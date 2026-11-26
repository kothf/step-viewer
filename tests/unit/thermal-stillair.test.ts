// Still air across small gaps between bodies (FRS-thermal FR-TCON-004): a body facing another across a gap up to
// `airSpan` wide passes heat by air's conductivity over the gap, k_air / d per area, as a resistor lying over a board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, airK, airMean, type ThermalDomain } from "../../src/sim/thermal";
import { DEFAULT_AIR_SPAN } from "../../src/sim/types";

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

// two bars 10×10 mm along x with a gap between them; the left end held at 20 °C, power into the right end
function bars(gap: number, airSpan: number | undefined, airT?: number) {
  const J = 20, lo = [0, 0, 0], hi = [40 + gap, 10, 10], P = 0.02;
  const A = dom([0, 0, 0], [J, 10, 10], 0.2), B = dom([J + gap, 0, 0], [40 + gap, 10, 10], 0.2);
  const inside = (x: number, y: number, z: number) => A.inside(x, y, z) || B.inside(x, y, z);
  return solveThermal({ lo, hi, inside, h: 5, p: 2, k: 0, domains: [A, B], gap: 0.1, ...(airSpan !== undefined ? { airSpan } : {}), ...(airT !== undefined ? { airT } : {}),
    sinks: [{ tris: rectFace(0, 0, lo, hi, false), temp: 20 }], sources: [{ tris: rectFace(0, 40 + gap, lo, hi, true), power: P }] });
}

test("still air: a 1 mm gap passes the heat at k_air / d, marked as air, at the temperature asked for", () => {
  assert.equal(DEFAULT_AIR_SPAN, 2);
  const d = 1, T = 50, r = bars(d, 2, T), air = r.contacts.filter(c => c.type === "air");
  assert.equal(air.length, 1, `contacts ${JSON.stringify(r.contacts.map(c => c.type))}`);
  const c = air[0], drop = Math.abs(c.ta - c.tb), want = (0.02 * d) / (airK(T) * 100);
  assert.ok(Math.abs(c.area - 100) < 2, `area ${c.area}`);
  assert.ok(Math.abs(Math.abs(c.heat) - 0.02) < 1e-3, `heat ${c.heat}`);
  assert.ok(Math.abs(drop - want) < 0.03 * want, `drop ${drop} vs ${want}`);
  const m = airMean(r.contacts)!;
  assert.ok(Math.abs(m - (c.ta + c.tb) / 2) < 0.06, `mean ${m}`);
});

test("still air: off with span 0, and nothing across a gap wider than the span", () => {
  assert.throws(() => bars(1, 0), /E-TH|singular|float/i, "the right bar has no path to the sink");
  assert.throws(() => bars(3, 2), /E-TH|singular|float/i);
  assert.equal(airMean([]), undefined);
});
