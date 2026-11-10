/// <reference lib="webworker" />
// Kernel worker: the full OpenCASCADE build (opencascade.js, ~50 MB of WASM),
// started in the background after a model opens. It reads the file again with
// its B-rep kept, so measurements can use exact values and the model can be
// saved as STEP. The main thread compiles the WASM once and hands the module
// to the worker; the worker is kept for the next file while it is idle.
import { cutList, isWeld, type WeldHost } from "../weldments/kernel";
import { Kernel, type PartProbe } from "./occ";
import { solidworksToStep } from "./solidworks";
import { ParasolidReader } from "../sw/parasolid";
import { Modeller, type ModelMesh, type Named } from "./model";
import { Assembler } from "./assembly";
import type { AsmDoc } from "../asm/types";
import { analyzeMesh } from "../topology";
import { applyPatch, probe } from "./patch";
import { transformPart } from "../asm/light";
import { invert } from "../asm/math";
import { moveBodies } from "../tools/inertia";
import type { PartData } from "../topology";
import type { PartDoc } from "../model/types";
import parasolidWasm from "../sw/parasolid.wasm?url";

/** A part another worker evaluated for a parallel assembly build: BREP + face order + analysed mesh, or why it has no body. */
export interface Prebuilt { brep?: string; order?: number[]; names?: string[]; data?: PartData; error?: string }

export type KernelRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; buffer: ArrayBuffer; name: string }
  | { id: number; type: "exact"; probes: (PartProbe | null)[] }
  | { id: number; type: "step"; which: number[] | null; names: string[]; colors: ([number, number, number] | null)[] }
  | { id: number; type: "board"; loops: number[][]; holes: [number, number, number][]; z0: number; thickness: number; name: string }
  | { id: number; type: "solidworks"; files: { name: string; buffer: ArrayBuffer }[]; main: string }
  /** Modelling: evaluate a part document and return its body (FRS 6.3). */
  | { id: number; type: "partBody"; doc: PartDoc }
  | { id: number; type: "recognize"; doc: PartDoc }
  | { id: number; type: "recognizeBlends"; doc: PartDoc }
  | { id: number; type: "recognizeExtrudes"; doc: PartDoc }
  | { id: number; type: "recognizeFeatures"; doc: PartDoc }
  /** Assemblies (FRS 10): place the components and return one mesh per shown component. */
  | { id: number; type: "asm"; doc: AsmDoc; quality: number; pre?: Record<string, Prebuilt> }
  | { id: number; type: "asmPrime"; doc: AsmDoc; key: string; quality: number }
  | { id: number; type: "prebuild"; doc: PartDoc; quality: number }
  | { id: number; type: "ping" }
  /** Drops the document state so the worker can serve another document as the page's spare. */
  | { id: number; type: "reset" }
  | { id: number; type: "asmInterfere"; doc: AsmDoc; touch?: boolean }
  | { id: number; type: "asmClearance"; doc: AsmDoc; min: number }
  | { id: number; type: "asmStep"; doc: AsmDoc }
  | { id: number; type: "model"; doc: PartDoc; color: [number, number, number]; quality: number; previewAt?: number; verify?: boolean }
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
/** Analysed part meshes in part coordinates, by evaluated source (FR-ASM-031). */
let shared: WeakMap<object, { quality: number; data: PartData }> | null = null;
/** The last evaluated body, for STEP export. */
let lastBody: { shape: unknown; faces: unknown[] } | null = null;
let heap: () => number = () => 0;
let occ: unknown = null;
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
  occ = oc;
  kernel = new Kernel(oc);
  heap = () => oc.HEAPU8?.length ?? 0;
}

