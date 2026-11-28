// Setting up a study and keeping its results with the model, by hand (test list
// /mnt/project-files/tests/analysis-tests.md): starting, picking faces, values, undo, then save, open again in a
// fresh browser (no disk cache) and see the studies and results come back.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, saveModel, openFiles, OUT } from "./lib.mjs";
const dir = `${OUT}/simsetup-files`;
let { browser, pg } = await open("simsetup", "&nocache");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const tree = () => pg.evaluate(() => document.querySelector("#sim-tree")?.innerText ?? "");
const rows = () => pg.$$eval("#sim-tree .sim-row .sim-name", els => els.map(e => e.textContent.trim()));
const facesText = () => pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? null);
const END = [50, 0, 10], TOP = [0, 0, 20];

// A1/A3: the Simulation tab; the first support with no study makes one.
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
const a1 = await pg.evaluate(() => ({ cmds: [...document.querySelectorAll("#sim-tools .mc-b")].map(e => e.dataset.s), tab: document.querySelector("#tab-sim")?.classList.contains("on") }));
check("A1", a1.tab && a1.cmds.includes("new") && a1.cmds.includes("newmodal"), "the Simulation tab offers new static and modal studies and shows the Study tab", a1, await snap(pg, "tab"));

// A2/A4: no material yet: what does the study say before anything is set?
await pg.click('#sim-tree button:has-text("New study")');
await idle(pg);
const t0 = await tree();
check("A4", /material/i.test(t0) && /support/i.test(t0) && /load/i.test(t0), "an empty study says what is missing (material, support, load)", { tree: t0.slice(0, 400) }, await snap(pg, "empty-study"));

// A5: Solve right away
const solveDis = await pg.evaluate(() => { const b = document.querySelector('#sim-tools [data-s="solve"]'); return { dis: b.disabled, why: b.dataset.why ?? b.title }; });
if (!solveDis.dis) await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(800);
const a5 = { ...(await sim()), solveDis, matDlg: await pg.isVisible("#mat-dlg[open]") };
async function pickSteel() {
  if (!(await pg.isVisible("#mat-dlg[open]"))) { await pg.click('#sim-tools [data-s="mat"]'); await pg.waitForSelector("#mat-dlg[open]"); }
  await pg.fill("#mat-q", "S235");
  await pg.waitForTimeout(300);
  await pg.click("#mat-dlg .mat-list li");
  await pg.click('#mat-dlg [data-a="ok"]');
  await idle(pg);
}
const a5t = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(e => e.textContent).join(" | ") + " || " + (document.querySelector("#sim-tree .sim-err")?.textContent ?? ""));
check("A5", !!a5.error || /material|support|load/i.test(a5t + a5.solveDis.why), "Solve with nothing set says what to add", { error: a5.error, text: a5t, solve: a5.solveDis, matDlg: a5.matDlg }, await snap(pg, "solve-empty"));
await pickSteel();

// B1: pick the end face first (Smart measure), then Fixed support.
await clickAt(pg, await screenOf(pg, END));
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="fixed"]');
await pg.waitForTimeout(400);
const b1 = await facesText();
check("B1", b1 === "1 face", "a face picked before Fixed support goes into it", { faces: b1 }, await snap(pg, "preselect"));
if (b1 !== "1 face") {
  // a person clicks the face again: right on its measurement label
  await clickAt(pg, await screenOf(pg, END));
  await pg.waitForTimeout(300);
  const again = await pg.evaluate(() => ({ faces: document.querySelector("#sim-pm .sim-faces")?.textContent ?? null, study: document.querySelector("#tab-sim")?.classList.contains("on") }));
  check("B1b", again.faces === "1 face" && again.study, "a click on the face picked before the command adds it and keeps the panel on screen", again, await snap(pg, "preselect-click"));
  if (!again.study) await pg.click("#t-sim");
  if (again.faces !== "1 face") await clickAt(pg, await screenOf(pg, [50, -7, 4]));
}
// B2: click the top face, then click it again
await clickAt(pg, await screenOf(pg, TOP));
await pg.waitForTimeout(250);
const b2a = await facesText();
await clickAt(pg, await screenOf(pg, TOP));
await pg.waitForTimeout(250);
const b2b = await facesText();
check("B2", b2a === "2 faces" && b2b === "1 face", "a second click takes a face out again", { b2a, b2b }, await snap(pg, "toggle"));
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// B3: right-click the top face with the Simulation tab on
await pg.mouse.move(...(await screenOf(pg, TOP)));
await pg.mouse.click(...(await screenOf(pg, TOP)), { button: "right" });
await pg.waitForTimeout(400);
const b3 = await pg.evaluate(() => [...document.querySelectorAll("#mc-menu button, .mc-menu button")].filter(b => b.offsetParent).map(b => b.textContent.trim()));
check("B3", b3.some(x => /Force|Pressure|support/i.test(x)), "a right-click on a face offers study commands", { menu: b3 }, await snap(pg, "rightclick"));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);

