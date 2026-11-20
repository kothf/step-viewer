// Structural analysis by hand (FRS-structural SA1): a steel bar clamped at one end with a load on top, set up and
// solved through the Simulation tab, with the stress and displacement plots.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("sim");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());

// SA1-1: the Simulation tab shows its commands and the Study tab beside the model.
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
const tab = await pg.evaluate(() => ({ study: document.querySelector("#tab-sim").classList.contains("on"), cmds: [...document.querySelectorAll("#sim-tools .mc-b .mc-l")].map(e => e.textContent) }));
const img1 = await snap(pg, "simulation-tab");
check("SA1-1", tab.study && tab.cmds.includes("Solve") && tab.cmds.includes("Force") && tab.cmds.includes("Fixed support"), "the Simulation tab lists study, support, load and solve commands and opens the Study tab", tab, img1);

// SA1-2: Material… picks a steel from the library; the Study tab shows its modulus.
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="new"]');
await idle(pg);
const mat = await pg.evaluate(() => ({ m: window.__sv.model.store.doc.material, note: document.querySelector("#sim-tree .sim-note")?.textContent ?? "" }));
const img2 = await snap(pg, "material");
check("SA1-2", mat.m?.E > 100 && /GPa/.test(mat.note), "a library steel becomes the part's material and the study shows E and ν", { name: mat.m?.name, E: mat.m?.E, note: mat.note }, img2);

// SA1-3: Fixed support: click the end face, ✓.
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
const img3 = await snap(pg, "fixed-face");
const s3 = await pg.evaluate(() => ({ faces: document.querySelector("#sim-pm .sim-faces")?.textContent, marks: window.__sv.sim.state().marks }));
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// SA1-4: Force: click the top face, type 1000 N, ✓.
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.fill('#sim-pm [data-n="value"]', "1000");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(250);
const img4 = await snap(pg, "force-face");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const rows = await pg.$$eval("#sim-tree .sim-row .sim-name", els => els.map(e => e.textContent.trim()));
check("SA1-3", s3.faces === "1 face" && s3.marks >= 1 && rows.length === 2, "a support and a force take the faces clicked on the model and show in the study tree", { s3, rows }, img4);
void img3;

// SA1-5: Solve: progress, then the stress plot on the deformed shape and the numbers (beam theory with shear: 0.0465 mm, 37.5 MPa).
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(400);
const img5 = await snap(pg, "solving");
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 });
await pg.waitForTimeout(400);
const r = await sim();
const img6 = await snap(pg, "stress-deformed");
check("SA1-5", !r.error && Math.abs(r.maxU / 0.0465 - 1) < 0.08 && Math.abs(r.maxVm / 37.5 - 1) < 0.3 && r.plot.shown,
  "the bar solves: tip deflection and root stress match beam theory, the reaction equals the load, the stress plot shows on the deformed shape", { err: r.error, maxU: r.maxU, maxVm: r.maxVm, passes: r.passes.map(p => [p.p, p.dofs, p.change]), reaction: r.reactions[0]?.force }, img6);
void img5;

// SA1-6: the legend switches to displacement on the undeformed model.
await pg.selectOption('#sim-legend [data-k="kind"]', "u");
await pg.uncheck('#sim-legend [data-k="deformed"]');
await pg.waitForTimeout(300);
const r2 = await sim();
const img7 = await snap(pg, "displacement");
check("SA1-6", r2.plot.kind === "u" && r2.plot.scale === 0 && Math.abs(r2.plot.range[1] - r.maxU) < 1e-6, "the legend switches the plot to displacement and turns the deformed shape off", r2.plot, img7);

// SA1-7: editing the force (double the load) puts the results out of date; Solve again doubles the deflection.
await pg.click("#sim-tree .sim-row[data-id=\"l1\"] .sim-name");
await pg.fill('#sim-pm [data-n="value"]', "2000");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const stale = (await sim()).stale;
const img8 = await snap(pg, "out-of-date");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && !s.stale) || s.error; }, null, { timeout: 300000 });
const r3 = await sim();
const img9 = await snap(pg, "solved-again");
check("SA1-7", stale && !r3.error && Math.abs(r3.maxU / r.maxU - 2) < 0.01, "a changed load marks the results out of date; solving again doubles the deflection", { stale, maxU: r3.maxU }, img9);
void img8;
await finish(browser, pg);
