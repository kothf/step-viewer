// Drawing compare (FR-PDM-051): two versions' sheet primitives split into unchanged, removed and added.
import { svgBody } from "./output";
import type { Prim } from "./prims";
import type { SheetPrims } from "./render";

/** A primitive's identity for the compare: its kind and coordinates to 0.01 mm (text by content too). */
function primKey(p: Prim): string {
  const r = (v: number) => Math.round(v * 100);
  if (p.t === "l") {
    const a = [r(p.p[0]), r(p.p[1])], b = [r(p.p[2]), r(p.p[3])];
    const [u, w] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    return `l${p.pen}${u}|${w}`;
  }
  if (p.t === "a") return `a${p.pen}${r(p.o[0])},${r(p.o[1])},${r(p.r)},${Math.round(p.a0 * 1000)},${Math.round(p.a1 * 1000)}`;
  if (p.t === "p") return `p${p.pen}${p.fill ? "f" : ""}${p.p.map(r).join(",")}`;
  if (p.t === "i") return `i${r(p.x)},${r(p.y)},${r(p.w)},${r(p.h)}:${p.src.length}:${p.src.slice(-32)}`;
  return `t${r(p.x)},${r(p.y)},${r(p.h)},${p.al},${Math.round(p.rot ?? 0)}:${p.s}`;
}

/** Splits two primitive lists into what both have, what only the old one has and what only the new one has. */
export function diffPrims(a: Prim[], b: Prim[]): { same: Prim[]; removed: Prim[]; added: Prim[] } {
  const count = new Map<string, number>();
  for (const p of a) { const k = primKey(p); count.set(k, (count.get(k) ?? 0) + 1); }
  const same: Prim[] = [], added: Prim[] = [];
  for (const p of b) {
    const k = primKey(p), n = count.get(k) ?? 0;
    if (n > 0) { same.push(p); count.set(k, n - 1); } else added.push(p);
  }
  const removed: Prim[] = [];
  for (const p of a) { const k = primKey(p), n = count.get(k) ?? 0; if (n > 0) { removed.push(p); count.set(k, n - 1); } }
  return { same, removed, added };
}

export const DIFF_OLD = "#d32f2f", DIFF_NEW = "#1b8a3a";

/** One sheet's overlay as an SVG: unchanged lines grey, removed red, added green. */
export function overlaySvg(a: SheetPrims | undefined, b: SheetPrims | undefined): { svg: string; removed: number; added: number } {
  const W = Math.max(a?.W ?? 0, b?.W ?? 0), H = Math.max(a?.H ?? 0, b?.H ?? 0);
  const d = diffPrims(a?.prims ?? [], b?.prims ?? []);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif" stroke-linecap="round" role="img"><rect width="${W}" height="${H}" fill="#fff"/><g opacity="0.45">${svgBody(d.same, H, "#555")}</g><g>${svgBody(d.removed, H, DIFF_OLD)}</g><g>${svgBody(d.added, H, DIFF_NEW)}</g></svg>`;
  return { svg, removed: d.removed.length, added: d.added.length };
}
