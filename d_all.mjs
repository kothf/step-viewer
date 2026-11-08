import { start, report, asmIdle, FILES } from "./lib.mjs";
import fs from "node:fs";
const geo = JSON.parse(fs.readFileSync("/tmp/claude-0/exam/asm-geo.json", "utf8"));
const C = n => geo.find(c => c.name.startsWith(n));
const { browser, page, errs, u } = await start("drw-all");
const dp = page;
const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 300000 });
const sheet = () => dp.evaluate(() => window.__sv.drw.doc().sheets.findIndex(s => s === window.__sv.drw.sheet?.()));
const views = () => dp.evaluate(() => { const d = window.__sv.drw.doc(); const s = window.__sv.drw.sheet ? window.__sv.drw.sheet() : d.sheets[d.sheets.length - 1]; return s.views.map(v => ({ id: v.id, x: v.x, y: v.y, side: v.side ?? null, orient: v.orient ?? null, parent: v.parent ?? null })); });
const pt = (x, y) => dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]);
const at = (id, uu, w) => dp.evaluate(([i, a, b]) => { const p = window.__sv.drw.placement(i); return window.__sv.drw.sheetPt(p.x + (a - p.uc) * p.s, p.y + (b - p.vc) * p.s); }, [id, uu, w]);
const drag = async (fx, fy, tx, ty) => { const [sx, sy] = await pt(fx, fy), [ex, ey] = await pt(tx, ty); await dp.mouse.move(sx, sy); await dp.mouse.down(); await dp.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 }); await dp.mouse.move(ex, ey, { steps: 4 }); await dp.mouse.up(); await dp.waitForTimeout(300); };
const click = async (id, uu, w) => { const [x, y] = await at(id, uu, w); await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.waitForTimeout(120); await dp.mouse.click(x, y); await dp.waitForTimeout(200); };
const tool = async an => { await dp.click('#drw [data-a="annot"]'); await dp.click(`#drw [data-an="${an}"]`); };
const texts = () => dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT").map(p => p.s));
const download = async (fn, name) => { const [d] = await Promise.all([dp.waitForEvent("download", { timeout: 180000 }), fn()]); await d.saveAs(`${FILES}/drawings/${name}`); return name; };
const esc = async () => { await dp.keyboard.press("Escape"); await dp.waitForTimeout(100); };
// a dimension: picks in view coords, then where the text goes
const dim = async (id, picks, place) => { try { await esc(); await dp.click('#drw [data-a="dim"]'); for (const [a, b] of picks) await click(id, a, b); await click(id, place[0], place[1]); await esc(); } catch (e) { console.log("dim fail", e.message.slice(0, 80)); } };
// select the newest dimension whose text starts with `s` and give it a fit
const fit = async (s, code) => { try {
  await esc();
  const p = await dp.evaluate(s => { const ps = window.__sv.drw.prims().filter(q => q.t === "t" && q.layer === "ANNOT" && q.s.startsWith(s)); const q = ps[ps.length - 1]; return q && [q.x + (q.w ?? 2) / 2, q.y + q.h / 2]; }, s);
  if (!p) { console.log("fit: no text", s); return; }
  const [x, y] = await pt(p[0], p[1]); await dp.mouse.click(x, y); await dp.waitForTimeout(200);
  if (!(await dp.locator('#drw .drw-props [data-tolt="fit"]').count())) { console.log("fit: not selected", s); return; }
  await dp.click('#drw [data-tolt="fit"]');
  await dp.fill('#drw .drw-props [data-d="fit"]', code); await dp.press('#drw .drw-props [data-d="fit"]', "Enter"); await dp.waitForTimeout(200);
  if (await dp.locator('#drw .drw-props [data-d="fshow"]').count()) await dp.selectOption('#drw .drw-props [data-d="fshow"]', "both");
  await esc();
} catch (e) { console.log("fit fail", s, e.message.slice(0, 80)); } };
// a model view of one component: orientation, sheet position, scale
const place = async (orient, x, y, comp, scale) => {
  await esc();
  const before = new Set((await views()).map(v => v.id));
  await dp.click('#drw [data-a="model"]'); await dp.click(`#drw [data-orient="${orient}"]`);
  const [sx, sy] = await pt(x, y); await dp.mouse.move(sx + 4, sy + 4); await dp.mouse.move(sx, sy); await dp.waitForTimeout(500);
  await dp.mouse.click(sx, sy); await dp.waitForTimeout(300); await esc(); await ready();
  const v = (await views()).find(w => !before.has(w.id));
  if (!v) throw new Error("view not placed " + comp);
  const [cx, cy] = await pt(v.x, v.y); await dp.mouse.click(cx, cy); await dp.waitForTimeout(200);
  if (comp) { await dp.selectOption('#drw .drw-props [data-v="only"]', C(comp).id); await ready(); }
  if (scale) { await dp.mouse.click(cx, cy); await dp.waitForTimeout(200); if (scale.includes(".")) globalThis.__dlgAnswer = scale; await dp.selectOption('#drw .drw-props [data-v="scale"]', scale.includes(".") ? "custom" : scale); await ready(); }
  // put it back where asked (the content recentres when it changes)
  const w = (await views()).find(q => q.id === v.id);
  if (Math.hypot(w.x - x, w.y - y) > 1) { await drag(w.x, w.y, x, y); await ready(); }
  await esc();
  console.log("view", orient, comp ?? "all", v.id);
  return v.id;
};
const addSheet = async () => { await esc(); await dp.click('#drw .drw-tabs [data-a="addsheet"]'); await dp.waitForTimeout(400); await ready(); };
const block = async (name, fn) => { try { await fn(); } catch (e) { console.log("ERR in", name, e.message.slice(0, 200)); await u.shot("err-" + name); await esc(); } };
try {
  const fc = page.waitForEvent("filechooser"); await page.click("[data-open]"); (await fc).setFiles(`${FILES}/leuenberger-engine.mcadasm`);
  await page.waitForFunction(() => window.__sv.asm.doc?.components.length > 40 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden, null, { timeout: 300000 });
  await asmIdle(u);
  await dp.click("#new-more"); await dp.click("#new-drawing");
  await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 300000 });
  await ready();
  // ---- Sheet 1: general arrangement ----
  await block("sheet1", async () => {
    await esc();
    await dp.selectOption('#drw .drw-props [data-s="projection"]', "third"); await ready();
    globalThis.__dlgAnswer = "1:2.5";
    await dp.selectOption('#drw .drw-props [data-s="scale"]', "custom"); await ready();
    for (const [k, v] of [["title", "1 CYLINDER HORIZONTAL DOUBLE ACTING STEAM ENGINE WITH REVERSER (B=25 S=40)"], ["number", "09B-53-00"], ["author", "H. Leuenberger / J.A.M. de Waal"], ["company", "MöbiusCAD exam"], ["date", "2026-11-08"]]) {
      const inp = dp.locator(`#drw .drw-props input[data-f="${k}"]`); if (await inp.count()) { await inp.fill(v); await inp.press("Tab"); }
    }
    let v = await views();
    console.log("views", JSON.stringify(v));
    const front = v.find(x => !x.parent), top = v.find(x => x.parent && x.side && x.side[1] !== 0), right = v.find(x => x.parent && x.side && x.side[0] !== 0);
    await drag(front.x, front.y, 200, 120); await ready();
    v = await views();
    const T = v.find(x => x.id === top.id), R = v.find(x => x.id === right.id);
    await drag(T.x, T.y, T.x, 218); await ready();
    await drag(R.x, R.y, 62, R.y); await ready();
    const [fx, fy] = await pt(200, 120); await dp.mouse.click(fx, fy);
    await dp.click('#drw [data-a="proj"]');
    const [lx, ly] = await pt(340, 120); await dp.mouse.move(lx + 5, ly); await dp.mouse.move(lx, ly); await dp.waitForTimeout(800); await dp.mouse.click(lx, ly);
    await esc(); await ready();
    v = await views();
    console.log("views1", JSON.stringify(v));
    const left = v.find(x => x.parent === front.id && x.side && x.side[0] !== 0 && x.id !== right.id);
    await dim(front.id, [[-100, 0]], [0, -22]);
    if (left) await dim(left.id, [[60, 0]], [0, -22]);
    await dim(front.id, [[-215, 15], [215, 15]], [240, 60]);
    globalThis.__dlgAnswer = "GENERAL NOTES:\n1. ALL DIMENSIONS IN MILLIMETRES.\n2. FITS AND TOLERANCES ISO 286 (SHEETS 2-4).\n3. TAPPED HOLES ISO METRIC COARSE.\n4. REMOVE ALL SHARP EDGES.\nORIGINAL DESIGN: HANS LEUENBERGER, 4800 ZOFINGEN.";
    await tool("note");
    const [nx, ny] = await pt(18, 282); await dp.mouse.move(nx, ny); await dp.mouse.click(nx, ny); await dp.waitForTimeout(300); await esc(); await ready();
    await u.shot("sheet1");
  });
  // ---- Sheet 2: isometric, BOM, base plate, main bearing ----
  await addSheet();
  await block("sheet2", async () => {
    const iso = await place("iso", 110, 225, null, "1:5");
    const bp = await place("top", 115, 130, "1-01.2-base-plate", "1:2.5");
    await dim(bp, [[0, 75]], [0, 90]);
    await dim(bp, [[200, 0]], [215, 0]);
    const mb = await place("front", 95, 45, "1-02.1-main-bearing<1>", "1:2");
    await dim(mb, [[92 + 16, 105.5]], [92 + 30, 125]);
    await fit("Ø32", "H7");
    await dim(mb, [[60, 66.5]], [92, 56]);
    await esc(); await tool("bom"); await dp.waitForTimeout(500); await esc(); await ready();
    await u.shot("sheet2");
  });
  // ---- Sheet 3: cylinder, liner, flywheel, crankshaft, pulley ----
  await addSheet();
  await block("sheet3", async () => {
    const cy = await place("front", 80, 225, "1-03.1-cylinder", "1:1");
    await dim(cy, [[-100, 128]], [-100, 138]);
    const cr = await place("right", 165, 225, "1-03.1-cylinder", "1:1");
    await dim(cr, [[35 + 22.5, 105.5]], [35 + 30, 128]);
    await dim(cr, [[35 + 16.5, 105.5]], [35 + 26, 84]);
    await fit("Ø33", "H7");
    const ln = await place("right", 235, 225, "1-03.2-liner", "1:1");
    await dim(ln, [[35 + 12.5, 105.5]], [35 + 24, 124]);
    await fit("Ø25", "H7");
    await dim(ln, [[35 + 16.5, 105.5]], [35 + 26, 86]);
    await fit("Ø33", "p6");
    const fw = await place("front", 335, 205, "2-01.1-flywheel", "1:2");
    await dim(fw, [[92 + 79, 105.5]], [92 + 60, 190]);
    await dim(fw, [[92 + 6, 105.5]], [92 + 30, 30]);
    await fit("Ø12", "H7");
    const cs = await place("top", 70, 110, "2-01.6-crankshaft", "1:1");
    await dim(cs, [[92, 29.5], [92, -97.5]], [75, -34]);
    const ce = await place("front", 125, 110, "2-01.6-crankshaft", "1:1");
    await dim(ce, [[92 + 6, 105.5]], [92 + 14, 118]);
    await fit("Ø12", "k6");
    const pu = await place("front", 195, 110, "2-01.2-pulley", "1:1");
    await dim(pu, [[92 + 21.5, 105.5]], [92 + 15, 132]);
    await dim(pu, [[92 + 5, 105.5]], [92 + 18, 80]);
    await fit("Ø10", "H7");
    await u.shot("sheet3");
  });
  // ---- Sheet 4: piston, piston rod, con-rod, crosshead, eccentric sheave and strap ----
  await addSheet();
  await block("sheet4", async () => {
    const pf = await place("front", 55, 235, "2-02.1-piston", "1:1");
    await dim(pf, [[-86.7, 118]], [-86.7, 126]);
    const pr = await place("right", 105, 235, "2-02.1-piston", "1:1");
    await dim(pr, [[35 + 12.5, 105.5]], [35 + 20, 124]);
    await fit("Ø25", "f7");
    const rf = await place("front", 230, 255, "2-02.2-piston-rod", "1:1");
    await dim(rf, [[-40, 108]], [-40, 116]);
    const rr = await place("right", 320, 255, "2-02.2-piston-rod", "1:1");
    await dim(rr, [[35 + 2.5, 105.5]], [35 + 10, 114]);
    await fit("Ø5", "f7");
    const cf = await place("front", 100, 150, "2-03-con-rod", "1:1");
    await dim(cf, [[12.285 + 4.5, 105.5], [100.44 + 4.5, 87.37]], [56, 125]);
    await dim(cf, [[12.285, 105.5 + 4.5]], [0, 125]);
    await dim(cf, [[100.44, 87.37 + 4.5]], [120, 70]);
    const ch = await place("front", 350, 225, "2-02.3-crosshead", "1:1");
    await dim(ch, [[7.28, 123.5]], [7.28, 131]);
    await dim(ch, [[22.28, 105.5]], [30, 105.5]);
    const sv = await place("front", 230, 150, "2-10.1-eccentric-sheave", "1:1");
    await dim(sv, [[88.5, 120.52]], [100, 130]);
    await fit("Ø30", "f7");
    await dim(sv, [[92 + 6, 105.5]], [110, 92]);
    await fit("Ø12", "H7");
    const st = await place("front", 320, 150, "2-11.1-eccentric-strap", "1:1");
    await dim(st, [[88.5 + 15, 105.5]], [112, 128]);
    await fit("Ø30", "H7");
    await u.shot("sheet4");
  });
  console.log("texts", JSON.stringify(await texts()));
  await download(async () => { await esc(); await dp.click('#drw [data-a="export"]'); await dp.click('#drw [data-x="pdf"]'); }, "leuenberger-sheets.pdf");
  await download(() => dp.keyboard.press("Control+s"), "leuenberger-engine.mcaddrw");
  console.log("saved");
} catch (e) { console.log("ERR", e.message); await u.shot("err"); }
report("drw-all", errs);
await browser.close();
