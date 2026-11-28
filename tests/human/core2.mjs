// Core modelling by hand, round 2: face pick for fillets, variable/face/full round fillets, chamfer modes,
// vertex chamfer, pattern of a mirror, multi-thickness shell, hole position by dimensions, hole following
// an upstream edit, and the Russian UI of these panels.
// Test ids follow /mnt/project-files/tests/core-modelling-tests.md.
import { open, snap, cmd, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("core2");
const P = (x, y, z = 0) => screenOf(pg, [x, y, z]);
const st = () => pg.evaluate(() => {
  const m = window.__sv.model, l = m.last(), md = m.mode();
  return { feats: m.store.doc.features.map(f => f.type + ":" + f.name), v: l?.props?.volume, bad: l?.statuses.filter(s => !s.ok).map(s => s.id + ": " + s.message), warn: l?.statuses.filter(s => s.ok && s.message).map(s => s.message), mode: md.kind, focus: md.focus, draft: md.draft ? structuredClone(md.draft) : null };
});
const ok = async () => { if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok"); await idle(pg); };
const cancel = async () => { if (await pg.isVisible("#mc-cancel")) await pg.click("#mc-cancel"); await idle(pg); };
const blank = async () => { await pg.mouse.click(8, 450); await pg.keyboard.press("Escape"); await pg.waitForTimeout(150); };
const num = async (key, v) => {
  await idle(pg);
  for (let k = 0; k < 3; k++) {
    const e = await pg.$(`#mc-pm input[data-num="${key}"], #mc-pm input[data-int="${key}"]`);
    if (!e) return false;
    try { await e.fill(String(v)); await e.press("Tab"); await idle(pg); return true; } catch { await pg.waitForTimeout(300); }
  }
  return false;
};
const listIn = async (sel, v) => { const e = await pg.$(`#mc-pm ${sel}`); if (!e) return false; await e.fill(String(v)); await e.press("Enter"); await idle(pg); return true; };
const near = (a, b, tol = 1) => typeof a === "number" && Math.abs(a - b) <= tol;
const toasts = () => pg.$$eval(".toast", els => els.map(e => e.textContent.trim()));
const cyls = () => pg.evaluate(() => (window.__sv.viewer.parts[0]?.data.faces ?? []).filter(f => f.type === "cylinder").map(f => ({ c: f.center.map(v => Math.round(v * 100) / 100), r: f.radius && Math.round(f.radius * 100) / 100 })));
const rowOf = name => pg.locator("#mc-tree .ft-row", { hasText: name }).first();
const menuPick = async (name, label) => {
  const id = await pg.evaluate(n => window.__sv.model.store.doc.features.find(f => f.name === n)?.id, name);
  await pg.locator(`#mc-tree .ft-row[data-id="${id}"]`).click({ button: "right" });
  await pg.waitForTimeout(200);
  const items = await pg.$$eval("#mc-menu button", els => els.map(e => e.textContent.trim()));
  const i = items.findIndex(t => t === label || t.startsWith(label));
  if (i < 0) { await pg.keyboard.press("Escape"); return items; }
  await pg.locator("#mc-menu button").nth(i).click();
  await pg.waitForTimeout(600);
  await idle(pg);
  return true;
};
const V0 = 100 * 60 * 20;
let S;

// ---------- A4: a face click adds all its edges ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, await P(25, 12, 20));
await idle(pg);
S = await st();
const a4n = S.draft?.edges?.length;
await num("radius", 2);
const imgA4 = await snap(pg, "fillet-face");
await ok();
S = await st();
const lossA4 = 4 * (1 - Math.PI / 4) * (2 * 100 + 2 * 60);
check("A4", a4n === 4 && !S.bad.length && near(S.v, V0 - lossA4, 6), "a click on the top face adds its 4 edges; ✓ rounds them all", { edges: a4n, v: S.v, want: V0 - lossA4, bad: S.bad }, imgA4);
await blank();

// ---------- A11: variable radius on one edge ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, await P(10, -30, 20));
await idle(pg);
await pg.check('#mc-pm input[data-k="variable"]').catch(e => console.log("variable", e.message.split("\n")[0]));
await idle(pg);
const er = await listIn('input[data-er="0"]', 2);
const er2 = await listIn('input[data-er2="0"]', 6);
S = await st();
const a11d = S.draft;
const prevA11 = await pg.evaluate(() => !!window.__sv.model.last()?.preview?.position?.length);
const callA11 = await pg.$$eval(".mc-vcall, .mc-callout", els => els.map(e => e.textContent.trim()));
const imgA11 = await snap(pg, "variable-fillet");
const fit11 = await pg.evaluate(() => { const l = document.querySelector("#mc-pm .pm-items")?.getBoundingClientRect(), i = document.querySelector('#mc-pm input[data-er2="0"]')?.parentElement?.getBoundingClientRect(); return l && i ? { list: Math.round(l.right), row: Math.round(i.right) } : null; });
check("A11-fit", fit11 && fit11.row <= fit11.list, "the start (a) and end (b) radius fields fit inside the panel's list", fit11, imgA11);
await ok();
S = await st();
// Linear radius 2 → 6 along 100 mm: loss ≈ (1 − π/4)·∫r² = (1 − π/4)·100·(4 + 12 + 36)/3
const lossA11 = (1 - Math.PI / 4) * 100 * (4 + 12 + 36) / 3;
check("A11", er && er2 && a11d?.variable && !S.bad.length && near(S.v, V0 - lossA11, 15), "Variable radius 2 → 6 mm along one edge: start and end radius typed in the list, preview, ✓", { er, er2, edge: a11d?.edges?.[0] && { r: a11d.edges[0].r, r2: a11d.edges[0].r2 }, prev: prevA11, callouts: callA11, v: S.v, want: V0 - lossA11, bad: S.bad }, imgA11);
await blank();

// ---------- A12: face fillet between two face sets ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await pg.selectOption('#mc-pm select[data-k="kind"]', "face").catch(e => console.log("kind", e.message.split("\n")[0]));
await idle(pg);
S = await st();
const a12focus = S.focus;
await clickAt(pg, await P(20, 10, 20)); // top
await idle(pg);
S = await st();
const a12f1 = S.draft?.faces1?.length, a12focus2 = S.focus;
const a12hint = await pg.$eval("#mc-status", e => e.textContent);
check("A12-hint", /face set 2/.test(a12hint), "the status line says the next click goes to face set 2", { hint: a12hint });
await clickAt(pg, await P(20, -30, 8)); // front
await idle(pg);
await num("radius", 5);
S = await st();
const a12d = S.draft;
const imgA12 = await snap(pg, "face-fillet");
await ok();
S = await st();
const lossA12 = 25 * (1 - Math.PI / 4) * 100;
check("A12", a12d?.faces1?.length === 1 && a12d?.faces2?.length === 1 && !S.bad.length && near(S.v, V0 - lossA12, 3), "Face fillet: top face as set 1, front face as set 2 (focus moves on by itself), r 5 rounds the edge between", { focus: a12focus, f1: a12f1, focusAfter1: a12focus2, f2: a12d?.faces2?.length, v: S.v, want: V0 - lossA12, bad: S.bad }, imgA12);
await blank();

// ---------- A13: full round fillet on a rib 100 × 10 × 20 ----------
await makeBlock(pg, 100, 10, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await pg.selectOption('#mc-pm select[data-k="kind"]', "full").catch(e => console.log("kind", e.message.split("\n")[0]));
await idle(pg);
await clickAt(pg, await P(20, -5, 8)); // side 1 (front)
await idle(pg);
await clickAt(pg, await P(20, 0, 20)); // centre (top)
await idle(pg);
S = await st();
const a13mid = { f1: S.draft?.faces1?.length, c: S.draft?.center?.length, focus: S.focus };
// The back face cannot be seen from the default view: turn the view 180° (Shift+← twice), then click it.
await pg.mouse.move(700, 450);
await pg.evaluate(() => document.activeElement?.blur?.());
for (let k = 0; k < 2; k++) { await pg.keyboard.press("Shift+ArrowLeft"); await pg.waitForTimeout(700); }
await clickAt(pg, await P(20, 5, 8));
await idle(pg);
S = await st();
const a13d = S.draft;
const imgA13 = await snap(pg, "full-round");
await ok();
S = await st();
const lossA13 = (10 * 5 - Math.PI * 25 / 2) * 100;
check("A13", a13d?.faces1?.length === 1 && a13d?.center?.length === 1 && a13d?.faces2?.length === 1 && !S.bad.length && near(S.v, 100 * 10 * 20 - lossA13, 5), "Full round fillet on a 10 mm rib: side, top, side → a half round top", { mid: a13mid, f2: a13d?.faces2?.length, v: S.v, want: 100 * 10 * 20 - lossA13, bad: S.bad }, imgA13);
await blank();

// ---------- B2: distance and angle; two distances with Flip ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Chamfer");
await pg.waitForTimeout(400);
await clickAt(pg, await P(10, -30, 20));
await idle(pg);
await pg.selectOption('#mc-pm select[data-k="mode"]', "angle").catch(e => console.log("mode", e.message.split("\n")[0]));
await idle(pg);
await num("distance", 4);
await num("angle", 30);
const imgB2a = await snap(pg, "chamfer-angle");
await ok();
S = await st();
// 4 mm on one face, 4·tan 30° on the other
const lossB2a = 4 * 4 * Math.tan(Math.PI / 6) / 2 * 100;
check("B2-angle", !S.bad.length && near(S.v, V0 - lossB2a, 3), "Distance and angle 4 mm × 30°", { v: S.v, want: V0 - lossB2a, bad: S.bad }, imgB2a);
const chName = S.feats.at(-1).split(":")[1];
await menuPick(chName, "Edit feature");
await pg.selectOption('#mc-pm select[data-k="mode"]', "two").catch(e => console.log("mode", e.message.split("\n")[0]));
await idle(pg);
await num("distance", 2);
await num("distance2", 6);
S = await st();
const sideAt = () => pg.$$eval('#mc-layer .mc-callout[data-side]', els => els.map(e => [e.dataset.side, e.textContent, Math.round(e.getBoundingClientRect().y)]));
const side0 = await sideAt();
const zmin0 = await pg.evaluate(() => [...(window.__sv.model.last()?.preview?.position ?? [])].reduce((m, v, i) => i % 3 === 2 ? Math.min(m, v) : m, 1e9));
await pg.check('#mc-pm input[data-k="flip"]').catch(e => console.log("flip", e.message.split("\n")[0]));
await idle(pg);
const zmin1 = await pg.evaluate(() => [...(window.__sv.model.last()?.preview?.position ?? [])].reduce((m, v, i) => i % 3 === 2 ? Math.min(m, v) : m, 1e9));
const imgB2b = await snap(pg, "chamfer-two-flip");
const side1 = await sideAt();
const y = (l, k) => l.find(x => x[0] === k)?.[2];
check("B2-labels", side0.length === 2 && side1.length === 2 && Math.abs(y(side0, "d1") - y(side1, "d1")) > 8, "D1 and D2 callouts sit on their own faces; Flip direction moves D1 to the other face", { side0, side1 }, imgB2b);
await ok();
S = await st();
check("B2-two", !S.bad.length && near(S.v, V0 - 6 * 100, 3) && Math.abs(zmin0 - zmin1) > 3, "Two distances 2 and 6 mm; Flip direction swaps which face takes 6 (preview drops from z 18 to z 14 or back)", { v: S.v, want: V0 - 600, zmin0, zmin1, bad: S.bad }, imgB2b);
await blank();

// ---------- B3: vertex chamfer ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Chamfer");
await pg.waitForTimeout(400);
await pg.selectOption('#mc-pm select[data-k="mode"]', "vertex").catch(e => console.log("mode", e.message.split("\n")[0]));
await idle(pg);
await num("distance", 6);
await num("distance2", 6);
await num("distance3", 6);
await clickAt(pg, await P(46, -30, 20)); // top front edge near the right front corner
await idle(pg);
S = await st();
const b3d = S.draft;
const imgB3 = await snap(pg, "vertex-chamfer");
await ok();
S = await st();
check("B3", b3d?.vertices?.length === 1 && !S.bad.length && near(S.v, V0 - 216 / 6, 1), "Vertex chamfer 6/6/6 on a corner: a tetrahedron (36 mm³) cut off", { vertices: b3d?.vertices?.length, v: S.v, want: V0 - 36, bad: S.bad }, imgB3);
await blank();

// ---------- C9: pattern of a mirror ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(-35, -15, 20)); await idle(pg);
await clickAt(pg, await P(-35, -15, 20)); await idle(pg);
if ((await st()).mode === "sketch") await ok();
await ok();
await blank();
S = await st();
const oneHole = V0 - S.v;
const holeName = S.feats.find(f => f.startsWith("hole")).split(":")[1];
await rowOf(holeName).click();
await cmd(pg, "Mirror");
await pg.waitForTimeout(600);
await pg.click('#mc-pm [data-focus="mplane"]').catch(() => {});
if (!(await rowOf("Right (YZ)").isVisible())) await pg.click(".mc-treefly-h").catch(() => {});
await rowOf("Right (YZ)").click();
await idle(pg);
await ok();
await blank();
S = await st();
const mirName = S.feats.at(-1).split(":")[1];
const mirOk = near(S.v, V0 - 2 * oneHole, 2);
await rowOf(mirName).click();
await cmd(pg, "Linear pattern");
await pg.waitForTimeout(600);
S = await st();
const c9seed = S.draft?.features;
await pg.click('#mc-pm [data-focus="dir"]').catch(() => {});
await clickAt(pg, await P(50, 0, 10)); // right vertical-ish? the right face's top edge runs along Y
await idle(pg);
await clickAt(pg, await P(50, 5, 20));
await idle(pg);
await num("spacing", 25);
await num("count", 2);
S = await st();
const c9d = S.draft;
const imgC9 = await snap(pg, "pattern-of-mirror");
await ok();
S = await st();
check("C9", mirOk && !S.bad.length && near(S.v, V0 - 4 * oneHole, 3), "a linear pattern of a mirror (hole mirrored about Right, then the mirror patterned along Y): 4 holes", { seed: c9seed, dir: !!c9d?.dir, flip: c9d?.flip, v: S.v, want: V0 - 4 * oneHole, bad: S.bad, warn: S.warn }, imgC9);
await blank();

// ---------- D4: multi-thickness shell ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Shell");
await pg.waitForTimeout(500);
await clickAt(pg, await P(30, -18, 20));
await idle(pg);
await num("thickness", 2);
await pg.click('#mc-pm [data-focus="mthick"]').catch(e => console.log("mthick", e.message.split("\n")[0]));
await idle(pg);
await clickAt(pg, await P(20, -30, 8)); // front wall
await idle(pg);
await listIn('input[data-mt="0"]', 5);
S = await st();
const d4d = S.draft;
const imgD4 = await snap(pg, "multi-thickness");
const mtc = await pg.$$eval("#mc-layer .mc-mtcall", els => els.map(e => e.textContent));
check("D4-callout", mtc.length === 1 && /5/.test(mtc[0]), "the thicker wall shows its own thickness on the model", { mtc }, imgD4);
await ok();
S = await st();
const wantD4 = V0 - 96 * 53 * 18;
check("D4", d4d?.multi?.length === 1 && !S.bad.length && near(S.v, wantD4, 5), "Multi-thickness: 2 mm walls, the front wall 5 mm", { multi: d4d?.multi?.map(x => x.t), v: S.v, want: wantD4, bad: S.bad }, imgD4);
await blank();

// ---------- E4: hole position by dimensions to the edges ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(-30, -10, 20)); await idle(pg);
await pg.waitForTimeout(500);
S = await st();
const e4mode = S.mode;
const ptsOf = () => pg.evaluate(() => window.__sv.model.editor()?.sk.ents.filter(e => e.t === "point" && !e.cons).map(e => [e.x, e.y]) ?? []);
let pts = await ptsOf();
// Smart Dimension: the point, then the left model edge, placed left of it, typed 20.
await pg.click('#mc-tools [data-c="sk:dim"]');
await pg.waitForTimeout(150);
await clickAt(pg, await P(-30, -10, 20));
await clickAt(pg, await P(-50, 10, 20));
await clickAt(pg, await P(-40, 22, 20));
await pg.waitForTimeout(400);
let box = await pg.$(".mod-in");
const e4box1 = !!box;
if (box) { await box.fill("15"); await box.press("Enter"); await pg.waitForTimeout(500); }
await idle(pg);
// Then the point (now 15 mm from the left edge) and the front edge, typed 12.
const pts1 = await ptsOf();
await clickAt(pg, await P(-35, -10, 20));
await clickAt(pg, await P(10, -30, 20));
await clickAt(pg, await P(-15, -22, 20));
await pg.waitForTimeout(400);
box = await pg.$(".mod-in");
const e4box2 = !!box;
if (box) { await box.fill("12"); await box.press("Enter"); await pg.waitForTimeout(500); }
await idle(pg);
const e4dims = await pg.evaluate(() => window.__sv.model.editor()?.sk.dims.map(d => ({ k: d.k ?? d.kind, v: d.val?.v ?? d.v })) ?? []);
const imgE4a = await snap(pg, "hole-dims");
await pg.keyboard.press("Escape");
await ok(); // sketch
await pg.waitForTimeout(400);
// a blind hole 8 deep, so E5 can tell whether it starts on the top face
await pg.click('#mc-pm [data-htab="type"]').catch(() => {});
await pg.selectOption('#mc-pm select[data-k="end"]', "blind").catch(e => console.log("end", e.message.split("\n")[0]));
await num("depth", 8);
await ok(); // hole
S = await st();
const c4 = await cyls();
const e4c = c4[0]?.c;
check("E4", e4mode === "sketch" && e4box1 && e4box2 && e4c && near(e4c[0], -35, 0.05) && near(e4c[1], -18, 0.05) && !S.bad.length, "position sketch: dimensions 15 mm to the left edge and 12 mm to the front edge place the hole at (−35, −18)", { e4mode, pts, pts1, dims: e4dims, cyl: c4, bad: S.bad }, imgE4a);
await blank();

// ---------- E5: a hole on a face moved by an upstream edit follows it ----------
const hName = (await st()).feats.find(f => f.startsWith("hole")).split(":")[1];
const hf = await pg.evaluate(n => window.__sv.model.store.doc.features.find(f => f.name === n), hName);
await menuPick("Extrude1", "Edit feature");
await num("depth", 30);
await ok();
S = await st();
const c5 = await cyls();
const top5 = c5[0] ? c5[0].c[2] : null;
const blind = hf?.end === "blind" || !hf?.end;
const hd = hf?.depth?.v;
// A blind hole of depth d from the top: the cylinder's middle is at 30 − d/2; through all: middle at 15.
const want5 = blind ? 30 - hd / 2 : 15;
check("E5", !S.bad.length && near(top5, want5, 0.2) && near(c5[0]?.c[0], -35, 0.05), "Extrude 20 → 30: the hole (and its position) moves up with the top face", { end: hf?.end, depth: hd, cyl: c5, want: want5, bad: S.bad }, await snap(pg, "hole-followed"));
// also the left edge moved: widen the base sketch: the dimensioned hole keeps 15 mm from the new left edge
await blank();

// ---------- F11: Russian UI of these panels ----------
const latin = () => pg.evaluate(() => {
  const out = [];
  // key names (Enter, Esc, Ctrl…) stay as on the keyboard
  const english = s => /[A-Za-z]{3,}/.test(s.replace(/\b(Enter|Esc|Ctrl|Shift|Alt|Tab|Delete)\b/g, ""));
  const walk = el => {
    if (el.closest?.("[translate=no]")) return;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const s = n.textContent.trim(); if (english(s) && !/^(mm|deg|M\d|ISO|DIN|Ø)/.test(s)) out.push(s); }
      else if (n.nodeType === 1 && getComputedStyle(n).display !== "none") walk(n);
    }
    for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute?.(a); if (v && english(v) && !el.closest("[translate=no]")) out.push(`@${a}=${v}`); }
  };
  const pm = document.querySelector("#mc-pm"); if (pm) walk(pm);
  return [...new Set(out)];
});
await makeBlock(pg, 100, 60, 20);
await blank();
await pg.click("#lang-btn");
await pg.waitForTimeout(500);
const lang = await pg.evaluate(() => document.documentElement.lang);
const found = {};
const panels = [["Скругление", "fillet"], ["Фаска", "chamfer"], ["Оболочка", "shell"], ["Отверстие", "hole"], ["Линейный массив", "lpattern"], ["Круговой массив", "cpattern"], ["Зеркальное отражение", "mirror"]];
for (const [label, key] of panels) {
  try { await cmd(pg, label); } catch { found[key] = ["(command not found: " + label + ")"]; continue; }
  await pg.waitForTimeout(600);
  if (key === "fillet") {
    await clickAt(pg, await P(10, -30, 20)); await idle(pg);
    found[key] = await latin();
    for (const k of ["variable", "multi"]) { await pg.check(`#mc-pm input[data-k="${k}"]`).catch(() => {}); await idle(pg); found[key].push(...await latin()); await pg.uncheck(`#mc-pm input[data-k="${k}"]`).catch(() => {}); await idle(pg); }
    for (const v of ["face", "full"]) { await pg.selectOption('#mc-pm select[data-k="kind"]', v).catch(() => {}); await idle(pg); found[key].push(...await latin()); }
  } else if (key === "chamfer") {
    found[key] = await latin();
    for (const v of ["two", "angle", "offset", "vertex"]) { await pg.selectOption('#mc-pm select[data-k="mode"]', v).catch(() => {}); await idle(pg); found[key].push(...await latin()); }
  } else if (key === "hole") {
    await clickAt(pg, await P(0, 0, 20)); await idle(pg);
    if ((await st()).mode === "sketch") await ok();
    found[key] = await latin();
    for (const v of ["cbore", "csink", "tapped", "slot"]) { await pg.selectOption('#mc-pm select[data-k="kind"]', v).catch(() => {}); await idle(pg); found[key].push(...await latin()); }
  } else found[key] = await latin();
  found[key] = [...new Set(found[key])];
  await snap(pg, `ru-${key}`);
  await cancel();
  if ((await st()).mode === "sketch") { await pg.keyboard.press("Escape"); await cancel(); }
  await blank();
}
const left = Object.entries(found).filter(([, v]) => v.length);
check("F11", lang === "ru" && !left.length, "Russian UI: no English left in the fillet, chamfer, shell, hole, pattern and mirror panels", { lang, left: Object.fromEntries(left) });

await finish(browser, pg);
