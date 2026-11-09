// Sheet metal on OpenCASCADE (FR-FT-120): turns the panels and bends of sheet.ts into solids and
// joins them to the body. Runs in the kernel worker, called from Modeller.evaluate.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Frame, PartDoc, SketchFeature, V2, V3 } from "../model/types";
import type { Named } from "../kernel/model";
import { inPolygon, loopPolygon, polyArea, type Seg } from "../sketch/profile";
import { apply, applyDir, bendStrip, sheetPlace, unfoldSheet, type SheetPlace, baseFlange, crossBreak, formTools, obroundLoop, type FormItem, ventLayout, ventPanel, loftedBend, type SheetMesh, breakCorner, closedCorner, miterFlange, miterProfile, sweptProfile, type FlatEdge, bendSketchLine, edgeFlange, flatLoops, hem, jog, sketchedBend, tab, SheetError, type Bend, type Mat, type Panel, type SheetOp, type SheetState } from "./sheet";
import type { SheetFeature, SmFormFeature, SmVentFeature } from "./types";

/** The few Modeller helpers the sheet metal code needs. */
export interface SheetApi {
  oc: any;
  bool(kind: "fuse" | "cut" | "common", a: Named, b: Named, fid: string): Named;
  segEdge(s: Seg, frame: Frame): any;
  sub(shape: any, kind: "FACE" | "EDGE"): any[];
  centroid(face: any): V3;
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const frameOf = (M: Mat, z = 0): Frame => ({ o: apply(M, [0, 0, z]), x: M.x, y: M.y, n: M.z });

/** Evaluates one sheet metal feature: the new body and sheet state. */
export function evalSheet(api: SheetApi, f: SheetFeature, doc: PartDoc, body: Named | null, sm: SheetState | null, frameOfSketch: (sk: SketchFeature) => Frame): { body: Named | null; sm: SheetState | null } {
  if (f.type === "smbase") {
    if (sm) throw new SheetError("E-SM-BASE2", "This part already has a base flange.");
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a sketch for the base flange.");
    const { state, ops } = baseFlange(f, sk, frameOfSketch(sk));
    return { body: applyOps(api, body, ops, state.T, f.id), sm: state };
  }
  if (f.type === "smloft") {
    if (sm) throw new SheetError("E-SM-BASE2", "This part already has a base flange.");
    const sk = (id: string) => doc.features.find((x): x is SketchFeature => x.id === id && x.type === "sketch");
    const s1 = sk(f.sketch1), s2 = sk(f.sketch2);
    if (!s1 || !s2) throw new SheetError("E-SM-SKETCH", "Pick two sketches with open profiles for the lofted bend.");
    const { state, ops } = loftedBend(f, s1, frameOfSketch(s1), s2, frameOfSketch(s2));
    return { body: applyOps(api, body, ops, state.T, f.id), sm: state };
  }
  if (!sm) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
  if (f.type === "smunfold" || f.type === "smfold") {
    if (!body) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
    const { state, from, to } = unfoldSheet(sm, f);
    return { body: reposition(api, state.T, sm, body, from, to, f.id), sm: state };
  }
  if (sm.unfold && f.type !== "smflat") throw new SheetError("E-SM-UNFOLDED", "Fold the bends back before adding sheet metal features.");
  if (f.type === "smflat") {
    // An unfolded sheet is folded back first, so the pattern picks up cuts made while it was flat.
    if (sm.unfold && body) {
      const home = { ...sm, unfold: undefined };
      body = reposition(api, sm.T, sm, body, sheetPlace(sm), sheetPlace(home), f.id);
      sm = home;
    }
    const flat = flatBody(api, sm, f.id, body);
    return { body: flat.body, sm: flat.edges ? { ...sm, flatEdges: flat.edges } : sm };
  }
  if (f.type === "smvent") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a sketch with the vent boundary.");
    if (!body) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
    return { body: ventCut(api, body, f, sm, sk, frameOfSketch(sk)), sm };
  }
  if (f.type === "smform") {
    if (!body) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
    const { items, state } = formTools(sm, f);
    return { body: formBody(api, body, f, sm.T, items), sm: state };
  }
  let res: { state: SheetState; ops: SheetOp[] };
  if (f.type === "smtab") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a closed sketch for the tab.");
    res = tab(sm, f, sk, frameOfSketch(sk));
  } else if (f.type === "smbend" || f.type === "smjog") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a sketch with the bend line.");
    const ln = bendSketchLine(sk, frameOfSketch(sk));
    res = f.type === "smbend" ? sketchedBend(sm, f, ln) : jog(sm, f, ln);
  } else if (f.type === "smmiter" || f.type === "smswept") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", f.type === "smswept" ? "Pick a sketch with the swept flange profile." : "Pick a sketch with the miter flange profile.");
    if (f.type === "smswept") { const sp = sweptProfile(sk, frameOfSketch(sk)); res = miterFlange(sm, f, sp.pts, sp.radii); }
    else res = miterFlange(sm, f, miterProfile(sk, frameOfSketch(sk)));
  } else if (f.type === "smcross") {
    const { state } = crossBreak(sm, f);
    return { body, sm: state };
  } else res = f.type === "smflange" ? edgeFlange(sm, f) : f.type === "smcorner" ? breakCorner(sm, f) : f.type === "smclosed" ? closedCorner(sm, f) : f.type === "smhem" ? hem(sm, f) : (() => { throw new SheetError("E-SM-TYPE", "Unknown sheet metal feature."); })();
  const { state, ops } = res;
  if (!body) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
  return { body: applyOps(api, body, ops, state.T, f.id), sm: state };
}

/** Cuts first, then joins the new panels and bends. */
function applyOps(api: SheetApi, body: Named | null, ops: SheetOp[], T: number, fid: string): Named {
  let out = body;
  ops.forEach((op, i) => {
    if (op.kind !== "cut") return;
    if (!out) return;
    out = api.bool("cut", out, op.segs ? segCutTool(api, op.M, op.segs, T, `${fid}:t${i}`) : cutTool(api, op.M, op.loop, T, `${fid}:t${i}`), fid);
  });
  for (const op of ops) {
    if (op.kind === "cut") continue;
    const piece = op.kind === "panel" ? panelSolid(api, op.panel, T) : op.kind === "mesh" ? meshSolid(api, op.mesh) : bendSolid(api, op.bend, T);
    out = out ? api.bool("fuse", out, piece, fid) : piece;
  }
  if (!out) throw new SheetError("E-SM-EMPTY", "The sheet metal feature made nothing.");
  return out;
}

