// Forced air by hand (FRS-thermal FR-TBC-005): a block heated throughout, cooled first by still air, then by a fan
// blowing along it, then across it. Faster air and a shorter run along the flow both cool it better.
import { open, snap, idle, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalfan");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solve = async () => {
  await pg.click('#sim-tools [data-s="solve"]');
  await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
  await pg.waitForTimeout(500);
  return sim();
};
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForTimeout(200);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "5");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// FAN-1: still air on every open surface
await pg.click('#sim-tools [data-s="conv"]');
await pg.waitForTimeout(200);
await pg.check('#sim-pm [data-k="all"]');
await pg.selectOption('#sim-pm [data-k="film"]', "nat");
await pg.waitForTimeout(150);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const still = await solve();
check("FAN-1", !still.error && still.thermal?.max > 60, "5 W in a 100 × 20 × 20 aluminium block cooled only by still air runs hot", { error: still.error, max: still.thermal?.max }, await snap(pg, "still-air"));

// FAN-2: the Forced air button, a fan's flow typed (36 m³/h through 50 cm² = 2 m/s), flow along the block
await pg.click('#sim-tools [data-s="fan"]');
await pg.waitForTimeout(200);
await pg.check('#sim-pm [data-k="all"]');
await pg.check('#sim-pm [data-k="fanon"]');
await pg.waitForTimeout(150);
await pg.fill('#sim-pm [data-q="fanq"]', "36");
await pg.press('#sim-pm [data-q="fanq"]', "Tab");
await pg.fill('#sim-pm [data-q="fana"]', "50");
await pg.press('#sim-pm [data-q="fana"]', "Tab");
await pg.waitForTimeout(200);
const fanv = await pg.evaluate(() => document.querySelector('#sim-pm [data-v="fanv"]')?.textContent ?? "");
const [b0, b1] = await pg.evaluate(() => [window.__sv.viewer.parts[0].data.bboxMin, window.__sv.viewer.parts[0].data.bboxMax]);
const ext = [0, 1, 2].map(i => b1[i] - b0[i]), long = ext.indexOf(Math.max(...ext)), short = ext.findIndex((v, i) => i !== long);
await pg.selectOption('#sim-pm [data-k="flow"]', "+" + "XYZ"[long]);
await pg.waitForTimeout(150);
const panel = await snap(pg, "fan-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// the still air item is switched off, so only the fan cools the block
await pg.evaluate(() => { const r = [...document.querySelectorAll("#sim-tree .sim-cool .sim-row")].find(x => !/m\/s/.test(x.textContent)); r?.querySelector('[data-a="toggle"]')?.click(); });
await pg.waitForTimeout(300);
const row = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-row")].map(r => r.textContent).find(x => /m\/s/.test(x)) ?? "");
const along = await solve();
check("FAN-2", /^2 m\/s/.test(fanv) && /2 m\/s/.test(row) && !along.error && along.thermal.max < still.thermal.max - 10 && Math.abs(along.thermal.out.reduce((a, b) => a + b, 0) - 5) < 0.05,
  "a fan's flow through an opening gives 2 m/s; blowing along the block cools it far below still air, and all 5 W leave through the air", { fanv, row, max: along.thermal?.max, out: along.thermal?.out, panel }, await snap(pg, "along"));

// FAN-3: the same fan blowing across the block: its long faces are 20 mm in the flow, not 100, so they cool better
await pg.evaluate(() => { const r = [...document.querySelectorAll("#sim-tree .sim-row")].find(x => /m\/s/.test(x.textContent)); const b = r?.querySelector('[data-a="edit"]'); if (b) b.click(); else r?.click(); });
await pg.waitForSelector('#sim-pm [data-k="flow"]');
await pg.selectOption('#sim-pm [data-k="flow"]', "+" + "XYZ"[short]);
await pg.waitForTimeout(150);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const across = await solve();
const h = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="hnat"]')?.textContent ?? "");
check("FAN-3", !across.error && across.thermal.max < along.thermal.max - 1 && /W\/\(m²·K\)/.test(h), "blowing across the block cools it better than along it; the results show the mean film coefficient", { along: along.thermal?.max, across: across.thermal?.max, h }, await snap(pg, "across"));

// FAN-4: translated
await pg.click("#lang-btn");
await pg.waitForTimeout(400);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#sim-tools *, #tab-sim *")].filter(e => !e.children.length && !e.closest("[translate=no]") && e.offsetParent).map(e => e.textContent.trim()).filter(t => /[A-Za-z]{4}/.test(t) && !/m\/s|W\/|°C/.test(t)));
check("FAN-4", ru.length === 0, "the Thermal bar and the study are translated", { ru }, await snap(pg, "ru"));
await pg.click("#lang-btn");
await finish(browser, pg);
