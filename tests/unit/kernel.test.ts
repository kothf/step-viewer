// Kernel acceptance checks (FRS 16.2, AT-P1-2..8) on the feature evaluator, without the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, FilletFeature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
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

test("split line: a projected circle splits the top and bottom faces, or only the picked one (FR-FT-084)", async () => {
  const m = new Modeller(await occ());
  const base: Feature[] = [rect("s", 0, 0, 40, 40), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } },
    { id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 30 } }, circle("c", 0, 0, 5, { plane: "p" })];
  const all = run(m, doc([...base, { id: "sp", type: "split", name: "Split Line1", sketch: "c", faces: [] }]));
  close(all.props!.volume, 32000);
  assert.equal(all.body!.faces.length, 8);
  assert.equal(all.body!.names.filter(n => n === "x:end").length, 2);
  const one = run(m, doc([...base, { id: "sp", type: "split", name: "Split Line1", sketch: "c", faces: [{ name: "x:end" }] }]));
  assert.equal(one.body!.faces.length, 7);
  close(one.props!.volume, 32000);
  // A sketch that misses the part is an error.
  const miss = m.evaluate(doc([...base.slice(0, 3), circle("c", 100, 0, 5, { plane: "p" }), { id: "sp", type: "split", name: "Split Line1", sketch: "c", faces: [] }]));
  assert.equal(miss.statuses.find(s => s.id === "sp")?.code, "E-SPL-MISS");
});

test("multibody: new body, split by a plane and combine back (AT-P3-3), subtract, delete, move and copy (FRS 9.10)", async () => {
  const m = new Modeller(await occ());
  const box: Feature[] = [rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }];
  // Split at x = 5 (a plane through the Right plane offset 5): two bodies, volume kept.
  const pl: Feature = { id: "p", type: "plane", name: "Plane1", base: { std: "YZ" }, mode: "offset", offset: { v: 5 } };
  const sp: Feature = { id: "b", type: "bsplit", name: "Split1", plane: { plane: "p" }, bodies: [] };
  const r1 = run(m, doc([...box, pl, sp]));
  close(r1.props!.volume, 8000);
  assert.equal(r1.props!.bodies, 2);
  // Combine them back (add): one body, same volume.
  const left = { name: "x:side:sl4" }, right = { name: "x:side:sl2" };
  const r2 = run(m, doc([...box, pl, sp, { id: "c", type: "combine", name: "Combine1", op: "add", main: left, tools: [right] }]));
  close(r2.props!.volume, 8000);
  assert.equal(r2.props!.bodies, 1);
  // A boss that does not merge is a second body, even where it overlaps; subtract it from the first.
  const cyl: Feature[] = [circle("k", 20, 0, 5, { face: { name: "x:end" } }), { id: "e", type: "extrude", name: "Extrude2", sketch: "k", op: "boss", end: "blind", depth: { v: 10 }, merge: false }];
  const r3 = run(m, doc([...box, ...cyl]));
  assert.equal(r3.props!.bodies, 2);
  close(r3.props!.volume, 8000 + Math.PI * 250);
  const r4 = run(m, doc([...box, ...cyl, { id: "c", type: "combine", name: "Combine1", op: "subtract", main: { name: "x:start" }, tools: [{ name: "e:end" }] }]));
  assert.equal(r4.props!.bodies, 1);
  close(r4.props!.volume, 8000);
  // Delete the cylinder body; keep only it.
  close(run(m, doc([...box, ...cyl, { id: "d", type: "delbody", name: "Body-Delete/Keep1", bodies: [{ name: "e:end" }] }])).props!.volume, 8000);
  close(run(m, doc([...box, ...cyl, { id: "d", type: "delbody", name: "Body-Delete/Keep1", bodies: [{ name: "e:end" }], keep: true }])).props!.volume, Math.PI * 250);
  // Move the box 100 along x: names hold, so a later feature still finds its end face; copy doubles it.
  const mv = run(m, doc([...box, { id: "mv", type: "movebody", name: "Body-Move/Copy1", bodies: [{ name: "x:end" }], dx: { v: 100 }, dy: { v: 0 }, dz: { v: 0 } },
    circle("k2", 100, 0, 3, { face: { name: "x:end" } }), { id: "h", type: "extrude", name: "Cut1", sketch: "k2", op: "cut", end: "blind", depth: { v: 4 } }]));
  close(mv.props!.volume, 8000 - Math.PI * 36);
  close(mv.props!.com[0], 100, 1e-3);
  const cp = run(m, doc([...box, { id: "mv", type: "movebody", name: "Body-Move/Copy1", bodies: [{ name: "x:end" }], copy: true, dx: { v: 0 }, dy: { v: 50 }, dz: { v: 0 } }]));
  assert.equal(cp.props!.bodies, 2);
  close(cp.props!.volume, 16000);
});

test("variable radius fillet: an edge going from 1 to 4 mm (FR-FT-032)", async () => {
  const m = new Modeller(await occ());
  const box: Feature[] = [rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }];
  const edge = { faces: ["x:side:sl1", "x:side:sl2"] as [string, string] };
  const vol = (f: Partial<FilletFeature>) => run(m, doc([...box, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 1 }, edges: [edge], ...f } as Feature])).props!.volume;
  const full = 8000;
  // A linear radius r(z) from 1 at the bottom to 4 at the top: (1 - π/4)·∫r² dz = (1 - π/4)·10·(1 + 4 + 16)/3.
  const up = full - vol({ variable: true, edges: [{ ...edge, r: 1, r2: 4, at: [20, -10, 0] }] });
  const down = full - vol({ variable: true, edges: [{ ...edge, r: 1, r2: 4, at: [20, -10, 10] }] });
  const want = (1 - Math.PI / 4) * 70;
  assert.ok(Math.abs(up - want) / want < 0.03, `${up} vs ${want}`);
  assert.ok(Math.abs(down - want) / want < 0.03, `${down} vs ${want}`);
  // Constant 1 and 4 bound it.
  assert.ok(up > (1 - Math.PI / 4) * 10 && up < (1 - Math.PI / 4) * 160);
});

test("imported body with a gap: check and heal reports it and closes it (FR-FT-130/131, AT-P3-4)", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  // A 10 mm cube as six loose faces, the top one 0.02 mm too high: a shell with a gap.
  const P = (x: number, y: number, z: number) => new oc.gp_Pnt_3(x, y, z);
  const quad = (a: number[][]) => {
    const w = new oc.BRepBuilderAPI_MakePolygon_4(P(a[0][0], a[0][1], a[0][2]), P(a[1][0], a[1][1], a[1][2]), P(a[2][0], a[2][1], a[2][2]), P(a[3][0], a[3][1], a[3][2]), true).Wire();
    return new oc.BRepBuilderAPI_MakeFace_15(w, true).Face();
  };
  const z1 = 10.02;
  const quads = [
    [[0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]], [[0, 0, z1], [10, 0, z1], [10, 10, z1], [0, 10, z1]],
    [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], [[0, 10, 0], [0, 10, 10], [10, 10, 10], [10, 10, 0]],
    [[0, 0, 0], [0, 0, 10], [0, 10, 10], [0, 10, 0]], [[10, 0, 0], [10, 10, 0], [10, 10, 10], [10, 0, 10]],
  ];
  const comp = new oc.TopoDS_Compound(), b = new oc.BRep_Builder();
  b.MakeCompound(comp);
  for (const q of quads) b.Add(comp, quad(q));
  oc.BRepTools.Write_4(comp, "/gap.brep", false, false, oc.TopTools_FormatVersion.TopTools_FormatVersion_CURRENT, new oc.Message_ProgressRange_1());
  const brep = oc.FS.readFile("/gap.brep", { encoding: "utf8" });
  const imp = (heal: boolean): Feature => ({ id: "i", type: "import", name: "Imported1", file: "gap.brep", brep, heal, tol: { v: 0.1 } });
  // As read: faces only, no volume.
  const raw = m.evaluate(doc([imp(false)]));
  assert.equal(raw.body!.faces.length, 6);
  // Healed: the report names the gap, then one closed valid solid of ~1000 mm³.
  const r = m.evaluate(doc([imp(true)]));
  const st = r.statuses.find(s => s.id === "i")!;
  assert.equal(st.code, "warning");
  const mm = st.warning!.match(/^Check and heal: (\d+) free edges before, (\d+) after; (valid|not valid) before, (valid|not valid) after; (\d+) solid bodies\.$/);
  assert.ok(mm, st.warning);
  assert.ok(+mm![1] > 0 && +mm![2] === 0 && mm![4] === "valid" && mm![5] === "1", st.warning);
  close(m.props(r.body!).volume, 1000, 0.01);
  // A cut on the healed body works.
  const cut = run(m, doc([imp(true), circle("k", 5, 5, 2, { std: "XY" }), { id: "c", type: "extrude", name: "Cut1", sketch: "k", op: "cut", end: "through", depth: { v: 1 }, flip: true }]));
  assert.ok(cut.props!.volume < 1000 - Math.PI * 4 * 9);
});

