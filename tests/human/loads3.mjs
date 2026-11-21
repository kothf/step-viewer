// Loads on round faces and from a fluid, by hand (FRS-structural FR-LOAD-005, FR-LOAD-006, FR-LOAD-008, FR-LOAD-009): a plate
// with a hole gets a torque and a bearing load on the hole, a hydrostatic pressure on its top face and a remote load.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("loads3");
await makeBlock(pg, 100, 60, 20);
// a hole of radius 10 through the middle: pick the top face, Cut, a circle, 20 deep
await clickAt(pg, await screenOf(pg, [30, 15, 20]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(1500);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await clickAt(pg, await screenOf(pg, [10, 0, 20]));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.click("#mc-ok");
await pg.waitForTimeout(1500);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
if (dp) { await dp.fill("20"); await dp.press("Enter"); }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const vol = await pg.evaluate(() => window.__sv.modeller.last?.props?.volume ?? 0);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 }); await pg.waitForTimeout(400); };
const draftFaces = () => pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
const toasts = () => pg.evaluate(() => [...document.querySelectorAll(".toast")].map(e => e.textContent).join("|"));
// the hole's wall, seen through its opening: the first point of the wall that a click takes
const pickHole = async () => {
  for (let k = 0; k < 12; k++) {
    const a = (Math.PI * 2 * k) / 12;
    await clickAt(pg, await screenOf(pg, [10 * Math.cos(a), 10 * Math.sin(a), 16]));
    await pg.waitForTimeout(200);
    if (!/Click/.test(await draftFaces())) return true;
  }
  return false;
};

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
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
const fits = await pg.evaluate(() => { const e = document.querySelector("#cm-body") ?? document.querySelector("#sim-tools"); return e.scrollWidth - e.clientWidth; });

// L3-1: Torque. A flat face is refused with a hint; the hole's wall is taken. 20 N·m about the hole's axis.
await pg.click('#sim-tools [data-s="torque"]');
await pg.waitForTimeout(250);
await clickAt(pg, await screenOf(pg, [30, 15, 20]));
await pg.waitForTimeout(250);
const refused = /Click/.test(await draftFaces()) && /cylindrical/.test(await toasts());
const took = await pickHole();
await pg.fill('#sim-pm [data-n="value"]', "20");
await pg.keyboard.press("Tab");
const img1 = await snap(pg, "torque-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r1 = await sim();
check("L3-1", vol > 113000 && vol < 114000 && refused && took && !r1.error && Math.abs(r1.applied.moment[2] / 20000 - 1) < 0.01 && Math.hypot(...r1.applied.force) < 1 && r1.plot.shown,
  "Torque refuses a flat face, takes the hole's wall and turns it with 20 N·m about the hole's axis, with no net force", { vol, refused, took, error: r1.error, applied: r1.applied, fits }, img1);
const img1b = await snap(pg, "torque-result");

// L3-2: the torque left out, a Bearing load of 500 N along −Y (with 100 N along the axis, which is left out).
await pg.locator('#sim-tree .sim-row [data-a="toggle"]').last().click();
await idle(pg);
await pg.click('#sim-tools [data-s="bearing"]');
await pg.waitForTimeout(250);
const took2 = await pickHole();
await pg.fill('#sim-pm [data-n="c0"]', "0"); await pg.keyboard.press("Tab");
await pg.fill('#sim-pm [data-n="c1"]', "-0.5 kN"); await pg.keyboard.press("Tab");
await pg.fill('#sim-pm [data-n="c2"]', "100"); await pg.keyboard.press("Tab");
const img2 = await snap(pg, "bearing-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r2 = await sim();
check("L3-2", took2 && !r2.error && Math.abs(r2.applied.force[1] / -500 - 1) < 0.01 && Math.abs(r2.applied.force[0]) < 1 && Math.abs(r2.applied.force[2]) < 1,
  "the bearing load presses 500 N onto the half of the hole that faces it; the part along the axis is left out", { took2, error: r2.error, applied: r2.applied?.force, img1b }, await snap(pg, "bearing-result"));

// L3-3: the bearing load left out, water standing 1 m above the top face: ρ g h × (6000 − π 10²) mm² = 55.8 N down.
await pg.locator('#sim-tree .sim-row [data-a="toggle"]').last().click();
await idle(pg);
await pg.click('#sim-tools [data-s="hydro"]');
await pg.waitForTimeout(250);
await clickAt(pg, await screenOf(pg, [30, 15, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="level"]', "1020");
await pg.keyboard.press("Tab");
const img3 = await snap(pg, "hydro-panel");
const wide = await pg.evaluate(() => document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r3 = await sim();
const row = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-row")].at(-1)?.textContent ?? "");
check("L3-3", !r3.error && wide <= 0 && Math.abs(r3.applied.force[2] / -55.76 - 1) < 0.01 && Math.hypot(r3.applied.force[0], r3.applied.force[1]) < 0.05,
  "water 1 m above the top face presses it down with ρ g h A", { error: r3.error, wide, row, applied: r3.applied?.force }, img3);

// L3-4: the water left out, a Remote load on the top face: the point is picked on a corner of the plate, then lifted
// to z = 100 by typing; 100 N along X there. About the origin its moment is (50, −30, 100) × (100, 0, 0) = (0, 10000, 3000) N·mm.
await pg.locator('#sim-tree .sim-row [data-a="toggle"]').last().click();
await idle(pg);
await pg.click('#sim-tools [data-s="remote"]');
await pg.waitForTimeout(250);
await clickAt(pg, await screenOf(pg, [30, 15, 20]));
await pg.waitForTimeout(250);
await pg.click('#sim-pm [data-k="pickat"]');
await pg.waitForTimeout(150);
await clickAt(pg, await screenOf(pg, [50, -30, 20]));
await pg.waitForTimeout(250);
const picked = await pg.evaluate(() => ["a0", "a1", "a2"].map(k => Number(document.querySelector(`#sim-pm [data-q="${k}"]`)?.value)));
await pg.fill('#sim-pm [data-q="a2"]', "100"); await pg.keyboard.press("Tab");
await pg.fill('#sim-pm [data-n="c0"]', "100"); await pg.keyboard.press("Tab");
await pg.fill('#sim-pm [data-n="c2"]', "0"); await pg.keyboard.press("Tab");
const img4 = await snap(pg, "remote-panel");
const wide4 = await pg.evaluate(() => document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r4 = await sim();
check("L3-4", JSON.stringify(picked) === JSON.stringify([50, -30, 20]) && wide4 <= 0 && !r4.error && Math.abs(r4.applied.force[0] / 100 - 1) < 1e-6
  && Math.abs(r4.applied.moment[1] / 10000 - 1) < 1e-3 && Math.abs(r4.applied.moment[2] / 3000 - 1) < 1e-3 && Math.abs(r4.applied.moment[0]) < 1,
  "a remote load: the point is picked on a corner and lifted by typing; the face carries the force at that point with its moment", { picked, wide4, error: r4.error, applied: r4.applied }, img4);

await finish(browser, pg);
