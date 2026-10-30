// Active coordinate system for display. Measurements stay in world millimetres;
// positions, directions and axis deltas are re-expressed in the active frame
// only when formatted, so switching frames updates every readout at once.

type Vec = { x: number; y: number; z: number };
type T3 = [number, number, number];

export interface Csys {
  name: string;
  origin: T3;
  /** Orthonormal, right-handed. */
  x: T3;
  y: T3;
  z: T3;
}

export const csys = { active: null as Csys | null };

const dot = (a: T3, b: T3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: T3, b: T3): T3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: T3): T3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A frame with origin `o` and Z along `z`. X follows `xHint` (made square to Z);
 * without one, world X projected onto the plane (world Y when Z is along X).
 */
export function makeCsys(name: string, o: T3, z: T3, xHint?: T3): Csys {
  const Z = norm(z);
  let hint = xHint ?? [1, 0, 0];
  if (Math.abs(dot(norm(hint), Z)) > 0.999) hint = Math.abs(Z[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const d = dot(hint, Z);
  const X = norm([hint[0] - d * Z[0], hint[1] - d * Z[1], hint[2] - d * Z[2]]);
  return { name, origin: [...o], x: X, y: cross(Z, X), z: Z };
}

/** World point to the active frame. */
export function toLocal(p: Vec): Vec {
  const c = csys.active;
  if (!c) return p;
  const w: T3 = [p.x - c.origin[0], p.y - c.origin[1], p.z - c.origin[2]];
  return { x: dot(w, c.x), y: dot(w, c.y), z: dot(w, c.z) };
}

/** World direction (or difference vector) to the active frame. */
export function dirToLocal(v: Vec): Vec {
  const c = csys.active;
  if (!c) return v;
  const w: T3 = [v.x, v.y, v.z];
  return { x: dot(w, c.x), y: dot(w, c.y), z: dot(w, c.z) };
}
