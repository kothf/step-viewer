// Local vault (FRS 12.5, P2): versions, check-out/check-in, history, roll back and an audit trail,
// kept beside the working files in a hidden `.mcadvault/` folder.
//
// The vault lives in a directory: a folder the user picked (File System Access) or a folder in the
// browser's private file system (OPFS), both reached through the same `VDir` interface (and an
// in-memory one for tests). Every version's bytes are stored once by their SHA-256
// (`objects/<sha>`); each file has a record `files/<id>.json`; every action appends its own entry to
// `log/` (append-only, so concurrent writers never overwrite each other, FR-PDM-071).

import { defaultCards, defaultWorkflow, formatNumber, PART_NUMBER, preLabel, revLabel, revIndex, ROLES, type CardField, type Numbering, type RevScheme, type Role, type Workflow, type WfTransition } from "./workflow";
import { docRefs, featureDiff, readProps, relPath, resolveRel, rewriteRefs, writeProps } from "./codec";

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

export interface SavedSearch { name: string; q: SearchQuery }
export interface VaultInfo {
  format: "mobiuscad-vault"; version: 1; name: string; created: string; users: string[]; commentRequired: boolean;
  /** Lifecycle settings (FRS 12.5.4/12.5.5); absent: the defaults. */
  revScheme?: RevScheme; workflow?: Workflow; cards?: Record<string, CardField[]>; numbering?: Numbering;
  /** Roles per user name in a shared vault (FR-PDM-037); a personal vault gives its one user every role. */
  roles?: Record<string, Role[]>; shared?: boolean;
  searches?: SavedSearch[];
}
/** A reference from one version to another file (FR-PDM-020): the version it was checked in against, and how many. */
export interface RefRec { id: string; path: string; version: number; qty: number }
export interface VersionRec {
  n: number; sha: string; size: number; at: string; user: string; comment: string; state: string; rolledBackFrom?: number;
  /** Content dropped by Purge old versions (the row stays in the history). */ purged?: boolean;
  /** Revision label given to this version (FR-PDM-030); `pre`: a pre-release label. */ rev?: string; pre?: boolean; approvedBy?: string;
  refs?: RefRec[]; card?: Record<string, string>;
}
export interface CheckOut { user: string; at: string; computer: string }
export interface FileRec {
  id: string; path: string; kind: string; created: string; state: string; versions: VersionRec[]; checkout?: CheckOut;
  /** The current revision label (the last given). */ revision?: string;
  /** Data card values (FR-PDM-040). */ card?: Record<string, string>;
  /** In the recycle bin (FR-PDM-025). */ deleted?: { at: string; user: string };
  copiedFrom?: { id: string; version: number };
}
export interface SearchQuery {
  text?: string; state?: string; revision?: string; checkedOutBy?: string; kind?: string;
  /** ISO dates: the latest version's date range. */ from?: string; to?: string;
  /** Data card fields that must contain the value (case-insensitive). */ fields?: Record<string, string>;
  /** "Contains material = Aluminium": a file anywhere in the file's references has this data card value. */ contains?: { field: string; value: string };
}
export interface TreeNode { id: string; path: string; version: number; qty: number; rev?: string; state: string; children: TreeNode[]; cycle?: boolean; missing?: boolean }
export type Resolve = "built" | "latest" | "released";
export interface LogEntry { at: string; seq?: number; user: string; action: string; file?: string; path?: string; version?: number; details?: string }

/** A message kept as an English key and its values, so the UI can translate it (`t(key, p)`). */
export interface Msg { key: string; p?: Record<string, string | number> }
export const fmtMsg = (m: Msg) => m.key.replace(/\{(\w+)\}/g, (x, k: string) => (m.p && k in m.p ? String(m.p[k]) : x));

