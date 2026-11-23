// CSV exports of thermal results (FR-TREP-011): the map's Parts list and a study's heat balance.
// Pure; headers and texts stay English like every other CSV export.

import { partMargin, partTemp, type PartStat, type ThermalPart } from "./package";

/** Rows to CSV text: cells quoted when they hold a comma, quote or line break, CRLF line ends. */
export function csvText(rows: (string | number | null | undefined)[][]): string {
  const cell = (c: string | number | null | undefined) => {
    const s = c === null || c === undefined || (typeof c === "number" && !Number.isFinite(c)) ? "" : String(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const r2 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(+v.toFixed(2)));
const r4 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(+v.toPrecision(6)));

export const PARTS_HEAD = ["Designator", "Part", "Power (W)", "Highest temperature (°C)", "Lowest temperature (°C)", "Limit (°C)", "Margin (K)", "Life (h)", "Heat path", "Status"];

/** The Parts list of a map, in the order given (the table's sort), one row per part. */
export function partsCsv(parts: ThermalPart[], stats: Map<number, PartStat>, opts: { missing?: Iterable<number>; changed?: Iterable<number> } = {}): string {
  const miss = new Set(opts.missing ?? []), chg = new Set(opts.changed ?? []);
  return csvText([PARTS_HEAD, ...parts.map(p => {
    const mg = partMargin(p, stats);
    const status = [mg !== undefined && mg < 0 ? "over limit" : "", miss.has(p.id) ? "not in the model" : "", chg.has(p.id) ? "changed" : ""].filter(Boolean).join("; ");
    return [p.designator, p.part, r4(p.p), r2(partTemp(p, stats)), r2(stats.get(p.id)?.min), r2(p.limit), r2(mg), p.life === undefined ? "" : String(Math.round(p.life)), p.path ?? "", status];
  })]);
}

export interface BalanceInput {
  /** Heat put in, W. */
  applied: number;
  /** Each cooling item: its name and what leaves through it (W/mm² film coefficient when known). */
  flows: { name: string; out: number; area: number; mean: number; h?: number }[];
  /** Radiation between face sets: heat from the first to the second. */
  exchanges?: { name: string; heat: number; ta: number; tb: number }[];
  /** Contacts between bodies: heat from a to b. */
  contacts?: { a: string; b: string; heat: number; area: number; ta: number; tb: number }[];
  /** Components or bodies: heat made in each, temperatures. */
  comps?: { name: string; power: number; min: number; max: number; mean: number }[];
}

export const BALANCE_HEAD = ["Kind", "Item", "Heat (W)", "Mean temperature (°C)", "Highest temperature (°C)", "Area (mm²)", "Film coefficient (W/(m²·K))"];

/** A steady thermal result's heat balance: what goes in, what each cooling item takes away, the balance, then what passes inside. */
export function balanceCsv(b: BalanceInput): string {
  const out = b.flows.reduce((s, f) => s + f.out, 0);
  const size = Math.max(Math.abs(b.applied), b.flows.reduce((s, f) => s + Math.abs(f.out), 0) / 2);
  const rows: (string | number)[][] = [BALANCE_HEAD, ["Heat put in", "Total", r4(b.applied), "", "", "", ""]];
  for (const f of b.flows) rows.push(["Heat taken away", f.name, r4(f.out), r2(f.mean), "", r4(f.area), f.h === undefined ? "" : r4(f.h * 1e6)]);
  rows.push(["Heat taken away", "Total", r4(out), "", "", "", ""]);
  rows.push(["Out of balance (%)", "", size > 0 ? r4(100 * Math.abs(out - b.applied) / size) : "", "", "", "", ""]);
  for (const x of b.exchanges ?? []) rows.push(["Radiation between faces", x.name, r4(x.heat), Number.isFinite(x.ta) ? `${r2(x.ta)} -> ${r2(x.tb)}` : "", "", "", ""]);
  for (const c of b.contacts ?? []) rows.push(["Contact", `${c.a} -> ${c.b}`, r4(c.heat), `${r2(c.ta)} -> ${r2(c.tb)}`, "", r4(c.area), ""]);
  for (const c of b.comps ?? []) rows.push(["Component", c.name, r4(c.power), r2(c.mean), r2(c.max), "", ""]);
  return csvText(rows);
}