function wireOf(api: SheetApi, loop: Seg[], fr: Frame): any {
  const mk = new api.oc.BRepBuilderAPI_MakeWire_1();
  for (const s of loop) mk.Add_1(api.segEdge(s, fr));
  if (!mk.IsDone()) throw new SheetError("E-SM-WIRE", "A sheet metal outline could not be closed.");
  return mk.Wire();
}

/** A planar face from a counter-clockwise outer loop and clockwise holes, in the frame. */
function faceOf(api: SheetApi, outer: Seg[], holes: Seg[][], fr: Frame): any {
  const oc = api.oc;
  const mk = new oc.BRepBuilderAPI_MakeFace_15(wireOf(api, outer, fr), true);
  for (const h of holes) mk.Add(wireOf(api, h, fr));
  if (!mk.IsDone()) throw new SheetError("E-SM-FACE", "A sheet metal face could not be made.");
  const fix = new oc.ShapeFix_Face_2(mk.Face());
  fix.Perform();
  return fix.Face();
}

const prism = (api: SheetApi, face: any, d: V3) => new api.oc.BRepPrimAPI_MakePrism_1(face, new api.oc.gp_Vec_4(d[0], d[1], d[2]), false, true).Shape();

/** Distance from a flat point to an outline piece. */
function segDist(s: Seg, p: V2): number {
  if (s.kind === "line") {
    const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], l2 = ux * ux + uy * uy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * ux + (p[1] - s.a[1]) * uy) / l2));
    return Math.hypot(p[0] - s.a[0] - t * ux, p[1] - s.a[1] - t * uy);
  }
  if (s.kind === "arc" || s.kind === "circle") return Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.r);
  return Infinity;
}

/** A plate's faces named after the outline: top, bottom and one side face per outline piece. */
function nameSides(api: SheetApi, shape: any, M: Mat, T: number, loops: Seg[], prefix: string): Named {
  const faces = api.sub(shape, "FACE");
  const names = faces.map(fc => {
    const c = sub3(api.centroid(fc), M.o);
    const z = dot(c, M.z);
    if (Math.abs(z) < T * 1e-3) return `${prefix}:bot`;
    if (Math.abs(z - T) < T * 1e-3) return `${prefix}:top`;
    const p: V2 = [dot(c, M.x), dot(c, M.y)];
    let best = loops[0], bd = Infinity;
    for (const s of loops) { const d = segDist(s, p); if (d < bd) { bd = d; best = s; } }
    return `${prefix}:${best.ent}`;
  });
  return { shape, faces, names };
}

function panelSolid(api: SheetApi, p: Panel, T: number): Named {
  const shape = prism(api, faceOf(api, p.outer, p.holes, frameOf(p.M)), applyDir(p.M, [0, 0, T]));
  return nameSides(api, shape, p.M, T, [p.outer, ...p.holes].flat(), p.id);
}

/** A bend: the panel's cross-section on its start line turned about the bend axis. */
function bendSolid(api: SheetApi, b: Bend, T: number): Named {
  const oc = api.oc;
  const l = Math.hypot(b.a1[0] - b.a0[0], b.a1[1] - b.a0[1]);
  const e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l];
  const w = (p: V2, z: number) => apply(b.M, [p[0], p[1], z]);
  const corners = [w(b.a0, 0), w(b.a1, 0), w(b.a1, T), w(b.a0, T)];
  const P = (q: V3) => new oc.gp_Pnt_3(q[0], q[1], q[2]);
  const mk = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < 4; i++) mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(P(corners[i]), P(corners[(i + 1) % 4])).Edge());
  const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
  const c = w(b.a0, b.up ? T + b.r : -b.r);
  const u = applyDir(b.M, b.up ? [-e[0], -e[1], 0] : [e[0], e[1], 0]);
  const shape = new oc.BRepPrimAPI_MakeRevol_1(face, new oc.gp_Ax1_2(P(c), new oc.gp_Dir_4(u[0], u[1], u[2])), b.angle, false).Shape();
  const faces = api.sub(shape, "FACE");
  const ew = applyDir(b.M, [e[0], e[1], 0]);
  const start = w([(b.a0[0] + b.a1[0]) / 2, (b.a0[1] + b.a1[1]) / 2], T / 2);
  const names = faces.map(fc => {
    const ad = new oc.BRepAdaptor_Surface_2(fc, true);
    const ty = ad.GetType();
    if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return `${b.id}:${Math.abs(ad.Cylinder().Radius() - b.r) < Math.abs(ad.Cylinder().Radius() - b.r - T) ? "in" : "out"}`;
    const cen = api.centroid(fc);
    const along = dot(sub3(cen, corners[0]), ew);
    if (along < l * 1e-3) return `${b.id}:s0`;
    if (along > l * (1 - 1e-3)) return `${b.id}:s1`;
    return `${b.id}:${Math.hypot(...sub3(cen, start)) < T * 1e-2 ? "start" : "end"}`;
  });
  return { shape, faces, names };
}

/**
 * A lofted bend's solid: a triangle on the bottom and on the top for each facet, and the boundary sides (split in two
 * when they twist), sewn into one closed shell. Faces lying in one plane are merged; names go by the nearest piece.
 */
