import * as THREE from "three";
import { ExtendedTriangle, MeshBVH, type HitPointInfo } from "three-mesh-bvh";
import type { Part, Viewer } from "../viewer/Viewer";
import type { EdgeInfo, FaceInfo, V3 } from "../topology";
import type { Snap } from "./Snapper";
import { fmtAngle, fmtArea, fmtLen, fmtVec } from "./units";

export interface Entity {
  kind: "point" | "edge" | "face";
  point: THREE.Vector3;
  part: Part;
  edge?: EdgeInfo;
  face?: FaceInfo;
  normal?: THREE.Vector3;
}

export type MeasureType =
  | "distance" | "minDistance" | "angle3" | "angle" | "radius" | "diameter"
  | "centerDistance" | "arcLength" | "point" | "bbox" | "smart";

export interface Measurement {
  id: string;
  type: MeasureType;
  /** Primary value: mm for lengths, radians for angles. */
  value: number;
  color: string;
  visible: boolean;
  /** World-space geometry of the annotation. */
  points: V3[];
  segments: [number, number][];
  labelAt: V3;
  data: Record<string, number | number[] | string>;
}

export const TOOL_INFO: Record<MeasureType, { title: string; picks: number; hint: string }> = {
  distance: { title: "Point to point", picks: 2, hint: "Pick two points (vertices, midpoints, centres…)" },
  minDistance: { title: "Shortest distance", picks: 2, hint: "Pick two entities: point, edge or face" },
  angle3: { title: "3-point angle", picks: 3, hint: "Pick start point, vertex, end point" },
  angle: { title: "Angle", picks: 2, hint: "Pick two edges or faces" },
  radius: { title: "Radius", picks: 1, hint: "Pick a circular edge or cylindrical face" },
  diameter: { title: "Diameter", picks: 1, hint: "Pick a circular edge or cylindrical face" },
  centerDistance: { title: "Centre to centre / pitch", picks: 2, hint: "Pick two holes, arcs or cylinders" },
  arcLength: { title: "Edge / arc length", picks: 1, hint: "Pick an edge" },
  point: { title: "Point & normal", picks: 1, hint: "Pick a point on the model" },
  bbox: { title: "Bounding box", picks: 0, hint: "" },
  smart: { title: "Smart measure", picks: 2, hint: "Click a point, edge or face, then a second one to measure between them" },
};

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const V = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export function entityFromSnap(s: Snap): Entity {
  if (s.kind === "vertex") return { kind: "point", point: s.point, part: s.part, edge: s.edge };
  if (s.kind === "onCap") return { kind: "point", point: s.point, part: s.part, normal: s.normal };
  if (s.kind === "onFace" || s.kind === "faceCenter") return { kind: "face", point: s.point, part: s.part, face: s.face, normal: s.normal };
  return { kind: "edge", point: s.point, part: s.part, edge: s.edge };
}

export function describeEntity(e: Entity) {
  if (e.kind === "point") return e.normal ? "Section point" : "Vertex";
  if (e.kind === "edge") {
    const ed = e.edge!;
    const what = ed.type === "line" ? "Line edge" : ed.type === "circle" ? `Circle R${fmtLen(ed.radius!)}` : ed.type === "arc" ? `Arc R${fmtLen(ed.radius!)}` : "Curve edge";
    return ed.id < 0 ? `Section ${what.toLowerCase()}` : what;
  }
  const f = e.face!;
  return f.type === "plane" ? "Planar face" : f.type === "cylinder" ? `Cylinder R${fmtLen(f.radius!)}` : f.type === "sphere" ? `Sphere R${fmtLen(f.radius!)}` : "Freeform face";
}

// ---------- geometry helpers ----------

function edgeSegments(v: Viewer, e: Entity): [THREE.Vector3, THREE.Vector3][] {
  const pts = e.edge!.pts, out: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 3; i < pts.length; i += 3) {
    out.push([v.toWorld(e.part, [pts[i - 3], pts[i - 2], pts[i - 1]]), v.toWorld(e.part, [pts[i], pts[i + 1], pts[i + 2]])]);
  }
  return out;
}

