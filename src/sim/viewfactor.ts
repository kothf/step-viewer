// View factors between two sets of faces by ray sampling (FRS-thermal FR-TBC-007): points spread over one set by
// area, directions spread by the cosine law about the outward normal; a ray counts when the first surface it meets
// is one of the other set. Both directions are sampled and joined through reciprocity (A·F_ab = B·F_ba), which halves
// the noise. Deterministic (a fixed seed), so the same model gives the same answer and results can be cached.
// Pure: runs in the solver worker and in node tests.

import { triNormals } from "./static";

/** Rays cast from each side by default: the view factor's noise is about √(F(1 − F)/n), under 0.4 % here. */
export const VIEW_RAYS = 16384;

/** A bounding volume tree over triangles: boxes per node, leaves hold a few triangles. */
interface Bvh {
  tris: Float64Array;
  /** The triangles in leaf order; ids give each one's index in the input. */
  order: Int32Array;
  /** Per node: min x, y, z, max x, y, z. */
  box: Float64Array;
  /** Per node: the right child (inner; the left one is the next node) or the first triangle (leaf), and the triangle count (0 = inner). */
  first: Int32Array;
  count: Int32Array;
  nodes: number;
}

const LEAF = 4;

function bvhOf(tris: Float64Array): Bvh {
  const nt = tris.length / 9, order = Int32Array.from({ length: nt }, (_, i) => i);
  const cen = new Float64Array(3 * nt);
  for (let t = 0; t < nt; t++) for (let a = 0; a < 3; a++) cen[3 * t + a] = (tris[9 * t + a] + tris[9 * t + 3 + a] + tris[9 * t + 6 + a]) / 3;
  const cap = Math.max(1, 2 * Math.ceil(nt / LEAF) + 1);
  const box = new Float64Array(6 * cap), first = new Int32Array(cap), count = new Int32Array(cap);
  let nodes = 0;
  const make = (lo: number, hi: number): number => {
    const n = nodes++;
    const B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], C = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) { const x = tris[9 * t + 3 * v + a]; if (x < B[a]) B[a] = x; if (x > B[3 + a]) B[3 + a] = x; }
      for (let a = 0; a < 3; a++) { const x = cen[3 * t + a]; if (x < C[a]) C[a] = x; if (x > C[3 + a]) C[3 + a] = x; }
    }
    box.set(B, 6 * n);
    if (hi - lo <= LEAF) { first[n] = lo; count[n] = hi - lo; return n; }
    let axis = 0;
    for (let a = 1; a < 3; a++) if (C[3 + a] - C[a] > C[3 + axis] - C[axis]) axis = a;
    // split at the centroids' median along the longest axis
    const mid = (lo + hi) >> 1, part = order.subarray(lo, hi);
    const sorted = Array.from(part).sort((p, q) => cen[3 * p + axis] - cen[3 * q + axis]);
    part.set(sorted);
    make(lo, mid);
    // the left child is always the next node; keep the right one
    first[n] = make(mid, hi); count[n] = 0;
    return n;
  };
  if (nt) make(0, nt);
  return { tris, order, box, first, count, nodes };
}

/** The nearest triangle a ray meets past `tmin`, or −1; `hit[0]` = its distance. */
function nearest(B: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, hit: Float64Array, stack: Int32Array): number {
  const { tris, order, box, first, count } = B;
  if (!B.nodes) return -1;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let best = Infinity, bi = -1, sp = 0;
  stack[sp++] = 0;
  while (sp) {
    const n = stack[--sp], o = 6 * n;
    // slab test against the node's box
    let t0 = (box[o] - ox) * ix, t1 = (box[o + 3] - ox) * ix;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    let u0 = (box[o + 1] - oy) * iy, u1 = (box[o + 4] - oy) * iy;
    if (u0 > u1) { const s = u0; u0 = u1; u1 = s; }
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    let v0 = (box[o + 2] - oz) * iz, v1 = (box[o + 5] - oz) * iz;
    if (v0 > v1) { const s = v0; v0 = v1; v1 = s; }
    if (v0 > t0) t0 = v0;
    if (v1 < t1) t1 = v1;
    if (!(t1 >= t0) || t1 < tmin || t0 > best) continue;
    if (count[n] === 0) { stack[sp++] = n + 1; stack[sp++] = first[n]; continue; }
    for (let i = first[n], e = first[n] + count[n]; i < e; i++) {
      const t = order[i], q = 9 * t;
      // Möller–Trumbore
      const ax = tris[q], ay = tris[q + 1], az = tris[q + 2];
      const e1x = tris[q + 3] - ax, e1y = tris[q + 4] - ay, e1z = tris[q + 5] - az;
      const e2x = tris[q + 6] - ax, e2y = tris[q + 7] - ay, e2z = tris[q + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-300) continue;
      const inv = 1 / det, sx = ox - ax, sy = oy - ay, sz = oz - az;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > tmin && tt < best) { best = tt; bi = t; }
    }
  }
  hit[0] = best;
  return bi;
}

