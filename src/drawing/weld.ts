// Weld symbols on drawings (ISO 2553 system A, FR-DRW-023): an arrow line to the joint, a reference line with
// the dashed identification line when the other side is welded, the elementary symbols drawn from lines (so they
// come out the same in SVG, PDF and DXF), the size before and the length after the symbol, the all-round circle
// and field flag at the knee, and an optional tail with its note.
import { arrowHead } from "./compose";
import type { Prim } from "./prims";
import type { WeldAnnot, WeldSide, WeldSym } from "./types";

type P2 = [number, number];
type Box = [number, number, number, number];
const H = 2.5;
/** Height of a symbol drawn on the reference line (mm). */
const K = 3;
const tw = (s: string, h = H) => s.length * h * 0.85;
const L = (a: P2, b: P2, dash = false): Prim => ({ t: "l", p: [a[0], a[1], b[0], b[1]], pen: dash ? "hidden" : "thin", layer: "ANNOT" });
const T = (x: number, y: number, s: string, al: "l" | "c" | "r" = "l"): Prim => ({ t: "t", x, y, s, h: H, al, layer: "ANNOT" });

export const WELD_SYMS: WeldSym[] = ["fillet", "square", "v", "bevel", "plug", "spot"];
export const WELD_SYM_NAMES: Record<WeldSym, string> = { fillet: "Fillet", square: "Square butt", v: "Single V butt", bevel: "Single bevel butt", plug: "Plug", spot: "Spot" };

/** One elementary symbol with its middle at x on the line y; `s` = +1 above the line, −1 below. */
export function weldSymPrims(sym: WeldSym, x: number, y: number, s: 1 | -1): Prim[] {
  const k = K, at = (u: number, v: number): P2 => [x + u, y + s * v];
  switch (sym) {
    case "fillet": return [{ t: "p", p: [...at(-k / 2, 0), ...at(-k / 2, k), ...at(k / 2, 0)], pen: "thin", layer: "ANNOT", closed: true }];
    case "square": return [L(at(-0.7, 0), at(-0.7, k)), L(at(0.7, 0), at(0.7, k))];
    case "v": return [L(at(0, 0), at(-k / 2, k)), L(at(0, 0), at(k / 2, k))];
    case "bevel": return [L(at(-k / 4, 0), at(-k / 4, k)), L(at(-k / 4, 0), at(k / 2, k))];
    case "plug": return [{ t: "p", p: [...at(-k / 2, 0), ...at(-k / 2, k * 0.6), ...at(k / 2, k * 0.6), ...at(k / 2, 0)], pen: "thin", layer: "ANNOT" }];
    case "spot": return [{ t: "a", o: at(0, k / 2.5), r: k / 2.5, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" }];
  }
}

/** Width the size, symbol and length of one side take on the reference line. */
const sideW = (w: WeldSide | undefined) => (w ? (w.size ? tw(w.size) + 0.8 : 0) + K + (w.len ? tw(w.len) + 0.8 : 0) : 0);

/**
 * The weld symbol with its knee at `knee` (sheet mm) and the arrow to `to` (the joint) when it has one. The reference
 * line runs away from the arrow, so its far end (the tail) never crosses the arrow line.
 */
export function weldPrims(a: WeldAnnot, knee: P2, to: P2 | null): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const both = !!a.arrow && !!a.other;
  // A symmetric weld (the same both sides) sits across the line; then no identification line is needed.
  const same = both && a.arrow!.sym === a.other!.sym && a.arrow!.size === a.other!.size && a.arrow!.len === a.other!.len;
  const W = Math.max(14, Math.max(sideW(a.arrow), sideW(a.other)) + 6);
  const left = !!to && to[0] > knee[0] + 1e-9;
  const x0 = left ? knee[0] - W : knee[0], x1 = x0 + W, y = knee[1];
  out.push(L([x0, y], [x1, y]));
  const dashY = y + 1;
  if (a.other && !same) out.push(L([x0 + 1, dashY], [x1 - 1, dashY], true));
  // Size, symbol, length from 2 mm after the knee end, read left to right.
  const place = (w: WeldSide, s: 1 | -1, base: number) => {
    let x = (left ? x1 - 2 - sideW(w) : x0 + 2);
    const ty = s > 0 ? base + 0.6 : base - 0.6 - H;
    if (w.size) { out.push(T(x, ty + (s > 0 ? 0.4 : 0), w.size)); x += tw(w.size) + 0.8; }
    out.push(...weldSymPrims(w.sym, x + K / 2, base, s));
    x += K + 0.8;
    if (w.len) out.push(T(x, ty + (s > 0 ? 0.4 : 0), w.len));
  };
  if (a.arrow) place(a.arrow, -1, y);
  if (a.other) place(a.other, 1, same ? y : dashY);
  if (to) {
    out.push(L(knee, to));
    const d = [to[0] - knee[0], to[1] - knee[1]], n = Math.hypot(d[0], d[1]) || 1;
    out.push(arrowHead(to[0], to[1], d[0] / n, d[1] / n, 3, 1));
  }
  if (a.around) out.push({ t: "a", o: knee, r: 1.5, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
  if (a.field) {
    const top: P2 = [knee[0], y + 5];
    out.push(L(knee, top), { t: "p", p: [top[0], top[1], top[0] + (left ? -3 : 3), top[1] - 1, top[0], top[1] - 2], pen: "thin", layer: "ANNOT", closed: true, fill: true });
  }
  let bx0 = x0, bx1 = x1;
  if (a.tail) {
    const e = left ? x0 : x1, g = left ? -1 : 1;
    out.push(L([e, y], [e + g * 2, y + 2]), L([e, y], [e + g * 2, y - 2]));
    out.push(T(e + g * 2.8, y - H / 2, a.tail, left ? "r" : "l"));
    if (left) bx0 = e - 2.8 - tw(a.tail); else bx1 = e + 2.8 + tw(a.tail);
  }
  const yTop = y + (a.field ? 5 : 0) + (a.other ? K + 1.6 : 1.5), yBot = y - (a.arrow ? K + 0.6 : 1.5);
  return { prims: out, box: [bx0, Math.min(yBot, y - 2), bx1, yTop] };
}
