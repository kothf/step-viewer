// Local accuracy in thermal studies (FR-TSOL-003): elements of different degrees on one grid, local passes that
// raise the degree where the temperatures still move, the weighted joint between bodies of very different
// conductivity and the finer cells of an assembly with a thin board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal } from "../../src/sim/thermal";
import { basisSize } from "../../src/sim/basis";
import { cellSize, runThermal, studyProblem, thermalCellSize, thermalSetup } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { MeshBody, insideOf } from "../../src/sim/body";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const boxTris = (lo: number[], hi: number[]) => { const t: number[] = []; for (let a = 0; a < 3; a++) t.push(...rectFace(a, lo[a], lo, hi, false), ...rectFace(a, hi[a], lo, hi, true)); return t; };

test("elements of different degrees on one grid: a linear field is still exact and x keeps the full layout", () => {
  const lo = [0, 0, 0], hi = [60, 20, 20], inside = (x: number, y: number, z: number) => x >= 0 && x <= 60 && y >= 0 && y <= 20 && z >= 0 && z <= 20;
  const pb = { lo, hi, inside, h: 10, k: 0.05, sinks: [{ tris: rectFace(0, 0, lo, hi, false), temp: 20 }, { tris: rectFace(0, 60, lo, hi, true), temp: 80 }], sources: [] };
  const r0 = solveThermal({ ...pb, p: 2 });
  const nel = r0.grid.elems.length, degrees = Int8Array.from({ length: nel }, (_, e) => 1 + (e % 4));
  const r = solveThermal({ ...pb, p: 4, grid: r0.grid, degrees });
  let dofs = 0;
  for (const d of degrees) dofs += basisSize(d);
  assert.equal(r.dofs, dofs);
  assert.equal(r.x.length, nel * basisSize(4));
  for (const x of [0, 7, 25, 33, 50, 60]) {
    const at = Math.min(x, 60 - 1e-6), t = r.temp(at, 10, 10);
    assert.ok(Math.abs(t - (20 + at)) < 1e-6, `T(${x}) = ${t}`);
  }
  assert.ok(Math.abs(r.flows[1].out + r.flows[0].out) < 1e-9 * Math.abs(r.flows[0].out));
});

test("local passes raise the degree only where the temperatures still move", () => {
  // a long thin fin: the field changes fast near its held base and hardly at all near the tip
  const L = 120, a = 6, lo = [0, 0, 0], hi = [L, a, a], tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let ax = 0; ax < 3; ax++) for (const end of [0, 1]) {
    const t = rectFace(ax, end ? hi[ax] : lo[ax], lo, hi, !!end);
    names.push("xyz"[ax] + end);
    tris.push(...t);
    for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
  }
  const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
  const st = newStudy([], "thermal");
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "x0" }], temp: 100 });
  st.supports.push({ id: "s2", type: "conv", faces: ["x1", "y0", "y1", "z0", "z1"].map(name => ({ name })), h: 2000, ambient: 25 });
  const pos = new Float32Array([2, a / 2, a / 2, L, a / 2, a / 2]), nrm = new Float32Array(6);
  const passes = [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 6, cells: 40, energyTol: -1, pos, nrm, thermal: { k: 0.2, setup: thermalSetup(st, body) } })];
  assert.equal(passes.length, 6);
  assert.deepEqual(passes.map(p => p.p), [2, 3, 4, 5, 6, 6]);
  const nel = passes[0].cells;
  for (const p of passes.slice(3)) {
    assert.ok(p.raised! > 0 && p.raised! < nel, `raised ${p.raised} of ${nel}`);
    // far fewer unknowns than the same degree everywhere
    assert.ok(p.dofs < nel * basisSize(p.p), `${p.dofs} unknowns`);
  }
  // against degree 6 everywhere on the same grid: the local passes come much closer than pass 3 did
  const set = thermalSetup(st, body), inside = insideOf(new MeshBody(body.tris));
  const ref = solveThermal({ lo, hi, inside, h: cellSize(body, 40), p: 6, k: 0.2, sinks: set.sinks, sources: set.sources });
  assert.equal(ref.grid.elems.length, nel);
  const exact = ref.temp(2, a / 2, a / 2), err = (p: (typeof passes)[0]) => Math.abs(p.vm[0] - exact) / (exact - 25);
  assert.ok(err(passes[5]) < 0.3 * err(passes[2]), `local passes ${err(passes[5])} vs ${err(passes[2])}`);
  assert.ok(passes[5].dofs < 0.5 * ref.dofs, `${passes[5].dofs} unknowns for ${ref.dofs}`);
  // heat balance: the base gives what the faces take
  const f = passes[5].thermal!.flows;
  assert.ok(Math.abs(f[0].out + f[1].out) < 1e-3 * f[1].out);
});

