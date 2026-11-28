// Assembly mates by hand (tests list /mnt/project-files/tests/mates-motion-tests.md, sections A, C, D):
// a plate with a hole and a pin, mated, edited, suppressed, deleted and dragged with real clicks.
import { open, snap, idle, clickAt, check, finish, screenOf, cmd } from "./lib.mjs";

/** A new part: on Top a rectangle w × h (0 = none) and a circle of radius r at the origin (0 = none), extruded by depth. */
export async function makePart(pg, { w = 0, h = 0, r = 0, depth = 20 }) {
  await pg.click("#file-btn");
  await pg.click('#file-menu [data-f="new-part"]');
  await idle(pg);
  await cmd(pg, "Sketch");
  await pg.waitForTimeout(300);
  await pg.getByRole("button", { name: "Top (XY)" }).last().click();
  await pg.waitForTimeout(1200);
  if (w) {
    await pg.click('#mc-tools [data-c="sk:rect"]');
    await clickAt(pg, await screenOf(pg, [-w / 2, -h / 2, 0]));
    await clickAt(pg, await screenOf(pg, [w / 2, h / 2, 0]));
    await pg.keyboard.press("Escape");
  }
  if (r) {
    await pg.click('#mc-tools [data-c="sk:circle"]');
    await clickAt(pg, await screenOf(pg, [w ? w / 4 : 0, 0, 0]));
    await clickAt(pg, await screenOf(pg, [(w ? w / 4 : 0) + r, 0, 0]));
    await pg.keyboard.press("Escape");
  }
  await pg.click('#mc-tools [data-c="extrude"]');
  await pg.waitForTimeout(800);
  const dp = await pg.$('#mc-pm input[data-num="depth"]');
  await dp.fill(String(depth)); await dp.press("Enter");
  await idle(pg);
  if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
  await idle(pg);
}

/** A screen point where shown part i shows a face that `test` (source of a function of the face) accepts. */
export const faceSpot = (pg, i, test) => pg.evaluate(([i, test]) => {
  const v = window.__sv.viewer, fn = new Function("f", `return (${test})(f)`), r = v.renderer.domElement.getBoundingClientRect();
  const V2 = v.camera.position.constructor;
  for (let n = 12; n <= 48; n *= 2)
    for (let a = 1; a < n; a++) for (let b = 1; b < n; b++) {
      const x = (a / n) * 2 - 1, y = (b / n) * 2 - 1;
      const h = v.pickMeshes({ x, y });
      if (!h || h.object.userData.partIdx !== i) continue;
      const part = v.parts[i], f = part.data.faces[part.triFace[h.faceIndex]];
      if (f && fn(f)) return [r.left + ((x + 1) / 2) * r.width, r.top + ((1 - y) / 2) * r.height];
    }
  return null;
}, [i, test]);

export const CYL = "f => f.type === 'cylinder' || f.surface === 'cylinder'";
export const TOP = "f => f.type === 'plane' && f.normal[2] > 0.99";
export const BOTTOM = "f => f.type === 'plane' && f.normal[2] < -0.99";
export const SIDE_Y = "f => f.type === 'plane' && f.normal[1] < -0.99";

/** Plate with a hole and a pin, the plate fixed in a new assembly, the pin inserted beside it. */
export async function plateAndPin(pg) {
  await makePart(pg, { r: 10, depth: 60 });       // pin, Ø20 × 60
  await makePart(pg, { w: 100, h: 60, r: 10 });    // plate 100 × 60 × 20 with a Ø20 hole at x = 25
  await pg.click("#file-btn");
  await pg.click('#file-menu [data-f="asm-part"]');
  await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
  await pg.waitForTimeout(1500);
  await pg.click('#asm-tools [data-ac="insert"]');
  await pg.waitForTimeout(300);
  await pg.getByText(/^Open document:/).first().click();
  await pg.waitForTimeout(800);
  const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await clickAt(pg, [vp[0] - 260, vp[1] - 120]);
  await pg.waitForTimeout(1500);
  await idle(pg);
  await pg.mouse.move(vp[0], vp[1]);
  await pg.keyboard.press("f");
  await pg.waitForTimeout(900);
  return vp;
}

