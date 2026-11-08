// Drawing documents (FRS section 11): sheets with a sheet format and views of one
// model. Views store how they were made (orientation, or parent + side for a
// projected view); their lines are computed by the drawing worker and never stored.
import type { V3, ViewDir } from "../kernel/drawing";
import type { AsmDoc } from "../asm/types";
import type { PartDoc } from "../model/types";

export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D" | "ANSI E" | "custom";
export type Projection = "first" | "third";
/** Display style (FR-DRW-010): visible + hidden dashed, hidden removed, all edges as visible (wireframe), shaded, shaded with visible edges. */
export type DisplayStyle = "hlv" | "hlr" | "wire" | "shaded" | "shadedEdges";
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
  /** A part configuration to draw (FR-DRW-010), set on a model view; views made from it follow. Absent: the part's active one. */
  /** Assembly drawings: the top-level components a model view shows alone (a detail sheet of one part from the assembly);
   *  views made from it follow. Absent: every shown component. */
  only?: string[];
  config?: string;
  style?: DisplayStyle;
  tangent?: TangentEdges;
  /** Show the label under the view (projected and model views have none by default). */
  label?: boolean;
  /** Section, detail and auxiliary views (FR-DRW-012/013/014): made from `parent`; `side` is unused. */
  kind?: "section" | "detail" | "aux";
  /** Section: cutting line; aux: the edge viewed square-on. In the parent's view axes, model mm: [u1, v1, u2, v2]. */
  line?: [number, number, number, number];
  /** Offset and half sections (FR-DRW-012, P6): the whole cutting path as u, v pairs (parent view axes, model mm),
   * 3+ points; every leg is parallel or square to the first, which `line` repeats. Legs parallel to the first cut,
   * square legs only step between them; a path that ends on a square leg (half section) cuts no further. */
  path?: number[];
  /** Aligned section (FR-DRW-012, P6): `path` is [end 1, centre, end 2] and `line` its first leg; the material behind
   * the second leg is turned about the centre (the parent's view axis) into the plane of the first before it is drawn. */
  aligned?: boolean;
  /** Section of an assembly: top-level components left whole (FR-DRW-012), drawn uncut. */
  exclude?: string[];
  /** Section / aux: the view looks from this side of the line (+1: left of u1→u2, −1: right). */
  look?: 1 | -1;
  /** Detail: circle centre (parent's view axes, model mm) and radius (model mm). */
  c?: [number, number];
  r?: number;
  /** Detail drawn by a profile instead of a circle (FR-DRW-013): corners u, v in the parent's view axes; `c`/`r` are its box centre and reach. */
  outline?: number[];
  /** Letter of a section, detail or auxiliary view (A, B, …). */
  letter?: string;
  /** Section hatching: line spacing on the sheet (mm) and angle (degrees); default 2.5 mm at 45°. `pattern` (FR-DRW-012):
   * an ANSI pattern for every cut face, or "material" (absent): each component or body by its material, adjacent ones at other angles. */
  hatch?: { gap?: number; angle?: number; pattern?: HatchPattern };
  /** Centre marks on round edges seen end-on and centrelines on cylinders seen from the side (FR-DRW-023); false hides them. */
  marks?: boolean;
  /** Crop view (FR-DRW-015): only what lies inside this rectangle (view axes, model mm: [u0, v0, u1, v1]) is drawn. */
  crop?: [number, number, number, number];
  /** Break view (FR-DRW-015): bands between `a` and `b` along the view's u (vertical break lines) or v axis
   * (horizontal break lines), in model mm, are left out and the rest closes up to a 6 mm gap on the sheet. */
  breaks?: ViewBreak[];
  /** Cosmetic threads (FR-DRW-017, ISO 6410 thin lines and a ¾ circle); false hides them. */
  threads?: boolean;
  /** Flat pattern views: bend lines and their notes (false hides them). */
  bendLines?: boolean;
  bendNotes?: boolean;
  /** Show the sketches that are shown in the model, as thin lines (FR-DRW-017). */
  sketches?: boolean;
  /** Alignment with the parent broken (FR-DRW-017): the view moves on its own and stays put when the parent moves. */
  free?: boolean;
  /** Broken-out section (FR-DRW-015): material inside `poly` (u, v pairs in view axes, model mm) is cut away
   * from the viewer down to the plane at `d` along the view direction (n · p, model mm), and the cut is hatched. */
  broken?: { poly: number[]; d: number };
  /** Alternate position (FR-DRW-015, assembly drawings): components drawn again, moved, in phantom lines. */
  alt?: AltMove[];
}

