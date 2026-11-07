// Drawing workspace (FRS section 11): a full-window sheet editor over the 3D view.
// Views are placed like in SolidWorks: a model view follows the cursor with its
// lines as a live preview, then projected views come off it as the cursor moves
// around (Esc or ✓ ends); views drag on the sheet and projected ones stay lined up
// with their parent. Lines come from the drawing worker (exact HLR).
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import type { Projection, ViewDir } from "../kernel/drawing";
import type { PartDoc } from "../model/types";
import { t, onLangChange } from "../i18n";
import { toast, confirmModal } from "../ui";
import { DrawingKernel, type ModelFacts } from "./client";
import { composeSheet, placement, viewPrims, viewRect, type Placement } from "./compose";
import { DrawingStore, newSheet, uid } from "./doc";
import { DRAWING_EXT, packDrawing, unpackDrawing } from "./file";
import { sheetDxf, sheetSvg, sheetsPdf, svgBody, FONT } from "./output";
import type { Prim } from "./prims";
import { EDITABLE, FIELD_LABEL, SIZES, fieldAt, formatPrims, frameOf, sheetSize, TB_H, type Fields } from "./sheet";
import type { DisplayStyle, DrawingDoc, DrawingProps, DrawingView, Orient, Sheet, SheetSize, TangentEdges } from "./types";
import { ORIENTS, ORIENT_NAMES, SCALES, alignAxis, dirKey, findView, fitScale, parseScale, projectedDir, scaleText, sideOf, viewDir, viewScalePair } from "./views";
import "./drawing.css";

export interface DrawingModel {
  name: string;
  part?: PartDoc;
  file?: { name: string; bytes: Uint8Array };
  /** Title block facts from the model. */
  info: { title?: string; number?: string; revision?: string; author?: string; material?: string; density?: number };
}

export interface DrawingHost {
  appVersion: string;
  occtBase: string;
  /** The model open now (a part, or the STEP of the open file), or null. */
  currentModel(): Promise<DrawingModel | null>;
  /** The part document with this id open in the modeller now, if any. */
  livePart(id: string): PartDoc | null;
  /** Runs after every change of the part open in the modeller. */
  onPartChange(fn: () => void): void;
  /** Direction of the 3D camera (for "Current 3D view"). */
  currentView(): ViewDir | null;
  download(blob: Blob, name: string): void;
  /** Called when the workspace opens or closes (the 3D view's keys and header step aside). */
  onToggle?(open: boolean): void;
}

type Mode =
  | { kind: "none" }
  /** A model view follows the cursor. */
  | { kind: "model"; orient: Orient; dir: ViewDir; at: [number, number] | null }
  /** Projected views come off `parent`. */
  | { kind: "projected"; parent: string | null; at: [number, number] | null };

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const SVGNS = "http://www.w3.org/2000/svg";
const SIZE_LIST = Object.keys(SIZES) as Exclude<SheetSize, "custom">[];
const I = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  std3: I('<rect x="1.5" y="1.5" width="6" height="5"/><rect x="1.5" y="9.5" width="6" height="5"/><rect x="9.5" y="1.5" width="5" height="5"/>'),
  model: I('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M8 8v6.2M8 8l5.5-3M8 8 2.5 5"/>'),
  proj: I('<rect x="1.5" y="5" width="6" height="6"/><rect x="10" y="5" width="4.5" height="6" stroke-dasharray="1.6 1.2"/><path d="M7.5 8h2.5"/>'),
  undo: I('<path d="M5 3 2 6l3 3"/><path d="M2 6h7a4.5 4.5 0 0 1 0 9H6"/>'),
  redo: I('<path d="m11 3 3 3-3 3"/><path d="M14 6H7a4.5 4.5 0 0 0 0 9h3"/>'),
  save: I('<path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v4h6v-4M5 13.5v-4h6v4"/>'),
  exp: I('<path d="M8 10V2M5 5l3-3 3 3M3 9.5v4h10v-4"/>'),
  fit: I('<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>'),
  back: I('<path d="M10 3 5 8l5 5"/>'),
  hlv: I('<rect x="2.5" y="2.5" width="11" height="11"/><path d="M6 2.5v11" stroke-dasharray="1.6 1.2"/>'),
  hlr: I('<rect x="2.5" y="2.5" width="11" height="11"/>'),
  wire: I('<rect x="2.5" y="2.5" width="11" height="11"/><path d="M6 2.5v11"/>'),
  ok: I('<path d="m3 8.5 3.2 3L13 4.5"/>'),
};

export class DrawingWorkspace {
  readonly el: HTMLElement;
  private svg!: SVGSVGElement;
  private kernel: DrawingKernel;
  private store: DrawingStore | null = null;
  private facts: ModelFacts | null = null;
  private model: Uint8Array | undefined;
  private fileName = "";
  private sheetIdx = 0;
  private sel: string | null = null;
  private hover: string | null = null;
  private mode: Mode = { kind: "none" };
  private vb = { x: 0, y: 0, w: 420, h: 297 };
  private placements = new Map<string, Placement>();
  private drag: { id: string; start: [number, number]; orig: Map<string, [number, number]>; moved: boolean } | null = null;
  private pan: { x: number; y: number; vb: { x: number; y: number; w: number; h: number } } | null = null;
  private loading = 0;
  private stale = false;
  private updateTimer = 0;
  private fontReady: Promise<void> | null = null;

  constructor(private host: DrawingHost) {
    this.kernel = new DrawingKernel(host.occtBase);
    this.el = document.createElement("div");
    this.el.id = "drw";
    this.el.className = "drw";
    this.el.hidden = true;
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Drawing");
    document.getElementById("app")!.appendChild(this.el);
    host.onPartChange(() => this.partChanged());
    onLangChange(() => { if (this.store) this.renderAll(); });
    window.addEventListener("keydown", e => this.onKey(e), true);
  }

  /** Which model the drawing was made from (set by the app: part id or file key). */
  modelKey = "";

  get open() { return !this.el.hidden; }
  get hasDrawing() { return !!this.store; }
  private get doc() { return this.store!.doc; }
  private get sheet() { return this.doc.sheets[Math.min(this.sheetIdx, this.doc.sheets.length - 1)]; }

  // ---------- opening ----------

  /** A new drawing of the model open now, with the standard 3 views. */
  async newFromModel() {
    const m = await this.host.currentModel();
    if (!m) { toast(t("Open a part or a STEP, IGES or BREP model first."), true); return; }
    const today = new Date().toISOString().slice(0, 10);
    const doc: DrawingDoc = {
      schema: 1, kind: "drawing", id: uid("dr_"), name: m.name.replace(/\.[^.]+$/, ""),
      sheets: [newSheet(1)], props: { date: today },
      source: m.part ? { kind: "part", doc: m.part, name: m.name } : { kind: "file", name: m.file!.name },
    };
    this.info = m.info;
    this.load(doc, m.file?.bytes, "");
    const facts = await this.loadModel();
    if (facts) this.standard3(true);
  }

