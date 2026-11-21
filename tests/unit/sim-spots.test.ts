// Structural analysis of assemblies: spot welds (FR-CON-024) and adhesive layers (FR-CON-025).
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, type RunInput } from "../../src/sim/run";
import { newStudy, glueStiffness } from "../../src/sim/types";
import { spotPoints } from "../../src/sim/run";

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



// a small plate lying on a larger one, pushed along X; the larger one is held at its end
const F = 1000;
const model = () => boxes([{ id: "a", lo: [0, 0, 0], hi: [60, 40, 10] }, { id: "b", lo: [10, 10, 10], hi: [50, 30, 20] }]);
type Link = NonNullable<NonNullable<RunInput["asm"]>["links"]>[number];
function solve(link: Link, spots?: number[], d = 6) {
  const m = model(), st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: [F, 0, 0].map(v => ({ v })) as never });
  const inp: RunInput = {
    body: m.body, mat: steel, regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap: 0.1, links: [link] },
    ...(spots ? { welds: [{ lines: new Float64Array(0), spots: Float64Array.from(spots), d }] } : {}),
    problem: studyProblem(st, m.body), passes: 2, energyTol: 0, pos: Float32Array.from([50, 20, 15]), nrm: Float32Array.from([1, 0, 0]),
  };
  return [...runStatic(inp)].at(-1)!;
}
const none: Link = { a: 0, b: 1, type: "none" };

test("spot points: the direction goes into the body at the picked face", () => {
  const m = model();
  const p = spotPoints(m.body, [{ faces: ["b@z1"], at: [20, 20, 20] }, { faces: ["a@x1"], at: [60, 20, 5] }])!;
  assert.deepEqual([...p].map(v => v + 0), [20, 20, 20, 0, 0, -1, 60, 20, 5, -1, 0, 0]);
  assert.equal(spotPoints(m.body, [{ faces: ["gone"], at: [0, 0, 0] }]), null);
});

test("two spot welds through the upper plate carry the whole push", () => {
  const r = solve(none, [20, 20, 20, 0, 0, -1, 40, 20, 20, 0, 0, -1]);
  const w = r.welds![0];
  assert.equal(w.spots, 2);
  assert.ok(Math.abs(w.force[0] / F - 1) < 0.01, `force ${w.force}`);
  assert.ok(Math.abs(w.length / (2 * Math.PI * 9) - 1) < 1e-6, `area ${w.length}`);
  assert.ok(w.peak >= w.mean && w.mean > 0.45 * F && w.peak < 0.75 * F, `per spot ${w.mean} ${w.peak}`);
  assert.ok(r.maxU > 0 && r.maxU < 0.05, `u ${r.maxU}`);
});

test("a spot with no body behind it is refused; without spots the plate is loose", () => {
  assert.throws(() => solve(none, [5, 5, 10, 0, 0, -1]), /E-SIM-WELD: 0/);
  assert.throws(() => solve(none), /E-SIM-LOOSE/);
});

test("an adhesive layer: the plate shifts by the force over the layer's shear stiffness", () => {
  const [kn, kt] = glueStiffness({ t: 1, E: 10 });
  assert.ok(Math.abs(kn - 10) < 1e-12 && Math.abs(kt - 10 / 2.8) < 1e-12);
  const r = solve({ a: 0, b: 1, type: "adhesive", kn, kt });
  const c = r.contacts![0];
  assert.equal(c.type, "adhesive");
  assert.ok(Math.abs(c.area / 800 - 1) < 0.01, `area ${c.area}`);
  // the lower plate holds the upper one back
  assert.ok(Math.abs(c.force![0] / -F - 1) < 0.01, `force ${c.force}`);
  const shift = F / (kt * 800);
  assert.ok(r.maxU > shift && r.maxU < 1.35 * shift, `u ${r.maxU} against ${shift}`);
  // a stiffer layer moves less, in proportion
  const [kn2, kt2] = glueStiffness({ t: 0.5, E: 10 });
  const r2 = solve({ a: 0, b: 1, type: "adhesive", kn: kn2, kt: kt2 });
  assert.ok(Math.abs(r2.maxU / r.maxU - 0.5) < 0.03, `ratio ${r2.maxU / r.maxU}`);
  assert.throws(() => solve({ a: 0, b: 1, type: "adhesive", kn: 0, kt: 1 }), /E-SIM-ADHESIVE/);
});
