// Tangent chains for fillet/chamfer picking (FR-SEL-005).
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeLoop, sameEdges, tangentChain } from "../../src/model/chain";
import type { EdgeInfo } from "../../src/topology";

type P = [number, number, number];
const edge = (id: number, pts: P[], extra: Partial<EdgeInfo> = {}): EdgeInfo => ({
  id, pts: pts.flat(), faces: [id, id + 100], closed: false, length: 1, type: "line",
  start: pts[0], end: pts[pts.length - 1], mid: pts[Math.floor(pts.length / 2)], ...extra,
});

test("a line, a quarter arc and a line join smoothly; a corner stops the chain", () => {
  const a = edge(1, [[0, 0, 0], [10, 0, 0]]);
  // Coarse tessellation on purpose: the arc's exact tangent is used, not its chords.
  const arcPts: P[] = [0, 1, 2, 3].map(k => { const t = -Math.PI / 2 + (k * Math.PI) / 6; return [10 + 5 * Math.cos(t), 5 + 5 * Math.sin(t), 0]; });
  const arc = edge(2, arcPts, { type: "arc", center: [10, 5, 0], axis: [0, 0, 1], radius: 5 });
  const b = edge(3, [[15, 5, 0], [15, 10, 0]]);
  const corner = edge(4, [[0, 10, 0], [0, 0, 0]]);
  const ids = tangentChain([a, arc, b, corner], a).map(e => e.id).sort();
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(tangentChain([a, arc, b, corner], corner).map(e => e.id), [4]);
});

test("select loop follows one face's boundary; same-size edges match by radius or length", () => {
  // Top face 7 of a box: four edges; a side face 8 shares one of them; a hole circle in face 7.
  const e = (id: number, a: P, b: P, faces: [number, number], extra: Partial<EdgeInfo> = {}) => ({ ...edge(id, [a, b], extra), faces, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) });
  const t1 = e(1, [0, 0, 5], [10, 0, 5], [7, 8]), t2 = e(2, [10, 0, 5], [10, 6, 5], [7, 9]), t3 = e(3, [10, 6, 5], [0, 6, 5], [7, 10]), t4 = e(4, [0, 6, 5], [0, 0, 5], [7, 11]);
  const b1 = e(5, [0, 0, 0], [10, 0, 0], [8, 12]), s1 = e(6, [0, 0, 0], [0, 0, 5], [8, 11]), s2 = e(13, [10, 0, 0], [10, 0, 5], [8, 9]);
  const hole = { ...edge(20, [[4, 3, 5], [5, 4, 5], [4, 3, 5]], { type: "circle", radius: 1, center: [5, 3, 5], axis: [0, 0, 1] }), faces: [7, 30] as [number, number], closed: true, start: [4, 3, 5] as P, end: [4, 3, 5] as P };
  const hole2 = { ...hole, id: 21, faces: [12, 31] as [number, number] };
  const all = [t1, t2, t3, t4, b1, s1, s2, hole, hole2];
  assert.deepEqual(edgeLoop(all, t1, 7).map(x => x.id).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual(edgeLoop(all, t1, 8).map(x => x.id).sort((a, b) => a - b), [1, 5, 6, 13]);
  assert.deepEqual(edgeLoop(all, hole, 7).map(x => x.id), [20]);
  assert.deepEqual(sameEdges(all, hole).map(x => x.id), [20, 21]);
  assert.deepEqual(sameEdges(all, t1).map(x => x.id), [1, 3, 5]);
});
