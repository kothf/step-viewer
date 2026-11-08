// Sheet formats (FR-DRW-001/002/003): sizes, the frame with zone marks
// (ISO 5457), and the title block (ISO 7200 or ANSI Y14.1 style) with its fields.
import { rect, type Prim } from "./prims";
import type { DrawingProps, Sheet, SheetSize } from "./types";

/** Landscape sizes in mm. */
export const SIZES: Record<Exclude<SheetSize, "custom">, [number, number]> = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  "ANSI A": [279.4, 215.9], "ANSI B": [431.8, 279.4], "ANSI C": [558.8, 431.8], "ANSI D": [863.6, 558.8], "ANSI E": [1117.6, 863.6],
};

export function sheetSize(s: Sheet): [number, number] {
  const [w, h] = s.size === "custom" ? [Math.max(50, s.w ?? 297), Math.max(50, s.h ?? 210)] : SIZES[s.size];
  return s.portrait ? [Math.min(w, h), Math.max(w, h)] : [Math.max(w, h), Math.min(w, h)];
}

/** The drawing frame: [x0, y0, x1, y1]. ISO keeps a 20 mm filing margin on the left. */
export function frameOf(s: Sheet): [number, number, number, number] {
  const [W, H] = sheetSize(s);
  return s.format === "iso" ? [20, 10, W - 10, H - 10] : s.format === "gost" ? [20, 5, W - 5, H - 5] : [10, 10, W - 10, H - 10];
}

/** Title block size: ISO/ANSI 180 × 40, GOST 2.104 form 1 185 × 55. */
export function tbSize(s: Sheet): [number, number] { return s.format === "gost" ? [185, 55] : [TB_W, TB_H]; }

export const TB_W = 180;
export const TB_H = 40;

/** Title block cells: position in the block (mm from its bottom-left), the field and its label. */
interface Cell { x: number; y: number; w: number; h: number; key: keyof Fields; label: string; ansi: string; big?: boolean }
export type Fields = Required<DrawingProps> & { scale: string; sheet: string; size: string; units: string };
const CELLS: Cell[] = [
  { x: 0, y: 24, w: 100, h: 16, key: "company", label: "Company", ansi: "COMPANY", big: true },
  { x: 100, y: 24, w: 80, h: 16, key: "title", label: "Title", ansi: "TITLE", big: true },
  { x: 0, y: 16, w: 50, h: 8, key: "author", label: "Created by", ansi: "DRAWN" },
  { x: 50, y: 16, w: 50, h: 8, key: "material", label: "Material", ansi: "MATERIAL" },
  { x: 0, y: 8, w: 50, h: 8, key: "checked", label: "Checked by", ansi: "CHECKED" },
  { x: 50, y: 8, w: 25, h: 8, key: "mass", label: "Mass", ansi: "WEIGHT" },
  { x: 75, y: 8, w: 25, h: 8, key: "scale", label: "Scale", ansi: "SCALE" },
  { x: 0, y: 0, w: 50, h: 8, key: "approved", label: "Approved by", ansi: "APPROVED" },
  { x: 50, y: 0, w: 50, h: 8, key: "date", label: "Date", ansi: "DATE" },
  { x: 100, y: 16, w: 50, h: 8, key: "number", label: "Drawing number", ansi: "DWG NO" },
  { x: 150, y: 16, w: 12, h: 8, key: "revision", label: "Rev", ansi: "REV" },
  { x: 162, y: 16, w: 18, h: 8, key: "sheet", label: "Sheet", ansi: "SHEET" },
  { x: 100, y: 8, w: 20, h: 8, key: "size", label: "Size", ansi: "SIZE" },
  { x: 100, y: 0, w: 20, h: 8, key: "units", label: "Units", ansi: "UNITS" },
];
/**
 * GOST 2.104 form 1 (185 × 55): change rows and signatures on the left (columns 7/10/23/15/10),
 * designation, name, letter/mass/scale, sheet/sheets, material and company on the right.
 * Value cells carry the field; label-only cells have no key.
 */
