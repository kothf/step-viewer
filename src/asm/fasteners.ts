// Toolbox (FR-ASM-028): standard parts generated as parametric parts: ISO screws, set screws, nuts,
// washers, dowel and spring pins, DIN 6885 keys and deep groove ball bearings. Global variables drive
// the sketch dimensions and feature depths, and each size is a configuration (its variables), so a part
// can be switched to another size like any configured part. Every part has its axis on Z. Parts that sit
// on the hole (screw heads, nuts, washers, keys) have that face on z = 0 facing -Z; parts that go in
// flush (countersunk and set screws, pins, bearings) have their top face on z = 0 facing +Z. Placing one
// on a hole is a concentric mate on the axis plus a coincident one on that face.
import { newPart } from "../model/doc";
import { activate, captureState } from "../model/configs";
import { refreshExprs } from "../model/params";
import type { ExtrudeFeature, Feature, GlobalVar, Num, PartDoc, SketchFeature, SkDim, SkEnt, SkRel } from "../model/types";

export type FastenerKind = "iso4762" | "iso4017" | "iso4014" | "iso7380" | "iso10642" | "iso4026"
  | "iso4032" | "iso4035" | "iso7040" | "iso4161" | "iso7089" | "iso7092" | "iso7093"
  | "iso2338" | "iso8752" | "din6885" | "bearing" | "bearingf" | "thrust" | "linear" | "needle" | "standoff" | "standoffm" | "spacer" | "din127" | "din471" | "din472"
  | "b183" | "b1821" | "b1822" | "b1822m" | "b1822w";

/**
 * Per size: d nominal (pin Ø, key width, bearing bore), dk head Ø, k head height, s key (hex socket or
 * across flats), t socket depth, m nut height, d1/d2/h washer (d1 also a spring pin's bore), dc/c collar or
 * flange Ø and height, b/hk key width and height, D/B bearing outside Ø and width, lmin/lmax length range.
 */
interface Row {
  d: number; dk?: number; k?: number; s?: number; t?: number; m?: number; d1?: number; d2?: number; h?: number; dc?: number; c?: number; hk?: number; b?: number; D?: number; B?: number; lmin?: number; lmax?: number;
  /** Detail values `detailRow` works out per size and length: tip/edge chamfer, head chamfer, thread length and Ø, bearing shield radii and depth. */
  ch?: number; hc?: number; tl?: number; td?: number; si?: number; so?: number; sd?: number;
  /** Male standoff: stud length; its internal thread depth. Split rings and spring washers: the opening's width. */
  ls?: number; bd?: number; g?: number;
  /** Inch sizes: thread pitch (mm), from the threads per inch. */
  p?: number;
}

/** ISO 261 coarse pitches by nominal Ø (the thread drawn on screws and nuts). */
export const COARSE_PITCH: Record<number, number> = { 1.6: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 20: 2.5, 24: 3, 30: 3.5, 36: 4, 42: 4.5, 48: 5, 56: 5.5, 64: 6 };
const r2 = (v: number) => Math.round(v * 100) / 100;

const T4762: Record<string, Row> = {
  "M1.6": { d: 1.6, dk: 3, k: 1.6, s: 1.5, t: 0.7 },
  M2: { d: 2, dk: 3.8, k: 2, s: 1.5, t: 1 }, "M2.5": { d: 2.5, dk: 4.5, k: 2.5, s: 2, t: 1.1 }, M3: { d: 3, dk: 5.5, k: 3, s: 2.5, t: 1.3 },
  M4: { d: 4, dk: 7, k: 4, s: 3, t: 2 }, M5: { d: 5, dk: 8.5, k: 5, s: 4, t: 2.5 }, M6: { d: 6, dk: 10, k: 6, s: 5, t: 3 },
  M8: { d: 8, dk: 13, k: 8, s: 6, t: 4 }, M10: { d: 10, dk: 16, k: 10, s: 8, t: 5 }, M12: { d: 12, dk: 18, k: 12, s: 10, t: 6 },
  M14: { d: 14, dk: 21, k: 14, s: 12, t: 7 }, M16: { d: 16, dk: 24, k: 16, s: 14, t: 8 }, M20: { d: 20, dk: 30, k: 20, s: 17, t: 10 },
  M24: { d: 24, dk: 36, k: 24, s: 19, t: 12 }, M30: { d: 30, dk: 45, k: 30, s: 22, t: 15.5 },
  M36: { d: 36, dk: 54, k: 36, s: 27, t: 19 }, M42: { d: 42, dk: 63, k: 42, s: 32, t: 24 }, M48: { d: 48, dk: 72, k: 48, s: 36, t: 28 },
  M56: { d: 56, dk: 84, k: 56, s: 41, t: 34 }, M64: { d: 64, dk: 96, k: 64, s: 46, t: 38 },
};
const T4017: Record<string, Row> = {
  "M1.6": { d: 1.6, s: 3.2, k: 1.1 },
  M2: { d: 2, s: 4, k: 1.4 }, "M2.5": { d: 2.5, s: 5, k: 1.7 }, M3: { d: 3, s: 5.5, k: 2 }, M4: { d: 4, s: 7, k: 2.8 },
  M5: { d: 5, s: 8, k: 3.5 }, M6: { d: 6, s: 10, k: 4 }, M8: { d: 8, s: 13, k: 5.3 }, M10: { d: 10, s: 16, k: 6.4 },
  M12: { d: 12, s: 18, k: 7.5 }, M14: { d: 14, s: 21, k: 8.8 }, M16: { d: 16, s: 24, k: 10 }, M20: { d: 20, s: 30, k: 12.5 },
  M24: { d: 24, s: 36, k: 15 }, M30: { d: 30, s: 46, k: 18.7 }, M36: { d: 36, s: 55, k: 22.5 },
  M42: { d: 42, s: 65, k: 26 }, M48: { d: 48, s: 75, k: 30 }, M56: { d: 56, s: 85, k: 35 }, M64: { d: 64, s: 95, k: 40 },
};
const T7380: Record<string, Row> = {
  M3: { d: 3, dk: 5.7, k: 1.65, s: 2, t: 1.04 }, M4: { d: 4, dk: 7.6, k: 2.2, s: 2.5, t: 1.3 }, M5: { d: 5, dk: 9.5, k: 2.75, s: 3, t: 1.56 },
  M6: { d: 6, dk: 10.5, k: 3.3, s: 4, t: 2.08 }, M8: { d: 8, dk: 14, k: 4.4, s: 5, t: 2.6 }, M10: { d: 10, dk: 17.5, k: 5.5, s: 6, t: 3.12 },
  M12: { d: 12, dk: 21, k: 6.6, s: 8, t: 4.16 }, M16: { d: 16, dk: 28, k: 8.8, s: 10, t: 5.2 },
};
const T4032: Record<string, Row> = {
  "M1.6": { d: 1.6, s: 3.2, m: 1.3 },
  M2: { d: 2, s: 4, m: 1.6 }, "M2.5": { d: 2.5, s: 5, m: 2 }, M3: { d: 3, s: 5.5, m: 2.4 }, M4: { d: 4, s: 7, m: 3.2 },
  M5: { d: 5, s: 8, m: 4.7 }, M6: { d: 6, s: 10, m: 5.2 }, M8: { d: 8, s: 13, m: 6.8 }, M10: { d: 10, s: 16, m: 8.4 },
  M12: { d: 12, s: 18, m: 10.8 }, M14: { d: 14, s: 21, m: 12.8 }, M16: { d: 16, s: 24, m: 14.8 }, M20: { d: 20, s: 30, m: 18 },
  M24: { d: 24, s: 36, m: 21.5 }, M30: { d: 30, s: 46, m: 25.6 }, M36: { d: 36, s: 55, m: 31 },
  M42: { d: 42, s: 65, m: 34 }, M48: { d: 48, s: 75, m: 38 }, M56: { d: 56, s: 85, m: 45 }, M64: { d: 64, s: 95, m: 51 },
};
const T7089: Record<string, Row> = {
  "M1.6": { d: 1.6, d1: 1.7, d2: 4, h: 0.3 },
  M2: { d: 2, d1: 2.2, d2: 5, h: 0.3 }, "M2.5": { d: 2.5, d1: 2.7, d2: 6, h: 0.5 }, M3: { d: 3, d1: 3.2, d2: 7, h: 0.5 },
  M4: { d: 4, d1: 4.3, d2: 9, h: 0.8 }, M5: { d: 5, d1: 5.3, d2: 10, h: 1 }, M6: { d: 6, d1: 6.4, d2: 12, h: 1.6 },
  M8: { d: 8, d1: 8.4, d2: 16, h: 1.6 }, M10: { d: 10, d1: 10.5, d2: 20, h: 2 }, M12: { d: 12, d1: 13, d2: 24, h: 2.5 },
  M14: { d: 14, d1: 15, d2: 28, h: 2.5 }, M16: { d: 16, d1: 17, d2: 30, h: 3 }, M20: { d: 20, d1: 21, d2: 37, h: 3 },
  M24: { d: 24, d1: 25, d2: 44, h: 4 }, M30: { d: 30, d1: 31, d2: 56, h: 4 }, M36: { d: 36, d1: 37, d2: 66, h: 5 },
  M42: { d: 42, d1: 45, d2: 78, h: 8 }, M48: { d: 48, d1: 52, d2: 92, h: 8 }, M56: { d: 56, d1: 62, d2: 105, h: 10 }, M64: { d: 64, d1: 70, d2: 115, h: 10 },
};

