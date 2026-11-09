// Sheet metal features (FRS 9.12, FR-FT-120). The first sheet metal feature of a part, the base
// flange, holds the part's sheet metal parameters (thickness, default bend radius, bend allowance);
// later sheet metal features use them unless they override the radius.
import type { EdgeRef, FaceRef, Num } from "../model/types";

/** How bend allowance is worked out: K-factor, a bend allowance or a bend deduction per bend. */
export type BendCalc = "k" | "ba" | "bd";

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

export type SheetFeature = SmBaseFeature | SmFlangeFeature | SmHemFeature | SmSketchBendFeature | SmJogFeature | SmTabFeature | SmCornerFeature | SmClosedFeature | SmMiterFeature | SmFlatFeature;
export const SHEET_TYPES: ReadonlySet<string> = new Set(["smbase", "smflange", "smhem", "smbend", "smjog", "smtab", "smcorner", "smclosed", "smmiter", "smswept", "smflat"]);
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
