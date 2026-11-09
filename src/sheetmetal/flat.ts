// Flat pattern export (FR-FT-120): the outline and bend lines as a 2D drawing, written as DXF R12
// (millimetres) or SVG by the section-profile writers. Outline on layer OUTLINE, bend lines on
// BEND_UP / BEND_DOWN (the side the flange goes, seen from the flat pattern's top face).
import * as THREE from "three";
import type { V2 } from "../model/types";
import type { Seg } from "../sketch/profile";
import { toDxf, toSvg, type Drawing2, type Entity2 } from "../tools/profileExport";
import { bendLine, flatLoops, type SheetState } from "./sheet";

export function flatDrawing(st: SheetState): Drawing2 {
  const { outer, holes } = flatLoops(st);
  const entities: Entity2[] = [];
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  const grow = (p: V2, r = 0) => { min[0] = Math.min(min[0], p[0] - r); min[1] = Math.min(min[1], p[1] - r); max[0] = Math.max(max[0], p[0] + r); max[1] = Math.max(max[1], p[1] + r); };
  const ang = (c: V2, p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  if (st.flatEdges) for (const e of st.flatEdges) {
    if (e.kind === "line") { entities.push({ ...e, layer: "OUTLINE" }); grow(e.a); grow(e.b); }
    else if (e.kind === "poly") { entities.push({ kind: "poly", pts: e.pts, closed: false, layer: "OUTLINE" }); e.pts.forEach(p => grow(p)); }
    else { entities.push({ ...e, layer: "OUTLINE" }); grow(e.c, e.r); }
  }
  else for (const s of [...outer, ...holes].flat() as Seg[]) {
    if (s.kind === "line") { entities.push({ kind: "line", a: s.a, b: s.b, layer: "OUTLINE" }); grow(s.a); grow(s.b); }
    else if (s.kind === "circle") { entities.push({ kind: "circle", c: s.c, r: s.r, layer: "OUTLINE" }); grow(s.c, s.r); }
    else if (s.kind === "arc") {
      // DXF arcs run counter-clockwise from a0 to a1.
      const [p, q] = s.ccw ? [s.a, s.b] : [s.b, s.a];
      entities.push({ kind: "arc", c: s.c, r: s.r, a0: ang(s.c, p), a1: ang(s.c, q), layer: "OUTLINE" });
      grow(s.c, s.r);
    }
  }
  for (const b of st.bends) {
    const [p, q] = bendLine(b);
    entities.push({ kind: "line", a: p, b: q, layer: b.up ? "BEND_UP" : "BEND_DOWN" });
  }
  // Cross breaks, on their own layer.
  for (const c of st.crosses ?? []) entities.push({ kind: "line", a: c.a, b: c.b, layer: "CROSS_BREAK" });
  // Sharp folds between the facets of a lofted bend.
  for (const f of st.folds ?? []) entities.push({ kind: "line", a: f.a, b: f.b, layer: f.up ? "BEND_UP" : "BEND_DOWN" });
  return { entities, u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), min, max };
}

export const flatDxf = (st: SheetState, title: string) => toDxf(flatDrawing(st), title);
export const flatSvg = (st: SheetState, title: string) => toSvg(flatDrawing(st), title);
