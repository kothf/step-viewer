// Weldments (FR-FT-121): profile library, structural members with mitred and butted corners,
// trim/extend, end caps, gussets, fillet weld beads and the cut list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { cutList, gussetEnds, pierceSpots, type WeldHost } from "../../src/weldments/kernel";
import { PROFILE_TYPES, profileArea, profileShape, profileSizes } from "../../src/weldments/profiles";
import type { Feature, PartDoc, SketchFeature, SkEnt, V2, V3, Sketch3dFeature } from "../../src/model/types";
import type { GussetFeature, MemberFeature } from "../../src/weldments/types";
import { cutKey, splitSubs } from "../../src/weldments/types";
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
    ["uangle", "60x40x5", 4.79], ["uangle", "100x50x8", 11.4], ["uangle", "120x80x10", 19.1], ["heb", "200", 78.1], ["heb", "300", 149],
    ["sqbar", "20", 4.0],
    ["upe", "100", 12.5], ["upe", "200", 29.0], ["upe", "300", 56.6], ["hem", "100", 53.2], ["hem", "200", 131], ["hem", "300", 303],
    ["ipn", "100", 10.6], ["ipn", "200", 33.4], ["ipn", "300", 69.0],
  ];
  for (const [type, size, cm2] of table) near(profileArea(profileShape(type, size)!) / 100, cm2, 0.012);
  assert.equal(profileShape("shs", "41x41x3"), null);
  // An unequal angle stands on its short leg: the long leg is the height of its box.
  const ua = profileShape("uangle", "75x50x6")!;
  assert.deepEqual([ua.w, ua.h], [50, 75]);
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

  // Merge miter trimmed bodies: the four mitred tubes become one body, listed once with the four lengths added up.
  const rm = run(m, doc([sk, { ...mem, mergeMiter: true }]));
  assert.equal(rm.info.length, 1);
  near(rm.volume, A * 2000, 2e-4);
  assert.deepEqual(rm.cut.map(c => [c.qty, c.length, c.angle1, c.angle2]), [[1, 2160, 0, 0]]);
  assert.ok(rm.body!.names.some(n => n.startsWith("m:sl2:side:")) && !rm.body!.names.includes("m:sl0:start"));
  // With a weld gap the mitred ends don't touch: four bodies again.
  assert.equal(run(m, doc([sk, { ...mem, mergeMiter: true, gap: { v: 2 } }])).info.length, 4);
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
  // Merged only at mitres: a butted corner keeps its two bodies; mitred, the L is one body with square free ends.
  assert.equal(run(m, doc([open, { ...butt, mergeMiter: true }])).info.length, 2);
  assert.deepEqual(run(m, doc([open, { ...butt, corner: "miter", mergeMiter: true }])).cut.map(c => [c.qty, c.length, c.angle1, c.angle2]), [[1, 840, 0, 0]]);
  const rb2 = run(m, doc([open, { ...butt, corner: "butt2" }]));
  assert.deepEqual(rb2.cut.map(c => c.length), [480, 320]);
  // A gap: the butted member stops 3 mm short of the one running through.
  assert.deepEqual(run(m, doc([open, { ...butt, gap: { v: 3 } }])).cut.map(c => c.length), [520, 277]);
  // An I-beam on its pierce point, turned 90°: still one body per segment.
  const ib = run(m, doc([open, { ...butt, profile: "ipe", size: "200", anchor: "b", angle: { v: Math.PI / 2 }, corner: "none" }]));
  assert.equal(ib.info.length, 2);
  near(ib.volume, profileArea(profileShape("ipe", "200")!) * 800, 2e-4);

  // Alignment: an RHS 80x40 along X on XY has its vertical axis on Z by default; aligning that axis with a
  // 3D sketch line along Y lays it on its side, so its Y and Z sizes swap.
  const oc = await occ();
  const size = (shape: any): V3 => {
    const b = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, b, false);
    const lo = b.CornerMin(), hi = b.CornerMax();
    return [hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()].map(v => Math.round(v * 10) / 10) as V3;
  };
  const bar = poly("x", [[0, 0], [500, 0]], false);
  const ax: Sketch3dFeature = { id: "ax", type: "sketch3d", name: "3DSketch1", rels: [], dims: [], pts: [{ id: "P", p: [0, 0, 0] }, { id: "Q", p: [0, 300, 0] }, { id: "R", p: [300, 0, 0] }], segs: [{ id: "ly", t: "line", pts: ["P", "Q"] }, { id: "lx", t: "line", pts: ["P", "R"] }] };
  const rhs: MemberFeature = { id: "r", type: "member", name: "Structural Member1", profile: "rhs", size: "80x40x4", segs: lines(bar), corner: "none" };
  const base = size(run(m, doc([bar, ax, rhs])).body!.shape);
  const upY = size(run(m, doc([bar, ax, { ...rhs, align: { sketch: "ax", ent: "ly", axis: "v" } }])).body!.shape);
  assert.deepEqual([upY[0], upY[1], upY[2]], [base[0], base[2], base[1]]);
  assert.notDeepEqual(base[1], base[2]);
  // Its horizontal axis along Y is the usual placement; a line along the member itself changes nothing.
  assert.deepEqual(size(run(m, doc([bar, ax, { ...rhs, align: { sketch: "ax", ent: "ly", axis: "h" } }])).body!.shape), base);
  assert.deepEqual(size(run(m, doc([bar, ax, { ...rhs, align: { sketch: "ax", ent: "lx", axis: "v" } }])).body!.shape), base);
  // The rotation angle turns the aligned profile on: 90° brings it back.
  assert.deepEqual(size(run(m, doc([bar, ax, { ...rhs, align: { sketch: "ax", ent: "ly", axis: "v" }, angle: { v: Math.PI / 2 } }])).body!.shape), base);
  // A lost alignment line is an error, not a silent fallback.
  const lost = m.evaluate(doc([bar, ax, { ...rhs, align: { sketch: "ax", ent: "gone", axis: "v" } }])).statuses.find(x => !x.ok);
  assert.match(lost?.message ?? "", /alignment line/);
  // Coped cut: a round post butting a round rail at a T gets a saddle end.
  const tee: SketchFeature = { ...poly("t", [[0, 0], [200, 0], [400, 0]], false) };
  tee.ents.push({ id: "tp3", t: "point", x: 200, y: 300 }, { id: "tl2", t: "line", a: "tp1", b: "tp3" });
  const post: MemberFeature = { id: "c", type: "member", name: "Structural Member1", profile: "chs", size: "48.3x3.2", segs: lines(tee), corner: "butt1" };
  const flat = run(m, doc([tee, post])), cope = run(m, doc([tee, { ...post, coped: true }]));
  assert.equal(cope.info.length, 3);
  const Ac = profileArea(profileShape("chs", "48.3x3.2")!), R = 48.3 / 2;
  // The flat cut stops the post at the rail's top (R from the axis); the saddle runs on down the rail's sides.
  assert.ok(cope.volume > flat.volume + Ac * 2 && cope.volume < flat.volume + Ac * R, `${cope.volume - flat.volume}`);
  assert.ok(cope.body!.names.includes("c:tl2:start"));
  // A weld gap moves the coped end back along the post: 3 mm less of it.
  near(run(m, doc([tee, { ...post, coped: true, gap: { v: 3 } }])).volume, cope.volume - 3 * Ac, 2e-3);
  const sq = { ...post, profile: "shs" as const, size: "40x40x3" };
  // On a square tube the coped end is flat except where the post's side walls run down into the rail's corner rounds.
  const dsq = run(m, doc([tee, { ...sq, coped: true }])).volume - run(m, doc([tee, sq])).volume;
  assert.ok(dsq > 0 && dsq < 2 * 40 * 3 * 7.5, `${dsq}`);
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
  // Against a plane instead of a face: the Right (YZ) plane lengthens the beam back to x = 0 (400 long),
  // and a reference plane 200 along X cuts it there (200 long).
  const rp = run(m, doc([k, mem, { ...tr, boundary: undefined, plane: { std: "YZ" } } as Feature]));
  assert.deepEqual(rp.cut.map(c => c.length), [500, 400]);
  const pl: Feature = { id: "p", type: "plane", name: "Plane1", base: { std: "YZ" }, mode: "offset", offset: { v: 200 } };
  const rq = run(m, doc([k, mem, pl, { ...tr, boundary: undefined, plane: { plane: "p" } } as Feature]));
  assert.deepEqual(rq.cut.map(c => c.length), [500, 200]);
  // Weld gap: the beam stops 3 mm short of the face, the body or the plane.
  const g3 = { gap: { v: 3 } };
  assert.deepEqual(run(m, doc([k, mem, { ...tr, ...g3 } as Feature])).cut.map(c => c.length), [500, 377]);
  assert.deepEqual(run(m, doc([k, mem, { ...tr, ...g3, kind: "body" } as Feature])).cut.map(c => c.length), [500, 383]);
  assert.deepEqual(run(m, doc([k, mem, { ...tr, ...g3, boundary: undefined, plane: { std: "YZ" } } as Feature])).cut.map(c => c.length), [500, 397]);
  // Planar trim against the body: a flat end where the beam first meets the post (its flat side, x = 20), not round its corners.
  const pt = run(m, doc([k, mem, { ...tr, kind: "body", planar: true } as Feature]));
  assert.deepEqual(pt.cut.map(c => [c.length, c.angle1, c.angle2]), [[500, 0, 0], [380, 0, 0]]);
  near(pt.volume, rb.volume - 6 * pt.cut[1].volume / 380, 0.2 * pt.cut[1].volume / 380);
  assert.deepEqual(run(m, doc([k, mem, { ...tr, ...g3, kind: "body", planar: true } as Feature])).cut.map(c => c.length), [500, 377]);

  // End cap on the beam's free end, 5 thick, 2 in from its outline.
  const cap: Feature = { id: "c", type: "endcap", name: "End cap1", faces: [{ name: "m:beam:end" }], thickness: { v: 5 }, inset: { v: 2 } };
  const rc = run(m, doc([k, mem, tr, cap]));
  assert.equal(rc.info.length, 3);
  const plate = rc.cut.find(c => c.kind === "plate")!;
  assert.deepEqual(plate.plate, [36, 36, 5]);

  // Corner treatment: on the rounded SHS outline nothing is sharp, so the plate is unchanged.
  const rcc = run(m, doc([k, mem, tr, { ...cap, chamfer: { v: 3 } } as Feature]));
  near(rcc.volume, rc.volume, 1e-9);
  // A flat bar's cap has four sharp corners: chamfered 3 mm, or rounded r 3.
  const fb: Feature[] = [k, { ...mem, profile: "flat", size: "50x10", segs: [{ sketch: "k", ent: "beam" }] } as Feature];
  const capF: Feature = { ...cap, inset: { v: 0 } } as Feature;
  const v0 = run(m, doc([...fb, capF])).volume;
  near(v0 - run(m, doc([...fb, { ...capF, chamfer: { v: 3 } } as Feature])).volume, 4 * 4.5 * 5, 1e-6);
  near(v0 - run(m, doc([...fb, { ...capF, chamfer: { v: 3 }, fillet: true } as Feature])).volume, 4 * (9 - Math.PI * 9 / 4) * 5, 1e-6);

  // Thickness direction. Inward keeps the overall length: the beam is cut back by 5 under a full-size plate.
  const capIn = run(m, doc([k, mem, tr, { ...cap, inset: { v: 0 }, dir: "in" } as Feature]));
  assert.deepEqual(capIn.cut.filter(c => c.kind === "member").map(c => c.length), [500, 375]);
  assert.deepEqual(capIn.cut.find(c => c.kind === "plate")!.plate, [40, 40, 5]);
  assert.equal(capIn.body!.names.filter(n => n === "m:beam:end").length, 1, "the new end face keeps the name");
  // Internal: the plate fits the tube's inner outline (34 × 34), 1 mm clearance all round, flush with the end.
  const capInt = run(m, doc([k, mem, tr, { ...cap, inset: { v: 1 }, dir: "internal" } as Feature]));
  assert.deepEqual(capInt.cut.filter(c => c.kind === "member").map(c => c.length), [500, 380]);
  assert.deepEqual(capInt.cut.find(c => c.kind === "plate")!.plate, [32, 32, 5]);
  // Thickness ratio: the inset is a multiple of the wall (SHS 40x40x3: 0.5 → 1.5 mm, 1 → 3 mm, the tube's inner outline).
  assert.deepEqual(run(m, doc([k, mem, tr, { ...cap, ratio: { v: 0.5 } } as Feature])).cut.find(c => c.kind === "plate")!.plate, [37, 37, 5]);
  assert.deepEqual(run(m, doc([k, mem, tr, { ...cap, ratio: { v: 1 } } as Feature])).cut.find(c => c.kind === "plate")!.plate, [34, 34, 5]);
  // A solid section's wall is 2 × area / perimeter (flat 50x10: 1000 / 120); internal caps ignore the ratio.
  assert.deepEqual(run(m, doc([...fb, { ...cap, ratio: { v: 0.3 } } as Feature])).cut.find(c => c.kind === "plate")!.plate, [45, 5, 5]);
  assert.deepEqual(run(m, doc([k, mem, tr, { ...cap, inset: { v: 1 }, dir: "internal", ratio: { v: 2 } } as Feature])).cut.find(c => c.kind === "plate")!.plate, [32, 32, 5]);
  // A flat bar has no inside.
  const bad = m.evaluate(doc([...fb, { ...capF, dir: "internal" } as Feature])).statuses.find(s => !s.ok);
  assert.match(String(bad?.message ?? JSON.stringify(bad)), /hollow profile/);

  // Gusset under the beam against the post: 60 × 60 × 5 triangle.
  const beamBottom = rc.body!.names.map((n, i) => ({ n, i })).find(({ n, i }) => n.startsWith("m:beam:side:") && Math.abs(centroid(m, rc.body!.faces[i])[2] - 280) < 1e-6)!;
  const g: Feature = { id: "g", type: "gusset", name: "Gusset1", face1: { name: beamBottom.n, hint: centroid(m, rc.body!.faces[beamBottom.i]) }, face2: pf, d1: { v: 60 }, d2: { v: 60 }, thickness: { v: 5 }, shape: "tri", loc: "mid" };
  const rg = run(m, doc([k, mem, tr, cap, g]));
  assert.equal(rg.info.length, 4);
  near(rg.volume - rc.volume, 0.5 * 60 * 60 * 5, 1e-6);
  // Location along the corner: the plate's centre (its face on face 1) moves with offset and thickness side.
  const yOf = (gf: Partial<Feature>) => { const r = run(m, doc([k, mem, tr, cap, { ...g, ...gf } as Feature])); const i = r.body!.names.indexOf("g:on1"); return centroid(m, r.body!.faces[i])[1]; };
  const ym = yOf({}), ys = yOf({ loc: "start" } as Partial<Feature>), ye = yOf({ loc: "end" } as Partial<Feature>);
  const dirIn = Math.sign(ym - ys);
  near(Math.abs(ye - ym), Math.abs(ym - ys), 1e-9);
  near(yOf({ loc: "start", side: "both" } as Partial<Feature>), ys - dirIn * 2.5, 1e-9);
  near(yOf({ loc: "start", side: "out" } as Partial<Feature>), ys - dirIn * 5, 1e-9);
  near(yOf({ loc: "start", offset: { v: 10 } } as Partial<Feature>), ys + dirIn * 10, 1e-9);
  near(yOf({ loc: "end", offset: { v: 10 }, side: "out" } as Partial<Feature>), ye - dirIn * 10 + dirIn * 5, 1e-9);
  near(yOf({ offset: { v: 4 } } as Partial<Feature>), ym + dirIn * 4, 1e-9);

  // Fillet bead where the beam's top face meets the post: 4 mm legs along the flat part of the top (40 - 2 × 6 corner radius).
  const beamTop = rg.body!.names.map((n, i) => ({ n, i })).find(({ n, i }) => n.startsWith("m:beam:side:") && Math.abs(centroid(m, rg.body!.faces[i])[2] - 320) < 1e-6)!;
  const bead: Feature = { id: "w", type: "weldbead", name: "Fillet Bead1", faces1: [pf], faces2: [{ name: beamTop.n, hint: centroid(m, rg.body!.faces[beamTop.i]) }], size: { v: 4 }, tangent: false };
  const rw = run(m, doc([k, mem, tr, cap, g, bead]));
  const b = rw.cut.find(c => c.kind === "bead")!;
  near(b.length!, 28, 1e-3);
  near(rw.volume - rg.volume, 8 * 28, 1e-4);
  // From/to length: 10 mm from 5 mm in; flipped, the same 10 mm from the other end (centres 28 - 10 = 18 apart).
  const spanOf = (span: object, extra: object = {}) => run(m, doc([k, mem, tr, cap, g, { ...bead, span, ...extra } as Feature]));
  const rs = spanOf({ start: { v: 5 }, len: { v: 10 } });
  near(rs.cut.find(c => c.kind === "bead")!.length!, 10, 1e-3);
  near(rs.volume - rg.volume, 8 * 10, 1e-4);
  const faceC = (r: ReturnType<typeof run>) => centroid(m, r.body!.faces[r.body!.names.findIndex(n => n.startsWith("w:") && n.endsWith(":face"))]);
  const a0 = faceC(spanOf({ start: { v: 0 }, len: { v: 10 } })), a1 = faceC(spanOf({ start: { v: 0 }, len: { v: 10 }, flip: true }));
  near(Math.hypot(a0[0] - a1[0], a0[1] - a1[1], a0[2] - a1[2]), 18, 1e-3);
  // A span running past the end is cut short; one starting past it fails; intermittent welds fill only the span.
  near(spanOf({ start: { v: 20 }, len: { v: 50 } }).cut.find(c => c.kind === "bead")!.length!, 8, 1e-3);
  const past = m.evaluate(doc([k, mem, tr, cap, g, { ...bead, span: { start: { v: 30 }, len: { v: 10 } } } as Feature])).statuses.find(x => !x.ok);
  assert.match(String(past?.message ?? JSON.stringify(past)), /past the end/);
  near(spanOf({ start: { v: 5 }, len: { v: 20 } }, { inter: { len: { v: 4 }, pitch: { v: 6 } } }).cut.find(c => c.kind === "bead")!.length!, 14, 1e-3);
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
  near(r.volume - base.volume, 12.5 * 2 * Math.PI * (R + 5 / 3), 1e-3);  // Unequal legs: 5 on the plate (set 1), 8 up the tube (set 2); the triangle's centroid is still 5/3 out from the tube.
  const ru = run(m, doc([sk, plate, k, mem, { ...bead, size2: { v: 8 } } as Feature]));
  const bu = ru.cut.find(c => c.kind === "bead")!;
  assert.equal(bu.desc, "5×8");
  near(bu.length!, 2 * Math.PI * R, 1e-3);
  near(ru.volume - base.volume, 20 * 2 * Math.PI * (R + 5 / 3), 1e-3);
  const top = ru.body!.faces.map((x, i) => ({ x, n: ru.body!.names[i] })).filter(({ n }) => n.endsWith(":leg2"));
  assert.ok(top.length > 0);
  const zs = top.map(({ x }) => centroid(m, x)[2]);
  // The leg on the tube runs from the plate (z = 10) up to z = 18: its centroid sits halfway.
  for (const z of zs) near(z, 14, 1e-3);
  // Equal legs again with the same size2: one leg value in the cut list.
  assert.equal(run(m, doc([sk, plate, k, mem, { ...bead, size2: { v: 5 } } as Feature])).cut.find(c => c.kind === "bead")!.desc, "5");
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
  // Intermittent 20 every 40 round the 149.7 mm loop: welds at 0, 40, 80 and 120 (pieces over a corner fuse), 80 mm of weld.
  const ri = run(m, doc([sk, plate, k, mem, { ...bead, inter: { len: { v: 20 }, pitch: { v: 40 } } } as Feature]));
  const bi = ri.cut.filter(c => c.kind === "bead");
  assert.equal(bi.length, 1);
  near(bi[0].length!, 80, 1e-3);
  assert.deepEqual(bi[0].inter, [20, 40]);
  near(ri.volume - base.volume, 8 * 80, 2);
  // On one straight side (28 mm) with pitch 10: welds at 0, 10, 20 of 5 mm.
  const rs = run(m, doc([sk, plate, k, mem, { ...bead, tangent: false, inter: { len: { v: 5 }, pitch: { v: 10 }, stagger: true } } as Feature]));
  const bs = rs.cut.find(c => c.kind === "bead")!;
  near(bs.length!, 15, 1e-3);
  assert.deepEqual(bs.inter, [5, 10, 1]);
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
  // Polygonal profile: the same flat at both ends, a flat of its own at face 2, or the sloping edge at a profile angle.
  const area = (d3: number, d4: number) => 50 * 70 - 0.5 * (50 - d4) * (70 - d3);
  const vol = (gf: object) => run(m, doc([sk, plate, k, mem, { ...g, shape: "poly", d3: { v: 10 }, ...gf } as Feature])).volume - base.volume;
  near(vol({}), area(10, 10) * 5, 1e-6);
  near(vol({ d4: { v: 20 } }), area(10, 20) * 5, 1e-6);
  near(vol({ polyAngle: { v: Math.PI / 3 } }), area(10, 50 - 60 / Math.tan(Math.PI / 3)) * 5, 1e-6);
  near(vol({ polyAngle: { v: Math.atan2(60, 40) } }), area(10, 10) * 5, 1e-6);
  assert.deepEqual(gussetEnds({ ...g, shape: "poly", d3: { v: 10 }, d4: { v: 20 } } as GussetFeature), { d3: 10, d4: 20 });
  // Too shallow an angle runs the sloping edge past face 2: the feature fails.
  assert.ok(!m.evaluate(doc([sk, plate, k, mem, { ...g, shape: "poly", d3: { v: 10 }, polyAngle: { v: 0.5 } } as Feature])).statuses.find(x => x.id === "g")!.ok);
  // Unequal chamfer of the inner corner: 8 along face 1, 12 along face 2.
  const tri = 0.5 * 50 * 70 * 5;
  near(run(m, doc([sk, plate, k, mem, { ...g, chamfer: { v: 8 } } as Feature])).volume - base.volume, tri - 0.5 * 8 * 8 * 5, 1e-6);
  near(run(m, doc([sk, plate, k, mem, { ...g, chamfer: { v: 8 }, chamfer2: { v: 12 } } as Feature])).volume - base.volume, tri - 0.5 * 8 * 12 * 5, 1e-6);
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
  // Merge arc segment bodies: the three tangent segments become one bent member, one cut list item of the whole length.
  const rm = run(m, doc([sk, { ...mem, id: "mm", mergeArcs: true }]));
  assert.equal(rm.info.length, 1);
  near(rm.volume, A * (600 + 50 * Math.PI), 1e-4);
  assert.deepEqual(rm.cut.map(c => [c.qty, c.length, c.angle1, c.angle2]), [[1, 757.1, 0, 0]]);
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
  // Locate profile: the far corner point of the sketch on the path, in group 1 and in a group.
  const rp = run(m, doc([pr, path, { ...mem, anchor: "p:prp2" }]));
  const cp = m.props(rp.body!).com;
  near(cp[1], -20); near(cp[2], -10);
  const rg = run(m, doc([pr, path, { ...mem, groups: [{ ents: [path.ents.find(e => e.t === "line")!.id], anchor: "p:hc" }] }]));
  const cg = m.props(rg.body!).com;
  near(cg[1] + 1, 1); near(cg[2] + 1, 1);
  // Locate profile in the view: the sketch's points (one shared with a box corner listed once), the origin, then the anchors left.
  const sp = pierceSpots({ ...mem, anchor: "p:prp2" }, path.ents.find(e => e.t === "line")!.id, doc([pr, path]), rp.frames);
  assert.deepEqual(sp.map(x => x.key), ["p:prp0", "p:prp1", "p:prp2", "p:prp3", "p:hc", "t", "l", "r", "b"]);
  const at = Object.fromEntries(sp.map(x => [x.key, x.at]));
  assert.deepEqual(at["p:prp2"].map(v => Math.round(v * 1e6) / 1e6), [0, 0, 0]);
  near(at["p:prp0"][1], -40); near(at["p:prp0"][2], -20);
  // A point that is gone: the member says so.
  const gone = m.evaluate(doc([pr, path, { ...mem, anchor: "p:nope" }]));
  assert.equal(gone.statuses.find(x => x.id === "m")?.ok, false);
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

