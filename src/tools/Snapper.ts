import * as THREE from "three";
import type { Part, Viewer } from "../viewer/Viewer";
import type { EdgeInfo, FaceInfo, V3 } from "../topology";

/** Cut curves supplied by the section manager (part-local coordinates). */
export type SectionSource = () => { part: Part; edges: EdgeInfo[] }[];

export type SnapKind = "vertex" | "circleCenter" | "midpoint" | "quadrant" | "intersection" | "faceCenter" | "onEdge" | "onFace" | "onCap";

export interface Snap {
  kind: SnapKind;
  point: THREE.Vector3;
  part: Part;
  face?: FaceInfo;
  edge?: EdgeInfo;
  /** World normal at the picked surface point (onFace / faceCenter). */
  normal?: THREE.Vector3;
  /** Feature of a section profile rather than of the model. */
  section?: boolean;
  px: number;
}

/** Vertices and centres first, then midpoints and quadrants, edge intersections and face centres, and points anywhere on an edge or face. */
const PRIORITY: Record<SnapKind, number> = { vertex: 0, circleCenter: 0.5, midpoint: 2, quadrant: 2, intersection: 3, faceCenter: 3, onEdge: 4, onFace: 5, onCap: 5 };

export const SNAP_FILTERS = {
  vertex: true, midpoint: true, center: true, edge: true,
  /** With a section active: snap only to the cut (profiles and cap faces), not to the 3D model. */
  planeOnly: false,
};

/**
 * Two stages: a BVH raycast finds the face under the cursor, then the snap
 * features of that face's edges (and every visible circle centre, since a
 * hole's centre lies over empty space) are scored in screen space.
 */
export class Snapper {
  radiusPx = 15;
  private current: Snap | null = null;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  sectionSource: SectionSource | null = null;

  constructor(private viewer: Viewer) {}

  private toScreen(p: THREE.Vector3, out: THREE.Vector2) {
    const v = this.tmpA.copy(p).project(this.viewer.camera);
    out.set((v.x * 0.5 + 0.5) * this.viewer.size.x, (-v.y * 0.5 + 0.5) * this.viewer.size.y);
    return v.z <= 1;
  }

