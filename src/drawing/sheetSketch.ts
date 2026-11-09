// Sketch entities on the drawing sheet (SolidWorks' sketch in a drawing): lines, rectangles, circles and polylines in
// sheet millimetres, drawn with an ISO 128 line type, for marking up a sheet beside the projected views.
import type { Pen, Prim, Layer } from "./prims";
import type { SketchAnnot, SkPen } from "./types";

type P2 = [number, number];
export const SK_PENS: SkPen[] = ["thin", "thick", "center", "hidden", "phantom"];
export const SK_PEN_NAMES: Record<SkPen, string> = { thin: "Thin line", thick: "Visible line", center: "Centre line", hidden: "Hidden line", phantom: "Phantom line" };
const LAYER: Record<SkPen, Layer> = { thin: "ANNOT", thick: "VISIBLE", center: "CENTER", hidden: "HIDDEN", phantom: "PHANTOM" };

/** The entity's corners/points in sheet mm (a circle: centre and the radius point; a polyline's `pts` start with 0, 0). */
export function skPoints(a: SketchAnnot): P2[] {
  const out: P2[] = a.k === "poly" ? [] : [[a.pos[0], a.pos[1]]];
  for (let i = 0; i + 1 < a.pts.length; i += 2) out.push([a.pos[0] + a.pts[i], a.pos[1] + a.pts[i + 1]]);
  if (a.k === "rect" && out.length === 2) { const [p, q] = out; return [p, [q[0], p[1]], q, [p[0], q[1]]]; }
  return out;
}

/** Primitives, pick box and pick outline (`ring`, `open` = not closed) of a sheet sketch entity. */
export function skPrims(a: SketchAnnot): { prims: Prim[]; box: [number, number, number, number]; ring: number[]; open: boolean } {
  const pen: Pen = a.pen ?? "thin", layer = LAYER[a.pen ?? "thin"], prims: Prim[] = [];
  const P = skPoints(a);
  if (a.k === "circle") {
    const c = a.pos, r = Math.hypot(a.pts[0] ?? 0, a.pts[1] ?? 0);
    prims.push({ t: "a", o: [c[0], c[1]], r, a0: 0, a1: 2 * Math.PI, pen, layer });
    const ring: number[] = [];
    for (let i = 0; i < 48; i++) { const t = (i / 48) * 2 * Math.PI; ring.push(c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)); }
    return { prims, box: [c[0] - r, c[1] - r, c[0] + r, c[1] + r], ring, open: false };
  }
  const closed = a.k === "rect" || (a.k === "poly" && !!a.closed && P.length >= 3);
  if (a.k === "line" && P.length >= 2) prims.push({ t: "l", p: [P[0][0], P[0][1], P[1][0], P[1][1]], pen, layer });
  else if (P.length >= 2) prims.push({ t: "p", p: P.flat(), pen, layer, ...(closed ? { closed: true } : {}) });
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]);
  return { prims, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], ring: P.flat(), open: !closed };
}

/** The point to use for a click at `p` after `prev`: horizontal or vertical when within 3° of it (SolidWorks' inference). */
export function orthoSnap(prev: P2 | undefined, p: P2): { p: P2; hv: "h" | "v" | null } {
  if (!prev) return { p, hv: null };
  const dx = p[0] - prev[0], dy = p[1] - prev[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) return { p, hv: null };
  const tol = Math.sin((3 * Math.PI) / 180);
  if (Math.abs(dy) / L < tol) return { p: [p[0], prev[1]], hv: "h" };
  if (Math.abs(dx) / L < tol) return { p: [prev[0], p[1]], hv: "v" };
  return { p, hv: null };
}
