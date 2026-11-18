// Mate solver (FR-MATE-003/008, AT-P4-1..3): pure geometry, no kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("free counts a linkage once; Lock rotation on Concentric takes the turn (exam #58, #59)", () => {
  const r = solve({ doc: doc([conc, coin]), geo, size: 100 });
  assert.equal(r.free, 1);
  // Unmated floating components count 6 each.
  assert.equal(solve({ doc: doc([]), geo, size: 100 }).free, 6);
  // The pin already concentric and seated (the solved pose), then the turn locked from there.
  const d = doc([conc, coin]);
  d.components[1].tf = r.tfs.q;
  const locked: Mate = { ...conc, lockRot: true, t0: [IDENTITY, r.tfs.q] };
  const r2 = solve({ doc: { ...d, mates: [locked, coin] }, geo, size: 100 });
  assert.ok(r2.ok);
  assert.equal(r2.dof.q, 0);
  assert.equal(r2.free, 0);
  // Started turned 0.4 rad about the axis, the pin turns back to where the mate was made.
  d.components[1].tf = compose(rotation([20, 10, 0], [0, 0, 1], 0.4), r.tfs.q);
  const r3 = solve({ doc: { ...d, mates: [locked, coin] }, geo, size: 100 });
  assert.ok(r3.ok);
  const x = applyDir(r3.tfs.q, [1, 0, 0]), x0 = applyDir(r.tfs.q, [1, 0, 0]);
  assert.ok(Math.hypot(x[0] - x0[0], x[1] - x0[1], x[2] - x0[2]) < 1e-5, String(x));
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

test("a 50-link hinge chain solves and counts its freedom in well under a second each (exam #62)", () => {
  const N = 50;
  geos.link = { a: { k: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 3 }, b: { k: "axis", p: [30, 0, 0], d: [0, 0, 1], r: 3 }, top: { k: "plane", p: [0, 0, 5], n: [0, 0, 1] }, under: { k: "plane", p: [0, 0, 0], n: [0, 0, -1] } };
  try {
    const comps = Array.from({ length: N + 1 }, (_, k) => ({ id: `l${k}`, name: `link<${k}>`, part: "link", fixed: k === 0,
      tf: k ? compose(translation([30 * k + Math.sin(k), Math.cos(k), 5 * k + 0.3 * Math.sin(2 * k)]), rotation([0, 0, 0], [0, 0, 1], 0.2 * Math.sin(k))) : IDENTITY }));
    const mates: Mate[] = [];
    for (let k = 1; k <= N; k++) {
      mates.push({ id: `c${k}`, name: `Concentric${k}`, type: "concentric", a: { comp: `l${k - 1}`, face: "b" }, b: { comp: `l${k}`, face: "a" } });
      mates.push({ id: `p${k}`, name: `Coincident${k}`, type: "coincident", a: { comp: `l${k - 1}`, face: "top" }, b: { comp: `l${k}`, face: "under" }, align: "anti" });
    }
    const d: AsmDoc = { ...doc([]), parts: { link: { name: "link", file: "link.mcadprt", doc: stub } }, components: comps, mates };
    let t0 = performance.now();
    const r = solve({ doc: d, geo, size: 30 * N });
    const full = performance.now() - t0;
    assert.ok(r.ok, JSON.stringify(r.bad));
    assert.equal(r.free, N);
    assert.equal(r.dof.l1, 1);
    assert.equal(r.dof[`l${N}`], 3);
    // Each link's pin sits on the previous link's hole, one layer up.
    for (let k = 1; k <= N; k++) {
      const p = applyPoint(r.tfs[`l${k}`], [0, 0, 0]), q = applyPoint(r.tfs[`l${k - 1}`], [30, 0, 5]);
      assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4, `${k}: ${p} vs ${q}`);
    }
    // A motion frame from the solved pose with one joint turned skips the freedom count.
    d.components = comps.map(c => ({ ...c, tf: r.tfs[c.id] }));
    d.components[1].tf = compose(rotation([0, 0, 0], [0, 0, 1], 0.05), r.tfs.l1);
    t0 = performance.now();
    const f = solve({ doc: d, geo, size: 30 * N, dof: false });
    const frame = performance.now() - t0;
    assert.ok(f.ok);
    assert.ok(full < 4000 && frame < 1500, `solve ${full.toFixed(0)} ms, frame ${frame.toFixed(0)} ms`);
  } finally { delete geos.link; }
});

