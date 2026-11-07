// Configurations (FR-CFG-001/002): named variants of a part. The document always holds the active
// configuration's values in place; each configuration keeps a snapshot of the values it may change
// (variable expressions, numeric values and expressions, counts, suppression, material). Switching
// stores the current values into the active configuration and applies the target's.
import { solve } from "../sketch/solver";
import type { Num, PartDoc, PartConfig, SketchFeature } from "./types";

export type ConfigState = PartConfig["state"];

const isNum = (v: unknown): v is Num => !!v && typeof v === "object" && typeof (v as Num).v === "number" && Object.keys(v as object).every(k => k === "v" || k === "expr");

/** The values a configuration controls, read from the document. */
export function captureState(d: PartDoc): ConfigState {
  const nums: Record<string, Num> = {}, ints: Record<string, number> = {}, suppressed: string[] = [];
  for (const f of d.features) {
    if (f.suppressed) suppressed.push(f.id);
    if (f.type === "sketch") { for (const dm of f.dims) nums[`${f.id}/dim/${dm.id}`] = { ...dm.val }; continue; }
    for (const [k, v] of Object.entries(f)) {
      if (isNum(v)) nums[`${f.id}/${k}`] = { ...v };
      else if (typeof v === "number" && (k === "count" || k === "count2")) ints[`${f.id}/${k}`] = v;
    }
  }
  const vars: Record<string, string> = {};
  for (const v of d.vars ?? []) vars[v.name] = v.expr;
  return { nums, ints, suppressed, vars, material: d.material ? { ...d.material } : null, ids: d.features.map(f => f.id) };
}

/**
 * Applies a configuration's values to the document. Values for features or variables made after
 * the snapshot are left as they are; sketches whose dimensions changed are solved again.
 */
export function applyState(d: PartDoc, s: ConfigState) {
  const sup = new Set(s.suppressed), ids = new Set(s.ids);
  const touched = new Set<SketchFeature>();
  for (const f of d.features) {
    if (ids.has(f.id)) { if (sup.has(f.id)) f.suppressed = true; else delete f.suppressed; }
    if (f.type === "sketch") {
      for (const dm of f.dims) {
        const n = s.nums[`${f.id}/dim/${dm.id}`];
        if (n && (n.v !== dm.val.v || n.expr !== dm.val.expr)) { dm.val = { ...n }; touched.add(f); }
      }
      continue;
    }
    const rec = f as unknown as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      const n = s.nums[`${f.id}/${k}`];
      if (n && isNum(rec[k])) rec[k] = { ...n };
      const c = s.ints[`${f.id}/${k}`];
      if (c != null && typeof rec[k] === "number") rec[k] = c;
    }
  }
  for (const v of d.vars ?? []) if (s.vars[v.name] != null) v.expr = s.vars[v.name];
  if (s.material) d.material = { ...s.material }; else if (s.material === null) delete d.material;
  for (const sk of touched) solve(sk);
}

/** Makes `name` the active configuration (creating "Default" from the current values the first time). */
export function activate(d: PartDoc, name: string) {
  const cur = d.configs?.find(c => c.name === d.config);
  const target = d.configs?.find(c => c.name === name);
  if (!target || target === cur) return;
  if (cur) cur.state = captureState(d);
  applyState(d, target.state);
  d.config = name;
}

/** Adds a configuration copied from the current values and makes it active. */
export function addConfig(d: PartDoc, name: string) {
  if (!d.configs?.length) { d.configs = [{ name: "Default", state: captureState(d) }]; d.config = "Default"; }
  const cur = d.configs.find(c => c.name === d.config);
  if (cur) cur.state = captureState(d);
  d.configs.push({ name, state: captureState(d) });
  d.config = name;
}

/** Removes a configuration; removing the active one switches to the first other. */
export function removeConfig(d: PartDoc, name: string) {
  if (!d.configs || d.configs.length < 2) return;
  if (d.config === name) activate(d, d.configs.find(c => c.name !== name)!.name);
  d.configs = d.configs.filter(c => c.name !== name);
  if (d.configs.length === 1) { delete d.configs; delete d.config; }
}

export function renameConfig(d: PartDoc, from: string, to: string) {
  const c = d.configs?.find(x => x.name === from);
  if (!c || d.configs!.some(x => x.name === to)) return false;
  c.name = to;
  if (d.config === from) d.config = to;
  return true;
}

/** A name not used yet: "Config2", "Config3"... */
export function nextConfigName(d: PartDoc) {
  let n = (d.configs?.length ?? 1) + 1;
  while (d.configs?.some(c => c.name === `Config${n}`)) n++;
  return `Config${n}`;
}