/**
 * A component's alternate position, in the view's axes: turned by `ang` degrees (counter-clockwise as seen)
 * about `c` (model mm), then moved by `du`, `dv` (mm). `comp` is a top-level component id; its sub-components go with it.
 */
export interface AltMove { comp: string; du: number; dv: number; ang?: number; c?: [number, number] }

export interface ViewBreak { axis: "u" | "v"; a: number; b: number }

/**
 * What an annotation is attached to (FR-DRW-021): a model edge by its key (the names of the faces
 * it joins) with its middle as a hint, and which part of it: an end (the one nearer `q`), the centre
 * of a circle, or the whole edge. Or a fixed model point (model items, whose points are rebuilt).
 */
export type GeoRef = { e: string; h: V3; p: "a" | "b" | "c" | "e"; q?: V3 } | { pt: V3 };

/** Tolerance (FR-DRW-021): symmetric ±up, deviations +up/−lo, limits, or an ISO 286 fit code. */
export interface Tol { t: "sym" | "dev" | "limit" | "fit"; up?: number; lo?: number; fit?: string;
  /** Fit display: the code (default), its ISO 286 deviations, or both; a hole/shaft pair always shows the code. */
  show?: "code" | "limits" | "both" }

/** A dimension: horizontal, vertical or aligned between two points (or a line's ends), radius, diameter, the angle of two lines,
 *  the length of an arc seen end-on ("arc"), a chamfer (the shorter of two lines against the other: "1 × 45°"), or an ordinate
 *  ("oh" / "ov": refs = [base point, point], the value is the horizontal / vertical distance from the base, `pos` is where its text sits). */
export interface DimAnnot {
  id: string; t: "dim"; view: string;
  k: "h" | "v" | "al" | "rad" | "dia" | "ang" | "arc" | "chamfer" | "oh" | "ov";
  refs: GeoRef[];
  /** Where the dimension line passes / the text sits, in the view's model axes (mm). */
  pos: [number, number];
  /** Decimals shown (absent: up to 2, trailing zeros dropped). */
  prec?: number;
  tol?: Tol;
  pre?: string;
  suf?: string;
  /** Text typed over the value. */
  txt?: string;
  /** Model item it was imported from (`<feature>:<dimension>`): its points are rebuilt from the part. */
  src?: string;
  /** Inspection dimension (FR-DRW-021): the text sits in an obround frame. */
  insp?: boolean;
}

/** A note: on the sheet (sheet mm) or on a view (its model axes, so it moves with the view), with an optional leader to the model. */
export interface NoteAnnot { id: string; t: "note"; view?: string; pos: [number, number]; text: string; h?: number; leader?: GeoRef }

/** A hole callout (FR-DRW-022) on a round edge, from the hole feature when there is one. */
export interface HoleAnnot { id: string; t: "hole"; view: string; ref: GeoRef; pos: [number, number]; txt?: string }

