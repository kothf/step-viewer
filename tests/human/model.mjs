// Part features of the gap list, done by hand: Hide/Show items (M4), face/feature colours (M2), push/pull (M1),
// Tangent edges (M7).
import { open, snap, cmd, idle, screenOf, clickAt, check, finish } from "./lib.mjs";
const { browser, pg } = await open("model");
const P = (x, y, z = 0) => screenOf(pg, [x, y, z]);
const tool = async c => { await pg.click(`#mc-tools [data-c="${c}"]`); await pg.waitForTimeout(100); };
const last = () => pg.evaluate(() => { const m = window.__sv.model, l = m.last(); return { feats: m.store.doc.features.map(f => f.type + ":" + f.name), v: l?.props?.volume, bad: l?.statuses.filter(s => !s.ok).map(s => s.message) }; });

await pg.click("#new-part");
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await tool("sk:rect");
await clickAt(pg, await P(-50, -30));
await clickAt(pg, await P(50, 30));
await pg.keyboard.press("Escape");
await tool("extrude");
await pg.waitForTimeout(800);
const depth = await pg.$('#mc-pm input[data-num="depth"]');
await depth.fill("20"); await depth.press("Enter");
await idle(pg);
await snap(pg, "extrude-panel");
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
let L = await last();
check("extrude", Math.abs(L.v - 100 * 60 * 20) < 1, "rectangle sketched and extruded 20 mm by hand", L);
// Isometric view from the view bar.
await pg.keyboard.press("Escape");
await pg.evaluate(() => window.__sv.viewer.setStandardView?.("iso"));
await pg.waitForTimeout(700);
await snap(pg, "block");

// M4: heads-up eye menu, Planes off.
const planes = () => pg.evaluate(() => window.__sv.modeller.planeMeshes.filter(m => m.visible !== false).length);
const p0 = await planes();
await pg.click('#hud [data-hud="items"]');
await pg.waitForTimeout(150);
const img1 = await snap(pg, "hide-show-items");
await pg.getByLabel("Planes").uncheck();
await pg.waitForTimeout(200);
const p1 = await planes();
const on = await pg.evaluate(() => document.querySelector('#hud [data-hud="items"]').classList.contains("on"));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(150);
const img2 = await snap(pg, "planes-hidden");
await pg.click('#hud [data-hud="items"]');
await pg.getByLabel("Planes").check();
await pg.keyboard.press("Escape");
const p2 = await planes();
check("M4", p0 >= 3 && p1 === 0 && on && p2 === p0, "Hide/Show items: Planes off hides every plane, the button shows it is on", { p0, p1, on, p2 }, img2);

// M2: right-click the top face → Face colour…, pick red in the colour picker.
const faceAt = async name => pg.evaluate(name => {
  const v = window.__sv.viewer, part = v.parts[0], n = window.__sv.model.last().faceNames, f = part.data.faces[n.indexOf(name)];
  const s = v.toWorld(part, f.center).clone().project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height];
}, name);
const colourOf = name => pg.evaluate(name => { const n = window.__sv.model.last().faceNames, fs = window.__sv.viewer.parts[0].data.faces; return fs[n.indexOf(name)]?.color; }, name);
const TOP = await pg.evaluate(() => window.__sv.model.last().faceNames.find(n => n.endsWith(":end")));
const topAt = await faceAt(TOP);
const pickColour = async (label, hex) => {
  await clickAt(pg, topAt, { button: "right" });
  await pg.waitForTimeout(250);
  const items = await pg.$$eval("#mc-menu button", els => els.map(e => e.textContent.trim()));
  const shot = await snap(pg, "menu-" + label.replace(/\W+/g, ""));
  const i = items.indexOf(label);
  if (i < 0) { await pg.keyboard.press("Escape"); return { items, shot }; }
  await pg.locator("#mc-menu button").nth(i).click();
  await pg.waitForTimeout(150);
  // What the colour picker does when a colour is chosen.
  const ok = await pg.evaluate(hex => { const inp = [...document.querySelectorAll('input[type="color"]')].at(-1); if (!inp) return false; inp.value = hex; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); return true; }, hex);
  await idle(pg);
  return { items, shot, ok };
};
const a = await pickColour("Feature colour…", "#ff0000");
const sideName = await pg.evaluate(() => window.__sv.model.last().faceNames.find(n => n.includes(":side:")));
const c1 = { top: await colourOf(TOP), side: await colourOf(sideName) };
const b = await pickColour("Face colour…", "#0000ff");
const c2 = { top: await colourOf(TOP), side: await colourOf(sideName) };
const img3 = await snap(pg, "colours");
const same = (x, y) => !!x && x.every((v, i) => Math.abs(v - y[i]) < 0.02);
check("M2", a.ok && b.ok && same(c1.top, [1, 0, 0]) && same(c1.side, [1, 0, 0]) && same(c2.top, [0, 0, 1]) && same(c2.side, [1, 0, 0]), "right-click Feature colour… paints the block red, Face colour… paints the top blue", { a: a.items, c1, c2 }, img3);
const r = await pickColour("Remove appearance", "");
const c3 = await colourOf(TOP);
check("M2-remove", same(c3, [1, 0, 0]), "Remove appearance on the top face takes its own colour off (back to the feature's red)", { c3, items: r.items });
// Undo takes the removal back.
await pg.keyboard.press("Control+z");
await idle(pg);
check("M2-undo", same(await colourOf(TOP), [0, 0, 1]), "Ctrl+Z brings the face colour back", { c: await colourOf(TOP) });

