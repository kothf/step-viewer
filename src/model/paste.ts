// Copy and paste features (FR-HIS-014): Ctrl+C on a sketch, an extrude, a revolve or a hole in the tree, then Ctrl+V
// with a plane or a flat face selected puts a copy on it (as SolidWorks does). Pure: the controller supplies the
// target plane and stores the result as one undo step.
import { nextName, uid } from "./doc";
import type { Feature, PartDoc, PlaneRef, SketchFeature } from "./types";

/** What Ctrl+C keeps: the features to copy, the sketch first. */
export interface Clip { feats: Feature[] }

/** Fixed English texts (translated when shown) for the references a pasted copy could not take along (FR-TN-004). */
export const LOST = {
  onEdge: "On edge relations became fixed points",
  pierce: "Pierce relations were removed",
  xAxis: "The sketch X axis follows the new plane",
  end: "The end condition went back to Blind",
  start: "The start went back to the sketch plane",
} as const;
export type Lost = (typeof LOST)[keyof typeof LOST];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The clip for a tree row, or null when that kind of feature can't be pasted. */
export function copyClip(doc: PartDoc, id: string): Clip | null {
  const f = doc.features.find(x => x.id === id);
  if (!f) return null;
  if (f.type === "sketch" || f.type === "hole") return { feats: [clone(f)] };
  if (f.type === "extrude" || f.type === "revolve") {
    const sk = doc.features.find(x => x.id === f.sketch);
    return sk?.type === "sketch" ? { feats: [clone(sk), clone(f)] } : null;
  }
  return null;
}

/** Can this row be copied? */
export const canCopy = (f: Feature | undefined) => !!f && (f.type === "sketch" || f.type === "hole" || f.type === "extrude" || f.type === "revolve");

/**
 * Copies of the clip's features placed on `plane`, with new ids and names (`doc` gives the names in use), plus the
 * references that could not follow. Sketch coordinates stay as they were, in the new plane's frame.
 */
export function pasteClip(doc: PartDoc, clip: Clip, plane: PlaneRef, newId: (p: string) => string = uid): { feats: Feature[]; lost: Lost[] } {
  const lost = new Set<Lost>();
  const names = { ...doc, features: [...doc.features] };
  const ids = new Map<string, string>();
  const out: Feature[] = [];
  for (const src of clip.feats) {
    const f = clone(src) as Feature;
    const id = newId("f_");
    ids.set(f.id, id);
    f.id = id;
    delete f.suppressed;
    if (f.type === "sketch") {
      sketchOn(f, plane, lost);
      f.name = nextName(names, "sketch");
    } else if (f.type === "extrude") {
      f.sketch = ids.get(f.sketch) ?? f.sketch;
      if (f.end === "upto" || f.end === "offset" || f.end === "vertex" || f.end === "body") { f.end = "blind"; lost.add(LOST.end); }
      delete f.upTo; delete f.upToOffset; delete f.reverseOffset; delete f.upToVertex; delete f.upToBody; delete f.outside;
      if (f.end2 === "upto" || f.end2 === "offset" || f.end2 === "vertex" || f.end2 === "body") { f.end2 = "blind"; lost.add(LOST.end); }
      if (f.end2 === "blind" && f.end === "blind") delete f.end2;
      delete f.upTo2; delete f.upToOffset2; delete f.reverseOffset2; delete f.upToVertex2; delete f.upToBody2;
      if (f.start === "surface" || f.start === "vertex") { delete f.start; lost.add(LOST.start); }
      delete f.startRef; delete f.startVertex;
      f.name = nextName(names, "extrude", f.op === "cut");
    } else if (f.type === "revolve") {
      f.sketch = ids.get(f.sketch) ?? f.sketch;
      if (f.end === "upto") { delete f.end; lost.add(LOST.end); }
      delete f.upTo;
      f.name = nextName(names, "revolve");
    } else if (f.type === "hole") {
      f.plane = plane;
      if (f.end === "upto") { f.end = "blind"; lost.add(LOST.end); }
      delete f.upTo;
      f.name = nextName(names, "hole");
    }
    names.features.push(f);
    out.push(f);
  }
  return { feats: out, lost: [...lost] };
}

function sketchOn(sk: SketchFeature, plane: PlaneRef, lost: Set<Lost>) {
  sk.plane = plane;
  if (sk.xAxis) { delete sk.xAxis; lost.add(LOST.xAxis); }
  const rels = [];
  for (const r of sk.rels) {
    if (r.t === "pierce") { lost.add(LOST.pierce); continue; }
    if (r.ext) { delete r.ext; delete r.dangling; lost.add(LOST.onEdge); }
    rels.push(r);
  }
  sk.rels = rels;
}