const faceBvhCache = new WeakMap<Part, Map<number, MeshBVH>>();
function faceBvh(part: Part, f: FaceInfo) {
  let m = faceBvhCache.get(part);
  if (!m) faceBvhCache.set(part, (m = new Map()));
  let b = m.get(f.id);
  if (!b) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", part.mesh.geometry.getAttribute("position"));
    g.setIndex(new THREE.BufferAttribute(part.data.index.slice(f.triStart * 3, (f.triStart + f.triCount) * 3), 1));
    b = new MeshBVH(g);
    m.set(f.id, b);
  }
  return b;
}

function faceTriangles(part: Part, f: FaceInfo, off: THREE.Vector3) {
  const P = part.data.positions, I = part.data.index, tris: ExtendedTriangle[] = [];
  for (let t = f.triStart; t < f.triStart + f.triCount; t++) {
    const tri = new ExtendedTriangle();
    const g = (k: number) => new THREE.Vector3(P[3 * I[3 * t + k]], P[3 * I[3 * t + k] + 1], P[3 * I[3 * t + k] + 2]).add(off);
    tri.set(g(0), g(1), g(2));
    tri.needsUpdate = true;
    tris.push(tri);
  }
  return tris;
}

/** Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segSeg(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-18 && e <= 1e-18) { s = t = 0; }
  else if (a <= 1e-18) { t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-18) { s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-18 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceTo(c2);
}

interface Closest { d: number; a: THREE.Vector3; b: THREE.Vector3; note?: string; planeGap?: number }

function closestPointEntity(v: Viewer, p: THREE.Vector3, e: Entity): Closest {
  if (e.kind === "point") return { d: p.distanceTo(e.point), a: p.clone(), b: e.point.clone() };
  if (e.kind === "edge") {
    let best: Closest = { d: Infinity, a: p.clone(), b: p.clone() };
    const line = new THREE.Line3(), c = new THREE.Vector3();
    for (const [s0, s1] of edgeSegments(v, e)) {
      line.set(s0, s1).closestPointToPoint(p, true, c);
      const d = c.distanceTo(p);
      if (d < best.d) best = { d, a: p.clone(), b: c.clone() };
    }
    return best;
  }
  const off = e.part.group.position;
  const hit = faceBvh(e.part, e.face!).closestPointToPoint(p.clone().sub(off));
  return { d: hit!.distance, a: p.clone(), b: hit!.point.clone().add(off) };
}

function swap(c: Closest): Closest { return { ...c, a: c.b, b: c.a }; }

export function shortestDistance(v: Viewer, A: Entity, B: Entity): Closest {
  if (A.kind === "point") return closestPointEntity(v, A.point, B);
  if (B.kind === "point") return swap(closestPointEntity(v, B.point, A));

  if (A.kind === "face" && B.kind === "face") {
    const fa = A.face!, fb = B.face!;
    const offA = A.part.group.position, offB = B.part.group.position;
    const bvhA = faceBvh(A.part, fa), bvhB = faceBvh(B.part, fb);
    const m = new THREE.Matrix4().makeTranslation(offB.x - offA.x, offB.y - offA.y, offB.z - offA.z);
    const t1 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as HitPointInfo;
    const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as HitPointInfo;
    bvhA.closestPointToGeometry(bvhB.geometry, m, t1, t2);
    const mesh: Closest = { d: t1.distance, a: t1.point.clone().add(offA), b: t2.point.clone().applyMatrix4(m).add(offA) };
    if (fa.type === "plane" && fb.type === "plane") {
      // Parallel planes: the plane gap is exact, but it is the distance between the
      // faces only where they overlap seen along the normal; otherwise the faces are further apart.
      const na = V(fa.normal!);
      if (Math.abs(na.dot(V(fb.normal!))) > 1 - 1e-9) {
        const gap = Math.abs(v.toWorld(B.part, fb.centroid).sub(v.toWorld(A.part, fa.centroid)).dot(na));
        if (mesh.d <= gap + 1e-6 * (1 + gap)) {
          const d = mesh.b.clone().sub(mesh.a).dot(na);
          return { d: gap, a: mesh.a, b: mesh.a.clone().addScaledVector(na, d), note: "parallel planes", planeGap: gap };
        }
        return { ...mesh, note: "parallel planes, offset sideways", planeGap: gap };
      }
    }
    return mesh;
  }

  if (A.kind === "edge" && B.kind === "edge") {
    let best: Closest = { d: Infinity, a: new THREE.Vector3(), b: new THREE.Vector3() };
    const sa = edgeSegments(v, A), sb = edgeSegments(v, B);
    const c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
    for (const [p1, q1] of sa) for (const [p2, q2] of sb) {
      const d = segSeg(p1, q1, p2, q2, c1, c2);
      if (d < best.d) best = { d, a: c1.clone(), b: c2.clone() };
    }
    return best;
  }

  // edge - face
  const [E, F, flip] = A.kind === "edge" ? [A, B, false] : [B, A, true];
  const tris = faceTriangles(F.part, F.face!, F.part.group.position);
  let best: Closest = { d: Infinity, a: new THREE.Vector3(), b: new THREE.Vector3() };
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), seg = new THREE.Line3();
  for (const [p, q] of edgeSegments(v, E)) {
    seg.set(p, q);
    for (const tri of tris) {
      const d = tri.closestPointToSegment(seg, t1, t2);
      if (d < best.d) best = { d, a: t2.clone(), b: t1.clone() };
    }
  }
  return flip ? swap(best) : best;
}

// ---------- analytic descriptors ----------

interface Circleish { center: THREE.Vector3; axis?: THREE.Vector3; radius?: number }

function circleOf(v: Viewer, e: Entity): Circleish | null {
  if (e.kind === "edge" && e.edge!.center) return { center: v.toWorld(e.part, e.edge!.center), axis: V(e.edge!.axis!), radius: e.edge!.radius };
  if (e.kind === "face" && e.face!.type === "cylinder") {
    const f = e.face!, axis = V(f.axis!), c = v.toWorld(e.part, f.center);
    // Centre on the axis level with the pick, so pitch lines sit at the hole.
    return { center: c.clone().addScaledVector(axis, e.point.clone().sub(c).dot(axis)), axis, radius: f.radius };
  }
  if (e.kind === "face" && e.face!.type === "sphere") return { center: v.toWorld(e.part, e.face!.center), radius: e.face!.radius };
  if (e.kind === "face" && e.face!.type === "plane") {
    // A disc, boss top or hole rim: a planar face bounded by a circle acts as that circle.
    const best = faceCircle(e.part, e.face!);
    if (best) return { center: v.toWorld(e.part, best.center!), axis: V(e.face!.normal!), radius: best.radius };
  }
  return null;
}

/** Circle edges of a face, with arcs of one circle merged (STEP often stores a circle as two halves). */
function circlesOf(part: Part, ids: number[]) {
  const groups: { edge: EdgeInfo; sweep: number }[] = [];
  for (const id of ids) {
    const ed = part.data.edges[id];
    if (!ed?.center || !ed.radius || (ed.type !== "circle" && ed.type !== "arc")) continue;
    const sweep = ed.type === "circle" ? 2 * Math.PI : ed.sweep ?? 0;
    // Arcs are fitted to the tessellation, so halves of one circle agree only roughly.
    const tol = 0.02 * Math.max(1, ed.radius);
    const g = groups.find(x => Math.abs(x.edge.radius! - ed.radius!) < tol && V(x.edge.center!).distanceTo(V(ed.center!)) < tol);
    if (g) g.sweep += sweep; else groups.push({ edge: ed, sweep });
  }
  // Nearly closed counts: a flat or a gap in the rim still leaves the circle's centre and size.
  return groups.filter(g => g.sweep > 1.8 * Math.PI).map(g => g.edge);
}

