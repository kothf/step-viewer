// The part document: plain JSON, the single source of truth for modelling
// (FRS section 15). Geometry, meshes and naming maps are derived from it.
// Lengths are millimetres, angles radians.

import type { WeldFeature } from "../weldments/types";
import type { MatRef } from "../tools/materials";

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
  | { id: string; t: "arc"; c: string; a: string; b: string; cons?: boolean }
  /**
   * Ellipse round c: a is the end of the major axis, b the end of the minor one (kept square to it).
   * With p0/p1 it is an elliptical arc, counter-clockwise from p0 to p1 (FR-SK-018).
   */
  | { id: string; t: "ellipse"; c: string; a: string; b: string; p0?: string; p1?: string; cons?: boolean }
  /**
   * Interpolating cubic spline through the points; closed runs back to the first (FR-SK-019).
   * FR-SK-021: `kind` "conic"/"parabola" = pts [start, top vertex (where the end tangents meet), end] with
   * `rho` (parabola 0.5); "eqn" = pts [start, end] and `eq` (y = f(x), or x(t), y(t)), placed so its own
   * ends land on the two points (`src/sketch/conic.ts` `entBezier`). "style" (FR-SK-019 P5) = pts are the control
   * polygon of a clamped uniform B-spline of degree min(3, n - 1).
   */
  | { id: string; t: "spline"; pts: string[]; closed?: boolean; cons?: boolean; kind?: "conic" | "parabola" | "eqn" | "style"; rho?: number; eq?: { mode: "xy" | "param"; x?: string; y: string; t0: string; t1: string; flip?: boolean } }
  /**
   * Text (FR-SK-020): `text` from the anchor point `p` (left end of the baseline), capital letters `h` mm
   * tall, turned by `ang` (radians). `gl` keeps the glyph outlines (from the bundled DejaVu fonts) so
   * profiles and the kernel need no font; the editor refreshes it when the text or the font changes.
   * `along` = a curve of the sketch the baseline follows from the point nearest `p` (`ang` is then unused);
   * `flip` runs it the other way, so the letters stand on the other side.
   */
  | { id: string; t: "text"; p: string; text: string; h: number; ang?: number; font?: TextFont; bold?: boolean; italic?: boolean; gl?: TextOutline; along?: string; flip?: boolean; cons?: boolean };

export type TextFont = "sans" | "serif" | "mono";
/**
 * Glyph outlines for `key` (text + font), in capital heights from the anchor, y up. Each contour is a
 * start point then commands: 1 x y = line, 2 x1 y1 x y = quadratic, 3 x1 y1 x2 y2 x y = cubic.
 */
export interface TextOutline { key: string; c: number[][] }

export type RelKind =
  | "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "collinear"
  | "equal" | "tangent" | "concentric" | "midpoint" | "fix" | "onCurve" | "symmetric"
  /** A point where two curves cross: e = [point, curve, curve] (FR-SK-051). */
  | "intersection"
  /** Equal curvature (G2) where a spline meets a line, arc or spline at a shared end; includes tangency (FR-SK-051). */
  | "curvature"
  /**
   * Offset (FR-SK-034): e = [source curve, offset curve, then pairs of (source end point, offset end point) at open chain ends].
   * `of` names the lead offset relation of the same offset: this pair keeps the lead's distance. The lead pair's distance is a dimension.
   */
  | "offset"
  /** Pierce (FR-SK-051): the point sits where the model edge `ext` crosses the sketch plane, e = [point]. */
  | "pierce";

export interface SkRel {
  id: string; t: RelKind; e: string[]; /** tangent arc–arc: internal */ inner?: boolean;
  /** Offset: the lead offset relation whose distance this pair keeps (absent = this pair leads). */
  of?: string;
  /** "On edge" (fix, FR-SK-064): the model edge a converted curve follows on every rebuild; pierce: the edge crossing the plane. */
  ext?: EdgeRef;
  /** Set by the rebuild when `ext` no longer resolves: the curve keeps its place, shown as dangling. */
  dangling?: boolean;
}

/** `arclen`: the length of an arc (e = [arc]) along it, counter-clockwise from its start to its end (FR-SK-060). */
export type DimKind = "distance" | "hdistance" | "vdistance" | "radius" | "diameter" | "angle" | "arclen";

/** Where a distance meets a circle or arc (FR-SK-060): its centre, its near side (min) or its far side (max). */
export type ArcCond = "c" | "min" | "max";

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
  /** Distance to a centerline shown and driven as a diameter (twice the distance), for revolve profiles. */
  dia?: boolean;
  /** Ordinate dimension (horizontal/vertical distance from the base e[0]); pos holds the row of the values. */
  ord?: boolean;
  /** Offset between two concentric arcs/circles: the difference of their radii (FR-SK-034). */
  off?: boolean;
  /** Arrowheads inside or outside the extension lines / rim (FR-SK-068); absent = automatic. */
  arrows?: "in" | "out";
  /**
   * Arc conditions of a distance, one per entry of `e` (FR-SK-060): a circle or arc measured from its near side
   * (min) or far side (max) instead of its centre; entries that are not circles/arcs are ignored.
   */
  cond?: ArcCond[];
}

/** Plane of a sketch or a reference: a standard plane, a planar face of the model, a reference plane feature, or a face of another component (in-context). */
export type PlaneRef =
  | { std: "XY" | "XZ" | "YZ" }
  /**
   * A flat face. `ax: 1`: the sketch X is the part's X laid onto the face (its Y when the face is square to X), so
   * editing the features that made the face no longer turns what is sketched on it (exam #85). Without it (older
   * files) X is the face surface's own direction, kept so their sketches stay where they are.
   */
  | { face: FaceRef; offset?: number; ax?: 1 }
  | { plane: string }
  | { ctx: CtxRef };

/**
 * External reference (FR-ASM-030): a flat face of another component of an assembly, made while editing
 * this part in context. `host` is the component this part was edited as; `p`/`n` are the face's plane in
 * this part's coordinates as last seen, so the part builds on its own. The assembly updates them when the
 * components move, unless `locked`.
 */
export interface CtxRef { comp: string; face: string; host: string; label?: string; p: V3; n: V3; locked?: boolean }

/** An edge of another component as last seen, in this part's coordinates (lines, circles and arcs). */
export interface CtxEdgeGeo { type: string; start: V3; end: V3; mid: V3; closed: boolean; center?: V3; axis?: V3; radius?: number }
/**
 * External reference (FR-ASM-030) on a converted sketch curve: an edge of component `comp`, between the faces
 * named by the EdgeRef (with `hint` = its middle in that component's own part coordinates). `geo` is where the
 * edge was last seen from the host component, so the part builds on its own; the assembly updates it unless
 * `locked`.
 */
export interface CtxEdge { comp: string; host: string; label?: string; geo: CtxEdgeGeo; locked?: boolean }

/** World frame of a sketch plane: origin, x and y directions, normal. */
/** `len` (Hole only): each hole's thread length when the thread runs through all (`HoleFeature.threadEnd`);
 *  for an Advanced Hole that leaves the material, each hole's depth to the far face. */
