// Assembly drawings (FR-DRW-030): the bill of materials of the assembly shown, balloons on its
// components and auto-balloon. A component is told by the face names of its edges, which the
// drawing worker gives as `<component id>@<face name>`.
import type { MEdge, Projection, Topo, V3 } from "../kernel/drawing";
import type { AsmDoc } from "../asm/types";
import type { Prim } from "./prims";
import type { BalloonAnnot, DrawingView, Sheet } from "./types";

type P2 = [number, number];
type Box = [number, number, number, number];

export interface BomRow { key: string; item: number; part: string; description: string; qty: number; comp: string }
export interface Bom { mode: BomMode; rows: BomRow[]; itemOf(comp: string): number | null }
/** FR-ASM-024: "top" lists sub-assemblies as one row; "parts" lists every part inside them. */
export type BomMode = "top" | "parts";

/** Default BOM columns (English keys; the sheet shows them in the interface language). */
export const BOM_COLS = ["Item", "Part number", "Description", "Qty"];

/** The component an edge key belongs to (`<comp>@<face>|<comp>@<face>`), or null. */
export function compOfKey(k: string): string | null {
  const i = k.indexOf("@");
  return i > 0 ? k.slice(0, i) : null;
}

/** The BOM mode a sheet's balloons and parts list follow: that of its BOM table, else top level. */
export function bomMode(sheet: Sheet): BomMode {
  const t = (sheet.annots ?? []).find(a => a.t === "table" && a.kind === "bom");
  return t && t.t === "table" && t.mode === "parts" ? "parts" : "top";
}

/**
 * The BOM (FR-ASM-024). "top": one row per part or sub-assembly in the order first used, counting
 * pattern instances; a sub-assembly's parts count as the sub-assembly. "parts": one row per part,
 * wherever it is used (the same part document at the top and inside sub-assemblies is one row).
 */
export function bomOf(top: AsmDoc, flat: AsmDoc, mode: BomMode = "top"): Bom {
  return mode === "parts" ? partsBom(flat) : topBom(top, flat);
}

function topBom(top: AsmDoc, flat: AsmDoc): Bom {
  const byId = new Map(top.components.map(c => [c.id, c]));
  // Pattern instances are `<pattern>~<seed>~<k>`; sub-assembly children `<top>/<child>`.
  const keyOf = (id: string): string | null => {
    const t = id.split("/")[0], seed = t.includes("~") ? t.split("~")[1] : t;
    return byId.get(t)?.part ?? byId.get(seed)?.part ?? null;
  };
  const tops = new Map<string, string>();
  for (const c of flat.components) {
    if (c.suppressed) continue;
    const t = c.id.split("/")[0], k = keyOf(c.id);
    if (k && !tops.has(t)) tops.set(t, k);
  }
  const rows: BomRow[] = [], at = new Map<string, number>();
  const order = [...top.components.filter(c => !c.suppressed).map(c => c.part), ...tops.values()];
  for (const k of order) {
    if (at.has(k)) continue;
    const p = top.parts[k];
    if (!p) continue;
    const d = p.asm ? null : p.doc;
    at.set(k, rows.length);
    rows.push({ key: k, item: rows.length + 1, part: d?.props?.partNumber || p.name, description: d?.props?.description ?? "", qty: 0, comp: "" });
  }
  for (const [t, k] of tops) { const i = at.get(k); if (i !== undefined) { rows[i].qty++; if (!rows[i].comp) rows[i].comp = firstShown(flat, t); } }
  return finish("top", rows, keyOf);
}

/** The first unsuppressed flat component of top-level component `t` (itself, or a child of a sub-assembly). */
function firstShown(flat: AsmDoc, t: string): string {
  return flat.components.find(c => !c.suppressed && (c.id === t || c.id.startsWith(`${t}/`)))?.id ?? t;
}

