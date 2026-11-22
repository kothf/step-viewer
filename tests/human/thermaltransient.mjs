// Transient thermal study by hand (FRS-thermal TH4): a steel block warming up under a heater, fan-cooled on its
// top face, against the lumped answer; then the heater on a duty cycle; the time slider, play, probes, time to reach.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermaltransient");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const top = async () => clickAt(pg, await screenOf(pg, [-30, 0, 20]));
const side = async () => clickAt(pg, await screenOf(pg, [20, -10, 10]));
const seek = k => pg.$eval('#sim-legend input[data-k="time"]', (e, k) => { e.value = String(k); e.dispatchEvent(new Event("input", { bubbles: true })); }, k);

// TT-1: S235, 10 W in the whole block, fan cooling (40 W/(m²·K)) on the top face; the clock button turns the study transient.
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
await top();
await pg.waitForTimeout(250);
await pg.selectOption('#sim-pm [data-k="film"]', "40");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="transient"]');
await idle(pg);
await pg.fill('#sim-tree [data-k="tend"]', "1800");
await pg.press('#sim-tree [data-k="tend"]', "Tab");
await idle(pg);
const t1 = await pg.evaluate(() => ({ on: document.querySelector('#sim-tree [data-k="transient"]')?.checked, rcp: document.querySelector('#sim-tree [data-v="rcp"]')?.textContent ?? "", kind: document.querySelector('#sim-tree [data-v="kind"]')?.textContent ?? "",
  tr: window.__sv.model.store.doc.studies[0].settings.transient }));
check("TT-1", t1.on && /461/.test(t1.rcp) && /Transient/.test(t1.kind) && t1.tr?.end === 1800 && t1.tr?.out === 60,
  "the clock button makes the thermal study transient: a Time section with end time, output interval and start temperature, and the material's density and specific heat shown", t1, await snap(pg, "transient-set"));

// TT-2: solved: the block warms like a lumped mass, C·dT/dt = P − h·A·(T − T∞).
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), T2 = s2.transient;
const C = 7.85e-6 * 461 * 40000, hA = 40 * 2e-3, lump = t => 25 + (10 / hA) * (1 - Math.exp(-hA * t / C));
const end2 = T2 ? T2.max[T2.max.length - 1] : 0, mono = T2 ? T2.max.every((v, i) => !i || v >= T2.max[i - 1] - 1e-6) : false;
check("TT-2", !s2.error && T2 && T2.times.length === 31 && mono && end2 / lump(1800) > 0.97 && end2 / lump(1800) < 1.1 && T2.steady > end2 && s2.plot.shown && s2.plot.kind === "temp",
  "10 W in a 145 J/K block losing h·A·ΔT through its top face: after 30 min the block is at the lumped answer within a few per cent, still below the steady temperature", { error: s2.error, max: T2?.max, lump: lump(1800), steady: T2?.steady, steps: T2?.steps }, await snap(pg, "transient-warm"));

// TT-3: the slider shows any output time; play runs the warm-up; a probe and Time to reach read the curve.
await seek(10);
await pg.waitForTimeout(300);
const s3 = await sim(), tt = await pg.evaluate(() => document.querySelector('#sim-legend [data-v="ttime"]')?.textContent ?? "");
await pg.click('#sim-legend [data-a="probe"]');
await side();
await pg.waitForTimeout(400);
await pg.click('#sim-legend [data-a="probe"]');
await pg.fill('#sim-tree [data-k="reach"]', "60");
await pg.press('#sim-tree [data-k="reach"]', "Tab");
await pg.waitForTimeout(300);
const reach = await pg.evaluate(() => [...document.querySelectorAll('#sim-tree [data-v="treach"]')].map(e => e.textContent));
await seek(0);
await pg.click('#sim-legend [data-a="tplay"]');
await pg.waitForTimeout(400);
const playing = (await sim()).transient.playing;
await pg.waitForFunction(() => { const s = window.__sv.sim.state().transient; return !s.playing && s.frame === s.times.length - 1; }, null, { timeout: 60000 });
const s3b = await sim();
const tReach = -C / hA * Math.log(1 - (60 - 25) * hA / 10);
check("TT-3", s3.transient.time === 600 && /10 min/.test(tt) && Math.abs(s3.transient.shown - T2.max[10]) < 1e-6 && playing && s3b.transient.probes.length === 1 && s3b.transient.probes[0].length === 31 && reach.length >= 2 && /^"Time, s"/.test(s3b.transient.csv),
  "the time slider shows the block at 10 min, Play runs the warm-up to the end, a probe gets the temperature at every output time, and Time to reach 60 °C reads off the curve", { time: s3.transient.time, tt, playing, probe: s3b.transient.probes[0]?.length, reach, lumpReach: tReach }, await snap(pg, "transient-probe"));

// TT-4: the heater on a duty cycle (30 s of every 60 s): about half the rise.
await pg.click('#sim-tree .sim-heat button.sim-name[data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.selectOption('#sim-pm [data-k="profile"]', "duty");
await pg.waitForTimeout(200);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const meta = await pg.evaluate(() => document.querySelector("#sim-tree .sim-heat .sim-meta")?.textContent ?? "");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim(), T4 = s4.transient, end4 = T4 ? T4.max[T4.max.length - 1] : 0, f = (end4 - 25) / (end2 - 25);
check("TT-4", !s4.error && T4 && f > 0.42 && f < 0.58,
  "with the heater on 30 s in every 60 s the block rises about half as much in 30 min", { meta, error: s4.error, end2, end4, f }, await snap(pg, "transient-duty"));

// TT-6: the warm-up saved as an animated GIF, one frame per output time.
await pg.click('#sim-legend [data-a="gif"]');
await pg.waitForFunction(() => window.__sv.sim.state().gifs > 0, null, { timeout: 120000 });
const s6 = await sim();
check("TT-6", s6.gif && s6.gif.frames === T4.times.length && s6.gif.bytes > 1000,
  "the GIF button in the legend saves the warm-up, one frame per output time", { gif: s6.gif, times: T4?.times.length }, await snap(pg, "transient-gif"));

// TT-5: Russian.
await pg.click("#lang-btn");
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim *, #sim-tools *, #sim-legend *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "transient-ru");
await pg.click("#lang-btn");
check("TT-5", ru.length === 0, "the Time section, the warm-up chart and the slider are all in Russian", { ru }, ruShot);

await finish(browser, pg);
