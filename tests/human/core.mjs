// Core modelling by hand: fillet, chamfer, patterns, mirror, shell, holes and rebuild after edits upstream.
// Test ids follow /mnt/project-files/tests/core-modelling-tests.md.
import { open, snap, cmd, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("core");
const P = (x, y, z = 0) => screenOf(pg, [x, y, z]);
const st = () => pg.evaluate(() => {
  const m = window.__sv.model, l = m.last(), md = m.mode();
  return { feats: m.store.doc.features.map(f => f.type + ":" + f.name), v: l?.props?.volume, bad: l?.statuses.filter(s => !s.ok).map(s => s.id + ": " + s.message), warn: l?.statuses.filter(s => s.ok && s.message).map(s => s.message), mode: md.kind, draft: md.draft ? structuredClone(md.draft) : null };
});
const ok = async () => { if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok"); await idle(pg); };
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
const near = (a, b, tol = 1) => typeof a === "number" && Math.abs(a - b) <= tol;
const toasts = () => pg.$$eval(".toast", els => els.map(e => e.textContent.trim()));
const V0 = 100 * 60 * 20;

await makeBlock(pg, 100, 60, 20);
let S = await st();
check("setup", near(S.v, V0), "block 100×60×20 made by hand", { v: S.v });
await blank();

// ---------- A. Fillet ----------
const topFront = await P(0, -30, 20), vert = await P(50, -30, 10), topRight = await P(50, 0, 20);
await cmd(pg, "Fillet");
await pg.waitForTimeout(500);
S = await st();
check("A1-open", S.mode === "feature" && S.draft?.type === "fillet", "Fillet with nothing selected opens its panel", { mode: S.mode });
await clickAt(pg, topFront);
await idle(pg);
S = await st();
const e1 = S.draft?.edges?.length;
await clickAt(pg, topFront);
await idle(pg);
S = await st();
check("A1-toggle", e1 === 1 && S.draft?.edges?.length === 0, "a click on an edge adds it, a second click removes it", { e1, e2: S.draft?.edges?.length });
await clickAt(pg, topFront);
await num("radius", 5);
const prev = await pg.evaluate(() => ({ v: window.__sv.model.last()?.preview?.position?.length, ok: window.__sv.model.last()?.preview?.status?.ok, overlay: window.__sv.viewer.scene.getObjectsByProperty ? 0 : 0, callouts: [...document.querySelectorAll(".mc-vcall, .mc-callout")].map(e => e.textContent.trim()) }));
const imgA2 = await snap(pg, "fillet-preview");
const cut = 25 * (1 - Math.PI / 4) * 100;
check("A2", prev.v > 0 && prev.ok !== false, "the preview shows the rounded edge in see-through yellow", { tris: prev.v / 9 }, imgA2);
check("A3", prev.callouts.some(t => /5/.test(t)), "a radius callout is on the model", { callouts: prev.callouts });
await num("radius", 8);
const prev8 = await pg.evaluate(() => [...(window.__sv.model.last()?.preview?.position ?? [])].reduce((m, v, i) => i % 3 === 2 ? Math.min(m, v) : m, 1e9));
check("A2-live", near(prev8, 12, 0.2), "the preview follows a new radius (lowest point of the 8 mm round at z = 12)", { zmin: prev8 });
await num("radius", 5);
await ok();
S = await st();
check("A7", near(S.v, V0 - cut, 2) && !S.bad.length, "✓ makes the fillet with the right volume", { v: S.v, bad: S.bad });
await pg.keyboard.press("Control+z");
await idle(pg);
S = await st();
check("A14", near(S.v, V0) && !S.feats.some(f => f.startsWith("fillet")), "Ctrl+Z removes the fillet in one step", { feats: S.feats, v: S.v });
await pg.keyboard.press("Control+y");
await idle(pg);
await blank();

// A5: tangent propagation: a top edge next to the fillet takes the chain.
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, topRight);
await idle(pg);
S = await st();
check("A5", (S.draft?.edges?.length ?? 0) >= 1, "an edge picked next to an earlier fillet is added (tangent chain)", { n: S.draft?.edges?.length });
await pg.click("#mc-cancel").catch(() => {});
await idle(pg);
await blank();

// A8: radius too large.
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, vert);
await num("radius", 80);
await pg.waitForTimeout(500);
const imgA8 = await snap(pg, "fillet-too-big");
S = await st();
const ts8 = await toasts();
const pmErr = await pg.$$eval("#mc-pm .pm-err, #mc-pm .err, #mc-pm [role=alert]", els => els.map(e => e.textContent.trim()));
check("A8-msg", S.bad.length || pmErr.length || ts8.length, "a radius that cannot fit says why while the panel is open", { bad: S.bad, pmErr, ts8 }, imgA8);
await ok();
S = await st();
check("A8-stay", S.mode === "feature" && !S.bad.length && S.feats.length === 3, "✓ with a failing radius keeps the panel open with the reason and adds nothing", { mode: S.mode, bad: S.bad, feats: S.feats, ts: await toasts() });
if (S.mode === "feature") { await pg.click("#mc-cancel").catch(() => {}); await idle(pg); }
S = await st();
if (S.feats.length > 3) { await pg.keyboard.press("Control+z"); await idle(pg); }
await blank();

