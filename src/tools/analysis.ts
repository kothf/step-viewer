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
