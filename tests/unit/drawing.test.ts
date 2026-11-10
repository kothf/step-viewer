// Drawing views (FRS 11.2): HLR projection of a modelled block with a through hole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { project, projectPoly, bounds, geometryDiff, type V3 } from "../../src/kernel/drawing";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  return { id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

export async function block() {
  const m = new Modeller(await occ());
  const hole: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [],
    ents: [{ id: "c0", t: "point", x: 10, y: 0 }, { id: "c1", t: "circle", c: "c0", r: 5 }] };
  const r = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    hole, { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }]));
  return { oc: await occ(), shape: r.body!.shape, names: r.body!.names };
}

test("quick preview (polygonal HLR) matches the exact view's outline", async () => {
  const { oc, shape } = await block();
  const view = { dir: [0, -1, 0] as V3, up: [0, 0, 1] as V3 };
  const p = projectPoly(oc, shape, view, 0.5), e = project(oc, shape, view);
  assert.equal(p.preview, true);
  assert.ok(p.vis.length > 0 && p.vis.every(s => s.k !== "a"), "polylines and lines only");
  p.box.forEach((v, i) => assert.ok(Math.abs(v - e.box[i]) < 0.05, `box ${p.box} vs ${e.box}`));
  // The hole is behind the front face: it shows as hidden lines.
  assert.ok(p.hid.length > 0);
  const t = projectPoly(oc, shape, { dir: [0, 0, 1], up: [0, 1, 0] }, 0.5);
  const xs = t.vis.flatMap(s => s.k === "l" ? [s.p[0], s.p[2]] : s.k === "p" ? s.p.filter((_v, i) => i % 2 === 0) : []);
  assert.ok(xs.some(x => Math.abs(x - 15) < 0.05) && xs.some(x => Math.abs(x - 5) < 0.05), "hole circle seen from the top");
});

test("top view: outline, hole circle, no hidden lines", async () => {
  const { oc, shape } = await block();
  const p = project(oc, shape, { dir: [0, 0, 1], up: [0, 1, 0] });
  const b = bounds(p.vis);
  assert.deepEqual(b.map(v => Math.round(v * 1000) / 1000), [-50, -30, 50, 30]);
  const arcs = p.vis.filter(s => s.k === "a");
  assert.ok(arcs.length >= 1);
  const a = arcs[0] as Extract<typeof arcs[0], { k: "a" }>;
  assert.ok(Math.abs(a.r - 5) < 1e-6 && Math.abs(a.o[0] - 10) < 1e-6, JSON.stringify(a));
  const sweep = arcs.reduce((s, x) => s + (x.k === "a" ? x.a1 - x.a0 : 0), 0);
  assert.ok(Math.abs(sweep - 2 * Math.PI) < 1e-6, `circle sweep ${sweep}`);
  assert.equal(p.hid.length, 0);
});

test("front view: hole shows as two hidden lines, block is 100 × 20", async () => {
  const { oc, shape } = await block();
  const p = project(oc, shape, { dir: [0, -1, 0], up: [0, 0, 1] });
  assert.deepEqual(p.box.map(v => Math.round(v * 1000) / 1000), [-50, 0, 50, 20]);
  const hl = p.hid.filter(s => s.k === "l" && Math.abs(s.p[0] - s.p[2]) < 1e-6);
  const xs = hl.map(s => (s.k === "l" ? Math.round(s.p[0] * 1000) / 1000 : 0)).sort((a, b) => a - b);
  assert.deepEqual([...new Set(xs)], [5, 15]);
});

test("front view: the hidden hole edge on the bottom face hides under the visible bottom edge", async () => {
  const { oc, shape } = await block();
  const p = project(oc, shape, { dir: [0, -1, 0], up: [0, 0, 1] });
  const onBottom = p.hid.filter(s => (s.k === "l" && Math.abs(s.p[1]) < 1e-4 && Math.abs(s.p[3]) < 1e-4) || (s.k === "p" && s.p.every((v, i) => i % 2 === 0 || Math.abs(v) < 1e-4)));
  assert.equal(onBottom.length, 0, JSON.stringify(onBottom));
});

test("projected views: first angle puts the top view below and the left view on the right; third angle the other way", async () => {
  const { projectedDir, ORIENTS, sideOf, fitScale } = await import("../../src/drawing/views");
  const r = (v: number[]) => v.map(x => Math.round(x * 1e6) / 1e6 + 0);
  const front = ORIENTS.front;
  assert.deepEqual(r(projectedDir(front, [0, -1], "first").dir), [0, 0, 1]);
  assert.deepEqual(r(projectedDir(front, [1, 0], "first").dir), [-1, 0, 0]);
  assert.deepEqual(r(projectedDir(front, [0, 1], "third").dir), [0, 0, 1]);
  assert.deepEqual(r(projectedDir(front, [1, 0], "third").dir), [1, 0, 0]);
  assert.deepEqual(r(projectedDir(front, [0, 1], "third").up), [0, 1, 0]);
  assert.deepEqual(sideOf(10, 1), [1, 0]);
  assert.deepEqual(sideOf(-3, -40), [0, -1]);
  assert.deepEqual(sideOf(10, 9), [1, 1]);
  assert.deepEqual(fitScale(400, 100, 250, 150), [1, 2]);
});

test("sheet output: SVG, DXF layers and linetypes, title block fields", async () => {
  const { composeSheet } = await import("../../src/drawing/compose");
  const { sheetDxf, sheetSvg } = await import("../../src/drawing/output");
  const { newSheet } = await import("../../src/drawing/doc");
  const { dirKey } = await import("../../src/drawing/views");
  const { oc, shape } = await block();
  const sh = newSheet(1);
  sh.views.push({ id: "v1", name: "V1", orient: "front", x: 150, y: 150 });
  const cache = new Map([[dirKey({ dir: [0, -1, 0], up: [0, 0, 1] }), project(oc, shape, { dir: [0, -1, 0], up: [0, 0, 1] })]]);
  const fields = { title: "Block", number: "BLK-1", revision: "A", material: "Steel", mass: "1 kg", company: "", author: "", checked: "", approved: "", date: "", scale: "1:1", sheet: "1/1", size: "A3", units: "mm" };
  const c = composeSheet(sh, fields, cache, null, s => s);
  assert.deepEqual(c.boxes.map(b => [b.x0, b.y0, b.x1, b.y1].map(v => Math.round(v))), [[100, 140, 200, 160]]);
  const dxf = sheetDxf(c.prims, 420, 297);
  assert.match(dxf, /\nHIDDEN\n/);
  assert.ok(dxf.includes("AC1009") && dxf.trim().endsWith("EOF"));
  const L = dxf.trim().split("\n");
  let hidden = 0;
  for (let i = 0; i + 5 < L.length; i += 2) if (L[i] === "0" && L[i + 1] === "LINE" && L[i + 3] === "HIDDEN") hidden++;
  assert.equal(hidden, 2);
  const svg = sheetSvg(c.prims, 420, 297);
  assert.match(svg, /width="420mm" height="297mm"/);
  assert.match(svg, />BLK-1</);
});

test("section through the hole: the cut faces are the block's middle slice minus the hole", async () => {
  const { section } = await import("../../src/kernel/drawing");
  const { oc, shape } = await block();
  const s = section(oc, shape, { dir: [0, -1, 0], up: [0, 0, 1] }, [0, 0, 0]);
  const area = (l: number[]) => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return a / 2; };
  const total = s.cut!.reduce((t, l) => t + Math.abs(area(l)), 0);
  assert.ok(Math.abs(total - (100 * 20 - 10 * 20)) < 1e-6, `cut area ${total}`);
  assert.equal(s.cut!.length, 2);
  assert.equal(s.hid.length, 0);
});

test("broken-out section: only the outline is cut away, down to the plane, and its floor is hatched (FR-DRW-015)", async () => {
  const { section, viewAxes } = await import("../../src/kernel/drawing");
  const { viewReq } = await import("../../src/drawing/views");
  const { oc, shape } = await block();
  const view = { dir: [0, 0, 1] as V3, up: [0, 1, 0] as V3 };
  const { n } = viewAxes(view);
  const poly = [-40, -10, -20, -10, -20, 10, -40, 10];
  const s = section(oc, shape, view, [n[0] * 10, n[1] * 10, n[2] * 10], 0.02, poly);
  const area = (l: number[]) => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return a / 2; };
  assert.equal(s.cut!.length, 1);
  assert.ok(Math.abs(Math.abs(area(s.cut![0])) - 400) < 1e-6, `cut area ${area(s.cut![0])}`);
  // The rest of the top view is as before: the hole circle and the outline are still there.
  const b = bounds(s.vis);
  assert.ok(Math.abs(b[2] - b[0] - 100) < 1e-6 && Math.abs(b[3] - b[1] - 60) < 1e-6);
  // The request carries the outline and caches separately from the plain view.
  const sheet = { id: "s", name: "S", size: "A3", scale: [1, 1], projection: "first", views: [], annots: [] } as never;
  const v = { id: "v", name: "Top", orient: "top", at: [0, 0], broken: { poly, d: 10 } } as never;
  const req = viewReq(sheet, v);
  assert.deepEqual(req.poly, poly);
  assert.match(req.key, /\|bo\|10\.000000\|/);
});

test("section/aux directions: a view from the right of a line is the third-angle right view; flipping looks the other way", async () => {
  const { projectedDir, sideView, lookDir, viewDir, viewReq, ORIENTS } = await import("../../src/drawing/views");
  const r = (v: number[]) => v.map(x => Math.round(x * 1e6) / 1e6 + 0);
  const front = ORIENTS.front;
  for (const q of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const a = sideView(front, q), b = projectedDir(front, q, "third");
    assert.deepEqual(r(a.dir), r(b.dir), `dir for ${q}`);
    assert.deepEqual(r(a.up), r(b.up), `up for ${q}`);
  }
  // A vertical cutting line drawn top to bottom: look +1 puts the view on the right (it looks left, at the model's −X side kept).
  const sheet = { id: "s", name: "S", size: "A3" as const, scale: [1, 1] as [number, number], projection: "first" as const, format: "iso" as const, views: [
    { id: "f", name: "F", orient: "front" as const, x: 100, y: 100 },
    { id: "a", name: "A", kind: "section" as const, parent: "f", line: [10, 30, 10, -30] as [number, number, number, number], look: 1 as const, x: 250, y: 100 }] };
  assert.deepEqual(lookDir(sheet.views[1]), [1, 0]);
  assert.deepEqual(r(viewDir(sheet, sheet.views[1]).dir), [1, 0, 0]);
  const req = viewReq(sheet, sheet.views[1]);
  assert.deepEqual(r(req.p!), [10, 0, 30]);
  // Detail views reuse their parent's projection.
  const det = { id: "d", name: "D", kind: "detail" as const, parent: "a", c: [0, 0] as [number, number], r: 5, x: 0, y: 0 };
  assert.equal(viewReq({ ...sheet, views: [...sheet.views, det] }, det).key, req.key);
  // A model view of some components alone: its own views carry the list and a key of their own.
  const solo = { ...sheet, views: [{ ...sheet.views[0], only: ["c2"] }, sheet.views[1]] };
  const sr = viewReq(solo, solo.views[1]);
  assert.deepEqual(sr.only, ["c2"]);
  assert.notEqual(sr.key, req.key);
  assert.equal(viewReq(sheet, sheet.views[1]).only, undefined);
});

test("detail clipping and section hatching", async () => {
  const { clipToCircle, hatch, nextLetter } = await import("../../src/drawing/compose");
  const out = clipToCircle([{ k: "l", c: 0, p: [-10, 0, 10, 0] }, { k: "l", c: 0, p: [20, 20, 30, 30] },
    { k: "a", c: 0, o: [0, 0], r: 10, a0: 0, a1: Math.PI }], [0, 0], 5);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].k === "l" && out[0].p.map(v => Math.round(v * 1e9) / 1e9), [-5, 0, 5, 0]);
  const arc = clipToCircle([{ k: "a", c: 0, o: [10, 0], r: 10, a0: 0, a1: 2 * Math.PI }], [0, 0], 10);
  assert.equal(arc.length, 1);
  assert.ok(arc[0].k === "a" && Math.abs(arc[0].a1 - arc[0].a0 - 2 * Math.PI / 3) < 1e-9);
  // A 10 × 10 square with a 4 × 4 hole: 45° lines 1 mm apart, total length ≈ area / gap.
  const sq = [0, 0, 10, 0, 10, 10, 0, 10], hole = [3, 3, 7, 3, 7, 7, 3, 7];
  const len = hatch([sq, hole], 1).reduce((t, h) => t + Math.hypot(h[2] - h[0], h[3] - h[1]), 0);
  assert.ok(Math.abs(len - 84) < 3, `hatch length ${len}`);
  for (const h of hatch([sq, hole], 1)) {
    const mx = (h[0] + h[2]) / 2, my = (h[1] + h[3]) / 2;
    assert.ok(!(mx > 3.01 && mx < 6.99 && my > 3.01 && my < 6.99), "no hatch in the hole");
  }
  const sh = (letters: string[]) => [{ id: "s", name: "S", size: "A3" as const, scale: [1, 1] as [number, number], projection: "first" as const, format: "iso" as const, views: letters.map((l, i) => ({ id: `v${i}`, name: "", x: 0, y: 0, letter: l })) }];
  assert.equal(nextLetter(sh([])), "A");
  assert.equal(nextLetter(sh(["A", "B", "C", "D", "E", "F", "G", "H"])), "J");
  assert.equal(nextLetter([{ ...sh(["A"])[0], annots: [{ id: "d", t: "datum", view: "v0", ref: { e: "x", h: [0, 0, 0], p: "e" }, pos: [0, 0], letter: "B" }] }] as never), "C", "a datum letter is taken (drawings exam #6)");
});

test("annotations: topology names, centre marks, dimensions, hole callout, model items", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { modelItems } = await import("../../src/drawing/items");
  const { centreMarks, dimGeo, edgeRef, fmtNum, holeText, placeItems, projector, refEdge, dimText } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const m = new Modeller(await occ());
  const s1 = rect("s1", 100, 60);
  s1.dims = [{ id: "d1", name: "D1", t: "hdistance", e: ["s1p1", "s1p2"], val: { v: 100 } }, { id: "d2", name: "D2", t: "vdistance", e: ["s1p2", "s1p3"], val: { v: 60 } }];
  const hole: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [{ id: "d3", name: "D3", t: "diameter", e: ["c1"], val: { v: 10 } }],
    ents: [{ id: "c0", t: "point", x: 10, y: 0 }, { id: "c1", t: "circle", c: "c0", r: 5 }] };
  const d = doc([s1, { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    hole, { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }]);
  const r = m.evaluate(d);
  const oc = await occ();
  const topo = topology(oc, r.body!.shape, r.body!.names);
  // Centre of mass (uniform density): the Ø10 hole 10 mm off centre pulls it 15708/118429 mm the other way; a COM reference follows it.
  const vh = Math.PI * 25 * 20, cx = vh * 10 / (120000 - vh);
  assert.ok(topo.com && Math.abs(Math.abs(topo.com[0]) - cx) < 1e-6 && Math.abs(topo.com[1]) < 1e-6 && Math.abs(topo.com[2] - 10) < 1e-6, `com ${topo.com}`);
  const { refPoint, comPrims, COM_R } = await import("../../src/drawing/annot");
  assert.deepEqual(refPoint({ pt: [5, 5, 5], com: true }, topo), topo.com);
  assert.deepEqual(refPoint({ pt: [5, 5, 5], com: true }, { edges: [], cyls: [] }), [5, 5, 5], "the last place when the model has none");
  assert.deepEqual(refPoint({ pt: [5, 5, 5] }, topo), [5, 5, 5]);
  const sym = comPrims([10, 20]);
  assert.ok(sym.some(p => p.t === "a" && p.r === COM_R) && sym.filter(p => p.t === "p" && p.fill).length === 2);
  const circles = topo.edges.filter(e => e.t === "c" && Math.abs(e.r! - 5) < 1e-9);
  assert.ok(circles.length >= 2 && circles.every(e => e.k.includes("f2")), `hole circles named by their faces: ${circles.map(e => e.k)}`);
  const cyl = topo.cyls.filter(c => Math.abs(c.r - 5) < 1e-9);
  assert.ok(cyl.length >= 1 && Math.abs(cyl[0].v1 - cyl[0].v0 - 20) < 1e-6 && Math.abs(cyl.reduce((t, c) => t + c.sp, 0) - 2 * Math.PI) < 1e-6);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  const view = (o: "top" | "front") => ({ id: o, name: o, orient: o, x: 0, y: 0 });
  const top = projector(ORIENTS.top), front = projector(ORIENTS.front);
  const cmTop = centreMarks(view("top"), pl, topo, top.P, top.n), cmFront = centreMarks(view("front"), pl, topo, front.P, front.n);
  assert.equal(cmTop.length, 2, "a centre mark (two lines) on the hole seen from above");
  assert.equal(cmFront.length, 1, "a centreline on the hole seen from the front");
  assert.ok(cmFront[0].t === "l" && Math.abs(cmFront[0].p[0] - 10) < 1e-9 && Math.abs(cmFront[0].p[1] + 2) < 1e-9 && Math.abs(cmFront[0].p[3] - 22) < 1e-9);
  // A horizontal dimension between the two ends of the front bottom edge, and the hole's diameter.
  const bottom = topo.edges.find(e => e.t === "l" && Math.abs(e.a[2]) < 1e-9 && Math.abs(e.b[2]) < 1e-9 && Math.abs(e.a[1] + 30) < 1e-9 && Math.abs(e.b[1] + 30) < 1e-9)!;
  const dim = { id: "x", t: "dim" as const, view: "front", k: "h" as const, refs: [edgeRef(bottom, "e")], pos: [0, -10] as [number, number] };
  assert.equal(dimGeo(dim, front.P, topo)!.value, 100);
  const dia = { id: "y", t: "dim" as const, view: "top", k: "dia" as const, refs: [edgeRef(circles[0], "e")], pos: [20, 10] as [number, number], tol: { t: "fit" as const, fit: "H7" } };
  assert.equal(dimText(dia, dimGeo(dia, top.P, topo)!, ",").main, "Ø10H7");
  assert.equal(fmtNum(12.5, undefined, ","), "12,5");
  assert.equal(fmtNum(12, 2), "12.00");
  // After the part gets wider the edge is found again by its faces' names, and measures anew.
  const s1w = structuredClone(s1); (s1w.ents[1] as { x: number }).x = 70; (s1w.ents[2] as { x: number }).x = 70;
  const r2 = m.evaluate(doc([s1w, ...d.features.slice(1)]));
  const topo2 = topology(oc, r2.body!.shape, r2.body!.names);
  assert.ok(refEdge(dim.refs[0], topo2));
  assert.equal(dimGeo(dim, front.P, topo2)!.value, 120);
  const ctx = { topo, holes: [], items: [], box: [[-50, -30, 0], [50, 30, 20]] as [V3, V3], dec: ".", label: (s: string) => s };
  assert.deepEqual(holeText(circles[0], ctx), ["Ø10 THRU"]);
  // Model items: the sketch's 100 and 60 go to the top view, the depth 20 to the front view, the Ø10 to the top view; no duplicates the second time.
  const { items } = modelItems(d, r.frames, r.sketches);
  assert.deepEqual(items.map(i => `${i.src}=${i.value}`).sort(), ["f1:depth=20", "s1:d1=100", "s1:d2=60", "s2:d3=10"]);
  const sheet = { id: "s", name: "S", size: "A3" as const, scale: [1, 1] as [number, number], projection: "first" as const, format: "iso" as const, views: [view("front"), { ...view("top"), id: "top" }] as never[], annots: [] as never[] };
  let n = 0;
  const placed = placeItems(sheet, items, () => [-50, -30, 50, 30], () => `a${n++}`);
  assert.deepEqual(placed.map(a => `${a.src}@${a.view}:${a.k}`).sort(), ["f1:depth@front:v", "s1:d1@top:h", "s1:d2@top:v", "s2:d3@top:dia"]);
  assert.equal(placeItems({ ...sheet, annots: placed as never[] }, items, () => [-50, -30, 50, 30], () => "z").length, 0);
});

