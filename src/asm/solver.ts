// Mate solver (FR-MATE-008): rigid-body positions of the floating components that satisfy the
// mates, by damped minimum-norm Gauss-Newton from where the components are now (so they move as
// little as possible). Each floating component has six unknowns, a translation and a small rotation
// about its centre, re-linearised after every step. Degrees of freedom come from the null space of
// the Jacobian at the solution; mates still off after the solve are reported and nothing moves.
import { compose, invert, rotation, translation, applyPoint, applyDir } from "./math";
import type { AsmDoc, Mate, MateRef, MateType, Tf } from "./types";
import type { V3 } from "../model/types";

/** Mate geometry of a face in its part's coordinates: a plane (point, outward normal) or an axis (point, direction, radius). */
export type Geo = { k: "plane"; p: V3; n: V3 } | { k: "axis"; p: V3; d: V3; r: number };

export interface SolveResult {
  /** Every component's transform after the solve (unchanged when it failed). */
  tfs: Record<string, Tf>;
  ok: boolean;
  /** Mates that are not satisfied (over-defined or conflicting), or whose references are missing. */
  bad: string[];
  missing: string[];
  /** Remaining degrees of freedom per floating component (fixed ones are 0). */
  dof: Record<string, number>;
  /** Degrees of freedom of the whole assembly (the null space of the mates); a linkage moving as one counts once. */
  free: number;
  moved: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The geometry moved by a transform. */
export function placeGeo(g: Geo, t: Tf): Geo {
  return g.k === "plane" ? { k: "plane", p: applyPoint(t, g.p), n: applyDir(t, g.n) } : { k: "axis", p: applyPoint(t, g.p), d: applyDir(t, g.d), r: g.r };
}

const dirOf = (g: Geo) => (g.k === "plane" ? g.n : g.d);

/** The mate types that fit two references, the likely one first (quick mate, FR-MATE-006). */
export function mateTypes(a: Geo["k"], b: Geo["k"]): MateType[] {
  if (a === "plane" && b === "plane") return ["coincident", "parallel", "perpendicular", "distance", "angle", "lock"];
  if (a === "axis" && b === "axis") return ["concentric", "coincident", "parallel", "perpendicular", "tangent", "distance", "angle", "lock"];
  return ["tangent", "coincident", "parallel", "perpendicular", "distance", "lock"];
}

/** Angle (rad) by which the rotation part of `t` · `t0`⁻¹ turns about the unit direction d. */
function turnAbout(t: Tf, t0: Tf, d: V3): number {
  const u0: V3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(d, u0), l = len(u);
  const uu = scale(u, 1 / l);
  // Back to the start pose, then forward to the current one.
  const v = applyDir(t, applyDir(invert(t0), uu));
  const w = sub(v, scale(d, dot(v, d)));
  return Math.atan2(dot(cross(uu, w), d), dot(uu, w));
}
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const I3x4: Tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
/** b's turn relative to a about a's (world) axis `d` since the transforms `t0`. */
function relTurn(t0: [Tf, Tf], tfa: Tf, tfb: Tf, d: V3): number {
  const ia = invert(tfa), delta = compose(compose(ia, tfb), invert(compose(invert(t0[0]), t0[1])));
  return turnAbout(delta, I3x4, applyDir(ia, d));
}

/** The mate's residuals (lengths in mm, directions scaled by `L`), for world geometry. */
/** A screw's turn (rad, in (−π, π]) and travel (mm) of b relative to a since the mate was made. */
function screwMotion(m: Mate, ga: Geo, tfa: Tf, tfb: Tf): { turn: number; travel: number } {
  const ia = invert(tfa), delta = compose(compose(ia, tfb), invert(compose(invert(m.t0![0]), m.t0![1])));
  const dA = applyDir(ia, (ga as Geo & { k: "axis" }).d), pA = applyPoint(ia, ga.p);
  return { turn: turnAbout(delta, I3x4, dA), travel: dot(sub(applyPoint(delta, pA), pA), dA) };
}

/**
 * Residuals of one mate. `branch` holds a screw's turn with its turn count (unwrapped, rad) as the solver last
 * accepted it, so the residual is smooth within a step; without it the nearest turn count is taken, which jumps every
 * half pitch and made the solver lose its way when a handwheel had to turn far (exam #75).
 */
export function residuals(m: Mate, ga: Geo, gb: Geo, L: number, tfa?: Tf, tfb?: Tf, gc?: Geo, gd?: Geo, branch?: { u: number }, ends?: [V3, V3]): number[] {
  const da = dirOf(ga), db0 = dirOf(gb);
  const s = m.align === "aligned" ? 1 : -1;
  const sg = m.flip ? -1 : 1;
  const out: number[] = [];
  const dirs = (v: V3) => out.push(v[0] * L, v[1] * L, v[2] * L);
  const parallel = () => dirs(cross(da, db0));
  // Offsets stay in mm (directions are × L to match): × L they were hundreds of times steeper than every other row,
  // and the solver's damping, set from the steepest row, then swamped gentle motions such as a screw's turn (exam #75).
  const offs = (v: V3) => out.push(v[0], v[1], v[2]);
  const axisOff = (a: Geo & { k: "axis" }, p: V3) => len(cross(sub(p, a.p), a.d));
  switch (m.type) {
    case "coincident":
      if (ga.k === "plane" && gb.k === "plane") { dirs(sub(da, scale(db0, s))); out.push(dot(da, sub(gb.p, ga.p))); }
      else if (ga.k === "axis" && gb.k === "axis") { parallel(); offs(cross(sub(gb.p, ga.p), ga.d)); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, dot(pl.n, sub(ax.p, pl.p))); }
      break;
    case "concentric":
      parallel(); offs(cross(sub(gb.p, ga.p), da));
      // Lock rotation: b's turn about a's axis since the mate was made stays zero.
      if (m.lockRot && tfa && tfb && m.t0 && ga.k === "axis") out.push(wrap(relTurn(m.t0, tfa, tfb, ga.d)) * L);
      break;
    case "parallel":
      if (ga.k === gb.k) parallel(); else out.push(dot(da, db0) * L);
      break;
    case "perpendicular":
      if (ga.k === gb.k) out.push(dot(da, db0) * L); else parallel();
      break;
    case "distance": {
      const v = m.value ?? 0;
      // Between planes the alignment counts, as in a coincident mate, so Aligned / Anti-aligned picks the side b faces (exam #64).
      if (ga.k === "plane" && gb.k === "plane") { if (m.align) dirs(sub(da, scale(db0, s))); else parallel(); out.push(dot(da, sub(gb.p, ga.p)) - sg * v); }
      else if (ga.k === "axis" && gb.k === "axis") { parallel(); out.push(axisOff(ga, gb.p) - v); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, dot(pl.n, sub(ax.p, pl.p)) - sg * v); }
      break;
    }
    case "angle": {
      const b = scale(db0, sg);
      // Signed about the direction kept from when the mate was made (in a's frame), so ±θ differ (exam #72).
      if (m.about && tfa) {
        const ax = applyDir(tfa, m.about), c = cross(da, b);
        out.push(wrap(Math.atan2(dot(c, ax), dot(da, b)) - (m.value ?? 0)) * L);
      } else out.push((Math.atan2(len(cross(da, b)), dot(da, b)) - (m.value ?? 0)) * L);
      break;
    }
    case "tangent":
      if (ga.k === "axis" && gb.k === "axis") { parallel(); out.push(axisOff(ga, gb.p) - (ga.r + gb.r)); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, Math.abs(dot(pl.n, sub(ax.p, pl.p))) - ax.r); }
      break;
    case "limitdist": {
      // Off only outside [min, max]: zero (and flat) inside, so a limit takes no freedom away.
      const lo = m.min ?? 0, hi = Math.max(lo, m.max ?? lo);
      const room = (v: number) => (v < lo ? v - lo : v > hi ? v - hi : 0);
      if (ga.k === "plane" && gb.k === "plane") { parallel(); out.push(room(sg * dot(da, sub(gb.p, ga.p)))); }
      else if (ga.k === "axis" && gb.k === "axis") { parallel(); out.push(room(axisOff(ga, gb.p))); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, room(sg * dot(pl.n, sub(ax.p, pl.p)))); }
      break;
    }
    case "limitangle": {
      const lo = m.min ?? 0, hi = Math.max(lo, m.max ?? lo), b = scale(db0, sg);
      const a = Math.atan2(len(cross(da, b)), dot(da, b));
      out.push((a < lo ? a - lo : a > hi ? a - hi : 0) * L);
      break;
    }
    case "symmetric": {
      if (!gc || gc.k !== "plane") break;
      // a mirrored in the plane c lies on b.
      const n = gc.n, refl = (v: V3) => sub(v, scale(n, 2 * dot(v, n))), reflP = (p: V3) => sub(p, scale(n, 2 * dot(sub(p, gc.p), n)));
      const ra = refl(da), pa = reflP(ga.p);
      if (ga.k === "plane" && gb.k === "plane") { dirs(sub(ra, db0)); out.push(dot(db0, sub(pa, gb.p))); }
      else if (ga.k === "axis" && gb.k === "axis") { dirs(cross(ra, db0)); offs(cross(sub(gb.p, pa), db0)); }
      break;
    }
    case "hinge":
      // Concentric on a/b, coincident on the faces c/d.
      parallel(); offs(cross(sub(gb.p, ga.p), da));
      if (gc?.k === "plane" && gd?.k === "plane") { dirs(sub(gc.n, scale(gd.n, -1))); out.push(dot(gc.n, sub(gd.p, gc.p))); }
      break;
    case "gear": {
      if (!tfa || !tfb || !m.t0 || ga.k !== "axis" || gb.k !== "axis") break;
      const r = m.ratio ?? 1, s2 = m.flip ? -1 : 1;
      const ta = turnAbout(tfa, m.t0[0], ga.d), tb = turnAbout(tfb, m.t0[1], gb.d);
      // External gears turn opposite ways: tb = −r·ta (flip: same way). a's turn count is taken from the branch that fits best.
      let best = Infinity;
      for (let k = -3; k <= 3; k++) { const e = wrap(tb + s2 * r * (ta + 2 * Math.PI * k)); if (Math.abs(e) < Math.abs(best)) best = e; }
      out.push(best * L);
      break;
    }
    case "screw": {
      parallel(); offs(cross(sub(gb.p, ga.p), da));
      if (!tfa || !tfb || !m.t0 || ga.k !== "axis") break;
      const pitch = m.ratio ?? 1, s2 = m.flip ? -1 : 1;
      if (Math.abs(pitch) < 1e-12) break;
      // b's motion relative to a since the mate was made, in a's frame: turn and travel along a's axis.
      const { turn, travel } = screwMotion(m, ga, tfa, tfb);
      // The thread error in mm; the turn count is the one the solver last accepted, so a step sees no jump.
      const lead = (s2 * pitch) / (2 * Math.PI);
      if (branch) out.push(travel - lead * (branch.u + wrap(turn - branch.u)));
      else out.push(lead * wrap(travel / lead - turn));
      break;
    }
    case "slot":
    case "width": {
      // The tab (b and d, or the axis b) centred between the width faces a and c.
      if (!gc || ga.k !== "plane" || gc.k !== "plane") break;
      // The width faces' midplane, measured along a's normal.
      const sa = dot(da, ga.p), sc = dot(da, gc.p), wm = (sa + sc) / 2;
      if (gb.k === "axis") {
        out.push(dot(da, gb.d) * L, dot(da, gb.p) - wm);
        // A slot's pin stays between the end centres (SolidWorks' Free slot mate, exam #81); zero inside, like a limit.
        if (m.type === "slot" && ends) {
          const [e0, e1] = ends, run = sub(e1, e0), Ls = len(run), u = scale(run, 1 / Math.max(Ls, 1e-12));
          const mid = scale(add(e0, e1), 0.5), q = add(gb.p, scale(gb.d, dot(sub(mid, gb.p), gb.d)));
          const t = dot(u, sub(q, e0));
          out.push(t < 0 ? t : t > Ls ? t - Ls : 0);
        }
      }
      else if (gd) { parallel(); out.push((dot(da, gb.p) + dot(da, gd.p)) / 2 - wm); }
      break;
    }
    case "lock": {
      if (!tfa || !tfb || !m.rel) break;
      const r = compose(invert(tfa), tfb);
      // Partial locks (motion study motors): only the orientation, or only the travel along an axis of a.
      if (m.keep === "slide") { const d = m.along ?? [0, 0, 1]; out.push(d[0] * (r[3] - m.rel[3]) + d[1] * (r[7] - m.rel[7]) + d[2] * (r[11] - m.rel[11])); break; }
      for (let i = 0; i < 12; i++) if (m.keep !== "rot" || i % 4 !== 3) out.push((r[i] - m.rel[i]) * (i % 4 === 3 ? 1 : L));
      break;
    }
  }
  return out;
}

