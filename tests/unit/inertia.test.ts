// Mass properties (FR-MAT-002): mesh second moments, OCCT's inertia matrix, combining bodies and the SolidWorks-style report.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { bodyMasses, combine, covOfTensor, massReport, meshMoments, principal, rotateSym, type Sym, type V3 } from "../../src/tools/inertia";
import { Kernel } from "../../src/kernel/occ";
import { occ } from "./occ";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
const nearAll = (a: number[], b: number[], tol = 1e-6) => a.forEach((v, i) => near(v, b[i], tol));

/** Covariance of a solid box w × d × h (unit density) about its centre. */
const boxCov = (w: number, d: number, h: number): Sym => { const V = w * d * h; return [V * w * w / 12, V * d * d / 12, V * h * h / 12, 0, 0, 0]; };
const boxGeo = (w: number, d: number, h: number, c: V3) => new THREE.BoxGeometry(w, d, h).translate(...c);

/** An L made of two boxes: 40×10×10 at (20, 5, 5) and 10×30×10 at (5, 25, 5). Analytic covariance via the parallel axis rule. */
const L = { boxes: [{ s: [40, 10, 10] as V3, c: [20, 5, 5] as V3 }, { s: [10, 30, 10] as V3, c: [5, 25, 5] as V3 }] };
const lAnalytic = () => combine(L.boxes.map(b => ({ volume: b.s[0] * b.s[1] * b.s[2], area: 0, com: b.c, cov: boxCov(...b.s), density: 1000 })));

test("mesh moments of a box far from the origin match the analytic ones", () => {
  const g = boxGeo(30, 20, 10, [1e4, -2e4, 5e3]);
  const r = meshMoments(g.getAttribute("position").array, g.getIndex()!.array);
  near(r.volume, 6000);
  nearAll(r.com, [1e4, -2e4, 5e3]);
  nearAll(r.cov, boxCov(30, 20, 10), 1e-5);
});

test("an L-shaped mesh has the analytic covariance with a non-zero product", () => {
  const g = mergeGeometries(L.boxes.map(b => boxGeo(...b.s, b.c)))!;
  const r = meshMoments(g.getAttribute("position").array, g.getIndex()!.array);
  const a = lAnalytic();
  near(r.volume, a.volume);
  nearAll(r.com, a.com);
  nearAll(r.cov, a.cov, 1e-6);
  assert.ok(a.cov[3] < -1000, "the L's xy product is negative about its centre");
});

test("OCCT's MatrixOfInertia is at the centre of mass with −∫xy off the diagonal", async () => {
  const oc = await occ();
  const box = (s: V3, c: V3) => new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2), ...s).Shape();
  const fuse = new oc.BRepAlgoAPI_Fuse_3(box(L.boxes[0].s, L.boxes[0].c), box(L.boxes[1].s, L.boxes[1].c), new oc.Message_ProgressRange_1());
  const vp = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(fuse.Shape(), vp, true, false, false);
  const m = vp.MatrixOfInertia();
  const cov = covOfTensor([0, 1, 2].map(r => [0, 1, 2].map(c => m.Value(r + 1, c + 1))));
  nearAll(cov, lAnalytic().cov, 1e-9);
  // The kernel patch carries the same numbers.
  const k = new Kernel(oc);
  k.meshes = [{ shape: fuse.Shape(), faces: [], name: "L", color: [0, 0, 0], solid: true }];
  const p = k.exact(0, { faces: 0, faceArea: [], samples: [], edges: [] });
  nearAll(p.inertia!, lAnalytic().cov, 1e-9);
});

test("turning a body turns its covariance; principal moments do not change", () => {
  const a = lAnalytic();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 1.1));
  const M = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).transpose().elements;
  const R = [[M[0], M[1], M[2]], [M[3], M[4], M[5]], [M[6], M[7], M[8]]];
  const g = mergeGeometries(L.boxes.map(b => boxGeo(...b.s, b.c)))!.applyQuaternion(q);
  const r = meshMoments(g.getAttribute("position").array, g.getIndex()!.array);
  nearAll(r.cov.map(v => v * 1), rotateSym(a.cov, R), 1e-5);
  nearAll(principal(r.cov).moments, principal(a.cov).moments, 1e-5);
});

test("report: a 10 kg box seen from a frame at its corner (SolidWorks' Lxx and Ixx)", () => {
  // 100 × 50 × 20 mm, density 10 g/cm³ → 1000 g.
  const c = combine([{ volume: 1e5, area: 0, com: [50, 25, 10], cov: boxCov(100, 50, 20), density: 10 }]);
  near(c.mass, 1000);
  const r = massReport(c, { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  nearAll(r.local, [50, 25, 10]);
  near(r.atCom.xx, 1000 * (50 * 50 + 20 * 20) / 12);
  near(r.atCom.zz, 1000 * (100 * 100 + 50 * 50) / 12);
  near(r.atCom.xy, 0);
  near(r.atOrigin.xx, r.atCom.xx + 1000 * (25 * 25 + 10 * 10));
  near(r.atOrigin.xy, 1000 * 50 * 25);
  // Principal: smallest about the long side (X).
  nearAll(r.principal.moments, [r.atCom.xx, r.atCom.yy, r.atCom.zz].sort((x, y) => x - y));
  nearAll(r.principal.axes[0], [1, 0, 0]);
  // A frame turned 90° about Z: X' = Y, Y' = −X.
  const t = massReport(c, { origin: [0, 0, 0], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] });
  nearAll(t.local, [25, -50, 10]);
  near(t.atCom.xx, r.atCom.yy);
  nearAll(t.principal.axes[0].map(Math.abs), [0, 1, 0]);
});

test("two densities: the heavy body pulls the centre of mass", () => {
  const c = combine([
    { volume: 1000, area: 600, com: [0, 0, 0], cov: boxCov(10, 10, 10), density: 1 },
    { volume: 1000, area: 600, com: [20, 0, 0], cov: boxCov(10, 10, 10), density: 3 },
  ]);
  near(c.mass, 4);
  nearAll(c.com, [15, 0, 0]);
  near(c.area, 1200);
  // ∫x² dm: 4 × (1000/12)/1000 own + 1 g × 15² + 3 g × 5².
  near(c.cov[0], 4 * 100 / 12 + 225 + 75);
  assert.equal(c.partial, false);
  assert.equal(combine([{ volume: 1, area: 1, com: [0, 0, 0], density: 1 }]).partial, true);
});

test("bodies with their own materials: own density where set, the part's for the rest", () => {
  const list = [
    { key: "a", volume: 8000, area: 2800, com: [0, 0, 5] as V3, cov: [1, 1, 1, 0, 0, 0] as Sym },
    { key: "b", volume: 1000, area: 600, com: [40, 0, 5] as V3, cov: [1, 1, 1, 0, 0, 0] as Sym },
  ];
  const bs = bodyMasses(list, k => (k === "b" ? 4.43 : undefined), 7.85)!;
  assert.deepEqual(bs.map(b => b.density), [7.85, 4.43]);
  const c = combine(bs);
  assert.ok(Math.abs(c.mass - (62.8 + 4.43)) < 1e-9);
  assert.ok(Math.abs(c.com[0] - (40 * 4.43) / 67.23) < 1e-9);
  // Bodies without their own mass properties (a one-body rebuild): nothing to combine.
  assert.equal(bodyMasses([{ key: "a", volume: 1 }], () => undefined, 1), null);
  assert.equal(bodyMasses([], () => undefined, 1), null);
});
