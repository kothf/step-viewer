// Thermal analysis (FRS-thermal TH2, FR-TSOL-001..): steady heat conduction on the structural solver's cells.
// One unknown per basis function (temperature, °C). Units: mm, W, K; conductivity W/(mm·K), film
// coefficient W/(mm²·K), flux W/mm². The same cut cells, hierarchical basis and interior-penalty coupling as
// `static.ts`; a fixed temperature is held by Nitsche terms, convection is a Robin term, radiation is
// linearised about the last temperatures and solved again until it settles.
// Pure: runs in the solver worker and in node tests. Work is split into small functions on purpose (a single
// large solve function is not optimised by the browser's compiler, see `measurePenalty` in static.ts).

import { Basis, basisSize } from "./basis";
import { BlockMatrix, Envelope } from "./sparse";
import { pcgSolver } from "./pcg";
import { makeGrid, refit, memoryBytes, type Grid } from "./grid";
import { facePoints, fitFacePoints, gridTrianglePoints, type Inside, type Points } from "./quad";
import { DIRECT_LIMIT, MEMORY_LIMIT, memoryMb, topEigen, triArea, triBox, triNormals } from "./static";

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
}

/**
 * Natural convection film coefficient for air, W/(mm²·K): the simplified laminar correlations (h = C (ΔT / L)^¼,
 * L in m) for a vertical plate (C 1.42, L = height), a horizontal plate with the hot side up (1.32, L = area /
 * perimeter) and with the hot side down (0.59). `up` = the normal's part along up (against gravity); a face cooler
 * than the air behaves like a hot one turned over.
 */
export function naturalH(up: number, dt: number, lv: number, lh: number): number {
  const d = Math.max(Math.abs(dt), 0.05), u = dt >= 0 ? up : -up;
  const [C, L] = u > Math.SQRT1_2 ? [1.32, lh] : u < -Math.SQRT1_2 ? [0.59, lh] : [1.42, lv];
  return 1e-6 * C * Math.sqrt(Math.sqrt(d / (Math.max(L, 1) * 1e-3)));
}

export interface ThermalSource {
  /** Faces the heat enters through; none = spread over the whole body's volume. */
  tris?: ArrayLike<number>;
  /** Total power, W (over the faces or the volume). */
  power?: number;
  /** Heat flux into the body, W/mm² (faces only). */
  flux?: number;
  /** Without faces and with `domains`: the heat is spread over the volume of these domains only. */
  doms?: number[];
  /** With faces: the domain they are on (bookkeeping only, for the heat made per component). */
  dom?: number;
  /** The study item it comes from (bookkeeping: its power profile in a transient study). */
  id?: string;
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

export interface ThermalProblem {
  lo: number[];
  hi: number[];
  inside: Inside;
  h: number;
  p: number;
  /** Conductivity, W/(mm·K) (not used with `domains`). */
  k: number;
  /** Its change with temperature (not used with `domains`): [°C, factor, …] as `ThermalDomain.kt`. */
  kt?: number[];
  /** Several bodies, joined where they touch (within `gap` mm) as `links` say. */
  domains?: ThermalDomain[];
  gap?: number;
  links?: ThermalLink[];
  sinks: ThermalSink[];
  sources: ThermalSource[];
  grid?: Grid;
  depth?: number;
  /** The pass before's coefficients on the same grid (for the error estimate). */
  prev?: Float64Array;
  solver?: "direct" | "pcg";
  tol?: number;
  beta?: number;
  memory?: number;
}

export interface SinkFlow {
  /** Heat leaving through this condition, W (negative = it brings heat in). */
  out: number;
  area: number;
  /** Mean temperature of its faces, °C. */
  mean: number;
  /** Natural convection: the mean film coefficient it came to, W/(mm²·K). */
  h?: number;
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
  eta: Float64Array;
  prevError: number | null;
  volume: number;
  /** With `domains`: where they touch and what passes there, and each one's volume. */
  contacts: ThermalContact[];
  volumes: number[];
  sample(pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): ThermalSample;
  temp(x: number, y: number, z: number): number;
}

interface Ctx {
  pb: ThermalProblem;
  grid: Grid;
  p: number;
  nb: number;
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
}

/** Boundary points of some triangles with the element each lies in: e, x, y, z, w, nx, ny, nz per point. */
function located(c: Ctx, tris: ArrayLike<number>, q: number, dom = -1): Float64Array {
  const g = c.grid, { pts, tri } = gridTrianglePoints(tris, g.lo, g.h, q), nrms = triNormals(tris), eps = 1e-7 * g.h;
  const out = new Float64Array(8 * pts.n);
  let n = 0;
  for (let i = 0; i < pts.n; i++) {
    const o = 4 * i, t = tri[i], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
    const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
    // nudged inwards so a point on a cell face lands in the cell the body is on
    const cl = g.cellOf(x - eps * nx, y - eps * ny, z - eps * nz, dom);
    if (cl < 0) continue;
    out.set([g.cells[cl].el, x, y, z, pts.a[o + 3], nx, ny, nz], 8 * n++);
  }
  return out.subarray(0, 8 * n);
}

function facePts(c: Ctx, ca: number, axis: number): Points {
  const g = c.grid, A0 = g.cells[ca], key = ca * 3 + axis, had = c.fitted.get(key);
  if (had) return had;
  let pts = g.faces.get(key);
  if (pts === undefined) {
    pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, c.doms ? c.doms[A0.dom].inside : c.pb.inside, c.pb.depth ?? 3);
    const area = g.h * g.h;
    g.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    pts = g.faces.get(key);
  }
  const out = pts ? fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, 2 * c.p + 1) : facePoints(axis, A0.hi[axis], A0.lo, A0.hi, c.p + 1, () => true, 0);
  c.fitted.set(key, out);
  return out;
}