export class VaultError extends Error {
  constructor(readonly key: string, readonly params: Record<string, string | number> = {}) { super(fmtMsg({ key, p: params })); }
}


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
  if (!parts.length || parts.some(p => p === "." || p === ".." || p === STORE)) throw new VaultError("Invalid file name: {path}", { path });
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

  /** Vault files; those in the recycle bin only with `withDeleted`. */
  async files(withDeleted = false): Promise<FileRec[]> {
    const dir = await this.sub("files");
    const out: FileRec[] = [];
    for (const e of await dir.list()) {
      if (e.kind !== "file" || !e.name.endsWith(".json")) continue;
      const raw = await dir.read(e.name);
      if (raw) { try { const f = JSON.parse(dec.decode(raw)) as FileRec; if (withDeleted || !f.deleted) out.push(f); } catch { /* a damaged record: the integrity check reports it */ } }
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
  async add(path: string, data: Uint8Array, comment = "Added", card0: Record<string, string> = {}, extra?: Partial<FileRec>): Promise<FileRec> {
    splitPath(path);
    if (await this.byPath(path)) throw new VaultError("{path} is already in the vault.", { path });
    const at = new Date().toISOString(), state = this.workflow.initial;
    // The data card starts from the document's properties and the field defaults; a new number when the scheme says so.
    const card = this.cardFromProps(kindOf(path), await readProps(path, data), card0);
    if (this.numbering.onAdd && !card[PART_NUMBER] && this.cardFields(kindOf(path)).some(x => x.name === PART_NUMBER)) {
      card[PART_NUMBER] = await this.issueNumber(card);
      data = await this.withCardProps(path, data, card);
    }
    const sha = await this.putObject(data);
    const refs = await this.indexRefs(path, data);
    const f: FileRec = { id: newId(), path, kind: kindOf(path), created: at, state, card, versions: [{ n: 1, sha, size: data.length, at, user: this.user, comment, state, refs, card: { ...card } }] };
    if (extra) Object.assign(f, extra);
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
      throw new VaultError("Checked out by {user}.", { user: f.checkout.user });
    }
    if (!this.stateOf(f.state).checkout) throw new VaultError("A file in the state {state} cannot be checked out.", { state: f.state });
    f.checkout = { user: this.user, at: new Date().toISOString(), computer: this.computer };
    await this.saveRec(f);
    await this.log("check out", { file: id, path: f.path, version: this.latest(f).n });
    return f;
  }

  private mineOrThrow(f: FileRec) {
    if (!f.checkout) throw new VaultError("Check the file out first.");
    if (f.checkout.user !== this.user || f.checkout.computer !== this.computer) throw new VaultError("Checked out by {user}.", { user: f.checkout.user });
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
      // Properties edited in the document come back into the data card (both ways, FR-PDM-040).
      f.card = this.cardFromProps(f.kind, await readProps(f.path, data), f.card ?? {});
      f.versions.push({ n, sha, size: data.length, at: new Date().toISOString(), user: this.user, comment: comment.trim(), state: f.state, refs: await this.indexRefs(f.path, data), card: { ...f.card } });
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
    if (!v) throw new VaultError("Version {n} does not exist.", { n });
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
    if (f.checkout && (f.checkout.user !== this.user || f.checkout.computer !== this.computer)) throw new VaultError("Checked out by {user}.", { user: f.checkout.user });
    if (!this.stateOf(f.state).checkout) throw new VaultError("A file in the state {state} cannot be changed.", { state: f.state });
    const v = f.versions.find(x => x.n === n);
    if (!v) throw new VaultError("Version {n} does not exist.", { n });
    if (v.purged) throw new VaultError("This version was purged: only its history entry is kept.");
    const m = this.latest(f).n + 1;
    f.versions.push({ n: m, sha: v.sha, size: v.size, at: new Date().toISOString(), user: this.user, comment: `Rolled back to version ${n}`, state: f.state, rolledBackFrom: n, refs: v.refs, card: v.card });
    await this.writeWorking(f.path, await this.object(v.sha));
    await this.saveRec(f);
    await this.log("roll back", { file: id, path: f.path, version: m, details: `from version ${n}` });
    return m;
  }

  // ---------- settings (FR-PDM-030/035/037/040/041) ----------

  get revScheme(): RevScheme { return this.info.revScheme ?? { kind: "letters", skip: true, pre: "none" }; }
  get workflow(): Workflow { return this.info.workflow ?? defaultWorkflow(); }
  get numbering(): Numbering { return this.info.numbering ?? { pattern: "MC-{YYYY}-{0000}", onAdd: false }; }

  stateOf(name: string) {
    return this.workflow.states.find(s => s.name === name) ?? { name, color: "#6b7280", checkout: true };
  }

  /** Data card fields for a file kind (the kind's own card, else the default "*"). */
  cardFields(kind: string): CardField[] {
    const c = this.info.cards ?? defaultCards();
    return c[kind] ?? c["*"] ?? [];
  }

  /** Roles of a user (FR-PDM-037): every role in a personal vault, and for the vault's creator. */
  rolesOf(user = this.user): Role[] {
    if (!this.info.shared || this.info.users[0] === user) return [...ROLES];
    return this.info.roles?.[user] ?? ["Designer"];
  }
  has(role: Role) { return this.rolesOf().includes(role); }

  /** Changes vault settings (Admin); logged as a settings change (FR-PDM-060). */
  async saveSettings(patch: Partial<Pick<VaultInfo, "revScheme" | "workflow" | "cards" | "numbering" | "roles" | "shared" | "commentRequired" | "searches" | "name">>, what = "settings") {
    if (what !== "saved search" && !this.has("Admin")) throw new VaultError("Only an Admin can change the vault settings.");
    if (patch.workflow) {
      const w = patch.workflow, names = new Set(w.states.map(s => s.name));
      if (!w.states.length || !names.has(w.initial) || w.transitions.some(x => !names.has(x.from) || !names.has(x.to))) throw new VaultError("The workflow has a transition to or from an unknown state.");
    }
    const fresh = await this.store.read("vault.json");
    if (fresh) { try { this.info = { ...JSON.parse(dec.decode(fresh)), users: this.info.users }; } catch { /* keep ours */ } }
    Object.assign(this.info, patch);
    await this.store.write("vault.json", json(this.info));
    await this.log(what === "saved search" ? "save search" : "settings", { details: Object.keys(patch).join(", ") });
  }

  // ---------- data cards and numbering (FR-PDM-040/041) ----------

  /** Card values from document properties (mapped fields), over the given values and the defaults. */
  private cardFromProps(kind: string, props: Record<string, string> | null, base: Record<string, string>) {
    const card: Record<string, string> = {};
    for (const fd of this.cardFields(kind)) {
      const p = fd.prop && props?.[fd.prop];
      card[fd.name] = p || base[fd.name] || (fd.default ?? "");
    }
    for (const [k, v] of Object.entries(base)) if (!(k in card)) card[k] = v;
    return card;
  }

  /** The document with the card's mapped fields written into its properties (unchanged bytes for other files). */
  private async withCardProps(path: string, data: Uint8Array, card: Record<string, string>, extra: Record<string, string> = {}) {
    const vals: Record<string, string> = { ...extra };
    for (const fd of this.cardFields(kindOf(path))) if (fd.prop) vals[fd.prop] = card[fd.name] ?? "";
    return (await writeProps(path, data, vals)) ?? data;
  }

  private checkCardValue(fd: CardField, v: string) {
    if (!v) return;
    if (fd.type === "number" && !Number.isFinite(Number(v))) throw new VaultError("{field} must be a number.", { field: fd.name });
    if (fd.type === "date" && Number.isNaN(Date.parse(v))) throw new VaultError("{field} must be a date.", { field: fd.name });
    if (fd.type === "list" && fd.options?.length && !fd.options.includes(v)) throw new VaultError("{field} must be one of: {list}.", { field: fd.name, list: fd.options.join(", ") });
    if (fd.type === "checkbox" && v !== "true" && v !== "false") throw new VaultError("{field} must be ticked or not.", { field: fd.name });
  }

  /** Edits the data card of a file checked out here; mapped fields go into the working copy's properties. */
  async setCard(id: string, values: Record<string, string>) {
    const f = await this.file(id);
    this.mineOrThrow(f);
    const fields = this.cardFields(f.kind);
    for (const fd of fields) if (fd.name in values) this.checkCardValue(fd, values[fd.name].trim());
    const card = { ...(f.card ?? {}) };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(values)) if ((card[k] ?? "") !== v.trim()) { card[k] = v.trim(); changed.push(k); }
    if (!changed.length) return f;
    f.card = card;
    const w = await this.working(f.path);
    if (w) { const nb = await this.withCardProps(f.path, w, card); if (nb !== w) await this.writeWorking(f.path, nb); }
    await this.saveRec(f);
    await this.log("data card", { file: id, path: f.path, details: changed.join(", ") });
    return f;
  }

  /** Issues the next number of the vault's numbering scheme (FR-PDM-041); numbers are never reused. */
  async issueNumber(card: Record<string, string> = {}): Promise<string> {
    const dir = await this.sub("numbers");
    let max = 0;
    for (const e of await dir.list()) { const n = parseInt(e.name, 10); if (n > max) max = n; }
    const n = max + 1;
    const value = formatNumber(this.numbering.pattern, n, card);
    // Its own record, named by the counter: concurrent writers never overwrite each other (FR-PDM-071).
    await dir.write(`${String(n).padStart(8, "0")}-${newId()}.json`, json({ n, value, at: new Date().toISOString(), user: this.user }));
    await this.log("issue number", { details: value });
    return value;
  }

  /** Gives a checked-out file a new part number from the scheme. */
  async assignNumber(id: string): Promise<string> {
    const f = await this.file(id);
    this.mineOrThrow(f);
    const value = await this.issueNumber(f.card);
    await this.setCard(id, { [PART_NUMBER]: value });
    return value;
  }

  // ---------- references (FR-PDM-020/021) ----------

  /** The references a document makes, resolved to vault files at their latest versions. */
  private async indexRefs(path: string, data: Uint8Array): Promise<RefRec[]> {
    const refs = await docRefs(path, data);
    if (!refs.length) return [];
    const files = await this.files();
    const out: RefRec[] = [];
    for (const r of refs) {
      const target = resolveRel(path, r.path);
      const f = target ? files.find(x => x.path.toLowerCase() === target.toLowerCase()) : undefined;
      out.push({ id: f?.id ?? "", path: r.path, version: f ? this.latest(f).n : 0, qty: r.qty });
    }
    return out;
  }

  /** The version of a referenced file a parent resolves to (FR-PDM-022). */
  private pick(f: FileRec, ref: RefRec | null, mode: Resolve): VersionRec {
    if (mode === "built" && ref) return f.versions.find(v => v.n === ref.version) ?? this.latest(f);
    if (mode === "released") return this.released(f) ?? this.latest(f);
    return this.latest(f);
  }

  /** The latest released revision's version, if any. */
  released(f: FileRec): VersionRec | null {
    for (let i = f.versions.length - 1; i >= 0; i--) if (f.versions[i].rev && !f.versions[i].pre) return f.versions[i];
    return null;
  }

  /** Contains (FR-PDM-021): the reference tree of a file at a version, components resolved as checked in, latest or latest released. */
  async contains(id: string, version?: number, mode: Resolve = "built"): Promise<TreeNode> {
    const all = new Map((await this.files(true)).map(f => [f.id, f]));
    const node = (f: FileRec, v: VersionRec, qty: number, seen: Set<string>): TreeNode => {
      const n: TreeNode = { id: f.id, path: f.path, version: v.n, qty, rev: this.revAt(f, v.n), state: f.state, children: [] };
      if (seen.has(f.id)) { n.cycle = true; return n; }
      const s2 = new Set(seen).add(f.id);
      for (const r of v.refs ?? []) {
        const c = all.get(r.id);
        if (!c) { n.children.push({ id: "", path: r.path, version: 0, qty: r.qty, state: "", children: [], missing: true }); continue; }
        n.children.push(node(c, this.pick(c, r, mode), r.qty, s2));
      }
      return n;
    };
    const f = all.get(id);
    if (!f) throw new VaultError("The file is not in the vault.");
    const v = version ? f.versions.find(x => x.n === version) : this.latest(f);
    if (!v) throw new VaultError("Version {n} does not exist.", { n: version ?? 0 });
    return node(f, v, 1, new Set());
  }

  /** The revision label in force at a version (the last label given at or before it). */
  revAt(f: FileRec, n: number) {
    let r: string | undefined;
    for (const v of f.versions) { if (v.n > n) break; if (v.rev) r = v.rev; }
    return r;
  }

  /**
   * Where used (FR-PDM-021): files whose latest version (or, with `anyVersion`, any version) references this one,
   * as a tree up to the top-level files, with the quantity and the version each one uses.
   */
  async whereUsed(id: string, anyVersion = false): Promise<TreeNode[]> {
    const files = await this.files(anyVersion);
    const up = (target: string, seen: Set<string>): TreeNode[] => {
      const out: TreeNode[] = [];
      for (const f of files) {
        const vs = anyVersion ? f.versions : [this.latest(f)];
        const hit = [...vs].reverse().map(v => ({ v, r: (v.refs ?? []).find(r => r.id === target) })).find(x => x.r);
        if (!hit) continue;
        const n: TreeNode = { id: f.id, path: f.path, version: hit.r!.version, qty: hit.r!.qty, rev: f.revision, state: f.state, children: [] };
        if (seen.has(f.id)) n.cycle = true; else n.children = up(f.id, new Set(seen).add(f.id));
        out.push(n);
      }
      return out;
    };
    return up(id, new Set([id]));
  }

  /** BOM (FR-PDM-052): every file in the tree with its total quantity, at the versions the mode resolves to. */
  async bom(id: string, version?: number, mode: Resolve = "built") {
    const tree = await this.contains(id, version, mode);
    const all = new Map((await this.files(true)).map(f => [f.id, f]));
    const rows = new Map<string, { id: string; path: string; version: number; rev?: string; qty: number; partNumber: string; description: string }>();
    const walk = (n: TreeNode, mult: number) => {
      for (const c of n.children) {
        const q = c.qty * mult, key = `${c.id || c.path}@${c.version}`;
        const f = all.get(c.id);
        const v = f?.versions.find(x => x.n === c.version);
        const card = v?.card ?? f?.card ?? {};
        const r = rows.get(key) ?? { id: c.id, path: c.path, version: c.version, rev: c.rev, qty: 0, partNumber: card[PART_NUMBER] ?? "", description: card.Description ?? "" };
        r.qty += q;
        rows.set(key, r);
        if (!c.cycle) walk(c, q);
      }
    };
    walk(tree, 1);
    return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** BOM compare (FR-PDM-052) between two versions of an assembly: added, removed, quantity and revision changes. */
  async bomCompare(id: string, a: number, b: number) {
    const ra = await this.bom(id, a), rb = await this.bom(id, b);
    const key = (r: { id: string; path: string }) => r.id || r.path;
    const ma = new Map(ra.map(r => [key(r), r])), mb = new Map(rb.map(r => [key(r), r]));
    const out: { path: string; change: "added" | "removed" | "quantity" | "revision" | "version"; from: string; to: string }[] = [];
    for (const [k, r] of mb) {
      const o = ma.get(k);
      if (!o) out.push({ path: r.path, change: "added", from: "", to: String(r.qty) });
      else if (o.qty !== r.qty) out.push({ path: r.path, change: "quantity", from: String(o.qty), to: String(r.qty) });
      else if ((o.rev ?? "") !== (r.rev ?? "")) out.push({ path: r.path, change: "revision", from: o.rev ?? "", to: r.rev ?? "" });
      else if (o.version !== r.version) out.push({ path: r.path, change: "version", from: `v${o.version}`, to: `v${r.version}` });
    }
    for (const [k, r] of ma) if (!mb.has(k)) out.push({ path: r.path, change: "removed", from: String(r.qty), to: "" });
    return out;
  }

  // ---------- compare (FR-PDM-050) ----------

  /** Compares two versions of a file: data card, size, references and (for documents) the feature tree. */
  async compare(id: string, a: number, b: number) {
    const f = await this.file(id);
    const va = f.versions.find(v => v.n === a), vb = f.versions.find(v => v.n === b);
    if (!va || !vb) throw new VaultError("Pick two versions of the file.");
    const card: { field: string; from: string; to: string }[] = [];
    const ca = va.card ?? {}, cb = vb.card ?? {};
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) if ((ca[k] ?? "") !== (cb[k] ?? "")) card.push({ field: k, from: ca[k] ?? "", to: cb[k] ?? "" });
    const ra = new Map((va.refs ?? []).map(r => [r.id || r.path, r])), rb = new Map((vb.refs ?? []).map(r => [r.id || r.path, r]));
    const refs: { path: string; from: string; to: string }[] = [];
    for (const k of new Set([...ra.keys(), ...rb.keys()])) {
      const x = ra.get(k), y = rb.get(k);
      const d = (r?: RefRec) => (r ? `${r.qty}× v${r.version}` : "");
      if (d(x) !== d(y)) refs.push({ path: (y ?? x)!.path, from: d(x), to: d(y) });
    }
    let features: Awaited<ReturnType<typeof featureDiff>> = null;
    if (!va.purged && !vb.purged && va.sha !== vb.sha) features = await featureDiff(f.path, await this.object(va.sha), await this.object(vb.sha));
    return { path: f.path, a: va, b: vb, same: va.sha === vb.sha, size: vb.size - va.size, card, refs, features };
  }

  // ---------- lifecycle (FR-PDM-031..034) ----------

  /** Transitions available from a file's state. */
  transitionsOf(f: FileRec): WfTransition[] { return this.workflow.transitions.filter(x => x.from === f.state); }

  /**
   * Checks a transition on a set of files before anything is written (FR-PDM-033/082): per file, the problems that
   * block it and warnings that do not.
   */
  async checkTransition(ids: string[], name: string, comment = "") {
    const all = new Map((await this.files()).map(f => [f.id, f]));
    const batch = new Set(ids);
    const out: { id: string; path: string; state: string; version: number; problems: Msg[]; warnings: Msg[] }[] = [];
    for (const id of ids) {
      const f = all.get(id);
      if (!f) continue;
      const problems: Msg[] = [], warnings: Msg[] = [];
      const tr = this.transitionsOf(f).find(x => x.name === name);
      if (!tr) problems.push({ key: "{name} is not possible from {state}.", p: { name, state: f.state } });
      else {
        if (f.checkout) problems.push({ key: "Checked out by {user}: check it in first.", p: { user: f.checkout.user } });
        if (tr.role && !this.has(tr.role)) problems.push({ key: "Needs the role {role}.", p: { role: tr.role } });
        if (tr.comment && !comment.trim()) problems.push({ key: "Needs a comment." });
        const card = f.card ?? {};
        const required = [...(tr.fields ?? []), ...(tr.revision === "release" ? this.cardFields(f.kind).filter(x => x.required).map(x => x.name) : [])];
        for (const k of new Set(required)) if (!(card[k] ?? "").trim()) problems.push({ key: "Fill in {field} first.", p: { field: k } });
        if (tr.refsReleased) {
          for (const r of this.latest(f).refs ?? []) {
            const c = all.get(r.id);
            if (!c) { problems.push({ key: "Missing reference {path}.", p: { path: r.path } }); continue; }
            const goingReleased = batch.has(c.id) && this.transitionsOf(c).some(x => x.name === name && this.stateOf(x.to).released);
            if (!this.stateOf(c.state).released && !goingReleased) problems.push({ key: "{path} is {state}, not released.", p: { path: c.path, state: c.state } });
          }
        }
        if ((await this.status(f)).modified) warnings.push({ key: "The local copy has changes that are not checked in." });
        for (const r of this.latest(f).refs ?? []) { const c = all.get(r.id); if (c && this.stateOf(c.state).obsolete) warnings.push({ key: "{path} is obsolete.", p: { path: c.path } }); }
        if (f.kind === "drawing") for (const r of this.latest(f).refs ?? []) { const c = all.get(r.id); if (c && this.latest(c).n !== r.version) warnings.push({ key: "Out of date with {path} (v{a}, latest v{b}).", p: { path: c.path, a: r.version, b: this.latest(c).n } }); }
      }
      out.push({ id, path: f.path, state: f.state, version: this.latest(f).n, problems, warnings });
    }
    return out;
  }

  /**
   * Changes the state of files (FR-PDM-031/032). Refused as a whole when any file has a problem. Approve gives the
   * latest version the next revision label and, in MöbiusCAD documents, writes revision, state, approver and date
   * into the properties (a new version, FR-PDM-034). Returns the revision labels given.
   */
  async transition(ids: string[], name: string, comment = ""): Promise<Record<string, string | undefined>> {
    const chk = await this.checkTransition(ids, name, comment);
    const bad = chk.find(c => c.problems.length);
    if (bad) throw new VaultError("{path}: {problem}", { path: bad.path, problem: fmtMsg(bad.problems[0]) });
    const out: Record<string, string | undefined> = {};
    const at = new Date().toISOString();
    for (const id of ids) {
      const f = await this.file(id);
      const tr = this.transitionsOf(f).find(x => x.name === name)!;
      const from = f.state;
      let label: string | undefined, pre = false;
      if (tr.revision === "release") {
        const last = this.released(f);
        label = revLabel(this.revScheme, last ? revIndex(this.revScheme, last.rev!) + 1 : 0);
      } else if (tr.revision === "pre" && !this.released(f)) {
        const n = f.versions.filter(v => v.pre).length;
        label = preLabel(this.revScheme, n) ?? undefined;
        pre = !!label;
      }
      f.state = tr.to;
      if (label && !pre) {
        // The release goes into the document's properties: a new version carrying the label.
        const cur = await this.object(this.latest(f).sha);
        const nb = await this.withCardProps(f.path, cur, f.card ?? {}, { revision: label, State: tr.to, "Approved by": this.user, "Approved date": at.slice(0, 10) });
        if (nb !== cur) {
          const sha = await this.putObject(nb);
          f.versions.push({ n: this.latest(f).n + 1, sha, size: nb.length, at, user: this.user, comment: `Revision ${label}`, state: tr.to, refs: this.latest(f).refs, card: { ...(f.card ?? {}) } });
          const st = await this.status({ ...f, versions: f.versions.slice(0, -1) });
          if (!st.modified) await this.writeWorking(f.path, nb);
        }
      }
      if (label) { const v = this.latest(f); v.rev = label; if (pre) v.pre = true; else v.approvedBy = this.user; f.revision = label; }
      await this.saveRec(f);
      await this.log("transition", { file: id, path: f.path, version: this.latest(f).n, details: `${name}: ${from} → ${tr.to}${label ? `, revision ${label}` : ""}${comment.trim() ? ` (${comment.trim()})` : ""}` });
      out[id] = label;
    }
    return out;
  }

  // ---------- rename, move, delete, copy (FR-PDM-023..025) ----------

  /**
   * Rename or move a file (FR-PDM-023). Files whose latest version references it get their references redirected:
   * a new version with an automatic comment, or the working copy when they are checked out here. Released
   * revisions keep their old references in those versions.
   */
  async rename(id: string, newPath: string) {
    splitPath(newPath);
    const f = await this.file(id);
    if (f.path === newPath) return;
    const clash = await this.byPath(newPath);
    if (clash && clash.id !== id) throw new VaultError("{path} is already in the vault.", { path: newPath });
    if (f.checkout && (f.checkout.user !== this.user || f.checkout.computer !== this.computer)) throw new VaultError("Checked out by {user}.", { user: f.checkout.user });
    const users = (await this.files()).filter(p => p.id !== id && (this.latest(p).refs ?? []).some(r => r.id === id));
    for (const p of users) if (p.checkout && (p.checkout.user !== this.user || p.checkout.computer !== this.computer)) throw new VaultError("{path} uses this file and is checked out by {user}.", { path: p.path, user: p.checkout.user });
    const old = f.path;
    const w = await this.working(old);
    if (w) { await this.writeWorking(newPath, w); await this.removeWorking(old); }
    f.path = newPath;
    f.kind = kindOf(newPath);
    await this.saveRec(f);
    const moved = old.split("/").slice(0, -1).join("/") !== newPath.split("/").slice(0, -1).join("/");
    await this.log(moved ? "move" : "rename", { file: id, path: newPath, version: this.latest(f).n, details: `${old} → ${newPath}` });
    // A moved document's own relative references must follow too.
    if (moved && (this.latest(f).refs ?? []).length) await this.redirect(f, r => { const t = resolveRel(old, r); return t ? relPath(newPath, t) : null; }, `Moved from ${old}`);
    for (const p of users) {
      await this.redirect(p, r => (resolveRel(p.path, r)?.toLowerCase() === old.toLowerCase() ? relPath(p.path, newPath) : null), `Reference to ${old} renamed to ${newPath}`);
    }
  }

  /** Rewrites a file's references: into the working copy when it is checked out here, else as a new version. */
  private async redirect(f0: FileRec, map: (rel: string) => string | null, comment: string) {
    const f = await this.file(f0.id);
    const mine = f.checkout && f.checkout.user === this.user && f.checkout.computer === this.computer;
    const src = mine ? await this.working(f.path) : await this.object(this.latest(f).sha);
    if (!src) return;
    const nb = await rewriteRefs(f.path, src, map);
    if (!nb) {
      // Not a document that names its references: only the record follows.
      const v = this.latest(f);
      v.refs = (v.refs ?? []).map(r => ({ ...r, path: map(r.path) ?? r.path }));
      await this.saveRec(f);
      return;
    }
    if (mine) { await this.writeWorking(f.path, nb); return; }
    const sha = await this.putObject(nb);
    const n = this.latest(f).n + 1;
    f.versions.push({ n, sha, size: nb.length, at: new Date().toISOString(), user: this.user, comment, state: f.state, refs: await this.indexRefs(f.path, nb), card: { ...(f.card ?? {}) } });
    if (!(await this.status({ ...f, versions: f.versions.slice(0, -1) })).modified) await this.writeWorking(f.path, nb);
    await this.saveRec(f);
    await this.log("check in", { file: f.id, path: f.path, version: n, details: comment });
  }

  private async removeWorking(path: string) {
    const { dir, name } = await this.folderOf(path, false);
    if (dir && await dir.read(name)) await dir.remove(name);
  }

  /** Files whose versions (any) reference this one: they block a delete (FR-PDM-025). */
  async usersOf(id: string) {
    return (await this.files()).filter(p => p.id !== id && p.versions.some(v => (v.refs ?? []).some(r => r.id === id)));
  }

  /** Delete (FR-PDM-025): to the recycle bin; refused while referenced by any version of another file. */
  async remove(id: string) {
    const f = await this.file(id);
    if (f.deleted) return;
    if (f.checkout) throw new VaultError("Checked out by {user}.", { user: f.checkout.user });
    const users = await this.usersOf(id);
    if (users.length) throw new VaultError("Used by {list}: it cannot be deleted.", { list: users.map(u => u.path).join(", ") });
    f.deleted = { at: new Date().toISOString(), user: this.user };
    await this.removeWorking(f.path);
    await this.saveRec(f);
    await this.log("delete", { file: id, path: f.path, version: this.latest(f).n });
  }

  async recycleBin() { return (await this.files(true)).filter(f => f.deleted); }

  /** Restores a deleted file; its latest version becomes the local copy again. */
  async restore(id: string) {
    const f = await this.file(id);
    if (!f.deleted) return;
    if (await this.byPath(f.path)) throw new VaultError("{path} is already in the vault.", { path: f.path });
    delete f.deleted;
    if (!this.latest(f).purged) await this.writeWorking(f.path, await this.object(this.latest(f).sha));
    await this.saveRec(f);
    await this.log("restore", { file: id, path: f.path, version: this.latest(f).n });
  }

  /** Destroys a file in the recycle bin for good (Admin); its stored versions are dropped by the next purge. */
  async destroy(id: string) {
    if (!this.has("Admin")) throw new VaultError("Only an Admin can destroy files.");
    const f = await this.file(id);
    if (!f.deleted) throw new VaultError("Delete the file first.");
    await (await this.sub("files")).remove(`${id}.json`);
    await this.log("destroy", { file: id, path: f.path, details: `${f.versions.length} versions` });
  }

  /**
   * Copy tree (FR-PDM-024): copies a file and the chosen referenced files to a folder, renamed by the rules, with
   * references redirected to the copies; each copy starts at version 1. Returns old id → new file.
   */
  async copyTree(rootId: string, opts: { ids?: string[]; folder: string; prefix?: string; suffix?: string; find?: string; replace?: string; renumber?: boolean }) {
    const tree = await this.contains(rootId, undefined, "latest");
    const inTree: string[] = [];
    const walk = (n: TreeNode) => { if (n.id && !inTree.includes(n.id)) inTree.push(n.id); if (!n.cycle) n.children.forEach(walk); };
    walk(tree);
    const ids = inTree.filter(i => i === rootId || !opts.ids || opts.ids.includes(i));
    const folder = opts.folder.split("/").map(s => s.trim()).filter(Boolean).join("/");
    const rename = (name: string) => {
      const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
      const b = opts.find ? base.split(opts.find).join(opts.replace ?? "") : base;
      return `${opts.prefix ?? ""}${b}${opts.suffix ?? ""}${ext}`;
    };
    const recs = new Map<string, FileRec>();
    for (const i of ids) recs.set(i, await this.file(i));
    const target = new Map<string, string>();
    for (const [i, f] of recs) {
      const p = `${folder ? `${folder}/` : ""}${rename(f.path.split("/").pop()!)}`;
      if (await this.byPath(p) || [...target.values()].some(x => x.toLowerCase() === p.toLowerCase())) throw new VaultError("{path} is already in the vault.", { path: p });
      target.set(i, p);
    }
    const out = new Map<string, FileRec>();
    // Leaves first, so each parent's references resolve to copies already in the vault.
    const order = [...ids].reverse();
    for (const i of order) {
      const f = recs.get(i)!, np = target.get(i)!;
      const v = this.latest(f);
      let data = await this.object(v.sha);
      const all = await this.files(true);
      data = (await rewriteRefs(f.path, data, rel => {
        const t = resolveRel(f.path, rel);
        const src = t && all.find(x => x.path.toLowerCase() === t.toLowerCase());
        const dst = src && target.get(src.id);
        return dst ? relPath(np, dst) : t ? relPath(np, t) : null;
      })) ?? data;
      const card = { ...(f.card ?? {}) };
      if (opts.renumber && this.cardFields(f.kind).some(x => x.name === PART_NUMBER)) card[PART_NUMBER] = await this.issueNumber(card);
      data = await this.withCardProps(np, data, card);
      out.set(i, await this.add(np, data, `Copied from ${f.path} v${v.n}`, card, { copiedFrom: { id: f.id, version: v.n } }));
    }
    await this.log("copy tree", { file: rootId, path: recs.get(rootId)!.path, details: `${ids.length} files to ${folder || "/"}` });
    return out;
  }

  // ---------- search (FR-PDM-042) ----------

  async search(q: SearchQuery): Promise<FileRec[]> {
    const files = await this.files();
    const has = (a: string | undefined, b: string) => (a ?? "").toLowerCase().includes(b.trim().toLowerCase());
    let out = files.filter(f => {
      const card = f.card ?? {};
      const lv = this.latest(f);
      if (q.text?.trim() && !has(f.path, q.text) && !Object.values(card).some(v => has(v, q.text!)) && !has(lv.comment, q.text)) return false;
      if (q.state && f.state !== q.state) return false;
      if (q.revision?.trim() && (f.revision ?? "").toLowerCase() !== q.revision.trim().toLowerCase()) return false;
      if (q.checkedOutBy?.trim() && !has(f.checkout?.user, q.checkedOutBy)) return false;
      if (q.kind && f.kind !== q.kind) return false;
      if (q.from && lv.at < q.from) return false;
      if (q.to && lv.at.slice(0, 10) > q.to.slice(0, 10)) return false;
      for (const [k, v] of Object.entries(q.fields ?? {})) if (v.trim() && !has(card[k], v)) return false;
      return true;
    });
    if (q.contains?.value.trim()) {
      const byId = new Map(files.map(f => [f.id, f]));
      const hit = (id: string, seen: Set<string>): boolean => {
        const f = byId.get(id);
        if (!f || seen.has(id)) return false;
        seen.add(id);
        return (this.latest(f).refs ?? []).some(r => { const c = byId.get(r.id); return !!c && (has(c.card?.[q.contains!.field], q.contains!.value) || hit(c.id, seen)); });
      };
      out = out.filter(f => hit(f.id, new Set()));
    }
    return out;
  }

  // ---------- backup, storage (FR-PDM-007/008) ----------

  /**
   * Everything needed to rebuild the vault elsewhere, as ZIP entries: settings, file records, the log, the
   * stored versions (all, or only the latest of each file) and the working copies at their paths.
   */
  async exportEntries(latestOnly = false): Promise<{ name: string; data: Uint8Array }[]> {
    const out: { name: string; data: Uint8Array }[] = [];
    const files = await this.files(true);
    out.push({ name: `${STORE}/vault.json`, data: enc.encode(json(this.info)) });
    const shas = new Set<string>();
    for (const f of files) {
      const rec = latestOnly ? { ...f, versions: f.versions.map(v => (v === this.latest(f) || (v.rev && !v.pre) ? v : { ...v, purged: true })) } : f;
      out.push({ name: `${STORE}/files/${f.id}.json`, data: enc.encode(json(rec)) });
      for (const v of rec.versions) if (!v.purged) shas.add(v.sha);
      const w = !f.deleted && await this.working(f.path);
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
    return (await this.files(true)).map(f => {
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
    const files = await this.files(true);
    for (const f of files) {
      let changed = false;
      // Released revisions are always kept (FR-PDM-008).
      f.versions.forEach((v, i) => { if (i < f.versions.length - keep && !v.purged && !(v.rev && !v.pre)) { v.purged = true; changed = true; } });
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
  async verify(): Promise<{ missing: string[]; corrupt: string[]; orphans: string[]; files: number; objects: number; broken: string[] }> {
    const files = await this.files(true);
    const ids = new Set(files.map(f => f.id));
    const broken: string[] = [];
    for (const f of files) if (!f.deleted) for (const r of this.latest(f).refs ?? []) if (!r.id || !ids.has(r.id)) broken.push(`${f.path} → ${r.path}`);
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
    return { missing, corrupt, orphans, files: files.length, objects: have.size, broken };
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
      // A file being written at the same moment reads as NotReadableError: try again shortly.
      for (let i = 0; ; i++) {
        try { return new Uint8Array(await (await (await h.getFileHandle(n)).getFile()).arrayBuffer()); }
        catch (e) {
          const name = (e as Error).name;
          if (name === "NotFoundError" || name === "TypeMismatchError") return null;
          if (name !== "NotReadableError" || i >= 10) throw e;
          await new Promise(r => setTimeout(r, 20 * (i + 1)));
        }
      }
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