// A6: preselect two edges with Ctrl+click, then Fillet.
await clickAt(pg, vert);
await clickAt(pg, await P(-50, -30, 10), { modifiers: ["Control"] });
await pg.waitForTimeout(200);
await cmd(pg, "Fillet");
await pg.waitForTimeout(600);
S = await st();
check("A6", S.draft?.edges?.length === 2, "two edges picked first (click, Ctrl+click) are in the Fillet panel", { n: S.draft?.edges?.length });
await num("radius", 4);
await ok();
S = await st();
const vA6 = S.v;
check("A6-ok", !S.bad.length && S.v < V0 - cut, "both vertical edges rounded", { v: S.v, bad: S.bad });
await blank();

// A9: edit from the tree.
const rowOf = name => pg.locator(`#mc-tree .ft-row`, { hasText: name }).first();
const lastFillet = (await st()).feats.filter(f => f.startsWith("fillet")).at(-1).split(":")[1];
await rowOf(lastFillet).click({ button: "right" });
await pg.waitForTimeout(200);
const menu = await pg.$$eval("#mc-menu button", els => els.map(e => e.textContent.trim()));
const ei = menu.findIndex(t => /^Edit feature/i.test(t));
if (ei >= 0) await pg.locator("#mc-menu button").nth(ei).click(); else await pg.keyboard.press("Escape");
await pg.waitForTimeout(600);
S = await st();
const edEdges = S.draft?.edges?.length, edR = S.draft?.radius?.v;
await num("radius", 6);
await ok();
S = await st();
check("A9", ei >= 0 && edEdges === 2 && near(edR, 4, 1e-6) && S.v < vA6 && !S.bad.length, "Edit feature from the tree opens the fillet with its edges and radius; a new radius rebuilds", { menu, edEdges, edR, v: S.v });
await blank();

// A10 multiple radius (fresh block).
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, await P(0, -30, 20));
await clickAt(pg, await P(50, 0, 20));
await pg.check('#mc-pm input[data-k="multi"]').catch(() => {});
await idle(pg);
const ers = await pg.$$('#mc-pm input[data-er]');
if (ers.length >= 2) { await ers[1].fill("3"); await ers[1].press("Enter"); await idle(pg); }
const imgA10 = await snap(pg, "multi-radius");
await ok();
S = await st();
const f10 = await pg.evaluate(() => window.__sv.model.store.doc.features.at(-1));
check("A10", f10.type === "fillet" && f10.multi && f10.edges.length === 2 && !S.bad.length, "Multiple radius fillet: each edge its own radius", { edges: f10.edges?.map(e => e.r), bad: S.bad, n: ers.length }, imgA10);
await blank();