test("cosmetic threads and shown sketches come from the part (FR-DRW-017)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { modelItems } = await import("../../src/drawing/items");
  const { threadPrims, projector } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const oc = await occ(), m = new Modeller(oc);
  const s1 = rect("s1", 100, 60);
  const hole: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [],
    ents: [{ id: "c0", t: "point", x: 10, y: 0 }, { id: "c1", t: "circle", c: "c0", r: 5 }] };
  const loose: SketchFeature = { id: "s3", type: "sketch", name: "Loose", plane: { face: { name: "f1:end" } }, rels: [], dims: [],
    ents: [{ id: "q0", t: "point", x: -40, y: -20 }, { id: "q1", t: "point", x: -20, y: -20 }, { id: "q2", t: "line", a: "q0", b: "q1" }] };
  const d = doc([s1, { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    hole, { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }, loose,
    { id: "t", type: "thread", name: "Thread1", edge: { faces: ["f1:end", "f2:side:c1"] }, size: "M12", pitch: 1.75, diameter: { v: 12 }, length: { v: 8 }, internal: true } as never]);
  const r = m.evaluate(d);
  const body = r.body!;
  const edgeCircle = (ref: never) => {
    const ad = new oc.BRepAdaptor_Curve_2(m.resolveEdge(body, ref));
    const ci = ad.Circle(), l = ci.Location(), dd = ci.Axis().Direction();
    return { c: [l.X(), l.Y(), l.Z()] as V3, ax: [dd.X(), dd.Y(), dd.Z()] as V3, r: ci.Radius() };
  };
  const mi = modelItems(d, r.frames, r.sketches, edgeCircle);
  assert.deepEqual(mi.sketches.map(s => s.id), ["s3"], "only the sketch no feature uses is shown");
  assert.deepEqual(mi.sketches[0].lines[0].map(p => p.map(x => Math.round(x))), [[-40, -20, 20], [-20, -20, 20]]);
  assert.equal(mi.threads.length, 1);
  const th = mi.threads[0];
  assert.ok(Math.abs(th.c[2] - 20) < 1e-6 && Math.abs(th.r - 5) < 1e-6 && th.internal);
  const topo = topology(oc, body.shape, body.names);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  // From the top the thread starts on the near face: a thin ¾ circle of Ø12; from the front, dashed lines down to z = 12.
  const top = projector(ORIENTS.top), front = projector(ORIENTS.front);
  const pt = threadPrims({ id: "top", name: "top", orient: "top", x: 0, y: 0 }, pl, mi.threads, topo, top.P, top.n);
  assert.ok(pt.length === 1 && pt[0].t === "a" && pt[0].pen === "thin" && Math.abs(pt[0].r - 6) < 1e-9);
  const pf = threadPrims({ id: "front", name: "front", orient: "front", x: 0, y: 0 }, pl, mi.threads, topo, front.P, front.n);
  assert.equal(pf.length, 3);
  assert.ok(pf.every(p => p.t === "l" && p.pen === "hidden"));
  const lim = pf.find(p => p.t === "l" && Math.abs(p.p[1] - p.p[3]) < 1e-9)!;
  assert.ok(lim.t === "l" && Math.abs(lim.p[1] - 12) < 1e-6, `limit line at z = 12: ${JSON.stringify(lim)}`);
});

test("GD&T, datums, surface finish, tables, GOST title block, dangling annotations", async () => {
  const { symbolPrims, gtolPrims, datumPrims, surfPrims, tablePrims, GSYMS } = await import("../../src/drawing/gdt");
  const { formatPrims, frameOf, titleBlockAt } = await import("../../src/drawing/sheet");
  const { viewAnnots, sheetNotes } = await import("../../src/drawing/annot");
  const { newSheet } = await import("../../src/drawing/doc");
  // Every characteristic draws something, all on the annotation layer.
  for (const g of GSYMS) { const p = symbolPrims(g, 0, 0); assert.ok(p.length && p.every(x => x.layer === "ANNOT"), g); }
  // A position frame: Ø0.1 (M) | A | B, two rows stacked downwards, with a leader ending at the feature.
  const f = gtolPrims({ id: "g", t: "gtol", pos: [0, 0], rows: [{ sym: "pos", tol: "0.1", dia: true, mod: "M", datums: ["A", "B"] }, { sym: "flat", tol: "0.02", datums: [] }] }, [100, 100], [80, 90], ",");
  const txt = f.prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.deepEqual(txt, ["Ø0,1", "M", "A", "B", "0,02"]);
  assert.equal(f.box[1], 86);
  assert.equal(f.box[3], 100);
  assert.ok(f.prims.some(p => p.t === "p" && p.fill), "arrow on the leader");
  // A datum on a horizontal edge with the letter above: the triangle points up, away from the edge.
  const d = datumPrims({ id: "d", t: "datum", view: "v", ref: { pt: [0, 0, 0] }, pos: [0, 0], letter: "A" }, [10, 0], [1, 0], [10, 15]);
  const tri = d.prims.find(p => p.t === "p" && p.fill) as { p: number[] };
  assert.equal(tri.p[5], 3);
  assert.deepEqual(d.box, [6.5, 11.5, 13.5, 18.5]);
  {
    // Open triangle: an outline, no fill. Bent leader: up from the apex square to the edge, then level to the frame.
    const o = datumPrims({ id: "d", t: "datum", view: "v", ref: { pt: [0, 0, 0] }, pos: [0, 0], letter: "A", open: true, bent: true }, [10, 0], [1, 0], [30, 15]);
    assert.ok(!o.prims.some(p => p.t === "p" && p.fill), "no filled triangle");
    const ls = o.prims.filter(p => p.t === "l") as unknown as { p: number[] }[];
    assert.equal(ls.length, 2);
    assert.deepEqual(ls[0].p, [10, 3, 10, 15]);
    assert.deepEqual(ls[1].p, [10, 15, 26.5, 15]);
    // Straight above the edge point there is nothing to bend.
    const st = datumPrims({ id: "d", t: "datum", view: "v", ref: { pt: [0, 0, 0] }, pos: [0, 0], letter: "A", bent: true }, [10, 0], [1, 0], [10, 15]);
    assert.equal(st.prims.filter(p => p.t === "l").length, 1);
  }
  {
    // Text above and below a tolerance frame: left-aligned with it, and inside the hit box.
    const row = { sym: "pos" as const, tol: "0.1", datums: ["A"] };
    const g0 = gtolPrims({ id: "g", t: "gtol", pos: [0, 0], rows: [row] }, [10, 20], null, ".");
    const g1 = gtolPrims({ id: "g", t: "gtol", pos: [0, 0], rows: [row], above: "2×", below: "SEP REQT" }, [10, 20], null, ".");
    const tt = g1.prims.filter(p => p.t === "t") as { s: string; x: number; y: number }[];
    const up = tt.find(p => p.s === "2×")!, dn = tt.find(p => p.s === "SEP REQT")!;
    assert.ok(up.x === 10 && up.y > 20 && dn.x === 10 && dn.y < 20 - 7 - 2.5 + 1e-9);
    assert.ok(g1.box[3] > g0.box[3] && g1.box[1] < g0.box[1] && g1.box[0] === g0.box[0]);
    assert.equal(g1.prims.length, g0.prims.length + 2);
  }
  // Surface finish: the removal bar and the roughness under the long leg's line, decimal comma.
  const s = surfPrims({ id: "s", t: "surf", pos: [0, 0], proc: "removal", text: "Ra 3.2" }, [0, 0], ",");
  assert.equal(s.prims.filter(p => p.t === "l").length, 4);
  assert.ok(s.prims.some(p => p.t === "t" && p.s === "Ra 3,2"));
  // Options: a second requirement lengthens the long leg, the lay symbol and the allowance sit by the legs, the circle = all around.
  const s2 = surfPrims({ id: "s", t: "surf", pos: [0, 0], proc: "removal", text: "Ra 3.2", text2: "Rz 6.3", lay: "⊥", allow: "0.5", around: true }, [0, 0], ",");
  const st = s2.prims.filter(p => p.t === "t") as { s: string; x: number; y: number; al?: string }[];
  assert.deepEqual(st.map(p => p.s), ["Ra 3,2", "Rz 6,3", "⊥", "0,5"]);
  const top = 14 * Math.sin(Math.PI / 3);
  assert.ok(Math.abs(st[0].y - (top - 3.6)) < 1e-9 && Math.abs(st[1].y - (top - 7.2)) < 1e-9 && st[1].y > 3.1);
  assert.ok(st[2].x > 0 && st[3].x < 0 && st[3].al === "r");
  const ring = s2.prims.find(p => p.t === "a" && p.r === 1) as { o: number[] };
  assert.ok(Math.abs(ring.o[0] - 7) < 1e-9 && Math.abs(ring.o[1] - top) < 1e-9);
  assert.ok(s2.box[0] < s.box[0] && s2.box[3] > s.box[3]);
  // A revision table anchored at its top-right corner grows to the left; headers are translated.
  const tb = tablePrims({ id: "t", t: "table", kind: "rev", anchor: "tr", pos: [400, 287], title: "REVISIONS", cols: ["Rev.", "Column 2"], rows: [["A", "x"]] }, (k, p) => (k === "Column {n}" ? `C${p!.n}` : k.toLowerCase()));
  assert.equal(tb.box[2], 400);
  assert.equal(tb.box[1], 287 - 18);
  assert.ok(tb.prims.some(p => p.t === "t" && p.s === "C2") && tb.prims.some(p => p.t === "t" && p.s === "revisions" && p.bold));
  // A 43-row parts list on the title block with 120 mm above it splits into side-by-side blocks (drawings exam round 2):
  // 19 rows + header per block, three blocks continuing to the left, none past the room above.
  const rows = Array.from({ length: 43 }, (_, i) => [String(i + 1), `part-${i + 1}`]);
  const bt = tablePrims({ id: "b", t: "table", kind: "bom", anchor: "br", pos: [400, 50], cols: ["Item", "Part number"], rows }, k => k, 120);
  const one = tablePrims({ id: "b", t: "table", kind: "bom", anchor: "br", pos: [400, 50], cols: ["Item", "Part number"], rows: rows.slice(0, 1) }, k => k, 120);
  const W = one.box[2] - one.box[0];
  assert.ok(bt.box[3] <= 170 + 1e-9 && bt.box[1] === 50 && Math.abs(bt.box[0] - (400 - 3 * W)) < 1e-6, JSON.stringify(bt.box));
  assert.equal(bt.prims.filter(p => p.t === "t" && p.s === "Item").length, 3);
  assert.ok(["1", "19", "20", "38", "39", "43"].every(n => bt.prims.some(p => p.t === "t" && p.s === n)));
  // GOST 2.104: frame 20/5/5/5, a 185 × 55 block in the bottom-right corner, sheet "2/3" split into its two cells.
  const g = newSheet(1); g.format = "gost";
  assert.deepEqual(frameOf(g), [20, 5, 415, 292]);
  assert.deepEqual(titleBlockAt(g), [230, 5]);
  const fields = { title: "Plate", number: "АБВГ.123456.001", revision: "", material: "Сталь 45", mass: "", company: "", author: "Ivanov", checked: "", approved: "", date: "", scale: "1:1", sheet: "2/3", size: "A3", units: "mm" };
  const fp = formatPrims(g, fields, k => k);
  const texts = fp.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  for (const k of ["Developed", "N. control", "Lit.", "No. of sheets", "АБВГ.123456.001", "Ivanov", "2", "3"]) assert.ok(texts.includes(k), k);
  assert.ok(fp.every(p => p.t !== "t" || p.x >= 230), "no zone letters on a GOST frame");
  // A datum whose edge is gone is reported and drawn as its framed letter only; sheet-level tables are drawn.
  const sh = { ...newSheet(1), views: [{ id: "v", name: "v", orient: "front" as const, x: 0, y: 0 }], annots: [
    { id: "d1", t: "datum" as const, view: "v", ref: { e: "nope", h: [0, 0, 0] as V3, p: "e" as const }, pos: [0, 10] as [number, number], letter: "A" },
    { id: "t1", t: "table" as const, kind: "general" as const, pos: [30, 280] as [number, number], cols: ["a"], rows: [["b"]] }] };
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-1, -1, 1, 1] as [number, number, number, number], ready: true };
  const out = viewAnnots(sh, sh.views[0], pl, { topo: { edges: [], cyls: [] }, holes: [], items: [], box: null, dec: ".", label: k => k });
  assert.deepEqual(out.dangling, ["d1"]);
  assert.deepEqual(out.hits.map(h => h.id), ["d1"]);
  assert.ok(!out.prims.some(p => p.t === "p" && p.fill), "no triangle without the edge");
  assert.deepEqual(sheetNotes(sh).hits.map(h => h.id), ["t1"]);
});

test("assembly BOM: items in first-use order, pattern and sub-assembly instances counted; balloons numbered", async () => {
  const { bomOf, bomCells, balloonPrims, compOfKey, onVisible } = await import("../../src/drawing/bom");
  const part = (id: string, pn?: string) => ({ name: id, file: `${id}.mcadprt`, doc: { ...doc([]), id, props: pn ? { partNumber: pn } : {} } });
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const top = { schema: 1 as const, kind: "assembly" as const, id: "a", name: "A", units: { length: "mm" as const, decimals: 2 }, parts: { plate: part("plate"), pin: part("pin", "PN-7"), sub: { ...part("sub"), asm: {} as never } },
    components: [{ id: "c1", name: "plate<1>", part: "plate", tf: I }, { id: "c2", name: "pin<1>", part: "pin", tf: I }, { id: "c3", name: "sub<1>", part: "sub", tf: I }, { id: "c4", name: "pin<2>", part: "pin", tf: I, suppressed: true }] };
  // Flattened: a pattern instance of the pin and two parts of the sub-assembly.
  const flat = { ...top, components: [top.components[0], top.components[1], { id: "pt~c2~1", name: "pin<3>", part: "pin", tf: I }, { id: "c3/x", name: "x", part: "sub/x", tf: I }, { id: "c3/y", name: "y", part: "sub/y", tf: I }] };
  const b = bomOf(top, flat);
  assert.deepEqual(bomCells(b), [["1", "plate", "", "1"], ["2", "PN-7", "", "2"], ["3", "sub", "", "1"]]);
  assert.equal(b.itemOf("pt~c2~1"), 2);
  assert.equal(b.itemOf("c3/y"), 3);
  assert.equal(compOfKey("c3/y@f1:end|c3/y@f1:side0"), "c3/y");
  const bp = balloonPrims([0, 20], [0, 0], "2");
  assert.ok(bp.prims.some(p => p.t === "l") && bp.prims.some(p => p.t === "p" && p.fill) && bp.prims.some(p => p.t === "t" && p.s === "2"));
  const proj = { vis: [{ k: "l" as const, c: "sharp" as never, p: [0, 0, 10, 0] as [number, number, number, number] }, { k: "a" as const, c: "sharp" as never, o: [20, 0] as [number, number], r: 5, a0: 0, a1: Math.PI }], hid: [], box: [0, -5, 25, 5] as [number, number, number, number], ms: 0 };
  assert.ok(onVisible(proj, [5, 0.001], 0.01) && onVisible(proj, [20, 5], 0.01) && !onVisible(proj, [20, -5], 0.01));
});

test("balloon styles: split circle with quantities, triangle, hexagon, box and underline (FR-DRW-023)", async () => {
  const { balloonPrims, balloonOutline } = await import("../../src/drawing/bom");
  type L = { t: "l"; p: number[] }; type T = { t: "t"; s: string; y: number };
  const n = (r: { prims: { t: string }[] }, t: string) => r.prims.filter(q => q.t === t).length;
  const plain = balloonPrims([0, 0], null, "7");
  assert.deepEqual([n(plain, "a"), n(plain, "l")], [1, 0]);
  // Split: the circle stays, a line across it, the item above and the quantity below.
  const split = balloonPrims([0, 0], null, "7", ["8"], { shape: "split", lower: ["2", "12"] });
  assert.deepEqual([n(split, "a"), n(split, "l")], [2, 2]);
  const st = split.prims.filter(q => q.t === "t") as unknown as T[];
  assert.deepEqual(st.map(q => q.s), ["7", "2", "8", "12"]);
  assert.ok(st[0].y > 0 && st[1].y < 0 && st[2].y > -10 && st[3].y < -10, "item above the line, quantity below, per balloon");
  // Polygons: sides instead of the circle, all 2R tall so a stack touches.
  for (const [shape, sides] of [["tri", 3], ["hex", 6], ["box", 4]] as const) {
    const r = balloonPrims([0, 0], null, "7", [], { shape });
    assert.deepEqual([n(r, "a"), n(r, "l")], [0, sides], shape);
    const ys = balloonOutline([0, 0], shape)!.map(q => q[1]);
    assert.ok(Math.abs(Math.min(...ys) + 5) < 1e-9 && Math.abs(Math.max(...ys) - 5) < 1e-9, `${shape} is 10 mm tall`);
  }
  const none = balloonPrims([0, 0], null, "7", [], { shape: "none" });
  assert.deepEqual([n(none, "a"), n(none, "l")], [0, 1], "underline only");
  // The leader starts on the outline: on a box side to the right, on the hexagon's corner.
  const lead = (shape: "box" | "hex" | "tri") => (balloonPrims([0, 0], [30, 0], "7", [], { shape }).prims.filter(q => q.t === "l") as unknown as L[]).find(q => q.p[2] === 30 && q.p[3] === 0)!;
  assert.ok(Math.abs(lead("box").p[0] - 5) < 1e-9 && Math.abs(lead("hex").p[0] - 10 / Math.sqrt(3)) < 1e-9);
  // Triangle: a level ray from the centre meets the sloping side half way up, at w/2.
  assert.ok(Math.abs(lead("tri").p[0] - 5 / Math.sqrt(3)) < 1e-9, String(lead("tri").p[0]));
  assert.ok(balloonPrims([0, 0], null, "7", [], { shape: "hex" }).box[2] > plain.box[2], "the hit box takes the wider outline in");
});