function partsBom(flat: AsmDoc): Bom {
  const same = new Map<string, string>();
  const group = (k: string) => {
    let g = same.get(k);
    if (g === undefined) { const p = flat.parts[k]; g = p ? JSON.stringify(p.doc) : k; same.set(k, g); }
    return g;
  };
  const partOf = new Map(flat.components.map(c => [c.id, c.part]));
  const rows: BomRow[] = [], at = new Map<string, number>();
  for (const c of flat.components) {
    if (c.suppressed) continue;
    const p = flat.parts[c.part];
    if (!p || p.asm) continue;
    const g = group(c.part);
    let i = at.get(g);
    if (i === undefined) {
      i = rows.length;
      at.set(g, i);
      rows.push({ key: g, item: i + 1, part: p.doc.props?.partNumber || p.name, description: p.doc.props?.description ?? "", qty: 0, comp: c.id });
    }
    rows[i].qty++;
  }
  return finish("parts", rows, id => { const k = partOf.get(id); return k ? group(k) : null; });
}

function finish(mode: BomMode, rows: BomRow[], keyOf: (comp: string) => string | null): Bom {
  const items = new Map<string, number>();
  return {
    mode,
    rows: rows.filter(r => r.qty > 0).map((r, i) => (items.set(r.key, i + 1), { ...r, item: i + 1 })),
    itemOf: comp => { const k = keyOf(comp); return k ? items.get(k) ?? null : null; },
  };
}

/** The BOM as table cells, in the order of `BOM_COLS`. */
export const bomCells = (b: Bom): string[][] => b.rows.map(r => [String(r.item), r.part, r.description, String(r.qty)]);

/**
 * A balloon: a Ø10 circle with the item number, a leader to `tip` ending in a dot on the part.
 * `more` are stacked balloons: circles touching it downwards, sharing its leader.
 */
export function balloonPrims(at: P2, tip: P2 | null, text: string, more: string[] = []): { prims: Prim[]; box: Box } {
  const R = 5, out: Prim[] = [];
  [text, ...more].forEach((s, i) => {
    const o: P2 = [at[0], at[1] - 2 * R * i];
    out.push({ t: "a", o, r: R, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
    out.push({ t: "t", x: o[0], y: o[1] - (s.length > 2 ? 1.25 : 1.75) + 0.2, s, h: s.length > 2 ? 3.5 : 5, al: "c", layer: "ANNOT" });
  });
  if (tip) {
    // The leader leaves the circle of the stack nearest the tip (the top one or the bottom one).
    const o: P2 = more.length && tip[1] < at[1] - R * more.length ? [at[0], at[1] - 2 * R * more.length] : at;
    const d = Math.hypot(tip[0] - o[0], tip[1] - o[1]);
    if (d > R + 0.5) {
      const u: P2 = [(tip[0] - o[0]) / d, (tip[1] - o[1]) / d];
      out.push({ t: "l", p: [o[0] + u[0] * R, o[1] + u[1] * R, tip[0], tip[1]], pen: "thin", layer: "ANNOT" });
      const dot: number[] = [];
      for (let i = 0; i < 8; i++) dot.push(tip[0] + 0.6 * Math.cos(i * Math.PI / 4), tip[1] + 0.6 * Math.sin(i * Math.PI / 4));
      out.push({ t: "p", p: dot, pen: "thin", layer: "ANNOT", fill: true, closed: true });
    }
  }
  return { prims: out, box: [at[0] - R, at[1] - R - 2 * R * more.length, at[0] + R, at[1] + R] };
}

/** Is the 2D point on a visible line of the projection (within `tol`)? */
export function onVisible(proj: Projection, q: P2, tol: number): boolean {
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
    const k = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - x0) * dx + (q[1] - y0) * dy) / L2)) : 0;
    return Math.hypot(x0 + dx * k - q[0], y0 + dy * k - q[1]) <= tol;
  };
  for (const s of proj.vis) {
    if (s.k === "l" && seg(...s.p)) return true;
    if (s.k === "a") {
      const d = Math.hypot(q[0] - s.o[0], q[1] - s.o[1]);
      if (Math.abs(d - s.r) > tol) continue;
      let a = Math.atan2(q[1] - s.o[1], q[0] - s.o[0]);
      while (a < s.a0) a += 2 * Math.PI;
      if (a <= s.a1 + tol / Math.max(s.r, 1e-9)) return true;
    }
    if (s.k === "p") for (let i = 0; i + 3 < s.p.length; i += 2) if (seg(s.p[i], s.p[i + 1], s.p[i + 2], s.p[i + 3])) return true;
  }
  return false;
}

