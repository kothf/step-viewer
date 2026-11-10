// Drawing document store: changes go through `change()` with a label, giving undo,
// redo and dirty tracking (same model as the part DocStore, kept separate).
import type { DrawingDoc, Sheet } from "./types";

export const uid = (p = "") => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function newSheet(n: number, base?: Partial<Sheet>): Sheet {
  const s: Sheet = { id: uid("s_"), name: `Sheet${n}`, size: base?.size ?? "A3", portrait: base?.portrait, scale: base?.scale ?? [1, 1], projection: base?.projection ?? "first", format: base?.format ?? "iso", views: [] };
  // The sheet format goes along, as in SolidWorks: a custom size and a user title block (drawings exam #31: both were dropped).
  if (base?.w !== undefined) s.w = base.w;
  if (base?.h !== undefined) s.h = base.h;
  if (base?.tb) s.tb = structuredClone(base.tb);
  return s;
}

export class DrawingStore {
  private undoStack: { doc: string; label: string }[] = [];
  private redoStack: { doc: string; label: string }[] = [];
  private savedAt: string;
  private listeners: ((why: string) => void)[] = [];
  doc: DrawingDoc;

  constructor(doc: DrawingDoc) { this.doc = doc; this.savedAt = JSON.stringify(doc); }

  onChange(fn: (why: string) => void) { this.listeners.push(fn); }
  private emit(why: string) { for (const l of this.listeners) l(why); }

  /** Applies a change; `merge` folds it into the last step with the same label (a drag). */
  change(label: string, fn: (d: DrawingDoc) => void, merge = false) {
    const before = JSON.stringify(this.doc);
    const next = JSON.parse(before) as DrawingDoc;
    fn(next);
    if (JSON.stringify(next) === before) return false;
    if (!(merge && this.undoStack.at(-1)?.label === label)) this.undoStack.push({ doc: before, label });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.emit("change");
    return true;
  }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push({ doc: JSON.stringify(this.doc), label: s.label }); this.doc = JSON.parse(s.doc); this.emit("undo"); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push({ doc: JSON.stringify(this.doc), label: s.label }); this.doc = JSON.parse(s.doc); this.emit("redo"); }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? null; }
  get dirty() { return JSON.stringify(this.doc) !== this.savedAt; }
  markSaved() { this.savedAt = JSON.stringify(this.doc); }
}
