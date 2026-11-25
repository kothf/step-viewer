// A board assembly whose part names the body its heat is made in (a die beside a copper tab) and keeps the
// package's split: all the power is made in the die, and the board share is given up by the part where it sits on
// the board, so the whole power crosses from the die to the case.
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
const pcb = { ...head("pcb", "Board"), material: { name: "Board laminate", density: 1.85, k: 0.8, cp: 1100, emis: 0.9 }, features: [rect("s1", -30, -20, 30, 20), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 1.6 } }] };
const q1 = { ...head("q1", "Q1"), material: { name: "Plain plastic", density: 1.2, k: 0.3, cp: 1200 },
  bodies: { b1: { name: "Tab", material: { name: "Bright copper", density: 8.9, k: 390, cp: 385, emis: 0.05 } }, b2: { name: "Die", material: { name: "Black silicon", density: 2.33, k: 148, cp: 700, emis: 0.8 } } },
  features: [rect("s1", -5, -5, 5, 5), { id: "b1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 4 } },
    rect("s2", 5, -2, 9, 2), { id: "b2", type: "extrude", name: "Extrude2", sketch: "s2", op: "boss", end: "blind", depth: { v: 4 }, merge: false }] };
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const study = { id: "st1", name: "Thermal 1", kind: "thermal", settings: { passes: 2, energyTol: 1, ambient: 25 },
  supports: [{ id: "s1", type: "rad", faces: [], all: true, emis: 0.5 }, { id: "s2", type: "conv", faces: [], all: true, h: 8 }],
  loads: [{ id: "l1", type: "pkgheat", faces: [], board: "c1", split: true, parts: [{ id: 1, name: "Q1", comps: ["c2"], p: 1, board: 0.4, junction: true, limit: 150, bodies: ["Die"] }] }] };
const doc = { schema: 1, kind: "assembly", id: "a_ds", name: "Amp", units: { length: "mm", decimals: 2 }, parts: { pcb: { name: "Board", file: "Board.mcadprt", doc: pcb }, q1: { name: "Q1", file: "Q1.mcadprt", doc: q1 } },
  components: [{ id: "c1", name: "Board<1>", part: "pcb", tf: T(0, 0, 0), fixed: true }, { id: "c2", name: "Q1<1>", part: "q1", tf: T(0, 0, 1.6), fixed: true }], studies: [study] };
const dir = join(OUT, "models");
mkdirSync(dir, { recursive: true });
const file = join(dir, "amp-diesplit.mcadasm");
writeFileSync(file, zip([["manifest.json", JSON.stringify({ format: "mobiuscad", schema: 1, kind: "assembly", app: "hands-on", modified: "2026-11-25T00:00:00Z", units: "mm" })], ["document.json", JSON.stringify(doc)]]));

const { browser, pg } = await open("thermaldiesplit");
await openFiles(pg, [file]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length === 2 && !window.__sv.asm.building, null, { timeout: 120000 });
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(400);
// TDS-1: solve; the whole watt is made in the die, the tab gives the board share up, the board takes it in
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(600);
const r = await pg.evaluate(() => { const s = window.__sv.sim.state(), th = s.thermal; return { error: s.error, out: th?.out, comps: th?.comps.map(c => ({ name: c.name, max: c.max, power: c.power })), paths: th?.paths, parts: th?.parts }; });
const board = r.comps?.find(c => /Board/.test(c.name)), tab = r.comps?.find(c => /\(1\)/.test(c.name)), die = r.comps?.find(c => /\(2\)/.test(c.name));
check("TDS-1", !r.error && die && tab && board && Math.abs(die.power - 1) < 1e-6 && Math.abs(tab.power + 0.4) < 1e-6 && Math.abs(board.power - 0.4) < 1e-6 && Math.abs(r.out.reduce((a, b) => a + b, 0) - 1) < 0.03,
  "the study solves: 1 W is made in the die, the tab gives up the 0.4 W board share where it sits on the board, the board takes it in, and 1 W leaves the model", r, await snap(pg, "solved"));
// TDS-2: the heat paths table still adds up for the part, and says how the share is handled
await pg.evaluate(() => document.querySelector("#tab-sim table.sim-paths")?.scrollIntoView({ block: "center" }));
const note = await pg.evaluate(() => ({ note: document.querySelector('#tab-sim [data-v="pathnote"]')?.textContent ?? "", die: document.querySelector('#tab-sim [data-v="dienote"]')?.textContent ?? "" }));
const p = r.paths?.[0];
check("TDS-2", p && Math.abs(p.board + p.air + p.other + p.sink + p.chassis - 1) < 1e-6 && p.board > 0.3 && /heat is made/.test(note.die),
  "Heat paths gives Q1's watt as board + surface + other, and a note says the shares are taken from the case of parts that name their heat bodies", { p, note }, await snap(pg, "paths"));
// TDS-3: the junction is the die's hottest point
const part = r.parts?.[0];
check("TDS-3", part && part.die && part.kind === "junction" && Math.abs(part.t - die.max) < 1e-6, "Part temperatures reads Q1's junction off the die", part);
await finish(browser, pg);