test("two bodies of very different conductivity in series: the weighted joint passes the exact heat", () => {
  // copper on a board-like slab, held at both ends: T is linear in each and the flux is ΔT / (L1/k1 + L2/k2) per area
  const A = { lo: [0, 0, 0], hi: [20, 20, 20] }, B = { lo: [20, 0, 0], hi: [40, 20, 20] };
  const k1 = 0.39, k2 = 0.0008, ta = boxTris(A.lo, A.hi), tb = boxTris(B.lo, B.hi);
  const domains = [{ inside: insideOf(new MeshBody(ta)), k: k1, tris: ta }, { inside: insideOf(new MeshBody(tb)), k: k2, tris: tb }];
  const pb = { lo: [0, 0, 0], hi: [40, 20, 20], inside: (x: number, y: number, z: number) => domains.some(d => d.inside(x, y, z)), h: 10, k: k1, domains, sinks: [{ tris: rectFace(0, 0, A.lo, A.hi, false), temp: 100 }, { tris: rectFace(0, 40, B.lo, B.hi, true), temp: 20 }], sources: [] };
  let grid, prev, r!: ReturnType<typeof solveThermal>;
  for (const p of [2, 3, 4]) { r = solveThermal({ ...pb, p, grid, prev }); grid = r.grid; prev = r.x; }
  const q = (80 / (20 / k1 + 20 / k2)) * 400;
  assert.ok(Math.abs(r.flows[1].out - q) < 1e-3 * q, `heat ${r.flows[1].out} W vs ${q} W`);
  assert.equal(r.contacts.length, 1);
  assert.ok(Math.abs(Math.abs(r.contacts[0].heat) - q) < 1e-3 * q, `contact ${r.contacts[0].heat} W`);
  // the joint's temperature: nearly the hot end's, the board slab takes almost all of the drop
  const tj = 100 - (q / 400) * (20 / k1);
  assert.ok(Math.abs(r.temp(20 - 1e-6, 10, 10) - tj) < 1e-3 * 80, `joint ${r.temp(20 - 1e-6, 10, 10)} vs ${tj}`);
});

test("cells of a thermal assembly: no larger than three times its thinnest body", () => {
  const plate = boxTris([0, 0, 0], [140, 110, 3]), board = boxTris([17, 12, 13], [123, 98, 14.6]), part = boxTris([40, 30, 14.6], [55, 45, 17.1]);
  const all = Float64Array.from([...plate, ...board, ...part]);
  const body = { tris: all, face: new Int32Array(all.length / 9), names: [""], lo: [0, 0, 0], hi: [140, 110, 17.1] };
  const h0 = cellSize(body), h = thermalCellSize(body, [plate, board, part]);
  assert.ok(h < 0.75 * h0, `${h} mm for ${h0} mm`);
  assert.ok(h >= cellSize(body, 400) - 1e-9, `${h} mm, at most 400 cells`);
  // thick bodies keep the usual size
  const a = boxTris([0, 0, 0], [40, 40, 20]), b = boxTris([0, 0, 20], [40, 40, 40]), both = Float64Array.from([...a, ...b]);
  const body2 = { tris: both, face: new Int32Array(both.length / 9), names: [""], lo: [0, 0, 0], hi: [40, 40, 40] };
  assert.equal(thermalCellSize(body2, [a, b]), cellSize(body2));
});
