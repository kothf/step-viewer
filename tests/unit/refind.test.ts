// References found again after earlier features change (1.585.0): a fillet, chamfer, sketch plane or any
// other face/edge reference keeps its geometry when an upstream edit renames the faces it was stored by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { applyRefFixes, fixRefsIn } from "../../src/model/refFix";
import type { EdgeRef, Feature, FilletFeature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, cx: number, cy: number, w: number, h: number, names = ["l1", "l2", "l3", "l4"], plane: SketchFeature["plane"] = { std: "XY" }): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const L = (k: number, a: string, b: string): SkEnt => ({ id: `${id}${names[k]}`, t: "line", a: `${id}p${a}`, b: `${id}p${b}` });
  return { id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [
    P("1", cx - w / 2, cy - h / 2), P("2", cx + w / 2, cy - h / 2), P("3", cx + w / 2, cy + h / 2), P("4", cx - w / 2, cy + h / 2),
    L(0, "1", "2"), L(1, "2", "3"), L(2, "3", "4"), L(3, "4", "1"),
  ] };
};
const circle = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null, naming: 2 });
const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);
const bad = (r: { statuses: { ok: boolean }[] }) => r.statuses.filter(s => !s.ok);
/** The document as the controller keeps it after a rebuild: with the references the rebuild reported. */
function taken(d: PartDoc, refs: Record<string, Parameters<typeof fixRefsIn>[1]>): PartDoc {
  const out = structuredClone(d);
  for (const f of out.features) if (refs[f.id]) fixRefsIn(f, refs[f.id]);
  return out;
}
const filletVol = (w: number, h: number, r: number, n = 1) => w * h * 20 - n * 20 * (r * r - (Math.PI * r * r) / 4);

test("a fillet keeps its edge when the sketch lines are drawn again under new ids", async () => {
  const m = new Modeller(await occ());
  // As picked in the view: names + the edge middle, no signature yet.
  const edge: EdgeRef = { faces: ["f1:side:s1l1", "f1:side:s1l2"], hint: [50, -30, 10] };
  const fil: FilletFeature = { id: "f3", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges: [edge] };
  let d = doc([rect("s1", 0, 0, 100, 60), ex, fil]);
  let r = m.evaluate(d);
  assert.deepEqual(bad(r), []);
  close(m.props(r.body!).volume, filletVol(100, 60, 5));

  // Both lines deleted and drawn again in place (new ids): the names the fillet stored are gone.
  d = doc([rect("s1", 0, 0, 100, 60, ["l7", "l8", "l3", "l4"]), ex, fil]);
  r = m.evaluate(d);
  assert.deepEqual(bad(r), [], JSON.stringify(bad(r)));
  close(m.props(r.body!).volume, filletVol(100, 60, 5));
  const fx = r.refs.f3;
  assert.ok(fx?.length === 1 && fx[0].found, JSON.stringify(fx));
  assert.deepEqual([...(fx[0].to as EdgeRef).faces].sort(), ["f1:side:s1l7", "f1:side:s1l8"]);

  // The document takes the reference over: the next rebuild is answered from the cache, by names.
  d = taken(d, r.refs);
  assert.deepEqual([...(d.features[2] as FilletFeature).edges[0].faces].sort(), ["f1:side:s1l7", "f1:side:s1l8"]);
  const body = r.body;
  r = m.evaluate(d);
  assert.equal(r.body, body);
  assert.deepEqual(Object.values(r.refs).flat().filter(x => x.found && !JSON.stringify(d).includes(JSON.stringify(x.to))), []);

  // One line renamed and the block made longer in the same edit: found by its kind near where it was.
  d = structuredClone(d);
  d.features[0] = rect("s1", 0, 0, 120, 60, ["l7", "l9", "l3", "l4"]);
  r = m.evaluate(d);
  assert.deepEqual(bad(r), [], JSON.stringify(bad(r)));
  close(m.props(r.body!).volume, filletVol(120, 60, 5));
  assert.deepEqual([...(applyRefFixes(d.features[2], r.refs.f3) as FilletFeature).edges[0].faces].sort(), ["f1:side:s1l7", "f1:side:s1l9"]);
});