  async openFile(file: File | { name: string; data: ArrayBuffer }) {
    const buf = file instanceof File ? await file.arrayBuffer() : file.data;
    try {
      const { doc, model } = await unpackDrawing(buf);
      this.info = {};
      if (doc.source.kind === "part") this.info = partInfo(doc.source.doc);
      this.load(doc, model, file.name);
      await this.loadModel();
    } catch (err) { toast(t("Could not open {name}: {err}", { name: file.name, err: t((err as Error).message) }), true); }
  }

  private info: DrawingModel["info"] = {};

  private load(doc: DrawingDoc, model: Uint8Array | undefined, fileName: string) {
    this.store = new DrawingStore(doc);
    this.store.onChange(() => this.renderAll());
    this.model = model;
    this.fileName = fileName;
    this.sheetIdx = 0;
    this.sel = null;
    this.mode = { kind: "none" };
    this.facts = null;
    this.show();
    this.build();
    this.fit();
  }

  /** (Re)loads the model into the worker from the drawing's source; the views then fill in. */
  private async loadModel(): Promise<ModelFacts | null> {
    const src = this.doc.source;
    this.loading++;
    this.renderStatus();
    try {
      this.facts = await this.kernel.load(src.kind === "part" ? { part: src.doc } : { file: { name: src.name, bytes: this.model! } });
      this.stale = false;
      this.renderAll();
      return this.facts;
    } catch (err) {
      toast(t("The drawing's model could not be loaded: {err}", { err: t((err as Error).message) }), true);
      return null;
    } finally { this.loading--; this.renderStatus(); }
  }

  show() {
    if (!this.store) return;
    this.el.hidden = false;
    document.getElementById("app")!.classList.add("drawing");
    this.host.onToggle?.(true);
    this.fontReady ??= (async () => {
      try { const f = new FontFace("DejaVu Sans", `url(${fontUrl})`); await f.load(); document.fonts.add(f); } catch { /* system font */ }
    })();
    this.partChanged();
    requestAnimationFrame(() => this.svg?.focus({ preventScroll: true }));
  }

  hide() {
    this.cancelMode();
    this.el.hidden = true;
    document.getElementById("app")!.classList.remove("drawing");
    this.host.onToggle?.(false);
  }

