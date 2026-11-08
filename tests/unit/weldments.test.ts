// Weldments (FR-FT-121): profile library, structural members with mitred and butted corners,
// trim/extend, end caps, gussets, fillet weld beads and the cut list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { cutList, type WeldHost } from "../../src/weldments/kernel";
import { PROFILE_TYPES, profileArea, profileShape, profileSizes } from "../../src/weldments/profiles";
import type { Feature, PartDoc, SketchFeature, SkEnt, V2, Sketch3dFeature } from "../../src/model/types";
import type { MemberFeature } from "../../src/weldments/types";
import { occ } from "./occ";

const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
/** A polyline sketch on XY (closed: back to the first point). */
const poly = (id: string, pts: V2[], closed: boolean, plane: SketchFeature["plane"] = { std: "XY" }): SketchFeature => {
  const ents: SkEnt[] = pts.map((p, i) => ({ id: `${id}p${i}`, t: "point", x: p[0], y: p[1] }));
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) ents.push({ id: `${id}l${i}`, t: "line", a: `${id}p${i}`, b: `${id}p${(i + 1) % pts.length}` });
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const lines = (sk: SketchFeature) => sk.ents.filter(e => e.t === "line").map(e => ({ sketch: sk.id, ent: e.id }));
const near = (a: number, b: number, rel = 1e-4) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-6, `${a} ≠ ${b}`);

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const info = r.body ? m.bodyInfo(r.body, d) : [];
  return { ...r, info, cut: cutList(m as unknown as WeldHost, info, d, r.frames), volume: r.body ? m.props(r.body).volume : 0 };
}

test("profile library: every size builds; areas match the standard tables", () => {
  for (const [type] of PROFILE_TYPES) for (const size of profileSizes(type)) {
    const s = profileShape(type, size);
    assert.ok(s && profileArea(s) > 0, `${type} ${size}`);
  }
  // cm² from EN 10219-2, EN 10056-1, DIN 1026-1, EN 10365.
  const table: [Parameters<typeof profileShape>[0], string, number][] = [
    ["shs", "40x40x3", 4.21], ["shs", "100x100x5", 18.4], ["rhs", "100x50x4", 10.9], ["chs", "48.3x3.2", 4.53],
    ["angle", "50x50x5", 4.80], ["angle", "100x100x10", 19.2], ["upn", "100", 13.5], ["upn", "200", 32.2],
    ["ipe", "200", 28.5], ["ipe", "300", 53.8], ["hea", "200", 53.8], ["flat", "40x5", 2.0], ["bar", "20", 3.14],
  ];
  for (const [type, size, cm2] of table) near(profileArea(profileShape(type, size)!) / 100, cm2, 0.012);
  assert.equal(profileShape("shs", "41x41x3"), null);
});

