// Thermal analysis (FRS-thermal TH2, FR-TSOL-001..): steady heat conduction on the structural solver's cells.
// One unknown per basis function (temperature, °C). Units: mm, W, K; conductivity W/(mm·K), film
// coefficient W/(mm²·K), flux W/mm². The same cut cells, hierarchical basis and interior-penalty coupling as
// `static.ts`; a fixed temperature is held by Nitsche terms, convection is a Robin term, radiation is
// linearised about the last temperatures and solved again until it settles.
// Pure: runs in the solver worker and in node tests. Work is split into small functions on purpose (a single
// large solve function is not optimised by the browser's compiler, see `measurePenalty` in static.ts).

import { Basis, basisSize } from "./basis";
import { BlockMatrix } from "./sparse";
import { BlockCholesky, type CholPlan } from "./blockchol";
import { pcgSolver } from "./pcg";
import { makeGrid, refit, memoryBytes, type Grid } from "./grid";
import { type MomentTables, conductFromMoments, degreeOf, massFromMoments, momentTables, momentsAdd, momentsClear, momentsKept, momentsPoint, legendrePoint } from "./moments";
import { facePoints, fitFacePoints, fitPlanePoints, gridTrianglePoints, type Inside, type Points } from "./quad";
import { DIRECT_LIMIT, MEMORY_LIMIT, directFits, memoryMb, topEigen, triArea, triBox, triNormals } from "./static";
import { exchangeResistance } from "./viewfactor";
import { progress } from "./progress";
import { kernel, parallelFor, sharedF64, sharedI32, worthSharing, type ParJob } from "./threads";

/** Stefan–Boltzmann constant, W/(mm²·K⁴). */
export const SIGMA = 5.670374419e-14;
export const KELVIN = 273.15;

/** A surface condition that takes heat away (or brings it): what the faces see. */
export interface ThermalSink {
  tris: ArrayLike<number>;
  /** Fixed temperature, °C. */
  temp?: number;
  /** Convection: film coefficient, W/(mm²·K), to air at `ambient` °C. */
  h?: number;
  /** Radiation: emissivity 0..1 to surroundings at `ambient` °C. */
  emissivity?: number;
  ambient?: number;
  /** With several domains: only the points of `tris` left open to the air, that is, not lying on another domain. */
  free?: boolean;
  /**
   * Natural convection (FR-TBC-004): the film coefficient of each point comes from its face's tilt and size and from
   * how much hotter it is than `ambient`, by the laminar plate correlations for air (`naturalH`), times `factor`
   * (the enclosure). `down` = gravity's direction (unit); `lv`/`lh` = per triangle of `tris`, the face's height
   * along gravity and its area / perimeter, mm.
   */
  natural?: { factor: number; down: ArrayLike<number>; lv: ArrayLike<number>; lh: ArrayLike<number> };
  /** Forced air (FR-TBC-005): the film coefficient of each triangle of `tris`, W/(mm²·K) (`forcedH` of its face). */
  forced?: { h: ArrayLike<number> };
}

/** Air near room temperature for the forced convection correlations: conductivity W/(m·K), kinematic viscosity m²/s, Prandtl number. */
export const AIR = { k: 0.0262, nu: 1.57e-5, pr: 0.71 };
/** Reynolds number where a flat plate's boundary layer turns turbulent. */
export const RE_TURBULENT = 5e5;

/**
 * Forced convection film coefficient for air flowing at `speed` m/s along a face `len` mm long in the flow, W/(mm²·K):
 * the mean over a flat plate, laminar Nu = 0.664 Re^½ Pr^⅓, above Re 5·10⁵ laminar then turbulent
 * Nu = (0.037 Re^0.8 − 871) Pr^⅓; h = Nu k / L.
 */
export function forcedH(speed: number, len: number): number {
  const L = Math.max(len, 1) * 1e-3, re = (Math.max(speed, 0) * L) / AIR.nu, pr3 = Math.cbrt(AIR.pr);
  const nu = re > RE_TURBULENT ? (0.037 * re ** 0.8 - 871) * pr3 : 0.664 * Math.sqrt(re) * pr3;
  return (1e-6 * nu * AIR.k) / L;
}

/**
 * Natural convection film coefficient for air, W/(mm²·K): the simplified laminar correlations (h = C (ΔT / L)^¼,
 * L in m) for a vertical plate (C 1.42, L = height), a horizontal plate with the hot side up (1.32, L = area /
 * perimeter) and with the hot side down (0.59). `up` = the normal's part along up (against gravity); a face cooler
 * than the air behaves like a hot one turned over.
 */
export function naturalH(up: number, dt: number, lv: number, lh: number): number {
  const d = Math.max(Math.abs(dt), 0.05), u = dt >= 0 ? up : -up;
  // (no array here: this runs for every surface point of every step)
  const C = u > Math.SQRT1_2 ? 1.32 : u < -Math.SQRT1_2 ? 0.59 : 1.42, L = u > Math.SQRT1_2 || u < -Math.SQRT1_2 ? lh : lv;
  return 1e-6 * C * Math.sqrt(Math.sqrt(d / (Math.max(L, 1) * 1e-3)));
}

export interface ThermalSource {
  /** Faces the heat enters through; none = spread over the whole body's volume. */
  tris?: ArrayLike<number>;
  /** Total power, W (over the faces or the volume). */
  power?: number;
  /** Heat flux into the body, W/mm² (faces only). */
  flux?: number;
  /** Without faces: heat made per volume, W/mm³ (in place of `power`; the power is this × the volume). */
  density?: number;
  /** Without faces and with `domains`: the heat is spread over the volume of these domains only. */
  doms?: number[];
  /** With faces: the domain they are on (bookkeeping only, for the heat made per component). */
  dom?: number;
  /** The study item it comes from (bookkeeping: its power profile in a transient study). */
  id?: string;
  /**
   * With faces: how many degrees ahead of the others the elements under them start (a part's pads or footprint on
   * a board, where the heat enters through a small area and the temperature peaks; `run.ts` `runThermal`).
   */
  fine?: number;
}

/** One body of several (an assembly's component): its own conductivity, W/(mm·K), and surface. */
export interface ThermalDomain {
  inside: Inside;
  k: number;
  /** Conductivity along the world X, Y and Z axes when they differ (a board: copper layers along it, laminate through it). */
  k3?: number[];
  /** Conductivity changing with temperature (FR-TMAT-004): [°C, factor on `k`/`k3`, °C, factor, …], ends held. */
  kt?: number[];
  tris: ArrayLike<number>;
  /** A board's conductivity varying over it (FR-TBRD-020): taken per element as the mean over its footprint; replaces `k3`. */
  kmap?: KMap;
}

/**
 * Conductivity over a board lying square to world axis `axis`: a grid of `nu` × `nv` cells of `cell` mm from (`u0`, `v0`)
 * along the world axes `ua` and `va`; per cell the conductivity along the board and through it, W/(mm·K).
 */
export interface KMap {
  axis: number; ua: number; va: number;
  u0: number; v0: number; cell: number; nu: number; nv: number;
  along: ArrayLike<number>; through: ArrayLike<number>;
}

/** A map's mean conductivity along and through the board over a box (half size `s` about `c`); the cells it overlaps, by area. */
export function kmapMean(m: KMap, c: ArrayLike<number>, s: number): [number, number] {
  const u0 = (c[m.ua] - s - m.u0) / m.cell, u1 = (c[m.ua] + s - m.u0) / m.cell, v0 = (c[m.va] - s - m.v0) / m.cell, v1 = (c[m.va] + s - m.v0) / m.cell;
  const i0 = Math.max(0, Math.floor(u0)), i1 = Math.min(m.nu - 1, Math.ceil(u1) - 1), j0 = Math.max(0, Math.floor(v0)), j1 = Math.min(m.nv - 1, Math.ceil(v1) - 1);
  let w = 0, a = 0, t = 0;
  for (let j = j0; j <= j1; j++) {
    const wv = Math.min(j + 1, v1) - Math.max(j, v0);
    if (!(wv > 0)) continue;
    for (let i = i0; i <= i1; i++) {
      const wu = Math.min(i + 1, u1) - Math.max(i, u0);
      if (!(wu > 0)) continue;
      const q = wu * wv, k = j * m.nu + i;
      w += q; a += q * m.along[k]; t += q * m.through[k];
    }
  }
  if (w > 0) return [a / w, t / w];
  // off the map: the nearest cell
  const i = Math.min(m.nu - 1, Math.max(0, Math.floor((c[m.ua] - m.u0) / m.cell))), j = Math.min(m.nv - 1, Math.max(0, Math.floor((c[m.va] - m.v0) / m.cell)));
  return [m.along[j * m.nu + i], m.through[j * m.nu + i]];
}

/**
 * How two domains that touch pass heat (FR-TCON-002): without a link the contact is perfect (one temperature
 * on both sides); "resistance" = a conductance `h` W/(mm²·K) between the two surface temperatures (a contact
 * resistance, or an interface material: k / thickness); "none" = insulated.
 */
export interface ThermalLink {
  a: number;
  b: number;
  type: "none" | "resistance";
  h?: number;
  /** An air layer this many mm thick (FR-TCON-002): `h` = air's conductivity at the joint's mean temperature / it. */
  air?: number;
}

/** Thinnest air layer taken, mm: a touching pair set to Air gap still passes a finite heat. */
export const AIR_MIN = 0.01;
/** Dry air's conductivity at `T` °C, W/(mm·K): 0.0243 W/(m·K) at 0 °C, 0.0314 at 100 °C, 0.0386 at 200 °C. */
export function airK(T: number): number { return (0.0243 + 7.15e-5 * Math.max(-50, Math.min(600, T))) * 1e-3; }
/** The links with each air layer's conductance at the temperature `T(link)` gives. */
function airLinks(links: ThermalLink[], T: (l: ThermalLink) => number): ThermalLink[] {
  return links.map(l => (l.air !== undefined ? { ...l, type: "resistance" as const, h: airK(T(l)) / Math.max(l.air, AIR_MIN) } : l));
}
/** The mean of the problem's fixed and ambient temperatures, °C: where temperature-dependent values start. */
function startTemp(pb: ThermalProblem): number {
  const temps = pb.sinks.map(s => s.temp ?? s.ambient ?? 0);
  return temps.length ? temps.reduce((a, v) => a + v, 0) / temps.length : 20;
}

export interface ThermalContact {
  a: number;
  b: number;
  area: number;
  type: "perfect" | "resistance";
  /** Heat passing from a to b, W, and the mean temperature of each side over the contact, °C. */
  heat: number;
  ta: number;
  tb: number;
}

/**
 * Radiation between two sets of faces (FR-TBC-007): a grey two-surface exchange of σ (Ta⁴ − Tb⁴) / R, R the
 * resistance of `exchangeResistance` (viewfactor.ts) from the emissivities, areas and the view factor `f` from a to b,
 * between the mean temperatures of the two sets. Each point of a set radiates by its own temperature to the other
 * set's mean, so a hot spot sends more and the two sides' heats are equal and opposite; it is Newton-linearised about
 * the mean temperatures, solved exactly (a rank-two update) and linearised again until it settles.
 */
export interface ThermalExchange {
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  ea: number;
  eb: number;
  f: number;
}

export interface ExchangeFlow {
  /** Heat from a to b, W, and the mean temperature of each set, °C. */
  heat: number;
  ta: number;
  tb: number;
  areaA: number;
  areaB: number;
  /** The view factor from a to b it used. */
  f: number;
  /** With `domains`: the one holding most of each set's area. */
  da?: number;
  db?: number;
}

export interface ThermalProblem {
  lo: number[];
  hi: number[];
  inside: Inside;
  h: number;
  p: number;
  /** Conductivity, W/(mm·K) (not used with `domains`). */
  k: number;
  /** Conductivity along the world X, Y and Z axes when they differ (FR-TMAT-003; not used with `domains`), W/(mm·K). */
  k3?: number[];
  /** Its change with temperature (not used with `domains`): [°C, factor, …] as `ThermalDomain.kt`. */
  kt?: number[];
  /** Several bodies, joined where they touch (within `gap` mm) as `links` say. */
  domains?: ThermalDomain[];
  gap?: number;
  links?: ThermalLink[];
  sinks: ThermalSink[];
  /** Radiation between face sets (FR-TBC-007). */
  exchanges?: ThermalExchange[];
  sources: ThermalSource[];
  grid?: Grid;
  depth?: number;
  /** The pass before's coefficients on the same grid (for the error estimate). */
  prev?: Float64Array;
  /**
   * FR-TSOL-003: the degree of each element of `grid` (at most `p`): an element takes the leading functions of the
   * hierarchical basis, so elements of different degrees join like any others. `x` comes back in the layout of
   * degree `p` everywhere (the missing coefficients 0).
   */
  degrees?: ArrayLike<number>;
  solver?: "direct" | "pcg";
  tol?: number;
  beta?: number;
  memory?: number;
  /**
   * FR-TSOL-021: a key of everything but the fixed temperatures, ambients and powers. A linear solve with the key of
   * the last one at the same degree reuses its grid, matrix and factorisation (only the load is made again).
   */
  reuse?: string;
}

export interface SinkFlow {
  /** Heat leaving through this condition, W (negative = it brings heat in). */
  out: number;
  area: number;
  /** Mean temperature of its faces, °C. */
  mean: number;
  /** Natural convection and forced air: the mean film coefficient it came to, W/(mm²·K). */
  h?: number;
  /**
   * With several domains (FR-TRES-005): what it takes from each domain, W, three per domain: convection (films,
   * natural and forced air), radiation to the surroundings, a fixed temperature.
   */
  doms?: Float64Array;
}

export interface ThermalSample {
  /** °C */
  temp: Float32Array;
  /** Heat flux −k ∇T, W/mm², 3 each. */
  flux: Float32Array;
  err: Float32Array;
  hit?: Uint8Array;
  /** With `domains`: the one each point is in. */
  dom?: Uint8Array;
}

export interface ThermalResult {
  grid: Grid;
  p: number;
  dofs: number;
  memory: number;
  x: Float64Array;
  /** ∫ k |∇T|² dV, W·K. */
  energy: number;
  /** Heat put in by the sources, W, and what each sink takes, in the order given. */
  applied: number;
  flows: SinkFlow[];
  /** Solves it took (more than one with radiation). */
  iterations: number;
  /** Solves made again with the conductivity at the temperatures found (FR-TMAT-004); 0 when it is constant. */
  kSteps?: number;
  /** Solves made again with air layers' k at the joints' temperatures (FR-TCON-002). */
  airSteps?: number;
  /** Solved with the kept factorisation of the solve before (FR-TSOL-021). */
  reused?: boolean;
  eta: Float64Array;
  prevError: number | null;
  volume: number;
  /** With `domains`: where they touch and what passes there, and each one's volume. */
  contacts: ThermalContact[];
  volumes: number[];
  /** Radiation between face sets, in the order given (absent without any). */
  exchanges?: ExchangeFlow[];
  sample(pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): ThermalSample;
  temp(x: number, y: number, z: number): number;
}

interface Ctx {
  pb: ThermalProblem;
  grid: Grid;
  p: number;
  /** Functions of degree `p`; each element's own count and where its unknowns start (nel + 1 entries). */
  nb: number;
  nbs: Int32Array;
  off: Int32Array;
  deg: Uint8Array;
  nel: number;
  /** Conductivity (the largest of the three directions) and domain of each element; `k3` = along X, Y, Z, 3 each. */
  ke: Float64Array;
  k3: Float64Array;
  dom: Uint8Array;
  doms: ThermalDomain[] | null;
  bas: Basis;
  bas2: Basis;
  gam: Float64Array;
  fitted: Map<number, Points>;
  /** While the equations are built with several bodies: the located points of the triangles met so far. */
  loc?: LocKept;
}

