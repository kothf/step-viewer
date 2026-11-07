// Local vault (FRS 12.5, P2): versions, check-out/check-in, history, roll back and an audit trail,
// kept beside the working files in a hidden `.mcadvault/` folder.
//
// The vault lives in a directory: a folder the user picked (File System Access) or a folder in the
// browser's private file system (OPFS), both reached through the same `VDir` interface (and an
// in-memory one for tests). Every version's bytes are stored once by their SHA-256
// (`objects/<sha>`); each file has a record `files/<id>.json`; every action appends its own entry to
// `log/` (append-only, so concurrent writers never overwrite each other, FR-PDM-071).

/** The little a vault needs from a directory. Names are single path segments. */
export interface VDir {
  readonly name: string;
  dir(name: string, create?: boolean): Promise<VDir | null>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array | string): Promise<void>;
  list(): Promise<{ name: string; kind: "file" | "dir" }[]>;
  remove(name: string): Promise<void>;
}

export const STORE = ".mcadvault";
export const DEFAULT_STATE = "Work in progress";

export interface VaultInfo { format: "mobiuscad-vault"; version: 1; name: string; created: string; users: string[]; commentRequired: boolean }
export interface VersionRec { n: number; sha: string; size: number; at: string; user: string; comment: string; state: string; rolledBackFrom?: number; /** Content dropped by Purge old versions (the row stays in the history). */ purged?: boolean }
export interface CheckOut { user: string; at: string; computer: string }
export interface FileRec { id: string; path: string; kind: string; created: string; state: string; versions: VersionRec[]; checkout?: CheckOut }
export interface LogEntry { at: string; seq?: number; user: string; action: string; file?: string; path?: string; version?: number; details?: string }

export class VaultError extends Error {}

const enc = new TextEncoder(), dec = new TextDecoder();
const bytesOf = (d: Uint8Array | string) => (typeof d === "string" ? enc.encode(d) : d);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export async function sha256(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The kind of a file by its extension: MöbiusCAD documents, or a foreign file (FR-PDM-004). */
export function kindOf(path: string) {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return ({ mcadprt: "part", mcadasm: "assembly", mcaddrw: "drawing", step: "STEP", stp: "STEP", pdf: "PDF", dxf: "DXF", png: "image", jpg: "image", jpeg: "image", csv: "spreadsheet", xlsx: "spreadsheet" } as Record<string, string>)[ext] ?? "file";
}

const newId = () => {
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  return [...r].map(b => b.toString(16).padStart(2, "0")).join("");
};

/** Splits "a/b/c.mcadprt" into folders and a file name; refuses empty segments and "..". */
function splitPath(path: string) {
  const parts = path.split("/").map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.some(p => p === "." || p === ".." || p === STORE)) throw new VaultError(`Invalid file name: ${path}`);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
}

export class Vault {
  private constructor(readonly root: VDir, private store: VDir, public info: VaultInfo, public user: string, public computer: string) {}

  /** Makes a vault in an empty (or not yet vaulted) directory (FR-PDM-001). */
  static async create(root: VDir, name: string, user: string, computer: string): Promise<Vault> {
    if (await root.dir(STORE, false)) throw new VaultError("This folder already holds a vault: open it instead.");
    const store = (await root.dir(STORE, true))!;
    const info: VaultInfo = { format: "mobiuscad-vault", version: 1, name: name.trim() || root.name, created: new Date().toISOString(), users: [user], commentRequired: true };
    await store.write("vault.json", json(info));
    for (const d of ["objects", "files", "log"]) await store.dir(d, true);
    const v = new Vault(root, store, info, user, computer);
    await v.log("create vault", { details: info.name });
    return v;
  }

  static async open(root: VDir, user: string, computer: string): Promise<Vault> {
    const store = await root.dir(STORE, false);
    const raw = store && await store.read("vault.json");
    if (!store || !raw) throw new VaultError("This folder is not a vault.");
    const info = JSON.parse(dec.decode(raw)) as VaultInfo;
    if (info.format !== "mobiuscad-vault") throw new VaultError("This folder is not a vault.");
    const v = new Vault(root, store, info, user, computer);
    if (!info.users.includes(user)) { info.users.push(user); await store.write("vault.json", json(info)); }
    return v;
  }

