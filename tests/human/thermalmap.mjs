// Board thermal maps by hand (FRS-thermal TH1): a board's STEP opened with its thermal package, the parts list,
// problems, probe, colour scale, the package alone and a broken package.
import { writeFileSync, mkdirSync } from "node:fs";
import { open, snap, idle, clickAt, check, finish, openFiles, OUT } from "./lib.mjs";
const FX = "tests/fixtures/thermal";
const { browser, pg } = await open("thermalmap");
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const at = p => pg.evaluate(p => { const s = window.__sv.thermal.screenOf(p); return [s.x, s.y]; }, p);
const mapped = async () => { await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 60000 }); await idle(pg); await pg.waitForTimeout(900); };
const text = sel => pg.evaluate(sel => document.querySelector(sel)?.innerText ?? "", sel);
/** Board temperature of the fixture (tests/fixtures/thermal/make.ts). */
const PARTS = [[45, 62, 0.6], [45, 30, 1.6], [105.2, 6.3, 0.2], [74, 55, 0], [79, 22.5, 1.9], [95, 35, 0]];
const boardT = (x, y) => 44 + PARTS.reduce((s, [cx, cy, pb]) => s + 30 * pb * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 260), 0);

// TM-1: the STEP and the package opened together: one document with the map on it.
await openFiles(pg, [`${FX}/amp.step`, `${FX}/amp-thermal.zip`]);
await mapped();
const s1 = await st();
const ui1 = await pg.evaluate(() => ({ cm: document.querySelector("#cm-tabs .on")?.dataset.cm, tab: document.querySelector("#tree-panel .tabs .on")?.id, min: document.querySelector('#th-legend [data-v="min"]')?.textContent, max: document.querySelector('#th-legend [data-v="max"]')?.textContent,
  hottest: document.querySelector('#th-summary [data-v="hottest"]')?.textContent, acc: document.querySelector('#th-legend [data-v="accuracy"]')?.textContent, tabs: document.querySelectorAll("#doc-tabs [data-dt]").length, matched: document.querySelector('#th-side [data-v="matched"]')?.textContent,
  wide: document.querySelector("#tab-thermal").scrollWidth - document.querySelector("#tab-thermal").clientWidth }));
check("TM-1", s1.drawn && s1.parts === 6 && s1.matched === 7 && !s1.missing.length && s1.hidden === 7 && ui1.cm === "thermal" && ui1.tab === "t-thermal" && ui1.min === "40" && ui1.max === "182" && /V3 182/.test(ui1.hottest) && /±15/.test(ui1.acc) && ui1.tabs === 1 && /7.*7/.test(ui1.matched) && ui1.wide <= 0,
  "a board's STEP and its thermal package opened together show the temperature map on the model, with the legend 40 to 182 °C, the hottest part and the accuracy", { s1: { ...s1, problems: s1.problems.length }, ui1 }, await snap(pg, "opened"));

// TM-2: the parts list starts with the least margin; a click on a part selects it and frames it; hovering shows its card.
const rows = () => pg.evaluate(() => [...document.querySelectorAll("#th-side tr[data-part]")].map(r => r.querySelector("td").innerText.split(/\s/)[0]));
const r0 = await rows();
await pg.click('#th-side tr[data-part="2"]');
await pg.waitForTimeout(1200);
const s2 = await st();
const p14 = await at([45, 30, 8.5]);
await pg.mouse.move(p14[0] + 3, p14[1] + 2);
await pg.mouse.move(p14[0], p14[1]);
await pg.waitForTimeout(400);
const card = await text("#th-card");
check("TM-2", r0[0] === "R20" && r0[1] === "C13" && r0.at(-1) === "V3" && s2.sel === 2 && /R14/.test(card) && /3\.1 W/.test(card) && /1\.6 W/.test(card) && /1\.5 W/.test(card) && /131/.test(card) && /155/.test(card) && /24/.test(card),
  "the parts are listed by margin, worst first; clicking R14 frames it, and pointing at it shows 3.1 W (board 1.6 W, air 1.5 W), 131 °C, limit 155 °C, margin 24 °C", { rows: r0, sel: s2.sel, card }, await snap(pg, "part-card"));

// TM-3: sorting by temperature, and the filter.
await pg.click('#th-side th[data-sort="t"]');
const byT = await rows();
await pg.click('#th-side th[data-sort="t"]');
const byT2 = await rows();
await pg.fill('#th-side [data-k="filter"]', "c1");
await pg.waitForTimeout(200);
const filtered = await rows();
await pg.fill('#th-side [data-k="filter"]', "");
await pg.click('#th-side th[data-sort="margin"]');
check("TM-3", byT[0] === "V3" && byT2[0] === "C12" && filtered.length === 2 && filtered.every(n => /^C1/.test(n)),
  "a click on the °C heading sorts the parts by temperature, a second click the other way; the filter keeps the parts whose name has the text", { byT, byT2, filtered });

