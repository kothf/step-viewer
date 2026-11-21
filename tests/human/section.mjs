// Results on section planes by hand (FRS-structural FR-RES-030): a clamped block under a force is solved, then cut
// with the Section view button; the cut face shows the stress inside, follows the picked result and the deformed
// shape, and goes plain again when the results are out of date.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simsection");
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

const painted = () => pg.waitForFunction(() => window.__sv.sim.state().caps.painted > 0, null, { timeout: 30000 }).then(() => pg.waitForTimeout(400));

// S-1: Section view: the cut through the block is coloured by the stress inside it.
await pg.click('#hud [data-hud="section"]');
await painted();
const s1 = await sim();
check("S-1", !r0.error && s1.caps.n >= 1 && s1.caps.painted >= 1 && s1.caps.hit > 500 && s1.caps.max > 0.3 * r0.maxVm && s1.caps.max < 1.5 * r0.maxVm && s1.caps.min >= 0 && s1.caps.min < 0.2 * r0.maxVm,
  "the section's cut face shows the von Mises stress inside the part, on the scale of the plot", { caps: s1.caps, maxVm: r0.maxVm }, await snap(pg, "section-stress"));

// S-2: another result in the legend: the cut face follows.
await pg.selectOption('#sim-legend [data-k="kind"]', "u");
await pg.waitForFunction(m => { const c = window.__sv.sim.state().caps; return c.painted > 0 && c.max < 1.2 * m && c.max > 0.5 * m; }, r0.maxU, { timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(300);
const s2 = await sim();
check("S-2", s2.plot.kind === "u" && s2.caps.painted >= 1 && s2.caps.max > 0.5 * r0.maxU && s2.caps.max < 1.2 * r0.maxU, "with Displacement picked the cut face shows the displacement", { caps: s2.caps, maxU: r0.maxU }, await snap(pg, "section-displacement"));

// S-3: the deformed shape turned off: the cut is that of the part as modelled, and stays coloured.
await pg.selectOption('#sim-legend [data-k="kind"]', "vm");
await pg.waitForTimeout(600);
await pg.uncheck('#sim-legend [data-k="deformed"]');
await pg.waitForTimeout(1200);
await painted();
const s3 = await sim();
check("S-3", s1.plot.deformed && s1.plot.scale > 0 && !s3.plot.deformed && s3.plot.scale === 0 && s3.caps.painted >= 1 && Math.abs(s3.caps.max / s1.caps.max - 1) < 0.25,
  "the cut face follows the deformed shape, and the undeformed one when that is turned off", { caps: s3.caps, was: s1.caps, scale: [s1.plot.scale, s3.plot.scale] }, await snap(pg, "section-undeformed"));

// S-4: the force left out: the results are out of date, the plot goes and the cut face is plain again.
await pg.click("#t-sim").catch(() => {});
await pg.click('#sim-tree .sim-row[data-id="l1"] [data-a="toggle"]');
await idle(pg);
await pg.waitForTimeout(400);
const s4 = await sim();
const plain = await pg.evaluate(() => { const out = []; window.__sv.viewer.scene.traverse(o => { if (o.userData.sectionCap) out.push(!!o.userData.simCap); }); return out; });
check("S-4", s4.stale && !s4.plot.shown && s4.caps.painted === 0 && plain.length >= 1 && plain.every(x => !x), "out-of-date results leave the cut face plain", { stale: s4.stale, caps: s4.caps, plain }, await snap(pg, "section-plain"));

await finish(browser, pg);