test("an angle mate made with a turning direction is signed; a plane distance keeps its alignment (exam #64, #72)", () => {
  // The pin on the hole, seated, turned about Z so its flat makes ±30° with the plate's side face.
  const base = solve({ doc: doc([conc, coin]), geo, size: 100 });
  const d = doc([conc, coin]);
  d.components[1].tf = compose(rotation([20, 10, 0], [0, 0, 1], 0.1), base.tfs.q);
  const ang = (v: number): Mate => ({ id: "m4", name: "Angle1", type: "angle", a: { comp: "p", face: "side" }, b: { comp: "q", face: "flat" }, value: (v * Math.PI) / 180, about: [0, 0, 1] });
  for (const v of [30, -30]) {
    const r = solve({ doc: { ...d, mates: [conc, coin, ang(v)] }, geo, size: 100 });
    assert.ok(r.ok, `${v}: ${JSON.stringify(r.bad)}`);
    const n = applyDir(r.tfs.q, [1, 0, 0]);
    assert.ok(Math.abs(n[0] - Math.cos((v * Math.PI) / 180)) < 1e-5 && Math.abs(n[1] - Math.sin((v * Math.PI) / 180)) < 1e-5, `${v}: ${n}`);
    assert.equal(r.dof.q, 0);
  }
  // Distance between the plate top (+Z) and the pin's under face: Aligned turns the pin over, Anti-aligned does not.
  for (const align of ["aligned", "anti"] as const) {
    const dist: Mate = { id: "m5", name: "Distance1", type: "distance", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, value: 4, align };
    const r = solve({ doc: doc([conc, dist]), geo, size: 100 });
    assert.ok(r.ok, align);
    const nz = applyDir(r.tfs.q, [0, 0, -1])[2], z = applyPoint(r.tfs.q, [0, 0, 10])[2];
    assert.ok(Math.abs(nz - (align === "aligned" ? 1 : -1)) < 1e-6 && Math.abs(z - 9) < 1e-5, `${align}: n ${nz}, z ${z}`);
  }
});

test("a screw mate turns its shaft when the nut is moved by a distance (exam #75)", () => {
  // A shaft that can only spin in the plate's hole, a nut on it that can only slide: pitch 0.5 mm per turn.
  const all: Record<string, Record<string, Geo>> = { ...geos, nut: { bore: { k: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 3 }, face: { k: "plane", p: [0, 0, 0], n: [0, 0, 1] }, flat: { k: "plane", p: [5, 0, 0], n: [1, 0, 0] } } };
  const g = (part: string, face: string) => all[part]?.[face] ?? null;
  const base = doc([conc, coin]);
  const d: AsmDoc = {
    ...base,
    parts: { ...base.parts, nut: { name: "nut", file: "nut.mcadprt", doc: stub } },
    components: [...base.components, { id: "n", name: "nut<1>", part: "nut", tf: translation([21, 9, 40]) }],
    mates: [conc, coin,
      { id: "m3", name: "Concentric2", type: "concentric", a: { comp: "q", face: "shank" }, b: { comp: "n", face: "bore" } },
      { id: "m4", name: "Parallel1", type: "parallel", a: { comp: "p", face: "side" }, b: { comp: "n", face: "flat" } }],
  };
  const r0 = solve({ doc: d, geo: g, size: 500 });
  assert.ok(r0.ok, JSON.stringify(r0.bad));
  d.components[1].tf = r0.tfs.q;
  d.components[2].tf = r0.tfs.n;
  const z0 = applyPoint(r0.tfs.n, [0, 0, 0])[2] - 5, x0 = applyDir(r0.tfs.q, [1, 0, 0]);
  const screw: Mate = { id: "m5", name: "Screw1", type: "screw", a: { comp: "q", face: "shank" }, b: { comp: "n", face: "bore" }, ratio: 0.5, t0: [r0.tfs.q, r0.tfs.n] };
  for (const move of [0.03, 0.31, 3.1]) {
    const dist: Mate = { id: "m6", name: "Distance1", type: "distance", a: { comp: "p", face: "top" }, b: { comp: "n", face: "face" }, value: Math.abs(z0 + move), flip: z0 + move < 0, align: "aligned" };
    const r = solve({ doc: { ...d, mates: [...d.mates!, screw, dist] }, geo: g, size: 500 });
    assert.ok(r.ok, `${move}: ${JSON.stringify(r.bad)}`);
    assert.ok(Math.abs(applyPoint(r.tfs.n, [0, 0, 0])[2] - 5 - (z0 + move)) < 1e-4, `nut at ${applyPoint(r.tfs.n, [0, 0, 0])}`);
    // The shaft stayed in its hole and turned move / pitch turns (either way round).
    const at = applyPoint(r.tfs.q, [0, 0, 10]);
    assert.ok(Math.abs(at[0] - 20) < 1e-4 && Math.abs(at[1] - 10) < 1e-4 && Math.abs(at[2] - 5) < 1e-4, String(at));
    const x = applyDir(r.tfs.q, [1, 0, 0]), turned = Math.acos(Math.max(-1, Math.min(1, x[0] * x0[0] + x[1] * x0[1] + x[2] * x0[2])));
    const want = Math.abs(((move / 0.5) * 2 * Math.PI + Math.PI) % (2 * Math.PI) - Math.PI);
    assert.ok(Math.abs(turned - want) < 1e-3, `${move}: turned ${turned}, expected ${want}`);
  }
});

