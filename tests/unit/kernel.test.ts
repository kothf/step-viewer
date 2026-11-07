// Kernel acceptance checks (FRS 16.2, AT-P1-2..8) on the feature evaluator, without the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, cx: number, cy: number, w: number, h: number, plane: SketchFeature["plane"] = { std: "XY" }): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", cx - w / 2, cy - h / 2), P("2", cx + w / 2, cy - h / 2), P("3", cx + w / 2, cy + h / 2), P("4", cx - w / 2, cy + h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const circle = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

test("bracket: extrude, cut, fillet and edits keep references (AT-P1-2..7)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  let r = run(m, doc([s1, ex]));
  close(r.props!.volume, 120000);
  assert.equal(r.body!.faces.length, 6);

  const s2 = circle("s2", 0, 0, 5, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  r = run(m, doc([s1, ex, s2, cut]));
  close(r.props!.volume, 120000 - 500 * Math.PI);

  // The four vertical edges: between neighbouring side faces.
  const sides = ["s1l1", "s1l2", "s1l3", "s1l4"].map(e => `f1:side:${e}`);
  const edges = sides.map((s, i) => ({ faces: [s, sides[(i + 1) % 4]] as [string, string] }));
  const fil: Feature = { id: "f3", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges };
  r = run(m, doc([s1, ex, s2, cut, fil]));
  close(r.props!.volume, 118000);

  // Longer block: the fillets follow the same edges.
  const s1b = rect("s1", 0, 0, 120, 60);
  r = run(m, doc([s1b, ex, s2, cut, fil]));
  close(r.props!.volume, 142000);

  // Bigger hole.
  const s2b = circle("s2", 0, 0, 10, { face: { name: "f1:end" } });
  r = run(m, doc([s1b, ex, s2b, cut, fil]));
  close(r.props!.volume, 144000 - 2000 * Math.PI - 80 * (25 - 6.25 * Math.PI));

  // Chamfer on the hole's top edge: between the top face and the hole wall.
  const ch: Feature = { id: "f4", type: "chamfer", name: "Chamfer1", distance: { v: 1 }, edges: [{ faces: ["f1:end", "f2:side:s2k"] }] };
  r = run(m, doc([s1b, ex, s2b, cut, fil, ch]));
  const withChamfer = 144000 - 2000 * Math.PI - 80 * (25 - 6.25 * Math.PI) - 2 * Math.PI * (10 + 1 / 3) * 0.5;
  close(r.props!.volume, withChamfer);

  // Suppressing the hole: the chamfer loses its edge; the rest stays.
  const r2 = m.evaluate(doc([s1b, ex, s2b, { ...cut, suppressed: true } as Feature, fil, ch]));
  assert.equal(r2.statuses.find(s => s.id === "f4")!.ok, false);
  close(m.props(r2.body!).volume, 144000 - 80 * (25 - 6.25 * Math.PI));

  // And back.
  r = run(m, doc([s1b, ex, s2b, cut, fil, ch]));
  close(r.props!.volume, withChamfer);
});

