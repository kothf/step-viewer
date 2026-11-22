/**
 * Conductivity that changes with temperature (FRS-thermal FR-TMAT-004): a table of rows [°C, W/(m·K)], linear
 * between the rows and held at the end values outside them. The solver takes it as factors on the body's k.
 */
export type KTable = [number, number][];

/** Most rows a table may have. */
export const KT_ROWS = 40;

/** Rows from text, one per line ("20 200", "20, 200" or "20;200" lines): null when a row is not two numbers, the temperatures do not rise, or a k is not positive. */
export function parseKTable(text: string): KTable | null {
  const rows: KTable = [];
  for (const line of text.split(/\n+/)) {
    const s = line.trim();
    if (!s) continue;
    const m = s.split(/[\s,;\t]+/).map(Number);
    if (m.length !== 2 || !m.every(Number.isFinite) || m[0] < -273.15 || !(m[1] > 0)) return null;
    if (rows.length && !(m[0] > rows[rows.length - 1][0])) return null;
    rows.push([m[0], m[1]]);
  }
  return rows.length && rows.length <= KT_ROWS ? rows : null;
}

export const kTableText = (rows: KTable) => rows.map(r => `${+r[0].toPrecision(6)} ${+r[1].toPrecision(6)}`).join("\n");

/** The table as the solver's factors on `k` W/(m·K): [°C, factor, …]. */
export function ktFactors(rows: KTable, k: number): number[] {
  return rows.flatMap(r => [r[0], r[1] / k]);
}

/** k at a temperature, W/(m·K). */
export function kAt(rows: KTable, t: number): number {
  if (!rows.length) return NaN;
  if (t <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) if (t <= rows[i][0]) { const [t0, k0] = rows[i - 1], [t1, k1] = rows[i]; return k0 + ((t - t0) / (t1 - t0)) * (k1 - k0); }
  return rows[rows.length - 1][1];
}
