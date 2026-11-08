// Composes a sheet into primitives: the sheet format plus every view's lines,
// placed and scaled, filtered by the view's display style and tangent edges.
// Section views add hatching on their cut faces; detail views are their parent's
// lines clipped to a circle; parents carry the cutting lines, detail circles and
// view arrows of the views made from them (FR-DRW-012/013/014).
import type { Projection, Seg2, V3 } from "../kernel/drawing";
import type { Pen, Layer, Prim } from "./prims";
import { formatPrims, type Fields } from "./sheet";
import type { DrawingView, Sheet } from "./types";
import { sheetNotes, viewAnnots, type AnnotCtx } from "./annot";
import { boxInView, findView, lookDir, viewReq, viewDir, viewScale, viewScalePair, scaleText } from "./views";

export interface ViewBox { id: string; x0: number; y0: number; x1: number; y1: number; ready: boolean }

/** Where a view's model coordinates land on the sheet. */
export interface Placement { s: number; uc: number; vc: number; x: number; y: number; box: [number, number, number, number]; ready: boolean }

export function placement(sheet: Sheet, v: DrawingView, proj: Projection | undefined, modelBox: [V3, V3] | null): Placement {
  const s = viewScale(sheet, v);
  let box: [number, number, number, number];
  if (v.kind === "detail" && v.c && v.r) box = [v.c[0] - v.r, v.c[1] - v.r, v.c[0] + v.r, v.c[1] + v.r];
  else box = proj && (proj.vis.length || proj.hid.length) ? proj.box : modelBox ? boxInView(modelBox, viewDir(sheet, v)) : [-10, -10, 10, 10];
  return { s, uc: (box[0] + box[2]) / 2, vc: (box[1] + box[3]) / 2, x: v.x, y: v.y, box, ready: !!proj };
}

export function viewRect(p: Placement): [number, number, number, number] {
  const hw = (p.box[2] - p.box[0]) / 2 * p.s, hh = (p.box[3] - p.box[1]) / 2 * p.s;
  return [p.x - hw, p.y - hh, p.x + hw, p.y + hh];
}

/** Model point of a view (its own axes) → sheet. */
export const toSheet = (pl: Placement, u: number, w: number): [number, number] => [pl.x + (u - pl.uc) * pl.s, pl.y + (w - pl.vc) * pl.s];
/** Sheet point → model point of a view. */
export const fromSheet = (pl: Placement, x: number, y: number): [number, number] => [pl.uc + (x - pl.x) / pl.s, pl.vc + (y - pl.y) / pl.s];

// ---------- clipping to a circle (detail views) ----------

/** Parameters t in [0, 1] of the parts of segment a→b inside the circle. */
function clipLine(ax: number, ay: number, bx: number, by: number, c: [number, number], R: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay, fx = ax - c[0], fy = ay - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
  if (A < 1e-18) return C <= 0 ? [0, 1] : null;
  const D = B * B - 4 * A * C;
  if (D <= 0) return null;
  const q = Math.sqrt(D), t0 = Math.max(0, (-B - q) / (2 * A)), t1 = Math.min(1, (-B + q) / (2 * A));
  return t1 > t0 ? [t0, t1] : null;
}

export function clipToCircle(segs: Seg2[], c: [number, number], R: number): Seg2[] {
  const out: Seg2[] = [];
  for (const g of segs) {
    if (g.k === "l") {
      const t = clipLine(g.p[0], g.p[1], g.p[2], g.p[3], c, R);
      if (t) { const L = (k: number) => [g.p[0] + (g.p[2] - g.p[0]) * k, g.p[1] + (g.p[3] - g.p[1]) * k]; out.push({ ...g, p: [...L(t[0]), ...L(t[1])] as [number, number, number, number] }); }
    } else if (g.k === "a") {
      // Split the arc where it crosses the clip circle, keep the pieces whose middle is inside.
      const d = Math.hypot(g.o[0] - c[0], g.o[1] - c[1]);
      const cuts = [g.a0, g.a1];
      if (d > 1e-12 && d < g.r + R && d > Math.abs(g.r - R)) {
        const base = Math.atan2(c[1] - g.o[1], c[0] - g.o[0]), h = Math.acos((g.r * g.r + d * d - R * R) / (2 * g.r * d));
        for (const a of [base - h, base + h]) for (let k = -2; k <= 2; k++) { const x = a + k * 2 * Math.PI; if (x > g.a0 && x < g.a1) cuts.push(x); }
      }
      cuts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        if (cuts[i + 1] - cuts[i] > 1e-9 && Math.hypot(g.o[0] + g.r * Math.cos(m) - c[0], g.o[1] + g.r * Math.sin(m) - c[1]) < R) out.push({ ...g, a0: cuts[i], a1: cuts[i + 1] });
      }
    } else {
      let run: number[] = [];
      const flush = () => { if (run.length >= 4) out.push({ k: "p", c: g.c, p: run }); run = []; };
      for (let i = 0; i + 3 < g.p.length; i += 2) {
        const t = clipLine(g.p[i], g.p[i + 1], g.p[i + 2], g.p[i + 3], c, R);
        if (!t) { flush(); continue; }
        const P = (k: number) => [g.p[i] + (g.p[i + 2] - g.p[i]) * k, g.p[i + 1] + (g.p[i + 3] - g.p[i + 1]) * k];
        if (t[0] > 1e-9) { flush(); run.push(...P(t[0])); } else if (!run.length) run.push(...P(0));
        run.push(...P(t[1]));
        if (t[1] < 1 - 1e-9) flush();
      }
      flush();
    }
  }
  return out;
}

