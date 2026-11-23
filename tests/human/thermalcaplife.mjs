// Part limits and capacitor life by hand (FRS-thermal FR-TBRD-022): in a board study the Heat from package load's parts
// table takes each part's temperature limit and an electrolytic's rated life; the results stay fresh, Part temperatures
// marks the parts over their limit and gives each electrolytic's life by the 10 °C rule, and the report has it.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalcaplife");
const fx = resolve("tests/fixtures/thermal");

const temps = () => pg.evaluate(() => ({ stale: window.__sv.sim.state().stale, parts: window.__sv.sim.state().thermal?.parts ?? [],
  rows: [...document.querySelectorAll("#sim-tree .sim-ptemps tr[data-ptemp]")].map(r => [r.dataset.ptemp, r.className, r.querySelector('[data-v="ptlife"]')?.textContent ?? null]),
  note: document.querySelector('#sim-tree [data-v="lifenote"]')?.textContent ?? null }));
const rowOf = name => pg.evaluate(n => [...document.querySelectorAll("#sim-pm .sim-pkparts tr[data-pk]")].find(r => r.children[1].textContent === n)?.dataset.pk, name);
const type = async (sel, v) => { await pg.click(sel, { clickCount: 3 }); await pg.keyboard.type(v); await pg.keyboard.press("Tab"); };

// CAP-1: board STEP + package, Simulate, solve: Part temperatures has limits from the package, no life column yet.
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
await pg.selectOption('#sim-tree select[data-k="passes"]', "1");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 400000 });
await pg.waitForTimeout(500);
const a = await temps();
await pg.evaluate(() => document.querySelector("#sim-tree .sim-ptemps")?.scrollIntoView());
const badA = a.rows.filter(r => /bad/.test(r[1])).map(r => r[0]);
check("CAP-1", !a.stale && a.rows.length === 6 && a.rows.every(r => r[2] === null) && badA.includes("R20"), "Part temperatures marks the parts over the package's limits; no life is known yet", { rows: a.rows }, await snap(pg, "limits-from-package"));

// CAP-2: edit the load: rated life 500 h for C13 and 5000 h for C12, R20's limit raised to 400 °C; OK.
await pg.click('#sim-tree .sim-row[data-id="l1"] [data-a="edit"]');
await pg.waitForSelector('#sim-pm .sim-pkparts input[data-q="pklife"]');
const c13 = await rowOf("C13"), c12 = await rowOf("C12"), r20 = await rowOf("R20");
await type(`#sim-pm .sim-pkparts tr[data-pk="${c13}"] input[data-q="pklife"]`, "500");
await type(`#sim-pm .sim-pkparts tr[data-pk="${c12}"] input[data-q="pklife"]`, "5000");
await type(`#sim-pm .sim-pkparts tr[data-pk="${r20}"] input[data-q="pklim"]`, "400");
const wide = await pg.evaluate(() => document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth);
const panel = await snap(pg, "parts-table-typed");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
const b = await temps(), p13 = b.parts.find(x => x.name === "C13"), p12 = b.parts.find(x => x.name === "C12");
await pg.evaluate(() => document.querySelector("#sim-tree .sim-ptemps")?.scrollIntoView());
const life = (r, p) => Math.abs(p.life - r * 2 ** ((p.limit - p.t) / 10)) < 1e-6 * r * 100;
check("CAP-2", wide <= 0 && !b.stale && p13 && p12 && life(500, p13) && p13.life < 10000 && b.note !== null && life(5000, p12) && !b.rows.find(r => r[0] === "R20")[1].includes("bad")
  && b.rows.filter(r => r[2]).length === 2 && (p13.life < 10000) === /warn/.test(b.rows.find(r => r[0] === "C13")[1]) && (b.note !== null) === b.parts.some(x => !x.over && x.life < 10000),
  "the limits and lives typed in the parts table change the verdicts at once, without solving again: R20 is no longer over and C12/C13 get their life by the 10 °C rule, a short one marked",
  { rows: b.rows, note: b.note, c13: p13, c12: p12, panel, wide }, await snap(pg, "life-shown"));

// CAP-3: the HTML report's Part temperatures table has the Life column.
await pg.click('#sim-tools [data-s="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
const path = `${process.env.HT_OUT ?? "/mnt/project-files/gap-tests"}/thermalcaplife-report.html`;
await dl.saveAs(path);
const html = readFileSync(path, "utf8");
check("CAP-3", /Part temperatures/.test(html) && /Life, h/.test(html), "the report's Part temperatures table lists each electrolytic's life", { life: /Life, h/.test(html) }, await snap(pg, "report"));
await finish(browser, pg);
