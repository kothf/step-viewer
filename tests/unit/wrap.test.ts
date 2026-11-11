/** Wrap (FR-FT-104). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, cx: number, cy: number, w: number, h: number, plane: SketchFeature["plane"]): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", cx - w / 2, cy - h / 2), P("2", cx + w / 2, cy - h / 2), P("3", cx + w / 2, cy + h / 2), P("4", cx - w / 2, cy + h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const circle = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

test("wrap: emboss and deboss a rectangle and a circle onto a shaft (FR-FT-104)", async () => {
  const m = new Modeller(await occ());
  const R = 10, H = 30;
  const s1 = circle("s1", 0, 0, R, { std: "XY" });
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: H } };
  const cyl = Math.PI * R * R * H;
  let r = run(m, doc([s1, ex]));
  const side = r.body!.names.find(n => n.startsWith("f1:side"))!;
  assert.ok(side, r.body!.names.join());
  const s2 = rect("s2", 0, 15, 12, 8, { std: "XZ" });
  const wrap: Feature = { id: "f2", type: "wrap", name: "Wrap1", sketch: "s2", face: { name: side }, kind: "emboss", depth: { v: 2 } };
  // Sector of a ring: height · angle · ((R + d)² − R²) / 2, angle = width / R.
  r = run(m, doc([s1, ex, s2, wrap]));
  close(r.props!.volume, cyl + 8 * (12 / R) * ((R + 2) ** 2 - R * R) / 2, 1e-5);
  assert.equal(r.props!.bodies, 1);
  assert.ok(r.body!.names.includes("f2:top:0"), r.body!.names.join());
  r = run(m, doc([s1, ex, s2, { ...wrap, kind: "deboss" }]));
  close(r.props!.volume, cyl - 8 * (12 / R) * (R * R - (R - 2) ** 2) / 2, 1e-5);
  assert.ok(r.body!.names.includes("f2:top:0"), r.body!.names.join());
  // Shallow: the solid's centroid sits inside the radius (the sector is wide), yet it still goes the right way.
  r = run(m, doc([s1, ex, s2, { ...wrap, depth: { v: 1 } }]));
  close(r.props!.volume, cyl + 8 * (12 / R) * ((R + 1) ** 2 - R * R) / 2, 1e-5);
  r = run(m, doc([s1, ex, s2, { ...wrap, kind: "deboss", depth: { v: 1 } }]));
  close(r.props!.volume, cyl - 8 * (12 / R) * (R * R - (R - 1) ** 2) / 2, 1e-5);
  // A circle on an offset plane keeps its area on the surface: volume ≈ area · mean radius ratio.
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XZ" }, offset: { v: 25 } };
  const s3 = circle("s3", 0, 15, 4, { plane: "p1" });
  r = run(m, doc([s1, ex, pl, s3, { ...wrap, sketch: "s3" }]));
  close(r.props!.volume, cyl + Math.PI * 16 * ((R + 2) ** 2 - R * R) / (2 * R), 1e-4);
});

test("wrap: on a hole, emboss grows into the hole and deboss cuts outwards (FR-FT-104)", async () => {
  const m = new Modeller(await occ());
  const s1: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [],
    ents: [{ id: "c", t: "point", x: 0, y: 0 }, { id: "k1", t: "circle", c: "c", r: 10 }, { id: "k2", t: "circle", c: "c", r: 6 }] };
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 30 } };
  const tube = Math.PI * (100 - 36) * 30;
  const s2 = rect("s2", 0, 15, 6, 8, { std: "XZ" });
  const wrap: Feature = { id: "f2", type: "wrap", name: "Wrap1", sketch: "s2", face: { name: "f1:side:k2" }, kind: "emboss", depth: { v: 1 } };
  const nd = (fs: Feature[]): PartDoc => ({ ...doc(fs), naming: 2 });
  let r = run(m, nd([s1, ex, s2, wrap]));
  close(r.props!.volume, tube + 8 * (6 / 6) * (36 - 25) / 2, 1e-5);
  r = run(m, nd([s1, ex, s2, { ...wrap, kind: "deboss" }]));
  close(r.props!.volume, tube - 8 * (6 / 6) * (49 - 36) / 2, 1e-5);
});

test("wrap: refuses a flat face and a sketch plane across the axis (FR-FT-104)", async () => {
  const m = new Modeller(await occ());
  const s1 = circle("s1", 0, 0, 10, { std: "XY" });
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 30 } };
  const s2 = rect("s2", 0, 0, 4, 4, { std: "XY" });
  let r = m.evaluate(doc([s1, ex, s2, { id: "f2", type: "wrap", name: "Wrap1", sketch: "s2", face: { name: "f1:end" }, kind: "emboss", depth: { v: 1 } }]));
  assert.equal(r.statuses.find(s => s.id === "f2")!.code, "E-WRAP-CYL");
  const side = r.body!.names.find(n => n.startsWith("f1:side"))!;
  r = m.evaluate(doc([s1, ex, s2, { id: "f2", type: "wrap", name: "Wrap1", sketch: "s2", face: { name: side }, kind: "emboss", depth: { v: 1 } }]));
  assert.equal(r.statuses.find(s => s.id === "f2")!.code, "E-WRAP-PLANE");
});
