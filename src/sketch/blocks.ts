/**
 * Sketch blocks (FRS 2.2, SolidWorks' Make Block / Insert Block / Explode Block). A definition keeps its
 * entities in its own coordinates with the insertion point at 0, 0; each instance is placed in the sketch
 * as ordinary entities `<insert>~<entity>` held by one fix relation `<insert>~fix`, so the solver, the
 * profiles and the kernel see plain fixed geometry. Moving, turning or scaling an instance places it again.
 */
import type { BlockInsert, SketchBlock, SketchFeature, SkEnt, SkRel, V2 } from "../model/types";
import { refPts } from "./define";

export const BLOCK_SEP = "~";
/** Relations a block keeps inside its definition (not ones tied to the model or a fix). */
const LOCAL = (r: SkRel) => r.t !== "fix" && r.t !== "pierce" && !r.ext && r.t !== "offset";

/** The insert an entity or relation id belongs to, when it is one of a block instance's. */
export function insertOf(sk: SketchFeature, id: string): BlockInsert | null {
  const k = id.indexOf(BLOCK_SEP);
  if (k < 0) return null;
  const ins = id.slice(0, k);
  return sk.inserts?.find(i => i.id === ins) ?? null;
}

/** Ids of the entities an insert placed. */
export function insertEnts(sk: SketchFeature, ins: string): string[] {
  return sk.ents.filter(e => e.id.startsWith(ins + BLOCK_SEP)).map(e => e.id);
}

/** The entity with every id it names (its own and the points it uses) passed through `f`. */
export function renameEnt(e: SkEnt, f: (id: string) => string): SkEnt {
  const c = structuredClone(e) as SkEnt & Record<string, unknown>;
  c.id = f(e.id);
  for (const k of ["a", "b", "c", "p", "p0", "p1", "along"] as const) if (typeof c[k] === "string") (c as Record<string, unknown>)[k] = f(c[k] as string);
  if (c.t === "spline") c.pts = c.pts.map(f);
  return c;
}

/** Where a block point lands in the sketch for an insert. */
export function placePoint(ins: BlockInsert, p: V2): V2 {
  const s = ins.scale ?? 1, a = ins.ang ?? 0, ca = Math.cos(a), sa = Math.sin(a);
  return [ins.x + s * (ca * p[0] - sa * p[1]), ins.y + s * (sa * p[0] + ca * p[1])];
}

/** The definition's entities placed for an insert (ids prefixed, circles scaled). */
function placed(def: SketchBlock, ins: BlockInsert): SkEnt[] {
  const s = ins.scale ?? 1;
  return def.ents.map(e => {
    const c = renameEnt(e, id => `${ins.id}${BLOCK_SEP}${id}`);
    if (c.t === "point") { const q = placePoint(ins, [c.x, c.y]); c.x = q[0]; c.y = q[1]; }
    else if (c.t === "circle") c.r *= s;
    return c;
  });
}

/**
 * Places every insert again from its definition: the old instance entities and their fix relations go,
 * the new ones keep the same ids, so the user's relations and dimensions to them stay. Inserts whose
 * definition is gone are dropped.
 */
export function placeInserts(sk: SketchFeature): SketchFeature {
  const defs = new Map((sk.blocks ?? []).map(b => [b.id, b] as const));
  const inserts = (sk.inserts ?? []).filter(i => defs.has(i.block));
  const ours = (id: string) => { const k = id.indexOf(BLOCK_SEP); return k > 0 && (sk.inserts ?? []).some(i => i.id === id.slice(0, k)); };
  const ents = sk.ents.filter(e => !ours(e.id));
  const rels = sk.rels.filter(r => !ours(r.id));
  for (const ins of inserts) {
    const def = defs.get(ins.block)!;
    const made = placed(def, ins);
    ents.push(...made);
    if (made.length) rels.push({ id: `${ins.id}${BLOCK_SEP}fix`, t: "fix", e: made.map(e => e.id) });
  }
  const have = new Set(ents.map(e => e.id));
  const out: SketchFeature = { ...sk, ents, rels: rels.filter(r => r.e.every(x => have.has(x))), dims: sk.dims.filter(d => d.e.every(x => have.has(x) || x === "origin")) };
  if (inserts.length) out.inserts = inserts; else delete out.inserts;
  return out;
}

/** A free id with this prefix among the sketch's blocks/inserts. */
function freeId(taken: Iterable<string>, prefix: string) {
  const used = new Set(taken);
  let k = 1;
  while (used.has(`${prefix}${k}`)) k++;
  return `${prefix}${k}`;
}

