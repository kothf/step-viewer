// Hole wizard data (FR-FT-051): ISO metric coarse and fine threads, ISO 273 clearance holes,
// counterbores for ISO 4762 socket head cap screws (DIN 974-1) and 90° countersinks for ISO 10642 (DIN 7991
// above M20), plus ANSI inch UNC/UNF sizes. Sizes in millimetres.

export interface HoleSize {
  size: string;
  pitch: number;
  /** Tap drill for the thread. */
  tap: number;
  /** ISO 273 clearance: close (fine), normal (medium), loose (coarse). Inch: close, free, loose. */
  clear: { close: number; normal: number; loose: number };
  /** Counterbore for a socket head cap screw (ISO 4762 / ASME B18.3): diameter and depth. */
  cbore: [number, number];
  /** Countersink diameter for a countersunk screw (ISO 10642 90°, inch flat heads 82°). */
  csink: number;
  /** Nominal (major) diameter; absent = the number after "M". */
  major?: number;
  /** Countersink angle in degrees; absent = 90. */
  csAng?: number;
}

/** Hole standards (FR-FT-051), as in a CAD app's Standard box. */
export type HoleStandard = "iso" | "isofine" | "unc" | "unf";

export const ISO_METRIC: HoleSize[] = [
  { size: "M1.6", pitch: 0.35, tap: 1.25, clear: { close: 1.7, normal: 1.8, loose: 2 }, cbore: [3.5, 1.9], csink: 3.2 },
  { size: "M2", pitch: 0.4, tap: 1.6, clear: { close: 2.2, normal: 2.4, loose: 2.6 }, cbore: [4.4, 2.3], csink: 4.4 },
  { size: "M2.5", pitch: 0.45, tap: 2.05, clear: { close: 2.7, normal: 2.9, loose: 3.1 }, cbore: [5.5, 2.8], csink: 5.5 },
  { size: "M3", pitch: 0.5, tap: 2.5, clear: { close: 3.2, normal: 3.4, loose: 3.6 }, cbore: [6.5, 3.3], csink: 6.72 },
  { size: "M4", pitch: 0.7, tap: 3.3, clear: { close: 4.3, normal: 4.5, loose: 4.8 }, cbore: [8, 4.4], csink: 8.96 },
  { size: "M5", pitch: 0.8, tap: 4.2, clear: { close: 5.3, normal: 5.5, loose: 5.8 }, cbore: [10, 5.4], csink: 11.2 },
  { size: "M6", pitch: 1, tap: 5, clear: { close: 6.4, normal: 6.6, loose: 7 }, cbore: [11, 6.4], csink: 13.44 },
  { size: "M8", pitch: 1.25, tap: 6.8, clear: { close: 8.4, normal: 9, loose: 10 }, cbore: [15, 8.6], csink: 17.92 },
  { size: "M10", pitch: 1.5, tap: 8.5, clear: { close: 10.5, normal: 11, loose: 12 }, cbore: [18, 10.6], csink: 22.4 },
  { size: "M12", pitch: 1.75, tap: 10.2, clear: { close: 13, normal: 13.5, loose: 14.5 }, cbore: [20, 12.6], csink: 26.88 },
  { size: "M14", pitch: 2, tap: 12, clear: { close: 15, normal: 15.5, loose: 16.5 }, cbore: [24, 14.6], csink: 30.8 },
  { size: "M16", pitch: 2, tap: 14, clear: { close: 17, normal: 17.5, loose: 18.5 }, cbore: [26, 16.6], csink: 33.6 },
  { size: "M18", pitch: 2.5, tap: 15.5, clear: { close: 19, normal: 20, loose: 21 }, cbore: [30, 18.6], csink: 36 },
  { size: "M20", pitch: 2.5, tap: 17.5, clear: { close: 21, normal: 22, loose: 24 }, cbore: [33, 20.6], csink: 40.32 },
  { size: "M22", pitch: 2.5, tap: 19.5, clear: { close: 23, normal: 24, loose: 26 }, cbore: [36, 22.6], csink: 44 },
  { size: "M24", pitch: 3, tap: 21, clear: { close: 25, normal: 26, loose: 28 }, cbore: [40, 24.8], csink: 48 },
  // ISO 10642 / DIN 7991 stop at M20 / M24; larger countersinks are 2 × d, like the smaller ones.
  { size: "M27", pitch: 3, tap: 24, clear: { close: 28, normal: 30, loose: 32 }, cbore: [46, 27.8], csink: 54 },
  { size: "M30", pitch: 3.5, tap: 26.5, clear: { close: 31, normal: 33, loose: 35 }, cbore: [50, 30.8], csink: 60 },
  { size: "M33", pitch: 3.5, tap: 29.5, clear: { close: 34, normal: 36, loose: 38 }, cbore: [54, 33.8], csink: 66 },
  { size: "M36", pitch: 4, tap: 32, clear: { close: 37, normal: 39, loose: 42 }, cbore: [58, 36.8], csink: 72 },
  { size: "M42", pitch: 4.5, tap: 37.5, clear: { close: 43, normal: 45, loose: 48 }, cbore: [69, 42.8], csink: 84 },
  { size: "M48", pitch: 5, tap: 43, clear: { close: 50, normal: 52, loose: 56 }, cbore: [78, 48.8], csink: 96 },
  { size: "M56", pitch: 5.5, tap: 50.5, clear: { close: 58, normal: 62, loose: 66 }, cbore: [93, 56.8], csink: 112 },
  { size: "M64", pitch: 6, tap: 58, clear: { close: 66, normal: 70, loose: 74 }, cbore: [106, 64.8], csink: 128 },
];

