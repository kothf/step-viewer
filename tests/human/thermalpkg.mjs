// A study's result as a thermal package by hand (FRS-thermal FR-TREP-010): a board study is solved, its Thermal
// package button saves a zip, and that zip opens again on the board's STEP as a thermal map whose parts match.
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalpkg");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
await pg.selectOption('#sim-tree select[data-k="passes"]', "2");
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(600);

// PKG-1: the Thermal package button under the results saves a zip of the package layout
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('#sim-tree [data-a="tpkg"]')]);
const file = join(tmpdir(), `ht-${dl.suggestedFilename().replace(/[^\w.-]+/g, "_")}`);
await dl.saveAs(file);
const s = await pg.evaluate(() => { const st = window.__sv.sim.state(); return { pkg: st.pkg, comps: st.thermal?.comps?.map(c => [c.name, c.max]) }; });
check("PKG-1", s.pkg?.files.length === 5 && s.pkg.parts.length === 6 && /-thermal\.zip$/.test(dl.suggestedFilename()),
  "Thermal package saves a zip with the mesh, the heat-source table, the picture, the manifest and a README, one part per package part", { name: dl.suggestedFilename(), files: s.pkg?.files, parts: s.pkg?.parts }, await snap(pg, "solved"));

// PKG-2: the package opens again on the board's STEP: every part matched, R14 as hot as in the study
const b = await open("thermalpkg-back");
await openFiles(b.pg, [resolve(fx, "amp.step"), file]);
await b.pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await b.pg.waitForTimeout(800);
await b.pg.click("#t-thermal").catch(() => {});
await b.pg.waitForTimeout(300);
const back = await b.pg.evaluate(() => { const st = window.__sv.thermal.state(); return { parts: st.parts, matched: st.matched, missing: st.missing, changed: st.changed, off: st.off, hottest: st.hottest, peak: st.peak, src: document.querySelector('#th-side [data-v="source"]')?.textContent }; });
const r14 = s.comps?.find(c => c[0] === "R14<1>")?.[1];
check("PKG-2", back.parts === 6 && back.missing.length === 0 && back.changed.length === 0 && back.off < 0.5 && /MöbiusCAD/.test(back.src ?? "") && Math.abs((back.peak?.t ?? back.peak ?? 0) - Math.max(...s.comps.map(c => c[1]))) < 0.05,
  "the saved package opens on the board's STEP as a thermal map from MöbiusCAD: every part matched by name and in place, the hottest temperature as in the study", { back, r14 }, await snap(b.pg, "reopened"));
await b.browser.close();
await finish(browser, pg);
