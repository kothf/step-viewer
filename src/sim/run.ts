// Structural analysis (FR-SOL-010, FR-STU-020): a study turned into a solver problem, and the passes.
// Pure: runs in the solver worker and in node tests.

import { outputTimes, profileBreaks, profileFactor, profileStep, type PowerProfile } from "./transient";
import { MeshBody, insideOf } from "./body";
import { solveStatic, staticMemory, MEMORY_LIMIT, momentField, triArea, triNormals, type Bolt, type BoltResult, type Weld, type WeldResult, type Connector, type ConnectorResult, type FaceMass, type Contact, type Load, type Reaction, type Support, type TempField } from "./static";
import { makeGrid, type Grid } from "./grid";
import { gridTrianglePoints } from "./quad";
import { DEFAULT_AMBIENT, DEFAULT_REF, keepsSplit, enclosureFactor, fanSpeed, GRAVITY, MAX_REFINE, PACKAGE_MIN_POWER, compOf, isThermalType, type Study, type StudyEdge, type StudyPoint } from "./types";
import { contactPatch, facingPatch, intoPatch } from "../thermal/study";
import { forcedH, keepBuild, kmapMean, ktFactor, solveThermal, takeBuild, thermalMemory, transientThermal, type SinkFlow, type ThermalContact, type ThermalLink, type ThermalSink, type ThermalSource, type ThermalExchange, type ExchangeFlow, type KMap } from "./thermal";
import { viewFactor } from "./viewfactor";
import { progress, progressPass } from "./progress";

/** The body for the solver: the kernel's triangles with each one's face, and the face names. */
export interface SimBody {
  tris: Float64Array;
  face: Int32Array;
  names: string[];
  lo: number[];
  hi: number[];
}

/** The body without the faces `drop` names: their triangles go and their names are blanked, so nothing can refer to them (face indices stay). */
export function withoutFaces(body: SimBody, drop: (name: string) => boolean): SimBody {
  const gone = body.names.map(drop), nt = body.face.length;
  if (!gone.some(Boolean)) return body;
  let n = 0;
  for (let t = 0; t < nt; t++) if (!gone[body.face[t]]) n++;
  const tris = new Float64Array(9 * n), face = new Int32Array(n);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let o = 0;
  for (let t = 0; t < nt; t++) {
    if (gone[body.face[t]]) continue;
    for (let k = 0; k < 9; k++) { const v = body.tris[9 * t + k]; tris[9 * o + k] = v; if (v < lo[k % 3]) lo[k % 3] = v; if (v > hi[k % 3]) hi[k % 3] = v; }
    face[o++] = body.face[t];
  }
  return { tris, face, names: body.names.map((s, i) => (gone[i] ? "" : s)), lo: n ? lo : [...body.lo], hi: n ? hi : [...body.hi] };
}

export interface SimMaterial { name: string; /** MPa */ E: number; nu: number; /** t/mm³ */ rho: number; /** MPa */ sy?: number; su?: number }

export interface StudyProblem {
  fixed: Support[];
  loads: Load[];
  gravity?: number[];
  /** A centrifugal load: the axis line, rad/s and rad/s². */
  spin?: { p: number[]; axis: number[]; omega: number; alpha: number };
  /**
   * Items that cannot be solved as they are: E-SIM-REF (face gone), E-SIM-EMPTY (nothing picked), E-SIM-HINGE,
   * E-SIM-SPRING (an elastic support without stiffness), E-SIM-AXIS (a centrifugal load's faces have no one axis),
   * E-SIM-ONESPIN (a second centrifugal load), E-SIM-BEARING (a bearing load whose force lies along the axis).
   */
  problems: { id: string; code: "E-SIM-REF" | "E-SIM-EMPTY" | "E-SIM-HINGE" | "E-SIM-SPRING" | "E-SIM-AXIS" | "E-SIM-ONESPIN" | "E-SIM-BEARING" | "E-SIM-ONETEMP" }[];
  /** Local accuracy (FR-SOL-012): the elements meeting these triangles start `level` degrees higher. */
  refine?: { tris: Float64Array; level: number }[];
  /** Inertia relief: no supports, the loads are balanced by the body's inertia. */
  relief?: boolean;
  /** Which study item each entry of `fixed` is. */
  supportIds: string[];
  /** Connectors between two sets of faces and masses spread over faces (FR-CON-023), with the connectors' ids. */
  connectors?: Connector[];
  connectorIds?: string[];
  masses?: FaceMass[];
  /**
   * Thermal expansion (FR-LOAD-011): the stress-free temperature °C, a uniform temperature (else a thermal
   * study's result, given in `RunInput.temp`), and the surface its traction acts on: every face but those whose
   * motion fixed, sliding, hinge, held-direction and displacement supports hold.
   */
  thermo?: { ref: number; uniform?: number; from?: string; tris: Float64Array; id: string };
}

const oneName = new WeakMap<SimBody, Int32Array>();
/**
 * Each triangle's face, with the faces of one name counted as one (the first of them): a hole that a slot cuts
 * in two keeps one name for both walls, and is picked, shown and counted as one face.
 */
function faceOf(b: SimBody): Int32Array {
  let f = oneName.get(b);
  if (!f) {
    const first = b.names.map(n => (n ? b.names.indexOf(n) : -1));
    f = first.every((v, i) => v < 0 || v === i) ? b.face : Int32Array.from(b.face, v => (first[v] >= 0 ? first[v] : v));
    oneName.set(b, f);
  }
  return f;
}

function trisOf(b: SimBody, names: string[]): Float64Array | null {
  const want = new Set<number>(), face = faceOf(b);
  for (const n of names) { const i = b.names.indexOf(n); if (i < 0) return null; want.add(i); }
  const out: number[] = [];
  for (let t = 0; t < face.length; t++) if (want.has(face[t])) for (let k = 0; k < 9; k++) out.push(b.tris[9 * t + k]);
  return Float64Array.from(out);
}

const vkey = (t: ArrayLike<number>, o: number, q: number) => `${Math.round(t[o] / q)},${Math.round(t[o + 1] / q)},${Math.round(t[o + 2] / q)}`;
const quantum = (b: SimBody) => 1e-7 * Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2], 1e-9);

/**
 * Spot weld points for the solver (6 numbers each): the point, and the direction into the body at the face
 * it is on (against the normal of that face's nearest triangle). Null when a face is gone.
 */
export function spotPoints(b: SimBody, pts: { faces: string[]; at: number[] }[]): Float64Array | null {
  const T = b.tris, out: number[] = [], face = faceOf(b);
  for (const p of pts) {
    const f = b.names.indexOf(p.faces[0]);
    if (f < 0) return null;
    let best = Infinity, bt = -1;
    for (let t = 0; t < face.length; t++) {
      if (face[t] !== f) continue;
      const o = 9 * t;
      const d = Math.hypot((T[o] + T[o + 3] + T[o + 6]) / 3 - p.at[0], (T[o + 1] + T[o + 4] + T[o + 7]) / 3 - p.at[1], (T[o + 2] + T[o + 5] + T[o + 8]) / 3 - p.at[2]);
      if (d < best) { best = d; bt = t; }
    }
    if (bt < 0) return null;
    const o = 9 * bt, ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]) || 1;
    out.push(p.at[0], p.at[1], p.at[2], -n[0] / l, -n[1] / l, -n[2] / l);
  }
  return Float64Array.from(out);
}

/**
 * The edge two faces share, as segments of 9 numbers: both ends and a direction into the body (against the
 * two faces' normals). Null when a face is gone, empty when they share no edge.
 */
export function edgeLines(b: SimBody, fa: string, fb: string): Float64Array | null {
  const ia = b.names.indexOf(fa), ib = b.names.indexOf(fb);
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return new Float64Array(0);
  const q = quantum(b), T = b.tris, nrm = triNormals(T), face = faceOf(b);
  const sides = new Map<string, number>();
  const each = (f: number, fn: (key: string, t: number, o0: number, o1: number) => void) => {
    for (let t = 0; t < face.length; t++) {
      if (face[t] !== f) continue;
      const k = [0, 1, 2].map(v => vkey(T, 9 * t + 3 * v, q));
      for (let e = 0; e < 3; e++) {
        const i = e, j = (e + 1) % 3;
        fn(k[i] < k[j] ? `${k[i]}|${k[j]}` : `${k[j]}|${k[i]}`, t, 9 * t + 3 * i, 9 * t + 3 * j);
      }
    }
  };
  each(ib, (key, t) => { sides.set(key, t); });
  const out: number[] = [];
  each(ia, (key, t, o0, o1) => {
    const u = sides.get(key);
    if (u === undefined) return;
    const d = [0, 1, 2].map(c => -(nrm[3 * t + c] + nrm[3 * u + c]));
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    out.push(T[o0], T[o0 + 1], T[o0 + 2], T[o1], T[o1 + 1], T[o1 + 2], d[0] / l, d[1] / l, d[2] / l);
  });
  return Float64Array.from(out);
}

/**
 * The corner where the faces meet nearest `at`: position and a direction into the body (against the normals
 * of the triangles around it). Null when a face is gone or they share no point.
 */
export function cornerPoint(b: SimBody, faces: string[], at: ArrayLike<number>): number[] | null {
  const ids = faces.map(n => b.names.indexOf(n));
  if (!ids.length || ids.some(i => i < 0)) return null;
  const q = quantum(b), T = b.tris, face = faceOf(b);
  const seen = new Map<string, { mask: Set<number>; o: number }>();
  for (let t = 0; t < face.length; t++) {
    if (!ids.includes(face[t])) continue;
    for (let v = 0; v < 3; v++) {
      const k = vkey(T, 9 * t + 3 * v, q);
      let r = seen.get(k);
      if (!r) seen.set(k, r = { mask: new Set(), o: 9 * t + 3 * v });
      r.mask.add(face[t]);
    }
  }
  const want = new Set(ids).size;
  let best = -1, bd = Infinity, bk = "";
  for (const [k, r] of seen) {
    if (r.mask.size < want) continue;
    const d = Math.hypot(T[r.o] - at[0], T[r.o + 1] - at[1], T[r.o + 2] - at[2]);
    if (d < bd) { bd = d; best = r.o; bk = k; }
  }
  if (best < 0) return null;
  const nrm = triNormals(T), d = [0, 0, 0];
  for (let t = 0; t < b.face.length; t++) for (let v = 0; v < 3; v++)
    if (vkey(T, 9 * t + 3 * v, q) === bk) for (let c = 0; c < 3; c++) d[c] -= nrm[3 * t + c];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [T[best], T[best + 1], T[best + 2], d[0] / l, d[1] / l, d[2] / l];
}

/** The axis of a round face from its triangles: the direction most square to every normal. */
export function axisOf(tris: ArrayLike<number>): number[] | null {
  const n = triNormals(tris), a = triNormals(tris, true);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < a.length; t++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += a[t] * n[3 * t + i] * n[3 * t + j];
  // smallest eigenvector by inverse-free power iteration on (tr·I − S)
  const tr = S[0][0] + S[1][1] + S[2][2];
  if (!(tr > 0)) return null;
  let best: number[] | null = null, bv = Infinity;
  for (const start of [[1, 0.3, 0.2], [0.2, 1, 0.3], [0.3, 0.2, 1]]) {
    let v = start;
    for (let it = 0; it < 200; it++) {
      const w = [0, 1, 2].map(i => tr * v[i] - (S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]));
      const l = Math.hypot(w[0], w[1], w[2]);
      if (!(l > 0)) break;
      v = w.map(x => x / l);
    }
    const q = [0, 1, 2].reduce((s, i) => s + v[i] * (S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]), 0);
    if (q < bv) { bv = q; best = v; }
  }
  // a flat face has two such directions, a sphere none: only a clear single one is an axis
  if (!best || bv > 1e-4 * tr) return null;
  let v = [1, 0.7, 0.4], top = 0;
  for (let it = 0; it < 200; it++) {
    const w = [0, 1, 2].map(i => S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]);
    top = Math.hypot(w[0], w[1], w[2]);
    if (!(top > 0)) break;
    v = w.map(x => x / top);
  }
  return tr - top - bv > 0.02 * tr ? best : null;
}

