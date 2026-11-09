// Weldment features (FR-FT-121). Each member, end cap, gusset and weld bead is its own solid body
// in the part's body compound, so the Bodies folder, mass properties and the cut list see them.
import type { FaceRef, Num, PlaneRef } from "../model/types";
import type { Anchor, ProfileType } from "./profiles";

/** A path segment: a line of a 2D sketch or of a 3D sketch, by the sketch's id and the line's id. */
export interface WeldSegRef { sketch: string; ent: string }

/**
 * Structural member: one standard profile swept along straight sketch segments, one solid body per
 * segment. Where two of its segments meet end to end the corner is mitred or butted.
 * Faces: `<id>:<ent>:side:<k>`, `<id>:<ent>:start`, `<id>:<ent>:end`.
 */
export interface MemberFeature {
  id: string; type: "member"; name: string; suppressed?: boolean;
  /** A library profile, or "sketch": the closed 2D sketch `psketch` is the cross-section. */
  profile: ProfileType | "sketch";
  size: string;
  psketch?: string;
  segs: WeldSegRef[];
  /**
   * Corner treatment where two segments meet: mitre, butt (the first runs through), butt (the second runs through), or none.
   * Where three or more segments meet, the first (butt2: the last) runs through and the others are cut square to it.
   */
  corner: "miter" | "butt1" | "butt2" | "none";
  /** Corner treatment of single corners, overriding `corner`: keyed by the meeting segments' ids, sorted and joined with "+" (see `cornerKey`). */
  corners?: Record<string, "miter" | "butt1" | "butt2" | "none">;
  /** Weld gap at corners: a mitre leaves this much between the two ends, a butted member stops this far short of the one running through. */
  gap?: Num;
  /** Cut list description in place of the profile's name. */
  desc?: string;
  /** Where the profile sits on the path; absent: its centre (a sketch profile: the sketch origin). */
  anchor?: Anchor;
  /** Rotation of the profile about the path. */
  angle?: Num;
  /** Mirror the profile left to right. */
  mirror?: boolean;
  /**
   * Groups 2, 3, …: segments (by sketch entity id) with their own profile position, rotation and mirror.
   * Segments in no group are group 1 and use the feature's `anchor`/`angle`/`mirror`.
   */
  groups?: MemberGroup[];
  /** Merge arc segment bodies: an arc and the segments that run on tangent from it become one body (one cut list item, bent length). */
  mergeArcs?: boolean;
}

/** A group of a Structural Member's segments placed with its own profile settings. */
export interface MemberGroup {
  ents: string[];
  anchor?: Anchor;
  angle?: Num;
  mirror?: boolean;
}

/**
 * Trim/Extend: member bodies cut back to, or extended up to, a boundary: a flat face's plane (`face`)
 * or another body (`body`: the end is cut where it meets it).
 */
export interface TrimExtendFeature {
  id: string; type: "trimext"; name: string; suppressed?: boolean;
  /** Bodies to trim: any face of each member segment. */
  bodies: FaceRef[];
  boundary?: FaceRef;
  /** kind face: a reference or standard plane used instead of a picked face. */
  plane?: PlaneRef;
  /** face: cut at a flat face's plane; body: stop at another body; mitre: this member and the boundary member are both lengthened to where their axes meet and cut on the bisector plane (End miter); butt1/butt2: the same two members butted, the first (butt1) or the boundary member (butt2) stopping at the other's side, the other running on to its far side, cut square (End butt). */
  kind: "face" | "body" | "mitre" | "butt1" | "butt2";
  /** Members that end short of the boundary are not lengthened. */
  noExtend?: boolean;
  /** Weld gap: trimmed members stop this far short of the boundary (an end miter splits it between the two ends). */
  gap?: Num;
  /** kind body: a flat end square to the member where it first meets the body (Planar trim) instead of following the body's shape. */
  planar?: boolean;
}

/** End cap: a plate closing a member's open end face, `inset` in from its outer edges, `thickness` thick, outwards (or into the member). */
export interface EndCapFeature {
  id: string; type: "endcap"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  thickness: Num;
  inset: Num;
  /** Corner treatment of the plate: chamfer distance, or the fillet radius when `fillet`. */
  chamfer?: Num;
  /** Round the plate's corners with radius `chamfer` instead of chamfering them. */
  fillet?: boolean;
  /** Old files: true = `dir` "in". */
  inward?: boolean;
  /**
   * Thickness direction (SolidWorks): "out" adds the plate past the end; "in" keeps the overall length
   * (the member is cut back by the thickness); "internal" fits the plate inside a hollow profile's
   * inner outline, flush with the end, `inset` = clearance.
   */
  dir?: "out" | "in" | "internal";
}

