// Drawing output (FR-DRW-030/031): one primitive list drawn as SVG (screen, SVG
// export, print), PDF (vector, sheet size, embedded font) and DXF (R12, mm, one
// layer per line type with its linetype).
import { PEN_DASH, PEN_W, type Prim } from "./prims";

const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
const escXml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Font size from the ISO 3098 capital height. */
export const FONT_K = 1 / 0.72;
export const FONT = "'DejaVu Sans', Arial, Helvetica, sans-serif";

/** SVG elements of the primitives for a W × H sheet (y flipped). */
export function svgBody(prims: Prim[], H: number, color = "#000"): string {
  const parts: string[] = [];
  const style = (pen: keyof typeof PEN_W) => {
    const d = PEN_DASH[pen];
    return `stroke="${color}" stroke-width="${PEN_W[pen]}"${d ? ` stroke-dasharray="${d.join(" ")}"` : ""}`;
  };
  for (const p of prims) {
    if (p.t === "l") parts.push(`<line x1="${f(p.p[0])}" y1="${f(H - p.p[1])}" x2="${f(p.p[2])}" y2="${f(H - p.p[3])}" ${style(p.pen)} data-l="${p.layer}"/>`);
    else if (p.t === "a") {
      if (p.a1 - p.a0 >= 2 * Math.PI - 1e-9) parts.push(`<circle cx="${f(p.o[0])}" cy="${f(H - p.o[1])}" r="${f(p.r)}" fill="none" ${style(p.pen)} data-l="${p.layer}"/>`);
      else {
        const x0 = p.o[0] + p.r * Math.cos(p.a0), y0 = p.o[1] + p.r * Math.sin(p.a0), x1 = p.o[0] + p.r * Math.cos(p.a1), y1 = p.o[1] + p.r * Math.sin(p.a1);
        parts.push(`<path d="M${f(x0)} ${f(H - y0)}A${f(p.r)} ${f(p.r)} 0 ${p.a1 - p.a0 > Math.PI ? 1 : 0} 0 ${f(x1)} ${f(H - y1)}" fill="none" ${style(p.pen)} data-l="${p.layer}"/>`);
      }
    } else if (p.t === "p") {
      let d = "";
      for (let i = 0; i < p.p.length; i += 2) d += `${i ? "L" : "M"}${f(p.p[i])} ${f(H - p.p[i + 1])}`;
      parts.push(`<path d="${d}${p.closed || p.fill ? "Z" : ""}" fill="${p.fill ? color : "none"}" ${style(p.pen)} stroke-linejoin="round" data-l="${p.layer}"/>`);
    } else {
      parts.push(`<text x="${f(p.x)}" y="${f(H - p.y)}" font-size="${f(p.h * FONT_K)}" text-anchor="${p.al === "l" ? "start" : p.al === "c" ? "middle" : "end"}"${p.bold ? ' font-weight="bold"' : ""}${p.rot ? ` transform="rotate(${f(-p.rot)} ${f(p.x)} ${f(H - p.y)})"` : ""} fill="${color}" data-l="${p.layer}">${escXml(p.s)}</text>`);
    }
  }
  return parts.join("");
}

/** A standalone SVG file of one sheet, at its real size in mm. */
export function sheetSvg(prims: Prim[], W: number, H: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}" font-family="${FONT.replace(/'/g, "")}" stroke-linecap="round">\n<rect width="${f(W)}" height="${f(H)}" fill="#fff"/>\n${svgBody(prims, H)}\n</svg>\n`;
}

/**
 * A sheet as a PNG at `dpi` (FR-DRW-031), white background. The SVG carries the DejaVu font as a
 * data URI so the text renders the same as on screen and in the PDF. Very large sheets drop to
 * the dpi that keeps the image under ~120 megapixels (browser canvas limits); `dpi` in the result says which.
 */
export async function sheetPng(prims: Prim[], W: number, H: number, font: ArrayBuffer, dpi = 300): Promise<{ blob: Blob; dpi: number }> {
  const maxPx = 120e6, px = (d: number) => (W / 25.4 * d) * (H / 25.4 * d);
  while (dpi > 72 && px(dpi) > maxPx) dpi -= 25;
  const w = Math.round(W / 25.4 * dpi), h = Math.round(H / 25.4 * dpi);
  let bin = "";
  const u8 = new Uint8Array(font);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  const face = `<style>@font-face{font-family:"DejaVu Sans";src:url(data:font/ttf;base64,${btoa(bin)}) format("truetype");}</style>`;
  const svg = sheetSvg(prims, W, H).replace(/width="[^"]+mm" height="[^"]+mm"/, `width="${w}" height="${h}"`).replace('stroke-linecap="round">', `stroke-linecap="round">${face}`);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("SVG")); img.src = url; });
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    if (!g) throw new Error("canvas");
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>(ok => cv.toBlob(ok, "image/png"));
    if (!blob) throw new Error("PNG");
    return { blob: await withDpi(blob, dpi), dpi };
  } finally { URL.revokeObjectURL(url); }
}

