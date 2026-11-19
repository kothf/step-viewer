// P3 polish of the gap list, second half, by hand: first-use tips in the panel (U5), measuring inside a command (M8),
// feature errors on the model (M9), editing sketch text on the canvas (S13) and rapid dimension targets (D3).
import { open, snap, idle, cmd, screenOf, clickAt, dblAt, check, finish, makeBlock, BASE } from "./lib.mjs";
const { browser, pg } = await open("polish2");
// Tips on, and the coach marks wanted under automation.
await pg.evaluate(() => { localStorage.setItem("sv:tips", "on"); localStorage.setItem("mc:coach", ""); localStorage.setItem("sv:tips-seen", "model,live,pair,section,tree"); });
await pg.goto(`${BASE}/index.html?debug&coach`);
await pg.waitForFunction(() => window.__sv);
await makeBlock(pg, 100, 60, 20);
await pg.keyboard.press("Escape");
const P = (x, y, z = 0) => screenOf(pg, [x, y, z]);
const mode = () => pg.evaluate(() => { const m = window.__sv.model.mode(); return { kind: m.kind, type: m.draft?.type ?? null, edges: m.draft?.edges?.length ?? null }; });
const coach = () => pg.evaluate(() => { const c = document.querySelector("#mc-pm .pm-coach"); return c ? c.querySelector("b")?.textContent ?? "?" : null; });
const seen1 = await pg.evaluate(() => localStorage.getItem("mc:coach"));

// U5: Fillet the first time: a tip card in its panel; Got it closes it; the second time there is none.
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
await cmd(pg, "Fillet");
await pg.waitForTimeout(500);
const c1 = await coach();
const img1 = await snap(pg, "fillet-tip");
await pg.click('#mc-pm [data-coach="ok"]');
await pg.waitForTimeout(150);
const c2 = await coach();
check("U5", /sketch/.test(seen1 ?? "") && /extrude/.test(seen1 ?? "") && c1 === "Fillet" && c2 === null, "the first time a command opens, a short tip card sits at the top of its panel; Got it closes it", { seen1, c1, c2 }, img1);

// M8: 📏 in the Fillet panel: a click on the top face measures it and picks no edge; Esc goes back to picking.
await pg.click("#mc-pm .pm-meas");
await pg.waitForTimeout(200);
const on = await pg.evaluate(() => document.querySelector("#mc-pm .pm-meas")?.getAttribute("aria-pressed"));
await clickAt(pg, await P(10, 5, 20));
await pg.waitForTimeout(500);
const meas = await pg.evaluate(() => ({ sel: window.__sv.state.selection?.kind ?? null, readout: !document.querySelector("#readout")?.hidden && (document.querySelector("#readout")?.textContent ?? "").length > 0 }));
const m1 = await mode();
const img2 = await snap(pg, "measure-in-fillet");
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const m2 = await mode();
const off = await pg.evaluate(() => document.querySelector("#mc-pm .pm-meas")?.getAttribute("aria-pressed"));
// Back to picking: a click on the top front edge picks it for the fillet.
await clickAt(pg, await P(0, -30, 20));
await pg.waitForTimeout(600);
const m3 = await mode();
check("M8", on === "true" && meas.sel === "face" && meas.readout && m1.kind === "feature" && m1.edges === 0 && off === "false" && m2.kind === "feature" && m3.edges === 1,
  "📏 in a feature panel measures with view clicks without picking for the feature; Esc goes back to picking and the panel stays open", { on, meas, m1, off, m2, m3 }, img2);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(400);

// M9: a cut that misses the body fails: its sketch is drawn red with a ⚠ callout; a click on it edits the cut.
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.mouse.move(700, 450);
for (let k = 0; k < 4; k++) { await pg.mouse.wheel(0, 300); await pg.waitForTimeout(120); }
await pg.waitForTimeout(400);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await P(75, 0));
await clickAt(pg, await P(81, 0));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
if (dp) { await dp.fill("5"); await dp.press("Enter"); }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("f");
await pg.waitForTimeout(900);
const err = await pg.evaluate(() => { const b = document.querySelector(".mc-ferr"); let red = 0; window.__sv.viewer.scene.traverse(o => { if (o.visible && o.material?.color?.getHex?.() === 0xe03131) red++; }); return b ? { text: b.textContent, title: b.title, red } : { red }; });
const img3 = await snap(pg, "cut-error");
if (await pg.$(".mc-ferr")) await pg.click(".mc-ferr");
await pg.waitForTimeout(800);
const m4 = await mode();
check("M9", /Cut/.test(err.text ?? "") && /does not touch/.test(err.title ?? "") && err.red >= 1 && m4.kind === "feature" && m4.type === "extrude",
  "a failed feature's sketch shows red on the model with a ⚠ callout saying why; a click on the callout opens the feature", { err, m4 }, img3);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(400);

