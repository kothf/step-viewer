// Structural analysis (FRS-structural 15.1): what a study stores in the document.
// Values are in the solver's units: N, MPa, mm/s², N·mm. Faces are named like everywhere else
// (persistent face names), so a study follows the model through edits (FR-STU-020).

import type { PowerProfile, TransientSettings } from "./transient";
import type { BoardStack } from "../thermal/study";
import type { FaceRef, Num, V3 } from "../model/types";
import type { MatRef } from "../tools/materials";

/** `temp`, `conv` and `rad` are a thermal study's surface conditions: a fixed temperature, convection to air, radiation to the surroundings. */
export type SupportType = "fixed" | "sliding" | "hinge" | "dirs" | "elastic" | "disp" | "temp" | "conv" | "rad";
/** `heat` (W) and `hflux` (W/m²) are a thermal study's heat sources. */
/** `temperature` (structural): thermal expansion from a uniform temperature (`value` °C) or a thermal study's result (`from`). */
export type LoadType = "force" | "pressure" | "gravity" | "moment" | "centrifugal" | "torque" | "bearing" | "hydro" | "remote" | "heat" | "hflux" | "pkgheat" | "temperature";
export const THERMAL_SUPPORTS: SupportType[] = ["temp", "conv", "rad"];
export const THERMAL_LOADS: LoadType[] = ["heat", "hflux", "pkgheat"];
/** Whether a support or load type belongs to thermal studies. */
export const isThermalType = (type: string) => (THERMAL_SUPPORTS as string[]).includes(type) || (THERMAL_LOADS as string[]).includes(type);

export interface StudySupport {
  id: string;
  name?: string;
  type: SupportType;
  faces: FaceRef[];
  /** Hinge: the pin may slide along its axis. */
  axialFree?: boolean;
  /** Fixed in directions: X, Y, Z held. Enforced displacement: X, Y, Z given (the others stay free). */
  dirs?: [boolean, boolean, boolean];
  /** Enforced displacement: where the given directions are moved to, mm. */
  disp?: [number, number, number];
  /** Elastic support: stiffness per area along the face normal and in its plane, N/mm³. */
  kn?: number;
  kt?: number;
  /** Fixed temperature, °C. */
  temp?: number;
  /** Convection: film coefficient, W/(m²·K). */
  h?: number;
  /** Radiation: emissivity, 0..1. */
  emis?: number;
  /** Convection: natural convection, the film coefficient worked out per face from its tilt, size and temperature (`h` unused). */
  natural?: boolean;
  /** Convection and radiation: the temperature of the air or the surroundings, °C; absent = the study's ambient. */
  ambient?: number;
  /** Convection: a heatsink on the faces given by its thermal resistance to the air, K/W, instead of `h`. */
  rth?: number;
  /** Convection and radiation: every surface open to the air instead of picked faces. */
  all?: boolean;
  /** Fixed, fixed in directions and enforced displacement only: what is held, absent = faces. */
  on?: "edges" | "points";
  edges?: StudyEdge[];
  points?: StudyPoint[];
}

/** One part of a board's thermal package in a Heat from package load. */
export interface PackageHeat {
  /** The package's part id and designator. */
  id: number;
  name: string;
  /** The components the part's bodies became. */
  comps: string[];
  /** Power, W. */
  p: number;
  off?: boolean;
  /** Temperature limit of the part, °C, from the package. */
  limit?: number;
  /** The package's split of the power (FR-TBRD-003): W into the board, W into a heatsink or the chassis, and the path. */
  board?: number;
  sink?: number;
  path?: "board" | "air" | "heatsink" | "chassis";
}
/** Package parts under this power are left out, as the package does (FR-TBRD-002), W. */
export const PACKAGE_MIN_POWER = 0.01;

/** An edge of the model, named by the two faces it joins. */
export interface StudyEdge { faces: [string, string]; hint?: V3 }
/** A corner of the model, named by the faces that meet there; `at` tells corners of the same faces apart. */
export interface StudyPoint { faces: string[]; at: V3 }
/** What takes edges or points instead of faces. */
export const ON_TYPES: readonly string[] = ["force", "fixed", "dirs", "disp"];

