// Document tabs (FRS 7, FR-DOC-003, FR-UI-120): every open part, assembly, drawing and model file gets a tab
// at the bottom of the window, as in SolidWorks. Only one document is live at a time; the others are parked
// with their undo history (`park`) and come back on a click (`resume`). A drawing is shown over the 3D view,
// so while a drawing tab is active the 3D document under it stays live (`under`).
import { t } from "./i18n";
import { confirmModal } from "./ui";

export type DocKind = "part" | "asm" | "drawing" | "model";

export interface DocTab {
  id: string;
  kind: DocKind;
  label: string;
  /** What `park` returned while the tab is not shown; null while it is live. */
  state: unknown;
  /** The camera of a parked 3D document (FR-DOC-003), put back when it is shown again. */
  view?: unknown;
}

export interface DocsHost {
  /** Keeps the live document of this kind and closes it; null when there is nothing to keep. */
  park(kind: DocKind): unknown;
  /** The 3D view's camera, kept with a parked 3D document. */
  view?(): unknown;
  /** Shows a parked document again. */
  resume(tab: DocTab): Promise<void> | void;
  /** Closes the live document of this kind for good. */
  close(kind: DocKind): void;
  /** The live document's label (file name, • when changed), or null to keep the tab's own. */
  label(kind: DocKind): string | null;
  /** Unsaved changes in a tab (live or parked). */
  dirty(tab: DocTab): boolean;
  /** A tab closed without saving (drop its recovery copy). */
  forget?(tab: DocTab): void;
}

