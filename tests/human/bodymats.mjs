// Bodies with their own materials by hand: a steel bar with a second body on its end is solved, then the second
// body gets aluminium from its row in the Features tree and the study is solved again with both materials.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, cmd } from "./lib.mjs";
const { browser, pg } = await open("bodymats");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");

// a second body: a 30 long block on the end of the first, Merge result off
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
// zoom out so the new block's far end is on screen
await pg.mouse.move(700, 450);
await pg.mouse.wheel(0, 500);
await pg.waitForTimeout(600);
await pg.click('#mc-tools [data-c="sk:rect"]');
await clickAt(pg, await screenOf(pg, [50, -10, 0]));
await clickAt(pg, await screenOf(pg, [80, 10, 0]));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
await pg.uncheck('#mc-pm input[data-k="merge"]');
await idle(pg);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
await dp.fill("20"); await dp.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const made = await pg.evaluate(() => ({ bodies: window.__sv.model.last().bodies?.length ?? 0, volume: window.__sv.model.last().props?.volume }));
check("BM-1", made.bodies === 2 && Math.abs(made.volume - 52000) < 1, "the part has two bodies, 100 and 30 long", made, await snap(pg, "two-bodies"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="new"]');
await idle(pg);
// clamped at the end of the second body, pushed down on top of the first
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [80, 0, 10]));
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
const sf0 = await pg.evaluate(() => Number(document.querySelector('#sim-tree [data-v="sf"]')?.textContent ?? NaN));

// BM-2: the second body gets aluminium from its row's menu; the study lists it and goes out of date.
await pg.click("#t-features");
await pg.waitForTimeout(300);
const rows = await pg.$$("#mc-tree .ft-row.ft-body");
await rows[rows.length - 1].click({ button: "right" });
await pg.waitForTimeout(300);
await pg.locator("#mc-menu button, .mc-menu button").filter({ hasText: "Material" }).first().click();
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
const img2 = await snap(pg, "body-material");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click("#t-sim");
await pg.waitForTimeout(300);
const s1 = await sim();
const own = await pg.evaluate(() => document.querySelector("#sim-tree .sim-bodymats")?.textContent ?? "");
check("BM-2", !r0.error && r0.bodyMats === null && s1.stale && /6061/.test(own), "a body given aluminium is listed under the study's material; the old results are out of date", { own, stale: s1.stale, error: r0.error }, img2);

// BM-3: solved again: both materials are used. The softer root lets the bar sag more.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r1 = await sim();
const info = await pg.evaluate(() => ({ note: document.querySelector("#sim-tree .sim-bonded")?.textContent ?? "", sf: Number(document.querySelector('#sim-tree [data-v="sf"]')?.textContent ?? NaN),
  wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
check("BM-3", !r1.error && r1.bodyMats?.length === 2 && /6061/.test(r1.bodyMats.join()) && /own material/.test(info.note) && r1.maxU > 1.15 * r0.maxU && r1.maxU < 3.2 * r0.maxU && info.sf > 0 && info.wide <= 0 && r1.plot.shown,
  "each body is solved with its own material: the deflection grows with the aluminium root, and the Study tab says each body has its own material", { error: r1.error, bodyMats: r1.bodyMats, maxU: [r0.maxU, r1.maxU], maxVm: [r0.maxVm, r1.maxVm], sf: [sf0, info.sf], note: info.note, wide: info.wide }, await snap(pg, "two-materials"));

// BM-4: the safety factor plot follows each body's yield strength.
await pg.selectOption('#sim-legend [data-k="kind"]', "sf");
await pg.waitForTimeout(500);
const r2 = await sim();
check("BM-4", r2.plot.kind === "sf" && r2.plot.shown, "the safety factor plot is drawn with each body's own yield strength", { plot: r2.plot }, await snap(pg, "safety-factor"));

await finish(browser, pg);
