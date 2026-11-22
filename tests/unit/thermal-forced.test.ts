// Forced air (FRS-thermal FR-TBC-005): flat plate film coefficients per face from the air speed and the face's length
// along the flow, through the solver and a study.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, forcedH, AIR, RE_TURBULENT } from "../../src/sim/thermal";
import { thermalSetup, runThermal, studyProblem, flowFilm } from "../../src/sim/run";
import { newStudy, fanSpeed, DEFAULT_FORCED } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

test("forced air: laminar and turbulent flat plate correlations for air", () => {
  // 2 m/s over 100 mm: Re ≈ 12 700, laminar
  const re = (2 * 0.1) / AIR.nu, lam = (0.664 * Math.sqrt(re) * Math.cbrt(AIR.pr) * AIR.k) / 0.1;
  assert.ok(Math.abs(forcedH(2, 100) * 1e6 - lam) < 1e-9);
  assert.ok(lam > 15 && lam < 20, `h ${lam}`);
  // faster air cools better, a longer face less per area (laminar: h ∝ √(v / L))
  assert.ok(Math.abs(forcedH(8, 100) / forcedH(2, 100) - 2) < 1e-9);
  assert.ok(Math.abs(forcedH(2, 400) / forcedH(2, 100) - 0.5) < 1e-9);
  // past the transition the mixed laminar-turbulent plate takes over and grows faster with speed
  const L = 1000, v = (2 * RE_TURBULENT * AIR.nu) / (L * 1e-3), re2 = (v * L * 1e-3) / AIR.nu;
  assert.ok(Math.abs(forcedH(v, L) * 1e6 - ((0.037 * re2 ** 0.8 - 871) * Math.cbrt(AIR.pr) * AIR.k) / 1) < 1e-9);
  assert.ok(forcedH(v, L) > forcedH(v * 0.99, L) && forcedH(2 * v, L) / forcedH(v, L) > Math.SQRT2);
  // a fan's flow through an opening: 36 m³/h through 50 cm² = 2 m/s
  assert.ok(Math.abs(fanSpeed(36, 50) - 2) < 1e-12);
  assert.equal(fanSpeed(0, 50), 0);
});

test("forced air: a slab cooled from one end with a per-face film coefficient", () => {
  const lo = [0, 0, 0], hi = [40, 10, 10], k = 0.2, q = 0.01, h = forcedH(3, 10);
  const box = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 10 && z >= 0 && z <= 10;
  const left = rectFace(0, 0, lo, hi, false), right = rectFace(0, 40, lo, hi, true);
  const r = solveThermal({ lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: right, ambient: 25, forced: { h: [h, h] } }], sources: [{ tris: left, flux: q }] });
  const tR = 25 + q / h;
  assert.ok(Math.abs(r.temp(40, 5, 5) - tR) < 1e-6 * tR, `${r.temp(40, 5, 5)} vs ${tR}`);
  assert.ok(Math.abs(r.flows[0].out - q * 100) < 1e-8);
  assert.ok(Math.abs(r.flows[0].h! - h) < 1e-12, "mean film coefficient reported");
});

const L = 100, B = 20, T = 5;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let i = 0; i < t.length / 9; i++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };

test("forced air: each face's length is its extent along the flow", () => {
  const all = [...Array(face.length).keys()];
  const hx = flowFilm(body, all, [1, 0, 0], 2), hy = flowFilm(body, all, [0, -1, 0], 2);
  const of = (hs: Float64Array, n: string) => hs[face.indexOf(names.indexOf(n))];
  // along X the long faces are 100 mm long; the ends face the flow and are taken by their size, √(20·5) = 10 mm
  assert.ok(Math.abs(of(hx, "z1") - forcedH(2, L)) < 1e-15 && Math.abs(of(hx, "y0") - forcedH(2, L)) < 1e-15);
  assert.ok(Math.abs(of(hx, "x0") - forcedH(2, 10)) < 1e-15);
  // across the bar (along −Y) the top is 20 mm long, and the side faces face the flow: √(100·5)
  assert.ok(Math.abs(of(hy, "z1") - forcedH(2, B)) < 1e-15);
  assert.ok(Math.abs(of(hy, "y1") - forcedH(2, Math.sqrt(L * T))) < 1e-15);
  // blowing across the short side cools better than along the long one
  assert.ok(of(hy, "z1") > of(hx, "z1"));
});

test("forced air study: heat leaves a bar through blown faces; a fan's flow sets the speed", () => {
  const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0]);
  const make = (forced: typeof DEFAULT_FORCED) => {
    const st = newStudy([], "thermal");
    st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x0" }], value: { v: 2 } });
    st.supports.push({ id: "s1", type: "conv", faces: [], all: true, forced });
    return st;
  };
  const solve = (st: ReturnType<typeof newStudy>) => {
    const set = thermalSetup(st, body);
    assert.equal(set.problems.length, 0);
    assert.ok(set.sinks[0].forced, "a forced air sink");
    return [...runThermal({ body, mat: { name: "Aluminium", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, thermal: { k: 0.2, setup: set } })].at(-1)!;
  };
  const slow = solve(make({ speed: 1, dir: [1, 0, 0] })), fast = solve(make({ speed: 4, dir: [1, 0, 0] }));
  // all the heat leaves through the air, and four times the speed roughly halves the rise (h ∝ √v)
  assert.ok(Math.abs(slow.thermal!.flows[0].out - 2) < 1e-3 * 2, `out ${slow.thermal!.flows[0].out}`);
  const rise = (r: typeof slow) => r.thermal!.max - 25;
  assert.ok(Math.abs(rise(fast) / rise(slow) - 0.5) < 0.05, `ratio ${rise(fast) / rise(slow)}`);
  assert.ok(fast.thermal!.flows[0].h! > slow.thermal!.flows[0].h!);
  // 36 m³/h through 50 cm² is 2 m/s
  const byFan = solve(make({ speed: 9, dir: [1, 0, 0], fan: { q: 36, a: 50 } })), two = solve(make({ speed: 2, dir: [1, 0, 0] }));
  assert.ok(Math.abs(byFan.thermal!.max - two.thermal!.max) < 1e-9);
  // no air speed: a problem, not a solve
  const bad = make({ speed: 0, dir: [1, 0, 0] });
  assert.deepEqual(thermalSetup(bad, body).problems, [{ id: "s1", code: "E-TH-VALUE" }]);
});
