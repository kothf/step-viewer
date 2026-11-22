// Solving again after a power or temperature change (FRS-thermal FR-TSOL-021): the study keeps its grid, matrix and
// factorisation, so the new answer comes in a fraction of the first solve's time and says so.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalreuse");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const top = async () => clickAt(pg, await screenOf(pg, [-30, 0, 20]));
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
await pg.click('#sim-tools [data-s="temp"]');
await top();
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
const ms = s => s.passes.reduce((a, p) => a + p.ms, 0);
const note = () => pg.evaluate(() => document.querySelector('#sim-tree [data-v="reused"]')?.textContent ?? "");
const n1 = await note();
check("TR-1", !s1.error && s1.thermal && Math.abs(s1.thermal.min - 40) < 0.02 && !n1, "first solve: 10 W in the block, top face at 40 °C; no reuse note", { thermal: s1.thermal, ms: ms(s1), n1 }, await snap(pg, "first"));

// the heat raised to 25 W in its panel, solved again
await pg.click('#sim-tree .sim-heat .sim-row [data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-n="value"]', "25 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), n2 = await note();
check("TR-2", !s2.error && /same grid and matrix/.test(n2) && Math.abs((s2.thermal.max - 40) / (s1.thermal.max - 40) - 2.5) < 1e-3 && ms(s2) < 0.5 * ms(s1),
  "25 W instead of 10: solved again on the same matrix in under half the time, the rise above 40 °C 2.5 times as high, and a note says why it was quick", { max: [s1.thermal.max, s2.thermal.max], ms: [ms(s1), ms(s2)], n2 }, await snap(pg, "power-changed"));

// the fixed temperature moved to 60 °C: reused again, everything 20 K higher
await pg.click('#sim-tree .sim-cool .sim-row [data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-q="temp"]', "60");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim(), n3 = await note();
check("TR-3", !s3.error && /same grid and matrix/.test(n3) && Math.abs(s3.thermal.max - s2.thermal.max - 20) < 1e-3 && Math.abs(s3.thermal.min - 60) < 0.02,
  "the top face at 60 °C instead of 40: solved again on the same matrix, every temperature 20 K higher", { max: [s2.thermal.max, s3.thermal.max], min: s3.thermal.min, ms: ms(s3) }, await snap(pg, "temp-changed"));

// a new cooling face changes the matrix: built again, no note
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [-30, -10, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim(), n4 = await note();
check("TR-4", !s4.error && !n4 && s4.thermal.flows.length === 2 && s4.thermal.max < s3.thermal.max,
  "convection on a side face is a new matrix: built again (no note), and the block runs cooler", { max: [s3.thermal.max, s4.thermal.max], ms: ms(s4) }, await snap(pg, "new-sink"));
await finish(browser, pg);