function meshSolid(api: SheetApi, m: SheetMesh): Named {
  const oc = api.oc;
  const P = (q: V3) => new oc.gp_Pnt_3(q[0], q[1], q[2]);
  const pieces: { face: any; name: string; c: V3; n: V3 }[] = [];
  const poly = (pts: V3[], name: string) => {
    const mk = new oc.BRepBuilderAPI_MakePolygon_1();
    for (const p of pts) mk.Add_1(P(p));
    mk.Close();
    const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
    pieces.push({ face, name, c: pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0] as V3), n: unit3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[0]))) });
  };
  for (const t of m.tris) {
    poly([m.bot[t.v[0]], m.bot[t.v[2]], m.bot[t.v[1]]], `${t.pid}:bot`);
    poly(t.v.map(i => m.top[i]), `${t.pid}:top`);
  }
  const size = Math.max(1, ...m.top.flatMap(p => p.map(Math.abs)));
  for (const s of m.sides) {
    const q = [m.bot[s.b], m.bot[s.a], m.top[s.a], m.top[s.b]];
    const n = unit3(cross3(sub3(q[1], q[0]), sub3(q[2], q[0])));
    const name = `${s.pid}:${s.ent}`;
    if (Math.abs(dot(sub3(q[3], q[0]), n)) < size * 1e-9) poly(q, name);
    else { poly([q[0], q[1], q[2]], name); poly([q[0], q[2], q[3]], name); }
  }
  const tol = Math.max(1e-7, size * 1e-8);
  const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  for (const p of pieces) sew.Add(p.face);
  sew.Perform(new oc.Message_ProgressRange_1());
  const sewn = sew.SewedShape();
  const shells: any[] = [];
  for (const ex = new oc.TopExp_Explorer_2(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) shells.push(oc.TopoDS.Shell_1(ex.Current()));
  if (shells.length !== 1 || !oc.BRep_Tool.IsClosed_1(shells[0])) throw new SheetError("E-SM-LOFTSOLID", "The lofted bend could not be closed into a solid; check that the profiles don't cross.");
  let solid = new oc.ShapeFix_Solid_1().SolidFromShell(shells[0]);
  if (volumeOf(api, solid) < 0) solid = solid.Reversed();
  let shape = solid;
  const un = new oc.ShapeUpgrade_UnifySameDomain_2(solid, true, true, false);
  try { un.Build(); shape = un.Shape(); } catch { /* keep the facets */ }
  const faces = api.sub(shape, "FACE");
  // A merged face's centroid lies in the plane of the pieces it was made of.
  const names = faces.map(fc => {
    const c = api.centroid(fc);
    let best = pieces[0].name, bd = Infinity;
    for (const p of pieces) {
      const dd = Math.hypot(...sub3(p.c, c)) + (Math.abs(dot(sub3(c, p.c), p.n)) < size * 1e-7 ? 0 : 1e9);
      if (dd < bd) { bd = dd; best = p.name; }
    }
    return best;
  });
  return { shape, faces, names };
}
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A cut prism across the sheet: a flat polygon in the panel frame, a little beyond both faces. */
function cutTool(api: SheetApi, M: Mat, loop: V2[], T: number, fid: string): Named {
  const pts = polyArea(loop) >= 0 ? loop : [...loop].reverse();
  const segs: Seg[] = pts.map((a, i) => ({ ent: `c${i}`, kind: "line", a, b: pts[(i + 1) % pts.length] }));
  const shape = prism(api, faceOf(api, segs, [], frameOf(M, -T * 0.01)), applyDir(M, [0, 0, T * 1.02]));
  const faces = api.sub(shape, "FACE");
  return { shape, faces, names: faces.map((_f, i) => `${fid}:${i}`) };
}

/** A cut prism across the sheet from a closed outline; a side face whose piece's `ent` holds ":" takes that name. */
function segCutTool(api: SheetApi, M: Mat, segs: Seg[], T: number, fid: string): Named {
  const ccw = polyArea(loopPolygon(segs)) >= 0 ? segs : [...segs].reverse().map(s => s.kind === "line" ? { ...s, a: s.b, b: s.a } : s.kind === "arc" ? { ...s, a: s.b, b: s.a, ccw: !s.ccw } : s);
  const shape = prism(api, faceOf(api, ccw, [], frameOf(M, -T * 0.01)), applyDir(M, [0, 0, T * 1.02]));
  const n = nameSides(api, shape, frameOf2(M, -T * 0.01), T * 1.02, ccw, fid);
  return { ...n, names: n.names.map((x, i) => { const e = x.slice(fid.length + 1); return e.includes(":") ? e : `${fid}:${i}`; }) };
}
const frameOf2 = (M: Mat, z: number): Mat => ({ ...M, o: apply(M, [0, 0, z]) });

/** The flat pattern as a solid on the plane of the first face. Material that later features took out
 * of a flat panel (holes, cuts) is moved onto the pattern with the panel and cut from it too; then
 * `edges` is the pattern's top outline for the DXF. Cuts through a bend aren't unrolled. */
export function flatBody(api: SheetApi, st: SheetState, fid: string, folded: Named | null = null): { body: Named; edges?: FlatEdge[] } {
  const { outer, holes } = flatLoops(st);
  if (!outer.length) throw new SheetError("E-SM-FLAT", "The flat pattern could not be made.");
  const parts: Named[] = outer.map(o => {
    const poly = loopPolygon(o);
    const inner = holes.filter(h => inPolygon(loopPolygon(h)[0], poly));
    const shape = prism(api, faceOf(api, o, inner, frameOf(st.root)), applyDir(st.root, [0, 0, st.T]));
    return nameSides(api, shape, st.root, st.T, [o, ...inner].flat().map((s, i) => ({ ...s, ent: `e${i}` })), fid);
  });
  let out = parts[0];
  for (const p of parts.slice(1)) out = api.bool("fuse", out, p, fid);
  // A faceted (lofted) sheet isn't made of the panels' prisms, so what was cut out can't be told by volume.
  // Forms are left out of the flat pattern: what they took out of a panel isn't cut from it.
  const keep = new Map<string, Named[]>();
  for (const m of st.forms ?? []) {
    const p = st.panels.find(x => x.id === m.pid);
    if (p) keep.set(p.id, [...(keep.get(p.id) ?? []), footprint(api, p.M, m.loop, st.T, `${fid}:fp`)]);
  }
  const removed = folded && !st.faceted ? removedPieces(api, st, folded, fid, keep) : [];
  // An extruded hole's pre-pierce hole.
  for (const m of st.forms ?? []) if (m.pierce) removed.push(footprint(api, st.root, [{ ent: "f", kind: "circle", c: m.c, r: m.pierce }], st.T, `${fid}:pp`));
  if (!removed.length) return { body: out };
  for (const r of removed) out = api.bool("cut", out, r, fid);
  return { body: out, edges: topEdges(api, out, st.root, st.T) };
}

