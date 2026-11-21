// Hole positions from sketch points (as a CAD app's Hole Wizard Positions), by hand: a click on the face opens
// the hole's position sketch with the Point tool, the holes preview as points are placed, a dimension between
// them moves a hole, ✓ goes back to the hole, the hole and its sketch are one undo step, editing the sketch later
// moves the holes, and ✕ on the hole takes its sketch away.
import { open, snap, check, finish, makeBlock, idle, clickAt, dblAt, screenOf, cmd } from "./lib.mjs";
const { browser, pg } = await open("holepos");
await makeBlock(pg, 100, 60, 20);
const T = (x, y) => screenOf(pg, [x, y, 20]);
const vol = () => pg.evaluate(() => window.__sv.modeller.last?.props?.volume ?? null);
const state = () => pg.evaluate(() => {
  const mc = window.__sv.modeller, m = mc.mode, d = mc.store.doc;
  const pts = m.kind === "sketch" ? m.editor.sk.ents.filter(e => e.t === "point").map(e => [e.x, e.y]) : null;
  return { kind: m.kind, type: m.draft?.type, sketch: m.draft?.sketch ?? null, draftPts: m.draft?.pts ?? null, pts, tool: m.kind === "sketch" ? m.editor.tool : null,
    dims: m.kind === "sketch" ? m.editor.sk.dims.map(x => x.val?.v) : null, features: d.features.map(f => ({ id: f.id, type: f.type, name: f.name, sketch: f.sketch, pts: f.pts })), undo: mc.store.undoLabel };
});
const v0 = await vol();
const n0 = (await state()).features.length;

await cmd(pg, "Hole");
await pg.waitForTimeout(600);
await pg.click('#mc-pm [data-htab="pos"]');
await pg.waitForTimeout(200);
await clickAt(pg, await T(20, 10));
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
await pg.waitForTimeout(800);
let s = await state();
const img1 = await snap(pg, "sketch-open");
check("H1", s.kind === "sketch" && s.tool === "point" && s.pts?.length === 1 && Math.abs(s.pts[0][0] - 20) < 1 && Math.abs(s.pts[0][1] - 10) < 1,
  "a click on the face opens the hole's position sketch with the Point tool and a point where it was clicked", s, img1);

await clickAt(pg, await T(-25, -15));
await pg.waitForTimeout(500);
await idle(pg);
s = await state();
const v1 = await vol();
const img2 = await snap(pg, "two-points-preview");
check("H2", s.pts?.length === 2 && v1 < v0 - 2 * 400, "a second point gets a hole too, previewed live while sketching", { pts: s.pts, v0, v1 }, img2);

// Smart Dimension between the two points, set to 40.
await pg.click('#mc-tools [data-c="sk:dim"]');
await pg.waitForTimeout(150);
await clickAt(pg, await T(20, 10));
await clickAt(pg, await T(-25, -15));
const mid = await T(0, 20);
await clickAt(pg, mid);
await pg.waitForTimeout(400);
const box = await pg.$(".mod-in");
if (box) { await box.fill("40"); await box.press("Enter"); await pg.waitForTimeout(500); }
await idle(pg);
s = await state();
const d = s.pts && Math.abs(s.pts[0][0] - s.pts[1][0]);
const img3 = await snap(pg, "dimensioned");
check("H3", !!box && Math.abs(d - 40) < 1e-6, "the holes can be dimensioned: a 40 mm horizontal dimension between the points", { dims: s.dims, d }, img3);

// ✓ on the sketch: back to the hole, which takes the sketch's points.
await pg.click("#mc-ok");
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "feature", null, { timeout: 30000 });
await idle(pg);
s = await state();
const img4 = await snap(pg, "back-to-hole");
const panel = await pg.evaluate(() => document.querySelector("#mc-pm")?.textContent ?? "");
check("H4", s.type === "hole" && !!s.sketch && s.draftPts?.length === 2 && /Position sketch/.test(panel), "✓ on the sketch goes back to the hole panel, which shows the position sketch and 2 holes", { s: { sketch: s.sketch, pts: s.draftPts } }, img4);

