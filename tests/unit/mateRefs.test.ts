// Mate references on edges, vertices, cones, spheres and a component's origin (FR-MATE-001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, mateTypes, mateDefaults, type Geo } from "../../src/asm/solver";
import { partRefs, edgeRef, vertexRef, refKind, originOf, originGeo } from "../../src/asm/refGeo";
import { IDENTITY, applyPoint, applyDir, translation, rotation, compose } from "../../src/asm/math";
import type { AsmDoc, Mate } from "../../src/asm/types";
import type { PartDoc } from "../../src/model/types";
import type { PartData } from "../../src/topology";

const stub = { schema: 1, kind: "part", id: "x", name: "x", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [] } as unknown as PartDoc;
const geos: Record<string, Record<string, Geo>> = {
  // A 20 mm cube's corner at the origin, its top face, a straight top edge and a round edge of radius 4 on top.
  block: {
    top: { k: "plane", p: [10, 10, 20], n: [0, 0, 1] },
    "@v:corner": { k: "point", p: [20, 20, 20], r: 0 },
    "@e:edge": { k: "axis", p: [10, 0, 20], d: [1, 0, 0], r: 0 },
    "@e:ring": { k: "axis", p: [10, 10, 20], d: [0, 0, 1], r: 4, c: true },
    ...Object.fromEntries((["XY", "YZ", "ZX", "X", "Y", "Z", "O"] as const).map(k => [`@o:${k}`, originGeo(k)])),
  },
  ball: { sphere: { k: "point", p: [0, 0, 0], r: 5 }, ...Object.fromEntries((["XY", "Z", "O"] as const).map(k => [`@o:${k}`, originGeo(k)])) },
  pin: { cone: { k: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 2 }, "@e:rim": { k: "axis", p: [0, 0, 0], d: [0, 0, -1], r: 3, c: true }, "@o:O": originGeo("O"), "@o:XY": originGeo("XY") },
};
const geo = (part: string, face: string) => geos[part]?.[face] ?? null;
const doc = (b: string, mates: Mate[]): AsmDoc => ({
  schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 },
  parts: { block: { name: "block", file: "block.mcadprt", doc: stub }, [b]: { name: b, file: `${b}.mcadprt`, doc: stub } },
  components: [
    { id: "p", name: "block<1>", part: "block", tf: IDENTITY, fixed: true },
    { id: "q", name: `${b}<1>`, part: b, tf: compose(translation([40, -15, 30]), rotation([0, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0], 0.4)) },
  ],
  mates,
});
const mate = (type: Mate["type"], a: string, bComp: string, b: string, more: Partial<Mate> = {}): Mate => ({ id: `m${Math.random()}`, name: type, type, a: { comp: "p", face: a }, b: { comp: bComp, face: b }, ...more });
const near = (a: number[], b: number[], tol = 1e-5) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < tol), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

test("reference names", () => {
  assert.equal(edgeRef("b", "a"), "@e:a|b");
  assert.equal(vertexRef(["c", "a", "b", "a"]), "@v:a|b|c");
  assert.equal(refKind("@e:a|b"), "edge"); assert.equal(refKind("@v:a|b|c"), "vertex"); assert.equal(refKind("@o:XY"), "origin"); assert.equal(refKind("f1:side"), "face");
  assert.equal(originOf("@o:ZX"), "ZX"); assert.equal(originOf("@o:Q"), null);
});

test("mate types with points: a vertex takes coincident and distance, a sphere tangent and concentric", () => {
  assert.deepEqual(mateTypes("point", "plane").slice(0, 2), ["coincident", "distance"]);
  assert.ok(mateTypes("point", "axis").includes("concentric"));
  assert.equal(mateTypes("point", "plane", 5, 0)[0], "tangent");
  assert.ok(!mateTypes("point", "plane").includes("parallel"));
  assert.ok(mateTypes("point", "point", 5, 2).includes("tangent"));
});

