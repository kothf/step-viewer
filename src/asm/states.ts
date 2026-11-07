// Display states (FR-ASM-025): named sets of visibility, colour and transparency per component.
// As with configurations, the active state's looks live on the components themselves; the others
// keep copies, swapped in by `activateState`.
import type { AsmDoc, DisplayState, Look } from "./types";

/** The components' looks now. */
export function looksOf(doc: AsmDoc): Record<string, Look> {
  const out: Record<string, Look> = {};
  for (const c of doc.components) {
    const l: Look = {};
    if (c.hidden) l.hidden = true;
    if (c.color) l.color = [...c.color];
    if (c.opacity !== undefined && c.opacity < 1) l.opacity = c.opacity;
    out[c.id] = l;
  }
  return out;
}

/** Puts looks on the components; a component the state does not know is shown plain. */
export function applyLooks(doc: AsmDoc, looks: Record<string, Look>) {
  for (const c of doc.components) {
    const l = looks[c.id] ?? {};
    if (l.hidden) c.hidden = true; else delete c.hidden;
    if (l.color) c.color = [...l.color]; else delete c.color;
    if (l.opacity !== undefined && l.opacity < 1) c.opacity = l.opacity; else delete c.opacity;
  }
}

/** The states, with a "Default" holding the current looks when there were none. */
function ensure(doc: AsmDoc): DisplayState[] {
  if (!doc.states?.length) {
    doc.states = [{ id: "ds_default", name: "Default", looks: looksOf(doc) }];
    doc.activeState = "ds_default";
  }
  if (!doc.states.some(s => s.id === doc.activeState)) doc.activeState = doc.states[0].id;
  return doc.states;
}

/** A new state copying the current looks, made active; returns its id. */
export function addState(doc: AsmDoc, name: string, id: string): string {
  const states = ensure(doc);
  const cur = states.find(s => s.id === doc.activeState)!;
  cur.looks = looksOf(doc);
  states.push({ id, name, looks: looksOf(doc) });
  doc.activeState = id;
  return id;
}

/** Stores the current looks in the active state and puts the chosen state's on the components. */
export function activateState(doc: AsmDoc, id: string): boolean {
  const states = ensure(doc);
  const to = states.find(s => s.id === id);
  if (!to) return false;
  if (id === doc.activeState) return true;
  states.find(s => s.id === doc.activeState)!.looks = looksOf(doc);
  applyLooks(doc, to.looks);
  doc.activeState = id;
  return true;
}

/** Deletes a state (not the last one); deleting the active one activates the first other. */
export function deleteState(doc: AsmDoc, id: string): boolean {
  const states = ensure(doc);
  if (states.length < 2 || !states.some(s => s.id === id)) return false;
  if (doc.activeState === id) activateState(doc, states.find(s => s.id !== id)!.id);
  doc.states = states.filter(s => s.id !== id);
  return true;
}
