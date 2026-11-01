/// <reference lib="webworker" />
// Parses Gerber / Excellon files (and zips of them) off the main thread.
import { buildLayer } from "./build";
import { loadPcbFiles } from "./load";

self.onmessage = async (e: MessageEvent<{ files: { name: string; data: ArrayBuffer }[] }>) => {
  const post = (m: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(m);
  try {
    post({ type: "progress", text: "Reading layers…", pct: 10 });
    const { layers, skipped } = await loadPcbFiles(e.data.files);
    const built = layers.map((l, i) => {
      post({ type: "progress", text: "Building {name} ({i}/{n})…", params: { name: l.name, i: i + 1, n: layers.length }, pct: 30 + (65 * i) / Math.max(1, layers.length) });
      return buildLayer(l);
    });
    const transfer: Transferable[] = built.flatMap(l => [l.packed.bb.buffer, l.packed.pOff.buffer, l.packed.pData.buffer, l.packed.sOff.buffer, l.packed.sData.buffer]);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "done", layers: built, skipped }, transfer);
  } catch (err) {
    post({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
};
