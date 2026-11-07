// The Vault tab (FR-PDM-002, 080): create or open a vault, list its files with their state, version and lock,
// and the commands Check out, Check in, Undo check-out, Get latest, History (open a version, roll back),
// Add files, Save the open part to the vault, the audit trail and the integrity check.
import { onLangChange, t } from "../i18n";
import { confirmModal, storage, toast } from "../ui";
import { unzipLimited, zip } from "../model/zip";
import { fsaDir, Vault, VaultError, type FileRec, type Msg, type Resolve, type SearchQuery, type TreeNode, type VDir } from "./vault";
import { PART_NUMBER, ROLES, type CardField, type Role } from "./workflow";

export interface VaultHost {
  /** Opens bytes as a document (a part, or any file the viewer reads). */
  open(name: string, data: Uint8Array): Promise<void>;
  /** The open part, if any: its file name and saved bytes. */
  part(): { name: string; bytes(): Promise<Uint8Array | null> } | null;
  /** Ties the open part to a vault file (null unties it). */
  setVault(v: { label: string; readOnly: boolean; save(bytes: Uint8Array): Promise<void>; checkOut(): Promise<void> } | null): void;
  markSaved(): void;
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
  /** The vault file the open part came from. */
  private openId: string | null = null;
  /** Search results shown instead of all files (FR-PDM-042), with what was searched. */
  private found: { ids: Set<string>; label: string } | null = null;

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

  private async pickFolder(create: boolean) {
    const w = window as PickerWindow;
    if (!w.showDirectoryPicker) return;
    let h: FileSystemDirectoryHandle;
    try { h = await w.showDirectoryPicker({ mode: "readwrite", id: "mc-vault" }); } catch { return; }
    const dir = fsaDir(h);
    try { await this.use(create ? await Vault.create(dir, h.name, this.user, this.computer) : await Vault.open(dir, this.user, this.computer)); }
    catch (e) { toast(errText(e), true); }
  }

  /** Opens a vault given its directory (tests, and the folder picker). */
  async use(v: Vault) {
    this.vault = v;
    this.sel = null;
    storage.set("mc:lastVault", v.root.name);
    await this.refresh();
    toast(t("Vault {name} open", { name: v.info.name }), "success");
  }

  close() {
    this.vault = null;
    this.files = [];
    if (this.openId) { this.app.setVault(null); this.openId = null; }
    void this.render();
  }

  async refresh() {
    const v = this.vault;
    if (v) {
      this.files = await v.files();
      this.state.clear();
      for (const f of this.files) this.state.set(f.id, await v.status(f));
      // The open part follows its file's lock and version.
      if (this.openId) { const f = this.files.find(x => x.id === this.openId); if (f) this.tieOpen(f); }
    }
    await this.render();
  }

  // ---------- commands ----------

  private rec(id: string) { return this.files.find(f => f.id === id)!; }

  private async run(work: () => Promise<unknown>) {
    try { await work(); } catch (e) { toast(errText(e), true); }
    await this.refresh();
  }

  async addFiles(list: File[]) {
    const v = this.vault;
    if (!v) return;
    await this.run(async () => {
      for (const f of list) await v.add(f.name, new Uint8Array(await f.arrayBuffer()));
      toast(t("Added {n} file to the vault|Added {n} files to the vault", { n: list.length }), "success");
    });
  }

  /** Save to vault (FR-PDM-003): the open part goes in as a new file at version 1, checked out here so work goes on. */
  async saveOpenPart() {
    const v = this.vault, p = this.app.part();
    if (!v || !p) { toast(t("Open or create a part first."), true); return; }
    await this.run(async () => {
      const bytes = await p.bytes();
      if (!bytes) return;
      const f = await v.add(p.name, bytes, "Added");
      await v.checkOut(f.id);
      this.openId = f.id;
      this.app.markSaved();
      toast(t("{name} is in the vault, checked out to you", { name: p.name }), "success");
    });
  }