test("a component's origin point on a vertex, its origin planes parallel to the block's: fully placed", () => {
  const r = solve({ doc: doc("ball", [
    mate("coincident", "@v:corner", "q", "@o:O"),
    mate("parallel", "@o:XY", "q", "@o:XY"),
  ]), geo, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  near(applyPoint(r.tfs.q, [0, 0, 0]), [20, 20, 20]);
  near(applyDir(r.tfs.q, [0, 0, 1]).map(Math.abs), [0, 0, 1]);
  assert.equal(r.dof.q, 1);
});

test("a sphere tangent to a plane and concentric with a round edge sits in the ring", () => {
  const r = solve({ doc: doc("ball", [mate("tangent", "top", "q", "sphere"), mate("concentric", "@e:ring", "q", "sphere")]), geo, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  near(applyPoint(r.tfs.q, [0, 0, 0]), [10, 10, 25]);
});

test("a distance from a vertex to a plane, and the default from where they are", () => {
  const ga = geos.block.top, gb: Geo = { k: "point", p: [3, 4, 32], r: 0 };
  assert.deepEqual(mateDefaults("distance", ga, gb), { value: 12, flip: false });
  const r = solve({ doc: doc("ball", [mate("distance", "top", "q", "@o:O", { value: 7 })]), geo, size: 100 });
  assert.ok(r.ok);
  assert.ok(Math.abs(applyPoint(r.tfs.q, [0, 0, 0])[2] - 27) < 1e-5);
});

test("a round edge coincident with a plane: the circle lies in it", () => {
  const r = solve({ doc: doc("pin", [mate("coincident", "top", "q", "@e:rim")]), geo, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  near(applyDir(r.tfs.q, [0, 0, 1]).map(Math.abs), [0, 0, 1]);
  assert.ok(Math.abs(applyPoint(r.tfs.q, [0, 0, 0])[2] - 20) < 1e-5);
});

test("a cone's axis concentric with a straight edge", () => {
  const r = solve({ doc: doc("pin", [mate("concentric", "@e:edge", "q", "cone")]), geo, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  const p = applyPoint(r.tfs.q, [0, 0, 0]), d = applyDir(r.tfs.q, [0, 0, 1]);
  near([Math.abs(d[0]), d[1], d[2]], [1, 0, 0]);
  near([p[1], p[2]], [0, 20]);
});

test("partRefs: faces, edges, vertices and origin of a box", () => {
  // A unit-free box 10 × 10 × 10 with three faces meeting at (10, 10, 10).
  const face = (id: number, type: "plane" | "sphere", centroid: number[], normal?: number[]) => ({ id, triStart: 0, triCount: 0, type, area: 100, centroid, center: centroid, normal, color: null, edges: [] });
  const edge = (id: number, faces: [number, number], start: number[], end: number[]) => ({ id, pts: [...start, ...end], faces, closed: false, length: 10, type: "line", start, end, mid: start.map((x, i) => (x + end[i]) / 2), dir: end.map((x, i) => (x - start[i]) / 10) });
  const d = {
    faces: [face(0, "plane", [10, 5, 5], [1, 0, 0]), face(1, "plane", [5, 10, 5], [0, 1, 0]), face(2, "plane", [5, 5, 10], [0, 0, 1])],
    edges: [edge(0, [0, 1], [10, 10, 0], [10, 10, 10]), edge(1, [1, 2], [0, 10, 10], [10, 10, 10]), edge(2, [0, 2], [10, 0, 10], [10, 10, 10])],
    bboxMin: [0, 0, 0], bboxMax: [10, 10, 10],
  } as unknown as PartData;
  const m = partRefs(d, ["x", "y", "z"], p => p, v => v);
  assert.equal(m.get("x")?.k, "plane");
  const e = m.get("@e:x|y");
  assert.ok(e?.k === "axis" && e.r === 0);
  const v = m.get("@v:x|y|z");
  assert.ok(v?.k === "point");
  near(v.p, [10, 10, 10]);
  assert.equal(m.get("@o:XY")?.k, "plane");
});