test("parts-only BOM, stacked balloons, surface symbol on a slanted edge, GOST signature cells", async () => {
  const { bomOf, bomCells, bomMode, balloonPrims } = await import("../../src/drawing/bom");
  const { rotatePrims, rotateBox } = await import("../../src/drawing/prims");
  const { formatPrims, fieldAt, titleBlockAt } = await import("../../src/drawing/sheet");
  const part = (id: string, pn?: string) => ({ name: id, file: `${id}.mcadprt`, doc: { ...doc([]), id, props: pn ? { partNumber: pn } : {} } });
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const pin = part("pin", "PN-7");
  const top = { schema: 1 as const, kind: "assembly" as const, id: "a", name: "A", units: { length: "mm" as const, decimals: 2 }, parts: { plate: part("plate"), pin, sub: { ...part("sub"), asm: {} as never } },
    components: [{ id: "c1", name: "plate<1>", part: "plate", tf: I }, { id: "c2", name: "pin<1>", part: "pin", tf: I }, { id: "c3", name: "sub<1>", part: "sub", tf: I }] };
  // The sub-assembly holds the same pin document and a washer.
  const flat = { ...top, parts: { plate: top.parts.plate, pin, "sub/p": { ...pin, name: "pin copy" }, "sub/w": part("washer", "W-3") },
    components: [top.components[0], top.components[1], { id: "c3/p", name: "p", part: "sub/p", tf: I }, { id: "c3/w", name: "w", part: "sub/w", tf: I }] };
  const b = bomOf(top, flat, "parts");
  assert.equal(b.mode, "parts");
  assert.deepEqual(bomCells(b), [["1", "plate", "", "1"], ["2", "PN-7", "", "2"], ["3", "W-3", "", "1"]]);
  assert.equal(b.itemOf("c3/p"), 2);
  assert.equal(b.itemOf("c3/w"), 3);
  assert.equal(b.rows[2].comp, "c3/w");
  assert.equal(bomOf(top, flat, "top").itemOf("c3/w"), 3);
  const sheet = { id: "s", name: "S", size: "A3" as const, scale: 1, projection: "first" as const, format: "gost" as const, views: [], annots: [{ id: "t", t: "table" as const, kind: "bom" as const, pos: [0, 0] as [number, number], cols: [], rows: [], mode: "parts" as const }] };
  assert.equal(bomMode(sheet as never), "parts");
  assert.equal(bomMode({ ...sheet, annots: [] } as never), "top");
  // Stacked: three circles one under the other, the leader from the bottom one when the tip is below.
  const st = balloonPrims([0, 20], [0, -30], "1", ["2", "3"]);
  assert.equal(st.prims.filter(p => p.t === "a").length, 3);
  assert.deepEqual(st.prims.filter(p => p.t === "t").map(p => p.t === "t" && p.s), ["1", "2", "3"]);
  const ld = st.prims.find(p => p.t === "l");
  assert.ok(ld && ld.t === "l" && Math.abs(ld.p[1] - (20 - 20 - 5)) < 1e-9);
  assert.ok(st.box[1] < 0 && st.box[3] === 25);
  // Turning by 90°: a line along x stands along y, text turns with it.
  const r = rotatePrims([{ t: "l", p: [0, 0, 10, 0], pen: "thin", layer: "ANNOT" }, { t: "t", x: 10, y: 0, s: "Ra", h: 2.5, al: "l", layer: "ANNOT" }], [0, 0], Math.PI / 2);
  assert.ok(r[0].t === "l" && Math.abs(r[0].p[3] - 10) < 1e-9 && Math.abs(r[0].p[2]) < 1e-9);
  assert.ok(r[1].t === "t" && Math.abs((r[1].rot ?? 0) - 90) < 1e-9);
  assert.deepEqual(rotateBox([0, 0, 10, 2], [0, 0], Math.PI).map(v => Math.round(v)), [-10, -2, 0, 0]);
  // GOST: the control signatures and the letter are typed fields.
  const f = { title: "T", number: "N", revision: "", material: "", mass: "", company: "", author: "", checked: "", approved: "", date: "", tcontrol: "Petrov", ncontrol: "Sidorov", litera: "O1", scale: "1:1", sheet: "1/1", size: "1", units: "mm" };
  const texts = formatPrims(sheet as never, f, s => s).filter(p => p.t === "t").map(p => p.t === "t" ? p.s : "");
  assert.ok(texts.includes("Petrov") && texts.includes("Sidorov") && texts.includes("O") && texts.includes("1"));
  const [bx, by] = titleBlockAt(sheet as never);
  assert.equal(fieldAt(sheet as never, bx + 20, by + 17), "tcontrol");
  assert.equal(fieldAt(sheet as never, bx + 20, by + 7), "ncontrol");
  assert.equal(fieldAt(sheet as never, bx + 142, by + 25), "litera");
});

test("drawing compare: unchanged, removed and added primitives (FR-PDM-051)", async () => {
  const { diffPrims, overlaySvg } = await import("../../src/drawing/diff");
  const L = (x0: number, y0: number, x1: number, y1: number) => ({ t: "l" as const, p: [x0, y0, x1, y1] as [number, number, number, number], pen: "thick" as const, layer: "VISIBLE" as const });
  const a = [L(0, 0, 10, 0), L(0, 0, 0, 10), { t: "t" as const, x: 5, y: 5, s: "A", h: 3.5, al: "c" as const, layer: "TEXT" as const }];
  // The same line drawn the other way round is the same; a moved line and new text are changes.
  const b = [L(10, 0, 0, 0), L(0, 0, 0, 12), { t: "t" as const, x: 5, y: 5, s: "B", h: 3.5, al: "c" as const, layer: "TEXT" as const }];
  const d = diffPrims(a, b);
  assert.equal(d.same.length, 1);
  assert.equal(d.removed.length, 2);
  assert.equal(d.added.length, 2);
  const o = overlaySvg({ name: "Sheet1", W: 20, H: 20, prims: a }, { name: "Sheet1", W: 20, H: 20, prims: b });
  assert.ok(o.svg.includes("#d32f2f") && o.svg.includes("#1b8a3a") && o.removed === 2 && o.added === 2);
  assert.equal(overlaySvg({ name: "S", W: 20, H: 20, prims: a }, { name: "S", W: 20, H: 20, prims: a }).added, 0);
});

test("composite feature control frame, all around, and the BOM of one sub-assembly", async () => {
  const { gtolPrims } = await import("../../src/drawing/gdt");
  const { bomOf, bomCells, sheetBom, subsOf } = await import("../../src/drawing/bom");
  const g = { id: "g", t: "gtol" as const, pos: [0, 0] as [number, number], rows: [{ sym: "pos" as const, tol: "0.5", dia: true, datums: ["A", "B"] }, { sym: "flat" as const, tol: "0.1", dia: true, datums: ["A"], composite: true }], around: true };
  const r = gtolPrims(g, [0, 0], [40, -30], ".");
  // One symbol for both rows: the second row draws no characteristic of its own (no flatness line).
  const one = gtolPrims({ ...g, rows: [g.rows[0]] }, [0, 0], null, ".").prims.length;
  const two = gtolPrims({ ...g, rows: [g.rows[0], { ...g.rows[1], composite: undefined }] }, [0, 0], null, ".").prims.length;
  const comp = gtolPrims(g, [0, 0], null, ".").prims.length;
  assert.ok(comp < two && comp > one);
  assert.ok(r.prims.some(p => p.t === "a" && Math.abs(p.r - 1.5) < 1e-9));
  // Sub-assembly BOM.
  const part = (id: string, pn: string) => ({ name: id, file: `${id}.mcadprt`, doc: { ...doc([]), id, props: { partNumber: pn } } });
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const top = { schema: 1 as const, kind: "assembly" as const, id: "a", name: "A", units: { length: "mm" as const, decimals: 2 }, parts: { plate: part("plate", "PL-1"), sub: { ...part("sub", ""), asm: {} as never } },
    components: [{ id: "c1", name: "Plate<1>", part: "plate", tf: I }, { id: "c3", name: "Hinge<1>", part: "sub", tf: I }] };
  const flat = { ...top, parts: { plate: top.parts.plate, "sub/p": part("pin", "PN-7"), "sub/l": part("leaf", "LF-2") },
    components: [top.components[0], { id: "c3/a", name: "a", part: "sub/l", tf: I }, { id: "c3/b", name: "b", part: "sub/l", tf: I }, { id: "c3/p", name: "p", part: "sub/p", tf: I }] };
  assert.deepEqual(subsOf(top), [{ id: "c3", name: "Hinge<1>" }]);
  assert.deepEqual(bomCells(bomOf(top, flat, "top", "c3")), [["1", "LF-2", "", "2"], ["2", "PN-7", "", "1"]]);
  const sheet = { annots: [{ id: "t", t: "table", kind: "bom", pos: [0, 0], cols: [], rows: [], sub: "c3" }] };
  const b = sheetBom(sheet as never, top, flat);
  assert.equal(b.itemOf("c3/p"), 2);
  assert.equal(b.itemOf("c1"), null);
});

test("geometry compare of two versions: removed and added material by booleans (FR-PDM-050)", async () => {
  const oc = await occ();
  const ext = (depth: number, w = 100) => new Modeller(oc).evaluate(doc([rect("s1", w, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: depth } }])).body!.shape;
  // v1 100 × 60 × 20; v2 is 10 mm narrower and 5 mm taller.
  const d = geometryDiff(oc, ext(20), ext(25, 90));
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-3, `${a} ≈ ${b}`);
  near(d.a.volume, 120000); near(d.b.volume, 135000);
  near(d.removed.volume, 10 * 60 * 20); near(d.added.volume, 90 * 60 * 5);
  near(d.b.box[1][2] - d.b.box[0][2], 25);
  assert.ok(d.removed.mesh.index.length > 0 && d.added.mesh.index.length > 0 && d.common.index.length > 0);
  // The same body twice: nothing either way.
  const same = geometryDiff(oc, ext(20), ext(20));
  assert.ok(same.removed.volume < 1e-6 && same.added.volume < 1e-6);
});

test("offset and half sections: the staircase cutter, hatched faces on every cut plane (FR-DRW-012)", async () => {
  const { section } = await import("../../src/kernel/drawing");
  const { cutLegs, staircase, viewReq, viewDir, FAR } = await import("../../src/drawing/views");
  assert.equal(cutLegs([0, 0, 10, 0, 15, 5]), null, "a leg at 45° is refused");
  assert.equal(cutLegs([0, 0, 10, 0, 10, 5, 0, 5]), null, "a cut may not run back");
  const st = staircase(cutLegs([0, 0, 10, 0, 10, -5, 20, -5])!, [0, -1]);
  assert.deepEqual(st.offs, [0, 5]);
  assert.deepEqual(st.pts, [-FAR, FAR, -FAR, 0, 10, 0, 10, 5, FAR, 5, FAR, FAR]);
  assert.deepEqual(staircase(cutLegs([0, 0, 10, 0, 10, 8])!, [0, -1]).pts, [-FAR, FAR, -FAR, 0, 10, 0, 10, FAR], "a half section stops at the step");
  const { oc, shape } = await block();
  const area = (l: number[]) => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return a / 2; };
  const parent = { id: "t", name: "Top", orient: "top", x: 100, y: 200 };
  const cutArea = (path: number[]) => {
    for (const look of [1, -1] as const) {
      const v = { id: "s", name: "A", kind: "section", parent: "t", line: path.slice(0, 4), path, look, x: 100, y: 80 };
      const sheet = { id: "sh", name: "S", size: "A3", scale: [1, 1], projection: "third", views: [parent, v], annots: [] } as never;
      if (viewDir(sheet, v as never).dir[1] > -0.9) continue;
      const req = viewReq(sheet, v as never);
      assert.ok(req.stair && req.key.includes("|st|"));
      const s = section(oc, shape, req.view, req.p!, 0.02, undefined, { stair: req.stair });
      return s.cut!.reduce((t, l) => t + Math.abs(area(l)), 0);
    }
    throw new Error("no front-facing look");
  };
  // Offset: y = 10 left of x = 0, then y = 0 through the hole (x 5..15).
  const off = cutArea([-60, 10, 0, 10, 0, 0, 60, 0]);
  assert.ok(Math.abs(off - (50 * 20 + 50 * 20 - 10 * 20)) < 1e-4, `offset cut area ${off}`);
  // Half: y = 0 up to x = 10 (half the hole), then the step: the right part stays whole.
  const half = cutArea([-60, 0, 10, 0, 10, -40]);
  assert.ok(Math.abs(half - (60 * 20 - 5 * 20)) < 1e-4, `half cut area ${half}`);
  // The cutting path on the parent: thick at the ends and bends, arrows at both ends, only at the start for a half section.
  const { childMarks, placement } = await import("../../src/drawing/compose");
  const marks = (path: number[]) => {
    const v = { id: "s", name: "A", kind: "section", parent: "t", line: path.slice(0, 4), path, look: 1, letter: "A", x: 100, y: 80 };
    const sheet = { id: "sh", name: "S", size: "A3", scale: [1, 1], projection: "third", views: [parent, v], annots: [] } as never;
    const pr = childMarks(sheet, parent as never, placement(sheet, parent as never, undefined, [[-50, -30, 0], [50, 30, 20]]));
    return { arrows: pr.filter(p => p.t === "p").length, thick: pr.filter(p => p.t === "l" && p.pen === "frame").length, letters: pr.filter(p => p.t === "t" && p.s === "A").length };
  };
  assert.deepEqual(marks([-60, 10, 0, 10, 0, 0, 60, 0]), { arrows: 2, thick: 6, letters: 2 });
  assert.deepEqual(marks([-60, 0, 10, 0, 10, -40]), { arrows: 1, thick: 4, letters: 1 });
});

test("shaded views: triangles facing the viewer, back to front, drawn under the visible edges (FR-DRW-010)", async () => {
  const { shadeTris } = await import("../../src/kernel/drawing");
  const { viewReq } = await import("../../src/drawing/views");
  const { viewPrims, placement } = await import("../../src/drawing/compose");
  const { sheetSvg } = await import("../../src/drawing/output");
  const { oc, shape } = await block();
  const top = { dir: [0, 0, 1] as V3, up: [0, 1, 0] as V3 };
  const t = shadeTris(oc, shape, top, 0.2);
  assert.equal(t.length % 7, 0);
  let area = 0;
  for (let i = 0; i < t.length; i += 7) area += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
  assert.ok(Math.abs(area - (100 * 60 - Math.PI * 25)) < 2, `only the top face shows: ${area}`);
  assert.ok(t.every((g, i) => i % 7 !== 6 || (g > 0.3 && g < 1)));
  // An isometric view sees three faces, sorted back to front; its greys differ by face.
  const iso = shadeTris(oc, shape, { dir: [1, -1, 1], up: [0, 0, 1] }, 0.2);
  assert.ok(new Set(iso.filter((_, i) => i % 7 === 6)).size >= 3);
  const sheet = { id: "s", name: "S", size: "A3", scale: [1, 1], projection: "first", views: [], annots: [] } as never;
  const v = { id: "v", name: "Top", orient: "top", x: 200, y: 150, style: "shadedEdges" } as never;
  const req = viewReq(sheet, v);
  assert.ok(req.shade && req.key.endsWith("|sh"));
  assert.ok(!viewReq(sheet, { ...(v as object), style: "hlr" } as never).shade);
  const proj = { ...project(oc, shape, top), shade: t };
  const pl = placement(sheet, v, proj, null);
  const pr = viewPrims(v, proj, pl);
  const firstLine = pr.findIndex(p => p.t !== "p" || p.gray === undefined);
  assert.equal(pr.slice(0, firstLine).length, t.length / 7, "the shading comes first");
  assert.ok(pr.slice(firstLine).some(p => p.layer === "VISIBLE"), "shaded with edges keeps the visible edges");
  assert.ok(!viewPrims({ ...(v as object), style: "shaded" } as never, proj, pl).some(p => p.layer === "VISIBLE" || p.layer === "HIDDEN"), "shaded alone has no edges");
  assert.match(sheetSvg(pr, 420, 297), /fill="#[0-9a-f]{6}" stroke="#[0-9a-f]{6}"/);
});

test("section hatching by material and component: loops know their solid, patterns follow the material (FR-DRW-012)", async () => {
  const { section } = await import("../../src/kernel/drawing");
  const { sectionHatch, materialPattern, patternHatch } = await import("../../src/drawing/compose");
  const oc = await occ();
  // Two separate blocks side by side in one compound, like two components of an assembly.
  const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  b.Add(comp, new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(-20, -5, 0), 20, 10, 10).Shape());
  b.Add(comp, new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(0, -5, 0), 20, 10, 10).Shape());
  const s = section(oc, comp, { dir: [0, -1, 0], up: [0, 0, 1] }, [0, 0, 0]);
  assert.equal(s.cut!.length, 2);
  assert.deepEqual([...s.cutOf!].sort(), [0, 1]);
  // Each loop lies on its own block: the first block's loop is left of x = 0.
  const left = s.cut!.findIndex(l => Math.max(...l.filter((_, i) => i % 2 === 0)) <= 1e-6);
  assert.equal(s.cutOf![left], 0);

  assert.equal(materialPattern("Steel (carbon)"), "ansi32");
  assert.equal(materialPattern("Stainless steel 304"), "ansi32");
  assert.equal(materialPattern("Brass"), "ansi33");
  assert.equal(materialPattern("Aluminium 6061"), "ansi38");
  assert.equal(materialPattern("ABS"), "ansi34");
  assert.equal(materialPattern("Polycarbonate"), "ansi34");
  assert.equal(materialPattern("Cast iron"), "ansi31");
  assert.equal(materialPattern(null), "ansi31");

  const sq = [0, 0, 20, 0, 20, 20, 0, 20];
  const ang = (h: number[]) => Math.round(Math.atan2(h[3] - h[1], h[2] - h[0]) * 180 / Math.PI + 360) % 180;
  // ANSI31 = one family; ANSI32 = pairs (twice the lines of a 2·gap family); ANSI37 = crossed.
  const n31 = patternHatch([sq], "ansi31", 2, Math.PI / 4).length, n32 = patternHatch([sq], "ansi32", 2, Math.PI / 4).length;
  assert.ok(Math.abs(n32 - n31) <= 2, `ansi32 ${n32} vs ansi31 ${n31}`);
  assert.deepEqual([...new Set(patternHatch([sq], "ansi37", 2, Math.PI / 4).map(ang))].sort((a, b) => a - b), [45, 135]);
  // ANSI33's second family is dashed: more, shorter pieces than its solid family.
  const h33 = patternHatch([sq], "ansi33", 2, Math.PI / 4), len = (h: number[]) => Math.hypot(h[2] - h[0], h[3] - h[1]);
  assert.ok(Math.min(...h33.map(len)) < 2.01);

  // Two components: the second is hatched at 135°; one component alone stays at the view's angle.
  const hs = { gap: 2, angle: 45, pattern: "material" as const };
  const two = sectionHatch([sq, sq.map((x, i) => i % 2 ? x : x + 30)], hs, ["a", "b"], ["Cast iron", "Cast iron"]);
  assert.deepEqual([...new Set(two.map(ang))].sort((a, b) => a - b), [45, 135]);
  const one = sectionHatch([sq], hs, ["a"], ["Cast iron"]);
  assert.deepEqual([...new Set(one.map(ang))], [45]);
  // A fixed pattern overrides the material.
  const fixed = sectionHatch([sq], { ...hs, pattern: "ansi37" }, ["a"], ["Steel (carbon)"]);
  assert.deepEqual([...new Set(fixed.map(ang))].sort((a, b) => a - b), [45, 135]);
});

