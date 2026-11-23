// Insulated faces and power by an expression, by hand (FRS-thermal FR-TBC-002, FR-TLOAD-005): a steel block making
// 10 W, cooled by convection on all open surfaces; its end insulated, so it runs hotter while all the heat still
// leaves; then over time with the power ramped up by min(1, t/300).
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalinsul");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const view = async k => { await pg.mouse.move(vp[0], vp[1]); await pg.keyboard.press(`Control+${k}`); await pg.waitForTimeout(900); };
const [a0, a1] = await pg.evaluate(() => [window.__sv.viewer.parts[0].data.bboxMin, window.__sv.viewer.parts[0].data.bboxMax]);
const ym = (a0[1] + a1[1]) / 2, zm = (a0[2] + a1[2]) / 2;
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
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="conv"]');
await pg.waitForSelector('#sim-pm [data-k="all"]');
await pg.check('#sim-pm [data-k="all"]');
await pg.waitForTimeout(200);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const open0 = await sim();

// TIN-1: Insulated on the block's end: the cooling leaves that face out, the block runs hotter, all 10 W still leave.
await pg.click('#sim-tools [data-s="insul"]');
await pg.waitForSelector("#sim-pm .sim-faces");
await view(3);
await clickAt(pg, await screenOf(pg, [a0[0], ym, zm]));
await pg.waitForTimeout(250);
const faces = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
const panelShot = await snap(pg, "panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await view(7);
const row = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-cool .sim-row")].map(r => r.textContent).find(x => /no heat crosses/.test(x)) ?? "");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
check("TIN-1", /1 face/.test(faces) && /no heat crosses/.test(row) && !s1.error && Math.abs(s1.thermal.out[0] / 10 - 1) < 0.02 && s1.thermal.max > open0.thermal.max,
  "the insulated end is left out of the convection on all open surfaces: the block runs hotter and all 10 W still leave", { faces, panelShot, row, out: s1.thermal?.out, max: s1.thermal?.max, before: open0.thermal?.max }, await snap(pg, "insulated"));

// TIN-2: over time, the heater's power ramped up by an expression of t; a bad expression is refused.
await pg.click('#sim-tools [data-s="transient"]');
await idle(pg);
await pg.click('#sim-tree .sim-heat .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm select[data-k="profile"]');
await pg.selectOption('#sim-pm select[data-k="profile"]', "expr");
await pg.waitForSelector('#sim-pm input[data-k="pexpr"]');
await pg.fill('#sim-pm input[data-k="pexpr"]', "1 +");
await pg.press('#sim-pm input[data-k="pexpr"]', "Tab");
await pg.waitForTimeout(250);
const bad = await pg.evaluate(() => ({ inv: document.querySelector('#sim-pm input[data-k="pexpr"]')?.getAttribute("aria-invalid"), toast: document.querySelector(".toast")?.textContent ?? "" }));
await pg.fill('#sim-pm input[data-k="pexpr"]', "min(1, t/300)");
await pg.press('#sim-pm input[data-k="pexpr"]', "Tab");
await pg.waitForTimeout(250);
const exprShot = await snap(pg, "expr");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const tr = (await sim()).transient, i = tr?.times.indexOf(tr.times.find(x => x > 0 && x < 300) ?? -1) ?? -1;
check("TIN-2", bad.inv === "true" && tr && i > 0 && Math.abs(tr.put[i] / (10 * tr.times[i] / 300) - 1) < 0.05 && Math.abs(tr.put.at(-1) / 10 - 1) < 0.02,
  "the power follows min(1, t/300): a share t/300 of the 10 W before 5 minutes, full after; \"1 +\" is refused", { bad, exprShot, times: tr?.times, put: tr?.put }, await snap(pg, "ramp"));

// TIN-3: both panels in Russian.
await pg.click('#sim-tree .sim-heat .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm input[data-k="pexpr"]');
await pg.click("#lang-btn");
await pg.waitForTimeout(200);
const ru1 = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "ru");
await pg.click("#sim-pm .pm-cancel");
await pg.click('#sim-tools [data-s="insul"]');
await pg.waitForSelector("#sim-pm .sim-faces");
const ru2 = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
await pg.click("#sim-pm .pm-cancel");
await pg.click("#lang-btn");
check("TIN-3", ru1.length === 0 && ru2.length === 0, "the expression and insulated panels are all in Russian", { ru1, ru2 }, ruShot);

await finish(browser, pg);
