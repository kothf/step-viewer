// Selected contours (FR-FT-010): regions of crossing/branching sketch curves, and extrude/revolve on picked ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { regionAt, regionPoint, sketchRegions, inRegion } from "../../src/sketch/regions";
import { sketchProfile } from "../../src/sketch/profile";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

/** A 100 × 60 rectangle centred on the origin with a line across it at x = 20 (a T at each end). */
function crossed(): SketchFeature {
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const ents: SkEnt[] = [
    P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30), P("q1", 20, -30), P("q2", 20, 30),
    { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" },
    { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" },
    { id: "l5", t: "line", a: "q1", b: "q2" },
  ];
  return { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents, rels: [], dims: [] };
}

/** Two circles of r 20 whose centres are 20 apart, plus a small circle inside the left one only. */
function lens(): SketchFeature {
  return { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [
    { id: "a", t: "point", x: -10, y: 0 }, { id: "b", t: "point", x: 10, y: 0 }, { id: "c", t: "point", x: -22, y: 0 },
    { id: "ka", t: "circle", c: "a", r: 20 }, { id: "kb", t: "circle", c: "b", r: 20 }, { id: "kc", t: "circle", c: "c", r: 4 },
  ] };
}

test("regions of crossing and branching curves", () => {
  const sk = crossed();
  assert.ok(sketchProfile(sk).error);
  const rs = sketchRegions(sk);
  assert.equal(rs.length, 2);
  close(rs[0].area, 70 * 60, 1e-9);
  close(rs[1].area, 30 * 60, 1e-9);
  assert.equal(regionAt(rs, [0, 0]), 0);
  assert.equal(regionAt(rs, [30, 10]), 1);
  assert.equal(regionAt(rs, [60, 0]), -1);
  assert.ok(inRegion(regionPoint(rs[1]), rs[1]));

  const ls = sketchRegions(lens());
  // Left moon (with the small circle as a hole), lens, right moon, small disc.
  assert.equal(ls.length, 4);
  const lensArea = 2 * 400 * Math.acos(0.5) - 10 * Math.sqrt(1600 - 400);
  const i = regionAt(ls, [0, 0]);
  close(ls[i].area, lensArea, 2e-2);
  const left = regionAt(ls, [-25, 10]);
  assert.equal(ls[left].holes.length, 1);
  assert.notEqual(regionAt(ls, [-22, 0]), left);
});

test("extrude and revolve selected contours (FR-FT-010)", async () => {
  const m = new Modeller(await occ());
  const ex = (contours?: [number, number][]): Feature => ({ id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 }, ...(contours ? { contours } : {}) });
  const vol = (fs: Feature[]) => {
    const r = m.evaluate(doc(fs));
    const bad = r.statuses.filter(s => !s.ok);
    return { bad, v: r.body ? m.props(r.body).volume : 0, faces: r.body?.faces.length ?? 0 };
  };
  // Without contours the branched sketch is refused, as before.
  assert.ok(vol([crossed(), ex()]).bad.length);
  let r = vol([crossed(), ex([[30, 0]])]);
  assert.deepEqual(r.bad, []);
  close(r.v, 30 * 60 * 10);
  assert.equal(r.faces, 6);
  r = vol([crossed(), ex([[0, 0], [30, 0]])]);
  close(r.v, 100 * 60 * 10);
  // Both regions fuse into one block: the line between them leaves no face.
  assert.equal(r.faces, 6);
  // A pick outside every region says so.
  assert.equal(vol([crossed(), ex([[80, 0]])]).bad[0]?.code, "E-SK-CONTOUR");
  // Lens of two circles; the left moon keeps the small circle as a hole.
  const lensArea = 2 * 400 * Math.acos(0.5) - 10 * Math.sqrt(1600 - 400);
  close(vol([lens(), ex([[0, 0]])]).v, lensArea * 10, 1e-5);
  const moon = 400 * Math.PI - lensArea - 16 * Math.PI;
  close(vol([lens(), ex([[-25, 10]])]).v, moon * 10, 1e-5);
  // A cut through one region of a sketch on top of a block.
  const top = { ...crossed(), id: "s2", name: "Sketch2", plane: { face: { name: "f1:end" } } } as SketchFeature;
  top.ents = top.ents.map(e => ({ ...e, id: `t${e.id}`, ...("a" in e && typeof e.a === "string" ? { a: `t${e.a}`, b: `t${(e as { b: string }).b}` } : {}) })) as SkEnt[];
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "blind", depth: { v: 4 }, contours: [[30, 0]] };
  close(vol([crossed(), ex([[0, 0], [30, 0]]), top, cut]).v, 60000 - 30 * 60 * 4);
  // Revolve one region of the crossed rectangle about the y axis line placed at x = -50 (its left side).
  const rv: Feature = { id: "f1", type: "revolve", name: "Revolve1", sketch: "s1", op: "boss", axis: "l4", angle: { v: 2 * Math.PI }, contours: [[30, 0]] };
  r = vol([crossed(), rv]);
  assert.deepEqual(r.bad, []);
  close(r.v, Math.PI * (100 * 100 - 70 * 70) * 60, 1e-6);
});