  pick(sx: number, sy: number): Snap | null {
    const v = this.viewer;
    const ndc = new THREE.Vector2((sx / v.size.x) * 2 - 1, -(sy / v.size.y) * 2 + 1);
    const hit = v.pickMeshes(ndc);
    const ray = v.raycaster.ray;
    const cursor = new THREE.Vector2(sx, sy);
    const scr = new THREE.Vector2();
    const R = this.radiusPx;
    let best: Snap | null = null;
    const score = (s: Snap) => PRIORITY[s.kind] * R + s.px;

    const consider = (kind: SnapKind, world: THREE.Vector3, part: Part, extra: Partial<Snap>) => {
      if (!this.toScreen(world, scr)) return;
      if (v.clipPlanes.some(pl => pl.distanceToPoint(world) < -1e-6 * v.modelSize)) return;
      const px = scr.distanceTo(cursor);
      if (px > R) return;
      const s: Snap = { kind, point: world.clone(), part, px, ...extra };
      if (!best || score(s) < score(best)) best = s;
    };

    const edgeCandidates = (part: Part, e: EdgeInfo, section = false) => {
      if (SNAP_FILTERS.vertex) {
        consider("vertex", v.toWorld(part, e.start), part, { edge: e, section });
        if (!e.closed) consider("vertex", v.toWorld(part, e.end), part, { edge: e, section });
      }
      if (SNAP_FILTERS.midpoint && !e.closed) consider("midpoint", v.toWorld(part, e.mid), part, { edge: e, section });
      if (SNAP_FILTERS.center && e.center) consider("circleCenter", v.toWorld(part, e.center), part, { edge: e, section });
      if (SNAP_FILTERS.midpoint && e.center && e.axis && e.radius) {
        for (const q of quadrants(e)) consider("quadrant", v.toWorld(part, q), part, { edge: e, section });
      }
      if (SNAP_FILTERS.edge) {
        let bestD = Infinity;
        const out = new THREE.Vector3();
        const off = part.group.position;
        for (let i = 3; i < e.pts.length; i += 3) {
          this.tmpA.set(e.pts[i - 3], e.pts[i - 2], e.pts[i - 1]).add(off);
          this.tmpB.set(e.pts[i], e.pts[i + 1], e.pts[i + 2]).add(off);
          const seg = new THREE.Vector3();
          const d = ray.distanceSqToSegment(this.tmpA, this.tmpB, undefined, seg);
          if (d < bestD) { bestD = d; out.copy(seg); }
        }
        if (bestD < Infinity) consider("onEdge", out, part, { edge: e, section });
      }
    };

    const profiles = this.sectionSource?.() ?? [];
    const restricted = SNAP_FILTERS.planeOnly && profiles.length > 0;
    for (const pr of profiles) for (const e of pr.edges) edgeCandidates(pr.part, e, true);
    const cap = this.capPoint(ray, hit);
    if (cap) {
      const s: Snap = { kind: "onCap", point: cap.point, part: cap.part, normal: cap.normal, section: true, px: 0 };
      if (!best || score(s) < score(best)) best = s;
    }

    if (restricted) {
      // Cut features only.
    } else if (hit) {
      const part = v.partOf(hit.object);
      const face = part.data.faces[part.triFace[hit.faceIndex!]];
      for (const eid of face.edges) edgeCandidates(part, part.data.edges[eid]);
      if (SNAP_FILTERS.vertex) {
        // This face's virtual corners and its neighbours' (a fillet under the cursor rounds off the corner of the faces beside it).
        const near = new Set([face.id, ...face.edges.flatMap(i => part.data.edges[i]?.faces ?? [])]);
        for (const fi of near) {
          const nf = part.data.faces[fi];
          if (nf) for (const x of virtualCorners(part, nf)) consider("intersection", v.toWorld(part, x), part, { face: nf });
        }
      }
      if (SNAP_FILTERS.center) consider("faceCenter", v.toWorld(part, face.center), part, { face, normal: this.faceNormal(part, face, hit) });
      const n = this.faceNormal(part, face, hit);
      const onFace: Snap = { kind: "onFace", point: hit.point.clone(), part, face, normal: n, px: 0 };
      if (!cap && (!best || score(onFace) < score(best))) best = onFace;
    } else if (v.mode === "wireframe" || v.mode === "hlr") {
      // No face under the cursor: test edges of every visible part.
      for (const part of v.parts) if (part.visible) for (const e of part.data.edges) edgeCandidates(part, e);
    }

    // Circle centres anywhere on screen (holes): cheap projection of all of them.
    if (SNAP_FILTERS.center && !restricted) {
      let budget = 30000;
      for (const part of v.parts) {
        if (!part.visible) continue;
        for (const e of part.data.edges) {
          if (!e.center || budget-- <= 0) continue;
          consider("circleCenter", v.toWorld(part, e.center), part, { edge: e });
        }
      }
    }

    return (this.current = this.hysteresis(best, cursor));
  }

  /**
   * Where the ray meets a section cap: the nearest enabled plane point that is
   * kept by the other planes and lies inside material (the first model hit
   * beyond it is a back face, i.e. the ray is travelling inside a solid).
   */
  private capPoint(ray: THREE.Ray, hit: THREE.Intersection | null) {
    const v = this.viewer;
    if (!hit || !hit.face || !v.clipPlanes.length) return null;
    const hitNormal = hit.face.normal;
    if (hitNormal.dot(ray.direction) <= 0) return null;
    let best: { point: THREE.Vector3; part: Part; normal: THREE.Vector3; t: number } | null = null;
    for (const pl of v.clipPlanes) {
      const t = ray.distanceToPlane(pl);
      if (t === null || t >= hit.distance) continue;
      const point = ray.at(t, new THREE.Vector3());
      if (v.clipPlanes.some(o => o !== pl && o.distanceToPoint(point) < 0)) continue;
      if (!best || t < best.t) best = { point, part: v.partOf(hit.object), normal: pl.normal.clone().negate(), t };
    }
    return best;
  }

