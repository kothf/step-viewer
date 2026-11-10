// Annotations on a drawing (FRS 11.3): dimensions, hole callouts, notes, and the automatic centre
// marks and centrelines. Dimensions hold on to model edges by name (GeoRef), so after the part
// changes they find their edges again and measure them anew (AT-P5-3). Drawn as sheet primitives
// in mm, ISO 129 style: thin extension lines with a 1 mm gap and 2 mm overshoot, filled arrows,
// 3.5 mm text above the dimension line, reading from the bottom or the right.
import { viewAxes, type MCyl, type MEdge, type MHole, type Seg2, type Topo, type V3, type ViewDir } from "../kernel/drawing";
import type { FlatBend } from "../sheetmetal/sheet";
import { arrowHead, clipToCircle, decorPrims, toSheet, type Placement } from "./compose";
import type { CutInfo, HoleInfo, ModelItem, SketchInfo, ThreadInfo, WeldInfo } from "./items";
import { PEN_W, rotateBox, rotatePrims, type Prim } from "./prims";
import { balloonPrims, bomCells, compOfKey, type Bom } from "./bom";
import { datumPrims, gtolPrims, surfPrims, tablePrims } from "./gdt";
import type { BendTableAnnot, CLineAnnot, CloudAnnot, DimAnnot, DraftStyle, DrawingView, GeoRef, HoleAnnot, HoleTableAnnot, NoteAnnot, Sheet, SurfAnnot, Tol, WeldTableAnnot, CutTableAnnot } from "./types";
import { topoOnly, viewDir, viewOnly, viewReq } from "./views";
import { fitLimits } from "./iso286";
import { weldPrims } from "./weld";
import { dtargetPrims } from "./dtarget";
import { skPrims } from "./sheetSketch";
import { textWidth } from "./textWidth";

type P2 = [number, number];
export type Label = (s: string, p?: Record<string, string>) => string;

/** What annotations need from the model and the UI. */
export interface AnnotCtx {
  topo: Topo | null; holes: HoleInfo[]; threads?: ThreadInfo[]; sketches?: SketchInfo[]; bends?: FlatBend[]; welds?: WeldInfo[]; cuts?: CutInfo[]; cutFaces?: Record<string, number>; weldFaces?: Record<string, number>; items: ModelItem[]; box: [V3, V3] | null; dec: string; label: Label; bom?: Bom | null;
  /** A view that shows another part configuration (FR-DRW-010) gets that configuration's topology and model items. */
  forView?: (v: DrawingView) => Partial<AnnotCtx> | null;
}

/** Annotation text height and arrowhead in force (FR-DRW-025): set from the drawing's style by `useStyle` before composing. */
export let TEXT_H = 3.5;
let ARROW = 3, ARROW_KIND: NonNullable<DraftStyle["arrow"]> = "filled";
/** The drawing's default decimals for linear and angular dimensions (FR-DRW-025), set by `useStyle`. */
let PREC_LIN: number | undefined, PREC_ANG: number | undefined;
/** The drawing's default ± tolerance (mm, degrees) for dimensions without their own, set by `useStyle`. */
let TOL_LIN: number | undefined, TOL_ANG: number | undefined;
let DUAL = false, DUAL_PREC = 3;
/** Extension lines: gap at the outline and run past the dimension line (sheet mm), set by `useStyle`. */
let EXT_GAP = 1, EXT_OVER = 2;

/** Applies a drawing's drafting style: text height (arrow length follows it), arrowhead kind and the ISO 128 line group. */
export function useStyle(st: DraftStyle | undefined) {
  TEXT_H = st?.text ?? 3.5;
  ARROW = TEXT_H * 6 / 7;
  ARROW_KIND = st?.arrow ?? "filled";
  PREC_LIN = st?.lin; PREC_ANG = st?.ang;
  TOL_LIN = st?.tol; TOL_ANG = st?.atol;
  DUAL = st?.dual === "in"; DUAL_PREC = st?.dualPrec ?? 3;
  EXT_GAP = st?.extGap ?? 1; EXT_OVER = st?.extOver ?? 2;
  const thick = st?.lines ?? 0.35, thin = { 0.25: 0.13, 0.35: 0.18, 0.5: 0.25, 0.7: 0.35 }[thick] ?? thick / 2;
  Object.assign(PEN_W, { thick, thin, hidden: thin, center: thin, phantom: thin, frame: Math.max(0.5, thick * 1.4) });
}