// ---------- B. Chamfer ----------
await makeBlock(pg, 100, 60, 20);
await blank();
const vBefore = (await st()).v;
await cmd(pg, "Chamfer");
await pg.waitForTimeout(400);
await clickAt(pg, await P(-50, 0, 20));
await num("distance", 3);
const vB1p = await pg.evaluate(() => window.__sv.model.last()?.preview?.position?.length ? "shown" : "none");
const imgB1 = await snap(pg, "chamfer-preview");
await ok();
S = await st();
check("B1", near(S.v, vBefore - 4.5 * 60, 3) && vB1p === "shown", "equal distance chamfer 3 mm on a 60 mm edge: preview and result", { v: S.v, want: vBefore - 270, prev: vB1p }, imgB1);
await blank();

await snap(pg, "after-AB");

// ---------- C. Hole + patterns + mirror ----------
const rowOf2 = name => pg.locator("#mc-tree .ft-row", { hasText: name }).first();
const editRow = async name => {
  const id = await pg.evaluate(n => window.__sv.model.store.doc.features.find(f => f.name === n)?.id, name);
  await pg.locator(`#mc-tree .ft-row[data-id="${id}"]`).click({ button: "right" });
  await pg.waitForTimeout(200);
  const items = await pg.$$eval("#mc-menu button", els => els.map(e => e.textContent.trim()));
  const i = items.findIndex(t => /^Edit feature/.test(t));
  if (i < 0) { await pg.keyboard.press("Escape"); return false; }
  await pg.locator("#mc-menu button").nth(i).click();
  await pg.waitForTimeout(600);
  return true;
};
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(-35, -15, 20));
await idle(pg);
await clickAt(pg, await P(-35, -15, 20));
await idle(pg);
S = await st();
const hd = S.draft;
const skPts = await pg.evaluate(() => window.__sv.model.editor()?.sk.ents.filter(e => e.t === "point" && !e.cons).length ?? -1);
check("E1-place", S.mode === "sketch" && skPts === 1, "Hole: a click on the top face opens its position sketch with the Point tool; a click places a hole", { mode: S.mode, skPts });
const imgE1 = await snap(pg, "hole-placed");
const holeMode = S.mode;
if (S.mode === "sketch") { await ok(); await pg.waitForTimeout(500); }
S = await st();
const dia = S.draft?.diameter?.v;
await ok();
S = await st();
const vHole = S.v;
check("E1", S.feats.some(f => f.startsWith("hole")) && !S.bad.length && vHole < V0, "✓ cuts the hole", { feats: S.feats, v: vHole, dia, holeMode, bad: S.bad }, imgE1);
const holeName = S.feats.find(f => f.startsWith("hole")).split(":")[1];
const oneHole = V0 - vHole;
await blank();

// C1 linear pattern: seed = hole row in the tree, direction = top front edge.
await rowOf2(holeName).click();
await cmd(pg, "Linear pattern");
await pg.waitForTimeout(600);
S = await st();
const seeded = S.draft?.features?.length;
if (!seeded) { await rowOf2(holeName).click(); await idle(pg); }
await pg.click('#mc-pm [data-focus="dir"]').catch(() => {});
await clickAt(pg, await P(10, -30, 20));
await idle(pg);
await num("spacing", 20);
await num("count", 4);
await idle(pg);
S = await st();
const imgC1 = await snap(pg, "lpattern-preview");
check("C2", near(S.v, V0 - 4 * oneHole, 5), "the copies show while the panel is open", { v: S.v, want: V0 - 4 * oneHole, seeded, draft: { f: S.draft?.features, dir: !!S.draft?.dir, n: S.draft?.count } }, imgC1);
await ok();
S = await st();
check("C1", near(S.v, V0 - 4 * oneHole, 5) && !S.bad.length, "linear pattern: hole picked in the tree first, edge clicked for the direction, 4 at 20 mm", { v: S.v, bad: S.bad, warn: S.warn });
const lpName = S.feats.at(-1).split(":")[1];
await blank();