/** The body each triangle of a set lies on (−1 = none found), asked once per set and kept. */
const triBodies = new WeakMap<object, { doms: ThermalDomain[]; of: Int8Array }>();
function bodiesOf(c: Ctx, tris: ArrayLike<number>): Int8Array | null {
  const doms = c.doms;
  if (!doms || typeof tris !== "object") return null;
  const had = triBodies.get(tris as object);
  if (had && had.doms === doms) return had.of;
  const n = Math.floor(tris.length / 9), nrms = triNormals(tris), of = new Int8Array(n).fill(-1), eps = 1e-4 * c.grid.h;
  for (let t = 0; t < n; t++) {
    const o = 9 * t, x = (tris[o] + tris[o + 3] + tris[o + 6]) / 3 - eps * nrms[3 * t], y = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3 - eps * nrms[3 * t + 1], z = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3 - eps * nrms[3 * t + 2];
    for (let d = 0; d < doms.length; d++) if (doms[d].inside(x, y, z)) { of[t] = d; break; }
  }
  triBodies.set(tris as object, { doms, of });
  return of;
}

/**
 * Boundary points of some triangles with the element each lies in: e, x, y, z, w, nx, ny, nz per point. The points of
 * one element in one plane are replaced by the few fitted points that integrate its functions' products the same
 * (`fitPlanar`), unless `fit` is false.
 */
function located(c: Ctx, tris: ArrayLike<number>, q: number, dom = -1, fit = true): Float64Array {
  const own = dom < 0 ? bodiesOf(c, tris) : null;
  if (c.loc && c.loc.q === q) { const r = keptPoints(c, c.loc, tris, own, dom); return fit ? fitPlanar(c, r.L, r.ids) : r.L; }
  const L = cutPoints(c, tris, q, own, dom);
  return fit ? fitPlanar(c, L) : L;
}

let pieceRules = true;
/** Tests: off = every piece of a surface triangle gets the rule of the highest degree, as before 1.743.0. */
export const setPieceRules = (on: boolean) => { pieceRules = on; };
/** What a piece of a surface triangle has to integrate: twice the degree of the element it lies in (products of two
 * of its functions), which with local degrees is well below twice the highest. −1 = not known, the full rule. */
function pieceDegree(c: Ctx, nrms: ArrayLike<number>, bodyOf: (t: number) => number): ((t: number, x: number, y: number, z: number) => number) | undefined {
  if (!pieceRules) return undefined;
  const g = c.grid, eps = 1e-7 * g.h, deg = c.deg;
  return (t, x, y, z) => {
    const cl = g.cellOf(x - eps * nrms[3 * t], y - eps * nrms[3 * t + 1], z - eps * nrms[3 * t + 2], bodyOf(t));
    return cl < 0 ? -1 : 2 * deg[g.cells[cl].el];
  };
}

/** The points of some triangles cut at the grid planes, each with its element: 8 numbers per point, triangle by triangle. */
function cutPoints(c: Ctx, tris: ArrayLike<number>, q: number, own: Int8Array | null, dom: number): Float64Array {
  const g = c.grid, nrms = triNormals(tris), eps = 1e-7 * g.h;
  const { pts, tri } = gridTrianglePoints(tris, g.lo, g.h, q, pieceDegree(c, nrms, t => own ? own[t] : dom));
  const out = new Float64Array(8 * pts.n);
  let n = 0;
  for (let i = 0; i < pts.n; i++) {
    const o = 4 * i, t = tri[i], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
    const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
    // nudged inwards so a point on a cell face lands in the cell the body is on;
    // with several bodies each point is read in its triangle's body (asked once per triangle, not per point)
    const cl = g.cellOf(x - eps * nx, y - eps * ny, z - eps * nz, own ? own[t] : dom);
    if (cl < 0) continue;
    const w = 8 * n++;
    out[w] = g.cells[cl].el; out[w + 1] = x; out[w + 2] = y; out[w + 3] = z; out[w + 4] = pts.a[o + 3]; out[w + 5] = nx; out[w + 6] = ny; out[w + 7] = nz;
  }
  return out.subarray(0, 8 * n);
}

/**
 * The located points of every triangle met while one set of equations is built, kept by the triangle's corners and
 * body: the sinks of a board study (convection face by face, radiation from all open surfaces) and the domains'
 * surfaces ask for the same triangles two or three times. `free` remembers what `freePoints` found for a point.
 */
interface LocKept {
  q: number;
  /** Hash of a triangle → its first record; records chained through `next`. */
  first: Map<number, number>;
  next: number[];
  /** Per record: where its nine corner numbers start in `key`, its body, its first point and its number of points. */
  body: number[]; from: number[]; count: number[];
  key: Float64Array; nk: number;
  /** Per point: element, x, y, z, weight. */
  pts: Float64Array; n: number;
  /** Per point: 0 not asked, 1 open, 2 on another body. */
  free: Uint8Array;
  /** Fitted plane groups by their first kept point: the group's kept points and what `fitPlanar` made of them. */
  fits: Map<number, { ids: Int32Array; out: Float64Array }[]>;
}
let keepPoints = true;
/** Tests: off = every sink and surface locates and fits its points itself, as before 1.739.0. */
export const setKeptPoints = (on: boolean) => { keepPoints = on; };
const newLoc = (q: number): LocKept => ({ q, first: new Map(), next: [], body: [], from: [], count: [], key: new Float64Array(9 * 1024), nk: 0, pts: new Float64Array(5 * 4096), n: 0, free: new Uint8Array(4096), fits: new Map() });
const hashWords = new Float64Array(9), hashBits = new Uint32Array(hashWords.buffer);
function triHash(tris: ArrayLike<number>, o: number, body: number): number {
  for (let j = 0; j < 9; j++) hashWords[j] = tris[o + j];
  let h = (body + 0x9e3779b9) | 0;
  for (let j = 0; j < 18; j++) h = (Math.imul(h ^ hashBits[j], 0x85ebca6b) + 0xc2b2ae35) | 0;
  return h;
}
/** The record of a triangle in `K`, or −1. */
function locFind(K: LocKept, tris: ArrayLike<number>, o: number, body: number, h: number): number {
  for (let r = K.first.get(h) ?? -1; r >= 0; r = K.next[r]) {
    if (K.body[r] !== body) continue;
    const k = 9 * r;
    let same = true;
    for (let j = 0; j < 9 && same; j++) same = K.key[k + j] === tris[o + j];
    if (same) return r;
  }
  return -1;
}
/** As `cutPoints`, through the kept triangles; `ids` = each point's place in `K` (for `K.free`). */
function keptPoints(c: Ctx, K: LocKept, tris: ArrayLike<number>, own: Int8Array | null, dom: number): { L: Float64Array; ids: Int32Array } {
  const nt = Math.floor(tris.length / 9), recs = new Int32Array(nt), miss: number[] = [];
  for (let t = 0; t < nt; t++) {
    const body = own ? own[t] : dom, h = triHash(tris, 9 * t, body);
    let r = locFind(K, tris, 9 * t, body, h);
    if (r < 0) {
      // a new record, its points made below with the other new ones
      r = K.body.length;
      if (9 * (r + 1) > K.key.length) { const a = new Float64Array(2 * K.key.length); a.set(K.key); K.key = a; }
      for (let j = 0; j < 9; j++) K.key[9 * r + j] = tris[9 * t + j];
      K.body.push(body); K.from.push(-1); K.count.push(0);
      K.next.push(K.first.get(h) ?? -1);
      K.first.set(h, r);
      miss.push(t);
    }
    recs[t] = r;
  }
  if (miss.length) {
    const sub = new Float64Array(9 * miss.length), g = c.grid, eps = 1e-7 * g.h;
    miss.forEach((t, k) => { for (let j = 0; j < 9; j++) sub[9 * k + j] = tris[9 * t + j]; });
    const nrms = triNormals(sub), { pts, tri } = gridTrianglePoints(sub, g.lo, g.h, K.q, pieceDegree(c, nrms, k => K.body[recs[miss[k]]]));
    if (K.n + pts.n > K.free.length) {
      const room = Math.max(2 * K.free.length, K.n + pts.n), a = new Float64Array(5 * room), f = new Uint8Array(room);
      a.set(K.pts.subarray(0, 5 * K.n)); f.set(K.free.subarray(0, K.n));
      K.pts = a; K.free = f;
    }
    for (let i = 0; i < pts.n; i++) {
      const o = 4 * i, k = tri[i], r = recs[miss[k]], nx = nrms[3 * k], ny = nrms[3 * k + 1], nz = nrms[3 * k + 2];
      const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
      const cl = g.cellOf(x - eps * nx, y - eps * ny, z - eps * nz, K.body[r]);
      if (cl < 0) continue;
      if (K.from[r] < 0) K.from[r] = K.n;
      const w = 5 * K.n++;
      K.pts[w] = g.cells[cl].el; K.pts[w + 1] = x; K.pts[w + 2] = y; K.pts[w + 3] = z; K.pts[w + 4] = pts.a[o + 3];
      K.count[r]++;
    }
  }
  let n = 0;
  for (let t = 0; t < nt; t++) n += K.count[recs[t]];
  const L = new Float64Array(8 * n), ids = new Int32Array(n), nrms = triNormals(tris);
  let m = 0;
  for (let t = 0; t < nt; t++) {
    const r = recs[t], from = K.from[r], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
    for (let i = 0; i < K.count[r]; i++, m++) {
      const s = 5 * (from + i), w = 8 * m;
      L[w] = K.pts[s]; L[w + 1] = K.pts[s + 1]; L[w + 2] = K.pts[s + 2]; L[w + 3] = K.pts[s + 3]; L[w + 4] = K.pts[s + 4]; L[w + 5] = nx; L[w + 6] = ny; L[w + 7] = nz;
      ids[m] = from + i;
    }
  }
  return { L, ids };
}

/** The fitted points kept for the group whose kept points are `ids[idx[…]]`, or null. */
function fitKept(K: LocKept, ids: Int32Array, idx: number[]): Float64Array | null {
  const list = K.fits.get(ids[idx[0]]);
  if (!list) return null;
  for (const F of list) {
    if (F.ids.length !== idx.length) continue;
    let same = true;
    for (let i = 0; i < idx.length && same; i++) same = F.ids[i] === ids[idx[i]];
    if (same) return F.out;
  }
  return null;
}
function fitKeep(K: LocKept, ids: Int32Array, idx: number[], out: Float64Array) {
  const own = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) own[i] = ids[idx[i]];
  const list = K.fits.get(own[0]);
  if (list) list.push({ ids: own, out });
  else K.fits.set(own[0], [{ ids: own, out }]);
}

/**
 * The points of `L` (8 numbers each) with those of one element lying in one plane replaced by the (2d + 1)² points
 * of `fitPlanePoints` (d = the element's degree), which integrate every product of its functions as they did: a
 * flat face made of many triangles, each cut at the grid planes, otherwise gives each element hundreds of points.
 * Groups keep the order they are first met; groups too small to gain keep their own points.
 */
function fitPlanar(c: Ctx, L: Float64Array, ids?: Int32Array | null): Float64Array {
  const n = L.length / 8, h = c.grid.h, tol = 1e-7;
  if (n < 2) return L;
  type Group = { e: number; nx: number; ny: number; nz: number; d: number; idx: number[] };
  const groups: Group[] = [], byEl = new Map<number, Group[]>();
  let G: Group | undefined;
  for (let i = 0; i < n; i++) {
    const o = 8 * i, e = L[o], nx = L[o + 5], ny = L[o + 6], nz = L[o + 7], d = nx * L[o + 1] + ny * L[o + 2] + nz * L[o + 3];
    // points come triangle by triangle, so the group of the point before is usually this one's
    if (!G || G.e !== e || !(Math.abs(G.nx - nx) < tol && Math.abs(G.ny - ny) < tol && Math.abs(G.nz - nz) < tol && Math.abs(G.d - d) < tol * h)) {
      G = undefined;
      let list = byEl.get(e);
      if (!list) byEl.set(e, (list = []));
      for (const g of list) if (Math.abs(g.nx - nx) < tol && Math.abs(g.ny - ny) < tol && Math.abs(g.nz - nz) < tol && Math.abs(g.d - d) < tol * h) { G = g; break; }
      if (!G) { G = { e, nx, ny, nz, d, idx: [] }; list.push(G); groups.push(G); }
    }
    G.idx.push(i);
  }
  if (groups.length === n) return L;
  // groups fitted before from the same kept points (another sink on the same faces, the body's own surface) are taken as they were
  const K = ids && c.loc ? c.loc : null, ng = groups.length;
  const had: (Float64Array | null)[] = new Array(ng).fill(null), todo: number[] = [];
  for (let k = 0; k < ng; k++) {
    const g = groups[k], q = 2 * c.deg[g.e] + 1;
    if (K && g.idx.length > q * q) had[k] = fitKept(K, ids!, g.idx);
    if (!had[k]) todo.push(k);
  }
  // every other group as a task: its points' numbers, its normal and degree, and room for as many points as it has
  const nj = todo.length;
  let work = 0, room = 0;
  for (const k of todo) { const g = groups[k], q = 2 * c.deg[g.e] + 1; room += g.idx.length; if (g.idx.length > q * q) work += g.idx.length * (q * q / 2 + 4 * q); }
  const share = nj > 0 && worthSharing(work);
  const idx = share ? sharedI32(room) : new Int32Array(room), rec = share ? sharedF64(PFIT * nj) : new Float64Array(PFIT * nj);
  const out = share ? sharedF64(8 * room) : new Float64Array(8 * room), cnt = share ? sharedI32(nj) : new Int32Array(nj);
  let at = 0;
  for (let j = 0; j < nj; j++) {
    const g = groups[todo[j]], o = PFIT * j;
    rec[o] = at; rec[o + 1] = g.idx.length; rec[o + 2] = g.e; rec[o + 3] = g.nx; rec[o + 4] = g.ny; rec[o + 5] = g.nz; rec[o + 6] = 2 * c.deg[g.e] + 1;
    idx.set(g.idx, at);
    at += g.idx.length;
  }
  if (nj) {
    const job: PlaneFitJob = { kind: "tplanefit", n: nj, L: share ? shared8(L) : L, idx, rec, out, cnt, tiny: 1e-9 * h };
    if (share) parallelFor(job);
    else { const st = planeFitInit(job); for (let j = 0; j < nj; j++) planeFitGroup(st, j); }
  }
  let m = 0, fitted = nj < ng;
  for (let j = 0; j < nj; j++) { m += cnt[j]; if (cnt[j] !== rec[PFIT * j + 1]) fitted = true; }
  if (!fitted) return L;
  for (let k = 0; k < ng; k++) if (had[k]) m += had[k]!.length / 8;
  const res = new Float64Array(8 * m);
  let to = 0;
  for (let k = 0, j = 0; k < ng; k++) {
    if (had[k]) { res.set(had[k]!, to); to += had[k]!.length; continue; }
    const from = 8 * rec[PFIT * j], len = 8 * cnt[j];
    res.set(out.subarray(from, from + len), to);
    if (K && cnt[j] !== rec[PFIT * j + 1]) fitKeep(K, ids!, groups[k].idx, res.slice(to, to + len));
    to += len;
    j++;
  }
  return res;
}
/** Numbers per group of `fitPlanar`: first index, count, element, normal, points per direction. */
const PFIT = 7;
interface PlaneFitJob { kind: string; n: number; L: Float64Array; idx: Int32Array; rec: Float64Array; out: Float64Array; cnt: Int32Array; tiny: number; [k: string]: unknown }
/** A copy on shared memory. */
function shared8(a: Float64Array): Float64Array { const s = sharedF64(a.length); s.set(a); return s; }
function planeFitInit(j: PlaneFitJob) {
  return { j, buf: new Float64Array(0) };
}
/** One group of `fitPlanar`: its points fitted (or kept) into its room of `out`, their number into `cnt`. */
function planeFitGroup(st: ReturnType<typeof planeFitInit>, k: number) {
  const j = st.j, o = PFIT * k, from = j.rec[o], n = j.rec[o + 1], e = j.rec[o + 2], nx = j.rec[o + 3], ny = j.rec[o + 4], nz = j.rec[o + 5], q = j.rec[o + 6];
  const L = j.L, out = j.out, to = 8 * from;
  let F: Points | null = null;
  if (n > q * q) {
    if (st.buf.length < 4 * n) st.buf = new Float64Array(4 * n);
    const a = st.buf, own = new Int32Array(n);
    for (let t = 0; t < n; t++) { const s = 8 * j.idx[from + t] + 1; a[4 * t] = L[s]; a[4 * t + 1] = L[s + 1]; a[4 * t + 2] = L[s + 2]; a[4 * t + 3] = L[s + 3]; own[t] = t; }
    F = fitPlanePoints({ a, n } as unknown as Points, own, [nx, ny, nz], q, j.tiny);
  }
  if (F) {
    for (let t = 0; t < F.n; t++) { const w = to + 8 * t; out[w] = e; out[w + 1] = F.a[4 * t]; out[w + 2] = F.a[4 * t + 1]; out[w + 3] = F.a[4 * t + 2]; out[w + 4] = F.a[4 * t + 3]; out[w + 5] = nx; out[w + 6] = ny; out[w + 7] = nz; }
    j.cnt[k] = F.n;
  } else {
    for (let t = 0; t < n; t++) { const s = 8 * j.idx[from + t], w = to + 8 * t; for (let i = 0; i < 8; i++) out[w + i] = L[s + i]; }
    j.cnt[k] = n;
  }
}
kernel<PlaneFitJob, ReturnType<typeof planeFitInit>>("tplanefit", { init: planeFitInit, run: planeFitGroup });

