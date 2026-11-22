// Copper from the Gerber set (FRS-thermal FR-TBRD-020): a board's conductivity cell by cell from each copper
// layer's coverage and the plated holes, and the solver taking it per element.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, kmapMean, type KMap, type ThermalDomain } from "../../src/sim/thermal";
import { b64, boardMap, gerberName, cellMeans, copperOrder, gridFor, kmapOf, stackK, swapFits, unb64, viaBytes, viaShare, PLATING, type CopperMap } from "../../src/thermal/copper";
import { boardConductivity, K_COPPER } from "../../src/thermal/study";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const boxTris = (lo: number[], hi: number[]) => { const t: number[] = []; for (let a = 0; a < 3; a++) t.push(...rectFace(a, lo[a], lo, hi, false), ...rectFace(a, hi[a], lo, hi, true)); return t; };
const boxIn = (lo: number[], hi: number[]) => (x: number, y: number, z: number) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];

test("even coverage gives the board formula; plated holes add copper through it", () => {
  const s = { layers: 2, copper: 35, cover: 0.4 };
  const a = stackK(1.6, s, [0.4, 0.4]), b = boardConductivity(1.6, s);
  assert.ok(Math.abs(a.along / b.along - 1) < 1e-9 && Math.abs(a.through / b.through - 1) < 1e-9, JSON.stringify({ a, b }));
  // a bare layer conducts like laminate; a full one far better
  assert.ok(stackK(1.6, s, [1, 1]).along > 10 * stackK(1.6, s, [0, 0]).along);
  const v = stackK(1.6, s, [0.4, 0.4], 0.01);
  assert.ok(Math.abs(v.through - a.through - 0.01 * K_COPPER) < 1e-9);
});

test("the grid, plated barrels per cell, cell means and the map encoding", () => {
  const g = gridFor([0, 0, 120, 80]);
  assert.deepEqual(g, { cell: 1, nu: 120, nv: 80 });
  const big = gridFor([0, 0, 600, 400]);
  assert.ok(big.nu * big.nv <= 40000 && big.cell > 1);
  const share = viaShare([{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, d: 0.4, plated: true }, { x1: 1.5, y1: 0.5, x2: 1.5, y2: 0.5, d: 3, plated: false }], { x0: 0, y0: 0, cell: 1, nu: 2, nv: 1 });
  assert.ok(Math.abs(share[0] - Math.PI * 0.4 * PLATING) < 1e-12 && share[1] === 0);
  assert.equal(unb64(b64(viaBytes(share)))[0], Math.round(share[0] * 2550));
  // a 2 × 1 cell image of 2 × 2 pixels per cell: the left cell half covered
  const px = 2, rgba = new Uint8ClampedArray(4 * 4 * 2);
  for (const [x, y] of [[0, 0], [1, 0]]) rgba[4 * (y * 4 + x) + 3] = 255;
  assert.deepEqual([...cellMeans(rgba, 2, 1, px)], [128, 0]);
  assert.ok(swapFits([80, 120], [120, 80]) && !swapFits([120, 80], [120, 80]));
  assert.deepEqual(copperOrder([{ kind: "copper", side: "bottom", label: "Bottom copper" }, { kind: "silk", side: "top", label: "x" }, { kind: "copper", side: "inner", label: "Inner copper 2" }, { kind: "copper", side: "top", label: "Top copper" }, { kind: "copper", side: "inner", label: "Inner copper 1" }]).map(l => l.label),
    ["Top copper", "Inner copper 1", "Inner copper 2", "Bottom copper"]);
});

/** A map of a board `w` × `h` mm at 1 mm cells with one layer: copper `left` on x < w/2, `right` beyond. */
function halves(w: number, h: number, left: number, right: number): CopperMap {
  const cov = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cov[j * w + i] = Math.round(255 * (i < w / 2 ? left : right));
  return { name: "t", x0: 0, y0: 0, cell: 1, nu: w, nv: h, cov: [b64(cov)], vias: b64(new Uint8Array(w * h)), labels: ["Top copper"], means: [(left + right) / 2], holes: 0 };
}