// C3: direction 2 grid.
const ed3 = await editRow(lpName);
await pg.check('#mc-pm input[data-k="useDir2"]').catch(e => console.log("useDir2", e.message.split("\n")[0]));
console.log("C3 dbg", ed3, JSON.stringify(await pg.evaluate(() => { const m = window.__sv.model.mode(); return { kind: m.kind, focus: m.focus, dir2: !!m.draft?.dir2 }; })));
await idle(pg);
const at3 = await P(-50, 0, 20);
await pg.mouse.move(...at3); await pg.waitForTimeout(200);
await snap(pg, "dir2-before-click");
console.log("C3 under", JSON.stringify(await pg.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e.tagName + "." + e.className + " " + (e.textContent ?? "").slice(0, 30); }, at3)));
await clickAt(pg, at3);
await idle(pg);
console.log("C3 after", JSON.stringify(await pg.evaluate(() => { const m = window.__sv.model.mode(); return { focus: m.focus, dir2: m.draft?.dir2, picking: window.__sv.modeller.picking, toasts: [...document.querySelectorAll(".toast")].map(e => e.textContent) }; })));
await num("spacing2", 25);
await num("count2", 2);
S = await st();
const warn3 = await pg.$eval("#mc-pm", e => e.textContent.includes("warning")).catch(() => false);
// The second row went off the part (−Y) with only a warning: reverse it, as a person would after reading What's wrong.
await pg.check('#mc-pm input[data-k="flip2"]').catch(() => {});
await idle(pg);
await snap(pg, "dir2-preview");
console.log("C3 pre-ok", JSON.stringify({ v: S.v, warn: S.warn, flip2: S.draft?.flip2 }));
await ok();
S = await st();
check("C3", near(S.v, V0 - 8 * oneHole, 5) && !S.bad.length, "Direction 2: a 4 × 2 grid (after Reverse direction: the default way ran off the part)", { v: S.v, want: V0 - 8 * oneHole, bad: S.bad, warnedFirst: warn3 });
await blank();

// C4: skip an instance by clicking its dot.
await editRow(lpName);
await pg.click('#mc-pm [data-focus="skip"]').catch(() => {});
await idle(pg);
const spots = await pg.$$("#mc-layer .pat-spot, .pat-spot");
let skipped = false;
if (spots.length > 2) { await spots[2].click(); await idle(pg); skipped = true; }
const imgC4 = await snap(pg, "skip-dots");
await ok();
S = await st();
check("C4", skipped && near(S.v, V0 - 7 * oneHole, 5), "Instances to skip: a click on a dot leaves that copy out", { spots: spots.length, v: S.v, want: V0 - 7 * oneHole }, imgC4);
await blank();

// C7: change the seed hole's diameter: every copy follows.
await editRow(holeName);
await num("diameter", (dia ?? 5) + 2);
await ok();
S = await st();
const big = Math.PI / 4 * ((dia ?? 5) + 2) ** 2 * 20;
check("C7", near(S.v, V0 - 7 * big, 10) && !S.bad.length, "a bigger seed hole makes every copy bigger", { v: S.v, want: V0 - 7 * big, bad: S.bad });
await blank();

// C6: mirror the pattern about Right (YZ).
await rowOf2(lpName).click();
await cmd(pg, "Mirror");
await pg.waitForTimeout(600);
S = await st();
const mseed = S.draft?.features?.length;
await pg.click('#mc-pm [data-focus="mplane"]').catch(() => {});
if (!(await rowOf2("Right (YZ)").isVisible())) await pg.click(".mc-treefly-h").catch(() => {});
await rowOf2("Right (YZ)").click();
await idle(pg);
const imgC6 = await snap(pg, "mirror");
await ok();
S = await st();
check("C6", near(S.v, V0 - 14 * big, 20) && !S.bad.length, "Mirror of the pattern about the Right plane", { v: S.v, want: V0 - 14 * big, mseed, bad: S.bad, warn: S.warn }, imgC6);
await blank();