export interface Frame { o: V3; x: V3; y: V3; n: V3; len?: number[]; /** Hole: each spot's point on its face and outward normal. */ sp?: [V3, V3][] }

export interface SketchFeature {
  id: string; type: "sketch"; name: string; suppressed?: boolean;
  /** Shown in the view: true hides it, false shows it even when a feature uses it; absent: shown until a feature uses it. */
  hidden?: boolean;
  plane: PlaneRef;
  /**
   * Sketch orientation (FR-SK-002 P2): the sketch X axis along a straight model edge (projected onto the plane,
   * first pointing the way of the plane's own X, `flip` turns it round). Absent: the plane's natural direction.
   */
  xAxis?: { edge: EdgeRef; flip?: boolean };
  ents: SkEnt[];
  rels: SkRel[];
  dims: SkDim[];
  /** Sketch pictures (FRS 2.2): images to trace over, drawn under the curves while the sketch is edited. */
  pictures?: SketchPicture[];
  /** Block definitions (FRS 2.2 blocks): entities in their own coordinates, the insertion point at 0, 0. */
  blocks?: SketchBlock[];
  /**
   * Block instances: each is placed as fixed entities `<insert id>~<entity id>` held by one fix relation
   * `<insert id>~fix` (`src/sketch/blocks.ts` `placeInserts`), so profiles and the kernel need nothing new.
   */
  inserts?: BlockInsert[];
  /**
   * Edit Block: the insert being edited in place. Its entities are free (no fix), its definition's relations
   * and dimensions are on them (ids `<insert>~<id>`); `known` = the other entity ids when the edit began, so
   * entities drawn meanwhile join the block when it finishes (`src/sketch/blocks.ts` `finishEditBlock`).
   */
  editBlock?: { insert: string; known: string[] };
}

/** A sketch block definition (a CAD app's Make Block): entities and the relations among them, the insertion point at 0, 0. */
export interface SketchBlock { id: string; name: string; ents: SkEnt[]; rels: SkRel[]; dims?: SkDim[] }
/** A placed block: its insertion point, angle (rad) and scale. */
export interface BlockInsert { id: string; block: string; x: number; y: number; ang?: number; scale?: number }

/** An image on the sketch plane: `src` a data URL, centre `c`, size `w` × `h` (mm), `ang` (rad), `alpha` transparency 0..1, `flip` mirrored left-right, `free` = width and height change apart. */
export interface SketchPicture { id: string; name?: string; src: string; c: V2; w: number; h: number; ang?: number; alpha?: number; flip?: boolean; free?: boolean }

// ---------- persistent references (FRS 9.14) ----------

/** A face by name (feature id + role), with its centroid when picked to choose between several. */
export interface FaceRef { name: string; hint?: V3 }
/** An edge between two named faces; the hint picks between several shared edges. */
export interface EdgeRef { faces: [string, string]; hint?: V3; /** An edge of another component (edit in context, sketch On edge relations only). */ ctx?: CtxEdge }

// ---------- features ----------

export type EndKind = "blind" | "through" | "mid" | "upto" | "offset" | "through2" | "next" | "vertex" | "body";
/** End conditions Direction 2 of an extrude offers (no mid plane or through all - both). */
export type Dir2End = "blind" | "through" | "next" | "vertex" | "upto" | "offset" | "body";
export const DIR2_ENDS: Dir2End[] = ["blind", "through", "next", "vertex", "upto", "offset", "body"];

/** Whether an extrude goes both ways (FR-FT-011): Direction 2 is on and Direction 1 allows it. */
export function hasDir2(f: { end: EndKind; depth2?: Num; end2?: Dir2End }): boolean {
  return !!(f.depth2 && f.depth2.v > 0) && f.end !== "mid" && f.end !== "through2" && (f.end === "blind" || f.end2 !== undefined);
}

/**
 * Direction 2 made as its own tool: both ways, but not blind both ways (that stays one prism, as before),
 * unless the directions are drafted apart (FR-FT-014: `draft2` set and a draft in either direction).
 */
export function dir2Apart(f: { end: EndKind; depth2?: Num; end2?: Dir2End; draft?: unknown; draft2?: { angle: Num } }): boolean {
  if (!hasDir2(f)) return false;
  if (!(f.end === "blind" && (f.end2 ?? "blind") === "blind")) return true;
  return draftApart(f);
}

/** Each direction drafted on its own about the sketch plane (FR-FT-014): `draft2` set and some draft on. */
export function draftApart(f: { draft?: unknown; draft2?: { angle: Num } }): boolean {
  return f.draft2 !== undefined && (!!f.draft || Math.abs(f.draft2.angle.v) > 1e-9);
}

/** Direction 2 is on and blind: it gets a drag arrow. */
export function dir2Blind(f: { end: EndKind; depth2?: Num; end2?: Dir2End }): boolean {
  return hasDir2(f) && (f.end2 ?? "blind") === "blind";
}

/** Drops Direction 2's end condition and references (not its depth). */
export function clearDir2(f: ExtrudeFeature) {
  delete f.end2; delete f.upTo2; delete f.upToOffset2; delete f.reverseOffset2; delete f.upToVertex2; delete f.upToBody2; delete f.draft2;
}

/** Direction 2 of an extrude as a one-way extrude of its own (the other way, same start). */
export function dir2Feature(f: ExtrudeFeature): ExtrudeFeature {
  const g: ExtrudeFeature = { ...f, end: f.end2 ?? "blind", depth: f.depth2 ?? f.depth, flip: !f.flip };
  delete g.depth2; delete g.end2; delete g.draft; delete g.draft2;
  // Direction 2's own draft (FR-FT-014), blind only, as the panel offers it.
  if (f.draft2 && Math.abs(f.draft2.angle.v) > 1e-9 && (f.end2 ?? "blind") === "blind") g.draft = { ...f.draft2 };
  delete g.upTo; delete g.upToOffset; delete g.reverseOffset; delete g.upToVertex; delete g.upToBody;
  if (f.upTo2) g.upTo = f.upTo2;
  if (f.upToOffset2) g.upToOffset = f.upToOffset2;
  if (f.reverseOffset2) g.reverseOffset = true;
  if (f.upToVertex2) g.upToVertex = f.upToVertex2;
  if (f.upToBody2) g.upToBody = f.upToBody2;
  delete g.upTo2; delete g.upToOffset2; delete g.reverseOffset2; delete g.upToVertex2; delete g.upToBody2;
  return g;
}

/** A vertex (FR-FT-012/013): the end of an edge nearer `at`, or a reference point feature. */
export type VertexRef = { edge: EdgeRef; at: V3 } | { point: string };

