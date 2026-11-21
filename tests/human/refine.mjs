// Local accuracy by hand (FRS-structural FR-SOL-012): a clamped block under a force is solved, then solved again
// with local accuracy at the clamped face, then with that item left out.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("refine");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 }); await pg.waitForTimeout(400); };

await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r0 = await sim();

// R-1: Local accuracy, level 3, on the clamped face. The row appears under Accuracy; the results go stale.
await pg.click('#sim-tools [data-s="refine"]');
await pg.waitForTimeout(250);
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.selectOption('#sim-pm [data-k="level"]', "3");
const img1 = await snap(pg, "refine-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const s1 = await sim();
const row = await pg.evaluate(() => document.querySelector("#sim-tree .sim-refs .sim-row")?.textContent ?? "");
const wide = await pg.evaluate(() => document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth);
check("R-1", !r0.error && JSON.stringify(s1.refine) === JSON.stringify([[1, 3]]) && /level 3/.test(row) && s1.stale && wide <= 0 && s1.marks >= 3,
  "a Local accuracy item with its face and level is listed under Accuracy and marked on the model; the old results are out of date", { refine: s1.refine, row, stale: s1.stale, wide, marks: s1.marks }, img1);

// R-2: solved again: the first pass runs at degree 5 at that face, with more unknowns on the same cells.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r2 = await sim();
check("R-2", !r2.error && r2.passes[0].p === 5 && r0.passes[0].p === 2 && r2.passes[0].dofs > r0.passes[0].dofs && r2.passes[0].cells === r0.passes[0].cells
  && Math.abs(r2.maxU / r0.maxU - 1) < 0.05 && r2.plot.shown,
  "with local accuracy the first pass is finer at the picked face; the deflection stays the same", { p: [r0.passes[0].p, r2.passes[0].p], dofs: [r0.passes[0].dofs, r2.passes[0].dofs], maxU: [r0.maxU, r2.maxU], maxVm: [r0.maxVm, r2.maxVm] }, await snap(pg, "refined-result"));

// R-3: the item left out: solved as before.
await pg.click('#sim-tree .sim-refs .sim-row [data-a="toggle"]');
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r3 = await sim();
check("R-3", !r3.error && r3.passes[0].p === 2 && r3.passes[0].dofs === r0.passes[0].dofs, "left out, the item changes nothing", { p: r3.passes[0].p, dofs: [r0.passes[0].dofs, r3.passes[0].dofs] }, await snap(pg, "left-out"));

await finish(browser, pg);
