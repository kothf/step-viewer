// Sketch text (FR-SK-020): glyph outlines from the bundled DejaVu fonts, turned into closed loops.
import type { SkEnt, TextFont, TextOutline, V2 } from "../model/types";
import type { Seg } from "./profile";

type TextEnt = Extract<SkEnt, { t: "text" }>;

/** The cache key of a text's outline: what the glyphs depend on. */
export const textKey = (e: Pick<TextEnt, "text" | "font" | "bold" | "italic">) => `${e.font ?? "sans"}|${e.bold ? "b" : ""}${e.italic ? "i" : ""}|${e.text}`;

/**
 * A point of the outline (capital heights, y up) placed on the sketch. With `path` (a polyline of the curve
 * the text follows, FR-SK-020), the baseline runs along it from the point of the curve nearest the anchor
 * and each point is lifted along the curve's left normal; a closed curve wraps round.
 */
function placer(e: TextEnt, p: V2, path?: V2[]) {
  const h = e.h;
  const along = path && path.length >= 2 ? pathPlacer(h, p, path) : null;
  if (along) return along;
  const c = Math.cos(e.ang ?? 0), s = Math.sin(e.ang ?? 0);
  return (x: number, y: number): V2 => [p[0] + h * (x * c - y * s), p[1] + h * (x * s + y * c)];
}

function pathPlacer(h: number, p: V2, path: V2[]) {
  const n = path.length, L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const tot = L[n - 1];
  if (!(tot > 1e-9)) return null;
  const closed = Math.hypot(path[0][0] - path[n - 1][0], path[0][1] - path[n - 1][1]) < 1e-9;
  const unit = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const segT = (i: number) => unit([path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]]);
  const avg = (a: V2, b: V2) => unit([a[0] + b[0], a[1] + b[1]]);
  // Tangents at the vertices (averaged), blended along each piece so glyphs don't kink at the samples.
  const vt: V2[] = path.map((_q, i) => i === 0 ? (closed ? avg(segT(n - 2), segT(0)) : segT(0)) : i === n - 1 ? (closed ? avg(segT(n - 2), segT(0)) : segT(n - 2)) : avg(segT(i - 1), segT(i)));
  // Start: the point of the curve nearest the anchor.
  let best = Infinity, s0 = 0;
  for (let i = 0; i + 1 < n; i++) {
    const a = path[i], d: V2 = [path[i + 1][0] - a[0], path[i + 1][1] - a[1]], ll = d[0] * d[0] + d[1] * d[1];
    const t = ll > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / ll)) : 0;
    const dist = Math.hypot(a[0] + t * d[0] - p[0], a[1] + t * d[1] - p[1]);
    if (dist < best) { best = dist; s0 = L[i] + t * (L[i + 1] - L[i]); }
  }
  return (x: number, y: number): V2 => {
    let s = s0 + h * x;
    if (closed) s = ((s % tot) + tot) % tot;
    let lo = 0, hi = n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m] <= s) lo = m; else hi = m - 1; }
    const i = lo, len = L[i + 1] - L[i] || 1, t = (s - L[i]) / len, tc = Math.max(0, Math.min(1, t));
    const q: V2 = [path[i][0] + t * (path[i + 1][0] - path[i][0]), path[i][1] + t * (path[i + 1][1] - path[i][1])];
    const T = unit([vt[i][0] * (1 - tc) + vt[i + 1][0] * tc, vt[i][1] * (1 - tc) + vt[i + 1][1] * tc]);
    return [q[0] - h * y * T[1], q[1] + h * y * T[0]];
  };
}

/** The text's contours as closed loops of lines and single cubic Bézier pieces (`spline` segments of 4 poles). */
export function textLoops(e: TextEnt, p: V2, path?: V2[]): Seg[][] {
  if (!e.gl || e.gl.key !== textKey(e)) return [];
  const at = placer(e, p, path);
  const loops: Seg[][] = [];
  for (const c of e.gl.c) {
    const loop: Seg[] = [];
    let cur: V2 = at(c[0], c[1]);
    const start = cur;
    let i = 2;
    while (i < c.length) {
      const op = c[i];
      if (op === 1) { const b = at(c[i + 1], c[i + 2]); if (Math.hypot(b[0] - cur[0], b[1] - cur[1]) > 1e-9) loop.push({ ent: e.id, kind: "line", a: cur, b }); cur = b; i += 3; }
      else if (op === 2) {
        const q = at(c[i + 1], c[i + 2]), b = at(c[i + 3], c[i + 4]);
        // Quadratic to cubic: the inner poles two thirds of the way to the control point.
        const c1: V2 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], c2: V2 = [b[0] + (2 / 3) * (q[0] - b[0]), b[1] + (2 / 3) * (q[1] - b[1])];
        loop.push({ ent: e.id, kind: "spline", bz: [cur, c1, c2, b] });
        cur = b; i += 5;
      } else if (op === 3) {
        const b = at(c[i + 5], c[i + 6]);
        loop.push({ ent: e.id, kind: "spline", bz: [cur, at(c[i + 1], c[i + 2]), at(c[i + 3], c[i + 4]), b] });
        cur = b; i += 7;
      } else break;
    }
    if (Math.hypot(start[0] - cur[0], start[1] - cur[1]) > 1e-9) loop.push({ ent: e.id, kind: "line", a: cur, b: start });
    if (loop.length) loops.push(loop);
  }
  return loops;
}

