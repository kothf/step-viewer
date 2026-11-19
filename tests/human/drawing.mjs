// Drawing features of the gap list, by hand: the format painter (D1) and aligning dimensions (D2).
import { open, snap, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("drawing");
await makeBlock(pg, 100, 60, 20);
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
const cmdA = async a => {
  const tab = await pg.evaluate(a => document.querySelector(`#drw .drw-cmds [data-a="${a}"]`)?.closest("[data-cpane]")?.dataset.cpane ?? null, a);
  if (tab) await pg.click(`#drw [data-ctab="${tab}"]`);
  await pg.click(`#drw .drw-cmds [data-a="${a}"]`);
};
await cmdA("std3");
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
// Two dimensions by hand with Smart dimension on the first view: its top edge and its left edge.
const pl = await pg.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0], p = window.__sv.drw.placement(v.id); return { x: p.x, y: p.y, s: p.s, box: p.box }; });
const sp = (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]);
// The front view of the 100 × 20 block: its top edge 10 above the centre, its left edge 50 left of it.
const hw = 50 * pl.s, hh = 10 * pl.s;
await pg.click('#drw [data-ctab="annot"]');
for (const [edge, place] of [[[pl.x + hw * 0.4, pl.y + hh], [pl.x, pl.y + hh + 12]], [[pl.x - hw, pl.y], [pl.x - hw - 12, pl.y]]]) {
  await pg.click('#drw .drw-cmds [data-a="dim"]');
  await pg.mouse.click(...(await sp(...edge)));
  await pg.waitForTimeout(250);
  await pg.mouse.click(...(await sp(...place)));
  await pg.waitForTimeout(400);
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(200);
}
await pg.waitForTimeout(800);
const dims = () => pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).filter(a => a.t === "dim").map(a => ({ id: a.id, view: a.view, k: a.k, prec: a.prec, ends: a.ends, pos: a.pos })));
/** The screen centre of an annotation's box. */
const centre = id => pg.evaluate(id => {
  const b = window.__sv.drw.hit(id);
  if (!b) return null;
  const [x0, y0] = window.__sv.drw.sheetPt(b[0], b[1]), [x1, y1] = window.__sv.drw.sheetPt(b[2], b[3]);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}, id);
const d0 = await dims();
const img0 = await snap(pg, "two-dims");
if (d0.length < 2) { check("D1", false, "two dimensions to start from", { d0 }, img0); 
// D2: a third dimension on the bottom edge, placed high above; ⇉ on the first, click the third: same line.
await pg.click('#drw .drw-cmds [data-a="dim"]');
await pg.mouse.click(...(await sp(pl.x - hw * 0.4, pl.y - hh)));
await pg.waitForTimeout(250);
await pg.mouse.click(...(await sp(pl.x - hw * 0.3, pl.y + hh + 30)));
await pg.waitForTimeout(400);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const d3 = await dims(), c = d3.find(x => !d0.some(y => y.id === x.id));
const top = d3.find(x => x.id === a.id);
await pg.mouse.click(...(await centre(a.id)));
await pg.waitForTimeout(300);
await pg.click('#drw [data-a="dalign"]');
await pg.waitForTimeout(200);
if (c) await pg.mouse.click(...(await centre(c.id)));
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const c2 = c && (await dims()).find(x => x.id === c.id);
const img3 = await snap(pg, "aligned");
check("D2-align", !!c && c.k === "h" && Math.abs(c.pos[1] - top.pos[1]) > 5 && Math.abs(c2.pos[1] - top.pos[1]) < 1e-6, "select a dimension, ⇉, click another horizontal one: it moves onto the same line", { top: top.pos, c, c2 }, img3);
// Space evenly from the view's panel: rows 10 and 18 sheet mm off the outline, the vertical one 10 mm left.
await pg.keyboard.press("Escape");
await pg.locator("#drw .drw-tree").getByText("Drawing View1", { exact: true }).click();
await pg.waitForTimeout(300);
await pg.click('#drw .drw-props [data-a="dspace"]');
await pg.waitForTimeout(500);
const d4 = await dims();
const img4 = await snap(pg, "spaced");
const ys = d4.filter(x => x.k === "h").map(x => x.pos[1]).sort((p, q) => p - q), xv = d4.find(x => x.k === "v")?.pos[0];
check("D2-space", Math.abs(ys[0] - (pl.box[3] + 10 / pl.s)) < 1e-6 && Math.abs(ys[1] - (pl.box[3] + 18 / pl.s)) < 1e-6 && Math.abs(xv - (pl.box[0] - 10 / pl.s)) < 1e-6, "Space dimensions evenly puts the two top dimensions 10 and 18 mm off the view and the side one 10 mm", { ys, xv, s: pl.s }, img4);
await finish(browser, pg); process.exit(0); }

