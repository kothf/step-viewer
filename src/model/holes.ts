// Hole wizard data (FR-FT-051): ISO metric coarse threads, ISO 273 clearance holes,
// counterbores for ISO 4762 socket head cap screws and 90° countersinks for ISO 10642.
// Sizes in millimetres.

export interface HoleSize {
  size: string;
  pitch: number;
  /** Tap drill for the thread. */
  tap: number;
  /** ISO 273 clearance: close (fine), normal (medium), loose (coarse). */
  clear: { close: number; normal: number; loose: number };
  /** Counterbore for a socket head cap screw (ISO 4762): diameter and depth. */
  cbore: [number, number];
  /** Countersink diameter for a 90° countersunk screw (ISO 10642). */
  csink: number;
}

export const ISO_METRIC: HoleSize[] = [
  { size: "M2", pitch: 0.4, tap: 1.6, clear: { close: 2.2, normal: 2.4, loose: 2.6 }, cbore: [4.4, 2.3], csink: 4.4 },
  { size: "M2.5", pitch: 0.45, tap: 2.05, clear: { close: 2.7, normal: 2.9, loose: 3.1 }, cbore: [5.5, 2.8], csink: 5.5 },
  { size: "M3", pitch: 0.5, tap: 2.5, clear: { close: 3.2, normal: 3.4, loose: 3.6 }, cbore: [6.5, 3.3], csink: 6.72 },
  { size: "M4", pitch: 0.7, tap: 3.3, clear: { close: 4.3, normal: 4.5, loose: 4.8 }, cbore: [8, 4.4], csink: 8.96 },
  { size: "M5", pitch: 0.8, tap: 4.2, clear: { close: 5.3, normal: 5.5, loose: 5.8 }, cbore: [10, 5.4], csink: 11.2 },
  { size: "M6", pitch: 1, tap: 5, clear: { close: 6.4, normal: 6.6, loose: 7 }, cbore: [11, 6.4], csink: 13.44 },
  { size: "M8", pitch: 1.25, tap: 6.8, clear: { close: 8.4, normal: 9, loose: 10 }, cbore: [15, 8.6], csink: 17.92 },
  { size: "M10", pitch: 1.5, tap: 8.5, clear: { close: 10.5, normal: 11, loose: 12 }, cbore: [18, 10.6], csink: 22.4 },
  { size: "M12", pitch: 1.75, tap: 10.2, clear: { close: 13, normal: 13.5, loose: 14.5 }, cbore: [20, 12.6], csink: 26.88 },
  { size: "M16", pitch: 2, tap: 14, clear: { close: 17, normal: 17.5, loose: 18.5 }, cbore: [26, 16.6], csink: 33.6 },
  { size: "M20", pitch: 2.5, tap: 17.5, clear: { close: 21, normal: 22, loose: 24 }, cbore: [33, 20.6], csink: 40.32 },
  { size: "M24", pitch: 3, tap: 21, clear: { close: 25, normal: 26, loose: 28 }, cbore: [40, 24.8], csink: 48 },
];

export const holeSize = (s: string | undefined) => ISO_METRIC.find(h => h.size === s);

/** A hole for a heat-set threaded insert in plastic (FR-FT-051): straight hole, insert length, wall. */
export interface InsertSize {
  size: string;
  /** Hole diameter for the insert. */
  hole: number;
  /** Insert length; the hole goes 1 mm deeper for the displaced plastic. */
  length: number;
  /** Least wall around the hole. */
  wall: number;
}

/** Common sizes for brass heat-set inserts in 3D-printed parts (makers' recommended holes). */
export const HEAT_INSERTS: InsertSize[] = [
  { size: "M2", hole: 3.2, length: 4, wall: 1.3 },
  { size: "M2.5", hole: 3.6, length: 5.7, wall: 1.5 },
  { size: "M3", hole: 4, length: 5.7, wall: 1.6 },
  { size: "M4", hole: 5.6, length: 8.1, wall: 2.1 },
  { size: "M5", hole: 6.4, length: 9.5, wall: 2.6 },
  { size: "M6", hole: 8, length: 12.7, wall: 3 },
  { size: "M8", hole: 9.6, length: 12.7, wall: 3.5 },
];

export const insertSize = (s: string | undefined) => HEAT_INSERTS.find(h => h.size === s);

/**
 * Hole features for holes found on a body (FR-FT-102): one simple Hole per opening face, size, end and
 * depth, holding every centre of that group. Ids from `id`; names are left empty for the caller.
 */
export function recognizedHoleFeatures(holes: import("./types").RecognizedHole[], id: () => string): import("./types").HoleFeature[] {
  const groups = new Map<string, { h: import("./types").RecognizedHole; pts: [number, number][] }>();
  for (const h of holes) {
    const k = `${"face" in h.plane ? h.plane.face.name : ""}|${h.diameter.toFixed(6)}|${h.end}|${h.end === "blind" ? h.depth.toFixed(6) : ""}|${h.flat}`
      + `|${h.cb ? `${h.cb.dia.toFixed(6)},${h.cb.depth.toFixed(6)}` : ""}|${h.cs ? `${h.cs.dia.toFixed(6)},${h.cs.angle.toFixed(6)}` : ""}`;
    const g = groups.get(k);
    if (g) g.pts.push(h.pt); else groups.set(k, { h, pts: [h.pt] });
  }
  // Counterbored and countersunk holes come back as Hole Wizard holes of that kind (FeatureWorks does the same).
  return [...groups.values()].map(({ h, pts }) => ({ id: id(), type: "hole", name: "", plane: h.plane, pts,
    kind: h.cb ? "cbore" : h.cs ? "csink" : "simple", diameter: { v: h.diameter }, end: h.end, depth: { v: h.end === "blind" ? h.depth : 10 },
    ...(h.flat && h.end === "blind" ? { flat: true } : {}),
    ...(h.cb ? { cbDia: { v: h.cb.dia }, cbDepth: { v: h.cb.depth } } : {}),
    ...(h.cs ? { csDia: { v: h.cs.dia }, csAngle: { v: h.cs.angle } } : {}) }));
}
