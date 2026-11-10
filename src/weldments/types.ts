// Weldment features (FR-FT-121). Each member, end cap, gusset and weld bead is its own solid body
// in the part's body compound, so the Bodies folder, mass properties and the cut list see them.
import type { FaceRef, Num, PlaneRef } from "../model/types";
import type { Anchor, ProfileType } from "./profiles";

/**
 * Where a member's profile sits on its path: a library anchor (box corners, edge middles, centre), "o" the
 * profile sketch's origin, or `p:<point id>` any point of the profile sketch (SolidWorks' Locate profile).
 */
export type Pierce = Anchor | "o" | `p:${string}`;

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
  anchor?: Pierce;
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
  /** Merge miter trimmed bodies: segments meeting at a mitred corner (no weld gap) become one body. */
  mergeMiter?: boolean;
  /** Coped cut: a butted member's end follows the shape of the member it stops at (a saddle on a round tube) instead of a flat cut square to its face. */
  coped?: boolean;
  /**
   * Alignment (SolidWorks' Align): the profile's vertical (`axis` "v") or horizontal ("h") axis points along this
   * straight sketch line, square to each segment, before the rotation angle; for every group. Absent: a 2D path
   * sketch's normal (else world Z) is up.
   */
  align?: { sketch: string; ent: string; axis: "h" | "v" };
}

/** A group of a Structural Member's segments placed with its own profile settings. */
export interface MemberGroup {
  ents: string[];
  anchor?: Pierce;
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
  /** Use thickness ratio (not with "internal"): the inset is this times the member's wall thickness (the end face's tube wall, else 2 × area / perimeter). */
  ratio?: Num;
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
  /** Polygonal profile: the flat at the end of leg 2 (along face 1's direction) when it differs from `d3`. */
  d4?: Num;
  /** Polygonal profile: the sloping edge's angle from face 1 (radians); sets the flat at the end of leg 2 instead of `d4`. */
  polyAngle?: Num;
  /** Inner corner chamfer (clears the weld between the members): the distance along face 1, and along face 2 unless `chamfer2`. */
  chamfer?: Num;
  /** The chamfer's distance along face 2 when it differs. */
  chamfer2?: Num;
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
  /** Leg on the faces of set 2 when the legs differ (unequal leg fillet); absent = both legs `size`. */
  size2?: Num;
  /** false: only the picked faces; otherwise faces that run on smoothly from them join their set (tangent propagation). */
  tangent?: boolean;
  /** Intermittent weld: welds of length `len` every `pitch` (centre to centre) along each chain of edges; `stagger` starts every other chain half a pitch on. */
  inter?: { len: Num; pitch: Num; stagger?: boolean };
  /** From/to length: the bead only from `start` along each chain of edges for `len` (from the chain's other end when `flip`); intermittent welds fill this span. */
  span?: { start: Num; len: Num; flip?: boolean };
  /** Weld both sides: each flat face of set 1 also brings the face on the other side of its plate (the nearest flat face of the same body facing the opposite way behind it). */
  both?: boolean;
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
  /** The sub-weldment (`PartDoc.subWelds` id) the item's bodies sit in; set by `splitSubs`, never by the kernel. */
  sub?: string;
}

/** A cut list item's key in `PartDoc.cutProps`: what makes items alike (kind, description, length, end angles, plate size). */
export function cutKey(c: CutItem): string {
  const r = (v: number | undefined) => v == null ? "" : String(Math.round(v * 10) / 10);
  return [c.kind, c.desc, r(c.length), r(c.angle1), r(c.angle2), (c.plate ?? []).map(r).join("x")].join("|") + (c.inter ? `|${c.inter.join("/")}` : "");
}

export interface SubWeld { id: string; name: string; bodies: string[] }

/**
 * The cut list as shown (SolidWorks' sub-weldment folders): items whose bodies sit in different sub-weldments are split,
 * the quantity following the body count (a bead's volume and length share out by its bodies). Items outside every sub-weldment
 * come first, then each sub-weldment's in `subs` order; `cutKey` ignores `sub`, so item properties stay shared.
 */
export function splitSubs(items: CutItem[], subs: SubWeld[] | undefined): CutItem[] {
  if (!subs?.length) return items;
  const owner = new Map<string, string>();
  for (const s of subs) for (const b of s.bodies) if (!owner.has(b)) owner.set(b, s.id);
  const groups = new Map<string, CutItem[]>([["", []], ...subs.map(s => [s.id, []] as [string, CutItem[]])]);
  for (const c of items) {
    const by = new Map<string, string[]>();
    for (const b of c.bodies) { const k = owner.get(b) ?? ""; by.set(k, [...(by.get(k) ?? []), b]); }
    if (!c.bodies.length) by.set("", []);
    for (const [k, bs] of by) {
      const part: CutItem = { ...c, bodies: bs };
      if (by.size > 1) {
        // A bead row sums its bodies: volume and length share out by body count.
        if (c.kind === "bead") { const f = bs.length / c.bodies.length; part.volume = c.volume * f; if (c.length != null) part.length = Math.round(c.length * f * 10) / 10; }
        else part.qty = bs.length;
      }
      if (k) part.sub = k; else delete part.sub;
      groups.get(k)!.push(part);
    }
  }
  return [...groups.values()].flat();
}

/** The key of a corner in `MemberFeature.corners`: the meeting segments' ids, sorted, joined with "+". */
export function cornerKey(ents: string[]): string {
  return [...ents].sort().join("+");
}