test("a slot mate keeps the pin between the slot's rounded ends (exam #81)", () => {
  // Slot 10 wide in y (faces y = 30 and 40) with end caps r 5 at x = 0 and x = 20, axes along z.
  const g2: Record<string, Record<string, Geo>> = { ...geos, plate: { ...geos.plate,
    slotA: { k: "plane", p: [10, 30, 0], n: [0, -1, 0] }, slotB: { k: "plane", p: [10, 40, 0], n: [0, 1, 0] },
    cap0: { k: "axis", p: [0, 35, 3], d: [0, 0, 1], r: 5 }, cap1: { k: "axis", p: [20, 35, -2], d: [0, 0, -1], r: 5 } } };
  const gg = (p: string, f: string) => g2[p]?.[f] ?? null;
  const faces = (p: string) => Object.values(g2[p] ?? {});
  const at = (x: number): AsmDoc => ({ ...doc([{ id: "sl", name: "Slot1", type: "slot", a: { comp: "p", face: "slotA" }, b: { comp: "q", face: "shank" }, c: { comp: "p", face: "slotB" } }]),
    components: [{ id: "p", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true }, { id: "q", name: "pin<1>", part: "pin", tf: translation([x, 36, 0]) }] });
  // Inside the slot the pin stays where it is along it.
  const s1 = solve({ doc: at(12), geo: gg, faces, size: 100 });
  assert.ok(s1.ok);
  assert.ok(Math.abs(applyPoint(s1.tfs.q, [0, 0, 0])[0] - 12) < 1e-6 && Math.abs(applyPoint(s1.tfs.q, [0, 0, 0])[1] - 35) < 1e-6);
  // Past an end it is brought back to that end (measured where the cap axes are, z = 3: the pin may lean along the slot); without the faces (older callers) it may stay out.
  const s2 = solve({ doc: at(31), geo: gg, faces, size: 100 });
  assert.ok(s2.ok && Math.abs(applyPoint(s2.tfs.q, [0, 0, 3])[0] - 20) < 1e-5, String(applyPoint(s2.tfs.q, [0, 0, 3])));
  const s3 = solve({ doc: at(-7), geo: gg, faces, size: 100 });
  assert.ok(s3.ok && Math.abs(applyPoint(s3.tfs.q, [0, 0, 3])[0]) < 1e-5);
  assert.ok(Math.abs(applyPoint(solve({ doc: at(31), geo: gg, size: 100 }).tfs.q, [0, 0, 0])[0] - 31) < 1e-6);
  // The ends take no freedom away, even with the pin at one.
  const free = solve({ doc: at(20), geo: gg, faces, size: 100 }).dof.q, plain = solve({ doc: at(20), geo: gg, size: 100 }).dof.q;
  assert.equal(free, plain);
});

test("a 57-part engine with repeated, slightly inexact mates still shows its one freedom (exam #94)", () => {
  // The Leuenberger engine as saved from the app: 148 mates, many of them saying the same thing twice (a Lock beside
  // Concentric + Coincident) with directions stored about 1e-5 off. Only the crank train may move.
  const f = JSON.parse(readFileSync("tests/fixtures/engine-dof.json", "utf8")) as { size: number; centres: [string, [number, number, number]][]; geo: [string, [string, Geo][]][]; components: AsmDoc["components"]; mates: Mate[] };
  const gm = new Map(f.geo.map(([p, fs]) => [p, new Map(fs)])), cm = new Map(f.centres);
  const d: AsmDoc = { ...doc([]), components: f.components, mates: f.mates };
  const r = solve({ doc: d, geo: (p, face) => gm.get(p)?.get(face) ?? null, faces: p => gm.get(p)?.values() ?? [], centre: p => cm.get(p) ?? [0, 0, 0], size: f.size });
  assert.ok(r.ok);
  assert.equal(r.free, 1);
  const name = (n: string) => f.components.find(c => c.name.startsWith(n))!.id;
  assert.equal(r.dof[name("2-01.1-flywheel")], 1);
  assert.equal(r.dof[name("2-07.1-spool-valve")], 1);
  assert.equal(r.dof[name("1-03.1-cylinder")], 0);
  // The handwheel's screw (0.5 mm a turn) is a weak row, but a real one: the reverser stays put.
  assert.equal(r.dof[name("2-05.4-handwheel")], 0);
});
