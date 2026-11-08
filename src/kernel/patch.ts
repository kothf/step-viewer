// Probes (what the main thread knows about a part's tessellation) and patches
// (exact values from the kernel written into the part). Shared by the viewer's
// kernel client and the modelling worker.
import type { EdgeInfo, FaceInfo, PartData, V3 } from "../topology";
import type { PartPatch, PartProbe } from "./occ";

// ---------- probes and patches ----------

const SAMPLES = 16;
const MAX_SAMPLED_FACES = 4000;

/** What the worker needs to check and match one part. */
export function probe(d: PartData): PartProbe {
  const samples: [number, number[]][] = [];
  for (const f of d.faces) {
    if (f.type !== "other" || !f.triCount || samples.length >= MAX_SAMPLED_FACES) continue;
    const pts: number[] = [];
    const step = Math.max(1, Math.floor((f.triCount * 3) / SAMPLES));
    for (let k = f.triStart * 3; k < (f.triStart + f.triCount) * 3 && pts.length < SAMPLES * 3; k += step) {
      const i = d.index[k] * 3;
      pts.push(d.positions[i], d.positions[i + 1], d.positions[i + 2]);
    }
    samples.push([f.id, pts]);
  }
  return {
    faces: d.faces.length,
    faceArea: d.faces.map(f => f.area),
    samples,
    edges: d.edges.map(e => ({ faces: e.faces, length: e.length, mid: e.mid, start: e.start, end: e.end, closed: e.closed })),
  };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Writes exact values into the part. Returns false when nothing could be used. */
export function applyPatch(d: PartData, p: PartPatch): boolean {
  if (!p.ok) return false;
  if (p.volume !== undefined && d.closed) { d.volume = p.volume; if (p.com) d.com = p.com; }
  if (p.area !== undefined) d.area = p.area;
  p.faces?.forEach((fp, i) => { const f = d.faces[i]; if (fp && f) patchFace(f, fp); });
  p.edges?.forEach((ep, i) => { const e = d.edges[i]; if (ep && e) patchEdge(e, ep); });
  d.exact = true;
  return true;
}

function patchFace(f: FaceInfo, fp: NonNullable<PartPatch["faces"]>[number] & object) {
  f.area = fp.area;
  f.surface = fp.type;
  if (fp.type === "cylinder" && f.type !== "cylinder" && f.type !== "plane" && fp.axis && fp.center && fp.radius) {
    // The mesh fit missed it (a short boss read as a sphere, a hole cut by a cross hole as "other"): the B-rep knows.
    const a = fp.axis, c = fp.center, w: V3 = [f.centroid[0] - c[0], f.centroid[1] - c[1], f.centroid[2] - c[2]];
    const t = dot(w, a);
    f.type = "cylinder";
    f.center = [c[0] + a[0] * t, c[1] + a[1] * t, c[2] + a[2] * t];
    f.axis = a;
    f.radius = fp.radius;
  } else if (fp.type === "cylinder" && f.type === "cylinder" && fp.axis && fp.center && fp.radius) {
    // Keep our centre (the middle of the face along its axis), moved onto the exact axis.
    const a = fp.axis, c = fp.center, w: V3 = [f.center[0] - c[0], f.center[1] - c[1], f.center[2] - c[2]];
    const t = dot(w, a);
    f.center = [c[0] + a[0] * t, c[1] + a[1] * t, c[2] + a[2] * t];
    f.axis = dot(a, f.axis ?? a) < 0 ? [-a[0], -a[1], -a[2]] : a;
    f.radius = fp.radius;
  } else if (fp.type === "sphere" && f.type === "sphere" && fp.center && fp.radius) {
    f.center = fp.center;
    f.radius = fp.radius;
  } else if (fp.type === "cone" || fp.type === "torus") {
    f.coneAngle = fp.angle;
    f.torus = fp.type === "torus" && fp.radius && fp.minor ? [fp.radius, fp.minor] : undefined;
  }
  if (fp.kMin !== undefined && fp.kMax !== undefined) f.curvature = [fp.kMin, fp.kMax];
}

function patchEdge(e: EdgeInfo, ep: NonNullable<PartPatch["edges"]>[number] & object) {
  e.length = ep.length;
  e.exact = true;
  if ((ep.type === "circle" || ep.type === "arc") && ep.radius && ep.center && ep.axis && e.type !== "line") {
    e.type = ep.type;
    e.radius = ep.radius;
    e.center = ep.center;
    e.axis = dot(ep.axis, e.axis ?? ep.axis) < 0 ? [-ep.axis[0], -ep.axis[1], -ep.axis[2]] : ep.axis;
    e.sweep = ep.sweep;
  } else if (ep.type === "ellipse") e.ellipse = true;
}