// ISO 10642: theoretical head Ø with a 90° countersink, so k = (dk - d) / 2.
const T10642: Record<string, Row> = {
  M3: { d: 3, dk: 6.72, k: 1.86, s: 2, t: 1.1 }, M4: { d: 4, dk: 8.96, k: 2.48, s: 2.5, t: 1.5 }, M5: { d: 5, dk: 11.2, k: 3.1, s: 3, t: 1.9 },
  M6: { d: 6, dk: 13.44, k: 3.72, s: 4, t: 2.2 }, M8: { d: 8, dk: 17.92, k: 4.96, s: 5, t: 3 }, M10: { d: 10, dk: 22.4, k: 6.2, s: 6, t: 3.6 },
  M12: { d: 12, dk: 26.88, k: 7.44, s: 8, t: 4.3 }, M16: { d: 16, dk: 33.6, k: 8.8, s: 10, t: 4.5 }, M20: { d: 20, dk: 40.32, k: 10.16, s: 12, t: 4.8 },
};
const T4026: Record<string, Row> = {
  M2: { d: 2, s: 0.9, t: 0.8 }, "M2.5": { d: 2.5, s: 1.3, t: 1.2 }, M3: { d: 3, s: 1.5, t: 1.2 }, M4: { d: 4, s: 2, t: 1.5 },
  M5: { d: 5, s: 2.5, t: 2 }, M6: { d: 6, s: 3, t: 2 }, M8: { d: 8, s: 4, t: 3 }, M10: { d: 10, s: 5, t: 4 },
  M12: { d: 12, s: 6, t: 4.8 }, M16: { d: 16, s: 8, t: 6.4 }, M20: { d: 20, s: 10, t: 8 },
};
const T4035: Record<string, Row> = {
  M3: { d: 3, s: 5.5, m: 1.8 }, M4: { d: 4, s: 7, m: 2.2 }, M5: { d: 5, s: 8, m: 2.7 }, M6: { d: 6, s: 10, m: 3.2 },
  M8: { d: 8, s: 13, m: 4 }, M10: { d: 10, s: 16, m: 5 }, M12: { d: 12, s: 18, m: 6 }, M16: { d: 16, s: 24, m: 8 }, M20: { d: 20, s: 30, m: 10 },
};
// ISO 7040: hex part m, then the nylon insert collar (Ø dc, height c) up to the total height.
const T7040: Record<string, Row> = {
  M3: { d: 3, s: 5.5, m: 2.4, dc: 5, c: 1.6 }, M4: { d: 4, s: 7, m: 2.9, dc: 6.4, c: 2.1 }, M5: { d: 5, s: 8, m: 3.2, dc: 7.4, c: 1.8 },
  M6: { d: 6, s: 10, m: 4, dc: 9.2, c: 2 }, M8: { d: 8, s: 13, m: 5.5, dc: 12, c: 2.5 }, M10: { d: 10, s: 16, m: 6.5, dc: 14.8, c: 3.5 },
  M12: { d: 12, s: 18, m: 8, dc: 16.6, c: 4 }, M16: { d: 16, s: 24, m: 10.4, dc: 22.2, c: 5.6 }, M20: { d: 20, s: 30, m: 14.1, dc: 27.8, c: 5.9 },
};
// ISO 4161: flange Ø dc, flange height c, total height m.
const T4161: Record<string, Row> = {
  M5: { d: 5, s: 8, m: 5, dc: 11.8, c: 1 }, M6: { d: 6, s: 10, m: 6, dc: 14.2, c: 1.1 }, M8: { d: 8, s: 13, m: 8, dc: 17.9, c: 1.2 },
  M10: { d: 10, s: 15, m: 10, dc: 21.8, c: 1.5 }, M12: { d: 12, s: 18, m: 12, dc: 26, c: 1.8 }, M16: { d: 16, s: 24, m: 16, dc: 34.5, c: 2.4 },
  M20: { d: 20, s: 30, m: 20, dc: 42.8, c: 3 },
};
const T7092: Record<string, Row> = {
  M2: { d: 2, d1: 2.2, d2: 4.5, h: 0.3 }, "M2.5": { d: 2.5, d1: 2.7, d2: 5, h: 0.5 }, M3: { d: 3, d1: 3.2, d2: 6, h: 0.5 },
  M4: { d: 4, d1: 4.3, d2: 8, h: 0.5 }, M5: { d: 5, d1: 5.3, d2: 9, h: 1 }, M6: { d: 6, d1: 6.4, d2: 11, h: 1.6 },
  M8: { d: 8, d1: 8.4, d2: 15, h: 1.6 }, M10: { d: 10, d1: 10.5, d2: 18, h: 1.6 }, M12: { d: 12, d1: 13, d2: 20, h: 2 },
  M16: { d: 16, d1: 17, d2: 28, h: 2.5 }, M20: { d: 20, d1: 21, d2: 34, h: 3 },
};
const T7093: Record<string, Row> = {
  M3: { d: 3, d1: 3.2, d2: 9, h: 0.8 }, M4: { d: 4, d1: 4.3, d2: 12, h: 1 }, M5: { d: 5, d1: 5.3, d2: 15, h: 1.2 },
  M6: { d: 6, d1: 6.4, d2: 18, h: 1.6 }, M8: { d: 8, d1: 8.4, d2: 24, h: 2 }, M10: { d: 10, d1: 10.5, d2: 30, h: 2.5 },
  M12: { d: 12, d1: 13, d2: 37, h: 3 }, M16: { d: 16, d1: 17, d2: 50, h: 3 }, M20: { d: 20, d1: 22, d2: 60, h: 4 },
};
const PIN_D = [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20];
const T2338: Record<string, Row> = Object.fromEntries(PIN_D.map(d => [String(d), { d }]));
// ISO 8752 heavy spring pins: wall s = d1 = d - 2 s.
const T8752: Record<string, Row> = Object.fromEntries(([[2, 0.4], [2.5, 0.5], [3, 0.6], [4, 0.8], [5, 1], [6, 1.2], [8, 1.5], [10, 2], [12, 2.5], [16, 3], [20, 4]] as const)
  .map(([d, s]) => [String(d), { d, d1: +(d - 2 * s).toFixed(2) }]));
// DIN 6885 form B (square ends): b × h, length range.
const T6885: Record<string, Row> = Object.fromEntries(([[2, 2, 6, 20], [3, 3, 6, 36], [4, 4, 8, 45], [5, 5, 10, 56], [6, 6, 14, 70], [8, 7, 18, 90], [10, 8, 22, 110],
  [12, 8, 28, 140], [14, 9, 36, 160], [16, 10, 45, 180], [18, 11, 50, 200], [20, 12, 56, 200]] as const)
  .map(([b, h, lmin, lmax]) => [`${b}x${h}`, { d: b, b, hk: h, lmin, lmax }]));
