// Times the amp board's own thermal study in the packaged app (not a test): node tests/human/thtime.mjs with dist/step-viewer
// served on :8123. SAVE = a folder to save the assembly in first (NOSOLVE = only that). Q = page query (default "&sw"), PASSES (study default when unset), WARMUP = a warm-up (transient) of the default hour. Prints the time of every step the
// status bar shows, then the passes' hottest temperatures and heat balance, so runs can be compared for speed and sameness.
import { resolve } from "node:path";
import { open, openFiles, saveModel } from "./lib.mjs";
const { browser, pg } = await open("thtime", process.env.Q ?? "&sw");
await pg.waitForTimeout(3000); await pg.reload(); await pg.waitForFunction(() => window.__sv);
console.log("isolated", await pg.evaluate(() => crossOriginIsolated), "cores", await pg.evaluate(() => navigator.hardwareConcurrency));
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
if (process.env.SAVE) { console.log("saved", await saveModel(pg, process.env.SAVE, "amp-board")); if (process.env.NOSOLVE) { await browser.close(); process.exit(0); } }
if (process.env.PASSES) { await pg.selectOption('#sim-tree [data-k="passes"]', process.env.PASSES); await pg.waitForTimeout(300); }
if (process.env.WARMUP) { await pg.click('#sim-tools [data-s="transient"]'); await pg.waitForTimeout(400); }
const t0 = Date.now(); let last = "", lt = t0;
await pg.click('#sim-tools [data-s="solve"]');
for (;;) {
  const s = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { run: s.running, done: s.done, err: s.error, n: s.passes?.length ?? 0, text: document.querySelector("#st-sim .st-sim-t")?.textContent ?? "", threads: s.threads }; });
  if (s.text !== last) { const n = Date.now(); if (last) console.log(((n - lt) / 1000).toFixed(1).padStart(6), last); last = s.text; lt = n; }
  if (!s.run && (s.done || s.err)) { console.log("total", ((Date.now() - t0) / 1000).toFixed(1), "s, passes", s.n, "threads", s.threads, s.err ?? ""); break; }
  await pg.waitForTimeout(100);
}
console.log(JSON.stringify(await pg.evaluate(() => { const s = window.__sv.sim.state(); return { max: s.passes.map(p => p.max ?? p.thermal?.max), th: { applied: s.thermal?.applied, out: s.thermal?.out, comps: s.thermal?.comps?.map(c => +c.max.toFixed(6)) } }; })));
await browser.close();
