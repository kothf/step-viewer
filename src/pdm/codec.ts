// What the vault reads from and writes into MöbiusCAD documents (.mcadprt / .mcadasm / .mcaddrw, ZIP + JSON):
// references to other files (FR-PDM-020) and document properties mapped to data cards (FR-PDM-034/040).
//
// References: `manifest.json` → `references: [{ path, qty? }]`, paths relative to the referencing file's folder.
// An assembly or drawing writes them when it saves; the vault indexes them at each check-in, redirects them on
// rename/move and copy tree. Properties: `document.json` → `props` ({ partNumber, description, title, author,
// revision, custom: {…} }).
import { toJson } from "../model/file";
import { unzipLimited, zip } from "../model/zip";

export interface DocRef { path: string; qty: number }

const dec = new TextDecoder();
const isDoc = (path: string) => /\.mcad(prt|asm|drw)$/i.test(path);

async function entries(bytes: Uint8Array) {
  try { return await unzipLimited(bytes.slice().buffer as ArrayBuffer, 512 * 1024 ** 2); } catch { return null; }
}
const readJson = (m: Map<string, Uint8Array>, name: string) => {
  const d = m.get(name);
  if (!d) return null;
  try { return JSON.parse(dec.decode(d)) as Record<string, unknown>; } catch { return null; }
};
async function rezip(m: Map<string, Uint8Array>) { return zip([...m].map(([name, data]) => ({ name, data }))); }

/** References a document makes to other files, relative to its own folder. */
export async function docRefs(path: string, bytes: Uint8Array): Promise<DocRef[]> {
  if (!isDoc(path)) return [];
  const m = await entries(bytes);
  const refs = m && readJson(m, "manifest.json")?.references;
  if (!Array.isArray(refs)) return [];
  const out = new Map<string, number>();
  for (const r of refs as { path?: unknown; qty?: unknown }[]) {
    if (typeof r?.path !== "string" || !r.path) continue;
    out.set(r.path, (out.get(r.path) ?? 0) + (typeof r.qty === "number" && r.qty > 0 ? r.qty : 1));
  }
  return [...out].map(([p, qty]) => ({ path: p, qty }));
}

/** Rewrites the references of a document (`map` gives the new relative path, or null to keep it). Null when nothing changed. */
export async function rewriteRefs(path: string, bytes: Uint8Array, map: (rel: string) => string | null): Promise<Uint8Array | null> {
  if (!isDoc(path)) return null;
  const m = await entries(bytes);
  const mf = m && readJson(m, "manifest.json");
  if (!m || !mf || !Array.isArray(mf.references)) return null;
  const changes = new Map<string, string>();
  for (const r of mf.references as { path?: string }[]) {
    if (typeof r?.path !== "string") continue;
    const n = map(r.path);
    if (n && n !== r.path) { changes.set(r.path, n); r.path = n; }
  }
  if (!changes.size) return null;
  m.set("manifest.json", new TextEncoder().encode(toJson(mf)));
  // The document may name the same files (components, views): exact string matches follow.
  const doc = readJson(m, "document.json");
  if (doc) {
    const walk = (v: unknown): unknown => (typeof v === "string" ? changes.get(v) ?? v : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
    m.set("document.json", new TextEncoder().encode(toJson(walk(doc))));
  }
  return rezip(m);
}

const STD = ["partNumber", "description", "title", "author", "revision"];

/** Document properties as a flat map (standard ones by key, custom ones by name). Null when not a MöbiusCAD document. */
export async function readProps(path: string, bytes: Uint8Array): Promise<Record<string, string> | null> {
  if (!isDoc(path)) return null;
  const m = await entries(bytes);
  const doc = m && readJson(m, "document.json");
  if (!doc) return null;
  const p = (doc.props ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of STD) if (typeof p[k] === "string") out[k] = p[k] as string;
  for (const [k, v] of Object.entries((p.custom ?? {}) as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Writes properties into a document; empty values remove them. Null when not a document or nothing changed. */
export async function writeProps(path: string, bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array | null> {
  if (!isDoc(path)) return null;
  const m = await entries(bytes);
  const doc = m && readJson(m, "document.json");
  if (!m || !doc) return null;
  const p = { ...(doc.props ?? {}) } as Record<string, unknown>;
  const custom = { ...((p.custom ?? {}) as Record<string, string>) };
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    const tgt = STD.includes(k) ? p : custom;
    const cur = tgt[k] ?? "";
    if (cur === v) continue;
    changed = true;
    if (v) tgt[k] = v; else delete tgt[k];
  }
  if (!changed) return null;
  if (Object.keys(custom).length) p.custom = custom; else delete p.custom;
  doc.props = p;
  m.set("document.json", new TextEncoder().encode(toJson(doc)));
  return rezip(m);
}

/** The vault path a relative reference points at, from the referencing file's path. Null when it leaves the vault. */
export function resolveRel(from: string, rel: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const s of rel.replace(/\\/g, "/").split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(s);
  }
  return parts.length ? parts.join("/") : null;
}

/** The relative path from one vault file's folder to another file. */
export function relPath(from: string, to: string): string {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** Feature-tree difference between two part documents (FR-PDM-050): added, removed, and changed parameters (old → new). */
export async function featureDiff(path: string, a: Uint8Array, b: Uint8Array) {
  const load = async (x: Uint8Array) => { const m = isDoc(path) ? await entries(x) : null; return (m && readJson(m, "document.json")) ?? null; };
  const da = await load(a), db = await load(b);
  if (!da || !db) return null;
  type F = { id: string; type: string; name?: string } & Record<string, unknown>;
  const fa = new Map(((da.features ?? []) as F[]).map(f => [f.id, f])), fb = new Map(((db.features ?? []) as F[]).map(f => [f.id, f]));
  const label = (f: F) => f.name || f.type;
  const flat = (v: unknown, pre: string, out: Map<string, string>) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      // An expression value: its text is what the user typed.
      if (typeof o.expr === "string" && "value" in o) { out.set(pre, `${o.expr}`); return; }
      for (const [k, x] of Object.entries(o)) flat(x, pre ? `${pre}.${k}` : k, out);
    } else if (Array.isArray(v)) {
      if (v.length > 12 || v.some(x => x && typeof x === "object")) out.set(pre, `[${v.length}]`);
      else out.set(pre, JSON.stringify(v));
    } else out.set(pre, String(v));
  };
  const added = [...fb.values()].filter(f => !fa.has(f.id)).map(label);
  const removed = [...fa.values()].filter(f => !fb.has(f.id)).map(label);
  const changed: { feature: string; param: string; from: string; to: string }[] = [];
  for (const [id, x] of fa) {
    const y = fb.get(id);
    if (!y) continue;
    const ma = new Map<string, string>(), mb = new Map<string, string>();
    flat(x, "", ma); flat(y, "", mb);
    for (const k of new Set([...ma.keys(), ...mb.keys()])) {
      if (k === "id" || ma.get(k) === mb.get(k)) continue;
      changed.push({ feature: label(y), param: k, from: ma.get(k) ?? "—", to: mb.get(k) ?? "—" });
    }
  }
  const props = (d: Record<string, unknown>) => { const m = new Map<string, string>(); flat({ props: d.props, material: d.material, vars: d.vars }, "", m); return m; };
  const pa = props(da), pb = props(db);
  for (const k of new Set([...pa.keys(), ...pb.keys()])) if (pa.get(k) !== pb.get(k)) changed.push({ feature: "Document", param: k, from: pa.get(k) ?? "—", to: pb.get(k) ?? "—" });
  return { added, removed, changed };
}
