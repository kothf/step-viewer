// Assemblies that reference their part files (FR-ASM-003, FR-IO-011): Save writes the assembly and every part and
// sub-assembly it uses as files in one folder, and the assembly's `parts[k].link` names each file by its path
// (relative to the assembly's folder) and the SHA-256 of its bytes. Open and switching back to the assembly read
// the folder again, so a part edited in its own file updates every assembly that uses it. `doc`/`asm` stay in the
// assembly as the last loaded copy: an assembly sent alone, or a part file gone missing, still opens.
import { PART_EXT, packPart, toJson, unpackPart } from "../model/file";
import type { PartDoc } from "../model/types";
import { ASM_EXT, packAsm, unpackAsm } from "./file";
import { hashBytes } from "./links";
import type { AsmDoc } from "./types";

/** A folder the references are read from and written to; paths use "/" and are relative to it. */
export interface RefDir {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
}

/** The JSON of each referenced document as last read from or written to its file, by its path in the folder: what
 * the assembly has since changed in a document (Open part, Return to assembly) is what differs from it. */
export type RefBase = Map<string, string>;

type Entry = AsmDoc["parts"][string];

const norm = (p: string) => p.replace(/\\/g, "/").split("/").filter(s => s && s !== ".").join("/");
const dirOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
export const joinPath = (dir: string, p: string) => {
  const out: string[] = dir ? dir.split("/") : [];
  for (const s of norm(p).split("/")) { if (s === "..") out.pop(); else out.push(s); }
  return out.join("/");
};
const keyOf = (p: string) => p.toLowerCase();
// key order does not matter (files are written with sorted keys)
const jsonOf = (e: Entry) => toJson(e.asm ?? e.doc);

/** Toolbox fasteners are made from a table (like other CAD apps' toolbox parts): they stay inside the assembly. */
export function staysInside(e: Entry): boolean { return !e.asm && /^fastener:/.test(e.doc?.id ?? ""); }

/** What reading the references did. Names are the part entries' names; keys are top-level part keys. */
export interface ResolveResult {
  doc: AsmDoc;
  /** Names of documents taken in from their files because the file changed. */
  updated: string[];
  /** Top-level part keys whose file is not there (their copy is kept). */
  missing: string[];
  /** Names of documents changed both here and in their file: this assembly's version is kept. */
  conflicts: string[];
}

type Read = { doc: PartDoc; asm?: undefined } | { doc?: undefined; asm: AsmDoc };
async function readEntry(bytes: Uint8Array, asm: boolean): Promise<Read | null> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try { return asm ? { asm: await unpackAsm(buf) } : { doc: await unpackPart(buf) }; } catch { return null; }
}

/**
 * Reads every referenced file of `doc` (and of its sub-assemblies, relative to their own files) from `dir`.
 * A file whose hash differs from its reference replaces the copy, unless the copy was changed here since it was
 * last read (`base`), which keeps this assembly's version (a conflict). `base` is filled with what was read.
 * The document is not changed in place.
 */
export async function resolveRefs(doc: AsmDoc, dir: RefDir, base: RefBase, at = ""): Promise<ResolveResult> {
  const out: ResolveResult = { doc: structuredClone(doc), updated: [], missing: [], conflicts: [] };
  await resolveInto(out.doc, dir, base, at, out, true, new Set());
  return out;
}

async function resolveInto(doc: AsmDoc, dir: RefDir, base: RefBase, at: string, out: ResolveResult, top: boolean, seen: Set<string>) {
  for (const [key, e] of Object.entries(doc.parts)) {
    if (!e.link) continue;
    const path = joinPath(at, e.link.path), k = keyOf(path);
    if (seen.has(k)) continue;
    const bytes = await dir.read(path);
    if (!bytes) { if (top) out.missing.push(key); continue; }
    const hash = await hashBytes(bytes);
    if (hash !== e.link.hash) {
      const got = await readEntry(bytes, !!e.asm);
      if (!got) { if (top) out.missing.push(key); continue; }
      const was = base.get(k), now = jsonOf(e), disk = toJson(got.asm ?? got.doc);
      if (disk === now) { /* the same document (saved from here): only the hash moves on */ }
      else if (was !== undefined && was !== now) { out.conflicts.push(e.name); base.set(k, disk); continue; }
      else {
        if (got.asm) e.asm = got.asm; else e.doc = got.doc!;
        out.updated.push(e.name);
      }
      e.link.hash = hash;
      base.set(k, disk);
    } else if (!base.has(k)) base.set(k, jsonOf(e));
    if (e.asm) {
      seen.add(k);
      await resolveInto(e.asm, dir, base, dirOf(path), out, false, seen);
      seen.delete(k);
    }
  }
}

/** What saving the references wrote. */
export interface WriteResult {
  doc: AsmDoc;
  /** Paths written, in order (sub-assemblies' parts before them). */
  written: string[];
}

const SAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
function fileName(e: Entry): string {
  const ext = e.asm ? ASM_EXT : PART_EXT;
  const f = (e.file ?? "").split(/[\\/]/).at(-1) ?? "";
  const stem = (f.toLowerCase().endsWith(ext) ? f.slice(0, -ext.length) : (e.asm?.name || e.doc?.name || e.name || "Part")).replace(SAFE, "_").trim() || "Part";
  return `${stem}${ext}`;
}

