// Shared data model for the Gerber / Excellon viewer. All coordinates are
// board millimetres with Y up (Gerber's own orientation).

export type Attrs = Record<string, string>;

/** A shape primitive: a capsule (a circle when a == b) or a CCW polygon (flat x,y list). */
export type Prim =
  | { k: "c"; ax: number; ay: number; bx: number; by: number; r: number }
  | { k: "p"; pts: number[] };

export interface ApDef {
  code: number;
  /** "C" "R" "O" "P", or the macro name. */
  shape: string;
  params: number[];
  /** Flash shape at the origin; exposure-off parts and holes go in `clear`. */
  prims: Prim[];
  clear: Prim[];
  attrs?: Attrs;
}

/** One contour vertex; `arc` means the segment from the previous vertex to this one is a circular arc. */
export interface CV { x: number; y: number; arc?: { cx: number; cy: number; ccw: boolean } }

export type GObj =
  | { t: "flash"; x: number; y: number; ap: number; dark: boolean; a?: Attrs }
  | { t: "track"; x1: number; y1: number; x2: number; y2: number; ap: number; dark: boolean; a?: Attrs }
  | { t: "arc"; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; ccw: boolean; ap: number; dark: boolean; a?: Attrs }
  | { t: "region"; contours: CV[][]; dark: boolean; a?: Attrs }
  | { t: "hole"; x: number; y: number; d: number; tool: number; plated: boolean | null }
  | { t: "slot"; x1: number; y1: number; x2: number; y2: number; d: number; tool: number; plated: boolean | null };

export type LayerKind = "copper" | "mask" | "silk" | "paste" | "outline" | "drill" | "other";
export type Side = "top" | "bottom" | "inner" | null;

export interface ParsedLayer {
  name: string;
  format: "gerber" | "excellon";
  kind: LayerKind;
  side: Side;
  /** Human label, e.g. "Top copper". */
  label: string;
  /** Default stacking rank: higher draws later (on top). */
  rank: number;
  objs: GObj[];
  apertures: Record<number, ApDef>;
  fileAttrs: Attrs;
  warnings: string[];
  units: "mm" | "in";
}

export type GUnit = "mm" | "in" | "mil";
export const G_UNITS: Record<GUnit, number> = { mm: 1, in: 1 / 25.4, mil: 1 / 0.0254 };