// F2/F1: make the block taller (edit Extrude1): every hole goes through again, no errors.
await editRow("Extrude1");
await num("depth", 30);
await ok();
S = await st();
const big30 = big * 1.5;
check("F2", !S.bad.length && near(S.v, 100 * 60 * 30 - 14 * big30, 30), "Extrude 20 → 30: hole, pattern, mirror rebuild through the taller block", { v: S.v, want: 100 * 60 * 30 - 14 * big30, bad: S.bad, warn: S.warn });
await pg.keyboard.press("Control+z"); await idle(pg);
S = await st();
check("F9", near(S.v, V0 - 14 * big, 20), "Ctrl+Z after the upstream edit brings every result back", { v: S.v });
await blank();

// F7: delete the seed hole: asks and names the features that use it.
await rowOf2(holeName).click({ button: "right" });
await pg.waitForTimeout(200);
await pg.locator("#mc-menu button", { hasText: "Delete" }).last().click();
await pg.waitForTimeout(300);
const ask = await pg.evaluate(() => ({ open: document.querySelector("#confirm")?.open, text: document.querySelector("#confirm-text")?.textContent }));
const imgF7 = await snap(pg, "delete-ask");
if (ask.open) await pg.click("#confirm [data-a=cancel]");
check("F7", ask.open && ask.text.includes(lpName), "Delete of the seed asks first and names the pattern that uses it", ask, imgF7);
await blank();

// F4: fillet on the top front edge, then make the block 3 mm thick: the fillet fails with a message.
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, await P(25, -30, 20));
await num("radius", 5);
await ok();
S = await st();
const vF = S.v;
await editRow("Extrude1");
await num("depth", 3);
await ok();
S = await st();
const imgF4 = await snap(pg, "fillet-fails");
const red = await pg.$$eval("#mc-tree .ft-row.err, #mc-tree .ft-row.bad, #mc-tree .ft-row[data-err]", els => els.map(e => e.textContent.trim()));
const wrong = await pg.$$eval("#mc-errors *", els => els.map(e => e.textContent.trim()).filter(Boolean).slice(0, 4));
check("F4", S.bad.length >= 1 && (red.length || wrong.length), "a 3 mm block cannot hold the 5 mm fillet: it is marked and says why", { bad: S.bad, red, wrong, v: S.v }, imgF4);
await pg.keyboard.press("Control+z"); await idle(pg);
S = await st();
check("F4-undo", near(S.v, vF, 1) && !S.bad.length, "Ctrl+Z puts the block back with its fillet", { v: S.v, vF });
await blank();

