// Transient thermal studies (FRS-thermal TH4): power profiles and output times. Pure.

/**
 * How a heat load's power changes with time (FR-TLOAD-005), as a share of its power: `step` = off until `at`, s,
 * then on; `duty` = on for `on` s of every `period` s (after `delay` s); `table` = (time s, share) rows, linear
 * between them, the ends held.
 */
export type PowerProfile =
  | { kind: "step"; at?: number }
  | { kind: "duty"; on: number; period: number; delay?: number }
  | { kind: "table"; pts: [number, number][] };

/** A transient study's times (FR-TSOL-006): end and output interval, s; start temperature, °C (absent = ambient). */
export interface TransientSettings { end: number; out: number; t0?: number }

/** The most output times a run keeps (the interval is widened past it). */
export const MAX_FRAMES = 201;

/** The share of the power at time t, s. */
export function profileFactor(p: PowerProfile | undefined, t: number): number {
  if (!p) return 1;
  if (p.kind === "step") return t >= (p.at ?? 0) ? 1 : 0;
  if (p.kind === "duty") {
    const s = t - (p.delay ?? 0);
    if (s < 0 || !(p.period > 0)) return 0;
    return s % p.period < p.on ? 1 : 0;
  }
  const pts = p.pts;
  if (!pts.length) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    if (t <= t1) { const [t0, v0] = pts[i - 1]; return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1; }
  }
  return pts[pts.length - 1][1];
}

/** The longest time step that still sees the profile's changes, s (Infinity = any). */
export function profileStep(p: PowerProfile | undefined): number {
  if (!p) return Infinity;
  if (p.kind === "step") return Infinity;
  if (p.kind === "duty") return Math.max(1e-6, Math.min(p.on, p.period - p.on > 0 ? p.period - p.on : p.on) / 4);
  let d = Infinity;
  for (let i = 1; i < p.pts.length; i++) { const g = p.pts[i][0] - p.pts[i - 1][0]; if (g > 0) d = Math.min(d, g); }
  return d === Infinity ? Infinity : d / 2;
}

/** Times the profile jumps or turns, s (a duty cycle's are left to its short steps). */
export function profileBreaks(p: PowerProfile | undefined): number[] {
  if (!p || p.kind === "duty") return [];
  if (p.kind === "step") return p.at ? [p.at] : [];
  return p.pts.map(r => r[0]);
}

/** The output times: 0, out, 2 out, …, end (at most `MAX_FRAMES`, the interval widened when there would be more). */
export function outputTimes(end: number, out: number): number[] {
  if (!(end > 0)) return [0];
  let dt = out > 0 ? out : end / 50;
  if (end / dt + 1 > MAX_FRAMES) dt = end / (MAX_FRAMES - 1);
  const times: number[] = [];
  // the interval is kept; the end closes the list even when it does not divide evenly
  for (let i = 0; i * dt < end - 1e-9 * end && i < MAX_FRAMES - 1; i++) times.push(i * dt);
  times.push(end);
  return times;
}

/** A profile in words, for the study tree. */
export function profileText(p: PowerProfile | undefined, t: (s: string, v?: Record<string, string | number>) => string): string {
  if (!p) return t("constant");
  if (p.kind === "step") return p.at ? t("on from {s} s", { s: p.at }) : t("constant");
  if (p.kind === "duty") return t("{on} s on every {period} s", { on: p.on, period: p.period });
  return t("table of {n} rows", { n: p.pts.length });
}

/** Reads a table typed as rows of time and share ("0 0", "60 1", …); null when a row cannot be read or times go back. */
export function parseProfile(text: string): [number, number][] | null {
  const rows: [number, number][] = [];
  for (const line of text.split(/[\n;]+/)) {
    const s = line.trim();
    if (!s) continue;
    const m = s.split(/[\s,\t]+/).map(Number);
    if (m.length !== 2 || !m.every(Number.isFinite) || m[0] < 0) return null;
    if (rows.length && m[0] < rows[rows.length - 1][0]) return null;
    rows.push([m[0], m[1]]);
  }
  return rows.length ? rows : null;
}

