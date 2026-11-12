// Geometric tolerances, datum features, surface finish and tables (FR-DRW-023/024). The
// characteristic symbols (ISO 1101 / ASME Y14.5) are drawn as lines and arcs, not font glyphs,
// so they come out the same in SVG, PDF and DXF whatever font the viewer has.
import { arrowHead } from "./compose";
import type { Prim } from "./prims";
import type { DatumAnnot, GRow, GSym, GtolAnnot, SurfAnnot, TableAnnot } from "./types";

type P2 = [number, number];
type Box = [number, number, number, number];
const H = 3.5;
const tw = (s: string, h = H) => s.length * h * 0.85;
const L = (a: P2, b: P2, pen: "thin" | "thick" = "thin"): Prim => ({ t: "l", p: [a[0], a[1], b[0], b[1]], pen, layer: "ANNOT" });
const C = (o: P2, r: number, a0 = 0, a1 = 2 * Math.PI): Prim => ({ t: "a", o, r, a0, a1, pen: "thin", layer: "ANNOT" });
type TPrim = Extract<Prim, { t: "t" }>;
const T = (x: number, y: number, s: string, h = H, al: "l" | "c" | "r" = "c"): TPrim => ({ t: "t", x, y, s, h, al, layer: "ANNOT" });

export const GSYMS: GSym[] = ["straight", "flat", "circ", "cyl", "pline", "psurf", "par", "perp", "ang", "pos", "conc", "sym", "runout", "trunout"];
export const GSYM_NAMES: Record<GSym, string> = {
  straight: "Straightness", flat: "Flatness", circ: "Circularity", cyl: "Cylindricity", pline: "Profile of a line", psurf: "Profile of a surface",
  par: "Parallelism", perp: "Perpendicularity", ang: "Angularity", pos: "Position tolerance", conc: "Concentricity", sym: "Symmetry", runout: "Circular run-out", trunout: "Total run-out",
};

/** Modifying symbols of a tolerance frame: the character kept in the text, what the button shows, its name. */
export const GMODS: [string, string, string][] = [
  ["Ø", "Ø", "Diameter"], ["SØ", "SØ", "Spherical diameter"],
  ["Ⓜ", "M", "Maximum material condition"], ["Ⓛ", "L", "Least material condition"], ["Ⓢ", "S", "Regardless of feature size"],
  ["Ⓕ", "F", "Free state"], ["Ⓟ", "P", "Projected tolerance zone"], ["Ⓣ", "T", "Tangent plane"], ["Ⓤ", "U", "Unequally disposed profile"],
  ["Ⓘ", "I", "Independency"], ["Ⓔ", "E", "Envelope requirement"], ["⬡", "ST", "Statistical tolerance"], ["CF", "CF", "Continuous feature"], ["▷", "▷", "Translation"],
];
/** The circled letter for a modifier ("M" → "Ⓜ"). */
export const circled = (l: string) => String.fromCodePoint(0x24b6 + l.toUpperCase().charCodeAt(0) - 65);
type Run = { k: "t"; s: string } | { k: "c"; l: string } | { k: "st" };
/** Frame text split into plain runs, circled letters and the statistical hexagon. */
export function richRuns(s: string): Run[] {
  const out: Run[] = [];
  for (const part of s.split(/([\u24b6-\u24cf\u24d0-\u24e9⬡])/)) {
    if (!part) continue;
    const c = part.codePointAt(0)!;
    if (part === "⬡") out.push({ k: "st" });
    else if (c >= 0x24b6 && c <= 0x24cf) out.push({ k: "c", l: String.fromCharCode(65 + c - 0x24b6) });
    else if (c >= 0x24d0 && c <= 0x24e9) out.push({ k: "c", l: String.fromCharCode(65 + c - 0x24d0) });
    else out.push({ k: "t", s: part });
  }
  return out;
}
export const richW = (s: string, h = H) => richRuns(s).reduce((w, r) => w + (r.k === "t" ? tw(r.s, h) : r.k === "c" ? 1.25 * h : 2.3 * h), 0);
/** Frame text on the baseline `base`: plain text as text, modifiers drawn (a circle with its letter, a hexagon with ST), so no font needs them. */
export function richPrims(x: number, base: number, s: string, h = H, al: "l" | "c" = "l"): Prim[] {
  const runs = richRuns(s);
  if (runs.every(r => r.k === "t")) return s ? [T(x, base, s, h, al)] : [];
  const out: Prim[] = [], cy = base + h / 2 - 0.2 * h / H;
  let u = al === "c" ? x - richW(s, h) / 2 : x;
  for (const r of runs) {
    if (r.k === "t") { out.push(T(u, base, r.s, h, "l")); u += tw(r.s, h); }
    else if (r.k === "c") { const m = u + 0.625 * h; out.push(C([m, cy], 0.49 * h), T(m, cy - 0.285 * h, r.l, 0.57 * h, "c")); u += 1.25 * h; }
    else {
      const m = u + 1.15 * h, a = 1.05 * h, b = 0.52 * h, k = 0.45 * h;
      out.push({ t: "p", p: [m - a, cy, m - a + k, cy + b, m + a - k, cy + b, m + a, cy, m + a - k, cy - b, m - a + k, cy - b], pen: "thin", layer: "ANNOT", closed: true }, T(m, cy - 0.27 * h, "ST", 0.54 * h, "c"));
      u += 2.3 * h;
    }
  }
  return out;
}
/** A row as the dialog edits it: the older Ø flag and modifier written into the tolerance text. */
export function rowText(r: GRow): GRow {
  const { dia, mod, ...rest } = r;
  return { ...rest, tol: (dia && !r.tol.startsWith("Ø") ? "Ø" : "") + r.tol + (mod ? circled(mod) : ""), datums: [...r.datums] };
}