test("revolve a ring (AT-P1-8)", async () => {
  const m = new Modeller(await occ());
  const s = rect("r", 35, 10, 10, 20, { std: "XZ" });
  // Axis: a construction line along the sketch's y (world Z).
  s.ents.push({ id: "ra", t: "point", x: 0, y: 0 }, { id: "rb", t: "point", x: 0, y: 10 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const rev: Feature = { id: "f1", type: "revolve", name: "Revolve1", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } };
  const r = run(m, doc([s, rev]));
  close(r.props!.volume, Math.PI * (40 * 40 - 30 * 30) * 20);
  const mesh = m.mesh(r.body!, "ring", [0.7, 0.7, 0.7]);
  assert.equal(mesh.brep_faces.length, r.body!.faces.length);
  assert.ok(mesh.index.array.length > 0);
});

test("revolve up to a plane, direction 2 and thin revolve (FR-FT-022)", async () => {
  const m = new Modeller(await occ());
  const s = rect("r", 35, 10, 10, 20, { std: "XZ" });
  s.ents.push({ id: "ra", t: "point", x: 0, y: 0 }, { id: "rb", t: "point", x: 0, y: 10 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const ring = Math.PI * (40 * 40 - 30 * 30) * 20;
  const base: Feature = { id: "f1", type: "revolve", name: "Revolve1", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } };
  // Up to the YZ plane (through the Z axis): a quarter turn either way.
  for (const flip of [false, true]) {
    const r = run(m, doc([s, { ...base, end: "upto", upTo: { std: "YZ" }, flip } as Feature]));
    close(r.props!.volume, ring / 4);
  }
  // 90° one way and 45° back.
  let r = run(m, doc([s, { ...base, angle: { v: Math.PI / 2 }, angle2: { v: Math.PI / 4 } } as Feature]));
  close(r.props!.volume, (ring * 3) / 8);
  // A 2 mm wall inside the 10 × 20 profile, a full turn: band area 200 − 6 × 16, centroid at 35.
  r = run(m, doc([s, { ...base, thin: { t: { v: 2 }, mode: "inside" } } as Feature]));
  close(r.props!.volume, 2 * Math.PI * 35 * (200 - 96));
  // XY does not contain the axis.
  const bad = m.evaluate(doc([s, { ...base, end: "upto", upTo: { std: "XY" } } as Feature]));
  assert.equal(bad.statuses.find(x => x.id === "f1")!.code, "E-RV-UPTO");
});

test("freeze bar keeps frozen features' cached result (FR-HIS-024)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 10, 10);
  const ex = (v: number): Feature => ({ id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v } });
  close(run(m, doc([s1, ex(10)])).props!.volume, 1000);
  // Frozen: a new depth is ignored while the cache holds the old shape.
  close(run(m, { ...doc([s1, ex(20)]), freezeAfter: "f1" }).props!.volume, 1000);
  // A feature after the bar still rebuilds on the frozen body.
  const s2 = circle("s2", 0, 0, 2, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  close(run(m, { ...doc([s1, ex(20), s2, cut]), freezeAfter: "f1" }).props!.volume, 1000 - 40 * Math.PI);
  // Unfrozen: everything follows the new depth.
  close(run(m, doc([s1, ex(20), s2, cut])).props!.volume, 2000 - 80 * Math.PI);
});

test("mid-plane extrude and errors", async () => {
  const m = new Modeller(await occ());
  const s = rect("s", 0, 0, 10, 10);
  const r = run(m, doc([s, { id: "f", type: "extrude", name: "E", sketch: "s", op: "boss", end: "mid", depth: { v: 10 } }]));
  close(r.props!.volume, 1000);
  close(r.props!.com[2], 0);
  // Open contour.
  const open = rect("o", 0, 0, 10, 10);
  open.ents = open.ents.filter(e => e.id !== "ol4");
  const bad = m.evaluate(doc([open, { id: "f", type: "extrude", name: "E", sketch: "o", op: "boss", end: "blind", depth: { v: 5 } }]));
  assert.equal(bad.statuses[1].code, "E-SK-OPEN");
});

test("reference planes, up to face, flip side to cut (FR-REF-002, FR-FT-011/016)", async () => {
  const m = new Modeller(await occ());
  const base = rect("s", 0, 0, 40, 20);
  const ex: Feature = { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  // Offset plane 30 mm above Top; a sketch on it extruded up to the block's top face.
  const pl: Feature = { id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 30 } };
  const s2 = circle("c", 0, 0, 5, { plane: "p" });
  const up: Feature = { id: "u", type: "extrude", name: "U", sketch: "c", op: "boss", end: "upto", depth: { v: 1 }, upTo: { face: { name: "e:end" } } };
  let r = run(m, doc([base, ex, pl, s2, up]));
  assert.deepEqual(r.frames.p.o, [0, 0, 30]);
  close(r.props!.volume, 8000 + Math.PI * 25 * 20);
  assert.ok(r.body!.names.includes("u:end") || r.body!.names.some(n => n.startsWith("u:side")));

  // Up to an angled plane: 45° about the block's front top edge (y = -10, z = 10).
  const ang: Feature = { id: "a", type: "plane", name: "Plane2", base: { std: "XY" }, mode: "angle", offset: { v: 0 }, angle: { v: Math.PI / 4 }, axis: { faces: ["e:end", "e:side:sl1"] } };
  const s3 = rect("t", 0, 0, 40, 20, { face: { name: "e:end" } });
  const up2: Feature = { id: "u2", type: "extrude", name: "U2", sketch: "t", op: "boss", end: "upto", depth: { v: 1 }, upTo: { plane: "a" } };
  r = run(m, doc([base, ex, ang, s3, up2]));
  // A wedge 40 long, 20 deep, rising to 20 at the back: 40 * 20 * 20 / 2.
  close(r.props!.volume, 8000 + 8000, 1e-5);

  // Flip side to cut: keep only what is inside a Ø10 cylinder.
  const s4 = circle("h", 0, 0, 5, { face: { name: "e:end" } });
  const keep: Feature = { id: "k", type: "extrude", name: "K", sketch: "h", op: "cut", end: "through", depth: { v: 0 }, outside: true };
  r = run(m, doc([base, ex, s4, keep]));
  close(r.props!.volume, Math.PI * 25 * 10);
});

test("chamfer modes, fillet keep features that fit, principal moments", async () => {
  const m = new Modeller(await occ());
  const s = rect("s", 0, 0, 40, 20);
  const ex: Feature = { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  const edge = { faces: ["e:end", "e:side:sl1"] as [string, string] };
  // Two distances 2 (on the top) and 4 (on the side): the triangle 2 × 4 / 2 along 40 mm.
  const two: Feature = { id: "c", type: "chamfer", name: "C", distance: { v: 2 }, distance2: { v: 4 }, mode: "two", edges: [edge] };
  let r = run(m, doc([s, ex, two]));
  close(r.props!.volume, 8000 - 4 * 40, 1e-6);
  // Distance 3 and 45°: 3 × 3 / 2.
  const da: Feature = { id: "c", type: "chamfer", name: "C", distance: { v: 3 }, angle: { v: Math.PI / 4 }, mode: "angle", edges: [edge] };
  r = run(m, doc([s, ex, da]));
  close(r.props!.volume, 8000 - 4.5 * 40, 1e-6);

  // A 12 mm fillet does not fit the 10 mm high vertical edges... but fits nothing too big; keep what fits.
  const sides = ["sl1", "sl2", "sl3", "sl4"].map(e => `e:side:${e}`);
  const vert = sides.map((a, i) => ({ faces: [a, sides[(i + 1) % 4]] as [string, string] }));
  const fil: Feature = { id: "f", type: "fillet", name: "F", radius: { v: 15 }, edges: [vert[0], edge] };
  const bad = m.evaluate(doc([s, ex, fil]));
  assert.equal(bad.statuses[2].ok, false);
  const fit = m.evaluate(doc([s, ex, { ...fil, keepFit: true } as Feature]));
  assert.equal(fit.statuses[2].ok, true);
  assert.equal(fit.statuses[2].code, "warning");
  close(m.props(fit.body!).volume, 8000 - 10 * 225 * (1 - Math.PI / 4));

  // Box 40 × 20 × 10: principal moments m(b² + c²)/12 with m = volume (density 1).
  r = run(m, doc([s, ex]));
  const V = 8000;
  const mom = [V * (20 * 20 + 10 * 10) / 12, V * (40 * 40 + 10 * 10) / 12, V * (40 * 40 + 20 * 20) / 12].sort((a, b) => a - b);
  r.props!.moments!.forEach((v, i) => close(v, mom[i], 1e-6));
  assert.ok(Math.abs(Math.abs(r.props!.axes![0][0]) - 1) < 1e-9);
});

test("reference axes and points (FR-REF-003, FR-REF-004)", async () => {
  const m = new Modeller(await occ());
  // 100 × 60 × 20 block centred on the origin, with a Ø10 hole at (20, 10) through it.
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const s2 = circle("s2", 20, 10, 5, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 10 } };
  const feats: Feature[] = [s1, ex, s2, cut,
    // Axis along the edge between the +x side and the top: direction ±Y, at x = 50, z = 20.
    { id: "a1", type: "axis", name: "Axis1", mode: "edge", edge: { faces: ["f1:side:s1l2", "f1:end"] } },
    // The hole's axis.
    { id: "a2", type: "axis", name: "Axis2", mode: "cylinder", face: { name: "f2:side:s2k" } },
    // Top (XY) and Right (YZ) meet along Y through the origin.
    { id: "a3", type: "axis", name: "Axis3", mode: "planes", planes: [{ std: "XY" }, { std: "YZ" }] },
    { id: "p1", type: "point", name: "Point1", mode: "centre", edge: { faces: ["f2:side:s2k", "f1:end"] } },
    { id: "p2", type: "point", name: "Point2", mode: "face", face: { name: "f1:end" } },
    { id: "p3", type: "point", name: "Point3", mode: "vertex", edge: { faces: ["f1:side:s1l2", "f1:end"] }, at: [50, 30, 20] },
    { id: "p4", type: "point", name: "Point4", mode: "mid", edge: { faces: ["f1:side:s1l2", "f1:end"] } },
  ];
  const r = run(m, doc(feats));
  const F = r.frames;
  const par = (d: number[], e: number[]) => close(Math.abs(d[0] * e[0] + d[1] * e[1] + d[2] * e[2]), 1);
  par(F.a1.n, [0, 1, 0]); close(F.a1.o[0], 50); close(F.a1.o[2], 20);
  par(F.a2.n, [0, 0, 1]); close(F.a2.o[0], 20); close(F.a2.o[1], 10);
  par(F.a3.n, [0, 1, 0]); assert.ok(Math.hypot(F.a3.o[0], F.a3.o[2]) < 1e-9);
  assert.deepEqual(F.p1.o.map(v => Math.round(v * 1e6) / 1e6), [20, 10, 20]);
  // The top face minus the hole: its centre shifts away from the hole.
  close(F.p2.o[2], 20); assert.ok(F.p2.o[0] < 0 && F.p2.o[1] < 0);
  assert.deepEqual(F.p3.o.map(v => Math.round(v * 1e6) / 1e6), [50, 30, 20]);
  assert.deepEqual(F.p4.o.map(v => Math.round(v * 1e6) / 1e6), [50, 0, 20]);
  // Parallel planes do not meet.
  const bad = m.evaluate(doc([...feats, { id: "a4", type: "axis", name: "Axis4", mode: "planes", planes: [{ std: "XY" }, { plane: "a1x" }] } as Feature]));
  assert.equal(bad.statuses.at(-1)!.ok, false);
});

test("reference coordinate systems (FR-REF-005)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const edge = { faces: ["f1:side:s1l2", "f1:end"] };
  const feats: Feature[] = [s1, ex,
    { id: "c0", type: "csys", name: "Coordinate system1" },
    // At the corner (50, 30, 20); Z the top face's normal, X along the +x top edge (±Y), reversed.
    { id: "c1", type: "csys", name: "Coordinate system2", origin: { edge, at: [50, 30, 20] }, z: { face: { name: "f1:end" } }, x: { edge }, flipX: true },
    { id: "p1", type: "point", name: "Point1", mode: "mid", edge },
    { id: "c2", type: "csys", name: "Coordinate system3", origin: { point: "p1" }, z: { edge }, flipZ: true },
  ];
  const r = run(m, doc(feats));
  const F = r.frames;
  const R = (v: number[]) => v.map(x => Math.round(x * 1e6) / 1e6 + 0);
  assert.deepEqual(R(F.c0.o), [0, 0, 0]); assert.deepEqual(R(F.c0.x), [1, 0, 0]); assert.deepEqual(R(F.c0.n), [0, 0, 1]); assert.deepEqual(R(F.c0.y), [0, 1, 0]);
  assert.deepEqual(R(F.c1.o), [50, 30, 20]); assert.deepEqual(R(F.c1.n), [0, 0, 1]);
  close(Math.abs(F.c1.x[1]), 1);
  // Right-handed: y = z × x.
  const c = F.c1, cr = [c.n[1] * c.x[2] - c.n[2] * c.x[1], c.n[2] * c.x[0] - c.n[0] * c.x[2], c.n[0] * c.x[1] - c.n[1] * c.x[0]];
  assert.deepEqual(R(c.y), R(cr));
  assert.deepEqual(R(F.c2.o), [50, 0, 20]); close(Math.abs(F.c2.n[1]), 1);
  // Flipping X turns it round.
  const r2 = run(m, doc(feats.map(f => (f.id === "c1" ? { ...f, flipX: false } : f)) as Feature[]));
  close(r2.frames.c1.x[1], -F.c1.x[1]);
  // X along Z: an error.
  const bad = m.evaluate(doc([s1, ex, { id: "c3", type: "csys", name: "Coordinate system4", z: { edge }, x: { edge } } as Feature]));
  assert.equal(bad.statuses.at(-1)!.ok, false);
});

