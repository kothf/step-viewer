// More supports and loads by hand (FRS-structural FR-SUP-005, FR-SUP-006, FR-LOAD-007): a block on an elastic
// support pushed down by an enforced displacement, then spun about an axis.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, simCmd } from "./lib.mjs";
const { browser, pg } = await open("loads2");
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

// L2-1: Elastic support on the end face x = 50, 200 N/mm³ along the normal, free in the face.
await simCmd(pg, "elastic");
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="kn"]', "200");
await pg.keyboard.press("Tab");
await pg.fill('#sim-pm [data-q="kt"]', "0");
await pg.keyboard.press("Tab");
const img1 = await snap(pg, "elastic-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const s1 = await pg.evaluate(() => window.__sv.model.store.doc.studies[0].supports.map(s => [s.type, s.kn, s.kt, s.faces.length]));
check("L2-1", JSON.stringify(s1) === JSON.stringify([["elastic", 200, 0, 1]]), "an elastic support with its two stiffnesses is added on the clicked face", s1, img1);

// L2-2: the top face is pushed down 0.02 mm (only Z given). No load: the solve runs on the displacement alone.
await simCmd(pg, "disp");
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.waitForTimeout(250);
await pg.uncheck('#sim-pm [data-k="dir0"]');
await pg.uncheck('#sim-pm [data-k="dir1"]');
await pg.fill('#sim-pm [data-q="d2"]', "-0.02");
await pg.keyboard.press("Tab");
const img2 = await snap(pg, "displacement-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r2 = await sim();
check("L2-2", r2.error && /free to move|Add a support/.test(await pg.evaluate(() => document.querySelector("#tab-sim").textContent)),
  "springs along X and a push along Z leave the block free to slide along Y: the study says so instead of solving", { error: r2.error }, img2);

// L2-3: with the springs also holding in the face, the study solves; the two reactions balance.
await pg.click('#sim-tree .sim-row [data-a="edit"]');
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="kt"]', "200");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r3 = await sim();
const sum = r3.reactions.length === 2 ? [0, 1, 2].map(i => r3.reactions[0].force[i] + r3.reactions[1].force[i]) : [NaN];
const img3 = await snap(pg, "pushed-down");
check("L2-3", !r3.error && r3.reactions.length === 2 && r3.reactions[1].force[2] < -1 && Math.hypot(...sum) < 0.01 * Math.abs(r3.reactions[1].force[2]) && r3.maxU >= 0.02 && r3.plot.shown,
  "the block bends on its springs under the pushed face; the springs' reaction balances the pushing force", { error: r3.error, reactions: r3.reactions.map(r => r.force), maxU: r3.maxU }, img3);

// L2-4: a centrifugal load of 12000 rpm about Y at the origin: nothing is thrown one way (the block is centred), stresses grow.
await simCmd(pg, "centrifugal");
await pg.waitForTimeout(250);
await pg.selectOption('#sim-pm [data-k="axis"]', "y");
await pg.fill('#sim-pm [data-n="value"]', "12000");
await pg.keyboard.press("Tab");
const img4 = await snap(pg, "centrifugal-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r4 = await sim();
// ρ ω² V z̄: 7.85e-9 × (1257)² × 40000 × 10 ≈ 4958 N along Z (the block sits on z = 0..20), none along X
const row = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-row")].at(-1)?.textContent ?? "");
check("L2-4", !r4.error && /Axis Y/.test(row) && Math.abs(r4.applied.force[2] / 4958 - 1) < 0.03 && Math.abs(r4.applied.force[0]) < 0.05,
  "the spinning block is thrown outwards from the Y axis by ρ ω² V r", { error: r4.error, row, applied: r4.applied?.force }, await snap(pg, "spinning"));

await finish(browser, pg);
