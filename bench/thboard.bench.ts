// A thermal study saved in an assembly file, solved in node as the Simulation tab solves it (no bolts, no typed k tables):
//   node bench/run.mjs bench/thboard.bench.ts <file.mcadasm> [study index]
// Prints each pass and the hottest temperature of every component. THBOARD_PASSES overrides the study's passes.
import { readFileSync } from "node:fs";
import { MeshBody, insideOf } from "../src/sim/body";
import { Assembler } from "../src/kernel/assembly";
import { asmSimGeometry } from "../src/kernel/simgeo";
import { unpackAsm } from "../src/asm/file";
import { thermalSetup, runThermal } from "../src/sim/run";
import { DEFAULT_GAP } from "../src/sim/types";
import { boardK } from "../src/thermal/study";
import { boardMap } from "../src/thermal/copper";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const oc = await init();
const b = readFileSync(process.argv[2]);
const doc = await unpackAsm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const st = doc.studies![Number(process.argv[3] ?? 0)];
const asm = new Assembler(oc);
const { placed } = asm.evaluate(doc, 1);
const shown = placed.filter((p: any) => p.body && !doc.components.find(c => c.id === p.id)?.hidden);
const geo: any = asmSimGeometry(oc, shown.map((p: any) => ({ id: p.id, shape: p.body.shape, faces: p.body.faces, names: p.body.names })), 0.0024, 0.05);
const partOf = new Map(shown.map((p: any) => [p.id, p.part]));
const bodies = geo.regions.map((q: any) => ({ key: q.comp, tris: q.tris, name: doc.components.find(c => c.id === q.comp)?.name ?? q.comp, mat: (doc.parts as any)[partOf.get(q.comp)]?.doc?.material ?? null }));
const bks = bodies.map((q: any) => { const bd = st.comps?.[q.key]?.board; return bd ? boardK(q.tris, bd, bd.t) : null; });
const kOf = (i: number) => bks[i]?.along ?? bodies[i].mat?.k;
const kmaps = bodies.map((q: any, i: number) => { const bd = st.comps?.[q.key]?.board; return bd?.map && bks[i] ? boardMap(q.tris, bd, bks[i]!.t) : null; });
const k3s = bodies.map((_q: any, i: number) => (bks[i]?.k3 ? bks[i]!.k3!.map(v => v * 1e-3) : null));
const setup = thermalSetup(st, geo, bodies.map((q: any) => q.key));
if (setup.problems.length) throw new Error(JSON.stringify(setup.problems));
console.log(bodies.map((q: any, i: number) => `${q.name}: k ${kOf(i)}`).join(", "));
const pos = new Float32Array(geo.tris.length / 3 * 3);
for (let i = 0; i < geo.tris.length / 3; i++) for (let a = 0; a < 3; a++) pos[3 * i + a] = geo.tris[3 * i + a];
// where the package puts heat into the board: the middle of each disc and rectangle, on the board's top face
const bi = bodies.findIndex((_q: any, i: number) => bks[i]), bt = bodies[bi]?.tris ?? [];
let ztop = -Infinity;
for (let i = 2; i < bt.length; i += 3) ztop = Math.max(ztop, bt[i]);
const spots: { name: string; p: number[] }[] = [];
for (const l of st.loads) for (const q of l.parts ?? []) for (const r of q.into ?? []) {
  const c = r.disc ? [r.disc[0], r.disc[1]] : [(r.rect![0] + r.rect![2]) / 2, (r.rect![1] + r.rect![3]) / 2];
  spots.push({ name: `${q.name} ${r.disc ? "pad" : "body"} (${c.map(v => v.toFixed(1)).join(", ")})`, p: [c[0], c[1], ztop - 1e-4] });
  // a disc's centre is the lead's hole: its ring, at 0.85 r in four directions
  if (r.disc) for (const a of [0, 1, 2, 3]) spots.push({ name: `${q.name} ring${a}`, p: [c[0] + 0.85 * r.disc[2] * Math.cos(a * Math.PI / 2), c[1] + 0.85 * r.disc[2] * Math.sin(a * Math.PI / 2), ztop - 1e-4] });
}
const discs: [number, number, number, string][] = [];
for (const l of st.loads) for (const q of l.parts ?? []) for (const r of q.into ?? []) if (r.disc && q.name === "R1") discs.push([r.disc[0], r.disc[1], r.disc[2], q.name]);
const inBoard = insideOf(new MeshBody(Float64Array.from(bt)));
let sampler: any = null;
const t0 = performance.now(), passes = Number(process.env.THBOARD_PASSES ?? st.settings.passes);
for (const p of runThermal({
  body: geo, problem: { fixed: [], loads: [], problems: [], supportIds: [] } as any, passes, energyTol: st.settings.energyTol ?? 0, pos, nrm: new Float32Array(pos.length),
  mat: { name: "", E: 0, nu: 0, rho: 0 }, regions: bodies.map((q: any) => ({ tris: q.tris, mat: { name: "", E: 0, nu: 0, rho: 0 } })),
  thermal: { k: kOf(0) * 1e-3, setup, ks: bodies.map((_q: any, i: number) => kOf(i) * 1e-3), k3s, gap: st.settings.gap ?? DEFAULT_GAP, links: [], ...(kmaps.some(Boolean) ? { kmaps } : {}) },
} as any, (sm: any) => { sampler = sm; })) {
  const comps = p.thermal?.comps?.map((c: any, i: number) => `${bodies[i].name} ${c.max.toFixed(1)}/${c.mean.toFixed(1)}`).join(", ");
  if (sampler && spots.length) {
    const pos = Float32Array.from(spots.flatMap(q => q.p)), r = sampler(pos, new Float32Array(pos.length));
    console.log("  " + spots.map((q, i) => `${q.name} ${r.vm[i].toFixed(1)}`).join(", "));
    // the board's top face around each disc, every 0.2 mm: its hottest point
    for (const d of discs) {
      const pts: number[] = [];
      for (let a = -20; a <= 20; a++) for (let b = -20; b <= 20; b++) { const x = d[0] + a * 0.2, y = d[1] + b * 0.2; if (inBoard(x, y, ztop - 1e-3)) pts.push(x, y, ztop - 1e-3); }
      const pp = Float32Array.from(pts), rr = sampler(pp, new Float32Array(pp.length));
      let m = 0;
      for (let i = 1; i < pts.length / 3; i++) if (rr.vm[i] > rr.vm[m]) m = i;
      let zb = Infinity;
      for (let i = 2; i < bt.length; i += 3) zb = Math.min(zb, bt[i]);
      const x = pts[3 * m], y = pts[3 * m + 1], col = Float32Array.from([0.02, 0.25, 0.5, 0.75, 0.98].flatMap(f => [x, y, zb + f * (ztop - zb)])), rc = sampler(col, new Float32Array(col.length));
      console.log(`  through the board there, bottom to top: ${Array.from(rc.vm as ArrayLike<number>).map(v => v.toFixed(1)).join(", ")}`);
      console.log(`  board near ${d[3]} (${d[0].toFixed(1)}, ${d[1].toFixed(1)}): max ${rr.vm[m].toFixed(1)} at (${pts[3 * m].toFixed(1)}, ${pts[3 * m + 1].toFixed(1)}), ${pts.length / 3} points`);
    }
  }
  console.log(`pass ${p.pass}: p ${p.p}, ${p.dofs} unknowns, err ${p.err?.toFixed?.(1) ?? "-"} %, change ${p.change?.toFixed(2)}, ${comps}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
