// Speed-ups of the rebuild pipeline: values kept per shape (memo.ts), pattern cuts in one Boolean,
// and part sections cut exactly on the picked plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { Kernel } from "../../src/kernel/occ";
import { areaOf, massOf, memoOf, optimalBox, stateAt } from "../../src/kernel/memo";
import { section, sectionCut, sectionFinish } from "../../src/kernel/drawing";
import { analyzeMesh } from "../../src/topology";
import { probe } from "../../src/kernel/patch";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const circleOn = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({ id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }] });
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const plate: Feature[] = [rect("s1", 100, 100), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } }];
const holeCut: Feature[] = [circleOn("s2", 30, 0, 4, { face: { name: "f1:end" } }), { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }];
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test("shape memo: mass, area, box and point tests are computed once per shape and equal OpenCASCADE's own", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const fil: Feature = { id: "r1", type: "fillet", name: "Fillet1", radius: { v: 3 }, edges: [{ faces: ["f1:end", "f1:side:s1l1"] }] } as Feature;
  const r = m.evaluate(doc([...plate, ...holeCut, fil]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  const body = r.body!, memo = memoOf(oc);
  // The values, against direct calls.
  const vp = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(body.shape, vp, true, false, false);
  const sp = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(body.shape, sp, false, false);
  const bb = new oc.Bnd_Box_1();
  oc.BRepBndLib.AddOptimal(body.shape, bb, false, false);
  const lo = bb.CornerMin(), hi = bb.CornerMax();
  const p = m.props(body);
  near(p.volume, vp.Mass());
  near(p.area, sp.Mass());
  near(massOf(oc, body.shape).com[0], vp.CentreOfMass().X());
  for (const [k, v] of [lo.X(), lo.Y(), lo.Z()].entries()) near(p.box![0][k], v, 1e-9);
  for (const [k, v] of [hi.X(), hi.Y(), hi.Z()].entries()) near(p.box![1][k], v, 1e-9);
  near(optimalBox(oc, body.shape)![1][2], hi.Z(), 1e-9);
  // A second time nothing is computed.
  const before = memo.misses;
  const again = m.props(body);
  assert.deepEqual(again, p);
  assert.equal(areaOf(oc, body.shape), p.area);
  assert.equal(memo.misses, before, "props of the same body computed something again");
  // A reversed copy is another shape for the mass (its volume changes sign), the same for the area.
  assert.ok(massOf(oc, body.shape.Reversed()).volume < 0);
  assert.equal(areaOf(oc, body.shape.Reversed()), p.area);
  // Point classification: inside the plate, in the hole, on a face.
  assert.equal(stateAt(oc, body.shape, [0, 0, 10], 1e-7), "in");
  assert.equal(stateAt(oc, body.shape, [30, 0, 10], 1e-7), "out");
  assert.equal(stateAt(oc, body.shape, [0, 0, 20], 1e-7), "on");
  assert.equal(stateAt(oc, body.shape, [0, 0, 25], 1e-7), "out");
  // Results handed out are copies or read-only: changing one does not change the next.
  again.com[0] = 99;
  near(m.props(body).com[0], vp.CentreOfMass().X());
});

test("shape memo: after an edit only the faces the feature made are measured again", async () => {
  const oc = await occ();
  const m = new Modeller(oc), k = new Kernel(oc), memo = memoOf(oc);
  const exact = (d: PartDoc) => {
    const r = m.evaluate(d);
    assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
    const body = r.body!, data = analyzeMesh(m.mesh(body, "t", [1, 1, 1], 1) as never);
    k.meshes = [{ shape: body.shape, faces: body.faces, name: "t", color: [1, 1, 1], solid: true }] as never;
    const patch = k.exact(0, probe(data));
    assert.ok(patch.ok);
    return { patch, faces: body.faces.length };
  };
  const a = exact(doc([...plate, ...holeCut]));
  let m0 = memo.misses;
  const same = exact(doc([...plate, ...holeCut]));
  assert.equal(memo.misses, m0, "an unchanged body measured something again");
  assert.deepEqual(same.patch, a.patch);
  // A second hole: the four side walls and the first hole's wall are the same faces as before.
  m0 = memo.misses;
  const more: Feature[] = [circleOn("s3", -30, 10, 5, { face: { name: "f1:end" } }), { id: "f3", type: "extrude", name: "Cut2", sketch: "s3", op: "cut", end: "through", depth: { v: 0 } }];
  const b = exact(doc([...plate, ...holeCut, ...more]));
  assert.equal(b.faces, a.faces + 1);
  near(b.patch.volume!, 100 * 100 * 20 - Math.PI * 16 * 20 - Math.PI * 25 * 20, 1e-9);
  const hits = memo.hits;
  exact(doc([...plate, ...holeCut, ...more]));
  assert.ok(memo.hits > hits);
  // Kept faces answer from the memo: far fewer new values than faces + edges of the new body.
  assert.ok(memo.misses - m0 < 30, `${memo.misses - m0} values computed for one more hole`);
  near(b.patch.area!, same.patch.area! - 2 * Math.PI * 25 + 2 * Math.PI * 5 * 20, 1e-9);
});

test("a pattern of cuts is one Boolean: same body as before, a copy off the body is still reported", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const cp: Feature = { id: "q", type: "cpattern", name: "CPattern1", features: ["f2"], axis: { std: "Z" }, count: 6, angle: { v: 2 * Math.PI }, equal: true } as Feature;
  let r = m.evaluate(doc([...plate, ...holeCut, cp]));
  assert.ok(r.statuses.every(s => s.ok && !s.warning), JSON.stringify(r.statuses));
  near(m.props(r.body!).volume, 100 * 100 * 20 - 6 * Math.PI * 16 * 20, 1e-9);
  // Six holes: one wall each, named by the seed's sketch circle.
  assert.equal(r.body!.faces.length, 6 + 6);
  const walls = (names: string[]) => names.filter(n => !n.startsWith("f1:")).length;
  assert.equal(walls(r.body!.names), 6, r.body!.names.join());
  // A linear pattern that runs off the plate: the copies beyond it are skipped with a warning, the rest cut.
  const lp: Feature = { id: "p", type: "lpattern", name: "LPattern1", features: ["f2"], dir: { edge: { faces: ["f1:side:s1l1", "f1:end"] } }, spacing: { v: 12 }, count: 5 } as Feature;
  r = m.evaluate(doc([...plate, ...holeCut, lp]));
  const st = r.statuses.find(s => s.id === "p")!;
  assert.ok(st.ok, JSON.stringify(st));
  const holes = walls(r.body!.names);
  assert.ok(holes >= 2, r.body!.names.join());
  near(m.props(r.body!).volume, 100 * 100 * 20 - holes * Math.PI * 16 * 20, 1e-6);
  if (holes < 5) assert.match(st.warning ?? "", /copies fall outside the body/);
  // Copies that land on holes already there change nothing and are skipped too.
  const c3: Feature = { ...cp, id: "q3", name: "CPattern2", count: 3 } as Feature;
  r = m.evaluate(doc([...plate, ...holeCut, c3, { ...cp, id: "q6", name: "CPattern3" } as Feature]));
  const s6 = r.statuses.find(s => s.id === "q6")!;
  assert.ok(s6.ok, JSON.stringify(s6));
  assert.match(s6.warning ?? "", /^2 of 5 copies/);
  near(m.props(r.body!).volume, 100 * 100 * 20 - 6 * Math.PI * 16 * 20, 1e-9);
});

