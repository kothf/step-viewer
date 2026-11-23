// Structural analysis (FR-SARC-002): the solver's own worker. One solve at a time; every finished pass
// is posted at once. Cancelling = the page ends this worker and keeps the passes it has (FR-SARC-004).
// The last pass's solution of a static study stays here, so the page can read it at other points
// (results on section planes, FR-RES-030).

import CholWorker from "./chol.worker?worker";
import { canShare, setHelpers, threadStats } from "./threads";
import { findConnections, type Connection } from "./connect";
import { findBolts, type FastenerBody } from "./bolts";
import { progress, progressTo, type SimProgress } from "./progress";
import { runModal, runStatic, runThermal, runTransient, sampleAt, type PassResult, type RunInput, type SampleResult, type Sampler } from "./run";

export type SimRequest =
  | { id: number; type: "threads"; n: number }
  | { id: number; type: "static" | "modal" | "thermal"; input: RunInput; /** Keep the solutions of the solves before (the other load cases). */ more?: boolean }
  | { id: number; type: "connect"; bodies: Float64Array[]; gap: number }
  | { id: number; type: "bolts"; bodies: Float64Array[]; fast: FastenerBody[] }
  | { id: number; type: "sample"; of: number; pos: Float32Array; scale: number; solid?: boolean };
export type SimReply =
  | { id: number; pass: PassResult }
  | { id: number; progress: SimProgress }
  | { id: number; done: true; threads: ReturnType<typeof threadStats> }
  | { id: number; sample: SampleResult | null }
  | { id: number; found: Connection[] }
  | { id: number; bolts: ReturnType<typeof findBolts> }
  | { id: number; error: string };

/**
 * Helper threads for the factorisations (`n` threads in all, this one among them). They need shared memory, which
 * a page has only when it is cross-origin isolated; without it the solver runs on this thread alone.
 */
let ready: Promise<void> = Promise.resolve();
function useThreads(n: number) {
  if (!canShare() || !(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) return;
  try {
    const list = Array.from({ length: Math.max(0, Math.min(16, n) - 1) }, () => new CholWorker());
    setHelpers(list);
    // A helper made just before this thread starts a long solve would not start until the solve ends (a worker's
    // own workers are started through its event loop), so a solve waits for them to report in, 3 s at most.
    const up = Promise.all(list.map(w => new Promise<void>(res => { w.onmessage = () => res(); w.onerror = () => res(); })));
    ready = Promise.race([up, new Promise<void>(res => setTimeout(res, 3000))]).then(() => {});
  } catch { setHelpers([]); }
}

const post = (m: SimReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const kept = new Map<number, { sample: Sampler; inside: (x: number, y: number, z: number) => boolean }>();

self.onmessage = async (e: MessageEvent<SimRequest>) => {
  const r = e.data;
  try {
    if (r.type === "threads") { useThreads(r.n); return; }
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
    await ready;
    if (!r.more) kept.clear();
    progressTo(p => post({ id: r.id, progress: p }));
    progress("geometry", 0, 1);
    const passes = r.type === "modal" ? runModal(r.input) : r.type === "thermal" && r.input.thermal?.transient ? runTransient(r.input) : r.type === "thermal" ? runThermal(r.input, (s, inside) => { kept.set(r.id, { sample: s, inside }); }) : runStatic(r.input, (s, inside) => { kept.set(r.id, { sample: s, inside }); });
    for (const pass of passes) post({ id: r.id, pass }, [pass.u.buffer, pass.vm.buffer, pass.err.buffer, ...(pass.shapes ?? []).map(s => s.buffer), ...(pass.transient?.frames ?? []).map(f => f.buffer)]);
    progressTo(null);
    post({ id: r.id, done: true, threads: threadStats() });
  } catch (err) {
    progressTo(null);
    post({ id: r.id, error: err instanceof Error ? err.message : String(err) });
  }
};
