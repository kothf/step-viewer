// Assembly drawings (FR-DRW-030): the bill of materials of the assembly shown, balloons on its
// components and auto-balloon. A component is told by the face names of its edges, which the
// drawing worker gives as `<component id>@<face name>`.
import type { MEdge, Projection, Topo, V3 } from "../kernel/drawing";
import type { AsmDoc } from "../asm/types";
import type { Prim } from "./prims";
import type { BalloonAnnot, DrawingView, Sheet } from "./types";

type P2 = [number, number];
type Box = [number, number, number, number];

export interface BomRow { key: string; item: number; part: string; description: string; qty: number; comp: string; /** The part's material, or its bodies' when they have their own (FR-MAT-001); empty for a sub-assembly. */ material: string }
export interface Bom { mode: BomMode; rows: BomRow[]; itemOf(comp: string): number | null }
/** FR-ASM-024: "top" lists sub-assemblies as one row; "parts" lists every part inside them. */
export type BomMode = "top" | "parts";

/** Default BOM columns (English keys; the sheet shows them in the interface language). */
export const BOM_COLS = ["Item", "Part number", "Description", "Qty", "Material"];
/** The column the Material cell goes in (BOMs made before 1.471.0 have only the first four). */
export const BOM_MAT_COL = 4;

/** Body materials by part key (from the drawing worker's components): what a BOM row shows in place of the part's material. */
export type BomMats = Map<string, string[]>;
export function bomMats(comps: { part: string; mats?: string[] }[] | undefined): BomMats | undefined {
  const m: BomMats = new Map();
  for (const c of comps ?? []) if (c.mats?.length && !m.has(c.part)) m.set(c.part, c.mats);
  return m.size ? m : undefined;
}

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
export function bomOf(top: AsmDoc, flat: AsmDoc, mode: BomMode = "top", sub?: string, mats?: BomMats): Bom {
  // One sub-assembly's own parts list (FR-DRW-030): its parts, wherever they sit inside it.
  if (sub) return partsBom({ ...flat, components: flat.components.filter(c => c.id.startsWith(`${sub}/`)) }, mats);
  return mode === "parts" ? partsBom(flat, mats) : topBom(top, flat, mats);
}

/** A part's material text: its bodies' distinct materials when they have their own, else the part's. */
const matText = (key: string, d: { material?: { name: string } | null } | null | undefined, mats?: BomMats): string =>
  d ? mats?.get(key)?.join(", ") ?? d.material?.name ?? "" : "";

/** The BOM a sheet's balloons and parts list follow: its BOM table's mode and sub-assembly (memoised in `cache`). */
export function sheetBom(sheet: Sheet, top: AsmDoc, flat: AsmDoc, cache?: Map<string, Bom>, mats?: BomMats): Bom {
  const t = (sheet.annots ?? []).find(a => a.t === "table" && a.kind === "bom");
  const sub = t && t.t === "table" && t.sub && top.components.some(c => c.id === t.sub) ? t.sub : undefined;
  const mode = bomMode(sheet), key = `${mode}|${sub ?? ""}`;
  let b = cache?.get(key);
  if (!b) { b = bomOf(top, flat, mode, sub, mats); cache?.set(key, b); }
  return b;
}

/** The sub-assemblies at the top of an assembly, for the BOM's choice. */
export const subsOf = (top: AsmDoc): { id: string; name: string }[] =>
  top.components.filter(c => !c.suppressed && top.parts[c.part]?.asm).map(c => ({ id: c.id, name: c.name }));

function topBom(top: AsmDoc, flat: AsmDoc, mats?: BomMats): Bom {
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
    rows.push({ key: k, item: rows.length + 1, part: d?.props?.partNumber || p.name, description: d?.props?.description ?? "", qty: 0, comp: "", material: matText(k, d, mats) });
  }
  for (const [t, k] of tops) { const i = at.get(k); if (i !== undefined) { rows[i].qty++; if (!rows[i].comp) rows[i].comp = firstShown(flat, t); } }
  return finish("top", rows, keyOf);
}

/** The first unsuppressed flat component of top-level component `t` (itself, or a child of a sub-assembly). */
function firstShown(flat: AsmDoc, t: string): string {
  return flat.components.find(c => !c.suppressed && (c.id === t || c.id.startsWith(`${t}/`)))?.id ?? t;
}

