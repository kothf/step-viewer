// Validation of the structural solver against CalculiX (FRS-structural NFR-SIM-022), run offline:
//   node bench/run.mjs bench/simval.bench.ts <folder with the engine parts> <work folder> [case]
// Each case is a real part: it is built by the kernel, written as STEP, meshed by Gmsh with second-order
// tetrahedra and solved by CalculiX (bench/simval.py: needs `ccx` and the gmsh Python module), then solved here,
// and both are read at the same points. Nothing of this is shipped. Results: docs/structural-validation.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Modeller } from "../src/kernel/model";
import { Kernel } from "../src/kernel/occ";
import { simGeometry } from "../src/kernel/simgeo";
import { unpackPart } from "../src/model/file";
import { studyProblem, runStatic, type Sampler } from "../src/sim/run";
import { newStudy } from "../src/sim/types";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

interface Case { id: string; file: string; what: string; fixed: number[]; loaded: number[]; force: number[]; size: number }
// faces by their index in the body (bench/simfaces.bench.ts lists them); forces in N; `size` = CalculiX mesh size, mm
const CASES: Case[] = [
  { id: "con-rod", file: "2-03-con-rod.mcadprt", what: "Connecting rod: the big end bore held, the small end bore pulled along the rod and pushed sideways", fixed: [9], loaded: [20, 21], force: [-400, 60, 0], size: 0.9 },
  { id: "bracket", file: "1-01.4-bracket.mcadprt", what: "Bracket: the underside of the foot held, the bore in the lug loaded down and sideways", fixed: [25], loaded: [6, 23], force: [0, 80, -200], size: 0.7 },
  { id: "fork-link", file: "2-06.1-fork-link.mcadprt", what: "Fork link: the end of the stem held, the pin holes of the fork loaded across the stem", fixed: [10], loaded: [7, 8], force: [0, 0, -40], size: 0.4 },
];
const MAT = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 };
const PASSES = Number(process.env.SIMVAL_PASSES ?? 6), CELLS = Number(process.env.SIMVAL_CELLS ?? 150);

/**
 * Points along the sharp inside corners of a body: edges where two of its faces meet at more than 20° with the
 * material on the outside of the angle. `step` = spacing of the points, mm.
 */
function insideCorners(tris: Float64Array, face: Int32Array, step: number): number[] {
  const nt = face.length, nrm = new Float64Array(3 * nt), cen = new Float64Array(3 * nt);
  for (let t = 0; t < nt; t++) {
    const p = tris.subarray(9 * t, 9 * t + 9);
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...x) || 1;
    for (let j = 0; j < 3; j++) { nrm[3 * t + j] = x[j] / l; cen[3 * t + j] = (p[j] + p[3 + j] + p[6 + j]) / 3; }
  }
  const q = (v: number) => Math.round(v * 1e5);
  const key = (a: number[], b: number[]) => { const ka = a.map(q).join(","), kb = b.map(q).join(","); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const seen = new Map<string, number>(), out: number[] = [];
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = [...tris.subarray(9 * t + 3 * e, 9 * t + 3 * e + 3)], b = [...tris.subarray(9 * t + 3 * ((e + 1) % 3), 9 * t + 3 * ((e + 1) % 3) + 3)];
    const k = key(a, b), o = seen.get(k);
    if (o === undefined) { seen.set(k, t); continue; }
    if (face[o] === face[t]) continue;
    const dot = nrm[3 * o] * nrm[3 * t] + nrm[3 * o + 1] * nrm[3 * t + 1] + nrm[3 * o + 2] * nrm[3 * t + 2];
    const lean = (cen[3 * t] - cen[3 * o]) * nrm[3 * o] + (cen[3 * t + 1] - cen[3 * o + 1]) * nrm[3 * o + 1] + (cen[3 * t + 2] - cen[3 * o + 2]) * nrm[3 * o + 2];
    if (dot > Math.cos((20 * Math.PI) / 180) || lean <= 1e-9) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) out.push(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, a[2] + ((b[2] - a[2]) * i) / n);
  }
  return out;
}
/** Whether a point is within `d` of any of `pts` (cells of size d). */
function nearTo(pts: number[], d: number): (x: number, y: number, z: number) => boolean {
  const cells = new Map<string, number[]>(), c = (v: number) => Math.floor(v / d);
  for (let i = 0; i < pts.length; i += 3) { const k = `${c(pts[i])},${c(pts[i + 1])},${c(pts[i + 2])}`; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); }
  return (x, y, z) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      const list = cells.get(`${c(x) + i},${c(y) + j},${c(z) + l}`);
      if (list) for (const p of list) if ((pts[p] - x) ** 2 + (pts[p + 1] - y) ** 2 + (pts[p + 2] - z) ** 2 < d * d) return true;
    }
    return false;
  };
}