export interface StudyLoad {
  id: string;
  name?: string;
  type: LoadType;
  /**
   * Not for gravity. Centrifugal: cylindrical faces whose axis the part spins about (none = `axis` through the origin).
   * Torque and bearing load: cylindrical faces on one axis.
   */
  faces: FaceRef[];
  /** Centrifugal without faces: the world axis through the origin (default Z). Hydrostatic pressure: the world axis that points up (`flip` = it points down). */
  axis?: "x" | "y" | "z";
  /** Centrifugal: angular acceleration, rad/s². The speed is `value`, rpm. */
  accel?: number;
  /** Hydrostatic pressure: the coordinate of the fluid's surface on `axis`, mm. The density is `value`, kg/m³. */
  level?: number;
  /** Remote load: the point the force (`comp`) and the moment (`mom`, N·mm) act at, mm. */
  at?: V3;
  mom?: [Num, Num, Num];
  /** Force only: what it acts on, absent = faces. A force on edges or points is given by components. */
  on?: "edges" | "points";
  edges?: StudyEdge[];
  points?: StudyPoint[];
  /** Force along the normal (N, into the face; total over the faces), pressure (MPa) or torque (N·mm, right-handed about the faces' axis taken towards +X, +Y or +Z). */
  value?: Num;
  /** Force or bearing load (N), gravity (mm/s²) or moment (N·mm) as X, Y, Z components. */
  comp?: [Num, Num, Num];
  /** Force: along the faces' normals (`value`) instead of `comp`. */
  normal?: boolean;
  /** Reverses a normal force or a pressure (pulls), or a torque. */
  flip?: boolean;
  /** Heat power: made throughout the whole body instead of entering through faces. */
  body?: boolean;
  /** Heat from package: the power of each part of a board's thermal package, made throughout its components. */
  parts?: PackageHeat[];
  /** Heat from package: the component that is the board (its contact patches take the parts' board shares). */
  board?: string;
  /** Heat from package: keep the package's split, its shares applied as fixed powers (FR-TBRD-003). */
  split?: boolean;
  /** Transient thermal studies: how the power changes with time (FR-TLOAD-005); absent = constant. */
  profile?: PowerProfile;
  /** Temperature load (FR-LOAD-011): the thermal study whose last result gives the temperatures; absent = `value` °C everywhere. */
  from?: string;
  /** Temperature load: the temperature at which the part is free of stress, °C (default `DEFAULT_REF`). */
  ref?: number;
}

/** A temperature load's stress-free temperature, °C. */
export const DEFAULT_REF = 20;

/** Local accuracy (FR-SOL-012): the solution starts `level` degrees higher where it meets these faces. */
/**
 * A weld (FR-CON-022), assemblies: along the picked edges of one component, where it meets another, the two
 * are joined. `throat` = the weld's throat thickness, mm: the stress is the force per length over it.
 */
export interface StudyWeld {
  id: string;
  name?: string;
  type: "weld";
  /** Always empty: a weld is on edges. */
  faces: FaceRef[];
  /** `points` = spot welds (FR-CON-024): each point is on a face of one component (`faces[0]`), and the spot
   * goes through that component to the one behind it, joining the two over a disc of diameter `dia`, mm. */
  on: "edges" | "points";
  edges: StudyEdge[];
  points?: StudyPoint[];
  dia?: number;
  throat: number;
}
export const SPOT_LABEL = "Spot weld";
export const DEFAULT_SPOT = 6;
/**
 * A connector (FR-CON-023): the faces of side one are tied to those of side two, each side moving as a whole
 * (mean displacement and rotation). Rigid, or a spring of `k` N/mm along X, Y, Z and `kr` N·mm/rad against turning.
 */
export interface StudyConnector {
  id: string;
  name?: string;
  type: "connector";
  faces: FaceRef[];
  faces2: FaceRef[];
  kind: "rigid" | "spring";
  k: [number, number, number];
  kr?: number;
}
/** A mass spread over faces, kg (FR-CON-023): it weighs under gravity and spinning and counts in a modal study. */
export interface StudyMass {
  id: string;
  name?: string;
  type: "mass";
  faces: FaceRef[];
  mass: number;
}
export type StudyExtra = StudyWeld | StudyConnector | StudyMass;
export const CONNECTOR_LABEL = "Connector";
export const MASS_LABEL = "Mass";
export const DEFAULT_SPRING = 1000;
/** A study's welds, connectors and masses. */
export function extrasOf(st: Study | null | undefined): StudyExtra[] {
  return [...(st?.welds ?? []), ...(st?.connectors ?? []), ...(st?.masses ?? [])];
}
export const WELD_LABEL = "Weld";
export const DEFAULT_THROAT = 3;

export interface StudyRefine {
  id: string;
  name?: string;
  type: "refine";
  faces: FaceRef[];
  /** 1..3 (`MAX_REFINE`). */
  level: number;
}
export const MAX_REFINE = 3;

