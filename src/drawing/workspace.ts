// Drawing workspace (FRS section 11): a full-window sheet editor over the 3D view.
// Views are placed like in SolidWorks: a model view follows the cursor with its
// lines as a live preview, then projected views come off it as the cursor moves
// around (Esc or ✓ ends); views drag on the sheet and projected ones stay lined up
// with their parent. Lines come from the drawing worker (exact HLR).
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import type { MEdge, Projection, ViewDir } from "../kernel/drawing";
import { AUTO_LAYERS, dimGeo, factsCtx, holeEdges, holeRows, dimPrims, dimText, edgeFoot, edgeRef, holeText, placeItems, projector, refEdge, refPoint, sheetNotes, useProps, useStyle, viewAnnots, type AnnotCtx } from "./annot";
import type { PartDoc } from "../model/types";
import type { AsmDoc } from "../asm/types";
import { BOM_COLS, autoBalloons, compOfKey, sheetBom, subsOf, type Bom } from "./bom";
import { t, onLangChange, lang } from "../i18n";
import { toast, confirmModal } from "../ui";
import { DrawingKernel, type ModelFacts } from "./client";
import { BREAK_GAP, composeSheet, fromSheet, HATCH_PATTERNS, hatchOf, inPoly, nextLetter, polyBox, placement, toSheet, viewBody, viewPrims, viewRect, type Placement } from "./compose";
import { DrawingStore, newSheet, uid } from "./doc";
import { DRAWING_EXT, packDrawing, unpackDrawing } from "./file";
import { sheetDxf, sheetDxf2000, sheetPng, sheetSvg, sheetsPdf, svgBody, FONT } from "./output";
import type { Prim } from "./prims";
import { editTitleBlock } from "./tbEditor";
import { loadFormats } from "./formats";
import { FIELD_LABEL, isoFormat, editableOf, SIZES, fieldAt, formatPrims, frameOf, sheetSize, tbSize, titleBlockAt, type Fields } from "./sheet";
import type { Annot, BalloonAnnot, DimAnnot, DisplayStyle, DraftStyle, DrawingDoc, DrawingProps, DrawingView, GeoRef, GRow, GSym, HatchPattern, Orient, Sheet, SheetSize, TableAnnot, TangentEdges, Tol } from "./types";
import { GSYMS, GSYM_NAMES, cellLabel } from "./gdt";
import { fitLimits, splitFit } from "./iso286";
import { ORIENTS, ORIENT_NAMES, SCALES, viewConfig, viewOnly, topoOnly, altReq, alignAxis, alignedLegs, cutLegs, findView, fitScale, lookDir, parseScale, projectedDir, scaleText, sideOf, switchProjection, viewDir, viewReq, viewScale } from "./views";
import { PALETTE, PALETTE_MIME, thumbPath } from "./palette";
import "./drawing.css";
import { makeGrip } from "../resize";

export interface DrawingModel {
  name: string;
  part?: PartDoc;
  file?: { name: string; bytes: Uint8Array };
  /** An assembly (FR-DRW-030): its document, and with patterns and sub-assemblies expanded. */
  asm?: { doc: AsmDoc; flat: AsmDoc };
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
  /** The assembly with this id open now, if any (with patterns and sub-assemblies expanded). */
  liveAsm?(id: string): { doc: AsmDoc; flat: AsmDoc } | null;
  /** Runs after every change of the part open in the modeller. */
  onPartChange(fn: () => void): void;
  /** Direction of the 3D camera (for "Current 3D view"). */
  currentView(): ViewDir | null;
  download(blob: Blob, name: string): void;
  /** Called when the workspace opens or closes (the 3D view's keys and header step aside). */
  onToggle?(open: boolean): void;
  /** Document tabs: a drawing is about to open (the one shown now is parked first), and one opened. */
  beforeOpen?(): void;
  opened?(label: string): void;
}

/** Title block fields a note can link to with $PRP:"key" (FR-DRW-023). */
const NOTE_PROP_KEYS: [string, string][] = [["title", "Title"], ["number", "Part number"], ["revision", "Revision"], ["material", "Material"], ["mass", "Mass"], ["company", "Company"], ["author", "Author"], ["checked", "Checked"], ["approved", "Approved"], ["date", "Date"], ["scale", "Scale"], ["sheet", "Sheet"], ["size", "Size"]];

type Mode =
  | { kind: "none" }
  /** A model view follows the cursor. */
  | { kind: "model"; orient: Orient; dir: ViewDir; at: [number, number] | null }
  /** Projected views come off `parent`. */
  | { kind: "projected"; parent: string | null; at: [number, number] | null }
  /** Section view (FR-DRW-012): pick the cutting line on a view (horizontal, vertical or through two points), then place the view. */
  | { kind: "section"; how: "h" | "v" | "2p" | "off" | "half" | "aligned"; parent: string | null; p1: Pt | null; line: Line4 | null; at: Pt | null; pts?: Pt[]; path?: number[] }
  /** Detail view (FR-DRW-013): click the centre, then the radius, then place. */
  | { kind: "detail"; parent: string | null; c: Pt | null; r: number | null; at: Pt | null; prof?: boolean; pts?: Pt[]; outline?: number[] }
  /** Auxiliary view (FR-DRW-014): click a straight edge, then place the view square to it. */
  | { kind: "aux"; parent: string | null; line: Line4 | null; at: Pt | null }
  /** Crop view (FR-DRW-015): two corners of the rectangle on the selected view (model view axes). */
  | { kind: "crop"; view: string; p1: Pt | null; at: Pt | null }
  /** Break view (FR-DRW-015): the two ends of the band to leave out, along u (vertical lines) or v. */
  | { kind: "break"; view: string; axis: "u" | "v"; a: number | null; at: Pt | null }
  /** Broken-out section (FR-DRW-015): the outline's corners on the selected view (model view axes); Enter or a click on the first corner closes it. */
  | { kind: "brokenout"; view: string; pts: Pt[]; at: Pt | null }
  /** Alternate position (FR-DRW-015): click a component on the view, then where that point goes. */
  | { kind: "altpos"; view: string; comp: string | null; from: Pt | null; at: Pt | null }
  | AnnotMode;
type Pt = [number, number];
/** A pick for a dimension: a point (edge end or circle centre), a line or a circle, in a view. */
interface Pick { kind: "pt" | "line" | "circle"; ref: GeoRef; e: MEdge }
type AnnotMode =
  /** Smart dimension (FR-DRW-021): pick one or two entities, then place. */
  | { kind: "dim"; view: string | null; picks: Pick[]; at: Pt | null }
  /** Chain, baseline or ordinate dimensions (FR-DRW-021): the first point is the base, each further point adds dimensions at once. */
  | { kind: "dimset"; how: "chain" | "base" | "ord"; view: string | null; picks: GeoRef[]; axis: "h" | "v" | null; at: Pt | null }
  /** Hole table (FR-DRW-024): click the origin on a view (its end-on holes are taken), then place the table. */
  | { kind: "htable"; view: string | null; origin: GeoRef | null; holes: GeoRef[]; at: Pt | null }
  /** Hole callout (FR-DRW-022): pick a round edge, then place. */
  | { kind: "hole"; view: string | null; e: MEdge | null; at: Pt | null }
  /** Note: click the place (first clicking an edge gives it a leader). */
  | { kind: "note"; view: string | null; leader: GeoRef | null; at: Pt | null }
  /** Geometric tolerance (FR-DRW-023): optionally click an edge for the leader, then place the frame. */
  | { kind: "gtol"; view: string | null; leader: GeoRef | null; circle?: boolean; at: Pt | null }
  /** Datum feature: click an edge, then place the letter. */
  | { kind: "datum"; view: string | null; ref: GeoRef | null; at: Pt | null }
  /** Surface finish: click an edge, then place the symbol (on the edge, or away from it with a leader). */
  | { kind: "surf"; view: string | null; ref: GeoRef | null; at: Pt | null }
  /** Balloon (FR-DRW-030): click an edge of a component, then place the balloon. */
  | { kind: "balloon"; view: string | null; ref: GeoRef | null; at: Pt | null };
const ANNOT_KINDS = new Set(["dim", "dimset", "htable", "hole", "note", "gtol", "datum", "surf", "balloon"]);
const isAnnotMode = (m: Mode): m is AnnotMode => ANNOT_KINDS.has(m.kind);
type Line4 = [number, number, number, number];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const SVGNS = "http://www.w3.org/2000/svg";
const SIZE_LIST = Object.keys(SIZES) as Exclude<SheetSize, "custom">[];
const I = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/** The annotation palette's tools (FR-UI-072), the same commands as Dimension and Annotate ▾. */
const ANNOT_TOOLS: [string, string][] = [
  ["dim", "Dimension"], ["chain", "Chain dimension"], ["base", "Baseline dimension"], ["ord", "Ordinate dimension"], ["items", "Model items"], ["hole", "Hole callout"], ["htable", "Hole table"], ["note", "Note"], ["gtol", "Geometric tolerance"], ["datum", "Datum feature"],
  ["surf", "Surface finish"], ["balloon", "Balloon"], ["auto", "Auto balloon"], ["bom", "Bill of materials"], ["rev", "Revision table"], ["table", "General table"],
];

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
  shaded: I('<rect x="2.5" y="2.5" width="11" height="11" fill="currentColor" fill-opacity=".45" stroke="none"/>'),
  shadedEdges: I('<rect x="2.5" y="2.5" width="11" height="11" fill="currentColor" fill-opacity=".45"/>'),
  ok: I('<path d="m3 8.5 3.2 3L13 4.5"/>'),
  section: I('<rect x="3" y="3.5" width="10" height="9"/><path d="M3 12.5l4-9M6.5 12.5l4-9M10 12.5l3-6.5" stroke-width="1"/><path d="M1 8h14" stroke-dasharray="3 1.2 1 1.2"/>'),
  detail: I('<circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4 4"/>'),
  dim: I('<path d="M2 4v8M14 4v8M2 8h12"/><path d="m4.5 6.5-2.5 1.5 2.5 1.5M11.5 6.5 14 8l-2.5 1.5"/>'),
  annot: I('<path d="M2.5 3h11M2.5 6.5h11M2.5 10h7"/><path d="m11 13 2-2"/>'),
  aux: I('<path d="M2 12 9 3"/><path d="m7.5 9.5 4 3.2M11.5 12.7l-.4-2.6M11.5 12.7l-2.5.3"/>'),
};