  /** The modelled part changed: an associative drawing of it updates (FR-DRW-016). */
  private partChanged() {
    if (!this.store || this.doc.source.kind !== "part") return;
    const live = this.host.livePart(this.doc.source.doc.id);
    if (!live || JSON.stringify(live) === JSON.stringify(this.doc.source.doc)) return;
    this.stale = true;
    this.renderStatus();
    if (!this.open) return;
    clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => void this.updateFromModel(), 300);
  }

  async updateFromModel() {
    if (!this.store || this.doc.source.kind !== "part") return;
    const live = this.host.livePart(this.doc.source.doc.id);
    if (live) {
      this.store.change("Update from model", d => { if (d.source.kind === "part") d.source.doc = JSON.parse(JSON.stringify(live)); });
      this.info = partInfo(live);
    }
    await this.loadModel();
  }

  // ---------- layout ----------

  private build() {
    this.el.innerHTML = `
      <div class="drw-top">
        <button class="btn small" data-a="back" title="${esc(t("Back to the 3D model"))}">${ICON.back}<span>${esc(t("Model"))}</span></button>
        <span class="drw-name" translate="no"></span>
        <div class="drw-cmds" role="toolbar" aria-label="${esc(t("Drawing commands"))}">
          <button class="btn small" data-a="std3" title="${esc(t("Standard 3 views: front, top and side, lined up"))}">${ICON.std3}<span>${esc(t("Standard 3 views"))}</span></button>
          <div class="drw-dd"><button class="btn small" data-a="model" aria-haspopup="menu" aria-expanded="false" title="${esc(t("Model view: pick an orientation, then place it on the sheet"))}">${ICON.model}<span>${esc(t("Model view"))}</span> ▾</button>
            <div class="drw-menu" role="menu" hidden>${(Object.keys(ORIENT_NAMES) as Orient[]).map(o => `<button role="menuitem" data-orient="${o}">${esc(t(ORIENT_NAMES[o]))}</button>`).join("")}</div></div>
          <button class="btn small" data-a="proj" title="${esc(t("Projected view: move the cursor around a view and click"))}">${ICON.proj}<span>${esc(t("Projected view"))}</span></button>
          <span class="drw-sep"></span>
          <button class="icon" data-a="undo" aria-label="${esc(t("Undo (Ctrl+Z)"))}" title="${esc(t("Undo (Ctrl+Z)"))}">${ICON.undo}</button>
          <button class="icon" data-a="redo" aria-label="${esc(t("Redo (Ctrl+Y)"))}" title="${esc(t("Redo (Ctrl+Y)"))}">${ICON.redo}</button>
          <button class="icon" data-a="fit" aria-label="${esc(t("Fit the sheet (F)"))}" title="${esc(t("Fit the sheet (F)"))}">${ICON.fit}</button>
          <span class="drw-sep"></span>
          <button class="btn small" data-a="save" title="${esc(t("Save the drawing (Ctrl+S)"))}">${ICON.save}<span>${esc(t("Save"))}</span></button>
          <div class="drw-dd"><button class="btn small" data-a="export" aria-haspopup="menu" aria-expanded="false" title="${esc(t("PDF, SVG, DXF or print"))}">${ICON.exp}<span>${esc(t("Export"))}</span> ▾</button>
            <div class="drw-menu right" role="menu" hidden>
              <button role="menuitem" data-x="pdf">${esc(t("PDF (all sheets)"))}</button>
              <button role="menuitem" data-x="svg">${esc(t("SVG (this sheet)"))}</button>
              <button role="menuitem" data-x="dxf">${esc(t("DXF (this sheet)"))}</button>
              <button role="menuitem" data-x="print">${esc(t("Print… (Ctrl+P)"))}</button>
            </div></div>
        </div>
      </div>
      <div class="drw-body">
        <aside class="drw-side" aria-label="${esc(t("Sheets and views"))}">
          <div class="drw-tree" role="tree" aria-label="${esc(t("Drawing tree"))}"></div>
          <div class="drw-props"></div>
        </aside>
        <div class="drw-canvas">
          <svg class="drw-svg" tabindex="0" role="img" aria-label="${esc(t("Drawing sheet. Drag a view to move it, Delete removes it, F fits the sheet, Esc cancels."))}" translate="no" xmlns="${SVGNS}"></svg>
          <div class="drw-confirm" hidden><button class="mc-ok" data-a="done" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="mc-cancel" data-a="done" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></div>
          <div class="drw-tabs"></div>
        </div>
      </div>
      <div class="drw-status" role="status"></div>`;
    this.svg = this.el.querySelector(".drw-svg")!;
    this.el.addEventListener("click", e => this.onClick(e));
    this.el.addEventListener("change", e => this.onInput(e as Event, true));
    this.el.addEventListener("input", e => this.onInput(e as Event, false));
    this.svg.addEventListener("pointerdown", e => this.onDown(e));
    this.svg.addEventListener("pointermove", e => this.onMove(e));
    this.svg.addEventListener("pointerup", e => this.onUp(e));
    this.svg.addEventListener("dblclick", e => this.onDbl(e));
    this.svg.addEventListener("wheel", e => this.onWheel(e), { passive: false });
    this.svg.addEventListener("contextmenu", e => e.preventDefault());
    document.addEventListener("pointerdown", e => { if (!(e.target as HTMLElement).closest?.(".drw-dd")) this.closeMenus(); });
    new ResizeObserver(() => this.applyViewBox()).observe(this.svg);
    this.renderAll();
  }

  private closeMenus() {
    this.el.querySelectorAll<HTMLElement>(".drw-menu").forEach(m => { m.hidden = true; m.previousElementSibling?.setAttribute("aria-expanded", "false"); });
  }

  private renderAll() {
    if (!this.store || !this.svg) return;
    if (this.sel && !findView(this.sheet, this.sel)) this.sel = null;
    this.renderSheet();
    this.renderTree();
    this.renderProps();
    this.renderTabs();
    this.renderStatus();
    const name = this.el.querySelector(".drw-name")!;
    name.textContent = `${this.fileName || `${this.doc.name}${DRAWING_EXT}`}${this.store.dirty ? " •" : ""}`;
    const u = this.el.querySelector<HTMLButtonElement>('[data-a="undo"]')!, r = this.el.querySelector<HTMLButtonElement>('[data-a="redo"]')!;
    u.disabled = !this.store.undoLabel; r.disabled = !this.store.redoLabel;
    u.title = this.store.undoLabel ? t("Undo {what} (Ctrl+Z)", { what: t(this.store.undoLabel) }) : t("Undo (Ctrl+Z)");
    r.title = this.store.redoLabel ? t("Redo {what} (Ctrl+Y)", { what: t(this.store.redoLabel) }) : t("Redo (Ctrl+Y)");
  }

  private renderStatus() {
    const st = this.el.querySelector<HTMLElement>(".drw-status");
    if (!st || !this.store) return;
    const m = this.mode;
    let s = "";
    if (this.loading) s = t("Loading the model into the drawing kernel…");
    else if (m.kind === "model") s = t("Click on the sheet to place the {orient} view. Esc cancels.", { orient: t(ORIENT_NAMES[m.orient]).toLowerCase() });
    else if (m.kind === "projected") s = m.parent ? t("Move the cursor around the view and click to place a projected view. Esc or ✓ ends.") : t("Click the view to project from.");
    else if (this.stale) s = t("The model changed: the views are out of date. Updating…");
    else s = t("Drag a view to move it. Double-click the title block to fill it in.");
    st.textContent = s;
    st.classList.toggle("warn", this.stale && !this.loading);
    this.el.querySelector<HTMLElement>(".drw-confirm")!.hidden = m.kind === "none";
    this.el.classList.toggle("stale", this.stale || this.loading > 0);
  }

  // ---------- the sheet ----------

  private fields(sheet: Sheet = this.sheet): Fields {
    const p = this.doc.props, i = this.info;
    const massKg = this.facts && i.density ? this.facts.volume * i.density * 1e-6 : null;
    return {
      title: p.title || i.title || this.doc.name, number: p.number || i.number || this.doc.name, revision: p.revision || i.revision || "",
      material: p.material || i.material || "", mass: p.mass || (massKg != null ? `${massKg < 10 ? massKg.toFixed(3) : massKg.toFixed(2)} kg` : ""),
      company: p.company || "", author: p.author || i.author || "", checked: p.checked || "", approved: p.approved || "", date: p.date || "",
      scale: scaleText(sheet.scale), sheet: `${this.doc.sheets.indexOf(sheet) + 1}/${this.doc.sheets.length}`,
      size: sheet.size === "custom" ? `${sheetSize(sheet).map(v => Math.round(v)).join("×")}` : sheet.size.replace("ANSI ", ""), units: "mm",
    };
  }

  private projFor(sheet: Sheet, v: DrawingView): Projection | undefined {
    const d = viewDir(sheet, v);
    const p = this.kernel.cache.get(dirKey(d));
    if (!p && this.facts) void this.kernel.project(d).then(() => this.renderSheet(), err => toast(t("A view could not be projected: {err}", { err: (err as Error).message }), true));
    return p;
  }

  private renderSheet() {
    const sh = this.sheet, [W, H] = sheetSize(sh);
    this.placements.clear();
    let html = `<rect class="drw-paper" x="0" y="0" width="${W}" height="${H}"/><g class="drw-fmt">${svgBody(formatPrims(sh, this.fields(), s => t(s)), H)}</g>`;
    for (const v of sh.views) {
      const proj = this.projFor(sh, v);
      const pl = placement(sh, v, proj, this.facts?.box ?? null);
      this.placements.set(v.id, pl);
      const r = viewRect(pl);
      let body = proj ? svgBody(viewPrims(v, proj, pl), H) : "";
      if (!proj) body = `<rect class="drw-pending" x="${r[0]}" y="${H - r[3]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}"/>`;
      if (v.label) {
        body += svgBody([{ t: "t", x: v.x, y: r[1] - 6, s: v.name, h: 3.5, al: "c", layer: "TEXT" },
          { t: "t", x: v.x, y: r[1] - 10.5, s: `${t("Scale")} ${scaleText(viewScalePair(sh, v))}`, h: 2.5, al: "c", layer: "TEXT" }], H);
      }
      html += `<g class="drw-view" data-v="${v.id}">${body}</g>`;
    }
    html += `<g class="drw-ovl"></g>`;
    this.svg.innerHTML = html;
    this.svg.style.fontFamily = FONT;
    this.renderOverlay();
    this.applyViewBox();
  }

  /** Selection and hover frames, and the live preview of a view being placed. */
  private renderOverlay() {
    const g = this.svg.querySelector(".drw-ovl");
    if (!g) return;
    const H = sheetSize(this.sheet)[1];
    let s = "";
    const frame = (id: string, cls: string) => {
      const pl = this.placements.get(id);
      if (!pl) return;
      const r = viewRect(pl), m = 3;
      s += `<rect class="${cls}" x="${r[0] - m}" y="${H - r[3] - m}" width="${r[2] - r[0] + 2 * m}" height="${r[3] - r[1] + 2 * m}"/>`;
    };
    if (this.hover && this.hover !== this.sel) frame(this.hover, "drw-hov");
    if (this.sel) frame(this.sel, "drw-sel");
    const pv = this.previewView();
    if (pv) {
      const proj = this.projFor(this.sheet, pv.view);
      const pl = placement(this.sheetWith(pv.view), pv.view, proj, this.facts?.box ?? null);
      const r = viewRect(pl);
      s += `<g class="drw-preview">${proj ? svgBody(viewPrims(pv.view, proj, pl), H, "currentColor") : ""}<rect class="drw-pv-frame" x="${r[0] - 3}" y="${H - r[3] - 3}" width="${r[2] - r[0] + 6}" height="${r[3] - r[1] + 6}"/></g>`;
      if (pv.parent) {
        const pp = this.placements.get(pv.parent);
        if (pp) s += `<line class="drw-align" x1="${pp.x}" y1="${H - pp.y}" x2="${pl.x}" y2="${H - pl.y}"/>`;
      }
    }
    g.innerHTML = s;
  }

  /** The sheet with an extra (preview) view, so its direction and scale resolve. */
  private sheetWith(v: DrawingView): Sheet { return { ...this.sheet, views: [...this.sheet.views, v] }; }

  /** The view the current command would place at the cursor. */
  private previewView(): { view: DrawingView; parent?: string } | null {
    const m = this.mode;
    if (m.kind === "model" && m.at) return { view: { id: "_pv", name: "", orient: m.orient, dir: m.dir, x: m.at[0], y: m.at[1], style: m.orient === "iso" || m.orient === "current" ? "hlr" : "hlv" } };
    if (m.kind === "projected" && m.parent && m.at) {
      const v = this.projectedAt(m.parent, m.at);
      return v ? { view: v, parent: m.parent } : null;
    }
    return null;
  }

  /** A projected view of `parentId` towards the cursor, lined up with it. */
  private projectedAt(parentId: string, at: [number, number]): DrawingView | null {
    const parent = findView(this.sheet, parentId), pp = this.placements.get(parentId);
    if (!parent || !pp) return null;
    const dx = at[0] - pp.x, dy = at[1] - pp.y;
    const r = viewRect(pp);
    if (Math.abs(dx) < (r[2] - r[0]) / 2 && Math.abs(dy) < (r[3] - r[1]) / 2) return null;
    const side = sideOf(dx, dy);
    const v: DrawingView = { id: "_pv", name: "", parent: parentId, side, x: at[0], y: at[1], style: side[0] && side[1] ? "hlr" : parent.style, tangent: parent.tangent };
    const ax = alignAxis(v);
    if (ax === "y") v.y = pp.y;
    if (ax === "x") v.x = pp.x;
    return v;
  }

  private applyViewBox() {
    if (!this.svg) return;
    const rc = this.svg.getBoundingClientRect();
    if (!rc.width || !rc.height) return;
    // Keep the aspect of the element: grow the box to fill it.
    const k = Math.max(this.vb.w / rc.width, this.vb.h / rc.height);
    const w = rc.width * k, h = rc.height * k;
    const cx = this.vb.x + this.vb.w / 2, cy = this.vb.y + this.vb.h / 2;
    this.vb = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
  }

  fit() {
    if (!this.store) return;
    const [W, H] = sheetSize(this.sheet), m = Math.max(W, H) * 0.03;
    this.vb = { x: -m, y: -m, w: W + 2 * m, h: H + 2 * m };
    this.applyViewBox();
    const rc = this.svg?.getBoundingClientRect();
    if (rc?.width) {
      const k = Math.max((W + 2 * m) / rc.width, (H + 2 * m) / rc.height);
      this.vb = { x: W / 2 - rc.width * k / 2, y: H / 2 - rc.height * k / 2, w: rc.width * k, h: rc.height * k };
      this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
    }
  }

  /** Sheet point (mm, y up) under a pointer event. */
  private sheetPt(e: { clientX: number; clientY: number }): [number, number] {
    const rc = this.svg.getBoundingClientRect();
    const x = this.vb.x + (e.clientX - rc.left) / rc.width * this.vb.w;
    const y = this.vb.y + (e.clientY - rc.top) / rc.height * this.vb.h;
    return [x, sheetSize(this.sheet)[1] - y];
  }

  private viewAt(p: [number, number]): string | null {
    const views = [...this.sheet.views].reverse();
    for (const v of views) {
      const pl = this.placements.get(v.id);
      if (!pl) continue;
      const r = viewRect(pl), m = 3;
      if (p[0] >= r[0] - m && p[0] <= r[2] + m && p[1] >= r[1] - m && p[1] <= r[3] + m) return v.id;
    }
    return null;
  }

  // ---------- pointer ----------

  private onDown(e: PointerEvent) {
    this.svg.focus({ preventScroll: true });
    if (e.button === 1 || e.button === 2) { this.startPan(e); return; }
    if (e.button !== 0) return;
    const p = this.sheetPt(e);
    const m = this.mode;
    if (m.kind === "model") { this.placeModel(m, p); return; }
    if (m.kind === "projected") {
      if (!m.parent) { const id = this.viewAt(p); if (id) { m.parent = id; this.sel = id; m.at = p; this.renderStatus(); this.renderOverlay(); } return; }
      const v = this.projectedAt(m.parent, p);
      if (v) this.placeProjected(v); else { const id = this.viewAt(p); if (id) { m.parent = id; this.sel = id; this.renderOverlay(); } }
      return;
    }
    const id = this.viewAt(p);
    if (id) {
      this.sel = id;
      const orig = new Map<string, [number, number]>();
      for (const v of this.sheet.views) orig.set(v.id, [v.x, v.y]);
      this.drag = { id, start: p, orig, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      this.renderTree();
      this.renderProps();
      this.renderOverlay();
    } else {
      if (this.sel) { this.sel = null; this.renderTree(); this.renderProps(); this.renderOverlay(); }
      this.startPan(e);
    }
  }

  private startPan(e: PointerEvent) {
    this.pan = { x: e.clientX, y: e.clientY, vb: { ...this.vb } };
    this.svg.setPointerCapture(e.pointerId);
    this.svg.classList.add("panning");
  }

  private onMove(e: PointerEvent) {
    if (this.pan) {
      const rc = this.svg.getBoundingClientRect(), k = this.pan.vb.w / rc.width;
      this.vb = { ...this.pan.vb, x: this.pan.vb.x - (e.clientX - this.pan.x) * k, y: this.pan.vb.y - (e.clientY - this.pan.y) * k };
      this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
      return;
    }
    const p = this.sheetPt(e);
    if (this.drag) {
      const d = this.drag;
      if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 1) return;
      d.moved = true;
      const moves = this.dragMoves(d.id, p[0] - d.start[0], p[1] - d.start[1], d.orig);
      for (const [id, [x, y]] of moves) {
        const g = this.svg.querySelector<SVGGElement>(`.drw-view[data-v="${id}"]`), o = d.orig.get(id)!;
        g?.setAttribute("transform", `translate(${x - o[0]} ${-(y - o[1])})`);
        const pl = this.placements.get(id);
        if (pl) { pl.x = x; pl.y = y; }
      }
      this.renderOverlay();
      return;
    }
    const m = this.mode;
    if (m.kind !== "none") { m.at = p; this.renderOverlay(); return; }
    const h = this.viewAt(p);
    if (h !== this.hover) { this.hover = h; this.renderOverlay(); }
    this.svg.style.cursor = h ? "move" : "";
  }

  /** New centres of a dragged view and the views that follow it (FR-DRW-011). */
  private dragMoves(id: string, dx: number, dy: number, o: Map<string, [number, number]>): Map<string, [number, number]> {
    const sh = this.sheet, out = new Map<string, [number, number]>();
    const v = findView(sh, id)!;
    const ax = alignAxis(v);
    if (ax === "y") dy = 0;
    if (ax === "x") dx = 0;
    const visit = (vid: string) => {
      const p = o.get(vid)!;
      out.set(vid, [p[0] + dx, p[1] + dy]);
      for (const c of sh.views) if (c.parent === vid && !out.has(c.id)) visit(c.id);
    };
    visit(id);
    return out;
  }

  private onUp(e: PointerEvent) {
    if (this.pan) { this.pan = null; this.svg.classList.remove("panning"); try { this.svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } return; }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    if (!d.moved) return;
    const p = this.sheetPt(e);
    const moves = this.dragMoves(d.id, p[0] - d.start[0], p[1] - d.start[1], d.orig);
    this.store!.change("Move view", doc => {
      const sh = doc.sheets[this.sheetIdx];
      for (const v of sh.views) { const m = moves.get(v.id); if (m) { v.x = round(m[0]); v.y = round(m[1]); } }
    });
  }

  private onDbl(e: MouseEvent) {
    const p = this.sheetPt(e);
    const f = fieldAt(this.sheet, p[0], p[1]);
    if (f) {
      this.sel = null;
      this.renderProps();
      const inp = this.el.querySelector<HTMLInputElement>(`[data-f="${f}"]`);
      inp?.focus();
      inp?.select();
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const rc = this.svg.getBoundingClientRect();
    const fx = (e.clientX - rc.left) / rc.width, fy = (e.clientY - rc.top) / rc.height;
    const k = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const [W, H] = sheetSize(this.sheet);
    const w = Math.min(Math.max(this.vb.w * k, 5), Math.max(W, H) * 6), h = this.vb.h * w / this.vb.w;
    this.vb = { x: this.vb.x + (this.vb.w - w) * fx, y: this.vb.y + (this.vb.h - h) * fy, w, h };
    this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
  }

  // ---------- commands ----------

  private cancelMode() {
    if (this.mode.kind === "none") return;
    this.mode = { kind: "none" };
    this.renderOverlay();
    this.renderStatus();
  }

  private startModel(orient: Orient) {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    let dir: ViewDir;
    if (orient === "current") {
      const c = this.host.currentView();
      if (!c) { toast(t("Open the 3D view of the model first."), true); return; }
      dir = c;
    } else dir = ORIENTS[orient];
    this.mode = { kind: "model", orient, dir, at: null };
    void this.kernel.project(dir).then(() => this.renderOverlay(), () => {});
    this.renderStatus();
  }

  private placeModel(m: Extract<Mode, { kind: "model" }>, p: [number, number]) {
    const id = uid("v_");
    const n = this.nextViewNumber();
    this.store!.change("Model view", d => {
      d.sheets[this.sheetIdx].views.push({ id, name: `${t("Drawing View")}${n}`, orient: m.orient, dir: m.orient === "current" ? m.dir : undefined, x: round(p[0]), y: round(p[1]), style: m.orient === "iso" || m.orient === "current" ? "hlr" : "hlv" });
    });
    this.sel = id;
    // As in SolidWorks, projected views come off the new view until Esc.
    this.mode = { kind: "projected", parent: id, at: p };
    this.renderAll();
  }

  private placeProjected(v: DrawingView) {
    const id = uid("v_"), n = this.nextViewNumber();
    this.store!.change("Projected view", d => {
      d.sheets[this.sheetIdx].views.push({ ...v, id, name: `${t("Drawing View")}${n}`, x: round(v.x), y: round(v.y) });
    });
  }

  private nextViewNumber() {
    let n = 1;
    const names = new Set(this.doc.sheets.flatMap(s => s.views.map(v => v.name)));
    while (names.has(`${t("Drawing View")}${n}`)) n++;
    return n;
  }

  private startProjected() {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    if (!this.sheet.views.length) { toast(t("Place a model view first."), true); return; }
    const parent = this.sel ?? (this.sheet.views.length === 1 ? this.sheet.views[0].id : null);
    this.mode = { kind: "projected", parent, at: null };
    // Warm the four side projections of the parent.
    if (parent) {
      const pv = findView(this.sheet, parent)!, pd = viewDir(this.sheet, pv);
      for (const side of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) void this.kernel.project(projectedDir(pd, side, this.sheet.projection)).catch(() => {});
    }
    this.renderStatus();
  }

  /** Standard 3 views (FR-DRW-011): front, top and side, lined up, at a scale that fits. */
  standard3(fresh = false) {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    const sh = this.sheet, [lo, hi] = this.facts.box;
    const dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2];
    const f = frameOf(sh), gap = 25;
    const ax0 = f[0] + 10, ax1 = f[2] - 10, ay0 = f[1] + TB_H + 10, ay1 = f[3] - 10;
    const s = fresh || !sh.views.length ? fitScale(dx + dy, dz + dy, (ax1 - ax0 - gap) * 0.85, (ay1 - ay0 - gap) * 0.85) : sh.scale;
    const k = s[0] / s[1];
    const Wg = k * (dx + dy) + gap, Hg = k * (dz + dy) + gap;
    const gx = (ax0 + ax1) / 2 - Wg / 2, gy = (ay0 + ay1) / 2 - Hg / 2;
    const third = sh.projection === "third";
    const front: [number, number] = third ? [gx + k * dx / 2, gy + k * dz / 2] : [gx + k * dx / 2, gy + k * dy + gap + k * dz / 2];
    const top: [number, number] = third ? [front[0], gy + k * dz + gap + k * dy / 2] : [front[0], gy + k * dy / 2];
    const side: [number, number] = [gx + k * dx + gap + k * dy / 2, front[1]];
    const fid = uid("v_");
    const n = this.nextViewNumber();
    this.store!.change("Standard 3 views", d => {
      const S = d.sheets[this.sheetIdx];
      S.scale = s;
      S.views.push(
        { id: fid, name: `${t("Drawing View")}${n}`, orient: "front", x: round(front[0]), y: round(front[1]), style: "hlv" },
        { id: uid("v_"), name: `${t("Drawing View")}${n + 1}`, parent: fid, side: [0, third ? 1 : -1], x: round(top[0]), y: round(top[1]), style: "hlv" },
        { id: uid("v_"), name: `${t("Drawing View")}${n + 2}`, parent: fid, side: [1, 0], x: round(side[0]), y: round(side[1]), style: "hlv" },
      );
    });
    this.sel = fid;
    this.renderAll();
  }

  private async deleteSel() {
    const id = this.sel;
    if (!id) return;
    const kids = this.sheet.views.filter(v => v.parent === id);
    if (kids.length && !(await confirmModal(t("Delete the view and the {n} views projected from it?", { n: kids.length }), t("Delete"), t("Delete view")))) return;
    const gone = new Set<string>([id]);
    let grew = true;
    while (grew) { grew = false; for (const v of this.sheet.views) if (v.parent && gone.has(v.parent) && !gone.has(v.id)) { gone.add(v.id); grew = true; } }
    this.sel = null;
    this.store!.change("Delete view", d => { const S = d.sheets[this.sheetIdx]; S.views = S.views.filter(v => !gone.has(v.id)); });
  }

  // ---------- tree, properties, tabs ----------

  private renderTree() {
    const host = this.el.querySelector<HTMLElement>(".drw-tree")!;
    const sh = this.sheet;
    const item = (v: DrawingView, depth: number): string => {
      const kind = v.parent ? t("Projected") : t(ORIENT_NAMES[v.orient ?? "front"]);
      let s = `<div role="treeitem" tabindex="${v.id === this.sel ? 0 : -1}" aria-selected="${v.id === this.sel}" class="drw-ti${v.id === this.sel ? " on" : ""}" data-sel="${v.id}" style="padding-left:${12 + depth * 14}px">${v.parent ? ICON.proj : ICON.model}<span translate="no">${esc(v.name)}</span><small>${esc(kind)}</small></div>`;
      for (const c of sh.views) if (c.parent === v.id) s += item(c, depth + 1);
      return s;
    };
    host.innerHTML = `<div role="treeitem" tabindex="${this.sel ? -1 : 0}" aria-selected="${!this.sel}" class="drw-ti sheet${this.sel ? "" : " on"}" data-sel="">${ICON.hlr}<span>${esc(sheetName(sh))}</span><small>${esc(sh.size === "custom" ? t("Custom") : sh.size)} · ${scaleText(sh.scale)}</small></div>`
      + sh.views.filter(v => !v.parent || !findView(sh, v.parent)).map(v => item(v, 1)).join("");
  }

  private renderProps() {
    const host = this.el.querySelector<HTMLElement>(".drw-props")!;
    const sh = this.sheet;
    const v = this.sel ? findView(sh, this.sel) : null;
    if (v) {
      const own = v.scale ? scaleText(v.scale) : "";
      const style = v.style ?? "hlv", tan = v.tangent ?? "visible";
      host.innerHTML = `
        <fieldset class="pm-group"><legend>${esc(t("Drawing view"))}</legend>
          <label class="drw-f">${esc(t("Name"))}<input data-v="name" value="${esc(v.name)}" translate="no"></label>
          ${v.parent ? `<p class="drw-note">${esc(t("Projected from {name}", { name: findView(sh, v.parent)?.name ?? "?" }))}</p>` : `
          <label class="drw-f">${esc(t("Orientation"))}<select data-v="orient">${(Object.keys(ORIENT_NAMES) as Orient[]).map(o => `<option value="${o}"${o === (v.orient ?? "front") ? " selected" : ""}>${esc(t(ORIENT_NAMES[o]))}</option>`).join("")}</select></label>`}
        </fieldset>
        <fieldset class="pm-group"><legend>${esc(t("Scale"))}</legend>
          <label class="drw-f">${esc(t("Scale"))}<select data-v="scale"><option value="">${esc(v.parent ? t("Parent's scale") : t("Sheet scale ({s})", { s: scaleText(sh.scale) }))}</option>${SCALES.map(s => `<option value="${scaleText(s)}"${own === scaleText(s) ? " selected" : ""}>${scaleText(s)}</option>`).join("")}${own && !SCALES.some(s => scaleText(s) === own) ? `<option value="${own}" selected>${own}</option>` : ""}<option value="custom">${esc(t("Custom…"))}</option></select></label>
        </fieldset>
        <fieldset class="pm-group"><legend>${esc(t("Display style"))}</legend>
          <div class="seg drw-seg" role="radiogroup" aria-label="${esc(t("Display style"))}">
            ${(["hlv", "hlr", "wire"] as DisplayStyle[]).map(s => `<button role="radio" aria-checked="${s === style}" class="${s === style ? "on" : ""}" data-style="${s}" title="${esc(t(STYLE_NAMES[s]))}" aria-label="${esc(t(STYLE_NAMES[s]))}">${ICON[s]}</button>`).join("")}
          </div>
          <label class="drw-f">${esc(t("Tangent edges"))}<select data-v="tangent">${(["visible", "thin", "hidden"] as TangentEdges[]).map(s => `<option value="${s}"${s === tan ? " selected" : ""}>${esc(t(TAN_NAMES[s]))}</option>`).join("")}</select></label>
          <label class="drw-chk"><input type="checkbox" data-v="label"${v.label ? " checked" : ""}> ${esc(t("Show the view label"))}</label>
        </fieldset>
        <div class="row"><button class="btn small danger" data-a="del">${esc(t("Delete view"))}</button></div>`;
      return;
    }
    const f = this.fields();
    host.innerHTML = `
      <fieldset class="pm-group"><legend>${esc(t("Sheet"))}</legend>
        <label class="drw-f">${esc(t("Size"))}<select data-s="size">${SIZE_LIST.map(s => `<option value="${s}"${sh.size === s ? " selected" : ""}>${s}</option>`).join("")}</select></label>
        <div class="seg drw-seg" role="radiogroup" aria-label="${esc(t("Orientation"))}">
          <button role="radio" data-orientation="land" aria-checked="${!sh.portrait}" class="${sh.portrait ? "" : "on"}">${esc(t("Landscape"))}</button><button role="radio" data-orientation="port" aria-checked="${!!sh.portrait}" class="${sh.portrait ? "on" : ""}">${esc(t("Portrait"))}</button>
        </div>
        <label class="drw-f">${esc(t("Scale"))}<select data-s="scale">${SCALES.map(s => `<option value="${scaleText(s)}"${scaleText(sh.scale) === scaleText(s) ? " selected" : ""}>${scaleText(s)}</option>`).join("")}${SCALES.some(s => scaleText(s) === scaleText(sh.scale)) ? "" : `<option selected value="${scaleText(sh.scale)}">${scaleText(sh.scale)}</option>`}<option value="custom">${esc(t("Custom…"))}</option></select></label>
        <label class="drw-f">${esc(t("Projection"))}<select data-s="projection"><option value="first"${sh.projection === "first" ? " selected" : ""}>${esc(t("First angle (ISO)"))}</option><option value="third"${sh.projection === "third" ? " selected" : ""}>${esc(t("Third angle (ANSI)"))}</option></select></label>
        <label class="drw-f">${esc(t("Sheet format"))}<select data-s="format"><option value="iso"${sh.format === "iso" ? " selected" : ""}>ISO 7200</option><option value="ansi"${sh.format === "ansi" ? " selected" : ""}>ANSI Y14.1</option></select></label>
      </fieldset>
      <fieldset class="pm-group"><legend>${esc(t("Title block"))}</legend>
        ${EDITABLE.map(k => `<label class="drw-f">${esc(t(FIELD_LABEL[k]))}<input data-f="${k}" value="${esc(this.doc.props[k] ?? "")}" placeholder="${esc(String(f[k] ?? ""))}" translate="no"></label>`).join("")}
      </fieldset>
      <div class="row"><button class="btn small" data-a="addsheet">${esc(t("Add sheet"))}</button>${this.doc.sheets.length > 1 ? `<button class="btn small danger" data-a="delsheet">${esc(t("Delete sheet"))}</button>` : ""}</div>`;
  }

  private renderTabs() {
    const host = this.el.querySelector<HTMLElement>(".drw-tabs")!;
    host.innerHTML = `<div class="drw-tablist" role="tablist" aria-label="${esc(t("Sheets"))}">${this.doc.sheets.map((s, i) => `<button role="tab" aria-selected="${i === this.sheetIdx}" tabindex="${i === this.sheetIdx ? 0 : -1}" class="${i === this.sheetIdx ? "on" : ""}" data-sheet="${i}">${esc(sheetName(s))}</button>`).join("")}</div>`
      + `<button class="drw-addsheet" data-a="addsheet" aria-label="${esc(t("Add sheet"))}" title="${esc(t("Add sheet"))}">+</button>`;
  }

  private onClick(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button, [data-sel]");
    if (!b || !this.store) return;
    const a = b.dataset.a;
    if (b.dataset.sel !== undefined) { this.cancelMode(); this.sel = b.dataset.sel || null; this.renderTree(); this.renderProps(); this.renderOverlay(); return; }
    if (b.dataset.orient) { this.closeMenus(); this.startModel(b.dataset.orient as Orient); return; }
    if (b.dataset.x) { this.closeMenus(); void this.exportAs(b.dataset.x as "pdf"); return; }
    if (b.dataset.sheet) { this.cancelMode(); this.sheetIdx = +b.dataset.sheet; this.sel = null; this.renderAll(); this.fit(); return; }
    if (b.dataset.style) { this.setView("Display style", v => { v.style = b.dataset.style as DisplayStyle; }); return; }
    if (b.dataset.orientation) { this.setSheet("Sheet orientation", s => { s.portrait = b.dataset.orientation === "port" || undefined; }); this.fit(); return; }
    switch (a) {
      case "back": this.hide(); break;
      case "std3": this.cancelMode(); this.standard3(); break;
      case "model": case "export": {
        const menu = b.nextElementSibling as HTMLElement, open = menu.hidden;
        this.closeMenus();
        menu.hidden = !open;
        b.setAttribute("aria-expanded", String(open));
        if (open) menu.querySelector<HTMLElement>("button")?.focus();
        break;
      }
      case "proj": this.startProjected(); break;
      case "undo": this.store.undo(); break;
      case "redo": this.store.redo(); break;
      case "fit": this.fit(); break;
      case "save": void this.save(); break;
      case "done": this.cancelMode(); break;
      case "del": void this.deleteSel(); break;
      case "addsheet": {
        const n = this.doc.sheets.length + 1;
        this.store.change("Add sheet", d => { d.sheets.push(newSheet(n, this.sheet)); d.sheets[d.sheets.length - 1].views = []; });
        this.sheetIdx = this.doc.sheets.length - 1;
        this.sel = null;
        this.renderAll();
        this.fit();
        break;
      }
      case "delsheet": void (async () => {
        if (this.sheet.views.length && !(await confirmModal(t("Delete {name} and its views?", { name: sheetName(this.sheet) }), t("Delete"), t("Delete sheet")))) return;
        const i = this.sheetIdx;
        this.sheetIdx = Math.max(0, i - 1);
        this.store!.change("Delete sheet", d => { d.sheets.splice(i, 1); });
        this.fit();
      })(); break;
    }
  }

  private setView(label: string, fn: (v: DrawingView) => void) {
    const id = this.sel;
    if (!id) return;
    this.store!.change(label, d => { const v = d.sheets[this.sheetIdx].views.find(x => x.id === id); if (v) fn(v); });
  }
  private setSheet(label: string, fn: (s: Sheet) => void) { this.store!.change(label, d => fn(d.sheets[this.sheetIdx])); }

  private onInput(e: Event, commit: boolean) {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (!this.store || !this.el.querySelector(".drw-props")?.contains(el)) return;
    const val = el.value;
    if (el.dataset.f) {
      // Title block fields: typing updates the sheet; one undo step per field.
      const k = el.dataset.f as keyof DrawingProps;
      this.store.change("Title block", d => { if (val) d.props[k] = val; else delete d.props[k]; }, true);
      return;
    }
    if (!commit) return;
    const vk = el.dataset.v, sk = el.dataset.s;
    if (vk === "name") this.setView("Rename view", v => { v.name = val.trim() || v.name; });
    else if (vk === "orient") {
      const o = val as Orient;
      const c = o === "current" ? this.host.currentView() : null;
      if (o === "current" && !c) { toast(t("Open the 3D view of the model first."), true); this.renderProps(); return; }
      this.setView("View orientation", v => { v.orient = o; v.dir = c ?? undefined; });
    } else if (vk === "scale" || sk === "scale") {
      let s: [number, number] | null | undefined = val === "" ? undefined : parseScale(val);
      if (val === "custom") {
        const txt = prompt(t("Scale, for example 1:3 or 3:2"), "1:3");
        s = txt ? parseScale(txt) : null;
        if (!s) { if (txt) toast(t("Type a scale like 1:3."), true); this.renderProps(); return; }
      }
      if (vk) this.setView("View scale", v => { if (s) v.scale = s; else delete v.scale; });
      else if (s) this.setSheet("Sheet scale", sh => { sh.scale = s!; });
    } else if (vk === "tangent") this.setView("Tangent edges", v => { v.tangent = val as TangentEdges; });
    else if (vk === "label") this.setView("View label", v => { v.label = (el as HTMLInputElement).checked || undefined; });
    else if (sk === "size") { this.setSheet("Sheet size", sh => { sh.size = val as SheetSize; }); this.fit(); }
    else if (sk === "projection") this.setSheet("Projection type", sh => { sh.projection = val as Sheet["projection"]; });
    else if (sk === "format") this.setSheet("Sheet format", sh => { sh.format = val as Sheet["format"]; });
  }

  private onKey(e: KeyboardEvent) {
    if (!this.open) return;
    const tgt = e.target as HTMLElement;
    const typing = tgt.matches?.("input, select, textarea");
    if (tgt.closest?.("dialog")) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    let used = true;
    if (mod && k === "s") void this.save();
    else if (mod && k === "p") void this.exportAs("print");
    else if (mod && !typing && (k === "z" && !e.shiftKey)) this.store?.undo();
    else if (mod && !typing && (k === "y" || (k === "z" && e.shiftKey))) this.store?.redo();
    else if (typing || mod || e.altKey) used = false;
    else if (k === "escape") { if (this.mode.kind !== "none") this.cancelMode(); else if (this.el.querySelector(".drw-menu:not([hidden])")) this.closeMenus(); else if (this.sel) { this.sel = null; this.renderAll(); } else used = false; }
    else if (k === "enter" && this.mode.kind !== "none" && (tgt as Element) === this.svg) this.cancelMode();
    else if ((k === "delete" || k === "backspace") && this.sel && ((tgt as Element) === this.svg || tgt.closest(".drw-tree"))) void this.deleteSel();
    else if (k === "f" && tgt.closest(".drw")) this.fit();
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
    else if (!tgt.closest?.(".drw") && !mod) e.stopPropagation();
  }

  // ---------- saving and output ----------

  async save() {
    if (!this.store) return;
    const bytes = await packDrawing(this.doc, `MöbiusCAD ${this.host.appVersion}`, this.model);
    const name = this.fileName || `${this.doc.name}${DRAWING_EXT}`;
    this.host.download(new Blob([bytes], { type: "application/zip" }), name);
    this.fileName = name;
    this.store.markSaved();
    this.renderAll();
    toast(t("Saved {name}", { name }), "success");
  }

  /** Waits until every view of the sheets has its lines. */
  private async allProjected(sheets: Sheet[]) {
    await Promise.all(sheets.flatMap(sh => sh.views.map(v => this.kernel.project(viewDir(sh, v)))));
  }

  private composed(sh: Sheet) {
    return composeSheet(sh, this.fields(sh), this.kernel.cache, this.facts?.box ?? null, s => t(s));
  }

  async exportAs(kind: "pdf" | "svg" | "dxf" | "print") {
    if (!this.store) return;
    const sheets = kind === "pdf" || kind === "print" ? this.doc.sheets : [this.sheet];
    try {
      if (this.loading) toast(t("Waiting for the views…"));
      await this.allProjected(sheets);
    } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); return; }
    const base = this.doc.name || "drawing";
    const out = sheets.map(sh => { const [W, H] = sheetSize(sh); return { prims: this.composed(sh).prims, W, H }; });
    try {
      if (kind === "svg") this.host.download(new Blob([sheetSvg(out[0].prims, out[0].W, out[0].H)], { type: "image/svg+xml" }), `${base}-${this.sheet.name}.svg`);
      else if (kind === "dxf") this.host.download(new Blob([sheetDxf(out[0].prims, out[0].W, out[0].H)], { type: "application/dxf" }), `${base}-${this.sheet.name}.dxf`);
      else if (kind === "pdf") {
        const font = await (await fetch(fontUrl)).arrayBuffer();
        this.host.download(await sheetsPdf(out, font, this.fields().title), `${base}.pdf`);
      } else { printSheets(out, base); return; }
      toast(t("Exported {kind}", { kind: kind.toUpperCase() }), "success");
    } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
  }

  /** For tests: the composed primitives of the current sheet. */
  debug() {
    return {
      doc: () => this.store?.doc ?? null,
      prims: () => (this.store ? this.composed(this.sheet).prims : []),
      ready: () => !!this.store && !this.loading && this.sheet.views.every(v => this.kernel.cache.has(dirKey(viewDir(this.sheet, v)))),
      svg: () => (this.store ? (() => { const sh = this.sheet, [W, H] = sheetSize(sh); return sheetSvg(this.composed(sh).prims, W, H); })() : ""),
      dxf: () => (this.store ? (() => { const sh = this.sheet, [W, H] = sheetSize(sh); return sheetDxf(this.composed(sh).prims, W, H); })() : ""),
      sheetPt: (x: number, y: number) => { const rc = this.svg.getBoundingClientRect(), H = sheetSize(this.sheet)[1]; return [rc.left + (x - this.vb.x) / this.vb.w * rc.width, rc.top + (H - y - this.vb.y) / this.vb.h * rc.height]; },
      placement: (id: string) => this.placements.get(id) ?? null,
    };
  }
}

