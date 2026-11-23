// Stand-in bodies for package parts the board's STEP does not have (a bare board STEP, such as the one MöbiusCAD
// writes from a Gerber set): each part becomes a block or a cylinder of its package box, standing where the package
// says, so its heat, its air cooling and its temperature can still be worked out. Pure.
import { newPart } from "../model/doc";
import type { PartDoc, SketchFeature, Feature } from "../model/types";
import type { Tf } from "../asm/types";
import type { Box } from "./match";
import type { ThermalPart } from "./package";

export interface StandIn {
  /** Package part id. */
  id: number;
  name: string;
  /** The part's box on the model (the package box moved by the match's shift). */
  box: Box;
  round: boolean;
}

/** Parts that stand on their own footprint and look round from above are drawn as cylinders. */
export function looksRound(p: Pick<ThermalPart, "designator" | "part" | "mount">, box: Box): boolean {
  const w = box[3] - box[0], l = box[4] - box[1];
  if (!(w > 0 && l > 0) || Math.abs(w - l) > 0.12 * Math.max(w, l)) return false;
  const text = `${p.part ?? ""} ${p.mount ?? ""}`.toLowerCase();
  if (/socket|standing|radial|tube|valve|can\b/.test(text)) return true;
  return /^(v|vt|c)\d/i.test(p.designator ?? "") && /\d\s*(u|µ|n)f?\b|el\d\d|ecc\d\d|\d+u\b/i.test(text);
}

/** Stand-ins for the parts that no body was found for and whose box the package (or its mesh) gives. */
export function standIns(parts: ThermalPart[], missing: number[], boxOf: (id: number) => Box | null, shift: [number, number, number]): StandIn[] {
  const out: StandIn[] = [];
  const lost = new Set(missing);
  for (const p of parts) {
    if (p.id === 0 || !lost.has(p.id)) continue;
    const b = boxOf(p.id);
    if (!b || !(b[3] - b[0] > 0.05 && b[4] - b[1] > 0.05 && b[5] - b[2] > 0.05)) continue;
    const box: Box = [b[0] + shift[0], b[1] + shift[1], b[2] + shift[2], b[3] + shift[0], b[4] + shift[1], b[5] + shift[2]];
    out.push({ id: p.id, name: p.designator || `#${p.id}`, box, round: looksRound(p, b) });
  }
  return out;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * A part document for a stand-in: a rectangle (or a circle) on XY centred on the origin, extruded up by the box's
 * height; `tf` puts it at the box. Numbers are rounded to 1e-6 mm.
 */
export function standInPart(s: StandIn): { doc: PartDoc; tf: Tf } {
  const [x0, y0, z0, x1, y1, z1] = s.box, w = r6(x1 - x0), l = r6(y1 - y0), h = r6(z1 - z0);
  const doc = newPart(s.name);
  const sk: SketchFeature = { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [{ id: "o", t: "point", x: 0, y: 0 }], rels: [{ id: "fo", t: "fix", e: ["o"] }], dims: [] };
  if (s.round) {
    const d = r6(Math.min(w, l));
    sk.ents.push({ id: "c", t: "circle", c: "o", r: d / 2 });
    sk.dims.push({ id: "dc", name: "D1@Sketch1", t: "diameter", e: ["c"], val: { v: d } });
  } else {
    const c = [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]];
    c.forEach(([x, y], i) => sk.ents.push({ id: `r${i}`, t: "point", x, y }));
    for (let i = 0; i < 4; i++) sk.ents.push({ id: `rl${i}`, t: "line", a: `r${i}`, b: `r${(i + 1) % 4}` });
    sk.ents.push({ id: "rd", t: "line", a: "r0", b: "r2", cons: true });
    sk.rels.push({ id: "h0", t: "horizontal", e: ["rl0"] }, { id: "v1", t: "vertical", e: ["rl1"] }, { id: "h2", t: "horizontal", e: ["rl2"] }, { id: "v3", t: "vertical", e: ["rl3"] }, { id: "mid", t: "midpoint", e: ["o", "rd"] });
    sk.dims.push({ id: "dx", name: "D1@Sketch1", t: "hdistance", e: ["r0", "r1"], val: { v: w } }, { id: "dy", name: "D2@Sketch1", t: "vdistance", e: ["r1", "r2"], val: { v: l } });
  }
  const ext = { id: "e1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: h } } as Feature;
  doc.features.push(sk, ext);
  doc.props = { ...(doc.props ?? {}), description: "Stand-in from the thermal package box" };
  return { doc, tf: [1, 0, 0, r6((x0 + x1) / 2), 0, 1, 0, r6((y0 + y1) / 2), 0, 0, 1, r6(z0)] };
}
