// Structural test set, real parts (FRS-structural NFR-SIM-022 by hand): three parts of the model steam engine are
// opened from their files, given steel, held and loaded on faces picked on the model and solved. The largest
// displacement is compared with CalculiX's for the same set-up (docs/structural-validation.md). Each part is
// saved with its study in HT_MODELS. HT_PARTS = the folder with the engine's .mcadprt files.
import { open, snap, idle, screenOf, clickAt, check, finish, openFiles, saveModel, boreSpot, OUT } from "./lib.mjs";
const PARTS = process.env.HT_PARTS || "/mnt/project-files/leuenberger";
const MODELS = process.env.HT_MODELS || `${OUT}/models`;
const Z = [0, 0, 1], Y = [0, 1, 0];
// a view: keys pressed after the isometric view (arrows turn it by 15°, Shift by 90°)
const BELOW = ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"];
const CASES = [
  { id: "con-rod", file: "2-03-con-rod.mcadprt", what: "the connecting rod (two bodies): big end bore held, small end bore pulled and pushed sideways", bodies: 2,
    fixed: [{ bore: [[90, 0, 0], Z, 6, -4.5, 4.5] }],
    loaded: [{ bore: [[0, 0, 0], Z, 4.5, 2.5, 4.5] }],
    force: [-400, 60, 0], maxU: 0.14972, passes: 4 },
  { id: "fork-link", file: "2-06.1-fork-link.mcadprt", what: "the fork link: end of the stem held, pin holes of the fork loaded across the stem", bodies: 1,
    fixed: [{ at: [25.5, 0.5, 0.5] }],
    loaded: [{ bore: [[4, 0, 0], Y, 1.5, -3.2, -1.5] }],
    force: [0, 0, -40], maxU: 0.024887, passes: 3 },
  { id: "bracket", file: "1-01.4-bracket.mcadprt", what: "the bracket: underside of the foot held, bore of the forked lug loaded down and sideways", bodies: 1,
    fixed: [{ view: BELOW, at: [30, 2, 0] }],
    loaded: [{ bore: [[32.5, 0, 15], Y, 3, -4.5, -1.5] }],
    force: [0, 80, -200], maxU: 0.0046832, passes: 6 },
];
const only = process.argv[2];
const { browser, pg } = await open("set-engine");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const faces = () => pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
async function view(keys = []) {
  await pg.mouse.move(700, 480);
  await pg.keyboard.press("Control+7");
  await pg.waitForTimeout(900);
  for (const k of keys) { await pg.keyboard.press(k); await pg.waitForTimeout(450); }
  await pg.keyboard.press("f");
  await pg.waitForTimeout(700);
}
async function pick(list) {
  for (const p of list) {
    await view(p.view);
    const at = p.bore ? await boreSpot(pg, ...p.bore) : p.at;
    await clickAt(pg, await screenOf(pg, at));
    await pg.waitForTimeout(250);
  }
  return faces();
}
for (const c of CASES.filter(c => !only || c.id === only)) {
  await openFiles(pg, [`${PARTS}/${c.file}`]);
  await pg.click("#cm-t-simulation");
  await pg.click('#sim-tools [data-s="mat"]');
  await pg.waitForSelector("#mat-dlg[open]");
  await pg.fill("#mat-q", "S235");
  await pg.waitForTimeout(300);
  await pg.click("#mat-dlg .mat-list li");
  await pg.click('#mat-dlg [data-a="ok"]');
  await idle(pg);
  await pg.click('#sim-tools [data-s="new"]');
  await pg.waitForTimeout(500);
  await pg.keyboard.press("Escape");
  await pg.click('#sim-tools [data-s="fixed"]');
  const held = await pick(c.fixed);
  const shot1 = await snap(pg, `${c.id}-held`);
  await pg.click("#sim-pm .pm-ok");
  await pg.waitForTimeout(400);
  await pg.click('#sim-tools [data-s="force"]');
  const pushed = await pick(c.loaded);
  await pg.uncheck('#sim-pm [data-k="normal"]');
  await pg.waitForTimeout(200);
  for (let k = 0; k < 3; k++) { await pg.fill(`#sim-pm [data-n="c${k}"]`, String(c.force[k])); await pg.keyboard.press("Tab"); }
  await pg.waitForTimeout(200);
  const shot2 = await snap(pg, `${c.id}-loaded`);
  await pg.click("#sim-pm .pm-ok");
  await pg.waitForTimeout(400);
  // a bore that a slot cuts in two is one face to pick: both walls light up and both carry the load
  const lit = await pg.evaluate(() => window.__sv.sim.state().marks);
  check(`SE-${c.id}-1`, held === "1 face" && pushed === "1 face" && lit >= 1,
    `${c.what}: the faces are picked on the model; one click takes both walls of the bore that the slot cuts in two`, { held, pushed, marks: lit }, shot2);
  void shot1;
  await view();
  await pg.selectOption('#sim-tree [data-k="passes"]', String(c.passes));
  await pg.waitForTimeout(300);
  await pg.click('#sim-tools [data-s="solve"]');
  await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 900000 });
  await pg.waitForTimeout(600);
  const r = await sim();
  const total = Math.hypot(...c.force), sum = r.error ? [NaN] : [0, 1, 2].map(k => r.reactions.reduce((a, q) => a + q.force[k], 0) + c.force[k]);
  const off = r.error ? NaN : (r.maxU / c.maxU - 1) * 100;
  check(`SE-${c.id}-2`, !r.error && Math.abs(off) < 3 && Math.hypot(...sum) < 1e-3 * total && r.bodies === (c.bodies > 1 ? c.bodies : r.bodies),
    `solved: the largest displacement is within 3 % of CalculiX's ${c.maxU} mm and the support carries the whole load`, { error: r.error, maxU: r.maxU, off, maxVm: r.maxVm, passes: r.passes?.map(p => [p.p, p.dofs, p.change]), unbalanced: sum, bodies: r.bodies }, await snap(pg, `${c.id}-solved`));
  const path = await saveModel(pg, MODELS, c.id);
  const { statSync } = await import("node:fs");
  check(`SE-${c.id}-3`, statSync(path).size > 1000, "the part is saved with its study", { path, bytes: statSync(path).size });
}
await finish(browser, pg);
