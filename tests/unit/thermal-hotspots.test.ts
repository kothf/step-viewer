// Hottest points and heat flux at sharp corners of a thermal result (FRS-thermal FR-TRES-003).
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalHotSpots, vectorSize } from "../../src/sim/hotspots";
import { refineMesh } from "../../src/sim/plotmesh";
import { runThermal, thermalSetup, studyProblem, type SimBody } from "../../src/sim/run";
import { thermalHotCsv } from "../../src/sim/exports";
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


/** The top end held at 20 °C, 20 W into the other end: the heat turns the inside corner of the L. */
function solve(r: number, passes: number) {
  const { body, top, end } = bracket(r);
  const st = newStudy([], "thermal");
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: top }], temp: 20 });
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: end }], value: { v: 20 } });
  const nrm: number[] = [];
  for (let o = 0; o < body.tris.length; o += 9) {
    const t = body.tris, u = [t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]], w = [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]];
    const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...c) || 1;
    for (let k = 0; k < 3; k++) nrm.push(c[0] / l, c[1] / l, c[2] / l);
  }
  const mesh = refineMesh(body.tris, nrm, null, 60 / 40);
  const ps = [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes, energyTol: 0, pos: mesh.pos, nrm: mesh.nrm, thermal: { k: 0.054, setup: thermalSetup(st, body) } })];
  return { mesh, ps, hot: thermalHotSpots(mesh.pos, mesh.index, ps, 5) };
}

test("thermal hot spots: the heat flux at a sharp inside corner keeps rising and is flagged", () => {
  const { ps, hot } = solve(0, 5);
  assert.equal(hot.corners.length, 1, "one sharp corner edge");
  for (const h of hot.corners) {
    assert.ok(Math.abs(h.at[0] - 20) < 1e-6 && Math.abs(h.at[2] - 20) < 1e-6, `on the corner line: ${h.at}`);
    assert.ok(h.growth! > 1.08 && h.singular);
  }
  // the hottest point is the heated end, far from the held one
  const last = ps.at(-1)!;
  assert.ok(hot.temps.length >= 1);
  assert.ok(Math.abs(hot.temps[0].vm - last.thermal!.max) < 1e-3, `${hot.temps[0].vm} for ${last.thermal!.max}`);
  assert.ok(hot.temps[0].at[0] > 55, `${hot.temps[0].at}`);
  assert.ok(hot.temps.every(h => !h.singular));
  // the whole sharp edge is marked, so the highest flux away from it is the one at the held end's rim or the heated end
  const sharp = [...hot.sharp.keys()].filter(i => hot.sharp[i]);
  assert.ok(sharp.length > 3);
  const q = vectorSize(last.u);
  let away = 0;
  for (let i = 0; i < q.length; i++) if (!hot.sharp[i] && q[i] > away) away = q[i];
  assert.ok(away < 0.8 * hot.corners[0].vm, `${away} against ${hot.corners[0].vm}`);
  // flux sizes in W/mm²
  assert.equal(vectorSize(last.u).length, last.vm.length);
  const csv = thermalHotCsv(hot.temps, hot.corners).split("\r\n");
  assert.equal(csv[0], "Kind,#,X (mm),Y (mm),Z (mm),Temperature (C),Heat flux (W/m2)");
  assert.ok(csv[1].startsWith("Hottest point,1,"));
  assert.ok(csv.some(l => l.startsWith("Sharp corner,1,20,")));
});

test("thermal hot spots: a rounded inside corner settles and is not flagged", () => {
  const { hot } = solve(5, 5);
  assert.equal(hot.corners.length, 0);
  // one hot end: no ripple on the slope down to the held end counts as a hot spot
  assert.equal(hot.temps.length, 1, JSON.stringify(hot.temps.map(h => [h.at, h.vm])));
  assert.equal(hot.sharp.reduce((a, b) => a + b, 0), 0);
});

test("thermal hot spots: two passes are enough when the flux at the corner jumps", () => {
  const two = solve(0, 2).hot;
  assert.equal(two.corners.length, 1);
  const r5 = solve(5, 2).hot;
  assert.equal(r5.corners.length, 0);
});
