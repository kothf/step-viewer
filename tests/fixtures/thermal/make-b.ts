// Makes a second thermal package of the same board (FRS-thermal FR-TMAP-030 compare): the board in a vented chassis,
// 10 K cooler, R14 moved hotter by 8 K and C13 left out. Run after make.ts: node bench/run.mjs tests/fixtures/thermal/make-b.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipLimited, zip } from "../../../src/model/zip";
import { readVtu, writeVtu } from "../../../src/thermal/vtu";

const dir = join(process.cwd(), "tests/fixtures/thermal");
const src = readFileSync(join(dir, "amp-thermal.zip"));
const files = await unzipLimited(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
const text = (n: string) => new TextDecoder().decode(files.get(n)!);
const m = await readVtu(files.get("amp-thermal.vtu")!);
const R14 = 2, C13 = 6;
// points take the change of the first part using them
const owner = new Int32Array(m.temp.length).fill(-1);
for (let k = 0; k < m.part.length; k++) for (let j = 0; j < 3; j++) { const v = m.tri[3 * k + j]; if (owner[v] < 0) owner[v] = m.part[k]; }
const temp = Float32Array.from(m.temp, (x, i) => x + (owner[i] === R14 ? 8 : -10));
const keep: number[] = [];
for (let k = 0; k < m.part.length; k++) if (m.part[k] !== C13) keep.push(k);
const pick = <T extends Int8Array | Int32Array | Float32Array>(a: T | undefined): T | undefined => (a ? (a.constructor as { from(x: number[]): T }).from(keep.map(k => a[k])) : undefined);
const tri = new Uint32Array(keep.length * 3);
keep.forEach((k, j) => tri.set(m.tri.subarray(3 * k, 3 * k + 3), 3 * j));
let lo = Infinity, hi = -Infinity;
for (const x of temp) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
const b = { ...m, temp, tri, part: pick(m.part)!, face: pick(m.face), power: pick(m.power), flux: pick(m.flux), ambient: 30, range: [lo, hi] as [number, number] };
const man = JSON.parse(text("amp-thermal.json"));
man.design = "EL84 test board (vented)";
man.settings.ambient_C = 30;
man.settings.enclosure = "vented";
man.range_C = [30, 172];
man.parts = man.parts.filter((p: { part_id: number }) => p.part_id !== C13).map((p: { part_id: number; t_body_C: number }) => ({ ...p, t_body_C: p.t_body_C + (p.part_id === R14 ? 8 : -10) }));
const csv = text("amp-heat-sources.csv").split("\n").filter(l => !/^6,C13,/.test(l)).join("\n");
writeFileSync(join(dir, "amp-vented-thermal.zip"), await zip([
  { name: "amp-vented-thermal.vtu", data: await writeVtu(b, { encoding: "zlib" }) }, { name: "amp-heat-sources.csv", data: csv },
  { name: "amp-thermal.json", data: JSON.stringify({ ...man, files: { ...man.files, mesh: "amp-vented-thermal.vtu" } }, null, 1) },
]));
console.log(`vented: ${keep.length} triangles, range ${lo.toFixed(1)}..${hi.toFixed(1)} °C`);
process.exit(0);
