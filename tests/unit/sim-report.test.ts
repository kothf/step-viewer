import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import { chartGeo, chartSvg, reportHtml, reportPdf, type SimReport } from "../../src/sim/report";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const REP: SimReport = {
  title: "Отчёт о прочностном расчёте",
  sub: "Bracket · Static 1 · MöbiusCAD 1.611.0",
  blocks: [
    { kind: "h", text: "Study" },
    { kind: "table", rows: [["Property", "Value"], ["Max von Mises stress", "75 MPa"], ["<b>", "a & b"]], widths: [2, 3] },
    { kind: "image", src: PNG, w: 800, h: 500, caption: "von Mises stress: 0 … 75 MPa" },
    { kind: "chart", errs: [9.86, 5.35, 2.9], label: "Estimated error per pass" },
    { kind: "p", text: "Linear elastic analysis with small displacements.", muted: true },
    ...Array.from({ length: 70 }, (_, i) => ({ kind: "p" as const, text: `Line ${i}: ${"word ".repeat(30)}` })),
  ],
};

test("report chart: log scale over whole decades, one point per pass, the last one marked", () => {
  const g = chartGeo([9.86, 5.35, 2.9])!;
  assert.equal(g.pts.length, 3);
  assert.deepEqual(g.grid.map(l => l.label), ["1 %", "10 %"]);
  assert.ok(g.pts[0].y < g.pts[1].y && g.pts[1].y < g.pts[2].y, "a falling error goes down the chart");
  assert.ok(g.pts[2].last && !g.pts[0].last);
  assert.equal(chartGeo([5, null]), null);
  assert.equal(chartSvg([5, null], "x"), "");
  // a pass without a value is skipped, the others keep their place
  const h = chartGeo([8, null, 2])!;
  assert.equal(h.pts.length, 2);
  assert.equal(h.pts[1].x, h.ticks[2].x);
});

test("report HTML: self-contained page, text escaped, tables, picture and chart in", () => {
  const html = reportHtml(REP, "ru");
  assert.ok(html.startsWith("<!doctype html><html lang=\"ru\">"));
  assert.ok(html.includes("<h1>Отчёт о прочностном расчёте</h1>"));
  assert.ok(html.includes("<td>&lt;b&gt;</td><td>a &amp; b</td>"));
  assert.ok(html.includes(`<img src="${PNG}"`) && html.includes("<svg class=\"sim-conv\""));
  assert.ok(!/<script|src="http|href="http/.test(html), "nothing loaded from outside");
});

test("report PDF: A4 pages with the embedded font, long reports break onto more pages", async () => {
  const font = readFileSync("node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf").toString("base64");
  const blob = reportPdf(jsPDF, REP, font);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const text = bytes.toString("latin1");
  const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 2, `pages ${pages}`);
  assert.ok(/DejaVu/.test(text) && /\/Subtype \/Image/.test(text));
});
