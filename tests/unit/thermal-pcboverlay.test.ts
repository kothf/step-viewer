// Thermal overlay in the PCB view (FRS-thermal FR-TMAP-040): the package's board top and bottom faces rasterised
// in the Gerber frame, each cell the temperature interpolated at its centre, parts and edges left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faceGrids, gridAt } from "../../src/thermal/pcbOverlay";
import { pcbFit, type GBox } from "../../src/thermal/pcbTexture";
import type { ThermalMesh } from "../../src/thermal/vtu";

/** A 100 × 60 × 1.6 board: top = 4 points at z 1.6 with T = 20 + x / 2, bottom = 4 at z 0 with T = 30 + y / 2, a part on top at 90 °C. */
function board(withFace: boolean): ThermalMesh {
  const P = [[0, 0], [100, 0], [100, 60], [0, 60]];
  const pos: number[] = [], temp: number[] = [];
  for (const [x, y] of P) { pos.push(x, y, 1.6); temp.push(20 + x / 2); }
  for (const [x, y] of P) { pos.push(x, y, 0); temp.push(30 + y / 2); }
  // a part: one triangle standing on the top face
  pos.push(40, 20, 1.6, 50, 20, 1.6, 45, 30, 8); temp.push(90, 90, 90);
  const tri = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 1, 5, 8, 9, 10];
  const part = [0, 0, 0, 0, 0, 1];
  const face = [1, 1, 2, 2, 3, 0];
  return {
    pos: Float32Array.from(pos), temp: Float32Array.from(temp), tri: Uint32Array.from(tri), part: Int32Array.from(part),
    face: withFace ? Int8Array.from(face) : undefined, range: [20, 90],
  } as ThermalMesh;
}

test("each side is rasterised over the Gerber box with the temperature interpolated, parts and edges left out", () => {
  const m = board(true), g: GBox = [0, 0, 100, 60];
  const f = pcbFit(m.pos, m.tri, m.part, g, 0, 0, m.face)!;
  const gr = faceGrids(m, f, g, 100, 60);
  // every cell of both faces is covered
  assert.equal(gr.top.t.filter(v => !Number.isNaN(v)).length, 6000);
  assert.equal(gr.bottom.t.filter(v => !Number.isNaN(v)).length, 6000);
  // top varies along x only, bottom along y only; the part's 90 °C is not drawn
  assert.ok(Math.abs(gridAt(gr.top, g, 10.5, 5)! - 25.25) < 1e-3);
  assert.ok(Math.abs(gridAt(gr.top, g, 80.5, 50)! - 60.25) < 1e-3);
  assert.ok(Math.abs(gridAt(gr.bottom, g, 50, 10.5)! - 35.25) < 1e-3);
  assert.ok(gr.max < 81 && gr.min > 20);
  assert.equal(gridAt(gr.top, g, 120, 5), null);
});

test("without Face the side comes from the board's middle; the Gerber box elsewhere follows the fit", () => {
  const m = board(false), g: GBox = [200, 100, 300, 160];
  const f = pcbFit(m.pos, m.tri, m.part, g)!;
  const gr = faceGrids(m, f, g, 50, 30);
  // the board centre (50, 30) lies on the Gerber box's centre (250, 130)
  assert.ok(Math.abs(gridAt(gr.top, g, 251, 130)! - 45.5) < 1.1);
  assert.ok(Math.abs(gridAt(gr.bottom, g, 250, 131)! - 45.5) < 1.1);
  // the sides differ where x and y do: board (10, 50) = Gerber (210, 150)
  assert.ok(Math.abs(gridAt(gr.top, g, 210, 150)! - 25) < 1.1);
  assert.ok(Math.abs(gridAt(gr.bottom, g, 210, 150)! - 55) < 1.1);
  // the edge triangle has no Face: it stands edge-on in plan and draws nothing new; the part (part 1) none
  assert.ok(gr.max <= 80.01);
});