/** An axis direction turned to point the way of its largest component: towards +X, +Y or +Z. */
export function positiveAxis(a: ArrayLike<number>): number[] {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(a[i]) > Math.abs(a[k]) + 1e-9) k = i;
  const s = a[k] < 0 ? -1 : 1;
  return [s * a[0], s * a[1], s * a[2]];
}

/** The axis of cylindrical faces as a line: the direction (`axisOf`) and the point nearest to every triangle's normal line. */
export function axisLine(tris: ArrayLike<number>): { p: number[]; axis: number[] } | null {
  const axis = axisOf(tris);
  if (!axis) return null;
  const n = triNormals(tris), ar = triNormals(tris, true);
  // Σ a (I − n nᵀ) p = Σ a (I − n nᵀ) c, with the axis direction pinned at the centroid
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0], cen = [0, 0, 0];
  let area = 0;
  for (let t = 0; t < ar.length; t++) {
    const o = 9 * t, c = [0, 1, 2].map(i => (tris[o + i] + tris[o + 3 + i] + tris[o + 6 + i]) / 3);
    for (let i = 0; i < 3; i++) {
      cen[i] += ar[t] * c[i];
      for (let j = 0; j < 3; j++) { const q = ar[t] * ((i === j ? 1 : 0) - n[3 * t + i] * n[3 * t + j]); M[i][j] += q; r[i] += q * c[j]; }
    }
    area += ar[t];
  }
  if (!(area > 0)) return null;
  for (let i = 0; i < 3; i++) cen[i] /= area;
  const ac = axis[0] * cen[0] + axis[1] * cen[1] + axis[2] * cen[2];
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) M[i][j] += area * axis[i] * axis[j]; r[i] += area * axis[i] * ac; }
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!(Math.abs(D) > 1e-12 * area ** 3)) return null;
  const p = [0, 1, 2].map(k => det(M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / D);
  return { p, axis };
}

/** The picked edges as segments, or the picked corners as points, of an item on edges or points; else the problem. */
function linesOrPoints(b: SimBody, it: { on?: "edges" | "points"; edges?: StudyEdge[]; points?: StudyPoint[] }): Float64Array | "E-SIM-REF" | "E-SIM-EMPTY" {
  const parts: number[] = [];
  if (it.on === "edges") for (const e of it.edges ?? []) {
    const s = edgeLines(b, e.faces[0], e.faces[1]);
    if (!s || !s.length) return "E-SIM-REF";
    for (const v of s) parts.push(v);
  } else for (const pt of it.points ?? []) {
    const c = cornerPoint(b, pt.faces, pt.at);
    if (!c) return "E-SIM-REF";
    parts.push(...c);
  }
  return parts.length ? Float64Array.from(parts) : "E-SIM-EMPTY";
}

