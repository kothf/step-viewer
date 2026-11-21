// 1.646.0: snapping a sketch line to model edges draws no extra lines, by hand. A line from the middle of the block's
// front top edge to the middle of its back top edge gets two Midpoint relations to the model edges, as in other CAD
// apps; the copies of the edges that hold them stay hidden (they used to show as dashed construction lines), and
// deleting the line takes them away.
import { open, snap, check, finish, makeBlock, clickAt, screenOf, cmd } from "./lib.mjs";
const { browser, pg } = await open("snapref");
await makeBlock(pg, 100, 20, 20);

// Sketch on the block's top face; the view turns to look straight down.
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
await cmd(pg, "Sketch");
await pg.waitForTimeout(400);
await clickAt(pg, await screenOf(pg, [-30, 3, 20]));
await pg.waitForTimeout(2000);
const state = () => pg.evaluate(() => {
  const e = window.__sv.modeller.mode.editor, s = e.sk;
  let dashed = 0;
  window.__sv.viewer.scene.traverse(o => { if (o.visible && o.userData?.skConstruction) dashed += o.geometry?.attributes?.instanceStart?.count ?? 0; });
  return { lines: s.ents.filter(x => x.t === "line" && !x.cons).length, refs: s.ents.filter(x => x.ref).length, cons: s.ents.filter(x => x.cons && !x.ref).length,
    mids: s.rels.filter(r => r.t === "midpoint").length, dof: e.info.dof, dashed, glyphs: document.querySelectorAll(".sk-rel").length };
});

// R1: Line tool, click the middle of the front top edge, then the middle of the back one.
await cmd(pg, "Line");
await pg.waitForTimeout(200);
for (const p of [[0, -10, 20], [0, 10, 20]]) { const at = await screenOf(pg, p); await pg.mouse.move(at[0] + 4, at[1] + 3); await pg.waitForTimeout(80); await clickAt(pg, at); }
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
const s1 = await state();
const img1 = await snap(pg, "line-on-edge-midpoints");
check("R1", s1.lines === 1 && s1.mids === 2 && s1.refs === 2 && s1.cons === 0 && s1.dashed === 0 && s1.dof === 0,
  "a line snapped to two model edge midpoints gets Midpoint relations and fully defined, with no dashed lines drawn", s1, img1);

// R2: hovering the model edge shows its hidden copy, as other CAD apps light up the edge.
const edge = await screenOf(pg, [30, -10, 20]);
await pg.mouse.move(edge[0], edge[1]);
await pg.waitForTimeout(300);
const hover = await pg.evaluate(() => window.__sv.modeller.mode.editor.hover?.id ?? null);
const isRef = await pg.evaluate(id => !!window.__sv.modeller.mode.editor.sk.ents.find(x => x.id === id)?.ref, hover);
check("R2", isRef, "the model edge under the pointer lights up", { hover, isRef });

// R3: select the line and delete it: the hidden copies go with it.
await pg.mouse.move(5, 300);
const mid = await screenOf(pg, [0, 2, 20]);
await clickAt(pg, mid);
await pg.keyboard.press("Delete");
await pg.waitForTimeout(300);
const s3 = await state();
const img3 = await snap(pg, "line-deleted");
check("R3", s3.lines === 0 && s3.refs === 0, "deleting the line also removes the hidden model edge copies", s3, img3);
await pg.keyboard.press("Escape");
await finish(browser, pg);