/** A characteristic symbol centred at (x, y), about `k` mm tall. */
export function symbolPrims(sym: GSym, x: number, y: number, k = H): Prim[] {
  const h = k / 2, out: Prim[] = [];
  const at = (u: number, v: number): P2 => [x + u, y + v];
  const slant = (dx: number) => L(at(dx - h * 0.45, -h * 0.85), at(dx + h * 0.45, h * 0.85));
  switch (sym) {
    case "straight": out.push(L(at(-h, 0), at(h, 0))); break;
    case "flat": out.push({ t: "p", p: [...at(-h, -h * 0.45), ...at(h * 0.6, -h * 0.45), ...at(h, h * 0.45), ...at(-h * 0.6, h * 0.45)], pen: "thin", layer: "ANNOT", closed: true }); break;
    case "circ": out.push(C(at(0, 0), h * 0.8)); break;
    case "cyl": out.push(C(at(0, 0), h * 0.6), slant(-h * 0.75), slant(h * 0.75)); break;
    case "pline": out.push(C(at(0, -h * 0.45), h * 0.85, 0, Math.PI)); break;
    case "psurf": out.push(C(at(0, -h * 0.45), h * 0.85, 0, Math.PI), L(at(-h * 0.85, -h * 0.45), at(h * 0.85, -h * 0.45))); break;
    case "par": out.push(slant(-h * 0.35), slant(h * 0.35)); break;
    case "perp": out.push(L(at(-h, -h * 0.8), at(h, -h * 0.8)), L(at(0, -h * 0.8), at(0, h * 0.9))); break;
    case "ang": out.push(L(at(-h, -h * 0.8), at(h, -h * 0.8)), L(at(-h, -h * 0.8), at(h * 0.8, h * 0.6))); break;
    case "pos": out.push(C(at(0, 0), h * 0.55), L(at(-h, 0), at(h, 0)), L(at(0, -h), at(0, h))); break;
    case "conc": out.push(C(at(0, 0), h * 0.35), C(at(0, 0), h * 0.8)); break;
    case "sym": out.push(L(at(-h * 0.6, h * 0.55), at(h * 0.6, h * 0.55)), L(at(-h, 0), at(h, 0)), L(at(-h * 0.6, -h * 0.55), at(h * 0.6, -h * 0.55))); break;
    case "runout": out.push(L(at(-h * 0.7, -h * 0.9), at(h * 0.55, h * 0.55)), arrowHead(...at(h * 0.8, h * 0.85), 1, 1.15, 1.6, 1)); break;
    case "trunout":
      out.push(L(at(-h, -h * 0.9), at(h, -h * 0.9)), L(at(-h * 0.9, -h * 0.9), at(-h * 0.1, h * 0.55)), L(at(0.1 * h, -h * 0.9), at(h * 0.9, h * 0.55)));
      out.push(arrowHead(...at(-h * 0.05, h * 0.85), 1, 1.15, 1.4, 0.9), arrowHead(...at(h * 0.95, h * 0.85), 1, 1.15, 1.4, 0.9));
      break;
  }
  return out;
}

