// A full thermal run on the board STEP that MöbiusCAD itself writes from a Gerber set (PCB view → STEP), with the
// board's thermal package: the board found by its outline, the parts the bare board lacks standing in as their package
// boxes, then steady state, copper from the Gerbers, a heatsink and a junction, a warm-up and the report.
import { open, snap, idle, screenOf, clickAt, check, finish, openFiles, OUT } from "./lib.mjs";
import { readFileSync, mkdirSync } from "node:fs";
const FX = "tests/fixtures/thermal", G = `${FX}/amp-gerber`, GERBERS = ["amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-F_Cu.gbr", "amp-PTH.drl"].map(f => `${G}/${f}`);
const out = `${OUT}/thermalexport`;
mkdirSync(out, { recursive: true });
const { browser, pg } = await open("thermalexport");
const toasts = () => pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(e => e.textContent).join(" | "));
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 900000 }); await pg.waitForTimeout(600); };
const solve = async () => { await pg.click('#sim-tools [data-s="solve"]'); await pg.waitForFunction(() => window.__sv.sim.state().running, null, { timeout: 20000 }).catch(() => {}); await solved(); };
const temps = () => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll("#sim-tree .sim-ptemps tr[data-ptemp]")].map(r => [r.dataset.ptemp, Number(r.querySelector('[data-v="pttemp"]').textContent.replace(/[^\d.-]/g, ""))])));
const outSum = s => (s.thermal?.out ?? []).reduce((a, x) => a + x, 0);

// TE-1: the Gerber set in the PCB view, then its board STEP from the panel's STEP button.
await openFiles(pg, GERBERS);
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("gerber"), null, { timeout: 30000 });
await idle(pg);
const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 120000 }), pg.click("#g-step")]);
const step = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(step);
const text = readFileSync(step, "latin1");
check("TE-1", dl.suggestedFilename() === "amp-board.step" && /MANIFOLD_SOLID_BREP/.test(text) && (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length === 1,
  "the PCB view writes the board of the Gerber set as one solid in amp-board.step, named after the set rather than its first layer", { name: dl.suggestedFilename(), bytes: text.length }, await snap(pg, "pcb"));

// TE-2: the STEP with the thermal package: only the board is in it, found by its outline, and the map goes onto it.
await openFiles(pg, [step, `${FX}/amp-thermal.zip`]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 60000 });
await idle(pg);
const s2 = await pg.evaluate(() => window.__sv.thermal.state());
const warn2 = await pg.evaluate(() => !!document.querySelector('#th-side [data-v="misfit"], #th-legend [data-v="misfit"]'));
check("TE-2", s2.matched === 1 && s2.missing.join() === "1,2,3,4,5,6" && s2.fitted && !warn2,
  "the bare board STEP has only the board: it is found by its outline (the exported board is centred on z = 0, the package's starts at 0), the map is put onto it without a misfit warning, and the 6 parts are listed as missing", { matched: s2.matched, missing: s2.missing, fitted: s2.fitted, off: s2.off, warn2 }, await snap(pg, "map-on-bare-board"));

// TE-3: Simulate: the board plus a stand-in block or cylinder per part, every part's heat in the study.
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden, null, { timeout: 300000 });
await idle(pg);
await pg.waitForTimeout(800);
const s3 = await pg.evaluate(() => { const d = window.__sv.asm.doc, st = d.studies?.[0], l = st?.loads[0]; return { comps: d.components.map(c => c.name), heat: l?.parts?.map(p => [p.name, p.p, p.comps.length]), split: l?.split, board: !!l?.board }; });
const t3 = await toasts();
check("TE-3", s3.comps.length === 7 && s3.heat?.length === 6 && s3.heat.every(h => h[2] === 1) && s3.split && s3.board && /stand in as blocks/.test(t3) && !/not found/.test(t3),
  "Simulate makes the board and six stand-ins from the package boxes (the valve and capacitors as cylinders); every part's heat has a body, and the package's board shares go into the board under them", { ...s3, t3 }, await snap(pg, "stand-ins"));

// TE-4: steady state: the 29.17 W leave by convection and radiation; each part's temperature beside its limit.
await solve();
const s4 = await sim(), T4 = await temps();
check("TE-4", !s4.error && Math.abs(s4.thermal.applied - 29.17) < 1e-6 && Math.abs(outSum(s4) - 29.17) < 0.05 && Object.keys(T4).length === 6 && T4.V3 > T4.C12 && T4.R20 > 155,
  "the board solves with all six parts making heat; the heat balance closes and R20 runs over its 155 °C limit", { error: s4.error, applied: s4.thermal?.applied, out: s4.thermal?.out, T4 }, await snap(pg, "steady"));