test("full round fillet: a 4 mm wall's top becomes a half cylinder tangent to both sides (FR-FT-032)", async () => {
  const m = new Modeller(await occ());
  const wall: Feature[] = [rect("s", 0, 0, 40, 4), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }];
  const r = run(m, doc([...wall, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 1 }, edges: [], kind: "full", faces1: [{ name: "x:side:sl1" }], center: [{ name: "x:end" }], faces2: [{ name: "x:side:sl3" }] } as Feature]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  // Removed: the 4×2 strip on top minus the half disc of radius 2, along 40 mm.
  close(r.props!.volume, 40 * 4 * 10 - (8 - 2 * Math.PI) * 40, 1e-4);
  assert.ok(r.body!.names.some(n => n.startsWith("f:round:")));
  assert.ok(!r.body!.names.includes("x:end"));
  // Sides that are not parallel are refused.
  const bad = m.evaluate(doc([...wall, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 1 }, edges: [], kind: "full", faces1: [{ name: "x:side:sl1" }], center: [{ name: "x:end" }], faces2: [{ name: "x:side:sl2" }] } as Feature]));
  assert.equal(bad.statuses[2].code, "E-FT-FULLROUND");
});

test("face fillet: rounds where the top face meets the side faces (FR-FT-032)", async () => {
  const m = new Modeller(await occ());
  const box: Feature[] = [rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }];
  const r = run(m, doc([...box, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 2 }, edges: [], kind: "face", faces1: [{ name: "x:end" }], faces2: [{ name: "x:side:sl1" }, { name: "x:side:sl3" }] } as Feature]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  close(r.props!.volume, 8000 - (1 - Math.PI / 4) * 4 * 40 * 2, 1e-4);
  assert.equal(r.body!.names.filter(n => n.startsWith("f:fillet:")).length, 2);
  const apart = m.evaluate( doc([...box, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 2 }, edges: [], kind: "face", faces1: [{ name: "x:end" }], faces2: [{ name: "x:start" }] } as Feature]));
  assert.equal(apart.statuses[2].code, "E-FT-FACESETS");
});

test("scale: uniform about the origin, per axis about the centroid (FR-BODY-006)", async () => {
  const m = new Modeller(await occ());
  const box: Feature[] = [rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }];
  const u = run(m, doc([...box, { id: "k", type: "scale", name: "Scale1", bodies: [], about: "origin", factor: { v: 2 } } as Feature]));
  close(u.props!.volume, 64000, 1e-6);
  close(u.props!.com[2], 10, 1e-6);
  assert.ok(u.body!.names.includes("x:end"));
  const a = run(m, doc([...box, { id: "k", type: "scale", name: "Scale1", bodies: [{ name: "x:end" }], about: "centroid", axes: true, factor: { v: 1 }, fx: { v: 0.5 }, fy: { v: 1 }, fz: { v: 3 } } as Feature]));
  close(a.props!.volume, 8000 * 1.5, 1e-6);
  close(a.props!.com[2], 5, 1e-6);
  const z = m.evaluate( doc([...box, { id: "k", type: "scale", name: "Scale1", bodies: [], about: "origin", factor: { v: 0 } } as Feature]));
  assert.equal(z.statuses[2].code, "E-BDY-SCALE");
});

test("bodies folder: keys by the feature that made each body, stable through later features (FR-BODY-001)", async () => {
  const m = new Modeller(await occ());
  const base: Feature[] = [rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } },
    circle("k", 40, 0, 5, { std: "XY" }), { id: "e", type: "extrude", name: "Extrude2", sketch: "k", op: "boss", end: "blind", depth: { v: 10 }, merge: false }];
  const d = doc(base);
  const a = m.evaluate(d);
  const info = m.bodyInfo(a.body!, d);
  assert.deepEqual(info.map(b => b.key), ["x", "e"]);
  close(info[0].volume, 8000);
  close(info[1].volume, Math.PI * 250, 1e-4);
  // A fillet on the box keeps its key; a copy of the cylinder is a body made by the Move/Copy.
  const more = doc([...base, { id: "f", type: "fillet", name: "Fillet1", radius: { v: 2 }, edges: [{ faces: ["x:side:sl1", "x:side:sl2"] }] } as Feature,
    { id: "mv", type: "movebody", name: "Body-Move/Copy1", bodies: [{ name: "e:side:kk" }], copy: true, dx: { v: 0 }, dy: { v: 30 }, dz: { v: 0 } } as Feature]);
  const b = m.evaluate(more);
  assert.deepEqual(b.statuses.filter(s => !s.ok), []);
  assert.deepEqual(m.bodyInfo(b.body!, more).map(x => x.key), ["x", "e", "mv"]);
});

test("insert part: another part's result as BREP text goes in as a body (FR-BODY-005)", async () => {
  const m = new Modeller(await occ());
  const other = doc([rect("s", 0, 0, 40, 20), { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }]);
  const r = m.evaluate(other);
  const text = new Modeller(await occ()).brepText(r.body!);
  assert.equal(text.solids, 1);
  assert.equal(text.faces, 6);
  const here = doc([circle("k", 0, 0, 5, { std: "XY" }), { id: "c", type: "extrude", name: "Extrude1", sketch: "k", op: "boss", end: "blind", depth: { v: 30 } },
    { id: "i", type: "import", name: "Imported1", file: "plate.mcadprt", brep: text.brep } as Feature]);
  const out = run(m, here);
  assert.equal(out.props!.bodies, 2);
  close(out.props!.volume, 8000 + Math.PI * 25 * 30, 1e-6);
});

test("direct editing: move face out and in, delete face heals (FR-FT-101)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  // Top face out 5 mm, then a side face in 10 mm: 100·60·25, then 90·60·25.
  const up: Feature = { id: "f2", type: "moveface", name: "MoveFace1", faces: [{ name: "f1:end" }], distance: { v: 5 } };
  let r = run(m, doc([s1, ex, up]));
  close(r.props!.volume, 150000);
  assert.ok(r.body!.names.includes("f1:end"), r.body!.names.join());
  // The new side faces merge into the old ones: still a plain block of 6 faces.
  assert.equal(r.body!.faces.length, 6, r.body!.names.join());
  const side: Feature = { id: "f3", type: "moveface", name: "MoveFace2", faces: [{ name: "f1:side:s1l2" }], distance: { v: 10 }, flip: true };
  r = run(m, doc([s1, ex, up, side]));
  close(r.props!.volume, 135000);
  assert.ok(r.body!.names.includes("f1:side:s1l2"));
  // A blind pocket in the top; deleting its floor and walls fills it again.
  const s2 = rect("s2", 0, 0, 20, 10, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f4", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "blind", depth: { v: 5 } };
  r = run(m, doc([s1, ex, s2, cut]));
  close(r.props!.volume, 120000 - 1000);
  const pocket = r.body!.names.filter(n => n.startsWith("f4:"));
  assert.ok(pocket.length >= 5, pocket.join());
  const del: Feature = { id: "f5", type: "delface", name: "DeleteFace1", faces: pocket.map(name => ({ name })) };
  r = run(m, doc([s1, ex, s2, cut, del]));
  close(r.props!.volume, 120000, 1e-6);
});