interface GCell { x: number; y: number; w: number; h: number; key?: keyof Fields; label?: string; big?: boolean; thick?: boolean; /** One character of the value (the letter cells). */ ch?: number }
const GOST: GCell[] = (() => {
  const cols = [0, 7, 17, 40, 55, 65], out: GCell[] = [];
  // Rows of 5 mm on the left: 4 change rows, the header row, then 6 signature rows.
  for (let r = 0; r < 11; r++) {
    // Signature rows join the first two columns.
    const cs = r < 5 ? cols : [0, 17, 40, 55, 65];
    for (let c = 0; c + 1 < cs.length; c++) out.push({ x: cs[c], y: 50 - r * 5, w: cs[c + 1] - cs[c], h: 5 });
  }
  const head = ["Chg.", "Sheet", "Doc. No.", "Sign.", "Date"];
  head.forEach((l, c) => { out.push({ x: cols[c], y: 30, w: cols[c + 1] - cols[c], h: 5, label: l }); });
  const roles: [string, keyof Fields | undefined][] = [["Developed", "author"], ["Checked", "checked"], ["T. control", "tcontrol"], ["", undefined], ["N. control", "ncontrol"], ["Appr.", "approved"]];
  roles.forEach(([l, k], i) => {
    const y = 25 - i * 5;
    if (l) out.push({ x: 0, y, w: 17, h: 5, label: l });
    if (k) out.push({ x: 17, y, w: 23, h: 5, key: k });
  });
  out.push({ x: 55, y: 25, w: 10, h: 5, key: "date" });
  out.push(
    { x: 65, y: 40, w: 120, h: 15, key: "number", big: true, thick: true },
    { x: 65, y: 15, w: 70, h: 25, key: "title", big: true, thick: true },
    { x: 135, y: 35, w: 15, h: 5, label: "Lit." }, { x: 150, y: 35, w: 17, h: 5, label: "Mass" }, { x: 167, y: 35, w: 18, h: 5, label: "Scale" },
    { x: 135, y: 20, w: 5, h: 15, key: "litera", ch: 0 }, { x: 140, y: 20, w: 5, h: 15, key: "litera", ch: 1 }, { x: 145, y: 20, w: 5, h: 15, key: "litera", ch: 2 },
    { x: 150, y: 20, w: 17, h: 15, key: "mass" }, { x: 167, y: 20, w: 18, h: 15, key: "scale" },
    { x: 135, y: 15, w: 20, h: 5, key: "sheet", label: "Sheet" }, { x: 155, y: 15, w: 30, h: 5, key: "size", label: "No. of sheets" },
    { x: 65, y: 0, w: 70, h: 15, key: "material", big: true, thick: true },
    { x: 135, y: 0, w: 50, h: 15, key: "company", big: true, thick: true },
  );
  return out;
})();

/** Fields a user can type (the others come from the sheet). */
export const EDITABLE: (keyof DrawingProps)[] = ["title", "number", "revision", "material", "mass", "company", "author", "checked", "approved", "date"];
export const FIELD_LABEL: Record<keyof DrawingProps, string> = {
  title: "Title", number: "Drawing number", revision: "Rev", material: "Material", mass: "Mass", company: "Company",
  author: "Created by", checked: "Checked by", approved: "Approved by", date: "Date",
  tcontrol: "Technical control", ncontrol: "Standards control", litera: "Drawing letter",
};
/** Fields only the GOST title block has. */
export const GOST_EDITABLE: (keyof DrawingProps)[] = ["tcontrol", "ncontrol", "litera"];
/** The fields a sheet's title block lets the user type. */
export const editableOf = (s: Sheet): (keyof DrawingProps)[] => s.format === "gost" ? [...EDITABLE, ...GOST_EDITABLE] : EDITABLE;

/** Bottom-left corner of the title block (it sits in the frame's bottom-right corner). */
export function titleBlockAt(s: Sheet): [number, number] {
  const f = frameOf(s);
  return [f[2] - tbSize(s)[0], f[1]];
}

