// A static study of a part file, solved in node (to time the static solver on real parts):
//   node bench/run.mjs bench/simstatic.bench.ts <file.mcadprt>
// Held: the flat face lowest along the longest axis; loaded: 1 kN across on the highest flat face there.
// SIMSTATIC_PASSES (4), SIMTHREADS (1), PROF=1 for a CPU profile. Prints each pass's time and energy, so runs can be compared for speed and sameness.
import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import { simGeometry } from "../src/kernel/simgeo";
import { unpackPart } from "../src/model/file";
import { studyProblem, runStatic } from "../src/sim/run";
import { newStudy } from "../src/sim/types";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { serve, setHelpers, threadStats } from "../src/sim/threads";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

// SIMTHREADS=<n>: the factorisations shared between n threads (this file is its own helper thread)
if (!isMainThread) { parentPort!.on("message", (j: any) => serve(j)); await new Promise(() => {}); }
const threads = Number(process.env.SIMTHREADS ?? 1);
if (threads > 1) setHelpers(Array.from({ length: threads - 1 }, () => new Worker(fileURLToPath(import.meta.url))));
const oc = await init();
const b = readFileSync(process.argv[2]);
const doc: any = (await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) as any);
const part = doc.doc ?? doc;
const m = new Modeller(oc);
const r = m.evaluate(part);
const geo: any = simGeometry(oc, r.body!.shape, r.body!.faces, 0.01, 0.05);
geo.names = r.body!.names.map((_: string, i: number) => `F${i}`);
const n = geo.names.length, c = new Float64Array(3 * n), area = new Float64Array(n), nn = new Float64Array(3 * n);
const ax = [0, 1, 2].sort((p, q) => (geo.hi[q] - geo.lo[q]) - (geo.hi[p] - geo.lo[p]))[0];
for (let t = 0; t < geo.face.length; t++) {
  const p = geo.tris.subarray(9 * t, 9 * t + 9), fi = geo.face[t];
  const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
  const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], a = Math.hypot(...x) / 2;
  area[fi] += a;
  for (let k = 0; k < 3; k++) { c[3 * fi + k] += (a * (p[k] + p[3 + k] + p[6 + k])) / 3; nn[3 * fi + k] += x[k] / 2; }
}
let lo = -1, hi = -1;
for (let i = 0; i < n; i++) {
  if (!(area[i] > 0) || Math.hypot(nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]) / area[i] < 0.999) continue;
  const z = c[3 * i + ax] / area[i];
  if (lo < 0 || z < c[3 * lo + ax] / area[lo]) lo = i;
  if (hi < 0 || z > c[3 * hi + ax] / area[hi]) hi = i;
}
const st = newStudy([], "static");
st.supports.push({ id: "s1", type: "fixed", faces: [{ name: `F${lo}` }] } as any);
const dir = [0, 0, 0]; dir[(ax + 1) % 3] = 1000;
st.loads.push({ id: "l1", type: "force", faces: [{ name: `F${hi}` }], comp: dir.map(v => ({ v })) } as any);
const pm = part.material;
const mat = pm?.E ? { name: pm.name, E: pm.E * (pm.E < 1000 ? 1000 : 1), nu: pm.nu, rho: pm.density * 1e-9 } : { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 };
const problem = studyProblem(st, geo);
if (problem.problems.length) throw new Error(JSON.stringify(problem.problems));
console.log(`held F${lo}, loaded F${hi}, ${geo.face.length} triangles`);
let session: any = null;
if (process.env.PROF) { const { Session } = await import("node:inspector"); session = new Session(); session.connect(); session.post("Profiler.enable"); session.post("Profiler.start"); }
let t0 = performance.now(), all = 0;
for (const p of runStatic({ body: geo, mat, problem, passes: Number(process.env.SIMSTATIC_PASSES ?? 4), energyTol: 0, pos: new Float32Array(3), nrm: new Float32Array(3) } as any)) {
  const t = performance.now();
  all += t - t0;
  console.log(`pass ${p.pass} p ${p.p}: ${p.dofs} unknowns, ${((t - t0) / 1000).toFixed(2)} s, energy ${p.energy.toPrecision(12)}, max u ${p.maxU.toPrecision(10)}, max vm ${p.maxVm.toPrecision(10)}`);
  t0 = t;
}
console.log(`total ${(all / 1000).toFixed(2)} s ${JSON.stringify(threadStats())}`);
if (session) await new Promise<void>(done => session.post("Profiler.stop", (_e: unknown, { profile }: any) => {
  const self = new Map<string, number>(), dt = profile.timeDeltas as number[], byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  profile.samples.forEach((id: number, i: number) => { const f = byId.get(id).callFrame, k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i]); });
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(v / 1e6).toFixed(2)} s  ${k}`);
  done();
}));
setHelpers([]);