// C1: force typed as "2 kN"
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, TOP));
await pg.fill('#sim-pm [data-n="value"]', "2 kN");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(250);
const c1 = await pg.evaluate(() => ({ v: document.querySelector('#sim-pm [data-n="value"]')?.value, err: document.querySelector("#sim-pm .pm-err, #sim-pm .bad")?.textContent ?? null }));
await snap(pg, "force-kn");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const r1 = await rows();
const treeShowsValue = /2 kN|2000 N/.test(await tree());

// B6: Ctrl+Z takes the force back, Ctrl+Y puts it again
await pg.mouse.move(700, 450);
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(400);
const b6a = (await rows()).length;
await pg.keyboard.press("Control+y");
await pg.waitForTimeout(400);
const b6b = (await rows()).length;
check("B6", b6a === 1 && b6b === 2, "Ctrl+Z / Ctrl+Y take back and put again a study change", { after: b6a, again: b6b }, await snap(pg, "undo-redo"));

// A2: material: the study needs one; pick from its note/button
check("A2", a5.matDlg, "Solve without a material opens the material picker", {});

// D1: solve
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(500);
const d1 = await pg.evaluate(() => ({ shown: !document.querySelector("#st-sim")?.hidden, stop: !!document.querySelector('#st-sim [data-a="simstop"]') }));
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 });
const s1 = await sim();
check("C1", Math.abs(s1.maxU / 0.093 - 1) < 0.05, "a force typed as 2 kN is taken (twice the 1 kN deflection)", { c1, maxU: s1.maxU });
check("C1b", treeShowsValue, "the study tree shows each load's value, not only its face count", { rows: r1 });
check("D1", d1.shown && d1.stop && s1.done && !s1.error, "progress with Stop in the status bar, then results", { d1, maxU: s1.maxU, err: s1.error }, await snap(pg, "solved"));

// E7: undo the material? No: undo a harmless view change is not possible; undo then redo a load must keep results.
await pg.mouse.move(700, 450);
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(500);
await pg.keyboard.press("Control+y");
await pg.waitForTimeout(800);
const e7 = await sim();
check("E7", e7.done && !e7.stale, "undo then redo after a solve: the results are still current", { done: e7.done, stale: e7.stale }, await snap(pg, "undo-after-solve"));

// A second study: modal, solved too (E4, E6)
await pg.click('#sim-tools [data-s="newmodal"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, END));
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && s.kind === "modal") || s.error; }, null, { timeout: 300000 });
const m1 = await sim();
await snap(pg, "modal-solved");
const studyIds = await pg.evaluate(() => window.__sv.model.store.doc.studies.map(s => s.id));

// E1/E2: save, then open in a fresh browser with no disk cache
const focus = await pg.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}#${a.id}.${a.className} ${a.dataset?.k ?? ""}` : null; });
const saveDl = pg.waitForEvent("download", { timeout: 8000 }).then(() => true, () => false);
await pg.evaluate(() => { window.showSaveFilePicker = undefined; });
const tS = Date.now();
await pg.keyboard.press("Control+s");
const asked = await pg.waitForSelector("#name-dlg[open]", { timeout: 15000 }).then(() => true, () => false);
const askMs = Date.now() - tS;
if (asked) await pg.keyboard.press("Escape");
check("E0", asked && askMs < 1500, "Ctrl+S after solving asks for the file name at once", { focus, asked, askMs });
void saveDl;
await pg.mouse.click(700, 860); // the empty status bar, as a person clicks away
const file = await saveModel(pg, dir, "SimBar");
await finish(browser, pg);
({ browser, pg } = await open("simsetup2", "&nocache"));
await openFiles(pg, [file]);
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(1500);
const e1 = await pg.evaluate(() => ({ studies: window.__sv.model.store.doc.studies?.map(s => [s.id, s.kind, s.supports.length, s.loads.length]) ?? [] }));
const e6 = await sim();
check("E1", e1.studies.length === 2, "the saved part opens with both studies and their set-up", e1, await snap(pg, "reopened"));
check("E6", e6.study === studyIds[1], "the study used last opens", { open: e6.study, last: studyIds[1] });
// switch to the static study
const firstRow = await pg.$(`#sim-tree [data-study="${studyIds[0]}"], #sim-tree select[data-k="study"]`);
if (firstRow) {
  if (await firstRow.evaluate(e => e.tagName === "SELECT")) await firstRow.selectOption(studyIds[0]); else await firstRow.click();
}
await pg.waitForTimeout(1200);
const e2 = await sim();
check("E2", e2.study === studyIds[0] && e2.done && e2.fromFile && Math.abs(e2.maxU - s1.maxU) < 1e-9 && e2.plot.shown, "the static study's results come back without solving, with the plot", { study: e2.study, done: e2.done, fromFile: e2.fromFile, maxU: e2.maxU, before: s1.maxU, plot: e2.plot.shown }, await snap(pg, "static-reopened"));