const [dir, work, only] = process.argv.slice(2);
if (!dir || !work) { console.log("usage: simval.bench.ts <parts folder> <work folder> [case]"); process.exit(1); }
mkdirSync(work, { recursive: true });
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bench");
const py = existsSync(join(here, "simval.py")) ? join(here, "simval.py") : "bench/simval.py";
const oc = await init();
const rows: any[] = [];
for (const c of CASES.filter(c => !only || c.id === only)) {
  const b = readFileSync(join(dir, c.file));
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const m = new Modeller(oc);
  const r = m.evaluate({ ...doc, rollback: null });
  if (!r.body) throw new Error(`${c.file}: no body`);
  // a multibody part is analysed with its bodies joined, as the app does (FRS-structural AT-SA2-5)
  r.body = m.bonded(r.body).body;
  const geo = simGeometry(oc, r.body.shape, r.body.faces, 0.002, 0.05);
  const nf = r.body.faces.length;
  // each face's area and centre: how the CalculiX side finds the same faces in the STEP file
  const area = new Float64Array(nf), cen = new Float64Array(3 * nf);
  for (let t = 0; t < geo.face.length; t++) {
    const p = geo.tris.subarray(9 * t, 9 * t + 9), f = geo.face[t];
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    area[f] += a;
    for (let k = 0; k < 3; k++) cen[3 * f + k] += (a * (p[k] + p[3 + k] + p[6 + k])) / 3;
  }
  const faceOf = (i: number) => ({ area: area[i], at: [0, 1, 2].map(k => cen[3 * i + k] / area[i]) });
  const kernel = new Kernel(oc);
  kernel.meshes = [{ shape: r.body.shape, faces: r.body.faces, name: c.id, color: [0.7, 0.7, 0.7], solid: true }] as any;
  const step = join(work, `${c.id}.step`), job = join(work, `${c.id}.json`), out = join(work, `${c.id}.out.json`);
  writeFileSync(step, kernel.writeStep([0], [c.id]));
  writeFileSync(job, JSON.stringify({ step, out, work, id: c.id, E: MAT.E, nu: MAT.nu, size: c.size, force: c.force, fixed: c.fixed.map(faceOf), loaded: c.loaded.map(faceOf) }));
  if (!process.env.SIMVAL_REUSE || !existsSync(out)) {
    const run = spawnSync("python3", [py, job], { stdio: "inherit" });
    if (run.status) throw new Error(`${c.id}: the CalculiX run failed`);
  }
  const ref = JSON.parse(readFileSync(out, "utf8")) as { nodes: number; elements: number; pos: number[]; u: number[]; ip: number[]; vm: number[]; far: number[]; reaction: number[] };

  // the same problem here: the faces are named by their index, since a part's face names may repeat
  const body = { tris: geo.tris, face: geo.face, names: r.body.names.map((_, i) => `F${i}`), lo: geo.lo, hi: geo.hi };
  const st = newStudy([], "static");
  st.supports.push({ id: "s1", type: "fixed", faces: c.fixed.map(i => ({ name: `F${i}` })) } as any);
  st.loads.push({ id: "l1", type: "force", faces: c.loaded.map(i => ({ name: `F${i}` })), comp: c.force.map(v => ({ v })) } as any);
  let keep: Sampler | undefined, last: any;
  const t0 = performance.now();
  for (const p of runStatic({ body, mat: MAT, problem: studyProblem(st, body), passes: PASSES, energyTol: 0, cells: CELLS, pos: new Float32Array(ref.pos.slice(0, 3)), nrm: new Float32Array(3) } as any, s => { keep = s; })) {
    last = p;
    console.log(`${c.id} pass ${p.pass}: p ${p.p}, ${p.dofs} unknowns, ${p.cells} cells, energy ${p.energy.toFixed(6)}, change ${p.change?.toFixed(3) ?? "-"} %`);
  }
  const ms = performance.now() - t0;
  const mine = keep!(ref.pos), inner = keep!(ref.ip);
  // displacements at the reference mesh's nodes
  const n = ref.pos.length / 3;
  let maxRef = 0, maxMine = 0, d2 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const a = [ref.u[3 * i], ref.u[3 * i + 1], ref.u[3 * i + 2]], q = [mine.u[3 * i], mine.u[3 * i + 1], mine.u[3 * i + 2]];
    maxRef = Math.max(maxRef, Math.hypot(...a)); maxMine = Math.max(maxMine, Math.hypot(...q));
    d2 += (a[0] - q[0]) ** 2 + (a[1] - q[1]) ** 2 + (a[2] - q[2]) ** 2; r2 += a[0] ** 2 + a[1] ** 2 + a[2] ** 2;
  }
  // von Mises at the reference's integration points away from the support and from sharp inside corners: the
  // stress at both grows without limit as either model is refined, so its peak there says nothing
  const k = ref.vm.length;
  const diag = Math.hypot(geo.hi[0] - geo.lo[0], geo.hi[1] - geo.lo[1], geo.hi[2] - geo.lo[2]);
  const clear = Math.max(3 * c.size, 0.03 * diag), corners = insideCorners(geo.tris, geo.face, clear / 2);
  const near = nearTo(corners, clear);
  let pkRef = 0, pkMine = 0, at = -1, s2 = 0, q2 = 0, cnt = 0;
  for (let i = 0; i < k; i++) {
    if (!ref.far[i] || near(ref.ip[3 * i], ref.ip[3 * i + 1], ref.ip[3 * i + 2])) continue;
    cnt++;
    if (ref.vm[i] > pkRef) { pkRef = ref.vm[i]; at = i; }
    pkMine = Math.max(pkMine, inner.vm[i]);
    s2 += (ref.vm[i] - inner.vm[i]) ** 2; q2 += ref.vm[i] ** 2;
  }
  const react = last.reactions.reduce((s: number[], x: any) => s.map((v, j) => v + x.force[j]), [0, 0, 0]);
  const balance = Math.hypot(...react.map((v: number, j: number) => v + c.force[j])) / Math.hypot(...c.force);
  const row = { id: c.id, what: c.what, force: c.force, ref: { nodes: ref.nodes, elements: ref.elements, size: c.size }, mine: { passes: last.pass, p: last.p, unknowns: last.dofs, cells: last.cells, s: ms / 1000, error: last.errors?.[last.errors.length - 1] ?? null },
    maxU: [maxRef, maxMine, (maxMine / maxRef - 1) * 100], uField: Math.sqrt(d2 / r2) * 100, peakVm: [pkRef, pkMine, (pkMine / pkRef - 1) * 100], vmAtPeak: [pkRef, inner.vm[at], (inner.vm[at] / pkRef - 1) * 100],
    vmField: Math.sqrt(s2 / q2) * 100, points: cnt, of: k, clear, corners: corners.length / 3, peakAt: at < 0 ? null : [ref.ip[3 * at], ref.ip[3 * at + 1], ref.ip[3 * at + 2]], balance: balance * 100 };
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(work, "simval.json"), JSON.stringify(rows, null, 1));
const f = (v: number, d = 2) => v.toFixed(d);
console.log("\n| Part | Largest displacement, mm (CalculiX / here) | Difference | Displacement field | Peak von Mises, MPa (CalculiX / here) | Difference | Reactions against the load |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.id} | ${r.maxU[0].toExponential(4)} / ${r.maxU[1].toExponential(4)} | ${f(r.maxU[2])} % | ${f(r.uField)} % | ${f(r.peakVm[0])} / ${f(r.peakVm[1])} | ${f(r.peakVm[2])} % | ${f(r.balance, 4)} % |`);
