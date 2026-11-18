// Benchmark: what the kernel worker's "model" request costs for real parts, stage by stage.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Modeller } from "../src/kernel/model";
import { Kernel } from "../src/kernel/occ";
import { analyzeMesh } from "../src/topology";
import { applyPatch, probe } from "../src/kernel/patch";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const dir = process.argv[2];
const only = process.argv[3];
const t = () => performance.now();
const oc = await init();
const kernel = new Kernel(oc);
const rows: any[] = [];
for (const f of readdirSync(dir).filter(f => f.endsWith(".mcadprt") && (!only || f.includes(only)))) {
  const b = readFileSync(join(dir, f));
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const m = new Modeller(oc);
  // per feature: evaluate with growing rollback (cache makes each step = one feature)
  const per: [string, number][] = [];
  let t0 = t();
  for (let i = 1; i <= doc.features.length; i++) {
    const a = t();
    m.evaluate({ ...doc, rollback: i });
    per.push([`${doc.features[i - 1].type}`, t() - a]);
  }
  const res = m.evaluate({ ...doc, rollback: null });
  const tEval = t() - t0;
  if (!res.body) { rows.push({ f, tEval, err: res.statuses.filter(s => !s.ok).map(s => s.code).join() }); continue; }
  t0 = t(); const mesh = m.mesh(res.body, doc.name, [0.7, 0.7, 0.7], 1); const tMesh = t() - t0;
  t0 = t(); const data = analyzeMesh(mesh as any); const tAna = t() - t0;
  kernel.meshes = [{ shape: res.body.shape, faces: res.body.faces, name: doc.name, color: [0.7, 0.7, 0.7], solid: true }] as any;
  t0 = t(); const pr = probe(data); const tProbe = t() - t0;
  t0 = t(); const ex = kernel.exact(0, pr); const tExact = t() - t0;
  t0 = t(); applyPatch(data, ex); const tPatch = t() - t0;
  t0 = t(); m.props(res.body); const tProps = t() - t0;
  t0 = t(); m.bodyInfo(res.body, doc); const tInfo = t() - t0;
  // an edit of the last feature again (cached prefix): whole request
  t0 = t(); m.evaluate({ ...doc, rollback: null }); const tHit = t() - t0;
  const slow = per.filter(p => p[1] > 30).sort((a, b) => b[1] - a[1]).slice(0, 4).map(p => `${p[0]} ${p[1].toFixed(0)}`).join(", ");
  rows.push({ f: f.replace(".mcadprt", ""), n: doc.features.length, faces: res.body.faces.length, tris: mesh.index.array.length / 3, eval: tEval, mesh: tMesh, ana: tAna, probe: tProbe, exact: tExact, patch: tPatch, props: tProps, info: tInfo, hit: tHit, slow });
}
const r = (x: number) => x == null ? "" : x.toFixed(0).padStart(6);
console.log("part".padEnd(26), "feat faces   tris   eval   mesh    ana  probe  exact  patch  props   info    hit  slow features");
const sum: Record<string, number> = {};
for (const x of rows) {
  if (x.err) { console.log(x.f, "FAILED", x.err); continue; }
  for (const k of ["eval", "mesh", "ana", "probe", "exact", "patch", "props", "info", "hit"]) sum[k] = (sum[k] ?? 0) + x[k];
  console.log(x.f.padEnd(26), String(x.n).padStart(4), String(x.faces).padStart(5), String(x.tris).padStart(6), r(x.eval), r(x.mesh), r(x.ana), r(x.probe), r(x.exact), r(x.patch), r(x.props), r(x.info), r(x.hit), " ", x.slow);
}
console.log("TOTAL".padEnd(43), ...["eval", "mesh", "ana", "probe", "exact", "patch", "props", "info", "hit"].map(k => r(sum[k])));