function volumeOf(api: SheetApi, shape: any): number {
  const p = new api.oc.GProp_GProps_1();
  api.oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
  return p.Mass();
}

/** What later features took out of each flat panel, moved from the folded panel onto the flat pattern. */
function removedPieces(api: SheetApi, st: SheetState, folded: Named, fid: string, keep = new Map<string, Named[]>()): Named[] {
  const panels = st.panels.map(p => ({ p, solid: panelSolid(api, p, st.T) }));
  const sheet = panels.reduce((a, x) => a + volumeOf(api, x.solid.shape), 0) + st.bends.reduce((a, b) => a + volumeOf(api, bendSolid(api, b, st.T).shape), 0);
  const body = volumeOf(api, folded.shape);
  // Nothing taken out: the folded body is exactly the panels and bends.
  if (Math.abs(body - sheet) <= sheet * 1e-7) return [];
  const out: Named[] = [];
  for (const { p, solid } of panels) {
    const v = volumeOf(api, solid.shape);
    let gone = api.bool("cut", solid, folded, `${fid}:cut`);
    for (const k of keep.get(p.id) ?? []) gone = api.bool("cut", gone, k, `${fid}:cut`);
    if (volumeOf(api, gone.shape) <= v * 1e-6) continue;
    out.push(moved(api, gone, flatTrsf(api, p.M, st.root)));
  }
  // Bends: what was taken out of each, unrolled from its neutral surface onto the flat strip.
  for (const b of st.bends) {
    const solid = bendSolid(api, b, st.T);
    const v = volumeOf(api, solid.shape);
    const gone = api.bool("cut", solid, folded, `${fid}:cut`);
    if (volumeOf(api, gone.shape) <= v * 1e-6) continue;
    out.push(...unrolled(api, st, b, gone, fid));
  }
  return out;
}

/**
 * Cut prisms on the flat pattern for what was taken out of a bend: the removed piece is cut with the bend's
 * neutral surface (radius ba / angle, so arc lengths there are flat lengths) and each piece of that surface
 * is mapped onto the bend's flat strip (along the bend line, and turned angle × radius across it).
 */
function unrolled(api: SheetApi, st: SheetState, b: Bend, gone: Named, fid: string): Named[] {
  const oc = api.oc, T = st.T;
  const l = Math.hypot(b.a1[0] - b.a0[0], b.a1[1] - b.a0[1]);
  const e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l], o: V2 = [e[1], -e[0]];
  const rho = Math.min(Math.max(b.ba / b.angle, b.r), b.r + T);
  const zc = b.up ? T + b.r : -b.r, zn = b.up ? zc - rho : zc + rho;
  const P = (q: V3) => new oc.gp_Pnt_3(q[0], q[1], q[2]);
  const w = (p: V2, z: number) => apply(b.M, [p[0], p[1], z]);
  const ua = applyDir(b.M, b.up ? [-e[0], -e[1], 0] : [e[0], e[1], 0]);
  // A little wider than the bend so cuts reaching its ends are whole.
  const pad = l * 0.01 + T;
  const n0: V2 = [b.a0[0] - e[0] * pad, b.a0[1] - e[1] * pad], n1: V2 = [b.a1[0] + e[0] * pad, b.a1[1] + e[1] * pad];
  const edge = new oc.BRepBuilderAPI_MakeEdge_3(P(w(n0, zn)), P(w(n1, zn))).Edge();
  const c = w(b.a0, zc);
  const surf = new oc.BRepPrimAPI_MakeRevol_1(edge, new oc.gp_Ax1_2(P(c), new oc.gp_Dir_4(ua[0], ua[1], ua[2])), b.angle, false).Shape();
  const common = new oc.BRepAlgoAPI_Common_3(surf, gone.shape, new oc.Message_ProgressRange_1());
  if (!common.IsDone()) return [];
  // World point on the neutral surface → flat pattern point.
  const s3 = applyDir(b.M, [0, 0, b.up ? -1 : 1]), e3 = applyDir(b.M, [e[0], e[1], 0]);
  const A0 = w(b.a0, 0);
  const flat = (x: V3): V2 => {
    const t = dot(sub3(x, A0), e3);
    const v = sub3(x, c), along = dot(v, e3);
    const vp: V3 = [v[0] - e3[0] * along, v[1] - e3[1] * along, v[2] - e3[2] * along];
    const cr: V3 = [s3[1] * vp[2] - s3[2] * vp[1], s3[2] * vp[0] - s3[0] * vp[2], s3[0] * vp[1] - s3[1] * vp[0]];
    const phi = Math.atan2(dot(ua, cr), dot(s3, vp));
    return [b.a0[0] + t * e[0] + phi * rho * o[0], b.a0[1] + t * e[1] + phi * rho * o[1]];
  };
  const loopOf = (wire: any): Seg[] => {
    const pts: V2[] = [];
    const ex = new oc.BRepTools_WireExplorer_2(wire);
    for (; ex.More(); ex.Next()) {
      const ed = ex.Current();
      const cu = new oc.BRepAdaptor_Curve_2(ed);
      const u0 = cu.FirstParameter(), u1 = cu.LastParameter();
      const n = cu.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : 24;
      const seq: V2[] = [];
      for (let i = 0; i <= n; i++) { const q = cu.Value(u0 + (u1 - u0) * i / n); seq.push(flat([q.X(), q.Y(), q.Z()])); }
      if (ed.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) seq.reverse();
      for (const q of seq) if (!pts.length || Math.hypot(q[0] - pts.at(-1)![0], q[1] - pts.at(-1)![1]) > 1e-7) pts.push(q);
    }
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1e-7) pts.pop();
    if (pts.length < 3 || Math.abs(polyArea(pts)) < 1e-9) return [];
    const ccw = polyArea(pts) >= 0 ? pts : [...pts].reverse();
    return ccw.map((a, i) => ({ ent: `u${i}`, kind: "line", a, b: ccw[(i + 1) % ccw.length] }) as Seg);
  };
  const out: Named[] = [];
  for (const fc of api.sub(common.Shape(), "FACE")) {
    const outer = loopOf(oc.BRepTools.OuterWire(fc));
    if (!outer.length) continue;
    try {
      const shape = prism(api, faceOf(api, outer, [], frameOf(st.root, -T * 0.01)), applyDir(st.root, [0, 0, T * 1.02]));
      const faces = api.sub(shape, "FACE");
      out.push({ shape, faces, names: faces.map((_f, i) => `${fid}:u${i}`) });
    } catch { /* a sliver that makes no face */ }
  }
  return out;
}

