// What weldment features refer to (for parents, dependants, reorder checks and rebuild order).
import type { Feature } from "../model/types";

export function weldRefs(f: Feature, faces: string[], features: string[]) {
  if (f.type === "member") {
    for (const s of f.segs) if (!features.includes(s.sketch)) features.push(s.sketch);
    if (f.profile === "sketch" && f.psketch && !features.includes(f.psketch)) features.push(f.psketch);
  }
  if (f.type === "trimext") { faces.push(...f.bodies.map(x => x.name)); if (f.boundary) faces.push(f.boundary.name); if (f.plane && "plane" in f.plane && !features.includes(f.plane.plane)) features.push(f.plane.plane); if (f.plane && "face" in f.plane) faces.push(f.plane.face.name); }
  if (f.type === "endcap") faces.push(...f.faces.map(x => x.name));
  if (f.type === "gusset") { if (f.face1) faces.push(f.face1.name); if (f.face2) faces.push(f.face2.name); }
  if (f.type === "weldbead") faces.push(...f.faces1.map(x => x.name), ...f.faces2.map(x => x.name));
}