test("structural members: a mitred rectangular frame and its cut list (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const sk = poly("s", [[0, 0], [600, 0], [600, 400], [0, 400]], true);
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: lines(sk), corner: "miter" };
  const r = run(m, doc([sk, mem]));
  assert.equal(r.info.length, 4);
  const A = profileArea(profileShape("shs", "40x40x3")!);
  // Symmetric profile, mitred both ends: each member's volume is the area times its centreline length.
  near(r.volume, A * 2000, 2e-4);
  assert.deepEqual(r.cut.map(c => [c.desc, c.qty, c.length, c.angle1, c.angle2]), [["SHS 40x40x3", 2, 640, 45, 45], ["SHS 40x40x3", 2, 440, 45, 45]]);
  // Faces carry the member, segment and role.
  assert.ok(r.body!.names.includes("m:sl0:start") && r.body!.names.includes("m:sl0:end") && r.body!.names.some(n => n.startsWith("m:sl0:side:")));

  // A 2 mm weld gap at every mitre: each end moves back 1 mm square to the mitre plane (√2 along the member).
  const rg = run(m, doc([sk, { ...mem, gap: { v: 2 } }]));
  near(rg.volume, A * (2000 - 8 * Math.SQRT2), 2e-4);
  assert.deepEqual(rg.cut.map(c => [c.qty, c.length]), [[2, 637.2], [2, 437.2]]);
  // One corner butted instead (the first line runs through), and a description for the cut list.
  const ro = run(m, doc([sk, { ...mem, corners: { "sl0+sl1": "butt1" }, desc: "Frame tube" }]));
  assert.deepEqual(ro.cut.map(c => [c.desc, c.qty, c.length, c.angle1, c.angle2]), [["Frame tube", 1, 640, 0, 45], ["Frame tube", 1, 640, 45, 45], ["Frame tube", 1, 440, 45, 45], ["Frame tube", 1, 400, 0, 45]]);

  // Butt joints: the first segment runs through the corner, the second stops at its face.
  const open = poly("o", [[0, 0], [500, 0], [500, 300]], false);
  const butt: MemberFeature = { ...mem, id: "b", segs: lines(open), corner: "butt1" };
  const rb = run(m, doc([open, butt]));
  assert.deepEqual(rb.cut.map(c => [c.length, c.qty, c.angle1, c.angle2]), [[520, 1, 0, 0], [280, 1, 0, 0]]);
  const rb2 = run(m, doc([open, { ...butt, corner: "butt2" }]));
  assert.deepEqual(rb2.cut.map(c => c.length), [480, 320]);
  // A gap: the butted member stops 3 mm short of the one running through.
  assert.deepEqual(run(m, doc([open, { ...butt, gap: { v: 3 } }])).cut.map(c => c.length), [520, 277]);
  // An I-beam on its pierce point, turned 90°: still one body per segment.
  const ib = run(m, doc([open, { ...butt, profile: "ipe", size: "200", anchor: "b", angle: { v: Math.PI / 2 }, corner: "none" }]));
  assert.equal(ib.info.length, 2);
  near(ib.volume, profileArea(profileShape("ipe", "200")!) * 800, 2e-4);
});

