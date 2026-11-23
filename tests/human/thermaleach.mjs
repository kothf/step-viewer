// Heat power per face by hand (FRS-thermal FR-TLOAD-001): a 100 × 20 × 20 mm block with 2 W on each of two faces
// makes 4 W in all; the top face is cooled by convection.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermaleach");
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

// HE-1: Heat power on two faces; Power of each face is offered and changes the help line; the row says "2 W each"
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await clickAt(pg, await screenOf(pg, [0, -10, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "2");
await pg.press('#sim-pm [data-n="value"]', "Tab");
const help0 = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm .pm-help")].map(e => e.textContent).join(" "));
await pg.check('#sim-pm [data-k="each"]');
await pg.waitForTimeout(200);
const help1 = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm .pm-help")].map(e => e.textContent).join(" "));
const shot1 = await snap(pg, "panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const r1 = await pg.evaluate(() => { const l = window.__sv.model.store.doc.studies.at(-1).loads[0]; return { each: l?.each, faces: l?.faces.map(f => f.name), row: document.querySelector(`#sim-tree .sim-row[data-id="${l?.id}"]`)?.textContent ?? "" }; });
check("HE-1", /spread evenly over the picked faces/.test(help0) && /Each picked face takes this power/.test(help1) && r1.each === true && r1.faces?.length === 2 && /2 faces · 2 W each/.test(r1.row),
  "Heat power on two faces with Power of each face: each face takes 2 W, the row says 2 W each", { help0, help1, ...r1 }, shot1);

await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// HE-2: Solve: 4 W go in and leave through the cooled top face
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(500);
const r2 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, applied: s.thermal?.applied, heat: document.querySelector('#sim-tree [data-v="heatin"]')?.textContent ?? "", out: s.thermal?.out }; });
check("HE-2", !r2.error && Math.abs((r2.applied ?? 0) - 4) < 1e-6 && /4 W/.test(r2.heat) && Math.abs((r2.out?.[0] ?? 0) - 4) < 0.05,
  "Solve: 2 W on each of the two faces = 4 W in, 4 W out through the top", r2, await snap(pg, "solved"));

// HE-3: unticked, the 2 W is the total over both faces
await pg.click('#sim-tree .sim-heat button.sim-name[data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.uncheck('#sim-pm [data-k="each"]');
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error) && !s.stale; }, null, { timeout: 600000 });
await pg.waitForTimeout(500);
const r3 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, applied: s.thermal?.applied, row: document.querySelector("#sim-tree .sim-heat .sim-meta")?.textContent ?? "" }; });
check("HE-3", !r3.error && Math.abs((r3.applied ?? 0) - 2) < 1e-6 && !/each/.test(r3.row), "Unticked, 2 W is the total over both faces", r3, await snap(pg, "total"));
await finish(browser, pg);