  /** Orders entries written in the same millisecond. */
  private seq = 0;

  private async sub(name: string) { return (await this.store.dir(name, true))!; }

  // ---------- records ----------

  async files(): Promise<FileRec[]> {
    const dir = await this.sub("files");
    const out: FileRec[] = [];
    for (const e of await dir.list()) {
      if (e.kind !== "file" || !e.name.endsWith(".json")) continue;
      const raw = await dir.read(e.name);
      if (raw) { try { out.push(JSON.parse(dec.decode(raw))); } catch { /* a damaged record: the integrity check reports it */ } }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async file(id: string): Promise<FileRec> {
    const raw = await (await this.sub("files")).read(`${id}.json`);
    if (!raw) throw new VaultError("The file is not in the vault.");
    return JSON.parse(dec.decode(raw));
  }

  async byPath(path: string): Promise<FileRec | null> {
    const p = path.toLowerCase();
    return (await this.files()).find(f => f.path.toLowerCase() === p) ?? null;
  }

  private async saveRec(f: FileRec) { await (await this.sub("files")).write(`${f.id}.json`, json(f)); }

  private async log(action: string, e: Omit<LogEntry, "at" | "user" | "action"> = {}) {
    const at = new Date().toISOString();
    const entry: LogEntry = { at, seq: this.seq++, user: this.user, action, ...e };
    await (await this.sub("log")).write(`${at.replace(/[:.]/g, "-")}-${newId()}.json`, json(entry));
  }

  async auditTrail(fileId?: string): Promise<LogEntry[]> {
    const dir = await this.sub("log");
    const out: LogEntry[] = [];
    for (const e of await dir.list()) {
      if (e.kind !== "file") continue;
      const raw = await dir.read(e.name);
      if (!raw) continue;
      try { const x = JSON.parse(dec.decode(raw)) as LogEntry; if (!fileId || x.file === fileId) out.push(x); } catch { /* skip */ }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0));
  }

  // ---------- objects and working copies ----------

  private async putObject(data: Uint8Array) {
    const sha = await sha256(data);
    const objs = await this.sub("objects");
    if (!(await objs.read(sha))) await objs.write(sha, data);
    return sha;
  }

  async object(sha: string): Promise<Uint8Array> {
    const d = await (await this.sub("objects")).read(sha);
    if (!d) throw new VaultError("A stored version is missing from the vault (run the integrity check).");
    return d;
  }

  private async folderOf(path: string, create: boolean) {
    const { dirs, name } = splitPath(path);
    let d: VDir | null = this.root;
    for (const s of dirs) { d = await d.dir(s, create); if (!d) return { dir: null, name }; }
    return { dir: d, name };
  }

  /** The local (working) copy of a file, as it is in the vault folder. */
  async working(path: string): Promise<Uint8Array | null> {
    const { dir, name } = await this.folderOf(path, false);
    return dir ? dir.read(name) : null;
  }

  private async writeWorking(path: string, data: Uint8Array) {
    const { dir, name } = await this.folderOf(path, true);
    await dir!.write(name, data);
  }

  latest(f: FileRec) { return f.versions[f.versions.length - 1]; }

  /** Badge facts for a file (FR-PDM-016). */
  async status(f: FileRec) {
    const w = await this.working(f.path);
    const sha = w ? await sha256(w) : null;
    return {
      mine: f.checkout?.user === this.user && f.checkout.computer === this.computer,
      by: f.checkout?.user ?? null,
      modified: !!sha && sha !== this.latest(f).sha,
      missing: !w,
    };
  }

  // ---------- commands ----------

  /** Adds a new file at version 1 (FR-PDM-003). The working copy is written, and the file is not checked out. */
  async add(path: string, data: Uint8Array, comment = "Added"): Promise<FileRec> {
    splitPath(path);
    if (await this.byPath(path)) throw new VaultError(`${path} is already in the vault.`);
    const sha = await this.putObject(data);
    const at = new Date().toISOString();
    const f: FileRec = { id: newId(), path, kind: kindOf(path), created: at, state: DEFAULT_STATE, versions: [{ n: 1, sha, size: data.length, at, user: this.user, comment, state: DEFAULT_STATE }] };
    await this.writeWorking(path, data);
    await this.saveRec(f);
    await this.log("add", { file: f.id, path, version: 1, details: comment });
    return f;
  }

  /** Check out (FR-PDM-010): the file becomes editable here; others see the lock. */
  async checkOut(id: string): Promise<FileRec> {
    const f = await this.file(id);
    if (f.checkout) {
      if (f.checkout.user === this.user && f.checkout.computer === this.computer) return f;
      throw new VaultError(`Checked out by ${f.checkout.user}.`);
    }
    f.checkout = { user: this.user, at: new Date().toISOString(), computer: this.computer };
    await this.saveRec(f);
    await this.log("check out", { file: id, path: f.path, version: this.latest(f).n });
    return f;
  }

  private mineOrThrow(f: FileRec) {
    if (!f.checkout) throw new VaultError("Check the file out first.");
    if (f.checkout.user !== this.user || f.checkout.computer !== this.computer) throw new VaultError(`Checked out by ${f.checkout.user}.`);
  }

  /** Saves the working copy of a file checked out here (no new version). */
  async saveWorking(id: string, data: Uint8Array) {
    const f = await this.file(id);
    this.mineOrThrow(f);
    await this.writeWorking(f.path, data);
  }

  /**
   * Check in (FR-PDM-011): the working copy becomes the next version, unless it is unchanged.
   * Returns the new version number, or null when nothing changed (the lock is still released unless kept).
   */
  async checkIn(id: string, comment: string, keep = false): Promise<number | null> {
    const f = await this.file(id);
    this.mineOrThrow(f);
    if (this.info.commentRequired && !comment.trim()) throw new VaultError("A check-in needs a comment.");
    const data = await this.working(f.path);
    if (!data) throw new VaultError("The local copy is missing.");
    const sha = await this.putObject(data);
    let n: number | null = null;
    if (sha !== this.latest(f).sha) {
      n = this.latest(f).n + 1;
      f.versions.push({ n, sha, size: data.length, at: new Date().toISOString(), user: this.user, comment: comment.trim(), state: f.state });
    }
    if (!keep) delete f.checkout;
    await this.saveRec(f);
    await this.log("check in", { file: id, path: f.path, version: n ?? this.latest(f).n, details: n ? comment.trim() : "unchanged" });
    return n;
  }

  /** Undo check-out (FR-PDM-012): local changes go, the latest version comes back, the lock is released. */
  async undoCheckOut(id: string) {
    const f = await this.file(id);
    this.mineOrThrow(f);
    await this.writeWorking(f.path, await this.object(this.latest(f).sha));
    delete f.checkout;
    await this.saveRec(f);
    await this.log("undo check out", { file: id, path: f.path, version: this.latest(f).n });
  }

  async versionBytes(id: string, n: number): Promise<Uint8Array> {
    const f = await this.file(id);
    const v = f.versions.find(x => x.n === n);
    if (!v) throw new VaultError(`Version ${n} does not exist.`);
    if (v.purged) throw new VaultError("This version was purged: only its history entry is kept.");
    return this.object(v.sha);
  }

  /** Get latest (FR-PDM-015): the working copy becomes the latest version (refused over local changes unless forced). */
  async getLatest(id: string, force = false) {
    const f = await this.file(id);
    const st = await this.status(f);
    if (st.modified && !force) throw new VaultError("The local copy has changes that are not checked in.");
    await this.writeWorking(f.path, await this.object(this.latest(f).sha));
    await this.log("get latest", { file: id, path: f.path, version: this.latest(f).n });
  }

  /** Roll back (FR-PDM-014): a new version with an older version's content; history is never rewritten. */
  async rollBack(id: string, n: number): Promise<number> {
    const f = await this.file(id);
    if (f.checkout && (f.checkout.user !== this.user || f.checkout.computer !== this.computer)) throw new VaultError(`Checked out by ${f.checkout.user}.`);
    const v = f.versions.find(x => x.n === n);
    if (!v) throw new VaultError(`Version ${n} does not exist.`);
    if (v.purged) throw new VaultError("This version was purged: only its history entry is kept.");
    const m = this.latest(f).n + 1;
    f.versions.push({ n: m, sha: v.sha, size: v.size, at: new Date().toISOString(), user: this.user, comment: `Rolled back to version ${n}`, state: f.state, rolledBackFrom: n });
    await this.writeWorking(f.path, await this.object(v.sha));
    await this.saveRec(f);
    await this.log("roll back", { file: id, path: f.path, version: m, details: `from version ${n}` });
    return m;
  }

  // ---------- backup, storage (FR-PDM-007/008) ----------

  /**
   * Everything needed to rebuild the vault elsewhere, as ZIP entries: settings, file records, the log, the
   * stored versions (all, or only the latest of each file) and the working copies at their paths.
   */
  async exportEntries(latestOnly = false): Promise<{ name: string; data: Uint8Array }[]> {
    const out: { name: string; data: Uint8Array }[] = [];
    const files = await this.files();
    out.push({ name: `${STORE}/vault.json`, data: enc.encode(json(this.info)) });
    const shas = new Set<string>();
    for (const f of files) {
      const rec = latestOnly ? { ...f, versions: f.versions.map(v => (v === this.latest(f) ? v : { ...v, purged: true })) } : f;
      out.push({ name: `${STORE}/files/${f.id}.json`, data: enc.encode(json(rec)) });
      for (const v of rec.versions) if (!v.purged) shas.add(v.sha);
      const w = await this.working(f.path);
      if (w) out.push({ name: f.path, data: w });
    }
    for (const sha of shas) out.push({ name: `${STORE}/objects/${sha}`, data: await this.object(sha) });
    const log = await this.sub("log");
    for (const e of await log.list()) { const d = e.kind === "file" && await log.read(e.name); if (d) out.push({ name: `${STORE}/log/${e.name}`, data: d }); }
    await this.log("export", { details: latestOnly ? "latest versions" : "all versions" });
    return out;
  }

  /** Rebuilds a vault from exported entries in an empty directory (FR-PDM-007). */
  static async importEntries(root: VDir, entries: Map<string, Uint8Array>, user: string, computer: string): Promise<Vault> {
    if (await root.dir(STORE, false)) throw new VaultError("This folder already holds a vault: open it instead.");
    if (!entries.get(`${STORE}/vault.json`)) throw new VaultError("Not a vault backup.");
    for (const [name, data] of entries) {
      const parts = name.split("/").filter(Boolean);
      if (!parts.length || parts.some(p => p === "." || p === "..")) continue;
      let d: VDir | null = root;
      for (const seg of parts.slice(0, -1)) d = await d!.dir(seg, true);
      await d!.write(parts[parts.length - 1], data);
    }
    const v = await Vault.open(root, user, computer);
    await v.log("import", { details: `${entries.size} entries` });
    return v;
  }

  /** Storage report (FR-PDM-008): bytes kept per file, each stored object counted once. */
  async storage(): Promise<{ path: string; id: string; versions: number; kept: number; bytes: number }[]> {
    const seen = new Set<string>();
    return (await this.files()).map(f => {
      let bytes = 0;
      for (const v of f.versions) if (!v.purged && !seen.has(v.sha)) { seen.add(v.sha); bytes += v.size; }
      return { path: f.path, id: f.id, versions: f.versions.length, kept: f.versions.filter(v => !v.purged).length, bytes };
    });
  }

  /**
   * Purge old versions (FR-PDM-008): keeps the last `keep` versions of each file; older ones keep their row in the
   * history but lose their content, and objects no version needs any more are deleted. Returns bytes freed.
   */
  async purge(keep: number): Promise<number> {
    keep = Math.max(1, Math.floor(keep));
    const files = await this.files();
    for (const f of files) {
      let changed = false;
      f.versions.forEach((v, i) => { if (i < f.versions.length - keep && !v.purged) { v.purged = true; changed = true; } });
      if (changed) await this.saveRec(f);
    }
    const used = new Set(files.flatMap(f => f.versions.filter(v => !v.purged).map(v => v.sha)));
    const objs = await this.sub("objects");
    let freed = 0;
    for (const e of await objs.list()) {
      if (e.kind !== "file" || used.has(e.name)) continue;
      freed += (await objs.read(e.name))?.length ?? 0;
      await objs.remove(e.name);
    }
    await this.log("purge", { details: `kept the last ${keep} versions, freed ${freed} bytes` });
    return freed;
  }

  /** Integrity check (FR-PDM-006): stored versions present and matching their hashes, objects nobody uses. */
  async verify(): Promise<{ missing: string[]; corrupt: string[]; orphans: string[]; files: number; objects: number }> {
    const files = await this.files();
    const used = new Set(files.flatMap(f => f.versions.filter(v => !v.purged).map(v => v.sha)));
    const objs = await this.sub("objects");
    const have = new Set((await objs.list()).filter(e => e.kind === "file").map(e => e.name));
    const missing: string[] = [], corrupt: string[] = [];
    for (const f of files) for (const v of f.versions) {
      if (v.purged) continue;
      if (!have.has(v.sha)) { missing.push(`${f.path} v${v.n}`); continue; }
      const d = await objs.read(v.sha);
      if (!d || await sha256(d) !== v.sha) corrupt.push(`${f.path} v${v.n}`);
    }
    const orphans = [...have].filter(s => !used.has(s));
    return { missing, corrupt, orphans, files: files.length, objects: have.size };
  }
}

// ---------- directories ----------

/** An in-memory directory (tests, and a fallback where the browser has no private file system). */
export function memDir(name = "vault"): VDir {
  const files = new Map<string, Uint8Array>(), dirs = new Map<string, VDir>();
  return {
    name,
    async dir(n, create = false) { let d = dirs.get(n); if (!d && create) { d = memDir(n); dirs.set(n, d); } return d ?? null; },
    async read(n) { return files.get(n) ?? null; },
    async write(n, data) { files.set(n, bytesOf(data).slice()); },
    async list() { return [...[...files.keys()].map(n => ({ name: n, kind: "file" as const })), ...[...dirs.keys()].map(n => ({ name: n, kind: "dir" as const }))]; },
    async remove(n) { files.delete(n); dirs.delete(n); },
  };
}

type DirHandle = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

/** A folder through the File System Access API: one the user picked, or one in OPFS. */
export function fsaDir(h: FileSystemDirectoryHandle): VDir {
  const hd = h as DirHandle;
  return {
    name: h.name,
    async dir(n, create = false) {
      try { return fsaDir(await h.getDirectoryHandle(n, { create })); } catch (e) { if ((e as Error).name === "NotFoundError" || (e as Error).name === "TypeMismatchError") return null; throw e; }
    },
    async read(n) {
      try { return new Uint8Array(await (await (await h.getFileHandle(n)).getFile()).arrayBuffer()); } catch (e) { if ((e as Error).name === "NotFoundError" || (e as Error).name === "TypeMismatchError") return null; throw e; }
    },
    async write(n, data) {
      const fh = await h.getFileHandle(n, { create: true });
      const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await w.write(bytesOf(data) as BufferSource);
      await w.close();
    },
    async list() {
      const out: { name: string; kind: "file" | "dir" }[] = [];
      for await (const [n, x] of hd.entries()) out.push({ name: n, kind: x.kind === "directory" ? "dir" : "file" });
      return out;
    },
    async remove(n) { await h.removeEntry(n, { recursive: true }); },
  };
}

/** Working files of the vault folder that are not in the vault yet (for "Add to vault"). */
export async function unvaulted(v: Vault): Promise<string[]> {
  const known = new Set((await v.files()).map(f => f.path.toLowerCase()));
  const out: string[] = [];
  const walk = async (d: VDir, prefix: string, depth: number) => {
    for (const e of await d.list()) {
      if (e.name === STORE || e.name.startsWith(".")) continue;
      const p = prefix + e.name;
      if (e.kind === "dir") { if (depth < 6) { const s = await d.dir(e.name); if (s) await walk(s, `${p}/`, depth + 1); } }
      else if (!known.has(p.toLowerCase())) out.push(p);
    }
  };
  await walk(v.root, "", 0);
  return out.sort();
}
