// Modal analysis by hand (FRS-structural SA2): a steel bar clamped at one end, its natural frequencies and mode
// shapes found through the Simulation tab; then the same bar free, with its six rigid-body modes.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("modal");
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

// SA2-1: Modal study makes a study with no Loads section, and the load commands are off.
await pg.click('#sim-tools [data-s="newmodal"]');
await idle(pg);
const s1 = await pg.evaluate(() => ({
  kind: document.querySelector('#sim-tree [data-v="kind"]')?.textContent, heads: [...document.querySelectorAll("#sim-tree h4")].map(e => e.textContent),
  force: document.querySelector('#sim-tools [data-s="force"]').disabled, modes: document.querySelector('#sim-tree [data-k="modes"]')?.value, name: window.__sv.model.store.doc.studies[0].name,
}));
const img1 = await snap(pg, "modal-study");
check("SA2-1", s1.kind === "Modal" && !s1.heads.includes("Loads") && s1.force && s1.modes === "6" && s1.name === "Modal 1", "Modal study makes a study without loads, six modes by default", s1, img1);

// SA2-2: fixed end, Solve: the mode table, the first bending frequency near beam theory (about 1.6 kHz), the shape swinging.
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r = await sim();
const tab = await pg.evaluate(() => ({ rows: document.querySelectorAll("#sim-tree table.sim-modes tbody tr").length, f1: document.querySelector('#sim-tree [data-v="f1"]')?.textContent, mass: document.querySelector('#sim-tree [data-v="mass"]')?.textContent,
  wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth, legend: document.querySelector('#sim-legend [data-k="mode"]')?.value }));
const fr0 = r.frames;
await pg.waitForTimeout(500);
const r2 = await sim();
const img2 = await snap(pg, "modes");
check("SA2-2", !r.error && r.modes.length === 6 && r.modes[0].hz > 1450 && r.modes[0].hz < 1720 && Math.abs(r.modes[1].hz / r.modes[0].hz - 1) < 0.02 && tab.rows === 6 && /Hz/.test(tab.f1 ?? "") && Math.abs(parseFloat(tab.mass) - 0.314) < 0.005
  && tab.wide <= 0 && r.plot.shown && r.animating && r2.frames > fr0 && tab.legend === "0",
  "the clamped bar's two first bending modes sit near 1.6 kHz, the table lists six modes and the shape swings on the model", { hz: r.modes.map(m => m.hz), eff: r.modes[0].eff, tab, frames: [fr0, r2.frames], passes: r.passes }, img2);

// SA2-3: a click on a mode in the table shows that mode; Animate off holds it still.
await pg.click('#sim-tree table.sim-modes tbody tr[data-mode="2"]');
await pg.waitForTimeout(300);
const r3 = await sim();
await pg.uncheck('#sim-legend [data-k="animate"]');
await pg.waitForTimeout(300);
const r4 = await sim();
const sel = await pg.evaluate(() => ({ row: document.querySelector("#sim-tree table.sim-modes tr.sel")?.dataset.mode, legend: document.querySelector('#sim-legend [data-k="mode"]')?.value }));
const img3 = await snap(pg, "mode-3-still");
check("SA2-3", r3.mode === 2 && sel.row === "2" && sel.legend === "2" && r3.animating && !r4.animating && r4.plot.shown, "a mode picked in the table is drawn, and Animate off holds its shape still", { mode: r3.mode, sel, animating: [r3.animating, r4.animating] }, img3);

// SA2-4: the report of a modal study saves with the mode table and pictures of the shapes.
await pg.evaluate(() => window.__sv.sim.report("html"));
await pg.waitForTimeout(1500);
const rep = (await sim()).report;
check("SA2-4", rep?.kind === "html" && rep.images >= 3, "the report holds the mode table and a picture per mode shape", rep, await snap(pg, "after-report"));

// SA2-5: without the support the bar is free: six modes at 0 Hz marked as rigid-body motions, then the elastic ones.
await pg.click('#sim-tree .sim-row [data-a="del"]');
await idle(pg);
await pg.fill('#sim-tree [data-k="modes"]', "8");
await pg.keyboard.press("Tab");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "1");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const f = await sim();
const note = await pg.evaluate(() => ({ rigid: document.querySelector("#sim-tree .sim-rigid")?.textContent ?? "", rows: document.querySelectorAll("#sim-tree table.sim-modes tbody tr.rigid").length }));
const img5 = await snap(pg, "free-bar");
check("SA2-5", !f.error && f.modes.length === 8 && f.modes.filter(m => m.rigid).length === 6 && f.modes[6].hz > 5000 && f.mode === 6 && note.rows === 6 && /^6 /.test(note.rigid),
  "a free bar has six rigid-body modes at 0 Hz, and the first elastic mode is the one shown", { hz: f.modes.map(m => m.hz), mode: f.mode, note }, img5);

await finish(browser, pg);
