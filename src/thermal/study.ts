// A thermal study from a board's STEP and its thermal package (FRS-thermal J5, FR-TBRD-001/002/010/011):
// which body is the board, what each body is made of, and the heat every package part makes. Pure.

import type { ModelBody, PartMatch } from "./match";
import type { ThermalManifest, ThermalPart } from "./package";

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

/** Library material names the guesses use. */
export const GUESS = {
  resistor: "Alumina 99.5 %",
  can: "Aluminium 6061",
  glass: "Glass (borosilicate 3.3)",
  plastic: "Epoxy resin (cast)",
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
  if (/^c\d/i.test(d) && /electrolytic|elko|can|µf|uf|мкф/.test(text)) return GUESS.can;
  return GUESS.plastic;
}

/** One package part's heat in the study. */
export interface PlanHeat { id: number; name: string; bodies: number[]; p: number; limit?: number }
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
  /** Total power of the parts that have bodies, W. */
  power: number;
}

/** The study a board's package describes, over the bodies of its STEP (in the viewer's order). */
export function boardPlan(man: ThermalManifest, match: PartMatch, bodies: ModelBody[]): BoardPlan {
  const owner = new Map<number, ThermalPart>();
  for (const p of man.parts) for (const i of match.bodies.get(p.id) ?? []) if (!owner.has(i)) owner.set(i, p);
  // the package's part 0 is the board; else it is found among the bodies no part owns
  const zero = match.bodies.get(0);
  const board = zero?.length ? zero[0] : findBoard(bodies, new Set(owner.keys()));
  const mats = bodies.map((b, i) => (i === board ? "" : guessMaterial(owner.get(i) ?? null, b.name)));
  const names = bodies.map((_b, i) => (i === board ? "PCB" : owner.get(i)?.designator ?? ""));
  const heat: PlanHeat[] = [];
  let power = 0;
  for (const p of man.parts) {
    if (p.id === 0) continue;
    const list = (match.bodies.get(p.id) ?? []).filter(i => i !== board), w = p.p ?? 0;
    heat.push({ id: p.id, name: p.designator || `#${p.id}`, bodies: list, p: w, ...(p.limit !== undefined ? { limit: p.limit } : {}) });
    if (list.length) power += w;
  }
  return { board, thickness: board >= 0 ? sizes(bodies[board].box)[0] : 0, mats, names, heat, ambient: man.settings.ambient, emissivity: man.settings.emissivity, power };
}
