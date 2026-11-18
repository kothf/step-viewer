// Outlines measured off the model (cuts unrolled from a bend, outlines wrapped back onto one): each edge is sampled
// and fitted back to a line, an arc or a smooth spline, so a cut across a bend gives one face per edge, not one per
// sample (exam bug #10: an Unfold went from 242 to 1,381 faces and a Fold took four minutes).
import type { V2 } from "../model/types";
import type { Seg } from "../sketch/profile";
import type { FlatEdge } from "./sheet";

/** Circle through three points, null when they are (nearly) in a line. */
function circle3(a: V2, b: V2, c: V2): { c: V2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const s = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  if (Math.abs(d) < 1e-12 * s * s) return null;
  const A = a[0] * a[0] + a[1] * a[1], B = b[0] * b[0] + b[1] * b[1], C = c[0] * c[0] + c[1] * c[1];
  const x = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d;
  const y = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

/**
 * One outline piece through sampled points (in order, first and last = its ends): a line when every point is within
 * `tol` of the chord, an arc when every point is within `tol` of the circle through the ends and the middle and they
 * turn one way round it, else a Catmull-Rom spline through all of them (as cubic Bézier poles).
 */
export function fitSeg(pts: V2[], tol: number, ent = "f"): Seg {
  const a = pts[0], b = pts[pts.length - 1];
  const ux = b[0] - a[0], uy = b[1] - a[1], l = Math.hypot(ux, uy);
  if (l > tol && pts.every(p => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) / l <= tol)) return { ent, kind: "line", a, b };
  if (pts.length >= 3) {
    const n = pts.length - 1;
    const ci = l > tol ? circle3(a, pts[Math.floor(n / 2)], b) : n >= 3 ? circle3(a, pts[Math.floor(n / 3)], pts[Math.floor(2 * n / 3)]) : null;
    // Nearly straight runs fit huge circles: keep to radii within a million times the run's size.
    const size = Math.max(l, ...pts.map(p => Math.hypot(p[0] - a[0], p[1] - a[1])));
    if (ci && ci.r < 1e6 * Math.max(size, tol) && pts.every(p => Math.abs(Math.hypot(p[0] - ci.c[0], p[1] - ci.c[1]) - ci.r) <= tol)) {
      let turn = 0, sign = 0, mixed = false;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const t = Math.atan2((p[0] - ci.c[0]) * (q[1] - ci.c[1]) - (p[1] - ci.c[1]) * (q[0] - ci.c[0]), (p[0] - ci.c[0]) * (q[0] - ci.c[0]) + (p[1] - ci.c[1]) * (q[1] - ci.c[1]));
        if (Math.abs(t) < 1e-12) continue;
        if (sign && Math.sign(t) !== sign) mixed = true;
        sign = Math.sign(t);
        turn += t;
      }
      if (!mixed && sign) {
        if (Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6 && l <= tol) return { ent, kind: "circle", c: ci.c, r: ci.r };
        if (Math.abs(turn) < 2 * Math.PI - 1e-6) return { ent, kind: "arc", c: ci.c, r: ci.r, a, b, ccw: sign > 0 };
      }
    }
  }
  const n = pts.length - 1, bz: V2[] = [a];
  const at = (i: number) => pts[Math.max(0, Math.min(n, i))];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    bz.push([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2);
  }
  return { ent, kind: "spline", bz };
}

/** The piece starting exactly at p (a fitted loop's pieces then meet end to end). */
export function startAt(s: Seg, p: V2): Seg {
  if (s.kind === "line" || s.kind === "arc" || s.kind === "earc") return { ...s, a: p };
  if (s.kind === "spline") return { ent: s.ent, kind: "spline", bz: [p, ...s.bz.slice(1)] };
  return s;
}

/** Where a piece ends. */
export function segEnd(s: Seg): V2 | null {
  if (s.kind === "line" || s.kind === "arc" || s.kind === "earc") return s.b;
  if (s.kind === "spline") return s.bz[s.bz.length - 1];
  return null;
}

/** The same outline piece run the other way. */
export function reverseSeg(s: Seg): Seg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  if (s.kind === "arc" || s.kind === "earc") return { ...s, a: s.b, b: s.a, ccw: !s.ccw };
  if (s.kind === "spline") return { ent: s.ent, kind: "spline", bz: [...s.bz].reverse() };
  return s;
}

/** A loop run the other way. */
export const reverseLoop = (loop: Seg[]): Seg[] => loop.map(reverseSeg).reverse();

/** Signed area of a loop of fitted pieces (arcs and splines by their samples). */
export function loopArea(loop: Seg[]): number {
  const pts: V2[] = [];
  for (const s of loop) pts.push(...segPoints(s, 16).slice(0, -1));
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - p[1] * q[0]; }
  return a / 2;
}

