// Volume heat by hand (FRS-thermal FR-TLOAD-003): a 100 × 20 × 20 mm block makes 0.1 W/cm³ throughout
// (40 cm³ → 4 W) and is cooled through its top face held at 40 °C.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalvheat");
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

// VHS-1: Volume heat asks for W/m³ and no faces; 0.1 W/cm³ is stored as 100 000 W/m³ for the whole body
await pg.click('#sim-tools [data-s="vheat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
const panel = await pg.evaluate(() => ({ head: document.querySelector("#sim-pm")?.textContent ?? "", faces: !!document.querySelector("#sim-pm .sim-faces"), unit: document.querySelector('#sim-pm [data-n="value"]')?.closest(".pm-in")?.textContent ?? "" }));
await pg.fill('#sim-pm [data-n="value"]', "0.1 W/cm³");
await pg.press('#sim-pm [data-n="value"]', "Tab");
const shot1 = await snap(pg, "panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const r1 = await pg.evaluate(() => { const l = window.__sv.model.store.doc.studies.at(-1).loads[0]; return { type: l?.type, v: l?.value?.v, row: document.querySelector(`#sim-tree .sim-row[data-id="${l?.id}"]`)?.textContent ?? "" }; });
check("VHS-1", /Volume heat/.test(panel.head) && !panel.faces && /W\/m³/.test(panel.unit) && r1.type === "vheat" && r1.v === 1e5 && /whole body/.test(r1.row),
  "Loads ▸ Volume heat takes W/m³ for the whole part, no faces to pick; 0.1 W/cm³ is 100 000 W/m³", { panel, ...r1 }, shot1);

await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// VHS-2: Solve: 4 W go in (40 cm³ × 0.1 W/cm³) and leave through the held face; the bottom is the hottest
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(500);
const r2 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, max: s.thermal?.max, min: s.thermal?.min, heat: document.querySelector('#sim-tree [data-v="heatin"]')?.textContent ?? "", out: s.thermal?.out }; });
// a 20 mm slab heated throughout, held on one side: the far side rises q t² / (2 k), k of S235JR 54 W/(m·K)
check("VHS-2", !r2.error && /4 W/.test(r2.heat) && Math.abs((r2.out?.[0] ?? 0) - 4) < 0.05 && r2.max > 40.3 && r2.max < 40.45 && Math.abs(r2.min - 40) < 0.02,
  "Solve: 4 W in, 4 W out through the held face; the bottom rises about q t² / 2k = 0.37 K", r2, await snap(pg, "solved"));
await finish(browser, pg);
