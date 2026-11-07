// Selection helpers on the tessellated B-rep (FR-SEL-005).
import type { EdgeInfo } from "../topology";
import type { V3 } from "./types";

/**
 * The edges joined smoothly to `seed` (FR-SEL-005): neighbours sharing an end point whose
 * directions there differ by less than 2°, followed both ways.
 */
export function tangentChain(all: EdgeInfo[], seed: EdgeInfo): EdgeInfo[] {
  const tol = 1e-4;
  const dirAt = (e: EdgeInfo, atStart: boolean): V3 | null => {
    const p = e.pts, n = p.length / 3;
    if (n < 2) return null;
    const [i, j] = atStart ? [0, 1] : [n - 1, n - 2];
    const d: V3 = [p[j * 3] - p[i * 3], p[j * 3 + 1] - p[i * 3 + 1], p[j * 3 + 2] - p[i * 3 + 2]];
    const l = Math.hypot(...d);
    if (!(l > 0)) return null;
    // Round edges: the exact tangent (a chord leans by half its angle), turned the chord's way.
    if (e.center && e.axis && (e.type === "arc" || e.type === "circle")) {
      const q = atStart ? e.start : e.end, a = e.axis, c = e.center;
      const r: V3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
      const tg: V3 = [a[1] * r[2] - a[2] * r[1], a[2] * r[0] - a[0] * r[2], a[0] * r[1] - a[1] * r[0]];
      const tl = Math.hypot(...tg);
      if (tl > 0) { const sg = tg[0] * d[0] + tg[1] * d[1] + tg[2] * d[2] < 0 ? -1 : 1; return [(sg * tg[0]) / tl, (sg * tg[1]) / tl, (sg * tg[2]) / tl]; }
    }
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol * Math.max(1, Math.hypot(...a));
  const out = new Set<EdgeInfo>([seed]);
  const todo = [seed];
  while (todo.length) {
    const e = todo.pop()!;
    if (e.closed) continue;
    for (const atStart of [true, false]) {
      const p = atStart ? e.start : e.end, d = dirAt(e, atStart);
      if (!d) continue;
      for (const o of all) {
        if (out.has(o) || o.closed || o.faces[0] === o.faces[1]) continue;
        const os = near(o.start, p), oe = near(o.end, p);
        if (!os && !oe) continue;
        const od = dirAt(o, os);
        // Leaving p along e is the reverse of arriving along o: tangent when they point opposite ways.
        if (od && d[0] * od[0] + d[1] * od[1] + d[2] * od[2] < -Math.cos((2 * Math.PI) / 180)) { out.add(o); todo.push(o); }
      }
    }
  }
  return [...out];
}