test("surfaces: planar, extruded, offset, knit and thicken (FR-FT-100)", async () => {
  const m = new Modeller(await occ());
  // A 40×20 planar surface thickened 3 mm up: a 2400 mm³ plate; the surface is used up.
  const s1 = rect("s1", 0, 0, 40, 20);
  const ps: Feature = { id: "f1", type: "planesurf", name: "Surface-Plane1", sketch: "s1" };
  let r = run(m, doc([s1, ps]));
  assert.equal(r.body, null);
  assert.deepEqual(r.sheets!.names, ["f1:face:0"]);
  const th: Feature = { id: "f2", type: "thicken", name: "Thicken1", surface: { name: "f1:face:0" }, thickness: { v: 3 }, side: "one" };
  r = run(m, doc([s1, ps, th]));
  close(r.props!.volume, 2400, 1e-4);
  assert.equal(r.sheets, null);
  assert.ok(r.body!.names.includes("f1:face:0"), r.body!.names.join());
  // Both sides: centred on the surface.
  r = run(m, doc([s1, ps, { ...th, side: "both" } as Feature]));
  close(r.props!.volume, 2400, 1e-4);
  close(r.props!.com[2], 0, 1e-6);
  // The rectangle extruded as a surface: an open tube of four sheets, sewn into one surface body.
  const es: Feature = { id: "f3", type: "extsurf", name: "Surface-Extrude1", sketch: "s1", depth: { v: 10 } };
  r = run(m, doc([s1, es]));
  assert.equal(r.sheets!.faces.length, 4);
  assert.ok(r.sheets!.names.includes("f3:side:s1l2"), r.sheets!.names.join());
  // Caps: a planar surface at the bottom, an offset copy 10 mm up; knitting the three closes a 40×20×10 box.
  const off: Feature = { id: "f4", type: "offsurf", name: "Surface-Offset1", faces: [{ name: "f1:face:0" }], distance: { v: 10 } };
  r = run(m, doc([s1, es, ps, off]));
  assert.equal(r.sheets!.faces.length, 6, r.sheets!.names.join());
  assert.ok(r.sheets!.names.includes("f4:off:f1:face:0"), r.sheets!.names.join());
  const kn: Feature = { id: "f5", type: "knit", name: "Surface-Knit1", surfaces: [{ name: "f3:side:s1l1" }, { name: "f1:face:0" }, { name: "f4:off:f1:face:0" }], tol: { v: 0.01 }, solid: true };
  r = run(m, doc([s1, es, ps, off, kn]));
  close(r.props!.volume, 8000, 1e-6);
  assert.equal(r.sheets, null);
  assert.equal(r.props!.bodies, 1);
  // Without "solid", the knit is one closed surface body and no solid.
  r = run(m, doc([s1, es, ps, off, { ...kn, solid: false } as Feature]));
  assert.equal(r.body, null);
  assert.equal(r.sheets!.faces.length, 6);
  // Offset faces of a solid: a copy of its top 5 mm above.
  const ex: Feature = { id: "f6", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } };
  const off2: Feature = { id: "f7", type: "offsurf", name: "Surface-Offset2", faces: [{ name: "f6:end" }], distance: { v: 5 } };
  r = run(m, doc([s1, ex, off2]));
  close(r.props!.volume, 8000, 1e-6);
  assert.deepEqual(r.sheets!.names, ["f7:off:f6:end"]);
});

test("move face: translate and rotate (FR-FT-101)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  // Translate the top by (7, 0, 5): only the 5 mm along its normal counts.
  const tr: Feature = { id: "f2", type: "moveface", name: "MoveFace1", faces: [{ name: "f1:end" }], distance: { v: 0 }, mode: "translate", dx: { v: 7 }, dy: { v: 0 }, dz: { v: -5 } };
  let r = run(m, doc([s1, ex, tr]));
  close(r.props!.volume, 100 * 60 * 15);
  assert.ok(r.body!.names.includes("f1:end"));
  // Rotate the top 10° about its edge on the y = -30 side: a wedge of 100 · 60² · tan10° / 2 added.
  const rot: Feature = { id: "f3", type: "moveface", name: "MoveFace2", faces: [{ name: "f1:end" }], distance: { v: 0 }, mode: "rotate", axis: { edge: { faces: ["f1:end", "f1:side:s1l1"] } }, angle: { v: Math.PI / 18 } };
  r = run(m, doc([s1, ex, rot]));
  close(r.props!.volume, 120000 + 100 * 3600 * Math.tan(Math.PI / 18) / 2, 1e-5);
  r = run(m, doc([s1, ex, { ...rot, flip: true } as Feature]));
  close(r.props!.volume, 120000 - 100 * 3600 * Math.tan(Math.PI / 18) / 2, 1e-5);
  assert.ok(r.body!.names.includes("f1:end"));
});

test("replace face with a surface (FR-FT-101)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const pl = (z: number): Feature => ({ id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: z } } as Feature);
  const s2 = rect("s2", 0, 0, 300, 300, { plane: "p1" });
  const ps: Feature = { id: "f2", type: "planesurf", name: "Surface-Plane1", sketch: "s2" };
  const rf: Feature = { id: "f3", type: "replaceface", name: "ReplaceFace1", faces: [{ name: "f1:end" }], surface: { name: "f2:face:0" } };
  // A flat surface 5 mm above the top: the body grows to it; 5 mm below: it shrinks.
  let r = run(m, doc([s1, ex, pl(25), s2, ps, rf]));
  close(r.props!.volume, 100 * 60 * 25, 1e-6);
  assert.equal(r.body!.faces.length, 6, r.body!.names.join());
  assert.ok(r.body!.names.includes("f1:end"));
  r = run(m, doc([s1, ex, pl(15), s2, ps, rf]));
  close(r.props!.volume, 100 * 60 * 15, 1e-6);
  // A sloping surface (z = 20 + x/10, an extruded line on the front plane): same volume, a tilted top.
  const s3: SketchFeature = { id: "s3", type: "sketch", name: "s3", plane: { std: "XZ" }, rels: [], dims: [], ents: [{ id: "a", t: "point", x: -100, y: 10 }, { id: "b", t: "point", x: 100, y: 30 }, { id: "l", t: "line", a: "a", b: "b" }] };
  const es: Feature = { id: "f4", type: "extsurf", name: "Surface-Extrude1", sketch: "s3", depth: { v: 200 }, mid: true };
  r = run(m, doc([s1, ex, s3, es, { ...rf, surface: { name: "f4:side:l" } } as Feature]));
  close(r.props!.volume, 120000, 1e-6);
  assert.equal(r.body!.faces.length, 6, r.body!.names.join());
});

test("surfaces: revolve, loft, trim; delete face to a surface (FR-FT-100/101)", async () => {
  const m = new Modeller(await occ());
  const area = (n: { shape: unknown; faces: unknown[]; names: string[] }) => m.props(n as never).area;
  // A line 10 mm off a vertical axis, revolved: a cylinder surface 2π·10·20.
  const s1: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XZ" }, rels: [], dims: [], ents: [
    { id: "a0", t: "point", x: 0, y: -5 }, { id: "a1", t: "point", x: 0, y: 30 }, { id: "ax", t: "line", a: "a0", b: "a1", cons: true },
    { id: "b0", t: "point", x: 10, y: 0 }, { id: "b1", t: "point", x: 10, y: 20 }, { id: "l", t: "line", a: "b0", b: "b1" }] };
  const rv: Feature = { id: "f1", type: "revsurf", name: "Surface-Revolve1", sketch: "s1", axis: "ax", angle: { v: 2 * Math.PI } };
  let r = run(m, doc([s1, rv]));
  close(area(r.sheets!), 2 * Math.PI * 10 * 20, 1e-6);
  assert.ok(r.sheets!.names.every(n => n === "f1:side:l"), r.sheets!.names.join());
  // Half a turn: half the area.
  r = run(m, doc([s1, { ...rv, angle: { v: Math.PI } } as Feature]));
  close(area(r.sheets!), Math.PI * 10 * 20, 1e-6);
  // Loft through two open lines 10 mm apart: a 20 × 10 strip.
  const line = (id: string, plane: SketchFeature["plane"]): SketchFeature => ({ id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [{ id: `${id}a`, t: "point", x: -10, y: 0 }, { id: `${id}b`, t: "point", x: 10, y: 0 }, { id: `${id}l`, t: "line", a: `${id}a`, b: `${id}b` }] });
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 10 } } as Feature;
  const lf: Feature = { id: "f2", type: "loftsurf", name: "Surface-Loft1", profiles: ["k1", "k2"] };
  r = run(m, doc([line("k1", { std: "XY" }), pl, line("k2", { plane: "p1" }), lf]));
  close(area(r.sheets!), 200, 1e-6);
  assert.ok(r.sheets!.names.includes("f2:side:k1l"), r.sheets!.names.join());
  // A 40 × 20 planar surface trimmed by the right plane (x = 0), keeping the +x half.
  const s2 = rect("s2", 0, 0, 40, 20);
  const ps: Feature = { id: "f3", type: "planesurf", name: "Surface-Plane1", sketch: "s2" };
  const tr: Feature = { id: "f4", type: "trimsurf", name: "Surface-Trim1", surface: { name: "f3:face:0" }, tool: { plane: { std: "YZ" } }, keep: [{ name: "f3:face:0", hint: [10, 0, 0] }] };
  r = run(m, doc([s2, ps, tr]));
  close(area(r.sheets!), 400, 1e-6);
  assert.ok(r.sheets!.faces.every(g => (m as never as { centroid(f: unknown): number[] }).centroid(g)[0] > 0));
  // Keeping the other side.
  r = run(m, doc([s2, ps, { ...tr, keep: [{ name: "f3:face:0", hint: [-10, 0, 0] }] } as Feature]));
  assert.ok(r.sheets!.faces.every(g => (m as never as { centroid(f: unknown): number[] }).centroid(g)[0] < 0));
  // Delete face, "delete": a block without its top is an open surface body of the other five faces.
  const s3 = rect("s3", 0, 0, 100, 60);
  const ex: Feature = { id: "f5", type: "extrude", name: "Extrude1", sketch: "s3", op: "boss", end: "blind", depth: { v: 20 } };
  const del: Feature = { id: "f6", type: "delface", name: "DeleteFace1", faces: [{ name: "f5:end" }], mode: "delete" };
  r = run(m, doc([s3, ex, del]));
  assert.equal(r.body, null);
  assert.equal(r.sheets!.faces.length, 5);
  close(area(r.sheets!), 6000 + 2 * 160 * 20, 1e-6);
  // A later feature reuses the cached steps: the deleted solid must stay gone.
  r = run(m, doc([s3, ex, del, { id: "f7", type: "planesurf", name: "Surface-Plane1", sketch: "s3" } as Feature]));
  assert.equal(r.body, null);
});