/** Supports and loads of a study on the body's triangles. */
export function studyProblem(st: Study, b: SimBody): StudyProblem {
  const off = new Set(st.suppressed ?? []);
  const out: StudyProblem = { fixed: [], loads: [], problems: [], supportIds: [] };
  const relief = !!st.settings.relief && st.kind !== "modal";
  if (relief) out.relief = true;
  for (const s of st.supports) {
    if (off.has(s.id) || relief || isThermalType(s.type)) continue;
    const moved = (sup: Support) => {
      if (s.type !== "disp") return;
      const d = s.dirs ?? [true, true, true], v = s.disp ?? [0, 0, 0];
      sup.mode = "dirs"; sup.dirs = d;
      if (v.some((x, i) => d[i] && x !== 0)) sup.value = v.map((x, i) => (d[i] ? x : 0));
    };
    if (s.on && (s.type === "fixed" || s.type === "dirs" || s.type === "disp")) {
      const g = linesOrPoints(b, s);
      if (typeof g === "string") { out.problems.push({ id: s.id, code: g }); continue; }
      const sup: Support = { tris: new Float64Array(0), mode: s.type === "disp" ? "dirs" : s.type, ...(s.on === "edges" ? { lines: g } : { points: g }) };
      if (s.type === "dirs") sup.dirs = s.dirs ?? [true, true, true];
      moved(sup);
      out.fixed.push(sup);
      out.supportIds.push(s.id);
      continue;
    }
    if (!s.faces.length) { out.problems.push({ id: s.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, s.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: s.id, code: "E-SIM-REF" }); continue; }
    if (s.type === "elastic") {
      const kn = Math.max(0, s.kn ?? 0), kt = Math.max(0, s.kt ?? 0);
      if (!(kn > 0) && !(kt > 0)) { out.problems.push({ id: s.id, code: "E-SIM-SPRING" }); continue; }
      out.fixed.push({ tris, mode: kn > 0 && kt > 0 ? "fixed" : kn > 0 ? "sliding" : "tangent", spring: { kn, kt } });
      out.supportIds.push(s.id);
      continue;
    }
    const sup: Support = { tris, mode: (s.type === "disp" ? "dirs" : s.type) as Support["mode"] };
    moved(sup);
    if (s.type === "hinge") {
      const axis = axisOf(tris);
      if (!axis) { out.problems.push({ id: s.id, code: "E-SIM-HINGE" }); continue; }
      sup.axis = axis; sup.axialFree = s.axialFree;
    }
    if (s.type === "dirs") sup.dirs = s.dirs ?? [true, true, true];
    out.fixed.push(sup);
    out.supportIds.push(s.id);
  }
  for (const l of st.loads) {
    if (off.has(l.id) || isThermalType(l.type)) continue;
    const comp = (l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(c => c.v);
    if (l.type === "temperature") {
      if (out.thermo) { out.problems.push({ id: l.id, code: "E-SIM-ONETEMP" }); continue; }
      const held = new Set<number>(), face = faceOf(b);
      for (const s of st.supports) {
        if (off.has(s.id) || relief || isThermalType(s.type) || s.type === "elastic" || s.on) continue;
        for (const f of s.faces) { const i = b.names.indexOf(f.name); if (i >= 0) held.add(i); }
      }
      const kept: number[] = [];
      for (let t = 0; t < face.length; t++) if (!held.has(face[t])) for (let k = 0; k < 9; k++) kept.push(b.tris[9 * t + k]);
      out.thermo = { ref: l.ref ?? DEFAULT_REF, tris: Float64Array.from(kept), id: l.id, ...(l.from ? { from: l.from } : { uniform: l.value?.v ?? DEFAULT_REF }) };
      continue;
    }
    if (l.type === "gravity") {
      out.gravity = (out.gravity ?? [0, 0, 0]).map((v, i) => v + comp[i]);
      continue;
    }
    if (l.type === "centrifugal") {
      if (out.spin) { out.problems.push({ id: l.id, code: "E-SIM-ONESPIN" }); continue; }
      let line: { p: number[]; axis: number[] } | null;
      if (l.faces.length) {
        const tris = trisOf(b, l.faces.map(f => f.name));
        if (!tris) { out.problems.push({ id: l.id, code: "E-SIM-REF" }); continue; }
        line = axisLine(tris);
        if (!line) { out.problems.push({ id: l.id, code: "E-SIM-AXIS" }); continue; }
      } else line = { p: [0, 0, 0], axis: l.axis === "x" ? [1, 0, 0] : l.axis === "y" ? [0, 1, 0] : [0, 0, 1] };
      out.spin = { ...line, omega: ((l.value?.v ?? 0) * Math.PI) / 30, alpha: l.accel ?? 0 };
      continue;
    }
    if (l.type === "force" && l.on) {
      const none = new Float64Array(0), g = linesOrPoints(b, l);
      if (typeof g === "string") out.problems.push({ id: l.id, code: g });
      else out.loads.push(l.on === "edges" ? { tris: none, force: comp, lines: g } : { tris: none, force: comp, points: g });
      continue;
    }
    if (!l.faces.length) { out.problems.push({ id: l.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, l.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: l.id, code: "E-SIM-REF" }); continue; }
    const sign = l.flip ? -1 : 1, v = l.value?.v ?? 0;
    if (l.type === "torque" || l.type === "bearing") {
      const line = axisLine(tris);
      if (!line) { out.problems.push({ id: l.id, code: "E-SIM-AXIS" }); continue; }
      const a = positiveAxis(line.axis);
      if (l.type === "torque") { out.loads.push({ tris, torque: { p: line.p, axis: a, value: sign * v } }); continue; }
      // a bearing presses across its axis: the part of the force along it is left out
      const d = comp[0] * a[0] + comp[1] * a[1] + comp[2] * a[2], f = comp.map((c, i) => c - d * a[i]);
      if (!(Math.hypot(f[0], f[1], f[2]) > 1e-9 * Math.max(1, Math.hypot(comp[0], comp[1], comp[2])))) { out.problems.push({ id: l.id, code: "E-SIM-BEARING" }); continue; }
      out.loads.push({ tris, bearing: f });
      continue;
    }
    if (l.type === "remote") {
      // carried to the faces as a distributed coupling: the force spread evenly (its resultant sits at the faces' centre)
      // plus the moment that moving it there from the point leaves, as a linear traction
      const c = momentField(tris, [0, 0, 0]).c, at = l.at ?? [0, 0, 0], r = [at[0] - c[0], at[1] - c[1], at[2] - c[2]];
      const m = (l.mom ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v);
      const M = [m[0] + r[1] * comp[2] - r[2] * comp[1], m[1] + r[2] * comp[0] - r[0] * comp[2], m[2] + r[0] * comp[1] - r[1] * comp[0]];
      if (Math.hypot(comp[0], comp[1], comp[2]) > 0) out.loads.push({ tris, force: comp });
      if (Math.hypot(M[0], M[1], M[2]) > 0) out.loads.push({ tris, moment: M });
      continue;
    }
    if (l.type === "hydro") {
      const k = l.axis === "x" ? 0 : l.axis === "y" ? 1 : 2, up = l.flip ? -1 : 1;
      const p = [0, 0, 0], down = [0, 0, 0];
      p[k] = l.level ?? 0; down[k] = -up;
      // kg/m³ → t/mm³, times standard gravity: N/mm³ per mm of depth
      out.loads.push({ tris, hydro: { p, down, gamma: v * 1e-12 * GRAVITY } });
      continue;
    }
    if (l.type === "pressure") out.loads.push({ tris, pressure: sign * v });
    else if (l.type === "moment") out.loads.push({ tris, moment: comp });
    else if (l.normal) out.loads.push({ tris, pressure: (sign * v) / (triArea(tris) || 1) });
    else out.loads.push({ tris, force: comp });
  }
  for (const r of st.refine ?? []) {
    if (off.has(r.id)) continue;
    if (!r.faces.length) { out.problems.push({ id: r.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, r.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: r.id, code: "E-SIM-REF" }); continue; }
    (out.refine ??= []).push({ tris, level: Math.max(1, Math.min(MAX_REFINE, Math.round(r.level) || 1)) });
  }
  for (const c of st.connectors ?? []) {
    if (off.has(c.id)) continue;
    if (!c.faces.length || !c.faces2?.length) { out.problems.push({ id: c.id, code: "E-SIM-EMPTY" }); continue; }
    const a = trisOf(b, c.faces.map(f => f.name)), d = trisOf(b, c.faces2.map(f => f.name));
    if (!a || !d) { out.problems.push({ id: c.id, code: "E-SIM-REF" }); continue; }
    const k = c.k.map(v => Math.max(0, Number(v) || 0));
    if (c.kind === "spring" && !(k[0] + k[1] + k[2] > 0)) { out.problems.push({ id: c.id, code: "E-SIM-SPRING" }); continue; }
    (out.connectors ??= []).push(c.kind === "spring" ? { a, b: d, k, ...(c.kr !== undefined ? { kr: Math.max(0, Number(c.kr) || 0) } : {}) } : { a, b: d });
    (out.connectorIds ??= []).push(c.id);
  }
  for (const m of st.masses ?? []) {
    if (off.has(m.id) || !(m.mass > 0)) continue;
    if (!m.faces.length) { out.problems.push({ id: m.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, m.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: m.id, code: "E-SIM-REF" }); continue; }
    (out.masses ??= []).push({ tris, mass: m.mass * 1e-3 });
  }
  return out;
}

/** A component of a thermal study's results: temperatures on its surface, the heat made in it, how the heat leaves it, W. */
export interface ThermalComp {
  min: number; max: number; mean: number; power: number;
  /** What leaves its own surface (power less what it conducts or radiates to other components). */
  out?: number;
  /** FR-TRES-005, steady solves only: to the air by convection, by radiation (to the surroundings and, net, to other components), to fixed temperatures, net by conduction to its neighbours. */
  conv?: number; rad?: number; held?: number; cond?: number;
}

export interface PassResult {
  pass: number;
  /** Highest degree in use. */
  p: number;
  /** Local passes: how many elements had their degree raised in this pass (absent on whole-body passes). */
  raised?: number;
  dofs: number;
  cells: number;
  /** What the stiffness matrix took, bytes. */
  memory?: number;
  /** The next pass would take more memory than the budget: megabytes it would need. The passes end here (FR-SOL-020). */
  capped?: number;
  /** Strain energy, N·mm. */
  energy: number;
  /** An assembly: the pairs of components found joined (by region index), with the area they share, mm². */
  contacts?: Contact[];
  /** Per bolt of the input, in its order. */
  bolts?: BoltResult[];
  welds?: WeldResult[];
  connectors?: ConnectorResult[];
  /** Change of the energy from the pass before, %, null on the first. */
  change: number | null;
  ms: number;
  reactions: Reaction[];
  applied: Reaction;
  /** Inertia relief: the acceleration the loads give the free part (mm/s², rad/s²), its centre of mass (mm) and mass (t). */
  accel?: { a: number[]; alpha: number[]; com: number[]; mass: number };
  /** At the sample points: displacement (3 each, mm) and von Mises stress (MPa). */
  u: Float32Array;
  vm: Float32Array;
  /** Where this pass still changed the solution: the local estimate at the sample points, % (zeros on the first pass). */
  err: Float32Array;
  /**
   * Error estimates in the energy norm, %, one per pass so far. A pass's error is known from the next one;
   * the last entry is extrapolated from the two before (their ratio holds), or null when there are fewer.
   */
  errors: (number | null)[];
  maxU: number;
  maxVm: number;
  /** The energy change is within the target (or this was the last pass). */
  done: boolean;
  converged: boolean;
  /**
   * Modal studies: the modes, lowest first, and each one's shape at the sample points (3 each, scaled so the
   * largest displacement is 1). `u` is then the first elastic mode's shape, `vm` zeros, `change` the largest
   * change of an elastic frequency from the pass before, %.
   */
  modes?: ModeInfo[];
  shapes?: Float32Array[];
  /** Modal studies: the body's mass, t. */
  mass?: number;
  /** A frequency range was asked for and the most modes allowed were found without passing its end: more may lie in it. */
  more?: boolean;
  /** Bodies with different materials: the body (index into `RunInput.regions`) each sample point is in. */
  dom?: Uint16Array;
  /**
   * Thermal studies: `vm` is then the temperature at the sample points, °C, and `u` the heat flux, W/mm². Lowest and
   * highest temperature, the heat the sources put in and what each surface condition takes away (W, in the order of
   * `ThermalSetup.sinkIds`), and how many solves the pass took (radiation is solved step by step).
   */
  thermal?: {
    min: number; max: number; applied: number; flows: SinkFlow[]; solves: number; /** Solves made again with k at the temperatures found (FR-TMAT-004). */ kSteps?: number; /** Solved with the matrix of the solve before (FR-TSOL-021). */ reused?: boolean; /** Solves made again with air layers' k at the joints' temperatures (FR-TCON-002). */ airSteps?: number;
    /** Assemblies: where the components touch and the heat passing there; each one's temperatures and the heat made in it. */
    contacts?: ThermalContact[];
    /** Radiation between face sets, in the order of `ThermalSetup.exchangeIds`. */
    exchanges?: ExchangeFlow[];
    /** By component: surface temperatures, heat made, and heat leaving its own surface (W; the rest is conducted or radiated to neighbours). */
    comps?: ThermalComp[];
  };
  /**
   * Transient thermal studies, on the last pass: the output times, s, and each one's temperatures at the sample
   * points, °C, with their lowest and highest, the heat put in and what the surfaces take, W, and by component its
   * highest temperature. `steady` = the hottest point of the steady state at full power (null without heat).
   */
  transient?: {
    times: number[]; frames: Float32Array[]; min: number[]; max: number[]; put: number[]; out: number[]; comps?: number[][];
    /** Per output time, each domain's lowest, highest and mean temperature over the plot points (assemblies). */
    cstats?: { min: number; max: number; mean: number }[][];
    steps: number; rejected: number; dt: [number, number]; capacity: number; t0: number; steady: number | null;
  };
}

/** A thermal study on the body's triangles. */
export interface ThermalSetup {
  sinks: ThermalSink[];
  sources: ThermalSource[];
  sinkIds: string[];
  /** Radiation between face sets (FR-TBC-007): the two sets and their emissivities; the view factor is found by the solver's worker. */
  exchanges?: { a: Float64Array; b: Float64Array; ea: number; eb: number }[];
  exchangeIds?: string[];
  problems: { id: string; code: "E-SIM-REF" | "E-SIM-EMPTY" | "E-TH-VALUE" }[];
  /** Package parts whose heatsink share went into a heatsink body (FR-TBRD-003): part id → the heatsink's component and the share, W. */
  heatsinks?: Record<string, { comp: string; w: number }>;
}

/** Area of a triangle soup (9 numbers per triangle), mm². */
/** The triangles of the faces on these components (face names `<comp>@<face>`). */
function compTris(b: SimBody, comps: Set<string>): Float64Array {
  const on = b.names.map(n => comps.has(compOf(n))), keep: number[] = [];
  for (let i = 0; i < b.face.length; i++) if (on[b.face[i]]) for (let k = 0; k < 9; k++) keep.push(b.tris[9 * i + k]);
  return Float64Array.from(keep);
}

function surfaceArea(tris: ArrayLike<number>): number {
  let a = 0;
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    a += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return a;
}

/**
 * Natural convection sizes per triangle of `idx` (FR-TBC-004): its face's height along `down` and area / perimeter,
 * mm (at least 1 mm).
 */
export function faceSizes(b: SimBody, idx: number[], down: ArrayLike<number>): { lv: Float64Array; lh: Float64Array } {
  const face = faceOf(b), by = new Map<number, number[]>();
  for (const t of idx) { let g = by.get(face[t]); if (!g) by.set(face[t], (g = [])); g.push(t); }
  const size = new Map<number, [number, number]>(), q = quantum(b), T = b.tris;
  for (const [f, g] of by) {
    let area = 0, lo = Infinity, hi = -Infinity;
    const edges = new Map<string, number>();
    for (const t of g) {
      const o = 9 * t;
      const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const keys = [vkey(T, o, q), vkey(T, o + 3, q), vkey(T, o + 6, q)];
      for (let k = 0; k < 3; k++) {
        const d = T[o + 3 * k] * down[0] + T[o + 3 * k + 1] * down[1] + T[o + 3 * k + 2] * down[2];
        lo = Math.min(lo, d); hi = Math.max(hi, d);
        const a = keys[k], c = keys[(k + 1) % 3], key = a < c ? `${a}|${c}` : `${c}|${a}`;
        const len = Math.hypot(T[o + 3 * ((k + 1) % 3)] - T[o + 3 * k], T[o + 3 * ((k + 1) % 3) + 1] - T[o + 3 * k + 1], T[o + 3 * ((k + 1) % 3) + 2] - T[o + 3 * k + 2]);
        edges.set(key, edges.has(key) ? -1 : len);
      }
    }
    let per = 0;
    for (const v of edges.values()) if (v > 0) per += v;
    size.set(f, [Math.max(1, hi - lo), Math.max(1, per > 0 ? area / per : Math.sqrt(area))]);
  }
  const lv = new Float64Array(idx.length), lh = new Float64Array(idx.length);
  idx.forEach((t, i) => { const z = size.get(face[t])!; lv[i] = z[0]; lh[i] = z[1]; });
  return { lv, lh };
}

/**
 * Forced air film coefficients per triangle of `idx` (FR-TBC-005), W/(mm²·K): each face's length is its extent along
 * the flow `dir`; a face standing square to the flow (extent under a fifth of √area) takes √area instead.
 */
export function flowFilm(b: SimBody, idx: number[], dir: ArrayLike<number>, speed: number): Float64Array {
  const face = faceOf(b), T = b.tris, n = Math.hypot(dir[0], dir[1], dir[2]) || 1, d = [dir[0] / n, dir[1] / n, dir[2] / n];
  const by = new Map<number, [number, number, number]>();
  for (const t of idx) {
    let z = by.get(face[t]);
    if (!z) by.set(face[t], (z = [Infinity, -Infinity, 0]));
    const o = 9 * t;
    const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    z[2] += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    for (let k = 0; k < 3; k++) { const s = T[o + 3 * k] * d[0] + T[o + 3 * k + 1] * d[1] + T[o + 3 * k + 2] * d[2]; z[0] = Math.min(z[0], s); z[1] = Math.max(z[1], s); }
  }
  const hOf = new Map<number, number>();
  for (const [f, z] of by) { const ext = z[1] - z[0], root = Math.sqrt(z[2]); hOf.set(f, forcedH(speed, ext < 0.2 * root ? root : ext)); }
  return Float64Array.from(idx, t => hOf.get(face[t])!);
}

/** The surface conditions and heat sources of a thermal study (FR-TLOAD, FR-TBC): W/m² and W/(m²·K) become per mm². */
export function thermalSetup(st: Study, b: SimBody, regions?: string[]): ThermalSetup {
  const off = new Set(st.suppressed ?? []), amb = st.settings.ambient ?? DEFAULT_AMBIENT;
  const out: ThermalSetup = { sinks: [], sources: [], sinkIds: [], problems: [] };
  const idxOf = (it: { id: string; faces: { name: string }[] }) => {
    if (!it.faces.length) { out.problems.push({ id: it.id, code: "E-SIM-EMPTY" }); return null; }
    const want = new Set<number>(), face = faceOf(b);
    for (const f of it.faces) { const i = b.names.indexOf(f.name); if (i < 0) { out.problems.push({ id: it.id, code: "E-SIM-REF" }); return null; } want.add(i); }
    const idx: number[] = [];
    for (let t = 0; t < face.length; t++) if (want.has(face[t])) idx.push(t);
    return idx;
  };
  // "all open surfaces": the whole surface without the faces a fixed temperature, a chassis wall, an insulated item or another item of its kind is on
  const openIdx = (s: Study["supports"][number]) => {
    const taken = new Set<string>();
    for (const o of st.supports) if (o !== s && !off.has(o.id) && !o.all && (o.type === "temp" || o.type === "chassis" || o.type === "insul" || o.type === s.type)) for (const f of o.faces) taken.add(f.name);
    const gone = b.names.map(n => taken.has(n)), keep: number[] = [];
    for (let i = 0; i < b.face.length; i++) if (!gone[b.face[i]]) keep.push(i);
    return keep;
  };
  // the same triangles give the same array, so items on one set of faces (convection and radiation from all open surfaces) share their points in the solver
  const gathered: { idx: number[]; tris: Float64Array }[] = [];
  const gather = (idx: number[]) => {
    const had = gathered.find(g => g.idx.length === idx.length && g.idx.every((t, k) => t === idx[k]));
    if (had) return had.tris;
    const tris = new Float64Array(9 * idx.length);
    idx.forEach((t, k) => { for (let j = 0; j < 9; j++) tris[9 * k + j] = b.tris[9 * t + j]; });
    gathered.push({ idx, tris });
    return tris;
  };
  const facesOf = (it: { id: string; faces: { name: string }[] }) => { const idx = idxOf(it); return idx ? gather(idx) : null; };
  const down = st.settings.down ?? [0, 0, -1], factor = enclosureFactor(st.settings);
  // chassis walls (FR-TBC-009): where a board package's chassis shares go when its split is kept
  const walls: { tris: Float64Array; area: number }[] = [];
  for (const s of st.supports) {
    if (off.has(s.id) || !isThermalType(s.type)) continue;
    // insulated faces (FR-TBC-002) carry no condition: they only keep "all open surfaces" items off
    if (s.type === "insul") { idxOf(s); continue; }
    if (s.type === "radx") {
      // radiation between two face sets: both picked, emissivities in (0, 1]
      const ia = idxOf(s), ib = ia ? idxOf({ id: s.id, faces: s.faces2 ?? [] }) : null;
      if (!ia || !ib) continue;
      const ea = s.emis ?? 0.9, eb = s.emis2 ?? ea;
      if (!(ea > 0 && ea <= 1 && eb > 0 && eb <= 1)) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
      (out.exchanges ??= []).push({ a: gather(ia), b: gather(ib), ea, eb });
      (out.exchangeIds ??= []).push(s.id);
      continue;
    }
    const open = !!s.all && s.type !== "temp";
    const idx = open ? openIdx(s) : idxOf(s);
    if (!idx) continue;
    const tris = gather(idx);
    const free = open && regions ? { free: true } : {};
    if (s.type === "temp") out.sinks.push({ tris, temp: s.temp ?? amb });
    else if (s.type === "chassis") {
      // a chassis wall: held at a temperature, or passing its heat to ambient through a resistance
      const area = surfaceArea(tris);
      if (s.rth !== undefined) {
        if (!(s.rth > 0) || !(area > 0)) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
        out.sinks.push({ tris, h: 1 / (s.rth * area), ambient: s.ambient ?? amb });
      } else out.sinks.push({ tris, temp: s.temp ?? amb });
      if (area > 0) walls.push({ tris, area });
    } else if (s.type === "conv") {
      if (s.rth !== undefined && !open) {
        // a heatsink by its resistance: the film coefficient that gives 1 / Rth over the picked faces
        const area = surfaceArea(tris);
        if (!(s.rth > 0) || !(area > 0)) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
        out.sinks.push({ tris, h: 1 / (s.rth * area), ambient: s.ambient ?? amb });
        out.sinkIds.push(s.id);
        continue;
      }
      if (s.natural) {
        out.sinks.push({ tris, natural: { factor, down, ...faceSizes(b, idx, down) }, ambient: s.ambient ?? amb, ...free });
        out.sinkIds.push(s.id);
        continue;
      }
      if (s.forced) {
        const v = s.forced.fan ? fanSpeed(s.forced.fan.q, s.forced.fan.a) : s.forced.speed;
        if (!(v > 0) || !Number.isFinite(v)) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
        out.sinks.push({ tris, forced: { h: flowFilm(b, idx, s.forced.dir, v) }, ambient: s.ambient ?? amb, ...free });
        out.sinkIds.push(s.id);
        continue;
      }
      if (!((s.h ?? 0) > 0)) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
      out.sinks.push({ tris, h: s.h! * 1e-6, ambient: s.ambient ?? amb, ...free });
    } else {
      if (!((s.emis ?? 0) > 0) || s.emis! > 1) { out.problems.push({ id: s.id, code: "E-TH-VALUE" }); continue; }
      out.sinks.push({ tris, emissivity: s.emis, ambient: s.ambient ?? amb, ...free });
    }
    out.sinkIds.push(s.id);
  }
  for (const l of st.loads) {
    if (off.has(l.id) || !isThermalType(l.type)) continue;
    const v = l.value?.v ?? 0;
    if (l.type === "pkgheat") {
      // a board's package: each part's power is made throughout the components its bodies became; with the
      // package's split (always kept with a board), its board share enters the board under the part and a chassis share leaves the model
      let any = false;
      const boardDom = l.board ? (regions ?? []).findIndex(k => compOf(k) === l.board) : -1;
      const boardTris = keepsSplit(l) && boardDom >= 0 ? compTris(b, new Set([l.board!])) : null;
      // heatsink candidates: components that are neither the board nor a part making heat
      const makers = new Set((l.parts ?? []).filter(x => x.p >= PACKAGE_MIN_POWER).flatMap(x => x.comps));
      const cands = [...new Set((regions ?? []).map(k => compOf(k)))].filter(c => c !== l.board && !makers.has(c));
      const candTris = new Map<string, Float64Array>();
      const sinkFor = (comps: Set<string>) => {
        const mine = compTris(b, comps);
        let best: { comp: string; patch: Float64Array; dom: number; area: number } | null = null;
        for (const c of cands) {
          let ct = candTris.get(c);
          if (!ct) candTris.set(c, ct = compTris(b, new Set([c])));
          const patch = facingPatch(ct, mine), area = patch ? surfaceArea(patch) : 0;
          if (patch && area > (best?.area ?? 0)) best = { comp: c, patch, dom: (regions ?? []).findIndex(k => compOf(k) === c), area };
        }
        return best;
      };
      for (const part of l.parts ?? []) {
        if (part.off || !(part.p >= PACKAGE_MIN_POWER)) continue;
        const comps = new Set(part.comps), doms: number[] = [];
        (regions ?? []).forEach((k, i) => { if (comps.has(compOf(k))) doms.push(i); });
        if (!doms.length) continue;
        let own = part.p;
        if (boardTris) {
          const share = Math.min(own, Math.max(0, part.board ?? 0)), partTris = share > 0 ? compTris(b, comps) : null;
          // through the pads and the air gap under the body when the package says where (`into`), each region's
          // watts scaled to the share; what lands off the board goes in under the whole part as before
          let rest = share;
          const into = (part.into ?? []).filter(x => x.w > 0), sum = into.reduce((a, x) => a + x.w, 0);
          if (partTris && sum > 0) for (const x of into) {
            const patch = intoPatch(boardTris, partTris, x);
            if (patch) { const w = (share * x.w) / sum; out.sources.push({ tris: patch, power: w, dom: boardDom, id: l.id, fine: PAD_FINE }); rest -= w; }
          }
          const patch = partTris && rest > 1e-12 ? contactPatch(boardTris, partTris) : null;
          if (patch) { out.sources.push({ tris: patch, power: rest, dom: boardDom, id: l.id, fine: PAD_FINE }); rest = 0; }
          own -= share - rest;
          if (part.path === "heatsink") {
            // the heatsink share enters the body the part sits on that makes no heat itself, where it touches the part
            const w = Math.min(own, Math.max(0, part.sink ?? 0));
            const hs = w > 0 ? sinkFor(comps) : null;
            if (hs) { out.sources.push({ tris: hs.patch, power: w, dom: hs.dom, id: l.id, fine: PAD_FINE }); own -= w; (out.heatsinks ??= {})[part.id] = { comp: hs.comp, w }; }
          }
          if (part.path === "chassis") {
            // the chassis share leaves through the chassis walls, shared by area; with none it leaves the model
            const share = Math.min(own, Math.max(0, part.sink ?? 0)), total = walls.reduce((a, w) => a + w.area, 0);
            if (share > 0 && total > 0) for (const w of walls) out.sources.push({ tris: w.tris, power: (share * w.area) / total, id: l.id });
            own -= share;
          }
        }
        if (own > 0) out.sources.push({ power: own, doms, id: l.id });
        any = true;
      }
      if (!any) out.problems.push({ id: l.id, code: "E-SIM-EMPTY" });
      continue;
    }
    if (l.type === "heat" && l.body && regions) {
      // an assembly: the heat is made throughout the components the picked faces are on
      if (!l.faces.length) { out.problems.push({ id: l.id, code: "E-SIM-EMPTY" }); continue; }
      const comps = new Set(l.faces.map(f => compOf(f.name))), doms: number[] = [];
      regions.forEach((k, i) => { if (comps.has(compOf(k))) doms.push(i); });
      if (!doms.length) { out.problems.push({ id: l.id, code: "E-SIM-REF" }); continue; }
      if (l.each) for (const c of comps) {
        // per item: every component makes the whole value
        const own = doms.filter(i => compOf(regions[i]) === c);
        if (own.length) out.sources.push({ power: v, doms: own, id: l.id });
      }
      else out.sources.push({ power: v, doms, id: l.id });
      continue;
    }
    if (l.type === "heat" && l.body) { out.sources.push({ power: v, id: l.id }); continue; }
    if (l.type === "vheat") {
      // W/m³ throughout the part, or in an assembly throughout the components the picked faces are on
      const density = v * 1e-9;
      if (!regions) { out.sources.push({ density, id: l.id }); continue; }
      if (!l.faces.length) { out.problems.push({ id: l.id, code: "E-SIM-EMPTY" }); continue; }
      const comps = new Set(l.faces.map(f => compOf(f.name))), doms: number[] = [];
      regions.forEach((k, i) => { if (comps.has(compOf(k))) doms.push(i); });
      if (!doms.length) { out.problems.push({ id: l.id, code: "E-SIM-REF" }); continue; }
      out.sources.push({ density, doms, id: l.id });
      continue;
    }
    if (l.type === "heat" && l.each && l.faces.length > 1) {
      // per item: every picked face takes the whole value
      const idx = idxOf(l);
      if (!idx) continue;
      const face = faceOf(b);
      for (const f of new Set(l.faces.map(x => x.name))) {
        const i = b.names.indexOf(f), mine = idx.filter(t => face[t] === i);
        if (mine.length) out.sources.push({ tris: gather(mine), power: v, id: l.id });
      }
      continue;
    }
    const tris = facesOf(l);
    if (!tris) continue;
    out.sources.push(l.type === "heat" ? { tris, power: v, id: l.id } : { tris, flux: v * 1e-6, id: l.id });
  }
  return out;
}

export interface ModeInfo {
  hz: number;
  /** A motion of the whole body without strain. */
  rigid: boolean;
  /** Effective mass along X, Y, Z as shares of the body's mass. */
  eff: [number, number, number];
}

export interface RunInput {
  body: SimBody;
  mat: SimMaterial;
  /**
   * The part's bodies, each with its own closed surface (wound outwards) and material. Used when their
   * materials differ: every body then keeps its own stiffness and density, joined to the others where they
   * touch. `body` stays the whole part (its faces are what supports and loads name), `mat` is not used then.
   */
  regions?: { tris: Float64Array; mat: SimMaterial; rigid?: boolean }[];
  /**
   * An assembly: `regions` are its components, each solved as its own body whatever its material and joined to
   * the others where they touch or come within `gap` mm (bonded unless `links` says otherwise, by region index).
   */
  asm?: { gap: number; links?: { a: number; b: number; type: "sliding" | "none" | "adhesive"; kn?: number; kt?: number }[] };
  /** Bolts between the regions (FR-CON-020): beams between two patches of their surfaces. */
  bolts?: Bolt[];
  /** Welds along edges where two components meet (FR-CON-022). */
  welds?: Weld[];
  problem: StudyProblem;
  passes: number;
  /** Energy change target, %. */
  energyTol: number;
  /** The memory budget, bytes (default `MEMORY_LIMIT`). */
  memory?: number;
  /** Where results are wanted: positions and outward normals (3 each). */
  pos: Float32Array;
  nrm: Float32Array;
  /** Cells aimed for (default 150). */
  cells?: number;
  /** A thermal study: conductivity W/(mm·K) and its set-up. `mat`, `problem` and the structural parts are not used. */
  /**
   * Assemblies: `ks` = each region's conductivity (the regions are then solved as bodies joined where they
   * touch, within `gap`, as `links` say).
   */
  /**
   * Thermal expansion: the material's α, 1/K, and for a temperature load from a thermal study, that study's
   * run input (solved here first; its last pass gives the temperatures).
   */
  temp?: { alpha: number; /** Per region (assemblies, bodies of their own material): α, 1/K; 0 for a rigid one. */ alphas?: number[]; thermal?: RunInput };
  thermal?: { k: number; setup: ThermalSetup; ks?: number[]; /** Per region: conductivity along X, Y, Z when they differ (a board), else null. */ k3s?: (number[] | null)[]; gap?: number; links?: ThermalLink[];
    /** A part's conductivity along X, Y, Z when it differs by direction (FR-TMAT-003), W/(mm·K). */
    k3?: number[];
    /** Per region: a board's conductivity varying over it, from its copper (FR-TBRD-020), else null. */
    kmaps?: (KMap | null)[];
    /** Conductivity changing with temperature (FR-TMAT-004): [°C, factor on k, …] for the part (`kt`) or per region (`kts`, null = constant). */
    kt?: number[]; kts?: (number[] | null)[];
    /**
     * A transient study (FR-TSOL-006): volumetric heat capacity ρ·cp, J/(mm³·K) (`rcs` per region), start
     * temperature °C, end time and output interval s, and the power profile of each heat load by its id.
     */
    transient?: { rc: number; rcs?: number[]; t0: number; end: number; out: number; profiles: Record<string, PowerProfile> };
  };
  /** A modal study: this many modes; loads are not used. */
  modal?: {
    count: number;
    /** Only the modes from `range[0]` to `range[1]` Hz: modes are found from the lowest up, `count` at first and then twice as many, until one lies above the range or there are `max`. */
    range?: [number, number];
    max?: number;
  };
}

/** Volume of a closed, outward-wound triangle mesh. */
export function meshVolume(t: ArrayLike<number>): number {
  let v = 0;
  for (let o = 0; o < t.length; o += 9)
    v += (t[o] * (t[o + 4] * t[o + 8] - t[o + 5] * t[o + 7]) - t[o + 1] * (t[o + 3] * t[o + 8] - t[o + 5] * t[o + 6]) + t[o + 2] * (t[o + 3] * t[o + 7] - t[o + 4] * t[o + 6])) / 6;
  return v;
}

/** Cell size for a body: about `cells` cells of material, never larger than the box's middle dimension. */
export function cellSize(b: SimBody, cells = 150): number {
  const d = [0, 1, 2].map(a => b.hi[a] - b.lo[a]).sort((x, y) => x - y);
  const vol = Math.abs(meshVolume(b.tris)) || d[0] * d[1] * d[2];
  const h = Math.min(Math.cbrt(vol / cells), Math.max(d[1], d[2] / 8));
  // a size that divides the smallest dimension lets flat-sided parts fill whole cells
  const fit = d[0] / Math.max(1, Math.round(d[0] / h));
  return fit > 0.7 * h && fit < 1.4 * h ? fit : h;
}

/**
 * The error of the pass after the ones whose errors are known: they fall by a steady ratio, so the next is
 * e·(e / before), never more than e. Null with fewer than two.
 */
export function passError(known: number[]): number | null {
  const n = known.length;
  if (n < 2) return null;
  const e = known[n - 1], b = known[n - 2];
  return b > 0 ? e * Math.min(1, e / b) : 0;
}

/**
 * Cell size of a thermal study of several bodies: a hot part on a thin board makes a kink in the temperature along its
 * footprint, which cells sized by the whole assembly (a chassis plate under it) resolve poorly
 * (docs/thermal-validation.md). The cells are made no larger than three times the thinnest body's thickness, but not
 * smaller than `THERMAL_MAX_CELLS` cells of material give.
 */
export const THERMAL_MAX_CELLS = 400;
/**
 * With heat entering a board through a part's pads (`ThermalSource.fine`) the cells are sized by the thinnest body's
 * thickness itself, up to this many cells: against CalculiX (docs/thermal-validation.md, case "pads") cells of half
 * the size took the hottest parts from 2.6 % cool to within 0.4 %.
 */
export const THERMAL_PAD_CELLS = 1500;
export function thermalCellSize(body: SimBody, regions: ArrayLike<number>[], pads = false): number {
  const h0 = cellSize(body), floor = cellSize(body, pads ? THERMAL_PAD_CELLS : THERMAL_MAX_CELLS), m = pads ? 1 : 3, most = pads ? THERMAL_PAD_CELLS : THERMAL_MAX_CELLS;
  let t = Infinity;
  for (const tris of regions) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i++) { const a = i % 3; if (tris[i] < lo[a]) lo[a] = tris[i]; if (tris[i] > hi[a]) hi[a] = tris[i]; }
    t = Math.min(t, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  }
  if (!(t > 0) || m * t >= h0) return h0;
  const vol = Math.abs(meshVolume(body.tris));
  return vol > 0 ? Math.max(floor, cellSize(body, Math.min(most, vol / (m * t) ** 3))) : h0;
}

