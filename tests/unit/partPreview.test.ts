/** The display mesh kept in a part file (src/model/preview.ts): written by Save, read back the same within 16 bits. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePreview, encodePreview } from "../../src/model/preview";
import { packPart, unpackPartFile } from "../../src/model/file";
import type { PartData } from "../../src/topology";

function box(n: number): PartData {
  // A strip of n quads, so the vertex count can pass 65535 (32-bit indices).
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) pos.push(i * 0.5, 0, 0, i * 0.5, 20, 3);
  for (let i = 0; i < n; i++) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const positions = new Float32Array(pos);
  return {
    name: "b", color: [0.2, 0.4, 0.6], positions, normals: new Float32Array(positions.length), colors: null, index: new Uint32Array(idx),
    faces: [], edges: [], edgeSegs: new Float32Array([0, 0, 0, n * 0.5, 0, 0, 0, 20, 3, n * 0.5, 20, 3]), sharpSegs: 6,
    closed: false, volume: 1, area: 1, com: [0, 0, 0], bboxMin: [0, 0, 0], bboxMax: [n * 0.5, 20, 3],
  };
}

for (const n of [10, 40000]) test(`part preview: ${n} quads round trip`, () => {
  const d = box(n);
  const b = encodePreview(d)!;
  assert.ok(b);
  const r = decodePreview(b, "x")!;
  assert.equal(r.positions.length, d.positions.length);
  assert.deepEqual([...r.index], [...d.index]);
  const tol = (n * 0.5) / 65535;
  for (let i = 0; i < d.positions.length; i++) assert.ok(Math.abs(r.positions[i] - d.positions[i]) <= tol, `p${i}`);
  for (let i = 0; i < d.edgeSegs.length; i++) assert.ok(Math.abs(r.edgeSegs[i] - d.edgeSegs[i]) <= tol, `e${i}`);
  assert.equal(r.sharpSegs, 6);
  assert.deepEqual(r.color, d.color);
  // Normals of the strip face (0, -3, 20)/|.| or its opposite, unit length.
  const l = Math.hypot(r.normals[0], r.normals[1], r.normals[2]);
  assert.ok(Math.abs(l - 1) < 1e-5 && Math.abs(r.normals[0]) < 1e-5);
  assert.equal(r.faces.length, 0);
});

test("part preview: kept in the file, absent in old files, refused when not a preview", async () => {
  const doc = { schema: 1, kind: "part", id: "p", name: "P", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [] } as never;
  const pv = encodePreview(box(4))!;
  const withPv = await unpackPartFile((await packPart(doc, "t", undefined, pv)).slice().buffer);
  assert.deepEqual([...withPv.preview!], [...pv]);
  const without = await unpackPartFile((await packPart(doc, "t")).slice().buffer);
  assert.equal(without.preview, null);
  assert.equal(decodePreview(new Uint8Array(16), "x"), null);
  assert.equal(encodePreview(null), null);
});