test("surfaces: fill openings and extend (FR-FT-100)", async () => {
  const m = new Modeller(await occ());
  const area = (n: { shape: unknown; faces: unknown[]; names: string[] }) => m.props(n as never).area;
  // An open 40×20×10 tube; filling both ends and knitting with Create solid gives the 8000 mm³ box.
  const s1 = rect("s1", 0, 0, 40, 20);
  const es: Feature = { id: "f1", type: "extsurf", name: "Surface-Extrude1", sketch: "s1", depth: { v: 10 } };
  const fb: Feature = { id: "f2", type: "fillsurf", name: "Surface-Fill1", surface: { name: "f1:side:s1l1" }, at: [0, 0, 0] };
  let r = run(m, doc([s1, es, fb]));
  assert.equal(r.sheets!.faces.length, 5, r.sheets!.names.join());
  close(area(r.sheets!), 2 * 60 * 10 + 800, 1e-3);
  const ft: Feature = { id: "f3", type: "fillsurf", name: "Surface-Fill2", surface: { name: "f1:side:s1l1" }, at: [0, 0, 10] };
  const kn: Feature = { id: "f4", type: "knit", name: "Surface-Knit1", surfaces: [{ name: "f1:side:s1l1" }], tol: { v: 0.01 }, solid: true };
  r = run(m, doc([s1, es, fb, ft, kn]));
  close(r.props!.volume, 8000, 1e-3);
  // A 40×20 planar surface extended 5 mm all round: 50 × 30.
  const ps: Feature = { id: "f5", type: "planesurf", name: "Surface-Plane1", sketch: "s1" };
  const ext: Feature = { id: "f6", type: "extendsurf", name: "Surface-Extend1", surface: { name: "f5:face:0" }, distance: { v: 5 } };
  r = run(m, doc([s1, ps, ext]));
  close(area(r.sheets!), 1500, 1e-6);
  assert.deepEqual(r.sheets!.names, ["f5:face:0"]);
});

test("3D curves through XYZ points, composite and projected, as sweep paths; swept surface (FR-FT-085, FR-FT-100)", async () => {
  const m = new Modeller(await occ());
  const len = (pts: number[][]) => pts.reduce((s, q, i) => i ? s + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1], q[2] - pts[i - 1][2]) : 0, 0);
  // Through XYZ points: collinear points give a straight curve; a circular profile swept along it is a cylinder.
  const xyz: Feature = { id: "c1", type: "curve", name: "Curve1", kind: "xyz", pts: [[0, 0, 0], [0, 0, 10], [0, 0, 20], [0, 0, 30]] };
  let r = run(m, doc([xyz, { id: "w1", type: "sweep", name: "Sweep1", op: "boss", circular: { v: 4 }, path: { curve: "c1" } }]));
  close(r.props!.volume, Math.PI * 4 * 30, 1e-6);
  // Eight points on a circle of radius 20, closed: the smooth curve is nearly the circle.
  const ring = Array.from({ length: 8 }, (_, k) => [20 * Math.cos(k * Math.PI / 4), 20 * Math.sin(k * Math.PI / 4), 5]);
  r = run(m, doc([{ ...xyz, pts: ring, closed: true } as Feature]));
  close(len(r.curves.c1), 2 * Math.PI * 20, 5e-3);
  // Composite: the four top edges of a 30 mm cube make a closed square of 120 mm.
  const cube: Feature[] = [rect("b", 0, 0, 30, 30), { id: "e", type: "extrude", name: "E", sketch: "b", op: "boss", end: "blind", depth: { v: 30 } }];
  const edges = ["bl1", "bl2", "bl3", "bl4"].map(l => ({ faces: [`e:side:${l}`, "e:end"] as [string, string] }));
  r = run(m, doc([...cube, { id: "c2", type: "curve", name: "Curve2", kind: "composite", edges }]));
  close(len(r.curves.c2), 120, 1e-6);
  // Two edges that do not touch cannot be joined.
  const bad = m.evaluate(doc([...cube, { id: "c2", type: "curve", name: "Curve2", kind: "composite", edges: [edges[0], edges[2]] }]));
  assert.equal(bad.statuses.find(s => s.id === "c2")?.code, "E-CRV-JOIN");
  // Projected: a 20 mm line on a plane 50 above the base, projected down onto the cube's top (the bottom is further).
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 50 } } as Feature;
  const ln: SketchFeature = { id: "k", type: "sketch", name: "K", plane: { plane: "p1" }, rels: [], dims: [], ents: [{ id: "ka", t: "point", x: -10, y: 0 }, { id: "kb", t: "point", x: 10, y: 5 }, { id: "kl", t: "line", a: "ka", b: "kb" }] };
  const pc: Feature = { id: "c3", type: "curve", name: "Curve3", kind: "projected", sketch: "k", flip: true };
  r = run(m, doc([...cube, pl, ln, pc]));
  close(len(r.curves.c3), Math.hypot(20, 5), 1e-6);
  assert.ok(r.curves.c3.every(q => Math.abs(q[2] - 30) < 1e-6), JSON.stringify(r.curves.c3.slice(0, 2)));
  // Looking up first finds nothing in front of the sketch, so it looks down: the same curve.
  r = run(m, doc([...cube, pl, ln, { ...pc, flip: false } as Feature]));
  assert.ok(r.curves.c3.every(q => Math.abs(q[2] - 30) < 1e-6));
  // A sketch beside the cube projects onto nothing.
  const off: SketchFeature = { ...ln, ents: [{ id: "ka", t: "point", x: 40, y: 0 }, { id: "kb", t: "point", x: 60, y: 5 }, { id: "kl", t: "line", a: "ka", b: "kb" }] };
  const miss = m.evaluate(doc([...cube, pl, off, pc]));
  assert.equal(miss.statuses.find(s => s.id === "c3")?.code, "E-CRV-MISS");
  // Swept surface: an open 10 mm line on Top swept 30 up the straight curve: a 300 mm² strip named after the line.
  const prof: SketchFeature = { id: "sp", type: "sketch", name: "SP", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "sa", t: "point", x: -5, y: 0 }, { id: "sb", t: "point", x: 5, y: 0 }, { id: "sl", t: "line", a: "sa", b: "sb" }] };
  r = run(m, doc([prof, xyz, { id: "s1", type: "sweepsurf", name: "Surface-Sweep1", profile: "sp", path: { curve: "c1" } }]));
  const props = (m as never as { props(b: unknown): { area: number } });
  close(props.props(r.sheets!).area, 300, 1e-6);
  assert.ok(r.sheets!.names.every(n => n === "s1:side:sl"), r.sheets!.names.join());
});

test("3D sketch as a sweep path (FR-SK-080)", async () => {
  const m = new Modeller(await occ());
  // An L: 30 along X then 20 up Z; a Ø4 circular sweep along it.
  const k: Feature = { id: "k", type: "sketch3d", name: "3DSketch1", pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [30, 0, 0] }, { id: "C", p: [30, 0, 20] }],
    segs: [{ id: "l2", t: "line", pts: ["C", "B"] }, { id: "l1", t: "line", pts: ["A", "B"] }], rels: [], dims: [] };
  const sw: Feature = { id: "w", type: "sweep", name: "Sweep1", op: "boss", circular: { v: 4 }, path: { curve: "k" } };
  const r = run(m, doc([k, sw]));
  // Two cylinders meeting at a mitred corner: 4π·50 exactly (the mitre adds and removes the same).
  close(r.props!.volume, Math.PI * 4 * 50, 1e-3);
  // A branched sketch is not a path.
  const br = m.evaluate(doc([{ ...k, pts: [...(k as { pts: unknown[] }).pts, { id: "D", p: [30, 10, 0] }], segs: [...(k as { segs: unknown[] }).segs, { id: "l3", t: "line", pts: ["B", "D"] }] } as Feature, sw]));
  assert.equal(br.statuses.find(s => s.id === "w")?.code, "E-SWP-PATH");
});

