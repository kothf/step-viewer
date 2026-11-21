// Structural analysis: results inside the body (FR-RES-030). The last pass's solution is kept and read at
// the points of a section plane; on a plot drawn deformed, the place each point came from is found first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, sampleAt, type Sampler } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { pathChart, pathChartSvg, pathCsv, pathPoints, pathRows } from "../../src/sim/path";
import { MeshBody, insideOf } from "../../src/sim/body";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 10, E = 210000;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const study = () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -100 }] });
  return st;
};
let kept: Sampler | null = null, calls = 0;
const passes = [...runStatic({ body, mat: { name: "Steel", E, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(study(), body), passes: 3, energyTol: 0,
  pos: new Float32Array([L, B / 2, T / 2]), nrm: new Float32Array([1, 0, 0]) }, s => { kept = s; calls++; })];

test("section results: the kept solution gives the bending stress across a cut of a cantilever", () => {
  assert.equal(calls, passes.length);
  assert.ok(kept);
  const zs = [0.5, 2.5, 5, 7.5, 9.5], pos = new Float32Array([...zs.flatMap(z => [L / 2, B / 2, z]), 5 * L, B / 2, T / 2]);
  const r = sampleAt(kept!, pos);
  assert.deepEqual([...r.hit], [1, 1, 1, 1, 1, 0]);
  assert.equal(r.vm[5], 0);
  const I = (B * T ** 3) / 12, M = 100 * (L / 2);
  zs.forEach((z, i) => {
    const sx = (M * Math.abs(z - T / 2)) / I, tau = z === 5 ? (1.5 * 100) / (B * T) : 0, want = Math.hypot(sx, Math.sqrt(3) * tau);
    assert.ok(Math.abs(r.vm[i] - want) < 0.08 * (M * (T / 2)) / I, `z ${z}: ${r.vm[i]} vs ${want}`);
  });
  // the deflection at mid length: F x² (3L − x) / 6EI
  const d = (100 * (L / 2) ** 2 * (3 * L - L / 2)) / (6 * E * I);
  assert.ok(Math.abs(-r.u[3 * 2 + 2] / d - 1) < 0.04, `${r.u[8]} vs ${d}`);
});

test("section results: points of the deformed shape are traced back to where they came from", () => {
  const at = [L * 0.8, B / 2, T / 2], plain = sampleAt(kept!, new Float32Array(at));
  const u = [plain.u[0], plain.u[1], plain.u[2]], scale = 2 / Math.hypot(...u);
  const moved = new Float32Array(at.map((x, i) => x + scale * u[i]));
  const back = sampleAt(kept!, moved, scale);
  assert.equal(back.hit[0], 1);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back.u[i] - u[i]) < 1e-3 * Math.hypot(...u), `${back.u[i]} vs ${u[i]}`);
  assert.ok(Math.abs(back.vm[0] - plain.vm[0]) < 0.01 * plain.vm[0] + 1e-6);
});

test("results along a path: a line through the bar's depth reads the bending stress, with gaps outside the part", () => {
  // from below the bar to above it, at mid length: inside for 0 < z < T
  const a = [L / 2, B / 2, -T / 2], b = [L / 2, B / 2, 1.5 * T], pos = pathPoints(a, b, 41);
  assert.equal(pos.length, 123);
  assert.deepEqual([pos[0], pos[1], pos[2]], a);
  assert.ok(Math.abs(pos[122] - b[2]) < 1e-6);
  const r = sampleAt(kept!, pos, 0, insideOf(new MeshBody(body.tris)));
  const rows = pathRows(pos, r.vm, r.u, r.solid!);
  const inside = rows.filter(q => q.ok);
  assert.ok(inside.length >= 18 && inside.length <= 21, String(inside.length));
  assert.ok(inside.every(q => q.at[2] > -1e-6 && q.at[2] < T + 1e-6));
  assert.ok(Math.abs(rows[40].d - 2 * T) < 1e-5);
  const I = (B * T ** 3) / 12, top = (100 * (L / 2) * (T / 2)) / I;
  // highest at the outer fibres, lowest near the neutral axis
  const hi = Math.max(...inside.map(q => q.vm)), lo = Math.min(...inside.map(q => q.vm));
  assert.ok(Math.abs(hi / top - 1) < 0.12 && lo < 0.25 * top, `${hi} ${lo} vs ${top}`);
  const c = pathChart(rows.map(q => q.d), rows.map(q => q.vm), rows.map(q => (q.ok ? 1 : 0)))!;
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].length, inside.length);
  assert.ok(c.lo === 0 && Math.abs(c.hi - hi) < 1e-9 && Math.abs(c.length - 2 * T) < 1e-5);
  const svg = pathChartSvg(c, "von Mises stress", v => v.toFixed(1), "20 mm");
  assert.ok(svg.includes("<polyline") && svg.includes("20 mm") && svg.includes("sim-pathchart"));
  const csv = pathCsv(rows).trim().split("\r\n");
  assert.equal(csv.length, 42);
  assert.ok(csv[0].startsWith("Distance (mm),X (mm)"));
  assert.equal(csv[1].split(",").slice(4).join(""), "", "no values outside the part");
  assert.equal(csv[21].split(",").length, 9);
  assert.ok(Number(csv[21].split(",")[4]) >= 0);
  // nothing to chart for a path that misses the part
  assert.equal(pathChart([0, 1, 2], [1, 2, 3], [0, 0, 0]), null);
});