test("trim/extend, end caps, gussets and weld beads (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  // A post along Z (3D sketch) and a beam along X ending short of it.
  const k: Sketch3dFeature = {
    id: "k", type: "sketch3d", name: "3DSketch1", rels: [], dims: [],
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [0, 0, 500] }, { id: "C", p: [100, 0, 300] }, { id: "D", p: [400, 0, 300] }],
    segs: [{ id: "post", t: "line", pts: ["A", "B"] }, { id: "beam", t: "line", pts: ["C", "D"] }],
  };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: [{ sketch: "k", ent: "post" }, { sketch: "k", ent: "beam" }], corner: "none" };
  const base = run(m, doc([k, mem]));
  assert.deepEqual(base.cut.map(c => c.length), [500, 300]);
  // The post's side face that looks at the beam (+X).
  const postFace = base.body!.names.map((n, i) => ({ n, i })).find(({ n, i }) => n.startsWith("m:post:side:") && Math.abs(centroidX(m, base.body!.faces[i]) - 20) < 1e-6)!;
  const pf = { name: postFace.n, hint: centroid(m, base.body!.faces[postFace.i]) };
  const tr: Feature = { id: "t", type: "trimext", name: "Trim/Extend1", bodies: [{ name: "m:beam:start" }], boundary: pf, kind: "face" };
  const r = run(m, doc([k, mem, tr]));
  // The beam now starts at the post's face (x = 20): 380 long.
  assert.deepEqual(r.cut.map(c => c.length), [500, 380]);
  assert.equal(r.body!.names.filter(n => n === "m:beam:start").length, 1);
  assert.equal(r.body!.names.filter(n => n.startsWith("m:beam:side:")).length, 16, "fused pieces merged back into whole faces");
  // Against the body instead of its face: the end follows the post's round corners too (6 mm radius).
  const rb = run(m, doc([k, mem, { ...tr, kind: "body" } as Feature]));
  assert.deepEqual(rb.cut.map(c => c.length), [500, 386]);

  // End cap on the beam's free end, 5 thick, 2 in from its outline.
  const cap: Feature = { id: "c", type: "endcap", name: "End cap1", faces: [{ name: "m:beam:end" }], thickness: { v: 5 }, inset: { v: 2 } };
  const rc = run(m, doc([k, mem, tr, cap]));
  assert.equal(rc.info.length, 3);
  const plate = rc.cut.find(c => c.kind === "plate")!;
  assert.deepEqual(plate.plate, [36, 36, 5]);

  // Gusset under the beam against the post: 60 × 60 × 5 triangle.
  const beamBottom = rc.body!.names.map((n, i) => ({ n, i })).find(({ n, i }) => n.startsWith("m:beam:side:") && Math.abs(centroid(m, rc.body!.faces[i])[2] - 280) < 1e-6)!;
  const g: Feature = { id: "g", type: "gusset", name: "Gusset1", face1: { name: beamBottom.n, hint: centroid(m, rc.body!.faces[beamBottom.i]) }, face2: pf, d1: { v: 60 }, d2: { v: 60 }, thickness: { v: 5 }, shape: "tri", loc: "mid" };
  const rg = run(m, doc([k, mem, tr, cap, g]));
  assert.equal(rg.info.length, 4);
  near(rg.volume - rc.volume, 0.5 * 60 * 60 * 5, 1e-6);

  // Fillet bead where the beam's top face meets the post: 4 mm legs along the flat part of the top (40 - 2 × 6 corner radius).
  const beamTop = rg.body!.names.map((n, i) => ({ n, i })).find(({ n, i }) => n.startsWith("m:beam:side:") && Math.abs(centroid(m, rg.body!.faces[i])[2] - 320) < 1e-6)!;
  const bead: Feature = { id: "w", type: "weldbead", name: "Fillet Bead1", faces1: [pf], faces2: [{ name: beamTop.n, hint: centroid(m, rg.body!.faces[beamTop.i]) }], size: { v: 4 }, tangent: false };
  const rw = run(m, doc([k, mem, tr, cap, g, bead]));
  const b = rw.cut.find(c => c.kind === "bead")!;
  near(b.length!, 28, 1e-3);
  near(rw.volume - rg.volume, 8 * 28, 1e-4);
});

test("fillet bead round a tube standing on a plate (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const sk = poly("s", [[-100, -100], [100, -100], [100, 100], [-100, 100]], true);
  const plate: Feature = { id: "p", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  const k: Sketch3dFeature = { id: "k", type: "sketch3d", name: "3DSketch1", rels: [], dims: [], pts: [{ id: "A", p: [0, 0, 10], fixed: true }, { id: "B", p: [0, 0, 300] }], segs: [{ id: "post", t: "line", pts: ["A", "B"] }] };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "chs", size: "48.3x3.2", segs: [{ sketch: "k", ent: "post" }], corner: "none" };
  const base = run(m, doc([sk, plate, k, mem]));
  const outer = base.body!.names.filter((n, i) => n.startsWith("m:post:side:") && Math.hypot(...centroid(m, base.body!.faces[i]).slice(0, 2) as [number, number]) > 14.5);
  assert.equal(outer.length, 2);
  const bead: Feature = { id: "w", type: "weldbead", name: "Fillet Bead1", faces1: [{ name: "p:end" }], faces2: outer.map(name => ({ name })), size: { v: 5 } };
  const r = run(m, doc([sk, plate, k, mem, bead]));
  const b = r.cut.find(c => c.kind === "bead")!;
  const R = 48.3 / 2;
  near(b.length!, 2 * Math.PI * R, 1e-3);
  // Pappus: the triangle's area times the path of its centroid (R + s/3 from the axis).
  near(r.volume - base.volume, 12.5 * 2 * Math.PI * (R + 5 / 3), 1e-3);
});

