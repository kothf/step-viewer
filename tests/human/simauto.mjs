// Solve on change and the memory of a pass by hand (FRS-structural FR-STU-022, FR-SOL-020): a plate held on a side
// and pushed down; with Solve on change ticked it is solved without the Solve button, and again after the load is changed.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simauto");
await makeBlock(pg, 40, 20, 5);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(800);

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solvedBy = async n => { await pg.waitForFunction(k => { const s = window.__sv.sim.state(); return s.autoRuns >= k && !s.running && (s.done || s.error); }, n, { timeout: 300000 }); await pg.waitForTimeout(500); };
const wide = () => pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");

// ticked before anything is set up: nothing to solve yet, and nothing is said about it
await pg.check('#sim-tree [data-k="auto"]');
await pg.waitForTimeout(1500);
const s0 = await sim();
const toasts0 = await pg.evaluate(() => document.querySelectorAll(".toast.error, .toast.warn").length);
check("SAU-1", s0.auto && s0.autoRuns === 0 && !s0.running && !s0.error && toasts0 === 0 && (await wide()) <= 0,
  "Solve on change ticked on an empty study: it waits for a support and a load, without a message", { auto: s0.auto, runs: s0.autoRuns, toasts0, wide: await wide() }, await snap(pg, "ticked"));

// a support alone does not start it; the load does
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(1500);
const s1 = await sim();
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-8, 3, 5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "200");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(1200);
const s1b = await sim();
await pg.click("#sim-pm .pm-ok");
await solvedBy(1);
const s2 = await sim();
const title = await pg.evaluate(() => document.querySelector("#sim-tree .sim-passes tbody td[title]")?.title ?? "");
check("SAU-2", s1.autoRuns === 0 && s1b.autoRuns === 0 && s2.autoRuns === 1 && !s2.error && s2.done && s2.maxU > 0 && s2.passes.every(p => p.memory > 0) && /MB/.test(title) && (await wide()) <= 0,
  "the support alone starts nothing, nor does the open Force panel; once the force is accepted the study is solved by itself, and each pass says how much memory it took", { runs: [s1.autoRuns, s1b.autoRuns, s2.autoRuns], error: s2.error, maxU: s2.maxU, title }, await snap(pg, "solved"));

// the force doubled: solved again, the displacement doubles
await pg.click('#sim-tree .sim-loads .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm [data-n="value"]');
await pg.fill('#sim-pm [data-n="value"]', "400");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await solvedBy(2);
const s3 = await sim();
check("SAU-3", s3.autoRuns === 2 && !s3.error && !s3.stale && Math.abs(s3.maxU / s2.maxU - 2) < 0.01,
  "the force changed to 400 N: the study is solved again by itself, with twice the displacement", { runs: s3.autoRuns, u: [s2.maxU, s3.maxU], stale: s3.stale }, await snap(pg, "again"));

// unticked, a change leaves the results out of date
await pg.uncheck('#sim-tree [data-k="auto"]');
await pg.waitForTimeout(300);
await pg.click('#sim-tree .sim-loads .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm [data-n="value"]');
await pg.fill('#sim-pm [data-n="value"]', "300");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(2000);
const s4 = await sim();
check("SAU-4", !s4.auto && s4.autoRuns === 2 && !s4.running && s4.stale,
  "unticked: a changed load leaves the results marked out of date until Solve is clicked", { auto: s4.auto, runs: s4.autoRuns, stale: s4.stale }, await snap(pg, "unticked"));
await finish(browser, pg);
