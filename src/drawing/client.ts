// Main-thread side of the drawing worker: one worker per open drawing, started on
// demand. Projections are cached by direction; asking again for one in flight
// shares the request.
import { compile } from "../kernel/client";
import type { FlatBend } from "../sheetmetal/sheet";
import type { GeomDiff, Projection, Topo, V3, ViewDir } from "../kernel/drawing";
import type { DiffSrc } from "./drawing.worker";
import type { CutInfo, HoleInfo, ModelItem, SketchInfo, ThreadInfo, WeldInfo } from "./items";
import type { PartDoc } from "../model/types";
import type { AsmDoc } from "../asm/types";
import DrawingWorker from "./drawing.worker?worker";
import { dirKey, type Align, type Stair } from "./views";
import { FAST_EDGES } from "../kernel/drawing";

/** An assembly's placed component (FR-DRW-030): its edges' face names start with `<id>@`. */
export interface CompInfo { id: string; part: string; name: string; /** Its part's body materials, when its bodies have their own (FR-MAT-001). */ mats?: string[] }
export interface ModelFacts { box: [V3, V3]; volume: number; topo: Topo; items: ModelItem[]; holes: HoleInfo[]; threads?: ThreadInfo[]; sketches?: SketchInfo[]; comps?: CompInfo[]; /** Flat pattern view: its bend lines. */ bends?: FlatBend[]; /** Weldment part: its fillet beads (weld table). */ welds?: WeldInfo[]; /** Weldment part: its cut list (cut list table). */ cuts?: CutInfo[]; /** Weldment part: face name → cut list item number (balloons). */ cutFaces?: Record<string, number>; /** Weldment part: face name → weld table row (weld tags). */ weldFaces?: Record<string, number>; /** Part whose bodies have their own materials: the distinct ones in body order (title block). */ mats?: string[]; /** Such a part's mass in kg with each body's own density. */ kg?: number }

/** `?fasthlr`: every exact view takes the fast path. */
const fastFlag = () => (typeof location !== "undefined" && new URLSearchParams(location.search).has("fasthlr") ? 0 : undefined);

const facts = (r: ModelFacts): ModelFacts => ({ box: r.box, volume: r.volume, topo: r.topo, items: r.items, holes: r.holes, threads: r.threads ?? [], sketches: r.sketches ?? [], comps: r.comps, bends: r.bends, welds: r.welds, cuts: r.cuts, cutFaces: r.cutFaces, weldFaces: r.weldFaces, mats: r.mats, kg: r.kg });

/**
 * Whether a drawing may use a second drawing worker for exact projections: four or more threads and
 * a device that does not say it is short of memory. `?drwhelper=0|1` turns it off or on.
 */
function helperWanted(): boolean {
  if (typeof location !== "undefined") {
    const q = new URLSearchParams(location.search).get("drwhelper");
    if (q === "0") return false;
    if (q === "1") return true;
  }
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if ((nav.hardwareConcurrency ?? 2) < 4) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return false;
  return !nav.connection?.saveData;
}

/** Heap size after which the main drawing worker is started over between calls (see `recycle`). */
const HEAP_RECYCLE = (() => {
  const q = typeof location !== "undefined" ? Number(new URLSearchParams(location.search).get("drwheap")) : 0;
  return (q > 0 ? q : 1200) * 1048576;
})();
/** An error that means the worker's heap is full. */
export const OUT_OF_MEMORY = /malloc failed|bad_alloc|out of memory|Cannot enlarge memory|Array buffer allocation failed/i;

/** A helper drawing worker idle this long is stopped (its model is loaded again at the next load). */
const HELPER_IDLE_MS = 60_000;

