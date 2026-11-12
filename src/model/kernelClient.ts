// Main-thread side of the modelling kernel: one long-lived worker per open part
// (its feature cache makes edits near the end of the history fast). Rebuilds
// coalesce: while one runs, only the newest request waits (FR-ARC-013). A worker
// whose heap grew too big, or that crashed, is replaced and rebuilds from the
// document (FR-ARC-011/012).
import { giveBack, takeWorker } from "../kernel/spare";
import type { Prebuilt } from "../kernel/kernel.worker";
import { kernelPool, type KernelPool } from "../kernel/pool";
import { cacheDelete, cacheGet, cacheKey, cacheOn, cachePut } from "../buildCache";
import type { PartData } from "../topology";
import type { OwnBody } from "../tools/inertia";
import type { AsmDoc, AsmComponentStatus } from "../asm/types";
import type { SheetState } from "../sheetmetal/sheet";
import type { CutItem } from "../weldments/types";
import type { ModelSnap } from "../drawing/drawing.worker";
import type { FaceRef, RecognizedHole, Feature, BodyProps, FeatureStatus, Frame, IntersectRegion, PatternSpot, PartDoc, SketchFeature, V3 } from "./types";

export interface Rebuild {
  statuses: FeatureStatus[];
  frames: Record<string, Frame>;
  /** Sketches whose On edge curves the rebuild moved or marked dangling (FR-SK-064). */
  sketches?: Record<string, SketchFeature>;
  /** Points along curve features (helix), for the view. */
  curves?: Record<string, V3[]>;
  /** Sheet metal panels and bends (FR-FT-120), for the flat pattern and its DXF. */
  sheet?: SheetState | null;
  /** Regions each intersect feature found (FR-BODY-007). */
  regions?: Record<string, IntersectRegion[]>;
  /** Where each linear/circular pattern's instances land (Instances to skip). */
  spots?: Record<string, PatternSpot[]>;
  data: PartData | null;
  faceNames: string[];
  /** How many of the last `faceNames` belong to surface bodies (FRS 9.11); they come after the solids. */
  sheetFaces?: number;
  /** The part's solid bodies, shown or hidden (FR-BODY-001). */
  /** `area`, `com`, `cov` (covariance about `com`, unit density): each body's own mass properties, sent for multibody parts. */
  bodies?: { key: string; ref: FaceRef; volume: number; faces?: number; area?: number; com?: V3; cov?: [number, number, number, number, number, number] }[];
  /** Weldment cut list (FR-FT-121), when the part has weldment features. */
  cutList?: CutItem[];
  props: BodyProps | null;
  /** Faces made by the previewed feature, and its status (fillet and chamfer previews). */
  preview?: { position: number[]; status?: FeatureStatus } | null;
  ms: { eval: number; mesh: number };
}

const RECYCLE_HEAP = 1.5 * 1024 ** 3;
/** A rebuild result is written to the disk cache once no newer one came for this long (one write per pause in editing). */
const STORE_AFTER_MS = 1500;

/** What a fresh build must give again for a cached result to stand: face names, statuses, bodies. */
const signature = (r: Rebuild) => JSON.stringify([r.faceNames, r.statuses.map(s => [s.id, s.ok, s.code ?? ""]), r.bodies?.map(b => [b.key, Math.round(b.volume * 1e3)]), r.data?.faces.length ?? 0, r.data ? Math.round(r.data.volume * 1e3) : 0]);

/** An assembly feature's result: the components it cut, or why it cut none (FR-ASM-027). */
export interface AsmFeatureStatus { id: string; ok: boolean; cut: string[]; message?: string }

/** The message of calls cut short by `stop()`. */
export const STOPPED = "The geometry kernel was stopped.";

