import { test } from "node:test";
import assert from "node:assert/strict";
import { arcRationals, fitSeg, joinShort, loopArea, reverseLoop, segEnd, segPoints, startAt } from "../../src/sheetmetal/fit";
import type { V2 } from "../../src/model/types";

const close = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const samples = (f: (t: number) => V2, n = 24): V2[] => Array.from({ length: n + 1 }, (_x, i) => f(i / n));

test("sheet metal fit: samples back to lines, arcs, circles and splines", () => {
  const ln = fitSeg(samples(t => [1 + 3 * t, 2 - t]), 1e-6);
  assert.equal(ln.kind, "line");
  const arc = fitSeg(samples(t => [5 + 2 * Math.cos(1.2 * t), -1 + 2 * Math.sin(1.2 * t)]), 1e-6);
  assert.equal(arc.kind, "arc");
  if (arc.kind === "arc") { close(arc.r, 2, 1e-9); close(arc.c[0], 5, 1e-9); close(arc.c[1], -1, 1e-9); assert.equal(arc.ccw, true); }
  const cw = fitSeg(samples(t => [2 * Math.cos(-2 * t), 2 * Math.sin(-2 * t)]), 1e-6);
  assert.ok(cw.kind === "arc" && !cw.ccw);
  const ci = fitSeg(samples(t => [3 * Math.cos(2 * Math.PI * t), 3 * Math.sin(2 * Math.PI * t)], 32), 1e-6);
  assert.equal(ci.kind, "circle");
  // An S curve is neither: a spline through every sample, starting and ending on them.
  const pts = samples(t => [10 * t, Math.sin(2 * Math.PI * t)]);
  const sp = fitSeg(pts, 1e-6);
  assert.equal(sp.kind, "spline");
  if (sp.kind === "spline") { assert.equal(sp.bz.length, 3 * (pts.length - 1) + 1); assert.deepEqual(segEnd(sp), pts[pts.length - 1]); }
});

test("sheet metal fit: loops, areas and rational arcs", () => {
  const sq: V2[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const loop = sq.map((a, i) => fitSeg([a, sq[(i + 1) % 4]], 1e-9));
  close(loopArea(loop), 12, 1e-12);
  close(loopArea(reverseLoop(loop)), -12, 1e-12);
  assert.deepEqual(segEnd(startAt(loop[0], [0.5, 0])), [4, 0]);
  const disc = [{ ent: "c", kind: "circle" as const, c: [0, 0] as V2, r: 2 }];
  close(loopArea(disc), 4 * Math.PI, 0.5);
  // A three-quarter arc becomes three quarter-turn pieces whose middle pole is at r / cos(h).
  const arc = { ent: "a", kind: "arc" as const, c: [0, 0] as V2, r: 1, a: [1, 0] as V2, b: [0, -1] as V2, ccw: true };
  const q = arcRationals(arc);
  assert.equal(q.length, 3);
  for (const p of q) { close(Math.hypot(...p.poles[1]), Math.SQRT2, 1e-12); close(p.w[1], Math.SQRT1_2, 1e-12); }
  assert.deepEqual(q[0].poles[0], [1, 0]); assert.deepEqual(q[2].poles[2], [0, -1]);
  const sp = segPoints(arc, 6);
  assert.equal(sp.length, 7);
  for (const p of sp) close(Math.hypot(...p), 1, 1e-12);
});

test("flat pattern: runs of short lines come back as circles and arcs (sheet metal exam #16)", () => {
  type L = { kind: "line"; a: V2; b: V2 };
  const ring = (c: V2, r: number, n: number, a0 = 0, sw = 2 * Math.PI): L[] => Array.from({ length: n }, (_, i) => {
    const t0 = a0 + (sw * i) / n, t1 = a0 + (sw * (i + 1)) / n;
    return { kind: "line", a: [c[0] + r * Math.cos(t0), c[1] + r * Math.sin(t0)], b: [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)] };
  });
  // A Ø4 hole as 64 facets: one circle.
  const hole = joinShort(ring([10, 10], 2, 64));
  assert.equal(hole.length, 1);
  assert.equal(hole[0].kind, "circle");
  // A slot: two long sides joined by half circles of 48 facets each: 2 lines + 2 arcs.
  const slot = [
    { kind: "line" as const, a: [0, 0] as V2, b: [20, 0] as V2 }, ...ring([20, 2], 2, 48, -Math.PI / 2, Math.PI),
    { kind: "line" as const, a: [20, 4] as V2, b: [0, 4] as V2 }, ...ring([0, 2], 2, 48, Math.PI / 2, Math.PI),
  ];
  const js = joinShort(slot);
  assert.deepEqual(js.map(e => e.kind).sort(), ["arc", "arc", "line", "line"]);
  const arc = js.find(e => e.kind === "arc") as { c: V2; r: number };
  assert.ok(Math.abs(arc.r - 2) < 1e-3);
  // Long lines alone are left as they are.
  assert.equal(joinShort([{ kind: "line", a: [0, 0], b: [5, 0] }, { kind: "line", a: [5, 0], b: [5, 5] }]).length, 2);
});