/** A dimension or leader end at (x, y) pointing along (dx, dy), in the style's arrowhead. */
function arrow(x: number, y: number, dx: number, dy: number): Prim {
  const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  if (ARROW_KIND === "open") return { t: "p", p: [x - ux * ARROW - uy * ARROW * 0.3, y - uy * ARROW + ux * ARROW * 0.3, x, y, x - ux * ARROW + uy * ARROW * 0.3, y - uy * ARROW - ux * ARROW * 0.3], pen: "thin", layer: "ANNOT" };
  if (ARROW_KIND === "dot") { const r = ARROW / 5, p: number[] = []; for (let i = 0; i < 12; i++) p.push(x + r * Math.cos(i * Math.PI / 6), y + r * Math.sin(i * Math.PI / 6)); return { t: "p", p, pen: "thin", layer: "ANNOT", closed: true, fill: true }; }
  if (ARROW_KIND === "tick") { const k = ARROW / 2 * Math.SQRT1_2, ax = (ux - uy) * k, ay = (uy + ux) * k; return { t: "l", p: [x - ax, y - ay, x + ax, y + ay], pen: "thick", layer: "ANNOT" }; }
  return arrowHead(x, y, dx, dy, ARROW, 1);
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const unit2 = (a: P2, fb: P2 = [1, 0]): P2 => { const l = len2(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : fb; };
const d2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Approximate width of a text on the sheet (DejaVu Sans). */
export const textW = (s: string, h = TEXT_H) => textWidth(s, h);

/** A number for a drawing: `prec` decimals, or up to 2 with trailing zeros dropped; the language's decimal sign. */
export function fmtNum(v: number, prec: number | undefined, dec = "."): string {
  let s = prec != null ? v.toFixed(prec) : (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return dec === "." ? s : s.replace(".", dec);
}

// ---------- references ----------

/** The model edge a reference names (the one of that name nearest to its hint), or null when it is gone. */
export function refEdge(ref: GeoRef, topo: Topo | null): MEdge | null {
  if ("pt" in ref || !topo) return null;
  let best: MEdge | null = null, bd = Infinity;
  for (const e of topo.edges) {
    if (e.k !== ref.e) continue;
    const d = Math.hypot(...sub3(e.m, ref.h));
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** The model point a reference stands for (for an edge "e": its middle, or a circle's centre). */
export function refPoint(ref: GeoRef, topo: Topo | null): V3 | null {
  if ("pt" in ref) return ref.com && topo?.com ? topo.com : ref.pt;
  const e = refEdge(ref, topo);
  if (!e) return null;
  if (ref.p === "c" || (ref.p === "e" && e.t === "c")) return e.c ?? e.m;
  if (ref.p === "e") return e.m;
  if (ref.q) return Math.hypot(...sub3(e.a, ref.q)) <= Math.hypot(...sub3(e.b, ref.q)) ? e.a : e.b;
  return ref.p === "a" ? e.a : e.b;
}

/** A reference to a model edge, for annotations. */
export function edgeRef(e: MEdge, p: "a" | "b" | "c" | "e"): GeoRef {
  return { e: e.k, h: e.m, p, ...(p === "a" ? { q: e.a } : p === "b" ? { q: e.b } : {}) };
}

/** Projects model points into a view's axes. */
export function projector(vd: ViewDir) {
  const { x, y, n } = viewAxes(vd);
  return { n, P: (p: V3): P2 => [dot3(p, x), dot3(p, y)] };
}

// ---------- dimension geometry ----------

/** `a0`/`sw`: an arc's start angle and sweep in view axes; `ang`: a chamfer's angle in degrees. */
/** `dl`: a circle seen side-on (as a line): the direction of that line in the view, along which its diameter is dimensioned. */
/** `segs`: for each of a linear dimension's two points, the measured straight edge it may slide along (null for a plain point). */
export interface DimGeo { k: DimAnnot["k"]; pts: P2[]; c?: P2; r?: number; lines?: [P2, P2][]; value: number; a0?: number; sw?: number; ang?: number; segs?: ([P2, P2] | null)[]; dl?: P2 }

/**
 * Whether a round edge is a whole circle: by itself, or with the other arcs on its centre and radius
 * (STEP files split a circle into two halves). A new dimension on it is a diameter, on any other arc a radius.
 */
export function wholeCircle(e: MEdge, topo: Topo | null): boolean {
  if (e.t !== "c" || !e.c || !e.r) return false;
  const full = TAU - 1e-3;
  if ((e.sp ?? 0) >= full) return true;
  const c = e.c, tol = 1e-6 * Math.max(1, e.r);
  let sum = 0;
  for (const o of topo?.edges ?? []) if (o.t === "c" && o.c && o.r && Math.abs(o.r - e.r) < tol && Math.hypot(o.c[0] - c[0], o.c[1] - c[1], o.c[2] - c[2]) < tol) sum += o.sp ?? 0;
  return sum >= full;
}

const TAU = 2 * Math.PI;
const normA = (v: number) => { v %= TAU; return v < 0 ? v + TAU : v; };

/** The measured geometry of a dimension in a view (model mm, view axes), or null when its edges are gone. */
export function dimGeo(a: DimAnnot, P: (p: V3) => P2, topo: Topo | null): DimGeo | null {
  const kind = a.k;
  if (kind === "rad" || kind === "dia") {
    const r0 = a.refs[0];
    if (!r0) return null;
    if ("pt" in r0) {
      const p1 = a.refs[1] && refPoint(a.refs[1], topo);
      if (!p1) return null;
      const c = P(refPoint(r0, topo)!), q = P(p1), r = d2(c, q);
      return { k: kind, pts: [], c, r, value: kind === "rad" ? r : 2 * r };
    }
    const e = refEdge(r0, topo);
    if (!e || e.t !== "c" || !e.c || !e.r) return null;
    // Seen side-on the circle is a line square to its axis: its diameter is then a linear dimension along that line.
    const o = P([0, 0, 0]), q = e.ax ? P(e.ax) : null, ax: P2 | null = q ? [q[0] - o[0], q[1] - o[1]] : null;
    const dl: P2 | undefined = ax && Math.abs(len2(ax) - 1) < 1e-6 ? [-ax[1], ax[0]] : undefined;
    return { k: kind, pts: [], c: P(e.c), r: e.r, value: kind === "rad" ? e.r : 2 * e.r, dl };
  }
  if (kind === "arc") {
    // The arc runs from one end through its middle to the other, whichever way that is in the view.
    const e = a.refs[0] && refEdge(a.refs[0], topo);
    if (!e || e.t !== "c" || !e.c || !e.r) return null;
    const c = P(e.c), at = (q: V3) => { const w = P(q); return Math.atan2(w[1] - c[1], w[0] - c[0]); };
    let a0 = at(e.a), sw = normA(at(e.b) - a0);
    if (sw < 1e-9) sw = TAU;
    else if (normA(at(e.m) - a0) > sw) { a0 = at(e.b); sw = TAU - sw; }
    return { k: kind, pts: [], c, r: e.r, a0: normA(a0), sw, value: e.r * sw };
  }
  if (kind === "oh" || kind === "ov") {
    const p0 = a.refs[0] && refPoint(a.refs[0], topo), p1 = a.refs[1] && refPoint(a.refs[1], topo);
    if (!p0 || !p1) return null;
    const s = P(p0), q = P(p1);
    return { k: kind, pts: [s, q], value: Math.abs(kind === "oh" ? q[0] - s[0] : q[1] - s[1]) };
  }
  if (kind === "ang" || kind === "chamfer") {
    const lines: [P2, P2][] = [];
    for (const r of a.refs) { const e = refEdge(r, topo); if (!e || e.t !== "l") return null; lines.push([P(e.a), P(e.b)]); }
    if (lines.length !== 2) return null;
    if (kind === "ang") return { k: kind, pts: [], lines, value: 0 };
    // The chamfer is the shorter line: its run along the other one, and the angle between them.
    if (d2(...lines[1]) < d2(...lines[0])) lines.reverse();
    const [c0, c1] = lines[0], w: P2 = [c1[0] - c0[0], c1[1] - c0[1]], u = unit2([lines[1][1][0] - lines[1][0][0], lines[1][1][1] - lines[1][0][1]]);
    const run = Math.abs(w[0] * u[0] + w[1] * u[1]), L = len2(w) || 1;
    return { k: kind, pts: [], lines, value: run, ang: Math.acos(Math.min(1, run / L)) * 180 / Math.PI };
  }
  // Linear: two points, or the two ends of one line; a line and a point or two parallel lines: the square distance.
  const pts: P2[] = [];
  let segs: ([P2, P2] | null)[] | undefined;
  const lineOf = (r: GeoRef): [P2, P2] | null => { if ("pt" in r || r.p !== "e") return null; const e = refEdge(r, topo); return e && e.t === "l" ? [P(e.a), P(e.b)] : null; };
  const foot = (p: P2, l: [P2, P2]): P2 => { const [u, v] = l, dx = v[0] - u[0], dy = v[1] - u[1], L2 = dx * dx + dy * dy || 1, t = ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / L2; return [u[0] + dx * t, u[1] + dy * t]; };
  if (a.refs.length === 1) { const l = lineOf(a.refs[0]); if (!l) return null; pts.push(l[0], l[1]); }
  else {
    const l0 = lineOf(a.refs[0]), l1 = lineOf(a.refs[1]);
    const p0 = l0 ? null : refPoint(a.refs[0], topo), p1 = l1 ? null : refPoint(a.refs[1], topo);
    if (l0 && l1) { const m: P2 = [(l0[0][0] + l0[1][0]) / 2, (l0[0][1] + l0[1][1]) / 2]; pts.push(m, foot(m, l1)); segs = [l0, l1]; }
    else if (l0 && p1) { const q = P(p1); pts.push(foot(q, l0), q); segs = [l0, null]; }
    else if (p0 && l1) { const q = P(p0); pts.push(q, foot(q, l1)); segs = [null, l1]; }
    else if (p0 && p1) pts.push(P(p0), P(p1));
    else return null;
  }
  const [s, t] = pts;
  const value = kind === "h" ? Math.abs(t[0] - s[0]) : kind === "v" ? Math.abs(t[1] - s[1]) : d2(s, t);
  return { k: kind, pts, value, segs };
}

/** The sector of two lines that holds `t`: intersection, start angle and sweep (radians), or null for parallel lines. */
export function angleSector(l1: [P2, P2], l2: [P2, P2], t: P2): { x: P2; a0: number; sw: number } | null {
  const d1 = unit2([l1[1][0] - l1[0][0], l1[1][1] - l1[0][1]]), d2v = unit2([l2[1][0] - l2[0][0], l2[1][1] - l2[0][1]]);
  const den = d1[0] * d2v[1] - d1[1] * d2v[0];
  if (Math.abs(den) < 1e-9) return null;
  const w: P2 = [l2[0][0] - l1[0][0], l2[0][1] - l1[0][1]];
  const s = (w[0] * d2v[1] - w[1] * d2v[0]) / den;
  const x: P2 = [l1[0][0] + d1[0] * s, l1[0][1] + d1[1] * s];
  const norm = (v: number) => { v %= 2 * Math.PI; return v < 0 ? v + 2 * Math.PI : v; };
  const at = Math.atan2(t[1] - x[1], t[0] - x[0]);
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
    let a0 = Math.atan2(d1[1] * s1, d1[0] * s1), sw = norm(Math.atan2(d2v[1] * s2, d2v[0] * s2) - a0);
    if (sw > Math.PI) { a0 = a0 + sw; sw = 2 * Math.PI - sw; }
    if (norm(at - a0) <= sw + 1e-9) return { x, a0: norm(a0), sw };
  }
  return null;
}

// ---------- text of dimensions and callouts ----------

export function dimText(a: DimAnnot, g: DimGeo, dec: string): { main: string; up?: string; lo?: string } {
  if (a.show === "ref" && !a.txt) {
    const r = dimText({ ...a, show: undefined }, g, dec);
    return r.main ? { ...r, main: `(${r.main})` } : { main: "", up: `(${r.up})`, lo: `(${r.lo})` };
  }
  // A basic dimension is theoretically exact: no tolerance, not even the drawing's default.
  if (a.show === "basic") a = { ...a, tol: { t: "none" } };
  const prec = a.prec ?? (g.k === "ang" ? PREC_ANG : PREC_LIN);
  const f = (v: number) => fmtNum(v, prec, dec), fa = (v: number) => fmtNum(v, a.prec ?? PREC_ANG, dec);
  // ◠ (U+25E0) stands for ISO 129's arc symbol: DejaVu Sans has no ⌒.
  const pre = a.pre ?? (g.k === "rad" ? "R" : g.k === "dia" ? "Ø" : g.k === "arc" ? "◠" : "");
  const suf = (g.k === "ang" ? "°" : "") + (a.suf ?? "");
  const dt = g.k === "ang" ? TOL_ANG : TOL_LIN;
  const tol: Tol | undefined = a.tol ?? (dt ? { t: "sym", up: dt } : undefined);
  if (a.txt) return { main: a.txt };
  // Dual dimension: the same length in inches, in brackets after the millimetres (angles have none).
  const dual = g.k !== "ang" && (a.dual ?? DUAL);
  const fi = (x: number) => fmtNum(x / 25.4, DUAL_PREC, dec), inch = (x: number, more = "") => (dual ? ` [${fi(x)}${more}]` : "");
  if (g.k === "chamfer") return { main: `${pre}${f(g.value)}${inch(g.value)} × ${fa(g.ang ?? 0)}°${suf}` };
  const v = g.value;
  if (tol?.t === "limit") { const hi = v + (tol.up ?? 0), low = v - (tol.lo ?? 0); return { main: "", up: pre + f(hi) + suf + inch(hi), lo: pre + f(low) + suf + inch(low) }; }
  let main = pre + f(v);
  if (tol?.t === "sym") return { main: `${main}±${f(tol.up ?? 0)}${suf}${inch(v, `±${fi(tol.up ?? 0)}`)}` };
  const sg = (x: number) => (x > 0 ? `+${f(x)}` : x < 0 ? `−${f(-x)}` : "0");
  if (tol?.t === "fit") {
    const code = tol.fit ?? "", lim = tol.show && tol.show !== "code" && !code.includes("/") ? fitLimits(code, v) : null;
    if (!lim) return { main: `${main}${code}${suf}${inch(v)}` };
    // Deviations to the fit's own precision (µm), never rounded away by the dimension's.
    const fd = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "") + (x === 0 ? "0" : fmtNum(Math.abs(x), Math.max(prec ?? 0, 3), dec));
    return { main: (tol.show === "both" ? `${main}${code}${suf}` : main + suf) + inch(v), up: fd(lim.up), lo: fd(lim.lo) };
  }
  main += suf + inch(v);
  if (tol?.t === "dev") return { main, up: sg(tol.up ?? 0), lo: sg(-(tol.lo ?? 0)) };
  return { main };
}

/** Hole callout lines (ISO style) for a round edge: from the hole feature at that place, else from the cylinder. */
export function holeText(e: MEdge, ctx: AnnotCtx, count = true): string[] {
  // Sizes follow the drawing's default decimals and dual dimensions (inches in brackets); angles and thread sizes do not.
  const fa = (v: number) => fmtNum(v, undefined, ctx.dec);
  const f = (v: number) => fmtNum(v, PREC_LIN, ctx.dec) + (DUAL ? ` [${fmtNum(v / 25.4, DUAL_PREC, ctx.dec)}]` : "");
  const c = e.c, ax = e.ax, r = e.r ?? 0;
  if (c && ax) {
    for (const h of ctx.holes) {
      if (Math.abs(Math.abs(dot3(h.n, ax)) - 1) > 1e-6) continue;
      const on = h.pts.some(p => { const w = sub3(c, p), along = dot3(w, h.n); return Math.hypot(w[0] - h.n[0] * along, w[1] - h.n[1] * along, w[2] - h.n[2] * along) < 1e-3; });
      if (!on) continue;
      const H = h.f, n = count && h.pts.length > 1 ? `${h.pts.length}× ` : "";
      const depth = H.end === "through" ? ` ${ctx.label("THRU")}` : H.end === "blind" ? ` ↧${f(H.depth.v)}` : "";
      const lines: string[] = [];
      if (H.kind === "tapped" && H.size) {
        lines.push(`${n}Ø${f(H.diameter.v)}${depth}`);
        lines.push(`${H.size}-6H${H.threadDepth ? ` ↧${f(H.threadDepth.v)}` : H.end === "through" ? ` ${ctx.label("THRU")}` : ""}`);
      } else lines.push(`${n}Ø${f(H.diameter.v)}${depth}`);
      if (H.kind === "cbore" && H.cbDia) lines.push(`⌴Ø${f(H.cbDia.v)}${H.cbDepth ? ` ↧${f(H.cbDepth.v)}` : ""}`);
      if (H.kind === "cdrill" && H.cdDia) lines.push(`⌴Ø${f(H.cdDia.v)}${H.cdDepth ? ` ↧${f(H.cdDepth.v)}` : ""} × ${fa((H.cdAngle?.v ?? (118 * Math.PI) / 180) * 180 / Math.PI)}°`);
      if (H.kind === "csink" && H.csDia) lines.push(`⌵Ø${f(H.csDia.v)} × ${fa((H.csAngle?.v ?? Math.PI / 2) * 180 / Math.PI)}°`);
      return lines;
    }
  }
  // No hole feature: read the hole from the geometry (count, counterbore, countersink, depth or THRU).
  const st = c && ax && r ? stackAt(c, ax, r, ctx.topo) : null, g = st && geoHole(st, f, ctx.threads, fa);
  if (g) {
    const words = (h: GeoHole) => h.lines.map(s => s.replace(/ THRU$/, ` ${ctx.label("THRU")}`));
    const n = count ? ctx.topo!.holes!.filter(h => { const o = geoHole(h, f, ctx.threads, fa); return !!o && o.key === g.key && (g.free ? Math.abs(Math.abs(dot3(o.dir, g.dir)) - 1) < 1e-6 : dot3(o.dir, g.dir) > 1 - 1e-6); }).length : 1;
    const lines = words(g);
    if (n > 1) lines[0] = `${n}× ${lines[0]}`;
    return lines;
  }
  let line = `Ø${f(2 * r)}`;
  const cyl = c && ax && ctx.topo?.cyls.find(y => Math.abs(y.r - r) < 1e-6 && Math.abs(Math.abs(dot3(y.ax, ax)) - 1) < 1e-6 && (() => { const w = sub3(c, y.o), al = dot3(w, y.ax); return Math.hypot(w[0] - y.ax[0] * al, w[1] - y.ax[1] * al, w[2] - y.ax[2] * al) < 1e-3; })());
  if (cyl && ctx.box) {
    const [lo, hi] = ctx.box, span = Math.abs(cyl.ax[0]) * (hi[0] - lo[0]) + Math.abs(cyl.ax[1]) * (hi[1] - lo[1]) + Math.abs(cyl.ax[2]) * (hi[2] - lo[2]);
    const depth = cyl.v1 - cyl.v0;
    line += depth >= span - 1e-3 ? ` ${ctx.label("THRU")}` : ` ↧${f(depth)}`;
  }
  return [line];
}

/** A hole read from the geometry: callout lines (English THRU), a key for counting equal ones, the way into the material. */
export interface GeoHole { lines: string[]; key: string; dir: V3; free: boolean }

/** The geometric hole that a round edge (centre, axis, radius) belongs to. */
export function stackAt(c: V3, ax: V3, r: number, topo: Topo | null): MHole | null {
  for (const h of topo?.holes ?? []) {
    if (Math.abs(Math.abs(dot3(h.ax, ax)) - 1) > 1e-6) continue;
    const w = sub3(c, h.o), v = dot3(w, h.ax);
    if (Math.hypot(w[0] - h.ax[0] * v, w[1] - h.ax[1] * v, w[2] - h.ax[2] * v) > 1e-3) continue;
    if (h.segs.some(s => v > s.v0 - 1e-6 && v < s.v1 + 1e-6 && (Math.abs(s.r0 - r) < 1e-6 || Math.abs(s.r1 - r) < 1e-6))) return h;
  }
  return null;
}

/**
 * Callout of a hole made of cylinders and cones (ISO style, as SolidWorks writes it): the drill Ø with its depth from
 * the entry face or THRU, then ⌴ counterbore Ø and depth or ⌵ countersink Ø × angle. The entry is the open end (for a
 * through hole, the wider one). Null when the hole has no cylinder to call the drill or no open end.
 */
export function geoHole(h: MHole, f: (v: number) => string = v => fmtNum(v, undefined), threads: ThreadInfo[] = [], fa: (v: number) => string = f): GeoHole | null {
  const [o0, o1] = h.open;
  if (!o0 && !o1) return null;
  const s = h.segs, first = s[0], last = s[s.length - 1];
  const fromStart = o0 && (!o1 || first.r0 >= last.r1 - 1e-6);
  const e0 = fromStart ? first.v0 : last.v1;
  const W = (fromStart ? s : [...s].reverse()).map(g => fromStart
    ? { k: g.k, a: g.v0 - e0, b: g.v1 - e0, ra: g.r0, rb: g.r1 }
    : { k: g.k, a: e0 - g.v1, b: e0 - g.v0, ra: g.r1, rb: g.r0 });
  let i = 0, extra = "";
  if (W[0].k === "cone" && W[0].ra > W[0].rb + 1e-6 && W[1]?.k === "cyl") {
    extra = `⌵Ø${f(2 * W[0].ra)} × ${fa(Math.round(2 * Math.atan((W[0].ra - W[0].rb) / (W[0].b - W[0].a)) * 180 / Math.PI * 100) / 100)}°`;
    i = 1;
  } else if (W[0].k === "cyl" && W[1]?.k === "cyl" && W[1].ra < W[0].ra - 1e-6) {
    extra = `⌴Ø${f(2 * W[0].ra)} ↧${f(W[0].b - W[0].a)}`;
    i = 1;
  }
  const d = W[i];
  if (!d || d.k !== "cyl") return null;
  const thru = o0 && o1;
  const lines = [`Ø${f(2 * d.ra)} ${thru ? "THRU" : `↧${f(d.b)}`}`];
  // A cosmetic thread on the drill (FR-DRW-022): its size with the ISO 965 6H class, and its length unless it runs through.
  const th = threads.find(t => {
    if (!t.internal || Math.abs(Math.abs(dot3(t.ax, h.ax)) - 1) > 1e-6 || Math.abs(t.r - d.ra) > 1e-3) return false;
    const w = sub3(t.c, h.o), v = dot3(w, h.ax);
    return Math.hypot(w[0] - h.ax[0] * v, w[1] - h.ax[1] * v, w[2] - h.ax[2] * v) < 1e-3;
  });
  if (th) lines.push(`${th.size ?? `M${fa(th.d)}`}-6H ${th.L == null ? (thru ? "THRU" : `↧${f(d.b)}`) : `↧${f(th.L)}`}`);
  if (extra) lines.push(extra);
  // The rest past the drill (a drill point) is part of the key, so a flat-bottomed hole is not counted with a pointed one.
  const rest = W.slice(i + 1).map(g => `${g.k}:${f(g.b - g.a)}:${f(g.ra)}:${f(g.rb)}`).join(",");
  const dir: V3 = fromStart ? h.ax : [-h.ax[0], -h.ax[1], -h.ax[2]];
  return { lines, key: `${lines.join("|")}|${rest}`, dir, free: thru && !extra };
}

// ---------- drawing ----------

/** `dangling`: annotations whose model edge is gone (FR-DRW-026); the workspace shows them in the warning colour. */
/** `ring`: a revision cloud's corners (sheet mm, closed): it is picked near its outline only, so views inside stay draggable. */
export interface AnnotOut { prims: Prim[]; hits: { id: string; box: [number, number, number, number]; ring?: number[]; band?: number; open?: boolean }[]; dangling: string[] }

const thin = (a: P2, b: P2): Prim => ({ t: "l", p: [a[0], a[1], b[0], b[1]], pen: "thin", layer: "ANNOT" });
const add2 = (a: P2, b: P2, s = 1): P2 => [a[0] + b[0] * s, a[1] + b[1] * s];

/** A text's hit box (sheet mm) for a centred or left/right aligned, possibly rotated, text. */
function textBox(x: number, y: number, s: string, h: number, al: "l" | "c" | "r", rot = 0): [number, number, number, number] {
  const w = textW(s, h), a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const x0 = al === "l" ? 0 : al === "c" ? -w / 2 : -w;
  const pts = [[x0, -0.3 * h], [x0 + w, -0.3 * h], [x0, h * 1.1], [x0 + w, h * 1.1]].map(([u, v]) => [x + u * ca - v * sa, y + u * sa + v * ca]);
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}

/** Draws one dimension. `pl` places the view's model axes on the sheet; an inspection dimension frames its text with an obround, a basic one with a box. */
export function dimPrims(a: DimAnnot, g: DimGeo, pl: Placement, dec: string): { prims: Prim[]; box: [number, number, number, number] } {
  const kind = ARROW_KIND;
  if (a.ends) ARROW_KIND = a.ends;
  let r: ReturnType<typeof dimPrims0>;
  try { r = dimPrims0(a, g, pl, dec); } finally { ARROW_KIND = kind; }
  if (a.insp) r.prims.push(...obround(r.box));
  if (a.show === "basic") {
    const [x0, y0, x1, y1] = [r.box[0] - 0.6, r.box[1] - 0.4, r.box[2] + 0.6, r.box[3] + 0.2];
    r.prims.push(thin([x0, y0], [x1, y0]), thin([x1, y0], [x1, y1]), thin([x1, y1], [x0, y1]), thin([x0, y1], [x0, y0]));
  }
  return r;
}

/** An obround (two straight sides, round ends) around a text box, its round ends on the box's short sides. */
export function obround(b: [number, number, number, number]): Prim[] {
  const [x0, y0, x1, y1] = [b[0] - 0.6, b[1] - 0.4, b[2] + 0.6, b[3] + 0.2];
  const w = x1 - x0, h = y1 - y0, P = (o: P2, r: number, a0: number, a1: number): Prim => ({ t: "a", o, r, a0, a1, pen: "thin", layer: "ANNOT" });
  if (w >= h) {
    const r = h / 2, cy = (y0 + y1) / 2;
    return [thin([x0, y0], [x1, y0]), thin([x0, y1], [x1, y1]), P([x1, cy], r, -Math.PI / 2, Math.PI / 2), P([x0, cy], r, Math.PI / 2, 1.5 * Math.PI)];
  }
  const r = w / 2, cx = (x0 + x1) / 2;
  return [thin([x0, y0], [x0, y1]), thin([x1, y0], [x1, y1]), P([cx, y1], r, 0, Math.PI), P([cx, y0], r, Math.PI, 2 * Math.PI)];
}

function dimPrims0(a: DimAnnot, g: DimGeo, pl: Placement, dec: string): { prims: Prim[]; box: [number, number, number, number] } {
  const out: Prim[] = [];
  const S = (p: P2) => toSheet(pl, p[0], p[1]);
  const T = S(a.pos);
  const txt = dimText(a, g, dec);
  const h = TEXT_H, small = h * 0.7;
  let mainW = 0, totalW = 0;
  const measure = () => {
    mainW = textW(txt.main, h);
    const tolW = txt.up || txt.lo ? Math.max(textW(txt.up ?? "", small), textW(txt.lo ?? "", small)) : 0;
    totalW = mainW + (txt.main && tolW ? tolW + 0.6 : tolW);
  };
  measure();
  /** Writes the value centred at `c` along `d` (rotation `rot`), `up` being the reading up direction. */
  const writeText = (c: P2, rot: number, al: "c" | "l" | "r" = "c"): [number, number, number, number] => {
    const a0 = rot * Math.PI / 180, dir: P2 = [Math.cos(a0), Math.sin(a0)], up: P2 = [-dir[1], dir[0]];
    // Start of the whole text block along the baseline.
    const start = al === "c" ? add2(c, dir, -totalW / 2) : al === "l" ? c : add2(c, dir, -totalW);
    if (txt.main) out.push({ t: "t", x: start[0], y: start[1], s: txt.main, h, al: "l", layer: "ANNOT", rot: rot || undefined });
    if (txt.up || txt.lo) {
      const s0 = add2(start, dir, txt.main ? mainW + 0.6 : 0);
      const big = !txt.main;
      const hh = big ? h * 0.8 : small;
      if (txt.up) { const p = add2(s0, up, big ? h * 0.55 : h * 0.6); out.push({ t: "t", x: p[0], y: p[1], s: txt.up, h: hh, al: "l", layer: "ANNOT", rot: rot || undefined }); }
      if (txt.lo) { const p = add2(s0, up, big ? -h * 0.45 : -h * 0.25); out.push({ t: "t", x: p[0], y: p[1], s: txt.lo, h: hh, al: "l", layer: "ANNOT", rot: rot || undefined }); }
    }
    const box = textBox(start[0], start[1], "x".repeat(Math.max(1, Math.round(totalW / (h * 0.85)))), h, "l", rot);
    if (!a.below) return box;
    // A second line under the dimension line (the value sits 0.8 above it), centred under the value.
    const wb = textW(a.below, h), sb = add2(add2(start, dir, (totalW - wb) / 2), up, -(h + 1.6));
    out.push({ t: "t", x: sb[0], y: sb[1], s: a.below, h, al: "l", layer: "ANNOT", rot: rot || undefined });
    const bb = textBox(sb[0], sb[1], "x".repeat(Math.max(1, Math.round(wb / (h * 0.85)))), h, "l", rot);
    return [Math.min(box[0], bb[0]), Math.min(box[1], bb[1]), Math.max(box[2], bb[2]), Math.max(box[3], bb[3])];
  };
  const diaLin = g.k === "dia" && (!!a.lin || !!g.dl);
  if ((g.k === "rad" || g.k === "dia") && !diaLin) {
    const C = S(g.c!), R = g.r! * pl.s;
    const u = unit2([T[0] - C[0], T[1] - C[1]], [Math.SQRT1_2, Math.SQRT1_2]);
    const outside = d2(T, C) > R;
    const far = outside ? T : add2(C, u, R);
    const lead = !!a.outside && outside && !(g.k === "rad" && a.fore);
    if (g.k === "rad" && a.fore) {
      // Foreshortened radius: the centre is far away (or off the sheet), so the line stops short of it with a jog.
      const A = add2(C, u, R), n: P2 = [-u[1], u[0]], len = Math.min(R * 0.6, FORE_LEN);
      const B = add2(A, u, -len / 2), B2 = add2(add2(B, u, -FORE_JOG / 2), n, FORE_JOG), E = add2(B2, u, -len / 2);
      out.push({ t: "p", p: [...E, ...B2, ...B, ...A], pen: "thin", layer: "ANNOT" });
      if (outside) out.push(thin(A, T));
    } else if (lead) out.push(thin(add2(C, u, R), T));
    else out.push(thin(g.k === "dia" ? add2(C, u, -R) : C, far));
    // A leader from outside points at the rim; otherwise the arrows touch the rim from inside.
    if (lead) out.push(arrow(...add2(C, u, R), -u[0], -u[1]));
    else {
      out.push(arrow(...add2(C, u, R), u[0], u[1]));
      if (g.k === "dia") out.push(arrow(...add2(C, u, -R), -u[0], -u[1]));
    }
    // A short horizontal shoulder at the text, which sits on it.
    const sx = u[0] >= 0 ? 1 : -1;
    let box: [number, number, number, number];
    if (a.along) {
      // Text along the leader, readable from the bottom or the right; outside the rim the leader runs on under it.
      let rot = Math.atan2(u[1], u[0]) * 180 / Math.PI;
      if (rot > 90.001) rot -= 180;
      if (rot <= -89.999) rot += 180;
      const rr = rot * Math.PI / 180, up: P2 = [-Math.sin(rr), Math.cos(rr)];
      if (outside) out.push(thin(T, add2(T, u, totalW + 1)));
      box = writeText(add2(outside ? add2(T, u, totalW / 2 + 0.5) : T, up, 0.8), rot, "c");
    } else if (outside) {
      const end: P2 = [T[0] + sx * (totalW + 1), T[1]];
      out.push(thin(T, end));
      box = writeText([T[0] + sx * 0.5, T[1] + 0.8], 0, sx > 0 ? "l" : "r");
    } else box = writeText([T[0], T[1] + 0.8], 0, "c");
    return { prims: out, box };
  }
  if (g.k === "arc") {
    // A dimension arc concentric with the edge, radial extension lines, the value above its middle.
    const C = S(g.c!), R0 = g.r! * pl.s, R = Math.max(d2(T, C), R0 + 2), a0 = g.a0!, a1 = a0 + g.sw!;
    out.push({ t: "a", o: C, r: R, a0, a1, pen: "thin", layer: "ANNOT" });
    const tip = (an: number): P2 => [C[0] + R * Math.cos(an), C[1] + R * Math.sin(an)];
    out.push(arrow(...tip(a0), Math.sin(a0), -Math.cos(a0)));
    out.push(arrow(...tip(a1), -Math.sin(a1), Math.cos(a1)));
    for (const [an, k] of [[a0, "a"], [a1, "b"]] as [number, "a" | "b"][]) {
      if (a.noExt === k || a.noExt === "both") continue;
      const e: P2 = [Math.cos(an), Math.sin(an)]; out.push(thin(add2(C, e, R0 + EXT_GAP), add2(C, e, R + EXT_OVER)));
    }
    const mid = a0 + g.sw! / 2, tp: P2 = [C[0] + (R + 1.5) * Math.cos(mid), C[1] + (R + 1.5) * Math.sin(mid)];
    const box = writeText([tp[0], tp[1] - (Math.sin(mid) < 0 ? h : 0)], 0, Math.cos(mid) > 0.3 ? "l" : Math.cos(mid) < -0.3 ? "r" : "c");
    return { prims: out, box };
  }
  if (g.k === "chamfer") {
    // A leader from the chamfer's middle to a shoulder that carries "run × angle".
    const [A, B] = g.lines![0].map(S), M: P2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const u = unit2([M[0] - T[0], M[1] - T[1]]);
    out.push(thin(T, M), arrow(M[0], M[1], u[0], u[1]));
    const sx = T[0] >= M[0] ? 1 : -1;
    out.push(thin(T, [T[0] + sx * (totalW + 1), T[1]]));
    return { prims: out, box: writeText([T[0] + sx * 0.5, T[1] + 0.8], 0, sx > 0 ? "l" : "r") };
  }
  if (g.k === "oh" || g.k === "ov") {
    // Ordinate: an extension line from the point out to the text's line, the value written on past its end.
    const Q = S(g.pts[1]), hor = g.k === "oh";
    const end: P2 = hor ? [Q[0], T[1]] : [T[0], Q[1]];
    const L = d2(Q, end), dir = unit2([end[0] - Q[0], end[1] - Q[1]], hor ? [0, 1] : [1, 0]);
    if (L > EXT_GAP + 0.5) out.push(thin(add2(Q, dir, EXT_GAP), end));
    const box = hor ? writeText([end[0] + h * 0.35, end[1] + dir[1]], 90, dir[1] > 0 ? "l" : "r")
      : writeText([end[0] + dir[0], end[1] - h * 0.35], 0, dir[0] > 0 ? "l" : "r");
    return { prims: out, box };
  }
  if (g.k === "ang") {
    const L = g.lines!.map(l => [S(l[0]), S(l[1])] as [P2, P2]);
    const sec = angleSector(L[0], L[1], T);
    if (!sec) return { prims: out, box: textBox(T[0], T[1], "?", h, "c") };
    g.value = sec.sw * 180 / Math.PI;
    const txt2 = dimText(a, g, dec);
    txt.main = txt2.main; txt.up = txt2.up; txt.lo = txt2.lo;
    const R = Math.max(d2(T, sec.x), 3), a1 = sec.a0 + sec.sw;
    // Arrows inside the sector while its arc has room for both; else outside it, on tails of the arc.
    const inside = a.arrows ? a.arrows === "in" : R * sec.sw >= 2 * ARROW + 2, tail = inside ? 0 : Math.min((ARROW + 2) / R, (2 * Math.PI - sec.sw) / 2 - 1e-3);
    out.push({ t: "a", o: sec.x, r: R, a0: sec.a0 - tail, a1: a1 + tail, pen: "thin", layer: "ANNOT" });
    const tip = (an: number): P2 => [sec.x[0] + R * Math.cos(an), sec.x[1] + R * Math.sin(an)], sg = inside ? 1 : -1;
    out.push(arrow(...tip(sec.a0), sg * Math.sin(sec.a0), -sg * Math.cos(sec.a0)));
    out.push(arrow(...tip(a1), -sg * Math.sin(a1), sg * Math.cos(a1)));
    // Extension lines when the arc runs past the lines' ends.
    for (const [l, an, k] of [[L[0], sec.a0, "a"], [L[1], a1, "b"]] as [[P2, P2], number, string][]) {
      if (a.noExt === k || a.noExt === "both") continue;
      const e: P2 = [Math.cos(an), Math.sin(an)], reach = Math.max(...l.map(p => (p[0] - sec.x[0]) * e[0] + (p[1] - sec.x[1]) * e[1]));
      if (reach < R - 1) out.push(thin(add2(sec.x, e, Math.max(reach, 0) + 1), add2(sec.x, e, R + 2)));
    }
    const mid = sec.a0 + sec.sw / 2, tp: P2 = [sec.x[0] + (R + 1.5) * Math.cos(mid), sec.x[1] + (R + 1.5) * Math.sin(mid)];
    measure();
    const box = writeText([tp[0], tp[1] - (Math.sin(mid) < 0 ? h : 0)], 0, Math.cos(mid) > 0.3 ? "l" : Math.cos(mid) < -0.3 ? "r" : "c");
    return { prims: out, box };
  }
  // Linear.
  // A diameter shown as a linear dimension: between the rim's two ends along the sheet's horizontal or vertical.
  const dl: P2 = g.dl ?? (a.lin === "v" ? [0, 1] : [1, 0]);
  const [S1, S2] = diaLin ? [add2(S(g.c!), dl, -g.r! * pl.s), add2(S(g.c!), dl, g.r! * pl.s)] : g.pts.map(S);
  const d: P2 = diaLin ? dl : g.k === "h" ? [1, 0] : g.k === "v" ? [0, 1] : unit2([S2[0] - S1[0], S2[1] - S1[1]]);
  const nrm: P2 = [-d[1], d[0]];
  const off = (p: P2) => (T[0] - p[0]) * nrm[0] + (T[1] - p[1]) * nrm[1];
  const D1 = add2(S1, nrm, off(S1)), D2 = add2(S2, nrm, off(S2));
  // An extension line leaves a measured edge at its end nearest the dimension line (or where the line crosses the edge),
  // so it never runs along the edge or across the part from the edge's middle.
  const extFrom = (s: P2, D: P2, i: number): P2 => {
    const sg = !diaLin && g.segs?.[i];
    if (!sg) return s;
    const [p, q] = sg.map(S), w: P2 = [q[0] - p[0], q[1] - p[1]], L = len2(w);
    if (L < 1e-9 || Math.abs(w[0] * d[0] + w[1] * d[1]) > 1e-6 * L) return s;
    const t = Math.max(0, Math.min(1, ((D[0] - p[0]) * w[0] + (D[1] - p[1]) * w[1]) / (L * L)));
    return [p[0] + w[0] * t, p[1] + w[1] * t];
  };
  const E1 = extFrom(S1, D1, 0), E2 = extFrom(S2, D2, 1);
  for (const [s, e, k] of [[E1, D1, "a"], [E2, D2, "b"]] as [P2, P2, "a" | "b"][]) {
    if (a.noExt === k || a.noExt === "both") continue;
    const v: P2 = [e[0] - s[0], e[1] - s[1]], L = len2(v);
    if (L > EXT_GAP + 0.5) { const u: P2 = [v[0] / L, v[1] / L]; out.push(thin(add2(s, u, EXT_GAP), add2(e, u, EXT_OVER))); }
  }
  const al = (p: P2) => p[0] * d[0] + p[1] * d[1];
  let [lo, hi] = [D1, D2];
  if (al(lo) > al(hi)) [lo, hi] = [hi, lo];
  const span = al(hi) - al(lo), st = al(T);
  let rot = Math.atan2(d[1], d[0]) * 180 / Math.PI;
  if (rot > 90.001) rot -= 180;
  if (rot <= -89.999) rot += 180;
  const rr = rot * Math.PI / 180, rdir: P2 = [Math.cos(rr), Math.sin(rr)], up: P2 = [-rdir[1], rdir[0]];
  const base = add2(lo, d, st - al(lo));
  // The dimension line runs under the text when the text is outside the arrows.
  const tLo = st - totalW / 2 - 1, tHi = st + totalW / 2 + 1;
  const inside = a.arrows ? a.arrows === "in" : span >= 2 * ARROW + 2;
  const from = Math.min(al(lo) - (inside ? 0 : ARROW + 2), tLo < al(lo) ? tLo : Infinity), to = Math.max(al(hi) + (inside ? 0 : ARROW + 2), tHi > al(hi) ? tHi : -Infinity);
  if (a.horiz) {
    // Horizontal text in a gap of the dimension line: the line stops where it would enter the text's box.
    const hw = totalW / 2 + 1, hh = h / 2 + 0.8, gap = Math.min(hw / Math.max(Math.abs(d[0]), 1e-9), hh / Math.max(Math.abs(d[1]), 1e-9));
    if (st - gap > from) out.push(thin(add2(lo, d, from - al(lo)), add2(lo, d, st - gap - al(lo))));
    if (to > st + gap) out.push(thin(add2(lo, d, st + gap - al(lo)), add2(lo, d, to - al(lo))));
  } else out.push(thin(add2(lo, d, from - al(lo)), add2(lo, d, to - al(lo))));
  if (inside) { out.push(arrow(lo[0], lo[1], -d[0], -d[1])); out.push(arrow(hi[0], hi[1], d[0], d[1])); }
  else { out.push(arrow(lo[0], lo[1], d[0], d[1])); out.push(arrow(hi[0], hi[1], -d[0], -d[1])); }
  const box = a.horiz ? writeText([base[0], base[1] - h * 0.4], 0, "c") : writeText(add2(base, up, 1), rot, "c");
  return { prims: out, box };
}

/** Draws a hole callout: a leader to the circle, a shoulder and the lines of text. */
function holePrims(a: HoleAnnot, e: MEdge, P: (p: V3) => P2, pl: Placement, ctx: AnnotCtx): { prims: Prim[]; box: [number, number, number, number] } {
  const out: Prim[] = [];
  const lines = a.txt ? a.txt.split("\n") : holeText(e, ctx, a.count !== false);
  if (a.below) lines.push(...a.below.split("\n"));
  const C = toSheet(pl, ...P(e.c ?? e.m)), R = (e.r ?? 0) * pl.s, T = toSheet(pl, a.pos[0], a.pos[1]);
  const u = unit2([T[0] - C[0], T[1] - C[1]], [Math.SQRT1_2, Math.SQRT1_2]);
  const tip = add2(C, u, R);
  out.push(thin(tip, T), arrow(tip[0], tip[1], -u[0], -u[1]));
  const sx = u[0] >= 0 ? 1 : -1, w = Math.max(...lines.map(s => textW(s))) + 1;
  out.push(thin(T, [T[0] + sx * w, T[1]]));
  const x = T[0] + sx * 0.5;
  lines.forEach((s, i) => out.push({ t: "t", x, y: T[1] + 0.8 + (lines.length - 1 - i) * TEXT_H * 1.5, s, h: TEXT_H, al: sx > 0 ? "l" : "r", layer: "ANNOT" }));
  const x0 = sx > 0 ? T[0] : T[0] - w, x1 = sx > 0 ? T[0] + w : T[0];
  return { prims: out, box: [x0, T[1] - 0.5, x1, T[1] + 0.8 + lines.length * TEXT_H * 1.5] };
}

/** Draws a note (multi-line text) and its leader. */
/** Length of a bent note leader's horizontal shoulder, sheet mm. */
/** Foreshortened radius: longest run of the shortened dimension line and the size of its jog (sheet mm). */
const FORE_LEN = 24, FORE_JOG = 3;
export const NOTE_SHOULDER = 4;
export function notePrims(a: NoteAnnot, at: P2, leaderTo: P2 | null): { prims: Prim[]; box: [number, number, number, number] } {
  const out: Prim[] = [], h = a.h ?? TEXT_H, lines = expandProps(a.text).split("\n");
  const w = Math.max(1, ...lines.map(s => textW(s, h)));
  // Justification: the block keeps its place, the lines move inside it.
  const tx = a.al === "c" ? at[0] + w / 2 : a.al === "r" ? at[0] + w : at[0];
  lines.forEach((s, i) => out.push({ t: "t", x: tx, y: at[1] - i * h * 1.5, s, h, al: a.al ?? "l", layer: "ANNOT" }));
  let box: [number, number, number, number] = [at[0] - 0.5, at[1] - (lines.length - 1) * h * 1.5 - 0.3 * h, at[0] + w + 0.5, at[1] + h * 1.1];
  // Border (FR-DRW-023): a box, an obround or a circle round the text; the leader then starts on it.
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, cr = Math.hypot(box[2] - box[0], box[3] - box[1]) / 2 + 0.3;
  const fr: [number, number, number, number] = [box[0] - 0.6, box[1] - 0.4, box[2] + 0.6, box[3] + 0.2];
  // The round ends of an obround stand out of the frame box on its short sides.
  if (a.border === "round") { const fw = fr[2] - fr[0], fh = fr[3] - fr[1]; if (fw >= fh) { fr[0] -= fh / 2; fr[2] += fh / 2; } else { fr[1] -= fw / 2; fr[3] += fw / 2; } }
  if (a.border === "box") out.push(thin([fr[0], fr[1]], [fr[2], fr[1]]), thin([fr[2], fr[1]], [fr[2], fr[3]]), thin([fr[2], fr[3]], [fr[0], fr[3]]), thin([fr[0], fr[3]], [fr[0], fr[1]]));
  else if (a.border === "round") out.push(...obround(box));
  else if (a.border === "circle") out.push({ t: "a", o: [cx, cy], r: cr, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
  if (leaderTo) {
    let start: P2 = [leaderTo[0] < at[0] ? at[0] - 1 : at[0] + w + 1, at[1] + h * 0.35];
    if (a.border === "circle") { const d = unit2([leaderTo[0] - cx, leaderTo[1] - cy], [1, 0]); start = [cx + d[0] * cr, cy + d[1] * cr]; }
    else if (a.border === "box" || a.border === "round") start = [leaderTo[0] < at[0] ? fr[0] : fr[2], (fr[1] + fr[3]) / 2];
    // A bent leader leaves the text along a horizontal shoulder (not from a circle, which it leaves radially).
    if (a.bent && a.border !== "circle") {
      const left = leaderTo[0] < at[0], knee: P2 = [start[0] + (left ? -NOTE_SHOULDER : NOTE_SHOULDER), start[1]];
      out.push(thin(start, knee)); start = knee;
    }
    const u = unit2([leaderTo[0] - start[0], leaderTo[1] - start[1]]);
    out.push(thin(start, leaderTo));
    if (a.end === "dot") { const r = 0.6, p: number[] = []; for (let i = 0; i < 12; i++) p.push(leaderTo[0] + r * Math.cos(i * Math.PI / 6), leaderTo[1] + r * Math.sin(i * Math.PI / 6)); out.push({ t: "p", p, pen: "thin", layer: "ANNOT", closed: true, fill: true }); }
    else if (a.end !== "none") out.push(arrow(leaderTo[0], leaderTo[1], u[0], u[1]));
  }
  if (a.border === "circle") box = [cx - cr, cy - cr, cx + cr, cy + cr];
  else if (a.border) box = fr;
  return { prims: out, box };
}

// ---------- property links in notes (FR-DRW-023) ----------

/** The drawing's properties that notes link to with $PRP:"name" (set from the title block fields before composing). */
let NOTE_PROPS: Record<string, string> = {};
/** SolidWorks property names that mean one of our fields. */
const PROP_ALIAS: Record<string, string> = { description: "title", partno: "number", partnumber: "number", weight: "mass", drawnby: "author", swsheetscale: "scale", sheetscale: "scale", sheetformatsize: "size", swsheetformatsize: "size" };

export function useProps(fields: Record<string, string | undefined>) {
  NOTE_PROPS = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === "string") NOTE_PROPS[k.toLowerCase()] = v;
}

/** $PRP:"Material" (or $PRPSHEET:"…") → the property's value; an unknown name stays as typed so it can be seen and fixed. */
export function expandProps(text: string, props: Record<string, string> = NOTE_PROPS): string {
  return text.replace(/\$PRP(?:SHEET)?:"([^"]*)"/g, (m, name: string) => {
    const k = name.toLowerCase().replace(/[^a-z0-9]/g, ""), v = props[PROP_ALIAS[k] ?? k];
    return v ?? m;
  });
}

// ---------- hole table (FR-DRW-024) ----------

/** The hole table's columns: English keys, translated when drawn. */
export const HOLE_COLS = ["Tag", "X LOC", "Y LOC", "Size"];

/** Whether a circle edge is seen end-on along the view normal `n`. */
export const endOnCircle = (e: MEdge, n: V3) => e.t === "c" && !!e.ax && !!e.c && !!e.r && Math.abs(Math.abs(dot3(e.ax, n)) - 1) < 1e-6;

/**
 * The holes a view shows end-on: full circles, one per centre and radius (a through hole's two rims are one hole).
 * With the geometry's hole stacks known (a modelled or imported solid), only circles on a hole count, one per hole (its
 * drill, the smallest circle): a boss's rim or a chamfer's circle is no hole, and a counterbore is not a second hole (drawings exam #5).
 */
export function holeEdges(topo: Topo | null, P: (p: V3) => P2, n: V3, keep: (c: P2) => boolean = () => true): MEdge[] {
  const out: MEdge[] = [], seen: [P2, number][] = [];
  const stacks = topo?.holes ?? (topo?.cyls.length ? [] : null), slot = new Map<MHole, number>();
  for (const e of topo?.edges ?? []) {
    if (!endOnCircle(e, n) || (e.sp ?? 2 * Math.PI) < 2 * Math.PI - 1e-3) continue;
    const c = P(e.c!);
    if (!keep(c)) continue;
    if (stacks) {
      const h = stacks.length ? stackAt(e.c!, e.ax!, e.r!, topo) : null;
      if (!h) continue;
      const i = slot.get(h);
      if (i === undefined) { slot.set(h, out.length); out.push(e); } else if (e.r! < out[i].r! - 1e-6) out[i] = e;
      continue;
    }
    if (seen.some(([q, r]) => d2(q, c) < 1e-4 && Math.abs(r - e.r!) < 1e-6)) continue;
    seen.push([c, e.r!]); out.push(e);
  }
  return out;
}

/** The rows of a hole table and where its tags go: sizes get letters A, B, … from the smallest, holes in a size are numbered by X then Y. */
export function holeRows(a: HoleTableAnnot, P: (p: V3) => P2, ctx: AnnotCtx): { rows: string[][]; tags: { tag: string; c: P2; r: number }[]; o: P2 | null; missing: boolean } {
  const op = refPoint(a.origin, ctx.topo), o = op ? P(op) : null;
  let missing = !o;
  const hs: { c: P2; r: number; size: string }[] = [];
  for (const ref of a.holes) {
    const e = refEdge(ref, ctx.topo);
    if (!e || e.t !== "c" || !e.c || !e.r) { missing = true; continue; }
    hs.push({ c: P(e.c), r: e.r, size: holeText(e, ctx, false).join(" ") });
  }
  const o0 = o ?? [0, 0];
  const sizes = [...new Map(hs.map(h => [h.size, h.r])).entries()].sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).map(([s]) => s);
  hs.sort((x, y) => sizes.indexOf(x.size) - sizes.indexOf(y.size) || x.c[0] - y.c[0] || x.c[1] - y.c[1]);
  const count = new Map<string, number>(), f = (v: number) => fmtNum(v, a.prec, ctx.dec);
  const rows: string[][] = [], tags: { tag: string; c: P2; r: number }[] = [];
  for (const h of hs) {
    const k = (count.get(h.size) ?? 0) + 1;
    count.set(h.size, k);
    const i = sizes.indexOf(h.size), tag = (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`) + k;
    rows.push([tag, f(h.c[0] - o0[0]), f(h.c[1] - o0[1]), h.size]);
    tags.push({ tag, c: h.c, r: h.r });
  }
  return { rows, tags, o, missing };
}

/** A hole table: the table at `pos`, a tag beside each hole and X/Y arrows at the origin. */
function holeTablePrims(a: HoleTableAnnot, P: (p: V3) => P2, pl: Placement, ctx: AnnotCtx): { prims: Prim[]; box: [number, number, number, number]; missing: boolean } {
  const hr = holeRows(a, P, ctx), h = 2.5;
  const tp = tablePrims({ id: a.id, t: "table", kind: "general", pos: toSheet(pl, a.pos[0], a.pos[1]), cols: HOLE_COLS, rows: hr.rows }, ctx.label);
  const out = tp.prims;
  for (const tg of hr.tags) {
    const C = toSheet(pl, tg.c[0], tg.c[1]), k = tg.r * pl.s * Math.SQRT1_2 + 0.6;
    out.push({ t: "t", x: C[0] + k, y: C[1] + k, s: tg.tag, h, al: "l", layer: "ANNOT" });
  }
  if (hr.o) {
    const O = toSheet(pl, hr.o[0], hr.o[1]), L = 10;
    out.push(thin(O, [O[0] + L, O[1]]), arrow(O[0] + L, O[1], 1, 0), thin(O, [O[0], O[1] + L]), arrow(O[0], O[1] + L, 0, 1));
    out.push({ t: "t", x: O[0] + L + 1, y: O[1] - h / 2, s: "X", h, al: "l", layer: "ANNOT" }, { t: "t", x: O[0], y: O[1] + L + 1, s: "Y", h, al: "c", layer: "ANNOT" });
  }
  return { prims: out, box: tp.box, missing: hr.missing };
}

/** Everything annotated on one view: its dimensions, callouts and notes, plus the automatic centre marks. */
/** The model facts annotations draw on (topology, holes, threads, sketches, model items, box). */
export function factsCtx(f: { topo: Topo; holes: HoleInfo[]; threads?: ThreadInfo[]; sketches?: SketchInfo[]; bends?: FlatBend[]; welds?: WeldInfo[]; cuts?: CutInfo[]; cutFaces?: Record<string, number>; weldFaces?: Record<string, number>; items: ModelItem[]; box: [V3, V3] } | null): Pick<AnnotCtx, "topo" | "holes" | "threads" | "sketches" | "bends" | "welds" | "cuts" | "cutFaces" | "weldFaces" | "items" | "box"> {
  return { topo: f?.topo ?? null, holes: f?.holes ?? [], threads: f?.threads ?? [], sketches: f?.sketches ?? [], bends: f?.bends ?? [], welds: f?.welds ?? [], cuts: f?.cuts ?? [], cutFaces: f?.cutFaces ?? {}, weldFaces: f?.weldFaces ?? {}, items: f?.items ?? [], box: f?.box ?? null };
}

/** A section view's facts (FR-DRW-021): the model's plus the cut faces' edges from its projection, so the section can be dimensioned. */
export function withCut<T extends { topo: Topo }>(f: T | null, proj?: { cutEdges?: MEdge[] } | null): T | null {
  return f && proj?.cutEdges?.length ? { ...f, topo: { ...f.topo, edges: [...f.topo.edges, ...proj.cutEdges] } } : f;
}

/**
 * A plain section's centre marks and centrelines leave out what the cut took away: circles, cylinders and spheres wholly
 * on the viewer's side of the cutting plane (drawings exam #4: a cut beside the boss still drew its axis). Offset, half,
 * aligned and broken-out sections keep everything.
 */
export function cutAway(sheet: Sheet, v: DrawingView, topo: Topo): Topo {
  let rq: ReturnType<typeof viewReq>;
  try { rq = viewReq(sheet, v); } catch { return topo; }
  if (!rq.p || rq.stair || rq.align || rq.poly) return topo;
  const n = rq.view.dir, d = dot3(rq.p, n), side = (q: V3) => dot3(q, n) - d, eps = 1e-6;
  const gone = (o: V3, r: number) => side(o) - r > -eps;
  return {
    ...topo,
    edges: topo.edges.filter(e => !(side(e.a) > eps && side(e.b) > eps && side(e.m) > eps)),
    cyls: topo.cyls.filter(c => Math.abs(dot3(c.ax, n)) > 1e-6 || !gone(c.o, c.r)),
    ...(topo.revs ? { revs: topo.revs.filter(q => !q.r || Math.abs(dot3(q.ax, n)) > 1e-6 && q.k !== "sphere" || !gone(q.o, q.r)) } : {}),
  };
}

export function viewAnnots(sheet: Sheet, v: DrawingView, pl: Placement, ctx: AnnotCtx): AnnotOut {
  const own = ctx.forView?.(v);
  if (own) ctx = { ...ctx, ...own, forView: undefined };
  const only = viewOnly(sheet, v);
  if (only && ctx.topo) ctx = { ...ctx, topo: topoOnly(ctx.topo, only) };
  const out: AnnotOut = { prims: [], hits: [], dangling: [] };
  const vd = viewDir(sheet, v), { P, n } = projector(vd);
  if (v.marks !== false && ctx.topo) out.prims.push(...centreMarks(v, pl, v.kind === "section" ? cutAway(sheet, v, ctx.topo) : ctx.topo, P, n));
  if (v.threads !== false && ctx.threads?.length) out.prims.push(...threadPrims(v, pl, ctx.threads, ctx.topo, P, n));
  if (v.sketches && ctx.sketches?.length) out.prims.push(...sketchPrims(v, pl, ctx.sketches, P));
  const btable = (sheet.annots ?? []).some(a => a.t === "btable" && a.view === v.id);
  if (v.bendLines !== false && ctx.bends?.length) out.prims.push(...bendPrims(v, pl, ctx.bends, P, ctx, btable));
  if (v.com && ctx.topo?.com) out.prims.push(...comPrims(toSheet(pl, ...P(ctx.topo.com))));
  for (const a of sheet.annots ?? []) {
    if (a.view !== v.id) continue;
    let r: { prims: Prim[]; box: [number, number, number, number] } | null = null;
    if (a.t === "dim") {
      // A model item measures the part as it is now.
      const it = a.src ? ctx.items.find(i => i.src === a.src) : undefined;
      const g = dimGeo(it ? { ...a, refs: [{ pt: it.p[0] }, { pt: it.p[1] }] } : a, P, ctx.topo);
      if (g) r = dimPrims(a, g, pl, ctx.dec);
      else { const T = toSheet(pl, a.pos[0], a.pos[1]); r = { prims: [{ t: "t", x: T[0], y: T[1], s: "?", h: TEXT_H, al: "c", layer: "ANNOT" }], box: textBox(T[0], T[1], "?", TEXT_H, "c") }; out.dangling.push(a.id); }
    } else if (a.t === "hole") {
      const e = refEdge(a.ref, ctx.topo);
      if (e && e.t === "c") r = holePrims(a, e, P, pl, ctx);
      else { const T = toSheet(pl, a.pos[0], a.pos[1]); r = { prims: [{ t: "t", x: T[0], y: T[1], s: "?", h: TEXT_H, al: "c", layer: "ANNOT" }], box: textBox(T[0], T[1], "?", TEXT_H, "c") }; out.dangling.push(a.id); }
    } else if (a.t === "note") {
      const pt = a.leader ? refPoint(a.leader, ctx.topo) : null;
      r = notePrims(a, toSheet(pl, a.pos[0], a.pos[1]), pt ? toSheet(pl, ...P(pt)) : null);
    } else if (a.t === "weld") {
      const f = a.leader ? edgeFoot(a.leader, ctx.topo, P, pl, toSheet(pl, a.pos[0], a.pos[1])) : null;
      r = weldPrims(a, toSheet(pl, a.pos[0], a.pos[1]), f?.at ?? null);
      if (a.leader && !f) out.dangling.push(a.id);
    } else if (a.t === "dtarget") {
      const at = toSheet(pl, a.pos[0], a.pos[1]), f = a.leader ? edgeFoot(a.leader, ctx.topo, P, pl, a.tp ? toSheet(pl, a.tp[0], a.tp[1]) : at) : null;
      r = dtargetPrims(a, at, f?.at ?? null, f?.d ?? [1, 0], pl.s);
      if (a.leader && !f) out.dangling.push(a.id);
    } else if (a.t === "gtol") {
      const pt = a.leader ? refPoint(a.leader, ctx.topo) : null;
      r = gtolPrims(a, toSheet(pl, a.pos[0], a.pos[1]), pt ? toSheet(pl, ...P(pt)) : null, ctx.dec);
    } else if (a.t === "datum") {
      const f = edgeFoot(a.ref, ctx.topo, P, pl, toSheet(pl, a.pos[0], a.pos[1]));
      r = datumPrims(a, f?.at ?? null, f?.d ?? [1, 0], toSheet(pl, a.pos[0], a.pos[1]));
      if (!f) out.dangling.push(a.id);
    } else if (a.t === "balloon") {
      // The tip stays on the edge's middle; the number is the component's item in the BOM (assembly) or the
      // body's item in the cut list (weldment part).
      // A weld tag numbers the bead's row in the weld table.
      const e = refEdge(a.ref, ctx.topo), item = "e" in a.ref ? (a.weld ? weldItem(a.ref.e, ctx) : edgeItem(a.ref.e, ctx)) : null;
      const more = (a.stack ?? []).map(sc => String(stackItem(sc, ctx) ?? "?"));
      const qty = (n: number | null) => !n ? "" : a.weld ? String(ctx.welds?.[n - 1]?.qty ?? "") : ctx.bom ? String(ctx.bom.rows.find(x => x.item === n)?.qty ?? "") : String(ctx.cuts?.find(x => x.item === n)?.qty ?? "");
      r = balloonPrims(toSheet(pl, a.pos[0], a.pos[1]), e ? toSheet(pl, ...P(e.m)) : null, a.txt || (item ? String(item) : "?"), more, { shape: a.shape, lower: a.shape === "split" ? [item, ...(a.stack ?? []).map(k => stackItem(k, ctx))].map(qty) : undefined });
      if (!e || (!a.txt && !item)) out.dangling.push(a.id);
    } else if (a.t === "btable") {
      const bends = ctx.bends ?? [];
      r = tablePrims({ id: a.id, t: "table", kind: "general", pos: toSheet(pl, a.pos[0], a.pos[1]), cols: BEND_COLS, rows: bendRows(a, bends, P, ctx) }, ctx.label);
      if (!bends.length) out.dangling.push(a.id);
    } else if (a.t === "wtable") {
      const welds = ctx.welds ?? [];
      r = tablePrims({ id: a.id, t: "table", kind: "general", pos: toSheet(pl, a.pos[0], a.pos[1]), cols: WELD_COLS, rows: weldRows(a, welds, ctx) }, ctx.label);
      if (!welds.length) out.dangling.push(a.id);
    } else if (a.t === "ctable") {
      const cuts = ctx.cuts ?? [];
      r = tablePrims({ id: a.id, t: "table", kind: "general", pos: toSheet(pl, a.pos[0], a.pos[1]), cols: cutCols(a), rows: cutRows(a, cuts, ctx) }, ctx.label);
      if (!cuts.length) out.dangling.push(a.id);
    } else if (a.t === "htable") {
      const ht = holeTablePrims(a, P, pl, ctx);
      r = ht;
      if (ht.missing) out.dangling.push(a.id);
    } else if (a.t === "cline") {
      const g = clineSegs(a, P, ctx.topo, pl);
      if (g) {
        for (const q of g) out.prims.push({ t: "l", p: q, pen: "center", layer: "CENTER" });
        const ring = g.length === 1 ? g[0] : [g[0][0], g[0][1], g[0][2], g[0][3], (g[0][0] + g[0][2]) / 2, (g[0][1] + g[0][3]) / 2, g[1][0], g[1][1], g[1][2], g[1][3], (g[1][0] + g[1][2]) / 2, (g[1][1] + g[1][3]) / 2];
        const xs = g.flatMap(q => [q[0], q[2]]), ys = g.flatMap(q => [q[1], q[3]]);
        out.hits.push({ id: a.id, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], ring, band: 1.5 });
      } else {
        const e = a.refs[0] && refPoint(a.refs[0], ctx.topo), T = e ? toSheet(pl, ...P(e)) : toSheet(pl, 0, 0);
        out.prims.push({ t: "t", x: T[0], y: T[1], s: "?", h: TEXT_H, al: "c", layer: "ANNOT" });
        out.hits.push({ id: a.id, box: textBox(T[0], T[1], "?", TEXT_H, "c") });
        out.dangling.push(a.id);
      }
    } else if (a.t === "surf") {
      const T = toSheet(pl, a.pos[0], a.pos[1]);
      const f = a.ref ? edgeFoot(a.ref, ctx.topo, P, pl, T) : null;
      r = surfOn(a, T, f, ctx.dec);
      if (a.ref && !f) out.dangling.push(a.id);
    }
    if (r) { out.prims.push(...r.prims); out.hits.push({ id: a.id, box: r.box }); }
  }
  return out;
}

/**
 * A hand-placed centreline or centre mark as sheet segments, or null when its edges are gone (or no longer fit:
 * the lines stopped being parallel, the edge is not round and end-on).
 * Line: two straight edges → the line halfway between them over the length both cover together; else the line through
 * the two points (a circle's centre, an edge end). It runs `ext` sheet mm past either end.
 */
export function clineSegs(a: CLineAnnot, P: (p: V3) => P2, topo: Topo | null, pl: Placement): [number, number, number, number][] | null {
  const ext = (a.ext ?? 2) / pl.s;
  const S = (q: P2): P2 => toSheet(pl, q[0], q[1]);
  if (a.k === "mark") {
    const e = a.refs[0] ? refEdge(a.refs[0], topo) : null;
    if (!e || e.t !== "c" || !e.c || !e.r) return null;
    const c = P(e.c), m = P(e.m);
    if (Math.abs(d2(c, m) - e.r) > e.r * 1e-3 + 1e-6) return null; // not seen end-on
    const L = e.r + ext, l = S([c[0] - L, c[1]]), r = S([c[0] + L, c[1]]), b = S([c[0], c[1] - L]), u = S([c[0], c[1] + L]);
    return [[l[0], l[1], r[0], r[1]], [b[0], b[1], u[0], u[1]]];
  }
  if (a.refs.length < 2) return null;
  const e0 = refEdge(a.refs[0], topo), e1 = refEdge(a.refs[1], topo);
  const isLine = (r: GeoRef, e: MEdge | null): e is MEdge => !!e && "p" in r && r.p === "e" && e.t === "l";
  let A: P2, B: P2;
  if (isLine(a.refs[0], e0) && isLine(a.refs[1], e1)) {
    const a0 = P(e0.a), b0 = P(e0.b), a1 = P(e1.a), b1 = P(e1.b);
    if (d2(a0, b0) < 1e-9 || d2(a1, b1) < 1e-9) return null;
    const d = unit2([b0[0] - a0[0], b0[1] - a0[1]]), w = unit2([b1[0] - a1[0], b1[1] - a1[1]]);
    if (Math.abs(d[0] * w[1] - d[1] * w[0]) > 1e-4) return null;
    const nrm: P2 = [-d[1], d[0]], off = (q: P2) => q[0] * nrm[0] + q[1] * nrm[1], tt = (q: P2) => q[0] * d[0] + q[1] * d[1];
    const o = (off(a0) + off(a1)) / 2;
    if (Math.abs(off(a0) - off(a1)) < 1e-9) return null; // the same line
    const ts = [a0, b0, a1, b1].map(tt), t0 = Math.min(...ts) - ext, t1 = Math.max(...ts) + ext;
    A = [d[0] * t0 + nrm[0] * o, d[1] * t0 + nrm[1] * o]; B = [d[0] * t1 + nrm[0] * o, d[1] * t1 + nrm[1] * o];
  } else {
    const p0 = refPoint(a.refs[0], topo), p1 = refPoint(a.refs[1], topo);
    if (!p0 || !p1) return null;
    const q0 = P(p0), q1 = P(p1);
    if (d2(q0, q1) < 1e-9) return null;
    const d = unit2([q1[0] - q0[0], q1[1] - q0[1]]);
    A = add2(q0, d, -ext); B = add2(q1, d, ext);
  }
  const sa = S(A), sb = S(B);
  return [[sa[0], sa[1], sb[0], sb[1]]];
}

/** The point of a referenced edge nearest to `T` on the sheet, and the edge's direction there. */
export function edgeFoot(ref: GeoRef, topo: Topo | null, P: (p: V3) => P2, pl: Placement, T: P2): { at: P2; d: P2 } | null {
  const e = refEdge(ref, topo);
  if (!e) { if ("pt" in ref) { const p = toSheet(pl, ...P(refPoint(ref, topo)!)); return { at: p, d: [1, 0] }; } return null; }
  const A = toSheet(pl, ...P(e.a)), B = toSheet(pl, ...P(e.b));
  if (e.t === "l" && d2(A, B) > 1e-6) {
    const d = unit2([B[0] - A[0], B[1] - A[1]]), k = Math.max(0, Math.min(d2(A, B), (T[0] - A[0]) * d[0] + (T[1] - A[1]) * d[1]));
    return { at: add2(A, d, k), d };
  }
  if (e.t === "c" && e.c && e.r) {
    // A circle seen end-on: the point towards T; seen edge-on it projects to a line through A and B.
    const C = toSheet(pl, ...P(e.c)), m = toSheet(pl, ...P(e.m));
    if (d2(C, m) > e.r * pl.s * 0.5) { const u = unit2([T[0] - C[0], T[1] - C[1]]); return { at: add2(C, u, e.r * pl.s), d: [-u[1], u[0]] }; }
  }
  const M = toSheet(pl, ...P(e.m));
  return { at: M, d: unit2([B[0] - A[0], B[1] - A[1]]) };
}

/** A surface finish symbol: on the edge when `pos` is close to it, else at `pos` with a leader to the edge. */
function surfOn(a: SurfAnnot, T: P2, f: { at: P2; d: P2 } | null, dec: string): { prims: Prim[]; box: [number, number, number, number] } {
  if (!f) return surfPrims(a, T, dec);
  if (d2(f.at, T) < 2) {
    // On the edge (ISO 1302): stood on it, readable from the bottom or the right of the sheet.
    let ang = Math.atan2(f.d[1], f.d[0]);
    while (ang > Math.PI / 2 + 1e-9) ang -= Math.PI;
    while (ang <= -Math.PI / 2 + 1e-9) ang += Math.PI;
    if (Math.abs(ang) < 1e-6) ang = 0;
    const r = surfPrims(a, f.at, dec);
    return { prims: rotatePrims(r.prims, f.at, ang), box: rotateBox(r.box, f.at, ang) };
  }
  const r = surfPrims(a, T, dec), u = unit2([f.at[0] - T[0], f.at[1] - T[1]]);
  r.prims.push(thin(T, f.at), arrow(f.at[0], f.at[1], u[0], u[1]));
  return r;
}

/** Notes, free tolerance frames, surface symbols and tables on the sheet itself (not on a view). */
/**
 * A revision cloud: each side of the polygon (wound counter-clockwise) split into equal chords no longer than `arc`,
 * each chord a half circle bulging outwards; with `rev`, the revision letter in a triangle at the first corner.
 */
export function cloudPrims(a: CloudAnnot): { prims: Prim[]; box: [number, number, number, number] } {
  const n = Math.floor(a.pts.length / 2), [ox, oy] = a.pos;
  let pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([ox + a.pts[2 * i], oy + a.pts[2 * i + 1]]);
  let area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  if (area < 0) pts = pts.reverse();
  const arc = Math.max(1, a.arc ?? 6), prims: Prim[] = [];
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const k = Math.max(1, Math.ceil(L / arc)), th = Math.atan2(q[1] - p[1], q[0] - p[0]), r = L / k / 2;
    for (let j = 0; j < k; j++) {
      const o: [number, number] = [p[0] + (q[0] - p[0]) * (j + 0.5) / k, p[1] + (q[1] - p[1]) * (j + 0.5) / k];
      prims.push({ t: "a", o, r, a0: th + Math.PI, a1: th + 2 * Math.PI, pen: "thin", layer: "ANNOT" });
      box = [Math.min(box[0], o[0] - r), Math.min(box[1], o[1] - r), Math.max(box[2], o[0] + r), Math.max(box[3], o[1] + r)];
    }
  }
  if (a.rev && n) {
    const [x, y] = a.pos.map((c, i) => c + a.pts[i]) as [number, number], s = TEXT_H * 2.2;
    const c: [number, number] = [x - s * 0.7, y + s * 0.7];
    prims.push({ t: "p", p: [c[0] - s / 2, c[1] - s * 0.29, c[0] + s / 2, c[1] - s * 0.29, c[0], c[1] + s * 0.58], closed: true, pen: "thin", layer: "ANNOT" });
    prims.push({ t: "t", x: c[0], y: c[1] - TEXT_H * 0.4, s: a.rev, h: TEXT_H, al: "c", layer: "ANNOT" });
    box = [Math.min(box[0], c[0] - s / 2), Math.min(box[1], c[1] - s * 0.29), Math.max(box[2], c[0] + s / 2), Math.max(box[3], c[1] + s * 0.58)];
  }
  if (!isFinite(box[0])) box = [ox, oy, ox, oy];
  return { prims, box };
}

/** Distance from p to the closed polygon `ring` (x, y pairs). */
export function ringDist(ring: number[], x: number, y: number, open = false): number {
  let d = Infinity;
  const n = Math.floor(ring.length / 2);
  if (n === 1) return Math.hypot(x - ring[0], y - ring[1]);
  for (let i = 0; i < (open ? n - 1 : n); i++) {
    const ax = ring[2 * i], ay = ring[2 * i + 1], bx = ring[(2 * i + 2) % (2 * n)], by = ring[(2 * i + 3) % (2 * n)];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}

export function sheetNotes(sheet: Sheet, label: Label = s => s, dec = ".", bom?: Bom | null): AnnotOut {
  const out: AnnotOut = { prims: [], hits: [], dangling: [] };
  for (const a of sheet.annots ?? []) {
    if (a.view) continue;
    if (a.t === "cloud") {
      const r = cloudPrims(a);
      out.prims.push(...r.prims);
      out.hits.push({ id: a.id, box: r.box, ring: a.pts.map((c, i) => c + a.pos[i % 2]), band: Math.max(1, a.arc ?? 6) });
      continue;
    }
    if (a.t === "sk") {
      const r = skPrims(a);
      out.prims.push(...r.prims);
      out.hits.push({ id: a.id, box: r.box, ring: r.ring, band: 2, open: r.open });
      continue;
    }
    const r = a.t === "weld" ? weldPrims(a, a.pos, null) : a.t === "dtarget" ? dtargetPrims(a, a.pos, null) : a.t === "note" ? notePrims(a, a.pos, null) : a.t === "gtol" ? gtolPrims(a, a.pos, null, dec)
      : a.t === "surf" ? surfPrims(a, a.pos, dec) : a.t === "table" ? tablePrims(a.kind === "bom" ? { ...a, rows: bom ? bomCells(bom) : [] } : a, label) : null;
    if (r) { out.prims.push(...r.prims); out.hits.push({ id: a.id, box: r.box }); }
  }
  return out;
}

/**
 * Centre marks on full circles seen end-on and centrelines along cylinders seen from the side
 * (FR-DRW-023), in the centre line type; detail views clip them to their circle.
 */
export function centreMarks(v: DrawingView, pl: Placement, topo: Topo, P: (p: V3) => P2, n: V3): Prim[] {
  const segs: Seg2[] = [];
  const ext = 2 / pl.s;
  // Circles seen end-on, grouped by their 3D centre and radius (STEP often splits a circle in two arcs; the
  // two 180° ends of a slot's top and bottom faces must not add up to a circle).
  const circ = new Map<string, { c: P2; r: number; sp: number; m: P2 }>();
  for (const e of topo.edges) {
    if (e.t !== "c" || !e.c || !e.ax || !e.r || Math.abs(Math.abs(dot3(e.ax, n)) - 1) > 1e-6) continue;
    const c = P(e.c), key = `${e.c.map(x => x.toFixed(4)).join(",")},${e.r.toFixed(4)}`;
    const g = circ.get(key) ?? { c, r: e.r, sp: 0, m: [0, 0] as P2 };
    const sp = e.sp ?? 0, md = unit2([P(e.m)[0] - c[0], P(e.m)[1] - c[1]]);
    g.sp += sp; g.m = [g.m[0] + md[0] * sp, g.m[1] + md[1] * sp];
    circ.set(key, g);
  }
  const marked = new Map<string, number>();
  const halves: { c: P2; r: number; m: P2 }[] = [], arcs: { c: P2; r: number }[] = [];
  for (const g of circ.values()) {
    if (g.sp < 2 * Math.PI - 1e-3) {
      if (Math.abs(g.sp - Math.PI) < 1e-3 && g.r * pl.s >= 1) halves.push({ c: g.c, r: g.r, m: unit2(g.m) });
      arcs.push({ c: g.c, r: g.r });
      continue;
    }
    const key = `${g.c[0].toFixed(4)},${g.c[1].toFixed(4)}`;
    marked.set(key, Math.max(marked.get(key) ?? 0, g.r));
  }
  // Straight slots seen end-on (FR-DRW-023): two half circles of one radius facing away from each other along the
  // line through their centres get a centreline over the slot and a cross line at each end centre.
  const slotKeys = new Set<string>();
  for (const sl of straightSlots(halves)) {
    const [a, b] = sl.c, d = unit2([b[0] - a[0], b[1] - a[1]]), q: P2 = [-d[1], d[0]], L = sl.r + ext;
    const key = `${a.map(x => x.toFixed(4))}|${b.map(x => x.toFixed(4))}`;
    if (slotKeys.has(key)) continue;
    slotKeys.add(key);
    segs.push({ k: "l", c: 0, p: [a[0] - d[0] * L, a[1] - d[1] * L, b[0] + d[0] * L, b[1] + d[1] * L] });
    for (const c of [a, b]) segs.push({ k: "l", c: 0, p: [c[0] - q[0] * L, c[1] - q[1] * L, c[0] + q[0] * L, c[1] + q[1] * L] });
  }
  // Arc slots seen end-on: a centre-line arc through both end centres, run past the ends, and a radial line
  // across each end (the top and bottom outlines give the same slot twice).
  const used = new Set(straightSlots(halves).flatMap(sl => sl.c.map(c => `${c[0].toFixed(4)},${c[1].toFixed(4)}`)));
  for (const sl of arcSlots(halves.filter(h => !used.has(`${h.c[0].toFixed(4)},${h.c[1].toFixed(4)}`)), arcs)) {
    const key = `${sl.o.map(x => x.toFixed(4))}|${sl.R.toFixed(4)}|${sl.a0.toFixed(5)}`;
    if (slotKeys.has(key)) continue;
    slotKeys.add(key);
    const L = sl.r + ext, a0 = sl.a0 - L / sl.R, a1 = sl.a1 + L / sl.R;
    const n = Math.max(12, Math.ceil((a1 - a0) / (Math.PI / 36))), p: number[] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; p.push(sl.o[0] + sl.R * Math.cos(a), sl.o[1] + sl.R * Math.sin(a)); }
    segs.push({ k: "p", c: 0, p });
    for (const a of [sl.a0, sl.a1]) {
      const d: P2 = [Math.cos(a), Math.sin(a)], c: P2 = [sl.o[0] + sl.R * d[0], sl.o[1] + sl.R * d[1]];
      segs.push({ k: "l", c: 0, p: [c[0] - d[0] * L, c[1] - d[1] * L, c[0] + d[0] * L, c[1] + d[1] * L] });
    }
  }
  const holes = [...marked].filter(([, r]) => r * pl.s >= 1).map(([key, r]) => { const [x, y] = key.split(",").map(Number); return { c: [x, y] as P2, r }; });
  // Hole rows (FR-DRW-023): 3+ holes of one size evenly spaced on a line get one centreline through them, and each
  // hole a short line across it unless a row the other way already crosses it. Rows go first: no three holes of a
  // bolt circle lie on a line.
  const onBolt = new Set<number>();
  if (v.rows !== false) {
    const dirs = new Map<number, P2[]>();
    for (const row of holeLines(holes)) {
      const a = holes[row.members[0]], b = holes[row.members[row.members.length - 1]], d = row.d, L = a.r + ext;
      segs.push({ k: "l", c: 0, p: [a.c[0] - d[0] * L, a.c[1] - d[1] * L, b.c[0] + d[0] * L, b.c[1] + d[1] * L] });
      for (const i of row.members) { onBolt.add(i); dirs.set(i, [...dirs.get(i) ?? [], d]); }
    }
    for (const [i, ds] of dirs) {
      if (ds.length > 1) continue;
      const h = holes[i], q: P2 = [-ds[0][1], ds[0][0]], L = h.r + ext;
      segs.push({ k: "l", c: 0, p: [h.c[0] - q[0] * L, h.c[1] - q[1] * L, h.c[0] + q[0] * L, h.c[1] + q[1] * L] });
    }
  }
  const rest = holes.map((h, i) => ({ h, i })).filter(x => !onBolt.has(x.i));
  if (v.bolts !== false) for (const b0 of boltCircles(rest.map(x => x.h))) {
    const b = { ...b0, members: b0.members.map(k => rest[k].i) };
    // Centre-line circle (or arc over the holes) as a polyline, so crop and break views map it like any point.
    const a0 = b.full ? 0 : b.a0 - (b.r + ext) / b.R, a1 = b.full ? 2 * Math.PI : b.a1 + (b.r + ext) / b.R;
    const n = Math.max(24, Math.ceil((a1 - a0) / (Math.PI / 36))), p: number[] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; p.push(b.o[0] + b.R * Math.cos(a), b.o[1] + b.R * Math.sin(a)); }
    segs.push({ k: "p", c: 0, p });
    for (const i of b.members) {
      onBolt.add(i);
      const h = holes[i], d = unit2([h.c[0] - b.o[0], h.c[1] - b.o[1]]), L = h.r + ext;
      segs.push({ k: "l", c: 0, p: [h.c[0] - d[0] * L, h.c[1] - d[1] * L, h.c[0] + d[0] * L, h.c[1] + d[1] * L] });
    }
    // The pattern centre: a small cross unless a round edge already marks it.
    if (!holes.some(h => Math.hypot(h.c[0] - b.o[0], h.c[1] - b.o[1]) < 1e-3)) {
      const L = 2 * ext;
      segs.push({ k: "l", c: 0, p: [b.o[0] - L, b.o[1], b.o[0] + L, b.o[1]] }, { k: "l", c: 0, p: [b.o[0], b.o[1] - L, b.o[0], b.o[1] + L] });
    }
  }
  holes.forEach((h, i) => {
    if (onBolt.has(i)) return;
    const [cx, cy] = h.c, L = h.r + ext;
    segs.push({ k: "l", c: 0, p: [cx - L, cy, cx + L, cy] }, { k: "l", c: 0, p: [cx, cy - L, cx, cy + L] });
  });
  // Cylinders, cones and tori seen from the side: one centreline per axis over all the faces on it. A cone or torus
  // counts when it goes all round (a taper, a countersink, a groove); a cylinder when its pieces of one radius do.
  const axes = new Map<string, { a: P2; d: P2; t0: number; t1: number; sp: Map<string, number>; half: Map<string, number> }>();
  for (const y of [...topo.cyls, ...(topo.revs ?? []).filter(q => q.k !== "sphere").map(q => ({ ...q, r: NaN, rk: `${q.k}:${q.o.map(x => x.toFixed(4))}` }))] as (MCyl & { rk?: string })[]) {
    if (Math.abs(dot3(y.ax, n)) > 1e-6) continue;
    const a3 = (t: number): V3 => [y.o[0] + y.ax[0] * t, y.o[1] + y.ax[1] * t, y.o[2] + y.ax[2] * t];
    const p0 = P(a3(y.v0)), p1 = P(a3(y.v1));
    let d = unit2([p1[0] - p0[0], p1[1] - p0[1]]);
    if (d[0] < -1e-9 || (Math.abs(d[0]) < 1e-9 && d[1] < 0)) d = [-d[0], -d[1]];
    const off = p0[0] * -d[1] + p0[1] * d[0];
    const key = `${Math.atan2(d[1], d[0]).toFixed(5)},${off.toFixed(4)}`;
    const g = axes.get(key) ?? { a: p0, d, t0: Infinity, t1: -Infinity, sp: new Map(), half: new Map() };
    const t = (p: P2) => (p[0] - g.a[0]) * g.d[0] + (p[1] - g.a[1]) * g.d[1];
    g.t0 = Math.min(g.t0, t(p0), t(p1)); g.t1 = Math.max(g.t1, t(p0), t(p1));
    const rk = y.rk ?? y.r.toFixed(4);
    g.sp.set(rk, (g.sp.get(rk) ?? 0) + y.sp);
    // A slot's end seen from the side: half a cylinder with material outside, keyed by where it sits along the axis.
    if (y.in && !y.rk) { const hk = `${rk}|${Math.min(t(p0), t(p1)).toFixed(3)}`; g.half.set(hk, (g.half.get(hk) ?? 0) + y.sp); }
    axes.set(key, g);
  }
  for (const g of axes.values()) {
    if (![...g.sp.values()].some(s => s >= 2 * Math.PI - 1e-3) && ![...g.half.values()].some(s => Math.abs(s - Math.PI) < 1e-3)) continue;
    const A = add2(g.a, g.d, g.t0 - ext), B = add2(g.a, g.d, g.t1 + ext);
    segs.push({ k: "l", c: 0, p: [A[0], A[1], B[0], B[1]] });
  }
  // Spheres (ball ends) from any side: a centre cross, unless an end-on circle already marks that centre.
  const balls = new Set<string>();
  for (const q of topo.revs ?? []) {
    if (q.k !== "sphere" || !q.r || q.sp < 2 * Math.PI - 1e-3) continue;
    const c = P(q.o), key = `${c[0].toFixed(3)},${c[1].toFixed(3)},${q.r.toFixed(4)}`;
    if (balls.has(key) || [...circ.values()].some(g => g.sp >= 2 * Math.PI - 1e-3 && Math.hypot(g.c[0] - c[0], g.c[1] - c[1]) < 1e-3)) continue;
    balls.add(key);
    const L = q.r + ext;
    segs.push({ k: "l", c: 0, p: [c[0] - L, c[1], c[0] + L, c[1]] }, { k: "l", c: 0, p: [c[0], c[1] - L, c[0], c[1] + L] });
  }
  const kept = v.kind === "detail" && v.c && v.r ? clipToCircle(segs, v.c, v.r) : segs;
  const out: Prim[] = [];
  for (const g of kept) {
    if (g.k === "l") { const a = toSheet(pl, g.p[0], g.p[1]), b = toSheet(pl, g.p[2], g.p[3]); out.push({ t: "l", p: [a[0], a[1], b[0], b[1]], pen: "center", layer: "CENTER" }); }
    else if (g.k === "p") { const p: number[] = []; for (let i = 0; i + 1 < g.p.length; i += 2) p.push(...toSheet(pl, g.p[i], g.p[i + 1])); out.push({ t: "p", p, pen: "center", layer: "CENTER" }); }
  }
  return out;
}

/**
 * Straight slots among end-on half circles (sweep π, `m` = unit direction from the centre to the arc's middle):
 * pairs of one radius whose middles point away from each other along the line joining their centres.
 * Returned once per slot as its two end centres, the first with the smaller x (then y).
 */
export function straightSlots(halves: { c: P2; r: number; m: P2 }[]): { c: [P2, P2]; r: number }[] {
  const out: { c: [P2, P2]; r: number }[] = [], used = new Set<number>();
  for (let i = 0; i < halves.length; i++) {
    if (used.has(i)) continue;
    const h = halves[i];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < halves.length; j++) {
      const g = halves[j];
      if (j === i || used.has(j) || Math.abs(g.r - h.r) > 1e-6 * Math.max(1, h.r)) continue;
      const dx = g.c[0] - h.c[0], dy = g.c[1] - h.c[1], D = Math.hypot(dx, dy);
      if (D < 1e-6) continue;
      const u: P2 = [dx / D, dy / D];
      // h opens towards g (its middle points away from g) and g opens towards h.
      if (h.m[0] * u[0] + h.m[1] * u[1] > -0.999 || g.m[0] * u[0] + g.m[1] * u[1] < 0.999) continue;
      if (D < bestD) { bestD = D; best = j; }
    }
    if (best < 0) continue;
    used.add(i); used.add(best);
    const a = h.c, b = halves[best].c;
    out.push({ c: a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] <= b[1]) ? [a, b] : [b, a], r: h.r });
  }
  return out;
}

/**
 * Hole rows among end-on holes (FR-DRW-023): 3+ holes of one radius on a line at equal spacing. `members` are hole
 * indices in order along `d` (unit, pointing +x, or +y when vertical). A hole may be in rows of two directions (a grid)
 * but in one row per direction and two at most; longer rows win, then closer spacing.
 */
export function holeLines(holes: { c: P2; r: number }[]): { members: number[]; d: P2 }[] {
  const found: { members: number[]; d: P2; step: number }[] = [], seen = new Set<string>();
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
    const a = holes[i], b = holes[j], rt = 1e-6 * Math.max(1, a.r);
    if (Math.abs(a.r - b.r) > rt) continue;
    let d = unit2([b.c[0] - a.c[0], b.c[1] - a.c[1]]);
    if (d[0] < -1e-9 || (Math.abs(d[0]) <= 1e-9 && d[1] < 0)) d = [-d[0], -d[1]];
    const tol = 1e-4 * Math.max(1, Math.hypot(b.c[0] - a.c[0], b.c[1] - a.c[1]));
    const on = holes.map((h, k) => ({ k, t: (h.c[0] - a.c[0]) * d[0] + (h.c[1] - a.c[1]) * d[1], o: (h.c[0] - a.c[0]) * -d[1] + (h.c[1] - a.c[1]) * d[0], r: h.r }))
      .filter(h => Math.abs(h.o) < tol && Math.abs(h.r - a.r) <= rt).sort((x, y) => x.t - y.t);
    if (on.length < 3) continue;
    // Only neighbours along the line set a spacing; the run grows both ways while the gaps stay equal to it.
    const pi = on.findIndex(h => h.k === i), pj = on.findIndex(h => h.k === j);
    if (Math.abs(pi - pj) !== 1) continue;
    const g = on.slice(1).map((h, k) => h.t - on[k].t), step = Math.abs(on[pj].t - on[pi].t);
    if (step < tol) continue;
    let s0 = Math.min(pi, pj), s1 = Math.max(pi, pj);
    while (s0 > 0 && Math.abs(g[s0 - 1] - step) < tol) s0--;
    while (s1 < on.length - 1 && Math.abs(g[s1] - step) < tol) s1++;
    const run = on.slice(s0, s1 + 1).map(h => h.k);
    if (run.length < 3) continue;
    const key = run.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ members: run, d, step });
  }
  found.sort((x, y) => y.members.length - x.members.length || x.step - y.step);
  const used = new Map<number, P2[]>(), out: { members: number[]; d: P2 }[] = [];
  for (const r of found) {
    // One row per direction and at most two per hole, so a grid's diagonals stay unmarked.
    if (r.members.some(k => { const u = used.get(k) ?? []; return u.length >= 2 || u.some(e => Math.abs(e[0] * r.d[1] - e[1] * r.d[0]) < 1e-6); })) continue;
    out.push({ members: r.members, d: r.d });
    for (const k of r.members) used.set(k, [...used.get(k) ?? [], r.d]);
  }
  return out;
}

export interface ArcSlot { o: P2; R: number; r: number; a0: number; a1: number }

/**
 * Arc slots among end-on half circles (see `straightSlots`): two half circles of one radius r whose diameters lie
 * on lines through one centre O, at one distance R from it, bulging away from each other along the circle, with a
 * concentric arc of radius R + r or R - r among `arcs` (so two loose half-round notches don't pair up).
 * `a0`..`a1` (radians, ccw, a1 > a0) runs from one end centre to the other through the slot.
 */
export function arcSlots(halves: { c: P2; r: number; m: P2 }[], arcs: { c: P2; r: number }[]): ArcSlot[] {
  const out: ArcSlot[] = [], used = new Set<number>();
  for (let i = 0; i < halves.length; i++) {
    if (used.has(i)) continue;
    const h = halves[i];
    let best: ArcSlot | null = null, bj = -1;
    for (let j = 0; j < halves.length; j++) {
      const g = halves[j];
      if (j === i || used.has(j) || Math.abs(g.r - h.r) > 1e-6 * Math.max(1, h.r)) continue;
      // Each diameter line passes through O: h.c + s·q_h, q = m turned by 90°.
      const qh: P2 = [-h.m[1], h.m[0]], qg: P2 = [-g.m[1], g.m[0]];
      const den = qh[0] * qg[1] - qh[1] * qg[0], dx = g.c[0] - h.c[0], dy = g.c[1] - h.c[1];
      let o: P2;
      if (Math.abs(den) >= 1e-6) { const s = (dx * qg[1] - dy * qg[0]) / den; o = [h.c[0] + qh[0] * s, h.c[1] + qh[1] * s]; }
      // One diameter line through both ends (a half-turn slot): O is midway; parallel apart = a straight slot.
      else if (Math.abs(dx * qh[1] - dy * qh[0]) < 1e-6 * Math.max(1, Math.hypot(dx, dy))) o = [h.c[0] + dx / 2, h.c[1] + dy / 2];
      else continue;
      const Rh = Math.hypot(h.c[0] - o[0], h.c[1] - o[1]), Rg = Math.hypot(g.c[0] - o[0], g.c[1] - o[1]), tol = 1e-4 * Math.max(1, Rh);
      if (Math.abs(Rh - Rg) > tol || Rh <= h.r + tol) continue;
      const th = Math.atan2(h.c[1] - o[1], h.c[0] - o[0]), tg = Math.atan2(g.c[1] - o[1], g.c[0] - o[0]);
      // The slot runs ccw from the end whose middle points clockwise to the end whose middle points ccw.
      const cw = (t: number, m: P2) => m[0] * Math.sin(t) - m[1] * Math.cos(t) > 0.999;
      const ccw = (t: number, m: P2) => -m[0] * Math.sin(t) + m[1] * Math.cos(t) > 0.999;
      let a0: number, a1: number;
      if (cw(th, h.m) && ccw(tg, g.m)) { a0 = th; a1 = tg; }
      else if (cw(tg, g.m) && ccw(th, h.m)) { a0 = tg; a1 = th; }
      else continue;
      while (a1 <= a0) a1 += 2 * Math.PI;
      const R = (Rh + Rg) / 2;
      if (!arcs.some(a => Math.hypot(a.c[0] - o[0], a.c[1] - o[1]) < tol && (Math.abs(a.r - (R + h.r)) < tol || Math.abs(a.r - (R - h.r)) < tol))) continue;
      if (!best || a1 - a0 < best.a1 - best.a0) { best = { o, R, r: h.r, a0, a1 }; bj = j; }
    }
    if (!best) continue;
    used.add(i); used.add(bj);
    out.push(best);
  }
  return out;
}

export interface BoltCircle { o: P2; R: number; r: number; members: number[]; full: boolean; a0: number; a1: number }

/**
 * Bolt circles among end-on holes (FR-DRW-023): 3+ holes of one radius on a common circle whose angular gaps are
 * whole multiples of the smallest one (a full or partial circular pattern; a square counts, an oblong rectangle does not).
 * Biggest patterns first, each hole in one. `a0`..`a1` (radians, ccw) spans the holes of a partial pattern.
 */
export function boltCircles(holes: { c: P2; r: number }[]): BoltCircle[] {
  const byR = new Map<string, number[]>();
  holes.forEach((h, i) => { const k = h.r.toFixed(4); byR.set(k, [...(byR.get(k) ?? []), i]); });
  const out: BoltCircle[] = [];
  for (const ids of byR.values()) {
    if (ids.length < 3 || ids.length > 40) continue;
    const cands = new Map<string, BoltCircle>();
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) for (let c = b + 1; c < ids.length; c++) {
      const o = circumcentre(holes[ids[a]].c, holes[ids[b]].c, holes[ids[c]].c);
      if (!o) continue;
      const R = Math.hypot(holes[ids[a]].c[0] - o[0], holes[ids[a]].c[1] - o[1]), tol = 1e-3 * Math.max(1, R);
      if (R < 2 * holes[ids[a]].r) continue;
      const key = `${o[0].toFixed(2)},${o[1].toFixed(2)},${R.toFixed(2)}`;
      if (cands.has(key)) continue;
      const members = ids.filter(i => Math.abs(Math.hypot(holes[i].c[0] - o[0], holes[i].c[1] - o[1]) - R) < tol);
      const ang = members.map(i => { const x = Math.atan2(holes[i].c[1] - o[1], holes[i].c[0] - o[0]); return x < 0 ? x + 2 * Math.PI : x; });
      const ord = members.map((_, k) => k).sort((p, q) => ang[p] - ang[q]);
      const gaps = ord.map((k, j) => j + 1 < ord.length ? ang[ord[j + 1]] - ang[k] : ang[ord[0]] + 2 * Math.PI - ang[k]);
      const big = gaps.indexOf(Math.max(...gaps)), g = Math.min(...gaps);
      if (g < 1e-3) continue;
      const even = gaps.every((x, j) => j === big || Math.abs(x / g - Math.round(x / g)) < 0.02);
      if (!even) continue;
      const full = gaps.every(x => Math.abs(x - g) < 0.02 * g);
      const first = ord[(big + 1) % ord.length], last = ord[big];
      let a0 = ang[first], a1 = ang[last];
      if (a1 < a0) a1 += 2 * Math.PI;
      cands.set(key, { o, R, r: holes[ids[a]].r, members: ord.map(k => members[k]), full, a0, a1 });
    }
    const used = new Set<number>();
    for (const b of [...cands.values()].sort((p, q) => q.members.length - p.members.length || q.R - p.R)) {
      if (b.members.some(i => used.has(i))) continue;
      b.members.forEach(i => used.add(i));
      out.push(b);
    }
  }
  return out;
}

function circumcentre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const s = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  if (Math.abs(d) < 1e-6 * s * s) return null;
  const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, C = c[0] ** 2 + c[1] ** 2;
  return [(A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d, (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d];
}

// ---------- cosmetic threads and sketches (FR-DRW-017) ----------

/** Layers drawn on every view by itself (not by an annotation): previews of one annotation leave them out. */
export const AUTO_LAYERS = new Set<string>(["CENTER", "THREAD", "SKETCH"]);

/**
 * Where a thread runs: from its edge's centre `c` along `dir` into the cylinder, for `L` mm. The cylinder
 * is the one on the edge's axis with its radius; the thread goes towards its far end.
 */
export function threadRun(t: ThreadInfo, topo: Topo | null): { c: V3; dir: V3; L: number; R: number } | null {
  const cyl = topo?.cyls.find(y => Math.abs(y.r - t.r) < 1e-4 && Math.abs(Math.abs(dot3(y.ax, t.ax)) - 1) < 1e-6 && (() => { const w = sub3(t.c, y.o), al = dot3(w, y.ax); return Math.hypot(w[0] - y.ax[0] * al, w[1] - y.ax[1] * al, w[2] - y.ax[2] * al) < 1e-3; })());
  if (!cyl) return null;
  const tc = dot3(sub3(t.c, cyl.o), cyl.ax);
  const toEnd = Math.abs(tc - cyl.v0) <= Math.abs(tc - cyl.v1);
  const dir: V3 = toEnd ? cyl.ax : [-cyl.ax[0], -cyl.ax[1], -cyl.ax[2]];
  const full = toEnd ? cyl.v1 - tc : tc - cyl.v0;
  const L = t.L == null ? full : Math.min(t.L, full);
  return L > 1e-6 ? { c: t.c, dir, L, R: t.r } : null;
}

/**
 * ISO 6410-1 cosmetic threads: seen from the side, thin lines at the thread diameter and a thick limit line
 * across; seen end-on, a thin ¾ circle (gap in the upper right quadrant). Internal threads seen from the
 * side lie inside the part, so they are dashed unless the view is a section.
 */
export function threadPrims(v: DrawingView, pl: Placement, threads: ThreadInfo[], topo: Topo | null, P: (p: V3) => P2, n: V3): Prim[] {
  const thinS: Seg2[] = [], hidS: Seg2[] = [], limS: Seg2[] = [], limH: Seg2[] = [];
  for (const t of threads) {
    const run = threadRun(t, topo);
    if (!run) continue;
    const { c, dir, L } = run, r = t.d / 2, R = Math.max(r, run.R);
    const cos = dot3(dir, n);
    const c2 = P(c), e2 = P([c[0] + dir[0] * L, c[1] + dir[1] * L, c[2] + dir[2] * L]);
    if (Math.abs(Math.abs(cos) - 1) < 1e-6) {
      // End-on: the near end is visible when the thread runs away from the viewer.
      (cos < 0 ? thinS : hidS).push({ k: "a", c: 0, o: c2, r, a0: Math.PI / 2, a1: 2 * Math.PI });
    } else if (Math.abs(cos) < 1e-6) {
      const d = unit2([e2[0] - c2[0], e2[1] - c2[1]]), s: P2 = [-d[1], d[0]];
      const hidden = t.internal && v.kind !== "section";
      for (const k of [-1, 1]) (hidden ? hidS : thinS).push({ k: "l", c: 0, p: [c2[0] + s[0] * r * k, c2[1] + s[1] * r * k, e2[0] + s[0] * r * k, e2[1] + s[1] * r * k] });
      (hidden ? limH : limS).push({ k: "l", c: 0, p: [e2[0] - s[0] * R, e2[1] - s[1] * R, e2[0] + s[0] * R, e2[1] + s[1] * R] });
    }
  }
  return [...decorPrims(v, pl, thinS, "thin", "THREAD"), ...decorPrims(v, pl, hidS, "hidden", "THREAD"), ...decorPrims(v, pl, limS, "thick", "THREAD"), ...decorPrims(v, pl, limH, "hidden", "THREAD")];
}

/** The model's shown sketches projected into the view as thin polylines. */
export function sketchPrims(v: DrawingView, pl: Placement, sketches: SketchInfo[], P: (p: V3) => P2): Prim[] {
  const segs: Seg2[] = [];
  for (const sk of sketches) for (const line of sk.lines) {
    const p: number[] = [];
    for (const q of line) p.push(...P(q));
    if (p.length >= 4) segs.push({ k: "p", c: 0, p });
  }
  return decorPrims(v, pl, segs, "thin", "SKETCH");
}

/** Flat pattern bend lines (FR-FT-120): centre lines with a note along each, "UP 90° R2" (SolidWorks' bend notes). */
export function bendPrims(v: DrawingView, pl: Placement, bends: FlatBend[], P: (p: V3) => P2, ctx: AnnotCtx, tagged = false): Prim[] {
  const segs: Seg2[] = bends.map(b => ({ k: "p", c: 0, p: [...P(b.a), ...P(b.b)] }));
  const out = decorPrims(v, pl, segs, "center", "CENTER");
  if (v.bendNotes === false && !tagged) return out;
  const h = TEXT_H * 0.8, tags = tagged ? bendTags(bends, P) : null;
  for (const [i, b] of bends.entries()) {
    const A = toSheet(pl, ...P(b.a)), B = toSheet(pl, ...P(b.b));
    let ang = Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI;
    if (ang > 90.001) ang -= 180; else if (ang <= -90) ang += 180;
    const r = ang * Math.PI / 180, nx = -Math.sin(r), ny = Math.cos(r);
    const deg = Math.round(b.angle * 180 / Math.PI * 100) / 100, rad = Math.round(b.r * 100) / 100;
    const s = tags ? tags[i] : `${ctx.label(b.up ? "UP" : "DOWN")} ${String(deg).replace(".", ctx.dec)}° R${String(rad).replace(".", ctx.dec)}`;
    out.push({ t: "t", x: (A[0] + B[0]) / 2 + nx * 0.8, y: (A[1] + B[1]) / 2 + ny * 0.8, s, h, al: "c", rot: ang, layer: "ANNOT" });
  }
  return out;
}

/** Radius of the centre of mass symbol on the sheet (mm). */
export const COM_R = 2;

/** The centre of mass symbol (ISO 7000-0626 style): a circle with a cross and two opposite quarters filled. */
export function comPrims(C: P2): Prim[] {
  const r = COM_R, out: Prim[] = [{ t: "a", o: C, r, a0: 0, a1: TAU, pen: "thin", layer: "ANNOT" },
    { t: "l", p: [C[0] - r, C[1], C[0] + r, C[1]], pen: "thin", layer: "ANNOT" }, { t: "l", p: [C[0], C[1] - r, C[0], C[1] + r], pen: "thin", layer: "ANNOT" }];
  for (const q of [0, 2]) {
    const p: number[] = [C[0], C[1]];
    for (let k = 0; k <= 8; k++) { const a = (q + k / 8) * Math.PI / 2; p.push(C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)); }
    out.push({ t: "p", p, pen: "thin", layer: "ANNOT", closed: true, fill: true });
  }
  return out;
}

/** Bend tags A, B, … by the bend line's middle on the view: top to bottom, then left to right. */
export function bendTags(bends: FlatBend[], P: (p: V3) => P2): string[] {
  const mid = bends.map(b => { const a = P(b.a), c = P(b.b); return [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]; });
  const order = bends.map((_b, i) => i).sort((i, j) => (Math.abs(mid[i][1] - mid[j][1]) > 1e-6 ? mid[j][1] - mid[i][1] : mid[i][0] - mid[j][0]));
  const tags: string[] = [];
  order.forEach((i, k) => { tags[i] = k < 26 ? String.fromCharCode(65 + k) : `Z${k - 25}`; });
  return tags;
}

export const BEND_COLS = ["Tag", "Direction", "Angle", "Inner radius"];

/** The rows of a bend table in tag order: tag, UP/DOWN (translated when drawn), angle in degrees and inner radius. */
export function bendRows(a: BendTableAnnot, bends: FlatBend[], P: (p: V3) => P2, ctx: AnnotCtx): string[][] {
  const tags = bendTags(bends, P), f = (v: number) => fmtNum(v, a.prec, ctx.dec);
  return bends.map((b, i) => ({ b, tag: tags[i] })).sort((x, y) => (x.tag.length - y.tag.length) || x.tag.localeCompare(y.tag))
    .map(({ b, tag }) => [tag, ctx.label(b.up ? "UP" : "DOWN"), `${f(b.angle * 180 / Math.PI)}°`, f(b.r)]);
}

export const WELD_COLS = ["Item", "Weld", "Leg", "Length", "Qty"];

/**
 * The rows of a weld table: one per kind of bead in cut list order (item, continuous / intermittent l / e /
 * staggered, ISO 2553 leg "z5" or "z5×8", summed root length, number of beads), then a total row.
 */
export function weldRows(a: WeldTableAnnot, welds: WeldInfo[], ctx: AnnotCtx): string[][] {
  const f = (v: number) => fmtNum(v, a.prec, ctx.dec);
  const kind = (w: WeldInfo) => !w.inter ? ctx.label("Continuous")
    : ctx.label(w.inter[2] ? "Staggered {l} / {e}" : "Intermittent {l} / {e}", { l: f(w.inter[0]), e: f(w.inter[1]) });
  const rows = welds.map((w, i) => [String(i + 1), kind(w), `z${ctx.dec === "." ? w.legs : w.legs.split(".").join(ctx.dec)}`, f(w.length), String(w.qty)]);
  if (welds.length > 1) rows.push(["", ctx.label("Total"), "", f(welds.reduce((t, w) => t + w.length, 0)), String(welds.reduce((t, w) => t + w.qty, 0))]);
  return rows;
}

/** The item a balloon on edge `k` numbers: its component's BOM item in an assembly drawing, else the cut list item of the weldment body the edge's faces belong to. */
export function edgeItem(k: string, ctx: Pick<AnnotCtx, "bom" | "cutFaces">): number | null {
  if (ctx.bom) { const c = compOfKey(k); return c ? ctx.bom.itemOf(c) : null; }
  for (const f of k.split("|")) { const n = ctx.cutFaces?.[f]; if (n) return n; }
  return null;
}

/** The weld table row a weld tag on edge `k` numbers: the bead the edge's faces belong to. */
export function weldItem(k: string, ctx: Pick<AnnotCtx, "weldFaces">): number | null {
  for (const f of k.split("|")) { const n = ctx.weldFaces?.[f]; if (n) return n; }
  return null;
}

/** A stacked balloon's item: a component id (assembly), `cut:<item>` (weldment cut list) or `weld:<row>` (weld table). */
export function stackItem(s: string, ctx: Pick<AnnotCtx, "bom" | "cuts" | "welds">): number | null {
  if (s.startsWith("cut:")) { const n = +s.slice(4); return ctx.cuts?.some(c => c.item === n) ? n : null; }
  if (s.startsWith("weld:")) { const n = +s.slice(5); return n >= 1 && n <= (ctx.welds?.length ?? 0) ? n : null; }
  return ctx.bom?.itemOf(s) ?? null;
}

/** The cut list table's columns (SolidWorks' Weldment Cut List: ITEM NO., QTY., DESCRIPTION, LENGTH, ANGLE1, ANGLE2), with Mass (kg) when asked. */
export function cutCols(a: CutTableAnnot): string[] {
  return ["Item", "Qty", "Description", "Length", "Angle 1", "Angle 2", ...(a.mass ? ["Mass (kg)"] : [])];
}

/**
 * The rows of a weldment cut list table, in the cut list's order and numbering: quantity, the typed description or
 * the profile / "Plate t × w × l" / fillet weld text (translated), length (member or bead root), end angles in degrees
 * from square for members, mass of one item. `beads` false leaves the weld beads out (their numbers stay).
 */
/** A cut list item's description as the cut list table writes it (typed one, member description, plate size or bead). */
export function cutDesc(c: CutInfo, ctx: Pick<AnnotCtx, "dec" | "label">, prec?: number): string {
  const f = (v: number) => fmtNum(v, prec, ctx.dec), d = (v: string) => ctx.dec === "." ? v : v.split(".").join(ctx.dec);
  return c.own ? c.desc
    : c.kind === "member" ? c.desc
    : c.kind === "plate" ? ctx.label("Plate {t} × {w} × {l}", { t: f(c.plate![2]), w: f(c.plate![0]), l: f(c.plate![1]) })
    : !c.inter ? ctx.label("Fillet weld, leg {s}", { s: d(c.desc) })
    : ctx.label(c.inter[2] ? "Staggered fillet weld, leg {s}, {l} every {e}" : "Intermittent fillet weld, leg {s}, {l} every {e}", { s: d(c.desc), l: f(c.inter[0]), e: f(c.inter[1]) });
}

export function cutRows(a: CutTableAnnot, cuts: CutInfo[], ctx: AnnotCtx): string[][] {
  const f = (v: number) => fmtNum(v, a.prec, ctx.dec), desc = (c: CutInfo) => cutDesc(c, ctx, a.prec);
  return cuts.filter(c => a.beads !== false || c.kind !== "bead").map(c => [String(c.item), String(c.qty), desc(c), c.length != null ? f(c.length) : "",
    c.a1 != null ? `${f(c.a1)}°` : "", c.a2 != null ? `${f(c.a2)}°` : "", ...(a.mass ? [fmtNum(c.kg, a.prec ?? 2, ctx.dec)] : [])]);
}

// ---------- model items ----------

/**
 * Model items (FR-DRW-020): each item goes to the first view where it reads best (looking along its
 * plane's normal, or for a depth, square to it), once per sheet; its dimension line sits outside the view.
 * On each side of a view the shorter dimensions sit nearer the outline (so extension lines do not cross
 * dimension lines), the stack starts beyond the dimensions already on that side, and the gaps are sheet
 * millimetres whatever the view's scale. Radius and diameter texts that would land on another one turn aside.
 */
export function placeItems(sheet: Sheet, items: ModelItem[], boxOf: (v: DrawingView) => [number, number, number, number] | null, uid: () => string,
  scaleOf: (v: DrawingView) => number = () => 1): DimAnnot[] {
  const have = new Set((sheet.annots ?? []).map(a => (a.t === "dim" ? a.src : undefined)).filter(Boolean));
  const out: DimAnnot[] = [];
  const order = [...sheet.views].sort((a, b) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0) || (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  /** Dimensions waiting for a place in a stack: view + side → entries with the measured length. */
  const stacks = new Map<string, { v: DrawingView; side: string; box: [number, number, number, number]; list: { d: DimAnnot; len: number; mid: P2 }[] }>();
  /** Radius/diameter texts placed so far, per view (existing ones included). */
  const round = new Map<string, P2[]>();
  for (const a of sheet.annots ?? []) if (a.t === "dim" && (a.k === "rad" || a.k === "dia") && a.pos) (round.get(a.view) ?? round.set(a.view, []).get(a.view)!).push(a.pos);
  for (const it of items) {
    if (have.has(it.src)) continue;
    for (const v of order) {
      if (v.kind === "detail" || v.orient === "iso" || (v.side && v.side[0] && v.side[1])) continue;
      const vd = viewDir(sheet, v), { P, n } = projector(vd), c = Math.abs(dot3(it.n, n));
      if (it.side ? c > 1e-6 : c < 1 - 1e-6) continue;
      const box = boxOf(v);
      if (!box) continue;
      const g = 1 / (scaleOf(v) || 1);
      const [a, b] = it.p.map(P);
      let k: DimAnnot["k"] = it.k === "lin" ? "al" : it.k;
      if (it.k === "lin") {
        const dd = it.dir ? P([it.dir[0], it.dir[1], it.dir[2]]) : [b[0] - a[0], b[1] - a[1]];
        k = Math.abs(dd[1]) < 1e-6 * (Math.abs(dd[0]) || 1) ? "h" : Math.abs(dd[0]) < 1e-6 * (Math.abs(dd[1]) || 1) ? "v" : "al";
        if (Math.abs(k === "h" ? b[0] - a[0] : k === "v" ? b[1] - a[1] : Math.hypot(b[0] - a[0], b[1] - a[1])) < 1e-6) break;
      }
      const d: DimAnnot = { id: uid(), t: "dim", view: v.id, k, refs: [{ pt: it.p[0] }, { pt: it.p[1] }], pos: [0, 0], src: it.src };
      const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (k === "rad" || k === "dia") {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]), d0 = unit2([b[0] - a[0], b[1] - a[1]], [Math.SQRT1_2, Math.SQRT1_2]);
        const taken = round.get(v.id) ?? round.set(v.id, []).get(v.id)!;
        let pos: P2 = [a[0] + d0[0] * (r + 8 * g), a[1] + d0[1] * (r + 8 * g)];
        // Turn aside in 30° steps while another radius/diameter text sits within 7 mm on the sheet.
        for (let i = 1; i < 12 && taken.some(q => Math.hypot(q[0] - pos[0], q[1] - pos[1]) < 7 * g); i++) {
          const t = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 6, cs = Math.cos(t), sn = Math.sin(t);
          pos = [a[0] + (d0[0] * cs - d0[1] * sn) * (r + 8 * g), a[1] + (d0[0] * sn + d0[1] * cs) * (r + 8 * g)];
        }
        d.pos = [r2(pos[0]), r2(pos[1])];
        taken.push(d.pos);
      } else if (k === "h" || k === "v") {
        // Outside the view on the side nearer the measured points; the place in the stack comes later.
        const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
        const side = k === "h" ? (mid[1] >= cy ? "t" : "b") : (mid[0] >= cx ? "r" : "l"), key = `${v.id}|${side}`;
        const st = stacks.get(key) ?? stacks.set(key, { v, side, box, list: [] }).get(key)!;
        st.list.push({ d, len: Math.abs(k === "h" ? b[0] - a[0] : b[1] - a[1]), mid });
      } else {
        const dd = unit2([b[0] - a[0], b[1] - a[1]]), nn: P2 = [-dd[1], dd[0]];
        d.pos = [r2(mid[0] + nn[0] * 10 * g), r2(mid[1] + nn[1] * 10 * g)];
      }
      out.push(d);
      break;
    }
  }
  for (const { v, side, box, list } of stacks.values()) {
    const g = 1 / (scaleOf(v) || 1), hz = side === "t" || side === "b", sg = side === "t" || side === "r" ? 1 : -1;
    const edge = side === "t" ? box[3] : side === "b" ? box[1] : side === "r" ? box[2] : box[0];
    // Start beyond the dimensions of this kind already outside this side of the view.
    let from = 10 * g;
    for (const a of sheet.annots ?? []) {
      if (a.t !== "dim" || a.view !== v.id || a.k !== (hz ? "h" : "v") || !a.pos) continue;
      const o = sg * ((hz ? a.pos[1] : a.pos[0]) - edge);
      if (o > 0) from = Math.max(from, o + 8 * g);
    }
    list.sort((x, y) => x.len - y.len);
    list.forEach((e, i) => {
      const o = edge + sg * (from + 8 * g * i);
      e.d.pos = hz ? [r2(e.mid[0]), r2(o)] : [r2(o), r2(e.mid[1])];
    });
  }
  return out;
}