test("bead all round a square tube on a plate: tangent faces join, the pieces fuse into one bead (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const sk = poly("s", [[-100, -100], [100, -100], [100, 100], [-100, 100]], true);
  const plate: Feature = { id: "p", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  const k: Sketch3dFeature = { id: "k", type: "sketch3d", name: "3DSketch1", rels: [], dims: [], pts: [{ id: "A", p: [0, 0, 10], fixed: true }, { id: "B", p: [0, 0, 300] }], segs: [{ id: "post", t: "line", pts: ["A", "B"] }] };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: [{ sketch: "k", ent: "post" }], corner: "none" };
  const base = run(m, doc([sk, plate, k, mem]));
  // One flat outer side of the tube.
  const side = base.body!.names.map((n, i) => ({ n, c: centroid(m, base.body!.faces[i]) })).find(({ n, c }) => n.startsWith("m:post:side:") && Math.abs(c[0] - 20) < 1e-6)!;
  const bead: Feature = { id: "w", type: "weldbead", name: "Fillet Bead1", faces1: [{ name: "p:end" }], faces2: [{ name: side.n, hint: side.c }], size: { v: 4 } };
  const r = run(m, doc([sk, plate, k, mem, bead]));
  const beads = r.cut.filter(c => c.kind === "bead");
  assert.equal(beads.length, 1);
  assert.equal(beads[0].qty, 1);
  // Flat sides 40 − 2·ro long, four quarter circles of radius ro (ro = 6 for t = 3).
  near(beads[0].length!, 4 * (40 - 12) + 2 * Math.PI * 6, 1e-3);
  assert.equal(r.info.length, 3);
  // Without tangent propagation only the picked side gets a bead.
  const r1 = run(m, doc([sk, plate, k, mem, { ...bead, tangent: false } as Feature]));
  near(r1.cut.find(c => c.kind === "bead")!.length!, 28, 1e-3);
});

test("gusset faces on the two picked faces are named for the leg arrows (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const sk = poly("s", [[-100, -100], [100, -100], [100, 100], [-100, 100]], true);
  const plate: Feature = { id: "p", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } };
  const k: Sketch3dFeature = { id: "k", type: "sketch3d", name: "3DSketch1", rels: [], dims: [], pts: [{ id: "A", p: [0, 0, 10], fixed: true }, { id: "B", p: [0, 0, 300] }], segs: [{ id: "post", t: "line", pts: ["A", "B"] }] };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: [{ sketch: "k", ent: "post" }], corner: "none" };
  const base = run(m, doc([sk, plate, k, mem]));
  const side = base.body!.names.map((n, i) => ({ n, c: centroid(m, base.body!.faces[i]) })).find(({ n, c }) => n.startsWith("m:post:side:") && Math.abs(c[0] - 20) < 1e-6)!;
  const g: Feature = { id: "g", type: "gusset", name: "Gusset1", face1: { name: "p:end" }, face2: { name: side.n, hint: side.c }, d1: { v: 50 }, d2: { v: 70 }, thickness: { v: 5 }, shape: "tri", loc: "mid" };
  const r = run(m, doc([sk, plate, k, mem, g]));
  const on1 = r.body!.names.map((n, i) => ({ n, i })).filter(({ n }) => n === "g:on1");
  const on2 = r.body!.names.map((n, i) => ({ n, i })).filter(({ n }) => n === "g:on2");
  assert.equal(on1.length, 1);
  assert.equal(on2.length, 1);
  near(centroid(m, r.body!.faces[on1[0].i])[2], 10);
  near(centroid(m, r.body!.faces[on2[0].i])[0], 20);
  near(r.volume - base.volume, 0.5 * 50 * 70 * 5, 1e-6);
});

