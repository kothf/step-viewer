/// <reference lib="webworker" />
// Drawing worker (FR-DRW-016): holds the drawing's model as an exact B-rep and
// projects views with OCCT's hidden-line removal. Parts are rebuilt from their
// document through the Modeller; STEP / IGES / BREP files are read as they are.
import { FLAT_CONFIG, type Align, type Stair } from "./views";
import { flatBends, flatPatternDoc, flatToXY } from "../sheetmetal/sheet";
import { geometryDiff, project, projectPoly, readShape, alignedShape, section, shadeTris, shapeInfo, topology, type V3, type ViewDir } from "../kernel/drawing";
import { Assembler } from "../kernel/assembly";
import { Modeller } from "../kernel/model";
import type { AsmDoc } from "../asm/types";
import type { EdgeRef, PartDoc } from "../model/types";
import { modelItems, type CutInfo, type WeldInfo } from "./items";
import { cutList, type WeldHost } from "../weldments/kernel";
import { cutKey, splitSubs } from "../weldments/types";
import { findMaterial } from "../tools/materials";
import { activate } from "../model/configs";

export type DrawingRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array } }
  | { id: number; type: "project"; view: ViewDir; shade?: boolean; cfg?: string; only?: string[] }
  /** A quick polygonal preview of a view (FR-DRW-016) while the exact one is computed. */
  | { id: number; type: "preview"; view: ViewDir; cfg?: string; only?: string[] }
  | { id: number; type: "section"; view: ViewDir; p: V3; poly?: number[]; stair?: Stair; align?: Align; exclude?: string[]; cfg?: string; only?: string[] }
  /** Another configuration of the loaded part (FR-DRW-010): built once, its facts returned like a load's. */
  | { id: number; type: "config"; name: string }
  | { id: number; type: "alt"; view: ViewDir; moves: { comp: string; tf: number[] }[] }
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
/** The loaded shape's face names in TopExp order (absent for files: faces are then f<i>, as `topology` names them). */
let shapeNames: string[] | undefined;
/** An assembly's placed component shapes by id, for alternate positions. */
let placedShapes: { id: string; shape: any; mat: string | null }[] = [];
/** The loaded model's material (a part) for section hatching. */
let modelMat: string | null = null;
/** Who each solid of a shape belongs to (TopExp order), for hatching each component or body on its own (FR-DRW-012). */
function solidOwners(list: { id: string; shape: any; mat: string | null }[]): { key: string; mat: string | null }[] {
  const A = oc.TopAbs_ShapeEnum, out: { key: string; mat: string | null }[] = [];
  for (const pc of list) {
    let k = 0;
    for (const ex = new oc.TopExp_Explorer_2(pc.shape, A.TopAbs_SOLID, A.TopAbs_SHAPE); ex.More(); ex.Next(), k++) out.push({ key: pc.id || `body${k}`, mat: pc.mat });
  }
  return out;
}
/** The loaded part's document, for its other configurations, and those built so far by name. */
let partDoc: PartDoc | null = null;
const variants = new Map<string, { shape: any; mat: string | null; names?: string[] }>();

/** A part's solid with its topology and model items (dimensions, holes, threads, sketches). */
function buildPart(doc: PartDoc): { shape: any; mat: string | null; names: string[]; extra: Record<string, unknown> } {
  const md = new Modeller(oc), res = md.evaluate(doc);
  if (!res.body) throw new Error("The part has no body yet.");
  const body = res.body, shape = body.shape;
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
  try { mi = modelItems(doc, res.frames, res.sketches, edgeCircle); } catch { /* no model items */ }
  // Weld table (FR-FT-121): the cut list's beads, less the items marked Exclude from cut list.
  // Cut list table: every item in the dialog's order (sub-weldments after the loose items), numbered the same way.
  let welds: WeldInfo[] = [], cuts: CutInfo[] = [];
  const WELD_TYPES = new Set(["member", "endcap", "gusset", "weldbead"]);
  if (doc.features.some(f => WELD_TYPES.has(f.type) && !f.suppressed)) {
    try {
      const raw = cutList(md as unknown as WeldHost, md.bodyInfo(body, doc), doc, res.frames), items = splitSubs(raw, doc.subWelds);
      const density = doc.material?.density ?? 7.85;
      let n = 0;
      for (const c of items) {
        const p = doc.cutProps?.[cutKey(c)];
        if (p?.excl) continue;
        const kg = c.volume * (findMaterial(p?.mat)?.density ?? density) / 1e6;
        cuts.push({ item: ++n, kind: c.kind, desc: p?.desc || c.desc, ...(p?.desc ? { own: true } : {}), qty: c.kind === "bead" ? 1 : c.qty, kg,
          ...(c.length != null ? { length: c.length } : {}), ...(c.kind === "member" ? { a1: c.angle1 ?? 0, a2: c.angle2 ?? 0 } : {}),
          ...(c.plate ? { plate: c.plate } : {}), ...(c.inter ? { inter: c.inter } : {}) });
      }
      welds = raw.filter(c => c.kind === "bead" && !doc.cutProps?.[cutKey(c)]?.excl)
        .map(c => ({ legs: c.desc, length: c.length ?? 0, qty: c.qty, ...(c.inter ? { inter: c.inter } : {}) }));
    } catch { /* no weld or cut list table rows */ }
  }
  return { shape, mat: doc.material?.name ?? null, names: body.names, extra: { topo: topology(oc, shape, body.names), ...mi, welds, cuts } };
}