/** Which title block field is under a sheet point, if any. */
export function fieldAt(s: Sheet, x: number, y: number): keyof DrawingProps | null {
  const [bx, by] = titleBlockAt(s);
  if (s.format === "gost") {
    for (const c of GOST) if (c.key && x >= bx + c.x && x <= bx + c.x + c.w && y >= by + c.y && y <= by + c.y + c.h) return (editableOf(s) as string[]).includes(c.key) ? c.key as keyof DrawingProps : null;
    return null;
  }
  for (const c of CELLS) if (x >= bx + c.x && x <= bx + c.x + c.w && y >= by + c.y && y <= by + c.y + c.h) return (EDITABLE as string[]).includes(c.key) ? c.key as keyof DrawingProps : null;
  return null;
}

/** Fits text into a cell width: Helvetica-like glyphs are ~0.55 of the height wide. */
function fitH(s: string, h: number, w: number) { return Math.max(1.8, Math.min(h, w / Math.max(1, s.length * 0.56))); }

/** The frame, zone marks and title block. Labels come translated through `label`. */
export function formatPrims(s: Sheet, f: Fields, label: (cellLabel: string) => string): Prim[] {
  const out: Prim[] = [];
  const [W, H] = sheetSize(s);
  const [x0, y0, x1, y1] = frameOf(s);
  out.push(...rect(0, 0, W, H, "thin", "FORMAT"));
  out.push(...rect(x0, y0, x1 - x0, y1 - y0, "frame", "FORMAT"));
  if (s.format === "gost") { out.push(...gostBlock(s, f, label)); return out; }
  // Zones (ISO 5457): fields of about 50 mm, numbers along the top and bottom, letters up the sides.
  const nx = Math.max(2, Math.round((x1 - x0) / 50)), ny = Math.max(2, Math.round((y1 - y0) / 50));
  const ztick = 5;
  for (let i = 0; i <= nx; i++) {
    const x = x0 + (x1 - x0) * i / nx;
    if (i > 0 && i < nx) { out.push({ t: "l", p: [x, y1, x, y1 + ztick], pen: "thin", layer: "FORMAT" }, { t: "l", p: [x, y0, x, y0 - ztick], pen: "thin", layer: "FORMAT" }); }
    if (i < nx) {
      const cx = x0 + (x1 - x0) * (i + 0.5) / nx, n = String(i + 1);
      out.push({ t: "t", x: cx, y: y1 + 3.2, s: n, h: 2.5, al: "c", layer: "FORMAT" }, { t: "t", x: cx, y: y0 - 6.8, s: n, h: 2.5, al: "c", layer: "FORMAT" });
    }
  }
  for (let j = 0; j <= ny; j++) {
    const y = y0 + (y1 - y0) * j / ny;
    if (j > 0 && j < ny) out.push({ t: "l", p: [x0, y, x0 - ztick, y], pen: "thin", layer: "FORMAT" }, { t: "l", p: [x1, y, x1 + ztick, y], pen: "thin", layer: "FORMAT" });
    if (j < ny) {
      const cy = y1 - (y1 - y0) * (j + 0.5) / ny - 1.2, L = String.fromCharCode(65 + (j % 26));
      out.push({ t: "t", x: x0 - 3, y: cy, s: L, h: 2.5, al: "c", layer: "FORMAT" }, { t: "t", x: x1 + 3, y: cy, s: L, h: 2.5, al: "c", layer: "FORMAT" });
    }
  }
  // Title block.
  const [bx, by] = titleBlockAt(s);
  out.push(...rect(bx, by, TB_W, TB_H, "frame", "FORMAT"));
  for (const c of CELLS) {
    out.push(...rect(bx + c.x, by + c.y, c.w, c.h, "thin", "FORMAT"));
    out.push({ t: "t", x: bx + c.x + 1, y: by + c.y + c.h - 2.6, s: s.format === "ansi" ? c.ansi : label(c.label), h: 1.8, al: "l", layer: "FORMAT" });
    const v = String(f[c.key] ?? "");
    if (v) {
      const h = fitH(v, c.big ? 5 : 3, c.w - 2);
      out.push({ t: "t", x: bx + c.x + c.w / 2, y: by + c.y + (c.big ? c.h / 2 - h / 2 - 1 : 1.3), s: v, h, al: "c", layer: "TEXT", bold: c.big });
    }
  }
  // Projection symbol (ISO 128-30 / ASME Y14.3): a truncated cone and its end view.
  const px = bx + 120, pw = 60;
  out.push(...rect(px, by, pw, 16, "thin", "FORMAT"));
  out.push({ t: "t", x: px + 1, y: by + 13.4, s: s.format === "ansi" ? (s.projection === "third" ? "THIRD ANGLE PROJECTION" : "FIRST ANGLE PROJECTION") : label(s.projection === "third" ? "Third angle projection" : "First angle projection"), h: 1.8, al: "l", layer: "FORMAT" });
  const cy = by + 6, D = 7, d = 3.5, L = 9;
  const trap = (x: number) => [
    { t: "l" as const, p: [x, cy - d / 2, x, cy + d / 2] as [number, number, number, number] },
    { t: "l" as const, p: [x + L, cy - D / 2, x + L, cy + D / 2] as [number, number, number, number] },
    { t: "l" as const, p: [x, cy - d / 2, x + L, cy - D / 2] as [number, number, number, number] },
    { t: "l" as const, p: [x, cy + d / 2, x + L, cy + D / 2] as [number, number, number, number] },
  ].map(p => ({ ...p, pen: "thin" as const, layer: "FORMAT" as const }));
  const circ = (x: number): Prim[] => [
    { t: "a", o: [x, cy], r: D / 2, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "FORMAT" },
    { t: "a", o: [x, cy], r: d / 2, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "FORMAT" },
  ];
  const sx = px + pw / 2 - 12;
  if (s.projection === "third") out.push(...circ(sx + D / 2), ...trap(sx + D + 5));
  else out.push(...trap(sx), ...circ(sx + L + 5 + D / 2));
  return out;
}