// ---------- D. Shell ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Shell");
await pg.waitForTimeout(500);
// Away from the middle, where the Thickness callout sits.
await clickAt(pg, await P(30, -18, 20));
await idle(pg);
await num("thickness", 2);
S = await st();
const imgD2 = await snap(pg, "shell-preview");
const shellIn = V0 - 96 * 56 * 18;
check("D2", near(S.v, shellIn, 5), "the hollowed body shows while the panel is open", { v: S.v, want: shellIn, faces: S.draft?.faces?.length }, imgD2);
await ok();
S = await st();
check("D1", near(S.v, shellIn, 5) && !S.bad.length, "Shell 2 mm with the top open", { v: S.v, want: shellIn, bad: S.bad });
const shName = S.feats.at(-1).split(":")[1];
await editRow(shName);
await pg.check('#mc-pm input[data-k="outward"]').catch(() => {});
await idle(pg);
await ok();
S = await st();
check("D3", near(S.v, 104 * 64 * 22 - V0, 2) && !S.bad.length, "Shell outward: sharp outer corners", { v: S.v, want: 104 * 64 * 22 - V0, bad: S.bad });
await editRow(shName);
await pg.uncheck('#mc-pm input[data-k="outward"]').catch(() => {});
await num("thickness", 40);
await pg.waitForTimeout(400);
const imgD6 = await snap(pg, "shell-too-thick");
const pmErr6 = await pg.$$eval("#mc-pm .pm-err, #mc-pm [role=alert], #mc-pm .pm-status", els => els.map(e => e.textContent.trim()));
S = await st();
check("D6", pmErr6.length || S.bad.length, "a shell thicker than the part says why", { pmErr6, bad: S.bad, v: S.v }, imgD6);
await pg.click("#mc-cancel").catch(() => {}); await idle(pg);
await blank();
// D5: fillets on the vertical edges, then a shell: the walls stay round.
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
for (const p of [[50, -30, 10], [-50, -30, 10]]) await clickAt(pg, await P(...p));
await num("radius", 8);
await ok();
await blank();
await cmd(pg, "Shell");
await pg.waitForTimeout(500);
// Away from the middle, where the Thickness callout sits.
await clickAt(pg, await P(30, -18, 20));
await idle(pg);
await num("thickness", 2);
await ok();
S = await st();
const imgD5 = await snap(pg, "shell-filleted");
check("D5", !S.bad.length && S.feats.at(-1).startsWith("shell") && S.v < 26000 && S.v > 20000, "a shell of a block with rounded corners keeps the round walls", { bad: S.bad, v: S.v }, imgD5);
await blank();

// D7 closed shell with no face removed.
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Shell");
await pg.waitForTimeout(500);
await num("thickness", 2);
await ok();
S = await st();
check("D7", near(S.v, V0 - 96 * 56 * 16, 5) && !S.bad.length, "Shell with no face removed makes a hollow closed body", { v: S.v, want: V0 - 96 * 56 * 16, bad: S.bad, mode: S.mode });
await blank();

// ---------- E. more holes ----------
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(0, 0, 20));
await idle(pg);
await clickAt(pg, await P(0, 0, 20));
await idle(pg);
if ((await st()).mode === "sketch") { await ok(); }
await pg.click('#mc-pm [data-htab="type"]').catch(() => {});
await idle(pg);
await pg.selectOption('#mc-pm select[data-k="kind"]', "cbore").catch(e => console.log("kind", e.message));
await idle(pg);
await pg.selectOption('#mc-pm select[data-k="size"]', "M6").catch(e => console.log("size", e.message));
await idle(pg);
const ends = await pg.$$eval('#mc-pm select[data-k="end"] option', els => els.map(e => e.value));
if (ends.includes("through")) { await pg.selectOption('#mc-pm select[data-k="end"]', "through"); await idle(pg); }
const imgE2 = await snap(pg, "cbore");
S = await st();
const hdraft = S.draft;
await ok();
S = await st();
const cb = hdraft ? Math.PI / 4 * (hdraft.diameter.v ** 2 * 20 + (hdraft.cbDia?.v ** 2 - hdraft.diameter.v ** 2) * hdraft.cbDepth?.v) : 0;
check("E2", hdraft?.kind === "cbore" && near(S.v, V0 - cb, 3) && !S.bad.length, "M6 counterbore through all", { kind: hdraft?.kind, size: hdraft?.size, end: hdraft?.end, ends, v: S.v, want: V0 - cb, bad: S.bad }, imgE2);
await blank();

