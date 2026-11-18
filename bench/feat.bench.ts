// Time per feature of one part's full build: `node bench/run.mjs bench/feat.bench.ts <file.mcadprt>`.
import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const oc = await init();
const b = readFileSync(process.argv[2]);
const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const m = new Modeller(oc);
let last = performance.now(), cur = "";
const rows: [string, number][] = [];
m.onFeature = (i, _of, name) => { const now = performance.now(); if (cur) rows.push([cur, now - last]); last = now; cur = `${i} ${name} (${doc.features[i].type})`; };
const t0 = performance.now();
m.evaluate(doc);
rows.push([cur, performance.now() - last]);
for (const [n, t] of rows) console.log(t.toFixed(0).padStart(7), n);
console.log("total", (performance.now() - t0).toFixed(0));
