// Interference between assembly meshes: parts that only touch are not a clash; parts pushed into one another are.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { penetrates, pierces } from "../../src/asm/clash";

const box = (w: number, h: number, d: number) => {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.setIndex([...Array(g.getAttribute("position").count).keys()]);
  return new MeshBVH(g);
};
const at = (x: number, y: number, z: number, turn = 0) => new THREE.Matrix4().makeRotationY(turn).setPosition(x, y, z);
const tri = (...p: number[]) => new THREE.Triangle(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Vector3(p[3], p[4], p[5]), new THREE.Vector3(p[6], p[7], p[8]));

test("an edge through a face pierces it; one lying on it, ending on it or meeting its outline does not", () => {
  const floor = tri(-10, 0, -10, 10, 0, -10, 0, 0, 10);
  assert.equal(pierces(floor, tri(-1, 0, 0, 1, 0, 0, 0, 0, 1), 0.005), false);
  assert.equal(pierces(floor, tri(-1, 0, 0, 1, 0, 0, 0, 5, 0), 0.005), false);
  assert.equal(pierces(floor, tri(-1, -0.3, 0, 1, -0.3, 0, 0, 5, 0), 0.005), true);
  assert.equal(pierces(floor, tri(-1, -0.003, 0, 1, -0.003, 0, 0, 5, 0), 0.005), false);
});

test("boxes face to face touch; boxes pushed together clash", () => {
  const a = box(10, 10, 10), b = box(10, 10, 10);
  assert.equal(penetrates(a, b, at(10, 0, 0), 0.005), false);
  assert.equal(penetrates(a, b, at(10, 3, 2, 0.4), 0.005) , true);
  assert.equal(penetrates(a, b, at(9.5, 3, 2), 0.005), true);
  assert.equal(penetrates(a, b, at(10, 3, 2), 0.005), false);
  // A disc turning on a face it is mated to stays touching at every angle.
  for (let k = 0; k < 12; k++) assert.equal(penetrates(a, b, at(0, 10, 0, (k * Math.PI) / 6), 0.005), false, `turn ${k}`);
  // A thin rod right through a plate.
  assert.equal(penetrates(box(1, 1, 40), box(20, 20, 2), new THREE.Matrix4(), 0.005), true);
});

test("a pin turning in a bore of its size stays clear at the meshes' error; a thicker pin clashes", () => {
  const ring = (r0: number, r1: number, h: number, n: number) => {
    const g = new THREE.LatheGeometry([new THREE.Vector2(r0, 0), new THREE.Vector2(r1, 0), new THREE.Vector2(r1, h), new THREE.Vector2(r0, h), new THREE.Vector2(r0, 0)], n);
    return new MeshBVH(g);
  };
  const pin = (r: number) => { const g = new THREE.CylinderGeometry(r, r, 30, 48); g.translate(0, 5, 0); return new MeshBVH(g); };
  const bore = ring(10, 15, 10, 40), tol = Math.max(0.005, 1e-3 * (30 + 45));
  for (let k = 0; k < 8; k++) assert.equal(penetrates(bore, pin(10), new THREE.Matrix4().makeRotationY(k * 0.1), tol), false, `turn ${k}`);
  assert.equal(penetrates(bore, pin(10.5), new THREE.Matrix4(), tol), true);
});
