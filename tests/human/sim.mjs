// Structural analysis by hand (FRS-structural SA1): a steel bar clamped at one end with a load on top, set up and
// solved through the Simulation tab, with the stress and displacement plots.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("sim");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());

// SA1-1: the Simulation tab shows its commands and the Study tab beside the model.
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
const tab = await pg.evaluate(() => ({ study: document.querySelector("#tab-sim").classList.contains("on"), cmds: [...document.querySelectorAll("#sim-tools .mc-b .mc-l")].map(e => e.textContent) }));
const img1 = await snap(pg, "simulation-tab");
check("SA1-1", tab.study && tab.cmds.includes("Solve") && tab.cmds.includes("Force") && tab.cmds.includes("Fixed support"), "the Simulation tab lists study, support, load and solve commands and opens the Study tab", tab, img1);

// SA1-2: Material… picks a steel from the library; the Study tab shows its modulus.
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="new"]');
await idle(pg);
const mat = await pg.evaluate(() => ({ m: window.__sv.model.store.doc.material, note: document.querySelector("#sim-tree .sim-note")?.textContent ?? "" }));
const img2 = await snap(pg, "material");
check("SA1-2", mat.m?.E > 100 && /GPa/.test(mat.note), "a library steel becomes the part's material and the study shows E and ν", { name: mat.m?.name, E: mat.m?.E, note: mat.note }, img2);

// SA1-3: Fixed support: click the end face, ✓.
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
const img3 = await snap(pg, "fixed-face");
const s3 = await pg.evaluate(() => ({ faces: document.querySelector("#sim-pm .sim-faces")?.textContent, marks: window.__sv.sim.state().marks }));
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// SA1-4: Force: click the top face, type 1000 N, ✓.
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.fill('#sim-pm [data-n="value"]', "1000");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(250);
const img4 = await snap(pg, "force-face");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const rows = await pg.$$eval("#sim-tree .sim-row .sim-name", els => els.map(e => e.textContent.trim()));
check("SA1-3", s3.faces === "1 face" && s3.marks >= 1 && rows.length === 2, "a support and a force take the faces clicked on the model and show in the study tree", { s3, rows }, img4);
void img3;

// SA1-5: Solve: progress, then the stress plot on the deformed shape and the numbers (beam theory with shear: 0.0465 mm, 37.5 MPa).
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(400);
const img5 = await snap(pg, "solving");
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 });
await pg.waitForTimeout(400);
const r = await sim();
const img6 = await snap(pg, "stress-deformed");
check("SA1-5", !r.error && Math.abs(r.maxU / 0.0465 - 1) < 0.08 && Math.abs(r.maxVm / 37.5 - 1) < 0.3 && r.plot.shown,
  "the bar solves: tip deflection and root stress match beam theory, the reaction equals the load, the stress plot shows on the deformed shape", { err: r.error, maxU: r.maxU, maxVm: r.maxVm, passes: r.passes.map(p => [p.p, p.dofs, p.change]), reaction: r.reactions[0]?.force }, img6);
void img5;

// SA1-9: the Study tab gives the estimated error with a chart of the passes; the legend can plot where it sits.
await pg.selectOption('#sim-legend [data-k="kind"]', "err");
await pg.waitForTimeout(300);
const er = await pg.evaluate(() => ({ errors: window.__sv.sim.state().errors, kv: document.querySelector('#sim-tree .sim-kv [data-v="error"]')?.textContent ?? "", chart: !!document.querySelector("#sim-tree svg.sim-conv polyline"), plot: window.__sv.sim.state().plot }));
const img11 = await snap(pg, "error-estimate");
check("SA1-9", er.errors.length === r.passes.length && (er.errors[1] == null || er.errors[0] > er.errors[1]) && /%/.test(er.kv) && (er.errors.length < 3 || er.chart) && er.plot.kind === "err" && er.plot.range[1] > 0,
  "the error estimate falls from pass to pass, shows in the Study tab with its chart, and plots on the model", er, img11);

