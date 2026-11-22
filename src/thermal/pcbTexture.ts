// The board's Gerber layers under a thermal map (FRS-thermal FR-TMAP-012): where the Gerber picture lies on the
// package's board and the texture coordinate of every map point. Pure: the picture itself is drawn by pcbRaster.ts.
//
// The texture is one atlas: the top side's picture, then the bottom side's, then a white strip that every point off
// the board (the parts) maps to, so the map's colours there are untouched. Both sides are drawn as seen from above
// (Gerber bottom layers are), so a bottom face takes the same Gerber point as the top face above it.

import { swapFits } from "./copper";
import { plateAxis } from "./study";

/** Width of the white strip at the atlas's right end, in pixels. */
export const WHITE_PX = 8;

/** Where the Gerber picture lies on the package's board. */
export interface PcbFit {
  /** The board's thin axis and the other two, in order. */
  axis: number; ua: number; va: number;
  /** The picture's centre on the board (package mm, along `ua`, `va`), offset included. */
  cu: number; cv: number;
  /** Middle of the board along `axis`: points above it are on the top side (or below it when `topUp` is false). */
  mid: number;
  topUp: boolean;
  /** The Gerber X runs along `va` (the picture turned a quarter turn), since the sizes fit better that way. */
  swap: boolean;
}

/** Gerber outline box [x0, y0, x1, y1] in board mm. */
export type GBox = [number, number, number, number];

/**
 * Lays a Gerber picture of box `g` on the package's board (part 0 of `part`, triangles `tri` over points `pos`):
 * centred on the board's box, a quarter turn when the sizes fit better so, moved by (`du`, `dv`) mm.
 * `face` (1 = top, 2 = bottom per triangle) says which way is up; without it the top is towards +axis.
 * Null when the map has no board.
 */
export function pcbFit(pos: ArrayLike<number>, tri: ArrayLike<number>, part: ArrayLike<number>, g: GBox, du = 0, dv = 0, face?: ArrayLike<number>): PcbFit | null {
  const soup: number[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < part.length; k++) {
    if (part[k] !== 0) continue;
    for (let c = 0; c < 3; c++) {
      const i = tri[k * 3 + c];
      for (let a = 0; a < 3; a++) { const v = pos[i * 3 + a]; soup.push(v); if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    }
  }
  if (!soup.length) return null;
  const axis = plateAxis(soup)?.axis ?? 2;
  const ua = (axis + 1) % 3 < (axis + 2) % 3 ? (axis + 1) % 3 : (axis + 2) % 3, va = 3 - axis - ua;
  const mid = (lo[axis] + hi[axis]) / 2;
  // the package's top faces (Face 1) say which way is up
  let topUp = true;
  if (face) {
    let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
    for (let k = 0; k < part.length; k++) {
      if (part[k] !== 0 || (face[k] !== 1 && face[k] !== 2)) continue;
      let z = 0;
      for (let c = 0; c < 3; c++) z += pos[tri[k * 3 + c] * 3 + axis];
      if (face[k] === 1) { s1 += z; n1++; } else { s2 += z; n2++; }
    }
    if (n1 && n2) topUp = s1 / n1 >= s2 / n2;
  }
  const swap = swapFits([g[2] - g[0], g[3] - g[1]], [hi[ua] - lo[ua], hi[va] - lo[va]]);
  return { axis, ua, va, cu: (lo[ua] + hi[ua]) / 2 + du, cv: (lo[va] + hi[va]) / 2 + dv, mid, topUp, swap };
}

/** The Gerber point (board mm) under a package point, by the fit. */
export function gerberAt(f: PcbFit, g: GBox, p: ArrayLike<number>, o = 0): [number, number] {
  const du = p[o + f.ua] - f.cu, dv = p[o + f.va] - f.cv, gx = (g[0] + g[2]) / 2, gy = (g[1] + g[3]) / 2;
  // a quarter turn: the Gerber offset (dx, dy) lies at (−dy, dx) on the board
  return f.swap ? [gx + dv, gy - du] : [gx + du, gy + dv];
}

/**
 * The atlas coordinate (u, v; v up) of every point: board points take their Gerber point on their side's picture
 * (pictures `w` pixels wide each), the others the white strip.
 */
export function pcbUvs(pos: ArrayLike<number>, tri: ArrayLike<number>, part: ArrayLike<number>, f: PcbFit, g: GBox, w: number): { uv: Float32Array; board: number } {
  const n = pos.length / 3, uv = new Float32Array(n * 2), on = new Uint8Array(n);
  for (let k = 0; k < part.length; k++) if (part[k] === 0) for (let c = 0; c < 3; c++) on[tri[k * 3 + c]] = 1;
  const W = 2 * w + WHITE_PX, white = (2 * w + WHITE_PX / 2) / W, gw = g[2] - g[0] || 1, gh = g[3] - g[1] || 1;
  const inset = 0.5 / w;
  let board = 0;
  for (let i = 0; i < n; i++) {
    if (!on[i]) { uv[i * 2] = white; uv[i * 2 + 1] = 0.5; continue; }
    board++;
    const [x, y] = gerberAt(f, g, pos, i * 3);
    const s = Math.min(1 - inset, Math.max(inset, (x - g[0]) / gw)), t = Math.min(1, Math.max(0, (y - g[1]) / gh));
    const top = (pos[i * 3 + f.axis] >= f.mid) === f.topUp;
    uv[i * 2] = ((top ? 0 : w) + s * w) / W;
    uv[i * 2 + 1] = t;
  }
  return { uv, board };
}

/** The picture's size in pixels for a Gerber box: about `ppm` pixels per mm, each side at most `max` wide or high. */
export function pictureSize(g: GBox, ppm = 10, max = 2040): { w: number; h: number; s: number } {
  const gw = Math.max(1e-3, g[2] - g[0]), gh = Math.max(1e-3, g[3] - g[1]);
  const s = Math.min(ppm, max / gw, max / gh);
  return { w: Math.max(4, Math.round(gw * s)), h: Math.max(4, Math.round(gh * s)), s };
}
