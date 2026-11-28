// Mate references beside faces (FR-MATE-001): straight and circular edges, vertices, cones, spheres and a
// component's own origin planes, axes and point. A reference is stored as a MateRef's `face` string, so files
// keep their shape: a face name, `@e:<face>|<face>` (an edge by the faces it joins), `@v:<faces>` (a vertex by
// the faces meeting there) or `@o:XY|YZ|ZX|X|Y|Z|O` (the part's origin).
import type { PartData } from "../topology";
import type { Geo } from "./solver";
import type { V3 } from "../model/types";

export const ORIGIN_REFS = ["XY", "YZ", "ZX", "X", "Y", "Z", "O"] as const;
export type OriginRef = (typeof ORIGIN_REFS)[number];

/** The part's origin entity as mate geometry (part coordinates). */
export function originGeo(k: OriginRef): Geo {
  const o: V3 = [0, 0, 0];
  switch (k) {
    case "XY": return { k: "plane", p: o, n: [0, 0, 1] };
    case "YZ": return { k: "plane", p: o, n: [1, 0, 0] };
    case "ZX": return { k: "plane", p: o, n: [0, 1, 0] };
    case "X": return { k: "axis", p: o, d: [1, 0, 0], r: 0 };
    case "Y": return { k: "axis", p: o, d: [0, 1, 0], r: 0 };
    case "Z": return { k: "axis", p: o, d: [0, 0, 1], r: 0 };
    default: return { k: "point", p: o, r: 0 };
  }
}

export type RefKind = "face" | "edge" | "vertex" | "origin";
export const refKind = (face: string): RefKind => (face.startsWith("@e:") ? "edge" : face.startsWith("@v:") ? "vertex" : face.startsWith("@o:") ? "origin" : "face");
export const originOf = (face: string): OriginRef | null => (face.startsWith("@o:") && (ORIGIN_REFS as readonly string[]).includes(face.slice(3)) ? (face.slice(3) as OriginRef) : null);
export const edgeRef = (a: string, b: string) => `@e:${[a, b].sort().join("|")}`;
export const vertexRef = (faces: Iterable<string>) => `@v:${[...new Set(faces)].sort().join("|")}`;

const unit = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Every reference of a part with its geometry, mapped into part coordinates by `pt`/`dir` (the shown mesh is
 * placed by its component). Faces: planes, cylinders, cones (their axis), spheres (centre and radius). Edges:
 * straight ones as lines, circles and arcs as circles. Vertices: the ends of edges, by the faces meeting there.
 * Edge and vertex keys that come out twice (two edges between the same faces) keep the first.
 */
export function partRefs(d: PartData, names: string[], pt: (p: V3) => V3, dir: (v: V3) => V3): Map<string, Geo> {
  const m = new Map<string, Geo>();
  d.faces.forEach((f, j) => {
    const name = names[j];
    if (!name || m.has(name)) return;
    if (f.type === "plane" && f.normal) m.set(name, { k: "plane", p: pt(f.centroid), n: unit(dir(f.normal)) });
    else if (f.type === "cylinder" && f.axis) m.set(name, { k: "axis", p: pt(f.center), d: unit(dir(f.axis)), r: f.radius ?? 0 });
    else if (f.cone) m.set(name, { k: "axis", p: pt(f.cone.o), d: unit(dir(f.cone.a)), r: f.cone.r });
    else if (f.type === "sphere" && f.radius) m.set(name, { k: "point", p: pt(f.center), r: f.radius });
  });
  // Vertices: edge ends welded by place, with every face of the edges ending there.
  const size = Math.hypot(d.bboxMax[0] - d.bboxMin[0], d.bboxMax[1] - d.bboxMin[1], d.bboxMax[2] - d.bboxMin[2]) || 1;
  const tol = size * 1e-6, cell = tol * 4;
  const ends = new Map<string, { p: V3; faces: Set<string> }[]>();
  const keyOf = (p: V3) => `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)},${Math.round(p[2] / cell)}`;
  const endAt = (p: V3, fa: string, fb: string) => {
    const k = keyOf(p);
    let list = ends.get(k);
    if (!list) ends.set(k, (list = []));
    let e = list.find(x => Math.hypot(x.p[0] - p[0], x.p[1] - p[1], x.p[2] - p[2]) <= tol * 4);
    if (!e) list.push((e = { p, faces: new Set() }));
    e.faces.add(fa); e.faces.add(fb);
  };
  for (const e of d.edges) {
    const a = names[e.faces[0]], b = names[e.faces[1]];
    if (!a || !b || a === b) continue;
    const key = edgeRef(a, b);
    if (!m.has(key)) {
      if (e.type === "line" && e.dir) m.set(key, { k: "axis", p: pt(e.mid), d: unit(dir(e.dir)), r: 0 });
      else if ((e.type === "circle" || e.type === "arc") && e.center && e.axis && e.radius) m.set(key, { k: "axis", p: pt(e.center), d: unit(dir(e.axis)), r: e.radius, c: true });
    }
    if (!e.closed) { endAt(e.start, a, b); endAt(e.end, a, b); }
  }
  for (const list of ends.values()) for (const v of list) {
    if (v.faces.size < 3) continue;
    const key = vertexRef(v.faces);
    if (!m.has(key)) m.set(key, { k: "point", p: pt(v.p), r: 0 });
  }
  for (const k of ORIGIN_REFS) m.set(`@o:${k}`, originGeo(k));
  return m;
}
