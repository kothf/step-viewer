// Sheet metal features (FRS 9.12, FR-FT-120). The first sheet metal feature of a part, the base
// flange, holds the part's sheet metal parameters (thickness, default bend radius, bend allowance);
// later sheet metal features use them unless they override the radius.
import type { EdgeRef, FaceRef, Num } from "../model/types";

/** How bend allowance is worked out: K-factor, a bend allowance or a bend deduction per bend, or a bend table. */
export type BendCalc = "k" | "ba" | "bd" | "table";

/**
 * Bend table: K-factors, bend allowances or bend deductions (mm) by inside radius (rows, mm) and
 * bend angle (columns, degrees), for the part's thickness. Values between the rows and columns are
 * interpolated linearly; outside them the nearest row or column is used.
 */
export interface BendTable {
  kind: "k" | "ba" | "bd";
  radii: number[];
  angles: number[];
  /** v[i][j] = value at radii[i], angles[j]. */
  v: number[][];
}

/** Base flange / tab: a closed sketch becomes a flat plate, an open sketch of lines a bent flange of `depth`. */
export interface SmBaseFeature {
  id: string; type: "smbase"; name: string; suppressed?: boolean;
  sketch: string;
  thickness: Num;
  /** Default inside bend radius. */
  radius: Num;
  /** Open profiles: how far the profile is extruded. */
  depth: Num;
  /** Open profiles: extrude both ways from the sketch plane. */
  mid?: boolean;
  /** Open profiles: extrude the other way along the sketch normal. */
  flip?: boolean;
  /** Thickness on the other side of the sketch. */
  reverse?: boolean;
  calc?: BendCalc;
  /** K-factor (0..1) when calc is "k" (the default). */
  k?: number;
  /** Bend allowance per bend when calc is "ba". */
  ba?: Num;
  /** Bend deduction per bend when calc is "bd". */
  bd?: Num;
  /** Bend table when calc is "table". */
  table?: BendTable;
  /** Gauge table row ("steel:16") the thickness, radius and K-factor came from. */
  gauge?: string;
  /** Bend relief where a bend stops short of the panel's edge: rectangular (default), obround or none. */
  relief?: "rect" | "obround" | "none";
  /** Relief width and depth as a multiple of the thickness (default 0.5). */
  reliefRatio?: number;
}

/** Edge flange: a bend and a flat flange on straight edges of the sheet. */
export interface SmFlangeFeature {
  id: string; type: "smflange"; name: string; suppressed?: boolean;
  edges: EdgeRef[];
  length: Num;
  angle: Num;
  /** What the length is measured to: the outer (default) or inner virtual sharp. */
  lengthRef?: "outer" | "inner";
  /** Where the flange sits against the edge: material inside (default), material outside, or bend outside. */
  position?: "inside" | "outside" | "bendout";
  /** Bend the other way. */
  flip?: boolean;
  /** Custom inside bend radius (else the base flange's). */
  radius?: Num;
  /** Shorten the flange from the edge's start / end. */
  off0?: Num;
  off1?: Num;
  /** Picked edges meeting at a corner: the gap left between their mitred flanges (default 0.1 mm). */
  gap?: Num;
}

/** Hem: the edge folded back on itself. */
export interface SmHemFeature {
  id: string; type: "smhem"; name: string; suppressed?: boolean;
  edges: EdgeRef[];
  kind: "closed" | "open";
  length: Num;
  /** Open hem: the gap between the sheet and the hem. */
  gap?: Num;
  /** Material inside (default: the hem's fold sits at the old edge) or outside (the hem is added beyond it). */
  position?: "inside" | "outside";
  flip?: boolean;
}

/** Break corner: outside corners of flat faces rounded or chamfered through the thickness. */
export interface SmCornerFeature {
  id: string; type: "smcorner"; name: string; suppressed?: boolean;
  /** Thickness edges at the corners (between two side faces of one flat face). */
  edges: EdgeRef[];
  kind: "chamfer" | "fillet";
  /** Chamfer distance along both edges, or fillet radius. */
  size: Num;
}

