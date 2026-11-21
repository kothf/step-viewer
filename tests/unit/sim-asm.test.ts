// Structural analysis of assemblies (FRS-structural SA3): every component is its own body, joined to the
// others where they touch or come within the gap tolerance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, type RunInput } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
/** Boxes as the components of an assembly: faces named `<component>@x0` … `<component>@z1`. */
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
type Links = NonNullable<RunInput["asm"]>["links"];
function input(m: ReturnType<typeof boxes>, st: ReturnType<typeof newStudy>, pos: number[], nrm: number[], gap = 0.1, links?: Links, passes = 3): RunInput {
  return { body: m.body, mat: steel, regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap, links }, problem: studyProblem(st, m.body), passes, energyTol: 0, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm) };
}

test("a bar in two components with a small gap between them stretches as one bar", () => {
  const L = 100, B = 20, T = 10, F = 1000, J = 40, g = 0.05;
  const m = boxes([{ id: "a", lo: [0, 0, 0], hi: [J, B, T] }, { id: "b", lo: [J + g, 0, 0], hi: [L, B, T] }]);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "sliding", faces: [{ name: "a@x0" }] }, { id: "s2", type: "sliding", faces: [{ name: "a@y0" }, { name: "b@y0" }] }, { id: "s3", type: "sliding", faces: [{ name: "a@z0" }, { name: "b@z0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: [{ v: F }, { v: 0 }, { v: 0 }] });
  const r = [...runStatic(input(m, st, [L, B / 2, T / 2], [1, 0, 0]))].at(-1)!;
  const u = (F * L) / (steel.E * B * T);
  assert.ok(Math.abs(r.u[0] / u - 1) < 0.01, `end ${r.u[0]} vs ${u}`);
  assert.equal(r.contacts!.length, 1);
  assert.ok(Math.abs(r.contacts![0].area / (B * T) - 1) < 0.01, `area ${r.contacts![0].area}`);
  assert.equal(r.contacts![0].type, "bonded");
});

test("AT-SA3-1: two plates overlapping 50 mm with a 0.05 mm gap carry tension like plates that touch", () => {
  const W = 40, T = 5, F = 2000;
  const lap = (g: number) => boxes([{ id: "a", lo: [0, 0, 0], hi: [150, W, T] }, { id: "b", lo: [100, 0, T + g], hi: [250, W, 2 * T + g] }]);
  const run = (g: number) => {
    const m = lap(g), st = newStudy([]);
    st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
    st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: [{ v: F }, { v: 0 }, { v: 0 }] });
    return [...runStatic(input(m, st, [250, W / 2, 1.5 * T + g], [1, 0, 0]))].at(-1)!;
  };
  const tight = run(0), loose = run(0.05);
  assert.ok(Math.abs(loose.contacts![0].area / (50 * W) - 1) < 0.02, `area ${loose.contacts![0].area}`);
  for (const c of [0, 2]) assert.ok(Math.abs(loose.u[c] / tight.u[c] - 1) < 0.03, `u${c} ${loose.u[c]} vs ${tight.u[c]}`);
  assert.ok(Math.abs(loose.energy / tight.energy - 1) < 0.03, `energy ${loose.energy} vs ${tight.energy}`);
  // the joint bends (the load is off the first plate's middle), so the end moves more than plain stretch
  assert.ok(tight.u[0] > (F * 200) / (steel.E * W * T));
});

test("a component that touches nothing and is not held is named", () => {
  const m = boxes([{ id: "a", lo: [0, 0, 0], hi: [40, 20, 10] }, { id: "b", lo: [41, 0, 0], hi: [80, 20, 10] }, { id: "c", lo: [80, 0, 0], hi: [100, 20, 10] }]);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "c@x1" }], comp: [{ v: 100 }, { v: 0 }, { v: 0 }] });
  assert.throws(() => [...runStatic(input(m, st, [0, 0, 0], [1, 0, 0], 0.1, undefined, 1))], /E-SIM-LOOSE: 1,2/);
});

