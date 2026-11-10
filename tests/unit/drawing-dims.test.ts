// More dimension types (FR-DRW-021): arc length, chamfer and ordinate dimensions measured from model edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MEdge, Projection, Topo, V3 } from "../../src/kernel/drawing";
import { bendRows, cutCols, cutDesc, cutRows, edgeItem, weldItem, stackItem, weldRows, dimGeo, dimPrims, dimText, holeEdges, holeRows, viewAnnots, type AnnotCtx } from "../../src/drawing/annot";
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

test("bend table: bends tagged top to bottom then left to right, the tags replace the notes on the view", () => {
  const bends = [
    { a: [0, 10, 2] as V3, b: [100, 10, 2] as V3, up: true, angle: Math.PI / 2, r: 2 },
    { a: [0, 60, 2] as V3, b: [100, 60, 2] as V3, up: false, angle: Math.PI / 4, r: 1.5 },
    { a: [120, 0, 2] as V3, b: [120, 70, 2] as V3, up: true, angle: Math.PI / 2, r: 2 },
  ];
  const ctx: AnnotCtx = { topo: { edges: [], cyls: [] }, holes: [], bends, items: [], box: null, dec: ",", label: s => s };
  const a = { id: "b", t: "btable" as const, view: "v", pos: [0, -40] as [number, number], prec: 1 };
  assert.deepEqual(bendRows(a, bends, P, ctx), [["A", "DOWN", "45,0°", "1,5"], ["B", "UP", "90,0°", "2,0"], ["C", "UP", "90,0°", "2,0"]]);
  const sh = { ...sheet, views: [view], annots: [a] } as unknown as Sheet;
  const tx = viewAnnots(sh, view, pl, ctx).prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(["Tag", "Direction", "Angle", "Inner radius", "DOWN", "45,0°"].every(s => tx.includes(s)), tx.join(" "));
  assert.equal(tx.filter(x => x === "A").length, 2, "in the table and on the bend line");
  assert.ok(!tx.some(s => /^(UP|DOWN) /.test(s)), "no bend notes beside a bend table");
  const none = viewAnnots(sh, view, pl, { ...ctx, bends: [] });
  assert.deepEqual(none.dangling, ["b"]);
});

test("weld table: one row per kind of bead (continuous, intermittent, staggered, by leg), then a total (FR-FT-121)", () => {
  const welds = [
    { legs: "4", length: 149.7, qty: 2 },
    { legs: "5×8", length: 151.75, qty: 1 },
    { legs: "3.5", length: 80, qty: 1, inter: [20, 40] as [number, number] },
    { legs: "3", length: 60, qty: 1, inter: [20, 50, 1] as [number, number, 1] },
  ];
  const ctx: AnnotCtx = { topo: { edges: [], cyls: [] }, holes: [], welds, items: [], box: null, dec: ",", label: (s, p) => s.replace(/\{(\w+)\}/g, (_m, k) => p?.[k] ?? "") };
  const a = { id: "w", t: "wtable" as const, view: "v", pos: [0, -40] as [number, number] };
  assert.deepEqual(weldRows(a, welds, ctx), [
    ["1", "Continuous", "z4", "149,7", "2"], ["2", "Continuous", "z5×8", "151,75", "1"],
    ["3", "Intermittent 20 / 40", "z3,5", "80", "1"], ["4", "Staggered 20 / 50", "z3", "60", "1"],
    ["", "Total", "", "441,45", "5"],
  ]);
  assert.deepEqual(weldRows({ ...a, prec: 1 }, welds.slice(0, 1), ctx), [["1", "Continuous", "z4", "149,7", "2"]], "no total under one row");
  const sh = { ...sheet, views: [view], annots: [a] } as unknown as Sheet;
  const tx = viewAnnots(sh, view, pl, ctx).prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(["Item", "Weld", "Leg", "Length", "Qty", "z5×8", "Total"].every(s => tx.includes(s)), tx.join(" "));
  assert.deepEqual(viewAnnots(sh, view, pl, { ...ctx, welds: [] }).dangling, ["w"]);
});

