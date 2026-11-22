// Comparing two thermal maps of one model (FRS-thermal FR-TMAP-030/031).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deltaRange, mapOnto, partChanges, vertexParts } from "../../src/thermal/compare";
import type { ThermalMesh } from "../../src/thermal/vtu";
import type { PartStat, ThermalPart } from "../../src/thermal/package";

/** A strip of n squares along X (two triangles each), part `part(k)` per square, temperature f(x). */
function strip(n: number, step: number, part: (k: number) => number, f: (x: number) => number, dy = 0): ThermalMesh {
  const pos: number[] = [], temp: number[] = [], tri: number[] = [], parts: number[] = [];
  for (let i = 0; i <= n; i++) for (const y of [0, 1]) { pos.push(i * step, y + dy, 0); temp.push(f(i * step)); }
  for (let k = 0; k < n; k++) { const a = 2 * k; tri.push(a, a + 2, a + 3, a, a + 3, a + 1); parts.push(part(k), part(k)); }
  return { pos: Float32Array.from(pos), temp: Float32Array.from(temp), tri: Uint32Array.from(tri), part: Int32Array.from(parts) };
}

test("the same mesh: B's temperatures as they are", () => {
  const a = strip(10, 1, () => 1, x => 20 + x), b = strip(10, 1, () => 1, x => 30 + 2 * x);
  assert.deepEqual([...mapOnto(a, b)], [...b.temp]);
});

test("another mesh: the nearest point of B, on the same part where it has one", () => {
  const a = strip(10, 1, k => (k < 5 ? 1 : 2), x => 20), b = strip(40, 0.25, k => (k < 20 ? 1 : 2), x => 100 * x);
  const t = mapOnto(a, b), pa = vertexParts(a);
  for (let v = 0; v < a.temp.length; v++) assert.ok(Math.abs(t[v] - 100 * a.pos[3 * v]) < 1e-3, `point ${v}: ${t[v]}`);
  // at x = 5 the point belongs to part 1 in A; B's points at x = 5 are on part 1 too (first triangle)
  assert.equal(pa[10], 1);
  // B moved 0.4 along Y: the shift brings it back
  const c = strip(40, 0.25, () => 1, x => 100 * x, 0.4);
  const s = mapOnto(a, c, [0, -0.4, 0]);
  assert.ok(Math.abs(s[4] - 200) < 1e-3, `${s[4]}`);
});

test("parts paired by designator, largest change first, the ones in one map only listed", () => {
  const P = (id: number, d: string, t?: number): ThermalPart => ({ id, designator: d, bodies: [], part: "", ...(t !== undefined ? { t } : {}) } as ThermalPart);
  const S = (max: number): PartStat => ({ tris: 1, min: 0, max, at: [0, 0, 0], box: [0, 0, 0, 1, 1, 1] });
  const sa = new Map([[0, S(50)], [1, S(80)], [2, S(60)], [3, S(40)]]), sb = new Map([[0, S(45)], [5, S(70)], [6, S(61)], [7, S(30)]]);
  const r = partChanges([P(1, "U1"), P(2, "R1"), P(3, "C1")], sa, [P(5, "U1"), P(6, "R1"), P(7, "C9")], sb);
  assert.deepEqual(r.rows.map(x => [x.name, x.d]), [["U1", -10], ["", -5], ["R1", 1]]);
  assert.deepEqual(r.onlyA, ["C1"]);
  assert.deepEqual(r.onlyB, ["C9"]);
  assert.deepEqual(deltaRange([-3, 2, NaN]), [-3, 3]);
  assert.deepEqual(deltaRange([0.2]), [-1, 1]);
});
