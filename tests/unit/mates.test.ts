// Mate solver (FR-MATE-003/008, AT-P4-1..3): pure geometry, no kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, mateTypes, mateDefaults, type Geo } from "../../src/asm/solver";
import { IDENTITY, applyPoint, applyDir, translation, rotation, compose } from "../../src/asm/math";
import type { AsmDoc, Mate } from "../../src/asm/types";
import type { PartDoc } from "../../src/model/types";

const stub = { schema: 1, kind: "part", id: "x", name: "x", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [] } as unknown as PartDoc;
const geos: Record<string, Record<string, Geo>> = {
  plate: { top: { k: "plane", p: [0, 0, 5], n: [0, 0, 1] }, side: { k: "plane", p: [0, 0, 0], n: [1, 0, 0] }, hole: { k: "axis", p: [20, 10, 0], d: [0, 0, 1], r: 3 } },
  pin: { shank: { k: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 3 }, under: { k: "plane", p: [0, 0, 10], n: [0, 0, -1] }, flat: { k: "plane", p: [3, 0, 0], n: [1, 0, 0] } },
};
const geo = (part: string, face: string) => geos[part]?.[face] ?? null;
const doc = (mates: Mate[]): AsmDoc => ({
  schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 },
  parts: { plate: { name: "plate", file: "plate.mcadprt", doc: stub }, pin: { name: "pin", file: "pin.mcadprt", doc: stub } },
  components: [
    { id: "p", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true },
    { id: "q", name: "pin<1>", part: "pin", tf: compose(translation([50, -20, 30]), rotation([0, 0, 0], [1, 0, 0], 0.3)) },
  ],
  mates,
});
const conc: Mate = { id: "m1", name: "Concentric1", type: "concentric", a: { comp: "p", face: "hole" }, b: { comp: "q", face: "shank" } };
const coin: Mate = { id: "m2", name: "Coincident1", type: "coincident", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, align: "anti" };

test("AT-P4-1: concentric + coincident leaves the pin one rotation", () => {
  const r = solve({ doc: doc([conc, coin]), geo, size: 100 });
  assert.ok(r.ok && r.moved);
  assert.equal(r.dof.p, 0);
  assert.equal(r.dof.q, 1);
  const t = r.tfs.q;
  const axisP = applyPoint(t, [0, 0, 0]), axisD = applyDir(t, [0, 0, 1]);
  assert.ok(Math.abs(axisD[2] - 1) < 1e-6 && Math.abs(axisP[0] - 20) < 1e-5 && Math.abs(axisP[1] - 10) < 1e-5, JSON.stringify(axisP));
  assert.ok(Math.abs(applyPoint(t, [0, 0, 10])[2] - 5) < 1e-5);
  // A third mate on the flat removes the rotation.
  const par: Mate = { id: "m3", name: "Parallel1", type: "parallel", a: { comp: "p", face: "side" }, b: { comp: "q", face: "flat" } };
  const r2 = solve({ doc: doc([conc, coin, par]), geo, size: 100 });
  assert.ok(r2.ok);
  assert.equal(r2.dof.q, 0);
});

test("axes fitted to a tessellation (off by 1e-5 rad) still solve with flat-face mates (exam bug 28)", () => {
  const tilt = 1.5e-5, saved = geos.pin.shank;
  geos.pin.shank = { k: "axis", p: [0, 0, 0], d: [Math.sin(tilt), 0, Math.cos(tilt)], r: 3 };
  try {
    const r = solve({ doc: doc([conc, coin]), geo, size: 400 });
    assert.ok(r.ok, JSON.stringify(r.bad));
    const at = applyPoint(r.tfs.q, [0, 0, 10]);
    assert.ok(Math.abs(at[0] - 20) < 0.01 && Math.abs(at[1] - 10) < 0.01 && Math.abs(at[2] - 5) < 0.01, String(at));
  } finally { geos.pin.shank = saved; }
});

