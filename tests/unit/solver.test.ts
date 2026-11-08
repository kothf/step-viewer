// Solver acceptance set (FRS 16.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, tryAdd, measureDim, ORIGIN, freeDirections, repairs, curveJoint } from "../../src/sketch/solver";
import { entBezier } from "../../src/sketch/conic";
import { piercePoint } from "../../src/sketch/external";
import type { SketchFeature, SkEnt, SkRel, SkDim } from "../../src/model/types";

const sk = (ents: SkEnt[], rels: SkRel[] = [], dims: SkDim[] = []): SketchFeature => ({ id: "s", type: "sketch", name: "S", plane: { std: "XY" }, ents, rels, dims });
const pt = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
const ln = (id: string, a: string, b: string): SkEnt => ({ id, t: "line", a, b });
const rel = (t: SkRel["t"], ...e: string[]): SkRel => ({ id: `r${Math.random()}`, t, e });
const dim = (t: SkDim["t"], v: number, ...e: string[]): SkDim => ({ id: `d${Math.random()}`, name: "D", t, e, val: { v } });
const P = (s: SketchFeature, id: string) => { const e = s.ents.find(x => x.id === id)!; return e.t === "point" ? [e.x, e.y] : null; };
const near = (a: number, b: number, tol = 1e-7) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function rectangle() {
  return sk(
    [pt("a", -4, -3), pt("b", 6, -2.5), pt("c", 5.5, 3.2), pt("d", -4.2, 2.8), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d"), ln("l4", "d", "a")],
    [rel("horizontal", "l1"), rel("horizontal", "l3"), rel("vertical", "l2"), rel("vertical", "l4")],
  );
}

test("rectangle: DOF counts down to fully defined (1)", () => {
  const s = rectangle();
  let r = solve(s);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 4);
  s.dims.push(dim("distance", 100, "l1"), dim("distance", 60, "l2"));
  r = solve(s);
  assert.equal(r.dof, 2);
  // Centre on the origin: midpoint of a diagonal construction line.
  s.ents.push(ln("diag", "a", "c"));
  (s.ents.at(-1) as any).cons = true;
  s.rels.push(rel("midpoint", ORIGIN, "diag"));
  r = solve(s);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 0);
  assert.ok(r.defined.has("l1") && r.defined.has("c"));
  near(P(s, "a")![0], -50); near(P(s, "a")![1], -30); near(P(s, "c")![0], 50); near(P(s, "c")![1], 30);
});

test("slot with tangent arcs and equal radii (2)", () => {
  const s = sk([
    pt("c1", 0, 0), pt("c2", 30, 1), pt("a1", 0, 5), pt("b1", 0, -5), pt("a2", 30, -5), pt("b2", 30, 5),
    { id: "arc1", t: "arc", c: "c1", a: "a1", b: "b1" }, { id: "arc2", t: "arc", c: "c2", a: "a2", b: "b2" },
    ln("top", "b2", "a1"), ln("bot", "b1", "a2"),
  ], [rel("tangent", "top", "arc1"), rel("tangent", "top", "arc2"), rel("tangent", "bot", "arc1"), rel("tangent", "bot", "arc2"), rel("equal", "arc1", "arc2"), rel("horizontal", "c1", "c2"), rel("coincident", "c1", ORIGIN)],
  [dim("radius", 5, "arc1"), dim("distance", 40, "c1", "c2")]);
  const r = solve(s);
  assert.equal(r.status, "ok");
  near(P(s, "c2")![0], 40, 1e-6);
  near(Math.hypot(P(s, "a2")![0] - 40, P(s, "a2")![1]), 5, 1e-6);
});

test("over-defined triangle is refused (3)", () => {
  const s = sk([pt("a", 0, 0), pt("b", 10, 0), pt("c", 3, 8), ln("ab", "a", "b"), ln("bc", "b", "c"), ln("ca", "c", "a")],
    [rel("coincident", "a", ORIGIN), rel("horizontal", "ab")],
    [dim("distance", 10, "ab"), dim("distance", 10, "bc"), dim("distance", 10, "ca")]);
  assert.equal(solve(s).status, "ok");
  const r = tryAdd(s, { dim: dim("angle", Math.PI / 2, "ab", "ca") });
  assert.equal(r.ok, false);
  assert.equal(r.sketch, s);
});

