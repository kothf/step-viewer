// A thermal study beside the package map it was made from (FRS-thermal FR-TRES-030): the package's temperatures
// carried onto the study's surface points, ΔT = study − package there, and the parts paired by designator.
import { mapOnto, partChanges, type PartChange } from "./compare";
import { partStats, type ThermalPart } from "./package";
import type { ThermalMesh } from "./vtu";

type V3 = [number, number, number];

export interface StudyMapCompare {
  /** Study − package, K, per study point (NaN where the package has no point near). */
  delta: Float32Array;
  /** Parts by how much the study differs from the package (study − package), largest first; the board's name is "". */
  rows: PartChange[];
  /** Designators in the package with no part in the study, and the other way round. */
  onlyMap: string[];
  onlyStudy: string[];
  /** Hottest point of the package and of the study, °C. */
  hot: { map: number; study: number };
  /** Mean and largest |ΔT| over the study's points, K. */
  mean: number;
  most: number;
}

/** Box of a mesh's points: min x, y, z, max x, y, z. */
export function meshBox(pos: ArrayLike<number>): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
  return b;
}

/**
 * How far a package picked by hand sits from the study's model: the difference of the box centres when the two boxes
 * have the same size (within 2 % or 1 mm per axis; the package was written in another frame), else nothing.
 */
export function fitShift(model: ArrayLike<number>, map: ArrayLike<number>): V3 {
  const a = meshBox(model), b = meshBox(map), d: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const sa = a[k + 3] - a[k], sb = b[k + 3] - b[k];
    if (!(Math.abs(sa - sb) <= Math.max(1, 0.02 * Math.max(sa, sb)))) return [0, 0, 0];
    d[k] = (a[k] + a[k + 3]) / 2 - (b[k] + b[k + 3]) / 2;
  }
  // a shift well inside the tolerance is the same frame
  return d.every(v => Math.abs(v) < 1e-3) ? [0, 0, 0] : d;
}

/**
 * Compare a study (its surface as a thermal mesh whose parts carry the package's part ids, 0 = the board) with a
 * package map. `shift` moves the package's points into the model's frame.
 */
export function compareStudyMap(study: ThermalMesh, studyParts: Pick<ThermalPart, "id" | "designator" | "t">[], map: { mesh: ThermalMesh; parts: ThermalPart[] }, shift: V3 = [0, 0, 0]): StudyMapCompare {
  const there = mapOnto(study, map.mesh, shift), n = study.temp.length, delta = new Float32Array(n);
  let sum = 0, cnt = 0, most = 0;
  for (let i = 0; i < n; i++) {
    const d = study.temp[i] - there[i];
    delta[i] = Number.isFinite(d) ? d : NaN;
    if (Number.isFinite(d)) { sum += Math.abs(d); cnt++; if (Math.abs(d) > most) most = Math.abs(d); }
  }
  const sm = partStats(map.mesh), ss = partStats(study);
  const { rows, onlyA, onlyB } = partChanges(map.parts, sm, studyParts as ThermalPart[], ss);
  let hm = -Infinity, hs = -Infinity;
  for (const v of map.mesh.temp) if (v > hm) hm = v;
  for (const v of study.temp) if (v > hs) hs = v;
  return { delta, rows, onlyMap: onlyA, onlyStudy: onlyB, hot: { map: hm, study: hs }, mean: cnt ? sum / cnt : NaN, most };
}
