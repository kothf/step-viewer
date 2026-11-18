// The Vault explorer (FR-PDM-080): the vault as a file manager in a document tab of its own, as other CAD apps'
// vault explorers have it. A folder tree on the left, the folder's files in a sortable list (several picked with
// Ctrl/Shift, a right-click menu, drag and drop to move or add), a preview on the right and the selected file's
// data card, versions, references and bill of materials in tabs under the list. The side panel's Vault tab stays
// the quick list; both run the same commands through `VaultPanel`, so a change made in one shows in the other.
import { onLangChange, t, tAs } from "../i18n";
import "./explorer.css";
import { makeGrip } from "../resize";
import { confirmModal, storage, toast } from "../ui";
import type { VaultPanel } from "./panel";
import { VaultError, type FileRec, type Resolve, type SearchQuery, type TreeNode } from "./vault";
import { PART_NUMBER, WIP, type CardField } from "./workflow";

export interface ExplorerHost {
  panel: VaultPanel;
  /** The explorer was shown or hidden (the document tabs follow). */
  shown(on: boolean): void;
  /** Opens the Vault menu under a button (no vault open: new / open vault). */
  vaultMenu(btn: HTMLElement): void;
}

type Col = "name" | "type" | "by" | "ver" | "state" | "rev" | "pn" | "desc" | "date" | "size" | "folder";
type DetTab = "card" | "versions" | "contains" | "used" | "bom";
interface Filters { kind: string; state: string; by: string; content: boolean }

const COLS: { k: Col; l: string; w: string; num?: boolean }[] = [
  { k: "name", l: "Name", w: "minmax(200px, 2.6fr)" },
  { k: "type", l: "Type", w: "78px" },
  { k: "by", l: "Checked out by", w: "minmax(104px, 1fr)" },
  { k: "ver", l: "Version", w: "72px", num: true },
  { k: "state", l: "State", w: "minmax(104px, 1fr)" },
  { k: "rev", l: "Revision", w: "72px" },
  { k: "pn", l: "Part number", w: "minmax(96px, 0.9fr)" },
  { k: "desc", l: "Description", w: "minmax(110px, 1.4fr)" },
  { k: "date", l: "Modified", w: "136px" },
  { k: "size", l: "Size", w: "72px", num: true },
  { k: "folder", l: "Folder", w: "minmax(100px, 1fr)" },
];
const TABS: [DetTab, string][] = [["card", "Data card"], ["versions", "Versions"], ["contains", "Contains"], ["used", "Where used"], ["bom", "Bill of materials"]];
const MIME = "application/x-mcad-vault";
const MINE = "@mine";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const tn = (s: string) => (s === WIP ? tAs("Draft", "Draft (lifecycle state)") : t(s));
const errText = (e: unknown) => (e instanceof VaultError ? t(e.key, e.params) : t("Vault error: {err}", { err: (e as Error).message }));
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const csvOf = (rows: (string | number)[][]) => rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
const KIND_LABEL: Record<string, string> = { part: "Part", assembly: "Assembly", drawing: "Drawing" };
const typeOf = (f: FileRec) => (KIND_LABEL[f.kind] ? t(KIND_LABEL[f.kind]) : (base(f.path).split(".").pop() ?? "").toUpperCase());

const svg = (d: string, cls = "") => `<svg class="vx-i${cls ? ` ${cls}` : ""}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">${d}</svg>`;
const ICON = {
  part: '<path d="M8 2l5 3v6l-5 3-5-3V5z M8 8l5-3 M8 8v6 M8 8L3 5"/>',
  assembly: '<path d="M2 5l4-2 4 2v4l-4 2-4-2z M10 7l4 2v4l-4 2-4-2v-2"/>',
  drawing: '<path d="M3 2h7l3 3v9H3z M10 2v3h3 M5 9h6 M5 11.5h4"/>',
  file: '<path d="M4 2h6l3 3v9H4z M10 2v3h3"/>',
  folder: '<path d="M2 4.5V12.5h12V6H7.5L6 4.5z"/>',
  vault: '<path d="M2.5 3h11v10h-11z M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4 M8 6v-.8 M8 10v.8 M10 8h.8 M6 8h-.8 M3.5 13v1 M12.5 13v1"/>',
  lock: '<path d="M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2"/>',
  add: '<path d="M8 3v10 M3 8h10"/>',
  newdir: '<path d="M2 4.5V12.5h12V6H7.5L6 4.5z M10 8v3 M8.5 9.5h3"/>',
  out: '<path d="M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 3.9-.6"/>',
  in: '<path d="M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2 M6.5 10.5l1.2 1.2 2-2.4"/>',
  undo: '<path d="M5 6H10a3 3 0 0 1 0 6H6 M7 4L5 6l2 2"/>',
  latest: '<path d="M8 2.5v8 M5 7.5l3 3 3-3 M3 13.5h10"/>',
  state: '<path d="M2.5 8h3l1.5-3 2 6 1.5-3h3"/>',
  more: '<path d="M4 8h.01 M8 8h.01 M12 8h.01" stroke-width="2.4"/>',
  filter: '<path d="M2.5 3.5h11l-4.3 5v4l-2.4 1v-5z"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6 M13 2.5v3h-3"/>',
  up: '<path d="M8 13V3.5 M4 7.5l4-4 4 4"/>',
  open: '<path d="M2 4.5V12.5h12V6H7.5L6 4.5z M5 9.5h6 M9 7.5l2 2-2 2"/>',
  save: '<path d="M3 2.5h8l2 2v9H3z M5.5 2.5v3.5h5V2.5 M5.5 13.5v-4h5v4"/>',
  mine: '<path d="M4.5 7.5h7v6h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2 M8 10v1.4"/>',
  bin: '<path d="M3 4.5h10 M6 4.5V3h4v1.5 M4.5 4.5l.7 9h5.6l.7-9"/>',
};
const kindIcon = (k: string) => svg(ICON[k as "part"] ?? ICON.file, `vx-k-${KIND_LABEL[k] ? k : "file"}`);

export class VaultExplorer {
  readonly el: HTMLElement;
  /** On screen (its tab is the active one). */
  open = false;
  /** Has a tab at the bottom (opened once, until its × closes it). */
  tabbed = false;
  private folder = "";
  private sel = new Set<string>();
  private anchor: string | null = null;
  /** The row with the keyboard focus (a file id or `dir:<path>`). */
  private cursor: string | null = null;
  /** A folder row (or tree folder) picked alone: the preview shows the folder. */
  private dirSel: string | null = null;
  private sort: { k: Col; up: boolean } = { k: "name", up: true };
  private tab: DetTab = "card";
  private mode: Resolve = "built";
  private query = "";
  private filters: Filters = { kind: "", state: "", by: "", content: false };
  private filtersOpen = false;
  /** Search results (file ids), or null while the folder is listed. */
  private found: Set<string> | null = null;
  /** Folders made with New folder that hold no file yet (kept per vault in this browser). */
  private extraDirs = new Set<string>();
  /** Folded tree folders. */
  private closed = new Set<string>();
  private vaultName = "";
  private thumbs = new Map<string, string>();
  private gen = 0;
  private searchTimer = 0;

  constructor(private host: ExplorerHost) {
    const el = document.createElement("section");
    el.id = "vault-ex";
    el.className = "vx";
    el.hidden = true;
    el.setAttribute("aria-label", t("Vault explorer"));
    this.el = el;
    try {
      const s = JSON.parse(storage.get("mc:vxSort") || "null") as { k: Col; up: boolean } | null;
      if (s && COLS.some(c => c.k === s.k)) this.sort = s;
    } catch { /* default sort */ }
    const tb = storage.get("mc:vxTab") as DetTab;
    if (TABS.some(([k]) => k === tb)) this.tab = tb;
    host.panel.listeners.add(() => { if (this.open) void this.refreshData(); });
    onLangChange(() => { if (this.open) this.render(); });
    this.bind();
  }

  private get panel() { return this.host.panel; }
  private get vault() { return this.panel.vault; }
  private get files() { return this.panel.fileList; }
  private rec(id: string) { return this.files.find(f => f.id === id); }

  // ---------- showing ----------

  show() {
    this.tabbed = true;
    if (this.open) { this.focusList(); return; }
    this.open = true;
    this.el.hidden = false;
    this.cover(true);
    this.host.shown(true);
    void this.refreshData().then(() => this.focusList());
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    this.cover(false);
    this.panel.closeMenu();
    this.host.shown(false);
  }

  /** The panels and the view under the explorer take no clicks or keys while it is shown. */
  private covered: HTMLElement[] = [];
  private cover(on: boolean) {
    const app = document.getElementById("app");
    app?.classList.toggle("vault-ex", on);
    document.body.classList.toggle("vault-ex", on);
    for (const x of this.covered) x.inert = false;
    this.covered = [];
    if (!on || !app) return;
    for (const x of app.children) {
      const h = x as HTMLElement;
      if (h === this.el || h.matches(".topbar, .doc-tabs, .status") || h.inert) continue;
      h.inert = true;
      this.covered.push(h);
    }
  }

  /** Its tab's ×: hidden, and the tab goes. */
  close() { this.tabbed = false; this.hide(); this.host.shown(false); }

  private focusList() {
    const row = this.el.querySelector<HTMLElement>(".vx-row[tabindex='0']") ?? this.el.querySelector<HTMLElement>(".vx-row");
    (row ?? this.el.querySelector<HTMLElement>(".vx-q"))?.focus({ preventScroll: true });
  }