/** Conduction inside the elements: K += k w ∇N_a · ∇N_b. */
function volumeTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nb, bas } = c;
  for (let e = 0; e < c.nel; e++) {
    const E = grid.elems[e], K = A.block(e, e), kx = c.k3[3 * e], ky = c.k3[3 * e + 1], kz = c.k3[3 * e + 2];
    for (const ci of E.cells) {
      const P = grid.cells[ci].pts;
      for (let q = 0; q < P.n; q++) {
        const o = 4 * q, w = P.a[o + 3];
        bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
        const g = bas.g;
        for (let a = 0; a < nb; a++) {
          const ax = g[3 * a] * w * kx, ay = g[3 * a + 1] * w * ky, az = g[3 * a + 2] * w * kz, r = a * nb;
          for (let b = 0; b < nb; b++) K[r + b] += ax * g[3 * b] + ay * g[3 * b + 1] + az * g[3 * b + 2];
        }
      }
    }
  }
}

/**
 * The penalty the cut elements need: γ = 2 λmax(T, K) with T = ∫ (k ∂N/∂n)² over the element's interior faces
 * and its fixed-temperature faces, K its conduction matrix; never under the formula's value.
 */
function measure(c: Ctx, A: BlockMatrix, held: Float64Array[]) {
  const { grid, nb, nel, bas, k3, gam } = c;
  const cut = new Uint8Array(nel);
  let any = false;
  for (let e = 0; e < nel; e++) if (grid.elems[e].cells.some(ci => grid.cells[ci].frac < 1 - 1e-9)) { cut[e] = 1; any = true; }
  if (!any) return;
  const TT: (Float64Array | undefined)[] = new Array(nel), M = new Float64Array(nb);
  const at = (e: number, x: number, y: number, z: number, w: number, nx: number, ny: number, nz: number) => {
    const E = grid.elems[e], T = TT[e] ?? (TT[e] = new Float64Array(nb * nb));
    bas.eval(x, y, z, E.c, E.s);
    const kx = k3[3 * e] * nx, ky = k3[3 * e + 1] * ny, kz = k3[3 * e + 2] * nz;
    for (let a = 0; a < nb; a++) M[a] = bas.g[3 * a] * kx + bas.g[3 * a + 1] * ky + bas.g[3 * a + 2] * kz;
    for (let a = 0; a < nb; a++) { const s = w * M[a], r = a * nb; for (let b = 0; b < nb; b++) T[r + b] += s * M[b]; }
  };
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
    for (let axis = 0; axis < 3; axis++) {
      const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0), grid.cells[ci].dom);
      if (o < 0) continue;
      const eb = grid.cells[o].el;
      if (ea === eb || !(cut[ea] || cut[eb])) continue;
      const pts = facePts(c, ci, axis), n = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
      for (let q = 0; q < pts.n; q++) {
        const o4 = 4 * q;
        if (cut[ea]) at(ea, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], n[0], n[1], n[2]);
        if (cut[eb]) at(eb, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], n[0], n[1], n[2]);
      }
    }
  }
  for (const L of held) for (let o = 0; o < L.length; o += 8) if (cut[L[o]]) at(L[o], L[o + 1], L[o + 2], L[o + 3], L[o + 4], L[o + 5], L[o + 6], L[o + 7]);
  for (let e = 0; e < nel; e++) {
    const T = TT[e];
    if (!T) continue;
    const need = Math.min(40 * gam[e], 1.15 * 2 * topEigen(T, A.block(e, e), nb));
    if (need > gam[e]) gam[e] = need;
  }
}