/**
 * Auto-balloon (FR-DRW-030): one balloon per BOM item seen in the view and not ballooned there yet,
 * on the longest visible edge of its first component, placed around the view `gap` mm outside it
 * and spread so balloons do not overlap. Positions are in the view's model axes.
 */
export function autoBalloons(sheet: Sheet, v: DrawingView, topo: Topo, P: (p: V3) => P2, proj: Projection, s: number, bom: Bom, uid: () => string, gap = 12): BalloonAnnot[] {
  const have = new Set<number>();
  for (const a of sheet.annots ?? []) if (a.t === "balloon" && a.view === v.id) {
    for (const c of ["e" in a.ref ? compOfKey(a.ref.e) : null, ...(a.stack ?? [])]) { const i = c ? bom.itemOf(c) : null; if (i) have.add(i); }
  }
  const size = Math.max(proj.box[2] - proj.box[0], proj.box[3] - proj.box[1], 1), tol = size * 2e-3;
  const best = new Map<number, { e: MEdge; m: P2; len: number }>();
  for (const e of topo.edges) {
    const c = compOfKey(e.k), item = c ? bom.itemOf(c) : null;
    if (!item || have.has(item)) continue;
    const a = P(e.a), b = P(e.b), m = P(e.m);
    const len = e.t === "c" && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? 2 * Math.PI * (e.r ?? 0) * 0.5 : Math.hypot(a[0] - m[0], a[1] - m[1]) + Math.hypot(m[0] - b[0], m[1] - b[1]);
    if (len < size * 0.02 || !onVisible(proj, m, tol)) continue;
    const cur = best.get(item);
    if (!cur || len > cur.len) best.set(item, { e, m, len });
  }
  const [x0, y0, x1, y1] = proj.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, g = gap / s;
  // Each balloon goes out from the centre through its edge point to a box `g` outside the view.
  const placed = [...best.entries()].sort((p, q) => p[0] - q[0]).map(([item, b]) => {
    const dx = b.m[0] - cx || 1e-6, dy = b.m[1] - cy;
    const hw = (x1 - x0) / 2 + g, hh = (y1 - y0) / 2 + g;
    const t = Math.min(hw / Math.abs(dx), dy ? hh / Math.abs(dy) : Infinity);
    return { item, b, pos: [cx + dx * t, cy + dy * t] as P2, ang: Math.atan2(dy, dx) };
  });
  // Spread along the ring: walk by angle and push apart anything closer than a balloon and a half.
  placed.sort((p, q) => p.ang - q.ang);
  const minD = 13 / s;
  for (let i = 1; i < placed.length; i++) {
    const p = placed[i - 1], q = placed[i];
    const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]);
    if (d < minD) {
      // Slide along the side q sits on (vertical sides move in y, the others in x).
      const side = Math.abs(Math.abs(q.pos[0] - cx) - ((x1 - x0) / 2 + g)) < 1e-6;
      if (side) q.pos[1] += (q.pos[1] >= p.pos[1] ? 1 : -1) * (minD - d + 1e-6);
      else q.pos[0] += (q.pos[0] >= p.pos[0] ? 1 : -1) * (minD - d + 1e-6);
    }
  }
  return placed.map(p => ({ id: uid(), t: "balloon" as const, view: v.id, ref: { e: p.b.e.k, h: p.b.e.m, p: "e" as const }, pos: [Math.round(p.pos[0] * 100) / 100, Math.round(p.pos[1] * 100) / 100] as P2 }));
}
