import * as THREE from "three";
import { chainSegments, makeEdge, type EdgeInfo, type FaceInfo, type V3 } from "../topology";
import type { Part, Viewer } from "./Viewer";

/** Cut profile of one part: curves in part-local coordinates (like B-rep edges). */
export interface PartProfile {
  part: Part;
  edges: EdgeInfo[];
  /** Net cut area (outer loops minus holes), mm². */
  area: number;
}

export interface SectionResult {
  profiles: PartProfile[];
  area: number;
  /** Segment endpoints in part-local coordinates, per part, for drawing. */
  segs: Map<Part, Float32Array>;
}

/**
 * Intersects a plane with every visible part's triangles. Segments are grouped
 * by B-rep face and chained into curves, then fitted like model edges, so a
 * cylinder cut square-on gives a circle with its centre and radius.
 * Area comes from the oriented segments (each oriented along n × triangle normal),
 * which sums outer loops positively and holes negatively without needing loops.
 */
export function computeSection(v: Viewer, plane: THREE.Plane, others: THREE.Plane[]): SectionResult {
  const n = plane.normal;
  const out: SectionResult = { profiles: [], area: 0, segs: new Map() };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), tn = new THREE.Vector3(), dir = new THREE.Vector3();
  const p = new THREE.Vector3(), q = new THREE.Vector3(), w = new THREE.Vector3();

  for (const part of v.parts) {
    if (!part.visible) continue;
    const off = part.group.position;
    const k = plane.constant + n.dot(off); // plane in part-local coordinates
    const d = part.data;
    const lo = n.x * (n.x > 0 ? d.bboxMin[0] : d.bboxMax[0]) + n.y * (n.y > 0 ? d.bboxMin[1] : d.bboxMax[1]) + n.z * (n.z > 0 ? d.bboxMin[2] : d.bboxMax[2]) + k;
    const hi = n.x * (n.x > 0 ? d.bboxMax[0] : d.bboxMin[0]) + n.y * (n.y > 0 ? d.bboxMax[1] : d.bboxMin[1]) + n.z * (n.z > 0 ? d.bboxMax[2] : d.bboxMin[2]) + k;
    if (lo > 0 || hi < 0) continue;

    const P = d.positions, I = d.index;
    const diag = Math.hypot(d.bboxMax[0] - d.bboxMin[0], d.bboxMax[1] - d.bboxMin[1], d.bboxMax[2] - d.bboxMin[2]) || 1;
    const tol = diag * 2e-5;
    const q8 = 1 / Math.max(tol * 0.01, 1e-9);
    const weld = new Map<string, number>();
    const pos: V3[] = [];
    const key = (v3: THREE.Vector3) => {
      const s = `${Math.round(v3.x * q8)},${Math.round(v3.y * q8)},${Math.round(v3.z * q8)}`;
      let id = weld.get(s);
      if (id === undefined) { id = pos.length; weld.set(s, id); pos.push([v3.x, v3.y, v3.z]); }
      return id;
    };
    const byFace = new Map<number, [number, number][]>();
    const draw: number[] = [];
    let area = 0;
    const kept = (v3: THREE.Vector3) => others.every(o => o.distanceToPoint(w.copy(v3).add(off)) >= -1e-9);

    for (let t = 0, nt = I.length / 3; t < nt; t++) {
      a.fromArray(P, 3 * I[3 * t]); b.fromArray(P, 3 * I[3 * t + 1]); c.fromArray(P, 3 * I[3 * t + 2]);
      const da = n.dot(a) + k, db = n.dot(b) + k, dc = n.dot(c) + k;
      const sa = da >= 0, sb = db >= 0, sc = dc >= 0;
      if (sa === sb && sb === sc) continue;
      // The lone vertex on one side, and the two edges leaving it.
      let pts: [THREE.Vector3, number, THREE.Vector3, number, THREE.Vector3, number];
      if (sa !== sb && sa !== sc) pts = [a, da, b, db, c, dc];
      else if (sb !== sa && sb !== sc) pts = [b, db, a, da, c, dc];
      else pts = [c, dc, a, da, b, db];
      const [v0, d0, v1, d1, v2, d2] = pts;
      p.lerpVectors(v0, v1, d0 / (d0 - d1));
      q.lerpVectors(v0, v2, d0 / (d0 - d2));
      if (p.distanceToSquared(q) < 1e-24) continue;
      if (!kept(p) && !kept(q)) continue;
      tn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      dir.crossVectors(n, tn);
      if (dir.dot(w.subVectors(q, p)) < 0) { const tmp = p.clone(); p.copy(q); q.copy(tmp); }
      area += 0.5 * w.crossVectors(p, q).dot(n);
      const face = part.triFace[t];
      const list = byFace.get(face) ?? byFace.set(face, []).get(face)!;
      list.push([key(p), key(q)]);
      draw.push(p.x, p.y, p.z, q.x, q.y, q.z);
    }
    if (!draw.length) continue;

    const edges: EdgeInfo[] = [];
    for (const [face, segs] of byFace) {
      for (const chain of chainSegments(segs, pos)) {
        const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
        const e = makeEdge(-1 - edges.length, chain.map(i => pos[i]), [face, -1], closed, tol);
        if (!e) continue;
        exactCircle(e, d.faces[face], n, k);
        edges.push(e);
      }
    }
    // Plane normal points to the kept side, so a solid's cut sums to a negative area.
    const partArea = Math.abs(area);
    out.profiles.push({ part, edges, area: partArea });
    out.area += partArea;
    out.segs.set(part, Float32Array.from(draw));
  }
  return out;
}

/**
 * Cut points on a tessellated cylinder fall partly on chords, inside the true
 * circle. When the cut surface is analytic, take the circle from the surface:
 * a cylinder cut square to its axis, or any planar cut of a sphere.
 */
function exactCircle(e: EdgeInfo, f: FaceInfo | undefined, n: THREE.Vector3, k: number) {
  if (!f || !f.radius || (e.type !== "circle" && e.type !== "arc")) return;
  const c = new THREE.Vector3(...f.center);
  let center: THREE.Vector3, radius: number;
  if (f.type === "cylinder" && f.axis) {
    const ax = new THREE.Vector3(...f.axis);
    const cos = ax.dot(n);
    if (Math.abs(cos) < 1 - 1e-6) return; // oblique cut: an ellipse, keep the fitted curve
    center = c.addScaledVector(ax, -(n.dot(c) + k) / cos);
    radius = f.radius;
  } else if (f.type === "sphere") {
    const dist = n.dot(c) + k;
    if (Math.abs(dist) >= f.radius) return;
    center = c.addScaledVector(n, -dist);
    radius = Math.sqrt(f.radius * f.radius - dist * dist);
  } else return;
  e.center = [center.x, center.y, center.z];
  e.axis = [n.x, n.y, n.z];
  e.radius = radius;
}