await pg.click("#mc-ok");
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "none", null, { timeout: 30000 });
await idle(pg);
s = await state();
const hole = s.features.find(f => f.type === "hole");
const v2 = await vol();
check("H5", s.features.length === n0 + 2 && hole?.sketch && hole.pts.length === 2 && v2 < v0 - 2 * 400 && /Hole/.test(s.undo), "OK makes the hole after its sketch; the hole and its sketch are one undo step", { n: s.features.length, undo: s.undo, v2 }, await snap(pg, "hole-done"));

// One Undo takes both away; Redo brings both back.
await pg.keyboard.press("Control+z");
await idle(pg);
const nU = (await state()).features.length;
await pg.keyboard.press("Control+y");
await idle(pg);
const nR = (await state()).features.length;
check("H6", nU === n0 && nR === n0 + 2, "Undo removes the hole with its sketch, Redo puts both back", { nU, nR, n0 });

// Edit the position sketch from the tree menu, change the dimension to 60: the hole follows.
await pg.locator("#mc-tree .ft-row", { hasText: "Hole1" }).first().click({ button: "right" });
await pg.waitForTimeout(250);
await pg.locator("#mc-menu button", { hasText: "Edit position sketch" }).click();
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
await pg.waitForTimeout(800);
const lab = await pg.$(".sk-dim");
if (lab) { const b = await lab.boundingBox(); await dblAt(pg, [b.x + b.width / 2, b.y + b.height / 2]); }
await pg.waitForTimeout(300);
const box2 = await pg.$(".mod-in");
if (box2) { await box2.fill("60"); await box2.press("Enter"); await pg.waitForTimeout(500); }
await pg.click("#mc-ok");
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "none", null, { timeout: 30000 });
await idle(pg);
s = await state();
const h2 = s.features.find(f => f.type === "hole");
const d2 = h2 && Math.abs(h2.pts[0][0] - h2.pts[1][0]);
const sv = await pg.evaluate(() => window.__sv.modeller.last?.statuses?.every(x => x.ok));
check("H7", Math.abs(d2 - 60) < 1e-6 && sv, "editing the position sketch later moves the holes (dimension 40 → 60)", { d2, ok: sv }, await snap(pg, "sketch-edited"));

// A second hole command, cancelled after its sketch: the sketch goes away with it.
await cmd(pg, "Hole");
await pg.waitForTimeout(600);
await pg.click('#mc-pm [data-htab="pos"]');
await clickAt(pg, await T(35, -20));
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
await pg.waitForTimeout(600);
await pg.click("#mc-ok");
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "feature", null, { timeout: 30000 });
await idle(pg);
await pg.click("#mc-cancel");
await pg.waitForTimeout(300);
await idle(pg);
s = await state();
check("H8", s.kind === "none" && s.features.length === n0 + 2, "✕ on the hole takes away the position sketch made in it", { n: s.features.length });

// Holes from an existing sketch: a sketch of points picked in the tree.
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await clickAt(pg, await T(-40, 20));
await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
await pg.waitForTimeout(800);
await pg.click('#mc-tools [data-c="sk:point"]');
await clickAt(pg, await T(-40, 20));
await clickAt(pg, await T(40, 20));
await clickAt(pg, await T(0, -20));
await pg.click("#mc-ok");
await idle(pg);
const nBefore = (await state()).features.length;
const vB = await vol();
await cmd(pg, "Hole");
await pg.waitForTimeout(600);
const skName = (await state()).features.filter(f => f.type === "sketch").at(-1).name;
await pg.click('#mc-pm [data-htab="pos"]');
// The tree folds into the command bar while a command is open: open it, as a person would.
if (!(await pg.locator("#mc-tree").isVisible())) await pg.click(".mc-treefly-h");
await pg.waitForTimeout(200);
await pg.locator("#mc-tree .ft-row", { hasText: skName }).first().click();
await idle(pg);
s = await state();
const img9 = await snap(pg, "existing-sketch");
await pg.click("#mc-ok");
await idle(pg);
const vA = await vol();
check("H9", s.draftPts?.length === 3 && (await state()).features.length === nBefore + 1 && vA < vB - 3 * 400, "a sketch of points picked in the tree places the holes", { pts: s.draftPts, vB, vA }, img9);
await finish(browser, pg);