// ---------- hatching (section views) ----------

/** 45° hatch lines inside closed loops (sheet mm, even-odd), `gap` apart. */
export function hatch(loops: number[][], gap = 2.5, angle = Math.PI / 4): [number, number, number, number][] {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  // Rotate so the hatch lines are horizontal: y' = −x·sin + y·cos.
  const rot = loops.map(l => { const r: number[] = []; for (let i = 0; i < l.length; i += 2) r.push(l[i] * ca + l[i + 1] * sa, -l[i] * sa + l[i + 1] * ca); return r; });
  let y0 = Infinity, y1 = -Infinity;
  for (const l of rot) for (let i = 1; i < l.length; i += 2) { y0 = Math.min(y0, l[i]); y1 = Math.max(y1, l[i]); }
  const out: [number, number, number, number][] = [];
  if (!isFinite(y0)) return out;
  for (let y = Math.ceil(y0 / gap) * gap; y <= y1; y += gap) {
    const xs: number[] = [];
    for (const l of rot) {
      const n = l.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = l[2 * i], ay = l[2 * i + 1], bx = l[(2 * i + 2) % l.length], by = l[(2 * i + 3) % l.length];
        if ((ay <= y) !== (by <= y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = xs[i], b = xs[i + 1];
      if (b - a < 1e-6) continue;
      out.push([a * ca - y * sa, a * sa + y * ca, b * ca - y * sa, b * sa + y * ca]);
    }
  }
  return out;
}

// ---------- a view's primitives ----------

/** Hatch spacing (sheet mm) and angle (degrees) of a view. */
export function hatchOf(v: DrawingView): { gap: number; angle: number } {
  return { gap: Math.max(0.5, v.hatch?.gap ?? 2.5), angle: v.hatch?.angle ?? 45 };
}

/** A view's lines in sheet mm. */
export function viewPrims(v: DrawingView, proj: Projection, pl: Placement): Prim[] {
  const out: Prim[] = [];
  const style = v.style ?? (v.kind === "section" ? "hlr" : "hlv"), tan = v.tangent ?? "visible";
  const X = (u: number) => pl.x + (u - pl.uc) * pl.s, Y = (w: number) => pl.y + (w - pl.vc) * pl.s;
  const put = (g: Seg2, pen: Pen, layer: Layer) => {
    if (g.k === "l") out.push({ t: "l", p: [X(g.p[0]), Y(g.p[1]), X(g.p[2]), Y(g.p[3])], pen, layer });
    else if (g.k === "a") out.push({ t: "a", o: [X(g.o[0]), Y(g.o[1])], r: g.r * pl.s, a0: g.a0, a1: g.a1, pen, layer });
    else { const p: number[] = []; for (let i = 0; i < g.p.length; i += 2) p.push(X(g.p[i]), Y(g.p[i + 1])); out.push({ t: "p", p, pen, layer }); }
  };
  let vis = proj.vis, hid = proj.hid;
  if (v.kind === "detail" && v.c && v.r) { vis = clipToCircle(vis, v.c, v.r); hid = clipToCircle(hid, v.c, v.r); }
  if (proj.cut?.length) {
    const loops = proj.cut.map(l => { const r: number[] = []; for (let i = 0; i < l.length; i += 2) r.push(X(l[i]), Y(l[i + 1])); return r; });
    const hs = hatchOf(v), circ = v.kind === "detail" && v.r ? { c: [pl.x, pl.y] as [number, number], R: v.r * pl.s } : null;
    for (const h of hatch(loops, hs.gap, hs.angle * Math.PI / 180)) {
      if (!circ) { out.push({ t: "l", p: h, pen: "thin", layer: "HATCH" }); continue; }
      const k = clipLine(h[0], h[1], h[2], h[3], circ.c, circ.R);
      if (k) out.push({ t: "l", p: [h[0] + (h[2] - h[0]) * k[0], h[1] + (h[3] - h[1]) * k[0], h[0] + (h[2] - h[0]) * k[1], h[1] + (h[3] - h[1]) * k[1]], pen: "thin", layer: "HATCH" });
    }
  }
  // Hidden lines first, so visible ones draw over them.
  if (style !== "hlr") for (const g of hid) {
    if (g.c === 1 && (tan === "hidden" || style === "hlv")) continue;
    put(g, style === "wire" ? (g.c === 1 && tan === "thin" ? "thin" : "thick") : "hidden", style === "wire" ? (g.c === 1 ? "TANGENT" : "VISIBLE") : "HIDDEN");
  }
  for (const g of vis) {
    if (g.c === 1) { if (tan !== "hidden") put(g, tan === "thin" ? "thin" : "thick", "TANGENT"); }
    else put(g, "thick", "VISIBLE");
  }
  if (v.kind === "detail" && v.r) out.push({ t: "a", o: [pl.x, pl.y], r: v.r * pl.s, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
  return out;
}

/** A filled arrowhead with its tip at (x, y), pointing along (dx, dy). */
export function arrowHead(x: number, y: number, dx: number, dy: number, len = 3.5, w = 1.2): Prim {
  const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  return { t: "p", p: [x, y, x - ux * len - uy * w / 2, y - uy * len + ux * w / 2, x - ux * len + uy * w / 2, y - uy * len - ux * w / 2], pen: "thin", layer: "ANNOT", fill: true, closed: true };
}

/** Marks on a parent view for the views made from it: cutting lines, detail circles, view arrows. */
export function childMarks(sheet: Sheet, parent: DrawingView, pl: Placement): Prim[] {
  const out: Prim[] = [];
  const r = viewRect(pl);
  for (const v of sheet.views) {
    if (v.parent !== parent.id || !v.kind) continue;
    const letter = v.letter ?? "";
    if (v.kind === "detail" && v.c && v.r) {
      const [cx, cy] = toSheet(pl, v.c[0], v.c[1]), R = v.r * pl.s;
      out.push({ t: "a", o: [cx, cy], r: R, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
      out.push({ t: "t", x: cx + R * 0.75 + 1.5, y: cy + R * 0.75 + 1.5, s: letter, h: 5, al: "l", layer: "ANNOT" });
      continue;
    }
    if (!v.line) continue;
    const [a, b] = [toSheet(pl, v.line[0], v.line[1]), toSheet(pl, v.line[2], v.line[3])];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const q = lookDir(v);
    if (v.kind === "section") {
      // Extend the cutting line past the view, thick ends (ISO 128-44), arrows the way the view looks.
      // The line runs across the whole view box (the infinite line clipped to it), and at least between its two points.
      let t0 = 0, t1 = L, lo = -Infinity, hi = Infinity;
      for (const [u, p0, m0, m1] of [[ux, a[0], r[0], r[2]], [uy, a[1], r[1], r[3]]]) {
        if (Math.abs(u) < 1e-9) continue;
        const k0 = (m0 - p0) / u, k1 = (m1 - p0) / u;
        lo = Math.max(lo, Math.min(k0, k1)); hi = Math.min(hi, Math.max(k0, k1));
      }
      if (lo < hi) { t0 = Math.min(t0, lo); t1 = Math.max(t1, hi); }
      t0 -= 4; t1 += 4;
      const P = (t: number): [number, number] => [a[0] + ux * t, a[1] + uy * t];
      const [s0, s1] = [P(t0), P(t1)];
      out.push({ t: "l", p: [...P(t0 + 6), ...P(t1 - 6)] as [number, number, number, number], pen: "center", layer: "ANNOT" });
      out.push({ t: "l", p: [...s0, ...P(t0 + 6)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
      out.push({ t: "l", p: [...P(t1 - 6), ...s1] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
      for (const s of [s0, s1]) {
        const tail: [number, number] = [s[0] + q[0] * 8, s[1] + q[1] * 8];
        out.push({ t: "l", p: [tail[0], tail[1], s[0] + q[0] * 3.5, s[1] + q[1] * 3.5], pen: "thin", layer: "ANNOT" });
        out.push(arrowHead(s[0], s[1], -q[0], -q[1]));
        out.push({ t: "t", x: tail[0] + q[0] * 2, y: tail[1] + q[1] * 2 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
      }
    } else {
      // Auxiliary view: an arrow square to the edge, at its middle, pointing at it.
      const m: [number, number] = [(a[0] + b[0]) / 2 + q[0] * 3, (a[1] + b[1]) / 2 + q[1] * 3];
      const tail: [number, number] = [m[0] + q[0] * 10, m[1] + q[1] * 10];
      out.push({ t: "l", p: [tail[0], tail[1], m[0] + q[0] * 3.5, m[1] + q[1] * 3.5], pen: "thin", layer: "ANNOT" });
      out.push(arrowHead(m[0], m[1], -q[0], -q[1]));
      out.push({ t: "t", x: tail[0] + q[0] * 3, y: tail[1] + q[1] * 3 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
    }
  }
  return out;
}

/** The label under a view: its name (or SECTION A-A / DETAIL B / VIEW C) and the scale when it differs or is asked for. */
export function viewLabel(sheet: Sheet, v: DrawingView, pl: Placement, label: (s: string, p?: Record<string, string>) => string): Prim[] {
  const special = v.kind && v.letter;
  if (!v.label && !special) return [];
  const r = viewRect(pl);
  const title = !special ? v.name : v.kind === "section" ? label("SECTION {a}-{a}", { a: v.letter! }) : v.kind === "detail" ? label("DETAIL {a}", { a: v.letter! }) : label("VIEW {a}", { a: v.letter! });
  const out: Prim[] = [{ t: "t", x: v.x, y: r[1] - 7, s: title, h: 3.5, al: "c", layer: "TEXT" }];
  if (v.label || v.kind === "detail" || v.scale) out.push({ t: "t", x: v.x, y: r[1] - 11.5, s: `${label("Scale")} ${scaleText(viewScalePair(sheet, v))}`, h: 2.5, al: "c", layer: "TEXT" });
  return out;
}

/** Everything drawn for one view: its lines, the marks of its child views and its label. */
export function viewBody(sheet: Sheet, v: DrawingView, proj: Projection | undefined, pl: Placement, label: (s: string, p?: Record<string, string>) => string, ctx?: AnnotCtx): Prim[] {
  const out = [...(proj ? viewPrims(v, proj, pl) : []), ...childMarks(sheet, v, pl), ...viewLabel(sheet, v, pl, label)];
  if (ctx) out.push(...viewAnnots(sheet, v, pl, ctx).prims);
  return out;
}

export interface Composed { prims: Prim[]; boxes: ViewBox[] }

/** The whole sheet. `projections` is looked up by each view's request key. */
export function composeSheet(sheet: Sheet, fields: Fields, projections: Map<string, Projection>, modelBox: [V3, V3] | null, label: (s: string, p?: Record<string, string>) => string, ctx?: AnnotCtx): Composed {
  const prims = formatPrims(sheet, fields, label);
  const boxes: ViewBox[] = [];
  for (const v of sheet.views) {
    const proj = projections.get(viewReq(sheet, v).key);
    const pl = placement(sheet, v, proj, modelBox);
    const r = viewRect(pl);
    boxes.push({ id: v.id, x0: r[0], y0: r[1], x1: r[2], y1: r[3], ready: !!proj });
    prims.push(...viewBody(sheet, v, proj, pl, label, ctx));
  }
  prims.push(...sheetNotes(sheet).prims);
  return { prims, boxes };
}

/** The next free letter for a section, detail or auxiliary view (I, O, Q are skipped, as ISO advises). */
export function nextLetter(sheets: Sheet[]): string {
  const used = new Set(sheets.flatMap(s => s.views.map(v => v.letter).filter(Boolean)));
  const abc = "ABCDEFGHJKLMNPRSTUVWXYZ";
  for (let n = 0; ; n++) for (const ch of abc) { const l = n ? ch + n : ch; if (!used.has(l)) return l; }
}

export { findView };
