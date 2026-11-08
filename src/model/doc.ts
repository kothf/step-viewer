// Document store: every change goes through `change()` (a command with a label),
// which gives undo/redo, dirty tracking and autosave in one place (FRS 6.2, 7.4).
// Undo keeps whole snapshots: part documents are small JSON, and snapshots can't drift.
import { SCHEMA, pathId, type Feature, type FeatureType, type PartDoc, type LineRef, type PlaneRef, type VertexRef } from "./types";

const UNDO_DEPTH = 200;

export const uid = (p = "") => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function newPart(name = "Part1"): PartDoc {
  return {
    schema: SCHEMA, kind: "part", id: uid("d_"), name,
    units: { length: "mm", decimals: 2 },
    props: {},
    features: [],
    rollback: null,
  };
}

/** English base names; shown translated, stored as is. */
const BASE: Record<FeatureType, string> = { sketch: "Sketch", extrude: "Extrude", revolve: "Revolve", fillet: "Fillet", chamfer: "Chamfer", plane: "Plane", axis: "Axis", point: "Point", csys: "Coordinate system", shell: "Shell", draft: "Draft", mirror: "Mirror", lpattern: "LPattern", cpattern: "CirPattern", hole: "Hole", thread: "Thread", helix: "Helix", sweep: "Sweep", loft: "Loft", rib: "Rib", split: "Split Line", combine: "Combine", bsplit: "Split", delbody: "Body-Delete/Keep", movebody: "Body-Move/Copy", import: "Imported", scale: "Scale", delface: "DeleteFace", moveface: "MoveFace", planesurf: "Surface-Plane", extsurf: "Surface-Extrude", offsurf: "Surface-Offset", knit: "Surface-Knit", thicken: "Thicken", replaceface: "ReplaceFace", revsurf: "Surface-Revolve", loftsurf: "Surface-Loft", trimsurf: "Surface-Trim", fillsurf: "Surface-Fill", extendsurf: "Surface-Extend", curve: "Curve", sweepsurf: "Surface-Sweep", sketch3d: "3DSketch" };
/** Every feature type this version knows: a file with another one needs a newer app. */
export const FEATURE_TYPES: readonly string[] = Object.keys(BASE);

export function nextName(doc: PartDoc, type: FeatureType, cut = false) {
  const base = cut ? (type === "revolve" ? "Revolve cut" : type === "sweep" ? "Cut-Sweep" : type === "loft" ? "Cut-Loft" : "Cut") : BASE[type];
  let n = 1;
  const names = new Set(doc.features.map(f => f.name));
  while (names.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export class DocStore {
  private undoStack: { doc: string; label: string; seq?: number }[] = [];
  private redoStack: { doc: string; label: string }[] = [];
  private seq = 0;
  private listeners: ((why: string) => void)[] = [];
  /** Snapshot at the last save, to tell whether there are unsaved changes. */
  private savedAt: string;
  doc: PartDoc;
  /** Runs on every change before it is stored (re-evaluates equations). */
  normalize: ((d: PartDoc) => void) | null = null;

  constructor(doc: PartDoc) {
    this.doc = doc;
    this.savedAt = JSON.stringify(doc);
  }

  onChange(fn: (why: string) => void) { this.listeners.push(fn); }
  private emit(why: string) { for (const l of this.listeners) l(why); }

  /** Applies a change; the label names it in the undo button ("Undo Extrude1 depth"). */
  change(label: string, fn: (d: PartDoc) => void) {
    const before = JSON.stringify(this.doc);
    const next: PartDoc = JSON.parse(before);
    fn(next);
    this.normalize?.(next);
    if (JSON.stringify(next) === before) return false;
    this.undoStack.push({ doc: before, label, seq: ++this.seq });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.emit(label);
    return true;
  }

  /**
   * Updates the document in place without an undo step or a change event: results the rebuild
   * derives from it (On edge curves that followed the model). Undo goes back to a document the
   * next rebuild derives the same way.
   */
  amend(fn: (d: PartDoc) => void) { fn(this.doc); }

  /** Replaces the document without an undo step (opening a file). */
  reset(doc: PartDoc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = JSON.stringify(doc);
    this.emit("open");
  }

  /** A mark for `collapse`: steps made after it can be merged into one. */
  mark() { return this.seq + 1; }

  /** Merges the undo steps made since `mark` into one (leaving a sketch: FR-UND-003). */
  collapse(mark: number, label: string) {
    const i = this.undoStack.findIndex(s => (s.seq ?? 0) >= mark);
    if (i < 0) return;
    const first = this.undoStack[i];
    this.undoStack.splice(i, this.undoStack.length - i, { doc: first.doc, label, seq: first.seq });
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ""; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ""; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ doc: JSON.stringify(this.doc), label: s.label });
    this.doc = JSON.parse(s.doc);
    this.emit("undo");
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ doc: JSON.stringify(this.doc), label: s.label });
    this.doc = JSON.parse(s.doc);
    this.emit("redo");
  }

  get dirty() { return JSON.stringify(this.doc) !== this.savedAt; }
  markSaved() { this.savedAt = JSON.stringify(this.doc); this.emit("saved"); }

  feature(id: string): Feature | undefined { return this.doc.features.find(f => f.id === id); }
}