/** A block name not used in the sketch: Block1, Block2, … */
export function nextBlockName(names: Iterable<string>) {
  const used = new Set(names);
  let k = 1;
  while (used.has(`Block${k}`)) k++;
  return `Block${k}`;
}

export type MakeBlockError = "NOTHING" | "TEXT" | "INSERT";

/**
 * Make Block: the picked entities (curves take their points) become a definition with its insertion point
 * at `base` (default: the middle of their box), and one insert of it replaces them where they were.
 * Relations among them go into the block; relations and dimensions to the rest of the sketch are dropped.
 */
export function makeBlock(sk: SketchFeature, ids: Iterable<string>, name?: string, base?: V2): { sk: SketchFeature; block: SketchBlock; insert: BlockInsert } | MakeBlockError {
  const ent = new Map(sk.ents.map(e => [e.id, e] as const));
  const take = new Set<string>();
  for (const id of ids) {
    const e = ent.get(id);
    if (!e) continue;
    if (insertOf(sk, id)) return "INSERT";
    if (e.t === "text") return "TEXT";
    take.add(id);
    for (const p of refPts(e)) take.add(p);
  }
  const items = sk.ents.filter(e => take.has(e.id));
  if (!items.some(e => e.t !== "point")) return "NOTHING";
  const pts = items.filter((e): e is Extract<SkEnt, { t: "point" }> => e.t === "point");
  let lo: V2 = [Infinity, Infinity], hi: V2 = [-Infinity, -Infinity];
  for (const p of pts) { lo = [Math.min(lo[0], p.x), Math.min(lo[1], p.y)]; hi = [Math.max(hi[0], p.x), Math.max(hi[1], p.y)]; }
  for (const e of items) if (e.t === "circle") { const c = ent.get(e.c) as Extract<SkEnt, { t: "point" }>; lo = [Math.min(lo[0], c.x - e.r), Math.min(lo[1], c.y - e.r)]; hi = [Math.max(hi[0], c.x + e.r), Math.max(hi[1], c.y + e.r)]; }
  const b: V2 = base ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const bid = freeId((sk.blocks ?? []).map(x => x.id), "blk");
  const block: SketchBlock = {
    id: bid,
    name: name ?? nextBlockName((sk.blocks ?? []).map(x => x.name)),
    ents: items.map(e => { const c = structuredClone(e); if (c.t === "point") { c.x -= b[0]; c.y -= b[1]; } return c; }),
    rels: sk.rels.filter(r => LOCAL(r) && r.e.every(x => take.has(x))).map(r => structuredClone(r)),
  };
  // Points the rest of the sketch still uses stay behind (the block has its own copy).
  const shared = new Set(pts.filter(p => sk.ents.some(o => !take.has(o.id) && refPts(o).includes(p.id))).map(p => p.id));
  const gone = new Set([...take].filter(id => !shared.has(id)));
  const insert: BlockInsert = { id: freeId((sk.inserts ?? []).map(i => i.id), "bi"), block: bid, x: b[0], y: b[1] };
  const next: SketchFeature = {
    ...sk,
    ents: sk.ents.filter(e => !gone.has(e.id)),
    rels: sk.rels.filter(r => !r.e.some(x => gone.has(x))),
    dims: sk.dims.filter(d => !d.e.some(x => gone.has(x))),
    blocks: [...(sk.blocks ?? []), block],
    inserts: [...(sk.inserts ?? []), insert],
  };
  return { sk: placeInserts(next), block, insert };
}

/** Insert Block: another instance of a definition (copied in from elsewhere when it is new to this sketch). */
export function insertBlock(sk: SketchFeature, def: SketchBlock, at: V2, ang = 0, scale = 1): { sk: SketchFeature; insert: BlockInsert } {
  const blocks = [...(sk.blocks ?? [])];
  let mine = blocks.find(b => b.id === def.id && JSON.stringify(b.ents) === JSON.stringify(def.ents));
  if (!mine) {
    mine = { ...structuredClone(def), id: freeId(blocks.map(b => b.id), "blk") };
    if (blocks.some(b => b.name === mine!.name)) mine.name = nextBlockName(blocks.map(b => b.name));
    blocks.push(mine);
  }
  const insert: BlockInsert = { id: freeId((sk.inserts ?? []).map(i => i.id), "bi"), block: mine.id, x: at[0], y: at[1], ...(ang ? { ang } : {}), ...(scale !== 1 ? { scale } : {}) };
  return { sk: placeInserts({ ...sk, blocks, inserts: [...(sk.inserts ?? []), insert] }), insert };
}