test("aligned section: the second leg turns about the centre into the first leg's plane (FR-DRW-012)", async () => {
  const { section, alignedShape, viewAxes, shapeInfo } = await import("../../src/kernel/drawing");
  const { alignedLegs } = await import("../../src/drawing/views");
  const oc = await occ();
  // A square plate, legs along −x and +y from the centre: a 90° turn.
  const plate = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(-50, -50, 0), 100, 100, 10).Shape();
  const al = alignedLegs([-40, 0, 0, 0, 0, 40])!;
  assert.ok(Math.abs(al.ang + Math.PI / 2) < 1e-9, `angle ${al.ang}`);
  assert.equal(alignedLegs([-40, 0, 0, 0, 40, 0]), null);
  assert.equal(alignedLegs([-40, 0, 0, 0, -30, 0]), null);
  const n = viewAxes({ dir: [0, 0, 1], up: [0, 1, 0] }).n;
  const s: V3 = [(al.d2[0] - al.d1[0]) / Math.SQRT2, (al.d2[1] - al.d1[1]) / Math.SQRT2, 0];
  const turned = alignedShape(oc, plate, { c: [0, 0, 0], s, axis: n, ang: al.ang });
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(turned, props, false, false, false);
  assert.ok(Math.abs(props.Mass() - 100 * 100 * 10) < 1e-3, `volume ${props.Mass()}`);
  const [lo, hi] = shapeInfo(oc, turned).box;
  assert.ok(Math.abs(lo[0] + 50) < 1e-6 && Math.abs(hi[0] - 50) < 1e-6 && Math.abs(lo[1] + 50) < 1e-6 && Math.abs(hi[1] - 50) < 1e-6);
  // Cut along the first leg's line: 50 mm of the kept half plus the 50 mm leg turned onto it.
  const cut = section(oc, turned, { dir: [0, -1, 0], up: [0, 0, 1] }, [0, 0, 0]);
  const area = (l: number[]) => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return a / 2; };
  const total = cut.cut!.reduce((t, l) => t + Math.abs(area(l)), 0);
  assert.ok(Math.abs(total - 100 * 10) < 1e-6, `cut area ${total}`);
});

test("ISO 286 fit limits: H7, g6, js6, K7, N7, P7, s6 and the dimension text (FR-DRW-021)", async () => {
  const { fitLimits, parseFit } = await import("../../src/drawing/iso286");
  const { dimText } = await import("../../src/drawing/annot");
  const um = (c: string, d: number) => { const l = fitLimits(c, d)!; return [Math.round(l.up * 1000), Math.round(l.lo * 1000)]; };
  assert.deepEqual(um("H7", 20), [21, 0]);
  assert.deepEqual(um("g6", 20), [-7, -20]);
  assert.deepEqual(um("h6", 50), [0, -16]);
  assert.deepEqual(um("f7", 25), [-20, -41]);
  assert.deepEqual(um("js6", 20), [6, -6]);
  assert.deepEqual(um("k6", 20), [15, 2]);
  assert.deepEqual(um("n6", 40), [33, 17]);
  assert.deepEqual(um("p6", 20), [35, 22]);
  assert.deepEqual(um("s6", 60), [72, 53]);
  assert.deepEqual(um("r6", 100), [73, 51]);
  assert.deepEqual(um("K7", 20), [6, -15]);
  assert.deepEqual(um("M7", 20), [0, -21]);
  assert.deepEqual(um("N7", 20), [-7, -28]);
  assert.deepEqual(um("P7", 20), [-14, -35]);
  assert.deepEqual(um("S7", 60), [-42, -72]);
  assert.deepEqual(um("F8", 10), [35, 13]);
  assert.deepEqual(um("H11", 120), [220, 0]);
  assert.equal(fitLimits("Z7", 20), null);
  assert.equal(fitLimits("H7", 600), null);
  assert.equal(parseFit("H7/g6"), null);
  const g = { k: "dia", value: 20 } as any;
  const base = { t: "dim", id: "d", view: "v", k: "dia", refs: [], pos: [0, 0] } as any;
  assert.deepEqual(dimText({ ...base, tol: { t: "fit", fit: "H7" } }, g, "."), { main: "Ø20H7" });
  assert.deepEqual(dimText({ ...base, tol: { t: "fit", fit: "H7", show: "limits" } }, g, "."), { main: "Ø20", up: "+0.021", lo: "0" });
  assert.deepEqual(dimText({ ...base, tol: { t: "fit", fit: "g6", show: "both" } }, g, ","), { main: "Ø20g6", up: "−0,007", lo: "−0,020" });
  assert.deepEqual(dimText({ ...base, tol: { t: "fit", fit: "H7/g6", show: "both" } }, g, "."), { main: "Ø20H7/g6" });
});

test("detail profile: lines, arcs and polylines are trimmed to a polygon (FR-DRW-013)", async () => {
  const { clipToPoly, inPoly, clipDetail } = await import("../../src/drawing/compose");
  // An L-shaped profile: the 20 × 20 square minus its top-right quarter.
  const L = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
  assert.ok(inPoly(L, 5, 15) && inPoly(L, 15, 5) && !inPoly(L, 15, 15) && !inPoly(L, -1, 5));
  const len = (g: any) => Math.hypot(g.p[2] - g.p[0], g.p[3] - g.p[1]);
  // A line across at y = 15 keeps x 0..10; at y = 5 keeps 0..20.
  const a = clipToPoly([{ k: "l", c: 0, p: [-5, 15, 25, 15] }], L);
  assert.equal(a.length, 1); assert.ok(Math.abs(len(a[0]) - 10) < 1e-9);
  const b = clipToPoly([{ k: "l", c: 0, p: [-5, 5, 25, 5] }], L);
  assert.ok(Math.abs(len(b[0]) - 20) < 1e-9);
  // A diagonal through the notch comes out in two pieces.
  const d = clipToPoly([{ k: "l", c: 0, p: [0, 20, 20, 0] }], L);
  assert.equal(d.length, 1);
  const e = clipToPoly([{ k: "l", c: 0, p: [0, 25, 25, 0] }], L);
  assert.equal(e.length, 2);
  // A full circle about (10, 10) of radius 5: the quarter in the notch goes.
  const c = clipToPoly([{ k: "a", c: 0, o: [10, 10], r: 5, a0: 0, a1: 2 * Math.PI }], L);
  const sw = c.reduce((t, g: any) => t + g.a1 - g.a0, 0);
  assert.ok(Math.abs(sw - 1.5 * Math.PI) < 1e-9, `sweep ${sw}`);
  // A polyline zig-zagging out of the profile and back splits into runs.
  const p = clipToPoly([{ k: "p", c: 0, p: [2, 15, 8, 15, 15, 15, 15, 5, 18, 5] }], L);
  assert.equal(p.length, 2);
  // Views without a profile keep the circle.
  const circ = clipDetail({ id: "d", name: "", kind: "detail", c: [0, 0], r: 1, x: 0, y: 0 } as any, [{ k: "l", c: 0, p: [-5, 0, 5, 0] }]);
  assert.ok(Math.abs(len(circ[0]) - 2) < 1e-9);
});

test("DXF 2000: handles, owners, model space records, LWPOLYLINE, Unicode text (FR-DRW-030)", async () => {
  const { sheetDxf2000 } = await import("../../src/drawing/output");
  const prims: any[] = [
    { t: "l", p: [0, 0, 100, 0], pen: "thick", layer: "VISIBLE" },
    { t: "a", o: [50, 50], r: 10, a0: 0, a1: Math.PI, pen: "thick", layer: "VISIBLE" },
    { t: "a", o: [50, 50], r: 5, a0: 0, a1: 2 * Math.PI, pen: "hidden", layer: "HIDDEN" },
    { t: "p", p: [0, 0, 10, 0, 10, 10], pen: "thin", layer: "ANNOT", closed: true },
    { t: "p", p: [0, 0, 3, 1, 3, -1], pen: "thin", layer: "ANNOT", fill: true, closed: true },
    { t: "t", x: 10, y: 10, s: "Масштаб 2:1 Ø16", h: 3.5, al: "c", layer: "TEXT" },
  ];
  const d = sheetDxf2000(prims, 420, 297);
  if (process.env.DXF_OUT) (await import("node:fs")).writeFileSync(process.env.DXF_OUT, d);
  const lines = d.split("\n");
  const val = (code: string, name: string) => { for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] === code && lines[i + 1] === name) return lines[i + 3]; return null; };
  assert.equal(val("9", "$ACADVER"), "AC1015");
  // Every handle is unique and below $HANDSEED.
  const hs: number[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) if ((lines[i] === "5" || lines[i] === "105") && lines[i - 2] !== "9") hs.push(parseInt(lines[i + 1], 16));
  const seed = parseInt(lines[lines.indexOf("$HANDSEED") + 2], 16);
  assert.equal(new Set(hs).size, hs.length);
  assert.ok(Math.max(...hs) < seed);
  assert.ok(d.includes("LWPOLYLINE") && d.includes("*Model_Space") && d.includes("ACAD_GROUP"));
  assert.ok(d.includes("\\U+041C\\U+0430") && d.includes("\\U+00D8") && !/[^\x00-\x7f]/.test(d));
});

test("DXF 2000 of a big sheet: no call stack overflow (File ▸ Export on the Leuenberger engine drawing)", async () => {
  const { sheetDxf2000 } = await import("../../src/drawing/output");
  const prims: any[] = [];
  for (let i = 0; i < 60000; i++) prims.push({ t: "l", p: [i % 400, 0, i % 400, 10], pen: "thin", layer: "VISIBLE" });
  const d = sheetDxf2000(prims, 420, 297);
  assert.ok(d.startsWith("0\nSECTION\n2\nHEADER") && d.trimEnd().endsWith("EOF"));
  assert.equal(d.split("\nLINE\n").length - 1, 60000);
});

test("note property links: $PRP:\"name\" takes the title block field, SolidWorks names too (FR-DRW-023)", async () => {
  const { expandProps, useProps, notePrims } = await import("../../src/drawing/annot");
  const props = { material: "Steel", mass: "1.25 kg", number: "MC-001", scale: "2:1", title: "Plate" };
  assert.equal(expandProps('MATERIAL: $PRP:"Material"', props), "MATERIAL: Steel");
  assert.equal(expandProps('$PRP:"Weight" / $PRP:"PartNo" / $PRPSHEET:"SW-Sheet Scale" / $PRP:"Description"', props), "1.25 kg / MC-001 / 2:1 / Plate");
  assert.equal(expandProps('$PRP:"Nope"', props), '$PRP:"Nope"');
  useProps({ material: "Brass" });
  const r = notePrims({ id: "n", t: "note", pos: [0, 0], text: 'M: $PRP:"material"' }, [0, 0], null);
  assert.equal((r.prims[0] as any).s, "M: Brass");
});

test("view configuration: projected, section and detail views follow their model view", async () => {
  const { viewConfig, viewReq } = await import("../../src/drawing/views");
  const sheet = { id: "s", name: "Sheet1", size: "A3", landscape: true, scale: [1, 1], projection: "first", views: [
    { id: "f", name: "F", orient: "front", x: 100, y: 100, config: "Tall" },
    { id: "t", name: "T", parent: "f", side: [0, 1], x: 100, y: 200 },
    { id: "d", name: "D", kind: "detail", parent: "t", c: [0, 0], r: 5, x: 200, y: 200 },
    { id: "g", name: "G", orient: "top", x: 300, y: 100 },
  ] } as any;
  assert.equal(viewConfig(sheet, sheet.views[2]), "Tall");
  assert.equal(viewConfig(sheet, sheet.views[3]), undefined);
  const r = viewReq(sheet, sheet.views[1]);
  assert.equal(r.cfg, "Tall");
  assert.ok(r.key.endsWith("|cfg|Tall"));
  assert.ok(!viewReq(sheet, sheet.views[3]).key.includes("|cfg|"));
});

test("switching first/third angle keeps each projected view the same view and moves it across its parent", async () => {
  const { switchProjection, projectedDir, viewDir } = await import("../../src/drawing/views");
  const sheet = { id: "s", name: "S", size: "A3" as const, scale: [1, 1] as [number, number], projection: "first" as const, format: "iso" as const, views: [
    { id: "f", name: "F", orient: "front" as const, x: 100, y: 150 },
    { id: "t", name: "T", parent: "f", side: [0, -1] as [number, number], x: 100, y: 80 },
    { id: "r", name: "R", parent: "f", side: [1, 0] as [number, number], x: 200, y: 150 },
    { id: "rr", name: "RR", parent: "r", side: [1, 0] as [number, number], x: 280, y: 150 }] };
  const before = sheet.views.map(v => viewDir(sheet as any, v as any).dir.map(c => Math.round(c) + 0).join());
  switchProjection(sheet as any, "third");
  const after = sheet.views.map(v => viewDir(sheet as any, v as any).dir.map(c => Math.round(c) + 0).join());
  assert.deepEqual(after, before);
  assert.deepEqual(sheet.views.map(v => [v.x, v.y]), [[100, 150], [100, 220], [0, 150], [-80, 150]]);
  assert.equal(sheet.projection, "third");
  void projectedDir;
});


test("a component-only view keeps the topology of its components only", async () => {
  const { topoOnly } = await import("../../src/drawing/views");
  const topo = { edges: [{ k: "c1@f1|c1@f2" }, { k: "c2@f1|c2@f3" }, { k: "s1/c3@f0|s1/c3@f1" }], cyls: [{ f: "c1@f4" }, { f: "c2@f2" }, {}] };
  const a = topoOnly(topo, ["c2"]);
  assert.deepEqual(a.edges.map(e => e.k), ["c2@f1|c2@f3"]);
  assert.deepEqual(a.cyls.map(c => c.f), ["c2@f2"]);
  assert.deepEqual(topoOnly(topo, ["s1"]).edges.map(e => e.k), ["s1/c3@f0|s1/c3@f1"]);
  assert.equal(topoOnly(topo, undefined), topo);
});

test("revision cloud: scallops bulge outwards whichever way the corners go", async () => {
  const { cloudPrims } = await import("../../src/drawing/annot");
  for (const pts of [[0, 0, 30, 0, 30, 20, 0, 20], [0, 0, 0, 20, 30, 20, 30, 0]]) {
    const r = cloudPrims({ id: "c", t: "cloud", pos: [100, 50], pts, arc: 10 });
    const arcs = r.prims.filter(p => p.t === "a") as any[];
    assert.equal(arcs.length, 3 + 2 + 3 + 2);
    for (const a of arcs) {
      const m = (a.a0 + a.a1) / 2, x = a.o[0] + a.r * Math.cos(m), y = a.o[1] + a.r * Math.sin(m);
      assert.ok(x < 100 + 1e-9 || x > 130 - 1e-9 || y < 50 + 1e-9 || y > 70 - 1e-9, "bulge outside the rectangle");
    }
    assert.deepEqual(r.box.map(v => Math.round(v * 100) / 100), [95, 45, 135, 75]);
  }
  const rv = cloudPrims({ id: "c", t: "cloud", pos: [0, 0], pts: [0, 0, 10, 0, 10, 10], rev: "B" });
  assert.ok(rv.prims.some(p => p.t === "t" && p.s === "B"));
});

test("text widths follow DejaVu Sans; long title block values break into two lines", async () => {
  const { textWidth } = await import("../../src/drawing/textWidth");
  const { cellText } = await import("../../src/drawing/sheet");
  assert.ok(Math.abs(textWidth("Ø12H7", 3.5) - 16.7) < 0.1, String(textWidth("Ø12H7", 3.5)));
  assert.ok(textWidth("WWW", 1, true) > textWidth("WWW", 1));
  const title = "1 CYLINDER HORIZONTAL DOUBLE ACTING STEAM ENGINE WITH REVERSER (B=25 S=40)";
  const ps = cellText(title, 140, 30, 5, 78, 11, true) as any[];
  assert.equal(ps.length, 2);
  for (const p of ps) assert.ok(textWidth(p.s, p.h, true) <= 78 + 1e-9 && p.h >= 2, `${p.s} ${p.h}`);
  assert.equal(ps.map(p => p.s).join(" "), title);
  assert.ok(ps[0].y > ps[1].y);
  const one = cellText("BASE PLATE", 140, 30, 5, 78, 11, true) as any[];
  assert.equal(one.length, 1); assert.equal(one[0].h, 5);
});