/** Closed corner: flange end faces run on (or back) to meet the neighbouring flange. */
export interface SmClosedFeature {
  id: string; type: "smclosed"; name: string; suppressed?: boolean;
  /** End faces of flanges to extend. */
  faces: FaceRef[];
  /** Overlap: the face runs over the other flange's end; underlap: it stops at the other flange's inside face. */
  kind: "overlap" | "underlap";
  /** Underlap: the gap left before the other flange. */
  gap?: Num;
}

/** Miter flange: an open profile of lines, sketched on a plane square to an edge and starting at it, run
 * along the picked edges; flanges on edges meeting at a corner are mitred. A swept flange ("smswept") is the same
 * with tangent arcs between the lines: each arc is a bend of its own radius (the profile is the outside of the first bend). */
export interface SmMiterFeature {
  id: string; type: "smmiter" | "smswept"; name: string; suppressed?: boolean;
  /** Open chain of lines; one end at the first edge. Lengths are to the virtual sharps on the profile's side. */
  sketch: string;
  edges: EdgeRef[];
  radius?: Num;
  /** The gap left between the mitred flanges at a corner (default 0.1 mm). */
  gap?: Num;
}

/** Flat pattern: the folded sheet unfolded onto the plane of its first face. */
/**
 * Unfold / Fold: flattens the picked bends (empty = every bend) keeping `face`'s panel where it is, so features can cut
 * across them; Fold bends them back (empty = every unfolded bend) and wraps such cuts onto the bends.
 */
export interface SmUnfoldFeature {
  id: string; type: "smunfold" | "smfold"; name: string; suppressed?: boolean;
  /** Unfold: a top or bottom face of the panel that stays put (else the first panel). */
  face?: FaceRef;
  /** Bend ids. */
  bends: string[];
}

export interface SmFlatFeature {
  id: string; type: "smflat"; name: string; suppressed?: boolean;
}

/** Where a sketched bend's bend region sits against the sketch line (the flat pattern keeps its size). */
export type BendPosition = "center" | "start" | "end";

/** Sketched bend: a line sketched on a flat face folds the face along it. */
export interface SmSketchBendFeature {
  id: string; type: "smbend"; name: string; suppressed?: boolean;
  /** A sketch on a flat face of the sheet holding one line. */
  sketch: string;
  angle: Num;
  /** Bend centreline (default), the bend starting at the line, or ending at it. */
  position?: BendPosition;
  /** Fold the other side of the line (the default folds the side without bends, else the smaller one). */
  flip?: boolean;
  /** Bend the other way (the default bends towards the sketched face). */
  reverse?: boolean;
  radius?: Num;
}

/** Jog: two opposite bends along a sketched line that offset the rest of the face. */
export interface SmJogFeature {
  id: string; type: "smjog"; name: string; suppressed?: boolean;
  sketch: string;
  offset: Num;
  /** What the offset measures: outside faces (default), inside faces, or face to same face. */
  dim?: "outside" | "inside" | "face";
  angle: Num;
  position?: BendPosition;
  flip?: boolean;
  reverse?: boolean;
  radius?: Num;
}

/** Tab: a closed sketch on a flat face of the sheet adds material there (same thickness), joined to the face. */
export interface SmTabFeature {
  id: string; type: "smtab"; name: string; suppressed?: boolean;
  sketch: string;
}

/** Cross break: an X of shallow bend lines across a flat face that stiffens it; the solid is unchanged. */
export interface SmCrossFeature {
  id: string; type: "smcross"; name: string; suppressed?: boolean;
  /** Top or bottom faces of panels (`<panel>:top|bot`). */
  faces: FaceRef[];
  /** Inside radius of the break lines. */
  radius: Num;
  /** Break angle. */
  angle: Num;
  /** Break the other way (default: raised towards the picked face). */
  flip?: boolean;
}

/**
 * Vent: openings cut through a flat face, from one sketch on it. The largest closed loop is the boundary; lines with a
 * free end (ending on the boundary or in the open) are ribs and closed circles inside are spars, both left as material
 * of their width. The flat pattern shows the openings like any cut.
 */
export interface SmVentFeature {
  id: string; type: "smvent"; name: string; suppressed?: boolean;
  sketch: string;
  /** Rib width. */
  rib: Num;
  /** Spar width. */
  spar: Num;
}

