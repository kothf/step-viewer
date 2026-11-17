// Benchmark: Gerber/Excellon parsing and layer building (the PCB worker's work) for a folder of layer files.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPcbFiles } from "../src/gerber/load";
import { buildLayer } from "../src/gerber/build";
const dir = process.argv[2];
const files = readdirSync(dir).map(n => { const b = readFileSync(join(dir, n)); return { name: n, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }; });
for (let rep = 0; rep < 3; rep++) {
  let t = performance.now();
  const { layers } = await loadPcbFiles(files);
  const parse = performance.now() - t; t = performance.now();
  const built = layers.map(l => buildLayer(l));
  console.log(`parse ${parse.toFixed(0)} ms, build ${(performance.now() - t).toFixed(0)} ms, ${layers.map((l: any) => (l.objs ?? l.L?.objs)?.length).join("/")} objects`);
  void built;
}
