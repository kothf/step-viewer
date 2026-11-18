import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MESH_QUALITY, MESH_PRESETS, parseMeshQuality } from "../../src/tools/meshQuality";

test("mesh quality: Fine by default, presets, custom values clamped", () => {
  assert.deepEqual(parseMeshQuality(null), DEFAULT_MESH_QUALITY);
  assert.deepEqual(parseMeshQuality("not json"), DEFAULT_MESH_QUALITY);
  assert.equal(DEFAULT_MESH_QUALITY.kind, "fine");
  assert.ok(DEFAULT_MESH_QUALITY.ang <= 5, "Fine keeps at most 5° per facet, so round holes print round");
  assert.deepEqual(parseMeshQuality(JSON.stringify({ kind: "coarse" })), { kind: "coarse", ...MESH_PRESETS.coarse });
  assert.deepEqual(parseMeshQuality(JSON.stringify({ kind: "custom", dev: 0.05, ang: 3 })), { kind: "custom", dev: 0.05, ang: 3 });
  assert.deepEqual(parseMeshQuality(JSON.stringify({ kind: "custom", dev: 100, ang: 0.01 })), { kind: "custom", dev: 10, ang: 0.5 });
  assert.deepEqual(parseMeshQuality(JSON.stringify({ kind: "custom", dev: "x" })), { kind: "custom", dev: 0.01, ang: 5 });
  assert.equal(parseMeshQuality(JSON.stringify({ kind: "view" })).kind, "view");
  assert.equal(parseMeshQuality(JSON.stringify({ kind: "weird" })).kind, "fine");
});
