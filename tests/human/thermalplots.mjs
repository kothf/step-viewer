// Thermal plots by hand (FRS-thermal FR-TRES-001): a block heated throughout and cooled through its top face, shown
// as temperature rise above ambient and with heat flow arrows that point towards the cooled face.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalplots");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
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
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(500);

// PLT-1: Temperature rise in the result list: the colour scale is the temperature less the 25 °C ambient, in K
await pg.selectOption('#sim-legend [data-k="kind"]', "rise");
await pg.waitForTimeout(400);
const r1 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, kind: s.plot.kind, range: s.plot.range, min: s.thermal?.min, max: s.thermal?.max,
  scale: document.querySelector("#sim-legend .ana-scale")?.textContent ?? "", labels: [...document.querySelectorAll("#sim-probes .sim-peak")].map(e => e.textContent) }; });
check("PLT-1", !r1.error && r1.kind === "rise" && Math.abs(r1.range[0] - (r1.min - 25)) < 1e-3 && Math.abs(r1.range[1] - (r1.max - 25)) < 1e-3 && /K/.test(r1.scale) && r1.labels.length >= 1,
  "Temperature rise shows how much hotter than the 25 °C ambient each place is: 15 K at the held face, more inside", r1, await snap(pg, "rise"));

// PLT-2: Heat flow arrows on the heat flux plot: the heat runs up to the cooled top face
await pg.selectOption('#sim-legend [data-k="kind"]', "flux");
await pg.waitForTimeout(300);
await pg.check('#sim-legend [data-k="vectors"]');
await pg.waitForTimeout(400);
const r2 = await pg.evaluate(() => {
  let n = 0, up = 0, down = 0;
  window.__sv.viewer.scene.traverse(o => {
    if (!o.userData.simArrows) return;
    const a = o.geometry.getAttribute("position").array;
    for (let j = 0; j < a.length; j += 18) { n++; const dz = a[j + 5] - a[j + 2]; if (dz > 0) up++; else if (dz < 0) down++; }
  });
  return { n, up, down, st: window.__sv.sim.state().plot.arrows };
});
check("PLT-2", r2.n > 50 && r2.n === r2.st && r2.up > 0.8 * r2.n,
  "Heat flow arrows spread over the block; almost all point up towards the face held at 40 °C, where the heat leaves", r2, await snap(pg, "arrows"));
await pg.uncheck('#sim-legend [data-k="vectors"]');
await pg.waitForTimeout(300);
const r3 = await pg.evaluate(() => window.__sv.sim.state().plot.arrows);
check("PLT-3", r3 === 0, "unticking Heat flow arrows takes them off", { arrows: r3 }, await snap(pg, "no-arrows"));
await finish(browser, pg);
