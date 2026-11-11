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

/**
 * A selection area on the screen: a box, or a lasso (FR-SEL-008 P2) = a closed freehand polygon. `box` bounds it;
 * `has` tells a point inside; `touches` a segment that meets it.
 */
export interface Region { box: Rect; has(x: number, y: number): boolean; touches(ax: number, ay: number, bx: number, by: number): boolean }

export const rectRegion = (r: Rect): Region => ({ box: r, has: (x, y) => inRect(r, x, y), touches: (ax, ay, bx, by) => segTouches(r, ax, ay, bx, by) });

/** Is the point inside the closed polygon `pts` (flat x, y pairs)? Even-odd rule. */
export function pointInPoly(pts: ArrayLike<number>, x: number, y: number): boolean {
  let on = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}

/** Do the segments a-b and c-d cross or touch? */
export function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by), d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  if (d1 !== d2 && d3 !== d4) return true;
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  return (d1 === 0 && on(cx, cy, dx, dy, ax, ay)) || (d2 === 0 && on(cx, cy, dx, dy, bx, by)) || (d3 === 0 && on(ax, ay, bx, by, cx, cy)) || (d4 === 0 && on(ax, ay, bx, by, dx, dy));
}

/** A lasso through screen points (closed back to the first). */
export function lassoRegion(pts: ArrayLike<number>): Region {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) { xs.push(pts[i]); ys.push(pts[i + 1]); }
  const box: Rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const n = xs.length;
  const has = (x: number, y: number) => inRect(box, x, y) && pointInPoly(pts, x, y);
  return {
    box, has,
    touches: (ax, ay, bx, by) => {
      if (has(ax, ay) || has(bx, by)) return true;
      if (!segTouches(box, ax, ay, bx, by)) return false;
      for (let i = 0, j = n - 1; i < n; j = i++) if (segsCross(ax, ay, bx, by, xs[j], ys[j], xs[i], ys[i])) return true;
      return false;
    },
  };
}

/** A lasso drawn clockwise on the screen (y down) selects what lies wholly inside; anticlockwise, what it touches. */
export function isClockwise(pts: ArrayLike<number>): boolean {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return a >= 0;
}

/** Every point of a polyline inside the area. */
export function regionInside(R: Region, pts: ArrayLike<number>): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i + 1 < pts.length; i += 2) if (!R.has(pts[i], pts[i + 1])) return false;
  return true;
}

/** Any piece of a polyline touching the area. */
export function regionTouches(R: Region, pts: ArrayLike<number>): boolean {
  if (pts.length === 2) return R.has(pts[0], pts[1]);
  for (let i = 0; i + 3 < pts.length; i += 2) if (R.touches(pts[i], pts[i + 1], pts[i + 2], pts[i + 3])) return true;
  return false;
}

export const regionTaken = (R: Region, pts: ArrayLike<number>, crossing: boolean) => crossing ? regionTouches(R, pts) : regionInside(R, pts);

/** The probe grid of the area's box, kept to the points inside it. */
export const regionProbe = (R: Region, max = 3000, minStep = 4) => probeGrid(R.box, max, minStep).filter(([x, y]) => R.has(x, y));

/** Lasso mode (FR-SEL-008 P2): a left drag from empty space draws a lasso instead of a box. Kept per browser. */
export function lassoMode(): boolean {
  try { return localStorage.getItem("mc:lasso") === "1"; } catch { return false; }
}
export function setLassoMode(on: boolean) {
  try { if (on) localStorage.setItem("mc:lasso", "1"); else localStorage.removeItem("mc:lasso"); } catch { /* storage off */ }
}
