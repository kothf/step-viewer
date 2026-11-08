// Main-thread side of the drawing worker: one worker per open drawing, started on
// demand. Projections are cached by direction; asking again for one in flight
// shares the request.
import { compile } from "../kernel/client";
import type { GeomDiff, Projection, Topo, V3, ViewDir } from "../kernel/drawing";
import type { DiffSrc } from "./drawing.worker";
import type { HoleInfo, ModelItem, SketchInfo, ThreadInfo } from "./items";
import type { PartDoc } from "../model/types";
import type { AsmDoc } from "../asm/types";
import DrawingWorker from "./drawing.worker?worker";
import { dirKey, type Stair } from "./views";

/** An assembly's placed component (FR-DRW-030): its edges' face names start with `<id>@`. */
export interface CompInfo { id: string; part: string; name: string }
export interface ModelFacts { box: [V3, V3]; volume: number; topo: Topo; items: ModelItem[]; holes: HoleInfo[]; threads?: ThreadInfo[]; sketches?: SketchInfo[]; comps?: CompInfo[] }

export class DrawingKernel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private loaded: Promise<ModelFacts> | null = null;
  /** Bumped at every load: answers for an older model are dropped. */
  gen = 0;
  readonly cache = new Map<string, Projection>();
  private inflight = new Map<string, Promise<Projection>>();

  constructor(private base: string) {}

  private start() {
    if (this.ready) return this.ready;
    const w = new DrawingWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(e.message || "The drawing kernel stopped")); this.pending.clear(); this.stop(); };
    this.worker = w;
    this.ready = compile(this.base).then(module => this.call<void>({ type: "init", base: this.base, module }));
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.loaded = null;
    this.cache.clear();
    this.inflight.clear();
  }

  /** Loads the model; the projection cache starts over. */
  load(src: { part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } }): Promise<ModelFacts> {
    this.gen++;
    this.cache.clear();
    this.inflight.clear();
    this.loaded = this.start().then(() => this.call<ModelFacts>({ type: "load", ...src })).then(r => ({ box: r.box, volume: r.volume, topo: r.topo, items: r.items, holes: r.holes, threads: r.threads ?? [], sketches: r.sketches ?? [], comps: r.comps }));
    return this.loaded;
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
      p = this.loaded.then(() => this.call<{ proj: Projection }>({ type: "alt", view: req.view, moves: req.moves })).then(r => {
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
  request(req: { view: ViewDir; p?: V3; poly?: number[]; stair?: Stair; exclude?: string[]; shade?: boolean; key: string }): Promise<Projection> {
    const { view, key } = req;
    const have = this.cache.get(key);
    if (have) return Promise.resolve(have);
    let p = this.inflight.get(key);
    if (!p) {
      if (!this.loaded) return Promise.reject(new Error("No model loaded"));
      const gen = this.gen;
      p = this.loaded.then(() => this.call<{ proj: Projection }>(req.p ? { type: "section", view, p: req.p, poly: req.poly, stair: req.stair, exclude: req.exclude } : { type: "project", view, shade: req.shade })).then(r => {
        if (gen === this.gen) this.cache.set(key, r.proj);
        this.inflight.delete(key);
        return r.proj;
      }, err => { this.inflight.delete(key); throw err; });
      this.inflight.set(key, p);
    }
    return p;
  }
}
