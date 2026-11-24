// Structural analysis (FR-SARC-012): quadrature on cells the geometry cuts.
// Gauss-Legendre rules, and volume/face point sets for a box clipped by an inside test: boxes the
// boundary passes through are split (octree) down to a depth, then their Gauss points are kept when inside.

const RULES = new Map<number, { x: Float64Array; w: Float64Array }>();

/** n-point Gauss-Legendre rule on [-1, 1] (Newton on P_n). */
export function gauss(n: number) {
  let r = RULES.get(n);
  if (r) return r;
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = Math.cos(Math.PI * (i + 0.75) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = t;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * t * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      const dp = n * (t * p1 - p0) / (t * t - 1);
      const dt = p1 / dp;
      t -= dt;
      if (Math.abs(dt) < 1e-16) {
        x[i] = t; w[i] = 2 / ((1 - t * t) * dp * dp);
        break;
      }
    }
  }
  r = { x, w };
  RULES.set(n, r);
  return r;
}

/** Inside test of the body; a mesh body adds exact line cuts and box hints (see body.ts). */
export type Inside = ((x: number, y: number, z: number) => boolean) & {
  hits?(axis: number, p: ArrayLike<number>): number[];
  hint?(lo: ArrayLike<number>, hi: ArrayLike<number>): { axis: number; edge: boolean } | null;
  /** A mesh body's triangles (9 numbers each): another thread can make the same body from them. */
  tris?: Float64Array;
};

/** Points (x, y, z, w) in a growable buffer. */
export class Points {
  a = new Float64Array(256);
  n = 0;
  push(x: number, y: number, z: number, w: number) {
    if (4 * this.n + 4 > this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const o = 4 * this.n++;
    this.a[o] = x; this.a[o + 1] = y; this.a[o + 2] = z; this.a[o + 3] = w;
  }
  weight() { let s = 0; for (let i = 0; i < this.n; i++) s += this.a[4 * i + 3]; return s; }
}

/** How a box lies against the body, by a 3×3×3 sample: 1 inside, 0 outside, −1 cut. */
export function boxState(lo: ArrayLike<number>, hi: ArrayLike<number>, inside: Inside): number {
  if (inside.hint) {
    // exact: no boundary triangle meets the box, so one point tells
    if (inside.hint(lo, hi)) return -1;
    return inside((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2) ? 1 : 0;
  }
  let ins = 0, n = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
    const x = lo[0] + (hi[0] - lo[0]) * i / 2, y = lo[1] + (hi[1] - lo[1]) * j / 2, z = lo[2] + (hi[2] - lo[2]) * k / 2;
    if (inside(x, y, z)) ins++;
    n++;
  }
  return ins === n ? 1 : ins === 0 ? 0 : -1;
}

/**
 * Volume quadrature of the part of box [lo, hi] inside the body. A piece wholly inside that is found above the
 * last octree level is large, so it gets `rich` Gauss points per direction: with fewer than p + 1 a degree-p
 * field has strain modes the points do not see, and the cell's stiffness loses them.
 */
export function volumePoints(lo: number[], hi: number[], q: number, inside: Inside, depth: number, out = new Points(), state?: number, extra = 3, rich = q): Points {
  const st = state ?? boxState(lo, hi, inside);
  if (st === 0) return out;
  // a leaf holding an edge or corner of the body is split further, since its lines can follow only
  // one face (needs the body's hint)
  const hint = st === -1 && depth === 0 && inside.hint ? inside.hint(lo, hi) : null;
  if (hint?.edge && extra > 0) {
    const m = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    for (let o = 0; o < 8; o++) {
      const a = [o & 1 ? m[0] : lo[0], o & 2 ? m[1] : lo[1], o & 4 ? m[2] : lo[2]];
      const b = [o & 1 ? hi[0] : m[0], o & 2 ? hi[1] : m[1], o & 4 ? hi[2] : m[2]];
      volumePoints(a, b, q, inside, 0, out, undefined, extra - 1);
    }
    return out;
  }
  if (st === -1 && depth > 0) {
    const m = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    for (let o = 0; o < 8; o++) {
      const a = [o & 1 ? m[0] : lo[0], o & 2 ? m[1] : lo[1], o & 4 ? m[2] : lo[2]];
      const b = [o & 1 ? hi[0] : m[0], o & 2 ? hi[1] : m[1], o & 4 ? hi[2] : m[2]];
      volumePoints(a, b, q, inside, depth - 1, out, undefined, 3, rich);
    }
    return out;
  }
  if (st === -1) return lineLeaf(lo, hi, q, inside, out, hint?.axis);
  if (depth > 0 && rich > q) q = rich;
  const g = gauss(q);
  const h = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const c = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
  const jw = h[0] * h[1] * h[2];
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) for (let k = 0; k < q; k++) {
    const x = c[0] + h[0] * g.x[i], y = c[1] + h[1] * g.x[j], z = c[2] + h[2] * g.x[k];
    if (st === 1 || inside(x, y, z)) out.push(x, y, z, jw * g.w[i] * g.w[j] * g.w[k]);
  }
  return out;
}

