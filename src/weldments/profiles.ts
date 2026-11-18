// Weldment profile library (FR-FT-121): standard steel sections as 2D outlines.
//
// A profile is an outer loop and optional holes in its own (u, v) plane, in mm, with the bounding box
// centred on the origin. A loop is a polygon whose corners may be rounded (radius per corner), or a
// circle. The kernel turns loops into exact lines and arcs; `outline` samples them for areas and tests.
//
// Sizes follow the usual European tables: EN 10219 hollow sections (SHS, RHS, CHS), EN 10056-1 equal
// angles, DIN 1026-1 UPN channels (8 % flange taper, thickness at half the flange width), EN 10365 IPE
// HEA and HEB beams, EN 10056-1 unequal angles, flat, square and round bars. Corner radii of hollow sections are the EN 10219 values used for
// section properties (outer 2t up to 6 mm wall, 2.5t up to 10 mm, inner = outer - t).
import type { V2 } from "../model/types";

/** A rounded polygon, a circle, or (custom profiles from a sketch) lines and arcs as they are. */
export type Loop = { pts: V2[]; r: number[] } | { circle: number; c: V2 } | { segs: LoopSeg[] };
/** `origin`: where the sketch origin of a custom profile lies (the default pierce point). */
export interface ProfileShape { outer: Loop; holes: Loop[]; w: number; h: number; origin?: V2; /** A profile sketch's points by id, in profile coordinates. */ points?: Record<string, V2> }

export type ProfileType = "shs" | "rhs" | "chs" | "angle" | "uangle" | "upn" | "upe" | "ipe" | "ipn" | "hea" | "heb" | "hem" | "flat" | "sqbar" | "bar";

/** Profile types in menu order, with English labels (translated where shown). */
export const PROFILE_TYPES: [ProfileType, string][] = [
  ["shs", "Square tube (EN 10219)"],
  ["rhs", "Rectangular tube (EN 10219)"],
  ["chs", "Round tube (EN 10219)"],
  ["angle", "Equal angle (EN 10056)"],
  ["uangle", "Unequal angle (EN 10056)"],
  ["upn", "Channel UPN (DIN 1026)"],
  ["upe", "Channel UPE (EN 10365)"],
  ["ipe", "I-beam IPE (EN 10365)"],
  ["ipn", "I-beam IPN (DIN 1025)"],
  ["hea", "H-beam HEA (EN 10365)"],
  ["heb", "H-beam HEB (EN 10365)"],
  ["hem", "H-beam HEM (EN 10365)"],
  ["flat", "Flat bar"],
  ["sqbar", "Square bar"],
  ["bar", "Round bar"],
];