/** A small fixed-seed generator (mulberry32): the same rays every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The share of rays leaving `from` (by area and cosine) whose first hit is the front of a triangle flagged in `mark` (`sn` = the scene's normals). */
function shareTo(from: ArrayLike<number>, B: Bvh, sn: Float64Array, mark: Uint8Array, rays: number, eps: number, seed: number): number {
  const nt = from.length / 9;
  if (!nt || !rays) return 0;
  const area = triNormals(from, true), nrm = triNormals(from), cum = new Float64Array(nt);
  let s = 0;
  for (let t = 0; t < nt; t++) { s += area[t]; cum[t] = s; }
  if (!(s > 0)) return 0;
  const r = rng(seed), hit = new Float64Array(1), stack = new Int32Array(128);
  let got = 0;
  for (let k = 0; k < rays; k++) {
    // a triangle by area, a point on it, then a direction by the cosine law about its outward normal
    const pick = r() * s;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < pick) lo = m + 1; else hi = m; }
    const t = lo, q = 9 * t;
    let a = r(), b = r();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const px = from[q] + a * (from[q + 3] - from[q]) + b * (from[q + 6] - from[q]);
    const py = from[q + 1] + a * (from[q + 4] - from[q + 1]) + b * (from[q + 7] - from[q + 1]);
    const pz = from[q + 2] + a * (from[q + 5] - from[q + 2]) + b * (from[q + 8] - from[q + 2]);
    const nx = nrm[3 * t], ny = nrm[3 * t + 1], nz = nrm[3 * t + 2];
    // two directions square to the normal
    const ux0 = Math.abs(nx) < 0.9 ? 1 : 0, uy0 = ux0 ? 0 : 1;
    let ux = ny * 0 - nz * uy0, uy = nz * ux0 - nx * 0, uz = nx * uy0 - ny * ux0;
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const r2 = r(), phi = 2 * Math.PI * r(), sr = Math.sqrt(r2), cz = Math.sqrt(1 - r2);
    const cu = sr * Math.cos(phi), cv = sr * Math.sin(phi);
    const dx = cu * ux + cv * vx + cz * nx, dy = cu * uy + cv * vy + cz * ny, dz = cu * uz + cv * vz + cz * nz;
    const i = nearest(B, px + eps * nx, py + eps * ny, pz + eps * nz, dx, dy, dz, eps, hit, stack);
    // only the front of a face receives: one met from behind blocks the ray and takes nothing
    if (i >= 0 && mark[i] && dx * sn[3 * i] + dy * sn[3 * i + 1] + dz * sn[3 * i + 2] < 0) got++;
  }
  return got / rays;
}

export interface ViewFactor {
  /** From a to b and from b to a, after reciprocity. */
  fab: number;
  fba: number;
  /** Areas of the two sets, mm². */
  areaA: number;
  areaB: number;
  rays: number;
}

/**
 * The view factor between face sets `a` and `b` (triangles, outward winding). `all` = every surface triangle of the
 * model, which can block the view (a and b may be among them; without it only a and b are seen).
 */
export function viewFactor(a: ArrayLike<number>, b: ArrayLike<number>, all?: ArrayLike<number>, rays = VIEW_RAYS): ViewFactor {
  const na = a.length / 9, nb = b.length / 9, nall = all ? all.length / 9 : 0;
  // the scene: the other triangles, then a and b (a set's own triangles win a tie at the same place)
  const scene = new Float64Array(9 * (nall + na + nb));
  if (all) scene.set(all, 0);
  scene.set(a, 9 * nall);
  scene.set(b, 9 * (nall + na));
  const B = bvhOf(scene);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < scene.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], scene[i]); hi[k] = Math.max(hi[k], scene[i]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, eps = 1e-6 * diag, grid = 10 * eps;
  // a triangle of `all` lying where one of b lies counts as b: same corners within eps
  const key = (o: number) => { const v: string[] = []; for (let c = 0; c < 3; c++) v.push(`${Math.round(scene[o + 3 * c] / grid)},${Math.round(scene[o + 3 * c + 1] / grid)},${Math.round(scene[o + 3 * c + 2] / grid)}`); return v.sort().join(";"); };
  const inA = new Set<string>(), inB = new Set<string>();
  for (let t = 0; t < na; t++) inA.add(key(9 * (nall + t)));
  for (let t = 0; t < nb; t++) inB.add(key(9 * (nall + na + t)));
  const markA = new Uint8Array(nall + na + nb), markB = new Uint8Array(nall + na + nb);
  for (let t = 0; t < nall; t++) { const k = key(9 * t); if (inA.has(k)) markA[t] = 1; if (inB.has(k)) markB[t] = 1; }
  for (let t = 0; t < na; t++) markA[nall + t] = 1;
  for (let t = 0; t < nb; t++) markB[nall + na + t] = 1;
  const aa = triNormals(a, true).reduce((s, v) => s + v, 0), abA = triNormals(b, true).reduce((s, v) => s + v, 0);
  if (!(aa > 0) || !(abA > 0)) return { fab: 0, fba: 0, areaA: aa, areaB: abA, rays };
  const sn = triNormals(scene), fab = shareTo(a, B, sn, markB, rays, eps, 0x9e3779b9), fba = shareTo(b, B, sn, markA, rays, eps, 0x85ebca6b);
  // reciprocity: both estimates of F_ab, averaged; neither direction may exceed 1
  let f = (fab + (abA / aa) * fba) / 2;
  f = Math.max(0, Math.min(f, 1, abA / aa));
  return { fab: f, fba: (f * aa) / abA, areaA: aa, areaB: abA, rays };
}

/**
 * Grey two-surface exchange (FR-TBC-007): the resistance between the sets per σ, 1/mm², so that the heat from a to b
 * is σ (Ta⁴ − Tb⁴) / R (temperatures in K): (1 − εa)/(εa Aa) + 1/(Aa F_ab) + (1 − εb)/(εb Ab). Infinity = no exchange.
 */
export function exchangeResistance(ea: number, eb: number, aa: number, ab: number, fab: number): number {
  if (!(ea > 0) || !(eb > 0) || !(aa > 0) || !(ab > 0) || !(fab > 0)) return Infinity;
  return (1 - ea) / (ea * aa) + 1 / (aa * fab) + (1 - eb) / (eb * ab);
}
