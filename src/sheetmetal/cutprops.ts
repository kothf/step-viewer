// Sheet metal cut-list properties (FR-FT-120): what a CAD app lists for a sheet metal cut-list item,
// worked out from the flat pattern. Pure: no DOM, no OCCT.
import type { V2 } from "../model/types";
import { tableValue } from "./bendTable";
import { loopPolygon, polyArea, type Seg } from "../sketch/profile";
import { flatLoops, type FlatEdge, type SheetState } from "./sheet";

export interface SheetCutProps {
  /** Sheet thickness, bend radius (mm) and K-factor. */
  T: number;
  R: number;
  k: number;
  /** Bends, the sharp folds of a lofted bend included. */
  bends: number;
  /** Smallest rectangle round the flat pattern: the longer and shorter side (mm) and its turn from flat X (rad). */
  length: number;
  width: number;
  angle: number;
  /** length × width (mm²). */
  boxArea: number;
  /** The flat pattern's area, openings taken out (mm²). */
  area: number;
  /** Cutting length round the outside and round the openings (mm). */
  outer: number;
  inner: number;
  /** Openings inside the outline. */
  cutouts: number;
}

interface Loop { poly: V2[]; len: number }

const TAU = 2 * Math.PI;
const d2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ccwSweep = (a0: number, a1: number) => { let s = (a1 - a0) % TAU; if (s <= 1e-12) s += TAU; return s; };

/** Loops of the outline the Flat-Pattern feature stored (unordered edges, chained by their ends). */
function edgeLoops(edges: FlatEdge[]): Loop[] {
  const out: Loop[] = [];
  type Open = { a: V2; b: V2; pts: V2[]; len: number };
  const open: Open[] = [];
  for (const e of edges) {
    if (e.kind === "circle") { out.push({ poly: Array.from({ length: 48 }, (_x, i) => [e.c[0] + e.r * Math.cos((i * TAU) / 48), e.c[1] + e.r * Math.sin((i * TAU) / 48)] as V2), len: TAU * e.r }); continue; }
    if (e.kind === "line") { open.push({ a: e.a, b: e.b, pts: [e.a, e.b], len: d2(e.a, e.b) }); continue; }
    if (e.kind === "poly") { if (e.pts.length > 1) open.push({ a: e.pts[0], b: e.pts.at(-1)!, pts: e.pts, len: e.pts.slice(1).reduce((s, p, i) => s + d2(p, e.pts[i]), 0) }); continue; }
    const sw = ccwSweep(e.a0, e.a1), n = Math.max(2, Math.ceil(sw / (TAU / 48)));
    const pts = Array.from({ length: n + 1 }, (_x, i) => [e.c[0] + e.r * Math.cos(e.a0 + (sw * i) / n), e.c[1] + e.r * Math.sin(e.a0 + (sw * i) / n)] as V2);
    open.push({ a: pts[0], b: pts[n], pts, len: e.r * sw });
  }
  const size = Math.max(1, ...open.flatMap(o => [Math.abs(o.a[0]), Math.abs(o.a[1])]));
  const tol = size * 1e-5;
  while (open.length) {
    const first = open.shift()!;
    const pts = [...first.pts];
    let len = first.len;
    for (let guard = 0; guard < 100000 && d2(pts.at(-1)!, pts[0]) > tol; guard++) {
      const end = pts.at(-1)!;
      const i = open.findIndex(o => d2(o.a, end) < tol || d2(o.b, end) < tol);
      if (i < 0) break;
      const o = open.splice(i, 1)[0];
      pts.push(...(d2(o.a, end) < tol ? o.pts : [...o.pts].reverse()).slice(1));
      len += o.len;
    }
    if (pts.length > 2) out.push({ poly: pts.slice(0, -1), len });
  }
  return out;
}

const segLen = (s: Seg) => s.kind === "line" ? d2(s.a, s.b)
  : s.kind === "circle" ? TAU * s.r
  : s.kind === "arc" ? s.r * (s.ccw ? ccwSweep(Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0])) : ccwSweep(Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]), Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0])))
  : 0;

