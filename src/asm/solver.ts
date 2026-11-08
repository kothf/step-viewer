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
  moved: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

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

/** The mate's residuals (lengths in mm, directions scaled by `L`), for world geometry. */
export function residuals(m: Mate, ga: Geo, gb: Geo, L: number, tfa?: Tf, tfb?: Tf, gc?: Geo, gd?: Geo): number[] {
  const da = dirOf(ga), db0 = dirOf(gb);
  const s = m.align === "aligned" ? 1 : -1;
  const sg = m.flip ? -1 : 1;
  const out: number[] = [];
  const dirs = (v: V3) => out.push(v[0] * L, v[1] * L, v[2] * L);
  const parallel = () => dirs(cross(da, db0));
  const axisOff = (a: Geo & { k: "axis" }, p: V3) => len(cross(sub(p, a.p), a.d));
  switch (m.type) {
    case "coincident":
      if (ga.k === "plane" && gb.k === "plane") { dirs(sub(da, scale(db0, s))); out.push(dot(da, sub(gb.p, ga.p))); }
      else if (ga.k === "axis" && gb.k === "axis") { parallel(); dirs(cross(sub(gb.p, ga.p), ga.d)); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, dot(pl.n, sub(ax.p, pl.p))); }
      break;
    case "concentric":
      parallel(); dirs(cross(sub(gb.p, ga.p), da));
      break;
    case "parallel":
      if (ga.k === gb.k) parallel(); else out.push(dot(da, db0) * L);
      break;
    case "perpendicular":
      if (ga.k === gb.k) out.push(dot(da, db0) * L); else parallel();
      break;
    case "distance": {
      const v = m.value ?? 0;
      if (ga.k === "plane" && gb.k === "plane") { parallel(); out.push(dot(da, sub(gb.p, ga.p)) - sg * v); }
      else if (ga.k === "axis" && gb.k === "axis") { parallel(); out.push(axisOff(ga, gb.p) - v); }
      else { const pl = ga.k === "plane" ? ga : gb as Geo & { k: "plane" }, ax = (ga.k === "axis" ? ga : gb) as Geo & { k: "axis" }; out.push(dot(pl.n, ax.d) * L, dot(pl.n, sub(ax.p, pl.p)) - sg * v); }
      break;
    }
    case "angle": {
      const b = scale(db0, sg);
      out.push((Math.atan2(len(cross(da, b)), dot(da, b)) - (m.value ?? 0)) * L);
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
      else if (ga.k === "axis" && gb.k === "axis") { dirs(cross(ra, db0)); dirs(cross(sub(gb.p, pa), db0)); }
      break;
    }
    case "hinge":
      // Concentric on a/b, coincident on the faces c/d.
      parallel(); dirs(cross(sub(gb.p, ga.p), da));
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
      parallel(); dirs(cross(sub(gb.p, ga.p), da));
      if (!tfa || !tfb || !m.t0 || ga.k !== "axis") break;
      const pitch = m.ratio ?? 1, s2 = m.flip ? -1 : 1;
      if (Math.abs(pitch) < 1e-12) break;
      // b's motion relative to a since the mate was made, in a's frame: turn and travel along a's axis.
      const ia = invert(tfa), delta = compose(compose(ia, tfb), invert(compose(invert(m.t0[0]), m.t0[1])));
      const dA = applyDir(ia, ga.d), pA = applyPoint(ia, ga.p);
      const turn = turnAbout(delta, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], dA);
      const travel = dot(sub(applyPoint(delta, pA), pA), dA);
      const k = Math.round(((2 * Math.PI * travel) / (s2 * pitch) - turn) / (2 * Math.PI));
      out.push(travel - (s2 * pitch * (turn + 2 * Math.PI * k)) / (2 * Math.PI));
      break;
    }
    case "slot":
    case "width": {
      // The tab (b and d, or the axis b) centred between the width faces a and c.
      if (!gc || ga.k !== "plane" || gc.k !== "plane") break;
      // The width faces' midplane, measured along a's normal.
      const sa = dot(da, ga.p), sc = dot(da, gc.p), wm = (sa + sc) / 2;
      if (gb.k === "axis") { out.push(dot(da, gb.d) * L, dot(da, gb.p) - wm); }
      else if (gd) { parallel(); out.push((dot(da, gb.p) + dot(da, gd.p)) / 2 - wm); }
      break;
    }
    case "lock": {
      if (!tfa || !tfb || !m.rel) break;
      const r = compose(invert(tfa), tfb);
      for (let i = 0; i < 12; i++) out.push((r[i] - m.rel[i]) * (i % 4 === 3 ? 1 : L));
      break;
    }
  }
  return out;
}

export interface SolveInput {
  doc: AsmDoc;
  /** Local geometry of a component's face, or null when it cannot be found. */
  geo: (part: string, face: string) => Geo | null;
  /** Rotation centres in part coordinates (bounding-box centre), by part key. */
  centre?: (part: string) => V3;
  /** Extra mates to try (a mate being made), solved with the document's. */
  extra?: Mate[];
  /** Start from these transforms (a drag) instead of the document's. */
  start?: Record<string, Tf>;
  /** Assembly size (mm), to weigh directions against lengths. */
  size?: number;
}

