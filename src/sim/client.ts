// Structural analysis: page side of the solver worker (FR-SOL-002, FR-SOL-022).

import SimWorker from "./sim.worker?worker";
import type { PassResult, RunInput, SampleResult } from "./run";
import type { SimReply } from "./sim.worker";

export const SIM_STOPPED = "E-SIM-STOPPED";

export class SimClient {
  private worker: Worker | null = null;
  private seq = 0;
  private job: { id: number; reject: (e: Error) => void } | null = null;
  /** The static solve whose last solution the worker still holds (0 = none). */
  private held = 0;
  private asks = new Map<number, (r: SampleResult | null) => void>();

  get busy() { return !!this.job; }
  /** A number naming the solution `sample` would read; 0 when there is none. */
  get solution() { return this.job ? 0 : this.held; }

  /**
   * The kept solution at these points (part coordinates, mm); with `scale` the points are places on the shape
   * deformed that much. Null when the worker holds no solution (stopped, another solve, results from the cache).
   */
  sample(pos: Float32Array, scale = 0): Promise<SampleResult | null> {
    const w = this.worker, of = this.solution;
    if (!w || !of) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise(resolve => {
      this.asks.set(id, resolve);
      w.postMessage({ id, type: "sample", of, pos, scale });
    });
  }

  private dropAsks() {
    const all = [...this.asks.values()];
    this.asks.clear();
    this.held = 0;
    for (const f of all) f(null);
  }

  /** Runs the passes; `onPass` gets each as it finishes. Resolves with them all; rejects with an E-SIM code. */
  solve(input: RunInput, onPass: (p: PassResult) => void): Promise<PassResult[]> {
    this.cancel();
    this.held = 0;
    const w = (this.worker ??= new SimWorker());
    const id = ++this.seq;
    return new Promise<PassResult[]>((resolve, reject) => {
      const passes: PassResult[] = [];
      this.job = { id, reject };
      const end = () => { if (this.job?.id === id) this.job = null; };
      w.onmessage = (e: MessageEvent<SimReply>) => {
        const d = e.data;
        if ("sample" in d) { const f = this.asks.get(d.id); this.asks.delete(d.id); f?.(d.sample); return; }
        if (d.id !== id) return;
        if ("pass" in d) { passes.push(d.pass); onPass(d.pass); }
        else if ("done" in d) { end(); if (!input.modal && passes.length) this.held = id; resolve(passes); }
        else { end(); reject(new Error(d.error)); }
      };
      // a crashed worker (out of memory) is replaced at the next solve
      w.onerror = ev => { end(); this.worker?.terminate(); this.worker = null; this.dropAsks(); reject(new Error(ev.message || SIM_STOPPED)); };
      w.postMessage({ id, type: input.modal ? "modal" : "static", input });
    });
  }

  /** Ends the running solve; the passes already delivered stay with the caller. */
  cancel() {
    if (!this.job) return;
    const j = this.job;
    this.job = null;
    this.worker?.terminate();
    this.worker = null;
    this.dropAsks();
    j.reject(new Error(SIM_STOPPED));
  }

  stop() { this.cancel(); this.worker?.terminate(); this.worker = null; this.dropAsks(); }
}
