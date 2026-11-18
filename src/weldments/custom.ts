// Custom weldment profiles (FR-FT-121): a closed 2D sketch used as a member's cross-section.
// The sketch's largest region becomes the outline and its holes the holes; lines, arcs and circles
// stay exact, ellipses and splines are followed by short lines. The box is centred like the library
// profiles, and `origin` keeps where the sketch origin went (the default pierce point).
import type { SketchFeature, V2 } from "../model/types";
import { loopPolygon, polyArea, sketchProfile, type Seg } from "../sketch/profile";
import { outline, type Loop, type LoopSeg, type ProfileShape } from "./profiles";

const norm = (x: number) => { while (x <= 0) x += 2 * Math.PI; while (x > 2 * Math.PI) x -= 2 * Math.PI; return x; };
const onCircle = (c: V2, r: number, a: number): V2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** A sketch curve of a region loop as profile lines and arcs, in the loop's direction of travel. */
function segsOf(s: Seg): LoopSeg[] {
  if (s.kind === "line") return [{ kind: "line", a: s.a, b: s.b }];
  if (s.kind === "circle") {
    const { c, r } = s;
    return [
      { kind: "arc", a: onCircle(c, r, 0), m: onCircle(c, r, Math.PI / 2), b: onCircle(c, r, Math.PI), c, r },
      { kind: "arc", a: onCircle(c, r, Math.PI), m: onCircle(c, r, 1.5 * Math.PI), b: onCircle(c, r, 0), c, r },
    ];
  }
  if (s.kind === "arc") {
    const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
    const sweep = s.ccw ? norm(a1 - a0) : -norm(a0 - a1);
    return [{ kind: "arc", a: s.a, m: onCircle(s.c, s.r, a0 + sweep / 2), b: s.b, c: s.c, r: s.r }];
  }
  // Ellipses and splines: a polyline through points along the curve.
  const pts = loopPolygon([s], 32);
  const end: V2 = s.kind === "spline" ? s.bz[s.bz.length - 1] : s.kind === "earc" ? s.b : pts[0];
  pts.push(end);
  const out: LoopSeg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > 1e-9) out.push({ kind: "line", a: pts[i], b: pts[i + 1] });
  return out;
}

const reverse = (segs: LoopSeg[]): LoopSeg[] => segs.slice().reverse().map(s => (s.kind === "line" ? { kind: "line", a: s.b, b: s.a } : { ...s, a: s.b, b: s.a }));
const shift = (segs: LoopSeg[], d: V2): LoopSeg[] => segs.map(s => {
  const m = (p: V2): V2 => [p[0] - d[0], p[1] - d[1]];
  return s.kind === "line" ? { kind: "line", a: m(s.a), b: m(s.b) } : { ...s, a: m(s.a), m: m(s.m), b: m(s.b), c: m(s.c) };
});

/** A closed 2D sketch as a member profile, or why it can't be one (an English message key). */
export function sketchShape(sk: SketchFeature): ProfileShape | { error: string } {
  const pr = sketchProfile(sk);
  if (!pr.faces.length) return { error: pr.error?.message ?? "The profile sketch has no closed region." };
  // The largest region is the profile (a sketch may also hold reference geometry).
  const face = pr.faces.map(f => ({ f, a: Math.abs(polyArea(loopPolygon(f.outer))) })).sort((p, q) => q.a - p.a)[0].f;
  // Every loop counter-clockwise: the kernel reverses the holes so they cut the outline.
  const ccw = (segs: LoopSeg[]) => (polyArea(outline({ segs }, 8)) < 0 ? reverse(segs) : segs);
  const outer = ccw(face.outer.flatMap(segsOf)), holes = face.holes.map(h => ccw(h.flatMap(segsOf)));
  const pts = outline({ segs: outer }, 32);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const c: V2 = [(x0 + x1) / 2, (y0 + y1) / 2];
  const loop = (segs: LoopSeg[]): Loop => ({ segs: shift(segs, c) });
  // Every sketch point, for Locate profile (a point id as the pierce point).
  const points: Record<string, V2> = {};
  for (const e of sk.ents) if (e.t === "point") points[e.id] = [e.x - c[0], e.y - c[1]];
  return { outer: loop(outer), holes: holes.map(loop), w: x1 - x0, h: y1 - y0, origin: [-c[0], -c[1]], points };
}