export interface StudySettings {
  /** Adaptive passes, 1..6: three over the whole body, the rest local (run.ts `MAX_PASSES`). */
  passes: number;
  /** Stop when the strain energy changes less than this between passes, %. */
  energyTol: number;
  /** Assemblies: components are joined across gaps up to this wide, mm (default `DEFAULT_GAP`). */
  gap?: number;
  /** Modal studies: how many modes are found (default `DEFAULT_MODES`, at most `MAX_MODES`). */
  modes?: number;
  /** Modal studies: only the modes between these frequencies, Hz (then `modes` is not used; at most `MAX_MODES` are found). */
  range?: { from: number; to: number };
  /** Static studies: inertia relief (FR-SUP-007). The part is held by nothing, its supports are left out, and the loads are balanced by its own inertia. */
  relief?: boolean;
  /** Thermal studies: the temperature of the air and the surroundings, °C (default `DEFAULT_AMBIENT`). */
  ambient?: number;
  /** Thermal studies: where the model sits (FR-TBC-010); its factor scales natural convection. Absent = open frame. */
  enclosure?: Enclosure;
  /** Thermal studies, `enclosure` "custom": the natural convection factor, 0..1. */
  factor?: number;
  /** Thermal studies: gravity's direction for natural convection (FR-TBC-011), a unit vector; absent = −Z. */
  down?: [number, number, number];
  /** Thermal studies: transient (FR-TSOL-006), stepped in time from the start temperature to `end`; absent = steady. */
  transient?: TransientSettings;
}
export const DEFAULT_AMBIENT = 25;
export type Enclosure = "open" | "vented" | "closed" | "custom";
/** Enclosure presets (FR-TBC-010): natural convection factor and the ambient temperature a pick sets. */
export const ENCLOSURES: { id: Exclude<Enclosure, "custom">; label: string; factor: number; ambient: number }[] = [
  { id: "open", label: "Open frame", factor: 1, ambient: 25 },
  { id: "vented", label: "Vented chassis", factor: 0.8, ambient: 35 },
  { id: "closed", label: "Closed chassis", factor: 0.55, ambient: 40 },
];
/** The natural convection factor of a study's enclosure. */
export function enclosureFactor(s: StudySettings): number {
  if (s.enclosure === "custom") return s.factor !== undefined && s.factor > 0 ? Math.min(1, s.factor) : 1;
  return ENCLOSURES.find(e => e.id === s.enclosure)?.factor ?? 1;
}
/** Gravity directions offered in the study (FR-TBC-011). */
export const DOWNS: [string, [number, number, number]][] = [["−Z", [0, 0, -1]], ["+Z", [0, 0, 1]], ["−Y", [0, -1, 0]], ["+Y", [0, 1, 0]], ["−X", [-1, 0, 0]], ["+X", [1, 0, 0]]];
/** Passes of a thermal study: degree 2, 3, 4 over the whole body. */
export const THERMAL_PASSES = 3;
/** Film coefficients people reach for, W/(m²·K). */
export const FILM_PRESETS: [string, number][] = [["Still air (natural convection)", 8], ["Moving air (fan)", 40], ["Still water", 500], ["Flowing water", 3000]];

/** `modal` = natural frequencies and mode shapes: supports only (none = a free body), no loads. */
/** `thermal` = steady temperatures: heat sources (its loads) and surface conditions (its supports). */
export type StudyKind = "static" | "modal" | "thermal";
export const DEFAULT_MODES = 6, MAX_MODES = 50;
/** Passes of a modal study: degree 2, 3, 4 over the whole body. */
export const MODAL_PASSES = 3;

