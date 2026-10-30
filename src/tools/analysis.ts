import * as THREE from "three";
import type { Part, Viewer } from "../viewer/Viewer";

export const MATERIALS: { name: string; density: number }[] = [
  { name: "Steel (carbon)", density: 7.85 },
  { name: "Stainless steel 304", density: 8.0 },
  { name: "Aluminium 6061", density: 2.7 },
  { name: "Brass", density: 8.5 },
  { name: "Copper", density: 8.96 },
  { name: "Titanium Ti-6Al-4V", density: 4.43 },
  { name: "Cast iron", density: 7.2 },
  { name: "ABS", density: 1.04 },
  { name: "PLA", density: 1.24 },
  { name: "Nylon PA6", density: 1.14 },
  { name: "Polycarbonate", density: 1.2 },
  { name: "POM (Delrin)", density: 1.41 },
  { name: "PEEK", density: 1.32 },
  { name: "Wood (oak)", density: 0.75 },
];

export interface MassResult {
  volume: number; area: number; mass: number;
  com: THREE.Vector3; bbox: THREE.Vector3; bboxVolume: number;
  openParts: string[]; parts: number;
}

/** Volume via the divergence theorem on each closed tessellated solid; density in g/cm³. */
export function massProperties(v: Viewer, parts: Part[], density: number): MassResult {
  let volume = 0, area = 0;
  const com = new THREE.Vector3();
  const b = new THREE.Box3();
  const openParts: string[] = [];
  for (const p of parts) {
    const d = p.data;
    area += d.area;
    b.expandByObject(p.mesh);
    if (!d.closed) openParts.push(d.name);
    volume += d.volume;
    com.addScaledVector(v.toWorld(p, d.com), d.volume);
  }
  if (volume > 0) com.divideScalar(volume);
  const size = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
  return { volume, area, mass: (volume / 1000) * density, com, bbox: size, bboxVolume: size.x * size.y * size.z, openParts, parts: parts.length };
}

// ---------- analysis colouring ----------

const analysisMats = new WeakMap<Part, THREE.MeshLambertMaterial>();
const savedColor = new WeakMap<Part, THREE.BufferAttribute | undefined>();

function applyColors(v: Viewer, p: Part, colors: Float32Array) {
  const g = p.mesh.geometry;
  if (!savedColor.has(p)) savedColor.set(p, g.getAttribute("color") as THREE.BufferAttribute | undefined);
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  let m = analysisMats.get(p);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    analysisMats.set(p, m);
  }
  m.clippingPlanes = v.clipPlanes;
  p.mesh.material = m;
}

export function clearAnalysis(v: Viewer) {
  for (const p of v.parts) {
    if (p.mesh.material === p.material) continue;
    const g = p.mesh.geometry;
    const old = savedColor.get(p);
    if (old) g.setAttribute("color", old); else g.deleteAttribute("color");
    savedColor.delete(p);
    p.mesh.material = p.material;
  }
  v.invalidate();
}

const GREEN = new THREE.Color(0x22a55a), RED = new THREE.Color(0xd8423a), YELLOW = new THREE.Color(0xf0c419);

/** Draft angle = asin(n·pull). Green ≥ +min, red ≤ −min, yellow in between (needs draft). */
export function draftAnalysis(v: Viewer, pull: THREE.Vector3, minDeg: number) {
  const d = pull.clone().normalize();
  const stats = { positive: 0, negative: 0, insufficient: 0 };
  for (const p of v.parts) {
    if (!p.visible) continue;
    const N = p.data.normals;
    const n = N.length / 3;
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const dot = N[3 * i] * d.x + N[3 * i + 1] * d.y + N[3 * i + 2] * d.z;
      const ang = (Math.asin(THREE.MathUtils.clamp(dot, -1, 1)) * 180) / Math.PI;
      if (ang >= minDeg) { c.copy(GREEN); stats.positive++; }
      else if (ang <= -minDeg) { c.copy(RED); stats.negative++; }
      else {
        stats.insufficient++;
        // Fade from yellow (vertical wall) toward green/red as it approaches the limit.
        const k = Math.abs(ang) / Math.max(minDeg, 1e-6);
        c.copy(YELLOW).lerp(ang >= 0 ? GREEN : RED, k * 0.45);
      }
      colors[3 * i] = c.r; colors[3 * i + 1] = c.g; colors[3 * i + 2] = c.b;
    }
    applyColors(v, p, colors);
  }
  v.invalidate();
  return stats;
}

