// Fastener library (FR-ASM-028): ISO socket head, hex head and button head screws, hex nuts and plain
// washers from M2 to M20, generated as parametric parts. Global variables drive the sketch dimensions
// and feature depths, and each size is a configuration (its variables), so a fastener part can be
// switched to another size like any configured part. Every fastener has its axis on Z and the face that
// seats on the hole (under the head, the nut's or washer's bottom) on z = 0, facing -Z: placing it on a
// hole is a concentric mate on the axis plus a coincident one on that face.
import { newPart } from "../model/doc";
import { activate, captureState } from "../model/configs";
import { refreshExprs } from "../model/params";
import type { ExtrudeFeature, Feature, GlobalVar, PartDoc, SketchFeature, SkDim, SkEnt, SkRel } from "../model/types";

export type FastenerKind = "iso4762" | "iso4017" | "iso4014" | "iso7380" | "iso4032" | "iso7089";

/** Per size: d nominal, dk head Ø, k head height, s key (hex socket or across flats), t socket depth, m nut height, d1/d2/h washer. */
interface Row { d: number; dk?: number; k?: number; s?: number; t?: number; m?: number; d1?: number; d2?: number; h?: number }

const T4762: Record<string, Row> = {
  M2: { d: 2, dk: 3.8, k: 2, s: 1.5, t: 1 }, "M2.5": { d: 2.5, dk: 4.5, k: 2.5, s: 2, t: 1.1 }, M3: { d: 3, dk: 5.5, k: 3, s: 2.5, t: 1.3 },
  M4: { d: 4, dk: 7, k: 4, s: 3, t: 2 }, M5: { d: 5, dk: 8.5, k: 5, s: 4, t: 2.5 }, M6: { d: 6, dk: 10, k: 6, s: 5, t: 3 },
  M8: { d: 8, dk: 13, k: 8, s: 6, t: 4 }, M10: { d: 10, dk: 16, k: 10, s: 8, t: 5 }, M12: { d: 12, dk: 18, k: 12, s: 10, t: 6 },
  M16: { d: 16, dk: 24, k: 16, s: 14, t: 8 }, M20: { d: 20, dk: 30, k: 20, s: 17, t: 10 },
};
const T4017: Record<string, Row> = {
  M2: { d: 2, s: 4, k: 1.4 }, "M2.5": { d: 2.5, s: 5, k: 1.7 }, M3: { d: 3, s: 5.5, k: 2 }, M4: { d: 4, s: 7, k: 2.8 },
  M5: { d: 5, s: 8, k: 3.5 }, M6: { d: 6, s: 10, k: 4 }, M8: { d: 8, s: 13, k: 5.3 }, M10: { d: 10, s: 16, k: 6.4 },
  M12: { d: 12, s: 18, k: 7.5 }, M16: { d: 16, s: 24, k: 10 }, M20: { d: 20, s: 30, k: 12.5 },
};
const T7380: Record<string, Row> = {
  M3: { d: 3, dk: 5.7, k: 1.65, s: 2, t: 1.04 }, M4: { d: 4, dk: 7.6, k: 2.2, s: 2.5, t: 1.3 }, M5: { d: 5, dk: 9.5, k: 2.75, s: 3, t: 1.56 },
  M6: { d: 6, dk: 10.5, k: 3.3, s: 4, t: 2.08 }, M8: { d: 8, dk: 14, k: 4.4, s: 5, t: 2.6 }, M10: { d: 10, dk: 17.5, k: 5.5, s: 6, t: 3.12 },
  M12: { d: 12, dk: 21, k: 6.6, s: 8, t: 4.16 }, M16: { d: 16, dk: 28, k: 8.8, s: 10, t: 5.2 },
};
const T4032: Record<string, Row> = {
  M2: { d: 2, s: 4, m: 1.6 }, "M2.5": { d: 2.5, s: 5, m: 2 }, M3: { d: 3, s: 5.5, m: 2.4 }, M4: { d: 4, s: 7, m: 3.2 },
  M5: { d: 5, s: 8, m: 4.7 }, M6: { d: 6, s: 10, m: 5.2 }, M8: { d: 8, s: 13, m: 6.8 }, M10: { d: 10, s: 16, m: 8.4 },
  M12: { d: 12, s: 18, m: 10.8 }, M16: { d: 16, s: 24, m: 14.8 }, M20: { d: 20, s: 30, m: 18 },
};
const T7089: Record<string, Row> = {
  M2: { d: 2, d1: 2.2, d2: 5, h: 0.3 }, "M2.5": { d: 2.5, d1: 2.7, d2: 6, h: 0.5 }, M3: { d: 3, d1: 3.2, d2: 7, h: 0.5 },
  M4: { d: 4, d1: 4.3, d2: 9, h: 0.8 }, M5: { d: 5, d1: 5.3, d2: 10, h: 1 }, M6: { d: 6, d1: 6.4, d2: 12, h: 1.6 },
  M8: { d: 8, d1: 8.4, d2: 16, h: 1.6 }, M10: { d: 10, d1: 10.5, d2: 20, h: 2 }, M12: { d: 12, d1: 13, d2: 24, h: 2.5 },
  M16: { d: 16, d1: 17, d2: 30, h: 3 }, M20: { d: 20, d1: 21, d2: 37, h: 3 },
};

