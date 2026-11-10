// The Vault menu (FR-PDM-002/080): the header's Vault button. With no vault open it creates or opens one, in
// a folder on disk or in the browser; with a vault open it has the commands for the document on screen
// (Save to vault, Check out, Check in, History…) and the vault itself. The Vault tab stays the file list.
import { t } from "../i18n";
import { vaultFolders } from "./folders";
import type { VaultPanel } from "./panel";

export interface VaultMenuHost {
  panel: VaultPanel;
  /** Shows the vault's file list (the Vault tab, or a window when the side panel is not on screen). */
  showPanel(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface Item { id: string; label: string; on?: boolean; title?: string; name?: boolean }

export class VaultMenu {
  readonly el: HTMLElement;
  private opener: HTMLElement | null = null;

  constructor(private host: VaultMenuHost) {
    const el = document.createElement("div");
    el.id = "vault-menu";
    el.className = "mc-menu file-menu vault-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", t("Vault"));
    el.hidden = true;
    document.body.appendChild(el);
    this.el = el;
    el.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
      if (!b || b.disabled) return;
      this.shut(false);
      void this.run(b.dataset.v!);
    });
    el.addEventListener("keydown", e => this.menuKey(e));
    document.addEventListener("pointerdown", e => {
      if (!el.hidden && !el.contains(e.target as Node) && !this.opener?.contains(e.target as Node)) this.shut(false);
    }, true);
    window.addEventListener("resize", () => this.shut(false));
  }

  get open() { return !this.el.hidden; }

  /** Opens the menu under a button (or closes it when it is open from that button). */
  toggle(btn: HTMLElement) {
    if (this.open && this.opener === btn) { this.shut(true); return; }
    void this.show(btn);
  }

  private async items(): Promise<(Item | "-" | { head: string; name?: string })[]> {
    const p = this.host.panel, v = p.vault;
    if (!v) {
      const fsa = p.foldersOk, why = fsa ? undefined : t("A vault in a folder needs Chrome or Edge on a computer. In this browser, use a browser vault and Export ZIP for backups.");
      const folders = fsa ? await vaultFolders() : [];
      const names = await p.browserVaults();
      return [
        { head: t("Vault in a folder on this computer") },
        { id: "new-dir", label: t("New vault in a folder…"), on: fsa, title: why ?? t("Pick a folder: the vault's files and all their versions are kept there") },
        { id: "open-dir", label: t("Open vault folder…"), on: fsa, title: why },
        ...folders.map((f): Item => ({ id: `folder:${f.key}`, label: f.name, name: true, title: t("Open the vault in this folder") })),
        "-",
        { head: t("Vaults in this browser") },
        ...names.map((n): Item => ({ id: `ws:${n}`, label: n, name: true })),
        { id: "new-ws", label: t("New browser vault…"), title: t("Kept in this browser's own storage; Export ZIP makes a backup") },
        "-",
        { id: "panel", label: t("Vault panel") },
      ];
    }
    const doc = p.docName, st = p.openFileState;
    return [
      { head: t("Vault"), name: v.info.name },
      { id: "save", label: t("Save to vault"), on: !!doc && !st, title: t("The open part, assembly or drawing becomes a vault file, checked out to you") },
      { id: "co", label: t("Check out"), on: !!st?.canCheckOut, title: st ? undefined : t("For the open document, once it is in the vault") },
      { id: "ci", label: t("Check in…"), on: !!st?.mine, title: t("Stores the open document as the next version, with a comment") },
      { id: "undo", label: t("Undo check-out"), on: !!st?.mine },
      { id: "latest", label: t("Get latest"), on: !!st },
      { id: "hist", label: t("History…"), on: !!st, title: t("Every version: open an older one, compare or roll back") },
      "-",
      { id: "add", label: t("Add files…") },
      { id: "search", label: t("Search the vault…") },
      { id: "panel", label: t("Vault files") },
      { id: "settings", label: t("Vault settings") },
      "-",
      { id: "close", label: t("Close vault") },
    ];
  }

  private async show(btn: HTMLElement) {
    this.opener = btn;
    const items = await this.items();
    this.el.innerHTML = items.map(it => {
      if (it === "-") return "<hr />";
      if ("head" in it) return `<div class="vm-h">${esc(it.head)}${it.name ? `: <b translate="no">${esc(it.name)}</b>` : ""}</div>`;
      return `<button role="menuitem" data-v="${esc(it.id)}"${it.on === false ? " disabled" : ""}${it.title ? ` title="${esc(it.title)}"` : ""}><span class="fm-l"${it.name ? ' translate="no"' : ""}>${esc(it.label)}</span></button>`;
    }).join("");
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

  private buttons() { return [...this.el.querySelectorAll<HTMLButtonElement>("button[data-v]:not([disabled])")]; }

  private menuKey(e: KeyboardEvent) {
    const bs = this.buttons(), i = bs.indexOf(document.activeElement as HTMLButtonElement);
    let j = -1;
    if (e.key === "ArrowDown") j = (i + 1) % bs.length;
    else if (e.key === "ArrowUp") j = (i - 1 + bs.length) % bs.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = bs.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.shut(true); return; }
    else if (e.key === "Tab") { this.shut(false); return; }
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    bs[j].focus();
  }

  async run(id: string) {
    const p = this.host.panel, open = p.openId;
    if (id.startsWith("folder:")) { await p.openFolder(id.slice(7)); if (p.vault) this.host.showPanel(); return; }
    if (id.startsWith("ws:")) { await p.openInBrowser(id.slice(3)); if (p.vault) this.host.showPanel(); return; }
    switch (id) {
      case "new-dir": case "open-dir": await p.pickFolder(id === "new-dir"); if (p.vault) this.host.showPanel(); break;
      case "new-ws": this.host.showPanel(); await p.render(); p.focusName(); break;
      case "panel": this.host.showPanel(); break;
      case "save": await p.saveOpenDoc(); break;
      case "co": if (open) await p.checkOut(open); break;
      case "ci": if (open) await p.checkIn(open); break;
      case "undo": if (open) await p.undoCheckOut(open); break;
      case "latest": if (open) await p.getLatest(open); break;
      case "hist": if (open) await p.history(open); break;
      case "add": this.host.showPanel(); await p.render(); p.pickFiles(); break;
      case "search": await p.searchDlg(); this.host.showPanel(); break;
      case "settings": await p.settingsDlg(); break;
      case "close": p.close(); break;
    }
  }
}