export interface ExtrudeFeature {
  id: string; type: "extrude"; name: string; suppressed?: boolean;
  sketch: string;
  op: "boss" | "cut";
  /** Boss only: false makes a new body instead of joining the ones it touches (FR-FT-006). */
  merge?: boolean;
  /**
   * Feature scope (FR-FT-007): the bodies a cut, or a boss with Merge result, acts on, each named by one
   * of its faces; absent or empty = all bodies. The other bodies are left as they are.
   */
  scope?: FaceRef[];
  end: EndKind;
  depth: Num;
  /** Second direction depth (its blind depth); 0 or absent: one direction. */
  depth2?: Num;
  /**
   * Direction 2's end condition (FR-FT-011, as a CAD app): absent = blind by `depth2`. Set whenever
   * Direction 1 is not blind, so older files whose end changed with a stale `depth2` keep one direction.
   */
  end2?: Dir2End;
  /** Direction 2: the face or plane (up to face, offset from surface), offset, vertex or body it ends at. */
  upTo2?: PlaneRef;
  upToOffset2?: Num;
  reverseOffset2?: boolean;
  upToVertex2?: VertexRef;
  upToBody2?: FaceRef;
  flip?: boolean;
  /** Up to face/plane: the face or plane the extrusion ends at. */
  upTo?: PlaneRef;
  /** Cut: keep the material outside the profile instead (flip side to cut). */
  outside?: boolean;
  /** Offset from surface: the distance short of the face (or past it, reversed). */
  upToOffset?: Num;
  reverseOffset?: boolean;
  /** Up to vertex: the extrusion ends level with this vertex. */
  upToVertex?: VertexRef;
  /** Up to body (FR-FT-012): any face of the solid the extrusion stops at. */
  upToBody?: FaceRef;
  /** Start from (FR-FT-013): absent is the sketch plane. */
  start?: "offset" | "surface" | "vertex";
  /** Start from Offset: the distance from the sketch plane (along its normal; reversed the other way). */
  startOffset?: Num;
  startReverse?: boolean;
  /** Start from Surface/Face/Plane: a flat face or plane parallel to the sketch. */
  startRef?: PlaneRef;
  /** Start from Vertex: the profile starts level with this vertex. */
  startVertex?: VertexRef;
  /** Thin feature (FR-FT-015): a wall of this thickness along the profile instead of a solid. */
  thin?: { t: Num; mode: "inside" | "outside" | "mid" };
  /** Draft while extruding (FR-FT-014): the side faces taper by this angle (outward: they flare). */
  draft?: { angle: Num; outward?: boolean };
  /**
   * Direction 2's draft (FR-FT-014, as a CAD app). Present (0° = off) means each direction tapers on its
   * own about the sketch plane, `draft` being Direction 1's; the panel sets it once Direction 2 is on.
   * Absent (older files): one `draft` tapers the whole two-way prism from its far end, as before.
   */
  draft2?: { angle: Num; outward?: boolean };
  /**
   * Selected contours (FR-FT-010): a point (sketch coordinates) inside each region of the sketch to use;
   * absent or empty = every closed region. The regions may come from crossing or branching curves.
   */
  contours?: V2[];
}

export interface RevolveFeature {
  id: string; type: "revolve"; name: string; suppressed?: boolean;
  sketch: string;
  op: "boss" | "cut";
  /** Boss only: false makes a new body (FR-FT-006). */
  merge?: boolean;
  /** Feature scope (FR-FT-007), as on an extrude. */
  scope?: FaceRef[];
  /** A line of the sketch (usually construction) used as the axis. */
  axis: string;
  angle: Num;
  mid?: boolean;
  flip?: boolean;
  /** Up to face or plane (FR-FT-022): the revolve stops at a plane through the axis. */
  end?: "blind" | "upto";
  upTo?: PlaneRef;
  /** Direction 2: an angle the other way round from the sketch plane (blind only). */
  angle2?: Num;
  /** Thin revolve (FR-FT-022): a wall along the profile instead of a solid. */
  thin?: { t: Num; mode: "inside" | "outside" | "mid" };
  /** Selected contours (FR-FT-010), as for extrude. */
  contours?: V2[];
}

export interface FilletFeature {
  id: string; type: "fillet"; name: string; suppressed?: boolean;
  radius: Num;
  /**
   * With `multi`, an edge's own radius `r` (mm) replaces `radius` (FR-FT-031). With `variable`, `r` is
   * the radius at the end nearer `at` (world mm; the edge's first vertex when unset) and `r2` at the other.
   */
  edges: (EdgeRef & { r?: number; r2?: number; at?: V3 })[];
  /** Variable radius fillet (FR-FT-032): each edge goes from `r` to `r2`. */
  variable?: boolean;
  /** Multiple radius fillet: each edge can have its own radius. */
  multi?: boolean;
  /** Keep features that fit: skip edges that cannot be rounded, with a warning. */
  keepFit?: boolean;
  /**
   * Fillet type (FR-FT-032): edges (unset), a face fillet that rounds where face set 1 meets face set 2,
   * or a full round that replaces the centre faces with a half cylinder touching side 1 and side 2.
   */
  kind?: "face" | "full";
  faces1?: FaceRef[];
  faces2?: FaceRef[];
  center?: FaceRef[];
  /**
   * Setback fillets (FR-FT-033): at each corner where three or more filleted edges meet, the fillets stop
   * `d` mm along every edge from the vertex and one smooth patch (`fid:setback:k`) blends the corner.
   */
  setbacks?: { v: VertexRef; d: number }[];
}

