import { dirToLocal, toLocal } from "./csys";

export type Unit = "mm" | "cm" | "m" | "in" | "ft";

const UNITS: Record<Unit, { f: number; d: number }> = {
  mm: { f: 1, d: 3 },
  cm: { f: 0.1, d: 4 },
  m: { f: 0.001, d: 5 },
  in: { f: 1 / 25.4, d: 4 },
  ft: { f: 1 / 304.8, d: 5 },
};

/** Display unit, and decimals for lengths (null: the unit's default). */
export const units = { current: "mm" as Unit, decimals: null as number | null };

/** Millimetres in one display unit. */
export const unitMm = () => 1 / UNITS[units.current].f;
const places = () => units.decimals ?? UNITS[units.current].d;

/** All internal values are millimetres; these format for display only. */
export const fmtLen = (mm: number, withUnit = true) =>
  (mm * UNITS[units.current].f).toFixed(places()) + (withUnit ? ` ${units.current}` : "");
export const fmtArea = (mm2: number) => fmtNum(mm2 * UNITS[units.current].f ** 2) + ` ${units.current}²`;
export const fmtVol = (mm3: number) => fmtNum(mm3 * UNITS[units.current].f ** 3) + ` ${units.current}³`;
export const fmtAngle = (rad: number) => `${((rad * 180) / Math.PI).toFixed(units.decimals ?? 3)}°`;
export const fmtMass = (g: number) => (g >= 1000 ? `${(g / 1000).toFixed(4)} kg` : `${g.toFixed(3)} g`);
/** A position (len) or a direction, in the active coordinate system. */
export const fmtVec = (w: { x: number; y: number; z: number }, len = true) => {
  const v = len ? toLocal(w) : dirToLocal(w);
  return len ? `X ${fmtLen(v.x, false)}  Y ${fmtLen(v.y, false)}  Z ${fmtLen(v.z, false)}` : `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
};

export function fmtNum(x: number) {
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return x.toExponential(4);
  return x.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 1 : 4 });
}