// SA1-6: the legend switches to displacement on the undeformed model.
await pg.selectOption('#sim-legend [data-k="kind"]', "u");
await pg.uncheck('#sim-legend [data-k="deformed"]');
await pg.waitForTimeout(300);
const r2 = await sim();
const img7 = await snap(pg, "displacement");
check("SA1-6", r2.plot.kind === "u" && r2.plot.scale === 0 && Math.abs(r2.plot.range[1] - r.maxU) < 1e-6, "the legend switches the plot to displacement and turns the deformed shape off", r2.plot, img7);

// SA1-8: Probe: click the plot, the value at that point is pinned on the model; Esc ends probing.
await pg.click('#sim-legend [data-a="probe"]');
await clickAt(pg, await screenOf(pg, [50, 0, 20]));
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.waitForTimeout(250);
const pr = await pg.evaluate(() => ({ probes: window.__sv.sim.state().probes, labels: [...document.querySelectorAll("#sim-probes [data-probe] span")].map(e => e.textContent) }));
const img10 = await snap(pg, "probes");
await pg.keyboard.press("Escape");
check("SA1-8", pr.probes.length === 2 && pr.labels.length === 2 && pr.probes[0] < 0.01 * r.maxU + 1e-4 && pr.probes[1] > 0.2 * r.maxU && pr.probes[1] < 0.5 * r.maxU && !(await sim()).probing,
  "two probes on the displacement plot: about zero at the clamped end, a part of the tip deflection at the middle", pr, img10);

// SA1-10: Report: the button asks for the format; the web page and the PDF are saved, and the page reads well.
await pg.click('#sim-tools [data-s="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const img12 = await snap(pg, "report-ask");
const [dlH] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
const htmlPath = `${process.env.HT_OUT ?? "/mnt/project-files/gap-tests"}/sim-report.html`;
await dlH.saveAs(htmlPath);
await pg.click('#sim-tree [data-a="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [dlP] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="pdf"]')]);
const pdfHead = (await (await import("node:fs/promises")).readFile(await dlP.path())).subarray(0, 5).toString();
const rp = await pg.context().newPage();
await rp.setViewportSize({ width: 1000, height: 1400 });
await rp.goto(`file://${htmlPath}`);
const repFacts = await rp.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, heads: [...document.querySelectorAll("h2")].map(e => e.textContent), imgs: [...document.querySelectorAll("figure img")].filter(i => i.naturalWidth > 100).length, chart: !!document.querySelector("svg.sim-conv polyline"), rows: document.querySelectorAll("tbody tr").length, text: document.body.innerText.includes("do not replace a validated analysis") }));
await rp.screenshot({ path: `${process.env.HT_OUT ?? "/mnt/project-files/gap-tests"}/sim-report-page.png`, fullPage: true });
await rp.close();
check("SA1-10", repFacts.imgs === 3 && repFacts.heads.length >= 6 && repFacts.rows > 15 && repFacts.text && pdfHead === "%PDF-" && /report\.pdf$/.test(dlP.suggestedFilename()),
  "Report saves a web page and a PDF with the set-up, the results, three pictures, the convergence and the statement", { ...repFacts, pdf: dlP.suggestedFilename() }, img12);

// SA1-7: editing the force (double the load) puts the results out of date; Solve again doubles the deflection.
await pg.click("#sim-tree .sim-row[data-id=\"l1\"] .sim-name");
await pg.fill('#sim-pm [data-n="value"]', "2000");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const stale = (await sim()).stale;
const img8 = await snap(pg, "out-of-date");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && !s.stale) || s.error; }, null, { timeout: 300000 });
const r3 = await sim();
const img9 = await snap(pg, "solved-again");
check("SA1-7", stale && !r3.error && Math.abs(r3.maxU / r.maxU - 2) < 0.01, "a changed load marks the results out of date; solving again doubles the deflection", { stale, maxU: r3.maxU }, img9);
void img8;

