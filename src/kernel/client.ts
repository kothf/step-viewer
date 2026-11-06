// Main-thread side of the kernel worker: starts it in the background, sends the
// tessellation's faces and edges so the worker can match them, and writes the
// exact values it returns back into the parts (volume, areas, lengths, radii,
// curvature). Measurements read those fields, so they become exact without a switch.
import type { EdgeInfo, FaceInfo, PartData, V3 } from "../topology";
import type { PartPatch, PartProbe } from "./occ";
import KernelWorker from "./kernel.worker?worker";

export type KernelStatus = "off" | "loading" | "ready" | "partial" | "error";

let wasm: Promise<WebAssembly.Module> | null = null;
function compile(base: string) {
  wasm ??= (async () => {
    const url = `${base}opencascade.full.wasm?v=${__APP_VERSION__}`;
    try { return await WebAssembly.compileStreaming(fetch(url)); }
    catch { return WebAssembly.compile(await (await fetch(url)).arrayBuffer()); }
  })();
  wasm.catch(() => { wasm = null; });
  return wasm;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** A worker whose WASM heap has grown past this is replaced at the next file (OCCT objects are not freed one by one). */
const RECYCLE_HEAP = 1024 * 1024 * 1024;

export class KernelClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  /** WASM heap size of the current worker after its last file. */
  private heap = 0;
  /** The file in the worker now (null: none, or a model that has no B-rep, such as a mesh). */
  file: string | null = null;
  status: KernelStatus = "off";
  /** Where the last open spent its time (ms), for `?debug` profiling. */
  timing: Record<string, number> = {};
  onStatus: ((s: KernelStatus, note?: string) => void) | null = null;

  constructor(private base: string) {}

  private set(s: KernelStatus, note?: string) { this.status = s; this.onStatus?.(s, note); }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  private stop() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.file = null;
    this.heap = 0;
    for (const p of this.pending.values()) p.reject(new Error("cancelled"));
    this.pending.clear();
  }

  /**
   * A worker ready for the next file. Starting one costs seconds (the 50 MB module
   * sets itself up), so an idle worker is kept and reused; a busy one (still on
   * the last file) or one with a big heap is replaced.
   */
  private take() {
    if (this.worker && this.ready && !this.pending.size && this.heap < RECYCLE_HEAP) return this.ready;
    this.stop();
    const w = new KernelWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(e.message || "kernel worker failed")); this.pending.clear(); };
    this.worker = w;
    const t = performance.now();
    const ready = compile(this.base)
      .then(module => { this.timing.compile = performance.now() - t; return this.call<void>({ type: "init", base: this.base, module }); });
    // A worker that failed to start is not reused.
    ready.catch(() => { if (this.ready === ready) this.stop(); });
    this.ready = ready;
    return ready;
  }

  /** Starts the kernel worker ahead of the first file, so its set-up is out of the way. */
  warm() {
    if (!this.worker) this.take().catch(() => {});
  }

  /** Stops background work for a model that has no B-rep (a mesh file, or a PCB). An idle worker stays for the next file. */
  clear() {
    if (this.pending.size) this.stop();
    this.file = null;
    this.set("off");
  }

  /**
   * Reads `bytes` in the worker and makes the parts exact. The read starts at once,
   * alongside the import; `parts` resolves once the import is done (null: it failed).
   * Resolves with how many parts matched.
   */
  async open(bytes: ArrayBuffer, name: string, parts: Promise<PartData[] | null>, stillCurrent: () => boolean) {
    this.set("loading");
    let t = performance.now();
    this.timing = {};
    const lap = (k: string) => { const n = performance.now(); this.timing[k] = n - t; t = n; };
    try {
      // A file still loading in the worker can't be interrupted: start a new worker.
      if (this.pending.size) this.stop();
      this.file = null;
      await this.take();
      lap("init");
      const { counts, heap } = await this.call<{ counts: number[]; heap: number }>({ type: "load", buffer: bytes, name }, [bytes]);
      this.heap = heap ?? 0;
      lap("load");
      const ps = await parts;
      if (!stillCurrent()) return 0;
      if (!ps) { this.set("off"); return 0; }
      t = performance.now();
      this.file = name;
      if (counts.length !== ps.length) { this.set("error", `${counts.length} ≠ ${ps.length} parts`); return 0; }
      const { patches } = await this.call<{ patches: (PartPatch | null)[] }>({ type: "exact", probes: ps.map(probe) });
      if (!stillCurrent()) return 0;
      lap("match");
      let n = 0;
      patches.forEach((p, i) => { if (p?.ok && applyPatch(ps[i], p)) n++; });
      this.set(n === ps.length ? "ready" : n ? "partial" : "error");
      return n;
    } catch (err) {
      if ((err as Error).message === "cancelled") return 0;
      // The module may be left broken (an OCCT abort): the next file gets a new worker.
      this.stop();
      if (stillCurrent()) this.set("error", (err as Error).message);
      return 0;
    }
  }

  /** STEP of the open file: all of it (null) or the listed parts, with their names and colours. */
  async step(which: number[] | null, names: string[] = [], colors: (V3 | null)[] = []) {
    if (!this.worker || !this.file) throw new Error("The model is not loaded in the kernel");
    await this.ready;
    const r = await this.call<{ bytes: Uint8Array }>({ type: "step", which, names, colors });
    return r.bytes;
  }

  /** STEP of a PCB board body. Uses the current worker, or starts one. */
  async board(body: { loops: number[][]; holes: [number, number, number][]; z0: number; thickness: number; name: string }) {
    await this.take();
    const r = await this.call<{ bytes: Uint8Array }>({ type: "board", ...body });
    return r.bytes;
  }
}