/** A cut leaf box: Gauss lines along the axis closest to the boundary normal (guessed from where the
 * inside samples lie), each cut exactly at the boundary by bisection, Gauss points on every inside piece.
 * A boundary square to that axis is integrated exactly; a tilted one to the accuracy of the lines. */
export function lineLeaf(lo: number[], hi: number[], q: number, inside: Inside, out: Points, axis?: number): Points {
  let ax = axis ?? 2;
  if (axis === undefined) {
    const S = 4;
    const m = [0, 0, 0];
    let nin = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) for (let k = 0; k < S; k++) {
      const f = [(i + 0.5) / S, (j + 0.5) / S, (k + 0.5) / S];
      const p = f.map((t, a) => lo[a] + t * (hi[a] - lo[a]));
      if (inside(p[0], p[1], p[2])) { nin++; for (let a = 0; a < 3; a++) m[a] += f[a] - 0.5; }
    }
    if (nin) { const d = m.map(Math.abs); ax = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2; }
  }
  const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
  if (inside.hits) return exactLeaf(lo, hi, q, inside, out, ax);
  const g = gauss(q);
  const h1 = (hi[a1] - lo[a1]) / 2, h2 = (hi[a2] - lo[a2]) / 2;
  const c1 = (hi[a1] + lo[a1]) / 2, c2 = (hi[a2] + lo[a2]) / 2;
  const L = hi[ax] - lo[ax];
  const p = [0, 0, 0];
  const ins = (t: number) => { p[ax] = t; return inside(p[0], p[1], p[2]); };
  const M = 8;
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) {
    p[a1] = c1 + h1 * g.x[i]; p[a2] = c2 + h2 * g.x[j];
    const wt = h1 * h2 * g.w[i] * g.w[j];
    // inside intervals along the line
    let t0 = lo[ax], prev = ins(t0), start = prev ? t0 : NaN;
    for (let s = 1; s <= M; s++) {
      const t = lo[ax] + (L * s) / M, cur = ins(t);
      if (cur !== prev) {
        let a = lo[ax] + (L * (s - 1)) / M, b = t;
        for (let it = 0; it < 40; it++) { const mid = (a + b) / 2; if (ins(mid) === prev) a = mid; else b = mid; }
        const x = (a + b) / 2;
        if (cur) start = x; else { piece(start, x); start = NaN; }
      }
      prev = cur; t0 = t;
    }
    if (prev) piece(start, hi[ax]);
    function piece(a: number, b: number) {
      const hh = (b - a) / 2, cc = (a + b) / 2;
      if (!(hh > 0)) return;
      for (let k = 0; k < q; k++) {
        p[ax] = cc + hh * g.x[k];
        out.push(p[0], p[1], p[2], wt * hh * g.w[k]);
      }
    }
  }
  return out;
}

/** A cut leaf of a body with exact line cuts: lines along `ax` cut at the boundary; across them the
 * length inside has kinks where the boundary meets the box's two faces square to `ax`, so the
 * transverse rule is split there (and, one level up, where those kink curves meet the box edges). */
