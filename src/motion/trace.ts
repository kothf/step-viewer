// Trace paths (FR-FT-122): SolidWorks' motion study Results → Trace Path / Plot. A point picked on a component is
// followed through the solved frames; its path is drawn in the view and its position, distance from the start,
// speed, acceleration and the component's angle and angular speed are plotted under the timeline and saved as CSV. Pure functions: the manager supplies the frames.
import { applyPoint, compose, invert } from "../asm/math";
import type { Tf } from "../asm/types";
import { placeGeo, type Geo } from "../asm/solver";
import type { V3 } from "../model/types";

/** What a trace plots against time. */
export type TracePlot = "dist" | "speed" | "accel" | "x" | "y" | "z" | "angle" | "aspeed";
export const TRACE_PLOTS: [TracePlot, string][] = [["dist", "Distance from start"], ["speed", "Speed"], ["accel", "Acceleration"], ["x", "X"], ["y", "Y"], ["z", "Z"],
  ["angle", "Component angle"], ["aspeed", "Angular speed"]];
/** The unit each plot is in (translated by the caller). */
export function plotUnit(q: TracePlot): string {
  return q === "speed" ? "mm/s" : q === "accel" ? "mm/s²" : q === "angle" ? "°" : q === "aspeed" ? "°/s" : "mm";
}
/** What a mate value result plots: the distance or angle between the mate's references and their rates. */
export const MATE_PLOTS: [TracePlot, string][] = [["dist", "Distance"], ["speed", "Rate of distance"], ["angle", "Angle"], ["aspeed", "Angular speed"]];

/** Path colours, picked in turn for new traces. */
export const TRACE_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00"];

/** The point `p` (in component `comp`'s own coordinates) in world coordinates in every frame; a frame without the component repeats the last point. */
export function tracePoints(frames: Record<string, Tf>[], comp: string, p: V3): V3[] {
  const out: V3[] = [];
  for (const f of frames) {
    const tf = f[comp];
    if (tf) out.push(applyPoint(tf, p));
    else if (out.length) out.push(out[out.length - 1]);
  }
  return out;
}

/**
 * The frames seen from component `rel` (SolidWorks' trace path "relative to" a component): every transform
 * re-expressed in `rel`'s own coordinates. A frame without `rel` keeps the last one it had (or stays in world).
 */
export function relativeFrames(frames: Record<string, Tf>[], rel: string): Record<string, Tf>[] {
  let last: Tf | undefined;
  return frames.map(f => {
    const r = f[rel] ?? last;
    if (!r) return f;
    last = r;
    const inv = invert(r), out: Record<string, Tf> = {};
    for (const [k, t] of Object.entries(f)) out[k] = compose(inv, t);
    return out;
  });
}

/** Speed (mm/s) at each sample: central differences inside, one-sided at the ends. */
export function speeds(pts: V3[], fps: number): number[] {
  const d = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return pts.map((p, i) => {
    if (pts.length < 2) return 0;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const n = Math.min(pts.length - 1, i + 1) - Math.max(0, i - 1);
    return (d(a, b) * fps) / n;
  });
}

/** Acceleration (mm/s²) at each sample: the size of the second difference, the ends taking their neighbour's value. */
export function accels(pts: V3[], fps: number): number[] {
  const n = pts.length;
  if (n < 3) return pts.map(() => 0);
  const a = pts.map((p, i) => {
    const k = Math.min(n - 2, Math.max(1, i)), u = pts[k - 1], v = pts[k], w = pts[k + 1];
    return Math.hypot(w[0] - 2 * v[0] + u[0], w[1] - 2 * v[1] + u[1], w[2] - 2 * v[2] + u[2]) * fps * fps;
  });
  return a;
}

/** The rotation part of `t` as a unit quaternion [w, x, y, z]. */
function quat(t: Tf): [number, number, number, number] {
  const m00 = t[0], m01 = t[1], m02 = t[2], m10 = t[4], m11 = t[5], m12 = t[6], m20 = t[8], m21 = t[9], m22 = t[10], tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4]; }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * How far component `comp` has turned (degrees) in every frame since the first one, signed about the axis it turns
 * most about (the axis of its largest turn) and unwrapped, so a crank going round keeps counting: 360, 720, ….
 * A frame without the component repeats the last angle.
 */
