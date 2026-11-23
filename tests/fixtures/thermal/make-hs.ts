// Makes amp-heatsink.step: the EL84 test board of make.ts with an aluminium heatsink block against the
// transistor Q2's side (FR-TBRD-003/004), for the heatsink share of a board study. Open it with amp-thermal.zip.
// Run: node bench/run.mjs tests/fixtures/thermal/make-hs.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { occ } from "../../unit/occ";
import { Kernel } from "../../../src/kernel/occ";

const dir = join(process.cwd(), "tests/fixtures/thermal");
type Box = [number, number, number, number, number, number];
// the bodies of make.ts (keep in step with its PARTS), then the heatsink
const BODIES: { name: string; box: Box; round?: boolean; color: [number, number, number] }[] = [
  { name: "Board", box: [0, 0, 0, 120, 80, 1.6], color: [0.1, 0.4, 0.2] },
  { name: "V3", box: [34, 51, 1.6, 56, 73, 61.6], round: true, color: [0.75, 0.8, 0.85] },
  { name: "R14", box: [33, 26.75, 2, 57, 33.25, 8.5], color: [0.85, 0.82, 0.7] },
  { name: "Q2", box: [100, 4, 1.6, 110.4, 8.6, 16.6], color: [0.15, 0.15, 0.17] },
  { name: "C12", box: [66, 47, 1.6, 82, 63, 33.6], round: true, color: [0.1, 0.2, 0.5] },
  { name: "R20", box: [70, 20, 2, 88, 25, 7], color: [0.85, 0.82, 0.7] },
  { name: "C13", box: [90, 30, 1.6, 100, 40, 14.1], round: true, color: [0.1, 0.2, 0.5] },
  { name: "Heatsink", box: [98, 8.6, 4, 112.4, 22, 30], color: [0.7, 0.7, 0.72] },
];
const oc = await occ();
const solid = (b: Box, round?: boolean) => {
  if (!round) return new oc.BRepPrimAPI_MakeBox_4(new oc.gp_Pnt_3(b[0], b[1], b[2]), new oc.gp_Pnt_3(b[3], b[4], b[5])).Shape();
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[2]), new oc.gp_Dir_4(0, 0, 1));
  return new oc.BRepPrimAPI_MakeCylinder_3(ax, (b[3] - b[0]) / 2, b[5] - b[2]).Shape();
};
const k = new Kernel(oc);
k.meshes = BODIES.map(b => ({ shape: solid(b.box, b.round), faces: [], name: b.name, color: b.color, solid: true }));
const stp = k.writeStep(k.meshes.map((_, i) => i)).slice();
writeFileSync(join(dir, "amp-heatsink.step"), stp);
console.log(`STEP ${stp.length} bytes`);
process.exit(0);
