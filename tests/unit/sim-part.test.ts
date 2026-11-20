// Structural analysis spike on a real part (FRS-structural AT-SA0-3/4): the modelling FRS bracket built by
// the kernel, tessellated by simgeo, solved by the cell method at p = 1..4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { simGeometry, faceTris } from "../../src/kernel/simgeo";
import { MeshBody, insideOf } from "../../src/sim/body";
import { solveStatic } from "../../src/sim/static";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

function bracketDoc(): PartDoc {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: k, t: "point", x, y });
  const sk: SketchFeature = {
    id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [],
    ents: [
      P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
      { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" },
      { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" },
      P("c", 0, 0), { id: "k", t: "circle", c: "c", r: 5 },
    ],
  };
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  return { schema: 1, kind: "part", id: "b", name: "bracket", units: { length: "mm", decimals: 2 }, props: {}, features: [sk, ex], rollback: null };
}

test("bracket: quadrature volume and a converging static solve (AT-SA0-3/4)", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const r = m.evaluate(bracketDoc());
  assert.ok(r.body);
  const exact = m.props(r.body!).volume;
  const geo = simGeometry(oc, r.body!.shape, r.body!.faces, 0.002, 0.05);
  const body = new MeshBody(geo.tris);
  const inside = insideOf(body);
  const fixed = new Set<number>(), loaded = new Set<number>();
  r.body!.names.forEach((n, i) => { if (n === "f1:side:l4") fixed.add(i); if (n === "f1:side:l2") loaded.add(i); });
  assert.equal(fixed.size, 1);
  assert.equal(loaded.size, 1);
  const E = 210000, I = (60 * 20 ** 3) / 12, L = 100;
  const beam = (1000 * L ** 3) / (3 * E * I) + (1000 * L) / ((5 / 6) * (E / 2.6) * 1200);
  let last = 0;
  let grid: ReturnType<typeof solveStatic>["grid"] | undefined;
  for (const p of [2, 3, 4]) {
    const res = solveStatic({ grid,
      lo: geo.lo, hi: geo.hi, inside, h: 10, p, mat: { E, nu: 0.3 }, solver: process.env.SIM_SOLVER as any,
      fixed: [{ tris: faceTris(geo, fixed) }],
      loads: [{ tris: faceTris(geo, loaded), force: [0, 0, -1000] }],
    });
    grid = res.grid;
    const vol = res.grid.volume;
    const w = -res.disp(49.999, 20, 10)[2];
    console.log(`bracket p ${p}: ${res.dofs} dofs, volume ${(vol / exact - 1).toExponential(2)}, tip ${w.toFixed(5)} mm (beam ${beam.toFixed(5)}), energy ${res.energy.toFixed(5)}, it ${res.iterations}, ms ${JSON.stringify(res.ms)}`);
    assert.ok(Math.abs(vol - exact) / exact < 1e-4, `volume ${vol} vs ${exact}`);
    assert.ok(res.energy > last);
    last = res.energy;
    assert.ok(Math.abs(w - beam) / beam < 0.1, `tip ${w} vs beam ${beam}`);
  }
});
