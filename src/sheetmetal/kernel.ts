// Sheet metal on OpenCASCADE (FR-FT-120): turns the panels and bends of sheet.ts into solids and
// joins them to the body. Runs in the kernel worker, called from Modeller.evaluate.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Frame, PartDoc, SketchFeature, V2, V3 } from "../model/types";
import type { Named } from "../kernel/model";
import { inPolygon, loopPolygon, polyArea, type Seg } from "../sketch/profile";
import { apply, applyDir, baseFlange, bendSketchLine, edgeFlange, flatLoops, hem, jog, sketchedBend, SheetError, type Bend, type Mat, type Panel, type SheetOp, type SheetState } from "./sheet";
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
  if (f.type === "smflat") return { body: flatBody(api, sm, f.id), sm };
  let res: { state: SheetState; ops: SheetOp[] };
  if (f.type === "smbend" || f.type === "smjog") {
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new SheetError("E-SM-SKETCH", "Pick a sketch with the bend line.");
    const ln = bendSketchLine(sk, frameOfSketch(sk));
    res = f.type === "smbend" ? sketchedBend(sm, f, ln) : jog(sm, f, ln);
  } else res = f.type === "smflange" ? edgeFlange(sm, f) : hem(sm, f);
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
    out = api.bool("cut", out, cutTool(api, op.M, op.loop, T, `${fid}:t${i}`), fid);
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

/** The flat pattern as a solid on the plane of the first face. */
export function flatBody(api: SheetApi, st: SheetState, fid: string): Named {
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
  return out;
}