/** The standards, in the order the panel lists them; `screw` ones take a length. */
export const FASTENERS: { kind: FastenerKind; label: string; name: string; screw: boolean; table: Record<string, Row> }[] = [
  { kind: "iso4762", label: "Socket head cap screw (ISO 4762)", name: "ISO 4762", screw: true, table: T4762 },
  { kind: "iso4017", label: "Hex head screw (ISO 4017)", name: "ISO 4017", screw: true, table: T4017 },
  { kind: "iso4014", label: "Hex head bolt (ISO 4014)", name: "ISO 4014", screw: true, table: T4017 },
  { kind: "iso7380", label: "Button head screw (ISO 7380)", name: "ISO 7380", screw: true, table: T7380 },
  { kind: "iso4032", label: "Hex nut (ISO 4032)", name: "ISO 4032", screw: false, table: T4032 },
  { kind: "iso7089", label: "Plain washer (ISO 7089)", name: "ISO 7089", screw: false, table: T7089 },
];

const LENGTHS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];

export const fastenerInfo = (kind: FastenerKind) => FASTENERS.find(f => f.kind === kind)!;
export const fastenerSizes = (kind: FastenerKind) => Object.keys(fastenerInfo(kind).table);

/** Preferred lengths for a size: from about 1.5 d to 10 d (ISO 4014 bolts start at 5 d, as their shank is partly plain). */
export function fastenerLengths(kind: FastenerKind, size: string): number[] {
  const d = fastenerInfo(kind).table[size]?.d ?? 6;
  const lo = kind === "iso4014" ? 5 * d : Math.max(3, 1.5 * d), hi = kind === "iso7380" ? 6 * d : 10 * d;
  return LENGTHS.filter(l => l >= lo - 1e-9 && l <= hi + 1e-9);
}
export function defaultLength(kind: FastenerKind, size: string): number {
  const ls = fastenerLengths(kind, size), d = fastenerInfo(kind).table[size]?.d ?? 6;
  return ls.reduce((b, l) => (Math.abs(l - 3 * d) < Math.abs(b - 3 * d) ? l : b), ls[0] ?? 3 * d);
}

/** The part name, as in SolidWorks Toolbox: "ISO 4762 M6 x 20", "ISO 4032 M6". */
export function fastenerName(kind: FastenerKind, size: string, length?: number) {
  const f = fastenerInfo(kind);
  return f.screw ? `${f.name} ${size} x ${length ?? defaultLength(kind, size)}` : `${f.name} ${size}`;
}

// ---------- geometry ----------

const VAR_NAMES: Record<keyof Row | "L", string> = { d: "Dia", dk: "HeadDia", k: "HeadH", s: "Key", t: "KeyDepth", m: "NutH", d1: "HoleDia", d2: "OuterDia", h: "WasherH", L: "Length" };

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
const num = (v: number, expr: string) => ({ v, expr });

/**
 * A fastener part of one standard with every size as a configuration; `size` is active, screws get
 * `length` (default: the preferred length nearest 3 d) in each configuration.
 */
export function fastenerPart(kind: FastenerKind, size: string, length?: number): PartDoc {
  const info = fastenerInfo(kind);
  const row = info.table[size];
  if (!row) throw new Error(`No ${info.name} size ${size}`);
  const L = length ?? defaultLength(kind, size);
  const pd = newPart(fastenerName(kind, size, L));
  const feats: Feature[] = [];
  const v = (k: keyof Row | "L") => VAR_NAMES[k];
  const val = (k: keyof Row | "L") => (k === "L" ? L : row[k] ?? 0);
  const ext = (id: string, name: string, sk: string, k: keyof Row | "L", extra: Partial<ExtrudeFeature> = {}): ExtrudeFeature =>
    ({ id, type: "extrude", name, sketch: sk, op: "boss", end: "blind", depth: num(val(k), v(k)), ...extra });
  const used: (keyof Row | "L")[] = [];
  if (info.screw) {
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
      feats.push(s3, { id: "e3", type: "extrude", name: "Socket", sketch: "s3", op: "cut", end: "blind", depth: num(row.t!, v("t")), start: "offset", startOffset: num(row.k!, v("k")) });
      used.push("s", "t");
    }
  } else if (kind === "iso4032") {
    const s1 = sketch("s1", "Sketch1"); hexagon(s1, v("s"), row.s!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d"), row.d);
    feats.push(s1, ext("e1", "Nut", "s1", "m"), s2,
      { id: "e2", type: "extrude", name: "Bore", sketch: "s2", op: "cut", end: "blind", depth: num(row.m!, v("m")), start: "offset", startOffset: num(row.m!, v("m")) });
    used.push("s", "m", "d");
  } else {
    const s1 = sketch("s1", "Sketch1"); circle(s1, v("d2"), row.d2!);
    const s2 = sketch("s2", "Sketch2"); circle(s2, v("d1"), row.d1!);
    feats.push(s1, ext("e1", "Washer", "s1", "h"), s2,
      { id: "e2", type: "extrude", name: "Bore", sketch: "s2", op: "cut", end: "blind", depth: num(row.h!, v("h")), start: "offset", startOffset: num(row.h!, v("h")) });
    used.push("d2", "h", "d1");
  }
  pd.features = feats;
  pd.material = { name: "Steel", density: 7.85 };
  const vars = (r: Row, len: number): GlobalVar[] => used.map(k => ({ name: VAR_NAMES[k], expr: `${+(k === "L" ? len : r[k] ?? 0).toFixed(4)}`, kind: "length" }));
  // Every size as a configuration (its variables), then the asked one made active.
  pd.configs = [];
  for (const [name, r] of Object.entries(info.table)) {
    pd.vars = vars(r, name === size ? L : defaultLength(kind, name));
    refreshExprs(pd);
    pd.configs.push({ name, state: captureState(pd) });
  }
  pd.config = Object.keys(info.table).at(-1);
  activate(pd, size);
  refreshExprs(pd);
  pd.props = { ...pd.props, partNumber: fastenerName(kind, size, L), description: info.label };
  return pd;
}