/**
 * Convert to Sheet Metal (a CAD app's Convert to Sheet Metal from a solid): the fixed face of a solid becomes a flat
 * panel and the flat faces across the picked bend edges flanges, each as long and at the angle the solid has, with the
 * thickness inside the solid (its outer faces stay); other edges between converted faces are rips, mitred `gap` apart.
 * The solid is replaced by the sheet, trimmed to the solid's faces. It starts a sheet metal part, like a base flange.
 */
export interface SmConvertFeature {
  id: string; type: "smconvert"; name: string; suppressed?: boolean;
  /** The flat face kept fixed. */
  face: FaceRef;
  /** Bend edges on the fixed face, each between it and another flat face. */
  edges: EdgeRef[];
  thickness: Num;
  /** Default inside bend radius. */
  radius: Num;
  k?: number;
  /** Rip gap at corners (default 0.1 mm). */
  gap?: Num;
  /** Auto relief at corners where two converted walls' bends meet (absent = none; new features: rect). */
  relief?: ReliefKind;
  /** Auto relief ratio × thickness (default 0.5). */
  reliefRatio?: number;
}

/**
 * Insert Bends (a CAD app's Insert Bends): a thin-walled solid of flat walls (a shelled box, a bent profile) becomes sheet
 * metal. The picked outside face stays fixed; every sharp outside edge of it to another flat wall becomes a bend of the
 * given radius; the thickness is the wall's own. Corners between walls are ripped and mitred `gap` apart.
 */
export interface SmInsertFeature {
  id: string; type: "sminsert"; name: string; suppressed?: boolean;
  face: FaceRef;
  radius: Num;
  k?: number;
  gap?: Num;
  /** Auto relief at corners where two converted walls' bends meet (absent = none; new features: rect). */
  relief?: ReliefKind;
  /** Auto relief ratio × thickness (default 0.5). */
  reliefRatio?: number;
}

/**
 * Normal cut (a CAD app's Extruded Cut with Normal cut): a closed sketch is projected along its normal onto the
 * sheet's mid-surface, and each piece it lands on is cut square to the sheet there, panels and bends alike, so the
 * flat pattern gets clean openings. End: link to thickness (default: as deep as the sheet), blind or through all.
 */
export interface SmCutFeature {
  id: string; type: "smcut"; name: string; suppressed?: boolean;
  sketch: string;
  /** Absent = link to thickness. */
  end?: "blind" | "through";
  /** Blind depth from the sketch plane. */
  depth?: Num;
  /** Cut along the sketch normal (default: against it, into the material). */
  flip?: boolean;
}

/** The forming tools of the library (FR-FT-120): a round dimple, an embossed rib, a louver and an extruded hole. */
export type FormTool = "dimple" | "rib" | "louver" | "xhole";

/**
 * Forming tool: a library shape pressed into a flat face of the sheet at one or more points. The material is formed
 * out of the picked face (the other way when flipped) and keeps the sheet's thickness. The flat pattern leaves the
 * form out (as a CAD app does), keeps its footprint as a mark and cuts an extruded hole's pre-pierce hole.
 */
export interface SmFormFeature {
  id: string; type: "smform"; name: string; suppressed?: boolean;
  /** The panel face (`<panel>:top|bot`) the tool sits on. */
  face: FaceRef;
  tool: FormTool;
  /** Tool centres in the flat coordinates of the face's panel. */
  pts: [number, number][];
  /** Dimple: diameter at the face. Rib, louver: length. Extruded hole: hole diameter. */
  size: Num;
  /** Rib, louver: width. */
  width: Num;
  /** How far the form stands out of the face. */
  height: Num;
  /** Dimple, rib: draft of the side walls. */
  draft?: Num;
  /** Rib, louver: turn about the face normal, from the panel's x axis. */
  angle?: Num;
  /** Form out of the other face. */
  flip?: boolean;
}

/** Lofted bend: two open profiles of lines and arcs, each on its own sketch, joined by a ruled sheet. It is made of
 * flat facets folded along straight lines (a CAD app's "bent" method), so its flat pattern is exact. A base feature. */
