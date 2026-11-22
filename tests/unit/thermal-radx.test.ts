// Radiation between face sets (FRS-thermal FR-TBC-007): heat crossing a gap only by radiation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, transientThermal, SIGMA, KELVIN, type ThermalDomain } from "../../src/sim/thermal";
import { viewFactor, exchangeResistance } from "../../src/sim/viewfactor";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxTris(lo: number[], hi: number[]): number[] {
  const t: number[] = [];
  for (let a = 0; a < 3; a++) t.push(...rectFace(a, lo[a], lo, hi, false), ...rectFace(a, hi[a], lo, hi, true));
  return t;
}
const boxIn = (lo: number[], hi: number[]) => (x: number, y: number, z: number) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
const dom = (lo: number[], hi: number[], k: number): ThermalDomain => ({ inside: boxIn(lo, hi), k, tris: boxTris(lo, hi) });

// a heater block (z 0..10) under a plate (z 14..18) held at 20 °C on top; nothing else touches the heater
const loA = [0, 0, 0], hiA = [20, 20, 10], loB = [0, 0, 14], hiB = [20, 20, 18];
const A = dom(loA, hiA, 0.2), B = dom(loB, hiB, 0.2);
const faceA = rectFace(2, 10, loA, hiA, true), faceB = rectFace(2, 14, loB, hiB, false), top = rectFace(2, 18, loB, hiB, true);
const both = (x: number, y: number, z: number) => boxIn(loA, hiA)(x, y, z) || boxIn(loB, hiB)(x, y, z);
const F = viewFactor(faceA, faceB, [...A.tris, ...B.tris]).fab;
const base = { lo: [0, 0, 0], hi: [20, 20, 18], inside: both, h: 5, p: 2, k: 0, domains: [A, B], sinks: [{ tris: top, temp: 20 }] };

test("all the heat crosses the gap by radiation; the grey-body law holds", () => {
  const P = 2, r = solveThermal({ ...base, sources: [{ power: P, doms: [0] }], exchanges: [{ a: faceA, b: faceB, ea: 0.9, eb: 0.8, f: F }] });
  const x = r.exchanges![0];
  assert.ok(F > 0.6 && F < 0.8, `F ${F}`);
  assert.ok(Math.abs(x.heat - P) < 0.01 * P, `heat ${x.heat}`);
  assert.ok(Math.abs(r.flows[0].out - P) < 0.01 * P, `held ${r.flows[0].out}`);
  const R = exchangeResistance(0.9, 0.8, 400, 400, F), want = SIGMA * ((x.ta + KELVIN) ** 4 - (x.tb + KELVIN) ** 4) / R;
  assert.ok(Math.abs(want - P) < 0.01 * P, `σ(Ta⁴ − Tb⁴)/R = ${want}`);
  assert.ok(x.ta > x.tb + 20, `heater ${x.ta} plate ${x.tb}`);
  assert.ok(r.iterations > 2 && r.iterations < 40, `iterations ${r.iterations}`);
  // without the exchange the heater has nowhere to send its heat
  assert.throws(() => solveThermal({ ...base, sources: [{ power: P, doms: [0] }] }), /E-TH-LOOSE: 0/);
});

test("a heater that also loses heat to the air: the balance closes", () => {
  const side = rectFace(0, 0, loA, hiA, false);
  const r = solveThermal({ ...base, sinks: [...base.sinks, { tris: side, h: 1e-5, ambient: 20 }], sources: [{ power: 1, doms: [0] }], exchanges: [{ a: faceA, b: faceB, ea: 0.9, eb: 0.9, f: F }] });
  const out = r.flows[0].out + r.flows[1].out;
  assert.ok(Math.abs(out - 1) < 0.01, `out ${out}`);
  assert.ok(Math.abs(r.exchanges![0].heat - r.flows[0].out) < 0.01, `exchange ${r.exchanges![0].heat} vs plate ${r.flows[0].out}`);
});

test("a transient run settles at the steady answer", () => {
  const ex = [{ a: faceA, b: faceB, ea: 0.9, eb: 0.9, f: F }], P = 2;
  const steady = solveThermal({ ...base, sources: [{ power: P, doms: [0] }], exchanges: ex });
  let last = 0;
  transientThermal({ ...base, sources: [{ power: P, doms: [0] }], exchanges: ex }, {
    rc: [2.4e-3, 2.4e-3], t0: 20, times: [2e5], factor: () => 1,
    frame: (_k, _t, sample) => { last = sample([10, 10, 5]).temp[0]; },
  });
  const want = steady.temp(10, 10, 5);
  assert.ok(Math.abs(last - want) < 0.01 * (want - 20), `${last} vs ${want}`);
});
