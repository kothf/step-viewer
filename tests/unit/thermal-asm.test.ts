// Thermal analysis of several bodies (FRS-thermal TH3, FR-TCON-001..004, AT-TH3-4, AT-TH3-8): bodies joined
// where they touch, with a perfect contact, a contact conductance or none, against closed-form answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, type ThermalDomain } from "../../src/sim/thermal";

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

// two bars end to end along X: aluminium-like, then steel-like; the joint is not on a grid plane
const lo = [0, 0, 0], hi = [40, 10, 10], J = 17;
const A = dom([0, 0, 0], [J, 10, 10], 0.2), B = dom([J, 0, 0], [40, 10, 10], 0.05);
const left = rectFace(0, 0, lo, hi, false), right = rectFace(0, 40, lo, hi, true);
const whole = boxIn(lo, hi), P = 5, area = 100;

test("two bodies, perfect contact: resistances in series", () => {
  for (const p of [2, 3]) {
    const r = solveThermal({ lo, hi, inside: whole, h: 10, p, k: 0, domains: [A, B], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
    const tj = 20 + (P * J) / (A.k * area), tr = tj + (P * (40 - J)) / (B.k * area);
    assert.ok(Math.abs(r.temp(40, 5, 5) - tr) < 1e-3 * tr, `p ${p}: T(40) = ${r.temp(40, 5, 5)} vs ${tr}`);
    assert.ok(Math.abs(r.temp(10, 5, 5) - (20 + (P * 10) / (A.k * area))) < 1e-3 * tj, `p ${p}: T(10) = ${r.temp(10, 5, 5)}`);
    assert.equal(r.contacts.length, 1);
    const c = r.contacts[0];
    assert.equal(c.type, "perfect");
    assert.ok(Math.abs(c.area - area) < 1e-6, `area ${c.area}`);
    // the heat runs from the hot bar (b) into the held one (a)
    assert.ok(Math.abs(c.heat + P) < 1e-3 * P, `heat ${c.heat}`);
    assert.ok(Math.abs(c.ta - tj) < 2e-3 * tj && Math.abs(c.tb - tj) < 2e-3 * tj, `${c.ta} ${c.tb} vs ${tj}`);
    const s = r.sample([5, 5, 5, 30, 5, 5]);
    assert.deepEqual([...s.dom!], [0, 1]);
    assert.ok(Math.abs(r.volumes[0] - J * 100) < 1e-6 && Math.abs(r.volumes[1] - (40 - J) * 100) < 1e-6);
  }
});

test("an interface pad adds p·t / (k·A) (AT-TH3-4)", () => {
  // 0.5 mm of silicone pad, k = 3 W/(m·K)
  const h = 3e-3 / 0.5;
  const base = solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, B], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const r = solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, B], links: [{ a: 0, b: 1, type: "resistance", h }], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const rise = r.temp(40, 5, 5) - base.temp(40, 5, 5), want = P / (h * area);
  assert.ok(Math.abs(rise - want) < 0.03 * want, `rise ${rise} vs ${want}`);
  const c = r.contacts[0];
  assert.equal(c.type, "resistance");
  assert.ok(Math.abs(c.tb - c.ta - want) < 0.01 * want, `drop ${c.tb - c.ta}`);
  assert.ok(Math.abs(c.heat + P) < 1e-6 * P, `heat ${c.heat}`);
});

test("heat made in one body leaves through the other; the balance closes (AT-TH3-8)", () => {
  const film = 2e-4, top = rectFace(2, 10, [0, 0, 0], [J, 10, 10], true);
  const r = solveThermal({ lo, hi, inside: whole, h: 10, p: 3, k: 0, domains: [A, B], sinks: [{ tris: top, h: film, ambient: 25 }], sources: [{ power: 2, doms: [1] }] });
  assert.ok(Math.abs(r.applied - 2) < 1e-12);
  assert.ok(Math.abs(r.flows[0].out - 2) < 0.005 * 2, `out ${r.flows[0].out}`);
  assert.ok(Math.abs(r.contacts[0].heat + 2) < 0.005 * 2, `through the contact ${r.contacts[0].heat}`);
  // the body making the heat is the hotter one
  assert.ok(r.temp(35, 5, 5) > r.temp(5, 5, 5) + 1);
});

