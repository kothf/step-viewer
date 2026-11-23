// Report of a thermal map from a package (FR-TREP-001): its blocks, the statement on where the values come from,
// and the HTML page it makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapReport, type MapReportData } from "../../src/thermal/report";
import { reportHtml } from "../../src/sim/report";

const tr = (s: string, p?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? `{${k}}`));
const base: MapReportData = {
  design: "Amp", source: "Tube Amp CAD 3.24, 2026-11-21", settings: "ambient 40 °C · closed enclosure", accuracy: "±15 °C", own: false,
  matched: [7, 7], summary: [["Hottest part", "V3 223 °C"], ["Parts over their limit", "1"]],
  pictures: [{ src: "data:image/png;base64,AA==", w: 10, h: 8, caption: "From above" }, { src: "data:image/png;base64,AA==", w: 10, h: 8, caption: "From below" }],
  problems: ["R20: 201 °C over its limit of 155 °C"],
  parts: [{ name: "R20", value: "10 W", p: "8", t: "201", limit: "155", margin: "-46", life: "", over: true }, { name: "C12", value: "100u", p: "0.1", t: "68", limit: "105", margin: "37", life: "19 000", over: false }],
  budget: [["Total power", "29.2"], ["To the board", "10"]], probes: [["1.0", "2.0", "3.0", "R20", "190"]], compare: null, stamp: "MöbiusCAD 1.697.0",
};

test("a map report says where the values come from and holds every section", () => {
  const r = mapReport(base, tr);
  assert.equal(r.title, "Thermal map: Amp");
  const heads = r.blocks.filter(b => b.kind === "h").map(b => (b as { text: string }).text);
  assert.deepEqual(heads, ["Source", "Summary", "Problems", "Parts", "Heat budget", "Probes", "Assumptions and accuracy"]);
  const text = r.blocks.map(b => ("text" in b ? b.text : "")).join("\n");
  assert.match(text, /written by Tube Amp CAD 3\.24, 2026-11-21; MöbiusCAD shows them and did not compute them/);
  assert.match(text, /accuracy at ±15 °C/);
  assert.match(text, /7 of 7 parts matched/);
  assert.equal(r.blocks.filter(b => b.kind === "image").length, 2);
  const parts = r.blocks.find(b => b.kind === "table" && b.rows[0][0] === "Part") as { rows: string[][] };
  assert.equal(parts.rows.length, 3);
  assert.equal(parts.rows[1][7], "over");
  assert.equal(parts.rows[2][7], "");
  const html = reportHtml(r);
  for (const s of ["R20", "C12", "From below", "Heat budget"]) assert.ok(html.includes(s), s);
});

test("a map with no problems, no accuracy, its own mesh and a comparison", () => {
  const r = mapReport({ ...base, source: "", accuracy: "", own: true, problems: [], probes: [], compare: { a: "Amp", b: "Amp vented", rows: [["R20", "201", "180", "−21"]] } }, tr);
  const heads = r.blocks.filter(b => b.kind === "h").map(b => (b as { text: string }).text);
  assert.ok(heads.includes("Compare") && !heads.includes("Probes"));
  const text = r.blocks.map(b => ("text" in b ? b.text : "")).join("\n");
  assert.match(text, /No part is over its limit/);
  assert.match(text, /no accuracy estimate/);
  assert.match(text, /package's own surfaces/);
  assert.match(text, /^The temperatures come from the thermal package; /m);
});