test("curved members: arcs of the path sketch are revolved, tangent joints stay open, a corner at an arc is mitred (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  // A line, a quarter arc of radius 100 tangent to it, and a line on from the arc.
  const sk: SketchFeature = { id: "s", type: "sketch", name: "Path", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("p0", 0, 0), P("p1", 300, 0), P("c", 300, 100), P("p2", 400, 100), P("p3", 400, 400),
    { id: "l1", t: "line", a: "p0", b: "p1" }, { id: "a1", t: "arc", c: "c", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" },
  ] };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: ["l1", "a1", "l2"].map(ent => ({ sketch: "s", ent })), corner: "miter" };
  const A = profileArea(profileShape("shs", "40x40x3")!);
  const r = run(m, doc([sk, mem]));
  assert.equal(r.info.length, 3);
  near(r.volume, A * (600 + 50 * Math.PI), 1e-4);
  assert.deepEqual(r.cut.map(c => [c.qty, c.length]).sort((x, y) => x[1] - y[1]), [[1, 157.1], [2, 300]]);
  assert.ok(r.body!.names.some(n => n.startsWith("m:a1:side:")) && r.body!.names.includes("m:a1:start") && r.body!.names.includes("m:a1:end"));
  // A half circle leaving the line at a right angle: the corner is mitred.
  const sk2: SketchFeature = { id: "t", type: "sketch", name: "Path2", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("q0", 0, 0), P("q1", 300, 0), P("qc", 400, 0), P("q2", 500, 0),
    { id: "k1", t: "line", a: "q0", b: "q1" }, { id: "k2", t: "arc", c: "qc", a: "q1", b: "q2" },
  ] };
  const r2 = run(m, doc([sk2, { ...mem, id: "n", segs: ["k1", "k2"].map(ent => ({ sketch: "t", ent })) }]));
  assert.equal(r2.info.length, 2);
  near(r2.volume, A * (300 + 100 * Math.PI), 2e-3);
  assert.deepEqual(r2.cut.map(c => [c.length, c.angle1, c.angle2]).sort((x, y) => x[0] - y[0]), [[320, 0, 45], [334.2, 0, 45]]);
});

test("custom profile from a sketch: holes, arcs, sketch origin on the path (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  // 40 × 20 rectangle with its corner on the sketch origin and a Ø10 hole in the middle.
  const pr = poly("pr", [[0, 0], [40, 0], [40, 20], [0, 20]], true);
  pr.name = "Bracket profile";
  pr.ents.push({ id: "hc", t: "point", x: 20, y: 10 }, { id: "h", t: "circle", c: "hc", r: 5 });
  const path = poly("o", [[0, 0], [500, 0]], false);
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "sketch", size: "", psketch: "pr", segs: lines(path), corner: "none" };
  const r = run(m, doc([pr, path, mem]));
  near(r.volume, (800 - 25 * Math.PI) * 500, 1e-4);
  // Along X on the XY plane: profile x runs along world Y, profile y along Z; the sketch origin sits on the path.
  const c = m.props(r.body!).com;
  near(c[0], 250); near(c[1], 20); near(c[2], 10);
  assert.deepEqual(r.cut.map(x => [x.desc, x.length]), [["Bracket profile", 500]]);
  // On its box centre instead.
  const rc = run(m, doc([pr, path, { ...mem, anchor: "c" }]));
  const cc = m.props(rc.body!).com;
  near(cc[1] + 1, 1); near(cc[2] + 1, 1);
  // A D-shape: a line and a half circle stay exact.
  const d: SketchFeature = { id: "d", type: "sketch", name: "D", plane: { std: "XY" }, rels: [], dims: [], ents: [
    { id: "p0", t: "point", x: 40, y: 0 }, { id: "p1", t: "point", x: 0, y: 0 }, { id: "pc", t: "point", x: 20, y: 0 },
    { id: "l", t: "line", a: "p1", b: "p0" }, { id: "a", t: "arc", c: "pc", a: "p0", b: "p1" },
  ] };
  const rd = run(m, doc([d, path, { ...mem, psketch: "d" }]));
  near(rd.volume, (Math.PI * 400) / 2 * 500, 1e-6);
  // No closed region: the member reports it.
  const bad = m.evaluate(doc([path, { ...mem, psketch: "o" }]));
  assert.equal(bad.statuses.find(x => x.id === "m")?.ok, false);
});

