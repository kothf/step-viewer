// Structural analysis: results along a straight path between two points (FR-RES-031). Pure: the points, the
// chart and the CSV. The values come from the solver's kept solution, or from the plot's surface.

export const PATH_POINTS = 101;

/** `n` points from a to b, ends included (x, y, z each). */
export function pathPoints(a: ArrayLike<number>, b: ArrayLike<number>, n = PATH_POINTS): Float32Array {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    for (let c = 0; c < 3; c++) out[3 * i + c] = a[c] + t * (b[c] - a[c]);
  }
  return out;
}

export const pathLength = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

export interface PathRow { d: number; at: [number, number, number]; vm: number; u: [number, number, number]; ok: boolean }

/** One row per point: distance from the start, place, stress, displacement; `ok` false where the point is outside the part. */
export function pathRows(pos: ArrayLike<number>, vm: ArrayLike<number>, u: ArrayLike<number>, ok: ArrayLike<number>): PathRow[] {
  const n = pos.length / 3, rows: PathRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      d: Math.hypot(pos[3 * i] - pos[0], pos[3 * i + 1] - pos[1], pos[3 * i + 2] - pos[2]),
      at: [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], vm: vm[i], u: [u[3 * i], u[3 * i + 1], u[3 * i + 2]], ok: !!ok[i],
    });
  }
  return rows;
}

const num = (v: number) => String(Number(v.toPrecision(7)));

/** Distance and place in mm, stress in MPa, displacement in mm; points outside the part have no values. */
export function pathCsv(rows: PathRow[], thermal = false): string {
  // a thermal result keeps the temperature in `vm` and the heat flux, W/mm², in `u`
  const head = thermal ? "Distance (mm),X (mm),Y (mm),Z (mm),Temperature (°C),QX (W/m²),QY (W/m²),QZ (W/m²),Heat flux (W/m²)" : "Distance (mm),X (mm),Y (mm),Z (mm),von Mises stress (MPa),UX (mm),UY (mm),UZ (mm),Displacement (mm)";
  const f = thermal ? 1e6 : 1;
  return [head, ...rows.map(r => [num(r.d), ...r.at.map(num), ...(r.ok ? [num(r.vm), ...r.u.map(x => num(x * f)), num(Math.hypot(...r.u) * f)] : ["", "", "", "", ""])].join(","))].join("\r\n") + "\r\n";
}

export interface PathChart {
  W: number; H: number; x0: number; x1: number; y0: number; y1: number;
  /** Runs of points inside the part, as polylines. */
  lines: [number, number][][];
  lo: number; hi: number; length: number;
}

/** A linear chart of the values against the distance along the path; breaks where the path leaves the part. */
export function pathChart(d: ArrayLike<number>, v: ArrayLike<number>, ok: ArrayLike<number>, W = 220, H = 80): PathChart | null {
  const n = d.length;
  let lo = Infinity, hi = -Infinity, any = 0;
  for (let i = 0; i < n; i++) if (ok[i]) { any++; if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const length = n ? d[n - 1] : 0;
  if (any < 2 || !(length > 0)) return null;
  if (lo > 0 && lo < 0.5 * hi) lo = 0;
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) { hi += 1; lo -= lo > 0 ? Math.min(lo, 1) : 1; }
  const L = 34, R = 8, T = 8, B = 16;
  const X = (x: number) => L + ((W - L - R) * x) / length, Y = (y: number) => T + ((H - T - B) * (hi - y)) / (hi - lo);
  const lines: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (ok[i]) run.push([X(d[i]), Y(v[i])]);
    else if (run.length) { lines.push(run); run = []; }
  }
  if (run.length) lines.push(run);
  return { W, H, x0: L, x1: W - R, y0: T, y1: H - B, lines, lo, hi, length };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The chart as SVG; `fmt` writes the axis numbers, `xUnit` follows the path length. */
export function pathChartSvg(c: PathChart, label: string, fmt: (v: number) => string, lengthText: string): string {
  let s = `<svg class="sim-conv sim-pathchart" viewBox="0 0 ${c.W} ${c.H}" role="img" aria-label="${esc(label)}">`;
  for (const [y, v] of [[c.y0, c.hi], [(c.y0 + c.y1) / 2, (c.hi + c.lo) / 2], [c.y1, c.lo]]) s += `<line class="g" x1="${c.x0}" x2="${c.x1}" y1="${y}" y2="${y}"/><text class="a" x="${c.x0 - 4}" y="${y + 3}" text-anchor="end">${esc(fmt(v))}</text>`;
  s += `<text class="a" x="${c.x0}" y="${c.H - 3}" text-anchor="middle">0</text><text class="a" x="${c.x1}" y="${c.H - 3}" text-anchor="end">${esc(lengthText)}</text>`;
  for (const l of c.lines) s += l.length > 1 ? `<polyline points="${l.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}"/>` : `<circle cx="${l[0][0].toFixed(1)}" cy="${l[0][1].toFixed(1)}" r="1.4"/>`;
  return s + `</svg>`;
}