// D1: select the first dimension, 3 decimals and open arrowheads, then 🖌 and click the second: it takes both.
const [a, b] = d0;
await pg.mouse.click(...(await centre(a.id)));
await pg.waitForTimeout(300);
await pg.selectOption('#drw .drw-props select[data-d="prec"]', "3");
await pg.waitForTimeout(300);
const ends = pg.locator('#drw .drw-props select[data-d="ends"]');
if (await ends.count()) { await ends.selectOption("open"); await pg.waitForTimeout(300); }
await pg.click('#drw [data-a="fpaint"]');
await pg.waitForTimeout(200);
const status = await pg.evaluate(() => document.querySelector("#drw .drw-status")?.textContent ?? "");
await pg.mouse.click(...(await centre(b.id)));
await pg.waitForTimeout(500);
const d1 = await dims();
const img1 = await snap(pg, "format-painted");
const bb = d1.find(x => x.id === b.id);
check("D1", bb.prec === 3 && bb.ends === "open" && /Format painter/.test(status), "select a dimension, 🖌, click another: it gets the same decimals and arrowheads", { status, before: b, after: bb }, img1);
// The painter stays on for more clicks; Esc ends it, and Ctrl+Z takes the paint back.
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const off = await pg.evaluate(() => !document.querySelector("#drw svg.drw-painting"));
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(400);
const d2 = (await dims()).find(x => x.id === b.id);
check("D1-undo", off && d2.prec === b.prec && d2.ends === b.ends, "Esc ends the painter and Ctrl+Z undoes the paint", { off, d2 });

// D2: a third dimension on the bottom edge, placed high above; ⇉ on the first, click the third: same line.
await pg.click('#drw .drw-cmds [data-a="dim"]');
await pg.mouse.click(...(await sp(pl.x - hw * 0.4, pl.y - hh)));
await pg.waitForTimeout(250);
await pg.mouse.click(...(await sp(pl.x - hw * 0.3, pl.y + hh + 30)));
await pg.waitForTimeout(400);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const d3 = await dims(), c = d3.find(x => !d0.some(y => y.id === x.id));
const top = d3.find(x => x.id === a.id);
await pg.mouse.click(...(await centre(a.id)));
await pg.waitForTimeout(300);
await pg.click('#drw [data-a="dalign"]');
await pg.waitForTimeout(200);
if (c) await pg.mouse.click(...(await centre(c.id)));
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const c2 = c && (await dims()).find(x => x.id === c.id);
const img3 = await snap(pg, "aligned");
check("D2-align", !!c && c.k === "h" && Math.abs(c.pos[1] - top.pos[1]) > 5 && Math.abs(c2.pos[1] - top.pos[1]) < 1e-6, "select a dimension, ⇉, click another horizontal one: it moves onto the same line", { top: top.pos, c, c2 }, img3);
// Space evenly from the view's panel: rows 10 and 18 sheet mm off the outline, the vertical one 10 mm left.
await pg.keyboard.press("Escape");
await pg.locator("#drw .drw-tree").getByText("Drawing View1", { exact: true }).click();
await pg.waitForTimeout(300);
await pg.click('#drw .drw-props [data-a="dspace"]');
await pg.waitForTimeout(500);
const d4 = await dims();
const img4 = await snap(pg, "spaced");
const ys = d4.filter(x => x.k === "h").map(x => x.pos[1]).sort((p, q) => p - q), xv = d4.find(x => x.k === "v")?.pos[0];
check("D2-space", Math.abs(ys[0] - (pl.box[3] + 10 / pl.s)) < 1e-6 && Math.abs(ys[1] - (pl.box[3] + 18 / pl.s)) < 1e-6 && Math.abs(xv - (pl.box[0] - 10 / pl.s)) < 1e-6, "Space dimensions evenly puts the two top dimensions 10 and 18 mm off the view and the side one 10 mm", { ys, xv, s: pl.s }, img4);
await finish(browser, pg);
