// Benchmark: what a drawing of each part costs in the drawing worker: build, facts, and the exact views.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Modeller } from "../src/kernel/model";
import { topology, shapeInfo, project, section, projectPoly } from "../src/kernel/drawing";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const dir = process.argv[2], only = process.argv[3];
const oc = await init();
const t = () => performance.now();
const V: Record<string, any> = { front: { dir: [0, -1, 0], up: [0, 0, 1] }, top: { dir: [0, 0, 1], up: [0, 1, 0] }, right: { dir: [1, 0, 0], up: [0, 0, 1] }, iso: { dir: [1, -1, 1], up: [0, 0, 1] } };
console.log("part".padEnd(26), "  eval   topo   info  front    top  right    iso  2nd-front  poly  section");
const sum: number[] = [];
for (const f of readdirSync(dir).filter(f => f.endsWith(".mcadprt") && (!only || f.includes(only)))) {
  const b = readFileSync(join(dir, f));
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const row: number[] = [];
  const time = (fn: () => any) => { const a = t(); let r; try { r = fn(); } catch (e) { r = null; } row.push(t() - a); return r; };
  const res = time(() => new Modeller(oc).evaluate(doc));
  if (!res?.body) { console.log(f, "no body"); continue; }
  const sh = res.body.shape;
  time(() => topology(oc, sh, res.body.names));
  const info = time(() => shapeInfo(oc, sh));
  for (const k of ["front", "top", "right", "iso"]) time(() => project(oc, sh, V[k]));
  time(() => project(oc, sh, V.front));
  time(() => projectPoly(oc, sh, V.front, 0.1));
  const c = info.box[0].map((x: number, i: number) => (x + info.box[1][i]) / 2);
  time(() => section(oc, sh, V.front, c as any, 0.02, undefined, { nudge: 0 }));
  row.forEach((x, i) => sum[i] = (sum[i] ?? 0) + x);
  console.log(f.replace(".mcadprt", "").padEnd(26), ...row.map(x => x.toFixed(0).padStart(6)));
}
console.log("TOTAL".padEnd(26), ...sum.map(x => x.toFixed(0).padStart(6)));
