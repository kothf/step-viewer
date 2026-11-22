// Thermal analysis (FRS-thermal TH0/TH2, AT-TH0-1..4): steady conduction against closed-form answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, naturalH, SIGMA, KELVIN } from "../../src/sim/thermal";
import { MeshBody, insideOf } from "../../src/sim/body";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const lo = [0, 0, 0], hi = [40, 10, 10];
const box = Object.assign((x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 10 && z >= 0 && z <= 10, {});
const left = rectFace(0, 0, lo, hi, false), right = rectFace(0, 40, lo, hi, true);
// aluminium-like: 200 W/(m·K)
const k = 0.2;

test("slab: fixed temperature one end, heat power the other (AT-TH0-1)", () => {
  const P = 5;
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  // T(x) = 20 + P x / (k A)
  for (const x of [0, 13, 27, 40]) assert.ok(Math.abs(r.temp(x, 5, 5) - (20 + (P * x) / (k * 100))) < 1e-6, `T(${x}) = ${r.temp(x, 5, 5)}`);
  assert.ok(Math.abs(r.applied - P) < 1e-9);
  assert.ok(Math.abs(r.flows[0].out - P) < 1e-6, `out ${r.flows[0].out}`);
  const s = r.sample([20, 5, 5]);
  assert.ok(Math.abs(s.flux[0] + P / 100) < 1e-8);
});

test("slab: flux in, convection out (AT-TH0-2)", () => {
  const q = 0.01, h = 5e-5;
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: right, h, ambient: 25 }], sources: [{ tris: left, flux: q }] });
  const tR = 25 + q / h;
  assert.ok(Math.abs(r.temp(40, 5, 5) - tR) < 1e-6, `${r.temp(40, 5, 5)} vs ${tR}`);
  assert.ok(Math.abs(r.temp(0, 5, 5) - (tR + (q * 40) / k)) < 1e-6);
  assert.ok(Math.abs(r.flows[0].out - q * 100) < 1e-8);
});

test("slab: volume heat, both ends held: a parabola (AT-TH0-3)", () => {
  const P = 8, V = 4000, qv = P / V;
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: left, temp: 0 }, { tris: right, temp: 0 }], sources: [{ power: P }] });
  // T = qv x (L − x) / 2k
  for (const x of [10, 20, 33]) assert.ok(Math.abs(r.temp(x, 5, 5) - (qv * x * (40 - x)) / (2 * k)) < 1e-6);
  assert.ok(Math.abs(r.flows[0].out + r.flows[1].out - P) < 1e-6);
});

test("slab: radiation carries the flux away", () => {
  const q = 0.002, eps = 0.9;
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: right, emissivity: eps, ambient: 20 }], sources: [{ tris: left, flux: q }] });
  const tR = (q / (eps * SIGMA) + (20 + KELVIN) ** 4) ** 0.25 - KELVIN;
  assert.ok(Math.abs(r.temp(40, 5, 5) - tR) < 1e-3, `${r.temp(40, 5, 5)} vs ${tR}`);
  assert.ok(Math.abs(r.flows[0].out - q * 100) < 1e-5);
  assert.ok(r.iterations > 1 && r.iterations < 20);
});

test("natural convection: plate correlations by tilt (FR-TBC-004)", () => {
  // vertical 100 mm plate 20 K hotter: 1.42 (20 / 0.1)^¼ = 5.34 W/(m²·K)
  assert.ok(Math.abs(naturalH(0, 20, 100, 30) * 1e6 - 1.42 * 200 ** 0.25) < 1e-9);
  assert.ok(Math.abs(naturalH(1, 20, 100, 30) * 1e6 - 1.32 * (20 / 0.03) ** 0.25) < 1e-9);
  assert.ok(Math.abs(naturalH(-1, 20, 100, 30) * 1e6 - 0.59 * (20 / 0.03) ** 0.25) < 1e-9);
  // a cold face up behaves like a hot face down
  assert.equal(naturalH(1, -20, 100, 30), naturalH(-1, 20, 100, 30));
});