function exactLeaf(lo: number[], hi: number[], q: number, inside: Inside, out: Points, ax: number): Points {
  const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
  const g = gauss(q);
  const hits = inside.hits!;
  const p = [0, 0, 0];
  const cuts = (axis: number, a: number, b: number) => {
    const v = hits(axis, p);
    return v.filter(x => x > a && x < b);
  };
  const pieces = (a: number, b: number, br: number[]) => {
    const xs = [a, ...br.sort((x, y) => x - y), b];
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i++) if (xs[i + 1] - xs[i] > 1e-12 * (b - a)) out.push([xs[i], xs[i + 1]]);
    return out;
  };
  // u breaks: where the boundary crosses the four box edges along a1 that bound the faces square to ax
  const ub: number[] = [];
  for (const t of [lo[ax], hi[ax]]) for (const w of [lo[a2], hi[a2]]) {
    p[ax] = t; p[a2] = w; p[a1] = lo[a1];
    ub.push(...cuts(a1, lo[a1], hi[a1]));
  }
  for (const [u0, u1] of pieces(lo[a1], hi[a1], ub)) {
    const hu = (u1 - u0) / 2, cu = (u0 + u1) / 2;
    for (let i = 0; i < q; i++) {
      const u = cu + hu * g.x[i];
      const vb: number[] = [];
      for (const t of [lo[ax], hi[ax]]) { p[ax] = t; p[a1] = u; p[a2] = lo[a2]; vb.push(...cuts(a2, lo[a2], hi[a2])); }
      for (const [v0, v1] of pieces(lo[a2], hi[a2], vb)) {
        const hv = (v1 - v0) / 2, cv = (v0 + v1) / 2;
        for (let j = 0; j < q; j++) {
          p[a1] = u; p[a2] = cv + hv * g.x[j];
          const wt = hu * g.w[i] * hv * g.w[j];
          const hs = hits(ax, p);
          let k = 0;
          while (k < hs.length && hs[k] <= lo[ax]) k++;
          let inn = ((hs.length - k) & 1) === 1, s0 = lo[ax];
          const seg = (a: number, b: number) => {
            const hh = (b - a) / 2, cc = (a + b) / 2;
            if (!(hh > 0)) return;
            for (let m = 0; m < q; m++) { p[ax] = cc + hh * g.x[m]; out.push(p[0], p[1], p[2], wt * hh * g.w[m]); }
          };
          for (; k < hs.length && hs[k] < hi[ax]; k++) { if (inn) seg(s0, hs[k]); inn = !inn; s0 = hs[k]; }
          if (inn) seg(s0, hi[ax]);
        }
      }
    }
  }
  return out;
}

/** facePoints for a body with exact line cuts: the square is split only where an edge of the body
 * crosses it; elsewhere Gauss lines across the boundary curve are cut exactly, with the transverse rule
 * split where that curve meets the square's sides. */
function exactFace(axis: number, at: number, lo: number[], hi: number[], q: number, inside: Inside, depth: number, out: Points): Points {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const bl = lo.slice(), bh = hi.slice();
  bl[axis] = bh[axis] = at;
  const h = inside.hint!(bl, bh);
  const g = gauss(q);
  if (!h) {
    const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    c[axis] = at;
    if (!inside(c[0], c[1], c[2])) return out;
    const h1 = (hi[a1] - lo[a1]) / 2, h2 = (hi[a2] - lo[a2]) / 2;
    for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) {
      const p = [0, 0, 0];
      p[axis] = at; p[a1] = c[a1] + h1 * g.x[i]; p[a2] = c[a2] + h2 * g.x[j];
      out.push(p[0], p[1], p[2], h1 * h2 * g.w[i] * g.w[j]);
    }
    return out;
  }
  if (h.edge && depth > 0) {
    const m1 = (lo[a1] + hi[a1]) / 2, m2 = (lo[a2] + hi[a2]) / 2;
    for (let o = 0; o < 4; o++) {
      const l = lo.slice(), hh = hi.slice();
      if (o & 1) l[a1] = m1; else hh[a1] = m1;
      if (o & 2) l[a2] = m2; else hh[a2] = m2;
      exactFace(axis, at, l, hh, q, inside, depth - 1, out);
    }
    return out;
  }
  // lines along d, stepping across t
  const d = h.axis === a2 ? a2 : a1, t = d === a1 ? a2 : a1;
  const hits = inside.hits!;
  const p = [0, 0, 0];
  p[axis] = at;
  const tb: number[] = [];
  for (const e of [lo[d], hi[d]]) { p[d] = e; p[t] = lo[t]; for (const x of hits(t, p)) if (x > lo[t] && x < hi[t]) tb.push(x); }
  const xs = [lo[t], ...tb.sort((a, b) => a - b), hi[t]];
  for (let s = 0; s + 1 < xs.length; s++) {
    const t0 = xs[s], t1 = xs[s + 1];
    if (!(t1 - t0 > 1e-12 * (hi[t] - lo[t]))) continue;
    const ht = (t1 - t0) / 2, ct = (t0 + t1) / 2;
    for (let i = 0; i < q; i++) {
      p[t] = ct + ht * g.x[i];
      const wt = ht * g.w[i];
      const hs = hits(d, p);
      let k = 0;
      while (k < hs.length && hs[k] <= lo[d]) k++;
      let inn = ((hs.length - k) & 1) === 1, s0 = lo[d];
      const seg = (a: number, b: number) => {
        const hh = (b - a) / 2, cc = (a + b) / 2;
        if (!(hh > 0)) return;
        for (let m = 0; m < q; m++) { p[d] = cc + hh * g.x[m]; out.push(p[0], p[1], p[2], wt * hh * g.w[m]); }
      };
      for (; k < hs.length && hs[k] < hi[d]; k++) { if (inn) seg(s0, hs[k]); inn = !inn; s0 = hs[k]; }
      if (inn) seg(s0, hi[d]);
    }
  }
  return out;
}

