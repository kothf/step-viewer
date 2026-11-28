// 3D sketch, hands-on (docs/3d-sketch-tests.md): every action is a real click, drag or key on the packaged app;
// window.__sv is only read. Test ids follow the test list.
import { open, snap, cmd, idle, screenOf, clickAt, dblAt, check, finish } from "./lib.mjs";
const { browser, pg } = await open("sketch3d");
const W = p => screenOf(pg, p);
const ev = f => pg.evaluate(f);
const draft = () => ev(() => { const m = window.__sv.model.mode(); return m.kind === "feature" && m.draft.type === "sketch3d" ? JSON.parse(JSON.stringify(m.draft)) : null; });
const s3 = () => ev(() => window.__sv.model.sk3?.() ?? null);
const deco = () => ev(() => { const o = { preview: 0, glyphs: 0, labels: 0, hover: 0 }; window.__sv.viewer.scene.traverse(x => { if (!x.visible) return; if (x.userData?.sk3Preview) o.preview++; if (x.userData?.sk3Hover) o.hover++; }); o.glyphs = document.querySelectorAll(".sk3-rel").length; o.labels = document.querySelectorAll(".sk3-dim").length; return o; });
const near = (a, b, e = 0.05) => a.every((v, i) => Math.abs(v - b[i]) < e);
const ptAt = (d, p) => d.pts.find(q => near(q.p, p, 0.5));
const ctrlAt = async p => { await pg.keyboard.down("Control"); await clickAt(pg, p); await pg.keyboard.up("Control"); };
const tb = async k => { await pg.click(`#mc-pm [data-s3t="${k}"]`); await pg.waitForTimeout(100); };

await pg.click("#new-part");
await idle(pg);

// A1: the command starts with the Line tool and its panel.
await cmd(pg, "3D Sketch");
await pg.waitForTimeout(400);
let d = await draft(), st = await s3();
check("A1", d && (st ? st.tool === "line" : true) && await pg.isVisible("#mc-pm [data-s3t=line]"), "3D Sketch opens with the Line tool and its panel", { open: !!d, st });

// B1/B2/B8: a chain of lines on XY; a rubber band follows the pointer; lines near an axis get Along X/Y.
await clickAt(pg, await W([0, 0, 0]));
await pg.mouse.move(...(await W([20, 1, 0])));
await pg.waitForTimeout(150);
let dc = await deco();
const img1 = await snap(pg, "rubber-band");
check("B2", dc.preview > 0, "a preview line follows the pointer from the last point", dc, img1);
await clickAt(pg, await W([40, 0.4, 0]));
await clickAt(pg, await W([40.3, 30, 0]));
d = await draft();
check("B1", d.segs.length === 2 && d.segs.every(s => s.t === "line"), "two clicks after the first make a chain of two lines", { segs: d.segs.length, pts: d.pts.map(p => p.p) });
check("B8", d.rels.some(r => r.t === "alongX") && d.rels.some(r => r.t === "alongY"), "lines drawn close to an axis get Along X / Along Y", { rels: d.rels.map(r => r.t) });
const img2 = await snap(pg, "chain");
dc = await deco();
check("D3", dc.glyphs >= 2, "relation glyphs show on the lines", dc, img2);

// B3: Tab turns the plane to YZ through the last point; a click goes up in Z.
await pg.keyboard.press("Tab");
await pg.waitForTimeout(100);
st = await s3();
const end = d.pts.at(-1).p;
await clickAt(pg, await W([end[0], end[1], 25]));
d = await draft();
const top = d.pts.at(-1).p;
check("B3", Math.abs(top[0] - end[0]) < 0.01 && top[2] > 15, "Tab turns the plane to YZ through the last point: the next point goes up", { plane: st?.plane, end, top });
check("B8z", d.rels.some(r => r.t === "alongZ"), "a line drawn up near Z gets Along Z", { rels: d.rels.map(r => r.t) });

// A5: Ctrl+Z inside the sketch takes the last point back; Ctrl+Y puts it again.
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(250);
const und = await draft();
await pg.keyboard.press("Control+y");
await pg.waitForTimeout(250);
const red = await draft();
check("A5", und && und.segs.length === 2 && red && red.segs.length === 3, "Ctrl+Z takes the last line back, Ctrl+Y puts it again", { undo: und?.segs.length, redo: red?.segs.length });

// B6: Esc ends the chain, the second Esc leaves the tool; a third Esc does not throw a changed sketch away.
await pg.keyboard.press("Escape"); await pg.waitForTimeout(80);
st = await s3();
const chainEnded = st ? !st.anchor && st.tool === "line" : null;
await pg.keyboard.press("Escape"); await pg.waitForTimeout(80);
st = await s3();
await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
d = await draft();
check("B6", chainEnded !== false && (!st || !st.tool) && !!d, "Esc ends the chain, Esc again leaves the tool, a third Esc keeps the changed sketch open", { chainEnded, tool: st?.tool, open: !!d });
if (!d) { await finish(browser, pg); process.exit(0); }

