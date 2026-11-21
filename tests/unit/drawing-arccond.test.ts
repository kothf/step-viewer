// Linear dimensions to a circle seen end-on: from its centre, its near side or its far side (arc conditions).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MEdge, Topo, V3 } from "../../src/kernel/drawing";
import { dimGeo, endOnRadius } from "../../src/drawing/annot";
import type { DimAnnot, GeoRef } from "../../src/drawing/types";

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const circ = (k: string, c: V3, r: number): MEdge => ({ k, t: "c", a: [c[0] + r, c[1], c[2]], b: [c[0] + r, c[1], c[2]], m: [c[0] - r, c[1], c[2]], c, ax: [0, 0, 1], r, sp: 2 * Math.PI });
// Top view of a plate: holes Ø10 at (30, 0) and Ø20 at (100, 40), a straight edge along y = -50.
const topo: Topo = { edges: [circ("h1", [30, 0, 0], 5), circ("h2", [100, 40, 0], 10), { k: "e", t: "l", a: [0, -50, 0], b: [200, -50, 0], m: [100, -50, 0] }] };
const P = (p: V3): [number, number] => [p[0], p[1]];
const R = (k: string): GeoRef => ({ e: k, h: topo.edges.find(e => e.k === k)!.m, p: "e" });
const dim = (k: DimAnnot["k"], refs: GeoRef[], cond?: DimAnnot["cond"]): DimAnnot => ({ id: "d", t: "dim", view: "v", k, refs, pos: [0, 0], ...(cond ? { cond } : {}) });

test("arc conditions on linear dimensions between circles and to a line", () => {
  near(endOnRadius(R("h1"), P, topo), 5);
  assert.equal(endOnRadius(R("e"), P, topo), 0, "a straight edge has no arc condition");
  // Seen from the side the circle is a line: no arc condition.
  assert.equal(endOnRadius(R("h1"), p => [p[0], p[2]], topo), 0);
  near(dimGeo(dim("h", [R("h1"), R("h2")]), P, topo)!.value, 70);
  near(dimGeo(dim("h", [R("h1"), R("h2")], ["min", "min"]), P, topo)!.value, 55);
  near(dimGeo(dim("h", [R("h1"), R("h2")], ["max", "max"]), P, topo)!.value, 85);
  near(dimGeo(dim("h", [R("h1"), R("h2")], ["min", "max"]), P, topo)!.value, 75);
  near(dimGeo(dim("v", [R("h1"), R("h2")], ["max", undefined]), P, topo)!.value, 45);
  const L = Math.hypot(70, 40);
  near(dimGeo(dim("al", [R("h1"), R("h2")], ["min", "min"]), P, topo)!.value, L - 15);
  near(dimGeo(dim("al", [R("h1"), R("h2")], ["center", "max"]), P, topo)!.value, L + 10);
  // A hole to the edge: square to the line, near or far side of the hole.
  near(dimGeo(dim("al", [R("e"), R("h2")]), P, topo)!.value, 90);
  near(dimGeo(dim("al", [R("e"), R("h2")], [undefined, "min"]), P, topo)!.value, 80);
  near(dimGeo(dim("al", [R("e"), R("h2")], [undefined, "max"]), P, topo)!.value, 100);
});