/** The analysed mesh of a part body in its own coordinates, made exact from the body. */
function analysePart(body: Named, mesh: ModelMesh, name: string): PartData {
  const data = analyzeMesh(mesh);
  data.name = name;
  const keep = kernel!.meshes;
  kernel!.meshes = [{ shape: body.shape, faces: body.faces, name, color: [0.72, 0.74, 0.78], solid: true }];
  try { applyPatch(data, kernel!.exact(0, probe(data))); } finally { kernel!.meshes = keep; }
  return data;
}

self.onmessage = async (e: MessageEvent<KernelRequest>) => {
  const r = e.data;
  try {
    if (r.type === "init") { await init(r.base, r.module); post({ id: r.id, ok: true }); return; }
    if (!kernel) throw new Error("Kernel not started");
    if (r.type === "ping") { post({ id: r.id, ok: true }); return; }
    if (r.type === "reset") {
      modeller = null; assembler = null; shared = null; lastBody = null;
      kernel = new Kernel(occ as ConstructorParameters<typeof Kernel>[0]);
      post({ id: r.id, ok: true, heap: heap() });
      return;
    }
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
      modeller.setVerify(!!r.verify);
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
      const solidShown = !res.body ? null : !split || !info.length ? res.body : vis.length ? modeller.shownBodies(vis.map(b => b.part)) : null;
      // Surface bodies (FRS 9.11) come after the solids in the view, so solid face indices stay put.
      const shown = res.sheets ? (solidShown ? modeller.shownBodies([solidShown, res.sheets]) : res.sheets) : solidShown;
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
      // `faces`: how many of the view's faces the body has (in order; 0 when hidden), so the tree can light it up.
      // Each body's own mass properties when there are several or one has its own material (FR-MAT-001).
      const ownMass = info.length > 1 || Object.values(state).some(b => b.material);
      const bodies = info.map(b => ({ key: b.key, ref: b.ref, volume: b.volume, faces: state[b.key]?.hidden || !shown ? 0 : b.part.faces.length, ...(ownMass ? modeller!.bodyMass(b.part) : {}) }));
      // Weldment cut list (FR-FT-121).
      const cut = res.body && r.doc.features.some(f => isWeld(f) && !f.suppressed) ? cutList(modeller as unknown as WeldHost, info, r.doc, res.frames) : undefined;
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
        const shown = cut ? (before && pr.body ? modeller.removed(before, pr.body) : null) : pr.sheets ? (pr.body ? modeller.shownBodies([pr.body, pr.sheets]) : pr.sheets) : pr.body;
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
      post({ id: r.id, ok: true, statuses: res.statuses, frames: res.frames, sketches: res.sketches, curves: res.curves, regions: res.regions, sheet: res.sheet, data, faceNames: shown?.names ?? [], sheetFaces: res.sheets?.faces.length ?? 0, bodies, cutList: cut, props, preview, heap: heap(), ms: { eval: t1 - t0, mesh: performance.now() - t1 } });
    } else if (r.type === "prebuild") {
      // Parallel assembly builds (pool.ts): a helper worker evaluates one part and sends its body
      // as BREP text with the face order, plus the analysed mesh, to the assembly's own worker.
      const m = new Modeller(kernel.module);
      let out: Prebuilt;
      try {
        const res = m.evaluate(r.doc);
        const bad = res.statuses.find(x => !x.ok && x.code !== "suppressed");
        const t = res.body && m.toTransport(res.body);
        if (!res.body) out = { error: bad?.message ?? "The part has no body." };
        else if (!t) throw new Error("The part body could not be sent.");
        else out = { ...t, names: res.body.names, data: analysePart(res.body, m.mesh(res.body, r.doc.name, [0.72, 0.74, 0.78], r.quality), r.doc.name) };
      } catch (err) {
        out = { error: err instanceof Error ? err.message : String(err) };
      }
      post({ id: r.id, ok: true, pre: out, heap: heap() });
    } else if (r.type === "asmPrime") {
      // This worker's own share of a parallel build: evaluated and analysed now, placed by the next "asm".
      assembler ??= new Assembler(kernel.module);
      shared ??= new WeakMap();
      const p = assembler.prime(r.key, r.doc, r.quality);
      const base = shared.get(p.src);
      if (p.body && !(base && base.quality === r.quality)) shared.set(p.src, { quality: r.quality, data: analysePart(p.body, p.mesh(), r.doc.parts[r.key].name) });
      post({ id: r.id, ok: true });
    } else if (r.type === "asm") {
      assembler ??= new Assembler(kernel.module);
      shared ??= new WeakMap();
      const t0 = performance.now();
      for (const [k, pre] of Object.entries(r.pre ?? {})) {
        if (!r.doc.parts[k]) continue;
        try {
          const src = assembler.adopt(k, r.doc, pre);
          if (pre.data) shared.set(src, { quality: r.quality, data: pre.data });
        } catch { /* evaluated here instead */ }
      }
      const { placed, statuses } = assembler.evaluate(r.doc, r.quality);
      const parts = [];
      kernel.meshes = [];
      for (const p of placed) {
        const comp = r.doc.components.find(c => c.id === p.id)!;
        if (comp.hidden) continue;
        const color = (comp.color ?? r.doc.parts[p.part].doc.color ?? [0.72, 0.74, 0.78]) as [number, number, number];
        kernel.meshes.push({ shape: p.body.shape, faces: p.body.faces, name: p.name, color, solid: true });
        // Instances share one analysis of their part (FR-ASM-031), moved to where they are.
        const base = shared.get(p.src);
        let data: PartData;
        if (base && base.quality === r.quality) data = transformPart(base.data, p.tf, p.name);
        else if (assembler.prime(p.part, r.doc, r.quality).src === p.src) {
          // Analysed in part coordinates, like the parallel builds (a tilted copy's analysis can find spurious curve edges).
          const pr = assembler.prime(p.part, r.doc, r.quality);
          const own = analysePart(pr.body!, pr.mesh(), p.name);
          shared.set(p.src, { quality: r.quality, data: own });
          data = transformPart(own, p.tf, p.name);
        } else {
          // A component cut by an assembly feature has its own world mesh.
          data = analyzeMesh(p.mesh());
          data.name = p.name;
          applyPatch(data, kernel.exact(kernel.meshes.length - 1, probe(data)));
          shared.set(p.src, { quality: r.quality, data: transformPart(data, invert(p.tf)) });
        }
        data.color = color;
        const own = assembler.ownBodies(p.part, r.doc, p.src);
        parts.push({ id: p.id, data, faces: p.body.names, ...(own ? { bodies: moveBodies(own, p.tf) } : {}) });
      }
      post({ id: r.id, ok: true, parts, statuses, features: assembler.featureStatus, props: assembler.props(placed), heap: heap(), ms: performance.now() - t0 });
    } else if (r.type === "asmClearance") {
      assembler ??= new Assembler(kernel.module);
      const { placed } = assembler.evaluate(r.doc, 1);
      const shown = placed.filter(p => !r.doc.components.find(c => c.id === p.id)?.hidden);
      post({ id: r.id, ok: true, pairs: assembler.clearance(shown, r.min) });
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
    } else if (r.type === "recognize") {
      // Feature recognition (FR-FT-102) in its own modeller, so the part's feature cache stays as it is.
      post({ id: r.id, ok: true, ...new Modeller(kernel.module).recognizeHoles(r.doc) });
    } else if (r.type === "recognizeBlends") {
      post({ id: r.id, ok: true, features: new Modeller(kernel.module).recognizeBlends(r.doc) });
    } else if (r.type === "recognizeExtrudes") {
      post({ id: r.id, ok: true, features: new Modeller(kernel.module).recognizeExtrudes(r.doc) });
    } else if (r.type === "recognizeFeatures") {
      post({ id: r.id, ok: true, features: new Modeller(kernel.module).recognizeFeatures(r.doc) });
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