/** The flat pattern's outline as closed loops (polygons with their exact lengths). */
export function flatOutline(st: SheetState): Loop[] {
  if (st.flatEdges) return edgeLoops(st.flatEdges);
  const { outer, holes } = flatLoops(st);
  const loops = [...outer, ...holes].map(l => ({ poly: loopPolygon(l, 48), len: l.reduce((s, x) => s + segLen(x), 0) }));
  // An extruded hole's pre-pierce hole is part of the outline.
  for (const m of st.forms ?? []) if (m.pierce) loops.push({ poly: Array.from({ length: 48 }, (_x, i) => [m.c[0] + m.pierce! * Math.cos((i * TAU) / 48), m.c[1] + m.pierce! * Math.sin((i * TAU) / 48)] as V2), len: TAU * m.pierce });
  return loops;
}

function inside(p: V2, poly: V2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function hull(pts: V2[]): V2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [], hi: V2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2)!, lo.at(-1)!, q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2)!, hi.at(-1)!, q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** Smallest-area rectangle round the points: flat X first, then each hull edge direction (rotating calipers). */
export function minBox(pts: V2[]): { length: number; width: number; angle: number } {
  const h = hull(pts);
  const span = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of h) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    return { u: u1 - u0, v: v1 - v0 };
  };
  let best = { a: 0, ...span(0) };
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    let a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const s = span(a);
    // Keep the flat pattern's own axes unless a turn really saves area.
    if (s.u * s.v < best.u * best.v * (1 - 1e-9)) best = { a, ...s };
  }
  return best.u >= best.v ? { length: best.u, width: best.v, angle: best.a } : { length: best.v, width: best.u, angle: best.a + Math.PI / 2 };
}

/** The cut-list properties of a sheet metal body. */
export function sheetCutProps(st: SheetState): SheetCutProps {
  const loops = flatOutline(st);
  // A loop inside an odd number of others is an opening.
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && inside(l.poly[0], o.poly)).length);
  let area = 0, outer = 0, inner = 0, cutouts = 0;
  loops.forEach((l, i) => {
    const a = Math.abs(polyArea(l.poly));
    if (depth[i] % 2) { area -= a; inner += l.len; cutouts++; } else { area += a; outer += l.len; }
  });
  const box = minBox(loops.filter((_l, i) => depth[i] === 0).flatMap(l => l.poly));
  // A K-factor table: its K at the default radius and a right angle.
  const k = st.calc === "table" && st.table?.kind === "k" ? tableValue(st.table, st.R, Math.PI / 2) : st.k;
  return { T: st.T, R: st.R, k, bends: st.bends.length + (st.folds?.length ?? 0), ...box, boxArea: box.length * box.width, area, outer, inner, cutouts };
}

/** The rows shown and exported (English labels, translated when shown). */
export function cutPropRows(p: SheetCutProps, mass?: number): [string, number | null, "len" | "area" | "count" | "num" | "mass"][] {
  return [
    ["Bounding box length", p.length, "len"],
    ["Bounding box width", p.width, "len"],
    ["Sheet metal thickness", p.T, "len"],
    ["Bend radius", p.R, "len"],
    ["K-factor", p.k, "num"],
    ["Bounding box area", p.boxArea, "area"],
    ["Flat pattern area", p.area, "area"],
    ["Cutting length - outer", p.outer, "len"],
    ["Cutting length - inner", p.inner, "len"],
    ["Cut outs", p.cutouts, "count"],
    ["Bends", p.bends, "count"],
    ["Mass", mass ?? null, "mass"],
  ];
}

/** CSV of the rows, in millimetres and kilograms. */
export function cutPropsCsv(p: SheetCutProps, mass?: number): string {
  const unit = { len: "mm", area: "mm²", count: "", num: "", mass: "kg" } as const;
  const r = (x: number) => String(Math.round(x * 1e6) / 1e6);
  return ["Property,Value,Unit", ...cutPropRows(p, mass).filter(x => x[1] != null).map(([k, v, q]) => `${k},${r(q === "mass" ? v! / 1000 : v!)},${unit[q]}`)].join("\n") + "\n";
}
