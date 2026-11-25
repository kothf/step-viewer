// A thermal study from a board's STEP and its thermal package (FRS-thermal J5, FR-TBRD-001/002/010/011):
// which body is the board, what each body is made of, and the heat every package part makes. Pure.

import type { StandIn } from "./standins";
import type { ModelBody, PartMatch } from "./match";
import { capacitorLife, isElectrolytic, type PackageMaterial, type ThermalManifest, type ThermalPart } from "./package";

/** The copper of a board, for its effective conductivity. */
export interface BoardStack {
  /** Copper layers. */
  layers: number;
  /** Copper thickness per layer, µm. */
  copper: number;
  /** Share of each layer's area that is copper, 0..1 (averaged over the layers). */
  cover: number;
}
export const DEFAULT_STACK: BoardStack = { layers: 2, copper: 35, cover: 0.4 };
/** Name of the board's effective material. */
export const BOARD_MATERIAL = "PCB (effective)";
export const K_COPPER = 390, K_FR4 = 0.3;
/** Density (g/cm³) and specific heat (J/(kg·K)) of copper and FR-4. */
const RHO_CU = 8.96, RHO_FR4 = 1.85, CP_CU = 385, CP_FR4 = 1100;

/** Conductivity of a board of thickness `t` mm, W/(m·K): along the board (layers in parallel) and through it (in series). */
export function boardConductivity(t: number, s: BoardStack = DEFAULT_STACK): { along: number; through: number; density: number; cp: number } {
  const cu = Math.min(Math.max(t, 1e-6), s.layers * s.copper * 1e-3), full = Math.min(1, Math.max(0, s.cover));
  const share = (cu * full) / Math.max(t, 1e-6);
  const along = K_FR4 * (1 - share) + K_COPPER * share;
  // through: the copper layers are thin sheets in the way of the heat, the laminate between them carries it
  const through = t / ((t - cu) / K_FR4 + cu / (K_FR4 * (1 - full) + K_COPPER * full));
  const density = RHO_FR4 * (1 - share) + RHO_CU * share;
  const cp = (RHO_FR4 * (1 - share) * CP_FR4 + RHO_CU * share * CP_CU) / density;
  return { along, through, density, cp };
}

/**
 * A flat plate lying square to a world axis, from its surface triangles (9 numbers each): the axis across it and
 * its thickness, mm. Null when the body is not one (tilted, or not flat).
 */
export function plateAxis(tris: ArrayLike<number>): { axis: number; t: number } | null {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) { const a = i % 3, v = tris[i]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  if (!(hi[0] >= lo[0])) return null;
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const axis = ext[0] <= ext[1] && ext[0] <= ext[2] ? 0 : ext[1] <= ext[2] ? 1 : 2, t = ext[axis];
  if (!(t > 0) || ext.some((e, a) => a !== axis && e < 4 * t)) return null;
  // its two big faces look along the axis: they hold most of the surface
  let all = 0, flat = 0;
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], a2 = Math.hypot(n[0], n[1], n[2]);
    all += a2;
    if (Math.abs(n[axis]) > 0.999 * a2) flat += a2;
  }
  return all > 0 && flat >= 0.6 * all ? { axis, t } : null;
}

/**
 * Where a part sits on the board (FR-TBRD-003): the board's face towards the part, square to the board's thin
 * axis, cut to the part's footprint (its box grown by `grow` mm across the board). Null when the board is not a
 * flat plate or nothing of it lies under the part.
 */
export function contactPatch(board: ArrayLike<number>, part: ArrayLike<number>, grow = 0.5): Float64Array | null {
  const pl = plateAxis(board);
  if (!pl || part.length < 9) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.length; i++) { const a = i % 3, v = part[i]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  const ax = pl.axis, a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
  // the footprint as a polygon over (u, v) = the two in-plane coordinates
  const box = [[lo[a1] - grow, lo[a2] - grow], [hi[a1] + grow, lo[a2] - grow], [hi[a1] + grow, hi[a2] + grow], [lo[a1] - grow, hi[a2] + grow]];
  return clipFacing(board, ax, (lo[ax] + hi[ax]) / 2, box);
}

