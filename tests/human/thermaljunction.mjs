// Junction temperatures by hand (FRS-thermal FR-TBRD-021): a board study reports each package part's temperature; the
// transistor Q2, whose package temperature is a junction, shows its case (marked) until its Rjc is typed in the Parts
// table of the Heat from package load, then case + power × Rjc after solving again.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermaljunction");
const fx = resolve("tests/fixtures/thermal");

const solve = async () => {
  await pg.click('#sim-tools [data-s="solve"]');
  await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 400000 });
  await pg.waitForTimeout(500);
};
const temps = () => pg.evaluate(() => ({ error: window.__sv.sim.state().error, parts: window.__sv.sim.state().thermal?.parts ?? [],
  rows: [...document.querySelectorAll("#sim-tree .sim-ptemps tr[data-ptemp]")].map(r => [r.dataset.ptemp, r.querySelector('[data-v="pttemp"]').textContent, r.querySelector('[data-v="ptkind"]').textContent]),
  note: !!document.querySelector('#sim-tree [data-v="ptnote"]') }));

// JUN-1: board STEP + package, Simulate, solve: Q2 is listed as Case*, the note says how to get the junction.
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
await pg.selectOption('#sim-tree select[data-k="passes"]', "1");
await solve();
const a = await temps();
await pg.evaluate(() => document.querySelector("#sim-tree .sim-ptemps")?.scrollIntoView());
check("JUN-1", !a.error && a.rows.length === 6 && a.rows.find(r => r[0] === "Q2")?.[2] === "Case*" && a.note, "Part temperatures lists every part; Q2 shows its case only, marked, with a note", a, await snap(pg, "case-only"));

// JUN-2: type Rjc 2.5 K/W for Q2 in the Heat from package panel, OK, solve again: Q2 = case + 4.4 W × 2.5 K/W.
await pg.click('#sim-tree .sim-row[data-id="l1"] [data-a="edit"]');
await pg.waitForSelector('#sim-pm .sim-pkparts tr[data-pk="3"] input[data-q="pkrjc"]');
await pg.click('#sim-pm .sim-pkparts tr[data-pk="3"] input[data-q="pkrjc"]');
await pg.keyboard.type("2.5");
await pg.keyboard.press("Tab");
const panel = await snap(pg, "rjc-typed");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(300);
await solve();
const b = await temps(), q = b.parts.find(x => x.name === "Q2");
await pg.evaluate(() => document.querySelector("#sim-tree .sim-ptemps")?.scrollIntoView());
check("JUN-2", !b.error && q?.kind === "junction" && Math.abs(q.t - q.body - 4.4 * 2.5) < 1e-6 && b.rows.find(r => r[0] === "Q2")?.[2] === "Junction" && !b.note,
  "with Rjc typed, Q2 reports its junction: the case maximum plus 4.4 W × 2.5 K/W = 11 K", { q, rows: b.rows, panel }, await snap(pg, "junction"));
await finish(browser, pg);