/** Whole-body passes (degree 2, 3, 4), then local ones up to this many passes and this degree. */
export const GLOBAL_PASSES = 3, MAX_PASSES = 6, LOCAL_DEGREE = 6;

/**
 * Elements to refine next: the fewest that hold `share` of the error indicator among those still below
 * `pmax`, largest first.
 */
export function markElements(ind: ArrayLike<number>, deg: ArrayLike<number>, share = 0.6, pmax = LOCAL_DEGREE): number[] {
  const open: number[] = [];
  let total = 0;
  for (let e = 0; e < ind.length; e++) if (deg[e] < pmax && ind[e] > 0) { open.push(e); total += ind[e]; }
  open.sort((a, b) => ind[b] - ind[a]);
  const out: number[] = [];
  let sum = 0;
  for (const e of open) {
    if (sum >= share * total) break;
    out.push(e); sum += ind[e];
  }
  return out;
}

/** Local accuracy: how many degrees higher each element of the grid starts, from the triangles it holds. */
export function boostOf(grid: Grid, refine: { tris: ArrayLike<number>; level: number }[]): Int8Array {
  const out = new Int8Array(grid.elems.length);
  for (const r of refine) {
    const { pts, tri } = gridTrianglePoints(r.tris, grid.lo, grid.h, 2);
    const nrm = triNormals(r.tris), eps = 1e-7 * grid.h;
    for (let k = 0; k < pts.n; k++) {
      const o = 4 * k, t = tri[k];
      const c = grid.cellOf(pts.a[o] - eps * nrm[3 * t], pts.a[o + 1] - eps * nrm[3 * t + 1], pts.a[o + 2] - eps * nrm[3 * t + 2]);
      if (c >= 0) { const e = grid.cells[c].el; if (out[e] < r.level) out[e] = r.level; }
    }
  }
  return out;
}