  async openFile(id: string, version?: number) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    try {
      const data = version ? await v.versionBytes(id, version) : await v.working(f.path) ?? await v.versionBytes(id, v.latest(f).n);
      const name = f.path.split("/").pop()!;
      await this.app.open(version ? name.replace(/(\.[^.]+)$/, ` (v${version})$1`) : name, data);
      if (f.kind === "part" && !version) { this.openId = id; this.tieOpen(f); }
      else this.openId = null;
    } catch (e) { toast(errText(e), true); }
  }

  private tieOpen(f: FileRec) {
    const v = this.vault!, st = this.state.get(f.id);
    const mine = !!st?.mine;
    const label = `v${v.latest(f).n}${f.revision ? ` · ${t("Rev {rev}", { rev: f.revision })}` : ""} · ${tn(f.state)}${f.checkout ? ` · ${mine ? t("checked out") : t("locked by {user}", { user: f.checkout.user })}` : ""}`;
    this.app.setVault({
      label, readOnly: !mine,
      save: async bytes => { await v.saveWorking(f.id, bytes); await this.refresh(); },
      checkOut: async () => { await this.run(() => v.checkOut(f.id)); },
    });
  }

  async checkOut(id: string) { const v = this.vault; if (v) await this.run(() => v.checkOut(id)); }

  async checkIn(id: string, comment?: string, keep = false) {
    const v = this.vault;
    if (!v) return;
    if (comment === undefined) {
      const r = await this.form(t("Check in"), `<p>${esc(this.rec(id).path)}</p><label class="v-lbl">${esc(t("Comment"))}<textarea name="comment" rows="3" maxlength="500" autofocus></textarea></label><label class="chk"><input type="checkbox" name="keep" /> ${esc(t("Keep checked out"))}</label>`, t("Check in"));
      if (!r) return;
      comment = r.comment as string;
      keep = !!r.keep;
    }
    // Unsaved edits of the open part go into the working copy first.
    if (this.openId === id) { const p = this.app.part(); const b = p && await p.bytes(); if (b) { await v.saveWorking(id, b); this.app.markSaved(); } }
    await this.run(async () => {
      const n = await v.checkIn(id, comment!, keep);
      toast(n ? t("Checked in as version {n}", { n }) : t("No changes: no new version"), "success");
    });
  }

  async undoCheckOut(id: string) {
    const v = this.vault;
    if (!v || !await confirmModal(t("Throw away the local changes to {name} and release it?", { name: this.rec(id).path }), t("Undo check-out"))) return;
    await this.run(() => v.undoCheckOut(id));
    if (this.openId === id) await this.openFile(id);
  }

  async getLatest(id: string) {
    const v = this.vault;
    if (!v) return;
    const st = this.state.get(id);
    if (st?.modified && !await confirmModal(t("The local copy of {name} has changes that are not checked in. Replace it with the latest version?", { name: this.rec(id).path }), t("Get latest"))) return;
    await this.run(() => v.getLatest(id, true));
  }

  async rollBack(id: string, n: number) {
    const v = this.vault;
    if (!v || !await confirmModal(t("Make version {n} the latest again? A new version is added; nothing is lost.", { n }), t("Roll back"), t("Roll back"))) return;
    await this.run(async () => { const m = await v.rollBack(id, n); toast(t("Version {m} has the content of version {n}", { m, n }), "success"); });
    if (this.openId === id) await this.openFile(id);
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
      d.el.close();
      void this.compareDlg(id, Math.min(a, b), Math.max(a, b));
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
  async transitionDlg(id: string, name: string, comment?: string, withRefs?: string[]) {
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
        <label class="v-lbl">${esc(tr.comment ? t("Comment (required)") : t("Comment"))}<textarea name="comment" rows="2" maxlength="500"></textarea></label>`, [[t("Cancel"), "cancel"], [tn(name), "ok"]]);
      d.el.querySelectorAll<HTMLInputElement>('[name="ref"]').forEach(c => c.addEventListener("change", async () => {
        const ids = [id, ...[...d.el.querySelectorAll<HTMLInputElement>('[name="ref"]:checked')].map(x => x.value)];
        d.el.querySelector(".v-check")!.innerHTML = await render(ids);
      }));
      if (await d.done !== "ok") return;
      comment = d.el.querySelector<HTMLTextAreaElement>('[name="comment"]')!.value;
      withRefs = [...d.el.querySelectorAll<HTMLInputElement>('[name="ref"]:checked')].map(x => x.value);
    }
    const ids = [id, ...(withRefs ?? [])];
    await this.run(async () => {
      const labels = await v.transition(ids, name, comment!);
      const rev = labels[id];
      toast(rev ? t("{name}: {state}, revision {rev}", { name: f.path, state: tn(tr.to), rev }) : t("{name}: {state}", { name: f.path, state: tn(tr.to) }), "success");
    });
    if (this.openId && ids.includes(this.openId)) await this.openFile(this.openId);
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
    const d = this.dialog(t("Data card"), body, editable ? [[t("Cancel"), "cancel"], [t("Save"), "ok"]] : [[t("Close"), "cancel"]]);
    d.el.querySelector<HTMLElement>("[data-num]")?.addEventListener("click", async e => {
      e.preventDefault();
      try { const n = await v.issueNumber(f.card); d.el.querySelector<HTMLInputElement>(`[name="c:${PART_NUMBER}"]`)!.value = n; } catch (er) { toast(errText(er), true); }
    });
    if (await d.done !== "ok") return;
    const vals: Record<string, string> = {};
    for (const fd of fields) {
      const el = d.el.querySelector<HTMLInputElement>(`[name="c:${CSS.escape(fd.name)}"]`);
      if (el) vals[fd.name] = el.type === "checkbox" ? String(el.checked) : el.value;
    }
    await this.run(async () => {
      await v.setCard(id, vals);
      // The open part gets the properties too (its saved copy is the vault's working copy).
      if (this.openId === id) await this.openFile(id);
      toast(t("Data card saved"), "success");
    });
  }

  // ---------- references (FR-PDM-021/022, 052) ----------

  private treeHtml(n: TreeNode, depth = 0): string {
    const li = (c: TreeNode): string => `<li translate="no">${c.qty > 1 ? `<b>${c.qty}×</b> ` : ""}${esc(c.path)}${c.missing ? ` <span class="v-bad">${esc(t("missing"))}</span>` : ` · v${c.version}${c.rev ? ` · ${esc(c.rev)}` : ""} · <span translate="yes">${esc(tn(c.state))}</span>`}${c.cycle ? " ↻" : ""}${c.children.length && depth < 20 ? `<ul>${c.children.map(x => li(x)).join("")}</ul>` : ""}</li>`;
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
    const again = () => { d.el.close(); void this.containsDlg(id, +d.el.querySelector<HTMLSelectElement>('[name="ver"]')!.value, d.el.querySelector<HTMLSelectElement>('[name="mode"]')!.value as Resolve); };
    d.el.querySelectorAll("select").forEach(s => s.addEventListener("change", again));
    if (await d.done === "csv") download(`${f.path.split("/").pop()}-v${tree.version}-bom.csv`, csvOf([["path", "part number", "description", "revision", "version", "qty"], ...bom.map(r => [r.path, r.partNumber, r.description, r.rev ?? "", r.version, r.qty])]), "text/csv");
  }

  async whereUsedDlg(id: string) {
    const v = this.vault;
    if (!v) return;
    const f = this.rec(id);
    const ups = await v.whereUsed(id);
    const li = (n: TreeNode): string => `<li translate="no">${esc(n.path)} · ${n.qty}× · ${esc(t("uses v{n}", { n: n.version }))}${n.cycle ? " ↻" : ""}${n.children.length ? `<ul>${n.children.map(li).join("")}</ul>` : ""}</li>`;
    this.dialog(t("Where used: {name}", { name: f.path }), ups.length ? `<div class="v-scroll"><ul class="v-tree">${ups.map(li).join("")}</ul></div>` : `<p class="muted">${esc(t("No file in the vault uses this file."))}</p>`, [[t("Close"), "cancel"]]);
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
      if (c.refs.length) {
        parts.push(`<h4>${esc(t("References"))}</h4>${table([t("File"), `v${a}`, `v${b}`], c.refs.map(x => [x.path, x.from, x.to]))}`);
        const bc = await v.bomCompare(id, a, b);
        if (bc.length) parts.push(`<h4>${esc(t("BOM changes"))}</h4>${table([t("File"), t("What changed"), `v${a}`, `v${b}`], bc.map(x => [x.path, t(x.change), x.from, x.to]))}`);
      }
      this.dialog(t("Compare v{a} and v{b} of {name}", { a, b, name: c.path }), `<div class="v-scroll">${parts.join("")}</div>`, [[t("Close"), "cancel"]]);
    } catch (e) { toast(errText(e), true); }
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
    if (this.openId === id) await this.openFile(id);
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
    await this.run(() => v.remove(id));
    if (this.sel === id) this.sel = null;
    if (this.openId === id) { this.app.setVault(null); this.openId = null; }
    await this.render();
  }

  async recycleBinDlg() {
    const v = this.vault;
    if (!v) return;
    const bin = await v.recycleBin();
    const admin = v.has("Admin");
    const d = this.dialog(t("Recycle bin"), bin.length ? `<table class="v-table"><tbody>${bin.map(f => `<tr><td translate="no">${esc(f.path)}</td><td>${esc(fmtDate(f.deleted!.at))}</td><td class="v-acts"><button class="btn small" data-restore="${f.id}">${esc(t("Restore"))}</button>${admin ? `<button class="btn small" data-destroy="${f.id}">${esc(t("Destroy"))}</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">${esc(t("The recycle bin is empty."))}</p>`, [[t("Close"), "cancel"]]);
    d.el.querySelectorAll<HTMLElement>("[data-restore]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); d.el.close(); void this.run(() => v.restore(b.dataset.restore!)); }));
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
    const q: SearchQuery = { text: val("text"), state: val("state"), revision: val("revision"), checkedOutBy: val("by"), kind: val("kind"), from: val("from"), to: val("to"), fields: Object.fromEntries(fields.map(fd => [fd.name, val(`f:${fd.name}`)]).filter(([, x]) => x)) };
    if (val("cv")) q.contains = { field: val("cf"), value: val("cv") };
    const name = val("save");
    if (name) await this.run(() => v.saveSettings({ searches: [...saved.filter(s => s.name !== name), { name, q }] }, "saved search"));
    await this.find(q, name || q.text || t("Advanced search"));
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
        cards: { ...(v.info.cards ?? {}), "*": fields },
        shared: g("shared").checked,
        roles: roleMap,
      });
      toast(t("Vault settings saved"), "success");
    });
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
    const a = await d.done;
    if (a !== "ok") return null;
    const out: Record<string, string | boolean> = {};
    d.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach(x => { out[x.name] = x instanceof HTMLInputElement && x.type === "checkbox" ? x.checked : x.value; });
    return out;
  }

  // ---------- view ----------

  async render() {
    const h = this.host, v = this.vault;
    const user = `<label class="v-user">${esc(t("User"))} <input id="v-user" value="${esc(this.user)}" maxlength="40" autocomplete="name" translate="no" /></label>`;
    if (!v) {
      const ws = await workspace();
      // A re-render (the tab was shown again) keeps a name being typed.
      const names = ws ? (await ws.list()).filter(e => e.kind === "dir").map(e => e.name).sort() : [];
      const typed = h.querySelector<HTMLInputElement>("#v-name")?.value ?? "";
      const fsa = !!(window as PickerWindow).showDirectoryPicker;
      h.innerHTML = `<div class="pad v-start">
        <p class="muted">${esc(t("A vault keeps every version of your files, with check-out, check-in, history and an audit trail."))}</p>
        ${user}
        ${names.length ? `<p class="v-h">${esc(t("Vaults in this browser"))}</p><div class="v-list">${names.map(n => `<button class="btn small" data-openws="${esc(n)}" translate="no">${esc(n)}</button>`).join("")}</div>` : ""}
        <div class="row"><input id="v-name" value="${esc(typed)}" placeholder="${esc(t("Vault name"))}" aria-label="${esc(t("Vault name"))}" maxlength="60" /><button class="btn small primary" data-a="new-ws"${ws ? "" : " disabled"}>${esc(t("New vault"))}</button></div>
        <div class="row"><button class="btn small" data-a="import"${ws ? "" : " disabled"}>${esc(t("Import vault ZIP…"))}</button><input type="file" id="v-zip" accept=".zip" hidden /></div>
        ${fsa ? `<div class="row"><button class="btn small" data-a="new-dir">${esc(t("New vault in a folder…"))}</button><button class="btn small" data-a="open-dir">${esc(t("Open vault folder…"))}</button></div>` : ""}
      </div>`;
    } else {
      const sel = this.sel ? this.files.find(f => f.id === this.sel) ?? null : null;
      const st = sel ? this.state.get(sel.id) : undefined;
      const row = (f: FileRec) => {
        const s = this.state.get(f.id)!;
        const lock = f.checkout ? `<span class="v-lock${s.mine ? " mine" : ""}" title="${esc(t("Checked out by {user}", { user: f.checkout.user }))}">🔒 <span translate="no">${esc(f.checkout.user)}</span></span>` : "";
        const color = v.stateOf(f.state).color;
        const pn = f.card?.[PART_NUMBER];
        return `<button class="v-row${f.id === this.sel ? " sel" : ""}" data-id="${f.id}" aria-pressed="${f.id === this.sel}"><span class="v-name" translate="no">${esc(f.path)}</span><span class="v-meta"><span class="v-state"><i style="background:${esc(color)}"></i>${esc(tn(f.state))}</span>${f.revision ? ` · ${esc(t("Rev {rev}", { rev: f.revision }))}` : ""} · ${esc(t(f.kind))} · v${v.latest(f).n}${pn ? ` · <span translate="no">${esc(pn)}</span>` : ""}${s.modified ? ` · <b>${esc(t("modified"))}</b>` : ""}${s.missing ? ` · ${esc(t("no local copy"))}` : ""} ${lock}</span></button>`;
      };
      const trs = sel ? v.transitionsOf(sel) : [];
      const acts = sel ? `<div class="v-acts">
        <div class="row">
        <button class="btn small primary" data-a="open">${esc(t("Open"))}</button>
        ${!sel.checkout && v.stateOf(sel.state).checkout ? `<button class="btn small" data-a="co">${esc(t("Check out"))}</button>` : ""}
        ${st?.mine ? `<button class="btn small" data-a="ci">${esc(t("Check in"))}</button><button class="btn small" data-a="undo">${esc(t("Undo check-out"))}</button>` : ""}
        <button class="btn small" data-a="latest">${esc(t("Get latest"))}</button>
        <button class="btn small" data-a="hist">${esc(t("History"))}</button>
        </div>
        ${trs.length ? `<div class="row v-trs"><span class="muted">${esc(t("Change state"))}:</span>${trs.map(x => `<button class="btn small" data-tr="${esc(x.name)}">${esc(tn(x.name))}</button>`).join("")}</div>` : ""}
        <div class="row">
        <button class="btn small" data-a="card">${esc(t("Data card"))}</button>
        <button class="btn small" data-a="contains">${esc(t("Contains"))}</button>
        <button class="btn small" data-a="used">${esc(t("Where used"))}</button>
        <button class="btn small" data-a="rename">${esc(t("Rename / move…"))}</button>
        <button class="btn small" data-a="copy">${esc(t("Copy tree…"))}</button>
        <button class="btn small" data-a="del">${esc(t("Delete"))}</button>
        </div>
        ${this.cardSummary(sel)}
      </div>` : "";
      const shown = this.found ? this.files.filter(f => this.found!.ids.has(f.id)) : this.files;
      h.innerHTML = `<div class="pad v-top"><div class="v-title"><b translate="no">${esc(v.info.name)}</b><button class="btn small" data-a="close">${esc(t("Close vault"))}</button></div>${user}
        <div class="row"><button class="btn small" data-a="add">${esc(t("Add files…"))}</button><button class="btn small" data-a="savepart"${this.app.part() && !this.openId ? "" : " disabled"}>${esc(t("Save part to vault"))}</button></div>
        <div class="row"><button class="btn small" data-a="audit">${esc(t("Audit trail"))}</button><button class="btn small" data-a="verify">${esc(t("Integrity check"))}</button><button class="btn small" data-a="storage">${esc(t("Storage"))}</button><button class="btn small" data-a="export">${esc(t("Export ZIP"))}</button></div>
        <div class="row"><button class="btn small" data-a="bin">${esc(t("Recycle bin"))}</button><button class="btn small" data-a="settings">${esc(t("Vault settings"))}</button></div>
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
    h.querySelectorAll<HTMLElement>(".v-row").forEach(b => {
      b.addEventListener("click", () => { this.sel = b.dataset.id!; void this.render(); });
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
        case "savepart": void this.saveOpenPart(); break;
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
        case "contains": if (id) void this.containsDlg(id); break;
        case "used": if (id) void this.whereUsedDlg(id); break;
        case "rename": if (id) void this.renameDlg(id); break;
        case "copy": if (id) void this.copyTreeDlg(id); break;
        case "del": if (id) void this.deleteFile(id); break;
        case "bin": void this.recycleBinDlg(); break;
        case "settings": void this.settingsDlg(); break;
        case "search": void this.searchDlg(); break;
        case "clearq": this.found = null; void this.render(); break;
      }
    }));
    h.querySelectorAll<HTMLElement>("[data-tr]").forEach(b => b.addEventListener("click", () => { if (this.sel) void this.transitionDlg(this.sel, b.dataset.tr!); }));
    const q = h.querySelector<HTMLInputElement>("#v-q");
    q?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); void this.find(q.value.trim() ? { text: q.value } : null, q.value.trim()); } });
    q?.addEventListener("search", () => { if (!q.value.trim()) void this.find(null, ""); });
  }
}
