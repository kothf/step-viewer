// Assembly configurations (FR-ASM-026): named sets of component suppression, the part configuration
// each component uses, mate values and suppression, and assembly feature suppression. As with part
// configurations and display states, the active one's values live in the document itself; the others
// keep copies, swapped in by `activateConfig`. A component's part configuration is a part entry of its
// own (the part's document with that configuration active), so it is a part key in the state.
import type { AsmConfig, AsmConfigState, AsmDoc } from "./types";

/** The values a configuration controls, read from the document. */
export function captureConfig(doc: AsmDoc): AsmConfigState {
  const mates: AsmConfigState["mates"] = {};
  for (const m of doc.mates ?? []) {
    const v: AsmConfigState["mates"][string] = {};
    if (m.value !== undefined) v.value = m.value;
    if (m.min !== undefined) v.min = m.min;
    if (m.max !== undefined) v.max = m.max;
    if (m.suppressed) v.suppressed = true;
    mates[m.id] = v;
  }
  return {
    suppressed: doc.components.filter(c => c.suppressed).map(c => c.id),
    parts: Object.fromEntries(doc.components.map(c => [c.id, c.part])),
    mates,
    features: (doc.features ?? []).filter(f => f.suppressed).map(f => f.id),
  };
}

/** Puts a configuration's values on the document; components, mates and features it does not know keep theirs. */
export function applyConfig(doc: AsmDoc, s: AsmConfigState) {
  const sup = new Set(s.suppressed);
  for (const c of doc.components) {
    if (!(c.id in s.parts)) continue;
    if (sup.has(c.id)) c.suppressed = true; else delete c.suppressed;
    if (doc.parts[s.parts[c.id]]) c.part = s.parts[c.id];
  }
  for (const m of doc.mates ?? []) {
    const v = s.mates[m.id];
    if (!v) continue;
    if (v.value !== undefined) m.value = v.value;
    if (v.min !== undefined) m.min = v.min;
    if (v.max !== undefined) m.max = v.max;
    if (v.suppressed) m.suppressed = true; else delete m.suppressed;
  }
  const fs = new Set(s.features);
  for (const f of doc.features ?? []) if (fs.has(f.id)) f.suppressed = true; else delete f.suppressed;
}

/** The configurations, with a "Default" holding the current values when there were none. */
function ensure(doc: AsmDoc): AsmConfig[] {
  if (!doc.configs?.length) {
    doc.configs = [{ id: "cf_default", name: "Default", state: captureConfig(doc) }];
    doc.activeConfig = "cf_default";
  }
  if (!doc.configs.some(c => c.id === doc.activeConfig)) doc.activeConfig = doc.configs[0].id;
  return doc.configs;
}

/** A new configuration copying the current values, made active; returns its id. */
export function addConfig(doc: AsmDoc, name: string, id: string): string {
  const cfs = ensure(doc);
  cfs.find(c => c.id === doc.activeConfig)!.state = captureConfig(doc);
  cfs.push({ id, name, state: captureConfig(doc) });
  doc.activeConfig = id;
  return id;
}

/** Stores the current values in the active configuration and applies the chosen one. */
export function activateConfig(doc: AsmDoc, id: string): boolean {
  const cfs = ensure(doc);
  const to = cfs.find(c => c.id === id);
  if (!to) return false;
  if (id === doc.activeConfig) return true;
  cfs.find(c => c.id === doc.activeConfig)!.state = captureConfig(doc);
  applyConfig(doc, to.state);
  doc.activeConfig = id;
  return true;
}

/** Deletes a configuration (not the last one); deleting the active one activates the first other. */
export function deleteConfig(doc: AsmDoc, id: string): boolean {
  const cfs = ensure(doc);
  if (cfs.length < 2 || !cfs.some(c => c.id === id)) return false;
  if (doc.activeConfig === id) activateConfig(doc, cfs.find(c => c.id !== id)!.id);
  doc.configs = cfs.filter(c => c.id !== id);
  return true;
}

/** Whether a part entry is used by a component now or in any configuration. */
export function partUsed(doc: AsmDoc, key: string): boolean {
  return doc.components.some(c => c.part === key) || !!doc.configs?.some(cf => Object.values(cf.state.parts).includes(key));
}