test("200-entity profile solves fast (4)", () => {
  const ents: SkEnt[] = [], rels: SkRel[] = [], dims: SkDim[] = [];
  const n = 60;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    ents.push(pt(`p${i}`, 50 * Math.cos(t) + Math.random(), 50 * Math.sin(t) + Math.random()));
  }
  for (let i = 0; i < n; i++) { ents.push(ln(`l${i}`, `p${i}`, `p${(i + 1) % n}`)); dims.push(dim("distance", 5, `l${i}`)); }
  for (let i = 0; i < n; i++) ents.push({ id: `c${i}`, t: "circle", c: `p${i}`, r: 1 + Math.random() }), rels.push(rel("equal", `c${i}`, "c0"));
  const s = sk(ents, rels, dims);
  const t0 = performance.now();
  const r = solve(s);
  const ms = performance.now() - t0;
  assert.equal(r.status, "ok");
  assert.ok(ms < 2000, `${ms} ms`);
});

test("dragging a four-bar linkage keeps lengths (5)", () => {
  const s = sk([pt("a", 0, 0), pt("b", 10, 0), pt("c", 12, 8), pt("d", 2, 9), ln("ab", "a", "b"), ln("bc", "b", "c"), ln("cd", "c", "d"), ln("da", "d", "a")],
    [rel("fix", "a"), rel("fix", "b")], [dim("distance", 10, "bc"), dim("distance", 12, "cd"), dim("distance", 9, "da")]);
  solve(s);
  for (let k = 0; k < 10; k++) {
    const d = P(s, "d")!;
    const r = solve(s, { point: "d", to: [d[0] - 0.3, d[1] + 0.1] });
    assert.equal(r.status, "ok");
    near(Math.hypot(P(s, "d")![0], P(s, "d")![1]), 9, 1e-6);
    near(Math.hypot(P(s, "c")![0] - P(s, "d")![0], P(s, "c")![1] - P(s, "d")![1]), 12, 1e-6);
  }
});

test("large change keeps the shape (6)", () => {
  const s = rectangle();
  s.dims.push(dim("distance", 10, "l1"), dim("distance", 6, "l2"));
  s.rels.push(rel("coincident", "a", ORIGIN));
  solve(s);
  s.dims[0].val.v = 1000;
  assert.equal(solve(s).status, "ok");
  near(P(s, "b")![0], 1000, 1e-6);
  near(P(s, "c")![1], 6, 1e-6);
});

test("redundant but consistent relation (7)", () => {
  const s = rectangle();
  const r = tryAdd(s, { rel: rel("parallel", "l1", "l3") });
  assert.equal(r.ok, true);
  assert.equal(r.redundant, true);
  near(measureDim(r.sketch, { t: "distance", e: ["l1"] }), Math.hypot(P(r.sketch, "b")![0] - P(r.sketch, "a")![0], P(r.sketch, "b")![1] - P(r.sketch, "a")![1]));
});

test("ellipse: 5 DOF, arc ends stay on it, fully defined by dimensions (FR-SK-018)", () => {
  const e: SkEnt = { id: "e", t: "ellipse", c: "c", a: "a", b: "b" };
  const s = sk([pt("c", 0, 0), pt("a", 10, 1), pt("b", -0.5, 4), e]);
  let r = solve(s);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 5);
  // b is pulled square to the major axis.
  const [cx, cy] = P(s, "c")!, [ax, ay] = P(s, "a")!, [bx, by] = P(s, "b")!;
  near((ax - cx) * (bx - cx) + (ay - cy) * (by - cy), 0, 1e-6);
  s.rels.push(rel("coincident", "c", ORIGIN), rel("horizontal", "c", "a"));
  s.dims.push(dim("distance", 20, "c", "a"), dim("distance", 6, "c", "b"));
  r = solve(s);
  assert.equal(r.dof, 0);
  near(P(s, "a")![0], 20, 1e-6); near(Math.abs(P(s, "b")![1]), 6, 1e-6);
  // Elliptical arc: drag an end; it stays on the ellipse.
  const arc = sk([pt("c", 0, 0), pt("a", 10, 0), pt("b", 0, 5), pt("p", 10, 0), pt("q", 0, 5), { id: "e", t: "ellipse", c: "c", a: "a", b: "b", p0: "p", p1: "q" }],
    [rel("fix", "c"), rel("fix", "a"), rel("fix", "b")]);
  r = solve(arc, { point: "q", to: [-6, 6] });
  assert.equal(r.status, "ok");
  const [qx, qy] = P(arc, "q")!;
  near((qx / 10) ** 2 + (qy / 5) ** 2, 1, 1e-6);
  // A point placed on the ellipse with onCurve.
  arc.ents.push(pt("z", 3, 3));
  arc.rels.push(rel("onCurve", "z", "e"));
  solve(arc);
  const [zx, zy] = P(arc, "z")!;
  near((zx / 10) ** 2 + (zy / 5) ** 2, 1, 1e-6);
});

