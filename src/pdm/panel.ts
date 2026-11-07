// The Vault tab (FR-PDM-002, 080): create or open a vault, list its files with their state, version and lock,
// and the commands Check out, Check in, Undo check-out, Get latest, History (open a version, roll back),
// Add files, Save the open part to the vault, the audit trail and the integrity check.
import { t } from "../i18n";
import { confirmModal, storage, toast } from "../ui";
import { fsaDir, Vault, VaultError, type FileRec, type VDir } from "./vault";

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

  constructor(private host: HTMLElement, private app: VaultHost) { void this.render(); }

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
    catch (e) { toast(t((e as Error).message), true); }
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
    try { await work(); } catch (e) { toast(e instanceof VaultError ? t(e.message) : t("Vault error: {err}", { err: (e as Error).message }), true); }
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
    } catch (e) { toast(t((e as Error).message), true); }
  }

  private tieOpen(f: FileRec) {
    const v = this.vault!, st = this.state.get(f.id);
    const mine = !!st?.mine;
    const label = `v${v.latest(f).n}${f.checkout ? ` · ${mine ? t("checked out") : t("locked by {user}", { user: f.checkout.user })}` : ""}`;
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
    const rows = [...f.versions].reverse().map(x => `<tr><td>v${x.n}</td><td>${esc(fmtDate(x.at))}</td><td translate="no">${esc(x.user)}</td><td translate="no">${esc(x.comment)}</td><td>${fmtSize(x.size)}</td><td class="v-acts"><button class="btn small" data-open="${x.n}">${esc(t("Open"))}</button>${x.n !== v.latest(f).n ? `<button class="btn small" data-rb="${x.n}">${esc(t("Roll back"))}</button>` : ""}</td></tr>`).join("");
    const events = log.map(e => `<li>${esc(fmtDate(e.at))} · <span translate="no">${esc(e.user)}</span> · ${esc(t(e.action))}${e.version ? ` v${e.version}` : ""}</li>`).join("");
    const d = this.dialog(t("History of {name}", { name: f.path }), `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Version"))}</th><th>${esc(t("Date"))}</th><th>${esc(t("User"))}</th><th>${esc(t("Comment"))}</th><th>${esc(t("Size"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><h4>${esc(t("Events"))}</h4><ul class="v-log">${events}</ul>`, [[t("Close"), "cancel"]]);
    d.el.querySelectorAll<HTMLElement>("[data-open]").forEach(b => b.addEventListener("click", () => { d.el.close(); void this.openFile(id, +b.dataset.open!); }));
    d.el.querySelectorAll<HTMLElement>("[data-rb]").forEach(b => b.addEventListener("click", () => { d.el.close(); void this.rollBack(id, +b.dataset.rb!); }));
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
    this.dialog(t("Integrity check"), `<p>${esc(ok ? t("The vault is sound: {f} files, {o} stored objects.", { f: r.files, o: r.objects }) : t("Problems found in the vault."))}</p>${list(t("Missing versions"), r.missing)}${list(t("Damaged versions"), r.corrupt)}${r.orphans.length ? `<p class="muted">${esc(t("{n} stored objects are not used by any version.", { n: r.orphans.length }))}</p>` : ""}`, [[t("Close"), "cancel"]]);
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
      const names = ws ? (await ws.list()).filter(e => e.kind === "dir").map(e => e.name).sort() : [];
      const fsa = !!(window as PickerWindow).showDirectoryPicker;
      h.innerHTML = `<div class="pad v-start">
        <p class="muted">${esc(t("A vault keeps every version of your files, with check-out, check-in, history and an audit trail."))}</p>
        ${user}
        ${names.length ? `<p class="v-h">${esc(t("Vaults in this browser"))}</p><div class="v-list">${names.map(n => `<button class="btn small" data-openws="${esc(n)}" translate="no">${esc(n)}</button>`).join("")}</div>` : ""}
        <div class="row"><input id="v-name" placeholder="${esc(t("Vault name"))}" aria-label="${esc(t("Vault name"))}" maxlength="60" /><button class="btn small primary" data-a="new-ws"${ws ? "" : " disabled"}>${esc(t("New vault"))}</button></div>
        ${fsa ? `<div class="row"><button class="btn small" data-a="new-dir">${esc(t("New vault in a folder…"))}</button><button class="btn small" data-a="open-dir">${esc(t("Open vault folder…"))}</button></div>` : ""}
      </div>`;
    } else {
      const sel = this.sel ? this.files.find(f => f.id === this.sel) ?? null : null;
      const st = sel ? this.state.get(sel.id) : undefined;
      const row = (f: FileRec) => {
        const s = this.state.get(f.id)!;
        const lock = f.checkout ? `<span class="v-lock${s.mine ? " mine" : ""}" title="${esc(t("Checked out by {user}", { user: f.checkout.user }))}">🔒 <span translate="no">${esc(f.checkout.user)}</span></span>` : "";
        return `<button class="v-row${f.id === this.sel ? " sel" : ""}" data-id="${f.id}" aria-pressed="${f.id === this.sel}"><span class="v-name" translate="no">${esc(f.path)}</span><span class="v-meta">${esc(t(f.kind))} · v${v.latest(f).n}${s.modified ? ` · <b>${esc(t("modified"))}</b>` : ""}${s.missing ? ` · ${esc(t("no local copy"))}` : ""} ${lock}</span></button>`;
      };
      const acts = sel ? `<div class="v-acts row">
        <button class="btn small primary" data-a="open">${esc(t("Open"))}</button>
        ${!sel.checkout ? `<button class="btn small" data-a="co">${esc(t("Check out"))}</button>` : ""}
        ${st?.mine ? `<button class="btn small" data-a="ci">${esc(t("Check in"))}</button><button class="btn small" data-a="undo">${esc(t("Undo check-out"))}</button>` : ""}
        <button class="btn small" data-a="latest">${esc(t("Get latest"))}</button>
        <button class="btn small" data-a="hist">${esc(t("History"))}</button>
      </div>` : "";
      h.innerHTML = `<div class="pad v-top"><div class="v-title"><b translate="no">${esc(v.info.name)}</b><button class="btn small" data-a="close">${esc(t("Close vault"))}</button></div>${user}
        <div class="row"><button class="btn small" data-a="add">${esc(t("Add files…"))}</button><button class="btn small" data-a="savepart"${this.app.part() && !this.openId ? "" : " disabled"}>${esc(t("Save part to vault"))}</button></div>
        <div class="row"><button class="btn small" data-a="audit">${esc(t("Audit trail"))}</button><button class="btn small" data-a="verify">${esc(t("Integrity check"))}</button></div>
        <input type="file" id="v-files" multiple hidden /></div>
        <div class="v-files" role="list" aria-label="${esc(t("Vault files"))}">${this.files.length ? this.files.map(row).join("") : `<p class="muted pad">${esc(t("No files yet: add files or save the open part to the vault."))}</p>`}</div>
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
        case "open": if (id) void this.openFile(id); break;
        case "co": if (id) void this.checkOut(id); break;
        case "ci": if (id) void this.checkIn(id); break;
        case "undo": if (id) void this.undoCheckOut(id); break;
        case "latest": if (id) void this.getLatest(id); break;
        case "hist": if (id) void this.history(id); break;
      }
    }));
  }
}
