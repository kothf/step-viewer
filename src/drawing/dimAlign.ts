import type { DimAnnot } from "./types";

/** The axis a dimension's line is held on: horizontal ones by their height (v), vertical ones by their u. */
const axisOf = (d: DimAnnot): 0 | 1 | null => (d.k === "h" ? 1 : d.k === "v" ? 0 : null);

/**
 * Align (gap list D2): puts `dst`'s dimension line on `src`'s, so two horizontal (or two vertical) dimensions of one
 * view run in one line. False when they are not both horizontal or both vertical on the same view, or already lined up.
 */
export function alignDim(src: DimAnnot, dst: DimAnnot): boolean {
  const a = axisOf(src);
  if (a == null || axisOf(dst) !== a || src.view !== dst.view || src.id === dst.id) return false;
  if (Math.abs(dst.pos[a] - src.pos[a]) < 1e-9) return false;
  dst.pos[a] = src.pos[a];
  return true;
}

/**
 * Space evenly (gap list D2): the horizontal dimensions above and below a view and the vertical ones left and right
 * of it are put in rows `first` sheet mm off the view's outline and `gap` sheet mm apart, in the order they stand now
 * (nearest the view first), as other CAD apps' Auto Arrange does. `box` = the view's outline in its own axes, `s` its
 * scale. Dimensions on the view itself are left alone. Returns the ids moved.
 */
export function spaceDims(dims: DimAnnot[], box: [number, number, number, number], s: number, first = 10, gap = 8): string[] {
  const moved: string[] = [];
  const f = first / s, g = gap / s;
  for (const a of [0, 1] as const) {
    const lo = box[a], hi = box[a + 2];
    const mine = dims.filter(d => axisOf(d) === a);
    const after = mine.filter(d => d.pos[a] > hi).sort((x, y) => x.pos[a] - y.pos[a]);
    const before = mine.filter(d => d.pos[a] < lo).sort((x, y) => y.pos[a] - x.pos[a]);
    after.forEach((d, i) => { const v = hi + f + i * g; if (Math.abs(d.pos[a] - v) > 1e-9) { d.pos[a] = v; moved.push(d.id); } });
    before.forEach((d, i) => { const v = lo - f - i * g; if (Math.abs(d.pos[a] - v) > 1e-9) { d.pos[a] = v; moved.push(d.id); } });
  }
  return moved;
}
