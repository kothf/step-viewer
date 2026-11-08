// Geometric tolerances, datum features, surface finish and tables (FR-DRW-023/024). The
// characteristic symbols (ISO 1101 / ASME Y14.5) are drawn as lines and arcs, not font glyphs,
// so they come out the same in SVG, PDF and DXF whatever font the viewer has.
import { arrowHead } from "./compose";
import type { Prim } from "./prims";
import type { DatumAnnot, GSym, GtolAnnot, SurfAnnot, TableAnnot } from "./types";

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
    out.push(...symbolPrims(r.sym, x + 4, cy));
    cell(8);
    const tol = (r.dia ? "Ø" : "") + (dec === "." ? r.tol : r.tol.replace(".", dec));
    const modW = r.mod ? 4.2 : 0, w = Math.max(8, tw(tol) + 3 + modW);
    out.push(T(x + 1.5, base, tol, H, "l"));
    if (r.mod) { const mx = x + w - 2.6; out.push(C([mx, cy], 1.7), T(mx, cy - 1, r.mod, 2, "c")); }
    cell(w);
    for (const d of r.datums.filter(Boolean)) { const dw = Math.max(7, tw(d) + 3); out.push(T(x + dw / 2, base, d)); cell(dw); }
    wMax = Math.max(wMax, x - at[0]);
  });
  if (to) {
    // Leave the frame horizontally from the side nearer the feature, then go to it.
    const right = to[0] > at[0] + wMax / 2, sx = right ? at[0] + wMax : at[0];
    const s: P2 = [sx, at[1] - ROW / 2], knee: P2 = [sx + (right ? 4 : -4), s[1]];
    const dl = Math.hypot(to[0] - knee[0], to[1] - knee[1]) || 1;
    out.push(L(s, knee), L(knee, to), arrowHead(to[0], to[1], (to[0] - knee[0]) / dl, (to[1] - knee[1]) / dl, 3, 1));
  }
  return { prims: out, box: [at[0], at[1] - a.rows.length * ROW, at[0] + wMax, at[1]] };
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
  out.push({ t: "p", p: [...b1, ...b2, ...apex], pen: "thin", layer: "ANNOT", fill: true, closed: true });
  // Line from the apex to the frame's edge.
  const v: P2 = [apex[0] - at[0], apex[1] - at[1]], m = Math.max(Math.abs(v[0]), Math.abs(v[1]));
  if (m > s) out.push(L(apex, [at[0] + v[0] * s / m, at[1] + v[1] * s / m]));
  }
  out.push({ t: "p", p: [at[0] - s, at[1] - s, at[0] + s, at[1] - s, at[0] + s, at[1] + s, at[0] - s, at[1] + s], pen: "thin", layer: "ANNOT", closed: true });
  out.push(T(at[0], at[1] - H / 2 + 0.2, a.letter));
  return { prims: out, box: [at[0] - s, at[1] - s, at[0] + s, at[1] + s] };
}

/** ISO 1302 surface texture symbol with its base at `base`: short leg 5 mm, long leg 10 mm, 60°. */
export function surfPrims(a: SurfAnnot, base: P2, dec: string): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const c = Math.cos(Math.PI / 3), s = Math.sin(Math.PI / 3);
  const p1: P2 = [base[0] - 5 * c, base[1] + 5 * s], p2: P2 = [base[0] + 10 * c, base[1] + 10 * s];
  out.push(L(base, p1), L(base, p2));
  if (a.proc === "removal") out.push(L(p1, [base[0] + 5 * c, base[1] + 5 * s]));
  if (a.proc === "none") out.push(C([base[0], base[1] + 5 * s * 0.55], 5 * s * 0.55 * Math.tan(Math.PI / 6) / 1.1));
  const text = dec === "." ? a.text : a.text.replace(/(\d)\.(\d)/g, `$1${dec}$2`);
  const w = Math.max(8, tw(text, 2.5) + 2, a.method ? tw(a.method, 2.5) + 2 : 0);
  out.push(L(p2, [p2[0] + w, p2[1]]));
  if (text) out.push(T(p2[0] + 1, p2[1] - 3.6, text, 2.5, "l"));
  if (a.method) out.push(T(p2[0] + 1, p2[1] + 1, a.method, 2.5, "l"));
  return { prims: out, box: [p1[0], base[1], p2[0] + w, p2[1] + (a.method ? 4 : 0.5)] };
}

/** A table header or title as shown: new columns are "Column n" until renamed; other English keys translate. */
export function cellLabel(c: string, label: (s: string, p?: Record<string, string>) => string): string {
  const m = /^Column (\d+)$/.exec(c);
  return m ? label("Column {n}", { n: m[1] }) : label(c);
}

/** A table: optional title row, a header row and the rows, column widths from their contents. */
export function tablePrims(a: TableAnnot, label: (s: string, p?: Record<string, string>) => string): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const h = 2.5, rh = 6;
  const head = a.cols.map(c => cellLabel(c, label));
  const widths = head.map((c, i) => Math.max(12, tw(c, h) + 3, ...a.rows.map(r => tw(r[i] ?? "", h) + 3)));
  const W = widths.reduce((s, w) => s + w, 0);
  let y = a.pos[1];
  const x0 = a.anchor === "tr" ? a.pos[0] - W : a.pos[0];
  const rows: { cells: string[]; bold?: boolean; span?: boolean }[] = [];
  if (a.title) rows.push({ cells: [cellLabel(a.title, label)], bold: true, span: true });
  rows.push({ cells: head, bold: true }, ...a.rows.map(r => ({ cells: a.cols.map((_c, i) => r[i] ?? "") })));
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
  return { prims: out, box: [x0, y, x0 + W, a.pos[1]] };
}
