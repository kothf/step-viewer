// Structural analysis: typed load values (FR-LOAD-021). A value may be a number, an expression,
// carry a unit ("2 kN", "30 psi") and use the part's global variables ("2 * F"). The text is kept
// on the value (`Num.expr`) and worked out again whenever the variables change.

import { evaluate, ExprError, type VarValue } from "../model/expr";
import type { Num, PartDoc } from "../model/types";
import type { LoadType, StudyLoad } from "./types";

/** Units a field takes, as factors to the unit the field shows (N, MPa, N·m, m/s², rpm, kg/m³). */
const UNITS: Record<LoadType, Record<string, number>> = {
  force: { N: 1, kN: 1000, lbf: 4.4482216152605, kgf: 9.80665, Н: 1, кН: 1000, кгс: 9.80665 },
  pressure: { MPa: 1, kPa: 1e-3, Pa: 1e-6, GPa: 1000, bar: 0.1, psi: 0.006894757293168, МПа: 1, кПа: 1e-3, Па: 1e-6, ГПа: 1000, бар: 0.1 },
  moment: { "N·m": 1, "N*m": 1, Nm: 1, "N·mm": 1e-3, "N*mm": 1e-3, Nmm: 1e-3, "kN·m": 1000, "kN*m": 1000, kNm: 1000, "Н·м": 1, "Н*м": 1, Нм: 1, "Н·мм": 1e-3, "кН·м": 1000 },
  gravity: { "m/s²": 1, "m/s2": 1, "mm/s²": 1e-3, "mm/s2": 1e-3, g: 9.80665, "м/с²": 1, "м/с2": 1 },
  torque: { "N·m": 1, "N*m": 1, Nm: 1, "N·mm": 1e-3, "N*mm": 1e-3, Nmm: 1e-3, "kN·m": 1000, "kN*m": 1000, kNm: 1000, "Н·м": 1, "Н*м": 1, Нм: 1, "Н·мм": 1e-3, "кН·м": 1000 },
  bearing: { N: 1, kN: 1000, lbf: 4.4482216152605, kgf: 9.80665, Н: 1, кН: 1000, кгс: 9.80665 },
  hydro: { "kg/m³": 1, "kg/m3": 1, "g/cm³": 1000, "g/cm3": 1000, "кг/м³": 1, "кг/м3": 1, "г/см³": 1000, "г/см3": 1000 },
  remote: { N: 1, kN: 1000, lbf: 4.4482216152605, kgf: 9.80665, Н: 1, кН: 1000, кгс: 9.80665 },
  heat: { W: 1, mW: 1e-3, kW: 1000, Вт: 1, мВт: 1e-3, кВт: 1000 },
  pkgheat: { W: 1, mW: 1e-3, kW: 1000, Вт: 1, мВт: 1e-3, кВт: 1000 },
  vheat: { "W/m³": 1, "W/m3": 1, "kW/m³": 1000, "kW/m3": 1000, "W/cm³": 1e6, "W/cm3": 1e6, "W/mm³": 1e9, "W/mm3": 1e9, "Вт/м³": 1, "Вт/м3": 1, "кВт/м³": 1000, "Вт/см³": 1e6, "Вт/см3": 1e6 },
  hflux: { "W/m²": 1, "W/m2": 1, "W/cm²": 1e4, "W/cm2": 1e4, "W/mm²": 1e6, "W/mm2": 1e6, "kW/m²": 1000, "kW/m2": 1000, "Вт/м²": 1, "Вт/м2": 1, "Вт/см²": 1e4, "Вт/см2": 1e4 },
  centrifugal: { rpm: 1, "rad/s": 30 / Math.PI, Hz: 60, "об/мин": 1, "рад/с": 30 / Math.PI, Гц: 60 },
  temperature: { "°C": 1, C: 1 },
};

/** From the unit a field shows to what the study stores (N, MPa, N·mm, mm/s²). */
export const storeFactor = (type: LoadType) => (type === "moment" || type === "gravity" || type === "torque" ? 1000 : 1);

/** Does the text need keeping (anything but a plain number)? */
export const isPlain = (text: string) => /^[+-]?(\d+[.,]?\d*|[.,]\d+)(e[+-]?\d+)?$/i.test(text.trim());

const escRe = (u: string) => u.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A typed value in the field's own unit. A unit belongs to the number right before it ("2 * F + 0.2 kN"),
 * or, after a closing bracket at the end, to the whole text ("(1 + 0.5) kN"); a variable named like a
 * unit ("2 * g") stays a variable. Throws an `ExprError`.
 */
export function loadValue(text: string, type: LoadType, vars: Record<string, VarValue> = {}): number {
  let src = text.trim(), f = 1;
  const table = UNITS[type], alt = Object.keys(table).sort((a, b) => b.length - a.length).map(escRe).join("|");
  const tail = new RegExp(`\\)\\s*(${alt})$`).exec(src);
  if (tail) { f = table[tail[1]]; src = src.slice(0, src.length - tail[0].length + 1); }
  src = src.replace(new RegExp(`(\\d+[.,]?\\d*(?:e[+-]?\\d+)?|[.,]\\d+)\\s*(${alt})(?![\\wа-яА-Я·²])`, "g"), (_m, n: string, u: string) => `(${n.replace(",", ".")}*${table[u]})`);
  // variables are plain numbers here: a length variable gives its millimetres
  const plain: Record<string, VarValue> = {};
  for (const [k, v] of Object.entries(vars)) plain[k] = { v: typeof v === "number" ? v : v.v, unit: false };
  const v = evaluate(src, "number", "mm", plain) * f;
  if (!isFinite(v)) throw new ExprError("Enter a value");
  return v;
}

/** What a value's field shows: the typed text, else the number in the field's unit. */
export function shownValue(n: Num | undefined, type: LoadType): string {
  if (n?.expr) return n.expr;
  return String(Number(((n?.v ?? 0) / storeFactor(type)).toPrecision(10)));
}

/** A typed text as the stored value; plain numbers keep no text. */
export function typedValue(text: string, type: LoadType, vars: Record<string, VarValue> = {}): Num {
  const v = loadValue(text, type, vars) * storeFactor(type);
  return isPlain(text) ? { v } : { v, expr: text.trim() };
}

/** Every expression-driven load value of the document's studies. */
export function studyTargets(doc: PartDoc): { load: StudyLoad; study: string; num: Num; type: LoadType }[] {
  const out: { load: StudyLoad; study: string; num: Num; type: LoadType }[] = [];
  for (const st of doc.studies ?? []) for (const l of st.loads) {
    for (const n of [l.value, ...(l.comp ?? [])]) if (n?.expr) out.push({ load: l, study: st.name, num: n, type: l.type });
    // a remote load's moment is typed like a moment
    for (const n of l.mom ?? []) if (n?.expr) out.push({ load: l, study: st.name, num: n, type: "moment" });
  }
  return out;
}

/** Works the kept expressions out again; returns the ones that failed (their old value stays). */
export function refreshStudyValues(doc: PartDoc, vars: Record<string, VarValue>): { key: string; owner: string; error: { key: string; params?: Record<string, string> } }[] {
  const failed: { key: string; owner: string; error: { key: string; params?: Record<string, string> } }[] = [];
  for (const t of studyTargets(doc)) {
    try { t.num.v = loadValue(t.num.expr!, t.type, vars) * storeFactor(t.type); }
    catch (e) { failed.push({ key: t.load.name ?? t.load.id, owner: t.study, error: { key: (e as ExprError).key ?? String(e), params: (e as ExprError).params } }); }
  }
  return failed;
}
