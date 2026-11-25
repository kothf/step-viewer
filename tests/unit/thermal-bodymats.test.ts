// Board studies with what the bodies bring themselves: a material's own emissivity, heat made only in named
// bodies (a die), a junction read off them, and the package manifest's materials (FRS-thermal FR-TBRD-011/021).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newStudy } from "../../src/sim/types";
import { mergeFlows, runThermal, studyProblem, thermalSetup } from "../../src/sim/run";
import { readManifest, readSources, type ThermalManifest, type ThermalPart } from "../../src/thermal/package";
import { boardPlan, partTemps } from "../../src/thermal/study";
import type { PartMatch } from "../../src/thermal/match";
import { validMaterial } from "../../src/tools/materials";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
/** A box whose faces all carry the component's name, as the solids of one component do. */
function box(l: number[], h: number[], comp: string, tag = "") {
  const t: number[] = [], f: number[] = [], n: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
    n.push(`${comp}@${tag}${"xyz"[a]}${end}`);
    t.push(...q);
    for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
  }
  return { tris: t, face: f, names: n };
}
function join(parts: ReturnType<typeof box>[], lo: number[], hi: number[]) {
  const tris: number[] = [], face: number[] = [], names: string[] = [];
  for (const p of parts) { face.push(...p.face.map(i => i + names.length)); names.push(...p.names); tris.push(...p.tris); }
  return { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
}

// two bars end to end: c1 (0..60) and c2 (60..100), 20 × 20
const A1 = box([0, 0, 0], [60, 20, 20], "c1"), A2 = box([60, 0, 0], [100, 20, 20], "c2");
const two = join([A1, A2], [0, 0, 0], [100, 20, 20]);
const pos = new Float32Array([0, 10, 10, 100, 10, 10]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0]);
const mat = { name: "m", E: 0, nu: 0, rho: 0 };

test("radiation from all open surfaces: a body with its own emissivity radiates by it, the rest by the item's", () => {
  const st = newStudy([], "thermal");
  st.settings.ambient = 25;
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "c1@x0" }], value: { v: 2 } });
  st.supports.push({ id: "s1", type: "rad", faces: [], all: true, emis: 0.9 });
  // nothing of their own: one sink, as before
  const plain = thermalSetup(st, two, ["c1", "c2"], { emis: [undefined, null] });
  assert.equal(plain.sinks.length, 1);
  assert.equal(plain.sinkRow, undefined);
  // the same emissivity as the item's is no split either
  assert.equal(thermalSetup(st, two, ["c1", "c2"], { emis: [0.9, 0.9] }).sinks.length, 1);
  // polished second bar: two sinks, one row
  const set = thermalSetup(st, two, ["c1", "c2"], { emis: [undefined, 0.1] });
  assert.deepEqual(set.sinks.map(s => s.emissivity), [0.9, 0.1]);
  assert.deepEqual(set.sinkIds, ["s1"]);
  assert.deepEqual(set.sinkRow, [0, 0]);
  assert.equal(set.sinks[0].tris.length, A1.tris.length);
  assert.equal(set.sinks[1].tris.length, A2.tris.length);
  assert.ok(set.sinks.every(s => s.free));
  // out of range values are not used
  assert.equal(thermalSetup(st, two, ["c1", "c2"], { emis: [0, 1.5] }).sinks.length, 1);
  const regions = [{ tris: Float64Array.from(A1.tris), mat }, { tris: Float64Array.from(A2.tris), mat }];
  const solve = (s: ReturnType<typeof thermalSetup>) => [...runThermal({ body: two, mat, problem: studyProblem(st, two), passes: 2, energyTol: 0, pos, nrm, regions, thermal: { k: 0.2, setup: s, ks: [0.2, 0.2], gap: 0.1 } })].at(-1)!;
  const a = solve(plain), b = solve(set);
  // one row of flows for the one study item, all the heat leaves through it
  assert.equal(b.thermal!.flows.length, 1);
  assert.ok(Math.abs(b.thermal!.flows[0].out - 2) < 0.02, `out ${b.thermal!.flows[0].out}`);
  assert.ok(Math.abs(b.thermal!.flows[0].area - a.thermal!.flows[0].area) < 1e-6 * a.thermal!.flows[0].area);
  // less of the surface radiates well: the model runs hotter
  assert.ok(b.thermal!.max > a.thermal!.max + 1, `${b.thermal!.max} against ${a.thermal!.max}`);
});

