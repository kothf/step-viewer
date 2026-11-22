// A heat-source CSV alone (FRS-thermal FR-TPKG-015): the powers of a board without its temperature map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchParts, type ModelBody } from "../../src/thermal/match";
import { isSourcesCsv, partStats, readPackage, readSources, sourcesPackage } from "../../src/thermal/package";
import { boardPlan } from "../../src/thermal/study";
import { ThermalError } from "../../src/thermal/vtu";

const POWERS = readFileSync("tests/fixtures/thermal/amp-powers.csv", "utf8");

test("a heat-source table is told from other CSV files by its header", () => {
  assert.ok(isSourcesCsv(POWERS));
  assert.ok(isSourcesCsv("﻿part_id,step_bodies,p_total_W\n1,R1,2\n"));
  assert.ok(!isSourcesCsv("designator,value\nR1,10k\n"));
  assert.ok(!isSourcesCsv("p_total_W\n2\n"));
  assert.ok(!isSourcesCsv("x,y,z\n1,2,3\n"));
});

test("rows without part_id are numbered in order", () => {
  const ps = readSources(POWERS);
  assert.deepEqual(ps.map(p => [p.id, p.designator, p.p, p.limit]), [[1, "V3", 18.2, 250], [2, "Q2", 4.4, 150], [3, "R20", 3.4, 155], [4, "R14", 3.1, 155], [5, "C12", 0.05, 105], [6, "C13", 0.02, 105], [7, "X9", 1, 85]]);
});

test("a CSV alone reads as a package with no map", async () => {
  const pkg = await readPackage(new Map([["amp-heat-sources.csv", new TextEncoder().encode(POWERS)]]), "x");
  assert.equal(pkg.sourcesOnly, true);
  assert.equal(pkg.name, "amp");
  assert.equal(pkg.mesh.tri.length, 0);
  assert.equal(pkg.manifest.parts.length, 7);
  assert.equal(partStats(pkg.mesh).size, 0);
  // a CSV with no power in it is refused; other files still need a manifest
  assert.throws(() => sourcesPackage("a.csv", "designator,p_total_W\nR1,\n"), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-PKG");
  await assert.rejects(readPackage(new Map([["notes.csv", new TextEncoder().encode("a,b\n1,2\n")]])), (e: unknown) => e instanceof ThermalError && /manifest/.test(e.reason));
});

test("the parts are found by name and give a board study its heat", async () => {
  const pkg = await readPackage(new Map([["amp-powers.csv", new TextEncoder().encode(POWERS)]]));
  const box = (x: number, y: number, z0: number, z1: number, s = 5): ModelBody["box"] => [x - s, y - s, z0, x + s, y + s, z1];
  const bodies: ModelBody[] = [
    { name: "PCB", box: [0, 0, 0, 120, 80, 1.6] },
    { name: "V3", box: box(45, 62, 1.6, 60) }, { name: "Q2", box: box(105, 6, 1.6, 16) }, { name: "R20", box: box(79, 22, 1.6, 7) },
    { name: "R14", box: box(45, 30, 1.6, 8) }, { name: "C12", box: box(74, 55, 1.6, 33) }, { name: "C13", box: box(95, 35, 1.6, 14) },
  ];
  const m = matchParts(pkg.manifest.parts, partStats(pkg.mesh), bodies);
  assert.deepEqual(m.missing, [7]);
  assert.deepEqual(m.bodies.get(1), [1]);
  const plan = boardPlan(pkg.manifest, m, bodies);
  assert.equal(plan.board, 0);
  assert.equal(plan.thickness, 1.6);
  assert.equal(plan.heat.length, 7);
  assert.ok(Math.abs(plan.power - 29.17) < 1e-9);
  assert.deepEqual(plan.heat.find(h => h.name === "X9")?.bodies, []);
  assert.equal(plan.names[1], "V3");
});