/** Writes a pHYs chunk (pixels per metre) after IHDR so viewers and printers know the resolution. */
async function withDpi(png: Blob, dpi: number): Promise<Blob> {
  const b = new Uint8Array(await png.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254), chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 8 + 25; // signature + IHDR (4 len + 4 type + 13 data + 4 crc)
  const out = new Uint8Array(b.length + 21);
  out.set(b.subarray(0, at)); out.set(chunk, at); out.set(b.subarray(at), at + 21);
  return new Blob([out], { type: "image/png" });
}

function crc32(d: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < d.length; i++) { c ^= d[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

// ---------- DXF ----------

const LTYPES: Record<string, { desc: string; pat: number[] }> = {
  CONTINUOUS: { desc: "Solid line", pat: [] },
  HIDDEN: { desc: "Hidden __ __ __", pat: [3, -1.5] },
  CENTER: { desc: "Center ____ _ ____", pat: [12, -2, 1.5, -2] },
};
const LAYERS: Record<string, { color: number; lt: string }> = {
  VISIBLE: { color: 7, lt: "CONTINUOUS" }, TANGENT: { color: 8, lt: "CONTINUOUS" }, HIDDEN: { color: 5, lt: "HIDDEN" },
  CENTER: { color: 1, lt: "CENTER" }, HATCH: { color: 8, lt: "CONTINUOUS" }, ANNOT: { color: 4, lt: "CONTINUOUS" }, FORMAT: { color: 7, lt: "CONTINUOUS" }, TEXT: { color: 7, lt: "CONTINUOUS" }, SKETCH: { color: 3, lt: "CONTINUOUS" },
};

/** DXF R12 in millimetres, one layer per line type. */
export function sheetDxf(prims: Prim[], W: number, H: number): string {
  const o: (string | number)[] = [];
  const g = (code: number, v: string | number) => o.push(code, typeof v === "number" ? f(v) : v);
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); o.push(70, 4);
  g(9, "$MEASUREMENT"); o.push(70, 1);
  g(9, "$EXTMIN"); g(10, 0); g(20, 0); g(30, 0);
  g(9, "$EXTMAX"); g(10, W); g(20, H); g(30, 0);
  g(9, "$LTSCALE"); g(40, 1);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); o.push(70, Object.keys(LTYPES).length);
  for (const [name, lt] of Object.entries(LTYPES)) {
    g(0, "LTYPE"); g(2, name); o.push(70, 0); g(3, lt.desc); o.push(72, 65, 73, lt.pat.length); g(40, lt.pat.reduce((s, v) => s + Math.abs(v), 0));
    for (const v of lt.pat) g(49, v);
  }
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); o.push(70, Object.keys(LAYERS).length);
  for (const [name, l] of Object.entries(LAYERS)) { g(0, "LAYER"); g(2, name); o.push(70, 0, 62, l.color); g(6, l.lt); }
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "STYLE"); o.push(70, 1);
  g(0, "STYLE"); g(2, "STANDARD"); o.push(70, 0); g(40, 0); g(41, 1); g(50, 0); o.push(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const p of prims) {
    if (p.t === "l") { g(0, "LINE"); g(8, p.layer); g(10, p.p[0]); g(20, p.p[1]); g(30, 0); g(11, p.p[2]); g(21, p.p[3]); g(31, 0); }
    else if (p.t === "a") {
      if (p.a1 - p.a0 >= 2 * Math.PI - 1e-9) { g(0, "CIRCLE"); g(8, p.layer); g(10, p.o[0]); g(20, p.o[1]); g(30, 0); g(40, p.r); }
      else { g(0, "ARC"); g(8, p.layer); g(10, p.o[0]); g(20, p.o[1]); g(30, 0); g(40, p.r); g(50, p.a0 * 180 / Math.PI); g(51, p.a1 * 180 / Math.PI); }
    } else if (p.t === "p" && p.fill && p.p.length >= 6 && p.p.length <= 8) {
      // A filled arrowhead: SOLID takes its corners in Z order (1, 2, 4, 3).
      const q = p.p, k = q.length / 2, c = (i: number) => [q[2 * Math.min(i, k - 1)], q[2 * Math.min(i, k - 1) + 1]];
      g(0, "SOLID"); g(8, p.layer);
      [c(0), c(1), c(3), c(2)].forEach((pt, i) => { g(10 + i, pt[0]); g(20 + i, pt[1]); g(30 + i, 0); });
    } else if (p.t === "p") {
      g(0, "POLYLINE"); g(8, p.layer); o.push(66, 1); g(10, 0); g(20, 0); g(30, 0); o.push(70, p.closed ? 1 : 0);
      for (let i = 0; i < p.p.length; i += 2) { g(0, "VERTEX"); g(8, p.layer); g(10, p.p[i]); g(20, p.p[i + 1]); g(30, 0); }
      g(0, "SEQEND"); g(8, p.layer);
    } else {
      g(0, "TEXT"); g(8, p.layer); g(10, p.x); g(20, p.y); g(30, 0); g(40, p.h); g(1, p.s.replace(/[\r\n]+/g, " ")); if (p.rot) g(50, p.rot);
      if (p.al !== "l") { o.push(72, p.al === "c" ? 1 : 2); g(11, p.x); g(21, p.y); g(31, 0); }
    }
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return o.join("\n") + "\n";
}

