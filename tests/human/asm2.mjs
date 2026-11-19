// Assembly features of the gap list, by hand: the mate pop-up toolbar (A4) and explode lines (A3).
import { open, snap, idle, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("asm2");
await makeBlock(pg, 100, 60, 20);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await pg.click('#asm-tools [data-ac="insert"]');
await pg.waitForTimeout(300);
await pg.getByText(/^Open document:/).first().click();
await pg.waitForTimeout(800);
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await clickAt(pg, [vp[0] + 220, vp[1] - 120]);
await pg.waitForTimeout(1500);
await pg.evaluate(() => window.__sv.viewer.setStandardView?.("iso"));
await pg.waitForTimeout(500);
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("f");
await pg.waitForTimeout(900);

/** A screen point where shown part i's flat face with normal n is seen in front (sampled over the face's box). */
const at = (i, n) => pg.evaluate(([i, n]) => {
  const v = window.__sv.viewer, part = v.parts[i], V = v.camera.position.constructor, d = part.data;
  const f = d.faces.find(f => f.type === "plane" && f.normal && f.normal.every((c, k) => Math.abs(c - n[k]) < 1e-3));
  const r = v.renderer.domElement.getBoundingClientRect(), c0 = v.toWorld(part, f.center).clone(), c1 = v.toWorld(part, [f.center[0] + n[0], f.center[1] + n[1], f.center[2] + n[2]]).clone(), nw = c1.sub(c0).normalize();
  for (let k = 0; k <= 64; k++) {
    const u = (k % 9) / 8, w = Math.floor(k / 9) / 7, p = [0, 1, 2].map(a => Math.abs(n[a]) > 0.5 ? f.center[a] : d.bboxMin[a] + (d.bboxMax[a] - d.bboxMin[a]) * (0.1 + 0.8 * (a === (Math.abs(n[0]) > 0.5 ? 1 : 0) ? u : w)));
    const pw = v.toWorld(part, new V(...p)).clone(), q = pw.clone().project(v.camera);
    const h = v.pickMeshes({ x: q.x, y: q.y });
    if (h && h.object.userData.partIdx === i && Math.abs(h.point.clone().sub(c0).dot(nw)) < 1e-3) return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
  }
  return null;
}, [i, n]);
const cam = await pg.evaluate(() => window.__sv.viewer.camera.position.toArray());
const fy = cam[1] < 0 ? -1 : 1;
const barState = () => pg.evaluate(() => {
  const b = document.getElementById("asm-matebar");
  return b ? { types: [...b.querySelectorAll("[data-mbt]")].map(x => x.dataset.mbt), on: b.querySelector(".on")?.dataset.mbt ?? "", box: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })() } : null;
});

// A4: Mate, then the side face of each block → a bar by the cursor with the mate types that fit two flat faces.
await pg.click('#asm-tools [data-ac="mate"]');
await pg.waitForTimeout(300);
const p1 = await at(0, [0, 0, 1]);
await clickAt(pg, p1);
await pg.waitForTimeout(300);
const b0 = await barState();
const p2 = await at(1, [0, 0, 1]);
await clickAt(pg, p2);
await pg.waitForTimeout(700);
const b1 = await barState();
const img1 = await snap(pg, "mate-bar");
check("A4-bar", !b0 && !!b1 && b1.types.includes("coincident") && b1.types.includes("distance") && !b1.types.includes("concentric") && Math.hypot(b1.box[0] - p2[0], b1.box[1] - p2[1]) < 220,
  "after the second face, a mate bar shows by the cursor with the types that fit two flat faces (no Concentric)", { b0, b1, p2 }, img1);
// Distance from the bar: type 15, Enter → the mate is added and the bar goes.
await pg.click('#asm-matebar [data-mbt="distance"]');
await pg.waitForTimeout(500);
const inp = pg.locator('#asm-matebar [data-mb="val"]');
const hasVal = await inp.count();
if (hasVal) { await inp.click({ clickCount: 3 }); await pg.keyboard.type("15"); await pg.keyboard.press("Enter"); }
await pg.waitForTimeout(1500);
await idle(pg);
const mates = await pg.evaluate(() => (window.__sv.asm.doc?.mates ?? []).map(m => ({ type: m.type, value: m.value })));
const gone = !(await barState());
const img2 = await snap(pg, "mate-added");
check("A4-distance", hasVal && mates.length === 1 && mates[0].type === "distance" && Math.abs(mates[0].value - 15) < 1e-9 && gone,
  "Distance on the bar, 15, Enter: a 15 mm distance mate is added and the bar closes", { hasVal, mates, gone }, img2);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.evaluate(() => window.__sv.asm.cancelMate?.());

// A3: Explode with explode lines ticked: a dashed line per moved component.
await pg.click('#asm-tools [data-ac="explode"]');
await pg.waitForTimeout(400);
await pg.click('#asm-pm [data-a="auto"]');
await pg.waitForTimeout(500);
await pg.check('#asm-pm [data-a="lines"]');
await pg.waitForTimeout(400);
const lines = () => pg.evaluate(() => { let n = 0; window.__sv.viewer.scene.traverse(o => { if (o.userData.explodeLines && o.visible && o.parent?.visible !== false) n += o.userData.explodeLines; }); return n; });
const n1 = await lines();
const img3 = await snap(pg, "explode-lines");
await pg.click('#asm-pm [data-a="ok"]');
await pg.waitForTimeout(800);
const n2 = await lines(), saved = await pg.evaluate(() => window.__sv.asm.doc?.explodes?.[0]?.lines ?? null);
check("A3", n1 >= 1 && n2 === n1 && saved === true, "Explode with Explode lines ticked draws a dashed line from each moved component's place, kept on the saved view", { n1, n2, saved }, img3);
// Collapse from the tree: the lines go with the explode.
await pg.locator("#asm-tree .ft-explode").first().click({ button: "right" });
await pg.waitForTimeout(250);
await pg.locator("button:visible", { hasText: /^Collapse$/ }).first().click();
await pg.waitForTimeout(900);
const n3 = await lines();
const img4 = await snap(pg, "collapsed");
check("A3-collapse", n3 === 0, "collapsing the exploded view takes the lines away", { n3 }, img4);
await finish(browser, pg);
