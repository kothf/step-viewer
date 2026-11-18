// Annotations on a side view of a round part (a flange seen from the front): leaders and symbols land on the lines
// the view draws (a cylinder's outline, a circle seen edge-on), not in the air beside them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MEdge, Topo, V3 } from "../../src/kernel/drawing";
import { edgeFoot, leaderEnd, viewAnnots, type AnnotCtx } from "../../src/drawing/annot";
import type { DrawingView, GeoRef, Sheet } from "../../src/drawing/types";

const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
// Disc Ø100 × 10 on z = 0..10 about Z, a Ø10 through hole at x = 30. Front view: sheet x = model x, sheet y = model z.
const circ = (k: string, c: V3, r: number): MEdge => ({ k, t: "c", a: [c[0] + r, c[1], c[2]], b: [c[0] + r, c[1], c[2]], m: [c[0] - r, c[1], c[2]], c, ax: [0, 0, 1], r, sp: 2 * Math.PI });
const topo: Topo = {
  edges: [circ("side|top", [0, 0, 10], 50), circ("bot|side", [0, 0, 0], 50), circ("hole|top", [30, 0, 10], 5), circ("bot|hole", [30, 0, 0], 5),
    // The seams of the two cylinders (not drawn).
    { k: "side", t: "l", a: [50, 0, 0], b: [50, 0, 10], m: [50, 0, 5] }, { k: "hole", t: "l", a: [35, 0, 0], b: [35, 0, 10], m: [35, 0, 5] }],
  cyls: [{ o: [0, 0, 0], ax: [0, 0, 1], r: 50, v0: 0, v1: 10, sp: 2 * Math.PI, f: "side" }, { o: [30, 0, 0], ax: [0, 0, 1], r: 5, v0: 0, v1: 10, sp: 2 * Math.PI, f: "hole", in: true }],
};
const P = (p: V3): [number, number] => [p[0], p[2]];
const pl = { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never;
const R = (k: string, s?: 1 | -1): GeoRef => ({ e: k, h: topo.edges.find(e => e.k === k)!.m, p: "e", ...(s ? { s } : {}) });

test("side view of a round part: datums and symbols stand on the outline or the edge-on face line", () => {
  // The outline on the left of the axis (sheet x = −50): the foot is on it, at the height of the text.
  const left = edgeFoot(R("side|top", -1), topo, P, pl, [-80, 4])!;
  near(left.at[0], 50 * (left.at[0] < 0 ? -1 : 1));
  near(Math.abs(left.at[0]), 50); near(left.at[1], 4);
  assert.ok(Math.abs(left.d[0]) < 1e-9, "along the outline");
  const right = edgeFoot(R("side|top", 1), topo, P, pl, [80, 30])!;
  near(Math.abs(right.at[0]), 50); assert.ok(Math.sign(right.at[0]) !== Math.sign(left.at[0]), "the other side");
  near(right.at[1], 10, 1e-6);
  // The top face's rim seen edge-on is the line z = 10 from x = −50 to 50: the foot is right under the text.
  const top = edgeFoot(R("side|top"), topo, P, pl, [20, 40])!;
  near(top.at[0], 20); near(top.at[1], 10);
  assert.ok(Math.abs(top.d[1]) < 1e-9, "along the face line");
  // Leaders of notes and tolerance frames end at the middle of the outline, not on the axis.
  const le = leaderEnd(R("hole|top", 1), P, topo)!;
  near(Math.abs(le[0] - 30), 5); near(le[1], 5);
  // Seen end-on (a top view) nothing changes: the rim point towards the text, the leader at the centre.
  const Ptop = (p: V3): [number, number] => [p[0], p[1]];
  const f = edgeFoot(R("hole|top"), topo, Ptop, pl, [30, 40])!;
  near(f.at[0], 30); near(f.at[1], 5);
  assert.deepEqual(leaderEnd(R("hole|top"), Ptop, topo), [30, 0]);
});

test("side view of a round part: every leader annotation lands on the line it was put on", () => {
  const sheet = { id: "s", name: "Sheet1", size: "A3", scale: [1, 1], projection: "first", views: [] } as unknown as Sheet;
  const view: DrawingView = { id: "v", name: "Front", orient: "front", x: 0, y: 0 };
  const ctx: AnnotCtx = { topo, holes: [], items: [], box: null, dec: ".", label: s => s };
  const run = (a: object) => viewAnnots({ ...sheet, views: [view], annots: [{ id: "a", view: "v", ...a }] } as unknown as Sheet, view, pl, ctx);
  // The front view's own projection, so the test reads the same axes as the code.
  const out = run({ t: "hole", ref: R("bot|hole", 1), pos: [60, 30] });
  assert.deepEqual(out.dangling, []);
  const lines = out.prims.filter(p => p.t === "l").map(p => (p as { p: number[] }).p);
  // The leader ends on one of the hole's hidden lines (x = 25 or 35 in view axes), between its faces.
  const ends = lines.flatMap(l => [[l[0], l[1]], [l[2], l[3]]]);
  assert.ok(ends.some(([x, y]) => (Math.abs(Math.abs(x) - 25) < 1e-6 || Math.abs(Math.abs(x) - 35) < 1e-6) && y >= -1e-6 && y <= 10 + 1e-6), `hole leader on its outline: ${JSON.stringify(ends)}`);
  assert.ok(out.prims.some(p => p.t === "t" && /Ø10/.test((p as { s: string }).s)), "the callout still reads the hole");
  for (const a of [
    { t: "datum", ref: R("side|top", 1), pos: [80, 5], letter: "A" },
    { t: "surf", ref: R("side|top"), pos: [0, 30], proc: "removal", text: "Ra 3.2" },
    { t: "weld", leader: R("side|top", -1), pos: [-90, 20], arrow: { sym: "fillet", size: "a4" } },
    { t: "dtarget", leader: R("side|top"), pos: [10, 40], label: "A1", kind: "point" },
    { t: "note", leader: R("bot|hole", -1), pos: [40, 40], text: "N" },
    { t: "gtol", leader: R("bot|hole", 1), pos: [40, 40], rows: [{ sym: "pos", tol: "0.1", dia: true, datums: ["A"] }] },
  ]) {
    const o = run(a);
    assert.deepEqual(o.dangling, [], a.t);
    const pts = o.prims.flatMap(p => p.t === "l" || p.t === "p" ? (p as { p: number[] }).p : []);
    const xy: [number, number][] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) xy.push([pts[i], pts[i + 1]]);
    // Something of it touches the part's drawn lines: the outlines x = ±50 / the hole's ±5 about 30, or the face lines z = 0, 10.
    const onPart = xy.some(([x, y]) => (y > -1e-6 && y < 10 + 1e-6 && [50, 25, 35].some(v => Math.abs(Math.abs(x) - v) < 1e-6)) || ((Math.abs(y) < 1e-6 || Math.abs(y - 10) < 1e-6) && Math.abs(x) <= 50 + 1e-6));
    assert.ok(onPart, `${a.t} touches the part: ${JSON.stringify(xy.slice(0, 12))}`);
  }
});