const SHS = ["20x20x2", "25x25x2", "30x30x2", "30x30x3", "40x40x2", "40x40x3", "40x40x4", "50x50x3", "50x50x4", "50x50x5", "60x60x3", "60x60x4", "60x60x5", "70x70x4", "80x80x4", "80x80x5", "80x80x6", "90x90x5", "100x100x4", "100x100x5", "100x100x6", "100x100x8", "120x120x5", "120x120x6", "140x140x6", "150x150x6", "150x150x8", "200x200x8", "200x200x10"];
const RHS = ["30x20x2", "40x20x2", "40x20x3", "50x25x2", "50x30x3", "60x30x3", "60x40x3", "60x40x4", "80x40x3", "80x40x4", "80x60x4", "100x50x4", "100x50x5", "100x60x4", "100x60x5", "120x60x4", "120x60x5", "120x80x5", "140x80x5", "150x100x5", "150x100x6", "160x80x6", "200x100x6", "200x100x8"];
const CHS = ["21.3x2", "26.9x2", "26.9x2.6", "33.7x2.6", "33.7x3.2", "42.4x2.6", "42.4x3.2", "48.3x3.2", "48.3x4", "60.3x3.2", "60.3x4", "76.1x3.2", "76.1x4", "88.9x4", "88.9x5", "114.3x4", "114.3x5", "139.7x5", "168.3x6.3", "219.1x6.3"];
/** a, t, r1 (root), r2 (toe). */
const ANGLE: Record<string, [number, number, number, number]> = {
  "20x20x3": [20, 3, 3.5, 2], "25x25x3": [25, 3, 3.5, 2], "25x25x4": [25, 4, 3.5, 2], "30x30x3": [30, 3, 5, 2.5], "30x30x4": [30, 4, 5, 2.5],
  "35x35x4": [35, 4, 5, 2.5], "40x40x4": [40, 4, 6, 3], "40x40x5": [40, 5, 6, 3], "45x45x5": [45, 5, 7, 3.5], "50x50x5": [50, 5, 7, 3.5],
  "50x50x6": [50, 6, 7, 3.5], "60x60x6": [60, 6, 8, 4], "65x65x7": [65, 7, 9, 4.5], "70x70x7": [70, 7, 9, 4.5], "75x75x8": [75, 8, 10, 5],
  "80x80x8": [80, 8, 10, 5], "90x90x9": [90, 9, 11, 5.5], "100x100x10": [100, 10, 12, 6], "120x120x12": [120, 12, 13, 6.5],
};
/** a (long leg), b (short leg), t, r1 (root), r2 (toe). */
const UANGLE: Record<string, [number, number, number, number, number]> = {
  "30x20x3": [30, 20, 3, 4, 2], "40x20x4": [40, 20, 4, 4, 2], "40x25x4": [40, 25, 4, 4, 2], "45x30x4": [45, 30, 4, 4.5, 2.25],
  "50x30x5": [50, 30, 5, 5, 2.5], "60x30x5": [60, 30, 5, 6, 3], "60x40x5": [60, 40, 5, 6, 3], "60x40x6": [60, 40, 6, 6, 3],
  "65x50x5": [65, 50, 5, 6, 3], "70x50x6": [70, 50, 6, 7, 3.5], "75x50x6": [75, 50, 6, 7, 3.5], "75x50x8": [75, 50, 8, 7, 3.5],
  "80x40x6": [80, 40, 6, 7, 3.5], "80x40x8": [80, 40, 8, 7, 3.5], "80x60x7": [80, 60, 7, 8, 4], "100x50x6": [100, 50, 6, 8, 4],
  "100x50x8": [100, 50, 8, 8, 4], "100x65x7": [100, 65, 7, 10, 5], "100x75x8": [100, 75, 8, 10, 5], "120x80x8": [120, 80, 8, 11, 5.5],
  "120x80x10": [120, 80, 10, 11, 5.5], "150x90x10": [150, 90, 10, 12, 6], "150x100x10": [150, 100, 10, 12, 6],
};
/** h, b, tw, tf, r1, r2. */
const UPN: Record<string, [number, number, number, number, number, number]> = {
  "50": [50, 38, 5, 7, 7, 3.5], "65": [65, 42, 5.5, 7.5, 7.5, 4], "80": [80, 45, 6, 8, 8, 4], "100": [100, 50, 6, 8.5, 8.5, 4.5],
  "120": [120, 55, 7, 9, 9, 4.5], "140": [140, 60, 7, 10, 10, 5], "160": [160, 65, 7.5, 10.5, 10.5, 5.5], "180": [180, 70, 8, 11, 11, 5.5],
  "200": [200, 75, 8.5, 11.5, 11.5, 6], "220": [220, 80, 9, 12.5, 12.5, 6.5], "240": [240, 85, 9.5, 13, 13, 6.5], "260": [260, 90, 10, 14, 14, 7],
  "300": [300, 100, 10, 16, 16, 8],
};
/** h, b, tw, tf, r. */
const IPE: Record<string, [number, number, number, number, number]> = {
  "80": [80, 46, 3.8, 5.2, 5], "100": [100, 55, 4.1, 5.7, 7], "120": [120, 64, 4.4, 6.3, 7], "140": [140, 73, 4.7, 6.9, 7],
  "160": [160, 82, 5, 7.4, 9], "180": [180, 91, 5.3, 8, 9], "200": [200, 100, 5.6, 8.5, 12], "220": [220, 110, 5.9, 9.2, 12],
  "240": [240, 120, 6.2, 9.8, 15], "270": [270, 135, 6.6, 10.2, 15], "300": [300, 150, 7.1, 10.7, 15], "330": [330, 160, 7.5, 11.5, 18],
  "360": [360, 170, 8, 12.7, 18], "400": [400, 180, 8.6, 13.5, 21],
};
const HEA: Record<string, [number, number, number, number, number]> = {
  "100": [96, 100, 5, 8, 12], "120": [114, 120, 5, 8, 12], "140": [133, 140, 5.5, 8.5, 12], "160": [152, 160, 6, 9, 15],
  "180": [171, 180, 6, 9.5, 15], "200": [190, 200, 6.5, 10, 18], "220": [210, 220, 7, 11, 18], "240": [230, 240, 7.5, 12, 21],
  "260": [250, 260, 7.5, 12.5, 24], "280": [270, 280, 8, 13, 24], "300": [290, 300, 8.5, 14, 27],
};
const HEB: Record<string, [number, number, number, number, number]> = {
  "100": [100, 100, 6, 10, 12], "120": [120, 120, 6.5, 11, 12], "140": [140, 140, 7, 12, 12], "160": [160, 160, 8, 13, 15],
  "180": [180, 180, 8.5, 14, 15], "200": [200, 200, 9, 15, 18], "220": [220, 220, 9.5, 16, 18], "240": [240, 240, 10, 17, 21],
  "260": [260, 260, 10, 17.5, 24], "280": [280, 280, 10.5, 18, 24], "300": [300, 300, 11, 19, 27],
};
const HEM: Record<string, [number, number, number, number, number]> = {
  "100": [120, 106, 12, 20, 12], "120": [140, 126, 12.5, 21, 12], "140": [160, 146, 13, 22, 12], "160": [180, 166, 14, 23, 15],
  "180": [200, 186, 14.5, 24, 15], "200": [220, 206, 15, 25, 18], "220": [240, 226, 15.5, 26, 18], "240": [270, 248, 18, 32, 21],
  "260": [290, 268, 18, 32.5, 24], "280": [310, 288, 18.5, 33, 24], "300": [340, 310, 21, 39, 27],
};
/** Parallel flange channels: h, b, tw, tf, r. */
const UPE: Record<string, [number, number, number, number, number]> = {
  "80": [80, 50, 4, 7, 10], "100": [100, 55, 4.5, 7.5, 10], "120": [120, 60, 5, 8, 12], "140": [140, 65, 5, 9, 12],
  "160": [160, 70, 5.5, 9.5, 12], "180": [180, 75, 5.5, 10.5, 12], "200": [200, 80, 6, 11, 13], "220": [220, 85, 6.5, 12, 13],
  "240": [240, 90, 7, 12.5, 15], "270": [270, 95, 7.5, 13.5, 15], "300": [300, 100, 9.5, 15, 15],
};
/** Tapered flange I-beams (14 % slope): h, b, tw, tf (at a quarter of the flange width from its edge), r1, r2. */
const IPN: Record<string, [number, number, number, number, number, number]> = {
  "80": [80, 42, 3.9, 5.9, 3.9, 2.3], "100": [100, 50, 4.5, 6.8, 4.5, 2.7], "120": [120, 58, 5.1, 7.7, 5.1, 3.1], "140": [140, 66, 5.7, 8.6, 5.7, 3.4],
  "160": [160, 74, 6.3, 9.5, 6.3, 3.8], "180": [180, 82, 6.9, 10.4, 6.9, 4.1], "200": [200, 90, 7.5, 11.3, 7.5, 4.5], "220": [220, 98, 8.1, 12.2, 8.1, 4.9],
  "240": [240, 106, 8.7, 13.1, 8.7, 5.2], "260": [260, 113, 9.4, 14.1, 9.4, 5.6], "280": [280, 119, 10.1, 15.2, 10.1, 6.1], "300": [300, 125, 10.8, 16.2, 10.8, 6.5],
};
const FLAT = ["20x3", "20x5", "25x5", "30x3", "30x5", "40x4", "40x5", "40x8", "50x5", "50x6", "50x8", "50x10", "60x6", "60x8", "60x10", "80x8", "80x10", "100x8", "100x10", "120x10", "150x10"];
const SQBAR = ["8", "10", "12", "14", "16", "20", "25", "30", "35", "40", "50", "60"];
const BAR = ["8", "10", "12", "14", "16", "18", "20", "22", "25", "30", "35", "40", "45", "50", "60"];