export interface SmLoftFeature {
  id: string; type: "smloft"; name: string; suppressed?: boolean;
  sketch1: string;
  sketch2: string;
  thickness: Num;
  /** Default inside bend radius for later flanges. */
  radius: Num;
  /** K-factor (0..1): where the neutral surface lies across the thickness. */
  k?: number;
  /** Thickness on the other side of the profiles. */
  reverse?: boolean;
  /** Facets each arc of the profiles is split into (default 8). */
  facets?: number;
}

/** Corner relief kinds: a rectangle over both bends' corner zone, a circle centred on the bend centre lines, or a small
 * round tear at the inside corner. */
export type ReliefKind = "rect" | "obround" | "circle" | "tear";

/**
 * Corner relief: cuts a relief where two bends meet at a corner of one face (a CAD app's Corner Relief, two-bend
 * corners). It is cut from the panels and bends in the flat pattern, so the bends lose their corner material and the
 * flat pattern shows the relief.
 */
export interface SmReliefFeature {
  id: string; type: "smrelief"; name: string; suppressed?: boolean;
  /** Corners by key (`<bend>+<bend>`, the two bend ids sorted); empty = every corner of the sheet. */
  corners: string[];
  kind: ReliefKind;
  /** Clearance past the bend zone (rectangle, circle) or tear radius; absent = `ratio` × thickness. */
  size?: Num;
  /** Relief ratio (default 0.5) used when `size` is absent. */
  ratio?: number;
  /** Rectangular: corner fillet radius (absent = sharp corners). */
  round?: Num;
}

/**
 * Sheet metal gusset: a stiffening rib pressed across a bend (a CAD app's Sheet Metal Gusset, flat type). The rib
 * stands inside the bend, a triangle `depth` along each face from their virtual sharp, `width` wide; the outside gets
 * the matching groove, so the walls keep the sheet's thickness. The flat pattern leaves it out.
 */
export interface SmGussetFeature {
  id: string; type: "smgusset"; name: string; suppressed?: boolean;
  /** The bend (`<feature>:b<n>`). */
  bend: string;
  /** Centre of the rib along the bend from its start end; absent = the middle. */
  at?: Num;
  /** Profile length along each face from the inside virtual sharp. */
  depth: Num;
  /** Rib width (outside). */
  width: Num;
  /** Profile length along the second face (absent = `depth` on both). */
  depth2?: Num;
  /** Several ribs (default 1), `spacing` apart centre to centre, centred on `at` (or the middle). */
  count?: number;
  spacing?: Num;
  /** Rib profile across its width: flat (default) or rounded (a full half round). */
  tip?: "flat" | "round";
  /** Flat tip: radius of the rib's outside edges along the chord (absent = sharp). */
  fillet?: Num;
}

/**
 * Rip (a CAD app's Rip): a thin gap cut along corner edges of a thin-walled solid (a shelled box) so its walls part
 * there before Insert Bends or Convert. Both directions = a slot `gap` wide on the bisector of the two faces; one
 * direction (inside edges only) = the cut lies along the chosen face, so that wall runs on past the other.
 */
export interface SmRipFeature {
  id: string; type: "smrip"; name: string; suppressed?: boolean;
  edges: EdgeRef[];
  /** Gap width (default 0.1 mm). */
  gap: Num;
  /** "a" / "b" = along the edge's first / second face (absent = both directions). */
  side?: "a" | "b";
}

/**
 * Tab and slot (a CAD app's Tab and Slot): tabs grow out of a straight edge of a flat face, in its plane, and pass
 * through the face they meet (any body, the sheet too), which gets slots `clearance` bigger all round. Tabs are panels,
 * so the flat pattern has them; slots in the sheet reach it like any cut.
 */
export interface SmTabSlotFeature {
  id: string; type: "smtabslot"; name: string; suppressed?: boolean;
  /** The tab edge: an outline edge of a panel (its top or bottom face and the side face). */
  edge: EdgeRef | null;
  /** The face the tabs go through, square to them and facing the edge. */
  face: FaceRef | null;
  /** Tab length along the edge. */
  length: Num;
  /** How far each tab stands past the slot face (default the thickness). */
  height: Num;
  count: number;
  /** Distance from the edge's ends to the outer tabs (equal spacing between them). */
  offset: Num;
  /** Fixed centre-to-centre spacing instead, the group centred on the edge. */
  spacing?: Num;
  /** Gap left all round a tab in its slot. */
  clearance: Num;
  /** Slot corner radius (absent = sharp). */
  round?: Num;
}