/**
 * A slot's rounded ends: the two cylinders of the slot's half width that lie on its mid-plane, square to
 * the side faces' normal (the farthest apart when there are more), in part coordinates. Null when the
 * slot has no such ends (a slot open at one end, or straight walls only).
 */
export function slotEnds(a: Geo & { k: "plane" }, c: Geo & { k: "plane" }, faces: Iterable<Geo>): [V3, V3] | null {
  const n = a.n, w = Math.abs(dot(n, sub(c.p, a.p))), mid = (dot(n, a.p) + dot(n, c.p)) / 2, tol = Math.max(1e-3, w * 1e-3);
  const caps: (Geo & { k: "axis" })[] = [];
  for (const g of faces) {
    if (g.k !== "axis" || Math.abs(g.r - w / 2) > tol || Math.abs(dot(g.d, n)) > 1e-6 || Math.abs(dot(n, g.p) - mid) > tol) continue;
    if (caps.some(q => Math.abs(Math.abs(dot(q.d, g.d)) - 1) > 1e-6)) continue;
    if (!caps.some(q => len(cross(sub(q.p, g.p), g.d)) < tol)) caps.push(g);
  }
  if (caps.length < 2) return null;
  // Each axis's point moved along it into the plane square to it through the first one.
  const d = caps[0].d, o = caps[0].p, at = (g: Geo & { k: "axis" }): V3 => sub(g.p, scale(d, dot(sub(g.p, o), d)));
  let best: [V3, V3] | null = null, far = 0;
  for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) {
    const p = at(caps[i]), q = at(caps[j]), s = len(sub(q, p));
    if (s > far) { far = s; best = [p, q]; }
  }
  return best;
}

