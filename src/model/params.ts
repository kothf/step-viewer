// Global variables and equations (FR-PAR-001..005): values other inputs use by name, evaluated
// in dependency order, plus sketch dimensions by "D1@Sketch1". Expressions are kept on each value
// (`Num.expr`) and re-evaluated whenever a variable or a referenced dimension changes.
import { evaluate, ExprError, type VarValue } from "./expr";
import { solve } from "../sketch/solver";
import type { Feature, Num, PartDoc, SketchFeature } from "./types";

/** An error as a fixed English sentence and its placeholders (translated when shown). */
export interface ErrMsg { key: string; params?: Record<string, string> }
export interface VarResult { values: Record<string, VarValue>; errors: Record<string, ErrMsg> }
const CIRC: ErrMsg = { key: "Circular reference" };

const NAME = /^[a-z_а-я][\w.а-я]*$/i;
export const validVarName = (s: string) => NAME.test(s) && !/^(pi|sin|cos|tan|asin|acos|atan|atan2|sqrt|abs|min|max|round|floor|ceil)$/i.test(s);

/** Names an expression uses (variables and Dn@Sketch dimensions). */
export function namesIn(src: string): string[] {
  return [...src.matchAll(/[a-z_а-я][\w@.а-я]*/gi)].map(m => m[0]).filter(n => !/^(pi|sin|cos|tan|asin|acos|atan|atan2|sqrt|abs|min|max|round|floor|ceil|mm|cm|um|m|in|ft|deg|rad|мм|см|м|град|e)$/i.test(n));
}

/** An expression with the name `from` (a whole name, such as "D1@Sketch1") replaced by `to`. */
export function renameIn(src: string, from: string, to: string): string {
  return src.replace(/[a-z_а-я][\w@.а-я]*/gi, m => (m === from ? to : m));
}

/** Renames a name in every expression of the document: variables, dimensions and feature values. */
export function renameEverywhere(doc: PartDoc, from: string, to: string) {
  for (const v of doc.vars ?? []) v.expr = renameIn(v.expr, from, to);
  for (const tg of exprTargets(doc)) tg.num.expr = renameIn(tg.num.expr!, from, to);
}

/**
 * Global variables in dependency order. A variable that refers to itself through others
 * (a circular reference) or to an unknown name gets an error instead of a value.
 */
export function evalVars(doc: PartDoc, unit = "mm"): VarResult {
  const vars = doc.vars ?? [];
  const values: Record<string, VarValue> = { ...dimValues(doc) };
  const errors: Record<string, ErrMsg> = {};
  const byName = new Map(vars.map(v => [v.name, v]));
  const state = new Map<string, "busy" | "done">();
  const visit = (name: string): boolean => {
    const v = byName.get(name)!;
    if (state.get(name) === "done") return !(name in errors);
    if (state.get(name) === "busy") { errors[name] = CIRC; return false; }
    state.set(name, "busy");
    for (const dep of namesIn(v.expr)) {
      if (byName.has(dep) && !visit(dep)) { errors[name] ??= errors[dep] === CIRC ? CIRC : { key: "Uses {name}, which has an error", params: { name: dep } }; }
    }
    if (!(name in errors)) {
      try {
        const x = evaluate(v.expr, v.kind === "number" ? "number" : v.kind, v.kind === "angle" ? "deg" : unit, values);
        values[name] = v.kind === "number" ? { v: x, unit: false } : x;
      } catch (e) { errors[name] = { key: (e as ExprError).key ?? String(e), params: (e as ExprError).params }; }
    }
    state.set(name, "done");
    return !(name in errors);
  };
  for (const v of vars) visit(v.name);
  return { values, errors };
}

/** Driving sketch dimensions by name: "D1@Sketch1". */
export function dimValues(doc: PartDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of doc.features) if (f.type === "sketch") for (const d of f.dims) out[`${d.name}@${f.name}`] = d.val.v;
  return out;
}

/** Every expression-driven value in the document, with where it is and what kind it is. */
export function exprTargets(doc: PartDoc): { owner: Feature; key: string; num: Num; q: "length" | "angle"; sketch?: SketchFeature }[] {
  const out: { owner: Feature; key: string; num: Num; q: "length" | "angle"; sketch?: SketchFeature }[] = [];
  for (const f of doc.features) {
    if (f.type === "sketch") { for (const d of f.dims) if (d.val.expr) out.push({ owner: f, key: `${d.name}@${f.name}`, num: d.val, q: d.t === "angle" ? "angle" : "length", sketch: f }); continue; }
    for (const [k, v] of Object.entries(f)) {
      if (v && typeof v === "object" && "v" in v && typeof (v as Num).v === "number" && typeof (v as Num).expr === "string") out.push({ owner: f, key: k, num: v as Num, q: /angle/i.test(k) ? "angle" : "length" });
    }
  }
  return out;
}

/**
 * Re-evaluates every kept expression with the current variables and dimensions, and re-solves the
 * sketches whose dimensions changed. Mutates the document; returns the expressions that failed.
 */
export function refreshExprs(doc: PartDoc, unit = "mm"): { key: string; owner: string; error: ErrMsg }[] {
  const failed: { key: string; owner: string; error: ErrMsg }[] = [];
  // A dimension can use another one: a few passes settle chains of them.
  for (let pass = 0; pass < 4; pass++) {
    const { values } = evalVars(doc, unit);
    let changed = false;
    failed.length = 0;
    const touched = new Set<SketchFeature>();
    for (const t of exprTargets(doc)) {
      if (namesIn(t.num.expr!).includes(t.key)) { failed.push({ key: t.key, owner: t.owner.name, error: CIRC }); continue; }
      try {
        const v = evaluate(t.num.expr!, t.q, t.q === "angle" ? "deg" : unit, values);
        if (Math.abs(v - t.num.v) > 1e-12) { t.num.v = v; changed = true; if (t.sketch) touched.add(t.sketch); }
      } catch (e) { failed.push({ key: t.key, owner: t.owner.name, error: { key: (e as ExprError).key ?? String(e), params: (e as ExprError).params } }); }
    }
    for (const sk of touched) solve(sk);
    if (!changed) break;
  }
  return failed;
}