/** Where a package part's board share enters the board (FR-TBRD-003): a pad as a disc [x, y, r] or the air gap under
 * the body as a rectangle [x0, y0, x1, y1], mm, in the board's plane (x, y when it lies square to z), with its watts. */
export interface HeatInto { disc?: [number, number, number]; rect?: [number, number, number, number]; w: number }

/** Sides of the polygon standing in for a pad's disc (inscribed, scaled to keep the disc's area). */
const DISC_SIDES = 24;

/**
 * The board's face towards the part clipped to one `into` region (FR-TBRD-003): a disc as a polygon of
 * `DISC_SIDES` sides with the disc's area, a rectangle as it is. Null when nothing of the board lies there.
 */
export function intoPatch(board: ArrayLike<number>, part: ArrayLike<number>, into: HeatInto): Float64Array | null {
  const pl = plateAxis(board);
  if (!pl || part.length < 9) return null;
  const ax = pl.axis;
  let lo = Infinity, hi = -Infinity;
  for (let i = ax; i < part.length; i += 3) { if (part[i] < lo) lo = part[i]; if (part[i] > hi) hi = part[i]; }
  let poly: number[][];
  if (into.disc) {
    const [x, y, r] = into.disc, n = DISC_SIDES, R = r * Math.sqrt((2 * Math.PI) / (n * Math.sin((2 * Math.PI) / n)));
    if (!(r > 0)) return null;
    poly = Array.from({ length: n }, (_, k) => [x + R * Math.cos((2 * Math.PI * k) / n), y + R * Math.sin((2 * Math.PI * k) / n)]);
  } else if (into.rect) {
    const [x0, y0, x1, y1] = into.rect, u0 = Math.min(x0, x1), u1 = Math.max(x0, x1), v0 = Math.min(y0, y1), v1 = Math.max(y0, y1);
    if (!(u1 > u0 && v1 > v0)) return null;
    poly = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  } else return null;
  return clipFacing(board, ax, (lo + hi) / 2, poly);
}

/** The board's triangles square to `ax` on the side looking towards `mid`, clipped to the ccw convex polygon `clip`. */
function clipFacing(board: ArrayLike<number>, ax: number, mid: number, clip: number[][]): Float64Array | null {
  const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3, keep: number[] = [];
  // the polygon's sides as half-planes: inside is left of each side
  const sides = clip.map((p, i) => { const q = clip[(i + 1) % clip.length]; return [p[0], p[1], q[0] - p[0], q[1] - p[1]]; });
  const side = (s: number[], p: number[]) => s[2] * (p[1] - s[1]) - s[3] * (p[0] - s[0]);
  for (let o = 0; o + 8 < board.length; o += 9) {
    const ux = board[o + 3] - board[o], uy = board[o + 4] - board[o + 1], uz = board[o + 5] - board[o + 2];
    const vx = board[o + 6] - board[o], vy = board[o + 7] - board[o + 1], vz = board[o + 8] - board[o + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], a2n = Math.hypot(n[0], n[1], n[2]);
    if (!(a2n > 0) || Math.abs(n[ax]) < 0.99 * a2n) continue;
    const at = (board[o + ax] + board[o + 3 + ax] + board[o + 6 + ax]) / 3;
    // the face looking towards the part
    if (n[ax] * (mid - at) <= 0) continue;
    let poly: number[][] = [0, 3, 6].map(k => [board[o + k + a1], board[o + k + a2]]);
    for (const s of sides) {
      const next: number[][] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length], dp = side(s, p), dq = side(s, q);
        if (dp >= 0) next.push(p);
        if (dp >= 0 !== dq >= 0) { const t = dp / (dp - dq); next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
      }
      poly = next;
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;
    const pt = (q: number[]) => { const r = [0, 0, 0]; r[ax] = at; r[a1] = q[0]; r[a2] = q[1]; return r; };
    // the cut keeps the triangle's winding: a fan from its first corner
    for (let i = 1; i + 1 < poly.length; i++) {
      const A = poly[0], B = poly[i], C = poly[i + 1];
      if (Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) > 1e-12) keep.push(...pt(A), ...pt(B), ...pt(C));
    }
  }
  return keep.length ? Float64Array.from(keep) : null;
}

