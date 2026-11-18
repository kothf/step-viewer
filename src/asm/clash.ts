import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";

type Tri = THREE.Triangle & { intersectsTriangle(o: THREE.Triangle): boolean };

const pl = new THREE.Plane(), x = new THREE.Vector3(), bc = new THREE.Vector3();

/**
 * Whether the edge p–q passes through triangle `t`, more than `tol` (mm) inside its outline, with both ends more than
 * `tol` from its plane.
 * An edge lying on the face, ending on it or meeting it on its outline (parts that only touch) does not.
 */
export function edgeThrough(p: THREE.Vector3, q: THREE.Vector3, t: THREE.Triangle, tol: number) {
  t.getPlane(pl);
  if (pl.normal.lengthSq() < 0.5) return false;
  const dp = pl.distanceToPoint(p), dq = pl.distanceToPoint(q);
  if (!((dp > tol && dq < -tol) || (dp < -tol && dq > tol))) return false;
  x.copy(p).lerp(q, dp / (dp - dq));
  if (!t.getBarycoord(x, bc)) return false;
  // At least `tol` inside the triangle: a pin's polygon pokes past the round edge of the face it stands in by a chord's sag.
  const a2 = 2 * t.getArea();
  return bc.x * a2 > tol * t.b.distanceTo(t.c) && bc.y * a2 > tol * t.c.distanceTo(t.a) && bc.z * a2 > tol * t.a.distanceTo(t.b);
}

/** Whether an edge of either triangle passes through the other by more than `tol` (see `edgeThrough`). */
export function pierces(a: THREE.Triangle, b: THREE.Triangle, tol: number) {
  return edgeThrough(a.a, a.b, b, tol) || edgeThrough(a.b, a.c, b, tol) || edgeThrough(a.c, a.a, b, tol)
    || edgeThrough(b.a, b.b, a, tol) || edgeThrough(b.b, b.c, a, tol) || edgeThrough(b.c, b.a, a, tol);
}

/**
 * Whether two closed meshes enter one another by more than `tol` (`m` = the second mesh's coordinates in the first's).
 * Meshes that only touch (a face on a face, an edge on a face, as mates put them) do not count, though their
 * triangles meet; a part entering another always takes an edge of one through a face of the other.
 */
export function penetrates(a: MeshBVH, b: MeshBVH, m: THREE.Matrix4, tol: number) {
  return a.bvhcast(b, m, {
    intersectsTriangles: (t1: THREE.Triangle, t2: THREE.Triangle) => (t1 as Tri).intersectsTriangle(t2) && pierces(t1, t2, tol),
  });
}