// ---------- probes and patches ----------

const SAMPLES = 16;
const MAX_SAMPLED_FACES = 4000;

/** What the worker needs to check and match one part. */
export function probe(d: PartData): PartProbe {
  const samples: [number, number[]][] = [];
  for (const f of d.faces) {
    if (f.type !== "other" || !f.triCount || samples.length >= MAX_SAMPLED_FACES) continue;
    const pts: number[] = [];
    const step = Math.max(1, Math.floor((f.triCount * 3) / SAMPLES));
    for (let k = f.triStart * 3; k < (f.triStart + f.triCount) * 3 && pts.length < SAMPLES * 3; k += step) {
      const i = d.index[k] * 3;
      pts.push(d.positions[i], d.positions[i + 1], d.positions[i + 2]);
    }
    samples.push([f.id, pts]);
  }
  return {
    faces: d.faces.length,
    faceArea: d.faces.map(f => f.area),
    samples,
    edges: d.edges.map(e => ({ faces: e.faces, length: e.length, mid: e.mid, start: e.start, end: e.end, closed: e.closed })),
  };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Writes exact values into the part. Returns false when nothing could be used. */
export function applyPatch(d: PartData, p: PartPatch): boolean {
  if (!p.ok) return false;
  if (p.volume !== undefined && d.closed) { d.volume = p.volume; if (p.com) d.com = p.com; }
  if (p.area !== undefined) d.area = p.area;
  p.faces?.forEach((fp, i) => { const f = d.faces[i]; if (fp && f) patchFace(f, fp); });
  p.edges?.forEach((ep, i) => { const e = d.edges[i]; if (ep && e) patchEdge(e, ep); });
  d.exact = true;
  return true;
}

function patchFace(f: FaceInfo, fp: NonNullable<PartPatch["faces"]>[number] & object) {
  f.area = fp.area;
  f.surface = fp.type;
  if (fp.type === "cylinder" && f.type === "cylinder" && fp.axis && fp.center && fp.radius) {
    // Keep our centre (the middle of the face along its axis), moved onto the exact axis.
    const a = fp.axis, c = fp.center, w: V3 = [f.center[0] - c[0], f.center[1] - c[1], f.center[2] - c[2]];
    const t = dot(w, a);
    f.center = [c[0] + a[0] * t, c[1] + a[1] * t, c[2] + a[2] * t];
    f.axis = dot(a, f.axis ?? a) < 0 ? [-a[0], -a[1], -a[2]] : a;
    f.radius = fp.radius;
  } else if (fp.type === "sphere" && f.type === "sphere" && fp.center && fp.radius) {
    f.center = fp.center;
    f.radius = fp.radius;
  } else if (fp.type === "cone" || fp.type === "torus") {
    f.coneAngle = fp.angle;
    f.torus = fp.type === "torus" && fp.radius && fp.minor ? [fp.radius, fp.minor] : undefined;
  }
  if (fp.kMin !== undefined && fp.kMax !== undefined) f.curvature = [fp.kMin, fp.kMax];
}

function patchEdge(e: EdgeInfo, ep: NonNullable<PartPatch["edges"]>[number] & object) {
  e.length = ep.length;
  e.exact = true;
  if ((ep.type === "circle" || ep.type === "arc") && ep.radius && ep.center && ep.axis && e.type !== "line") {
    e.type = ep.type;
    e.radius = ep.radius;
    e.center = ep.center;
    e.axis = dot(ep.axis, e.axis ?? ep.axis) < 0 ? [-ep.axis[0], -ep.axis[1], -ep.axis[2]] : ep.axis;
    e.sweep = ep.sweep;
  } else if (ep.type === "ellipse") e.ellipse = true;
}
