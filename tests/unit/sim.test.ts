// Structural analysis spike (FRS-structural SA0, AT-SA0-1..3): cell basis, cut-cell quadrature and the
// linear static solve against closed-form answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Basis, basisSize, legendre } from "../../src/sim/basis";
import { gauss, volumePoints, gridTrianglePoints, fitPoints } from "../../src/sim/quad";
import { solveStatic, vonMises } from "../../src/sim/static";

/** Two triangles of the axis-aligned rectangle x[axis] = at, outward normal along ±axis. */
function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

test("Legendre values and Gauss rules", () => {
  const o = new Float64Array(18);
  legendre(4, 0.5, o);
  assert.ok(Math.abs(o[8] - (35 * 0.0625 - 30 * 0.25 + 3) / 8) < 1e-14);
  assert.ok(Math.abs(o[9] - (140 * 0.125 - 60 * 0.5) / 8) < 1e-13);
  for (const n of [1, 2, 3, 5, 8]) {
    const g = gauss(n);
    // exact for x^(2n−2) and x^(2n−1)... check the even moment
    let s = 0, sw = 0;
    for (let i = 0; i < n; i++) { s += g.w[i] * g.x[i] ** (2 * n - 2); sw += g.w[i]; }
    assert.ok(Math.abs(sw - 2) < 1e-13);
    assert.ok(Math.abs(s - 2 / (2 * n - 1)) < 1e-13);
  }
  assert.equal(basisSize(2), 10);
  const b = new Basis(3);
  assert.equal(b.n, 20);
  b.eval(1, 2, 3, [0, 0, 0], 2);
  assert.equal(b.v[0], 1);
});

test("cut-cell quadrature finds the volume of a ball", () => {
  const r = 1;
  const pts = volumePoints([-1, -1, -1], [1, 1, 1], 3, (x, y, z) => x * x + y * y + z * z <= r * r, 6);
  const v = pts.weight();
  assert.ok(Math.abs(v - (4 / 3) * Math.PI) / ((4 / 3) * Math.PI) < 0.01, `volume ${v}`);
});

test("moment fitting keeps the integrals of degree-2p polynomials", () => {
  const inside = (x: number, y: number, z: number) => x * x + y * y + z * z <= 1.3;
  const fine = volumePoints([0, 0, 0], [1, 1, 1], 4, inside, 4);
  const fit = fitPoints(fine, [0, 0, 0], [1, 1, 1], 5);
  assert.equal(fit.n <= 125, true);
  const f = (x: number, y: number, z: number) => x ** 4 * y ** 2 - 3 * x * y ** 3 * z ** 4 + z ** 3 + 1;
  const sum = (P: typeof fine) => { let s = 0; for (let i = 0; i < P.n; i++) s += P.a[4 * i + 3] * f(P.a[4 * i], P.a[4 * i + 1], P.a[4 * i + 2]); return s; };
  assert.ok(Math.abs(sum(fit) - sum(fine)) < 1e-12 * fine.n);
});

test("triangles cut along grid planes keep their area", () => {
  const tris = [0.3, 0.2, 0, 4.7, 0.9, 0, 1.1, 3.8, 0];
  const { pts } = gridTrianglePoints(tris, [0, 0, 0], 1, 3);
  const area = 0.5 * Math.abs((4.7 - 0.3) * (3.8 - 0.2) - (1.1 - 0.3) * (0.9 - 0.2));
  assert.ok(Math.abs(pts.weight() - area) < 1e-12);
});

const L = 200, W = 20, F = 1000, E = 210000;
const lo = [0, -W / 2, -W / 2], hi = [L, W / 2, W / 2];
const inBox = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && Math.abs(y) <= W / 2 + 1e-12 && Math.abs(z) <= W / 2 + 1e-12;

test("patch test: a bar in tension with ν = 0 is exact, also on cut cells", () => {
  for (const h of [20, 13]) {
    // h 13: the grid does not fit the bar, so its ends and sides cut cells; the cut-cell volume is
    // found to ~1e-3 at quadrature depth 3, which bounds how exact the answer can be there
    const tol = h === 20 ? 1e-6 : 2e-3;
    const r = solveStatic({
      lo, hi, inside: inBox, h, p: 1, mat: { E, nu: 0 },
      fixed: [{ tris: rectFace(0, 0, lo, hi, false) }],
      loads: [{ tris: rectFace(0, L, lo, hi, true), force: [F, 0, 0] }],
    });
    const want = F * L / (E * W * W);
    const u = r.disp(L - 1e-9, 3, -4)[0];
    assert.ok(Math.abs(u - want) / want < tol, `h ${h}: u ${u} want ${want}`);
    const sx = r.stress(77, 1, 2)[0];
    assert.ok(Math.abs(sx - F / (W * W)) < 10 * tol * F / (W * W), `σx ${sx}`);
  }
});

test("cantilever tip deflection matches beam theory for p = 2..4", () => {
  const I = W ** 4 / 12, G = E / 2.6;
  const want = F * L ** 3 / (3 * E * I) + F * L / ((5 / 6) * G * W * W);
  for (const [h, p] of [[10, 2], [20, 3], [20, 4], [40, 4]]) {
    const r = solveStatic({
      lo, hi, inside: inBox, h, p, mat: { E, nu: 0.3 },
      fixed: [{ tris: rectFace(0, 0, lo, hi, false) }],
      loads: [{ tris: rectFace(0, L, lo, hi, true), force: [0, 0, -F] }],
    });
    const w = -r.disp(L - 1e-9, 0, 0)[2];
    assert.ok(Math.abs(w - want) / want < 0.03, `h ${h} p ${p}: ${w} vs ${want}`);
    // bending stress at mid span, top fibre: M c / I
    const s = r.stress(L / 2, 0, W / 2 - 1e-9)[0];
    const sb = F * (L / 2) * (W / 2) / I;
    assert.ok(Math.abs(s - sb) / sb < 0.05, `σ ${s} vs ${sb}`);
    assert.ok(vonMises([s, 0, 0, 0, 0, 0]) >= 0);
  }
});

