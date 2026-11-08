// Exact patches from the kernel (src/kernel/patch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../../src/kernel/patch";
import type { PartData } from "../../src/topology";

test("a cylinder the mesh fit missed (short boss read as a sphere, cut hole as other) takes the exact axis (exam bug 30)", () => {
  const face = (type: "sphere" | "other") => ({ id: 0, triStart: 0, triCount: 1, type, area: 150, centroid: [16, 0, 11.25] as [number, number, number], center: [0, 0, 0] as [number, number, number], radius: 16.02, color: null, edges: [] });
  const d = { closed: false, faces: [face("sphere"), face("other")], edges: [] } as unknown as PartData;
  const fp = { area: 150.8, type: "cylinder" as const, radius: 16, axis: [0, 0, 1] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
  assert.ok(applyPatch(d, { ok: true, faces: [fp, fp], edges: [] }));
  for (const f of d.faces) {
    assert.equal(f.type, "cylinder");
    assert.equal(f.radius, 16);
    assert.deepEqual(f.axis, [0, 0, 1]);
    assert.deepEqual(f.center, [0, 0, 11.25]);
  }
});