test("cut list table: the cut list's items with their numbers, typed descriptions, lengths and end angles (FR-FT-121)", () => {
  const cuts = [
    { item: 1, kind: "member" as const, desc: "SHS 40x40x3", length: 300.25, a1: 45, a2: 0, qty: 4, kg: 1.0512 },
    { item: 2, kind: "plate" as const, desc: "10", plate: [200, 150, 10] as [number, number, number], qty: 1, kg: 2.356 },
    { item: 3, kind: "member" as const, desc: "Leg", own: true, length: 500, a1: 0, a2: 0, qty: 2, kg: 1.75 },
    { item: 4, kind: "bead" as const, desc: "4.5", length: 149.7, qty: 1, kg: 0.01 },
    { item: 5, kind: "bead" as const, desc: "3", length: 60, qty: 1, kg: 0.005, inter: [20, 50, 1] as [number, number, 1] },
  ];
  const ctx: AnnotCtx = { topo: { edges: [], cyls: [] }, holes: [], cuts, items: [], box: null, dec: ",", label: (s, p) => s.replace(/\{(\w+)\}/g, (_m, k) => p?.[k] ?? "") };
  const a = { id: "c", t: "ctable" as const, view: "v", pos: [0, -40] as [number, number] };
  assert.deepEqual(cutCols(a), ["Item", "Qty", "Description", "Length", "Angle 1", "Angle 2"]);
  assert.deepEqual(cutRows(a, cuts, ctx), [
    ["1", "4", "SHS 40x40x3", "300,25", "45°", "0°"], ["2", "1", "Plate 10 × 200 × 150", "", "", ""],
    ["3", "2", "Leg", "500", "0°", "0°"], ["4", "1", "Fillet weld, leg 4,5", "149,7", "", ""],
    ["5", "1", "Staggered fillet weld, leg 3, 20 every 50", "60", "", ""],
  ]);
  const m = { ...a, beads: false, mass: true };
  assert.deepEqual(cutCols(m).at(-1), "Mass (kg)");
  assert.deepEqual(cutRows(m, cuts, ctx).map(r => [r[0], r[6]]), [["1", "1,05"], ["2", "2,36"], ["3", "1,75"]], "beads left out, numbers kept, mass each");
  const sh = { ...sheet, views: [view], annots: [a] } as unknown as Sheet;
  const out = viewAnnots(sh, view, pl, ctx), tx = out.prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(["Item", "Qty", "Description", "Angle 1", "SHS 40x40x3", "Plate 10 × 200 × 150"].every(s => tx.includes(s)), tx.join(" "));
  assert.deepEqual(viewAnnots(sh, view, pl, { ...ctx, cuts: [] }).dangling, ["c"]);
});