  /** The vault's files changed (or it opened / closed): drop picks that are gone and draw again. */
  private async refreshData() {
    const v = this.vault;
    const name = v ? `${this.panel.where}:${v.info.name}` : "";
    if (name !== this.vaultName) {
      this.vaultName = name;
      this.folder = "";
      this.sel.clear(); this.anchor = null; this.cursor = null; this.dirSel = null;
      this.found = null; this.query = "";
      for (const u of this.thumbs.values()) URL.revokeObjectURL(u);
      this.thumbs.clear();
      try { this.extraDirs = new Set(JSON.parse(storage.get(`mc:vxDirs:${name}`) || "[]") as string[]); } catch { this.extraDirs = new Set(); }
      try { this.closed = new Set(JSON.parse(storage.get(`mc:vxClosed:${name}`) || "[]") as string[]); } catch { this.closed = new Set(); }
    }
    const live = new Set(this.files.map(f => f.id));
    for (const id of [...this.sel]) if (!live.has(id)) this.sel.delete(id);
    if (this.anchor && !live.has(this.anchor)) this.anchor = null;
    // A New folder that now holds files is a real folder.
    const dirs = this.realDirs();
    let gone = false;
    for (const d of [...this.extraDirs]) if (dirs.has(d)) { this.extraDirs.delete(d); gone = true; }
    if (gone) this.saveDirs();
    if (this.folder && this.folder !== MINE && !this.allDirs().has(this.folder)) this.folder = "";
    if (this.found && (this.query || this.filterCount)) await this.runSearch(false);
    this.render();
  }

  private saveDirs() { storage.set(`mc:vxDirs:${this.vaultName}`, JSON.stringify([...this.extraDirs])); }

  /** Folders that hold files, with every parent. */
  private realDirs() {
    const out = new Set<string>();
    for (const f of this.files) { const p = f.path.split("/"); for (let i = 1; i < p.length; i++) out.add(p.slice(0, i).join("/")); }
    return out;
  }
  private allDirs() {
    const out = this.realDirs();
    for (const d of this.extraDirs) { const p = d.split("/"); for (let i = 1; i <= p.length; i++) out.add(p.slice(0, i).join("/")); }
    return out;
  }
  private subDirs(of: string) {
    const pre = of ? `${of}/` : "";
    return [...this.allDirs()].filter(d => d.startsWith(pre) && !d.slice(pre.length).includes("/")).sort((a, b) => a.localeCompare(b));
  }

  // ---------- what is listed ----------

  private get filterCount() { const f = this.filters; return (f.kind ? 1 : 0) + (f.state ? 1 : 0) + (f.by ? 1 : 0) + (f.content ? 1 : 0); }
  private get searching() { return !!this.found; }

  /** The files listed: search results, Checked out to me, or the folder's own files. */
  private listedFiles(): FileRec[] {
    let out: FileRec[];
    if (this.found) out = this.files.filter(f => this.found!.has(f.id));
    else if (this.folder === MINE) out = this.files.filter(f => this.panel.isMine(f.id));
    else out = this.files.filter(f => dirOf(f.path) === this.folder);
    return this.sorted(out);
  }

  private value(f: FileRec, k: Col): string | number {
    const v = this.vault!, lv = v.latest(f);
    switch (k) {
      case "name": return base(f.path).toLowerCase();
      case "type": return typeOf(f).toLowerCase();
      case "by": return (f.checkout?.user ?? "").toLowerCase();
      case "ver": return lv.n;
      case "state": return tn(f.state).toLowerCase();
      case "rev": return f.revision ?? "";
      case "pn": return (f.card?.[PART_NUMBER] ?? "").toLowerCase();
      case "desc": return (f.card?.Description ?? "").toLowerCase();
      case "date": return lv.at;
      case "size": return lv.size;
      case "folder": return dirOf(f.path).toLowerCase();
    }
  }