test("Sweep twist and guide curve, loft centreline, variable pitch helix (FR-FT-080, FR-FT-082, FR-FT-083)", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const bbox = (shape: unknown) => {
    const b = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, b, false);
    const lo = b.CornerMin(), hi = b.CornerMax();
    return [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()];
  };
  const line: Feature = { id: "c1", type: "curve", name: "Curve1", kind: "xyz", pts: [[0, 0, 0], [0, 0, 30]] };
  // A 10 mm square swept 30 up with a 45° twist: same volume as the prism, but the top corner reaches 5√2.
  const sq = rect("s", 0, 0, 10, 10);
  let r = run(m, doc([sq, line, { id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "s", path: { curve: "c1" }, twist: { v: Math.PI / 4 } } as Feature]));
  close(r.props!.volume, 3000, 2e-3);
  close(bbox(r.body!.shape)[3], 5 * Math.SQRT2, 2e-3);
  // No twist: the plain prism.
  r = run(m, doc([sq, line, { id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "s", path: { curve: "c1" } } as Feature]));
  close(bbox(r.body!.shape)[3], 5, 1e-6);
  // Guide curve: a Ø10 circle up a 50 mm line, its edge led out to radius 10 by a straight guide: a frustum.
  const c = circle("k", 0, 0, 5, { std: "XY" });
  const path: Feature = { id: "c1", type: "curve", name: "Curve1", kind: "xyz", pts: [[0, 0, 0], [0, 0, 50]] };
  const guide: Feature = { id: "g1", type: "curve", name: "Curve2", kind: "xyz", pts: [[5, 0, 0], [10, 0, 50]] };
  r = run(m, doc([c, path, guide, { id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "k", path: { curve: "c1" }, guide: { curve: "g1" } } as Feature]));
  close(r.props!.volume, (Math.PI * 50 / 3) * (25 + 50 + 100), 5e-3);
  // A square profile follows a guide off its corner too: 10 → 20 mm over 30, a square frustum.
  r = run(m, doc([sq, line, { ...guide, pts: [[5, 5, 0], [10, 10, 30]] } as Feature, { id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "s", path: { curve: "c1" }, guide: { curve: "g1" } } as Feature]));
  close(r.props!.volume, 7000, 2e-3);
  // A guide that starts on the path cannot scale the profile.
  const onPath = m.evaluate(doc([sq, line, { ...guide, pts: [[0, 0, 0], [10, 10, 30]] } as Feature, { id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "s", path: { curve: "c1" }, guide: { curve: "g1" } } as Feature]));
  assert.equal(onPath.statuses.find(s => s.id === "w")?.code, "E-SWP-GUIDE");
  // Loft along a centreline from a 10 mm square to a 20 mm square 30 up: a square frustum, 7000 mm³.
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 30 } } as Feature;
  const big = rect("t", 0, 0, 20, 20, { plane: "p1" });
  r = run(m, doc([sq, pl, big, line, { id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["s", "t"], centerline: { curve: "c1" } } as Feature]));
  close(r.props!.volume, 7000, 2e-3);
  // Variable pitch: constant rows match the plain helix's 4 turns; pitch 2 → 6 over 20 mm turns ln 3 / 0.2 times.
  const turns = (pts: number[][]) => { let a = 0; for (let i = 1; i < pts.length; i++) { let d = Math.atan2(pts[i][1], pts[i][0]) - Math.atan2(pts[i - 1][1], pts[i - 1][0]); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; a += d; } return a / (2 * Math.PI); };
  const hc = circle("h", 0, 0, 10, { std: "XY" });
  const hx = (vpitch: [number, number, number][]): Feature => ({ id: "x", type: "helix", name: "Helix1", sketch: "h", mode: "pitchRev", pitch: { v: 5 }, revs: { v: 4 }, height: { v: 20 }, vpitch: vpitch.map(([h, p, d]) => ({ h: { v: h }, p: { v: p }, d: { v: d } })) } as Feature);
  r = run(m, doc([hc, hx([[0, 5, 20], [20, 5, 20]])]));
  close(turns(r.curves.x), 4, 1e-6);
  r = run(m, doc([hc, hx([[0, 2, 20], [20, 6, 30]])]));
  close(turns(r.curves.x), Math.log(3) / 0.2, 1e-6);
  const end = r.curves.x.at(-1)!;
  close(end[2], 20, 1e-9);
  close(Math.hypot(end[0], end[1]), 15, 1e-9);
  // Rows must climb.
  const bad = m.evaluate(doc([hc, hx([[0, 2, 20], [0, 6, 30]])]));
  assert.equal(bad.statuses.find(s => s.id === "x")?.code, "E-HLX-ROWS");
});

test("Intersect bodies and surfaces into regions; untrim surface (FR-BODY-007, FR-FT-100)", async () => {
  const m = new Modeller(await occ());
  // Two 20 × 20 × 10 boxes as separate bodies, overlapping by half: three regions of 2000 mm³.
  const boxes: Feature[] = [rect("a", 0, 0, 20, 20), { id: "ea", type: "extrude", name: "E1", sketch: "a", op: "boss", end: "blind", depth: { v: 10 } },
    rect("b", 10, 0, 20, 20), { id: "eb", type: "extrude", name: "E2", sketch: "b", op: "boss", end: "blind", depth: { v: 10 }, merge: false } as Feature];
  const it = (o: Partial<{ bodies: { name: string }[]; exclude: number[][]; merge: boolean; consume: boolean }> = {}): Feature => ({ id: "i", type: "intersect", name: "Intersect1", bodies: [], exclude: [], ...o } as Feature);
  let r = run(m, doc([...boxes, it()]));
  assert.equal(r.regions.i.length, 3);
  r.regions.i.forEach(g => close(g.v, 2000, 1e-6));
  close(r.props!.volume, 6000, 1e-6);
  assert.equal(r.props!.bodies, 1);
  // Leave the common part out: the two outer pieces stay, as two bodies (they do not touch).
  r = run(m, doc([...boxes, it({ exclude: [[5, 0, 5]] })]));
  close(r.props!.volume, 4000, 1e-6);
  assert.equal(r.props!.bodies, 2);
  assert.deepEqual(r.regions.i.map(g => g.out).filter(Boolean).length, 1);
  // Not merged: three bodies.
  r = run(m, doc([...boxes, it({ merge: false })]));
  assert.equal(r.props!.bodies, 3);
  // A plane surface at z = 4 across the first box: two regions; keep the lower one and consume the surface.
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 4 } } as Feature;
  const surf: Feature[] = [pl, rect("s", 0, 0, 40, 40, { plane: "p1" }), { id: "ps", type: "planesurf", name: "Surface-Plane1", sketch: "s" }];
  const one: Feature[] = boxes.slice(0, 2);
  r = run(m, doc([...one, ...surf, it({ bodies: [{ name: "ea:end" }, { name: "ps:face:0" }], exclude: [[0, 0, 8]], consume: true })]));
  close(r.props!.volume, 20 * 20 * 4, 1e-6);
  assert.equal(r.sheets, null);
  assert.ok(r.body!.names.includes("ea:start") && r.body!.names.includes("ps:face:0"), r.body!.names.join());
  // Excluding every region is an error.
  const all = m.evaluate(doc([...one, ...surf, it({ exclude: [[0, 0, 8], [0, 0, 2]] })]));
  assert.equal(all.statuses.find(s => s.id === "i")?.code, "E-INT-ALL");
  // Untrim: a 40 mm square surface with a Ø10 hole gets its hole filled; a Ø20 disc goes back to its 20 mm parameter square.
  const props = (m as never as { props(b: unknown): { area: number } });
  const holed: SketchFeature = { ...rect("h", 0, 0, 40, 40), ents: [...rect("h", 0, 0, 40, 40).ents, { id: "hc", t: "point", x: 0, y: 0 }, { id: "hk", t: "circle", c: "hc", r: 5 }] };
  const ps: Feature = { id: "ps", type: "planesurf", name: "Surface-Plane1", sketch: "h" };
  r = run(m, doc([holed, ps]));
  close(props.props(r.sheets!).area, 1600 - Math.PI * 25, 1e-6);
  r = run(m, doc([holed, ps, { id: "u", type: "untrimsurf", name: "Surface-Untrim1", surface: { name: "ps:face:0" }, mode: "holes" } as Feature]));
  close(props.props(r.sheets!).area, 1600, 1e-6);
  r = run(m, doc([circle("d", 0, 0, 10, { std: "XY" }), { id: "ps", type: "planesurf", name: "Surface-Plane1", sketch: "d" }, { id: "u", type: "untrimsurf", name: "Surface-Untrim1", surface: { name: "ps:face:0" } } as Feature]));
  close(props.props(r.sheets!).area, 400, 1e-6);
  assert.deepEqual(r.sheets!.names, ["ps:face:0"]);
});

