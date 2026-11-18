// Sketch features of the gap list, done by hand: construction (1.585), dimension conflicts and hover (1.587),
// entity properties, region shading, open ends (1.590), double-click chain and Show dimensions (1.593).
import { open, snap, cmd, idle, screenOf, clickAt, dblAt, check, finish } from "./lib.mjs";
const { browser, pg } = await open("sketch");
const P = (x, y) => screenOf(pg, [x, y, 0]);
const ed = f => pg.evaluate(f);
const sk = () => ed(() => { const e = window.__sv.model.editor(), s = e.sk; return { ents: s.ents.filter(x => x.t !== "point").map(x => ({ id: x.id, t: x.t, cons: !!x.cons })), dims: s.dims.map(d => ({ id: d.id, kind: d.kind, driven: !!d.driven, v: d.val?.v })), sel: [...e.selection], hover: e.hover?.id ?? e.hover ?? null }; });
const deco = () => ed(() => { let regions = 0, open = 0, dash = 0; window.__sv.viewer.scene.traverse(o => { if (o.visible && o.userData?.skRegions) regions += o.userData.skRegions; if (o.visible && o.userData?.skOpenEnds) open += o.userData.skOpenEnds; if (o.visible && o.userData?.skConstruction) dash++; }); return { regions, open, dash }; });
const tool = async c => { await pg.click(`#mc-tools [data-c="${c}"]`); await pg.waitForTimeout(100); };

await pg.click("#new-part");
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);

// Rectangle by two clicks.
await tool("sk:rect");
await clickAt(pg, await P(-40, -25));
await clickAt(pg, await P(40, 25));
await pg.keyboard.press("Escape");
let s = await sk(), d = await deco();
const img1 = await snap(pg, "rectangle");
check("S5", s.ents.filter(e => e.t === "line").length === 4 && d.regions === 1, "a drawn rectangle is shaded as a closed region", { lines: s.ents.length, ...d }, img1);
check("1.585-autodims", s.dims.length === 0, "new curves get no automatic dimensions", { dims: s.dims.length });

// A lone line: its two ends show as open-end dots.
await tool("sk:line");
await clickAt(pg, await P(55, 10));
await clickAt(pg, await P(75, 30));
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
d = await deco();
const img2 = await snap(pg, "open-ends");
check("S6", d.open === 2, "a lone line shows its 2 open ends", d, img2);

// Construction: select the lone line, press Construction; it turns dashed.
await tool("sk:select");
const mid = await P(65, 20);
await clickAt(pg, mid);
s = await sk();
const lone = s.sel[0];
await tool("cons");
s = await sk(); d = await deco();
const img3 = await snap(pg, "construction");
check("1.585-cons", s.ents.find(e => e.id === lone)?.cons && d.dash >= 1 && d.open === 0, "Construction turns the selected line into dashed construction geometry (no open ends counted)", { lone, cons: s.ents.find(e => e.id === lone), ...d }, img3);
// With nothing selected, Construction is a mode: a new line comes out as construction.
await pg.keyboard.press("Escape");
await clickAt(pg, await P(0, 60));
await tool("cons");
const pressed = await pg.getAttribute('#mc-tools [data-c="cons"]', "aria-pressed");
await tool("sk:line");
await clickAt(pg, await P(-70, 35));
await clickAt(pg, await P(-50, 45));
await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
s = await sk();
const newest = s.ents.at(-1);
await tool("cons");
check("1.585-forcons", pressed === "true" && newest.t === "line" && newest.cons, "Construction with nothing selected draws new lines as construction", { pressed, newest });

// Double-click one side of the rectangle: the whole closed chain is selected.
await tool("sk:select");
await pg.keyboard.press("Escape");
await dblAt(pg, await P(0, -25));
s = await sk();
const img4 = await snap(pg, "double-click-chain");
check("S7", s.sel.length === 4, "double-clicking a rectangle side selects all 4 sides", { sel: s.sel }, img4);