function pair(nb: number, K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, Nj: Float64Array, Mj: Float64Array, sj: number, w: number, gamma: number) {
  const hw = 0.5 * w, gw = gamma * w * si * sj;
  for (let a = 0; a < nb; a++) {
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
  const { grid, nb, bas, bas2, gam, k3, pb } = c, doms = c.doms!, nd = doms.length;
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
      bas.eval(x, y, z, EA.c, EA.s);
      bas2.eval(x, y, z, EB.c, EB.s);
      const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
      if (hc) {
        const s = w * hc;
        for (let i = 0; i < nb; i++) {
          const na = s * bas.v[i], nb2 = s * bas2.v[i], r = i * nb;
          for (let j = 0; j < nb; j++) {
            Kaa[r + j] += na * bas.v[j]; Kab[r + j] -= na * bas2.v[j];
            Kba[r + j] -= nb2 * bas.v[j]; Kbb[r + j] += nb2 * bas2.v[j];
          }
        }
        joins.push(ci, ea, eb, x, y, z, w, nx, ny, nz, 0, hc);
        continue;
      }
      const gamma = Math.max(gam[ea], gam[eb]), oa = 3 * ea, ob = 3 * eb;
      const ax = k3[oa] * nx, ay = k3[oa + 1] * ny, az = k3[oa + 2] * nz, bx2 = k3[ob] * nx, by2 = k3[ob + 1] * ny, bz2 = k3[ob + 2] * nz;
      for (let i = 0; i < nb; i++) {
        MA[i] = bas.g[3 * i] * ax + bas.g[3 * i + 1] * ay + bas.g[3 * i + 2] * az;
        MB[i] = bas2.g[3 * i] * bx2 + bas2.g[3 * i + 1] * by2 + bas2.g[3 * i + 2] * bz2;
      }
      pair(nb, Kaa, bas.v, MA, 1, bas.v, MA, 1, w, gamma);
      pair(nb, Kab, bas.v, MA, 1, bas2.v, MB, -1, w, gamma);
      pair(nb, Kba, bas2.v, MB, -1, bas.v, MA, 1, w, gamma);
      pair(nb, Kbb, bas2.v, MB, -1, bas2.v, MB, -1, w, gamma);
      joins.push(ci, ea, eb, x, y, z, w, nx, ny, nz, gamma, 0);
    }
  }
  return { contacts, joins };
}

/** What passes each contact, W from a to b, and the mean temperature of both sides there. */
function contactFlows(c: Ctx, contacts: ThermalContact[], joins: number[], x: Float64Array) {
  const { grid, nb, bas, bas2, k3 } = c;
  for (let o = 0; o < joins.length; o += JOIN) {
    const C = contacts[joins[o]], ea = joins[o + 1], eb = joins[o + 2], EA = grid.elems[ea], EB = grid.elems[eb];
    const w = joins[o + 6], nx = joins[o + 7], ny = joins[o + 8], nz = joins[o + 9];
    bas.eval(joins[o + 3], joins[o + 4], joins[o + 5], EA.c, EA.s);
    bas2.eval(joins[o + 3], joins[o + 4], joins[o + 5], EB.c, EB.s);
    const oa = 3 * ea, ob = 3 * eb, ax = k3[oa] * nx, ay = k3[oa + 1] * ny, az = k3[oa + 2] * nz, bx = k3[ob] * nx, by = k3[ob + 1] * ny, bz = k3[ob + 2] * nz;
    // da, db: k ∂T/∂n of each side
    let ta = 0, tb = 0, da = 0, db = 0;
    for (let i = 0; i < nb; i++) {
      const va = x[ea * nb + i], vb = x[eb * nb + i];
      ta += va * bas.v[i]; tb += vb * bas2.v[i];
      da += va * (bas.g[3 * i] * ax + bas.g[3 * i + 1] * ay + bas.g[3 * i + 2] * az);
      db += vb * (bas2.g[3 * i] * bx + bas2.g[3 * i + 1] * by + bas2.g[3 * i + 2] * bz);
    }
    C.ta += w * ta; C.tb += w * tb;
    C.heat += joins[o + 11] > 0 ? w * joins[o + 11] * (ta - tb) : w * (-0.5 * (da + db) + joins[o + 10] * (ta - tb));
  }
  for (const C of contacts) if (C.area > 0) { C.ta /= C.area; C.tb /= C.area; }
}

/** The points of some surface triangles that lie on no other domain: what the air around an assembly touches. */
function freePoints(c: Ctx, tris: ArrayLike<number>, q: number): Float64Array {
  const { grid, pb } = c, doms = c.doms!;
  const eps = 2e-3 * grid.h, far = Math.max(0, pb.gap ?? 0) + eps;
  const boxes = doms.map(d => triBox(d.tris)), L = located(c, tris, q);
  let m = 0;
  for (let o = 0; o < L.length; o += 8) {
    const x = L[o + 1], y = L[o + 2], z = L[o + 3], nx = L[o + 5], ny = L[o + 6], nz = L[o + 7], own = c.dom[L[o]];
    let on = false;
    for (let d = 0; d < doms.length && !on; d++) {
      if (d === own) continue;
      const B = boxes[d];
      if (x < B[0] - far || y < B[1] - far || z < B[2] - far || x > B[3] + far || y > B[4] + far || z > B[5] + far) continue;
      on = doms[d].inside(x + eps * nx, y + eps * ny, z + eps * nz) || (far > eps && doms[d].inside(x + far * nx, y + far * ny, z + far * nz));
    }
    if (on) continue;
    if (m !== o) L.copyWithin(m, o, o + 8);
    m += 8;
  }
  return L.subarray(0, m);
}