/** Quadrature of the part of an axis-aligned square face (normal along `axis`, at `at`) inside the body. */
export function facePoints(axis: number, at: number, lo: number[], hi: number[], q: number, inside: Inside, depth: number, out = new Points()): Points {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  if (inside.hits && inside.hint) return exactFace(axis, at, lo, hi, q, inside, depth, out);
  const pt = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  let ins = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const p = pt(lo[a1] + (hi[a1] - lo[a1]) * i / 2, lo[a2] + (hi[a2] - lo[a2]) * j / 2);
    if (inside(p[0], p[1], p[2])) ins++;
  }
  if (ins === 0) return out;
  if (ins < 9 && depth > 0) {
    const m1 = (lo[a1] + hi[a1]) / 2, m2 = (lo[a2] + hi[a2]) / 2;
    for (let o = 0; o < 4; o++) {
      const l = lo.slice(), h = hi.slice();
      if (o & 1) l[a1] = m1; else h[a1] = m1;
      if (o & 2) l[a2] = m2; else h[a2] = m2;
      facePoints(axis, at, l, h, q, inside, depth - 1, out);
    }
    return out;
  }
  const g = gauss(q);
  const h1 = (hi[a1] - lo[a1]) / 2, h2 = (hi[a2] - lo[a2]) / 2;
  const c1 = (hi[a1] + lo[a1]) / 2, c2 = (hi[a2] + lo[a2]) / 2;
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) {
    const p = pt(c1 + h1 * g.x[i], c2 + h2 * g.x[j]);
    if (ins === 9 || inside(p[0], p[1], p[2])) out.push(p[0], p[1], p[2], h1 * h2 * g.w[i] * g.w[j]);
  }
  return out;
}

/** Quadrature of triangles (9 numbers each): `q` = 1, 3 or 6 point rule; also returns each point's triangle. */
export function trianglePoints(tris: ArrayLike<number>, q: 1 | 3 | 6 = 6): { pts: Points; tri: Int32Array } {
  const R: number[][] = q === 1 ? [[1 / 3, 1 / 3, 1]] : q === 3
    ? [[1 / 6, 1 / 6, 1 / 3], [2 / 3, 1 / 6, 1 / 3], [1 / 6, 2 / 3, 1 / 3]]
    : [[0.445948490915965, 0.445948490915965, 0.223381589678011], [0.108103018168070, 0.445948490915965, 0.223381589678011],
       [0.445948490915965, 0.108103018168070, 0.223381589678011], [0.091576213509771, 0.091576213509771, 0.109951743655322],
       [0.816847572980459, 0.091576213509771, 0.109951743655322], [0.091576213509771, 0.816847572980459, 0.109951743655322]];
  const pts = new Points();
  const nt = tris.length / 9;
  const tri = new Int32Array(nt * R.length);
  let k = 0;
  for (let t = 0; t < nt; t++) {
    const o = 9 * t;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const ux = tris[o + 3] - ax, uy = tris[o + 4] - ay, uz = tris[o + 5] - az;
    const vx = tris[o + 6] - ax, vy = tris[o + 7] - ay, vz = tris[o + 8] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = Math.hypot(cx, cy, cz) / 2;
    for (const [s, t2, w] of R) {
      pts.push(ax + s * ux + t2 * vx, ay + s * uy + t2 * vy, az + s * uz + t2 * vz, w * area);
      tri[k++] = t;
    }
  }
  return { pts, tri };
}

