// Hole positions from a sketch (FR-FT-050, as a CAD app's Hole Wizard Positions tab): a hole with `sketch` takes
// its centres from that sketch's points, so they can be dimensioned and constrained like any sketch geometry.
// Pure: used by the document normalizer, the kernel and the panel.
import type { Feature, HoleFeature, PartDoc, SketchFeature } from "./types";

/**
 * The points of a sketch that get a hole: points that are not construction and that no curve uses (free points),
 * plus the ends of lines and arcs that are not construction (as in other CAD apps; draw construction lines to
 * place holes without holes at their ends). Each point once, in sketch order.
 */
export function holeSketchPoints(sk: Feature | undefined): { id: string; x: number; y: number }[] {
  if (!sk || sk.type !== "sketch") return [];
  const used = new Set<string>(), ends = new Set<string>();
  for (const e of sk.ents) {
    if (e.t === "point") continue;
    const g = e as Record<string, unknown>;
    for (const k of ["a", "b", "c", "p0", "p1", "p"]) { const v = g[k]; if (typeof v === "string") used.add(v); }
    if (e.t === "spline") for (const q of e.pts) used.add(q);
    if ((e.t === "line" || e.t === "arc") && !e.cons) { ends.add(e.a); ends.add(e.b); }
  }
  return sk.ents.filter(e => e.t === "point" && !e.cons && (!used.has(e.id) || ends.has(e.id))) as { id: string; x: number; y: number }[];
}

/** Does this sketch have points a hole can use? */
export const hasHolePoints = (sk: Feature | undefined) => holeSketchPoints(sk).length > 0;

/** The hole's centres from its position sketch, in the sketch's frame; null when it has none. */
export function holeSketchPts(doc: Pick<PartDoc, "features">, f: HoleFeature): [number, number][] | null {
  if (!f.sketch) return null;
  const sk = doc.features.find(x => x.id === f.sketch);
  if (sk?.type !== "sketch") return null;
  return holeSketchPoints(sk).map(p => [p.x, p.y]);
}

/** Copies each sketch-driven hole's plane and centres from its sketch (every change runs it; the sketch is the truth). */
export function syncHoleSketches(doc: Pick<PartDoc, "features">) {
  for (const f of doc.features) if (f.type === "hole") syncHole(doc, f);
}

/** One hole: plane and centres from its sketch. */
export function syncHole(doc: Pick<PartDoc, "features">, f: HoleFeature) {
  if (!f.sketch) return;
  const sk = doc.features.find(x => x.id === f.sketch) as SketchFeature | undefined;
  if (sk?.type !== "sketch") return;
  f.plane = structuredClone(sk.plane);
  f.pts = holeSketchPoints(sk).map(p => [p.x, p.y]);
}