/** The domains nothing takes heat from: no sink on them and none on anything they pass heat to. */
function looseDomains(c: Ctx, contacts: ThermalContact[], at: Float64Array[]): number[] {
  const nd = c.doms!.length, root = Array.from({ length: nd }, (_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const C of contacts) root[find(C.a)] = find(C.b);
  const held = new Set<number>();
  for (const L of at) for (let o = 0; o < L.length; o += 8) held.add(find(c.dom[L[o]]));
  const out: number[] = [];
  for (let d = 0; d < nd; d++) if (!held.has(find(d))) out.push(d);
  return out;
}

/** Elements joined across the faces between their cells: −½ [N]{k ∂N/∂n} − ½ {k ∂N/∂n}[N] + γ [N][N]. */
function faceTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nb, bas, bas2, gam } = c;
  const MA = new Float64Array(nb), MB = new Float64Array(nb);
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
    for (let axis = 0; axis < 3; axis++) {
      const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0), grid.cells[ci].dom);
      if (o < 0) continue;
      const eb = grid.cells[o].el;
      if (ea === eb) continue;
      const k = c.k3[3 * ea + axis];
      const EA = grid.elems[ea], EB = grid.elems[eb], pts = facePts(c, ci, axis), gamma = Math.max(gam[ea], gam[eb]);
      const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
      for (let q = 0; q < pts.n; q++) {
        const o4 = 4 * q, w = pts.a[o4 + 3], x = pts.a[o4], y = pts.a[o4 + 1], z = pts.a[o4 + 2];
        bas.eval(x, y, z, EA.c, EA.s);
        bas2.eval(x, y, z, EB.c, EB.s);
        for (let b = 0; b < nb; b++) { MA[b] = k * bas.g[3 * b + axis]; MB[b] = k * bas2.g[3 * b + axis]; }
        pair(nb, Kaa, bas.v, MA, 1, bas.v, MA, 1, w, gamma);
        pair(nb, Kab, bas.v, MA, 1, bas2.v, MB, -1, w, gamma);
        pair(nb, Kba, bas2.v, MB, -1, bas.v, MA, 1, w, gamma);
        pair(nb, Kbb, bas2.v, MB, -1, bas2.v, MB, -1, w, gamma);
      }
    }
  }
}

/** A fixed temperature g on boundary points (Nitsche): K += −N_a M_b − M_a N_b + 2γ N_a N_b, f += (−M_a + 2γ N_a) g. */
function heldTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, g: number) {
  const { grid, nb, bas, gam } = c, M = new Float64Array(nb);
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], K = A.block(e, e), g2 = 2 * gam[e], fo = e * nb;
    const kx = c.k3[3 * e] * L[o + 5], ky = c.k3[3 * e + 1] * L[o + 6], kz = c.k3[3 * e + 2] * L[o + 7];
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    for (let a = 0; a < nb; a++) M[a] = bas.g[3 * a] * kx + bas.g[3 * a + 1] * ky + bas.g[3 * a + 2] * kz;
    for (let a = 0; a < nb; a++) {
      const na = bas.v[a], r = a * nb;
      f[fo + a] += w * (g2 * na - M[a]) * g;
      for (let b = 0; b < nb; b++) K[r + b] += w * (-na * M[b] - M[a] * bas.v[b] + g2 * na * bas.v[b]);
    }
  }
}

/**
 * A film on boundary points: K += h w N_a N_b, f += h w T∞ N_a. `rad` > 0 makes it radiation of that emissivity,
 * linearised about the temperatures `x` (°C): q = εσ(T⁴ − Ts⁴) ≈ q(T₀) + 4εσT₀³ (T − T₀).
 */
function filmTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, h: number, amb: number, rad: number, x: Float64Array | null) {
  const { grid, nb, bas } = c;
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], K = A.block(e, e), fo = e * nb;
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    let hh = h, rhs = h * amb;
    if (rad > 0) {
      let t0 = amb;
      if (x) { t0 = 0; for (let a = 0; a < nb; a++) t0 += bas.v[a] * x[fo + a]; }
      const T0 = Math.max(1, t0 + KELVIN), Ts = amb + KELVIN, es = rad * SIGMA;
      hh = 4 * es * T0 ** 3;
      rhs = hh * t0 - es * (T0 ** 4 - Ts ** 4);
    }
    for (let a = 0; a < nb; a++) {
      const na = w * bas.v[a], r = a * nb;
      f[fo + a] += na * rhs;
      for (let b = 0; b < nb; b++) K[r + b] += hh * na * bas.v[b];
    }
  }
}