/** ISO 261 fine pitches in common use; tap drill d − P, the rest as the coarse size. */
const FINE: [string, number][] = [["M8", 1], ["M10", 1], ["M10", 1.25], ["M12", 1.25], ["M12", 1.5], ["M14", 1.5], ["M16", 1.5], ["M18", 1.5], ["M20", 1.5], ["M20", 2],
  ["M22", 1.5], ["M24", 2], ["M27", 2], ["M30", 2], ["M33", 2], ["M36", 3], ["M42", 3], ["M48", 3], ["M56", 4], ["M64", 4]];
export const ISO_FINE: HoleSize[] = FINE.map(([m, p]) => {
  const c = ISO_METRIC.find(h => h.size === m)!, d = parseFloat(m.slice(1));
  return { ...c, size: `${m}x${p}`, pitch: p, tap: Math.round((d - p) * 100) / 100, major: d };
});

const IN = 25.4;
/**
 * ANSI inch rows (inches): size, major, [UNC tpi, tap], [UNF tpi, tap], clearance close / free (common drill charts),
 * socket head cap screw counterbore diameter (depth = d), 82° flat head diameter (ASME B18.6.3). Loose = free + 1/32.
 */
const INCH: [string, number, [number, number], [number, number], number, number, number, number][] = [
  ["#2", 0.086, [56, 0.07], [64, 0.07], 0.089, 0.096, 0.1875, 0.172],
  ["#4", 0.112, [40, 0.089], [48, 0.0935], 0.116, 0.1285, 0.2188, 0.225],
  ["#6", 0.138, [32, 0.1065], [40, 0.113], 0.144, 0.1495, 0.2812, 0.279],
  ["#8", 0.164, [32, 0.136], [36, 0.136], 0.1695, 0.177, 0.3125, 0.332],
  ["#10", 0.19, [24, 0.1495], [32, 0.159], 0.196, 0.201, 0.375, 0.385],
  ["1/4", 0.25, [20, 0.201], [28, 0.213], 0.257, 0.266, 0.4375, 0.507],
  ["5/16", 0.3125, [18, 0.257], [24, 0.272], 0.323, 0.332, 0.5312, 0.635],
  ["3/8", 0.375, [16, 0.3125], [24, 0.332], 0.386, 0.397, 0.625, 0.762],
  ["7/16", 0.4375, [14, 0.368], [20, 0.3906], 0.4531, 0.4687, 0.7188, 0.812],
  ["1/2", 0.5, [13, 0.4219], [20, 0.4531], 0.5156, 0.5312, 0.8125, 0.875],
  ["5/8", 0.625, [11, 0.5312], [18, 0.5781], 0.6406, 0.6562, 1, 1.125],
  ["3/4", 0.75, [10, 0.6562], [16, 0.6875], 0.7656, 0.7812, 1.1875, 1.375],
  ["1", 1, [8, 0.875], [12, 0.9219], 1.0156, 1.0312, 1.625, 1.875],
];
const mm = (v: number) => Math.round(v * IN * 1000) / 1000;
const inch = (k: 2 | 3, kind: string): HoleSize[] => INCH.map(r => {
  const [tpi, tap] = r[k];
  return { size: `${r[0]}-${tpi} ${kind}`, pitch: Math.round((IN / tpi) * 10000) / 10000, tap: mm(tap), major: mm(r[1]),
    clear: { close: mm(r[4]), normal: mm(r[5]), loose: mm(r[5] + 1 / 32) }, cbore: [mm(r[6]), mm(r[1])], csink: mm(r[7]), csAng: 82 };
});
export const ANSI_UNC = inch(2, "UNC");
export const ANSI_UNF = inch(3, "UNF");

export const HOLE_STANDARDS: Record<HoleStandard, HoleSize[]> = { iso: ISO_METRIC, isofine: ISO_FINE, unc: ANSI_UNC, unf: ANSI_UNF };
const ALL = [...ISO_METRIC, ...ISO_FINE, ...ANSI_UNC, ...ANSI_UNF];