/** The circle bounding a disc or ring face; none for a face that merely has holes in it. */
function faceCircle(part: Part, f: FaceInfo) {
  const c = circlesOf(part, f.edges).sort((a, b) => b.radius! - a.radius!)[0];
  if (!c) return undefined;
  const r = c.radius!;
  const inside = f.area <= Math.PI * r * r * 1.02 && V(f.centroid).distanceTo(V(c.center!)) < 0.05 * r;
  return inside ? c : undefined;
}

/** An arc that, with its neighbours on the same face, closes a circle. */
function closesCircle(part: Part, ed: EdgeInfo) {
  if (ed.type === "circle") return true;
  if (ed.type !== "arc") return false;
  return ed.faces.some(fi => fi >= 0 && circlesOf(part, part.data.faces[fi]?.edges ?? []).some(c =>
    Math.abs(c.radius! - ed.radius!) < 0.02 * Math.max(1, ed.radius!) && V(c.center!).distanceTo(V(ed.center!)) < 0.02 * Math.max(1, ed.radius!)));
}

function directionOf(e: Entity): { v: THREE.Vector3; kind: "line" | "plane" } | null {
  if (e.kind === "edge") {
    const ed = e.edge!;
    if (ed.type === "line") return { v: V(ed.dir!), kind: "line" };
    if (ed.axis) return { v: V(ed.axis), kind: "line" };
    return null;
  }
  if (e.kind === "face") {
    const f = e.face!;
    if (f.type === "plane") return { v: V(f.normal!), kind: "plane" };
    if (f.type === "cylinder") return { v: V(f.axis!), kind: "line" };
    if (e.normal) return { v: e.normal.clone(), kind: "plane" };
  }
  return null;
}

