// Sheet metal on OpenCASCADE (FR-FT-120): turns the panels and bends of sheet.ts into solids and
// joins them to the body. Runs in the kernel worker, called from Modeller.evaluate.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Frame, PartDoc, SketchFeature, V2, V3 } from "../model/types";
import type { Named } from "../kernel/model";
import { inPolygon, loopPolygon, polyArea, type Seg } from "../sketch/profile";
import { apply, applyDir, baseFlange, breakCorner, closedCorner, miterFlange, miterProfile, type FlatEdge, bendSketchLine, edgeFlange, flatLoops, hem, jog, sketchedBend, tab, SheetError, type Bend, type Mat, type Panel, type SheetOp, type SheetState } from "./sheet";
import type { SheetFeature } from "./types";

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
  if (!sm) throw new SheetError("E-SM-NOBASE", "Make a base flange first.");
  if (f.type === "smflat") {
    const flat = flatBody(api, sm, f.id, body);
    return { body: flat.body, sm: flat.edges ? { ...sm, flatEdges: flat.edges } : sm };
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
  } else if (f.type === "smmiter") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a sketch with the miter flange profile.");
    res = miterFlange(sm, f, miterProfile(sk, frameOfSketch(sk)));
  } else res = f.type === "smflange" ? edgeFlange(sm, f) : f.type === "smcorner" ? breakCorner(sm, f) : f.type === "smclosed" ? closedCorner(sm, f) : hem(sm, f);
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
    const piece = op.kind === "panel" ? panelSolid(api, op.panel, T) : bendSolid(api, op.bend, T);
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
  const removed = folded ? removedPieces(api, st, folded, fid) : [];
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
function removedPieces(api: SheetApi, st: SheetState, folded: Named, fid: string): Named[] {
  const panels = st.panels.map(p => ({ p, solid: panelSolid(api, p, st.T) }));
  const sheet = panels.reduce((a, x) => a + volumeOf(api, x.solid.shape), 0) + st.bends.reduce((a, b) => a + volumeOf(api, bendSolid(api, b, st.T).shape), 0);
  const body = volumeOf(api, folded.shape);
  // Nothing taken out: the folded body is exactly the panels and bends.
  if (Math.abs(body - sheet) <= sheet * 1e-7) return [];
  const out: Named[] = [];
  for (const { p, solid } of panels) {
    const v = volumeOf(api, solid.shape);
    const gone = api.bool("cut", solid, folded, `${fid}:cut`);
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