test("side view of a turned part: a chamfer's cone outline against the end face gives an angle and 2 × 45° (exam #50)", async () => {
  const { dimGeo, refLine, coneMid, edgeFoot: foot } = await import("../../src/drawing/annot");
  // Shaft Ø20 along X up to x = 50, a 2 × 45° chamfer to Ø16 at x = 52, end face there. Top view: sheet x, y = model x, y.
  const cone = { k: "cone" as const, o: [50, 0, 0] as V3, ax: [1, 0, 0] as V3, v0: 0, v1: 2, r0: 10, r1: 8, sp: 2 * Math.PI, f: "cone" };
  const end: MEdge = { k: "cone|end", t: "c", a: [52, 8, 0], b: [52, 8, 0], m: [52, -8, 0], c: [52, 0, 0], ax: [1, 0, 0], r: 8, sp: 2 * Math.PI };
  const t2: Topo = { edges: [end, { k: "cone", t: "l", a: [50, 0, 10], b: [52, 0, 8], m: [51, 0, 9] }], cyls: [], revs: [cone] };
  const Pt = (p: V3): [number, number] => [p[0], p[1]];
  const cr = (s: 1 | -1): GeoRef => ({ e: "cone", h: coneMid(cone), p: "e", s, rv: true });
  const up = refLine(cr(1), Pt, t2)!, dn = refLine(cr(-1), Pt, t2)!;
  assert.deepEqual([up, dn].map(l => l.map(q => q.map(v => Math.round(v * 1e6) / 1e6))), [[[50, 10], [52, 8]], [[50, -10], [52, -8]]]);
  const er = { e: "cone|end", h: end.m, p: "e" as const };
  const mk = (k: "ang" | "chamfer") => ({ id: "d", t: "dim" as const, view: "v", k, refs: [cr(1), er], pos: [56, 14] as [number, number] });
  assert.ok(dimGeo(mk("ang"), Pt, t2), "an angle between the outline and the edge-on end face");
  const ch = dimGeo(mk("chamfer"), Pt, t2)!;
  near(ch.value, 2); near(ch.ang!, 45);
  // A datum or a note on the chamfer's outline lands on it.
  const f = foot(cr(1), t2, Pt, pl, [60, 20])!;
  assert.ok(f.at[0] >= 50 - 1e-9 && f.at[0] <= 52 + 1e-9 && Math.abs(f.at[1] - (10 - (f.at[0] - 50))) < 1e-9, JSON.stringify(f));
  // End-on (looking along the axis) the cone has no outline line.
  assert.equal(refLine(cr(1), (p: V3) => [p[1], p[2]], t2), null);
});