test("Trim/Extend end miter between two members (FR-FT-121)", async () => {
  const m = new Modeller(await occ());
  // Two separate beams on XY that stop short of the corner at the origin: one along X, one along Y.
  const a = poly("a", [[100, 0], [400, 0]], false), b = poly("b", [[0, 100], [0, 400]], false);
  const ma: MemberFeature = { id: "ma", type: "member", name: "Structural Member1", profile: "shs", size: "40x40x3", segs: [{ sketch: "a", ent: "al0" }], corner: "none" };
  const mb: MemberFeature = { id: "mb", type: "member", name: "Structural Member2", profile: "shs", size: "40x40x3", segs: [{ sketch: "b", ent: "bl0" }], corner: "none" };
  const base = run(m, doc([a, b, ma, mb]));
  assert.deepEqual(base.cut.map(c => [c.qty, c.length]), [[2, 300]]);
  const tr: Feature = { id: "t", type: "trimext", name: "Trim/Extend1", bodies: [{ name: "ma:al0:start" }], boundary: { name: "mb:bl0:start" }, kind: "mitre" };
  const r = run(m, doc([a, b, ma, mb, tr]));
  // Both now reach the outer corner (−20, −20): 420 long, mitred 45° at that end, square at the other; the bodies touch without overlap.
  assert.equal(r.cut.length, 1, JSON.stringify(r.cut));
  assert.equal(r.cut[0].qty, 2);
  near(r.cut[0].length!, 420, 1e-3);
  assert.deepEqual([r.cut[0].angle1, r.cut[0].angle2].sort(), [0, 45]);
  near(r.volume, 2 * (base.volume / 2) * (400 / 300), 0.01 * base.volume);
  // End butt 1: the X beam stops at the Y beam's side (x = 20), the Y beam runs on to the X beam's far side (y = −20).
  const b1 = run(m, doc([a, b, ma, mb, { ...tr, kind: "butt1" } as Feature]));
  assert.deepEqual(b1.cut.map(c => [c.qty, Math.round(c.length!), c.angle1, c.angle2]).sort(), [[1, 380, 0, 0], [1, 420, 0, 0]], JSON.stringify(b1.cut));
  // End butt 2: the other way round.
  const b2 = run(m, doc([a, b, ma, mb, { ...tr, kind: "butt2" } as Feature]));
  assert.deepEqual(b2.cut.map(c => [c.qty, Math.round(c.length!)]).sort(), [[1, 380], [1, 420]]);
  near(b1.volume, b2.volume, 1e-6 * b1.volume);  // Weld gap: a 2 mm mitre gap takes 1 mm square to the mitre plane off each end (√2 along the beams);
  // with End butt 1 the stopping member ends 3 mm short of the other's side.
  const rg = run(m, doc([a, b, ma, mb, { ...tr, gap: { v: 2 } } as Feature]));
  near(rg.cut[0].length!, 420 - Math.SQRT2, 1e-3);
  const bg = run(m, doc([a, b, ma, mb, { ...tr, kind: "butt1", gap: { v: 3 } } as Feature]));
  assert.deepEqual(bg.cut.map(c => [c.qty, Math.round(c.length!)]).sort(), [[1, 377], [1, 420]]);
});

