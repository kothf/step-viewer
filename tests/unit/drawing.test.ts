// Drawing views (FRS 11.2): HLR projection of a modelled block with a through hole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { project, bounds } from "../../src/kernel/drawing";
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
