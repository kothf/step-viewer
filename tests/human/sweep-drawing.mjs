// Sweep: every drawing command clicked on a sheet with three views, nothing selected; lists those after which nothing visible changed.
import { open, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("sweepd");
await makeBlock(pg, 100, 60, 20);
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
await pg.click('#drw [data-ctab="layout"]').catch(() => {});
await pg.click('#drw .drw-cmds [data-a="std3"]');
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
const sig = () => pg.evaluate(() => {
  const vis = e => e && e.offsetParent !== null;
  return JSON.stringify({
    dlg: [...document.querySelectorAll("dialog[open]")].map(d => d.id),
    toasts: [...document.querySelectorAll("#toasts .toast")].map(t => t.dataset.msg),
    menus: [...document.querySelectorAll(".drw-menu, .mc-menu")].filter(vis).length,
    status: document.querySelector("#drw .drw-status")?.textContent ?? "",
    props: (document.querySelector("#drw .drw-props")?.textContent ?? "").slice(0, 60),
    pressed: [...document.querySelectorAll("#drw [aria-pressed=true], #drw .on")].length,
    annots: window.__sv.drw.doc().sheets.flatMap(s => s.annots ?? []).length,
    views: window.__sv.drw.doc().sheets.flatMap(s => s.views).length, sheets: window.__sv.drw.doc().sheets.length,
  });
});
const out = [];
for (const tab of ["layout", "annot", "sketch"]) {
  await pg.click(`#drw [data-ctab="${tab}"]`);
  const btns = await pg.$$eval(`#drw [data-cpane="${tab}"] button`, els => els.filter(e => e.offsetParent).map(e => ({ a: e.dataset.a, an: e.dataset.an, l: e.textContent.trim().slice(0, 30), dis: e.disabled })));
  for (const b of btns) {
    if (b.dis || b.a === "file" || b.a === "back") continue;
    await pg.click(`#drw [data-ctab="${tab}"]`);
    // Clear toasts so a repeated message counts.
    await pg.evaluate(() => document.querySelectorAll("#toasts .toast").forEach(t => t.remove()));
    const a = await sig();
    const sel = b.a ? `#drw [data-cpane="${tab}"] [data-a="${b.a}"]` : `#drw [data-cpane="${tab}"] [data-an="${b.an}"]`;
    try { await pg.click(sel, { timeout: 2000 }); } catch (e) { out.push(`ERR ${tab} ${b.l}`); continue; }
    await pg.waitForTimeout(600);
    const B = await sig();
    const A = JSON.parse(a), C = JSON.parse(B);
    const diff = Object.keys(A).filter(k => JSON.stringify(A[k]) !== JSON.stringify(C[k]));
    out.push(`${diff.length ? "ok  " : "NONE"} ${tab} | ${b.l} (${b.a ?? b.an}) | ${diff.map(k => k + "=" + JSON.stringify(C[k]).slice(0, 80)).join(" ; ")}`);
    console.error(out.at(-1));
    for (let i = 0; i < 2; i++) await pg.keyboard.press("Escape");
    await pg.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
    if (C.views !== A.views || C.annots !== A.annots || C.sheets !== A.sheets) await pg.keyboard.press("Control+z");
  }
}
console.log(out.join("\n"), "\nERRORS", pg.errors.slice(0, 10));
await browser.close();
