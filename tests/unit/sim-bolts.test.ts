// Structural analysis of assemblies (FR-CON-020/021, FR-LOAD-010): bolts as beams between two patches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, type RunInput } from "../../src/sim/run";
import { beamStiffness } from "../../src/sim/static";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxes(list: { id: string; lo: number[]; hi: number[] }[]) {
  const tris: number[] = [], face: number[] = [], names: string[] = [], parts: Float64Array[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    const own: number[] = [];
    for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
      const t = rectFace(a, end ? b.hi[a] : b.lo[a], b.lo, b.hi, !!end);
      names.push(`${b.id}@${"xyz"[a]}${end}`);
      own.push(...t);
      for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
    }
    tris.push(...own);
    parts.push(Float64Array.from(own));
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.lo[a]); hi[a] = Math.max(hi[a], b.hi[a]); }
  }
  return { body: { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi }, parts };
}
const steel = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9, sy: 235 };

// two plates one on the other, not joined where they touch, held together by one bolt through their middle
const S = 40, T = 10, D = 8, F = 1000;
const model = () => boxes([{ id: "a", lo: [0, 0, 0], hi: [S, S, T] }, { id: "b", lo: [0, 0, T], hi: [S, S, 2 * T] }]);
const ring = (z: number, up: boolean) => rectFace(2, z, [S / 2 - 7, S / 2 - 7, 0], [S / 2 + 7, S / 2 + 7, 0], up);
function solve(load: number[] | null, preload = 0, join: "none" | "sliding" | "bonded" = "none") {
  const m = model(), st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  if (load) st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: load.map(v => ({ v })) });
  const inp: RunInput = {
    body: m.body, mat: steel, regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap: 0.1, links: join === "bonded" ? [] : [{ a: 0, b: 1, type: join }] },
    bolts: [{ a: ring(2 * T, true), b: ring(0, false), d: D, E: 210000, ...(preload ? { preload } : {}) }],
    problem: studyProblem(st, m.body), passes: 2, energyTol: 0, pos: Float32Array.from([S, S / 2, 1.5 * T]), nrm: Float32Array.from([1, 0, 0]),
  };
  return [...runStatic(inp)].at(-1)!;
}

test("the beam's stiffness: pulled, sheared and bent as beam theory says", () => {
  const E = 210000, d = 8, L = 50, K = beamStiffness(E, 0.3, d, L, [0, 0, 1]);
  const A = Math.PI * d * d / 4, I = Math.PI * d ** 4 / 64;
  assert.ok(Math.abs(K[12 * 8 + 8] / (E * A / L) - 1) < 1e-12);
  // symmetric, and a rigid motion costs nothing
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) assert.ok(Math.abs(K[12 * i + j] - K[12 * j + i]) < 1e-6 * K[12 * 8 + 8]);
  const turn = [0, L / 2, 0, 1, 0, 0, 0, -L / 2, 0, 1, 0, 0];   // a turn about X through the middle
  for (let i = 0; i < 12; i++) { let v = 0; for (let j = 0; j < 12; j++) v += K[12 * i + j] * turn[j]; assert.ok(Math.abs(v) < 1e-6 * K[12 * 8 + 8], `row ${i}: ${v}`); }
  // end b moved sideways with both ends kept from turning: 12EI/L³ less the shear's share
  const phi = 12 * E * I / (0.9 * (E / 2.6) * A * L * L);
  assert.ok(Math.abs(K[12 * 6 + 6] / (12 * E * I / L ** 3 / (1 + phi)) - 1) < 1e-12);
});

test("a bolt alone holds a plate pulled off another: its tension is the load", () => {
  const r = solve([0, 0, F]), b = r.bolts![0];
  assert.ok(Math.abs(b.axial / F - 1) < 0.01, `axial ${b.axial}`);
  assert.ok(b.shear < 0.01 * F, `shear ${b.shear}`);
  assert.ok(Math.abs(b.length - 2 * T) < 1e-9);
  // the load acts at the plate's edge, half a plate from the bolt
  assert.ok(Math.abs(b.moment / (F * S / 2) - 1) < 0.05, `moment ${b.moment}`);
  assert.ok(Math.abs(r.reactions[0].force[2] / -F - 1) < 0.01, `reaction ${r.reactions[0].force}`);
});

test("pushed sideways the bolt carries the load in shear", () => {
  const r = solve([0, F, 0]), b = r.bolts![0];
  assert.ok(Math.abs(b.shear / F - 1) < 0.01, `shear ${b.shear}`);
  assert.ok(Math.abs(b.axial) < 0.05 * F, `axial ${b.axial}`);
  assert.ok(Math.abs(b.torsion / (F * S / 2) - 1) < 0.05, `torsion ${b.torsion}`);
});

test("tightening leaves the preload in the bolt; plates that touch take most of a pull off it", () => {
  const P = 5000;
  const tight = solve(null, P, "sliding"), tb = tight.bolts![0];
  assert.ok(Math.abs(tb.axial / P - 1) < 1e-6, `axial ${tb.axial}`);
  // the plates are pressed together under the head
  assert.ok(tight.maxVm > 1, `stress ${tight.maxVm}`);
  const c = tight.contacts![0];
  assert.ok(Math.abs(Math.abs(c.force![2]) / P - 1) < 0.02, `clamping force ${c.force}`);
  for (const join of ["sliding", "bonded"] as const) {
    const r = solve([0, 0, F], P, join), b = r.bolts![0];
    assert.ok(b.axial > P - 1 && b.axial - P < 0.5 * F, `${join}: axial ${b.axial}`);
  }
});

test("plates that are not joined cannot take a preload", () => {
  assert.throws(() => solve(null, 5000, "none"), /E-SIM-PRELOAD/);
});