// TM-4: problems follow the checks.
const probs = () => pg.evaluate(() => [...document.querySelectorAll("#th-side .th-list li")].map(li => li.innerText));
const pr0 = await probs(), badge0 = await text("#th-count");
await pg.fill('#th-side [data-k="life"]', "5000");
await pg.press('#th-side [data-k="life"]', "Tab");
await pg.waitForTimeout(200);
const pr1 = await probs();
await pg.fill('#th-side [data-k="board"]', "90");
await pg.press('#th-side [data-k="board"]', "Tab");
await pg.waitForTimeout(200);
const pr2 = await probs(), badge2 = await text("#th-count");
await pg.fill('#th-side [data-k="life"]', "10000");
await pg.press('#th-side [data-k="life"]', "Tab");
await pg.fill('#th-side [data-k="board"]', "105");
await pg.press('#th-side [data-k="board"]', "Tab");
await pg.waitForTimeout(200);
check("TM-4", pr0.length === 2 && /R20/.test(pr0[0]) && /C13/.test(pr0[1]) && badge0 === "2" && pr1.length === 1 && pr2.length === 2 && /101/.test(pr2[1]) && badge2 === "2" && (await probs()).length === 2,
  "the problems are the part over its limit and the short-lived capacitor; a lower life threshold drops the capacitor, a lower board limit adds the board", { pr0, pr1, pr2 }, await snap(pg, "problems"));

// TM-5: a probe reads the map's own temperature at the clicked point.
await pg.click('#th-tools [data-th="flip"]');
await pg.waitForTimeout(900);
await pg.click('#th-tools [data-th="flip"]');
await pg.waitForTimeout(900);
const viewTop = await pg.evaluate(() => { const c = window.__sv.viewer.camera, t = window.__sv.viewer.controls.target; return c.position.z - t.z > 0 && Math.abs(c.position.x - t.x) < 1 && Math.abs(c.position.y - t.y) < 1; });
await pg.click('#th-tools [data-th="probe"]');
const spots = [[20, 20, 1.6], [16, 64, 1.6], [60, 40, 1.6], [112, 72, 1.6], [24, 44, 1.6]];
for (const p of spots) { await clickAt(pg, await at(p)); await pg.waitForTimeout(150); }
const s5 = await st();
const want = spots.map(p => boardT(p[0], p[1]));
const errs = s5.probes.map((p, i) => Math.abs(p.t - want[i]));
const labels = await pg.evaluate(() => document.querySelectorAll("#th-labels [data-probe]").length);
const table = await pg.evaluate(() => [...document.querySelectorAll('#th-side [data-v="probe"]')].map(td => td.textContent));
check("TM-5", viewTop && s5.probes.length === 5 && errs.every(e => e < 0.05) && s5.probes.every(p => p.part === 0) && labels === 5 && table.length === 5,
  "Top and Bottom turn the view to the board's faces; five probe clicks on the board give the map's temperatures at those points", { want: want.map(x => +x.toFixed(2)), got: s5.probes.map(p => +p.t.toFixed(2)), table }, await snap(pg, "probes"));
await pg.click('#th-legend [data-a="noprobes"]');
await pg.keyboard.press("Escape");

// TM-6: colour scale: another palette, a fixed range, the rise above ambient.
await pg.selectOption('#th-legend [data-k="palette"]', "rainbow");
await pg.selectOption('#th-legend [data-k="range"]', "fixed");
await pg.fill('#th-legend [data-k="rmax"]', "120");
await pg.press('#th-legend [data-k="rmax"]', "Tab");
await pg.waitForTimeout(200);
const s6 = await st(), max6 = await text('#th-legend [data-v="max"]');
await pg.check('#th-legend [data-k="rise"]');
await pg.waitForTimeout(200);
const rise = { max: await text('#th-legend [data-v="max"]'), hottest: await text('#th-summary [data-v="hottest"]') };
const shot6 = await snap(pg, "scale");
await pg.uncheck('#th-legend [data-k="rise"]');
await pg.selectOption('#th-legend [data-k="range"]', "auto");
await pg.selectOption('#th-legend [data-k="palette"]', "heat");
check("TM-6", s6.palette === "rainbow" && s6.range[0] === 40 && s6.range[1] === 120 && /▲ 120/.test(max6) && /\+80/.test(rise.max) && /\+142/.test(rise.hottest) && (await st()).range[1] === 182,
  "the legend changes the colours and fixes the range (hotter values are marked ▲); Rise above ambient shows the temperatures as a rise over 40 °C", { range: s6.range, max6, rise }, shot6);

