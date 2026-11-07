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