/** The outline as polylines on the sketch (for drawing and picking). */
export function textPolys(e: TextEnt, p: V2, path?: V2[]): V2[][] {
  return textLoops(e, p, path).map(loop => {
    const out: V2[] = [];
    for (const s of loop) {
      if (s.kind === "line") out.push(s.a);
      else if (s.kind === "spline") {
        const [a, b, c, d] = s.bz;
        for (let k = 0; k < 6; k++) { const t = k / 6, u = 1 - t; out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]); }
      }
    }
    if (out.length) out.push(out[0]);
    return out;
  });
}

/**
 * The text's box on the sketch as a polygon: the baseline edge from the start, then the top edge back
 * (four corners for straight text; along a curve each edge is sampled). The middle point is the top end.
 * An empty text: a small box at the anchor.
 */
export function textBox(e: TextEnt, p: V2, path?: V2[]): V2[] {
  const at = placer(e, p, path);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of e.gl?.key === textKey(e) ? e.gl.c : []) for (let i = 0; i < c.length;) {
    const n = i === 0 ? 2 : c[i] === 1 ? 3 : c[i] === 2 ? 5 : 7;
    const pts = i === 0 ? [c[0], c[1]] : c.slice(i + 1, i + n);
    for (let k = 0; k + 1 < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
    i += n;
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 0.6; y1 = 1; }
  const k = path && path.length >= 2 ? 12 : 1, out: V2[] = [];
  for (let i = 0; i <= k; i++) out.push(at(x0 + ((x1 - x0) * i) / k, y0));
  for (let i = 0; i <= k; i++) out.push(at(x1 - ((x1 - x0) * i) / k, y1));
  return out;
}

const FONT_FILES: Record<string, () => Promise<{ default: string }>> = {
  "sans|": () => import("dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url"),
  "sans|b": () => import("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url"),
  "sans|i": () => import("dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf?url"),
  "sans|bi": () => import("dejavu-fonts-ttf/ttf/DejaVuSans-BoldOblique.ttf?url"),
  "serif|": () => import("dejavu-fonts-ttf/ttf/DejaVuSerif.ttf?url"),
  "serif|b": () => import("dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf?url"),
  "serif|i": () => import("dejavu-fonts-ttf/ttf/DejaVuSerif-Italic.ttf?url"),
  "serif|bi": () => import("dejavu-fonts-ttf/ttf/DejaVuSerif-BoldItalic.ttf?url"),
  "mono|": () => import("dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf?url"),
  "mono|b": () => import("dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf?url"),
  "mono|i": () => import("dejavu-fonts-ttf/ttf/DejaVuSansMono-Oblique.ttf?url"),
  "mono|bi": () => import("dejavu-fonts-ttf/ttf/DejaVuSansMono-BoldOblique.ttf?url"),
};
type OtFont = { unitsPerEm: number; tables: { os2?: { sCapHeight?: number } }; getPath(text: string, x: number, y: number, size: number, opts?: { kerning?: boolean }): { commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[] } };
const fonts = new Map<string, Promise<OtFont>>();

/** Outlines from font bytes (also used by the unit tests, which read the font from disk). */
export function outlineFrom(font: OtFont, e: Pick<TextEnt, "text" | "font" | "bold" | "italic">): TextOutline {
  const em = font.unitsPerEm, cap = font.tables.os2?.sCapHeight || em * 0.73;
  // getPath works in y-down units of `em`: divide by the capital height and flip.
  const path = font.getPath(e.text, 0, 0, em, { kerning: true });
  const X = (v = 0) => v / cap, Y = (v = 0) => -v / cap;
  const c: number[][] = [];
  let cur: number[] | null = null;
  for (const k of path.commands) {
    if (k.type === "M") { if (cur && cur.length > 2) c.push(cur); cur = [X(k.x), Y(k.y)]; }
    else if (!cur) continue;
    else if (k.type === "L") cur.push(1, X(k.x), Y(k.y));
    else if (k.type === "Q") cur.push(2, X(k.x1), Y(k.y1), X(k.x), Y(k.y));
    else if (k.type === "C") cur.push(3, X(k.x1), Y(k.y1), X(k.x2), Y(k.y2), X(k.x), Y(k.y));
    else if (k.type === "Z") { if (cur.length > 2) c.push(cur); cur = null; }
  }
  if (cur && cur.length > 2) c.push(cur);
  // Round to keep documents small (1e-5 of a capital height).
  return { key: textKey(e), c: c.map(q => q.map((v, i) => (i < 2 || !Number.isInteger(v) || v > 3 || v < 1 ? Math.round(v * 1e5) / 1e5 : v))) };
}

/** Loads the font (once) and makes the outline of a text. */
export async function textOutline(e: Pick<TextEnt, "text" | "font" | "bold" | "italic">): Promise<TextOutline> {
  const style = `${e.font ?? "sans"}|${e.bold ? "b" : ""}${e.italic ? "i" : ""}`;
  let f = fonts.get(style);
  if (!f) {
    f = (async () => {
      const [{ default: url }, ot] = await Promise.all([FONT_FILES[style](), import("three/examples/jsm/libs/opentype.module.js")]);
      const buf = await (await fetch(url)).arrayBuffer();
      return ot.parse(buf) as unknown as OtFont;
    })();
    fonts.set(style, f);
    f.catch(() => fonts.delete(style));
  }
  return outlineFrom(await f, e);
}

export const TEXT_FONTS: [TextFont, string][] = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Monospace"]];
