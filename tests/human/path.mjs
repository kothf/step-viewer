// Results along a path by hand (FRS-structural FR-RES-031): a clamped block under a force is solved, then two points
// are clicked on the plot; the Study tab charts the result along the line between them and saves it as CSV.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simpath");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done || s.error; }, null, { timeout: 300000 }); await pg.waitForTimeout(400); };

await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r0 = await sim();


// P-1: Path in the legend, then a point near the clamped end and one near the free end on the top face.
await pg.click('#sim-legend [data-a="path"]');
const hint0 = await pg.evaluate(() => document.querySelector('#sim-legend [data-v="pathhint"]')?.textContent ?? "");
const onPlot = async p => { const s = await sim(); const k = s.plot.scale; return screenOf(pg, p); };
await clickAt(pg, await onPlot([40, 0, 20]));
await pg.waitForTimeout(300);
const mid = await sim();
const hint1 = await pg.evaluate(() => document.querySelector('#sim-legend [data-v="pathhint"]')?.textContent ?? "");
await clickAt(pg, await onPlot([-40, 0, 20]));
await idle(pg);
await pg.waitForFunction(() => window.__sv.sim.state().path.source === "solution", null, { timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(300);
const p1 = await sim();
const chart = await pg.evaluate(() => ({ svg: !!document.querySelector("#sim-tree svg.sim-pathchart polyline"), info: document.querySelector('#sim-tree [data-v="pathinfo"]')?.textContent ?? "",
  wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
const len = p1.path.at ? Math.hypot(...p1.path.at[0].map((v, i) => v - p1.path.at[1][i])) : 0;
check("P-1", /start/.test(hint0) && /end/.test(hint1) && mid.path.first && !!p1.path.at && !p1.path.picking && len > 40 && len < 120 && p1.path.points === 101 && p1.path.inside >= 95 && p1.path.source === "solution"
  && p1.path.max > 0.3 * r0.maxVm && p1.path.max <= 1.05 * r0.maxVm && p1.path.min < 0.7 * p1.path.max && chart.svg && /von Mises/.test(chart.info) && chart.wide <= 0 && p1.path.drawn === 2,
  "two clicks on the plot make a path; the Study tab charts the stress along it, falling towards the loaded end", { path: { ...p1.path, csv: undefined }, len, chart, hint0, hint1 }, await snap(pg, "path-chart"));

// P-2: the CSV has a row per point with distance, place, stress and displacement; another result re-draws the chart.
const rows = p1.path.csv.trim().split("\r\n");
await pg.selectOption('#sim-legend [data-k="kind"]', "u");
await pg.waitForTimeout(400);
const p2 = await sim();
const info2 = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="pathinfo"]')?.textContent ?? "");
check("P-2", rows.length === 102 && rows[0].startsWith("Distance (mm)") && rows[1].split(",").length === 9 && Math.abs(Number(rows[101].split(",")[0]) - len) < 1e-3
  && /Displacement/.test(info2) && p2.path.max > 0 && p2.path.max <= 1.05 * r0.maxU, "the CSV lists every point; with Displacement picked the chart shows the displacement", { rows: rows.length, head: rows[0], last: rows[101], info2, max: p2.path.max, maxU: r0.maxU }, await snap(pg, "path-displacement"));

// P-3: Remove path: the chart and the line go; Undo brings them back.
await pg.click('#sim-tree [data-a="rmpath"]');
await idle(pg);
const p3 = await sim();
const gone = await pg.evaluate(() => !document.querySelector("#sim-tree svg.sim-pathchart"));
await pg.keyboard.press("Control+z");
await idle(pg);
await pg.waitForTimeout(500);
const p3b = await sim();
check("P-3", !p3.path.at && gone && p3.path.drawn === 0 && !!p3b.path.at && p3b.path.points === 101, "Remove path takes the chart and the line away, and Undo brings them back", { after: p3.path.at, drawn: p3.path.drawn, undone: p3b.path.at }, await snap(pg, "path-undone"));

await finish(browser, pg);