/** The sizes of a profile type, as stored in a member feature. */
export function profileSizes(type: ProfileType): string[] {
  switch (type) {
    case "shs": return SHS;
    case "rhs": return RHS;
    case "chs": return CHS;
    case "angle": return Object.keys(ANGLE);
    case "uangle": return Object.keys(UANGLE);
    case "upn": return Object.keys(UPN);
    case "upe": return Object.keys(UPE);
    case "ipe": return Object.keys(IPE);
    case "ipn": return Object.keys(IPN);
    case "hea": return Object.keys(HEA);
    case "heb": return Object.keys(HEB);
    case "hem": return Object.keys(HEM);
    case "flat": return FLAT;
    case "sqbar": return SQBAR;
    case "bar": return BAR;
  }
}

/** A short designation for cut lists: "SHS 40x40x3", "IPE 200", "L 50x50x5". */
export function profileName(type: ProfileType, size: string): string {
  const pre: Record<ProfileType, string> = { shs: "SHS", rhs: "RHS", chs: "CHS", angle: "L", uangle: "L", upn: "UPN", upe: "UPE", ipe: "IPE", ipn: "IPN", hea: "HEA", heb: "HEB", hem: "HEM", flat: "FL", sqbar: "SQ", bar: "RD" };
  return `${pre[type]} ${size}`;
}