/** The first time a series reaches a value, s, linear between samples; null when it never does. */
export function timeToReach(times: number[], v: ArrayLike<number>, target: number): number | null {
  if (!times.length) return null;
  const up = target >= v[0];
  if (v[0] === target) return times[0];
  for (let i = 1; i < times.length; i++) {
    const a = v[i - 1], b = v[i];
    if (up ? b >= target && a < target : b <= target && a > target) return times[i - 1] + ((target - a) / (b - a)) * (times[i] - times[i - 1]);
  }
  return null;
}

/** Temperature over time at each probe, as CSV (time s, then °C per probe). */
export function transientCsv(times: number[], cols: { name: string; v: ArrayLike<number> }[]): string {
  const head = ["Time, s", ...cols.map(c => `${c.name}, °C`)].map(s => `"${s}"`).join(",");
  return [head, ...times.map((t, i) => [t, ...cols.map(c => c.v[i])].map(v => String(Number(v.toPrecision(6)))).join(","))].join("\n") + "\n";
}
export const BOARD_RC = 1.85e-6 * 1100;

/** A time for display: seconds, minutes or hours. */
export function timeText(s: number, u: { s: string; min: string; h: string } = { s: "s", min: "min", h: "h" }): string {
  const r = (v: number) => String(Number(v.toPrecision(3)));
  if (Math.abs(s) < 120) return `${r(s)} ${u.s}`;
  if (Math.abs(s) < 7200) return `${r(s / 60)} ${u.min}`;
  return `${r(s / 3600)} ${u.h}`;
}

/** Colours of the lines of a chart over time after the hottest point (red). */
export const SERIES_COLORS = ["#1c64d8", "#2f9e44", "#f08c00", "#9c36b5", "#0c8599", "#5c940d"];

const escXml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A chart of temperatures over time (`svg.sim-tchart`): one polyline per series, the shown time as a line. */
export function timeChartSvg(times: number[], lines: { name: string; v: ArrayLike<number>; color: string }[], at: number, fmt: (s: number) => string = timeText): string {
  if (times.length < 2 || !lines.length) return "";
  const W = 320, H = 150, x0 = 34, x1 = W - 8, y0 = 8, y1 = H - 18, end = times[times.length - 1] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const l of lines) for (let i = 0; i < l.v.length; i++) { lo = Math.min(lo, l.v[i]); hi = Math.max(hi, l.v[i]); }
  if (!(hi > lo)) { hi = lo + 1; }
  const X = (t: number) => x0 + ((x1 - x0) * t) / end, Y = (v: number) => y1 - ((y1 - y0) * (v - lo)) / (hi - lo);
  const f = (v: number) => String(Number(v.toPrecision(3)));
  let s = `<svg class="sim-conv sim-tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escXml(lines.map(l => l.name).join(", "))}">`;
  for (const v of [hi, (hi + lo) / 2, lo]) s += `<line class="g" x1="${x0}" x2="${x1}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="a" x="${x0 - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${f(v)}</text>`;
  s += `<text class="a" x="${x0}" y="${H - 4}" text-anchor="middle">0</text><text class="a" x="${x1}" y="${H - 4}" text-anchor="end">${escXml(fmt(end))}</text>`;
  if (at >= 0 && at < times.length) s += `<line class="now" x1="${X(times[at]).toFixed(1)}" x2="${X(times[at]).toFixed(1)}" y1="${y0}" y2="${y1}"/>`;
  for (const l of lines) s += `<polyline style="stroke:${l.color}" points="${times.map((t, i) => `${X(t).toFixed(1)},${Y(l.v[i]).toFixed(1)}`).join(" ")}"/>`;
  return s + `</svg>`;
}
