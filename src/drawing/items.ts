// Model items (FR-DRW-020): the driving dimensions of a part's sketches and the depths of its
// blind extrudes, as 3D geometry the drawing can place in the view where each reads best.
// Hole feature data for hole callouts (FR-DRW-022). Runs in the drawing worker after a rebuild,
// so the points always follow the part.
import type { V3 } from "../kernel/drawing";
import type { Frame, HoleFeature, PartDoc, SketchFeature, SkEnt } from "../model/types";

/** A model dimension in 3D: linear between two points (along `dir`, or aligned), or radial on a circle. */
export interface ModelItem {
  /** `<feature id>:<dimension id>`, or `<extrude id>:depth`. */
  src: string;
  name: string;
  k: "lin" | "rad" | "dia";
  /** Linear: the two points. Radial: centre and a point on the circle. */
  p: [V3, V3];
  /** Linear only: the measured direction (absent: aligned). */
  dir?: V3;
  /** The plane the dimension lies in (its normal): it reads best in a view looking along it. */
  n: V3;
  /** Extrude depths read best in a view square to `n` instead. */
  side?: boolean;
  value: number;
}

/** A hole feature's centres in 3D and its drilling direction. */
export interface HoleInfo { id: string; pts: V3[]; n: V3; f: HoleFeature }

const at = (fr: Frame, x: number, y: number): V3 => [fr.o[0] + fr.x[0] * x + fr.y[0] * y, fr.o[1] + fr.x[1] * x + fr.y[1] * y, fr.o[2] + fr.x[2] * x + fr.y[2] * y];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export function modelItems(doc: PartDoc, frames: Record<string, Frame>, sketches: Record<string, SketchFeature> = {}): { items: ModelItem[]; holes: HoleInfo[] } {
  const items: ModelItem[] = [], holes: HoleInfo[] = [];
  const feats = doc.rollback != null ? doc.features.slice(0, doc.rollback + 1) : doc.features;
  for (const f0 of feats) {
    if (f0.suppressed) continue;
    const fr = frames[f0.id];
    if (f0.type === "sketch" && fr) {
      const sk = sketches[f0.id] ?? f0;
      const E = new Map<string, SkEnt>(sk.ents.map(e => [e.id, e]));
      const pt = (id: string): [number, number] | null => { const e = E.get(id); return e?.t === "point" ? [e.x, e.y] : null; };
      // A point of an entity for a distance: a point itself, or a circle's / arc's centre.
      const anchor = (id: string): [number, number] | null => { const e = E.get(id); if (!e) return null; if (e.t === "point") return [e.x, e.y]; if (e.t === "circle" || e.t === "arc" || e.t === "ellipse") return pt(e.c); return null; };
      const line = (id: string): [[number, number], [number, number]] | null => { const e = E.get(id); if (e?.t !== "line") return null; const a = pt(e.a), b = pt(e.b); return a && b ? [a, b] : null; };
      for (const d of sk.dims) {
        if (d.driven || d.ord) continue;
        const val = d.val.v;
        if (d.t === "radius" || d.t === "diameter") {
          const e = E.get(d.e[0]);
          if (!e || (e.t !== "circle" && e.t !== "arc")) continue;
          const c = pt(e.c);
          if (!c) continue;
          const r = e.t === "circle" ? e.r : (() => { const a = pt(e.a); return a ? Math.hypot(a[0] - c[0], a[1] - c[1]) : 0; })();
          if (!(r > 0)) continue;
          const ang = d.pos ? Math.atan2(d.pos[1] - c[1], d.pos[0] - c[0]) : Math.PI / 4;
          items.push({ src: `${sk.id}:${d.id}`, name: d.name, k: d.t === "radius" ? "rad" : "dia", p: [at(fr, c[0], c[1]), at(fr, c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang))], n: fr.n, value: d.t === "radius" ? r : 2 * r });
          continue;
        }
        if (d.t === "angle") continue;
        let a: [number, number] | null = null, b: [number, number] | null = null;
        if (d.e.length === 1) { const l = line(d.e[0]); if (l) [a, b] = l; }
        else {
          const p0 = anchor(d.e[0]), p1 = anchor(d.e[1]), l0 = line(d.e[0]), l1 = line(d.e[1]);
          const foot = (p: [number, number], l: [[number, number], [number, number]]): [number, number] => {
            const [u, v] = l, dx = v[0] - u[0], dy = v[1] - u[1], L2 = dx * dx + dy * dy || 1, k = ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / L2;
            return [u[0] + dx * k, u[1] + dy * k];
          };
          if (p0 && p1) { a = p0; b = p1; }
          else if (p0 && l1) { a = p0; b = d.t === "distance" ? foot(p0, l1) : l1[0]; }
          else if (l0 && p1) { a = d.t === "distance" ? foot(p1, l0) : l0[0]; b = p1; }
          else if (l0 && l1) { a = l0[0]; b = d.t === "distance" ? foot(l0[0], l1) : l1[0]; }
        }
        if (!a || !b) continue;
        // Shown as a diameter about a centreline: twice the distance, across the axis.
        if (d.dia) { if (anchor(d.e[0])) b = [2 * b[0] - a[0], 2 * b[1] - a[1]]; else a = [2 * a[0] - b[0], 2 * a[1] - b[1]]; }
        items.push({ src: `${sk.id}:${d.id}`, name: d.name, k: "lin", p: [at(fr, a[0], a[1]), at(fr, b[0], b[1])], dir: d.t === "hdistance" ? fr.x : d.t === "vdistance" ? fr.y : undefined, n: fr.n, value: val });
      }
    } else if (f0.type === "extrude" && f0.end === "blind") {
      const sk = feats.find(s => s.id === f0.sketch) as SketchFeature | undefined, sfr = sk && frames[sk.id];
      const p = sk?.ents.find(e => e.t === "point" && !e.cons) as Extract<SkEnt, { t: "point" }> | undefined;
      if (!sk || !sfr || !p) continue;
      // A cut goes into the material (against the sketch normal); flip reverses either.
      const s = (f0.op === "cut" ? -1 : 1) * (f0.flip ? -1 : 1);
      const a = at(sfr, p.x, p.y), depth = f0.depth.v;
      items.push({ src: `${f0.id}:depth`, name: `${f0.name} depth`, k: "lin", p: [a, add(a, sfr.n, s * depth)], dir: sfr.n, n: sfr.n, side: true, value: depth });
    } else if (f0.type === "hole" && fr) {
      holes.push({ id: f0.id, pts: f0.pts.map(([x, y]) => at(fr, x, y)), n: fr.n, f: f0 });
    }
  }
  return { items, holes };
}