/** An end cap's thickness direction (old files use `inward`). */
export const capDir = (f: EndCapFeature): "out" | "in" | "internal" => f.dir ?? (f.inward ? "in" : "out");

/**
 * Gusset: a triangular (or polygonal) plate in the corner between two flat faces that meet at an
 * edge, legs `d1` along the first face and `d2` along the second, `thickness` thick, centred on the
 * shared edge's middle (or flush with one end).
 */
export interface GussetFeature {
  id: string; type: "gusset"; name: string; suppressed?: boolean;
  face1?: FaceRef;
  face2?: FaceRef;
  d1: Num;
  d2: Num;
  thickness: Num;
  /** Polygonal profile: the outer corner is cut off, leaving `d3` along each leg's end. */
  shape: "tri" | "poly";
  d3?: Num;
  /** Inner corner chamfer (clears the weld between the members). */
  chamfer?: Num;
  loc: "mid" | "start" | "end";
  /** Moves the plate from its location along the corner line (from the start or end inwards; from the middle towards the end). */
  offset?: Num;
  /** Where the thickness goes from the location at a start/end location: "in" (default, towards the other end), "both" (centred) or "out". */
  side?: "in" | "both" | "out";
}

/** Fillet weld bead: a triangular bead of leg `size` where faces of set 1 meet faces of set 2 (flat and cylindrical faces); pieces that meet become one bead. */
export interface WeldBeadFeature {
  id: string; type: "weldbead"; name: string; suppressed?: boolean;
  faces1: FaceRef[];
  faces2: FaceRef[];
  size: Num;
  /** false: only the picked faces; otherwise faces that run on smoothly from them join their set (tangent propagation). */
  tangent?: boolean;
  /** Intermittent weld: welds of length `len` every `pitch` (centre to centre) along each chain of edges; `stagger` starts every other chain half a pitch on. */
  inter?: { len: Num; pitch: Num; stagger?: boolean };
  /** false hides the weld symbol in the view. */
  symbol?: false;
  /** Weld all around (ISO 2553 circle at the knee of the symbol). */
  around?: boolean;
  /** Field (site) weld, made on assembly (ISO 2553 flag). */
  field?: boolean;
}

export type WeldFeature = MemberFeature | TrimExtendFeature | EndCapFeature | GussetFeature | WeldBeadFeature;
export const WELD_TYPES: ReadonlySet<string> = new Set(["member", "trimext", "endcap", "gusset", "weldbead"]);

/** One row of a weldment cut list (FR-FT-121): identical items grouped with a quantity. */
export interface CutItem {
  kind: "member" | "plate" | "bead";
  /** "SHS 40x40x3", "PL 5", "Fillet weld a4". */
  desc: string;
  qty: number;
  /** Member length (longest point to point along its axis) or bead length, mm. */
  length?: number;
  /** End cut angles of a member, degrees from square (0 = square cut). */
  angle1?: number;
  angle2?: number;
  /** Plate size (box in its plane) and thickness, mm. */
  plate?: [number, number, number];
  /** Intermittent bead: weld length, pitch, and 1 when staggered. */
  inter?: [number, number] | [number, number, 1];
  /** Volume of one item, mm³ (mass = volume × density). */
  volume: number;
  /** Body keys of the items (Bodies folder). */
  bodies: string[];
}

/** A cut list item's key in `PartDoc.cutProps`: what makes items alike (kind, description, length, end angles, plate size). */
export function cutKey(c: CutItem): string {
  const r = (v: number | undefined) => v == null ? "" : String(Math.round(v * 10) / 10);
  return [c.kind, c.desc, r(c.length), r(c.angle1), r(c.angle2), (c.plate ?? []).map(r).join("x")].join("|") + (c.inter ? `|${c.inter.join("/")}` : "");
}

/** The key of a corner in `MemberFeature.corners`: the meeting segments' ids, sorted, joined with "+". */
export function cornerKey(ents: string[]): string {
  return [...ents].sort().join("+");
}
