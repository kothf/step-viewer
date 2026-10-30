import * as THREE from "three";
import type { Part, Viewer } from "../viewer/Viewer";
import type { EdgeInfo, FaceInfo } from "../topology";

export type SnapKind = "vertex" | "circleCenter" | "midpoint" | "faceCenter" | "onEdge" | "onFace";

export interface Snap {
  kind: SnapKind;
  point: THREE.Vector3;
  part: Part;
  face?: FaceInfo;
  edge?: EdgeInfo;
  /** World normal at the picked surface point (onFace / faceCenter). */
  normal?: THREE.Vector3;
  px: number;
}

const PRIORITY: Record<SnapKind, number> = { vertex: 0, circleCenter: 1, midpoint: 2, faceCenter: 3, onEdge: 4, onFace: 5 };

export const SNAP_FILTERS = { vertex: true, midpoint: true, center: true, edge: true };

/**
 * Two stages: a BVH raycast finds the face under the cursor, then the snap
 * features of that face's edges (and every visible circle centre, since a
 * hole's centre lies over empty space) are scored in screen space.
 */
export class Snapper {
  radiusPx = 14;
  private current: Snap | null = null;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

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
      if (v.clipPlanes.some(pl => pl.distanceToPoint(world) < -1e-6)) return;
      const px = scr.distanceTo(cursor);
      if (px > R) return;
      const s: Snap = { kind, point: world.clone(), part, px, ...extra };
      if (!best || score(s) < score(best)) best = s;
    };

    const edgeCandidates = (part: Part, e: EdgeInfo) => {
      if (SNAP_FILTERS.vertex) {
        consider("vertex", v.toWorld(part, e.start), part, { edge: e });
        if (!e.closed) consider("vertex", v.toWorld(part, e.end), part, { edge: e });
      }
      if (SNAP_FILTERS.midpoint && !e.closed) consider("midpoint", v.toWorld(part, e.mid), part, { edge: e });
      if (SNAP_FILTERS.center && e.center) consider("circleCenter", v.toWorld(part, e.center), part, { edge: e });
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
        if (bestD < Infinity) consider("onEdge", out, part, { edge: e });
      }
    };

    if (hit) {
      const part = v.partOf(hit.object);
      const face = part.data.faces[part.triFace[hit.faceIndex!]];
      for (const eid of face.edges) edgeCandidates(part, part.data.edges[eid]);
      if (SNAP_FILTERS.center) consider("faceCenter", v.toWorld(part, face.center), part, { face, normal: this.faceNormal(part, face, hit) });
      const n = this.faceNormal(part, face, hit);
      const onFace: Snap = { kind: "onFace", point: hit.point.clone(), part, face, normal: n, px: 0 };
      if (!best || score(onFace) < score(best)) best = onFace;
    } else if (v.mode === "wireframe" || v.mode === "hlr") {
      // No face under the cursor: test edges of every visible part.
      for (const part of v.parts) if (part.visible) for (const e of part.data.edges) edgeCandidates(part, e);
    }

    // Circle centres anywhere on screen (holes): cheap projection of all of them.
    if (SNAP_FILTERS.center) {
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
