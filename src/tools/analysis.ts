import * as THREE from "three";
import type { Part, Viewer } from "../viewer/Viewer";
import { combine, rotateSym, type Combined, type MassBody, type V3 } from "./inertia";

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

export interface MassResult extends Combined {
  /** Centre of mass, world mm. */
  com3: THREE.Vector3;
  bbox: THREE.Vector3; bboxVolume: number;
  openParts: string[]; parts: number;
  /** The densities used (g/cm³), each once. */
  densities: number[];
}

/**
 * Mass properties of parts (FR-MAT-002): volume, area, mass, centre of mass and the mass
 * covariance about it, from each part's exact or tessellated second moments, moved where
 * the part is shown. `density` in g/cm³, one for all or per part (part materials).
 */
export function massProperties(v: Viewer, parts: Part[], density: number | ((p: Part) => number)): MassResult {
  const b = new THREE.Box3();
  const openParts: string[] = [];
  const bodies: MassBody[] = [];
  const dens = new Set<number>();
  for (const p of parts) {
    const d = p.data;
    b.expandByObject(p.mesh);
    if (!d.closed) openParts.push(d.name);
    p.group.updateMatrix();
    const e = p.group.matrix.elements;
    const R = [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]];
    const c = new THREE.Vector3(...d.com).applyMatrix4(p.group.matrix);
    const rho = typeof density === "number" ? density : density(p);
    dens.add(rho);
    bodies.push({ volume: d.volume, area: d.area, com: c.toArray() as V3, cov: d.inertia ? rotateSym(d.inertia, R) : undefined, density: rho });
  }
  const r = combine(bodies);
  const size = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
  return { ...r, com3: new THREE.Vector3(...r.com), bbox: size, bboxVolume: size.x * size.y * size.z, openParts, parts: parts.length, densities: [...dens] };
}