// Deep groove ball bearings (ISO 15), shown as one ring: bore d, outside D, width B.
const TBRG: Record<string, Row> = Object.fromEntries(([
  ["623", 3, 10, 4], ["624", 4, 13, 5], ["625", 5, 16, 5], ["626", 6, 19, 6], ["608", 8, 22, 7], ["627", 7, 22, 7], ["628", 8, 24, 8], ["609", 9, 24, 7], ["629", 9, 26, 8],
  ["6000", 10, 26, 8], ["6001", 12, 28, 8], ["6002", 15, 32, 9], ["6003", 17, 35, 10], ["6004", 20, 42, 12], ["6005", 25, 47, 12], ["6006", 30, 55, 13],
  ["6007", 35, 62, 14], ["6008", 40, 68, 15], ["6009", 45, 75, 16], ["6010", 50, 80, 16],
  ["6200", 10, 30, 9], ["6201", 12, 32, 10], ["6202", 15, 35, 11], ["6203", 17, 40, 12], ["6204", 20, 47, 14], ["6205", 25, 52, 15], ["6206", 30, 62, 16],
  ["6207", 35, 72, 17], ["6208", 40, 80, 18], ["6209", 45, 85, 19], ["6210", 50, 90, 20],
  ["6300", 10, 35, 11], ["6301", 12, 37, 12], ["6302", 15, 42, 13], ["6303", 17, 47, 14], ["6304", 20, 52, 15], ["6305", 25, 62, 17], ["6306", 30, 72, 19],
  ["6307", 35, 80, 21], ["6308", 40, 90, 23], ["6309", 45, 100, 25], ["6310", 50, 110, 27],
  ["6800", 10, 19, 5], ["6801", 12, 21, 5], ["6802", 15, 24, 5], ["6803", 17, 26, 5], ["6804", 20, 32, 7], ["6805", 25, 37, 7], ["6806", 30, 42, 7],
  ["6900", 10, 22, 6], ["6901", 12, 24, 6], ["6902", 15, 28, 7], ["6903", 17, 30, 7], ["6904", 20, 37, 9], ["6905", 25, 42, 9], ["6906", 30, 47, 9],
] as const).map(([n, d, D, B]) => [n, { d, D, B }]));
// Flanged miniature ball bearings: d, D, B and the flange Ø dc × width c (NSK / Koyo catalogue values).
const TBRGF: Record<string, Row> = Object.fromEntries(([
  ["F623", 3, 10, 4, 11.5, 1], ["F624", 4, 13, 5, 15, 1], ["F625", 5, 16, 5, 18, 1], ["F626", 6, 19, 6, 22, 1.5], ["F608", 8, 22, 7, 25, 1.5],
] as const).map(([n, d, D, B, dc, c]) => [n, { d, D, B, dc, c }]));
// Single direction thrust ball bearings (ISO 104, 511 series): bore d, outside D, height B.
const TTHRUST: Record<string, Row> = Object.fromEntries(([
  ["51100", 10, 24, 9], ["51101", 12, 26, 9], ["51102", 15, 28, 9], ["51103", 17, 30, 9], ["51104", 20, 35, 10], ["51105", 25, 42, 11],
  ["51106", 30, 47, 11], ["51107", 35, 52, 12], ["51108", 40, 60, 13], ["51110", 50, 70, 14],
] as const).map(([n, d, D, B]) => [n, { d, D, B }]));
// Linear ball bearings LM..UU (both ends sealed): shaft d, outside D, length B.
const TLINEAR: Record<string, Row> = Object.fromEntries(([
  ["LM6UU", 6, 12, 19], ["LM8UU", 8, 15, 24], ["LM10UU", 10, 19, 29], ["LM12UU", 12, 21, 30], ["LM13UU", 13, 23, 32], ["LM16UU", 16, 28, 37],
  ["LM20UU", 20, 32, 42], ["LM25UU", 25, 40, 59], ["LM30UU", 30, 45, 64],
] as const).map(([n, d, D, B]) => [n, { d, D, B }]));
// Drawn cup needle roller bearings HK (ISO 3245): roller set bore d (Fw), outside D, width B (C).
const TNEEDLE: Record<string, Row> = Object.fromEntries(([
  ["HK0408", 4, 8, 8], ["HK0509", 5, 9, 9], ["HK0609", 6, 10, 9], ["HK0808", 8, 12, 8], ["HK1010", 10, 14, 10], ["HK1210", 12, 16, 10],
  ["HK1512", 15, 21, 12], ["HK2010", 20, 26, 10], ["HK2512", 25, 32, 12],
] as const).map(([n, d, D, B]) => [n, { d, D, B }]));

// Hex standoffs (common catalogue sizes): across flats s, male stud length ls, internal thread depth bd of the male-female one.
const TSTANDOFF: Record<string, Row> = Object.fromEntries(([["M2", 2, 4, 4], ["M2.5", 2.5, 5, 5], ["M3", 3, 5.5, 6], ["M4", 4, 7, 8], ["M5", 5, 8, 8], ["M6", 6, 10, 10], ["M8", 8, 13, 12]] as const)
  .map(([n, d, s, ls]) => [n, { d, s, ls, bd: Math.min(2 * d, ls + 1) }]));
// Round spacers for a screw: bore = ISO 273 medium clearance, outside Ø.
const TSPACER: Record<string, Row> = Object.fromEntries(([["M2", 2, 2.4, 4], ["M2.5", 2.5, 2.9, 5], ["M3", 3, 3.4, 6], ["M4", 4, 4.5, 8], ["M5", 5, 5.5, 10], ["M6", 6, 6.6, 11], ["M8", 8, 9, 14], ["M10", 10, 11, 18]] as const)
  .map(([n, d, d1, d2]) => [n, { d, d1, d2 }]));
// DIN 127 B spring lock washers: d1, d2, thickness s (h), drawn flat with the split.
const T127: Record<string, Row> = Object.fromEntries(([["M3", 3, 3.1, 6.2, 0.8], ["M4", 4, 4.1, 7.6, 0.9], ["M5", 5, 5.1, 9.2, 1.2], ["M6", 6, 6.1, 11.8, 1.6], ["M8", 8, 8.2, 14.8, 2],
  ["M10", 10, 10.2, 18.1, 2.2], ["M12", 12, 12.2, 21.1, 2.5], ["M16", 16, 16.2, 27.4, 3.5], ["M20", 20, 20.2, 33.6, 4]] as const)
  .map(([n, d, d1, d2, h]) => [n, { d, d1, d2, h, g: +(0.6 * h).toFixed(2) }]));
// DIN 471 rings for shafts (normal type): shaft d1, thickness s, free Ø d3, lug width a, ring width b, groove d2 / m
// (Westfield Fasteners' DIN 471 specification). Drawn as a split ring d3 … d3 + 2b, the opening 0.6 a wide.
const T471: Record<string, Row> = Object.fromEntries(([[8, 0.8, 7.4, 3.2, 1.5, 7.6, 0.9], [10, 1, 9.3, 3.3, 1.8, 9.6, 1.1], [12, 1, 11, 3.3, 1.8, 11.5, 1.1], [14, 1, 12.9, 3.5, 2.1, 13.4, 1.1],
  [15, 1, 13.8, 3.6, 2.2, 14.3, 1.1], [16, 1, 14.7, 3.7, 2.2, 15.2, 1.1], [17, 1, 15.7, 3.8, 2.3, 16.2, 1.1], [18, 1.2, 16.5, 3.9, 2.4, 17, 1.3], [20, 1.2, 18.5, 4, 2.6, 19, 1.3],
  [22, 1.2, 20.5, 4.2, 2.8, 21, 1.3], [25, 1.2, 23.2, 4.4, 3, 23.9, 1.3], [28, 1.5, 25.9, 4.7, 3.2, 26.6, 1.6], [30, 1.5, 27.9, 5, 3.5, 28.6, 1.6], [32, 1.5, 29.6, 5.2, 3.6, 30.3, 1.6],
  [35, 1.5, 32.2, 5.6, 3.9, 33, 1.6], [40, 1.75, 36.5, 6, 4.4, 37.5, 1.85], [45, 1.75, 41.5, 6.7, 4.7, 42.5, 1.85], [50, 2, 45.8, 6.9, 5.1, 47, 2.15], [55, 2, 50.8, 7.2, 5.4, 52, 2.15],
  [60, 2, 55.8, 7.4, 5.8, 57, 2.15]] as const)
  .map(([d, s, d3, a, b, gd, m]) => [String(d), { d, h: s, d1: d3, d2: +(d3 + 2 * b).toFixed(2), b, g: +(0.6 * a).toFixed(2), D: gd, m }]));
// DIN 472 rings for bores (normal type): bore d1, s, free Ø d3, a, b, groove d2 / m (Aspen Fasteners' DIN 472 specification).
// Drawn as a split ring d3 - 2b … d3. Sizes include the outside Ø of the 6xxx bearings.
const T472: Record<string, Row> = Object.fromEntries(([[10, 1, 10.8, 3.2, 1.4, 10.4, 1.1], [12, 1, 13, 3.4, 1.7, 12.5, 1.1], [14, 1, 15.1, 3.7, 1.9, 14.6, 1.1], [15, 1, 16.2, 3.7, 2, 15.7, 1.1],
  [16, 1, 17.3, 3.8, 2, 16.8, 1.1], [17, 1, 18.3, 3.9, 2.1, 17.8, 1.1], [18, 1, 19.5, 4.1, 2.2, 19, 1.1], [19, 1, 20.5, 4.1, 2.2, 20, 1.1], [20, 1, 21.5, 4.2, 2.3, 21, 1.1],
  [22, 1, 23.5, 4.2, 2.5, 23, 1.1], [24, 1.2, 25.9, 4.4, 2.6, 25.2, 1.3], [25, 1.2, 26.9, 4.5, 2.7, 26.2, 1.3], [26, 1.2, 27.9, 4.7, 2.8, 27.2, 1.3], [28, 1.2, 30.1, 4.8, 2.9, 29.4, 1.3],
  [30, 1.2, 32.1, 4.8, 3, 31.4, 1.3], [32, 1.2, 34.4, 5.4, 3.2, 33.7, 1.3], [35, 1.5, 37.8, 5.4, 3.4, 37, 1.6], [37, 1.5, 39.8, 5.5, 3.6, 39, 1.6], [40, 1.8, 43.5, 5.8, 3.9, 42.5, 1.9],
  [42, 1.8, 45.5, 5.9, 4.1, 44.5, 1.9], [47, 1.8, 50.5, 6.4, 4.4, 49.5, 1.9], [52, 2, 56.2, 6.7, 4.7, 55, 2.2], [55, 2, 59.2, 6.8, 5, 58, 2.2], [62, 2, 66.2, 7.3, 5.5, 65, 2.2],
  [72, 2.5, 76.6, 7.8, 6.4, 75, 2.7], [80, 2.5, 85.5, 8.5, 7, 83.5, 2.7]] as const)
  .map(([d, s, d3, a, b, gd, m]) => [String(d), { d, h: s, d1: +(d3 - 2 * b).toFixed(2), d2: d3, b, g: +(0.6 * a).toFixed(2), D: gd, m }]));