const nums = (s: string) => s.split("x").map(Number);

/** Hollow section radii (EN 10219-2 values for section properties). */
const hollowR = (t: number) => { const ro = t <= 6 ? 2 * t : t <= 10 ? 2.5 * t : 3 * t; return { ro, ri: ro - t }; };

const rect = (w: number, h: number, r: number): Loop => ({ pts: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], r: [r, r, r, r] });

/** Moves a loop so the box (x0..x1, y0..y1) is centred on the origin. */
function centre(shape: { outer: Loop; holes: Loop[] }, x0: number, x1: number, y0: number, y1: number): ProfileShape {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const mv = (l: Loop): Loop => ("circle" in l ? { circle: l.circle, c: [l.c[0] - cx, l.c[1] - cy] } : "pts" in l ? { pts: l.pts.map(p => [p[0] - cx, p[1] - cy] as V2), r: l.r } : l);
  return { outer: mv(shape.outer), holes: shape.holes.map(mv), w: x1 - x0, h: y1 - y0 };
}

/** The outline of a standard section, or null for an unknown size. */
export function profileShape(type: ProfileType, size: string): ProfileShape | null {
  if (!profileSizes(type).includes(size)) return null;
  if (type === "shs" || type === "rhs") {
    const [b, h, t] = nums(size);
    const { ro, ri } = hollowR(t);
    return { outer: rect(b, h, ro), holes: [rect(b - 2 * t, h - 2 * t, ri)], w: b, h };
  }
  if (type === "chs") {
    const [d, t] = nums(size);
    return { outer: { circle: d / 2, c: [0, 0] }, holes: [{ circle: d / 2 - t, c: [0, 0] }], w: d, h: d };
  }
  if (type === "flat") { const [b, t] = nums(size); return { outer: rect(b, t, 0), holes: [], w: b, h: t }; }
  if (type === "sqbar") { const a = Number(size); return { outer: rect(a, a, 0), holes: [], w: a, h: a }; }
  if (type === "bar") { const d = Number(size); return { outer: { circle: d / 2, c: [0, 0] }, holes: [], w: d, h: d }; }
  if (type === "angle") {
    const [a, t, r1, r2] = ANGLE[size];
    // Heel at the origin, legs along +u and +v (counter-clockwise).
    return centre({ outer: { pts: [[0, 0], [a, 0], [a, t], [t, t], [t, a], [0, a]], r: [0, 0, r2, r1, r2, 0] }, holes: [] }, 0, a, 0, a);
  }
  if (type === "uangle") {
    const [a, b, t, r1, r2] = UANGLE[size];
    // Heel at the origin, the long leg along +v (standing up) and the short one along +u.
    return centre({ outer: { pts: [[0, 0], [b, 0], [b, t], [t, t], [t, a], [0, a]], r: [0, 0, r2, r1, r2, 0] }, holes: [] }, 0, b, 0, a);
  }
  if (type === "upn") {
    const [h, b, tw, tf, r1, r2] = UPN[size];
    // Back of the web on u = 0, flanges towards +u; the flange's inner face slopes 8 % (thicker at the web).
    const y = (x: number) => h / 2 - tf + 0.08 * (x - b / 2);
    return centre({
      outer: { pts: [[0, -h / 2], [b, -h / 2], [b, -y(b)], [tw, -y(tw)], [tw, y(tw)], [b, y(b)], [b, h / 2], [0, h / 2]], r: [0, 0, r2, r1, r1, r2, 0, 0] },
      holes: [],
    }, 0, b, -h / 2, h / 2);
  }
  if (type === "upe") {
    const [h, b, tw, tf, r] = UPE[size];
    // Back of the web on u = 0, parallel flanges towards +u.
    const y = h / 2 - tf;
    return centre({
      outer: { pts: [[0, -h / 2], [b, -h / 2], [b, -y], [tw, -y], [tw, y], [b, y], [b, h / 2], [0, h / 2]], r: [0, 0, 0, r, r, 0, 0, 0] },
      holes: [],
    }, 0, b, -h / 2, h / 2);
  }
  if (type === "ipn") {
    const [h, b, tw, tf, r1, r2] = IPN[size];
    // The flanges' inner faces slope 14 % (thicker at the web); tf is measured a quarter of the flange width from the edge.
    const y = (x: number) => h / 2 - tf + 0.14 * (x - b / 4);
    const x = tw / 2, yw = y(x), yb = y(b / 2);
    return {
      outer: {
        pts: [[-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -yb], [x, -yw], [x, yw], [b / 2, yb], [b / 2, h / 2], [-b / 2, h / 2], [-b / 2, yb], [-x, yw], [-x, -yw], [-b / 2, -yb]],
        r: [0, 0, r2, r1, r1, r2, 0, 0, r2, r1, r1, r2],
      },
      holes: [], w: b, h,
    };
  }
  const [h, b, tw, tf, r] = type === "ipe" ? IPE[size] : type === "heb" ? HEB[size] : type === "hem" ? HEM[size] : HEA[size];
  const x = tw / 2, y = h / 2 - tf;
  return {
    outer: {
      pts: [[-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -y], [x, -y], [x, y], [b / 2, y], [b / 2, h / 2], [-b / 2, h / 2], [-b / 2, y], [-x, y], [-x, -y], [-b / 2, -y]],
      r: [0, 0, 0, r, r, 0, 0, 0, 0, r, r, 0],
    },
    holes: [], w: b, h,
  };
}