function partsBom(flat: AsmDoc, mats?: BomMats): Bom {
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
      rows.push({ key: g, item: i + 1, part: p.doc.props?.partNumber || p.name, description: p.doc.props?.description ?? "", qty: 0, comp: c.id, material: matText(c.part, p.doc, mats) });
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
export const bomCells = (b: Bom): string[][] => b.rows.map(r => [String(r.item), r.part, r.description, String(r.qty), r.material]);

/** Balloon outlines (SolidWorks' balloon styles): the plain circle, a circle split for the quantity, or a polygon; "none" = the number alone, underlined. */
export type BalloonShape = "split" | "tri" | "hex" | "box" | "none";
export const BALLOON_R = 5;

/** The corners of a polygon balloon about `o`, ccw (every shape is 2R tall, so stacked balloons touch). */
export function balloonOutline(o: P2, shape: BalloonShape | undefined, R = BALLOON_R): P2[] | null {
  const [x, y] = o;
  if (shape === "tri") { const w = 2 * R / Math.sqrt(3); return [[x - w, y - R], [x + w, y - R], [x, y + R]]; }
  if (shape === "hex") { const w = 2 * R / Math.sqrt(3); return [[x - w, y], [x - w / 2, y - R], [x + w / 2, y - R], [x + w, y], [x + w / 2, y + R], [x - w / 2, y + R]]; }
  if (shape === "box") return [[x - R, y - R], [x + R, y - R], [x + R, y + R], [x - R, y + R]];
  if (shape === "none") return [[x - R, y - R * 0.6], [x + R, y - R * 0.6], [x + R, y + R * 0.6], [x - R, y + R * 0.6]];
  return null;
}

/** How far from `o` along the unit direction `u` the outline `poly` is (o inside it). */
function reach(o: P2, u: P2, poly: P2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1], den = u[0] * ey - u[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den, k = ((a[0] - o[0]) * u[1] - (a[1] - o[1]) * u[0]) / den;
    if (t > 0 && k >= -1e-9 && k <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}

/**
 * A balloon: a Ø10 circle with the item number, a leader to `tip` ending in a dot on the part.
 * `more` are stacked balloons: circles touching it downwards, sharing its leader.
 * `opt.shape`: the outline. `opt.lower`: with "split", the text of each balloon's lower half (the quantity),
 * in the order of `text` then `more`.
 */
export function balloonPrims(at: P2, tip: P2 | null, text: string, more: string[] = [], opt: { shape?: BalloonShape; lower?: string[] } = {}): { prims: Prim[]; box: Box } {
  const R = BALLOON_R, out: Prim[] = [], shape = opt.shape;
  const line = (a: P2, b: P2): Prim => ({ t: "l", p: [a[0], a[1], b[0], b[1]], pen: "thin", layer: "ANNOT" });
  [text, ...more].forEach((s, i) => {
    const o: P2 = [at[0], at[1] - 2 * R * i], poly = balloonOutline(o, shape);
    if (shape === "none") out.push(line(poly![0], poly![1]));
    else if (poly) poly.forEach((q, j) => out.push(line(q, poly[(j + 1) % poly.length])));
    else out.push({ t: "a", o, r: R, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
    if (shape === "split") {
      out.push(line([o[0] - R, o[1]], [o[0] + R, o[1]]));
      out.push({ t: "t", x: o[0], y: o[1] + 0.9, s, h: s.length > 2 ? 2.5 : 3.5, al: "c", layer: "ANNOT" });
      const q = opt.lower?.[i] ?? "";
      if (q) out.push({ t: "t", x: o[0], y: o[1] - 3.6, s: q, h: q.length > 2 ? 2.5 : 3, al: "c", layer: "ANNOT" });
    } else {
      // A triangle is narrow at the top: its text is smaller and sits lower.
      const h = shape === "tri" ? (s.length > 2 ? 2.5 : 3.5) : s.length > 2 ? 3.5 : 5;
      out.push({ t: "t", x: o[0], y: o[1] - h * 0.35 + 0.2 - (shape === "tri" ? 1.6 : 0), s, h, al: "c", layer: "ANNOT" });
    }
  });
  if (tip) {
    // The leader leaves the balloon of the stack nearest the tip (the top one or the bottom one).
    const o: P2 = more.length && tip[1] < at[1] - R * more.length ? [at[0], at[1] - 2 * R * more.length] : at;
    const d = Math.hypot(tip[0] - o[0], tip[1] - o[1]);
    if (d > R + 0.5) {
      const u: P2 = [(tip[0] - o[0]) / d, (tip[1] - o[1]) / d], poly = balloonOutline(o, shape), r0 = poly ? Math.min(reach(o, u, poly), d) : R;
      out.push({ t: "l", p: [o[0] + u[0] * r0, o[1] + u[1] * r0, tip[0], tip[1]], pen: "thin", layer: "ANNOT" });
      const dot: number[] = [];
      for (let i = 0; i < 8; i++) dot.push(tip[0] + 0.6 * Math.cos(i * Math.PI / 4), tip[1] + 0.6 * Math.sin(i * Math.PI / 4));
      out.push({ t: "p", p: dot, pen: "thin", layer: "ANNOT", fill: true, closed: true });
    }
  }
  const w = shape === "tri" || shape === "hex" ? 2 * R / Math.sqrt(3) : R;
  return { prims: out, box: [at[0] - w, at[1] - R - 2 * R * more.length, at[0] + w, at[1] + R] };
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
export interface BalloonItems {
  /** The item an edge (by its key) belongs to: a BOM item, or a cut list item on a weldment part. */
  edge(k: string): number | null;
  /** The item a stacked entry names. */
  stack(s: string): number | null;
  /** Which balloons already in the view count (weld tags and cut list balloons number different lists). */
  mine?(a: BalloonAnnot): boolean;
}

/** Items from a BOM: the component an edge key names. */
export function bomItems(bom: Bom): BalloonItems {
  return { edge: k => { const c = compOfKey(k); return c ? bom.itemOf(c) : null; }, stack: s => bom.itemOf(s) };
}

export function autoBalloons(sheet: Sheet, v: DrawingView, topo: Topo, P: (p: V3) => P2, proj: Projection, s: number, items: BalloonItems, uid: () => string, gap = 12, taken?: (p: P2) => boolean): BalloonAnnot[] {
  const have = new Set<number>();
  for (const a of sheet.annots ?? []) if (a.t === "balloon" && a.view === v.id && (items.mine?.(a) ?? true)) {
    for (const i of ["e" in a.ref ? items.edge(a.ref.e) : null, ...(a.stack ?? []).map(x => items.stack(x))]) if (i) have.add(i);
  }
  const size = Math.max(proj.box[2] - proj.box[0], proj.box[3] - proj.box[1], 1), tol = size * 2e-3;
  const best = new Map<number, { e: MEdge; m: P2; len: number }>();
  for (const e of topo.edges) {
    const item = items.edge(e.k);
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
  // A balloon on top of something already there (a dimension's text, a note, another view) takes the nearest free place
  // further out or along the side it sits on, in 3 mm steps; with none free it stays where it was.
  // Balloons still on top of each other after the spread (many items round a small view) are moved the same way.
  const done: typeof placed = [];
  for (const p of placed) {
    const clear = (q: P2) => done.every(o => Math.hypot(o.pos[0] - q[0], o.pos[1] - q[1]) >= minD);
    if (!taken?.(p.pos) && clear(p.pos)) { done.push(p); continue; }
    const onSide = Math.abs(Math.abs(p.pos[0] - cx) - ((x1 - x0) / 2 + g)) < 1e-6;
    const out: P2 = onSide ? [Math.sign(p.pos[0] - cx) || 1, 0] : [0, Math.sign(p.pos[1] - cy) || 1], along: P2 = onSide ? [0, 1] : [1, 0], st = 3 / s;
    const cands: { q: P2; d: number }[] = [];
    for (let k = 0; k <= 20; k++) for (let j = -16; j <= 16; j++) if (k || j) cands.push({ q: [p.pos[0] + (out[0] * k + along[0] * j) * st, p.pos[1] + (out[1] * k + along[1] * j) * st], d: Math.hypot(k, j) });
    cands.sort((a, b) => a.d - b.d);
    const free = cands.find(c => !taken?.(c.q) && clear(c.q));
    if (free) p.pos = free.q;
    done.push(p);
  }
  return placed.map(p => ({ id: uid(), t: "balloon" as const, view: v.id, ref: { e: p.b.e.k, h: p.b.e.m, p: "e" as const }, pos: [Math.round(p.pos[0] * 100) / 100, Math.round(p.pos[1] * 100) / 100] as P2 }));
}
