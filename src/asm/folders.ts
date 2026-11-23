// The folder each assembly was saved in (assemblies that reference part files): a page never learns the folder a
// file came from, so the folder handle is kept in IndexedDB by the assembly's document id, and opening the assembly
// again reads its parts from there. The browser asks for access to the folder again once per session.

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "readwrite" }): Promise<PermissionState>;
};

const DB = "mc-asm-folders", STORE = "folders", MAX = 200;
interface Stored { id: string; at: number; handle: FileSystemDirectoryHandle }

/** Tests (headless Chromium crashes on private file system handles in IndexedDB) keep them in memory. */
const mem: Map<string, Stored> | null = typeof navigator !== "undefined" && navigator.webdriver ? new Map() : null;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("no IndexedDB")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

/** Remembers the folder an assembly was saved in or read from. */
export async function rememberAsmFolder(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!id) return;
  if (mem) { mem.set(id, { id, at: Date.now(), handle }); return; }
  try {
    const db = await open();
    try {
      const st = db.transaction(STORE, "readwrite").objectStore(STORE);
      await req(st.put({ id, at: Date.now(), handle } satisfies Stored));
      const all = (await req(db.transaction(STORE).objectStore(STORE).getAll())) as Stored[];
      if (all.length > MAX) {
        const tx = db.transaction(STORE, "readwrite").objectStore(STORE);
        for (const x of all.sort((a, b) => b.at - a.at).slice(MAX)) tx.delete(x.id);
      }
    } finally { db.close(); }
  } catch { /* the folder is just not remembered */ }
}

/** The folder remembered for an assembly, or null. */
export async function asmFolder(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (!id) return null;
  if (mem) return mem.get(id)?.handle ?? null;
  try {
    const db = await open();
    try { return ((await req(db.transaction(STORE).objectStore(STORE).get(id))) as Stored | undefined)?.handle ?? null; }
    finally { db.close(); }
  } catch { return null; }
}

/** Read and write access to a folder: "granted" without asking when the browser already allows it, else asks
 * (`ask`, which needs a click just before) or answers "prompt". */
export async function folderAccess(h: FileSystemDirectoryHandle, ask: boolean): Promise<PermissionState> {
  const p = h as PermHandle;
  try {
    const now = p.queryPermission ? await p.queryPermission({ mode: "readwrite" }) : "granted";
    if (now === "granted" || !ask || !p.requestPermission) return now;
    return await p.requestPermission({ mode: "readwrite" });
  } catch { return "prompt"; }
}

type PickerWindow = Window & { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> };

/** Can this browser save into a folder (Chrome, Edge on a computer)? Tests get the private file system. */
export function foldersOk(): boolean {
  if (testRoot()) return true;
  // both pickers come together (Chrome, Edge); tests that take away the save picker get the download path
  const w = window as PickerWindow & { showSaveFilePicker?: unknown };
  return !!w.showDirectoryPicker && !!w.showSaveFilePicker;
}

function testRoot(): string | null { return new URLSearchParams(location.search).get("asmfolder"); }

/** Asks for a folder (null = cancelled). With `?asmfolder=<name>` (tests) it is that folder of the private file system. */
export async function pickFolder(startIn?: FileSystemHandle | null): Promise<FileSystemDirectoryHandle | null> {
  const name = testRoot();
  if (name) return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  const w = window as PickerWindow;
  if (!w.showDirectoryPicker) return null;
  try { return await w.showDirectoryPicker({ mode: "readwrite", id: "mc-asm", ...(startIn ? { startIn } : {}) }); }
  catch { return null; }
}
