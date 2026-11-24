// A board with parts made of boxes, solved as a thermal study in node (to time the thermal solver without OpenCASCADE):
//   node bench/run.mjs bench/thbox.bench.ts
// Every open face has a film and radiates. THBOX_PASSES (4), THBOX_CELLS, SIMTHREADS (1), PROF=1 for a CPU profile.
// Prints each pass's time and hottest temperature, so runs can be compared for speed and sameness.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runThermal, type RunInput, type ThermalSetup } from "../src/sim/run";
import { serve, setHelpers, threadStats } from "../src/sim/threads";

if (!isMainThread) { parentPort!.on("message", (j: any) => serve(j)); await new Promise(() => {}); }
const threads = Number(process.env.SIMTHREADS ?? 1);
if (threads > 1) setHelpers(Array.from({ length: threads - 1 }, () => new Worker(fileURLToPath(import.meta.url))));

type Box = [number, number, number, number, number, number];
/** The 12 triangles of a box [x, y, z, dx, dy, dz], looking outwards. */
function boxTris([x, y, z, dx, dy, dz]: Box): number[] {
  const p = (i: number) => [x + (i & 1 ? dx : 0), y + (i & 2 ? dy : 0), z + (i & 4 ? dz : 0)];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, c, d]) => [...p(a), ...p(b), ...p(c), ...p(a), ...p(c), ...p(d)]);
}
const bodies: { box: Box; k: number; power?: number }[] = [
  { box: [0, 0, 0, 100, 80, 1.6], k: 0.8 },
  { box: [15, 15, 1.6, 14, 14, 2], k: 20, power: 2 },
  { box: [60, 15, 1.6, 10, 15, 3], k: 50, power: 1.5 },
  { box: [20, 55, 1.6, 12, 6, 1], k: 2, power: 0.5 },
  { box: [52, 48, 1.6, 20, 20, 2], k: 1, power: 1.2 },
  { box: [82, 60, 1.6, 12, 12, 6], k: 5, power: 0.8 },
];
const soups = bodies.map(b => Float64Array.from(boxTris(b.box)));
const all = Float64Array.from(soups.flatMap(s => [...s]));
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < all.length; i++) { lo[i % 3] = Math.min(lo[i % 3], all[i]); hi[i % 3] = Math.max(hi[i % 3], all[i]); }
const setup: ThermalSetup = {
  sinks: [{ tris: all, h: 8e-6, ambient: 25, free: true }, { tris: all, emissivity: 0.9, ambient: 25, free: true }], sinkIds: ["s0", "s1"], problems: [],
  sources: bodies.flatMap((b, i) => (b.power ? [{ power: b.power, doms: [i] }] : [])),
} as ThermalSetup;
const inp = {
  body: { tris: all, face: new Int32Array(all.length / 9), names: [""], lo, hi }, mat: { E: 1, nu: 0.3, rho: 0 }, regions: soups.map(tris => ({ tris, mat: { E: 1, nu: 0.3, rho: 0 } })),
  problem: {}, passes: Number(process.env.THBOX_PASSES ?? 4), ...(process.env.THBOX_CELLS ? { cells: Number(process.env.THBOX_CELLS) } : {}), energyTol: 0, pos: new Float32Array(3), nrm: new Float32Array(3),
  thermal: { k: bodies[0].k / 1000, ks: bodies.map(b => b.k / 1000), setup, gap: 0.1 },
} as unknown as RunInput;

let session: any = null;
if (process.env.PROF) { const { Session } = await import("node:inspector"); session = new Session(); session.connect(); session.post("Profiler.enable"); session.post("Profiler.start"); }
let t0 = performance.now(), sum = 0;
for (const r of runThermal(inp)) {
  const t = performance.now();
  sum += t - t0;
  console.log(`pass ${r.pass} p ${r.p}: ${r.dofs} unknowns, ${r.cells} cells, ${((t - t0) / 1000).toFixed(2)} s, max ${r.thermal!.max.toPrecision(12)} °C, min ${r.thermal!.min.toPrecision(12)}, solves ${r.thermal!.solves}`);
  t0 = t;
}
console.log(`total ${(sum / 1000).toFixed(2)} s ${JSON.stringify(threadStats())}`);
if (session) session.post("Profiler.stop", (_e: unknown, { profile }: any) => {
  const self = new Map<string, number>(), dt = profile.timeDeltas as number[], byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  profile.samples.forEach((id: number, i: number) => { const f = byId.get(id).callFrame, k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i]); });
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(v / 1e6).toFixed(2)} s  ${k}`);
});
setHelpers([]);
