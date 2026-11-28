// Thermal stress by hand (FRS-thermal TH5, FR-LOAD-011): a steel block clamped at one end and warmed, first to one
// temperature everywhere, then to the temperatures a thermal study found; the stress follows the thermal study.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, simCmd } from "./lib.mjs";
const { browser, pg } = await open("thermalstress");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const end = async () => clickAt(pg, await screenOf(pg, [50, 0, 10]));

// TS-1: S235, clamped at its end, 120 °C everywhere: it grows about α ΔT L = 0.12 mm at the free end, and the clamp stresses it.
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await end();
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await simCmd(pg, "temperature");
await pg.waitForSelector("#sim-pm .pm-ok");
const panel = await pg.evaluate(() => ({ from: [...document.querySelectorAll('#sim-pm [data-k="tfrom"] option')].map(o => o.textContent), ref: document.querySelector('#sim-pm [data-q="tref"]')?.value }));
await pg.fill('#sim-pm [data-n="value"]', "120");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), meta1 = await pg.evaluate(() => document.querySelector("#sim-tree .sim-loads .sim-meta")?.textContent ?? "");
check("TS-1", !s1.error && s1.maxU > 0.1 && s1.maxU < 0.16 && s1.maxVm > 50 && panel.ref === "20" && /120 °C/.test(meta1),
  "Loads ▸ Temperature at 120 °C (stress-free at 20 °C) makes the clamped block grow about 0.12 mm and stresses it at the clamp", { panel, meta1, error: s1.error, maxU: s1.maxU, maxVm: s1.maxVm }, await snap(pg, "thermalstress-uniform"));

// TS-2: a thermal study: the clamped end held at 20 °C, 20 W made in the block, still air on every surface.
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="temp"]');
await end();
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "20 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const th = await sim();
check("TS-2", !th.error && th.thermal && th.thermal.max > 40,
  "the thermal study solves: the block is hottest at its free end", { error: th.error, max: th.thermal?.max, min: th.thermal?.min }, await snap(pg, "thermalstress-thermal"));

// TS-3: back in the static study the Temperature load takes the thermal study's temperatures.
await pg.click('#sim-tools [data-s="mode-structural"]');
await pg.waitForTimeout(300);
await pg.click('#sim-tree .sim-loads button.sim-name[data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
const thId = await pg.evaluate(() => window.__sv.model.store.doc.studies.find(s => s.kind === "thermal")?.id);
await pg.selectOption('#sim-pm [data-k="tfrom"]', thId);
await pg.waitForTimeout(200);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const stale0 = (await sim()).stale;
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim(), meta3 = await pg.evaluate(() => document.querySelector("#sim-tree .sim-loads .sim-meta")?.textContent ?? "");
check("TS-3", !s3.error && stale0 && /from Thermal 1/.test(meta3) && s3.maxU > 0 && s3.maxU < s1.maxU && s3.maxVm > 0,
  "From Thermal 1: the block is warmed as the thermal study found (cool at the clamp), so it grows less than at 120 °C everywhere", { meta3, stale0, error: s3.error, maxU: s3.maxU, maxVm: s3.maxVm }, await snap(pg, "thermalstress-from"));

// TS-4: a change in the thermal study makes the static results out of date.
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(300);
await pg.click('#sim-tree .sim-heat button.sim-name[data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-n="value"]', "40 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="mode-structural"]');
await pg.waitForTimeout(300);
const s4 = await sim();
check("TS-4", s4.stale === true, "after the thermal study's heat changes, the static study's results are marked out of date", { stale: s4.stale }, await snap(pg, "thermalstress-stale"));

// TS-5: Russian.
await pg.click("#lang-btn");
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim *, #sim-tools *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "thermalstress-ru");
await pg.click("#lang-btn");
check("TS-5", ru.length === 0, "the Temperature load and its study are all in Russian", { ru }, ruShot);

await finish(browser, pg);