/** The points of the face between cell `ca` and the next one along `axis`, for degree `d` (the higher side's). */
function facePts(c: Ctx, ca: number, axis: number, d = c.p): Points {
  const g = c.grid, A0 = g.cells[ca], key = ca * 3 + axis, had = c.fitted.get(key);
  if (had) return had;
  let pts = g.faces.get(key);
  if (pts === undefined) {
    pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, c.doms ? c.doms[A0.dom].inside : c.pb.inside, c.pb.depth ?? 3);
    const area = g.h * g.h;
    g.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    pts = g.faces.get(key);
  }
  const out = pts ? fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, 2 * d + 1) : facePoints(axis, A0.hi[axis], A0.lo, A0.hi, d + 1, () => true, 0);
  c.fitted.set(key, out);
  return out;
}

/**
 * Conduction of an element into its matrix, K += ∫ k ∇N_a · ∇N_b, from the moments of its integration points
 * (`moments.ts`): the points are `n` runs of four numbers from `from`; `deg` is the element's degree.
 */
function conductElement(K: Float64Array, T: MomentTables, pts: ArrayLike<number>, from: number, n: number, c: ArrayLike<number>, sz: number, nb: number, deg: number, kx: number, ky: number, kz: number) {
  momentsAdd(T, pts, from, n, c, sz, Math.max(0, 2 * deg - 2));
  conductFromMoments(T, K, nb, sz, kx, ky, kz);
  momentsClear(T);
}

/** Conduction inside the elements, on all threads when there are several and the work is worth it. */
function volumeTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nbs, bas, nel, k3 } = c;
  let work = 0, npt = 0;
  for (let e = 0; e < nel; e++) for (const ci of grid.elems[e].cells) { const n = grid.cells[ci].pts.n; npt += n; work += n * 300; }
  if (!worthSharing(work)) {
    const T = momentTables(bas.p);
    momentsClear(T);
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e], K = A.block(e, e), top = Math.max(0, 2 * c.deg[e] - 2);
      for (const ci of E.cells) { const P = grid.cells[ci].pts; momentsAdd(T, P.a, 0, P.n, E.c, E.s, top); }
      conductFromMoments(T, K, nbs[e], E.s, k3[3 * e], k3[3 * e + 1], k3[3 * e + 2]);
      momentsClear(T);
    }
    return;
  }
  // the points, the elements and the blocks they fill, on shared memory: one task per element
  const pts = sharedF64(4 * npt), at = sharedF64(TVOL * nel), nb = sharedI32(nel);
  let n = 0, size = 0;
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e], o = TVOL * e;
    at[o] = n;
    for (const ci of E.cells) { const P = grid.cells[ci].pts; pts.set((P.a as Float64Array).subarray(0, 4 * P.n), 4 * n); n += P.n; }
    at.set([n, size, E.c[0], E.c[1], E.c[2], E.s, k3[3 * e], k3[3 * e + 1], k3[3 * e + 2], c.deg[e]], o + 1);
    nb[e] = nbs[e];
    size += nbs[e] * nbs[e];
  }
  const out = sharedF64(size);
  parallelFor({ kind: "tvolume", n: nel, p: bas.p, pts, at, nb, out } satisfies Omit<TVolumeJob, "ctl">, d => progress("assemble", d, 2 * nel));
  for (let e = 0; e < nel; e++) { const o = at[TVOL * e + 2]; A.adopt(e, out.subarray(o, o + nbs[e] * nbs[e])); }
}
/** Numbers per element of a shared conduction loop: first point, end point, block offset, centre, half size, k along X, Y, Z, degree. */
const TVOL = 11;
interface TVolumeJob extends ParJob { p: number; pts: Float64Array; at: Float64Array; nb: Int32Array; out: Float64Array }
kernel<TVolumeJob, { j: TVolumeJob; T: MomentTables }>("tvolume", {
  init: j => { const T = momentTables(j.p); momentsClear(T); return { j, T }; },
  run({ j, T }, e) {
    const a = j.at, o = TVOL * e, nb = j.nb[e];
    conductElement(j.out.subarray(a[o + 2], a[o + 2] + nb * nb), T, j.pts, 4 * a[o], a[o + 1] - a[o], [a[o + 3], a[o + 4], a[o + 5]], a[o + 6], nb, a[o + 10], a[o + 7], a[o + 8], a[o + 9]);
  },
});

/**
 * The penalty the cut elements need: γ = 2 λmax(T, K) with T = ∫ (k ∂N/∂n)² over the element's interior faces
 * and its fixed-temperature faces, K its conduction matrix; never under the formula's value.
 */
function measure(c: Ctx, A: BlockMatrix, held: Float64Array[]) {
  const { grid, nbs, nel, bas, k3, gam } = c;
  const cut = new Uint8Array(nel);
  let any = false;
  for (let e = 0; e < nel; e++) if (grid.elems[e].cells.some(ci => grid.cells[ci].frac < 1 - 1e-9)) { cut[e] = 1; any = true; }
  if (!any) return;
  // the samples of each cut element (place, weight, normal), in the order they are met: one task per element
  const count = new Int32Array(nel);
  const faces = (each: (e: number, x: number, y: number, z: number, w: number, nx: number, ny: number, nz: number) => void) => {
    for (let ci = 0; ci < grid.cells.length; ci++) {
      const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
      for (let axis = 0; axis < 3; axis++) {
        const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0), grid.cells[ci].dom);
        if (o < 0) continue;
        const eb = grid.cells[o].el;
        if (ea === eb || !(cut[ea] || cut[eb])) continue;
        const pts = facePts(c, ci, axis, Math.max(c.deg[ea], c.deg[eb])), nx = axis === 0 ? 1 : 0, ny = axis === 1 ? 1 : 0, nz = axis === 2 ? 1 : 0;
        for (let q = 0; q < pts.n; q++) {
          const o4 = 4 * q;
          if (cut[ea]) each(ea, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], nx, ny, nz);
          if (cut[eb]) each(eb, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], nx, ny, nz);
        }
      }
    }
    for (const L of held) for (let o = 0; o < L.length; o += 8) if (cut[L[o]]) each(L[o], L[o + 1], L[o + 2], L[o + 3], L[o + 4], L[o + 5], L[o + 6], L[o + 7]);
  };
  faces(e => { count[e]++; });
  const els: number[] = [];
  let total = 0, work = 0, size = 0;
  for (let e = 0; e < nel; e++) if (count[e]) { els.push(e); total += count[e]; work += count[e] * nbs[e] * nbs[e] * 2 + 60 * nbs[e] ** 3; size += nbs[e] * nbs[e]; }
  if (!els.length) return;
  const shared = worthSharing(work), f64 = (m: number) => (shared ? sharedF64(m) : new Float64Array(m));
  const sam = f64(7 * total), task = f64(TMEAS * els.length), blocks = f64(size), out = f64(els.length), fill = new Int32Array(nel);
  let from = 0, bo = 0;
  els.forEach((e, t) => {
    const E = grid.elems[e], nb = nbs[e];
    task.set([from, from + count[e], bo, E.c[0], E.c[1], E.c[2], E.s, nb, k3[3 * e], k3[3 * e + 1], k3[3 * e + 2]], TMEAS * t);
    blocks.set(A.block(e, e).subarray(0, nb * nb), bo);
    fill[e] = from;
    from += count[e];
    bo += nb * nb;
  });
  faces((e, x, y, z, w, nx, ny, nz) => { const o = 7 * fill[e]++; sam[o] = x; sam[o + 1] = y; sam[o + 2] = z; sam[o + 3] = w; sam[o + 4] = nx; sam[o + 5] = ny; sam[o + 6] = nz; });
  if (shared) parallelFor({ kind: "tmeasure", n: els.length, p: bas.p, sam, task, blocks, out } satisfies Omit<TMeasureJob, "ctl">);
  else {
    const T = new Float64Array(c.nb * c.nb), M = new Float64Array(c.nb);
    for (let t = 0; t < els.length; t++) out[t] = measureCell(t, sam, task, blocks, bas, T, M);
  }
  els.forEach((e, t) => {
    const need = Math.min(40 * gam[e], 1.15 * 2 * out[t]);
    if (need > gam[e]) gam[e] = need;
  });
}
/** Numbers per element of a penalty loop: first and end sample, place of its block, centre, half size, functions, k along X, Y, Z. */
const TMEAS = 11;
/** The largest λ of T x = λ K x of one cut element: T = Σ w (k ∂N/∂n)² over its samples, K its conduction block. */
function measureCell(t: number, sam: ArrayLike<number>, task: ArrayLike<number>, blocks: Float64Array, bas: Basis, T: Float64Array, M: Float64Array): number {
  const o = TMEAS * t, nb = task[o + 7], cc = [task[o + 3], task[o + 4], task[o + 5]], sz = task[o + 6], g = bas.g;
  T.fill(0, 0, nb * nb);
  for (let q = task[o]; q < task[o + 1]; q++) {
    const s = 7 * q, w = sam[s + 3];
    bas.eval(sam[s], sam[s + 1], sam[s + 2], cc, sz, nb);
    const kx = task[o + 8] * sam[s + 4], ky = task[o + 9] * sam[s + 5], kz = task[o + 10] * sam[s + 6];
    for (let a = 0; a < nb; a++) M[a] = g[3 * a] * kx + g[3 * a + 1] * ky + g[3 * a + 2] * kz;
    for (let a = 0; a < nb; a++) { const m = w * M[a], r = a * nb; for (let b = 0; b <= a; b++) T[r + b] += m * M[b]; }
  }
  for (let a = 0; a < nb; a++) for (let b = 0; b < a; b++) T[b * nb + a] = T[a * nb + b];
  return topEigen(T.subarray(0, nb * nb), blocks.subarray(task[o + 2], task[o + 2] + nb * nb), nb);
}
interface TMeasureJob extends ParJob { p: number; sam: Float64Array; task: Float64Array; blocks: Float64Array; out: Float64Array }
kernel<TMeasureJob, { j: TMeasureJob; bas: Basis; T: Float64Array; M: Float64Array }>("tmeasure", {
  init: j => { const bas = new Basis(j.p), nb = bas.v.length; return { j, bas, T: new Float64Array(nb * nb), M: new Float64Array(nb) }; },
  run({ j, bas, T, M }, t) { j.out[t] = measureCell(t, j.sam, j.task, j.blocks, bas, T, M); },
});


function pair(ni: number, nb: number, K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, Nj: Float64Array, Mj: Float64Array, sj: number, w: number, gamma: number) {
  const hw = 0.5 * w, gw = gamma * w * si * sj;
  for (let a = 0; a < ni; a++) {
    const na = Ni[a] * si * hw, ma = Mi[a] * sj * hw, ga = gw * Ni[a], r = a * nb;
    for (let b = 0; b < nb; b++) K[r + b] += -na * Mj[b] - ma * Nj[b] + ga * Nj[b];
  }
}

/** Numbers kept per joining point: contact, elements a and b, x, y, z, w, normal, γ (0 with a conductance), conductance. */
const JOIN = 12;

/**
 * Domains joined where one's surface lies on another's (FR-TCON-001): a point of A's surface is on B when a
 * step along the normal (or the gap) ends inside B. Perfect contact = the terms between elements, each side
 * with its own conductivity; a resistance = a conductance between the two temperatures.
 */
function joinTerms(c: Ctx, A: BlockMatrix, tq: number): { contacts: ThermalContact[]; joins: number[] } {
  const { grid, nb, nbs, bas, bas2, gam, k3, pb } = c, doms = c.doms!, nd = doms.length;
  const contacts: ThermalContact[] = [], joins: number[] = [];
  const eps = 2e-3 * grid.h, gap = Math.max(0, pb.gap ?? 0), far = gap + eps;
  const how = new Map<number, ThermalLink>();
  for (const l of pb.links ?? []) {
    if (l.type === "resistance" && !(l.h! > 0)) throw new Error("E-TH-CONTACT");
    how.set(Math.min(l.a, l.b) * nd + Math.max(l.a, l.b), l);
  }
  const boxes = doms.map(d => triBox(d.tris)), found = new Map<number, number>();
  const MA = new Float64Array(nb), MB = new Float64Array(nb);
  for (let a = 0; a + 1 < nd; a++) {
    const near: number[] = [];
    for (let d = a + 1; d < nd; d++) {
      if (how.get(a * nd + d)?.type === "none") continue;
      let apart = false;
      for (let k = 0; k < 3; k++) if (boxes[a][k] > boxes[d][3 + k] + far || boxes[d][k] > boxes[a][3 + k] + far) apart = true;
      if (!apart) near.push(d);
    }
    if (!near.length) continue;
    const T = doms[a].tris, { pts, tri } = gridTrianglePoints(T, grid.lo, grid.h, tq), nrms = triNormals(T);
    for (let q = 0; q < pts.n; q++) {
      const o = 4 * q, t = tri[q], w = pts.a[o + 3], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
      const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
      let b = -1, bx = 0, by = 0, bz = 0;
      for (const d of near) {
        const B = boxes[d];
        if (x < B[0] - far || y < B[1] - far || z < B[2] - far || x > B[3] + far || y > B[4] + far || z > B[5] + far) continue;
        for (const st of gap > 0 ? [eps, far] : [eps]) {
          bx = x + st * nx; by = y + st * ny; bz = z + st * nz;
          if (doms[d].inside(bx, by, bz)) { b = d; break; }
        }
        if (b >= 0) break;
      }
      if (b < 0) continue;
      const ca = grid.cellOf(x - eps * nx, y - eps * ny, z - eps * nz, a), cb = grid.cellOf(bx, by, bz, b);
      if (ca < 0 || cb < 0) continue;
      const link = how.get(a * nd + b), hc = link?.type === "resistance" ? link.h! : 0;
      let ci = found.get(a * nd + b);
      if (ci === undefined) { ci = contacts.length; found.set(a * nd + b, ci); contacts.push({ a, b, area: 0, type: hc ? "resistance" : "perfect", heat: 0, ta: 0, tb: 0 }); }
      contacts[ci].area += w;
      const ea = grid.cells[ca].el, eb = grid.cells[cb].el, EA = grid.elems[ea], EB = grid.elems[eb];
      bas.eval(x, y, z, EA.c, EA.s, c.nbs[ea]);
      bas2.eval(x, y, z, EB.c, EB.s, c.nbs[eb]);
      const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
      const ma = nbs[ea], mb = nbs[eb];
      if (hc) {
        const s = w * hc;
        for (let i = 0; i < ma; i++) {
          const na = s * bas.v[i];
          for (let j = 0; j < ma; j++) Kaa[i * ma + j] += na * bas.v[j];
          for (let j = 0; j < mb; j++) Kab[i * mb + j] -= na * bas2.v[j];
        }
        for (let i = 0; i < mb; i++) {
          const nb2 = s * bas2.v[i];
          for (let j = 0; j < ma; j++) Kba[i * ma + j] -= nb2 * bas.v[j];
          for (let j = 0; j < mb; j++) Kbb[i * mb + j] += nb2 * bas2.v[j];
        }
        joins.push(ci, ea, eb, x, y, z, w, nx, ny, nz, 0, hc);
        continue;
      }
      const oa = 3 * ea, ob = 3 * eb, [wa, wb] = joinWeights(k3, ea, eb, nx, ny, nz);
      const gamma = wa * gam[ea] + wb * gam[eb];
      const ax = k3[oa] * nx, ay = k3[oa + 1] * ny, az = k3[oa + 2] * nz, bx2 = k3[ob] * nx, by2 = k3[ob + 1] * ny, bz2 = k3[ob + 2] * nz;
      // pair() takes half of each side's flux: the weights make it wa·(A's) + wb·(B's)
      for (let i = 0; i < ma; i++) MA[i] = 2 * wa * (bas.g[3 * i] * ax + bas.g[3 * i + 1] * ay + bas.g[3 * i + 2] * az);
      for (let i = 0; i < mb; i++) MB[i] = 2 * wb * (bas2.g[3 * i] * bx2 + bas2.g[3 * i + 1] * by2 + bas2.g[3 * i + 2] * bz2);
      pair(ma, ma, Kaa, bas.v, MA, 1, bas.v, MA, 1, w, gamma);
      pair(ma, mb, Kab, bas.v, MA, 1, bas2.v, MB, -1, w, gamma);
      pair(mb, ma, Kba, bas2.v, MB, -1, bas.v, MA, 1, w, gamma);
      pair(mb, mb, Kbb, bas2.v, MB, -1, bas2.v, MB, -1, w, gamma);
      joins.push(ci, ea, eb, x, y, z, w, nx, ny, nz, gamma, 0);
    }
  }
  return { contacts, joins };
}

