// Weldment features (FR-FT-121). Each member, end cap, gusset and weld bead is its own solid body
// in the part's body compound, so the Bodies folder, mass properties and the cut list see them.
import type { FaceRef, Num } from "../model/types";
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
  /** face: cut at a flat face's plane; body: stop at another body; mitre: this member and the boundary member are both lengthened to where their axes meet and cut on the bisector plane (End miter). */
  kind: "face" | "body" | "mitre";
  /** Members that end short of the boundary are not lengthened. */
  noExtend?: boolean;
}

/** End cap: a plate closing a member's open end face, `inset` in from its outer edges, `thickness` thick, outwards (or into the member). */
export interface EndCapFeature {
  id: string; type: "endcap"; name: string; suppressed?: boolean;
  faces: FaceRef[];
  thickness: Num;
  inset: Num;
  /** Corner chamfer of the plate. */
  chamfer?: Num;
  inward?: boolean;
}

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
}

/** Fillet weld bead: a triangular bead of leg `size` where faces of set 1 meet faces of set 2 (flat and cylindrical faces); pieces that meet become one bead. */
export interface WeldBeadFeature {
  id: string; type: "weldbead"; name: string; suppressed?: boolean;
  faces1: FaceRef[];
  faces2: FaceRef[];
  size: Num;
  /** false: only the picked faces; otherwise faces that run on smoothly from them join their set (tangent propagation). */
  tangent?: boolean;
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
  /** Volume of one item, mm³ (mass = volume × density). */
  volume: number;
  /** Body keys of the items (Bodies folder). */
  bodies: string[];
}

/** The key of a corner in `MemberFeature.corners`: the meeting segments' ids, sorted, joined with "+". */
export function cornerKey(ents: string[]): string {
  return [...ents].sort().join("+");
}