/**
 * The envelope of several load cases' results on the same sample points (FR-LOAD-022): at each point the highest
 * von Mises stress and error estimate, and the displacement of the case that moves the point most.
 */
export function envelope(cases: PassResult[]): PassResult {
  const first = cases[0], n = first.vm.length;
  const u = Float32Array.from(first.u), vm = Float32Array.from(first.vm), err = Float32Array.from(first.err);
  for (const c of cases.slice(1)) {
    for (let i = 0; i < n; i++) {
      if (c.vm[i] > vm[i]) vm[i] = c.vm[i];
      if (c.err[i] > err[i]) err[i] = c.err[i];
      const a = Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]), b = Math.hypot(c.u[3 * i], c.u[3 * i + 1], c.u[3 * i + 2]);
      if (b > a) { u[3 * i] = c.u[3 * i]; u[3 * i + 1] = c.u[3 * i + 1]; u[3 * i + 2] = c.u[3 * i + 2]; }
    }
  }
  const top = (f: (p: PassResult) => number) => Math.max(...cases.map(f));
  const errors = first.errors.map((_e, i) => { const v = cases.map(c => c.errors[i]).filter((x): x is number => x != null); return v.length ? Math.max(...v) : null; });
  // thermal power cases (FR-TSTU-005): the hottest and coolest of any case, and each component's hottest; flows belong to one case
  const T = first.thermal ? cases.map(c => c.thermal!) : null;
  const thermal = T ? {
    min: Math.min(...T.map(x => x.min)), max: Math.max(...T.map(x => x.max)), applied: Math.max(...T.map(x => x.applied)), flows: [], solves: Math.max(...T.map(x => x.solves)),
    ...(T[0].comps ? { comps: T[0].comps.map((_c, i) => ({ min: Math.min(...T.map(x => x.comps?.[i]?.min ?? Infinity)), max: Math.max(...T.map(x => x.comps?.[i]?.max ?? -Infinity)), mean: Math.max(...T.map(x => x.comps?.[i]?.mean ?? -Infinity)), power: Math.max(...T.map(x => x.comps?.[i]?.power ?? 0)) })) } : {}),
  } : undefined;
  return {
    ...first, u, vm, err, errors, maxU: top(c => c.maxU), maxVm: top(c => c.maxVm), dofs: top(c => c.dofs), ms: cases.reduce((s, c) => s + c.ms, 0),
    energy: top(c => c.energy), change: null, reactions: [], applied: { force: [0, 0, 0], moment: [0, 0, 0] }, converged: cases.every(c => c.converged), done: true,
    ...(thermal ? { thermal } : {}),
  };
}

/** Reads a solution anywhere in the body: what the worker keeps of the last pass (FR-RES-030). */
export type Sampler = (pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean) => { u: Float32Array; vm: Float32Array; err: Float32Array; hit?: Uint8Array; dom?: Uint16Array };

/** The solver's domains for bodies whose materials differ; undefined when one material serves the whole part. */
export function domainsOf(inp: RunInput) {
  const R = inp.regions;
  if (!R || R.length < 2) return undefined;
  const a = R[0].mat;
  if (!inp.asm && R.every(r => r.mat.E === a.E && r.mat.nu === a.nu && r.mat.rho === a.rho)) return undefined;
  return R.map(r => ({ inside: insideOf(new MeshBody(r.tris)), mat: { E: r.mat.E, nu: r.mat.nu, rho: r.mat.rho }, tris: r.tris, ...(r.rigid ? { rigid: true } : {}) }));
}
/** `solid` (asked for): 1 where the point is inside the body itself, not only in one of its cells. */
export interface SampleResult { u: Float32Array; vm: Float32Array; err: Float32Array; hit: Uint8Array; solid?: Uint8Array }

/**
 * The solution at points of the body as drawn: with `scale` > 0 the points are places on the deformed shape
 * (x + scale·u(x)), and the place x each came from is found first, by a few fixed-point steps.
 */
export function sampleAt(sample: Sampler, pos: ArrayLike<number>, scale = 0, inside?: (x: number, y: number, z: number) => boolean): SampleResult {
  let at: ArrayLike<number> = pos;
  if (scale > 0) {
    const x = Float64Array.from(pos);
    for (let k = 0; k < 4; k++) {
      const u = sample(x).u;
      for (let i = 0; i < x.length; i++) x[i] = pos[i] - scale * u[i];
    }
    at = x;
  }
  const r = sample(at, undefined, true);
  if (!inside) return { u: r.u, vm: r.vm, err: r.err, hit: r.hit! };
  const n = at.length / 3, solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = r.hit![i] && inside(at[3 * i], at[3 * i + 1], at[3 * i + 2]) ? 1 : 0;
  return { u: r.u, vm: r.vm, err: r.err, hit: r.hit!, solid };
}