test("Patterns of faces and bodies, sketch- and table-driven patterns (FR-FT-070..073)", async () => {
  const m = new Modeller(await occ());
  const top = { face: { name: "eb:end" } };
  const base: Feature[] = [rect("b", 0, 0, 100, 60), { id: "eb", type: "extrude", name: "E1", sketch: "b", op: "boss", end: "blind", depth: { v: 10 } },
    circle("c", -40, -20, 5, top), { id: "ec", type: "extrude", name: "Boss", sketch: "c", op: "boss", end: "blind", depth: { v: 5 } },
    circle("h", -40, 20, 4, top), { id: "eh", type: "extrude", name: "Cut", sketch: "h", op: "cut", end: "blind", depth: { v: 5 } }];
  const boss = Math.PI * 25 * 5, hole = Math.PI * 16 * 5, v0 = 60000 + boss - hole;
  let r = run(m, doc(base));
  close(r.props!.volume, v0);
  const facesOf = (id: string) => r.body!.names.filter(n => n.startsWith(`${id}:`) && !n.endsWith(":start")).map(name => ({ name }));
  const dir = { edge: { faces: ["eb:side:bl1", "eb:end"] } };
  const lp = (o: object): Feature => ({ id: "p", type: "lpattern", name: "LPattern1", features: [], dir, spacing: { v: 20 }, count: 3, ...o } as Feature);
  // Faces of the boss: two more bosses; faces of the cut: two more holes.
  const bossFaces = facesOf("ec"), holeFaces = facesOf("eh");
  r = run(m, doc([...base, lp({ copy: "faces", faces: bossFaces })]));
  close(r.props!.volume, v0 + 2 * boss, 1e-5);
  r = run(m, doc([...base, lp({ copy: "faces", faces: holeFaces })]));
  close(r.props!.volume, v0 - 2 * hole, 1e-5);
  // Faces that bound nothing are an error.
  const bad = m.evaluate(doc([...base, lp({ copy: "faces", faces: [{ name: "eb:end" }] })]));
  assert.ok(!bad.statuses.find(s => s.id === "p")!.ok);
  // Bodies: a separate 10 mm cube patterned into new bodies.
  const cube: Feature[] = [rect("q", 5, 100, 10, 10), { id: "eq", type: "extrude", name: "E2", sketch: "q", op: "boss", end: "blind", depth: { v: 10 }, merge: false } as Feature];
  r = run(m, doc([...base, ...cube, lp({ copy: "bodies", bodies: [{ name: "eq:end" }] })]));
  close(r.props!.volume, v0 + 3000, 1e-6);
  assert.equal(r.props!.bodies, 4);
  // Mirror a body about YZ: it touches its original, and merge joins them.
  const mir = (o: object): Feature => ({ id: "mi", type: "mirror", name: "Mirror1", features: [], plane: { std: "YZ" }, copy: "bodies", bodies: [{ name: "eq:end" }], ...o } as Feature);
  r = run(m, doc([...base, ...cube, mir({})]));
  assert.equal(r.props!.bodies, 3);
  r = run(m, doc([...base, ...cube, mir({ merge: true })]));
  assert.equal(r.props!.bodies, 2);
  close(r.props!.volume, v0 + 2000, 1e-6);
  // Sketch-driven: the boss copied from its centre to two free points of a sketch (a line's ends don't count).
  const pts: SketchFeature = { id: "k", type: "sketch", name: "Pts", plane: top, rels: [], dims: [], ents: [
    { id: "k1", t: "point", x: 0, y: 0 }, { id: "k2", t: "point", x: 20, y: 0 }, { id: "k3", t: "point", x: 30, y: 20 }, { id: "k4", t: "point", x: 40, y: 20 }, { id: "kl", t: "line", a: "k3", b: "k4", cons: true }] };
  r = run(m, doc([...base, pts, { id: "sp", type: "spattern", name: "SketchPattern1", features: ["ec"], src: "sketch", sketch: "k" } as Feature]));
  close(r.props!.volume, v0 + 2 * boss, 1e-5);
  // With a picked reference point at the first point, only the second gives a copy (the first is the seed's own place).
  r = run(m, doc([...base, pts, { id: "sp", type: "spattern", name: "SketchPattern1", features: ["ec"], src: "sketch", sketch: "k", refPt: "k1" } as Feature]));
  close(r.props!.volume, v0 + boss, 1e-5);
  // Table-driven: offsets in the part's axes; a zero row is the seed itself.
  r = run(m, doc([...base, { id: "tp", type: "spattern", name: "TablePattern1", features: ["eh"], src: "table", table: [{ x: { v: 0 }, y: { v: 0 } }, { x: { v: 20 }, y: { v: 0 } }, { x: { v: 40 }, y: { v: -10 } }] } as Feature]));
  close(r.props!.volume, v0 - 2 * hole, 1e-5);
});

test("Up to body; counterdrilled, slot holes; hole up to face and up to next (FR-FT-012, FR-FT-050)", async () => {
  const m = new Modeller(await occ());
  // A 100 × 60 × 20 block, and a 20 × 20 × 10 block floating 30 mm above it as its own body.
  const base: Feature[] = [rect("s1", 0, 0, 100, 60), { id: "f1", type: "extrude", name: "E1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } }];
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 50 } } as Feature;
  const lid: Feature[] = [pl, rect("s2", 0, 0, 20, 20, { plane: "p1" }), { id: "f2", type: "extrude", name: "E2", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 }, merge: false } as Feature];
  // Up to body: a Ø10 boss on the block's top grows until it meets the floating block (30 mm).
  const post: Feature[] = [{ id: "c", type: "sketch", name: "c", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [{ id: "c0", t: "point", x: 0, y: 0 }, { id: "ck", t: "circle", c: "c0", r: 5 }] },
    { id: "f3", type: "extrude", name: "E3", sketch: "c", op: "boss", end: "body", depth: { v: 1 }, upToBody: { name: "f2:start" } } as Feature];
  let r = run(m, doc([...base, ...lid, ...post]));
  close(r.props!.volume, 120000 + 4000 + Math.PI * 25 * 30, 1e-6);
  const top = { face: { name: "f1:end" } };
  const h = (o: object): Feature => ({ id: "h1", type: "hole", name: "Hole1", plane: top, pts: [[0, 0]], kind: "simple", diameter: { v: 6 }, end: "blind", depth: { v: 10 }, flat: true, ...o } as Feature);
  // Counterdrill Ø12 × 4 with a 90° bottom (3 mm high cone frustum) over a Ø6 × 15 flat hole.
  r = run(m, doc([...base, h({ kind: "cdrill", cdDia: { v: 12 }, cdDepth: { v: 4 }, cdAngle: { v: Math.PI / 2 }, depth: { v: 15 } })]));
  const cone = (Math.PI * 3 / 3) * (36 + 18 + 9);
  close(r.props!.volume, 120000 - (Math.PI * 36 * 4 + cone + Math.PI * 9 * 8), 1e-6);
  // Slot: two Ø6 ends 20 mm apart, 10 deep with a flat bottom: 10 × (π·9 + 6·20).
  r = run(m, doc([...base, h({ kind: "slot", slotLen: { v: 20 } })]));
  close(r.props!.volume, 120000 - 10 * (Math.PI * 9 + 120), 1e-6);
  assert.ok(r.body!.faces.length <= 6 + 5, `slot faces merged: ${r.body!.faces.length}`);
  // Up to face: a plane 8 mm below the top (z = 12).
  const p8: Feature = { id: "p8", type: "plane", name: "Plane8", base: { std: "XY" }, mode: "offset", offset: { v: 12 } } as Feature;
  r = run(m, doc([...base, p8, h({ end: "upto", upTo: { plane: "p8" } })]));
  close(r.props!.volume, 120000 - Math.PI * 9 * 8, 1e-6);
  // Up to next: through the 20 mm block, no drill point.
  r = run(m, doc([...base, h({ end: "next" })]));
  close(r.props!.volume, 120000 - Math.PI * 9 * 20, 1e-6);
});

