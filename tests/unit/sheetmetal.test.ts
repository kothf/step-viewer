// Sheet metal (FR-FT-120): base flange, edge flange, hem and flat pattern on the kernel.
// With K = 0.5 the neutral surface is the mid-surface, so the folded volume equals the flat one:
// that checks every bend's allowance and placement at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import type { SmConvertFeature, SmCutFeature, SmGussetFeature, SmReliefFeature, SmUnfoldFeature, SmFormFeature, SmVentFeature, SmCrossFeature, SmLoftFeature, SmBaseFeature, SmClosedFeature, SmCornerFeature, SmFlangeFeature, SmFlatFeature, SmHemFeature, SmJogFeature, SmMiterFeature, SmSketchBendFeature, SmTabFeature } from "../../src/sheetmetal/types";
import { flatLoops, flatSize, bendAllowance, reliefCorners, filletLoop } from "../../src/sheetmetal/sheet";
import { flatDrawing } from "../../src/sheetmetal/flat";
import { loopPolygon, polyArea } from "../../src/sketch/profile";
import { occ } from "./occ";

const rect = (id: string, x0: number, y0: number, x1: number, y1: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  return {
    id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [
      P("1", x0, y0), P("2", x1, y0), P("3", x1, y1), P("4", x0, y1),
      { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
      { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
    ],
  };
};
const chain = (id: string, pts: [number, number][]): SketchFeature => ({
  id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [],
  ents: [...pts.map((p, i): SkEnt => ({ id: `${id}p${i}`, t: "point", x: p[0], y: p[1] })), ...pts.slice(1).map((_p, i): SkEnt => ({ id: `${id}l${i}`, t: "line", a: `${id}p${i}`, b: `${id}p${i + 1}` }))],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-6, `${a} ≠ ${b}`);
const base = (over: Partial<SmBaseFeature> = {}): SmBaseFeature => ({ id: "b", type: "smbase", name: "Base-Flange1", sketch: "s", thickness: { v: 2 }, radius: { v: 2 }, depth: { v: 40 }, k: 0.5, ...over });
const flat: SmFlatFeature = { id: "fp", type: "smflat", name: "Flat-Pattern1" };

let oc: any;
let m: Modeller;
function run(d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const box = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(r.body!.shape, box, false);
  const a = box.CornerMin(), b = box.CornerMax();
  const gap = box.GetGap();
  return { ...r, props: m.props(r.body!), size: [b.X() - a.X() - 2 * gap, b.Y() - a.Y() - 2 * gap, b.Z() - a.Z() - 2 * gap], min: [a.X() + gap, a.Y() + gap, a.Z() + gap] };
}

test("sheet metal: plate, edge flange, flat pattern (FR-FT-120)", async () => {
  oc = await occ();
  m = new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  let r = run(doc([s, base()]));
  close(r.props.volume, 100 * 50 * 2);
  assert.ok(r.body!.names.includes("b:p0:top") && r.body!.names.includes("b:p0:sl1"));

  // A 90° flange, 30 long to the outer virtual sharp, material inside: the outer face stays on the old edge.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  r = run(doc([s, base(), fl]));
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  const flatLen = 50 - 4 + ba + 26;
  close(r.props.volume, 100 * flatLen * 2, 1e-5);
  close(r.size[0], 100, 1e-5); close(r.size[1], 50, 1e-5); close(r.size[2], 30, 1e-5);
  close(r.min[1], 0, 1e-5);
  assert.ok(r.body!.names.includes("f:p0:tip"));
  assert.ok(r.body!.names.some(n => n === "f:b0:in") && r.body!.names.some(n => n === "f:b0:out"));
  const st = r.sheet!;
  close(bendAllowance(st, Math.PI / 2, 2), ba);
  const loops = flatLoops(st);
  assert.equal(loops.outer.length, 1);
  assert.equal(loops.outer[0].length, 4, "the flat outline merges into one rectangle");
  const fs = flatSize(st);
  close(fs.w, 100); close(fs.h, flatLen);

  // Flatten: same volume, lies on the base plane.
  r = run(doc([s, base(), fl, flat]));
  close(r.props.volume, 100 * flatLen * 2, 1e-5);
  close(r.size[2], 2, 1e-6);
  close(r.size[1], flatLen, 1e-6);

  // DXF: the outline and one bend line.
  const dr = flatDrawing(st);
  assert.equal(dr.entities.filter(e => e.layer === "OUTLINE").length, 4);
  assert.equal(dr.entities.filter(e => e.layer.startsWith("BEND")).length, 1);

  // The flange on the other side, bent down, as a chained edit.
  const fl2: SmFlangeFeature = { ...fl, id: "g", name: "Edge-Flange2", edges: [{ faces: ["b:p0:bot", "b:p0:sl3"] }] };
  r = run(doc([s, base(), fl, fl2]));
  close(r.props.volume, 100 * (flatLen + ba + 26 - 4) * 2, 1e-5);
  close(r.size[2], 60 - 2, 1e-5);
});

test("sheet metal: open profile base flange, offsets with relief, hem", async () => {
  oc ??= await occ();
  m = new Modeller(oc);
  // An L of lines: 50 along X then 30 along Y (a left turn), 40 deep, T 1, R 1.
  const s = chain("s", [[0, 0], [50, 0], [50, 30]]);
  const b = base({ thickness: { v: 1 }, radius: { v: 1 } });
  let r = run(doc([s, b]));
  const ba = (Math.PI / 2) * (1 + 0.5);
  // Left turn bends up (thickness on the left): the sketch lines are the outside, setback R + T = 2 each side.
  const L = 50 - 2 + ba + 30 - 2;
  close(r.props.volume, L * 40 * 1, 1e-5);
  close(r.size[0], 50, 1e-5); close(r.size[1], 30, 1e-5); close(r.size[2], 40, 1e-5);
  close(flatSize(r.sheet!).w, L, 1e-9);

  // A flange with offsets on the first panel's long edge: reliefs keep the volume equal to the flat one.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:v1"] }], length: { v: 15 }, angle: { v: Math.PI / 2 }, off0: { v: 10 }, off1: { v: 10 } };
  r = run(doc([s, b, fl]));
  const flatArea = (st: NonNullable<typeof r.sheet>) => {
    const { outer, holes } = flatLoops(st);
    const area = (l: typeof outer[0]) => { let a = 0; for (const q of l) if (q.kind === "line") a += q.a[0] * q.b[1] - q.b[0] * q.a[1]; return a / 2; };
    return outer.reduce((x, l) => x + area(l), 0) + holes.reduce((x, l) => x + area(l), 0);
  };
  close(r.props.volume, flatArea(r.sheet!) * 1, 1e-5);
  const fp = run(doc([s, b, fl, flat]));
  close(fp.props.volume, r.props.volume, 1e-5);

  // Closed hem on the flange's tip.
  const h: SmHemFeature = { id: "h", type: "smhem", name: "Hem1", edges: [{ faces: ["f:p0:top", "f:p0:tip"] }], kind: "closed", length: { v: 6 } };
  r = run(doc([s, b, fl, h]));
  close(r.props.volume, flatArea(r.sheet!) * 1, 1e-4);
});

test("sheet metal: errors", async () => {
  oc ??= await occ();
  m = new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  let r = m.evaluate(doc([s, fl]));
  assert.equal(r.statuses[1].code, "E-SM-NOBASE");
  r = m.evaluate(doc([s, base(), fl, { ...fl, id: "g" }]));
  assert.equal(r.statuses[3].code, "E-SM-USED");
  r = m.evaluate(doc([s, base(), { ...fl, edges: [{ faces: ["b:p0:sl1", "b:p0:sl2"] }] }]));
  assert.equal(r.statuses[2].code, "E-SM-EDGE");
});

test("sheet metal: sketched bend and jog keep the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  // The line is sketched on XY, the plate's bottom face: the bend goes down, the smaller side (x > 60) folds.
  const ln = chain("k", [[60, -5], [60, 55]]);
  const sb: SmSketchBendFeature = { id: "sb", type: "smbend", name: "Sketched-Bend1", sketch: "k", angle: { v: Math.PI / 2 } };
  let r = run(doc([s, base(), ln, sb]));
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  close(r.props.volume, 100 * 50 * 2, 1e-5);
  close(r.size[0], 60 - ba / 2 + 4, 1e-5);
  close(r.size[2], 2 + 2 + 40 - ba / 2, 1e-5);
  let fs = flatSize(r.sheet!);
  close(fs.w, 100); close(fs.h, 50);
  assert.equal(flatLoops(r.sheet!).outer[0].length, 4);
  assert.ok(r.body!.names.includes("sb:p0:top") && r.body!.names.includes("sb:b0:in"));
  // Flipped: the other side folds instead.
  r = run(doc([s, base(), ln, { ...sb, flip: true }]));
  close(r.size[0], 40 - ba / 2 + 4, 1e-5);
  // Bend starts at the line, then 120°.
  r = run(doc([s, base(), ln, { ...sb, position: "start", angle: { v: (2 * Math.PI) / 3 } }]));
  close(r.props.volume, 100 * 50 * 2, 1e-5);
  // Flatten gives the plate back.
  r = run(doc([s, base(), ln, sb, flat]));
  close(r.size[0], 100, 1e-6); close(r.size[1], 50, 1e-6);

  // Jog: the far side ends 10 mm lower (face to same face), then 10 outside to outside.
  const jl = chain("j", [[50, -5], [50, 55]]);
  const jg: SmJogFeature = { id: "jg", type: "smjog", name: "Jog1", sketch: "j", offset: { v: 10 }, dim: "face", angle: { v: Math.PI / 2 } };
  r = run(doc([s, base(), jl, jg]));
  close(r.props.volume, 100 * 50 * 2, 1e-5);
  close(r.size[2], 12, 1e-5);
  fs = flatSize(r.sheet!);
  close(fs.w, 100); close(fs.h, 50);
  r = run(doc([s, base(), jl, { ...jg, dim: "outside" }]));
  close(r.size[2], 10, 1e-5);
  r = run(doc([s, base(), jl, { ...jg, angle: { v: Math.PI / 4 }, dim: "inside", offset: { v: 6 } }]));
  close(r.size[2], 6 + 4, 1e-5);
  close(r.props.volume, 100 * 50 * 2, 1e-5);
  // Too small for two bends of radius 2.
  const bad = m.evaluate(doc([s, base(), jl, { ...jg, offset: { v: 1 } }])).statuses.find(x => x.id === "jg");
  assert.equal(bad?.ok, false);
});

test("sheet metal: tab beside a face joins the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const tb = rect("t", 100, 10, 120, 40);
  const tf: SmTabFeature = { id: "tb", type: "smtab", name: "Tab1", sketch: "t" };
  const r = run(doc([s, base(), tb, tf]));
  close(r.props.volume, (100 * 50 + 20 * 30) * 2, 1e-6);
  close(r.size[0], 120, 1e-6);
  const loops = flatLoops(r.sheet!);
  assert.equal(loops.outer.length, 1);
  assert.equal(loops.outer[0].length, 8);
  // A flange on the tab's far edge.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["tb:p0:top", "tb:p0:tl2"] }], length: { v: 15 }, angle: { v: Math.PI / 2 } };
  const r2 = run(doc([s, base(), tb, tf, fl]));
  close(r2.props.volume, (100 * 50 + 20 * 30 - 4 * 30 + ((Math.PI / 2) * 3 + 11) * 30) * 2, 1e-5);
  // Over the face: refused.
  const over = m.evaluate(doc([s, base(), rect("o", 90, 10, 120, 40), { ...tf, sketch: "o" }])).statuses.find(x => x.id === "tb");
  assert.equal(over?.ok, false);
  assert.equal(over?.code, "E-SM-TABOVER");
});

test("sheet metal: holes cut in flat faces show in the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  const circ = (id: string, plane: "XY" | "XZ", x: number, y: number, r: number): SketchFeature => ({
    id, type: "sketch", name: id, plane: { std: plane }, rels: [], dims: [], ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}o`, t: "circle", c: `${id}c`, r }],
  });
  // One hole in the plate, one in the flange (the flange stands on y = 0, 30 high; flat, it lies below y = 4 - ba).
  const h1 = circ("h1", "XY", 20, 20, 5), h2 = circ("h2", "XZ", 70, 18, 4);
  const cut = (id: string, sk: string): Feature => ({ id, type: "extrude", name: id, sketch: sk, op: "cut", end: "through2", depth: { v: 0 } });
  const feats = [s, base(), fl, h1, cut("c1", "h1"), h2, cut("c2", "h2")];
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  const flatLen = 50 - 4 + ba + 26;
  const holes = Math.PI * (25 + 16) * 2;
  const folded = run(doc(feats));
  close(folded.props.volume, 100 * flatLen * 2 - holes, 1e-5);
  const r = run(doc([...feats, flat]));
  close(r.props.volume, 100 * flatLen * 2 - holes, 1e-5);
  close(r.size[1], flatLen, 1e-6);
  // The flange hole lands on the flange part of the pattern: 18 up the flange is 14 flat past the bend.
  const edges = r.sheet!.flatEdges!;
  const circles = edges.filter(e => e.kind === "circle") as { c: [number, number]; r: number }[];
  assert.equal(circles.length, 2, JSON.stringify(edges.map(e => e.kind)));
  const c1 = circles.find(c => Math.abs(c.r - 5) < 1e-6)!, c2 = circles.find(c => Math.abs(c.r - 4) < 1e-6)!;
  close(c1.c[0], 20, 1e-6); close(c1.c[1], 20, 1e-6);
  close(c2.c[0], 70, 1e-6); close(c2.c[1], 4 - ba - (18 - 4), 1e-6);
  const dr = flatDrawing(r.sheet!);
  assert.equal(dr.entities.filter(e => e.kind === "circle").length, 2);
  // Without cuts the flat pattern keeps its exact sketch outline.
  assert.equal(run(doc([s, base(), fl, flat])).sheet!.flatEdges, undefined);
});

test("sheet metal: edge flanges on edges meeting at a corner are mitred (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const { apply } = await import("../../src/sheetmetal/sheet");
  const s = rect("s", 0, 0, 100, 50);
  // Front (y = 0) and right (x = 100) edges: the front edge ends where the right one starts.
  const fl = (gap: number): SmFlangeFeature => ({ id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }, { faces: ["b:p0:top", "b:p0:sl2"] }], length: { v: 30 }, angle: { v: Math.PI / 2 }, gap: { v: gap } });
  for (const gap of [0.1, 5]) {
    const r = run(doc([s, base(), fl(gap)]));
    close(r.size[0], 100, 1e-6); close(r.size[1], 50, 1e-6); close(r.size[2], 30, 1e-6);
    const st = r.sheet!;
    for (const [id, axis] of [["f:p0", 0], ["f:p1", 1]] as const) {
      const p = st.panels.find(x => x.id === id)!;
      const mi = p.outer.filter(x => x.ent === "miter");
      assert.equal(mi.length, 1, `${id} has one mitre edge`);
      // The mid-planes meet 1 mm (T/2) inside the outer corner; each flange stops gap/2 short of it.
      const pts = [mi[0].a, mi[0].b].map(q => apply(p.M, [q[0], q[1], 1]));
      for (const q of pts) close(axis === 0 ? q[0] : q[1], axis === 0 ? 99 - gap / 2 : 1 + gap / 2, 1e-6);
    }
    assert.equal(flatLoops(st).outer.length, 1);
    run(doc([s, base(), fl(gap), flat]));
  }
});

test("sheet metal: break corner chamfers and rounds outside corners (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const bc = (kind: "chamfer" | "fillet", size: number, edges = [{ faces: ["b:p0:sl1", "b:p0:sl2"] as [string, string] }]): SmCornerFeature => ({ id: "c", type: "smcorner", name: "Break-Corner1", edges, kind, size: { v: size } });
  // Chamfer 10 at (100, 0): a 10 × 10 triangle off the plate, and a new side face named after the outline piece.
  let r = run(doc([s, base(), bc("chamfer", 10)]));
  close(r.props.volume, (5000 - 50) * 2);
  const p0 = r.sheet!.panels[0];
  const piece = p0.outer.find(x => x.ent.startsWith("x"))!;
  assert.equal(piece.kind, "line");
  assert.ok(r.body!.names.includes(`b:p0:${piece.ent}`), "the chamfer face is named");
  assert.equal(flatLoops(r.sheet!).outer[0].length, 5);
  // The picked faces may come in either order; two corners at once.
  r = run(doc([s, base(), bc("fillet", 10, [{ faces: ["b:p0:sl2", "b:p0:sl1"] }, { faces: ["b:p0:sl2", "b:p0:sl3"] }])]));
  close(r.props.volume, (5000 - 2 * 100 * (1 - Math.PI / 4)) * 2, 1e-6);
  assert.equal(r.sheet!.panels[0].outer.filter(x => x.kind === "arc").length, 2);
  run(doc([s, base(), bc("fillet", 10), flat]));
  // An edge flange on the chamfer's edge.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", `b:p0:${piece.ent}`] }], length: { v: 15 }, angle: { v: Math.PI / 2 } };
  r = run(doc([s, base(), bc("chamfer", 10), fl]));
  close(r.size[2], 15, 1e-6);
  // Too big for the edge, and an edge that isn't at a corner.
  const bad = (f: SmCornerFeature) => m.evaluate(doc([s, base(), f])).statuses.find(x => x.id === "c")!;
  assert.equal(bad(bc("chamfer", 60)).ok, false);
  assert.equal(bad(bc("chamfer", 5, [{ faces: ["b:p0:sl1", "b:p0:sl3"] }])).ok, false);
});

test("sheet metal: closed corner runs flange ends on to meet (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const { apply } = await import("../../src/sheetmetal/sheet");
  const s = rect("s", 0, 0, 100, 50);
  // Two flanges, material outside, made separately on the front and right edges: they leave an open corner.
  const fl = (id: string, e: string): SmFlangeFeature => ({ id, type: "smflange", name: id, edges: [{ faces: ["b:p0:top", `b:p0:${e}`] }], length: { v: 20 }, angle: { v: Math.PI / 2 }, position: "outside" });
  const cc = (face: string, kind: "overlap" | "underlap"): SmClosedFeature => ({ id: "c", type: "smclosed", name: "Closed-Corner1", faces: [{ name: face }], kind });
  const v0 = run(doc([s, base(), fl("f", "sl1"), fl("g", "sl2")])).props.volume;
  // In world terms: the front flange covers the right one's end (to x = 102), the right one runs to 0.1 mm from it.
  const ends = (r: ReturnType<typeof run>) => {
    const end = (pid: string, ent: string) => { const p = r.sheet!.panels.find(x => x.id === pid)!, sg = p.outer.find(x => x.ent === ent)!; return apply(p.M, [(sg as any).a[0], (sg as any).a[1], 0]); };
    return { fx: end("f:p0", "s1")[0], gy: end("g:p0", "s0")[1] };
  };
  let r = run(doc([s, base(), fl("f", "sl1"), fl("g", "sl2"), cc("f:p0:s1", "overlap")]));
  let e = ends(r);
  close(e.fx, 102); close(e.gy, 0.1);
  close(r.props.volume - v0, 16 * 2 * 2 + 16 * 1.9 * 2, 1e-6);
  assert.ok(r.body!.names.includes("f:p0:s1") && r.body!.names.includes("g:p0:s0"), "the moved end faces keep their names");
  run(doc([s, base(), fl("f", "sl1"), fl("g", "sl2"), cc("f:p0:s1", "overlap"), flat]));
  // Underlap from the front flange = overlap from the right one: the front flange is cut back 0.1 mm short of it.
  for (const c of [cc("f:p0:s1", "underlap"), cc("g:p0:s0", "overlap")]) {
    r = run(doc([s, base(), fl("f", "sl1"), fl("g", "sl2"), c]));
    e = ends(r);
    close(e.fx, 99.9); close(e.gy, -2);
  }
  // A face with no flange beyond it.
  assert.equal(m.evaluate(doc([s, base(), fl("f", "sl1"), fl("g", "sl2"), cc("f:p0:s0", "overlap")])).statuses.find(x => x.id === "c")!.ok, false);
});

test("sheet metal: the flat pattern laid on XY for drawings (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const { flatPatternDoc, flatToXY, flatBends } = await import("../../src/sheetmetal/sheet");
  // A plate on a tilted sketch plane would do too; here the flange makes the folded part non-flat.
  const s = rect("s", 0, 0, 100, 50);
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 20 }, angle: { v: Math.PI / 2 } };
  const d = doc([s, base(), fl]);
  assert.equal(flatPatternDoc(doc([s])), null, "not sheet metal");
  const fd = flatPatternDoc(d)!;
  assert.equal(fd.features.at(-1)!.type, "smflat");
  assert.equal(d.features.length, 3, "the original is left alone");
  const r = m.evaluate(fd);
  const t = flatToXY(r.sheet!), tr = new oc.gp_Trsf_1();
  tr.SetValues(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11]);
  const moved = r.body!.shape.Moved(new oc.TopLoc_Location_2(tr), false);
  const box = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(moved, box, false);
  const lo = box.CornerMin(), hi = box.CornerMax(), g = box.GetGap();
  close(hi.Z() - lo.Z() - 2 * g, 2, 1e-5);
  close(lo.Z() + g, 0, 1e-5);
  const bends = flatBends(r.sheet!);
  assert.equal(bends.length, 1);
  close(bends[0].a[2], 2); close(bends[0].angle, Math.PI / 2); close(bends[0].r, 2);
  // The bend line lies across the pattern, inside its box.
  for (const p of [bends[0].a, bends[0].b]) assert.ok(p[0] >= lo.X() - 1e-6 && p[0] <= hi.X() + 1e-6 && p[1] >= lo.Y() - 1e-6 && p[1] <= hi.Y() + 1e-6);
});

test("sheet metal: miter flange runs a sketched profile along edges (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  // On YZ (2D = Y, Z) at the front edge's start: up 30 to the outer sharp, then 20 outwards (-Y).
  const pr = { ...chain("mp", [[0, 0], [0, 30], [-20, 30]]), plane: { std: "YZ" as const } };
  const mf: SmMiterFeature = { id: "mf", type: "smmiter", name: "Miter-Flange1", sketch: "mp", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }] };
  let r = run(doc([s, base(), pr, mf]));
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  // Bend 1 has the profile outside (setback r + T), bend 2 inside (setback r).
  close(r.props.volume, 100 * ((50 - 4) + ba + (30 - 4 - 2) + ba + (20 - 2)) * 2, 1e-5);
  close(r.size[0], 100, 1e-6); close(r.size[1], 70, 1e-5); close(r.size[2], 32, 1e-5);
  close(r.min[1], -20, 1e-5);
  assert.ok(r.body!.names.includes("mf:p0:top") && r.body!.names.includes("mf:p1:tip") && r.body!.names.includes("mf:b1:in"));
  // The profile drawn from its far end works the same.
  const rev = { ...chain("mp", [[-20, 30], [0, 30], [0, 0]]), plane: { std: "YZ" as const } };
  close(run(doc([s, base(), rev, mf])).props.volume, r.props.volume, 1e-9);
  assert.equal(flatLoops(r.sheet!).outer.length, 1);
  run(doc([s, base(), pr, mf, flat]));

  // Front and right edges meet at a corner: every level is mitred there.
  const two: SmMiterFeature = { ...mf, edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }, { faces: ["b:p0:top", "b:p0:sl2"] }] };
  r = run(doc([s, base(), pr, two]));
  close(r.size[0], 120, 1e-5); close(r.size[1], 70, 1e-5); close(r.size[2], 32, 1e-5);
  for (const id of ["mf:p0", "mf:p1", "mf:p2", "mf:p3"]) assert.equal(r.sheet!.panels.find(x => x.id === id)!.outer.filter(x => x.ent === "miter").length, 1, `${id} is mitred`);
  run(doc([s, base(), pr, two, flat]));

  // A profile away from the edges, or not square to it, is refused.
  const off = { ...chain("mp", [[0, 0], [30, 10]]), plane: { std: "XZ" as const } };
  const bad = m.evaluate(doc([s, base(), off, mf])).statuses.find(x => x.id === "mf");
  assert.ok(bad && !bad.ok);
});

test("sheet metal: swept flange makes each tangent arc a bend of its radius (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  // On YZ: up 20, a tangent arc of radius 10 turning outwards (-Y), then 10 more: virtual sharp at (0, 30), ends at -20.
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `sp${k}`, t: "point", x, y });
  const pr: SketchFeature = {
    id: "sp", type: "sketch", name: "sp", plane: { std: "YZ" }, rels: [], dims: [], ents: [
      P("0", 0, 0), P("1", 0, 20), P("c", -10, 20), P("2", -10, 30), P("3", -20, 30),
      { id: "spl0", t: "line", a: "sp0", b: "sp1" }, { id: "spa", t: "arc", c: "spc", a: "sp1", b: "sp2" }, { id: "spl1", t: "line", a: "sp2", b: "sp3" },
    ],
  };
  const sf: SmMiterFeature = { id: "sf", type: "smswept", name: "Swept-Flange1", sketch: "sp", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }] };
  const r = run(doc([s, base(), pr, sf]));
  // The arc is on the inside of bend 2 (it turns against the first): inner radius 10, setback 10.
  const ba1 = (Math.PI / 2) * (2 + 0.5 * 2), ba2 = (Math.PI / 2) * (10 + 0.5 * 2);
  close(r.props.volume, 100 * ((50 - 4) + ba1 + (30 - 4 - 10) + ba2 + (20 - 10)) * 2, 1e-5);
  close(r.size[1], 70, 1e-5); close(r.size[2], 32, 1e-5); close(r.min[1], -20, 1e-5);
  close(r.sheet!.bends.find(x => x.id === "sf:b1")!.r, 10, 1e-9);
  run(doc([s, base(), pr, sf, flat]));
  // The same profile as a miter flange is refused (it has an arc), and an arc that doesn't sit between lines is refused here.
  const asMiter = m.evaluate(doc([s, base(), pr, { ...sf, type: "smmiter" }])).statuses.find(x => x.id === "sf");
  assert.ok(asMiter && !asMiter.ok);
  const tail: SketchFeature = { ...pr, ents: pr.ents.filter(e => e.id !== "spl1") };
  const bad = m.evaluate(doc([s, base(), tail, sf])).statuses.find(x => x.id === "sf");
  assert.ok(bad && !bad.ok);
});

test("sheet metal: cuts across a bend are unrolled in the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  const flatLen = 50 - 4 + ba + 26;
  // A slot through everything over x 40..60, y < 10: 6 of the plate, the whole bend and the flange go.
  const slot = rect("k", 40, -5, 60, 10);
  const cut: Feature = { id: "c", type: "extrude", name: "Cut-Extrude1", sketch: "k", op: "cut", end: "through2", depth: { v: 0 } };
  const want = 2 * (100 * flatLen - 20 * (6 + ba + 26));
  const folded = run(doc([s, base(), fl, slot, cut]));
  close(folded.props.volume, want, 1e-5);
  const r = run(doc([s, base(), fl, slot, cut, flat]));
  close(r.props.volume, want, 1e-4);
  close(r.size[0], 100, 1e-6); close(r.size[1], flatLen, 1e-6);
  // A slot ending inside the bend (z < 2 on the flange side) takes part of the bend strip only.
  const slot2 = { ...rect("k", 40, -5, 60, 10), plane: { std: "XY" as const } };
  const part: Feature = { ...cut, end: "blind", depth: { v: 2 }, flip: true } as Feature;
  const f2 = run(doc([s, base(), fl, slot2, part]));
  const r2 = run(doc([s, base(), fl, slot2, part, flat]));
  // The flat pattern loses what the folded part lost (the neutral surface keeps lengths).
  close(r2.props.volume, f2.props.volume, 2e-3);
});

test("sheet metal: lofted bend unfolds its facets exactly (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const up = (id: string, z: number): Feature => ({ id, type: "plane", name: id, base: { std: "XY" }, mode: "offset", offset: { v: z } });
  const on = (sk: SketchFeature, plane: string): SketchFeature => ({ ...sk, plane: { plane } });
  const arc = (id: string, r: number, a: [number, number], b: [number, number]): SketchFeature => ({
    id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [
      { id: `${id}c`, t: "point", x: 0, y: 0 }, { id: `${id}a`, t: "point", x: a[0], y: a[1] }, { id: `${id}b`, t: "point", x: b[0], y: b[1] },
      { id: `${id}r`, t: "arc", c: `${id}c`, a: `${id}a`, b: `${id}b` },
    ],
  });
  const loft = (over: Partial<SmLoftFeature> = {}): SmLoftFeature => ({ id: "lb", type: "smloft", name: "Lofted-Bend1", sketch1: "s1", sketch2: "s2", thickness: { v: 2 }, radius: { v: 2 }, k: 0.5, ...over });
  const area = (st: NonNullable<ReturnType<typeof run>["sheet"]>) => st.panels.reduce((a, p) => a + Math.abs(polyArea(loopPolygon(p.outer))), 0);

  // Two parallel lines 30 apart: one flat panel 100 × 30, no folds.
  let r = run(doc([chain("s1", [[0, 0], [100, 0]]), up("pl", 30), on(chain("s2", [[0, 0], [100, 0]]), "pl"), loft()]));
  close(r.props.volume, 100 * 30 * 2, 1e-6);
  assert.equal(r.sheet!.panels.length, 1);
  assert.equal(r.sheet!.folds!.length, 0);
  const sz = flatSize(r.sheet!);
  close(Math.max(sz.w, sz.h), 100, 1e-6); close(Math.min(sz.w, sz.h), 30, 1e-6);
  assert.ok(r.body!.names.includes("lb:p0:top") && r.body!.names.includes("lb:p0:bot"));
  r = run(doc([chain("s1", [[0, 0], [100, 0]]), up("pl", 30), on(chain("s2", [[0, 0], [100, 0]]), "pl"), loft(), flat]));
  close(r.props.volume, 100 * 30 * 2, 1e-6);

  // Half a cone frustum (radius 50 at the bottom, 25 at 40 up): facets folded by small angles, area ≈ the cone's.
  const cone = [arc("s1", 50, [50, 0], [-50, 0]), up("pl", 40), on(arc("s2", 25, [25, 0], [-25, 0]), "pl")];
  r = run(doc([...cone, loft({ thickness: { v: 1 }, facets: 24 })]));
  const st = r.sheet!;
  assert.ok(st.folds!.length >= 23, `${st.folds!.length} folds`);
  assert.ok(st.folds!.every(f => f.angle < 0.2 && f.up === st.folds![0].up));
  // Thickness on the other side turns every fold the other way.
  const rev = run(doc([...cone, loft({ thickness: { v: 1 }, facets: 24, reverse: true })])).sheet!;
  assert.ok(rev.folds!.every(f => f.up !== st.folds![0].up));
  const lateral = Math.PI * (50 + 25) * Math.hypot(25, 40) / 2;
  assert.ok(Math.abs(area(st) - lateral) < lateral * 0.02, `${area(st)} vs ${lateral}`);
  // K = 0.5: the folded volume is the flat area times the thickness.
  close(r.props.volume, area(st) * 1, 2e-3);
  assert.equal(flatLoops(st).outer.length, 1);
  const fd = flatDrawing(st);
  assert.ok(fd.entities.filter(e => e.layer === "BEND_UP" || e.layer === "BEND_DOWN").length === st.folds!.length);
  const fr = run(doc([...cone, loft({ thickness: { v: 1 }, facets: 24 }), flat]));
  close(fr.props.volume, area(st), 1e-6);

  // A corner of two lines lofted to a quarter circle (a square-to-round quarter): one outline, flat faces kept whole.
  const sq = [chain("s1", [[60, 0], [60, 60], [0, 60]]), up("pl", 50), on(arc("s2", 30, [30, 0], [0, 30]), "pl")];
  r = run(doc([...sq, loft({ facets: 8 })]));
  assert.equal(flatLoops(r.sheet!).outer.length, 1);
  close(r.props.volume, area(r.sheet!) * 2, 5e-3);
  run(doc([...sq, loft({ facets: 8, reverse: true }), flat]));
  // A second base feature is refused.
  const two = m.evaluate(doc([rect("s", 0, 0, 10, 10), base(), ...sq, loft()])).statuses.find(x => x.id === "lb");
  assert.ok(two && !two.ok);
});

test("sheet metal: cross break marks a flat face corner to corner (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const cb = (over: Partial<SmCrossFeature> = {}): SmCrossFeature => ({ id: "x", type: "smcross", name: "Cross-Break1", faces: [{ name: "b:p0:top" }], radius: { v: 0.5 }, angle: { v: Math.PI / 180 }, ...over });
  const r = run(doc([s, base(), cb()]));
  close(r.props.volume, 100 * 50 * 2);
  const cr = r.sheet!.crosses!;
  assert.equal(cr.length, 2);
  // The two diagonals of the plate.
  const len = (c: typeof cr[number]) => Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
  for (const c of cr) close(len(c), Math.hypot(100, 50), 1e-9);
  assert.ok(cr.every(c => c.up && c.side === "top"));
  assert.ok(run(doc([s, base(), cb({ flip: true })])).sheet!.crosses!.every(c => !c.up));
  // Flat pattern DXF: the two lines on their own layer; the flattened part keeps them.
  assert.equal(flatDrawing(r.sheet!).entities.filter(e => e.layer === "CROSS_BREAK").length, 2);
  assert.equal(run(doc([s, base(), cb(), flat])).sheet!.crosses!.length, 2);
  // A side face or a bad angle fails.
  assert.equal(m.evaluate(doc([s, base(), cb({ faces: [{ name: "b:p0:sl1" }] })])).statuses.find(x => x.id === "x")!.ok, false);
  assert.equal(m.evaluate(doc([s, base(), cb({ angle: { v: Math.PI / 2 } })])).statuses.find(x => x.id === "x")!.ok, false);
});

test("sheet metal: vent cuts the boundary less ribs and spars (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  // Boundary 60 × 30, one rib across it at x = 50 (ends on the boundary's sides), one spar circle r 8 at (30, 25).
  const v = rect("v", 20, 10, 80, 40);
  v.ents.push({ id: "vr1", t: "point", x: 50, y: 10 }, { id: "vr2", t: "point", x: 50, y: 40 }, { id: "vr", t: "line", a: "vr1", b: "vr2" },
    { id: "vc0", t: "point", x: 30, y: 25 }, { id: "vc", t: "circle", c: "vc0", r: 8 });
  const vent = (over: Partial<SmVentFeature> = {}): SmVentFeature => ({ id: "x", type: "smvent", name: "Vent1", sketch: "v", rib: { v: 2 }, spar: { v: 2 }, ...over });
  const r = run(doc([s, base(), v, vent()]));
  const open = 60 * 30 - 2 * 30 - Math.PI * (9 * 9 - 7 * 7);
  close(r.props.volume, (100 * 50 - open) * 2, 1e-6);
  // Flattened: the same openings.
  close(run(doc([s, base(), v, vent(), flat])).props.volume, (100 * 50 - open) * 2, 1e-6);
  // A spar that is not a circle, and a sketch off the sheet, fail.
  const off: SketchFeature = { ...rect("w", 20, 10, 80, 40), plane: { std: "XZ" } };
  assert.equal(m.evaluate(doc([s, base(), off, vent({ sketch: "w" })])).statuses.find(x => x.id === "x")!.ok, false);
  const sq = rect("v", 20, 10, 80, 40);
  sq.ents.push(...rect("q", 30, 20, 35, 25).ents);
  assert.equal(m.evaluate(doc([s, base(), sq, vent()])).statuses.find(x => x.id === "x")!.ok, false);
});

test("sheet metal: forming tools keep the thickness and stay out of the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const form = (over: Partial<SmFormFeature>): SmFormFeature => ({ id: "x", type: "smform", name: "Form-Tool1", face: { name: "b:p0:top" }, tool: "dimple", pts: [[25, 25]], size: { v: 20 }, width: { v: 10 }, height: { v: 6 }, ...over });
  const plate = 100 * 50 * 2;
  // Dimple Ø20 × 6, square walls: a cup of wall 2 (ring 10..8 × 4 high, cap 2) less the Ø16 hole through the sheet.
  const d = run(doc([s, base(), form({})]));
  close(d.props.volume, plate + 216 * Math.PI, 1e-5);
  assert.equal(d.props.bodies, 1);
  // Flattened, the form is left out.
  close(run(doc([s, base(), form({}), flat])).props.volume, plate, 1e-6);
  // Out of the bottom face: the same volume, the other way.
  const dn = run(doc([s, base(), form({ face: { name: "b:p0:bot" } })]));
  close(dn.props.volume, plate + 216 * Math.PI, 1e-5);
  assert.ok(dn.min[2] < -5 && dn.min[2] + dn.size[2] <= 2 + 1e-3);
  // Rib 30 × 10 × 4: 4 × (outer obround − inner obround 26 × 6).
  close(run(doc([s, base(), form({ tool: "rib", pts: [[60, 25]], size: { v: 30 }, height: { v: 4 } })])).props.volume, plate + 4 * (80 + 16 * Math.PI), 1e-5);
  // Extruded hole Ø10 × 4: collar 7..5, hole through; the flat pattern has the Ø6 pre-pierce hole.
  const xh = form({ tool: "xhole", pts: [[85, 25]], size: { v: 10 }, height: { v: 4 } });
  close(run(doc([s, base(), xh])).props.volume, plate + 46 * Math.PI, 1e-5);
  const xf = run(doc([s, base(), xh, flat]));
  close(xf.props.volume, plate - 18 * Math.PI, 1e-6);
  const ents = flatDrawing(xf.sheet!).entities;
  assert.ok(ents.some(e => e.layer === "FORM_TOOL" && e.kind === "circle" && Math.abs(e.r - 7) < 1e-9));
  assert.ok(ents.some(e => e.layer === "OUTLINE" && e.kind === "circle" && Math.abs(e.r - 3) < 1e-6));
  // Louver and a drafted dimple build; the flat pattern is the plain plate.
  const lv = form({ tool: "louver", pts: [[50, 25]], size: { v: 30 }, width: { v: 12 }, height: { v: 5 } });
  assert.ok(run(doc([s, base(), lv])).props.volume > plate);
  close(run(doc([s, base(), lv, flat])).props.volume, plate, 1e-6);
  const dd = form({ draft: { v: Math.PI / 12 }, pts: [[25, 25], [75, 25]] });
  assert.ok(run(doc([s, base(), dd])).props.volume > plate);
  close(run(doc([s, base(), dd, flat])).props.volume, plate, 1e-6);
  // Off the face, too low, and no face fail.
  const bad = (f: SmFormFeature) => assert.equal(m!.evaluate(doc([s, base(), f])).statuses.find(x => x.id === "x")!.ok, false);
  bad(form({ pts: [[5, 25]] }));
  bad(form({ height: { v: 1.5 } }));
  bad(form({ face: { name: "b:p0:sl1" } }));
});

test("sheet metal: unfold, cut across the bend, fold back (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  const ba = (Math.PI / 2) * (2 + 0.5 * 2);
  const flatLen = 50 - 4 + ba + 26;
  const unf: SmUnfoldFeature = { id: "u", type: "smunfold", name: "Unfold1", face: { name: "b:p0:top" }, bends: [] };
  const fold: SmUnfoldFeature = { id: "v", type: "smfold", name: "Fold1", bends: [] };
  // Unfolded: the flange lies flat in the base plate's plane.
  let r = run(doc([s, base(), fl, unf]));
  close(r.props.volume, 2 * 100 * flatLen, 1e-5);
  close(r.size[2], 2, 1e-6); close(r.size[1], flatLen, 1e-6); close(r.min[1], 50 - flatLen, 1e-6);
  assert.ok(r.sheet!.unfold);
  assert.ok(r.body!.names.includes("f:b0:top"), "the flat bend is named after the bend");
  // Other sheet metal features wait for the fold.
  const late = m.evaluate(doc([s, base(), fl, unf, { ...fl, id: "g", edges: [{ faces: ["b:p0:top", "b:p0:sl3"] }] }]));
  assert.equal(late.statuses.find(x => x.id === "g")?.code, "E-SM-UNFOLDED");
  // A slot inside the bend strip (y 4 - ba .. 4) and a hole in the flange, cut while flat.
  const slot = rect("k", 40, 5 - ba, 60, 3);
  const hole: SketchFeature = { id: "h", type: "sketch", name: "h", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "hc", t: "point", x: 50, y: 4 - ba - 13 }, { id: "hk", t: "circle", c: "hc", r: 5 }] };
  const cut = (id: string, sk: string): Feature => ({ id, type: "extrude", name: id, sketch: sk, op: "cut", end: "through2", depth: { v: 0 } } as Feature);
  const feats = [s, base(), fl, unf, slot, cut("c", "k"), hole, cut("d", "h")];
  r = run(doc(feats));
  const lost = 2 * (20 * (ba - 2) + 25 * Math.PI);
  close(r.props.volume, 2 * 100 * flatLen - lost, 1e-6);
  // Folded back: the slot wraps onto the bend and the hole goes up with the flange; the neutral surface keeps areas.
  r = run(doc([...feats, fold]));
  assert.equal(r.sheet!.unfold, undefined);
  close(r.props.volume, 2 * 100 * flatLen - lost, 1e-5);
  close(r.size[0], 100, 1e-6); close(r.size[1], 50, 1e-6); close(r.size[2], 30, 1e-6);
  // The hole is in the flange (y 0..2), its centre 13 up from the bend's end (z = 4 + 13).
  const inside = (p: [number, number, number]) => new oc.BRepClass3d_SolidClassifier_3(r.body!.shape, new oc.gp_Pnt_3(...p), 1e-6).State() === oc.TopAbs_State.TopAbs_IN;
  assert.ok(inside([50, 1, 17]) === false && inside([20, 1, 17]) === true, "the hole is in the flange");
  // The Flat-Pattern after the fold has both openings again.
  r = run(doc([...feats, fold, flat]));
  close(r.props.volume, 2 * 100 * flatLen - lost, 1e-4);
  // Flat-Pattern straight after an unfold folds the cuts back first.
  r = run(doc([...feats, flat]));
  close(r.props.volume, 2 * 100 * flatLen - lost, 1e-4);
  // A slot cut while folded, through the bend, is unrolled by the Unfold; a dimple moves with its panel.
  const k2 = rect("k2", 40, -5, 60, 10);
  const dim: SmFormFeature = { id: "fm", type: "smform", name: "Form-Tool1", face: { name: "b:p0:top" }, tool: "dimple", pts: [[50, 30]], size: { v: 10 }, width: { v: 4 }, height: { v: 3 } };
  const pre = [s, base(), fl, k2, cut("c2", "k2"), dim];
  const fv = run(doc(pre)).props.volume;
  r = run(doc([...pre, unf]));
  close(r.props.volume, fv, 1e-4);
  close(r.size[2], 2 + 3, 1e-6);
  r = run(doc([...pre, unf, fold]));
  close(r.props.volume, fv, 1e-4);
  // (The box of the wrapped faces' B-spline edges is a little loose.)
  close(r.size[2], 30, 1e-3);
});

test("sheet metal: corner relief at two-bend corners (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const edges = (ids: string[]) => ids.map(e => ({ faces: ["b:p0:top", `b:p0:${e}`] as [string, string] }));
  const fl = (ids: string[]): SmFlangeFeature => ({ id: "f", type: "smflange", name: "Edge-Flange1", edges: edges(ids), length: { v: 30 }, angle: { v: Math.PI / 2 } });
  const rel = (over: Partial<SmReliefFeature> = {}): SmReliefFeature => ({ id: "r", type: "smrelief", name: "Corner-Relief1", corners: [], kind: "rect", ...over });
  // Front (y = 0) and right (x = 100) flanges: one corner, where the start lines (4 inside the edges) cross.
  const two = [s, base(), fl(["sl1", "sl2"])];
  const r0 = run(doc(two));
  const cs = reliefCorners(r0.sheet!);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].key, "f:b0+f:b1");
  close(cs[0].c0[0], 96, 1e-9); close(cs[0].c0[1], 4, 1e-9);
  assert.equal(reliefCorners(run(doc([s, base(), fl(["sl1", "sl2", "sl3", "sl4"])])).sheet!).length, 4);
  const inside = (r: { body: { shape: unknown } | null }, p: [number, number, number]) => new oc.BRepClass3d_SolidClassifier_3(r.body!.shape, new oc.gp_Pnt_3(...p), 1e-6).State() === oc.TopAbs_State.TopAbs_IN;
  assert.ok(inside(r0, [95.5, 4.5, 1]));
  const flat0 = run(doc([...two, flat])).props.volume;
  for (const kind of ["rect", "obround", "circle", "tear"] as const) {
    const r = run(doc([...two, rel({ kind })]));
    assert.ok(r.props.volume < r0.props.volume - 1, `${kind} takes material away`);
    assert.equal(inside(r, [95.5, 4.5, 1]), false, `${kind}: the face corner is cut`);
    assert.ok(inside(r, [94, 6, 1]), `${kind}: the relief stays at the corner`);
    const f = run(doc([...two, rel({ kind }), flat]));
    // The flat pattern loses about as much (the two bends overlap a little at the folded corner).
    const lost = flat0 - f.props.volume;
    assert.ok(lost > 1);
    close(lost, r0.props.volume - r.props.volume, 0.03);
  }
  // Obround and rounded rectangular reliefs take less than the sharp rectangle; the obround least.
  const vr = run(doc([...two, rel()])).props.volume, vf = run(doc([...two, rel({ round: { v: 1 } })])).props.volume, vo = run(doc([...two, rel({ kind: "obround" })])).props.volume;
  assert.ok(vr < vf && vf < vo, JSON.stringify({ vr, vf, vo }));
  // filletLoop: a 10 × 4 rectangle rounded as far as it goes is a stadium.
  const st = filletLoop([[0, 0], [10, 0], [10, 4], [0, 4]], Infinity, "x");
  close(polyArea(loopPolygon(st, 256)), 6 * 4 + Math.PI * 4, 1e-3);
  // A bigger clearance takes more; a picked corner only that one.
  const v1 = run(doc([...two, rel()])).props.volume, v3 = run(doc([...two, rel({ size: { v: 3 } })])).props.volume;
  assert.ok(v3 < v1);
  const four = [s, base(), fl(["sl1", "sl2", "sl3", "sl4"])];
  const all = run(doc([...four, rel()])).props.volume, one = run(doc([...four, rel({ corners: ["f:b0+f:b1"] })])).props.volume;
  close(run(doc(four)).props.volume - one, (run(doc(four)).props.volume - all) / 4, 1e-2);
  // Errors: no corners; corners gone.
  const bad = m.evaluate(doc([s, base(), fl(["sl1"]), rel()]));
  assert.equal(bad.statuses.find(x => x.id === "r")?.code, "E-SM-NOCORNER");
  const gone = m.evaluate(doc([...two, rel({ corners: ["x+y"] })]));
  assert.equal(gone.statuses.find(x => x.id === "r")?.code, "E-SM-CORNERGONE");
});

test("sheet metal: gusset across a bend, left out of the flat pattern (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  // The front flange stands on y 0..2 up to z 30; the inside faces meet at y = z = 2.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  const gus = (over: Partial<SmGussetFeature> = {}): SmGussetFeature => ({ id: "g", type: "smgusset", name: "Sheet-Metal-Gusset1", bend: "f:b0", depth: { v: 10 }, width: { v: 6 }, ...over });
  const pre = [s, base(), fl];
  const r0 = run(doc(pre));
  const r = run(doc([...pre, gus()]));
  const inside = (q: { body: { shape: unknown } | null }, p: [number, number, number]) => new oc.BRepClass3d_SolidClassifier_3(q.body!.shape, new oc.gp_Pnt_3(...p), 1e-6).State() === oc.TopAbs_State.TopAbs_IN;
  assert.ok(!inside(r0, [48, 4, 4]), "air inside the bend before");
  assert.ok(inside(r, [48, 4, 4]), "the rib's side wall");
  assert.ok(!inside(r, [50, 4, 4]), "the groove behind it");
  assert.ok(inside(r, [50, 6.25, 6.25]), "the rib's top wall");
  assert.ok(!inside(r, [50, 7.5, 7.5]), "past the rib");
  assert.ok(!inside(r, [50, 1.88, 1.88]) && inside(r, [20, 1.88, 1.88]), "the groove goes through the bend");
  assert.equal(r.sheet!.gussets?.length, 1);
  // Off the middle: at 20 from the start end, the rib is where asked (the bend runs along x, from one end or the other).
  const r2 = run(doc([...pre, gus({ at: { v: 20 } })]));
  assert.ok(inside(r2, [18, 4, 4]) !== inside(r2, [82, 4, 4]));
  // The flat pattern is the same as without the gusset.
  close(run(doc([...pre, gus(), flat])).props.volume, run(doc([...pre, flat])).props.volume, 1e-6);
  // Errors.
  const code = (g: SmGussetFeature, more: Feature[] = []) => m.evaluate(doc([...pre, g, ...more])).statuses.find(x => x.id === "g")?.code;
  assert.equal(code(gus({ width: { v: 4 } })), "E-SM-GUSSETWIDTH");
  assert.equal(code(gus({ depth: { v: 3 } })), "E-SM-GUSSETDEPTH");
  assert.equal(code(gus({ bend: "x:b0" })), "E-SM-GUSSETBEND");
  assert.equal(code(gus({ at: { v: 99 } })), "E-SM-GUSSETPOS");
  const unf: SmUnfoldFeature = { id: "u", type: "smunfold", name: "Unfold1", bends: [] };
  assert.equal(m.evaluate(doc([...pre, gus(), unf])).statuses.find(x => x.id === "u")?.code, "E-SM-UNFOLDGUSSET");
  // Three ribs 20 apart about the middle (x 30, 50, 70); the volume grows three times as much as for one.
  const one = r.props.volume - r0.props.volume;
  const r3 = run(doc([...pre, gus({ count: 3, spacing: { v: 20 } })]));
  assert.equal(r3.sheet!.gussets?.length, 3);
  close(r3.props.volume - r0.props.volume, 3 * one, 1e-6);
  for (const x of [28, 48, 68]) assert.ok(inside(r3, [x, 4, 4]), `rib wall at x ${x}`);
  assert.ok(!inside(r3, [40, 4, 4]), "air between the ribs");
  close(run(doc([...pre, gus({ count: 3, spacing: { v: 20 } }), flat])).props.volume, run(doc([...pre, flat])).props.volume, 1e-6);
  // A longer reach up the flange (second face): the rib reaches higher there but not further along the plate.
  const r4 = run(doc([...pre, gus({ depth2: { v: 16 } })]));
  assert.ok(r4.props.volume > r.props.volume);
  assert.ok(inside(r4, [48, 4, 10]) && !inside(r, [48, 4, 10]), "the rib wall runs further up the flange");
  assert.equal(code(gus({ count: 3, spacing: { v: 4 } })), "E-SM-GUSSETSPACE");
  assert.equal(code(gus({ count: 0 })), "E-SM-GUSSETCOUNT");
});

test("sheet metal: normal cut is square to the sheet, across bends too (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 50);
  const plate = 100 * 50 * 2;
  const cut = (over: Partial<SmCutFeature> = {}): SmCutFeature => ({ id: "x", type: "smcut", name: "Normal-Cut1", sketch: "k", ...over });
  // Link to thickness from the bottom face (XY): reversed so it goes into the sheet; a Ø10 hole.
  const hole: SketchFeature = { id: "k", type: "sketch", name: "k", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "kc0", t: "point", x: 50, y: 30 }, { id: "kc", t: "circle", c: "kc0", r: 5 }] };
  close(run(doc([s, base(), hole, cut({ flip: true })])).props.volume, plate - 50 * Math.PI, 1e-6);
  // The default direction runs away from the sheet and misses it.
  assert.equal(m.evaluate(doc([s, base(), hole, cut()])).statuses.find(x => x.id === "x")!.ok, false);
  // A 90° flange up on the y = 0 edge; a slot x 40..60, y < 2 cut up through all from z = 0 ends inside the bend,
  // where the neutral surface (radius 3 about y = z = 4) passes y = 2: the bend is cut radially there.
  const fl: SmFlangeFeature = { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:sl1"] }], length: { v: 30 }, angle: { v: Math.PI / 2 } };
  const ba = (Math.PI / 2) * 3;
  const flatLen = 50 - 4 + ba + 26;
  const slot = rect("k", 40, -5, 60, 2);
  const gone = 20 * 2 * (3 * (Math.PI / 2 - Math.asin(2 / 3)) + 26);
  const folded = run(doc([s, base(), fl, slot, cut({ end: "through", flip: true })]));
  close(folded.props.volume, 100 * flatLen * 2 - gone, 2e-4);
  // The flat pattern loses the same (the cut ends square on the neutral surface).
  const fp = run(doc([s, base(), fl, slot, cut({ end: "through", flip: true }), flat]));
  close(fp.props.volume, 100 * flatLen * 2 - gone, 2e-4);
  // Blind 1 from z = 0 reaches no mid-surface of the bend or flange.
  assert.equal(m.evaluate(doc([s, base(), fl, slot, cut({ end: "blind", depth: { v: 0.5 }, flip: true })])).statuses.find(x => x.id === "x")!.ok, false);
});

test("sheet metal: convert a solid box to sheet metal (FR-FT-120)", async () => {
  oc ??= await occ();
  m ??= new Modeller(oc);
  const s = rect("s", 0, 0, 100, 60);
  const box: Feature = { id: "e", type: "extrude", name: "Boss1", sketch: "s", op: "boss", end: "blind", depth: { v: 40 } };
  const conv = (over: Partial<SmConvertFeature> = {}): SmConvertFeature => ({ id: "c", type: "smconvert", name: "Convert-Solid1", face: { name: "e:start" }, edges: [], thickness: { v: 2 }, radius: { v: 2 }, k: 0.5, ...over });
  const edge = (l: string) => ({ faces: ["e:start", `e:side:s${l}`] as [string, string] });
  // A U channel: the bottom and the two long walls; the thickness lies inside, so the box keeps its size.
  const ba = (Math.PI / 2) * 3;
  const flatW = 60 - 8 + 2 * (36 + ba);
  const u = run(doc([s, box, conv({ edges: [edge("l1"), edge("l3")] })]));
  close(u.props.volume, 100 * flatW * 2, 1e-5);
  close(u.size[0], 100, 1e-6); close(u.size[1], 60, 1e-6); close(u.size[2], 40, 1e-6);
  assert.equal(u.sheet!.bends.length, 2);
  const uf = run(doc([s, box, conv({ edges: [edge("l1"), edge("l3")] }), flat]));
  close(uf.props.volume, 100 * flatW * 2, 1e-5);
  close(uf.size[1], flatW, 1e-6);
  // A tray: all four walls, ripped and mitred at the corners; the flat pattern keeps the volume (K = 0.5) but for the
  // corners, where the two bends overlap in the folded part until a corner relief takes them out.
  const tr = run(doc([s, box, conv({ edges: ["l1", "l2", "l3", "l4"].map(edge) })]));
  close(tr.size[0], 100, 1e-6); close(tr.size[1], 60, 1e-6); close(tr.size[2], 40, 1e-6);
  assert.equal(tr.props.bodies, 1);
  const tf = run(doc([s, box, conv({ edges: ["l1", "l2", "l3", "l4"].map(edge) }), flat]));
  close(tf.props.volume, tr.props.volume, 3e-3);
  // A hole through both long walls before converting carries over to the sheet and its flat pattern.
  const hs: SketchFeature = { id: "h", type: "sketch", name: "h", plane: { std: "XZ" }, rels: [], dims: [], ents: [{ id: "hc0", t: "point", x: 50, y: 20 }, { id: "hc", t: "circle", c: "hc0", r: 5 }] };
  const hole: Feature = { id: "hx", type: "extrude", name: "Cut1", sketch: "h", op: "cut", end: "through2", depth: { v: 0 } };
  const hu = run(doc([s, box, hs, hole, conv({ edges: [edge("l1"), edge("l3")] })]));
  close(hu.props.volume, 100 * flatW * 2 - 2 * 50 * Math.PI, 1e-5);
  close(run(doc([s, box, hs, hole, conv({ edges: [edge("l1"), edge("l3")] }), flat])).props.volume, 100 * flatW * 2 - 2 * 50 * Math.PI, 1e-5);
  // A bend edge off the fixed face, or a curved fixed face, fails.
  assert.equal(m.evaluate(doc([s, box, conv({ edges: [{ faces: ["e:side:sl1", "e:side:sl2"] }] })])).statuses.find(x => x.id === "c")!.ok, false);
});