/**
 * The weights of each side's flux where two bodies meet: each the other side's conductivity across the contact over
 * the sum (Ern, Stephansen and Zunino), so the better conductor's flux, which its field resolves poorly there, counts
 * little; the plain mean (½, ½) made a hot part on a board read several per cent too cool. The penalty is weighted
 * the same way (it then goes as the harmonic mean of the two conductivities).
 */
function joinWeights(k3: Float64Array, ea: number, eb: number, nx: number, ny: number, nz: number): [number, number] {
  const oa = 3 * ea, ob = 3 * eb;
  const ka = k3[oa] * nx * nx + k3[oa + 1] * ny * ny + k3[oa + 2] * nz * nz, kb = k3[ob] * nx * nx + k3[ob + 1] * ny * ny + k3[ob + 2] * nz * nz;
  return ka + kb > 0 ? [kb / (ka + kb), ka / (ka + kb)] : [0.5, 0.5];
}

/** What passes each contact, W from a to b, and the mean temperature of both sides there. */
function contactFlows(c: Ctx, contacts: ThermalContact[], joins: number[], x: Float64Array) {
  const { grid, nbs, off, bas, bas2, k3 } = c;
  for (let o = 0; o < joins.length; o += JOIN) {
    const C = contacts[joins[o]], ea = joins[o + 1], eb = joins[o + 2], EA = grid.elems[ea], EB = grid.elems[eb];
    const w = joins[o + 6], nx = joins[o + 7], ny = joins[o + 8], nz = joins[o + 9];
    bas.eval(joins[o + 3], joins[o + 4], joins[o + 5], EA.c, EA.s, c.nbs[ea]);
    bas2.eval(joins[o + 3], joins[o + 4], joins[o + 5], EB.c, EB.s, c.nbs[eb]);
    const oa = 3 * ea, ob = 3 * eb, ax = k3[oa] * nx, ay = k3[oa + 1] * ny, az = k3[oa + 2] * nz, bx = k3[ob] * nx, by = k3[ob + 1] * ny, bz = k3[ob + 2] * nz;
    // da, db: k ∂T/∂n of each side
    let ta = 0, tb = 0, da = 0, db = 0;
    for (let i = 0; i < nbs[ea]; i++) {
      const va = x[off[ea] + i];
      ta += va * bas.v[i];
      da += va * (bas.g[3 * i] * ax + bas.g[3 * i + 1] * ay + bas.g[3 * i + 2] * az);
    }
    for (let i = 0; i < nbs[eb]; i++) {
      const vb = x[off[eb] + i];
      tb += vb * bas2.v[i];
      db += vb * (bas2.g[3 * i] * bx + bas2.g[3 * i + 1] * by + bas2.g[3 * i + 2] * bz);
    }
    C.ta += w * ta; C.tb += w * tb;
    const [wa, wb] = joinWeights(k3, ea, eb, nx, ny, nz);
    C.heat += joins[o + 11] > 0 ? w * joins[o + 11] * (ta - tb) : w * (-(wa * da + wb * db) + joins[o + 10] * (ta - tb));
  }
  for (const C of contacts) if (C.area > 0) { C.ta /= C.area; C.tb /= C.area; }
}

/** The points of some surface triangles that lie on no other domain: what the air around an assembly touches. */
function freePoints(c: Ctx, tris: ArrayLike<number>, q: number): Float64Array {
  const { grid, pb } = c, doms = c.doms!;
  const eps = 2e-3 * grid.h, far = Math.max(0, pb.gap ?? 0) + eps;
  const boxes = doms.map(d => triBox(d.tris));
  // through the kept triangles each point is asked once however many sinks hold it
  const K = c.loc && c.loc.q === q ? c.loc : null, kept = K ? keptPoints(c, K, tris, bodiesOf(c, tris), -1) : null;
  const L = kept ? kept.L : located(c, tris, q, -1, false), ids = kept ? kept.ids : null;
  let m = 0;
  for (let o = 0; o < L.length; o += 8) {
    const known = ids ? K!.free[ids[o / 8]] : 0;
    let on = known === 2;
    if (!known) {
      const x = L[o + 1], y = L[o + 2], z = L[o + 3], nx = L[o + 5], ny = L[o + 6], nz = L[o + 7], own = c.dom[L[o]];
      for (let d = 0; d < doms.length && !on; d++) {
        if (d === own) continue;
        const B = boxes[d];
        if (x < B[0] - far || y < B[1] - far || z < B[2] - far || x > B[3] + far || y > B[4] + far || z > B[5] + far) continue;
        on = doms[d].inside(x + eps * nx, y + eps * ny, z + eps * nz) || (far > eps && doms[d].inside(x + far * nx, y + far * ny, z + far * nz));
      }
      if (ids) K!.free[ids[o / 8]] = on ? 2 : 1;
    }
    if (on) continue;
    if (m !== o) { L.copyWithin(m, o, o + 8); if (ids) ids[m / 8] = ids[o / 8]; }
    m += 8;
  }
  return fitPlanar(c, L.subarray(0, m), ids ? ids.subarray(0, m / 8) : null);
}

/** The domains nothing takes heat from: no sink on them and none on anything they pass heat to. */
function looseDomains(c: Ctx, contacts: ThermalContact[], at: Float64Array[], ex: ExBuilt[] = []): number[] {
  const nd = c.doms!.length, root = Array.from({ length: nd }, (_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const C of contacts) root[find(C.a)] = find(C.b);
  // radiation between face sets joins the bodies its faces are on
  for (const X of ex) {
    if (!Number.isFinite(X.R)) continue;
    let d0 = -1;
    for (const L of [X.La, X.Lb]) for (let o = 0; o < L.length; o += 8) { const d = c.dom[L[o]]; if (d0 < 0) d0 = d; else root[find(d)] = find(d0); }
  }
  const held = new Set<number>();
  for (const L of at) for (let o = 0; o < L.length; o += 8) held.add(find(c.dom[L[o]]));
  const out: number[] = [];
  for (let d = 0; d < nd; d++) if (!held.has(find(d))) out.push(d);
  return out;
}

/** Elements joined across the faces between their cells: −½ [N]{k ∂N/∂n} − ½ {k ∂N/∂n}[N] + γ [N][N]. */
/**
 * One face between two elements: its four blocks summed over the face's points into S (aa, ab, ba, bb, each in a
 * quarter of the slot), from zero. The same sums on one thread and on several.
 */
function faceBlocks(S: Float64Array, q: number, a: ArrayLike<number>, from: number, end: number, axis: number, k: number, gamma: number,
  bas: Basis, bas2: Basis, ca: ArrayLike<number>, sa: number, cb: ArrayLike<number>, sb: number, ma: number, mb: number, MA: Float64Array, MB: Float64Array) {
  const Saa = S.subarray(0, ma * ma), Sab = S.subarray(q, q + ma * mb), Sba = S.subarray(2 * q, 2 * q + mb * ma), Sbb = S.subarray(3 * q, 3 * q + mb * mb);
  Saa.fill(0); Sab.fill(0); Sba.fill(0); Sbb.fill(0);
  // per point the four blocks are N c' + c N' with c = (γw/2) N ∓ (w/2) k ∂N/∂n of each side: aa and bb are
  // symmetric (their lower triangles are summed and mirrored), ba is ab turned over
  const NA = bas.v, NB = bas2.v;
  for (let i = from; i < end; i++) {
    const o4 = 4 * i, w = a[o4 + 3], x = a[o4], y = a[o4 + 1], z = a[o4 + 2];
    bas.eval(x, y, z, ca, sa, ma);
    bas2.eval(x, y, z, cb, sb, mb);
    const hw = 0.5 * w * k, gh = 0.5 * gamma * w;
    for (let b = 0; b < ma; b++) MA[b] = gh * NA[b] - hw * bas.g[3 * b + axis];
    for (let b = 0; b < mb; b++) MB[b] = gh * NB[b] + hw * bas2.g[3 * b + axis];
    for (let r = 0; r < ma; r++) {
      const n = NA[r], cc = MA[r], row = r * ma, rb = r * mb;
      for (let b = 0; b <= r; b++) Saa[row + b] += n * MA[b] + cc * NA[b];
      for (let b = 0; b < mb; b++) Sab[rb + b] -= n * MB[b] + cc * NB[b];
    }
    for (let r = 0; r < mb; r++) {
      const n = NB[r], cc = MB[r], row = r * mb;
      for (let b = 0; b <= r; b++) Sbb[row + b] += n * MB[b] + cc * NB[b];
    }
  }
  for (let r = 0; r < ma; r++) for (let b = 0; b < r; b++) Saa[b * ma + r] = Saa[r * ma + b];
  for (let r = 0; r < mb; r++) for (let b = 0; b < r; b++) Sbb[b * mb + r] = Sbb[r * mb + b];
  for (let r = 0; r < ma; r++) for (let b = 0; b < mb; b++) Sba[b * ma + r] = Sab[r * mb + b];
}
/** Adds a face's blocks to the matrix. */
function addFace(A: BlockMatrix, S: Float64Array, q: number, ea: number, eb: number, ma: number, mb: number) {
  const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
  for (let i = 0, n = ma * ma; i < n; i++) Kaa[i] += S[i];
  for (let i = 0, n = ma * mb; i < n; i++) { Kab[i] += S[q + i]; Kba[i] += S[2 * q + i]; }
  for (let i = 0, n = mb * mb; i < n; i++) Kbb[i] += S[3 * q + i];
}

/** The interior-penalty terms of the faces between cells of different elements, on all threads when the work is worth it. */
function faceTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nb, nbs, bas, bas2, gam, nel } = c;
  const faces: number[] = [];
  let work = 0;
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
    for (let axis = 0; axis < 3; axis++) {
      const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0), grid.cells[ci].dom);
      if (o < 0 || grid.cells[o].el === ea) continue;
      faces.push(ci, o, axis);
      work += (c.p + 1) ** 2 * (nbs[ea] + nbs[grid.cells[o].el]) ** 2 * 2;
    }
  }
  const nf = faces.length / 3, q = nb * nb, slot = 4 * q;
  const taskOf = (f: number) => {
    const ci = faces[3 * f], axis = faces[3 * f + 2], ea = grid.cells[ci].el, eb = grid.cells[faces[3 * f + 1]].el;
    return { axis, ea, eb, pts: facePts(c, ci, axis, Math.max(c.deg[ea], c.deg[eb])), k: c.k3[3 * ea + axis], gamma: Math.max(gam[ea], gam[eb]) };
  };
  if (!worthSharing(work)) {
    const S = new Float64Array(slot), MA = new Float64Array(nb), MB = new Float64Array(nb);
    for (let f = 0; f < nf; f++) {
      const t = taskOf(f), EA = grid.elems[t.ea], EB = grid.elems[t.eb];
      faceBlocks(S, q, t.pts.a, 0, t.pts.n, t.axis, t.k, t.gamma, bas, bas2, EA.c, EA.s, EB.c, EB.s, nbs[t.ea], nbs[t.eb], MA, MB);
      addFace(A, S, q, t.ea, t.eb, nbs[t.ea], nbs[t.eb]);
    }
    return;
  }
  const B = Math.max(1, Math.min(nf, 512, Math.floor(TFACE_SCRATCH / (8 * slot))));
  const out = sharedF64(B * slot), task = sharedF64(TFACE * B);
  let pts = sharedF64(4 * B * (2 * c.p + 1) ** 2);
  for (let f0 = 0; f0 < nf; f0 += B) {
    const n = Math.min(B, nf - f0), els: number[] = [];
    let np = 0;
    for (let t = 0; t < n; t++) {
      const T = taskOf(f0 + t), EA = grid.elems[T.ea], EB = grid.elems[T.eb], P = T.pts;
      if (4 * (np + P.n) > pts.length) { const more = sharedF64(Math.max(2 * pts.length, 4 * (np + P.n))); more.set(pts.subarray(0, 4 * np)); pts = more; }
      pts.set((P.a as Float64Array).subarray(0, 4 * P.n), 4 * np);
      task.set([np, P.n, T.axis, EA.c[0], EA.c[1], EA.c[2], EA.s, EB.c[0], EB.c[1], EB.c[2], EB.s, nbs[T.ea], nbs[T.eb], T.k, T.gamma], TFACE * t);
      els.push(T.ea, T.eb);
      np += P.n;
    }
    parallelFor({ kind: "tfaces", n, p: c.p, slot, pts, task, out } satisfies Omit<TFaceJob, "ctl">);
    progress("assemble", nel + ((f0 + n) * nel) / nf, 2 * nel);
    for (let t = 0; t < n; t++) addFace(A, out.subarray(slot * t, slot * (t + 1)), q, els[2 * t], els[2 * t + 1], nbs[els[2 * t]], nbs[els[2 * t + 1]]);
  }
}
/** Bytes of scratch a batch of faces may take, and the numbers per face of a shared face loop: first point, points,
 * axis, the two elements' centres and half sizes, their function counts, conductivity across, penalty. */
