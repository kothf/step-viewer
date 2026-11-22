// Draws a board's Gerber set as two light pictures, one per side (FRS-thermal FR-TMAP-012): the board, copper,
// silkscreen and drilled holes, in tones meant to be multiplied with the thermal colours, so tracks and silkscreen
// stay readable on the map. Browser only (Path2D, canvas).

import { buildLayer, centerlineBox, type BuiltLayer } from "../gerber/build";
import { loadPcbFiles } from "../gerber/load";
import type { ParsedLayer } from "../gerber/model";
import { pictureSize, type GBox } from "./pcbTexture";

/** Tones of the picture (multiplied with the map's colours). */
const TONE = { board: "rgb(150,158,150)", copper: "rgb(226,212,178)", silk: "rgb(255,255,255)", hole: "rgb(55,55,55)" };

/** A board's Gerber set drawn for the map. */
export interface PcbLayers {
  name: string;
  /** Outline box (or the layers' box), board mm. */
  box: GBox;
  /** One picture per side, `w` × `h` pixels, top edge = the box's top. */
  top: HTMLCanvasElement;
  bottom: HTMLCanvasElement;
  w: number; h: number;
  /** The layers drawn, by their labels. */
  labels: string[];
}

/** Draws a Gerber set (files or zips of them). Throws E-TH-GERBER when it has no copper or silkscreen layer. */
export async function pcbFromGerber(files: { name: string; data: ArrayBuffer }[], name: string): Promise<PcbLayers> {
  const { layers } = await loadPcbFiles(files);
  const used = layers.filter(l => (l.kind === "copper" || l.kind === "silk") && (l.side === "top" || l.side === "bottom"));
  if (!used.length) throw new Error("E-TH-GERBER");
  const built = new Map<ParsedLayer, BuiltLayer>(used.map(l => [l, buildLayer(l)]));
  const outline = layers.find(l => l.kind === "outline");
  let box: GBox | null = outline ? centerlineBox(outline.objs) : null;
  if (!box) {
    box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of built.values()) { box[0] = Math.min(box[0], b.bbox[0]); box[1] = Math.min(box[1], b.bbox[1]); box[2] = Math.max(box[2], b.bbox[2]); box[3] = Math.max(box[3], b.bbox[3]); }
  }
  const { w, h, s } = pictureSize(box);
  const holes = layers.filter(l => l.kind === "drill");
  const side = (which: "top" | "bottom") => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d")!;
    c.fillStyle = TONE.board;
    c.fillRect(0, 0, w, h);
    // board mm with Y up into pixels with Y down
    c.setTransform(s, 0, 0, -s, -box![0] * s, box![3] * s);
    for (const kind of ["copper", "silk"] as const) {
      const L = used.find(l => l.kind === kind && l.side === which);
      if (!L) continue;
      // each layer on its own canvas first, so clear (negative) objects cut only that layer
      const lc = document.createElement("canvas");
      lc.width = w; lc.height = h;
      const x = lc.getContext("2d")!;
      x.setTransform(s, 0, 0, -s, -box![0] * s, box![3] * s);
      x.fillStyle = x.strokeStyle = TONE[kind];
      x.lineWidth = 0.15;
      for (const b of built.get(L)!.batches) {
        x.globalCompositeOperation = b.dark ? "source-over" : "destination-out";
        for (const d of b.fill) x.fill(new Path2D(d));
        if (b.eo.length) x.fill(new Path2D(b.eo.join("")), "evenodd");
        if (b.hair) x.stroke(new Path2D(b.hair));
      }
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(lc, 0, 0);
      c.restore();
    }
    c.fillStyle = TONE.hole;
    for (const L of holes) for (const o of L.objs) {
      if (o.t === "hole") { c.beginPath(); c.arc(o.x, o.y, o.d / 2, 0, 2 * Math.PI); c.fill(); }
      else if (o.t === "slot") { c.beginPath(); c.lineCap = "round"; c.lineWidth = o.d; c.strokeStyle = TONE.hole; c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke(); }
    }
    return cv;
  };
  return { name, box, top: side("top"), bottom: side("bottom"), w, h, labels: used.map(l => l.label) };
}

/** The atlas for the map: white, then each side's picture at `mix` (0 = none, 1 = full), then the white strip. */
export function pcbAtlas(p: PcbLayers, mix: number, white: number, into?: HTMLCanvasElement): HTMLCanvasElement {
  const cv = into ?? document.createElement("canvas");
  cv.width = 2 * p.w + white; cv.height = p.h;
  const c = cv.getContext("2d")!;
  c.globalAlpha = 1;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  c.globalAlpha = Math.max(0, Math.min(1, mix));
  c.drawImage(p.top, 0, 0);
  c.drawImage(p.bottom, p.w, 0);
  c.globalAlpha = 1;
  return cv;
}
