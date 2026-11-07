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
import { Assembler } from "./assembly";
import type { AsmDoc } from "../asm/types";
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
  | { id: number; type: "partBody"; doc: PartDoc }
  /** Assemblies (FRS 10): place the components and return one mesh per shown component. */
  | { id: number; type: "asm"; doc: AsmDoc; quality: number }
  | { id: number; type: "asmInterfere"; doc: AsmDoc; touch?: boolean }
  | { id: number; type: "asmStep"; doc: AsmDoc }
  | { id: number; type: "model"; doc: PartDoc; color: [number, number, number]; quality: number; previewAt?: number }
  /** Modelling: STEP of the last evaluated body. */
  | { id: number; type: "modelStep"; name: string; color: [number, number, number] }
  | { id: number; type: "importBody"; buffer: ArrayBuffer; name: string };

let parasolid: Promise<ParasolidReader> | null = null;
/** The Parasolid reader (600 kB of WASM), loaded at the first SolidWorks file. */
function parasolidReader() {
  parasolid ??= fetch(parasolidWasm).then(r => r.arrayBuffer()).then(b => ParasolidReader.create(b));
  parasolid.catch(() => { parasolid = null; });
  return parasolid;
}

let kernel: Kernel | null = null;
let modeller: Modeller | null = null;
let assembler: Assembler | null = null;
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
      // The Bodies folder (FR-BODY-001): hidden bodies leave the view, coloured ones get their colour.
      const info = res.body ? modeller.bodyInfo(res.body, r.doc) : [];
      const state = r.doc.bodies ?? {};
      const vis = info.filter(b => !state[b.key]?.hidden);
      const split = info.length > 1 || vis.length < info.length || info.some(b => state[b.key]?.color);
      const shown = !res.body ? null : !split || !info.length ? res.body : vis.length ? modeller.shownBodies(vis.map(b => b.part)) : null;
      if (shown) {
        const mesh = modeller.mesh(shown, r.doc.name, r.color, r.quality);
        if (split) {
          let at = 0;
          for (const b of vis) {
            const c = state[b.key]?.color;
            if (c) for (let i = at; i < at + b.part.faces.length; i++) if (mesh.brep_faces[i]) mesh.brep_faces[i].color = c;
            at += b.part.faces.length;
          }
        }
        data = analyzeMesh(mesh);
        data.name = r.doc.name;
        data.color = r.color;
        kernel.meshes = [{ shape: shown.shape, faces: shown.faces, name: r.doc.name, color: r.color, solid: true }];
        applyPatch(data, kernel.exact(0, probe(data)));
      }
      if (res.body) props = modeller.props(res.body);
      const bodies = info.map(b => ({ key: b.key, ref: b.ref, volume: b.volume }));
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
      post({ id: r.id, ok: true, statuses: res.statuses, frames: res.frames, sketches: res.sketches, curves: res.curves, data, faceNames: shown?.names ?? [], bodies, props, preview, heap: heap(), ms: { eval: t1 - t0, mesh: performance.now() - t1 } });
    } else if (r.type === "asm") {
      assembler ??= new Assembler(kernel.module);
      const t0 = performance.now();
      const { placed, statuses } = assembler.evaluate(r.doc, r.quality);
      const parts = [];
      kernel.meshes = [];
      for (const p of placed) {
        const comp = r.doc.components.find(c => c.id === p.id)!;
        if (comp.hidden) continue;
        const color = (comp.color ?? r.doc.parts[p.part].doc.color ?? [0.72, 0.74, 0.78]) as [number, number, number];
        const data = analyzeMesh(p.mesh());
        data.name = p.name;
        data.color = color;
        kernel.meshes.push({ shape: p.body.shape, faces: p.body.faces, name: p.name, color, solid: true });
        applyPatch(data, kernel.exact(kernel.meshes.length - 1, probe(data)));
        parts.push({ id: p.id, data, faces: p.body.names });
      }
      post({ id: r.id, ok: true, parts, statuses, props: assembler.props(placed), heap: heap(), ms: performance.now() - t0 });
    } else if (r.type === "asmInterfere") {
      assembler ??= new Assembler(kernel.module);
      const { placed } = assembler.evaluate(r.doc, 1);
      const shown = placed.filter(p => !r.doc.components.find(c => c.id === p.id)?.hidden);
      post({ id: r.id, ok: true, pairs: assembler.interference(shown, !!r.touch) });
    } else if (r.type === "asmStep") {
      // Assembly STEP (AT-P4-6): one product per part, one named instance per shown component.
      assembler ??= new Assembler(kernel.module);
      const { placed } = assembler.evaluate(r.doc, 1);
      const shown = placed.filter(p => !r.doc.components.find(c => c.id === p.id)?.hidden);
      if (!shown.length) throw new Error("There is no body to export yet.");
      const keys = [...new Set(shown.map(p => p.part))];
      const parts = keys.map(k => ({ key: k, shape: assembler!.sourceBody(k, r.doc)!.shape, name: r.doc.parts[k].name, color: (r.doc.parts[k].doc.color ?? [0.72, 0.74, 0.78]) as [number, number, number] }));
      const bytes = kernel.writeAssemblyStep(r.doc.name, parts, shown.map(p => ({ part: p.part, name: p.name, tf: p.tf }))).slice();
      post({ id: r.id, ok: true, bytes }, [bytes.buffer]);
    } else if (r.type === "partBody") {
      // Insert part (FR-BODY-005): the other part is evaluated on its own, so this part's feature cache stays.
      const other = new Modeller(kernel.module).evaluate(r.doc);
      if (!other.body) throw new Error("The part has no body.");
      post({ id: r.id, ok: true, ...(modeller ??= new Modeller(kernel.module)).brepText(other.body) });
    } else if (r.type === "importBody") {
      kernel.load(new Uint8Array(r.buffer), r.name);
      post({ id: r.id, ok: true, ...kernel.brepText() });
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