// ---------- F. more rebuild checks on a block with hole, pattern and fillet ----------
const menuPick = async (id, label) => {
  await pg.locator(`#mc-tree .ft-row[data-id="${id}"]`).click({ button: "right" });
  await pg.waitForTimeout(200);
  const items = await pg.$$eval("#mc-menu button", els => els.map(e => e.textContent.trim()));
  const i = items.findIndex(t => t === label || t.startsWith(label));
  if (i < 0) { await pg.keyboard.press("Escape"); return items; }
  await pg.locator("#mc-menu button").nth(i).click();
  await idle(pg);
  return true;
};
const idOf = name => pg.evaluate(n => window.__sv.model.store.doc.features.find(f => f.name === n)?.id, name);
await makeBlock(pg, 100, 60, 20);
await blank();
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(-35, 0, 20)); await idle(pg);
await clickAt(pg, await P(-35, 0, 20)); await idle(pg);
if ((await st()).mode === "sketch") await ok();
await ok();
await blank();
const hId = (await pg.evaluate(() => window.__sv.model.store.doc.features.at(-1).id));
await pg.locator(`#mc-tree .ft-row[data-id="${hId}"]`).click();
await cmd(pg, "Linear pattern");
await pg.waitForTimeout(600);
await clickAt(pg, await P(10, -30, 20)); await idle(pg);
await num("spacing", 20);
await num("count", 3);
await ok();
await blank();
await cmd(pg, "Fillet");
await pg.waitForTimeout(400);
await clickAt(pg, await P(50, -30, 10));
await num("radius", 6);
await ok();
await blank();
S = await st();
const vFull = S.v;
const lpId = (await pg.evaluate(() => window.__sv.model.store.doc.features.find(f => f.type === "lpattern").id));
const flId = (await pg.evaluate(() => window.__sv.model.store.doc.features.find(f => f.type === "fillet").id));

// F6: suppress the seed hole.
const sup = await menuPick(hId, "Suppress");
S = await st();
const imgF6 = await snap(pg, "suppress-seed");
check("F6", sup === true && near(S.v, V0 - 6 * 6 * (1 - Math.PI / 4) * 20, 3) && !S.bad.length, "Suppress the seed hole: the pattern of it goes too, no errors, the fillet stays", { v: S.v, bad: S.bad, warn: S.warn, sup }, imgF6);
await menuPick(hId, "Unsuppress");
S = await st();
check("F6-back", near(S.v, vFull, 1), "Unsuppress brings the holes back", { v: S.v, vFull });

// F5: roll back above the fillet, add a chamfer there, roll to the end.
const rb = await menuPick(flId, "Roll back to here");
S = await st();
const rolled = await pg.evaluate(() => window.__sv.model.store.doc.rollback);
await cmd(pg, "Chamfer");
await pg.waitForTimeout(400);
await clickAt(pg, await P(-50, 0, 20));
await num("distance", 2);
await ok();
await blank();
const order = (await st()).feats;
await pg.locator("#mc-tree .ft-row", { hasText: "Roll to end" }).first().click().catch(() => {});
const rolledEnd = await pg.evaluate(() => window.__sv.model.store.doc.rollback);
if (rolledEnd != null) { const bar = await pg.$("#mc-rolled [data-a=rollend]"); if (bar) await bar.click(); else await menuPick(flId, "Roll to end"); }
await idle(pg);
S = await st();
const imgF5 = await snap(pg, "rollback-insert");
check("F5", rb === true && rolled != null && order.findIndex(f => f.startsWith("chamfer")) < order.findIndex(f => f.startsWith("fillet")) && (await pg.evaluate(() => window.__sv.model.store.doc.rollback)) == null && !S.bad.length && near(S.v, vFull - 2 * 60, 2), "Roll back to here, a chamfer added there goes before the fillet; Roll to end rebuilds all", { order, v: S.v, want: vFull - 120, bad: S.bad }, imgF5);

// F8: move the fillet above the pattern with Alt+↑ (twice) in the tree.
await pg.locator(`#mc-tree .ft-row[data-id="${flId}"]`).click();
for (let k = 0; k < 3; k++) { await pg.keyboard.press("Alt+ArrowUp"); await idle(pg); }
S = await st();
check("F8", S.feats.findIndex(f => f.startsWith("fillet")) < S.feats.findIndex(f => f.startsWith("lpattern")) && !S.bad.length && near(S.v, vFull - 120, 2), "Alt+↑ moves the fillet above the pattern; same result", { feats: S.feats, v: S.v, bad: S.bad });

