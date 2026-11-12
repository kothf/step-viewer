// Face names, volume, area and box of every part, to compare two builds of the kernel.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Modeller } from "../src/kernel/model";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const dir = process.argv[2], outFile = process.argv[3];
const oc = await init();
const out: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter(f => f.endsWith(".mcadprt"))) {
  const b = readFileSync(join(dir, f));
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const m = new Modeller(oc);
  const res = m.evaluate(doc);
  if (!res.body) { out[f] = { statuses: res.statuses }; continue; }
  const p = m.props(res.body);
  const r = (x: number) => +x.toPrecision(9);
  out[f] = { names: [...res.body.names].sort(), ordered: res.body.names, statuses: res.statuses.map(s => [s.ok, s.code ?? "", s.warning ?? ""]), volume: r(p.volume), area: r(p.area), com: p.com.map(r), box: p.box?.map(v => v.map(r)), moments: p.moments.map(r) };
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