test("round bar cantilever on cut cells", () => {
  const R = 10, N = 64;
  const disk = (x: number, out: boolean) => {
    const t: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N, b = (2 * Math.PI * (i + 1)) / N;
      const P = [x, R * Math.cos(a), R * Math.sin(a)], Q = [x, R * Math.cos(b), R * Math.sin(b)];
      t.push(...(out ? [x, 0, 0, ...P, ...Q] : [x, 0, 0, ...Q, ...P]));
    }
    return t;
  };
  const I = (Math.PI * (2 * R) ** 4) / 64, A = Math.PI * R * R, G = E / 2.6;
  const want = (F * L ** 3) / (3 * E * I) + (F * L) / (0.886 * G * A);
  const r = solveStatic({
    lo: [0, -R, -R], hi: [L, R, R], inside: (x, y, z) => x >= 0 && x <= L && y * y + z * z <= R * R,
    h: 10, p: 2, mat: { E, nu: 0.3 },
    fixed: [{ tris: disk(0, false) }], loads: [{ tris: disk(L, true), force: [0, 0, -F] }],
  });
  const w = -r.disp(L - 1e-9, 0, 0)[2];
  assert.ok(Math.abs(r.grid.volume - A * L) / (A * L) < 2e-3);
  assert.ok(Math.abs(w - want) / want < 0.03, `${w} vs ${want}`);
});

test("strain energy grows with the degree (the passes converge from below)", () => {
  let last = 0;
  for (const p of [1, 2, 3]) {
    const r = solveStatic({
      lo, hi, inside: inBox, h: 20, p, mat: { E, nu: 0.3 },
      fixed: [{ tris: rectFace(0, 0, lo, hi, false) }],
      loads: [{ tris: rectFace(0, L, lo, hi, true), force: [0, 0, -F] }],
    });
    assert.ok(r.energy > last, `p ${p}: ${r.energy} <= ${last}`);
    last = r.energy;
  }
});

test("Lamé thick cylinder: pressure, sliding supports and curved cut cells", () => {
  // quarter cylinder a = 10, b = 20, length 10, internal pressure 100 MPa, plane strain ends
  const a = 10, b = 20, Lz = 10, pr = 100, N = 48, q = Math.PI / 2;
  const arc = (r: number) => {
    const t: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = (q * i) / N, t1 = (q * (i + 1)) / N;
      const P0 = [r * Math.cos(t0), r * Math.sin(t0), 0], P1 = [r * Math.cos(t1), r * Math.sin(t1), 0];
      const Q0 = [P0[0], P0[1], Lz], Q1 = [P1[0], P1[1], Lz];
      t.push(...P0, ...Q1, ...P1, ...P0, ...Q0, ...Q1); // facing the axis (the inner surface's outward side)
    }
    return t;
  };
  const ring = (z: number, up: boolean) => {
    const t: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = (q * i) / N, t1 = (q * (i + 1)) / N;
      const A0 = [a * Math.cos(t0), a * Math.sin(t0), z], A1 = [a * Math.cos(t1), a * Math.sin(t1), z];
      const B0 = [b * Math.cos(t0), b * Math.sin(t0), z], B1 = [b * Math.cos(t1), b * Math.sin(t1), z];
      t.push(...(up ? [...A0, ...B1, ...B0, ...A0, ...A1, ...B1] : [...A0, ...B0, ...B1, ...A0, ...B1, ...A1]));
    }
    return t;
  };
  const sym = (axis: number) => { const l = [0, 0, 0], h = [0, 0, Lz], o = axis === 0 ? 1 : 0; l[o] = a; h[o] = b; return rectFace(axis, 0, l, h, false); };
  const r = solveStatic({
    lo: [0, 0, 0], hi: [b, b, Lz], h: 5, p: 3, mat: { E, nu: 0.3 },
    inside: (x, y, z) => { const rr = x * x + y * y; return x >= 0 && y >= 0 && z >= 0 && z <= Lz && rr >= a * a && rr <= b * b; },
    fixed: [{ tris: sym(0), sliding: true }, { tris: sym(1), sliding: true }, { tris: ring(0, false), sliding: true }, { tris: ring(Lz, true), sliding: true }],
    loads: [{ tris: arc(a), pressure: pr }],
  });
  const c = Math.SQRT1_2 * a + 1e-6;
  const s = r.stress(c, c, Lz / 2);
  const hoop = (s[0] + s[1]) / 2 - s[3];
  const want = (pr * (b * b + a * a)) / (b * b - a * a);
  assert.ok(Math.abs(hoop - want) / want < 0.02, `hoop ${hoop} vs ${want}`);
  const u = r.disp(c, c, Lz / 2);
  const uw = ((1 + 0.3) * pr * a * a) / (E * (b * b - a * a)) * ((1 - 2 * 0.3) * a + (b * b) / a);
  assert.ok(Math.abs(Math.hypot(u[0], u[1]) - uw) / uw < 0.01, `ur ${Math.hypot(u[0], u[1])} vs ${uw}`);
});
