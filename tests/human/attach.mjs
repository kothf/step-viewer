// Half-working features, batch 1, by hand: a datum feature symbol on a dimension and on a tolerance frame, a surface finish
// symbol on a dimension, Ctrl+C / Ctrl+V of a drawing annotation, deleting a dimension takes what sits on it along; and
// Rename / F2 on assembly components (only states, configurations and mates could be renamed).
import { open, snap, check, finish, idle, cmd, clickAt, screenOf, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("attach");
await makeBlock(pg, 100, 60, 20);
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
const cmdA = async a => {
  const tab = await pg.evaluate(a => document.querySelector(`#drw .drw-cmds [data-a="${a}"]`)?.closest("[data-cpane]")?.dataset.cpane ?? null, a);
  if (tab) await pg.click(`#drw [data-ctab="${tab}"]`);
  await pg.click(`#drw .drw-cmds [data-a="${a}"]`);
};
const tool = async k => {
  await pg.click('#drw [data-ctab="annot"]');
  const menu = await pg.evaluate(k => { const b = document.querySelector(`#drw .drw-cmds [data-an="${k}"]`); return b?.closest(".drw-menu") ? b.closest(".drw-dd").querySelector("button").dataset.a : null; }, k);
  if (menu) await pg.click(`#drw .drw-cmds [data-a="${menu}"]`);
  await pg.click(`#drw .drw-cmds [data-an="${k}"]`);
};
await cmdA("std3");
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
await pg.waitForTimeout(800);
const pl = await pg.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0], p = window.__sv.drw.placement(v.id); return { id: v.id, x: p.x, y: p.y, s: p.s }; });
const sp = (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]);
const annots = () => pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).map(a => JSON.parse(JSON.stringify(a))));
const box = id => pg.evaluate(id => window.__sv.drw.hit(id), id);
const centre = async id => { const b = await box(id); return b && sp((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
// The front view of the 100 × 20 block: a dimension on its top edge (the 100), placed above.
const hw = 50 * pl.s, hh = 10 * pl.s;
await pg.click('#drw [data-ctab="annot"]');
await pg.click('#drw .drw-cmds [data-a="dim"]');
await clickAt(pg, await sp(pl.x + hw * 0.4, pl.y + hh));
await pg.waitForTimeout(250);
await clickAt(pg, await sp(pl.x, pl.y + hh + 14));
await pg.waitForTimeout(400);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(500);
const dim = (await annots()).find(a => a.t === "dim");
if (!dim) { check("B1", false, "a dimension to start from", { a: await annots() }, await snap(pg, "no-dim")); await finish(browser, pg); process.exit(0); }
// Datum feature: click the dimension's text, then a place to its right: the datum sits on the dimension.
await tool("datum");
await clickAt(pg, await centre(dim.id));
await pg.waitForTimeout(300);
const hint = await pg.evaluate(() => document.querySelector("#drw .drw-status, #st-hint")?.textContent ?? "");
await clickAt(pg, await sp(pl.x + hw + 14, pl.y + hh + 24));
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const dt = (await annots()).find(a => a.t === "datum");
// The triangle must touch one of the dimension's lines: some filled datum polygon apex/base point lies on a dimension line.
const onLine = dt && await pg.evaluate(([did]) => {
  const prims = window.__sv.drw.prims();
  const tri = prims.filter(p => p.t === "p" && p.fill && p.p.length === 6 && p.layer === "ANNOT");
  const lines = prims.filter(p => p.t === "l" && p.layer === "ANNOT").flatMap(p => { const out = []; for (let i = 0; i + 3 < p.p.length; i += 4) out.push(p.p.slice(i, i + 4)); return out; });
  const dist = (x, y, [x0, y0, x1, y1]) => { const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy, k = L ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L)) : 0; return Math.hypot(x - x0 - k * dx, y - y0 - k * dy); };
  return tri.some(t => { const mx = (t.p[0] + t.p[2]) / 2, my = (t.p[1] + t.p[3]) / 2; return lines.some(l => dist(mx, my, l) < 0.05); });
}, [dt.id]);
const img1 = await snap(pg, "datum-on-dim");
check("B1", dt?.on === dim.id && onLine, "Datum feature clicked on a dimension: the datum is attached to it and its triangle sits on the dimension's line", { on: dt?.on, onLine, hint }, img1);
// Drag the dimension: the datum's triangle follows.
const tri0 = await pg.evaluate(() => JSON.stringify(window.__sv.drw.prims().filter(p => p.t === "p" && p.fill && p.p.length === 6).map(p => p.p.map(x => +x.toFixed(2)))));
const c0 = await centre(dim.id);
await pg.mouse.move(...c0); await pg.mouse.down(); await pg.mouse.move(c0[0], c0[1] - 20); await pg.mouse.move(c0[0], c0[1] - 40); await pg.mouse.up();
await pg.waitForTimeout(600);
const tri1 = await pg.evaluate(() => JSON.stringify(window.__sv.drw.prims().filter(p => p.t === "p" && p.fill && p.p.length === 6).map(p => p.p.map(x => +x.toFixed(2)))));
check("B2", tri0 !== tri1, "dragging the dimension takes the datum's triangle along", {}, await snap(pg, "dim-dragged"));
// A free tolerance frame, then a datum clicked on it.
await tool("gtol");
await clickAt(pg, await sp(pl.x - hw - 30, pl.y + hh + 30));
await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 10000 });
await pg.click("dialog.ad-dlg[open] button[value=ok]");
await pg.waitForTimeout(400);
const g = (await annots()).find(a => a.t === "gtol");
let dg = null;
if (g) {
  await tool("datum");
  await clickAt(pg, await centre(g.id));
  await pg.waitForTimeout(300);
  await clickAt(pg, await sp(pl.x - hw - 20, pl.y + hh + 45));
  await pg.waitForTimeout(500);
  await pg.keyboard.press("Escape");
  dg = (await annots()).find(a => a.t === "datum" && a.on === g.id);
}
check("B3", !!g && !!dg && dg.letter !== dt?.letter, "Datum feature clicked on a tolerance frame attaches to the frame (next letter)", { g: !!g, dg }, await snap(pg, "datum-on-frame"));
// Surface finish clicked on the dimension.
await tool("surf");
await clickAt(pg, await centre(dim.id));
await pg.waitForTimeout(300);
await clickAt(pg, await sp(pl.x - hw * 0.5, pl.y + hh + 40));
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const sf = (await annots()).find(a => a.t === "surf");
check("B4", sf?.on === dim.id, "Surface finish clicked on a dimension attaches to it", { sf }, await snap(pg, "surf-on-dim"));
// Ctrl+C / Ctrl+V: select the frame's datum, copy, move the pointer, paste.
const n0 = (await annots()).length;
if (dg) {
  await clickAt(pg, await centre(dg.id));
  await pg.keyboard.press("Control+c");
  await pg.waitForTimeout(200);
}
const g2 = g && await centre(g.id);
// A note copied and pasted at the pointer.
await tool("note");
await clickAt(pg, await sp(pl.x + hw + 30, pl.y - hh - 30));
await pg.waitForTimeout(400);
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
const note = (await annots()).find(a => a.t === "note");
if (note) {
  await clickAt(pg, await centre(note.id));
  await pg.keyboard.press("Control+c");
  const to = await sp(pl.x + hw + 30, pl.y - hh - 60);
  await pg.mouse.move(...to);
  await pg.waitForTimeout(150);
  await pg.keyboard.press("Control+v");
  await pg.waitForTimeout(600);
}
const notes = (await annots()).filter(a => a.t === "note");
check("B5", notes.length === 2 && Math.abs(notes[1].pos[1] - notes[0].pos[1]) > 10, "a note copied with Ctrl+C and pasted with Ctrl+V lands at the pointer", { notes: notes.map(n => n.pos), n0, g2: !!g2 }, await snap(pg, "note-pasted"));
// Delete the dimension: its datum and surface finish go too.
await clickAt(pg, await centre(dim.id));
await pg.keyboard.press("Delete");
await pg.waitForTimeout(500);
const left = await annots();
check("B6", !left.some(a => a.id === dt?.id || a.id === sf?.id) && left.some(a => a.id === dg?.id), "deleting the dimension removes the datum and finish on it, not the frame's datum", { left: left.map(a => a.t) }, await snap(pg, "dim-deleted"));
// Assembly: Rename on a component's menu and F2.
await pg.click('#drw [data-a="back"]').catch(() => {});
await pg.waitForTimeout(800);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
const row = pg.locator("#asm-tree .ft-row").filter({ hasText: "<1>" }).first();
await row.click({ button: "right" });
await pg.waitForTimeout(250);
const items = await pg.$$eval("#asm-menu button", els => els.map(e => e.textContent.trim()));
if (items.includes("Rename")) {
  await pg.locator("#asm-menu button", { hasText: "Rename" }).click();
  await pg.waitForTimeout(200);
  await pg.keyboard.type("Base plate");
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(600);
}
const names = await pg.evaluate(() => window.__sv.asm?.doc?.components?.map(c => c.name) ?? [...document.querySelectorAll("#asm-tree .ft-row .ft-name")].map(e => e.textContent));
check("B7", items.includes("Rename") && names.some(n => /Base plate/.test(n)), "a component's menu has Rename and the new name shows", { items, names }, await snap(pg, "comp-renamed"));
await pg.locator("#asm-tree .ft-row").filter({ hasText: "Base plate" }).first().click();
await pg.keyboard.press("F2");
await pg.waitForTimeout(200);
const ren = await pg.$("#asm-tree input.ft-ren");
if (ren) { await pg.keyboard.type("Plate A"); await pg.keyboard.press("Enter"); await pg.waitForTimeout(600); }
const names2 = await pg.$$eval("#asm-tree .ft-row .ft-name", els => els.map(e => e.textContent));
check("B8", !!ren && names2.some(n => /Plate A/.test(n)), "F2 renames the selected component in the assembly tree", { names2 }, await snap(pg, "comp-f2"));
await finish(browser, pg);