// C2/C1: hovering a line lights it; a click selects it.
const mid = await W([40, 15, 0]);
await pg.mouse.move(mid[0], mid[1]); await pg.waitForTimeout(150);
dc = await deco();
check("C2", dc.hover > 0, "hovering a line lights it before the click", dc);
await clickAt(pg, mid);
st = await s3();
const line2 = d.segs.find(s => { const a = d.pts.find(p => p.id === s.pts[0]).p, b = d.pts.find(p => p.id === s.pts[1]).p; return Math.abs(a[0] - 40) < 1 && Math.abs(b[0] - 40) < 1 && Math.abs(a[2]) < 1 && Math.abs(b[2]) < 1; });
check("C1", st ? st.sel.length === 1 && st.sel[0] === line2?.id : true, "a click on a line selects it", { sel: st?.sel, line2: line2?.id });

// E1: a Length dimension on the selected line, set to 50: the end moves.
await pg.click('#mc-pm [data-s3r="dim:length"]');
await pg.waitForTimeout(200);
const din = await pg.$("#mc-pm input[data-s3dim]");
await din.fill("50"); await din.press("Enter");
await pg.waitForTimeout(250);
d = await draft();
const L = s => { const a = d.pts.find(p => p.id === s.pts[0]).p, b = d.pts.find(p => p.id === s.pts[1]).p; return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); };
check("E1", Math.abs(L(d.segs.find(s => s.id === line2.id)) - 50) < 1e-6, "a Length dimension drives the line to 50", { len: L(d.segs.find(s => s.id === line2.id)) });
const img3 = await snap(pg, "dimension");
dc = await deco();
check("E2", dc.labels >= 1, "the dimension shows its value in the view", dc, img3);

// E3: an angle between two lines (the middles of the first two lines, wherever the dimension moved them).
await pg.keyboard.press("Escape");
d = await draft();
const segMid = s => { const a = d.pts.find(p => p.id === s.pts[0]).p, b = d.pts.find(p => p.id === s.pts[1]).p; return a.map((v, k) => (v + b[k]) / 2); };
await clickAt(pg, await W(segMid(d.segs[0])));
await ctrlAt(await W(segMid(d.segs[1])));
const angleBtn = await pg.$('#mc-pm [data-s3r="dim:angle"]');
if (angleBtn) { await angleBtn.click(); await pg.waitForTimeout(200); }
d = await draft();
const angTxt = await pg.$$eval(".sk3-dim", els => els.map(e => e.textContent));
check("E3", !!angleBtn && d.dims.some(x => x.t === "angle") && angTxt.some(x => x.endsWith("°")), "two lines take an Angle dimension, shown in degrees in the view", { dims: d.dims.map(x => x.t), angTxt });
// D5: a point and a line offer Midpoint and On line.
await pg.keyboard.press("Escape");
await clickAt(pg, await W(d.pts.at(-1).p));
await ctrlAt(await W(segMid(d.segs[0])));
const mp = await pg.$('#mc-pm [data-s3r="midpoint"]'), ol = await pg.$('#mc-pm [data-s3r="onCurve:onLine"]');
check("D5", !!mp && !!ol, "a point and a line offer Midpoint and On line", {});
// E2: a click on a dimension in the view opens the Modify box; the line follows.
await pg.keyboard.press("Escape");
const dimEl = await pg.$(".sk3-dim");
await dimEl.click();
await pg.waitForTimeout(150);
const modOpen = await pg.isVisible(".mod-box .mod-in");
if (modOpen) { await pg.fill(".mod-box .mod-in", "45"); await pg.keyboard.press("Enter"); await pg.waitForTimeout(250); }
d = await draft();
check("E2b", modOpen && d.dims.some(x => x.t === "length" && Math.abs(x.val.v - 45) < 1e-9), "a click on a dimension in the view opens the Modify box and sets it", { modOpen, dims: d.dims.map(x => [x.t, x.val.v]) });

// B11: dragging a point in the view moves it; relations hold.
await pg.keyboard.press("Escape");
d = await draft();
const tip = d.pts.at(-1);
const a0 = await W(tip.p);
await pg.mouse.move(a0[0], a0[1]); await pg.waitForTimeout(80);
await pg.mouse.down(); await pg.mouse.move(a0[0] + 30, a0[1] - 30, { steps: 6 }); await pg.mouse.up();
await pg.waitForTimeout(250);
const moved = (await draft()).pts.find(p => p.id === tip.id).p;
check("B11", !near(moved, tip.p, 0.5), "dragging a point in the view moves it", { from: tip.p, to: moved });