test("centreline: halfway between two parallel edges over both, centre mark on an arc", async () => {
  const { clineSegs } = await import("../../src/drawing/annot");
  const pl = { s: 2, uc: 0, vc: 0, x: 100, y: 100, box: [0, 0, 0, 0] as [number, number, number, number], ready: true };
  const P = (p: V3): [number, number] => [p[0], p[1]];
  const topo = { cyls: [], edges: [
    { k: "A", t: "l" as const, a: [0, 0, 0] as V3, b: [40, 0, 0] as V3, m: [20, 0, 0] as V3 },
    { k: "B", t: "l" as const, a: [10, 10, 0] as V3, b: [50, 10, 0] as V3, m: [30, 10, 0] as V3 },
    { k: "C", t: "l" as const, a: [0, 0, 0] as V3, b: [10, 10, 0] as V3, m: [5, 5, 0] as V3 },
    { k: "R", t: "c" as const, a: [5, 0, 0] as V3, b: [0, 5, 0] as V3, m: [5 * Math.SQRT1_2, 5 * Math.SQRT1_2, 0] as V3, c: [0, 0, 0] as V3, ax: [0, 0, 1] as V3, r: 5, sp: Math.PI / 2 },
  ] };
  const ref = (k: string, m: V3) => ({ e: k, h: m, p: "e" as const });
  const g = clineSegs({ id: "l", t: "cline", view: "v", k: "line", refs: [ref("A", [20, 0, 0]), ref("B", [30, 10, 0])] }, P, topo, pl)!;
  assert.equal(g.length, 1);
  // Halfway at y = 5 (sheet 100 + 2·5), from x = 0 to 50 plus 2 sheet mm (1 model mm) each way.
  assert.deepEqual(g[0].map(v => Math.round(v * 1000) / 1000), [100 - 2, 110, 200 + 2, 110]);
  assert.equal(clineSegs({ id: "l", t: "cline", view: "v", k: "line", refs: [ref("A", [20, 0, 0]), ref("C", [5, 5, 0])] }, P, topo, pl), null, "not parallel");
  const pts = clineSegs({ id: "l", t: "cline", view: "v", k: "line", refs: [{ pt: [0, 0, 0] }, { pt: [0, 20, 0] }], ext: 0 }, P, topo, pl)!;
  assert.deepEqual(pts[0], [100, 100, 100, 140]);
  const mk = clineSegs({ id: "m", t: "cline", view: "v", k: "mark", refs: [ref("R", topo.edges[3].m)] }, P, topo, pl)!;
  assert.equal(mk.length, 2);
  assert.deepEqual(mk[0].map(v => Math.round(v * 1000) / 1000), [100 - 12, 100, 100 + 12, 100]);
  assert.equal(clineSegs({ id: "m", t: "cline", view: "v", k: "mark", refs: [ref("A", [20, 0, 0])] }, P, topo, pl), null, "a line is not round");
});

test("weld symbol: reference line away from the arrow, identification line only for a one-sided other-side weld", async () => {
  const { weldPrims } = await import("../../src/drawing/weld");
  const base = { id: "w", t: "weld" as const, pos: [100, 100] as [number, number] };
  const dashed = (ps: any[]) => ps.filter(p => p.t === "l" && p.pen === "hidden").length;
  const r = weldPrims({ ...base, arrow: { sym: "fillet", size: "a4", len: "100" } }, [100, 100], [80, 80]);
  assert.equal(dashed(r.prims), 0);
  assert.ok(r.box[0] >= 100 - 1e-9 && r.box[2] > 110, "runs right when the joint is to the left");
  assert.ok(r.prims.some(p => p.t === "t" && p.s === "a4") && r.prims.some(p => p.t === "t" && p.s === "100"));
  const tri = r.prims.find(p => p.t === "p" && p.closed) as any;
  assert.ok(tri && Math.max(...tri.p.filter((_: number, i: number) => i % 2)) <= 100 + 1e-9, "arrow-side symbol below the line");
  const l = weldPrims({ ...base, other: { sym: "v" } }, [100, 100], [130, 80]);
  assert.equal(dashed(l.prims), 1);
  assert.ok(l.box[2] <= 100 + 1e-9, "runs left when the joint is to the right");
  const sym = weldPrims({ ...base, arrow: { sym: "fillet", size: "a3" }, other: { sym: "fillet", size: "a3" }, around: true, field: true, tail: "111" }, [100, 100], null);
  assert.equal(dashed(sym.prims), 0, "symmetric welds need no identification line");
  assert.equal(sym.prims.filter(p => p.t === "p" && p.closed && !(p as any).fill).length, 2);
  assert.ok(sym.prims.some(p => p.t === "a" && p.r === 1.5) && sym.prims.some(p => p.t === "p" && (p as any).fill) && sym.prims.some(p => p.t === "t" && p.s === "111"));
});

test("datum target: split frame, plain leader, cross / phantom line / hatched phantom area", async () => {
  const { dtargetPrims, targetRadius } = await import("../../src/drawing/dtarget");
  const base = { id: "d", t: "dtarget" as const, pos: [100, 100] as [number, number], label: "A1" };
  const R = targetRadius(base);
  assert.equal(R, 4.5);
  const pt = dtargetPrims({ ...base, kind: "point" }, [100, 100], [80, 100]);
  assert.ok(pt.prims.some(p => p.t === "a" && p.r === R) && pt.prims.some(p => p.t === "t" && p.s === "A1"));
  assert.ok(!pt.prims.some(p => p.t === "p" && (p as any).fill), "no arrowhead");
  assert.equal(pt.prims.filter(p => p.t === "l" && p.pen === "thick").length, 2, "a cross on the point");
  const leader = pt.prims.find(p => p.t === "l" && p.pen === "thin" && p.p[2] === 80) as any;
  assert.ok(leader && leader.p[0] === 100 - R, "leader from the frame to the cross");
  assert.deepEqual(pt.box, [100 - R, 100 - R, 100 + R, 100 + R], "picked by its frame");
  const ln = dtargetPrims({ ...base, kind: "line", d: 20 }, [100, 100], [80, 60], [0, 1], 0.5);
  const ph = ln.prims.find(p => p.t === "l" && p.pen === "phantom") as any;
  assert.deepEqual(ph.p, [80, 55, 80, 65], "line along the edge, d × scale long");
  const ar = dtargetPrims({ ...base, kind: "area", d: 8, size: "Ø8" }, [100, 100], [70, 100], [1, 0], 1);
  assert.ok(ar.prims.some(p => p.t === "a" && p.pen === "phantom" && p.r === 4) && ar.prims.some(p => p.t === "t" && p.s === "Ø8"));
  const hatch = ar.prims.filter(p => p.t === "l" && p.pen === "thin").slice(2) as any[];
  assert.ok(hatch.length >= 4 && hatch.every(h => Math.hypot(h.p[0] - 70, h.p[1] - 100) <= 4 + 1e-9 && Math.hypot(h.p[2] - 70, h.p[3] - 100) <= 4 + 1e-9), "hatching inside the area");
  assert.ok(targetRadius({ label: "A1", size: "Ø12.5×20" }) > 4.5, "long texts widen the frame");
});

test("sheet sketch: entities, pick outlines and horizontal/vertical inference", async () => {
  const { skPrims, skPoints, orthoSnap } = await import("../../src/drawing/sheetSketch");
  const { ringDist } = await import("../../src/drawing/annot");
  const rect = skPrims({ id: "r", t: "sk", k: "rect", pos: [10, 20], pts: [30, -10] });
  assert.deepEqual(rect.box, [10, 10, 40, 20]);
  assert.equal(rect.open, false);
  assert.ok((rect.prims[0] as any).closed && (rect.prims[0] as any).pen === "thin");
  const line = skPrims({ id: "l", t: "sk", k: "line", pos: [0, 0], pts: [10, 0], pen: "center" });
  assert.equal(line.prims[0].t, "l");
  assert.equal((line.prims[0] as any).layer, "CENTER");
  assert.ok(ringDist(line.ring, 5, 0.5, line.open) < 0.6 && ringDist(line.ring, 15, 0, line.open) > 4, "an open line is picked along itself only");
  const poly = { id: "p", t: "sk" as const, k: "poly" as const, pos: [0, 0] as [number, number], pts: [0, 0, 10, 0, 10, 10] };
  assert.ok(ringDist(skPrims(poly).ring, 5, 5, true) > 3, "open polyline: no closing side");
  assert.ok(ringDist(skPrims({ ...poly, closed: true }).ring, 5, 5, false) < 0.1);
  const c = skPrims({ id: "c", t: "sk", k: "circle", pos: [50, 50], pts: [3, 4] });
  assert.equal((c.prims[0] as any).r, 5);
  assert.deepEqual(skPoints({ id: "r", t: "sk", k: "rect", pos: [0, 0], pts: [2, 3] }), [[0, 0], [2, 0], [2, 3], [0, 3]]);
  assert.deepEqual(orthoSnap([0, 0], [20, 0.5]), { p: [20, 0], hv: "h" });
  assert.deepEqual(orthoSnap([0, 0], [0.4, -20]), { p: [0, -20], hv: "v" });
  assert.equal(orthoSnap([0, 0], [10, 10]).hv, null);
});

test("section views can be dimensioned on their cut faces: cut edges named after the face they cut (FR-DRW-021)", async () => {
  const { section, topology } = await import("../../src/kernel/drawing");
  const { dimGeo, edgeRef, projector, refEdge, withCut } = await import("../../src/drawing/annot");
  const { oc, shape, names } = await block();
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
  const namer = (f: any) => { const i = map.FindIndex(f); return i > 0 ? names[i - 1] : null; };
  const view = { dir: [0, -1, 0] as V3, up: [0, 0, 1] as V3 };
  const s = section(oc, shape, view, [0, 0, 0], 0.02, undefined, { namer });
  const cuts = s.cutEdges ?? [];
  assert.ok(cuts.length >= 8, `cut edges ${cuts.length}`);
  assert.ok(cuts.every(e => e.k.endsWith("|§") && Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6), "named, on the plane");
  // The hole's wall cut gives two lines 10 apart (its diameter), both named after the hole face.
  const hole = cuts.filter(e => e.t === "l" && Math.abs(e.a[0] - e.b[0]) < 1e-6 && Math.abs(Math.abs(e.a[0] - 10) - 5) < 1e-6);
  assert.equal(hole.length, 2);
  assert.equal(hole[0].k, hole[1].k);
  const facts = withCut({ topo: topology(oc, shape, names) }, s)!;
  assert.equal(facts.topo.edges.length, topology(oc, shape, names).edges.length + cuts.length);
  const { P } = projector(view);
  const dim = { id: "d", t: "dim" as const, view: "v", pos: [10, 30] as [number, number], k: "al" as const, refs: [edgeRef(hole[0], "e"), edgeRef(hole[1], "e")] };
  const g = dimGeo(dim, P, facts.topo);
  assert.ok(g && Math.abs(g.value - 10) < 1e-6, `value ${g?.value}`);
  // Without the section's edges the reference is gone (a plain view of the uncut model).
  assert.equal(refEdge(dim.refs[0], topology(oc, shape, names)), null);
});

test("bolt circles: evenly spaced holes on a circle get a centre-line circle and radial marks (FR-DRW-023)", async () => {
  const { boltCircles, centreMarks, projector } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const at = (R: number, degs: number[], r: number, o: [number, number] = [0, 0]) => degs.map(d => ({ c: [o[0] + R * Math.cos(d * Math.PI / 180), o[1] + R * Math.sin(d * Math.PI / 180)] as [number, number], r }));
  // Six Ø6 on PCD 80 around a Ø30 bore: one full bolt circle; the bore keeps its cross.
  const six = [...at(40, [0, 60, 120, 180, 240, 300], 3), { c: [0, 0] as [number, number], r: 15 }];
  const b6 = boltCircles(six);
  assert.equal(b6.length, 1);
  assert.ok(b6[0].full && Math.abs(b6[0].R - 40) < 1e-9 && Math.hypot(...b6[0].o) < 1e-9 && b6[0].members.length === 6);
  // A partial pattern (3 holes, 30° apart, one missing) is an arc from the first to the last hole.
  const part = boltCircles(at(50, [10, 40, 100], 2));
  assert.equal(part.length, 1);
  assert.ok(!part[0].full && Math.abs(part[0].a0 - 10 * Math.PI / 180) < 1e-9 && Math.abs(part[0].a1 - 100 * Math.PI / 180) < 1e-9);
  // Holes at the corners of a square are a pattern; an oblong rectangle's corners and uneven spacing are not.
  assert.equal(boltCircles([{ c: [10, 10], r: 2 }, { c: [-10, 10], r: 2 }, { c: [-10, -10], r: 2 }, { c: [10, -10], r: 2 }]).length, 1);
  assert.equal(boltCircles([{ c: [30, 10], r: 2 }, { c: [-30, 10], r: 2 }, { c: [-30, -10], r: 2 }, { c: [30, -10], r: 2 }]).length, 0);
  assert.equal(boltCircles(at(40, [0, 50, 120], 3)).length, 0, "gaps 50 and 70: not whole multiples");
  assert.equal(boltCircles(at(40, [0, 90, 180], 3).map((h, i) => ({ ...h, r: i ? 3 : 4 }))).length, 0, "holes of different sizes");
  // Drawn: the circle as one centre-line polyline, a radial line per hole, a cross on the bore; off = crosses.
  const edges = six.map((h, i) => ({ k: `h${i}`, t: "c" as const, a: [0, 0, 0] as [number, number, number], b: [0, 0, 0] as [number, number, number], c: [h.c[0], h.c[1], 0] as [number, number, number], m: [h.c[0] + h.r, h.c[1], 0] as [number, number, number], ax: [0, 0, 1] as [number, number, number], r: h.r, sp: 2 * Math.PI }));
  const topo = { edges, cyls: [] };
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -50, 50, 50] as [number, number, number, number], ready: true };
  const top = projector(ORIENTS.top);
  const on = centreMarks({ id: "v", name: "v", orient: "top", x: 0, y: 0 }, pl, topo as any, top.P, top.n);
  assert.equal(on.filter(p => p.t === "p").length, 1);
  assert.equal(on.filter(p => p.t === "l").length, 6 + 2);
  const poly = on.find(p => p.t === "p")!;
  assert.ok(poly.t === "p" && poly.pen === "center" && Math.abs(Math.hypot(poly.p[0], poly.p[1]) - 40) < 1e-9);
  const radial = on.find(p => p.t === "l" && Math.abs(p.p[1] - p.p[3]) < 1e-4 && p.p[0] > 30);
  assert.ok(radial && radial.t === "l" && Math.abs(radial.p[0] - 35) < 1e-4 && Math.abs(radial.p[2] - 45) < 1e-4, "radial line through the hole at 0°");
  const off = centreMarks({ id: "v", name: "v", orient: "top", x: 0, y: 0, bolts: false }, pl, topo as any, top.P, top.n);
  assert.equal(off.filter(p => p.t === "p").length, 0);
  assert.equal(off.length, 14);
});

test("hole rows: evenly spaced holes on a line get one centreline and a cross line each (FR-DRW-023)", async () => {
  const { holeLines, centreMarks, projector } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const H = (x: number, y: number, r = 2) => ({ c: [x, y] as [number, number], r });
  // A row of four along x; uneven spacing, two holes or mixed sizes are not rows.
  const four = holeLines([H(0, 0), H(10, 0), H(20, 0), H(30, 0)]);
  assert.equal(four.length, 1);
  assert.deepEqual(four[0].members, [0, 1, 2, 3]);
  assert.ok(Math.abs(four[0].d[0] - 1) < 1e-12 && Math.abs(four[0].d[1]) < 1e-12);
  assert.equal(holeLines([H(0, 0), H(10, 0), H(25, 0)]).length, 0, "uneven");
  assert.equal(holeLines([H(0, 0), H(10, 0)]).length, 0, "two holes");
  assert.equal(holeLines([H(0, 0), H(10, 0), H(20, 0, 3)]).length, 0, "mixed sizes");
  // A slanted row; a run of 3 inside a longer uneven line.
  const slant = holeLines([H(0, 0), H(6, 8), H(12, 16)]);
  assert.ok(slant.length === 1 && Math.abs(slant[0].d[0] - 0.6) < 1e-12 && Math.abs(slant[0].d[1] - 0.8) < 1e-12);
  assert.deepEqual(holeLines([H(0, 0), H(10, 0), H(20, 0), H(45, 0)]).map(r => r.members), [[0, 1, 2]]);
  // A 3 × 3 grid: three rows and three columns, no diagonals.
  const grid: { c: [number, number]; r: number }[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.push(H(x * 20, y * 15));
  const g = holeLines(grid);
  assert.equal(g.length, 6);
  assert.ok(g.every(r => Math.abs(r.d[0] * r.d[1]) < 1e-12), "rows and columns only");
  // Drawn: four holes in a row of a view = one centreline 2 mm past the end holes plus a short line across each.
  const rowHoles = [H(-15, 0), H(-5, 0), H(5, 0), H(15, 0)];
  const edges = rowHoles.map((h, i) => ({ k: `h${i}`, t: "c" as const, a: [0, 0, 0] as [number, number, number], b: [0, 0, 0] as [number, number, number], c: [h.c[0], h.c[1], 0] as [number, number, number], m: [h.c[0] + h.r, h.c[1], 0] as [number, number, number], ax: [0, 0, 1] as [number, number, number], r: h.r, sp: 2 * Math.PI }));
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -50, 50, 50] as [number, number, number, number], ready: true };
  const top = projector(ORIENTS.top);
  const on = centreMarks({ id: "v", name: "v", orient: "top", x: 0, y: 0 }, pl, { edges, cyls: [] } as any, top.P, top.n);
  const ls = on.filter(p => p.t === "l").map(p => p.p.map(x => Math.round(x * 1000) / 1000));
  assert.equal(ls.length, 5, JSON.stringify(ls));
  const along = ls.filter(q => Math.abs(q[1] - q[3]) < 1e-9);
  assert.ok(along.length === 1 && Math.min(along[0][0], along[0][2]) === -19 && Math.max(along[0][0], along[0][2]) === 19, `row line: ${along}`);
  assert.equal(ls.filter(q => Math.abs(q[0] - q[2]) < 1e-9 && Math.abs(Math.abs(q[1] - q[3]) - 8) < 1e-9).length, 4);
  const off = centreMarks({ id: "v", name: "v", orient: "top", x: 0, y: 0, rows: false }, pl, { edges, cyls: [] } as any, top.P, top.n);
  assert.equal(off.length, 8, "plain crosses when off");
});

