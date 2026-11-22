// The board's Gerber layers under a thermal map (FRS-thermal FR-TMAP-012): the picture laid on the package's board
// by the boxes, each board point's place on its side's picture, the parts on the white strip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gerberAt, pcbFit, pcbUvs, pictureSize, WHITE_PX, type GBox } from "../../src/thermal/pcbTexture";

/** A box as a mesh: 8 corners, 12 triangles, with the triangles' part. */
function boxMesh(lo: number[], hi: number[], part: number, base = 0) {
  const pos: number[] = [];
  for (let k = 0; k < 8; k++) pos.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
  const q = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  const tri: number[] = [];
  for (const f of q) tri.push(base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]);
  return { pos, tri, part: tri.map(() => part).slice(0, 12) };
}
function join(...ms: ReturnType<typeof boxMesh>[]) {
  return { pos: ms.flatMap(m => m.pos), tri: ms.flatMap(m => m.tri), part: ms.flatMap(m => m.part) };
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

test("a picture of the board's own size lies on it; top and bottom points take their side's picture, parts the white strip", () => {
  const m = join(boxMesh([0, 0, 0], [120, 80, 1.6], 0), boxMesh([30, 20, 1.6], [40, 30, 10], 1, 8));
  const g: GBox = [0, 0, 120, 80];
  const f = pcbFit(m.pos, m.tri, m.part, g)!;
  assert.equal(f.axis, 2);
  assert.equal(f.swap, false);
  assert.ok(f.topUp);
  assert.deepEqual(gerberAt(f, g, [10, 20, 1.6]), [10, 20]);
  const w = 1200, W = 2 * w + WHITE_PX;
  const { uv, board } = pcbUvs(m.pos, m.tri, m.part, f, g, w);
  assert.equal(board, 8);
  // corner 7 = (120, 80, 1.6) on top: right end of the top picture; corner 0 = (0, 0, 0) at the bottom picture's start
  assert.ok(near(uv[7 * 2], (w - 0.5) / W, 1e-4) && near(uv[7 * 2 + 1], 1));
  assert.ok(near(uv[0], (w + 0.5) / W, 1e-4) && near(uv[1], 0));
  // the part's points: the white strip
  for (let i = 8; i < 16; i++) { assert.ok(uv[i * 2] > (2 * w) / W); assert.equal(uv[i * 2 + 1], 0.5); }
});

test("a picture whose sizes fit the other way turns a quarter turn; an offset moves it; Face 1 says which side is up", () => {
  // the board lies 80 along x and 120 along y; the Gerber is 120 wide, 80 high
  const m = boxMesh([0, 0, 0], [80, 120, 1.6], 0);
  const g: GBox = [100, 50, 220, 130];
  const f = pcbFit(m.pos, m.tri, m.part, g)!;
  assert.equal(f.swap, true);
  // the board's centre is the picture's centre; a point 10 mm along +y lies 10 mm along +x of the Gerber
  assert.deepEqual(gerberAt(f, g, [40, 60, 0]), [160, 90]);
  assert.deepEqual(gerberAt(f, g, [40, 70, 0]), [170, 90]);
  assert.deepEqual(gerberAt(f, g, [30, 60, 0]), [160, 100]);
  const moved = pcbFit(m.pos, m.tri, m.part, g, 5, -2)!;
  assert.deepEqual(gerberAt(moved, g, [45, 58, 0]), [160, 90]);
  // a package whose top faces (Face 1) are the ones at z = 0
  const face = m.tri.slice(0, 12).map((_, k) => (k < 2 ? 1 : k < 4 ? 2 : 3));
  const flipped = pcbFit(m.pos, m.tri, m.part, g, 0, 0, face)!;
  assert.equal(flipped.topUp, false);
  const { uv } = pcbUvs(m.pos, m.tri, m.part, flipped, g, 100);
  assert.ok(uv[0] < 100 / 208, "the z = 0 corner is on the top picture");
});

test("no board, no fit; the picture's size keeps to the cap", () => {
  const m = boxMesh([0, 0, 0], [10, 10, 10], 3);
  assert.equal(pcbFit(m.pos, m.tri, m.part, [0, 0, 10, 10]), null);
  const s = pictureSize([0, 0, 400, 100]);
  assert.ok(s.w <= 2040 && s.h <= 2040 && near(s.w / s.h, 4, 0.05));
  assert.equal(pictureSize([0, 0, 50, 30]).w, 500);
});
