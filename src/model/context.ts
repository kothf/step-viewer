// In-context design (FR-ASM-030): external references to faces of other components.
import type { CtxEdge, CtxEdgeGeo, CtxRef, EdgeRef, Feature, Frame, PartDoc, SketchFeature, V3 } from "./types";

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

/** Every converted edge of another component (sketch On edge relations with `ext.ctx`), with its sketch. */
export function ctxEdgeRefs(doc: PartDoc): { f: SketchFeature; ext: EdgeRef & { ctx: CtxEdge } }[] {
  const out: { f: SketchFeature; ext: EdgeRef & { ctx: CtxEdge } }[] = [];
  for (const f of doc.features) {
    if (f.type !== "sketch") continue;
    for (const r of f.rels) if (r.ext?.ctx) out.push({ f, ext: r.ext as EdgeRef & { ctx: CtxEdge } });
  }
  return out;
}

/** One row of the External References list: a sketch plane on a face, or a converted edge. */
export interface AnyCtxRef { f: Feature; kind: "plane" | "edge"; comp: string; label?: string; host: string; key: string; locked?: boolean; set(locked: boolean): void }

/** Planes and edges together, in feature order (planes of a feature before its edges). */
export function allCtxRefs(doc: PartDoc): AnyCtxRef[] {
  const out: AnyCtxRef[] = [];
  for (const { f, ref } of ctxRefs(doc)) out.push({ f, kind: "plane", comp: ref.comp, label: ref.label, host: ref.host, key: ref.face, locked: ref.locked, set: on => { if (on) ref.locked = true; else delete ref.locked; } });
  for (const { f, ext } of ctxEdgeRefs(doc)) out.push({ f, kind: "edge", comp: ext.ctx.comp, label: ext.ctx.label, host: ext.ctx.host, key: [...ext.faces].sort().join("|"), locked: ext.ctx.locked, set: on => { if (on) ext.ctx.locked = true; else delete ext.ctx.locked; } });
  const at = new Map(doc.features.map((f, i) => [f.id, i]));
  return out.map((r, i) => ({ r, i })).sort((a, b) => (at.get(a.r.f.id)! - at.get(b.r.f.id)!) || a.i - b.i).map(x => x.r);
}

/** Whether a feature holds an external reference (tree mark), and whether all of them are locked. */
export function ctxMark(doc: PartDoc, f: Feature): "none" | "open" | "locked" {
  const pl = (f as { plane?: unknown }).plane;
  const locks: boolean[] = [];
  if (pl && typeof pl === "object" && "ctx" in pl) locks.push(!!(pl as { ctx: CtxRef }).ctx.locked);
  if (f.type === "sketch") for (const r of f.rels) if (r.ext?.ctx) locks.push(!!r.ext.ctx.locked);
  if (!locks.length) return "none";
  return doc.ctxLocked || locks.every(x => x) ? "locked" : "open";
}

/** An edge of a component, in its own part coordinates, between two named faces. */
export interface CtxEdgeSeen { faces: [string, string]; geo: CtxEdgeGeo }

/**
 * The edge an `EdgeRef` names among the edges of its component: same pair of faces, the one whose middle
 * is nearest the hint (or the only one); null when none has those faces.
 */
export function findCtxEdge(list: CtxEdgeSeen[], ref: EdgeRef): CtxEdgeSeen | null {
  const key = [...ref.faces].sort().join("|");
  const cands = list.filter(e => [...e.faces].sort().join("|") === key);
  if (cands.length <= 1 || !ref.hint) return cands[0] ?? null;
  const h = ref.hint, d = (e: CtxEdgeSeen) => Math.hypot(e.geo.mid[0] - h[0], e.geo.mid[1] - h[1], e.geo.mid[2] - h[2]);
  return cands.reduce((a, b) => (d(b) < d(a) ? b : a));
}

/** Edge geometry moved by a point map and a direction map (both rigid). */
export function moveEdgeGeo(g: CtxEdgeGeo, pt: (p: V3) => V3, dir: (d: V3) => V3): CtxEdgeGeo {
  return {
    type: g.type, closed: g.closed, start: pt(g.start), end: pt(g.end), mid: pt(g.mid),
    ...(g.center ? { center: pt(g.center) } : {}), ...(g.axis ? { axis: unit(dir(g.axis)) } : {}), ...(g.radius != null ? { radius: g.radius } : {}),
  };
}

const sameGeo = (a: CtxEdgeGeo, b: CtxEdgeGeo, tol = 1e-6) => {
  const near = (p?: V3, q?: V3) => (!p && !q) || (!!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol * 1000);
  return a.type === b.type && a.closed === b.closed && near(a.start, b.start) && near(a.end, b.end) && near(a.mid, b.mid) && near(a.center, b.center) && Math.abs((a.radius ?? 0) - (b.radius ?? 0)) < tol * 1000;
};

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
export function syncCtx(doc: PartDoc, plane: (r: CtxRef) => { p: V3; n: V3 } | null, edge?: (r: EdgeRef & { ctx: CtxEdge }) => { geo: CtxEdgeGeo; hint: V3 } | null): { changed: number; missing: (CtxRef | CtxEdge)[] } {
  let changed = 0;
  const missing: (CtxRef | CtxEdge)[] = [];
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
  if (edge) for (const { ext } of ctxEdgeRefs(doc)) {
    if (ext.ctx.locked) continue;
    const g = edge(ext);
    if (!g) { missing.push(ext.ctx); continue; }
    if (sameGeo(ext.ctx.geo, g.geo)) continue;
    ext.ctx.geo = g.geo;
    ext.hint = g.hint.slice() as V3;
    changed++;
  }
  return { changed, missing };
}

/** A face of a context component: its triangles and, when flat, its plane (world mm). */
export interface CtxFace { triStart: number; triCount: number; name: string; plane?: { p: V3; n: V3 } }
/** A component shown around a part edited in context, in world coordinates. */
export interface CtxComp { comp: string; label: string; positions: Float32Array; index: Uint32Array; faces: CtxFace[]; edges?: CtxCompEdge[] }
/**
 * An edge of a context component (world mm): its two face names, polyline `pts` and kind, and `hint` = its
 * middle in the component's own part coordinates (what a converted edge stores to find it again).
 */
export interface CtxCompEdge extends CtxEdgeGeo { faces: [string, string]; pts: Float32Array; hint: V3 }
/**
 * Edit in context (FR-ASM-030): the component the part is edited as (`host`, placed by `tf`, a 3×4
 * row-major rigid transform) and the other shown components around it.
 */
export interface PartContext { host: string; tf: number[]; comps: CtxComp[] }