/**
 * Natural convection on boundary points: q = h(T)(T − T∞) with h ∝ |T − T∞|^¼, linearised about the temperatures
 * in `x` (dq/dT = 1.25 h); none yet = a plain film taken 10 K hotter than the air.
 */
function naturalTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, s: ThermalSink, lens: Float64Array, x: Float64Array | null) {
  const { grid, nb, bas } = c, nat = s.natural!, amb = s.ambient ?? 0, dn = nat.down;
  for (let o = 0, i = 0; o < L.length; o += 8, i += 2) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], K = A.block(e, e), fo = e * nb;
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    let t0 = amb + 10;
    if (x) { t0 = 0; for (let a = 0; a < nb; a++) t0 += bas.v[a] * x[fo + a]; }
    const up = -(L[o + 5] * dn[0] + L[o + 6] * dn[1] + L[o + 7] * dn[2]);
    const h = nat.factor * naturalH(up, t0 - amb, lens[i], lens[i + 1]);
    const hh = x ? 1.25 * h : h, rhs = x ? hh * t0 - h * (t0 - amb) : h * amb;
    for (let a = 0; a < nb; a++) {
      const na = w * bas.v[a], r = a * nb;
      f[fo + a] += na * rhs;
      for (let b = 0; b < nb; b++) K[r + b] += hh * na * bas.v[b];
    }
  }
}

/** The points of a natural convection sink, located face by face so each keeps its face's sizes (2 numbers per point). */
function naturalPoints(c: Ctx, s: ThermalSink, q: number): { L: Float64Array; lens: Float64Array } {
  const nat = s.natural!, n = Math.floor(s.tris.length / 9), groups = new Map<string, number[]>();
  for (let t = 0; t < n; t++) {
    const key = `${nat.lv[t]}|${nat.lh[t]}`;
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
    for (let o = 0; o < L.length; o += 8) lens.push(nat.lv[g[0]], nat.lh[g[0]]);
  }
  const L = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let m = 0;
  for (const p of parts) { L.set(p, m); m += p.length; }
  return { L, lens: Float64Array.from(lens) };
}

function copyMatrix(A: BlockMatrix): BlockMatrix {
  const B = new BlockMatrix(A.nel, A.ms);
  for (const [key, blk] of A.blocks) { const a = Math.floor(key / A.nel); B.block(a, key - a * A.nel).set(blk); }
  return B;
}

function solveSystem(c: Ctx, A: BlockMatrix, f: Float64Array, x0: Float64Array | null): Float64Array {
  const pb = c.pb, useCg = pb.solver === "pcg" || (pb.solver !== "direct" && A.size > DIRECT_LIMIT);
  if (useCg) return pcgSolver(A, { coarse: basisSize(1), tol: pb.tol ?? 1e-9 }).solve(f, x0 ?? undefined).x;
  return new Envelope(A).solve(f);
}

/** ∫ k |∇T|² and, with the pass before, the same of what this pass changed per element. */
function energies(c: Ctx, x: Float64Array, prev: Float64Array | null) {
  const { grid, nb, nel, bas, k3 } = c, eta = new Float64Array(nel), pm = prev ? prev.length / nel : 0;
  let energy = 0;
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e], kx = k3[3 * e], ky = k3[3 * e + 1], kz = k3[3 * e + 2];
    for (const ci of E.cells) {
      const Q = grid.cells[ci].pts;
      for (let q = 0; q < Q.n; q++) {
        const o = 4 * q, w = Q.a[o + 3];
        bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
        let gx = 0, gy = 0, gz = 0, hx = 0, hy = 0, hz = 0;
        for (let a = 0; a < nb; a++) {
          const v = x[e * nb + a], dv = prev ? v - (a < pm ? prev[e * pm + a] : 0) : 0;
          gx += v * bas.g[3 * a]; gy += v * bas.g[3 * a + 1]; gz += v * bas.g[3 * a + 2];
          hx += dv * bas.g[3 * a]; hy += dv * bas.g[3 * a + 1]; hz += dv * bas.g[3 * a + 2];
        }
        energy += w * (kx * gx * gx + ky * gy * gy + kz * gz * gz);
        eta[e] += w * (kx * hx * hx + ky * hy * hy + kz * hz * hz);
      }
    }
  }
  return { energy, eta };
}