/** The rigid move from a panel's folded place onto the flat pattern: root ∘ M⁻¹. */
function flatTrsf(api: SheetApi, M: Mat, R: Mat): any {
  const A = [0, 1, 2].map(r => [0, 1, 2].map(c => R.x[r] * M.x[c] + R.y[r] * M.y[c] + R.z[r] * M.z[c]));
  const t = [0, 1, 2].map(r => R.o[r] - (A[r][0] * M.o[0] + A[r][1] * M.o[1] + A[r][2] * M.o[2]));
  const tr = new api.oc.gp_Trsf_1();
  tr.SetValues(A[0][0], A[0][1], A[0][2], t[0], A[1][0], A[1][1], A[1][2], t[1], A[2][0], A[2][1], A[2][2], t[2]);
  return tr;
}

function moved(api: SheetApi, n: Named, tr: any): Named {
  const mk = new api.oc.BRepBuilderAPI_Transform_2(n.shape, tr, true);
  const shape = mk.Shape();
  const faces = api.sub(shape, "FACE");
  return { shape, faces, names: faces.map((_f, i) => n.names[i] ?? `cut:${i}`) };
}

/** The flat pattern's outline on its top face, in flat coordinates: lines, circles and arcs exact, other curves as polylines. */
function topEdges(api: SheetApi, flat: Named, R: Mat, T: number): FlatEdge[] {
  const oc = api.oc;
  const to2 = (p: any): V2 => { const d = sub3([p.X(), p.Y(), p.Z()], R.o); return [dot(d, R.x), dot(d, R.y)]; };
  const out: FlatEdge[] = [];
  for (const fc of api.sub(flat.shape, "FACE")) {
    if (Math.abs(dot(sub3(api.centroid(fc), R.o), R.z) - T) > T * 1e-3) continue;
    for (const ed of api.sub(fc, "EDGE")) {
      const c = new oc.BRepAdaptor_Curve_2(ed);
      const u0 = c.FirstParameter(), u1 = c.LastParameter();
      const ty = c.GetType();
      const a = to2(c.Value(u0)), b = to2(c.Value(u1)), m = to2(c.Value((u0 + u1) / 2));
      if (ty === oc.GeomAbs_CurveType.GeomAbs_Line) out.push({ kind: "line", a, b });
      else if (ty === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const ci = c.Circle(), r = ci.Radius(), cc = to2(ci.Location());
        if (Math.abs(u1 - u0) > 2 * Math.PI - 1e-6) out.push({ kind: "circle", c: cc, r });
        else {
          const ccw = (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) > 0;
          const [p, q] = ccw ? [a, b] : [b, a];
          out.push({ kind: "arc", c: cc, r, a0: Math.atan2(p[1] - cc[1], p[0] - cc[0]), a1: Math.atan2(q[1] - cc[1], q[0] - cc[0]) });
        }
      } else {
        const pts: V2[] = [];
        for (let i = 0; i <= 32; i++) pts.push(to2(c.Value(u0 + (u1 - u0) * i / 32)));
        out.push({ kind: "poly", pts });
      }
    }
  }
  return out;
}

/**
 * Vent (FR-FT-120): the boundary's prism through the sheet, less a strip of rib width along each rib and a ring of
 * spar width on each spar, is cut from the body. The flat pattern picks the openings up like any other cut.
 */
function ventCut(api: SheetApi, body: Named, f: SmVentFeature, st: SheetState, sk: SketchFeature, fr: Frame): Named {
  const rib = f.rib.v, spar = f.spar.v;
  if (!(rib > 0) || !(spar > 0)) throw new SheetError("E-SM-VENTW", "Rib and spar widths must be more than 0.");
  const lay = ventLayout(sk);
  const w = (p: V2): V3 => [fr.o[0] + fr.x[0] * p[0] + fr.y[0] * p[1], fr.o[1] + fr.x[1] * p[0] + fr.y[1] * p[1], fr.o[2] + fr.x[2] * p[0] + fr.y[2] * p[1]];
  ventPanel(st, loopPolygon(lay.boundary, 8).map(w));
  // A slab a little thicker than the sheet on both sides of the sketch plane, so either face works.
  const h = st.T * 1.02;
  const base: Frame = { ...fr, o: [fr.o[0] - fr.n[0] * h, fr.o[1] - fr.n[1] * h, fr.o[2] - fr.n[2] * h] };
  const dz: V3 = [fr.n[0] * 2 * h, fr.n[1] * 2 * h, fr.n[2] * 2 * h];
  const ccw = (l: Seg[]): Seg[] => polyArea(loopPolygon(l)) >= 0 ? l : [...l].reverse().map(x => x.kind === "line" ? { ...x, a: x.b, b: x.a } : x.kind === "arc" ? { ...x, a: x.b, b: x.a, ccw: !x.ccw } : x);
  const named = (shape: any, tag: string): Named => { const faces = api.sub(shape, "FACE"); return { shape, faces, names: faces.map((_x, i) => `${f.id}:${tag}${i}`) }; };
  let tool = named(prism(api, faceOf(api, ccw(lay.boundary), [], base), dz), "v");
  lay.ribs.forEach((rb, i) => {
    const l = Math.hypot(rb.b[0] - rb.a[0], rb.b[1] - rb.a[1]);
    if (!(l > 0)) return;
    const e: V2 = [(rb.b[0] - rb.a[0]) / l, (rb.b[1] - rb.a[1]) / l], n: V2 = [-e[1] * rib / 2, e[0] * rib / 2];
    // Run past both ends so the strip crosses the boundary.
    const a: V2 = [rb.a[0] - e[0] * rib, rb.a[1] - e[1] * rib], b: V2 = [rb.b[0] + e[0] * rib, rb.b[1] + e[1] * rib];
    const pts: V2[] = [[a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]]];
    const segs: Seg[] = pts.map((p, k) => ({ ent: `r${k}`, kind: "line", a: p, b: pts[(k + 1) % 4] }));
    tool = api.bool("cut", tool, named(prism(api, faceOf(api, segs, [], base), dz), `r${i}_`), f.id);
  });
  lay.spars.forEach((sp, i) => {
    const ro = sp.r + spar / 2, ri = sp.r - spar / 2;
    const disc = (r: number, tag: string) => named(prism(api, faceOf(api, [{ ent: tag, kind: "circle", c: sp.c, r }], [], base), dz), `${tag}${i}_`);
    let ring = disc(ro, "s");
    if (ri > 1e-9) ring = api.bool("cut", ring, disc(ri, "si"), f.id);
    tool = api.bool("cut", tool, ring, f.id);
  });
  return api.bool("cut", body, tool, f.id);
}

