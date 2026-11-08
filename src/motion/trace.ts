// Trace paths (FR-FT-122): SolidWorks' motion study Results → Trace Path. A point picked on a component is
// followed through the solved frames; its path is drawn in the view and its position, distance from the start
// and speed are plotted under the timeline and saved as CSV. Pure functions: the manager supplies the frames.
import { applyPoint } from "../asm/math";
import type { Tf } from "../asm/types";
import type { V3 } from "../model/types";

/** What a trace plots against time. */
export type TracePlot = "dist" | "speed" | "x" | "y" | "z";
export const TRACE_PLOTS: [TracePlot, string][] = [["dist", "Distance from start"], ["speed", "Speed"], ["x", "X"], ["y", "Y"], ["z", "Z"]];
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

/** The plotted quantity at each sample (mm, or mm/s for speed). */
export function traceSeries(pts: V3[], fps: number, q: TracePlot): number[] {
  if (q === "speed") return speeds(pts, fps);
  if (q === "x" || q === "y" || q === "z") { const k = q === "x" ? 0 : q === "y" ? 1 : 2; return pts.map(p => p[k]); }
  const p0 = pts[0];
  return pts.map(p => (p0 ? Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]) : 0));
}

/** Length of the path (mm). */
export function pathLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return s;
}

const r4 = (v: number) => String(Math.round(v * 1e4) / 1e4);

/** One row per frame: time, position and speed (English headers, as every export). */
export function traceCsv(pts: V3[], fps: number): string {
  const sp = speeds(pts, fps);
  return ["t (s),x (mm),y (mm),z (mm),speed (mm/s)", ...pts.map((p, i) => [r4(i / fps), r4(p[0]), r4(p[1]), r4(p[2]), r4(sp[i])].join(","))].join("\n") + "\n";
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