// TE-5: the board's copper from the same Gerber set.
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#sim-tree [data-a="bgerber"]')]);
await fc.setFiles(GERBERS);
await pg.waitForFunction(() => (document.querySelector('#sim-tree img[data-v="bmap"]')?.naturalWidth ?? 0) > 0, null, { timeout: 60000 });
await idle(pg);
await solve();
const s5 = await sim(), T5 = await temps();
const moved5 = Object.keys(T5).some(k => Math.abs(T5[k] - T4[k]) > 0.5);
check("TE-5", !s5.error && moved5 && Math.abs(outSum(s5) - 29.17) < 0.05, "the copper map read from the same Gerbers replaces the board's even coverage and the part temperatures follow it",
  { before: T4, after: T5 }, await snap(pg, "copper"));

// TE-6: the transistor's heatsink (the package says Q2 sits on one; the board STEP has none) as 3 K/W on its top face, and its Rjc.
const q2 = await pg.evaluate(() => { const v = window.__sv.viewer, i = window.__sv.asm.doc.components.findIndex(c => c.name.startsWith("Q2")), p = v.parts[i]; return [p.data.bboxMin, p.data.bboxMax]; });
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [(q2[0][0] + q2[1][0]) / 2, (q2[0][1] + q2[1][1]) / 2, q2[1][2]]));
await pg.waitForTimeout(300);
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.selectOption('#sim-pm select[data-k="film"]', "rth");
await pg.waitForSelector('#sim-pm input[data-q="rth"]');
await pg.fill('#sim-pm input[data-q="rth"]', "3");
await pg.press('#sim-pm input[data-q="rth"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tree .sim-row[data-id="l1"] [data-a="edit"]');
await pg.waitForSelector('#sim-pm .sim-pkparts tr[data-pk="3"] input[data-q="pkrjc"]');
await pg.fill('#sim-pm .sim-pkparts tr[data-pk="3"] input[data-q="pkrjc"]', "2.5");
await pg.press('#sim-pm .sim-pkparts tr[data-pk="3"] input[data-q="pkrjc"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await solve();
const s6 = await sim(), T6 = await temps();
const q2row = await pg.evaluate(() => { const r = document.querySelector('#sim-tree .sim-ptemps tr[data-ptemp="Q2"]'); return r ? r.querySelector('[data-v="ptkind"]').textContent : ""; });
check("TE-6", picked === "1 face" && !s6.error && T6.Q2 < T5.Q2 - 20 && /junction/i.test(q2row) && Math.abs(outSum(s6) - 29.17) < 0.05,
  "a 3 K/W heatsink on the stand-in transistor's top face takes most of its heat; with Rjc 2.5 K/W its row gives the junction temperature", { picked, q2: [T5.Q2, T6.Q2], q2row }, await snap(pg, "heatsink-junction"));

// TE-7: the warm-up over 30 minutes from ambient.
await pg.click('#sim-tools [data-s="transient"]');
await pg.waitForSelector('#sim-tree [data-k="tend"]');
await pg.fill('#sim-tree [data-k="tend"]', "1800");
await pg.press('#sim-tree [data-k="tend"]', "Tab");
await idle(pg);
await solve();
const s7 = await sim(), T7 = s7.transient;
const end7 = T7?.max?.at(-1), chart = await pg.evaluate(() => !!document.querySelector("#sim-tree svg.sim-tchart")), T7p = await temps();
check("TE-7", !s7.error && T7 && T7.times.at(-1) === 1800 && end7 > T7.max[1] && end7 <= (T7.steady ?? s6.thermal.max) + 0.5 && chart && Object.keys(T7p).length === 6 && T7p.V3 > T7p.C12,
  "the board warms up over 30 minutes from ambient: the hottest temperature rises with time and stays at or below the steady one; the warm-up chart is drawn and every part's temperature at the shown time is listed", { end: end7, steady: T7?.steady, first: T7?.max?.slice(0, 3), T7p }, await snap(pg, "warm-up"));
// at 3 minutes the parts are cooler than at the end
await pg.$eval('#sim-legend input[data-k="time"]', e => { e.value = "1"; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); });
await idle(pg);
await pg.waitForTimeout(400);
const T7a = await temps();
check("TE-7b", Object.keys(T7a).length === 6 && T7a.V3 < T7p.V3 - 5 && T7a.R20 < T7p.R20, "the time slider at the first output time shows every part cooler than at the end", { early: T7a, end: T7p }, await snap(pg, "warm-up-early"));
await pg.$eval('#sim-legend input[data-k="time"]', e => { e.value = e.max; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); });
await idle(pg);

// TE-8: the report.
const dis = await pg.evaluate(() => { const b = document.querySelector('#sim-tools [data-s="report"]'); const s = window.__sv.sim.state(); return b.disabled ? JSON.stringify({ error: s.error, stale: s.stale, done: s.done, running: s.running }) : ""; });
if (dis) console.log("report disabled", dis);
await pg.click('#sim-tools [data-s="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [rd] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
const rpath = `${out}/report.html`;
await rd.saveAs(rpath);
const html = readFileSync(rpath, "utf8");
check("TE-8", /<img/.test(html) && ["V3", "R14", "Q2", "C12", "R20", "C13"].every(n => html.includes(n)) && /junction/i.test(html), "the HTML report holds the picture and every part's temperature, Q2's as a junction",
  { bytes: html.length }, await snap(pg, "report"));

await finish(browser, pg);