// E4: the modal study's modes
await pg.selectOption('#sim-tree select[data-k="study"]', studyIds[1]);
await pg.waitForTimeout(1200);
const e4 = await sim();
check("E4", e4.done && e4.fromFile && e4.modes.length > 0 && Math.abs(e4.modes.find(m => !m.rigid)?.hz - m1.modes.find(m => !m.rigid)?.hz) < 1e-6, "the modal study's modes come back from the file", { done: e4.done, fromFile: e4.fromFile, modes: e4.modes.length }, await snap(pg, "modal-reopened"));
await pg.selectOption('#sim-tree select[data-k="study"]', studyIds[0]);
await pg.waitForTimeout(800);

// E3: change the model (right-click the top face, Edit feature, depth 25): the results are out of date
await pg.click("#cm-t-features");
await pg.waitForTimeout(300);
await pg.mouse.move(...(await screenOf(pg, TOP)));
await pg.mouse.click(...(await screenOf(pg, TOP)), { button: "right" });
await pg.waitForTimeout(400);
await pg.locator("#mc-menu button", { hasText: "Edit feature" }).first().click();
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
await dp.fill("25"); await dp.press("Enter"); await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
const vol = await pg.evaluate(() => window.__sv.model.store.doc.features.find(f => f.type === "extrude")?.depth);
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(800);
const e3s = await sim();
check("E3", e3s.stale, "after a model change the kept results show as out of date", { depth: vol, stale: e3s.stale, done: e3s.done }, await snap(pg, "changed-model"));

// F1-F4, E5, E10: a thermal study on the same part, its copy, saved and opened again
await pg.click('#sim-tools [data-s="mode-thermal"]');
await idle(pg);
if ((await sim()).kind !== "thermal") { await pg.click('#sim-tools [data-s="newthermal"]'); await idle(pg); }
const f1 = await sim();
check("F1", f1.kind === "thermal" && f1.barMode === "thermal", "the Thermal switch opens a thermal study", { kind: f1.kind, bar: f1.barMode }, await snap(pg, "thermal-study"));
const sur = await pg.$('#sim-tree [data-a="surround"]');
check("F2", !!sur, "a thermal study with no cooling offers Add surroundings");
if (sur) { await sur.click(); await idle(pg); }
await pg.click('#sim-tools [data-s="heat"]');
await clickAt(pg, await screenOf(pg, TOP));
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && s.kind === "thermal" && !s.stale) || s.error; }, null, { timeout: 300000 });
const th = await sim();
check("F3", th.done && !th.error && th.thermal?.max > 25, "10 W on the top face with surroundings solves", { err: th.error, max: th.thermal?.max }, await snap(pg, "thermal-solved"));
await pg.click('#sim-tree [data-a="dupstudy"]');
await pg.waitForTimeout(1500);
const dup = await sim();
check("E10", dup.done && !dup.stale && Math.abs(dup.thermal?.max - th.thermal?.max) < 1e-9, "a copy of a solved study keeps its results", { done: dup.done, stale: dup.stale, max: dup.thermal?.max }, await snap(pg, "thermal-copy"));
await pg.mouse.click(700, 860);
const thIds = await pg.evaluate(() => window.__sv.model.store.doc.studies.map(s => s.id));
const file2 = await saveModel(pg, dir, "SimBar2");
await finish(browser, pg);
({ browser, pg } = await open("simsetup3", "&nocache"));
await openFiles(pg, [file2]);
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(1200);
await pg.selectOption('#sim-tree select[data-k="study"]', thIds.at(-2));
await pg.waitForTimeout(1500);
const e5 = await sim();
check("E5", e5.done && e5.fromFile && e5.kind === "thermal" && Math.abs(e5.thermal?.max - th.thermal?.max) < 1e-6, "the thermal study's temperatures come back from the file", { done: e5.done, fromFile: e5.fromFile, max: e5.thermal?.max, saved: e5.savedStudies }, await snap(pg, "thermal-reopened"));
await finish(browser, pg);