// B7: the spline tool previews the curve through the pointer.
await tb("spline");
await clickAt(pg, await W((await draft()).pts[0].p));
await clickAt(pg, await W([-20, 15, 0]));
await pg.mouse.move(...(await W([-40, 5, 0]))); await pg.waitForTimeout(150);
dc = await deco();
const img5 = await snap(pg, "spline-preview");
check("B7", dc.preview > 0, "the spline previews through the pointer", dc, img5);
await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
// D6: the spline and the first line share the start point: Tangent joins them smoothly.
d = await draft();
{
  const s0 = d.segs.find(s => s.t === "spline"), l0 = d.segs.find(s => s.t === "line" && s.pts.includes(s0?.pts[0]));
  const sp = s0 ? segMid(s0) : null;
  if (s0 && l0) {
    const q = d.pts.find(p => p.id === s0.pts[1]).p, a = d.pts.find(p => p.id === s0.pts[0]).p;
    await clickAt(pg, await W(q.map((v, k) => (v + a[k]) / 2)));
    await ctrlAt(await W(segMid(l0)));
  }
  const tan = await pg.$('#mc-pm [data-s3r="tangent"]');
  if (tan) { await tan.click(); await pg.waitForTimeout(250); }
  d = await draft();
  check("D6", !!tan && d.rels.some(r => r.t === "tangent"), "a spline and the line it starts from take Tangent", { sel: (await s3())?.sel, rels: d.rels.map(r => r.t), sp, segs: d.segs.map(s => [s.t, ...s.pts]), pts: d.pts.map(p => [p.id, ...p.p.map(v => Math.round(v))]) });
  await pg.keyboard.press("Escape");
}
// The spline was added on the start point: delete it again so the path stays one chain.
d = await draft();
const spl = d.segs.find(s => s.t === "spline");
if (spl) { await clickAt(pg, await W(d.pts.find(p => p.id === spl.pts.at(-1)).p)); await pg.keyboard.press("Delete"); await pg.waitForTimeout(200); }
d = await draft();
check("C3", !d.segs.some(s => s.t === "spline"), "Delete removes the selected point with its spline", { segs: d.segs.map(s => s.t) });

// B12: a corner point of two lines takes a sketch fillet; the radius is asked at once and the arc shows.
d = await draft();
{
  const corner = d.pts.find(p => d.segs.filter(s => s.t === "line" && (s.pts[0] === p.id || s.pts.at(-1) === p.id)).length === 2);
  await clickAt(pg, await W(corner.p));
  const fb = await pg.$('#mc-pm [data-s3r="fillet"]');
  if (fb) await fb.click();
  await pg.waitForTimeout(250);
  const box = await pg.isVisible(".mod-box .mod-in");
  if (box) { await pg.fill(".mod-box .mod-in", "4"); await pg.keyboard.press("Enter"); await pg.waitForTimeout(250); }
  d = await draft();
  const lab = await pg.$$eval(".sk3-dim", els => els.map(e => e.textContent));
  const img6 = await snap(pg, "fillet");
  check("B12", !!fb && box && d.dims.some(x => x.t === "fillet" && Math.abs(x.val.v - 4) < 1e-9) && lab.some(x => x.startsWith("R")), "a corner takes a fillet: the radius box opens, R4 shows on the arc", { box, dims: d.dims.map(x => [x.t, x.val.v]), lab }, img6);
  await pg.keyboard.press("Escape");
}
// A2: ✓ keeps the 3D sketch; F1: a sweep with a circular profile follows it.
await pg.click("#mc-ok");
await idle(pg);
const tree = await ev(() => window.__sv.model.store.doc.features.map(f => f.type));
check("A2", tree.includes("sketch3d"), "✓ adds the 3D sketch to the tree", { tree });
await cmd(pg, "Sweep");
await pg.waitForTimeout(600);
await idle(pg);
const sw = await ev(() => { const m = window.__sv.model.mode(); return m.kind === "feature" ? JSON.parse(JSON.stringify(m.draft)) : null; });
await pg.click("#mc-ok");
await idle(pg);
const vol = await ev(() => window.__sv.model.last()?.props?.volume ?? window.__sv.viewer.parts[0]?.data?.volume ?? 0);
const img4 = await snap(pg, "sweep");
check("F1", sw?.path?.curve && sw.circular && vol > 0, "Sweep takes the 3D sketch as its path with a circular profile", { path: sw?.path, circular: sw?.circular, vol }, img4);

await finish(browser, pg);
