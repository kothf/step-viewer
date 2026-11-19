// Convert Entities of curved edges: a tilted circle or any other curve becomes a spline along its projection,
// and an On edge relation moves that spline with its edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyExt, projectEdge, type ModelEdge } from "../../src/sketch/external";
import type { Frame, SketchFeature, V3 } from "../../src/model/types";

const XY: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] } as Frame;
const flat = (ps: V3[]) => ps.flat();

/** A circle of radius r about the X axis tilted by `tilt` from the XY plane, centred on the origin. */
function tilted(r: number, tilt: number): ModelEdge {
  const ps: V3[] = [];
  for (let k = 0; k <= 64; k++) {
    const a = 2 * Math.PI * k / 64;
    ps.push([r * Math.cos(a), r * Math.sin(a) * Math.cos(tilt), r * Math.sin(a) * Math.sin(tilt)]);
  }
  return { type: "circle", start: ps[0], end: ps[0], mid: ps[32], closed: true, center: [0, 0, 0], axis: [0, -Math.sin(tilt), Math.cos(tilt)], radius: r, pts: flat(ps) };
}

test("a tilted circle converts to a closed spline on its ellipse", () => {
  const g = projectEdge(tilted(10, Math.PI / 3), XY);
  assert.ok(g && g.t === "spline");
  assert.equal(g.closed, true);
  assert.equal(g.pts.length, 16);
  // Every point lies on the ellipse x²/100 + y²/25 = 1.
  for (const [x, y] of g.pts) assert.ok(Math.abs(x * x / 100 + y * y / 25 - 1) < 0.02, `${x}, ${y}`);
});

test("a circle square to the sketch stays a circle; an edge seen end-on gives nothing", () => {
  assert.equal(projectEdge(tilted(10, 0), XY)?.t, "circle");
  const ps: V3[] = Array.from({ length: 9 }, (_, k) => [3, 4, k]);
  assert.equal(projectEdge({ type: "curve", start: ps[0], end: ps[8], mid: ps[4], closed: false, pts: flat(ps) }, XY), null);
  assert.equal(projectEdge({ type: "curve", start: ps[0], end: ps[8], mid: ps[4], closed: false }, XY), null);
});

test("an open curve becomes a 12-point spline from end to end, and follows the edge", () => {
  const ps: V3[] = Array.from({ length: 41 }, (_, k) => { const x = k / 4; return [x, Math.sin(x), 5]; });
  const ed: ModelEdge = { type: "curve", start: ps[0], end: ps[40], mid: ps[20], closed: false, pts: flat(ps) };
  const g = projectEdge(ed, XY);
  assert.ok(g && g.t === "spline" && !g.closed);
  assert.equal(g.pts.length, 12);
  assert.deepEqual(g.pts[0], [0, 0]);
  assert.ok(Math.abs(g.pts[11][0] - 10) < 1e-9);
  // A sketch spline on it (made the other way round) follows a moved edge and keeps its direction.
  const sk = { ents: [...g.pts.map((q, i) => ({ id: `p${i}`, t: "point", x: q[0], y: q[1] })), { id: "s", t: "spline", pts: g.pts.map((_, i) => `p${11 - i}`) }] } as unknown as SketchFeature;
  const moved = projectEdge({ ...ed, pts: flat(ps.map(([x, y, z]) => [x, y + 2, z] as V3)) }, XY)!;
  assert.equal(applyExt(sk, sk.ents.at(-1)!, moved), true);
  const p11 = sk.ents.find(e => e.id === "p11") as { x: number; y: number };
  assert.ok(Math.abs(p11.x - 10) < 1e-9 && Math.abs(p11.y - Math.sin(10) - 2) < 1e-9, `${p11.x}, ${p11.y}`);
  // A spline does not follow a straight edge.
  assert.equal(applyExt(sk, sk.ents.at(-1)!, { t: "line", a: [0, 0], b: [1, 0] }), false);
});

test("an arc seen edge-on converts to a straight line between its ends", () => {
  const ps: V3[] = Array.from({ length: 17 }, (_, k) => { const a = Math.PI * k / 32; return [10 * Math.cos(a), 0, 10 * Math.sin(a)]; });
  const XZ: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] } as Frame;
  const top: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] } as Frame;
  const ed: ModelEdge = { type: "arc", start: ps[0], end: ps[16], mid: ps[8], closed: false, center: [0, 0, 0], axis: [0, 1, 0], radius: 10, pts: flat(ps) };
  assert.equal(projectEdge(ed, XZ)?.t, "arc");
  const g = projectEdge(ed, top);
  assert.ok(g && g.t === "line");
  assert.ok(Math.abs(g.a[0] - 10) < 1e-9 && Math.abs(g.b[0]) < 1e-9, JSON.stringify(g));
});

test("a circle seen edge-on converts to a line across it", () => {
  const g = projectEdge(tilted(10, Math.PI / 2), XY);
  assert.ok(g && g.t === "line", JSON.stringify(g));
  assert.ok(Math.abs(Math.abs(g.a[0] - g.b[0]) - 20) < 1e-6);
});
