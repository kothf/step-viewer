// Drawing views (FRS 11.2): HLR projection of a modelled block with a through hole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { project, bounds, geometryDiff, type V3 } from "../../src/kernel/drawing";
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
  return { oc: await occ(), shape: r.body!.shape };
}

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
  // Surface finish: the removal bar and the roughness under the long leg's line, decimal comma.
  const s = surfPrims({ id: "s", t: "surf", pos: [0, 0], proc: "removal", text: "Ra 3.2" }, [0, 0], ",");
  assert.equal(s.prims.filter(p => p.t === "l").length, 4);
  assert.ok(s.prims.some(p => p.t === "t" && p.s === "Ra 3,2"));
  // A revision table anchored at its top-right corner grows to the left; headers are translated.
  const tb = tablePrims({ id: "t", t: "table", kind: "rev", anchor: "tr", pos: [400, 287], title: "REVISIONS", cols: ["Rev.", "Column 2"], rows: [["A", "x"]] }, (k, p) => (k === "Column {n}" ? `C${p!.n}` : k.toLowerCase()));
  assert.equal(tb.box[2], 400);
  assert.equal(tb.box[1], 287 - 18);
  assert.ok(tb.prims.some(p => p.t === "t" && p.s === "C2") && tb.prims.some(p => p.t === "t" && p.s === "revisions" && p.bold));
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
