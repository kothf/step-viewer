// Sheet metal (FR-FT-120): base flange, edge flange, hem and flat pattern on the kernel.
// With K = 0.5 the neutral surface is the mid-surface, so the folded volume equals the flat one:
// that checks every bend's allowance and placement at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import type { SmBaseFeature, SmFlangeFeature, SmFlatFeature, SmHemFeature, SmJogFeature, SmSketchBendFeature } from "../../src/sheetmetal/types";
import { flatLoops, flatSize, bendAllowance } from "../../src/sheetmetal/sheet";
import { flatDrawing } from "../../src/sheetmetal/flat";
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
