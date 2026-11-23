// Conductivity by direction (FRS-thermal FR-TMAT-003): a part whose k differs along X, Y and Z.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal } from "../../src/sim/thermal";
import { reuseKey, type RunInput } from "../../src/sim/run";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
// a 40 × 40 × 4 plate
const lo = [0, 0, 0], hi = [40, 40, 4];
const box = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 40 && z >= 0 && z <= 4;
const k3 = [0.4, 0.4, 0.005];

test("heat along the plate goes by kx, through it by kz", () => {
  const P = 5;
  // along X: left face held, right face heated; A = 40 × 4
  const along = solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: 0.1, k3, sinks: [{ tris: rectFace(0, 0, lo, hi, false), temp: 20 }], sources: [{ tris: rectFace(0, 40, lo, hi, true), power: P }] });
  const ex = 20 + (P * 40) / (k3[0] * 160);
  assert.ok(Math.abs(along.temp(40, 20, 2) - ex) < 1e-3 * (ex - 20), `${along.temp(40, 20, 2)} vs ${ex}`);
  assert.ok(Math.abs(along.temp(20, 20, 2) - (20 + (ex - 20) / 2)) < 1e-3 * (ex - 20));
  // through Z: bottom held, top heated; A = 40 × 40
  const through = solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: 0.1, k3, sinks: [{ tris: rectFace(2, 0, lo, hi, false), temp: 20 }], sources: [{ tris: rectFace(2, 4, lo, hi, true), power: P }] });
  const ez = 20 + (P * 4) / (k3[2] * 1600);
  assert.ok(Math.abs(through.temp(20, 20, 4) - ez) < 1e-3 * (ez - 20), `${through.temp(20, 20, 4)} vs ${ez}`);
  assert.ok(Math.abs(through.flows[0].out - P) < 1e-6 * P);
});

test("a spot heated on top spreads along a good in-plane conductor", () => {
  const P = 2, spot = rectFace(2, 4, [16, 16, 4], [24, 24, 4], true), floor = rectFace(2, 0, lo, hi, false);
  const run = (kk?: number[]) => solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: 0.05, ...(kk ? { k3: kk } : {}), sinks: [{ tris: floor, h: 1e-5, ambient: 20 }], sources: [{ tris: spot, power: P }] });
  const iso = run(), ortho = run([0.4, 0.4, 0.05]);
  // the same through-thickness k, but far better along: the hot spot is cooler and the corners warmer
  assert.ok(ortho.temp(20, 20, 4) < iso.temp(20, 20, 4) - 1, `${ortho.temp(20, 20, 4)} vs ${iso.temp(20, 20, 4)}`);
  assert.ok(ortho.temp(2, 2, 4) > iso.temp(2, 2, 4), `${ortho.temp(2, 2, 4)} vs ${iso.temp(2, 2, 4)}`);
  assert.ok(Math.abs(ortho.flows[0].out - P) < 1e-6 * P);
});

test("a typed k by direction changes the reuse key", () => {
  const inp = { body: { tris: [0, 0, 0, 1, 0, 0, 0, 1, 0], lo, hi }, thermal: { k: 0.1, setup: { sinks: [], sources: [], problems: [], sinkIds: [] } } } as unknown as RunInput;
  const a = reuseKey(inp, 5), b = reuseKey({ ...inp, thermal: { ...inp.thermal!, k3 } }, 5);
  assert.notEqual(a, b);
});
