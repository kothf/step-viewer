// Thermal study of a part by hand (FRS-thermal TH2) and the Simulation bar's Structural | Thermal switch:
// a block heated throughout, cooled through its top face, against the closed-form answers.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermal");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const bar = () => pg.evaluate(() => ({ ids: [...document.querySelectorAll("#sim-tools [data-s]")].map(b => b.dataset.s), on: document.querySelector("#sim-tools .sim-mode-b.on")?.dataset.s ?? "",
  wide: document.querySelector("#sim-tools").scrollWidth - document.querySelector("#cm-body").clientWidth }));
const top = async () => clickAt(pg, await screenOf(pg, [-30, 0, 20]));

// TH-1: the bar opens on Structural; Thermal swaps the commands for heat sources and cooling.
await pg.click("#cm-t-simulation");
const b0 = await bar();
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
const b1 = await bar();
check("TH-1", b0.on === "mode-structural" && b0.ids.includes("force") && !b0.ids.includes("heat") && b1.on === "mode-thermal" && ["newthermal", "mat", "ambient", "heat", "hflux", "temp", "conv", "rad", "solve", "results", "report"].every(k => b1.ids.includes(k)) && !b1.ids.includes("force") && !b1.ids.includes("fixed"),
  "the Simulation bar starts with the structural commands; the Thermal button shows thermal study, heat sources, cooling and solve instead", { b0, b1 }, await snap(pg, "thermal-bar"));

// TH-2: heat power in the whole body makes a thermal study by itself; fixed temperature on the top face; solved.
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
await pg.click('#sim-tools [data-s="temp"]');
await top();
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const k = await pg.evaluate(() => Number((document.querySelector('#sim-tree [data-v="kcond"]')?.textContent ?? "").match(/([\d.]+)\s*W/)?.[1]));
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const shown2 = await pg.evaluate(() => ({ kind: document.querySelector('#sim-tree [data-v="kind"]')?.textContent, tmax: document.querySelector('#sim-tree [data-v="tmax"]')?.textContent, tmin: document.querySelector('#sim-tree [data-v="tmin"]')?.textContent,
  heat: document.querySelector('#sim-tree [data-v="heatin"]')?.textContent, flow: document.querySelector('#sim-tree [data-v="flow"]')?.textContent, legend: document.querySelector('#sim-legend [data-k="kind"]')?.value,
  deformed: !!document.querySelector('#sim-legend [data-k="deformed"]'), wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
const rise = 10 * 0.02 / (2 * k * 2e-3), T = s2.thermal;
check("TH-2", !s2.error && s2.kind === "thermal" && k > 0 && T && Math.abs(T.min - 40) < 0.02 && Math.abs((T.max - 40) / rise - 1) < 0.02 && Math.abs(T.applied - 10) < 1e-6 && Math.abs(T.flows[0].out - 10) < 0.01 && shown2.legend === "temp" && !shown2.deformed && shown2.wide <= 0 && s2.plot.shown,
  "10 W made in the whole block and its top face held at 40 °C: the hottest point is P·t / (2·k·A) above 40 °C, and the face takes all 10 W away", { k, rise, thermal: T, shown2, error: s2.error }, await snap(pg, "thermal-fixed"));

// TH-3: heat flux plot.
await pg.selectOption('#sim-legend [data-k="kind"]', "flux");
await pg.waitForTimeout(400);
const s3 = await sim();
const unit3 = await pg.evaluate(() => document.querySelector("#sim-legend .ana-scale")?.textContent ?? "");
check("TH-3", s3.plot.kind === "flux" && /W\/m²/.test(unit3), "the legend switches the plot to the heat flux, in W/m²", { kind: s3.plot.kind, unit3 }, await snap(pg, "thermal-flux"));

// TH-4: convection by a fan on the top face instead of the fixed temperature.
await pg.click('#sim-tree .sim-cool .sim-row [data-a="toggle"]');
await idle(pg);
await pg.click('#sim-tools [data-s="conv"]');
await top();
await pg.waitForTimeout(250);
await pg.selectOption('#sim-pm [data-k="film"]', "40");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const stale = (await sim()).stale;
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim();
const f4 = s4.thermal?.flows[0];
check("TH-4", stale && !s4.error && f4 && Math.abs(f4.out - 10) < 0.01 && Math.abs(f4.mean - (25 + 10 / (40 * 2e-3))) < 0.5 && s4.thermal.max > f4.mean,
  "with fan cooling (40 W/(m²·K)) on the top face at 25 °C ambient the face settles at 25 + P / (h·A) = 150 °C on average and gives off all 10 W", { thermal: s4.thermal, error: s4.error }, await snap(pg, "thermal-conv"));

// TH-5: a structural command while a thermal study is open makes a static study; the switch goes back to the thermal one.
await pg.click('#sim-tools [data-s="mode-structural"]');
await pg.waitForTimeout(200);
const mid = await bar();
await pg.click('#sim-tools [data-s="fixed"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await top();
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const s5 = await sim(), b5 = await bar();
await pg.click('#sim-tools [data-s="mode-thermal"]');
await idle(pg);
const s6 = await sim(), b6 = await bar();
check("TH-5", mid.on === "mode-structural" && mid.ids.includes("fixed") && s5.kind === "static" && b5.on === "mode-structural" && s6.kind === "thermal" && b6.on === "mode-thermal" && b6.ids.includes("heat"),
  "Structural shows the structural commands; Fixed then starts a static study of its own, and Thermal returns to the thermal study", { mid: mid.on, k5: s5.kind, b5: b5.on, k6: s6.kind, b6: b6.on }, await snap(pg, "thermal-switch"));

// TH-6: nothing to take the heat away is refused in plain words.
await pg.click('#sim-tree .sim-cool .sim-row:not(.off) [data-a="toggle"]');
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s7 = await sim();
const msg = await pg.evaluate(() => document.querySelector("#sim-tree .sim-res .sim-prob")?.textContent ?? "");
check("TH-6", /E-TH-NOSINK/.test(s7.error ?? "") && /heat away/.test(msg), "without cooling the study is not solved and says the heat has no way out", { error: s7.error, msg }, await snap(pg, "thermal-nosink"));

await finish(browser, pg);