/** Names of model faces and features a feature refers to (for dependants and repair). */
export function featureRefs(f: Feature): { faces: string[]; features: string[] } {
  const faces: string[] = [], features: string[] = [];
  const plane = (p: PlaneRef | undefined) => {
    if (!p) return;
    if ("face" in p) faces.push(p.face.name);
    else if ("plane" in p) features.push(p.plane);
  };
  if (f.type === "extrude" || f.type === "revolve") features.push(f.sketch);
  if (f.type === "extrude" || f.type === "revolve") plane(f.upTo);
  if (f.type === "extrude") {
    const vtx = (v: VertexRef | undefined) => { if (v) { if ("point" in v) features.push(v.point); else faces.push(...v.edge.faces); } };
    if (f.end === "vertex") vtx(f.upToVertex);
    if (f.start === "surface") plane(f.startRef);
    if (f.start === "vertex") vtx(f.startVertex);
  }
  if (f.type === "thread" && f.edge) faces.push(...f.edge.faces);
  if (f.type === "sketch") plane(f.plane);
  if (f.type === "plane") { plane(f.base); if (f.axis) faces.push(...f.axis.faces); }
  if (f.type === "axis" || f.type === "point") { if (f.edge) faces.push(...f.edge.faces); if (f.face) faces.push(f.face.name); }
  if (f.type === "axis") for (const p of f.planes ?? []) plane(p);
  if (f.type === "csys" && f.origin) { if ("point" in f.origin) features.push(f.origin.point); else faces.push(...f.origin.edge.faces); }
  if (f.type === "fillet" || f.type === "chamfer") for (const e of f.edges) faces.push(...e.faces);
  if (f.type === "fillet") for (const x of [...(f.faces1 ?? []), ...(f.faces2 ?? []), ...(f.center ?? [])]) faces.push(x.name);
  const line = (l: LineRef | undefined) => {
    if (!l) return;
    if (l.edge) faces.push(...l.edge.faces);
    if (l.face) faces.push(l.face.name);
    if (l.axis) features.push(l.axis);
  };
  if (f.type === "csys") { line(f.x); line(f.z); }
  if (f.type === "moveface") line(f.axis);
  if (f.type === "hole") plane(f.plane);
  if (f.type === "shell" || f.type === "delface" || f.type === "moveface") faces.push(...f.faces.map(x => x.name));
  if (f.type === "draft") { plane(f.plane); faces.push(...f.faces.map(x => x.name)); }
  if (f.type === "mirror") { plane(f.plane); features.push(...f.features); }
  if (f.type === "lpattern") { line(f.dir); line(f.dir2); features.push(...f.features); }
  if (f.type === "cpattern") { line(f.axis); features.push(...f.features); }
  if (f.type === "helix") features.push(f.sketch);
  if (f.type === "sweep") { if (f.profile) features.push(f.profile); if (f.path) features.push(pathId(f.path)); }
  if (f.type === "sweepsurf") { features.push(f.profile); if (f.path) features.push(pathId(f.path)); }
  if (f.type === "curve") { if (f.sketch) features.push(f.sketch); for (const e of f.edges ?? []) faces.push(...e.faces); faces.push(...(f.faces ?? []).map(x => x.name)); }
  if (f.type === "loft") features.push(...f.profiles);
  if (f.type === "rib") features.push(f.sketch);
  if (f.type === "combine") { if (f.main) faces.push(f.main.name); faces.push(...f.tools.map(x => x.name)); }
  if (f.type === "bsplit") { plane(f.plane); faces.push(...f.bodies.map(x => x.name)); }
  if (f.type === "scale") faces.push(...f.bodies.map(x => x.name));
  if (f.type === "delbody") faces.push(...f.bodies.map(x => x.name));
  if (f.type === "movebody") { faces.push(...f.bodies.map(x => x.name)); line(f.axis); }
  if (f.type === "split") { features.push(f.sketch); faces.push(...f.faces.map(x => x.name)); }
  if (f.type === "planesurf" || f.type === "extsurf") features.push(f.sketch);
  if (f.type === "offsurf") faces.push(...f.faces.map(x => x.name));
  if (f.type === "knit") faces.push(...f.surfaces.map(x => x.name));
  if (f.type === "thicken" && f.surface) faces.push(f.surface.name);
  if (f.type === "revsurf") features.push(f.sketch);
  if (f.type === "loftsurf") features.push(...f.profiles);
  if (f.type === "trimsurf") { if (f.surface) faces.push(f.surface.name); if (f.tool) { if ("plane" in f.tool) plane(f.tool.plane); else faces.push(f.tool.surface.name); } faces.push(...f.keep.map(x => x.name)); }
  if ((f.type === "fillsurf" || f.type === "extendsurf") && f.surface) faces.push(f.surface.name);
  if (f.type === "replaceface") { faces.push(...f.faces.map(x => x.name)); if (f.surface) faces.push(f.surface.name); }
  return { faces, features };
}

