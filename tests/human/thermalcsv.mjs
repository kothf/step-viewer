// Heat sources from a CSV alone by hand (FRS-thermal FR-TPKG-015): a table of powers, no temperature map, added to
// a board's STEP and simulated.
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const FX = "tests/fixtures/thermal";
const { browser, pg } = await open("thermalcsv");
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const toasts = () => pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(e => e.textContent).join(" | "));

// TC-1: the CSV alone with nothing open: it asks for the board's STEP first.
await openFiles(pg, [`${FX}/amp-powers.csv`]);
const t1 = await toasts();
check("TC-1", /STEP first/.test(t1) && !(await st()), "a heat-source CSV opened with nothing on screen asks for the board's STEP first", { t1 }, await snap(pg, "alone"));

// TC-2: the STEP first, then File ▸ Add thermal map… with the CSV: the parts and their powers, no map.
await openFiles(pg, [`${FX}/amp.step`]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length === 7, null, { timeout: 60000 });
await idle(pg);
await pg.click("#file-btn");
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="thermal-map"]')]);
await fc.setFiles([`${FX}/amp-powers.csv`]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.sourcesOnly, null, { timeout: 30000 });
await idle(pg);
await pg.waitForTimeout(500);
const s2 = await st();
const ui2 = await pg.evaluate(() => ({ cm: document.querySelector("#cm-tabs .on")?.dataset.cm, bar: [...document.querySelectorAll("#th-tools [data-th]")].map(b => b.querySelector(".mc-l").textContent),
  rows: [...document.querySelectorAll("#th-side tbody tr")].map(r => r.innerText.replace(/\s+/g, " ").trim()), legend: !document.querySelector("#th-legend")?.hidden && document.querySelector("#th-legend")?.innerHTML.length > 0, summary: !document.querySelector("#th-summary").hidden }));
check("TC-2", s2.sourcesOnly && !s2.drawn && s2.parts === 7 && s2.missing.length === 1 && ui2.cm === "thermal" && ui2.rows.length === 7 && /^V3 18\.2 250$/.test(ui2.rows[0]) && !ui2.summary && ui2.bar.includes("Simulate") && !ui2.bar.includes("Map"),
  "File ▸ Add thermal map… with a CSV of powers on the open board lists the 7 parts with power and limit (X9 not in the model), draws no colours and offers Simulate", { s2: { ...s2, problems: s2.problems.length }, ui2 }, await snap(pg, "sources"));

// TC-3: a click on a row frames that part; sorting by power; the filter.
await pg.click('#th-side tr[data-part="3"]');
await pg.waitForTimeout(900);
const s3 = await st();
await pg.click('#th-side th[data-sort="p"]');
const byP = await pg.evaluate(() => [...document.querySelectorAll("#th-side tbody tr td:first-child")].map(td => td.innerText.split(/\s/)[0]));
await pg.fill('#th-side [data-k="filter"]', "c1");
await pg.waitForTimeout(200);
const filt = await pg.evaluate(() => document.querySelectorAll("#th-side tbody tr").length);
await pg.fill('#th-side [data-k="filter"]', "");
check("TC-3", s3.sel === 3 && byP[0] === "V3" && byP.at(-1) === "C13" && filt === 2, "clicking R20 selects and frames it; the W heading sorts by power, largest first; the filter keeps C12 and C13", { sel: s3.sel, byP, filt }, await snap(pg, "framed"));

// TC-4: Simulate makes the board assembly and a thermal study with the table's powers.
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden, null, { timeout: 180000 });
await idle(pg);
await pg.waitForTimeout(800);
const s4 = await pg.evaluate(() => { const st = window.__sv.asm.doc.studies?.[0]; return { kind: st?.kind, heat: st?.loads[0]?.parts?.map(p => [p.name, p.p, p.comps.length]), row: [...document.querySelectorAll("#sim-tree .sim-row")].map(r => r.innerText.replace(/\s+/g, " ").trim()).find(r => /Heat from package/.test(r)), t: [...document.querySelectorAll("#toasts .toast")].map(e => e.textContent).join(" | ") }; });
check("TC-4", s4.kind === "thermal" && s4.heat?.length === 7 && s4.heat[0][1] === 18.2 && /7 parts|6 parts/.test(s4.row ?? "") && /not found/.test(s4.t),
  "Simulate makes an assembly of the board and a thermal study whose heat is the table's powers; the part not in the model is named in the message", s4, await snap(pg, "study"));
await finish(browser, pg);