function thicknessColor(t: number, tMin: number, tMax: number, out: THREE.Color) {
  if (!isFinite(t)) return out.set(0x9aa3b2);
  const k = THREE.MathUtils.clamp((t - tMin) / Math.max(tMax - tMin, 1e-9), 0, 1);
  // red (thin) → yellow → green → blue (thick)
  return out.setHSL(k * 0.66, 0.85, 0.5);
}

export interface ThicknessResult { min: number; at: THREE.Vector3 | null; thin: number; samples: number }

/**
 * Ray-casting wall thickness: from each triangle centroid shoot a ray into the
 * material (against the face normal) and take the distance to where it exits.
 * Centroids, not vertices, so rays never graze the neighbouring faces at an edge.
 */
export async function thicknessAnalysis(v: Viewer, tMin: number, tMax: number, onProgress: (f: number) => void, signal: { cancelled: boolean }): Promise<ThicknessResult> {
  const parts = v.parts.filter(p => p.visible && p.data.closed);
  const total = parts.reduce((s, p) => s + p.data.index.length / 3, 0);
  let done = 0;
  const res: ThicknessResult = { min: Infinity, at: null, thin: 0, samples: 0 };
  const ray = new THREE.Ray();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3(), n = new THREE.Vector3(), o = new THREE.Vector3();
  const c = new THREE.Color();
  for (const p of parts) {
    const P = p.data.positions, N = p.data.normals, I = p.data.index;
    const triCount = I.length / 3;
    const values = new Float32Array(P.length / 3).fill(Infinity);
    const bvh = p.mesh.geometry.boundsTree!;
    const eps = v.modelSize * 1e-6;
    for (let t = 0; t < triCount; t++) {
      const i0 = I[3 * t], i1 = I[3 * t + 1], i2 = I[3 * t + 2];
      a.fromArray(P, 3 * i0); b.fromArray(P, 3 * i1); c3.fromArray(P, 3 * i2);
      o.copy(a).add(b).add(c3).divideScalar(3);
      n.set(N[3 * i0] + N[3 * i1] + N[3 * i2], N[3 * i0 + 1] + N[3 * i1 + 1] + N[3 * i2 + 1], N[3 * i0 + 2] + N[3 * i1 + 2] + N[3 * i2 + 2]).normalize();
      ray.origin.copy(o).addScaledVector(n, -eps);
      ray.direction.copy(n).negate();
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      const d = hit && hit.distance > eps ? hit.distance + eps : Infinity;
      for (const i of [i0, i1, i2]) if (d < values[i]) values[i] = d;
      if (isFinite(d)) {
        res.samples++;
        if (d < tMin) res.thin++;
        if (d < res.min) { res.min = d; res.at = v.toWorld(p, o.clone()); }
      }
      if (++done % 4000 === 0) {
        onProgress(done / total);
        await new Promise(r => setTimeout(r, 0));
        if (signal.cancelled) return res;
      }
    }
    const colors = new Float32Array(values.length * 3);
    for (let i = 0; i < values.length; i++) {
      thicknessColor(values[i], tMin, tMax, c);
      colors[3 * i] = c.r; colors[3 * i + 1] = c.g; colors[3 * i + 2] = c.b;
    }
    applyColors(v, p, colors);
    v.invalidate();
  }
  onProgress(1);
  return res;
}