// ---------- forming tools ----------

/** A prism of a flat loop through the sheet (a hair beyond both faces), in a panel's frame. */
function footprint(api: SheetApi, M: Mat, loop: Seg[], T: number, tag: string): Named {
  const shape = prism(api, faceOf(api, loop, [], frameOf(M, -T * 0.01)), applyDir(M, [0, 0, T * 1.02]));
  const faces = api.sub(shape, "FACE");
  return { shape, faces, names: faces.map((_x, i) => `${tag}${i}`) };
}

/** A ruled solid through the same loop at two heights, drawn by `at(z)` (the loop at height z) in a frame. */
function ruled(api: SheetApi, fr: Frame, z0: number, z1: number, at: (z: number) => Seg[]): any {
  const oc = api.oc;
  const mk = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
  for (const z of [z0, z1]) mk.AddWire(wireOf(api, at(z), { ...fr, o: [fr.o[0] + fr.n[0] * z, fr.o[1] + fr.n[1] * z, fr.o[2] + fr.n[2] * z] }));
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) throw new SheetError("E-SM-FORM", "The forming tool could not be made.");
  return mk.Shape();
}

/**
 * Presses each forming tool into the body: the outer shape is joined on the face it stands out of and the same
 * shape moved back by the thickness is cut away, so the form keeps the sheet's thickness (measured along the normal).
 */
function formBody(api: SheetApi, body: Named, f: SmFormFeature, T: number, items: FormItem[]): Named {
  const size = f.size.v, w = f.width.v, h = f.height.v, tn = Math.tan(f.draft?.v ?? 0), eps = T * 0.01;
  let out = body;
  items.forEach((it, i) => {
    const sgn = it.up ? 1 : -1;
    const n = applyDir(it.M, [0, 0, sgn]);
    const x = applyDir(it.M, [Math.cos(it.ang), Math.sin(it.ang), 0]);
    const y: V3 = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    // Local frame on the face the form stands out of: z along the form, the tool's centre at the origin.
    const fr: Frame = { o: apply(it.M, [it.c[0], it.c[1], it.up ? T : 0]), x, y, n };
    const named = (shape: any, tag: string): Named => { const faces = api.sub(shape, "FACE"); return { shape, faces, names: faces.map((_x, j) => `${f.id}:${i}:${tag}${j}`) }; };
    let outer: any, inner: any;
    if (f.tool === "dimple" || f.tool === "rib") {
      // Side walls drafted inwards by tan(draft) per unit of height.
      const at = (z: number): Seg[] => { const g = -2 * z * tn; return f.tool === "dimple" ? [{ ent: "f", kind: "circle", c: [0, 0], r: size / 2 + g / 2 }] : obroundLoop([0, 0], size + g, w + g, 0); };
      outer = ruled(api, fr, 0, h, at);
      // The inside: walls in by T / cos(draft) at the same height, top down by T (frame moved back by T).
      const cs = Math.cos(f.draft?.v ?? 0);
      const inLoop = (z: number): Seg[] => { const g = -2 * (z - T) * tn - 2 * T / cs; return f.tool === "dimple" ? [{ ent: "f", kind: "circle", c: [0, 0], r: size / 2 + g / 2 }] : obroundLoop([0, 0], size + g, w + g, 0); };
      inner = ruled(api, { ...fr, o: [fr.o[0] - n[0] * T, fr.o[1] - n[1] * T, fr.o[2] - n[2] * T] }, -eps, h, inLoop);
    } else if (f.tool === "louver") {
      // A hood rising across the width, open on the +y side; the ends stay closed.
      const side: Frame = { o: [fr.o[0] - x[0] * size / 2, fr.o[1] - x[1] * size / 2, fr.o[2] - x[2] * size / 2], x: y, y: n, n: x };
      const tri = (pts: V2[]): Seg[] => pts.map((p, k) => ({ ent: `l${k}`, kind: "line" as const, a: p, b: pts[(k + 1) % pts.length] }));
      outer = prism(api, faceOf(api, tri([[-w / 2, 0], [w / 2, 0], [w / 2, h]]), [], side), [x[0] * size, x[1] * size, x[2] * size]);
      const s2: Frame = { ...side, o: [side.o[0] + x[0] * T, side.o[1] + x[1] * T, side.o[2] + x[2] * T] };
      // The hood's underside: the top moved down so the skin is T thick square to it.
      const z0 = -T - eps, k = w / h, sft = T * Math.hypot(1, h / w);
      inner = prism(api, faceOf(api, tri([[-w / 2 + (z0 + sft) * k, z0], [w / 2 + eps, z0], [w / 2 + eps, h - sft + eps / k]]), [], s2), [x[0] * (size - 2 * T), x[1] * (size - 2 * T), x[2] * (size - 2 * T)]);
    } else {
      // Extruded hole: a collar of the sheet's thickness round the hole.
      outer = prism(api, faceOf(api, [{ ent: "f", kind: "circle", c: [0, 0], r: size / 2 + T }], [], fr), [n[0] * h, n[1] * h, n[2] * h]);
      const lo = -T - eps, fr2: Frame = { ...fr, o: [fr.o[0] + n[0] * lo, fr.o[1] + n[1] * lo, fr.o[2] + n[2] * lo] }, L = h - lo + eps;
      inner = prism(api, faceOf(api, [{ ent: "f", kind: "circle", c: [0, 0], r: size / 2 }], [], fr2), [n[0] * L, n[1] * L, n[2] * L]);
    }
    out = api.bool("fuse", out, named(outer, "o"), f.id);
    out = api.bool("cut", out, named(inner, "i"), f.id);
  });
  return out;
}

