// Time of reading an assembly's geometry for a study, per component:
//   node bench/run.mjs bench/asmgeo.bench.ts <file.mcadasm>
import { readFileSync } from "node:fs";
import { Assembler } from "../src/kernel/assembly";
import { asmSimGeometry } from "../src/kernel/simgeo";
import { unpackAsm } from "../src/asm/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const oc = await init();
const b = readFileSync(process.argv[2]);
const doc = await unpackAsm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let t = performance.now();
const asm = new Assembler(oc);
const { placed } = asm.evaluate(doc, 1);
console.log(`evaluate ${((performance.now() - t) / 1000).toFixed(1)} s, ${placed.length} placed`);
const only = process.env.ASMGEO_ONLY, lin = Number(process.env.ASMGEO_LIN ?? 0.0024), ang = Number(process.env.ASMGEO_ANG ?? 0.05);
const shown = placed.filter((p: any) => p.body && (!only || doc.components.find(c => c.id === p.id)?.name === only));
const rows: [number, string, number, number][] = [];
let all = 0, tris = 0;
for (const p of shown as any[]) {
  t = performance.now();
  const g = asmSimGeometry(oc, [{ id: p.id, shape: p.body.shape, faces: p.body.faces, names: p.body.names }], lin, ang);
  const s = (performance.now() - t) / 1000;
  all += s; tris += g.face.length;
  rows.push([s, doc.components.find(c => c.id === p.id)?.name ?? p.id, g.face.length, g.regions.length]);
}
rows.sort((x, y) => y[0] - x[0]);
console.log(`geometry ${all.toFixed(1)} s, ${tris} triangles`);
for (const r of rows.slice(0, 12)) console.log(`${r[0].toFixed(2)} s  ${r[1]}: ${r[2]} triangles, ${(shown as any[]).find(p => (doc.components.find(c => c.id === p.id)?.name ?? p.id) === r[1])?.body.faces.length} faces, ${r[3]} solids`);
