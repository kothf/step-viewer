import type { Annot } from "./types";

/**
 * Format painter (gap list D1): the display properties one annotation can hand to another of the same kind, as
 * other CAD apps' Format Painter does. Text, references and position stay; only how it is drawn moves across.
 */
export const PAINT_KEYS: Partial<Record<Annot["t"], readonly string[]>> = {
  dim: ["prec", "tol", "arrows", "show", "dual", "horiz", "ends", "insp", "noExt", "along", "outside"],
  note: ["h", "border", "al", "end", "bent"],
  balloon: ["shape"],
  datum: ["open", "bent"],
  hole: ["count"],
  htable: ["prec"],
  btable: ["prec"],
  wtable: ["prec"],
  ctable: ["prec", "beads", "mass", "mat", "part"],
  cloud: ["arc"],
  cline: ["ext"],
  sk: ["pen"],
};

/** Whether `a`'s format can be painted on others. */
export const canPaint = (a: Annot) => !!PAINT_KEYS[a.t];

/**
 * Copies `src`'s display properties onto `dst` (same kind only): a key `src` has is copied (deep), a key it lacks is
 * removed, so the target looks the same.
 * Returns false when the kinds differ or nothing would change.
 */
export function paintFormat(src: Annot, dst: Annot): boolean {
  const keys = PAINT_KEYS[src.t];
  if (!keys || src.t !== dst.t || src.id === dst.id) return false;
  const s = src as unknown as Record<string, unknown>, d = dst as unknown as Record<string, unknown>;
  const before = JSON.stringify(keys.map(k => d[k]));
  for (const k of keys) {
    if (s[k] === undefined) delete d[k];
    else d[k] = JSON.parse(JSON.stringify(s[k]));
  }
  return JSON.stringify(keys.map(k => d[k])) !== before;
}