export interface Study {
  id: string;
  name: string;
  kind: StudyKind;
  supports: StudySupport[];
  loads: StudyLoad[];
  settings: StudySettings;
  /** Static studies: places solved more accurately from the first pass on. */
  refine?: StudyRefine[];
  /** Ids of supports, loads and refinements left out of the solve. */
  suppressed?: string[];
  /** Assemblies: pairs of components that are not bonded where they touch (FR-CON-005/006). */
  links?: StudyLink[];
  /** Assemblies: what the study changes on a component, by component id (FR-CON-001/002). */
  comps?: Record<string, StudyComp>;
  /** Assemblies: how the bolts found among the fasteners are taken (FR-CON-020), by screw component id. */
  bolts?: Record<string, StudyBolt>;
  /** Assemblies: welds along edges where two components meet (FR-CON-022). */
  welds?: StudyWeld[];
  connectors?: StudyConnector[];
  masses?: StudyMass[];
  /** Parts: materials of this study only (FR-SMAT-003), by Bodies folder key; "" = the part's. The part keeps its own. */
  mats?: Record<string, MatRef>;
  /** Probes: points on the undeformed model, mm, whose result values are read after each solve (FR-RES-005). */
  probes?: V3[];
  /** Static studies: load cases (FR-LOAD-022), each solved on its own with the same supports. None = one case with every load. */
  cases?: StudyCase[];
  /** A straight path between two points of the undeformed model: the results are charted along it (not part of the set-up). */
  path?: [V3, V3];
  /** Modal studies: a frequency the part is excited at, as typed ("3000 rpm", "50 Hz"); modes near it are flagged. Not part of the solve. */
  excite?: string;
  /** Solve on change (FR-STU-022): the study is solved again by itself whenever the model or its set-up changes. Not part of the solve. */
  auto?: boolean;
  /** View state: the plot shown and the deformation scale (0 = automatic). */
  plot?: { kind: PlotKind; scale?: number; deformed?: boolean };
}

/** A component in a study: left out of the analysis (`off`), or analysed with another material than its part's. */
/** `rigid`: the component moves as a body with its mass, without strain (FR-CON-001). */
export interface StudyComp {
  off?: boolean; material?: MatRef; rigid?: boolean;
  /** Thermal studies: the component is a circuit board with this copper (`t` = its thickness when known, mm); its conductivity comes from it, not from a material. */
  board?: BoardStack & { t?: number };
}
/**
 * A bolt in a study, by its screw's component id: `off` = the fastener is analysed as a solid like any other
 * component, `cls` = property class (default 8.8), `preload` = tightening, N, or N·mm of torque with `torque`
 * (tension = torque / (`k` · d), nut factor `k` 0.2 unless given).
 */
