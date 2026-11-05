// Cut profile of a section plane as a 2D drawing: DXF (R12, millimetres) for 2D
// CAD, laser or waterjet, and SVG. Circles and arcs stay true circles and arcs;
// lines stay lines; other curves become polylines.
import * as THREE from "three";
import type { V3 } from "../topology";
import type { SectionPlane } from "../viewer/Section";
import type { Viewer } from "../viewer/Viewer";

type P2 = [number, number];
export type Entity2 =
  | { kind: "line"; a: P2; b: P2; layer: string }
  | { kind: "circle"; c: P2; r: number; layer: string }
  /** Counter-clockwise from a0 to a1 (radians), as DXF draws arcs. */
  | { kind: "arc"; c: P2; r: number; a0: number; a1: number; layer: string }
  | { kind: "poly"; pts: P2[]; closed: boolean; layer: string };

export interface Drawing2 {
  entities: Entity2[];
  /** Drawing axes in world space: x to the right, y up, looking along -n. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  min: P2;
  max: P2;
}

/** Axes for the plane's drawing: XY, YZ and XZ planes use the world axes; others keep world Z up where they can. */
export function planeAxes(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const a = axis.clone().normalize();
  const near = (x: number, y: number, z: number) => Math.abs(a.dot(new THREE.Vector3(x, y, z))) > 1 - 1e-9;
  if (near(0, 0, 1)) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  if (near(1, 0, 0)) return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  if (near(0, 1, 0)) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  let v = new THREE.Vector3(0, 0, 1).addScaledVector(a, -a.z);
  if (v.lengthSq() < 1e-12) v = new THREE.Vector3(0, 1, 0).addScaledVector(a, -a.y);
  v.normalize();
  const u = new THREE.Vector3().crossVectors(v, a).normalize();
  return [u, v];
}

/** The plane's cut curves in drawing coordinates (mm), one layer per part. */
export function profileDrawing(view: Viewer, sp: SectionPlane): Drawing2 | null {
  const res = sp.result;
  if (!res || !res.profiles.length) return null;
  const [u, v] = planeAxes(sp.axis);
  const w = new THREE.Vector3().crossVectors(u, v);
  const entities: Entity2[] = [];
  const min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
  const grow = (p: P2, r = 0) => { min[0] = Math.min(min[0], p[0] - r); min[1] = Math.min(min[1], p[1] - r); max[0] = Math.max(max[0], p[0] + r); max[1] = Math.max(max[1], p[1] + r); };
  for (const prof of res.profiles) {
    const part = prof.part;
    const layer = layerName(part.data.name || `Part ${part.idx + 1}`, part.idx);
    const to2 = (p: V3 | number[]): P2 => { const q = view.toWorld(part, p as V3); return [q.dot(u), q.dot(v)]; };
    for (const e of prof.edges) {
      const pts: P2[] = [];
      for (let i = 0; i + 2 < e.pts.length; i += 3) pts.push(to2([e.pts[i], e.pts[i + 1], e.pts[i + 2]]));
      if (pts.length < 2) continue;
      if ((e.type === "circle" || e.type === "arc") && e.center && e.radius && (!e.axis || Math.abs(new THREE.Vector3(...e.axis).dot(w)) > 1 - 1e-6)) {
        const c = to2(e.center);
        grow(c, e.radius);
        if (e.type === "circle") { entities.push({ kind: "circle", c, r: e.radius, layer }); continue; }
        let a0 = Math.atan2(pts[0][1] - c[1], pts[0][0] - c[0]), a1 = Math.atan2(pts.at(-1)![1] - c[1], pts.at(-1)![0] - c[0]);
        if (turn(pts, c) < 0) [a0, a1] = [a1, a0];
        entities.push({ kind: "arc", c, r: e.radius, a0, a1, layer });
        continue;
      }
      pts.forEach(p => grow(p));
      if (e.type === "line") entities.push({ kind: "line", a: pts[0], b: pts.at(-1)!, layer });
      else entities.push({ kind: "poly", pts: e.closed ? pts.slice(0, -1) : pts, closed: e.closed, layer });
    }
  }
  const out = joinArcs(entities);
  return out.length ? { entities: out, u, v, min, max } : null;
}

/** Arcs on one circle that together go all the way round (a hole cut as two halves) become one circle. */
function joinArcs(entities: Entity2[]): Entity2[] {
  const groups: Extract<Entity2, { kind: "arc" }>[][] = [];
  for (const e of entities) {
    if (e.kind !== "arc") continue;
    // Halves fitted from the tessellation can differ in the fourth decimal.
    const tol = 1e-3 * Math.max(1, e.r);
    const g = groups.find(g => g[0].layer === e.layer && Math.abs(g[0].r - e.r) < tol && Math.hypot(g[0].c[0] - e.c[0], g[0].c[1] - e.c[1]) < tol);
    if (g) g.push(e); else groups.push([e]);
  }
  const drop = new Set<Entity2>(), add = new Map<Entity2, Entity2>();
  for (const g of groups) {
    if (g.length < 2) continue;
    const sweep = g.reduce((s, a) => { let d = a.a1 - a.a0; while (d <= 0) d += 2 * Math.PI; return s + d; }, 0);
    if (Math.abs(sweep - 2 * Math.PI) > 0.02) continue;
    g.forEach(a => drop.add(a));
    const avg = (f: (a: (typeof g)[number]) => number) => g.reduce((s, a) => s + f(a), 0) / g.length;
    add.set(g[0], { kind: "circle", c: [avg(a => a.c[0]), avg(a => a.c[1])], r: avg(a => a.r), layer: g[0].layer });
  }
  return entities.flatMap(e => (add.has(e) ? [add.get(e)!] : drop.has(e) ? [] : [e]));
}

/** Signed turning of a polyline about c (positive: counter-clockwise). */
function turn(pts: P2[], c: P2) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.atan2(pts[i][1] - c[1], pts[i][0] - c[0]) - Math.atan2(pts[i - 1][1] - c[1], pts[i - 1][0] - c[0]);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    s += d;
  }
  return s;
}