test("slot centre marks: a centreline over a straight slot and a cross line at each end, no circle marks (FR-DRW-023)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { centreMarks, projector, straightSlots } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const slot: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [
    P("c1", -20, 0), P("c2", 20, 0), P("q1", -20, 5), P("q2", -20, -5), P("q3", 20, -5), P("q4", 20, 5),
    { id: "a1", t: "arc", c: "c1", a: "q1", b: "q2" }, { id: "a2", t: "arc", c: "c2", a: "q3", b: "q4" },
    { id: "l1", t: "line", a: "q2", b: "q3" }, { id: "l2", t: "line", a: "q4", b: "q1" }] };
  const d = doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    slot, { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }]);
  const r = m.evaluate(d);
  const topo = topology(await occ(), r.body!.shape, r.body!.names);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  const top = projector(ORIENTS.top);
  const cm = centreMarks({ id: "t", name: "t", orient: "top", x: 0, y: 0 }, pl, topo, top.P, top.n);
  const ls = cm.flatMap(p => p.t === "l" ? [p.p.map(x => Math.round(x * 1000) / 1000)] : []);
  assert.equal(ls.length, 3, `one centreline and two end lines, no crosses on the slot ends: ${JSON.stringify(ls)}`);
  const along = ls.find(q => Math.abs(q[1]) < 1e-6 && Math.abs(q[3]) < 1e-6)!;
  assert.ok(along && Math.min(along[0], along[2]) === -27 && Math.max(along[0], along[2]) === 27, `centreline 2 mm past the ends: ${along}`);
  const ends = ls.filter(q => Math.abs(q[0] - q[2]) < 1e-6).map(q => [q[0], Math.min(q[1], q[3]), Math.max(q[1], q[3])]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(ends, [[-20, -7, 7], [20, -7, 7]]);
  // From the side each slot end (half a cylinder with material outside) gets its axis, 2 mm past the faces; from the
  // end the two axes fall on one line.
  const front = projector(ORIENTS.front);
  const side = centreMarks({ id: "f", name: "f", orient: "front", x: 0, y: 0 }, pl, topo, front.P, front.n)
    .flatMap(p => p.t === "l" ? [p.p.map(x => Math.round(x * 1000) / 1000)] : []).sort((a, b) => a[0] - b[0]);
  assert.equal(side.length, 2, `two end axes side-on: ${JSON.stringify(side)}`);
  assert.ok(side.every(q => q[0] === q[2] && Math.abs(Math.abs(q[3] - q[1]) - 24) < 1e-6) && side[0][0] === -20 && side[1][0] === 20, JSON.stringify(side));
  const right = projector(ORIENTS.right);
  assert.equal(centreMarks({ id: "r", name: "r", orient: "right", x: 0, y: 0 }, pl, topo, right.P, right.n).length, 1, "one line looking along the slot");
  // An outside half round (a rounded bar end) and a quarter (an inside fillet) get none.
  const bar = { edges: [], cyls: [{ o: [0, 0, 0] as V3, ax: [0, 1, 0] as V3, r: 5, v0: 0, v1: 20, sp: Math.PI }, { o: [30, 0, 0] as V3, ax: [0, 1, 0] as V3, r: 5, v0: 0, v1: 20, sp: Math.PI / 2, in: true }] };
  assert.equal(centreMarks({ id: "t", name: "t", orient: "top", x: 0, y: 0 }, pl, bar, top.P, top.n).length, 0);
  // Pure: half circles facing each other pair up; facing the same way or of another radius do not.
  assert.equal(straightSlots([{ c: [0, 0], r: 3, m: [-1, 0] }, { c: [10, 0], r: 3, m: [1, 0] }]).length, 1);
  assert.equal(straightSlots([{ c: [0, 0], r: 3, m: [1, 0] }, { c: [10, 0], r: 3, m: [-1, 0] }]).length, 0, "bulging towards each other");
  assert.equal(straightSlots([{ c: [0, 0], r: 3, m: [-1, 0] }, { c: [10, 0], r: 4, m: [1, 0] }]).length, 0);
});

test("arc slot centre marks: a centre-line arc through the end centres and a radial line across each end (FR-DRW-023)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { centreMarks, projector, arcSlots } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const m = new Modeller(await occ());
  // Arc slot about O = (0, -10): centre radius 25 from 30° to 150°, 8 mm wide.
  const at = (id: string, R: number, deg: number): SkEnt => ({ id, t: "point", x: R * Math.cos(deg * Math.PI / 180), y: -10 + R * Math.sin(deg * Math.PI / 180) });
  const slot: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [
    at("o", 0, 0), at("c1", 25, 30), at("c2", 25, 150), at("o1", 29, 30), at("o2", 29, 150), at("i1", 21, 30), at("i2", 21, 150),
    { id: "k1", t: "arc", c: "c1", a: "i1", b: "o1" }, { id: "k2", t: "arc", c: "c2", a: "o2", b: "i2" },
    { id: "ao", t: "arc", c: "o", a: "o1", b: "o2" }, { id: "ai", t: "arc", c: "o", a: "i1", b: "i2" }] };
  const d = doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    slot, { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }]);
  const r = m.evaluate(d);
  assert.ok(r.body, JSON.stringify(r.errors ?? r.warnings));
  const topo = topology(await occ(), r.body!.shape, r.body!.names);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  const top = projector(ORIENTS.top);
  const cm = centreMarks({ id: "t", name: "t", orient: "top", x: 0, y: 0 }, pl, topo, top.P, top.n);
  const ls = cm.filter(p => p.t === "l"), ps = cm.filter(p => p.t === "p");
  assert.equal(ls.length, 2, `two radial end lines, no crosses: ${JSON.stringify(ls.map(p => p.p))}`);
  assert.equal(ps.length, 1, "one centre-line arc");
  const arc = ps[0].p as number[];
  for (let i = 0; i < arc.length; i += 2) assert.ok(Math.abs(Math.hypot(arc[i], arc[i + 1] + 10) - 25) < 1e-6, "arc on R 25 about O");
  const ang = (i: number) => Math.atan2(arc[i + 1] + 10, arc[i]) * 180 / Math.PI;
  const span = [ang(0), ang(arc.length - 2)].sort((a, b) => a - b), past = (6 / 25) * 180 / Math.PI;
  assert.ok(Math.abs(span[0] - (30 - past)) < 1e-3 && Math.abs(span[1] - (150 + past)) < 1e-3, `arc runs 2 mm past the end caps: ${span}`);
  for (const l of ls) {
    const [x0, y0, x1, y1] = l.p as number[], mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    assert.ok(Math.abs(Math.hypot(mx, my + 10) - 25) < 1e-4, "end line centred on an end centre");
    assert.ok(Math.abs(Math.hypot(x1 - x0, y1 - y0) - 12) < 1e-4, "end line 2 mm past the slot width");
    assert.ok(Math.abs((x1 - x0) * -(my + 10) + (y1 - y0) * mx) < 1e-3, "end line radial");
  }
  // Pure: the pairing needs a concentric arc of R ± r.
  const halves = [{ c: [25, 0] as [number, number], r: 4, m: [0, -1] as [number, number] }, { c: [-25, 0] as [number, number], r: 4, m: [0, -1] as [number, number] }];
  assert.equal(arcSlots(halves, [{ c: [0, 0], r: 29 }]).length, 1);
  const one = arcSlots(halves, [{ c: [0, 0], r: 21 }])[0];
  assert.ok(one && Math.abs(one.a0) < 1e-9 && Math.abs(one.a1 - Math.PI) < 1e-9 && Math.abs(one.R - 25) < 1e-9);
  assert.equal(arcSlots(halves, []).length, 0, "two loose notches");
  assert.equal(arcSlots([halves[0], { ...halves[1], m: [0, 1] }], [{ c: [0, 0], r: 29 }]).length, 0, "ends bulging the same way round");
});

test("cones and tori seen from the side get a centreline on their axis (FR-DRW-023)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { centreMarks, projector } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const m = new Modeller(await occ());
  // A frustum Ø20 → Ø10 over 20 mm, revolved about the sketch's y axis: one cone and two flat caps, no cylinder.
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const pts = [P("p0", 0, 0), P("p1", 10, 0), P("p2", 5, 20), P("p3", 0, 20)], ids = pts.map(p => p.id);
  const s: SketchFeature = { id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, rels: [], dims: [],
    ents: [...pts, ...ids.map((a, i): SkEnt => ({ id: `l${i}`, t: "line", a, b: ids[(i + 1) % ids.length] }))] };
  const r = m.evaluate(doc([s, { id: "f1", type: "revolve", name: "R", sketch: "r", op: "boss", axis: "l3", angle: { v: 2 * Math.PI } } as Feature]));
  assert.ok(r.body, JSON.stringify(r.errors ?? r.warnings));
  const topo = topology(await occ(), r.body!.shape, r.body!.names);
  assert.equal(topo.cyls.length, 0);
  assert.ok(topo.revs!.some(q => q.k === "cone"), `a cone: ${topo.revs!.map(q => q.k)}`);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  const front = projector(ORIENTS.front);
  const cm = centreMarks({ id: "f", name: "f", orient: "front", x: 0, y: 0 }, pl, topo, front.P, front.n);
  assert.equal(cm.length, 1, "one centreline on the cone's axis");
  const [x0, y0, x1, y1] = cm[0].p as number[];
  assert.ok(Math.abs(x0) < 1e-9 && Math.abs(x1) < 1e-9 && Math.abs(Math.abs(y1 - y0) - 24) < 1e-6, `along the axis, 2 mm past both ends: ${cm[0].p}`);
  // A torus alone (an O-ring) gets one too; a cone that does not go all round does not.
  const ring = { edges: [], cyls: [], revs: [{ k: "torus" as const, o: [0, 0, 0] as V3, ax: [0, 0, 1] as V3, v0: -2, v1: 2, sp: 2 * Math.PI }] };
  assert.equal(centreMarks({ id: "f", name: "f", orient: "front", x: 0, y: 0 }, pl, ring, front.P, front.n).length, 1);
  const part = { edges: [], cyls: [], revs: [{ k: "cone" as const, o: [0, 0, 0] as V3, ax: [0, 0, 1] as V3, v0: 0, v1: 5, sp: Math.PI / 2 }] };
  assert.equal(centreMarks({ id: "f", name: "f", orient: "front", x: 0, y: 0 }, pl, part, front.P, front.n).length, 0);
});

test("spheres get a centre cross from any side; corner blends do not (FR-DRW-023)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { centreMarks, projector } = await import("../../src/drawing/annot");
  const { ORIENTS } = await import("../../src/drawing/views");
  const m = new Modeller(await occ());
  // A half disc R10 revolved about its straight side: a ball.
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const s: SketchFeature = { id: "b", type: "sketch", name: "b", plane: { std: "XZ" }, rels: [], dims: [],
    ents: [P("o", 0, 0), P("a", 0, -10), P("c", 0, 10), { id: "k", t: "arc", c: "o", a: "a", b: "c" }, { id: "l", t: "line", a: "c", b: "a" }] };
  const r = m.evaluate(doc([s, { id: "f1", type: "revolve", name: "R", sketch: "b", op: "boss", axis: "l", angle: { v: 2 * Math.PI } } as Feature]));
  assert.ok(r.body, JSON.stringify(r.errors ?? r.warnings));
  const topo = topology(await occ(), r.body!.shape, r.body!.names);
  const ball = topo.revs!.find(q => q.k === "sphere");
  assert.ok(ball && Math.abs(ball.r! - 10) < 1e-6, `a sphere R10: ${JSON.stringify(topo.revs)}`);
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0, box: [-50, -30, 50, 30] as [number, number, number, number], ready: true };
  for (const o of ["front", "top", "iso"] as const) {
    const pr = projector(ORIENTS[o]);
    const cm = centreMarks({ id: "f", name: "f", orient: o, x: 0, y: 0 }, pl, { ...topo, cyls: [] }, pr.P, pr.n);
    const c = pr.P(ball!.o), cross = cm.filter(g => { const p = g.p as number[]; return Math.abs((p[0] + p[2]) / 2 - c[0]) < 1e-6 && Math.abs((p[1] + p[3]) / 2 - c[1]) < 1e-6 && Math.abs(Math.hypot(p[2] - p[0], p[3] - p[1]) - 24) < 1e-6; });
    assert.equal(cross.length, 2, `${o}: a 24 mm cross at the centre (${JSON.stringify(cm.map(g => g.p))})`);
  }
  const blend = { edges: [], cyls: [], revs: [{ k: "sphere" as const, o: [0, 0, 0] as V3, ax: [0, 0, 1] as V3, v0: -2, v1: 2, sp: Math.PI / 2, r: 2 }] };
  const front = projector(ORIENTS.front);
  assert.equal(centreMarks({ id: "f", name: "f", orient: "front", x: 0, y: 0 }, pl, blend, front.P, front.n).length, 0);
});

test("hole callouts read from the geometry: count, counterbore, countersink, blind with a point (FR-DRW-022)", async () => {
  const { topology } = await import("../../src/kernel/drawing");
  const { holeText, geoHole } = await import("../../src/drawing/annot");
  const oc = await occ(), m = new Modeller(oc);
  const s1 = rect("s1", 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const top = { face: { name: "f1:end" } };
  const feats: Feature[] = [s1, ex,
    { id: "h1", type: "hole", name: "H1", plane: top, pts: [[-30, 15], [-10, 15], [10, 15], [30, 15]], kind: "cbore", diameter: { v: 6.6 }, end: "through", depth: { v: 0 }, cbDia: { v: 11 }, cbDepth: { v: 6.4 } } as Feature,
    { id: "h2", type: "hole", name: "H2", plane: top, pts: [[-30, -15], [0, -15]], kind: "csink", diameter: { v: 6.6 }, end: "through", depth: { v: 0 }, csDia: { v: 13.44 }, csAngle: { v: Math.PI / 2 } } as Feature,
    { id: "h3", type: "hole", name: "H3", plane: top, pts: [[30, -15]], kind: "simple", diameter: { v: 5 }, end: "blind", depth: { v: 12 } } as Feature];
  const r = m.evaluate(doc(feats));
  const topo = topology(oc, r.body!.shape, r.body!.names);
  assert.equal(topo.holes?.length, 7, JSON.stringify(topo.holes?.map(h => h.segs.length)));
  // As if read from a STEP file: no hole features to go by.
  const ctx = { topo, holes: [], items: [], box: [[-50, -30, 0], [50, 30, 20]] as [V3, V3], dec: ".", label: (s: string) => s };
  const at = (x: number, y: number, r: number) => topo.edges.find(e => e.t === "c" && Math.abs(e.r! - r) < 1e-6 && Math.abs(e.c![0] - x) < 1e-6 && Math.abs(e.c![1] - y) < 1e-6)!;
  assert.deepEqual(holeText(at(-30, 15, 3.3), ctx), ["4× Ø6.6 THRU", "⌴Ø11 ↧6.4"]);
  assert.deepEqual(holeText(at(-30, 15, 3.3), ctx, false), ["Ø6.6 THRU", "⌴Ø11 ↧6.4"], "without the number of holes");
  assert.deepEqual(holeText(at(10, 15, 5.5), ctx), ["4× Ø6.6 THRU", "⌴Ø11 ↧6.4"], "the counterbore's own circle gives the same callout");
  assert.deepEqual(holeText(at(0, -15, 6.72), ctx), ["2× Ø6.6 THRU", "⌵Ø13.44 × 90°"]);
  assert.deepEqual(holeText(at(30, -15, 2.5), ctx), ["Ø5 ↧12"]);
  // Callouts follow the drawing's default decimals and dual dimensions; angles stay as they are.
  const { useStyle: styleFor } = await import("../../src/drawing/annot");
  try {
    styleFor({ lin: 1, dual: "in", dualPrec: 2 });
    assert.deepEqual(holeText(at(30, -15, 2.5), ctx), ["Ø5.0 [0.20] ↧12.0 [0.47]"]);
    assert.deepEqual(holeText(at(0, -15, 6.72), ctx), ["2× Ø6.6 [0.26] THRU", "⌵Ø13.4 [0.53] × 90°"]);
  } finally { styleFor(undefined); }
  assert.deepEqual(holeText(at(30, -15, 2.5), ctx), ["Ø5 ↧12"]);
  assert.deepEqual(holeText(at(-30, 15, 3.3), ctx, false), ["Ø6.6 THRU", "⌴Ø11 ↧6.4"], "no count in a hole table");
  assert.deepEqual(holeText(at(-30, 15, 3.3), { ...ctx, dec: ",", label: (s: string) => (s === "THRU" ? "СКВОЗН." : s) }), ["4× Ø6,6 СКВОЗН.", "⌴Ø11 ↧6,4"]);
  // Entered from the bottom, a counterbore is a different hole: holes count only with the same way in.
  const flip = geoHole({ ...topo.holes!.find(h => h.segs.length === 2 && h.segs.some(s => Math.abs(s.r0 - 5.5) < 1e-6))!, ax: [0, 0, 1] });
  assert.ok(flip && /⌴Ø11/.test(flip.lines[1]));
});

test("hole callout adds a cosmetic thread; drafting style sets default decimals (FR-DRW-022, FR-DRW-025)", async () => {
  const { geoHole, dimText, useStyle } = await import("../../src/drawing/annot");
  const hole = { o: [30, -15, 20] as V3, ax: [0, 0, -1] as V3, segs: [{ k: "cyl" as const, v0: 0, v1: 12, r0: 2.5, r1: 2.5 }, { k: "cone" as const, v0: 12, v1: 13.5, r0: 2.5, r1: 0 }], open: [true, false] as [boolean, boolean] };
  const th = { id: "t", c: [30, -15, 20] as V3, ax: [0, 0, 1] as V3, r: 2.5, d: 6, L: 10, internal: true, size: "M6" };
  assert.deepEqual(geoHole(hole, undefined, [th])!.lines, ["Ø5 ↧12", "M6-6H ↧10"]);
  assert.deepEqual(geoHole(hole, undefined, [{ ...th, size: undefined, L: null }])!.lines, ["Ø5 ↧12", "M6-6H ↧12"], "full length: the drill depth");
  assert.deepEqual(geoHole(hole, undefined, [{ ...th, c: [0, 0, 20] }])!.lines, ["Ø5 ↧12"], "a thread elsewhere is not this hole's");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [0, 0] as [number, number] };
  const ang = { ...lin, k: "ang" as const };
  try {
    useStyle({ lin: 2, ang: 1 });
    assert.equal(dimText(lin, { k: "h", pts: [], value: 100 }, ".").main, "100.00");
    assert.equal(dimText(ang, { k: "ang", pts: [], value: 30 }, ",").main, "30,0°");
    assert.equal(dimText({ ...lin, prec: 0 }, { k: "h", pts: [], value: 12.34 }, ".").main, "12", "a dimension's own precision wins");
  } finally { useStyle(undefined); }
  assert.equal(dimText(lin, { k: "h", pts: [], value: 100 }, ".").main, "100");
});

test("reference dimensions are in parentheses, basic ones boxed and never toleranced (FR-DRW-021)", async () => {
  const { dimText, dimPrims, useStyle } = await import("../../src/drawing/annot");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [0, 0] as [number, number] };
  const g = { k: "h" as const, pts: [], value: 40 };
  assert.equal(dimText({ ...lin, show: "ref" }, g, ".").main, "(40)");
  assert.equal(dimText({ ...lin, show: "ref", tol: { t: "sym", up: 0.1 } }, g, ".").main, "(40±0.1)");
  assert.deepEqual(dimText({ ...lin, show: "ref", tol: { t: "limit", up: 1, lo: 1 } }, g, "."), { main: "", up: "(41)", lo: "(39)" });
  assert.equal(dimText({ ...lin, show: "ref", txt: "REF" }, g, ".").main, "REF");
  assert.equal(dimText({ ...lin, show: "basic", tol: { t: "sym", up: 0.1 } }, g, ".").main, "40", "a basic dimension has no tolerance of its own");
  try {
    useStyle({ tol: 0.2, dual: "in", dualPrec: 2 });
    assert.equal(dimText({ ...lin, show: "basic" }, g, ".").main, "40 [1.57]", "nor the drawing's default");
    assert.equal(dimText({ ...lin, show: "ref" }, g, ".").main, "(40±0.2 [1.57±0.01])");
  } finally { useStyle(undefined); }
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never;
  const geo = { k: "h" as const, pts: [[0, 0], [40, 0]] as [number, number][], value: 40 };
  const n = (a: object) => dimPrims({ ...lin, pos: [20, 15], ...a } as never, geo as never, pl, ".").prims.filter(q => q.t === "l").length;
  assert.equal(n({ show: "basic" }) - n({}), 4, "four box sides");
});

