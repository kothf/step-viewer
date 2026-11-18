// Names for assembly undo steps (exam #73): what changed between two states of the document, for the Undo/Redo tips.
import type { AsmDoc } from "./types";

/** An English message key and its parameters (translated by the caller with `t`). */
export type StepName = { key: string; params?: Record<string, string | number> };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What turns `before` into `after`, by the first kind of change found (mates, then components, then the rest). */
export function stepName(before: AsmDoc, after: AsmDoc): StepName {
  const m0 = new Map((before.mates ?? []).map(m => [m.id, m])), m1 = new Map((after.mates ?? []).map(m => [m.id, m]));
  const addedM = [...m1.values()].filter(m => !m0.has(m.id)), goneM = [...m0.values()].filter(m => !m1.has(m.id));
  if (addedM.length) return { key: "Add {name}", params: { name: addedM.map(m => m.name).join(", ") } };
  if (goneM.length) return { key: "Delete {name}", params: { name: goneM.map(m => m.name).join(", ") } };
  const c0 = new Map(before.components.map(c => [c.id, c])), c1 = new Map(after.components.map(c => [c.id, c]));
  const addedC = after.components.filter(c => !c0.has(c.id)), goneC = before.components.filter(c => !c1.has(c.id));
  if (addedC.length) return { key: "Insert {name}", params: { name: addedC.map(c => c.name).join(", ") } };
  if (goneC.length) return { key: "Delete {name}", params: { name: goneC.map(c => c.name).join(", ") } };
  const editedM = [...m1.values()].filter(m => !same(m, m0.get(m.id)));
  if (editedM.length) return { key: "Edit {name}", params: { name: editedM.map(m => m.name).join(", ") } };
  // Components whose only change is where they stand (a mate solve moves others along: the first is named).
  const changed = after.components.filter(c => !same(c, c0.get(c.id)));
  const moved = changed.filter(c => { const o = c0.get(c.id)!; return same({ ...c, tf: 0 }, { ...o, tf: 0 }); });
  if (changed.length && moved.length === changed.length) return moved.length === 1 ? { key: "Move {name}", params: { name: moved[0].name } } : { key: "Move {n} components", params: { n: moved.length } };
  const other = changed.find(c => !moved.includes(c));
  if (other) return { key: "Change {name}", params: { name: other.name } };
  return { key: "Change the assembly" };
}