test("shell, mirror, linear and circular patterns (FR-FT-060, 070-072, 075)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  // Shell 2 mm, open at the top: 120000 − 96·56·18.
  const sh: Feature = { id: "f2", type: "shell", name: "Shell1", thickness: { v: 2 }, faces: [{ name: "f1:end" }] };
  let r = run(m, doc([s1, ex, sh]));
  close(r.props!.volume, 120000 - 96 * 56 * 18, 1e-6);
  assert.ok(r.body!.names.some(n => n.startsWith("f2:off:")), r.body!.names.join());

  // A hole near a corner, patterned 4 × along X at 20 mm and 2 × along Y at 30 mm.
  const s2 = circle("s2", -40, -15, 4, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f3", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  const hole = 16 * Math.PI * 20;
  const lp: Feature = { id: "f4", type: "lpattern", name: "LPattern1", features: ["f3"], dir: { edge: { faces: ["f1:side:s1l1", "f1:end"] } }, spacing: { v: 20 }, count: 4, dir2: { edge: { faces: ["f1:side:s1l2", "f1:end"] } }, spacing2: { v: 30 }, count2: 2 };
  r = run(m, doc([s1, ex, s2, cut, lp]));
  close(r.props!.volume, 120000 - 8 * hole, 1e-6);
  // Skip one; one more column falls off the part (warning, not an error).
  r = run(m, doc([s1, ex, s2, cut, { ...lp, skip: ["1,1"], count: 6 } as Feature]));
  close(r.props!.volume, 120000 - 9 * hole, 1e-6);
  assert.equal(r.statuses.at(-1)!.code, "warning");

  // Mirror the hole about the YZ plane, then the whole body about its end face (a 40 mm tall block).
  const mi: Feature = { id: "f5", type: "mirror", name: "Mirror1", plane: { std: "YZ" }, features: ["f3"] };
  r = run(m, doc([s1, ex, s2, cut, mi]));
  close(r.props!.volume, 120000 - 2 * hole, 1e-6);
  const mb: Feature = { id: "f6", type: "mirror", name: "Mirror2", plane: { face: { name: "f1:end" } }, features: [] };
  r = run(m, doc([s1, ex, mb]));
  close(r.props!.volume, 240000, 1e-6);

  // Circular pattern: 6 holes on a 20 mm radius around a central boss's axis.
  const s3 = circle("s3", 0, 0, 30, { std: "XY" });
  const disc: Feature = { id: "g1", type: "extrude", name: "Extrude1", sketch: "s3", op: "boss", end: "blind", depth: { v: 10 } };
  const s4 = circle("s4", 20, 0, 3, { face: { name: "g1:end" } });
  const c2: Feature = { id: "g2", type: "extrude", name: "Cut1", sketch: "s4", op: "cut", end: "through", depth: { v: 0 } };
  const cp: Feature = { id: "g3", type: "cpattern", name: "CirPattern1", features: ["g2"], axis: { face: { name: "g1:side:s3k" } }, count: 6, angle: { v: 2 * Math.PI }, equal: true };
  r = run(m, doc([s3, disc, s4, c2, cp]));
  close(r.props!.volume, 900 * Math.PI * 10 - 6 * 9 * Math.PI * 10, 1e-6);
});

