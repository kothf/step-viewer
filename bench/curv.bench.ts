// Writes every free-form face's sampled curvature range (Kernel.exact) for the parts in a folder: diff two builds.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Modeller } from "../src/kernel/model";
import { Kernel } from "../src/kernel/occ";
import { analyzeMesh } from "../src/topology";
import { probe } from "../src/kernel/patch";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const [dir, out] = process.argv.slice(2);
const oc = await init();
const kernel = new Kernel(oc);
const res: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter(f => f.endsWith(".mcadprt"))) {
  const b = readFileSync(join(dir, f));
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const r = new Modeller(oc).evaluate(doc);
  if (!r.body) continue;
  const data = analyzeMesh(r.body && new Modeller(oc).mesh(r.body, doc.name, [0.7, 0.7, 0.7], 1) as any);
  kernel.meshes = [{ shape: r.body.shape, faces: r.body.faces, name: doc.name, color: [0.7, 0.7, 0.7], solid: true }] as any;
  const ex = kernel.exact(0, probe(data));
  res[f] = ex.ok ? ex.faces.map(x => x && x.type === "freeform" ? [x.kMin, x.kMax] : null) : ex.reason;
}
writeFileSync(out, JSON.stringify(res, (_k, v) => typeof v === "number" ? Number(v.toPrecision(6)) : v, 1));
