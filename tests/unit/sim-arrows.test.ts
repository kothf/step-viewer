// Heat flux arrows on thermal plots (FRS-thermal FR-TRES-001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fluxArrows } from "../../src/sim/arrows";

function plate(n: number, flux: (x: number, y: number) => [number, number, number]) {
  // an n × n grid of squares on z = 0, 100 mm wide
  const pos: number[] = [], nrm: number[] = [], vec: number[] = [], index: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = 100 * i / n, y = 100 * j / n; pos.push(x, y, 0); nrm.push(0, 0, 1); vec.push(...flux(x, y)); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; index.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1); }
  return { pos, nrm, vec, index };
}

test("flux arrows: spread over the surface, along the flux, length by magnitude", () => {
  const p = plate(60, x => [1e-3 * (1 + x / 100), 0, 0]);
  const a = fluxArrows(p.pos, p.nrm, p.vec, p.index, 200);
  assert.ok(a.at.length > 100 && a.at.length < 400, String(a.at.length));
  assert.equal(a.lines.length, 18 * a.at.length);
  assert.ok(Math.abs(a.peak - 2e-3) < 1e-9);
  // every shaft points along +X, lifted off the face, and the longest is at the hot end
  let longest = 0, atX = 0;
  for (let j = 0; j < a.at.length; j++) {
    const o = 18 * j, dx = a.lines[o + 3] - a.lines[o], dy = a.lines[o + 4] - a.lines[o + 1];
    assert.ok(dx > 0 && Math.abs(dy) < 1e-6);
    assert.ok(a.lines[o + 2] > 0);
    if (dx > longest) { longest = dx; atX = a.lines[o]; }
  }
  assert.ok(atX > 90, String(atX));
  const full = Math.hypot(100, 100) / 18;
  assert.ok(longest <= full + 1e-6 && longest > 0.9 * full, String(longest));
});

test("flux arrows: none where there is no flux, none on degenerate triangles", () => {
  const p = plate(10, x => (x < 50 ? [0, 0, 0] : [0, 1, 0]));
  const a = fluxArrows(p.pos, p.nrm, p.vec, p.index);
  for (const v of a.at) assert.ok(p.pos[3 * v] >= 50);
  const none = fluxArrows(p.pos, p.nrm, p.vec, p.index.map(() => 0));
  assert.equal(none.at.length, 0);
});