const TFACE_SCRATCH = 96e6, TFACE = 15;
interface TFaceJob extends ParJob { p: number; slot: number; pts: Float64Array; task: Float64Array; out: Float64Array }
kernel<TFaceJob, { j: TFaceJob; bas: Basis; bas2: Basis; MA: Float64Array; MB: Float64Array }>("tfaces", {
  init: j => { const bas = new Basis(j.p); return { j, bas, bas2: new Basis(j.p), MA: new Float64Array(bas.n), MB: new Float64Array(bas.n) }; },
  run({ j, bas, bas2, MA, MB }, t) {
    const k = j.task, o = TFACE * t;
    faceBlocks(j.out.subarray(j.slot * t, j.slot * (t + 1)), j.slot / 4, j.pts, k[o], k[o] + k[o + 1], k[o + 2], k[o + 13], k[o + 14],
      bas, bas2, [k[o + 3], k[o + 4], k[o + 5]], k[o + 6], [k[o + 7], k[o + 8], k[o + 9]], k[o + 10], k[o + 11], k[o + 12], MA, MB);
  },
});

/** A fixed temperature g on boundary points (Nitsche): K += −N_a M_b − M_a N_b + 2γ N_a N_b, f += (−M_a + 2γ N_a) g. */
function heldTerms(c: Ctx, A: BlockMatrix | null, f: Float64Array, L: Float64Array, g: number) {
  const { grid, nbs, off, bas, gam } = c, M = new Float64Array(c.nb);
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], nb = nbs[e], E = grid.elems[e], w = L[o + 4], K = A?.block(e, e), g2 = 2 * gam[e], fo = off[e];
    const kx = c.k3[3 * e] * L[o + 5], ky = c.k3[3 * e + 1] * L[o + 6], kz = c.k3[3 * e + 2] * L[o + 7];
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s, c.nbs[e]);
    for (let a = 0; a < nb; a++) M[a] = bas.g[3 * a] * kx + bas.g[3 * a + 1] * ky + bas.g[3 * a + 2] * kz;
    for (let a = 0; a < nb; a++) {
      const na = bas.v[a], r = a * nb;
      f[fo + a] += w * (g2 * na - M[a]) * g;
      if (K) for (let b = 0; b < nb; b++) K[r + b] += w * (-na * M[b] - M[a] * bas.v[b] + g2 * na * bas.v[b]);
    }
  }
}

/**
 * A film on boundary points: K += h w N_a N_b, f += h w T∞ N_a. `rad` > 0 makes it radiation of that emissivity,
 * linearised about the temperatures `x` (°C): q = εσ(T⁴ − Ts⁴) ≈ q(T₀) + 4εσT₀³ (T − T₀).
 */
function filmTerms(c: Ctx, A: BlockMatrix | null, f: Float64Array, L: Float64Array, h: number | ArrayLike<number>, amb: number, rad: number, x: Float64Array | null) {
  const per = typeof h === "number" ? null : h;
  surfaceTerms(c, A, f, L, per, per ? 1 : 0, [0, per ? 0 : (h as number), amb, rad, x ? 1 : 0, 0, 0, 0, 0], x);
}

/**
 * Natural convection on boundary points: q = h(T)(T − T∞) with h ∝ |T − T∞|^¼, linearised about the temperatures
 * in `x` (dq/dT = 1.25 h); none yet = a plain film taken 10 K hotter than the air.
 */
function naturalTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, s: ThermalSink, lens: Float64Array, x: Float64Array | null) {
  const nat = s.natural!;
  surfaceTerms(c, A, f, L, lens, 2, [2, 0, s.ambient ?? 0, 0, x ? 1 : 0, nat.factor, nat.down[0], nat.down[1], nat.down[2]], x);
}

/**
 * One element's share of a film, radiation or natural convection, summed from zero into `S` (its nb × nb matrix,
 * then its nb load values) over the points `order[from..end)` of `L`. `par` = kind (0 film or radiation, 2 natural),
 * film coefficient, ambient, emissivity, whether `x` holds temperatures, natural factor, down (3).
 */
function filmCell(S: Float64Array, nb: number, mat: boolean, L: ArrayLike<number>, order: ArrayLike<number>, from: number, end: number, bas: Basis,
  cc: ArrayLike<number>, sz: number, par: ArrayLike<number>, per: ArrayLike<number> | null, stride: number, x: ArrayLike<number> | null, fo: number,
  vals: Float64Array | null, task: Float64Array, slot: number) {
  const f0 = nb * nb, amb = par[2], rad = par[3], hasX = par[4] > 0 && !!x;
  // what a point gives whatever the temperatures are, the functions' values and the Legendre values its moments
  // are made of, is kept with the plan (`vals`, `filmRecord` numbers per point): made by the first loop over this element
  const top2 = 2 * degreeOf(nb), rs = nb + 3 * (top2 + 1);
  let vb = 0;
  if (vals) {
    vb = task[slot];
    if (vb < 0) {
      vb = -vb - 1;
      for (let q = from, b = vb; q < end; q++, b += rs) {
        const o = 8 * order[q];
        bas.values(L[o + 1], L[o + 2], L[o + 3], cc, sz, nb);
        for (let a = 0; a < nb; a++) vals[b + a] = bas.v[a];
        legendrePoint(top2, L[o + 1], L[o + 2], L[o + 3], cc, sz, vals, b + nb);
      }
      task[slot] = vb;
    }
  }
  const v = vals ?? bas.v;
  // the matrix Σ w h N_a N_b comes from the points' moments weighted by w h (`moments.ts`)
  const T = mat ? momentTables(bas.p) : null, top = mat ? 2 * degreeOf(nb) : 0;
  S.fill(0, 0, f0 + nb);
  for (let q = from; q < end; q++) {
    const i = order[q], o = 8 * i, w = L[o + 4], vo = vals ? vb + (q - from) * rs : 0;
    if (!vals) bas.values(L[o + 1], L[o + 2], L[o + 3], cc, sz, nb);
    let hh: number, rhs: number;
    if (par[0] === 2) {
      let t0 = amb + 10;
      if (hasX) { t0 = 0; for (let a = 0; a < nb; a++) t0 += v[vo + a] * x![fo + a]; }
      const up = -(L[o + 5] * par[6] + L[o + 6] * par[7] + L[o + 7] * par[8]);
      const h = par[5] * naturalH(up, t0 - amb, per![2 * i], per![2 * i + 1]);
      hh = hasX ? 1.25 * h : h;
      rhs = hasX ? hh * t0 - h * (t0 - amb) : h * amb;
    } else {
      const hp = stride ? per![i] : par[1];
      hh = hp;
      rhs = hp * amb;
      if (rad > 0) {
        let t0 = amb;
        if (hasX) { t0 = 0; for (let a = 0; a < nb; a++) t0 += v[vo + a] * x![fo + a]; }
        const T0 = Math.max(1, t0 + KELVIN), Ts = amb + KELVIN, es = rad * SIGMA;
        const T2 = T0 * T0, S2 = Ts * Ts;
        hh = 4 * es * (T2 * T0);
        rhs = hh * t0 - es * (T2 * T2 - S2 * S2);
      }
    }
    const wr = w * rhs;
    for (let a = 0; a < nb; a++) S[f0 + a] += wr * v[vo + a];
    if (T) { if (vals) momentsKept(T, vals, vo + nb, w * hh, top); else momentsPoint(T, L[o + 1], L[o + 2], L[o + 3], w * hh, cc, sz, top); }
  }
  if (T) { massFromMoments(T, S, nb); momentsClear(T); }
}

/** The points of one surface item by element, kept with the item's points: what a loop over its elements needs. */
interface FilmPlan { c: Ctx; shared: boolean; work: number; n: number; L: Float64Array; order: Int32Array; task: Float64Array; per: Float64Array | null; out: Float64Array; vals: Float64Array | null; where: Int32Array | null }
/** Numbers per element of a surface loop: element, first and end place in `order`, place in `out`, centre, half size, functions, first unknown,
 * place of its points' function values in `vals` (−place − 1 until they are made). */
const TFILM = 11;
/** Function values kept at surface points (`FilmPlan.vals`), numbers per build at most: beyond it they are evaluated every time. */
let FILM_VALUES = 24e6;
/** Tests: how many numbers may be kept at surface points (0 = evaluate every time). */
export const setFilmValues = (n: number) => { FILM_VALUES = n; };
const filmKept = new WeakMap<Int32Array, number>();
const filmRecord = (nb: number) => nb + 3 * (2 * degreeOf(nb) + 1);
const filmPlans = new WeakMap<Float64Array, FilmPlan>();
function filmPlan(c: Ctx, L: Float64Array, per: ArrayLike<number> | null, stride: number): FilmPlan {
  const had = filmPlans.get(L);
  if (had && had.c === c) return had;
  const { grid, nbs, off } = c, n = L.length / 8, count = new Map<number, number>();
  let work = 0;
  for (let i = 0; i < n; i++) { const e = L[8 * i]; count.set(e, (count.get(e) ?? 0) + 1); work += 4 * nbs[e] * nbs[e]; }
  const shared = worthSharing(work), f64 = (m: number) => (shared ? sharedF64(m) : new Float64Array(m));
  const els = [...count.keys()].sort((a, b) => a - b), task = f64(TFILM * els.length), order = shared ? sharedI32(n) : new Int32Array(n), at = new Map<number, number>();
  let from = 0, size = 0, nv = 0;
  for (const e of els) nv += count.get(e)! * filmRecord(nbs[e]);
  const used = filmKept.get(off) ?? 0, keep = used + nv <= FILM_VALUES;
  if (keep) filmKept.set(off, used + nv);
  nv = 0;
  els.forEach((e, t) => {
    const E = grid.elems[e], m = count.get(e)!;
    task.set([e, from, from + m, size, E.c[0], E.c[1], E.c[2], E.s, nbs[e], off[e], -nv - 1], TFILM * t);
    nv += m * filmRecord(nbs[e]);
    at.set(e, from);
    from += m;
    size += nbs[e] * nbs[e] + nbs[e];
  });
  for (let i = 0; i < n; i++) { const e = L[8 * i], k = at.get(e)!; order[k] = i; at.set(e, k + 1); }
  let LL = L, pp = per ? (per as Float64Array) : null;
  if (shared) { LL = sharedF64(L.length); LL.set(L); if (per) { pp = sharedF64(stride * n); pp.set(per as Float64Array); } }
  const plan: FilmPlan = { c, shared, work, n: els.length, L: LL, order, task, per: pp, out: f64(size), vals: keep ? f64(nv) : null, where: null };
  filmPlans.set(L, plan);
  return plan;
}

/**
 * Films, radiation and natural convection on the points `L`: each element's terms are summed from zero (on all
 * threads when the work is worth it) and then added to its block and load in the elements' order, so the result
 * does not depend on the number of threads.
 */
function surfaceTerms(c: Ctx, A: BlockMatrix | null, f: Float64Array, L: Float64Array, per: ArrayLike<number> | null, stride: number, par: number[], x: Float64Array | null) {
  if (!L.length) return;
  const P = filmPlan(c, L, per, stride), { task, out } = P, mat = !!A;
  if (P.shared && worthSharing(P.work)) {
    parallelFor({ kind: "tfilm", n: P.n, p: c.bas.p, L: P.L, order: P.order, task, per: P.per, stride, x, par: Float64Array.from(par), mat, out, vals: P.vals } satisfies Omit<TFilmJob, "ctl">);
  } else {
    for (let t = 0; t < P.n; t++) {
      const o = TFILM * t, nb = task[o + 8];
      filmCell(out.subarray(task[o + 3], task[o + 3] + nb * nb + nb), nb, mat, P.L, P.order, task[o + 1], task[o + 2], c.bas, [task[o + 4], task[o + 5], task[o + 6]], task[o + 7], par, P.per, stride, x, task[o + 9], P.vals, task, o + 10);
    }
  }
  for (let t = 0; t < P.n; t++) {
    const o = TFILM * t, e = task[o], nb = task[o + 8], so = task[o + 3], fo = task[o + 9], f0 = so + nb * nb;
    for (let a = 0; a < nb; a++) f[fo + a] += out[f0 + a];
    if (A) { const K = A.block(e, e); for (let i = 0; i < nb * nb; i++) K[i] += out[so + i]; }
  }
}
interface TFilmJob extends ParJob { p: number; L: Float64Array; order: Int32Array; task: Float64Array; per: Float64Array | null; stride: number; x: Float64Array | null; par: Float64Array; mat: boolean; out: Float64Array; vals: Float64Array | null }
kernel<TFilmJob, { j: TFilmJob; bas: Basis }>("tfilm", {
  init: j => ({ j, bas: new Basis(j.p) }),
  run({ j, bas }, t) {
    const k = j.task, o = TFILM * t, nb = k[o + 8];
    filmCell(j.out.subarray(k[o + 3], k[o + 3] + nb * nb + nb), nb, j.mat, j.L, j.order, k[o + 1], k[o + 2], bas, [k[o + 4], k[o + 5], k[o + 6]], k[o + 7], j.par, j.per, j.stride, j.x, k[o + 9], j.vals, k, o + 10);
  },
});

/** Where each point of `L` has its function values in the plan's `vals` (null until every element's are made). */
function filmValues(c: Ctx, L: Float64Array): { vals: Float64Array; where: Int32Array } | null {
  const P = filmPlans.get(L);
  if (!P || !P.vals || P.c.grid !== c.grid || P.c.off !== c.off) return null;
  if (!P.where) {
    const { task, order } = P, where = new Int32Array(L.length / 8);
    for (let t = 0; t < P.n; t++) {
      const o = TFILM * t, vb = task[o + 10], nb = task[o + 8];
      if (vb < 0) return null;
      for (let q = task[o + 1], b = vb, rs = filmRecord(nb); q < task[o + 2]; q++, b += rs) where[order[q]] = b;
    }
    P.where = where;
  }
  return { vals: P.vals, where: P.where };
}

/** The points of a natural convection sink, located face by face so each keeps its face's sizes (2 numbers per point). */
function naturalPoints(c: Ctx, s: ThermalSink, q: number): { L: Float64Array; lens: Float64Array } {
  return groupedPoints(c, s, q, [s.natural!.lv, s.natural!.lh]);
}

/** The points of `s`, located in groups of triangles sharing the values `per` gives them, which each point keeps (one number per array). */
function groupedPoints(c: Ctx, s: ThermalSink, q: number, per: ArrayLike<number>[]): { L: Float64Array; lens: Float64Array } {
  const n = Math.floor(s.tris.length / 9), groups = new Map<string, number[]>();
  for (let t = 0; t < n; t++) {
    const key = per.map(a => a[t]).join("|");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(t);
  }
  const parts: Float64Array[] = [], lens: number[] = [];
  for (const g of groups.values()) {
    const sub = new Float64Array(9 * g.length);
    g.forEach((t, k) => { for (let j = 0; j < 9; j++) sub[9 * k + j] = s.tris[9 * t + j]; });
    const L = s.free && c.doms ? freePoints(c, sub, q) : located(c, sub, q);
    parts.push(L);
    for (let o = 0; o < L.length; o += 8) for (const a of per) lens.push(a[g[0]]);
  }
  const L = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let m = 0;
  for (const p of parts) { L.set(p, m); m += p.length; }
  return { L, lens: Float64Array.from(lens) };
}

/** The coefficients `prev` (degree-uniform layout of an earlier pass on the same cells) in this pass's layout, or null. */
function startFrom(c: Ctx, prev: Float64Array | null | undefined): Float64Array | null {
  const { nel, nbs, off } = c;
  if (!prev || !prev.length || prev.length % nel) return null;
  const pm = prev.length / nel, x = new Float64Array(off[nel]);
  for (let e = 0; e < nel; e++) for (let a = 0, n = Math.min(pm, nbs[e]); a < n; a++) x[off[e] + a] = prev[e * pm + a];
  return x;
}
function copyMatrix(A: BlockMatrix): BlockMatrix {
  const B = new BlockMatrix(A.nel, A.ms);
  for (const [key, blk] of A.blocks) { const a = Math.floor(key / A.nel); B.block(a, key - a * A.nel).set(blk); }
  return B;
}

/**
 * How a study's matrices are solved: directly while the factorisation is cheap (as the structural solver decides),
 * else by the iterative solver. Asked once per set of equations: the linearised and time-step matrices of one
 * `Ctx` have the same blocks, so they share the answer and the factorisation's plan.
 */