// ---------- measurement builders ----------

export class MeasureError extends Error {}

function base(type: MeasureType, value: number, color: string, points: THREE.Vector3[], segments: [number, number][], labelAt: THREE.Vector3, data: Measurement["data"] = {}): Measurement {
  return { id: newId(), type, value, color, visible: true, points: points.map(v3), segments, labelAt: v3(labelAt), data };
}

export function measure(v: Viewer, type: MeasureType, picks: Entity[], color: string): Measurement {
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  switch (type) {
    case "distance": {
      const [a, b] = [picks[0].point, picks[1].point];
      const d = b.clone().sub(a);
      return base(type, d.length(), color, [a, b], [[0, 1]], mid(a, b), { dx: Math.abs(d.x), dy: Math.abs(d.y), dz: Math.abs(d.z) });
    }
    case "minDistance": {
      const c = shortestDistance(v, picks[0], picks[1]);
      return base(type, c.d, color, [c.a, c.b], [[0, 1]], mid(c.a, c.b), {
        a: describeEntity(picks[0]), b: describeEntity(picks[1]), note: c.note ?? "", ...(c.planeGap !== undefined ? { planeGap: c.planeGap } : {}),
        dx: Math.abs(c.b.x - c.a.x), dy: Math.abs(c.b.y - c.a.y), dz: Math.abs(c.b.z - c.a.z),
      });
    }
    case "angle3": {
      const [a, o, b] = picks.map(p => p.point);
      const ang = a.clone().sub(o).angleTo(b.clone().sub(o));
      const at = o.clone().add(mid(a, b).sub(o).multiplyScalar(0.4));
      return base(type, ang, color, [a, o, b], [[0, 1], [1, 2]], at, { supplement: Math.PI - ang });
    }
    case "angle": {
      const da = directionOf(picks[0]), db = directionOf(picks[1]);
      if (!da || !db) throw new MeasureError("Pick straight edges, planar faces or cylinders (axis).");
      let ang = da.v.angleTo(db.v), label = "between normals";
      if (da.kind === "line" && db.kind === "line") { ang = Math.min(ang, Math.PI - ang); label = "between lines"; }
      else if (da.kind !== db.kind) { const acute = Math.min(ang, Math.PI - ang); ang = Math.PI / 2 - acute; label = "line to plane"; }
      const L = v.modelSize * 0.06;
      const pa = picks[0].point, pb = picks[1].point;
      const pts = [pa, pa.clone().addScaledVector(da.v, L), pb, pb.clone().addScaledVector(db.v, L)];
      return base(type, ang, color, pts, [[0, 1], [2, 3], [0, 2]], mid(pa, pb), { mode: label, supplement: Math.PI - ang });
    }
    case "radius":
    case "diameter": {
      const c = circleOf(v, picks[0]);
      if (!c || !c.radius) throw new MeasureError("Pick a circular edge, arc, cylinder or sphere.");
      let radial = picks[0].point.clone().sub(c.center);
      if (c.axis) radial.addScaledVector(c.axis, -radial.dot(c.axis));
      if (radial.lengthSq() < 1e-12) radial = new THREE.Vector3(1, 0, 0).cross(c.axis ?? new THREE.Vector3(0, 0, 1));
      radial.normalize().multiplyScalar(c.radius);
      const rim = c.center.clone().add(radial);
      if (type === "radius") return base(type, c.radius, color, [c.center, rim], [[0, 1]], mid(c.center, rim), { center: v3(c.center) as number[] });
      const rim2 = c.center.clone().sub(radial);
      return base(type, c.radius * 2, color, [rim2, c.center, rim], [[0, 2]], mid(c.center, rim), { center: v3(c.center) as number[] });
    }
    case "centerDistance": {
      const ca = circleOf(v, picks[0]) ?? { center: picks[0].point }, cb = circleOf(v, picks[1]) ?? { center: picks[1].point };
      const d3 = ca.center.distanceTo(cb.center);
      const data: Measurement["data"] = { centerDistance: d3 };
      let a = ca.center, b = cb.center, value = d3;
      if (ca.axis && cb.axis && Math.abs(ca.axis.dot(cb.axis)) > 1 - 1e-6) {
        const w = cb.center.clone().sub(ca.center);
        const perp = w.clone().addScaledVector(ca.axis, -w.dot(ca.axis));
        value = perp.length();
        b = ca.center.clone().add(perp);
        data.pitch = value;
        data.axial = Math.abs(w.dot(ca.axis));
      }
      return base(type, value, color, [a, b, cb.center], [[0, 1]], mid(a, b), data);
    }
    case "arcLength": {
      const e = picks[0];
      if (e.kind !== "edge") throw new MeasureError("Pick an edge.");
      const ed = e.edge!;
      const pts = edgeSegments(v, e);
      const all = [pts[0][0], ...pts.map(s => s[1])];
      const segs = all.slice(1).map((_, i) => [i, i + 1] as [number, number]);
      const data: Measurement["data"] = { edgeType: ed.type };
      if (ed.radius) { data.radius = ed.radius; data.sweep = ed.sweep ?? 0; }
      return base(type, ed.length, color, all, segs, v.toWorld(e.part, ed.mid), data);
    }
    case "point": {
      const e = picks[0];
      const n = (e.normal ?? new THREE.Vector3(0, 0, 1)).clone().normalize();
      const tip = e.point.clone().addScaledVector(n, v.modelSize * 0.05);
      return base(type, 0, color, [e.point, tip], [[0, 1]], tip, { normal: v3(n) as number[], entity: describeEntity(e) });
    }
    default:
      throw new MeasureError("Unsupported tool");
  }
}