/** One drawing worker and its calls in flight. */
class Lane {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** The model is loaded (for the generation in `gen`). */
  loaded = false;
  gen = -1;
  busy = false;
  dead = false;
  constructor(base: string, fast: number | undefined, onDead: (l: Lane) => void) {
    const w = new DrawingWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => { this.stop(new Error(e.message || "The drawing kernel stopped")); onDead(this); };
    this.worker = w;
    this.ready = compile(base).then(module => this.call<void>({ type: "init", base, module, fast }));
  }
  call<T>(msg: Record<string, unknown>): Promise<T> {
    if (this.dead) return Promise.reject(new Error("The drawing kernel stopped"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }
  stop(err = new Error("The drawing kernel stopped")) {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** An exact projection waiting for a worker. */
interface Job { msg: Record<string, unknown>; resolve: (v: any) => void; reject: (e: Error) => void; tries: number }

export class DrawingKernel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private loaded: Promise<ModelFacts> | null = null;
  /** Bumped at every load: answers for an older model are dropped. */
  gen = 0;
  readonly cache = new Map<string, Projection>();
  /** Facts of the part's other configurations (FR-DRW-010), by name, once built. */
  readonly configs = new Map<string, ModelFacts>();
  private cfgLoading = new Map<string, Promise<ModelFacts>>();
  private inflight = new Map<string, Promise<Projection>>();
  /** Quick polygonal previews (FR-DRW-016) by the same keys as `cache`; only drawn, never measured. */
  readonly previews = new Map<string, Projection>();
  private previewing = new Map<string, Promise<Projection>>();
  /** The longest exact projection of this model so far (ms): slow models get previews first. */
  slowest = 0;
  /** Previews made so far (for the smoke test). */
  previewsMade = 0;
  /**
   * Exact projections run on the drawing's worker and, with enough threads, on a helper worker
   * holding the same model, one at a time each, so a sheet's views are projected two at a time.
   */
  private jobs: Job[] = [];
  private mainBusy = false;
  private helper: Lane | null = null;
  private helperIdle: ReturnType<typeof setTimeout> | null = null;
  /** Exact projections the helper worker made (for the smoke test). */
  helped = 0;
  /** The loaded model, for starting the worker over (`recycle`). */
  private src: { part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } } | null = null;
  private wantRecycle = false;
  private recycling: Promise<void> | null = null;
  /** Times the main worker was started over (for tests). */
  recycles = 0;
  /** Told when a restart (`recycle`) starts and ends, so the status line can say so. */
  onRestart: (() => void) | null = null;
  get restarting() { return !!this.recycling; }

  constructor(private base: string) {}

  private start() {
    if (this.ready) return this.ready;
    const w = new DrawingWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (typeof d.heap === "number" && d.heap > HEAP_RECYCLE) this.wantRecycle = true;
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
      if (this.wantRecycle && !this.pending.size) void this.recycle();
    };
    w.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(e.message || "The drawing kernel stopped")); this.pending.clear(); this.stop(); };
    this.worker = w;
    this.ready = compile(this.base).then(module => this.call<void>({ type: "init", base: this.base, module, fast: fastFlag() }));
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    // While the worker starts over, everything but its own set-up waits for the model to be back.
    if (this.recycling && msg.type !== "init" && msg.type !== "load") return this.recycling.then(() => this.call<T>(msg));
    if (!this.worker) return Promise.reject(new Error("The drawing kernel stopped"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  /**
   * Starts the main worker over with the same model (the projection cache stays): OCCT's polygonal HLR leaks
   * ~100 MB per fast view of an engine assembly, and the heap ran out on an alternate position after
   * Standard 3 views (drawings exam round three). Calls still waiting fail with "stopped".
   */
  private recycle(): Promise<void> {
    if (this.recycling) return this.recycling;
    const src = this.src;
    if (!src || !this.worker) return Promise.resolve();
    this.wantRecycle = false;
    this.recycles++;
    this.worker.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error("The drawing kernel stopped"));
    this.pending.clear();
    // Configurations are built inside the worker: build them again when asked.
    this.configs.clear();
    this.cfgLoading.clear();
    // Loaded lite: the facts (topology, items, tables) are known already, and skipping them saves a good part
    // of the restart on a big assembly.
    const gen = this.gen;
    const done = this.start().then(() => this.call<void>({ type: "load", ...src, lite: true }));
    this.recycling = done.then(() => undefined, () => undefined).then(() => { this.recycling = null; this.onRestart?.(); if (gen === this.gen) this.pump(); });
    this.onRestart?.();
    return this.recycling;
  }

  stop() {
    this.src = null;
    this.wantRecycle = false;
    this.stopHelper();
    for (const j of this.jobs.splice(0)) j.reject(new Error("The drawing kernel stopped"));
    this.mainBusy = false;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.loaded = null;
    this.cache.clear();
    this.inflight.clear();
    this.previews.clear();
    this.previewing.clear();
    this.slowest = 0;
    this.configs.clear();
    this.cfgLoading.clear();
  }

  /** Loads the model; the projection cache starts over. */
  load(src: { part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } }): Promise<ModelFacts> {
    this.gen++;
    this.cache.clear();
    this.inflight.clear();
    this.previews.clear();
    this.previewing.clear();
    this.slowest = 0;
    this.configs.clear();
    this.cfgLoading.clear();
    this.src = src;
    this.wantRecycle = false;
    // The helper only for models under FAST_EDGES: a second copy of a big assembly can run the tab out of memory
    // (drawings exam: an engine tab crashed after Standard 3 views); big ones take the fast path anyway.
    const gen = this.gen;
    this.loaded = this.start().then(() => this.call<ModelFacts>({ type: "load", ...src })).then(facts).then(f => {
      if (gen === this.gen) { if (f.topo.edges.length < FAST_EDGES) this.loadHelper(src); else this.stopHelper(); }
      return f;
    });
    return this.loaded;
  }