export interface ChamferFeature {
  id: string; type: "chamfer"; name: string; suppressed?: boolean;
  distance: Num;
  edges: EdgeRef[];
  /**
   * Equal distances (default), two distances, distance and angle, offset face (FR-FT-041: `distance`
   * is how far the two faces move in; their intersection sets the chamfer), or vertex (three distances
   * along the three straight edges at each picked corner).
   */
  mode?: "equal" | "two" | "angle" | "offset" | "vertex";
  distance2?: Num;
  /** Vertex chamfer: the third distance. Distances go to the clicked edge first, then the others in name order. */
  distance3?: Num;
  /** Vertex chamfer: the corners. */
  vertices?: VertexRef[];
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
  /** Angle mode: a standard axis, a reference axis or a round face's axis to turn about instead of `axis` (FR-REF-002). */
  about?: LineRef;
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

/**
 * Reference coordinate system (FR-REF-005): an origin (a vertex or reference point, else the part origin),
 * an X and a Z direction (else world X and Z); X is made square to Z. Usable as the measurement and export frame.
 */
export interface CsysFeature {
  id: string; type: "csys"; name: string; suppressed?: boolean;
  origin?: VertexRef;
  x?: LineRef;
  z?: LineRef;
  flipX?: boolean;
  flipZ?: boolean;
  hidden?: boolean;
}

/** A direction or axis: a straight or round edge, a flat or round face, a reference axis or a standard axis (through the origin). */
export interface LineRef { edge?: EdgeRef; face?: FaceRef; axis?: string; std?: "X" | "Y" | "Z" }

/** Shell (FR-FT-060): hollows the body to a wall thickness, leaving the picked faces open. */
export interface ShellFeature {
  id: string; type: "shell"; name: string; suppressed?: boolean;
  thickness: Num;
  faces: FaceRef[];
  /** Grow the wall outward instead of inward. */
  outward?: boolean;
  /** Multi-thickness (FR-FT-060): flat faces whose wall gets its own thickness `t` (mm). */
  multi?: (FaceRef & { t: number })[];
}

/** Delete face (FR-FT-101): removes the picked faces and heals the gap from the faces around them (defeaturing). */
export interface DeleteFaceFeature {
  id: string; type: "delface"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  /** "delete": the faces go and the rest of the solid becomes a surface body (no healing). */
  mode?: "patch" | "delete";
}

/**
 * Move face (FR-FT-101) on flat faces. Offset (default) moves them along their normals by `distance`
 * (out adds material, `flip` removes it); translate moves them by `dx`/`dy`/`dz` (only the part along
 * each normal changes a flat face whose neighbours grow with it); rotate turns them by `angle` about
 * `axis`, which must lie in each face's plane (an edge of the face, usually).
 */
export interface MoveFaceFeature {
  id: string; type: "moveface"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  distance: Num;
  /** Move into the body instead of out. */
  flip?: boolean;
  mode?: "offset" | "translate" | "rotate";
  dx?: Num; dy?: Num; dz?: Num;
  axis?: LineRef;
  angle?: Num;
}

/** Draft (FR-FT-061): tapers the picked faces by an angle about a neutral plane (the pull direction is its normal). */
export interface DraftFeature {
  id: string; type: "draft"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  faces: FaceRef[];
  angle: Num;
  /** Reverse the pull direction. */
  flip?: boolean;
  /**
   * Parting line draft (FR-FT-061, P5): `plane` only gives the pull direction; each picked edge hinges
   * the face on one side of it (`faces[0]` of the EdgeRef, or `faces[1]` with `other`), so faces
   * above a split line taper from it.
   */
  kind?: "neutral" | "parting";
  parting?: EdgeRef[];
  other?: boolean;
}

/**
 * What a mirror or pattern copies (FR-FT-070..073): features (their tool solids, the default), faces (the
 * boss or cut they bound, found by deleting them) or whole bodies (copies become new bodies).
 */
export interface CopySource {
  copy?: "features" | "faces" | "bodies";
  /** Copying features (FR-FT-074): false/unset = geometry pattern (the result is copied); true = each instance is re-evaluated (end conditions such as up to face or through all hold at each place). */
  vary?: boolean;
  faces?: FaceRef[];
  bodies?: FaceRef[];
}

/** Mirror (FR-FT-072): copies of features (or of the whole body, with none picked) about a plane. */
export interface MirrorFeature extends CopySource {
  id: string; type: "mirror"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  features: string[];
  /** Bodies: join each mirrored body to its original (a CAD app's "Merge solids"). */
  merge?: boolean;
}

/** Linear pattern (FR-FT-070): copies of features along one or two directions. */
export interface LinearPatternFeature extends CopySource {
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
  /** Up to distance (FR-FT-070): `spacing` is the distance from the seed to the last instance, shared out equally. */
  total?: boolean;
  total2?: boolean;
  /** Up to reference (FR-FT-070): the last instance of a direction stops `offset` short of a plane or flat face, measured from the seed's centre; the spacing follows. */
  upTo?: PlaneRef; upToOffset?: Num;
  upTo2?: PlaneRef; upToOffset2?: Num;
  /** Pattern seed only: direction 2 copies the seed alone, not the instances of direction 1. */
  seedOnly?: boolean;
}

/** Circular pattern (FR-FT-071): copies of features about an axis. */
export interface CircularPatternFeature extends CopySource {
  id: string; type: "cpattern"; name: string; suppressed?: boolean;
  features: string[];
  axis?: LineRef;
  count: number;
  /** Total angle with equal spacing, or the angle between instances. */
  angle: Num;
  equal: boolean;
  flip?: boolean;
  /** Direction 2 (FR-FT-071): copies turned the other way; `sym` = the same count and angle as direction 1. Its instances are "-i" in `skip`. */
  dir2?: boolean;
  sym?: boolean;
  count2?: number;
  angle2?: Num;
  equal2?: boolean;
  skip?: string[];
}

/**
 * Sketch-driven and table-driven patterns (FR-FT-073): a copy at each point of a sketch (moved from the
 * seed's reference point, its centroid unless a sketch point is picked) or at each X/Y row of a table in a
 * coordinate system (offsets from the seed).
 */
export interface SketchPatternFeature extends CopySource {
  id: string; type: "spattern"; name: string; suppressed?: boolean;
  features: string[];
  src: "sketch" | "table";
  sketch?: string;
  /** Sketch point used as the seed's reference point; absent: the seed's centroid. */
  refPt?: string;
  /** Table rows: offsets from the seed along the coordinate system's X and Y. */
  table?: { x: Num; y: Num }[];
  /** Coordinate system feature for the table; absent: the part's axes. */
  csys?: string;
}

/**
 * Cosmetic thread (FR-FT-054): thread data on a round edge of a cylinder, drawn as dashed circles;
 * the geometry is unchanged. Internal threads show the major diameter, external ones the minor.
 */
export interface ThreadFeature {
  id: string; type: "thread"; name: string; suppressed?: boolean;
  edge?: EdgeRef;
  /** ISO size ("M6") the values came from; absent: custom. */
  size?: string;
  /** Diameter of the dashed circle. */
  diameter: Num;
  length: Num;
  /** Up to the end of the cylinder instead of a length. */
  upToEnd?: boolean;
  pitch?: number;
  internal?: boolean;
  /** Modelled (helical) thread cut into the body (FR-FT-055) instead of a cosmetic one. */
  modelled?: boolean;
}

/** Hole wizard (FR-FT-050..053): holes of one kind at points on a flat face or plane. */
/** Fillets and chamfers found on a body (FR-FT-102): the faces to delete and the edges to treat again after that. */
export interface RecognizedBlends { faces: FaceRef[]; fillets: { radius: number; variable?: boolean; edges: (EdgeRef & { r?: number; r2?: number; at?: V3 })[] }[]; chamfers: { distance: number; distance2?: number; edges: EdgeRef[]; first?: [number, number, number][] }[] }

/** A hole found on a body (FR-FT-102): where a hole feature would rebuild it. */
/** A hole found by Recognize Holes; `cb` = counterbore (diameter, depth), `cs` = countersink (diameter, included angle in radians). */
export interface RecognizedHole { plane: PlaneRef; pt: [number, number]; diameter: number; end: "blind" | "through"; depth: number; flat: boolean; cb?: { dia: number; depth: number }; cs?: { dia: number; angle: number } }

export interface HoleFeature {
  id: string; type: "hole"; name: string; suppressed?: boolean;
  /** Feature scope (FR-FT-007), as on an extrude: the bodies the holes cut. */
  scope?: FaceRef[];
  plane?: PlaneRef;
  /** Hole centres in the plane's frame (x, y). */
  pts: [number, number][];
  /** Holes on other faces, flat or curved (FR-FT-052): a point on the face (world mm), drilled square to the face there. */
  spots?: { face: FaceRef; p: V3 }[];
  /** clear = ISO 273 clearance hole for the size and fit; cdrill = counterdrilled; slot = an obround of `slotLen`;
   *  ptap = tapered tap (pipe thread, NPT or Rc): a 1:16 cone from `taperDia` at the face over the thread depth,
   *  never narrower than the tap drill `diameter`. */
  kind: "simple" | "cbore" | "csink" | "tapped" | "insert" | "clear" | "cdrill" | "slot" | "ptap" | "adv" | "captive";
  /** Captive screw hole (in a cover): `capStyle` absent = a tapped retaining section the screw is turned through
   *  (`capHold` long, then a clearance bore; without `retract` the thread runs through the cover), "ring" = a
   *  clearance hole with a recess under the cover for the retaining ring (`ringDia` × `ringT`). `retract` =
   *  Retracted screw: room below the retaining section for the screw's thread (`capThread`) so the cover sits flat
   *  with the screw pulled up; a cover too thin for it gets a warning. */
  capStyle?: "ring";
  retract?: boolean;
  capHold?: Num;
  capThread?: Num;
  ringDia?: Num;
  ringT?: Num;
  /** Advanced Hole (a CAD app's Advanced Hole): elements stacked from the face down (`near`, the last one is the
   *  main hole and runs to the end condition, `diameter` mirrors it) and from the far face in (`far`, holes that
   *  leave the material only). */
  near?: HoleElem[];
  far?: HoleElem[];
  /** Size ("M6", "M8x1", "1/4-20 UNC") the values were taken from; absent for a custom hole. */
  size?: string;
  /** Size table (FR-FT-051): absent = ISO metric coarse. */
  standard?: "isofine" | "unc" | "unf" | "bspt";
  fit?: "close" | "normal" | "loose";
  diameter: Num;
  /** upto: to a face or plane (`upTo`); next: until the hole leaves the material; vertex: to the plane through
   *  `upToVertex` square to the hole; offset: `upToOffset` short of the face or plane `upTo` (past it with `reverseOffset`). */
  end: "blind" | "through" | "upto" | "next" | "vertex" | "offset";
  depth: Num;
  upTo?: PlaneRef;
  upToVertex?: VertexRef;
  upToOffset?: Num;
  reverseOffset?: boolean;
  /** Drill point angle of a blind hole (absent = 118°). */
  drillAngle?: Num;
  /** Counterdrill: diameter, depth and the angle of its conical bottom. */
  cdDia?: Num;
  cdDepth?: Num;
  cdAngle?: Num;
  /** Slot: centre-to-centre length and its angle from the plane's X axis. */
  slotLen?: Num;
  slotAngle?: Num;
  /** Slot: Counterbored slot / Countersunk slot (a CAD app's slot types), with `cbDia`/`cbDepth` or `csDia`/`csAngle`. */
  slotHead?: "cbore" | "csink";
  /** Flat bottom instead of a 118° drill point. */
  flat?: boolean;
  /** Reverse direction: the holes run along the plane's normal (Hole Wizard on a plane in the air, e.g. a plane tangent to a shaft). */
  flip?: boolean;
  cbDia?: Num;
  cbDepth?: Num;
  csDia?: Num;
  csAngle?: Num;
  /** Options (FR-FT-051, as in a CAD app's Hole Wizard): a countersink on the near side (at the top of the hole or
   *  its counterbore), under the counterbore's head, and on the far side where a hole that is not blind leaves the
   *  material; head clearance deepens a counterbore or puts a cylinder of the countersink's width above the cone. */
  nearCs?: HoleSink;
  underCs?: HoleSink;
  farCs?: HoleSink;
  headClear?: Num;
  /** Tapered tap: the cone's diameter at the face (the thread's minor diameter there). */
  taperDia?: Num;
  /** Tapped: thread depth (cosmetic thread) and nominal diameter. */
  threadDepth?: Num;
  /** Tapped, hole end not blind: "through" = the thread runs the whole drill (a CAD app's thread Through All); absent = `threadDepth`. */
  threadEnd?: "through";
  major?: number;
  pitch?: number;
  /** Counterbore / countersink / counterdrill: the screw type its head pocket is sized for (holes.ts `ScrewType`); absent = ISO 4762 or ISO 10642. */
  screw?: "iso4762" | "din7984" | "iso7380" | "iso1207" | "iso10642" | "iso2009";
  /** Tapped: thread tolerance class in the callout (absent = 6H, or 2B for inch). */
  tclass?: string;
  /** Tapped (and tapered tap: "remove" only): "remove" cuts the threaded length to the major diameter (a CAD app's Remove thread), "none" drops the
   *  cosmetic thread; absent = cosmetic thread on the tap drill. */
  threadMode?: "remove" | "none";
}

/** A countersink option of a hole: its diameter and included angle. */
export interface HoleSink { dia: Num; angle: Num }

/** The tapped hole's thread runs the whole drill (thread end Through all; only for holes that are not blind). */
/** The head pocket a hole is cut with: a counterbored or countersunk slot cuts like a counterbore or countersink. */
/** An Advanced Hole element: counterbore / straight / tapped = a cylinder of `dia` over `depth` (tapped: `dia` is
 *  the tap drill, `major`/`pitch` the thread; on the main hole `depth` is the thread depth), countersink = a cone
 *  from `dia` at its top down to the next element at `angle`. `size` = the table size the values came from. */
export interface HoleElem { t: "cbore" | "csink" | "straight" | "tapped"; size?: string; dia: Num; depth?: Num; angle?: Num; major?: number; pitch?: number }

/** How many holes the feature makes: its positions on the plane plus those on other faces. */
export function holeCount(f: HoleFeature): number { return f.pts.length + (f.spots?.length ?? 0); }

export function headKind(f: HoleFeature): HoleFeature["kind"] { return f.kind === "slot" && f.slotHead ? f.slotHead : f.kind; }
export function threadThrough(f: HoleFeature): boolean { return f.kind === "tapped" && f.threadEnd === "through" && holeExits(f); }
/** The hole's end is where it leaves the material or meets a face (through, up to next, up to face): far side options apply. */
export function holeExits(f: HoleFeature): boolean { return f.end === "through" || f.end === "next" || f.end === "upto"; }

/**
 * Helix / spiral curve (FR-FT-083): round the circle of a sketch, starting on it at the start angle and
 * running along the sketch normal (reversed: the other way). Two of height, pitch and revolutions set it.
 */
export interface HelixFeature {
  id: string; type: "helix"; name: string; suppressed?: boolean;
  sketch: string;
  /** Which values define it; the third follows. */
  mode: "pitchRev" | "heightRev" | "heightPitch";
  pitch: Num;
  revs: Num;
  height: Num;
  /** Taper angle (outward positive): the radius grows by height·tan(taper). */
  taper?: Num;
  /** Start angle from the sketch's x axis. */
  start?: Num;
  /** Clockwise (left-handed) instead of counter-clockwise about the direction it runs. */
  cw?: boolean;
  reverse?: boolean;
  /**
   * Variable pitch (FR-FT-083, P5): rows of height, pitch and diameter from the start; pitch and
   * diameter vary linearly between rows and the last row's height is the helix height. The mode,
   * pitch, revolutions, height and taper are then unused.
   */
  vpitch?: { h: Num; p: Num; d: Num }[];
  hidden?: boolean;
}

/** Sweep path: an open (or closed) chain of a sketch's curves, a helix feature or a curve feature. */
export type SweepPath = { sketch: string } | { helix: string } | { curve: string };

/** The feature a sweep path names. */
export const pathId = (p: SweepPath): string => "sketch" in p ? p.sketch : "helix" in p ? p.helix : p.curve;

/**
 * 3D curve (FR-FT-085), usable as a sweep path: `xyz` = a smooth curve through points in space
 * (mm, part axes; typed or read from a CSV file), `composite` = model edges joined end to end,
 * `projected` = a sketch's chain of curves projected along its normal onto faces (the nearest
 * piece in front; `flip` looks against the normal first).
 */
export interface CurveFeature {
  id: string; type: "curve"; name: string; suppressed?: boolean;
  kind: "xyz" | "composite" | "projected";
  pts?: V3[];
  closed?: boolean;
  edges?: EdgeRef[];
  sketch?: string;
  faces?: FaceRef[];
  flip?: boolean;
  hidden?: boolean;
}

/** A 3D sketch point (FR-SK-080), part coordinates in mm. */
export interface Sk3Point { id: string; p: V3; fixed?: boolean }
/** A 3D sketch line (two points) or spline (two or more points, the C2 interpolant). */
export interface Sk3Seg { id: string; t: "line" | "spline"; pts: string[] }
/** 3D sketch relations: a line along an axis or parallel to a standard plane, two lines parallel/perpendicular/equal, two points coincident. */
export interface Sk3Rel { id: string; t: "alongX" | "alongY" | "alongZ" | "parallelPlane" | "parallel" | "perpendicular" | "equal" | "coincident"; e: string[]; plane?: "XY" | "YZ" | "ZX" }
/** 3D sketch dimensions: a line's length or the distance between two points. */
export interface Sk3Dim { id: string; t: "length" | "distance"; e: string[]; val: Num }

/**
 * 3D sketch (FR-SK-080): points, lines and splines in space with relations and dimensions. The
 * document keeps solved positions. One chain of segments is a sweep path (`{ curve: id }`).
 */
export interface Sketch3dFeature {
  id: string; type: "sketch3d"; name: string; suppressed?: boolean;
  pts: Sk3Point[];
  segs: Sk3Seg[];
  rels: Sk3Rel[];
  dims: Sk3Dim[];
  hidden?: boolean;
}

/** Swept surface (FR-FT-100): a sketch's chain of curves, open or closed, moved along a path into an open surface. */
export interface SweepSurfFeature {
  id: string; type: "sweepsurf"; name: string; suppressed?: boolean;
  profile: string;
  path?: SweepPath;
  orient?: "follow" | "normal";
}

/**
 * Sweep (FR-FT-080/081): a closed profile sketch, or a circle of the given diameter (circular profile),
 * moved along a path. Boss adds material, cut removes it.
 */
export interface SweepFeature {
  id: string; type: "sweep"; name: string; suppressed?: boolean;
  op: "boss" | "cut";
  /** Feature scope (FR-FT-007), as on an extrude. */
  scope?: FaceRef[];
  /** Profile sketch; absent with `circular`. */
  profile?: string;
  /** Circular profile: diameter, centred on the start of the path and square to it. */
  circular?: Num;
  path?: SweepPath;
  /** Follow path (the profile turns with the path's frame) or keep normal constant. */
  orient?: "follow" | "normal";
  /** Twist along path (P5): the profile turns this far about the path from start to end (follow path only). */
  twist?: Num;
  /** Guide curve (P5): the profile is scaled and turned so that it keeps touching this curve. */
  guide?: SweepPath;
  /** Start tangency "path tangent" (P5): the profile is turned square to the path where it starts. */
  startTangent?: boolean;
  /** End tangency "path tangent" (P5): the sweep ends with the profile square to the path's end. */
  endTangent?: boolean;
  /** Merge result off: a boss makes a new body (like extrude/revolve). */
  merge?: boolean;
}

/** Loft (FR-FT-082): through two or more closed profiles in order. */
export interface LoftFeature {
  id: string; type: "loft"; name: string; suppressed?: boolean;
  op: "boss" | "cut";
  /** Feature scope (FR-FT-007), as on an extrude. */
  scope?: FaceRef[];
  profiles: string[];
  /** Straight (ruled) sections between profiles instead of a smooth surface. */
  ruled?: boolean;
  /** Close loft: back from the last profile to the first (needs three or more). */
  close?: boolean;
  /** Centreline (P5): the loft follows this path between its profiles. */
  centerline?: SweepPath;
  /** Connectors (FR-FT-082): per profile, the sketch point the loft starts from there ("" = automatic). */
  connectors?: string[];
  /** Guide curves (FR-FT-082, P5): sketches or curves that touch every profile; the loft's sections stretch to pass through them. */
  guides?: SweepPath[];
  /** Start / end constraint (FR-FT-082): the loft leaves the first / reaches the last profile square to it. */
  startNormal?: boolean;
  endNormal?: boolean;
  /** Tangent length (1 = default) for the start / end constraint. */
  startLen?: number;
  endLen?: number;
  /** Merge result off: the lofted body is added as a new body (boss only). */
  merge?: boolean;
}

/**
 * Rib (FR-FT-062): an open sketch chain given a thickness and extended to the body. `dir` parallel
 * grows it in the sketch plane (thickness along the sketch normal), normal grows it along the normal
 * (thickness in the plane). `side` puts the thickness on both sides of the curve or one; `flip`
 * tries the other direction first.
 */
export interface RibFeature {
  id: string; type: "rib"; name: string; suppressed?: boolean;
  sketch: string;
  thickness: Num;
  side: "mid" | "one" | "other";
  dir: "parallel" | "normal";
  flip?: boolean;
  /** Draft (FR-FT-062) on a rib normal to the sketch: the walls taper away from the sketch plane. */
  draft?: Num;
  /** The walls get wider away from the sketch instead. */
  draftOut?: boolean;
}

/**
 * Split line (FR-FT-084): the sketch's curves projected along its normal (both ways) split the faces
 * they cross; `faces` limits it to those faces (empty: every face the projection meets). The body
 * keeps its shape; the pieces are separate faces for colours, drafts and mates.
 */
export interface SplitFeature {
  id: string; type: "split"; name: string; suppressed?: boolean;
  sketch: string;
  faces: FaceRef[];
}

/*
 * Multibody (FRS 9.10). A body is named by any face on it (a FaceRef): the solid that holds that
 * face, so body picks follow the persistent face names.
 */
/** Combine (FR-BODY-002): add, subtract the tools from the main body, or keep what they share. */
export interface CombineFeature {
  id: string; type: "combine"; name: string; suppressed?: boolean;
  op: "add" | "subtract" | "common";
  main?: FaceRef;
  tools: FaceRef[];
}
/**
 * Dome (FR-FT-110, P5): each picked flat face bulges out by `distance` at its middle (into the body with
 * `flip`, a dent). A round face gets an exact spherical cap, or half an ellipsoid with `elliptical`
 * (semi-axes = the face radius and the distance); any other outline gets a smooth patch through its
 * edges and the peak above the face's centroid. The dome face is named `<id>:dome:<k>`.
 */
export interface DomeFeature {
  id: string; type: "dome"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  distance: Num;
  flip?: boolean;
  elliptical?: boolean;
}
/**
 * Wrap (FR-FT-104, P5): the closed regions of `sketch` (on a plane parallel to the axis) wrapped round the
 * cylinder `face` without stretching (arc length = sketch distance across the axis) and raised by `depth`
 * (emboss) or sunk into it (deboss). Faces `<id>:top|base|side:<k>`.
 */
export interface WrapFeature {
  id: string; type: "wrap"; name: string; suppressed?: boolean;
  sketch: string;
  face?: FaceRef;
  kind: "emboss" | "deboss";
  depth: Num;
}
/**
 * Indent (FR-BODY-007, P5): the target body takes the shape of the tool bodies. The tools grown by
 * `clearance` are cut out; unless `cut`, a wall `thickness` thick around them is added on the side the
 * tools press into (the target swept that way), like a CAD app's Indent. The tool bodies stay.
 */
export interface IndentFeature {
  id: string; type: "indent"; name: string; suppressed?: boolean;
  main?: FaceRef;
  tools: FaceRef[];
  thickness: Num;
  clearance: Num;
  cut?: boolean;
}
/** Split body (FR-BODY-003, AT-P3-3): cut the bodies (all it crosses, or the picked ones) by a plane into separate bodies. */
export interface SplitBodyFeature {
  id: string; type: "bsplit"; name: string; suppressed?: boolean;
  plane?: PlaneRef;
  bodies: FaceRef[];
}
/** Delete/Keep bodies (FR-BODY-001): remove the picked bodies, or keep only them. */
export interface DeleteBodyFeature {
  id: string; type: "delbody"; name: string; suppressed?: boolean;
  bodies: FaceRef[];
  keep?: boolean;
}
/** Move/Copy body (FR-BODY-004): rotate about an axis, then translate; `copy` adds the moved copies. */
export interface MoveBodyFeature {
  id: string; type: "movebody"; name: string; suppressed?: boolean;
  bodies: FaceRef[];
  copy?: boolean;
  dx: Num; dy: Num; dz: Num;
  axis?: LineRef;
  angle?: Num;
}

/** Scale (FR-BODY-006): bodies (all when none picked) scaled about the origin or each body's centroid. */
export interface ScaleFeature {
  id: string; type: "scale"; name: string; suppressed?: boolean;
  bodies: FaceRef[];
  about: "origin" | "centroid";
  /** Per axis factors `fx`/`fy`/`fz` instead of one `factor`. */
  axes?: boolean;
  factor: Num;
  fx?: Num; fy?: Num; fz?: Num;
}

/**
 * Flex (FR-FT-105, P5): picked bodies (all when none) bent, twisted, tapered or stretched between two
 * trim planes square to `axis`. The planes sit `trim1`/`trim2` in from the bodies' ends along the axis;
 * the triad `origin` (absent = the middle of the bodies' box) is the bend's neutral line, the twist and
 * taper axis and the point that stays put; `toward` is the axis the bend turns to. `hard` false maps the
 * faces whole (no split at the trim planes). Bend/twist take `angle`, taper `factor`, stretch `distance`.
 */
export interface FlexFeature {
  id: string; type: "flex"; name: string; suppressed?: boolean;
  bodies: FaceRef[];
  kind: "bend" | "twist" | "taper" | "stretch";
  axis: "x" | "y" | "z";
  toward?: "x" | "y" | "z";
  angle: Num;
  factor?: Num;
  distance?: Num;
  trim1?: Num; trim2?: Num;
  origin?: V3;
  hard?: boolean;
}

/**
 * Imported body (FR-FT-130, FR-BODY-005): the exact B-rep of a STEP/IGES/BREP file, kept as BREP text
 * in the document. Faces are named `<id>:f<i>` in the file's order. `heal` (FR-FT-131) sews the faces
 * with `tol` and fixes the result into solids; the rebuild reports the check before and after.
 */
export interface ImportFeature {
  id: string; type: "import"; name: string; suppressed?: boolean;
  file: string;
  brep: string;
  heal?: boolean;
  tol?: Num;
}

/**
 * Check and heal (FR-FT-131): the whole body sewn within `tol`, fixed with ShapeFix and closed shells
 * made solids; `unify` also merges faces that lie on one surface. The report is the feature's warning.
 */
export interface HealFeature {
  id: string; type: "heal"; name: string; suppressed?: boolean;
  tol: Num;
  unify?: boolean;
}

/*
 * Surfaces (FRS 9.11, FR-FT-100). Surface bodies are open sheets kept apart from the solid bodies:
 * they show in the view and can be picked, but have no volume and take no part in solid features.
 * Their faces are named like any other, so later features pick them by FaceRef.
 */
/** Planar surface: the sketch's closed regions as flat faces (`<id>:face:k`). */
export interface PlaneSurfFeature {
  id: string; type: "planesurf"; name: string; suppressed?: boolean;
  sketch: string;
  /** Selected Contours (FR-FT-010): a point (sketch coordinates) inside each region to fill; absent = every closed profile. */
  contours?: V2[];
}

/** Extruded surface: each sketch curve (open or closed) swept along the sketch normal into a sheet (`<id>:side:<entity>`). */
export interface ExtrudeSurfFeature {
  id: string; type: "extsurf"; name: string; suppressed?: boolean;
  sketch: string;
  depth: Num;
  flip?: boolean;
  /** Mid plane: half the depth each way. */
  mid?: boolean;
}

/** Offset surface: copies of faces (of solids or surfaces) at a distance along their normals; 0 copies them. */
export interface OffsetSurfFeature {
  id: string; type: "offsurf"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  distance: Num;
  flip?: boolean;
}

/** Knit: sews surface bodies (each named by a face on it) into one; `solid` turns a closed result into a new solid body. */
export interface KnitFeature {
  id: string; type: "knit"; name: string; suppressed?: boolean;
  surfaces: FaceRef[];
  tol: Num;
  solid?: boolean;
}

/** Thicken: a surface body given a thickness to one side, the other or both; merged into the solid bodies unless `merge` is false. */
export interface ThickenFeature {
  id: string; type: "thicken"; name: string; suppressed?: boolean;
  surface?: FaceRef;
  thickness: Num;
  side: "one" | "other" | "both";
  merge?: boolean;
}

/**
 * Replace face (FR-FT-101): the picked faces of a solid are replaced by a surface body; the faces around
 * them grow or shrink to meet it. The new faces take the first picked face's name. The surface stays.
 */
export interface ReplaceFaceFeature {
  id: string; type: "replaceface"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  surface?: FaceRef;
}

/** Revolved surface: the sketch's curves (not the axis line) turned about `axis` by `angle` into sheets (`<id>:side:<entity>`). */
export interface RevolveSurfFeature {
  id: string; type: "revsurf"; name: string; suppressed?: boolean;
  sketch: string;
  axis: string;
  angle: Num;
  flip?: boolean;
}

/** Lofted surface: an open surface through two or more profile sketches, each one chain of curves, open or closed. */
export interface LoftSurfFeature {
  id: string; type: "loftsurf"; name: string; suppressed?: boolean;
  profiles: string[];
  ruled?: boolean;
}

/**
 * Trim surface: a surface body cut by a plane or another surface; the pieces holding the picked
 * faces (`keep`, by their hints) stay. Without `keep`, the larger piece stays.
 */
export interface TrimSurfFeature {
  id: string; type: "trimsurf"; name: string; suppressed?: boolean;
  surface?: FaceRef;
  tool?: { plane: PlaneRef } | { surface: FaceRef };
  /** What a click picks as the tool (UI). */
  toolKind?: "plane" | "surface";
  keep: FaceRef[];
}

/** Filled surface: a patch over the open boundary loop of a surface body nearest `at` (all loops without it); merged (knitted) into it unless `merge` is false. */
export interface FillSurfFeature {
  id: string; type: "fillsurf"; name: string; suppressed?: boolean;
  surface?: FaceRef;
  at?: V3;
  merge?: boolean;
}

/** Extend surface: a one-face surface body grown by `distance` past all its sides. */
export interface ExtendSurfFeature {
  id: string; type: "extendsurf"; name: string; suppressed?: boolean;
  surface?: FaceRef;
  distance: Num;
}

import type { SheetFeature } from "../sheetmetal/types";

/** Untrim surface (FR-FT-100): a one-face surface back to its natural bounds (`all`, the face's parameter box) or with its holes filled (`holes`). */
export interface UntrimSurfFeature {
  id: string; type: "untrimsurf"; name: string; suppressed?: boolean;
  surface?: FaceRef;
  mode?: "all" | "holes";
}

/**
 * Intersect (FR-BODY-007): solids and surfaces cut each other into closed regions; the regions not
 * excluded become bodies (merged into one unless `merge === false`) in place of the picked solids.
 * `exclude` holds a point inside each region left out; `consume` removes the surfaces used.
 */
export interface IntersectFeature {
  id: string; type: "intersect"; name: string; suppressed?: boolean;
  bodies: FaceRef[];
  exclude: V3[];
  merge?: boolean;
  consume?: boolean;
}

/** A region an intersect found: a point inside it, its volume and whether it is left out. */
/** Where each instance of a linear or circular pattern lands (the seed's centre moved), `key` as in `skip`. */
export interface PatternSpot { key: string; p: V3 }
export interface IntersectRegion { c: V3; v: number; out: boolean; /** Indexes of the `exclude` points inside it. */ ex?: number[] }

export type Feature = SheetFeature | SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature | ChamferFeature | PlaneFeature | AxisFeature | PointFeature | CsysFeature
  | ShellFeature | DraftFeature | MirrorFeature | LinearPatternFeature | CircularPatternFeature | SketchPatternFeature | HoleFeature | ThreadFeature
  | HelixFeature | SweepFeature | LoftFeature | RibFeature | SplitFeature | CurveFeature | SweepSurfFeature | Sketch3dFeature
  | CombineFeature | IndentFeature | SplitBodyFeature | DeleteBodyFeature | MoveBodyFeature | ImportFeature | HealFeature | ScaleFeature | DeleteFaceFeature | MoveFaceFeature | DomeFeature | WrapFeature | FlexFeature
  | PlaneSurfFeature | ExtrudeSurfFeature | OffsetSurfFeature | KnitFeature | ThickenFeature | ReplaceFaceFeature | RevolveSurfFeature | LoftSurfFeature | TrimSurfFeature | FillSurfFeature | ExtendSurfFeature | UntrimSurfFeature | IntersectFeature
  | WeldFeature;
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
    material: MatRef | null;
    /** Features that existed then (newer ones keep their suppression when switching). */
    ids: string[];
  };
}