test("under-defined analysis: free directions of points (FR-SLV-010)", () => {
  // A horizontal line from the origin: its start is fixed, its end slides along X only.
  const s = sk([pt("a", 0, 0), pt("b", 5, 0.5), ln("l", "a", "b")], [rel("coincident", "a", ORIGIN), rel("horizontal", "l")]);
  solve(s);
  let f = freeDirections(s, ["a", "b"]);
  assert.equal(f.get("a")!.length, 0);
  assert.equal(f.get("b")!.length, 1);
  near(Math.abs(f.get("b")![0][0]), 1); near(f.get("b")![0][1], 0);
  // A loose point moves both ways; dimensioning the line fixes its end.
  s.ents.push(pt("c", 3, 3));
  f = freeDirections(s, ["c"]);
  assert.equal(f.get("c")!.length, 2);
  s.dims.push(dim("distance", 10, "l"));
  solve(s);
  assert.equal(freeDirections(s, ["b"]).get("b")!.length, 0);
});

test("sketch assistant: removals that fix an over-defined sketch (FR-SLV-009)", () => {
  const s = rectangle();
  const w = dim("distance", 100, "l1"), h = dim("distance", 60, "l2"), bad = dim("distance", 80, "l3");
  s.dims.push(w, h, bad);
  assert.equal(solve(structuredClone(s)).status, "conflict");
  const sets = repairs(s);
  // Deleting either width (top or bottom) or a horizontal/vertical that ties them fixes it; the height does not.
  assert.ok(sets.length > 0 && sets.every(x => x.length === 1));
  assert.ok(sets.some(x => x[0] === bad.id) && sets.some(x => x[0] === w.id));
  assert.ok(!sets.some(x => x[0] === h.id));
  for (const [id] of sets) {
    const c = structuredClone(s);
    c.rels = c.rels.filter(r => r.id !== id); c.dims = c.dims.filter(d => d.id !== id);
    assert.equal(solve(c).status, "ok");
  }
  // A solvable sketch needs nothing.
  assert.deepEqual(repairs(rectangle()), []);
});

test("intersection relation: a point where two curves cross (FR-SK-051)", () => {
  // Line y = x from (0,0) to (10,10), circle r 5 round (0,0) fixed; the point starts off both.
  const s = sk([pt("a", 0, 0), pt("b", 10, 10), ln("l", "a", "b"), pt("c", 0, 0), { id: "k", t: "circle", c: "c", r: 5 }, pt("p", 4.5, 2)],
    [rel("fix", "l"), rel("fix", "k"), rel("intersection", "p", "l", "k")]);
  const r = solve(s);
  assert.equal(r.status, "ok");
  const [x, y] = P(s, "p")!;
  near(x, 5 / Math.SQRT2, 1e-6); near(y, 5 / Math.SQRT2, 1e-6);
  assert.ok(r.defined.has("p"));
});

test("diameter about a centerline and ordinate dimensions (FR-SK-063)", () => {
  // Centerline on the Y axis; a diameter of 16 puts the point 8 from it.
  const s = sk([pt("a", 0, 0), pt("b", 0, 10), { id: "cl", t: "line", a: "a", b: "b", cons: true }, pt("p", 5, 3)], [rel("fix", "cl")]);
  const d: SkDim = { ...dim("distance", 0, "cl", "p"), dia: true };
  near(measureDim(s, d), 10);
  d.val.v = 16;
  s.dims.push(d);
  assert.equal(solve(s).status, "ok");
  near(P(s, "p")![0], 8, 1e-6);
  // Ordinate: horizontal distances from the origin to two points.
  const o = sk([pt("q", 3, 1), pt("r", 7, -2)], [], [{ ...dim("hdistance", 20, ORIGIN, "q"), ord: true }, { ...dim("hdistance", 35, ORIGIN, "r"), ord: true }]);
  assert.equal(solve(o).status, "ok");
  near(P(o, "q")![0], 20, 1e-6); near(P(o, "r")![0], 35, 1e-6);
});