// ---------- unfold / fold ----------

/** The sheet's panels and bends where `pl` puts them: panels, then bends (flat ones as strips in their start panel's plane). */
function sheetParts(api: SheetApi, st: SheetState, pl: SheetPlace): { kind: "panel" | "bend"; id: string; solid: Named }[] {
  const flat = new Set(pl.flat);
  return [
    ...st.panels.map(p => ({ kind: "panel" as const, id: p.id, solid: panelSolid(api, { ...p, M: pl.mats[p.id] }, st.T) })),
    ...st.bends.map(b => ({ kind: "bend" as const, id: b.id, solid: flat.has(b.id) ? stripSolid(api, b, pl.mats[pl.a[b.id]], st.T) : bendSolid(api, { ...b, M: pl.mats[pl.a[b.id]] }, st.T) })),
  ];
}

/** A flat bend: its strip as a plate in the start panel's plane, faces named `<bend>:top|bot|start|end|s0|s1`. */
function stripSolid(api: SheetApi, b: Bend, M: Mat, T: number): Named {
  const loop = bendStrip(b);
  const shape = prism(api, faceOf(api, loop, [], frameOf(M)), applyDir(M, [0, 0, T]));
  return nameSides(api, shape, M, T, loop, b.id);
}

function fuseAll(api: SheetApi, parts: Named[], fid: string): Named {
  let out = parts[0];
  for (const p of parts.slice(1)) out = api.bool("fuse", out, p, fid);
  return out;
}

function solidsOf(api: SheetApi, n: Named): Named[] {
  const oc = api.oc, out: Named[] = [];
  for (const ex = new oc.TopExp_Explorer_2(n.shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const shape = ex.Current(), faces = api.sub(shape, "FACE");
    // Faces keep their names: look each one up in the whole shape.
    out.push({ shape, faces, names: faces.map(fc => { const i = n.faces.findIndex(g => g.IsSame(fc)); return i >= 0 ? n.names[i] : "x"; }) });
  }
  return out;
}

/**
 * Unfold / Fold (FR-FT-120): moves the body from one layout of the sheet to another. The sheet is rebuilt where `to`
 * puts it; what features took out of each panel or bend is moved with it (rigidly, unrolled onto a strip that goes
 * flat, or wrapped onto a bend that folds), and what they added (forms, other bodies) goes with the nearest panel.
 */
function reposition(api: SheetApi, T: number, st: SheetState, body: Named, from: SheetPlace, to: SheetPlace, fid: string): Named {
  const was = sheetParts(api, st, from), now = sheetParts(api, st, to);
  const target = fuseAll(api, now.map(x => x.solid), fid);
  const vols = was.map(x => volumeOf(api, x.solid.shape));
  const sheet = vols.reduce((a, v) => a + v, 0), vb = volumeOf(api, body.shape);
  if (Math.abs(vb - sheet) <= sheet * 1e-7) return target;
  const flatFrom = new Set(from.flat), flatTo = new Set(to.flat);
  const removed: Named[] = [];
  was.forEach((x, i) => {
    const gone = api.bool("cut", x.solid, body, `${fid}:cut`);
    if (volumeOf(api, gone.shape) <= vols[i] * 1e-6) return;
    if (x.kind === "panel") { removed.push(moved(api, gone, flatTrsf(api, from.mats[x.id], to.mats[x.id]))); return; }
    const b = st.bends.find(q => q.id === x.id)!, a = from.a[b.id];
    const f0 = flatFrom.has(b.id), f1 = flatTo.has(b.id);
    if (f0 === f1) removed.push(moved(api, gone, flatTrsf(api, from.mats[a], to.mats[a])));
    else if (!f0) removed.push(...unrolled(api, { ...st, root: to.mats[a] }, { ...b, M: from.mats[a] }, gone, fid));
    else removed.push(...wrapped(api, T, { ...b, M: to.mats[a] }, gone, from.mats[a], fid));
  });
  let out = target;
  for (const r of removed) out = api.bool("cut", out, r, fid);
  // Added material: the body less the sheet, each solid moved with the panel nearest to it.
  let extra: Named = body;
  for (const x of was) extra = api.bool("cut", extra, x.solid, `${fid}:add`);
  const panels = was.filter(x => x.kind === "panel");
  for (const piece of solidsOf(api, extra)) {
    if (volumeOf(api, piece.shape) <= sheet * 1e-9) continue;
    let best = panels[0], bd = Infinity;
    for (const p of panels) {
      const d = new api.oc.BRepExtrema_DistShapeShape_2(piece.shape, p.solid.shape, api.oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, api.oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new api.oc.Message_ProgressRange_1());
      const v = d.IsDone() ? d.Value() : Infinity;
      if (v < bd) { bd = v; best = p; }
    }
    out = api.bool("fuse", out, moved(api, piece, flatTrsf(api, from.mats[best.id], to.mats[best.id])), fid);
  }
  return out;
}

/** Points of a wire, sampled (lines exact), in the plane of M, wound as the wire runs. */
function wirePoints(api: SheetApi, wire: any, M: Mat): V2[] {
  const oc = api.oc, pts: V2[] = [];
  const to2 = (q: any): V2 => { const d = sub3([q.X(), q.Y(), q.Z()], M.o); return [dot(d, M.x), dot(d, M.y)]; };
  for (const ex = new oc.BRepTools_WireExplorer_2(wire); ex.More(); ex.Next()) {
    const ed = ex.Current();
    const cu = new oc.BRepAdaptor_Curve_2(ed);
    const u0 = cu.FirstParameter(), u1 = cu.LastParameter();
    const n = cu.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : 24;
    const seq: V2[] = [];
    for (let i = 0; i <= n; i++) seq.push(to2(cu.Value(u0 + (u1 - u0) * i / n)));
    if (ed.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) seq.reverse();
    for (const q of seq) if (!pts.length || Math.hypot(q[0] - pts.at(-1)![0], q[1] - pts.at(-1)![1]) > 1e-7) pts.push(q);
  }
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1e-7) pts.pop();
  return pts;
}