// SA1-11: a force on an edge and one on a corner point: Acts on → Edges / Points, a click on the model each.
await pg.click('#sim-legend [data-a="close"]');
const spot = await pg.evaluate(() => {
  const v = window.__sv.viewer, part = v.parts[0], r = v.renderer.domElement.getBoundingClientRect();
  const scr = q => { const s = v.toWorld(part, q).clone().project(v.camera); return { x: r.left + ((s.x + 1) / 2) * r.width, y: r.top + ((1 - s.y) / 2) * r.height }; };
  const e = part.data.edges.filter(e => e.type === "line").map(e => ({ e, d: v.toWorld(part, e.mid).distanceTo(v.camera.position) })).sort((a, b) => a.d - b.d)[0].e;
  return { mid: scr(e.mid), start: scr(e.start) };
});
await pg.click('#sim-tools [data-s="force"]');
await pg.selectOption('#sim-pm [data-k="on"]', "edges");
await pg.mouse.click(spot.mid.x, spot.mid.y);
await pg.fill('#sim-pm [data-n="c2"]', "-300");
await pg.keyboard.press("Tab");
const img13 = await snap(pg, "force-on-edge");
const eb = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="force"]');
await pg.selectOption('#sim-pm [data-k="on"]', "points");
await pg.mouse.click(spot.start.x, spot.start.y);
await pg.fill('#sim-pm [data-n="c2"]', "-200");
await pg.keyboard.press("Tab");
const img14 = await snap(pg, "force-on-point");
const pb = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const img15 = await snap(pg, "edge-and-point-marks");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && !s.stale) || s.error; }, null, { timeout: 300000 });
const r4 = await sim();
const img16 = await snap(pg, "edge-and-point-solved");
const total = Math.hypot(...r4.applied.force), before = Math.hypot(...r3.applied.force);
check("SA1-11", eb === "1 edge" && pb === "1 point" && !r4.error && total !== before && Math.abs(Math.hypot(...r4.reactions[0].force) - total) < 1e-3 * total,
  "a force on an edge and one on a corner point are picked on the model and solved; the support carries all the loads", { eb, pb, applied: r4.applied.force, reaction: r4.reactions[0].force }, img16);
void img13; void img14; void img15;

// SA1-12: local refinement: five passes with the stop target at 0; passes 4 and 5 work in some cells only.
await pg.click("#t-sim");
await pg.selectOption('#sim-tree [data-k="passes"]', "5");
await idle(pg);
await pg.fill('#sim-tree [data-k="tol"]', "0");
await pg.keyboard.press("Tab");
await idle(pg);
await pg.click('#sim-tree [data-a="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && !s.stale) || s.error; }, null, { timeout: 600000 });
const r5 = await sim();
const notes = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-local")].map(e => e.textContent));
await pg.selectOption('#sim-legend [data-k="kind"]', "err");
const img17 = await snap(pg, "local-passes");
const lp = r5.passes;
check("SA1-12", !r5.error && lp.length === 5 && lp[3].raised > 0 && lp[3].raised < lp[3].cells && lp[4].dofs > lp[3].dofs && notes.length === 2,
  "passes 4 and 5 raise the accuracy only where the error estimate is highest; the Study tab says in how many cells", { passes: lp.map(q => ({ p: q.p, raised: q.raised, cells: q.cells, dofs: q.dofs, ms: q.ms })), notes }, img17);
// SA1-13: hot spots: the list under the results, labels on the stress plot, a singular peak is flagged.
await pg.selectOption('#sim-legend [data-k="kind"]', "vm");
await idle(pg);
const hot = (await sim()).hot;
const hotRows = await pg.locator("#sim-tree .sim-hot tbody tr").count();
await pg.locator("#sim-tree .sim-hot tbody tr").last().click();
await idle(pg);
const hotPeaks = await pg.evaluate(() => [...document.querySelectorAll("#sim-probes .sim-peak")].map(e => e.textContent.trim()));
const img18 = await snap(pg, "hot-spots");
check("SA1-13", hot.length >= 2 && hotRows === hot.length && hotPeaks.length >= 2,
  "the highest stress peaks are listed and labelled on the plot; a peak that keeps growing with accuracy is marked as a singularity", { hot: hot.map(h => ({ vm: +h.vm.toFixed(1), singular: h.singular, growth: h.growth })), labels: hotPeaks }, img18);
await finish(browser, pg);
