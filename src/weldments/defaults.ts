// Weldment defaults (FR-FT-121): a new Structural Member, End Cap, Gusset or Fillet Bead starts with the
// profile, sizes and options used last, as a CAD app's weldment PropertyManagers do. Kept per browser in
// localStorage `mc:weldLast:<type>`; pure apart from the two storage helpers at the end.
import type { Feature, Num } from "../model/types";
import { PROFILE_TYPES, profileSizes, type ProfileType } from "./profiles";

type Kind = "num" | "bool" | "str";
/** What each weldment feature type carries over to the next one: never picked geometry, names or paths. */
export const WELD_REMEMBER: Record<string, [string, Kind, (readonly string[])?][]> = {
  member: [["profile", "str"], ["size", "str"], ["corner", "str", ["miter", "butt1", "butt2", "none"]], ["gap", "num"], ["coped", "bool"], ["mergeMiter", "bool"], ["mergeArcs", "bool"]],
  endcap: [["thickness", "num"], ["inset", "num"], ["ratio", "num"], ["dir", "str", ["in", "internal"]], ["chamfer", "num"], ["fillet", "bool"]],
  gusset: [["d1", "num"], ["d2", "num"], ["thickness", "num"], ["shape", "str", ["tri", "poly"]], ["d3", "num"], ["d4", "num"], ["polyAngle", "num"], ["chamfer", "num"], ["chamfer2", "num"], ["loc", "str", ["start", "mid", "end"]], ["side", "str", ["both", "out"]], ["offset", "num"]],
  weldbead: [["size", "num"], ["size2", "num"], ["tangent", "bool"], ["symbol", "bool"]],
};

const okNum = (v: unknown): v is Num => !!v && typeof v === "object" && Number.isFinite((v as Num).v) && (v as Num).v >= 0;

/** The values of `f` to carry over (numbers without their expressions: another part has other variables). */
export function weldMemory(f: Feature): Record<string, unknown> | null {
  const spec = WELD_REMEMBER[f.type];
  if (!spec) return null;
  const g = f as unknown as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const [k, kind] of spec) {
    const v = g[k];
    if (kind === "num" && okNum(v)) out[k] = { v: v.v };
    else if (kind === "bool" && typeof v === "boolean") out[k] = v;
    else if (kind === "str" && typeof v === "string") out[k] = v;
  }
  // A custom (sketch) profile belongs to its part: keep the library profile the draft starts with.
  if (f.type === "member" && out.profile === "sketch") { delete out.profile; delete out.size; }
  return out;
}

/**
 * Puts remembered values onto a fresh draft of the same type: checked one by one (unknown profile or size,
 * bad numbers and values a key does not take are skipped), so an old or edited store never breaks a draft.
 * Keys absent from the memory are cleared from the draft when they are optional (the last feature had them off).
 */
export function applyWeldMemory(f: Feature, saved: unknown): Feature {
  const spec = WELD_REMEMBER[f.type];
  if (!spec || !saved || typeof saved !== "object") return f;
  const s = saved as Record<string, unknown>, g = f as unknown as Record<string, unknown>;
  const required = new Set(["profile", "size", "corner", "thickness", "inset", "d1", "d2", "shape", "loc"]);
  for (const [k, kind, allowed] of spec) {
    const v = s[k];
    if (v === undefined) { if (!required.has(k)) delete g[k]; continue; }
    if (kind === "num" && okNum(v)) g[k] = { v: v.v };
    else if (kind === "bool" && typeof v === "boolean") g[k] = v;
    else if (kind === "str" && typeof v === "string" && (!allowed || allowed.includes(v))) {
      if (k === "profile" && !PROFILE_TYPES.some(p => p[0] === v)) continue;
      g[k] = v;
    }
  }
  if (f.type === "member") {
    const sizes = f.profile === "sketch" ? [] : profileSizes(f.profile as ProfileType);
    if (sizes.length && !sizes.includes(f.size)) f.size = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length / 3))];
  }
  if (f.type === "gusset") {
    // A polygonal profile needs its corner cut; a triangle has none.
    if (f.shape === "poly") f.d3 ??= { v: Math.round(Math.min(f.d1.v, f.d2.v) / 4) || 5 };
    else { delete f.d3; delete f.d4; delete f.polyAngle; }
    if (f.d4 && f.polyAngle) delete f.polyAngle;
    if (!f.chamfer) delete f.chamfer2;
    if (f.loc === "mid") delete f.side;
  }
  if (f.type === "endcap") {
    if (!f.inset.v) delete f.ratio;
    if (!f.chamfer) delete f.fillet;
    if (f.dir === "internal") delete f.ratio;
  }
  if (f.type === "weldbead" && f.size2 && f.size2.v <= 0) delete f.size2;
  return f;
}

const KEY = (type: string) => `mc:weldLast:${type}`;

/** Remembers a confirmed new weldment feature's settings for the next one of its type. */
export function rememberWeld(f: Feature) {
  const m = weldMemory(f);
  if (!m) return;
  try { localStorage.setItem(KEY(f.type), JSON.stringify(m)); } catch { /* storage blocked: not remembered */ }
}

/** A fresh draft with the settings used last for its type (unchanged when none are stored). */
export function recallWeld(f: Feature): Feature {
  if (!WELD_REMEMBER[f.type]) return f;
  let saved: unknown = null;
  try { saved = JSON.parse(localStorage.getItem(KEY(f.type)) ?? "null"); } catch { return f; }
  return applyWeldMemory(f, saved);
}
