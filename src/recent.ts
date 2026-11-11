// Recent documents for File ▸ recent list (FR-UI-010): the files themselves are kept in IndexedDB, so a
// recent entry opens again without a file picker (a browser page cannot reopen a path on disk). A group of
// files opened together (an SLDASM assembly with its parts, a set of PCB layers) is one entry.

export interface RecentEntry {
  /** The name shown: the main file's name. */
  name: string;
  /** When it was opened or saved (ms). */
  at: number;
  /** Total bytes of the files. */
  size: number;
  /** How many files the entry opens. */
  count: number;
}
interface Stored extends RecentEntry { key: string; files: { name: string; data: ArrayBuffer }[] }

export const RECENT_MAX = 8;
/** An entry bigger than this is listed nowhere (keeps the browser's storage use sane). */
export const RECENT_BYTES = 64 * 1024 * 1024;
const DB = "mc-recent", STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("no IndexedDB")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "key" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function all(db: IDBDatabase): Promise<Stored[]> {
  return ((await req(db.transaction(STORE).objectStore(STORE).getAll())) as Stored[]).sort((a, b) => b.at - a.at);
}

/** The list, newest first (empty when storage is unavailable). */
export async function recentList(): Promise<RecentEntry[]> {
  try {
    const db = await open();
    try { return (await all(db)).map(({ name, at, size, count }) => ({ name, at, size, count })); } finally { db.close(); }
  } catch { return []; }
}

/** Remembers files just opened or saved; the main file comes first. Older entries past RECENT_MAX go. */
export async function recentAdd(files: { name: string; data: ArrayBuffer | Uint8Array | Blob }[]): Promise<void> {
  if (!files.length) return;
  try {
    const list = await Promise.all(files.map(async f => ({
      name: f.name,
      data: f.data instanceof Blob ? await f.data.arrayBuffer() : f.data instanceof Uint8Array ? f.data.slice().buffer as ArrayBuffer : f.data.slice(0),
    })));
    const size = list.reduce((s, f) => s + f.data.byteLength, 0);
    if (size > RECENT_BYTES) return;
    const key = list.map(f => f.name.toLowerCase()).sort().join("|");
    const db = await open();
    try {
      const tx = db.transaction(STORE, "readwrite"), st = tx.objectStore(STORE);
      st.put({ key, name: list[0].name, at: Date.now(), size, count: list.length, files: list } satisfies Stored);
      const old = ((await req(st.getAll())) as Stored[]).sort((a, b) => b.at - a.at).slice(RECENT_MAX);
      for (const o of old) st.delete(o.key);
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    } finally { db.close(); }
  } catch { /* private window or storage full: no recent list */ }
}

/** The files of the i-th entry (newest first), or null. */
export async function recentFiles(i: number): Promise<File[] | null> {
  try {
    const db = await open();
    try {
      const e = (await all(db))[i];
      return e ? e.files.map(f => new File([f.data], f.name)) : null;
    } finally { db.close(); }
  } catch { return null; }
}

export async function recentClear(): Promise<void> {
  try {
    const db = await open();
    try { await req(db.transaction(STORE, "readwrite").objectStore(STORE).clear()); } finally { db.close(); }
  } catch { /* nothing to clear */ }
}
