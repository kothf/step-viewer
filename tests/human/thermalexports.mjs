// CSV exports of thermal results by hand (FRS-thermal FR-TREP-011): the board map's Parts list saved from the
// Thermal tab, and a solved thermal study's heat balance saved from the Study tab.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { open, snap, idle, check, finish, openFiles, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalexports");
const fx = resolve("tests/fixtures/thermal"), out = process.env.HT_OUT ?? "/mnt/project-files/gap-tests";
const save = async (sel, name) => {
  const dl = pg.waitForEvent("download", { timeout: 30000 });
  await pg.click(sel);
  const d = await dl, path = `${out}/thermalexports-${name}-${d.suggestedFilename()}`;
  await d.saveAs(path);
  return { file: d.suggestedFilename(), rows: readFileSync(path, "utf8").trim().split("\r\n") };
};

// CSV-1: board STEP + package, Thermal tab, Export CSV under the Parts list.
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.click("#t-thermal");
await pg.waitForTimeout(300);
const shown = await pg.evaluate(() => [...document.querySelectorAll("#th-side tbody[data-v=rows] tr")].map(r => r.querySelector("td span")?.textContent ?? ""));
const parts = await save('#th-side [data-a="partscsv"]', "parts");
check("CSV-1", /-parts\.csv$/.test(parts.file) && parts.rows[0].startsWith("Designator,Part,Power (W)") && parts.rows.length === shown.length + 1 && parts.rows.slice(1).every((r, i) => r.startsWith(shown[i] + ",")),
  "Thermal tab ▸ Parts list ▸ Export CSV saves one row per part, in the table's order, with temperature, limit, margin and status", { file: parts.file, head: parts.rows[0], first: parts.rows[1], n: parts.rows.length - 1 }, await snap(pg, "parts-list"));

// CSV-2: sort by temperature, export again: the file follows the table.
await pg.click('#th-side th[data-sort="t"]');
await pg.waitForTimeout(200);
const shown2 = await pg.evaluate(() => [...document.querySelectorAll("#th-side tbody[data-v=rows] tr")].map(r => r.querySelector("td span")?.textContent ?? ""));
const parts2 = await save('#th-side [data-a="partscsv"]', "sorted");
check("CSV-2", parts2.rows.slice(1).every((r, i) => r.startsWith(shown2[i] + ",")),
  "after sorting by temperature the saved list is in the same order as the table", { order: shown2 }, await snap(pg, "parts-sorted"));

// CSV-3: a thermal study of a block: 5 W in it, still air on every surface, then Export heat balance CSV.
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForTimeout(200);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "5");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="conv"]');
await pg.waitForTimeout(200);
await pg.check('#sim-pm [data-k="all"]');
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(500);
const sim = await pg.evaluate(() => window.__sv.sim.state());
const bal = await save('#sim-tree [data-a="balcsv"]', "balance");
const cell = (k, j) => bal.rows.find(r => r.startsWith(k))?.split(",")[j];
const put = Number(cell("Heat put in,Total", 2)), taken = Number(bal.rows.filter(r => r.startsWith("Heat taken away,Total"))[0]?.split(",")[2]);
check("CSV-3", !sim.error && /-heat-balance\.csv$/.test(bal.file) && Math.abs(put - 5) < 1e-6 && Math.abs(taken - 5) < 0.1 && bal.rows.some(r => r.startsWith("Out of balance (%),")),
  "Study tab ▸ Export heat balance CSV: 5 W put in, the convection takes about 5 W away, and the balance is listed", { file: bal.file, rows: bal.rows }, await snap(pg, "heat-balance"));
await finish(browser, pg);
