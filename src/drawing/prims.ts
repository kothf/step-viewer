// Drawing primitives in sheet millimetres (origin at the bottom-left corner, y up).
// The sheet is composed once into primitives; the screen (SVG), PDF, DXF and print
// all draw the same list, so every output matches what is on screen.

/** Line types (ISO 128): thick visible, thin, hidden (dashed), centre (long dash dot). */
export type Pen = "thick" | "thin" | "hidden" | "center" | "frame";
/** DXF layers / SVG classes. */
export type Layer = "VISIBLE" | "TANGENT" | "HIDDEN" | "CENTER" | "FORMAT" | "TEXT" | "SKETCH";

export type Prim =
  | { t: "l"; p: [number, number, number, number]; pen: Pen; layer: Layer }
  /** Counter-clockwise arc from a0 to a1 (radians). */
  | { t: "a"; o: [number, number]; r: number; a0: number; a1: number; pen: Pen; layer: Layer }
  | { t: "p"; p: number[]; pen: Pen; layer: Layer; closed?: boolean }
  /** Text: baseline point, height in mm, horizontal alignment. */
  | { t: "t"; x: number; y: number; s: string; h: number; al: "l" | "c" | "r"; layer: Layer; bold?: boolean };

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
