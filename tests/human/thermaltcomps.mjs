// Transient results per component by hand (FRS-thermal FR-TRES-006): two blocks end to end, one heated, warmed for
// 10 minutes: the chart shows each block's highest temperature, one can be left off, time to reach and the CSV take
// them, and the warm-up plays at a chosen speed.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermaltcomps");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
// the part gets its material first: every component is analysed with its part's
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await pg.click('#asm-tools [data-ac="insert"]');
await pg.waitForTimeout(300);
await pg.getByText(/^Open document:/).first().click();
await pg.waitForTimeout(800);
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await clickAt(pg, [vp[0] + 220, vp[1] - 120]);
await pg.waitForTimeout(1500);

// the second block goes end to end with the first, 0.05 mm away: typed in the Move panel
const rows = await pg.$$("#asm-tree .ft-row[data-id]");
const comps = [];
for (const r of rows) if (/Block|Part|<\d+>/.test(await r.innerText())) comps.push(r);
await comps[comps.length - 1].click();
await pg.waitForTimeout(300);
await pg.click('#asm-tools [data-ac="move"]');
await pg.waitForSelector('#asm-pm input[data-pose="x"]');
for (const [k, v] of [["x", "100.05"], ["y", "0"], ["z", "0"], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
  const i = await pg.$(`#asm-pm input[data-pose="${k}"]`);
  await i.fill(v); await i.press("Enter");
  await pg.waitForTimeout(500);
}
if (await pg.isVisible("#asm-pm [data-a=ok]")) await pg.click("#asm-pm [data-a=ok]");
await pg.waitForTimeout(1500);
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("f");
await pg.waitForTimeout(900);
const placed = await pg.evaluate(() => window.__sv.viewer.parts.map(p => [p.data.bboxMin.map(v => Math.round(v * 100) / 100), p.data.bboxMax.map(v => Math.round(v * 100) / 100)]));
check("THA-1", placed.length === 2 && Math.abs(placed[1][0][0] - placed[0][1][0] - 0.05) < 1e-6, "two blocks stand end to end, 0.05 mm apart", placed, await snap(pg, "two-blocks"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const x1 = placed[1][1][0], x0 = placed[0][0][0], zt = placed[0][1][2], ym = (placed[0][0][1] + placed[0][1][1]) / 2;
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);

// THA-2: Thermal works over an assembly; a fixed temperature on the second block's far end makes the study.
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [x1, ym, zt / 2]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// 4 W made throughout the first block: one of its faces is clicked, then Throughout the whole component
await pg.click('#sim-tools [data-s="heat"]');
await clickAt(pg, await screenOf(pg, [(x0 + placed[0][1][0]) / 2, ym, zt]));
await pg.waitForTimeout(250);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "4");
await pg.press('#sim-pm [data-n="value"]', "Tab");
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// THC-1: over time, 600 s with results every 60 s; each block's highest temperature is drawn and listed.
await pg.click('#sim-tools [data-s="transient"]');
await idle(pg);
await pg.fill('#sim-tree [data-k="tend"]', "600");
await pg.press('#sim-tree [data-k="tend"]', "Tab");
await idle(pg);
await pg.fill('#sim-tree [data-k="tout"]', "60");
await pg.press('#sim-tree [data-k="tout"]', "Tab");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), T = s1.transient, c = T?.comps ?? [];
const chart = () => pg.evaluate(() => ({ lines: document.querySelectorAll("#sim-tree svg.sim-tchart polyline").length, legend: [...document.querySelectorAll("#sim-tree .sim-legline span")].map(e => e.textContent) }));
const ch1 = await chart();
await pg.locator("#sim-tree svg.sim-tchart").scrollIntoViewIfNeeded();
check("THC-1", !s1.error && c.length === 2 && c[0].v.at(-1) > c[1].v.at(-1) && ch1.lines === 3 && ch1.legend.length === 3,
  "after a 10 minute warm-up the chart draws the hottest point and each block's highest temperature, the heated block first", { error: s1.error, comps: c.map(x => ({ name: x.name, start: x.v[0], end: x.v.at(-1) })), ch1 }, await snap(pg, "tcomps-chart"));

// THC-2: the colder block is left off the chart from the Components list.
await pg.click("#sim-tree .sim-tcomps-pick summary");
await pg.waitForTimeout(200);
await pg.locator('#sim-tree .sim-tcomplist li').nth(1).locator('input[data-k="tcomp"]').uncheck();
await idle(pg);
const ch2 = await chart(), s2 = await sim();
check("THC-2", ch2.lines === 2 && s2.transient.compsShown.length === 1 && s2.transient.compsShown[0] === c[0].name,
  "unticking the colder block takes its line off the chart and the list stays open", { ch2, shown: s2.transient.compsShown }, await snap(pg, "tcomps-one"));

// THC-3: time to reach a temperature lists the hottest point and the block on the chart; the CSV has both blocks.
const mid = Math.round((c[0].v[0] + c[0].v.at(-1)) / 2 * 10) / 10;
await pg.fill('#sim-tree [data-k="reach"]', String(mid));
await pg.press('#sim-tree [data-k="reach"]', "Tab");
await idle(pg);
const reach = await pg.evaluate(() => [...document.querySelectorAll('#sim-tree [data-v="treach"]')].map(e => e.textContent));
const head = (await sim()).transient.csv.split("\n")[0];
check("THC-3", reach.length === 2 && reach.some(r => r.startsWith(c[0].name) && !/not reached/.test(r)) && (head.match(/ max, °C/g) ?? []).length === 2,
  `time to reach ${mid} °C is given for the heated block; the CSV has a column for each block's highest temperature`, { reach, head }, await snap(pg, "tcomps-reach"));

// THC-4: the warm-up plays at ×4 to the end.
await pg.selectOption('#sim-legend .sim-time select[data-k="speed"]', "4");
await pg.click('#sim-legend [data-a="tplay"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state().transient; return !s.playing && s.frame === s.times.length - 1; }, null, { timeout: 20000 });
const s4 = await sim();
check("THC-4", s4.transient.speed === 4 && s4.transient.frame === s4.transient.times.length - 1,
  "the speed on the legend's time row plays the warm-up at ×4 to the end", { speed: s4.transient.speed, frame: s4.transient.frame }, await snap(pg, "tcomps-played"));

await finish(browser, pg);
