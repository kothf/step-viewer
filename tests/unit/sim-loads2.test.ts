// Structural analysis SA2 loads and supports (FR-SUP-005, FR-SUP-006, FR-LOAD-007): elastic support,
// enforced displacement and centrifugal load against closed forms on a bar held like a symmetric piece.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveStatic, freeModes, type Support } from "../../src/sim/static";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 10, E = 210000, rho = 7.85e-9, A = B * T;
const lo = [0, 0, 0], hi = [L, B, T];
const inside = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && y >= -1e-12 && y <= B + 1e-12 && z >= -1e-12 && z <= T + 1e-12;
const x0 = rectFace(0, 0, lo, hi, false), x1 = rectFace(0, L, lo, hi, true), y0 = rectFace(1, 0, lo, hi, false), z0 = rectFace(2, 0, lo, hi, false);
// the faces y = 0 and z = 0 slide: with x held at one end the bar is in plain tension
const sym: Support[] = [{ tris: y0, mode: "sliding" }, { tris: z0, mode: "sliding" }];
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${what}: ${a} vs ${b}`);

test("enforced displacement: a bar stretched by 0.1 mm carries E A δ / L", () => {
  const d = 0.1;
  const r = solveStatic({ lo, hi, inside, h: 10, p: 2, mat: { E, nu: 0.3 }, loads: [],
    fixed: [{ tris: x0, mode: "sliding" }, ...sym, { tris: x1, mode: "dirs", dirs: [true, false, false], value: [d, 0, 0] }] });
  const F = (E * A * d) / L;
  near(r.disp(L / 2, B / 2, T / 2)[0], d / 2, 1e-4, "mid displacement");
  near(r.disp(L - 1e-9, B / 2, T / 2)[0], d, 1e-4, "end displacement");
  near(r.reactions[0].force[0], -F, 1e-4, "reaction at the held end");
  near(r.reactions[3].force[0], F, 1e-4, "force of the moved end");
  // an edge moved instead of a face: the bar follows it too
  const edge = [L, 0, 0, L, B, 0, -1, 0, 1];
  const r2 = solveStatic({ lo, hi, inside, h: 10, p: 2, mat: { E, nu: 0.3 }, loads: [],
    fixed: [{ tris: x0, mode: "sliding" }, ...sym, { tris: [], lines: edge, mode: "dirs", dirs: [true, false, false], value: [d, 0, 0] }] });
  near(r2.disp(L - 1e-9, B / 2, 1e-6)[0], d, 0.05, "edge displacement");
});

test("elastic support: the bar sinks F / (k A) into its springs", () => {
  const k = 50, F = 1000;
  const spring: Support = { tris: x0, mode: "sliding", spring: { kn: k, kt: 0 } };
  assert.equal(freeModes([spring, ...sym], lo, hi), 0);
  const r = solveStatic({ lo, hi, inside, h: 10, p: 2, mat: { E, nu: 0.3 }, fixed: [spring, ...sym], loads: [{ tris: x1, force: [F, 0, 0] }] });
  near(r.disp(1e-9, B / 2, T / 2)[0], F / (k * A), 1e-4, "sink");
  near(r.disp(L - 1e-9, B / 2, T / 2)[0], F / (k * A) + (F * L) / (E * A), 1e-4, "end");
  near(r.reactions[0].force[0], -F, 1e-4, "spring reaction");
  // tangential springs alone hold the bar across: it can still lift off and tip two ways
  assert.equal(freeModes([{ tris: x0, mode: "tangent", spring: { kn: 0, kt: k } }], lo, hi), 3);
  const side = solveStatic({ lo, hi, inside, h: 10, p: 2, mat: { E, nu: 0.3 }, loads: [{ tris: x1, force: [0, F, 0] }],
    fixed: [{ tris: x0, mode: "fixed", spring: { kn: 1e6, kt: k } }] });
  near(side.reactions[0].force[1], -F, 1e-3, "shear reaction");
});

test("centrifugal load: a spinning bar pulls ρ ω² A L² / 2 on its hub", () => {
  const omega = (2 * Math.PI * 6000) / 60;
  const r = solveStatic({ lo, hi, inside, h: 10, p: 3, mat: { E, nu: 0.3, rho }, loads: [],
    fixed: [{ tris: x0, mode: "sliding" }, ...sym], spin: { p: [0, 0, 0], axis: [0, 0, 1], omega } });
  near(r.reactions[0].force[0], -(rho * omega * omega * A * L * L) / 2, 1e-3, "hub force");
  near(r.applied.force[1], rho * omega * omega * L * T * B * B / 2, 1e-6, "sideways force");
  near(r.disp(L - 1e-9, 1e-6, 1e-6)[0], (rho * omega * omega * L ** 3) / (3 * E), 0.02, "tip");
  // speeding up: the inertia force −ρ α × r turns against the spin, its moment about the axis is −α I
  const al = 500;
  const a = solveStatic({ lo, hi, inside, h: 10, p: 2, mat: { E, nu: 0.3, rho }, loads: [], fixed: [{ tris: x0 }], spin: { p: [0, 0, 0], axis: [0, 0, 1], omega: 0, alpha: al } });
  near(a.applied.moment[2], -al * rho * T * (B * L ** 3 / 3 + L * B ** 3 / 3), 1e-6, "inertia moment");
});

test("study items: elastic support, enforced displacement and centrifugal load become the solver's problem", async () => {
  const { studyProblem, axisLine, runStatic } = await import("../../src/sim/run");
  const { newStudy } = await import("../../src/sim/types");
  const tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
    names.push("xyz"[a] + end);
    tris.push(...t);
    for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
  }
  const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "elastic", faces: [{ name: "x0" }], kn: 50, kt: 0 }, { id: "s2", type: "sliding", faces: [{ name: "y0" }] }, { id: "s3", type: "sliding", faces: [{ name: "z0" }] },
    { id: "s4", type: "disp", faces: [{ name: "x1" }], dirs: [true, false, false], disp: [0.2, 5, 5] }, { id: "s5", type: "elastic", faces: [{ name: "y1" }], kn: 0, kt: 0 });
  st.loads.push({ id: "l1", type: "centrifugal", faces: [], axis: "y", value: { v: 3000 }, accel: 2 }, { id: "l2", type: "centrifugal", faces: [], value: { v: 1 } });
  const pb = studyProblem(st, body);
  assert.deepEqual(pb.problems, [{ id: "s5", code: "E-SIM-SPRING" }, { id: "l2", code: "E-SIM-ONESPIN" }]);
  assert.deepEqual(pb.supportIds, ["s1", "s2", "s3", "s4"]);
  assert.deepEqual([pb.fixed[0].mode, pb.fixed[0].spring], ["sliding", { kn: 50, kt: 0 }]);
  // only the ticked direction is moved
  assert.deepEqual([pb.fixed[3].mode, pb.fixed[3].dirs, Array.from(pb.fixed[3].value!)], ["dirs", [true, false, false], [0.2, 0, 0]]);
  assert.deepEqual([pb.spin!.axis, pb.spin!.p, pb.spin!.alpha], [[0, 1, 0], [0, 0, 0], 2]);
  near(pb.spin!.omega, 100 * Math.PI, 1e-12, "rad/s");
  // enforced displacement alone is a load: springs at one end, the other end moved
  st.loads.length = 0; st.supports.pop();
  const last = [...runStatic({ body, mat: { name: "Steel", E, nu: 0.3, rho }, problem: studyProblem(st, body), passes: 1, energyTol: 2, pos: new Float32Array([0, B / 2, T / 2]), nrm: new Float32Array([-1, 0, 0]) })].at(-1)!;
  // springs k A in series with the bar E A / L share the 0.2 mm
  const kb = (E * A) / L, ks = 50 * A, F = 0.2 / (1 / kb + 1 / ks);
  near(last.u[0], F / ks, 1e-3, "spring end");
  near(last.reactions[0].force[0], -F, 1e-3, "spring force");
  near(last.energy, (F * F) / (2 * kb), 1e-3, "strain energy of the bar");

  // a half cylinder of radius 3 about the line through (5, 7, ·) along Z
  const cyl: number[] = [];
  for (let i = 0; i < 16; i++) {
    const a0 = (Math.PI * i) / 16, a1 = (Math.PI * (i + 1)) / 16;
    const P = (a: number, z: number) => [5 + 3 * Math.cos(a), 7 + 3 * Math.sin(a), z];
    cyl.push(...P(a0, 0), ...P(a1, 0), ...P(a1, 10), ...P(a0, 0), ...P(a1, 10), ...P(a0, 10));
  }
  const ln = axisLine(cyl)!;
  assert.ok(Math.abs(Math.abs(ln.axis[2]) - 1) < 1e-9);
  assert.ok(Math.abs(ln.p[0] - 5) < 1e-6 && Math.abs(ln.p[1] - 7) < 1e-6, `${ln.p}`);
  assert.equal(axisLine(rectFace(0, 0, lo, hi, false)), null);
});
