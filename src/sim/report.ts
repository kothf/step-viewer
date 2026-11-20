// Structural analysis report (FRS-structural 10.4, FR-REP-001): the study, its set-up and its results as a
// stand-alone HTML page or a PDF. This file only lays a report out; the caller supplies the texts (already in
// the UI language) and the pictures.
import type { jsPDF as JsPDF } from "jspdf";

export type ReportBlock =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string; muted?: boolean }
  /** The first row is the header. `widths` are relative. */
  | { kind: "table"; rows: string[][]; widths?: number[] }
  /** A picture (data URL) with its pixel size and a caption. */
  | { kind: "image"; src: string; w: number; h: number; caption: string }
  /** The convergence chart: estimated error per pass, %. */
  | { kind: "chart"; errs: (number | null)[]; label: string };

export interface SimReport {
  title: string;
  /** One line under the title: document, study, date, version. */
  sub: string;
  blocks: ReportBlock[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const trim = (v: number) => String(Number(v.toPrecision(8)));

export interface ChartGeo {
  W: number; H: number;
  /** Horizontal grid lines at whole decades, with their labels. */
  grid: { y: number; label: string }[];
  /** Pass numbers under the chart. */
  ticks: { x: number; label: string }[];
  /** The points with a value; `last` marks the extrapolated one. */
  pts: { x: number; y: number; last: boolean }[];
  /** Left and right ends of the grid lines. */
  x0: number; x1: number;
}

/** The error estimate per pass on a log scale. Null with fewer than two values. */
export function chartGeo(errs: (number | null)[], W = 220, H = 64): ChartGeo | null {
  const pts = errs.map((e, i) => ({ e, i })).filter((q): q is { e: number; i: number } => q.e != null && q.e > 0);
  if (pts.length < 2) return null;
  const L = 34, R = 8, T = 8, B = 16;
  const lg = pts.map(q => Math.log10(q.e)), hi = Math.ceil(Math.max(...lg)), lo = Math.min(Math.floor(Math.min(...lg)), hi - 1);
  const X = (i: number) => L + ((W - L - R) * i) / Math.max(1, errs.length - 1), Y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const grid: ChartGeo["grid"] = [];
  for (let d = lo; d <= hi; d++) grid.push({ y: Y(d), label: `${trim(10 ** d)} %` });
  return {
    W, H, grid, x0: L, x1: W - R,
    ticks: errs.map((_, i) => ({ x: X(i), label: String(i + 1) })),
    pts: pts.map((q, k) => ({ x: X(q.i), y: Y(lg[k]), last: q.i === errs.length - 1 })),
  };
}

export function chartSvg(errs: (number | null)[], label: string): string {
  const g = chartGeo(errs);
  if (!g) return "";
  let s = `<svg class="sim-conv" viewBox="0 0 ${g.W} ${g.H}" role="img" aria-label="${esc(label)}">`;
  for (const l of g.grid) s += `<line class="g" x1="${g.x0}" x2="${g.x1}" y1="${l.y}" y2="${l.y}"/><text class="a" x="${g.x0 - 4}" y="${l.y + 3}" text-anchor="end">${l.label}</text>`;
  for (const k of g.ticks) s += `<text class="a" x="${k.x}" y="${g.H - 3}" text-anchor="middle">${k.label}</text>`;
  s += `<polyline points="${g.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>` + g.pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6"${p.last ? ' class="x"' : ""}/>`).join("");
  return s + `</svg>`;
}

const CSS = `body{font:14px/1.45 "DejaVu Sans",system-ui,Arial,sans-serif;color:#111827;background:#fff;max-width:900px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #d5dae3;padding-bottom:4px}
.sub,.muted{color:#5b6472}p{margin:6px 0}table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e3e7ee;vertical-align:top}th{background:#eef1f6;font-weight:600}
figure{margin:10px 0}figure img{max-width:100%;border:1px solid #d5dae3}figcaption{color:#5b6472;font-size:12.5px}
.sim-conv{width:330px;max-width:100%}.sim-conv .g{stroke:#d5dae3;stroke-width:.5}.sim-conv .a{font-size:7px;fill:#5b6472}
.sim-conv polyline{fill:none;stroke:#1c64d8;stroke-width:1.4}.sim-conv circle{fill:#1c64d8}.sim-conv circle.x{fill:#fff;stroke:#1c64d8;stroke-width:1.2}
@media print{body{margin:0 auto}h2{break-after:avoid}figure,tr{break-inside:avoid}}`;

/** The report as one self-contained HTML page (pictures inline). */
export function reportHtml(r: SimReport, lang = "en"): string {
  let body = `<h1>${esc(r.title)}</h1><p class="sub">${esc(r.sub)}</p>`;
  for (const b of r.blocks) {
    if (b.kind === "h") body += `<h2>${esc(b.text)}</h2>`;
    else if (b.kind === "p") body += `<p${b.muted ? ' class="muted"' : ""}>${esc(b.text)}</p>`;
    else if (b.kind === "table") {
      const [head, ...rows] = b.rows;
      body += `<table><thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    } else if (b.kind === "image") body += `<figure><img src="${b.src}" width="${b.w}" height="${b.h}" style="height:auto" alt="${esc(b.caption)}"/><figcaption>${esc(b.caption)}</figcaption></figure>`;
    else body += `<figure>${chartSvg(b.errs, b.label)}<figcaption>${esc(b.label)}</figcaption></figure>`;
  }
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

/** The report as an A4 PDF. `font` is DejaVu Sans as base64, so Cyrillic and symbols come out. */
export function reportPdf(jsPDF: typeof JsPDF, r: SimReport, font: string): Blob {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS("DejaVuSans.ttf", font);
  doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.setFont("DejaVu", "normal");
  doc.setProperties({ title: r.title, creator: "MöbiusCAD" });
  const W = 210, M = 14, BOTTOM = 283, IW = W - 2 * M;
  let y = M;
  const room = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const text = (s: string, size: number, grey = 0, gap = 1.5) => {
    doc.setFontSize(size); doc.setTextColor(grey);
    const lines = doc.splitTextToSize(s, IW) as string[], lh = size * 0.42;
    for (const l of lines) { room(lh); doc.text(l, M, y + lh * 0.78); y += lh; }
    y += gap;
    doc.setTextColor(0);
  };
  text(r.title, 16, 0, 0.5);
  text(r.sub, 9, 100, 3);
  for (const b of r.blocks) {
    if (b.kind === "h") {
      room(22);
      y += 3;
      text(b.text, 12, 0, 0.5);
      doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
      y += 2.5;
    } else if (b.kind === "p") text(b.text, 9, b.muted ? 100 : 0);
    else if (b.kind === "table") {
      const n = b.rows[0].length, rel = b.widths ?? b.rows[0].map(() => 1), sum = rel.reduce((a, c) => a + c, 0);
      const widths = rel.slice(0, n).map(w => (IW * w) / sum);
      doc.setFontSize(8.5);
      b.rows.forEach((row, ri) => {
        const lines = row.map((c, i) => doc.splitTextToSize(c, widths[i] - 2) as string[]);
        const h = Math.max(...lines.map(l => l.length)) * 3.8 + 1.6;
        room(h);
        if (ri === 0) { doc.setFillColor(238, 241, 246); doc.rect(M, y, IW, h, "F"); }
        let x = M;
        lines.forEach((l, i) => { doc.text(l, x + 1, y + 3.5); x += widths[i]; });
        doc.setDrawColor(225); doc.setLineWidth(0.1); doc.line(M, y + h, W - M, y + h);
        y += h;
      });
      y += 3;
    } else if (b.kind === "image") {
      const h = Math.min(105, (IW * b.h) / b.w), w = (h * b.w) / b.h;
      room(h + 7);
      doc.addImage(b.src, b.src.startsWith("data:image/jpeg") ? "JPEG" : "PNG", M, y, w, h);
      doc.setDrawColor(200); doc.setLineWidth(0.1); doc.rect(M, y, w, h);
      y += h + 1;
      text(b.caption, 8, 100, 3);
    } else {
      const g = chartGeo(b.errs);
      if (!g) continue;
      const k = 0.42, h = g.H * k;
      room(h + 7);
      const X = (x: number) => M + x * k, Y = (v: number) => y + v * k;
      doc.setFontSize(6); doc.setTextColor(100);
      doc.setDrawColor(210); doc.setLineWidth(0.1);
      for (const l of g.grid) { doc.line(X(g.x0), Y(l.y), X(g.x1), Y(l.y)); doc.text(l.label, X(g.x0 - 4), Y(l.y + 3), { align: "right" }); }
      for (const tk of g.ticks) doc.text(tk.label, X(tk.x), Y(g.H - 3), { align: "center" });
      doc.setDrawColor(28, 100, 216); doc.setLineWidth(0.35);
      for (let i = 1; i < g.pts.length; i++) doc.line(X(g.pts[i - 1].x), Y(g.pts[i - 1].y), X(g.pts[i].x), Y(g.pts[i].y));
      for (const p of g.pts) {
        if (p.last) { doc.setFillColor(255, 255, 255); doc.circle(X(p.x), Y(p.y), 0.9, "FD"); }
        else { doc.setFillColor(28, 100, 216); doc.circle(X(p.x), Y(p.y), 0.9, "F"); }
      }
      doc.setTextColor(0);
      y += h + 1;
      text(b.label, 8, 100, 3);
    }
  }
  const pages = doc.getNumberOfPages();
  doc.setFontSize(8); doc.setTextColor(120);
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.text(`${i} / ${pages}`, W - M, 291, { align: "right" }); }
  return doc.output("blob");
}