test("a note can have a border; the leader starts on it (FR-DRW-023)", async () => {
  const { notePrims } = await import("../../src/drawing/annot");
  const note = { id: "n", t: "note" as const, pos: [0, 0] as [number, number], text: "A1" };
  const plain = notePrims(note, [10, 10], [40, 10]);
  const kinds = (b: "box" | "round" | "circle") => notePrims({ ...note, border: b }, [10, 10], [40, 10]);
  const count = (r: { prims: { t: string }[] }, t: string) => r.prims.filter(q => q.t === t).length;
  assert.equal(count(kinds("box"), "l") - count(plain, "l"), 4, "four sides");
  assert.equal(count(kinds("round"), "a") - count(plain, "a"), 2, "two round ends");
  assert.equal(count(kinds("circle"), "a") - count(plain, "a"), 1, "one circle");
  for (const b of ["box", "round", "circle"] as const) {
    const r = kinds(b);
    assert.ok(r.box[0] < plain.box[0] && r.box[2] > plain.box[2], `${b}: the hit box takes the frame in`);
    // The leader is the line ending at the arrow point; it starts on the frame's right side.
    const lead = (r.prims.filter(q => q.t === "l") as { p: number[] }[]).find(q => Math.abs(q.p[2] - 40) < 1e-9 && Math.abs(q.p[3] - 10) < 1e-9)!;
    assert.ok(Math.abs(lead.p[0] - r.box[2]) < 1e-6 || b === "circle", `${b}: leader from the frame edge`);
    if (b === "circle") { const cx = (r.box[0] + r.box[2]) / 2, cy = (r.box[1] + r.box[3]) / 2; assert.ok(Math.abs(Math.hypot(lead.p[0] - cx, lead.p[1] - cy) - (r.box[2] - r.box[0]) / 2) < 1e-6, "leader from the circle"); }
  }
});

test("a note's lines can be centred or set right, and its leader bent or ended in a dot (FR-DRW-023)", async () => {
  const { notePrims, NOTE_SHOULDER, textW } = await import("../../src/drawing/annot");
  const note = { id: "n", t: "note" as const, pos: [0, 0] as [number, number], text: "LONG LINE\nAB" };
  type T = { t: "t"; x: number; al: string };
  const texts = (r: { prims: { t: string }[] }) => r.prims.filter(q => q.t === "t") as unknown as T[];
  const w = textW("LONG LINE", 3.5);
  const left = notePrims(note, [10, 10], null), mid = notePrims({ ...note, al: "c" }, [10, 10], null), right = notePrims({ ...note, al: "r" }, [10, 10], null);
  assert.deepEqual(texts(left).map(q => [q.x, q.al]), [[10, "l"], [10, "l"]]);
  assert.ok(texts(mid).every(q => Math.abs(q.x - (10 + w / 2)) < 1e-9 && q.al === "c"), "centred on the block");
  assert.ok(texts(right).every(q => Math.abs(q.x - (10 + w)) < 1e-9 && q.al === "r"), "set to the block's right side");
  assert.deepEqual(mid.box, left.box, "the block stays where it was");
  // Leader: straight with an arrow by default; bent adds a horizontal shoulder; a dot or nothing replaces the arrow.
  const lines = (r: { prims: { t: string }[] }) => r.prims.filter(q => q.t === "l") as unknown as { p: number[] }[];
  const fills = (r: { prims: { t: string }[] }) => (r.prims.filter(q => q.t === "p") as unknown as { fill?: boolean; p: number[] }[]).filter(q => q.fill);
  const plain = notePrims(note, [10, 10], [60, 40]), bent = notePrims({ ...note, bent: true }, [10, 10], [60, 40]);
  assert.equal(lines(bent).length, lines(plain).length + 1, "one more line: the shoulder");
  const sh = lines(bent)[0], lead = lines(bent)[1];
  assert.ok(Math.abs(sh.p[1] - sh.p[3]) < 1e-9 && Math.abs(sh.p[2] - sh.p[0] - NOTE_SHOULDER) < 1e-9, "shoulder runs level, towards the point");
  assert.deepEqual([lead.p[0], lead.p[1], lead.p[2], lead.p[3]], [sh.p[2], sh.p[3], 60, 40], "the leader goes on from the shoulder to the point");
  const toLeft = lines(notePrims({ ...note, bent: true }, [10, 10], [-30, 40]))[0];
  assert.ok(Math.abs(toLeft.p[2] - toLeft.p[0] + NOTE_SHOULDER) < 1e-9, "a point on the left: the shoulder runs left");
  const dot = notePrims({ ...note, end: "dot" }, [10, 10], [60, 40]), none = notePrims({ ...note, end: "none" }, [10, 10], [60, 40]);
  assert.equal(fills(none).length, 0, "no arrow head");
  assert.equal(fills(dot).length, 1);
  const dp = fills(dot)[0].p; let cx = 0, cy = 0; for (let i = 0; i < dp.length; i += 2) { cx += dp[i]; cy += dp[i + 1]; }
  assert.ok(Math.abs(cx / (dp.length / 2) - 60) < 1e-9 && Math.abs(cy / (dp.length / 2) - 40) < 1e-9 && dp.length === 24, "a dot centred on the point");
  assert.equal(lines(dot).length, lines(plain).length, "the leader line stays");
});

test("a linear dimension's arrows can be put outside or inside by hand (FR-DRW-021)", async () => {
  const { dimPrims } = await import("../../src/drawing/annot");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [20, 15] as [number, number] };
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never;
  const line = (value: number, a: object) => {
    const geo = { k: "h" as const, pts: [[0, 0], [value, 0]] as [number, number][], value };
    const ls = dimPrims({ ...lin, pos: [value / 2, 15], ...a } as never, geo as never, pl, ".").prims.filter(q => q.t === "l" && Math.abs((q as { p: number[] }).p[1] - 15) < 1e-9 && Math.abs((q as { p: number[] }).p[3] - 15) < 1e-9) as { p: number[] }[];
    return Math.max(...ls.map(q => Math.abs(q.p[2] - q.p[0])));
  };
  assert.ok(Math.abs(line(40, {}) - 40) < 1e-9, "room enough: arrows inside, the line spans the extension lines");
  assert.ok(Math.abs(line(40, { arrows: "out" }) - 50) < 1e-9, "outside: the line runs an arrow and 2 mm past each side");
  assert.ok(line(3, {}) > 3 + 1e-9, "no room: arrows outside");
  assert.ok(line(3, { arrows: "in" }) < line(3, {}) - 5, "inside by hand: no arrow tails");
});

test("a dimension can hide extension lines and keep its text horizontal in the line (FR-DRW-021)", async () => {
  const { dimPrims } = await import("../../src/drawing/annot");
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never;
  const mk = (k: "h" | "v", a: object) => {
    const pts = (k === "h" ? [[0, 0], [40, 0]] : [[0, 0], [0, 40]]) as [number, number][];
    const r = dimPrims({ id: "a", t: "dim", view: "v", k, refs: [], pos: k === "h" ? [20, 15] : [15, 20], ...a } as never, { k, pts, value: 40 } as never, pl, ".");
    return { ls: (r.prims.filter(q => q.t === "l") as { p: number[] }[]).map(q => q.p), tx: r.prims.filter(q => q.t === "t") as { x: number; y: number; rot?: number; s: string }[], box: r.box };
  };
  // Extension lines of a horizontal dimension are the vertical lines at x = 0 and x = 40.
  const ext = (a: object) => mk("h", a).ls.filter(p => Math.abs(p[0] - p[2]) < 1e-9).map(p => p[0]).sort((x, y) => x - y);
  assert.deepEqual(ext({}), [0, 40]);
  assert.deepEqual(ext({ noExt: "a" }), [40]);
  assert.deepEqual(ext({ noExt: "b" }), [0]);
  assert.deepEqual(ext({ noExt: "both" }), []);
  // A vertical dimension: the text is turned 90° beside the line; with `horiz` it is level and the line has a gap round it.
  const v0 = mk("v", {}), v1 = mk("v", { horiz: true });
  const dimLs = (r: typeof v0) => r.ls.filter(p => Math.abs(p[0] - 15) < 1e-9 && Math.abs(p[2] - 15) < 1e-9).map(p => [Math.min(p[1], p[3]), Math.max(p[1], p[3])]).sort((a, b) => a[0] - b[0]);
  assert.equal(v0.tx[0].rot, 90);
  assert.deepEqual(dimLs(v0), [[0, 40]]);
  assert.equal(v1.tx[0].rot, undefined);
  const g = dimLs(v1);
  assert.equal(g.length, 2);
  assert.ok(Math.abs(g[0][0]) < 1e-9 && Math.abs(g[1][1] - 40) < 1e-9 && g[0][1] < 20 && g[1][0] > 20 && Math.abs(g[0][1] + g[1][0] - 40) < 1e-9, "the gap is centred on the text");
  assert.ok(v1.box[1] >= g[0][1] - 1e-9 && v1.box[3] <= g[1][0] + 1e-9 && v1.box[0] < 15 && v1.box[2] > 15, "the text box sits in the gap, across the line");
  // A horizontal one too: the line stops either side of the text.
  const h1 = mk("h", { horiz: true }).ls.filter(p => Math.abs(p[1] - 15) < 1e-9 && Math.abs(p[3] - 15) < 1e-9);
  assert.equal(h1.length, 2);
});

