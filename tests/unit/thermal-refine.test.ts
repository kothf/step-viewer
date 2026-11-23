// Smaller cells where heat enters through a small patch (FR-TSOL-004): the refined grid's faces between cells of
// different sizes, a field the basis holds exactly, and a small heated disc on a plate whose peak converges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, refineNear } from "../../src/sim/thermal";
import { makeGrid } from "../../src/sim/grid";
import { heatZones } from "../../src/sim/run";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

test("a refined grid: cells step down by halves towards the zone and the face pieces cover every face", () => {
  const lo = [0, 0, 0], hi = [40, 40, 8], inside = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 40 && z >= 0 && z <= 8;
  const zone = { lo: [19, 19, 8], hi: [21, 21, 8], h: 0.5 };
  const g = makeGrid(lo, hi, 8, inside, { q: 2, depth: 2, refine: refineNear([zone], 8) });
  // 8 mm cells down to 0.5 mm would be four halvings: three at most (MAX_HALVINGS)
  assert.equal(g.levels, 3);
  const sizes = new Map<number, number>();
  for (const c of g.cells) { const s = c.hi[0] - c.lo[0]; sizes.set(s, (sizes.get(s) ?? 0) + 1); }
  assert.deepEqual([...sizes.keys()].sort((a, b) => a - b), [1, 2, 4, 8]);
  // the volume is whole and the cells by the zone are the smallest
  assert.ok(Math.abs(g.volume - 40 * 40 * 8) < 1e-6);
  const at = g.cellOf(20.2, 20.2, 7.9);
  assert.equal(g.cells[at].hi[0] - g.cells[at].lo[0], 1);
  // every inner face is covered once by the pieces from its −side cell
  let inner = 0;
  for (let c = 0; c < g.cells.length; c++) for (let a = 0; a < 3; a++) for (const P of g.across(c, a)) {
    const a1 = (a + 1) % 3, a2 = (a + 2) % 3;
    inner += (P.hi[a1] - P.lo[a1]) * (P.hi[a2] - P.lo[a2]);
    assert.ok(Math.abs(g.cells[P.o].lo[a] - g.cells[c].hi[a]) < 1e-9);
  }
  // inner face area of the box cut into 1 mm planes is not what counts: cells of size 8 make planes every 8 mm
  // along the plain grid, the refined ones more; the pieces add up to the sum over all cells of their +faces inside
  let want = 0;
  for (const c of g.cells) for (let a = 0; a < 3; a++) if (c.hi[a] < hi[a] - 1e-9) { const a1 = (a + 1) % 3, a2 = (a + 2) % 3; want += (c.hi[a1] - c.lo[a1]) * (c.hi[a2] - c.lo[a2]); }
  assert.ok(Math.abs(inner - want) < 1e-6, `${inner} vs ${want}`);
});

test("a linear field is exact across cells of different sizes", () => {
  const lo = [0, 0, 0], hi = [40, 16, 16], inside = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 16 && z >= 0 && z <= 16;
  const zone = { lo: [18, 6, 16], hi: [22, 10, 16], h: 1 };
  const r = solveThermal({ lo, hi, inside, h: 8, p: 2, k: 0.05, refine: [zone], sinks: [{ tris: rectFace(0, 0, lo, hi, false), temp: 20 }, { tris: rectFace(0, 40, lo, hi, true), temp: 100 }], sources: [] });
  assert.ok(r.grid.levels > 0);
  for (const [x, y, z] of [[1, 8, 8], [19.6, 8.3, 15.9], [20.1, 3, 14], [33, 12, 2]]) {
    const t = r.temp(x, y, z);
    assert.ok(Math.abs(t - (20 + 2 * x)) < 1e-6, `T(${x}, ${y}, ${z}) = ${t}`);
  }
  assert.ok(Math.abs(r.flows[0].out + r.flows[1].out) < 1e-8 * Math.abs(r.flows[0].out));
});

test("a small heated disc on a plate: the peak converges as the cells there are made smaller", () => {
  // (read just off the patch's middle, which is a cell corner: the temperature may step across one)
  // a 40 × 30 × 1.6 mm board, 0.3 W through a 2.4 mm square patch on top, a film on every face
  const lo = [0, 0, 0], hi = [40, 30, 1.6], inside = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 30 && z >= 0 && z <= 1.6;
  const all: number[] = [];
  for (let ax = 0; ax < 3; ax++) all.push(...rectFace(ax, lo[ax], lo, hi, false), ...rectFace(ax, hi[ax], lo, hi, true));
  const patch = rectFace(2, 1.6, [18.8, 13.8, 0], [21.2, 16.2, 0], true);
  const sources = [{ tris: patch, power: 0.3 }];
  // plain cells of 4 mm; the zone asks for a quarter of the patch (0.6 mm), no smaller than an eighth of a cell
  const zones = heatZones(sources, 4);
  assert.equal(zones.length, 1);
  assert.ok(Math.abs(zones[0].h - 0.6) < 1e-9);
  assert.deepEqual(heatZones([{ tris: patch, power: 0.3 }], 1.5).length, 1);
  assert.deepEqual(heatZones([{ tris: rectFace(2, 1.6, [0, 0, 0], [40, 30, 0], true), power: 1 }], 4), []);
  const peak = (h: number | null) => {
    const r = solveThermal({ lo, hi, inside, h: 4, p: 3, k: 0.0004, sinks: [{ tris: all, h: 1e-5, ambient: 25 }], sources, ...(h ? { refine: [{ ...zones[0], h }] } : {}) });
    return { t: r.temp(20.1, 15.1, 1.6 - 1e-6) - 25, n: r.grid.cells.length };
  };
  const plain = peak(null), h2 = peak(2), h1 = peak(1), h05 = peak(0.5);
  const e = (q: { t: number }) => Math.abs(q.t - h05.t) / h05.t;
  assert.ok(e(plain) > 0.04, `plain cells: ${plain.t} K against ${h05.t} K`);
  assert.ok(e(h1) < e(plain) / 3, `errors ${e(plain)}, ${e(h2)}, ${e(h1)}`);
  assert.ok(e(h1) < 0.03, `1 mm cells: ${h1.t} K against ${h05.t} K`);
  // the refined grid stays small: the plain cells hold most of the plate
  assert.ok(h05.n < 8 * plain.n, `${h05.n} cells against ${plain.n}`);
});
