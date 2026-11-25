// A capacitor as four components: an aluminium can (floor, wall, lid) around a heated core of wound foil, on a board.
// Opened and solved by hand: Solve is pressed while the assembly is still being built, and the core's temperature
// is read at its middle, which no surface point shows.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { open, snap, check, finish, openFiles, OUT } from "./lib.mjs";

function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), nm = Buffer.from(name), comp = deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    locals.push(h, nm, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const P = (id, x, y) => ({ id, t: "point", x, y });
const rect = (id, x0, y0, x1, y1) => ({ id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [P(`${id}p1`, x0, y0), P(`${id}p2`, x1, y0), P(`${id}p3`, x1, y1), P(`${id}p4`, x0, y1),
  { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` }, { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }] });
const head = (id, name) => ({ schema: 1, kind: "part", id, name, units: { length: "mm", decimals: 2 }, props: {}, rollback: null });
const box = (id, name, mat, w, d, hole) => ({ ...head(id, name), material: mat, features: [{ ...rect("s1", -w / 2, -w / 2, w / 2, w / 2), ents: [...rect("s1", -w / 2, -w / 2, w / 2, w / 2).ents, ...(hole ? rect("h", -hole / 2, -hole / 2, hole / 2, hole / 2).ents : [])] }, { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: d } }] });
const AL = { name: "Aluminium can", density: 2.7, k: 167, cp: 900, emis: 0.2 }, FOIL = { name: "Wound foil", density: 1.6, k: 1, cp: 1500 };
const pcb = { ...head("pcb", "Board"), material: { name: "Board laminate", density: 1.85, k: 0.8, cp: 1100, emis: 0.9 }, features: [rect("s1", -30, -20, 30, 20), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 1.6 } }] };
const parts = { pcb: { name: "Board", file: "Board.mcadprt", doc: pcb }, floor: { name: "Floor", file: "Floor.mcadprt", doc: box("floor", "Floor", AL, 10, 1) }, wall: { name: "Wall", file: "Wall.mcadprt", doc: box("wall", "Wall", AL, 10, 10, 8) },
  lid: { name: "Lid", file: "Lid.mcadprt", doc: box("lid", "Lid", AL, 10, 1) }, core: { name: "Core", file: "Core.mcadprt", doc: box("core", "Core", FOIL, 8, 10) } };
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const study = { id: "st1", name: "Thermal 1", kind: "thermal", settings: { passes: 2, energyTol: 1, ambient: 25 },
  supports: [{ id: "s2", type: "conv", faces: [], all: true, h: 10 }],
  loads: [{ id: "l1", type: "pkgheat", faces: [], parts: [{ id: 1, name: "C1", comps: ["c5"], p: 0.5, limit: 105 }] }] };
const doc = { schema: 1, kind: "assembly", id: "a_inner", name: "Cap", units: { length: "mm", decimals: 2 }, parts,
  components: [{ id: "c1", name: "Board<1>", part: "pcb", tf: T(0, 0, 0), fixed: true }, { id: "c2", name: "Floor<1>", part: "floor", tf: T(0, 0, 1.6), fixed: true }, { id: "c3", name: "Wall<1>", part: "wall", tf: T(0, 0, 2.6), fixed: true },
    { id: "c4", name: "Lid<1>", part: "lid", tf: T(0, 0, 12.6), fixed: true }, { id: "c5", name: "Core<1>", part: "core", tf: T(0, 0, 2.6), fixed: true }], studies: [study] };
const dir = join(OUT, "models");
mkdirSync(dir, { recursive: true });
const file = join(dir, "cap-inner.mcadasm");
writeFileSync(file, zip([["manifest.json", JSON.stringify({ format: "mobiuscad", schema: 1, kind: "assembly", app: "hands-on", modified: "2026-11-25T00:00:00Z", units: "mm" })], ["document.json", JSON.stringify(doc)]]));

const { browser, pg } = await open("thermalinner");
await openFiles(pg, [file]);
// TIN-1: Solve pressed straight away, while the components are still being built
await pg.waitForSelector("#cm-t-simulation", { state: "visible", timeout: 60000 });
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
const building = await pg.evaluate(() => !!window.__sv.asm.building);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(200);
const early = await pg.evaluate(() => { const s = window.__sv.sim.state(), el = document.querySelector('#st-sim [data-v="building"]'); return { waiting: s.waiting, waits: s.waits, note: el?.textContent ?? "", toasts: [...document.querySelectorAll(".toast")].map(x => x.textContent) }; });
check("TIN-1", !early.toasts.some(x => /no components/.test(x)) && (!building || (early.waits === 1 && /Building the assembly/.test(early.note))),
  "Solve pressed while the assembly is still being built does not complain: the status bar says Building the assembly…", { building, early }, await snap(pg, "building"));
// TIN-2: it solves by itself once the build ends
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.waiting && !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(600);
const r = await pg.evaluate(() => { const s = window.__sv.sim.state(), th = s.thermal; return { error: s.error, comps: th?.comps.map(c => ({ name: c.name, max: c.max, deep: !!c.deep, power: c.power })), parts: th?.parts }; });
const core = r.comps?.find(c => /Core/.test(c.name)), wall = r.comps?.find(c => /Wall/.test(c.name));
check("TIN-2", !r.error && r.comps?.length === 5 && core && Math.abs(core.power - 0.5) < 1e-6, "the study solved without a second press, with the 0.5 W in the core", r, await snap(pg, "solved"));
// TIN-3: the core is hotter at its middle than anywhere on the can around it
check("TIN-3", core && wall && core.deep && core.max - wall.max > 1.5 && core.max - wall.max < 8, "the core's highest temperature is the one at its middle, a few kelvin over the can", { core, wall });
// TIN-4: the components table marks it, and the part's temperature follows
await pg.evaluate(() => document.querySelector("#tab-sim table.sim-tcomps")?.scrollIntoView({ block: "center" }));
const cell = await pg.evaluate(() => { const c = [...document.querySelectorAll('#tab-sim table.sim-tcomps [data-v="tcmax"][data-deep]')]; return { n: c.length, title: c[0]?.title ?? "", text: c[0]?.textContent ?? "" }; });
check("TIN-4", cell.n >= 1 && /inside the body/.test(cell.title) && r.parts?.[0] && Math.abs(r.parts[0].t - core.max) < 1e-6, "the Components table says the hottest point is inside the body, and Part temperatures gives C1 that temperature", { cell, part: r.parts?.[0] }, await snap(pg, "table"));
await finish(browser, pg);
