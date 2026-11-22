// Air gaps and interface materials between bodies (FRS-thermal FR-TCON-002): an air layer conducts by air's k at
// the joint's mean temperature, found by solving again; the pad library's entries give k / t.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, airK, AIR_MIN, type ThermalDomain } from "../../src/sim/thermal";
import { linkConductance, PAD_LIBRARY, padEntry, DEFAULT_AIR_GAP, AIR_K25 } from "../../src/sim/types";

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

test("air's conductivity follows temperature", () => {
  assert.ok(Math.abs(airK(0) - 2.43e-5) < 1e-9 && Math.abs(airK(100) - 3.145e-5) < 1e-8 && Math.abs(airK(200) - 3.86e-5) < 1e-8);
  assert.ok(Math.abs(linkConductance({ type: "air", t: 0.2 }) - AIR_K25 * 1e-3 / 0.2) < 1e-12);
  assert.ok(Math.abs(linkConductance({ type: "air" }) - AIR_K25 * 1e-3 / DEFAULT_AIR_GAP) < 1e-12);
});

test("an air layer between two bars: the drop is p·t / (k_air(T mean)·A), solved until k settles", () => {
  const lo = [0, 0, 0], hi = [40, 10, 10], J = 17, P = 0.5, area = 100, t = 0.1;
  const A = dom([0, 0, 0], [J, 10, 10], 0.2), B = dom([J, 0, 0], [40, 10, 10], 0.05);
  const left = rectFace(0, 0, lo, hi, false), right = rectFace(0, 40, lo, hi, true);
  const r = solveThermal({ lo, hi, inside: boxIn(lo, hi), h: 10, p: 2, k: 0, domains: [A, B], links: [{ a: 0, b: 1, type: "resistance", air: t }], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const c = r.contacts[0], drop = c.tb - c.ta, want = (P * t) / (airK((c.ta + c.tb) / 2) * area);
  assert.equal(c.type, "resistance");
  assert.ok(Math.abs(drop - want) < 0.01 * want, `drop ${drop} vs ${want}`);
  assert.ok((r.airSteps ?? 0) >= 2, `steps ${r.airSteps}`);
  // at 25 °C air would have given a larger drop: the hot joint conducts better
  assert.ok(drop < (P * t) / (airK(20) * area), `drop ${drop}`);
  // a touching pair set to an air gap still passes a finite heat through the thinnest layer
  const z = solveThermal({ lo, hi, inside: boxIn(lo, hi), h: 10, p: 2, k: 0, domains: [A, B], links: [{ a: 0, b: 1, type: "resistance", air: 0 }], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const cz = z.contacts[0], dz = cz.tb - cz.ta;
  assert.ok(Math.abs(dz - (P * AIR_MIN) / (airK((cz.ta + cz.tb) / 2) * area)) < 0.02 * dz, `thin ${dz}`);
});

test("the interface material library", () => {
  assert.ok(PAD_LIBRARY.length >= 6 && PAD_LIBRARY.every(p => p.t > 0 && p.k > 0));
  const g = PAD_LIBRARY.findIndex(p => p.name === "Thermal grease");
  assert.equal(padEntry(PAD_LIBRARY[g].t, PAD_LIBRARY[g].k), g);
  assert.equal(padEntry(0.37, 2.2), -1);
  assert.ok(Math.abs(linkConductance({ type: "pad", ...PAD_LIBRARY[g] }) - 1e-3 / 0.05) < 1e-12);
});