/** Points along a piece, ends included (a circle starts and ends at angle 0). */
export function segPoints(s: Seg, n: number): V2[] {
  if (s.kind === "line") return [s.a, s.b];
  if (s.kind === "circle") return Array.from({ length: n + 1 }, (_x, i) => [s.c[0] + s.r * Math.cos(2 * Math.PI * i / n), s.c[1] + s.r * Math.sin(2 * Math.PI * i / n)] as V2);
  if (s.kind === "arc") {
    const t0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
    let sw = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]) - t0;
    if (s.ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
    return Array.from({ length: n + 1 }, (_x, i) => i === 0 ? s.a : i === n ? s.b : [s.c[0] + s.r * Math.cos(t0 + sw * i / n), s.c[1] + s.r * Math.sin(t0 + sw * i / n)] as V2);
  }
  if (s.kind === "spline") {
    const out: V2[] = [s.bz[0]];
    for (let k = 0; k + 3 < s.bz.length; k += 3) {
      const [p0, p1, p2, p3] = s.bz.slice(k, k + 4);
      const m = Math.max(2, Math.ceil(n / ((s.bz.length - 1) / 3)));
      for (let i = 1; i <= m; i++) {
        const t = i / m, u = 1 - t;
        out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
    }
    return out;
  }
  return [];
}

/**
 * Rational quadratic Bézier pieces (poles, weights) of an arc or circle, at most a quarter turn each: an affine map
 * of the poles (unrolling onto a cylinder's (angle, height) parameters) keeps them exact.
 */
export function arcRationals(s: Seg): { poles: V2[]; w: number[] }[] {
  if (s.kind !== "arc" && s.kind !== "circle") return [];
  const t0 = s.kind === "circle" ? 0 : Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
  let sw = 2 * Math.PI;
  if (s.kind === "arc") {
    sw = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]) - t0;
    if (s.ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
  }
  const k = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 2) - 1e-9)), h = sw / k / 2;
  const P = (t: number): V2 => [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
  const out: { poles: V2[]; w: number[] }[] = [];
  for (let i = 0; i < k; i++) {
    const a = t0 + 2 * h * i, m = a + h, rr = s.r / Math.cos(h);
    const p0 = i === 0 && s.kind === "arc" ? s.a : P(a), p2 = i === k - 1 && s.kind === "arc" ? s.b : P(a + 2 * h);
    out.push({ poles: [p0, [s.c[0] + rr * Math.cos(m), s.c[1] + rr * Math.sin(m)], p2], w: [1, Math.cos(h), 1] });
  }
  return out;
}

/**
 * Runs of short straight edges (a cut-out whose curve reached the flat pattern as facets) put back as one line, arc
 * or smooth curve each, so a DXF has an arc where the part has one (sheet metal exam #16: 6,912 lines under 0.5 mm).
 * Only chains through points where exactly two edges meet are joined.
 */
export function joinShort(edges: FlatEdge[], short = 0.5, tol = 2e-3): FlatEdge[] {
  const key = (p: V2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const isShort = (e: FlatEdge) => e.kind === "line" && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < short;
  const at = new Map<string, number[]>();
  edges.forEach((e, i) => { if (e.kind !== "line") return; for (const p of [e.a, e.b]) { const k = key(p); const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); } });
  const used = new Set<number>(), out: FlatEdge[] = [];
  const other = (i: number, k: string) => { const l = at.get(k)!; return l.length === 2 ? l[0] === i ? l[1] : l[0] : -1; };
  edges.forEach((e, i) => {
    if (used.has(i)) return;
    if (!isShort(e) || e.kind !== "line") { out.push(e); return; }
    used.add(i);
    // Walk both ways from this edge over short lines.
    const pts: V2[] = [e.a, e.b];
    for (const dir of [1, -1] as const) {
      let cur = i, end = dir > 0 ? e.b : e.a;
      for (;;) {
        const j = other(cur, key(end));
        if (j < 0 || used.has(j) || !isShort(edges[j])) break;
        const n = edges[j] as Extract<FlatEdge, { kind: "line" }>;
        const next = key(n.a) === key(end) ? n.b : n.a;
        used.add(j);
        if (dir > 0) pts.push(next); else pts.unshift(next);
        cur = j; end = next;
      }
    }
    if (pts.length < 4) { for (let k = 1; k < pts.length; k++) out.push({ kind: "line", a: pts[k - 1], b: pts[k] }); return; }
    const closed = key(pts[0]) === key(pts[pts.length - 1]);
    // A closed run is split in two, so each half has distinct ends.
    const runs = closed ? [pts.slice(0, Math.ceil(pts.length / 2)), pts.slice(Math.ceil(pts.length / 2) - 1)] : [pts];
    const fitted = runs.map(r => fitSeg(r, tol));
    if (closed && fitted.every(f => f.kind === "arc") && fitted.every(f => f.kind === "arc" && Math.hypot(f.c[0] - (fitted[0] as typeof f).c[0], f.c[1] - (fitted[0] as typeof f).c[1]) < tol && Math.abs(f.r - (fitted[0] as typeof f).r) < tol)) {
      const f0 = fitted[0] as Extract<Seg, { kind: "arc" }>;
      out.push({ kind: "circle", c: f0.c, r: f0.r });
      return;
    }
    fitted.forEach((f, k) => {
      if (f.kind === "line") out.push({ kind: "line", a: f.a, b: f.b });
      else if (f.kind === "arc") {
        const [p, q] = f.ccw ? [f.a, f.b] : [f.b, f.a];
        out.push({ kind: "arc", c: f.c, r: f.r, a0: Math.atan2(p[1] - f.c[1], p[0] - f.c[0]), a1: Math.atan2(q[1] - f.c[1], q[0] - f.c[0]) });
      } else out.push({ kind: "poly", pts: runs[k] });
    });
  });
  return out;
}
