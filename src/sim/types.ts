// Structural analysis (FRS-structural 15.1): what a study stores in the document.
// Values are in the solver's units: N, MPa, mm/s², N·mm. Faces are named like everywhere else
// (persistent face names), so a study follows the model through edits (FR-STU-020).

import type { FaceRef, Num, V3 } from "../model/types";

export type SupportType = "fixed" | "sliding" | "hinge" | "dirs" | "elastic" | "disp";
export type LoadType = "force" | "pressure" | "gravity" | "moment" | "centrifugal" | "torque" | "bearing" | "hydro" | "remote";

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
  /** Fixed, fixed in directions and enforced displacement only: what is held, absent = faces. */
  on?: "edges" | "points";
  edges?: StudyEdge[];
  points?: StudyPoint[];
}

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
}

/** Local accuracy (FR-SOL-012): the solution starts `level` degrees higher where it meets these faces. */
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
  /** Modal studies: how many modes are found (default `DEFAULT_MODES`, at most `MAX_MODES`). */
  modes?: number;
  /** Modal studies: only the modes between these frequencies, Hz (then `modes` is not used; at most `MAX_MODES` are found). */
  range?: { from: number; to: number };
}

/** `modal` = natural frequencies and mode shapes: supports only (none = a free body), no loads. */
export type StudyKind = "static" | "modal";
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
  /** Probes: points on the undeformed model, mm, whose result values are read after each solve (FR-RES-005). */
  probes?: V3[];
  /** Modal studies: a frequency the part is excited at, as typed ("3000 rpm", "50 Hz"); modes near it are flagged. Not part of the solve. */
  excite?: string;
  /** View state: the plot shown and the deformation scale (0 = automatic). */
  plot?: { kind: PlotKind; scale?: number; deformed?: boolean };
}

export type PlotKind = "vm" | "u" | "ux" | "uy" | "uz" | "sf" | "err";

export const DEFAULT_SETTINGS: StudySettings = { passes: 3, energyTol: 2 };
export const GRAVITY = 9806.65;

/** A new study named "Static n" or "Modal n". */
export function newStudy(existing: Study[], kind: StudyKind = "static"): Study {
  let n = 1, k = 1;
  const ids = new Set(existing.map(s => s.id)), names = new Set(existing.map(s => s.name));
  const label = kind === "modal" ? "Modal" : "Static";
  while (ids.has(`st${n}`)) n++;
  while (names.has(`${label} ${k}`)) k++;
  return { id: `st${n}`, name: `${label} ${k}`, kind, supports: [], loads: [], settings: kind === "modal" ? { ...DEFAULT_SETTINGS, modes: DEFAULT_MODES } : { ...DEFAULT_SETTINGS } };
}

/** The next free id with a prefix among a study's supports and loads. */
export function nextId(st: Study, prefix: "s" | "l" | "r"): string {
  const ids = new Set([...st.supports, ...st.loads, ...(st.refine ?? [])].map(i => i.id));
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const SUPPORT_LABEL: Record<SupportType, string> = { fixed: "Fixed support", sliding: "Sliding", hinge: "Hinge", dirs: "Fixed in directions", elastic: "Elastic support", disp: "Enforced displacement" };
export const LOAD_LABEL: Record<LoadType, string> = { force: "Force", pressure: "Pressure", gravity: "Gravity", moment: "Moment", centrifugal: "Centrifugal load", torque: "Torque", bearing: "Bearing load", hydro: "Hydrostatic pressure", remote: "Remote load" };

export const REFINE_LABEL = "Local accuracy";

/** Default name of a new item: "Fixed 1", "Force 2". */
export function itemName(st: Study, type: SupportType | LoadType | "refine"): string {
  const label = type === "refine" ? REFINE_LABEL : (SUPPORT_LABEL as Record<string, string>)[type] ?? (LOAD_LABEL as Record<string, string>)[type];
  const names = new Set([...st.supports, ...st.loads, ...(st.refine ?? [])].map(i => i.name));
  let n = 1;
  while (names.has(`${label} ${n}`)) n++;
  return `${label} ${n}`;
}

/** How many faces, edges or points an item is on. */
export function pickCount(it: StudySupport | StudyLoad | StudyRefine): number {
  const l = it as { on?: "edges" | "points"; edges?: StudyEdge[]; points?: StudyPoint[] };
  return l.on === "edges" ? l.edges?.length ?? 0 : l.on === "points" ? l.points?.length ?? 0 : it.faces.length;
}
