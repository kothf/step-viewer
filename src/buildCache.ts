// Disk cache of built geometry (IndexedDB "mc-build-cache"): a part's rebuild result, an assembly part's body and
// analysed mesh, a drawing's loaded model and its exact views. Reopening a document then reads them instead of
// running the kernel again.
//
// Correctness first: every key is a SHA-256 of the app version, the build id (a hash of the sources and the locked
// packages, so a new kernel or any code change misses), the kind of entry and everything the result is made from
// (the whole document JSON or the file's bytes, the request). A failed read or write only costs the speed-up:
// every call here swallows its errors. `?nocache` turns it off; it is off in the dev server (whose sources change
// under a fixed build id) unless `?diskcache`.

const DB = "mc-build-cache";
/** Entries `{ v }` and their bookkeeping `{ size, at }` by key, in two stores so eviction reads only the small one. */
const DATA = "e", META = "m";
/** The cache's size before the least recently used entries go (bytes, estimated). */
export const CACHE_LIMIT = 400 * 1048576;
/** One entry larger than this is not stored. */
const ENTRY_MAX = 96 * 1048576;

/** Hits, misses and writes so far (for `?debug` and the smoke test). */
export const cacheStats = { hits: 0, misses: 0, puts: 0, errors: 0 };

let on: boolean | null = null;
/** Whether the disk cache is used on this page. */
export function cacheOn(): boolean {
  if (on !== null) return on;
  try {
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
    const dev = typeof import.meta !== "undefined" && !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
    on = typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle && !q?.has("nocache") && (!dev || !!q?.has("diskcache"));
  } catch { on = false; }
  return on;
}

let db: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  if (!cacheOn()) return Promise.resolve(null);
  db ??= new Promise<IDBDatabase | null>(resolve => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(DATA); r.result.createObjectStore(META); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return db;
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise(resolve => { tx.oncomplete = () => resolve(true); tx.onerror = tx.onabort = () => resolve(false); });
}

const enc = new TextEncoder();
/**
 * The key of an entry: SHA-256 (hex) of the app version, the build id, `kind` and `parts` (JSON; byte arrays as
 * their own hash, so a file is keyed by its content). Null when the cache is off.
 */
export async function cacheKey(kind: string, ...parts: unknown[]): Promise<string | null> {
  if (!cacheOn()) return null;
  try {
    const bins: string[] = [];
    for (const p of parts) if (p instanceof Uint8Array || p instanceof ArrayBuffer) bins.push(hex(await crypto.subtle.digest("SHA-256", p)));
    const text = JSON.stringify([__APP_VERSION__, typeof __BUILD_ID__ === "undefined" ? "" : __BUILD_ID__, kind, bins, parts.map(p => (p instanceof Uint8Array || p instanceof ArrayBuffer ? null : p))]);
    return `${kind}:${hex(await crypto.subtle.digest("SHA-256", enc.encode(text)))}`;
  } catch { cacheStats.errors++; return null; }
}

function hex(b: ArrayBuffer): string {
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

/** The stored value, or undefined. */
export async function cacheGet<T>(key: string | null): Promise<T | undefined> {
  if (!key) return undefined;
  const d = await open();
  if (!d) return undefined;
  try {
    const tx = d.transaction([DATA, META], "readwrite");
    const req = tx.objectStore(DATA).get(key);
    const v = await new Promise<{ v: T } | undefined>(resolve => { req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(undefined); });
    if (v) {
      // Used now: it is the last to go.
      const m = tx.objectStore(META), mr = m.get(key);
      mr.onsuccess = () => { if (mr.result) m.put({ ...mr.result, at: Date.now() }, key); };
    }
    await done(tx);
    if (v) cacheStats.hits++; else cacheStats.misses++;
    return v?.v;
  } catch { cacheStats.errors++; return undefined; }
}

/** Stores `value` (cloned by IndexedDB) and drops the oldest entries past `CACHE_LIMIT`. */
export async function cachePut(key: string | null, value: unknown): Promise<void> {
  if (!key) return;
  const size = sizeOf(value);
  if (size > ENTRY_MAX) return;
  const d = await open();
  if (!d) return;
  try {
    const tx = d.transaction([DATA, META], "readwrite");
    tx.objectStore(DATA).put({ v: value }, key);
    tx.objectStore(META).put({ size, at: Date.now() }, key);
    if (await done(tx)) cacheStats.puts++;
    await evict(d);
  } catch { cacheStats.errors++; }
}

/** Drops one entry (a result found to differ from a fresh build). */
export async function cacheDelete(key: string | null): Promise<void> {
  if (!key) return;
  const d = await open();
  if (!d) return;
  try {
    const tx = d.transaction([DATA, META], "readwrite");
    tx.objectStore(DATA).delete(key);
    tx.objectStore(META).delete(key);
    await done(tx);
  } catch { cacheStats.errors++; }
}

/** Empties the cache. */
export async function cacheClear(): Promise<void> {
  const d = await open();
  if (!d) return;
  try {
    const tx = d.transaction([DATA, META], "readwrite");
    tx.objectStore(DATA).clear();
    tx.objectStore(META).clear();
    await done(tx);
  } catch { cacheStats.errors++; }
}

/** Entries and their estimated bytes. */
export async function cacheSize(): Promise<{ entries: number; bytes: number }> {
  const d = await open();
  if (!d) return { entries: 0, bytes: 0 };
  const all = await metas(d);
  return { entries: all.length, bytes: all.reduce((s, m) => s + m.size, 0) };
}

async function metas(d: IDBDatabase): Promise<{ key: string; size: number; at: number }[]> {
  const tx = d.transaction(META, "readonly"), st = tx.objectStore(META);
  const ks = st.getAllKeys(), vs = st.getAll();
  await done(tx);
  return (ks.result as string[]).map((key, i) => ({ key, size: vs.result[i]?.size ?? 0, at: vs.result[i]?.at ?? 0 }));
}

async function evict(d: IDBDatabase) {
  const all = await metas(d);
  let total = all.reduce((s, m) => s + m.size, 0);
  if (total <= CACHE_LIMIT) return;
  all.sort((a, b) => a.at - b.at);
  const tx = d.transaction([DATA, META], "readwrite");
  for (const m of all) {
    if (total <= CACHE_LIMIT * 0.8) break;
    tx.objectStore(DATA).delete(m.key);
    tx.objectStore(META).delete(m.key);
    total -= m.size;
  }
  await done(tx);
}

/** A rough size in bytes: typed arrays by their length, strings at 2 bytes a character, 8 bytes a number. */
export function sizeOf(v: unknown, depth = 0): number {
  if (v == null || depth > 12) return 8;
  if (typeof v === "string") return 2 * v.length;
  if (typeof v !== "object") return 8;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  let s = 16;
  if (Array.isArray(v)) { for (const x of v) s += sizeOf(x, depth + 1); return s; }
  for (const k in v as Record<string, unknown>) s += 2 * k.length + sizeOf((v as Record<string, unknown>)[k], depth + 1);
  return s;
}
