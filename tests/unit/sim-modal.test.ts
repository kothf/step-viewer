// Structural analysis SA2 (AT-SA2-1, AT-SA2-2, AT-SA2-4): natural frequencies against beam theory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveStatic } from "../../src/sim/static";
import { reduced } from "../../src/sim/eigen";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 500, B = 20, T = 10, E = 210000, rho = 7.85e-9;
const lo = [0, -B / 2, -T / 2], hi = [L, B / 2, T / 2];
const inBox = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && Math.abs(y) <= B / 2 + 1e-12 && Math.abs(z) <= T / 2 + 1e-12;
const beam = (k: number, t: number) => (k * k / (2 * Math.PI)) * Math.sqrt((E * t * t / 12) / (rho * L ** 4));

test("small generalised eigenproblem", () => {
  const r = reduced(Float64Array.from([2, 0, 0, 8]), Float64Array.from([1, 0, 0, 2]), 2);
  assert.ok(Math.abs(r.val[0] - 2) < 1e-12 && Math.abs(r.val[1] - 4) < 1e-12);
});

test("cantilever 500 × 20 × 10: bending frequencies match beam theory", () => {
  let start: Float64Array[] | undefined, grid;
  for (const p of [2, 3]) {
    const t0 = Date.now();
    const r = solveStatic({
      lo, hi, inside: inBox, h: 10, p, grid, mat: { E, nu: 0.3, rho },
      fixed: [{ tris: rectFace(0, 0, lo, hi, false) }], loads: [], modal: { count: 6, start },
    });
    grid = r.grid; start = r.space;
    const m = r.modes!;
    console.log(`p ${p} dofs ${r.dofs} ${Date.now() - t0} ms`, m.map(v => v.hz.toFixed(2)).join(" "), "eff", m.map(v => v.eff.map(e => e.toFixed(3)).join("/")).join(" "));
    assert.ok(Math.abs(r.mass! - rho * L * B * T) / r.mass! < 1e-6);
    if (p === 3) {
      assert.ok(Math.abs(m[0].hz - beam(1.8751, T)) / beam(1.8751, T) < 0.02, `f1 ${m[0].hz} vs ${beam(1.8751, T)}`);
      assert.ok(Math.abs(m[1].hz - beam(1.8751, B)) / beam(1.8751, B) < 0.02, `f2 ${m[1].hz} vs ${beam(1.8751, B)}`);
      assert.ok(Math.abs(m[2].hz - beam(4.6941, T)) / beam(4.6941, T) < 0.02, `f3 ${m[2].hz}`);
      // the first bending mode carries 61 % of the mass across the beam
      assert.ok(Math.abs(m[0].eff[2] - 0.613) < 0.02 && m[0].eff[0] < 1e-3);
      r.use!(0);
      const u = r.disp(L - 1e-6, 0, 0);
      assert.ok(Math.abs(u[2]) > 10 * Math.abs(u[0]) && Math.abs(u[2]) > 10 * Math.abs(u[1]));
    }
  }
});

test("free beam: six rigid-body modes, then the first bending mode", () => {
  const r = solveStatic({ lo, hi, inside: inBox, h: 10, p: 3, mat: { E, nu: 0.3, rho }, fixed: [], loads: [], modal: { count: 8 } });
  const m = r.modes!;
  console.log(m.map(v => `${v.hz.toFixed(3)}${v.rigid ? "r" : ""}`).join(" "));
  assert.equal(m.filter(v => v.rigid).length, 6);
  assert.ok(m.slice(0, 6).every(v => v.rigid && v.hz === 0));
  assert.ok(Math.abs(m[6].hz - beam(4.7300, T)) / beam(4.7300, T) < 0.02, `f ${m[6].hz} vs ${beam(4.73, T)}`);
});

test("modal passes of a study: frequencies settle, shapes are scaled to 1, a new modal study is named and set up", async () => {
  const { runModal, studyProblem } = await import("../../src/sim/run");
  const { newStudy } = await import("../../src/sim/types");
  const tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
    names.push("xyz"[a] + end);
    tris.push(...t);
    for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
  }
  const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
  const st = newStudy([newStudy([])], "modal");
  assert.deepEqual([st.id, st.name, st.kind, st.settings.modes], ["st2", "Modal 1", "modal", 6]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  const pos = new Float32Array([L, 0, 0, L / 2, 0, T / 2]), nrm = new Float32Array([1, 0, 0, 0, 0, 1]);
  const passes = [...runModal({ body, mat: { name: "Steel", E, nu: 0.3, rho }, problem: studyProblem(st, body), passes: 3, energyTol: 2, pos, nrm, modal: { count: 4 } })];
  const last = passes.at(-1)!;
  assert.ok(passes.length >= 2 && last.converged && last.done, `passes ${passes.length}, change ${last.change}`);
  assert.equal(last.modes!.length, 4);
  assert.ok(Math.abs(last.modes![0].hz - beam(1.8751, T)) / beam(1.8751, T) < 0.02);
  // the first mode bends across the thin side: the tip moves along Z by the whole scale
  const s0 = last.shapes![0];
  assert.ok(Math.abs(s0[2] - 1) < 1e-6 && Math.abs(s0[0]) < 0.05, `${Array.from(s0.slice(0, 3))}`);
  assert.ok(Math.abs(last.mass! - rho * L * B * T) / last.mass! < 1e-6);
  assert.throws(() => [...runModal({ body, mat: { name: "x", E, nu: 0.3, rho: 0 }, problem: studyProblem(st, body), passes: 1, energyTol: 2, pos, nrm, modal: { count: 2 } })], /E-SIM-DENSITY/);
});
