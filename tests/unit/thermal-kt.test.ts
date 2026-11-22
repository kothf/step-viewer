// Temperature-dependent conductivity (FRS-thermal FR-TMAT-004): solved again with k at the temperatures found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, transientThermal, ktFactor } from "../../src/sim/thermal";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const lo = [0, 0, 0], hi = [40, 10, 10];
const box = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 10 && z >= 0 && z <= 10;
const left = rectFace(0, 0, lo, hi, false), right = rectFace(0, 40, lo, hi, true);
const k0 = 0.2;
// k = k0 (1 + b (T − 20)): twice as good at 120 °C, as a table
const b = 0.01, kt = [20, 1, 120, 2, 220, 3];
// Kirchhoff: k0 [(T − 20) + b (T − 20)² / 2] = P x / A
const exact = (P: number, x: number) => 20 + (Math.sqrt(1 + (2 * b * P * x) / (k0 * 100)) - 1) / b;

test("table factor: linear between rows, ends held", () => {
  assert.equal(ktFactor(kt, 0), 1);
  assert.equal(ktFactor(kt, 70), 1.5);
  assert.equal(ktFactor(kt, 220), 3);
  assert.equal(ktFactor(kt, 500), 3);
  assert.equal(ktFactor([50, 0.8], 10), 0.8);
});

test("slab with k rising with temperature: the Kirchhoff answer", () => {
  const P = 30;
  const plain = solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: k0, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const r = solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: k0, kt, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const rise = exact(P, 40) - 20;
  assert.ok(Math.abs(plain.temp(40, 5, 5) - (20 + (P * 40) / (k0 * 100))) < 1e-6);
  for (const x of [10, 25, 40]) {
    const t = r.temp(x, 5, 5), e = exact(P, x);
    assert.ok(Math.abs(t - e) < 0.02 * rise, `T(${x}) = ${t} vs ${e}`);
  }
  // heat still balances, and the hotter end conducts better: cooler than with constant k
  assert.ok(Math.abs(r.flows[0].out - P) < 1e-6 * P, `out ${r.flows[0].out}`);
  assert.ok(r.temp(40, 5, 5) < plain.temp(40, 5, 5) - 0.15 * rise);
  assert.ok((r.kSteps ?? 0) >= 3 && r.kSteps! < 30, `${r.kSteps} solves`);
  assert.equal(plain.kSteps, undefined);
});

test("two bodies, one with a table: only that one changes", () => {
  const half = (a: number, c: number) => (x: number, y: number, z: number) => x >= a && x <= c && y >= 0 && y <= 10 && z >= 0 && z <= 10;
  const tris = (a: number, c: number) => [0, 1, 2].flatMap(ax => [rectFace(ax, [a, 0, 0][ax], [a, 0, 0], [c, 10, 10], false), rectFace(ax, [c, 10, 10][ax], [a, 0, 0], [c, 10, 10], true)]).flat();
  const P = 10;
  const run = (tab?: number[]) => solveThermal({ lo, hi, inside: box, h: 5, p: 3, k: k0, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }],
    domains: [{ inside: half(0, 20), k: k0, tris: tris(0, 20) }, { inside: half(20, 40), k: k0, ...(tab ? { kt: tab } : {}), tris: tris(20, 40) }] });
  const plain = run(), r = run(kt);
  // the left body keeps its constant k: the same straight line up to the joint
  const tj = 20 + (P * 20) / (k0 * 100);
  assert.ok(Math.abs(r.temp(10, 5, 5) - plain.temp(10, 5, 5)) < 0.01, `${r.temp(10, 5, 5)} vs ${plain.temp(10, 5, 5)}`);
  assert.ok(Math.abs(r.temp(19.9, 5, 5) - tj) < 0.02 * (tj - 20));
  // the right one, from the joint temperature on: Kirchhoff from tj
  const u = (T: number) => (T - 20) + (b * (T - 20) ** 2) / 2;
  const target = u(tj) + (P * 20) / (k0 * 100), tEnd = 20 + (Math.sqrt(1 + 2 * b * target) - 1) / b;
  assert.ok(Math.abs(r.temp(40, 5, 5) - tEnd) < 0.02 * (tEnd - 20), `${r.temp(40, 5, 5)} vs ${tEnd}`);
});

test("transient with a table settles on the steady answer", () => {
  const P = 10, rc = 2.4e-3 * 0.1;
  const steady = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k: k0, kt, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  let last = 0;
  const r = transientThermal({ lo, hi, inside: box, h: 10, p: 2, k: k0, kt, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] }, {
    rc: [rc], t0: 20, times: [200, 400], factor: () => 1, step: 4,
    frame: (k, _t, sample) => { if (k === 1) last = sample([40, 5, 5]).temp[0]; },
  });
  const ts = steady.temp(40, 5, 5);
  assert.ok(Math.abs(last - ts) < 0.01 * (ts - 20), `${last} vs ${ts}`);
  assert.ok(r.solves > 2, `${r.solves} matrices`);
});