/**
 * The passes of a static study on the same cells, until the energy settles: degree 2, 3, 4 everywhere,
 * then local passes that raise the degree by one only in the elements holding most of the error estimate.
 * `keep` gets each pass's solution, to be read later at other points.
 */
/**
 * The temperatures of a temperature load: uniform, or the last pass of the thermal study in `inp.temp.thermal`
 * (solved here; the gradient is −flux / k). A point the thermal solution has no cell for takes the nearest
 * value found a little further in, else the mean.
 */
export function tempField(inp: RunInput): TempField {
  const th = inp.problem.thermo!;
  if (!inp.temp || !(inp.temp.alpha > 0 || inp.temp.alphas?.some(a => a > 0))) throw new Error("E-TH-ALPHA");
  if (th.uniform != null) { const u = th.uniform; return pts => ({ t: new Float64Array(pts.length / 3).fill(u) }); }
  const ti = inp.temp.thermal;
  if (!ti?.thermal) throw new Error("E-TH-NOFIELD");
  let sampler: Sampler | null = null, last: PassResult | undefined;
  for (const p of runThermal(ti, s => { sampler = s; })) last = p;
  if (!sampler || !last) throw new Error("E-TH-NOFIELD");
  const s: Sampler = sampler, TT = ti.thermal, mean = (last.thermal!.min + last.thermal!.max) / 2;
  const c = [(inp.body.lo[0] + inp.body.hi[0]) / 2, (inp.body.lo[1] + inp.body.hi[1]) / 2, (inp.body.lo[2] + inp.body.hi[2]) / 2];
  return (pts, grad) => {
    const n = pts.length / 3, r = s(pts, undefined, true), t = Float64Array.from(r.vm), g = grad ? new Float64Array(3 * n) : undefined;
    const miss: number[] = [];
    for (let i = 0; i < n; i++) if (!r.hit?.[i] || !Number.isFinite(t[i])) miss.push(i);
    if (miss.length) {
      // a little towards the middle of the body
      const q = new Float64Array(3 * miss.length);
      miss.forEach((i, j) => { for (let a = 0; a < 3; a++) q[3 * j + a] = pts[3 * i + a] + 1e-4 * (c[a] - pts[3 * i + a]); });
      const r2 = s(q, undefined, true);
      miss.forEach((i, j) => { t[i] = r2.hit?.[j] ? r2.vm[j] : mean; if (g) for (let a = 0; a < 3; a++) r.u[3 * i + a] = r2.hit?.[j] ? r2.u[3 * j + a] : 0; });
    }
    // ∇T = −flux / k, with the body's own conductivity (by direction for a board, at the temperature when it changes)
    if (g) for (let i = 0; i < n; i++) {
      const d = r.dom?.[i] ?? 0, km = TT.kmaps?.[d], kt = TT.kts ? TT.kts[d] : TT.kt, m = kt ? ktFactor(kt, t[i]) : 1, k = TT.ks?.[d] ?? TT.k;
      const k3 = km ? (([al, th]) => [0, 1, 2].map(a => (a === km.axis ? th : al)))(kmapMean(km, [pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]], 0)) : TT.k3s?.[d] ?? TT.k3;
      for (let a = 0; a < 3; a++) g[3 * i + a] = -r.u[3 * i + a] / ((k3 ? k3[a] : k) * m);
    }
    return { t, g };
  };
}

export function* runStatic(inp: RunInput, keep?: (s: Sampler, inside: (x: number, y: number, z: number) => boolean) => void): Generator<PassResult> {
  if (inp.problem.problems.length) throw new Error(`${inp.problem.problems[0].code}: ${inp.problem.problems[0].id}`);
  const field = inp.problem.thermo ? tempField(inp) : undefined;
  if (!inp.problem.loads.length && !inp.problem.thermo && !inp.problem.gravity && !inp.problem.spin?.omega && !inp.problem.spin?.alpha && !inp.problem.fixed.some(s => s.value) && !inp.bolts?.some(b => (b.preload ?? 0) > 0)) throw new Error("E-SIM-NOLOAD");
  if (!inp.problem.fixed.length && !inp.problem.relief) throw new Error("E-SIM-FREE: 6");
  const domains = domainsOf(inp);
  if (inp.problem.relief && !(domains ? domains.every(d => d.mat.rho > 0) : inp.mat.rho > 0)) throw new Error("E-SIM-DENSITY");
  const body = new MeshBody(inp.body.tris);
  const inside = insideOf(body);
  const h = cellSize(inp.body, inp.cells);
  const passes = Math.max(1, Math.min(MAX_PASSES, Math.round(inp.passes)));
  let grid: Grid | undefined, last = 0, prev: Float64Array | undefined;
  const known: number[] = [];
  // local passes: each element's degree, and its share of the error when its degree was last raised
  let degrees: Int8Array | undefined, ind: Float64Array | undefined;
  // local accuracy asked for by the user: those elements run ahead of the others from the first pass on
  let boost: Int8Array | undefined;
  if (inp.problem.refine?.length) {
    grid = makeGrid(inp.body.lo, inp.body.hi, h, inside, { q: 3, depth: 3, fit: 5, domains: domains?.map(d => d.inside), rigid: domains?.map(d => !!d.rigid) });
    boost = boostOf(grid, inp.problem.refine);
    if (!boost.some(v => v > 0)) boost = undefined;
  }
  for (let k = 0; k < passes; k++) {
    progressPass(k + 1, passes);
    const t0 = Date.now();
    let p = k + 2, raised: number | undefined, marked: number[] = [];
    if (boost && k < GLOBAL_PASSES) {
      degrees = new Int8Array(boost.length);
      for (let e = 0; e < boost.length; e++) { degrees[e] = Math.min(LOCAL_DEGREE, k + 2 + boost[e]); p = Math.max(p, degrees[e]); }
    }
    if (k >= GLOBAL_PASSES && grid && ind) {
      degrees ??= new Int8Array(grid.elems.length).fill(GLOBAL_PASSES + 1);
      marked = markElements(ind, degrees);
      if (!marked.length) return;
      for (const e of marked) degrees[e]++;
      raised = marked.length;
      p = 0;
      for (let e = 0; e < degrees.length; e++) p = Math.max(p, degrees[e]);
    }
    const r = solveStatic({
      lo: inp.body.lo, hi: inp.body.hi, inside, h, p, grid, prev, degrees, domains, gap: inp.asm?.gap, links: inp.asm?.links, bolts: inp.bolts, welds: inp.welds, connectors: inp.problem.connectors, masses: inp.problem.masses,
      mat: { E: inp.mat.E, nu: inp.mat.nu, rho: inp.mat.rho },
      fixed: inp.problem.fixed, loads: inp.problem.loads, gravity: inp.problem.gravity, spin: inp.problem.spin, relief: inp.problem.relief, memory: inp.memory,
      ...(field ? { thermo: { alpha: inp.temp!.alpha, ...(domains && inp.temp!.alphas ? { alphas: inp.temp!.alphas } : {}), ref: inp.problem.thermo!.ref, field, tris: inp.problem.thermo!.tris } } : {}),
    });
    grid = r.grid;
    prev = r.x;
    if (!ind || !degrees || k < GLOBAL_PASSES) ind = Float64Array.from(r.eta);
    else for (const e of marked) ind[e] = r.eta[e];
    if (r.prevError != null) known.push(r.prevError);
    const errors: (number | null)[] = [...known, passError(known)];
    keep?.(r.sample, inside);
    progress("results", 0, 1);
    const { u, vm, err, dom } = r.sample(inp.pos, inp.nrm);
    let maxU = 0, maxVm = 0;
    for (let i = 0; i < vm.length; i++) {
      maxVm = Math.max(maxVm, vm[i]);
      maxU = Math.max(maxU, Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]));
    }
    const change = k ? (Math.abs(r.energy - last) / Math.abs(r.energy || 1)) * 100 : null;
    last = r.energy;
    const converged = change != null && change <= inp.energyTol;
    // what the next pass would take: over the budget, the passes end with this one
    let capped = 0;
    if (!converged && k + 1 < passes) {
      let need = 0;
      if (k + 1 < GLOBAL_PASSES) {
        const d = boost ? Int8Array.from(boost, b => Math.min(LOCAL_DEGREE, k + 3 + b)) : null;
        need = staticMemory(r.grid, d ? d.reduce((a, v) => Math.max(a, v), 0) : k + 3, d);
      } else {
        const d = degrees ? Int8Array.from(degrees) : new Int8Array(ind.length).fill(GLOBAL_PASSES + 1);
        const mk = markElements(ind, d);
        for (const e of mk) d[e]++;
        if (mk.length) need = staticMemory(r.grid, d.reduce((a, v) => Math.max(a, v), 0), d);
      }
      if (need > (inp.memory ?? MEMORY_LIMIT)) capped = Math.ceil(need / 2 ** 20);
    }
    yield { pass: k + 1, p, raised, dofs: r.dofs, cells: r.grid.elems.length, memory: r.memory, ...(capped ? { capped } : {}), energy: r.energy, change, ms: Date.now() - t0, reactions: r.reactions, applied: r.applied, ...(r.accel ? { accel: r.accel } : {}), ...(dom ? { dom } : {}), ...(r.contacts ? { contacts: r.contacts } : {}), ...(r.bolts ? { bolts: r.bolts } : {}), ...(r.welds ? { welds: r.welds } : {}), ...(r.connectors ? { connectors: r.connectors } : {}), u, vm, err, errors, maxU, maxVm, converged, done: converged || capped > 0 || k === passes - 1 || (k >= GLOBAL_PASSES - 1 && k < passes - 1 && !markElements(ind, degrees ?? new Int8Array(ind.length).fill(GLOBAL_PASSES + 1)).length) };
    if (converged || capped) return;
  }
}

/**
 * The passes of a modal study (FR-RES-020..022): degree 2, 3, 4 on the same cells, each starting from the
 * modes of the one before, until the elastic frequencies settle within `energyTol` %.
 */