test("AT-SA3-4: a block sliding on a plate passes on only the load across the surface", () => {
  const m = boxes([{ id: "plate", lo: [0, 0, 0], hi: [60, 60, 10] }, { id: "block", lo: [20, 20, 10], hi: [40, 40, 30] }]);
  const links: Links = [{ a: 0, b: 1, type: "sliding" }];
  const base = () => { const st = newStudy([]); st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "plate@z0" }] }); return st; };
  // pressed down, held sideways by two of its own faces
  const st = base();
  st.supports.push({ id: "s2", type: "sliding", faces: [{ name: "block@x0" }, { name: "block@y0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "block@z1" }], comp: [{ v: 0 }, { v: 0 }, { v: -500 }] });
  const r = [...runStatic(input(m, st, [30, 30, 30], [0, 0, 1], 0.1, links, 2))].at(-1)!;
  assert.equal(r.contacts![0].type, "sliding");
  assert.ok(Math.abs(r.reactions[0].force[2] / 500 - 1) < 0.01, `plate reaction ${r.reactions[0].force}`);
  assert.ok(r.u[2] < 0);
  // pushed along the plate with nothing to stop it: it is loose
  const st2 = base();
  st2.loads.push({ id: "l1", type: "force", faces: [{ name: "block@x1" }], comp: [{ v: -100 }, { v: 0 }, { v: 0 }] });
  assert.throws(() => [...runStatic(input(m, st2, [30, 30, 30], [0, 0, 1], 0.1, links, 1))], /E-SIM-LOOSE: 1/);
  // the same block bonded is held by the plate
  const r3 = [...runStatic(input(m, st2, [30, 30, 30], [0, 0, 1], 0.1, undefined, 2))].at(-1)!;
  assert.ok(Math.abs(r3.reactions[0].force[0] / 100 - 1) < 0.01, `bonded reaction ${r3.reactions[0].force}`);
});

test("FR-RES-008: a bonded connection carries the load across: force and moment about its centre", () => {
  // a cantilever in two components joined at x = J: the joint passes on the tip load and its moment
  const L = 100, B = 20, T = 10, F = 300, J = 40;
  const m = boxes([{ id: "a", lo: [0, 0, 0], hi: [J, B, T] }, { id: "b", lo: [J, 0, 0], hi: [L, B, T] }]);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -F }] });
  const r = [...runStatic(input(m, st, [L, B / 2, T / 2], [1, 0, 0]))].at(-1)!;
  const c = r.contacts![0];
  assert.ok(c.force && c.moment && c.at, "force, moment and centre");
  // b pulls on a with the load, so a passes the opposite to b
  assert.ok(Math.abs(c.force![2] / F - 1) < 0.02, `shear ${c.force}`);
  assert.ok(Math.abs(c.force![0]) < 0.02 * F && Math.abs(c.force![1]) < 0.02 * F, `other parts ${c.force}`);
  assert.ok(Math.abs(c.at![0] - J) < 1e-6 && Math.abs(c.at![1] - B / 2) < 0.01 && Math.abs(c.at![2] - T / 2) < 0.01, `centre ${c.at}`);
  // moment of what a does to b about the joint: balances the tip load's (L − J) × (−F z) = +F (L − J) about y
  assert.ok(Math.abs(c.moment![1] / (-F * (L - J)) - 1) < 0.03, `moment ${c.moment}`);
});

test("FR-RES-008: a sliding connection passes on only the force square to it", () => {
  const B = 20, T = 10, F = 400;
  const m = boxes([{ id: "a", lo: [0, 0, 0], hi: [30, B, T] }, { id: "b", lo: [0, 0, T], hi: [30, B, 2 * T] }]);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@z0" }] }, { id: "s2", type: "sliding", faces: [{ name: "b@x0" }] }, { id: "s3", type: "sliding", faces: [{ name: "b@y0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@z1" }], comp: [{ v: 0 }, { v: 0 }, { v: -F }] });
  const r = [...runStatic(input(m, st, [15, B / 2, 2 * T], [0, 0, 1], 0.1, [{ a: 0, b: 1, type: "sliding" }]))].at(-1)!;
  const c = r.contacts![0];
  assert.equal(c.type, "sliding");
  // a holds b up: it passes +F along z
  assert.ok(Math.abs(c.force![2] / F - 1) < 0.02, `normal ${c.force}`);
  assert.ok(Math.abs(c.force![0]) < 1e-6 * F && Math.abs(c.force![1]) < 1e-6 * F, `tangential ${c.force}`);
});