// TM-7: the map goes off and on; off, the model is itself again.
await pg.click('#th-tools [data-th="map"]');
await pg.waitForTimeout(300);
const off = await st(), legendOff = await pg.evaluate(() => document.querySelector("#th-legend").hidden && document.querySelector("#th-summary").hidden);
const shot7 = await snap(pg, "map-off");
await pg.click('#th-tools [data-th="map"]');
await pg.waitForTimeout(300);
const on = await st();
check("TM-7", !off.drawn && off.hidden === 0 && legendOff && on.drawn && on.hidden === 7,
  "the Map button takes the temperatures off the model and puts them back", { off: { drawn: off.drawn, hidden: off.hidden }, on: { drawn: on.drawn, hidden: on.hidden } }, shot7);

// TM-8: Remove map: the model stays, the Thermal tab and page go.
await pg.click('#th-tools [data-th="remove"]');
await pg.waitForTimeout(400);
const gone = await pg.evaluate(() => ({ state: window.__sv.thermal.state(), tab: document.querySelector("#t-thermal").hidden, cm: [...document.querySelectorAll("#cm-tabs [data-cm]")].map(b => b.dataset.cm), parts: window.__sv.viewer.parts.length }));
// File ▸ Add thermal map… puts it back on the open model
await pg.click("#file-btn");
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="thermal-map"]')]);
await fc.setFiles([`${FX}/amp-thermal.zip`]);
await mapped();
const back = await st();
check("TM-8", gone.state === null && gone.tab && !gone.cm.includes("thermal") && gone.parts === 7 && back.drawn && back.matched === 7 && !back.own,
  "Remove map leaves the model without its Thermal tab; File, Add thermal map… attaches the package to the open model again", { gone, back: { drawn: back.drawn, matched: back.matched } }, await snap(pg, "added-again"));

// TM-9: a package that holds its STEP opens both from one file (compressed mesh).
await openFiles(pg, [`${FX}/amp-with-step-thermal.zip`]);
await mapped();
const s9 = await st(), doc9 = await text("#doc");
check("TM-9", s9.drawn && s9.matched === 7 && !s9.own && /amp\.step/.test(doc9) && s9.range[1] === 182 && s9.problems.length === 2,
  "one ZIP with the STEP inside opens the board and its map", { doc9, matched: s9.matched, problems: s9.problems.length }, await snap(pg, "zip-with-step"));

// TM-10: the package alone: its own surfaces are the model.
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="close-all"]');
await pg.waitForTimeout(600);
await openFiles(pg, [`${FX}/amp-thermal.zip`]);
await mapped();
const s10 = await st(), note = await text('#th-side [data-v="own"]');
check("TM-10", s10.drawn && s10.own && s10.matched === 7 && /STEP/.test(note) && s10.tris === 2480,
  "a package opened without a STEP shows its own surfaces, with a note to open the board's STEP for measuring", { own: s10.own, matched: s10.matched, note }, await snap(pg, "package-alone"));

// TM-11: a broken package is refused with a reason and nothing else changes.
mkdirSync(`${OUT}/tmp`, { recursive: true });
writeFileSync(`${OUT}/tmp/bad-thermal.json`, JSON.stringify({ format: "tubecad-thermal", version: 1, files: { mesh: "bad-thermal.vtu" }, parts: [] }));
writeFileSync(`${OUT}/tmp/bad-thermal.vtu`, `<?xml version="1.0"?><VTKFile type="UnstructuredGrid" byte_order="LittleEndian"><UnstructuredGrid><Piece NumberOfPoints="3" NumberOfCells="1"><Points><DataArray type="Float32" format="ascii">0 0 0 1 0`);
await openFiles(pg, [`${OUT}/tmp/bad-thermal.json`, `${OUT}/tmp/bad-thermal.vtu`]);
await pg.waitForTimeout(800);
const toastText = await pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(e => e.textContent).join(" | "));
const s11 = await st();
check("TM-11", /bad/.test(toastText) && /thermal package/i.test(toastText) && s11?.drawn && s11.name === "amp" && !pg.errors.length,
  "a package whose mesh file is cut short is refused with the reason, and the map that was open stays", { toastText, errors: pg.errors }, await snap(pg, "refused"));
await finish(browser, pg);
