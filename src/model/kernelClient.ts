// Main-thread side of the modelling kernel: one long-lived worker per open part
// (its feature cache makes edits near the end of the history fast). Rebuilds
// coalesce: while one runs, only the newest request waits (FR-ARC-013). A worker
// whose heap grew too big, or that crashed, is replaced and rebuilds from the
// document (FR-ARC-011/012).
import { compile } from "../kernel/client";
import KernelWorker from "../kernel/kernel.worker?worker";
import type { PartData } from "../topology";
import type { AsmDoc, AsmComponentStatus } from "../asm/types";
import type { SheetState } from "../sheetmetal/sheet";
import type { CutItem } from "../weldments/types";
import type { FaceRef, RecognizedHole, BodyProps, FeatureStatus, Frame, IntersectRegion, PartDoc, SketchFeature, V3 } from "./types";

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
  data: PartData | null;
  faceNames: string[];
  /** How many of the last `faceNames` belong to surface bodies (FRS 9.11); they come after the solids. */
  sheetFaces?: number;
  /** The part's solid bodies, shown or hidden (FR-BODY-001). */
  bodies?: { key: string; ref: FaceRef; volume: number }[];
  /** Weldment cut list (FR-FT-121), when the part has weldment features. */
  cutList?: CutItem[];
  props: BodyProps | null;
  /** Faces made by the previewed feature, and its status (fillet and chamfer previews). */
  preview?: { position: number[]; status?: FeatureStatus } | null;
  ms: { eval: number; mesh: number };
}

const RECYCLE_HEAP = 1.5 * 1024 ** 3;

/** An assembly feature's result: the components it cut, or why it cut none (FR-ASM-027). */
export interface AsmFeatureStatus { id: string; ok: boolean; cut: string[]; message?: string }

/** The message of calls cut short by `stop()`. */
export const STOPPED = "The geometry kernel was stopped.";

export class ModelKernel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private running = false;
  private queued: { doc: PartDoc; color: V3; quality: number; previewAt?: number; resolve: (r: Rebuild | null) => void } | null = null;
  heap = 0;
  onCrash: ((msg: string) => void) | null = null;

  constructor(private base: string) {}

  private start() {
    if (this.ready) return this.ready;
    const w = new KernelWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => this.crash(e.message || "The geometry kernel stopped");
    this.worker = w;
    this.ready = compile(this.base).then(module => this.call<void>({ type: "init", base: this.base, module }));
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private crash(msg: string) {
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
    this.stop();
    this.onCrash?.(msg);
  }

  stop() {
    // Calls in flight end now: a parked document's rebuild must not wait for ever (it held "Rebuilding…").
    for (const p of this.pending.values()) p.reject(new Error(STOPPED));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.heap = 0;
  }

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
  rebuild(doc: PartDoc, color: V3, quality = 1, previewAt?: number): Promise<Rebuild | null> {
    return new Promise(resolve => {
      this.queued?.resolve(null);
      this.queued = { doc, color, quality, previewAt, resolve };
      if (!this.running) void this.pump();
    });
  }

  private async pump() {
    this.running = true;
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      try {
        if (this.heap > RECYCLE_HEAP) this.stop();
        await this.start();
        const r = await this.call<Rebuild & { heap: number }>({ type: "model", doc: job.doc, color: job.color, quality: job.quality, previewAt: job.previewAt });
        this.heap = r.heap;
        job.resolve(r);
      } catch (err) {
        // Stopped on purpose (the document was closed or parked): nobody waits for this result.
        if ((err as Error).message === STOPPED) { job.resolve(null); continue; }
        // A crashed worker: start again from the document once.
        if (!this.worker) {
          try {
            await this.start();
            const r = await this.call<Rebuild & { heap: number }>({ type: "model", doc: job.doc, color: job.color, quality: job.quality, previewAt: job.previewAt });
            job.resolve(r);
            continue;
          } catch { /* give up below */ }
        }
        job.resolve({ statuses: job.doc.features.map(f => ({ id: f.id, ok: false, code: "E-KRN-CRASH", message: (err as Error).message })), frames: {}, data: null, faceNames: [], props: null, ms: { eval: 0, mesh: 0 } });
      }
    }
    this.running = false;
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
  async recognizeHoles(doc: PartDoc): Promise<{ faces: FaceRef[]; holes: RecognizedHole[] }> {
    await this.start();
    return this.call<{ faces: FaceRef[]; holes: RecognizedHole[] }>({ type: "recognize", doc });
  }

  /** Evaluates an assembly: one mesh per shown component, placed (FRS 10). */
  async assembly(doc: AsmDoc): Promise<{ parts: { id: string; data: PartData; faces: string[] }[]; statuses: AsmComponentStatus[]; features?: AsmFeatureStatus[]; props: BodyProps | null }> {
    await this.start();
    return this.call<{ parts: { id: string; data: PartData; faces: string[] }[]; statuses: AsmComponentStatus[]; features?: AsmFeatureStatus[]; props: BodyProps | null }>({ type: "asm", doc, quality: 1 });
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

  async step(name: string, color: V3): Promise<Uint8Array> {
    await this.start();
    const r = await this.call<{ bytes: Uint8Array }>({ type: "modelStep", name, color });
    return r.bytes;
  }
}