test("tangency at a shared end counts once: a fully dimensioned slot has 0 DOF (exam bug 13)", () => {
  const s = sk([
    pt("c1", 0, 0), pt("c2", 30, 1), pt("a1", 0, 5), pt("b1", 0, -5), pt("a2", 30, -5), pt("b2", 30, 5),
    { id: "arc1", t: "arc", c: "c1", a: "a1", b: "b1" }, { id: "arc2", t: "arc", c: "c2", a: "a2", b: "b2" },
    ln("top", "b2", "a1"), ln("bot", "b1", "a2"),
  ], [rel("tangent", "top", "arc1"), rel("tangent", "top", "arc2"), rel("tangent", "bot", "arc1"), rel("tangent", "bot", "arc2"), rel("equal", "arc1", "arc2"), rel("horizontal", "c1", "c2"), rel("coincident", "c1", ORIGIN)],
  [dim("radius", 5, "arc1"), dim("distance", 40, "c1", "c2")]);
  const r = solve(s);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 0);
});

test("spline tangent and equal curvature at a shared end (FR-SK-050, FR-SK-051)", () => {
  type Sp = SkEnt & { t: "spline" };
  const xy = (s: SketchFeature) => (id: string) => P(s, id) as [number, number];
  const endOf = (s: SketchFeature, id: string) => {
    const e = s.ents.find(x => x.id === id) as Sp;
    const bz = entBezier(e, xy(s));
    const [b0, b1, b2] = bz;
    const d1 = [b1[0] - b0[0], b1[1] - b0[1]], d2 = [b2[0] - 2 * b1[0] + b0[0], b2[1] - 2 * b1[1] + b0[1]];
    const l = Math.hypot(d1[0], d1[1]);
    return { t: [d1[0] / l, d1[1] / l], k: (2 / 3) * (d1[0] * d2[1] - d1[1] * d2[0]) / l ** 3 };
  };
  // A line into an interpolating spline: tangency moves the free spline point.
  const s1 = sk(
    [pt("a", -10, 0), pt("b", 0, 0), pt("q", 5, 3), pt("c", 10, 0), ln("l", "a", "b"), { id: "s", t: "spline", pts: ["b", "q", "c"] }],
    [rel("fix", "l"), rel("fix", "c")],
  );
  const dof0 = solve(s1).dof;
  const r1 = tryAdd(s1, { rel: rel("tangent", "l", "s") });
  assert.ok(r1.ok);
  assert.equal(r1.result.dof, dof0 - 1);
  const e1 = endOf(r1.sketch, "s");
  near(Math.abs(e1.t[1]), 0, 1e-6);
  assert.ok(e1.t[0] > 0, "the spline carries on from the line");
  // An arc into a style spline: equal curvature = tangent and the same turn (1/r) at the joint.
  const s2 = sk(
    [pt("o", 0, 0), pt("a", 10, 0), pt("b", 0, 10), { id: "k", t: "arc", c: "o", a: "a", b: "b" },
      pt("p1", -4, 11), pt("p2", -8, 9), pt("p3", -11, 5), pt("p4", -12, 0), { id: "s", t: "spline", kind: "style", pts: ["b", "p1", "p2", "p3", "p4"] }],
    [rel("fix", "k"), rel("fix", "p4")],
  );
  const dof2 = solve(s2).dof;
  const r2 = tryAdd(s2, { rel: rel("curvature", "k", "s") });
  assert.ok(r2.ok);
  assert.equal(r2.result.dof, dof2 - 2);
  const e2 = endOf(r2.sketch, "s");
  near(e2.t[0], -1, 1e-6);
  near(e2.k, 0.1, 1e-6);
  // Ends held together by a coincident relation count as a joint; curves apart have none.
  const s3 = sk([pt("a", 0, 0), pt("b", 5, 0), pt("c", 5, 0), pt("d", 9, 2), pt("e", 12, 0), ln("l", "a", "b"), { id: "s", t: "spline", pts: ["c", "d", "e"] }],
    [rel("coincident", "b", "c")]);
  assert.deepEqual(curveJoint(s3, "l", "s"), ["b", "c"]);
  s3.rels = [];
  assert.equal(curveJoint(s3, "l", "s"), null);
});