test("AT-P4-2: moving the hole in the part moves the pin", () => {
  const d = doc([conc, coin]);
  const r = solve({ doc: d, geo, size: 100 });
  d.components[1].tf = r.tfs.q;
  const moved = { ...geos, plate: { ...geos.plate, hole: { k: "axis", p: [30, 5, 0], d: [0, 0, 1], r: 3 } as Geo } };
  const r2 = solve({ doc: d, geo: (p, f) => moved[p]?.[f] ?? null, size: 100 });
  assert.ok(r2.ok && r2.moved);
  const a = applyPoint(r2.tfs.q, [0, 0, 0]);
  assert.ok(Math.abs(a[0] - 30) < 1e-5 && Math.abs(a[1] - 5) < 1e-5);
});

test("AT-P4-3: a conflicting distance mate is refused and nothing moves", () => {
  const d = doc([conc, coin]);
  d.components[1].tf = solve({ doc: d, geo, size: 100 }).tfs.q;
  const before = d.components[1].tf.slice();
  const dist: Mate = { id: "m9", name: "Distance1", type: "distance", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, value: 5 };
  const r = solve({ doc: d, geo, extra: [dist], size: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.bad.includes("m9"));
  assert.deepEqual(r.tfs.q, before);
  assert.equal(r.moved, false);
});

test("distance, angle, lock and quick mate types", () => {
  assert.deepEqual(mateTypes("axis", "axis")[0], "concentric");
  assert.deepEqual(mateTypes("plane", "plane")[0], "coincident");
  const dd = mateDefaults("distance", { k: "plane", p: [0, 0, 5], n: [0, 0, 1] }, { k: "plane", p: [0, 0, 12], n: [0, 0, -1] });
  assert.equal(dd.value, 7);
  const dist: Mate = { id: "d", name: "Distance1", type: "distance", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, value: 7 };
  const r = solve({ doc: doc([conc, dist]), geo, size: 100 });
  assert.ok(r.ok);
  assert.ok(Math.abs(applyPoint(r.tfs.q, [0, 0, 10])[2] - 12) < 1e-5);
  const ang: Mate = { id: "g", name: "Angle1", type: "angle", a: { comp: "p", face: "side" }, b: { comp: "q", face: "flat" }, value: Math.PI / 6 };
  const r2 = solve({ doc: doc([conc, coin, ang]), geo, size: 100 });
  assert.ok(r2.ok, JSON.stringify(r2.bad));
  const f = applyDir(r2.tfs.q, [1, 0, 0]);
  assert.ok(Math.abs(Math.acos(f[0]) - Math.PI / 6) < 1e-5);
  const d = doc([]);
  const lock: Mate = { id: "l", name: "Lock1", type: "lock", a: { comp: "p", face: "" }, b: { comp: "q", face: "" }, rel: translation([1, 2, 3]) };
  d.mates = [lock];
  const r3 = solve({ doc: d, geo, size: 100 });
  assert.ok(r3.ok && r3.dof.q === 0);
  assert.ok(r3.tfs.q.every((v, i) => Math.abs(v - translation([1, 2, 3])[i]) < 1e-6));
});

import { expandPatterns, explodeOffsets, autoExplode } from "../../src/asm/patterns";
import { placeGeo } from "../../src/asm/solver";

test("component patterns: circular instances round the hole axis, linear along a face normal (FR-ASM-022)", () => {
  const d = doc([]);
  d.components[1].tf = translation([20, 0, 5]);
  d.patterns = [{ id: "cp", name: "CircPattern1", kind: "circular", seeds: ["q"], dir: { comp: "p", face: "hole" }, count: 4, spacing: 2 * Math.PI, equal: true }];
  const wg = (r: { comp: string; face: string }) => { const c = d.components.find(x => x.id === r.comp)!; const g = geo(c.part, r.face); return g && placeGeo(g, c.tf); };
  const e = expandPatterns(d, wg);
  assert.equal(e.doc.components.length, 5);
  assert.deepEqual(e.doc.components.slice(2).map(c => c.name), ["pin<2>", "pin<3>", "pin<4>"]);
  // Pin at (20, 0) about the hole axis at (20, 10): 90° steps.
  const at = e.doc.components.slice(2).map(c => applyPoint(c.tf, [0, 0, 0]).map(v => Math.round(v * 1e6) / 1e6));
  assert.deepEqual(at, [[30, 10, 5], [20, 20, 5], [10, 10, 5]]);
  assert.ok(e.doc.components.slice(2).every(c => c.fixed));
  d.patterns = [{ id: "lp", name: "LocalLPattern1", kind: "linear", seeds: ["q"], dir: { comp: "p", face: "side" }, count: 3, spacing: 15 }];
  const l = expandPatterns(d, wg);
  assert.deepEqual(l.doc.components.slice(2).map(c => c.tf[3]), [35, 50]);
  d.patterns[0].dir = null;
  assert.deepEqual(expandPatterns(d, wg).bad, ["lp"]);
});

test("exploded views: steps add up; auto explode moves floating components outward (FR-ASM-023)", () => {
  const off = explodeOffsets({ id: "e", name: "Exploded1", steps: [{ comps: ["a", "b"], dir: [0, 0, 1], dist: 10 }, { comps: ["b"], dir: [1, 0, 0], dist: 5 }] });
  assert.deepEqual(off.get("a"), [0, 0, 10]);
  assert.deepEqual(off.get("b"), [5, 0, 10]);
  const steps = autoExplode([{ id: "a", centre: [0, 0, 0], fixed: true }, { id: "b", centre: [10, 0, 0] }], 40);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], { comps: ["b"], dir: [1, 0, 0], dist: 20 });
});