/** What a sink takes, W: the flux the terms above carry through its points. */
function flowOf(c: Ctx, s: ThermalSink, L: Float64Array, x: Float64Array, lens?: Float64Array): SinkFlow {
  const { grid, nb, bas, k3, gam } = c, nat = s.natural, amb = s.ambient ?? 0;
  let out = 0, area = 0, sum = 0, hs = 0;
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4];
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    let t = 0, dn = 0;
    for (let a = 0; a < nb; a++) {
      const v = x[e * nb + a];
      t += v * bas.v[a];
      dn += v * (bas.g[3 * a] * k3[3 * e] * L[o + 5] + bas.g[3 * a + 1] * k3[3 * e + 1] * L[o + 6] + bas.g[3 * a + 2] * k3[3 * e + 2] * L[o + 7]);
    }
    area += w; sum += w * t;
    if (s.temp !== undefined) out += w * (-dn + 2 * gam[e] * (t - s.temp));
    if (s.temp === undefined && s.emissivity) out += w * s.emissivity * SIGMA * ((t + KELVIN) ** 4 - ((s.ambient ?? 0) + KELVIN) ** 4);
    if (s.temp === undefined && nat && lens) {
      const o2 = o / 4, up = -(L[o + 5] * nat.down[0] + L[o + 6] * nat.down[1] + L[o + 7] * nat.down[2]);
      const h = nat.factor * naturalH(up, t - amb, lens[o2], lens[o2 + 1]);
      hs += w * h;
      out += w * h * (t - amb);
    } else if (s.temp === undefined) out += w * (s.h ?? 0) * (t - amb);
  }
  return { out, area, mean: area > 0 ? sum / area : 0, ...(nat ? { h: area > 0 ? hs / area : 0 } : {}) };
}

export const thermalMemory = (grid: Grid, p: number) => memoryBytes(grid, () => basisSize(p));

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
}

function build(pb: ThermalProblem, scaleBy?: Float64Array | ((dom: Uint8Array) => Float64Array) | null): Built {
  const p = pb.p;
  const doms = pb.domains && pb.domains.length > 1 ? pb.domains : null;
  if (doms ? doms.some(d => !(d.k > 0) || (d.k3 && !(d.k3.length === 3 && d.k3.every(v => v > 0)))) : !(pb.k > 0)) throw new Error("E-TH-NOK");
  if (!pb.sinks.length) throw new Error("E-TH-NOSINK");
  let grid = pb.grid;
  if (grid) refit(grid, p + 1, 2 * p + 1);
  else grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q: p + 1, depth: pb.depth ?? 3, fit: 2 * p + 1, domains: doms?.map(d => d.inside) });
  const nb = basisSize(p), nel = grid.elems.length;
  const memory = thermalMemory(grid, p);
  if (memory > (pb.memory ?? MEMORY_LIMIT)) throw new Error(`E-SIM-MEMORY: ${memoryMb(memory)}`);
  const g1 = grid, dom = Uint8Array.from(grid.elems, E => (doms ? g1.cells[E.cells[0]].dom : 0));
  const k3 = new Float64Array(3 * nel), ke = new Float64Array(nel);
  const scale = typeof scaleBy === "function" ? scaleBy(dom) : scaleBy;
  for (let e = 0; e < nel; e++) {
    const d = doms ? doms[dom[e]] : null, k = d ? d.k : pb.k;
    const m = scale ? scale[e] : 1;
    for (let a = 0; a < 3; a++) k3[3 * e + a] = (d?.k3 ? d.k3[a] : k) * m;
    // the penalty goes by the best-conducting direction
    ke[e] = Math.max(k3[3 * e], k3[3 * e + 1], k3[3 * e + 2]);
  }
  const c: Ctx = { pb, grid, p, nb, nel, ke, k3, dom, doms, bas: new Basis(p), bas2: new Basis(p), gam: new Float64Array(nel), fitted: new Map() };
  for (let e = 0; e < nel; e++) {
    let fr = 0;
    for (const ci of grid.elems[e].cells) fr = Math.max(fr, grid.cells[ci].frac);
    c.gam[e] = ((pb.beta ?? 3) * ke[e]) / grid.h * (p + 1) ** 2 / Math.min(1, Math.max(0.2, fr));
  }
  const tq = Math.max(2, p + 1);
  const A = new BlockMatrix(nel, nb), f = new Float64Array(A.size);
  volumeTerms(c, A);
  const lens: (Float64Array | undefined)[] = [];
  const at = pb.sinks.map((s, i) => {
    if (s.natural && s.temp === undefined) { const r = naturalPoints(c, s, tq); lens[i] = r.lens; return r.L; }
    return s.free && doms ? freePoints(c, s.tris, tq) : located(c, s.tris, tq);
  });
  // the penalty is measured on the fixed-temperature faces and, with several domains, on every domain's surface
  const surf = at.filter((_L, i) => pb.sinks[i].temp !== undefined);
  if (doms) doms.forEach((d, i) => surf.push(located(c, d.tris, tq, i)));
  measure(c, A, surf);
  faceTerms(c, A);
  const { contacts, joins } = doms ? joinTerms(c, A, tq) : { contacts: [] as ThermalContact[], joins: [] as number[] };
  if (doms) {
    const loose = looseDomains(c, contacts, at);
    if (loose.length) throw new Error(`E-TH-LOOSE: ${loose.join(",")}`);
  }
  pb.sinks.forEach((s, i) => {
    if (s.temp !== undefined) heldTerms(c, A, f, at[i], s.temp);
    else if (!s.natural && (s.h ?? 0) > 0) filmTerms(c, A, f, at[i], s.h!, s.ambient ?? 0, 0, null);
  });
  let volume = 0;
  const volumes = new Array<number>(doms ? doms.length : 1).fill(0);
  for (const cl of grid.cells) { const v = cl.pts.weight(); volume += v; volumes[doms ? cl.dom : 0] += v; }
  const fs: Float64Array[] = [], put: number[] = [];
  for (const s of pb.sources) { const r = sourceLoad(c, s, tq, volume, volumes); fs.push(r.f); put.push(r.put); }
  const rads = pb.sinks.map((s, i) => (s.temp === undefined && ((s.emissivity ?? 0) > 0 || s.natural) ? i : -1)).filter(i => i >= 0);
  return { c, A, f, fs, put, at, lens, rads, contacts, joins, volume, volumes, memory };
}