test("a dimension can carry a second line of text under its line (FR-DRW-021)", async () => {
  const { dimPrims, dimGeo, wholeCircle, edgeOnSeg, outlineSeg } = await import("../../src/drawing/annot");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [20, 15] as [number, number] };
  const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never;
  const geo = { k: "h" as const, pts: [[0, 0], [40, 0]] as [number, number][], value: 40 };
  {
    // Foreshortened radius: the line from the rim stops short of the centre with a jog; the arrow stays on the rim.
    const rad = { id: "r", t: "dim", view: "v", k: "rad", refs: [], pos: [30, 40] } as never, rg = { k: "rad", pts: [], c: [0, 0], r: 100, value: 100 } as never;
    const full = dimPrims(rad, rg, pl, "."), short = dimPrims({ ...(rad as object), fore: true } as never, rg, pl, ".");
    assert.ok(full.prims.some(q => q.t === "l" && Math.hypot((q as { p: number[] }).p[0], (q as { p: number[] }).p[1]) < 1e-9), "the plain radius starts at the centre");
    const zig = short.prims.find(q => q.t === "p" && (q as { p: number[] }).p.length === 8) as { p: number[] };
    assert.ok(zig && Math.abs(Math.hypot(zig.p[6], zig.p[7]) - 100) < 1e-9, "the jogged line ends on the rim");
    assert.ok(Math.hypot(zig.p[0], zig.p[1]) > 70 && Math.hypot(zig.p[0], zig.p[1]) < 80, "and starts about 24 mm inside it");
    assert.ok(!short.prims.some(q => q.t === "l" && Math.hypot((q as { p: number[] }).p[0], (q as { p: number[] }).p[1]) < 1e-9));
    assert.equal(short.prims.filter(q => q.t === "t").length, full.prims.filter(q => q.t === "t").length);
  }
  {
    // Arrow outside: with the text outside the circle the leader stops at the rim (one arrow, nothing crosses the circle).
    const dia = { id: "d", t: "dim", view: "v", k: "dia", refs: [], pos: [30, 0] } as never, dg = { k: "dia", pts: [], c: [0, 0], r: 10, value: 20 } as never;
    const through = dimPrims(dia, dg, pl, "."), lead = dimPrims({ ...(dia as object), outside: true } as never, dg, pl, ".");
    const xs = (o: { prims: { t: string }[] }) => o.prims.filter(q => q.t === "l").flatMap(q => [(q as never as { p: number[] }).p[0], (q as never as { p: number[] }).p[2]]);
    assert.ok(Math.min(...xs(through)) < -9.99, "the plain diameter crosses the circle");
    assert.ok(Math.min(...xs(lead)) > 9.99, "the leader stays outside it");
    assert.equal(lead.prims.length, through.prims.length - 1, "one arrow instead of two");
    // Text inside the circle: nothing to lead from, so the option changes nothing.
    const inn = { id: "d", t: "dim", view: "v", k: "dia", refs: [], pos: [3, 0] } as never;
    assert.deepEqual(dimPrims({ ...(inn as object), outside: true } as never, dg, pl, ".").prims, dimPrims(inn, dg, pl, ".").prims);
  }
  {
    // Extension lines leave a measured edge at its end nearest the dimension line, not at the point the distance was taken from.
    const segs = [[[-50, -30], [-50, -10]], [[50, 10], [50, 30]]];
    const dg = (s?: unknown) => ({ k: "al", pts: [[-50, -20], [50, -20]], value: 100, segs: s }) as never;
    const dim = (pos: number[]) => ({ id: "d", t: "dim", view: "v", k: "al", refs: [], pos }) as never;
    const vert = (o: { prims: { t: string }[] }) => o.prims.filter(q => q.t === "l").map(q => (q as never as { p: number[] }).p).filter(p => Math.abs(p[0] - p[2]) < 1e-9).map(p => [p[0], Math.min(p[1], p[3]), Math.max(p[1], p[3])]);
    const plain = vert(dimPrims(dim([0, 40]), dg(), pl, ".")), slid = vert(dimPrims(dim([0, 40]), dg(segs), pl, "."));
    assert.deepEqual(plain.map(v => v[1]), [-19, -19], "without the edges both start at the measured points");
    assert.deepEqual(slid.map(v => [v[0], v[1]]), [[-50, -9], [50, 31]], "with them: 1 mm past each edge's upper end");
    assert.ok(slid.every(v => Math.abs(v[2] - 42) < 1e-9), "and 2 mm past the dimension line");
    // Below the part the lower ends are used; a dimension line crossing an edge needs no extension line there.
    assert.deepEqual(vert(dimPrims(dim([0, -40]), dg(segs), pl, ".")).map(v => v[2]), [-31, 9]);
    assert.equal(vert(dimPrims(dim([0, 20]), dg(segs), pl, ".")).length, 1);
    assert.equal(dimPrims(dim([0, 40]), dg(segs), pl, ".").prims.length, dimPrims(dim([0, 40]), dg(), pl, ".").prims.length);
    // dimGeo hands the edges over for two parallel lines.
    const E = (k: string, a: number[], b: number[]) => ({ k, t: "l", a, b, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0] });
    const topo = { edges: [E("a|b", [-50, -30, 0], [-50, -10, 0]), E("c|d", [50, 10, 0], [50, 30, 0])], cyls: [] } as never;
    const g = dimGeo({ id: "d", t: "dim", view: "v", k: "al", refs: [{ e: "a|b", h: [-50, -20, 0], p: "e" }, { e: "c|d", h: [50, 20, 0], p: "e" }], pos: [0, 40] } as never, (p: number[]) => [p[0], p[1]], topo)!;
    assert.equal(g.value, 100);
    assert.equal(g.segs!.length, 2);
    assert.deepEqual(g.segs![1], [[50, 10], [50, 30]]);
  }
  {
    // A circle seen side-on (its axis in the view plane) is a line: its diameter is a linear dimension along that line, Ø kept.
    const circ = { k: "s|t", t: "c", a: [10, 0, 0], b: [10, 0, 0], m: [-10, 0, 0], c: [0, 0, 5], ax: [0, 0, 1], r: 10, sp: 2 * Math.PI };
    const topo = { edges: [circ], cyls: [] } as never, ref = { e: "s|t", h: [-10, 0, 0], p: "e" };
    const front = (p: number[]) => [p[0], p[2]], top = (p: number[]) => [p[0], p[1]];
    const side = dimGeo({ id: "d", t: "dim", view: "v", k: "dia", refs: [ref], pos: [0, 20] } as never, front, topo)!;
    assert.ok(side.dl && Math.abs(Math.abs(side.dl[0]) - 1) < 1e-9 && Math.abs(side.dl[1]) < 1e-9, "the line runs along X");
    assert.equal(dimGeo({ id: "d", t: "dim", view: "v", k: "dia", refs: [ref], pos: [0, 20] } as never, top, topo)!.dl, undefined, "end-on: an ordinary diameter");
    const o = dimPrims({ id: "d", t: "dim", view: "v", k: "dia", refs: [ref], pos: [0, 20] } as never, side, pl, ".");
    const ls = o.prims.filter(q => q.t === "l").map(q => (q as never as { p: number[] }).p);
    assert.ok(ls.some(p => Math.abs(p[0] + 10) < 1e-9 && Math.abs(p[2] + 10) < 1e-9) && ls.some(p => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[2] - 10) < 1e-9), "extension lines at both ends of the line");
    assert.ok(ls.some(p => Math.abs(p[1] - 20) < 1e-9 && Math.abs(p[3] - 20) < 1e-9 && Math.abs(Math.abs(p[2] - p[0]) - 20) < 1e-9), "a level dimension line 20 long");
    assert.ok(o.prims.some(q => q.t === "t" && (q as never as { s: string }).s === "Ø20"));
  }
  {
    // A stepped shaft seen from the front (axis along X): Ø20 from x = −80 to 0, Ø24 from 0 to 80, end circles at x = ±80.
    // Two outline lines (`s`) give their distance (exam #14: 2, not the end circles' centres 160 apart); an end circle seen
    // edge-on is a line across the axis (exam #3/#10: the overall length).
    const C = (k: string, x: number, r: number) => ({ k, t: "c", a: [x, r, 0], b: [x, r, 0], m: [x, -r, 0], c: [x, 0, 0], ax: [1, 0, 0], r, sp: 2 * Math.PI });
    const e1 = C("a|e1", -80, 10), e2 = C("b|e2", 80, 12);
    const topo = { edges: [e1, e2], cyls: [{ o: [0, 0, 0], ax: [1, 0, 0], r: 10, v0: -80, v1: 0, sp: 2 * Math.PI }, { o: [0, 0, 0], ax: [1, 0, 0], r: 12, v0: 0, v1: 80, sp: 2 * Math.PI }] } as never;
    const front = (p: number[]) => [p[0], p[1]];
    const R = (e: { k: string; m: number[] }, s?: 1 | -1) => ({ e: e.k, h: e.m, p: "e", ...(s ? { s } : {}) });
    const lower = dimGeo({ id: "d", t: "dim", view: "v", k: "al", refs: [R(e1, 1), R(e2, 1)], pos: [0, -30] } as never, front, topo)!;
    assert.ok(Math.abs(lower.value - 2) < 1e-9, `outline to outline: ${lower.value}`);
    assert.deepEqual(lower.segs![0], [[-80, 10], [0, 10]]);
    const across = dimGeo({ id: "d", t: "dim", view: "v", k: "al", refs: [R(e1, 1), R(e1, -1)], pos: [-40, 0] } as never, front, topo)!;
    assert.ok(Math.abs(across.value - 20) < 1e-9, "both outlines of one cylinder: its diameter");
    const len = dimGeo({ id: "d", t: "dim", view: "v", k: "h", refs: [R(e1), R(e2)], pos: [0, 30] } as never, front, topo)!;
    assert.equal(len.value, 160, "edge-on end circles: the overall length");
    assert.deepEqual(edgeOnSeg(e2 as never, front, topo), [[80, -12], [80, 12]]);
    assert.equal(edgeOnSeg(e2 as never, (p: number[]) => [p[1], p[2]], topo), null, "end-on: no line");
    assert.deepEqual(outlineSeg([0, 0], [1, 0], 5, -1, 2, -1), [[-1, -5], [2, -5]]);
  }
  {
    // A hole is dimensioned by its diameter: a whole circle, also when the file gives it as two half circles; other arcs by radius.
    const C = (k: string, c: number[], r: number, sp: number) => ({ k, t: "c", a: [0, 0, 0], b: [0, 0, 0], m: [0, 0, 0], c, r, sp });
    const whole = C("w", [0, 0, 0], 5, 2 * Math.PI), h1 = C("h1", [20, 0, 0], 3, Math.PI), h2 = C("h2", [20, 0, 0], 3, Math.PI), fil = C("f", [40, 0, 0], 3, Math.PI / 2), half = C("s", [60, 0, 0], 3, Math.PI);
    const topo = { edges: [whole, h1, h2, fil, half, C("o", [60, 0, 0], 4, Math.PI)], cyls: [] } as never;
    assert.equal(wholeCircle(whole as never, topo), true);
    assert.equal(wholeCircle(h1 as never, topo), true, "two halves on one centre and radius");
    assert.equal(wholeCircle(fil as never, topo), false, "a fillet arc");
    assert.equal(wholeCircle(half as never, topo), false, "a lone half circle (the other arc there has another radius)");
    assert.equal(wholeCircle(h1 as never, null), false);
  }
  {
    // Text along the leader: turned to the leader's angle, no level shoulder; the leader runs on under the text.
    const dia = { id: "d", t: "dim", view: "v", k: "dia", refs: [], pos: [20, 20] } as never, dg = { k: "dia", pts: [], c: [0, 0], r: 10, value: 20 } as never;
    const flat = dimPrims(dia, dg, pl, "."), al = dimPrims({ ...(dia as object), along: true } as never, dg, pl, ".");
    const tx = (o: { prims: { t: string }[] }) => o.prims.find(q => q.t === "t") as never as { rot?: number; x: number; y: number };
    assert.ok(!tx(flat).rot && Math.abs(tx(al).rot! - 45) < 1e-9, "text at the leader's 45°");
    const level = (o: { prims: { t: string }[] }) => o.prims.filter(q => q.t === "l").map(q => (q as never as { p: number[] }).p).filter(p => Math.abs(p[1] - p[3]) < 1e-9).length;
    assert.equal(level(flat), 1, "the plain one has a level shoulder");
    assert.equal(level(al), 0, "the aligned one has none");
    assert.equal(al.prims.length, flat.prims.length);
    // On the left the text still reads from the bottom (rot within -90..90).
    const left = tx(dimPrims({ ...(dia as object), pos: [-20, 20], along: true } as never, dg, pl, "."));
    assert.ok(Math.abs(left.rot! + 45) < 1e-9);
  }
  {
    // Angle arrows: a wide sector keeps them inside; a narrow one gets them outside on tails of the arc; the choice can be forced.
    const lines = [[[0, 0], [40, 0]], [[0, 0], [0, 40]]];
    const ang = (pos: number[], more: object = {}) => dimPrims({ id: "d", t: "dim", view: "v", k: "ang", refs: [], pos, ...more } as never, { k: "ang", pts: [], lines, value: 0 } as never, pl, ".");
    const arc = (o: { prims: { t: string }[] }) => o.prims.find(q => q.t === "a") as never as { a0: number; a1: number; r: number };
    const wide = arc(ang([14, 14])), narrow = arc(ang([2.2, 2.2]));
    assert.ok(Math.abs(wide.a1 - wide.a0 - Math.PI / 2) < 1e-9, "wide: the arc spans just the angle");
    assert.ok(Math.abs(narrow.a1 - narrow.a0 - Math.PI / 2 - 2 * 5 / narrow.r) < 1e-9, "narrow: a tail of arrow + 2 at each end");
    assert.ok(Math.abs(arc(ang([2.2, 2.2], { arrows: "in" })).a1 - arc(ang([2.2, 2.2], { arrows: "in" })).a0 - Math.PI / 2) < 1e-9, "forced inside");
    assert.ok(arc(ang([14, 14], { arrows: "out" })).a1 - arc(ang([14, 14], { arrows: "out" })).a0 > Math.PI / 2 + 0.1, "forced outside");
    assert.equal(ang([2.2, 2.2]).prims.length, ang([2.2, 2.2], { arrows: "in" }).prims.length, "same pieces either way");
    // Extension lines appear when the arc is past the lines' ends, and can be hidden one by one.
    const far = ang([50, 50]), nl = (o: { prims: { t: string }[] }) => o.prims.filter(q => q.t === "l").length;
    assert.equal(nl(far) - nl(ang([50, 50], { noExt: "a" })), 1);
    assert.equal(nl(far) - nl(ang([50, 50], { noExt: "both" })), 2);
  }
  {
    // A diameter displayed as a linear dimension: extension lines from the rim's left and right ends, arrows on a level line, Ø kept.
    const dia = { id: "d", t: "dim", view: "v", k: "dia", refs: [], pos: [3, 30], lin: "h" } as never, dg = { k: "dia", pts: [], c: [0, 0], r: 10, value: 20 } as never;
    const o = dimPrims(dia, dg, pl, ".");
    const ls = o.prims.filter(q => q.t === "l").map(q => (q as { p: number[] }).p);
    assert.ok(ls.some(p => Math.abs(p[0] + 10) < 1e-9 && Math.abs(p[2] + 10) < 1e-9 && p[3] > 30), "extension line at x = -10");
    assert.ok(ls.some(p => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[2] - 10) < 1e-9 && p[3] > 30), "extension line at x = 10");
    assert.ok(ls.some(p => Math.abs(p[1] - 30) < 1e-9 && Math.abs(p[3] - 30) < 1e-9 && Math.abs(Math.abs(p[2] - p[0]) - 20) < 1e-9), "dimension line 20 long at y = 30");
    assert.ok(o.prims.some(q => q.t === "t" && (q as { s: string }).s === "Ø20"));
    const v = dimPrims({ ...(dia as object), lin: "v", pos: [30, 3] } as never, dg, pl, ".").prims.filter(q => q.t === "l").map(q => (q as { p: number[] }).p);
    assert.ok(v.some(p => Math.abs(p[0] - 30) < 1e-9 && Math.abs(p[2] - 30) < 1e-9 && Math.abs(Math.abs(p[3] - p[1]) - 20) < 1e-9), "vertical dimension line at x = 30");
  }
  {
    // The drawing's extension line gap and overshoot: with gap 0 and 3 past, the Ø20's lines start on the rim (y = 0) and end 3 above the dimension line.
    const { useStyle } = await import("../../src/drawing/annot");
    const dia = { id: "d", t: "dim", view: "v", k: "dia", refs: [], pos: [3, 30], lin: "h" } as never, dg = { k: "dia", pts: [], c: [0, 0], r: 10, value: 20 } as never;
    const ext = () => dimPrims(dia, dg, pl, ".").prims.filter(q => q.t === "l").map(q => (q as { p: number[] }).p).filter(p => Math.abs(p[0] - p[2]) < 1e-9 && Math.abs(Math.abs(p[0]) - 10) < 1e-9);
    const std = ext();
    assert.ok(std.length === 2 && std.every(p => Math.abs(Math.min(p[1], p[3]) - 1) < 1e-9 && Math.abs(Math.max(p[1], p[3]) - 32) < 1e-9), JSON.stringify(std));
    try {
      useStyle({ extGap: 0, extOver: 3 });
      const own = ext();
      assert.ok(own.length === 2 && own.every(p => Math.abs(Math.min(p[1], p[3])) < 1e-9 && Math.abs(Math.max(p[1], p[3]) - 33) < 1e-9), JSON.stringify(own));
    } finally { useStyle(undefined); }
  }
  {
    // Arrowheads of its own: oblique strokes are two thick lines in place of the two filled heads, and the next dimension is back to the style's.
    const base = dimPrims(lin as never, geo as never, pl, ".").prims, tick = dimPrims({ ...lin, ends: "tick" } as never, geo as never, pl, ".").prims;
    const thick = (ps: typeof base) => ps.filter(q => q.t === "l" && (q as { pen?: string }).pen === "thick").length;
    const filled = (ps: typeof base) => ps.filter(q => q.t === "p" && (q as { fill?: boolean }).fill).length;
    assert.equal(thick(tick), thick(base) + 2);
    assert.equal(filled(tick), filled(base) - 2);
    assert.deepEqual(dimPrims(lin as never, geo as never, pl, ".").prims, base);
  }
  const plain = dimPrims(lin as never, geo as never, pl, ".");
  const r = dimPrims({ ...lin, below: "2 PLACES" } as never, geo as never, pl, ".");
  const ts = r.prims.filter(q => q.t === "t") as { s: string; x: number; y: number; h: number }[];
  const main = ts.find(q => q.s === "40")!, low = ts.find(q => q.s === "2 PLACES")!;
  assert.ok(main && low, "both lines are written");
  assert.ok(main.y > 15 && low.y + low.h < 15, "the value above the dimension line, the second line under it");
  assert.ok(r.box[1] < plain.box[1] - low.h * 0.9 && r.box[0] <= plain.box[0] && r.box[2] >= plain.box[2], "the hit box covers both lines");
  assert.equal(plain.prims.filter(q => q.t === "t").length, 1);
});

test("dual dimensions add inches in brackets; a dimension can opt in or out (FR-DRW-021)", async () => {
  const { dimText, useStyle } = await import("../../src/drawing/annot");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [0, 0] as [number, number] };
  const g = { k: "h" as const, pts: [], value: 25.4 };
  assert.equal(dimText({ ...lin, dual: true }, g, ".").main, "25.4 [1.000]", "one dimension, three decimals by default");
  try {
    useStyle({ dual: "in", dualPrec: 2 });
    assert.equal(dimText(lin, g, ",").main, "25,4 [1,00]");
    assert.equal(dimText({ ...lin, dual: false }, g, ".").main, "25.4", "turned off for one dimension");
    assert.equal(dimText({ ...lin, k: "dia" as const, suf: " H7" }, { k: "dia", pts: [], value: 50.8 }, ".").main, "Ø50.8 H7 [2.00]");
    assert.equal(dimText({ ...lin, tol: { t: "sym", up: 0.254 } }, g, ".").main, "25.4±0.25 [1.00±0.01]");
    assert.deepEqual(dimText({ ...lin, tol: { t: "limit", up: 25.4, lo: 0 } }, g, "."), { main: "", up: "50.8 [2.00]", lo: "25.4 [1.00]" });
    assert.deepEqual(dimText({ ...lin, tol: { t: "dev", up: 0.2, lo: 0 } }, g, "."), { main: "25.4 [1.00]", up: "+0.2", lo: "0" });
    assert.equal(dimText({ ...lin, k: "ang" as const }, { k: "ang", pts: [], value: 30 }, ".").main, "30°", "angles have no inch value");
    assert.equal(dimText({ ...lin, txt: "REF" }, g, ".").main, "REF", "typed text stays as typed");
  } finally { useStyle(undefined); }
  assert.equal(dimText(lin, g, ".").main, "25.4");
});

test("drafting style sets a default ± tolerance; a dimension's own tolerance or None wins (FR-DRW-025)", async () => {
  const { dimText, useStyle } = await import("../../src/drawing/annot");
  const lin = { id: "a", t: "dim" as const, view: "v", k: "h" as const, refs: [], pos: [0, 0] as [number, number] };
  const ang = { ...lin, k: "ang" as const };
  try {
    useStyle({ tol: 0.1, atol: 0.5 });
    assert.equal(dimText(lin, { k: "h", pts: [], value: 100 }, ".").main, "100±0.1");
    assert.equal(dimText(ang, { k: "ang", pts: [], value: 30 }, ",").main, "30±0,5°");
    assert.equal(dimText({ ...lin, tol: { t: "none" } }, { k: "h", pts: [], value: 100 }, ".").main, "100", "None turns the default off");
    assert.deepEqual(dimText({ ...lin, tol: { t: "dev", up: 0.2, lo: 0 } }, { k: "h", pts: [], value: 100 }, "."), { main: "100", up: "+0.2", lo: "0" });
    useStyle({ tol: 0.1 });
    assert.equal(dimText(ang, { k: "ang", pts: [], value: 30 }, ".").main, "30°", "no angle default: angles stay plain");
  } finally { useStyle(undefined); }
  assert.equal(dimText(lin, { k: "h", pts: [], value: 100 }, ".").main, "100");
});

test("model items stack by size, clear of each other, in sheet millimetres (FR-DRW-020)", async () => {
  const { placeItems } = await import("../../src/drawing/annot");
  const lin = (src: string, len: number) => ({ src, name: src, k: "lin" as const, p: [[-len / 2, 30, 0], [len / 2, 30, 0]] as [V3, V3], dir: [1, 0, 0] as V3, n: [0, 0, 1] as V3, value: len });
  const dia = (src: string) => ({ src, name: src, k: "dia" as const, p: [[0, 0, 0], [5, 0, 0]] as [V3, V3], n: [0, 0, 1] as V3, value: 10 });
  const sheet = { id: "s", name: "S", size: "A3" as const, scale: [1, 1] as [number, number], projection: "first" as const, format: "iso" as const, views: [{ id: "top", name: "top", orient: "top", x: 0, y: 0 }] as never[], annots: [] as never[] };
  const box = (): [number, number, number, number] => [-50, -30, 50, 30];
  let n = 0;
  const id = () => `a${n++}`;
  const items = [lin("a:100", 100), lin("a:20", 20), lin("a:40", 40), dia("a:d1"), dia("a:d2")] as never[];
  const off = (ds: { src?: string; pos: [number, number] }[], src: string) => Math.abs(ds.find(d => d.src === src)!.pos[1]) - 30;
  const placed = placeItems(sheet, items, box, id);
  assert.deepEqual(placed.filter(d => d.k === "h").map(d => Math.sign(d.pos[1])).filter((v, i, a) => a.indexOf(v) === i).length, 1, "all on one side");
  assert.deepEqual(["a:20", "a:40", "a:100"].map(s => off(placed, s)), [10, 18, 26], "shorter dimensions nearer the view");
  const [d1, d2] = placed.filter(d => d.k === "dia");
  assert.ok(Math.hypot(d1.pos[0] - d2.pos[0], d1.pos[1] - d2.pos[1]) >= 7 - 1e-6, "two diameters on one centre do not share a place");
  // At 1:2 the gaps are the same on the sheet, so twice as large in model millimetres.
  const half = placeItems(sheet, items, box, id, () => 0.5);
  assert.deepEqual(["a:20", "a:40", "a:100"].map(s => off(half, s)), [20, 36, 52]);
  // A later import starts beyond the dimensions already on that side.
  const more = placeItems({ ...sheet, annots: placed as never[] }, [...items, lin("a:10", 10)] as never[], box, id);
  assert.equal(more.length, 1);
  assert.equal(off(more, "a:10"), 34);
});

test("offset section: the cutter's steps are no lines in the view (drawings exam #12)", async () => {
  const { dropSteps } = await import("../../src/kernel/drawing");
  // Frame: e = +X, view x = +X, y = +Z; one step at t = 25 (x = 25 - 40 = -15), the outer walls at ±FAR stay.
  const st = { o: [-40, -20, 0] as [number, number, number], e: [1, 0, 0] as [number, number, number], pts: [-1e9, 1e9, -1e9, 0, 25, 0, 25, 20, 1e9, 20, 1e9, 1e9] };
  const l = (p: [number, number, number, number]) => ({ k: "l" as const, c: 0 as const, p });
  const proj = { vis: [l([-15, 0, -15, 35]), l([-40, 0, 40, 0]), l([-20, 15, -20, 33]), l([-15, 15, -10, 15])], hid: [l([-15, 2, -15, 8])] };
  // Cut faces: the plate cut on both sides of the step (z 0…15), and only right of it above (the boss beyond on the left).
  const cut = [[-40, 0, -15, 0, -15, 15, -40, 15], [-15, 0, 40, 0, 40, 15, -10, 15, -10, 35, -15, 35]];
  dropSteps(proj, st, [1, 0, 0], [0, 0, 1], cut);
  const ps = proj.vis.map(g => (g as { p: number[] }).p.map(v => Math.round(v * 100) / 100));
  assert.deepEqual(ps.slice(1), [[-40, 0, 40, 0], [-20, 15, -20, 33], [-15, 15, -10, 15]], "lines with only one end on the step stay");
  assert.ok(ps[0][0] === -15 && ps[0][2] === -15 && Math.abs(ps[0][1] - 15) < 0.3 && ps[0][3] === 35, `the step stays only where it borders the uncut boss (${ps[0]})`);
  assert.equal(proj.hid.length, 0, "between two cut faces it goes");
});

test("half section: hatched even when the stored line is a hair off the rounded path (drawings exam #13)", async () => {
  const { section } = await import("../../src/kernel/drawing");
  const { viewReq } = await import("../../src/drawing/views");
  const { oc, shape } = await block();
  const parent = { id: "t", name: "Top", orient: "top", x: 100, y: 200 };
  for (const look of [1, -1]) {
    // The first point snapped to the block's edge: the line keeps 1.6e-5 of drift, the path is rounded.
    const v = { id: "s", name: "A", kind: "section", parent: "t", line: [20.0000162, -30.000004, 20, 0], path: [20, -30, 20, 0, 50, 0], look, x: 100, y: 80 };
    const sheet = { id: "sh", name: "S", size: "A3", scale: [1, 1], projection: "first", views: [parent, v], annots: [] } as never;
    const req = viewReq(sheet, v as never);
    const s = section(oc, shape, req.view, req.p!, 0.02, undefined, { stair: req.stair });
    assert.ok(s.cut!.length >= 1, `look ${look}: ${s.cut!.length} cut faces`);
  }
});
