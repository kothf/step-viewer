// Re-found references (1.585.0): the rebuild reports each face or edge reference that resolved under other
// names, at another place or as another shape than the document stores; the document takes them over, so
// features keep their edges and faces after earlier features were edited.
import type { EdgeRef, FaceRef } from "./types";

/** A reference as stored (its JSON) and as it resolved now; `found` = its names were gone and it was found again by place. */
export interface RefFix { from: string; to: FaceRef | EdgeRef; found: boolean }

const isRef = (v: unknown): v is FaceRef | EdgeRef => {
  if (!v || typeof v !== "object") return false;
  const o = v as { name?: unknown; faces?: unknown };
  return typeof o.name === "string" || (Array.isArray(o.faces) && o.faces.length === 2 && typeof o.faces[0] === "string");
};

/** How many references of the value were replaced in place. */
function walk(v: unknown, map: Map<string, FaceRef | EdgeRef>): number {
  if (!v || typeof v !== "object") return 0;
  let n = 0;
  const box = v as Record<string, unknown>;
  for (const k of Object.keys(box)) {
    const c = box[k];
    if (!c || typeof c !== "object") continue;
    if (isRef(c)) {
      const to = map.get(JSON.stringify(c));
      if (to) { box[k] = structuredClone(to); n++; continue; }
    }
    n += walk(c, map);
  }
  return n;
}

/** Replaces the fixed references inside a feature (or any value) in place; returns how many. */
export function fixRefsIn(target: unknown, fixes: RefFix[]): number {
  if (!fixes.length) return 0;
  return walk(target, new Map(fixes.map(f => [f.from, f.to])));
}

/** A copy of the feature with the fixed references. */
export function applyRefFixes<T>(feature: T, fixes: RefFix[]): T {
  const out = structuredClone(feature);
  fixRefsIn(out, fixes);
  return out;
}
