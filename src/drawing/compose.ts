// Composes a sheet into primitives: the sheet format plus every view's lines,
// placed and scaled, filtered by the view's display style and tangent edges.
import type { Projection, Seg2, V3 } from "../kernel/drawing";
import type { Pen, Layer, Prim } from "./prims";
import { formatPrims, type Fields } from "./sheet";
import type { DrawingView, Sheet } from "./types";
import { boxInView, dirKey, viewDir, viewScale, viewScalePair, scaleText } from "./views";

export interface ViewBox { id: string; x0: number; y0: number; x1: number; y1: number; ready: boolean }

/** Where a view's model coordinates land on the sheet. */
export interface Placement { s: number; uc: number; vc: number; x: number; y: number; box: [number, number, number, number]; ready: boolean }

export function placement(sheet: Sheet, v: DrawingView, proj: Projection | undefined, modelBox: [V3, V3] | null): Placement {
  const s = viewScale(sheet, v);
  const box = proj && (proj.vis.length || proj.hid.length) ? proj.box : modelBox ? boxInView(modelBox, viewDir(sheet, v)) : [-10, -10, 10, 10] as [number, number, number, number];
  return { s, uc: (box[0] + box[2]) / 2, vc: (box[1] + box[3]) / 2, x: v.x, y: v.y, box, ready: !!proj };
}

export function viewRect(p: Placement): [number, number, number, number] {
  const hw = (p.box[2] - p.box[0]) / 2 * p.s, hh = (p.box[3] - p.box[1]) / 2 * p.s;
  return [p.x - hw, p.y - hh, p.x + hw, p.y + hh];
}

/** A view's lines in sheet mm. */
export function viewPrims(v: DrawingView, proj: Projection, pl: Placement): Prim[] {
  const out: Prim[] = [];
  const style = v.style ?? "hlv", tan = v.tangent ?? "visible";
  const X = (u: number) => pl.x + (u - pl.uc) * pl.s, Y = (w: number) => pl.y + (w - pl.vc) * pl.s;
  const put = (g: Seg2, pen: Pen, layer: Layer) => {
    if (g.k === "l") out.push({ t: "l", p: [X(g.p[0]), Y(g.p[1]), X(g.p[2]), Y(g.p[3])], pen, layer });
    else if (g.k === "a") out.push({ t: "a", o: [X(g.o[0]), Y(g.o[1])], r: g.r * pl.s, a0: g.a0, a1: g.a1, pen, layer });
    else { const p: number[] = []; for (let i = 0; i < g.p.length; i += 2) p.push(X(g.p[i]), Y(g.p[i + 1])); out.push({ t: "p", p, pen, layer }); }
  };
  // Hidden lines first, so visible ones draw over them.
  if (style !== "hlr") for (const g of proj.hid) {
    if (g.c === 1 && (tan === "hidden" || style === "hlv")) continue;
    put(g, style === "wire" ? (g.c === 1 && tan === "thin" ? "thin" : "thick") : "hidden", style === "wire" ? (g.c === 1 ? "TANGENT" : "VISIBLE") : "HIDDEN");
  }
  for (const g of proj.vis) {
    if (g.c === 1) { if (tan !== "hidden") put(g, tan === "thin" ? "thin" : "thick", "TANGENT"); }
    else put(g, "thick", "VISIBLE");
  }
  return out;
}

export interface Composed { prims: Prim[]; boxes: ViewBox[] }

/** The whole sheet. `projections` is looked up by view direction. */
export function composeSheet(sheet: Sheet, fields: Fields, projections: Map<string, Projection>, modelBox: [V3, V3] | null, label: (s: string) => string): Composed {
  const prims = formatPrims(sheet, fields, label);
  const boxes: ViewBox[] = [];
  for (const v of sheet.views) {
    const proj = projections.get(dirKey(viewDir(sheet, v)));
    const pl = placement(sheet, v, proj, modelBox);
    const r = viewRect(pl);
    boxes.push({ id: v.id, x0: r[0], y0: r[1], x1: r[2], y1: r[3], ready: !!proj });
    if (proj) prims.push(...viewPrims(v, proj, pl));
    if (v.label) {
      prims.push({ t: "t", x: v.x, y: r[1] - 6, s: v.name, h: 3.5, al: "c", layer: "TEXT" });
      prims.push({ t: "t", x: v.x, y: r[1] - 10.5, s: `${label("Scale")} ${scaleText(viewScalePair(sheet, v))}`, h: 2.5, al: "c", layer: "TEXT" });
    }
  }
  return { prims, boxes };
}
