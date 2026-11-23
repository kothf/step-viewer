// The progress line of a solve (FRS-structural FR-SOL-023, FR-SARC-005): while a study is solved the status bar says
// which pass and step it is at, the view still turns, and Stop ends it keeping the passes done so far.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simprogress");
await makeBlock(pg, 60, 30, 20);
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
const line = () => pg.evaluate(() => { const e = document.querySelector("#st-sim"); return { shown: !e.hidden, text: e.querySelector(".st-sim-t")?.textContent ?? "", pc: e.querySelector(".st-sim-p")?.textContent ?? "", time: e.querySelector(".st-sim-s")?.textContent ?? "", stop: !!e.querySelector('button[data-a="simstop"]') }; });
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [12, -15, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-12, 5, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "500");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.selectOption('#sim-tree [data-k="passes"]', "6");
await pg.fill('#sim-tree [data-k="tol"]', "0");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);

// the longest time the page did not answer, measured by a timer that should tick every 16 ms
await pg.evaluate(() => { window.__gap = 0; let last = performance.now(); const tick = () => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; setTimeout(tick, 16); }; tick(); });
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => /Pass [2-9]/.test(document.querySelector("#st-sim .st-sim-t")?.textContent ?? ""), null, { timeout: 300000 });
const l1 = await line();
check("SPR-1", l1.shown && /Pass \d of \d: /.test(l1.text) && /%/.test(l1.pc) && /^\d+:\d\d$/.test(l1.time) && l1.stop,
  "while the study is solved the status bar shows the pass, what it is doing, a bar with per cent, the time so far and Stop", l1, await snap(pg, "solving"));

// the view answers while the solver works
const v0 = await pg.evaluate(() => JSON.stringify(window.__sv.viewer.getView()));
for (let i = 0; i < 4; i++) { await pg.keyboard.press("ArrowLeft"); await pg.waitForTimeout(150); }
await pg.waitForTimeout(400);
const v1 = await pg.evaluate(() => JSON.stringify(window.__sv.viewer.getView()));
const s1 = await sim();
const gap = await pg.evaluate(() => Math.round(window.__gap));
check("SPR-2", v0 !== v1 && s1.running && gap < 1500,
  "the arrow keys turn the model while the solve runs; the page never stopped answering for long", { turned: v0 !== v1, running: s1.running, longestPauseMs: gap }, await snap(pg, "turned"));

// Stop in the status bar: the solve ends, the passes done so far stay, the line goes
await pg.click('#st-sim button[data-a="simstop"]');
await pg.waitForFunction(() => !window.__sv.sim.state().running, null, { timeout: 30000 });
await pg.waitForTimeout(500);
const s2 = await sim(), l2 = await line();
check("SPR-3", !s2.running && s2.passes.length >= 1 && !l2.shown,
  "Stop in the status bar ends the solve; the passes it had finished stay and the progress line is gone", { passes: s2.passes.length, line: l2.shown }, await snap(pg, "stopped"));

// solved again to the end (two passes): the line comes and goes by itself
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(500);
const s3 = await sim(), l3 = await line();
check("SPR-4", s3.done && !s3.error && s3.passes.length === 2 && s3.maxU > 0 && !l3.shown,
  "solved again with two passes: results show and the progress line has gone by itself", { passes: s3.passes.length, maxU: s3.maxU, threads: s3.threads, isolated: s3.isolated }, await snap(pg, "done"));
await finish(browser, pg);