/** One source's load vector at its full power and the heat it puts in, W. */
function sourceLoad(c: Ctx, s: ThermalSource, tq: number, volume: number, volumes: number[]): { f: Float64Array; put: number } {
  const { grid, nb, nel, dom, doms } = c, f = new Float64Array(nel * nb);
  let put = 0;
  if (s.tris) {
    const area = triArea(s.tris), q = s.flux !== undefined ? s.flux : area > 0 ? (s.power ?? 0) / area : 0;
    const L = located(c, s.tris, tq);
    for (let o = 0; o < L.length; o += 8) {
      const e = L[o], E = grid.elems[e], w = q * L[o + 4];
      c.bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
      for (let a = 0; a < nb; a++) f[e * nb + a] += w * c.bas.v[a];
      put += w;
    }
  } else if (s.power && volume > 0) {
    const only = doms && s.doms ? new Set(s.doms) : null;
    let vol = volume;
    if (only) { vol = 0; for (const d of only) vol += volumes[d] ?? 0; }
    if (!(vol > 0)) return { f, put };
    const q = s.power / vol;
    for (let e = 0; e < nel; e++) {
      if (only && !only.has(dom[e])) continue;
      const E = grid.elems[e];
      for (const ci of E.cells) {
        const P = grid.cells[ci].pts;
        for (let i = 0; i < P.n; i++) {
          const o = 4 * i, w = q * P.a[o + 3];
          c.bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
          for (let a = 0; a < nb; a++) f[e * nb + a] += w * c.bas.v[a];
        }
      }
    }
    put = s.power;
  }
  return { f, put };
}

/** The matrix and load with the temperature-dependent sinks linearised about `last` (none = their first guess). */
function linearised(b: Built, last: Float64Array | null): { B: BlockMatrix; g: Float64Array } {
  const B = copyMatrix(b.A), g = new Float64Array(b.f.length), pb = b.c.pb;
  for (const i of b.rads) {
    const s = pb.sinks[i];
    if (s.natural) naturalTerms(b.c, B, g, b.at[i], s, b.lens[i]!, last);
    else filmTerms(b.c, B, g, b.at[i], 0, s.ambient ?? 0, s.emissivity!, last);
  }
  return { B, g };
}