export interface FeatureFolder { id: string; name: string; ids: string[] }

/** A saved camera (FR-UI-104): target, camera position and the orthographic view height, in world mm. */
export interface NamedView { name: string; t: V3; p: V3; h: number }

export interface PartDoc {
  schema: 1;
  kind: "part";
  id: string;
  name: string;
  units: { length: "mm" | "cm" | "m" | "in" | "ft"; decimals: number };
  props: PartProps;
  /** The part's material (FR-MAT-001): name and density, plus the library properties it was picked with. */
  material?: MatRef;
  /** Mass property override (FR-MAT-004), e.g. for a purchased part: mass in kg, centre of mass in mm; each absent one is calculated. */
  massOverride?: { mass?: number; com?: V3 };
  /** Weldment cut list item properties (FR-FT-121), keyed by `cutKey` of the item: own description, part number, notes. */
  cutProps?: Record<string, { desc?: string; part?: string; note?: string; /** Material name from `MATERIALS` for this item's cut list mass (unset = the part's material). */ mat?: string; /** Excluded from the cut list (a CAD app's Exclude from cut list): no item number, mass or CSV row. */ excl?: boolean }>;
  /** Stock bar for the weldment cut list (FR-FT-121): bar length and saw kerf in mm; the Stock lengths table then counts the bars to buy. */
  stock?: { len?: number; kerf?: number };
  /** Sub-weldments (a CAD app's sub-weldment folders in the cut list): named groups of body keys; a body sits in at most one. */
  subWelds?: { id: string; name: string; bodies: string[] }[];
  color?: V3;
  features: Feature[];
  /** Features after this index are not evaluated (rollback bar); null: all. */
  rollback: number | null;
  /**
   * Face naming version: 2 = sweep side faces are matched to sketch curves by a point on each edge (exam #77). Absent (files from
   * before 1.410.0): by the edge's centre of mass, which can give an arc's face the name of a smaller concentric curve; kept so the
   * faces their mates and references name stay the same.
   */
  naming?: 2;
  /** Global variables (Equations). */
  vars?: GlobalVar[];
  /** Configurations; absent: only the default one. */
  configs?: PartConfig[];
  /** Tree folders (FR-HIS-009): user groups of features, by id. */
  folders?: FeatureFolder[];
  /** Freeze bar (FR-HIS-024): this feature and the ones before it are not re-evaluated. */
  freezeAfter?: string;
  /** The active configuration's name. */
  config?: string;
  /** Standard planes hidden in the view (they are shown by default). */
  /** Lock external references (FR-ASM-030): in-context planes keep their stored values. */
  ctxLocked?: boolean;
  stdHidden?: ("XY" | "XZ" | "YZ")[];
  /** Bodies folder (FR-BODY-001): per body key (see `Modeller.bodyInfo`), a name, hidden, colour, and its own material (FR-MAT-001; absent = the part's). */
  bodies?: Record<string, { name?: string; hidden?: boolean; color?: V3; material?: MatRef }>;
  /** Mate references (FR-MATE-011): named faces (persistent names; primary, secondary, tertiary) an assembly mates to a same-named reference on insert. */
  mateRefs?: { name: string; faces: string[] }[];
  /** Named views (FR-UI-104): saved cameras, view data kept out of the undo history. */
  views?: NamedView[];
}

// ---------- kernel results ----------

export interface FeatureStatus { id: string; ok: boolean; code?: string; message?: string; warning?: string }

/** Mass properties of the body for density 1 (mm units): volume, area, centre of mass, principal moments (mm⁵) and axes. */
/** `bodies`: how many solid bodies the part has (FRS 9.10). */
/** `box` = exact bounding box corners of the solids (min, max), where the kernel gives one. */
export interface BodyProps { volume: number; area: number; com: V3; moments?: V3; axes?: [V3, V3, V3]; bodies?: number; box?: [V3, V3] }

export const SCHEMA = 1;
