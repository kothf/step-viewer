// Line cuts within a stretch (body.ts `hitsIn`): the same numbers as the whole line's cuts kept between the ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MeshBody } from "../../src/sim/body";

function boxTris(lo: number[], hi: number[], inward = false): number[] {
  const f: number[] = [];
  for (let a = 0; a < 3; a++) for (const top of [false, true]) {
    const a1 = (a + 1) % 3, a2 = (a + 2) % 3, at = top ? hi[a] : lo[a];
    const P = (u: number, v: number) => { const q = [0, 0, 0]; q[a] = at; q[a1] = u; q[a2] = v; return q; };
    const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
    f.push(...(top !== inward ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C]));
  }
  return f;
}

test("cuts within a stretch are the whole line's cuts between its ends", () => {
  // a long plate with a row of square holes through it, and a leaning tetrahedron beside it
  const tris = boxTris([0, 0, 0], [200, 30, 2]);
  for (let i = 0; i < 40; i++) tris.push(...boxTris([3 + 5 * i, 10, -1], [5 + 5 * i, 14, 3], true));
  const P = [[210, 0, 0], [250, 3, 2], [215, 37, 4], [218, 6, 33]];
  tris.push(...[[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]].flatMap(f => f.flatMap(v => P[v])));
  const body = new MeshBody(tris);
  let seed = 11, met = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 4000; k++) {
    const axis = k % 3, p = [-5 + 265 * rnd(), -3 + 43 * rnd(), -2 + 37 * rnd()];
    const lo = axis === 0 ? -5 : -3, span = axis === 0 ? 265 : 43, a = lo + span * rnd(), b = a + span * rnd() * (k % 5 ? 0.1 : 1);
    const want = body.hits(axis, p).filter(x => x > a && x < b), got = body.hitsIn(axis, p, a, b);
    assert.deepEqual(got, want, `axis ${axis} at ${p}`);
    met += got.length;
  }
  assert.ok(met > 300, `only ${met} cuts met`);
});
