// Thermal benchmarks against closed-form answers (NFR-TH-020, AT-TH0-1): a pin fin with convection (cosh solution),
// an annular fin with convection (Bessel solution), a solid cylinder with internal heat and convection, and the heat
// balance of each, after the passes p = 2, 3, 4 that a study runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, type ThermalProblem, type ThermalResult } from "../../src/sim/thermal";
import { MeshBody, insideOf } from "../../src/sim/body";

/** Runs p = 2, 3, 4 on one grid as a study does and returns the last pass. */
function passes(pb: Omit<ThermalProblem, "p">): ThermalResult {
  let grid, prev, r!: ThermalResult;
  for (const p of [2, 3, 4]) {
    r = solveThermal({ ...pb, p, grid, prev });
    grid = r.grid; prev = r.x;
  }
  return r;
}
const balance = (r: ThermalResult) => {
  const out = r.flows.reduce((s, f) => s + f.out, 0);
  return { out, applied: r.applied };
};

// Modified Bessel functions (Abramowitz & Stegun 9.8.1-9.8.8, |error| < 2e-7 relative).
function I0(x: number): number {
  if (x < 3.75) { const t = (x / 3.75) ** 2; return 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))); }
  const t = 3.75 / x;
  return (Math.exp(x) / Math.sqrt(x)) * (0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))));
}
function I1(x: number): number {
  if (x < 3.75) { const t = (x / 3.75) ** 2; return x * (0.5 + t * (0.87890594 + t * (0.51498869 + t * (0.15084934 + t * (0.02658733 + t * (0.00301532 + t * 0.00032411)))))); }
  const t = 3.75 / x;
  return (Math.exp(x) / Math.sqrt(x)) * (0.39894228 + t * (-0.03988024 + t * (-0.00362018 + t * (0.00163801 + t * (-0.01031555 + t * (0.02282967 + t * (-0.02895312 + t * (0.01787654 - t * 0.00420059))))))));
}
function K0(x: number): number {
  if (x <= 2) { const t = (x / 2) ** 2; return -Math.log(x / 2) * I0(x) + (-0.57721566 + t * (0.4227842 + t * (0.23069756 + t * (0.0348859 + t * (0.00262698 + t * (0.0001075 + t * 0.0000074)))))); }
  const t = 2 / x;
  return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + t * (-0.07832358 + t * (0.02189568 + t * (-0.01062446 + t * (0.00587872 + t * (-0.0025154 + t * 0.00053208))))));
}
function K1(x: number): number {
  if (x <= 2) { const t = (x / 2) ** 2; return Math.log(x / 2) * I1(x) + (1 / x) * (1 + t * (0.15443144 + t * (-0.67278579 + t * (-0.18156897 + t * (-0.01919402 + t * (-0.00110404 - t * 0.00004686)))))); }
  const t = 2 / x;
  return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + t * (0.23498619 + t * (-0.0365562 + t * (0.01504268 + t * (-0.00780353 + t * (0.00325614 - t * 0.00068245))))));
}

test("Bessel functions match tabulated values", () => {
  // Abramowitz & Stegun table 9.8
  assert.ok(Math.abs(I0(1) - 1.266065878) < 1e-6);
  assert.ok(Math.abs(I1(1) - 0.565159104) < 1e-6);
  assert.ok(Math.abs(K0(1) - 0.421024438) < 1e-6);
  assert.ok(Math.abs(K1(1) - 0.601907230) < 1e-6);
  assert.ok(Math.abs(I0(5) - 27.23987182) < 1e-4);
  assert.ok(Math.abs(K1(5) - 0.004044613) < 1e-8);
});

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

test("pin fin: base held, convection on the sides and the tip (cosh solution within 2 %)", () => {
  // aluminium bar 4 × 4 × 100 mm, k = 200 W/(m·K), h = 25 W/(m²·K), base 100 °C, air 25 °C
  const a = 4, L = 100, k = 0.2, h = 25e-6, tb = 100, ta = 25;
  const lo = [0, 0, 0], hi = [L, a, a];
  const inside = (x: number, y: number, z: number) => x >= 0 && x <= L && y >= 0 && y <= a && z >= 0 && z <= a;
  const base = rectFace(0, 0, lo, hi, false);
  const cooled = [...rectFace(0, L, lo, hi, true), ...rectFace(1, 0, lo, hi, false), ...rectFace(1, a, lo, hi, true), ...rectFace(2, 0, lo, hi, false), ...rectFace(2, a, lo, hi, true)];
  const r = passes({ lo, hi, inside, h: 2, k, sinks: [{ tris: base, temp: tb }, { tris: cooled, h, ambient: ta }], sources: [] });
  const m = Math.sqrt((h * 4 * a) / (k * a * a)), hk = h / (m * k);
  const theta = (x: number) => (Math.cosh(m * (L - x)) + hk * Math.sinh(m * (L - x))) / (Math.cosh(m * L) + hk * Math.sinh(m * L));
  for (const x of [25, 50, 75, 100]) {
    const t = r.temp(Math.min(x, L - 1e-6), a / 2, a / 2), exact = ta + (tb - ta) * theta(x);
    assert.ok(Math.abs(t - exact) / (exact - ta) < 0.02, `T(${x}) = ${t} vs ${exact}`);
  }
  // heat through the base: √(hPkA) θb (sinh mL + hk cosh mL) / (cosh mL + hk sinh mL)
  const q = Math.sqrt(h * 4 * a * k * a * a) * (tb - ta) * (Math.sinh(m * L) + hk * Math.cosh(m * L)) / (Math.cosh(m * L) + hk * Math.sinh(m * L));
  assert.ok(Math.abs(-r.flows[0].out - q) / q < 0.02, `base ${-r.flows[0].out} W vs ${q} W`);
  const b = balance(r);
  assert.ok(Math.abs(b.out - b.applied) < 0.005 * q, `balance ${b.out} W`);
});