/** Moves, turns or scales an insert and places it again. */
export function moveInsert(sk: SketchFeature, id: string, patch: Partial<Pick<BlockInsert, "x" | "y" | "ang" | "scale">>): SketchFeature {
  const inserts = (sk.inserts ?? []).map(i => {
    if (i.id !== id) return i;
    const n = { ...i, ...patch };
    if (!n.ang) delete n.ang;
    if (n.scale === undefined || n.scale === 1) delete n.scale;
    return n;
  });
  return placeInserts({ ...sk, inserts });
}

/** Deletes inserts (their entities and anything tied to them); definitions nothing uses any more go too. */
export function removeInserts(sk: SketchFeature, ids: Iterable<string>): SketchFeature {
  const del = new Set(ids);
  const inserts = (sk.inserts ?? []).filter(i => !del.has(i.id));
  const used = new Set(inserts.map(i => i.block));
  const ours = (x: string) => del.has(x.split(BLOCK_SEP)[0]) && x.includes(BLOCK_SEP);
  const out: SketchFeature = {
    ...sk,
    ents: sk.ents.filter(e => !ours(e.id)),
    rels: sk.rels.filter(r => !ours(r.id) && !r.e.some(ours)),
    dims: sk.dims.filter(d => !d.e.some(ours)),
    blocks: (sk.blocks ?? []).filter(b => used.has(b.id)),
    inserts,
  };
  if (!out.blocks!.length) delete out.blocks;
  if (!out.inserts!.length) delete out.inserts;
  return out;
}

/**
 * Explode Block: the instance's entities become ordinary sketch entities with new ids, its definition's
 * relations come back on them, and relations/dimensions the user tied to the instance follow.
 */
export function explodeInsert(sk: SketchFeature, id: string, fresh: (k: string) => string): SketchFeature {
  const ins = sk.inserts?.find(i => i.id === id);
  const def = ins && sk.blocks?.find(b => b.id === ins.block);
  if (!ins || !def) return sk;
  const pre = id + BLOCK_SEP;
  const map = new Map<string, string>();
  for (const e of sk.ents) if (e.id.startsWith(pre)) map.set(e.id, fresh(e.t === "point" ? "p" : "e"));
  const f = (x: string) => map.get(x) ?? x;
  const ents = sk.ents.map(e => (e.id.startsWith(pre) ? renameEnt(e, f) : e));
  const rels = sk.rels.filter(r => r.id !== `${pre}fix`).map(r => (r.e.some(x => map.has(x)) ? { ...r, e: r.e.map(f) } : r));
  for (const r of def.rels) rels.push({ ...structuredClone(r), id: fresh("r"), e: r.e.map(x => f(pre + x)) });
  const dims = sk.dims.map(d => (d.e.some(x => map.has(x)) ? { ...d, e: d.e.map(f) } : d));
  const inserts = (sk.inserts ?? []).filter(i => i.id !== id);
  const blocks = (sk.blocks ?? []).filter(b => inserts.some(i => i.block === b.id));
  const out: SketchFeature = { ...sk, ents, rels, dims, blocks, inserts };
  if (!blocks.length) delete out.blocks;
  if (!inserts.length) delete out.inserts;
  return out;
}

/** Renames a definition (every instance shows the new name). */
export function renameBlock(sk: SketchFeature, id: string, name: string): SketchFeature {
  return { ...sk, blocks: (sk.blocks ?? []).map(b => (b.id === id ? { ...b, name } : b)) };
}

/** A block as a file (`.mcadblk`): JSON with a format tag, in millimetres. */
export function blockFile(def: SketchBlock): string {
  return JSON.stringify({ format: "mobiuscad-block", version: 1, block: def }, null, 1);
}

/** Reads a `.mcadblk` file; throws "NOT_BLOCK" when it is not one. */
export function readBlockFile(text: string): SketchBlock {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("NOT_BLOCK"); }
  const o = j as { format?: string; block?: SketchBlock };
  const b = o?.block;
  if (o?.format !== "mobiuscad-block" || !b || typeof b.name !== "string" || !Array.isArray(b.ents) || !Array.isArray(b.rels)) throw new Error("NOT_BLOCK");
  const ids = new Set(b.ents.map(e => e?.id));
  for (const e of b.ents) {
    if (!e || typeof e.id !== "string" || e.id.includes(BLOCK_SEP) || e.t === "text") throw new Error("NOT_BLOCK");
    if (e.t === "point" ? !(isFinite(e.x) && isFinite(e.y)) : !refPts(e).every(p => ids.has(p))) throw new Error("NOT_BLOCK");
  }
  return { id: typeof b.id === "string" ? b.id : "blk1", name: b.name, ents: b.ents, rels: b.rels.filter(r => r && r.e?.every(x => ids.has(x))) };
}
