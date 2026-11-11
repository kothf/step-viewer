/// <reference lib="webworker" />
// Drawing worker (FR-DRW-016): holds the drawing's model as an exact B-rep and
// projects views with OCCT's hidden-line removal. Parts are rebuilt from their
// document through the Modeller; STEP / IGES / BREP files are read as they are.
import { FLAT_CONFIG, type Align, type Stair } from "./views";
import { flatBends, flatPatternDoc, flatToXY } from "../sheetmetal/sheet";
import type { Projection, SectionCut } from "../kernel/drawing";
import { geometryDiff, projectAuto, FAST_EDGES, projectPoly, readShape, shapeBin, readBin, childShapes, alignedShape, sectionCut, sectionFinish, sectionPreview, freeSection, shapeBox, shadeTris, shapeInfo, topology, type V3, type ViewDir } from "../kernel/drawing";
import { Assembler } from "../kernel/assembly";
import { Modeller } from "../kernel/model";
import type { AsmDoc } from "../asm/types";
import type { EdgeRef, PartDoc } from "../model/types";
import { modelItems, type CutInfo, type WeldInfo } from "./items";
import { cutList, type WeldHost } from "../weldments/kernel";
import { cutKey, splitSubs } from "../weldments/types";
import { bodiesDensity, findMaterial } from "../tools/materials";
import { activate } from "../model/configs";

export type DrawingRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module; fast?: number }
  /** `lite`: a helper worker that only projects; no topology, model items or tables. */
  | { id: number; type: "load"; part?: PartDoc; asm?: AsmDoc; file?: { name: string; bytes: Uint8Array }; lite?: boolean; snap?: ModelSnap }
  | { id: number; type: "project"; view: ViewDir; shade?: boolean; cfg?: string; only?: string[] }
  /** A quick polygonal preview of a view (FR-DRW-016) while the exact one is computed. */
  | { id: number; type: "preview"; view: ViewDir; cfg?: string; only?: string[] }
  | { id: number; type: "section"; view: ViewDir; p: V3; poly?: number[]; stair?: Stair; align?: Align; exclude?: string[]; cfg?: string; only?: string[] }
  /** A section's quick preview: its cut, projected polygonally; the cut is kept for the exact request that follows. */
  | { id: number; type: "secpreview"; view: ViewDir; p: V3; poly?: number[]; stair?: Stair; align?: Align; exclude?: string[]; cfg?: string; only?: string[] }
  /** Another configuration of the loaded part (FR-DRW-010): built once, its facts returned like a load's. */
  | { id: number; type: "config"; name: string }
  | { id: number; type: "alt"; view: ViewDir; moves: { comp: string; tf: number[] }[] }
  /** Two versions of a part or an assembly compared by booleans (FR-PDM-050); the loaded model stays. */
  | { id: number; type: "diff"; a: DiffSrc; b: DiffSrc };

/**
 * The loaded model's shape in binary BREP with what a lite load needs besides it (names, materials, component ids),
 * sent back by a full load so a restart or the helper reads it (~0.3 s) instead of building the model again
 * (an engine assembly: ~12 s). After the first fast view a big model's snapshot is sent again with its mesh
 * (`mesh`), so a restart need not mesh it again either (~6 s).
 */
export interface ModelSnap { bin: Uint8Array; mesh?: boolean; names?: string[]; mat: string | null; mats: (string | null)[] | null; placed?: { id: string; part?: string; name?: string; mat: string | null; mats?: (string | null)[] | null }[] }

/** Snapshots past this many bytes are not made (they would cost more memory than the time saved). */
const SNAP_MAX = 128 * 1048576;
/** Whether the loaded shape's meshed snapshot has been sent (or the shape came from one). */
let snapMeshed = false;

function writeSnap(mesh = false): ModelSnap | undefined {
  try {
    const bin = shapeBin(oc, shape, mesh);
    if (bin.length > SNAP_MAX) return undefined;
    return { bin, mesh, names: shapeNames, mat: modelMat, mats: modelMats, placed: placedShapes.length ? placedShapes.map(p => ({ id: p.id, mat: p.mat, mats: p.mats })) : undefined };
  } catch { return undefined; }
}

