/// <reference lib="webworker" />
// Kernel worker: the full OpenCASCADE build (opencascade.js, ~50 MB of WASM),
// started in the background after a model opens. It reads the file again with
// its B-rep kept, so measurements can use exact values and the model can be
// saved as STEP. The main thread compiles the WASM once and hands the module
// to the worker; the worker is kept for the next file while it is idle.
import { Kernel, type PartProbe } from "./occ";
import { solidworksToStep } from "./solidworks";
import { ParasolidReader } from "../sw/parasolid";
import { Modeller } from "./model";
import { analyzeMesh } from "../topology";
import { applyPatch, probe } from "./patch";
import type { PartDoc } from "../model/types";
import parasolidWasm from "../sw/parasolid.wasm?url";

export type KernelRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; buffer: ArrayBuffer; name: string }
  | { id: number; type: "exact"; probes: (PartProbe | null)[] }
  | { id: number; type: "step"; which: number[] | null; names: string[]; colors: ([number, number, number] | null)[] }
  | { id: number; type: "board"; loops: number[][]; holes: [number, number, number][]; z0: number; thickness: number; name: string }
  | { id: number; type: "solidworks"; files: { name: string; buffer: ArrayBuffer }[]; main: string }
  /** Modelling: evaluate a part document and return its body (FRS 6.3). */
  | { id: number; type: "model"; doc: PartDoc; color: [number, number, number]; quality: number; previewAt?: number }
  /** Modelling: STEP of the last evaluated body. */
  | { id: number; type: "modelStep"; name: string; color: [number, number, number] };

let parasolid: Promise<ParasolidReader> | null = null;
/** The Parasolid reader (600 kB of WASM), loaded at the first SolidWorks file. */
function parasolidReader() {
  parasolid ??= fetch(parasolidWasm).then(r => r.arrayBuffer()).then(b => ParasolidReader.create(b));
  parasolid.catch(() => { parasolid = null; });
  return parasolid;
}

let kernel: Kernel | null = null;
let modeller: Modeller | null = null;
/** The last evaluated body, for STEP export. */
let lastBody: { shape: unknown; faces: unknown[] } | null = null;
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
    } else if (r.type === "solidworks") {
      const reader = await parasolidReader();
      const k = kernel;
      const { bytes, report } = await solidworksToStep(k.module, reader, r.files.map(f => ({ name: f.name, bytes: new Uint8Array(f.buffer) })), r.main, doc => k.stepOfDoc(doc));
      const preview = report.preview?.slice() ?? null;
      const transfer: Transferable[] = [];
      if (bytes) transfer.push(bytes.buffer);
      if (preview) transfer.push(preview.buffer);
      post({ id: r.id, ok: true, bytes, report: { ...report, preview } }, transfer);
    } else if (r.type === "model") {
      modeller ??= new Modeller(kernel.module);
      const t0 = performance.now();
      const res = modeller.evaluate(r.doc);
      const t1 = performance.now();
      let data = null, props = null;
      lastBody = res.body;
      if (res.body) {
        const mesh = modeller.mesh(res.body, r.doc.name, r.color, r.quality);
        data = analyzeMesh(mesh);
        data.name = r.doc.name;
        data.color = r.color;
        kernel.meshes = [{ shape: res.body.shape, faces: res.body.faces, name: r.doc.name, color: r.color, solid: true }];
        applyPatch(data, kernel.exact(0, probe(data)));
        props = modeller.props(res.body);
      }
      // Preview of the feature at `previewAt` (fillet, chamfer) while its edges are picked on the body before it:
      // only the faces it makes, as a plain triangle list.
      let preview: { position: number[]; status: unknown } | null = null;
      if (r.previewAt != null) {
        const pf = r.doc.features[r.previewAt];
        const fid = pf?.id;
        const pr = modeller.evaluate({ ...r.doc, rollback: r.previewAt + 1 });
        const status = pr.statuses[r.previewAt];
        const position: number[] = [];
        // A cut shows the material it removes (the body before it minus the body after it).
        const cut = (pf?.type === "extrude" || pf?.type === "revolve") && pf.op === "cut";
        const before = cut && pr.body && status?.ok && status.code !== "suppressed" ? modeller.evaluate({ ...r.doc, rollback: r.previewAt }).body : null;
        const shown = cut ? (before && pr.body ? modeller.removed(before, pr.body) : null) : pr.body;
        if (shown && fid && status?.ok) {
          const m = modeller.mesh(shown, "preview", r.color, r.quality);
          const P = m.attributes.position.array, I = m.index.array;
          shown.names.forEach((n, i) => {
            if (!cut && !n.startsWith(`${fid}:`)) return;
            const fr = m.brep_faces[i];
            for (let t = fr.first; t <= fr.last; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k]; position.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
          });
        }
        preview = { position, status };
      }
      post({ id: r.id, ok: true, statuses: res.statuses, frames: res.frames, data, faceNames: res.body?.names ?? [], props, preview, heap: heap(), ms: { eval: t1 - t0, mesh: performance.now() - t1 } });
    } else if (r.type === "modelStep") {
      if (!lastBody) throw new Error("There is no body to export yet.");
      kernel.meshes = [{ shape: lastBody.shape, faces: lastBody.faces, name: r.name, color: r.color, solid: true }];
      const bytes = kernel.writeStep([0], [r.name], [r.color]).slice();
      post({ id: r.id, ok: true, bytes }, [bytes.buffer]);
    } else if (r.type === "board") {
      const bytes = kernel.boardStep(r.loops, r.holes, r.z0, r.thickness, r.name).slice();
      post({ id: r.id, ok: true, bytes }, [bytes.buffer]);
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? `OpenCASCADE error ${err}` : String(err) });
  }
};
