// Structural analysis (FR-RES-023): an excitation frequency typed by the user (a motor speed, a mains hum)
// and the natural frequencies that lie close to it.

/** How close a natural frequency may come to the excitation before it is flagged: 10 % either way. */
export const EXCITE_BAND = 0.1;

/** "50", "50 Hz", "1.2 kHz", "3000 rpm" (also об/мин, Гц, кГц) → Hz; null when it is not a positive frequency. */
export function parseExcitation(text: string): number | null {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?(?:e[+-]?[0-9]+)?)\s*([^\s].*)?$/i.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace(",", ".")), u = (m[2] ?? "hz").trim().toLowerCase().replace(/\s+/g, "");
  const f = u === "hz" || u === "гц" ? 1 : u === "khz" || u === "кгц" ? 1000 : u === "rpm" || u === "об/мин" || u === "1/min" || u === "min-1" ? 1 / 60 : NaN;
  const hz = v * f;
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

/** Indices of the frequencies (Hz; rigid-body ones passed as 0 are never near) within `band` of the excitation. */
export function nearExcitation(hz: number[], excite: number, band = EXCITE_BAND): number[] {
  const out: number[] = [];
  if (!(excite > 0)) return out;
  hz.forEach((f, i) => { if (f > 0 && Math.abs(f - excite) <= band * excite * (1 + 1e-12)) out.push(i); });
  return out;
}