function readSnap(snap: ModelSnap) {
  const s = readBin(oc, snap.bin);
  if (snap.placed) {
    const kids = childShapes(oc, s);
    if (kids.length !== snap.placed.length) throw new Error("The model snapshot does not match its components");
    placedShapes = snap.placed.map((p, i) => ({ ...p, shape: kids[i] }));
  }
  shape = s; shapeNames = snap.names; modelMat = snap.mat; modelMats = snap.mats;
  snapMeshed = !!snap.mesh;
}

/** Reads an assembly snapshot made by the kernel worker; false (nothing kept) when it does not fit the assembly. */
function fromAsm(snap: ModelSnap, asm: AsmDoc): boolean {
  const ok = !!snap.placed?.length && snap.placed.every(p => p.part && p.name !== undefined && asm.components.some(c => c.id === p.id && !c.hidden && c.part === p.part));
  if (!ok) return false;
  try { readSnap(snap); return true; }
  catch { shape = null; placedShapes = []; shapeNames = undefined; modelMat = null; modelMats = null; snapMeshed = false; return false; }
}

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
/** Edge count from which views use the fast hidden-line removal (`?fasthlr` = always). */
let fastEdges = FAST_EDGES;
let shape: any = null;
/** The loaded shape's face names in TopExp order (absent for files: faces are then f<i>, as `topology` names them). */
let shapeNames: string[] | undefined;
/** An assembly's placed component shapes by id, for alternate positions. */
let placedShapes: Owner[] = [];
/** The loaded model's material (a part) for section hatching. */
let modelMat: string | null = null;
/** A shape a section cuts: whose it is, its material and, when its bodies have their own (FR-MAT-001), each solid's in TopExp order. */
type Owner = { id: string; shape: any; mat: string | null; mats?: (string | null)[] | null };
/** Who each solid of a shape belongs to (TopExp order), for hatching each component or body on its own (FR-DRW-012). */
function solidOwners(list: Owner[]): { key: string; mat: string | null }[] {
  const A = oc.TopAbs_ShapeEnum, out: { key: string; mat: string | null }[] = [];
  for (const pc of list) {
    const solids: any[] = [];
    for (const ex = new oc.TopExp_Explorer_2(pc.shape, A.TopAbs_SOLID, A.TopAbs_SHAPE); ex.More(); ex.Next()) solids.push(ex.Current());
    // Body materials only while the solids are still the bodies one to one (an aligned section may split one).
    const mats = pc.mats && pc.mats.length === solids.length ? pc.mats : null;
    solids.forEach((_, k) => out.push({ key: pc.id ? (mats && solids.length > 1 ? `${pc.id}#${k}` : pc.id) : `body${k}`, mat: mats?.[k] ?? pc.mat }));
  }
  return out;
}
/** Each solid's material of a part whose bodies have their own (FR-MAT-001), else null. */
function bodyMats(md: Modeller, body: any, doc: PartDoc): (string | null)[] | null {
  if (!Object.values(doc.bodies ?? {}).some(b => b.material)) return null;
  try { return md.bodyInfo(body, doc).map(b => doc.bodies?.[b.key]?.material?.name ?? doc.material?.name ?? null); }
  catch { return null; }
}
/** The part's mass in kg with each body's own material (title block), or undefined when a body has no density. */
function bodiesKg(md: Modeller, body: any, doc: PartDoc): number | undefined {
  try {
    let kg = 0;
    for (const b of md.bodyInfo(body, doc)) {
      const d = doc.bodies?.[b.key]?.material?.density ?? doc.material?.density;
      if (d == null) return undefined;
      kg += b.volume * d * 1e-6;
    }
    return kg;
  } catch { return undefined; }
}
/** The distinct materials of a part whose bodies have their own, in body order (title block, BOM), else undefined. */
function usedMats(mats: (string | null)[] | null | undefined): string[] | undefined {
  return mats ? [...new Set(mats.filter((m): m is string => !!m))] : undefined;
}
/** The loaded part's document, for its other configurations, and those built so far by name. */
let partDoc: PartDoc | null = null;
const variants = new Map<string, { shape: any; mat: string | null; mats?: (string | null)[] | null; names?: string[] }>();
/** The loaded part's solid materials (see `bodyMats`). */
let modelMats: (string | null)[] | null = null;