/**
 * The part of a body's surface a part sits on (FR-TBRD-003/004, FR-TBC-008): each triangle of `body` clipped to the
 * part's box grown by `grow` mm, kept where it looks towards the part's centre, so a heatsink takes a tab's heat
 * under the tab and not on its fins. Null when nothing of `body` lies there.
 */
export function facingPatch(body: ArrayLike<number>, part: ArrayLike<number>, grow = 1): Float64Array | null {
  if (part.length < 9 || body.length < 9) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.length; i++) { const a = i % 3, v = part[i]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  const c = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2), keep: number[] = [];
  for (let o = 0; o + 8 < body.length; o += 9) {
    let poly: number[][] = [0, 3, 6].map(k => [body[o + k], body[o + k + 1], body[o + k + 2]]);
    const u = [0, 1, 2].map(a => poly[1][a] - poly[0][a]), v = [0, 1, 2].map(a => poly[2][a] - poly[0][a]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nn = Math.hypot(n[0], n[1], n[2]);
    if (!(nn > 0)) continue;
    for (let a = 0; a < 3 && poly.length >= 3; a++) for (const [sg, k] of [[1, lo[a] - grow], [-1, -(hi[a] + grow)]] as const) {
      const next: number[][] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length], dp = sg * p[a] - k, dq = sg * q[a] - k;
        if (dp >= 0) next.push(p);
        if (dp >= 0 !== dq >= 0) { const t = dp / (dp - dq); next.push(p.map((x, j) => x + t * (q[j] - x))); }
      }
      poly = next;
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;
    // looking towards the part: the piece's normal within 60° of the way to the part's centre
    const m = [0, 1, 2].map(a => poly.reduce((s, p) => s + p[a], 0) / poly.length), d = [0, 1, 2].map(a => c[a] - m[a]), dd = Math.hypot(d[0], d[1], d[2]);
    if (dd > 0 && (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) < 0.5 * nn * dd) continue;
    for (let i = 1; i + 1 < poly.length; i++) keep.push(...poly[0], ...poly[i], ...poly[i + 1]);
  }
  return keep.length ? Float64Array.from(keep) : null;
}

/**
 * What a board conducts, W/(m·K), from its surface and copper (FR-TBRD-010): `k3` along world X, Y, Z when it
 * lies square to an axis (in-plane along it, the series value through it); a tilted board gets the in-plane
 * value every way.
 */
export function boardK(tris: ArrayLike<number>, s: BoardStack, t0 = 1.6): { along: number; through: number; t: number; k3?: number[] } {
  const pl = plateAxis(tris), t = pl?.t ?? t0, k = boardConductivity(t, s);
  return { along: k.along, through: k.through, t, ...(pl ? { k3: [0, 1, 2].map(a => (a === pl.axis ? k.through : k.along)) } : {}) };
}

const sizes = (b: ModelBody["box"]) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]].sort((x, y) => x - y);

/** The body that is the board: one named board or PCB, else the largest thin flat body. −1 when none looks like one. */
export function findBoard(bodies: ModelBody[], taken: Set<number> = new Set()): number {
  const named = bodies.findIndex((b, i) => !taken.has(i) && /(^|[^a-z])(pcb|board|плата)([^a-z]|$)/i.test(b.name));
  if (named >= 0) return named;
  let best = -1, area = 0;
  bodies.forEach((b, i) => {
    if (taken.has(i)) return;
    const [t, w, l] = sizes(b.box);
    // a board is flat: its thickness is small beside both other sizes
    if (!(t > 0.2 && t <= 4 && w >= 8 * t)) return;
    if (w * l > area) { area = w * l; best = i; }
  });
  return best;
}

/** A reference designator such as R12, C3 or U101 (with an optional suffix after a separator). */
export const DESIGNATOR = /^[A-Z]{1,3}\d{1,4}(?:[^A-Za-z0-9].*)?$/;

/**
 * Does the model look like a circuit board (FR-TPKG-005)? A body named board or PCB, three or more bodies named
 * by reference designators, or a thin flat body whose footprint is larger than every other body's.
 */
