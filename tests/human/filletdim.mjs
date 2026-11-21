// 1.637.0: sketch dimensions to round faces seen side-on, by hand: a pin lying across a block shows no model edge along
// its outline from above, yet Dimension takes that outline (a silhouette edge, as in other CAD apps), and the
// dimension follows the pin after a rebuild. Also: the pin's end circle seen edge-on, and a fillet's tangent edges.
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf, cmd } from "./lib.mjs";
const { browser, pg } = await open("filletdim");
await makeBlock(pg, 100, 60, 20);

// A Ø12 pin along Y, its axis 4 mm above the block's top: sketch a circle on Front (XZ), extrude it 25 mm.
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Front (XZ)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [20, 0, 24]));
await clickAt(pg, await screenOf(pg, [26, 0, 24]));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
await dp.fill("25"); await dp.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
// A fillet on the block's top left edge, r = 6.
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
const edge = await screenOf(pg, [-50, 15, 20]);
await cmd(pg, "Fillet");
await pg.waitForTimeout(500);
await clickAt(pg, edge);
await pg.waitForTimeout(400);
const rad = await pg.$('#mc-pm input[data-num="radius"]');
await rad.fill("6"); await rad.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
// Where the pin lies along Y: its outline seen from above (read only).
const pin = await pg.evaluate(() => { const l = window.__sv.modeller.silhouettesFor([0, 0, 1])[0]?.ed; return l ? { y: (l.start[1] + l.end[1]) / 2, end: Math.abs(l.start[1]) > Math.abs(l.end[1]) ? l.start[1] : l.end[1] } : null; });
console.log(pin);
const y = pin?.y ?? 12.5;

// Sketch on the block's top face; the view turns to look straight down.
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
await cmd(pg, "Sketch");
await pg.waitForTimeout(400);
await clickAt(pg, await screenOf(pg, [-20, -20, 20]));
await pg.waitForTimeout(2000);
const img0 = await snap(pg, "sketch-on-top");
const editor = () => pg.evaluate(() => { const e = window.__sv.modeller.mode.editor; return { picks: e.dimDraft.picks.map(p => p.kind), dims: e.sk.dims.map(d => ({ t: d.t, v: d.val.v, driven: !!d.driven })), sil: e.sk.rels.filter(r => r.ext?.sil).length, ext: e.sk.rels.filter(r => r.ext).length }; });
const dimTool = async () => { await cmd(pg, "Dimension"); await pg.waitForTimeout(200); };
const hoverClick = async p => { const at = await screenOf(pg, p); await pg.mouse.move(at[0] - 4, at[1] - 3); await pg.waitForTimeout(80); await clickAt(pg, at); await pg.waitForTimeout(250); };
const place = async p => { await hoverClick(p); await pg.waitForTimeout(300); const b = await pg.$('dialog.choose-dlg [data-choose="driven"]'); if (b) { await b.click(); await pg.waitForTimeout(300); } else if (await pg.isVisible(".mod-in")) { await pg.keyboard.press("Enter"); await pg.waitForTimeout(300); } await idle(pg); };

// F1: the pin's outline at x = 14 (no model edge there: the seam is on the other side) and the block's right edge at x = 50: 36 mm apart.
await dimTool();
await hoverClick([14, y, 24]);
const first = await editor();
await hoverClick([50, y, 20]);
await place([38, y + 12, 20]);
let e1 = await editor();
const img1 = await snap(pg, "pin-outline-dimension");
check("F1", first.picks[0] === "line" && e1.sil === 1 && e1.dims.some(d => Math.abs(d.v - 36) < 1e-3), "Dimension takes a pin's outline seen from above (no model edge there): 36 mm to the block's edge", { first, e1 }, img1);

// F2: the pin's other side at x = 26 (its seam) and the fillet's tangent edge on the top face at x = -44: 70 mm.
await pg.keyboard.press("Escape");
await dimTool();
await hoverClick([26, y - 6, 24]);
await hoverClick([-44, y - 6, 20]);
await place([-15, y - 16, 20]);
const e2 = await editor();
const img2 = await snap(pg, "fillet-tangent-dimension");
check("F2", e2.sil === 1 && e2.dims.some(d => Math.abs(d.v - 70) < 1e-3), "the pin's other side (its seam) to the fillet's tangent edge: 70 mm", e2, img2);

// F3: the pin's end circle seen edge-on is a line across it: its length is the pin's diameter.
await pg.keyboard.press("Escape");
await dimTool();
const endAt = pin?.end ?? -25;
await hoverClick([21, endAt, 24]);
await snap(pg, "end-circle-picked");
const e3a = await editor();
await place([20, endAt + 8, 20]);
const e3 = await editor();
const img3 = await snap(pg, "end-circle-edge-on");
check("F3", e3a.picks[0] === "line" && e3.dims.length === 3 && e3.dims[2].v > 9 && e3.dims[2].v < 12.001, "the pin's end arc seen edge-on is picked as a line and dimensioned (its length across the pin)", { e3a, dims: e3.dims }, img3);

// F4: the fillet's outer outline (x = -50, below the top face) is its tangent edge with the side face.
await pg.keyboard.press("Escape");
await dimTool();
await hoverClick([-50, -10, 14]);
const e4 = await editor();
await pg.keyboard.press("Escape");
check("F4", e4.picks[0] === "line", "the fillet's outer edge seen from above is picked", e4);

// F5: close the sketch; the outline references are kept and nothing dangles after the rebuild.
await pg.keyboard.press("Escape");
await pg.click("#mc-ok");
await idle(pg);
const kept = await pg.evaluate(() => { const d = window.__sv.model.store.doc, sk = d.features.at(-1); return { type: sk.type, sil: sk.rels.filter(r => r.ext?.sil).length, dangling: sk.rels.filter(r => r.dangling).length, dims: sk.dims.map(x => Math.round(x.val.v * 1000) / 1000) }; });
const img5 = await snap(pg, "closed");
check("F5", kept.type === "sketch" && kept.sil === 1 && kept.dangling === 0 && kept.dims.includes(36) && kept.dims.includes(70), "the closed sketch keeps the outline reference, none dangling after the rebuild", kept, img5);
await finish(browser, pg);
