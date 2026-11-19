// Selection features of the gap list, done by hand: sizes of the selection in the status bar (M3), the
// selection list (U2), preselection for more commands (M10), the face's edges projected into a new sketch
// (S12) and sketch tool cursors (U4).
import { open, snap, cmd, idle, clickAt, check, finish, makeBlock } from "./lib.mjs";
/** Ctrl+click, the way a person does it: hold Ctrl, click, let go. */
const ctrlClick = async (pg, at) => { await pg.keyboard.down("Control"); await clickAt(pg, at); await pg.keyboard.up("Control"); };
const { browser, pg } = await open("select");
await makeBlock(pg, 100, 60, 20);
await pg.keyboard.press("Escape");
await pg.evaluate(() => window.__sv.viewer.setStandardView?.("iso"));
await pg.waitForTimeout(700);

/** Screen point of a face by a test on its normal (n) in world axes, the one the camera sees. */
const faceWith = n => pg.evaluate(n => {
  const v = window.__sv.viewer, part = v.parts[0], r = v.renderer.domElement.getBoundingClientRect();
  const i = part.data.faces.findIndex(f => f.type === "plane" && f.normal && f.normal.every((c, k) => Math.abs(c - n[k]) < 1e-3));
  const f = part.data.faces[i];
  const s = v.toWorld(part, f.center).clone().project(v.camera);
  return { i, at: [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height] };
}, n);
const P = p => pg.evaluate(p => {
  const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
}, p);
const stSel = () => pg.evaluate(() => { const e = document.getElementById("st-sel"); return e && !e.hidden ? e.textContent : ""; });
const away = async () => { await pg.mouse.click(5, 300); await pg.keyboard.press("Escape"); await pg.waitForTimeout(150); };

// The camera's side faces: whichever of ±Y the iso view sees.
const top = await faceWith([0, 0, 1]);
const cam = await pg.evaluate(() => window.__sv.viewer.camera.position.toArray());
const front = await faceWith([0, cam[1] < 0 ? -1 : 1, 0]);
const ySide = cam[1] < 0 ? -30 : 30;

// M3: one click on the top face; Esc; one click on an edge.
await clickAt(pg, top.at);
const s1 = await stSel();
const img1 = await snap(pg, "status-face");
await away();
await clickAt(pg, await P([0, ySide, 20]));
const s2 = await stSel();
const img2 = await snap(pg, "status-edge");
check("M3-face", /Face: Area 6,000 mm²/.test(s1), "clicking the top face shows its area in the status bar", { s1 }, img1);
check("M3-edge", /Edge: Length 100\.000 mm/.test(s2), "clicking the 100 mm edge shows its length in the status bar", { s2 }, img2);
await away();
check("M3-clear", !(await stSel()), "clicking empty space clears it", {});

// U2 + M3: top face, then Ctrl+click the side face → the list shows both, the status bar the summed area.
await clickAt(pg, top.at);
await ctrlClick(pg, front.at);
await pg.waitForTimeout(200);
const rows = () => pg.$$eval("#mc-sellist li", els => els.map(e => e.textContent.replace("×", "").trim()));
const r1 = await rows(), s3 = await stSel();
const img3 = await snap(pg, "selection-list");
check("U2-list", r1.length === 2 && r1.every(x => /Planar face/.test(x)), "Ctrl+click: the selection list shows both faces with the feature that made them", { r1 }, img3);
check("M3-sum", /2 faces: total area 8,000 mm²/.test(s3), "the status bar sums the two faces' areas (6,000 + 2,000)", { s3 });
// × on the second row takes it out.
await pg.locator("#mc-sellist li").nth(1).locator("button").click();
await pg.waitForTimeout(200);
const r2 = await rows(), n2 = await pg.evaluate(() => window.__sv.modeller.multiCount);
const img4 = await snap(pg, "selection-list-removed");
check("U2-remove", r2.length === 1 && n2.faces === 1 && /Face: Area 6,000/.test(await stSel()), "× on a row takes that face out of the selection", { r2, n2 }, img4);

