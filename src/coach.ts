/**
 * First-use coach marks (gap list U5): the first time a command's panel opens, a short card at the top of the
 * panel says how the command is used, as other CAD apps do. Each shows once; "Turn off tips" stops them (the same
 * switch as the other first-use tips, Settings ▸ General). Never over the model: the card sits in the panel.
 */
import { tipsOn } from "./hints";
import { storage } from "./ui";

/** Command key (feature type, "cut" for an extruded cut, "sketch") → [title, how]. English text is the i18n key. */
export const COACH: Record<string, [string, string]> = {
  sketch: ["Sketching", "Pick a tool on the Sketch tab and click in the view. Dimensions and relations make the shape fully defined (black); ✓ or Enter leaves the sketch."],
  extrude: ["Extrude", "Drag the arrow on the model or type the depth. A second direction, draft and end conditions are in the panel; ✓ or Enter finishes."],
  cut: ["Extruded cut", "The cut goes into the material. Drag the arrow or type the depth, or pick Through all; the yellow preview shows what is taken away."],
  revolve: ["Revolve", "Pick the axis (a centerline or a straight edge), then the angle. A profile must lie on one side of the axis."],
  fillet: ["Fillet", "Click edges or faces on the model; every picked edge gets the radius. Tangent edges are taken along; right-click an edge for loops and chains."],
  chamfer: ["Chamfer", "Click edges on the model, then set the distance (or distance and angle). Right-click an edge to take its whole loop."],
  shell: ["Shell", "Click the faces to remove, then set the wall thickness. With no face picked the part becomes hollow inside."],
  hole: ["Hole", "Pick the hole type and size, then click on a flat face to place each hole; the Positions box holds the centres."],
  mirror: ["Mirror", "Pick a plane or flat face to mirror about, then the features, faces or bodies to copy."],
  lpattern: ["Linear pattern", "Pick a direction (an edge, axis or face), the spacing and the count, then what to copy. Click a copy's dot to skip it."],
  cpattern: ["Circular pattern", "Pick an axis (a round face, an axis or an edge), the count and the angle, then what to copy."],
  sweep: ["Sweep", "Pick a closed profile sketch and a path (a sketch, helix or curve); the profile follows the path."],
  loft: ["Loft", "Pick two or more profiles in order; guide curves and start/end constraints shape the transition."],
  draft: ["Draft", "Pick the neutral plane, then the faces to taper and the angle."],
  plane: ["Plane", "Pick one to three references (faces, edges, points); the plane takes an offset, angle or passes through them."],
};

const SEEN = "mc:coach";

const seen = (): Set<string> => new Set((storage.get(SEEN) ?? "").split(",").filter(Boolean));

/** Coach marks are wanted: tips on, and not under test automation unless the page asks with `?coach`. */
export function coachWanted(): boolean {
  if (!tipsOn()) return false;
  if (navigator.webdriver && !new URLSearchParams(location.search).has("coach")) return false;
  return true;
}

/** True the first time for `key` (and marks it seen); false when shown before, unknown or unwanted. */
export function coachFirst(key: string): boolean {
  if (!(key in COACH) || !coachWanted()) return false;
  const s = seen();
  if (s.has(key)) return false;
  s.add(key);
  storage.set(SEEN, [...s].join(","));
  return true;
}

/** Forgets which coach marks were shown (Help ▸ tips reset). */
export function resetCoach() { storage.set(SEEN, ""); }
