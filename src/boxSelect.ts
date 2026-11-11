// Box selection in parts (FR-SEL-008): which screen-projected faces and edges a dragged box takes.
// Left to right ("window") takes what lies wholly inside; right to left ("crossing") also what the box touches.
// Pure: points are screen pixels, a polyline is a flat [x0, y0, x1, y1, ...] array.

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** The box between two corners, whatever way it was dragged. */
export function rectOf(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** A box dragged from right to left selects by crossing (SolidWorks). */
export const isCrossing = (startX: number, endX: number) => endX < startX;

export const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Does the segment a-b touch the box (an end inside, or it crosses a side)? */
export function segTouches(r: Rect, ax: number, ay: number, bx: number, by: number): boolean {
  if (inRect(r, ax, ay) || inRect(r, bx, by)) return true;
  // Liang-Barsky clip of the segment against the box.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const edges: [number, number][] = [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}

/** Every point of a polyline inside the box. */
export function polyInside(r: Rect, pts: ArrayLike<number>): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i + 1 < pts.length; i += 2) if (!inRect(r, pts[i], pts[i + 1])) return false;
  return true;
}

/** Any piece of a polyline touching the box. */
export function polyTouches(r: Rect, pts: ArrayLike<number>): boolean {
  if (pts.length === 2) return inRect(r, pts[0], pts[1]);
  for (let i = 0; i + 3 < pts.length; i += 2) if (segTouches(r, pts[i], pts[i + 1], pts[i + 2], pts[i + 3])) return true;
  return false;
}

/** Window: wholly inside; crossing: touching. */
export const polyTaken = (r: Rect, pts: ArrayLike<number>, crossing: boolean) => crossing ? polyTouches(r, pts) : polyInside(r, pts);

/**
 * Screen points to probe for what is seen inside the box: a grid of about `max` points, at least every `minStep`
 * pixels, centred in the box.
 */
export function probeGrid(r: Rect, max = 3000, minStep = 4): [number, number][] {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const step = Math.max(minStep, Math.sqrt((w * h) / max));
  const nx = Math.max(1, Math.floor(w / step) + 1), ny = Math.max(1, Math.floor(h / step) + 1);
  const ox = r.x0 + (w - (nx - 1) * step) / 2, oy = r.y0 + (h - (ny - 1) * step) / 2;
  const out: [number, number][] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push([ox + i * step, oy + j * step]);
  return out;
}

/** The new selection: the boxed items, or (Ctrl) the old ones plus those not in yet. */
export function mergeSel<T>(old: T[], boxed: T[], add: boolean): T[] {
  if (!add) return [...boxed];
  const out = [...old];
  for (const b of boxed) if (!out.includes(b)) out.push(b);
  return out;
}
