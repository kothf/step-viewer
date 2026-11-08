// Sketch text (FR-SK-020): glyph outlines from the bundled DejaVu fonts, turned into closed loops.
import type { SkEnt, TextFont, TextOutline, V2 } from "../model/types";
import type { Seg } from "./profile";

type TextEnt = Extract<SkEnt, { t: "text" }>;

/** The cache key of a text's outline: what the glyphs depend on. */
export const textKey = (e: Pick<TextEnt, "text" | "font" | "bold" | "italic">) => `${e.font ?? "sans"}|${e.bold ? "b" : ""}${e.italic ? "i" : ""}|${e.text}`;

/** A point of the outline (capital heights, y up) placed on the sketch. */
function placer(e: TextEnt, p: V2) {
  const c = Math.cos(e.ang ?? 0), s = Math.sin(e.ang ?? 0), h = e.h;
  return (x: number, y: number): V2 => [p[0] + h * (x * c - y * s), p[1] + h * (x * s + y * c)];
}

/** The text's contours as closed loops of lines and single cubic Bézier pieces (`spline` segments of 4 poles). */
export function textLoops(e: TextEnt, p: V2): Seg[][] {
  if (!e.gl || e.gl.key !== textKey(e)) return [];
  const at = placer(e, p);
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
export function textPolys(e: TextEnt, p: V2): V2[][] {
  return textLoops(e, p).map(loop => {
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

/** The four corners of the text's box on the sketch (an empty text: a small box at the anchor). */
export function textBox(e: TextEnt, p: V2): V2[] {
  const at = placer(e, p);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of e.gl?.key === textKey(e) ? e.gl.c : []) for (let i = 0; i < c.length;) {
    const n = i === 0 ? 2 : c[i] === 1 ? 3 : c[i] === 2 ? 5 : 7;
    const pts = i === 0 ? [c[0], c[1]] : c.slice(i + 1, i + n);
    for (let k = 0; k + 1 < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
    i += n;
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 0.6; y1 = 1; }
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
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
