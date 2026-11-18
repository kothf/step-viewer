// A cross hole drilled through a round shaft: its rim on the shaft is no circle (two cylinders meet in a saddle curve),
// but seen along the hole it draws as one. Dimensions, hole callouts, centre marks and datums must take it as a circle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { ringOn, topology, type V3 } from "../../src/kernel/drawing";
import { centreMarks, dimGeo, edgeRef, factsCtx, holeEdges, holeText, projector, ringTopo, wholeCircle } from "../../src/drawing/annot";
import { ORIENTS } from "../../src/drawing/views";
import type { Feature, PartDoc, SketchFeature } from "../../src/model/types";
import { occ } from "./occ";

const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const circle = (id: string, std: "XY" | "XZ" | "YZ", x: number, y: number, r: number): SketchFeature => ({ id, type: "sketch", name: id, plane: { std }, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}o`, t: "circle", c: `${id}c`, r }] });

test("ringOn: a saddle curve on a cylinder is its circle seen along the axis", () => {
  // Hole r = 4 along Z through a shaft r = 16 along X: the rim is (4cos t, 4sin t, √(256 − 16 sin² t)).
  const q: V3[] = [];
  for (let j = 0; j <= 24; j++) { const t = 2 * Math.PI * j / 24; q.push([4 * Math.cos(t), 4 * Math.sin(t), Math.sqrt(256 - 16 * Math.sin(t) ** 2)]); }
  const g = ringOn(q, { o: [0, 0, 0], ax: [0, 0, 1], r: 4 })!;
  assert.ok(g && Math.abs(g.sp - 2 * Math.PI) < 1e-9 && g.r === 4);
  assert.ok(Math.abs(g.c[0]) < 1e-9 && Math.abs(g.c[1]) < 1e-9 && g.c[2] > 15.4 && g.c[2] < 16);
  // Half of it is an arc of π; a curve off the cylinder is none.
  const h = ringOn(q.slice(0, 13), { o: [0, 0, 0], ax: [0, 0, 1], r: 4 })!;
  assert.ok(Math.abs(h.sp - Math.PI) < 1e-9);
  assert.equal(ringOn(q, { o: [0, 0, 0], ax: [0, 0, 1], r: 5 }), null);
});

test("cross hole in a shaft: its rim is a circle in the view along the hole", async () => {
  const oc = await occ(), m = new Modeller(oc);
  // Shaft Ø32 × 80 along Z; a Ø8 hole along Y through it at z = 50.
  const r = m.evaluate(doc([circle("s1", "XY", 0, 0, 16), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 80 } },
    circle("s2", "XZ", 0, 50, 4), { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through2", depth: { v: 0 } }]));
  assert.ok(r.body, JSON.stringify(r.status));
  const topo = topology(oc, r.body!.shape, r.body!.names);
  const rims = topo.edges.filter(e => e.rg);
  assert.ok(rims.length >= 2, "both rims are found");
  for (const e of rims) assert.ok(e.t === "o" && e.rg!.length === 1 && Math.abs(e.rg![0].r - 4) < 1e-9, "the hole's ring, not the shaft's");
  // The hole runs along ±Y: find the standard view looking along it.
  const hy = Math.abs(rims[0].rg![0].ax[1]) > 0.99;
  assert.ok(hy, `hole axis ${rims[0].rg![0].ax}`);
  const name = (Object.keys(ORIENTS) as (keyof typeof ORIENTS)[]).find(k => Math.abs(Math.abs(projector(ORIENTS[k]).n[1]) - 1) < 1e-9)!;
  const { P, n } = projector(ORIENTS[name]);
  const vt = ringTopo(topo, n);
  assert.equal(ringTopo(topo, n), vt, "memoised");
  const cs = vt.edges.filter(e => e.rg && e.t === "c");
  assert.equal(cs.length, rims.length);
  for (const e of cs) assert.ok(!e.rim && wholeCircle(e, vt), "a whole circle, end-on");
  // A diameter dimension on it reads Ø8, centred on the hole.
  const e = cs[0], g = dimGeo({ id: "d", t: "dim", view: "v", k: "dia", refs: [edgeRef(e, "e")], pos: [0, 0] } as never, P, vt)!;
  assert.ok(g && Math.abs(g.value - 8) < 1e-9 && !g.dl, JSON.stringify(g));
  const pc = P([0, 0, 50]);
  assert.ok(Math.hypot(g.c![0] - pc[0], g.c![1] - pc[1]) < 1e-6, `centre ${g.c}`);
  // The centre is a point to dimension from, the hole gets a centre mark, a callout and a hole table row.
  assert.ok(centreMarks({ id: "v", name: "v", orient: name, x: 0, y: 0 }, { s: 1, uc: 0, vc: 0, x: 0, y: 0 } as never, vt, P, n).some(p => p.t === "l" && p.layer === "CENTER" && Math.hypot((p.p[0] + p.p[2]) / 2 - pc[0], (p.p[1] + p.p[3]) / 2 - pc[1]) < 1e-6), "centre mark on the hole");
  assert.equal(holeEdges(vt, P, n).length, 1);
  const txt = holeText(e, { ...factsCtx({ topo: vt, holes: [], items: [] } as never), dec: ".", label: (s: string) => s } as never);
  assert.match(txt.join(" "), /Ø8.*THRU/);
  // In the other views the curve is not a flat circle: along the shaft it stays a curve, from the side it names the cylinder.
  const top = ringTopo(topo, [0, 0, 1]);
  assert.ok(top.edges.filter(q => q.rg).every(q => q.t === "c" && q.rim), "side-on: a stand-in for the hole's outline");
  const skew = ringTopo(topo, [Math.SQRT1_2, Math.SQRT1_2, 0]);
  assert.equal(skew, topo);
});

test("cross holes off the shaft axis and blind ones are circles too", async () => {
  const oc = await occ(), m = new Modeller(oc);
  // Shaft Ø32 × 80 along Z; a Ø6 hole along Y through it 9 mm off the axis, and a Ø10 one from the middle plane out through one side.
  const r = m.evaluate(doc([circle("s1", "XY", 0, 0, 16), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 80 } },
    circle("s2", "XZ", 9, 20, 3), { id: "f2", type: "extrude", name: "C", sketch: "s2", op: "cut", end: "through2", depth: { v: 0 } },
    circle("s3", "XZ", 0, 55, 5), { id: "f3", type: "extrude", name: "B", sketch: "s3", op: "cut", end: "blind", depth: { v: 30 } }]));
  assert.ok(r.body, JSON.stringify(r.status));
  const topo = topology(oc, r.body!.shape, r.body!.names);
  const rs = topo.edges.filter(e => e.rg).map(e => e.rg![0].r).sort();
  assert.ok(rs.filter(x => Math.abs(x - 3) < 1e-9).length >= 2, `through rims ${rs}`);
  assert.ok(rs.some(x => Math.abs(x - 5) < 1e-9), `blind rim ${rs}`);
  const name = (Object.keys(ORIENTS) as (keyof typeof ORIENTS)[]).find(k => Math.abs(Math.abs(projector(ORIENTS[k]).n[1]) - 1) < 1e-9)!;
  const { P, n } = projector(ORIENTS[name]);
  const vt = ringTopo(topo, n);
  for (const e of vt.edges.filter(q => q.rg)) {
    assert.ok(e.t === "c" && !e.rim && wholeCircle(e, vt), "whole circle end-on");
    const g = dimGeo({ id: "d", t: "dim", view: "v", k: "dia", refs: [edgeRef(e, "e")], pos: [0, 0] } as never, P, vt)!;
    assert.ok(Math.abs(g.value - 2 * e.rg![0].r) < 1e-9);
  }
  assert.equal(holeEdges(vt, P, n).length, 2);
});