export type SheetFeature = SmRipFeature | SmTabSlotFeature | SmInsertFeature | SmConvertFeature | SmCutFeature | SmGussetFeature | SmReliefFeature | SmUnfoldFeature | SmFormFeature | SmVentFeature | SmCrossFeature | SmLoftFeature | SmBaseFeature | SmFlangeFeature | SmHemFeature | SmSketchBendFeature | SmJogFeature | SmTabFeature | SmCornerFeature | SmClosedFeature | SmMiterFeature | SmFlatFeature;
export const SHEET_TYPES: ReadonlySet<string> = new Set(["smrip", "smtabslot", "smloft", "smbase", "smconvert", "sminsert", "smflange", "smhem", "smbend", "smjog", "smtab", "smcross", "smvent", "smcut", "smform", "smunfold", "smfold", "smrelief", "smgusset", "smcorner", "smclosed", "smmiter", "smswept", "smflat"]);
/** The feature that starts a sheet metal part: a base flange, a lofted bend or a solid converted to sheet metal. */
export const isSheetBase = (f: { type: string; suppressed?: boolean }) => (f.type === "smbase" || f.type === "smloft" || f.type === "smconvert" || f.type === "sminsert") && !f.suppressed;
export const isSheet = (f: { type: string }): f is SheetFeature => SHEET_TYPES.has(f.type);

/** Gauge tables: thickness, default inside radius and K-factor for common sheet gauges. */
export interface GaugeRow { gauge: string; t: number; r: number; k: number }
export const GAUGE_TABLES: { id: string; name: string; rows: GaugeRow[] }[] = [
  {
    id: "steel", name: "Steel, mild (MSG)", rows: [
      { gauge: "10", t: 3.416, r: 3.5, k: 0.44 }, { gauge: "11", t: 3.038, r: 3, k: 0.44 }, { gauge: "12", t: 2.657, r: 2.5, k: 0.44 },
      { gauge: "14", t: 1.897, r: 2, k: 0.42 }, { gauge: "16", t: 1.519, r: 1.5, k: 0.42 }, { gauge: "18", t: 1.214, r: 1.2, k: 0.4 },
      { gauge: "20", t: 0.912, r: 1, k: 0.4 }, { gauge: "22", t: 0.759, r: 0.8, k: 0.38 }, { gauge: "24", t: 0.607, r: 0.6, k: 0.38 },
    ],
  },
  {
    id: "stainless", name: "Stainless steel", rows: [
      { gauge: "10", t: 3.571, r: 4, k: 0.45 }, { gauge: "12", t: 2.778, r: 3, k: 0.45 }, { gauge: "14", t: 1.984, r: 2, k: 0.44 },
      { gauge: "16", t: 1.588, r: 1.6, k: 0.44 }, { gauge: "18", t: 1.27, r: 1.3, k: 0.42 }, { gauge: "20", t: 0.953, r: 1, k: 0.42 },
    ],
  },
  {
    id: "alu", name: "Aluminium (metric)", rows: [
      { gauge: "0.5", t: 0.5, r: 0.5, k: 0.38 }, { gauge: "0.8", t: 0.8, r: 0.8, k: 0.38 }, { gauge: "1", t: 1, r: 1, k: 0.4 },
      { gauge: "1.5", t: 1.5, r: 1.5, k: 0.4 }, { gauge: "2", t: 2, r: 2, k: 0.42 }, { gauge: "3", t: 3, r: 3, k: 0.43 },
      { gauge: "4", t: 4, r: 4, k: 0.44 }, { gauge: "5", t: 5, r: 5, k: 0.45 },
    ],
  },
];

/** A gauge row by its key ("steel:16"). */
export function gaugeRow(key: string | undefined): GaugeRow | undefined {
  if (!key) return undefined;
  const [tab, g] = key.split(":");
  return GAUGE_TABLES.find(x => x.id === tab)?.rows.find(r => r.gauge === g);
}
