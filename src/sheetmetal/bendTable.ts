// Bend tables (FR-FT-120): K-factor, bend allowance or bend deduction by inside radius and bend
// angle, looked up for each bend with linear interpolation. Pure, so the unit tests and the panel
// share it.
import type { BendTable } from "./types";

/** Where x falls in the ascending list xs: the two neighbours and the weight of the second (clamped). */
function bracket(xs: number[], x: number): [number, number, number] {
  if (xs.length === 1 || x <= xs[0]) return [0, 0, 0];
  const n = xs.length - 1;
  if (x >= xs[n]) return [n, n, 0];
  let i = 0;
  while (xs[i + 1] < x) i++;
  return [i, i + 1, (x - xs[i]) / (xs[i + 1] - xs[i])];
}

/** The table's value for an inside radius r (mm) and a bend angle (radians): bilinear, ends held. */
export function tableValue(tb: BendTable, r: number, angle: number): number {
  const deg = angle * 180 / Math.PI;
  const [i0, i1, u] = bracket(tb.radii, r), [j0, j1, w] = bracket(tb.angles, deg);
  const a = tb.v[i0][j0] * (1 - w) + tb.v[i0][j1] * w;
  const b = tb.v[i1][j0] * (1 - w) + tb.v[i1][j1] * w;
  return a * (1 - u) + b * u;
}

/** Why a table can't be used, as an English message (translated where shown), or null. */
export function tableProblem(tb: BendTable | undefined): string | null {
  if (!tb || !tb.radii?.length || !tb.angles?.length) return "The bend table needs at least one radius and one angle.";
  const up = (xs: number[]) => xs.every((x, i) => Number.isFinite(x) && (i === 0 || x > xs[i - 1]));
  if (!up(tb.radii) || !up(tb.angles)) return "Bend table radii and angles must be numbers going up.";
  if (tb.radii[0] < 0 || tb.angles[0] <= 0 || tb.angles[tb.angles.length - 1] > 180) return "Bend table radii can't be negative and angles must be from above 0 to 180°.";
  if (tb.v.length !== tb.radii.length || tb.v.some(row => row.length !== tb.angles.length || row.some(x => !Number.isFinite(x)))) return "Every bend table row needs a value for each angle.";
  if (tb.kind === "k" && tb.v.some(row => row.some(x => x < 0 || x > 1))) return "The K-factor must be between 0 and 1.";
  return null;
}

const num = (s: string) => Number(s.trim().replace(",", "."));

/**
 * Reads a table typed or pasted as text: the first line holds the angles (degrees) after a first
 * cell that is ignored, each further line a radius (mm) then its values. Cells split on tabs,
 * semicolons or runs of spaces; a comma splits too unless the text uses no other separator and
 * looks like decimal commas (then use ; or tabs).
 */
export function parseBendTable(text: string, kind: BendTable["kind"]): BendTable | string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return "The bend table needs at least one radius and one angle.";
  const sep = /[\t;]/.test(text) ? /\s*[\t;]\s*/ : /\s*,\s*|\s+/;
  const rows = lines.map(l => l.split(sep));
  const angles = rows[0].slice(1).map(num);
  const radii: number[] = [], v: number[][] = [];
  for (const r of rows.slice(1)) { radii.push(num(r[0])); v.push(r.slice(1).map(num)); }
  const tb: BendTable = { kind, radii, angles, v };
  return tableProblem(tb) ?? tb;
}

const cell = (x: number) => String(Math.round(x * 1e6) / 1e6);

/** The table as text the parser reads back: a header of angles, then a line per radius. */
export function bendTableText(tb: BendTable): string {
  return [["r \\ °", ...tb.angles.map(cell)], ...tb.radii.map((r, i) => [cell(r), ...tb.v[i].map(cell)])].map(r => r.join("\t")).join("\n");
}

/**
 * A K-factor table after DIN 6935: correction factor k = 0.65 + 0.5·lg(r/T) (1 from r/T = 5 on),
 * K = k/2, for radii from T/2 to 5T and any angle.
 */
export function dinTable(T: number): BendTable {
  const radii = [0.5, 1, 1.5, 2, 3, 4, 5].map(m => Math.round(m * T * 1000) / 1000);
  const K = (r: number) => Math.round(Math.min(1, 0.65 + 0.5 * Math.log10(r / T)) / 2 * 1000) / 1000;
  return { kind: "k", radii, angles: [90], v: radii.map(r => [K(r)]) };
}

/** A starting table for the chosen kind: DIN 6935 K-factors, or allowances/deductions worked out from them. */
export function defaultTable(kind: BendTable["kind"], T: number): BendTable {
  const din = dinTable(T);
  if (kind === "k") return din;
  const angles = [30, 45, 60, 90, 120, 135, 150];
  const v = din.radii.map((r, i) => angles.map(a => {
    const ang = a * Math.PI / 180, ba = ang * (r + din.v[i][0] * T);
    if (kind === "ba") return Math.round(ba * 1000) / 1000;
    const sb = (ang <= Math.PI / 2 + 1e-12 ? Math.tan(ang / 2) : 1) * (r + T);
    return Math.round((2 * sb - ba) * 1000) / 1000;
  }));
  return { kind, radii: din.radii, angles, v };
}