// S13: sketch text, double-click it, type, Enter: the text changes in place.
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await cmd(pg, "Text");
await clickAt(pg, await P(-30, 0));
await pg.waitForTimeout(1500);
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="sk:select"]').catch(() => {});
const txt = () => pg.evaluate(() => window.__sv.model.editor()?.sk.ents.find(e => e.t === "text") ?? null);
const t0 = await txt();
// The middle of the text's box, from the drawn outline.
const mid = t0 ? await P(-30 + t0.h * 0.9, t0.h * 0.45) : [700, 450];
await pg.mouse.move(mid[0] - 3, mid[1]); await pg.mouse.move(mid[0], mid[1]); await pg.waitForTimeout(200);
await dblAt(pg, mid);
await pg.waitForTimeout(300);
const boxShown = await pg.evaluate(() => document.querySelector(".sk-textedit")?.value ?? null);
const img4 = await snap(pg, "text-edit-box");
if (boxShown !== null) { await pg.keyboard.press("Control+a"); await pg.keyboard.type("M5 x 20"); await pg.keyboard.press("Enter"); }
await pg.waitForTimeout(1500);
const t1 = await txt();
const img5 = await snap(pg, "text-edited");
check("S13", !!t0 && boxShown === t0.text && t1?.text === "M5 x 20", "double-click a sketch text: a box opens on it with the text; typing and Enter changes it in place", { before: t0?.text, boxShown, after: t1?.text }, img5);
void img4;
await pg.click("#mc-ok");
await idle(pg);

// D3: a drawing; Smart dimension on the front view's top edge, then the top rapid target: the dimension sits 10 mm off
// the view; a second one through the same target sits 8 mm beyond it.
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
const tab = await pg.evaluate(() => document.querySelector('#drw .drw-cmds [data-a="std3"]')?.closest("[data-cpane]")?.dataset.cpane ?? null);
if (tab) await pg.click(`#drw [data-ctab="${tab}"]`);
await pg.click('#drw .drw-cmds [data-a="std3"]');
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
const pl = await pg.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0], p = window.__sv.drw.placement(v.id); return { x: p.x, y: p.y, s: p.s, box: p.box }; });
const sp = (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]);
const hw = 50 * pl.s, hh = 10 * pl.s;
await pg.click('#drw [data-ctab="annot"]');
const target = () => pg.evaluate(() => { const r = document.querySelector('#drw .drw-rapid[data-rapid="top"]')?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; });
const dims = () => pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).filter(a => a.t === "dim").map(a => ({ k: a.k, pos: a.pos })));
const rows = [];
let img6 = null, tg0 = null;
for (const edge of [[pl.x + hw * 0.4, pl.y + hh], [pl.x - hw * 0.4, pl.y - hh]]) {
  await pg.click('#drw .drw-cmds [data-a="dim"]');
  await pg.mouse.click(...(await sp(...edge)));
  await pg.waitForTimeout(250);
  const near = await sp(pl.x, pl.y + hh + 3);
  await pg.mouse.move(near[0], near[1], { steps: 3 });
  await pg.waitForTimeout(200);
  const tg = await target();
  tg0 ??= tg;
  if (tg) { await pg.mouse.move(tg[0], tg[1], { steps: 3 }); await pg.waitForTimeout(200); img6 ??= await snap(pg, "rapid-target"); await pg.mouse.click(tg[0], tg[1]); }
  await pg.waitForTimeout(400);
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(200);
  rows.push((await dims()).at(-1));
}
const img7 = await snap(pg, "rapid-placed");
const want0 = pl.box[3] + 10 / pl.s, want1 = pl.box[3] + 18 / pl.s;
check("D3", !!tg0 && rows[0]?.k === "h" && Math.abs(rows[0].pos[1] - want0) < 0.02 && rows[1]?.k === "h" && Math.abs(rows[1].pos[1] - want1) < 0.02,
  "while placing a dimension, targets stand round the view; clicking the top one puts it 10 mm off the view, the next 8 mm beyond", { tg0, rows, want0, want1 }, img7);
void img6;
await finish(browser, pg);
