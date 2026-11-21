// Structural analysis of assemblies (FR-CON-003, FR-CON-004): the pairs of bodies that touch, overlap or face
// each other within the gap tolerance, found from their surfaces before anything is solved. A piece of one
// body's surface is on another body when a step of the gap along its normal ends inside that body: the same
// test the solver joins the bodies by, so the list is what a solve will join.

import { MeshBody } from "./body";

export interface Connection {
  /** Body indices, a < b. */
  a: number; b: number;
  /** Area of a's surface lying on b, mm² (b's on a when none of a's does). */
  area: number;
  /** Mean distance between the two surfaces over the patch, mm (0 where they touch or overlap). */
  gap: number;
  /** Centre of the patch. */
  at: [number, number, number];
  /** The patch as triangles: the pieces of a's surface on b, and of b's on a. */
  pa: Float32Array; pb: Float32Array;
}

/** Pieces a triangle is cut into along each side at most. */
const MAX_SPLIT = 48;

function boxOf(t: ArrayLike<number>): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i++) { const a = i % 3; if (t[i] < b[a]) b[a] = t[i]; if (t[i] > b[3 + a]) b[3 + a] = t[i]; }
  return b;
}

/**
 * One side of a pair: the pieces of `tris` (body A's surface) that lie on body B. Returns the area, the
 * area-weighted gap and centre sums, and the pieces.
 */
function side(tris: ArrayLike<number>, B: MeshBody, boxB: number[], far: number, eps: number, step: number) {
  const out: number[] = [];
  let area = 0, gapSum = 0;
  const c = [0, 0, 0];
  const nt = tris.length / 9;
  const P = (o: number, u: number, v: number, k: number) => tris[o + k] + u * (tris[o + 3 + k] - tris[o + k]) + v * (tris[o + 6 + k] - tris[o + k]);
  for (let t = 0; t < nt; t++) {
    const o = 9 * t;
    let apart = false;
    for (let k = 0; k < 3; k++) {
      const mn = Math.min(tris[o + k], tris[o + 3 + k], tris[o + 6 + k]), mx = Math.max(tris[o + k], tris[o + 3 + k], tris[o + 6 + k]);
      if (mn > boxB[3 + k] + far || mx < boxB[k] - far) apart = true;
    }
    if (apart) continue;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    nx /= len; ny /= len; nz /= len;
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
    const n = Math.max(1, Math.min(MAX_SPLIT, Math.ceil(edge / step))), w = len / 2 / (n * n);
    const piece = (u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => {
      const cu = (u0 + u1 + u2) / 3, cv = (v0 + v1 + v2) / 3;
      const x = P(o, cu, cv, 0), y = P(o, cu, cv, 1), z = P(o, cu, cv, 2);
      if (x < boxB[0] - far || y < boxB[1] - far || z < boxB[2] - far || x > boxB[3] + far || y > boxB[4] + far || z > boxB[5] + far) return;
      const at = (s: number) => B.inside(x + s * nx, y + s * ny, z + s * nz);
      let g = 0;
      if (!at(eps)) {
        if (!(far > eps) || !at(far)) return;
        let lo = eps, hi = far;
        for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (at(m)) hi = m; else lo = m; }
        g = hi;
      }
      area += w; gapSum += w * g;
      c[0] += w * x; c[1] += w * y; c[2] += w * z;
      for (const [u, v] of [[u0, v0], [u1, v1], [u2, v2]]) out.push(P(o, u, v, 0), P(o, u, v, 1), P(o, u, v, 2));
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      const u = i / n, v = j / n, d = 1 / n;
      piece(u, v, u + d, v, u, v + d);
      if (j < n - i - 1) piece(u + d, v, u + d, v + d, u, v + d);
    }
  }
  return { area, gapSum, c, tris: out };
}

/**
 * The pairs of bodies (closed triangle soups, 9 numbers per triangle, normals outwards) joined across `gap` mm.
 * `only` leaves the search to those pairs (a callback that says whether a pair is wanted).
 */
export function findConnections(bodies: ArrayLike<number>[], gap: number, only?: (a: number, b: number) => boolean): Connection[] {
  const nd = bodies.length, boxes = bodies.map(boxOf);
  const size = boxes.map(b => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]));
  const made: (MeshBody | null)[] = bodies.map(() => null);
  const body = (i: number) => (made[i] ??= new MeshBody(bodies[i]));
  const g = Math.max(0, gap);
  const list: Connection[] = [];
  for (let a = 0; a + 1 < nd; a++) for (let b = a + 1; b < nd; b++) {
    if (only && !only(a, b)) continue;
    const small = Math.min(size[a], size[b]);
    if (!(small > 0)) continue;
    const eps = Math.max(1e-7, 1e-4 * small), far = g + eps;
    let apart = false;
    for (let k = 0; k < 3; k++) if (boxes[a][k] > boxes[b][3 + k] + far || boxes[b][k] > boxes[a][3 + k] + far) apart = true;
    if (apart) continue;
    const step = small / 30;
    const A = side(bodies[a], body(b), boxes[b], far, eps, step), B = side(bodies[b], body(a), boxes[a], far, eps, step);
    const s = A.area > 0 ? A : B;
    if (!(s.area > 0)) continue;
    list.push({
      a, b, area: s.area, gap: s.gapSum / s.area,
      at: [s.c[0] / s.area, s.c[1] / s.area, s.c[2] / s.area],
      pa: Float32Array.from(A.tris), pb: Float32Array.from(B.tris),
    });
  }
  return list;
}