const STYLE_NAMES: Record<DisplayStyle, string> = { hlv: "Hidden lines visible", hlr: "Hidden lines removed", wire: "Wireframe" };
const TAN_NAMES: Record<TangentEdges, string> = { visible: "Visible", thin: "Thin", hidden: "Removed" };
const round = (v: number) => Math.round(v * 100) / 100;
function sheetName(s: Sheet) { const m = /^Sheet(\d+)$/.exec(s.name); return m ? t("Sheet {n}", { n: m[1] }) : s.name; }

export function partInfo(d: PartDoc): DrawingModel["info"] {
  return { title: d.props.title || d.name, number: d.props.partNumber, revision: d.props.revision, author: d.props.author, material: d.material?.name, density: d.material?.density };
}

/** Prints the sheets 1:1 through the browser's print dialog (FR-DRW-031). */
function printSheets(sheets: { prims: Prim[]; W: number; H: number }[], title: string) {
  const fr = document.createElement("iframe");
  fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  fr.setAttribute("aria-hidden", "true");
  document.body.appendChild(fr);
  const first = sheets[0];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:${first.W}mm ${first.H}mm;margin:0}html,body{margin:0}svg{display:block;page-break-after:always;break-after:page}@font-face{font-family:"DejaVu Sans";src:url(${new URL(fontUrl, location.href).href})}</style></head><body>${sheets.map(s => sheetSvg(s.prims, s.W, s.H).replace(/^<\?xml[^>]*>\n/, "")).join("")}</body></html>`;
  const d = fr.contentDocument!;
  d.open(); d.write(html); d.close();
  const go = () => { try { fr.contentWindow!.focus(); fr.contentWindow!.print(); } finally { setTimeout(() => fr.remove(), 60_000); } };
  (d.fonts?.ready ?? Promise.resolve()).then(() => setTimeout(go, 100), go);
}
