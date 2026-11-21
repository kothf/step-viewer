// Structural analysis (FR-SARC-002): the solver's own worker. One solve at a time; every finished pass
// is posted at once. Cancelling = the page ends this worker and keeps the passes it has (FR-SARC-004).
// The last pass's solution of a static study stays here, so the page can read it at other points
// (results on section planes, FR-RES-030).

import { runModal, runStatic, sampleAt, type PassResult, type RunInput, type SampleResult, type Sampler } from "./run";

export type SimRequest =
  | { id: number; type: "static" | "modal"; input: RunInput }
  | { id: number; type: "sample"; of: number; pos: Float32Array; scale: number; solid?: boolean };
export type SimReply =
  | { id: number; pass: PassResult }
  | { id: number; done: true }
  | { id: number; sample: SampleResult | null }
  | { id: number; error: string };

const post = (m: SimReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
let kept: { of: number; sample: Sampler; inside: (x: number, y: number, z: number) => boolean } | null = null;

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const r = e.data;
  try {
    if (r.type === "sample") {
      const s = kept && kept.of === r.of ? sampleAt(kept.sample, r.pos, r.scale, r.solid ? kept.inside : undefined) : null;
      post({ id: r.id, sample: s }, s ? [s.u.buffer, s.vm.buffer, s.err.buffer, s.hit.buffer, ...(s.solid ? [s.solid.buffer] : [])] : []);
      return;
    }
    kept = null;
    const passes = r.type === "modal" ? runModal(r.input) : runStatic(r.input, (s, inside) => { kept = { of: r.id, sample: s, inside }; });
    for (const pass of passes) post({ id: r.id, pass }, [pass.u.buffer, pass.vm.buffer, pass.err.buffer, ...(pass.shapes ?? []).map(s => s.buffer)]);
    post({ id: r.id, done: true });
  } catch (err) {
    post({ id: r.id, error: err instanceof Error ? err.message : String(err) });
  }
};
