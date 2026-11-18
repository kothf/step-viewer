// Rigid transforms for assembly components (3×4 row-major, see `Tf`).
import type { V3 } from "../model/types";
import type { Tf } from "./types";

export const IDENTITY: Tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function translation(d: V3): Tf { return [1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2]]; }

/** Rotation by `a` radians about the axis through `o` along unit `u`. */
export function rotation(o: V3, u: V3, a: number): Tf {
  const c = Math.cos(a), s = Math.sin(a), k = 1 - c, [x, y, z] = u;
  const r = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  const t = sub(o, apply3(r, o));
  return [r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2]];
}

/** a ∘ b: b first, then a. */
export function compose(a: Tf, b: Tf): Tf {
  const out: number[] = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
    out[i * 4 + 3] = a[i * 4] * b[3] + a[i * 4 + 1] * b[7] + a[i * 4 + 2] * b[11] + a[i * 4 + 3];
  }
  return out;
}

export function applyPoint(t: Tf, p: V3): V3 {
  return [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]];
}

export function applyDir(t: Tf, d: V3): V3 {
  return [t[0] * d[0] + t[1] * d[1] + t[2] * d[2], t[4] * d[0] + t[5] * d[1] + t[6] * d[2], t[8] * d[0] + t[9] * d[1] + t[10] * d[2]];
}

export function invert(t: Tf): Tf {
  // Rigid: the inverse rotation is the transpose.
  const r = [t[0], t[4], t[8], t[1], t[5], t[9], t[2], t[6], t[10]];
  const p = apply3(r, [t[3], t[7], t[11]]);
  return [r[0], r[1], r[2], -p[0], r[3], r[4], r[5], -p[1], r[6], r[7], r[8], -p[2]];
}

const apply3 = (r: number[], p: V3): V3 => [r[0] * p[0] + r[1] * p[1] + r[2] * p[2], r[3] * p[0] + r[4] * p[1] + r[5] * p[2], r[6] * p[0] + r[7] * p[1] + r[8] * p[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Rotation angles (degrees) about X, then Y, then Z, of a transform, for the move panel. */
export function eulerXYZ(t: Tf): V3 {
  const r20 = t[8], y = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const x = Math.abs(r20) < 0.999999 ? Math.atan2(t[9], t[10]) : 0;
  const z = Math.abs(r20) < 0.999999 ? Math.atan2(t[4], t[0]) : Math.atan2(-t[1], t[5]);
  return [x, y, z].map(a => (a * 180) / Math.PI) as V3;
}

/** The angles to show for `t`: the ones typed before (`typed`) while they still give this rotation, else
 *  `eulerXYZ`. At ±90° about Y the X and Z turns share one axis, and reading the angles back from the
 *  transform would show the X turn as 0 and fold it into Z, so the next typed box would lose it. */
export function poseAngles(t: Tf, typed?: V3 | null): V3 {
  if (typed) {
    const r = fromPose([t[3], t[7], t[11]], typed);
    if ([0, 1, 2, 4, 5, 6, 8, 9, 10].every(i => Math.abs(r[i] - t[i]) < 1e-9)) return [...typed] as V3;
  }
  return eulerXYZ(t);
}

/** The transform with this position and X-then-Y-then-Z rotation angles (degrees). */
export function fromPose(p: V3, deg: V3): Tf {
  const [ax, ay, az] = deg.map(d => (d * Math.PI) / 180);
  let r = rotation([0, 0, 0], [1, 0, 0], ax);
  r = compose(rotation([0, 0, 0], [0, 1, 0], ay), r);
  r = compose(rotation([0, 0, 0], [0, 0, 1], az), r);
  r[3] = p[0]; r[7] = p[1]; r[11] = p[2];
  return r;
}

/** The pose a fraction `u` of the way from `a` to `b` along the screw motion that takes one to the other, so a part
 *  turning about an axis away from its origin stays on its arc between two solved frames (a plain blend of the
 *  matrices would cut the corner and shrink it). */
export function tweenTf(a: Tf, b: Tf, u: number): Tf {
  if (u <= 0) return [...a];
  if (u >= 1) return [...b];
  const d = compose(b, invert(a));
  const tr = d[0] + d[5] + d[10], th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  const t: V3 = [d[3], d[7], d[11]];
  if (th < 1e-9) return compose(translation([t[0] * u, t[1] * u, t[2] * u]), a);
  let k: V3;
  if (th < Math.PI - 1e-6) {
    const s = 2 * Math.sin(th);
    k = [(d[9] - d[6]) / s, (d[2] - d[8]) / s, (d[4] - d[1]) / s];
  } else {
    // Half a turn: the axis is the column of R + I with the largest diagonal.
    const i = d[0] >= d[5] && d[0] >= d[10] ? 0 : d[5] >= d[10] ? 1 : 2;
    const c: V3 = [d[i] + (i === 0 ? 1 : 0), d[4 + i] + (i === 1 ? 1 : 0), d[8 + i] + (i === 2 ? 1 : 0)];
    const l = Math.hypot(...c);
    k = [c[0] / l, c[1] / l, c[2] / l];
  }
  const along = k[0] * t[0] + k[1] * t[1] + k[2] * t[2];
  const p: V3 = [t[0] - along * k[0], t[1] - along * k[1], t[2] - along * k[2]];
  // The point the rotation turns about: (p + cot(θ/2)·(k × p)) / 2.
  const ct = 1 / Math.tan(th / 2), kx: V3 = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]];
  const c: V3 = [(p[0] + ct * kx[0]) / 2, (p[1] + ct * kx[1]) / 2, (p[2] + ct * kx[2]) / 2];
  const m = compose(translation([k[0] * along * u, k[1] * along * u, k[2] * along * u]), rotation(c, k, th * u));
  return compose(m, a);
}