const solverPlans = new WeakMap<Ctx, { blocks: number; direct: boolean; plan?: CholPlan }>();
/**
 * How big a factorisation thermal solves still take directly: more than a static solve, since conjugate gradients
 * converge slowly across bodies whose conductivities differ by a thousand times (a board and its copper parts) and
 * a radiating study solves several times on one factorisation. A board's third pass (84,000 unknowns, 4.6e10
 * multiplications, 6.3e7 values) took 70 s by conjugate gradients and 42 s directly on three threads.
 */
export const THERMAL_FLOPS = 1.5e11, THERMAL_VALUES = 7.5e7;
function systemSolver(c: Ctx, A: BlockMatrix): Solver {
  const pb = c.pb;
  let how = solverPlans.get(c);
  if (!how || how.blocks !== A.blocks.size) {
    const fits = pb.solver ? { direct: pb.solver === "direct" } as ReturnType<typeof directFits> : directFits(A, DIRECT_LIMIT, THERMAL_FLOPS, THERMAL_VALUES);
    solverPlans.set(c, (how = { blocks: A.blocks.size, direct: fits.direct, plan: fits.plan }));
  }
  if (!how.direct) { const P = pcgSolver(A, { coarse: basisSize(1), tol: pb.tol ?? 1e-9 }); return { solve: (f, x0) => P.solve(f, x0 ?? undefined).x }; }
  const E = new BlockCholesky(A, { plan: how.plan });
  how.plan = E.plan;
  return { solve: f => E.solve(f) };
}

const isDirect = (c: Ctx) => !!solverPlans.get(c)?.direct;

/**
 * A x = f by conjugate gradients from `x0`, preconditioned by the solver of a matrix close to A (the same
 * equations linearised a step earlier). Null when it has not converged in `POLISH_STEPS` iterations.
 */
const POLISH_STEPS = 40, POLISH_TOL = 1e-11;
function polished(A: BlockMatrix, f: Float64Array, x0: Float64Array, pre: Solver): Float64Array | null {
  const n = f.length, x = Float64Array.from(x0), r = new Float64Array(n), q = new Float64Array(n);
  A.mul(x, q);
  let f2 = 0, r2 = 0;
  for (let i = 0; i < n; i++) { r[i] = f[i] - q[i]; f2 += f[i] * f[i]; r2 += r[i] * r[i]; }
  const stop = POLISH_TOL * POLISH_TOL * f2;
  if (r2 <= stop) return x;
  let z = pre.solve(r, null), rz = 0;
  const d = Float64Array.from(z);
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < POLISH_STEPS; it++) {
    A.mul(d, q);
    let dq = 0;
    for (let i = 0; i < n; i++) dq += d[i] * q[i];
    if (!(dq > 0)) return null;
    const a = rz / dq;
    r2 = 0;
    for (let i = 0; i < n; i++) { x[i] += a * d[i]; r[i] -= a * q[i]; r2 += r[i] * r[i]; }
    if (r2 <= stop) return x;
    z = pre.solve(r, null);
    let rz1 = 0;
    for (let i = 0; i < n; i++) rz1 += r[i] * z[i];
    const beta = rz1 / rz;
    rz = rz1;
    for (let i = 0; i < n; i++) d[i] = z[i] + beta * d[i];
  }
  return null;
}

function factorSystem(c: Ctx, A: BlockMatrix): Solver {
  const s = systemSolver(c, A);
  progress("solve", 0, 1);
  return s;
}

function solveSystem(c: Ctx, A: BlockMatrix, f: Float64Array, x0: Float64Array | null, lr: LowRank | null = null): Float64Array {
  return withLowRank(factorSystem(c, A), lr).solve(f, x0);
}

/** ∫ k |∇T|² and, with the pass before, the same of what this pass changed per element. */
function energies(c: Ctx, x: Float64Array, prev: Float64Array | null) {
  const { grid, nbs, off, nel, bas, k3 } = c, eta = new Float64Array(nel), pm = prev ? prev.length / nel : 0;
  let energy = 0;
  // xᵀ K x with each element's conduction matrix made from the moments of its points (as `volumeTerms` makes it)
  const T = momentTables(bas.p), K = new Float64Array(c.nb * c.nb), d = new Float64Array(c.nb);
  momentsClear(T);
  for (let e = 0; e < nel; e++) {
    const nb = nbs[e], E = grid.elems[e], o = off[e], top = Math.max(0, 2 * c.deg[e] - 2);
    for (const ci of E.cells) { const P = grid.cells[ci].pts; momentsAdd(T, P.a, 0, P.n, E.c, E.s, top); }
    K.fill(0, 0, nb * nb);
    conductFromMoments(T, K, nb, E.s, k3[3 * e], k3[3 * e + 1], k3[3 * e + 2]);
    momentsClear(T);
    if (prev) for (let a = 0; a < nb; a++) d[a] = x[o + a] - (a < pm ? prev[e * pm + a] : 0);
    let en = 0, et = 0;
    for (let a = 0; a < nb; a++) {
      const r = a * nb;
      let s1 = 0, s2 = 0;
      for (let b = 0; b < nb; b++) { s1 += K[r + b] * x[o + b]; if (prev) s2 += K[r + b] * d[b]; }
      en += x[o + a] * s1;
      if (prev) et += d[a] * s2;
    }
    energy += en;
    eta[e] = et > 0 ? et : 0;
  }
  return { energy, eta };
}

/** What a sink takes, W: the flux the terms above carry through its points. */
function flowOf(c: Ctx, s: ThermalSink, L: Float64Array, x: Float64Array, lens?: Float64Array): SinkFlow {
  const { grid, nbs, off, bas, k3, gam } = c, nat = s.natural, amb = s.ambient ?? 0;
  const forced = s.forced && s.temp === undefined && lens ? lens : null;
  const held = s.temp !== undefined;
  let out = 0, area = 0, sum = 0, hs = 0;
  const kept = held ? null : filmValues(c, L), ambK = (s.ambient ?? 0) + KELVIN, amb4 = ambK * ambK * (ambK * ambK);
  const by = c.doms ? new Float64Array(3 * c.doms.length) : null;
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], was = out;
    let rad = 0, t = 0, dn = 0;
    const nb = nbs[e], fo = off[e];
    if (held) {
      bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s, nb);
      for (let a = 0; a < nb; a++) {
        const v = x[fo + a];
        t += v * bas.v[a];
        dn += v * (bas.g[3 * a] * k3[3 * e] * L[o + 5] + bas.g[3 * a + 1] * k3[3 * e + 1] * L[o + 6] + bas.g[3 * a + 2] * k3[3 * e + 2] * L[o + 7]);
      }
    } else if (kept) {
      const b = kept.where[o / 8], V = kept.vals;
      for (let a = 0; a < nb; a++) t += x[fo + a] * V[b + a];
    } else {
      // only a held face's flow needs the gradients
      bas.values(L[o + 1], L[o + 2], L[o + 3], E.c, E.s, nb);
      for (let a = 0; a < nb; a++) t += x[fo + a] * bas.v[a];
    }
    area += w; sum += w * t;
    if (s.temp !== undefined) out += w * (-dn + 2 * gam[e] * (t - s.temp));
    if (s.temp === undefined && s.emissivity) { const T2 = (t + KELVIN) * (t + KELVIN); rad = w * s.emissivity * SIGMA * (T2 * T2 - amb4); out += rad; }
    if (s.temp === undefined && nat && lens) {
      const o2 = o / 4, up = -(L[o + 5] * nat.down[0] + L[o + 6] * nat.down[1] + L[o + 7] * nat.down[2]);
      const h = nat.factor * naturalH(up, t - amb, lens[o2], lens[o2 + 1]);
      hs += w * h;
      out += w * h * (t - amb);
    } else if (forced) { const h = forced[o / 8]; hs += w * h; out += w * h * (t - amb); }
    else if (s.temp === undefined) out += w * (s.h ?? 0) * (t - amb);
    if (by) { const d = 3 * c.dom[e]; if (s.temp !== undefined) by[d + 2] += out - was; else { by[d + 1] += rad; by[d] += out - was - rad; } }
  }
  return { out, area, mean: area > 0 ? sum / area : 0, ...(nat || forced ? { h: area > 0 ? hs / area : 0 } : {}), ...(by ? { doms: by } : {}) };
}

export const thermalMemory = (grid: Grid, p: number, degrees?: ArrayLike<number> | null) => memoryBytes(grid, e => basisSize(degrees ? Math.min(p, Math.max(1, degrees[e])) : p));

/** Most solves of a problem with radiation or natural convection. */
const RAD_STEPS = 40;

/** A problem set up for solving: the constant matrix and load, each source's load at full power, the sink points. */
interface Built {
  c: Ctx;
  A: BlockMatrix;
  /** The sinks' part of the load (fixed temperatures, films). */
  f: Float64Array;
  /** Each source's load vector at its full power, and the heat it puts in, W. */
  fs: Float64Array[];
  put: number[];
  at: Float64Array[];
  lens: (Float64Array | undefined)[];
  /** Sinks with radiation or natural convection: they depend on the temperatures. */
  rads: number[];
  contacts: ThermalContact[];
  joins: number[];
  volume: number;
  volumes: number[];
  memory: number;
  /** Radiation between face sets, and the temperature its first linearisation is taken at, °C. */
  ex: ExBuilt[];
  t0: number;
}

/** One radiation exchange set up: the points of each set, ∫N / area over each (mean temperature = u · x), areas, R. */
interface ExBuilt {
  La: Float64Array;
  Lb: Float64Array;
  ua: Float64Array;
  ub: Float64Array;
  aa: number;
  ab: number;
  R: number;
  f: number;
  da: number;
  db: number;
}

/** The points of each set of an exchange and the vectors giving their mean temperatures. */
function exchangeOf(c: Ctx, X: ThermalExchange, tq: number): ExBuilt {
  const n = c.off[c.nel], mean = (L: Float64Array) => {
    const u = new Float64Array(n), by = new Float64Array(c.doms ? c.doms.length : 1);
    let area = 0;
    for (let o = 0; o < L.length; o += 8) {
      const e = L[o], E = c.grid.elems[e], w = L[o + 4];
      c.bas.values(L[o + 1], L[o + 2], L[o + 3], E.c, E.s, c.nbs[e]);
      for (let a = 0; a < c.nbs[e]; a++) u[c.off[e] + a] += w * c.bas.v[a];
      area += w;
      by[c.dom[e]] += w;
    }
    if (area > 0) for (let i = 0; i < n; i++) u[i] /= area;
    let d = 0;
    for (let i = 1; i < by.length; i++) if (by[i] > by[d]) d = i;
    return { u, area, d };
  };
  const La = located(c, X.a, tq), Lb = located(c, X.b, tq), A = mean(La), B = mean(Lb);
  return { La, Lb, ua: A.u, ub: B.u, aa: A.area, ab: B.area, R: exchangeResistance(X.ea, X.eb, A.area, B.area, X.f), f: X.f, da: A.d, db: B.d };
}


const dot = (u: Float64Array, v: Float64Array) => { let s = 0; for (let i = 0; i < u.length; i++) s += u[i] * v[i]; return s; };

/** A low-rank change of a matrix: + U C Uᵀ, kept as U and C⁻¹ (m × m, row-major; C need not be symmetric). */
interface LowRank { U: Float64Array[]; cinv: Float64Array }

/** A solver of (A + U C Uᵀ) x = f from one of A (Woodbury): A⁻¹f − Z S⁻¹ Uᵀ A⁻¹f, Z = A⁻¹U, S = C⁻¹ + UᵀZ. */
function withLowRank(s: Solver, lr: LowRank | null): Solver {
  if (!lr || !lr.U.length) return s;
  const m = lr.U.length, Z = lr.U.map(u => s.solve(u, null)), S = Float64Array.from(lr.cinv);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) S[i * m + j] += dot(lr.U[i], Z[j]);
  return {
    solve(f, x0) {
      const y = s.solve(f, x0), r = lr.U.map(u => dot(u, y)), c = denseSolve(S, r, m);
      for (let j = 0; j < m; j++) { const z = Z[j], cj = c[j]; for (let i = 0; i < y.length; i++) y[i] -= cj * z[i]; }
      return y;
    },
  };
}

/** A small dense solve with partial pivoting (S is m × m, row-major; not changed). */
function denseSolve(S0: Float64Array, r0: number[], m: number): number[] {
  const S = Float64Array.from(S0), r = r0.slice();
  for (let k = 0; k < m; k++) {
    let p = k;
    for (let i = k + 1; i < m; i++) if (Math.abs(S[i * m + k]) > Math.abs(S[p * m + k])) p = i;
    if (p !== k) { for (let j = 0; j < m; j++) { const t = S[k * m + j]; S[k * m + j] = S[p * m + j]; S[p * m + j] = t; } const t = r[k]; r[k] = r[p]; r[p] = t; }
    const d = S[k * m + k] || 1e-300;
    for (let i = k + 1; i < m; i++) { const q = S[i * m + k] / d; if (!q) continue; for (let j = k; j < m; j++) S[i * m + j] -= q * S[k * m + j]; r[i] -= q * r[k]; }
  }
  const x = new Array<number>(m).fill(0);
  for (let k = m - 1; k >= 0; k--) { let v = r[k]; for (let j = k + 1; j < m; j++) v -= S[k * m + j] * x[j]; x[k] = v / (S[k * m + k] || 1e-300); }
  return x;
}

interface Solver { solve(f: Float64Array, x0: Float64Array | null): Float64Array }

