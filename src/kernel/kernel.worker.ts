/// <reference lib="webworker" />
// Kernel worker: the full OpenCASCADE build (opencascade.js, ~50 MB of WASM),
// started in the background after a model opens. It reads the file again with
// its B-rep kept, so measurements can use exact values and the model can be
// saved as STEP. The main thread compiles the WASM once and hands the module
// to the worker; the worker is kept for the next file while it is idle.
import { Kernel, type PartProbe } from "./occ";

export type KernelRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; buffer: ArrayBuffer; name: string }
  | { id: number; type: "exact"; probes: (PartProbe | null)[] }
  | { id: number; type: "step"; which: number[] | null; names: string[]; colors: ([number, number, number] | null)[] }
  | { id: number; type: "board"; loops: number[][]; holes: [number, number, number][]; z0: number; thickness: number; name: string };

let kernel: Kernel | null = null;
let heap: () => number = () => 0;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function init(base: string, module: WebAssembly.Module) {
  const v = `?v=${__APP_VERSION__}`;
  const factory = (await import(/* @vite-ignore */ `${base}opencascade.full.js${v}`)).default;
  const oc = await factory({
    print: () => {},
    printErr: () => {},
    instantiateWasm: (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance) => void) => {
      WebAssembly.instantiate(module, imports).then(inst => done(inst));
      return {};
    },
  });
  kernel = new Kernel(oc);
  heap = () => oc.HEAPU8?.length ?? 0;
}

self.onmessage = async (e: MessageEvent<KernelRequest>) => {
  const r = e.data;
  try {
    if (r.type === "init") { await init(r.base, r.module); post({ id: r.id, ok: true }); return; }
    if (!kernel) throw new Error("Kernel not started");
    if (r.type === "load") post({ id: r.id, ok: true, counts: kernel.load(new Uint8Array(r.buffer), r.name), heap: heap() });
    else if (r.type === "exact") post({ id: r.id, ok: true, patches: r.probes.map((p, i) => (p ? kernel!.exact(i, p) : null)) });
    else if (r.type === "step") {
      const bytes = kernel.writeStep(r.which, r.names, r.colors);
      const copy = bytes.slice();
      post({ id: r.id, ok: true, bytes: copy }, [copy.buffer]);
    } else if (r.type === "board") {
      const bytes = kernel.boardStep(r.loops, r.holes, r.z0, r.thickness, r.name).slice();
      post({ id: r.id, ok: true, bytes }, [bytes.buffer]);
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? `OpenCASCADE error ${err}` : String(err) });
  }
};