export function looksLikeBoard(bodies: ModelBody[]): boolean {
  if (!bodies.length) return false;
  if (bodies.some(b => /(^|[^a-z])(pcb|board|плата)([^a-z]|$)/i.test(b.name))) return true;
  if (bodies.filter(b => DESIGNATOR.test(b.name.trim())).length >= 3) return true;
  if (bodies.length < 2) return false;
  const i = findBoard(bodies);
  if (i < 0) return false;
  const foot = (b: ModelBody) => { const [, w, l] = sizes(b.box); return w * l; };
  const a = foot(bodies[i]);
  return bodies.every((b, j) => j === i || foot(b) < a);
}

/** Library material names the guesses use. */
export const GUESS = {
  resistor: "Alumina 99.5 %",
  can: "Aluminium 6061",
  glass: "Glass (borosilicate 3.3)",
  // moulded part bodies: a glass-filled moulding compound with a specific heat, so warm-ups run (cast epoxy has none)
  plastic: "Nylon PA66-GF30",
  metal: "Copper",
  sink: "Aluminium 6061",
  iron: "Steel (carbon)",
} as const;

/** What a board part is most likely made of, by its designator, value and body name (FR-TBRD-011). */
export function guessMaterial(part: Pick<ThermalPart, "designator" | "part" | "mount" | "path"> | null, body: string): string {
  const d = (part?.designator ?? "").trim(), text = `${part?.part ?? ""} ${body}`.toLowerCase();
  if (/heat ?sink|radiator|радиатор|kühlkörper/.test(text)) return GUESS.sink;
  if (/\b(tab|lead|pin|leg|busbar|bracket)\b/.test(text)) return GUESS.metal;
  // a part made to sit on a heatsink carries its heat in a metal tab
  if (part?.path === "heatsink" || /heatsink/.test(part?.mount ?? "")) return GUESS.metal;
  if (/^(v|vt|tube)\d/i.test(d) || /valve|tube|bulb|envelope|лампа|el\d\d|ecc\d\d|6l6|kt\d\d|12a[xtu]7/.test(text)) return GUESS.glass;
  if (/^(t|tr|l)\d/i.test(d) || /transformer|choke|inductor|трансформатор|дроссель/.test(text)) return GUESS.iron;
  if (/^r\d/i.test(d) || /resistor|резистор|\d+ ?[rkm]\b.*\d ?w/.test(text)) return GUESS.resistor;
  if (/^c\d/i.test(d) && (/electrolytic|elko|can|µf|uf|мкф/.test(text) || bigCap(text))) return GUESS.can;
  return GUESS.plastic;
}

/** "47u 450V", "100µ 63V": a microfarad value of 1 or more with a voltage, as electrolytics are written. */
function bigCap(text: string) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:u|µ)\b/.exec(text);
  return !!m && parseFloat(m[1].replace(",", ".")) >= 1 && /\d\s*v\b/.test(text);
}

/** One package part's heat in the study. */
export interface PlanHeat { id: number; name: string; bodies: number[]; p: number; /** The bodies (of `bodies`) its own heat is made in, from the package's `heat_bodies`; absent = all. */ hot?: number[]; limit?: number; life?: number; board?: number; sink?: number; path?: ThermalPart["path"]; elyt?: boolean; junction?: boolean; rjc?: number }
export interface BoardPlan {
  /** Body index of the board, −1 = none found. */
  board: number;
  /** Board thickness, mm (0 without a board). */
  thickness: number;
  /** Library material name per body; "" for the board (it gets the effective board material). */
  mats: string[];
  /** A name per body from the package: the part's designator, "PCB" for the board, "" when the package knows none. */
  names: string[];
  heat: PlanHeat[];
  ambient?: number;
  emissivity?: number;
  /** The package's enclosure preset ("open" | "vented" | "closed"), when it names one. */
  enclosure?: "open" | "vented" | "closed";
  /** Gravity's direction from the package's orientation and the board's place (FR-TBC-011), when both are known. */
  down?: [number, number, number];
  /**
   * What the package says each body is made of (`body_materials` / `material`): a material of its own table, or the
   * key to look up as a library name; null = nothing given, `mats` holds the guess.
   */
  given?: (PackageMaterial | string | null)[];
  /** The board's surface emissivity from the package. */
  boardEmis?: number;
  /** Total power of the parts that have bodies, W. */
  power: number;
  /** The board's copper stack from the manifest, where it gives one. */
  stack?: Partial<BoardStack>;
  /** Bodies made from package boxes for parts the STEP lacks (body index = bodies.length + their index), and their materials. */
  stand?: StandIn[];
  standMats?: string[];
}