// ---------- ANSI inch (UNC) ----------
const IN = 25.4, inMm = (v: number) => Math.round(v * IN * 1000) / 1000;
/** Inch rows: size ("1/4-20"), major Ø and the other values in inches; stored in mm with the pitch from the tpi. */
const inchRows = (rows: (readonly [string, number, ...number[]])[], keys: (keyof Row)[]): Record<string, Row> =>
  Object.fromEntries(rows.map(([n, d, ...vs]) => {
    const r: Row = { d: inMm(d), p: +(IN / +n.split("-")[1]).toFixed(4) };
    keys.forEach((k, i) => { (r as unknown as Record<string, number>)[k] = inMm(vs[i]); });
    return [n, r];
  }));
// ASME B18.3 socket head cap screws: head Ø A, height H = D, hex key J, key engagement T.
const TB183 = inchRows([["#2-56", 0.086, 0.14, 0.086, 0.0781, 0.038], ["#4-40", 0.112, 0.183, 0.112, 0.0938, 0.051], ["#6-32", 0.138, 0.226, 0.138, 0.1094, 0.064],
  ["#8-32", 0.164, 0.27, 0.164, 0.1406, 0.077], ["#10-24", 0.19, 0.312, 0.19, 0.1562, 0.09], ["1/4-20", 0.25, 0.375, 0.25, 0.1875, 0.12],
  ["5/16-18", 0.3125, 0.469, 0.3125, 0.25, 0.151], ["3/8-16", 0.375, 0.562, 0.375, 0.3125, 0.182], ["7/16-14", 0.4375, 0.656, 0.4375, 0.375, 0.213],
  ["1/2-13", 0.5, 0.75, 0.5, 0.375, 0.245], ["5/8-11", 0.625, 0.938, 0.625, 0.5, 0.307], ["3/4-10", 0.75, 1.125, 0.75, 0.625, 0.37], ["1-8", 1, 1.5, 1, 0.75, 0.495]], ["dk", "k", "s", "t"]);
// ASME B18.2.1 hex cap screws: across flats F, head height H.
const TB1821 = inchRows([["1/4-20", 0.25, 0.4375, 0.1562], ["5/16-18", 0.3125, 0.5, 0.2031], ["3/8-16", 0.375, 0.5625, 0.2344], ["7/16-14", 0.4375, 0.625, 0.2812],
  ["1/2-13", 0.5, 0.75, 0.3125], ["5/8-11", 0.625, 0.9375, 0.3906], ["3/4-10", 0.75, 1.125, 0.4688], ["1-8", 1, 1.5, 0.6094]], ["s", "k"]);
// ASME B18.2.2 hex nuts: across flats F, height H.
const TB1822 = inchRows([["1/4-20", 0.25, 0.4375, 0.2188], ["5/16-18", 0.3125, 0.5, 0.2656], ["3/8-16", 0.375, 0.5625, 0.3281], ["7/16-14", 0.4375, 0.6875, 0.375],
  ["1/2-13", 0.5, 0.75, 0.4375], ["5/8-11", 0.625, 0.9375, 0.5469], ["3/4-10", 0.75, 1.125, 0.6406], ["1-8", 1, 1.5, 0.8594]], ["s", "m"]);
// ASME B18.6.3 hex machine screw nuts: across flats F, height H.
const TB1822M = inchRows([["#2-56", 0.086, 0.1875, 0.0625], ["#4-40", 0.112, 0.25, 0.0938], ["#6-32", 0.138, 0.3125, 0.1094], ["#8-32", 0.164, 0.3438, 0.125],
  ["#10-24", 0.19, 0.375, 0.125]], ["s", "m"]);
// ASME B18.22.1 plain washers, type A narrow (SAE): inside Ø, outside Ø, thickness.
const TB1822W = inchRows([["#6-32", 0.138, 0.156, 0.375, 0.049], ["#8-32", 0.164, 0.188, 0.438, 0.049], ["#10-24", 0.19, 0.219, 0.5, 0.049],
  ["1/4-20", 0.25, 0.281, 0.625, 0.065], ["5/16-18", 0.3125, 0.344, 0.688, 0.065], ["3/8-16", 0.375, 0.406, 0.812, 0.065], ["7/16-14", 0.4375, 0.469, 0.922, 0.065],
  ["1/2-13", 0.5, 0.531, 1.062, 0.095], ["5/8-11", 0.625, 0.656, 1.312, 0.095], ["3/4-10", 0.75, 0.812, 1.469, 0.134], ["1-8", 1, 1.062, 2, 0.134]], ["d1", "d2", "h"]);

export type ToolboxGroup = "Screws" | "Nuts" | "Washers" | "Spacers" | "Pins" | "Keys" | "Retaining rings" | "Bearings";
/** How a part sits on a hole: on its z = 0 face facing -Z ("under" the head, a nut or washer), or flush with its top (+Z on z = 0). */
export type SeatKind = "under" | "flush";
export interface FastenerInfo {
  kind: FastenerKind; label: string; name: string; group: ToolboxGroup; seat: SeatKind;
  /** Takes a length (screws, pins, keys). */
  screw: boolean;
  table: Record<string, Row>;
  /** Preferred length range as multiples of d (default 1.5 d to 10 d), unless the row has lmin/lmax. */
  len?: [number, number];
  /** Fixed preferred lengths (standoffs and spacers), instead of `len`. */
  lengths?: number[];
  /** How the size follows a clicked hole: "clear" = largest d that fits, "d" = d matches, "D" = outside Ø (else bore) matches, absent = never. */
  fit?: "clear" | "d" | "D";
  /** Built like this metric standard (the inch ones). */
  like?: FastenerKind;
  /** Inch sizes: lengths in inches, names "1/4-20 x 1-1/2". */
  inch?: boolean;
}