test("vertex and offset face chamfers, multi-thickness shell (FR-FT-041, FR-FT-060)", async () => {
  const m = new Modeller(await occ());
  const s = rect("s", 0, 0, 40, 20);
  const ex: Feature = { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  const edge = { faces: ["e:end", "e:side:sl1"] as [string, string] };
  // Offset face 3 on a square edge: both faces move in 3, so the chamfer is 3 × 3.
  let r = run(m, doc([s, ex, { id: "c", type: "chamfer", name: "C", distance: { v: 3 }, mode: "offset", edges: [edge] } as Feature]));
  close(r.props!.volume, 8000 - 4.5 * 40, 1e-6);
  // Vertex chamfer 2 / 3 / 4 at the corner (−20, −10, 10): a tetrahedron 2·3·4 / 6 comes off.
  const vc: Feature = { id: "c", type: "chamfer", name: "C", distance: { v: 2 }, distance2: { v: 3 }, distance3: { v: 4 }, mode: "vertex", edges: [], vertices: [{ edge, at: [-20, -10, 10] }] };
  r = run(m, doc([s, ex, vc]));
  close(r.props!.volume, 8000 - 4, 1e-6);
  assert.equal(r.body!.faces.length, 7);
  assert.ok(r.body!.names.includes("c:vertex:0"), r.body!.names.join());
  // Equal 2 at two corners.
  r = run(m, doc([s, ex, { ...vc, distance2: undefined, distance3: undefined, vertices: [{ edge, at: [-20, -10, 10] }, { edge, at: [20, -10, 10] }] } as Feature]));
  close(r.props!.volume, 8000 - 2 * 8 / 6, 1e-6);

  // Shell 2 mm open at the top, the +X wall 5 mm and the −X wall 1 mm: the cavity is 94 × 56 × 18.
  const s1 = rect("s1", 0, 0, 100, 60);
  const e1: Feature = { id: "f1", type: "extrude", name: "E1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const sh: Feature = { id: "f2", type: "shell", name: "Shell1", thickness: { v: 2 }, faces: [{ name: "f1:end" }], multi: [{ name: "f1:side:s1l2", t: 5 }, { name: "f1:side:s1l4", t: 1 }] };
  r = run(m, doc([s1, e1, sh]));
  close(r.props!.volume, 120000 - 94 * 56 * 18, 1e-6);
  assert.ok(r.body!.names.includes("f2:off:f1:side:s1l2"), r.body!.names.join());
  // A removed face cannot have its own thickness.
  const bad = m.evaluate(doc([s1, e1, { ...sh, multi: [{ name: "f1:end", t: 3 }] } as Feature]));
  assert.equal(bad.statuses[2].ok, false);
});

test("parting line draft, rib draft, loft start/end normal to profile (FR-FT-061, FR-FT-062, FR-FT-082)", async () => {
  const m = new Modeller(await occ());
  const deg = Math.PI / 180;
  // Two stacked 100 × 60 × 10 blocks: the edge between their −Y sides is the parting line; the top side tapers from it.
  const st: Feature[] = [rect("s1", 0, 0, 100, 60), { id: "f1", type: "extrude", name: "E1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } },
    rect("s2", 0, 0, 100, 60, { face: { name: "f1:end" } }), { id: "f2", type: "extrude", name: "E2", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 } }];
  const r0 = run(m, doc(st));
  assert.ok(r0.body!.names.includes("f2:side:s2l1") && r0.body!.names.includes("f1:side:s1l1"), r0.body!.names.join());
  const pd: Feature = { id: "d", type: "draft", name: "Draft1", kind: "parting", plane: { std: "XY" }, faces: [], parting: [{ faces: ["f2:side:s2l1", "f1:side:s1l1"] }], angle: { v: 5 * deg } };
  let r = run(m, doc([...st, pd]));
  close(Math.abs(120000 - r.props!.volume), 100 * 0.5 * 10 * 10 * Math.tan(5 * deg), 1e-4);
  // Other face: the lower side tapers from the same edge instead (down the pull, so the same size wedge).
  r = run(m, doc([...st, { ...pd, other: true } as Feature]));
  close(Math.abs(120000 - r.props!.volume), 100 * 0.5 * 10 * 10 * Math.tan(5 * deg), 1e-4);

  // Rib normal to the sketch across a channel, 4 thick and 50 deep, walls drafted 2° in: 80 · (4·50 − 50²·tan 2°).
  const line = (id: string, plane: SketchFeature["plane"], a: [number, number], b: [number, number]): SketchFeature => ({
    id, type: "sketch", name: id, plane, rels: [], dims: [],
    ents: [{ id: `${id}a`, t: "point", x: a[0], y: a[1] }, { id: `${id}b`, t: "point", x: b[0], y: b[1] }, { id: `${id}l`, t: "line", a: `${id}a`, b: `${id}b` }],
  });
  const chan: Feature[] = [rect("b", 0, 0, 100, 60), { id: "bx", type: "extrude", name: "Base", sketch: "b", op: "boss", end: "blind", depth: { v: 10 } },
    rect("w", -45, 0, 10, 60), { id: "wx", type: "extrude", name: "Wall", sketch: "w", op: "boss", end: "blind", depth: { v: 60 } },
    rect("w2", 45, 0, 10, 60), { id: "w2x", type: "extrude", name: "Wall2", sketch: "w2", op: "boss", end: "blind", depth: { v: 60 } },
    { id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 60 } }, line("r", { plane: "p" }, [-45, 0], [45, 0])];
  const rib: Feature = { id: "rb", type: "rib", name: "Rib1", sketch: "r", thickness: { v: 4 }, side: "mid", dir: "normal", draft: { v: 2 * deg } };
  r = run(m, doc([...chan, rib]));
  close(r.props!.volume, 120000 + 80 * (200 - 2500 * Math.tan(2 * deg)), 1e-4);
  r = run(m, doc([...chan, { ...rib, draftOut: true } as Feature]));
  close(r.props!.volume, 120000 + 80 * (200 + 2500 * Math.tan(2 * deg)), 1e-4);

  // Loft between two 20 mm squares 30 apart, the top one 15 mm over in X: every section is the same square, so 12000 either way.
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 30 } };
  const lf: Feature = { id: "l1", type: "loft", name: "Loft1", op: "boss", profiles: ["q1", "q2"] };
  const lofts = (o: object) => run(m, doc([rect("q1", 0, 0, 20, 20), pl, rect("q2", 15, 0, 20, 20, { plane: "p1" }), { ...lf, ...o } as Feature]));
  const plain = lofts({}), normal = lofts({ startNormal: true, endNormal: true });
  close(plain.props!.volume, 12000, 1e-4);
  close(normal.props!.volume, 12000, 1e-3);
  // Square to the start: 1 mm up, the left side has hardly moved (straight loft: 0.5 mm).
  const oc = (m as unknown as { oc: any }).oc;
  const inside = (r: { body: { shape: unknown } | null }, x: number) => new oc.BRepClass3d_SolidClassifier_3(r.body!.shape, new oc.gp_Pnt_3(x, 0, 1), 1e-7).State() === oc.TopAbs_State.TopAbs_IN;
  assert.equal(inside(plain, -9.7), false);
  assert.equal(inside(normal, -9.7), true);
});

test("indent: the target takes the tool's shape, with a wall or as a cut (FR-BODY-007)", async () => {
  const m = new Modeller(await occ());
  // A 100 × 100 × 5 plate and a 20 × 20 block from z = 1 to 21, kept as its own body.
  const sp = rect("sp", 0, 0, 100, 100), st = rect("st", 0, 0, 20, 20, { std: "XY" });
  const plate: Feature = { id: "p", type: "extrude", name: "P", sketch: "sp", op: "boss", end: "blind", depth: { v: 5 } };
  const block: Feature = { id: "b", type: "extrude", name: "B", sketch: "st", op: "boss", end: "blind", depth: { v: 20 }, startOffset: { v: 1 }, start: "offset", merge: false } as Feature;
  let r = run(m, doc([sp, st, plate, block]));
  assert.equal(r.props!.bodies, 2);
  const base = r.props!.volume;
  close(base, 50000 + 8000);
  const ind = (o: object): Feature => ({ id: "i", type: "indent", name: "I", main: { name: "p:end" }, tools: [{ name: "b:end" }], thickness: { v: 2 }, clearance: { v: 0 }, ...o } as Feature);
  // Cut: the 20 × 20 × 4 overlap comes out of the plate; the block stays.
  r = run(m, doc([sp, st, plate, block, ind({ cut: true })]));
  close(r.props!.volume, base - 1600, 1e-6);
  assert.equal(r.props!.bodies, 2);
  // Indent 2: the pocket plus a wall under it, 24 × 24 with round corners, from z = −1 to 0.
  r = run(m, doc([sp, st, plate, block, ind({})]));
  const add = r.props!.volume - (base - 1600);
  assert.ok(add > 400 && add < 576, `wall ${add}`);
  // Clearance 1 takes more out than the cut.
  const c1 = run(m, doc([sp, st, plate, block, ind({ cut: true, clearance: { v: 1 } })]));
  assert.ok(c1.props!.volume < base - 1600 - 300, `${c1.props!.volume}`);
  // A tool that does not touch the target fails.
  const far = rect("st", 200, 0, 20, 20, { std: "XY" });
  const bad = m.evaluate(doc([sp, far, plate, block, ind({})]));
  assert.equal(bad.statuses[4].ok, false);
});

test("sweep start tangency: path tangent turns the profile square to the path (FR-FT-080 P5)", async () => {
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  // A straight path 40 long at 45° in Front (XZ), from the origin; a 6 × 4 profile flat on Top.
  const s = 40 / Math.SQRT2;
  const path: SketchFeature = { id: "ps", type: "sketch", name: "Path", plane: { std: "XZ" }, rels: [], dims: [], ents: [P("a", 0, 0), P("b", s, s), { id: "pl", t: "line", a: "a", b: "b" }] };
  const prof = rect("pr", 0, 0, 6, 4);
  const sw: Feature = { id: "w1", type: "sweep", name: "Sweep1", op: "boss", profile: "pr", path: { sketch: "ps" }, orient: "normal" };
  // Without it the profile keeps its tilt: an oblique prism, 24 × 40 · cos 45°.
  const r0 = run(m, doc([path, prof, sw]));
  close(r0.props!.volume, 24 * 40 / Math.SQRT2, 1e-4);
  // Path tangent: the section square to the path is the whole profile, 24 × 40.
  const r1 = run(m, doc([path, prof, { ...sw, orient: undefined, startTangent: true } as Feature]));
  close(r1.props!.volume, 24 * 40, 1e-4);
});