  private faceNormal(part: Part, face: FaceInfo, hit: THREE.Intersection) {
    if (face.type === "plane" && face.normal) return new THREE.Vector3(...face.normal);
    const n = (hit as any).normal as THREE.Vector3 | undefined;
    if (n) return n.clone().normalize();
    return hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
  }

  /** Keeps the current snap unless the new one is clearly closer, so markers do not flicker. */
  private hysteresis(next: Snap | null, cursor: THREE.Vector2): Snap | null {
    const cur = this.current;
    if (!cur || !next || cur.kind !== next.kind || next.kind === "onFace" || cur.point.equals(next.point)) return next;
    const scr = new THREE.Vector2();
    if (!this.toScreen(cur.point, scr)) return next;
    const px = scr.distanceTo(cursor);
    return px <= this.radiusPx && px < next.px + 3 ? { ...cur, px } : next;
  }

  reset() { this.current = null; }
}

/**
 * 0°, 90°, 180° and 270° points of a circle or arc: world X (or Y, for a circle
 * square to X) projected into its plane, then turned about the axis. Points an
 * arc does not reach are left out.
 */
export function quadrants(e: EdgeInfo): THREE.Vector3[] {
  const c = new THREE.Vector3(...e.center!), n = new THREE.Vector3(...e.axis!).normalize(), r = e.radius!;
  const u = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  u.addScaledVector(n, -u.dot(n)).normalize();
  const w = n.clone().cross(u);
  const pts = [u, w, u.clone().negate(), w.clone().negate()].map(d => c.clone().addScaledVector(d, r));
  if (e.type === "circle") return pts;
  // On the arc if close to its polyline (chords sag by at most a small fraction of r).
  const seg = new THREE.Line3(), tmp = new THREE.Vector3();
  return pts.filter(p => {
    for (let i = 3; i < e.pts.length; i += 3) {
      seg.set(new THREE.Vector3(e.pts[i - 3], e.pts[i - 2], e.pts[i - 1]), new THREE.Vector3(e.pts[i], e.pts[i + 1], e.pts[i + 2]));
      if (seg.closestPointToPoint(p, true, tmp).distanceTo(p) < 0.02 * r) return true;
    }
    return false;
  });
}

const cornerCache = new WeakMap<Part, Map<number, V3[]>>();

/**
 * Where the extensions of a face's straight edges meet away from any vertex:
 * the sharp corner a fillet or chamfer rounds off. Part-local coordinates.
 */
export function virtualCorners(part: Part, f: FaceInfo): V3[] {
  let m = cornerCache.get(part);
  if (!m) cornerCache.set(part, (m = new Map()));
  const hit = m.get(f.id);
  if (hit) return hit;
  const edges = f.edges.map(i => part.data.edges[i]).filter(Boolean);
  const lines = edges.filter(e => e.type === "line" && e.dir).slice(0, 64);
  const ends = edges.flatMap(e => [e.start, e.end]);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of ends) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = 1e-6 * size;
  const out: V3[] = [];
  const V = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    const d1 = V(a.dir!), d2 = V(b.dir!), p1 = V(a.start), p2 = V(b.start);
    const bb = d1.dot(d2), den = 1 - bb * bb;
    if (den < 1e-9) continue;
    const r = p1.clone().sub(p2), c = d1.dot(r), ff = d2.dot(r);
    const q1 = p1.clone().addScaledVector(d1, (bb * ff - c) / den), q2 = p2.clone().addScaledVector(d2, (ff - bb * c) / den);
    if (q1.distanceTo(q2) > tol) continue;
    const x = q1.add(q2).multiplyScalar(0.5);
    if (ends.some(e => x.distanceTo(V(e)) < tol * 100)) continue;
    // Only corners close to both edges: far crossings of unrelated edges are noise.
    const far = (e: EdgeInfo) => Math.min(x.distanceTo(V(e.start)), x.distanceTo(V(e.end))) > Math.max(e.length, 0.5 * size);
    if (far(a) || far(b)) continue;
    if (!out.some(o => x.distanceTo(V(o)) < tol * 100)) out.push([x.x, x.y, x.z]);
  }
  m.set(f.id, out);
  return out;
}
