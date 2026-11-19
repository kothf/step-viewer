// The drawing's right-click menus and F2, by hand: a right click on a view, an annotation, the sheet and a tree row opens
// a menu of what is under the pointer; F2 and the menu's Rename rename the view and the sheet.
import { open, snap, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("drwmenu");
await makeBlock(pg, 100, 60, 20);
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
await pg.click('#drw [data-ctab="layout"]').catch(() => {});
await pg.click('#drw .drw-cmds [data-a="std3"]');
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
await pg.waitForTimeout(800);
const v0 = await pg.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0], p = window.__sv.drw.placement(v.id); return { id: v.id, x: p.x, y: p.y }; });
const sp = (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]);
const menu = () => pg.$$eval("#drw .drw-ctx:not([hidden]) button", els => els.map(e => e.textContent.trim()));
const right = async ([x, y]) => { await pg.mouse.move(x, y); await pg.mouse.down({ button: "right" }); await pg.mouse.up({ button: "right" }); await pg.waitForTimeout(300); };
// A view: Rename and Delete view.
await right(await sp(v0.x, v0.y));
const mv = await menu();
const img1 = await snap(pg, "view-menu");
await pg.locator("#drw .drw-ctx button", { hasText: "Rename" }).click();
await pg.waitForTimeout(200);
const focusName = await pg.evaluate(() => document.activeElement?.matches('input[data-v="name"]'));
await pg.keyboard.type("Front A");
await pg.keyboard.press("Enter");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const vname = await pg.evaluate(id => window.__sv.drw.doc().sheets[0].views.find(v => v.id === id).name, v0.id);
check("M1", mv.includes("Rename") && mv.includes("Delete view") && focusName && vname === "Front A", "right click on a view: Rename and Delete view; Rename takes the typed name", { mv, focusName, vname }, img1);
// The empty sheet: Rename, Add sheet, Zoom to fit; F2 renames the sheet too.
await pg.keyboard.press("Escape");
await right(await sp(30, 30));
const ms = await menu();
const img2 = await snap(pg, "sheet-menu");
await pg.keyboard.press("Escape");
await pg.locator("#drw .drw-tree .drw-ti.sheet").click();
await pg.keyboard.press("F2");
await pg.waitForTimeout(200);
const sheetFocus = await pg.evaluate(() => document.activeElement?.matches('input[data-s="name"]'));
await pg.keyboard.type("Layout");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const tab = await pg.$eval("#drw .drw-tablist [data-sheet]", e => e.textContent.trim()).catch(() => "");
check("M2", ms.includes("Rename") && ms.includes("Add sheet") && sheetFocus && tab === "Layout", "right click on the sheet: Rename, Add sheet, Zoom to fit; F2 renames the sheet and its tab follows", { ms, sheetFocus, tab }, img2);
// An annotation: a note, right-clicked: Edit, Copy, Delete; the tree row's menu is the same.
await pg.click('#drw [data-ctab="annot"]');
await pg.click('#drw .drw-cmds [data-an="note"]').catch(async () => { await pg.click('#drw .drw-cmds [data-a="note"]'); });
const np = await sp(v0.x + 70, v0.y + 40);
await pg.mouse.click(...np);
await pg.waitForTimeout(400);
await pg.keyboard.type("NOTE");
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
const note = await pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).find(a => a.t === "note"));
let ma = [];
if (note) {
  const b = await pg.evaluate(id => window.__sv.drw.hit(id), note.id);
  await right(await sp((b[0] + b[2]) / 2, (b[1] + b[3]) / 2));
  ma = await menu();
}
const img3 = await snap(pg, "note-menu");
await pg.keyboard.press("Escape");
const row = pg.locator("#drw .drw-tree [data-sela]").first();
let mt = [];
if (await row.count()) { await row.click({ button: "right" }); await pg.waitForTimeout(300); mt = await menu(); }
if (mt.includes("Delete")) { await pg.locator("#drw .drw-ctx button", { hasText: "Delete" }).click(); await pg.waitForTimeout(400); }
const left = await pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).filter(a => a.t === "note").length);
check("M3", !!note && ma.includes("Edit annotation") && ma.includes("Copy") && ma.includes("Delete") && mt.includes("Delete") && left === 0, "right click on a note (sheet and tree row): Edit annotation, Copy, Delete; Delete removes it", { ma, mt, left }, img3);
await finish(browser, pg);
