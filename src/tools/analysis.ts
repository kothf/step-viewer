import * as THREE from "three";
import type { Part, Viewer } from "../viewer/Viewer";
import { LIBRARY, type Material } from "./materials";
import { combine, rotateSym, type Combined, type MassBody, type V3 } from "./inertia";

/** The built-in material library (see materials.ts); kept under this name for its older users. */
export const MATERIALS: Material[] = LIBRARY;

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
export function massProperties(v: Viewer, parts: Part[], density: number | ((p: Part) => number | MassBody[])): MassResult {
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
    if (typeof rho !== "number") {
      // Bodies with their own materials (FR-MAT-001), in the part data's coordinates; the area stays the part's.
      rho.forEach((o, i) => {
        dens.add(o.density);
        bodies.push({ ...o, area: i ? 0 : d.area, com: new THREE.Vector3(...o.com).applyMatrix4(p.group.matrix).toArray() as V3, cov: o.cov && rotateSym(o.cov, R) });
      });
      continue;
    }
    dens.add(rho);
    bodies.push({ volume: d.volume, area: d.area, com: c.toArray() as V3, cov: d.inertia ? rotateSym(d.inertia, R) : undefined, density: rho });
  }
  const r = combine(bodies);
  const size = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
  return { ...r, com3: new THREE.Vector3(...r.com), bbox: size, bboxVolume: size.x * size.y * size.z, openParts, parts: parts.length, densities: [...dens] };
}
