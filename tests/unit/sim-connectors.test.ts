// Structural analysis (FR-CON-023): rigid and spring connectors between faces, and masses spread over faces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, runModal, type RunInput } from "../../src/sim/run";
import { newStudy, type Study, type StudyConnector } from "../../src/sim/types";

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



// two bars in line with a 5 mm gap between them: nothing joins them but the connector
const model = () => boxes([{ id: "a", lo: [0, 0, 0], hi: [50, 10, 10] }, { id: "b", lo: [55, 0, 0], hi: [105, 10, 10] }]);
const conn = (more: Partial<StudyConnector> = {}): StudyConnector => ({ id: "k1", type: "connector", faces: [{ name: "a@x1" }], faces2: [{ name: "b@x0" }], kind: "rigid", k: [0, 0, 0], ...more });
function input(st: Study): RunInput {
  const m = model();
  return {
    body: m.body, mat: steel, regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap: 0.1, links: [] },
    problem: studyProblem(st, m.body), passes: 2, energyTol: 0, pos: Float32Array.from([105, 5, 5]), nrm: Float32Array.from([1, 0, 0]),
  };
}
function solve(c: StudyConnector | null, load: number[]) {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: load.map(v => ({ v })) });
  if (c) st.connectors = [c];
  return [...runStatic(input(st))].at(-1)!;
}

test("a rigid connector makes two bars one cantilever and passes the whole load on", () => {
  const r = solve(conn(), [0, 0, -100]);
  const c = r.connectors![0];
  assert.ok(Math.abs(c.force[2] / 100 - 1) < 0.01 && Math.abs(c.force[0]) < 1 && Math.abs(c.force[1]) < 1, `force ${c.force}`);
  // the load's moment about the midpoint of the gap: 100 N × 52.5 mm about Y
  assert.ok(Math.abs(Math.abs(c.moment[1]) / 5250 - 1) < 0.02, `moment ${c.moment}`);
  // a cantilever 105 long with a rigid 5 mm piece: between the 100 mm and the 105 mm beam
  const I = 1e4 / 12, d = (L: number) => 100 * L ** 3 / (3 * 210000 * I);
  assert.ok(r.maxU > 0.95 * d(100) && r.maxU < 1.08 * d(105), `tip ${r.maxU} between ${d(100)} and ${d(105)}`);
});

test("a spring connector stretches by force over stiffness and does not let the bars turn", () => {
  const r = solve(conn({ kind: "spring", k: [1000, 500, 500] }), [100, 0, 0]);
  const c = r.connectors![0];
  assert.ok(Math.abs(c.stretch[0] / 0.1 - 1) < 0.01, `stretch ${c.stretch}`);
  assert.ok(Math.abs(c.force[0] / -100 - 1) < 0.01, `force ${c.force}`);
  assert.ok(r.maxU > 0.1 && r.maxU < 0.11, `u ${r.maxU}`);
});

test("without a connector the second bar is loose; a spring with no stiffness along the bars leaves it loose too", () => {
  assert.throws(() => solve(null, [100, 0, 0]), /E-SIM-LOOSE: 1/);
  assert.throws(() => solve(conn({ kind: "spring", k: [0, 500, 500] }), [100, 0, 0]), /E-SIM-LOOSE: 1/);
  assert.throws(() => solve(conn({ kind: "spring", k: [0, 0, 0], kr: 0 }), [100, 0, 0]), /E-SIM-SPRING: k1/);
  assert.throws(() => solve(conn({ faces2: [] }), [100, 0, 0]), /E-SIM-EMPTY: k1/);
});

test("a mass on the end face weighs under gravity and lowers the first frequency", () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "gravity", faces: [], comp: [{ v: 0 }, { v: 0 }, { v: -9806.65 }] });
  st.connectors = [conn()];
  const own = 2 * 50 * 10 * 10 * 7.85e-9 * 9806.65;
  const r0 = [...runStatic(input(st))].at(-1)!;
  assert.ok(Math.abs(r0.reactions[0].force[2] / own - 1) < 0.01, `own weight ${r0.reactions[0].force[2]} of ${own}`);
  st.masses = [{ id: "m1", type: "mass", faces: [{ name: "b@x1" }], mass: 0.5 }];
  const r1 = [...runStatic(input(st))].at(-1)!;
  assert.ok(Math.abs(r1.reactions[0].force[2] / (own + 0.5e-3 * 9806.65) - 1) < 0.01, `with the mass ${r1.reactions[0].force[2]}`);
  assert.ok(r1.maxU > 3 * r0.maxU, `sag ${r0.maxU} -> ${r1.maxU}`);
  // modal: 0.5 kg on the tip of a 0.08 kg cantilever: f ≈ √(3EI / (L³ (m + 0.24 m_bar))) / 2π
  const sm = newStudy([], "modal");
  sm.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  sm.connectors = [conn()];
  const f = (s: Study) => [...runModal({ ...input(s), modal: { count: 2 } })].at(-1)!;
  const m0 = f(sm);
  sm.masses = [{ id: "m1", type: "mass", faces: [{ name: "b@x1" }], mass: 0.5 }];
  const m1 = f(sm);
  const I = 1e4 / 12, bar = 105 * 100 * 7.85e-9, hz = Math.sqrt(3 * 210000 * I / (105 ** 3 * (0.5e-3 + 0.24 * bar))) / (2 * Math.PI);
  assert.ok(m1.modes![0].hz < 0.5 * m0.modes![0].hz, `first mode ${m0.modes![0].hz} -> ${m1.modes![0].hz}`);
  assert.ok(Math.abs(m1.modes![0].hz / hz - 1) < 0.1, `first mode ${m1.modes![0].hz} against ${hz}`);
  assert.ok(Math.abs(m1.mass! / (2 * 50 * 100 * 7.85e-9 + 0.5e-3) - 1) < 0.01, `mass ${m1.mass}`);
});