  /** Starts (or reuses) the helper worker and loads the same model into it, without its facts. */
  private loadHelper(src: { part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } }) {
    if (!helperWanted()) return;
    const h = this.helper ?? (this.helper = new Lane(this.base, fastFlag(), l => { if (this.helper === l) this.helper = null; }));
    const gen = this.gen;
    h.loaded = false;
    h.gen = gen;
    h.ready.then(() => h.call({ type: "load", ...src, lite: true })).then(() => {
      if (h.gen !== gen || h.dead) return;
      h.loaded = true;
      this.pump();
      this.idleHelper();
    }, () => { if (this.helper === h) this.stopHelper(); });
  }

  private stopHelper() {
    if (this.helperIdle) clearTimeout(this.helperIdle);
    this.helperIdle = null;
    this.helper?.stop();
    this.helper = null;
  }

  /** Stops the helper after a while without work. */
  private idleHelper() {
    if (this.helperIdle) clearTimeout(this.helperIdle);
    this.helperIdle = setTimeout(() => { if (this.helper && !this.helper.busy) this.stopHelper(); }, HELPER_IDLE_MS);
  }

  /** For tests: whether the helper worker is up and has the model, and how many projections it made. */
  helperState() { return { on: !!this.helper, loaded: !!this.helper?.loaded, helped: this.helped, recycles: this.recycles }; }

  /** An exact projection or section, run by whichever worker is free first. */
  private exact<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => { this.jobs.push({ msg, resolve, reject, tries: 0 }); this.pump(); });
  }

  private pump() {
    if (!this.worker) return;
    while (this.jobs.length) {
      if (!this.mainBusy && !this.recycling) {
        const j = this.jobs.shift()!;
        this.mainBusy = true;
        const gen = this.gen;
        this.call(j.msg).then(j.resolve, (err: Error) => {
          // Out of memory: start the worker over and try once more.
          if (gen === this.gen && j.tries < 2 && OUT_OF_MEMORY.test(err.message) && this.src) {
            j.tries = 2;
            this.jobs.unshift(j);
            this.wantRecycle = true;
            return;
          }
          j.reject(err);
        }).finally(() => {
          this.mainBusy = false;
          if (this.wantRecycle && !this.pending.size) void this.recycle();
          else this.pump();
        });
        continue;
      }
      if (this.recycling) break;
      // The helper takes plain jobs of the loaded model (configurations are built on the main worker only).
      const h = this.helper;
      if (!h || !h.loaded || h.busy || h.gen !== this.gen) break;
      const i = this.jobs.findIndex(j => !j.msg.cfg && j.tries === 0);
      if (i < 0) break;
      const j = this.jobs.splice(i, 1)[0];
      h.busy = true;
      h.call(j.msg).then(r => { this.helped++; j.resolve(r); }, () => {
        // The helper failed (out of memory, stopped): the main worker does it.
        j.tries++;
        this.jobs.unshift(j);
      }).finally(() => { h.busy = false; this.idleHelper(); this.pump(); });
    }
  }

  /** Builds another configuration of the loaded part (once) and gives its facts. */
  config(name: string): Promise<ModelFacts> {
    const have = this.configs.get(name);
    if (have) return Promise.resolve(have);
    let p = this.cfgLoading.get(name);
    if (!p) {
      if (!this.loaded) return Promise.reject(new Error("No model loaded"));
      const gen = this.gen;
      p = this.loaded.then(() => this.call<ModelFacts>({ type: "config", name })).then(r => {
        const f = facts(r);
        if (gen === this.gen) this.configs.set(name, f);
        return f;
      });
      p.catch(() => { if (gen === this.gen) this.cfgLoading.delete(name); });
      this.cfgLoading.set(name, p);
    }
    return p;
  }

  get hasModel() { return !!this.loaded; }

  /** Two versions of a part or an assembly compared by booleans (FR-PDM-050). */
  async diff(a: DiffSrc, b: DiffSrc): Promise<GeomDiff> {
    await this.start();
    return (await this.call<{ diff: GeomDiff }>({ type: "diff", a, b })).diff;
  }

  /** The lines of moved components for an alternate position (FR-DRW-015), cached by `key`. */
  alt(req: { view: ViewDir; moves: { comp: string; tf: number[] }[]; key: string }): Promise<Projection> {
    const have = this.cache.get(req.key);
    if (have) return Promise.resolve(have);
    let p = this.inflight.get(req.key);
    if (!p) {
      if (!this.loaded) return Promise.reject(new Error("No model loaded"));
      const gen = this.gen;
      p = this.loaded.then(() => this.exact<{ proj: Projection }>({ type: "alt", view: req.view, moves: req.moves })).then(r => {
        if (gen === this.gen) this.cache.set(req.key, r.proj);
        this.inflight.delete(req.key);
        return r.proj;
      }, err => { this.inflight.delete(req.key); throw err; });
      this.inflight.set(req.key, p);
    }
    return p;
  }

  /** The view's lines (cached by direction). */
  project(view: ViewDir): Promise<Projection> { return this.request({ view, key: dirKey(view) }); }

  /** A projection, or a section when `p` is set (cached by `key`). */
  request(req: { view: ViewDir; p?: V3; poly?: number[]; stair?: Stair; align?: Align; exclude?: string[]; shade?: boolean; cfg?: string; only?: string[]; key: string }): Promise<Projection> {
    const { view, key } = req;
    const have = this.cache.get(key);
    if (have) return Promise.resolve(have);
    let p = this.inflight.get(key);
    if (!p) {
      if (!this.loaded) return Promise.reject(new Error("No model loaded"));
      const gen = this.gen;
      const cfg = req.cfg;
      p = (cfg ? this.config(cfg) : this.loaded).then(() => this.exact<{ proj: Projection }>(req.p ? { type: "section", view, p: req.p, poly: req.poly, stair: req.stair, align: req.align, exclude: req.exclude, cfg, only: req.only } : { type: "project", view, shade: req.shade, cfg, only: req.only })).then(r => {
        if (gen === this.gen) { this.cache.set(key, r.proj); this.previews.delete(key); this.slowest = Math.max(this.slowest, r.proj.ms); }
        this.inflight.delete(key);
        return r.proj;
      }, err => { this.inflight.delete(key); throw err; });
      this.inflight.set(key, p);
    }
    return p;
  }

  /**
   * A quick polygonal preview of a plain view (not a section), cached by the same key. Ask for it before
   * the exact projection: the worker answers in order.
   */
  preview(req: { view: ViewDir; cfg?: string; only?: string[]; key: string }): Promise<Projection> {
    const { key } = req;
    const have = this.previews.get(key);
    if (have) return Promise.resolve(have);
    let p = this.previewing.get(key);
    if (!p) {
      if (!this.loaded) return Promise.reject(new Error("No model loaded"));
      const gen = this.gen, cfg = req.cfg;
      p = (cfg ? this.config(cfg) : this.loaded).then(() => this.call<{ proj: Projection }>({ type: "preview", view: req.view, cfg, only: req.only })).then(r => {
        this.previewsMade++;
        if (gen === this.gen && !this.cache.has(key)) this.previews.set(key, r.proj);
        this.previewing.delete(key);
        return r.proj;
      }, err => { this.previewing.delete(key); throw err; });
      this.previewing.set(key, p);
    }
    return p;
  }
}
