// Structural analysis (FRS-structural 15.1): what a study stores in the document.
// Values are in the solver's units: N, MPa, mm/s², N·mm. Faces are named like everywhere else
// (persistent face names), so a study follows the model through edits (FR-STU-020).

import type { FaceRef, Num, V3 } from "../model/types";

export type SupportType = "fixed" | "sliding" | "hinge" | "dirs";
export type LoadType = "force" | "pressure" | "gravity" | "moment";

export interface StudySupport {
  id: string;
  name?: string;
  type: SupportType;
  faces: FaceRef[];
  /** Hinge: the pin may slide along its axis. */
  axialFree?: boolean;
  /** Fixed in directions: X, Y, Z held. */
  dirs?: [boolean, boolean, boolean];
}

/** An edge of the model, named by the two faces it joins. */
export interface StudyEdge { faces: [string, string]; hint?: V3 }
/** A corner of the model, named by the faces that meet there; `at` tells corners of the same faces apart. */
export interface StudyPoint { faces: string[]; at: V3 }

export interface StudyLoad {
  id: string;
  name?: string;
  type: LoadType;
  /** Not for gravity. */
  faces: FaceRef[];
  /** Force only: what it acts on, absent = faces. A force on edges or points is given by components. */
  on?: "edges" | "points";
  edges?: StudyEdge[];
  points?: StudyPoint[];
  /** Force along the normal (N, into the face; total over the faces) or pressure (MPa). */
  value?: Num;
  /** Force (N), gravity (mm/s²) or moment (N·mm) as X, Y, Z components. */
  comp?: [Num, Num, Num];
  /** Force: along the faces' normals (`value`) instead of `comp`. */
  normal?: boolean;
  /** Reverses a normal force or a pressure (pulls). */
  flip?: boolean;
}

export interface StudySettings {
  /** Adaptive passes, 1..3. */
  passes: number;
  /** Stop when the strain energy changes less than this between passes, %. */
  energyTol: number;
}

export interface Study {
  id: string;
  name: string;
  kind: "static";
  supports: StudySupport[];
  loads: StudyLoad[];
  settings: StudySettings;
  /** Ids of supports and loads left out of the solve. */
  suppressed?: string[];
  /** View state: the plot shown and the deformation scale (0 = automatic). */
  plot?: { kind: PlotKind; scale?: number; deformed?: boolean };
}

export type PlotKind = "vm" | "u" | "ux" | "uy" | "uz" | "sf" | "err";

export const DEFAULT_SETTINGS: StudySettings = { passes: 3, energyTol: 2 };
export const GRAVITY = 9806.65;

/** A new static study named "Static n". */
export function newStudy(existing: Study[]): Study {
  let n = 1;
  const ids = new Set(existing.map(s => s.id)), names = new Set(existing.map(s => s.name));
  while (ids.has(`st${n}`) || names.has(`Static ${n}`)) n++;
  return { id: `st${n}`, name: `Static ${n}`, kind: "static", supports: [], loads: [], settings: { ...DEFAULT_SETTINGS } };
}

/** The next free id with a prefix among a study's supports and loads. */
export function nextId(st: Study, prefix: "s" | "l"): string {
  const ids = new Set([...st.supports, ...st.loads].map(i => i.id));
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const SUPPORT_LABEL: Record<SupportType, string> = { fixed: "Fixed support", sliding: "Sliding", hinge: "Hinge", dirs: "Fixed in directions" };
export const LOAD_LABEL: Record<LoadType, string> = { force: "Force", pressure: "Pressure", gravity: "Gravity", moment: "Moment" };

/** Default name of a new item: "Fixed 1", "Force 2". */
export function itemName(st: Study, type: SupportType | LoadType): string {
  const label = (SUPPORT_LABEL as Record<string, string>)[type] ?? (LOAD_LABEL as Record<string, string>)[type];
  const names = new Set([...st.supports, ...st.loads].map(i => i.name));
  let n = 1;
  while (names.has(`${label} ${n}`)) n++;
  return `${label} ${n}`;
}

/** How many faces, edges or points an item is on. */
export function pickCount(it: StudySupport | StudyLoad): number {
  const l = it as StudyLoad;
  return l.on === "edges" ? l.edges?.length ?? 0 : l.on === "points" ? l.points?.length ?? 0 : it.faces.length;
}