/** n×n collapsed (Duffy) Gauss rule on triangle a, b, c: exact for polynomials of degree 2n − 2. */
export function triangleGauss(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, n: number, out: Points) {
  const g = gauss(n);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const a2 = Math.hypot(cx, cy, cz);
  if (a2 === 0) return;
  for (let i = 0; i < n; i++) {
    const u = (1 + g.x[i]) / 2;
    for (let j = 0; j < n; j++) {
      const v = (1 + g.x[j]) / 2;
      out.push(a[0] + u * ux + u * v * vx, a[1] + u * uy + u * v * vy, a[2] + u * uz + u * v * vz, a2 * u * g.w[i] * g.w[j] / 4);
    }
  }
}

/** Splits a convex polygon by the plane x[axis] = at into the parts below and above. */
export function splitPoly(poly: number[][], axis: number, at: number): [number[][], number[][]] {
  const lo: number[][] = [], hi: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = p[axis] - at, dq = q[axis] - at;
    if (dp <= 0) lo.push(p);
    if (dp >= 0) hi.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      const r = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
      lo.push(r); hi.push(r);
    }
  }
  return [lo.length >= 3 ? lo : [], hi.length >= 3 ? hi : []];
}

/** Quadrature of triangles cut along the planes of a grid (origin lo, step h), so each piece lies in one
 * cell: `n`×`n` Duffy points per sub-triangle. Returns the points and each point's source triangle. */
export function gridTrianglePoints(tris: ArrayLike<number>, lo: number[], h: number, n: number): { pts: Points; tri: Int32Array } {
  const pts = new Points();
  const tri: number[] = [];
  const nt = tris.length / 9;
  for (let t = 0; t < nt; t++) {
    const o = 9 * t;
    let polys: number[][][] = [[[tris[o], tris[o + 1], tris[o + 2]], [tris[o + 3], tris[o + 4], tris[o + 5]], [tris[o + 6], tris[o + 7], tris[o + 8]]]];
    for (let a = 0; a < 3; a++) {
      const next: number[][][] = [];
      for (const P of polys) {
        let mn = Infinity, mx = -Infinity;
        for (const p of P) { mn = Math.min(mn, p[a]); mx = Math.max(mx, p[a]); }
        let rest = P;
        const k0 = Math.floor((mn - lo[a]) / h) + 1, k1 = Math.ceil((mx - lo[a]) / h) - 1;
        for (let k = k0; k <= k1 && rest.length; k++) {
          const at = lo[a] + k * h;
          if (at <= mn + 1e-12 * h || at >= mx - 1e-12 * h) continue;
          const [below, above] = splitPoly(rest, a, at);
          if (below.length) next.push(below);
          rest = above;
        }
        if (rest.length) next.push(rest);
      }
      polys = next;
    }
    for (const P of polys) for (let i = 1; i + 1 < P.length; i++) {
      const before = pts.n;
      triangleGauss(P[0], P[i], P[i + 1], n, pts);
      for (let k = before; k < pts.n; k++) tri.push(t);
    }
  }
  return { pts, tri: Int32Array.from(tri) };
}

/** Moment fitting: replaces many points in box [lo, hi] by the box's q×q×q Gauss points with weights
 * that integrate every tensor Legendre product of degree < q per axis exactly as the given points do
 * (closed form, since the Gauss rule makes those products orthogonal). With q = 2p + 1 the stiffness
 * and mass integrands of degree-p fields come out the same as from the fine points, at a fraction of
 * the cost. Weights may be negative. */
