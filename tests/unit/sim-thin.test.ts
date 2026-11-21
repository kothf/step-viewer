// Structural analysis: a body thinner than a cell (a thin plate among thick parts of an assembly: the cells are
// sized by the whole assembly). No cell of it is a quarter full, so none was a root to join the slivers at its
// rim to: a cell holding next to nothing stood alone and made the stiffness matrix indefinite from degree 3 on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGrid } from "../../src/sim/grid";

test("the rim slivers of a plate thinner than a cell join a neighbour", () => {
  const box = (lo: number[], hi: number[]) => (x: number, y: number, z: number) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
  // a thick block and a plate 2 mm thick lying on it, its rim a hair into the next cells
  const block = box([0, 0, 0], [100, 60, 30]), plate = box([-0.3, -0.3, 30], [75, 45, 32]);
  const all = (x: number, y: number, z: number) => block(x, y, z) || plate(x, y, z);
  const g = makeGrid([-0.3, -0.3, 0], [100, 60, 32], 10, all, { q: 3, depth: 3, fit: 5, domains: [block, plate] });
  const cells = g.cells.filter(c => c.dom === 1), most = Math.max(...cells.map(c => c.frac));
  assert.ok(most < 0.25 && cells.some(c => c.frac < 0.01), `the plate's cells: fullest ${most}, emptiest ${Math.min(...cells.map(c => c.frac))}`);
  for (const e of g.elems) {
    if (g.cells[e.cells[0]].dom !== 1) continue;
    const sum = e.cells.reduce((a, c) => a + g.cells[c].frac, 0);
    assert.ok(sum >= 0.5 * most - 1e-9, `an element of the plate holds ${sum} of a cell (fullest cell ${most})`);
  }
  // the thick block is aggregated as before: its roots are the cells a quarter full
  for (const e of g.elems) if (g.cells[e.cells[0]].dom === 0) assert.ok(g.cells[e.cells[0]].frac >= 0.25 || e.cells.length === 1);
});