test("solids of one component radiate each by its own material", () => {
  // one component of two solids: a body and a tab beside it
  const S1 = box([0, 0, 0], [60, 20, 20], "u1", "a"), S2 = box([60, 0, 0], [100, 20, 20], "u1", "b");
  const b = join([S1, S2], [0, 0, 0], [100, 20, 20]);
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], parts: [{ id: 1, name: "U1", comps: ["u1"], p: 1, bodies: [" tab "] }] });
  st.supports.push({ id: "s1", type: "rad", faces: [], all: true, emis: 0.9 });
  const set = thermalSetup(st, b, ["u1#0", "u1#1"], { emis: [0.8, 0.05], names: [["Body", "b1"], ["Tab", "b2"]], tris: [S1.tris, S2.tris] });
  assert.deepEqual(set.sinks.map(s => [s.emissivity, s.tris.length]), [[0.8, S1.tris.length], [0.05, S2.tris.length]]);
  // the heat is made in the solid named, whatever its case
  assert.deepEqual(set.sources, [{ power: 1, doms: [1], id: "l1" }]);
  // a name no body has: in all of them, as without names
  st.loads[0].parts![0].bodies = ["Die"];
  assert.deepEqual(thermalSetup(st, b, ["u1#0", "u1#1"], { names: [["Body"], ["Tab"]] }).sources[0].doms, [0, 1]);
  // without the solids' triangles the component's first emissivity serves all of it
  const rough = thermalSetup(st, b, ["u1#0", "u1#1"], { emis: [0.8, 0.05] });
  assert.deepEqual(rough.sinks.map(s => s.emissivity), [0.8]);
});

test("a package part's own heat goes only into its heat components", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], parts: [{ id: 1, name: "Q1", comps: ["c1", "c2"], p: 3, hot: ["c2"] }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  assert.deepEqual(thermalSetup(st, two, ["c1", "c2"]).sources, [{ power: 3, doms: [1], id: "l1" }]);
  // a heat component that is not one of the part's is ignored
  st.loads[0].parts![0].hot = ["zz"];
  assert.deepEqual(thermalSetup(st, two, ["c1", "c2"]).sources[0].doms, [0, 1]);
});

test("the flows of sinks of one row add up", () => {
  const f = mergeFlows([
    { out: 1, area: 10, mean: 50, doms: Float64Array.from([1, 0]) }, { out: 3, area: 30, mean: 70, doms: Float64Array.from([0, 3]) }, { out: 5, area: 4, mean: 20 },
  ] as never, [0, 0, 1]);
  assert.equal(f.length, 2);
  assert.equal(f[0].out, 4); assert.equal(f[0].area, 40); assert.equal(f[0].mean, 65);
  assert.deepEqual(Array.from(f[0].doms as unknown as Float64Array), [1, 3]);
  assert.equal(f[1].out, 5);
  const same = [{ out: 1, area: 1, mean: 1 }] as never;
  assert.equal(mergeFlows(same), same);
});

test("a junction part with heat bodies reports their hottest point, and ignores Rjc", () => {
  const max: Record<string, number> = { die: 121, tab: 80, lead: 60 };
  const [r] = partTemps([{ name: "Q1", p: 4, junction: true, rjc: 5, comps: ["die", "tab", "lead"], hot: ["die"], limit: 150 }], c => max[c]);
  assert.deepEqual([r.t, r.body, r.kind, r.die, r.over], [121, 121, "junction", true, false]);
  // named bodies inside one component: the caller gives their hottest point
  const [n] = partTemps([{ name: "Q2", p: 4, junction: true, rjc: 5, comps: ["tab"], die: 95 }], c => max[c]);
  assert.deepEqual([n.t, n.body, n.die], [95, 80, true]);
  // not a junction part: the hottest of all its bodies, as ever
  const [p] = partTemps([{ name: "T1", p: 4, comps: ["die", "tab"], hot: ["tab"] }], c => max[c]);
  assert.deepEqual([p.t, p.kind, p.die], [121, "body", undefined]);
});