export function fitPoints(src: Points, lo: number[], hi: number[], q: number): Points {
  const g = gauss(q);
  const h = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const c = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
  const deg = q - 1;
  const lx = new Float64Array(2 * q), ly = new Float64Array(2 * q), lz = new Float64Array(2 * q);
  const leg = (n: number, x: number, out: Float64Array) => {
    out[0] = 1; if (n === 0) return; out[1] = x;
    for (let k = 2; k <= n; k++) out[k] = ((2 * k - 1) * x * out[k - 1] - (k - 1) * out[k - 2]) / k;
  };
  const M = new Float64Array(q * q * q);
  for (let t = 0; t < src.n; t++) {
    const o = 4 * t, w = src.a[o + 3];
    leg(deg, (src.a[o] - c[0]) / h[0], lx);
    leg(deg, (src.a[o + 1] - c[1]) / h[1], ly);
    leg(deg, (src.a[o + 2] - c[2]) / h[2], lz);
    // what is integrated with these points has total degree q − 1 at most (the cell basis is of total degree p,
    // q = 2p + 1), so only the moments i + j + k ≤ q − 1 are needed: the others stay 0 and the fitted points
    // integrate the same polynomials exactly
    for (let i = 0; i < q; i++) {
      const X = w * lx[i], bi = i * q * q;
      for (let j = 0; i + j < q; j++) { const XY = X * ly[j], b = bi + j * q, kn = q - i - j; for (let k = 0; k < kn; k++) M[b + k] += XY * lz[k]; }
    }
  }
  // divide by the norms ∫ L_i² = 2 / (2i + 1) on [−1, 1]
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) for (let k = 0; k < q; k++)
    M[(i * q + j) * q + k] *= ((2 * i + 1) * (2 * j + 1) * (2 * k + 1)) / 8;
  const out = new Points();
  const LX: Float64Array[] = [], LY: Float64Array[] = [], LZ: Float64Array[] = [];
  for (let a = 0; a < q; a++) {
    const A = new Float64Array(q); leg(deg, g.x[a], A); LX.push(A);
  }
  LY.push(...LX); LZ.push(...LX);
  // the polynomial at the Gauss points, one direction at a time (3 q⁴ steps, not q⁶)
  const q2 = q * q, T1 = new Float64Array(q * q2), T2 = new Float64Array(q * q2);
  for (let a = 0; a < q; a++) for (let i = 0; i < q; i++) {
    const X = LX[a][i], ao = a * q2, io = i * q2;
    if (X !== 0) for (let jk = 0; jk < q2; jk++) T1[ao + jk] += X * M[io + jk];
  }
  for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) for (let j = 0; j < q; j++) {
    const Y = LY[b][j], to = (a * q + b) * q, so = (a * q + j) * q;
    for (let k = 0; k < q; k++) T2[to + k] += Y * T1[so + k];
  }
  for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) {
    const to = (a * q + b) * q;
    for (let d = 0; d < q; d++) {
      let s = 0;
      const Z = LZ[d];
      for (let k = 0; k < q; k++) s += Z[k] * T2[to + k];
      const w = g.w[a] * g.w[b] * g.w[d] * s;
      if (w !== 0) out.push(c[0] + h[0] * g.x[a], c[1] + h[1] * g.x[b], c[2] + h[2] * g.x[d], w);
    }
  }
  return out;
}

/** Moment fitting of points lying in one plane (see fitPoints): the points (indices `idx` of `src`) are replaced by
 * the q×q Gauss points of their bounding rectangle in the plane with normal `n`, with weights that integrate every
 * polynomial of total degree < q exactly as they do. Returns null when that is no fewer points, or the points
 * lie along a line. */
