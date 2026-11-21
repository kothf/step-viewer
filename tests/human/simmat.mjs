// A material for one study only, by hand (FRS-structural FR-SMAT-003): a steel plate held on a side and pushed
// down is solved, then solved again as aluminium in this study alone. The part keeps its steel.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simmat");
await makeBlock(pg, 40, 20, 5);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(800);

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const wide = () => pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
const mats = () => pg.evaluate(() => ({ part: document.querySelector('#sim-tree .sim-mat [data-a="mat"]')?.textContent ?? "", study: document.querySelector('#sim-tree .sim-smat [data-a="smat"]')?.textContent ?? "", own: !!document.querySelector('#sim-tree .sim-smat .btn.own'), note: document.querySelector("#sim-tree .sim-mat .sim-note")?.textContent ?? "", doc: window.__sv.model.store.doc.material?.name ?? null }));
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-8, 3, 5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "200");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), m1 = await mats();
check("SM-1", !s1.error && s1.maxU > 0 && /S235/.test(m1.part) && /As the part/.test(m1.study) && !m1.own && (await wide()) <= 0,
  "the steel plate is solved; under Material the study says it takes the part's material", { error: s1.error, maxU: s1.maxU, mats: m1, wide: await wide() }, await snap(pg, "steel"));

// another material for this study only
await pg.click('#sim-tree .sim-smat [data-a="smat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.waitForTimeout(300);
const pickedName = await pg.evaluate(() => document.querySelector("#mat-dlg .mat-list li")?.textContent ?? "");
await pg.click("#mat-dlg .mat-list li");
const shot = await snap(pg, "picker");
await pg.click('#mat-dlg [data-a="ok"]');
await pg.waitForTimeout(500);
const s2 = await sim(), m2 = await mats();
check("SM-2", s2.stale && m2.own && /6061/.test(m2.study) && /S235/.test(m2.part) && /S235/.test(m2.doc ?? "") && /^E 6\d/.test(m2.note) && (await wide()) <= 0,
  "In this study: an aluminium alloy is picked; the study shows it and its modulus, the part's own material stays steel, and the results are out of date", { stale: s2.stale, pickedName, mats: m2, wide: await wide() }, shot);

await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
const ratio = s3.maxU / s1.maxU;
check("SM-3", !s3.error && ratio > 2.7 && ratio < 3.3,
  "solved as aluminium the plate bends about three times as far as in steel (210 GPa against about 69 GPa)", { error: s3.error, maxU: [s1.maxU, s3.maxU], ratio }, await snap(pg, "aluminium"));

// back to the part's material
await pg.click('#sim-tree .sim-smat [data-a="smat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.click('#mat-dlg [data-a="none"]');
await pg.waitForTimeout(500);
const m4 = await mats();
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim();
check("SM-4", !m4.own && /As the part/.test(m4.study) && !s4.error && Math.abs(s4.maxU / s1.maxU - 1) < 1e-6,
  "No material in the picker goes back to the part's steel, and the first result comes back", { mats: m4, error: s4.error, maxU: [s1.maxU, s4.maxU] }, await snap(pg, "back"));
await finish(browser, pg);
