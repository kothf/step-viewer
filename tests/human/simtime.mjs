// Times a static study of the bracket in the packaged app (not a test): node tests/human/simtime.mjs with dist/step-viewer
// served on :8123. Q = page query (default "&sw", "&sw&simthreads=1" for one thread), PASSES (5), HT_PARTS = folder
// with 1-01.4-bracket.mcadprt. Prints the time of every step the status bar shows. The study holds a big face, which
// bench/simstatic.bench.ts does not, so the two together show where the time goes.
import { open, idle, screenOf, clickAt, openFiles, boreSpot } from "./lib.mjs";
const Y = [0, 1, 0];
const { browser, pg } = await open("brtime", process.env.Q ?? "&sw");
await pg.waitForTimeout(3000); await pg.reload(); await pg.waitForFunction(() => window.__sv);
console.log("isolated", await pg.evaluate(() => crossOriginIsolated), "cores", await pg.evaluate(() => navigator.hardwareConcurrency));
async function view(keys = []) { await pg.mouse.move(700, 480); await pg.keyboard.press("Control+7"); await pg.waitForTimeout(900); for (const k of keys) { await pg.keyboard.press(k); await pg.waitForTimeout(450); } await pg.keyboard.press("f"); await pg.waitForTimeout(700); }
await openFiles(pg, [`${process.env.HT_PARTS || "/mnt/project-files/leuenberger"}/1-01.4-bracket.mcadprt`]);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]'); await pg.waitForSelector("#mat-dlg[open]"); await pg.fill("#mat-q", "S235"); await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li"); await pg.click('#mat-dlg [data-a="ok"]'); await idle(pg);
await pg.click('#sim-tools [data-s="new"]'); await pg.waitForTimeout(500); await pg.keyboard.press("Escape");
await pg.click('#sim-tools [data-s="fixed"]'); await view(["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]);
await clickAt(pg, await screenOf(pg, [30, 2, 0])); await pg.waitForTimeout(250); await pg.click("#sim-pm .pm-ok"); await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]'); await view();
await clickAt(pg, await screenOf(pg, await boreSpot(pg, [32.5, 0, 15], Y, 3, -4.5, -1.5))); await pg.waitForTimeout(250);
await pg.uncheck('#sim-pm [data-k="normal"]');
for (const [k, v] of [[0, 0], [1, 80], [2, -200]]) { await pg.fill(`#sim-pm [data-n="c${k}"]`, String(v)); await pg.keyboard.press("Tab"); }
await pg.click("#sim-pm .pm-ok"); await pg.waitForTimeout(400); await view();
await pg.selectOption('#sim-tree [data-k="passes"]', process.env.PASSES ?? "5"); await pg.fill('#sim-tree [data-k="tol"]', "0"); await pg.keyboard.press("Tab"); await pg.waitForTimeout(300);
const t0 = Date.now(); let last = "", lt = t0;
await pg.click('#sim-tools [data-s="solve"]');
for (;;) {
  const s = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { run: s.running, done: s.done, err: s.error, n: s.passes?.length ?? 0, text: document.querySelector("#st-sim .st-sim-t")?.textContent ?? "", threads: s.threads }; });
  if (s.text !== last) { const n = Date.now(); if (last) console.log(((n - lt) / 1000).toFixed(1).padStart(6), last); last = s.text; lt = n; }
  if (!s.run && (s.done || s.err)) { console.log("total", ((Date.now() - t0) / 1000).toFixed(1), "s, passes", s.n, "threads", s.threads, s.err ?? ""); break; }
  await pg.waitForTimeout(100);
}
console.log(JSON.stringify(await pg.evaluate(() => { const s = window.__sv.sim.state(); return { e: s.passes.map(p => p.energy), maxVm: s.maxVm, maxU: s.maxU, r: s.reactions ?? s.balance }; })));
await browser.close();