// Entity properties: one side selected, its length typed in the panel.
await pg.keyboard.press("Escape");
await clickAt(pg, await P(0, 25));
await pg.waitForTimeout(200);
const keys = await pg.$$eval("#mc-pm [data-ep]", els => els.map(e => e.dataset.ep));
const img5 = await snap(pg, "entity-props");
let lenAfter = null;
if (keys.includes("len")) {
  await pg.fill('#mc-pm [data-ep="len"]', "100");
  await pg.press('#mc-pm [data-ep="len"]', "Enter");
  await pg.waitForTimeout(300);
  lenAfter = await ed(() => window.__sv.model.editor().entityProps()?.v.len);
}
check("S4", keys.includes("len") && Math.abs(lenAfter - 100) < 1e-6, "a selected line's length typed in the panel changes it", { keys, lenAfter }, img5);

// Smart Dimension: hovering a line highlights it; click it and place the value.
await pg.keyboard.press("Escape");
await tool("sk:dim");
const top = await P(0, 25);
await pg.mouse.move(top[0], top[1] + 30); await pg.waitForTimeout(80);
await pg.mouse.move(top[0], top[1]); await pg.waitForTimeout(200);
s = await sk();
const img6 = await snap(pg, "dimension-hover");
check("1.587-hover", !!s.hover, "Dimension tool: the line under the cursor is highlighted", { hover: s.hover }, img6);
await clickAt(pg, top);
await clickAt(pg, [top[0], top[1] - 60]);
await pg.waitForTimeout(300);
const box = await pg.$(".mod-in");
if (box) { await box.fill("120"); await box.press("Enter"); await pg.waitForTimeout(400); }
s = await sk();
const dim1 = s.dims.at(-1);
check("dim", s.dims.length === 1 && Math.abs(dim1?.v - 120) < 1e-6, "dimension placed and set to 120 in the Modify box", { dims: s.dims, box: !!box });
// The bottom side is the same length: dimensioning it too over-defines, the app asks to make it driven.
await clickAt(pg, await P(0, -25));
const bot = await P(0, -25);
await clickAt(pg, [bot[0], bot[1] + 60]);
await pg.waitForTimeout(400);
const asked = await pg.$("dialog.choose-dlg[open]");
const img7 = await snap(pg, "make-driven");
if (asked) { await pg.click('dialog.choose-dlg [data-choose="driven"]'); await pg.waitForTimeout(300); }
s = await sk();
const box2 = await pg.$(".mod-in");
if (box2) await pg.keyboard.press("Escape");
s = await sk();
check("1.587-driven", !!asked && s.dims.length === 2 && s.dims.at(-1).driven, "an over-defining dimension asks 'Make Dimension Driven?' and becomes driven", { asked: !!asked, dims: s.dims }, img7);
await pg.keyboard.press("Escape");

// Show dimensions off hides the labels; on shows them again.
await tool("sk:select");
const shownDims = () => pg.$$eval(".sk-dim", els => els.filter(e => e.offsetParent !== null).length);
const n0 = await shownDims();
await pg.getByLabel("Show dimensions").uncheck();
await pg.waitForTimeout(200);
const n1 = await shownDims();
const img8 = await snap(pg, "dims-hidden");
await pg.getByLabel("Show dimensions").check();
await pg.waitForTimeout(200);
const n2 = await shownDims();
check("S8", n0 === 2 && n1 === 0 && n2 === 2, "Show dimensions hides and shows the dimension labels", { n0, n1, n2 }, img8);

// Shade closed regions off.
await pg.getByLabel("Shade closed regions").uncheck();
const r0 = (await deco()).regions;
await pg.getByLabel("Shade closed regions").check();
const r1 = (await deco()).regions;
check("S5-off", r0 === 0 && r1 === 1, "Shade closed regions turns the fill off and on", { r0, r1 });
await finish(browser, pg);