test("hole wizard: simple, counterbore, countersink, tapped; patterned (FR-FT-050..052)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const top = { face: { name: "f1:end" } };
  // Two through holes Ø6.6: 120000 − 2·π·3.3²·20.
  const h1: Feature = { id: "h1", type: "hole", name: "Hole1", plane: top, pts: [[-30, 0], [30, 0]], kind: "simple", diameter: { v: 6.6 }, end: "through", depth: { v: 0 } };
  let r = run(m, doc([s1, ex, h1]));
  close(r.props!.volume, 120000 - 2 * Math.PI * 3.3 ** 2 * 20, 1e-6);
  // Counterbore Ø11 × 6.4 over a through Ø6.6.
  const cb: Feature = { ...h1, kind: "cbore", pts: [[0, 0]], cbDia: { v: 11 }, cbDepth: { v: 6.4 } } as Feature;
  r = run(m, doc([s1, ex, cb]));
  close(r.props!.volume, 120000 - Math.PI * (5.5 ** 2 * 6.4 + 3.3 ** 2 * 13.6), 1e-6);
  // Countersink Ø13.44 at 90°: a cone frustum from r 6.72 down to 3.3 over 3.42 mm.
  const cs: Feature = { ...h1, kind: "csink", pts: [[0, 0]], csDia: { v: 13.44 }, csAngle: { v: Math.PI / 2 } } as Feature;
  r = run(m, doc([s1, ex, cs]));
  const hh = 6.72 - 3.3;
  close(r.props!.volume, 120000 - Math.PI * (hh / 3 * (6.72 ** 2 + 6.72 * 3.3 + 3.3 ** 2) + 3.3 ** 2 * (20 - hh)), 1e-6);
  // Blind tapped M6 hole, 12 deep with a 118° point; then a linear pattern of it.
  const tp: Feature = { id: "h1", type: "hole", name: "Hole1", plane: top, pts: [[0, 0]], kind: "tapped", size: "M6", diameter: { v: 5 }, end: "blind", depth: { v: 12 }, threadDepth: { v: 10 }, major: 6, pitch: 1 };
  r = run(m, doc([s1, ex, tp]));
  const tip = 2.5 / Math.tan((59 * Math.PI) / 180);
  close(r.props!.volume, 120000 - Math.PI * 2.5 ** 2 * (12 + tip / 3), 1e-6);
  assert.ok(r.frames.h1, "the hole's plane frame");
  const lp: Feature = { id: "p1", type: "lpattern", name: "LPattern1", features: ["h1"], dir: { edge: { faces: ["f1:side:s1l1", "f1:end"] } }, spacing: { v: 20 }, count: 3 };
  r = run(m, doc([s1, ex, tp, lp]));
  close(r.props!.volume, 120000 - 3 * Math.PI * 2.5 ** 2 * (12 + tip / 3), 1e-6);
});

test("draft tapers faces about a neutral plane (FR-FT-061)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const deg = Math.PI / 180;
  // One 100 mm side, 5° about the bottom: a wedge of 100 · ½ · 20 · 20·tan 5° comes off (or goes on, flipped).
  const wedge = 100 * 0.5 * 20 * 20 * Math.tan(5 * deg);
  const dr: Feature = { id: "f2", type: "draft", name: "Draft1", plane: { std: "XY" }, faces: [{ name: "f1:side:s1l1" }], angle: { v: 5 * deg } };
  let r = run(m, doc([s1, ex, dr]));
  const v1 = r.props!.volume;
  close(Math.abs(120000 - v1), wedge, 1e-4);
  assert.ok(r.body!.names.includes("f1:side:s1l1"), r.body!.names.join());
  r = run(m, doc([s1, ex, { ...dr, flip: true } as Feature]));
  close(r.props!.volume - 120000, 120000 - v1, 1e-4);
  // All four sides.
  r = run(m, doc([s1, ex, { ...dr, faces: ["s1l1", "s1l2", "s1l3", "s1l4"].map(l => ({ name: `f1:side:${l}` })) } as Feature]));
  assert.ok(Math.abs(120000 - r.props!.volume) > 2 * wedge);
  // A face parallel to the neutral plane can't be drafted.
  const bad = m.evaluate(doc([s1, ex, { ...dr, faces: [{ name: "f1:end" }] } as Feature]));
  assert.equal(bad.statuses.at(-1)!.ok, false);
});