test("a part's section is cut exactly on the plane: a shaft's fillets stay arcs and lines", async () => {
  const oc = await occ();
  const pr = () => new oc.Message_ProgressRange_1();
  const cyl = (z: number, r: number, h: number) => new oc.BRepPrimAPI_MakeCylinder_3(new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, z), new oc.gp_Dir_4(0, 0, 1)), r, h).Shape();
  const shaft = new oc.BRepAlgoAPI_Fuse_3(cyl(0, 10, 40), cyl(40, 6, 30), pr()).Shape();
  const mk = new oc.BRepFilletAPI_MakeFillet(shaft, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const em = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shaft, oc.TopAbs_ShapeEnum.TopAbs_EDGE, em);
  for (let i = 1; i <= em.Extent(); i++) { const e = oc.TopoDS.Edge_1(em.FindKey(i)); if (new oc.BRepAdaptor_Curve_2(e).GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) mk.Add_2(1, e); }
  mk.Build(pr());
  const sh = mk.Shape(), view = { dir: [0, -1, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number] };
  const exact = sectionFinish(oc, sectionCut(oc, sh, view, [0, 0, 0], undefined, { nudge: 0 }), view);
  // Every line of the half shaft is a straight line or an arc of a fillet: no free-form polylines.
  assert.ok(exact.vis.length > 0);
  assert.equal(exact.vis.filter(s => s.k === "p").length, 0, JSON.stringify(exact.vis.filter(s => s.k === "p").length));
  assert.equal(exact.cut!.length, 1);
  // The cut face: the profile's area on both sides of the axis.
  const loop = exact.cut![0];
  let area = 0;
  for (let i = 0; i < loop.length; i += 2) { const j = (i + 2) % loop.length; area += loop[i] * loop[j + 1] - loop[j] * loop[i + 1]; }
  assert.ok(Math.abs(Math.abs(area) / 2 - (20 * 40 + 12 * 30)) < 12, `cut area ${Math.abs(area) / 2}`);
  // The default still moves the plane 1 µm (assemblies): same picture within that.
  const moved = section(oc, sh, view, [0, 0, 0]);
  assert.equal(moved.cut!.length, 1);
  assert.ok(Math.abs(moved.box[2] - exact.box[2]) < 1e-2 && Math.abs(moved.box[3] - exact.box[3]) < 1e-2);
});