// M10: with top + front selected, Fillet takes every edge of both faces (4 + 4 − 1 shared = 7).
await ctrlClick(pg, front.at);
await pg.waitForTimeout(150);
await cmd(pg, "Fillet");
await pg.waitForTimeout(600);
const fe = await pg.evaluate(() => { const m = window.__sv.model.mode(); return { kind: m.kind, type: m.draft?.type, n: m.draft?.edges?.length }; });
const img5 = await snap(pg, "fillet-preselected");
check("M10-fillet", fe.type === "fillet" && fe.n === 7, "two faces selected, then Fillet: every edge of both faces is in the fillet", fe, img5);
await pg.keyboard.press("Escape");
await idle(pg);
await away();
// The list goes when a command starts.
check("U2-gone", !(await pg.$("#mc-sellist")), "the selection list closes once the selection is used", {});

// M10: the top face, then Mirror → mirror plane = that face.
await clickAt(pg, top.at);
await cmd(pg, "Mirror");
await pg.waitForTimeout(600);
const mi = await pg.evaluate(() => { const m = window.__sv.model.mode(); return { type: m.draft?.type, plane: m.draft?.plane }; });
const img6 = await snap(pg, "mirror-preselected");
check("M10-mirror", mi.type === "mirror" && !!mi.plane?.face, "a face selected, then Mirror: the face is the mirror plane", mi, img6);
await pg.keyboard.press("Escape");
await idle(pg);
await away();
// M10: an edge, then Linear Pattern → its direction.
await clickAt(pg, await P([0, ySide, 20]));
await cmd(pg, "Linear pattern");
await pg.waitForTimeout(600);
const lp = await pg.evaluate(() => { const m = window.__sv.model.mode(); return { type: m.draft?.type, dir: m.draft?.dir }; });
const img7 = await snap(pg, "lpattern-preselected");
check("M10-lpattern", lp.type === "lpattern" && !!lp.dir?.edge, "an edge selected, then Linear Pattern: the edge is Direction 1", lp, img7);
await pg.keyboard.press("Escape");
await idle(pg);
await away();

// S12: Settings ▸ Sketch ▸ Project the face's edges, then a sketch on the top face.
await pg.click("#settings-btn");
await pg.waitForTimeout(300);
await pg.click("#pt-sketch");
await pg.waitForTimeout(150);
await pg.getByLabel("Project the face's edges").check();
const img8 = await snap(pg, "settings-project");
await pg.click('#prefs-dlg [data-a="ok"]');
await pg.waitForTimeout(200);
await clickAt(pg, top.at);
await cmd(pg, "Sketch");
await pg.waitForTimeout(1500);
await idle(pg);
const sk = await pg.evaluate(() => {
  const m = window.__sv.model.mode();
  const s = m.kind === "sketch" ? m.editor.sk : null;
  return s ? { lines: s.ents.filter(e => e.t === "line").length, cons: s.ents.filter(e => e.t === "line" && e.cons).length, ext: s.rels.filter(r => r.t === "fix" && r.ext).length } : null;
});
const img9 = await snap(pg, "sketch-projected");
check("S12", sk?.lines === 4 && sk.cons === 4 && sk.ext === 4, "a new sketch on the top face starts with its 4 edges as construction lines tied to them", sk, img9);

// U4: the line tool and Trim change the cursor.
const cur = () => pg.evaluate(() => { const c = window.__sv.viewer.renderer.domElement; return { tool: c.dataset.tool ?? "", css: getComputedStyle(c).cursor.slice(0, 30) }; });
await pg.click('#mc-tools [data-c="sk:line"]');
await pg.mouse.move(700, 450);
const u1 = await cur();
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-fly="trim"]').catch(() => {});
await pg.waitForTimeout(150);
const trimBtn = pg.locator('#mc-menu button', { hasText: /^Trim/ });
if (await trimBtn.count()) await trimBtn.first().click(); else await pg.click('#mc-tools [data-c="sk:trim"]');
const u2 = await cur();
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
const u3 = await cur();
check("U4", u1.tool === "line" && u1.css.startsWith("url(") && u2.tool === "trim" && u2.css.startsWith("url(") && !u3.tool, "the cursor shows a pencil with a line for Line, scissors for Trim, and the arrow again for Select", { u1, u2, u3 });
await finish(browser, pg);