export function traceAngles(frames: Record<string, Tf>[], comp: string): number[] {
  const tfs: (Tf | undefined)[] = frames.map(f => f[comp]), t0 = tfs.find(Boolean);
  if (!t0) return frames.map(() => 0);
  // Relative rotation R_k R_0ᵀ as a quaternion (w, v): angle 2·acos|w|, axis v/|v|.
  const r0: Tf = [t0[0], t0[4], t0[8], 0, t0[1], t0[5], t0[9], 0, t0[2], t0[6], t0[10], 0];
  const rel = tfs.map(t => (t ? quat(compose(t, r0)) : null));
  let axis: V3 = [0, 0, 1], best = 1e-9;
  for (const q of rel) {
    if (!q) continue;
    const s = Math.hypot(q[1], q[2], q[3]);
    if (s > best) { best = s; const g = q[0] < 0 ? -1 : 1; axis = [g * q[1] / s, g * q[2] / s, g * q[3] / s]; }
  }
  const out: number[] = [];
  let last = 0;
  for (const q of rel) {
    if (!q) { out.push(out.length ? out[out.length - 1] : 0); continue; }
    let a = 2 * Math.atan2(q[1] * axis[0] + q[2] * axis[1] + q[3] * axis[2], q[0]) * 180 / Math.PI;
    a += 360 * Math.round((last - a) / 360);
    out.push(a);
    last = a;
  }
  return out;
}

const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/**
 * The distance (mm) and angle (degrees) between a mate's references `ga`/`gb` (in their parts' coordinates) in every
 * frame. Distance: two planes = signed along a's normal, two axes = between the lines, a plane and an axis = the axis
 * point's signed height over the plane. Angle: between the two directions, signed about the axis they turn most about
 * and unwrapped, so a crank keeps counting past 180°. A frame without either component repeats the last values.
 */
export function mateMeasures(frames: Record<string, Tf>[], a: string, b: string, ga: Geo, gb: Geo): { dist: number[]; angle: number[] } {
  const raw: { d: number; u: V3; v: V3 }[] = [];
  for (const f of frames) {
    const ta = f[a], tb = f[b];
    if (!ta || !tb) { if (raw.length) raw.push(raw[raw.length - 1]); continue; }
    const A = placeGeo(ga, ta), B = placeGeo(gb, tb);
    const u = A.k === "plane" ? A.n : A.d, v = B.k === "plane" ? B.n : B.d;
    let d: number;
    if (A.k === "plane" && B.k === "plane") d = vdot(A.n, vsub(B.p, A.p));
    else if (A.k === "axis" && B.k === "axis") {
      const c = vcross(A.d, B.d), w = vsub(B.p, A.p);
      d = vlen(c) < 1e-9 ? vlen(vcross(w, A.d)) : Math.abs(vdot(w, c)) / vlen(c);
    } else { const pl = (A.k === "plane" ? A : B) as Geo & { k: "plane" }, ax = (A.k === "axis" ? A : B) as Geo & { k: "axis" }; d = vdot(pl.n, vsub(ax.p, pl.p)); }
    raw.push({ d, u, v });
  }
  let axis: V3 = [0, 0, 1], best = 1e-9;
  for (const r of raw) { const c = vcross(r.u, r.v), l = vlen(c); if (l > best) { best = l; axis = [c[0] / l, c[1] / l, c[2] / l]; } }
  const angle: number[] = [];
  let last = 0;
  for (const r of raw) {
    let x = Math.atan2(vdot(vcross(r.u, r.v), axis), vdot(r.u, r.v)) * 180 / Math.PI;
    if (angle.length) x += 360 * Math.round((last - x) / 360);
    angle.push(x);
    last = x;
  }
  return { dist: raw.map(r => r.d), angle };
}

/** One row per frame of a mate value result: time, distance and angle (English headers, as every export). */
export function mateCsv(dist: number[], angle: number[], fps: number): string {
  return ["t (s),distance (mm),angle (deg)", ...dist.map((d, i) => [r4(i / fps), r4(d), r4(angle[i] ?? 0)].join(","))].join("\n") + "\n";
}

/** What a proximity result can plot. */
export const GAP_PLOTS: [TracePlot, string][] = [["dist", "Distance"], ["speed", "Rate of distance"]];

/** One row per frame of a proximity result: time and the smallest distance (English headers, as every export). */
export function gapCsv(dist: number[], fps: number): string {
  return ["t (s),distance (mm)", ...dist.map((d, i) => [r4(i / fps), r4(d)].join(","))].join("\n") + "\n";
}

/** Rate of change (per second) of `v` at each sample: central differences inside, one-sided at the ends. */
export function rates(v: number[], fps: number): number[] {
  return v.map((_, i) => {
    if (v.length < 2) return 0;
    const a = Math.max(0, i - 1), b = Math.min(v.length - 1, i + 1);
    return ((v[b] - v[a]) * fps) / (b - a);
  });
}