/**
 * What was cut from a flat strip (lying at Mf), wrapped onto the bend as it folds: each outline on the strip's top face
 * maps to (angle s / ρ, along t) on cylinders just inside and outside the bend (ρ = neutral radius, so lengths on
 * the neutral surface are kept), and the solid between them, holes taken out, is cut from the bend.
 */
function wrapped(api: SheetApi, T: number, b: Bend, gone: Named, Mf: Mat, fid: string): Named[] {
  const oc = api.oc;
  const l = Math.hypot(b.a1[0] - b.a0[0], b.a1[1] - b.a0[1]);
  const e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l], o: V2 = [e[1], -e[0]];
  const rho = Math.min(Math.max(b.ba / b.angle, b.r), b.r + T);
  const c = apply(b.M, [b.a0[0], b.a0[1], b.up ? T + b.r : -b.r]);
  const ua = applyDir(b.M, b.up ? [-e[0], -e[1], 0] : [e[0], e[1], 0]);
  const s3 = applyDir(b.M, [0, 0, b.up ? -1 : 1]);
  // Along the cylinder's axis ua: +t when ua runs with e.
  const sg = b.up ? -1 : 1;
  const ax3 = new oc.gp_Ax3_3(new oc.gp_Pnt_3(c[0], c[1], c[2]), new oc.gp_Dir_4(ua[0], ua[1], ua[2]), new oc.gp_Dir_4(s3[0], s3[1], s3[2]));
  const R1 = Math.max(b.r - T * 0.01, T * 1e-3), R2 = b.r + T * 1.01;
  const S1 = new oc.Handle_Geom_Surface_2(new oc.Geom_CylindricalSurface_1(ax3, R1)), S2 = new oc.Handle_Geom_Surface_2(new oc.Geom_CylindricalSurface_1(ax3, R2));
  const uv = (p: V2): V2 => { const d: V2 = [p[0] - b.a0[0], p[1] - b.a0[1]]; return [(d[0] * o[0] + d[1] * o[1]) / rho, sg * (d[0] * e[0] + d[1] * e[1])]; };
  const tool = (poly: V2[], tag: string): Named => {
    const q = poly.map(uv);
    const edgesOn = (S: any) => q.map((p, i) => {
      const r = q[(i + 1) % q.length], du = r[0] - p[0], dv = r[1] - p[1];
      const line = new oc.Handle_Geom2d_Curve_2(new oc.Geom2d_Line_3(new oc.gp_Pnt2d_3(p[0], p[1]), new oc.gp_Dir2d_4(du, dv)));
      const ed = new oc.BRepBuilderAPI_MakeEdge_31(line, S, 0, Math.hypot(du, dv)).Edge();
      oc.BRepLib.BuildCurves3d_2(ed);
      return ed;
    });
    const e1 = edgesOn(S1), e2 = edgesOn(S2);
    const wire = (es: any[]) => { const mk = new oc.BRepBuilderAPI_MakeWire_1(); for (const x of es) mk.Add_1(x); return mk.Wire(); };
    const sew = new oc.BRepBuilderAPI_Sewing(T * 1e-5, true, true, true, false);
    sew.Add(new oc.BRepBuilderAPI_MakeFace_21(S1, wire(e1), true).Face());
    sew.Add(new oc.BRepBuilderAPI_MakeFace_21(S2, wire(e2), true).Face());
    e1.forEach((x, i) => sew.Add(oc.BRepFill.Face(x, e2[i])));
    sew.Perform(new oc.Message_ProgressRange_1());
    const shells: any[] = [];
    for (const ex = new oc.TopExp_Explorer_2(sew.SewedShape(), oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) shells.push(oc.TopoDS.Shell_1(ex.Current()));
    if (shells.length !== 1 || !oc.BRep_Tool.IsClosed_1(shells[0])) throw new SheetError("E-SM-WRAP", "A cut across an unfolded bend could not be folded back.");
    let solid = new oc.ShapeFix_Solid_1().SolidFromShell(shells[0]);
    if (volumeOf(api, solid) < 0) solid = solid.Reversed();
    const faces = api.sub(solid, "FACE");
    return { shape: solid, faces, names: faces.map((_x, i) => `${fid}:${tag}${i}`) };
  };
  const out: Named[] = [];
  let k = 0;
  for (const fc of api.sub(gone.shape, "FACE")) {
    if (Math.abs(dot(sub3(api.centroid(fc), Mf.o), Mf.z) - T) > T * 1e-3) continue;
    const outerW = oc.BRepTools.OuterWire(fc);
    const outer = wirePoints(api, outerW, Mf);
    if (outer.length < 3 || Math.abs(polyArea(outer)) < 1e-9) continue;
    let t = tool(outer, `w${k++}:`);
    for (const ex = new oc.TopExp_Explorer_2(fc, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const w = oc.TopoDS.Wire_1(ex.Current());
      if (w.IsSame(outerW)) continue;
      const h = wirePoints(api, w, Mf);
      if (h.length >= 3 && Math.abs(polyArea(h)) > 1e-9) t = api.bool("cut", t, tool(h, `w${k++}:`), fid);
    }
    out.push(t);
  }
  return out;
}
