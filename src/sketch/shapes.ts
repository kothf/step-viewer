// 3-point rectangles and the parallelogram (FR-SK-013, P2).
type V2 = [number, number];
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const cross2 = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];

/**
 * Corners, in order round the outline, of a 3-point rectangle (first side p1–p2, p3 sets the width), a 3-point centre
 * rectangle (centre p1, middle of a side p2, p3 sets the other half-size) or a parallelogram (p1, p2, p3, then p1 + p3 − p2).
 */
export function quadCorners(kind: "rect3" | "crect3" | "pgram", p1: V2, p2: V2, p3: V2): V2[] | null {
  const u = sub2(p2, p1), l = Math.hypot(u[0], u[1]);
  if (l < 1e-9) return null;
  if (kind === "pgram") return Math.abs(cross2(u, sub2(p3, p2))) < 1e-9 * l * l ? null : [p1, p2, p3, [p1[0] + p3[0] - p2[0], p1[1] + p3[1] - p2[1]]];
  const n: V2 = [-u[1] / l, u[0] / l];
  const h = n[0] * (p3[0] - p1[0]) + n[1] * (p3[1] - p1[1]);
  if (Math.abs(h) < 1e-9) return null;
  const at = (c: V2, k: number): V2 => [c[0] + n[0] * h * k, c[1] + n[1] * h * k];
  if (kind === "rect3") return [p1, p2, at(p2, 1), at(p1, 1)];
  const a: V2 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
  return [at(a, -1), at(p2, -1), at(p2, 1), at(a, 1)];
}