/** DXF layer names: letters, digits, _ and -, at most 31 characters (R12). */
function layerName(name: string, idx: number) {
  const clean = name.normalize("NFKD").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).toUpperCase();
  return `${clean || "PART"}_${idx + 1}`;
}

const n = (x: number) => (Math.abs(x) < 5e-10 ? "0" : x.toFixed(6).replace(/\.?0+$/, ""));
const deg = (a: number) => n((((a * 180) / Math.PI) % 360 + 360) % 360);

/** AutoCAD R12 ASCII DXF, millimetres. */
export function toDxf(d: Drawing2, title: string): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? n(value) : value);
  g(999, `MöbiusCAD section profile: ${title}`.replace(/[\r\n]+/g, " "));
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, "4");
  g(9, "$EXTMIN"); g(10, d.min[0]); g(20, d.min[1]); g(30, 0);
  g(9, "$EXTMAX"); g(10, d.max[0]); g(20, d.max[1]); g(30, 0);
  g(0, "ENDSEC");
  const layers = [...new Set(d.entities.map(e => e.layer))];
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, String(layers.length));
  for (const l of layers) { g(0, "LAYER"); g(2, l); g(70, "0"); g(62, "7"); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const e of d.entities) {
    if (e.kind === "line") { g(0, "LINE"); g(8, e.layer); g(10, e.a[0]); g(20, e.a[1]); g(30, 0); g(11, e.b[0]); g(21, e.b[1]); g(31, 0); }
    else if (e.kind === "circle") { g(0, "CIRCLE"); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); }
    else if (e.kind === "arc") { g(0, "ARC"); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, deg(e.a0)); g(51, deg(e.a1)); }
    else {
      g(0, "POLYLINE"); g(8, e.layer); g(66, "1"); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? "1" : "0");
      for (const p of e.pts) { g(0, "VERTEX"); g(8, e.layer); g(10, p[0]); g(20, p[1]); g(30, 0); }
      g(0, "SEQEND"); g(8, e.layer);
    }
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return out.join("\n") + "\n";
}

/** SVG at 1:1 in millimetres (y up in the model, so y is flipped). */
export function toSvg(d: Drawing2, title: string): string {
  const pad = Math.max(d.max[0] - d.min[0], d.max[1] - d.min[1]) * 0.02 || 1;
  const x0 = d.min[0] - pad, y0 = d.min[1] - pad, W = d.max[0] - d.min[0] + 2 * pad, H = d.max[1] - d.min[1] + 2 * pad;
  const X = (x: number) => n(x - x0), Y = (y: number) => n(H - (y - y0));
  const sw = n(Math.max(W, H) / 800);
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = d.entities.map(e => {
    if (e.kind === "line") return `<line x1="${X(e.a[0])}" y1="${Y(e.a[1])}" x2="${X(e.b[0])}" y2="${Y(e.b[1])}"/>`;
    if (e.kind === "circle") return `<circle cx="${X(e.c[0])}" cy="${Y(e.c[1])}" r="${n(e.r)}"/>`;
    if (e.kind === "arc") {
      const p0: P2 = [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)], p1: P2 = [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)];
      let sweep = e.a1 - e.a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      // Counter-clockwise in the model is clockwise on screen (y flipped): sweep flag 0.
      return `<path d="M${X(p0[0])} ${Y(p0[1])}A${n(e.r)} ${n(e.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(p1[0])} ${Y(p1[1])}"/>`;
    }
    return `<poly${e.closed ? "gon" : "line"} points="${e.pts.map(p => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}mm" height="${n(H)}mm" viewBox="0 0 ${n(W)} ${n(H)}">
<title>${esc(title)}</title>
<g fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
${body.join("\n")}
</g>
</svg>
`;
}