test("DXF gasket sketch extrudes with its holes (AT-P2-5)", async () => {
  const { readDxf } = await import("../../src/sketch/dxf");
  const { readFileSync } = await import("node:fs");
  const m = new Modeller(await occ());
  const ents: SkEnt[] = [];
  const pts = new Map<string, string>();
  let k = 0;
  const point = (q: [number, number]) => {
    const key = `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)}`;
    let id = pts.get(key);
    if (!id) { id = `p${k++}`; ents.push({ id, t: "point", x: q[0], y: q[1] }); pts.set(key, id); }
    return id;
  };
  for (const s of readDxf(readFileSync("tests/fixtures/dxf/gasket.dxf", "utf8")).shapes) {
    if (s.t === "line") ents.push({ id: `e${k++}`, t: "line", a: point(s.a), b: point(s.b) });
    else if (s.t === "circle") ents.push({ id: `e${k++}`, t: "circle", c: point(s.c), r: s.r });
    else { const at = (a: number): [number, number] => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]; ents.push({ id: `e${k++}`, t: "arc", c: point(s.c), a: point(at(s.a0)), b: point(at(s.a1)) }); }
  }
  const sk: SketchFeature = { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents, rels: [], dims: [] };
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } };
  const r = run(m, doc([sk, ex]));
  close(r.props!.volume, (3900 + 25 * Math.PI - 32 * Math.PI) * 10, 1e-6);
});

test("extrude: offset from surface, through all both, thin walls, draft (FR-FT-012/014/015)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const base: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  // Offset from surface: 5 mm short of a plane 30 mm up.
  const pl: Feature = { id: "pl", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 30 } };
  let r = run(m, doc([pl, s1, { ...base, end: "offset", upTo: { plane: "pl" }, upToOffset: { v: 5 } } as Feature]));
  close(r.props!.volume, 6000 * 25, 1e-6);
  r = run(m, doc([pl, s1, { ...base, end: "offset", upTo: { plane: "pl" }, upToOffset: { v: 5 }, reverseOffset: true } as Feature]));
  close(r.props!.volume, 6000 * 35, 1e-6);
  // Through all both: a ⌀10 hole from a sketch on a mid plane cuts the whole height.
  const mid: Feature = { id: "pm", type: "plane", name: "Plane2", base: { std: "XY" }, mode: "offset", offset: { v: 10 } };
  const s2 = circle("s2", 0, 0, 5, { plane: "pm" });
  const cut: Feature = { id: "c1", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  r = run(m, doc([s1, base, mid, s2, cut]));
  close(r.props!.volume, 120000 - Math.PI * 25 * 10, 1e-6);
  r = run(m, doc([s1, base, mid, s2, { ...cut, end: "through2" } as Feature]));
  close(r.props!.volume, 120000 - Math.PI * 25 * 20, 1e-6);
  // Thin walls 2 mm: inside (sharp inner corners), outside (round outer corners), centred.
  r = run(m, doc([s1, { ...base, thin: { t: { v: 2 }, mode: "inside" } } as Feature]));
  close(r.props!.volume, (6000 - 96 * 56) * 20, 1e-6);
  r = run(m, doc([s1, { ...base, thin: { t: { v: 2 }, mode: "outside" } } as Feature]));
  close(r.props!.volume, (640 + 4 * Math.PI) * 20, 1e-6);
  r = run(m, doc([s1, { ...base, thin: { t: { v: 2 }, mode: "mid" } } as Feature]));
  close(r.props!.volume, (636 + Math.PI) * 20, 1e-6);
  // Draft 5° inward: ∫ (100 − 2z·tan a)(60 − 2z·tan a) dz over 0..20.
  const ta = Math.tan(5 * Math.PI / 180);
  const frustum = 6000 * 20 - 160 * ta * 20 * 20 + 4 * ta * ta * 20 ** 3 / 3;
  r = run(m, doc([s1, { ...base, draft: { angle: { v: 5 * Math.PI / 180 } } } as Feature]));
  close(r.props!.volume, frustum, 1e-6);
  r = run(m, doc([s1, { ...base, draft: { angle: { v: 5 * Math.PI / 180 }, outward: true } } as Feature]));
  close(r.props!.volume, 6000 * 20 + 160 * ta * 20 * 20 + 4 * ta * ta * 20 ** 3 / 3, 1e-6);
});

test("ellipse and elliptical arc extrude (FR-SK-018)", async () => {
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  // Full ellipse 30 × 10 at 30°, extruded 5.
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const el: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [],
    ents: [P("c", 0, 0), P("a", 30 * c, 30 * s), P("b", -10 * s, 10 * c), { id: "e", t: "ellipse", c: "c", a: "a", b: "b" }] };
  const ex: Feature = { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 5 } };
  let r = run(m, doc([el, ex]));
  close(r.props!.volume, Math.PI * 30 * 10 * 5, 1e-4);
  // Taller than wide: the minor point further out than the major one still works.
  const tall: SketchFeature = { ...el, ents: [P("c", 0, 0), P("a", 10, 0), P("b", 0, 25), { id: "e", t: "ellipse", c: "c", a: "a", b: "b" }] };
  r = run(m, doc([tall, ex]));
  close(r.props!.volume, Math.PI * 10 * 25 * 5, 1e-4);
  // Half ellipse: arc from (20,0) ccw to (-20,0) over the top, closed by a line.
  const half: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [],
    ents: [P("c", 0, 0), P("a", 20, 0), P("b", 0, 8), P("s", 20, 0), P("t", -20, 0),
      { id: "e", t: "ellipse", c: "c", a: "a", b: "b", p0: "s", p1: "t" }, { id: "l", t: "line", a: "t", b: "s" }] };
  r = run(m, doc([half, ex]));
  close(r.props!.volume, (Math.PI * 20 * 8 * 5) / 2, 1e-4);
  assert.equal(r.body!.faces.length, 4);
});

test("spline profiles extrude as one exact B-spline face (FR-SK-019)", async () => {
  const { splineBezier, bezPts } = await import("../../src/sketch/spline");
  const { polyArea } = await import("../../src/sketch/profile");
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const xy: [number, number][] = [[0, 0], [30, -5], [45, 15], [20, 30], [-5, 18]];
  // Interpolation passes through every point, and joins are smooth.
  const bz = splineBezier(xy, true);
  assert.equal(bz.length, 3 * xy.length + 1);
  xy.forEach((q, i) => { close(bz[3 * i][0], q[0]); close(bz[3 * i][1], q[1]); });
  for (let i = 3; i < bz.length - 1; i += 3) {
    const u = [bz[i][0] - bz[i - 1][0], bz[i][1] - bz[i - 1][1]], v = [bz[i + 1][0] - bz[i][0], bz[i + 1][1] - bz[i][1]];
    assert.ok(Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * (1 + Math.hypot(...u) * Math.hypot(...v)));
  }
  const area = Math.abs(polyArea(bezPts(bz, 2000).slice(0, -1)));
  const closed: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [],
    ents: [...xy.map((q, i) => P(`p${i}`, q[0], q[1])), { id: "sp", t: "spline", pts: xy.map((_, i) => `p${i}`), closed: true }] };
  const ex: Feature = { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 4 } };
  let r = run(m, doc([closed, ex]));
  close(r.props!.volume, area * 4, 1e-5);
  assert.equal(r.body!.faces.length, 3);
  // Open spline closed by a line.
  const open: SketchFeature = { ...closed, ents: [...xy.map((q, i) => P(`p${i}`, q[0], q[1])), { id: "sp", t: "spline", pts: xy.map((_, i) => `p${i}`) }, { id: "l", t: "line", a: "p4", b: "p0" }] };
  const area2 = Math.abs(polyArea(bezPts(splineBezier(xy), 2000)));
  r = run(m, doc([open, ex]));
  close(r.props!.volume, area2 * 4, 5e-4); // OCCT's default integration of the planar face along a B-spline edge is ~2e-4 off
  assert.equal(r.body!.faces.length, 4);
});

