// Electrolytics beside a hot part by hand (FRS-thermal FR-TBRD-023): the board map's problems list warns about a
// capacitor within 10 mm of a part over 1 W, a click on the warning selects it, and a board study made from the map
// says the same after its solve.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalnear");
const fx = resolve("tests/fixtures/thermal");

// NEAR-1: board STEP + package; the Thermal tab lists C13 beside R20 and C12 beside V3.
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.click("#t-thermal");
await pg.waitForTimeout(300);
const items = await pg.evaluate(() => [...document.querySelectorAll("#th-side .th-list li")].map(li => li.innerText));
const near = items.filter(x => / mm from /.test(x));
check("NEAR-1", near.length === 2 && /^C13: .* mm from R20 \(3\.4 W\)/.test(near[0]) && /^C12: 10 mm from V3/.test(near[1]),
  "the problems list warns about C13 5 mm from R20 and C12 10 mm from the valve V3, with how much their surfaces differ", { items }, await snap(pg, "problems"));

// NEAR-2: a click on the C13 warning selects C13.
await pg.click('#th-side .th-list li:has-text("mm from R20")');
await pg.waitForTimeout(300);
const sel = await pg.evaluate(() => window.__sv.thermal.state().sel);
const selName = await pg.evaluate(() => document.querySelector("#th-side tr.sel td span")?.textContent ?? document.querySelector("#th-card")?.innerText ?? "");
check("NEAR-2", sel === 6, "a click on the warning selects the capacitor", { sel, selName }, await snap(pg, "selected"));

// NEAR-3: Simulate makes a board study; after the solve its results warn about C13.
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
await pg.selectOption('#sim-tree select[data-k="passes"]', "1");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 400000 });
await pg.waitForTimeout(500);
const res = await pg.evaluate(() => ({ error: window.__sv.sim.state().error, li: [...document.querySelectorAll('#sim-tree [data-v="tnear"] li')].map(e => e.textContent) }));
await pg.evaluate(() => document.querySelector('#sim-tree [data-v="tnear"]')?.scrollIntoView());
check("NEAR-3", !res.error && res.li.some(x => /^C13: .* mm from R20/.test(x)), "the board study's results warn about C13 next to R20 after the solve", res, await snap(pg, "study"));
await finish(browser, pg);