/** Samples a solution at points (moved a little against their normals, so a surface point is read inside). */
function samplerOf(c: Ctx, x: Float64Array, local: Float32Array | null) {
  const { grid: g0, nb, bas, k3, dom, doms } = c;
  const elAt = (px: number, py: number, pz: number) => {
    const cl = g0.cellOf(px, py, pz);
    if (cl < 0) return -1;
    const e = g0.cells[cl].el, E = g0.elems[e];
    bas.eval(px, py, pz, E.c, E.s);
    return e;
  };
  const sample = (pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): ThermalSample => {
    const n = pos.length / 3, temp = new Float32Array(n), flux = new Float32Array(3 * n), err = new Float32Array(n);
    const hit = hits ? new Uint8Array(n) : undefined, eps = 1e-6 * g0.h, where = doms ? new Uint8Array(n) : undefined;
    for (let i = 0; i < n; i++) {
      let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
      if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
      if (hit && (px < g0.lo[0] - eps || py < g0.lo[1] - eps || pz < g0.lo[2] - eps || px > g0.lo[0] + g0.n[0] * g0.h + eps || py > g0.lo[1] + g0.n[1] * g0.h + eps || pz > g0.lo[2] + g0.n[2] * g0.h + eps)) continue;
      const e = elAt(px, py, pz);
      if (e < 0) continue;
      if (hit) hit[i] = 1;
      let t = 0, gx = 0, gy = 0, gz = 0;
      for (let a = 0; a < nb; a++) { const v = x[e * nb + a]; t += v * bas.v[a]; gx += v * bas.g[3 * a]; gy += v * bas.g[3 * a + 1]; gz += v * bas.g[3 * a + 2]; }
      if (where) where[i] = dom[e];
      temp[i] = t; flux[3 * i] = -k3[3 * e] * gx; flux[3 * i + 1] = -k3[3 * e + 1] * gy; flux[3 * i + 2] = -k3[3 * e + 2] * gz; err[i] = local ? local[e] : 0;
    }
    return { temp, flux, err, ...(hit ? { hit } : {}), ...(where ? { dom: where } : {}) };
  };
  const temp = (px: number, py: number, pz: number) => {
    const e = elAt(px, py, pz);
    if (e < 0) return NaN;
    let t = 0;
    for (let a = 0; a < nb; a++) t += x[e * nb + a] * bas.v[a];
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
  const tab = ktOf(pb);
  if (!tab) return solveOnce(pb, build(pb), 0);
  // FR-TMAT-004: solved again with each element's k at the temperatures found until no k changes by more than 0.5 %
  const temps = pb.sinks.map(s => s.temp ?? s.ambient ?? 0);
  const t0 = temps.length ? temps.reduce((a, v) => a + v, 0) / temps.length : 20;
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

function solveOnce(pb: ThermalProblem, b: Built, kSteps: number): ThermalResult {
  const { c, A } = b, { grid, p, nel, nb } = c;
  const f = Float64Array.from(b.f);
  for (const fs of b.fs) for (let i = 0; i < f.length; i++) f[i] += fs[i];
  const applied = b.put.reduce((a, v) => a + v, 0);
  // radiation and natural convection depend on the temperatures: linearised about the last answer and solved again until they settle
  let x: Float64Array, iterations = 1;
  if (!b.rads.length) x = solveSystem(c, A, f, null);
  else {
    let last: Float64Array | null = null;
    x = f;
    for (let it = 0; it < RAD_STEPS; it++) {
      const { B, g } = linearised(b, last);
      for (let i = 0; i < g.length; i++) g[i] += f[i];
      x = solveSystem(c, B, g, last);
      iterations = it + 1;
      let d = 0, top = 0;
      if (last) for (let e = 0; e < nel; e++) { d = Math.max(d, Math.abs(x[e * nb] - last[e * nb])); top = Math.max(top, Math.abs(x[e * nb])); }
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
  contactFlows(c, b.contacts, b.joins, x);
  const sm = samplerOf(c, x, local);
  return { grid, p, dofs: A.size, memory: b.memory, x, energy, applied, flows, iterations, ...(kSteps ? { kSteps } : {}), eta, prevError, volume: b.volume, contacts: b.contacts, volumes: b.volumes, sample: sm.sample, temp: sm.temp };
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
        bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
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
  const cache = new Map<string, { solve(f: Float64Array, x0: Float64Array): Float64Array }>();
  let made = 0;
  let lin: Float64Array | null = b.rads.length || tab ? Float64Array.from(y0) : null, linGen = 0, linG: Float64Array | null = null, linB: BlockMatrix | null = null;
  const relinearise = (rebuild: boolean) => {
    if (!lin) return;
    if (rebuild && tab) { const at = lin; b = build({ ...pb, grid }, dom => ktScale(dom, nb, tab, at, run.t0)); c = b.c; }
    if (b.rads.length) { const r = linearised(b, lin); linB = r.B; linG = r.g; } else { linB = null; linG = null; }
    linGen++;
  };
  relinearise(false);
  const solverFor = (a: number, key: string) => {
    const k = `${key}|${linGen}`, had = cache.get(k);
    if (had) return had;
    const B = copyMatrix(linB ?? b.A);
    for (let e = 0; e < nel; e++) { const K = B.block(e, e), Ce = C[e]; for (let i = 0; i < nb * nb; i++) K[i] += a * Ce[i]; }
    const pbx = c.pb, useCg = pbx.solver === "pcg" || (pbx.solver !== "direct" && B.size > DIRECT_LIMIT);
    let s: { solve(f: Float64Array, x0: Float64Array): Float64Array };
    if (useCg) { const P = pcgSolver(B, { coarse: basisSize(1), tol: pbx.tol ?? 1e-9 }); s = { solve: (f, x0) => P.solve(f, x0).x }; }
    else { const E = new Envelope(B); s = { solve: f => E.solve(f) }; }
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