test("modelled thread cuts a helical groove into a hole (FR-FT-055)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 40, 40);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const s2 = circle("s2", 0, 0, 2.5, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  const base = run(m, doc([s1, ex, s2, cut]));
  const edge = { faces: ["f1:end", "f2:side:s2k"] as [string, string] };
  const th: Feature = { id: "t", type: "thread", name: "Thread1", edge, size: "M6", pitch: 1, diameter: { v: 6 }, length: { v: 10 }, upToEnd: true, internal: true, modelled: true };
  const t0 = performance.now();
  const r = run(m, doc([s1, ex, s2, cut, th]));
  const ms = performance.now() - t0;
  const removed = base.props!.volume - r.props!.volume;
  // Groove section in the material: a 60° V 0.5 deep (0.144 mm²) round a mean radius of 2.67, per mm of a 1 mm pitch.
  const perMm = 0.5 * 0.5 * 2 * 0.5 * Math.tan(Math.PI / 6) * 2 * Math.PI * (2.5 + 0.5 / 3);
  assert.ok(removed > perMm * 20 * 0.85 && removed < perMm * 21 * 1.1, `removed ${removed} for ${perMm * 20}`);
  // A set length cuts less.
  const short = run(m, doc([s1, ex, s2, cut, { ...th, upToEnd: false, length: { v: 8 } } as Feature]));
  const rs = base.props!.volume - short.props!.volume;
  assert.ok(rs > perMm * 8 * 0.85 && rs < perMm * 9 * 1.15, `short ${rs}`);
  console.log(`thread: ${removed.toFixed(2)} mm³ in ${ms.toFixed(0)} ms`);
});

test("extrude: up to next, up to vertex and start from (FR-FT-012/013)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const pl: Feature = { id: "pl", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 50 } };
  const s2 = circle("s2", 0, 0, 5, { plane: "pl" });
  const boss = (o: object): Feature => ({ id: "f2", type: "extrude", name: "Boss", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 }, ...o } as Feature);
  // Up to next: from 50 down to the block's top at 20.
  let r = run(m, doc([s1, ex, pl, s2, boss({ end: "next", flip: true })]));
  close(r.props!.volume, 120000 + Math.PI * 25 * 30, 1e-6);
  // Pointing away from the block: nothing in the way.
  let bad = m.evaluate(doc([s1, ex, pl, s2, boss({ end: "next" })])).statuses.find(x => x.id === "f2")!;
  assert.equal(bad.ok, false);
  // Up to vertex: a bottom corner of the block (z = 0), toward it whatever the direction.
  const corner = { edge: { faces: ["f1:side:s1l1", "f1:side:s1l2"] as [string, string] }, at: [50, -30, 0] as [number, number, number] };
  r = run(m, doc([s1, ex, pl, s2, boss({ end: "vertex", upToVertex: corner })]));
  close(r.props!.volume, 120000 + Math.PI * 25 * 30, 1e-6);
  // The same through a reference point at that corner.
  const pt: Feature = { id: "pt", type: "point", name: "Point1", mode: "vertex", edge: corner.edge, at: corner.at };
  r = run(m, doc([s1, ex, pt, pl, s2, boss({ end: "vertex", upToVertex: { point: "pt" } })]));
  close(r.props!.volume, 120000 + Math.PI * 25 * 30, 1e-6);
  // Start from: offset 10 (z 10..30), a plane at 50 (50..70), the block's top vertex (20..40).
  r = run(m, doc([s1, { ...ex, start: "offset", startOffset: { v: 10 } } as Feature]));
  close(r.props!.volume, 120000, 1e-6); close(r.props!.com[2], 20, 1e-6);
  r = run(m, doc([pl, s1, { ...ex, start: "surface", startRef: { plane: "pl" } } as Feature]));
  close(r.props!.com[2], 60, 1e-6);
  r = run(m, doc([s1, ex, rect("s3", 200, 0, 10, 10), { ...ex, id: "f3", sketch: "s3", start: "vertex", startVertex: { ...corner, at: [50, -30, 20] } } as Feature]));
  close(r.props!.volume, 120000 + 2000, 1e-6);
  // Up to next cut: a slab floating above the block; a cut from its top stops at its bottom.
  const pt2: Feature = { id: "p2", type: "plane", name: "Plane2", base: { std: "XY" }, mode: "offset", offset: { v: 30 } };
  const s4 = rect("s4", 0, 0, 100, 60, { plane: "p2" });
  const slab: Feature = { id: "f4", type: "extrude", name: "Slab", sketch: "s4", op: "boss", end: "blind", depth: { v: 10 } };
  const s5 = circle("s5", 0, 0, 5, { face: { name: "f4:end" } });
  const cut: Feature = { id: "f5", type: "extrude", name: "Cut", sketch: "s5", op: "cut", end: "next", depth: { v: 1 } };
  r = run(m, doc([s1, ex, pt2, s4, slab, s5, cut]));
  close(r.props!.volume, 120000 + 60000 - Math.PI * 25 * 10, 1e-6);
  // Starting inside the body: no gap up to the next face.
  const s6 = circle("s6", 0, 0, 5, { plane: { std: "XY" } });
  bad = m.evaluate(doc([s1, ex, s6, { id: "f6", type: "extrude", name: "B", sketch: "s6", op: "boss", end: "next", depth: { v: 1 } } as Feature])).statuses.find(x => x.id === "f6")!;
  assert.equal(bad.ok, false);
});

