// Inertia relief by hand (FRS-structural FR-SUP-007): a block with a force and no support is refused, then solved
// with Inertia relief on: the loads are balanced by the block's own inertia.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simrelief");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };

await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);

// R-1: no support: the solve is refused and the message names Inertia relief.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
const msg = await pg.evaluate(() => document.querySelector("#sim-tree .sim-res .sim-prob")?.textContent ?? "");
check("R-1", /E-SIM-FREE/.test(s1.error ?? "") && /Inertia relief/.test(msg), "without a support the study is not solved, and the message offers Inertia relief", { error: s1.error, msg }, await snap(pg, "relief-refused"));

// R-2: Inertia relief ticked under Supports, solved: the acceleration is the force over the mass, no reactions.
await pg.check('#sim-tree [data-k="relief"]');
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const shown = await pg.evaluate(() => ({ accel: document.querySelector('#sim-tree [data-v="accel"]')?.textContent ?? "", note: document.querySelector("#sim-tree .sim-relieved .sim-note")?.textContent ?? "",
  wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
const F = Math.hypot(...(s2.applied?.force ?? [0, 0, 0])), mass = 7.85e-9 * 100 * 20 * 20, a = s2.accel ? Math.hypot(...s2.accel.a) : 0;
check("R-2", !s2.error && s2.relief && F > 0 && Math.abs(a / (F / mass) - 1) < 0.01 && s2.reactions.length === 0 && s2.plot.shown && s2.maxU < 1 && s2.maxVm > 0 && /m\/s²/.test(shown.accel) && shown.note.length > 20 && shown.wide <= 0,
  "with Inertia relief the free block is solved; the Study tab shows the acceleration the force gives it and no reactions", { F, a, expected: F / mass, maxU: s2.maxU, maxVm: s2.maxVm, shown }, await snap(pg, "relief-solved"));

// R-3: unticked again: the results are out of date.
await pg.uncheck('#sim-tree [data-k="relief"]');
await idle(pg);
const s3 = await sim();
check("R-3", !s3.relief && s3.stale, "turning Inertia relief off marks the results out of date", { relief: s3.relief, stale: s3.stale }, await snap(pg, "relief-off"));

await finish(browser, pg);