import { flattenSubs, topOf } from "../../src/asm/patterns";

test("sub-assemblies flatten rigidly, placed by their component (FR-ASM-001/006)", () => {
  const sub = doc([]);
  sub.id = "sub";
  sub.components[1].tf = translation([10, 0, 0]);
  const top = doc([]);
  top.parts.s = { name: "pinplate", file: "pinplate.mcadasm", doc: stub, asm: sub };
  top.components.push({ id: "k", name: "pinplate<1>", part: "s", tf: translation([0, 100, 0]), hidden: true });
  const f = flattenSubs(top);
  assert.deepEqual(f.components.map(c => c.id), ["p", "q", "k/p", "k/q"]);
  assert.deepEqual(f.components.map(c => c.part), ["plate", "pin", "s/plate", "s/pin"]);
  assert.ok(f.parts["s/pin"] && !f.parts.s);
  assert.deepEqual(applyPoint(f.components[3].tf, [0, 0, 0]), [10, 100, 0]);
  assert.ok(f.components[3].fixed && f.components[3].hidden);
  assert.equal(topOf("k/q"), "k");
});

test("advanced mates: limit distance, limit angle, symmetric, width (FR-MATE-004)", () => {
  // Limit distance 2..8 between the plate top and the pin's underside: a pin 20 mm up comes down to 8 and keeps one more freedom than a distance mate.
  const lim: Mate = { id: "l", name: "LimitDistance1", type: "limitdist", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, align: "anti", min: 2, max: 8 };
  const d = doc([conc, lim]);
  d.components[1].tf = translation([20, 10, 20]);
  const r = solve({ doc: d, geo, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  const z = applyPoint(r.tfs.q, [0, 0, 10])[2] - 5;
  assert.ok(Math.abs(z - 8) < 1e-4, String(z));
  assert.equal(r.dof.q, 2);
  // Inside the range nothing moves.
  d.components[1].tf = translation([20, 10, 0]);
  assert.equal(solve({ doc: d, geo, size: 100 }).moved, false);
  // Limit angle 0..20° between the plate side and the pin flat.
  const la: Mate = { id: "a", name: "LimitAngle1", type: "limitangle", a: { comp: "p", face: "side" }, b: { comp: "q", face: "flat" }, min: 0, max: Math.PI / 9 };
  const d2 = doc([conc, coin, la]);
  d2.components[1].tf = compose(translation([20, 10, -5]), rotation([0, 0, 0], [0, 0, 1], 1));
  const r2 = solve({ doc: d2, geo, size: 100 });
  assert.ok(r2.ok, JSON.stringify(r2.bad));
  const f = applyDir(r2.tfs.q, [1, 0, 0]);
  assert.ok(Math.abs(Math.acos(f[0]) - Math.PI / 9) < 1e-4, String(Math.acos(f[0])));
  // Symmetric: two blocks' outer faces mirrored in the plate's side plane (x = 0).
  const blk = { lft: { k: "plane", p: [-5, 0, 0], n: [-1, 0, 0] }, rgt: { k: "plane", p: [5, 0, 0], n: [1, 0, 0] }, bot: { k: "plane", p: [0, 0, 0], n: [0, 0, -1] } } as Record<string, Geo>;
  const g3 = (p: string, f: string) => (p === "blk" ? blk[f] : geo(p, f)) ?? null;
  const d3 = doc([]);
  d3.parts.blk = { name: "blk", file: "blk.mcadprt", doc: stub };
  d3.components = [d3.components[0], { id: "u", name: "blk<1>", part: "blk", tf: translation([-30, 0, 5]), fixed: true }, { id: "v", name: "blk<2>", part: "blk", tf: translation([12, 0, 5]) }];
  d3.mates = [{ id: "s", name: "Symmetric1", type: "symmetric", a: { comp: "u", face: "lft" }, b: { comp: "v", face: "rgt" }, c: { comp: "p", face: "side" } }];
  const r3 = solve({ doc: d3, geo: g3, size: 100 });
  assert.ok(r3.ok, JSON.stringify(r3.bad));
  assert.ok(Math.abs(applyPoint(r3.tfs.v, [5, 0, 0])[0] - 35) < 1e-4, JSON.stringify(r3.tfs.v));
  // Width: the block (tab faces lft/rgt) centred between the plate side (x = 0) and a wall at x = 40 on a fixed second block.
  const d4 = doc([]);
  d4.parts.blk = { name: "blk", file: "blk.mcadprt", doc: stub };
  d4.components = [d4.components[0], { id: "w", name: "blk<1>", part: "blk", tf: translation([45, 0, 0]), fixed: true }, { id: "v", name: "blk<2>", part: "blk", tf: translation([7, 3, 5]) }];
  d4.mates = [{ id: "w1", name: "Width1", type: "width", a: { comp: "p", face: "side" }, c: { comp: "w", face: "lft" }, b: { comp: "v", face: "lft" }, d: { comp: "v", face: "rgt" } }];
  const r4 = solve({ doc: d4, geo: g3, size: 100 });
  assert.ok(r4.ok, JSON.stringify(r4.bad));
  assert.ok(Math.abs(applyPoint(r4.tfs.v, [0, 0, 0])[0] - 20) < 1e-4, JSON.stringify(r4.tfs.v));
});

test("display states keep visibility, colour and transparency per component (FR-ASM-025)", async () => {
  const { addState, activateState, deleteState } = await import("../../src/asm/states");
  const d = doc([]);
  d.components[1].color = [1, 0, 0];
  addState(d, "Inside", "ds_in");
  assert.deepEqual(d.states!.map(s => s.name), ["Default", "Inside"]);
  d.components[0].hidden = true;
  d.components[1].opacity = 0.4;
  activateState(d, "ds_default");
  assert.equal(d.components[0].hidden, undefined);
  assert.equal(d.components[1].opacity, undefined);
  assert.deepEqual(d.components[1].color, [1, 0, 0]);
  activateState(d, "ds_in");
  assert.equal(d.components[0].hidden, true);
  assert.equal(d.components[1].opacity, 0.4);
  assert.ok(deleteState(d, "ds_in"));
  assert.equal(d.activeState, "ds_default");
  assert.equal(d.components[0].hidden, undefined);
  assert.equal(deleteState(d, "ds_default"), false);
});

test("FR-ASM-006: a flexible sub-assembly's own mates solve in the parent, and parent mates reach its parts", async () => {
  const { solveView, applySolved, flattenSubs } = await import("../../src/asm/patterns");
  // Sub-assembly: a fixed plate and a pin concentric in its hole (free to slide and turn).
  const sub: AsmDoc = { ...doc([conc]), id: "s", name: "Sub" };
  sub.components[1].tf = translation([20, 10, 40]);
  // Parent: a fixed plate, and the sub placed 100 mm along X; the parent pushes the sub's pin onto its own plate top.
  const parent: AsmDoc = {
    schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 },
    parts: { plate: { name: "plate", file: "plate.mcadprt", doc: stub }, sub: { name: "sub", file: "sub.mcadasm", doc: stub, asm: sub } },
    components: [
      { id: "base", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true },
      { id: "S", name: "Sub<1>", part: "sub", tf: translation([100, 0, 0]), fixed: true },
    ],
    mates: [{ id: "pm", name: "Coincident1", type: "coincident", a: { comp: "base", face: "top" }, b: { comp: "S/q", face: "under" }, align: "anti" }],
  };
  const g = (part: string, face: string) => geos[part.split("/").at(-1)!]?.[face] ?? null;
  // Rigid: the parent mate cannot reach into the sub-assembly.
  assert.ok(solve({ doc: solveView(parent), geo: g, size: 100 }).missing.includes("pm"));
  parent.components[1].flexible = true;
  const view = solveView(parent);
  assert.ok(view.components.some(c => c.id === "S/q") && view.mates!.some(m => m.id === "S/m1"));
  const r = solve({ doc: view, geo: g, size: 100 });
  assert.ok(r.ok, JSON.stringify(r.bad));
  applySolved(parent, r.tfs);
  // The pin stays in the sub's hole (x = 100 + 20, y = 10) and now sits on the parent plate's top (z = 5 + 0 under the head at 10).
  const flat = flattenSubs(parent);
  const pin = flat.components.find(c => c.id === "S/q")!;
  const o = applyPoint(pin.tf, [0, 0, 0]);
  assert.ok(Math.abs(o[0] - 120) < 1e-5 && Math.abs(o[1] - 10) < 1e-5 && Math.abs(applyPoint(pin.tf, [0, 0, 10])[2] - 5) < 1e-5, JSON.stringify(o));
  // The sub's plate did not move, and making it rigid again puts the pin back.
  assert.ok(Math.abs(applyPoint(flat.components.find(c => c.id === "S/p")!.tf, [0, 0, 0])[0] - 100) < 1e-9);
  delete parent.components[1].flexible;
  assert.ok(Math.abs(applyPoint(flattenSubs(parent).components.find(c => c.id === "S/q")!.tf, [0, 0, 0])[2] - 40) < 1e-9);
});

test("FR-ASM-003 / FR-IO-011: linked parts are found by path or by name, read again when changed, marked when missing", async () => {
  const { planLinks, folderPath, hashBytes } = await import("../../src/asm/links");
  const e = { name: "x", file: "x", doc: stub };
  const parts: AsmDoc["parts"] = {
    a: { ...e, link: { path: "parts/a.mcadprt", hash: "1" } },
    b: { ...e, link: { path: "b.mcadprt", hash: "2" } },
    c: { ...e, link: { path: "c.step", hash: "3" } },
    d: { ...e, link: { path: "gone.mcadprt", hash: "4" } },
    emb: e,
  };
  const plan = planLinks(parts, [{ path: "parts/a.mcadprt", hash: "1" }, { path: "b.mcadprt", hash: "9" }, { path: "old/c.step", hash: "3" }]);
  assert.deepEqual(plan.same, ["a"]);
  assert.deepEqual([...plan.update.entries()], [["b", { path: "b.mcadprt", hash: "9" }], ["c", { path: "old/c.step", hash: "3" }]]);
  assert.deepEqual(plan.missing, ["d"]);
  assert.equal(folderPath("Project/parts/a.mcadprt"), "parts/a.mcadprt");
  assert.equal(folderPath("a.mcadprt"), "a.mcadprt");
  assert.equal(await hashBytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("FR-MATE-005: gear, screw, hinge and slot mates", () => {
  const g2: Record<string, Record<string, Geo>> = { ...geos, plate: { ...geos.plate, hole2: { k: "axis", p: [60, 10, 0], d: [0, 0, 1], r: 6 }, slotA: { k: "plane", p: [0, 30, 0], n: [0, -1, 0] }, slotB: { k: "plane", p: [0, 40, 0], n: [0, 1, 0] } } };
  const gg = (p: string, f: string) => g2[p]?.[f] ?? null;
  const base = (): AsmDoc => ({
    schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 },
    parts: { plate: { name: "plate", file: "p", doc: stub }, pin: { name: "pin", file: "q", doc: stub } },
    components: [
      { id: "p", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true },
      { id: "q", name: "pin<1>", part: "pin", tf: translation([20, 10, -5]) },
      { id: "r", name: "pin<2>", part: "pin", tf: translation([60, 10, -5]) },
    ],
    mates: [],
  });
  const M = (id: string, type: Mate["type"], a: [string, string], b: [string, string], more: Partial<Mate> = {}): Mate => ({ id, name: id, type, a: { comp: a[0], face: a[1] }, b: { comp: b[0], face: b[1] }, ...more });
  const turn = (t: number[]) => Math.atan2(applyDir(t, [1, 0, 0])[1], applyDir(t, [1, 0, 0])[0]);
  // Gear: both pins turn in their holes; turning q by 0.3 turns r by −0.6 (ratio 2).
  const d = base();
  d.mates = [M("c1", "concentric", ["p", "hole"], ["q", "shank"]), M("k1", "coincident", ["p", "top"], ["q", "under"], { align: "anti" }),
    M("c2", "concentric", ["p", "hole2"], ["r", "shank"]), M("k2", "coincident", ["p", "top"], ["r", "under"], { align: "anti" }),
    M("g", "gear", ["q", "shank"], ["r", "shank"], { ratio: 2, t0: [d.components[1].tf, d.components[2].tf] })];
  const s0 = solve({ doc: d, geo: gg, size: 100 });
  assert.ok(s0.ok, JSON.stringify(s0.bad));
  for (const c of d.components) c.tf = s0.tfs[c.id];
  d.mates[4].t0 = [d.components[1].tf, d.components[2].tf];
  const q1 = compose(rotation([20, 10, 0], [0, 0, 1], 0.3), d.components[1].tf);
  // q is held where it was dragged (as a drag does: fixed for the solve).
  const dd = { ...d, components: d.components.map(c => (c.id === "q" ? { ...c, tf: q1, fixed: true } : c)) };
  const s1 = solve({ doc: dd, geo: gg, size: 100 });
  assert.ok(s1.ok, JSON.stringify(s1.bad));
  assert.ok(Math.abs(turn(s1.tfs.r) - turn(d.components[2].tf) + 0.6) < 1e-5, String(turn(s1.tfs.r)));
  assert.deepEqual([s0.dof.q, s0.dof.r], [1, 1], JSON.stringify(s0.dof));
  // Screw: q concentric in the hole, 2 mm per turn; a quarter turn moves it 0.5 mm along the axis.
  const e = base();
  e.components = e.components.slice(0, 2);
  e.mates = [M("s", "screw", ["p", "hole"], ["q", "shank"], { ratio: 2, t0: [IDENTITY, translation([20, 10, -5])] })];
  const q2 = compose(rotation([20, 10, 0], [0, 0, 1], Math.PI / 2), translation([20, 10, -5]));
  const s2 = solve({ doc: { ...e, components: [e.components[0], { ...e.components[1], tf: q2 }] }, geo: gg, size: 100 });
  assert.ok(s2.ok, JSON.stringify(s2.bad));
  const z = applyPoint(s2.tfs.q, [0, 0, 0])[2];
  // Wherever it settled, travel = 2 mm × turns, and it moved (the turn was not simply undone).
  const tq = turn(s2.tfs.q);
  assert.ok(Math.abs((z + 5) - (2 * tq) / (2 * Math.PI)) < 1e-5 && Math.abs(z + 5) > 0.05, JSON.stringify({ z, tq }));
  // Hinge: concentric + coincident in one mate; slot: the pin centred between the slot faces.
  const h = base();
  h.components = h.components.slice(0, 2);
  h.mates = [{ ...M("h", "hinge", ["p", "hole"], ["q", "shank"]), c: { comp: "p", face: "top" }, d: { comp: "q", face: "under" } }];
  const s3 = solve({ doc: h, geo: gg, size: 100 });
  assert.ok(s3.ok && s3.dof.q === 1, JSON.stringify(s3));
  assert.ok(Math.abs(applyPoint(s3.tfs.q, [0, 0, 10])[2] - 5) < 1e-5);
  h.mates = [{ ...M("sl", "slot", ["p", "slotA"], ["q", "shank"]), c: { comp: "p", face: "slotB" } }];
  const s4 = solve({ doc: h, geo: gg, size: 100 });
  assert.ok(s4.ok, JSON.stringify(s4.bad));
  assert.ok(Math.abs(applyPoint(s4.tfs.q, [0, 0, 0])[1] - 35) < 1e-5, String(applyPoint(s4.tfs.q, [0, 0, 0])));
});