const ROW = 7;
/** A feature control frame with its top-left corner at `at`; the leader goes from its left side to `to`. */
export function gtolPrims(a: GtolAnnot, at: P2, to: P2 | null, dec: string): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  let wMax = 0;
  a.rows.forEach((r, i) => {
    const y0 = at[1] - (i + 1) * ROW, cy = y0 + ROW / 2, base = cy - H / 2 + 0.2;
    let x = at[0];
    const cell = (w: number) => { out.push(L([x, y0], [x + w, y0]), L([x + w, y0], [x + w, y0 + ROW]), L([x + w, y0 + ROW], [x, y0 + ROW]), L([x, y0 + ROW], [x, y0])); x += w; };
    // A composite frame: one characteristic cell spans the row and the composite rows under it.
    if (i > 0 && r.composite) x += 8;
    else {
      let n = 1;
      while (a.rows[i + n]?.composite) n++;
      const yb = y0 - (n - 1) * ROW;
      out.push(...symbolPrims(r.sym, x + 4, (yb + y0 + ROW) / 2));
      out.push(L([x, yb], [x + 8, yb]), L([x + 8, yb], [x + 8, y0 + ROW]), L([x + 8, y0 + ROW], [x, y0 + ROW]), L([x, y0 + ROW], [x, yb]));
      x += 8;
    }
    const dp = (v: string) => dec === "." ? v : v.replace(".", dec);
    const e = rowText(r);
    for (const v of [dp(e.tol), ...(e.tol2 ? [dp(e.tol2)] : [])]) { const w = Math.max(8, richW(v) + 3); out.push(...richPrims(x + 1.5, base, v)); cell(w); }
    for (const d of r.datums.filter(Boolean)) { const dw = Math.max(7, richW(d) + 3); out.push(...richPrims(x + dw / 2, base, d, H, "c")); cell(dw); }
    wMax = Math.max(wMax, x - at[0]);
  });
  if (to) {
    // Leave the frame horizontally from the side nearer the feature, then go to it.
    const right = to[0] > at[0] + wMax / 2, sx = right ? at[0] + wMax : at[0];
    const s: P2 = [sx, at[1] - ROW / 2], knee: P2 = [sx + (right ? 4 : -4), s[1]];
    const dl = Math.hypot(to[0] - knee[0], to[1] - knee[1]) || 1;
    out.push(L(s, knee), L(knee, to), arrowHead(to[0], to[1], (to[0] - knee[0]) / dl, (to[1] - knee[1]) / dl, 3, 1));
    if (a.around) out.push(C(knee, 1.5));
  }
  // Text above the frame ("2×", "4× Ø6 H7") and below it ("SEP REQT"), left-aligned with it.
  const hb = 2.5;
  let yb = at[1] - a.rows.length * ROW, wText = a.above ? tw(a.above, hb) : 0;
  if (a.above) out.push(T(at[0], at[1] + 1, a.above, hb, "l"));
  // Between: "A ↔ B" under the frame, the arrow drawn.
  if (a.between && (a.between[0] || a.between[1])) {
    const [p, q] = a.between, y = yb - H - 1.2, x0 = at[0] + tw(p) + 1, x1 = x0 + 7;
    out.push(T(at[0], y, p, H, "l"), L([x0, y + H / 2], [x1, y + H / 2]), arrowHead(x0, y + H / 2, -1, 0, 2, 1), arrowHead(x1, y + H / 2, 1, 0, 2, 1), T(x1 + 1, y, q, H, "l"));
    wText = Math.max(wText, x1 + 1 + tw(q) - at[0]);
    yb = y - 0.6;
  }
  if (a.below) { out.push(T(at[0], yb - hb - 1, a.below, hb, "l")); wText = Math.max(wText, tw(a.below, hb)); }
  return { prims: out, box: [at[0], yb - (a.below ? hb + 1.5 : 0), at[0] + Math.max(wMax, wText), at[1] + (a.above ? hb + 1.5 : 0)] };
}