test("cut list item keys stay put when the volume changes (FR-FT-121)", () => {
  const a = cutKey({ kind: "member", desc: "SHS 40x40x3", qty: 2, length: 420.00001, angle1: 0, angle2: 45, volume: 1, bodies: [] });
  const b = cutKey({ kind: "member", desc: "SHS 40x40x3", qty: 3, length: 420, angle1: 0, angle2: 45, volume: 2, bodies: ["x"] });
  assert.equal(a, b);
  assert.notEqual(a, cutKey({ kind: "member", desc: "SHS 40x40x3", qty: 2, length: 380, angle1: 0, angle2: 45, volume: 1, bodies: [] }));
});

test("sub-weldments split cut list items by their bodies", () => {
  const items = [
    { kind: "member" as const, desc: "SHS 40x40x3", qty: 3, length: 420, angle1: 0, angle2: 0, volume: 10, bodies: ["a", "b", "c"] },
    { kind: "bead" as const, desc: "4", qty: 2, length: 100, volume: 8, bodies: ["w1", "w2"] },
    { kind: "plate" as const, desc: "PL 5", qty: 1, plate: [50, 50, 5] as [number, number, number], volume: 1, bodies: ["p"] },
  ];
  assert.equal(splitSubs(items, undefined), items);
  const out = splitSubs(items, [{ id: "s1", name: "Frame", bodies: ["b", "w2", "p", "gone"] }, { id: "s2", name: "Empty", bodies: [] }]);
  assert.deepEqual(out.map(c => [c.kind, c.sub ?? "", c.qty, c.bodies.join()]), [
    ["member", "", 2, "a,c"], ["bead", "", 2, "w1"], ["member", "s1", 1, "b"], ["bead", "s1", 2, "w2"], ["plate", "s1", 1, "p"],
  ]);
  // A bead's volume and length share out by body; members keep their volume each.
  assert.equal(out[1].volume, 4); assert.equal(out[1].length, 50); assert.equal(out[2].volume, 10);
  assert.equal(cutKey(out[0]), cutKey(out[2]));
  // A body listed by two sub-weldments sits in the first.
  assert.deepEqual(splitSubs(items, [{ id: "x", name: "X", bodies: ["a"] }, { id: "y", name: "Y", bodies: ["a"] }]).filter(c => c.sub).map(c => c.sub), ["x"]);
});
