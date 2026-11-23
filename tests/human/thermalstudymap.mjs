// A board study beside the package map it was made from (FRS-thermal FR-TRES-030): after Solve the Study tab
// compares the result with the package's map part by part, the difference shows on the model, and a package
// picked by hand compares the same way.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalstudymap");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 }); await pg.waitForTimeout(600); };
const rows = () => pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-maptable tbody tr")].map(r => ({ part: r.dataset.mapcmp, map: Number(r.children[1].textContent), study: Number(r.children[2].textContent), d: r.children[3].textContent })));

// SM-1: solved, the study is set beside the package map it came from, part by part.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), r1 = await rows();
const kv = await pg.evaluate(() => Object.fromEntries(["mapname", "maphot", "studyhot", "mapmean", "mapmost"].map(k => [k, document.querySelector(`#sim-tree [data-v="${k}"]`)?.textContent ?? ""])));
await pg.locator("#sim-tree .sim-maptable").scrollIntoViewIfNeeded();
const shot1 = await snap(pg, "study-against-map");
const m1 = s1.mapCmp;
check("SM-1", !s1.error && m1 && r1.length >= 6 && r1.some(r => r.part === "board") && r1.some(r => r.part === "Q2") && r1.every(r => Number.isFinite(r.map) && Number.isFinite(r.study))
  && Math.abs(parseFloat(kv.maphot) - m1.hot.map) < 0.5 && /EL84 test board/.test(kv.mapname) && m1.missing === 0 && m1.most > 0 && m1.mean > 0,
  "after Solve the Study tab compares the result with the package's map it was made from: the hottest of each, the mean and largest difference, and every part with its map and study temperature", { kv, rows: r1, mean: m1?.mean, most: m1?.most, missing: m1?.missing }, shot1);

// SM-2: the difference on the model: a plot of study − map, symmetric about 0.
await pg.click('#sim-tree [data-a="mapplot"]');
await idle(pg);
await pg.waitForTimeout(500);
const s2 = await sim();
const leg = await pg.evaluate(() => ({ kind: document.querySelector('#sim-legend select[data-k="kind"]')?.value, lo: Number(document.querySelector('#sim-legend [data-v="min"]')?.textContent), hi: Number(document.querySelector('#sim-legend [data-v="max"]')?.textContent), unit: document.querySelector("#sim-legend .ana-scale")?.textContent ?? "" }));
const shot2 = await snap(pg, "difference-on-model");
check("SM-2", leg.kind === "dmap" && Math.abs(leg.lo + leg.hi) < 1e-6 && leg.hi >= 1 && /K/.test(leg.unit) && s2.plot?.kind === "dmap",
  "Show the difference on the model colours the board by study − map in K, red warmer, blue cooler, on a scale symmetric about 0", { leg, plot: s2.plot?.kind }, shot2);

// SM-3: Stop comparing, then pick the package by hand: the same comparison comes back.
await pg.click('#sim-tree [data-a="mapclear"]');
await idle(pg);
const gone = await pg.evaluate(() => ({ none: !!document.querySelector('#sim-tree [data-v="mapnone"]'), kind: document.querySelector('#sim-legend select[data-k="kind"]')?.value, opts: [...document.querySelectorAll('#sim-legend select[data-k="kind"] option')].map(o => o.value) }));
const chooser = pg.waitForEvent("filechooser");
await pg.click('#sim-tree [data-a="cmpmap"]');
await (await chooser).setFiles(resolve(fx, "amp-thermal.zip"));
await pg.waitForFunction(() => window.__sv.sim.state().mapCmp, null, { timeout: 60000 });
await pg.waitForTimeout(400);
const s3 = await sim(), r3 = await rows();
const shot3 = await snap(pg, "picked-map");
check("SM-3", gone.none && gone.kind === "temp" && !gone.opts.includes("dmap") && s3.mapCmp && r3.length === r1.length && r3.every((r, i) => r.part === r1[i].part && r.d === r1[i].d),
  "Stop comparing leaves a Compare with a package map… button and takes the difference plot away; picking the package's ZIP compares the same way again", { gone, rows: r3.length, shift: s3.mapCmp?.shift }, shot3);

// SM-4: a different map (the vented one) is warmer or cooler: the differences change, and the report carries them.
const chooser2 = pg.waitForEvent("filechooser");
await pg.click('#sim-tree [data-a="cmpmap"]');
await (await chooser2).setFiles(resolve(fx, "amp-vented-thermal.zip"));
await pg.waitForFunction(r => { const m = window.__sv.sim.state().mapCmp; return m && /vented/i.test(m.name); }, null, { timeout: 60000 });
await pg.waitForTimeout(400);
const s4 = await sim(), r4 = await rows();
check("SM-4", /vented/i.test(s4.mapCmp.name) && r4.length > 0 && r4.some(r => { const o = r1.find(x => x.part === r.part); return o && Math.abs(o.map - r.map) > 0.5; }),
  "another map picked by hand (the vented chassis) replaces the first: its part temperatures differ, so the differences do too", { name: s4.mapCmp?.name, rows: r4 }, await snap(pg, "vented-map"));
await finish(browser, pg);