test("a body nothing takes heat from is named", () => {
  const sinks = [{ tris: left, temp: 20 }], sources = [{ tris: right, power: P }];
  assert.throws(() => solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, B], links: [{ a: 0, b: 1, type: "none" }], sinks, sources }), /E-TH-LOOSE: 1$/);
  const C = dom([J + 3, 0, 0], [40, 10, 10], 0.05);
  assert.throws(() => solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, C], sinks, sources: [{ power: 1, doms: [1] }] }), /E-TH-LOOSE: 1$/);
  // within the gap tolerance they are joined
  const D = dom([J + 0.05, 0, 0], [40, 10, 10], 0.05);
  const r = solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, D], gap: 0.1, sinks, sources: [{ power: 1, doms: [1] }] });
  assert.equal(r.contacts.length, 1);
  assert.throws(() => solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, { ...B, k: 0 }], sinks, sources }), /E-TH-NOK/);
});

test("a body that conducts differently along the axes (a board: FR-TBRD-010)", () => {
  // the second bar conducts 0.05 along X and forty times better across: along X only kx counts
  const B3: ThermalDomain = { ...B, k: 2, k3: [0.05, 2, 2] };
  const r = solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, B3], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] });
  const tj = 20 + (P * J) / (A.k * area), tr = tj + (P * (40 - J)) / (0.05 * area);
  assert.ok(Math.abs(r.temp(40, 5, 5) - tr) < 2e-3 * tr, `T(40) = ${r.temp(40, 5, 5)} vs ${tr}`);
  assert.ok(Math.abs(r.contacts[0].heat + P) < 2e-3 * P, `heat ${r.contacts[0].heat}`);
  const s = r.sample([30, 5, 5]);
  assert.ok(Math.abs(s.flux[0] + P / area) < 2e-3 * (P / area), `flux ${s.flux[0]}`);
  // a plate on a block, heated on top and held below: through the plate only kz counts
  const blk = dom([0, 0, 0], [20, 20, 7], 0.2), plate: ThermalDomain = { ...dom([0, 0, 7], [20, 20, 9], 0.02), k3: [0.02, 0.02, 0.0005] };
  const l2 = [0, 0, 0], h2 = [20, 20, 9];
  const q = solveThermal({ lo: l2, hi: h2, inside: boxIn(l2, h2), h: 5, p: 2, k: 0, domains: [blk, plate], sinks: [{ tris: rectFace(2, 0, l2, h2, false), temp: 20 }], sources: [{ tris: rectFace(2, 9, l2, h2, true), power: 2 }] });
  const want = 20 + (2 * 7) / (0.2 * 400) + (2 * 2) / (0.0005 * 400);
  assert.ok(Math.abs(q.temp(10, 10, 9) - want) < 2e-3 * want, `top ${q.temp(10, 10, 9)} vs ${want}`);
  assert.ok(Math.abs(q.flows[0].out - 2) < 2e-3 * 2, `out ${q.flows[0].out}`);
  assert.throws(() => solveThermal({ lo, hi, inside: whole, h: 10, p: 2, k: 0, domains: [A, { ...B, k3: [1, 0, 1] }], sinks: [{ tris: left, temp: 20 }], sources: [{ tris: right, power: P }] }), /E-TH-NOK/);
});

test("a body wholly inside an earlier one is joined to it from its own surface", () => {
  // an anode drawn inside a tube's solid bulb: the bulb's surface never meets it, so the join is found from the inner body
  const out = dom([0, 0, 0], [40, 30, 30], 0.2), inner = dom([14, 11, 11], [26, 19, 19], 0.05);
  const r = solveThermal({ lo: [0, 0, 0], hi: [40, 30, 30], inside: boxIn([0, 0, 0], [40, 30, 30]), h: 10, p: 2, k: 0, domains: [out, inner],
    sinks: [{ tris: rectFace(0, 0, [0, 0, 0], [40, 30, 30], false), temp: 20 }], sources: [{ power: 1, doms: [1] }] });
  assert.equal(r.contacts.length, 1);
  assert.deepEqual([r.contacts[0].a, r.contacts[0].b], [1, 0]);
  const area = 2 * (12 * 8 + 12 * 8 + 8 * 8);
  assert.ok(Math.abs(r.contacts[0].area - area) < 1e-6 * area, `area ${r.contacts[0].area}`);
  assert.ok(Math.abs(r.contacts[0].heat - 1) < 0.02, `heat ${r.contacts[0].heat}`);
  assert.ok(r.flows[0].out > 0.98 && r.flows[0].out < 1.02, `out ${r.flows[0].out}`);
});