/** The shape (and material) a request draws: the loaded model, or one of the part's configurations. */
/** The placed components a view shows alone (a top-level id takes its sub-components along), as one compound. */
function onlyOf(ids: string[]): { shape: any; list: typeof placedShapes } {
  const list = placedShapes.filter(pc => ids.some(x => pc.id === x || pc.id.startsWith(`${x}/`)));
  if (!list.length) throw new Error("None of the view's components are in the assembly.");
  const b = new oc.BRep_Builder(), c = new oc.TopoDS_Compound();
  b.MakeCompound(c);
  for (const pc of list) b.Add(c, pc.shape);
  return { shape: c, list };
}

function shapeOf(cfg?: string): { shape: any; mat: string | null; names?: string[] } {
  if (!cfg || !partDoc || cfg === partDoc.config) return { shape, mat: modelMat, names: shapeNames };
  const v = variants.get(cfg);
  if (!v) throw new Error(`Configuration "${cfg}" is not loaded`);
  return v;
}

/** Names a face of `full` (or of a compound of its pieces, which share its faces) by the model's face names; null for faces it lacks. */
function namer(full: any, names?: string[]): (face: any) => string | null {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(full, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
  return face => { const i = map.FindIndex(face); return i > 0 ? names?.[i - 1] ?? `f${i - 1}` : null; };
}

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
      placedShapes = [];
      modelMat = null;
      shapeNames = undefined;
      if (!oc) throw new Error("Kernel not started");
      let extra = {};
      partDoc = null;
      variants.clear();
      if (r.part) {
        const b = buildPart(r.part);
        shape = b.shape; modelMat = b.mat; extra = b.extra; shapeNames = b.names;
        partDoc = r.part;
      } else if (r.asm) {
        // An assembly (FR-DRW-030): the shown components placed into one compound; face names get
        // the component id in front (`<comp>@<face>`) so an edge says which component it is on.
        const { placed } = new Assembler(oc).evaluate({ ...r.asm, components: r.asm.components.filter(c => !c.hidden) });
        if (!placed.length) throw new Error("The assembly has no components to draw.");
        const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
        b.MakeCompound(comp);
        const names: string[] = [], comps: { id: string; part: string; name: string }[] = [];
        placedShapes = placed.map(pc => ({ id: pc.id, shape: pc.body.shape, mat: r.asm!.parts[pc.part]?.doc?.material?.name ?? null }));
        for (const pc of placed) { b.Add(comp, pc.body.shape); names.push(...pc.body.names.map(n => `${pc.id}@${n}`)); comps.push({ id: pc.id, part: pc.part, name: pc.name }); }
        shape = comp; shapeNames = names;
        extra = { topo: topology(oc, shape, names), items: [], holes: [], comps };
      } else if (r.file) { shape = readShape(oc, r.file.bytes, r.file.name); extra = { topo: topology(oc, shape), items: [], holes: [] }; }
      else throw new Error("Nothing to load");
      post({ id: r.id, ok: true, ...shapeInfo(oc, shape), ...extra });
    } else if (r.type === "config" && r.name === FLAT_CONFIG) {
      // Flat pattern (FR-FT-120): the part with its flat pattern shown, laid on XY with the top face up.
      const d = partDoc && flatPatternDoc(partDoc);
      if (!d) throw new Error("Only a sheet metal part has a flat pattern");
      const md = new Modeller(oc), res = md.evaluate(d);
      if (!res.body || !res.sheet) throw new Error("The flat pattern could not be made.");
      const t = flatToXY(res.sheet), trsf = new oc.gp_Trsf_1();
      trsf.SetValues(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11]);
      const flat = res.body.shape.Moved(new oc.TopLoc_Location_2(trsf), false);
      variants.set(r.name, { shape: flat, mat: d.material?.name ?? null, names: res.body.names });
      post({ id: r.id, ok: true, ...shapeInfo(oc, flat), topo: topology(oc, flat, res.body.names), items: [], holes: [], threads: [], sketches: [], bends: flatBends(res.sheet) });
    } else if (r.type === "config") {
      if (!partDoc) throw new Error("Only a part has configurations");
      if (!partDoc.configs?.some(c => c.name === r.name)) throw new Error(`The part has no configuration "${r.name}"`);
      const d: PartDoc = structuredClone(partDoc);
      activate(d, r.name);
      const b = buildPart(d);
      variants.set(r.name, { shape: b.shape, mat: b.mat, names: b.names });
      post({ id: r.id, ok: true, ...shapeInfo(oc, b.shape), ...b.extra });
    } else if (r.type === "project") {
      if (!shape) throw new Error("No model loaded");
      const sh = r.only?.length && placedShapes.length ? onlyOf(r.only).shape : shapeOf(r.cfg).shape;
      const proj = project(oc, sh, r.view);
      if (r.shade) {
        // Mesh chord error: 1/400 of the model's size, so the shading stays light even for big models.
        const [lo, hi] = shapeInfo(oc, sh).box;
        proj.shade = shadeTris(oc, sh, r.view, Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 400));
      }
      post({ id: r.id, ok: true, proj });
    } else if (r.type === "preview") {
      if (!shape) throw new Error("No model loaded");
      const sh = r.only?.length && placedShapes.length ? onlyOf(r.only).shape : shapeOf(r.cfg).shape;
      // Mesh chord error: 1/300 of the model's size (the preview only has to look right).
      const [lo, hi] = shapeInfo(oc, sh).box;
      post({ id: r.id, ok: true, proj: projectPoly(oc, sh, r.view, Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 300)) });
    } else if (r.type === "diff") {
      if (!oc) throw new Error("Kernel not started");
      post({ id: r.id, ok: true, diff: geometryDiff(oc, solidOf(r.a), solidOf(r.b)) });
    } else if (r.type === "alt") {
      // Alternate position (FR-DRW-015): the moved components alone (a sub-assembly's children go with it), projected.
      const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
      b.MakeCompound(comp);
      let n = 0;
      for (const mv of r.moves) {
        const t = mv.tf, trsf = new oc.gp_Trsf_1();
        trsf.SetValues(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11]);
        const loc = new oc.TopLoc_Location_2(trsf);
        for (const pc of placedShapes) if (pc.id === mv.comp || pc.id.startsWith(`${mv.comp}/`)) { b.Add(comp, pc.shape.Moved(loc, false)); n++; }
      }
      post({ id: r.id, ok: true, proj: n ? project(oc, comp, r.view) : { vis: [], hid: [], box: [0, 0, 0, 0], ms: 0 } });
    } else if (r.type === "section") {
      if (!shape) throw new Error("No model loaded");
      const own0 = shapeOf(r.cfg), modelMat = own0.mat;
      // Components left whole (FR-DRW-012) are drawn but not cut; a top-level id takes its sub-components along.
      const only = r.only?.length && placedShapes.length ? onlyOf(r.only) : null, base = only ? only.list : placedShapes;
      let cutShape = only ? only.shape : own0.shape, keep: any, cutList = base.length ? base : [{ id: "", shape: own0.shape, mat: modelMat }];
      if (r.exclude?.length && placedShapes.length) {
        const out = (id: string) => r.exclude!.some(x => id === x || id.startsWith(`${x}/`));
        const b = new oc.BRep_Builder(), a = new oc.TopoDS_Compound(), k = new oc.TopoDS_Compound();
        b.MakeCompound(a); b.MakeCompound(k);
        let na = 0, nk = 0;
        for (const pc of base) { if (out(pc.id)) { b.Add(k, pc.shape); nk++; } else { b.Add(a, pc.shape); na++; } }
        if (nk) {
          if (!na) { post({ id: r.id, ok: true, proj: { ...project(oc, k, r.view), cut: [] } }); return; }
          cutShape = a; keep = k; cutList = base.filter(pc => !out(pc.id));
        }
      }
      if (r.align) {
        // Aligned section (FR-DRW-012): each component's half beyond the second leg is turned into the first leg's plane,
        // component by component so the hatching still knows whose cut face is whose.
        const b = new oc.BRep_Builder(), c = new oc.TopoDS_Compound();
        b.MakeCompound(c);
        cutList = cutList.map(pc => { const s = alignedShape(oc, pc.shape, r.align!); b.Add(c, s); return { ...pc, shape: s }; });
        cutShape = c;
        if (keep) keep = alignedShape(oc, keep, r.align);
      }
      const proj = section(oc, cutShape, r.view, r.p, 0.02, r.poly, { stair: r.stair, keep, namer: namer(own0.shape, own0.names) });
      const own = solidOwners(cutList);
      proj.cutKey = (proj.cutOf ?? []).map(i => own[i]?.key ?? "");
      proj.cutMat = (proj.cutOf ?? []).map(i => own[i]?.mat ?? modelMat);
      post({ id: r.id, ok: true, proj });
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? `OpenCASCADE error ${err}` : String(err) });
  }
};
