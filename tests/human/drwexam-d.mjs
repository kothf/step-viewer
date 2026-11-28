// D. The drawing follows edits of its part.
import { clickAt, idle, openFiles } from "./lib.mjs";
export default async function ({ pg, drw, snap, check, tool, cmdA, click, at, vs }) {
  const top = vs.find(v => v.side && v.side[1] === -1), front = vs.find(v => !v.parent);
  const pt = await drw.pl(top.id), pf = await drw.pl(front.id);
  const of = async k => (await drw.annots()).filter(a => a.t === k);
  const mid = async id => { const b = await drw.hit(id); return at((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
  const textIn = async id => { const b = await drw.hit(id); return b ? pg.evaluate(b => window.__sv.drw.prims().filter(p => p.t === "t" && p.x >= b[0] - 1 && p.x <= b[2] + 1 && p.y >= b[1] - 1 && p.y <= b[3] + 1).map(p => p.s), b) : []; };
  const dangling = () => pg.evaluate(() => document.querySelectorAll("#drw .drw-dangle *").length);
  // Set-up: the front view's height (vertical dimension on its left edge), a callout on the plain hole, a frame under the height.
  await cmdA("dim");
  await click(...pf.at(-50, 10));
  await click(...pf.at(-62, 10));
  await pg.keyboard.press("Escape");
  const dimH = (await of("dim")).at(-1);
  await tool("hole");
  const c45 = Math.SQRT1_2;
  await click(...pt.at(25 + 3.3 * c45, 3.3 * c45));
  await click(...pt.at(40, 22));
  await pg.keyboard.press("Escape");
  const call = (await of("hole")).at(-1);
  await tool("gtol");
  await clickAt(pg, await mid(dimH.id));
  if (await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 6000 }).catch(() => null)) { await pg.click('#drw-gtol-dlg button[value="ok"]'); await pg.waitForTimeout(400); }
  await pg.keyboard.press("Escape");
  const fr = (await of("gtol")).find(g => g.dim === dimH.id);
  const t0 = { h: await textIn(dimH.id), c: await textIn(call.id) };
  await snap(pg, "before-edit");
  const toPart = async () => { await pg.locator("#doc-tabs .dt-b", { hasText: "Plate.mcadprt" }).click(); await pg.waitForTimeout(800); await idle(pg); };
  const toDrawing = async () => { await pg.locator("#doc-tabs .dt-b", { hasText: "Plate.mcaddrw" }).click(); await pg.waitForTimeout(1500); await drw.ready(); await pg.waitForTimeout(800); };
  const editFeature = async (name, set) => {
    await pg.locator("#mc-tree .ft-row[data-i]", { hasText: name }).first().click({ button: "right" });
    await pg.waitForTimeout(250);
    await pg.locator("#mc-menu button", { hasText: "Edit feature" }).click();
    await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "feature", null, { timeout: 30000 });
    await pg.waitForTimeout(500);
    await set();
    await idle(pg);
    if (await pg.evaluate(() => window.__sv.modeller.mode.kind === "feature")) await pg.click("#mc-pm .pm-ok");
    await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "none", null, { timeout: 30000 });
    await idle(pg);
  };
  // D1/D2/D4/D5: depth 20 → 30.
  await toPart();
  await editFeature("Extrude1", async () => { const i = await pg.$('#mc-pm input[data-num="depth"]'); await i.fill("30"); await i.press("Enter"); });
  const tEdit = Date.now();
  await toDrawing();
  const ms = Date.now() - tEdit;
  const pf2 = await drw.pl(front.id);
  const img1 = await snap(pg, "after-depth");
  check("D1", Math.abs(pf2.box[3] - pf2.box[1] - 30) < 1e-3, "after the depth changes to 30 the front view is 30 high", { box: pf2.box, ms }, img1);
  const th = await textIn(dimH.id);
  check("D2", th.includes("30") && t0.h.includes("20"), "the height dimension reads 30 (was 20)", { before: t0.h, after: th }, img1);
  const views = await drw.views(), sec = views.find(v => v.kind === "section");
  if (sec) { const ps = await drw.pl(sec.id); check("D4", Math.abs(ps.box[3] - ps.box[1] - 30) < 1e-3 || Math.abs(ps.box[2] - ps.box[0] - 30) < 1e-3, "the section follows the new depth", { box: ps.box }, img1); }
  const fr2 = (await of("gtol")).find(g => g.id === fr?.id);
  check("D5", !!fr2 && fr2.dim === dimH.id && (await drw.hit(fr2.id)) != null, "the frame stays under the height dimension", { fr2 }, img1);
  // D3: the plain hole's diameter 6.6 → 9.
  await toPart();
  await editFeature("Hole1", async () => { const i = await pg.$('#mc-pm input[data-num="diameter"]'); await i.fill("9"); await i.press("Enter"); });
  await toDrawing();
  const tc = await textIn(call.id);
  check("D3", tc.some(s => /Ø\s*9\b/.test(s)), "the callout follows the hole's new diameter", { before: t0.c, after: tc }, await snap(pg, "after-diameter"));
  // D6/D7: delete the plain hole: its callout shows as dangling; Undo in the part brings it back.
  await toPart();
  await pg.locator("#mc-tree .ft-row[data-i]", { hasText: "Hole1" }).first().click({ button: "right" });
  await pg.waitForTimeout(250);
  await pg.locator("#mc-menu button", { hasText: /^Delete$/ }).click();
  await pg.waitForTimeout(400);
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  await idle(pg);
  await toDrawing();
  const stillThere = (await of("hole")).some(h => h.id === call.id), dg = await dangling();
  check("D6", stillThere && dg > 0, "with the hole deleted, its callout stays and shows as dangling", { stillThere, dangling: dg }, await snap(pg, "hole-deleted"));
  await toPart();
  await pg.keyboard.press("Control+z");
  await idle(pg);
  await toDrawing();
  const back = await textIn(call.id), dg2 = await dangling();
  check("D7", dg2 === 0 && back.some(s => /Ø\s*9\b/.test(s)), "Undo in the part brings the hole back and the callout re-attaches", { back, dangling: dg2 }, await snap(pg, "hole-undone"));
  // D8/D9: save the drawing, close it, open the file again.
  const before = await drw.doc();
  await pg.evaluate(() => { window.showSaveFilePicker = undefined; });
  const dl = pg.waitForEvent("download", { timeout: 60000 });
  await pg.click('#drw [data-a="save"]');
  await pg.waitForTimeout(500);
  if (await pg.isVisible("#name-dlg[open]")) await pg.keyboard.press("Enter");
  const d = await dl;
  const path = `${process.env.HT_OUT}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  await pg.locator("#doc-tabs .dt", { hasText: "Plate.mcaddrw" }).locator("[data-dtx]").click();
  await pg.waitForTimeout(600);
  if (await pg.isVisible("dialog[open]")) { const btns = await pg.$$eval("dialog[open] button", bs => bs.map(b => b.textContent)); console.log("close dialog", btns); }
  await openFiles(pg, [path]);
  await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 180000 });
  const t9 = Date.now();
  await pg.waitForTimeout(300);
  const early = await pg.evaluate(() => document.querySelectorAll("#drw .drw-view").length);
  await drw.ready();
  const again = await drw.doc();
  const same = again.sheets[0].views.length === before.sheets[0].views.length && (again.sheets[0].annots ?? []).length === (before.sheets[0].annots ?? []).length;
  check("D8", same, "the saved drawing opens again with every view and annotation", { views: again.sheets[0].views.length, annots: (again.sheets[0].annots ?? []).length }, await snap(pg, "reopened"));
  check("D9", early > 0, "views show at once on reopen", { early, ms: Date.now() - t9 }, null);
}
