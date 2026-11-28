// 3D sketch on a model, hands-on (docs/3d-sketch-tests.md B14): points clicked on a face, an edge and a vertex
// of a block are held there and follow the block when it changes. Real clicks and keys; window.__sv only read.
import { open, snap, cmd, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("sketch3dmodel");
const W = p => screenOf(pg, p);
const ev = f => pg.evaluate(f);
const draft = () => ev(() => { const m = window.__sv.model.mode(); return m.kind === "feature" && m.draft.type === "sketch3d" ? JSON.parse(JSON.stringify(m.draft)) : null; });
const k3 = () => ev(() => JSON.parse(JSON.stringify(window.__sv.model.store.doc.features.find(f => f.type === "sketch3d") ?? null)));
const near = (a, b, e = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < e);

await makeBlock(pg, 100, 60, 20);
await cmd(pg, "3D Sketch");
await pg.waitForTimeout(400);
// A on the top face, B on the top edge at x = 50 (away from its middle), C on the corner (50, 30, 20).
await clickAt(pg, await W([-20, -5, 20]));
await clickAt(pg, await W([50, 15, 20]));
await clickAt(pg, await W([50, 30, 20]));
await pg.mouse.move(...(await W([10, 40, 40]))); await pg.waitForTimeout(150);
let d = await draft();
const kinds = d ? d.rels.map(r => r.t) : [];
check("B14", !!d && d.pts.length === 3 && ["onFace", "onEdge", "onVertex"].every(k => kinds.includes(k)), "clicks on a model face, edge and vertex hold the points there (On face, On edge, On model vertex)", { kinds, pts: d?.pts.map(p => p.p) }, await snap(pg, "on-model"));
const glyphs = await pg.$$eval(".sk3-rel", els => els.map(e => e.getAttribute("title")).join(" | "));
check("B14b", /On face/.test(glyphs) && /On edge/.test(glyphs) && /On model vertex/.test(glyphs), "the relations show as glyphs in the view with their names", { glyphs });
await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
await pg.click("#mc-ok");
await idle(pg);

// The block gets taller (35): the points follow its top face, edge and corner.
// right-click the block's front face, Edit feature (the 3D sketch points are on the top)
await pg.mouse.move(...(await W([0, -30, 10])));
await pg.mouse.click(...(await W([0, -30, 10])), { button: "right" });
await pg.waitForTimeout(400);
await pg.locator("#mc-menu button", { hasText: "Edit feature" }).first().click();
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
if (dp) { await dp.fill("35"); await dp.press("Enter"); }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.waitForTimeout(500);
const k = await k3();
const P = t => { const r = k?.rels.find(x => x.t === t); return r ? k.pts.find(q => q.id === r.e[0]).p : null; };
const a = P("onFace"), b = P("onEdge"), c = P("onVertex");
const bad = await ev(() => window.__sv.model.last()?.statuses.filter(s => !s.ok || s.warning).map(s => s.message ?? s.warning) ?? []);
const G = t => k?.rels.find(x => x.t === t)?.geo;
const gv = G("onVertex"), ge = G("onEdge");
// The block is drawn by mouse, so its corner is where the drawing put it: compare with the model's own vertex and edge.
check("B14c", !!a && !!b && !!c && !!gv && !!ge && Math.abs(a[2] - 35) < 1e-6 && Math.abs(b[2] - 35) < 1e-6 && Math.abs(b[0] - ge.o[0]) < 1e-6 && near(c, gv.o, 1e-6) && Math.abs(gv.o[2] - 35) < 1e-6 && !bad.length,
  "after the block grows to 35 the points stay on its top face, edge and corner", { a, b, c, bad, vertex: gv?.o, edge: ge?.o }, await snap(pg, "followed"));

await finish(browser, pg);
