// Reads a board's Gerber set into a copper map (FRS-thermal FR-TBRD-020): each copper layer drawn into a canvas in
// board millimetres and averaged per cell, the drill files' plated holes counted. Browser only (Path2D, canvas).

import { buildLayer, centerlineBox } from "../gerber/build";
import { loadPcbFiles } from "../gerber/load";
import type { ParsedLayer } from "../gerber/model";
import { b64, cellMeans, copperOrder, gridFor, viaBytes, viaShare, type CopperMap, type DrillHole } from "./copper";

/** Most pixels drawn per layer. */
const MAX_PIXELS = 16e6;

/** The copper map of a Gerber set (files or zips of them). Throws E-TH-GERBER when it has no copper layer. */
export async function copperFromGerber(files: { name: string; data: ArrayBuffer }[], name: string): Promise<CopperMap> {
  const { layers } = await loadPcbFiles(files);
  const copper = copperOrder(layers);
  if (!copper.length) throw new Error("E-TH-GERBER");
  const built = copper.map(buildLayer);
  const outline = layers.find(l => l.kind === "outline");
  let box: [number, number, number, number];
  const cut = outline ? centerlineBox(outline.objs) : null;
  if (cut) box = cut;
  else { box = [Infinity, Infinity, -Infinity, -Infinity]; for (const b of built) { box[0] = Math.min(box[0], b.bbox[0]); box[1] = Math.min(box[1], b.bbox[1]); box[2] = Math.max(box[2], b.bbox[2]); box[3] = Math.max(box[3], b.bbox[3]); } }
  const g = gridFor(box), x0 = box[0], y0 = box[1];
  const px = Math.max(1, Math.min(8, Math.floor(Math.sqrt(MAX_PIXELS / (g.nu * g.nv)))));
  const W = g.nu * px, H = g.nv * px, s = px / g.cell, y1 = y0 + g.nv * g.cell;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext("2d", { willReadFrequently: true })!;
  const cov: string[] = [], means: number[] = [];
  for (const L of built) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    // board mm with Y up into canvas pixels with Y down
    c.setTransform(s, 0, 0, -s, -x0 * s, y1 * s);
    c.fillStyle = "#fff";
    for (const b of L.batches) {
      c.globalCompositeOperation = b.dark ? "source-over" : "destination-out";
      for (const d of b.fill) c.fill(new Path2D(d));
      if (b.eo.length) c.fill(new Path2D(b.eo.join("")), "evenodd");
    }
    c.globalCompositeOperation = "source-over";
    const top = cellMeans(c.getImageData(0, 0, W, H).data, g.nu, g.nv, px);
    // rows from y0 upwards
    const rows = new Uint8Array(top.length);
    for (let j = 0; j < g.nv; j++) rows.set(top.subarray((g.nv - 1 - j) * g.nu, (g.nv - j) * g.nu), j * g.nu);
    cov.push(b64(rows));
    let sum = 0;
    for (const v of rows) sum += v;
    means.push(sum / (255 * rows.length));
  }
  const holes: DrillHole[] = [];
  for (const L of layers as ParsedLayer[]) {
    if (L.kind !== "drill") continue;
    const np = /NPTH/.test(L.label);
    for (const o of L.objs) {
      if (o.t === "hole") holes.push({ x1: o.x, y1: o.y, x2: o.x, y2: o.y, d: o.d, plated: np ? false : o.plated });
      else if (o.t === "slot") holes.push({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, d: o.d, plated: np ? false : o.plated });
    }
  }
  const share = viaShare(holes, { x0, y0, ...g });
  return { name, x0, y0, ...g, cov, vias: b64(viaBytes(share)), labels: copper.map(l => l.label), means, holes: holes.filter(h => h.plated !== false).length };
}
