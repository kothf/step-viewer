// The part document: plain JSON, the single source of truth for modelling
// (FRS section 15). Geometry, meshes and naming maps are derived from it.
// Lengths are millimetres, angles radians.

export type V2 = [number, number];
export type V3 = [number, number, number];

/** A numeric parameter: the last evaluated value, and the expression typed by the user (if any). */
export interface Num { v: number; expr?: string }

// ---------- sketch ----------

export type SkEnt =
  | { id: string; t: "point"; x: number; y: number; cons?: boolean }
  | { id: string; t: "line"; a: string; b: string; cons?: boolean }
  | { id: string; t: "circle"; c: string; r: number; cons?: boolean }
  /** Arc counter-clockwise from a to b around c (|ca| = |cb| is implicit). */
  | { id: string; t: "arc"; c: string; a: string; b: string; cons?: boolean };

export type RelKind =
  | "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "collinear"
  | "equal" | "tangent" | "concentric" | "midpoint" | "fix" | "onCurve" | "symmetric";

export interface SkRel { id: string; t: RelKind; e: string[]; /** tangent arc–arc: internal */ inner?: boolean }

export type DimKind = "distance" | "hdistance" | "vdistance" | "radius" | "diameter" | "angle";

export interface SkDim {
  id: string;
  name: string;
  t: DimKind;
  e: string[];
  val: Num;
  /** Driven (reference) dimensions only report. */
  driven?: boolean;
  /** Text position in sketch coordinates. */
  pos?: V2;
  /** Angle: the quadrant chosen when placed (flips line directions). */
  flip?: [boolean, boolean];
}

/** Plane of a sketch or a reference: a standard plane, a planar face of the model, or a reference plane feature. */
export type PlaneRef =
  | { std: "XY" | "XZ" | "YZ" }
  | { face: FaceRef; offset?: number }
  | { plane: string };

/** World frame of a sketch plane: origin, x and y directions, normal. */
export interface Frame { o: V3; x: V3; y: V3; n: V3 }

export interface SketchFeature {
  id: string; type: "sketch"; name: string; suppressed?: boolean;
  plane: PlaneRef;
  ents: SkEnt[];
  rels: SkRel[];
  dims: SkDim[];
}

// ---------- persistent references (FRS 9.14) ----------

/** A face by name (feature id + role), with its centroid when picked to choose between several. */
export interface FaceRef { name: string; hint?: V3 }
/** An edge between two named faces; the hint picks between several shared edges. */
export interface EdgeRef { faces: [string, string]; hint?: V3 }

// ---------- features ----------

export type EndKind = "blind" | "through" | "mid" | "upto";

export interface ExtrudeFeature {
  id: string; type: "extrude"; name: string; suppressed?: boolean;
  sketch: string;
  op: "boss" | "cut";
  end: EndKind;
  depth: Num;
  /** Second direction depth (blind only); 0 or absent: one direction. */
  depth2?: Num;
  flip?: boolean;
  /** Up to face/plane: the face or plane the extrusion ends at. */
  upTo?: PlaneRef;
  /** Cut: keep the material outside the profile instead (flip side to cut). */
  outside?: boolean;
}

export interface RevolveFeature {
  id: string; type: "revolve"; name: string; suppressed?: boolean;
  sketch: string;
  op: "boss" | "cut";
  /** A line of the sketch (usually construction) used as the axis. */
  axis: string;
  angle: Num;
  mid?: boolean;
  flip?: boolean;
}

export interface FilletFeature {
  id: string; type: "fillet"; name: string; suppressed?: boolean;
  radius: Num;
  edges: EdgeRef[];
  /** Keep features that fit: skip edges that cannot be rounded, with a warning. */
  keepFit?: boolean;
}

export interface ChamferFeature {
  id: string; type: "chamfer"; name: string; suppressed?: boolean;
  distance: Num;
  edges: EdgeRef[];
  /** Equal distances (default), two distances, or distance and angle. */
  mode?: "equal" | "two" | "angle";
  distance2?: Num;
  angle?: Num;
  /** Measure the first distance on the edge's other face. */
  flip?: boolean;
}

/** Reference plane (FRS FR-REF-002): offset from a plane or face, or at an angle to it about an edge. */
export interface PlaneFeature {
  id: string; type: "plane"; name: string; suppressed?: boolean;
  base: PlaneRef;
  mode: "offset" | "angle";
  offset: Num;
  angle?: Num;
  /** Angle mode: the straight edge the plane turns about. */
  axis?: EdgeRef;
  flip?: boolean;
  /** Hidden in the view. */
  hidden?: boolean;
}

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature | ChamferFeature | PlaneFeature;
export type FeatureType = Feature["type"];

export interface PartProps {
  title?: string; partNumber?: string; description?: string; revision?: string; author?: string;
  custom?: Record<string, string>;
}

export interface PartDoc {
  schema: 1;
  kind: "part";
  id: string;
  name: string;
  units: { length: "mm" | "cm" | "m" | "in" | "ft"; decimals: number };
  props: PartProps;
  material?: { name: string; density: number };
  color?: V3;
  features: Feature[];
  /** Features after this index are not evaluated (rollback bar); null: all. */
  rollback: number | null;
}

// ---------- kernel results ----------

export interface FeatureStatus { id: string; ok: boolean; code?: string; message?: string; warning?: string }

/** Mass properties of the body for density 1 (mm units): volume, area, centre of mass, principal moments (mm⁵) and axes. */
export interface BodyProps { volume: number; area: number; com: V3; moments?: V3; axes?: [V3, V3, V3] }

export const SCHEMA = 1;
