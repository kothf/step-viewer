// Shared instance meshes (FR-ASM-031): a part is analysed once (welding, B-rep faces and edges, exact
// values) in its own coordinates, and every component of it gets a rigid copy of that analysis instead
// of analysing its transformed mesh again. Large assemblies of repeated parts load in a fraction of the time.
import type { EdgeInfo, FaceInfo, PartData } from "../topology";
import type { V3 } from "../model/types";
import type { Tf } from "./types";

const P = (t: Tf, p: V3): V3 => [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]];
const D = (t: Tf, d: V3): V3 => [t[0] * d[0] + t[1] * d[1] + t[2] * d[2], t[4] * d[0] + t[5] * d[1] + t[6] * d[2], t[8] * d[0] + t[9] * d[1] + t[10] * d[2]];

function points(t: Tf, a: ArrayLike<number>, out: { length: number; [i: number]: number }, dir = false) {
  for (let i = 0; i + 2 < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    out[i] = t[0] * x + t[1] * y + t[2] * z + (dir ? 0 : t[3]);
    out[i + 1] = t[4] * x + t[5] * y + t[6] * z + (dir ? 0 : t[7]);
    out[i + 2] = t[8] * x + t[9] * y + t[10] * z + (dir ? 0 : t[11]);
  }
}

/** A part's analysis moved by a rigid transform: points and directions move, sizes stay; the index is shared. */
export function transformPart(d: PartData, t: Tf, name = d.name): PartData {
  const positions = new Float32Array(d.positions.length), normals = new Float32Array(d.normals.length), edgeSegs = new Float32Array(d.edgeSegs.length);
  points(t, d.positions, positions);
  points(t, d.normals, normals, true);
  points(t, d.edgeSegs, edgeSegs);
  const opt = (v: V3 | undefined, dir: boolean) => (v ? (dir ? D(t, v) : P(t, v)) : undefined);
  const faces: FaceInfo[] = d.faces.map(f => {
    const g: FaceInfo = { ...f, centroid: P(t, f.centroid), center: P(t, f.center), edges: f.edges };
    if (f.normal) g.normal = D(t, f.normal);
    if (f.axis) g.axis = D(t, f.axis);
    return g;
  });
  const edges: EdgeInfo[] = d.edges.map(e => {
    const pts = new Array<number>(e.pts.length);
    points(t, e.pts, pts);
    const g: EdgeInfo = { ...e, pts, start: P(t, e.start), end: P(t, e.end), mid: P(t, e.mid) };
    if (e.dir) g.dir = opt(e.dir, true);
    if (e.center) g.center = opt(e.center, false);
    if (e.axis) g.axis = opt(e.axis, true);
    return g;
  });
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  if (!positions.length) { lo.fill(0); hi.fill(0); }
  return { ...d, name, positions, normals, edgeSegs, faces, edges, com: P(t, d.com), bboxMin: lo, bboxMax: hi, colors: d.colors ? d.colors.slice() : null };
}