test("pierce: crossing points and the held point (FR-SK-051)", () => {
  const F = { o: [0, 0, 0] as [number, number, number], x: [1, 0, 0] as [number, number, number], y: [0, 1, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number] };
  const near = (q: number[] | null, x: number, y: number) => { assert.ok(q); assert.ok(Math.hypot(q[0] - x, q[1] - y) < 1e-9, `${q} ≠ ${x},${y}`); };
  // A slanted line, extended past its ends.
  near(piercePoint({ type: "line", start: [1, 2, 3], end: [2, 4, 5], mid: [1.5, 3, 4], closed: false }, F, [0, 0]), -0.5, -1);
  // In the plane: none.
  assert.equal(piercePoint({ type: "line", start: [0, 0, 0], end: [1, 0, 0], mid: [0.5, 0, 0], closed: false }, F, [0, 0]), null);
  // A circle of radius 5 about X through the origin crosses at y = ±5; the nearer one wins.
  const c = { type: "circle", start: [0, 5, 0] as [number, number, number], end: [0, 5, 0] as [number, number, number], mid: [0, -5, 0] as [number, number, number], closed: true, center: [0, 0, 0] as [number, number, number], axis: [1, 0, 0] as [number, number, number], radius: 5 };
  near(piercePoint(c, F, [0, 4]), 0, 5);
  near(piercePoint(c, F, [0, -4]), 0, -5);
  // Lifted 6 above the plane, it never reaches it.
  assert.equal(piercePoint({ ...c, center: [0, 0, 6] }, F, [0, 0]), null);
  // Other curves by their polyline.
  near(piercePoint({ type: "curve", start: [0, 0, -1], end: [2, 0, 1], mid: [1, 0, 0], closed: false, pts: [0, 0, -1, 1, 0, -0.5, 2, 0, 1] }, F, [0, 0]), 4 / 3, 0);
  // The solver holds a pierced point like a fixed one.
  const s = sk([pt("p", 3, 4), pt("q", 0, 0), ln("l", "p", "q")], [{ id: "r", t: "pierce", e: ["p"], ext: { faces: ["a", "b"] } }, rel("horizontal", "l")]);
  const r = solve(s);
  assert.equal(r.status, "ok");
  const p = s.ents.find(e => e.id === "p") as SkEnt & { t: "point" };
  assert.ok(Math.abs(p.x - 3) < 1e-9 && Math.abs(p.y - 4) < 1e-9);
});

test("offset relations: the copy follows its source and one dimension (FR-SK-034)", () => {
  // An L chain p1-p2-p3 held by fixes, offset 2 to its left (inside).
  const fix = (id: string): SkRel => ({ id: `f${id}`, t: "fix", e: [id] });
  const lead: SkRel = { id: "o1", t: "offset", e: ["l1", "m1", "p1", "q1"] };
  const dd = dim("distance", 2, "l1", "m1");
  const s = sk(
    [pt("p1", 0, 0), pt("p2", 10, 0), pt("p3", 10, 10), ln("l1", "p1", "p2"), ln("l2", "p2", "p3"),
      pt("q1", 0, 2), pt("q2", 8, 2), pt("q3", 8, 10), ln("m1", "q1", "q2"), ln("m2", "q2", "q3")],
    [fix("p1"), fix("p2"), fix("p3"), rel("parallel", "l1", "m1"), rel("parallel", "l2", "m2"), lead, { id: "o2", t: "offset", e: ["l2", "m2", "p3", "q3"], of: "o1" }],
    [dd],
  );
  let r = solve(s);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 0);
  // The source moves: the copy keeps its distance and its ends stay square to the source ends.
  const p3 = s.ents.find(e => e.id === "p3") as SkEnt & { t: "point" }, p2 = s.ents.find(e => e.id === "p2") as SkEnt & { t: "point" };
  p3.x = 14; p2.x = 14;
  r = solve(s);
  assert.equal(r.status, "ok");
  near(P(s, "q2")![0], 12); near(P(s, "q2")![1], 2); near(P(s, "q3")![0], 12); near(P(s, "q3")![1], 10); near(P(s, "q1")![0], 0);
  // One dimension drives every segment.
  dd.val.v = 3;
  r = solve(s);
  assert.equal(r.status, "ok");
  near(P(s, "q1")![1], 3); near(P(s, "q2")![0], 11); near(P(s, "q3")![0], 11);
  // Concentric curves: the radial offset dimension.
  const c = sk([pt("c", 0, 0), { id: "k", t: "circle", c: "c", r: 10 }, { id: "k2", t: "circle", c: "c", r: 12 }, { id: "k3", t: "circle", c: "c", r: 8 }],
    [fix("c"), { id: "o", t: "offset", e: ["k", "k2"] }, { id: "o3", t: "offset", e: ["k", "k3"], of: "o" }],
    [dim("radius", 10, "k"), { ...dim("distance", 2, "k", "k2"), off: true }]);
  assert.equal(measureDim(c, { t: "distance", e: ["k", "k2"], off: true }), 2);
  (c.dims[0].val as { v: number }).v = 20;
  r = solve(c);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 0);
  const rad = (id: string) => (c.ents.find(e => e.id === id) as SkEnt & { t: "circle" }).r;
  near(rad("k2"), 22); near(rad("k3"), 18);
});