  private sorted(list: FileRec[]) {
    const { k, up } = this.sort, s = up ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = this.value(a, k), y = this.value(b, k);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c ? c * s : base(a.path).localeCompare(base(b.path), undefined, { numeric: true });
    });
  }

  private async runSearch(draw = true) {
    const v = this.vault;
    const text = this.query.trim();
    if (!v || (!text && !this.filterCount)) { this.found = null; if (draw) this.render(); return; }
    const f = this.filters;
    const q: SearchQuery = { kind: f.kind && f.kind !== "other" ? f.kind : undefined, state: f.state || undefined, checkedOutBy: f.by === MINE ? v.user : f.by || undefined };
    const gen = ++this.gen;
    try {
      const hits = new Set((await v.search({ ...q, text: text || undefined })).map(x => x.id));
      if (f.content && text) for (const x of await v.search({ ...q, content: text })) hits.add(x.id);
      if (gen !== this.gen) return;
      const other = f.kind === "other";
      this.found = new Set(this.files.filter(x => hits.has(x.id) && (!other || !KIND_LABEL[x.kind]) && (f.by !== MINE || this.panel.isMine(x.id))).map(x => x.id));
    } catch (e) { toast(errText(e), true); this.found = null; }
    if (draw) this.render();
  }

  // ---------- drawing ----------

  render() {
    const v = this.vault;
    if (!v) {
      this.el.innerHTML = `<div class="vx-none"><div class="vx-none-c">${svg(ICON.vault, "vx-none-i")}<h2>${esc(t("No vault is open"))}</h2>
        <p class="muted">${esc(t("A vault keeps every version of your files, with check-out, check-in, history and an audit trail."))}</p>
        <button class="btn primary" data-x="vmenu" aria-haspopup="menu">${esc(t("Open or create a vault…"))}</button></div></div>`;
      return;
    }
    const keepScroll = this.el.querySelector(".vx-list")?.scrollTop ?? 0;
    const hadFocus = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focusKey = hadFocus?.closest<HTMLElement>(".vx-row")?.dataset.key ?? null;
    const focusQ = hadFocus?.classList.contains("vx-q") ? (hadFocus as HTMLInputElement).selectionStart : null;
    this.el.innerHTML = `${this.barHtml()}${this.filtersOpen ? this.filtersHtml() : ""}
      <div class="vx-main">
        <nav class="vx-tree" aria-label="${esc(t("Folders"))}"><ul role="tree" aria-label="${esc(t("Folders"))}">${this.treeHtml()}</ul></nav>
        <div class="vx-center">
          <div class="vx-crumbs">${this.crumbsHtml()}</div>
          <div class="vx-list" tabindex="-1">${this.listHtml()}</div>
          <div class="vx-foot" aria-live="polite">${this.footText()}</div>
          <div class="vx-detail">${this.detailHead()}<div class="vx-dpane" role="tabpanel" id="vx-dpane" aria-labelledby="vx-t-${this.tab}"></div></div>
        </div>
        <aside class="vx-prev" aria-label="${esc(t("Preview"))}"></aside>
      </div>
      <input type="file" class="vx-files" multiple hidden />`;
    this.grips();
    const list = this.el.querySelector<HTMLElement>(".vx-list")!;
    list.scrollTop = keepScroll;
    this.renderPreview();
    void this.renderDetail();
    if (focusKey) this.el.querySelector<HTMLElement>(`.vx-row[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    else if (focusQ != null) { const q = this.el.querySelector<HTMLInputElement>(".vx-q")!; q.focus(); q.setSelectionRange(focusQ, focusQ); }
  }

  private grips() {
    const main = this.el.querySelector<HTMLElement>(".vx-main")!, center = this.el.querySelector<HTMLElement>(".vx-center")!;
    const setVar = (k: string, px: number | null) => { if (px == null) this.el.style.removeProperty(k); else this.el.style.setProperty(k, `${px}px`); };
    const tree = makeGrip({ key: "vx-tree", axis: "x", sign: 1, def: 230, min: 150, max: () => main.clientWidth * 0.4, apply: px => setVar("--vx-tree", px), label: "Resize the folder tree" });
    tree.classList.add("vx-g-tree");
    const prev = makeGrip({ key: "vx-prev", axis: "x", sign: -1, def: 300, min: 220, max: () => main.clientWidth * 0.45, apply: px => setVar("--vx-prev", px), label: "Resize the preview" });
    prev.classList.add("vx-g-prev");
    const det = makeGrip({ key: "vx-detail", axis: "y", sign: -1, def: 260, min: 120, max: () => center.clientHeight - 140, apply: px => setVar("--vx-det", px), label: "Resize the details" });
    det.classList.add("vx-g-det");
    main.append(tree, prev);
    center.insertBefore(det, center.querySelector(".vx-detail"));
  }

  private barHtml() {
    const v = this.vault!, ids = this.selection;
    const one = ids.length === 1 ? this.rec(ids[0]) : undefined;
    const canCo = ids.some(id => this.panel.canCheckOut(id)), mine = ids.some(id => this.panel.isMine(id));
    const trs = ids.length ? this.panel.commonTransitions(ids) : [];
    const doc = this.panel.docName, inVault = !!this.panel.openFileState;
    const b = (x: string, icon: string, label: string, on = true, extra = "", title = "") =>
      `<button class="vx-b" data-x="${x}"${on ? "" : " disabled"} title="${esc(title || label)}"${extra}>${svg(icon)}<span class="vx-bl">${esc(label)}</span></button>`;
    const where = this.folder === MINE ? t("Checked out to me") : this.folder || v.info.name;
    return `<div class="vx-bar" role="toolbar" aria-label="${esc(t("Vault commands"))}">
      <div class="vx-grp">
        ${b("add", ICON.add, t("Add files…"), this.folder !== MINE, "", t("Add files to {folder}", { folder: where }))}
        ${b("newdir", ICON.newdir, t("New folder"), this.folder !== MINE)}
        ${b("savedoc", ICON.save, t("Save to vault"), !!doc && !inVault, "", doc ? t("Save {name} in {folder}, checked out to you", { name: doc, folder: where }) : t("Open or create a part, an assembly or a drawing first."))}
      </div><span class="vx-sep" aria-hidden="true"></span>
      <div class="vx-grp">
        ${b("co", ICON.out, t("Check out"), canCo)}
        ${b("ci", ICON.in, t("Check in…"), mine)}
        ${b("undo", ICON.undo, t("Undo check-out"), mine)}
        ${b("latest", ICON.latest, t("Get latest"), ids.length > 0)}
        ${b("state", ICON.state, t("Change state"), trs.length > 0, ' aria-haspopup="menu"', one || ids.length ? "" : t("Select files first"))}
      </div><span class="vx-sep" aria-hidden="true"></span>
      <div class="vx-grp">
        ${b("more", ICON.more, t("More"), true, ' aria-haspopup="menu"', t("More vault commands"))}
      </div>
      <div class="vx-search">
        <input class="vx-q" type="search" value="${esc(this.query)}" placeholder="${esc(t("Search the vault"))}" aria-label="${esc(t("Search the vault"))}" />
        <button class="vx-b vx-fbtn${this.filterCount ? " on" : ""}" data-x="filters" aria-expanded="${this.filtersOpen}" title="${esc(t("Filters"))}">${svg(ICON.filter)}<span class="vx-bl">${esc(t("Filters"))}</span>${this.filterCount ? `<span class="vx-badge">${this.filterCount}</span>` : ""}</button>
        <button class="vx-b vx-icon" data-x="refresh" title="${esc(t("Refresh (F5)"))}" aria-label="${esc(t("Refresh (F5)"))}">${svg(ICON.refresh)}</button>
      </div>
    </div>`;
  }

  private filtersHtml() {
    const v = this.vault!, f = this.filters;
    const opt = (val: string, label: string, cur: string) => `<option value="${esc(val)}"${val === cur ? " selected" : ""}>${esc(label)}</option>`;
    const kinds: [string, string][] = [["", "Any type"], ["part", "Parts"], ["assembly", "Assemblies"], ["drawing", "Drawings"], ["other", "Other files"]];
    const users = [...new Set([...v.info.users, ...this.files.flatMap(x => (x.checkout ? [x.checkout.user] : []))])].sort();
    return `<div class="vx-filt" role="group" aria-label="${esc(t("Filters"))}">
      <label>${esc(t("Type"))}<select data-f="kind">${kinds.map(([k, l]) => opt(k, t(l), f.kind)).join("")}</select></label>
      <label>${esc(t("State"))}<select data-f="state">${opt("", t("Any state"), f.state)}${v.workflow.states.map(s => opt(s.name, tn(s.name), f.state)).join("")}</select></label>
      <label>${esc(t("Checked out by"))}<select data-f="by">${opt("", t("Anyone or no one"), f.by)}${opt(MINE, t("Me"), f.by)}${users.map(u => `<option value="${esc(u)}" translate="no"${u === f.by ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
      <label class="chk"><input type="checkbox" data-f="content"${f.content ? " checked" : ""} /> ${esc(t("Also search inside files"))}</label>
      ${this.filterCount ? `<button class="btn small ghost" data-x="clearf">${esc(t("Clear filters"))}</button>` : ""}
    </div>`;
  }

  private treeHtml() {
    const v = this.vault!, dirs = this.allDirs();
    const count = (d: string) => this.files.filter(f => (d ? f.path.startsWith(`${d}/`) : true)).length;
    const item = (path: string, label: string, level: number): string => {
      const kids = this.subDirs(path);
      const open = !this.closed.has(path) || !path;
      const on = !this.searching && this.folder === path;
      const n = count(path);
      return `<li role="treeitem" class="vx-node${on ? " on" : ""}" data-dir="${esc(path)}" aria-level="${level}" aria-selected="${on}"${kids.length ? ` aria-expanded="${open}"` : ""} tabindex="${on ? 0 : -1}" draggable="false">
        <div class="vx-nr" style="--l:${level - 1}">${kids.length && path ? `<span class="vx-tw" data-tw aria-hidden="true">${open ? "▾" : "▸"}</span>` : '<span class="vx-tw" aria-hidden="true"></span>'}${svg(path ? ICON.folder : ICON.vault)}<span class="vx-nl" translate="no">${esc(label)}</span>${n ? `<span class="vx-cnt">${n}</span>` : ""}</div>
        ${kids.length && open ? `<ul role="group">${kids.map(k => item(k, base(k), level + 1)).join("")}</ul>` : ""}</li>`;
    };
    void dirs;
    const mine = this.files.filter(f => this.panel.isMine(f.id)).length;
    return `${item("", v.info.name, 1)}
      <li role="treeitem" class="vx-node vx-special${!this.searching && this.folder === MINE ? " on" : ""}" data-dir="${MINE}" aria-level="1" aria-selected="${this.folder === MINE}" tabindex="${!this.searching && this.folder === MINE ? 0 : -1}"><div class="vx-nr" style="--l:0"><span class="vx-tw" aria-hidden="true"></span>${svg(ICON.mine)}<span class="vx-nl">${esc(t("Checked out to me"))}</span>${mine ? `<span class="vx-cnt">${mine}</span>` : ""}</div></li>
      <li role="treeitem" class="vx-node vx-special" data-dir="@bin" aria-level="1" aria-selected="false" tabindex="-1"><div class="vx-nr" style="--l:0"><span class="vx-tw" aria-hidden="true"></span>${svg(ICON.bin)}<span class="vx-nl">${esc(t("Recycle bin"))}</span></div></li>`;
  }

  private crumbsHtml() {
    const v = this.vault!;
    if (this.searching) {
      const n = this.found!.size;
      return `<span class="vx-crumb-t">${esc(t("{n} file found|{n} files found", { n }))}</span><button class="btn small ghost" data-x="clearq">${esc(t("Clear search"))}</button>${this.colsBtn()}`;
    }
    if (this.folder === MINE) return `<span class="vx-crumb-t">${esc(t("Checked out to me"))}</span>${this.colsBtn()}`;
    const parts = this.folder ? this.folder.split("/") : [];
    const up = `<button class="vx-b vx-icon" data-x="up"${this.folder ? "" : " disabled"} title="${esc(t("Up one folder (Backspace)"))}" aria-label="${esc(t("Up one folder (Backspace)"))}">${svg(ICON.up)}</button>`;
    const crumbs = [`<button class="vx-crumb" data-dir="" translate="no">${esc(v.info.name)}</button>`, ...parts.map((p, i) => `<span class="vx-cs" aria-hidden="true">›</span><button class="vx-crumb" data-dir="${esc(parts.slice(0, i + 1).join("/"))}" translate="no"${i === parts.length - 1 ? ' aria-current="location"' : ""}>${esc(p)}</button>`)];
    return `${up}<nav class="vx-path" aria-label="${esc(t("Folder path"))}">${crumbs.join("")}</nav>${this.colsBtn()}`;
  }

  /** Columns turned off with Columns (kept in this browser). */
  private hidden = new Set<Col>((() => { try { return JSON.parse(storage.get("mc:vxHide") || '["pn"]') as Col[]; } catch { return [] as Col[]; } })());
  private colsBtn() { return `<button class="vx-b vx-cols" data-x="cols" aria-haspopup="menu" title="${esc(t("Show or hide columns"))}">${svg('<path d="M2.5 3h11v10h-11z M6.5 3v10 M10 3v10"/>')}<span>${esc(t("Columns"))}</span></button>`; }

  private get cols() { return COLS.filter(c => (c.k !== "folder" || this.searching || this.folder === MINE) && (c.k === "name" || !this.hidden.has(c.k))); }

  private colsMenu(x: number, y: number, back: HTMLElement | null) {
    this.panel.showMenuAt(COLS.filter(c => c.k !== "name" && c.k !== "folder").map(c => [`${this.hidden.has(c.k) ? "\u2003 " : "✓ "}${t(c.l)}`, () => {
      if (this.hidden.has(c.k)) this.hidden.delete(c.k); else this.hidden.add(c.k);
      storage.set("mc:vxHide", JSON.stringify([...this.hidden]));
      this.render();
    }] as [string, () => void]), x, y, back);
  }

  private listHtml() {
    const v = this.vault!, cols = this.cols;
    const dirs = this.searching || this.folder === MINE ? [] : this.subDirs(this.folder);
    const files = this.listedFiles();
    const grid = cols.map(c => c.w).join(" ");
    // The list scrolls sideways only below the columns' smallest widths.
    const least = cols.reduce((sum, c) => sum + Number(/(\d+)px/.exec(c.w)?.[1] ?? 80), 0);
    const head = `<div class="vx-tr vx-head" role="row">${cols.map(c => {
      const on = this.sort.k === c.k;
      return `<div role="columnheader" class="vx-th${c.num ? " num" : ""}" aria-sort="${on ? (this.sort.up ? "ascending" : "descending") : "none"}"><button data-sort="${c.k}">${esc(t(c.l))}${on ? `<span class="vx-arrow" aria-hidden="true">${this.sort.up ? "▲" : "▼"}</span>` : ""}</button></div>`;
    }).join("")}</div>`;
    const cur = this.cursor ?? (dirs.length ? `dir:${dirs[0]}` : files[0]?.id ?? null);
    const dirRow = (d: string) => {
      const key = `dir:${d}`, on = this.dirSel === d;
      const n = this.files.filter(f => f.path.startsWith(`${d}/`)).length;
      return `<div class="vx-tr vx-row vx-dir${on ? " sel" : ""}" role="row" data-key="${esc(key)}" data-dir="${esc(d)}" aria-selected="${on}" tabindex="${key === cur ? 0 : -1}" draggable="true">${cols.map(c => `<div role="gridcell" class="vx-td${c.num ? " num" : ""}">${c.k === "name" ? `${svg(ICON.folder, "vx-k-folder")}<span class="vx-nm" translate="no">${esc(base(d))}</span>` : c.k === "type" ? esc(t("Folder")) : c.k === "size" ? esc(t("{n} file|{n} files", { n })) : ""}</div>`).join("")}</div>`;
    };
    const fileRow = (f: FileRec) => {
      const st = this.panel.statusOf(f.id), lv = v.latest(f), on = this.sel.has(f.id);
      const color = v.stateOf(f.state).color;
      const lock = f.checkout ? `<span class="vx-lock${st?.mine ? " mine" : ""}" title="${esc(st?.mine ? t("Checked out to you") : t("Checked out by {user}", { user: f.checkout.user }))}">${svg(ICON.lock)}<span translate="no">${esc(f.checkout.user)}</span></span>` : "";
      const badges = `${st?.modified ? `<span class="vx-tag ${st.mine ? "mod" : "old"}" title="${esc(st.mine ? t("Modified: saved changes not checked in yet.") : t("Your local copy is older than the vault's latest version."))}">${esc(st.mine ? t("modified") : t("outdated"))}</span>` : ""}${st?.missing ? `<span class="vx-tag old" title="${esc(t("no local copy"))}">${esc(t("no local copy"))}</span>` : ""}${this.panel.behindOf(f.id) ? `<span class="vx-tag old" title="${esc(t("Uses older versions of:"))} ${esc(this.panel.behindOf(f.id)!.refs.map(r => r.path).join(", "))}">${esc(t("behind"))}</span>` : ""}`;
      const cell = (c: Col) => {
        switch (c) {
          case "name": return `${kindIcon(f.kind)}<span class="vx-nm" translate="no">${esc(base(f.path))}</span>${badges}`;
          case "type": return esc(typeOf(f));
          case "by": return lock;
          case "ver": return `v${lv.n}`;
          case "state": return `<span class="v-state"><i style="background:${esc(color)}"></i>${esc(tn(f.state))}</span>`;
          case "rev": return `<span translate="no">${esc(f.revision ?? "")}</span>`;
          case "pn": return `<span translate="no">${esc(f.card?.[PART_NUMBER] ?? "")}</span>`;
          case "desc": return `<span translate="no">${esc(f.card?.Description ?? "")}</span>`;
          case "date": return esc(fmtDate(lv.at));
          case "size": return esc(fmtSize(lv.size));
          case "folder": return `<span translate="no">${esc(dirOf(f.path) || v.info.name)}</span>`;
        }
      };
      return `<div class="vx-tr vx-row${on ? " sel" : ""}" role="row" data-key="${f.id}" data-id="${f.id}" aria-selected="${on}" tabindex="${f.id === cur ? 0 : -1}" draggable="true" title="${esc(f.path)}">${this.cols.map(c => `<div role="gridcell" class="vx-td vx-c-${c.k}${c.num ? " num" : ""}">${cell(c.k)}</div>`).join("")}</div>`;
    };
    const empty = !dirs.length && !files.length
      ? `<div class="vx-empty">${this.searching ? `<p>${esc(t("Nothing found."))}</p>` : this.folder === MINE ? `<p>${esc(t("No file is checked out to you."))}</p>` : `<p>${esc(t("This folder is empty."))}</p><p class="muted">${esc(t("Drop files here, or use Add files…"))}</p>`}</div>` : "";
    return `<div class="vx-grid" role="grid" aria-multiselectable="true" aria-label="${esc(t("Vault files"))}" aria-rowcount="${dirs.length + files.length + 1}" style="--cols:${grid};min-width:${least}px">${head}<div class="vx-body" role="rowgroup">${dirs.map(dirRow).join("")}${files.map(fileRow).join("")}</div></div>${empty}`;
  }

  private footText() {
    const files = this.listedFiles(), dirs = this.searching || this.folder === MINE ? 0 : this.subDirs(this.folder).length;
    const parts = [t("{n} item|{n} items", { n: files.length + dirs })];
    const ids = this.selection;
    if (ids.length) parts.push(t("{n} selected", { n: ids.length }));
    const mine = files.filter(f => this.panel.isMine(f.id)).length;
    if (mine) parts.push(t("{n} checked out to you", { n: mine }));
    return esc(parts.join(" · "));
  }

  /** The selected files, in the order listed. */
  private get selection(): string[] {
    const shown = this.listedFiles().map(f => f.id).filter(id => this.sel.has(id));
    const rest = [...this.sel].filter(id => !shown.includes(id) && this.rec(id));
    return [...shown, ...rest];
  }

  // ---------- preview ----------

  private renderPreview() {
    const box = this.el.querySelector<HTMLElement>(".vx-prev");
    const v = this.vault;
    if (!box || !v) return;
    const ids = this.selection;
    if (!ids.length) {
      const d = this.dirSel ?? (this.folder === MINE ? null : this.folder);
      if (d == null) { box.innerHTML = `<div class="vx-pv-empty muted">${esc(t("Select a file to see it here."))}</div>`; return; }
      const inside = this.files.filter(f => (d ? f.path.startsWith(`${d}/`) : true));
      const counts = (k: string) => inside.filter(f => (k === "other" ? !KIND_LABEL[f.kind] : f.kind === k)).length;
      const rows = ([["part", "Parts"], ["assembly", "Assemblies"], ["drawing", "Drawings"], ["other", "Other files"]] as const).filter(([k]) => counts(k)).map(([k, l]) => `<dt>${esc(t(l))}</dt><dd>${counts(k)}</dd>`).join("");
      const mine = inside.filter(f => this.panel.isMine(f.id)).length, out = inside.filter(f => f.checkout).length;
      box.innerHTML = `<div class="vx-pic vx-pic-dir">${svg(d ? ICON.folder : ICON.vault, d ? "vx-big vx-k-folder" : "vx-big vx-k-vault")}</div>
        <h3 class="vx-pv-name" translate="no">${esc(d ? base(d) : v.info.name)}</h3>
        <p class="muted vx-pv-path" translate="no">${esc(d || t("Vault {name}", { name: v.info.name }))}</p>
        <dl class="vx-kv"><dt>${esc(t("Files"))}</dt><dd>${inside.length}</dd>${rows}${out ? `<dt>${esc(t("Checked out"))}</dt><dd>${out}${mine ? ` (${esc(t("{n} to you", { n: mine }))})` : ""}</dd>` : ""}</dl>
        <div class="vx-pv-acts">${this.dirSel ? `<button class="btn small primary" data-x="opendir">${esc(t("Open folder"))}</button>` : ""}<button class="btn small" data-x="add">${esc(t("Add files here…"))}</button></div>`;
      return;
    }
    if (ids.length > 1) {
      const fs = ids.map(id => this.rec(id)!).filter(Boolean);
      const size = fs.reduce((s, f) => s + v.latest(f).size, 0);
      const states = new Map<string, number>();
      for (const f of fs) states.set(f.state, (states.get(f.state) ?? 0) + 1);
      box.innerHTML = `<div class="vx-pic vx-pic-many">${fs.slice(0, 3).map(f => kindIcon(f.kind)).join("")}</div>
        <h3 class="vx-pv-name">${esc(t("{n} files selected", { n: fs.length }))}</h3>
        <dl class="vx-kv"><dt>${esc(t("Size"))}</dt><dd>${esc(fmtSize(size))}</dd>${[...states].map(([s, n]) => `<dt><span class="v-state"><i style="background:${esc(v.stateOf(s).color)}"></i>${esc(tn(s))}</span></dt><dd>${n}</dd>`).join("")}</dl>
        <ul class="vx-pv-list" translate="no">${fs.slice(0, 12).map(f => `<li>${kindIcon(f.kind)}${esc(base(f.path))}</li>`).join("")}${fs.length > 12 ? `<li class="muted" translate="yes">${esc(t("and {n} more", { n: fs.length - 12 }))}</li>` : ""}</ul>`;
      return;
    }
    const f = this.rec(ids[0])!, st = this.panel.statusOf(f.id), lv = v.latest(f);
    const color = v.stateOf(f.state).color, rel = v.released(f);
    const lockLine = f.checkout
      ? `<p class="vx-pv-lock${st?.mine ? " mine" : ""}">${svg(ICON.lock)}${esc(st?.mine ? t("Checked out to you") : t("Checked out by {user}", { user: f.checkout.user }))} · <span class="muted">${esc(fmtDate(f.checkout.at))}</span></p>`
      : `<p class="vx-pv-lock muted">${esc(v.stateOf(f.state).checkout ? t("Checked in: read-only until you check it out.") : t("Read-only in this state"))}</p>`;
    const thumb = this.thumbs.get(f.id);
    const trs = v.transitionsOf(f);
    box.innerHTML = `<div class="vx-pic">${thumb ? `<img src="${thumb}" alt="${esc(t("Preview of {name}", { name: base(f.path) }))}" />` : kindIcon(f.kind).replace('class="vx-i', 'class="vx-i vx-big')}</div>
      <h3 class="vx-pv-name" translate="no">${esc(base(f.path))}</h3>
      <p class="muted vx-pv-path" translate="no">${esc(dirOf(f.path) || v.info.name)}</p>
      <div class="vx-pv-tags"><span class="vx-pill"><i style="background:${esc(color)}"></i>${esc(tn(f.state))}</span><span class="vx-pill">v${lv.n}</span>${f.revision ? `<span class="vx-pill">${esc(t("Rev {rev}", { rev: f.revision }))}</span>` : ""}${st?.modified ? `<span class="vx-pill vx-pill-w">${esc(st.mine ? t("modified") : t("outdated"))}</span>` : ""}</div>
      ${lockLine}
      <div class="vx-pv-acts">
        <button class="btn small primary" data-x="open">${esc(t("Open"))}</button>
        ${this.panel.canCheckOut(f.id) ? `<button class="btn small" data-x="co">${esc(t("Check out"))}</button>` : ""}
        ${st?.mine ? `<button class="btn small" data-x="ci">${esc(t("Check in…"))}</button>` : ""}
        ${trs.length ? `<button class="btn small" data-x="state" aria-haspopup="menu">${esc(t("Change state"))} ▾</button>` : ""}
      </div>
      <dl class="vx-kv">
        <dt>${esc(t("Type"))}</dt><dd>${esc(typeOf(f))}</dd>
        <dt>${esc(t("Latest version"))}</dt><dd>${esc(t("v{n} by {user}", { n: lv.n, user: lv.user }))}<br><span class="muted">${esc(fmtDate(lv.at))}</span></dd>
        ${lv.comment ? `<dt>${esc(t("Comment"))}</dt><dd translate="no">${esc(lv.comment)}</dd>` : ""}
        ${rel ? `<dt>${esc(t("Released"))}</dt><dd translate="no">${esc(rel.rev ?? "")} · v${rel.n}${rel.approvedBy ? ` · ${esc(rel.approvedBy)}` : ""}</dd>` : ""}
        <dt>${esc(t("Size"))}</dt><dd>${esc(fmtSize(lv.size))}</dd>
        ${v.cardFields(f.kind).filter(x => f.card?.[x.name]).slice(0, 6).map(x => `<dt>${esc(t(x.name))}</dt><dd translate="no">${esc(f.card![x.name])}</dd>`).join("")}
      </dl>`;
    if (!thumb) void this.loadThumb(f.id);
  }

  private async loadThumb(id: string) {
    const v = this.vault;
    if (!v || this.thumbs.has(id)) return;
    this.thumbs.set(id, "");
    const png = await v.thumb(id).catch(() => null);
    if (!png || this.vault !== v) return;
    this.thumbs.set(id, URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })));
    if (this.selection.length === 1 && this.selection[0] === id) this.renderPreview();
  }

  // ---------- details under the list ----------

  private detailHead() {
    return `<div class="vx-tabs" role="tablist" aria-label="${esc(t("File details"))}">${TABS.map(([k, l]) => `<button role="tab" id="vx-t-${k}" data-tab="${k}" aria-selected="${k === this.tab}" aria-controls="vx-dpane" tabindex="${k === this.tab ? 0 : -1}">${esc(t(l))}</button>`).join("")}</div>`;
  }

  private async renderDetail() {
    const pane = this.el.querySelector<HTMLElement>(".vx-dpane"), v = this.vault;
    if (!pane || !v) return;
    const ids = this.selection;
    if (ids.length !== 1) {
      pane.innerHTML = `<p class="muted vx-dmsg">${esc(ids.length ? t("{n} files selected: pick one to see its details.", { n: ids.length }) : t("Select a file to see its details."))}</p>`;
      return;
    }
    const id = ids[0], f = this.rec(id)!, gen = ++this.gen;
    const set = (html: string) => { if (gen === this.gen && this.el.contains(pane)) pane.innerHTML = html; };
    try {
      switch (this.tab) {
        case "card": set(this.cardHtml(f)); break;
        case "versions": set(this.versionsHtml(f)); break;
        case "contains": {
          const tree = await v.contains(id, undefined, this.mode);
          set(`${this.modeHtml()}${tree.children.length ? `<ul class="vx-ref" role="tree" aria-label="${esc(t("Contains"))}">${tree.children.map(c => this.refHtml(c)).join("")}</ul>` : `<p class="muted vx-dmsg">${esc(t("This file references no other files."))}</p>`}`);
          break;
        }
        case "used": {
          const ups = await v.whereUsed(id);
          set(ups.length ? `<ul class="vx-ref" role="tree" aria-label="${esc(t("Where used"))}">${ups.map(c => this.refHtml(c, true)).join("")}</ul>` : `<p class="muted vx-dmsg">${esc(t("No file in the vault uses this file."))}</p>`);
          break;
        }
        case "bom": {
          const bom = await v.bom(id, undefined, this.mode);
          set(`${this.modeHtml(bom.length > 0)}${bom.length ? `<table class="vx-tbl"><thead><tr><th>${esc(t("Item"))}</th><th>${esc(t("File"))}</th><th>${esc(t("Part number"))}</th><th>${esc(t("Description"))}</th><th>${esc(t("Revision"))}</th><th>${esc(t("State"))}</th><th class="num">${esc(t("Qty"))}</th></tr></thead><tbody>${bom.map((r, i) => {
            const c = this.files.find(x => x.path === r.path);
            return `<tr><td>${i + 1}</td><td translate="no">${c ? `<button class="v-link" data-goto="${c.id}">${esc(r.path)}</button>` : esc(r.path)}</td><td translate="no">${esc(r.partNumber)}</td><td translate="no">${esc(r.description)}</td><td translate="no">${esc(r.rev ?? "")} v${r.version}</td><td>${c ? esc(tn(c.state)) : ""}</td><td class="num">${r.qty}</td></tr>`;
          }).join("")}</tbody></table>` : `<p class="muted vx-dmsg">${esc(t("This file references no other files."))}</p>`}`);
          break;
        }
      }
    } catch (e) { set(`<p class="v-bad vx-dmsg">${esc(errText(e))}</p>`); }
  }

  private modeHtml(csv = false) {
    const opts = ([["built", "As checked in"], ["latest", "Latest"], ["released", "Latest released"]] as const).map(([k, l]) => `<option value="${k}"${k === this.mode ? " selected" : ""}>${esc(t(l))}</option>`).join("");
    return `<div class="vx-dbar"><label>${esc(t("Components"))} <select data-x="mode">${opts}</select></label>${csv ? `<button class="btn small" data-x="bomcsv">${esc(t("Export BOM CSV"))}</button>` : ""}</div>`;
  }

  private refHtml(n: TreeNode, up = false, depth = 0): string {
    const v = this.vault!, c = this.files.find(x => x.id === n.id);
    const latest = c ? v.latest(c).n : 0;
    const label = `${n.qty > 1 ? `<b>${n.qty}×</b> ` : ""}${c ? `<button class="v-link" data-goto="${c.id}" translate="no">${esc(n.path)}</button>` : `<span translate="no">${esc(n.path)}</span>`}`;
    const meta = n.missing ? ` <span class="v-bad">${esc(t("missing"))}</span>` : up
      ? ` <span class="muted">· ${esc(t("uses v{n}", { n: n.version }))}</span>`
      : ` <span class="muted">· v${n.version}${n.rev ? ` · ${esc(n.rev)}` : ""} · ${esc(tn(n.state))}</span>${n.linked ? ` <span class="vx-tag">⛓ ${esc(t("linked"))}</span>` : ""}${n.newer || (latest > n.version && !up) ? ` <span class="vx-tag old">${esc(t("v{n} in the vault", { n: n.newer ?? latest }))}</span>` : ""}`;
    const kids = n.children.length && depth < 20 && !n.cycle ? `<ul role="group">${n.children.map(x => this.refHtml(x, up, depth + 1)).join("")}</ul>` : "";
    return `<li role="treeitem"${kids ? ' aria-expanded="true"' : ""}>${c ? kindIcon(c.kind) : svg(ICON.file)}${label}${meta}${n.cycle ? " ↻" : ""}${kids}</li>`;
  }

  private cardHtml(f: FileRec) {
    const v = this.vault!, editable = this.panel.isMine(f.id);
    const input = (fd: CardField) => {
      const val = f.card?.[fd.name] ?? "", nm = `c:${fd.name}`, dis = editable ? "" : " disabled";
      if (fd.type === "list") return `<select name="${esc(nm)}"${dis}><option value=""></option>${(fd.options ?? []).map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      if (fd.type === "checkbox") return `<input type="checkbox" name="${esc(nm)}"${val === "true" ? " checked" : ""}${dis} />`;
      if (fd.type === "user") return `<select name="${esc(nm)}"${dis}><option value=""></option>${v.info.users.map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      return `<input name="${esc(nm)}" type="${fd.type === "date" ? "date" : "text"}"${fd.type === "number" ? ' inputmode="decimal"' : ""} value="${esc(val)}" maxlength="200"${dis}${editable ? "" : ' placeholder="—"'} translate="no" />`;
    };
    const fields = v.cardFields(f.kind);
    const note = editable ? "" : `<div class="vx-dbar"><span class="muted">${esc(this.panel.canCheckOut(f.id) ? t("Check the file out to edit its data card.") : f.checkout ? t("Checked out by {user}.", { user: f.checkout.user }) : t("Read-only in this state"))}</span>${this.panel.canCheckOut(f.id) ? `<button class="btn small" data-x="co">${esc(t("Check out"))}</button>` : ""}</div>`;
    return `${note}<form class="vx-card" data-card="${f.id}">${fields.map(fd => `<label><span>${esc(t(fd.name))}${fd.required ? " *" : ""}</span>${input(fd)}${fd.name === PART_NUMBER && editable ? `<button type="button" class="btn small" data-x="num">${esc(t("New number"))}</button>` : ""}</label>`).join("")}
      ${editable ? `<div class="vx-card-acts"><button type="button" class="btn small" data-x="cardreset">${esc(t("Revert"))}</button><button type="submit" class="btn small primary">${esc(t("Save"))}</button></div>` : ""}</form>`;
  }

  private versionsHtml(f: FileRec) {
    const v = this.vault!, latest = v.latest(f).n;
    const live = f.versions.filter(x => !x.purged);
    const vs = live.map(x => `<option value="${x.n}">v${x.n}${x.rev ? ` (${esc(x.rev)})` : ""}</option>`).join("");
    const cmp = live.length > 1 ? `<div class="vx-dbar"><span>${esc(t("Compare"))}</span><select data-x="ca" aria-label="${esc(t("First version"))}">${vs.replace(`value="${live[Math.max(0, live.length - 2)].n}"`, `value="${live[Math.max(0, live.length - 2)].n}" selected`)}</select><select data-x="cb" aria-label="${esc(t("Second version"))}">${vs.replace(`value="${latest}"`, `value="${latest}" selected`)}</select><button class="btn small" data-x="compare">${esc(t("Compare"))}</button><button class="btn small ghost" data-x="history">${esc(t("Full history…"))}</button></div>` : `<div class="vx-dbar"><button class="btn small ghost" data-x="history">${esc(t("Full history…"))}</button></div>`;
    return `${cmp}<table class="vx-tbl"><thead><tr><th>${esc(t("Version"))}</th><th>${esc(t("Revision"))}</th><th>${esc(t("State"))}</th><th>${esc(t("Date"))}</th><th>${esc(t("User"))}</th><th>${esc(t("Comment"))}</th><th class="num">${esc(t("Size"))}</th><th></th></tr></thead><tbody>${[...f.versions].reverse().map(x => `<tr${x.n === latest ? ' class="vx-cur"' : ""}><td>v${x.n}</td><td translate="no">${esc(x.rev ?? "")}</td><td>${esc(tn(x.state))}</td><td>${esc(fmtDate(x.at))}</td><td translate="no">${esc(x.user)}</td><td translate="no">${esc(x.comment)}</td><td class="num">${esc(fmtSize(x.size))}</td><td class="vx-acts">${x.purged ? `<span class="muted">${esc(t("purged"))}</span>` : `<button class="btn small" data-ver="${x.n}">${esc(t("Open"))}</button>${x.n !== latest ? `<button class="btn small" data-rb="${x.n}">${esc(t("Roll back"))}</button>` : ""}`}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------- selection ----------

  /** Selects a list row: plain click = only it, Ctrl = toggle, Shift = range from the anchor. */
  private pick(key: string, how: { ctrl?: boolean; shift?: boolean } = {}) {
    this.cursor = key;
    if (key.startsWith("dir:")) {
      this.sel.clear(); this.anchor = null;
      this.dirSel = key.slice(4);
    } else {
      this.dirSel = null;
      const order = this.listedFiles().map(f => f.id);
      if (how.shift && this.anchor && order.includes(this.anchor)) {
        const a = order.indexOf(this.anchor), b = order.indexOf(key);
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        if (!how.ctrl) this.sel.clear();
        for (const id of range) this.sel.add(id);
      } else if (how.ctrl) {
        if (this.sel.has(key)) this.sel.delete(key); else this.sel.add(key);
        this.anchor = key;
      } else {
        this.sel = new Set([key]);
        this.anchor = key;
      }
    }
    this.selectionChanged();
  }

  private selectionChanged() {
    for (const r of this.el.querySelectorAll<HTMLElement>(".vx-row")) {
      const k = r.dataset.key!;
      const on = k.startsWith("dir:") ? this.dirSel === k.slice(4) : this.sel.has(k);
      r.classList.toggle("sel", on);
      r.setAttribute("aria-selected", String(on));
      r.tabIndex = k === this.cursor ? 0 : -1;
    }
    const bar = this.el.querySelector(".vx-bar");
    if (bar) bar.outerHTML = this.barHtml();
    const foot = this.el.querySelector(".vx-foot");
    if (foot) foot.innerHTML = this.footText();
    this.renderPreview();
    void this.renderDetail();
  }

  private goFolder(dir: string) {
    if (dir === "@bin") { void this.panel.recycleBinDlg(); return; }
    this.folder = dir;
    this.found = null;
    this.query = "";
    this.sel.clear(); this.anchor = null; this.cursor = null; this.dirSel = null;
    // Opening a folder unfolds its parents in the tree.
    if (dir && dir !== MINE) { const p = dir.split("/"); for (let i = 1; i <= p.length; i++) this.closed.delete(p.slice(0, i).join("/")); this.saveClosed(); }
    this.render();
  }

  private saveClosed() { storage.set(`mc:vxClosed:${this.vaultName}`, JSON.stringify([...this.closed])); }

  /** Shows a file: its folder opens and the file is selected (links in the details). */
  private reveal(id: string) {
    const f = this.rec(id);
    if (!f) return;
    this.goFolder(dirOf(f.path));
    this.pick(id);
    this.el.querySelector<HTMLElement>(`.vx-row[data-key="${id}"]`)?.scrollIntoView({ block: "nearest" });
    this.el.querySelector<HTMLElement>(`.vx-row[data-key="${id}"]`)?.focus({ preventScroll: true });
  }

  // ---------- commands ----------

  private async openFile(id: string, version?: number) {
    await this.panel.openFile(id, version);
    // Opened (or shown in its tab): the document is on screen, so the explorer steps aside.
    if (version || this.panel.openId === id) this.hide();
  }

  private stateMenu(btn: HTMLElement) {
    const ids = this.selection;
    const trs = this.panel.commonTransitions(ids);
    if (!trs.length) return;
    const r = btn.getBoundingClientRect();
    this.panel.showMenuAt(trs.map(n => [tn(n), () => void this.panel.transitionDlg(ids.length === 1 ? ids[0] : ids, n)]), r.left, r.bottom + 4, btn);
  }

  private async newFolder() {
    const parent = this.folder === MINE ? "" : this.folder;
    const name = await this.panel.askText(t("New folder"), t("Folder name"), "", t("Create"));
    const clean = name?.trim().replace(/[\\/]+/g, "-");
    if (!clean) return;
    if (clean === "." || clean === ".." || clean.startsWith(".mcadvault")) { toast(t("Invalid file name: {path}", { path: clean }), true); return; }
    const path = parent ? `${parent}/${clean}` : clean;
    if (this.allDirs().has(path)) { toast(t("{name} already exists.", { name: path }), true); return; }
    this.extraDirs.add(path);
    this.saveDirs();
    this.render();
    toast(t("Folder {name} made: add or drop files into it to keep it.", { name: path }), "success");
  }

  private async renameFolderDlg(dir: string) {
    if (!this.realDirs().has(dir)) {
      // A New folder with no files yet is renamed here only.
      const to = await this.panel.askText(t("Rename folder"), t("New name"), base(dir), t("Rename"));
      const clean = to?.trim().replace(/[\\/]+/g, "-");
      if (!clean) return;
      this.extraDirs.delete(dir);
      this.extraDirs.add(dirOf(dir) ? `${dirOf(dir)}/${clean}` : clean);
      this.saveDirs();
      this.render();
      return;
    }
    const to = await this.panel.askText(t("Rename folder"), t("New path (use / for folders)"), dir, t("Rename"));
    if (to == null) return;
    const n = this.files.filter(f => f.path.startsWith(`${dir}/`)).length;
    if (!await confirmModal(t("Move {n} file to {folder}?|Move {n} files to {folder}?", { n, folder: to.trim() }), t("Rename"), t("Rename folder"))) return;
    await this.panel.renameFolder(dir, to);
    if (this.folder === dir || this.folder.startsWith(`${dir}/`)) this.folder = to.trim() + this.folder.slice(dir.length);
    this.render();
  }

  private folderMenu(dir: string, x: number, y: number, back: HTMLElement | null) {
    const inside = this.files.filter(f => (dir ? f.path.startsWith(`${dir}/`) : true)).map(f => f.id);
    const canCo = inside.filter(id => this.panel.canCheckOut(id)), mine = inside.filter(id => this.panel.isMine(id));
    this.panel.showMenuAt([
      [t("Open folder"), () => this.goFolder(dir), true],
      null,
      [t("Add files here…"), () => this.addInto(dir)],
      [t("New folder"), () => { this.folder = dir; void this.newFolder(); }],
      null,
      canCo.length ? [t("Check out all ({n})", { n: canCo.length }), () => void this.panel.checkOutMany(canCo)] : null,
      mine.length ? [t("Check in all ({n})…", { n: mine.length }), () => void this.panel.checkInMany(mine)] : null,
      inside.length ? [t("Get latest of all ({n})", { n: inside.length }), () => void this.panel.latestMany(inside)] : null,
      null,
      dir ? [t("Rename folder…"), () => void this.renameFolderDlg(dir)] : null,
      dir && !this.realDirs().has(dir) ? [t("Remove empty folder"), () => { this.extraDirs.delete(dir); this.saveDirs(); if (this.folder === dir) this.folder = dirOf(dir); this.render(); }] : null,
    ], x, y, back);
  }

  private addInto(dir: string) {
    const inp = this.el.querySelector<HTMLInputElement>(".vx-files");
    if (!inp) return;
    inp.dataset.dir = dir;
    inp.value = "";
    inp.click();
  }

  private async addFiles(list: File[], dir: string) {
    if (!list.length) return;
    await this.panel.addFiles(list, undefined, dir === MINE ? "" : dir);
    // The files just added are selected.
    const names = new Set(list.map(f => (dir && dir !== MINE ? `${dir}/` : "") + f.name));
    this.sel = new Set(this.files.filter(f => names.has(f.path)).map(f => f.id));
    this.render();
  }

  private async move(ids: string[], dir: string) {
    if (await this.panel.moveMany(ids, dir)) { this.sel = new Set(ids); this.render(); }
  }

  private rowMenuAt(key: string, x: number, y: number, back: HTMLElement | null) {
    if (key.startsWith("dir:")) { this.folderMenu(key.slice(4), x, y, back); return; }
    if (!this.sel.has(key)) this.pick(key);
    const ids = this.selection;
    const one = ids.length === 1 ? this.rec(ids[0]) : undefined;
    const extra: ([string, () => void] | null)[] = [];
    if (one && (this.searching || this.folder === MINE)) extra.push([t("Show in folder"), () => this.reveal(one.id)]);
    this.panel.fileMenu(ids, x, y, back, extra);
  }

  private act(x: string, btn: HTMLElement) {
    const ids = this.selection, id = ids[0];
    switch (x) {
      case "vmenu": this.host.vaultMenu(btn); break;
      case "add": this.addInto(this.dirSel ?? (this.folder === MINE ? "" : this.folder)); break;
      case "newdir": void this.newFolder(); break;
      case "savedoc": void this.panel.saveOpenDoc(this.folder === MINE ? "" : this.folder); break;
      case "co": if (ids.length > 1) void this.panel.checkOutMany(ids); else if (id) void this.panel.checkOut(id); break;
      case "ci": if (ids.length > 1) void this.panel.checkInMany(ids); else if (id) void this.panel.checkIn(id); break;
      case "undo": if (ids.length > 1) void this.panel.undoMany(ids); else if (id) void this.panel.undoCheckOut(id); break;
      case "latest": if (ids.length > 1) void this.panel.latestMany(ids); else if (id) void this.panel.getLatest(id); break;
      case "state": this.stateMenu(btn); break;
      case "more": { const r = btn.getBoundingClientRect(); this.panel.moreMenu(r.left, r.bottom + 4, btn); break; }
      case "filters": this.filtersOpen = !this.filtersOpen; this.render(); if (this.filtersOpen) this.el.querySelector<HTMLElement>(".vx-filt select")?.focus(); else this.el.querySelector<HTMLElement>('[data-x="filters"]')?.focus(); break;
      case "clearf": this.filters = { kind: "", state: "", by: "", content: false }; void this.runSearch(); break;
      case "clearq": this.query = ""; this.filters = { kind: "", state: "", by: "", content: false }; this.found = null; this.render(); this.el.querySelector<HTMLElement>(".vx-q")?.focus(); break;
      case "refresh": void this.panel.refresh(); break;
      case "up": if (this.folder && this.folder !== MINE) this.goFolder(dirOf(this.folder)); break;
      case "open": if (id) void this.openFile(id); break;
      case "opendir": if (this.dirSel != null) this.goFolder(this.dirSel); break;
      case "history": if (id) void this.panel.history(id); break;
      case "compare": {
        const a = +this.el.querySelector<HTMLSelectElement>('[data-x="ca"]')!.value, b = +this.el.querySelector<HTMLSelectElement>('[data-x="cb"]')!.value;
        if (id && a !== b) void this.panel.compareDlg(id, Math.min(a, b), Math.max(a, b)); else toast(t("Pick two different versions."));
        break;
      }
      case "bomcsv": void this.bomCsv(); break;
      case "cols": { const r = btn.getBoundingClientRect(); this.colsMenu(r.right - 200, r.bottom + 4, btn); break; }
      case "num": void this.newNumber(); break;
      case "cardreset": void this.renderDetail(); break;
    }
  }

  private async bomCsv() {
    const v = this.vault, id = this.selection[0], f = id ? this.rec(id) : undefined;
    if (!v || !f) return;
    const bom = await v.bom(id, undefined, this.mode);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csvOf([["item", "path", "part number", "description", "revision", "version", "qty"], ...bom.map((r, i) => [i + 1, r.path, r.partNumber, r.description, r.rev ?? "", r.version, r.qty])])], { type: "text/csv" }));
    a.download = `${base(f.path)}-v${v.latest(f).n}-bom.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async newNumber() {
    const v = this.vault, id = this.selection[0], f = id ? this.rec(id) : undefined;
    if (!v || !f) return;
    try {
      const n = await v.issueNumber(f.card);
      const el = this.el.querySelector<HTMLInputElement>(`[name="c:${CSS.escape(PART_NUMBER)}"]`);
      if (el) el.value = n;
    } catch (e) { toast(errText(e), true); }
  }

  private async saveCard(form: HTMLFormElement) {
    const v = this.vault, id = form.dataset.card!, f = this.rec(id);
    if (!v || !f) return;
    const vals: Record<string, string> = {};
    for (const fd of v.cardFields(f.kind)) {
      const el = form.querySelector<HTMLInputElement>(`[name="c:${CSS.escape(fd.name)}"]`);
      if (el) vals[fd.name] = el.type === "checkbox" ? String(el.checked) : el.value;
    }
    await this.panel.saveCard(id, vals);
  }

  // ---------- events ----------

  private bind() {
    const el = this.el;
    el.addEventListener("click", e => {
      const tg = e.target as HTMLElement;
      const x = tg.closest<HTMLElement>("[data-x]");
      if (x && !(x instanceof HTMLSelectElement) && !(x as HTMLButtonElement).disabled) { this.act(x.dataset.x!, x); return; }
      const sort = tg.closest<HTMLElement>("[data-sort]");
      if (sort) {
        const k = sort.dataset.sort as Col;
        this.sort = { k, up: this.sort.k === k ? !this.sort.up : true };
        storage.set("mc:vxSort", JSON.stringify(this.sort));
        this.render();
        this.el.querySelector<HTMLElement>(`[data-sort="${k}"]`)?.focus();
        return;
      }
      const go = tg.closest<HTMLElement>("[data-goto]");
      if (go) { this.reveal(go.dataset.goto!); return; }
      const ver = tg.closest<HTMLElement>("[data-ver]");
      if (ver) { const id = this.selection[0]; if (id) void this.openFile(id, +ver.dataset.ver!); return; }
      const rb = tg.closest<HTMLElement>("[data-rb]");
      if (rb) { const id = this.selection[0]; if (id) void this.panel.rollBack(id, +rb.dataset.rb!); return; }
      const tab = tg.closest<HTMLElement>("[data-tab]");
      if (tab) { this.setTab(tab.dataset.tab as DetTab); return; }
      const crumb = tg.closest<HTMLElement>(".vx-crumb");
      if (crumb) { this.goFolder(crumb.dataset.dir!); return; }
      const node = tg.closest<HTMLElement>(".vx-node");
      if (node) {
        const dir = node.dataset.dir!;
        if (tg.closest("[data-tw]")) { this.toggleNode(dir); return; }
        this.goFolder(dir);
        this.el.querySelector<HTMLElement>(`.vx-node[data-dir="${CSS.escape(dir)}"]`)?.focus();
        return;
      }
      const row = tg.closest<HTMLElement>(".vx-row");
      if (row) { this.pick(row.dataset.key!, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }); row.focus({ preventScroll: true }); }
    });
    el.addEventListener("dblclick", e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".vx-row");
      if (!row) return;
      const k = row.dataset.key!;
      if (k.startsWith("dir:")) this.goFolder(k.slice(4)); else void this.openFile(k);
    });
    el.addEventListener("contextmenu", e => {
      const tg = e.target as HTMLElement;
      const row = tg.closest<HTMLElement>(".vx-row"), node = tg.closest<HTMLElement>(".vx-node");
      if (row) { e.preventDefault(); this.rowMenuAt(row.dataset.key!, e.clientX, e.clientY, row); return; }
      if (node && !node.dataset.dir!.startsWith("@")) { e.preventDefault(); this.folderMenu(node.dataset.dir!, e.clientX, e.clientY, node); return; }
      if (tg.closest(".vx-head")) { e.preventDefault(); this.colsMenu(e.clientX, e.clientY, null); return; }
      if (tg.closest(".vx-list")) { e.preventDefault(); this.folderMenu(this.folder === MINE ? "" : this.folder, e.clientX, e.clientY, null); }
    });
    el.addEventListener("change", e => {
      const tg = e.target as HTMLElement;
      if (tg.matches(".vx-files")) {
        const inp = tg as HTMLInputElement;
        void this.addFiles([...(inp.files ?? [])], inp.dataset.dir ?? this.folder);
        return;
      }
      const f = tg.dataset.f as keyof Filters | undefined;
      if (f) {
        if (f === "content") this.filters.content = (tg as HTMLInputElement).checked;
        else this.filters[f] = (tg as HTMLSelectElement).value;
        void this.runSearch();
        return;
      }
      if (tg.dataset.x === "mode") { this.mode = (tg as HTMLSelectElement).value as Resolve; void this.renderDetail(); }
    });
    el.addEventListener("input", e => {
      const q = e.target as HTMLInputElement;
      if (!q.matches(".vx-q")) return;
      this.query = q.value;
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.runSearch(), 220);
    });
    el.addEventListener("submit", e => {
      const form = (e.target as HTMLElement).closest<HTMLFormElement>(".vx-card");
      if (!form) return;
      e.preventDefault();
      void this.saveCard(form);
    });
    el.addEventListener("keydown", e => this.key(e));
    // Drag and drop: rows onto folders move them; files from the computer go into the folder they land on.
    el.addEventListener("dragstart", e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".vx-row");
      if (!row || !e.dataTransfer) return;
      const k = row.dataset.key!;
      if (k.startsWith("dir:")) { e.preventDefault(); return; }
      if (!this.sel.has(k)) this.pick(k);
      const ids = this.selection;
      e.dataTransfer.setData(MIME, JSON.stringify(ids));
      e.dataTransfer.setData("text/plain", ids.map(id => this.rec(id)?.path ?? "").join("\n"));
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); this.dropMark(null); });
    const target = (e: DragEvent): string | null => {
      const tg = e.target as HTMLElement;
      const node = tg.closest<HTMLElement>(".vx-node"), dirRow = tg.closest<HTMLElement>(".vx-dir"), crumb = tg.closest<HTMLElement>(".vx-crumb");
      const d = node?.dataset.dir ?? dirRow?.dataset.dir ?? crumb?.dataset.dir;
      if (d != null) return d.startsWith("@") ? null : d;
      if (tg.closest(".vx-list")) return this.folder === MINE || this.searching ? null : this.folder;
      return null;
    };
    el.addEventListener("dragover", e => {
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes(MIME) && !types.includes("Files")) return;
      const d = target(e);
      if (d == null) { this.dropMark(null); return; }
      e.preventDefault();
      e.dataTransfer!.dropEffect = types.includes(MIME) ? "move" : "copy";
      this.dropMark(e.target as HTMLElement);
    });
    el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget as Node)) this.dropMark(null); });
    el.addEventListener("drop", e => {
      const d = target(e);
      this.dropMark(null);
      el.classList.remove("dragging");
      if (d == null || !e.dataTransfer) return;
      e.preventDefault();
      const raw = e.dataTransfer.getData(MIME);
      if (raw) { void this.move(JSON.parse(raw) as string[], d); return; }
      const files = [...e.dataTransfer.files];
      if (files.length) void this.addFiles(files, d);
    });
  }

  private dropMark(tg: HTMLElement | null) {
    const on = tg?.closest<HTMLElement>(".vx-node .vx-nr, .vx-dir, .vx-crumb") ?? tg?.closest<HTMLElement>(".vx-list") ?? null;
    for (const x of this.el.querySelectorAll(".drop")) if (x !== on) x.classList.remove("drop");
    on?.classList.add("drop");
  }

  private setTab(k: DetTab) {
    this.tab = k;
    storage.set("mc:vxTab", k);
    for (const b of this.el.querySelectorAll<HTMLElement>("[data-tab]")) { const on = b.dataset.tab === k; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    this.el.querySelector(".vx-dpane")?.setAttribute("aria-labelledby", `vx-t-${k}`);
    void this.renderDetail();
  }

  private toggleNode(dir: string, open?: boolean) {
    const now = !this.closed.has(dir);
    const want = open ?? !now;
    if (want === now) return;
    if (want) this.closed.delete(dir); else this.closed.add(dir);
    this.saveClosed();
    const tree = this.el.querySelector(".vx-tree ul");
    if (tree) tree.innerHTML = this.treeHtml();
    this.el.querySelector<HTMLElement>(`.vx-node[data-dir="${CSS.escape(dir)}"]`)?.focus();
  }

  private key(e: KeyboardEvent) {
    const tg = e.target as HTMLElement;
    const ctrl = e.ctrlKey || e.metaKey;
    // The 3D document's shortcuts (Delete, Ctrl+Z, letters) must not act while the explorer has the keys;
    // the file shortcuts (Ctrl+O, Ctrl+S, Ctrl+P) still reach the window.
    if (!(ctrl && /^[ospn]$/i.test(e.key))) e.stopPropagation();
    if (tg.matches("input, select, textarea")) {
      if (e.key === "Escape" && tg.matches(".vx-q") && (this.query || this.found)) { e.preventDefault(); this.act("clearq", tg); }
      else if (e.key === "Enter" && tg.matches(".vx-q")) { e.preventDefault(); clearTimeout(this.searchTimer); void this.runSearch(); }
      return;
    }
    if (e.key === "F5") { e.preventDefault(); void this.panel.refresh(); return; }
    if (ctrl && e.key.toLowerCase() === "f") { e.preventDefault(); this.el.querySelector<HTMLElement>(".vx-q")?.focus(); return; }
    const tab = tg.closest<HTMLElement>("[role=tab]");
    if (tab && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const i = TABS.findIndex(([k]) => k === this.tab), n = TABS.length;
      const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
      this.setTab(TABS[j][0]);
      this.el.querySelector<HTMLElement>(`[data-tab="${TABS[j][0]}"]`)?.focus();
      return;
    }
    const node = tg.closest<HTMLElement>(".vx-node");
    if (node && tg === node) { this.treeKey(e, node); return; }
    const row = tg.closest<HTMLElement>(".vx-row");
    if (row && tg === row) this.listKey(e, row);
  }

  private treeKey(e: KeyboardEvent, node: HTMLElement) {
    const nodes = [...this.el.querySelectorAll<HTMLElement>(".vx-node")];
    const i = nodes.indexOf(node), dir = node.dataset.dir!;
    const focus = (n?: HTMLElement) => { if (!n) return; nodes.forEach(x => (x.tabIndex = -1)); n.tabIndex = 0; n.focus(); };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focus(nodes[i + 1]); break;
      case "ArrowUp": e.preventDefault(); focus(nodes[i - 1]); break;
      case "Home": e.preventDefault(); focus(nodes[0]); break;
      case "End": e.preventDefault(); focus(nodes[nodes.length - 1]); break;
      case "ArrowRight": e.preventDefault(); if (node.getAttribute("aria-expanded") === "false") this.toggleNode(dir, true); else focus(node.querySelector<HTMLElement>(".vx-node") ?? undefined); break;
      case "ArrowLeft": e.preventDefault(); if (node.getAttribute("aria-expanded") === "true" && dir) this.toggleNode(dir, false); else focus(node.parentElement?.closest<HTMLElement>(".vx-node") ?? undefined); break;
      case "Enter": case " ": e.preventDefault(); this.goFolder(dir); this.el.querySelector<HTMLElement>(`.vx-node[data-dir="${CSS.escape(dir)}"]`)?.focus(); break;
      case "ContextMenu": case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        if (!dir.startsWith("@")) { const r = node.getBoundingClientRect(); this.folderMenu(dir, r.left + 24, r.top + 20, node); }
        break;
    }
  }

  private listKey(e: KeyboardEvent, row: HTMLElement) {
    const rows = [...this.el.querySelectorAll<HTMLElement>(".vx-row")];
    const i = rows.indexOf(row), k = row.dataset.key!;
    const ctrl = e.ctrlKey || e.metaKey;
    const moveTo = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!r) return;
      const key = r.dataset.key!;
      if (e.shiftKey && !key.startsWith("dir:")) this.pick(key, { shift: true });
      else if (ctrl) { this.cursor = key; rows.forEach(x => (x.tabIndex = x === r ? 0 : -1)); }
      else this.pick(key);
      r.focus();
      r.scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveTo(i + 1); break;
      case "ArrowUp": e.preventDefault(); moveTo(i - 1); break;
      case "Home": e.preventDefault(); moveTo(0); break;
      case "End": e.preventDefault(); moveTo(rows.length - 1); break;
      case "PageDown": e.preventDefault(); moveTo(i + 10); break;
      case "PageUp": e.preventDefault(); moveTo(i - 10); break;
      case " ": e.preventDefault(); this.pick(k, { ctrl }); break;
      case "Enter": e.preventDefault(); if (k.startsWith("dir:")) this.goFolder(k.slice(4)); else void this.openFile(k); break;
      case "Backspace": e.preventDefault(); this.act("up", row); break;
      case "ArrowLeft": if (e.altKey) { e.preventDefault(); this.act("up", row); } break;
      case "Delete": {
        e.preventDefault();
        const ids = this.selection;
        if (k.startsWith("dir:")) return;
        if (ids.length > 1) void this.panel.deleteMany(ids); else if (ids[0]) void this.panel.deleteFile(ids[0]);
        break;
      }
      case "F2": e.preventDefault(); if (k.startsWith("dir:")) void this.renameFolderDlg(k.slice(4)); else void this.panel.renameDlg(k); break;
      case "Escape": if (this.sel.size || this.dirSel) { e.preventDefault(); this.sel.clear(); this.dirSel = null; this.selectionChanged(); } break;
      case "a": case "A":
        if (ctrl) { e.preventDefault(); this.sel = new Set(this.listedFiles().map(f => f.id)); this.dirSel = null; this.selectionChanged(); }
        break;
      case "ContextMenu": case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        this.rowMenuAt(k, r.left + 40, r.bottom - 4, row);
        break;
      }
    }
  }
}
