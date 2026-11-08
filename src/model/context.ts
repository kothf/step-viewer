// In-context design (FR-ASM-030): external references to faces of other components.
import type { CtxRef, Feature, Frame, PartDoc, V3 } from "./types";

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The sketch frame on an external face: the normal is the face's, the origin the part origin dropped
 * onto the plane and x the part axis least along the normal, made square to it. It depends only on the
 * plane, so the sketch stays put while the face slides in its own plane.
 */
export function ctxFrame(r: { p: V3; n: V3 }): Frame {
  const n = unit(r.n);
  const o: V3 = [n[0] * dot(r.p, n), n[1] * dot(r.p, n), n[2] * dot(r.p, n)];
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a = axes.reduce((b, c) => (Math.abs(dot(c, n)) < Math.abs(dot(b, n)) - 1e-9 ? c : b));
  const d = dot(a, n);
  const x = unit([a[0] - n[0] * d, a[1] - n[1] * d, a[2] - n[2] * d]);
  return { o, x, y: cross(n, x), n };
}

/** Every external reference of a part, with the feature holding it. */
export function ctxRefs(doc: PartDoc): { f: Feature; ref: CtxRef }[] {
  const out: { f: Feature; ref: CtxRef }[] = [];
  for (const f of doc.features) {
    const pl = (f as { plane?: unknown }).plane;
    if (pl && typeof pl === "object" && "ctx" in pl) out.push({ f, ref: (pl as { ctx: CtxRef }).ctx });
  }
  return out;
}

/** Same plane within the tolerances (mm, radians), whichever way the stored point slid in it. */
export function samePlane(a: { p: V3; n: V3 }, b: { p: V3; n: V3 }, tol = 1e-6): boolean {
  const na = unit(a.n), nb = unit(b.n);
  return dot(na, nb) > 1 - tol && Math.abs(dot(na, a.p) - dot(nb, b.p)) < tol * 1000;
}

/**
 * Updates a part's unlocked external references from the assembly: `plane(ref)` gives the referenced
 * face's plane in the part's coordinates now, or null when it is gone. Returns how many changed and
 * which are missing; the document is changed in place.
 */
export function syncCtx(doc: PartDoc, plane: (r: CtxRef) => { p: V3; n: V3 } | null): { changed: number; missing: CtxRef[] } {
  let changed = 0;
  const missing: CtxRef[] = [];
  if (doc.ctxLocked) return { changed, missing };
  for (const { ref } of ctxRefs(doc)) {
    if (ref.locked) continue;
    const g = plane(ref);
    if (!g) { missing.push(ref); continue; }
    if (samePlane(ref, g)) continue;
    ref.p = g.p.slice() as V3;
    ref.n = unit(g.n);
    changed++;
  }
  return { changed, missing };
}

/** A face of a context component: its triangles and, when flat, its plane (world mm). */
export interface CtxFace { triStart: number; triCount: number; name: string; plane?: { p: V3; n: V3 } }
/** A component shown around a part edited in context, in world coordinates. */
export interface CtxComp { comp: string; label: string; positions: Float32Array; index: Uint32Array; faces: CtxFace[] }
/**
 * Edit in context (FR-ASM-030): the component the part is edited as (`host`, placed by `tf`, a 3×4
 * row-major rigid transform) and the other shown components around it.
 */
export interface PartContext { host: string; tf: number[]; comps: CtxComp[] }