export function measureBBox(v: Viewer, parts: Part[], color: string): Measurement {
  const b = new THREE.Box3();
  for (const p of parts) b.expandByObject(p.mesh);
  const c = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
  const segs: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const s = b.getSize(new THREE.Vector3());
  return base("bbox", s.length(), color, c, segs, c[7], {
    x: s.x, y: s.y, z: s.z, volume: s.x * s.y * s.z, parts: parts.length,
    min: v3(b.min) as number[], max: v3(b.max) as number[],
  });
}

/** Label text (title, main value, detail lines) in the current units. */
export function formatMeasurement(m: Measurement): { title: string; value: string; details: string[] } {
  const d = m.data;
  const L = (x: unknown) => fmtLen(x as number);
  switch (m.type) {
    case "distance": return { title: "Distance", value: L(m.value), details: [`ΔX ${L(d.dx)}`, `ΔY ${L(d.dy)}`, `ΔZ ${L(d.dz)}`] };
    case "minDistance": return { title: "Min distance", value: L(m.value), details: [`${d.a} → ${d.b}`, d.note ? String(d.note) : "", d.planeGap !== undefined && Math.abs((d.planeGap as number) - m.value) > 1e-9 ? `Plane gap ${L(d.planeGap)}` : "", `ΔX ${L(d.dx)}  ΔY ${L(d.dy)}  ΔZ ${L(d.dz)}`].filter(Boolean) };
    case "angle3": return { title: "Angle", value: fmtAngle(m.value), details: [`Supplement ${fmtAngle(d.supplement as number)}`] };
    case "angle": return { title: "Angle", value: fmtAngle(m.value), details: [String(d.mode), `Supplement ${fmtAngle(d.supplement as number)}`] };
    case "radius": return { title: "Radius", value: "R " + L(m.value), details: [`Ø ${L(m.value * 2)}`, `Centre ${fmtVec(new THREE.Vector3(...(d.center as V3)))}`] };
    case "diameter": return { title: "Diameter", value: "Ø " + L(m.value), details: [`R ${L(m.value / 2)}`, `Centre ${fmtVec(new THREE.Vector3(...(d.center as V3)))}`] };
    case "centerDistance": return {
      title: d.pitch !== undefined ? "Pitch (axis to axis)" : "Centre to centre", value: L(m.value),
      details: [d.pitch !== undefined ? `3D centre distance ${L(d.centerDistance)}` : "", d.axial !== undefined ? `Axial offset ${L(d.axial)}` : ""].filter(Boolean),
    };
    case "arcLength": return {
      title: d.edgeType === "line" ? "Edge length" : d.edgeType === "curve" ? "Curve length" : "Arc length", value: L(m.value),
      details: d.radius ? [`R ${L(d.radius)}`, `Sweep ${fmtAngle(d.sweep as number)}`] : [],
    };
    case "point": {
      const p = new THREE.Vector3(...m.points[0]);
      const n = d.normal as number[];
      return { title: "Point", value: fmtVec(p), details: [`Normal (${n.map(x => x.toFixed(4)).join(", ")})`, String(d.entity)] };
    }
    case "smart": {
      const rows = JSON.parse(String(d.rows)) as Row[];
      return { title: String(d.title), value: String(d.prefix ?? "") + fmtRow(d.kind as RowKind, m.value, m.points[0]), details: rows.map(([label, kind, x]) => `${label} ${fmtRow(kind, x)}`) };
    }
    case "bbox": return {
      title: "Bounding box", value: `${fmtLen(d.x as number, false)} × ${fmtLen(d.y as number, false)} × ${fmtLen(d.z as number)}`,
      details: [`Diagonal ${L(m.value)}`, `Parts ${d.parts}`],
    };
  }
}