// M1: click the top, drag the arrow up.
await pg.mouse.click(5, 300);
await clickAt(pg, topAt);
await pg.waitForTimeout(300);
const arrow = await pg.evaluate(() => {
  const v = window.__sv.viewer, a = window.__sv.modeller.arrows.find(x => x.key === "push");
  if (!a) return null;
  const r = v.renderer.domElement.getBoundingClientRect();
  const sc = p => { const s = p.clone().project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; };
  return { at: sc(a.base.clone().addScaledVector(a.dir, a.scale * 0.9)), up: sc(a.base.clone().addScaledVector(a.dir, a.scale * 0.9 + 10)) };
});
const img4 = await snap(pg, "push-arrow");
let pushed = null;
if (arrow) {
  await pg.mouse.move(...arrow.at); await pg.waitForTimeout(100);
  await pg.mouse.down();
  for (let k = 1; k <= 8; k++) { await pg.mouse.move(arrow.at[0] + ((arrow.up[0] - arrow.at[0]) * k) / 8, arrow.at[1] + ((arrow.up[1] - arrow.at[1]) * k) / 8); await pg.waitForTimeout(80); }
  await pg.waitForTimeout(300);
  const during = await pg.evaluate(() => { const m = window.__sv.model.mode(); return { kind: m.kind, d: m.draft?.distance?.v, label: document.querySelector("#mc-pushval")?.textContent, labelShown: !!document.querySelector("#mc-pushval")?.offsetParent, vcall: [...document.querySelectorAll(".mc-vcall")].map(e => e.textContent), busy: !document.querySelector("#mc-busy").hidden, v: window.__sv.model.last()?.props?.volume }; });
  check("M1-live", during.labelShown && /\d/.test(during.label) && !during.label.startsWith("0 ") && !during.vcall.length && Math.abs(during.v - 6000 * (20 + during.d)) < 1, "while dragging, the face moves live and the distance shows by the arrow", during);
  await snap(pg, "push-dragging");
  await pg.mouse.up();
  await idle(pg);
  pushed = await pg.evaluate(() => { const m = window.__sv.model, f = m.store.doc.features.at(-1); return { type: f.type, d: f.distance?.v, v: m.last().props.volume }; });
}
const img5 = await snap(pg, "pushed");
check("M1", pushed?.type === "moveface" && pushed.d > 2 && Math.abs(pushed.v - 6000 * (20 + pushed.d)) < 1, "click the top face, drag its arrow: the face is pulled up (Move Face)", { arrow: !!arrow, pushed }, img5);

// M7: a fillet on a vertical edge, by hand: click the edge, Fillet, radius 8, OK.
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
const edgeAt = await P(50, -30, 10);
await cmd(pg, "Fillet");
await pg.waitForTimeout(500);
await clickAt(pg, edgeAt);
await pg.waitForTimeout(400);
const rad = await pg.$('#mc-pm input[data-num="radius"]');
if (rad) { await rad.fill("8"); await rad.press("Enter"); }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
L = await last();
const segs = () => pg.evaluate(() => { const p = window.__sv.viewer.parts[0]; return { drawn: p.edges.geometry.instanceCount, all: p.data.edgeSegs.length / 6, sharp: (p.data.sharpSegs ?? -6) / 6, tangent: p.data.edges.filter(e => e.tangent).length }; });
const t0 = await segs();
const img6 = await snap(pg, "fillet-tangent-on");
await pg.click("#display-btn");
await pg.waitForTimeout(150);
await snap(pg, "display-menu");
await pg.uncheck("#tangent-edges");
await pg.waitForTimeout(200);
const t1 = await segs();
await pg.keyboard.press("Escape");
await pg.mouse.click(5, 300);
const img7 = await snap(pg, "fillet-tangent-off");
check("M7", /fillet/.test(L.feats.join()) && !L.bad.length && t0.tangent >= 2 && t1.drawn === t0.sharp && t0.drawn === t0.all, "Display ▸ Tangent edges off hides the fillet's tangent edges", { feats: L.feats, t0, t1 }, img7);
await pg.click("#display-btn"); await pg.check("#tangent-edges"); await pg.keyboard.press("Escape");
await finish(browser, pg);
