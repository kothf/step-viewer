// Drawing primitives in sheet millimetres (origin at the bottom-left corner, y up).
// The sheet is composed once into primitives; the screen (SVG), PDF, DXF and print
// all draw the same list, so every output matches what is on screen.

/** Line types (ISO 128): thick visible, thin, hidden (dashed), centre (long dash dot). */
export type Pen = "thick" | "thin" | "hidden" | "center" | "frame";
/** DXF layers / SVG classes. */
export type Layer = "VISIBLE" | "TANGENT" | "HIDDEN" | "CENTER" | "FORMAT" | "TEXT" | "SKETCH" | "HATCH" | "ANNOT" | "THREAD";

export type Prim =
  | { t: "l"; p: [number, number, number, number]; pen: Pen; layer: Layer }
  /** Counter-clockwise arc from a0 to a1 (radians). */
  | { t: "a"; o: [number, number]; r: number; a0: number; a1: number; pen: Pen; layer: Layer }
  | { t: "p"; p: number[]; pen: Pen; layer: Layer; closed?: boolean; fill?: boolean }
  /** Text: baseline point, height in mm, horizontal alignment, optional rotation (degrees, CCW). */
  | { t: "t"; x: number; y: number; s: string; h: number; al: "l" | "c" | "r"; layer: Layer; bold?: boolean; rot?: number };
/** Text `rot` is in degrees, counter-clockwise, about the baseline point. */

/** Line widths in mm (ISO 128 pen group 0.35 / 0.18; the frame 0.5). */
export const PEN_W: Record<Pen, number> = { thick: 0.35, thin: 0.18, hidden: 0.18, center: 0.18, frame: 0.5 };
/** Dash patterns in mm (ISO 128: hidden 3/1.5, centre 12/3/1.5/3). */
export const PEN_DASH: Record<Pen, number[] | null> = { thick: null, thin: null, frame: null, hidden: [3, 1.5], center: [12, 2, 1.5, 2] };

export function rect(x: number, y: number, w: number, h: number, pen: Pen, layer: Layer): Prim[] {
  return [
    { t: "l", p: [x, y, x + w, y], pen, layer }, { t: "l", p: [x + w, y, x + w, y + h], pen, layer },
    { t: "l", p: [x + w, y + h, x, y + h], pen, layer }, { t: "l", p: [x, y + h, x, y], pen, layer },
  ];
}

/** Primitives turned by `ang` radians (counter-clockwise) about `o`. */
export function rotatePrims(prims: Prim[], o: [number, number], ang: number): Prim[] {
  if (!ang) return prims;
  const c = Math.cos(ang), s = Math.sin(ang);
  const r = (x: number, y: number): [number, number] => [o[0] + (x - o[0]) * c - (y - o[1]) * s, o[1] + (x - o[0]) * s + (y - o[1]) * c];
  return prims.map((q): Prim => {
    if (q.t === "l") { const a = r(q.p[0], q.p[1]), b = r(q.p[2], q.p[3]); return { ...q, p: [a[0], a[1], b[0], b[1]] }; }
    if (q.t === "a") return { ...q, o: r(...q.o), a0: q.a0 + ang, a1: q.a1 + ang };
    if (q.t === "p") { const p: number[] = []; for (let i = 0; i + 1 < q.p.length; i += 2) p.push(...r(q.p[i], q.p[i + 1])); return { ...q, p }; }
    const [x, y] = r(q.x, q.y);
    return { ...q, x, y, rot: (q.rot ?? 0) + ang * 180 / Math.PI };
  });
}

/** The box around box `b` turned by `ang` about `o`. */
export function rotateBox(b: [number, number, number, number], o: [number, number], ang: number): [number, number, number, number] {
  if (!ang) return b;
  const c = Math.cos(ang), s = Math.sin(ang);
  const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => [o[0] + (x - o[0]) * c - (y - o[1]) * s, o[1] + (x - o[0]) * s + (y - o[1]) * c]);
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}