test("feature recognition: holes in an imported body become hole features (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const s = rect("s", 0, 0, 60, 40);
  const ex: Feature = { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } };
  const top = { face: { name: "e:end" } };
  const hs: Feature[] = [
    { id: "h1", type: "hole", name: "H1", plane: top, pts: [[-15, 0], [-15, 12]], kind: "simple", diameter: { v: 10 }, end: "through", depth: { v: 0 } },
    { id: "h2", type: "hole", name: "H2", plane: top, pts: [[15, 0]], kind: "simple", diameter: { v: 8 }, end: "blind", depth: { v: 8 }, flat: true },
    { id: "h3", type: "hole", name: "H3", plane: top, pts: [[15, -12]], kind: "simple", diameter: { v: 6 }, end: "blind", depth: { v: 10 } },
  ] as Feature[];
  const src = run(m, doc([s, ex, ...hs]));
  const brep = m.brepText(src.body!).brep;
  const imp: Feature = { id: "i", type: "import", name: "Imported1", file: "block.brep", brep };
  const base = doc([imp]);
  const r0 = run(m, base);
  close(r0.props!.volume, src.props!.volume, 1e-6);
  const rec = m.recognizeHoles(base);
  assert.equal(rec.holes.length, 4, JSON.stringify(rec.holes));
  assert.equal(rec.holes.filter(h => h.end === "through").length, 2);
  const blind = rec.holes.filter(h => h.end === "blind").sort((a, b) => a.diameter - b.diameter);
  close(blind[0].diameter, 6, 1e-6); assert.equal(blind[0].flat, false); close(blind[0].depth, 10, 1e-6);
  close(blind[1].diameter, 8, 1e-6); assert.equal(blind[1].flat, true); close(blind[1].depth, 8, 1e-6);
  // Fill them and rebuild them as hole features: the same solid, with holes that can be edited.
  const feats: Feature[] = [{ id: "d", type: "delface", name: "D", faces: rec.faces } as Feature,
    ...rec.holes.map((h, k) => ({ id: `r${k}`, type: "hole", name: `R${k}`, plane: h.plane, pts: [h.pt], kind: "simple", diameter: { v: h.diameter }, end: h.end, depth: { v: h.depth }, flat: h.flat || undefined }) as Feature)];
  const r1 = run(m, doc([imp, feats[0]]));
  close(r1.props!.volume, 60 * 40 * 20, 1e-6);
  const r2 = run(m, doc([imp, ...feats]));
  close(r2.props!.volume, src.props!.volume, 1e-6);
});

test("loft guide curves: sections stretch to pass through the guides (FR-FT-082)", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const bbox = (shape: unknown) => {
    const b = new oc.Bnd_Box_1();
    oc.BRepBndLib.AddOptimal(shape, b, false, false);
    const lo = b.CornerMin(), hi = b.CornerMax();
    return [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()];
  };
  const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 40 } } as Feature;
  // Two Ø10 circles 40 apart, one guide bowing out to radius 8 half way: a barrel.
  const a = circle("a", 0, 0, 5, { std: "XY" }), b = circle("b", 0, 0, 5, { plane: "p1" });
  const g1: Feature = { id: "g1", type: "curve", name: "Curve1", kind: "xyz", pts: [[5, 0, 0], [8, 0, 20], [5, 0, 40]] };
  const free = run(m, doc([a, pl, b, { id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["a", "b"] } as Feature]));
  close(free.props!.volume, Math.PI * 25 * 40, 2e-3);
  let r = run(m, doc([a, pl, b, g1, { id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["a", "b"], guides: [{ curve: "g1" }] } as Feature]));
  let bb = bbox(r.body!.shape);
  close(bb[3], 8, 2e-2);
  close(bb[4], 8, 2e-2);
  assert.ok(r.props!.volume > Math.PI * 25 * 40 * 1.5, `barrel volume ${r.props!.volume}`);
  // Two guides on the long sides of a 20 × 10 rectangle bow out to ±15: only the width grows.
  const ra = rect("ra", 0, 0, 20, 10), rb = rect("rb", 0, 0, 20, 10, { plane: "p1" });
  const gl: Feature = { id: "gl", type: "curve", name: "Curve2", kind: "xyz", pts: [[-10, 0, 0], [-15, 0, 20], [-10, 0, 40]] };
  const gr: Feature = { id: "gr", type: "curve", name: "Curve3", kind: "xyz", pts: [[10, 0, 0], [15, 0, 20], [10, 0, 40]] };
  r = run(m, doc([ra, pl, rb, gl, gr, { id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["ra", "rb"], guides: [{ curve: "gl" }, { curve: "gr" }] } as Feature]));
  bb = bbox(r.body!.shape);
  close(bb[0], -15, 2e-2);
  close(bb[3], 15, 2e-2);
  close(bb[4], 5, 2e-2);
  // A guide that misses a profile is refused.
  const off = m.evaluate(doc([a, pl, b, { ...g1, pts: [[6, 0, 0], [8, 0, 20], [5, 0, 40]] } as Feature, { id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["a", "b"], guides: [{ curve: "g1" }] } as Feature]));
  assert.equal(off.statuses.find(s => s.id === "l")?.code, "E-LOFT-GUIDE");
});

test("check and heal feature: a gap sewn shut, split faces merged, names kept (FR-FT-131)", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  // The gap cube from the import test, read without healing, then healed by the feature.
  const P = (x: number, y: number, z: number) => new oc.gp_Pnt_3(x, y, z);
  const quad = (a: number[][]) => new oc.BRepBuilderAPI_MakeFace_15(new oc.BRepBuilderAPI_MakePolygon_4(P(a[0][0], a[0][1], a[0][2]), P(a[1][0], a[1][1], a[1][2]), P(a[2][0], a[2][1], a[2][2]), P(a[3][0], a[3][1], a[3][2]), true).Wire(), true).Face();
  const z1 = 10.02;
  const quads = [
    [[0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]], [[0, 0, z1], [10, 0, z1], [10, 10, z1], [0, 10, z1]],
    [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], [[0, 10, 0], [0, 10, 10], [10, 10, 10], [10, 10, 0]],
    [[0, 0, 0], [0, 0, 10], [0, 10, 10], [0, 10, 0]], [[10, 0, 0], [10, 10, 0], [10, 10, 10], [10, 0, 10]],
  ];
  const comp = new oc.TopoDS_Compound(), b = new oc.BRep_Builder();
  b.MakeCompound(comp);
  for (const q of quads) b.Add(comp, quad(q));
  oc.BRepTools.Write_4(comp, "/gap2.brep", false, false, oc.TopTools_FormatVersion.TopTools_FormatVersion_CURRENT, new oc.Message_ProgressRange_1());
  const brep = oc.FS.readFile("/gap2.brep", { encoding: "utf8" });
  const imp: Feature = { id: "i", type: "import", name: "Imported1", file: "gap.brep", brep };
  const heal: Feature = { id: "h", type: "heal", name: "Check-Heal1", tol: { v: 0.1 } } as Feature;
  const r = m.evaluate(doc([imp, heal]));
  const st = r.statuses.find(s => s.id === "h")!;
  assert.match(st.warning ?? "", /^Check and heal: [1-9]\d* free edges before, 0 after; (valid|not valid) before, valid after; 1 solid bodies\.$/);
  close(m.props(r.body!).volume, 1000, 0.01);
  assert.deepEqual([...r.body!.names].sort(), ["i:f0", "i:f1", "i:f2", "i:f3", "i:f4", "i:f5"]);
  // Two blocks side by side leave the top split in two; Merge faces makes it one, named after the larger.
  const a = rect("a", 5, 5, 10, 10), c = rect("c", 15, 5, 10, 10);
  const feats: Feature[] = [a, { id: "ea", type: "extrude", name: "E1", sketch: "a", op: "boss", end: "blind", depth: { v: 5 } } as Feature,
    c, { id: "ec", type: "extrude", name: "E2", sketch: "c", op: "boss", end: "blind", depth: { v: 5 } } as Feature];
  const split = run(m, doc(feats));
  const merged = run(m, doc([...feats, { id: "h", type: "heal", name: "Check-Heal1", tol: { v: 0.01 }, unify: true } as Feature]));
  assert.ok(merged.body!.faces.length < split.body!.faces.length, `${split.body!.faces.length} → ${merged.body!.faces.length}`);
  assert.equal(merged.body!.faces.length, 6);
  close(merged.props!.volume, split.props!.volume, 1e-9);
  assert.ok(merged.body!.names.includes("ea:end") || merged.body!.names.includes("ec:end"), merged.body!.names.join());
});