// ---------- PDF ----------

/** Vector PDF of the sheets at their real size, with an embedded font (Cyrillic and drawing symbols work). */
export async function sheetsPdf(sheets: { prims: Prim[]; W: number; H: number }[], fontBytes: ArrayBuffer, title: string): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const first = sheets[0];
  const doc = new jsPDF({ unit: "mm", format: [first.W, first.H], orientation: first.W >= first.H ? "landscape" : "portrait", compress: true });
  let bin = "";
  const u8 = new Uint8Array(fontBytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  doc.addFileToVFS("DejaVuSans.ttf", btoa(bin));
  doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.setFont("DejaVu", "normal");
  doc.setProperties({ title, creator: "MöbiusCAD" });
  sheets.forEach((sh, i) => {
    if (i) doc.addPage([sh.W, sh.H], sh.W >= sh.H ? "landscape" : "portrait");
    const H = sh.H;
    doc.setLineCap("round");
    let pen = "";
    const usePen = (p: keyof typeof PEN_W) => {
      if (p === pen) return;
      pen = p;
      doc.setLineWidth(PEN_W[p]);
      doc.setLineDashPattern(PEN_DASH[p] ?? [], 0);
    };
    for (const p of sh.prims) {
      if (p.t === "l") { usePen(p.pen); doc.line(p.p[0], H - p.p[1], p.p[2], H - p.p[3]); }
      else if (p.t === "a") {
        usePen(p.pen);
        if (p.a1 - p.a0 >= 2 * Math.PI - 1e-9) { doc.circle(p.o[0], H - p.o[1], p.r, "S"); continue; }
        // Cubic Béziers of at most 90° each.
        const n = Math.max(1, Math.ceil((p.a1 - p.a0) / (Math.PI / 2))), da = (p.a1 - p.a0) / n, k = 4 / 3 * Math.tan(da / 4);
        const P = (a: number) => [p.o[0] + p.r * Math.cos(a), H - (p.o[1] + p.r * Math.sin(a))];
        const [sx, sy] = P(p.a0);
        const segs: number[][] = [];
        let [cx, cy] = [sx, sy];
        for (let j = 0; j < n; j++) {
          const a = p.a0 + j * da, b = a + da;
          const c1 = [cx - k * p.r * Math.sin(a), cy - k * p.r * Math.cos(a)];
          const [ex, ey] = P(b);
          const c2 = [ex + k * p.r * Math.sin(b), ey + k * p.r * Math.cos(b)];
          segs.push([c1[0] - cx, c1[1] - cy, c2[0] - cx, c2[1] - cy, ex - cx, ey - cy]);
          [cx, cy] = [ex, ey];
        }
        doc.lines(segs, sx, sy, [1, 1], "S", false);
      } else if (p.t === "p") {
        usePen(p.pen);
        const segs: number[][] = [];
        for (let j = 2; j < p.p.length; j += 2) segs.push([p.p[j] - p.p[j - 2], -(p.p[j + 1] - p.p[j - 1])]);
        if (p.fill) doc.setFillColor(0, 0, 0);
        doc.lines(segs, p.p[0], H - p.p[1], [1, 1], p.fill ? "FD" : "S", !!p.closed || !!p.fill);
      } else {
        doc.setFontSize(p.h * FONT_K / 0.3528);
        if (p.rot) {
          // jsPDF aligns rotated text badly: shift the start along the rotated baseline ourselves.
          const w = p.al === "l" ? 0 : doc.getTextWidth(p.s) * (p.al === "c" ? 0.5 : 1), a = p.rot * Math.PI / 180;
          doc.text(p.s, p.x - w * Math.cos(a), H - (p.y - w * Math.sin(a)), { angle: p.rot, baseline: "alphabetic" });
        } else doc.text(p.s, p.x, H - p.y, { align: p.al === "l" ? "left" : p.al === "c" ? "center" : "right", baseline: "alphabetic" });
      }
    }
  });
  return doc.output("blob");
}
