// Structural analysis: page side of the solver worker (FR-SOL-002, FR-SOL-022).

import SimWorker from "./sim.worker?worker";
import type { PassResult, RunInput } from "./run";
import type { SimReply } from "./sim.worker";

export const SIM_STOPPED = "E-SIM-STOPPED";

export class SimClient {
  private worker: Worker | null = null;
  private seq = 0;
  private job: { id: number; reject: (e: Error) => void } | null = null;

  get busy() { return !!this.job; }

  /** Runs the passes; `onPass` gets each as it finishes. Resolves with them all; rejects with an E-SIM code. */
  solve(input: RunInput, onPass: (p: PassResult) => void): Promise<PassResult[]> {
    this.cancel();
    const w = (this.worker ??= new SimWorker());
    const id = ++this.seq;
    return new Promise<PassResult[]>((resolve, reject) => {
      const passes: PassResult[] = [];
      this.job = { id, reject };
      const end = () => { if (this.job?.id === id) this.job = null; };
      w.onmessage = (e: MessageEvent<SimReply>) => {
        const d = e.data;
        if (d.id !== id) return;
        if ("pass" in d) { passes.push(d.pass); onPass(d.pass); }
        else if ("done" in d) { end(); resolve(passes); }
        else { end(); reject(new Error(d.error)); }
      };
      // a crashed worker (out of memory) is replaced at the next solve
      w.onerror = ev => { end(); this.worker?.terminate(); this.worker = null; reject(new Error(ev.message || SIM_STOPPED)); };
      w.postMessage({ id, type: "static", input });
    });
  }

  /** Ends the running solve; the passes already delivered stay with the caller. */
  cancel() {
    if (!this.job) return;
    const j = this.job;
    this.job = null;
    this.worker?.terminate();
    this.worker = null;
    j.reject(new Error(SIM_STOPPED));
  }

  stop() { this.cancel(); this.worker?.terminate(); this.worker = null; }
}