export function* runModal(inp: RunInput): Generator<PassResult> {
  if (inp.problem.problems.length) throw new Error(`${inp.problem.problems[0].code}: ${inp.problem.problems[0].id}`);
  const domains = domainsOf(inp);
  if (!(domains ? domains.every(d => d.mat.rho > 0) : inp.mat.rho > 0)) throw new Error("E-SIM-DENSITY");
  const body = new MeshBody(inp.body.tris);
  const inside = insideOf(body);
  const h = cellSize(inp.body, inp.cells);
  const passes = Math.max(1, Math.min(GLOBAL_PASSES, Math.round(inp.passes)));
  let count = Math.max(1, Math.round(inp.modal?.count ?? 6));
  const range = inp.modal?.range, most = Math.max(count, Math.round(inp.modal?.max ?? count));
  let grid: Grid | undefined, start: Float64Array[] | undefined, before: number[] | null = null;
  const none: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  for (let k = 0; k < passes; k++) {
    progressPass(k + 1, passes);
    const t0 = Date.now(), p = k + 2;
    const solve = () => solveStatic({
      lo: inp.body.lo, hi: inp.body.hi, inside, h, p, grid, domains, gap: inp.asm?.gap, links: inp.asm?.links, bolts: inp.bolts, welds: inp.welds, connectors: inp.problem.connectors, masses: inp.problem.masses,
      mat: { E: inp.mat.E, nu: inp.mat.nu, rho: inp.mat.rho },
      fixed: inp.problem.fixed, loads: [], modal: { count, start }, memory: inp.memory,
    });
    let r = solve();
    grid = r.grid; start = r.space;
    // a frequency range: more modes until one lies above it (the count then stays for the later passes)
    while (range && count < most && (r.modes ?? []).length >= count && !(r.modes ?? []).some(m => m.hz > range[1])) {
      count = Math.min(most, count * 2);
      r = solve();
      start = r.space;
    }
    const found = r.modes ?? [];
    const more = !!range && found.length >= count && !found.some(m => m.hz > range[1]);
    const keep = found.map(m => !range || (m.rigid ? range[0] <= 0 : m.hz >= range[0] && m.hz <= range[1]));
    const shapes: Float32Array[] = [];
    found.forEach((_m, i) => {
      r.use!(i);
      const u = r.sample(inp.pos, inp.nrm).u;
      // largest displacement 1, and its largest component positive, so a mode looks the same in every pass
      let top = 0, at = 0;
      for (let j = 0; j < u.length; j += 3) { const l = Math.hypot(u[j], u[j + 1], u[j + 2]); if (l > top) { top = l; at = j; } }
      let sign = 1;
      if (top > 0) { const a = [Math.abs(u[at]), Math.abs(u[at + 1]), Math.abs(u[at + 2])], c = a.indexOf(Math.max(...a)); sign = u[at + c] < 0 ? -1 : 1; }
      const f = top > 0 ? sign / top : 1;
      for (let j = 0; j < u.length; j++) u[j] *= f;
      shapes.push(u);
    });
    const freqs = found.map(m => m.hz);
    let change: number | null = null;
    if (before) {
      change = 0;
      found.forEach((m, i) => { if (keep[i] && !m.rigid && before![i] > 0) change = Math.max(change!, (Math.abs(m.hz - before![i]) / m.hz) * 100); });
    }
    before = freqs;
    const kept = found.filter((_m, i) => keep[i]), keptShapes = shapes.filter((_s, i) => keep[i]);
    const first = Math.max(0, kept.findIndex(m => !m.rigid));
    const n = inp.pos.length / 3;
    const converged = change != null && change <= inp.energyTol;
    const need = !converged && k + 1 < passes ? staticMemory(r.grid, p + 1) : 0;
    const capped = need > (inp.memory ?? MEMORY_LIMIT) ? Math.ceil(need / 2 ** 20) : 0;
    yield {
      pass: k + 1, p, dofs: r.dofs, cells: r.grid.elems.length, memory: r.memory, ...(capped ? { capped } : {}), energy: 0, change, ms: Date.now() - t0, reactions: [], applied: none,
      u: keptShapes[first] ? Float32Array.from(keptShapes[first]) : new Float32Array(3 * n), vm: new Float32Array(n), err: new Float32Array(n), errors: [],
      maxU: keptShapes.length ? 1 : 0, maxVm: 0, converged, done: converged || capped > 0 || k === passes - 1,
      modes: kept.map(m => ({ hz: m.hz, rigid: m.rigid, eff: m.eff })), shapes: keptShapes, mass: r.mass, ...(more ? { more: true } : {}),
    };
    if (converged || capped) return;
  }
}

/**
 * The passes of a thermal study (FR-TSOL-010): degree 2, 3, 4 on the same cells, until no temperature changes by
 * more than `energyTol` % of the temperature range. `keep` gets each pass's solution (temperature as `vm`, heat
 * flux as `u`), to be read later at other points.
 */
/** View factors of a set-up's exchanges against the whole surface, found once per set-up (they do not change between passes). */
const views = new WeakMap<ThermalSetup, ThermalExchange[]>();
export function exchangesOf(set: ThermalSetup, body: SimBody): ThermalExchange[] | undefined {
  if (!set.exchanges?.length) return undefined;
  let got = views.get(set);
  if (!got) { got = set.exchanges.map(x => ({ ...x, f: viewFactor(x.a, x.b, body.tris).fab })); views.set(set, got); }
  return got;
}

/** A hash of some numbers (their float64 bits), for keys. */
function hashOf(a: ArrayLike<number> | undefined, h = 2166136261): number {
  if (!a) return h;
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < a.length; i++) { f[0] = a[i]; h = Math.imul(h ^ u[0], 16777619); h = Math.imul(h ^ u[1], 16777619); }
  return h >>> 0;
}

/**
 * FR-TSOL-021: what a thermal solve's matrix depends on: the body and its regions, conductivities, joins, the cell
 * size and every sink's faces and kind (fixed temperature, or film and its coefficient), but not the temperatures,
 * ambients or powers, which only change the load.
 */
export function reuseKey(inp: RunInput, h: number): string {
  const T = inp.thermal!;
  return JSON.stringify([
    hashOf(inp.body.tris), inp.body.lo, inp.body.hi, h, inp.memory ?? null, T.k, T.ks ?? null, T.k3s ?? null, T.k3 ?? null, T.kt ?? null, T.kts ?? null, T.gap ?? null, T.links ?? null,
    (T.kmaps ?? []).map(m => (m ? [m.axis, m.ua, m.va, m.u0, m.v0, m.cell, m.nu, m.nv, hashOf(m.along), hashOf(m.through)] : null)),
    (inp.regions ?? []).map(r => hashOf(r.tris)),
    T.setup.sinks.map(s => [hashOf(s.tris), s.temp !== undefined ? "t" : "f", s.temp !== undefined ? 0 : s.h ?? 0, s.emissivity ?? 0, !!s.free, s.natural ? 1 : 0, s.forced ? hashOf(s.forced.h) : 0]),
    (T.setup.exchanges ?? []).length,
  ]);
}

/** Degrees ahead under a package part's pads, footprint or heatsink contact (`thermalBoost`). */
export const PAD_FINE = 2;

/**
 * Board heat entering through small faces (FR-TBRD-003, the package's pads and footprints): the elements holding
 * those faces start `fine` degrees ahead of the rest (as `boostOf` does for a structural study's refined faces), since
 * the temperature peaks there over a few millimetres the whole-body passes resolve slowly. Null when no source asks.
 */
export function thermalBoost(inp: RunInput, h: number, inside: (x: number, y: number, z: number) => boolean, domains?: { inside: (x: number, y: number, z: number) => boolean }[]): { grid: Grid; level: Int8Array } | null {
  const fine = inp.thermal!.setup.sources.filter(s => s.tris && (s.fine ?? 0) > 0).map(s => ({ tris: s.tris!, level: Math.min(MAX_REFINE, Math.round(s.fine!)) }));
  if (!fine.length || inp.thermal!.transient) return null;
  const grid = makeGrid(inp.body.lo, inp.body.hi, h, inside, { q: 3, depth: 3, fit: 5, domains: domains?.map(d => d.inside) });
  const level = boostOf(grid, fine);
  if (!level.some(v => v > 0)) return null;
  // the peak spreads past the faces' own cells: every body's neighbouring cells (edges and corners too) one degree less
  const near = Int8Array.from(level), maps = grid.maps.length;
  for (const C of grid.cells) {
    const L = level[C.el] - 1;
    if (L < 1) continue;
    const [i, j, k] = C.ijk;
    for (let d = 0; d < maps; d++) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const n = grid.at(i + a, j + b, k + c, d);
      if (n >= 0 && near[grid.cells[n].el] < L) near[grid.cells[n].el] = L;
    }
  }
  return { grid, level: near };
}