test("a map placed on a board body: centred on it, swapped when its sides say so, mean over a box", () => {
  const s = { layers: 1, copper: 35, cover: 0.5 };
  const tris = boxTris([10, 20, 0], [110, 30, 1.6]);
  const m = boardMap(tris, { ...s, map: halves(100, 10, 1, 0) }, 1.6)!;
  assert.deepEqual([m.axis, m.ua, m.va, m.u0, m.v0, m.nu, m.nv], [2, 0, 1, 10, 20, 100, 10]);
  const full = stackK(1.6, s, [1]).along * 1e-3, bare = stackK(1.6, s, [0]).along * 1e-3;
  assert.ok(Math.abs(kmapMean(m, [30, 25, 0.8], 5)[0] - full) < 1e-9 && Math.abs(kmapMean(m, [90, 25, 0.8], 5)[0] - bare) < 1e-9);
  assert.ok(Math.abs(kmapMean(m, [60, 25, 0.8], 10)[0] - (full + bare) / 2) < 1e-9);
  // the same board standing along Y: the map turned to fit
  const t2 = boxTris([20, 10, 0], [30, 110, 1.6]), m2 = boardMap(t2, { ...s, map: halves(100, 10, 1, 0) }, 1.6)!;
  assert.deepEqual([m2.u0, m2.v0, m2.nu, m2.nv], [20, 10, 10, 100]);
  assert.ok(Math.abs(kmapMean(m2, [25, 30, 0.8], 4)[0] - full) < 1e-9 && Math.abs(kmapMean(m2, [25, 90, 0.8], 4)[0] - bare) < 1e-9);
  assert.equal(kmapOf(halves(4, 2, 0, 0), s, 1.6, 2, 0, 0).along.length, 8);
});

test("the solver takes the board's conductivity element by element: two halves in series", () => {
  // a board 100 × 10 × 2 mm (copper on its left half only) and a block beside it holding its right end at 20 °C;
  // 1 W in at its left end: the rise is the two halves' resistances in series
  const s = { layers: 1, copper: 35, cover: 0.5 };
  const lo = [0, 0, 0], hi = [110, 10, 2], bl = [100, 0, 0];
  const tris = boxTris([0, 0, 0], [100, 10, 2]);
  const kmap: KMap = boardMap(tris, { ...s, map: halves(100, 10, 1, 0) }, 2)!;
  const board: ThermalDomain = { inside: boxIn([0, 0, 0], [100, 10, 2]), k: 1, kmap, tris };
  const block: ThermalDomain = { inside: boxIn(bl, hi), k: 400e-3, tris: boxTris(bl, hi) };
  const r = solveThermal({ lo, hi, inside: boxIn(lo, hi), h: 5, p: 2, k: 0, domains: [board, block], sinks: [{ tris: rectFace(0, 110, bl, hi, true), temp: 20 }], sources: [{ tris: rectFace(0, 0, lo, [100, 10, 2], false), power: 1 }] });
  const A = 10 * 2, kl = stackK(2, s, [1]).along * 1e-3, kr = stackK(2, s, [0]).along * 1e-3;
  const want = 20 + 50 / (kl * A) + 50 / (kr * A) + 10 / (0.4 * A);
  const got = r.temp(0.01, 5, 1);
  assert.ok(Math.abs(got - want) < 0.02 * (want - 20), `left end ${got} vs ${want}`);
  // the bare half takes nearly all of the drop
  assert.ok(r.temp(50, 5, 1) - r.temp(100, 5, 1) > 20 * (r.temp(0.01, 5, 1) - r.temp(50, 5, 1)));
});

test("a Gerber set is named by its files' common start", () => {
  assert.equal(gerberName(["amp-F_Cu.gbr", "amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-PTH.drl"]), "amp");
  assert.equal(gerberName(["board.zip"]), "board");
  assert.equal(gerberName(["amp-gerber.zip"]), "amp");
  assert.equal(gerberName(["x.gbr", "y.gbr"]), "x");
});
