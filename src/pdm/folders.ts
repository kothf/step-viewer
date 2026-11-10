// Vault folders used before (FR-PDM-002): the folder handles are kept in IndexedDB, so a vault on disk opens
// again from the Vault menu without the folder picker. The browser asks for access to the folder again once
// per session; that needs a click, which the menu entry is.

export interface VaultFolder {
  /** The folder's name (a page never learns the full path). */
  name: string;
  /** When it was opened last (ms). */
  at: number;
}
interface Stored extends VaultFolder { key: string; handle: FileSystemDirectoryHandle }
type PermHandle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  isSameEntry(o: FileSystemHandle): Promise<boolean>;
};

export const FOLDERS_MAX = 8;
const DB = "mc-vault-folders", STORE = "folders";

/**
 * Tests keep the list in memory: headless Chromium crashes when a handle of the origin's private file system
 * (what the smoke test hands out in place of a picked folder) goes into IndexedDB.
 */
let mem: Stored[] | null = null;
export function useMemoryFolders() { mem = []; }
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

/** The remembered folders, newest first (empty when storage is unavailable). */
export async function vaultFolders(): Promise<(VaultFolder & { key: string })[]> {
  if (mem) return [...mem].sort((a, b) => b.at - a.at).map(({ key, name, at }) => ({ key, name, at }));
  try {
    const db = await open();
    try { return (await all(db)).map(({ key, name, at }) => ({ key, name, at })); } finally { db.close(); }
  } catch { return []; }
}

/** Remembers a vault folder just opened or created. The same folder picked again replaces its entry. */
export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  if (mem) {
    let old: Stored | undefined;
    for (const x of mem) if (await (x.handle as PermHandle).isSameEntry(handle).catch(() => false)) old = x;
    mem = [{ key: old?.key ?? newKey(), name: handle.name, at: Date.now(), handle }, ...mem.filter(x => x !== old)].slice(0, FOLDERS_MAX);
    return;
  }
  try {
    const db = await open();
    try {
      const list = await all(db);
      let key = "";
      for (const x of list) if (await (x.handle as PermHandle).isSameEntry(handle).catch(() => false)) { key = x.key; break; }
      const tx = db.transaction(STORE, "readwrite"), st = tx.objectStore(STORE);
      st.put({ key: key || newKey(), name: handle.name, at: Date.now(), handle } satisfies Stored);
      for (const x of list.filter(x => x.key !== key).slice(FOLDERS_MAX - 1)) st.delete(x.key);
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    } finally { db.close(); }
  } catch { /* the folder is just not remembered */ }
}

/**
 * The handle of a remembered folder with read and write access, asking the user when the browser wants that.
 * "denied" = the user said no; null = the entry is gone.
 */
export async function folderHandle(key: string): Promise<FileSystemDirectoryHandle | "denied" | null> {
  let rec: Stored | undefined = mem?.find(x => x.key === key);
  if (!mem) try {
    const db = await open();
    try { rec = (await req(db.transaction(STORE).objectStore(STORE).get(key))) as Stored | undefined; } finally { db.close(); }
  } catch { return null; }
  if (!rec) return null;
  const h = rec.handle as PermHandle;
  try {
    if (h.queryPermission && await h.queryPermission({ mode: "readwrite" }) !== "granted") {
      if (!h.requestPermission || await h.requestPermission({ mode: "readwrite" }) !== "granted") return "denied";
    }
  } catch { return "denied"; }
  return h;
}

export async function forgetFolder(key: string): Promise<void> {
  if (mem) { mem = mem.filter(x => x.key !== key); return; }
  try {
    const db = await open();
    try { await req(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key)); } finally { db.close(); }
  } catch { /* nothing to forget */ }
}
