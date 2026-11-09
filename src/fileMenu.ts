// File menu (FR-UI-010, SolidWorks' File menu): New, Open, Close, Save / Save as / Save all, Pack and Go,
// Export, Print, Properties, the recent documents and Exit, with their shortcuts. The header's File button
// and the drawing workspace's File button open the same menu; main.ts supplies the actions (`FileHost`).
import { t } from "./i18n";
import { toast, trapFocus } from "./ui";
import { zip } from "./model/zip";
import { recentClear, recentFiles, recentList, type RecentEntry } from "./recent";

export type LiveKind = "part" | "asm" | "drawing" | "model" | "pcb" | null;

/** One open document for Pack and Go. */
export interface PackDoc {
  label: string;
  kind: "part" | "asm" | "drawing" | "model";
  live: boolean;
  /** The document as saved. */
  files(): Promise<{ name: string; data: Uint8Array }[]>;
  /** An assembly's parts (and sub-assemblies) as separate files. */
  parts?(): Promise<{ name: string; data: Uint8Array }[]>;
}

export interface FileHost {
  /** What is shown now. */
  live(): LiveKind;
  /** Documents open in tabs. */
  docCount(): number;
  /** Changed documents. */
  dirtyCount(): number;
  open(): void;
  openFiles(files: File[]): void;
  newPart(): void;
  newAsm(): void;
  newDrawing(): void;
  /** Make assembly from part; absent when no part is open. */
  asmFromPart: (() => void) | null;
  close(): Promise<void>;
  /** Closes every document; false when the user kept one. */
  closeAll(): Promise<boolean>;
  save(as: boolean): Promise<void> | void;
  saveAll(): Promise<void>;
  packDocs(): PackDoc[];
  download(blob: Blob, name: string): void;
  exportDoc(): void;
  print(): void;
  properties(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Shortcut text: ⌘ on macOS. */
const key = (k: string) => (mac ? k.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : k);

interface Item { id: string; label: string; key?: string; on: boolean; hidden?: boolean; title?: string }

export class FileMenu {
  readonly el: HTMLElement;
  private opener: HTMLElement | null = null;
  private recent: RecentEntry[] = [];

  constructor(private host: FileHost) {
    const el = document.createElement("div");
    el.id = "file-menu";
    el.className = "mc-menu file-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", t("File"));
    el.hidden = true;
    document.body.appendChild(el);
    this.el = el;
    el.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-f]");
      if (!b || b.disabled) return;
      this.shut(false);
      void this.run(b.dataset.f!);
    });
    el.addEventListener("keydown", e => this.menuKey(e));
    document.addEventListener("pointerdown", e => {
      if (!el.hidden && !el.contains(e.target as Node) && !this.opener?.contains(e.target as Node)) this.shut(false);
    }, true);
    window.addEventListener("resize", () => this.shut(false));
    // Shortcuts before any other key handler, so Ctrl+Alt+S is Save all and not Save, and Ctrl+P prints the
    // document rather than the page.
    window.addEventListener("keydown", e => this.shortcut(e), true);
  }

  get open() { return !this.el.hidden; }

  /** Opens the menu under a button (or closes it when it is open from that button). */
  toggle(btn: HTMLElement) {
    if (this.open && this.opener === btn) { this.shut(true); return; }
    void this.show(btn);
  }

  private items(): (Item | "-")[] {
    const h = this.host, k = h.live(), doc = k === "part" || k === "asm" || k === "drawing" || k === "model";
    return [
      { id: "new-part", label: t("New part"), key: "Ctrl+Alt+N", on: true },
      { id: "new-asm", label: t("New assembly"), on: true },
      { id: "new-drawing", label: t("New drawing"), on: doc && k !== "drawing", title: t("Drawing: sheets with views of the open model") },
      { id: "asm-part", label: t("Make assembly from part"), on: true, hidden: !h.asmFromPart },
      "-",
      { id: "open", label: t("Open…"), key: "Ctrl+O", on: true },
      { id: "close", label: t("Close"), key: "Ctrl+Alt+W", on: h.docCount() > 0 },
      { id: "close-all", label: t("Close all"), on: h.docCount() > 0 },
      "-",
      { id: "save", label: t("Save"), key: "Ctrl+S", on: k === "part" || k === "asm" || k === "drawing" },
      { id: "save-as", label: t("Save as…"), key: "Ctrl+Shift+S", on: doc, title: k === "model" ? t("Save a copy of the model file") : undefined },
      { id: "save-all", label: t("Save all"), key: "Ctrl+Alt+S", on: h.dirtyCount() > 0 },
      "-",
      { id: "pack", label: t("Pack and Go…"), on: h.docCount() > 0, title: t("All open documents, and an assembly's parts, in one .zip") },
      { id: "export", label: t("Export…"), on: doc, title: t("PNG, STEP, STL, OBJ, glTF, 3MF, PDF report; for a drawing PDF, SVG, DXF, PNG") },
      { id: "print", label: t("Print…"), key: "Ctrl+P", on: doc },
      "-",
      { id: "props", label: t("Properties…"), on: doc, title: t("Title, part number, material and other properties of the document") },
    ];
  }

  private async show(btn: HTMLElement) {
    this.opener = btn;
    this.recent = await recentList();
    const row = (it: Item) => it.hidden ? "" : `<button role="menuitem" data-f="${it.id}"${it.on ? "" : " disabled"}${it.title ? ` title="${esc(it.title)}"` : ""}><span class="fm-l">${esc(it.label)}</span>${it.key ? `<kbd class="fm-k" translate="no">${esc(key(it.key))}</kbd>` : ""}</button>`;
    const recent = this.recent.length
      ? `<hr />${this.recent.map((r, i) => `<button role="menuitem" data-f="recent:${i}" title="${esc(`${r.name}${r.count > 1 ? ` (+${r.count - 1})` : ""} · ${new Date(r.at).toLocaleString()}`)}"><span class="fm-l"><span class="fm-n">${i + 1}</span> <span translate="no">${esc(r.name)}</span>${r.count > 1 ? ` <span class="muted">+${r.count - 1}</span>` : ""}</span></button>`).join("")}<button role="menuitem" data-f="recent-clear"><span class="fm-l">${esc(t("Clear recent documents"))}</span></button>`
      : "";
    this.el.innerHTML = this.items().map(it => (it === "-" ? "<hr />" : row(it))).join("")
      + recent + `<hr />${row({ id: "exit", label: t("Exit"), on: true, title: t("Close every document; an installed app window closes too") })}`;
    this.el.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect(), w = this.el.offsetWidth, hgt = this.el.offsetHeight;
    this.el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - hgt - 4))}px`;
    this.buttons()[0]?.focus();
  }

  private shut(focus: boolean) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.opener?.setAttribute("aria-expanded", "false");
    if (focus) this.opener?.focus();
  }

  private buttons() { return [...this.el.querySelectorAll<HTMLButtonElement>("button[data-f]:not([disabled])")]; }

  private menuKey(e: KeyboardEvent) {
    const bs = this.buttons(), i = bs.indexOf(document.activeElement as HTMLButtonElement);
    let j = -1;
    if (e.key === "ArrowDown") j = (i + 1) % bs.length;
    else if (e.key === "ArrowUp") j = (i - 1 + bs.length) % bs.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = bs.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.shut(true); return; }
    else if (e.key === "Tab") { this.shut(false); return; }
    else if (/^[1-9]$/.test(e.key)) { const b = this.el.querySelector<HTMLButtonElement>(`[data-f="recent:${+e.key - 1}"]`); if (b) { e.preventDefault(); b.click(); } return; }
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    bs[j].focus();
  }

  /** The shortcuts (also work with the menu shut). */
  private shortcut(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tg = e.target as HTMLElement;
    if (tg.closest?.("dialog[open]")) return;
    const k = e.key.toLowerCase();
    let id = "";
    if (e.altKey && !e.shiftKey && (k === "n" || e.code === "KeyN")) id = "new-part";
    else if (e.altKey && !e.shiftKey && (k === "w" || e.code === "KeyW")) id = "close";
    else if (e.altKey && !e.shiftKey && (k === "s" || e.code === "KeyS")) id = "save-all";
    else if (!e.altKey && !e.shiftKey && k === "o") id = "open";
    else if (!e.altKey && !e.shiftKey && k === "p") id = "print";
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const it = this.items().find((x): x is Item => x !== "-" && x.id === id);
    if (!it?.on) return;
    this.shut(false);
    void this.run(id);
  }

  async run(id: string) {
    const h = this.host;
    if (id.startsWith("recent:")) {
      const fs = await recentFiles(+id.slice(7));
      if (fs) h.openFiles(fs); else toast(t("That document is no longer in the recent list."), true);
      return;
    }
    switch (id) {
      case "new-part": h.newPart(); break;
      case "new-asm": h.newAsm(); break;
      case "new-drawing": h.newDrawing(); break;
      case "asm-part": h.asmFromPart?.(); break;
      case "open": h.open(); break;
      case "close": await h.close(); break;
      case "close-all": await h.closeAll(); break;
      case "save": await h.save(false); break;
      case "save-as": await h.save(true); break;
      case "save-all": await h.saveAll(); break;
      case "pack": this.packAndGo(); break;
      case "export": h.exportDoc(); break;
      case "print": h.print(); break;
      case "props": h.properties(); break;
      case "recent-clear": await recentClear(); toast(t("Recent documents cleared")); break;
      case "exit": {
        if (!(await h.closeAll())) return;
        window.close();
        // A browser tab that the page did not open stays: say so.
        setTimeout(() => { if (!window.closed) toast(t("All documents are closed. Close the browser tab to leave MöbiusCAD.")); }, 200);
        break;
      }
    }
  }

  /** Pack and Go (SolidWorks): the open documents, and an assembly's parts as separate files, in one .zip. */
  packAndGo() {
    const docs = this.host.packDocs();
    if (!docs.length) { toast(t("Open a document first.")); return; }
    let d = document.getElementById("pack-dlg") as HTMLDialogElement | null;
    if (!d) {
      d = document.createElement("dialog");
      d.id = "pack-dlg";
      d.className = "modal v-dlg";
      d.setAttribute("aria-labelledby", "pack-title");
      document.body.appendChild(d);
      trapFocus(d, () => d!.open);
    }
    const dlg = d;
    const live = docs.find(x => x.live) ?? docs[0];
    const base = live.label.replace(/\s*•$/, "").replace(/\.[^.]+$/, "") || "documents";
    const anyAsm = docs.some(x => x.parts);
    dlg.innerHTML = `<h3 id="pack-title">${esc(t("Pack and Go"))}</h3>`
      + `<p class="muted">${esc(t("Saves the chosen documents into one .zip, with everything they need to open elsewhere."))}</p>`
      + `<fieldset class="pack-list"><legend>${esc(t("Documents"))}</legend>${docs.map((x, i) => `<label class="chk"><input type="checkbox" data-pk="${i}"${x.live || docs.length === 1 ? " checked" : ""} /> <span translate="no">${esc(x.label.replace(/\s*•$/, ""))}</span></label>`).join("")}</fieldset>`
      + (anyAsm ? `<label class="chk"><input type="checkbox" data-pk="parts" checked /> ${esc(t("Also save each assembly's parts as separate files"))}</label>` : "")
      + `<label class="pm-field"><span>${esc(t("Zip file name"))}</span><input type="text" data-pk="name" value="${esc(base)}.zip" spellcheck="false" translate="no" /></label>`
      + `<div class="row end"><button class="btn" data-a="cancel">${esc(t("Cancel"))}</button><button class="btn primary" data-a="ok">${esc(t("Save"))}</button></div>`;
    dlg.querySelector("[data-a=cancel]")!.addEventListener("click", () => dlg.close());
    dlg.querySelector<HTMLButtonElement>("[data-a=ok]")!.addEventListener("click", async e => {
      const btn = e.currentTarget as HTMLButtonElement;
      const picked = docs.filter((_, i) => dlg.querySelector<HTMLInputElement>(`[data-pk="${i}"]`)?.checked);
      if (!picked.length) { toast(t("Choose at least one document."), true); return; }
      const parts = !!dlg.querySelector<HTMLInputElement>('[data-pk="parts"]')?.checked;
      let name = dlg.querySelector<HTMLInputElement>('[data-pk="name"]')!.value.trim() || `${base}.zip`;
      if (!/\.zip$/i.test(name)) name += ".zip";
      btn.disabled = true;
      try {
        const out: { name: string; data: Uint8Array }[] = [], used = new Set<string>();
        const add = (f: { name: string; data: Uint8Array }, dir = "") => {
          let n = dir + f.name.replace(/[\\/:*?"<>|]/g, "_");
          for (let k = 2; used.has(n.toLowerCase()); k++) n = dir + f.name.replace(/(\.[^.]+)?$/, ` (${k})$1`);
          used.add(n.toLowerCase());
          out.push({ name: n, data: f.data });
        };
        for (const x of picked) {
          for (const f of await x.files()) add(f);
          if (parts && x.parts) for (const f of await x.parts()) add(f, "parts/");
        }
        this.host.download(new Blob([await zip(out) as BlobPart], { type: "application/zip" }), name);
        dlg.close();
        toast(t("Packed {n} file into {name}|Packed {n} files into {name}", { n: out.length, name }), "success");
      } catch (err) {
        toast(t("Pack and Go failed: {err}", { err: (err as Error).message }), true);
      } finally { btn.disabled = false; }
    });
    if (!dlg.open) dlg.showModal();
    dlg.querySelector<HTMLButtonElement>("[data-a=ok]")!.focus();
  }
}