/** A drawing kept in a document tab while another document is shown. */
export interface DrawingTab { store: DrawingStore; model: Uint8Array | undefined; fileName: string; info: DrawingModel["info"]; modelKey: string; sheetIdx: number }

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
  /** Text boxes of the drawn annotations (sheet mm), for picking. */
  private annotHits: { id: string; box: [number, number, number, number]; view?: string }[] = [];
  private dangling = new Set<string>();
  /** The selected annotation (views and annotations select one at a time). */
  private selA: string | null = null;
  private adrag: { id: string; start: Pt; orig: Pt; s: number; moved: boolean } | null = null;
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
    if (!m) { toast(t("Open a part, an assembly or a STEP, IGES or BREP model first."), true); return; }
    const today = new Date().toISOString().slice(0, 10);
    const doc: DrawingDoc = {
      schema: 1, kind: "drawing", id: uid("dr_"), name: m.name.replace(/\.[^.]+$/, ""),
      sheets: [newSheet(1)], props: { date: today },
      source: m.part ? { kind: "part", doc: m.part, name: m.name } : m.asm ? { kind: "asm", doc: m.asm.doc, flat: m.asm.flat, name: m.name } : { kind: "file", name: m.file!.name },
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
      else if (doc.source.kind === "asm") this.info = { title: doc.source.doc.name };
      this.load(doc, model, file.name);
      await this.loadModel();
    } catch (err) { toast(t("Could not open {name}: {err}", { name: file.name, err: t((err as Error).message) }), true); }
  }

  private info: DrawingModel["info"] = {};
  /** The assembly's bill of materials (FR-DRW-030), for BOM tables and balloon numbers. */
  private boms: Map<string, Bom> | null = null;
  /** The BOM a sheet's balloons and parts list follow (its BOM table's mode). */
  private bomFor(sh: Sheet): Bom | null { const src = this.doc.source; return this.boms && src.kind === "asm" ? sheetBom(sh, src.doc, src.flat, this.boms) : null; }
  private get bom(): Bom | null { return this.bomFor(this.sheet); }

  private load(doc: DrawingDoc, model: Uint8Array | undefined, fileName: string) {
    this.host.beforeOpen?.();
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
    this.host.opened?.(this.title);
  }

  /** (Re)loads the model into the worker from the drawing's source; the views then fill in. */
  private async loadModel(): Promise<ModelFacts | null> {
    const src = this.doc.source;
    this.loading++;
    this.renderStatus();
    try {
      this.facts = await this.kernel.load(src.kind === "part" ? { part: src.doc } : src.kind === "asm" ? { asm: src.flat } : { file: { name: src.name, bytes: this.model! } });
      this.boms = src.kind === "asm" ? new Map() : null;
      this.stale = false;
      this.renderAll();
      void this.renderPalette();
      return this.facts;
    } catch (err) {
      toast(t("The drawing's model could not be loaded: {err}", { err: t((err as Error).message) }), true);
      return null;
    } finally { this.loading--; this.renderStatus(); }
  }

  /** Document tabs (FR-DOC-003): the open drawing with its undo history, kept while another document is shown. */
  park(): DrawingTab | null {
    if (!this.store) return null;
    this.cancelMode();
    const tab: DrawingTab = { store: this.store, model: this.model, fileName: this.fileName, info: this.info, modelKey: this.modelKey, sheetIdx: this.sheetIdx };
    this.hide();
    this.store = null;
    return tab;
  }

  /** Shows a parked drawing again. */
  async resume(tab: DrawingTab) {
    this.store = tab.store;
    this.model = tab.model;
    this.fileName = tab.fileName;
    this.info = tab.info;
    this.modelKey = tab.modelKey;
    this.sheetIdx = tab.sheetIdx;
    this.sel = null;
    this.mode = { kind: "none" };
    this.facts = null;
    this.show();
    this.build();
    this.fit();
    await this.loadModel();
  }

  /** The drawing's name for its tab, and whether it has unsaved changes. */
  get title() { return this.store ? this.fileName || `${this.doc.name}.mcaddrw` : ""; }
  get dirty() { return !!this.store?.dirty; }

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
    if (!this.store) return;
    const src = this.doc.source;
    if (src.kind === "file") return;
    if (src.kind === "part") { const live = this.host.livePart(src.doc.id); if (!live || JSON.stringify(live) === JSON.stringify(src.doc)) return; }
    else { const live = this.host.liveAsm?.(src.doc.id); if (!live || JSON.stringify(live.flat) === JSON.stringify(src.flat)) return; }
    this.stale = true;
    this.renderStatus();
    if (!this.open) return;
    clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => void this.updateFromModel(), 300);
  }

  async updateFromModel() {
    if (!this.store || this.doc.source.kind === "file") return;
    if (this.doc.source.kind === "asm") {
      const la = this.host.liveAsm?.(this.doc.source.doc.id);
      if (la) this.store.change("Update from model", d => { if (d.source.kind === "asm") { d.source.doc = JSON.parse(JSON.stringify(la.doc)); d.source.flat = JSON.parse(JSON.stringify(la.flat)); } });
      await this.loadModel();
      return;
    }
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
          <div class="drw-dd"><button class="btn small" data-a="section" aria-haspopup="menu" aria-expanded="false" title="${esc(t("Section view: draw the cutting line on a view, then place the section"))}">${ICON.section}<span>${esc(t("Section"))}</span> ▾</button>
            <div class="drw-menu" role="menu" hidden>
              <button role="menuitem" data-cut="h">${esc(t("Horizontal cutting line"))}</button>
              <button role="menuitem" data-cut="v">${esc(t("Vertical cutting line"))}</button>
              <button role="menuitem" data-cut="2p">${esc(t("Cutting line through two points"))}</button>
              <button role="menuitem" data-cut="off">${esc(t("Offset section"))}</button>
              <button role="menuitem" data-cut="half">${esc(t("Half section"))}</button>
              <button role="menuitem" data-cut="aligned">${esc(t("Aligned section"))}</button>
            </div></div>
          <div class="drw-dd"><button class="btn small" data-a="detail" aria-haspopup="menu" aria-expanded="false" title="${esc(t("Detail view: click the centre of the circle on a view, then its radius, then place the view"))}">${ICON.detail}<span>${esc(t("Detail"))}</span> ▾</button>
            <div class="drw-menu" role="menu" hidden>
              <button role="menuitem" data-det="circle">${esc(t("Circle"))}</button>
              <button role="menuitem" data-det="profile">${esc(t("Profile"))}</button>
            </div></div>
          <button class="btn small" data-a="aux" title="${esc(t("Auxiliary view: click a straight edge, then place the view square to it"))}">${ICON.aux}<span>${esc(t("Auxiliary"))}</span></button>
          <span class="drw-sep"></span>
          <button class="btn small" data-a="dim" title="${esc(t("Smart dimension (D): click an edge, a circle or two points, then place the dimension"))}">${ICON.dim}<span>${esc(t("Dimension"))}</span></button>
          <div class="drw-dd"><button class="btn small" data-a="annot" aria-haspopup="menu" aria-expanded="false" title="${esc(t("Model items, hole callouts, notes, geometric tolerances, datums, surface finish, tables, balloons and the bill of materials"))}">${ICON.annot}<span>${esc(t("Annotate"))}</span> ▾</button>
            <div class="drw-menu" role="menu" hidden>
              <button role="menuitem" data-an="chain">${esc(t("Chain dimension"))}</button>
              <button role="menuitem" data-an="base">${esc(t("Baseline dimension"))}</button>
              <button role="menuitem" data-an="ord">${esc(t("Ordinate dimension"))}</button>
              <button role="menuitem" data-an="items">${esc(t("Model items"))}</button>
              <button role="menuitem" data-an="hole">${esc(t("Hole callout"))}</button>
              <button role="menuitem" data-an="htable">${esc(t("Hole table"))}</button>
              <button role="menuitem" data-an="note">${esc(t("Note"))}</button>
              <button role="menuitem" data-an="gtol">${esc(t("Geometric tolerance"))}</button>
              <button role="menuitem" data-an="datum">${esc(t("Datum feature"))}</button>
              <button role="menuitem" data-an="surf">${esc(t("Surface finish"))}</button>
              <button role="menuitem" data-an="rev">${esc(t("Revision table"))}</button>
              <button role="menuitem" data-an="table">${esc(t("General table"))}</button>
              <button role="menuitem" data-an="balloon">${esc(t("Balloon"))}</button>
              <button role="menuitem" data-an="auto">${esc(t("Auto balloon"))}</button>
              <button role="menuitem" data-an="bom">${esc(t("Bill of materials"))}</button>
            </div></div>
          <span class="drw-sep"></span>
          <button class="icon" data-a="undo" aria-label="${esc(t("Undo (Ctrl+Z)"))}" title="${esc(t("Undo (Ctrl+Z)"))}">${ICON.undo}</button>
          <button class="icon" data-a="redo" aria-label="${esc(t("Redo (Ctrl+Y)"))}" title="${esc(t("Redo (Ctrl+Y)"))}">${ICON.redo}</button>
          <button class="icon" data-a="fit" aria-label="${esc(t("Fit the sheet (F)"))}" title="${esc(t("Fit the sheet (F)"))}">${ICON.fit}</button>
          <span class="drw-sep"></span>
          <button class="btn small" data-a="save" title="${esc(t("Save the drawing (Ctrl+S)"))}">${ICON.save}<span>${esc(t("Save"))}</span></button>
          <div class="drw-dd"><button class="btn small" data-a="export" aria-haspopup="menu" aria-expanded="false" title="${esc(t("PDF, SVG, DXF, PNG or print"))}">${ICON.exp}<span>${esc(t("Export"))}</span> ▾</button>
            <div class="drw-menu right" role="menu" hidden>
              <button role="menuitem" data-x="pdf">${esc(t("PDF (all sheets)"))}</button>
              <button role="menuitem" data-x="pdf1">${esc(t("PDF (this sheet)"))}</button>
              <button role="menuitem" data-x="svg">${esc(t("SVG (this sheet)"))}</button>
              <button role="menuitem" data-x="dxf">${esc(t("DXF (this sheet)"))}</button>
              <button role="menuitem" data-x="dxf2000">${esc(t("DXF 2000 (this sheet)"))}</button>
              <button role="menuitem" data-x="png">${esc(t("PNG 300 dpi (this sheet)"))}</button>
              <button role="menuitem" data-x="print">${esc(t("Print… (Ctrl+P)"))}</button>
            </div></div>
        </div>
      </div>
      <div class="drw-body">
        <aside class="drw-side" aria-label="${esc(t("Sheets and views"))}">
          <div class="drw-ptabs" role="tablist" aria-label="${esc(t("Palettes"))}">
            <button role="tab" id="drw-pt-views" aria-selected="true" aria-controls="drw-pane-views" data-ptab="views" class="on">${esc(t("View palette"))}</button>
            <button role="tab" id="drw-pt-annot" aria-selected="false" aria-controls="drw-pane-annot" tabindex="-1" data-ptab="annot">${esc(t("Annotation"))}</button>
          </div>
          <div class="drw-pal" id="drw-pane-views" role="tabpanel" aria-labelledby="drw-pt-views">
            <p class="drw-pal-note">${esc(t("Drag a view onto the sheet, or click it and then click the sheet."))}</p>
            <div class="drw-pal-grid">${PALETTE.map(o => `<button class="drw-pt" draggable="true" data-orient="${o}" data-pal="${o}" title="${esc(t("Drag this view onto the sheet"))}"><svg viewBox="0 0 64 64" aria-hidden="true"><path d=""/></svg><span>${esc(t(ORIENT_NAMES[o]))}</span></button>`).join("")}</div>
          </div>
          <div class="drw-pal" id="drw-pane-annot" role="tabpanel" aria-labelledby="drw-pt-annot" hidden>
            <div class="drw-at-grid">${ANNOT_TOOLS.map(([k, label]) => `<button class="btn small drw-at" ${k === "dim" ? 'data-a="dim"' : `data-an="${k}"`}>${esc(t(label))}</button>`).join("")}</div>
          </div>
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
    this.bindPalette();
    // The side panel resizes from its edge and keeps its width (FR-UI-002).
    const side = this.el.querySelector<HTMLElement>(".drw-side")!;
    side.after(makeGrip({ key: "drw-side", axis: "x", sign: 1, def: 280, min: 200, max: () => Math.min(640, window.innerWidth * 0.45), apply: px => { side.style.width = px == null ? "" : `${px}px`; }, label: "Resize the side panel" }));
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
    else if (m.kind === "section" && !m.line && m.how === "aligned") s = t(!m.pts?.length ? "Click the end of the first leg on a view." : m.pts.length === 1 ? "Click the centre: the second leg turns about it into the first leg's plane." : "Click the end of the second leg.");
    else if (m.kind === "section" && !m.line && (m.how === "off" || m.how === "half")) s = !m.pts?.length ? t("Click the first point of the cutting line on a view.") : m.how === "half" ? (m.pts.length === 1 ? t("Click the centre: the cut stops there.") : t("Click where the step ends, square to the cut.")) : m.pts.length === 1 ? t("Click the end of the first cut.") : t("Click the next corner: legs run along or square to the first. Enter or a second click on the last point finishes.");
    else if (m.kind === "section") s = m.line ? t("Move the cursor to the side the section looks from and click to place it. Esc cancels.") : m.how === "2p" ? (m.p1 ? t("Click the second point of the cutting line.") : t("Click the first point of the cutting line on a view.")) : t("Click on a view to place the cutting line. It snaps to circle centres, line ends and midpoints.");
    else if (m.kind === "detail" && m.prof && !m.r) s = (m.pts?.length ?? 0) < 3 ? t("Click the corners of the detail profile on a view.") : t("Click more corners; click the first corner or press Enter to close the profile.");
    else if (m.kind === "detail") s = m.r ? t("Click on the sheet to place the detail view. Esc cancels.") : m.c ? t("Move the cursor to size the circle and click.") : t("Click the centre of the detail circle on a view.");
    else if (m.kind === "crop") s = m.p1 ? t("Click the opposite corner of the crop rectangle.") : t("Click the first corner of the crop rectangle on the view.");
    else if (m.kind === "altpos") s = m.comp ? t("Click where that point of the component goes in its other position.") : t("Click an edge of the component to show in another position.");
    else if (m.kind === "brokenout") s = m.pts.length < 3 ? t("Click the corners of the area to cut away on the view.") : t("Click more corners; click the first corner or press Enter to cut.");
    else if (m.kind === "break") s = m.a != null ? t("Click where the break ends.") : t("Click where the break starts on the view.");
    else if (m.kind === "dim") s = !m.picks.length ? t("Click an edge, a circle or a point of a view. Esc ends.") : t("Click a second edge or point, or click where the dimension goes. Esc ends.");
    else if (m.kind === "dimset") s = !m.picks.length ? t("Click the base point: a corner or a circle centre.") : t("Click the next point. Enter or Esc ends.");
    else if (m.kind === "htable") s = m.origin ? t("Click where the hole table goes.") : t("Click the origin of the hole table on a view: a corner or a circle centre.");
    else if (m.kind === "hole") s = m.e ? t("Click where the callout goes.") : t("Click the edge of a hole.");
    else if (m.kind === "note") s = m.leader ? t("Click where the note goes.") : t("Click where the note goes, or first click an edge for a leader.");
    else if (m.kind === "gtol") s = m.leader ? t("Click where the tolerance frame goes.") : t("Click where the tolerance frame goes, or first click an edge for a leader.");
    else if (m.kind === "datum") s = m.ref ? t("Click where the datum letter goes.") : t("Click the edge of the datum feature.");
    else if (m.kind === "balloon") s = m.ref ? t("Click where the balloon goes.") : t("Click an edge of a component.");
    else if (m.kind === "surf") s = m.ref ? t("Click on the edge to put the symbol there, or away from it for a leader.") : t("Click the edge of the surface, or an empty place on the sheet.");
    else if (m.kind === "aux") s = m.line ? t("Move the cursor to the side of the edge and click to place the auxiliary view. Esc cancels.") : t("Click a straight edge of a view.");
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
      tcontrol: p.tcontrol || "", ncontrol: p.ncontrol || "", litera: p.litera || "",
      scale: scaleText(sheet.scale), sheet: `${this.doc.sheets.indexOf(sheet) + 1}/${this.doc.sheets.length}`,
      size: sheet.size === "custom" ? `${sheetSize(sheet).map(v => Math.round(v)).join("×")}` : sheet.size.replace("ANSI ", ""), units: "mm",
    };
  }

  private projFor(sheet: Sheet, v: DrawingView): Projection | undefined {
    const req = viewReq(sheet, v);
    const p = this.kernel.cache.get(req.key);
    if (!p && this.facts) void this.kernel.request(req).then(() => this.renderSheet(), err => toast(t("A view could not be projected: {err}", { err: (err as Error).message }), true));
    return p;
  }

  /** A view's alternate position lines, asked for when missing. */
  private altFor(sheet: Sheet, v: DrawingView): Projection | undefined {
    const req = altReq(sheet, v);
    if (!req) return undefined;
    const p = this.kernel.cache.get(req.key);
    if (!p && this.facts) void this.kernel.alt(req).then(() => this.renderSheet(), err => toast(t("A view could not be projected: {err}", { err: (err as Error).message }), true));
    return p;
  }

  private renderSheet() {
    const sh = this.sheet, [W, H] = sheetSize(sh);
    this.placements.clear();
    this.annotHits = [];
    this.dangling.clear();
    let html = `<rect class="drw-paper" x="0" y="0" width="${W}" height="${H}"/><g class="drw-fmt">${svgBody(formatPrims(sh, this.fields(), s => t(s)), H)}</g>`;
    for (const v of sh.views) {
      const proj = this.projFor(sh, v);
      const pl = placement(sh, v, proj, this.facts?.box ?? null);
      this.placements.set(v.id, pl);
      const r = viewRect(pl);
      let body = svgBody(viewBody(sh, v, proj, pl, (s, p) => t(s, p), undefined, this.altFor(sh, v)), H);
      const an = viewAnnots(sh, v, pl, this.ctx());
      body += `<g class="drw-annots">${svgBody(an.prims, H)}</g>`;
      for (const h of an.hits) this.annotHits.push({ ...h, view: v.id });
      for (const id of an.dangling) this.dangling.add(id);
      if (!proj) body += `<rect class="drw-pending" x="${r[0]}" y="${H - r[3]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}"/>`;
      html += `<g class="drw-view" data-v="${v.id}">${body}</g>`;
    }
    const notes = sheetNotes(sh, (s, p) => t(s, p), this.ctx().dec, this.bom);
    html += `<g class="drw-notes">${svgBody(notes.prims, H)}</g>`;
    this.annotHits.push(...notes.hits);
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
    // Annotations whose edge is gone (FR-DRW-026), in the warning colour; on screen only.
    for (const h of this.annotHits) if (this.dangling.has(h.id)) s += `<rect class="drw-dangle" x="${h.box[0] - 0.6}" y="${H - h.box[3] - 0.6}" width="${h.box[2] - h.box[0] + 1.2}" height="${h.box[3] - h.box[1] + 1.2}"><title>${esc(t("Its model edge is gone: pick it again or delete it."))}</title></rect>`;
    if (this.selA) for (const h of this.annotHits) if (h.id === this.selA) s += `<rect class="drw-sel" x="${h.box[0] - 1}" y="${H - h.box[3] - 1}" width="${h.box[2] - h.box[0] + 2}" height="${h.box[3] - h.box[1] + 2}"/>`;
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
    if (this.drag?.moved || this.mode.kind === "model") for (const [x1, y1, x2, y2] of this.guides) s += `<line class="drw-guide" x1="${x1}" y1="${H - y1}" x2="${x2}" y2="${H - y2}"/>`;
    s += this.modeMarks(H) + this.annotPreview(H);
    g.innerHTML = s;
  }

  /** The sheet with an extra (preview) view, so its direction and scale resolve. */
  private sheetWith(v: DrawingView): Sheet { return { ...this.sheet, views: [...this.sheet.views, v] }; }

  /** The view the current command would place at the cursor. */
  private previewView(): { view: DrawingView; parent?: string } | null {
    const m = this.mode;
    if (m.kind === "section" && m.parent && m.line && m.at) return { view: this.sideViewAt("section", m.parent, m.line, m.at, m.path, m.how === "aligned"), parent: m.parent };
    if (m.kind === "aux" && m.parent && m.line && m.at) return { view: this.sideViewAt("aux", m.parent, m.line, m.at), parent: m.parent };
    if (m.kind === "detail" && m.parent && m.c && m.r && m.at) {
      const par = findView(this.sheet, m.parent);
      return { view: { id: "_pv", name: "", kind: "detail", parent: m.parent, c: m.c, r: m.r, ...(m.outline ? { outline: m.outline } : {}), x: m.at[0], y: m.at[1], letter: nextLetter(this.doc.sheets), style: par?.style, tangent: par?.tangent } };
    }
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
    if (m.kind === "section" || m.kind === "detail" || m.kind === "aux") { this.kindClick(m, p); return; }
    if (m.kind === "crop" || m.kind === "break") { this.trimClick(m, p); return; }
    if (m.kind === "brokenout") { this.brokenClick(m, p); return; }
    if (m.kind === "altpos") { this.altClick(m, p); return; }
    if (isAnnotMode(m)) { this.annotClick(m, p); return; }
    if (m.kind === "projected") {
      if (!m.parent) { const id = this.viewAt(p); if (id) { m.parent = id; this.sel = id; m.at = p; this.renderStatus(); this.renderOverlay(); } return; }
      const v = this.projectedAt(m.parent, p);
      if (v) this.placeProjected(v); else { const id = this.viewAt(p); if (id) { m.parent = id; this.sel = id; this.renderOverlay(); } }
      return;
    }
    const aid = this.annotAt(p);
    if (aid) {
      const a = this.annot(aid)!, pl = a.view ? this.placements.get(a.view) : undefined;
      this.sel = null; this.selA = aid;
      this.adrag = { id: aid, start: p, orig: [...a.pos] as Pt, s: pl?.s ?? 1, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      this.renderTree(); this.renderProps(); this.renderOverlay();
      return;
    }
    if (this.selA) { this.selA = null; this.renderProps(); }
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
    if (this.adrag) {
      const d = this.adrag;
      if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 0.5) return;
      d.moved = true;
      this.renderAnnotDrag(p);
      return;
    }
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
    if (m.kind === "model") { const s = this.infer(p, new Set()); m.at = s.p; this.guides = s.guides; this.renderOverlay(); return; }
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
    if (Array.isArray(ax)) { const k = dx * ax[0] + dy * ax[1]; dx = k * ax[0]; dy = k * ax[1]; }
    // A projected view stays on its side of the parent: across it, it would still be the same view (its side
    // and the projection type say which), now in the wrong place for first or third angle.
    const par = v.parent && !v.kind && v.side ? o.get(v.parent) : undefined;
    if (par && v.side) {
      const p0 = o.get(id)!, gap = 5;
      if (v.side[0]) { const rel = (p0[0] + dx - par[0]) * v.side[0]; if (rel < gap) dx += (gap - rel) * v.side[0]; }
      if (v.side[1]) { const rel = (p0[1] + dy - par[1]) * v.side[1]; if (rel < gap) dy += (gap - rel) * v.side[1]; }
    }
    const visit = (vid: string) => {
      const p = o.get(vid)!;
      out.set(vid, [p[0] + dx, p[1] + dy]);
      for (const c of sh.views) if (c.parent === vid && !c.free && !out.has(c.id)) visit(c.id);
    };
    visit(id);
    // A free view lines up with the others' centres when it comes close (inference lines, FR-UI-072).
    this.guides = [];
    if (!ax) {
      const p0 = o.get(id)!, s = this.infer([p0[0] + dx, p0[1] + dy], new Set(out.keys()));
      if (s.guides.length) { dx = s.p[0] - p0[0]; dy = s.p[1] - p0[1]; out.clear(); visit(id); this.guides = s.guides; }
    }
    return out;
  }

  /** Lines a point up with the centres of the views on the sheet (except `skip`) within a few pixels. */
  private guides: [number, number, number, number][] = [];
  private infer(p: [number, number], skip: Set<string>): { p: [number, number]; guides: [number, number, number, number][] } {
    const rc = this.svg.getBoundingClientRect();
    const tol = 6 * (rc.width ? this.vb.w / rc.width : 0.5);
    let bx: { d: number; x: number; y: number } | null = null, by: { d: number; x: number; y: number } | null = null;
    for (const [id, pl] of this.placements) {
      if (skip.has(id) || !findView(this.sheet, id)) continue;
      const dx = Math.abs(pl.x - p[0]), dy = Math.abs(pl.y - p[1]);
      if (dx < tol && (!bx || dx < bx.d)) bx = { d: dx, x: pl.x, y: pl.y };
      if (dy < tol && (!by || dy < by.d)) by = { d: dy, x: pl.x, y: pl.y };
    }
    const q: [number, number] = [bx ? bx.x : p[0], by ? by.y : p[1]];
    const guides: [number, number, number, number][] = [];
    if (bx) guides.push([bx.x, bx.y, q[0], q[1]]);
    if (by) guides.push([by.x, by.y, q[0], q[1]]);
    return { p: q, guides };
  }

  private onUp(e: PointerEvent) {
    if (this.pan) { this.pan = null; this.svg.classList.remove("panning"); try { this.svg.releasePointerCapture(e.pointerId); } catch { /* gone */ } return; }
    if (this.adrag) {
      const d = this.adrag;
      this.adrag = null;
      try { this.svg.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      if (!d.moved) return;
      const p = this.sheetPt(e), np: Pt = [round(d.orig[0] + (p[0] - d.start[0]) / d.s), round(d.orig[1] + (p[1] - d.start[1]) / d.s)];
      this.store!.change("Move annotation", doc => { const a = (doc.sheets[this.sheetIdx].annots ?? []).find(x => x.id === d.id); if (a) a.pos = np; });
      return;
    }
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

  // ---------- view palette (FR-UI-072) ----------

  private palRun = 0;

  /** Draws the palette's pictures from the model's projections (the kernel keeps them for the views). */
  private async renderPalette() {
    const run = ++this.palRun;
    for (const o of PALETTE) {
      let d = "";
      try { d = thumbPath(await this.kernel.project(ORIENTS[o])); } catch { /* left blank */ }
      if (run !== this.palRun) return;
      this.el.querySelector(`[data-pal="${o}"] path`)?.setAttribute("d", d);
    }
  }

  /** Dragging a palette view over the sheet previews it under the cursor; dropping places it. */
  private bindPalette() {
    let dragged: Orient | null = null;
    this.el.querySelector(".drw-pal-grid")!.addEventListener("dragstart", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pal]"), de = e as DragEvent;
      if (!b || !de.dataTransfer) return;
      if (!this.facts) { e.preventDefault(); toast(t("The drawing's model is still loading.")); return; }
      dragged = b.dataset.pal as Orient;
      de.dataTransfer.setData(PALETTE_MIME, dragged);
      de.dataTransfer.effectAllowed = "copy";
      this.cancelMode();
      this.mode = { kind: "model", orient: dragged, dir: ORIENTS[dragged as Exclude<Orient, "current">], at: null };
      this.renderStatus();
    });
    this.el.addEventListener("dragend", () => {
      if (dragged && this.mode.kind === "model" && this.mode.orient === dragged) this.cancelMode();
      dragged = null;
    });
    this.svg.addEventListener("dragover", e => {
      if (!dragged || this.mode.kind !== "model") return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      const s = this.infer(this.sheetPt(e), new Set());
      this.mode.at = s.p;
      this.guides = s.guides;
      this.renderOverlay();
    });
    this.svg.addEventListener("dragleave", () => { if (this.mode.kind === "model") { this.mode.at = null; this.renderOverlay(); } });
    this.svg.addEventListener("drop", e => {
      if (!dragged || this.mode.kind !== "model") return;
      e.preventDefault();
      const m = this.mode;
      dragged = null;
      this.placeModel(m, this.sheetPt(e));
      this.svg.focus({ preventScroll: true });
    });
  }

  private placeModel(m: Extract<Mode, { kind: "model" }>, p: [number, number]) {
    p = this.infer(p, new Set()).p;
    this.guides = [];
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

  // ---------- annotations: dimensions, hole callouts, notes (FR-DRW-020..023) ----------

  private ctx(sh: Sheet = this.sheet): AnnotCtx {
    const f = this.facts;
    if (this.store) { useStyle(this.doc.style); useProps(this.fields(sh) as unknown as Record<string, string>); }
    return { ...factsCtx(f), dec: lang() === "ru" ? "," : ".", label: (s, p) => t(s, p), bom: this.bomFor(sh), forView: v => { const c = viewConfig(sh, v), g = c && this.kernel.configs.get(c); return g ? factsCtx(g) : null; } };
  }

  /** The model facts a view draws on: its part configuration's (FR-DRW-010) once built, else the loaded model's. */
  private factsOf(view: string, sh = this.sheet): ModelFacts | null {
    const v = findView(sh, view), c = v && viewConfig(sh, v), f = (c && this.kernel.configs.get(c)) || this.facts, only = v && viewOnly(sh, v);
    return f && only ? { ...f, topo: topoOnly(f.topo, only) } : f;
  }

  private annot(id: string): Annot | undefined { return (this.sheet.annots ?? []).find(a => a.id === id); }

  private annotAt(p: Pt): string | null {
    for (let i = this.annotHits.length - 1; i >= 0; i--) {
      const h = this.annotHits[i], m = 0.8;
      if (p[0] >= h.box[0] - m && p[0] <= h.box[2] + m && p[1] >= h.box[1] - m && p[1] <= h.box[3] + m) return h.id;
    }
    return null;
  }

  /** Redraws a dragged annotation at the cursor (the rest of the sheet stays). */
  private renderAnnotDrag(p: Pt) {
    const d = this.adrag!, a = this.annot(d.id);
    if (!a) return;
    const moved = { ...a, pos: [d.orig[0] + (p[0] - d.start[0]) / d.s, d.orig[1] + (p[1] - d.start[1]) / d.s] as Pt } as Annot;
    const sh = { ...this.sheet, annots: (this.sheet.annots ?? []).map(x => (x.id === d.id ? moved : x)) };
    const H = sheetSize(sh)[1];
    let prims: Prim[] = [];
    if (moved.view) { const v = findView(sh, moved.view), pl = this.placements.get(moved.view); if (v && pl) prims = viewAnnots({ ...sh, annots: [moved] }, v, pl, { ...this.ctx(), topo: this.ctx().topo && { ...this.ctx().topo!, cyls: [] } }).prims.filter(x => !AUTO_LAYERS.has(x.layer)); }
    else prims = sheetNotes({ ...sh, annots: [moved] }, (s, p) => t(s, p), this.ctx().dec, this.bom).prims;
    const host = moved.view ? this.svg.querySelector(`.drw-view[data-v="${moved.view}"] .drw-annots`) : this.svg.querySelector(".drw-notes");
    if (!host) return;
    // Draw everything but the dragged one from the stored sheet, then the dragged one where it is now.
    let rest: Prim[];
    if (moved.view) { const v = findView(sh, moved.view)!, pl = this.placements.get(moved.view)!; rest = viewAnnots({ ...this.sheet, annots: (this.sheet.annots ?? []).filter(x => x.id !== d.id) }, v, pl, this.ctx()).prims; }
    else rest = sheetNotes({ ...this.sheet, annots: (this.sheet.annots ?? []).filter(x => x.id !== d.id) }, (s, p) => t(s, p), this.ctx().dec, this.bom).prims;
    host.innerHTML = svgBody(rest, H) + `<g class="drw-adrag">${svgBody(prims, H)}</g>`;
  }

  private startAnnot(kind: AnnotMode["kind"], how: "chain" | "base" | "ord" = "chain") {
    const free = kind === "note" || kind === "gtol" || kind === "surf";
    if (kind === "balloon" && !this.bom) { toast(t("Balloons and the bill of materials are for drawings of an assembly."), true); return; }
    if (!free && !this.facts) { toast(t("The drawing's model is still loading.")); return; }
    if (!free && !this.sheet.views.length) { toast(t("Place a model view first."), true); return; }
    if (kind === "dim") this.mode = { kind, view: null, picks: [], at: null };
    else if (kind === "dimset") this.mode = { kind, how, view: null, picks: [], axis: null, at: null };
    else if (kind === "hole") this.mode = { kind, view: null, e: null, at: null };
    else if (kind === "htable") this.mode = { kind, view: null, origin: null, holes: [], at: null };
    else if (kind === "datum" || kind === "surf" || kind === "balloon") this.mode = { kind, view: null, ref: null, at: null };
    else this.mode = { kind, view: null, leader: null, at: null };
    this.sel = null; this.selA = null;
    this.renderStatus(); this.renderProps(); this.renderOverlay();
  }

  /** The point, line or circle of a view's model under a sheet point (points first), within the snap distance. */
  private pickAt(viewId: string, p: Pt, only?: "circle"): Pick | null {
    const v = findView(this.sheet, viewId), pl = this.placements.get(viewId), topo = this.factsOf(viewId)?.topo;
    if (!v || !pl || !topo) return null;
    const { P, n } = projector(viewDir(this.sheet, v));
    const tol = this.snapTol();
    const S = (q: [number, number, number]) => toSheet(pl, ...P(q));
    const inDetail = (q: Pt) => v.kind !== "detail" || (v.outline && v.outline.length >= 6 ? inPoly(v.outline, q[0], q[1]) : !v.c || !v.r || Math.hypot(q[0] - v.c[0], q[1] - v.c[1]) <= v.r);
    const endOn = (e: MEdge) => e.t === "c" && !!e.ax && Math.abs(Math.abs(e.ax[0] * n[0] + e.ax[1] * n[1] + e.ax[2] * n[2]) - 1) < 1e-6;
    let best: Pick | null = null, bd = tol;
    if (!only) for (const e of topo.edges) {
      // Ends of an edge seen end-on (a cylinder's seam) are not corners of the view.
      if (e.t !== "c") { const a = P(e.a), b = P(e.b); if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue; }
      const cands: [Pick["ref"], [number, number, number]][] = e.t === "c" ? (endOn(e) && e.c ? [[edgeRef(e, "c"), e.c]] : []) : [[edgeRef(e, "a"), e.a], [edgeRef(e, "b"), e.b]];
      for (const [ref, q] of cands) {
        if (!inDetail(P(q))) continue;
        const d = Math.hypot(...(([x, y]) => [x - p[0], y - p[1]])(S(q)));
        if (d < bd) { bd = d; best = { kind: "pt", ref, e }; }
      }
    }
    if (best) return best;
    bd = tol;
    for (const e of topo.edges) {
      if (e.t === "l" && !only) {
        const a = S(e.a), b = S(e.b), dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        if (L2 < 1e-6) continue;
        const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
        const q: Pt = [a[0] + dx * k, a[1] + dy * k], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bd && inDetail(fromSheet(pl, q[0], q[1]))) { bd = d; best = { kind: "line", ref: edgeRef(e, "e"), e }; }
      } else if (endOn(e) && e.c && e.r) {
        const c = S(e.c), R = e.r * pl.s, d = Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - R);
        if (d < bd && inDetail(fromSheet(pl, p[0], p[1]))) { bd = d; best = { kind: "circle", ref: edgeRef(e, "e"), e }; }
      }
    }
    return best;
  }

  /** The dimension the picks and the cursor make (FR-DRW-021), SolidWorks style: the cursor's side picks horizontal, vertical or aligned. */
  private buildDim(viewId: string, picks: Pick[], at: Pt): DimAnnot | null {
    const pl = this.placements.get(viewId), v = findView(this.sheet, viewId);
    if (!pl || !v || !picks.length) return null;
    const { P } = projector(viewDir(this.sheet, v));
    const pos = fromSheet(pl, at[0], at[1]);
    const base = { id: "_pd", t: "dim" as const, view: viewId, pos: [round(pos[0]), round(pos[1])] as Pt };
    const [p0, p1] = picks;
    if (picks.length === 1) {
      if (p0.kind === "circle") return { ...base, k: (p0.e.sp ?? 0) >= 2 * Math.PI - 1e-3 ? "dia" : "rad", refs: [p0.ref] };
      if (p0.kind === "pt") return null;
    }
    if (p0.kind === "line" && p1?.kind === "line") {
      const d = (e: MEdge) => { const a = P(e.a), b = P(e.b); const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
      const u = d(p0.e), w = d(p1.e);
      return { ...base, k: Math.abs(u[0] * w[1] - u[1] * w[0]) < 1e-6 ? "al" : "ang", refs: [p0.ref, p1.ref] };
    }
    const asPoint = (pk: Pick): GeoRef => (pk.kind === "circle" ? edgeRef(pk.e, "c") : pk.ref);
    if (p1 && (p0.kind === "line" || p1.kind === "line")) return { ...base, k: "al", refs: [p0.kind === "line" ? p0.ref : asPoint(p0), p1.kind === "line" ? p1.ref : asPoint(p1)] };
    const refs = picks.length === 1 ? [p0.ref] : [asPoint(p0), asPoint(p1)];
    const g = dimGeo({ ...base, k: "al", refs }, P, this.factsOf(viewId)?.topo ?? null);
    if (!g) return null;
    const [a, b] = g.pts, x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const flatY = y1 - y0 < 1e-6, flatX = x1 - x0 < 1e-6;
    let k: DimAnnot["k"];
    if (flatY) k = "h";
    else if (flatX) k = "v";
    else if (pos[0] >= x0 && pos[0] <= x1 && (pos[1] > y1 || pos[1] < y0)) k = "h";
    else if (pos[1] >= y0 && pos[1] <= y1 && (pos[0] > x1 || pos[0] < x0)) k = "v";
    else k = "al";
    return { ...base, k, refs };
  }

  /** The holes a view shows end-on (inside a detail view's circle), as edge references for a hole table. */
  private viewHoleRefs(viewId: string): GeoRef[] {
    const v = findView(this.sheet, viewId);
    if (!v) return [];
    const { P, n } = projector(viewDir(this.sheet, v));
    const inDetail = (q: Pt) => v.kind !== "detail" || (v.outline && v.outline.length >= 6 ? inPoly(v.outline, q[0], q[1]) : !v.c || !v.r || Math.hypot(q[0] - v.c[0], q[1] - v.c[1]) <= v.r);
    return holeEdges(this.factsOf(viewId)?.topo ?? null, P, n, inDetail).map(e => edgeRef(e, "e"));
  }

  /** A point for chain, baseline and ordinate dimensions: a corner or a circle's centre (a line is no point). */
  private pointAt(viewId: string, p: Pt): GeoRef | null {
    const pk = this.pickAt(viewId, p);
    return !pk || pk.kind === "line" ? null : pk.kind === "circle" ? edgeRef(pk.e, "c") : pk.ref;
  }

  /** The dimensions one more point adds to a chain, baseline or ordinate set (FR-DRW-021), placed clear of the view:
   *  horizontal ones above it, vertical ones to its right, baseline ones stacked 7 mm apart. The axis comes from the first step. */
  private dimSetNext(m: Extract<AnnotMode, { kind: "dimset" }>, ref: GeoRef): { dims: DimAnnot[]; axis: "h" | "v" } | null {
    const vid = m.view, v = vid ? findView(this.sheet, vid) : undefined, pl = vid ? this.placements.get(vid) : undefined, topo = (vid ? this.factsOf(vid) : this.facts)?.topo ?? null;
    if (!vid || !v || !pl || !m.picks.length) return null;
    const { P } = projector(viewDir(this.sheet, v));
    const pt = (r: GeoRef) => { const q = refPoint(r, topo); return q ? P(q) : null; };
    const q0 = pt(m.picks[0]), ql = pt(m.picks[m.picks.length - 1]), q = pt(ref);
    if (!q0 || !ql || !q || Math.hypot(q[0] - ql[0], q[1] - ql[1]) < 1e-6) return null;
    const axis = m.axis ?? (Math.abs(q[0] - q0[0]) >= Math.abs(q[1] - q0[1]) ? "h" : "v");
    const n = m.picks.length - 1, gap = 8 / pl.s, step = 7 / pl.s, [, , bx1, by1] = pl.box;
    const pos = (a: [number, number], b: [number, number], k: number): Pt => axis === "h" ? [round((a[0] + b[0]) / 2), round(by1 + gap + k * step)] : [round(bx1 + gap + k * step), round((a[1] + b[1]) / 2)];
    const dim = (refs: GeoRef[], k: DimAnnot["k"], at: Pt): DimAnnot => ({ id: uid("a_"), t: "dim", view: vid, k, refs, pos: at });
    const dims: DimAnnot[] = [];
    if (m.how === "chain") dims.push(dim([m.picks[n], ref], axis, pos(ql, q, 0)));
    else if (m.how === "base") dims.push(dim([m.picks[0], ref], axis, pos(q0, q, n)));
    else {
      const k = axis === "h" ? "oh" : "ov", at = (w: [number, number]): Pt => axis === "h" ? [round(w[0]), round(by1 + gap)] : [round(bx1 + gap), round(w[1])];
      if (!n) dims.push(dim([m.picks[0], m.picks[0]], k, at(q0)));
      dims.push(dim([m.picks[0], ref], k, at(q)));
    }
    return { dims, axis };
  }

  private annotClick(m: AnnotMode, p: Pt) {
    const vid = m.view ?? this.viewAt(p);
    if (m.kind === "dim") {
      if (!vid) return;
      const pick = this.pickAt(vid, p);
      const same = (a: Pick, b: Pick) => JSON.stringify(a.ref) === JSON.stringify(b.ref);
      if (!m.picks.length) { if (!pick) return; m.view = vid; m.picks = [pick]; }
      else if (pick && m.picks.length === 1 && !same(pick, m.picks[0]) && !(m.picks[0].kind === "circle" && pick.kind === "circle" && pick.e === m.picks[0].e)) m.picks.push(pick);
      else {
        const d = this.buildDim(m.view!, m.picks, p);
        if (!d) return;
        this.addAnnot({ ...d, id: uid("a_") }, "Dimension");
        m.picks = []; m.view = null;
      }
    } else if (m.kind === "htable") {
      if (!m.origin) {
        if (!vid) return;
        const ref = this.pointAt(vid, p);
        if (!ref) { toast(t("Click a point: a corner or a circle centre.")); return; }
        const holes = this.viewHoleRefs(vid);
        if (!holes.length) { toast(t("This view shows no holes end-on."), true); return; }
        m.view = vid; m.origin = ref; m.holes = holes;
        this.renderStatus();
      } else {
        const pl = this.placements.get(m.view!)!, pos = fromSheet(pl, p[0], p[1]);
        this.addAnnot({ id: uid("a_"), t: "htable", view: m.view!, origin: m.origin, holes: m.holes, pos: [round(pos[0]), round(pos[1])] }, "Hole table");
        this.mode = { kind: "none" };
      }
    } else if (m.kind === "dimset") {
      if (!vid) return;
      const ref = this.pointAt(vid, p);
      if (!ref) { toast(t("Click a point: a corner or a circle centre.")); return; }
      if (!m.picks.length) { m.view = vid; m.picks = [ref]; this.renderStatus(); return; }
      const next = this.dimSetNext(m, ref);
      if (!next) return;
      m.axis = next.axis; m.picks.push(ref);
      this.store!.change(m.how === "ord" ? "Ordinate dimension" : m.how === "base" ? "Baseline dimension" : "Chain dimension", d => { (d.sheets[this.sheetIdx].annots ??= []).push(...next.dims); });
    } else if (m.kind === "hole") {
      if (!m.e) {
        if (!vid) return;
        const pick = this.pickAt(vid, p, "circle");
        if (!pick) { toast(t("Click the edge of a hole.")); return; }
        m.view = vid; m.e = pick.e;
      } else {
        const pl = this.placements.get(m.view!)!, pos = fromSheet(pl, p[0], p[1]);
        this.addAnnot({ id: uid("a_"), t: "hole", view: m.view!, ref: edgeRef(m.e, "e"), pos: [round(pos[0]), round(pos[1])] }, "Hole callout");
        this.mode = { kind: "none" };
      }
    } else if (m.kind === "gtol") {
      if (!m.leader && vid && this.facts) {
        const pick = this.pickAt(vid, p);
        if (pick) { m.view = vid; m.circle = pick.kind === "circle"; m.leader = pick.kind === "circle" ? { ...pick.ref, p: "e" } : pick.kind === "line" ? { ...pick.ref, p: "e" } : pick.ref; this.renderStatus(); this.renderOverlay(); return; }
      }
      const view = m.view ?? vid ?? undefined, pl = view ? this.placements.get(view) : undefined;
      const pos: Pt = pl ? fromSheet(pl, p[0], p[1]) : p;
      const row: GRow = m.circle ? { sym: "pos", tol: "0.1", dia: true, datums: ["A", "B"] } : { sym: m.leader ? "perp" : "flat", tol: "0.05", datums: m.leader ? ["A"] : [] };
      if (!m.leader) row.sym = "flat";
      this.addAnnot({ id: uid("a_"), t: "gtol", ...(view ? { view } : {}), pos: [round(pos[0]), round(pos[1])], rows: [row], ...(m.leader ? { leader: m.leader } : {}) }, "Geometric tolerance");
      this.mode = { kind: "none" };
    } else if (m.kind === "balloon") {
      if (!m.ref) {
        const pick = vid ? this.pickAt(vid, p) : null;
        const e = pick?.e;
        if (!e || !compOfKey(e.k)) { toast(t("Click an edge of a component.")); return; }
        m.view = vid; m.ref = edgeRef(e, "e");
        this.renderStatus(); this.renderOverlay(); return;
      }
      const pl = this.placements.get(m.view!)!, pos = fromSheet(pl, p[0], p[1]);
      this.addAnnot({ id: uid("a_"), t: "balloon", view: m.view!, ref: m.ref, pos: [round(pos[0]), round(pos[1])] }, "Balloon");
      m.ref = null; m.view = null;
    } else if (m.kind === "datum" || m.kind === "surf") {
      if (!m.ref) {
        const pick = vid && this.facts ? this.pickAt(vid, p) : null;
        if (pick && pick.kind !== "pt") { m.view = vid; m.ref = pick.ref; this.renderStatus(); this.renderOverlay(); return; }
        if (m.kind === "datum") { toast(t("Click an edge of a view.")); return; }
        // A surface symbol on its own: on the view under the cursor, or on the sheet.
        const pl = vid ? this.placements.get(vid) : undefined, pos: Pt = pl ? fromSheet(pl, p[0], p[1]) : p;
        this.addAnnot({ id: uid("a_"), t: "surf", ...(vid ? { view: vid } : {}), pos: [round(pos[0]), round(pos[1])], proc: "removal", text: "Ra 3.2" }, "Surface finish");
        this.mode = { kind: "none" };
      } else {
        const pl = this.placements.get(m.view!)!;
        let q = p;
        if (m.kind === "surf") { const f = this.footAt(m.view!, m.ref, p); if (f && Math.hypot(f.at[0] - p[0], f.at[1] - p[1]) < this.snapTol() * 1.5) q = f.at; }
        const pos = fromSheet(pl, q[0], q[1]), at: Pt = [round(pos[0]), round(pos[1])];
        if (m.kind === "datum") this.addAnnot({ id: uid("a_"), t: "datum", view: m.view!, ref: m.ref, pos: at, letter: this.nextDatum() }, "Datum feature");
        else this.addAnnot({ id: uid("a_"), t: "surf", view: m.view!, ref: m.ref, pos: at, proc: "removal", text: "Ra 3.2" }, "Surface finish");
        this.mode = { kind: "none" };
      }
    } else {
      if (!m.leader && vid) {
        const pick = this.pickAt(vid, p);
        if (pick) { m.view = vid; m.leader = pick.kind === "circle" ? edgeRef(pick.e, "c") : pick.kind === "line" ? { ...pick.ref, p: "e" } : pick.ref; this.renderStatus(); this.renderOverlay(); return; }
      }
      const text = prompt(t("Note text"), "");
      if (!text?.trim()) return;
      const view = m.view ?? vid ?? undefined, pl = view ? this.placements.get(view) : undefined;
      const pos: Pt = pl ? fromSheet(pl, p[0], p[1]) : p;
      this.addAnnot({ id: uid("a_"), t: "note", ...(view ? { view } : {}), pos: [round(pos[0]), round(pos[1])], text: text.trim(), ...(m.leader ? { leader: m.leader } : {}) }, "Note");
      this.mode = { kind: "none" };
    }
    this.renderStatus();
    this.renderOverlay();
  }

  private addAnnot(a: Annot, label: string) {
    this.store!.change(label, d => { const S = d.sheets[this.sheetIdx]; (S.annots ??= []).push(a); });
    if (a.t !== "dim") { this.selA = a.id; this.renderProps(); }
  }

  /** The next datum letter not used on any sheet (I, O, Q skipped). */
  private nextDatum(): string {
    const used = new Set(this.doc.sheets.flatMap(s => (s.annots ?? []).map(a => (a.t === "datum" ? a.letter : ""))));
    for (const c of "ABCDEFGHJKLMNPRSTUVWXYZ") if (!used.has(c)) return c;
    return "A";
  }

  private footAt(viewId: string, ref: GeoRef, p: Pt) {
    const v = findView(this.sheet, viewId), pl = this.placements.get(viewId);
    if (!v || !pl) return null;
    return edgeFoot(ref, this.factsOf(viewId)?.topo ?? null, projector(viewDir(this.sheet, v)).P, pl, p);
  }

  /** A revision table at the frame's top-right corner, or a general table at its top-left (FR-DRW-024). */
  private insertTable(kind: "rev" | "general") {
    const f = frameOf(this.sheet);
    if (kind === "rev" && (this.sheet.annots ?? []).some(a => a.t === "table" && a.kind === "rev")) { toast(t("The sheet has a revision table already.")); return; }
    const today = new Date().toISOString().slice(0, 10);
    const a: TableAnnot = kind === "rev"
      ? { id: uid("a_"), t: "table", kind, anchor: "tr", pos: [f[2], f[3]], title: "REVISIONS", cols: ["Rev.", "Description", "Date", "Approved"], rows: [["A", t("First issue"), today, ""]] }
      : { id: uid("a_"), t: "table", kind, pos: [f[0] + 10, f[3] - 10], cols: ["Column 1", "Column 2", "Column 3"], rows: [["", "", ""], ["", "", ""]] };
    this.addAnnot(a, kind === "rev" ? "Revision table" : "General table");
  }

  /** A BOM table (FR-DRW-030) on top of the title block, header at the bottom, items upwards; its rows follow the assembly. */
  private insertBom() {
    if (!this.bom) { toast(t("Balloons and the bill of materials are for drawings of an assembly."), true); return; }
    if ((this.sheet.annots ?? []).some(a => a.t === "table" && a.kind === "bom")) { toast(t("The sheet has a bill of materials already.")); return; }
    const [bx, by] = titleBlockAt(this.sheet), [tw, th] = tbSize(this.sheet);
    this.addAnnot({ id: uid("a_"), t: "table", kind: "bom", anchor: "br", pos: [bx + tw, by + th], cols: [...BOM_COLS], rows: [] }, "Bill of materials");
  }

  /** Auto balloon (FR-DRW-030): one balloon per BOM item in the selected view (or the first view), around it. */
  private async autoBalloon() {
    if (!this.bom || !this.facts) { toast(t("Balloons and the bill of materials are for drawings of an assembly."), true); return; }
    const v = this.sheet.views.find(x => x.id === this.sel) ?? this.sheet.views.find(x => x.kind !== "detail");
    if (!v) { toast(t("Place a model view first."), true); return; }
    const proj = await this.kernel.request(viewReq(this.sheet, v)).catch(() => null);
    if (!proj || !this.facts) return;
    const add = autoBalloons(this.sheet, v, this.facts.topo, projector(viewDir(this.sheet, v)).P, proj, viewScale(this.sheet, v), this.bom, () => uid("a_"));
    if (!add.length) { toast(t("Every item already has a balloon in the view.")); return; }
    this.store!.change("Auto balloon", d => { const S = d.sheets[this.sheetIdx]; (S.annots ??= []).push(...add); });
    toast(t("{n} balloon added|{n} balloons added", { n: add.length }), "success");
  }

  /** What an annotation command shows before it is placed: the hovered entity, the picks and the preview. */
  private annotPreview(H: number): string {
    const m = this.mode;
    if (!isAnnotMode(m)) return "";
    const at = m.at;
    const vid = m.view ?? (at ? this.viewAt(at) : null);
    const pl = vid ? this.placements.get(vid) : undefined, v = vid ? findView(this.sheet, vid) : undefined;
    if (!vid || !pl || !v || !at) return "";
    const { P } = projector(viewDir(this.sheet, v));
    const S = (q: [number, number, number]) => toSheet(pl, ...P(q));
    const show = (pk: Pick, cls: string) => {
      if (pk.kind === "pt") { const q = S(pk.ref && "pt" in pk.ref ? pk.ref.pt : (pk.ref.p === "c" ? pk.e.c! : pk.ref.p === "a" ? pk.e.a : pk.e.b)); return `<circle class="drw-snap" cx="${q[0]}" cy="${H - q[1]}" r="${this.snapTol() / 2.5}"/>`; }
      if (pk.kind === "line") { const a = S(pk.e.a), b = S(pk.e.b); return `<line class="${cls}" x1="${a[0]}" y1="${H - a[1]}" x2="${b[0]}" y2="${H - b[1]}"/>`; }
      const c = S(pk.e.c!); return `<circle class="${cls}" cx="${c[0]}" cy="${H - c[1]}" r="${pk.e.r! * pl.s}" fill="none"/>`;
    };
    let s = "";
    if (m.kind === "dim") {
      for (const pk of m.picks) s += show(pk, "drw-edge on");
      const hov = this.pickAt(vid, at);
      if (hov && !(m.picks.length >= 2)) s += show(hov, "drw-edge");
      if (m.picks.length) {
        const d = this.buildDim(vid, m.picks, at), g = d && dimGeo(d, P, this.factsOf(vid)?.topo ?? null);
        if (d && g) s += `<g class="drw-preview">${svgBody(dimPrims(d, g, pl, this.ctx().dec).prims, H, "currentColor")}</g>`;
      }
    } else if (m.kind === "htable") {
      if (!m.origin) { const ref = this.pointAt(vid, at), q = ref && refPoint(ref, this.factsOf(vid)?.topo ?? null); if (q) { const w = S(q); s += `<circle class="drw-snap" cx="${w[0]}" cy="${H - w[1]}" r="${this.snapTol() / 2.5}"/>`; } }
      else {
        const pa: Annot = { id: "_pt", t: "htable", view: vid, origin: m.origin, holes: m.holes, pos: fromSheet(pl, at[0], at[1]) };
        s += `<g class="drw-preview">${svgBody(viewAnnots({ ...this.sheet, annots: [pa] }, v, pl, this.ctx()).prims.filter(x => !AUTO_LAYERS.has(x.layer)), H, "currentColor")}</g>`;
      }
    } else if (m.kind === "dimset") {
      const topo = this.factsOf(vid)?.topo ?? null;
      for (const r of m.picks) { const q = refPoint(r, topo); if (q) { const w = S(q); s += `<circle class="drw-snap" cx="${w[0]}" cy="${H - w[1]}" r="${this.snapTol() / 2.5}"/>`; } }
      const ref = this.pointAt(vid, at), q = ref && refPoint(ref, topo);
      if (q) { const w = S(q); s += `<circle class="drw-snap" cx="${w[0]}" cy="${H - w[1]}" r="${this.snapTol() / 2.5}"/>`; }
      const next = ref && this.dimSetNext(m, ref);
      if (next) s += `<g class="drw-preview">${svgBody(next.dims.flatMap(d => { const g = dimGeo(d, P, topo); return g ? dimPrims(d, g, pl, this.ctx().dec).prims : []; }), H, "currentColor")}</g>`;
    } else if (m.kind === "hole") {
      if (!m.e) { const hov = this.pickAt(vid, at, "circle"); if (hov) s += show(hov, "drw-edge"); }
      else {
        const pos = fromSheet(pl, at[0], at[1]);
        const sh = { ...this.sheet, annots: [{ id: "_ph", t: "hole" as const, view: vid, ref: edgeRef(m.e, "e"), pos }] };
        s += `<g class="drw-preview">${svgBody(viewAnnots(sh, v, pl, { ...this.ctx(), topo: { edges: this.factsOf(vid)?.topo.edges ?? [], cyls: this.factsOf(vid)?.topo.cyls ?? [] } }).prims.filter(x => !AUTO_LAYERS.has(x.layer)), H, "currentColor")}</g>`;
      }
    } else if (m.kind === "balloon") {
      if (!m.ref) { const hov = this.pickAt(vid, at); if (hov && compOfKey(hov.e.k)) s += show(hov.kind === "pt" ? { ...hov, kind: hov.e.t === "c" && hov.e.c ? "circle" : "line" } : hov, "drw-edge"); }
      else {
        const pa: Annot = { id: "_pb", t: "balloon", view: vid, ref: m.ref, pos: fromSheet(pl, at[0], at[1]) };
        s += `<g class="drw-preview">${svgBody(viewAnnots({ ...this.sheet, annots: [pa] }, v, pl, { ...this.ctx(), topo: { edges: this.factsOf(vid)?.topo.edges ?? [], cyls: [] } }).prims.filter(x => !AUTO_LAYERS.has(x.layer)), H, "currentColor")}</g>`;
      }
    } else if (m.kind === "datum" || m.kind === "surf") {
      if (!m.ref) { const hov = this.pickAt(vid, at); if (hov && hov.kind !== "pt") s += show(hov, "drw-edge"); }
      else {
        const pos = fromSheet(pl, at[0], at[1]);
        const pa: Annot = m.kind === "datum" ? { id: "_pa", t: "datum", view: vid, ref: m.ref, pos, letter: this.nextDatum() } : { id: "_pa", t: "surf", view: vid, ref: m.ref, pos: (() => { const f = this.footAt(vid, m.ref!, at); return f && Math.hypot(f.at[0] - at[0], f.at[1] - at[1]) < this.snapTol() * 1.5 ? fromSheet(pl, ...f.at) : pos; })(), proc: "removal", text: "Ra 3.2" };
        s += `<g class="drw-preview">${svgBody(viewAnnots({ ...this.sheet, annots: [pa] }, v, pl, { ...this.ctx(), topo: { edges: this.factsOf(vid)?.topo.edges ?? [], cyls: [] } }).prims.filter(x => !AUTO_LAYERS.has(x.layer)), H, "currentColor")}</g>`;
      }
    } else if (!m.leader) { const hov = this.pickAt(vid, at); if (hov) s += show(hov, "drw-edge"); }
    return s;
  }

  /** Model items (FR-DRW-020): the part's driving dimensions, each once, in the view where it reads best. */
  private insertItems() {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    if (!this.facts.items.length) { toast(t("The model has no dimensions to import: model items come from a part's sketches and extrudes."), true); return; }
    const add = placeItems(this.sheet, this.facts.items, v => this.placements.get(v.id)?.box ?? null, () => uid("a_"));
    if (!add.length) { toast(t("Every model item is on the sheet already, or no view shows it square on.")); return; }
    this.store!.change("Model items", d => { const S = d.sheets[this.sheetIdx]; (S.annots ??= []).push(...add); });
    toast(t("{n} model dimension inserted|{n} model dimensions inserted", { n: add.length }), "success");
  }

  private deleteAnnot() {
    const id = this.selA;
    if (!id) return;
    this.selA = null;
    this.store!.change("Delete annotation", d => { const S = d.sheets[this.sheetIdx]; S.annots = (S.annots ?? []).filter(a => a.id !== id); });
  }

  /** The BOM's sub-assembly choice: the whole assembly or one top-level sub-assembly. */
  private subRow(a: TableAnnot): string {
    const src = this.doc.source;
    const subs = src.kind === "asm" ? subsOf(src.doc) : [];
    if (!subs.length) return "";
    return `<label class="drw-f">${esc(t("Of"))}<select data-d="bsub"><option value="">${esc(t("The whole assembly"))}</option>${subs.map(c => `<option value="${esc(c.id)}"${a.sub === c.id ? " selected" : ""} translate="no">${esc(c.name)}</option>`).join("")}</select></label>`;
  }

  /** A balloon's stacked items (FR-DRW-030): each with a remove button, and a list of the items not shown yet. */
  private stackRows(a: BalloonAnnot): string {
    const bom = this.bom;
    if (!bom) return "";
    const item = (c: string) => bom.itemOf(c);
    const own = "e" in a.ref ? compOfKey(a.ref.e) : null;
    const used = new Set([own, ...(a.stack ?? [])].map(c => (c ? item(c) : null)));
    const rows = (a.stack ?? []).map((c, i) => `<div class="row drw-stack"><span>${esc(t("item {n}", { n: item(c) ?? "?" }))}</span><button class="btn small" data-unstack="${i}" aria-label="${esc(t("Remove from the stack"))}">✕</button></div>`).join("");
    const free = bom.rows.filter(r => !used.has(r.item) && r.comp);
    const add = free.length ? `<label class="drw-f">${esc(t("Stack another item"))}<select data-d="bstack"><option value="">—</option>${free.map(r => `<option value="${esc(r.comp)}">${r.item} · ${esc(r.part)}</option>`).join("")}</select></label>` : "";
    return rows || add ? `<p class="drw-note">${esc(t("Stacked balloons"))}</p>${rows}${add}` : "";
  }

  private setAnnot(label: string, fn: (a: Annot) => void) {
    const id = this.selA;
    if (!id) return;
    this.store!.change(label, d => { const a = (d.sheets[this.sheetIdx].annots ?? []).find(x => x.id === id); if (a) fn(a); });
  }

  /** Fit display choice and the ISO 286 limits the code gives at this size (FR-DRW-021). */
  private fitFields(a: DimAnnot, size: number | undefined): string {
    const code = a.tol?.fit ?? "", pair = code.includes("/");
    const show = a.tol?.show ?? "code";
    const sel = `<label class="drw-f">${esc(t("Show"))}<select data-d="fshow"${pair ? " disabled" : ""}>${([["code", "Code"], ["limits", "Deviations"], ["both", "Code and deviations"]] as const).map(([k, l]) => `<option value="${k}"${show === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`;
    const sg = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(3).replace(/^0\.000$/, "0");
    const row = (c: string) => { const l = size != null ? fitLimits(c, size) : null; return l ? `${c}: ${sg(l.up)} / ${sg(l.lo)}` : null; };
    const parts = splitFit(code), codes = [parts.hole, parts.shaft].filter((c): c is string => !!c);
    const rows = codes.map(row);
    const note = !codes.length || rows.some(r => !r)
      ? `<p class="drw-note drw-fitlim">${esc(t("ISO 286 has no limits for this code and size (letters D to S, grades 3 to 14, up to 500 mm)."))}</p>`
      : `<p class="drw-note drw-fitlim" translate="no">${rows.map(r => esc(r!)).join("<br>")}</p>`;
    return sel + note;
  }

  private setTol(tt: Tol["t"] | "") {
    this.setAnnot("Tolerance", a => {
      if (a.t !== "dim") return;
      if (!tt) delete a.tol;
      else a.tol = { t: tt, up: a.tol?.up ?? (tt === "fit" ? undefined : 0.1), lo: a.tol?.lo ?? (tt === "sym" || tt === "fit" ? undefined : 0.1), fit: tt === "fit" ? a.tol?.fit ?? (a.k === "dia" ? "H7" : "h7") : undefined };
    });
  }

  /** Properties of the selected annotation. */
  private annotProps(a: Annot): string {
    const sh = this.sheet;
    if (a.t === "dim") {
      const v = findView(sh, a.view), g = v ? dimGeo(a.src ? { ...a, refs: (() => { const it = this.factsOf(a.view)?.items.find(i => i.src === a.src); return it ? [{ pt: it.p[0] }, { pt: it.p[1] }] : a.refs; })() } : a, projector(viewDir(sh, v)).P, this.factsOf(a.view)?.topo ?? null) : null;
      const val = g ? (g.k === "ang" ? null : dimText({ ...a, tol: undefined, txt: undefined }, g, this.ctx().dec).main) : "?";
      const tol = a.tol?.t ?? "";
      const lin = a.k === "h" || a.k === "v" || a.k === "al";
      // A round edge can be dimensioned as radius, diameter or (an arc) its length; two lines as an angle or a chamfer.
      const e0 = a.refs[0] && !("pt" in a.refs[0]) ? refEdge(a.refs[0], this.factsOf(a.view)?.topo ?? null) : null;
      const kinds: [DimAnnot["k"], string][] | null = (a.k === "rad" || a.k === "dia" || a.k === "arc") && e0?.t === "c"
        ? [["rad", "Radius"], ["dia", "Diameter"], ...((e0.sp ?? 2 * Math.PI) < 2 * Math.PI - 1e-3 ? [["arc", "Arc length"] as [DimAnnot["k"], string]] : [])]
        : a.k === "ang" || a.k === "chamfer" ? [["ang", "Angle"], ["chamfer", "Chamfer"]] : null;
      return `<fieldset class="pm-group"><legend>${esc(t("Dimension"))}</legend>
        ${val != null ? `<p class="drw-note">${esc(t("Value"))}: <b translate="no">${esc(val)}</b>${a.src ? ` · ${esc(t("model item"))}` : ""}</p>` : ""}
        ${kinds ? `<label class="drw-f">${esc(t("Type"))}<select data-d="k">${kinds.map(([k, l]) => `<option value="${k}"${a.k === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>` : ""}
        ${lin ? `<label class="drw-f">${esc(t("Direction"))}<select data-d="k">${(["h", "v", "al"] as const).map(k => `<option value="${k}"${a.k === k ? " selected" : ""}>${esc(t(k === "h" ? "Horizontal" : k === "v" ? "Vertical" : "Aligned"))}</option>`).join("")}</select></label>` : ""}
        <label class="drw-f">${esc(t("Decimals"))}<select data-d="prec"><option value="">${esc(t("Auto"))}</option>${[0, 1, 2, 3].map(n => `<option value="${n}"${a.prec === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="drw-f">${esc(t("Prefix"))}<input data-d="pre" value="${esc(a.pre ?? "")}" translate="no"></label>
        <label class="drw-f">${esc(t("Suffix"))}<input data-d="suf" value="${esc(a.suf ?? "")}" translate="no"></label>
        <label class="drw-f">${esc(t("Text instead of the value"))}<input data-d="txt" value="${esc(a.txt ?? "")}" translate="no"></label>
        <label class="drw-chk"><input type="checkbox" data-d="insp"${a.insp ? " checked" : ""}> ${esc(t("Inspection dimension"))}</label>
      </fieldset>
      <fieldset class="pm-group"><legend>${esc(t("Tolerance"))}</legend>
        <div class="seg drw-seg drw-tolseg" role="radiogroup" aria-label="${esc(t("Tolerance"))}">${([["", "None"], ["sym", "±"], ["dev", "+/−"], ["limit", "Limits"], ["fit", "Fit"]] as const).map(([k, l]) => `<button role="radio" aria-checked="${tol === k}" class="${tol === k ? "on" : ""}" data-tolt="${k}">${esc(t(l))}</button>`).join("")}</div>
        ${tol && tol !== "fit" ? `<label class="drw-f">${esc(t(tol === "sym" ? "Tolerance (±)" : "Upper"))}<input data-d="up" inputmode="decimal" value="${a.tol?.up ?? ""}"></label>` : ""}
        ${tol === "dev" || tol === "limit" ? `<label class="drw-f">${esc(t("Lower"))}<input data-d="lo" inputmode="decimal" value="${a.tol?.lo ?? ""}"></label>` : ""}
        ${tol === "fit" ? `<label class="drw-f">${esc(t("Fit (ISO 286)"))}<input data-d="fit" value="${esc(a.tol?.fit ?? "")}" translate="no" placeholder="H7"></label>${this.fitFields(a, g?.value)}` : ""}
      </fieldset>
      <div class="row"><button class="btn small danger" data-a="adel">${esc(t("Delete"))}</button></div>`;
    }
    if (a.t === "hole") {
      const e = refEdge(a.ref, this.factsOf(a.view)?.topo ?? null), auto = e ? holeText(e, this.ctx()).join("\n") : "";
      return `<fieldset class="pm-group"><legend>${esc(t("Hole callout"))}</legend>
        <label class="drw-f">${esc(t("Text"))}<textarea data-d="htxt" rows="3" translate="no" placeholder="${esc(auto)}">${esc(a.txt ?? "")}</textarea></label>
        <p class="drw-note">${esc(t("Empty: the text comes from the hole."))}</p>
      </fieldset><div class="row"><button class="btn small danger" data-a="adel">${esc(t("Delete"))}</button></div>`;
    }
    const del = `<div class="row"><button class="btn small danger" data-a="adel">${esc(t("Delete"))}</button></div>`;
    if (a.t === "gtol") {
      const rows = a.rows.map((r, i) => `<fieldset class="pm-group drw-grow"><legend>${esc(t("Row {n}", { n: i + 1 }))}</legend>
        ${i > 0 && r.composite ? "" : `<label class="drw-f">${esc(t("Characteristic"))}<select data-d="g:${i}:sym">${GSYMS.map(g => `<option value="${g}"${r.sym === g ? " selected" : ""}>${esc(t(GSYM_NAMES[g]))}</option>`).join("")}</select></label>`}
        <label class="drw-f">${esc(t("Tolerance"))}<input data-d="g:${i}:tol" inputmode="decimal" value="${esc(r.tol)}" translate="no"></label>
        <label class="drw-chk"><input type="checkbox" data-d="g:${i}:dia"${r.dia ? " checked" : ""}> ${esc(t("Diameter zone (Ø)"))}</label>
        <label class="drw-f">${esc(t("Material condition"))}<select data-d="g:${i}:mod"><option value="">${esc(t("None"))}</option><option value="M"${r.mod === "M" ? " selected" : ""}>${esc(t("Maximum (M)"))}</option><option value="L"${r.mod === "L" ? " selected" : ""}>${esc(t("Least (L)"))}</option></select></label>
        ${i > 0 ? `<label class="drw-chk"><input type="checkbox" data-d="g:${i}:comp"${r.composite ? " checked" : ""}> ${esc(t("Composite with the row above"))}</label>` : ""}
        <div class="drw-datums">${[0, 1, 2].map(k => `<label class="drw-f">${esc(t(["Primary datum", "Secondary datum", "Tertiary datum"][k]))}<input data-d="g:${i}:d${k}" value="${esc(r.datums[k] ?? "")}" maxlength="6" translate="no"></label>`).join("")}</div>
        ${a.rows.length > 1 ? `<div class="row"><button class="btn small" data-grow="-${i}">${esc(t("Remove row"))}</button></div>` : ""}
      </fieldset>`).join("");
      return `<fieldset class="pm-group"><legend>${esc(t("Geometric tolerance"))}</legend>${a.leader ? `<p class="drw-note">${esc(t("With a leader to the model."))}</p><label class="drw-chk"><input type="checkbox" data-d="gall"${a.around ? " checked" : ""}> ${esc(t("All around"))}</label>` : ""}</fieldset>${rows}
        <div class="row"><button class="btn small" data-grow="+">${esc(t("Add row"))}</button></div>${del}`;
    }
    if (a.t === "datum") {
      return `<fieldset class="pm-group"><legend>${esc(t("Datum feature"))}</legend>
        <label class="drw-f">${esc(t("Letter"))}<input data-d="dl" value="${esc(a.letter)}" maxlength="2" translate="no"></label>
      </fieldset>${del}`;
    }
    if (a.t === "surf") {
      return `<fieldset class="pm-group"><legend>${esc(t("Surface finish"))}</legend>
        <label class="drw-f">${esc(t("Process"))}<select data-d="sp">${([["any", "Any process"], ["removal", "Material removed"], ["none", "No material removed"]] as const).map(([k, l]) => `<option value="${k}"${a.proc === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>
        <label class="drw-f">${esc(t("Roughness"))}<input data-d="st" value="${esc(a.text)}" translate="no" placeholder="Ra 3.2"></label>
        <label class="drw-f">${esc(t("Production method"))}<input data-d="sm" value="${esc(a.method ?? "")}" translate="no"></label>
      </fieldset>${del}`;
    }
    if (a.t === "balloon") {
      const c = "e" in a.ref ? compOfKey(a.ref.e) : null, item = c && this.bom ? this.bom.itemOf(c) : null;
      const comp = c ? this.facts?.comps?.find(x => x.id === c)?.name ?? c : "";
      return `<fieldset class="pm-group"><legend>${esc(t("Balloon"))}</legend>
        ${comp ? `<p class="drw-note">${esc(t("Component"))}: <b translate="no">${esc(comp)}</b>${item ? ` · ${esc(t("item {n}", { n: item }))}` : ""}</p>` : ""}
        <label class="drw-f">${esc(t("Text instead of the item number"))}<input data-d="btxt" value="${esc(a.txt ?? "")}" translate="no"></label>
        ${this.stackRows(a)}
      </fieldset>${del}`;
    }
    if (a.t === "table" && a.kind === "bom") {
      const head = a.cols.map((c, j) => `<label class="drw-f">${esc(t("Column {n}", { n: j + 1 }))}<input data-d="th:${j}" value="${esc(cellLabel(c, t))}" translate="no"></label>`).join("");
      return `<fieldset class="pm-group"><legend>${esc(t("Bill of materials"))}</legend>
        <p class="drw-note">${esc(t("The rows come from the assembly and follow it."))}</p>
        <label class="drw-f">${esc(t("List"))}<select data-d="bmode"><option value="top"${a.mode !== "parts" ? " selected" : ""}>${esc(t("Top-level only"))}</option><option value="parts"${a.mode === "parts" ? " selected" : ""}>${esc(t("Parts only"))}</option></select></label>${this.subRow(a)}${head}
      </fieldset>${del}`;
    }
    if (a.t === "table") {
      const head = a.cols.map((c, j) => `<th><input data-d="th:${j}" value="${esc(cellLabel(c, t))}" aria-label="${esc(t("Column {n}", { n: j + 1 }))}" translate="no"></th>`).join("");
      const body = a.rows.map((r, i) => `<tr>${a.cols.map((_c, j) => `<td><input data-d="tc:${i}:${j}" value="${esc(r[j] ?? "")}" aria-label="${esc(t("Row {r}, column {c}", { r: i + 1, c: j + 1 }))}" translate="no"></td>`).join("")}</tr>`).join("");
      return `<fieldset class="pm-group"><legend>${esc(t(a.kind === "rev" ? "Revision table" : "General table"))}</legend>
        <label class="drw-f">${esc(t("Title"))}<input data-d="tt" value="${esc(a.title ? cellLabel(a.title, t) : "")}" translate="no"></label>
        <div class="drw-tbl"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
        <div class="row"><button class="btn small" data-trow="+">${esc(t(a.kind === "rev" ? "Add revision" : "Add row"))}</button>${a.rows.length > 1 ? `<button class="btn small" data-trow="-">${esc(t("Remove last row"))}</button>` : ""}${a.kind === "general" ? `<button class="btn small" data-tcol="+">${esc(t("Add column"))}</button>${a.cols.length > 1 ? `<button class="btn small" data-tcol="-">${esc(t("Remove last column"))}</button>` : ""}` : ""}</div>
      </fieldset>${del}`;
    }
    if (a.t === "htable") {
      const v = findView(sh, a.view), n = v ? holeRows(a, projector(viewDir(sh, v)).P, this.ctx()).rows.length : 0;
      return `<fieldset class="pm-group"><legend>${esc(t("Hole table"))}</legend>
        <p class="drw-note">${esc(t("{n} holes, measured from the origin along the view's axes.", { n }))}</p>
        <label class="drw-f">${esc(t("Decimals"))}<select data-d="hprec"><option value="">${esc(t("Auto"))}</option>${[0, 1, 2, 3].map(k => `<option value="${k}"${a.prec === k ? " selected" : ""}>${k}</option>`).join("")}</select></label>
        <div class="row"><button class="btn small" data-a="hupd" title="${esc(t("Take the holes the view shows now, after the model changed"))}">${esc(t("Update holes"))}</button></div>
      </fieldset>${del}`;
    }
    if (a.t !== "note") return del;
    return `<fieldset class="pm-group"><legend>${esc(t("Note"))}</legend>
      <label class="drw-f">${esc(t("Text"))}<textarea data-d="ntxt" rows="4" translate="no">${esc(a.text)}</textarea></label>
      <label class="drw-f">${esc(t("Link to property"))}<select data-d="nprop"><option value="">—</option>${NOTE_PROP_KEYS.map(([k, l]) => `<option value="${k}">${esc(t(l))}</option>`).join("")}</select></label>
      <label class="drw-f">${esc(t("Text height (mm)"))}<select data-d="nh">${[2.5, 3.5, 5, 7].map(h => `<option value="${h}"${(a.h ?? 3.5) === h ? " selected" : ""}>${h}</option>`).join("")}</select></label>
    </fieldset><div class="row"><button class="btn small danger" data-a="adel">${esc(t("Delete"))}</button></div>`;
  }

  private onAnnotInput(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
    const k = el.dataset.d!, val = el.value;
    const num = (s: string) => { const v = parseFloat(s.replace(",", ".")); return isFinite(v) ? v : undefined; };
    this.setAnnot(k === "ntxt" || k === "htxt" ? "Text" : "Annotation property", a => {
      if (a.t === "dim") {
        if (k === "k") a.k = val as DimAnnot["k"];
        else if (k === "insp") { if ((el as HTMLInputElement).checked) a.insp = true; else delete a.insp; }
        else if (k === "prec") { if (val === "") delete a.prec; else a.prec = +val; }
        else if (k === "pre" || k === "suf" || k === "txt") { if (val) a[k] = val; else delete a[k]; }
        else if (a.tol && (k === "up" || k === "lo")) a.tol[k] = num(val);
        else if (a.tol && k === "fit") a.tol.fit = val.trim();
        else if (a.tol && k === "fshow") { if (val === "code") delete a.tol.show; else a.tol.show = val as Tol["show"]; }
      } else if (a.t === "hole" && k === "htxt") { if (val.trim()) a.txt = val; else delete a.txt; }
      else if (a.t === "note" && k === "nprop") { if (val) a.text += `$PRP:"${val}"`; }
      else if (a.t === "note") { if (k === "ntxt" && val.trim()) a.text = val; else if (k === "nh") a.h = +val; }
      else if (a.t === "htable" && k === "hprec") { if (val === "") delete a.prec; else a.prec = +val; }
      else if (a.t === "gtol" && k.startsWith("g:")) {
        const [, si, f] = k.split(":"), r = a.rows[+si];
        if (!r) return;
        if (f === "sym") r.sym = val as GSym;
        else if (f === "tol") r.tol = val.trim().replace(",", ".") || "0";
        else if (f === "dia") { if ((el as HTMLInputElement).checked) r.dia = true; else delete r.dia; }
        else if (f === "comp") { if ((el as HTMLInputElement).checked) { r.composite = true; r.sym = a.rows[+si - 1]?.sym ?? r.sym; } else delete r.composite; }
        else if (f === "mod") { if (val === "M" || val === "L") r.mod = val; else delete r.mod; }
        else if (f[0] === "d") { const d = [0, 1, 2].map(j => r.datums[j] ?? ""); d[+f[1]] = val.trim().toUpperCase(); while (d.length && !d[d.length - 1]) d.pop(); r.datums = d; }
      } else if (a.t === "gtol" && k === "gall") { if ((el as HTMLInputElement).checked) a.around = true; else delete a.around; }
      else if (a.t === "datum" && k === "dl" && val.trim()) a.letter = val.trim().toUpperCase();
      else if (a.t === "balloon" && k === "btxt") { if (val.trim()) a.txt = val.trim(); else delete a.txt; }
      else if (a.t === "balloon" && k === "bstack") { if (val) a.stack = [...(a.stack ?? []), val]; }
      else if (a.t === "table" && a.kind === "bom" && k === "bsub") { if (val) a.sub = val; else delete a.sub; }
      else if (a.t === "table" && a.kind === "bom" && k === "bmode") { if (val === "parts") a.mode = "parts"; else delete a.mode; }
      else if (a.t === "surf") { if (k === "sp") a.proc = val as typeof a.proc; else if (k === "st") a.text = val.trim(); else if (k === "sm") { if (val.trim()) a.method = val.trim(); else delete a.method; } }
      else if (a.t === "table") {
        // Headers and the title keep their English key while unchanged, so they follow the language.
        if (k === "tt") { if (!val.trim()) delete a.title; else if (!(a.title && cellLabel(a.title, t) === val)) a.title = val; }
        else if (k.startsWith("th:")) { const j = +k.slice(3); if (cellLabel(a.cols[j], t) !== val) a.cols[j] = val; }
        else if (k.startsWith("tc:")) { const [, i, j] = k.split(":").map(Number); if (a.rows[i]) a.rows[i][j] = val; }
      }
    });
  }

  // ---------- section, detail and auxiliary views ----------

  private startKind(kind: "section" | "detail" | "aux", how: "h" | "v" | "2p" | "off" | "half" | "aligned" = "h", prof = false) {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    if (!this.sheet.views.length) { toast(t("Place a model view first."), true); return; }
    // The first click picks the view (as in SolidWorks), unless there is only one.
    const parent = this.sheet.views.length === 1 ? this.sheet.views[0].id : null;
    if (kind === "section") this.mode = { kind, how, parent, p1: null, line: null, at: null, pts: [] };
    else if (kind === "detail") this.mode = { kind, parent, c: null, r: null, at: null, ...(prof ? { prof: true, pts: [] } : {}) };
    else this.mode = { kind, parent, line: null, at: null };
    this.renderStatus();
    this.renderOverlay();
  }

  /** Snap distance on the sheet (mm): 8 screen pixels. */
  private snapTol() {
    const w = this.svg.getBoundingClientRect().width;
    return w ? 8 * this.vb.w / w : 2;
  }

  /** The view a step of a section/detail/aux command works on: the chosen parent, else the view under the cursor. */
  private kindParent(m: { parent: string | null }, p: Pt): string | null {
    return m.parent ?? this.viewAt(p);
  }

  /**
   * The model point (parent view axes) under a sheet point, snapped to circle centres,
   * line ends and midpoints of the view's lines, and to the view's centre.
   */
  private snapIn(id: string, p: Pt): { m: Pt; snap: boolean } {
    const pl = this.placements.get(id)!, v = findView(this.sheet, id)!;
    const proj = this.projFor(this.sheet, v);
    const tol = this.snapTol();
    let best: Pt | null = null, bd = tol;
    const tryPt = (u: number, w: number) => {
      const [x, y] = toSheet(pl, u, w), d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd) { bd = d; best = [u, w]; }
    };
    tryPt(...(pl.unsq ? pl.unsq(pl.uc, pl.vc) : [pl.uc, pl.vc] as Pt));
    if (proj) for (const g of [...proj.vis, ...proj.hid]) {
      if (g.k === "l") { tryPt(g.p[0], g.p[1]); tryPt(g.p[2], g.p[3]); tryPt((g.p[0] + g.p[2]) / 2, (g.p[1] + g.p[3]) / 2); }
      else if (g.k === "a") { tryPt(g.o[0], g.o[1]); tryPt(g.o[0] + g.r * Math.cos(g.a0), g.o[1] + g.r * Math.sin(g.a0)); tryPt(g.o[0] + g.r * Math.cos(g.a1), g.o[1] + g.r * Math.sin(g.a1)); }
    }
    return best ? { m: best, snap: true } : { m: fromSheet(pl, p[0], p[1]), snap: false };
  }

  /** The cutting line of a horizontal or vertical section through a model point: across the view. */
  private cutLine(id: string, how: "h" | "v", m: Pt): Line4 {
    const b = this.placements.get(id)!.box;
    return how === "h" ? [b[0], m[1], b[2], m[1]] : [m[0], b[3], m[0], b[1]];
  }

  /** The straight visible edge of a view nearest to a sheet point (model coordinates), within the snap distance. */
  private edgeAt(id: string, p: Pt): Line4 | null {
    const pl = this.placements.get(id), v = findView(this.sheet, id);
    const proj = v && this.projFor(this.sheet, v);
    if (!pl || !proj) return null;
    let best: Line4 | null = null, bd = this.snapTol();
    for (const g of proj.vis) {
      if (g.k !== "l") continue;
      const [ax, ay] = toSheet(pl, g.p[0], g.p[1]), [bx, by] = toSheet(pl, g.p[2], g.p[3]);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      if (L2 < 1e-6) continue;
      const k = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2));
      const d = Math.hypot(ax + dx * k - p[0], ay + dy * k - p[1]);
      if (d < bd) { bd = d; best = [...g.p] as Line4; }
    }
    return best;
  }

  /** A section or auxiliary view of `parent` from `line`, on the cursor's side and lined up square to the line. */
  private sideViewAt(kind: "section" | "aux", parent: string, line: Line4, at: Pt, path?: number[], aligned?: boolean): DrawingView {
    const pp = this.placements.get(parent)!, par = findView(this.sheet, parent);
    const [a, b] = [toSheet(pp, line[0], line[1]), toSheet(pp, line[2], line[3])];
    const n: Pt = [-(b[1] - a[1]), b[0] - a[0]];
    const look: 1 | -1 = (at[0] - a[0]) * n[0] + (at[1] - a[1]) * n[1] >= 0 ? 1 : -1;
    const v: DrawingView = { id: "_pv", name: "", kind, parent, line, look, x: at[0], y: at[1], letter: nextLetter(this.doc.sheets), style: kind === "section" ? "hlr" : par?.style, tangent: par?.tangent };
    if (path) v.path = path;
    if (aligned) v.aligned = true;
    const [x, y] = this.alignedAt(v, at);
    v.x = x; v.y = y;
    return v;
  }

  /**
   * Centre of a section/aux view near `at` that keeps it lined up with its parent: free along the
   * viewing direction q, fixed across it so a model point lands on the same line square to q in both views.
   */
  private alignedAt(v: DrawingView, at: Pt): Pt {
    const pp = this.placements.get(v.parent!);
    if (!pp) return at;
    const q = lookDir(v), r: Pt = [-q[1], q[0]];
    const sh = this.sheetWith(v), vp = placement(sh, v, this.projFor(sh, v), this.facts?.box ?? null);
    const dot = (p: Pt, d: Pt) => p[0] * d[0] + p[1] * d[1];
    const across = dot([pp.x, pp.y], r) - vp.s * (dot([pp.uc, pp.vc], r) - dot([vp.uc, vp.vc], r));
    const along = dot(at, q);
    return [r[0] * across + q[0] * along, r[1] * across + q[1] * along];
  }

  /** Projects both sides of a section/aux line ahead, so the preview has its lines when the cursor gets there. */
  private warmSides(kind: "section" | "aux", parent: string, line: Line4, path?: number[], aligned?: boolean) {
    for (const look of [1, -1] as const) {
      const v: DrawingView = { id: "_pv", name: "", kind, parent, line, look, x: 0, y: 0 };
      if (path) v.path = path;
      if (aligned) v.aligned = true;
      const sh = this.sheetWith(v);
      void this.kernel.request(viewReq(sh, v)).then(() => this.renderOverlay(), () => {});
    }
  }

  private kindClick(m: Extract<Mode, { kind: "section" | "detail" | "aux" }>, p: Pt) {
    const id = this.kindParent(m, p);
    if (m.kind === "section") {
      if (m.line && m.parent) { this.placeKind(this.sideViewAt("section", m.parent, m.line, p, m.path, m.how === "aligned")); return; }
      if (!id || !this.placements.get(id)) return;
      if (m.how === "off" || m.how === "half" || m.how === "aligned") { this.pathClick(m, id, p); return; }
      const sp = this.snapIn(id, p).m;
      if (m.how !== "2p") m.line = this.cutLine(id, m.how, sp);
      else if (!m.p1) { m.parent = id; m.p1 = sp; this.sel = id; this.renderStatus(); this.renderOverlay(); return; }
      else {
        if (Math.hypot(sp[0] - m.p1[0], sp[1] - m.p1[1]) < 1e-6) return;
        m.line = [m.p1[0], m.p1[1], sp[0], sp[1]];
      }
      m.parent = id;
      this.sel = id;
      this.warmSides("section", id, m.line);
    } else if (m.kind === "detail") {
      if (m.r && m.c && m.parent) { const pv = this.previewView(); if (pv) this.placeKind(pv.view); return; }
      if (m.prof) { this.profileClick(m, id, p); return; }
      if (!id || !this.placements.get(id)) return;
      if (!m.c) { m.parent = id; m.c = this.snapIn(id, p).m; this.sel = id; }
      else {
        const pl = this.placements.get(m.parent!)!, [cx, cy] = toSheet(pl, m.c[0], m.c[1]);
        const r = Math.hypot(p[0] - cx, p[1] - cy) / pl.s;
        if (r * pl.s < 1) return;
        m.r = Math.round(r * 100) / 100;
      }
    } else {
      if (m.line && m.parent) { this.placeKind(this.sideViewAt("aux", m.parent, m.line, p)); return; }
      if (!id) return;
      const e = this.edgeAt(id, p);
      if (!e) { toast(t("Click a straight edge of the view.")); return; }
      m.parent = id; m.line = e; this.sel = id;
      this.warmSides("aux", id, e);
    }
    this.renderStatus();
    this.renderOverlay();
  }

  /**
   * The next corner of an offset or half section's path (FR-DRW-012): after the first leg every leg runs along
   * or square to it, whichever is nearer the cursor (a half section's second leg is always square).
   */
  private pathPoint(m: Extract<Mode, { kind: "section" }>, id: string, p: Pt): Pt {
    const sp = this.snapIn(id, p).m, pts = m.pts ?? [];
    if (pts.length < 2 || m.how === "aligned") return sp;
    const [a, b] = pts, last = pts[pts.length - 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, e: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n: Pt = [-e[1], e[0]];
    const dx = sp[0] - last[0], dy = sp[1] - last[1], te = dx * e[0] + dy * e[1], tn = dx * n[0] + dy * n[1];
    // Steps and cuts take turns (a cut runs only forwards along the first leg); a half section stops after one step.
    const prev = pts[pts.length - 2], prevCut = Math.abs((last[0] - prev[0]) * n[0] + (last[1] - prev[1]) * n[1]) < 1e-6;
    const along = m.how !== "half" && !prevCut;
    return along ? [last[0] + e[0] * Math.max(0, te), last[1] + e[1] * Math.max(0, te)] : [last[0] + n[0] * tn, last[1] + n[1] * tn];
  }

  private pathClick(m: Extract<Mode, { kind: "section" }>, id: string, p: Pt) {
    const pts = m.pts ?? (m.pts = []);
    if (!pts.length) { m.parent = id; this.sel = id; pts.push(this.snapIn(id, p).m); this.renderStatus(); this.renderOverlay(); return; }
    if (id !== m.parent) return;
    const q = this.pathPoint(m, id, p), last = pts[pts.length - 1];
    const pl = this.placements.get(id)!, [lx, ly] = toSheet(pl, last[0], last[1]);
    if (Math.hypot(p[0] - lx, p[1] - ly) < this.snapTol() && pts.length >= 3 && m.how !== "aligned") { this.finishPath(m); return; }
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) return;
    pts.push(q);
    if ((m.how === "half" || m.how === "aligned") && pts.length === 3) { this.finishPath(m); return; }
    this.renderStatus(); this.renderOverlay();
  }

  /** The path is done: its first leg is the section's line, and the view is placed next. */
  private finishPath(m: Extract<Mode, { kind: "section" }>) {
    const pts = m.pts ?? [];
    if (pts.length < 2 || !m.parent) return;
    const path = pts.flatMap(q => [Math.round(q[0] * 1e4) / 1e4, Math.round(q[1] * 1e4) / 1e4]);
    if (m.how === "aligned") {
      // Aligned section: end 1, centre, end 2; the first leg is the line the view looks square to.
      if (pts.length !== 3 || !alignedLegs(path)) { toast(t("The two legs of an aligned section must meet at an angle.")); m.pts = pts.slice(0, 2); this.renderStatus(); this.renderOverlay(); return; }
      m.line = [path[0], path[1], path[2], path[3]];
      m.path = path;
      this.warmSides("section", m.parent, m.line, m.path, true);
      this.renderStatus(); this.renderOverlay();
      return;
    }
    m.line = [pts[0][0], pts[0][1], pts[1][0], pts[1][1]];
    m.path = pts.length >= 3 && cutLegs(path) ? path : undefined;
    if (pts.length >= 3 && !m.path) { toast(t("Every leg of the cutting path must run along or square to the first.")); m.line = null; return; }
    this.warmSides("section", m.parent, m.line, m.path);
    this.renderStatus(); this.renderOverlay();
  }

  private placeKind(v: DrawingView) {
    const id = uid("v_"), L = nextLetter(this.doc.sheets);
    const name = v.kind === "section" ? `${t("Section View")} ${L}-${L}` : v.kind === "detail" ? `${t("Detail View")} ${L}` : `${t("Auxiliary View")} ${L}`;
    const label = v.kind === "section" ? "Section view" : v.kind === "detail" ? "Detail view" : "Auxiliary view";
    this.store!.change(label, d => {
      d.sheets[this.sheetIdx].views.push({ ...v, id, name, letter: L, x: round(v.x), y: round(v.y) });
    });
    this.sel = id;
    this.mode = { kind: "none" };
    this.renderAll();
  }

  // ---------- crop and break views (FR-DRW-015) ----------

  private startTrim(kind: "crop" | "break", axis: "u" | "v" = "u") {
    const v = this.sel ? findView(this.sheet, this.sel) : null;
    if (!v || v.kind === "detail" || !this.placements.get(v.id)) { toast(t("Select a view first.")); return; }
    this.mode = kind === "crop" ? { kind, view: v.id, p1: null, at: null } : { kind, view: v.id, axis, a: null, at: null };
    this.renderStatus();
    this.renderOverlay();
  }

  private trimClick(m: Extract<Mode, { kind: "crop" | "break" }>, p: Pt) {
    const pl = this.placements.get(m.view);
    if (!pl) return;
    const q = fromSheet(pl, p[0], p[1]);
    if (m.kind === "crop") {
      if (!m.p1) { m.p1 = q; this.renderStatus(); this.renderOverlay(); return; }
      const c: [number, number, number, number] = [Math.min(m.p1[0], q[0]), Math.min(m.p1[1], q[1]), Math.max(m.p1[0], q[0]), Math.max(m.p1[1], q[1])];
      if ((c[2] - c[0]) * pl.s < 2 || (c[3] - c[1]) * pl.s < 2) return;
      this.mode = { kind: "none" };
      this.setView("Crop view", v => { v.crop = c.map(x => round(x)) as [number, number, number, number]; });
      return;
    }
    const k = m.axis === "u" ? q[0] : q[1];
    if (m.a == null) { m.a = k; this.renderStatus(); this.renderOverlay(); return; }
    const a = Math.min(m.a, k), b = Math.max(m.a, k);
    if ((b - a) * pl.s <= BREAK_GAP) { toast(t("Make the break wider than the gap it closes to.")); return; }
    const axis = m.axis;
    this.mode = { kind: "none" };
    this.setView("Break view", v => { (v.breaks ??= []).push({ axis, a: round(a), b: round(b) }); });
  }

  // ---------- broken-out section (FR-DRW-015) ----------

  /** Where the model starts and ends along a view's direction (n · p over the model box). */
  private depthRange(v: DrawingView): [number, number] | null {
    const b = this.facts?.box;
    if (!b) return null;
    const n = viewDir(this.sheet, v).dir;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const d = b[i & 1][0] * n[0] + b[(i >> 1) & 1][1] * n[1] + b[(i >> 2) & 1][2] * n[2];
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return [lo, hi];
  }

  private startBroken() {
    const v = this.sel ? findView(this.sheet, this.sel) : null;
    if (!v || v.kind === "detail" || v.kind === "section" || !this.placements.get(v.id)) { toast(t("Select a model, projected or auxiliary view first.")); return; }
    this.mode = { kind: "brokenout", view: v.id, pts: [], at: null };
    this.renderStatus();
    this.renderOverlay();
  }

  private brokenClick(m: Extract<Mode, { kind: "brokenout" }>, p: Pt) {
    const pl = this.placements.get(m.view);
    if (!pl) return;
    if (m.pts.length >= 3) {
      const f = toSheet(pl, m.pts[0][0], m.pts[0][1]);
      if (Math.hypot(f[0] - p[0], f[1] - p[1]) < this.snapTol()) { this.finishBroken(m); return; }
    }
    m.pts.push(fromSheet(pl, p[0], p[1]));
    this.renderStatus();
    this.renderOverlay();
  }

  /** Detail profile (FR-DRW-013): corners on one view; a click on the first corner (or Enter) closes it. */
  private profileClick(m: Extract<Mode, { kind: "detail" }>, id: string | null, p: Pt) {
    const pts = m.pts ?? (m.pts = []);
    if (!pts.length) { if (!id || !this.placements.get(id)) return; m.parent = id; this.sel = id; }
    const pl = this.placements.get(m.parent!);
    if (!pl) return;
    if (pts.length >= 3) {
      const f = toSheet(pl, pts[0][0], pts[0][1]);
      if (Math.hypot(f[0] - p[0], f[1] - p[1]) < this.snapTol()) { this.finishProfile(m); return; }
    }
    pts.push(fromSheet(pl, p[0], p[1]));
    this.renderStatus();
    this.renderOverlay();
  }

  private finishProfile(m: Extract<Mode, { kind: "detail" }>) {
    const pts = m.pts ?? [];
    const outline = pts.flat();
    // A profile with no area (all corners on one line) can't frame anything.
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    if (pts.length < 3 || Math.abs(a) < 1e-6) { toast(t("Click at least three corners that enclose an area."), true); return; }
    const b = polyBox(outline), c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1]));
    m.c = c; m.r = Math.round(r * 100) / 100 || 0.01; m.outline = outline;
    this.renderStatus();
    this.renderOverlay();
  }

  private finishBroken(m: Extract<Mode, { kind: "brokenout" }>) {
    const v = findView(this.sheet, m.view);
    this.mode = { kind: "none" };
    if (!v || m.pts.length < 3) { this.renderOverlay(); this.renderStatus(); return; }
    const r = this.depthRange(v);
    // Cut down to the middle of the model by default; the depth can be typed afterwards.
    const d = r ? (r[0] + r[1]) / 2 : v.broken?.d ?? 0;
    const poly = m.pts.flatMap(q => [round(q[0]), round(q[1])]);
    this.setView("Broken-out section", w => { w.broken = { poly, d: round(d) }; });
  }

  // ---------- alternate position (FR-DRW-015) ----------

  /** A top-level component's name in an assembly drawing. */
  private compName(id: string): string {
    const src = this.doc.source;
    return (src.kind === "asm" ? src.doc.components.find(c => c.id === id)?.name : undefined) ?? id;
  }

  private startAlt() {
    const v = this.sel ? findView(this.sheet, this.sel) : null;
    if (this.doc.source.kind !== "asm") { toast(t("Alternate positions are for drawings of an assembly."), true); return; }
    if (!v || v.kind === "detail" || v.kind === "section" || !this.placements.get(v.id)) { toast(t("Select a model, projected or auxiliary view first.")); return; }
    this.mode = { kind: "altpos", view: v.id, comp: null, from: null, at: null };
    this.renderStatus();
    this.renderOverlay();
  }

  private altClick(m: Extract<Mode, { kind: "altpos" }>, p: Pt) {
    const pl = this.placements.get(m.view);
    if (!pl) return;
    if (!m.comp) {
      const id = compOfKey(this.pickAt(m.view, p)?.e.k ?? "");
      if (!id) { toast(t("Click an edge of a component.")); return; }
      m.comp = id.split("/")[0];
      m.from = fromSheet(pl, p[0], p[1]);
      this.renderStatus();
      this.renderOverlay();
      return;
    }
    const q = fromSheet(pl, p[0], p[1]), from = m.from!, comp = m.comp;
    this.mode = { kind: "none" };
    this.setView("Alternate position", v => {
      const moves = (v.alt ?? []).filter(x => x.comp !== comp);
      moves.push({ comp, du: round(q[0] - from[0]), dv: round(q[1] - from[1]), c: [round(from[0]), round(from[1])] });
      v.alt = moves;
    });
  }

  /** The move being picked: from the clicked point to the cursor. */
  private altMarks(H: number): string {
    const m = this.mode;
    if (m.kind !== "altpos" || !m.from || !m.at) return "";
    const pl = this.placements.get(m.view);
    if (!pl) return "";
    const a = toSheet(pl, m.from[0], m.from[1]);
    return `<line class="drw-cut" x1="${a[0]}" y1="${H - a[1]}" x2="${m.at[0]}" y2="${H - m.at[1]}"/><circle class="drw-snap" cx="${a[0]}" cy="${H - a[1]}" r="${this.snapTol() / 3}"/>`;
  }

  /** The alternate position group of an assembly view's panel. */
  private altProps(v: DrawingView): string {
    const rows = (v.alt ?? []).map((m, i) => `<div class="drw-alt" data-i="${i}">
        <p class="drw-note" translate="no">${esc(this.compName(m.comp))}</p>
        <div class="row">
          <label class="drw-f">${esc(t("Move across (mm)"))}<input data-v="alt:${i}:du" inputmode="decimal" value="${m.du}"></label>
          <label class="drw-f">${esc(t("Move up (mm)"))}<input data-v="alt:${i}:dv" inputmode="decimal" value="${m.dv}"></label>
          <label class="drw-f">${esc(t("Turn (°)"))}<input data-v="alt:${i}:ang" inputmode="decimal" value="${m.ang ?? 0}"></label>
        </div>
        <div class="row"><button class="btn small" data-a="altrm" data-i="${i}">${esc(t("Remove"))}</button></div>
      </div>`).join("");
    return `<fieldset class="pm-group drw-altpos"><legend>${esc(t("Alternate position"))}</legend>
      ${rows || `<p class="drw-note">${esc(t("Show components again in another position, in phantom lines."))}</p>`}
      <div class="row"><button class="btn small" data-a="altpos" title="${esc(t("Click an edge of a component, then where that point goes in its other position"))}">${esc(t("Add component…"))}</button></div>
    </fieldset>`;
  }

  /** The outline of a broken-out section being drawn. */
  private brokenMarks(H: number): string {
    const m = this.mode;
    if (m.kind !== "brokenout") return "";
    const pl = this.placements.get(m.view);
    if (!pl) return "";
    const pts = m.pts.map(q => toSheet(pl, q[0], q[1]));
    if (m.at) pts.push(m.at);
    const tol = this.snapTol();
    let s = pts.length > 1 ? `<polyline class="drw-cut" fill="none" points="${pts.map(q => `${q[0]},${H - q[1]}`).join(" ")}"/>` : "";
    if (m.pts.length >= 3) s += `<circle class="drw-snap" cx="${pts[0][0]}" cy="${H - pts[0][1]}" r="${tol / 2}"/>`;
    return s;
  }

  /** The crop rectangle or break band being drawn. */
  private trimMarks(H: number): string {
    const m = this.mode;
    if (m.kind !== "crop" && m.kind !== "break") return "";
    const pl = this.placements.get(m.view);
    if (!pl) return "";
    const r = viewRect(pl);
    if (m.kind === "crop") {
      if (!m.p1 || !m.at) return "";
      const a = toSheet(pl, m.p1[0], m.p1[1]), b = m.at;
      return `<rect class="drw-cut" x="${Math.min(a[0], b[0])}" y="${H - Math.max(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" fill="none"/>`;
    }
    const line = (k: number) => (m.axis === "u" ? `<line class="drw-cut" x1="${k}" y1="${H - r[1] + 3}" x2="${k}" y2="${H - r[3] - 3}"/>` : `<line class="drw-cut" x1="${r[0] - 3}" y1="${H - k}" x2="${r[2] + 3}" y2="${H - k}"/>`);
    let s = "";
    if (m.a != null) { const [x, y] = toSheet(pl, m.axis === "u" ? m.a : pl.uc, m.axis === "u" ? pl.vc : m.a); s += line(m.axis === "u" ? x : y); }
    if (m.at) s += line(m.axis === "u" ? m.at[0] : m.at[1]);
    return s;
  }

  /** What a section/detail/aux command draws on the sheet before its view exists: the cutting line, circle or picked edge. */
  private modeMarks(H: number): string {
    const m = this.mode;
    if (m.kind === "crop" || m.kind === "break") return this.trimMarks(H);
    if (m.kind === "brokenout") return this.brokenMarks(H);
    if (m.kind === "altpos") return this.altMarks(H);
    if (m.kind !== "section" && m.kind !== "detail" && m.kind !== "aux") return "";
    const at = m.at;
    const id = at ? this.kindParent(m, at) : m.parent;
    const pl = id ? this.placements.get(id) : undefined;
    if (!pl || !id) return "";
    const L = (l: Line4, cls: string) => { const [a, b] = [toSheet(pl, l[0], l[1]), toSheet(pl, l[2], l[3])]; return `<line class="${cls}" x1="${a[0]}" y1="${H - a[1]}" x2="${b[0]}" y2="${H - b[1]}"/>`; };
    const dot = (mp: Pt) => { const [x, y] = toSheet(pl, mp[0], mp[1]); return `<circle class="drw-snap" cx="${x}" cy="${H - y}" r="${this.snapTol() / 3}"/>`; };
    let s = "";
    if (m.kind === "section") {
      const poly = (q: Pt[]) => q.length < 2 ? "" : `<polyline class="drw-cut" fill="none" points="${q.map(r => { const [x, y] = toSheet(pl, r[0], r[1]); return `${x},${H - y}`; }).join(" ")}"/>`;
      if (m.line && m.path) { const q: Pt[] = []; for (let i = 0; i + 1 < m.path.length; i += 2) q.push([m.path[i], m.path[i + 1]]); return poly(q); }
      if (m.line) return L(m.line, "drw-cut");
      if (m.how === "off" || m.how === "half" || m.how === "aligned") {
        const pts = m.pts ?? [];
        if (!pts.length) { if (at) { const sp = this.snapIn(id, at); if (sp.snap) s += dot(sp.m); } return s; }
        return poly(at ? [...pts, this.pathPoint(m, id, at)] : pts) + pts.map(dot).join("");
      }
      if (!at) return "";
      const sp = this.snapIn(id, at);
      if (m.how === "2p") { if (m.p1) s += L([m.p1[0], m.p1[1], sp.m[0], sp.m[1]], "drw-cut") + dot(m.p1); }
      else s += L(this.cutLine(id, m.how, sp.m), "drw-cut");
      if (sp.snap) s += dot(sp.m);
    } else if (m.kind === "detail" && m.prof) {
      const pts = m.outline ? Array.from({ length: m.outline.length / 2 }, (_, i): Pt => [m.outline![2 * i], m.outline![2 * i + 1]]) : m.pts ?? [];
      const q = m.outline ? [...pts, pts[0]] : at && pts.length ? [...pts, fromSheet(pl, at[0], at[1])] : pts;
      if (q.length >= 2) s += `<polyline class="drw-cut" fill="none" points="${q.map(r => { const [x, y] = toSheet(pl, r[0], r[1]); return `${x},${H - y}`; }).join(" ")}"/>`;
      if (!m.outline) s += pts.map(dot).join("");
    } else if (m.kind === "detail") {
      if (!m.c) { if (at) { const sp = this.snapIn(id, at); if (sp.snap) s += dot(sp.m); } return s; }
      const [cx, cy] = toSheet(pl, m.c[0], m.c[1]);
      const R = m.r ? m.r * pl.s : at ? Math.hypot(at[0] - cx, at[1] - cy) : 0;
      s += `<circle class="drw-cut" cx="${cx}" cy="${H - cy}" r="${R}"/>` + dot(m.c);
    } else {
      const e = m.line ?? (at ? this.edgeAt(id, at) : null);
      if (e) s += L(e, "drw-edge");
    }
    return s;
  }

  /** Standard 3 views (FR-DRW-011): front, top and side, lined up, at a scale that fits. */
  standard3(fresh = false) {
    if (!this.facts) { toast(t("The drawing's model is still loading.")); return; }
    const sh = this.sheet, [lo, hi] = this.facts.box;
    const dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2];
    const f = frameOf(sh), gap = 25;
    const ax0 = f[0] + 10, ax1 = f[2] - 10, ay0 = f[1] + tbSize(sh)[1] + 10, ay1 = f[3] - 10;
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
    this.store!.change("Delete view", d => {
      const S = d.sheets[this.sheetIdx];
      S.views = S.views.filter(v => !gone.has(v.id));
      if (S.annots) S.annots = S.annots.filter(a => !a.view || !gone.has(a.view));
    });
  }

  // ---------- tree, properties, tabs ----------

  private renderTree() {
    const host = this.el.querySelector<HTMLElement>(".drw-tree")!;
    const sh = this.sheet;
    const item = (v: DrawingView, depth: number): string => {
      const kind = v.kind ? t(KIND_NAMES[v.kind]) : v.parent ? t("Projected") : t(ORIENT_NAMES[v.orient ?? "front"]);
      const icon = v.kind ? ICON[v.kind === "section" ? "section" : v.kind === "detail" ? "detail" : "aux"] : v.parent ? ICON.proj : ICON.model;
      let s = `<div role="treeitem" tabindex="${v.id === this.sel ? 0 : -1}" aria-selected="${v.id === this.sel}" class="drw-ti${v.id === this.sel ? " on" : ""}" data-sel="${v.id}" style="padding-left:${12 + depth * 14}px">${icon}<span translate="no">${esc(v.name)}</span><small>${esc(kind)}</small></div>`;
      for (const c of sh.views) if (c.parent === v.id) s += item(c, depth + 1);
      return s;
    };
    host.innerHTML = `<div role="treeitem" tabindex="${this.sel ? -1 : 0}" aria-selected="${!this.sel}" class="drw-ti sheet${this.sel ? "" : " on"}" data-sel="">${ICON.hlr}<span>${esc(sheetName(sh))}</span><small>${esc(sh.size === "custom" ? t("Custom") : sh.size)} · ${scaleText(sh.scale)}</small></div>`
      + sh.views.filter(v => !v.parent || !findView(sh, v.parent)).map(v => item(v, 1)).join("");
  }

  private renderProps() {
    const host = this.el.querySelector<HTMLElement>(".drw-props")!;
    const sh = this.sheet;
    const sa = this.selA ? this.annot(this.selA) : undefined;
    if (sa) { host.innerHTML = this.annotProps(sa); return; }
    const v = this.sel ? findView(sh, this.sel) : null;
    if (v) {
      const own = v.scale ? scaleText(v.scale) : "";
      const style = v.style ?? "hlv", tan = v.tangent ?? "visible";
      host.innerHTML = `
        <fieldset class="pm-group"><legend>${esc(t("Drawing view"))}</legend>
          <label class="drw-f">${esc(t("Name"))}<input data-v="name" value="${esc(v.name)}" translate="no"></label>
          ${v.kind ? this.kindProps(v) : v.parent ? `<p class="drw-note">${esc(t("Projected from {name}", { name: findView(sh, v.parent)?.name ?? "?" }))}</p>` : `
          <label class="drw-f">${esc(t("Orientation"))}<select data-v="orient">${(Object.keys(ORIENT_NAMES) as Orient[]).map(o => `<option value="${o}"${o === (v.orient ?? "front") ? " selected" : ""}>${esc(t(ORIENT_NAMES[o]))}</option>`).join("")}</select></label>`}
          ${this.configField(v)}${this.onlyField(v)}
        </fieldset>
        <fieldset class="pm-group"><legend>${esc(t("Scale"))}</legend>
          <label class="drw-f">${esc(t("Scale"))}<select data-v="scale"><option value="">${esc(v.parent ? t("Parent's scale") : t("Sheet scale ({s})", { s: scaleText(sh.scale) }))}</option>${SCALES.map(s => `<option value="${scaleText(s)}"${own === scaleText(s) ? " selected" : ""}>${scaleText(s)}</option>`).join("")}${own && !SCALES.some(s => scaleText(s) === own) ? `<option value="${own}" selected>${own}</option>` : ""}<option value="custom">${esc(t("Custom…"))}</option></select></label>
        </fieldset>
        <fieldset class="pm-group"><legend>${esc(t("Display style"))}</legend>
          <div class="seg drw-seg" role="radiogroup" aria-label="${esc(t("Display style"))}">
            ${(["hlv", "hlr", "wire", "shaded", "shadedEdges"] as DisplayStyle[]).filter(s => v.kind !== "section" || !s.startsWith("shaded")).map(s => `<button role="radio" aria-checked="${s === style}" class="${s === style ? "on" : ""}" data-style="${s}" title="${esc(t(STYLE_NAMES[s]))}" aria-label="${esc(t(STYLE_NAMES[s]))}">${ICON[s]}</button>`).join("")}
          </div>
          <label class="drw-f">${esc(t("Tangent edges"))}<select data-v="tangent">${(["visible", "thin", "hidden"] as TangentEdges[]).map(s => `<option value="${s}"${s === tan ? " selected" : ""}>${esc(t(TAN_NAMES[s]))}</option>`).join("")}</select></label>
          <label class="drw-chk"><input type="checkbox" data-v="label"${v.label ? " checked" : ""}> ${esc(t("Show the view label"))}</label>
          <label class="drw-chk"><input type="checkbox" data-v="marks"${v.marks !== false ? " checked" : ""}> ${esc(t("Centre marks and centrelines"))}</label>
          <label class="drw-chk"><input type="checkbox" data-v="threads"${v.threads !== false ? " checked" : ""}> ${esc(t("Cosmetic threads"))}</label>
          <label class="drw-chk"><input type="checkbox" data-v="sketches"${v.sketches ? " checked" : ""}> ${esc(t("Sketches"))}</label>
        </fieldset>
        ${v.parent && (v.kind !== "detail") ? `<fieldset class="pm-group"><legend>${esc(t("Alignment"))}</legend>
          <p class="drw-note">${esc(v.free ? t("Moves on its own.") : t("Lined up with {name}.", { name: findView(sh, v.parent)?.name ?? "?" }))}</p>
          <div class="row"><button class="btn small" data-a="${v.free ? "align" : "unalign"}">${esc(v.free ? t("Default alignment") : t("Break alignment"))}</button></div>
        </fieldset>` : ""}
        ${v.kind === "detail" ? "" : `<fieldset class="pm-group drw-trim"><legend>${esc(t("Crop and break"))}</legend>
          <div class="row">
          <button class="btn small" data-a="crop" title="${esc(t("Crop view: click two corners; only what is inside stays"))}">${esc(t("Crop"))}</button>
          <button class="btn small" data-a="vbreak" title="${esc(t("Break view: click the two ends of the part to leave out; vertical break lines"))}">${esc(t("Vertical break"))}</button>
          <button class="btn small" data-a="hbreak" title="${esc(t("Break view: click the two ends of the part to leave out; horizontal break lines"))}">${esc(t("Horizontal break"))}</button>
          </div>
          ${v.crop || v.breaks?.length ? `<div class="row">${v.crop ? `<button class="btn small" data-a="uncrop">${esc(t("Remove crop"))}</button>` : ""}${v.breaks?.length ? `<button class="btn small" data-a="unbreak">${esc(t("Remove breaks"))}</button>` : ""}</div>` : ""}
        </fieldset>`}
        ${v.kind === "detail" || v.kind === "section" ? "" : this.brokenProps(v)}
        ${v.kind === "detail" || v.kind === "section" || this.doc.source.kind !== "asm" ? "" : this.altProps(v)}
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
        <label class="drw-f">${esc(t("Sheet format"))}<select data-s="format">${this.formatOptions(sh)}</select></label>
        ${sh.format === "gost" ? "" : `<div class="row"><button class="btn small" data-a="tbedit">${esc(sh.tb ? t("Edit title block…") : t("New title block…"))}</button></div>`}
      </fieldset>
      <fieldset class="pm-group drw-style"><legend>${esc(t("Drafting style"))}</legend>
        <label class="drw-f">${esc(t("Text height"))}<select data-st="text">${[2.5, 3.5, 5].map(h => `<option value="${h}"${(this.doc.style?.text ?? 3.5) === h ? " selected" : ""}>${String(h).replace(".", lang() === "ru" ? "," : ".")} ${esc(t("mm"))}</option>`).join("")}</select></label>
        <label class="drw-f">${esc(t("Arrowheads"))}<select data-st="arrow">${(["filled", "open", "dot", "tick"] as const).map(k => `<option value="${k}"${(this.doc.style?.arrow ?? "filled") === k ? " selected" : ""}>${esc(t(ARROW_NAMES[k]))}</option>`).join("")}</select></label>
        <label class="drw-f">${esc(t("Line group"))}<select data-st="lines">${[0.25, 0.35, 0.5, 0.7].map(w => `<option value="${w}"${(this.doc.style?.lines ?? 0.35) === w ? " selected" : ""}>${String(w).replace(".", lang() === "ru" ? "," : ".")} ${esc(t("mm"))}</option>`).join("")}</select></label>
      </fieldset>
      <fieldset class="pm-group"><legend>${esc(t("Title block"))}</legend>
        ${editableOf(sh).map(k => `<label class="drw-f">${esc(t(FIELD_LABEL[k]))}<input data-f="${k}" value="${esc(this.doc.props[k] ?? "")}" placeholder="${esc(String(f[k] ?? ""))}"${k === "litera" ? ' maxlength="3"' : ""} translate="no"></label>`).join("")}
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
    if (b.dataset.sel !== undefined) { this.cancelMode(); this.selA = null; this.sel = b.dataset.sel || null; this.renderTree(); this.renderProps(); this.renderOverlay(); return; }
    if (b.dataset.ptab) {
      for (const x of this.el.querySelectorAll<HTMLElement>("[data-ptab]")) {
        const on = x === b;
        x.classList.toggle("on", on); x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1;
        this.el.querySelector<HTMLElement>(`#drw-pane-${x.dataset.ptab}`)!.hidden = !on;
      }
      return;
    }
    if (b.dataset.orient) { this.closeMenus(); this.startModel(b.dataset.orient as Orient); return; }
    if (b.dataset.cut) { this.closeMenus(); this.startKind("section", b.dataset.cut as "h"); return; }
    if (b.dataset.det) { this.closeMenus(); this.startKind("detail", "h", b.dataset.det === "profile"); return; }
    if (b.dataset.an) {
      this.closeMenus();
      const an = b.dataset.an;
      if (an === "items") this.insertItems(); else if (an === "rev") this.insertTable("rev"); else if (an === "table") this.insertTable("general"); else if (an === "bom") this.insertBom(); else if (an === "auto") void this.autoBalloon(); else if (an === "chain" || an === "base" || an === "ord") this.startAnnot("dimset", an); else this.startAnnot(an as AnnotMode["kind"]);
      return;
    }
    if (b.dataset.grow) {
      const g = b.dataset.grow;
      this.setAnnot(g === "+" ? "Add row" : "Remove row", a => { if (a.t !== "gtol") return; if (g === "+") a.rows.push({ sym: "flat", tol: "0.05", datums: [] }); else a.rows.splice(-+g, 1); });
      return;
    }
    if (b.dataset.unstack !== undefined) {
      const i = +b.dataset.unstack;
      this.setAnnot("Stacked balloon", a => { if (a.t !== "balloon" || !a.stack) return; a.stack.splice(i, 1); if (!a.stack.length) delete a.stack; });
      return;
    }
    if (b.dataset.trow || b.dataset.tcol) {
      const add = (b.dataset.trow ?? b.dataset.tcol) === "+", col = !!b.dataset.tcol;
      this.setAnnot(col ? "Table column" : "Table row", a => {
        if (a.t !== "table") return;
        if (col) { if (add) { a.cols.push(`Column ${a.cols.length + 1}`); a.rows.forEach(r => r.push("")); } else if (a.cols.length > 1) { a.cols.pop(); a.rows.forEach(r => r.splice(a.cols.length)); } }
        else if (add) {
          // The next revision letter and today's date.
          const last = a.rows[a.rows.length - 1]?.[0] ?? "", next = a.kind === "rev" && /^[A-Z]$/.test(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : "";
          a.rows.push(a.cols.map((_c, j) => (a.kind === "rev" ? (j === 0 ? next : j === 2 ? new Date().toISOString().slice(0, 10) : "") : "")));
        } else if (a.rows.length > 1) a.rows.pop();
      });
      return;
    }
    if (b.dataset.tolt !== undefined) { this.setTol(b.dataset.tolt as Tol["t"] | ""); return; }
    if (b.dataset.x) { this.closeMenus(); void this.exportAs(b.dataset.x as "pdf"); return; }
    if (b.dataset.sheet) { this.cancelMode(); this.sheetIdx = +b.dataset.sheet; this.sel = null; this.renderAll(); this.fit(); return; }
    if (b.dataset.style) { this.setView("Display style", v => { v.style = b.dataset.style as DisplayStyle; }); return; }
    if (b.dataset.orientation) { this.setSheet("Sheet orientation", s => { s.portrait = b.dataset.orientation === "port" || undefined; }); this.fit(); return; }
    switch (a) {
      case "back": this.hide(); break;
      case "std3": this.cancelMode(); this.standard3(); break;
      case "model": case "export": case "section": case "annot": case "detail": {
        const menu = b.nextElementSibling as HTMLElement, open = menu.hidden;
        this.closeMenus();
        menu.hidden = !open;
        b.setAttribute("aria-expanded", String(open));
        if (open) menu.querySelector<HTMLElement>("button")?.focus();
        break;
      }
      case "proj": this.startProjected(); break;
      case "aux": this.startKind("aux"); break;
      case "flip": this.flipSel(); break;
      case "crop": this.startTrim("crop"); break;
      case "vbreak": this.startTrim("break", "u"); break;
      case "hbreak": this.startTrim("break", "v"); break;
      case "uncrop": this.setView("Remove crop", v => { delete v.crop; }); break;
      case "unbreak": this.setView("Remove breaks", v => { delete v.breaks; }); break;
      case "brokenout": this.startBroken(); break;
      case "altpos": this.startAlt(); break;
      case "altrm": { const i = +b.dataset.i!; this.setView("Remove alternate position", v => { v.alt = (v.alt ?? []).filter((_, j) => j !== i); if (!v.alt.length) delete v.alt; }); break; }
      case "unbroken": this.setView("Remove broken-out section", v => { delete v.broken; }); break;
      case "unalign": this.setView("Break alignment", v => { v.free = true; }); break;
      case "tbedit": void this.editFormat(); break;
      case "align": this.realign(); break;
      case "dim": this.startAnnot("dim"); break;
      case "adel": this.deleteAnnot(); break;
      case "hupd": { const a = this.selA ? this.annot(this.selA) : null; if (a?.t === "htable") { const holes = this.viewHoleRefs(a.view); this.setAnnot("Update holes", x => { if (x.t === "htable") x.holes = holes; }); } break; }
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

  /** Hatch pattern, spacing and angle of a section or broken-out view (FR-DRW-012). */
  private hatchFields(v: DrawingView): string {
    const h = hatchOf(v);
    return `<label class="drw-f">${esc(t("Hatch pattern"))}<select data-v="hpat" title="${esc(t("By material: each component or body gets its material's pattern, and neighbouring ones turn and change spacing"))}">${HATCH_PATTERNS.map(p => `<option value="${p.id}"${p.id === h.pattern ? " selected" : ""}>${esc(t(p.name))}</option>`).join("")}</select></label>
      <label class="drw-f">${esc(t("Hatch spacing (mm)"))}<input data-v="hgap" inputmode="decimal" value="${h.gap}"></label>
      <label class="drw-f">${esc(t("Hatch angle"))}<select data-v="hang">${[45, 135, 30, 60].map(a => `<option value="${a}"${a === h.angle ? " selected" : ""}>${a}°</option>`).join("")}</select></label>`;
  }

  /** The broken-out section group of the view panel. */
  private brokenProps(v: DrawingView): string {
    const r = this.depthRange(v), b = v.broken;
    let s = `<fieldset class="pm-group drw-broken"><legend>${esc(t("Broken-out section"))}</legend>`;
    if (!b) s += `<div class="row"><button class="btn small" data-a="brokenout" title="${esc(t("Click the corners of an area; the material in it is cut away down to a depth and hatched"))}">${esc(t("Broken-out section"))}</button></div>`;
    else {
      s += `<label class="drw-f">${esc(t("Depth from the front (mm)"))}<input data-v="bdepth" inputmode="decimal" value="${r ? round(r[1] - b.d) : ""}"></label>
        ${this.hatchFields(v)}
        <div class="row"><button class="btn small" data-a="brokenout">${esc(t("Redraw the outline"))}</button><button class="btn small" data-a="unbroken">${esc(t("Remove broken-out section"))}</button></div>`;
    }
    return s + `</fieldset>`;
  }

  /** Extra properties of section, detail and auxiliary views. */
  /** A part's configuration for a model view (FR-DRW-010); views made from it follow theirs. */
  private configField(v: DrawingView): string {
    const src = this.doc.source;
    if (src.kind !== "part" || !src.doc.configs?.length || v.kind || v.parent) return "";
    const act = src.doc.config ?? src.doc.configs[0].name;
    return `<label class="drw-f">${esc(t("Configuration"))}<select data-v="cfg"><option value="">${esc(t("Active ({name})", { name: act }))}</option>${src.doc.configs.map(c => `<option value="${esc(c.name)}"${v.config === c.name ? " selected" : ""} translate="no">${esc(c.name)}</option>`).join("")}</select></label>`;
  }

  /** Assembly drawings: a model view of one component alone (a part's detail views on the assembly's drawing); views made from it follow. */
  private onlyField(v: DrawingView): string {
    const comps = this.sectionComps();
    if (!comps.length || v.kind || v.parent) return "";
    const cur = v.only?.[0] ?? "";
    return `<label class="drw-f">${esc(t("Components"))}<select data-v="only"><option value="">${esc(t("All components"))}</option>${comps.map(c => `<option value="${esc(c.id)}"${cur === c.id ? " selected" : ""} translate="no">${esc(c.name)}</option>`).join("")}</select></label>`;
  }

  private kindProps(v: DrawingView): string {
    const par = v.parent ? findView(this.sheet, v.parent)?.name ?? "?" : "?";
    let s = `<p class="drw-note">${esc(t(v.kind === "section" ? "Section of {name}" : v.kind === "detail" ? "Detail of {name}" : "Auxiliary view of {name}", { name: par }))}</p>
      <label class="drw-f">${esc(t("Letter"))}<input data-v="letter" value="${esc(v.letter ?? "")}" maxlength="3" translate="no"></label>`;
    if (v.kind === "detail" && v.outline) s += "";
    else if (v.kind === "detail") s += `<label class="drw-f">${esc(t("Radius (mm)"))}<input data-v="radius" inputmode="decimal" value="${v.r ?? ""}"></label>`;
    else s += `<div class="row"><button class="btn small" data-a="flip" title="${esc(t("Look at the other side of the line"))}">${esc(t("Flip direction"))}</button></div>`;
    if (v.kind === "section") {
      s += this.hatchFields(v);
      s += this.excludeProps(v);
    }
    return s;
  }

  /** The top-level components of an assembly drawing that a section can leave uncut, with whether each is a fastener. */
  private sectionComps(): { id: string; name: string; fastener: boolean }[] {
    const src = this.doc.source;
    if (src.kind !== "asm") return [];
    const flat = src.flat ?? src.doc;
    return flat.components.filter(c => !c.hidden && !c.suppressed && !c.id.includes("/"))
      .map(c => ({ id: c.id, name: c.name, fastener: !!flat.parts[c.part]?.doc?.id?.startsWith("fastener:") }));
  }

  /** Section of an assembly (FR-DRW-012): components left whole, picked one by one or all fasteners at once. */
  private excludeProps(v: DrawingView): string {
    const comps = this.sectionComps();
    if (!comps.length) return "";
    const ex = new Set(v.exclude ?? []), fast = comps.filter(c => c.fastener);
    return `<fieldset class="drw-fs"><legend>${esc(t("Don't cut"))}</legend>
      ${fast.length ? `<label class="drw-chk"><input type="checkbox" data-v="exfast"${fast.every(c => ex.has(c.id)) ? " checked" : ""}> ${esc(t("Fasteners"))}</label>` : ""}
      <div class="drw-exlist">${comps.map(c => `<label class="drw-chk"><input type="checkbox" data-ex="${esc(c.id)}"${ex.has(c.id) ? " checked" : ""}> <span translate="no">${esc(c.name)}</span></label>`).join("")}</div></fieldset>`;
  }

  /** Flips a section/aux view: it looks from the other side of its line and moves across to that side. */
  private flipSel() {
    const v = this.sel ? findView(this.sheet, this.sel) : null;
    const pp = v?.parent ? this.placements.get(v.parent) : undefined;
    if (!v || !v.line || !pp) return;
    const q = lookDir(v);
    const [a] = [toSheet(pp, v.line[0], v.line[1])];
    const k = (v.x - a[0]) * q[0] + (v.y - a[1]) * q[1];
    const moves = this.dragMoves(v.id, -2 * k * q[0], -2 * k * q[1], new Map(this.sheet.views.map(o => [o.id, [o.x, o.y] as [number, number]])));
    this.store!.change("Flip direction", d => {
      for (const o of d.sheets[this.sheetIdx].views) {
        if (o.id === v.id) o.look = (o.look ?? 1) === 1 ? -1 : 1;
        const mv = moves.get(o.id);
        if (mv) { o.x = round(mv[0]); o.y = round(mv[1]); }
      }
    });
  }

  /** The sheet format choices: the built-in title blocks, then the user formats (the sheet's own one first if it is not in the library). */
  private formatOptions(sh: Sheet): string {
    const lib = loadFormats(), cur = sh.tb ? `user:${sh.tb.id}` : sh.format;
    const users = sh.tb && !lib.some(f => f.id === sh.tb!.id) ? [sh.tb, ...lib] : lib;
    const opt = (v: string, label: string, tr = false) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}${tr ? ' translate="no"' : ""}>${esc(label)}</option>`;
    return opt("iso", "ISO 7200") + opt("ansi", "ANSI Y14.1") + opt("gost", "GOST 2.104")
      + (users.length ? `<optgroup label="${esc(t("My formats"))}">${users.map(f => opt(`user:${f.id}`, f.name, true)).join("")}</optgroup>` : "");
  }

  /** Edit the sheet's title block (FR-DRW-004), starting from its own one or the ISO block. */
  private async editFormat() {
    const sh = this.sheet;
    const start = sh.tb ?? { ...isoFormat(), name: t("My title block") };
    const f = await editTitleBlock(start, sh, this.fields(), (b, n) => this.host.download(b, n));
    if (f) this.setSheet("Title block", s => { s.tb = f; if (s.format === "gost") s.format = "iso"; });
    else this.renderProps();
  }

  /** Default alignment (FR-DRW-017): the view goes back in line with its parent, taking the views that follow it along. */
  private realign() {
    const v0 = this.sel ? findView(this.sheet, this.sel) : null;
    const pp = v0?.parent ? this.placements.get(v0.parent) : null;
    if (!v0 || !pp) return;
    const v: DrawingView = { ...v0, free: undefined };
    const ax = alignAxis(v);
    let [x, y] = [v.x, v.y];
    if (ax === "y") y = pp.y;
    else if (ax === "x") x = pp.x;
    else if (Array.isArray(ax)) [x, y] = this.alignedAt(v, [v.x, v.y]);
    const dx = x - v.x, dy = y - v.y;
    this.setSheet("Default alignment", sh => {
      const move = (id: string) => {
        const w = sh.views.find(o => o.id === id);
        if (!w) return;
        w.x += dx; w.y += dy;
        for (const c of sh.views) if (c.parent === id && !c.free) move(c.id);
      };
      move(v.id);
      delete sh.views.find(o => o.id === v.id)!.free;
    });
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
    if (el.dataset.d) { this.onAnnotInput(el); return; }
    const vk = el.dataset.v, sk = el.dataset.s;
    if (vk === "name") this.setView("Rename view", v => { v.name = val.trim() || v.name; });
    else if (vk === "cfg") this.setView("View configuration", v => { if (val) v.config = val; else delete v.config; });
    else if (vk === "only") this.setView("View components", v => { if (val) v.only = [val]; else delete v.only; });
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
    else if (vk === "marks") this.setView("Centre marks", v => { if ((el as HTMLInputElement).checked) delete v.marks; else v.marks = false; });
    else if (vk === "threads") this.setView("Cosmetic threads", v => { if ((el as HTMLInputElement).checked) delete v.threads; else v.threads = false; });
    else if (vk === "sketches") this.setView("Show sketches", v => { v.sketches = (el as HTMLInputElement).checked || undefined; });
    else if (vk === "letter") {
      const L = val.trim().toUpperCase();
      if (!L) { this.renderProps(); return; }
      if (this.doc.sheets.some(sh => sh.views.some(o => o.id !== this.sel && o.letter === L))) toast(t("Another view already uses the letter {a}.", { a: L }), true);
      this.setView("View letter", v => {
        const old = v.letter;
        v.letter = L;
        // The default names carry the letter: keep them in step.
        if (old && v.name.endsWith(v.kind === "section" ? ` ${old}-${old}` : ` ${old}`)) v.name = v.name.slice(0, v.name.lastIndexOf(" ")) + (v.kind === "section" ? ` ${L}-${L}` : ` ${L}`);
      });
    } else if (vk === "radius") {
      const r = parseFloat(val.replace(",", "."));
      if (!(r > 0)) { toast(t("Type a radius above zero."), true); this.renderProps(); return; }
      this.setView("Detail radius", v => { v.r = r; });
    } else if (vk === "hgap") {
      const g = parseFloat(val.replace(",", "."));
      if (!(g >= 0.5)) { toast(t("Type a spacing of at least 0.5 mm."), true); this.renderProps(); return; }
      this.setView("Hatch spacing", v => { v.hatch = { ...v.hatch, gap: g }; });
    } else if (vk?.startsWith("alt:")) {
      const [, i, k] = vk.split(":"), x = parseFloat(val.replace(",", "."));
      if (!Number.isFinite(x)) { toast(t("Type a number."), true); this.renderProps(); return; }
      this.setView("Alternate position", v => { const m = v.alt?.[+i]; if (m) m[k as "du" | "dv" | "ang"] = x; });
    } else if (vk === "bdepth") {
      const v0 = this.sel ? findView(this.sheet, this.sel) : null, r = v0 ? this.depthRange(v0) : null;
      const dep = parseFloat(val.replace(",", "."));
      if (!r || !v0?.broken || !(dep > 0 && dep < r[1] - r[0])) { toast(t("Type a depth between 0 and {max} mm.", { max: r ? round(r[1] - r[0]) : "?" }), true); this.renderProps(); return; }
      this.setView("Broken-out depth", v => { if (v.broken) v.broken = { ...v.broken, d: round(r[1] - dep) }; });
    } else if (vk === "hang") this.setView("Hatch angle", v => { v.hatch = { ...v.hatch, angle: +val }; });
    else if (vk === "hpat") this.setView("Hatch pattern", v => { v.hatch = { ...v.hatch, pattern: val as HatchPattern }; if (val === "material") delete v.hatch.pattern; });
    else if (vk === "exfast" || el.dataset.ex) {
      const on = (el as HTMLInputElement).checked;
      const ids = vk === "exfast" ? this.sectionComps().filter(c => c.fastener).map(c => c.id) : [el.dataset.ex!];
      this.setView("Don't cut", v => {
        const ex = new Set(v.exclude ?? []);
        for (const id of ids) { if (on) ex.add(id); else ex.delete(id); }
        if (ex.size) v.exclude = [...ex]; else delete v.exclude;
      });
    }
    else if (sk === "size") { this.setSheet("Sheet size", sh => { sh.size = val as SheetSize; }); this.fit(); }
    else if (sk === "projection") this.setSheet("Projection type", sh => switchProjection(sh, val as Sheet["projection"]));
    else if (sk === "format") {
      if (val.startsWith("user:")) {
        const id = val.slice(5), f = this.sheet.tb?.id === id ? this.sheet.tb : loadFormats().find(x => x.id === id);
        if (f) this.setSheet("Sheet format", sh => { sh.tb = structuredClone(f); if (sh.format === "gost") sh.format = "iso"; });
      } else this.setSheet("Sheet format", sh => { sh.format = val as Sheet["format"]; delete sh.tb; });
    }
    else if (el.dataset.st) {
      const k = el.dataset.st as keyof DraftStyle;
      this.store.change("Drafting style", d => { const st: DraftStyle = { ...d.style }; if (k === "arrow") st.arrow = val as DraftStyle["arrow"]; else (st as Record<string, number>)[k] = +val; d.style = st; });
    }
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
    else if (k === "escape") { if (this.mode.kind !== "none") this.cancelMode(); else if (this.el.querySelector(".drw-menu:not([hidden])")) this.closeMenus(); else if (this.sel || this.selA) { this.sel = null; this.selA = null; this.renderAll(); } else used = false; }
    else if (k === "enter" && this.mode.kind === "brokenout" && (tgt as Element) === this.svg) this.finishBroken(this.mode);
    else if (k === "enter" && this.mode.kind === "detail" && this.mode.prof && !this.mode.r && (this.mode.pts?.length ?? 0) >= 3 && (tgt as Element) === this.svg) this.finishProfile(this.mode);
    else if (k === "enter" && this.mode.kind === "section" && !this.mode.line && (this.mode.pts?.length ?? 0) >= 2 && (tgt as Element) === this.svg) this.finishPath(this.mode);
    else if (k === "enter" && this.mode.kind !== "none" && (tgt as Element) === this.svg) this.cancelMode();
    else if ((k === "delete" || k === "backspace") && this.selA && (tgt as Element) === this.svg) this.deleteAnnot();
    else if ((k === "delete" || k === "backspace") && this.sel && ((tgt as Element) === this.svg || tgt.closest(".drw-tree"))) void this.deleteSel();
    else if (k === "d" && tgt.closest(".drw")) this.startAnnot("dim");
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
    await Promise.all(sheets.flatMap(sh => sh.views.map(v => this.kernel.request(viewReq(sh, v)))));
    await Promise.all(sheets.flatMap(sh => sh.views.map(v => altReq(sh, v)).filter(r => !!r).map(r => this.kernel.alt(r!).catch(() => null))));
  }

  private composed(sh: Sheet) {
    return composeSheet(sh, this.fields(sh), this.kernel.cache, this.facts?.box ?? null, (s, p) => t(s, p), this.ctx(sh));
  }

  async exportAs(kind: "pdf" | "pdf1" | "svg" | "dxf" | "dxf2000" | "png" | "print") {
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
      else if (kind === "dxf2000") this.host.download(new Blob([sheetDxf2000(out[0].prims, out[0].W, out[0].H)], { type: "application/dxf" }), `${base}-${this.sheet.name}.dxf`);
      else if (kind === "dxf") this.host.download(new Blob([sheetDxf(out[0].prims, out[0].W, out[0].H)], { type: "application/dxf" }), `${base}-${this.sheet.name}.dxf`);
      else if (kind === "png") {
        const font = await (await fetch(fontUrl)).arrayBuffer();
        const r = await sheetPng(out[0].prims, out[0].W, out[0].H, font, 300);
        this.host.download(r.blob, `${base}-${this.sheet.name}.png`);
        if (r.dpi < 300) toast(t("The sheet is large: PNG saved at {dpi} dpi.", { dpi: r.dpi }));
      } else if (kind === "pdf" || kind === "pdf1") {
        const font = await (await fetch(fontUrl)).arrayBuffer();
        this.host.download(await sheetsPdf(out, font, this.fields().title), kind === "pdf1" ? `${base}-${this.sheet.name}.pdf` : `${base}.pdf`);
      } else { printSheets(out, base); return; }
      toast(t("Exported {kind}", { kind: kind.toUpperCase() }), "success");
    } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
  }

  /** For tests: the composed primitives of the current sheet. */
  debug() {
    return {
      doc: () => this.store?.doc ?? null,
      prims: () => (this.store ? this.composed(this.sheet).prims : []),
      ready: () => !!this.store && !this.loading && this.sheet.views.every(v => this.kernel.cache.has(viewReq(this.sheet, v).key) && (!altReq(this.sheet, v) || this.kernel.cache.has(altReq(this.sheet, v)!.key))),
      svg: () => (this.store ? (() => { const sh = this.sheet, [W, H] = sheetSize(sh); return sheetSvg(this.composed(sh).prims, W, H); })() : ""),
      dxf: () => (this.store ? (() => { const sh = this.sheet, [W, H] = sheetSize(sh); return sheetDxf(this.composed(sh).prims, W, H); })() : ""),
      sheetPt: (x: number, y: number) => { const rc = this.svg.getBoundingClientRect(), H = sheetSize(this.sheet)[1]; return [rc.left + (x - this.vb.x) / this.vb.w * rc.width, rc.top + (H - y - this.vb.y) / this.vb.h * rc.height]; },
      placement: (id: string) => this.placements.get(id) ?? null,
      mode: () => this.mode.kind,
      proj: (id: string) => { const sh = this.sheet, v = findView(sh, id); return v ? this.kernel.cache.get(viewReq(sh, v).key) ?? null : null; },
    };
  }
}

const STYLE_NAMES: Record<DisplayStyle, string> = { hlv: "Hidden lines visible", hlr: "Hidden lines removed", wire: "Wireframe", shaded: "Shaded", shadedEdges: "Shaded with edges" };
const KIND_NAMES: Record<NonNullable<DrawingView["kind"]>, string> = { section: "Section", detail: "Detail", aux: "Auxiliary" };
const ARROW_NAMES: Record<NonNullable<DraftStyle["arrow"]>, string> = { filled: "Filled", open: "Open", dot: "Dot", tick: "Oblique stroke" };
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
