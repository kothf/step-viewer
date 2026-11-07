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

export type EndKind = "blind" | "through" | "mid" | "upto" | "offset" | "through2";

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
  /** Offset from surface: the distance short of the face (or past it, reversed). */
  upToOffset?: Num;
  reverseOffset?: boolean;
  /** Thin feature (FR-FT-015): a wall of this thickness along the profile instead of a solid. */
  thin?: { t: Num; mode: "inside" | "outside" | "mid" };
  /** Draft while extruding (FR-FT-014): the side faces taper by this angle (outward: they flare). */
  draft?: { angle: Num; outward?: boolean };
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

/** Reference axis (FR-REF-003): along a straight edge, the axis of a round face, or where two planes meet. */
export interface AxisFeature {
  id: string; type: "axis"; name: string; suppressed?: boolean;
  mode: "edge" | "cylinder" | "planes";
  edge?: EdgeRef;
  face?: FaceRef;
  planes?: PlaneRef[];
  hidden?: boolean;
}

/** Reference point (FR-REF-004): a vertex, the centre of a round edge, a face's centre, or an edge's midpoint. */
export interface PointFeature {
  id: string; type: "point"; name: string; suppressed?: boolean;
  mode: "vertex" | "centre" | "face" | "mid";
  edge?: EdgeRef;
  /** Vertex mode: near which end of the edge. */
  at?: V3;
  face?: FaceRef;
  hidden?: boolean;
}

/** A direction or axis: a straight or round edge, a flat or round face, or a reference axis. */
export interface LineRef { edge?: EdgeRef; face?: FaceRef; axis?: string }

/** Shell (FR-FT-060): hollows the body to a wall thickness, leaving the picked faces open. */
export interface ShellFeature {
  id: string; type: "shell"; name: string; suppressed?: boolean;
  thickness: Num;
  faces: FaceRef[];
  /** Grow the wall outward instead of inward. */
  outward?: boolean;
}

/** Draft (FR-FT-061): tapers the picked faces by an angle about a neutral plane (the pull direction is its normal). */
export interface DraftFeature {
  id: string; type: "draft"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  faces: FaceRef[];
  angle: Num;
  /** Reverse the pull direction. */
  flip?: boolean;
}

/** Mirror (FR-FT-072): copies of features (or of the whole body, with none picked) about a plane. */
export interface MirrorFeature {
  id: string; type: "mirror"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  features: string[];
}

/** Linear pattern (FR-FT-070): copies of features along one or two directions. */
export interface LinearPatternFeature {
  id: string; type: "lpattern"; name: string; suppressed?: boolean;
  features: string[];
  dir?: LineRef;
  spacing: Num;
  count: number;
  flip?: boolean;
  dir2?: LineRef;
  spacing2?: Num;
  count2?: number;
  flip2?: boolean;
  /** Instances left out, as "i" or "i,j" (0-based; the seed is 0 / 0,0). */
  skip?: string[];
}

/** Circular pattern (FR-FT-071): copies of features about an axis. */
export interface CircularPatternFeature {
  id: string; type: "cpattern"; name: string; suppressed?: boolean;
  features: string[];
  axis?: LineRef;
  count: number;
  /** Total angle with equal spacing, or the angle between instances. */
  angle: Num;
  equal: boolean;
  flip?: boolean;
  skip?: string[];
}

/** Hole wizard (FR-FT-050..053): holes of one kind at points on a flat face or plane. */
export interface HoleFeature {
  id: string; type: "hole"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  /** Hole centres in the plane's frame (x, y). */
  pts: [number, number][];
  kind: "simple" | "cbore" | "csink" | "tapped";
  /** ISO size ("M6") the values were taken from; absent for a custom hole. */
  size?: string;
  fit?: "close" | "normal" | "loose";
  diameter: Num;
  end: "blind" | "through";
  depth: Num;
  /** Flat bottom instead of a 118° drill point. */
  flat?: boolean;
  cbDia?: Num;
  cbDepth?: Num;
  csDia?: Num;
  csAngle?: Num;
  /** Tapped: thread depth (cosmetic thread) and nominal diameter. */
  threadDepth?: Num;
  major?: number;
  pitch?: number;
}

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature | ChamferFeature | PlaneFeature | AxisFeature | PointFeature
  | ShellFeature | DraftFeature | MirrorFeature | LinearPatternFeature | CircularPatternFeature | HoleFeature;
export type FeatureType = Feature["type"];

export interface PartProps {
  title?: string; partNumber?: string; description?: string; revision?: string; author?: string;
  custom?: Record<string, string>;
}

/** A global variable (FR-PAR-001): a named value other inputs can use by name. */
export interface GlobalVar {
  name: string;
  expr: string;
  kind: "length" | "angle" | "number";
  comment?: string;
}

/** A configuration (FR-CFG-001): a named set of values; the active one's live in the document. */
export interface PartConfig {
  name: string;
  /** Values when this configuration was last left (the active one's are stale until switched away). */
  state: {
    nums: Record<string, Num>;
    ints: Record<string, number>;
    suppressed: string[];
    vars: Record<string, string>;
    material: { name: string; density: number } | null;
    /** Features that existed then (newer ones keep their suppression when switching). */
    ids: string[];
  };
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
  /** Global variables (Equations). */
  vars?: GlobalVar[];
  /** Configurations; absent: only the default one. */
  configs?: PartConfig[];
  /** The active configuration's name. */
  config?: string;
}

// ---------- kernel results ----------

export interface FeatureStatus { id: string; ok: boolean; code?: string; message?: string; warning?: string }

/** Mass properties of the body for density 1 (mm units): volume, area, centre of mass, principal moments (mm⁵) and axes. */
export interface BodyProps { volume: number; area: number; com: V3; moments?: V3; axes?: [V3, V3, V3] }

export const SCHEMA = 1;