// ---------- smart measure ----------

type RowKind = "len" | "ang" | "area" | "pos" | "dir" | "text";
type Row = [string, RowKind, number | number[] | string];

function fmtRow(kind: RowKind, x: unknown, fallback?: V3): string {
  switch (kind) {
    case "len": return fmtLen(x as number);
    case "ang": return fmtAngle(x as number);
    case "area": return fmtArea(x as number);
    case "pos": return fmtVec(V((Array.isArray(x) ? x : fallback) as V3));
    case "dir": return fmtVec(V(x as V3), false);
    case "text": return String(x);
  }
}

function smart(geo: Measurement, title: string, value: number, kind: RowKind, rows: Row[], prefix = ""): Measurement {
  geo.type = "smart";
  geo.value = value;
  geo.data = { title, kind, prefix, rows: JSON.stringify(rows) };
  return geo;
}

const deltas = (a: THREE.Vector3, b: THREE.Vector3): Row[] =>
  [["ΔX", "len", Math.abs(b.x - a.x)], ["ΔY", "len", Math.abs(b.y - a.y)], ["ΔZ", "len", Math.abs(b.z - a.z)]];

/**
 * Picks what to measure from the entities themselves: one entity gives its own
 * size (diameter, length, area, position), two give the relation between them
 * (pitch, plane gap, angle or shortest distance) with the other values as details.
 */
export function smartMeasure(v: Viewer, picks: Entity[], color: string): Measurement {
  return picks.length === 1 ? smartSingle(v, picks[0], color) : smartPair(v, picks[0], picks[1], color);
}