test("slab: natural convection from a vertical end and a top face, with an enclosure factor", () => {
  const q = 0.002, down = [0, 0, -1];
  // the right end is vertical, 10 mm high: q = f · 1.42e-6 (ΔT / 0.01)^¼ ΔT
  for (const factor of [1, 0.55]) {
    const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: right, ambient: 25, natural: { factor, down, lv: [10, 10], lh: [5, 5] } }], sources: [{ tris: left, flux: q }] });
    const dt = (q / (factor * 1.42e-6 * 100 ** 0.25)) ** 0.8;
    assert.ok(Math.abs(r.temp(40, 5, 5) - (25 + dt)) < 1e-3 * dt, `${r.temp(40, 5, 5)} vs ${25 + dt}`);
    assert.ok(Math.abs(r.flows[0].out - q * 100) < 1e-6 * q * 100, `out ${r.flows[0].out}`);
    assert.ok(r.flows[0].h! > 0 && r.iterations > 1 && r.iterations < 15, `h ${r.flows[0].h}, ${r.iterations} solves`);
  }
  // a top face (hot side up, area / perimeter = 400 / 100 = 4 mm), heat in through the bottom: conduction through 10 mm
  const top = rectFace(2, 10, lo, hi, true), bottom = rectFace(2, 0, lo, hi, false);
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: top, ambient: 25, natural: { factor: 1, down, lv: [1, 1], lh: [4, 4] } }], sources: [{ tris: bottom, flux: q }] });
  const dt = (q / (1.32e-6 * 250 ** 0.25)) ** 0.8;
  assert.ok(Math.abs(r.temp(20, 5, 10) - (25 + dt)) < 1e-3 * dt, `${r.temp(20, 5, 10)} vs ${25 + dt}`);
});

test("no sink is refused", () => {
  assert.throws(() => solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [], sources: [{ tris: left, flux: 1 }] }), /E-TH-NOSINK/);
});

/** A tube along Z as triangles: inner radius a, outer b, length L. */
function tube(a: number, b: number, L: number, n = 96) {
  const t: number[] = [], inner: number[] = [], outer: number[] = [];
  const P = (r: number, i: number, z: number) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z];
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    const o = [...P(b, i, 0), ...P(b, j, 0), ...P(b, j, L), ...P(b, i, 0), ...P(b, j, L), ...P(b, i, L)];
    const q = [...P(a, i, 0), ...P(a, j, L), ...P(a, j, 0), ...P(a, i, 0), ...P(a, i, L), ...P(a, j, L)];
    outer.push(...o); inner.push(...q);
    t.push(...o, ...q);
    t.push(...P(a, i, L), ...P(b, i, L), ...P(b, j, L), ...P(a, i, L), ...P(b, j, L), ...P(a, j, L));
    t.push(...P(a, i, 0), ...P(b, j, 0), ...P(b, i, 0), ...P(a, i, 0), ...P(a, j, 0), ...P(b, j, 0));
  }
  return { tris: Float64Array.from(t), inner, outer };
}

test("tube: heat through the wall follows the logarithm, passes converge (AT-TH0-4)", () => {
  const a = 10, b = 25, L = 20, P = 30;
  const T = tube(a, b, L), body = new MeshBody(T.tris), inside = insideOf(body);
  const exact = (r: number) => 40 + (P / (2 * Math.PI * k * L)) * Math.log(b / r);
  let grid, prev, err = Infinity;
  for (const p of [2, 3, 4]) {
    const r = solveThermal({ lo: [-b, -b, 0], hi: [b, b, L], inside, h: 12.5, p, k, grid, prev, sinks: [{ tris: T.outer, temp: 40 }], sources: [{ tris: T.inner, power: P }] });
    grid = r.grid; prev = r.x;
    const e = Math.abs(r.temp(a + 0.01, 0, L / 2) - exact(a)) / (exact(a) - 40);
    assert.ok(e < err * 1.05 || e < 0.01, `p ${p}: ${e} after ${err}`);
    err = e;
    if (p === 4) {
      assert.ok(e < 0.02, `inner wall off by ${e}`);
      assert.ok(Math.abs(r.temp(17, 3, 8) - exact(Math.hypot(17, 3))) / (exact(a) - 40) < 0.02);
      assert.ok(Math.abs(r.flows[0].out - r.applied) < 1e-6 * P, `balance ${r.flows[0].out} of ${r.applied}`);
      assert.ok(r.prevError !== null && r.prevError < 10);
    }
  }
});