// F3: edit the base sketch: move the rectangle's right side out 20 mm (drag a corner), fillet and pattern follow.
// Sketch1 is folded under Extrude1 in the tree: Edit sketch from the extrude's menu.
await menuPick(await idOf("Extrude1"), "Edit sketch");
await pg.waitForTimeout(800);
const insk = (await st()).mode;
const c0 = await P(50, 30, 0), c1 = await P(70, 30, 0);
await pg.mouse.move(...c0); await pg.waitForTimeout(150); await pg.mouse.down();
for (let k = 1; k <= 8; k++) { await pg.mouse.move(c0[0] + (c1[0] - c0[0]) * k / 8, c0[1] + (c1[1] - c0[1]) * k / 8); await pg.waitForTimeout(60); }
await pg.mouse.up();
await pg.waitForTimeout(300);
await ok();
S = await st();
const imgF3 = await snap(pg, "base-sketch-dragged");
check("F3", insk === "sketch" && S.v > vFull && !S.bad.length && S.feats.some(f => f.startsWith("fillet")), "dragging a corner of the base sketch out: fillet, chamfer, hole and pattern rebuild with no error", { insk, v: S.v, vFull, bad: S.bad, warn: S.warn }, imgF3);

// F10: save and open again.
const saved = await (await import("./lib.mjs")).saveModel(pg, `${process.env.HT_OUT || "/tmp"}/files`, "core-f10");
const vSaved = (await st()).v, nSaved = (await st()).feats.length;
await (await import("./lib.mjs")).openFiles(pg, [saved]);
S = await st();
check("F10", near(S.v, vSaved, 0.01) && S.feats.length === nSaved && !S.bad.length, "save and open again: same tree, same volume", { v: S.v, vSaved, n: S.feats.length, nSaved });
await blank();

// ---------- C5. Circular pattern ----------
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="new-part"]');
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await P(0, 0, 0));
await clickAt(pg, await P(50, 0, 0));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
await num("depth", 10);
await ok();
await blank();
const vDisc = (await st()).v;
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(30, 0, 10)); await idle(pg);
await clickAt(pg, await P(30, 0, 10)); await idle(pg);
if ((await st()).mode === "sketch") await ok();
await ok();
await blank();
const vOne = vDisc - (await st()).v;
const h2 = await pg.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
await pg.locator(`#mc-tree .ft-row[data-id="${h2}"]`).click();
await cmd(pg, "Circular pattern");
await pg.waitForTimeout(600);
await clickAt(pg, await P(-35.36, -35.36, 5)); await idle(pg);
await num("count", 6);
const cpd = (await st()).draft;
const imgC5 = await snap(pg, "cpattern");
await ok();
S = await st();
check("C5", near(S.v, vDisc - 6 * vOne, 5) && !S.bad.length, "circular pattern of a hole about the disc's round face, 6 equal over 360°", { v: S.v, want: vDisc - 6 * vOne, axis: !!cpd?.axis, eq: cpd?.equal, ang: cpd?.angle?.v, bad: S.bad, warn: S.warn }, imgC5);
await blank();

// E6: hole on the round side face.
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(0, -50, 5)); await idle(pg);
const e6 = { mode: (await st()).mode, toasts: await toasts(), pm: await pg.$eval("#mc-pm", e => e.innerText.slice(0, 300)).catch(() => "") };
const imgE6 = await snap(pg, "hole-round-face");
check("E6", e6.mode !== "sketch" || e6.toasts.length, "a click on a round face for a hole says it needs a flat face (or places it square to the face)", e6, imgE6);
if ((await st()).mode === "sketch") { await pg.keyboard.press("Escape"); await pg.click("#mc-cancel").catch(() => {}); await idle(pg); }
await pg.click("#mc-cancel").catch(() => {}); await idle(pg);
await blank();

await finish(browser, pg);