/** A ring of thickness t (along Z) between radii r1 and r2, faceted with n sides. */
function ring(r1: number, r2: number, t: number, n = 128) {
  const inner: number[] = [], faces: number[] = [], rim: number[] = [];
  const P = (r: number, i: number, z: number) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z];
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    rim.push(...P(r2, i, 0), ...P(r2, j, 0), ...P(r2, j, t), ...P(r2, i, 0), ...P(r2, j, t), ...P(r2, i, t));
    inner.push(...P(r1, i, 0), ...P(r1, j, t), ...P(r1, j, 0), ...P(r1, i, 0), ...P(r1, i, t), ...P(r1, j, t));
    faces.push(...P(r1, i, t), ...P(r2, i, t), ...P(r2, j, t), ...P(r1, i, t), ...P(r2, j, t), ...P(r1, j, t));
    faces.push(...P(r1, i, 0), ...P(r2, j, 0), ...P(r2, i, 0), ...P(r1, i, 0), ...P(r1, j, 0), ...P(r2, j, 0));
  }
  return { tris: Float64Array.from([...inner, ...faces, ...rim]), inner, faces };
}

test("annular fin: inner rim held, convection on both faces, outer rim insulated (Bessel solution within 2 %)", () => {
  // aluminium ring r1 = 10, r2 = 40, t = 2 mm, k = 200 W/(m·K), h = 50 W/(m²·K)
  const r1 = 10, r2 = 40, t = 2, k = 0.2, h = 50e-6, tb = 80, ta = 20;
  const R = ring(r1, r2, t), inside = insideOf(new MeshBody(R.tris));
  const r = passes({ lo: [-r2, -r2, 0], hi: [r2, r2, t], inside, h: 6, k, sinks: [{ tris: R.inner, temp: tb }, { tris: R.faces, h, ambient: ta }], sources: [] });
  const m = Math.sqrt((2 * h) / (k * t));
  const den = K1(m * r2) * I0(m * r1) + I1(m * r2) * K0(m * r1);
  const theta = (x: number) => (K1(m * r2) * I0(m * x) + I1(m * r2) * K0(m * x)) / den;
  for (const x of [15, 25, 35, 39.5]) {
    const T = r.temp(x * Math.cos(0.3), x * Math.sin(0.3), t / 2), exact = ta + (tb - ta) * theta(x);
    assert.ok(Math.abs(T - exact) / (exact - ta) < 0.02, `T(${x}) = ${T} vs ${exact}`);
  }
  // heat through the inner rim: 2π k t r1 m θb (K1(mr1) I1(mr2) − I1(mr1) K1(mr2)) / den
  const q = 2 * Math.PI * k * t * r1 * m * (tb - ta) * (K1(m * r1) * I1(m * r2) - I1(m * r1) * K1(m * r2)) / den;
  assert.ok(Math.abs(-r.flows[0].out - q) / q < 0.02, `base ${-r.flows[0].out} W vs ${q} W`);
  const b = balance(r);
  assert.ok(Math.abs(b.out - b.applied) < 0.005 * q, `balance ${b.out} W`);
});

/** A solid cylinder along Z, radius R, length L: side and the two ends. */
function rod(R: number, L: number, n = 128) {
  const side: number[] = [], ends: number[] = [];
  const P = (i: number, z: number) => [R * Math.cos((2 * Math.PI * i) / n), R * Math.sin((2 * Math.PI * i) / n), z];
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    side.push(...P(i, 0), ...P(j, 0), ...P(j, L), ...P(i, 0), ...P(j, L), ...P(i, L));
    ends.push(0, 0, L, ...P(i, L), ...P(j, L));
    ends.push(0, 0, 0, ...P(j, 0), ...P(i, 0));
  }
  return { tris: Float64Array.from([...side, ...ends]), side };
}

test("cylinder: internal heat, convection on the side, ends insulated (within 1 %)", () => {
  // steel rod R = 10, L = 30 mm, k = 50 W/(m·K), 20 W inside, h = 100 W/(m²·K), air 25 °C
  const Rr = 10, L = 30, k = 0.05, h = 100e-6, P = 20, ta = 25;
  const C = rod(Rr, L), inside = insideOf(new MeshBody(C.tris));
  const r = passes({ lo: [-Rr, -Rr, 0], hi: [Rr, Rr, L], inside, h: 5, k, sinks: [{ tris: C.side, h, ambient: ta }], sources: [{ power: P }] });
  // the faceted section has a little less area than the circle: use the volume the solver spread the power over
  const n = 128, area = 0.5 * n * Rr * Rr * Math.sin((2 * Math.PI) / n), qv = P / (area * L), Re = Math.sqrt(area / Math.PI);
  const exact = (x: number) => ta + (qv * Re) / (2 * h) + (qv * (Re * Re - x * x)) / (4 * k);
  for (const x of [0, 4, 7, 9.5]) {
    const T = r.temp(x, 0.3, L / 2), e = exact(x);
    assert.ok(Math.abs(T - e) / (e - ta) < 0.01, `T(${x}) = ${T} vs ${e}`);
  }
  const b = balance(r);
  assert.ok(Math.abs(b.out - P) < 0.005 * P, `balance ${b.out} W of ${P}`);
});