/** Solves the mates; on failure no transform changes. */
export function solve(inp: SolveInput): SolveResult {
  const { doc } = inp;
  const comps = doc.components.filter(c => !c.suppressed);
  const byId = new Map(comps.map(c => [c.id, c]));
  const L = Math.max(1, inp.size ?? 100);
  const all = [...(doc.mates ?? []), ...(inp.extra ?? [])].filter(m => !m.suppressed);
  const missing: string[] = [];
  type Live = { m: Mate; ga: Geo; gb: Geo; ca: string; cb: string; gc?: Geo; cc?: string; gd?: Geo; cd?: string };
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

  const resOf = (l: Live, t: Record<string, Tf>) => residuals(l.m, placeGeo(l.ga, t[l.ca]), placeGeo(l.gb, t[l.cb]), L, t[l.ca], t[l.cb], l.gc && placeGeo(l.gc, t[l.cc!]), l.gd && placeGeo(l.gd, t[l.cd!]));
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
  const jac = (r0: number[]) => {
    const h = 1e-6 * L;
    const J: number[][] = r0.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const x = new Array(n).fill(0);
      x[j] = h;
      const r1 = R(moved(x, tfs));
      x[j] = -h;
      const r2 = R(moved(x, tfs));
      for (let i = 0; i < r0.length; i++) J[i][j] = (r1[i] - r2[i]) / (2 * h);
    }
    return J;
  };

  let r = R(tfs);
  let ok = r.every(v => Math.abs(v) < tol);
  let kicks = 0;
  for (let it = 0; it < 80 && !ok && n; it++) {
    const J = jac(r);
    // Minimum-norm damped step: dx = -Jᵀ (J Jᵀ + μI)⁻¹ r.
    const m = r.length;
    const A: number[][] = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, k) => { let s = 0; for (let j = 0; j < n; j++) s += J[i][j] * J[k][j]; return s; }));
    let mx = 0;
    for (let i = 0; i < m; i++) mx = Math.max(mx, A[i][i]);
    const mu = 1e-10 * mx + 1e-14;
    for (let i = 0; i < m; i++) A[i][i] += mu;
    const y = solveLinear(A, r.map(v => -v));
    if (!y) break;
    const dx = new Array(n).fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < m; i++) dx[j] += J[i][j] * y[i];
    const f0 = norm(r);
    let step = 1, next = r, tn = tfs;
    for (let ls = 0; ls < 12; ls++) {
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
    r = next;
    ok = r.every(v => Math.abs(v) < tol);
  }

  // Which mates are off, by their own residuals.
  const bad: string[] = [];
  if (!ok) for (const l of live) if (resOf(l, tfs).some(v => Math.abs(v) > tol * 10)) bad.push(l.m.id);
  if (!ok && !bad.length) ok = true;
  const dof: Record<string, number> = {};
  for (const c of comps) dof[c.id] = c.fixed ? 0 : 6;
  if (ok && n) {
    // A limit takes no freedom away, even when it sits at its end.
    for (const l of live) if (l.m.type === "limitdist" || l.m.type === "limitangle") l.m = { ...l.m, min: -Infinity, max: Infinity };
    const J = jac(R(tfs));
    const N = nullSpace(J, n);
    for (const id of vars) {
      const i = col.get(id)!;
      dof[id] = rank(N.map(v => v.slice(i, i + 6)));
    }
  }
  const out = ok ? tfs : tf0;
  let mv = false;
  for (const c of doc.components) if (out[c.id].some((v, i) => Math.abs(v - c.tf[i]) > 1e-9 * Math.max(1, Math.abs(v)))) mv = true;
  return { tfs: out, ok, bad, missing, dof, moved: mv };
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

/** Basis of the null space of J (rows m × n) from the eigenvectors of JᵀJ (Jacobi), as vectors of length n. */
function nullSpace(J: number[][], n: number): number[][] {
  const A: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => J.reduce((s, row) => s + row[i] * row[k], 0)));
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (i === k ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const ev = A.map((row, i) => row[i]);
  const mx = Math.max(1e-30, ...ev.map(Math.abs));
  const out: number[][] = [];
  for (let k = 0; k < n; k++) if (Math.abs(ev[k]) < 1e-9 * mx) out.push(V.map(row => row[k]));
  return out;
}

/** Rank of the 6-row block spanned by these vectors (columns), by Gram-Schmidt. */
function rank(vs: number[][]): number {
  const basis: number[][] = [];
  for (const v0 of vs) {
    const v = v0.slice();
    for (const b of basis) { const d = v.reduce((s, x, i) => s + x * b[i], 0); for (let i = 0; i < v.length; i++) v[i] -= d * b[i]; }
    const l = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (l > 1e-6) basis.push(v.map(x => x / l));
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