/** GOST 2.104 form 1 title block. "sheet" holds n/m: n goes in Sheet, m in Sheets. */
function gostBlock(s: Sheet, f: Fields, label: (cellLabel: string) => string): Prim[] {
  const out: Prim[] = [];
  const [bx, by] = titleBlockAt(s);
  out.push(...rect(bx, by, 185, 55, "frame", "FORMAT"));
  const [n, m] = String(f.sheet).split("/");
  for (const c of GOST) {
    out.push(...rect(bx + c.x, by + c.y, c.w, c.h, c.thick ? "frame" : "thin", "FORMAT"));
    if (c.label) { const l = label(c.label); out.push({ t: "t", x: bx + c.x + (c.key ? 1 : c.w / 2), y: by + c.y + (c.key ? c.h - 2.6 : 1.4), s: l, h: c.key ? 1.8 : fitH(l, 2.5, c.w - 1), al: c.key ? "l" : "c", layer: "FORMAT" }); }
    if (!c.key) continue;
    const v = c.key === "sheet" ? n ?? "" : c.key === "size" ? m ?? "" : c.ch !== undefined ? [...String(f[c.key] ?? "")][c.ch] ?? "" : String(f[c.key] ?? "");
    if (!v) continue;
    const h = fitH(v, c.big ? 5 : c.h >= 10 ? 3.5 : 2.5, c.w - 2);
    const y = c.label ? by + c.y + 0.6 : by + c.y + c.h / 2 - h / 2;
    out.push({ t: "t", x: c.label ? bx + c.x + c.w - 1 : bx + c.x + c.w / 2, y, s: v, h: c.label ? Math.min(h, 2.5) : h, al: c.label ? "r" : "c", layer: "TEXT", bold: c.big });
  }
  return out;
}