export const doc = pg => pg.evaluate(() => {
  const d = window.__sv.asm.doc;
  return { comps: d.components.map(c => ({ id: c.id, name: c.name, fixed: !!c.fixed, tf: c.tf })), mates: (d.mates ?? []).map(m => ({ id: m.id, type: m.type, value: m.value, suppressed: !!m.suppressed, name: m.name, align: m.align, flip: m.flip })) };
});

/** World position of the pin's own origin (the component's translation). */
const pinAt = async pg => (await doc(pg)).comps[1].tf.slice(0, 12);

if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, pg } = await open("mates");
  const vp = await plateAndPin(pg);
  const img0 = await snap(pg, "plate-and-pin");
  const d0 = await doc(pg);
  check("setup", d0.comps.length === 2 && d0.comps[0].fixed && !d0.comps[1].fixed, "a fixed plate and a floating pin in the assembly", d0.comps.map(c => [c.name, c.fixed]), img0);

  // A2/A5: Mate, the pin's cylinder, the hole's cylinder → the bar offers Concentric first; Enter adds it.
  await pg.click('#asm-tools [data-ac="mate"]');
  await pg.waitForTimeout(400);
  const pc = await faceSpot(pg, 1, CYL);
  await clickAt(pg, pc);
  await pg.waitForTimeout(300);
  const hc = await faceSpot(pg, 0, CYL);
  await clickAt(pg, hc);
  await pg.waitForTimeout(800);
  const bar = await pg.evaluate(() => { const b = document.getElementById("asm-matebar"); return b ? { types: [...b.querySelectorAll("[data-mbt]")].map(x => x.dataset.mbt), on: b.querySelector(".on")?.dataset.mbt } : null; });
  const img1 = await snap(pg, "concentric-bar");
  check("A2", bar && bar.on === "concentric" && !bar.types.includes("width"), "two cylinders: the mate bar shows by the cursor with Concentric chosen", bar, img1);
  await pg.click('#asm-matebar [data-mb="ok"]');
  await pg.waitForTimeout(1200);
  await idle(pg);
  const d1 = await doc(pg);
  const img2 = await snap(pg, "concentric-added");
  check("A5", d1.mates.length === 1 && d1.mates[0].type === "concentric", "✓ adds a concentric mate and the pin moves into the hole's axis", d1.mates, img2);
  const axisOff = await pg.evaluate(() => { const c = window.__sv.asm.doc.components[1].tf; return Math.hypot(c[3] - 25, c[7]); });  // the pin's origin is on its axis
  check("A5-axis", axisOff < 1e-3, "the pin's axis is the hole's axis (x = 25, y = 0)", { axisOff });

  // A4: Coincident between the pin's top and the plate's top: flush. Other CAD apps keep the alignment nearer
  // to how the parts stand (both faces look up: aligned), so the pin is not turned over.
  const pb = await faceSpot(pg, 1, TOP);
  const pt = await faceSpot(pg, 0, TOP);
  let coinc = null;
  if (pb && pt) {
    await clickAt(pg, pb); await pg.waitForTimeout(300);
    await clickAt(pg, pt); await pg.waitForTimeout(700);
    coinc = await pg.evaluate(() => document.querySelector("#asm-matebar .on")?.dataset.mbt);
    if (coinc !== "coincident") await pg.click('#asm-matebar [data-mbt="coincident"]').catch(() => {});
    await pg.waitForTimeout(500);
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(1200);
    await idle(pg);
  }
  const d2 = await doc(pg);
  const z2 = d2.comps[1].tf[11], up2 = d2.comps[1].tf[10];
  const img3 = await snap(pg, "coincident");
  check("A4", !!pb && d2.mates.length === 2 && d2.mates[1].type === "coincident" && Math.abs(z2 + 40) < 1e-3 && up2 > 0.99, "pin top on plate top: a coincident mate, the pin is flush and still points up (aligned kept)", { pb: !!pb, coinc, z2, up2, mates: d2.mates }, img3);

  // A11: close the panel with ✓ (nothing picked).
  await pg.click('#asm-pm [data-a="ok"]').catch(() => {});
  await pg.waitForTimeout(500);

  // C1/C6: the tree shows a Mates folder with the two mates; the pin row says it is under-defined.
  const tree = await pg.evaluate(() => ({
    mates: [...document.querySelectorAll("#asm-tree .ft-mate")].map(r => r.textContent.trim()),
    rows: [...document.querySelectorAll("#asm-tree .ft-row")].map(r => r.textContent.trim()).slice(0, 12),
  }));
  const img4 = await snap(pg, "tree");
  check("C1", tree.mates.length === 2, "the tree lists both mates with the components named", tree, img4);
  check("C6", tree.rows.some(r => /\(-\)|\(−\)/.test(r)) && tree.rows.some(r => /\(f\)|fixed/i.test(r)), "the tree marks the pin under-defined (−) and the plate fixed (f)", tree.rows);

  // D2: drag the pin sideways: it stays on the axis (it only turns), z stays 20.
  const before = await pinAt(pg);
  const ps = await faceSpot(pg, 1, CYL);
  await pg.mouse.move(ps[0], ps[1]); await pg.mouse.down();
  for (let k = 1; k <= 10; k++) { await pg.mouse.move(ps[0] + k * 12, ps[1] + k * 4); await pg.waitForTimeout(30); }
  await pg.mouse.up();
  await pg.waitForTimeout(1000);
  await idle(pg);
  const after = await pinAt(pg);
  const img5 = await snap(pg, "dragged");
  const turned = Math.atan2(after[4], after[0]) - Math.atan2(before[4], before[0]);
  check("D2", Math.abs(turned) > 0.05 && Math.hypot(after[3] - 25, after[7]) < 1e-3 && Math.abs(after[11] - before[11]) < 1e-3, "dragging the mated pin turns it about the hole's axis; it stays on the axis and flush", { before, after, turned }, img5);

  // D3: drag the fixed plate: nothing moves.
  const pl = await faceSpot(pg, 0, TOP);
  const tf0 = (await doc(pg)).comps[0].tf.join();
  await pg.mouse.move(pl[0], pl[1]); await pg.mouse.down();
  for (let k = 1; k <= 8; k++) { await pg.mouse.move(pl[0] + k * 10, pl[1]); await pg.waitForTimeout(30); }
  await pg.mouse.up(); await pg.waitForTimeout(800);
  const status = await pg.evaluate(() => [document.querySelector("#st-hint")?.textContent, [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")]);
  check("D3", (await doc(pg)).comps[0].tf.join() === tf0, "dragging the fixed plate does not move it", { status });

  // C2: Edit the coincident mate from the tree into a distance of 15.
  const coRow = pg.locator("#asm-tree .ft-mate").nth(1);
  await coRow.click({ button: "right" });
  await pg.waitForTimeout(300);
  const menu = await pg.evaluate(() => [...document.querySelectorAll(".mc-menu button, #mc-menu button")].filter(b => b.offsetParent).map(b => b.textContent.trim()));
  const edit = pg.locator(".mc-menu button:visible, #mc-menu button:visible", { hasText: /^Edit/ }).first();
  let edited = null;
  if (await edit.count()) {
    await edit.click(); await pg.waitForTimeout(600);
    await pg.click('#asm-pm [data-mt="distance"]').catch(() => {});
    await pg.waitForTimeout(400);
    const vi = pg.locator('#asm-pm [data-mv]');
    if (await vi.count()) { await vi.fill("15"); await vi.press("Enter"); }
    await pg.waitForTimeout(1200); await idle(pg);
    if (await pg.isVisible('#asm-pm [data-a="ok"]')) { await pg.click('#asm-pm [data-a="ok"]'); await pg.waitForTimeout(800); }
    edited = await doc(pg);
  }
  const img6 = await snap(pg, "edited");
  const z6 = edited?.comps[1].tf[11];
  check("C2", edited && edited.mates[1].type === "distance" && Math.abs(edited.mates[1].value - 15) < 1e-6 && Math.abs(Math.abs(z6 + 40) - 15) < 1e-3, "Edit mate from the tree: Coincident changed to a 15 mm distance, the pin moves 15 mm off the plate", { menu, mates: edited?.mates, z6 }, img6);

  // C3: Suppress the distance mate; the pin can be dragged along the axis then. Unsuppress puts it back.
  await coRow.click({ button: "right" }); await pg.waitForTimeout(300);
  const sup = pg.locator(".mc-menu button:visible, #mc-menu button:visible", { hasText: /^Suppress/ }).first();
  const hasSup = await sup.count();
  if (hasSup) { await sup.click(); await pg.waitForTimeout(1000); await idle(pg); }
  const d7 = await doc(pg);
  check("C3", hasSup && d7.mates[1].suppressed, "Suppress from the mate's menu suppresses it", { menu, mates: d7.mates }, await snap(pg, "suppressed"));
  await coRow.click({ button: "right" }); await pg.waitForTimeout(300);
  const unsup = pg.locator(".mc-menu button:visible, #mc-menu button:visible", { hasText: /^Unsuppress/ }).first();
  if (await unsup.count()) { await unsup.click(); await pg.waitForTimeout(1000); await idle(pg); }
  const d8 = await doc(pg);
  check("C3-back", !d8.mates[1].suppressed && Math.abs(Math.abs(d8.comps[1].tf[11] + 40) - 15) < 1e-3, "Unsuppress brings the distance back", d8.mates);

  // C4: Delete the distance mate, then Ctrl+Z.
  await coRow.click({ button: "right" }); await pg.waitForTimeout(300);
  await pg.locator(".mc-menu button:visible, #mc-menu button:visible", { hasText: /^Delete/ }).first().click();
  await pg.waitForTimeout(800);
  const n9 = (await doc(pg)).mates.length;
  await pg.mouse.move(vp[0], vp[1] + 150);
  await pg.keyboard.press("Control+z");
  await pg.waitForTimeout(1200); await idle(pg);
  const n10 = (await doc(pg)).mates.length;
  check("C4", n9 === 1 && n10 === 2, "Delete removes the mate, Ctrl+Z brings it back", { n9, n10 }, await snap(pg, "undo-delete"));

  // C5: a conflicting mate: Distance 5 between pin bottom and plate top while the 15 mm distance holds.
  await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
  const pb2 = await faceSpot(pg, 1, TOP), pt2 = await faceSpot(pg, 0, TOP);
  let conflict = null;
  if (pb2 && pt2) {
    await clickAt(pg, pb2); await pg.waitForTimeout(300);
    await clickAt(pg, pt2); await pg.waitForTimeout(700);
    await pg.click('#asm-matebar [data-mbt="distance"]').catch(() => {});
    await pg.waitForTimeout(400);
    const inp = pg.locator('#asm-matebar [data-mb="val"]');
    if (await inp.count()) { await inp.click({ clickCount: 3 }); await pg.keyboard.type("5"); await pg.keyboard.press("Enter"); }
    await pg.waitForTimeout(1500); await idle(pg);
    conflict = await pg.evaluate(() => ({
      status: document.querySelector("#asm-pm [data-mstatus]")?.textContent,
      toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent),
      bad: [...document.querySelectorAll("#asm-tree .ft-mate.bad")].map(r => r.textContent.trim()),
      n: window.__sv.asm.doc.mates.length,
      z: window.__sv.asm.doc.components[1].tf[11],
    }));
  }
  const img11 = await snap(pg, "conflict");
  check("C5", conflict && Math.abs(Math.abs(conflict.z + 40) - 15) < 1e-3 && (conflict.n === 2 ? /conflict|cannot|over/i.test(`${conflict.status} ${conflict.toasts}`) : conflict.bad.length > 0),
    "a conflicting 5 mm distance: nothing moves and the app says the mate cannot hold (refused or shown red)", { pb2: !!pb2, pt2: !!pt2, conflict }, img11);
  await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
  await pg.click('#asm-pm [data-a="cancel"]').catch(() => {});

  await finish(browser, pg);
}