function smartSingle(v: Viewer, e: Entity, color: string): Measurement {
  const desc = describeEntity(e);
  if (e.kind === "point") {
    return smart(base("smart", 0, color, [e.point], [], e.point), "Vertex", 0, "pos", [["Point", "pos", v3(e.point)]]);
  }
  const c = circleOf(v, e);
  if (e.kind === "edge") {
    const ed = e.edge!;
    if (c && ed.type === "arc" && !closesCircle(e.part, ed)) {
      const rows: Row[] = [["Diameter", "len", c.radius! * 2], ["Arc length", "len", ed.length], ["Sweep", "ang", ed.sweep ?? 0], ["Centre", "pos", v3(c.center)]];
      return smart(measure(v, "radius", [e], color), "Arc", c.radius!, "len", rows, "R ");
    }
    if (c) {
      const rows: Row[] = [["Radius", "len", c.radius!], ["Circumference", "len", 2 * Math.PI * c.radius!], ["Centre", "pos", v3(c.center)], ["Axis", "dir", v3(c.axis!)]];
      return smart(measure(v, "diameter", [e], color), desc.startsWith("Section") ? "Section circle" : "Circle", c.radius! * 2, "len", rows, "Ø ");
    }
    const geo = measure(v, "arcLength", [e], color);
    const a = v.toWorld(e.part, ed.start), b = v.toWorld(e.part, ed.end);
    const rows: Row[] = ed.type === "line" ? [...deltas(a, b), ["Direction", "dir", ed.dir!]] : [["Chord", "len", a.distanceTo(b)]];
    return smart(geo, ed.type === "line" ? "Edge length" : "Curve length", ed.length, "len", rows);
  }
  const f = e.face!;
  const area: Row = ["Area", "area", f.area];
  if (c) {
    const rows: Row[] = [["Radius", "len", c.radius!], area];
    if (f.type === "cylinder") rows.push(["Axis", "dir", v3(c.axis!)]);
    else rows.push(["Centre", "pos", v3(c.center)]);
    if (f.type === "plane") rows.push(["Normal", "dir", f.normal!]);
    const title = f.type === "cylinder" ? "Cylinder" : f.type === "sphere" ? "Sphere" : "Circular face";
    return smart(measure(v, "diameter", [e], color), title, c.radius! * 2, "len", rows, f.type === "sphere" ? "SØ " : "Ø ");
  }
  const geo = measure(v, "point", [e], color);
  const rows: Row[] = [["Point", "pos", v3(e.point)]];
  if (f.type === "plane") rows.push(["Normal", "dir", f.normal!], ["Centroid", "pos", v3(v.toWorld(e.part, f.centroid))]);
  else if (e.normal) rows.push(["Normal here", "dir", v3(e.normal)]);
  return smart(geo, f.type === "plane" ? "Planar face" : "Face", f.area, "area", rows);
}