/** A part's solid with its topology and model items (dimensions, holes, threads, sketches). */
function buildPart(doc: PartDoc, lite = false): { shape: any; mat: string | null; mats: (string | null)[] | null; names: string[]; extra: Record<string, unknown> } {
  const md = new Modeller(oc), res = md.evaluate(doc);
  if (!res.body) throw new Error("The part has no body yet.");
  const body = res.body, shape = body.shape;
  if (lite) return { shape, mat: doc.material?.name ?? null, mats: bodyMats(md, body, doc), names: body.names, extra: {} };
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
  // Cut list balloons: every face of an item's bodies names its item number.
  let welds: WeldInfo[] = [], cuts: CutInfo[] = [];
  const cutFaces: Record<string, number> = {}, weldFaces: Record<string, number> = {};
  const WELD_TYPES = new Set(["member", "endcap", "gusset", "weldbead"]);
  if (doc.features.some(f => WELD_TYPES.has(f.type) && !f.suppressed)) {
    try {
      const info = md.bodyInfo(body, doc), raw = cutList(md as unknown as WeldHost, info, doc, res.frames), items = splitSubs(raw, doc.subWelds);
      const namesOf = new Map(info.map(b => [b.key, b.part.names]));
      const density = doc.material?.density ?? 7.85;
      let n = 0;
      for (const c of items) {
        const p = doc.cutProps?.[cutKey(c)];
        if (p?.excl) continue;
        const kg = c.volume * (findMaterial(p?.mat)?.density ?? bodiesDensity(c.bodies, doc.bodies, density)) / 1e6;
        ++n;
        for (const k of c.bodies) for (const nm of namesOf.get(k) ?? []) cutFaces[nm] ??= n;
        cuts.push({ item: n, kind: c.kind, desc: p?.desc || c.desc, ...(p?.desc ? { own: true } : {}), qty: c.kind === "bead" ? 1 : c.qty, kg,
          ...(c.length != null ? { length: c.length } : {}), ...(c.kind === "member" ? { a1: c.angle1 ?? 0, a2: c.angle2 ?? 0 } : {}),
          ...(c.plate ? { plate: c.plate } : {}), ...(c.inter ? { inter: c.inter } : {}) });
      }
      const beads = raw.filter(c => c.kind === "bead" && !doc.cutProps?.[cutKey(c)]?.excl);
      // Weld tags: every face of a bead's bodies names its weld table row.
      beads.forEach((c, i) => { for (const k of c.bodies) for (const nm of namesOf.get(k) ?? []) weldFaces[nm] ??= i + 1; });
      welds = beads.map(c => ({ legs: c.desc, length: c.length ?? 0, qty: c.qty, ...(c.inter ? { inter: c.inter } : {}) }));
    } catch { /* no weld or cut list table rows */ }
  }
  const mats = bodyMats(md, body, doc);
  return { shape, mat: doc.material?.name ?? null, mats, names: body.names, extra: { topo: topology(oc, shape, body.names), ...mi, welds, cuts, cutFaces, weldFaces, mats: usedMats(mats), kg: mats ? bodiesKg(md, body, doc) : undefined } };
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

function shapeOf(cfg?: string): { shape: any; mat: string | null; mats?: (string | null)[] | null; names?: string[] } {
  if (!cfg || !partDoc || cfg === partDoc.config) return { shape, mat: modelMat, mats: modelMats, names: shapeNames };
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

/** An OCCT exception (a number in wasm): its message when the build keeps it, else `OpenCASCADE error <n>` (the workspace explains that). */
function occtMessage(err: number): string {
  let m = "";
  try { m = oc?.OCJS?.getStandard_FailureData?.(err)?.GetMessageString?.() ?? ""; } catch { /* no message */ }
  return m ? `OpenCASCADE: ${m}` : `OpenCASCADE error ${err}`;
}

/** Every projection reply carries the heap size, so the client can start a worker over before it runs out. */
/** Section cuts made for previews, kept for their exact requests (the worker answers in order), by request fields. */
const stash = new Map<string, SectionCut>();

/** A preview's mesh chord error: 1/300 of the shape's size (the preview only has to look right). */
function previewLin(sh: any): number {
  const [lo, hi] = shapeBox(oc, sh);
  return Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 300);
}

const post = (msg: Record<string, unknown>) => (self as DedicatedWorkerGlobalScope).postMessage(msg.proj ? { ...msg, heap: oc?.HEAP8?.length } : msg);

self.onmessage = async (e: MessageEvent<DrawingRequest>) => {
  const r = e.data;
  try {
    if (r.type === "init") {
      const factory = (await import(/* @vite-ignore */ `${r.base}opencascade.full.js?v=${__APP_VERSION__}`)).default;
      oc = await factory({
        print: () => {}, printErr: () => {},
        instantiateWasm: (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance) => void) => { WebAssembly.instantiate(r.module, imports).then(done); return {}; },
      });
      if (r.fast !== undefined) fastEdges = r.fast;
      post({ id: r.id, ok: true });
    } else if (r.type === "load") {
      for (const sc of stash.values()) freeSection(sc);
      stash.clear();
      placedShapes = [];
      snapMeshed = false;
      modelMat = null;
      modelMats = null;
      shapeNames = undefined;
      if (!oc) throw new Error("Kernel not started");
      let extra = {};
      partDoc = null;
      variants.clear();
      if (r.lite && r.snap) {
        // A restart or the helper: the shape from the full load's snapshot, no rebuild.
        readSnap(r.snap);
        partDoc = r.part ?? null;
        post({ id: r.id, ok: true });
        return;
      }
      if (r.part) {
        const b = buildPart(r.part, r.lite);
        shape = b.shape; modelMat = b.mat; modelMats = b.mats; extra = b.extra; shapeNames = b.names;
        partDoc = r.part;
      } else if (r.asm && r.snap && fromAsm(r.snap, r.asm)) {
        // The open assembly's own build (kernel worker `asmSnap`): the same compound without building the parts again.
        const comps = r.snap.placed!.map((p, i) => ({ id: p.id, part: p.part!, name: p.name!, mats: usedMats(placedShapes[i].mats) }));
        post({ id: r.id, ok: true, ...shapeInfo(oc, shape), topo: topology(oc, shape, shapeNames), items: [], holes: [], comps, snap: r.snap, pre: true });
        return;
      } else if (r.asm) {
        // An assembly (FR-DRW-030): the shown components placed into one compound; face names get
        // the component id in front (`<comp>@<face>`) so an edge says which component it is on.
        const asm = new Assembler(oc), { placed } = asm.evaluate({ ...r.asm, components: r.asm.components.filter(c => !c.hidden) });
        if (!placed.length) throw new Error("The assembly has no components to draw.");
        const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
        b.MakeCompound(comp);
        const names: string[] = [], comps: { id: string; part: string; name: string; mats?: string[] }[] = [];
        placedShapes = placed.map(pc => ({ id: pc.id, shape: pc.body.shape, mat: r.asm!.parts[pc.part]?.doc?.material?.name ?? null, mats: asm.bodyMats(pc.part, r.asm!, pc.src) }));
        placed.forEach((pc, i) => { b.Add(comp, pc.body.shape); names.push(...pc.body.names.map(n => `${pc.id}@${n}`)); comps.push({ id: pc.id, part: pc.part, name: pc.name, mats: usedMats(placedShapes[i].mats) }); });
        shape = comp; shapeNames = names;
        extra = r.lite ? {} : { topo: topology(oc, shape, names), items: [], holes: [], comps };
      } else if (r.file) { shape = readShape(oc, r.file.bytes, r.file.name); extra = r.lite ? {} : { topo: topology(oc, shape), items: [], holes: [] }; }
      else throw new Error("Nothing to load");
      if (r.lite) { post({ id: r.id, ok: true }); return; }
      post({ id: r.id, ok: true, ...shapeInfo(oc, shape), ...extra, snap: writeSnap() });
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
      variants.set(r.name, { shape: b.shape, mat: b.mat, mats: b.mats, names: b.names });
      post({ id: r.id, ok: true, ...shapeInfo(oc, b.shape), ...b.extra });
    } else if (r.type === "project") {
      if (!shape) throw new Error("No model loaded");
      const sh = r.only?.length && placedShapes.length ? onlyOf(r.only).shape : shapeOf(r.cfg).shape;
      const proj = projectAuto(oc, sh, r.view, 0.02, fastEdges);
      if (r.shade) {
        // Mesh chord error: 1/400 of the model's size, so the shading stays light even for big models.
        const [lo, hi] = shapeBox(oc, sh);
        proj.shade = shadeTris(oc, sh, r.view, Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 400));
      }
      // The first fast view of the whole model meshed it: send the snapshot again with that mesh (see `ModelSnap`).
      const snap = proj.fast && sh === shape && !snapMeshed ? (snapMeshed = true, writeSnap(true)) : undefined;
      post({ id: r.id, ok: true, proj, ...(snap ? { snap } : {}) });
    } else if (r.type === "preview") {
      if (!shape) throw new Error("No model loaded");
      const sh = r.only?.length && placedShapes.length ? onlyOf(r.only).shape : shapeOf(r.cfg).shape;
      post({ id: r.id, ok: true, proj: projectPoly(oc, sh, r.view, previewLin(sh)) });
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
      post({ id: r.id, ok: true, proj: n ? projectAuto(oc, comp, r.view, 0.02, fastEdges) : { vis: [], hid: [], box: [0, 0, 0, 0], ms: 0 } });
    } else if (r.type === "section" || r.type === "secpreview") {
      if (!shape) throw new Error("No model loaded");
      // A preview's cut is kept for the exact request of the same section, which comes next (FR-DRW-016).
      const skey = JSON.stringify([r.view, r.p, r.poly, r.stair, r.align, r.exclude, r.cfg, r.only]);
      const stashed = stash.get(skey) ?? null;
      stash.delete(skey);
      const own0 = shapeOf(r.cfg), modelMat = own0.mat;
      // Components left whole (FR-DRW-012) are drawn but not cut; a top-level id takes its sub-components along.
      const only = r.only?.length && placedShapes.length ? onlyOf(r.only) : null, base = only ? only.list : placedShapes;
      let cutShape = only ? only.shape : own0.shape, keep: any, cutList: Owner[] = base.length ? base : [{ id: "", shape: own0.shape, mat: modelMat, mats: own0.mats }];
      if (r.exclude?.length && placedShapes.length) {
        const out = (id: string) => r.exclude!.some(x => id === x || id.startsWith(`${x}/`));
        const b = new oc.BRep_Builder(), a = new oc.TopoDS_Compound(), k = new oc.TopoDS_Compound();
        b.MakeCompound(a); b.MakeCompound(k);
        let na = 0, nk = 0;
        for (const pc of base) { if (out(pc.id)) { b.Add(k, pc.shape); nk++; } else { b.Add(a, pc.shape); na++; } }
        if (nk) {
          if (!na) { post({ id: r.id, ok: true, proj: { ...(r.type === "secpreview" ? projectPoly(oc, k, r.view, previewLin(k)) : projectAuto(oc, k, r.view, 0.02, fastEdges)), cut: [] } }); return; }
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
      const sc = stashed ?? sectionCut(oc, cutShape, r.view, r.p, r.poly, { stair: r.stair, keep });
      let proj: Projection;
      if (r.type === "secpreview") {
        stash.set(skey, sc);
        // At most two kept (both sides of a section line being placed): the oldest goes.
        for (const [k, old] of stash) { if (stash.size <= 2) break; freeSection(old); stash.delete(k); }
        proj = sectionPreview(oc, sc, r.view, previewLin(sc.drawn));
      } else {
        proj = sectionFinish(oc, sc, r.view, 0.02, { namer: namer(own0.shape, own0.names), fast: fastEdges });
      }
      const own = solidOwners(cutList);
      proj.cutKey = (proj.cutOf ?? []).map(i => own[i]?.key ?? "");
      proj.cutMat = (proj.cutOf ?? []).map(i => own[i]?.mat ?? modelMat);
      post({ id: r.id, ok: true, proj });
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? occtMessage(err) : String(err) });
  }
};