/**
 * Writes the documents `doc` uses into `dir`, next to the assembly (`at` = the folder the assembly is in): an
 * entry with no reference gets a file named after it (another document's file of that name is never overwritten:
 * "Name (2)" is used then) and a reference to it; a referenced entry is written when it changed here since its
 * file was read (`base`) or its file is gone. Toolbox fasteners stay inside. Returns the document with the new
 * references and hashes; the assembly file itself is the caller's to write.
 */
export async function writeRefs(doc: AsmDoc, dir: RefDir, base: RefBase, app: string, at = "", asmName = ""): Promise<WriteResult> {
  const out: WriteResult = { doc: structuredClone(doc), written: [] };
  await writeInto(out.doc, dir, base, app, at, out, new Set(asmName ? [keyOf(joinPath(at, asmName))] : []));
  return out;
}

async function writeInto(doc: AsmDoc, dir: RefDir, base: RefBase, app: string, at: string, out: WriteResult, taken: Set<string>) {
  // the names this assembly's references already use are kept for them
  for (const e of Object.values(doc.parts)) if (e.link) taken.add(keyOf(joinPath(at, e.link.path)));
  for (const e of Object.values(doc.parts)) {
    if (staysInside(e) || (!e.doc && !e.asm)) continue;
    let path: string;
    if (e.link) path = joinPath(at, e.link.path);
    else {
      const want = fileName(e), stem = want.slice(0, want.lastIndexOf(".")), ext = want.slice(want.lastIndexOf("."));
      path = "";
      for (let n = 1; !path; n++) {
        const p = joinPath(at, n === 1 ? want : `${stem} (${n})${ext}`), k = keyOf(p);
        if (taken.has(k)) continue;
        // a file of this name that holds another document is somebody else's
        const old = await dir.read(p);
        if (old) {
          const got = await readEntry(old, !!e.asm);
          const id = got ? (got.asm ? got.asm.id : got.doc!.id) : null;
          if (!got || id !== (e.asm?.id ?? e.doc.id)) continue;
        }
        path = p;
      }
      taken.add(keyOf(path));
    }
    const k = keyOf(path);
    if (e.asm) await writeInto(e.asm, dir, base, app, dirOf(path), out, new Set([k]));
    const now = jsonOf(e);
    if (e.link) {
      const disk = await dir.read(path);
      if (disk && !base.has(k) && await hashBytes(disk) === e.link.hash) base.set(k, now);
      if (disk && base.get(k) === now) continue;
    }
    const bytes = e.asm ? await packAsm(e.asm, app) : await packPart(e.doc, app);
    await dir.write(path, bytes);
    out.written.push(path);
    const rel = at && path.startsWith(`${at}/`) ? path.slice(at.length + 1) : path;
    e.link = { path: e.link?.path ?? rel, hash: await hashBytes(bytes) };
    e.file = path.split("/").at(-1)!;
    base.set(k, now);
  }
}

/** A folder in memory (tests, and Pack and Go builds its zip from one). */
export function memDir(files = new Map<string, Uint8Array>()): RefDir & { files: Map<string, Uint8Array> } {
  return {
    files,
    async read(p) { return files.get(norm(p)) ?? null; },
    async write(p, d) { files.set(norm(p), d); },
  };
}

type DirH = FileSystemDirectoryHandle & { values?(): AsyncIterable<FileSystemHandle> };

/** A folder on disk through the File System Access API. */
export function fsaDir(root: FileSystemDirectoryHandle): RefDir {
  const walk = async (p: string, create: boolean): Promise<[DirH, string] | null> => {
    const parts = norm(p).split("/");
    const name = parts.pop()!;
    let d: DirH = root;
    try { for (const s of parts) d = await d.getDirectoryHandle(s, { create }); } catch { return null; }
    return [d, name];
  };
  return {
    async read(p) {
      const w = await walk(p, false);
      if (!w) return null;
      try { return new Uint8Array(await (await (await w[0].getFileHandle(w[1])).getFile()).arrayBuffer()); } catch { return null; }
    },
    async write(p, data) {
      const w = await walk(p, true);
      if (!w) throw new Error(`Could not write ${p}`);
      const h = await w[0].getFileHandle(w[1], { create: true }) as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> };
      const s = await h.createWritable();
      await s.write(data as BlobPart);
      await s.close();
    },
  };
}

/** The file handle of a path in a folder (Open part saves into it), or null. */
export async function fileIn(root: FileSystemDirectoryHandle, p: string): Promise<FileSystemFileHandle | null> {
  const parts = norm(p).split("/");
  const name = parts.pop()!;
  try {
    let d = root;
    for (const s of parts) d = await d.getDirectoryHandle(s);
    return await d.getFileHandle(name);
  } catch { return null; }
}

/** Does the document reference any file (or have parts that would get one on Save)? */
export function hasRefs(doc: AsmDoc): boolean { return Object.values(doc.parts).some(e => !!e.link); }