/** The standards, in the order the panel lists them; `screw` ones take a length. */
export const FASTENERS: FastenerInfo[] = [
  { kind: "iso4762", label: "Socket head cap screw (ISO 4762)", name: "ISO 4762", group: "Screws", seat: "under", screw: true, table: T4762, fit: "clear" },
  { kind: "iso4017", label: "Hex head screw (ISO 4017)", name: "ISO 4017", group: "Screws", seat: "under", screw: true, table: T4017, fit: "clear" },
  { kind: "iso4014", label: "Hex head bolt (ISO 4014)", name: "ISO 4014", group: "Screws", seat: "under", screw: true, table: T4017, len: [5, 10], fit: "clear" },
  { kind: "iso7380", label: "Button head screw (ISO 7380)", name: "ISO 7380", group: "Screws", seat: "under", screw: true, table: T7380, len: [1.5, 6], fit: "clear" },
  { kind: "iso10642", label: "Countersunk socket screw (ISO 10642)", name: "ISO 10642", group: "Screws", seat: "flush", screw: true, table: T10642, fit: "clear" },
  { kind: "iso4026", label: "Set screw, flat point (ISO 4026)", name: "ISO 4026", group: "Screws", seat: "flush", screw: true, table: T4026, len: [1, 5], fit: "clear" },
  { kind: "b183", label: "Socket head cap screw, inch (ASME B18.3)", name: "ASME B18.3", group: "Screws", seat: "under", screw: true, table: TB183, fit: "clear", like: "iso4762", inch: true },
  { kind: "b1821", label: "Hex cap screw, inch (ASME B18.2.1)", name: "ASME B18.2.1", group: "Screws", seat: "under", screw: true, table: TB1821, len: [2, 12], fit: "clear", like: "iso4014", inch: true },
  { kind: "iso4032", label: "Hex nut (ISO 4032)", name: "ISO 4032", group: "Nuts", seat: "under", screw: false, table: T4032, fit: "clear" },
  { kind: "iso4035", label: "Thin hex nut (ISO 4035)", name: "ISO 4035", group: "Nuts", seat: "under", screw: false, table: T4035, fit: "clear" },
  { kind: "iso7040", label: "Nylon insert lock nut (ISO 7040)", name: "ISO 7040", group: "Nuts", seat: "under", screw: false, table: T7040, fit: "clear" },
  { kind: "b1822", label: "Hex nut, inch (ASME B18.2.2)", name: "ASME B18.2.2", group: "Nuts", seat: "under", screw: false, table: TB1822, fit: "clear", like: "iso4032", inch: true },
  { kind: "b1822m", label: "Machine screw nut, inch (ASME B18.6.3)", name: "ASME B18.6.3", group: "Nuts", seat: "under", screw: false, table: TB1822M, fit: "clear", like: "iso4032", inch: true },
  { kind: "iso4161", label: "Flange nut (ISO 4161)", name: "ISO 4161", group: "Nuts", seat: "under", screw: false, table: T4161, fit: "clear" },
  { kind: "iso7089", label: "Plain washer (ISO 7089)", name: "ISO 7089", group: "Washers", seat: "under", screw: false, table: T7089, fit: "clear" },
  { kind: "iso7092", label: "Small washer (ISO 7092)", name: "ISO 7092", group: "Washers", seat: "under", screw: false, table: T7092, fit: "clear" },
  { kind: "iso7093", label: "Large washer (ISO 7093)", name: "ISO 7093", group: "Washers", seat: "under", screw: false, table: T7093, fit: "clear" },
  { kind: "b1822w", label: "Plain washer, inch (ASME B18.22.1 A)", name: "ASME B18.22.1", group: "Washers", seat: "under", screw: false, table: TB1822W, fit: "clear", like: "iso7089", inch: true },
  { kind: "din127", label: "Spring lock washer (DIN 127 B)", name: "DIN 127 B", group: "Washers", seat: "under", screw: false, table: T127, fit: "clear" },
  { kind: "standoff", label: "Hex standoff, female-female", name: "Standoff F-F", group: "Spacers", seat: "under", screw: true, table: TSTANDOFF, lengths: [5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60], fit: "clear" },
  { kind: "standoffm", label: "Hex standoff, male-female", name: "Standoff M-F", group: "Spacers", seat: "under", screw: true, table: TSTANDOFF, lengths: [5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60], fit: "clear" },
  { kind: "spacer", label: "Round spacer", name: "Spacer", group: "Spacers", seat: "under", screw: true, table: TSPACER, lengths: [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50], fit: "clear" },
  { kind: "iso2338", label: "Dowel pin (ISO 2338)", name: "ISO 2338", group: "Pins", seat: "flush", screw: true, table: T2338, len: [2, 10], fit: "d" },
  { kind: "iso8752", label: "Spring pin (ISO 8752)", name: "ISO 8752", group: "Pins", seat: "flush", screw: true, table: T8752, len: [2, 10], fit: "d" },
  { kind: "din6885", label: "Parallel key, square ends (DIN 6885 B)", name: "DIN 6885 B", group: "Keys", seat: "under", screw: true, table: T6885 },
  { kind: "din471", label: "Retaining ring for shafts (DIN 471)", name: "DIN 471", group: "Retaining rings", seat: "flush", screw: false, table: T471, fit: "d" },
  { kind: "din472", label: "Retaining ring for bores (DIN 472)", name: "DIN 472", group: "Retaining rings", seat: "flush", screw: false, table: T472, fit: "d" },
  { kind: "bearing", label: "Deep groove ball bearing (ISO 15)", name: "Ball bearing", group: "Bearings", seat: "flush", screw: false, table: TBRG, fit: "D" },
  { kind: "bearingf", label: "Flanged ball bearing", name: "Flanged ball bearing", group: "Bearings", seat: "under", screw: false, table: TBRGF, fit: "D" },
  { kind: "needle", label: "Drawn cup needle roller bearing (HK)", name: "Needle roller bearing", group: "Bearings", seat: "flush", screw: false, table: TNEEDLE, fit: "D" },
  { kind: "linear", label: "Linear ball bearing (LM..UU)", name: "Linear bearing", group: "Bearings", seat: "flush", screw: false, table: TLINEAR, fit: "D" },
  { kind: "thrust", label: "Thrust ball bearing (ISO 104)", name: "Thrust ball bearing", group: "Bearings", seat: "flush", screw: false, table: TTHRUST, fit: "D" },
];
export const TOOLBOX_GROUPS: ToolboxGroup[] = ["Screws", "Nuts", "Washers", "Spacers", "Pins", "Keys", "Retaining rings", "Bearings"];

const LENGTHS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 220, 240, 260, 280, 300];
/** Inch screw lengths, in inches. */
const INCH_LENGTHS = [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8];
const KEY_LENGTHS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 70, 80, 90, 100, 110, 125, 140, 160, 180, 200];

export const fastenerInfo = (kind: FastenerKind) => FASTENERS.find(f => f.kind === kind)!;
export const fastenerSizes = (kind: FastenerKind) => Object.keys(fastenerInfo(kind).table);
/** The metric standard whose geometry `kind` uses (itself, or the one an inch standard is built like). */
export const shapeKind = (kind: FastenerKind): FastenerKind => fastenerInfo(kind).like ?? kind;

const FRAC: [number, string][] = [[0.125, "1/8"], [0.25, "1/4"], [0.375, "3/8"], [0.5, "1/2"], [0.625, "5/8"], [0.75, "3/4"], [0.875, "7/8"]];
/** A length as shown: "20" (mm) or "1-1/2" (inches) for inch standards. */
export function lengthText(kind: FastenerKind, L: number): string {
  if (!fastenerInfo(kind).inch) return `${+L.toFixed(2)}`;
  const v = L / IN, w = Math.floor(v + 1e-6), f = FRAC.find(([x]) => Math.abs(v - w - x) < 1e-4)?.[1];
  return f ? (w ? `${w}-${f}` : f) : Math.abs(v - w) < 1e-4 ? `${w}` : `${+v.toFixed(3)}`;
}
/** A length with its unit, for the panel: "20 mm", "1-1/2 in". */
export const lengthLabel = (kind: FastenerKind, L: number) => `${lengthText(kind, L)} ${fastenerInfo(kind).inch ? "in" : "mm"}`;

/** Preferred lengths for a size: from about 1.5 d to 10 d by default (ISO 4014 bolts start at 5 d, as their shank is partly plain). */
export function fastenerLengths(kind: FastenerKind, size: string): number[] {
  const info = fastenerInfo(kind), row = info.table[size];
  if (!info.screw) return [];
  if (info.lengths) return info.lengths;
  if (row?.lmin !== undefined) return KEY_LENGTHS.filter(l => l >= row.lmin! && l <= row.lmax!);
  const d = row?.d ?? 6, [a, b] = info.len ?? [1.5, 10];
  const lo = Math.max(3, a * d), hi = b * d;
  if (info.inch) return INCH_LENGTHS.map(inMm).filter(l => l >= lo - 1e-9 && l <= hi + 1e-9);
  return LENGTHS.filter(l => l >= lo - 1e-9 && l <= hi + 1e-9);
}
export function defaultLength(kind: FastenerKind, size: string): number {
  const ls = fastenerLengths(kind, size), d = fastenerInfo(kind).table[size]?.d ?? 6;
  return ls.reduce((b, l) => (Math.abs(l - 3 * d) < Math.abs(b - 3 * d) ? l : b), ls[0] ?? 3 * d);
}

/** The preferred length of `kind` in `size` nearest `want` (none for parts without a length). */
export function lengthFor(kind: FastenerKind, size: string, want: number): number {
  const ls = fastenerLengths(kind, size);
  return ls.length ? ls.reduce((b, l) => (Math.abs(l - want) < Math.abs(b - want) ? l : b), ls[0]) : defaultLength(kind, size);
}

/**
 * Library search (FR-ASM-028): every word must be found in the standard's name or label (English or
 * shown), its group, or be one of its sizes ("m6 nut", "4762", "6201", "washer").
 */
export function searchFasteners(q: string, shown: (label: string) => string = x => x): FastenerInfo[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return FASTENERS;
  return FASTENERS.filter(f => {
    const text = `${f.name} ${f.label} ${shown(f.label)} ${f.group} ${shown(f.group)} ${f.kind}${f.inch ? " inch unc ansi" : " metric"}`.toLowerCase();
    const sizes = Object.keys(f.table).map(x => x.toLowerCase());
    // A size matches whole, or by its start from three characters with a digit ("lm8" → LM8UU, "hk10" → HK1010).
    const sizeHit = (w: string) => sizes.includes(w) || (w.length >= 3 && /\d/.test(w) && sizes.some(x => x.startsWith(w)));
    return words.every(w => text.includes(w) || sizeHit(w) || (w.length > 3 && text.includes(w.replace(/s$/, ""))));
  });
}

/** The part name, as in SolidWorks Toolbox: "ISO 4762 M6 x 20", "ISO 4032 M6", "Ball bearing 6201". */
export function fastenerName(kind: FastenerKind, size: string, length?: number) {
  const f = fastenerInfo(kind);
  return f.screw ? `${f.name} ${size} x ${lengthText(kind, length ?? defaultLength(kind, size))}` : `${f.name} ${size}`;
}

/**
 * The size of `kind` for a hole (or shaft) of diameter `dia`, or null when none fits: the largest nominal
 * size that passes through it for screws, nuts and washers (from 70 % of the hole up), the pin Ø within 5 %,
 * a bearing's outside Ø (else its bore) within 2 %. Among equal fits the `current` size, then its series
 * (the same first two characters, as 62xx bearings), wins.
 */