/**
 * Which way is down for a board (FR-TBC-011): lying flat with its parts up = against the side most part bodies are
 * on along the board's thin axis; parts down = towards it; standing upright = down its shorter edge (−).
 */
export function boardDown(orientation: string | undefined, bodies: ModelBody[], board: number): [number, number, number] | undefined {
  if (!orientation || board < 0 || !bodies[board]) return undefined;
  const B = bodies[board].box, ext = [B[3] - B[0], B[4] - B[1], B[5] - B[2]];
  const axis = ext[0] <= ext[1] && ext[0] <= ext[2] ? 0 : ext[1] <= ext[2] ? 1 : 2;
  const d: [number, number, number] = [0, 0, 0];
  if (orientation === "vertical") {
    const [a1, a2] = [0, 1, 2].filter(a => a !== axis);
    d[ext[a1] <= ext[a2] ? a1 : a2] = -1;
    return d;
  }
  if (orientation !== "horizontal-up" && orientation !== "horizontal-down") return undefined;
  const mid = (B[axis] + B[axis + 3]) / 2;
  let side = 0;
  bodies.forEach((b, i) => { if (i !== board) side += (b.box[axis] + b.box[axis + 3]) / 2 >= mid ? 1 : -1; });
  const up = side >= 0 ? 1 : -1;
  d[axis] = orientation === "horizontal-up" ? -up : up;
  return d;
}

/** The study a board's package describes, over the bodies of its STEP (in the viewer's order). */
export function boardPlan(man: ThermalManifest, match: PartMatch, bodies: ModelBody[], stand: StandIn[] = []): BoardPlan {
  const owner = new Map<number, ThermalPart>();
  for (const p of man.parts) for (const i of match.bodies.get(p.id) ?? []) if (!owner.has(i)) owner.set(i, p);
  // the package's part 0 is the board; else it is found among the bodies no part owns
  const zero = match.bodies.get(0);
  const board = zero?.length ? zero[0] : findBoard(bodies, new Set(owner.keys()));
  const mats = bodies.map((b, i) => (i === board ? "" : guessMaterial(owner.get(i) ?? null, b.name)));
  const names = bodies.map((_b, i) => (i === board ? "PCB" : owner.get(i)?.designator ?? ""));
  const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
  const given = bodies.map((b, i) => {
    const p = i === board ? null : owner.get(i);
    const key = p ? Object.entries(p.mats ?? {}).find(([n]) => same(n, b.name))?.[1] ?? p.mat : undefined;
    return key ? man.materials?.[key] ?? key : null;
  });
  const heat: PlanHeat[] = [];
  let power = 0;
  for (const p of man.parts) {
    if (p.id === 0) continue;
    const si = stand.findIndex(x => x.id === p.id);
    const list = si >= 0 && !match.bodies.get(p.id)?.length ? [bodies.length + si] : (match.bodies.get(p.id) ?? []).filter(i => i !== board), w = p.p ?? 0;
    const hot = p.heat?.length ? list.filter(i => i < bodies.length && p.heat!.some(n => same(n, bodies[i].name))) : [];
    heat.push({ id: p.id, name: p.designator || `#${p.id}`, bodies: list, p: w, ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.ratedLife !== undefined && p.ratedLife > 0 ? { life: p.ratedLife } : {}), ...(p.pBoard !== undefined ? { board: p.pBoard } : {}), ...(p.pSink !== undefined ? { sink: p.pSink } : {}), ...(p.path ? { path: p.path } : {}), ...(isElectrolytic(p) ? { elyt: true } : {}), ...(p.tKind === "junction" ? { junction: true } : {}), ...(p.rjc !== undefined && p.rjc >= 0 ? { rjc: p.rjc } : {}), ...(hot.length && hot.length < list.length ? { hot } : {}) });
    if (list.length) power += w;
  }
  const partOf = new Map(man.parts.map(p => [p.id, p]));
  const standMats = stand.map(x => guessMaterial(partOf.get(x.id) ?? null, ""));
  return { board, thickness: board >= 0 ? sizes(bodies[board].box)[0] : 0, mats, names, heat, ambient: man.settings.ambient, emissivity: man.settings.emissivity, power,
    ...(stand.length ? { stand, standMats } : {}),
    ...(["open", "vented", "closed"].includes(man.settings.enclosure ?? "") ? { enclosure: man.settings.enclosure as "open" | "vented" | "closed" } : {}),
    ...(() => { const down = boardDown(man.settings.orientation, bodies, board); return down ? { down } : {}; })(),
    ...(given.some(Boolean) ? { given } : {}),
    ...(man.board?.emis !== undefined ? { boardEmis: man.board.emis } : {}),
    ...(() => { const { emis: _e, ...stack } = man.board ?? {}; return Object.keys(stack).length ? { stack } : {}; })() };
}

