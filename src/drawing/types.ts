// Drawing documents (FRS section 11): sheets with a sheet format and views of one
// model. Views store how they were made (orientation, or parent + side for a
// projected view); their lines are computed by the drawing worker and never stored.
import type { V3, ViewDir } from "../kernel/drawing";
import type { PartDoc } from "../model/types";

export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D" | "ANSI E" | "custom";
export type Projection = "first" | "third";
/** Display style (FR-DRW-010): visible + hidden dashed, hidden removed, all edges as visible (wireframe). */
export type DisplayStyle = "hlv" | "hlr" | "wire";
export type TangentEdges = "visible" | "thin" | "hidden";
export type Orient = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso" | "current";

export interface DrawingView {
  id: string;
  name: string;
  /** Model view: a named orientation (with its direction); projected view: parent and side (−1, 0, 1 each). */
  orient?: Orient;
  dir?: ViewDir;
  parent?: string;
  side?: [number, number];
  /** Centre of the view's box on the sheet (mm from the bottom-left corner, y up). */
  x: number;
  y: number;
  /** Own scale as [numerator, denominator]; absent: the sheet scale (projected views: the parent's). */
  scale?: [number, number];
  style?: DisplayStyle;
  tangent?: TangentEdges;
  /** Show the label under the view (projected and model views have none by default). */
  label?: boolean;
}

export interface Sheet {
  id: string;
  name: string;
  size: SheetSize;
  /** Custom size in mm (landscape: w > h). */
  w?: number;
  h?: number;
  portrait?: boolean;
  scale: [number, number];
  projection: Projection;
  /** Sheet format: ISO 7200 or ANSI Y14.1 title block (GOST later). */
  format: "iso" | "ansi";
  views: DrawingView[];
}

/** Title block fields (FR-DRW-003); empty ones come from the model or the sheet. */
export interface DrawingProps {
  title?: string;
  number?: string;
  revision?: string;
  material?: string;
  mass?: string;
  author?: string;
  checked?: string;
  approved?: string;
  company?: string;
  date?: string;
}

export interface DrawingDoc {
  schema: 1;
  kind: "drawing";
  id: string;
  name: string;
  sheets: Sheet[];
  props: DrawingProps;
  /** The model shown: a part document, or a STEP/IGES/BREP file kept in the drawing file. */
  source: { kind: "part"; doc: PartDoc; name: string } | { kind: "file"; name: string };
}

/** Model facts for the title block. */
export interface ModelInfo { title: string; number?: string; revision?: string; author?: string; material?: string; mass?: number; box: [V3, V3] }