/** The standard a size belongs to (ISO coarse when unknown). */
export const standardOf = (s: string | undefined): HoleStandard =>
  (Object.keys(HOLE_STANDARDS) as HoleStandard[]).find(k => HOLE_STANDARDS[k].some(h => h.size === s)) ?? "iso";
/** Nominal (major) diameter in mm. */
export const majorOf = (h: HoleSize) => h.major ?? parseFloat(h.size.slice(1));
/** Internal thread tolerance class for a callout: 6H for metric, 2B for unified inch. */
export const threadClass = (s: string | undefined) => (s && / UN[CF]$/.test(s) ? "2B" : "6H");
export const holeSize = (s: string | undefined) => ALL.find(h => h.size === s);

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

/**
 * Screw types a counterbore or countersink is sized for (FR-FT-051), as in a CAD app's Type box. Heads as [dk, k]
 * (head Ø, head height) per size, from the screw standards: ISO 4762 / DIN 7984 / ISO 7380 / ISO 1207 maximum
 * head sizes; ISO 10642 and ISO 2009 / 7046 theoretical countersunk head Ø (ISO 7721). A counterbore for a head
 * keeps the clearance DIN 974-1 gives the ISO 4762 head of that size (Ø and depth over the head); a countersink is
 * the head's theoretical Ø at 90°. Inch sizes have the one type their table is for.
 */
export type ScrewType = NonNullable<import("./types").HoleFeature["screw"]>;
type Head = [number, number];
const HEADS: Record<ScrewType, Record<string, Head>> = {
  iso4762: { "M1.6": [3, 1.6], M2: [3.8, 2], "M2.5": [4.5, 2.5], M3: [5.5, 3], M4: [7, 4], M5: [8.5, 5], M6: [10, 6], M8: [13, 8], M10: [16, 10], M12: [18, 12], M14: [21, 14], M16: [24, 16], M20: [30, 20], M24: [36, 24] },
  din7984: { M3: [5.5, 2], M4: [7, 2.8], M5: [8.5, 3.5], M6: [10, 4], M8: [13, 5], M10: [16, 6], M12: [18, 7], M14: [21, 8], M16: [24, 9], M20: [30, 11], M24: [36, 13] },
  iso7380: { M3: [5.7, 1.65], M4: [7.6, 2.2], M5: [9.5, 2.75], M6: [10.5, 3.3], M8: [14, 4.4], M10: [17.5, 5.5], M12: [21, 6.6], M16: [28, 8.8] },
  iso1207: { "M1.6": [3, 1.1], M2: [3.8, 1.4], "M2.5": [4.5, 1.8], M3: [5.5, 2], M4: [7, 2.6], M5: [8.5, 3.3], M6: [10, 3.9], M8: [13, 5], M10: [16, 6] },
  iso10642: {},
  iso2009: { "M1.6": [3.6, 1], M2: [4.4, 1.2], "M2.5": [5.5, 1.5], M3: [6.3, 1.65], M4: [9.4, 2.7], M5: [10.4, 2.7], M6: [12.6, 3.3], M8: [17.3, 4.65], M10: [20, 5] },
};
export const SCREW_TYPES: { key: ScrewType; pocket: "cbore" | "csink"; label: string }[] = [
  { key: "iso4762", pocket: "cbore", label: "Socket head cap screw (ISO 4762)" },
  { key: "din7984", pocket: "cbore", label: "Low head cap screw (DIN 7984)" },
  { key: "iso7380", pocket: "cbore", label: "Button head screw (ISO 7380)" },
  { key: "iso1207", pocket: "cbore", label: "Slotted cheese head screw (ISO 1207)" },
  { key: "iso10642", pocket: "csink", label: "Countersunk socket screw (ISO 10642)" },
  { key: "iso2009", pocket: "csink", label: "Countersunk slotted or cross screw (ISO 2009 / 7046)" },
];
/** The screw type a pocket is sized for when none is chosen. */
export const defaultScrew = (pocket: "cbore" | "csink"): ScrewType => (pocket === "cbore" ? "iso4762" : "iso10642");
const metric = (h: HoleSize) => /^M/.test(h.size);
/** Screw types offered for a size and pocket: every type with a head of that size (metric), else the default. */
export function screwTypes(size: string | undefined, pocket: "cbore" | "csink"): ScrewType[] {
  const h = holeSize(size);
  const all = SCREW_TYPES.filter(s => s.pocket === pocket).map(s => s.key);
  if (!h || !metric(h)) return [defaultScrew(pocket)];
  const nom = h.major ? `M${h.major}` : h.size;
  return all.filter(k => k === defaultScrew(pocket) || HEADS[k][nom]);
}
/**
 * The pocket for a screw type and size: counterbore [Ø, depth] or countersink [Ø, angle in degrees]; null when that
 * type has no head of that size.
 */
