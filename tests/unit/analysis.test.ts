// Surface analyses (FR-MEA-005): draft, curvature, ray-based thickness and undercut on simple meshes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshBVH } from "three-mesh-bvh";
import { curvature, draft, thickness, undercut, type MeshIn, type RayHit } from "../../src/tools/surfaceAnalysis";

const meshOf = (g: THREE.BufferGeometry): MeshIn => ({
  positions: g.getAttribute("position").array as Float32Array,
  normals: g.getAttribute("normal").array as Float32Array,
  index: Uint32Array.from(g.getIndex()!.array),
});
const box = (w: number, d: number, h: number, z = 0) => new THREE.BoxGeometry(w, d, h).translate(0, 0, z + h / 2);
function rays(g: THREE.BufferGeometry): RayHit {
  const bvh = new MeshBVH(g), ray = new THREE.Ray();
  return (o, d, far) => {
    ray.origin.set(...o); ray.direction.set(...d);
    const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
    return h && h.distance <= far ? h.distance : null;
  };
}
const near = (a: number | undefined, b: number, tol = 1e-3) => assert.ok(Math.abs((a ?? 0) - b) < tol, `${a} ≈ ${b}`);

test("draft: a plate pulled along +Z has its top positive, bottom negative and sides without draft", () => {
  const m = meshOf(box(10, 10, 2));
  const r = draft(m, [0, 0, 1], 1);
  near(r.areas.pos, 100); near(r.areas.neg, 100); near(r.areas.low, 80);
  assert.equal(r.colors.length, m.positions.length);
  // Pulled along +X, the +X side becomes the positive one.
  const x = draft(m, [1, 0, 0], 1);
  near(x.areas.pos, 20); near(x.areas.neg, 20); near(x.areas.low, 240);
});

test("curvature: a sphere reads 1/r everywhere, and an exact plane is flat", () => {
  const s = new THREE.SphereGeometry(5, 48, 24);
  const r = curvature(meshOf(s));
  near(r.max, 0.2, 2e-3);
  const b = meshOf(box(10, 10, 10));
  const flat = curvature({ ...b, faces: [{ triStart: 0, triCount: b.index.length / 3, surface: "plane" }] });
  near(flat.areas.flat, 600);
});

test("thickness: a plate's faces are as thick as the plate; under the minimum they are thin", async () => {
  const g = box(20, 20, 2);
  const r = (await thickness(meshOf(g), rays(g), 1, 30))!;
  near(r.max, 20, 1e-2); // across the plate from one side face to the other
  near(r.areas.ok, 2 * 400 + 4 * 40, 1e-2);
  const thin = box(20, 20, 1);
  const t = (await thickness(meshOf(thin), rays(thin), 1.5, 30))!;
  near(t.areas.thin, 2 * 400, 1e-2);
  near(t.areas.ok, 4 * 20, 1e-2);
});

test("undercut: two stacked plates with a gap trap the faces that look at each other", async () => {
  const one = box(10, 10, 2);
  const free = (await undercut(meshOf(one), rays(one), [0, 0, 1], 20))!;
  assert.equal(free.areas.under ?? 0, 0);
  near(free.areas.up, 100); near(free.areas.down, 100); near(free.areas.side, 80);
  const two = mergeGeometries([box(10, 10, 1), box(10, 10, 1, 3)])!;
  const r = (await undercut(meshOf(two), rays(two), [0, 0, 1], 20))!;
  near(r.areas.under, 200); near(r.areas.up, 100); near(r.areas.down, 100);
});
