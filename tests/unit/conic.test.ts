// Conics, parabolas and equation driven curves (FR-SK-021).
import { test } from "node:test";
import assert from "node:assert/strict";
import { conicBezier, conicShoulder, entBezier, eqBezier, parabolaFrom, rhoAt } from "../../src/sketch/conic";
import { bezPts } from "../../src/sketch/spline";
import { sketchProfile } from "../../src/sketch/profile";
import { solve } from "../../src/sketch/solver";
import type { SketchFeature, SkEnt } from "../../src/model/types";

type V2 = [number, number];
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test("conic: rho 0.5 is the exact parabola, others pass through the shoulder and stay on the conic", () => {
  const a: V2 = [0, 0], v: V2 = [10, 10], b: V2 = [20, 0];
  // Parabola through a, b tangent to a-v and v-b: y = x - x²/20.
  for (const q of bezPts(conicBezier(a, v, b, 0.5), 20)) near(q[1], q[0] - (q[0] * q[0]) / 20, 1e-9);
  // A quarter circle: tangents at right angles, w = cos 45°.
  const A: V2 = [10, 0], V: V2 = [10, 10], B: V2 = [0, 10];
  const rho = Math.SQRT1_2 / (1 + Math.SQRT1_2); // w = cos 45°
  const pts = bezPts(conicBezier(A, V, B, rho), 12);
  for (const q of pts) near(Math.hypot(q[0], q[1]), 10, 1e-5);
  const sh = conicShoulder(A, V, B, rho);
  near(Math.hypot(sh[0], sh[1]), 10, 1e-9);
  near(rhoAt(A, V, B, sh), rho, 1e-9);
});

test("parabola from focus and vertex: ends on y = x²/4f, tangents meet at the middle", () => {
  const q = parabolaFrom([0, 5], [0, 0], [-10, 3], [20, -7])!;
  near(q[0][0], -10); near(q[0][1], 100 / 20);
  near(q[2][0], 20); near(q[2][1], 400 / 20);
  near(q[1][0], 5); near(q[1][1], -200 / 20);
  for (const p of bezPts(conicBezier(q[0], q[1], q[2], 0.5), 10)) near(p[1], (p[0] * p[0]) / 20, 1e-9);
  assert.equal(parabolaFrom([0, 0], [0, 0], [1, 1], [2, 2]), null);
});

test("equation curves: explicit and parametric, placed by their end points", () => {
  const bz = eqBezier({ mode: "xy", y: "x^2/10", t0: "-10", t1: "10" });
  near(bz[0][0], -10); near(bz[0][1], 10); near(bz.at(-1)![1], 10);
  for (const p of bezPts(bz, 8)) near(p[1], (p[0] * p[0]) / 10, 1e-5);
  // Half circle, radians.
  const hc = eqBezier({ mode: "param", x: "10*cos(t)", y: "10*sin(t)", t0: "0", t1: "pi" });
  for (const p of bezPts(hc, 8)) near(Math.hypot(p[0], p[1]), 10, 1e-5);
  assert.throws(() => eqBezier({ mode: "xy", y: "q*2", t0: "0", t1: "1" }));
  assert.throws(() => eqBezier({ mode: "xy", y: "sqrt(x)", t0: "-1", t1: "1" }));
  // The entity follows its points: moved by (5, 5).
  const pts: Record<string, V2> = { a: [-5, 15], b: [15, 15] };
  const e = { id: "s", t: "spline", pts: ["a", "b"], kind: "eqn", eq: { mode: "xy", y: "x^2/10", t0: "-10", t1: "10" } } as SkEnt & { t: "spline" };
  const moved = entBezier(e, id => pts[id]);
  for (const p of bezPts(moved, 8)) near(p[1] - 5, ((p[0] - 5) ** 2) / 10, 1e-5);
  // Flipped: mirrored about the chord y = 15.
  const fl = entBezier({ ...e, eq: { ...e.eq!, flip: true } }, id => pts[id]);
  for (const p of bezPts(fl, 8)) near(15 - (p[1] - 15) - 5, ((p[0] - 5) ** 2) / 10, 1e-5);
});

test("a conic closed by a line makes a region the solver keeps defined by its points", () => {
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const sk: SketchFeature = { id: "k", type: "sketch", name: "S", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("a", 0, 0), P("v", 10, 10), P("b", 20, 0),
    { id: "c", t: "spline", pts: ["a", "v", "b"], kind: "conic", rho: 0.3 },
    { id: "l", t: "line", a: "b", b: "a" },
  ] };
  const r = solve(sk);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 6);
  const prof = sketchProfile(sk);
  assert.equal(prof.error, undefined);
  assert.equal(prof.faces.length, 1);
  const seg = prof.faces[0].outer.find(s => s.kind === "spline")!;
  assert.ok(seg && seg.kind === "spline" && seg.bz.length === 49);
});