export interface SolveInput {
  doc: AsmDoc;
  /** Local geometry of a component's face, or null when it cannot be found. */
  geo: (part: string, face: string) => Geo | null;
  /** Every face's geometry of a part (finds a slot's rounded ends). */
  faces?: (part: string) => Iterable<Geo>;
  /** Rotation centres in part coordinates (bounding-box centre), by part key. */
  centre?: (part: string) => V3;
  /** Extra mates to try (a mate being made), solved with the document's. */
  extra?: Mate[];
  /** Start from these transforms (a drag) instead of the document's. */
  start?: Record<string, Tf>;
  /** Assembly size (mm), to weigh directions against lengths. */
  size?: number;
  /** false skips the degrees of freedom (motion frames, drags): `dof` and `free` are left as if nothing were mated. */
  dof?: boolean;
}

/** Solves the mates; on failure no transform changes. */
export function solve(inp: SolveInput): SolveResult {
  const { doc } = inp;
  const comps = doc.components.filter(c => !c.suppressed);
  const byId = new Map(comps.map(c => [c.id, c]));
  const L = Math.max(1, inp.size ?? 100);
  const all = [...(doc.mates ?? []), ...(inp.extra ?? [])].filter(m => !m.suppressed);
  const missing: string[] = [];
  type Live = { m: Mate; ga: Geo; gb: Geo; ca: string; cb: string; gc?: Geo; cc?: string; gd?: Geo; cd?: string; ends?: [V3, V3] };
  const live: Live[] = [];
  for (const m of all) {
    const ca = byId.get(m.a.comp), cb = byId.get(m.b.comp);
    const ga = ca && (m.type === "lock" ? ({ k: "plane", p: [0, 0, 0], n: [0, 0, 1] } as Geo) : inp.geo(ca.part, m.a.face));
    const gb = cb && (m.type === "lock" ? ({ k: "plane", p: [0, 0, 0], n: [0, 0, 1] } as Geo) : inp.geo(cb.part, m.b.face));
    if (!ca || !cb || !ga || !gb || (ca.id === cb.id && m.type !== "symmetric")) { missing.push(m.id); continue; }
    const l: Live = { m, ga, gb, ca: ca.id, cb: cb.id };
    // The third and fourth references (symmetry plane, width faces).
    const need = m.type === "symmetric" || m.type === "width" || m.type === "slot" || m.type === "hinge";
    if (need) {
      const cc = m.c && byId.get(m.c.comp), gc = cc && inp.geo(cc.part, m.c!.face);
      if (!cc || !gc) { missing.push(m.id); continue; }
      l.gc = gc; l.cc = cc.id;
      if ((m.type === "width" && gb.k === "plane") || m.type === "hinge") {
        const cd = m.d && byId.get(m.d.comp), gd = cd && inp.geo(cd.part, m.d!.face);
        if (!cd || !gd) { missing.push(m.id); continue; }
        l.gd = gd; l.cd = cd.id;
      }
      if (m.type === "symmetric" && ca.id === cb.id && ca.id === cc.id) { missing.push(m.id); continue; }
      if (m.type === "slot" && cc.id === ca.id && ga.k === "plane" && gc.k === "plane" && inp.faces) l.ends = slotEnds(ga, gc, inp.faces(ca.part)) ?? undefined;
    }
    live.push(l);
  }
  const tf0: Record<string, Tf> = {};
  for (const c of doc.components) tf0[c.id] = (inp.start?.[c.id] ?? c.tf).slice();
  // Unknowns: floating components that some mate touches.
  const touched = new Set(live.flatMap(l => [l.ca, l.cb, ...(l.cc ? [l.cc] : []), ...(l.cd ? [l.cd] : [])]));
  const vars = comps.filter(c => !c.fixed && touched.has(c.id)).map(c => c.id);
  const col = new Map(vars.map((id, i) => [id, i * 6]));
  const n = vars.length * 6;
  const tfs: Record<string, Tf> = {};
  for (const id of Object.keys(tf0)) tfs[id] = tf0[id].slice();
  const centreOf = (id: string): V3 => applyPoint(tfs[id], inp.centre?.(byId.get(id)!.part) ?? [0, 0, 0]);

  // A screw's turn count is picked (nearest) where the solve starts and after each accepted step, never inside a step,
  // so the residual has no jump while a step and its line search are measured (exam #75).
  const branches = new Map<Live, { u: number }>();
  const pickBranches = () => {
    for (const l of live) {
      const m = l.m;
      if (m.type !== "screw" || !m.t0 || l.ga.k !== "axis" || Math.abs(m.ratio ?? 1) < 1e-12) continue;
      const { turn, travel } = screwMotion(m, placeGeo(l.ga, tfs[l.ca]), tfs[l.ca], tfs[l.cb]);
      const sp = (m.flip ? -1 : 1) * (m.ratio ?? 1);
      branches.set(l, { u: turn + 2 * Math.PI * Math.round(((2 * Math.PI * travel) / sp - turn) / (2 * Math.PI)) });
    }
  };
  pickBranches();
  const resOf = (l: Live, t: Record<string, Tf>) => residuals(l.m, placeGeo(l.ga, t[l.ca]), placeGeo(l.gb, t[l.cb]), L, t[l.ca], t[l.cb], l.gc && placeGeo(l.gc, t[l.cc!]), l.gd && placeGeo(l.gd, t[l.cd!]), branches.get(l), l.ends && [applyPoint(t[l.ca], l.ends[0]), applyPoint(t[l.ca], l.ends[1])]);
  const R = (t: Record<string, Tf>) => {
    const r: number[] = [];
    for (const l of live) r.push(...resOf(l, t));
    return r;
  };
  /** The transforms moved by a step x (translation, rotation vector × L about each centre). */
  const moved = (x: number[], base: Record<string, Tf>) => {
    const t: Record<string, Tf> = { ...base };
    for (const id of vars) {
      const i = col.get(id)!, c = centreOf(id);
      const w: V3 = [x[i + 3] / L, x[i + 4] / L, x[i + 5] / L], a = len(w);
      let m = translation([x[i], x[i + 1], x[i + 2]]);
      if (a > 1e-15) m = compose(m, rotation(c, scale(w, 1 / a), a));
      t[id] = compose(m, base[id]);
    }
    return t;
  };
  const tol = 1e-7 * L;
  const norm = (r: number[]) => Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  // The mates each unknown component takes part in: a column of the Jacobian only needs those (exam #62).
  const usedBy = new Map<string, number[]>(vars.map(id => [id, []]));
  live.forEach((l, k) => { for (const c of new Set([l.ca, l.cb, l.cc, l.cd])) if (c) usedBy.get(c)?.push(k); });
  /** One component's transform moved by h along unknown j (0..5) of it. */
  const nudged = (id: string, j: number, h: number): Tf => {
    const x = [0, 0, 0, 0, 0, 0];
    x[j] = h;
    if (j < 3) return compose(translation([x[0], x[1], x[2]]), tfs[id]);
    const w: V3 = [x[3] / L, x[4] / L, x[5] / L], a = len(w);
    return compose(rotation(centreOf(id), scale(w, 1 / a), a), tfs[id]);
  };
  const jac = (r0: number[]) => {
    const h = 1e-6 * L;
    const J: number[][] = r0.map(() => new Array(n).fill(0));
    // Row offsets of each mate's residuals; a mate whose count changes with the step falls back to a full evaluation.
    const at: number[] = [];
    let o = 0;
    for (const l of live) { at.push(o); o += resOf(l, tfs).length; }
    const full = o !== r0.length;
    for (const id of vars) {
      const c0 = col.get(id)!;
      for (let j = 0; j < 6; j++) {
        const tp = { ...tfs, [id]: nudged(id, j, h) }, tm = { ...tfs, [id]: nudged(id, j, -h) };
        if (full) {
          const r1 = R(tp), r2 = R(tm);
          for (let i = 0; i < r0.length; i++) J[i][c0 + j] = (r1[i] - r2[i]) / (2 * h);
          continue;
        }
        for (const k of usedBy.get(id)!) {
          const r1 = resOf(live[k], tp), r2 = resOf(live[k], tm);
          for (let i = 0; i < r1.length && i < r2.length; i++) J[at[k] + i][c0 + j] = (r1[i] - r2[i]) / (2 * h);
        }
      }
    }
    return J;
  };

  let r = R(tfs);
  let ok = r.every(v => Math.abs(v) < tol);
  let kicks = 0, damp = DAMP_MIN;
  for (let it = 0; it < 80 && !ok && n; it++) {
    const J = jac(r);
    const f0 = norm(r);
    let dx: number[] | null = null, next = r, tn = tfs, good = false;
    // Levenberg-Marquardt: a step is kept when it lowers the error about as much as the linear model promised;
    // otherwise the damping goes up and the step is made again from the same Jacobian. Light damping lets gentle
    // motions through (a screw's turn moves its row only pitch/2π per radian); heavy damping stops wild turns about
    // directions the mates barely hold, such as a pin's spin when its fitted axis is a little off (exam #28, #75).
    for (let tries = 0; tries < 7 && !good; tries++) {
      dx = dampedStep(J, r, n, damp);
      if (!dx) break;
      let lin = 0;
      for (let i = 0; i < J.length; i++) { const row = J[i]; let v = r[i]; for (let j = 0; j < n; j++) if (row[j] !== 0) v += row[j] * dx[j]; lin += v * v; }
      tn = moved(dx, tfs);
      next = R(tn);
      const fn = norm(next), gain = f0 * f0 - fn * fn, promised = f0 * f0 - lin;
      if (fn < f0 && gain >= 0.1 * promised) { good = true; if (gain >= 0.75 * promised) damp = Math.max(DAMP_MIN, damp / 10); }
      else damp = Math.min(1e-2, damp * 100);
    }
    if (!dx) break;
    // No damping gave a good step: shorten the last (most damped) one.
    let step = 1;
    for (let ls = 0; ls < 12 && !good; ls++) {
      tn = moved(dx.map(v => v * step), tfs);
      next = R(tn);
      if (norm(next) < f0) break;
      step /= 2;
    }
    if (norm(next) >= f0) {
      // Stuck where a residual has no slope (an angle mate between parallel faces): nudge once and go on.
      if (kicks++ > 2) break;
      const kick = vars.flatMap((_, k) => [0, 0, 0, 0.01 * L * Math.sin(k + kicks), 0.01 * L * Math.cos(2 * k + kicks), 0.01 * L * Math.sin(3 * k + 1 + kicks)]);
      const tk = moved(kick, tfs);
      for (const id of vars) tfs[id] = tk[id];
      r = R(tfs);
      continue;
    }
    for (const id of vars) tfs[id] = tn[id];
    pickBranches();
    r = next;
    ok = r.every(v => Math.abs(v) < tol);
  }

  // Which mates are off, by their own residuals.
  const bad: string[] = [];
  if (!ok) for (const l of live) if (resOf(l, tfs).some(v => Math.abs(v) > tol * 10)) bad.push(l.m.id);
  if (!ok && !bad.length) ok = true;
  // Geometry fitted to a tessellation (mesh imports, no kernel) is off by ~1e-5: a solve that stalls that close is solved.
  if (!ok && r.every(v => Math.abs(v) < 1e-5 * L)) { ok = true; bad.length = 0; }
  const dof: Record<string, number> = {};
  for (const c of comps) dof[c.id] = c.fixed ? 0 : 6;
  const loose = 6 * comps.filter(c => !c.fixed && !col.has(c.id)).length;
  let free = n + loose;
  if (ok && n && inp.dof !== false) {
    // A limit takes no freedom away, even when it sits at its end.
    for (const l of live) if (l.m.type === "limitdist" || l.m.type === "limitangle") l.m = { ...l.m, min: -Infinity, max: Infinity };
    for (const l of live) l.ends = undefined;
    const J = jac(R(tfs));
    const N = nullSpace(J, n);
    free = N.length + loose;
    for (const id of vars) {
      const i = col.get(id)!;
      dof[id] = rank(N.map(v => v.slice(i, i + 6)));
    }
  }
  const out = ok ? tfs : tf0;
  let mv = false;
  for (const c of doc.components) if (out[c.id].some((v, i) => Math.abs(v - c.tf[i]) > 1e-9 * Math.max(1, Math.abs(v)))) mv = true;
  return { tfs: out, ok, bad, missing, dof, free, moved: mv };
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const m = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let i = c + 1; i < m; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < m; i++) {
      const f = M[i][c] / M[c][c];
      if (f) for (let k = c; k <= m; k++) M[i][k] -= f * M[c][k];
    }
  }
  const x = new Array(m).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    let s = M[i][m];
    for (let k = i + 1; k < m; k++) s -= M[i][k] * x[k];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * Minimum-norm damped Gauss-Newton step dx = -Jᵀ (J Jᵀ + μI)⁻¹ r, or the same step as -(JᵀJ + μI)⁻¹ Jᵀ r when there
 * are fewer unknowns than residuals (the smaller system; a big linkage has hundreds of each, exam #62).
 */
/** Lightest damping, as a share of the steepest column of JᵀJ. */
const DAMP_MIN = 1e-10;
function dampedStep(J: number[][], r: number[], n: number, damp = DAMP_MIN): number[] | null {
  const m = r.length;
  // Nonzero columns per row: a mate touches at most four components.
  const nz = J.map(row => { const c: number[] = []; for (let j = 0; j < n; j++) if (row[j] !== 0) c.push(j); return c; });
  if (m <= n) {
    const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
    const rowsOf: number[][] = Array.from({ length: n }, () => []);
    nz.forEach((cs, i) => { for (const j of cs) rowsOf[j].push(i); });
    for (let j = 0; j < n; j++) {
      const rs = rowsOf[j];
      for (const i of rs) for (const k of rs) A[i][k] += J[i][j] * J[k][j];
    }
    let mx = 0;
    for (let i = 0; i < m; i++) mx = Math.max(mx, A[i][i]);
    const mu = damp * mx + 1e-14;
    for (let i = 0; i < m; i++) A[i][i] += mu;
    const y = solveLinear(A, r.map(v => -v));
    if (!y) return null;
    const dx = new Array(n).fill(0);
    nz.forEach((cs, i) => { for (const j of cs) dx[j] += J[i][j] * y[i]; });
    return dx;
  }
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  nz.forEach((cs, i) => {
    const row = J[i];
    for (const j of cs) { b[j] -= row[j] * r[i]; for (const k of cs) A[j][k] += row[j] * row[k]; }
  });
  let mx = 0;
  for (let j = 0; j < n; j++) mx = Math.max(mx, A[j][j]);
  const mu = damp * mx + 1e-14;
  for (let j = 0; j < n; j++) A[j][j] += mu;
  return solveLinear(A, b);
}

/**
 * Basis of the null space of J (rows m × n), as vectors of length n: an orthonormal basis of the row space by
 * Gram-Schmidt (twice, for accuracy), then the unit vectors' parts outside it. O(m·n·rank), where the old Jacobi
 * eigen-solve of JᵀJ was O(n³) per sweep and took most of a motion frame for a big linkage (exam #62).
 */
function nullSpace(J: number[][], n: number): number[][] {
  const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const off = (v: number[], basis: number[][]) => {
    for (let pass = 0; pass < 2; pass++) for (const q of basis) { const d = dot(v, q); if (d) for (let i = 0; i < v.length; i++) v[i] -= d * q[i]; }
  };
  const big = Math.max(1e-30, ...J.map(row => Math.sqrt(dot(row, row))));
  const rows: number[][] = [];
  // Longest rows first, so a nearly dependent row is the one judged against the others.
  for (const row of [...J].sort((a, b) => dot(b, b) - dot(a, a))) {
    const v = row.slice(), l0 = Math.sqrt(dot(v, v));
    if (l0 < 1e-9 * big) continue;
    off(v, rows);
    const l = Math.sqrt(dot(v, v));
    if (l > 3e-5 * big) rows.push(v.map(x => x / l));
  }
  const out: number[][] = [];
  for (let k = 0; k < n && rows.length + out.length < n; k++) {
    const v = new Array(n).fill(0);
    v[k] = 1;
    off(v, rows);
    off(v, out);
    const l = Math.sqrt(dot(v, v));
    if (l > 1e-6) out.push(v.map(x => x / l));
  }
  return out;
}

/** Rank of the 6-row block spanned by these vectors (columns), by Gram-Schmidt. */
function rank(vs: number[][]): number {
  const basis: number[][] = [];
  for (const v0 of vs) {
    const v = v0.slice();
    for (const b of basis) { const d = v.reduce((s, x, i) => s + x * b[i], 0); for (let i = 0; i < v.length; i++) v[i] -= d * b[i]; }
    const l = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // Null vectors are unit length over every unknown: a block below 1e-4 is round-off, not a freedom (exam #71).
    if (l > 1e-4) basis.push(v.map(x => x / l));
  }
  return Math.min(6, basis.length);
}

/** Default alignment and side for a new mate, from where the references are now (as SolidWorks picks the nearer one). */
export function mateDefaults(type: MateType, ga: Geo, gb: Geo): Partial<Mate> {
  const da = dirOf(ga), db = dirOf(gb);
  const out: Partial<Mate> = {};
  if (type === "coincident" || type === "parallel" || type === "distance") out.align = dot(da, db) >= 0 ? "aligned" : "anti";
  if (type === "distance") {
    if (ga.k === "plane" && gb.k === "plane") { const d = dot(da, sub(gb.p, ga.p)); out.value = Math.abs(d); out.flip = d < 0; }
    else if (ga.k === "axis" && gb.k === "axis") out.value = len(cross(sub(gb.p, ga.p), ga.d));
    else { const pl = (ga.k === "plane" ? ga : gb) as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; const d = dot(pl.n, sub(ax.p, pl.p)); out.value = Math.abs(d); out.flip = d < 0; }
  }
  if (type === "angle") { const a = Math.atan2(len(cross(da, db)), dot(da, db)); out.value = a; }
  // Gear: the turns go inversely with the radii; screw: 1 mm per turn to start with.
  if (type === "gear" && ga.k === "axis" && gb.k === "axis") out.ratio = gb.r > 1e-9 ? Math.round((ga.r / gb.r) * 1e6) / 1e6 : 1;
  if (type === "screw") out.ratio = 1;
  return out;
}

export type { MateRef };