export function fitPlanePoints(src: Points, idx: ArrayLike<number>, n: ArrayLike<number>, q: number, tiny: number): Points | null {
  const cnt = idx.length;
  if (cnt <= q * q) return null;
  // in-plane axes
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const e = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let ux = n[1] * e[2] - n[2] * e[1], uy = n[2] * e[0] - n[0] * e[2], uz = n[0] * e[1] - n[1] * e[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
  const o0 = 4 * idx[0], x0 = src.a[o0], y0 = src.a[o0 + 1], z0 = src.a[o0 + 2];
  const U = new Float64Array(cnt), V = new Float64Array(cnt);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let t = 0; t < cnt; t++) {
    const o = 4 * idx[t], dx = src.a[o] - x0, dy = src.a[o + 1] - y0, dz = src.a[o + 2] - z0;
    const u = dx * ux + dy * uy + dz * uz, v = dx * vx + dy * vy + dz * vz;
    U[t] = u; V[t] = v;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2, cu = (u1 + u0) / 2, cv = (v1 + v0) / 2;
  if (!(hu > tiny) || !(hv > tiny)) return null;
  const g = gauss(q), deg = q - 1;
  const leg = (x: number, out: Float64Array) => {
    out[0] = 1; if (deg === 0) return; out[1] = x;
    for (let k = 2; k <= deg; k++) out[k] = ((2 * k - 1) * x * out[k - 1] - (k - 1) * out[k - 2]) / k;
  };
  const lu = new Float64Array(q), lv = new Float64Array(q), M = new Float64Array(q * q);
  for (let t = 0; t < cnt; t++) {
    const w = src.a[4 * idx[t] + 3];
    leg((U[t] - cu) / hu, lu);
    leg((V[t] - cv) / hv, lv);
    for (let i = 0; i < q; i++) { const X = w * lu[i], b = i * q; for (let j = 0; i + j < q; j++) M[b + j] += X * lv[j]; }
  }
  for (let i = 0; i < q; i++) for (let j = 0; i + j < q; j++) M[i * q + j] *= ((2 * i + 1) * (2 * j + 1)) / 4;
  const L: Float64Array[] = [];
  for (let a = 0; a < q; a++) { const A = new Float64Array(q); leg(g.x[a], A); L.push(A); }
  const out = new Points();
  for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) {
    let sum = 0;
    for (let i = 0; i < q; i++) { const X = L[a][i], r = i * q; for (let j = 0; i + j < q; j++) sum += X * L[b][j] * M[r + j]; }
    const w = g.w[a] * g.w[b] * sum;
    if (w === 0) continue;
    const u = cu + hu * g.x[a], v = cv + hv * g.x[b];
    out.push(x0 + u * ux + v * vx, y0 + u * uy + v * vy, z0 + u * uz + v * vz, w);
  }
  return out;
}

/** Moment fitting on an axis-aligned face (see fitPoints): q×q Gauss points of the face square. */
export function fitFacePoints(src: Points, axis: number, at: number, lo: number[], hi: number[], q: number): Points {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const g = gauss(q);
  const h1 = (hi[a1] - lo[a1]) / 2, h2 = (hi[a2] - lo[a2]) / 2;
  const c1 = (hi[a1] + lo[a1]) / 2, c2 = (hi[a2] + lo[a2]) / 2;
  const deg = q - 1;
  const leg = (x: number, out: Float64Array) => {
    out[0] = 1; if (deg === 0) return; out[1] = x;
    for (let k = 2; k <= deg; k++) out[k] = ((2 * k - 1) * x * out[k - 1] - (k - 1) * out[k - 2]) / k;
  };
  const lu = new Float64Array(q), lv = new Float64Array(q);
  const M = new Float64Array(q * q);
  for (let t = 0; t < src.n; t++) {
    const o = 4 * t, w = src.a[o + 3];
    leg((src.a[o + a1] - c1) / h1, lu);
    leg((src.a[o + a2] - c2) / h2, lv);
    for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) M[i * q + j] += w * lu[i] * lv[j];
  }
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) M[i * q + j] *= ((2 * i + 1) * (2 * j + 1)) / 4;
  const L: Float64Array[] = [];
  for (let a = 0; a < q; a++) { const A = new Float64Array(q); leg(g.x[a], A); L.push(A); }
  const out = new Points();
  for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) {
    let s = 0;
    for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) s += L[a][i] * L[b][j] * M[i * q + j];
    const w = g.w[a] * g.w[b] * s;
    if (w === 0) continue;
    const p = [0, 0, 0];
    p[axis] = at; p[a1] = c1 + h1 * g.x[a]; p[a2] = c2 + h2 * g.x[b];
    out.push(p[0], p[1], p[2], w);
  }
  return out;
}
