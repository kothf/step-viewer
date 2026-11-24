// A modal study of a part file, solved in node (to time the modal solver on real parts):
//   node bench/run.mjs bench/simmodal.bench.ts <file.mcadprt> [face name to hold, default the lowest flat face along Y]
// The material is the part's, else a plastic (E 3600 MPa, ν 0.36, 1240 kg/m³). SIMMODAL_PASSES (3), SIMMODAL_MODES (6), SIMTHREADS (1), PROF=1 for a CPU profile.
import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import { simGeometry } from "../src/kernel/simgeo";
import { unpackPart } from "../src/model/file";
import { studyProblem, runModal } from "../src/sim/run";
import { newStudy } from "../src/sim/types";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { serve, setHelpers, threadStats } from "../src/sim/threads";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

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
geo.names = r.body!.names;
let held = process.argv[3];
if (!held) {
  // the flat face with the lowest centre along the longest axis
  const n = geo.names.length, c = new Float64Array(3 * n), area = new Float64Array(n), nn = new Float64Array(3 * n);
  const ax = [0, 1, 2].sort((p, q) => (geo.hi[q] - geo.lo[q]) - (geo.hi[p] - geo.lo[p]))[0];
  for (let t = 0; t < geo.face.length; t++) {
    const p = geo.tris.subarray(9 * t, 9 * t + 9), fi = geo.face[t];
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], a = Math.hypot(...x) / 2;
    area[fi] += a;
    for (let k = 0; k < 3; k++) { c[3 * fi + k] += (a * (p[k] + p[3 + k] + p[6 + k])) / 3; nn[3 * fi + k] += x[k] / 2; }
  }
  let best = -1;
  for (let i = 0; i < n; i++) if (area[i] > 0 && Math.hypot(nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]) / area[i] > 0.999 && (best < 0 || c[3 * i + ax] / area[i] < c[3 * best + ax] / area[best])) best = i;
  held = geo.names[best];
}
const st = newStudy([], "modal");
st.supports.push({ id: "s1", type: "fixed", faces: [{ name: held }] } as any);
const pm = part.material;
const mat = pm?.E ? { name: pm.name, E: pm.E * (pm.E < 1000 ? 1000 : 1), nu: pm.nu, rho: pm.density * 1e-9 } : { name: "Plastic", E: 3600, nu: 0.36, rho: 1.24e-9 };
const problem = studyProblem(st, geo);
if (problem.problems.length) throw new Error(JSON.stringify(problem.problems));
console.log(`held ${held}, E ${mat.E}, ${geo.face.length} triangles`);
let session: any = null;
if (process.env.PROF) { const { Session } = await import("node:inspector"); session = new Session(); session.connect(); session.post("Profiler.enable"); session.post("Profiler.start"); }
let t0 = performance.now(), all = 0;
for (const p of runModal({ body: geo, mat, problem, passes: Number(process.env.SIMMODAL_PASSES ?? 3), energyTol: 0, pos: new Float32Array(3), nrm: new Float32Array(3), modal: { count: Number(process.env.SIMMODAL_MODES ?? 6) } } as any)) {
  const t = performance.now();
  console.log(`pass p ${p.p}: ${p.dofs} unknowns, ${((t - t0) / 1000).toFixed(1)} s, ${(p.modes ?? []).map((q: any) => q.hz.toFixed(2)).join(" ")} ${JSON.stringify((p as any).ms ?? "")}`);
  all += t - t0;
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