test("cut list balloons: a weldment part drawing numbers bodies by their cut list item (FR-FT-121)", () => {
  const cuts = [
    { item: 1, kind: "member" as const, desc: "SHS 40x40x3", length: 300, a1: 45, a2: 45, qty: 4, kg: 1 },
    { item: 2, kind: "plate" as const, desc: "10", plate: [200, 150, 10] as [number, number, number], qty: 2, kg: 2 },
  ];
  const cutFaces = { "m:e1:side:0": 1, "m:e1:side:1": 1, "p:f0": 2 };
  const edges = [line("m:e1:side:0|m:e1:side:1", [0, 0, 0], [40, 0, 0]), line("p:f0|p:f1", [0, 20, 0], [40, 20, 0]), line("x:a|x:b", [0, 30, 0], [40, 30, 0])];
  const ctx: AnnotCtx = { topo: { edges, cyls: [] }, holes: [], cuts, cutFaces, items: [], box: null, dec: ".", label: (s, p) => s.replace(/\{(\w+)\}/g, (_m, k) => p?.[k] ?? "") };
  assert.equal(edgeItem(edges[0].k, ctx), 1);
  assert.equal(edgeItem(edges[1].k, ctx), 2, "either face of the edge names the body");
  assert.equal(edgeItem(edges[2].k, ctx), null);
  assert.equal(stackItem("cut:2", ctx), 2);
  assert.equal(stackItem("cut:9", ctx), null, "an item the cut list no longer has");
  assert.equal(cutDesc(cuts[1], ctx), "Plate 10 × 200 × 150");
  const b = { id: "b", t: "balloon" as const, view: "v", ref: { e: edges[0].k, h: edges[0].m, p: "e" as const }, pos: [20, -20] as [number, number], stack: ["cut:2"], shape: "split" as const };
  const sh = { ...sheet, views: [view], annots: [b] } as unknown as Sheet;
  const out = viewAnnots(sh, view, pl, ctx), tx = out.prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(["1", "2", "4"].every(s => tx.includes(s)), `item numbers and the split quantities: ${tx.join(" ")}`);
  assert.deepEqual(out.dangling, []);
  const lost = { ...b, ref: { ...b.ref, e: edges[2].k }, stack: [] };
  assert.deepEqual(viewAnnots({ ...sh, annots: [lost] } as unknown as Sheet, view, pl, ctx).dangling, ["b"], "an edge of no cut list body dangles");
});

test("weld tags: a tag on a bead edge shows the bead's row in the weld table, apart from cut list balloons (FR-FT-121)", () => {
  const welds = [{ legs: "4", length: 160, qty: 1 }, { legs: "6", length: 400, qty: 2 }];
  const weldFaces = { "w:b0:leg1": 1, "w:b0:leg2": 1, "w:b1:face": 2 };
  const cutFaces = { "w:b0:leg1": 3, "w:b0:leg2": 3, "w:b1:face": 4, "m:e1:side:0": 1 };
  const edges = [line("w:b0:leg1|w:b0:leg2", [0, 0, 0], [40, 0, 0]), line("w:b1:face|m:e1:side:0", [0, 20, 0], [40, 20, 0]), line("m:e1:side:0|m:e1:side:1", [0, 30, 0], [40, 30, 0])];
  const ctx: AnnotCtx = { topo: { edges, cyls: [] }, holes: [], welds, weldFaces, cutFaces, cuts: [], items: [], box: null, dec: ".", label: (s, p) => s.replace(/\{(\w+)\}/g, (_m, k) => p?.[k] ?? "") };
  assert.equal(weldItem(edges[0].k, ctx), 1);
  assert.equal(weldItem(edges[1].k, ctx), 2, "a bead face on either side of the edge names the bead");
  assert.equal(weldItem(edges[2].k, ctx), null);
  assert.equal(edgeItem(edges[0].k, ctx), 3, "a plain balloon still numbers the cut list item");
  assert.equal(stackItem("weld:2", ctx), 2);
  assert.equal(stackItem("weld:3", ctx), null, "a row the weld table no longer has");
  const tag = { id: "w", t: "balloon" as const, view: "v", ref: { e: edges[1].k, h: edges[1].m, p: "e" as const }, pos: [20, -20] as [number, number], weld: true as const, shape: "split" as const };
  const sh = { ...sheet, views: [view], annots: [tag] } as unknown as Sheet;
  const out = viewAnnots(sh, view, pl, ctx), tx = out.prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(tx.includes("2") && !tx.includes("4"), `the weld row and its bead count, not the cut list item: ${tx.join(" ")}`);
  assert.deepEqual(out.dangling, []);
  const lost = { ...tag, ref: { ...tag.ref, e: edges[2].k } };
  assert.deepEqual(viewAnnots({ ...sh, annots: [lost] } as unknown as Sheet, view, pl, ctx).dangling, ["w"], "an edge of no bead dangles");
});