test("stored references follow the geometry: hints and signatures are refreshed", async () => {
  const m = new Modeller(await occ());
  const fil: FilletFeature = { id: "f3", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges: [{ faces: ["f1:side:s1l1", "f1:side:s1l2"] }] };
  const d = doc([rect("s1", 0, 0, 100, 60), ex, fil]);
  const r = m.evaluate(d);
  assert.deepEqual(bad(r), []);
  const to = r.refs.f3[0].to as EdgeRef;
  assert.equal(r.refs.f3[0].found, false);
  assert.deepEqual(to.hint, [50, -30, 10]);
  assert.deepEqual(to.g, ["l", 0, 0, 1]);
  // Nothing to report once the document holds them.
  const r2 = m.evaluate(taken(d, r.refs));
  assert.equal(r2.refs.f3?.filter(x => JSON.stringify(x.to) !== x.from).length ?? 0, r2.refs.f3?.length ?? 0);
  const m2 = new Modeller(await occ());
  assert.deepEqual(m2.evaluate(taken(d, r.refs)).refs, {});
});

test("a reference whose geometry is really gone still fails", async () => {
  const m = new Modeller(await occ());
  const s2 = circle("s2", 0, 0, 10, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  const ch: Feature = { id: "f4", type: "chamfer", name: "Chamfer1", distance: { v: 1 }, edges: [{ faces: ["f1:end", "f2:side:s2k"] }] };
  let d = doc([rect("s1", 0, 0, 100, 60), ex, s2, cut, ch]);
  let r = m.evaluate(d);
  assert.deepEqual(bad(r), []);
  d = taken(d, r.refs);
  // The hole suppressed: no circle is left for the chamfer, and no straight edge may take its place.
  d.features[3] = { ...cut, suppressed: true } as Feature;
  r = m.evaluate(d);
  assert.equal(r.statuses.find(s => s.id === "f4")!.ok, false);
  assert.equal(r.statuses.find(s => s.id === "f4")!.code, "E-TN-LOST");
  // A fillet edge with only a stale hint far from every edge is not guessed either.
  const fil: FilletFeature = { id: "f5", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges: [{ faces: ["f1:side:gone", "f1:side:gone2"], hint: [20, -10, 10] }] };
  r = m.evaluate(doc([rect("s1", 0, 0, 100, 60), ex, fil]));
  assert.equal(r.statuses.find(s => s.id === "f5")!.ok, false);
});

test("a sketch plane, a shell face and a hole keep their faces after a rename", async () => {
  const m = new Modeller(await occ());
  const side = { name: "f1:side:s1l2", hint: [50, 0, 10] as [number, number, number] };
  const s2 = circle("s2", 0, 10, 4, { face: side });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "blind", depth: { v: 5 } };
  const shell: Feature = { id: "f6", type: "shell", name: "Shell1", thickness: { v: 2 }, faces: [{ name: "f1:side:s1l4", hint: [-50, 0, 10] }] } as Feature;
  let d = doc([rect("s1", 0, 0, 100, 60), ex, s2, cut, shell]);
  let r = m.evaluate(d);
  assert.deepEqual(bad(r), [], JSON.stringify(bad(r)));
  const v = m.props(r.body!).volume;
  d = taken(d, r.refs);
  d.features[0] = rect("s1", 0, 0, 100, 60, ["l1", "l12", "l3", "l14"]);
  r = m.evaluate(d);
  assert.deepEqual(bad(r), [], JSON.stringify(bad(r)));
  close(m.props(r.body!).volume, v);
  assert.equal((applyRefFixes(d.features[2], r.refs.s2) as SketchFeature).plane && ((applyRefFixes(d.features[2], r.refs.s2) as SketchFeature).plane as { face: { name: string } }).face.name, "f1:side:s1l12");
  assert.ok(r.refs.f6.some(x => x.found));
});