/** Geometric characteristics (ISO 1101 / ASME Y14.5). */
export type GSym = "straight" | "flat" | "circ" | "cyl" | "pline" | "psurf" | "par" | "perp" | "ang" | "pos" | "conc" | "sym" | "runout" | "trunout";
/** One row of a feature control frame: symbol, tolerance (Ø for a cylindrical zone, M/L material condition), datums. */
/** `composite`: shares the characteristic of the row above (a composite frame, ISO 5458 / ASME Y14.5). */
export interface GRow { sym: GSym; tol: string; dia?: boolean; mod?: "M" | "L"; datums: string[]; composite?: boolean }
/** Geometric tolerance (FR-DRW-023): a feature control frame with a leader to the model (or free). */
/** `around`: the all-around circle at the leader's bend (the tolerance applies all around the profile). */
export interface GtolAnnot { id: string; t: "gtol"; view?: string; pos: [number, number]; rows: GRow[]; leader?: GeoRef; around?: boolean }
/** Datum feature symbol: a filled triangle on an edge and a framed letter. */
export interface DatumAnnot { id: string; t: "datum"; view: string; ref: GeoRef; pos: [number, number]; letter: string }
/** Surface finish (ISO 1302 / 21920): the tick on an edge, any process, material removed or not removed, with the roughness above. */
export interface SurfAnnot { id: string; t: "surf"; view?: string; ref?: GeoRef; pos: [number, number]; proc: "any" | "removal" | "none"; text: string; method?: string }
/** A table on the sheet (FR-DRW-024): revision table or a general one; `pos` is its top-left corner (sheet mm), its top-right one with `anchor: "tr"` (revision tables grow to the left), or its bottom-right one with `anchor: "br"` (a BOM on the title block: header at the bottom, items upwards). A BOM's rows come from the assembly when drawn. */
export interface TableAnnot { id: string; t: "table"; view?: undefined; kind: "rev" | "general" | "bom"; pos: [number, number]; cols: string[]; rows: string[][]; title?: string; anchor?: "tr" | "br"; /** BOM only: "parts" lists the parts inside sub-assemblies (FR-ASM-024). */ mode?: "top" | "parts"; /** BOM only: list just this top-level sub-assembly's parts. */ sub?: string }

/**
 * A balloon (FR-DRW-030) on a component of an assembly view: `ref` is an edge of it (its face names
 * start with `<component id>@`), the number is that part's item in the BOM unless `txt` overrides it.
 * `stack` lists more components whose items are stacked under it (one leader for all).
 */
export interface BalloonAnnot { id: string; t: "balloon"; view: string; ref: GeoRef; pos: [number, number]; txt?: string; stack?: string[] }

/**
 * A hole table (FR-DRW-024): the holes seen end-on in a view, tagged on the view (A1, A2, B1: one letter per size) and listed
 * with their X/Y from `origin` along the view's axes and their size. `pos` (the table's top-left corner) is in the view's
 * model axes like other view annotations; `holes` are circle edges, so the table follows the model.
 */
export interface HoleTableAnnot { id: string; t: "htable"; view: string; origin: GeoRef; holes: GeoRef[]; pos: [number, number]; prec?: number }

/** A revision cloud (SolidWorks' Revision Cloud): scallops around a polygon on the sheet. `pts` are x, y pairs relative to `pos`
 *  (sheet mm); `arc` is the largest scallop chord (mm, default 6); `rev` an optional revision letter in a triangle at the first corner. */
export interface CloudAnnot { id: string; t: "cloud"; view?: undefined; pos: [number, number]; pts: number[]; arc?: number; rev?: string }

/** A centreline or centre mark put in by hand (SolidWorks' Centerline / Center Mark, FR-DRW-023). `k` "line": between two
 *  parallel straight edges (the middle line over both) or through two points; "mark": a cross on a round edge seen end-on
 *  (also arcs, which get no automatic mark). `ext` is how far it runs past the geometry, in sheet mm (default 2). */
export interface CLineAnnot { id: string; t: "cline"; view: string; k: "line" | "mark"; refs: GeoRef[]; ext?: number; pos?: undefined }

