// The Vault tab (FR-PDM-002, 080): create or open a vault, list its files with their state, version and lock,
// and the commands Check out, Check in, Undo check-out, Get latest, History (open a version, roll back),
// Add files, Save the open part to the vault, the audit trail and the integrity check.
import { onLangChange, t } from "../i18n";
import { confirmModal, storage, toast } from "../ui";
import { unzipLimited, zip } from "../model/zip";
import { packPart } from "../model/file";
import type { PartDoc } from "../model/types";
import { embeddedParts, resolveRel } from "./codec";
import { geomComparable, geometryCompare, geomRows, mountDiffView } from "./geomCompare";
import { folderHandle, forgetFolder, rememberFolder, vaultFolders } from "./folders";
import { fsaDir, MOVED_ON, Vault, VaultError, type FileRec, type Msg, type RefRec, type Resolve, type SearchQuery, type TreeNode, type VDir, STORE } from "./vault";
import { defaultWorkflow, PART_NUMBER, ROLES, type CardField, type Role, type Workflow } from "./workflow";

/**
 * What ties an open document to its vault file: Save writes the working copy through it, only while the file
 * is checked out here. `label` and `readOnly` are read when used, so a parked document tab stays up to date.
 */
export interface VaultTie {
  /** The vault file's id. */
  id: string;
  readonly label: string;
  readonly readOnly: boolean;
  save(bytes: Uint8Array): Promise<void>;
  checkOut(): Promise<void>;
}
/** The live document a vault can keep: a part, an assembly or a drawing. */
export interface VaultDoc {
  name: string;
  kind: "part" | "assembly" | "drawing";
  tie: VaultTie | null;
  /** The document as saved. */
  bytes(): Promise<Uint8Array | null>;
  /** Ties the document to a vault file (null unties it). */
  setVault(v: VaultTie | null): void;
  markSaved(): void;
}
export interface VaultHost {
  /** Opens bytes as a document (a part, or any file the viewer reads); `replace`: in the live document's tab. */
  open(name: string, data: Uint8Array, replace?: boolean): Promise<void>;
  /** Shows the document tab that holds this vault file, if one does (true when it was found). */
  show?(id: string): Promise<boolean>;
  /** The live part, assembly or drawing, if any. */
  doc(): VaultDoc | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
/** A vault message in the interface language. */
const tm = (m: Msg) => t(m.key, m.p);
/** State, transition and role names: the default workflow's are translated, a user's own are shown as typed (FR-PDM-083). */
const tn = (s: string) => t(s);
const errText = (e: unknown) => (e instanceof VaultError ? t(e.key, e.params) : t("Vault error: {err}", { err: (e as Error).message }));
const download = (name: string, data: BlobPart, type: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const csvOf = (rows: (string | number)[][]) => rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

type PickerWindow = Window & { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> };

/** The browser workspace: one folder per vault under `mcad-vaults/` in the origin's private file system. */
async function workspace(): Promise<VDir | null> {
  const nav = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (!nav?.getDirectory) return null;
  try { return await fsaDir(await nav.getDirectory()).dir("mcad-vaults", true); } catch { return null; }
}

export class VaultPanel {
  vault: Vault | null = null;
  private files: FileRec[] = [];
  private state = new Map<string, Awaited<ReturnType<Vault["status"]>>>();
  private sel: string | null = null;
  /** The ties this vault handed out: a document tied by another vault (closed since) is not ours. */
  private ties = new WeakSet<VaultTie>();
  /** The vault file the live document came from. */
  get openId(): string | null { const tie = this.app.doc()?.tie; return tie && this.ties.has(tie) ? tie.id : null; }
  /** The live document's vault file with its lock state, for the Vault menu. */
  get openFileState() {
    const id = this.openId, f = id ? this.files.find(x => x.id === id) : undefined;
    return f ? { file: f, mine: !!this.state.get(f.id)?.mine, canCheckOut: !f.checkout && !!this.vault?.stateOf(f.state).checkout } : null;
  }
  /** The live document's name when a vault can keep it. */
  get docName() { return this.app.doc()?.name ?? null; }
  /** Puts the cursor in the new vault's name box (no vault open). */
  focusName() { this.host.querySelector<HTMLInputElement>("#v-name")?.focus(); }
  /** The file picker of Add files (a vault is open). */
  pickFiles() { this.host.querySelector<HTMLInputElement>("#v-files")?.click(); }
  /** Import vault ZIP… from the Vault menu (the start screen's file input). */
  pickZip() { this.host.querySelector<HTMLInputElement>("#v-zip")?.click(); }
  /** Called when the vault opens, closes or its files change (the Vault menu's button follows). */
  onChange: (() => void) | null = null;
  /** Search results shown instead of all files (FR-PDM-042), with what was searched. */
  private found: { ids: Set<string>; label: string } | null = null;
  /** Users whose check-out of the selected file lost to an earlier one (FR-PDM-071). */
  private conflicts: string[] = [];
  /** The selected assembly's linked components that have newer versions in the vault. */
  private stale: { id: string; path: string; version: number; latest: number }[] = [];
  /** Notifications since the last visit (FR-PDM-061). */
  private unseen = 0;

  constructor(private host: HTMLElement, private app: VaultHost) {
    void this.render();
    // Interpolated text (revision labels, counts) is rebuilt in the new language.
    onLangChange(() => { if (this.vault) void this.render(); });
  }

  get user() { return storage.get("mc:vaultUser") || "User"; }
  private get computer() {
    let c = storage.get("mc:computer");
    if (!c) { c = `Browser-${Math.random().toString(36).slice(2, 6)}`; storage.set("mc:computer", c); }
    return c;
  }

  // ---------- opening ----------

  async createInBrowser(name: string) {
    const ws = await workspace();
    if (!ws) { toast(t("This browser has no private file system; pick a folder instead."), true); return; }
    const safe = name.trim().replace(/[\\/:*?"<>|]/g, "_") || "Vault";
    const dir = await ws.dir(safe, true);
    await this.use(await Vault.create(dir!, safe, this.user, this.computer));
  }

  async openInBrowser(name: string) {
    const ws = await workspace();
    const dir = ws && await ws.dir(name, false);
    if (!dir) { toast(t("Vault not found."), true); return; }
    await this.use(await Vault.open(dir, this.user, this.computer));
  }

  /** Folder vaults need the File System Access API: Chrome, Edge and other Chromium browsers on a computer. */
  get foldersOk() { return !!(window as PickerWindow).showDirectoryPicker; }

  /**
   * A vault in a folder on disk (FR-PDM-002): the user picks the folder; `create` makes a new vault there,
   * else the vault in it is opened. A folder that already holds a vault is opened either way, and an
   * ordinary folder picked for Open can become a vault after a question.
   */
  async pickFolder(create: boolean) {
    const w = window as PickerWindow;
    if (!w.showDirectoryPicker) { toast(t("A vault in a folder needs Chrome or Edge on a computer. In this browser, use a browser vault and Export ZIP for backups."), true); return; }
    let h: FileSystemDirectoryHandle;
    try { h = await w.showDirectoryPicker({ mode: "readwrite", id: "mc-vault" }); } catch { return; }
    const dir = fsaDir(h);
    try {
      const has = !!(await dir.dir(STORE, false));
      if (!has && !create && !await confirmModal(t("The folder {name} holds no vault yet. Create a vault in it?", { name: h.name }), t("Create vault"))) return;
      await this.use(has ? await Vault.open(dir, this.user, this.computer) : await Vault.create(dir, h.name, this.user, this.computer), "folder");
      if (has && create) toast(t("This folder already held a vault: it is open now."));
      await rememberFolder(h);
      // A new vault in a project folder offers the files already there.
      if (!has) await this.addFolderFiles(true);
    } catch (e) { toast(errText(e), true); }
  }

  /** Opens a vault folder used before; the browser may ask for access to the folder again. */
  async openFolder(key: string) {
    const h = await folderHandle(key);
    if (h === "denied") { toast(t("The browser was not allowed to use that folder."), true); return; }
    if (!h) { toast(t("That folder is no longer in the list."), true); return; }
    try {
      await this.use(await Vault.open(fsaDir(h), this.user, this.computer), "folder");
      await rememberFolder(h);
    } catch (e) {
      toast(errText(e), true);
      // A folder that was moved or deleted leaves the list.
      if ((e as Error).name === "NotFoundError") await forgetFolder(key);
    }
  }

  /** The browser vaults' names. */
  async browserVaults() {
    const ws = await workspace();
    return ws ? (await ws.list()).filter(e => e.kind === "dir").map(e => e.name).sort() : [];
  }

  /** Where the open vault lives: a folder on disk or this browser's storage (the Vault menu's Switch to leaves it out). */
  where: "folder" | "browser" = "browser";

  /** Opens a vault given its directory (tests, and the folder picker). */
  async use(v: Vault, where: "folder" | "browser" = "browser") {
    this.where = where;
    if (this.vault && this.openId) this.app.doc()?.setVault(null);
    this.ties = new WeakSet();
    this.vault = v;
    this.sel = null;
    storage.set("mc:lastVault", v.root.name);
    await this.refresh();
    toast(t("Vault {name} open", { name: v.info.name }), "success");
  }

  close() {
    this.vault = null;
    this.files = [];
    if (this.openId) this.app.doc()?.setVault(null);
    this.ties = new WeakSet();
    void this.render();
    this.onChange?.();
  }

  async refresh() {
    const v = this.vault;
    if (v) {
      // Files and their status are swapped in together: a render while this runs sees the old pair, never a mix.
      const files = await v.files();
      const state = new Map<string, Awaited<ReturnType<Vault["status"]>>>();
      for (const f of files) state.set(f.id, await v.status(f));
      this.files = files;
      this.state = state;
      // The open part follows its file's lock and version.
      // (The tie reads the label and the lock when asked; setting it again redraws the title.)
      const d = this.app.doc();
      if (this.openId && d) d.setVault(d.tie);
      this.conflicts = this.sel ? [...new Set((await v.lockConflicts(this.sel)).map(c => c.user))] : [];
      this.stale = this.sel ? await v.outdatedLinks(this.sel).catch(() => []) : [];
      this.unseen = (await v.notifications(this.seenAt)).length;
    }
    await this.render();
    this.onChange?.();
  }

  // ---------- commands ----------

  private rec(id: string) { return this.files.find(f => f.id === id)!; }

  private async run(work: () => Promise<unknown>) {
    try { await work(); } catch (e) { toast(errText(e), true); }
    await this.refresh();
  }

  async addFiles(list: File[], withParts?: boolean) {
    const v = this.vault;
    if (!v) return;
    const items = await Promise.all(list.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    const chosen = await this.embeddedOffer(items.map(it => ({ path: it.name, data: it.data })), items.map(it => it.name), withParts);
    if (!chosen) return;
    await this.run(async () => {
      for (const p of chosen) await v.add(p.path, await packPart(p.doc as unknown as PartDoc, "MöbiusCAD vault"), "Added from an assembly");
      for (const it of items) await v.add(it.name, it.data);
      const n = items.length + chosen.length;
      toast(t("Added {n} file to the vault|Added {n} files to the vault", { n }), "success");
    });
  }

  /**
   * FR-PDM-003: an assembly's parts that are not in the vault yet can go in as files of their own first, so the
   * assembly's references point at them. They go in the assembly's folder. Null: the user cancelled.
   */
  private async embeddedOffer(asms: { path: string; data: Uint8Array }[], coming: string[], withParts?: boolean): Promise<{ path: string; doc: Record<string, unknown> }[] | null> {
    const v = this.vault!;
    const base = (p: string) => p.split("/").pop()!.toLowerCase();
    const have = new Set([...this.files.map(f => base(f.path)), ...coming.map(base)]);
    const missing: { path: string; doc: Record<string, unknown> }[] = [];
    for (const it of asms) {
      if (!/\.mcadasm$/i.test(it.path)) continue;
      for (const p of await embeddedParts(it.data)) {
        const path = resolveRel(it.path, p.file) ?? p.file;
        if (have.has(base(path)) || missing.some(x => x.path.toLowerCase() === path.toLowerCase()) || await v.byPath(path)) continue;
        missing.push({ path, doc: p.doc });
      }
    }
    if (!missing.length || withParts === false) return [];
    if (withParts) return missing;
    const r = await this.form(t("Add to vault"), `<p>${esc(t("The assembly uses parts that are not in the vault. Add them as files too, so it can be opened with the latest versions?"))}</p><div class="v-pick">${missing.map((p, i) => `<label class="chk" translate="no"><input type="checkbox" name="p:${i}" checked /> ${esc(p.path)}</label>`).join("")}</div>`, t("Add"));
    return r ? missing.filter((_p, i) => r[`p:${i}`]) : null;
  }

  /**
   * Add the files already in the vault folder (FR-PDM-003): a vault made in a project folder takes its parts,
   * assemblies and drawings where they are, subfolders and all, instead of copies at the top.
   */
  async addFolderFiles(afterCreate = false) {
    const v = this.vault;
    if (!v) return;
    const paths = await v.untracked();
    if (!paths.length) { if (!afterCreate) toast(t("Every file in the vault folder is in the vault already.")); return; }
    const docs = paths.filter(p => /\.mcad(prt|asm|drw)$/i.test(p));
    const r = await this.form(t("Add the files in this folder"), `<p>${esc(afterCreate ? t("The folder already holds {n} file. Add it to the vault where it is?|The folder already holds {n} files. Add them to the vault where they are? Subfolders are kept.", { n: paths.length }) : t("{n} file in the vault folder is not in the vault yet. Add it where it is?|{n} files in the vault folder are not in the vault yet. Add them where they are? Subfolders are kept.", { n: paths.length }))}</p>
      <div class="row"><button type="button" class="btn small" data-all="1">${esc(t("Select all"))}</button><button type="button" class="btn small" data-all="0">${esc(t("Select none"))}</button>${docs.length && docs.length < paths.length ? `<button type="button" class="btn small" data-all="docs">${esc(t("Only MöbiusCAD documents"))}</button>` : ""}</div>
      <div class="v-pick">${paths.map((p, i) => `<label class="chk" translate="no"><input type="checkbox" name="f:${i}" checked /> ${esc(p)}</label>`).join("")}</div>`, t("Add"));
    if (!r) return;
    const picked = paths.filter((_p, i) => r[`f:${i}`]);
    if (!picked.length) return;
    const asms = (await Promise.all(picked.filter(p => /\.mcadasm$/i.test(p)).map(async p => ({ path: p, data: await v.working(p) })))).filter((x): x is { path: string; data: Uint8Array } => !!x.data);
    const extra = await this.embeddedOffer(asms, picked);
    if (!extra) return;
    await this.run(async () => {
      for (const p of extra) await v.add(p.path, await packPart(p.doc as unknown as PartDoc, "MöbiusCAD vault"), "Added from an assembly");
      const added = await v.addInPlace(picked);
      const n = added.length + extra.length;
      toast(t("Added {n} file to the vault|Added {n} files to the vault", { n }), "success");
    });
  }

  /**
   * Save to vault (FR-PDM-003): the live part, assembly or drawing goes in as a new file at version 1, checked
   * out here so work goes on; from then on Save writes its working copy in the vault.
   */
  async saveOpenDoc() {
    const v = this.vault, p = this.app.doc();
    if (!v) { toast(t("Open or create a vault first."), true); return; }
    if (!p) { toast(t("Open or create a part, an assembly or a drawing first."), true); return; }
    if (this.openId) { toast(t("This document is already in the vault."), true); return; }
    await this.run(async () => {
      const bytes = await p.bytes();
      if (!bytes) return;
      const f = await v.add(p.name, bytes, "Added");
      await v.checkOut(f.id);
      this.shown.set(f.id, 1);
      p.setVault(this.tie(f.id));
      p.markSaved();
      this.sel = f.id;
      toast(t("{name} is in the vault, checked out to you", { name: p.name }), "success");
    });
  }

  /** The drawing's latest version as a PDF; one that is not released says so across every sheet (FR-PDM-036). */
  async pdfOf(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    try {
      toast(t("Making the PDF…"));
      const { drawingPdf } = await import("./outputs");
      const released = v.stateOf(f.state).released;
      const name = f.path.split("/").pop()!.replace(/\.[^.]+$/, "");
      const pdf = await drawingPdf(await v.versionBytes(id, v.latest(f).n), name, released ? undefined : t("NOT RELEASED"));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
      a.download = `${name}${f.revision ? `_rev${f.revision}` : ""}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) { toast(errText(e), true); }
  }

  /** How to open an assembly's components (FR-PDM-022), or null when cancelled. */
  private async askResolve(refs: RefRec[] = []): Promise<Resolve | null> {
    // The components with newer versions than the ones the assembly was checked in with, so the choice is informed.
    const newer = refs.flatMap(r => { const c = this.files.find(x => x.id === r.id); return c && this.vault!.latest(c).n > r.version ? [`${c.path} · v${r.version} → v${this.vault!.latest(c).n}`] : []; });
    const note = newer.length ? `<p>${esc(t("{n} component has a newer version in the vault:|{n} components have newer versions in the vault:", { n: newer.length }))}</p><ul class="v-log" translate="no">${[...new Set(newer)].map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">${esc(t("Every component is at its latest version."))}</p>`;
    const r = await this.form(t("Open assembly"), `${note}<label class="v-lbl">${esc(t("Components"))}<select name="mode" autofocus>${([["built", "As checked in"], ["latest", "Latest"], ["released", "Latest released"]] as const).map(([k, l]) => `<option value="${k}">${esc(t(l))}</option>`).join("")}</select></label><p class="muted">${esc(t("Latest and Latest released put those versions of the part files in place of the copies saved in the assembly."))}</p>`, t("Open"));
    return r ? r.mode as Resolve : null;
  }

  /** The version of each vault file that its open document shows (a tab may hold an older one). */
  private shown = new Map<string, number>();

  async openFile(id: string, version?: number, resolveAs?: Resolve, replace = false) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    // A file open already is shown in its tab, not opened a second time; it is reloaded there only when the
    // vault has a newer version than the one on screen.
    if (!version && !replace && (this.openId === id || await this.app.show?.(id))) {
      if ((this.shown.get(id) ?? 0) >= v.latest(f).n) return;
      replace = true;
    }
    try {
      let data = version ? await v.versionBytes(id, version) : await v.working(f.path) ?? await v.versionBytes(id, v.latest(f).n);
      const name = f.path.split("/").pop()!;
      // FR-PDM-022: an assembly whose parts are vault files opens as checked in, or with the latest (released) parts.
      const ver = version ? f.versions.find(x => x.n === version) : v.latest(f);
      if (f.kind === "assembly" && ver?.refs?.some(r => r.id) && (version || !f.checkout)) {
        const mode = resolveAs ?? await this.askResolve(ver.refs ?? []);
        if (!mode) return;
        if (mode !== "built") {
          const r = await v.resolvedBytes(id, ver.n, mode);
          data = r.bytes;
          toast(r.changed.length ? t("Opened with newer versions of: {files}", { files: r.changed.join(", ") }) : t("The parts are already the versions the assembly was checked in with."));
        }
      }
      await this.app.open(version ? name.replace(/(\.[^.]+)$/, ` (v${version})$1`) : name, data, replace && !version);
      // A part, assembly or drawing opened from the vault saves back into it (an old version is a loose copy).
      const d = this.app.doc();
      if (!version && d && d.kind === f.kind) { this.shown.set(id, v.latest(f).n); d.setVault(this.tie(id)); }
    } catch (e) { toast(errText(e), true); }
  }

  /** The tie between an open document and its vault file (FR-PDM-010/081). */
  private tie(id: string): VaultTie {
    const v = this.vault!, panel = this;
    const cur = () => (panel.vault === v ? panel.files.find(x => x.id === id) : undefined);
    const tie: VaultTie = {
      id,
      get label() {
        const f = cur(), st = panel.state.get(id);
        if (!f) return t("vault closed");
        const mine = !!st?.mine, n = v.latest(f).n, on = panel.shown.get(id) ?? n;
        // A tab left open while the vault moved on (check-in elsewhere, roll back, release) says so.
        if (on < n) return `v${on} · ${t("newer v{n} in the vault", { n })}`;
        return `v${n}${f.revision ? ` · ${t("Rev {rev}", { rev: f.revision })}` : ""} · ${tn(f.state)}${f.checkout ? ` · ${mine ? t("checked out") : t("locked by {user}", { user: f.checkout.user })}` : ""}${st?.modified ? ` · ${mine ? t("modified") : t("local copy outdated")}` : ""}`;
      },
      get readOnly() { return !cur() || !panel.state.get(id)?.mine; },
      save: async bytes => { await v.saveWorking(id, bytes); await this.refresh(); },
      checkOut: async () => {
        await this.run(() => v.checkOut(id));
        // Checked out over an older version on screen: the latest comes in first, so Save cannot undo it.
        const f = cur();
        if (f && (panel.shown.get(id) ?? 0) < v.latest(f).n && panel.openId === id) await panel.reopen(id);
      },
    };
    this.ties.add(tie);
    return tie;
  }

  /** The live document's unsaved edits go into its working copy (before a check-in). */
  private async flushOpen(id: string) {
    if (this.openId !== id) return;
    const v = this.vault!, p = this.app.doc();
    const b = p && await p.bytes();
    if (b) { await v.saveWorking(id, b); p!.markSaved(); }
  }

  /** Opens the file again after the vault changed its content (the assembly as it is, without asking). */
  private reopen(id: string) { return this.openFile(id, undefined, "built", true); }

  async checkOut(id: string) {
    const v = this.vault;
    if (!v) return;
    await this.run(() => v.checkOut(id));
    if (this.openId === id && (this.shown.get(id) ?? 0) < v.latest(this.rec(id)).n) await this.reopen(id);
  }

  async checkIn(id: string, comment?: string, keep = false) {
    const v = this.vault;
    if (!v) return;
    let withRefs: string[] = [];
    if (comment === undefined) {
      // FR-PDM-011: referenced files checked out here can go in too; the changed ones are ticked.
      const refs = await v.checkInWith(id).catch(() => []);
      const refHtml = refs.length ? `<fieldset class="v-refs"><legend>${esc(t("Check in referenced files too"))}</legend>${refs.map(x => `<label class="chk" translate="no"><input type="checkbox" name="ref:${x.id}"${x.modified ? " checked" : ""} /> ${esc(x.path)}${x.modified ? "" : ` <small class="muted" translate="yes">${esc(t("(unchanged)"))}</small>`}</label>`).join("")}</fieldset>` : "";
      const r = await this.form(t("Check in"), `<p>${esc(this.rec(id).path)}</p><label class="v-lbl">${esc(t("Comment"))}<textarea name="comment" rows="3" maxlength="500" autofocus></textarea></label><label class="chk"><input type="checkbox" name="keep" /> ${esc(t("Keep checked out"))}</label>${refHtml}`, t("Check in"));
      if (!r) return;
      comment = r.comment as string;
      keep = !!r.keep;
      withRefs = refs.filter(x => r[`ref:${x.id}`]).map(x => x.id);
    }
    // The referenced files first, so the file that uses them is checked in against their new versions.
    for (const rid of withRefs) {
      try {
        await this.flushOpen(rid);
        const n = await v.checkIn(rid, comment!, keep);
        if (n && this.shown.has(rid)) this.shown.set(rid, n);
        if (n) toast(t("{name}: version {n}", { name: this.rec(rid).path, n }), "success");
      } catch (e) {
        toast(`${this.rec(rid).path}: ${errText(e)}`, true);
        await this.refresh();
        return;
      }
    }
    // Unsaved edits of the open part go into the working copy first.
    await this.flushOpen(id);
    try {
      const n = await v.checkIn(id, comment!, keep);
      if (n && this.shown.has(id)) this.shown.set(id, n);
      toast(n ? t("Checked in as version {n}", { n }) : t("No changes: no new version"), "success");
    } catch (e) {
      if (e instanceof VaultError && e.key === MOVED_ON) await this.movedOn(id, e);
      else toast(errText(e), true);
    }
    await this.refresh();
  }

  private async loadConflicts() {
    const v = this.vault, id = this.sel;
    if (!v || !id) return;
    const c = [...new Set((await v.lockConflicts(id)).map(x => x.user))];
    const stale = await v.outdatedLinks(id).catch(() => []);
    if ((c.length || stale.length) && this.sel === id) { this.conflicts = c; this.stale = stale; await this.render(); }
  }

  /** A refused check-in in a shared vault (FR-PDM-070): save the work as a new file, or discard it. */
  private async movedOn(id: string, e: VaultError) {
    const v = this.vault!, f = this.rec(id);
    const dot = f.path.lastIndexOf(".");
    const sug = `${dot > 0 ? f.path.slice(0, dot) : f.path}-${v.user}${dot > 0 ? f.path.slice(dot) : ""}`;
    const d = this.dialog(t("Check-in refused"), `<p>${esc(t(e.key, e.params))}</p><label class="v-lbl">${esc(t("New file"))}<input name="path" value="${esc(sug)}" maxlength="240" translate="no" /></label>`, [[t("Cancel"), "cancel"], [t("Discard my changes"), "discard"], [t("Save as new file"), "new"]]);
    const a = await d.done;
    const path = d.el.querySelector<HTMLInputElement>('[name="path"]')!.value.trim();
    if (a === "new") await this.run(async () => { const nf = await v.saveAsNew(id, path); this.sel = nf.id; toast(t("Saved as {name}", { name: path }), "success"); });
    else if (a === "discard") await this.run(() => v.undoCheckOut(id));
    if (this.openId === id) await this.reopen(id);
  }

  async undoCheckOut(id: string) {
    const v = this.vault;
    if (!v || !await confirmModal(t("Throw away the local changes to {name} and release it?", { name: this.rec(id).path }), t("Undo check-out"))) return;
    await this.run(() => v.undoCheckOut(id));
    if (this.openId === id) await this.reopen(id);
  }

  async getLatest(id: string) {
    const v = this.vault;
    if (!v) return;
    const st = this.state.get(id);
    if (st?.modified && !await confirmModal(t("The local copy of {name} has changes that are not checked in. Replace it with the latest version?", { name: this.rec(id).path }), t("Get latest"))) return;
    await this.run(() => v.getLatest(id, true));
    if (this.openId === id) await this.reopen(id);
  }

  /** Update links (FR-ASM-003): the checked-out assembly takes the latest versions of its linked components. */
  async updateLinks(id: string) {
    const v = this.vault;
    if (!v) return;
    await this.run(async () => {
      const changed = await v.updateLinks(id);
      toast(changed.length ? t("Links updated: {list}. Check the assembly in to keep them.", { list: changed.join(", ") }) : t("The links are up to date."), "success");
    });
    if (this.openId === id) await this.reopen(id);
  }

  async rollBack(id: string, n: number) {
    const v = this.vault;
    if (!v || !await confirmModal(t("Make version {n} the latest again? A new version is added; nothing is lost.", { n }), t("Roll back"), t("Roll back"))) return;
    await this.run(async () => { const m = await v.rollBack(id, n); toast(t("Version {m} has the content of version {n}", { m, n }), "success"); });
    if (this.openId === id) await this.reopen(id);
  }

  async history(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = await v.file(id);
    const log = await v.auditTrail(id);
    const rows = [...f.versions].reverse().map(x => `<tr><td>v${x.n}</td><td>${esc(fmtDate(x.at))}</td><td translate="no">${esc(x.user)}</td><td translate="no">${esc(x.comment)}</td><td>${fmtSize(x.size)}</td><td translate="no">${esc(x.rev ?? "")}</td><td>${esc(tn(x.state))}</td><td class="v-acts">${x.purged ? `<span class="muted">${esc(t("purged"))}</span>` : `<button class="btn small" data-open="${x.n}">${esc(t("Open"))}</button>${x.n !== v.latest(f).n ? `<button class="btn small" data-rb="${x.n}">${esc(t("Roll back"))}</button>` : ""}`}</td></tr>`).join("");
    const events = log.map(e => `<li>${esc(fmtDate(e.at))} · <span translate="no">${esc(e.user)}</span> · ${esc(t(e.action))}${e.version ? ` v${e.version}` : ""}${e.action === "transition" && e.details ? ` · <span translate="no">${esc(e.details)}</span>` : ""}</li>`).join("");
    const vs = f.versions.filter(x => !x.purged).map(x => `<option value="${x.n}">v${x.n}${x.rev ? ` (${esc(x.rev)})` : ""}</option>`).join("");
    const cmp = f.versions.filter(x => !x.purged).length > 1 ? `<div class="row v-cmp"><span>${esc(t("Compare"))}</span><select name="ca" aria-label="${esc(t("First version"))}">${vs}</select><select name="cb" aria-label="${esc(t("Second version"))}">${vs.replace(`value="${v.latest(f).n}"`, `value="${v.latest(f).n}" selected`)}</select><button class="btn small" data-cmp>${esc(t("Compare"))}</button></div>` : "";
    const d = this.dialog(t("History of {name}", { name: f.path }), `${cmp}<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Version"))}</th><th>${esc(t("Date"))}</th><th>${esc(t("User"))}</th><th>${esc(t("Comment"))}</th><th>${esc(t("Size"))}</th><th>${esc(t("Revision"))}</th><th>${esc(t("State"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><h4>${esc(t("Events"))}</h4><ul class="v-log">${events}</ul>`, [[t("Close"), "cancel"]]);
    d.el.querySelectorAll<HTMLElement>("[data-open]").forEach(b => b.addEventListener("click", () => { d.el.close(); void this.openFile(id, +b.dataset.open!); }));
    d.el.querySelectorAll<HTMLElement>("[data-rb]").forEach(b => b.addEventListener("click", () => { d.el.close(); void this.rollBack(id, +b.dataset.rb!); }));
    d.el.querySelector<HTMLElement>("[data-cmp]")?.addEventListener("click", e => {
      e.preventDefault();
      const a = +d.el.querySelector<HTMLSelectElement>('[name="ca"]')!.value, b = +d.el.querySelector<HTMLSelectElement>('[name="cb"]')!.value;
      void d.done.then(() => this.compareDlg(id, Math.min(a, b), Math.max(a, b)));
      d.el.close();
    });
  }

  async auditTrail() {
    const v = this.vault;
    if (!v) return;
    const log = await v.auditTrail();
    const rows = log.slice(-300).reverse().map(e => `<tr><td>${esc(fmtDate(e.at))}</td><td translate="no">${esc(e.user)}</td><td>${esc(t(e.action))}</td><td translate="no">${esc(e.path ?? "")}</td><td>${e.version ? `v${e.version}` : ""}</td><td translate="no">${esc(e.details ?? "")}</td></tr>`).join("");
    const d = this.dialog(t("Audit trail"), `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Date"))}</th><th>${esc(t("User"))}</th><th>${esc(t("Action"))}</th><th>${esc(t("File"))}</th><th>${esc(t("Version"))}</th><th>${esc(t("Details"))}</th></tr></thead><tbody>${rows}</tbody></table></div>`, [[t("Export CSV"), "csv"], [t("Close"), "cancel"]]);
    d.done.then(a => {
      if (a !== "csv") return;
      const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
      const csv = ["at,user,action,path,version,details", ...log.map(e => [e.at, e.user, e.action, e.path ?? "", e.version ?? "", e.details ?? ""].map(x => q(String(x))).join(","))].join("\n");
      const a2 = document.createElement("a");
      a2.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a2.download = `${v.info.name}-audit.csv`;
      a2.click();
      setTimeout(() => URL.revokeObjectURL(a2.href), 1000);
    });
  }

  async verify() {
    const v = this.vault;
    if (!v) return;
    const r = await v.verify();
    const ok = !r.missing.length && !r.corrupt.length;
    const list = (title: string, xs: string[]) => (xs.length ? `<p><b>${esc(title)}</b></p><ul class="v-log">${xs.slice(0, 50).map(x => `<li translate="no">${esc(x)}</li>`).join("")}</ul>` : "");
    this.dialog(t("Integrity check"), `${r.broken.length ? `<p><b>${esc(t("Broken references"))}</b></p><ul class="v-log">${r.broken.slice(0, 50).map(x => `<li translate="no">${esc(x)}</li>`).join("")}</ul>` : ""}<p>${esc(ok ? t("The vault is sound: {f} files, {o} stored objects.", { f: r.files, o: r.objects }) : t("Problems found in the vault."))}</p>${list(t("Missing versions"), r.missing)}${list(t("Damaged versions"), r.corrupt)}${r.orphans.length ? `<p class="muted">${esc(t("{n} stored objects are not used by any version.", { n: r.orphans.length }))}</p>` : ""}`, [[t("Close"), "cancel"]]);
  }

  /** Export vault (FR-PDM-007): a ZIP of everything, or of the latest versions only. */
  async exportZip(latestOnly?: boolean) {
    const v = this.vault;
    if (!v) return;
    if (latestOnly === undefined) {
      const r = await this.form(t("Export vault"), `<p>${esc(t("A ZIP backup of the vault: settings, history, audit trail, stored versions and working files. Import it in any browser to carry on."))}</p><label class="chk"><input type="checkbox" name="latest" /> ${esc(t("Latest versions only (smaller)"))}</label>`, t("Export"));
      if (!r) return;
      latestOnly = !!r.latest;
    }
    try {
      const entries = await v.exportEntries(latestOnly);
      const bytes = await zip(entries);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
      a.download = `${v.info.name}${latestOnly ? "-latest" : ""}.mcadvault.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(t("Vault exported: {n} files", { n: (await v.files()).length }), "success");
    } catch (e) { toast(t("Vault error: {err}", { err: (e as Error).message }), true); }
  }

  /** Import vault (FR-PDM-007): a vault ZIP becomes a new vault in this browser. */
  async importZip(file: File) {
    const ws = await workspace();
    if (!ws) { toast(t("This browser has no private file system; pick a folder instead."), true); return; }
    try {
      const entries = await unzipLimited(await file.arrayBuffer());
      const info = entries.get(".mcadvault/vault.json");
      if (!info) throw new VaultError("Not a vault backup.");
      const base = (JSON.parse(new TextDecoder().decode(info)).name as string || "Vault").replace(/[\\/:*?"<>|]/g, "_");
      const names = new Set((await ws.list()).map(e => e.name));
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
      const dir = await ws.dir(name, true);
      await this.use(await Vault.importEntries(dir!, entries, this.user, this.computer));
    } catch (e) { toast(errText(e), true); }
  }

  /** Storage report with Purge old versions (FR-PDM-008). */
  async storage() {
    const v = this.vault;
    if (!v) return;
    const rows = await v.storage();
    const total = rows.reduce((a, r) => a + r.bytes, 0);
    const body = `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("File"))}</th><th>${esc(t("Versions"))}</th><th>${esc(t("Stored"))}</th><th>${esc(t("Size"))}</th></tr></thead><tbody>${rows.sort((a, b) => b.bytes - a.bytes).map(r => `<tr><td translate="no">${esc(r.path)}</td><td>${r.versions}</td><td>${r.kept}</td><td>${fmtSize(r.bytes)}</td></tr>`).join("")}</tbody></table></div>
      <p>${esc(t("Total stored: {size}", { size: fmtSize(total) }))}</p>
      <label class="v-lbl">${esc(t("Purge old versions: keep the last"))}<input type="number" name="keep" min="1" max="999" value="5" /></label>
      <p class="muted">${esc(t("Purged versions stay in the history but their content is deleted. This cannot be undone."))}</p>`;
    const d = this.dialog(t("Storage"), body, [[t("Close"), "cancel"], [t("Purge"), "purge"]]);
    if (await d.done !== "purge") return;
    const keep = Math.max(1, +(d.el.querySelector<HTMLInputElement>('[name="keep"]')?.value ?? 5) || 5);
    if (!await confirmModal(t("Delete the content of all but the last {n} versions of every file?", { n: keep }), t("Purge"))) return;
    await this.run(async () => { const freed = await v.purge(keep); toast(t("Purged: {size} freed", { size: fmtSize(freed) }), "success"); });
  }

  // ---------- lifecycle (FR-PDM-031..034, 082) ----------

  private cardSummary(f: FileRec) {
    const v = this.vault!;
    const rel = v.released(f);
    const rows = v.cardFields(f.kind).filter(x => f.card?.[x.name]).slice(0, 5).map(x => `<dt>${esc(t(x.name))}</dt><dd translate="no">${esc(f.card![x.name])}</dd>`).join("");
    return `<dl class="v-card">${rows}${rel ? `<dt>${esc(t("Released"))}</dt><dd translate="no">${esc(rel.rev ?? "")} · v${rel.n}${rel.approvedBy ? ` · ${esc(rel.approvedBy)}` : ""}</dd>` : ""}</dl>`;
  }

  /**
   * Change state (FR-PDM-082): lists the file and its referenced files that can take the same transition, with
   * problems and warnings, before anything is written.
   */
  async transitionDlg(id: string, name: string, comment?: string, withRefs?: string[], notify = "") {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const tr = v.transitionsOf(f).find(x => x.name === name);
    if (!tr) return;
    // Referenced files in the same state can go along (release an assembly with its parts).
    const tree = await v.contains(id, undefined, "latest");
    const refs: FileRec[] = [];
    const walk = (n: TreeNode) => { for (const c of n.children) { const r = this.files.find(x => x.id === c.id); if (r && r.state === f.state && !refs.includes(r) && r.id !== id) refs.push(r); if (!c.cycle) walk(c); } };
    walk(tree);
    if (comment === undefined) {
      const render = async (ids: string[]) => {
        const chk = await v.checkTransition(ids, name, "x");
        return chk.map(c => `<li translate="no"><b>${esc(c.path)}</b> · v${c.version}${c.problems.map(p => `<div class="v-bad">${esc(tm(p))}</div>`).join("")}${c.warnings.map(p => `<div class="v-warn">${esc(tm(p))}</div>`).join("")}</li>`).join("");
      };
      const d = this.dialog(t("{name}: {from} → {to}", { name: tn(name), from: tn(tr.from), to: tn(tr.to) }), `
        ${refs.length ? `<p>${esc(t("Referenced files in the same state:"))}</p>${refs.map(r => `<label class="chk" translate="no"><input type="checkbox" name="ref" value="${r.id}" checked /> ${esc(r.path)}</label>`).join("")}` : ""}
        <ul class="v-log v-check">${await render([id, ...refs.map(r => r.id)])}</ul>
        <label class="v-lbl">${esc(tr.comment ? t("Comment (required)") : t("Comment"))}<textarea name="comment" rows="2" maxlength="500"></textarea></label>
        ${v.info.shared ? `<label class="v-lbl">${esc(t("Notify"))}<select name="to"><option value=""></option>${[...v.info.users, ...ROLES].map(u => `<option value="${esc(u)}">${esc(ROLES.includes(u as Role) ? tn(u) : u)}</option>`).join("")}</select></label>` : ""}`, [[t("Cancel"), "cancel"], [tn(name), "ok"]]);
      d.el.querySelectorAll<HTMLInputElement>('[name="ref"]').forEach(c => c.addEventListener("change", async () => {
        const ids = [id, ...[...d.el.querySelectorAll<HTMLInputElement>('[name="ref"]:checked')].map(x => x.value)];
        d.el.querySelector(".v-check")!.innerHTML = await render(ids);
      }));
      if (await d.done !== "ok") return;
      comment = d.el.querySelector<HTMLTextAreaElement>('[name="comment"]')!.value;
      withRefs = [...d.el.querySelectorAll<HTMLInputElement>('[name="ref"]:checked')].map(x => x.value);
      notify = d.el.querySelector<HTMLSelectElement>('[name="to"]')?.value ?? "";
    }
    const ids = [id, ...(withRefs ?? [])];
    await this.run(async () => {
      const labels = await v.transition(ids, name, comment!, notify);
      const rev = labels[id];
      toast(rev ? t("{name}: {state}, revision {rev}", { name: f.path, state: tn(tr.to), rev }) : t("{name}: {state}", { name: f.path, state: tn(tr.to) }), "success");
    });
    // FR-PDM-036: the release's PDF / STEP files, made after the state change so a failure there undoes nothing.
    if (v.info.outputs !== false && v.stateOf(tr.to).released) {
      const { releaseOutputKind, releaseOutputs } = await import("./outputs");
      if (ids.some(x => releaseOutputKind(this.rec(x)?.path ?? ""))) {
        toast(t("Making the release files…"));
        const r = await releaseOutputs(v, ids);
        await this.refresh();
        if (r.made.length) toast(t("Stored {files}", { files: r.made.join(", ") }), "success");
        for (const x of r.failed) toast(t("Could not make the release file of {path}: {err}", { path: x.path, err: x.error }), true);
      }
    }
    if (this.openId && ids.includes(this.openId)) await this.reopen(this.openId);
  }

  // ---------- data card and numbering (FR-PDM-040/041) ----------

  async dataCard(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id), editable = !!this.state.get(id)?.mine;
    const input = (fd: CardField) => {
      const val = f.card?.[fd.name] ?? "", nm = `c:${fd.name}`, dis = editable ? "" : " disabled";
      if (fd.type === "list") return `<select name="${esc(nm)}"${dis}><option value=""></option>${(fd.options ?? []).map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      if (fd.type === "checkbox") return `<input type="checkbox" name="${esc(nm)}"${val === "true" ? " checked" : ""}${dis} />`;
      if (fd.type === "user") return `<select name="${esc(nm)}"${dis}><option value=""></option>${v.info.users.map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      return `<input name="${esc(nm)}" type="${fd.type === "number" ? "text" : fd.type === "date" ? "date" : "text"}"${fd.type === "number" ? ' inputmode="decimal"' : ""} value="${esc(val)}" maxlength="200"${dis} />`;
    };
    const fields = v.cardFields(f.kind);
    const body = `<p translate="no">${esc(f.path)}</p>${editable ? "" : `<p class="muted">${esc(t("Check the file out to edit its data card."))}</p>`}
      <div class="v-form">${fields.map(fd => `<label><span>${esc(t(fd.name))}${fd.required ? " *" : ""}</span>${input(fd)}${fd.name === PART_NUMBER && editable ? `<button class="btn small" data-num>${esc(t("New number"))}</button>` : ""}</label>`).join("")}</div>`;
    // A file that can be checked out offers it here, and the card opens again editable.
    const canCo = !editable && !f.checkout && v.stateOf(f.state).checkout;
    const d = this.dialog(t("Data card"), body, editable ? [[t("Cancel"), "cancel"], [t("Save"), "ok"]] : canCo ? [[t("Close"), "cancel"], [t("Check out"), "co"]] : [[t("Close"), "cancel"]]);
    d.el.querySelector<HTMLElement>("[data-num]")?.addEventListener("click", async e => {
      e.preventDefault();
      try { const n = await v.issueNumber(f.card); d.el.querySelector<HTMLInputElement>(`[name="c:${PART_NUMBER}"]`)!.value = n; } catch (er) { toast(errText(er), true); }
    });
    const a = await d.done;
    if (a === "co") { await this.checkOut(id); if (this.state.get(id)?.mine) await this.dataCard(id); return; }
    if (a !== "ok") return;
    const vals: Record<string, string> = {};
    for (const fd of fields) {
      const el = d.el.querySelector<HTMLInputElement>(`[name="c:${CSS.escape(fd.name)}"]`);
      if (el) vals[fd.name] = el.type === "checkbox" ? String(el.checked) : el.value;
    }
    await this.run(async () => {
      await v.setCard(id, vals);
      // The open part gets the properties too (its saved copy is the vault's working copy).
      if (this.openId === id) await this.reopen(id);
      toast(t("Data card saved"), "success");
    });
  }

  // ---------- references (FR-PDM-021/022, 052) ----------

  private treeHtml(n: TreeNode, depth = 0): string {
    const li = (c: TreeNode): string => `<li translate="no">${c.qty > 1 ? `<b>${c.qty}×</b> ` : ""}${esc(c.path)}${c.missing ? ` <span class="v-bad">${esc(t("missing"))}</span>` : ` · v${c.version}${c.rev ? ` · ${esc(c.rev)}` : ""} · <span translate="yes">${esc(tn(c.state))}</span>`}${c.linked ? ` · <span class="v-link" translate="yes">⛓ ${esc(t("linked"))}</span>` : ""}${c.newer ? ` <span class="v-warn-i" translate="yes">${esc(t("v{n} in the vault", { n: c.newer }))}</span>` : ""}${c.cycle ? " ↻" : ""}${c.children.length && depth < 20 ? `<ul>${c.children.map(x => li(x)).join("")}</ul>` : ""}</li>`;
    return `<ul class="v-tree">${depth ? li(n) : n.children.map(li).join("")}</ul>`;
  }

  async containsDlg(id: string, version?: number, mode: Resolve = "built") {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const tree = await v.contains(id, version, mode);
    const opts = ([["built", "As checked in"], ["latest", "Latest"], ["released", "Latest released"]] as const).map(([k, l]) => `<option value="${k}"${k === mode ? " selected" : ""}>${esc(t(l))}</option>`).join("");
    const vers = [...f.versions].reverse().filter(x => !x.purged).map(x => `<option value="${x.n}"${x.n === tree.version ? " selected" : ""}>v${x.n}${x.rev ? ` (${esc(x.rev)})` : ""}</option>`).join("");
    const bom = await v.bom(id, version, mode);
    const d = this.dialog(t("Contains: {name}", { name: f.path }), `<div class="row"><select name="ver" aria-label="${esc(t("Version"))}">${vers}</select><select name="mode" aria-label="${esc(t("Components"))}">${opts}</select></div>
      ${tree.children.length ? `<div class="v-scroll">${this.treeHtml(tree)}</div>
      <h4>${esc(t("Bill of materials"))}</h4><div class="v-scroll"><table class="v-table v-bom"><thead><tr><th>${esc(t("File"))}</th><th>${esc(t("Part number"))}</th><th>${esc(t("Description"))}</th><th>${esc(t("Revision"))}</th><th>${esc(t("Qty"))}</th></tr></thead><tbody>${bom.map(r => `<tr translate="no"><td>${esc(r.path)}</td><td>${esc(r.partNumber)}</td><td>${esc(r.description)}</td><td>${esc(r.rev ?? "")} v${r.version}</td><td>${r.qty}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${esc(t("This file references no other files."))}</p>`}`,
      bom.length ? [[t("Export BOM CSV"), "csv"], [t("Close"), "cancel"]] : [[t("Close"), "cancel"]]);
    const again = () => {
      const ver = +d.el.querySelector<HTMLSelectElement>('[name="ver"]')!.value, md = d.el.querySelector<HTMLSelectElement>('[name="mode"]')!.value as Resolve;
      void d.done.then(() => this.containsDlg(id, ver, md));
      d.el.close();
    };
    d.el.querySelectorAll("select").forEach(s => s.addEventListener("change", again));
    if (await d.done === "csv") download(`${f.path.split("/").pop()}-v${tree.version}-bom.csv`, csvOf([["path", "part number", "description", "revision", "version", "qty"], ...bom.map(r => [r.path, r.partNumber, r.description, r.rev ?? "", r.version, r.qty])]), "text/csv");
  }

  async whereUsedDlg(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const ups = await v.whereUsed(id);
    // Each level says which version of the file below it uses, and when that is not the latest.
    const latestOf = (fid: string) => { const x = this.files.find(y => y.id === fid); return x ? v.latest(x).n : 0; };
    const li = (n: TreeNode, below: string): string => { const lv = latestOf(below); return `<li translate="no">${esc(n.path)} · ${n.qty}× · ${esc(t("uses v{n}", { n: n.version }))}${lv > n.version ? ` <span class="v-warn" translate="yes">${esc(t("(latest is v{n})", { n: lv }))}</span>` : ""}${n.cycle ? " ↻" : ""}${n.children.length ? `<ul>${n.children.map(c => li(c, n.id)).join("")}</ul>` : ""}</li>`; };
    this.dialog(t("Where used: {name}", { name: f.path }), ups.length ? `<div class="v-scroll"><ul class="v-tree">${ups.map(n => li(n, id)).join("")}</ul></div>` : `<p class="muted">${esc(t("No file in the vault uses this file."))}</p>`, [[t("Close"), "cancel"]]);
  }

  // ---------- compare (FR-PDM-050/052) ----------

  async compareDlg(id: string, a: number, b: number) {
    const v = this.vault;
    if (!v) return;
    try {
      const c = await v.compare(id, a, b);
      const table = (head: string[], rows: string[][]) => `<table class="v-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr translate="no">${r.map(x => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      const parts: string[] = [`<p>${esc(c.same ? t("The two versions have the same content.") : t("Size change: {d}", { d: `${c.size >= 0 ? "+" : "−"}${fmtSize(Math.abs(c.size))}` }))}</p>`];
      if (c.card.length) parts.push(`<h4>${esc(t("Data card"))}</h4>${table([t("Field"), `v${a}`, `v${b}`], c.card.map(x => [x.field, x.from, x.to]))}`);
      if (c.features) {
        const ft = c.features;
        if (ft.added.length) parts.push(`<p><b>${esc(t("Added features"))}:</b> <span translate="no">${esc(ft.added.join(", "))}</span></p>`);
        if (ft.removed.length) parts.push(`<p><b>${esc(t("Removed features"))}:</b> <span translate="no">${esc(ft.removed.join(", "))}</span></p>`);
        if (ft.changed.length) parts.push(`<h4>${esc(t("Changed parameters"))}</h4>${table([t("Feature"), t("Parameter"), `v${a}`, `v${b}`], ft.changed.slice(0, 200).map(x => [x.feature, x.param, x.from, x.to]))}`);
      }
      if (/\.mcaddrw$/i.test(c.path) && !c.same && !c.a.purged && !c.b.purged) parts.push(await this.drawingOverlay(id, a, b));
      let geo: import("../kernel/drawing").GeomDiff | null = null;
      if (geomComparable(c.path) && !c.same && !c.a.purged && !c.b.purged) {
        try {
          toast(t("Building the two versions…"));
          const r = await geometryCompare(c.path, await v.versionBytes(id, a), await v.versionBytes(id, b));
          geo = r.diff;
          parts.push(`<h4>${esc(t("Geometry"))}</h4>${table([t("Quantity"), `v${a}`, `v${b}`, t("Difference")], geomRows(r.diff, r.density).map(([q, x, y, d]) => [t(q), x, y, d]))}
            <p class="v-legend"><span class="v-old">${esc(t("only in v{n}", { n: a }))}</span> <span class="v-new">${esc(t("only in v{n}", { n: b }))}</span></p><div class="v-geo3d" aria-label="${esc(t("Material only in one of the versions"))}"></div>`);
        } catch (e) {
          parts.push(`<p class="muted">${esc(t("The two versions could not be built for comparing: {err}", { err: t((e as Error).message) }))}</p>`);
        }
      }
      if (c.refs.length) {
        parts.push(`<h4>${esc(t("References"))}</h4>${table([t("File"), `v${a}`, `v${b}`], c.refs.map(x => [x.path, x.from, x.to]))}`);
        const bc = await v.bomCompare(id, a, b);
        if (bc.length) parts.push(`<h4>${esc(t("BOM changes"))}</h4>${table([t("File"), t("What changed"), `v${a}`, `v${b}`], bc.map(x => [x.path, t(x.change), x.from, x.to]))}`);
      }
      const d = this.dialog(t("Compare v{a} and v{b} of {name}", { a, b, name: c.path }), `<div class="v-scroll">${parts.join("")}</div>`, [[t("Close"), "cancel"]]);
      const host = d.el.querySelector<HTMLElement>(".v-geo3d");
      if (geo && host) { const free = mountDiffView(host, geo); void d.done.then(free); }
    } catch (e) { toast(errText(e), true); }
  }

  /** FR-PDM-051: both versions of a drawing drawn and overlaid, sheet by sheet; only in the older one red, only in the newer one green. */
  private async drawingOverlay(id: string, a: number, b: number): Promise<string> {
    const v = this.vault!;
    try {
      toast(t("Drawing the two versions…"));
      const { renderDrawing, overlaySvg } = await import("../drawing/render");
      // One at a time: each takes a geometry kernel of its own.
      const ra = await renderDrawing(await v.versionBytes(id, a));
      const rb = await renderDrawing(await v.versionBytes(id, b));
      const out: string[] = [`<h4>${esc(t("Drawing overlay"))}</h4><p class="v-legend"><span class="v-old">${esc(t("only in v{n}", { n: a }))}</span> <span class="v-new">${esc(t("only in v{n}", { n: b }))}</span></p>`];
      for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
        const o = overlaySvg(ra[i], rb[i]), name = (rb[i] ?? ra[i]).name;
        const sheet = /^Sheet(\d+)$/.test(name) ? t("Sheet {n}", { n: name.slice(5) }) : name;
        out.push(`<p class="v-sheet"><b translate="no">${esc(sheet)}</b>: ${esc(o.removed || o.added ? t("{r} removed, {a} added", { r: o.removed, a: o.added }) : t("no visible change"))}</p><div class="v-overlay" data-removed="${o.removed}" data-added="${o.added}">${o.svg}</div>`);
      }
      return out.join("");
    } catch (e) {
      return `<p class="muted">${esc(t("The drawings could not be drawn for comparing: {err}", { err: (e as Error).message }))}</p>`;
    }
  }

  // ---------- rename, copy, delete (FR-PDM-023..025) ----------

  async renameDlg(id: string, to?: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    if (to === undefined) {
      const r = await this.form(t("Rename / move"), `<p class="muted">${esc(t("Use / for folders. Files that use this one get their references updated (a new version each)."))}</p><label class="v-lbl">${esc(t("New path"))}<input name="path" value="${esc(f.path)}" maxlength="240" autofocus translate="no" /></label>`, t("Rename"));
      if (!r) return;
      to = (r.path as string).trim();
    }
    await this.run(async () => { await v.rename(id, to!); toast(t("Renamed to {name}", { name: to! }), "success"); });
    if (this.openId === id) await this.reopen(id);
  }

  async copyTreeDlg(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const tree = await v.contains(id, undefined, "latest");
    const ids: { id: string; path: string }[] = [];
    const walk = (n: TreeNode) => { for (const c of n.children) { if (c.id && !ids.some(x => x.id === c.id)) ids.push({ id: c.id, path: c.path }); if (!c.cycle) walk(c); } };
    walk(tree);
    const folder = f.path.includes("/") ? `${f.path.split("/").slice(0, -1).join("/")}/copy` : "copy";
    const r = await this.form(t("Copy tree"), `<p translate="no">${esc(f.path)}</p>
      ${ids.length ? `<p>${esc(t("Copy these referenced files too (the others stay shared):"))}</p>${ids.map(x => `<label class="chk" translate="no"><input type="checkbox" name="id:${x.id}" checked /> ${esc(x.path)}</label>`).join("")}` : ""}
      <div class="v-form"><label><span>${esc(t("To folder"))}</span><input name="folder" value="${esc(folder)}" maxlength="200" translate="no" /></label>
      <label><span>${esc(t("Prefix"))}</span><input name="prefix" maxlength="40" /></label><label><span>${esc(t("Suffix"))}</span><input name="suffix" maxlength="40" /></label>
      <label><span>${esc(t("Find"))}</span><input name="find" maxlength="40" /></label><label><span>${esc(t("Replace with"))}</span><input name="replace" maxlength="40" /></label></div>
      <label class="chk"><input type="checkbox" name="renumber" /> ${esc(t("New part numbers from the numbering scheme"))}</label>`, t("Copy"));
    if (!r) return;
    await this.run(async () => {
      const out = await v.copyTree(id, { ids: ids.filter(x => r[`id:${x.id}`]).map(x => x.id), folder: r.folder as string, prefix: r.prefix as string, suffix: r.suffix as string, find: r.find as string, replace: r.replace as string, renumber: !!r.renumber });
      toast(t("Copied {n} file|Copied {n} files", { n: out.size }), "success");
      this.sel = out.get(id)?.id ?? this.sel;
    });
  }

  async deleteFile(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const users = await v.usersOf(id);
    if (users.length) {
      this.dialog(t("Cannot delete {name}", { name: f.path }), `<p>${esc(t("These files use it:"))}</p><ul class="v-log">${users.map(u => `<li translate="no">${esc(u.path)}</li>`).join("")}</ul>`, [[t("Close"), "cancel"]]);
      return;
    }
    if (!await confirmModal(t("Move {name} to the recycle bin?", { name: f.path }), t("Delete"))) return;
    await this.run(async () => { await v.remove(id); toast(t("{name} is in the recycle bin", { name: f.path }), "success"); });
    if (this.sel === id) this.sel = null;
    if (this.openId === id) this.app.doc()?.setVault(null);
    await this.render();
  }

  async recycleBinDlg() {
    const v = this.vault;
    if (!v) return;
    const bin = await v.recycleBin();
    const admin = v.has("Admin");
    const d = this.dialog(t("Recycle bin"), bin.length ? `<table class="v-table"><tbody>${bin.map(f => `<tr><td translate="no">${esc(f.path)}</td><td>${esc(fmtDate(f.deleted!.at))}</td><td class="v-acts"><button class="btn small" data-restore="${f.id}">${esc(t("Restore"))}</button>${admin ? `<button class="btn small" data-destroy="${f.id}">${esc(t("Destroy"))}</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">${esc(t("The recycle bin is empty."))}</p>`, [[t("Close"), "cancel"]]);
    d.el.querySelectorAll<HTMLElement>("[data-restore]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); d.el.close(); const path = bin.find(x => x.id === b.dataset.restore)?.path ?? ""; void this.run(async () => { await v.restore(b.dataset.restore!); this.sel = b.dataset.restore!; toast(t("{name} restored", { name: path }), "success"); }); }));
    d.el.querySelectorAll<HTMLElement>("[data-destroy]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      d.el.close();
      if (await confirmModal(t("Destroy this file and its history for good?"), t("Destroy"))) await this.run(() => v.destroy(b.dataset.destroy!));
    }));
  }

  // ---------- search (FR-PDM-042) ----------

  async find(q: SearchQuery | null, label: string) {
    const v = this.vault;
    if (!v) return;
    this.found = q ? { ids: new Set((await v.search(q)).map(f => f.id)), label } : null;
    await this.render();
  }

  async searchDlg() {
    const v = this.vault;
    if (!v) return;
    const fields = v.cardFields("*");
    const kinds = [...new Set(this.files.map(f => f.kind))].sort();
    const saved = v.info.searches ?? [];
    const body = `${saved.length ? `<p class="v-h">${esc(t("Saved searches"))}</p><div class="v-list">${saved.map((s, i) => `<button class="btn small" data-saved="${i}" translate="no">${esc(s.name)}</button>`).join("")}</div>` : ""}
      <div class="v-form">
      <label><span>${esc(t("Name or any field"))}</span><input name="text" maxlength="80" /></label>
      <label><span>${esc(t("Text inside files"))}</span><input name="content" maxlength="80" /></label>
      <label><span>${esc(t("State"))}</span><select name="state"><option value=""></option>${v.workflow.states.map(s => `<option value="${esc(s.name)}">${esc(tn(s.name))}</option>`).join("")}</select></label>
      <label><span>${esc(t("Revision"))}</span><input name="revision" maxlength="10" /></label>
      <label><span>${esc(t("Checked out by"))}</span><input name="by" maxlength="40" /></label>
      <label><span>${esc(t("Kind"))}</span><select name="kind"><option value=""></option>${kinds.map(k => `<option value="${esc(k)}">${esc(t(k))}</option>`).join("")}</select></label>
      <label><span>${esc(t("Changed from"))}</span><input name="from" type="date" /></label><label><span>${esc(t("Changed to"))}</span><input name="to" type="date" /></label>
      ${fields.map(fd => `<label><span>${esc(t(fd.name))}</span><input name="f:${esc(fd.name)}" maxlength="80" /></label>`).join("")}
      <label><span>${esc(t("Contains a file with"))}</span><select name="cf">${fields.map(fd => `<option value="${esc(fd.name)}">${esc(t(fd.name))}</option>`).join("")}</select></label>
      <label><span>${esc(t("equal to"))}</span><input name="cv" maxlength="80" /></label>
      <label><span>${esc(t("Save as"))}</span><input name="save" maxlength="40" placeholder="${esc(t("optional name"))}" /></label>
      </div>`;
    const d = this.dialog(t("Search the vault"), body, [[t("Cancel"), "cancel"], [t("Search"), "ok"]]);
    let pick: SearchQuery | null = null, pickName = "";
    d.el.querySelectorAll<HTMLElement>("[data-saved]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); const s = saved[+b.dataset.saved!]; pick = s.q; pickName = s.name; d.el.close("ok"); }));
    if (await d.done !== "ok") return;
    if (pick) { await this.find(pick, pickName); return; }
    const val = (n: string) => d.el.querySelector<HTMLInputElement>(`[name="${CSS.escape(n)}"]`)?.value.trim() ?? "";
    const q: SearchQuery = { text: val("text"), content: val("content"), state: val("state"), revision: val("revision"), checkedOutBy: val("by"), kind: val("kind"), from: val("from"), to: val("to"), fields: Object.fromEntries(fields.map(fd => [fd.name, val(`f:${fd.name}`)]).filter(([, x]) => x)) };
    if (val("cv")) q.contains = { field: val("cf"), value: val("cv") };
    const name = val("save");
    if (name) await this.run(() => v.saveSettings({ searches: [...saved.filter(s => s.name !== name), { name, q }] }, "saved search"));
    await this.find(q, name || q.text || q.content || t("Advanced search"));
  }

  // ---------- settings (FR-PDM-030/037/040/041) ----------

  async settingsDlg() {
    const v = this.vault;
    if (!v) return;
    const rs = v.revScheme, nb = v.numbering, admin = v.has("Admin");
    const cards = v.cardFields("*").map(fd => [fd.name, fd.type, (fd.options ?? []).join(";"), fd.required ? "required" : "", fd.prop ?? ""].join(" | ").replace(/( \| )+$/, "")).join("\n");
    const roles = v.info.users.map(u => `${u}: ${v.rolesOf(u).join(", ")}`).join("\n");
    const dis = admin ? "" : " disabled";
    const body = `${admin ? "" : `<p class="muted">${esc(t("Only an Admin can change the vault settings."))}</p>`}
      <div class="v-form">
      <label><span>${esc(t("Revision scheme"))}</span><select name="kind"${dis}>${([["letters", "Letters A, B, C …"], ["numbers", "Numbers 01, 02 …"], ["eskd", "ESKD letters О, О1, А, Б …"], ["custom", "Custom list"]] as const).map(([k, l]) => `<option value="${k}"${rs.kind === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>
      <label><span>${esc(t("Custom labels"))}</span><input name="labels" value="${esc((rs.labels ?? []).join(", "))}" placeholder="A1, A2, B1"${dis} /></label>
      <label><span>${esc(t("Pre-release"))}</span><select name="pre"${dis}>${([["none", "None"], ["dash", "-"], ["decimal", "0.1, 0.2 …"], ["x", "X1, X2 …"]] as const).map(([k, l]) => `<option value="${k}"${(rs.pre ?? "none") === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>
      <label class="chk"><input type="checkbox" name="skip"${rs.skip ? " checked" : ""}${dis} /> ${esc(t("Skip I, O, Q, S, X, Z (ASME Y14.35)"))}</label>
      <label><span>${esc(t("Numbering pattern"))}</span><input name="pattern" value="${esc(nb.pattern)}" maxlength="60" translate="no"${dis} /></label>
      <label class="chk"><input type="checkbox" name="onAdd"${nb.onAdd ? " checked" : ""}${dis} /> ${esc(t("Number new files when they are added"))}</label>
      <label class="chk"><input type="checkbox" name="commentRequired"${v.info.commentRequired ? " checked" : ""}${dis} /> ${esc(t("Check-in needs a comment"))}</label>
      <label class="chk"><input type="checkbox" name="outputs"${v.info.outputs !== false ? " checked" : ""}${dis} /> ${esc(t("On release, store a PDF of drawings and a STEP of parts and assemblies"))}</label>
      </div>
      <p class="muted">${esc(t("Pattern tokens: {YYYY} {YY} {MM} for the date, {0000} for the counter, {Project} or any data card field."))}</p>
      <label class="v-lbl">${esc(t("Data card fields, one per line: name | type | options;… | required | property"))}<textarea name="cards" rows="5" translate="no"${dis}>${esc(cards)}</textarea></label>
      <label class="chk"><input type="checkbox" name="shared"${v.info.shared ? " checked" : ""}${dis} /> ${esc(t("Shared vault: users have roles"))}</label>
      <label class="v-lbl">${esc(t("Roles, one user per line (Designer, Checker, Approver, Admin)"))}<textarea name="roles" rows="3" translate="no"${dis}>${esc(roles)}</textarea></label>
      <p class="muted">${esc(t("Users and roles identify who did what; they are not security. Anyone who can write to the vault folder can change its files."))}</p>`;
    const d = this.dialog(t("Vault settings"), body, admin ? [[t("Cancel"), "cancel"], [t("Save"), "ok"]] : [[t("Close"), "cancel"]]);
    if (await d.done !== "ok") return;
    const g = (n: string) => d.el.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
    const types = new Set(["text", "number", "date", "list", "checkbox", "user"]);
    const fields: CardField[] = g("cards").value.split("\n").map(l => l.split("|").map(x => x.trim())).filter(p => p[0]).map(([name, type, opts, req, prop]) => ({ name, type: (types.has(type) ? type : "text") as CardField["type"], ...(opts ? { options: opts.split(";").map(x => x.trim()).filter(Boolean) } : {}), ...(req === "required" ? { required: true } : {}), ...(prop ? { prop } : {}) }));
    const roleMap: Record<string, Role[]> = {};
    for (const l of g("roles").value.split("\n")) {
      const [u, rs2] = l.split(":");
      if (u?.trim()) roleMap[u.trim()] = (rs2 ?? "").split(",").map(x => x.trim()).filter((x): x is Role => (ROLES as string[]).includes(x));
    }
    await this.run(async () => {
      await v.saveSettings({
        revScheme: { kind: g("kind").value as "letters", skip: g("skip").checked, pre: g("pre").value as "none", labels: g("labels").value.split(",").map(x => x.trim()).filter(Boolean) },
        numbering: { pattern: g("pattern").value.trim() || "MC-{0000}", onAdd: g("onAdd").checked },
        commentRequired: g("commentRequired").checked,
        outputs: g("outputs").checked,
        cards: { ...(v.info.cards ?? {}), "*": fields },
        shared: g("shared").checked,
        roles: roleMap,
      });
      toast(t("Vault settings saved"), "success");
    });
  }

  // ---------- shared vault, notifications (FR-PDM-061/070) ----------

  private get seenKey() { return `mc:vaultSeen:${this.vault?.info.name ?? ""}:${this.user}`; }
  /** When this user last opened the notifications of this vault (a new user starts from now). */
  private get seenAt() {
    let s = storage.get(this.seenKey);
    if (!s) { s = new Date().toISOString(); storage.set(this.seenKey, s); }
    return s;
  }

  async notificationsDlg() {
    const v = this.vault;
    if (!v) return;
    const list = (await v.notifications(this.seenAt)).reverse();
    storage.set(this.seenKey, new Date().toISOString());
    this.unseen = 0;
    await this.render();
    this.dialog(t("Notifications"), list.length ? `<ul class="v-log">${list.map(e => `<li>${esc(fmtDate(e.at))} · <span translate="no">${esc(e.user)}</span> · ${esc(t(e.action))}${e.path ? ` · <span translate="no">${esc(e.path)}</span>` : ""}${e.version ? ` v${e.version}` : ""}${e.details ? ` · <span translate="no">${esc(e.details)}</span>` : ""}${e.to ? ` → <b translate="no">${esc(ROLES.includes(e.to as Role) ? tn(e.to) : e.to)}</b>` : ""}</li>`).join("")}</ul>` : `<p class="muted">${esc(t("Nothing new since your last visit."))}</p>`, [[t("Close"), "cancel"]]);
  }

  async breakLock(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const r = await this.form(t("Break lock"), `<p>${esc(t("{user} has had {name} checked out since {date}. Their changes that are not checked in stay on their computer, but they can no longer check them in.", { user: f.checkout?.user ?? "", name: f.path, date: f.checkout ? fmtDate(f.checkout.at) : "" }))}</p><label class="v-lbl">${esc(t("Reason"))}<input name="reason" maxlength="200" /></label>`, t("Break lock"));
    if (!r) return;
    await this.run(() => v.breakLock(id, r.reason as string));
  }

  // ---------- change orders and release packages (FR-PDM-053/054) ----------

  async newChange(ids: string[]) {
    const v = this.vault;
    if (!v) return;
    const body = `<div class="v-form"><label><span>${esc(t("Title"))}</span><input name="title" maxlength="120" autofocus /></label>
      <label><span>${esc(t("Notify"))}</span><select name="to">${["Approver", ...v.info.users].map(u => `<option value="${esc(u)}">${esc(ROLES.includes(u as Role) ? tn(u) : u)}</option>`).join("")}</select></label></div>
      <label class="v-lbl">${esc(t("Reason"))}<textarea name="reason" rows="3" maxlength="1000"></textarea></label>
      <p>${esc(t("Affected files"))}</p><div class="v-scroll v-pick">${this.files.map(f => `<label class="chk" translate="no"><input type="checkbox" name="f:${f.id}"${ids.includes(f.id) ? " checked" : ""} /> ${esc(f.path)} · ${esc(f.revision ?? "")}</label>`).join("")}</div>`;
    const r = await this.form(t("Change request"), body, t("Request"));
    if (!r) return;
    await this.run(async () => {
      const c = await v.requestChange(r.title as string, r.reason as string, this.files.filter(f => r[`f:${f.id}`]).map(f => f.id), r.to as string);
      toast(t("{n} requested", { n: c.number }), "success");
    });
  }

  async changesDlg() {
    const v = this.vault;
    if (!v) return;
    const list = (await v.changes()).reverse();
    const all = await v.files(true);
    const name = (id: string) => all.find(f => f.id === id)?.path ?? id;
    const approver = v.has("Approver");
    const rows = list.map(c => `<tr><td translate="no"><b>${esc(c.number)}</b></td><td translate="no">${esc(c.title)}<div class="muted">${esc(c.reason)}</div><div class="muted">${c.files.map(f => esc(name(f))).join(", ")}</div></td><td>${esc(t(c.state))}</td><td translate="no">${esc(c.requester)}</td><td class="v-acts">${approver && c.state === "Requested" ? `<button class="btn small" data-eco-ok="${c.id}">${esc(t("Approve"))}</button><button class="btn small" data-eco-no="${c.id}">${esc(t("Reject"))}</button>` : ""}${approver && c.state === "Approved" ? `<button class="btn small" data-eco-close="${c.id}">${esc(t("Close and release"))}</button>` : ""}</td></tr>`).join("");
    const d = this.dialog(t("Change orders"), `<p class="muted">${esc(t("A request lists the files to change and why. Approving it moves released files to Change pending; closing it releases them together with new revisions and records a release package."))}</p>${list.length ? `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Number"))}</th><th>${esc(t("Title"))}</th><th>${esc(t("State"))}</th><th>${esc(t("User"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(t("No change requests yet."))}</p>`}`, [[t("Close"), "cancel"], [t("New request…"), "new"]]);
    const act = (sel: string, fn: (id: string) => Promise<unknown>) => d.el.querySelectorAll<HTMLElement>(`[${sel}]`).forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      d.el.close();
      await this.run(() => fn(b.getAttribute(sel)!));
      void this.changesDlg();
    }));
    act("data-eco-ok", id => v.approveChange(id));
    act("data-eco-close", async id => { const c = await v.closeChange(id); toast(t("{n} closed: files released", { n: c.number }), "success"); });
    d.el.querySelectorAll<HTMLElement>("[data-eco-no]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      d.el.close();
      const r = await this.form(t("Reject"), `<label class="v-lbl">${esc(t("Comment (required)"))}<textarea name="comment" rows="2" maxlength="500" autofocus></textarea></label>`, t("Reject"));
      if (r) await this.run(() => v.rejectChange(b.dataset.ecoNo!, r.comment as string));
      void this.changesDlg();
    }));
    if (await d.done === "new") await this.newChange(this.sel ? [this.sel] : []);
  }

  async packagesDlg() {
    const v = this.vault;
    if (!v) return;
    const list = await v.baselines();
    const d = this.dialog(t("Release packages"), list.length ? `<div class="v-scroll"><table class="v-table"><tbody>${list.map(b => `<tr><td translate="no"><b>${esc(b.name)}</b><div class="muted">${b.files.map(f => `${esc(f.path)}${f.rev ? ` ${esc(f.rev)}` : ""}`).join(", ")}</div></td><td>${esc(fmtDate(b.at))}</td><td class="v-acts"><button class="btn small" data-zip="${b.id}">${esc(t("Export ZIP"))}</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${esc(t("Files released together, or by a change order, are recorded here."))}</p>`, [[t("Close"), "cancel"]]);
    d.el.querySelectorAll<HTMLElement>("[data-zip]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault();
      try {
        const bl = list.find(x => x.id === b.dataset.zip)!;
        download(`${bl.name.replace(/[\\/:*?"<>|]/g, "_")}.zip`, (await zip(await v.baselineEntries(bl.id))) as BlobPart, "application/zip");
      } catch (er) { toast(errText(er), true); }
    }));
  }

  // ---------- workflow editor (FR-PDM-035) ----------

  async workflowDlg(wf?: Workflow) {
    const v = this.vault;
    if (!v) return;
    const w: Workflow = wf ?? structuredClone(v.workflow);
    const admin = v.has("Admin"), dis = admin ? "" : " disabled";
    const opts = (sel: string) => w.states.map(s => `<option${s.name === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    const states = w.states.map((s, i) => `<tr data-s="${i}"><td><input name="name" value="${esc(s.name)}" maxlength="40" aria-label="${esc(t("State"))}" translate="no"${dis} /></td><td><input type="color" name="color" value="${esc(s.color)}" aria-label="${esc(t("Colour"))}"${dis} /></td><td><input type="checkbox" name="checkout"${s.checkout ? " checked" : ""} aria-label="${esc(t("Can be checked out"))}"${dis} /></td><td><input type="checkbox" name="released"${s.released ? " checked" : ""} aria-label="${esc(t("Released"))}"${dis} /></td><td><input type="checkbox" name="obsolete"${s.obsolete ? " checked" : ""} aria-label="${esc(t("Obsolete"))}"${dis} /></td><td>${admin ? `<button class="btn small" data-del-s="${i}" aria-label="${esc(t("Delete"))}">✕</button>` : ""}</td></tr>`).join("");
    const trs = w.transitions.map((x, i) => `<tr data-t="${i}"><td><input name="name" value="${esc(x.name)}" maxlength="40" aria-label="${esc(t("Transition"))}" translate="no"${dis} /></td><td><select name="from" aria-label="${esc(t("From"))}" translate="no"${dis}>${opts(x.from)}</select></td><td><select name="to" aria-label="${esc(t("To"))}" translate="no"${dis}>${opts(x.to)}</select></td>
      <td><select name="revision" aria-label="${esc(t("Revision"))}"${dis}><option value=""></option><option value="release"${x.revision === "release" ? " selected" : ""}>${esc(t("Next revision"))}</option><option value="pre"${x.revision === "pre" ? " selected" : ""}>${esc(t("Pre-release"))}</option></select></td>
      <td><select name="role" aria-label="${esc(t("Role"))}"${dis}><option value=""></option>${ROLES.map(r => `<option value="${r}"${x.role === r ? " selected" : ""}>${esc(tn(r))}</option>`).join("")}</select></td>
      <td><input type="checkbox" name="comment"${x.comment ? " checked" : ""} aria-label="${esc(t("Needs a comment"))}"${dis} /></td><td><input type="checkbox" name="refs"${x.refsReleased ? " checked" : ""} aria-label="${esc(t("Referenced files released"))}"${dis} /></td>
      <td><input name="fields" value="${esc((x.fields ?? []).join(", "))}" aria-label="${esc(t("Required fields"))}" maxlength="200"${dis} /></td><td>${admin ? `<button class="btn small" data-del-t="${i}" aria-label="${esc(t("Delete"))}">✕</button>` : ""}</td></tr>`).join("");
    const body = `<p class="muted">${esc(t("States and the transitions between them. A transition can give the next revision, need a role, a comment, filled fields or released referenced files."))}</p>
      <div class="v-scroll"><table class="v-table v-wf"><thead><tr><th>${esc(t("State"))}</th><th>${esc(t("Colour"))}</th><th>${esc(t("Check-out"))}</th><th>${esc(t("Released"))}</th><th>${esc(t("Obsolete"))}</th><th></th></tr></thead><tbody>${states}</tbody></table>
      ${admin ? `<button class="btn small" data-add-s>${esc(t("Add state"))}</button>` : ""}
      <table class="v-table v-wf"><thead><tr><th>${esc(t("Transition"))}</th><th>${esc(t("From"))}</th><th>${esc(t("To"))}</th><th>${esc(t("Revision"))}</th><th>${esc(t("Role"))}</th><th>${esc(t("Comment"))}</th><th>${esc(t("Refs released"))}</th><th>${esc(t("Required fields"))}</th><th></th></tr></thead><tbody>${trs}</tbody></table>
      ${admin ? `<button class="btn small" data-add-t>${esc(t("Add transition"))}</button>` : ""}</div>
      <div class="row"><label>${esc(t("Initial state"))} <select name="initial" translate="no"${dis}>${opts(w.initial)}</select></label></div>
      <input type="file" id="v-wf-file" accept=".json" hidden />`;
    const d = this.dialog(t("Workflow"), body, admin ? [[t("Cancel"), "cancel"], [t("Export JSON"), "export"], [t("Import JSON…"), "import"], [t("Reset to default"), "reset"], [t("Save"), "ok"]] : [[t("Export JSON"), "export"], [t("Close"), "cancel"]]);
    // Reads the table back into a workflow (renamed states follow in the transitions).
    const read = (): Workflow => {
      const names = new Map<string, string>();
      const st = [...d.el.querySelectorAll<HTMLElement>("[data-s]")].map(r => {
        const old = w.states[+r.dataset.s!], q = (n: string) => r.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
        const name = q("name").value.trim() || old.name;
        names.set(old.name, name);
        return { name, color: q("color").value, checkout: q("checkout").checked, ...(q("released").checked ? { released: true } : {}), ...(q("obsolete").checked ? { obsolete: true } : {}) };
      });
      const rn = (x: string) => names.get(x) ?? x;
      const tr = [...d.el.querySelectorAll<HTMLElement>("[data-t]")].map(r => {
        const q = (n: string) => r.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
        const fields = q("fields").value.split(",").map(x => x.trim()).filter(Boolean);
        return { name: q("name").value.trim() || "Transition", from: rn(q("from").value), to: rn(q("to").value), ...(q("revision").value ? { revision: q("revision").value as "release" } : {}), ...(q("role").value ? { role: q("role").value as Role } : {}), ...(q("comment").checked ? { comment: true } : {}), ...(q("refs").checked ? { refsReleased: true } : {}), ...(fields.length ? { fields } : {}) };
      });
      return { name: w.name, initial: rn(d.el.querySelector<HTMLSelectElement>('[name="initial"]')!.value), states: st, transitions: tr };
    };
    // The same dialog element is reused: open the next one once this one has finished closing.
    const reopen = (nw: Workflow) => { void d.done.then(() => this.workflowDlg(nw)); d.el.close("redraw"); };
    d.el.querySelector("[data-add-s]")?.addEventListener("click", e => { e.preventDefault(); const nw = read(); nw.states.push({ name: `State ${nw.states.length + 1}`, color: "#64748b", checkout: false }); reopen(nw); });
    d.el.querySelector("[data-add-t]")?.addEventListener("click", e => { e.preventDefault(); const nw = read(); nw.transitions.push({ name: "Transition", from: nw.states[0].name, to: nw.states[nw.states.length - 1].name }); reopen(nw); });
    d.el.querySelectorAll<HTMLElement>("[data-del-s]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); const nw = read(); const gone = nw.states.splice(+b.dataset.delS!, 1)[0]; nw.transitions = nw.transitions.filter(x => x.from !== gone.name && x.to !== gone.name); if (nw.initial === gone.name) nw.initial = nw.states[0]?.name ?? ""; reopen(nw); }));
    d.el.querySelectorAll<HTMLElement>("[data-del-t]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); const nw = read(); nw.transitions.splice(+b.dataset.delT!, 1); reopen(nw); }));
    const a = await d.done;
    if (a === "redraw" || a === "cancel" || !a) return;
    if (a === "export") { download(`${v.info.name}-workflow.json`, JSON.stringify(admin ? read() : w, null, 2), "application/json"); return; }
    if (a === "reset") { if (await confirmModal(t("Replace the workflow with the default one?"), t("Reset to default"))) await this.run(async () => { await v.saveSettings({ workflow: defaultWorkflow() }); toast(t("Workflow saved"), "success"); }); return; }
    if (a === "import") {
      const inp = document.getElementById("v-wf-file") as HTMLInputElement | null ?? Object.assign(document.createElement("input"), { type: "file", accept: ".json" });
      inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file) return;
        try { const nw = JSON.parse(await file.text()) as Workflow; if (!Array.isArray(nw.states) || !Array.isArray(nw.transitions)) throw new VaultError("Not a workflow file."); void this.workflowDlg(nw); } catch (er) { toast(errText(er), true); }
      };
      inp.click();
      return;
    }
    const nw = read();
    // States in use must still exist.
    const missing = [...new Set(this.files.map(f => f.state))].filter(s2 => !nw.states.some(x => x.name === s2));
    if (missing.length) { toast(t("Files are still in {list}: keep those states.", { list: missing.join(", ") }), true); void this.workflowDlg(nw); return; }
    await this.run(async () => { await v.saveSettings({ workflow: nw }); toast(t("Workflow saved"), "success"); });
  }

  // ---------- dialogs ----------

  private dialog(title: string, html: string, buttons: [string, string][]) {
    let d = document.getElementById("vault-dlg") as HTMLDialogElement | null;
    if (!d) {
      d = document.createElement("dialog");
      d.id = "vault-dlg";
      d.className = "modal v-dlg";
      d.setAttribute("aria-labelledby", "vault-dlg-title");
      document.body.appendChild(d);
    }
    if (d.open) d.close();
    d.innerHTML = `<form method="dialog"><h3 id="vault-dlg-title" translate="no">${esc(title)}</h3><div class="v-body">${html}</div><div class="row end">${buttons.map(([l, v], i) => `<button class="btn${i === buttons.length - 1 && buttons.length > 1 ? " primary" : ""}" value="${v}"${v === "cancel" ? " formnovalidate" : ""}>${esc(l)}</button>`).join("")}</div></form>`;
    d.returnValue = "";
    const opener = document.activeElement as HTMLElement | null;
    d.showModal();
    (d.querySelector<HTMLElement>("[autofocus]") ?? d.querySelector<HTMLElement>("button"))?.focus();
    const el = d;
    const done = new Promise<string>(res => el.addEventListener("close", () => { opener?.focus?.(); res(el.returnValue); }, { once: true }));
    return { el, done };
  }

  /** A small form; resolves to its values, or null when cancelled. */
  private async form(title: string, html: string, ok: string): Promise<Record<string, string | boolean> | null> {
    const d = this.dialog(title, html, [[t("Cancel"), "cancel"], [ok, "ok"]]);
    // Select all / none / only documents over a list of files.
    d.el.querySelectorAll<HTMLElement>("[data-all]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault();
      d.el.querySelectorAll<HTMLInputElement>(".v-pick input[type=checkbox]").forEach(c => {
        const name = c.parentElement?.textContent?.trim() ?? "";
        c.checked = b.dataset.all === "docs" ? /\.mcad(prt|asm|drw)$/i.test(name) : b.dataset.all === "1";
      });
    }));
    const a = await d.done;
    if (a !== "ok") return null;
    const out: Record<string, string | boolean> = {};
    d.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach(x => { out[x.name] = x instanceof HTMLInputElement && x.type === "checkbox" ? x.checked : x.value; });
    return out;
  }

  // ---------- view ----------

  /** Renders run one after another, so the last one asked for is the last one drawn. */
  private rendering: Promise<void> = Promise.resolve();
  render(): Promise<void> {
    return (this.rendering = this.rendering.then(() => this.draw()).catch(e => { console.error(e); }));
  }

  private async draw() {
    const h = this.host, v = this.vault;
    const user = `<label class="v-user">${esc(t("User"))} <input id="v-user" value="${esc(this.user)}" maxlength="40" autocomplete="name" translate="no" /></label>`;
    if (!v) {
      const ws = await workspace();
      // A re-render (the tab was shown again) keeps a name being typed.
      const names = ws ? (await ws.list()).filter(e => e.kind === "dir").map(e => e.name).sort() : [];
      const typed = h.querySelector<HTMLInputElement>("#v-name")?.value ?? "";
      const fsa = this.foldersOk;
      const folders = fsa ? await vaultFolders() : [];
      h.innerHTML = `<div class="pad v-start">
        <p class="muted">${esc(t("A vault keeps every version of your files, with check-out, check-in, history and an audit trail."))}</p>
        ${user}
        ${names.length ? `<p class="v-h">${esc(t("Vaults in this browser"))}</p><div class="v-list">${names.map(n => `<button class="btn small" data-openws="${esc(n)}" translate="no">${esc(n)}</button>`).join("")}</div>` : ""}
        <div class="row"><input id="v-name" value="${esc(typed)}" placeholder="${esc(t("Vault name"))}" aria-label="${esc(t("Vault name"))}" maxlength="60" /><button class="btn small primary" data-a="new-ws"${ws ? "" : " disabled"}>${esc(t("New vault"))}</button></div>
        <div class="row"><button class="btn small" data-a="import"${ws ? "" : " disabled"}>${esc(t("Import vault ZIP…"))}</button><input type="file" id="v-zip" accept=".zip" hidden /></div>
        <p class="v-h">${esc(t("Vault in a folder on this computer"))}</p>
        ${fsa ? `<p class="muted">${esc(t("Pick any folder, also on a network drive or a synced one: the vault's files and all their versions are kept there."))}</p>
        ${folders.length ? `<div class="v-list">${folders.map(f => `<button class="btn small" data-openfolder="${esc(f.key)}" title="${esc(t("Open the vault in this folder"))}" translate="no">${esc(f.name)}</button>`).join("")}</div>` : ""}
        <div class="row"><button class="btn small primary" data-a="new-dir">${esc(t("New vault in a folder…"))}</button><button class="btn small" data-a="open-dir">${esc(t("Open vault folder…"))}</button></div>`
          : `<p class="muted v-nofsa">${esc(t("A vault in a folder needs Chrome or Edge on a computer. In this browser, use a browser vault and Export ZIP for backups."))}</p>`}
      </div>`;
    } else {
      const sel = this.sel ? this.files.find(f => f.id === this.sel) ?? null : null;
      const st = sel ? this.state.get(sel.id) : undefined;
      const row = (f: FileRec) => {
        const s = this.state.get(f.id) ?? { mine: false, by: null, modified: false, missing: false };
        const lock = f.checkout ? `<span class="v-lock${s.mine ? " mine" : ""}" title="${esc(t("Checked out by {user}", { user: f.checkout.user }))}">🔒 <span translate="no">${esc(f.checkout.user)}</span></span>` : "";
        const color = v.stateOf(f.state).color;
        const pn = f.card?.[PART_NUMBER];
        return `<button class="v-row${f.id === this.sel ? " sel" : ""}" data-id="${f.id}" aria-pressed="${f.id === this.sel}"><span class="v-name" translate="no">${esc(f.path)}</span><span class="v-meta"><span class="v-state"><i style="background:${esc(color)}"></i>${esc(tn(f.state))}</span>${f.revision ? ` · ${esc(t("Rev {rev}", { rev: f.revision }))}` : ""} · ${esc(t(f.kind))} · v${v.latest(f).n}${pn ? ` · <span translate="no">${esc(pn)}</span>` : ""}${s.modified ? ` · <b>${esc(t("modified"))}</b>` : ""}${s.missing ? ` · ${esc(t("no local copy"))}` : ""} ${lock}</span></button>`;
      };
      const trs = sel ? v.transitionsOf(sel) : [];
      const acts = sel ? `<div class="v-acts" aria-label="${esc(t("Selected file"))}">
        <div class="v-acts-h" translate="no">${esc(sel.path)}</div>
        <div class="row">
        <button class="btn small primary" data-a="open">${esc(t("Open"))}</button>
        ${!sel.checkout && v.stateOf(sel.state).checkout ? `<button class="btn small" data-a="co">${esc(t("Check out"))}</button>` : ""}
        ${st?.mine ? `<button class="btn small" data-a="ci">${esc(t("Check in"))}</button><button class="btn small" data-a="undo">${esc(t("Undo check-out"))}</button>` : ""}
        <button class="btn small" data-a="latest">${esc(t("Get latest"))}</button>
        <button class="btn small" data-a="hist">${esc(t("History"))}</button>
        ${sel.kind === "drawing" ? `<button class="btn small" data-a="pdf">${esc(t("PDF"))}</button>` : ""}
        </div>
        ${trs.length ? `<div class="row v-trs"><span class="muted">${esc(t("Change state"))}:</span>${trs.map(x => `<button class="btn small" data-tr="${esc(x.name)}">${esc(tn(x.name))}</button>`).join("")}</div>` : ""}
        <div class="row">
        <button class="btn small" data-a="card">${esc(t("Data card"))}</button>
        <button class="btn small" data-a="contains">${esc(t("Contains"))}</button>
        <button class="btn small" data-a="used">${esc(t("Where used"))}</button>
        <button class="btn small" data-a="rename">${esc(t("Rename / move…"))}</button>
        <button class="btn small" data-a="copy">${esc(t("Copy tree…"))}</button>
        <button class="btn small" data-a="del">${esc(t("Delete"))}</button>
        <button class="btn small" data-a="eco">${esc(t("Request change…"))}</button>
        ${sel.checkout && !st?.mine && v.has("Admin") ? `<button class="btn small" data-a="break">${esc(t("Break lock"))}</button>` : ""}
        </div>
        ${this.conflicts.length ? `<p class="v-warn">${esc(t("Also checked out at the same time by {list}: the earlier check-out holds the lock.", { list: this.conflicts.join(", ") }))}</p>` : ""}
        ${this.stale.length ? `<div class="v-warn v-stale"><p>${esc(t("Linked components with newer versions in the vault:"))}</p><ul>${this.stale.map(x => `<li translate="no">${esc(x.path)} · v${x.version} → v${x.latest}</li>`).join("")}</ul>${st?.mine ? `<button class="btn small" data-a="links">${esc(t("Update links"))}</button>` : `<p class="muted">${esc(t("Check the assembly out to update its links."))}</p>`}</div>` : ""}
        ${this.cardSummary(sel)}
      </div>` : "";
      const shown = this.found ? this.files.filter(f => this.found!.ids.has(f.id)) : this.files;
      h.innerHTML = `<div class="pad v-top"><div class="v-title"><b translate="no">${esc(v.info.name)}</b><button class="btn small" data-a="close">${esc(t("Close vault"))}</button></div>${user}
        <div class="row"><button class="btn small" data-a="add">${esc(t("Add files…"))}</button><button class="btn small" data-a="addfolder" title="${esc(t("Files already in the vault folder go in where they are, subfolders and all"))}">${esc(t("Add files in this folder…"))}</button><button class="btn small" data-a="savepart"${this.app.doc() && !this.openId ? "" : " disabled"} title="${esc(t("The open part, assembly or drawing becomes a vault file, checked out to you"))}">${esc(t("Save to vault"))}</button></div>
        <div class="row"><button class="btn small" data-a="audit">${esc(t("Audit trail"))}</button><button class="btn small" data-a="verify">${esc(t("Integrity check"))}</button><button class="btn small" data-a="storage">${esc(t("Storage"))}</button><button class="btn small" data-a="export">${esc(t("Export ZIP"))}</button></div>
        <div class="row"><button class="btn small" data-a="changes">${esc(t("Change orders"))}</button><button class="btn small" data-a="packages">${esc(t("Release packages"))}</button><button class="btn small" data-a="notes">${esc(t("Notifications"))}${this.unseen ? ` <span class="v-badge">${this.unseen}</span>` : ""}</button></div>
        <div class="row"><button class="btn small" data-a="bin">${esc(t("Recycle bin"))}</button><button class="btn small" data-a="settings">${esc(t("Vault settings"))}</button><button class="btn small" data-a="workflow">${esc(t("Workflow"))}</button></div>
        <div class="row v-search"><input id="v-q" type="search" value="${esc(this.found?.label ?? "")}" placeholder="${esc(t("Search the vault"))}" aria-label="${esc(t("Search the vault"))}" /><button class="btn small" data-a="search">${esc(t("Advanced…"))}</button>${this.found ? `<button class="btn small" data-a="clearq">${esc(t("Clear"))}</button>` : ""}</div>
        <input type="file" id="v-files" multiple hidden /></div>
        ${this.found ? `<p class="muted pad v-found">${esc(t("{n} file found|{n} files found", { n: shown.length }))}</p>` : ""}
        <div class="v-files" role="list" aria-label="${esc(t("Vault files"))}">${shown.length ? shown.map(row).join("") : `<p class="muted pad">${esc(this.found ? t("Nothing found.") : t("No files yet: add files or save the open part to the vault."))}</p>`}</div>
        ${acts}`;
    }
    this.wire();
  }

  private wire() {
    const h = this.host;
    h.querySelector<HTMLInputElement>("#v-user")?.addEventListener("change", e => {
      const u = (e.target as HTMLInputElement).value.trim();
      if (u) { storage.set("mc:vaultUser", u); if (this.vault) this.vault.user = u; void this.refresh(); }
    });
    h.querySelectorAll<HTMLElement>("[data-openws]").forEach(b => b.addEventListener("click", () => void this.openInBrowser(b.dataset.openws!).catch(e => toast(t((e as Error).message), true))));
    h.querySelectorAll<HTMLElement>("[data-openfolder]").forEach(b => b.addEventListener("click", () => void this.openFolder(b.dataset.openfolder!)));
    h.querySelectorAll<HTMLElement>(".v-row").forEach(b => {
      b.addEventListener("click", () => { this.sel = b.dataset.id!; this.conflicts = []; this.stale = []; void this.render().then(() => this.loadConflicts()); });
      b.addEventListener("dblclick", () => void this.openFile(b.dataset.id!));
    });
    const zipIn = h.querySelector<HTMLInputElement>("#v-zip");
    zipIn?.addEventListener("change", () => { const f = zipIn.files?.[0]; zipIn.value = ""; if (f) void this.importZip(f); });
    const files = h.querySelector<HTMLInputElement>("#v-files");
    files?.addEventListener("change", () => { const l = [...(files.files ?? [])]; files.value = ""; if (l.length) void this.addFiles(l); });
    h.querySelectorAll<HTMLElement>("[data-a]").forEach(b => b.addEventListener("click", () => {
      const id = this.sel;
      switch (b.dataset.a) {
        case "new-ws": void this.createInBrowser(h.querySelector<HTMLInputElement>("#v-name")!.value).catch(e => toast(t((e as Error).message), true)); break;
        case "new-dir": void this.pickFolder(true); break;
        case "open-dir": void this.pickFolder(false); break;
        case "close": this.close(); break;
        case "add": files?.click(); break;
        case "addfolder": void this.addFolderFiles(); break;
        case "savepart": void this.saveOpenDoc(); break;
        case "audit": void this.auditTrail(); break;
        case "verify": void this.verify(); break;
        case "storage": void this.storage(); break;
        case "export": void this.exportZip(); break;
        case "import": zipIn?.click(); break;
        case "open": if (id) void this.openFile(id); break;
        case "co": if (id) void this.checkOut(id); break;
        case "ci": if (id) void this.checkIn(id); break;
        case "undo": if (id) void this.undoCheckOut(id); break;
        case "latest": if (id) void this.getLatest(id); break;
        case "hist": if (id) void this.history(id); break;
        case "card": if (id) void this.dataCard(id); break;
        case "pdf": if (id) void this.pdfOf(id); break;
        case "contains": if (id) void this.containsDlg(id); break;
        case "links": if (id) void this.updateLinks(id); break;
        case "used": if (id) void this.whereUsedDlg(id); break;
        case "rename": if (id) void this.renameDlg(id); break;
        case "copy": if (id) void this.copyTreeDlg(id); break;
        case "del": if (id) void this.deleteFile(id); break;
        case "bin": void this.recycleBinDlg(); break;
        case "settings": void this.settingsDlg(); break;
        case "search": void this.searchDlg(); break;
        case "clearq": this.found = null; void this.render(); break;
        case "changes": void this.changesDlg(); break;
        case "packages": void this.packagesDlg(); break;
        case "notes": void this.notificationsDlg(); break;
        case "workflow": void this.workflowDlg(); break;
        case "eco": if (id) void this.newChange([id]); break;
        case "break": if (id) void this.breakLock(id); break;
      }
    }));
    h.querySelectorAll<HTMLElement>("[data-tr]").forEach(b => b.addEventListener("click", () => { if (this.sel) void this.transitionDlg(this.sel, b.dataset.tr!); }));
    const q = h.querySelector<HTMLInputElement>("#v-q");
    q?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); void this.find(q.value.trim() ? { text: q.value } : null, q.value.trim()); } });
    q?.addEventListener("search", () => { if (!q.value.trim()) void this.find(null, ""); });
  }
}
