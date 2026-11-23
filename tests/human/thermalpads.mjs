// Finer around the pads (FRS-thermal FR-TBRD-003, 1.715.0): a board's own study puts each part's board share on its
// footprint; the cells under those footprints start two degrees higher and the board's cells follow its thickness,
// so the temperature peak over a part's pads is resolved instead of smeared over a 5 mm cell.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalpads");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);

// TP-1: two passes; the first already runs degree 4 under the footprints, the heat balance closes.
await pg.selectOption('#sim-tree select[data-k="passes"]', "2");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 900000 });
await pg.waitForTimeout(600);
const s = await pg.evaluate(() => window.__sv.sim.state());
const out = (s.thermal?.out ?? []).reduce((a, x) => a + x, 0);
const passes = s.passes.map(q => ({ p: q.p, cells: q.cells, dofs: q.dofs, ms: q.ms }));
check("TP-1", !s.error && passes[0]?.p === 4 && passes[1]?.p === 5 && Math.abs(out - 29.17) < 0.05 && s.thermal.max > s.thermal.min,
  "The board study starts the cells under the parts' footprints two degrees higher: the first pass is degree 4 there, the second 5, and all 29.17 W leave", { error: s.error, passes, out, max: s.thermal?.max }, await snap(pg, "pads-solved"));

// TP-2: the hottest point sits on a part or right under one, not between parts.
const hot = s.thermal?.hot?.temps?.[0];
check("TP-2", !!hot && hot.t > s.thermal.max - 0.5, "The hottest point is where the study's highest temperature is", { hot, max: s.thermal?.max }, await snap(pg, "pads-hot"));
await finish(browser, pg);