test("multiple radius fillet: each edge its own radius (FR-FT-031)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const sides = ["s1l1", "s1l2", "s1l3"].map(e => `f1:side:${e}`);
  const edges = [{ faces: [sides[0], sides[1]] as [string, string], r: 10 }, { faces: [sides[1], sides[2]] as [string, string] }];
  const corner = (r: number) => r * r * (1 - Math.PI / 4) * 20;
  let r = run(m, doc([s1, ex, { id: "f2", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges, multi: true } as Feature]));
  close(r.props!.volume, 120000 - corner(10) - corner(5), 1e-6);
  // Off: every edge takes the feature's radius again.
  r = run(m, doc([s1, ex, { id: "f2", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges } as Feature]));
  close(r.props!.volume, 120000 - 2 * corner(5), 1e-6);
});

test("converted curves follow their model edge and dangle when it is gone (FR-SK-064)", async () => {
  const m = new Modeller(await occ());
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const s2 = circle("s2", 0, 0, 5, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  // A boss on the hole's top edge (converted circle, drawn too small) and a line on the block's right top edge (drawn off).
  const s3: SketchFeature = {
    id: "s3", type: "sketch", name: "Sketch3", plane: { face: { name: "f1:end" } }, dims: [],
    ents: [
      { id: "c0", t: "point", x: 0, y: 0 }, { id: "c", t: "circle", c: "c0", r: 3 },
      { id: "q1", t: "point", x: 40, y: -10 }, { id: "q2", t: "point", x: 40, y: 10 }, { id: "ln", t: "line", a: "q1", b: "q2", cons: true },
    ],
    rels: [
      { id: "r1", t: "fix", e: ["c"], ext: { faces: ["f1:end", "f2:side:s2k"] } },
      { id: "r2", t: "fix", e: ["ln"], ext: { faces: ["f1:end", "f1:side:s1l2"] } },
    ],
  };
  const boss: Feature = { id: "f3", type: "extrude", name: "Boss", sketch: "s3", op: "boss", end: "blind", depth: { v: 5 } };
  let r = run(m, doc([rect("s1", 0, 0, 100, 60), ex, s2, cut, s3, boss]));
  const moved = r.sketches.s3;
  assert.ok(moved, "the sketch follows the model");
  const circ = moved.ents.find(e => e.id === "c") as SkEnt & { t: "circle" };
  close(circ.r, 5);
  const pts = moved.ents.filter(e => e.id === "q1" || e.id === "q2") as (SkEnt & { t: "point" })[];
  for (const p of pts) close(Math.abs(p.x), 50);
  close(Math.abs(pts[0].y - pts[1].y), 60);
  // The boss uses the moved circle: it fills the hole's top with a 5 mm cylinder of radius 5.
  close(r.props!.volume, 120000 - 500 * Math.PI + 125 * Math.PI);
  assert.ok(!moved.rels.some(x => x.dangling));

  // Wider block: the line moves with its edge.
  r = run(m, doc([rect("s1", 0, 0, 140, 60), ex, s2, cut, s3, boss]));
  for (const p of r.sketches.s3.ents.filter(e => e.id === "q1" || e.id === "q2") as (SkEnt & { t: "point" })[]) close(Math.abs(p.x), 70);

  // The edge is gone (no hole any more): dangling, the circle stays, and the sketch warns.
  const noHole = structuredClone(s3);
  noHole.rels[0].ext = { faces: ["f1:end", "f9:side:x"] };
  r = run(m, doc([rect("s1", 0, 0, 100, 60), ex, noHole, boss]));
  const dg = r.sketches.s3;
  assert.equal(dg.rels.find(x => x.id === "r1")!.dangling, true);
  assert.ok(!dg.rels.find(x => x.id === "r2")!.dangling);
  close((dg.ents.find(e => e.id === "c") as SkEnt & { t: "circle" }).r, 3);
  const st = r.statuses.find(s => s.id === "s3")!;
  assert.equal(st.code, "warning");
  // Evaluated again from the moved sketch: nothing more to change (no rebuild loop).
  const again = m.evaluate(doc([rect("s1", 0, 0, 100, 60), ex, dg, boss]));
  assert.equal(again.sketches.s3, undefined);
});

test("helix and circular-profile sweep: a spring (AT-P3-1, FR-FT-081/083)", async () => {
  const m = new Modeller(await occ());
  const s1 = circle("s1", 0, 0, 10, { std: "XY" });
  const hx: Feature = { id: "h1", type: "helix", name: "Helix1", sketch: "s1", mode: "pitchRev", pitch: { v: 5 }, revs: { v: 10 }, height: { v: 50 } };
  const sw: Feature = { id: "w1", type: "sweep", name: "Sweep1", op: "boss", circular: { v: 2 }, path: { helix: "h1" } };
  const r = run(m, doc([s1, hx, sw]));
  const L = 10 * Math.hypot(2 * Math.PI * 10, 5);
  close(r.props!.volume, Math.PI * L, 1e-4);
  // The helix curve for the view: starts on the circle, ends 50 mm up.
  const pts = r.curves.h1;
  close(Math.hypot(pts[0][0], pts[0][1]), 10);
  close(pts.at(-1)![2], 50);
  // Height and revolutions, reversed, with taper: ends 30 mm down, wider.
  const hx2: Feature = { ...hx, mode: "heightRev", height: { v: 30 }, revs: { v: 3 }, reverse: true, taper: { v: (5 * Math.PI) / 180 } };
  const r2 = m.evaluate(doc([s1, hx2]));
  const end = r2.curves.h1.at(-1)!;
  close(end[2], -30);
  close(Math.hypot(end[0], end[1]), 10 + 30 * Math.tan((5 * Math.PI) / 180), 1e-6);
});

test("loft between a square and a circle (AT-P3-2, FR-FT-082)", async () => {
  const m = new Modeller(await occ());
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 50 } };
  const sq = rect("s1", 0, 0, 40, 40);
  const ci = circle("s2", 0, 0, 15, { plane: "p1" });
  const lf: Feature = { id: "l1", type: "loft", name: "Loft1", op: "boss", profiles: ["s1", "s2"] };
  const r = run(m, doc([sq, pl, ci, lf]));
  const v = r.props!.volume;
  // Between the frustum-like bounds: more than the cylinder of the circle, less than the square prism.
  assert.ok(v > Math.PI * 225 * 50 && v < 1600 * 50, `${v}`);
  assert.ok(r.body!.names.includes("l1:start") && r.body!.names.includes("l1:end"), r.body!.names.join());
  // Ruled loft: straight sections, a cut through it removes material.
  const ruled: Feature = { ...lf, ruled: true };
  run(m, doc([sq, pl, ci, ruled]));
});