test("three members meeting at a corner: one runs through, the others stop at its faces (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const k: Sketch3dFeature = {
    id: "k", type: "sketch3d", name: "3DSketch1", rels: [], dims: [],
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "X", p: [300, 0, 0] }, { id: "Y", p: [0, 300, 0] }, { id: "Z", p: [0, 0, 300] }],
    segs: [{ id: "x", t: "line", pts: ["A", "X"] }, { id: "y", t: "line", pts: ["A", "Y"] }, { id: "z", t: "line", pts: ["A", "Z"] }],
  };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: ["x", "y", "z"].map(ent => ({ sketch: "k", ent })), corner: "butt1" };
  const A = profileArea(profileShape("shs", "40x40x3")!);
  const r = run(m, doc([k, mem]));
  assert.equal(r.info.length, 3);
  assert.deepEqual(r.cut.map(c => [c.length, c.qty]), [[320, 1], [280, 2]]);
  near(r.volume, A * 880, 2e-4);
  // Mitre falls back to the same rule; butt 2: the last one runs through.
  assert.deepEqual(run(m, doc([k, { ...mem, corner: "miter" }])).cut.map(c => [c.length, c.qty]), [[320, 1], [280, 2]]);
  const r2 = run(m, doc([k, { ...mem, corner: "butt2" }]));
  const zLen = r2.cut.find(c => c.qty === 1)!.length;
  assert.equal(zLen, 320);
  assert.equal(r2.body!.names.filter(n => n.startsWith("m:z:")).length > 0, true);
});

function centroid(m: Modeller, face: unknown) { return (m as unknown as { centroid(f: unknown): [number, number, number] }).centroid(face); }
function centroidX(m: Modeller, face: unknown) { return centroid(m, face)[0]; }

test("member groups: segments in group 2 take their own profile position, rotation and mirror (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  // Two separate rails along X.
  const sk: SketchFeature = { id: "s", type: "sketch", name: "Rails", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("a0", 0, 0), P("a1", 500, 0), P("b0", 0, 200), P("b1", 500, 200),
    { id: "r1", t: "line", a: "a0", b: "a1" }, { id: "r2", t: "line", a: "b0", b: "b1" },
  ] };
  const mem: MemberFeature = { id: "m", type: "member", name: "Structural Member1", profile: "rhs", size: "100x50x4", segs: ["r1", "r2"].map(ent => ({ sketch: "s", ent })), corner: "none" };
  const A = profileArea(profileShape("rhs", "100x50x4")!);
  const flat = run(m, doc([sk, mem]));
  near(flat.volume, 2 * 500 * A, 1e-4);
  assert.ok(Math.abs(m.props(flat.body!).com[2]) < 1e-6);
  // Both on their bottom edge: the profiles sit on one side of the path.
  const both = run(m, doc([sk, { ...mem, anchor: "b" }]));
  const dz = m.props(both.body!).com[2];
  assert.ok(Math.abs(dz) > 10, `com z ${dz}`);
  // Only group 2 on its bottom edge: half the shift; rotated 90° the volume stays the same.
  const g = run(m, doc([sk, { ...mem, groups: [{ ents: ["r2"], anchor: "b" }] }]));
  near(m.props(g.body!).com[2], dz / 2, 1e-4);
  const rot = run(m, doc([sk, { ...mem, anchor: "b", groups: [{ ents: ["r2"], anchor: "b", angle: { v: Math.PI / 2 } }] }]));
  near(rot.volume, 2 * 500 * A, 1e-4);
  const zr = m.props(rot.body!).com[2];
  assert.ok(Math.abs(zr - dz) > 5 && Math.abs(zr) > 5, `rotated group com z ${zr} vs ${dz}`);
});
