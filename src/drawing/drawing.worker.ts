/// <reference lib="webworker" />
// Drawing worker (FR-DRW-016): holds the drawing's model as an exact B-rep and
// projects views with OCCT's hidden-line removal. Parts are rebuilt from their
// document through the Modeller; STEP / IGES / BREP files are read as they are.
import { geometryDiff, project, readShape, section, shapeInfo, topology, type V3, type ViewDir } from "../kernel/drawing";
import { Assembler } from "../kernel/assembly";
import { Modeller } from "../kernel/model";
import type { AsmDoc } from "../asm/types";
import type { EdgeRef, PartDoc } from "../model/types";
import { modelItems } from "./items";

export type DrawingRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } }
  | { id: number; type: "project"; view: ViewDir }
  | { id: number; type: "section"; view: ViewDir; p: V3; poly?: number[] }
  /** Two versions of a part or an assembly compared by booleans (FR-PDM-050); the loaded model stays. */
  | { id: number; type: "diff"; a: DiffSrc; b: DiffSrc };

export type DiffSrc = { part?: PartDoc; asm?: AsmDoc };

/** The solid of a part, or the shown components of an assembly placed into one compound. */
function solidOf(src: DiffSrc): any {
  if (src.part) {
    const res = new Modeller(oc).evaluate(src.part);
    if (!res.body) throw new Error("The part has no body yet.");
    return res.body.shape;
  }
  const { placed } = new Assembler(oc).evaluate({ ...src.asm!, components: src.asm!.components.filter(c => !c.hidden) });
  const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  for (const pc of placed) b.Add(comp, pc.body.shape);
  return comp;
}

let oc: any = null;
let shape: any = null;
const post = (msg: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (e: MessageEvent<DrawingRequest>) => {
  const r = e.data;
  try {
    if (r.type === "init") {
      const factory = (await import(/* @vite-ignore */ `${r.base}opencascade.full.js?v=${__APP_VERSION__}`)).default;
      oc = await factory({
        print: () => {}, printErr: () => {},
        instantiateWasm: (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance) => void) => { WebAssembly.instantiate(r.module, imports).then(done); return {}; },
      });
      post({ id: r.id, ok: true });
    } else if (r.type === "load") {
      if (!oc) throw new Error("Kernel not started");
      let extra = {};
      if (r.part) {
        const md = new Modeller(oc), res = md.evaluate(r.part);
        if (!res.body) throw new Error("The part has no body yet.");
        shape = res.body.shape;
        const body = res.body;
        // A cosmetic thread's round edge, found by its persistent name.
        const edgeCircle = (ref: EdgeRef) => {
          try {
            const ad = new oc.BRepAdaptor_Curve_2(md.resolveEdge(body, ref));
            if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Circle) return null;
            const ci = ad.Circle(), l = ci.Location(), d = ci.Axis().Direction();
            return { c: [l.X(), l.Y(), l.Z()] as V3, ax: [d.X(), d.Y(), d.Z()] as V3, r: ci.Radius() };
          } catch { return null; }
        };
        let mi: ReturnType<typeof modelItems> = { items: [], holes: [], threads: [], sketches: [] };
        try { mi = modelItems(r.part, res.frames, res.sketches, edgeCircle); } catch { /* no model items */ }
        extra = { topo: topology(oc, shape, res.body.names), ...mi };
      } else if (r.asm) {
        // An assembly (FR-DRW-030): the shown components placed into one compound; face names get
        // the component id in front (`<comp>@<face>`) so an edge says which component it is on.
        const { placed } = new Assembler(oc).evaluate({ ...r.asm, components: r.asm.components.filter(c => !c.hidden) });
        if (!placed.length) throw new Error("The assembly has no components to draw.");
        const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
        b.MakeCompound(comp);
        const names: string[] = [], comps: { id: string; part: string; name: string }[] = [];
        for (const pc of placed) { b.Add(comp, pc.body.shape); names.push(...pc.body.names.map(n => `${pc.id}@${n}`)); comps.push({ id: pc.id, part: pc.part, name: pc.name }); }
        shape = comp;
        extra = { topo: topology(oc, shape, names), items: [], holes: [], comps };
      } else if (r.file) { shape = readShape(oc, r.file.bytes, r.file.name); extra = { topo: topology(oc, shape), items: [], holes: [] }; }
      else throw new Error("Nothing to load");
      post({ id: r.id, ok: true, ...shapeInfo(oc, shape), ...extra });
    } else if (r.type === "project") {
      if (!shape) throw new Error("No model loaded");
      post({ id: r.id, ok: true, proj: project(oc, shape, r.view) });
    } else if (r.type === "diff") {
      if (!oc) throw new Error("Kernel not started");
      post({ id: r.id, ok: true, diff: geometryDiff(oc, solidOf(r.a), solidOf(r.b)) });
    } else if (r.type === "section") {
      if (!shape) throw new Error("No model loaded");
      post({ id: r.id, ok: true, proj: section(oc, shape, r.view, r.p, 0.02, r.poly) });
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? `OpenCASCADE error ${err}` : String(err) });
  }
};
