// Datum targets on drawings (ISO 5459, FR-DRW-023): a frame circle split by a horizontal line, the target area's size in
// the upper half and the datum letter with the target number in the lower half; a plain leader (no arrow) to the target,
// which is a cross for a point, a cross on a phantom line for a line, and a hatched phantom circle for an area.
import type { Prim } from "./prims";
import type { DatumTargetAnnot } from "./types";
import { textWidth } from "./textWidth";

type P2 = [number, number];
type Box = [number, number, number, number];
const H = 2.5;
const L = (a: P2, b: P2, pen: "thin" | "thick" | "phantom" = "thin"): Prim => ({ t: "l", p: [a[0], a[1], b[0], b[1]], pen, layer: "ANNOT" });
const T = (x: number, y: number, s: string): Prim => ({ t: "t", x, y, s, h: H, al: "c", layer: "ANNOT" });

/** The frame circle's radius: 4.5 mm, or more for long texts. */
export function targetRadius(a: Pick<DatumTargetAnnot, "label" | "size">): number {
  const w = Math.max(textWidth(a.label || "", H), textWidth(a.size ?? "", H));
  return Math.max(4.5, w / 2 + 1.2);
}

/** Size of the target marker on the sheet: area diameter or line length (model mm × view scale), at least 2 mm. */
const markSize = (a: DatumTargetAnnot, s: number) => Math.max(2, (a.d ?? (a.kind === "area" ? 8 : 10)) * s);

/**
 * The datum target with its frame centred at `at` (sheet mm) and the target at `to` when it has one; `d` is the target
 * edge's direction on the sheet (a line target runs along it), `s` the view scale.
 */
export function dtargetPrims(a: DatumTargetAnnot, at: P2, to: P2 | null, d: P2 = [1, 0], s = 1): { prims: Prim[]; box: Box } {
  const out: Prim[] = [];
  const R = targetRadius(a);
  out.push({ t: "a", o: at, r: R, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" }, L([at[0] - R, at[1]], [at[0] + R, at[1]]));
  if (a.size) out.push(T(at[0], at[1] + 0.9, a.size));
  if (a.label) out.push(T(at[0], at[1] - 0.9 - H, a.label));
  // Picked and dragged by its frame only.
  const box: Box = [at[0] - R, at[1] - R, at[0] + R, at[1] + R];
  if (to) {
    const v: P2 = [to[0] - at[0], to[1] - at[1]], n = Math.hypot(v[0], v[1]) || 1, u: P2 = [v[0] / n, v[1] / n];
    // The leader stops at the area's outline, or at the cross.
    const r = a.kind === "area" ? markSize(a, s) / 2 : 0;
    if (n > R + r + 0.5) out.push(L([at[0] + u[0] * R, at[1] + u[1] * R], [to[0] - u[0] * r, to[1] - u[1] * r]));
    if (a.kind === "area") {
      out.push({ t: "a", o: to, r, a0: 0, a1: 2 * Math.PI, pen: "phantom", layer: "ANNOT" });
      // 45° hatching 1.5 mm apart, clipped to the circle.
      for (let k = -r + 0.75; k < r; k += 1.5) {
        const h = Math.sqrt(r * r - k * k), c = Math.SQRT1_2;
        // Lines x − y = k·√2 through the circle: points along (c, c) offset by k along (c, −c).
        const m: P2 = [to[0] + k * c, to[1] - k * c];
        out.push(L([m[0] - h * c, m[1] - h * c], [m[0] + h * c, m[1] + h * c]));
      }
    } else {
      const q = 1.5;
      out.push(L([to[0] - q, to[1] - q], [to[0] + q, to[1] + q], "thick"), L([to[0] - q, to[1] + q], [to[0] + q, to[1] - q], "thick"));
      if (a.kind === "line") {
        const dn = Math.hypot(d[0], d[1]) || 1, e: P2 = [d[0] / dn, d[1] / dn], hl = markSize(a, s) / 2;
        out.push(L([to[0] - e[0] * hl, to[1] - e[1] * hl], [to[0] + e[0] * hl, to[1] + e[1] * hl], "phantom"));
      }
    }
  }
  return { prims: out, box };
}
