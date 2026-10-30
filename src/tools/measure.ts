import * as THREE from "three";
import { ExtendedTriangle, MeshBVH, type HitPointInfo } from "three-mesh-bvh";
import type { Part, Viewer } from "../viewer/Viewer";
import type { EdgeInfo, FaceInfo, V3 } from "../topology";
import type { Snap } from "./Snapper";
import { fmtAngle, fmtLen, fmtVec } from "./units";

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
  | "centerDistance" | "arcLength" | "point" | "bbox";

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

interface Closest { d: number; a: THREE.Vector3; b: THREE.Vector3; note?: string }

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

function swap(c: Closest): Closest { return { d: c.d, a: c.b, b: c.a, note: c.note }; }

export function shortestDistance(v: Viewer, A: Entity, B: Entity): Closest {
  if (A.kind === "point") return closestPointEntity(v, A.point, B);
  if (B.kind === "point") return swap(closestPointEntity(v, B.point, A));

  if (A.kind === "face" && B.kind === "face") {
    const fa = A.face!, fb = B.face!;
    if (fa.type === "plane" && fb.type === "plane") {
      const na = V(fa.normal!), nb = V(fb.normal!);
      if (Math.abs(na.dot(nb)) > 1 - 1e-9) {
        const ca = v.toWorld(A.part, fa.centroid), cb = v.toWorld(B.part, fb.centroid);
        const d = cb.clone().sub(ca).dot(na);
        return { d: Math.abs(d), a: ca, b: ca.clone().addScaledVector(na, d), note: "parallel planes" };
      }
    }
    const offA = A.part.group.position, offB = B.part.group.position;
    const bvhA = faceBvh(A.part, fa), bvhB = faceBvh(B.part, fb);
    const m = new THREE.Matrix4().makeTranslation(offB.x - offA.x, offB.y - offA.y, offB.z - offA.z);
    const t1 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as HitPointInfo;
    const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as HitPointInfo;
    bvhA.closestPointToGeometry(bvhB.geometry, m, t1, t2);
    return { d: t1.distance, a: t1.point.clone().add(offA), b: t2.point.clone().applyMatrix4(m).add(offA) };
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
  return null;
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
        a: describeEntity(picks[0]), b: describeEntity(picks[1]), note: c.note ?? "",
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
    case "minDistance": return { title: "Min distance", value: L(m.value), details: [`${d.a} → ${d.b}`, d.note ? String(d.note) : "", `ΔX ${L(d.dx)}  ΔY ${L(d.dy)}  ΔZ ${L(d.dz)}`].filter(Boolean) };
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
    case "bbox": return {
      title: "Bounding box", value: `${fmtLen(d.x as number, false)} × ${fmtLen(d.y as number, false)} × ${fmtLen(d.z as number)}`,
      details: [`Diagonal ${L(m.value)}`, `Parts ${d.parts}`],
    };
  }
}
