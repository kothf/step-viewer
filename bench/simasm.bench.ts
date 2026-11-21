// A static study of an assembly file, solved in node (to look into the solver on real assemblies):
//   node bench/run.mjs bench/simasm.bench.ts <file.mcadasm> [name part of a component to leave out]
// Every component is steel. Held: the lowest flat face looking down. Loaded: 200 N down on the highest
// cylindrical face of the component whose name holds SIMASM_LOAD (default "main-bearing").
import { readFileSync } from "node:fs";
import { Assembler } from "../src/kernel/assembly";
import { asmSimGeometry } from "../src/kernel/simgeo";
import { unpackAsm } from "../src/asm/file";
import { studyProblem, runStatic, withoutFaces } from "../src/sim/run";
import { newStudy, compOf } from "../src/sim/types";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const oc = await init();
const b = readFileSync(process.argv[2]);
const doc = await unpackAsm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const skip = process.argv[3] ?? "\u0000", want = process.env.SIMASM_LOAD ?? "main-bearing";
const asm = new Assembler(oc);
const { placed } = asm.evaluate(doc, 1);
const shown = placed.filter((p: any) => p.body);
const nameOf = (id: string) => doc.components.find(c => c.id === id)?.name ?? id;
const box = shown.map((p: any) => p.id);
let geo: any = asmSimGeometry(oc, shown.map((p: any) => ({ id: p.id, shape: p.body.shape, faces: p.body.faces, names: p.body.names })), 0.01, 0.05);
const off = new Set(box.filter((id: string) => nameOf(id).includes(skip)));
let regions = geo.regions.filter((q: any) => !off.has(q.comp));
const body = off.size ? withoutFaces(geo, (n: string) => off.has(compOf(n))) : geo;
// faces: area, centre, summed normal
const n = body.names.length, area = new Float64Array(n), c = new Float64Array(3 * n), nn = new Float64Array(3 * n);
for (let t = 0; t < body.face.length; t++) {
  const p = body.tris.subarray(9 * t, 9 * t + 9), fi = body.face[t];
  const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
  const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], a = Math.hypot(...x) / 2;
  area[fi] += a;
  for (let k = 0; k < 3; k++) { c[3 * fi + k] += (a * (p[k] + p[3 + k] + p[6 + k])) / 3; nn[3 * fi + k] += x[k] / 2; }
}
let held = -1, loaded = -1;
for (let i = 0; i < n; i++) {
  if (!(area[i] > 0)) continue;
  const z = c[3 * i + 2] / area[i], flat = Math.hypot(nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]) / area[i];
  if (flat > 0.999 && nn[3 * i + 2] / area[i] < -0.99 && (held < 0 || z < c[3 * held + 2] / area[held])) held = i;
  if (flat < 0.2 && nameOf(compOf(body.names[i])).includes(want) && (loaded < 0 || area[i] > area[loaded])) loaded = i;
}
console.log(`held ${body.names[held]} (${nameOf(compOf(body.names[held]))}), loaded ${body.names[loaded]} (${nameOf(compOf(body.names[loaded]))}), ${regions.length} bodies`);
const st = newStudy([]);
st.supports.push({ id: "s1", type: "fixed", faces: [{ name: body.names[held] }] });
st.loads.push({ id: "l1", type: "force", faces: [{ name: body.names[loaded] }], comp: [{ v: 0 }, { v: 0 }, { v: -200 }] });
const MAT = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 };
const problem = studyProblem(st, body);
if (problem.problems.length) throw new Error(JSON.stringify(problem.problems));
const t0 = performance.now();
for (const p of runStatic({ body, mat: MAT, regions: regions.map((q: any) => ({ tris: q.tris, mat: MAT })), asm: { gap: 0.1 }, problem, passes: Number(process.env.SIMASM_PASSES ?? 3), energyTol: 0, pos: new Float32Array(3), nrm: new Float32Array(3) } as any)) {
  const sum = p.reactions?.reduce((a: number, q: any) => a + q.force[2], 0);
  for (const k of p.contacts ?? []) console.log(`  ${nameOf(regions[k.a].comp)} | ${nameOf(regions[k.b].comp)}: area ${k.area.toFixed(1)}, force ${k.force?.map((v: number) => v.toFixed(1))}, at ${k.at?.map((v: number) => v.toFixed(1))}`);
  console.log(`pass ${p.pass ?? ""}: p ${p.p}, ${p.dofs} unknowns, energy ${p.energy.toFixed(6)}, reaction z ${sum?.toFixed(3)}, contacts ${p.contacts?.length}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
