// Document store: every change goes through `change()` (a command with a label),
// which gives undo/redo, dirty tracking and autosave in one place (FRS 6.2, 7.4).
// Undo keeps whole snapshots: part documents are small JSON, and snapshots can't drift.
import { SCHEMA, type Feature, type FeatureType, type PartDoc } from "./types";

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
const BASE: Record<FeatureType, string> = { sketch: "Sketch", extrude: "Extrude", revolve: "Revolve", fillet: "Fillet", chamfer: "Chamfer" };

export function nextName(doc: PartDoc, type: FeatureType, cut = false) {
  const base = cut ? (type === "revolve" ? "Revolve cut" : "Cut") : BASE[type];
  let n = 1;
  const names = new Set(doc.features.map(f => f.name));
  while (names.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export class DocStore {
  private undoStack: { doc: string; label: string }[] = [];
  private redoStack: { doc: string; label: string }[] = [];
  private listeners: ((why: string) => void)[] = [];
  /** Snapshot at the last save, to tell whether there are unsaved changes. */
  private savedAt: string;
  doc: PartDoc;

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
    if (JSON.stringify(next) === before) return false;
    this.undoStack.push({ doc: before, label });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.emit(label);
    return true;
  }

  /** Replaces the document without an undo step (opening a file). */
  reset(doc: PartDoc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = JSON.stringify(doc);
    this.emit("open");
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

/** Features that use this one (a sketch's extrude, a face's sketch on it...). */
export function dependants(doc: PartDoc, id: string): Feature[] {
  const out: Feature[] = [];
  const idx = doc.features.findIndex(f => f.id === id);
  const uses = (f: Feature, x: string) => {
    if ((f.type === "extrude" || f.type === "revolve") && f.sketch === x) return true;
    const names: string[] = [];
    if (f.type === "sketch" && "face" in f.plane) names.push(f.plane.face.name);
    if (f.type === "fillet" || f.type === "chamfer") for (const e of f.edges) names.push(...e.faces);
    return names.some(n => n.startsWith(`${x}:`));
  };
  const ids = new Set([id]);
  for (const f of doc.features.slice(idx + 1)) if ([...ids].some(x => uses(f, x))) { out.push(f); ids.add(f.id); }
  return out;
}
