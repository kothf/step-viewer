// Thermal solve on change by hand (FRS-thermal FR-TSOL-020): a new steady thermal study solves by itself once the heat
// has a way out, again after every change, never for a warm-up, and not once Solve on change is unticked.
// (`?simauto`: under webdriver new studies keep it off unless asked, so the smoke test solves only on Solve.)
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalauto", "&simauto");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const ran = n => pg.waitForFunction(n => { const s = window.__sv.sim.state(); return s.autoRuns > n && !s.running && (s.done || s.error); }, n, { timeout: 300000 });
const box = () => pg.evaluate(() => { const b = document.querySelector('#sim-tree [data-k="auto"]'); return { on: !!b?.checked, off: !!b?.disabled }; });
const ambient = async v => { await pg.fill('#sim-tree [data-k="ambient"]', v); await pg.press('#sim-tree [data-k="ambient"]', "Tab"); await idle(pg); };

// TA-1: material, 10 W in the whole block: the new thermal study has Solve on change ticked but waits (no way out yet).
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.waitForTimeout(1500);
const a1 = await sim(), b1 = await box();
check("TA-1", b1.on && !b1.off && a1.autoRuns === 0 && !a1.running && !a1.error, "a new thermal study has Solve on change ticked, and does not solve while the heat has no way out", { b1, runs: a1.autoRuns }, await snap(pg, "auto-waits"));

// TA-2: convection 25 W/(m²·K) on the top face: the study solves by itself.
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="hc"]', "25");
await pg.press('#sim-pm [data-q="hc"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await ran(0);
const a2 = await sim();
check("TA-2", a2.autoRuns === 1 && !a2.error && a2.done && a2.plot.shown && a2.thermal.min > 25, "adding the convection solves the study by itself and shows the temperatures", { runs: a2.autoRuns, thermal: a2.thermal, error: a2.error }, await snap(pg, "auto-solved"));

// TA-3: Rise above ambient picked, ambient typed 40 °C: solved again, everything 15 K warmer, the plot kept.
await pg.selectOption('#sim-legend [data-k="kind"]', "rise");
await pg.waitForTimeout(300);
await ambient("40");
await ran(1);
const a3 = await sim();
check("TA-3", a3.autoRuns === 2 && !a3.error && Math.abs(a3.thermal.min - a2.thermal.min - 15) < 0.05 && Math.abs(a3.thermal.max - a2.thermal.max - 15) < 0.05 && a3.plot.kind === "rise",
  "a new ambient solves the study again: every temperature moves by the same 15 K and Rise above ambient stays the plot", { min: [a2.thermal.min, a3.thermal.min], max: [a2.thermal.max, a3.thermal.max], kind: a3.plot.kind }, await snap(pg, "auto-ambient"));

// TA-4: a warm-up waits for Solve: the box is greyed and nothing runs.
await pg.click('#sim-tools [data-s="transient"]');
await idle(pg);
await pg.waitForTimeout(1500);
const a4 = await sim(), b4 = await box();
check("TA-4", a4.autoRuns === 2 && b4.off && !b4.on && a4.stale && !a4.running, "turned into a warm-up, the study waits for Solve: Solve on change is greyed", { b4, runs: a4.autoRuns, stale: a4.stale }, await snap(pg, "auto-warmup"));

// TA-5: back to steady, Solve on change unticked, ambient 30 °C: the results go out of date and nothing runs.
await pg.click('#sim-tools [data-s="transient"]');
await idle(pg);
await pg.waitForTimeout(300);
await pg.uncheck('#sim-tree [data-k="auto"]');
await idle(pg);
await ambient("30");
await pg.waitForTimeout(1500);
const a5 = await sim(), b5 = await box();
check("TA-5", !b5.on && !b5.off && a5.autoRuns === 2 && a5.stale && !a5.running, "with Solve on change unticked a change only puts the results out of date", { b5, runs: a5.autoRuns, stale: a5.stale }, await snap(pg, "auto-off"));
await finish(browser, pg);
