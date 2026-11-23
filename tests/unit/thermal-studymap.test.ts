// A thermal study beside the package map it was made from (FRS-thermal FR-TRES-030).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareStudyMap, fitShift, meshBox } from "../../src/thermal/studyMap";
import type { ThermalMesh } from "../../src/thermal/vtu";
import type { ThermalPart } from "../../src/thermal/package";

/** A strip of n squares along X (two triangles each), part `part(k)` per square, temperature f(x). */
function strip(n: number, step: number, part: (k: number) => number, f: (x: number) => number, dx = 0): ThermalMesh {
  const pos: number[] = [], temp: number[] = [], tri: number[] = [], parts: number[] = [];
  for (let i = 0; i <= n; i++) for (const y of [0, 1]) { pos.push(i * step + dx, y, 0); temp.push(f(i * step)); }
  for (let k = 0; k < n; k++) { const a = 2 * k; tri.push(a, a + 2, a + 3, a, a + 3, a + 1); parts.push(part(k), part(k)); }
  return { pos: Float32Array.from(pos), temp: Float32Array.from(temp), tri: Uint32Array.from(tri), part: Int32Array.from(parts) };
}
const P = (id: number, d: string, t?: number): ThermalPart => ({ id, designator: d, bodies: [], part: "", ...(t !== undefined ? { t } : {}) });

test("study against its package: ΔT per point, parts paired by designator, the board as the board", () => {
  // the package: board (part 0) then U1 and R1; the study is finer and 3 K warmer on U1, 1 K cooler on the board
  const map = strip(10, 1, k => (k < 4 ? 0 : k < 7 ? 1 : 2), x => 40 + x);
  const study = strip(40, 0.25, k => (k < 16 ? 0 : k < 28 ? 1 : 2), x => 40 + x + (x <= 4 ? -1 : x <= 7 ? 3 : 0));
  const c = compareStudyMap(study, [P(1, "U1"), P(2, "R1"), P(9, "C5")], { mesh: map, parts: [P(1, "U1"), P(2, "R1"), P(3, "D1")] });
  assert.equal(c.delta.length, study.temp.length);
  // a point of U1 at x = 5 is 3 K hotter than the package says there (the package's nearest point is the same place)
  const v = 2 * 20;
  assert.ok(Math.abs(study.pos[3 * v] - 5) < 1e-6 && Math.abs(c.delta[v] - 3) < 1e-4, `${c.delta[v]}`);
  assert.deepEqual(c.rows.map(r => [r.name, Math.round(r.d * 100) / 100]), [["U1", 3], ["", -1], ["R1", 0]]);
  assert.deepEqual(c.onlyMap, ["D1"]);
  assert.deepEqual(c.onlyStudy, ["C5"]);
  assert.equal(c.hot.map, 50);
  assert.ok(Math.abs(c.hot.study - 50) < 1e-6);
  assert.ok(c.most >= 3 - 1e-4 && c.most < 3.3 && c.mean > 0.5 && c.mean < 3);
  // a package temperature reported as a junction is what the package says for that part
  const j = compareStudyMap(study, [P(1, "U1", 70)], { mesh: map, parts: [P(1, "U1", 75)] });
  assert.equal(j.rows.find(r => r.name === "U1")!.d, -5);
});

test("a package picked by hand in another frame goes onto the model by its box centre", () => {
  const model = strip(10, 1, () => 0, () => 20), moved = strip(10, 1, () => 0, () => 20, 100);
  assert.deepEqual(fitShift(model.pos, moved.pos), [-100, 0, 0]);
  assert.deepEqual(fitShift(model.pos, model.pos), [0, 0, 0]);
  // another size: not the same board, left where it is
  assert.deepEqual(fitShift(model.pos, strip(20, 1, () => 0, () => 20, 100).pos), [0, 0, 0]);
  assert.deepEqual(meshBox(model.pos), [0, 0, 0, 10, 1, 0]);
  // with the shift the package's temperatures land on the right points
  const map = strip(10, 1, () => 0, x => 30 + x, 100), study = strip(10, 1, () => 0, x => 30 + x);
  const c = compareStudyMap(study, [], { mesh: map, parts: [] }, fitShift(study.pos, map.pos));
  assert.ok(c.most < 1e-4, `${c.most}`);
});