export interface StudyBolt { off?: boolean; cls?: string; preload?: number; torque?: boolean; k?: number }
export const NUT_FACTOR = 0.2;
/** The tension a bolt's tightening leaves in it, N. */
export const boltPreload = (b: StudyBolt | undefined, d: number) => (!b?.preload || !(b.preload > 0) ? 0 : b.torque ? b.preload / ((b.k && b.k > 0 ? b.k : NUT_FACTOR) * d) : b.preload);
/** The component a region key (`<comp>` or `<comp>#<solid>`) or a face name (`<comp>@<face>`) belongs to. */
export const compOf = (key: string) => { const m = /[@#]/.exec(key); return m ? key.slice(0, m.index) : key; };
/** The ids of the components a study leaves out. */
export const offComps = (st: Study | null | undefined) => new Set(Object.entries(st?.comps ?? {}).filter(([, c]) => c.off).map(([id]) => id));

/** How two components (by id, `a` < `b`) are joined where they touch: sliding along the surface, or not at all. */
/** `adhesive` (FR-CON-025): bonded through a thin elastic layer `t` mm thick of modulus `E`, MPa. */
/**
 * Thermal studies (FR-TCON-002): `resist` = a contact conductance `h`, W/(m²·K), between the two surfaces;
 * `pad` = an interface material `t` mm thick of conductivity `k`, W/(m·K); `none` = insulated. Without a link
 * the contact is perfect.
 */
export interface StudyLink { a: string; b: string; type: "sliding" | "none" | "adhesive" | "resist" | "pad"; t?: number; E?: number; h?: number; k?: number }
/** A dry metal-to-metal contact under light pressure, W/(m²·K), and a silicone pad. */
export const DEFAULT_TCC = 3000;
export const DEFAULT_PAD = { t: 0.5, k: 3 };
/** What a thermal link passes per area and kelvin, W/(mm²·K). */
export function linkConductance(l: { type: string; t?: number; h?: number; k?: number }): number {
  if (l.type === "pad") return ((l.k && l.k > 0 ? l.k : DEFAULT_PAD.k) * 1e-3) / (l.t && l.t > 0 ? l.t : DEFAULT_PAD.t);
  return (l.h && l.h > 0 ? l.h : DEFAULT_TCC) * 1e-6;
}
export const DEFAULT_GLUE = { t: 0.2, E: 2000 };
/** Poisson's ratio taken for an adhesive layer. */
export const GLUE_NU = 0.4;
/** An adhesive layer's stiffness per area across and along it, N/mm³: E / t and G / t. */
export function glueStiffness(l: { t?: number; E?: number }): [number, number] {
  const t = l.t && l.t > 0 ? l.t : DEFAULT_GLUE.t, E = l.E && l.E > 0 ? l.E : DEFAULT_GLUE.E;
  return [E / t, E / (2 * (1 + GLUE_NU)) / t];
}
/** Assemblies: components are joined across gaps up to this wide, mm, when the study sets none (FR-CON-003). */
export const DEFAULT_GAP = 0.1;

export type PlotKind = "vm" | "u" | "ux" | "uy" | "uz" | "sf" | "err" | "temp" | "flux";

export const DEFAULT_SETTINGS: StudySettings = { passes: 3, energyTol: 2 };
export const GRAVITY = 9806.65;

/** A load case: the study's loads without the ones in `off`. */
export interface StudyCase { id: string; name: string; off: string[] }

/** A new load case named "Case n", with every load in it. */
export function newCase(st: Study): StudyCase {
  let n = 1, k = 1;
  const ids = new Set((st.cases ?? []).map(c => c.id)), names = new Set((st.cases ?? []).map(c => c.name));
  while (ids.has(`c${n}`)) n++;
  while (names.has(`Case ${k}`)) k++;
  return { id: `c${n}`, name: `Case ${k}`, off: [] };
}

/** The study as one of its load cases solves it: the case's left-out loads join the suppressed items. */
export function caseStudy(st: Study, c: StudyCase): Study {
  const loads = new Set(st.loads.map(l => l.id));
  return { ...st, suppressed: [...new Set([...(st.suppressed ?? []), ...c.off.filter(id => loads.has(id))])] };
}

/** A new study named "Static n" or "Modal n". */
export function newStudy(existing: Study[], kind: StudyKind = "static"): Study {
  let n = 1, k = 1;
  const ids = new Set(existing.map(s => s.id)), names = new Set(existing.map(s => s.name));
  const label = kind === "modal" ? "Modal" : kind === "thermal" ? "Thermal" : "Static";
  while (ids.has(`st${n}`)) n++;
  while (names.has(`${label} ${k}`)) k++;
  return { id: `st${n}`, name: `${label} ${k}`, kind, supports: [], loads: [], settings: kind === "modal" ? { ...DEFAULT_SETTINGS, modes: DEFAULT_MODES } : kind === "thermal" ? { ...DEFAULT_SETTINGS, energyTol: 1, ambient: DEFAULT_AMBIENT } : { ...DEFAULT_SETTINGS } };
}

/** The next free id with a prefix among a study's supports and loads. */
export function nextId(st: Study, prefix: "s" | "l" | "r" | "w" | "k" | "m"): string {
  const ids = new Set([...st.supports, ...st.loads, ...(st.refine ?? []), ...extrasOf(st)].map(i => i.id));
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const SUPPORT_LABEL: Record<SupportType, string> = { fixed: "Fixed support", sliding: "Sliding", hinge: "Hinge", dirs: "Fixed in directions", elastic: "Elastic support", disp: "Enforced displacement", temp: "Fixed temperature", conv: "Convection", rad: "Radiation" };
export const LOAD_LABEL: Record<LoadType, string> = { force: "Force", pressure: "Pressure", gravity: "Gravity", moment: "Moment", centrifugal: "Centrifugal load", torque: "Torque", bearing: "Bearing load", hydro: "Hydrostatic pressure", remote: "Remote load", heat: "Heat power", hflux: "Heat flux", pkgheat: "Heat from package", temperature: "Temperature" };

export const REFINE_LABEL = "Local accuracy";

/** Default name of a new item: "Fixed 1", "Force 2". */
export function itemName(st: Study, type: SupportType | LoadType | "refine" | "weld" | "spot" | "connector" | "mass"): string {
  const label = type === "refine" ? REFINE_LABEL : type === "spot" ? SPOT_LABEL : type === "weld" ? WELD_LABEL : type === "connector" ? CONNECTOR_LABEL : type === "mass" ? MASS_LABEL : (SUPPORT_LABEL as Record<string, string>)[type] ?? (LOAD_LABEL as Record<string, string>)[type];
  const names = new Set([...st.supports, ...st.loads, ...(st.refine ?? []), ...extrasOf(st)].map(i => i.name));
  let n = 1;
  while (names.has(`${label} ${n}`)) n++;
  return `${label} ${n}`;
}

/** How many faces, edges or points an item is on. */
export function pickCount(it: StudySupport | StudyLoad | StudyRefine | StudyExtra): number {
  const l = it as { on?: "edges" | "points"; edges?: StudyEdge[]; points?: StudyPoint[] };
  return l.on === "edges" ? l.edges?.length ?? 0 : l.on === "points" ? l.points?.length ?? 0 : it.faces.length;
}