function smartPair(v: Viewer, A: Entity, B: Entity, color: string): Measurement {
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  const line = (a: THREE.Vector3, b: THREE.Vector3) => base("smart", 0, color, [a, b], [[0, 1]], mid(a, b));
  const sd = shortestDistance(v, A, B);
  const gapRow: Row = ["Shortest distance", "len", sd.d];
  const names: Row = ["Between", "text", `${describeEntity(A)} → ${describeEntity(B)}`];
  const ca = circleOf(v, A), cb = circleOf(v, B);

  // Holes, bosses, arcs, cylinders: centre to centre, pitch for parallel axes.
  if (ca && cb) {
    const w = cb.center.clone().sub(ca.center);
    const rows: Row[] = [["Centre distance", "len", w.length()]];
    const dia = (c: Circleish) => (c.radius ? c.radius * 2 : 0);
    if (ca.axis && cb.axis && Math.abs(ca.axis.dot(cb.axis)) > 1 - 1e-6) {
      const axial = w.dot(ca.axis);
      const perp = w.clone().addScaledVector(ca.axis, -axial);
      if (perp.length() < 1e-6 * (1 + w.length())) {
        rows.push(["Ø", "text", `${fmtLen(dia(ca))} / ${fmtLen(dia(cb))}`], gapRow, names);
        return smart(line(ca.center, cb.center), "Coaxial, axial distance", Math.abs(axial), "len", rows);
      }
      const foot = ca.center.clone().add(perp);
      const geo = base("smart", 0, color, [ca.center, foot, cb.center], [[0, 1], [1, 2]], mid(ca.center, foot));
      if (Math.abs(axial) > 1e-6 * (1 + w.length())) rows.push(["Axial offset", "len", Math.abs(axial)]);
      rows.push(...deltas(ca.center, cb.center), ["Ø", "text", `${fmtLen(dia(ca))} / ${fmtLen(dia(cb))}`], gapRow, names);
      if (Math.abs(axial) < 1e-6 * (1 + w.length())) geo.segments = [[0, 1]];
      return smart(geo, "Pitch (axis to axis)", perp.length(), "len", rows);
    }
    rows.push(...deltas(ca.center, cb.center), gapRow, names);
    return smart(line(ca.center, cb.center), "Centre to centre", w.length(), "len", rows);
  }

  // A hole or boss against a face or a straight edge: from its centre.
  const circ = ca ? { c: ca, e: A, o: B } : cb ? { c: cb, e: B, o: A } : null;
  if (circ) {
    const { c, e, o } = circ;
    const isCylinder = e.kind === "face" && e.face!.type === "cylinder";
    if (o.kind === "face" && o.face!.type === "plane") {
      const n = V(o.face!.normal!);
      const cos = c.axis ? Math.abs(c.axis.dot(n)) : 0;
      // Axis along the face: centre to face. Axis square to it: the circle's depth (a cylinder has no single centre there).
      if (cos < 1e-6 || (cos > 1 - 1e-6 && !isCylinder)) {
        const d = c.center.clone().sub(o.point).dot(n);
        const foot = c.center.clone().addScaledVector(n, -d);
        const rows: Row[] = [["Ø", "len", (c.radius ?? 0) * 2], gapRow, names];
        return smart(line(c.center, foot), cos < 1e-6 ? "Centre to face" : "Circle to face", Math.abs(d), "len", rows);
      }
    } else if (o.kind === "edge" && o.edge!.type === "line") {
      const p0 = v.toWorld(o.part, o.edge!.start), dir = V(o.edge!.dir!);
      const w = c.center.clone().sub(p0);
      const foot = p0.clone().addScaledVector(dir, w.dot(dir));
      const rows: Row[] = [["Ø", "len", (c.radius ?? 0) * 2], gapRow, names];
      return smart(line(c.center, foot), "Centre to line", c.center.distanceTo(foot), "len", rows);
    }
  }

  const da = directionOf(A), db = directionOf(B);
  if (da && db) {
    const raw = da.v.angleTo(db.v), acute = Math.min(raw, Math.PI - raw);
    const parallel = da.kind === db.kind ? acute < 1e-6 : Math.abs(acute - Math.PI / 2) < 1e-6;
    if (parallel) {
      // Plane–plane and line–plane use the plane normal; line–line the common perpendicular.
      const n = da.kind === "plane" ? da.v : db.kind === "plane" ? db.v : null;
      const pa = A.point, pb = B.point;
      const w = pb.clone().sub(pa);
      const off = n ? n.clone().multiplyScalar(w.dot(n)) : w.clone().addScaledVector(da.v, -w.dot(da.v));
      const dist = off.length();
      const title = da.kind === "plane" && db.kind === "plane" ? "Parallel faces" : da.kind === "line" && db.kind === "line" ? "Parallel lines" : "Parallel to the face";
      if (dist > 1e-6 * (1 + v.modelSize)) {
        const rows: Row[] = [["Normal distance", "len", dist]];
        if (Math.abs(sd.d - dist) > 1e-6) rows.push(gapRow);
        rows.push(names);
        return smart(line(pa, pa.clone().add(off)), title, dist, "len", rows);
      }
      // Coplanar / collinear: what is left is how far apart they sit.
      const rows: Row[] = [["Plane gap", "len", 0], ...deltas(sd.a, sd.b), names];
      return smart(line(sd.a, sd.b), da.kind === "plane" && db.kind === "plane" ? "Coplanar faces" : "Collinear", sd.d, "len", rows);
    }
    const geo = measure(v, "angle", [A, B], color);
    const rows: Row[] = [["Supplement", "ang", Math.PI - geo.value], ["Mode", "text", String(geo.data.mode)], gapRow, names];
    return smart(geo, "Angle", geo.value, "ang", rows);
  }

  const rows: Row[] = [...deltas(sd.a, sd.b)];
  const c = ca ?? cb, p = A.kind === "point" ? A.point : B.kind === "point" ? B.point : null;
  if (c && p) rows.push(["To centre", "len", p.distanceTo(c.center)]);
  rows.push(names);
  const title = A.kind === "point" && B.kind === "point" ? "Distance" : "Shortest distance";
  return smart(line(sd.a, sd.b), title, sd.d, "len", rows);
}