export function sizeForHole(kind: FastenerKind, dia: number, current?: string): string | null {
  const info = fastenerInfo(kind), rows = Object.entries(info.table);
  if (info.fit === "clear") {
    let best: [string, number] | null = null;
    for (const [n, r] of rows) if (r.d <= dia + 0.01 && r.d >= 0.7 * dia && (!best || r.d > best[1])) best = [n, r.d];
    return best?.[0] ?? null;
  }
  const rank = (n: string) => (n === current ? 0 : current && n.slice(0, 2) === current.slice(0, 2) ? 1 : 2);
  const near = (val: (r: Row) => number | undefined, tol: number) => {
    let best: [string, number] | null = null;
    for (const [n, r] of rows) {
      const v = val(r);
      if (v === undefined) continue;
      const e = Math.abs(v - dia);
      if (e <= tol * dia && (!best || e < best[1] - 1e-9 || (Math.abs(e - best[1]) <= 1e-9 && rank(n) < rank(best[0])))) best = [n, e];
    }
    return best?.[0] ?? null;
  };
  if (info.fit === "d") return near(r => r.d, 0.05);
  if (info.fit === "D") return near(r => r.D, 0.02) ?? near(r => r.d, 0.02);
  return null;
}

// ---------- geometry ----------

/** Thread length b of partly threaded screws (ISO 4762 / ISO 4014, L ≤ 125 mm; longer ones a little more); absent = threaded to the head. */
function threadRun(kind: FastenerKind, d: number, L: number): number | undefined {
  // ASME B18.3: 2 D + 1/2 in; ASME B18.2.1 up to 6 in: 2 D + 1/4 in, longer 2 D + 1/2 in.
  if (kind === "b183") return 2 * d + 12.7;
  if (kind === "b1821") return L <= 152.4 ? 2 * d + 6.35 : 2 * d + 12.7;
  if (kind === "iso4762") return 2 * d + 12;
  if (kind === "iso4014") return L <= 125 ? 2 * d + 6 : 2 * d + 12;
  return undefined;
}

/**
 * A size's row with the detail values for length `L`: screws get a tip chamfer about the thread depth and a
 * cosmetic thread (minor Ø, run b or up to the head); socket head cap screws a head chamfer; nuts a 90°
 * countersink each side and a thread between them; pins chamfered ends; bearings chamfered rings and a
 * shield recess each side.
 */
export function detailRow(std: FastenerKind, row: Row, L: number): Row {
  const kind = shapeKind(std), r: Row = { ...row }, info = fastenerInfo(kind), P = row.p ?? COARSE_PITCH[row.d] ?? 0.15 * row.d;
  if (info.group === "Screws") {
    const shank = kind === "iso10642" ? L - row.k! : L;
    r.ch = r2(Math.max(0.2, 0.7 * P));
    r.tl = r2(Math.min(threadRun(std, row.d, L) ?? shank, shank) - r.ch);
    r.td = r2(row.d - 1.2269 * P);
    if (kind === "iso4762") r.hc = r2(0.06 * row.dk!);
  } else if (info.group === "Nuts") {
    const h = kind === "iso7040" ? row.m! + row.c! : row.m!;
    r.ch = r2(0.1 * row.d);
    r.tl = r2(h - 2 * r.ch);
    r.td = row.d;
  } else if (kind === "standoff" || kind === "standoffm") {
    const P0 = P;
    r.ch = r2(Math.max(0.2, 0.1 * row.d));
    r.tl = r2(kind === "standoff" ? L - 2 * r.ch : row.bd! - r.ch);
    r.td = row.d;
    // The male stud: its tip chamfer and external thread (`hc` and `si` reused for them).
    if (kind === "standoffm") { r.hc = r2(Math.max(0.2, 0.7 * P0)); r.si = r2(row.ls! - r.hc); r.so = r2(row.d - 1.2269 * P0); }
  } else if (info.group === "Pins") {
    r.ch = r2(Math.min(0.1 * row.d, row.d1 ? 0.4 * (row.d - row.d1) / 2 : Infinity));
  } else if (info.group === "Bearings") {
    const w = (row.D! - row.d) / 2;
    r.ch = r2(Math.min(row.D! < 30 ? 0.3 : row.D! < 55 ? 0.6 : 1, 0.15 * w, kind === "bearingf" ? 0.4 * row.c! : Infinity));
    if (kind === "bearing") {
      r.si = r2(row.d + 0.7 * w);
      r.so = r2(row.D! - 0.5 * w);
      r.sd = r2(Math.max(0.2, 0.03 * row.B!));
    } else if (kind === "thrust") {
      // The gap between the shaft and housing washers, cut in from the bore and from the outside, leaving the cage.
      const m = (row.d + row.D!) / 2;
      r.si = r2(m - 0.3 * w);
      r.so = r2(m + 0.3 * w);
      r.sd = r2(0.3 * row.B!);
    }
  }
  return r;
}

const VAR_NAMES: Record<keyof Row | "L", string> = {
  ch: "Chamfer", hc: "HeadChamfer", tl: "ThreadL", td: "ThreadDia", si: "ShieldIn", so: "ShieldOut", sd: "ShieldDepth",
  ls: "StudL", bd: "ThreadDepth", g: "Gap", p: "Pitch",
  d: "Dia", dk: "HeadDia", k: "HeadH", s: "Key", t: "KeyDepth", m: "NutH", d1: "HoleDia", d2: "OuterDia", h: "WasherH", L: "Length",
  dc: "CollarDia", c: "CollarH", b: "KeyW", hk: "KeyH", D: "OutsideDia", B: "Width", lmin: "MinLength", lmax: "MaxLength",
};

/** A sketch on Top (XY) with the origin fixed. */
function sketch(id: string, name: string): SketchFeature {
  return { id, type: "sketch", name, plane: { std: "XY" }, ents: [{ id: "o", t: "point", x: 0, y: 0 }], rels: [{ id: "fo", t: "fix", e: ["o"] }], dims: [] };
}
/** A circle on the origin, its diameter driven by `v`. */
function circle(sk: SketchFeature, v: string, val: number) {
  sk.ents.push({ id: "c", t: "circle", c: "o", r: val / 2 });
  sk.dims.push({ id: "dc", name: `D1@${sk.name}`, t: "diameter", e: ["c"], val: { v: val, expr: v } });
}
/** A regular hexagon on the origin, `v` across flats (a construction circle through the corners is s / cos 30°). */
function hexagon(sk: SketchFeature, v: string, s: number) {
  const r = s / Math.sqrt(3);
  const ents: SkEnt[] = [{ id: "hc", t: "circle", c: "o", r, cons: true }], rels: SkRel[] = [], ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3, id = `p${i}`;
    ents.push({ id, t: "point", x: r * Math.cos(a), y: r * Math.sin(a) });
    rels.push({ id: `on${i}`, t: "onCurve", e: [id, "hc"] });
    ids.push(id);
  }
  ids.forEach((a, i) => ents.push({ id: `l${i}`, t: "line", a, b: ids[(i + 1) % 6] }));
  for (let i = 1; i < 6; i++) rels.push({ id: `eq${i}`, t: "equal", e: ["l0", `l${i}`] });
  // l5 joins the corners at 330° and 30°: vertical keeps two flats square to X.
  rels.push({ id: "vt", t: "vertical", e: ["l5"] });
  sk.ents.push(...ents);
  sk.rels.push(...rels);
  const dim: SkDim = { id: "dh", name: `D1@${sk.name}`, t: "diameter", e: ["hc"], val: { v: 2 * r, expr: `${v} / cos(30)` } };
  sk.dims.push(dim);
}
/** A rectangle centred on the origin: `x` along X driven by `vx`, `y` along Y by `vy`. */
function rectangle(sk: SketchFeature, vx: string, x: number, vy: string, y: number) {
  const c = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
  c.forEach(([px, py], i) => sk.ents.push({ id: `r${i}`, t: "point", x: px, y: py }));
  for (let i = 0; i < 4; i++) sk.ents.push({ id: `rl${i}`, t: "line", a: `r${i}`, b: `r${(i + 1) % 4}` });
  sk.ents.push({ id: "rd", t: "line", a: "r0", b: "r2", cons: true });
  sk.rels.push({ id: "h0", t: "horizontal", e: ["rl0"] }, { id: "v1", t: "vertical", e: ["rl1"] }, { id: "h2", t: "horizontal", e: ["rl2"] }, { id: "v3", t: "vertical", e: ["rl3"] },
    { id: "mid", t: "midpoint", e: ["o", "rd"] });
  sk.dims.push({ id: "dx", name: `D1@${sk.name}`, t: "hdistance", e: ["r0", "r1"], val: { v: x, expr: vx } },
    { id: "dy", name: `D2@${sk.name}`, t: "vdistance", e: ["r1", "r2"], val: { v: y, expr: vy } });
}
const num = (v: number, expr: string) => ({ v, expr });

/**
 * The opening of a split ring between Ø `d1` and Ø `d2`: a rectangle `g` wide across the ring on +X, running
 * 1 mm past both edges, centred on a point on the X axis halfway across the ring.
 */