function build(pb: ThermalProblem, scaleBy?: Float64Array | ((dom: Uint8Array) => Float64Array) | null): Built {
  const p = pb.p;
  const doms = pb.domains && pb.domains.length > 1 ? pb.domains : null;
  if (doms ? doms.some(d => !(d.k > 0) || (d.k3 && !(d.k3.length === 3 && d.k3.every(v => v > 0)))) : !(pb.k > 0) || (pb.k3 && !(pb.k3.length === 3 && pb.k3.every(v => v > 0)))) throw new Error("E-TH-NOK");
  if (!pb.sinks.length) throw new Error("E-TH-NOSINK");
  let grid = pb.grid;
  const deg0 = grid && pb.degrees && pb.degrees.length === grid.elems.length ? pb.degrees : null;
  const degOf = (e: number) => (deg0 ? Math.min(p, Math.max(1, deg0[e])) : p);
  if (grid) refit(grid, p + 1, 2 * p + 1, deg0 ? cl => degOf(cl.el) : undefined);
  else grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q: p + 1, depth: pb.depth ?? 3, fit: 2 * p + 1, domains: doms?.map(d => d.inside) });
  const nb = basisSize(p), nel = grid.elems.length;
  const nbs = Int32Array.from({ length: nel }, (_, e) => basisSize(degOf(e))), off = new Int32Array(nel + 1);
  for (let e = 0; e < nel; e++) off[e + 1] = off[e] + nbs[e];
  const memory = thermalMemory(grid, p, deg0);
  if (memory > (pb.memory ?? MEMORY_LIMIT)) throw new Error(`E-SIM-MEMORY: ${memoryMb(memory)}`);
  const g1 = grid, dom = Uint8Array.from(grid.elems, E => (doms ? g1.cells[E.cells[0]].dom : 0));
  const k3 = new Float64Array(3 * nel), ke = new Float64Array(nel);
  const scale = typeof scaleBy === "function" ? scaleBy(dom) : scaleBy;
  for (let e = 0; e < nel; e++) {
    const d = doms ? doms[dom[e]] : null, k = d ? d.k : pb.k;
    const m = scale ? scale[e] : 1;
    if (d?.kmap) {
      const E = grid.elems[e], [al, th] = kmapMean(d.kmap, E.c, E.s);
      for (let a = 0; a < 3; a++) k3[3 * e + a] = (a === d.kmap.axis ? th : al) * m;
    } else for (let a = 0; a < 3; a++) k3[3 * e + a] = (d ? (d.k3 ? d.k3[a] : k) : pb.k3 ? pb.k3[a] : k) * m;
    // the penalty goes by the best-conducting direction
    ke[e] = Math.max(k3[3 * e], k3[3 * e + 1], k3[3 * e + 2]);
  }
  const c: Ctx = { pb, grid, p, nb, nbs, off, deg: Uint8Array.from({ length: nel }, (_, e) => degOf(e)), nel, ke, k3, dom, doms, bas: new Basis(p), bas2: new Basis(p), gam: new Float64Array(nel), fitted: new Map() };
  for (let e = 0; e < nel; e++) {
    let fr = 0;
    for (const ci of grid.elems[e].cells) fr = Math.max(fr, grid.cells[ci].frac);
    c.gam[e] = ((pb.beta ?? 3) * ke[e]) / grid.h * (degOf(e) + 1) ** 2 / Math.min(1, Math.max(0.2, fr));
  }
  const tq = Math.max(2, p + 1);
  const A = new BlockMatrix(nel, nbs), f = new Float64Array(A.size);
  volumeTerms(c, A);
  if (doms && keepPoints) c.loc = newLoc(tq);
  const lens: (Float64Array | undefined)[] = [];
  // sinks on the same triangles (convection and radiation from all open surfaces) share their points
  const seen = [new Map<object, Float64Array>(), new Map<object, Float64Array>()];
  const at = pb.sinks.map((s, i) => {
    if (s.natural && s.temp === undefined) { const r = naturalPoints(c, s, tq); lens[i] = r.lens; return r.L; }
    if (s.forced && s.temp === undefined) { const r = groupedPoints(c, s, tq, [s.forced.h]); lens[i] = r.lens; return r.L; }
    const free = !!(s.free && doms), kept = seen[free ? 1 : 0], key = s.tris as object, had = kept.get(key);
    if (had) return had;
    const L = free ? freePoints(c, s.tris, tq) : located(c, s.tris, tq);
    kept.set(key, L);
    return L;
  });
  // the penalty is measured on the fixed-temperature faces and, with several domains, on every domain's surface
  const surf = at.filter((_L, i) => pb.sinks[i].temp !== undefined);
  if (doms) doms.forEach((d, i) => surf.push(located(c, d.tris, tq, i)));
  measure(c, A, surf);
  faceTerms(c, A);
  const { contacts, joins } = doms ? joinTerms(c, A, tq) : { contacts: [] as ThermalContact[], joins: [] as number[] };
  const ex = (pb.exchanges ?? []).map(X => exchangeOf(c, X, tq));
  if (doms) {
    const loose = looseDomains(c, contacts, at, ex);
    if (loose.length) throw new Error(`E-TH-LOOSE: ${loose.join(",")}`);
  }
  sinkLoad(c, A, f, at, lens);
  let volume = 0;
  const volumes = new Array<number>(doms ? doms.length : 1).fill(0);
  for (const cl of grid.cells) { const v = cl.pts.weight(); volume += v; volumes[doms ? cl.dom : 0] += v; }
  const fs: Float64Array[] = [], put: number[] = [];
  for (const s of pb.sources) { const r = sourceLoad(c, s, tq, volume, volumes); fs.push(r.f); put.push(r.put); }
  c.loc = undefined;
  const rads = pb.sinks.map((s, i) => (s.temp === undefined && ((s.emissivity ?? 0) > 0 || s.natural) ? i : -1)).filter(i => i >= 0);
  return { c, A, f, fs, put, at, lens, rads, contacts, joins, volume, volumes, memory, ex, t0: meanTemp(pb) };
}

const meanTemp = (pb: ThermalProblem) => { const temps = pb.sinks.map(s => s.temp ?? s.ambient ?? 0); return temps.reduce((a, v) => a + v, 0) / Math.max(1, temps.length); };

/** The fixed temperatures and films: their matrix terms into `A` (none = the load alone) and their load into `f`. */
function sinkLoad(c: Ctx, A: BlockMatrix | null, f: Float64Array, at: Float64Array[], lens: (Float64Array | undefined)[]) {
  c.pb.sinks.forEach((s, i) => {
    if (s.temp !== undefined) heldTerms(c, A, f, at[i], s.temp);
    else if (s.forced) filmTerms(c, A, f, at[i], lens[i]!, s.ambient ?? 0, 0, null);
    else if (!s.natural && (s.h ?? 0) > 0) filmTerms(c, A, f, at[i], s.h!, s.ambient ?? 0, 0, null);
  });
}

/**
 * FR-TSOL-021: the grid, matrix and factorisation of the last linear solve at each degree, kept while only
 * temperatures, ambients and powers change (`ThermalProblem.reuse` = the caller's key of everything else).
 */
const kept = { key: "", byP: new Map<number, { b: Built; solver: Solver }>() };
/** What the kept matrices may take, bytes (the factorisation about as much again). */
const REUSE_BYTES = 800 * 2 ** 20;
/** Solves answered from a kept factorisation (for tests). */
export let reusedSolves = 0;
export function dropReuse() { kept.key = ""; kept.byP.clear(); }

/** A kept build with this problem's loads: the sinks' load and each source's again on the same grid. */
function reloaded(b: Built, pb: ThermalProblem): Built {
  const c = { ...b.c, pb }, tq = Math.max(2, c.p + 1), f = new Float64Array(b.f.length);
  sinkLoad(c, null, f, b.at, b.lens);
  const fs: Float64Array[] = [], put: number[] = [];
  for (const s of pb.sources) { const r = sourceLoad(c, s, tq, b.volume, b.volumes); fs.push(r.f); put.push(r.put); }
  return { ...b, c, f, fs, put, t0: meanTemp(pb) };
}

/** One source's load vector at its full power and the heat it puts in, W. */
function sourceLoad(c: Ctx, s: ThermalSource, tq: number, volume: number, volumes: number[]): { f: Float64Array; put: number } {
  const { grid, nbs, off, nel, dom, doms } = c, f = new Float64Array(off[nel]);
  let put = 0;
  if (s.tris) {
    const area = triArea(s.tris), q = s.flux !== undefined ? s.flux : area > 0 ? (s.power ?? 0) / area : 0;
    const L = located(c, s.tris, tq);
    for (let o = 0; o < L.length; o += 8) {
      const e = L[o], E = grid.elems[e], w = q * L[o + 4];
      c.bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s, c.nbs[e]);
      for (let a = 0; a < nbs[e]; a++) f[off[e] + a] += w * c.bas.v[a];
      put += w;
    }
  } else if ((s.power || s.density) && volume > 0) {
    const only = doms && s.doms ? new Set(s.doms) : null;
    let vol = volume;
    if (only) { vol = 0; for (const d of only) vol += volumes[d] ?? 0; }
    if (!(vol > 0)) return { f, put };
    const power = s.density !== undefined ? s.density * vol : s.power!;
    const q = power / vol, T = momentTables(c.bas.p), ex = c.bas.ex;
    momentsClear(T);
    for (let e = 0; e < nel; e++) {
      if (only && !only.has(dom[e])) continue;
      const E = grid.elems[e];
      // Σ w N_a over the element's points = the moment of N_a's three degrees
      for (const ci of E.cells) { const P = grid.cells[ci].pts; momentsAdd(T, P.a, 0, P.n, E.c, E.s, c.deg[e]); }
      for (let a = 0; a < nbs[e]; a++) f[off[e] + a] += q * T.mom[(ex[3 * a] * T.m + ex[3 * a + 1]) * T.m + ex[3 * a + 2]];
      momentsClear(T);
    }
    put = power;
  }
  return { f, put };
}

/** The matrix and load with the temperature-dependent sinks linearised about `last` (none = their first guess). */
function linearised(b: Built, last: Float64Array | null): { B: BlockMatrix; g: Float64Array; lr: LowRank | null } {
  const B = copyMatrix(b.A), g = new Float64Array(b.f.length), pb = b.c.pb;
  for (const i of b.rads) {
    const s = pb.sinks[i];
    if (s.natural) naturalTerms(b.c, B, g, b.at[i], s, b.lens[i]!, last);
    else filmTerms(b.c, B, g, b.at[i], 0, s.ambient ?? 0, s.emissivity!, last);
  }
  // radiation between face sets, Newton-linearised about the last mean temperatures: Q ≈ Ga ta − Gb tb + q0
  // (Ga = 4σTa³/R). Each point of a carries Ga/area·T, of b Gb/area·T; the other set's mean is the rank-two part.
  const live = b.ex.filter(X => Number.isFinite(X.R));
  if (!live.length) return { B, g, lr: null };
  const U: Float64Array[] = [], m = 2 * live.length, cinv = new Float64Array(m * m), n = g.length;
  live.forEach((X, k) => {
    const ta = last ? dot(X.ua, last) : b.t0, tb = last ? dot(X.ub, last) : b.t0;
    const A0 = Math.max(1, ta + KELVIN), B0 = Math.max(1, tb + KELVIN);
    const Ga = (4 * SIGMA * A0 ** 3) / X.R, Gb = (4 * SIGMA * B0 ** 3) / X.R, q0 = (SIGMA * (A0 ** 4 - B0 ** 4)) / X.R - Ga * ta + Gb * tb;
    filmTerms(b.c, B, g, X.La, Ga / X.aa, 0, 0, null);
    filmTerms(b.c, B, g, X.Lb, Gb / X.ab, 0, 0, null);
    for (let i = 0; i < n; i++) g[i] += q0 * (X.ub[i] - X.ua[i]);
    U.push(X.ua, X.ub);
    // C = [[0, −Gb], [−Ga, 0]] on (a, b), so U C Uᵀ = −Gb a bᵀ − Ga b aᵀ
    cinv[2 * k * m + 2 * k + 1] = -1 / Ga;
    cinv[(2 * k + 1) * m + 2 * k] = -1 / Gb;
  });
  return { B, g, lr: { U, cinv } };
}

/** Samples a solution at points (moved a little against their normals, so a surface point is read inside). */
function samplerOf(c: Ctx, x: Float64Array, local: Float32Array | null) {
  const { grid: g0, nbs, off, bas, k3, dom, doms } = c;
  const elAt = (px: number, py: number, pz: number) => {
    const cl = g0.cellOf(px, py, pz);
    if (cl < 0) return -1;
    const e = g0.cells[cl].el, E = g0.elems[e];
    bas.eval(px, py, pz, E.c, E.s, c.nbs[e]);
    return e;
  };
  const elIn = (cl: number, px: number, py: number, pz: number) => {
    if (cl < 0) return -1;
    const e = g0.cells[cl].el, E = g0.elems[e];
    bas.eval(px, py, pz, E.c, E.s, c.nbs[e]);
    return e;
  };
  const sample = (pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): ThermalSample => {
    const n = pos.length / 3, temp = new Float32Array(n), flux = new Float32Array(3 * n), err = new Float32Array(n);
    const hit = hits ? new Uint8Array(n) : undefined, eps = 1e-6 * g0.h, where = doms ? new Uint8Array(n) : undefined;
    const cells = typeof pos === "object" ? g0.cellsOf(pos, nrm, eps) : null;
    for (let i = 0; i < n; i++) {
      let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
      if (hit && (px < g0.lo[0] - eps || py < g0.lo[1] - eps || pz < g0.lo[2] - eps || px > g0.lo[0] + g0.n[0] * g0.h + eps || py > g0.lo[1] + g0.n[1] * g0.h + eps || pz > g0.lo[2] + g0.n[2] * g0.h + eps)) continue;
      const e = cells ? elIn(cells[i], px, py, pz) : elAt(px, py, pz);
      if (e < 0) continue;
      if (hit) hit[i] = 1;
      let t = 0, gx = 0, gy = 0, gz = 0;
      for (let a = 0; a < nbs[e]; a++) { const v = x[off[e] + a]; t += v * bas.v[a]; gx += v * bas.g[3 * a]; gy += v * bas.g[3 * a + 1]; gz += v * bas.g[3 * a + 2]; }
      if (where) where[i] = dom[e];
      temp[i] = t; flux[3 * i] = -k3[3 * e] * gx; flux[3 * i + 1] = -k3[3 * e + 1] * gy; flux[3 * i + 2] = -k3[3 * e + 2] * gz; err[i] = local ? local[e] : 0;
    }
    return { temp, flux, err, ...(hit ? { hit } : {}), ...(where ? { dom: where } : {}) };
  };
  const temp = (px: number, py: number, pz: number) => {
    const e = elAt(px, py, pz);
    if (e < 0) return NaN;
    let t = 0;
    for (let a = 0; a < nbs[e]; a++) t += x[off[e] + a] * bas.v[a];
    return t;
  };
  return { sample, temp };
}

/** A conductivity table's factor at a temperature: linear between the rows, the ends held. */
export function ktFactor(kt: ArrayLike<number>, t: number): number {
  const n = kt.length >> 1;
  if (!n) return 1;
  if (!(t > kt[0])) return kt[1];
  for (let i = 1; i < n; i++) {
    const t1 = kt[2 * i];
    if (t <= t1) { const t0 = kt[2 * i - 2], u = t1 > t0 ? (t - t0) / (t1 - t0) : 1; return kt[2 * i - 1] + u * (kt[2 * i + 1] - kt[2 * i - 1]); }
  }
  return kt[2 * n - 1];
}

/** The table of each element's body, or null when no body's conductivity changes with temperature. */
function ktOf(pb: ThermalProblem): ((dom: number) => number[] | undefined) | null {
  const doms = pb.domains && pb.domains.length > 1 ? pb.domains : null;
  if (doms) return doms.some(d => d.kt && d.kt.length >= 2) ? i => doms[i].kt : null;
  return pb.kt && pb.kt.length >= 2 ? () => pb.kt : null;
}

/** Each element's conductivity factor at its mean temperature in `x` (its constant coefficient). */
function ktScale(dom: Uint8Array, nb: number, tab: (dom: number) => number[] | undefined, x: Float64Array | null, t0: number): Float64Array {
  const s = new Float64Array(dom.length);
  for (let e = 0; e < dom.length; e++) { const kt = tab(dom[e]); s[e] = kt ? ktFactor(kt, x ? x[e * nb] : t0) : 1; }
  return s;
}

/** Most solves made again for a conductivity that changes with temperature, and the change in k they stop at. */
const KT_STEPS = 30, KT_TOL = 0.005;

export function solveThermal(pb: ThermalProblem): ThermalResult {
  if (!(pb.links ?? []).some(l => l.air !== undefined)) return solveLinked(pb);
  // FR-TCON-002: an air layer conducts by air's k at the joint's mean temperature: solved again until no layer's conductance changes by more than 0.5 %
  const t0 = startTemp(pb), raw = pb.links!;
  const meanOf = (r: ThermalResult, l: ThermalLink) => {
    const C = r.contacts?.find(c => (c.a === l.a && c.b === l.b) || (c.a === l.b && c.b === l.a));
    return C && C.area > 0 && Number.isFinite(C.ta + C.tb) ? (C.ta + C.tb) / 2 : t0;
  };
  let links = airLinks(raw, () => t0), r = solveLinked({ ...pb, links, reuse: undefined }), steps = 1;
  while (steps < KT_STEPS) {
    const next = airLinks(raw, l => meanOf(r, l));
    if (next.every((l, i) => raw[i].air === undefined || Math.abs(l.h! / links[i].h! - 1) <= KT_TOL)) break;
    links = next;
    r = solveLinked({ ...pb, links, grid: r.grid, reuse: undefined });
    steps++;
  }
  return { ...r, airSteps: steps };
}

