// Structural test set, a real assembly (FRS-structural SA3 by hand): the crankshaft stage of the model steam
// engine (wood base, four pillars, base plate, two main bearings, crankshaft) is opened from its file, every
// components are set up in the study (one left out, one rigid, the rest given steel), the base is held from below
// and a bearing housing's bore is loaded. The components are joined where they touch; the support must carry
// the whole load and the housings must pass it on to the base plate. The assembly is saved with its study in HT_MODELS.
import { open, snap, screenOf, clickAt, check, finish, openFiles, saveModel, eyeDir, boreSpot, OUT } from "./lib.mjs";
import { statSync } from "node:fs";
const PARTS = process.env.HT_PARTS || "/mnt/project-files/leuenberger";
const MODELS = process.env.HT_MODELS || `${OUT}/models`;
const LOAD = [0, 0, -200];
const { browser, pg } = await open("set-shaft");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
await openFiles(pg, [`${PARTS}/stage-shaft.mcadasm`]);
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 180000 });
await pg.waitForFunction(() => window.__sv.viewer.parts.length === 9, null, { timeout: 180000 });
await pg.waitForTimeout(3000);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(1200);
// the ball bearings are not in this stage, so the crankshaft touches nothing: it is left out and its load goes
// onto a housing's bore as a bearing load. The wood base is rigid (wood has no single E), the rest is steel.
const comps = (await sim()).compList;
const shaft = comps.find(c => /crankshaft/.test(c.name)), base = comps.find(c => /wood/.test(c.name));
await pg.uncheck(`#sim-tree input[data-k="compon"][data-c="${shaft.id}"]`);
await pg.waitForTimeout(400);
await pg.click(`#sim-tree [data-a="comprigid"][data-c="${base.id}"]`);
await pg.waitForTimeout(400);
for (const c of comps) {
  if (c === shaft || c === base) continue;
  await pg.click(`#sim-tree [data-a="compmat"][data-c="${c.id}"]`);
  await pg.waitForSelector("#mat-dlg[open]");
  await pg.fill("#mat-q", "S235");
  await pg.waitForTimeout(300);
  await pg.click("#mat-dlg .mat-list li");
  await pg.click('#mat-dlg [data-a="ok"]');
  await pg.waitForTimeout(400);
}
const set = (await sim()).compList;
check("SS-1", set.length === 9 && set.find(c => c.id === shaft.id).off && set.find(c => c.id === base.id).rigid && set.filter(c => c.material).length === 7,
  "the stage opens with its nine components: the crankshaft is left out, the wood base made rigid, the other seven get steel for the study", set.map(c => [c.name, c.off ? "left out" : c.rigid ? "rigid" : c.material]), await snap(pg, "shaft-components"));

const view = async (keys = []) => {
  await pg.mouse.move(700, 480);
  await pg.keyboard.press("Control+7");
  await pg.waitForTimeout(900);
  for (const k of keys) { await pg.keyboard.press(k); await pg.waitForTimeout(450); }
  await pg.keyboard.press("f");
  await pg.waitForTimeout(800);
};
const faces = () => pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
// held: the underside of the wood base, seen from below
await view(["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [0, 0, 0]));
await pg.waitForTimeout(300);
const held = await faces();
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
// loaded: the bore of the bearing housing nearer the eye (the wide seat of the ball bearing, or the narrow bore
// behind it, whichever looks at the eye)
await view();
const eye = await eyeDir(pg);
const y0 = eye[1] > 0 ? 17.5 : -68, dir = eye[1] > 0 ? -1 : 1;
await pg.click('#sim-tools [data-s="bearing"]');
let pushed = "", bore = null;
// (the crankshaft still stands in the bore: the click goes on the wall beside it)
for (const [r, len, turn] of [[16, 10, 0.8], [16, 10, -0.8], [7.5, 8, 0.8], [7.5, 8, -0.8]]) {
  const a = [y0, y0 + dir * len].sort((p, q) => p - q);
  await clickAt(pg, await screenOf(pg, await boreSpot(pg, [92, 0, 105.5], [0, 1, 0], r, a[0], a[1], 0.25, turn)));
  await pg.waitForTimeout(300);
  pushed = await faces();
  if (pushed === "1 face") { bore = [r, ...a]; break; }
}
for (let k = 0; k < 3; k++) { await pg.fill(`#sim-pm [data-n="c${k}"]`, String(LOAD[k])); await pg.keyboard.press("Tab"); }
await pg.waitForTimeout(200);
const shot = await snap(pg, "shaft-loaded");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
check("SS-2", held === "1 face" && pushed === "1 face", "the underside of the base is held and a housing's bore gets the bearing load, both picked on the model", { held, pushed, bore }, shot);

// connections before solving
await pg.click('#sim-tree [data-a="findlinks"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.finding && s.found?.length; }, null, { timeout: 300000 });
const found = (await sim()).found;
check("SS-3", found.length === 10, "Find connections lists the ten pairs that touch: base and pillars, pillars and plate, plate and bearing housings", found.map(c => [c.a, c.b, +c.area.toFixed(1), +c.gap.toFixed(3)]), await snap(pg, "shaft-connections"));

await pg.selectOption('#sim-tree [data-k="passes"]', "3");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 1500000 });
await pg.waitForTimeout(800);
const r = await sim();
const sum = r.error ? [NaN] : [0, 1, 2].map(k => r.reactions.reduce((a, q) => a + q.force[k], 0) + LOAD[k]);
check("SS-4", !r.error && Math.hypot(...sum) < 1e-3 * 200 && r.maxU > 0 && isFinite(r.maxVm), "solved: the support carries the whole load", { error: r.error, maxU: r.maxU, maxVm: r.maxVm, unbalanced: sum, passes: r.passes?.map(p => [p.p, p.dofs, p.change]) }, await snap(pg, "shaft-solved"));
// what the loaded housing passes to the base plate: the load
const under = r.error ? [] : r.contacts.filter(c => /base-plate/.test(c.a + c.b) && /main-bearing/.test(c.a + c.b) && c.force);
const down = under.reduce((a, c) => a + (/main-bearing/.test(c.a) ? c.force[2] : -c.force[2]), 0);
check("SS-5", under.length === 2 && Math.abs(down - LOAD[2]) < 0.02 * 200, "the housings pass the load on to the base plate (connection forces)", { pairs: under.map(c => [c.a, c.b, c.force]), down });
const rows = r.compRows ?? [];
const top = rows.slice().sort((a, b) => b.u - a.u)[0];
const still = rows.find(x => /wood-base/.test(x.name));
check("SS-6", rows.length === 8 && /base-plate|main-bearing/.test(top?.name ?? "") && still?.u < 1e-6 && r.excluded?.length === 1, "results by component: eight rows (the crankshaft is left out), the held rigid base stays put, the plate or a housing moves most", rows.map(x => [x.name, x.u, x.vm]));
const path = await saveModel(pg, MODELS, "stage-shaft");
check("SS-7", statSync(path).size > 1000, "the assembly is saved with its study", { path, bytes: statSync(path).size });
await finish(browser, pg);
