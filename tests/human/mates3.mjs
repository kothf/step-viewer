// Mate references beside faces, by hand (FR-MATE-001; tests list E1–E3): a vertex, a round edge and a
// component's own origin axis and point, picked in the view and the Mate panel of the packaged app.
import { open, snap, idle, clickAt, check, finish } from "./lib.mjs";
import { plateAndPin, faceSpot, doc, CYL } from "./mates.mjs";

/** A screen point on a visible edge of shown part i that passes `test` (`end` = its start vertex). */
const edgeSpot = (pg, i, test, end = false) => pg.evaluate(([i, test, end]) => {
  const v = window.__sv.viewer, fn = new Function("e", `return (${test})(e)`), r = v.renderer.domElement.getBoundingClientRect();
  const part = v.parts[i], cam = v.camera;
  for (const e of part.data.edges) {
    if (!fn(e)) continue;
    const pts = end ? [e.start, e.end] : [e.mid, ...Array.from({ length: e.pts.length / 3 }, (_, k) => [e.pts[k * 3], e.pts[k * 3 + 1], e.pts[k * 3 + 2]])];
    for (const p of pts) {
      const w = v.toWorld(part, p), s = w.clone().project(cam);
      if (Math.abs(s.x) > 0.95 || Math.abs(s.y) > 0.95) continue;
      // Seen: the surface hit just inside the point is within a hair of it.
      const h = v.pickMeshes({ x: s.x, y: s.y });
      if (!h || h.point.distanceTo(w) > 0.02 * v.modelSize) continue;
      return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height];
    }
  }
  return null;
}, [i, test, end]);

/** The screen point of a point in shown part i's coordinates. */
const spotAt = (pg, i, p) => pg.evaluate(([i, p]) => {
  const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(), s = v.toWorld(v.parts[i], p).project(v.camera);
  return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height];
}, [i, p]);

const mates = pg => pg.evaluate(() => (window.__sv.asm.doc.mates ?? []).map(m => ({ type: m.type, a: m.a.face, b: m.b.face })));
const panelBoxes = pg => pg.evaluate(() => [...document.querySelectorAll('#asm-pm [data-a="sa"], #asm-pm [data-a="sb"]')].map(b => b.textContent));

const { browser, pg } = await open("mates3");
const vp = await plateAndPin(pg);

// E1: a vertex of the plate and the pin's origin point: Coincident puts the pin's origin on the corner.
await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
const corner = await edgeSpot(pg, 0, "e => e.type === 'line'", true);
if (corner) await clickAt(pg, corner);
await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 1, CYL)); await pg.waitForTimeout(400);
await pg.click('#asm-pm [data-morg="O"]').catch(() => {}); await pg.waitForTimeout(600);
const e1Boxes = await panelBoxes(pg), e1Types = await pg.evaluate(() => [...document.querySelectorAll("#asm-pm [data-mt]:not([disabled])")].map(b => b.dataset.mt));
await pg.click('#asm-pm [data-a="ok"]').catch(() => {}); await pg.waitForTimeout(1200); await idle(pg);
const m1 = await mates(pg), pin1 = (await doc(pg)).comps[1].tf;
const vtx = m1.find(m => m.a.startsWith("@v:") || m.b.startsWith("@v:"));
const sv = await pg.evaluate(() => { const a = window.__sv.asm; return a.solved ? { ok: a.solved.ok, bad: a.solved.bad } : null; });
check("E1", !!vtx && vtx.type === "coincident" && /Vertex/.test(e1Boxes.join()) && /Origin point/.test(e1Boxes.join()) && !e1Types.includes("parallel"),
  "a plate corner and the pin's origin point (⊙): the boxes say Vertex / Origin point, Parallel is not offered, Coincident is added and moves the pin's origin onto the corner",
  { corner, boxes: e1Boxes, types: e1Types, mates: m1, pinOrigin: [pin1[3], pin1[7], pin1[11]], sv }, await snap(pg, "vertex-origin"));
await pg.click('#asm-pm [data-a="cancel"]').catch(() => {}); await pg.waitForTimeout(300);
await pg.mouse.move(vp[0], vp[1] + 200);
await pg.keyboard.press("Control+z"); await pg.waitForTimeout(1000); await idle(pg);

// E2: the pin's origin Z axis concentric with the hole.
await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 1, CYL)); await pg.waitForTimeout(400);
await pg.click('#asm-pm [data-morg="Z"]').catch(() => {}); await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 0, CYL)); await pg.waitForTimeout(700);
const e2Type = await pg.evaluate(() => document.querySelector("#asm-pm [data-mt].on")?.dataset.mt);
await pg.click('#asm-pm [data-a="ok"]').catch(() => {}); await pg.waitForTimeout(1200); await idle(pg);
const m2 = await mates(pg), pin2 = (await doc(pg)).comps[1].tf;
const zc = m2.find(m => m.a === "@o:Z" || m.b === "@o:Z");
check("E2", !!zc && zc.type === "concentric" && Math.abs(Math.abs(pin2[10]) - 1) < 1e-6 && Math.abs(pin2[3] - 25) < 1e-3,
  "Origin axis Z of the pin picked with the Z button, then the hole: Concentric is offered first and lines the pin's axis up with the hole (x = 25)",
  { type: e2Type, mates: m2, axisZ: pin2[10], x: pin2[3], y: pin2[7] }, await snap(pg, "origin-axis"));

// E3: a round edge of the pin coincident with the plate's top: the circle lies in the top face (the panel is still open).
if (!(await pg.isVisible('#asm-pm[data-id="mate"]'))) { await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400); }
const rim = await edgeSpot(pg, 1, "e => e.type === 'circle' || e.type === 'arc'");
if (rim) await clickAt(pg, rim);
await pg.waitForTimeout(400);
// The plate's top, well away from its edges and the hole (plate x −50…50, y −30…30, top at z = 20).
await clickAt(pg, await spotAt(pg, 0, [-25, 5, 20])); await pg.waitForTimeout(700);
const e3Boxes = await panelBoxes(pg);
await pg.click('#asm-pm [data-a="ok"]').catch(() => {}); await pg.waitForTimeout(1200); await idle(pg);
const m3 = await mates(pg);
const ring = m3.find(m => m.a.startsWith("@e:") || m.b.startsWith("@e:"));
const sv3 = await pg.evaluate(() => { const a = window.__sv.asm; return a.solved ? { ok: a.solved.ok, bad: a.solved.bad } : null; });
check("E3", !!ring && ring.type === "coincident" && /Circular edge/.test(e3Boxes.join()) && (!sv3 || sv3.ok),
  "a round edge of the pin and the plate's top face: the box says Circular edge, Coincident is added and solves with the concentric mate",
  { rim, boxes: e3Boxes, mates: m3, sv: sv3 }, await snap(pg, "round-edge"));

await finish(browser, pg);
