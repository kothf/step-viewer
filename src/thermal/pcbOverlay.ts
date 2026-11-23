// The package's board-face temperatures as pictures for the 2D PCB view (FRS-thermal FR-TMAP-040): one grid per
// side in the Gerber frame, laid by the same fit as the board layers under a 3D map (pcbTexture.ts). Pure.

import { gerberAt, type GBox, type PcbFit } from "./pcbTexture";
import type { ThermalMesh } from "./vtu";

/** One side's temperatures: `w` × `h` cells over the Gerber box, row 0 = the box's top; NaN = no board face there. */
export interface SideGrid { w: number; h: number; t: Float32Array }

export interface FaceGrids { top: SideGrid; bottom: SideGrid; /** Lowest and highest board-face temperature drawn. */ min: number; max: number }

/** Is board triangle k on the top face? Face 1/2 when the file has them (3 = the edge: neither), else by side of the board's middle. */
function sideOf(m: ThermalMesh, f: PcbFit, k: number): "top" | "bottom" | null {
  if (m.face) return m.face[k] === 1 ? "top" : m.face[k] === 2 ? "bottom" : null;
  let z = 0;
  for (let c = 0; c < 3; c++) z += m.pos[m.tri[k * 3 + c] * 3 + f.axis];
  return (z / 3 >= f.mid) === f.topUp ? "top" : "bottom";
}

/**
 * Rasterises the board's top and bottom faces of `m` (part 0) into `w` × `h` grids over the Gerber box `g`, each
 * cell the temperature at its centre interpolated across the triangle holding it. Both sides are seen from above,
 * like Gerber bottom layers, so the PCB view's mirrored bottom view mirrors them too.
 */
export function faceGrids(m: ThermalMesh, f: PcbFit, g: GBox, w: number, h: number): FaceGrids {
  const top: SideGrid = { w, h, t: new Float32Array(w * h).fill(NaN) };
  const bottom: SideGrid = { w, h, t: new Float32Array(w * h).fill(NaN) };
  const gw = g[2] - g[0] || 1, gh = g[3] - g[1] || 1;
  let min = Infinity, max = -Infinity;
  const px = [0, 0, 0], py = [0, 0, 0], tv = [0, 0, 0];
  for (let k = 0; k < m.part.length; k++) {
    if (m.part[k] !== 0) continue;
    const side = sideOf(m, f, k);
    if (!side) continue;
    // a face seen edge-on carries nothing to a plan view
    for (let c = 0; c < 3; c++) {
      const i = m.tri[k * 3 + c];
      const [x, y] = gerberAt(f, g, m.pos, i * 3);
      px[c] = ((x - g[0]) / gw) * w;
      py[c] = ((g[3] - y) / gh) * h;
      tv[c] = m.temp[i];
    }
    const d = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2]);
    if (Math.abs(d) < 1e-9) continue;
    const grid = side === "top" ? top : bottom;
    const x0 = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2]))), x1 = Math.min(w - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
    const y0 = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2]))), y1 = Math.min(h - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
    const eps = -1e-6;
    for (let r = y0; r <= y1; r++) {
      const cy = r + 0.5;
      for (let q = x0; q <= x1; q++) {
        const cx = q + 0.5;
        const a = ((py[1] - py[2]) * (cx - px[2]) + (px[2] - px[1]) * (cy - py[2])) / d;
        const b = ((py[2] - py[0]) * (cx - px[2]) + (px[0] - px[2]) * (cy - py[2])) / d;
        const c = 1 - a - b;
        if (a < eps || b < eps || c < eps) continue;
        const v = a * tv[0] + b * tv[1] + c * tv[2];
        grid.t[r * w + q] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!(min <= max)) { min = m.range[0]; max = m.range[1]; }
  return { top, bottom, min, max };
}

/** The grid's temperature at a Gerber point (board mm), or null off the board's face. */
export function gridAt(s: SideGrid, g: GBox, x: number, y: number): number | null {
  const q = Math.floor(((x - g[0]) / (g[2] - g[0] || 1)) * s.w), r = Math.floor(((g[3] - y) / (g[3] - g[1] || 1)) * s.h);
  if (q < 0 || r < 0 || q >= s.w || r >= s.h) return null;
  const v = s.t[r * s.w + q];
  return Number.isNaN(v) ? null : v;
}
