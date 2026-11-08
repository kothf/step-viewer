// More dimension types (FR-DRW-021): arc length, chamfer and ordinate dimensions measured from model edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MEdge, Projection, Topo, V3 } from "../../src/kernel/drawing";
import { dimGeo, dimPrims, dimText, holeEdges, holeRows, viewAnnots, type AnnotCtx } from "../../src/drawing/annot";
import { placement } from "../../src/drawing/compose";
import type { DimAnnot, DrawingView, GeoRef, Sheet } from "../../src/drawing/types";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const P = (p: V3): [number, number] => [p[0], p[1]];
const s2 = Math.SQRT1_2 * 10;
const arc = (k: string, a: V3, b: V3, m: V3): MEdge => ({ k, t: "c", a, b, m, c: [0, 0, 0], ax: [0, 0, 1], r: 10, sp: Math.PI / 2 });
const line = (k: string, a: V3, b: V3): MEdge => ({ k, t: "l", a, b, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
const topo: Topo = {
  edges: [
    arc("q1", [10, 0, 0], [0, 10, 0], [s2, s2, 0]),
    arc("q1r", [0, 10, 0], [10, 0, 0], [s2, s2, 0]),
    { ...arc("big", [10, 0, 0], [0, 10, 0], [-s2, -s2, 0]), sp: 1.5 * Math.PI },
    line("ch45", [0, 8, 0], [2, 10, 0]), line("top", [2, 10, 0], [40, 10, 0]),
    line("ch30", [0, 0, 0], [3, Math.sqrt(3), 0]), line("bot", [0, 0, 0], [40, 0, 0]),
  ],
  cyls: [],
};
const ref = (k: string): GeoRef => ({ e: k, h: topo.edges.find(e => e.k === k)!.m, p: "e" });
const dim = (k: DimAnnot["k"], refs: GeoRef[], pos: [number, number] = [20, 20]): DimAnnot => ({ id: "d", t: "dim", view: "v", k, refs, pos });
const sheet = { id: "s", name: "Sheet1", size: "A3", scale: [1, 1], projection: "first", views: [] } as unknown as Sheet;
const view: DrawingView = { id: "v", name: "Top", orient: "top", x: 200, y: 150 };
const pl = placement(sheet, view, { vis: [], hid: [], box: [-20, -20, 50, 20] } as unknown as Projection, null);

test("arc length: radius × sweep, whichever way the arc runs, with the arc symbol", () => {
  for (const k of ["q1", "q1r"]) {
    const g = dimGeo(dim("arc", [ref(k)]), P, topo)!;
    near(g.value, 5 * Math.PI); near(g.a0!, 0); near(g.sw!, Math.PI / 2);
  }
  const big = dimGeo(dim("arc", [ref("big")]), P, topo)!;
  near(big.value, 15 * Math.PI); near(big.a0!, Math.PI / 2); near(big.sw!, 1.5 * Math.PI);
  const a = dim("arc", [ref("q1")]), g = dimGeo(a, P, topo)!;
  assert.equal(dimText(a, g, ".").main, "◠15.71");
  const { prims } = dimPrims(a, g, pl, ".");
  const dl = prims.find(p => p.t === "a") as Extract<typeof prims[number], { t: "a" }>;
  near(dl.a0, 0); near(dl.a1, Math.PI / 2);
  assert.ok(dl.r > 10 * pl.s, "the dimension arc runs outside the edge");
  assert.equal(dimGeo(dim("arc", [ref("top")]), P, topo), null, "a line has no arc length");
});

test("chamfer: the shorter line's run along the other and the angle, in either pick order", () => {
  for (const refs of [[ref("ch45"), ref("top")], [ref("top"), ref("ch45")]]) {
    const a = dim("chamfer", refs), g = dimGeo(a, P, topo)!;
    near(g.value, 2); near(g.ang!, 45);
    assert.equal(dimText(a, g, ".").main, "2 × 45°");
  }
  const a = dim("chamfer", [ref("ch30"), ref("bot")]), g = dimGeo(a, P, topo)!;
  assert.equal(dimText(a, g, ",").main, "3 × 30°");
  const { prims } = dimPrims(a, g, pl, ".");
  assert.ok(prims.some(p => p.t === "t" && p.s === "3 × 30°"));
});

test("ordinate: distance from the base along one axis; the text stands at the end of the extension line", () => {
  const base: GeoRef = { pt: [0, 0, 0] }, q: GeoRef = { pt: [25, 12, 0] };
  const oh = dim("oh", [base, q], [25, 30]), ov = dim("ov", [base, q], [40, 12]);
  assert.equal(dimGeo(oh, P, topo)!.value, 25);
  assert.equal(dimGeo(ov, P, topo)!.value, 12);
  assert.equal(dimText(dim("oh", [base, base]), dimGeo(dim("oh", [base, base]), P, topo)!, ".").main, "0");
  const ph = dimPrims(oh, dimGeo(oh, P, topo)!, pl, ".").prims;
  assert.ok(ph.some(p => p.t === "t" && p.s === "25" && p.rot === 90), "horizontal ordinates read from the right");
  const ext = ph.find(p => p.t === "l") as Extract<typeof ph[number], { t: "l" }>;
  near(ext.p[0], ext.p[2]);
  const pvv = dimPrims(ov, dimGeo(ov, P, topo)!, pl, ".").prims;
  assert.ok(pvv.some(p => p.t === "t" && p.s === "12" && !p.rot));
  assert.equal(dimGeo(dim("ov", [base, { e: "gone", h: [0, 0, 0], p: "e" }]), P, topo), null);
});

test("inspection dimension: the text is framed by an obround", () => {
  const a = dim("arc", [ref("q1")]), g = dimGeo(a, P, topo)!;
  const plain = dimPrims(a, g, pl, ".").prims, insp = dimPrims({ ...a, insp: true }, g, pl, ".").prims;
  assert.equal(insp.length - plain.length, 4, "two sides and two round ends");
  assert.equal(insp.slice(-4).filter(p => p.t === "a").length, 2);
});

test("hole table: end-on holes once each, tagged by size from the smallest, X/Y from the origin", () => {
  const hole = (k: string, c: V3, r: number, z = 0): MEdge => ({ k, t: "c", a: [c[0] + r, c[1], z], b: [c[0] + r, c[1], z], m: [c[0] - r, c[1], z], c: [c[0], c[1], z], ax: [0, 0, 1], r, sp: 2 * Math.PI });
  const ht: Topo = { edges: [hole("h1", [30, 20, 0], 5), hole("h1b", [30, 20, 0], 5, -10), hole("h2", [10, 20, 0], 5), hole("h3", [50, 10, 0], 3),
    { ...hole("side", [0, 0, 0], 4), ax: [1, 0, 0] }, { ...hole("half", [70, 0, 0], 4), sp: Math.PI }, line("e", [0, 0, 0], [80, 0, 0])], cyls: [] };
  const holes = holeEdges(ht, P, [0, 0, 1]);
  assert.deepEqual(holes.map(e => e.k).sort(), ["h1", "h2", "h3"], "the far rim, a side-on circle and an arc are left out");
  const ctx: AnnotCtx = { topo: ht, holes: [], items: [], box: null, dec: ",", label: s => s };
  const a = { id: "t", t: "htable" as const, view: "v", origin: { pt: [0, 0, 0] as V3 }, holes: holes.map(e => ({ e: e.k, h: e.m, p: "e" as const })), pos: [0, -40] as [number, number], prec: 1 };
  const hr = holeRows(a, P, ctx);
  assert.deepEqual(hr.rows, [["A1", "50,0", "10,0", "Ø6"], ["B1", "10,0", "20,0", "Ø10"], ["B2", "30,0", "20,0", "Ø10"]]);
  assert.equal(hr.missing, false);
  const sh = { ...sheet, views: [view], annots: [a] } as unknown as Sheet;
  const out = viewAnnots(sh, view, pl, ctx);
  const tx = out.prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(["Tag", "X LOC", "Y LOC", "Size", "A1", "B2", "X", "Y"].every(s => tx.filter(x => x === s).length >= 1), tx.join(" "));
  assert.equal(tx.filter(x => x === "B2").length, 2, "in the table and beside the hole");
  const gone = viewAnnots({ ...sh, annots: [{ ...a, holes: [...a.holes, { e: "gone", h: [0, 0, 0] as V3, p: "e" as const }] }] } as unknown as Sheet, view, pl, ctx);
  assert.deepEqual(gone.dangling, ["t"]);
});
