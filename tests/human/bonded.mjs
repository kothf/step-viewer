// Bonded bodies by hand (FRS-structural AT-SA2-5): a bar made of two bodies that touch end to end is
// analysed as one piece, and the Study tab says so.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, cmd } from "./lib.mjs";
const { browser, pg } = await open("bonded");
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
check("BND-1", made.bodies === 2 && Math.abs(made.volume - 52000) < 1, "the part has two bodies, 100 and 30 long", made, await snap(pg, "two-bodies"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="newmodal"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [80, 0, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 });
await pg.waitForTimeout(600);
const r = await sim();
const note = await pg.evaluate(() => document.querySelector("#sim-tree .sim-bonded")?.textContent ?? "");
// one bar 130 long clamped at an end: 1640 Hz × (100 / 130)² ≈ 970 Hz
check("BND-2", !r.error && r.bodies === 2 && /2 bodies/.test(note) && Math.abs(r.modes[0].hz / 970 - 1) < 0.05 && r.plot.shown,
  "the two bodies are analysed bonded: the first frequency is that of one 130 long bar, and the tab says the bodies are joined", { error: r.error, bodies: r.bodies, note, hz: r.modes.map(m => m.hz) }, await snap(pg, "bonded-mode"));

await finish(browser, pg);
