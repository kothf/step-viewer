// Local accuracy passes in a thermal study (FRS-thermal FR-TSOL-003): after three passes over every cell, passes 4 to 6
// raise the degree only in the cells where the temperatures still move, say where, and the heat still balances.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermallocal");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
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
// one end held at 40 °C, a side cooled by air
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [0, -10, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
check("TL-1", !s3.error && s3.passes.length <= 3 && "2,3,4".startsWith(s3.passes.map(p => p.p).join()) && s3.passes.every(p => !p.raised), "by default up to three passes raise every cell together (degree 2, 3, 4), stopping once the answer settles", { passes: s3.passes.map(p => ({ p: p.p, dofs: p.dofs })), max: s3.thermal?.max }, await snap(pg, "three-passes"));

await pg.selectOption('#sim-tree [data-k="passes"]', "6");
await idle(pg);
await pg.fill('#sim-tree [data-k="tol"]', "0");
await pg.press('#sim-tree [data-k="tol"]', "Tab");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s6 = await sim();
const ui = await pg.evaluate(() => ({ notes: [...document.querySelectorAll("#sim-tree .sim-local")].map(e => e.textContent), rows: document.querySelectorAll("#sim-tree .sim-passes tbody tr").length }));
const last = s6.passes[s6.passes.length - 1] ?? {};
check("TL-2", !s6.error && s6.passes.length >= 4 && s6.passes.slice(3).every(p => p.raised > 0 && p.raised < p.cells) && ui.notes.length === s6.passes.length - 3 && /accuracy raised in/.test(ui.notes[0] ?? ""),
  "six passes: from pass 4 on only some cells get a higher degree, and the Study tab says how many", { passes: s6.passes.map(p => ({ p: p.p, raised: p.raised, cells: p.cells, dofs: p.dofs })), ui }, await snap(pg, "local-passes"));
const out = (s6.thermal?.out ?? []).reduce((a, b) => a + b, 0);
check("TL-3", Math.abs(out - 10) < 0.01 && Math.abs(s6.thermal.max - s3.thermal.max) < 0.02 * (s3.thermal.max - 40) && last.dofs < last.cells * 84,
  "the 10 W still leave through the two faces, the hottest point agrees with three passes within 2 % of the rise, and the last pass needed fewer unknowns than degree 6 everywhere", { out, max: [s3.thermal.max, s6.thermal.max], last }, await snap(pg, "balance"));
await finish(browser, pg);