const ICON: Record<DocKind, string> = {
  part: '<path d="M8 2l5 3v6l-5 3-5-3V5z M8 8l5-3 M8 8v6 M8 8L3 5"/>',
  asm: '<path d="M2 5l4-2 4 2v4l-4 2-4-2z M10 7l4 2v4l-4 2-4-2v-2"/>',
  drawing: '<path d="M3 2h7l3 3v9H3z M10 2v3h3 M5 9h6 M5 11.5h4"/>',
  model: '<path d="M2 4h12v9H2z M2 7h12 M6 7v6"/>',
};
const KIND: Record<DocKind, string> = { part: "Part", asm: "Assembly", drawing: "Drawing", model: "Model" };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class DocTabs {
  tabs: DocTab[] = [];
  /** The tab shown. */
  active: DocTab | null = null;
  /** The live 3D document while a drawing tab is shown over it. */
  under: DocTab | null = null;
  private busy = false;
  private parking = false;
  /** Edit part in place: the part replaces the assembly in the same tab (and back). */
  private inPlace = false;
  private seq = 0;

  constructor(private host: DocsHost, private el: HTMLElement) {
    el.addEventListener("click", e => {
      const x = (e.target as HTMLElement).closest<HTMLElement>("[data-dtx]");
      if (x) { e.stopPropagation(); void this.close(x.dataset.dtx!); return; }
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dt]");
      if (b) void this.activate(b.dataset.dt!);
    });
    el.addEventListener("auxclick", e => {
      // Middle click closes a tab, as in browsers.
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dt]");
      if (b && e.button === 1) { e.preventDefault(); void this.close(b.dataset.dt!); }
    });
    el.addEventListener("keydown", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dt]");
      if (!b) return;
      const i = this.tabs.findIndex(x => x.id === b.dataset.dt);
      if (e.key === "Delete") { e.preventDefault(); void this.close(b.dataset.dt!); return; }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      e.stopPropagation();
      const n = this.tabs.length;
      const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
      this.el.querySelector<HTMLElement>(`[data-dt="${this.tabs[j].id}"]`)?.focus();
    });
  }

  /** Tabs with unsaved changes (File ▸ Save all). */
  dirtyTabs() { return this.tabs.filter(x => this.host.dirty(x)); }

  /** The live 3D document's tab (the active one, or the one under a drawing). */
  private get live3d() { return this.active?.kind === "drawing" ? this.under : this.active; }

  /** Runs an edit-in-place switch: the new document takes over the active tab instead of opening its own. */
  inPlaceSwitch(fn: () => void) {
    this.inPlace = true;
    try { fn(); } finally { this.inPlace = false; }
  }

  /** A 3D document (part, assembly or model) is about to open: the one shown now is parked in its tab. */
  before3d() {
    if (this.busy || this.inPlace) return;
    if (this.active?.kind === "drawing") this.parkTab(this.active);
    if (this.under) { this.parkTab(this.under); this.under = null; }
    else if (this.active && this.active.kind !== "drawing") this.parkTab(this.active);
    this.active = null;
  }

  /** A drawing is about to open: a drawing shown now is parked; a 3D document shown now stays live under it. */
  beforeDrawing() {
    if (this.busy) return;
    if (this.active?.kind === "drawing") { this.parkTab(this.active); this.active = this.under; }
    if (this.active && this.active.kind !== "drawing") this.under = this.active;
  }

  /** A document was opened or made. */
  opened(kind: DocKind, label: string) {
    if (this.busy) { this.render(); return; }
    if (this.inPlace && this.active) { this.active.kind = kind; this.active.label = label; this.render(); return; }
    const tab: DocTab = { id: `d${++this.seq}`, kind, label, state: null };
    const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    this.active = tab;
    if (kind !== "drawing") this.under = null;
    this.render();
  }

  /** The drawing workspace was closed with its own Back button: the 3D document under it is the active tab again. */
  drawingHidden() {
    if (this.busy || this.parking || this.active?.kind !== "drawing") return;
    this.parkTab(this.active);
    this.active = this.under;
    this.under = null;
    this.render();
  }

  /** A document closed by itself (a PCB or a file replaced it without a tab): its tab goes. */
  closed(kind: DocKind) {
    if (this.busy) return;
    const tab = kind === "drawing" ? (this.active?.kind === "drawing" ? this.active : null) : this.live3d;
    if (!tab || tab.kind !== kind) return;
    this.tabs = this.tabs.filter(x => x !== tab);
    if (tab === this.under) this.under = null;
    if (tab === this.active) this.active = kind === "drawing" ? this.under : null;
    this.render();
  }

  private parkTab(tab: DocTab) {
    this.parking = true;
    if (tab.kind !== "drawing") tab.view = this.host.view?.();
    try { tab.state = this.host.park(tab.kind); } finally { this.parking = false; }
    if (tab.state == null) this.tabs = this.tabs.filter(x => x !== tab);
  }

  async activate(id: string) {
    const tab = this.tabs.find(x => x.id === id);
    if (!tab || tab === this.active || this.busy) return;
    this.busy = true;
    try {
      if (tab.kind === "drawing") {
        if (this.active?.kind === "drawing") this.parkTab(this.active);
        else if (this.active) this.under = this.active;
        this.active = tab;
        await this.host.resume(tab);
      } else {
        if (this.active?.kind === "drawing") { this.parkTab(this.active); this.active = this.under; this.under = null; }
        if (this.active !== tab) {
          if (this.active) this.parkTab(this.active);
          this.active = tab;
          await this.host.resume(tab);
        }
      }
      tab.state = null;
    } finally {
      this.busy = false;
      this.render();
    }
    this.el.querySelector<HTMLElement>(`[data-dt="${tab.id}"]`)?.focus();
  }

  async close(id: string) {
    const tab = this.tabs.find(x => x.id === id);
    if (!tab || this.busy) return;
    if (this.host.dirty(tab) && !(await confirmModal(t("{name} has unsaved changes. Close it anyway?", { name: tab.label.replace(/\s*•$/, "") }), t("Close"), t("Close document")))) return;
    const i = this.tabs.indexOf(tab);
    this.busy = true;
    try {
      this.host.forget?.(tab);
      if (tab === this.active || tab === this.under) this.host.close(tab.kind);
      this.tabs.splice(i, 1);
      if (tab === this.under) this.under = null;
      if (tab === this.active) {
        // A drawing shows the 3D document under it again; otherwise the neighbour tab opens.
        this.active = tab.kind === "drawing" ? this.under : null;
        if (tab.kind === "drawing") this.under = null;
      }
    } finally { this.busy = false; }
    if (!this.active && this.tabs.length) await this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    this.render();
  }

  render() {
    for (const k of ["part", "asm", "drawing", "model"] as DocKind[]) {
      const tab = k === "drawing" ? (this.active?.kind === "drawing" ? this.active : null) : this.live3d?.kind === k ? this.live3d : null;
      const l = tab ? this.host.label(k) : null;
      if (tab && l) tab.label = l;
    }
    this.el.hidden = !this.tabs.length;
    document.getElementById("app")?.classList.toggle("has-doc-tabs", !!this.tabs.length);
    this.el.innerHTML = this.tabs.map(tab => {
      const on = tab === this.active;
      const name = tab.label.replace(/\s*•$/, "");
      const dirty = this.host.dirty(tab);
      return `<div class="dt${on ? " on" : ""}${tab === this.under ? " under" : ""}">`
        + `<button type="button" class="dt-b" data-dt="${tab.id}"${on ? ' aria-current="page"' : ""} title="${esc(`${t(KIND[tab.kind])}: ${name}`)}">`
        + `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">${ICON[tab.kind]}</svg>`
        + `<span class="dt-l" translate="no">${esc(name)}</span>${dirty ? '<span class="dt-dirty" aria-hidden="true">•</span>' : ""}</button>`
        + `<button type="button" class="dt-x" data-dtx="${tab.id}" aria-label="${esc(t("Close {name}", { name }))}" title="${esc(t("Close {name}", { name }))}">×</button></div>`;
    }).join("");
  }
}