function split(sk: SketchFeature, v1: string, d1: number, v2: string, d2: number, vg: string, g: number) {
  const w = (d2 - d1) / 2 + 2, mx = (d1 + d2) / 4;
  sk.ents.push({ id: "m", t: "point", x: mx, y: 0 }, { id: "om", t: "line", a: "o", b: "m", cons: true });
  sk.rels.push({ id: "hm", t: "horizontal", e: ["om"] });
  sk.dims.push({ id: "dm", name: `D3@${sk.name}`, t: "hdistance", e: ["o", "m"], val: num(mx, `(${v1} + ${v2}) / 4`) });
  const c = [[mx - w / 2, -g / 2], [mx + w / 2, -g / 2], [mx + w / 2, g / 2], [mx - w / 2, g / 2]];
  c.forEach(([px, py], i) => sk.ents.push({ id: `r${i}`, t: "point", x: px, y: py }));
  for (let i = 0; i < 4; i++) sk.ents.push({ id: `rl${i}`, t: "line", a: `r${i}`, b: `r${(i + 1) % 4}` });
  sk.ents.push({ id: "rd", t: "line", a: "r0", b: "r2", cons: true });
  sk.rels.push({ id: "h0", t: "horizontal", e: ["rl0"] }, { id: "v1", t: "vertical", e: ["rl1"] }, { id: "h2", t: "horizontal", e: ["rl2"] }, { id: "v3", t: "vertical", e: ["rl3"] },
    { id: "mid", t: "midpoint", e: ["m", "rd"] });
  sk.dims.push({ id: "dx", name: `D1@${sk.name}`, t: "hdistance", e: ["r0", "r1"], val: num(w, `(${v2} - ${v1}) / 2 + 2`) },
    { id: "dy", name: `D2@${sk.name}`, t: "vdistance", e: ["r1", "r2"], val: num(g, vg) });
}

type Key = keyof Row | "L";
/**
 * Chamfers and cosmetic threads (see `detailRow`) added after the body features; returns the variables they use.
 * Face names are the extrudes' (`<id>:side:c`, `<id>:start|end`); a one-edge chamfer's face is `<id>:chamfer:0`.
 */
function detailFeatures(std: FastenerKind, row: Row, feats: Feature[], v: (k: Key) => string, val: (k: Key) => number): Key[] {
  const kind = shapeKind(std), info = fastenerInfo(kind), P = row.p ?? COARSE_PITCH[row.d] ?? 0.15 * row.d;
  // The thread's size as the Hole Wizard writes it: "M6", "1/4-20 UNC".
  const own = fastenerInfo(std), tsize = own.inch ? `${Object.keys(own.table).find(k => Math.abs(own.table[k].d - row.d) < 1e-6)} UNC` : `M${row.d}`;
  const chamfer = (id: string, name: string, edges: [string, string][], k: Key): Feature =>
    ({ id, type: "chamfer", name, distance: num(val(k), v(k)), edges: edges.map(faces => ({ faces })) });
  const thread = (faces: [string, string], internal: boolean): Feature =>
    ({ id: "t1", type: "thread", name: "Cosmetic Thread1", edge: { faces }, size: tsize, diameter: num(val("td"), v("td")), length: num(val("tl"), v("tl")), pitch: P, ...(internal ? { internal: true } : {}) });
  if (info.group === "Screws") {
    const sh = kind === "iso10642" ? "e2" : "e1";
    feats.push(chamfer("c1", "Chamfer1", [[`${sh}:side:c`, `${sh}:end`]], "ch"));
    if (kind === "iso4762") feats.push(chamfer("c2", "Chamfer2", [["e2:side:c", "e2:end"]], "hc"));
    feats.push(thread([`${sh}:side:c`, "c1:chamfer:0"], false));
    return kind === "iso4762" ? ["ch", "hc", "tl", "td"] : ["ch", "tl", "td"];
  }
  if (info.group === "Nuts") {
    const bore = kind === "iso7040" || kind === "iso4161" ? "e3" : "e2", top = kind === "iso7040" || kind === "iso4161" ? "e2:end" : "e1:end";
    feats.push(chamfer("c1", "Chamfer1", [[`${bore}:side:c`, "e1:start"], [`${bore}:side:c`, top]], "ch"), thread([`${bore}:side:c`, "c1:chamfer:0"], true));
    return ["ch", "tl", "td"];
  }
  if (kind === "standoff") {
    feats.push(chamfer("c1", "Chamfer1", [["e2:side:c", "e1:start"], ["e2:side:c", "e1:end"]], "ch"), thread(["e2:side:c", "c1:chamfer:0"], true));
    return ["ch", "tl", "td"];
  }
  if (kind === "standoffm") {
    feats.push(chamfer("c1", "Chamfer1", [["e2:side:c", "e1:end"]], "ch"), chamfer("c2", "Chamfer2", [["e3:side:c", "e3:end"]], "hc"));
    // Internal thread from the bore's mouth down; external thread on the stud from its tip.
    feats.push({ ...thread(["e2:side:c", "c1:chamfer:0"], true) },
      { id: "t2", type: "thread", name: "Cosmetic Thread2", edge: { faces: ["e3:side:c", "c2:chamfer:0"] }, size: `M${row.d}`, diameter: num(row.so!, v("so")), length: num(row.si!, v("si")), pitch: P });
    return ["ch", "tl", "td", "hc", "si", "so"];
  }
  if (info.group === "Pins") { feats.push(chamfer("c1", "Chamfer1", [["e1:side:c", "e1:start"], ["e1:side:c", "e1:end"]], "ch")); return ["ch"]; }
  if (kind === "bearingf") {
    feats.push(chamfer("c1", "Chamfer1", [["e1:side:c", "e1:end"], ["e2:side:c", "e2:end"], ["e3:side:c", "e2:end"], ["e3:side:c", "e1:end"]], "ch"));
    return ["ch"];
  }
  if (info.group === "Bearings") {
    feats.push(chamfer("c1", "Chamfer1", [["e1:side:c", "e1:start"], ["e1:side:c", "e1:end"], ["e2:side:c", "e1:start"], ["e2:side:c", "e1:end"]], "ch"));
    return ["ch"];
  }
  return [];
}

/**
 * A fastener part of one standard with every size as a configuration; `size` is active, screws get
 * `length` (default: the preferred length nearest 3 d) in each configuration.
 */
