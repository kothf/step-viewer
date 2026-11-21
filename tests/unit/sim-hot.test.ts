// Hot spots and stress singularities (FRS-structural FR-RES-004, FR-SOL-015, FR-RES-012).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hotSpots } from "../../src/sim/hotspots";
import { refineMesh } from "../../src/sim/plotmesh";
import { runStatic, studyProblem, type SimBody } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

/** A prism: the ccw outline in (x, z) pushed along y from 0 to `t`. Faces e0, e1, … per outline edge, then y0, y1. */
function prism(pts: [number, number][], t: number, caps: [number, number, number][]): SimBody {
  const tris: number[] = [], face: number[] = [], names: string[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % n];
    // outward of a ccw outline in (x, z), seen from −y: (dz, −dx)
    tris.push(ax, 0, az, ax, t, az, bx, t, bz, ax, 0, az, bx, t, bz, bx, 0, bz);
    names.push(`e${i}`); face.push(i, i);
  }
  for (const [y, name] of [[0, "y0"], [t, "y1"]] as const) {
    names.push(name);
    for (const [a, b, c] of caps) {
      const P = [pts[a], pts[b], pts[c]];
      // a ccw triangle in (x, z) faces −y
      const o = y ? [0, 2, 1] : [0, 1, 2];
      for (const k of o) tris.push(P[k][0], y, P[k][1]);
      face.push(names.length - 1);
    }
  }
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  const b: SimBody = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo: [Math.min(...xs), 0, Math.min(...zs)], hi: [Math.max(...xs), t, Math.max(...zs)] };
  return b;
}

/** An L bracket, 60 × 60, legs 20 thick, 20 deep; `r` rounds the inside corner with `seg` chords. */
function bracket(r: number, seg = 12): { body: SimBody; top: string; end: string } {
  const pts: [number, number][] = [[0, 0], [60, 0], [60, 20]];
  if (r > 0) for (let i = 0; i <= seg; i++) { const a = -Math.PI / 2 - (Math.PI / 2) * (i / seg); pts.push([20 + r + r * Math.cos(a), 20 + r + r * Math.sin(a)]); }
  else pts.push([20, 20]);
  pts.push([20, 60], [0, 60]);
  const n = pts.length, caps: [number, number, number][] = [];
  // a fan from the outside corner (0, 0) sees every vertex of the L
  for (let i = 1; i + 1 < n; i++) caps.push([0, i, i + 1]);
  return { body: prism(pts, 20, caps), top: `e${n - 2}`, end: "e1" };
}

function solve(r: number, passes: number) {
  const { body, top, end } = bracket(r);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: top }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: end }], comp: [{ v: 0 }, { v: 0 }, { v: -1000 }] });
  const nrm: number[] = [];
  for (let o = 0; o < body.tris.length; o += 9) {
    const t = body.tris, u = [t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]], w = [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]];
    const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...c) || 1;
    for (let k = 0; k < 3; k++) nrm.push(c[0] / l, c[1] / l, c[2] / l);
  }
  const mesh = refineMesh(body.tris, nrm, null, 60 / 40);
  const ps = [...runStatic({ body, mat: { name: "Steel", E: 210000, nu: 0.3, rho: 0 }, problem: studyProblem(st, body), passes, energyTol: 0, pos: mesh.pos, nrm: mesh.nrm })];
  return { mesh, ps };
}

test("hot spots: a sharp inside corner is a singularity, a rounded one is a real peak", () => {
  const sharp = solve(0, 4);
  const hs = hotSpots(sharp.mesh.pos, sharp.mesh.index, sharp.ps, 6);
  // the corner line x = 20, z = 20 leads the list and is flagged; the bending stress of the legs follows
  assert.ok(hs[0].singular, JSON.stringify(hs[0]));
  assert.ok(Math.abs(hs[0].at[0] - 20) < 1 && Math.abs(hs[0].at[2] - 20) < 1);
  assert.ok(hs[0].growth! > 1.1);
  const real = hs.filter(h => !h.singular);
  assert.ok(real.length >= 3 && real.length <= 5);
  // 1000 N at 30 to 40 mm on a 20 × 20 section: 6 M / b h² = 22 to 30 MPa plus the corner's rise
  assert.ok(real[0].vm > 25 && real[0].vm < 60, `real peak ${real[0].vm}`);
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].vm <= hs[i - 1].vm);
  for (let i = 0; i < hs.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.hypot(...hs[i].at.map((x, k) => x - hs[j].at[k])) >= 6);
  // one pass or two: nothing can be flagged yet
  assert.ok(hotSpots(sharp.mesh.pos, sharp.mesh.index, sharp.ps.slice(0, 2), 6).every(h => !h.singular));
  assert.deepEqual(hotSpots(sharp.mesh.pos, sharp.mesh.index, [], 6), []);

  const round = solve(6, 4);
  const hr = hotSpots(round.mesh.pos, round.mesh.index, round.ps, 6);
  assert.ok(hr.every(h => !h.singular), JSON.stringify(hr));
  // the fillet carries the highest stress
  assert.ok(hr[0].at[0] < 27 && hr[0].at[2] < 27 && hr[0].at[0] >= 20 - 1e-6);
});
