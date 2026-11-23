// Validation of the thermal solver against CalculiX (FRS-thermal NFR-TH-021, AT-TH3-9), run offline:
//   node bench/run.mjs bench/thval.bench.ts <work folder> [case]
// Each case is built from boxes by Gmsh with shared faces where bodies touch, meshed with second-order tetrahedra and
// solved by CalculiX (bench/thval.py: needs `ccx` and the gmsh Python module); the same bodies, faces and heat are
// then solved here as a study does (`runThermal`, passes p = 2, 3, 4) and both are read at CalculiX's corner nodes.
// Nothing of this is shipped. Results: docs/thermal-validation.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runThermal, type RunInput, type ThermalSetup } from "../src/sim/run";
import type { ThermalSink } from "../src/sim/thermal";

type Box = [number, number, number, number, number, number];
interface Body { name: string; boxes: Box[]; k: number; power?: number }
interface Sel { exterior?: boolean; body?: number; normal?: number[]; at?: [number, number] }
interface Cond { kind: "conv" | "temp" | "insul"; h?: number; T?: number; sel: Sel }
interface Case { id: string; what: string; bodies: Body[]; sinks: Cond[]; ambient: number; size: number }

const fins: Box[] = Array.from({ length: 6 }, (_, i) => [2 + i * 10.8, 0, 9, 2, 40, 25]);
const CASES: Case[] = [
  {
    id: "heatsink", what: "Aluminium heatsink (60 × 40 mm base, six 25 mm fins) on a 15 W copper heater; every open face cooled at 10 W/(m²·K), the heater's underside insulated", ambient: 25, size: 1.6,
    bodies: [{ name: "heatsink", boxes: [[0, 0, 4, 60, 40, 5], ...fins], k: 200 }, { name: "heater", boxes: [[20, 10, 0, 20, 20, 4]], k: 390, power: 15 }],
    sinks: [{ kind: "insul", sel: { exterior: true, body: 1, normal: [0, 0, -1] } }, { kind: "conv", h: 10, T: 25, sel: { exterior: true } }],
  },
  {
    id: "board", what: "Board 100 × 80 × 1.6 mm (0.8 W/(m·K)) with five parts making 6 W between them; every open face cooled at 10 W/(m²·K)", ambient: 25, size: 1.5,
    bodies: [
      { name: "board", boxes: [[0, 0, 0, 100, 80, 1.6]], k: 0.8 },
      { name: "U1", boxes: [[15, 15, 1.6, 14, 14, 2]], k: 20, power: 2 },
      { name: "Q1", boxes: [[60, 15, 1.6, 10, 15, 3]], k: 50, power: 1.5 },
      { name: "R1", boxes: [[20, 55, 1.6, 12, 6, 1]], k: 2, power: 0.5 },
      { name: "U2", boxes: [[52, 48, 1.6, 20, 20, 2]], k: 1, power: 1.2 },
      { name: "L1", boxes: [[82, 60, 1.6, 12, 12, 6]], k: 5, power: 0.8 },
    ],
    sinks: [{ kind: "conv", h: 10, T: 25, sel: { exterior: true } }],
  },
  {
    id: "chassis", what: "The board on four brass standoffs over an aluminium chassis plate whose underside is held at 40 °C; three parts make 5 W; open faces cooled at 6 W/(m²·K)", ambient: 25, size: 1.6,
    bodies: [
      { name: "chassis", boxes: [[0, 0, 0, 140, 110, 3]], k: 200 },
      ...[[20, 15], [114, 15], [20, 89], [114, 89]].map(([x, y], i): Body => ({ name: `standoff ${i + 1}`, boxes: [[x, y, 3, 6, 6, 10]], k: 110 })),
      { name: "board", boxes: [[17, 12, 13, 106, 86, 1.6]], k: 0.8 },
      { name: "A", boxes: [[40, 30, 14.6, 15, 15, 2.5]], k: 20, power: 2.5 },
      { name: "B", boxes: [[80, 40, 14.6, 12, 20, 3]], k: 50, power: 1.5 },
      { name: "C", boxes: [[55, 70, 14.6, 20, 10, 2]], k: 2, power: 1 },
    ],
    sinks: [{ kind: "temp", T: 40, sel: { exterior: true, body: 0, normal: [0, 0, -1] } }, { kind: "conv", h: 6, T: 25, sel: { exterior: true } }],
  },
];

interface Out { nodes: number; elements: number; bodies: number[][]; sinks: number[][][]; pos: number[]; body: number[]; T: number[] }