/** A piece of a loop: a straight line, or an arc through a middle point. */
export type LoopSeg = { kind: "line"; a: V2; b: V2 } | { kind: "arc"; a: V2; m: V2; b: V2; c: V2; r: number };

/** A rounded polygon as lines and arcs (a circle gives one closed arc split in two). */
export function loopSegs(l: Loop): LoopSeg[] {
  if ("segs" in l) return l.segs;
  if ("circle" in l) {
    const [cx, cy] = l.c, r = l.circle;
    return [
      { kind: "arc", a: [cx + r, cy], m: [cx, cy + r], b: [cx - r, cy], c: l.c, r },
      { kind: "arc", a: [cx - r, cy], m: [cx, cy - r], b: [cx + r, cy], c: l.c, r },
    ];
  }
  const n = l.pts.length;
  // Each corner: where the arc starts and ends (the corner itself when not rounded).
  const corners = l.pts.map((p, i) => {
    const r = l.r[i] ?? 0;
    if (!(r > 0)) return { a: p, b: p, arc: null as null | { m: V2; c: V2; r: number } };
    const pp = l.pts[(i + n - 1) % n], pn = l.pts[(i + 1) % n];
    const u = unit2([pp[0] - p[0], pp[1] - p[1]]), v = unit2([pn[0] - p[0], pn[1] - p[1]]);
    const th = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    const t = r / Math.tan(th / 2);
    const bis = unit2([u[0] + v[0], u[1] + v[1]]);
    const dc = r / Math.sin(th / 2);
    const c: V2 = [p[0] + bis[0] * dc, p[1] + bis[1] * dc];
    const m: V2 = [c[0] - bis[0] * r, c[1] - bis[1] * r];
    return { a: [p[0] + u[0] * t, p[1] + u[1] * t] as V2, b: [p[0] + v[0] * t, p[1] + v[1] * t] as V2, arc: { m, c, r } };
  });
  const out: LoopSeg[] = [];
  for (let i = 0; i < n; i++) {
    const k = corners[i], nx = corners[(i + 1) % n];
    if (k.arc) out.push({ kind: "arc", a: k.a, m: k.arc.m, b: k.b, c: k.arc.c, r: k.arc.r });
    if (Math.hypot(nx.a[0] - k.b[0], nx.a[1] - k.b[1]) > 1e-9) out.push({ kind: "line", a: k.b, b: nx.a });
  }
  return out;
}

