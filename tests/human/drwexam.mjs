// Drawings exam (test list /mnt/project-files/tests/drawings-tests.md): section views, hole callouts,
// geometric tolerances and following model edits, all by hand on the packaged app. The part comes from
// drwpart.mjs (made by hand too), saved in HT_MODELS.
import { open, snap, check, finish, idle, openFiles, clickAt, dblAt } from "./lib.mjs";
import { makePlate } from "./drwpart.mjs";
import { makeFlange } from "./drwpart2.mjs";
import { existsSync } from "node:fs";
const MODELS = process.env.HT_MODELS || "/mnt/project-files/tests/drw";
const { browser, pg } = await open("drwexam");
const PART = process.env.PART || "Plate";
if (existsSync(`${MODELS}/${PART}.mcadprt`)) await openFiles(pg, [`${MODELS}/${PART}.mcadprt`]);
else if (PART === "Plate") await makePlate(pg);
else await makeFlange(pg);
await idle(pg);

export const drw = {
  doc: () => pg.evaluate(() => JSON.parse(JSON.stringify(window.__sv.drw.doc()))),
  views: async () => (await drw.doc()).sheets[0].views,
  annots: async () => (await drw.doc()).sheets[0].annots ?? [],
  /** A view's placement; `at(u, v)` = the sheet point of view point (u, v) (the box is centred on x, y). */
  pl: id => pg.evaluate(id => { const p = window.__sv.drw.placement(id); return p && { x: p.x, y: p.y, s: p.s, box: p.box }; }, id).then(p => p && { ...p, at: (u, v) => [p.x + (u - (p.box[0] + p.box[2]) / 2) * p.s, p.y + (v - (p.box[1] + p.box[3]) / 2) * p.s] }),
  sp: (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]),
  hit: id => pg.evaluate(id => window.__sv.drw.hit(id), id),
  texts: () => pg.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t").map(p => p.s)),
  ready: () => pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 180000 }),
  mode: () => pg.evaluate(() => window.__sv.drw.mode()),
  status: () => pg.evaluate(() => document.querySelector("#drw .drw-status, #drw [role=status]")?.textContent ?? ""),
};
const cmdA = async a => {
  const tab = await pg.evaluate(a => document.querySelector(`#drw .drw-cmds [data-a="${a}"]`)?.closest("[data-cpane]")?.dataset.cpane ?? null, a);
  if (tab) await pg.click(`#drw [data-ctab="${tab}"]`);
  await pg.click(`#drw .drw-cmds [data-a="${a}"]`);
};
const menuItem = async (a, sel) => { await cmdA(a); await pg.waitForTimeout(150); await pg.click(`#drw .drw-cmds ${sel}`); };
const tool = async k => {
  await pg.click('#drw [data-ctab="annot"]');
  const menu = await pg.evaluate(k => { const b = document.querySelector(`#drw .drw-cmds [data-an="${k}"]`); return b?.closest(".drw-menu") ? b.closest(".drw-dd").querySelector("button").dataset.a : null; }, k);
  if (menu) await pg.click(`#drw .drw-cmds [data-a="${menu}"]`);
  await pg.click(`#drw .drw-cmds [data-an="${k}"]`);
};
const at = async (x, y) => drw.sp(x, y);
const click = async (x, y) => { await clickAt(pg, await at(x, y)); await pg.waitForTimeout(250); };
export { cmdA, menuItem, tool, click };

// ---- the drawing: New drawing, Standard 3 views
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 180000 });
await cmdA("std3");
await drw.ready();
await pg.waitForTimeout(800);
const vs = await drw.views();
console.log(JSON.stringify(vs.map(v => ({ id: v.id, orient: v.orient, parent: v.parent, side: v.side, x: v.x, y: v.y, scale: v.scale }))));
for (const v of vs) console.log(v.id, JSON.stringify(await drw.pl(v.id)));
await snap(pg, "std3");
const stage = process.env.STAGE || "all";
globalThis.T = { pg, drw, snap, check, cmdA, menuItem, tool, click, at, idle, clickAt, dblAt, vs };
for (const part of ["a", "b", "c", "d", "e"]) if ((stage === "all" ? (PART === "Flange") === (part === "e") : stage.includes(part))) await (await import(`./drwexam-${part}.mjs`)).default(globalThis.T);
await finish(browser, pg);