test("the package manifest: materials, body materials, heat bodies and the board's emissivity", () => {
  const man = readManifest(JSON.stringify({
    format: "tubecad-thermal", version: 1, units: { length: "mm", temperature: "C" },
    board: { layers: 2, emissivity: 0.9 },
    materials: { si: { name: "Silicon", k_WmK: 148, cp_JkgK: 700, density_kgm3: 2330, emissivity: 0.7 }, bad: { name: "No k" }, cu: { k_WmK: 390, emissivity: 3 } },
    parts: [{ part_id: 1, designator: "Q1", step_bodies: ["Q1 die", "Q1 tab", "Q1 case"], p_total_W: 4, t_kind: "junction", rjc_KW: 2,
      heat_bodies: ["Q1 die"], material: "Nylon PA66-GF30", body_materials: { "Q1 die": "si", "Q1 tab": "cu" } }],
  }));
  assert.deepEqual(man.materials, { si: { name: "Silicon", k: 148, cp: 700, density: 2330, emis: 0.7 }, cu: { name: "cu", k: 390 } });
  assert.equal(man.board?.emis, 0.9);
  const q = man.parts[0];
  assert.deepEqual([q.heat, q.mat, q.mats], [["Q1 die"], "Nylon PA66-GF30", { "Q1 die": "si", "Q1 tab": "cu" }]);
  const body = (name: string, b: number[]) => ({ name, box: b as [number, number, number, number, number, number] });
  const bodies = [body("", [0, 0, 0, 100, 80, 1.6]), body("q1 DIE", [10, 10, 2, 14, 14, 3]), body("Q1 tab", [8, 8, 1.6, 20, 16, 2]), body("Q1 case", [8, 8, 2, 20, 16, 6])];
  const match = { bodies: new Map([[1, [1, 2, 3]]]), by: new Map(), missing: [], changed: [], off: 0, shift: [0, 0, 0] } as PartMatch;
  const plan = boardPlan(man as ThermalManifest, match, bodies);
  assert.equal(plan.boardEmis, 0.9);
  assert.equal(plan.stack?.layers, 2);
  assert.ok(!("emis" in (plan.stack ?? {})));
  assert.deepEqual(plan.given, [null, man.materials!.si, man.materials!.cu, "Nylon PA66-GF30"]);
  assert.deepEqual(plan.heat[0].hot, [1]);
  assert.ok(plan.heat[0].junction);
  // every body named as a heat body = no choice made
  const all = boardPlan({ ...man, parts: [{ ...q, heat: ["Q1 die", "Q1 tab", "Q1 case"] } as ThermalPart] } as ThermalManifest, match, bodies);
  assert.equal(all.heat[0].hot, undefined);
});

test("the heat-source CSV may name heat bodies and a material", () => {
  const rows = readSources("part_id,designator,step_bodies,p_total_W,heat_bodies,material\n1,Q1,Q1 die;Q1 tab,3,Q1 die,si\n2,R1,R1,1,,\n");
  assert.deepEqual([rows[0].heat, rows[0].mat], [["Q1 die"], "si"]);
  assert.equal(rows[1].heat, undefined);
});

test("a material of one's own may carry a surface emissivity between 0 and 1", () => {
  const ok = validMaterial({ name: "Anodised", category: "Other", density: 2.7, k: 200, emis: 0.85 });
  assert.equal(ok?.emis, 0.85);
  assert.equal(validMaterial({ name: "Shiny", category: "Other", density: 2.7, emis: 1.4 })?.emis, undefined);
});