/** A datum feature (`base` null: its edge is gone): a filled triangle on the edge at `base` (edge direction `d`), a line to the framed letter at `at`. */
export function datumPrims(a: DatumAnnot, base: P2 | null, d: P2, at: P2): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const s = 3.5;
  // Without its edge (dangling) only the framed letter is drawn.
  if (base) {
  let n: P2 = [-d[1], d[0]];
  if ((at[0] - base[0]) * n[0] + (at[1] - base[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const b1: P2 = [base[0] - d[0] * 2, base[1] - d[1] * 2], b2: P2 = [base[0] + d[0] * 2, base[1] + d[1] * 2], apex: P2 = [base[0] + n[0] * 3, base[1] + n[1] * 3];
  out.push({ t: "p", p: [...b1, ...b2, ...apex], pen: "thin", layer: "ANNOT", closed: true, ...(a.open ? {} : { fill: true }) });
  // Line from the apex to the frame's edge; bent = square to the edge first, then along it.
  let from = apex;
  const along = (at[0] - apex[0]) * d[0] + (at[1] - apex[1]) * d[1], up = (at[0] - apex[0]) * n[0] + (at[1] - apex[1]) * n[1];
  if (a.bent && Math.abs(along) > s + 0.5 && up > 0.5) {
    const knee: P2 = [apex[0] + n[0] * up, apex[1] + n[1] * up];
    out.push(L(apex, knee));
    from = knee;
  }
  const v: P2 = [from[0] - at[0], from[1] - at[1]], m = Math.max(Math.abs(v[0]), Math.abs(v[1]));
  if (m > s) out.push(L(from, [at[0] + v[0] * s / m, at[1] + v[1] * s / m]));
  }
  out.push({ t: "p", p: [at[0] - s, at[1] - s, at[0] + s, at[1] - s, at[0] + s, at[1] + s, at[0] - s, at[1] + s], pen: "thin", layer: "ANNOT", closed: true });
  out.push(T(at[0], at[1] - H / 2 + 0.2, a.letter));
  return { prims: out, box: [at[0] - s, at[1] - s, at[0] + s, at[1] + s] };
}

/** Lay symbols of ISO 1302 (direction of the surface pattern). */
export const SURF_LAYS = ["=", "⊥", "X", "M", "C", "R", "P"] as const;

/**
 * ISO 1302 surface texture symbol with its base at `base`: short leg 5 mm, long leg 10 mm (14 mm with a second
 * requirement), 60°. The requirements sit under the long leg's line, the method above it, the lay symbol beside
 * the long leg, the machining allowance left of the short leg and the all-around circle where leg and line meet.
 */
export function surfPrims(a: SurfAnnot, base: P2, dec: string): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const c = Math.cos(Math.PI / 3), s = Math.sin(Math.PI / 3);
  const comma = (x: string) => (dec === "." ? x : x.replace(/(\d)\.(\d)/g, `$1${dec}$2`));
  const text = comma(a.text), text2 = a.text2 ? comma(a.text2) : "", allow = a.allow ? comma(a.allow) : "";
  const long = text2 ? 14 : 10;
  const p1: P2 = [base[0] - 5 * c, base[1] + 5 * s], p2: P2 = [base[0] + long * c, base[1] + long * s];
  out.push(L(base, p1), L(base, p2));
  if (a.proc === "removal") out.push(L(p1, [base[0] + 5 * c, base[1] + 5 * s]));
  if (a.proc === "none") out.push(C([base[0], base[1] + 5 * s * 0.55], 5 * s * 0.55 * Math.tan(Math.PI / 6) / 1.1));
  const w = Math.max(8, tw(text, 2.5) + 2, text2 ? tw(text2, 2.5) + 2 : 0, a.method ? tw(a.method, 2.5) + 2 : 0);
  out.push(L(p2, [p2[0] + w, p2[1]]));
  if (text) out.push(T(p2[0] + 1, p2[1] - 3.6, text, 2.5, "l"));
  if (text2) out.push(T(p2[0] + 1, p2[1] - 7.2, text2, 2.5, "l"));
  if (a.method) out.push(T(p2[0] + 1, p2[1] + 1, a.method, 2.5, "l"));
  if (a.lay) out.push(T(base[0] + 3.2, base[1] + 0.6, a.lay, 2.5, "l"));
  if (allow) out.push(T(base[0] - 2.6, base[1] + 0.6, allow, 2.5, "r"));
  if (a.around) out.push(C(p2, 1));
  const left = allow ? base[0] - 2.6 - tw(allow, 2.5) : p1[0];
  return { prims: out, box: [Math.min(p1[0], left), base[1], p2[0] + w, p2[1] + (a.method ? 4 : a.around ? 1 : 0.5)] };
}

/** A table header or title as shown: new columns are "Column n" until renamed; other English keys translate. */
export function cellLabel(c: string, label: (s: string, p?: Record<string, string>) => string): string {
  const m = /^Column (\d+)$/.exec(c);
  return m ? label("Column {n}", { n: m[1] }) : label(c);
}

/** A table: optional title row, a header row and the rows, column widths from their contents. */
export function tablePrims(a: TableAnnot, label: (s: string, p?: Record<string, string>) => string, maxH = Infinity): { prims: Prim[]; box: Box; boxes: Box[] } {
  const out: Prim[] = [];
  const h = 2.5, rh = 6;
  const head = a.cols.map(c => cellLabel(c, label));
  const widths = head.map((c, i) => Math.max(12, tw(c, h) + 3, ...a.rows.map(r => tw(r[i] ?? "", h) + 3)));
  const W = widths.reduce((s, w) => s + w, 0);
  // A parts list taller than the room above it is split into blocks side by side, each with its header, continuing to the
  // left (a CAD app's split table): drawings exam round 2, a 43-row BOM ran off the sheet.
  const per = a.anchor === "br" && Number.isFinite(maxH) ? Math.max(1, Math.floor(maxH / rh) - 1 - (a.title ? 1 : 0)) : Infinity;
  const blocks: string[][][] = [];
  for (let i = 0; i < Math.max(1, a.rows.length); i += per === Infinity ? Math.max(1, a.rows.length) : per) blocks.push(a.rows.slice(i, per === Infinity ? undefined : i + per));
  const xr = a.anchor === "tr" || a.anchor === "br" ? a.pos[0] - W : a.pos[0];
  let top = -Infinity, bottom = Infinity;
  const boxes: Box[] = [];
  blocks.forEach((block, bi) => {
    const title = bi === 0 && a.title;
    const nRows = (title ? 1 : 0) + 1 + block.length;
    // Anchored at the bottom (a parts list on the title block): the header is at the bottom and items count upwards.
    let y = a.anchor === "br" ? a.pos[1] + nRows * rh : a.pos[1];
    top = Math.max(top, y);
    const x0 = xr - bi * W;
    const rows: { cells: string[]; bold?: boolean; span?: boolean }[] = [];
    if (title) rows.push({ cells: [cellLabel(title, label)], bold: true, span: true });
    const body = block.map(r => ({ cells: a.cols.map((_c, i) => r[i] ?? "") }));
    if (a.anchor === "br") rows.push(...body.reverse(), { cells: head, bold: true });
    else rows.push({ cells: head, bold: true }, ...body);
    for (const r of rows) {
      const y0 = y - rh;
      out.push(L([x0, y0], [x0 + W, y0]), L([x0, y], [x0 + W, y]));
      if (r.span) { out.push({ ...T(x0 + W / 2, y0 + 1.8, r.cells[0], h, "c"), bold: true }); }
      else {
        let x = x0;
        r.cells.forEach((c, i) => {
          out.push(L([x, y0], [x, y]));
          if (c) out.push({ ...T(x + 1.5, y0 + 1.8, c, h, "l"), bold: r.bold });
          x += widths[i];
        });
      }
      out.push(L([x0, y0], [x0, y]), L([x0 + W, y0], [x0 + W, y]));
      y = y0;
    }
    bottom = Math.min(bottom, y);
    boxes.push(a.anchor === "br" ? [x0, y, x0 + W, a.pos[1] + nRows * rh] : [x0, y, x0 + W, a.pos[1]]);
  });
  return { prims: out, box: [xr - (blocks.length - 1) * W, bottom, xr + W, top], boxes };
}
