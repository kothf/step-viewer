import { test } from "node:test";
import assert from "node:assert/strict";
import { arcRationals, fitSeg, loopArea, reverseLoop, segEnd, segPoints, startAt } from "../../src/sheetmetal/fit";
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
