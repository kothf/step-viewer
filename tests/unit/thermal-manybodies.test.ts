// More than 127 bodies (1.753.0): the list of each surface triangle's body was 8-bit, so bodies from the 128th on
// read as "none" and their surface points were located one by one through inside tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { triangleBodies } from "../../src/sim/thermal";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxTris(lo: number[], hi: number[]): number[] {
  const f: number[] = [];
  for (let a = 0; a < 3; a++) f.push(...rectFace(a, lo[a], lo, hi, false), ...rectFace(a, hi[a], lo, hi, true));
  return f;
}

test("every triangle finds its body among 300 bodies", () => {
  const n = 300, doms: { inside(x: number, y: number, z: number): boolean }[] = [], tris: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = [2 * i, 0, 0], hi = [2 * i + 1, 1, 1];
    doms.push({ inside: (x, y, z) => x >= lo[0] && x <= hi[0] && y >= 0 && y <= 1 && z >= 0 && z <= 1 });
    tris.push(...boxTris(lo, hi));
  }
  const of = triangleBodies(doms, tris, 1e-4);
  assert.equal(of.length, 12 * n);
  for (let t = 0; t < of.length; t++) assert.equal(of[t], Math.floor(t / 12), `triangle ${t}`);
});