/** Features that use this one (a sketch's extrude, a face's sketch on it...). */
export function dependants(doc: PartDoc, id: string): Feature[] {
  const out: Feature[] = [];
  const idx = doc.features.findIndex(f => f.id === id);
  const uses = (f: Feature, x: string) => {
    const r = featureRefs(f);
    return r.features.includes(x) || r.faces.some(n => n.startsWith(`${x}:`));
  };
  const ids = new Set([id]);
  for (const f of doc.features.slice(idx + 1)) if ([...ids].some(x => uses(f, x))) { out.push(f); ids.add(f.id); }
  return out;
}

/** Features this one needs (directly): earlier features whose faces or results it refers to. */
export function parents(doc: PartDoc, f: Feature): string[] {
  const r = featureRefs(f);
  const ids = new Set(r.features);
  for (const n of r.faces) ids.add(n.split(":")[0]);
  return doc.features.filter(g => ids.has(g.id)).map(g => g.id);
}

/**
 * Reorder check (FR-HIS-006): the first feature that would come before something it uses,
 * or null when every feature still follows its parents.
 */
export function orderProblem(features: Feature[]): { feature: Feature; parent: Feature } | null {
  const seen = new Set<string>();
  const ids = new Set(features.map(f => f.id));
  for (const f of features) {
    const r = featureRefs(f);
    const need = new Set([...r.features, ...r.faces.map(n => n.split(":")[0])]);
    for (const p of need) if (ids.has(p) && !seen.has(p) && p !== f.id) return { feature: f, parent: features.find(g => g.id === p)! };
    seen.add(f.id);
  }
  return null;
}

/** Features in a new order: `ids` (kept together, in their order) moved to before index `to` of the others. */
export function moved(features: Feature[], ids: string[], to: number): Feature[] {
  const block = features.filter(f => ids.includes(f.id));
  const rest = features.filter(f => !ids.includes(f.id));
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, ...block);
  return rest;
}