export function* runThermal(inp: RunInput, keep?: (s: Sampler, inside: (x: number, y: number, z: number) => boolean) => void): Generator<PassResult> {
  const T = inp.thermal!, set = T.setup, exchanges = exchangesOf(set, inp.body);
  if (set.problems.length) throw new Error(`${set.problems[0].code}: ${set.problems[0].id}`);
  const R = T.ks && inp.regions && inp.regions.length > 1 ? inp.regions : null;
  if (R ? T.ks!.some(v => !(v > 0)) : !((T.ks?.[0] ?? T.k) > 0)) throw new Error("E-TH-NOK");
  if (!set.sinks.length) throw new Error(R ? `E-TH-NOSINK: ${R.map((_r, i) => i).join(",")}` : "E-TH-NOSINK");
  const domains = R?.map((r, i) => ({ inside: insideOf(new MeshBody(r.tris)), k: T.ks![i], ...(T.k3s?.[i] ? { k3: T.k3s[i]! } : {}), ...(T.kmaps?.[i] ? { kmap: T.kmaps[i]! } : {}), ...(T.kts?.[i] ? { kt: T.kts[i]! } : {}), tris: r.tris }));
  // nothing brings heat and nothing differs: every point would just sit at the one temperature
  const temps = new Set(set.sinks.map(s => s.temp ?? s.ambient ?? 0));
  if (!set.sources.some(s => (s.power ?? 0) !== 0 || (s.flux ?? 0) !== 0 || (s.density ?? 0) !== 0) && temps.size < 2) throw new Error("E-TH-NOHEAT");
  const inside = insideOf(new MeshBody(inp.body.tris));
  const pads = set.sources.some(q => q.tris && (q.fine ?? 0) > 0);
  const h = inp.cells || !R ? cellSize(inp.body, inp.cells) : thermalCellSize(inp.body, R.map(r => r.tris), pads);
  const passes = Math.max(1, Math.min(MAX_PASSES, Math.round(inp.passes)));
  let grid: Grid | undefined, prev: Float64Array | undefined, before: Float32Array | null = null;
  const known: number[] = [], none: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  const reuse = reuseKey(inp, h);
  // FR-TSOL-003 local passes (as runStatic): each element's degree, and its share of the error when its degree was last raised
  let degrees: Int8Array | undefined, ind: Float64Array | undefined;
  // heat entering through small faces (a part's pads on a board): the elements under them run ahead from the first pass
  const boost = thermalBoost(inp, h, inside, domains);
  if (boost) grid = boost.grid;
  for (let k = 0; k < passes; k++) {
    progressPass(k + 1, passes);
    const t0 = Date.now();
    let p = k + 2, raised: number | undefined, marked: number[] = [];
    if (boost && k < GLOBAL_PASSES) {
      degrees = new Int8Array(boost.level.length);
      for (let e = 0; e < degrees.length; e++) { degrees[e] = Math.min(LOCAL_DEGREE, k + 2 + boost.level[e]); p = Math.max(p, degrees[e]); }
    }
    if (k >= GLOBAL_PASSES && grid && ind) {
      degrees ??= new Int8Array(grid.elems.length).fill(GLOBAL_PASSES + 1);
      marked = markElements(ind, degrees);
      if (!marked.length) return;
      for (const e of marked) degrees[e]++;
      raised = marked.length;
      p = 0;
      for (let e = 0; e < degrees.length; e++) p = Math.max(p, degrees[e]);
    }
    const r = solveThermal({ lo: inp.body.lo, hi: inp.body.hi, inside, h, p, k: T.ks?.[0] ?? T.k, ...(T.kt ? { kt: T.kt } : {}), ...(!domains && (T.k3 ?? T.k3s?.[0]) ? { k3: (T.k3 ?? T.k3s![0])! } : {}), grid, prev, ...(degrees ? { degrees } : {}), sinks: set.sinks, sources: set.sources, ...(exchanges ? { exchanges } : {}), memory: inp.memory, ...(domains ? { domains, gap: T.gap, links: T.links } : {}), reuse });
    grid = r.grid; prev = r.x;
    if (!ind || !degrees || k < GLOBAL_PASSES) ind = Float64Array.from(r.eta);
    else for (const e of marked) ind[e] = r.eta[e];
    if (r.prevError != null) known.push(r.prevError);
    const sampler: Sampler = (pos, nrm, hits) => { const s = r.sample(pos, nrm, hits); return { u: s.flux, vm: s.temp, err: s.err, ...(s.hit ? { hit: s.hit } : {}), ...(s.dom ? { dom: s.dom } : {}) }; };
    keep?.(sampler, inside);
    progress("results", 0, 1);
    const s = r.sample(inp.pos, inp.nrm);
    let min = Infinity, max = -Infinity, maxU = 0, moved = 0;
    for (let i = 0; i < s.temp.length; i++) {
      const v = s.temp[i];
      if (v < min) min = v;
      if (v > max) max = v;
      maxU = Math.max(maxU, Math.hypot(s.flux[3 * i], s.flux[3 * i + 1], s.flux[3 * i + 2]));
      if (before) moved = Math.max(moved, Math.abs(v - before[i]));
    }
    if (!s.temp.length) { min = 0; max = 0; }
    // by component: the temperatures on its surface and the heat made in it
    let comps: ThermalComp[] | undefined;
    if (domains && s.dom) {
      comps = domains.map(() => ({ min: Infinity, max: -Infinity, mean: 0, power: 0 }));
      const cnt = new Float64Array(domains.length);
      for (let i = 0; i < s.temp.length; i++) { const c = comps[s.dom[i]], v = s.temp[i]; if (v < c.min) c.min = v; if (v > c.max) c.max = v; c.mean += v; cnt[s.dom[i]]++; }
      comps.forEach((c, i) => { if (cnt[i]) c.mean /= cnt[i]; else { c.min = 0; c.max = 0; } });
      for (const q of set.sources) {
        if (q.tris && q.dom !== undefined && q.power && comps[q.dom]) comps[q.dom].power += q.power;
        if (q.tris || !(q.power || q.density)) continue;
        const ds = q.doms ?? domains.map((_d, i) => i);
        let vol = 0;
        for (const d of ds) vol += r.volumes[d] ?? 0;
        if (vol > 0) for (const d of ds) comps[d].power += q.density !== undefined ? q.density * (r.volumes[d] ?? 0) : (q.power! * (r.volumes[d] ?? 0)) / vol;
      }
      // what leaves each component's own surface (to the air or a fixed temperature): its heat less what it conducts away
      comps.forEach(c => { c.out = c.power; });
      for (const c of r.contacts ?? []) { if (comps[c.a]) comps[c.a].out! -= c.heat; if (comps[c.b]) comps[c.b].out! += c.heat; }
      for (const x of r.exchanges ?? []) if (x.da !== undefined && x.db !== undefined && x.da !== x.db) { comps[x.da].out! -= x.heat; comps[x.db].out! += x.heat; }
      // how that heat leaves (FR-TRES-005): by the sinks on its surface, by radiation to other components, by conduction
      comps.forEach(c => { c.conv = 0; c.rad = 0; c.held = 0; c.cond = 0; });
      for (const f of r.flows) if (f.doms) comps.forEach((c, i) => { c.conv! += f.doms![3 * i]; c.rad! += f.doms![3 * i + 1]; c.held! += f.doms![3 * i + 2]; });
      for (const c of r.contacts ?? []) { if (comps[c.a]) comps[c.a].cond! += c.heat; if (comps[c.b]) comps[c.b].cond! -= c.heat; }
      for (const x of r.exchanges ?? []) if (x.da !== undefined && x.db !== undefined && x.da !== x.db) { comps[x.da].rad! += x.heat; comps[x.db].rad! -= x.heat; }
    }
    // the range the change is measured against takes in the surroundings, so a nearly even part still converges
    let lo = min, hi = max;
    for (const q of set.sinks) { const v = q.temp ?? q.ambient ?? min; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const change = before ? (100 * moved) / Math.max(hi - lo, 1e-9) : null;
    before = s.temp.slice(); // a copy: the worker hands the pass's own arrays over
    const converged = change != null && change <= inp.energyTol;
    let need = 0, more = k + 1 < passes;
    if (!converged && more) {
      if (k + 1 < GLOBAL_PASSES) need = boost ? thermalMemory(r.grid, p + 1, Int8Array.from(boost.level, b => Math.min(LOCAL_DEGREE, k + 3 + b))) : thermalMemory(r.grid, p + 1);
      else {
        const d = degrees ? Int8Array.from(degrees) : new Int8Array(ind.length).fill(GLOBAL_PASSES + 1), mk = markElements(ind, d);
        for (const e of mk) d[e]++;
        more = mk.length > 0;
        if (more) need = thermalMemory(r.grid, d.reduce((a, v) => Math.max(a, v), 0), d);
      }
    }
    const capped = need > (inp.memory ?? MEMORY_LIMIT) ? Math.ceil(need / 2 ** 20) : 0;
    yield {
      pass: k + 1, p, ...(raised ? { raised } : {}), dofs: r.dofs, cells: r.grid.elems.length, memory: r.memory, ...(capped ? { capped } : {}), energy: r.energy, change, ms: Date.now() - t0, reactions: [], applied: none,
      u: s.flux, vm: s.temp, err: s.err, errors: [...known, passError(known)], maxU, maxVm: max, converged, done: converged || capped > 0 || !more,
      ...(s.dom ? { dom: s.dom } : {}),
      thermal: { min, max, applied: r.applied, flows: r.flows, solves: r.iterations, ...(r.kSteps ? { kSteps: r.kSteps } : {}), ...(r.reused ? { reused: true } : {}), ...(r.airSteps ? { airSteps: r.airSteps } : {}), ...(domains ? { contacts: r.contacts, comps } : {}), ...(r.exchanges ? { exchanges: r.exchanges } : {}) },
    };
    if (converged || capped) return;
  }
}

/**
 * The passes of a transient thermal study (FR-TSOL-006): when heat is made, steady passes at degree 2 and 3 first
 * (they choose the degree and show where the temperatures head), then the run in time at that degree from the start
 * temperature. The last pass carries every output time's temperatures at the sample points; its `vm` is the last one.
 */
/** A transient output time's per-domain temperatures as the steady result's component rows (power = the steady one's, at full power). */
export function frameComps(stats: { min: number; max: number; mean: number }[], powers: number[]) {
  return stats.map((c, d) => ({ ...c, power: powers[d] ?? 0 }));
}

export function* runTransient(inp: RunInput): Generator<PassResult> {
  const T = inp.thermal!, Tr = T.transient!, set = T.setup;
  if (set.problems.length) throw new Error(`${set.problems[0].code}: ${set.problems[0].id}`);
  const R = T.ks && inp.regions && inp.regions.length > 1 ? inp.regions : null;
  if (R ? T.ks!.some(v => !(v > 0)) : !((T.ks?.[0] ?? T.k) > 0)) throw new Error("E-TH-NOK");
  if (R ? (Tr.rcs ?? []).length !== R.length || Tr.rcs!.some(v => !(v > 0)) : !(Tr.rc > 0)) throw new Error("E-TH-NOCP");
  if (!set.sinks.length) throw new Error(R ? `E-TH-NOSINK: ${R.map((_r, i) => i).join(",")}` : "E-TH-NOSINK");
  if (!(Tr.end > 0)) throw new Error("E-TH-TIME");
  const heat = set.sources.some(s => (s.power ?? 0) !== 0 || (s.flux ?? 0) !== 0 || (s.density ?? 0) !== 0);
  const temps = new Set(set.sinks.map(s => s.temp ?? s.ambient ?? 0));
  if (!heat && temps.size < 2 && temps.has(Tr.t0)) throw new Error("E-TH-NOHEAT");
  let p = 2, pass = 0, steady: number | null = null, powers: number[] = [];
  // the last steady pass's cells, matrix and surface points are the warm-up's own: kept for it instead of made again
  let built: unknown;
  if (heat) {
    keepBuild(true);
    try {
      for (const r of runThermal({ ...inp, cells: inp.cells ?? 150, passes: Math.min(2, Math.max(1, Math.round(inp.passes))) })) {
        pass = r.pass; p = r.p; steady = r.thermal?.max ?? null; powers = (r.thermal?.comps ?? []).map(c => c.power);
        yield { ...r, done: false, converged: false };
      }
      built = takeBuild();
    } finally { keepBuild(false); }
  }
  progressPass(0, 0);
  const t0 = Date.now();
  const domains = R?.map((r, i) => ({ inside: insideOf(new MeshBody(r.tris)), k: T.ks![i], ...(T.k3s?.[i] ? { k3: T.k3s[i]! } : {}), ...(T.kmaps?.[i] ? { kmap: T.kmaps[i]! } : {}), ...(T.kts?.[i] ? { kt: T.kts[i]! } : {}), tris: r.tris }));
  const inside = insideOf(new MeshBody(inp.body.tris));
  const h = cellSize(inp.body, inp.cells);
  const times = outputTimes(Tr.end, Tr.out);
  const prof = set.sources.map(s => (s.id ? Tr.profiles[s.id] : undefined));
  const maxStep = Math.min(...prof.map(x => profileStep(x, Tr.end)));
  const frames: Float32Array[] = [], min: number[] = [], max: number[] = [], put: number[] = [], out: number[] = [];
  const comps: number[][] = [], cstats: { min: number; max: number; mean: number }[][] = [];
  let flux = new Float32Array(3 * (inp.pos.length / 3)), dom: Uint16Array | undefined, flows: SinkFlow[] = [];
  const r = transientThermal(
    { lo: inp.body.lo, hi: inp.body.hi, inside, h, p, k: T.ks?.[0] ?? T.k, ...(T.kt ? { kt: T.kt } : {}), ...(!domains && (T.k3 ?? T.k3s?.[0]) ? { k3: (T.k3 ?? T.k3s![0])! } : {}), sinks: set.sinks, sources: set.sources, ...(set.exchanges?.length ? { exchanges: exchangesOf(set, inp.body) } : {}), memory: inp.memory, ...(domains ? { domains, gap: T.gap, links: T.links } : {}) },
    {
      rc: R ? Tr.rcs! : [Tr.rc], t0: Tr.t0, times, built, ...(Number.isFinite(maxStep) ? { maxStep } : {}), breaks: prof.flatMap(profileBreaks),
      factor: (i, t) => profileFactor(prof[i], t),
      frame: (k, _t, sample, fl, applied) => {
        const s = sample(inp.pos, inp.nrm);
        let lo = Infinity, hi = -Infinity;
        for (const v of s.temp) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!s.temp.length) { lo = 0; hi = 0; }
        frames[k] = s.temp; min[k] = lo; max[k] = hi; put[k] = applied; out[k] = fl.reduce((a, f) => a + f.out, 0);
        if (domains && s.dom) {
          const m = domains.map(() => -Infinity), lo = domains.map(() => Infinity), sum = domains.map(() => 0), n = domains.map(() => 0);
          for (let i = 0; i < s.temp.length; i++) { const d = s.dom[i], v = s.temp[i]; if (v > m[d]) m[d] = v; if (v < lo[d]) lo[d] = v; sum[d] += v; n[d]++; }
          comps[k] = m.map(v => (v === -Infinity ? 0 : v));
          cstats[k] = m.map((v, d) => (n[d] ? { min: lo[d], max: v, mean: sum[d] / n[d] } : { min: 0, max: 0, mean: 0 }));
          dom = s.dom;
        }
        if (k === times.length - 1) { flux = s.flux; flows = fl; }
      },
    },
  );
  const last = frames[frames.length - 1];
  let maxU = 0;
  for (let i = 0; i < flux.length; i += 3) maxU = Math.max(maxU, Math.hypot(flux[i], flux[i + 1], flux[i + 2]));
  const none: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  yield {
    pass: pass + 1, p, dofs: r.dofs, cells: r.grid.elems.length, memory: r.memory, energy: 0, change: null, ms: Date.now() - t0, reactions: [], applied: none,
    u: flux, vm: Float32Array.from(last), err: new Float32Array(last.length), errors: [], maxU, maxVm: max[max.length - 1], converged: true, done: true,
    ...(dom ? { dom } : {}),
    thermal: { min: min[min.length - 1], max: max[max.length - 1], applied: put[put.length - 1], flows, solves: r.solves, ...(domains && cstats.length ? { comps: frameComps(cstats[cstats.length - 1], powers) } : {}) },
    transient: { times, frames, min, max, put, out, ...(domains ? { comps, cstats } : {}), steps: r.steps, rejected: r.rejected, dt: r.dt, capacity: r.capacity, t0: Tr.t0, steady },
  };
}
