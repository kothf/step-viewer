// Tangent chains for fillet/chamfer picking (FR-SEL-005).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tangentChain } from "../../src/model/chain";
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