function solveLinked(pb: ThermalProblem): ThermalResult {
  const tab = ktOf(pb);
  const linear = !tab && !(pb.exchanges ?? []).length && !pb.sinks.some(s => s.temp === undefined && ((s.emissivity ?? 0) > 0 || s.natural));
  if (pb.reuse && linear && !pb.degrees) {
    if (kept.key !== pb.reuse) dropReuse();
    const hit = kept.byP.get(pb.p);
    if (hit && (!pb.grid || pb.grid === hit.b.c.grid)) { reusedSolves++; return { ...solveOnce(pb, reloaded(hit.b, pb), 0, hit.solver), reused: true }; }
    const b = build(pb), solver = factorSystem(b.c, b.A);
    let bytes = 2 * b.memory;
    for (const k of kept.byP.values()) bytes += 2 * k.b.memory;
    if (bytes <= REUSE_BYTES) { kept.key = pb.reuse; kept.byP.set(pb.p, { b, solver }); }
    return solveOnce(pb, b, 0, solver);
  }
  if (!tab) return solveOnce(pb, build(pb), 0);
  // FR-TMAT-004: solved again with each element's k at the temperatures found until no k changes by more than 0.5 %
  const t0 = startTemp(pb);
  let scale = new Float64Array(0);
  let b = build(pb, dom => (scale = ktScale(dom, basisSize(pb.p), tab, null, t0)));
  let r = solveOnce(pb, b, 1);
  for (let it = 2; it <= KT_STEPS; it++) {
    const next = ktScale(b.c.dom, b.c.nb, tab, r.x, t0);
    let d = 0;
    for (let e = 0; e < next.length; e++) d = Math.max(d, Math.abs(next[e] / scale[e] - 1));
    if (d <= KT_TOL) break;
    scale = next;
    b = build({ ...pb, grid: b.c.grid }, scale);
    r = solveOnce(pb, b, it);
  }
  return r;
}

function solveOnce(pb: ThermalProblem, b: Built, kSteps: number, solver?: Solver): ThermalResult {
  const { c, A } = b, { grid, p, nel, nb, off } = c;
  const f = Float64Array.from(b.f);
  for (const fs of b.fs) for (let i = 0; i < f.length; i++) f[i] += fs[i];
  const applied = b.put.reduce((a, v) => a + v, 0);
  // radiation and natural convection depend on the temperatures: linearised about the last answer and solved again until they settle
  let x: Float64Array, iterations = 1;
  if (!b.rads.length && !b.ex.some(X => Number.isFinite(X.R))) x = solver ? solver.solve(f, null) : solveSystem(c, A, f, null);
  else {
    // the pass before's answer on these cells is where the loop starts (hierarchical basis: its coefficients lead each
    // element's), so a later pass settles in two or three steps instead of starting from the ambient again
    let last: Float64Array | null = startFrom(c, pb.prev), kept0: Solver | null = null;
    x = f;
    for (let it = 0; it < RAD_STEPS; it++) {
      const { B, g, lr } = linearised(b, last);
      for (let i = 0; i < g.length; i++) g[i] += f[i];
      // the films move little from one step to the next: the first step's factorisation, kept, solves the later
      // steps' equations in a few conjugate-gradient iterations (a new one only when that stalls)
      const y = !lr && kept0 && last ? polished(B, g, last, kept0) : null;
      if (y) x = y;
      else {
        const s0 = factorSystem(c, B);
        kept0 = lr || !isDirect(c) ? null : s0;
        x = withLowRank(s0, lr).solve(g, last);
      }
      iterations = it + 1;
      let d = 0, top = 0;
      if (last) for (let e = 0; e < nel; e++) { d = Math.max(d, Math.abs(x[off[e]] - last[off[e]])); top = Math.max(top, Math.abs(x[off[e]])); }
      const settled = !!last && d <= 1e-4 * Math.max(1, top);
      last = x;
      if (settled) break;
    }
  }
  const prev = pb.prev && pb.prev.length % nel === 0 ? pb.prev : null;
  const { energy, eta } = energies(c, x, prev);
  let etaSum = 0;
  for (let e = 0; e < nel; e++) etaSum += eta[e];
  const prevError = !prev ? null : energy > 0 ? 100 * Math.sqrt(etaSum / energy) : 0;
  const local = new Float32Array(nel);
  for (let e = 0; e < nel; e++) local[e] = prev && energy > 0 ? 100 * Math.sqrt((eta[e] * nel) / energy) : 0;
  const flows = pb.sinks.map((s, i) => flowOf(c, s, b.at[i], x, b.lens[i]));
  // fresh contact records: a kept build's are read again by the next solve
  const contacts = b.contacts.map(C => ({ ...C, ta: 0, tb: 0, heat: 0 }));
  contactFlows(c, contacts, b.joins, x);
  const sm = samplerOf(c, x, local);
  const exchanges = b.ex.length ? exchangeFlows(b, x) : undefined;
  // the coefficients in the layout of degree p everywhere (hierarchical basis: the missing ones are 0)
  let xs = x;
  if (A.size !== nel * nb) { xs = new Float64Array(nel * nb); for (let e = 0; e < nel; e++) xs.set(x.subarray(off[e], off[e + 1]), e * nb); }
  return { grid, p, dofs: A.size, memory: b.memory, x: xs, energy, applied, flows, iterations, ...(kSteps ? { kSteps } : {}), eta, prevError, volume: b.volume, contacts, volumes: b.volumes, ...(exchanges ? { exchanges } : {}), sample: sm.sample, temp: sm.temp };
}

/** What each radiation exchange passes at the temperatures `x` (the exchanges left out by a zero view factor are absent from `b.ex`). */
function exchangeFlows(b: Built, x: Float64Array): ExchangeFlow[] {
  return b.ex.map(X => {
    const ta = X.aa > 0 ? dot(X.ua, x) : NaN, tb = X.ab > 0 ? dot(X.ub, x) : NaN, A = ta + KELVIN, B = tb + KELVIN;
    return { heat: Number.isFinite(X.R) ? (SIGMA * (A ** 4 - B ** 4)) / X.R : 0, ta, tb, areaA: X.aa, areaB: X.ab, f: X.f, ...(b.c.doms ? { da: X.da, db: X.db } : {}) };
  });
}

/**
 * A transient run (FR-TSOL-006). `rc` = volumetric heat capacity ρ·cp, J/(mm³·K), one per domain (or one);
 * `factor(i, t)` = source i's share of its power at time t, s; `times` = the output times, s, the last = the end.
 */
export interface TransientRun {
  rc: number[];
  t0: number;
  times: number[];
  factor(i: number, t: number): number;
  /** Each output time's solution (the steps are interpolated to it): read the temperatures, what the sinks take and the heat put in. */
  frame(k: number, t: number, sample: (pos: ArrayLike<number>, nrm?: ArrayLike<number>) => ThermalSample, flows: SinkFlow[], applied: number): void;
  /** Allowed temperature change per step, K (at least 2 K). */
  step?: number;
  /** The longest step, s, so a power profile's changes are not stepped over. */
  maxStep?: number;
  /** Times a power jumps or turns, s: a step ends on each. */
  breaks?: number[];
  stop?(): boolean;
}

export interface TransientResult {
  grid: Grid;
  p: number;
  dofs: number;
  memory: number;
  steps: number;
  rejected: number;
  /** How many matrices were factored. */
  solves: number;
  /** Time steps used, s: smallest and largest. */
  dt: [number, number];
  volume: number;
  /** The heat capacity of the whole model, J/K. */
  capacity: number;
}

/** The capacity of each element: ρcp ∫ N_a N_b (diagonal blocks only), and the whole model's ρcp V. */
function capacity(c: Ctx, rc: number[]): { C: Float64Array[]; total: number } {
  const { grid, nb, nel, bas, dom } = c, C: Float64Array[] = [];
  let total = 0;
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e], K = new Float64Array(nb * nb), r0 = rc[Math.min(dom[e], rc.length - 1)] ?? rc[0];
    for (const ci of E.cells) {
      const P = grid.cells[ci].pts;
      for (let q = 0; q < P.n; q++) {
        const o = 4 * q, w = P.a[o + 3] * r0;
        total += w;
        bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s, c.nbs[e]);
        for (let a = 0; a < nb; a++) { const va = w * bas.v[a], r = a * nb; for (let b = 0; b < nb; b++) K[r + b] += va * bas.v[b]; }
      }
    }
    C.push(K);
  }
  return { C, total };
}

/** out += s·C y, element by element. */
function capMul(C: Float64Array[], nb: number, y: Float64Array, s: number, out: Float64Array) {
  for (let e = 0; e < C.length; e++) {
    const K = C[e], o = e * nb;
    for (let a = 0; a < nb; a++) { let v = 0; const r = a * nb; for (let b = 0; b < nb; b++) v += K[r + b] * y[o + b]; out[o + a] += s * v; }
  }
}

/** The finest step allowed is the end time over this, the coarsest the end time over `MIN_STEPS`. */
const MAX_STEPS = 2000, MIN_STEPS = 20;

/**
 * Steps a problem in time from a uniform temperature `t0` (FR-TSOL-006): backward Euler for the first step, BDF2 with
 * variable steps after it, on the consistent capacity matrix. The step is chosen from the temperature change per step
 * (halved and the step done again when it moved more than allowed, doubled after two quiet steps), from end / 2000 to
 * end / 20, always a power of two of the coarsest, so the few matrices met are factored once each. Radiation and natural
 * convection are linearised about the temperatures, again when they moved more than the step allowance since.
 */
export function transientThermal(pb: ThermalProblem, run: TransientRun): TransientResult {
  // a conductivity that changes with temperature is taken at the element temperatures, again whenever they moved more than the step allowance
  const tab = ktOf(pb);
  // an air layer is taken at the run's starting temperature
  if ((pb.links ?? []).some(l => l.air !== undefined)) pb = { ...pb, links: airLinks(pb.links!, () => run.t0) };
  // steps on one degree everywhere
  if (pb.degrees) pb = { ...pb, degrees: undefined };
  let b = build(pb, tab ? dom => ktScale(dom, basisSize(pb.p), tab, null, run.t0) : null), c = b.c;
  const { nb, nel, grid } = c;
  const { C, total } = capacity(c, run.rc);
  if (!(total > 0)) throw new Error("E-TH-NOCP");
  const end = run.times[run.times.length - 1];
  const dtMax = end / MIN_STEPS;
  const kMin = run.maxStep && run.maxStep < dtMax ? Math.ceil(Math.log2(dtMax / run.maxStep) - 1e-9) : 0;
  const kMax = Math.max(kMin, Math.floor(Math.log2(MAX_STEPS / MIN_STEPS)));
  const allow = Math.max(2, run.step ?? 2);
  const n = nel * nb, mean = (y: Float64Array, e: number) => y[e * nb];
  let y0 = new Float64Array(n), yPrev: Float64Array | null = null;
  for (let e = 0; e < nel; e++) y0[e * nb] = run.t0;
  const cache = new Map<string, Solver>();
  let made = 0;
  let lin: Float64Array | null = b.rads.length || b.ex.some(X => Number.isFinite(X.R)) || tab ? Float64Array.from(y0) : null, linGen = 0, linG: Float64Array | null = null, linB: BlockMatrix | null = null, linLr: LowRank | null = null;
  const relinearise = (rebuild: boolean) => {
    if (!lin) return;
    if (rebuild && tab) { const at = lin; b = build({ ...pb, grid }, dom => ktScale(dom, nb, tab, at, run.t0)); c = b.c; }
    if (b.rads.length || b.ex.length) { const r = linearised(b, lin); linB = r.B; linG = r.g; linLr = r.lr; } else { linB = null; linG = null; linLr = null; }
    linGen++;
  };
  relinearise(false);
  const solverFor = (a: number, key: string) => {
    const k = `${key}|${linGen}`, had = cache.get(k);
    if (had) return had;
    const B = copyMatrix(linB ?? b.A);
    for (let e = 0; e < nel; e++) { const K = B.block(e, e), Ce = C[e]; for (let i = 0; i < nb * nb; i++) K[i] += a * Ce[i]; }
    const s0 = systemSolver(c, B);
    const s = withLowRank(s0, linLr);
    // a new linearisation makes the older matrices useless
    for (const key2 of [...cache.keys()]) if (!key2.endsWith(`|${linGen}`)) cache.delete(key2);
    cache.set(k, s);
    made++;
    return s;
  };
  const loadAt = (t: number) => {
    const f = Float64Array.from(b.f);
    if (linG) for (let i = 0; i < n; i++) f[i] += linG[i];
    let put = 0;
    b.fs.forEach((fs, i) => { const m = run.factor(i, t); if (!m) return; put += m * b.put[i]; for (let j = 0; j < n; j++) f[j] += m * fs[j]; });
    return { f, put };
  };
  const putAt = (t: number) => b.put.reduce((a, v, i) => a + v * run.factor(i, t), 0);
  const emit = (k: number, t: number, y: Float64Array) => {
    const sm = samplerOf(c, y, null);
    run.frame(k, t, sm.sample, pb.sinks.map((s, i) => flowOf(c, s, b.at[i], y, b.lens[i])), putAt(t));
  };
  let out = 0;
  while (out < run.times.length && run.times[out] <= 0) emit(out++, run.times[out - 1] ?? 0, y0);
  const breaks = (run.breaks ?? []).filter(b2 => b2 > 0 && b2 < end).sort((a2, b2) => a2 - b2);
  let br = 0;
  let t = 0, k = Math.max(kMin, Math.min(kMax, 4)), dtLast = 0, steps = 0, rejected = 0, quiet = 0, dtLo = Infinity, dtHi = 0;
  while (out < run.times.length) {
    progress("time", t, end);
    if (run.stop?.()) throw new Error("E-SIM-STOPPED");
    let dt = dtMax / 2 ** k, clip = "";
    while (br < breaks.length && breaks[br] <= t + 1e-9 * end) br++;
    if (br < breaks.length && t + dt > breaks[br] + 1e-9 * end) { dt = breaks[br] - t; clip = `c${dt}`; }
    const w = yPrev && dtLast > 0 ? dt / dtLast : 0;
    // the power over the step: read at its middle, so a step that ends where a heater turns on has none of it
    const { f } = loadAt(t + dt / 2);
    let a: number, key: string;
    if (!yPrev) { a = 1 / dt; key = `be${k}${clip}`; capMul(C, nb, y0, a, f); }
    else {
      a = (1 + 2 * w) / ((1 + w) * dt); key = `b${k}${clip}|${w}`;
      capMul(C, nb, y0, (1 + w) / dt, f);
      capMul(C, nb, yPrev, -(w * w) / ((1 + w) * dt), f);
    }
    const y1 = solverFor(a, key).solve(f, y0);
    let moved = 0;
    for (let e = 0; e < nel; e++) moved = Math.max(moved, Math.abs(mean(y1, e) - mean(y0, e)));
    if (moved > allow && k < kMax && (!clip || dt > dtMax / 2 ** (k + 1))) { k++; rejected++; quiet = 0; continue; }
    steps++;
    dtLo = Math.min(dtLo, dt); dtHi = Math.max(dtHi, dt);
    const t1 = t + dt;
    while (out < run.times.length && run.times[out] <= t1 + 1e-9 * end) {
      const s = (run.times[out] - t) / dt, yo = new Float64Array(n);
      for (let i = 0; i < n; i++) yo[i] = y0[i] + s * (y1[i] - y0[i]);
      emit(out, run.times[out], yo);
      out++;
    }
    yPrev = y0; y0 = y1; t = t1; dtLast = dt;
    if (lin) {
      let d = 0;
      for (let e = 0; e < nel; e++) d = Math.max(d, Math.abs(mean(y0, e) - mean(lin, e)));
      if (d > allow) { lin = Float64Array.from(y0); relinearise(true); }
    }
    quiet = moved < allow / 4 ? quiet + 1 : 0;
    if (quiet >= 2 && k > kMin) { k--; quiet = 0; }
  }
  return { grid, p: c.p, dofs: b.A.size, memory: b.memory, steps, rejected, solves: made, dt: [dtLo === Infinity ? 0 : dtLo, dtHi], volume: b.volume, capacity: total };
}
