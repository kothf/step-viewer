// Mesh export quality (STL, 3MF, OBJ, glTF): how finely the exact B-rep is tessellated for the file, like a CAD
// app's STL options. Pure apart from the remembered choice in localStorage (`mc:meshQuality`).

export type MeshQualityKind = "coarse" | "fine" | "xfine" | "custom" | "view";
export interface MeshQuality { kind: MeshQualityKind; /** chord deviation, mm */ dev: number; /** angle between neighbouring facets, degrees */ ang: number }

/** Preset deviation (mm) and angle (°). Fine keeps round holes round for 3D printing: at most 5° per facet. */
export const MESH_PRESETS: Record<"coarse" | "fine" | "xfine", { dev: number; ang: number }> = {
  coarse: { dev: 0.1, ang: 20 },
  fine: { dev: 0.01, ang: 5 },
  xfine: { dev: 0.002, ang: 2 },
};
export const MESH_KINDS: { kind: MeshQualityKind; label: string }[] = [
  { kind: "coarse", label: "Coarse" },
  { kind: "fine", label: "Fine (3D printing)" },
  { kind: "xfine", label: "Extra fine" },
  { kind: "custom", label: "Custom" },
  { kind: "view", label: "As shown in the view" },
];
export const DEFAULT_MESH_QUALITY: MeshQuality = { kind: "fine", ...MESH_PRESETS.fine };
const KEY = "mc:meshQuality";

/** A stored or typed quality, checked: unknown kinds give Fine, custom values are clamped to 0.0005..10 mm and 0.5..45°. */
export function parseMeshQuality(raw: string | null): MeshQuality {
  let v: Partial<MeshQuality> = {};
  try { v = raw ? JSON.parse(raw) : {}; } catch { v = {}; }
  const kind = MESH_KINDS.some(k => k.kind === v.kind) ? v.kind! : "fine";
  if (kind === "custom") return { kind, dev: clamp(v.dev, 0.0005, 10, 0.01), ang: clamp(v.ang, 0.5, 45, 5) };
  if (kind === "view") return { kind, dev: 0, ang: 0 };
  return { kind, ...MESH_PRESETS[kind] };
}
function clamp(x: unknown, lo: number, hi: number, def: number) {
  const n = typeof x === "number" ? x : Number(x);
  return isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
}

export function meshQuality(): MeshQuality {
  try { return parseMeshQuality(localStorage.getItem(KEY)); } catch { return { ...DEFAULT_MESH_QUALITY }; }
}
export function setMeshQuality(q: MeshQuality) {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* not kept */ }
}