const [work = "node_modules/.cache/thval", only] = process.argv.slice(2);
// THVAL_SIZE=<factor> scales CalculiX's mesh size (to check that its answer has settled)
for (const c of CASES) c.size *= Number(process.env.THVAL_SIZE ?? 1);
mkdirSync(work, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const py = existsSync(join(here, "thval.py")) ? join(here, "thval.py") : "bench/thval.py";
const rows: string[] = [];
for (const c of CASES) {
  if (only && c.id !== only) continue;
  const job = join(work, `${c.id}.json`), outFile = join(work, `${c.id}.out.json`);
  writeFileSync(job, JSON.stringify({ ...c, work, out: outFile }));
  const t0 = Date.now();
  // THVAL_REUSE=1 reads CalculiX's answer from the last run of the case
  if (!(process.env.THVAL_REUSE && existsSync(outFile))) {
    const run = spawnSync("python3", [py, job], { stdio: "inherit" });
    if (run.status) throw new Error(`${c.id}: CalculiX side failed`);
  }
  const ccxS = (Date.now() - t0) / 1000;
  const o: Out = JSON.parse(readFileSync(outFile, "utf8"));
  const regions = o.bodies.map(b => ({ tris: Float64Array.from(b), mat: { E: 1, nu: 0.3, rho: 0 } }));
  const all = Float64Array.from(o.bodies.flat());
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < all.length; i++) { lo[i % 3] = Math.min(lo[i % 3], all[i]); hi[i % 3] = Math.max(hi[i % 3], all[i]); }
  const sinks: ThermalSink[] = [];
  c.sinks.forEach((s, i) => {
    if (s.kind === "insul") return;
    const tris = Float64Array.from(o.sinks[i].flat());
    sinks.push(s.kind === "temp" ? { tris, temp: s.T! } : { tris, h: s.h! * 1e-6, ambient: s.T! });
  });
  const setup: ThermalSetup = { sinks, sinkIds: sinks.map((_s, i) => `s${i}`), problems: [], sources: c.bodies.flatMap((b, i) => (b.power ? [{ power: b.power, doms: [i] }] : [])) };
  const pos = Float32Array.from(o.pos);
  const inp: RunInput = {
    body: { tris: all, face: new Int32Array(all.length / 9), names: [""], lo, hi }, mat: { E: 1, nu: 0.3, rho: 0 }, regions,
    problem: {} as RunInput["problem"], passes: Number(process.env.THVAL_PASSES ?? 3), cells: Number(process.env.THVAL_CELLS ?? 150), energyTol: 0, pos, nrm: new Float32Array(pos.length),
    thermal: { k: c.bodies[0].k / 1000, ks: c.bodies.map(b => b.k / 1000), setup, gap: 0.1 },
  };
  const t1 = Date.now();
  let sampler: ((p: ArrayLike<number>) => { vm: Float32Array }) | null = null, last;
  for (const r of runThermal(inp, s => { sampler = s; })) { last = r; console.log(`${c.id}: pass ${r.pass} p ${r.p}, ${r.dofs} unknowns, ${r.ms} ms, max ${r.thermal!.max.toFixed(3)} °C, change ${r.change?.toFixed(3) ?? "-"} %`); if (process.env.THVAL_DEBUG) console.log(r.thermal!.contacts!.map(x => `${x.a}-${x.b} ${x.area.toFixed(1)} mm² ${x.heat.toFixed(3)} W`).join("; "), "|", r.thermal!.comps!.map(x => x.max.toFixed(1)).join(" ")); }
  const ourS = (Date.now() - t1) / 1000;
  const T = sampler!(Float64Array.from(o.pos)).vm;
  const n = o.T.length, amb = c.ambient;
  let rise = 0;
  for (let i = 0; i < n; i++) rise = Math.max(rise, o.T[i] - amb);
  let worst = 0, sum = 0, at = 0;
  const bmaxC = c.bodies.map(() => -Infinity), bmaxO = c.bodies.map(() => -Infinity);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(T[i] - o.T[i]) / rise;
    sum += e * e;
    if (e > worst) { worst = e; at = i; }
    const b = o.body[i];
    bmaxC[b] = Math.max(bmaxC[b], o.T[i]); bmaxO[b] = Math.max(bmaxO[b], T[i]);
  }
  const balance = last!.thermal!.flows.reduce((s, f) => s + f.out, 0);
  console.log(`${c.id}: worst ${(100 * worst).toFixed(2)} % of the largest rise at (${[0, 1, 2].map(k => o.pos[3 * at + k].toFixed(1)).join(", ")}) CalculiX ${o.T[at].toFixed(3)}, here ${T[at].toFixed(3)}; RMS ${(100 * Math.sqrt(sum / n)).toFixed(2)} %; out ${balance.toFixed(4)} W of ${last!.thermal!.applied.toFixed(4)}`);
  const bodyRows = c.bodies.map((b, i) => `| ${b.name} | ${bmaxC[i].toFixed(2)} | ${bmaxO[i].toFixed(2)} | ${((100 * (bmaxO[i] - bmaxC[i])) / (bmaxC[i] - amb)).toFixed(2)} % |`).join("\n");
  rows.push(`### ${c.id}\n\n${c.what}.\n\nCalculiX: ${o.nodes} nodes, ${o.elements} second-order tetrahedra${ccxS > 1 ? ` (${ccxS.toFixed(0)} s with meshing)` : ""}. MöbiusCAD: ${last!.dofs} unknowns at p = ${last!.p} (${ourS.toFixed(1)} s, ${last!.cells} cells). Compared at ${n} corner nodes.\n\n- Largest difference: **${(100 * worst).toFixed(2)} %** of the largest rise above ambient (${rise.toFixed(2)} K); RMS ${(100 * Math.sqrt(sum / n)).toFixed(2)} %.\n- Heat balance: ${balance.toFixed(4)} W leaves of ${last!.thermal!.applied.toFixed(4)} W made.\n\n| Body | Hottest, CalculiX °C | Hottest, MöbiusCAD °C | Difference of its rise |\n|---|---|---|---|\n${bodyRows}\n`);
}
writeFileSync(join(work, "report.md"), rows.join("\n"));
console.log(`report: ${join(work, "report.md")}`);