/** What a part's reported temperature is of (FR-TBRD-021). */
export type PartTempKind = "body" | "case" | "junction";
export interface PartTempIn { name: string; p: number; off?: boolean; limit?: number; life?: number; junction?: boolean; rjc?: number; comps: string[]; hot?: string[]; /** The hottest point of the bodies named as its heat bodies inside its part (`PackageHeat.bodies`), found by the caller. */ die?: number }
export interface PartTemp {
  name: string;
  /** °C: the hottest point of the part's bodies, plus p × Rjc for a junction. */
  t: number;
  /** °C: the hottest point of its bodies in the solve (its case for a junction part). */
  body: number;
  kind: PartTempKind;
  /** A junction part with no Rjc: only its case temperature is known. */
  caseOnly?: boolean;
  /** A junction read off the bodies the heat is made in (the package's `heat_bodies`), not from case + Rjc. */
  die?: boolean;
  limit?: number;
  over?: boolean;
  /** An electrolytic with a rated life at its limit: hours at `t` by the 10 °C rule (FR-TBRD-022). */
  life?: number;
}

/**
 * Each package part's temperature in a study (FR-TBRD-021): the maximum of its bodies; a part whose package temperature
 * is a junction (or that has an Rjc typed) reports its case maximum plus p × Rjc, or the case alone, marked, without Rjc;
 * a junction part with heat bodies (`hot`) reports their hottest point.
 * `maxOf` gives the hottest temperature of a component (undefined: not in the result).
 */
export function partTemps(parts: PartTempIn[], maxOf: (comp: string) => number | undefined): PartTemp[] {
  const out: PartTemp[] = [];
  for (const x of parts) {
    let body = -Infinity;
    for (const c of x.comps) { const m = maxOf(c); if (m !== undefined && m > body) body = m; }
    if (!Number.isFinite(body)) continue;
    // a part whose heat bodies are modelled (a die): its junction is their hottest point, whatever Rjc says
    let die = -Infinity;
    if (x.junction) for (const c of x.hot ?? []) if (x.comps.includes(c)) { const m = maxOf(c); if (m !== undefined && m > die) die = m; }
    if (x.junction && x.die !== undefined && Number.isFinite(x.die) && x.die > die) die = x.die;
    if (Number.isFinite(die)) {
      out.push({ name: x.name, t: die, body, kind: "junction", die: true, ...(x.limit !== undefined ? { limit: x.limit, over: die > x.limit } : {}) });
      continue;
    }
    const p = x.off ? 0 : Math.max(0, x.p), rjc = x.rjc !== undefined && x.rjc >= 0 ? x.rjc : undefined;
    const junction = !!x.junction || rjc !== undefined;
    const t = junction && rjc !== undefined ? body + p * rjc : body;
    const kind: PartTempKind = junction ? (rjc !== undefined ? "junction" : "case") : "body";
    out.push({ name: x.name, t, body, kind, ...(junction && rjc === undefined ? { caseOnly: true } : {}), ...(x.limit !== undefined ? { limit: x.limit, over: t > x.limit } : {}), ...(x.life !== undefined && x.life > 0 && x.limit !== undefined ? { life: capacitorLife(x.life, x.limit, t) } : {}) });
  }
  return out;
}
