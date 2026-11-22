// Comparing two thermal maps of one board by hand (FRS-thermal FR-TMAP-030/031): a second package opened from the
// Thermal bar asks Replace or Keep both; compared, the map shows B − A, B flips between the two maps, the parts
// are listed by their change, and Stop comparing goes back.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalcompare");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => window.__sv.thermal.state());

// TC-1: Another map on the Thermal bar, a second package, Keep both and compare.
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#th-tools [data-th="add"]')]);
await fc.setFiles([resolve(fx, "amp-vented-thermal.zip")]);
await pg.waitForSelector("dialog.choose-dlg[open]");
const ask = await snap(pg, "ask");
await pg.click('dialog.choose-dlg [data-choose="compare"]');
await pg.waitForFunction(() => window.__sv.thermal.state()?.compare);
await idle(pg);
await pg.waitForTimeout(600);
const s1 = await st();
const rows = await pg.evaluate(() => [...document.querySelectorAll("#th-side .th-ctable tr[data-cpart]")].map(r => r.innerText.replace(/\s+/g, " ").trim()));
check("TC-1", s1.compare.view === "d" && s1.range[0] === -10 && s1.range[1] === 10 && rows.length === 6 && rows.some(r => /R14 131 139 \+8/.test(r)) && s1.compare.onlyA.join() === "C13",
  "a second package of the board opened from Another map asks Replace or Keep both; compared, the map shows B − A from −10 to +10 K (blue cooler, red hotter) and the parts by their change, C13 in A only", { compare: s1.compare, rows, ask }, await snap(pg, "compare-delta"));

// TC-2: B flips between the two maps on one range; the legend's Show list does the same.
await pg.mouse.move(800, 450);
await pg.keyboard.press("b");
await pg.waitForTimeout(300);
const s2 = await st(), shotB = await snap(pg, "map-b");
await pg.keyboard.press("b");
await pg.waitForTimeout(300);
const s3 = await st();
await pg.selectOption('#th-legend select[data-k="show"]', "d");
await idle(pg);
const s4 = await st();
check("TC-2", s2.compare.view === "b" && s3.compare.view === "a" && JSON.stringify(s2.range) === JSON.stringify(s3.range) && s4.compare.view === "d",
  "B flips from the change to map B, then map A, both on one colour range (30 to 182 °C); Show takes it back to the change", { b: s2.range, a: s3.range, shotB }, await snap(pg, "map-a"));

// TC-3: a row of the compare table frames its part; Stop comparing leaves map A alone.
await pg.click('#th-side .th-ctable tr[data-cpart="2"]');
await pg.waitForTimeout(900);
const s5 = await st(), shotSel = await snap(pg, "compare-r14");
await pg.click('#th-legend [data-a="uncompare"]');
await idle(pg);
const s6 = await st();
check("TC-3", s5.sel === 2 && s6.compare === null && s6.drawn && s6.range[0] === 40 && s6.range[1] === 182 && !pg.errors.length,
  "clicking R14 in the compare table selects and frames it; Stop comparing brings back map A alone on its own range", { sel: s5.sel, range: s6.range, shotSel, errors: pg.errors }, await snap(pg, "compare-off"));
await finish(browser, pg);
