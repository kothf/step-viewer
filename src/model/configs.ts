// Configurations (FR-CFG-001/002): named variants of a part. The document always holds the active
// configuration's values in place; each configuration keeps a snapshot of the values it may change
// (variable expressions, numeric values and expressions, counts, suppression, material). Switching
// stores the current values into the active configuration and applies the target's.
import { solve } from "../sketch/solver";
import { findMaterial, toRef } from "../tools/materials";
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

// ---------- configuration table (FR-CFG-003) ----------
// One row per configuration, one column per value it controls, as in a design table:
//   Configuration | $STATE@Extrude1 | depth@Extrude1 | D1@Sketch1 | count@LPattern1 | $VAR@W | $MATERIAL
// Lengths are mm, angles degrees; a cell may hold an expression ("W/2"). Suppression is S or U.

/** CSV cell quoting (RFC 4180). */
const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Splits CSV text (comma or semicolon separated, quoted cells allowed) into rows of trimmed cells. */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur.trim()); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur.trim()); cur = "";
      if (row.some(x => x)) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur.trim());
  if (row.some(x => x)) rows.push(row);
  return rows;
}

interface Column { head: string; get(s: ConfigState): string; set(s: ConfigState, v: string): void }

const fmt = (n: number) => String(Math.round(n * 1e9) / 1e9);

/** The columns of the document's table: suppression, values, counts, variables, material. */
function columns(d: PartDoc): Column[] {
  const cols: Column[] = [];
  const num = (head: string, key: string, angle: boolean) => cols.push({
    head,
    get: s => { const n = s.nums[key]; return !n ? "" : n.expr ?? fmt(angle ? (n.v * 180) / Math.PI : n.v); },
    set: (s, v) => {
      const plain = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v);
      // The value of an expression is worked out by the next rebuild (refreshExprs); keep the old one until then.
      s.nums[key] = plain ? { v: angle ? (Number(v) * Math.PI) / 180 : Number(v) } : { v: s.nums[key]?.v ?? 0, expr: v };
    },
  });
  for (const f of d.features) {
    cols.push({
      head: `$STATE@${f.name}`,
      get: s => (s.suppressed.includes(f.id) ? "S" : "U"),
      set: (s, v) => {
        const sup = /^(s|suppressed|1|true|yes)$/i.test(v);
        s.suppressed = s.suppressed.filter(x => x !== f.id);
        if (sup) s.suppressed.push(f.id);
        if (!s.ids.includes(f.id)) s.ids.push(f.id);
      },
    });
    if (f.type === "sketch") { for (const dm of f.dims) if (!dm.driven) num(`${dm.name}@${f.name}`, `${f.id}/dim/${dm.id}`, dm.t === "angle"); continue; }
    for (const [k, v] of Object.entries(f)) {
      if (isNum(v)) num(`${k}@${f.name}`, `${f.id}/${k}`, /angle/i.test(k));
      else if (typeof v === "number" && (k === "count" || k === "count2")) {
        const key = `${f.id}/${k}`;
        cols.push({ head: `${k}@${f.name}`, get: s => (s.ints[key] != null ? String(s.ints[key]) : ""), set: (s, v) => { const n = Math.round(Number(v)); if (n >= 1) s.ints[key] = n; } });
      }
    }
  }
  for (const v of d.vars ?? []) cols.push({ head: `$VAR@${v.name}`, get: s => s.vars[v.name] ?? "", set: (s, x) => { s.vars[v.name] = x; } });
  cols.push({
    head: "$MATERIAL",
    get: s => s.material?.name ?? "",
    set: (s, v) => { const m = v ? findMaterial(v) : undefined; s.material = m ? toRef(m) : v && s.material?.name === v ? s.material : null; },
  });
  return cols;
}

/** Every configuration's values as a CSV table (the active one read from the document). */
export function configTable(d: PartDoc): string {
  const cols = columns(d);
  const list = d.configs?.length ? d.configs : [{ name: d.config ?? "Default", state: captureState(d) }];
  const rows = [["Configuration", ...cols.map(c => c.head)]];
  for (const c of list) {
    const s = c.name === (d.config ?? "Default") ? captureState(d) : c.state;
    rows.push([c.name, ...cols.map(col => col.get(s))]);
  }
  return rows.map(r => r.map(cell).join(",")).join("\n") + "\n";
}

export interface TableResult { added: string[]; changed: string[]; unknown: string[] }

/**
 * Reads a configuration table: each row updates the configuration of that name, or adds one
 * (starting from the active values). Empty cells keep the value; unknown columns are reported.
 * The active configuration's row is applied to the document at once.
 */
export function applyConfigTable(d: PartDoc, text: string): TableResult {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The table needs a header row and at least one configuration.");
  const cols = new Map(columns(d).map(c => [c.head.toLowerCase(), c]));
  const head = rows[0];
  const unknown = head.slice(1).filter(h => h && !cols.has(h.toLowerCase()));
  const res: TableResult = { added: [], changed: [], unknown };
  if (!d.configs?.length) { d.configs = [{ name: d.config ?? "Default", state: captureState(d) }]; d.config = d.configs[0].name; }
  const active = d.configs.find(c => c.name === d.config)!;
  active.state = captureState(d);
  for (const r of rows.slice(1)) {
    const name = r[0]?.trim();
    if (!name) continue;
    let c = d.configs.find(x => x.name === name);
    if (!c) { c = { name, state: structuredClone(active.state) }; d.configs.push(c); res.added.push(name); }
    else res.changed.push(name);
    for (let i = 1; i < head.length; i++) {
      const v = r[i]?.trim();
      const col = cols.get(head[i]?.toLowerCase() ?? "");
      if (col && v) col.set(c.state, v);
    }
  }
  applyState(d, active.state);
  return res;
}