export class ModelKernel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  /** Rejects `ready` while the worker is still setting itself up (stop() then ends the wait). */
  private abortReady: ((err: Error) => void) | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private running = false;
  private queued: { doc: PartDoc; color: V3; quality: number; previewAt?: number; verify?: boolean; resolve: (r: Rebuild | null) => void } | null = null;
  heap = 0;
  onCrash: ((msg: string) => void) | null = null;
  /**
   * Told when a result shown from the disk cache turned out to differ from the worker's own build of the same
   * document (it never should): the entry is gone, and the caller rebuilds.
   */
  onStale: (() => void) | null = null;
  /** Whether this worker has built the part since it started: the disk cache is read only for the first build. */
  private built = false;
  /** The next build skips the disk cache (Ctrl+Q: rebuild every feature). */
  private bypass = false;
  private storeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rebuilds and assembly parts answered from the disk cache (for `?debug` and the smoke test). */
  cacheHits = 0;

  constructor(private base: string) {}

  private start() {
    if (this.ready) return this.ready;
    // The page's spare worker when there is one: its seconds of set-up are already done (or under way).
    const { w, ready, abort } = takeWorker(this.base);
    this.abortReady = abort;
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => this.crash(e.message || "The geometry kernel stopped");
    this.worker = w;
    this.ready = ready;
    this.ready.catch(() => this.stop(false));
    return this.ready;
  }

  private crash(msg: string) {
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
    this.stop(false);
    this.onCrash?.(msg);
  }

  /** Stops the worker; `reuse`: an idle, healthy one becomes the page's spare for the next document. */
  stop(reuse = true) {
    // Calls in flight end now: a parked document's rebuild must not wait for ever (it held "Rebuilding…").
    const idle = !this.pending.size;
    for (const p of this.pending.values()) p.reject(new Error(STOPPED));
    this.pending.clear();
    const w = this.worker, ready = this.ready;
    if (w && ready && reuse && idle && this.heap > 0) giveBack(w, this.base, this.heap);
    else w?.terminate();
    // A rebuild waiting for the set-up of a worker stopped now must end too (it would wait for ever).
    this.abortReady?.(new Error(STOPPED));
    this.abortReady = null;
    this.worker = null;
    this.ready = null;
    this.heap = 0;
    this.built = false;
    this.known.clear();
  }

  /** The next rebuild runs every feature in the kernel instead of reading the disk cache. */
  bypassCache() { this.bypass = true; }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  /** Warms the worker up before the first feature. */
  warm() { this.start().catch(() => {}); }

  /** Evaluates the document. Resolves null when a newer request replaced this one. */
  rebuild(doc: PartDoc, color: V3, quality = 1, previewAt?: number, verify = false): Promise<Rebuild | null> {
    return new Promise(resolve => {
      this.queued?.resolve(null);
      this.queued = { doc, color, quality, previewAt, verify, resolve };
      if (!this.running) void this.pump();
    });
  }

  private async pump() {
    this.running = true;
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      try {
        if (this.heap > RECYCLE_HEAP) this.stop(false);
        const plain = job.previewAt == null && cacheOn();
        const key = plain ? await cacheKey("part", job.doc, job.color, job.quality, !!job.verify) : null;
        // The first build of a document: the disk cache answers at once, and the worker still builds it behind,
        // so the edits, picks and exports that follow find it ready (they queue behind it, as before).
        const hit = key && !this.built && !this.bypass ? await cacheGet<Rebuild>(key) : undefined;
        this.bypass = false;
        if (hit) { this.cacheHits++; job.resolve(hit); }
        await this.start();
        const r = await this.call<Rebuild & { heap: number }>({ type: "model", doc: job.doc, color: job.color, quality: job.quality, previewAt: job.previewAt, verify: job.verify });
        this.heap = r.heap;
        this.built = true;
        if (hit) {
          if (signature(hit) !== signature(r)) { void cacheDelete(key); this.storeLater(key, r); this.onStale?.(); }
        } else {
          job.resolve(r);
          if (key) this.storeLater(key, r);
        }
      } catch (err) {
        // Stopped on purpose (the document was closed or parked): nobody waits for this result.
        if ((err as Error).message === STOPPED) { job.resolve(null); continue; }
        // A crashed worker: start again from the document once.
        if (!this.worker) {
          try {
            await this.start();
            const r = await this.call<Rebuild & { heap: number }>({ type: "model", doc: job.doc, color: job.color, quality: job.quality, previewAt: job.previewAt, verify: job.verify });
            job.resolve(r);
            continue;
          } catch { /* give up below */ }
        }
        job.resolve({ statuses: job.doc.features.map(f => ({ id: f.id, ok: false, code: "E-KRN-CRASH", message: (err as Error).message })), frames: {}, data: null, faceNames: [], props: null, ms: { eval: 0, mesh: 0 } });
      }
    }
    this.running = false;
  }

  /** Writes the newest rebuild result to the disk cache once editing pauses. */
  private storeLater(key: string | null, r: Rebuild & { heap?: number }) {
    if (this.storeTimer) clearTimeout(this.storeTimer);
    const { heap: _h, ...keep } = r;
    this.storeTimer = setTimeout(() => { this.storeTimer = null; void cachePut(key, keep); }, STORE_AFTER_MS);
  }

  /** Reads a STEP/IGES/BREP file into BREP text for an imported body (FR-FT-130). */
  async importBody(buffer: ArrayBuffer, name: string): Promise<{ brep: string; solids: number; faces: number }> {
    await this.start();
    return this.call<{ brep: string; solids: number; faces: number }>({ type: "importBody", buffer, name });
  }

  /** Evaluates another part document into BREP text for an inserted part (FR-BODY-005). */
  async partBody(doc: PartDoc): Promise<{ brep: string; solids: number; faces: number }> {
    await this.start();
    return this.call<{ brep: string; solids: number; faces: number }>({ type: "partBody", doc });
  }

  /** Feature recognition (FR-FT-102): the round holes of the part's body, as hole features would make them. */
  async recognizeHoles(doc: PartDoc): Promise<{ faces: FaceRef[]; holes: RecognizedHole[]; cuts?: Feature[] }> {
    await this.start();
    return this.call<{ faces: FaceRef[]; holes: RecognizedHole[]; cuts?: Feature[] }>({ type: "recognize", doc });
  }

  /** Feature recognition (FR-FT-102): fillets and chamfers that can be deleted and made again as features. */
  async recognizeBlends(doc: PartDoc): Promise<Feature[]> {
    await this.start();
    return (await this.call<{ features: Feature[] }>({ type: "recognizeBlends", doc })).features;
  }

  /** Feature recognition (FR-FT-102): pockets and bosses that can be deleted and made again as sketches with extrudes. */
  async recognizeExtrudes(doc: PartDoc): Promise<Feature[]> {
    await this.start();
    return (await this.call<{ features: Feature[] }>({ type: "recognizeExtrudes", doc })).features;
  }

  /** Recognize Features (FR-FT-102): fillets, holes, extrudes and the base in one go, in modelling order. */
  async recognizeFeatures(doc: PartDoc): Promise<Feature[]> {
    await this.start();
    return (await this.call<{ features: Feature[] }>({ type: "recognizeFeatures", doc })).features;
  }

  /** Evaluates an assembly: one mesh per shown component, placed (FRS 10). */
  async assembly(doc: AsmDoc): Promise<{ parts: { id: string; data: PartData; faces: string[]; bodies?: OwnBody[] }[]; statuses: AsmComponentStatus[]; features?: AsmFeatureStatus[]; props: BodyProps | null }> {
    let t = performance.now();
    const all = this.unbuilt(doc);
    // Parts built before (this session or an earlier one) come from the disk cache as BREP + analysed mesh.
    const keys = new Map<string, string | null>();
    const cached: Record<string, Prebuilt> = {};
    if (cacheOn()) {
      await Promise.all(all.map(async k => {
        const key = await cacheKey("asmpart", doc.parts[k].doc, 1);
        keys.set(k, key);
        const hit = await cacheGet<Prebuilt>(key);
        if (hit?.brep) cached[k] = hit;
      }));
    }
    const todo = all.filter(k => !cached[k]);
    this.cacheHits += all.length - todo.length;
    const pool = todo.length > 1 ? kernelPool(this.base) : null;
    pool?.warm(todo.length - 1);
    await this.start();
    const worker = this.worker;
    const lap = () => { const n = performance.now(), d = n - t; t = n; return Math.round(d); };
    const start = lap();
    const store = keys.size ? (k: string, p: Prebuilt) => { if (p.brep && p.data) void cachePut(keys.get(k) ?? null, p); } : null;
    let pre: Record<string, Prebuilt> | undefined = pool ? await this.prebuild(doc, todo, pool, store) : undefined;
    // One part to build: the assembly worker builds it, and sends it back for the disk cache.
    if (!pool && store && todo.length === 1) {
      const r = await this.call<{ pre?: Prebuilt }>({ type: "asmPrime", doc, key: todo[0], quality: 1, out: true });
      if (r.pre) store(todo[0], r.pre);
    }
    if (Object.keys(cached).length) pre = { ...pre, ...cached };
    const pb = lap();
    const r = await this.call<{ parts: { id: string; data: PartData; faces: string[]; bodies?: OwnBody[] }[]; statuses: AsmComponentStatus[]; features?: AsmFeatureStatus[]; props: BodyProps | null }>({ type: "asm", doc, quality: 1, pre });
    // The worker now holds these part sources; a new worker (after a crash) knows none.
    this.timing = { start, prebuild: pb, asm: lap(), worker: Math.round((r as any).ms) };
    if (this.worker === worker) this.known = new Map(Object.entries(doc.parts).map(([k, p]) => [k, JSON.stringify(p.doc)]));
    return r;
  }

  /** Part documents the assembly worker has evaluated, by part key (as JSON), so only changed parts are built again. */
  private known = new Map<string, string>();
  /** Time spent on the last parallel part build, and on how many workers (for `?debug`). */
  /** Where the last assembly build spent its time (ms), for `?debug` profiling. */
  timing: Record<string, number> = {};
  lastParallel: { parts: number; workers: number; ms: number } | null = null;

  /** Part keys the assembly worker does not hold yet, biggest document first. */
  private unbuilt(doc: AsmDoc): string[] {
    return Object.entries(doc.parts)
      .filter(([k, p]) => !p.asm && this.known.get(k) !== JSON.stringify(p.doc))
      .map(([k, p]) => ({ k, size: JSON.stringify(p.doc).length }))
      .sort((a, b) => b.size - a.size).map(x => x.k);
  }

  /**
   * Parallel part builds (FR-ARC-016): parts the assembly worker does not hold yet are built at
   * once, biggest first, by the helper pool and by the assembly worker itself. Helper results come
   * back as BREP bodies with their analysed meshes for the "asm" call; a part a helper could not
   * build is left to the assembly worker.
   */
  private async prebuild(doc: AsmDoc, todo: string[], pool: KernelPool, store: ((k: string, p: Prebuilt) => void) | null): Promise<Record<string, Prebuilt>> {
    const t0 = performance.now();
    const pre: Record<string, Prebuilt> = {};
    let next = 0;
    const own = async () => {
      while (next < todo.length) {
        const k = todo[next++];
        const r = await this.call<{ pre?: Prebuilt }>({ type: "asmPrime", doc, key: k, quality: 1, out: !!store });
        if (r.pre) store?.(k, r.pre);
      }
    };
    const helper = async () => {
      // Take parts only once a helper has started, so the assembly worker is not left waiting on one that is still loading.
      try { await pool.run({ type: "ping" }); } catch { return; }
      while (next < todo.length) {
        const k = todo[next++];
        try {
          const r = await pool.run<{ pre: Prebuilt }>({ type: "prebuild", doc: doc.parts[k].doc, quality: 1 });
          pre[k] = r.pre;
          store?.(k, r.pre);
        } catch { /* the assembly worker builds it in the "asm" call */ }
      }
    };
    const lanes = Math.min(pool.size, todo.length - 1);
    await Promise.all([own(), ...Array.from({ length: lanes }, helper)]);
    this.lastParallel = { parts: todo.length, workers: lanes + 1, ms: performance.now() - t0 };
    return pre;
  }

  /** Overlapping component pairs, with the overlap volume and triangles (FR-ASM-020). */
  async interference(doc: AsmDoc, touch = false): Promise<{ a: string; b: string; volume: number; position: number[] }[]> {
    await this.start();
    return (await this.call<{ pairs: { a: string; b: string; volume: number; position: number[] }[] }>({ type: "asmInterfere", doc, touch })).pairs;
  }

  /** Component pairs closer than `min` mm (touching and overlapping ones at 0), nearest first (FR-ASM-021). */
  async clearance(doc: AsmDoc, min: number): Promise<{ a: string; b: string; distance: number; p1: number[]; p2: number[] }[]> {
    await this.start();
    return (await this.call<{ pairs: { a: string; b: string; distance: number; p1: number[]; p2: number[] }[] }>({ type: "asmClearance", doc, min })).pairs;
  }

  /** STEP of the assembly: one product per shown component (AT-P4-6). */
  async assemblyStep(doc: AsmDoc): Promise<Uint8Array> {
    await this.start();
    return (await this.call<{ bytes: Uint8Array }>({ type: "asmStep", doc })).bytes;
  }

  /**
   * The shown components as a drawing snapshot (`ModelSnap`), from the parts this worker has built already;
   * `doc` must be what the last `assembly` built, or the worker would rebuild (and lose its cache for the 3D view).
   */
  async drawingSnap(doc: AsmDoc): Promise<ModelSnap> {
    await this.start();
    return (await this.call<{ snap: ModelSnap }>({ type: "asmSnap", doc })).snap;
  }

  async step(name: string, color: V3): Promise<Uint8Array> {
    await this.start();
    const r = await this.call<{ bytes: Uint8Array }>({ type: "modelStep", name, color });
    return r.bytes;
  }
}
