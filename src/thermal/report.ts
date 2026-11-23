// Report of a thermal map from a package (FRS-thermal FR-TREP-001): the board, where the values come from, the
// summary, pictures of the view (as shown, top, bottom), problems, parts, heat budget, probes and the comparison.
// Pure: the caller gives the texts already formatted and the pictures; `tr` translates the fixed ones. The layout
// (HTML page or PDF) is the structural report's (`sim/report.ts`).
import type { ReportBlock, SimReport } from "../sim/report";

export interface MapPart {
  name: string; value: string; p: string; t: string; limit: string; margin: string; life: string;
  /** Over its limit: the row is marked in the table's last column. */
  over: boolean;
}

export interface MapReportData {
  design: string;
  /** "Tube Amp CAD 3.24, 2026-11-21": the app and date that wrote the package; "" = unknown. */
  source: string;
  /** Settings in words: ambient, enclosure, orientation… joined by " · ". */
  settings: string;
  /** "±15 °C", or "" when the package gives no accuracy. */
  accuracy: string;
  /** The map is shown on its own mesh (no STEP). */
  own: boolean;
  /** Parts found in the model / parts in the package (board included). */
  matched: [number, number];
  /** Rows of the summary: label, value. */
  summary: [string, string][];
  pictures: { src: string; w: number; h: number; caption: string }[];
  problems: string[];
  parts: MapPart[];
  budget: [string, string][];
  /** Probes: X, Y, Z, part, °C. */
  probes: string[][];
  /** Compare rows: part, A, B, Δ; null when no second map is attached. */
  compare: { a: string; b: string; rows: string[][] } | null;
  /** "MöbiusCAD 1.697.0, 2026-11-23 09:14". */
  stamp: string;
}

export function mapReport(d: MapReportData, tr: (s: string, p?: Record<string, string | number>) => string): SimReport {
  const b: ReportBlock[] = [];
  b.push({ kind: "h", text: tr("Source") });
  b.push({ kind: "p", text: d.source ? tr("The temperatures come from the thermal package written by {app}; MöbiusCAD shows them and did not compute them.", { app: d.source }) : tr("The temperatures come from the thermal package; MöbiusCAD shows them and did not compute them.") });
  if (d.settings) b.push({ kind: "p", text: d.settings });
  b.push({ kind: "p", text: d.own ? tr("Shown on the package's own surfaces: no STEP model was open.") : tr("{n} of {m} parts matched", { n: d.matched[0], m: d.matched[1] }), muted: true });
  if (d.summary.length) {
    b.push({ kind: "h", text: tr("Summary") });
    b.push({ kind: "table", rows: [[tr("Item"), tr("Value")], ...d.summary], widths: [3, 2] });
  }
  for (const p of d.pictures) b.push({ kind: "image", ...p });
  b.push({ kind: "h", text: tr("Problems") });
  if (d.problems.length) b.push({ kind: "table", rows: [["#", tr("Problem")], ...d.problems.map((s, i) => [String(i + 1), s])], widths: [1, 12] });
  else b.push({ kind: "p", text: tr("No part is over its limit.") });
  if (d.parts.length) {
    b.push({ kind: "h", text: tr("Parts") });
    b.push({
      kind: "table",
      rows: [[tr("Part"), tr("Value"), "W", "°C", tr("Limit"), tr("Margin"), tr("Life, h"), ""], ...d.parts.map(p => [p.name, p.value, p.p, p.t, p.limit, p.margin, p.life, p.over ? tr("over") : ""])],
      widths: [2, 3, 1.4, 1.4, 1.4, 1.6, 1.6, 1.4],
    });
  }
  if (d.budget.length) {
    b.push({ kind: "h", text: tr("Heat budget") });
    b.push({ kind: "table", rows: [[tr("Path"), "W"], ...d.budget], widths: [3, 2] });
  }
  if (d.probes.length) {
    b.push({ kind: "h", text: tr("Probes") });
    b.push({ kind: "table", rows: [["#", "X, mm", "Y, mm", "Z, mm", tr("Part"), "°C"], ...d.probes.map((r, i) => [String(i + 1), ...r])], widths: [0.8, 1.5, 1.5, 1.5, 2, 1.4] });
  }
  if (d.compare) {
    b.push({ kind: "h", text: tr("Compare") });
    b.push({ kind: "p", text: `A: ${d.compare.a} · B: ${d.compare.b}`, muted: true });
    b.push({ kind: "table", rows: [[tr("Part"), "A, °C", "B, °C", "Δ, K"], ...d.compare.rows], widths: [3, 2, 2, 2] });
  }
  b.push({ kind: "h", text: tr("Assumptions and accuracy") });
  b.push({ kind: "p", text: tr("The values are surface temperatures as the package gives them; a package has no values inside the parts.") });
  b.push({ kind: "p", text: d.accuracy ? tr("The design app estimates its accuracy at {v}.", { v: d.accuracy }) : tr("The package gives no accuracy estimate.") });
  return { title: tr("Thermal map: {name}", { name: d.design }), sub: d.stamp, blocks: b };
}