test("sweep a profile along a sketch path, boss and cut (FR-FT-080)", async () => {
  const m = new Modeller(await occ());
  // Path on Front (XZ): a line up 40 then a quarter arc R20; profile: a 6×4 rectangle on Top at the path start.
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const path: SketchFeature = { id: "ps", type: "sketch", name: "Path", plane: { std: "XZ" }, rels: [], dims: [], ents: [
    P("a", 0, 0), P("b", 0, 40), P("c", 20, 40), P("d", 20, 60),
    { id: "pl", t: "line", a: "a", b: "b" }, { id: "pa", t: "arc", c: "c", a: "d", b: "b" },
  ] };
  const prof = rect("pr", 0, 0, 6, 4);
  const sw: Feature = { id: "w1", type: "sweep", name: "Sweep1", op: "boss", profile: "pr", path: { sketch: "ps" } };
  const r = run(m, doc([path, prof, sw]));
  const L = 40 + (Math.PI / 2) * 20;
  close(r.props!.volume, 24 * L, 1e-3);
  assert.ok(r.body!.names.some(n => n.startsWith("w1:side:prl")), r.body!.names.join());
  // Keep normal constant along a straight path is the same prism.
  const straight: SketchFeature = { ...path, ents: [P("a", 0, 0), P("b", 0, 40), { id: "pl", t: "line", a: "a", b: "b" }] };
  const r2 = run(m, doc([straight, prof, { ...sw, orient: "normal" } as Feature]));
  close(r2.props!.volume, 24 * 40, 1e-6);
  // A circular cut swept through a block.
  const blk = rect("b", 0, 0, 30, 30);
  const ex: Feature = { id: "e", type: "extrude", name: "E", sketch: "b", op: "boss", end: "blind", depth: { v: 30 } };
  const cut: Feature = { id: "w2", type: "sweep", name: "Cut-Sweep1", op: "cut", circular: { v: 4 }, path: { sketch: "ps" } };
  const r3 = run(m, doc([blk, ex, straight, cut]));
  close(r3.props!.volume, 27000 - Math.PI * 4 * 30, 1e-4);
});

test("rib: parallel to sketch fills an L bracket's corner, normal to sketch spans a channel (FR-FT-062)", async () => {
  const m = new Modeller(await occ());
  const line = (id: string, plane: SketchFeature["plane"], a: [number, number], b: [number, number]): SketchFeature => ({
    id, type: "sketch", name: id, plane, rels: [], dims: [],
    ents: [{ id: `${id}a`, t: "point", x: a[0], y: a[1] }, { id: `${id}b`, t: "point", x: b[0], y: b[1] }, { id: `${id}l`, t: "line", a: `${id}a`, b: `${id}b` }],
  });
  const base: Feature[] = [
    rect("b", 0, 0, 100, 60), { id: "bx", type: "extrude", name: "Base", sketch: "b", op: "boss", end: "blind", depth: { v: 10 } },
    rect("w", -45, 0, 10, 60), { id: "wx", type: "extrude", name: "Wall", sketch: "w", op: "boss", end: "blind", depth: { v: 60 } },
  ];
  // Diagonal from the wall (x = -40, z = 50) to the base (x = 40, z = 10): a 80 × 40 triangle, 4 thick.
  const r1 = run(m, doc([...base, line("r", { std: "XZ" }, [-40, 50], [40, 10]), { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side: "mid", dir: "parallel" }]));
  close(r1.props!.volume, 90000 + 6400);
  // One side: the same volume, all of it on one side of the sketch plane.
  const r2 = run(m, doc([...base, line("r", { std: "XZ" }, [-40, 50], [40, 10]), { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side: "one", dir: "parallel" }]));
  close(r2.props!.volume, 90000 + 6400);
  // Flip with nowhere to go the other way still finds the body.
  const r3 = run(m, doc([...base, line("r", { std: "XZ" }, [-40, 50], [40, 10]), { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side: "mid", dir: "parallel", flip: true }]));
  close(r3.props!.volume, 90000 + 6400);
  // A channel: walls at both ends; a line across the top, run down to the floor: 80 × 50 × 4.
  const chan: Feature[] = [...base, rect("w2", 45, 0, 10, 60), { id: "w2x", type: "extrude", name: "Wall2", sketch: "w2", op: "boss", end: "blind", depth: { v: 60 } },
    { id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 60 } }];
  const r4 = run(m, doc([...chan, line("r", { plane: "p" }, [-45, 0], [45, 0]), { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side: "mid", dir: "normal" }]));
  close(r4.props!.volume, 120000 + 16000);
  // A bent chain on one side or the other: n × the start direction is "one" (the inside of this bend).
  const bent = (side: "one" | "other"): SketchFeature[] | Feature[] => [...chan, {
    id: "r", type: "sketch", name: "r", plane: { plane: "p" }, rels: [], dims: [],
    ents: [{ id: "ra", t: "point", x: -45, y: 0 }, { id: "rb0", t: "point", x: 0, y: 0 }, { id: "rc", t: "point", x: 0, y: 20 },
      { id: "rl1", t: "line", a: "ra", b: "rb0" }, { id: "rl2", t: "line", a: "rb0", b: "rc" }],
  }, { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side, dir: "normal" }];
  close(run(m, doc(bent("one") as Feature[])).props!.volume, 120000 + (40 * 4 + 20 * 4 - 16) * 50);
  close(run(m, doc(bent("other") as Feature[])).props!.volume, 120000 + (44 * 4 + 24 * 4 - 16) * 50);
  // A closed sketch is refused.
  const bad = m.evaluate(doc([...base, rect("q", 0, 0, 10, 10, { std: "XZ" }), { id: "rb", type: "rib", name: "Rib1", sketch: "q", thickness: { v: 4 }, side: "mid", dir: "parallel" }]));
  assert.equal(bad.statuses.find(s => s.id === "rb")?.code, "E-RIB-OPEN");
});
