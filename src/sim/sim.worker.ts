// Structural analysis (FR-SARC-002): the solver's own worker. One solve at a time; every finished pass
// is posted at once. Cancelling = the page ends this worker and keeps the passes it has (FR-SARC-004).
// The last pass's solution of a static study stays here, so the page can read it at other points
// (results on section planes, FR-RES-030).

import { findConnections, type Connection } from "./connect";
import { findBolts, type FastenerBody } from "./bolts";
import { runModal, runStatic, runThermal, runTransient, sampleAt, type PassResult, type RunInput, type SampleResult, type Sampler } from "./run";

export type SimRequest =
  | { id: number; type: "static" | "modal" | "thermal"; input: RunInput; /** Keep the solutions of the solves before (the other load cases). */ more?: boolean }
  | { id: number; type: "connect"; bodies: Float64Array[]; gap: number }
  | { id: number; type: "bolts"; bodies: Float64Array[]; fast: FastenerBody[] }
  | { id: number; type: "sample"; of: number; pos: Float32Array; scale: number; solid?: boolean };
export type SimReply =
  | { id: number; pass: PassResult }
  | { id: number; done: true }
  | { id: number; sample: SampleResult | null }
  | { id: number; found: Connection[] }
  | { id: number; bolts: ReturnType<typeof findBolts> }
  | { id: number; error: string };

const post = (m: SimReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const kept = new Map<number, { sample: Sampler; inside: (x: number, y: number, z: number) => boolean }>();

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const r = e.data;
  try {
    if (r.type === "sample") {
      const k = kept.get(r.of);
      const s = k ? sampleAt(k.sample, r.pos, r.scale, r.solid ? k.inside : undefined) : null;
      post({ id: r.id, sample: s }, s ? [s.u.buffer, s.vm.buffer, s.err.buffer, s.hit.buffer, ...(s.solid ? [s.solid.buffer] : [])] : []);
      return;
    }
    if (r.type === "connect") {
      const found = findConnections(r.bodies, r.gap);
      post({ id: r.id, found }, found.flatMap(f => [f.pa.buffer, f.pb.buffer]));
      return;
    }
    if (r.type === "bolts") {
      const bolts = findBolts(r.bodies, r.fast);
      post({ id: r.id, bolts }, bolts.bolts.flatMap(b => [b.a.buffer, b.b.buffer]));
      return;
    }
    if (!r.more) kept.clear();
    const passes = r.type === "modal" ? runModal(r.input) : r.type === "thermal" && r.input.thermal?.transient ? runTransient(r.input) : r.type === "thermal" ? runThermal(r.input, (s, inside) => { kept.set(r.id, { sample: s, inside }); }) : runStatic(r.input, (s, inside) => { kept.set(r.id, { sample: s, inside }); });
    for (const pass of passes) post({ id: r.id, pass }, [pass.u.buffer, pass.vm.buffer, pass.err.buffer, ...(pass.shapes ?? []).map(s => s.buffer), ...(pass.transient?.frames ?? []).map(f => f.buffer)]);
    post({ id: r.id, done: true });
  } catch (err) {
    post({ id: r.id, error: err instanceof Error ? err.message : String(err) });
  }
};
