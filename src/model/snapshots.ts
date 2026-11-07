// Automatic snapshots (FRS FR-STO-005): outside a vault, every save of a part keeps a copy in the
// browser's private file system, mcad-snapshots/<document id>/<time>.mcadprt, the last 20 of them.
// Inside a vault its versions do this job instead.

export const SNAPSHOT_KEEP = 20;

export interface Snapshot { name: string; at: Date; size: number }

type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

async function folder(docId: string, create: boolean): Promise<Dir | null> {
  const nav = navigator as Navigator & { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
  if (!nav.storage?.getDirectory) return null;
  try {
    const root = await nav.storage.getDirectory();
    const all = await root.getDirectoryHandle("mcad-snapshots", { create });
    return (await all.getDirectoryHandle(docId.replace(/[^\w-]/g, "_"), { create })) as Dir;
  } catch { return null; }
}

/** Snapshots of a document, newest first. */
export async function snapshotList(docId: string): Promise<Snapshot[]> {
  const d = await folder(docId, false);
  if (!d) return [];
  const out: Snapshot[] = [];
  for await (const [name, h] of d.entries()) {
    const ms = parseInt(name, 10);
    if (h.kind !== "file" || !Number.isFinite(ms)) continue;
    const f = await (h as FileSystemFileHandle).getFile();
    out.push({ name, at: new Date(ms), size: f.size });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Keeps a copy of the saved bytes; the oldest beyond the limit go. Fails quietly where there is no private file system. */
export async function snapshotSave(docId: string, bytes: Uint8Array): Promise<boolean> {
  const d = await folder(docId, true);
  if (!d) return false;
  try {
    let ms = Date.now();
    const have = new Set((await snapshotList(docId)).map(s => s.name));
    while (have.has(`${ms}.mcadprt`)) ms++;
    const fh = await d.getFileHandle(`${ms}.mcadprt`, { create: true });
    const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(bytes as BlobPart);
    await w.close();
    for (const s of (await snapshotList(docId)).slice(SNAPSHOT_KEEP)) await d.removeEntry(s.name);
    return true;
  } catch { return false; }
}

export async function snapshotRead(docId: string, name: string): Promise<ArrayBuffer | null> {
  const d = await folder(docId, false);
  if (!d) return null;
  try { return await (await (await d.getFileHandle(name)).getFile()).arrayBuffer(); } catch { return null; }
}
