// Structural analysis (FR-SARC-002): the solver's own worker. One solve at a time; every finished pass
// is posted at once. Cancelling = the page ends this worker and keeps the passes it has (FR-SARC-004).

import { runStatic, type PassResult, type RunInput } from "./run";

export type SimRequest = { id: number; type: "static"; input: RunInput };
export type SimReply =
  | { id: number; pass: PassResult }
  | { id: number; done: true }
  | { id: number; error: string };

const post = (m: SimReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const r = e.data;
  try {
    for (const pass of runStatic(r.input)) post({ id: r.id, pass }, [pass.u.buffer, pass.vm.buffer, pass.err.buffer]);
    post({ id: r.id, done: true });
  } catch (err) {
    post({ id: r.id, error: err instanceof Error ? err.message : String(err) });
  }
};