/** The plotted quantity at each sample (mm, mm/s, mm/s², ° or °/s); the angle plots need the component's `angles`. */
export function traceSeries(pts: V3[], fps: number, q: TracePlot, angles: number[] = []): number[] {
  if (q === "speed") return speeds(pts, fps);
  if (q === "accel") return accels(pts, fps);
  if (q === "angle") return angles;
  if (q === "aspeed") return rates(angles, fps);
  if (q === "x" || q === "y" || q === "z") { const k = q === "x" ? 0 : q === "y" ? 1 : 2; return pts.map(p => p[k]); }
  const p0 = pts[0];
  return pts.map(p => (p0 ? Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]) : 0));
}

/** A result sensor's limits on the plotted quantity: frames below `min` or above `max` are out of range. */
export interface Limits { min?: number; max?: number }

/** Whether each sample lies outside the limits (an unset limit never trips). */
export function outOfRange(v: number[], l: Limits): boolean[] {
  return v.map(x => (l.min !== undefined && x < l.min) || (l.max !== undefined && x > l.max));
}

/** Runs of out-of-range frames as [first, last] times (s). */
export function alertSpans(v: number[], fps: number, l: Limits): [number, number][] {
  const o = outOfRange(v, l), out: [number, number][] = [];
  for (let i = 0; i < o.length; i++) {
    if (!o[i]) continue;
    let j = i;
    while (j + 1 < o.length && o[j + 1]) j++;
    out.push([i / fps, j / fps]);
    i = j;
  }
  return out;
}

/** The first frame in (from, to] where the value goes out of range (it was in range the frame before), or -1. */
export function tripFrame(v: number[], l: Limits, from: number, to: number): number {
  const o = outOfRange(v, l);
  for (let i = Math.max(1, from + 1); i <= Math.min(to, o.length - 1); i++) if (o[i] && !o[i - 1]) return i;
  return -1;
}

/** Length of the path (mm). */
export function pathLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return s;
}

const r4 = (v: number) => String(Math.round(v * 1e4) / 1e4);

/** One row per frame: time, position, speed and acceleration, then the component's angle when given (English headers, as every export). */
export function traceCsv(pts: V3[], fps: number, angles?: number[]): string {
  const sp = speeds(pts, fps), ac = accels(pts, fps), an = angles?.length === pts.length ? angles : null;
  const head = "t (s),x (mm),y (mm),z (mm),speed (mm/s),accel (mm/s^2)" + (an ? ",angle (deg)" : "");
  return [head, ...pts.map((p, i) => [r4(i / fps), r4(p[0]), r4(p[1]), r4(p[2]), r4(sp[i]), r4(ac[i]), ...(an ? [r4(an[i])] : [])].join(","))].join("\n") + "\n";
}

/** A rounded step for axis labels: 1, 2 or 5 × 10ⁿ. */
function nice(span: number): number {
  const e = 10 ** Math.floor(Math.log10(Math.max(1e-9, span))), m = span / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

/**
 * An inline SVG plot of `values` (one per frame) over the study, with the playhead at `time`.
 * `unit` goes on the value axis. Sized by the CSS; drawn in a 300 × 100 view box.
 */
export function plotSvg(values: number[], fps: number, time: number, unit: string, color: string, label: string): string {
  const W = 300, H = 100, L = 34, R = 4, T = 6, B = 16;
  const n = values.length, dur = Math.max(1e-9, (n - 1) / fps);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const step = nice((hi - lo) / 3);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (tq: number) => L + ((W - L - R) * tq) / dur, y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const pts = values.map((v, i) => `${x(i / fps).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="mo-pg" /><text x="${L - 3}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="mo-pt">${Math.round(v * 100) / 100}</text>`;
  const tstep = nice(dur / 4);
  for (let tq = 0; tq <= dur + 1e-9; tq += tstep) grid += `<text x="${x(tq).toFixed(1)}" y="${H - 3}" text-anchor="middle" class="mo-pt">${Math.round(tq * 100) / 100}</text>`;
  const hx = x(Math.max(0, Math.min(dur, time))).toFixed(1);
  return `<svg class="mo-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}"><text x="2" y="10" class="mo-pt">${unit}</text>${grid}`
    + `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" />`
    + `<line x1="${hx}" x2="${hx}" y1="${T}" y2="${H - B}" class="mo-ph" /></svg>`;
}
