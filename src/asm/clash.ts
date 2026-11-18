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
  // At least `tol` inside the triangle: a pin's polygon pokes past the round edge of the face it stands in by a chord's sag.
  return inside(x, t, tol);
}

/** Whether `c` lies in triangle `t`'s plane, more than `tol` inside its outline. */
function inside(c: THREE.Vector3, t: THREE.Triangle, tol: number) {
  if (!t.getBarycoord(c, bc)) return false;
  const a2 = 2 * t.getArea();
  return bc.x * a2 > tol * t.b.distanceTo(t.c) && bc.y * a2 > tol * t.c.distanceTo(t.a) && bc.z * a2 > tol * t.a.distanceTo(t.b);
}

const na = new THREE.Vector3(), nb = new THREE.Vector3(), ca = new THREE.Vector3(), cb = new THREE.Vector3();

/** Whether segments p–q and r–s of one plane (normal `n`) cross each other more than `tol` from all four ends. */
function cross(p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3, n: THREE.Vector3, tol: number) {
  const d1 = ca.subVectors(q, p), d2 = cb.subVectors(s, r);
  const den = new THREE.Vector3().crossVectors(d1, d2).dot(n);
  const l1 = d1.length(), l2 = d2.length();
  if (Math.abs(den) < 1e-12 * l1 * l2) return false;
  const w = new THREE.Vector3().subVectors(r, p);
  const t = new THREE.Vector3().crossVectors(w, d2).dot(n) / den, u = new THREE.Vector3().crossVectors(w, d1).dot(n) / den;
  return t * l1 > tol && (1 - t) * l1 > tol && u * l2 > tol && (1 - u) * l2 > tol;
}

/** Whether two triangles on one plane share more than an outline: a corner of one inside the other, or crossing edges. */
function overlapFlat(a: THREE.Triangle, b: THREE.Triangle, tol: number) {
  if (inside(b.a, a, tol) || inside(b.b, a, tol) || inside(b.c, a, tol) || inside(a.a, b, tol) || inside(a.b, b, tol) || inside(a.c, b, tol)) return true;
  const A = [a.a, a.b, a.c], B = [b.a, b.b, b.c];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (cross(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3], na, tol)) return true;
  // The same triangle (a part on a copy of itself): neither test above sees it.
  a.getMidpoint(ca); b.getMidpoint(cb);
  return inside(cb, a, tol) || inside(ca, b, tol);
}

/**
 * Whether two triangles of different parts show the parts overlapping: an edge of either passes through the other by
 * more than `tol` (see `edgeThrough`), or they lie on one plane facing the same way and overlap (a part placed on
 * another copy of itself; faces mated onto one another face opposite ways).
 */
export function pierces(a: THREE.Triangle, b: THREE.Triangle, tol: number) {
  a.getNormal(na); b.getNormal(nb);
  if (na.dot(nb) > 1 - 1e-6) {
    a.getPlane(pl);
    if (Math.abs(pl.distanceToPoint(b.a)) < tol && Math.abs(pl.distanceToPoint(b.b)) < tol && Math.abs(pl.distanceToPoint(b.c)) < tol) {
      return overlapFlat(a, b, tol);
    }
  }
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