export function headPocket(size: string | undefined, screw: ScrewType | undefined, pocket: "cbore" | "csink"): [number, number] | null {
  const h = holeSize(size);
  if (!h) return null;
  const k = screw ?? defaultScrew(pocket);
  if (k === defaultScrew(pocket) || !metric(h)) return pocket === "cbore" ? [h.cbore[0], h.cbore[1]] : [h.csink, h.csAng ?? 90];
  const nom = h.major ? `M${h.major}` : h.size, head = HEADS[k]?.[nom], ref = HEADS.iso4762[nom];
  if (!head) return null;
  if (pocket === "csink") return [head[0], 90];
  if (!ref) return null;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [r2(head[0] + h.cbore[0] - ref[0]), r2(head[1] + h.cbore[1] - ref[1])];
}

/** Internal thread tolerance classes offered for a size (ISO 965 / ASME B1.1), the usual one first. */
export const threadClasses = (s: string | undefined) => (s && / UN[CF]$/.test(s) ? ["2B", "1B", "3B"] : ["6H", "4H", "5H", "7H", "6G"]);

/**
 * Tapered pipe threads (FR-FT-051, a CAD app's Tapered Tap): NPT (ASME B1.20.1) and Rc / BSPT (ISO 7-1). The
 * internal thread narrows into the hole by 1:16 on the diameter; `major`/`minor` are its diameters at the face,
 * `len` the thread length (NPT: effective thread L2; Rc: useful thread) and `tap` the drill. Sizes in millimetres.
 */
export interface TaperSize { size: string; pitch: number; tap: number; major: number; minor: number; len: number }
export type TaperStandard = "npt" | "bspt";
/** Diameter change per unit depth of a pipe taper (1:16 on the diameter). */
export const TAPER = 1 / 16;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
// NPT rows (inches): size, threads per inch, E0 (pitch diameter at the small end), L2, tap drill.
const NPT: [string, number, number, number, number][] = [
  ["1/16", 27, 0.27118, 0.2611, 0.246], ["1/8", 27, 0.36351, 0.2639, 0.339], ["1/4", 18, 0.47739, 0.4018, 0.4375],
  ["3/8", 18, 0.61201, 0.4078, 0.5781], ["1/2", 14, 0.75843, 0.5337, 0.7188], ["3/4", 14, 0.96768, 0.5457, 0.9219],
  ["1", 11.5, 1.21363, 0.6828, 1.1562], ["1-1/4", 11.5, 1.55713, 0.7068, 1.5], ["1-1/2", 11.5, 1.79609, 0.7235, 1.7344],
  ["2", 11.5, 2.26902, 0.7565, 2.2188],
];
export const ANSI_NPT: TaperSize[] = NPT.map(([s, tpi, e0, l2, tap]) => {
  // Pitch diameter at the face = E0 + L2/16; the NPT thread is 0.8p deep.
  const p = 1 / tpi, e = e0 + l2 * TAPER;
  return { size: `${s}-${tpi} NPT`, pitch: r3(p * IN), tap: mm(tap), major: mm(e + 0.8 * p), minor: mm(e - 0.8 * p), len: mm(l2) };
});
// Rc rows (ISO 7-1): size, threads per inch, gauge (major) diameter at the face mm, useful thread length mm, tap drill mm.
const RC: [string, number, number, number, number][] = [
  ["1/16", 28, 7.723, 6.5, 6.2], ["1/8", 28, 9.728, 6.5, 8.4], ["1/4", 19, 13.157, 9.7, 11.2], ["3/8", 19, 16.662, 10.1, 14.75],
  ["1/2", 14, 20.955, 13.2, 18.25], ["3/4", 14, 26.441, 14.5, 23.75], ["1", 11, 33.249, 16.8, 30], ["1-1/4", 11, 41.91, 19.1, 38.5],
  ["1-1/2", 11, 47.803, 19.1, 44.5], ["2", 11, 59.614, 23.4, 56],
];
export const ISO_RC: TaperSize[] = RC.map(([s, tpi, D, len, tap]) => {
  // Whitworth form: thread height 0.640327p.
  const p = IN / tpi;
  return { size: `Rc ${s}`, pitch: r3(p), tap, major: D, minor: r3(D - 2 * 0.640327 * p), len };
});
export const TAPER_STANDARDS: Record<TaperStandard, TaperSize[]> = { npt: ANSI_NPT, bspt: ISO_RC };
export const taperSize = (s: string | undefined) => [...ANSI_NPT, ...ISO_RC].find(h => h.size === s);
export const taperStandardOf = (s: string | undefined): TaperStandard => (s && /^Rc /.test(s) ? "bspt" : "npt");