export function fastenerPart(std: FastenerKind, size: string, length?: number, opts: { detail?: boolean } = {}): PartDoc {
  const info = fastenerInfo(std), detail = opts.detail !== false, kind = shapeKind(std);
  if (!info.table[size]) throw new Error(`No ${info.name} size ${size}`);
  const L = length ?? defaultLength(std, size);
  const row = detail ? detailRow(std, info.table[size], L) : info.table[size];
  const pd = newPart(fastenerName(std, size, L));
  const feats: Feature[] = [];
  const v = (k: keyof Row | "L") => VAR_NAMES[k];
  const val = (k: keyof Row | "L") => (k === "L" ? L : row[k] ?? 0);
  const ext = (id: string, name: string, sk: string, k: keyof Row | "L", extra: Partial<ExtrudeFeature> = {}): ExtrudeFeature =>
    ({ id, type: "extrude", name, sketch: sk, op: "boss", end: "blind", depth: num(val(k), v(k)), ...extra });
  const used: (keyof Row | "L")[] = [];
  const cut = (id: string, name: string, sk: string, depth: Num, startOffset?: Num): ExtrudeFeature =>
    ({ id, type: "extrude", name, sketch: sk, op: "cut", end: "blind", depth, ...(startOffset ? { start: "offset" as const, startOffset } : {}) });
  const sum = (a: keyof Row, b: keyof Row) => num(val(a) + val(b), `${v(a)} + ${v(b)}`);
  if (kind === "iso4762" || kind === "iso4017" || kind === "iso4014" || kind === "iso7380") {
    // Shank below z = 0, head above it.
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d"), row.d);
    feats.push(s1, ext("e1", "Shank", "s1", "L", { flip: true }));
    const s2 = sketch("s2", "Sketch2");
    if (kind === "iso4017" || kind === "iso4014") hexagon(s2, v("s"), row.s!); else circle(s2, v("dk"), row.dk!);
    feats.push(s2, ext("e2", "Head", "s2", "k", kind === "iso7380" ? { draft: { angle: { v: (25 * Math.PI) / 180 } } } : {}));
    used.push("d", "L", "k", kind === "iso4017" || kind === "iso4014" ? "s" : "dk");
    if (kind === "iso4762" || kind === "iso7380") {
      // Hex socket, cut down from the top of the head.
      const s3 = sketch("s3", "Sketch3"); hexagon(s3, v("s"), row.s!);
      feats.push(s3, cut("e3", "Socket", "s3", num(row.t!, v("t")), num(row.k!, v("k"))));
      used.push("s", "t");
    }
  } else if (kind === "iso10642") {
    // Head top on z = 0: a 90° cone down to the shank, the shank on below it, the socket cut into the head.
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("dk"), row.dk!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    const s3 = sketch("s3", "Sketch3"); hexagon(s3, v("s"), row.s!);
    feats.push(s1, ext("e1", "Head", "s1", "k", { flip: true, draft: { angle: { v: Math.PI / 4 } } }), s2, ext("e2", "Shank", "s2", "L", { flip: true }),
      s3, cut("e3", "Socket", "s3", num(row.t!, v("t"))));
    used.push("dk", "k", "d", "L", "s", "t");
  } else if (kind === "iso4026") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d"), row.d);
    const s2 = sketch("s2", "Sketch2"); hexagon(s2, v("s"), row.s!);
    feats.push(s1, ext("e1", "Body", "s1", "L", { flip: true }), s2, cut("e2", "Socket", "s2", num(row.t!, v("t"))));
    used.push("d", "L", "s", "t");
  } else if (kind === "iso4032" || kind === "iso4035") {
    const s1 = sketch("s1", "Sketch1"); hexagon(s1, v("s"), row.s!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    feats.push(s1, ext("e1", "Nut", "s1", "m"), s2, cut("e2", "Bore", "s2", num(row.m!, v("m")), num(row.m!, v("m"))));
    used.push("s", "m", "d");
  } else if (kind === "iso7040") {
    // Hex up to m, then the insert collar on top of it.
    const s1 = sketch("s1", "Sketch1"); hexagon(s1, v("s"), row.s!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("dc"), row.dc!);
    const s3 = sketch("s3", "Sketch3"); circle(s3, v("d"), row.d);
    feats.push(s1, ext("e1", "Nut", "s1", "m"), s2, ext("e2", "Collar", "s2", "c", { start: "offset", startOffset: num(row.m!, v("m")) }),
      s3, cut("e3", "Bore", "s3", sum("m", "c"), sum("m", "c")));
    used.push("s", "m", "dc", "c", "d");
  } else if (kind === "iso4161") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("dc"), row.dc!);
    const s2 = sketch("s2", "Sketch2"); hexagon(s2, v("s"), row.s!);
    const s3 = sketch("s3", "Sketch3"); circle(s3, v("d"), row.d);
    feats.push(s1, ext("e1", "Flange", "s1", "c"), s2, ext("e2", "Nut", "s2", "m"), s3, cut("e3", "Bore", "s3", num(row.m!, v("m")), num(row.m!, v("m"))));
    used.push("dc", "c", "s", "m", "d");
  } else if (kind === "iso2338" || kind === "iso8752") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d"), row.d);
    feats.push(s1, ext("e1", "Pin", "s1", "L", { flip: true }));
    used.push("d", "L");
    if (kind === "iso8752") {
      const s2 = sketch("s2", "Sketch2"); circle(s2, v("d1"), row.d1!);
      feats.push(s2, cut("e2", "Bore", "s2", num(L, v("L"))));
      used.push("d1");
    }
  } else if (kind === "din6885") {
    // Length along X, width along Y, height up from z = 0.
    const s1 = sketch("s1", "Sketch1"); rectangle(s1, v("L"), L, v("b"), row.b!);
    feats.push(s1, ext("e1", "Key", "s1", "hk"));
    used.push("L", "b", "hk");
  } else if (kind === "bearingf") {
    // Flange on top of z = 0 (its underside is the seat), the ring below it, the bore through both.
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("D"), row.D!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("dc"), row.dc!);
    const s3 = sketch("s3", "Sketch3"); circle(s3, v("d"), row.d);
    feats.push(s1, ext("e1", "Ring", "s1", "B", { flip: true, depth: num(row.B! - row.c!, `${v("B")} - ${v("c")}`) }), s2, ext("e2", "Flange", "s2", "c"),
      s3, cut("e3", "Bore", "s3", num(row.B!, v("B")), num(row.c!, v("c"))));
    used.push("D", "dc", "c", "B", "d");
  } else if (kind === "needle" || kind === "linear" || kind === "thrust") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("D"), row.D!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    feats.push(s1, ext("e1", "Ring", "s1", "B", { flip: true }), s2, cut("e2", "Bore", "s2", num(row.B!, v("B"))));
    used.push("D", "B", "d");
    if (detail && kind === "thrust") {
      // Two ring grooves halfway down, one in from the bore and one in from the outside: the gap between the washers.
      const s3 = sketch("s3", "Sketch3");
      s3.ents.push({ id: "c1", t: "circle", c: "o", r: row.d / 2 - 1 }, { id: "c2", t: "circle", c: "o", r: row.si! / 2 },
        { id: "c3", t: "circle", c: "o", r: row.so! / 2 }, { id: "c4", t: "circle", c: "o", r: row.D! / 2 + 1 });
      s3.dims.push({ id: "d1", name: "D1@Sketch3", t: "diameter", e: ["c1"], val: num(row.d - 2, `${v("d")} - 2`) },
        { id: "d2", name: "D2@Sketch3", t: "diameter", e: ["c2"], val: num(row.si!, v("si")) },
        { id: "d3", name: "D3@Sketch3", t: "diameter", e: ["c3"], val: num(row.so!, v("so")) },
        { id: "d4", name: "D4@Sketch3", t: "diameter", e: ["c4"], val: num(row.D! + 2, `${v("D")} + 2`) });
      feats.push(s3, cut("e3", "Gap", "s3", num(row.sd!, v("sd")), num(-(row.B! - row.sd!) / 2, `-(${v("B")} - ${v("sd")}) / 2`)));
      used.push("si", "so", "sd");
    }
  } else if (kind === "bearing") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("D"), row.D!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    feats.push(s1, ext("e1", "Ring", "s1", "B", { flip: true }), s2, cut("e2", "Bore", "s2", num(row.B!, v("B"))));
    used.push("D", "B", "d");
    if (detail) {
      // Shields: a shallow ring recess on both faces between the inner and the outer ring.
      const s3 = sketch("s3", "Sketch3");
      s3.ents.push({ id: "c", t: "circle", c: "o", r: row.so! / 2 }, { id: "ci", t: "circle", c: "o", r: row.si! / 2 });
      s3.dims.push({ id: "dc", name: "D1@Sketch3", t: "diameter", e: ["c"], val: num(row.so!, v("so")) }, { id: "di", name: "D2@Sketch3", t: "diameter", e: ["ci"], val: num(row.si!, v("si")) });
      feats.push(s3, cut("e3", "Shield", "s3", num(row.sd!, v("sd"))),
        { ...cut("e4", "Shield", "s3", num(row.sd!, v("sd")), num(-row.B!, `-${v("B")}`)), flip: true });
      used.push("so", "si", "sd");
    }
  } else if (kind === "standoff" || kind === "standoffm") {
    // Hex body up from z = 0; F-F: a bore right through; M-F: a blind bore from the top and a stud below z = 0.
    const s1 = sketch("s1", "Sketch1"); hexagon(s1, v("s"), row.s!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    feats.push(s1, ext("e1", "Body", "s1", "L"), s2, kind === "standoff" ? cut("e2", "Bore", "s2", num(L, v("L")), num(L, v("L"))) : cut("e2", "Bore", "s2", num(row.bd!, v("bd")), num(L, v("L"))));
    used.push("s", "L", "d");
    if (kind === "standoffm") {
      const s3 = sketch("s3", "Sketch3"); circle(s3, v("d"), row.d);
      feats.push(s3, ext("e3", "Stud", "s3", "ls", { flip: true }));
      used.push("bd", "ls");
    }
  } else if (kind === "spacer") {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d2"), row.d2!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d1"), row.d1!);
    feats.push(s1, ext("e1", "Spacer", "s1", "L"), s2, cut("e2", "Bore", "s2", num(L, v("L")), num(L, v("L"))));
    used.push("d2", "L", "d1");
  } else {
    // Washers; DIN 127 and retaining rings are split (the opening on +X). Rings sit flush: z from -s to 0.
    const ring = kind === "din471" || kind === "din472";
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d2"), row.d2!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d1"), row.d1!);
    feats.push(s1, ext("e1", ring ? "Ring" : "Washer", "s1", "h", ring ? { flip: true } : {}), s2,
      ring ? cut("e2", "Bore", "s2", num(row.h!, v("h"))) : cut("e2", "Bore", "s2", num(row.h!, v("h")), num(row.h!, v("h"))));
    used.push("d2", "h", "d1");
    if (row.g) {
      const s3 = sketch("s3", "Sketch3"); split(s3, v("d1"), row.d1!, v("d2"), row.d2!, v("g"), row.g);
      feats.push(s3, ring ? cut("e3", "Opening", "s3", num(row.h!, v("h"))) : cut("e3", "Split", "s3", num(row.h!, v("h")), num(row.h!, v("h"))));
      used.push("g");
    }
  }
  if (detail) used.push(...detailFeatures(std, row, feats, v, val));
  pd.features = feats;
  pd.material = { name: "Steel", density: 7.85 };
  const vars = (r0: Row, len: number): GlobalVar[] => {
    const r = detail ? detailRow(std, r0, len) : r0;
    return used.map(k => ({ name: VAR_NAMES[k], expr: `${+(k === "L" ? len : r[k] ?? 0).toFixed(4)}`, kind: "length" }));
  };
  // Every size as a configuration (its variables), then the asked one made active.
  pd.configs = [];
  for (const [name, r] of Object.entries(info.table)) {
    pd.vars = vars(r, name === size ? L : defaultLength(std, name));
    refreshExprs(pd);
    pd.configs.push({ name, state: captureState(pd) });
  }
  pd.config = Object.keys(info.table).at(-1);
  activate(pd, size);
  refreshExprs(pd);
  pd.props = { ...pd.props, partNumber: fastenerName(std, size, L), description: info.label };
  return pd;
}
