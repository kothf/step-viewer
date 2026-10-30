export type Unit = "mm" | "cm" | "m" | "in";

const UNITS: Record<Unit, { f: number; d: number }> = {
  mm: { f: 1, d: 3 },
  cm: { f: 0.1, d: 4 },
  m: { f: 0.001, d: 5 },
  in: { f: 1 / 25.4, d: 4 },
};

export const units = { current: "mm" as Unit };

/** All internal values are millimetres; these format for display only. */
export const fmtLen = (mm: number, withUnit = true) =>
  (mm * UNITS[units.current].f).toFixed(UNITS[units.current].d) + (withUnit ? ` ${units.current}` : "");
export const fmtArea = (mm2: number) => fmtNum(mm2 * UNITS[units.current].f ** 2) + ` ${units.current}²`;
export const fmtVol = (mm3: number) => fmtNum(mm3 * UNITS[units.current].f ** 3) + ` ${units.current}³`;
export const fmtAngle = (rad: number) => `${((rad * 180) / Math.PI).toFixed(3)}°`;
export const fmtMass = (g: number) => (g >= 1000 ? `${(g / 1000).toFixed(4)} kg` : `${g.toFixed(3)} g`);
export const fmtVec = (v: { x: number; y: number; z: number }, len = true) =>
  len ? `X ${fmtLen(v.x, false)}  Y ${fmtLen(v.y, false)}  Z ${fmtLen(v.z, false)}` : `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

export function fmtNum(x: number) {
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return x.toExponential(4);
  return x.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 1 : 4 });
}