/** An ISO 2553 elementary weld symbol. */
export type WeldSym = "fillet" | "square" | "v" | "bevel" | "plug" | "spot";
/** One side of a weld symbol: the symbol, the size before it (e.g. "a4", "z5") and the length after it (e.g. "100", "3×50 (100)"). */
export interface WeldSide { sym: WeldSym; size?: string; len?: string }
/** A weld symbol (ISO 2553 system A, FR-DRW-023): `pos` is the knee (view axes, or sheet mm without a view); `leader` the joint the
 *  arrow points at; `arrow`/`other` the arrow-side and other-side welds; `around` = all round, `field` = site weld, `tail` a note. */
export interface WeldAnnot { id: string; t: "weld"; view?: string; pos: [number, number]; leader?: GeoRef; arrow?: WeldSide; other?: WeldSide; around?: boolean; field?: boolean; tail?: string }

export type Annot = DimAnnot | NoteAnnot | HoleAnnot | GtolAnnot | DatumAnnot | SurfAnnot | TableAnnot | BalloonAnnot | HoleTableAnnot | CloudAnnot | CLineAnnot | WeldAnnot;

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
  /** Sheet format: ISO 7200, ANSI Y14.1 or GOST 2.104 (form 1) title block. */
  format: "iso" | "ansi" | "gost";
  /** A user title block (FR-DRW-004) in place of the ISO/ANSI one (not with GOST); the zones follow `format`. */
  tb?: TitleFormat;
  views: DrawingView[];
  /** Dimensions, notes and hole callouts (FR-DRW-020..023). */
  annots?: Annot[];
}

/** What a title block cell shows: a property, a sheet fact, or the projection symbol. */
export type TbKey = keyof DrawingProps | "scale" | "sheet" | "size" | "units" | "projection";
/** A user title block cell (mm from the block's bottom-left corner); a cell without a key is a label or a box. */
export interface TbCell { x: number; y: number; w: number; h: number; key?: TbKey; label?: string; big?: boolean }
/** A logo image (PNG or JPEG data URL) placed in the block. */
export interface TbLogo { src: string; x: number; y: number; w: number; h: number }
/** A user sheet format's title block (FR-DRW-004): its size, cells and logo. */
export interface TitleFormat { id: string; name: string; w: number; h: number; cells: TbCell[]; logo?: TbLogo }

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
  /** GOST 2.104: technical and standards control signatures, and the letter (up to 3 characters). */
  tcontrol?: string;
  ncontrol?: string;
  litera?: string;
}

export interface DrawingDoc {
  schema: 1;
  kind: "drawing";
  id: string;
  name: string;
  sheets: Sheet[];
  props: DrawingProps;
  /** The model shown: a part document, or a STEP/IGES/BREP file kept in the drawing file. */
  /** Drafting style for every sheet (FR-DRW-025); absent fields take the ISO defaults. */
  style?: DraftStyle;
  source: { kind: "part"; doc: PartDoc; name: string } | { kind: "file"; name: string }
    /** An assembly (FR-DRW-030): its document, and `flat` = with pattern instances and sub-assemblies' parts placed (what the kernel builds). */
    | { kind: "asm"; doc: AsmDoc; flat: AsmDoc; name: string };
}

/** Annotation text height (mm), arrowhead (filled, open, dot or oblique tick) and ISO 128 line group (thick line width, mm). */
export interface DraftStyle { text?: 2.5 | 3.5 | 5; arrow?: "filled" | "open" | "dot" | "tick"; lines?: 0.25 | 0.35 | 0.5 | 0.7 }

/** Model facts for the title block. */
export interface ModelInfo { title: string; number?: string; revision?: string; author?: string; material?: string; mass?: number; box: [V3, V3] }

/** Section hatch patterns (ANSI Y14.2 / ISO 128-50): 31 general use and cast iron, 32 steel, 33 brass, bronze and copper,
 * 34 plastics and rubber, 37 lead, zinc and insulation, 38 aluminium and light alloys. */
export type HatchPattern = "material" | "ansi31" | "ansi32" | "ansi33" | "ansi34" | "ansi37" | "ansi38";
