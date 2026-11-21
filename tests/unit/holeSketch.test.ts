// Hole positions from sketch points (FR-FT-050, a CAD app's Hole Wizard Positions): a hole with `sketch` drills at
// that sketch's points, follows them when the sketch changes, and the document keeps `plane`/`pts` in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, HoleFeature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { holeSketchPoints, holeSketchPts, syncHoleSketches } from "../../src/model/holePos";
import { featureRefs } from "../../src/model/doc";
import { copyClip, pasteClip } from "../../src/model/paste";
import { occ } from "./occ";

const P = (id: string, x: number, y: number, cons?: boolean): SkEnt => ({ id, t: "point", x, y, ...(cons ? { cons } : {}) });
const plate: SketchFeature = { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [],
  ents: [P("a", -50, -50), P("b", 50, -50), P("c", 50, 50), P("d", -50, 50),
    { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }, { id: "l3", t: "line", a: "c", b: "d" }, { id: "l4", t: "line", a: "d", b: "a" }] };
const pos = (pts: [number, number][]): SketchFeature => ({ id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: pts.map((p, i) => P(`q${i}`, p[0], p[1])) });
const hole: HoleFeature = { id: "h1", type: "hole", name: "Hole1", sketch: "s2", pts: [], kind: "simple", diameter: { v: 8 }, end: "through", depth: { v: 0 } };
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const base = (pts: [number, number][]): Feature[] => [plate, { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } } as Feature, pos(pts), structuredClone(hole)];
const cyl = Math.PI * 16 * 20;

test("hole sketch points: free Point entities only, not construction, not curve ends", () => {
  const sk: SketchFeature = { id: "s", type: "sketch", name: "S", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("p1", 0, 0), P("p2", 10, 0, true), P("e1", 20, 0), P("e2", 30, 0), { id: "l", t: "line", a: "e1", b: "e2" },
    P("k1", 40, 0), P("k2", 50, 0), { id: "lc", t: "line", a: "k1", b: "k2", cons: true },
    P("cc", 60, 0), { id: "c", t: "circle", c: "cc", r: 3 }] };
  assert.deepEqual(holeSketchPoints(sk).map(p => p.id), ["p1"]);
});

test("hole from a sketch: drilled at the sketch points, moved when they move", async () => {
  const m = new Modeller(await occ());
  let r = m.evaluate(doc(base([[20, 10], [-30, -25]])));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  let p = m.props(r.body!);
  assert.ok(Math.abs(p.volume - (200000 - 2 * cyl)) < 1e-2, `${p.volume}`);
  // The centre of mass moves away from the holes: Σ (hole centre) × hole volume = − (com) × body volume.
  const comX = (h: [number, number][]) => -h.reduce((s, q) => s + q[0], 0) * cyl / (200000 - h.length * cyl);
  assert.ok(Math.abs(p.com[0] - comX([[20, 10], [-30, -25]])) < 1e-6, `${p.com[0]}`);
  // Move a point (as a dimension change in the sketch would): the hole follows.
  r = m.evaluate(doc(base([[35, 10], [-30, -25]])));
  p = m.props(r.body!);
  assert.ok(Math.abs(p.com[0] - comX([[35, 10], [-30, -25]])) < 1e-6, `${p.com[0]}`);
  // Three points: three holes, even though the hole's own `pts` is stale.
  r = m.evaluate(doc(base([[35, 10], [-30, -25], [0, 30]])));
  assert.ok(Math.abs(m.props(r.body!).volume - (200000 - 3 * cyl)) < 1e-2);
});

test("hole from a sketch: missing sketch or no points is an error", async () => {
  const m = new Modeller(await occ());
  let r = m.evaluate(doc(base([])));
  assert.equal(r.statuses.find(s => s.id === "h1")?.ok, false);
  const fs = base([[0, 0]]);
  (fs[3] as HoleFeature).sketch = "nope";
  r = m.evaluate(doc(fs));
  const st = r.statuses.find(s => s.id === "h1");
  assert.equal(st?.ok, false);
});

test("document: plane and pts follow the sketch; refs and paste carry the sketch", () => {
  const d = doc(base([[1, 2], [3, 4]]));
  syncHoleSketches(d);
  const h = d.features[3] as HoleFeature;
  assert.deepEqual(h.pts, [[1, 2], [3, 4]]);
  assert.deepEqual(h.plane, { face: { name: "f1:end" } });
  assert.deepEqual(holeSketchPts(d, h), [[1, 2], [3, 4]]);
  assert.ok(featureRefs(h).features.includes("s2"));
  const clip = copyClip(d, "h1")!;
  assert.deepEqual(clip.feats.map(f => f.type), ["sketch", "hole"]);
  let n = 0;
  const out = pasteClip(d, clip, { std: "XZ" }, () => `n${++n}`).feats;
  assert.equal((out[1] as HoleFeature).sketch, out[0].id);
  assert.deepEqual((out[0] as SketchFeature).plane, { std: "XZ" });
});