const unit2 = (a: V2): V2 => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

/** Points along a loop (arcs sampled every few degrees), for areas and drawing. */
export function outline(l: Loop, perArc = 24): V2[] {
  const out: V2[] = [];
  for (const s of loopSegs(l)) {
    out.push(s.a);
    if (s.kind === "arc") {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      const am = Math.atan2(s.m[1] - s.c[1], s.m[0] - s.c[0]);
      const a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
      // The sweep from a to b that passes the middle point.
      let d1 = a1 - a0, dm = am - a0;
      const norm = (x: number) => { while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
      dm = norm(dm);
      d1 = norm(d1);
      if (Math.abs(d1) < 1e-12) d1 = dm > 0 ? 2 * Math.PI : -2 * Math.PI;
      else if (Math.sign(dm) !== Math.sign(d1) || Math.abs(dm) > Math.abs(d1)) d1 = d1 > 0 ? d1 - 2 * Math.PI : d1 + 2 * Math.PI;
      for (let k = 1; k < perArc; k++) { const a = a0 + (d1 * k) / perArc; out.push([s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]); }
    }
  }
  return out;
}

const shoelace = (p: V2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a) / 2; };

/** Cross-section area in mm² (arcs sampled finely: within 0.01 % of the exact value). */
export function profileArea(s: ProfileShape): number {
  const a = (l: Loop) => ("circle" in l ? Math.PI * l.circle * l.circle : shoelace(outline(l, 256)));
  return a(s.outer) - s.holes.reduce((t, h) => t + a(h), 0);
}

/** Where a profile sits on its path (a CAD app's pierce point): a corner, an edge middle or the centre of its box. */
export type Anchor = "c" | "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";
export const ANCHORS: Anchor[] = ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"];
/** The profile point that goes on the path, in profile coordinates. */
export function anchorPoint(s: ProfileShape, a: Anchor): V2 {
  const x = a.includes("l") ? -s.w / 2 : a.includes("r") ? s.w / 2 : 0;
  const y = a.startsWith("t") ? s.h / 2 : a.startsWith("b") ? -s.h / 2 : 0;
  return [x, y];
}
