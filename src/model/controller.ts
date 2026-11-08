// Part modelling UI (FRS phases P0/P1): the command bar over the view, the
// Features tab (feature tree and the property panel of the open command), the
// ✓/✕ confirm corner, sketch editing, picking faces and edges, and part files.
//
// The document (DocStore) is the source of truth; every rebuild sends it to the
// kernel worker and shows the returned body with the viewer's own pipeline, so
// the measuring tools work on modelled parts unchanged.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import type { EdgeInfo, PartData } from "../topology";
import { edgeLoop, sameEdges, tangentChain } from "./chain";
import { DocStore, dependants, moved, newPart, nextName, orderProblem, parents, uid } from "./doc";
import { activate, addConfig, nextConfigName, removeConfig, renameConfig } from "./configs";
import { evaluate, ExprError, isPlain } from "./expr";
import { journalDrop, journalList, journalSave, packPart, unpackPart, PART_EXT, type JournalEntry } from "./file";
import { snapshotList, snapshotRead, snapshotSave, SNAPSHOT_KEEP } from "./snapshots";
import { ModelKernel, type Rebuild } from "./kernelClient";
import type { FeatureFolder, ThreadFeature,
  AxisFeature, ChamferFeature, CsysFeature, CircularPatternFeature, EdgeRef, ExtrudeFeature, Feature, FeatureStatus, FilletFeature, ScaleFeature, Frame, LinearPatternFeature, LineRef,
  GlobalVar, HelixFeature, LoftFeature, RibFeature, SplitFeature, FaceRef, ImportFeature, CombineFeature, SplitBodyFeature, DeleteBodyFeature, MoveBodyFeature, DeleteFaceFeature, MoveFaceFeature, PlaneSurfFeature, ExtrudeSurfFeature, OffsetSurfFeature, KnitFeature, ThickenFeature, ReplaceFaceFeature, SweepFeature, HoleFeature, MirrorFeature, Num, PartDoc, PlaneFeature, PlaneRef, PointFeature, RevolveFeature, ShellFeature, DraftFeature, SketchFeature, V3, VertexRef,
} from "./types";
import { MATERIALS } from "../tools/analysis";
import { ISO_METRIC, HEAT_INSERTS, holeSize, insertSize, type HoleSize } from "./holes";

/** What a hole favourite keeps: the definition, not the placement. */
const HOLE_DEF_KEYS = ["kind", "size", "fit", "diameter", "end", "depth", "flat", "cbDia", "cbDepth", "csDia", "csAngle", "threadDepth", "major", "pitch"] as const;
interface HoleFav { name: string; def: Partial<HoleFeature> }
function loadFavs(): HoleFav[] { try { const v = JSON.parse(localStorage.getItem("mc:holeFavs") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveFavs(list: HoleFav[]) { try { localStorage.setItem("mc:holeFavs", JSON.stringify(list)); } catch { /* storage blocked: kept for this page only */ } }
function holeTitle(f: HoleFeature) { return `${f.size ?? `Ø${trimNum(f.diameter.v, 2)}`} ${f.kind}`; }

/** Nominal (major) diameter of an ISO metric size: "M6" → 6. */
const majorOf = (h: HoleSize) => parseFloat(h.size.slice(1));
import { evalVars, exprTargets, refreshExprs, renameEverywhere, validVarName } from "./params";
import { STD_FRAMES } from "../kernel/model";
import { ellOf, ellParam, ellPts, ellSweep } from "../sketch/ellipse";
import { bezPts, splineBezier } from "../sketch/spline";
import { SketchEditor, REL_NAME, relName, trimNum, type SkTool } from "../sketch/editor";
import { ORIGIN, repairs, solve } from "../sketch/solver";
import { sketchPath, sketchProfile } from "../sketch/profile";
import { SEL_FILTER } from "../tools/Snapper";
import { units, UNITS } from "../tools/units";
import { csys } from "../tools/csys";
import { confirmModal, toast, trapFocus } from "../ui";
import { onLangChange, t } from "../i18n";

export interface ModelHost {
  viewer: Viewer;
  vp: HTMLElement;
  /** Shows the part's body (null: no body yet) with the viewer pipeline; `first` resets the view and tools. */
  show(data: PartData | null, name: string, first: boolean): void;
  /** Face (index into the shown part's faces) under a screen point. */
  faceAt(clientX: number, clientY: number): { faceId: number; point: V3 } | null;
  /** Edge under a screen point (snapping), or the face when no edge is close. */
  edgeAt(clientX: number, clientY: number): { edge?: EdgeInfo; faceId?: number } | null;
  /** A snap point near a screen point (vertex, arc centre, midpoint, quadrant, face centre), if any. */
  snapAt?(clientX: number, clientY: number): { point: V3; kind: string } | null;
  /** The face picked with Smart measure, if any (used as the sketch plane). */
  selectedFace(): number | null;
  /** Clears Smart measure's pick and highlights. */
  clearPick(): void;
  setDoc(label: string): void;
  selectLeftTab(tab: "features" | "tree"): void;
  /** The edge picked with Smart measure, if any (pre-selection for fillet and chamfer). */
  selectedEdge?(): EdgeInfo | null;
  /** The part's material changed (or a part opened): preset the mass properties panel. */
  setMaterial?(m: { name: string; density: number } | undefined): void;
  /** Normal to the picked flat face (the view's "8"). */
  normalTo?(normal?: V3): void;
  /** Makes a coordinate system feature the active measurement and export frame (null: back to global); `src` is its feature id. */
  setCsys?(c: { name: string; src: string; o: V3; x: V3; z: V3 } | null, quiet?: boolean): void;
  /** Another document kind gives way (an open assembly closes). */
  leaveOthers?(): void;
  appVersion: string;
}

type Mode =
  | { kind: "none" }
  /** Picking a sketch plane: for a new sketch, or for an existing one (`edit`: Edit sketch plane, FR-SK-007). */
  | { kind: "plane"; edit?: { id: string; plane: PlaneRef } }
  | { kind: "sketch"; id: string; editor: SketchEditor; entry: string; isNew: boolean }
  | { kind: "feature"; draft: Feature; index: number; isNew: boolean; focus?: Focus; instant?: boolean }
  | { kind: "props"; draft: PartDoc }
  | { kind: "eq"; draft: GlobalVar[] }
  | { kind: "cfg" };

/** Which selection box of the feature panel the next click in the view fills. */
type Focus = "fs1" | "fs2" | "fc" | "main" | "bodies" | "base" | "axis" | "upto" | "start" | "origin" | "cx" | "cz" | "seeds" | "dir" | "dir2" | "mplane" | "faces" | "hplane" | "pts" | "nplane";
type CopyFeature = MirrorFeature | LinearPatternFeature | CircularPatternFeature;
type BodyFeature = CombineFeature | SplitBodyFeature | DeleteBodyFeature | MoveBodyFeature | ScaleFeature;
/** A fillet or chamfer has what it needs to preview: edges, or the face sets of a face fillet / full round. */
const roundReady = (f: FilletFeature | ChamferFeature) => f.type === "fillet" && f.kind
  ? !!f.faces1?.length && !!f.faces2?.length && (f.kind !== "full" || !!f.center?.length) : f.edges.length > 0;
const isBodyOp = (f: Feature): f is BodyFeature => f.type === "combine" || f.type === "bsplit" || f.type === "delbody" || f.type === "movebody" || f.type === "scale";
const isCopy = (f: Feature): f is CopyFeature => f.type === "mirror" || f.type === "lpattern" || f.type === "cpattern";
/** Features whose result mirror and patterns can copy. */
const SEED_TYPES = new Set(["extrude", "revolve", "mirror", "lpattern", "cpattern", "hole"]);

/** Fills a hole's sizes from the ISO table for its kind, size and fit (FR-FT-051). */
function applyHoleSize(f: HoleFeature) {
  if (f.kind === "insert") {
    const ins = insertSize(f.size);
    if (!ins) return;
    delete f.cbDia; delete f.cbDepth; delete f.csDia; delete f.csAngle; delete f.threadDepth; delete f.major; delete f.pitch; delete f.fit;
    f.diameter = { v: ins.hole };
    f.end = "blind";
    f.depth = { v: Math.round((ins.length + 1) * 10) / 10 };
    f.flat = true;
    return;
  }
  const h = holeSize(f.size);
  if (!h) return;
  const fit = f.fit ?? "normal";
  delete f.cbDia; delete f.cbDepth; delete f.csDia; delete f.csAngle; delete f.threadDepth; delete f.major; delete f.pitch;
  if (f.kind === "tapped") {
    f.diameter = { v: h.tap };
    f.major = parseFloat(h.size.slice(1));
    f.pitch = h.pitch;
    f.threadDepth = { v: Math.round(f.major * 2 * 10) / 10 };
    if (f.end === "blind" && f.depth.v < f.threadDepth.v + h.pitch * 2) f.depth = { v: Math.round((f.threadDepth.v + f.major * 0.5) * 10) / 10 };
  } else f.diameter = { v: h.clear[fit] };
  if (f.kind === "cbore") { f.cbDia = { v: h.cbore[0] }; f.cbDepth = { v: h.cbore[1] }; }
  if (f.kind === "csink") { f.csDia = { v: h.csink }; f.csAngle = { v: Math.PI / 2 }; }
}

const DEFAULT_COLOR: V3 = [0.72, 0.75, 0.8];
const STD_NAMES: Record<"XY" | "XZ" | "YZ", string> = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };
const ICONS: Record<string, string> = { helix: "∿", sweep: "⤳", loft: "⏢", rib: "⊿", split: "⊘", import: "⇩", combine: "⊕", bsplit: "◨", delbody: "⊖", movebody: "⇲", moveface: "⇧", delface: "⌫", planesurf: "▢", extsurf: "⊓", offsurf: "⫽", knit: "⧉", thicken: "▤", replaceface: "⇄", scale: "⤢", thread: "≋", hole: "◎", sketch: "✎", extrude: "▰", cut: "▱", revolve: "↻", fillet: "◜", chamfer: "◺", plane: "▭", axis: "⟋", point: "✳", csys: "⊹", shell: "◫", draft: "◿", mirror: "⧎", lpattern: "⋯", cpattern: "✲", part: "◆", material: "▦" };
const BASES = ["Revolve cut", "Sketch", "Extrude", "Cut", "Revolve", "Fillet", "Chamfer", "Plane", "Axis", "Point", "Coordinate system", "Shell", "Draft", "Mirror", "LPattern", "CirPattern", "Hole", "Thread", "Cut-Sweep", "Cut-Loft", "Helix", "Sweep", "Loft", "Rib", "Split Line", "Combine", "Split", "Body-Delete/Keep", "Body-Move/Copy", "Imported", "Scale", "DeleteFace", "MoveFace", "Surface-Plane", "Surface-Extrude", "Surface-Offset", "Surface-Knit", "Thicken", "ReplaceFace"];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** A default feature name ("Extrude2") in the interface language; renamed features stay as typed. */
export function featureLabel(name: string) {
  for (const b of BASES) { const m = name.match(new RegExp(`^${b}(\\d+)$`)); if (m) return `${t(b)}${m[1]}`; }
  return name;
}

/** Kernel messages are fixed English sentences; a lost reference names internal ids, so it gets a plain one. */
function statusText(s: FeatureStatus) {
  if (s.code === "warning" && s.warning) {
    const m = s.warning.match(/^(\d+) of (\d+) edges/);
    if (m) return t("{n} of {m} edges could not be rounded and were skipped.", { n: m[1], m: m[2] });
    const h = s.warning.match(/^Check and heal: (\d+) free edges before, (\d+) after; (valid|not valid) before, (valid|not valid) after; (\d+) solid bodies\.$/);
    if (h) return t("Check and heal: {a} free edges before, {b} after; {v0} before, {v1} after; {n} solid bodies.", { a: h[1], b: h[2], v0: t(h[3]), v1: t(h[4]), n: h[5] });
    const c = s.warning.match(/^(\d+) of (\d+) copies fall outside the body and were skipped: (.*)\.$/);
    return c ? t("{n} of {m} copies fall outside the body and were skipped (instances {list}).", { n: c[1], m: c[2], list: c[3] }) : t(s.warning);
  }
  if (s.code === "E-TN-LOST") return t("A face or edge this feature used is gone (reference lost).");
  if (s.code === "E-KRN-CRASH") return t("The geometry kernel stopped; it was restarted.");
  return t(s.message ?? "Error");
}

export class ModelController {
  store: DocStore | null = null;
  private kernel: ModelKernel;
  private last: Rebuild | null = null;
  private mode: Mode = { kind: "none" };
  private fileName = "";
  private handle: FileSystemFileHandle | null = null;
  /**
   * The open part came from a vault (FR-PDM-010/081): saving writes the working copy there, only while it is
   * checked out here; the title shows the version and a read-only bar offers Check out.
   */
  vault: { label: string; readOnly: boolean; save(bytes: Uint8Array): Promise<void>; checkOut(): Promise<void> } | null = null;

  /** Ties (or unties) the open part to a vault file and refreshes the title and read-only bar. */
  setVault(v: ModelController["vault"]) {
    this.vault = v;
    if (this.store) this.host.setDoc(this.docLabel());
    this.renderVaultBar();
  }

  private renderVaultBar() {
    let bar = document.getElementById("mc-ro");
    const show = !!this.store && !!this.vault?.readOnly;
    if (!show) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "mc-ro";
      bar.className = "mc-ro";
      bar.setAttribute("role", "status");
      document.getElementById("tab-features")!.prepend(bar);
    }
    bar.innerHTML = `<span>${esc(t("Read-only: check out to edit"))}</span><button class="btn small primary" data-a="co">${esc(t("Check out"))}</button>`;
    bar.querySelector("button")!.addEventListener("click", () => { void this.vault?.checkOut(); });
  }

  /** The bytes of the open part, as saved (for the vault). */
  async partBytes() {
    if (!this.store) return null;
    if (this.mode.kind === "sketch") this.ok();
    return packPart(this.doc, `MöbiusCAD ${this.host.appVersion}`);
  }

  /** Edit part in place (FR-ASM-007): the assembly the part came from, and how to go back to it with the edited part. */
  returnTo: { label: string; back(doc: PartDoc): void } | null = null;

  /** Opens a component's part for editing; Return to assembly hands the edited part back. */
  editIn(doc: PartDoc, fileName: string, ret: { label: string; back(doc: PartDoc): void }) {
    this.load(doc, fileName, null);
    this.store!.markSaved();
    this.returnTo = ret;
    this.renderReturnBar();
  }

  /** Back to the assembly with the part as it is now. */
  returnToAssembly() {
    const r = this.returnTo;
    if (!r || !this.store) return;
    if (this.mode.kind === "sketch") this.ok();
    else if (this.mode.kind !== "none") this.exitMode(false);
    const doc = JSON.parse(JSON.stringify(this.doc)) as PartDoc;
    // The assembly keeps the edit; the recovery journal does not need it.
    this.store.markSaved();
    journalDrop(this.doc.id);
    this.returnTo = null;
    r.back(doc);
  }

  private renderReturnBar() {
    let bar = document.getElementById("mc-ret");
    if (!this.store || !this.returnTo) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "mc-ret";
      bar.className = "mc-ro";
      bar.setAttribute("role", "status");
      document.getElementById("tab-features")!.prepend(bar);
    }
    bar.innerHTML = `<span>${esc(t("Editing a part of {asm}", { asm: this.returnTo.label }))}</span><button class="btn small primary" data-a="ret">${esc(t("Return to assembly"))}</button>`;
    bar.querySelector("button")!.addEventListener("click", () => this.returnToAssembly());
  }

  /** Marks the open part saved (the vault wrote it). */
  markSaved() { if (!this.store) return; this.store.markSaved(); journalDrop(this.doc.id); }
  private selected: string | null = null;
  private journalTimer = 0;
  private shownOnce = false;
  private decor = new THREE.Group();
  private planeMeshes: THREE.Mesh[] = [];
  private lineMats: LineMaterial[] = [];
  private down: { x: number; y: number } | null = null;
  private busyCount = 0;
  private rebuildMs = 0;
  /** Undo mark taken when a sketch was opened: leaving it merges its steps (FR-UND-003). */
  private sketchMark = 0;
  /** The depth arrow of an extrude (FR-FT-017): its mesh, and the drag in progress. */
  /** Drag handle: the extrude depth arrow, or the revolve angle handle (`ang` set: centre on the axis, unit axis, radius vector at 0°). */
  private arrow: { obj: THREE.Group; pick: THREE.Mesh; base: THREE.Vector3; dir: THREE.Vector3; scale: number; mid: boolean; ang?: { c: THREE.Vector3; u: THREE.Vector3; r: THREE.Vector3; arc: THREE.Line; head: THREE.Group } } | null = null;
  private arrowDrag: { start: number; depth: number; moved: boolean; raw?: number } | null = null;

  constructor(private host: ModelHost, occtBase: string) {
    this.kernel = new ModelKernel(occtBase);
    document.getElementById("ft-search")?.addEventListener("input", () => this.renderTree());
    this.kernel.onCrash = () => toast(t("The geometry kernel stopped; it was restarted."), "warn");
    host.viewer.scene.add(this.decor);
    host.viewer.beforeRender.push(() => {
      for (const m of this.lineMats) m.resolution.set(host.viewer.size.x, host.viewer.size.y);
      this.sizeArrow();
      this.placeCallouts();
    });
    this.bindDom();
    onLangChange(() => {
      if (this.active) { this.renderBar(); this.renderTree(); this.renderPanel(); this.renderStatus(); }
      if (this.mode.kind === "sketch") { this.mode.editor.render(); this.mode.editor.statusHint(); }
      this.renderRecovery();
    });
    this.renderRecovery();
  }

  get active() { return !!this.store; }
  /** A command is taking clicks in the view (Smart measure leaves them alone). */
  get picking() { return this.mode.kind !== "none" || !!this.arrowDrag; }
  get editingSketch() { return this.mode.kind === "sketch"; }
  private get doc() { return this.store!.doc; }

  // ---------- opening and closing ----------

  /** Starts a new, empty part. */
  newPart() {
    let n = 1;
    const used = new Set(journalList().map(j => j.doc.name));
    while (used.has(`Part${n}`)) n++;
    this.load(newPart(`Part${n}`), "", null);
    this.warm();
    toast(t("New part: click Sketch, pick a plane and draw a closed profile, then Extrude."));
  }

  warm() { this.kernel.warm(); }

  isPartName(name: string) { return name.toLowerCase().endsWith(PART_EXT); }

  async openFile(file: File | { name: string; data: ArrayBuffer }, handle: FileSystemFileHandle | null = null) {
    const buf = file instanceof File ? await file.arrayBuffer() : file.data;
    let doc: PartDoc;
    try { doc = await unpackPart(buf); }
    catch (err) { toast(t("Could not open {name}: {err}", { name: file.name, err: t((err as Error).message) }), true); return; }
    this.load(doc, file.name, handle);
  }

  private load(doc: PartDoc, fileName: string, handle: FileSystemFileHandle | null) {
    this.host.leaveOthers?.();
    this.exitMode(false);
    this.vault = null;
    this.renderVaultBar();
    this.returnTo = null;
    this.renderReturnBar();
    this.fileName = fileName;
    this.handle = handle;
    this.selected = null;
    this.shownOnce = false;
    this.last = null;
    if (this.store) this.store.reset(doc);
    else {
      this.store = new DocStore(doc);
      this.store.onChange(why => this.changed(why));
      // Equations: every change re-evaluates the kept expressions (FR-PAR-002/003).
      this.store.normalize = d => {
        refreshExprs(d, units.current);
        // Folders and the freeze bar follow the features: gone ids drop out, empty folders go.
        const have = new Set(d.features.map(f => f.id));
        if (d.folders) { for (const g of d.folders) g.ids = g.ids.filter(x => have.has(x)); d.folders = d.folders.filter(g => g.ids.length); if (!d.folders.length) delete d.folders; }
        if (d.freezeAfter && !have.has(d.freezeAfter)) delete d.freezeAfter;
      };
    }
    document.getElementById("app")!.classList.add("model");
    // The start card goes at once, not when the kernel's first rebuild comes back (that can take seconds).
    $("#empty").hidden = true;
    this.host.viewer.emptySize = 50;
    $("#t-features").hidden = false;
    this.host.selectLeftTab("features");
    this.host.setMaterial?.(doc.material);
    this.renderAll();
    void this.rebuild();
  }

  /** Another file was opened in the viewer: leave modelling (the journal keeps unsaved work). */
  close() {
    if (!this.store) return;
    this.exitMode(false);
    if (this.store.dirty) journalSave(this.doc, this.fileName);
    if (csys.active?.src) this.host.setCsys?.(null, true);
    this.store = null;
    this.vault = null;
    this.renderVaultBar();
    this.returnTo = null;
    this.renderReturnBar();
    this.last = null;
    this.clearDecor();
    this.kernel.stop();
    document.getElementById("app")!.classList.remove("model");
    this.host.viewer.emptySize = 1;
    $("#t-features").hidden = true;
    this.host.selectLeftTab("tree");
    this.renderRecovery();
  }

  /** The open part's file name ("" when none is open). */
  get partName() { return this.store ? this.displayName() : ""; }

  private displayName() { return this.fileName || `${this.store?.doc.name ?? ""}${PART_EXT}`; }

  // ---------- document changes and rebuilds ----------

  private changed(why: string) {
    const m = this.mode;
    if (m.kind === "sketch") {
      const sk = this.store!.feature(m.id);
      if (!sk || sk.type !== "sketch") { this.exitMode(false); void this.rebuild(); }
      else if (why === "undo" || why === "redo") m.editor.setSketch(sk, this.frameOf(sk));
      this.renderPanel();
    } else if (m.kind === "feature" && (why === "undo" || why === "redo")) {
      this.exitMode(false);
      void this.rebuild();
    } else void this.rebuild();
    this.renderTree();
    this.renderBar();
    this.renderEmpty();
    this.host.setDoc(this.docLabel());
    if (why === "undo" || why === "redo" || why.startsWith("Properties")) this.host.setMaterial?.(this.doc.material);
    if (why !== "saved" && why !== "open") {
      clearTimeout(this.journalTimer);
      this.journalTimer = window.setTimeout(() => { if (this.store?.dirty) journalSave(this.doc, this.fileName); }, 800);
    }
  }

  private docLabel() { return `${this.displayName()}${this.vault ? ` · ${this.vault.label}` : ""}${this.store?.dirty ? " •" : ""}`; }

  /** The document as shown: with the open command's draft, rolled back while a sketch or a pick is open. */
  private displayDoc(): PartDoc {
    const d: PartDoc = structuredClone(this.doc);
    const m = this.mode;
    if (m.kind === "sketch") {
      const i = d.features.findIndex(f => f.id === m.id);
      d.rollback = i + 1;
    } else if (m.kind === "plane" && m.edit) {
      // Edit sketch plane: rolled back to the sketch, which shows on the plane picked so far.
      const i = d.features.findIndex(f => f.id === m.edit!.id);
      const sk = d.features[i];
      if (sk?.type === "sketch") { sk.plane = m.edit.plane; sk.hidden = false; d.rollback = i + 1; }
    } else if (m.kind === "feature") {
      const f = structuredClone(m.draft);
      if (m.isNew) d.features.splice(m.index, 0, f); else d.features[m.index] = f;
      // Fillet and chamfer pick edges on the body before them; extrude, revolve and planes preview live.
      d.rollback = f.type === "fillet" || f.type === "chamfer" ? m.index : m.index + 1;
    } else if (m.kind === "props") d.color = m.draft.color;
    return d;
  }

  private async rebuild() {
    if (!this.store) return;
    const doc = this.displayDoc();
    this.setBusy(1);
    const m = this.mode;
    const d = m.kind === "feature" ? m.draft : null;
    const previewAt = m.kind === "feature" && d && (((d.type === "fillet" || d.type === "chamfer") && roundReady(d)) || ((d.type === "extrude" || d.type === "revolve" || d.type === "sweep" || d.type === "loft") && d.op === "cut")) ? m.index : undefined;
    const r = await this.kernel.rebuild(doc, doc.color ?? DEFAULT_COLOR, 1, previewAt);
    this.setBusy(-1);
    if (!r || !this.store) return;
    this.last = r;
    this.followEdges(r);
    this.rebuildMs = r.ms.eval + r.ms.mesh;
    this.syncCsys();
    const first = !this.shownOnce;
    this.shownOnce = true;
    this.host.show(r.data, this.doc.name, first);
    this.host.setDoc(this.docLabel());
    if (first && !r.data) this.host.viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
    this.drawDecor();
    this.renderTree();
    this.renderStatus();
    this.renderEmpty();
    if (this.mode.kind === "feature" && !this.arrowDrag) this.renderPanel();
    const hm = this.mode;
    if (this.pendingHole.length && hm.kind === "feature" && hm.draft.type === "hole") {
      // A rebuild started before the face was picked has no frame yet: keep waiting for the next one.
      const fr = r.frames[hm.draft.id];
      if (fr) { const ws = this.pendingHole; this.pendingHole = []; for (const w of ws) this.placeHole(hm.draft, this.holeSnap(w.at, fr) ?? w.p, fr); }
    } else this.pendingHole = [];
  }

  /** Takes over the sketches the rebuild moved onto their model edges or marked dangling (FR-SK-064). */
  private followEdges(r: Rebuild) {
    const upd = r.sketches ?? {};
    for (const [id, sk] of Object.entries(upd)) {
      const cur = this.store!.feature(id);
      if (!cur || cur.type !== "sketch") continue;
      const m = this.mode;
      const editing = m.kind === "sketch" && m.id === id;
      // Only the parts the rebuild owns: point positions of followed curves and dangling marks, on the sketch as it is now.
      const next: SketchFeature = structuredClone(editing ? m.editor.sk : cur);
      const before = JSON.stringify(next);
      const pts = new Set<string>();
      for (const rel of next.rels) {
        const src = sk.rels.find(x => x.id === rel.id);
        if (!src || !rel.ext) continue;
        if (src.dangling) rel.dangling = true; else delete rel.dangling;
        const e = next.ents.find(x => x.id === rel.e[0]);
        if (e?.t === "line") { pts.add(e.a); pts.add(e.b); }
        else if (e?.t === "arc") { pts.add(e.c); pts.add(e.a); pts.add(e.b); }
        else if (e?.t === "circle") { pts.add(e.c); const r = sk.ents.find(x => x.id === e.id); if (r?.t === "circle") e.r = r.r; }
      }
      for (const e of next.ents) {
        const src = e.t === "point" && pts.has(e.id) ? sk.ents.find(x => x.id === e.id) : null;
        if (e.t === "point" && src?.t === "point") { e.x = src.x; e.y = src.y; }
      }
      const changed = JSON.stringify(next) !== before;
      if (changed) solve(next);
      if (!changed) continue;
      this.store!.amend(d => { const i = d.features.findIndex(f => f.id === id); if (i >= 0) d.features[i] = structuredClone(next); });
      if (editing && !m.editor.busy) m.editor.setSketch(next, this.frameOf(next));
    }
  }

  /** Rebuild (Ctrl+B), or force a rebuild of every feature with a fresh kernel (Ctrl+Q). */
  forceRebuild(all: boolean) {
    if (!this.store) return;
    if (all) this.kernel.stop();
    void this.rebuild();
    toast(all ? t("Rebuilt all features") : t("Rebuilt"));
  }

  private setBusy(d: number) {
    this.busyCount += d;
    $("#mc-busy").hidden = this.busyCount <= 0;
  }

  /** World frame of a sketch: standard planes are fixed, face sketches come from the last rebuild. */
  private frameOf(sk: SketchFeature): Frame {
    if ("std" in sk.plane) return STD_FRAMES[sk.plane.std];
    return this.last?.frames[sk.id] ?? STD_FRAMES.XY;
  }

  // ---------- commands ----------

  /** Sketch: on the picked flat face or the selected plane; otherwise asks for one. */
  startSketch() {
    if (!this.store) return;
    this.exitMode(false);
    const fid = this.pickedFace();
    const pr = fid != null ? this.planeOfFace(fid) : null;
    if (pr) { void this.createSketch(pr); return; }
    const sel = this.selected && this.selected.startsWith("std:") ? this.selected.slice(4) as "XY" | "XZ" | "YZ" : null;
    if (sel) { void this.createSketch({ std: sel }); return; }
    const pl = this.selected ? this.store.feature(this.selected) : undefined;
    if (pl?.type === "plane" && !pl.suppressed) { void this.createSketch({ plane: pl.id }); return; }
    this.mode = { kind: "plane" };
    this.renderAll();
    this.drawDecor();
  }

  private planeOfFace(faceId: number): PlaneRef | null {
    const name = this.last?.faceNames[faceId];
    const face = this.host.viewer.parts[0]?.data.faces[faceId];
    if (!name || !face) return null;
    if (face.type !== "plane") { toast(t("A sketch needs a flat face or a plane."), true); return null; }
    return { face: { name, hint: face.centroid } };
  }

  private async createSketch(plane: PlaneRef) {
    const id = uid("f_");
    const before = JSON.stringify(this.doc);
    const mark = this.store!.mark();
    this.mode = { kind: "none" };
    this.store!.change("New sketch", d => {
      const at = d.rollback ?? d.features.length;
      d.features.splice(at, 0, { id, type: "sketch", name: nextName(d, "sketch"), plane, ents: [], rels: [], dims: [] });
      if (d.rollback != null) d.rollback++;
    });
    await this.editSketch(id, before, true, mark);
  }

  async editSketch(id: string, entry = JSON.stringify(this.doc), isNew = false, mark = this.store?.mark() ?? 0) {
    const sk = this.store?.feature(id);
    if (!sk || sk.type !== "sketch") return;
    if (!isNew && this.isFrozen(id)) { this.frozenToast(); return; }
    this.exitMode(false);
    this.sketchMark = mark;
    this.host.clearPick();
    // Face sketches need the face's frame from a rebuild up to the sketch.
    const editor = new SketchEditor({
      viewer: this.host.viewer,
      layer: $("#sk-layer"),
      commit: (label, next) => this.store!.change(label, d => { const i = d.features.findIndex(f => f.id === id); if (i >= 0) d.features[i] = next; }),
      status: text => { $("#mc-status").textContent = text; },
      toast: (msg, kind) => toast(msg, kind ?? "info"),
      unit: () => ({ mm: 1 / UNITS[units.current].f, name: units.current, decimals: units.decimals ?? this.doc.units.decimals }),
      vars: () => evalVars(this.doc, units.current).values,
      onSelection: () => this.renderPanel(),
      modelEdges: e => {
        const hit = this.host.edgeAt(e.clientX, e.clientY);
        const data = this.host.viewer.parts[0]?.data;
        if (!hit || !data) return null;
        return hit.edge ? [hit.edge] : hit.faceId != null ? data.edges.filter(x => x.faces.includes(hit.faceId!)) : null;
      },
      modelFace: e => {
        const hit = this.host.faceAt(e.clientX, e.clientY);
        const data = this.host.viewer.parts[0]?.data;
        const face = hit && data ? data.faces[hit.faceId] : undefined;
        if (!face || !data) return null;
        const tri = new Float32Array(face.triCount * 9);
        for (let t = 0; t < face.triCount; t++) for (let k = 0; k < 3; k++) {
          const v = data.index[(face.triStart + t) * 3 + k] * 3;
          tri.set([data.positions[v], data.positions[v + 1], data.positions[v + 2]], t * 9 + k * 3);
        }
        return { tri, type: face.type, axis: face.axis, center: face.center, radius: face.radius };
      },
      edgeRef: ed => this.refOfEdge(ed as EdgeInfo),
      renamedDim: (from, to) => this.store!.change("Rename dimension", d => renameEverywhere(d, from, to)),
    }, sk, this.frameOf(sk));
    this.mode = { kind: "sketch", id, editor, entry, isNew };
    document.getElementById("app")!.classList.add("sketching");
    this.renderAll();
    editor.statusHint();
    await this.rebuild();
    const m = this.mode as Mode;
    if (m.kind === "sketch" && m.id === id) {
      const f = this.frameOf(sk);
      m.editor.setSketch(this.store!.feature(id) as SketchFeature, f);
      this.host.viewer.viewFrom(new THREE.Vector3(...f.n));
    }
  }

  /** Extrude / Cut / Revolve / Fillet / Chamfer: opens the property panel with a draft. */
  startFeature(type: "extrude" | "cut" | "revolve" | "fillet" | "chamfer" | "plane" | "axis" | "point" | "csys" | "shell" | "draft" | "mirror" | "lpattern" | "cpattern" | "hole" | "thread" | "helix" | "sweep" | "sweepcut" | "loft" | "loftcut" | "rib" | "split" | "combine" | "bsplit" | "delbody" | "movebody" | "scale" | "delface" | "moveface" | SurfTool) {
    if (!this.store) return;
    // Starting a feature from inside a sketch exits the sketch and uses it (FR-SK-004).
    const fromSketch = this.mode.kind === "sketch" ? this.mode.id : null;
    if (fromSketch) { this.ok(); this.selected = fromSketch; }
    // Pre-selected edges for fillet and chamfer (FR-SEL-006): the edge picked with Smart measure.
    const selEdge = (type === "fillet" || type === "chamfer") ? this.pickedEdge() : null;
    const threadEdge = type === "thread" ? this.pickedEdge() : null;
    const pre = selEdge ? this.refOfEdge(selEdge) : null;
    const preFace = type === "plane" ? this.pickedFace() : null;
    // Axis and point take a picked edge or face too.
    const refEdge = type === "axis" || type === "point" ? this.pickedEdge() : null;
    const refFace = type === "axis" || type === "point" ? this.pickedFace() : null;
    const csysEdge = type === "csys" ? this.pickedEdge() : null;
    const shellFace = type === "shell" || type === "hole" || type === "draft" || type === "delface" || type === "moveface" || type === "offsurf" || type === "knit" || type === "thicken" || type === "replaceface" ? this.pickedFace() : null;
    const seedSel = this.selected && SEED_TYPES.has(this.store.feature(this.selected)?.type ?? "") ? this.selected : null;
    this.exitMode(false);
    const d = this.doc;
    const end = d.rollback ?? d.features.length;
    const sketches = d.features.slice(0, end).filter((f): f is SketchFeature => f.type === "sketch");
    const used = new Set(d.features.flatMap(f => (f.type === "extrude" || f.type === "revolve" ? [f.sketch] : [])));
    const pick = (this.selected && sketches.find(s => s.id === this.selected)) || [...sketches].reverse().find(s => !used.has(s.id)) || sketches.at(-1);
    let draft: Feature;
    const id = uid("f_");
    if (type === "extrude" || type === "cut") {
      if (!pick) { toast(t("Draw a sketch first."), true); return; }
      const cut = type === "cut";
      draft = { id, type: "extrude", name: nextName(d, "extrude", cut), sketch: pick.id, op: cut ? "cut" : "boss", end: cut && this.last?.data ? "through" : "blind", depth: { v: 10 } } satisfies ExtrudeFeature;
    } else if (type === "revolve") {
      if (!pick) { toast(t("Draw a sketch first."), true); return; }
      const lines = pick.ents.filter(e => e.t === "line");
      const axis = (lines.find(l => l.cons) ?? lines[0])?.id ?? "";
      draft = { id, type: "revolve", name: nextName(d, "revolve"), sketch: pick.id, op: "boss", axis, angle: { v: 2 * Math.PI } } satisfies RevolveFeature;
    } else if (type === "plane") {
      const selPlane = this.selected?.startsWith("std:") ? { std: this.selected.slice(4) as "XY" } : this.selected && this.store.feature(this.selected)?.type === "plane" ? { plane: this.selected } : null;
      const base: PlaneRef = (preFace != null ? this.planeOfFace(preFace) : null) ?? selPlane ?? { std: "XY" };
      draft = { id, type: "plane", name: nextName(d, "plane"), base, mode: "offset", offset: { v: 10 } } satisfies PlaneFeature;
    } else if (type === "axis") {
      const a: AxisFeature = { id, type: "axis", name: nextName(d, "axis"), mode: "edge" };
      const fr = refFace != null ? this.faceRef(refFace) : null;
      if (refEdge?.type === "line") a.edge = this.refOfEdge(refEdge) ?? undefined;
      else if (fr && this.host.viewer.parts[0]?.data.faces[refFace!]?.type === "cylinder") { a.mode = "cylinder"; a.face = fr; }
      draft = a;
    } else if (type === "point") {
      const pt: PointFeature = { id, type: "point", name: nextName(d, "point"), mode: "vertex" };
      if (refEdge) { pt.edge = this.refOfEdge(refEdge) ?? undefined; pt.mode = refEdge.type === "circle" || refEdge.type === "arc" ? "centre" : "mid"; }
      else if (refFace != null) { const fr = this.faceRef(refFace); if (fr) { pt.mode = "face"; pt.face = fr; } }
      draft = pt;
    } else if (type === "csys") {
      const cs: CsysFeature = { id, type: "csys", name: nextName(d, "csys") };
      // A picked straight edge: the origin at its start, X along it.
      const er = csysEdge?.type === "line" ? this.refOfEdge(csysEdge) : null;
      if (er && csysEdge) { cs.origin = { edge: er, at: csysEdge.start }; cs.x = { edge: er }; }
      draft = cs;
    } else if (type === "hole") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const h: HoleFeature = { id, type: "hole", name: nextName(d, "hole"), pts: [], kind: "simple", size: "M6", fit: "normal", diameter: { v: 6.6 }, end: "through", depth: { v: 10 } };
      const fid = shellFace;
      const face = fid != null ? this.host.viewer.parts[0]?.data.faces[fid] : undefined;
      if (fid != null && face?.type === "plane") { const pr = this.planeOfFace(fid); if (pr) h.plane = pr; }
      draft = h;
    } else if (type === "thread") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const th: ThreadFeature = { id, type: "thread", name: nextName(d, "thread"), diameter: { v: 6 }, length: { v: 10 }, upToEnd: true };
      if (threadEdge) this.setThreadEdge(th, threadEdge);
      draft = th;
    } else if (type === "combine" || type === "bsplit" || type === "delbody" || type === "movebody" || type === "scale") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const nm = nextName(d, type);
      draft = type === "combine" ? { id, type, name: nm, op: "add", tools: [] } satisfies CombineFeature
        : type === "bsplit" ? { id, type, name: nm, bodies: [] } satisfies SplitBodyFeature
        : type === "delbody" ? { id, type, name: nm, bodies: [] } satisfies DeleteBodyFeature
        : type === "scale" ? { id, type, name: nm, bodies: [], about: "centroid", factor: { v: 1 } } satisfies ScaleFeature
        : { id, type, name: nm, bodies: [], dx: { v: 0 }, dy: { v: 0 }, dz: { v: 0 } } satisfies MoveBodyFeature;
    } else if (type === "split") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const hasCurves = (s: SketchFeature) => s.ents.some(e => !e.cons && e.t !== "point");
      const sel = this.selected ? sketches.find(s => s.id === this.selected && hasCurves(s)) : undefined;
      const sk = sel ?? sketches.filter(s => !used.has(s.id) && hasCurves(s)).at(-1);
      draft = { id, type: "split", name: nextName(d, "split"), sketch: sk?.id ?? "", faces: [] } satisfies SplitFeature;
    } else if (type === "rib") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      // The selected open sketch, else the last unused one (SolidWorks: sketch the rib line, then Rib).
      const sel = this.selected ? sketches.find(s => s.id === this.selected && sketchOpenOk(s)) : undefined;
      const sk = sel ?? sketches.filter(s => !used.has(s.id) && sketchOpenOk(s)).at(-1);
      draft = { id, type: "rib", name: nextName(d, "rib"), sketch: sk?.id ?? "", thickness: { v: 5 }, side: "mid", dir: "parallel" } satisfies RibFeature;
    } else if (type === "helix" || type === "sweep" || type === "sweepcut" || type === "loft" || type === "loftcut") {
      const p3 = this.p3Draft(type, id, sketches, used);
      if (!p3) return;
      draft = p3;
    } else if (SURF_TYPES.has(type)) {
      const sf = this.surfDraft(type as SurfTool, id, sketches, used, shellFace);
      if (!sf) return;
      draft = sf;
    } else if (type === "draft") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      // SolidWorks order: the neutral plane first (a picked flat face), then the faces to draft.
      const dr: DraftFeature = { id, type: "draft", name: nextName(d, "draft"), faces: [], angle: { v: Math.PI / 180 } };
      const face = shellFace != null ? this.host.viewer.parts[0]?.data.faces[shellFace] : undefined;
      if (shellFace != null && face?.type === "plane") { const pr = this.planeOfFace(shellFace); if (pr) dr.plane = pr; }
      draft = dr;
    } else if (type === "shell" || type === "mirror" || type === "lpattern" || type === "cpattern" || type === "delface" || type === "moveface") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const seeds = seedSel ? [seedSel] : [];
      if (type === "delface" || type === "moveface") {
        const fr = shellFace != null ? this.faceRef(shellFace) : null;
        draft = type === "delface" ? { id, type, name: nextName(d, type), faces: fr ? [fr] : [] } satisfies DeleteFaceFeature
          : { id, type, name: nextName(d, type), faces: fr ? [fr] : [], distance: { v: 5 } } satisfies MoveFaceFeature;
      } else if (type === "shell") {
        const fr = shellFace != null ? this.faceRef(shellFace) : null;
        draft = { id, type: "shell", name: nextName(d, "shell"), thickness: { v: 2 }, faces: fr ? [fr] : [] } satisfies ShellFeature;
      } else if (type === "mirror") draft = { id, type: "mirror", name: nextName(d, "mirror"), features: seeds } satisfies MirrorFeature;
      else if (type === "lpattern") draft = { id, type: "lpattern", name: nextName(d, "lpattern"), features: seeds, spacing: { v: 10 }, count: 3 } satisfies LinearPatternFeature;
      else draft = { id, type: "cpattern", name: nextName(d, "cpattern"), features: seeds, count: 4, angle: { v: 2 * Math.PI }, equal: true } satisfies CircularPatternFeature;
    } else {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      draft = type === "fillet"
        ? { id, type: "fillet", name: nextName(d, "fillet"), radius: { v: 2 }, edges: [] } satisfies FilletFeature
        : { id, type: "chamfer", name: nextName(d, "chamfer"), distance: { v: 1 }, edges: [] } satisfies ChamferFeature;
      if (pre) (draft as FilletFeature).edges = [pre];
    }
    const index = end;
    const focus: Focus | undefined = type === "plane" ? "base" : type === "shell" || type === "delface" || type === "moveface" || type === "offsurf" ? "faces" : type === "draft" ? ((draft as DraftFeature).plane ? "faces" : "nplane") : type === "hole" ? ((draft as HoleFeature).plane ? "pts" : "hplane")
      : type === "mirror" ? ((draft as MirrorFeature).features.length ? "mplane" : "seeds")
      : type === "lpattern" || type === "cpattern" ? ((draft as CopyFeature).features.length ? "dir" : "seeds")
      : type === "csys" ? ((draft as CsysFeature).origin ? "cz" : "origin")
      : type === "combine" ? "main" : type === "bsplit" ? "mplane" : type === "delbody" || type === "movebody" || type === "scale" ? "bodies" : undefined;
    this.mode = { kind: "feature", draft, index, isNew: true, focus };
    this.host.clearPick();
    this.renderAll();
    void this.rebuild();
  }

  /**
   * New helix, sweep or loft (FRS 9.9) with sensible picks: a helix on the selected (or last) sketch with a
   * circle; a sweep along the last helix or a path sketch, with the last unused closed sketch as its
   * profile (else a circular profile); a loft through the last two unused sketches.
   */
  private p3Draft(type: "helix" | "sweep" | "sweepcut" | "loft" | "loftcut", id: string, sketches: SketchFeature[], used: Set<string>): Feature | null {
    const d = this.doc;
    const end = d.rollback ?? d.features.length;
    const sel = this.selected ? sketches.find(s => s.id === this.selected) : undefined;
    const closed = (s: SketchFeature) => !sketchProfile(s).error;
    if (type === "helix") {
      const withCircle = sketches.filter(s => s.ents.some(e => e.t === "circle"));
      const sk = (sel && withCircle.includes(sel) ? sel : null) ?? withCircle.at(-1);
      if (!sk) { toast(t("Draw a sketch with a circle first: the helix starts on it."), true); return null; }
      return { id, type: "helix", name: nextName(d, "helix"), sketch: sk.id, mode: "pitchRev", pitch: { v: 5 }, revs: { v: 4 }, height: { v: 20 } } satisfies HelixFeature;
    }
    const cut = type === "sweepcut" || type === "loftcut";
    if (cut && !this.last?.data) { toast(t("There is no body yet."), true); return null; }
    const free = sketches.filter(s => !used.has(s.id) && !d.features.some(g => (g.type === "sweep" && (g.profile === s.id || (g.path && "sketch" in g.path && g.path.sketch === s.id))) || (g.type === "loft" && g.profiles.includes(s.id)) || (g.type === "helix" && g.sketch === s.id)));
    if (type === "loft" || type === "loftcut") {
      const profs = free.filter(closed).slice(-2);
      return { id, type: "loft", name: nextName(d, "loft", cut), op: cut ? "cut" : "boss", profiles: profs.map(s => s.id) } satisfies LoftFeature;
    }
    const helix = d.features.slice(0, end).filter(f => f.type === "helix" && !f.suppressed).at(-1);
    const profile = (sel && closed(sel) ? sel : null) ?? free.filter(closed).at(-1);
    const pathSk = free.filter(s => s !== profile && !closed(s)).at(-1);
    const sw: SweepFeature = { id, type: "sweep", name: nextName(d, "sweep", cut), op: cut ? "cut" : "boss" };
    if (helix) sw.path = { helix: helix.id }; else if (pathSk) sw.path = { sketch: pathSk.id };
    if (profile && !(helix && profile.id === (helix as HelixFeature).sketch)) sw.profile = profile.id; else sw.circular = { v: 2 };
    return sw;
  }

  editFeature(id: string) {
    const i = this.doc.features.findIndex(f => f.id === id);
    const f = this.doc.features[i];
    if (!f) return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    if (f.type === "sketch") { void this.editSketch(id); return; }
    this.exitMode(false);
    this.mode = { kind: "feature", draft: structuredClone(f), index: i, isNew: false };
    this.host.clearPick();
    this.renderAll();
    void this.rebuild();
  }

  /** ✓: keeps the sketch or the feature. */
  ok() {
    const m = this.mode;
    if (m.kind === "sketch") {
      const sk = this.store!.feature(m.id);
      this.exitMode(true);
      if (sk) this.store!.collapse(this.sketchMark, m.isNew ? `Add ${sk.name}` : `Edit ${sk.name}`);
      this.renderBar();
      void this.rebuild();
      return;
    }
    if (m.kind === "plane" && m.edit) {
      const { id, plane } = m.edit;
      this.mode = { kind: "none" };
      this.store!.change("Edit sketch plane", d => { const f = d.features.find(x => x.id === id); if (f?.type === "sketch") f.plane = plane; });
      this.clearDecor();
      this.renderAll();
      void this.rebuild();
      return;
    }
    if (m.kind === "plane") { toast(t("Pick a plane or a flat face for the sketch.")); return; }
    if (m.kind === "cfg") { this.mode = { kind: "none" }; this.renderAll(); return; }
    if (m.kind === "eq") {
      const names = new Set<string>();
      for (const v of m.draft) {
        if (!validVarName(v.name)) { toast(t("“{name}” is not a valid name: use letters, digits and _ , starting with a letter.", { name: v.name }), true); return; }
        if (names.has(v.name)) { toast(t("Two variables are called “{name}”.", { name: v.name }), true); return; }
        names.add(v.name);
      }
      const errs = evalVars({ ...this.doc, vars: m.draft }, units.current).errors;
      const bad = Object.entries(errs)[0];
      if (bad) { toast(`${bad[0]}: ${t(bad[1].key, bad[1].params)}`, true); return; }
      const dr = m.draft;
      this.mode = { kind: "none" };
      this.store!.change("Equations", d => { if (dr.length) d.vars = dr; else delete d.vars; });
      this.renderAll();
      void this.rebuild();
      return;
    }
    if (m.kind === "props") {
      const dr = m.draft;
      this.mode = { kind: "none" };
      this.store!.change("Properties", d => { d.name = dr.name; d.props = dr.props; d.material = dr.material; d.color = dr.color; if (!dr.material) delete d.material; if (!dr.color) delete d.color; if (dr.massOverride) d.massOverride = dr.massOverride; else delete d.massOverride; });
      this.renderAll();
      void this.rebuild();
      return;
    }
    if (m.kind !== "feature") return;
    const f = m.draft;
    if ((f.type === "fillet" || f.type === "chamfer") && !roundReady(f)) { toast(t(f.type === "fillet" && f.kind === "full" ? "Pick side face set 1, the centre face set and side face set 2." : f.type === "fillet" && f.kind === "face" ? "Pick the faces of face set 1 and face set 2." : "Pick at least one edge."), true); return; }
    if (f.type === "revolve" && !f.axis) { toast(t("Pick a line of the sketch as the axis."), true); return; }
    if (f.type === "revolve" && f.end === "upto" && !f.upTo) { toast(t("Pick the face or plane the revolve goes up to."), true); return; }
    if (f.type === "extrude" && (f.end === "upto" || f.end === "offset") && !f.upTo) { toast(t("Pick the face or plane the extrusion goes up to."), true); return; }
    if (f.type === "extrude" && f.end === "vertex" && !f.upToVertex) { toast(t("Pick the vertex the extrusion goes up to."), true); return; }
    if (f.type === "extrude" && ((f.start === "surface" && !f.startRef) || (f.start === "vertex" && !f.startVertex))) { toast(t("Pick where the extrusion starts."), true); return; }
    if (f.type === "plane" && f.mode === "angle" && !f.axis) { toast(t("Pick a straight edge to turn the plane about."), true); return; }
    if (f.type === "axis" && !(f.mode === "edge" ? f.edge : f.mode === "cylinder" ? f.face : (f.planes?.length ?? 0) >= 2)) { toast(t(f.mode === "planes" ? "Pick two planes or flat faces." : f.mode === "edge" ? "Pick a straight edge." : "Pick a cylindrical or conical face."), true); return; }
    if (f.type === "thread" && !f.edge) { toast(t("Pick a round edge of a cylinder."), true); return; }
    if (f.type === "hole" && (!f.plane || !f.pts.length)) { toast(t(f.plane ? "Click on the face to place the holes." : "Pick a flat face or a plane for the holes."), true); return; }
    if (f.type === "mirror" && !f.plane) { toast(t("Pick a plane or a flat face to mirror about."), true); return; }
    if ((f.type === "lpattern" || f.type === "cpattern") && !f.features.length) { toast(t("Pick the features to copy."), true); return; }
    if (f.type === "lpattern" && !f.dir) { toast(t("Pick a direction: an edge, a face or an axis."), true); return; }
    if (f.type === "cpattern" && !f.axis) { toast(t("Pick an axis: a round edge or face, a straight edge or a reference axis."), true); return; }
    if (f.type === "sweep" && !f.path) { toast(t("Pick a path: a sketch or a helix."), true); return; }
    if (f.type === "sweep" && !f.profile && !f.circular) { toast(t("Pick a profile sketch, or use a circular profile."), true); return; }
    if (f.type === "combine" && (!f.main || !f.tools.length)) { toast(t("Pick the main body and at least one other body."), true); return; }
    if (f.type === "bsplit" && !f.plane) { toast(t("Pick a plane or a flat face to split with."), true); return; }
    if ((f.type === "delbody" || f.type === "movebody") && !f.bodies.length) { toast(t("Pick the bodies."), true); return; }
    if ((f.type === "delface" || f.type === "moveface") && !f.faces.length) { toast(t("Pick the faces."), true); return; }
    if (f.type === "split" && !f.sketch) { toast(t("Pick the sketch to project."), true); return; }
    if ((f.type === "planesurf" || f.type === "extsurf") && !f.sketch) { toast(t("Pick a sketch."), true); return; }
    if (f.type === "offsurf" && !f.faces.length) { toast(t("Pick the faces."), true); return; }
    if (f.type === "knit" && f.surfaces.length < (f.solid ? 1 : 2)) { toast(t("Pick two or more surface bodies."), true); return; }
    if (f.type === "thicken" && !f.surface) { toast(t("Pick the surface to thicken."), true); return; }
    if (f.type === "replaceface" && (!f.faces.length || !f.surface)) { toast(t(f.faces.length ? "Pick the replacement surface." : "Click the faces to replace."), true); return; }
    if (f.type === "rib" && !f.sketch) { toast(t("Pick an open sketch: the line the rib is built on."), true); return; }
    if (f.type === "loft" && f.profiles.length < 2) { toast(t("Pick two or more profile sketches."), true); return; }
    if (f.type === "point" && !(f.mode === "face" ? f.face : f.edge)) { toast(t(f.mode === "face" ? "Pick a face." : "Pick an edge."), true); return; }
    this.mode = { kind: "none" };
    this.store!.change(m.isNew ? `Add ${f.name}` : `Edit ${f.name}`, d => {
      if (m.isNew) d.features.splice(m.index, 0, f); else d.features[m.index] = f;
      if (m.isNew && d.rollback != null) d.rollback++;
    });
    this.selected = f.id;
    this.clearDecor();
    this.renderAll();
    void this.rebuild();
  }

  /** ✕: closes without changes (a sketch asks before throwing its edits away). */
  async cancel() {
    const m = this.mode;
    if (m.kind === "sketch") {
      const changed = JSON.stringify(this.doc) !== m.entry;
      if (changed && !(await confirmModal(t("Discard the changes made to this sketch?"), t("Discard"), t("Exit sketch")))) return;
      this.exitMode(false);
      if (changed) {
        const entry = JSON.parse(m.entry) as PartDoc;
        this.store!.change("Discard sketch changes", d => { d.features = entry.features; d.rollback = entry.rollback; });
      } else void this.rebuild();
      return;
    }
    if (m.kind === "none") return;
    this.exitMode(false);
    void this.rebuild();
  }

  private exitMode(_keep: boolean) {
    const m = this.mode;
    if (m.kind === "sketch") {
      m.editor.dispose();
      $("#mc-status").textContent = "";
      document.getElementById("app")!.classList.remove("sketching");
    }
    this.mode = { kind: "none" };
    this.arrowDrag = null;
    this.clearDecor();
    if (this.store) { this.renderAll(); this.renderEmpty(); }
  }

  /** Features before this index are frozen (FR-HIS-024). */
  private frozenCount() { const d = this.doc; return d.freezeAfter ? d.features.findIndex(f => f.id === d.freezeAfter) + 1 : 0; }
  private isFrozen(id: string) { const i = this.doc.features.findIndex(f => f.id === id); return i >= 0 && i < this.frozenCount(); }
  private frozenToast() { toast(t("This feature is above the freeze bar. Move the bar above it to change it."), true); }

  /** Freezes the features up to and including `id` (null: unfreeze all). */
  setFreeze(id: string | null) {
    if (!this.store) return;
    if (this.mode.kind !== "none") this.exitMode(false);
    if (id && this.doc.rollback != null && this.doc.features.findIndex(f => f.id === id) >= this.doc.rollback) { toast(t("Roll forward past the feature before freezing it."), true); return; }
    this.store.change(id ? "Freeze" : "Unfreeze", d => { if (id) d.freezeAfter = id; else delete d.freezeAfter; });
  }

  /** Puts a feature into a folder (a new one when `folder` is null), out of any other. */
  addToFolder(id: string, folder: string | null) {
    if (!this.store) return;
    const f = this.store.feature(id);
    if (!f) return;
    this.store.change(folder ? "Add to folder" : "Add to new folder", d => {
      const fs = d.folders ?? (d.folders = []);
      for (const g of fs) g.ids = g.ids.filter(x => x !== id);
      if (folder) fs.find(g => g.id === folder)?.ids.push(id);
      else {
        let n = 1;
        while (fs.some(g => g.name === `Folder${n}`)) n++;
        fs.push({ id: uid("fd"), name: `Folder${n}`, ids: [id] });
      }
    });
  }
  removeFromFolder(id: string) { this.store?.change("Remove from folder", d => { for (const g of d.folders ?? []) g.ids = g.ids.filter(x => x !== id); }); }
  deleteFolder(fid: string) { this.store?.change("Delete folder", d => { d.folders = (d.folders ?? []).filter(g => g.id !== fid); }); }
  /** Fillet/chamfer picking adds the tangent chain of an edge (FR-SEL-005). */
  private tangentProp = true;
  /** Folders collapsed in the tree (view state, not saved). */
  private closedFolders = new Set<string>();

  /** Moves the rollback bar: features from `index` on are not evaluated (null: none). */
  setRollback(index: number | null) {
    if (!this.store) return;
    if (index != null && index < this.frozenCount()) { toast(t("The rollback bar can't go above the freeze bar."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    const n = this.doc.features.length;
    const rb = index == null || index >= n ? null : Math.max(0, index);
    if (rb === this.doc.rollback) return;
    this.store.change(rb == null ? "Roll to end" : "Roll back", d => { d.rollback = rb; });
  }

  rename(id: string, name: string) {
    if (id.startsWith("body:")) { const key = id.slice(5), v = name.trim(); if (v && v !== this.bodyName(key)) this.setBody(key, { name: v }); return; }
    if (id.startsWith("folder:")) {
      const g = this.doc.folders?.find(x => `folder:${x.id}` === id), v = name.trim();
      if (g && v && v !== g.name) this.store!.change(`Rename ${g.name}`, d => { d.folders!.find(x => x.id === g.id)!.name = v; });
      return;
    }
    const f = this.store?.feature(id);
    const v = name.trim();
    if (!f || !v || v === featureLabel(f.name)) return;
    this.store!.change(`Rename ${f.name}`, d => {
      d.features.find(x => x.id === id)!.name = v;
      // Dimensions are used as "D1@Sketch1": expressions follow the sketch's new name (FR-SK-065).
      if (f.type === "sketch") for (const dm of f.dims) renameEverywhere(d, `${dm.name}@${f.name}`, `${dm.name}@${v}`);
    });
  }

  /** Whether a sketch shows in the view: by its own choice, else until a feature uses it (SolidWorks absorbs it). */
  private sketchShown(f: SketchFeature) {
    return !(f.hidden ?? this.doc.features.some(g => absorbs(g, f.id)));
  }

  toggleHidden(id: string) {
    if (id.startsWith("std:")) {
      const k = id.slice(4) as "XY" | "XZ" | "YZ";
      const was = (this.doc.stdHidden ?? []).includes(k);
      this.store!.change(was ? `Show ${k}` : `Hide ${k}`, d => {
        const list = (d.stdHidden ?? []).filter(x => x !== k);
        if (!was) list.push(k);
        if (list.length) d.stdHidden = list; else delete d.stdHidden;
      });
      return;
    }
    const f = this.store?.feature(id);
    if (f?.type === "sketch") {
      const show = !this.sketchShown(f);
      this.store!.change(show ? `Show ${f.name}` : `Hide ${f.name}`, d => { (d.features.find(x => x.id === id) as SketchFeature).hidden = !show; });
      return;
    }
    if (f?.type !== "plane" && f?.type !== "axis" && f?.type !== "point" && f?.type !== "csys" && f?.type !== "helix") return;
    this.store!.change(f.hidden ? `Show ${f.name}` : `Hide ${f.name}`, d => {
      const g = d.features.find(x => x.id === id) as PlaneFeature | AxisFeature | PointFeature | CsysFeature | HelixFeature;
      if (g.hidden) delete g.hidden; else g.hidden = true;
    });
  }

  /** Part properties and material (FR-DOC-007, FR-MAT-001/003). */
  /** Equations (FR-PAR-001/005): global variables and every expression in the part, in the panel. */
  editEquations() {
    if (!this.store) return;
    this.exitMode(false);
    this.mode = { kind: "eq", draft: structuredClone(this.doc.vars ?? []) };
    this.renderAll();
  }

  /** DXF into the open sketch (FR-SK-040, AT-P2-5): lines, circles, arcs and polylines, in the file's units. */
  importDxf(file?: File) {
    const m = this.mode;
    if (m.kind !== "sketch") return;
    const run = async (f: File) => {
      if (f.size > 20 * 1024 * 1024) { toast(t("The DXF file is too large (over 20 MB)."), true); return; }
      const { readDxf } = await import("../sketch/dxf");
      const r = readDxf(await f.text());
      const n = r.shapes.length ? m.editor.importShapes(r.shapes) : 0;
      if (!n) { toast(t("No lines, arcs or circles were found in the DXF file."), true); return; }
      toast(r.skipped ? t("Imported {n} entities; {k} other entities were skipped.", { n, k: r.skipped }) : t("Imported {n} entities.", { n }), r.skipped ? "warn" : "success");
      this.renderPanel();
      this.renderBar();
    };
    if (file) { void run(file); return; }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".dxf";
    inp.addEventListener("change", () => { const f = inp.files?.[0]; if (f) void run(f); });
    inp.click();
  }

  /**
   * Insert body (FR-FT-130, FR-BODY-005): a STEP, IGES or BREP file read by the kernel into BREP text,
   * kept in the document as an Imported feature at the rollback bar, then opened for Check and heal.
   */
  importBodyFile(file?: File) {
    if (!this.store) return;
    const run = async (f: File) => {
      if (f.size > 100 * 1024 * 1024) { toast(t("The file is too large to import (over 100 MB)."), true); return; }
      if (this.mode.kind !== "none") this.exitMode(false);
      this.setBusy(1);
      let r: { brep: string; solids: number; faces: number };
      try {
        // Insert part (FR-BODY-005): a MöbiusCAD part's result, evaluated on its own.
        r = f.name.toLowerCase().endsWith(PART_EXT) ? await this.kernel.partBody(await unpackPart(await f.arrayBuffer())) : await this.kernel.importBody(await f.arrayBuffer(), f.name);
      }
      catch (err) { toast(t("The file could not be read: {msg}", { msg: (err as Error).message }), true); return; }
      finally { this.setBusy(-1); }
      if (!r.faces) { toast(t("No faces or solids were found in the file."), true); return; }
      const id = uid("f_");
      const name = nextName(this.doc, "import");
      // Faces without solids (a surface model or a broken file): heal it from the start.
      const feat: ImportFeature = { id, type: "import", name, file: f.name, brep: r.brep, tol: { v: 0.1 }, ...(r.solids ? {} : { heal: true }) };
      this.store!.change(`Add ${name}`, d => { const at = d.rollback ?? d.features.length; d.features.splice(at, 0, feat); if (d.rollback != null) d.rollback++; });
      this.editFeature(id);
    };
    if (file) { void run(file); return; }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = `.step,.stp,.iges,.igs,.brep,${PART_EXT}`;
    inp.addEventListener("change", () => { const f = inp.files?.[0]; if (f) void run(f); });
    inp.click();
  }

  /** Configurations (FR-CFG-001/002): list, switch, add, rename, delete. */
  editConfigs() {
    if (!this.store) return;
    this.exitMode(false);
    this.mode = { kind: "cfg" };
    this.renderAll();
  }

  /** Makes a configuration active; the part rebuilds with its values. */
  setConfig(name: string) {
    if (!this.store || (this.doc.config ?? "Default") === name) return;
    this.store.change(`Configuration ${name}`, d => activate(d, name));
    this.renderAll();
    void this.rebuild();
  }

  /**
   * Moves a feature (and the sketch only it uses) to before position `to` of the other features
   * (FR-HIS-006). Refused, with the reason, when a feature would come before something it uses.
   */
  moveFeature(id: string, to: number) {
    if (!this.store) return false;
    const d = this.doc;
    const f = d.features.find(x => x.id === id);
    if (!f) return false;
    const ids = [id];
    if (f.type === "extrude" || f.type === "revolve") {
      const own = d.features.filter(x => (x.type === "extrude" || x.type === "revolve") && x.sketch === f.sketch).length === 1;
      if (own) ids.unshift(f.sketch);
    }
    const next = moved(d.features, ids, to);
    if (next.every((x, i) => x.id === d.features[i].id)) return false;
    const fz = this.frozenCount();
    if (fz && next.some((x, i) => (i < fz) !== (d.features.findIndex(y => y.id === x.id) < fz))) { this.frozenToast(); return false; }
    const bad = orderProblem(next);
    if (bad) { toast(t("{a} can't come before {b}: it uses {b}.", { a: featureLabel(bad.feature.name), b: featureLabel(bad.parent.name) }), true); return false; }
    this.store.change(`Move ${f.name}`, dd => { dd.features = moved(dd.features, ids, to); });
    this.selected = id;
    this.renderAll();
    void this.rebuild();
    return true;
  }

  /** Position among the other features for a move of `id` to just before (or after) feature `target`. */
  private dropIndex(id: string, target: string, after: boolean) {
    const d = this.doc;
    const f = d.features.find(x => x.id === id)!;
    const block = new Set([id]);
    if ((f.type === "extrude" || f.type === "revolve") && d.features.filter(x => (x.type === "extrude" || x.type === "revolve") && x.sketch === f.sketch).length === 1) block.add(f.sketch);
    const rest = d.features.filter(x => !block.has(x.id));
    const i = rest.findIndex(x => x.id === target);
    return i < 0 ? -1 : i + (after ? 1 : 0);
  }

  editProps() {
    if (!this.store) return;
    this.exitMode(false);
    this.mode = { kind: "props", draft: structuredClone(this.doc) };
    this.renderAll();
  }

  toggleSuppress(id: string) {
    const f = this.store?.feature(id);
    if (!f) return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    this.store!.change(f.suppressed ? `Unsuppress ${f.name}` : `Suppress ${f.name}`, d => {
      const g = d.features.find(x => x.id === id)!;
      if (g.suppressed) delete g.suppressed; else g.suppressed = true;
    });
  }

  async deleteFeature(id: string) {
    const f = this.store?.feature(id);
    if (!f) return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    const deps = dependants(this.doc, id);
    if (deps.length && !(await confirmModal(
      t("{name} is used by {list}. Delete them too?", { name: featureLabel(f.name), list: deps.map(x => featureLabel(x.name)).join(", ") }),
      t("Delete"), t("Delete feature")))) return;
    const gone = new Set([id, ...deps.map(x => x.id)]);
    if (this.selected && gone.has(this.selected)) this.selected = null;
    this.store!.change(`Delete ${f.name}`, d => { d.features = d.features.filter(x => !gone.has(x.id)); d.rollback = null; });
  }

  undo() { if (this.mode.kind === "feature" || this.mode.kind === "plane") this.exitMode(false); this.store?.undo(); }
  redo() { if (this.mode.kind === "feature" || this.mode.kind === "plane") this.exitMode(false); this.store?.redo(); }

  // ---------- files ----------

  async save(as = false) {
    if (!this.store) return;
    if (this.mode.kind === "sketch") this.ok();
    const bytes = await packPart(this.doc, `MöbiusCAD ${this.host.appVersion}`);
    if (this.vault && !as) {
      // A vaulted part saves into the vault's working copy, and only while checked out here (FR-PDM-081).
      if (this.vault.readOnly) { toast(t("This file is read-only: check it out to save, or use Save as."), true); return; }
      try { await this.vault.save(bytes); }
      catch (err) { toast(t("Could not save: {err}", { err: t((err as Error).message) }), true); return; }
      this.store.markSaved();
      journalDrop(this.doc.id);
      toast(t("Saved {name}", { name: this.fileName }), "success");
      return;
    }
    if (as && this.vault) this.setVault(null);
    const blob = new Blob([bytes], { type: "application/zip" });
    const suggested = this.fileName || `${this.doc.name}${PART_EXT}`;
    const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
    try {
      if (w.showSaveFilePicker) {
        if (!this.handle || as) {
          this.handle = await w.showSaveFilePicker({ suggestedName: suggested, types: [{ description: "MöbiusCAD part", accept: { "application/zip": [PART_EXT] } }] });
        }
        const out = await (this.handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await out.write(blob);
        await out.close();
        this.fileName = this.handle.name;
      } else {
        downloadBlob(blob, suggested);
        this.fileName = suggested;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      toast(t("Could not save: {err}", { err: (err as Error).message }), true);
      return;
    }
    this.store.markSaved();
    journalDrop(this.doc.id);
    // Automatic snapshot of every save outside a vault (FR-STO-005).
    void snapshotSave(this.doc.id, bytes);
    toast(t("Saved {name}", { name: this.fileName }), "success");
  }

  /** Snapshots of the open part (FR-STO-005): restore one, or open it as a copy. */
  async showSnapshots() {
    if (!this.store) return;
    if (this.vault) { toast(t("This part is in a vault: its versions are in the Vault tab's History.")); return; }
    const id = this.doc.id;
    const list = await snapshotList(id);
    let d = document.getElementById("mc-snaps") as HTMLDialogElement | null;
    if (!d) {
      d = document.createElement("dialog");
      d.id = "mc-snaps";
      d.className = "modal v-dlg";
      d.setAttribute("aria-labelledby", "mc-snaps-title");
      document.body.appendChild(d);
      trapFocus(d, () => d!.open);
    }
    const dlg = d;
    const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
    dlg.innerHTML = `<h3 id="mc-snaps-title">${esc(t("Snapshots"))}</h3>`
      + `<p class="muted">${esc(t("Every save keeps a snapshot of the part in this browser (the last {n}).", { n: SNAPSHOT_KEEP }))}</p>`
      + (list.length ? `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Saved"))}</th><th>${esc(t("Size"))}</th><th></th></tr></thead><tbody>${list.map((x, i) => `<tr><td>${esc(x.at.toLocaleString())}</td><td>${kb(x.size)}</td><td class="v-acts"><button class="btn small" data-snap-restore="${i}">${esc(t("Restore"))}</button><button class="btn small" data-snap-copy="${i}">${esc(t("Open as copy"))}</button></td></tr>`).join("")}</tbody></table></div>`
        : `<p>${esc(t("No snapshots yet: they are kept each time you save the part."))}</p>`)
      + `<div class="row end"><button class="btn" data-a="close">${esc(t("Close"))}</button></div>`;
    const read = async (i: number) => {
      const buf = await snapshotRead(id, list[i].name);
      if (!buf) { toast(t("The snapshot could not be read."), true); return null; }
      try { return await unpackPart(buf); } catch (err) { toast(t("Could not open {name}: {err}", { name: t("Snapshot"), err: t((err as Error).message) }), true); return null; }
    };
    dlg.querySelector("[data-a=close]")!.addEventListener("click", () => dlg.close());
    dlg.querySelectorAll<HTMLElement>("[data-snap-restore]").forEach(b => b.addEventListener("click", async () => {
      const snap = await read(+b.dataset.snapRestore!);
      if (!snap || !this.store) return;
      dlg.close();
      this.exitMode(false);
      // One undoable step: the whole document goes back to the snapshot.
      this.store.change("Restore snapshot", doc => {
        const keep = doc.id;
        for (const k of Object.keys(doc)) delete (doc as unknown as Record<string, unknown>)[k];
        Object.assign(doc, snap, { id: keep });
      });
      toast(t("Restored the snapshot of {time}", { time: list[+b.dataset.snapRestore!].at.toLocaleString() }), "success");
    }));
    dlg.querySelectorAll<HTMLElement>("[data-snap-copy]").forEach(b => b.addEventListener("click", async () => {
      const snap = await read(+b.dataset.snapCopy!);
      if (!snap) return;
      dlg.close();
      snap.id = uid("d_");
      this.load(snap, `${snap.name} (copy)${PART_EXT}`, null);
    }));
    dlg.showModal();
    dlg.querySelector<HTMLElement>("button")?.focus();
  }

  async exportStep() {
    if (!this.store) return;
    if (!this.last?.data) { toast(t("There is no body to export yet."), true); return; }
    try {
      const bytes = await this.kernel.step(this.doc.name, this.doc.color ?? DEFAULT_COLOR);
      downloadBlob(new Blob([bytes as BlobPart], { type: "model/step" }), `${this.doc.name}.step`);
      toast(t("Saved as STEP"), "success");
    } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
  }

  /** Unsaved parts from an earlier session (FR-STO-003): offered on the start screen. */
  private renderRecovery() {
    const box = $("#mc-recover");
    if (!box) return;
    const list = journalList().slice(0, 3);
    box.hidden = !list.length;
    box.innerHTML = list.length ? `<p class="muted">${esc(t("Unsaved parts from an earlier session:"))}</p>` + list.map((j, i) =>
      `<div class="mc-rec"><button class="btn small" data-rec="${i}">${esc(t("Recover {name}", { name: j.fileName || j.doc.name }))}</button><span class="muted">${esc(new Date(j.at).toLocaleString())}</span><button class="icon" data-drop="${i}" title="${esc(t("Discard"))}" aria-label="${esc(t("Discard"))}">✕</button></div>`).join("") : "";
    box.querySelectorAll<HTMLElement>("[data-rec]").forEach(b => b.addEventListener("click", () => this.recover(list[+b.dataset.rec!])));
    box.querySelectorAll<HTMLElement>("[data-drop]").forEach(b => b.addEventListener("click", () => { journalDrop(list[+b.dataset.drop!].doc.id); this.renderRecovery(); }));
  }

  private recover(j: JournalEntry) {
    this.load(j.doc, j.fileName, null);
    // Recovered work is unsaved until saved again.
    this.store!.change("Recover", d => { d.props = { ...d.props }; });
    this.warm();
    toast(t("Recovered {name}. Save it to keep it.", { name: j.fileName || j.doc.name }));
  }

  // ---------- pointer and keys ----------

  /** Capture-phase handlers on the viewport: sketching takes left clicks; pick modes take clicks. */
  private bindDom() {
    const vp = this.host.vp;
    const canvas = this.host.viewer.renderer.domElement;
    const onCanvas = (e: Event) => e.target === canvas;
    vp.addEventListener("pointerdown", e => {
      if (!onCanvas(e)) return;
      this.down = { x: e.clientX, y: e.clientY };
      const m = this.mode;
      // The edge under a right-click, taken before the view controls react to the button.
      this.rightHit = e.button === 2 && m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer") ? this.host.edgeAt(e.clientX, e.clientY) : null;
      if (m.kind === "sketch" && m.editor.pointerDown(e)) { e.stopPropagation(); e.preventDefault(); return; }
      if (e.button === 0 && this.arrowHit(e)) {
        // Dragging the depth arrow: the orbit controls never see this button.
        e.stopPropagation();
        e.preventDefault();
        this.startArrowDrag(e);
      }
    }, true);
    vp.addEventListener("pointermove", e => { this.pointer = { x: e.clientX, y: e.clientY }; }, true);
    vp.addEventListener("pointermove", e => {
      if (this.arrowDrag) { e.stopPropagation(); this.moveArrow(e); return; }
      if (!onCanvas(e)) return;
      const m = this.mode;
      if (m.kind === "sketch" && m.editor.pointerMove(e)) e.stopPropagation();
      else if (this.arrow && !e.buttons) canvas.style.cursor = this.arrowHit(e) ? "grab" : "";
    }, true);
    vp.addEventListener("pointerup", e => {
      if (this.arrowDrag) { e.stopPropagation(); this.endArrowDrag(); return; }
      if (!onCanvas(e)) return;
      const m = this.mode;
      if (m.kind === "sketch") { if (m.editor.pointerUp(e)) e.stopPropagation(); return; }
      const d = this.down;
      this.down = null;
      // Not stopped either: the view controls must see the right button go up.
      if (e.button === 2 && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4) { this.edgeMenu(e); return; }
      if (e.button !== 0 || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      // Not stopped: the orbit controls must see the button go up. Smart measure skips these clicks (`picking`).
      if (m.kind === "none") { const at = { x: e.clientX, y: e.clientY }, alt = e.altKey; setTimeout(() => this.showContextBar(at, alt), 0); }
      else if (m.kind === "plane") this.pickPlane(e);
      else if (m.kind === "feature" && m.draft.type === "fillet" && m.draft.kind) this.pickFaceSet(e, m.draft);
      else if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) this.pickEdge(e);
      else if (m.kind === "feature" && m.draft.type === "plane") {
        if (m.focus === "axis") this.pickAxis(e);
        else { const r = this.pickRef(e); if (r) { m.draft.base = r; if (m.draft.mode === "angle" && !m.draft.axis) m.focus = "axis"; this.draftChanged(); } }
      } else if (m.kind === "feature" && m.draft.type === "extrude" && this.extrudeTarget(m.draft, m.focus)) {
        const f = m.draft, tg = this.extrudeTarget(f, m.focus)!;
        if (tg === "start-vertex" || tg === "vertex") {
          const v = this.pickVertex(e);
          if (!v) return;
          if (tg === "vertex") f.upToVertex = v; else { f.startVertex = v; m.focus = "upto"; }
        } else {
          const r = this.pickRef(e);
          if (!r) return;
          if (tg === "upto") f.upTo = r; else { f.startRef = r; m.focus = "upto"; }
        }
        this.draftChanged();
      } else if (m.kind === "feature" && m.draft.type === "revolve" && m.draft.end === "upto") {
        const r = this.pickRef(e);
        if (r) { m.draft.upTo = r; this.draftChanged(); }
      } else if (m.kind === "feature" && (m.draft.type === "axis" || m.draft.type === "point")) this.pickRefGeometry(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "csys") this.pickCsys(e, m.draft);
      else if (m.kind === "feature" && isBodyOp(m.draft)) this.pickBody(e);
      else if (m.kind === "feature" && (m.draft.type === "shell" || m.draft.type === "draft" || m.draft.type === "split" || m.draft.type === "delface" || m.draft.type === "moveface" || m.draft.type === "offsurf" || isCopy(m.draft))) this.pickCopy(e);
      else if (m.kind === "feature" && (m.draft.type === "knit" || m.draft.type === "thicken" || m.draft.type === "replaceface")) this.pickSurface(e);
      else if (m.kind === "feature" && m.draft.type === "hole") this.pickHole(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "thread") {
        const hit = this.host.edgeAt(e.clientX, e.clientY);
        if (hit?.edge && this.setThreadEdge(m.draft, hit.edge)) this.draftChanged();
        else toast(t("Pick a round edge of a cylinder."));
      }
    }, true);
    vp.addEventListener("contextmenu", e => {
      // The edge helpers open on the button going up without a drag (a right-drag pans).
      const m = this.mode;
      if (onCanvas(e) && m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) e.preventDefault();
    }, true);
    vp.addEventListener("dblclick", e => {
      const m = this.mode;
      if (onCanvas(e) && m.kind === "sketch" && m.editor.doubleClick()) e.stopPropagation();
    }, true);
    window.addEventListener("keydown", e => this.key(e), true);
    window.addEventListener("beforeunload", e => { if (this.store?.dirty) { journalSave(this.doc, this.fileName); e.preventDefault(); } });

    $("#new-part").addEventListener("click", () => this.newPart());
    $("#empty-new").addEventListener("click", () => this.newPart());
    $("#mc-ok").addEventListener("click", () => this.ok());
    document.querySelectorAll<HTMLElement>("#mc-empty [data-plane]").forEach(b => b.addEventListener("click", () => void this.createSketch({ std: b.dataset.plane as "XY" })));
    // The menu closes on a click elsewhere, Esc, scrolling or resizing.
    document.addEventListener("pointerdown", e => { if (!(e.target as HTMLElement).closest?.("#mc-menu")) this.closeMenu(); }, true);
    window.addEventListener("resize", () => this.closeMenu());
    $("#mc-cancel").addEventListener("click", () => void this.cancel());
  }

  private key(e: KeyboardEvent) {
    if (!this.store) return;
    const tg = e.target as HTMLElement;
    if (tg.matches?.("input, select, textarea") || tg.closest?.("dialog")) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && k === "s") { stop(); void this.save(e.shiftKey); return; }
    if (mod && !e.shiftKey && k === "z") { stop(); this.undo(); return; }
    if (mod && (k === "y" || (e.shiftKey && k === "z"))) { stop(); this.redo(); return; }
    if (mod && k === "b") { stop(); this.forceRebuild(false); return; }
    if (mod && k === "q") { stop(); this.forceRebuild(true); return; }
    if (mod || e.altKey) return;
    if (e.key === "F5") { stop(); this.toggleFilterBar(); return; }
    if (k === "escape" && document.querySelector("#mc-sbar, #mc-cbar")) { stop(); this.hideShortcutBar(); return; }
    const m = this.mode;
    // S: the shortcut bar at the cursor (SolidWorks habit, FR-UI-023).
    if (k === "s" && !e.shiftKey && (m.kind === "sketch" || m.kind === "none")) { stop(); this.showShortcutBar(); return; }
    if (m.kind === "sketch") {
      if (k === "enter") { stop(); this.ok(); return; }
      if (m.editor.key(e)) { stop(); this.renderBar(); return; }
      if (k === "escape") { stop(); void this.cancel(); }
      return;
    }
    if (m.kind === "feature" || m.kind === "plane" || m.kind === "props" || m.kind === "eq" || m.kind === "cfg") {
      if (k === "escape") { stop(); void this.cancel(); }
      else if (k === "enter" && !tg.closest?.("#mc-tree")) { stop(); this.ok(); }
      return;
    }
    const inTree = !!tg.closest?.("#tab-features");
    const feat = this.selected ? this.store.feature(this.selected) : undefined;
    if ((k === "delete" || k === "backspace") && feat && inTree) { stop(); void this.deleteFeature(feat.id); }
    else if (k === "f2" && feat) { stop(); this.startRename(feat.id); }
  }

  private pickPlane(e: PointerEvent) {
    const r = this.pickRef(e);
    if (r) this.planePicked(r);
  }

  /** A plane picked while asking for one: a new sketch on it, or the new plane of the sketch being edited. */
  private planePicked(r: PlaneRef) {
    const m = this.mode;
    if (m.kind !== "plane") return;
    if (!m.edit) { void this.createSketch(r); return; }
    const i = this.doc.features.findIndex(f => f.id === m.edit!.id);
    if ("plane" in r && (r.plane === m.edit.id || this.doc.features.findIndex(f => f.id === r.plane) > i)) { toast(t("That plane comes after the sketch in the tree."), true); return; }
    m.edit.plane = r;
    this.renderPanel();
    void this.rebuild();
  }

  /** Edit sketch plane (FR-SK-007): pick another plane or flat face; the sketch keeps its geometry in its own coordinates. */
  editSketchPlane(id: string) {
    const sk = this.store?.feature(id);
    if (!sk || sk.type !== "sketch") return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    this.exitMode(false);
    this.mode = { kind: "plane", edit: { id, plane: structuredClone(sk.plane) } };
    this.selected = id;
    this.renderAll();
    void this.rebuild();
  }

  /** A plane under the pointer: a standard or reference plane drawn in the view, or a flat model face, whichever is nearer. */
  private pickRef(e: PointerEvent): PlaneRef | null {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const ph = rc.intersectObjects(this.planeMeshes, false)[0];
    const f = this.host.faceAt(e.clientX, e.clientY);
    const fd = f ? new THREE.Vector3(...f.point).distanceTo(rc.ray.origin) : Infinity;
    // A face beats the standard planes (drawn over the whole model); reference planes count when nearer.
    if (f && (!ph || "std" in (ph.object.userData.ref as PlaneRef) || fd <= ph.distance + 1e-6)) return this.planeOfFace(f.faceId);
    return ph ? (ph.object.userData.ref as PlaneRef) : null;
  }

  /** Angle plane: the straight edge it turns about. */
  private pickAxis(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || m.draft.type !== "plane") return;
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    if (!hit?.edge) { toast(t("Pick a straight edge to turn the plane about.")); return; }
    if (hit.edge.type !== "line") { toast(t("The plane turns about a straight edge."), true); return; }
    const ref = this.refOfEdge(hit.edge);
    if (!ref) return;
    m.draft.axis = ref;
    m.focus = "base";
    this.draftChanged();
  }

  /** The open feature's draft changed: panel, decorations and preview. */
  private draftChanged() { this.renderPanel(); this.drawDecor(); void this.rebuild(); }

  /** A plane reference in words: "Top (XY)", "Plane1", "Face of Extrude1". */
  /** What a click in the view sets while an extrude is edited (FR-FT-012/013). */
  private extrudeTarget(f: ExtrudeFeature, focus: Focus | undefined): "start-surface" | "start-vertex" | "upto" | "vertex" | null {
    if (f.start === "surface" && (focus === "start" || !f.startRef)) return "start-surface";
    if (f.start === "vertex" && (focus === "start" || !f.startVertex)) return "start-vertex";
    if (f.end === "upto" || f.end === "offset") return "upto";
    if (f.end === "vertex") return "vertex";
    return null;
  }

  /** A vertex under the pointer: the end of the edge under it nearer the click on screen. */
  private pickVertex(e: PointerEvent): VertexRef | null {
    const ed = this.host.edgeAt(e.clientX, e.clientY)?.edge;
    if (!ed) { toast(t("Pick a vertex: click near the end of an edge.")); return null; }
    const ref = this.refOfEdge(ed);
    if (!ref) return null;
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const scr = (p: V3) => { const q = new THREE.Vector3(...p).project(v.camera); return Math.hypot(r.left + ((q.x + 1) / 2) * r.width - e.clientX, r.top + ((1 - q.y) / 2) * r.height - e.clientY); };
    return { edge: ref, at: scr(ed.start) <= scr(ed.end) ? ed.start : ed.end };
  }

  private vertexLabel(r: VertexRef | undefined): string {
    if (!r) return t("None");
    if ("point" in r) { const f = this.store?.feature(r.point); return f ? featureLabel(f.name) : t("Missing"); }
    return t("Vertex ({x}, {y}, {z})", { x: trimNum(r.at[0], 3), y: trimNum(r.at[1], 3), z: trimNum(r.at[2], 3) });
  }

  private refLabel(r: PlaneRef | undefined): string {
    if (!r) return t("None");
    if ("std" in r) return t(STD_NAMES[r.std]);
    if ("plane" in r) { const f = this.store?.feature(r.plane); return f ? featureLabel(f.name) : t("Missing"); }
    const owner = this.store?.feature(r.face.name.split(":")[0]);
    return owner ? t("Face of {name}", { name: featureLabel(owner.name) }) : t("Face");
  }

  /**
   * Face fillet and full round (FR-FT-032): a click toggles a face in the focused face set; the first
   * face of a set moves the focus on (set 1, then the centre for a full round, then set 2).
   */
  private pickFaceSet(e: PointerEvent, f: FilletFeature) {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Pick a face.")); return; }
    const focus = m.focus === "fs2" || m.focus === "fc" ? m.focus : "fs1";
    const list = focus === "fs2" ? (f.faces2 ??= []) : focus === "fc" ? (f.center ??= []) : (f.faces1 ??= []);
    const i = list.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
    if (i >= 0) list.splice(i, 1);
    else {
      // A face sits in one set only.
      for (const other of [f.faces1, f.faces2, f.center]) if (other && other !== list) { const j = other.findIndex(x => x.name === fr.name); if (j >= 0) other.splice(j, 1); }
      list.push(fr);
      if (list.length === 1) m.focus = focus === "fs1" ? (f.kind === "full" && !f.center?.length ? "fc" : f.faces2?.length ? focus : "fs2") : focus === "fc" && !f.faces2?.length ? "fs2" : focus;
    }
    this.draftChanged();
  }

  private pickEdge(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "fillet" && m.draft.type !== "chamfer")) return;
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    const data = this.host.viewer.parts[0]?.data;
    if (!hit || !data) return;
    let edges = hit.edge ? [hit.edge] : data.edges.filter(x => x.faces.includes(hit.faceId!));
    // Tangent propagation (FR-SEL-005, on by default as in SolidWorks): an edge brings its smooth chain.
    if (hit.edge && this.tangentProp) edges = tangentChain(data.edges, hit.edge);
    this.toggleEdges(edges);
  }

  /**
   * Right-click on an edge while picking fillet or chamfer edges: the selection helpers (FR-SEL-005),
   * Select loop (the face boundary through it), Select tangency, and the edges of the same size.
   */
  private rightHit: { edge?: EdgeInfo; faceId?: number } | null = null;
  private edgeMenu(e: MouseEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "fillet" && m.draft.type !== "chamfer")) return false;
    const hit = this.rightHit?.edge ? this.rightHit : this.host.edgeAt(e.clientX, e.clientY);
    this.rightHit = null;
    const data = this.host.viewer.parts[0]?.data;
    if (!hit?.edge || !data) return false;
    const ed = hit.edge;
    const face = hit.faceId != null && ed.faces.includes(hit.faceId) ? hit.faceId : ed.faces[0];
    const round = (ed.type === "circle" || ed.type === "arc") && !!ed.radius && !ed.ellipse;
    const back = () => this.host.viewer.renderer.domElement.focus();
    this.showMenu([
      [t("Select loop"), () => this.addEdges(edgeLoop(data.edges, ed, face))],
      [t("Select tangency"), () => this.addEdges(tangentChain(data.edges, ed))],
      [round ? t("Select round edges of the same radius") : t("Select straight edges of the same length"), () => this.addEdges(sameEdges(data.edges, ed))],
    ], e.clientX, e.clientY, back);
    return true;
  }

  /** Adds edges to the fillet/chamfer list (the helpers only add). */
  private addEdges(edges: EdgeInfo[]) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "fillet" && m.draft.type !== "chamfer")) return;
    const refs = this.edgeRefs(edges);
    if (!refs.length) { toast(t("That edge cannot be rounded (it is not between two faces).")); return; }
    const list = m.draft.edges;
    const same = (x: EdgeRef, y: EdgeRef) => this.edgeOf(x) === this.edgeOf(y) && this.edgeOf(x) != null;
    for (const r of refs) if (!list.some(x => same(x, r))) list.push(r);
    this.draftChanged();
  }

  private edgeRefs(edges: EdgeInfo[]): EdgeRef[] {
    const names = this.last?.faceNames ?? [];
    const refs: EdgeRef[] = [];
    for (const ed of edges) {
      const [a, b] = ed.faces;
      if (a === b || !names[a] || !names[b]) continue;
      refs.push({ faces: [names[a], names[b]], hint: ed.mid });
    }
    return refs;
  }

  /** One edge toggles; several add (or all go when they are all in already). */
  private toggleEdges(edges: EdgeInfo[]) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "fillet" && m.draft.type !== "chamfer")) return;
    const refs = this.edgeRefs(edges);
    if (!refs.length) { toast(t("That edge cannot be rounded (it is not between two faces).")); return; }
    const list = m.draft.edges;
    const same = (x: EdgeRef, y: EdgeRef) => this.edgeOf(x) === this.edgeOf(y) && this.edgeOf(x) != null;
    // One edge toggles; a face adds its edges (or removes them when all are in).
    if (refs.length === 1 && list.some(x => same(x, refs[0]))) m.draft.edges = list.filter(x => !same(x, refs[0]));
    else if (refs.every(r => list.some(x => same(x, r)))) m.draft.edges = list.filter(x => !refs.some(r => same(x, r)));
    else for (const r of refs) if (!list.some(x => same(x, r))) list.push(r);
    this.drawDecor();
    this.renderPanel();
    void this.rebuild();
  }

  /**
   * Shell, mirror and patterns: a click fills the focused box. Faces toggle in Shell's list; for the
   * features to copy, a face picks the feature that made it; a direction or axis takes an edge or a face.
   */
  private pickCopy(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const f = m.draft;
    const own = (n: string | undefined) => !!n && n.startsWith(`${f.id}:`);
    if (f.type === "draft" && (m.focus === "nplane" || !f.plane)) {
      const r = this.pickRef(e);
      if (!r || ("face" in r && own(r.face.name))) return;
      f.plane = r;
      // The neutral face itself is not drafted.
      if ("face" in r) f.faces = f.faces.filter(x => x.name !== r.face.name);
      m.focus = "faces";
      this.draftChanged();
      return;
    }
    if (f.type === "moveface" && f.mode === "rotate" && m.focus === "axis") {
      const hit = this.host.edgeAt(e.clientX, e.clientY);
      const er = hit?.edge?.type === "line" ? this.refOfEdge(hit.edge) : null;
      if (!er || er.faces.some(own)) { toast(t("Pick a straight edge.")); return; }
      f.axis = { edge: er };
      m.focus = "faces";
      this.draftChanged();
      return;
    }
    if (f.type === "shell" || f.type === "draft" || f.type === "split" || f.type === "delface" || f.type === "moveface" || f.type === "offsurf") {
      const hit = this.host.faceAt(e.clientX, e.clientY);
      const fr = hit ? this.faceRef(hit.faceId) : null;
      if (!fr || own(fr.name)) { toast(t("Pick a face.")); return; }
      const i = f.faces.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
      if (i >= 0) f.faces.splice(i, 1); else f.faces.push(fr);
      this.draftChanged();
      return;
    }
    if (!isCopy(f)) return;
    if (m.focus === "mplane" && f.type === "mirror") {
      const r = this.pickRef(e);
      if (!r) return;
      if ("face" in r && own(r.face.name)) return;
      f.plane = r;
      if (!f.features.length) m.focus = "seeds";
      this.draftChanged();
      return;
    }
    if (m.focus === "dir" || m.focus === "dir2") {
      const hit = this.host.edgeAt(e.clientX, e.clientY);
      let ref: LineRef | null = null;
      if (hit?.edge && (hit.edge.type === "line" || hit.edge.type === "circle" || hit.edge.type === "arc")) { const er = this.refOfEdge(hit.edge); if (er && !er.faces.some(own)) ref = { edge: er }; }
      else if (hit?.faceId != null) {
        const face = this.host.viewer.parts[0]?.data.faces[hit.faceId];
        const fr = this.faceRef(hit.faceId);
        if (fr && !own(fr.name) && face && (face.type === "plane" || face.type === "cylinder")) ref = { face: fr };
      }
      if (!ref) { toast(t("Pick a straight or round edge, or a flat or round face.")); return; }
      if (f.type === "cpattern") f.axis = ref;
      else if (m.focus === "dir2" && f.type === "lpattern") f.dir2 = ref;
      else if (f.type === "lpattern") f.dir = ref;
      this.draftChanged();
      return;
    }
    // Features to copy: the feature that made the clicked face.
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const name = hit ? this.last?.faceNames[hit.faceId] : undefined;
    const owner = name?.split(":")[0];
    const sf = owner ? this.store?.feature(owner) : undefined;
    if (!sf || sf.id === f.id || !SEED_TYPES.has(sf.type)) { toast(t("Pick a face made by an extrude, a cut, a revolve, a mirror or a pattern.")); return; }
    this.toggleSeed(f, sf.id);
  }

  /** Whether a face of the view belongs to a surface body (they come after the solids' faces). */
  private isSheetFace(faceId: number): boolean {
    const r = this.last;
    return !!r && faceId >= r.faceNames.length - (r.sheetFaces ?? 0);
  }

  /** Knit and Thicken (FRS 9.11): a surface body is picked by clicking any face of it. */
  private pickSurface(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "knit" && m.draft.type !== "thicken" && m.draft.type !== "replaceface")) return;
    const f = m.draft;
    const hit = this.host.faceAt(e.clientX, e.clientY);
    if (f.type === "replaceface") {
      // Replace face: a surface face picks the replacement, a solid face toggles the faces to replace.
      const fr = hit ? this.faceRef(hit.faceId) : null;
      if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Pick a face.")); return; }
      if (this.isSheetFace(hit!.faceId)) f.surface = fr;
      else {
        const i = f.faces.findIndex(x => x.name === fr.name);
        if (i >= 0) f.faces.splice(i, 1); else f.faces.push(fr);
      }
      this.draftChanged();
      return;
    }
    const fr = hit ? this.faceRef(hit.faceId) : null;
    // The live result shows the thickened or knitted solid: its faces keep the surfaces' names.
    const known = (n: string) => (f.type === "thicken" ? f.surface?.name === n : f.surfaces.some(x => x.name === n));
    if (!fr || fr.name.startsWith(`${f.id}:`) || (!this.isSheetFace(hit!.faceId) && !known(fr.name))) { toast(t("Pick a surface body.")); return; }
    if (f.type === "thicken") f.surface = fr;
    else {
      const i = f.surfaces.findIndex(x => x.name === fr.name);
      if (i >= 0) f.surfaces.splice(i, 1); else f.surfaces.push(fr);
    }
    this.draftChanged();
  }

  /** New surface feature (FRS 9.11) with sensible picks: the selected or last unused sketch, the picked face. */
  private surfDraft(type: SurfTool, id: string, sketches: SketchFeature[], used: Set<string>, face: number | null): Feature | null {
    const d = this.doc;
    const nm = nextName(d, type);
    const sel = this.selected ? sketches.find(s => s.id === this.selected) : undefined;
    const curves = (s: SketchFeature) => s.ents.some(e => !e.cons && e.t !== "point");
    if (type === "planesurf" || type === "extsurf") {
      const ok = type === "planesurf" ? sketchProfileOk : curves;
      const sk = (sel && ok(sel) ? sel : undefined) ?? sketches.filter(s => !used.has(s.id) && !this.doc.features.some(g => absorbs(g, s.id)) && ok(s)).at(-1) ?? sketches.filter(ok).at(-1);
      if (!sk) { toast(t(type === "planesurf" ? "Draw a closed sketch first." : "Draw a sketch first."), true); return null; }
      return type === "planesurf" ? { id, type, name: nm, sketch: sk.id } satisfies PlaneSurfFeature
        : { id, type, name: nm, sketch: sk.id, depth: { v: 10 } } satisfies ExtrudeSurfFeature;
    }
    if (!this.last?.data) { toast(t("There is no body yet."), true); return null; }
    const fr = face != null ? this.faceRef(face) : null;
    if (type === "offsurf") return { id, type, name: nm, faces: fr ? [fr] : [], distance: { v: 5 } } satisfies OffsetSurfFeature;
    const onSheet = fr && face != null && this.isSheetFace(face) ? fr : null;
    if (!(this.last.sheetFaces ?? 0)) { toast(t("There are no surface bodies yet."), true); return null; }
    if (type === "knit") return { id, type, name: nm, surfaces: onSheet ? [onSheet] : [], tol: { v: 0.01 } } satisfies KnitFeature;
    if (type === "replaceface") return { id, type, name: nm, faces: fr && !onSheet ? [fr] : [], surface: onSheet ?? undefined } satisfies ReplaceFaceFeature;
    return { id, type, name: nm, surface: onSheet ?? undefined, thickness: { v: 2 }, side: "one" } satisfies ThickenFeature;
  }

  /** PropertyManager groups for the surface features (FRS 9.11). */
  private surfPanel(f: PlaneSurfFeature | ExtrudeSurfFeature | OffsetSurfFeature | KnitFeature | ThickenFeature | ReplaceFaceFeature, sketches: SketchFeature[], group: (legend: string, inner: string) => string,
    numField: (key: string, label: string, n: Num, q: "length" | "angle") => string, chk: (k: string, on: boolean | undefined, label: string) => string): { title: string; body: string } {
    const opt = (v: string, l: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;
    const sel = (k: string, label: string, inner: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${k}">${inner}</select></label>`;
    const skOpts = (list: SketchFeature[], cur: string) => list.map(s => `<option value="${esc(s.id)}"${s.id === cur ? " selected" : ""} translate="no">${esc(featureLabel(s.name))}</option>`).join("");
    const help = (s: string) => `<p class="pm-help muted">${esc(s)}</p>`;
    if (f.type === "planesurf") {
      const list = sketches.filter(s => sketchProfileOk(s) || s.id === f.sketch);
      return { title: t("Planar Surface"), body: group(t("Bounding entities"), sel("sketch", t("Sketch"), skOpts(list, f.sketch))) + help(t("A closed sketch becomes a flat surface body: no volume, ready to knit or thicken.")) };
    }
    if (f.type === "extsurf") {
      const list = sketches.filter(s => s.ents.some(e => !e.cons && e.t !== "point") || s.id === f.sketch);
      return { title: t("Surface-Extrude"), body: group(t("Direction 1"), sel("sketch", t("Sketch"), skOpts(list, f.sketch)) + numField("depth", t("Depth"), f.depth, "length")
          + chk("mid", f.mid, t("Mid plane")) + chk("flip", f.flip, t("Reverse direction")))
        + help(t("Every curve of the sketch, open or closed, is swept along the sketch normal into a surface.")) };
    }
    if (f.type === "offsurf") {
      return { title: t("Offset Surface"), body: group(t("Offset parameters"), numField("distance", t("Distance"), f.distance, "length") + chk("flip", f.flip, t("Reverse direction")))
        + group(t("Faces to offset"), `<p class="pm-count">${esc(t("{n} face|{n} faces", { n: f.faces.length }))}</p>`
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
          + help(t("Click faces of solids or surfaces; a distance of 0 copies them."))) };
    }
    if (f.type === "knit") {
      return { title: t("Knit Surface"), body: group(t("Selections"), `<p class="pm-count">${esc(t("{n} surface|{n} surfaces", { n: f.surfaces.length }))}</p>`
          + (f.surfaces.length ? `<button class="btn small" data-k="clearSurfaces">${esc(t("Clear selections"))}</button>` : "")
          + chk("solid", f.solid, t("Create solid")))
        + group(t("Gap control"), numField("tol", t("Knit tolerance"), f.tol, "length"))
        + help(t("Click the surface bodies to sew together along their shared edges. With Create solid, surfaces that close a volume become a solid body.")) };
    }
    if (f.type === "replaceface") {
      return { title: t("Replace Face"), body: group(t("Replace face parameters"), `<div class="pm-field"><span>${esc(t("Target faces"))}</span><button class="pm-box" translate="no">${esc(t("{n} face|{n} faces", { n: f.faces.length }))}</button></div>`
          + `<div class="pm-field"><span>${esc(t("Replacement surface"))}</span><button class="pm-box" translate="no">${esc(f.surface ? t("Surface picked") : t("None"))}</button></div>`
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : ""))
        + help(t("Click flat faces of the solid to replace, then a surface body: the faces around them grow or shrink to meet it. The surface must cover the faces' whole outline.")) };
    }
    return { title: t("Thicken"), body: group(t("Thicken parameters"), `<div class="pm-field"><span>${esc(t("Surface"))}</span><button class="pm-box focus" translate="no">${esc(f.surface ? t("Surface picked") : t("None"))}</button></div>`
        + sel("side", t("Direction"), opt("one", t("Side 1"), f.side) + opt("other", t("Side 2"), f.side) + opt("both", t("Both sides"), f.side))
        + numField("thickness", t("Thickness"), f.thickness, "length")
        + (this.last?.props ? chk("merge", f.merge !== false, t("Merge result")) : ""))
      + help(t("Click a surface body: it grows into a solid of this thickness.")) };
  }

  /** Multibody features (FRS 9.10): a body is picked by clicking any face of it. */
  private pickBody(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || !isBodyOp(m.draft)) return;
    const f = m.draft;
    const own = (n: string) => n.startsWith(`${f.id}:`);
    if (f.type === "bsplit" && (m.focus === "mplane" || !f.plane)) {
      const r = this.pickRef(e);
      if (!r || ("face" in r && own(r.face.name))) return;
      f.plane = r;
      m.focus = "bodies";
      this.draftChanged();
      return;
    }
    if (f.type === "movebody" && m.focus === "axis") {
      const hit = this.host.edgeAt(e.clientX, e.clientY);
      let ref: LineRef | null = null;
      if (hit?.edge && (hit.edge.type === "line" || hit.edge.type === "circle" || hit.edge.type === "arc")) { const er = this.refOfEdge(hit.edge); if (er) ref = { edge: er }; }
      else if (hit?.faceId != null) {
        const face = this.host.viewer.parts[0]?.data.faces[hit.faceId];
        const fr = this.faceRef(hit.faceId);
        if (fr && face && (face.type === "plane" || face.type === "cylinder")) ref = { face: fr };
      }
      if (!ref) { toast(t("Pick a straight or round edge, or a flat or round face.")); return; }
      f.axis = ref;
      f.angle ??= { v: Math.PI / 2 };
      this.draftChanged();
      return;
    }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (!fr || own(fr.name)) { toast(t("Click a face of a body.")); return; }
    if (f.type === "combine" && (m.focus === "main" || !f.main)) { f.main = fr; m.focus = "bodies"; this.draftChanged(); return; }
    const list = f.type === "combine" ? f.tools : f.bodies;
    const near = (x: FaceRef) => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3);
    const i = list.findIndex(near);
    if (i >= 0) list.splice(i, 1); else list.push(fr);
    this.draftChanged();
  }

  /** Hole: the face first, then each click on it places a hole there (a click on a hole removes it). */
  private pickHole(e: PointerEvent, f: HoleFeature) {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const own = (n: string) => n.startsWith(`${f.id}:`);
    if (m.focus === "hplane" || !f.plane) {
      const r = this.pickRef(e);
      if (!r || ("face" in r && own(r.face.name))) return;
      f.plane = r;
      f.pts = [];
      m.focus = "pts";
      // The first click on a face also places the first hole there.
      const hit = this.host.faceAt(e.clientX, e.clientY);
      this.pendingHole = hit && "face" in r ? [{ p: hit.point, at: { clientX: e.clientX, clientY: e.clientY } }] : [];
      this.draftChanged();
      return;
    }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = this.last?.frames[f.id];
    if (!hit) return;
    // Clicks made before the plane's frame arrives are placed once it does.
    if (!fr || this.pendingHole.length) { this.pendingHole.push({ p: hit.point, at: { clientX: e.clientX, clientY: e.clientY } }); return; }
    this.placeHole(f, this.holeSnap(e, fr) ?? hit.point, fr);
  }

  /**
   * Where a hole click snaps (SolidWorks-style): the origin (projected onto the hole's face), or a
   * vertex, arc centre or midpoint of the model lying in that face, when within a few pixels.
   */
  private holeSnap(e: { clientX: number; clientY: number }, fr: Frame): V3 | null {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const onScreen = (w: V3) => { const s = new THREE.Vector3(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; };
    const dn = -(fr.o[0] * fr.n[0] + fr.o[1] * fr.n[1] + fr.o[2] * fr.n[2]);
    const origin: V3 = [-fr.n[0] * dn, -fr.n[1] * dn, -fr.n[2] * dn];
    const [ox, oy] = onScreen(origin);
    if (Math.hypot(ox - e.clientX, oy - e.clientY) <= 10) return origin;
    const s = this.host.snapAt?.(e.clientX, e.clientY);
    if (s && ["vertex", "circleCenter", "midpoint", "faceCenter", "quadrant", "intersection"].includes(s.kind)) {
      const off = (s.point[0] - fr.o[0]) * fr.n[0] + (s.point[1] - fr.o[1]) * fr.n[1] + (s.point[2] - fr.o[2]) * fr.n[2];
      if (Math.abs(off) < 1e-4 * Math.max(1, Math.hypot(...s.point))) return s.point;
    }
    return null;
  }

  /** A first hole waiting for the hole's plane frame (it comes with the next rebuild). */
  private pendingHole: { p: V3; at: { clientX: number; clientY: number } }[] = [];

  private placeHole(f: HoleFeature, w: V3, fr: Frame) {
    const d: V3 = [w[0] - fr.o[0], w[1] - fr.o[1], w[2] - fr.o[2]];
    const p: [number, number] = [d[0] * fr.x[0] + d[1] * fr.x[1] + d[2] * fr.x[2], d[0] * fr.y[0] + d[1] * fr.y[1] + d[2] * fr.y[2]];
    // Round to 0.01 mm so typed-in feel values stay tidy (snapped points are exact).
    const q = (x: number) => Math.abs(x) < 1e-9 ? 0 : Math.round(x * 100) / 100;
    const near = f.pts.findIndex(o => Math.hypot(o[0] - p[0], o[1] - p[1]) < Math.max(f.diameter.v * 0.75, 1));
    if (near >= 0) f.pts.splice(near, 1); else f.pts.push([q(p[0]), q(p[1])]);
    this.draftChanged();
  }

  private toggleSeed(f: CopyFeature, id: string) {
    const m = this.mode;
    const i = f.features.indexOf(id);
    if (i >= 0) f.features.splice(i, 1);
    else {
      // Only features before this one.
      const at = m.kind === "feature" ? m.index : this.doc.features.length;
      if (this.doc.features.findIndex(x => x.id === id) >= at) return;
      f.features.push(id);
    }
    this.draftChanged();
  }

  /** Coordinate system: the origin (a vertex), then the Z and X directions (an edge or a face). */
  private pickCsys(e: PointerEvent, f: CsysFeature) {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const focus = m.focus ?? "origin";
    if (focus === "origin") {
      const v = this.pickVertex(e);
      if (!v) return;
      f.origin = v;
      m.focus = f.z ? "cx" : "cz";
      this.draftChanged();
      return;
    }
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    let ref: LineRef | null = null;
    if (hit?.edge && (hit.edge.type === "line" || hit.edge.type === "circle" || hit.edge.type === "arc")) { const er = this.refOfEdge(hit.edge); if (er) ref = { edge: er }; }
    else if (hit?.faceId != null) {
      const face = this.host.viewer.parts[0]?.data.faces[hit.faceId];
      const fr = this.faceRef(hit.faceId);
      if (fr && face && (face.type === "plane" || face.type === "cylinder")) ref = { face: fr };
    }
    if (!ref) { toast(t("Pick a straight or round edge, or a flat or round face.")); return; }
    if (focus === "cz") { f.z = ref; if (!f.x) m.focus = "cx"; } else f.x = ref;
    this.draftChanged();
  }

  /** The active measurement frame follows its coordinate system feature through rebuilds (FR-REF-005). */
  private syncCsys() {
    const src = csys.active?.src;
    if (!src || !this.store) return;
    const f = this.store.feature(src);
    const fr = this.last?.frames[src];
    const end = this.doc.rollback ?? this.doc.features.length;
    if (f?.type !== "csys" || f.suppressed || !fr || this.doc.features.indexOf(f) >= end) { this.host.setCsys?.(null, true); return; }
    this.host.setCsys?.({ name: featureLabel(f.name), src, o: fr.o, x: fr.x, z: fr.n }, true);
  }

  /** Makes a coordinate system feature the measurement and export frame, or goes back to the global one. */
  useCsys(id: string | null) {
    if (!id) { this.host.setCsys?.(null); return; }
    const f = this.store?.feature(id);
    const fr = this.last?.frames[id];
    if (f?.type !== "csys" || !fr) { toast(t("This coordinate system has an error or is rolled back."), true); return; }
    this.host.setCsys?.({ name: featureLabel(f.name), src: id, o: fr.o, x: fr.x, z: fr.n });
  }

  /** A direction or axis reference in words. */
  private lineLabel(r: LineRef | undefined): string {
    if (!r) return t("None");
    if (r.axis) { const f = this.store?.feature(r.axis); return f ? featureLabel(f.name) : t("Missing"); }
    if (r.edge) return t("Edge picked");
    const owner = r.face ? this.store?.feature(r.face.name.split(":")[0]) : undefined;
    return owner ? t("Face of {name}", { name: featureLabel(owner.name) }) : t("Face");
  }

  /** A persistent reference to a shown face. */
  private faceRef(faceId: number): { name: string; hint?: V3 } | null {
    const name = this.last?.faceNames[faceId];
    const face = this.host.viewer.parts[0]?.data.faces[faceId];
    return name && face ? { name, hint: face.centroid } : null;
  }

  /** Axis and point: a click in the view fills the selection for the chosen type. */
  private pickRefGeometry(e: PointerEvent, f: AxisFeature | PointFeature) {
    if (f.type === "axis" && f.mode === "planes") {
      const r = this.pickRef(e);
      if (!r) return;
      // Two planes: a third pick replaces the older one.
      f.planes = [...(f.planes ?? []), r].slice(-2);
      this.draftChanged();
      return;
    }
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    const wantsFace = (f.type === "axis" && f.mode === "cylinder") || (f.type === "point" && f.mode === "face");
    if (wantsFace) {
      const fr = hit?.faceId != null ? this.faceRef(hit.faceId) : null;
      if (!fr) { toast(t("Pick a face.")); return; }
      f.face = fr;
    } else {
      const ed = hit?.edge;
      if (!ed) { toast(t("Pick an edge.")); return; }
      if (f.type === "axis" && ed.type !== "line") { toast(t("The axis needs a straight edge."), true); return; }
      if (f.type === "point" && f.mode === "centre" && ed.type !== "circle" && ed.type !== "arc") { toast(t("The centre needs a circle or an arc."), true); return; }
      const ref = this.refOfEdge(ed);
      if (!ref) return;
      f.edge = ref;
      if (f.type === "point" && f.mode === "vertex") {
        // The end nearer the click on screen.
        const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
        const scr = (p: V3) => { const q = new THREE.Vector3(...p).project(v.camera); return Math.hypot(r.left + ((q.x + 1) / 2) * r.width - e.clientX, r.top + ((1 - q.y) / 2) * r.height - e.clientY); };
        f.at = scr(ed.start) <= scr(ed.end) ? ed.start : ed.end;
      }
    }
    this.draftChanged();
  }

  /** A persistent reference to a shown edge (between two named faces). */
  private refOfEdge(ed: EdgeInfo): EdgeRef | null {
    const names = this.last?.faceNames ?? [];
    const [a, b] = ed.faces;
    if (a === b || !names[a] || !names[b]) return null;
    return { faces: [names[a], names[b]], hint: ed.mid };
  }

  /** A face or edge of the shown part by its persistent names (for measurements that follow rebuilds). */
  entityRef(e: { edge?: EdgeInfo; faceId?: number }): { edge?: EdgeRef; face?: { name: string; hint: V3 } } | null {
    if (!this.active || !this.last) return null;
    if (e.edge) { const r = this.refOfEdge(e.edge); return r ? { edge: r } : null; }
    if (e.faceId != null) {
      const name = this.last.faceNames[e.faceId], f = this.host.viewer.parts[0]?.data.faces[e.faceId];
      return name && f ? { face: { name, hint: [...f.center] as V3 } } : null;
    }
    return null;
  }

  /** What an entityRef points at after a rebuild, if it still exists. */
  resolveRef(r: { edge?: EdgeRef; face?: { name: string; hint: V3 } }): { edge?: EdgeInfo; faceId?: number } | null {
    if (r.edge) { const ed = this.edgeOf(r.edge); return ed ? { edge: ed } : null; }
    const data = this.host.viewer.parts[0]?.data, names = this.last?.faceNames;
    if (!r.face || !data || !names) return null;
    let best = -1, bd = Infinity;
    names.forEach((n, i) => {
      if (n !== r.face!.name || !data.faces[i]) return;
      const c = data.faces[i].center, h = r.face!.hint, d = Math.hypot(c[0] - h[0], c[1] - h[1], c[2] - h[2]);
      if (d < bd) { bd = d; best = i; }
    });
    return best >= 0 ? { faceId: best } : null;
  }

  /** The shown edge an edge reference points at (same face names, nearest to the hint). */
  private edgeOf(ref: EdgeRef): EdgeInfo | null {
    const data = this.host.viewer.parts[0]?.data;
    const names = this.last?.faceNames;
    if (!data || !names) return null;
    let best: EdgeInfo | null = null, bd = Infinity;
    for (const ed of data.edges) {
      const n = [names[ed.faces[0]], names[ed.faces[1]]];
      if (!(n.includes(ref.faces[0]) && n.includes(ref.faces[1]) && ref.faces[0] !== ref.faces[1]) && !(n[0] === ref.faces[0] && n[1] === ref.faces[1])) continue;
      const d = ref.hint ? Math.hypot(ed.mid[0] - ref.hint[0], ed.mid[1] - ref.hint[1], ed.mid[2] - ref.hint[2]) : 0;
      if (d < bd) { bd = d; best = ed; }
    }
    return best;
  }

  // ---------- 3D decorations: sketches, planes, picked edges ----------

  private clearDecor() {
    for (const c of [...this.decor.children]) {
      const o = c as THREE.Mesh;
      o.geometry?.dispose();
      ((o.material as THREE.MeshBasicMaterial)?.map)?.dispose?.();
      (o.material as THREE.Material)?.dispose?.();
    }
    this.decor.clear();
    this.arrow = null;
    document.getElementById("mc-layer")?.replaceChildren();
    this.planeMeshes = [];
    this.lineMats = [];
    this.host.viewer.invalidate();
  }

  private lines(pos: number[], color: number, width: number, dashed = false, depthTest = false) {
    if (!pos.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    const mat = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest, transparent: true, dashed, dashSize: 3, gapSize: 2 });
    mat.resolution.set(this.host.viewer.size.x, this.host.viewer.size.y);
    const l = new LineSegments2(g, mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 2500;
    this.lineMats.push(mat);
    this.decor.add(l);
  }

  private drawDecor() {
    this.clearDecor();
    if (!this.store) return;
    const dark = document.documentElement.dataset.theme === "dark";
    const m = this.mode;
    // Sketches no feature uses yet are shown (SolidWorks shows unabsorbed sketches).
    const used = new Set(this.doc.features.flatMap(f => this.doc.features.filter(g => g.type === "sketch" && absorbs(f, g.id)).map(g => g.id)));
    if (m.kind === "feature" && (m.draft.type === "extrude" || m.draft.type === "revolve")) used.add(m.draft.sketch);
    const end = this.doc.rollback ?? this.doc.features.length;
    this.doc.features.slice(0, end).forEach(f => {
      if (f.type !== "sketch" || f.suppressed || (m.kind === "sketch" && m.id === f.id)) return;
      // Edit sketch plane: the sketch shows on the plane picked so far, highlighted.
      const moving = m.kind === "plane" && m.edit?.id === f.id;
      if ((f.hidden ?? used.has(f.id)) && !moving) return;
      const g = moving ? { ...f, plane: m.edit!.plane } : f;
      this.lines(sketchSegments(g, this.frameOf(g)), moving ? 0xf08c00 : dark ? 0x8ab4ff : 0x1d4ed8, moving ? 2.2 : 1.4);
    });
    // Helix curves (FR-FT-083): drawn like sketch curves; the one being edited highlighted.
    for (const [id, pts] of Object.entries(this.last?.curves ?? {})) {
      const hf = this.doc.features.find(x => x.id === id);
      const editing = m.kind === "feature" && m.draft.id === id;
      if (!editing && (hf?.type !== "helix" || hf.hidden || hf.suppressed)) continue;
      const pos: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) pos.push(...pts[i], ...pts[i + 1]);
      this.lines(pos, editing ? 0xf08c00 : dark ? 0x8ab4ff : 0x1d4ed8, editing ? 2.2 : 1.4);
    }
    const picksPlanes = m.kind === "plane" || (m.kind === "feature" && ((m.draft.type === "plane" && m.focus !== "axis") || (m.draft.type === "extrude" && (this.extrudeTarget(m.draft, m.focus) === "upto" || this.extrudeTarget(m.draft, m.focus) === "start-surface")) || (m.draft.type === "revolve" && m.draft.end === "upto")));
    this.drawPlanes(picksPlanes);
    this.drawHoles();
    this.drawThreads();
    if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) {
      const pos: number[] = [];
      for (const r of m.draft.edges) { const ed = this.edgeOf(r); if (ed) pushEdge(pos, ed); }
      this.lines(pos, 0xf08c00, 4);
      this.drawRoundPreview(m.draft);
    }
    if (m.kind === "feature" && (m.draft.type === "extrude" || m.draft.type === "revolve") && m.draft.op === "cut") this.drawCutPreview();
    if (m.kind === "feature" && (m.draft.type === "axis" || m.draft.type === "point") && m.draft.edge) {
      const ed = this.edgeOf(m.draft.edge);
      if (ed) { const pos: number[] = []; pushEdge(pos, ed); this.lines(pos, 0xf08c00, 4); }
    }
    if (m.kind === "feature" && m.draft.type === "plane" && m.draft.axis) {
      const ed = this.edgeOf(m.draft.axis);
      if (ed) { const pos: number[] = []; pushEdge(pos, ed); this.lines(pos, 0xf08c00, 4); }
    }
    this.drawArrow();
    this.drawFeatureFaces();
    this.host.viewer.invalidate();
  }

  /** Standard planes (when picking one) and the reference planes, as see-through squares. */
  /** Cosmetic threads (FR-FT-053): a dashed circle of the thread's major diameter on each tapped hole; the hole being placed gets crosses. */
  /** The cylinder a round edge bounds, with the thread's direction along it and whether it is a hole. */
  private threadGeom(ed: EdgeInfo) {
    const data = this.host.viewer.parts[0]?.data;
    if (!data || !ed.center || !ed.axis || !ed.radius || (ed.type !== "circle" && ed.type !== "arc")) return null;
    const cyl = ed.faces.map(i => data.faces[i]).find(f => f && (f.type === "cylinder" || f.surface === "cylinder"));
    if (!cyl) return null;
    const a = ed.axis, c = ed.center;
    const w = [cyl.center[0] - c[0], cyl.center[1] - c[1], cyl.center[2] - c[2]];
    const along = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
    const dir: V3 = along < 0 ? [-a[0], -a[1], -a[2]] : [a[0], a[1], a[2]];
    // A hole's surface normals point at the axis.
    const k = data.index[cyl.triStart * 3];
    const p = [data.positions[k * 3], data.positions[k * 3 + 1], data.positions[k * 3 + 2]];
    const nrm = [data.normals[k * 3], data.normals[k * 3 + 1], data.normals[k * 3 + 2]];
    const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const t0 = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
    const rad = [q[0] - a[0] * t0, q[1] - a[1] * t0, q[2] - a[2] * t0];
    const internal = rad[0] * nrm[0] + rad[1] * nrm[1] + rad[2] * nrm[2] < 0;
    return { c, dir, r: ed.radius, internal, full: Math.abs(along) * 2 };
  }

  /** Takes a picked round edge for a cosmetic thread: the nearest ISO size fills in the values. */
  private setThreadEdge(f: ThreadFeature, ed: EdgeInfo) {
    const g = this.threadGeom(ed);
    const ref = this.refOfEdge(ed);
    if (!g || !ref) return false;
    f.edge = ref;
    f.internal = g.internal;
    const d = g.r * 2;
    const best = ISO_METRIC.reduce((b, h) => (Math.abs((g.internal ? h.tap : majorOf(h)) - d) < Math.abs((g.internal ? b.tap : majorOf(b)) - d) ? h : b));
    this.applyThreadSize(f, best.size);
    if (!f.upToEnd) f.length = { v: Math.min(f.length.v, g.full) };
    return true;
  }

  private applyThreadSize(f: ThreadFeature, size: string | undefined) {
    const h = holeSize(size);
    if (!h) { delete f.size; delete f.pitch; return; }
    f.size = h.size;
    f.pitch = h.pitch;
    // Internal: the major diameter; external: the minor one (ISO 68-1, d1 = d − 1.0825 P).
    f.diameter = { v: f.internal ? majorOf(h) : Math.round((majorOf(h) - 1.0825 * h.pitch) * 1000) / 1000 };
  }

  /** Cosmetic threads (FR-FT-054): dashed circles at both ends and four lines along the cylinder. */
  private drawThreads() {
    const m = this.mode;
    const end = this.doc.rollback ?? this.doc.features.length;
    const list = this.doc.features.slice(0, end).filter((f): f is ThreadFeature => f.type === "thread" && !f.suppressed);
    if (m.kind === "feature" && m.draft.type === "thread") { const i = list.findIndex(x => x.id === m.draft.id); if (i >= 0) list[i] = m.draft; else list.push(m.draft); }
    const segs: number[] = [];
    for (const f of list) {
      if (f.modelled) continue;
      const ed = f.edge ? this.edgeOf(f.edge) : null;
      const g = ed ? this.threadGeom(ed) : null;
      if (!g) continue;
      const L = f.upToEnd ? g.full : Math.min(f.length.v, g.full), r = f.diameter.v / 2;
      const n = g.dir, ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = (() => { const x: V3 = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]; const l = Math.hypot(...x); return [x[0] / l, x[1] / l, x[2] / l] as V3; })();
      const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const at = (a: number, s: number) => [0, 1, 2].map(i => g.c[i] + n[i] * s + r * (u[i] * Math.cos(a) + v[i] * Math.sin(a)));
      for (const s of [0, L]) for (let k = 0; k < 48; k++) segs.push(...at((k / 48) * Math.PI * 2, s), ...at(((k + 1) / 48) * Math.PI * 2, s));
      for (let k = 0; k < 4; k++) segs.push(...at((k * Math.PI) / 2, 0), ...at((k * Math.PI) / 2, L));
      this.threadShade(g.c, n, g.r, L, f.pitch ?? Math.max(0.25, f.diameter.v * 0.15), g.internal);
    }
    if (segs.length) { const before = this.decor.children.length; this.lines(segs, 0x2b8a3e, 1.6, true); for (const o of this.decor.children.slice(before)) o.userData.thread = true; }
  }

  /** Diagonal stripes, one per tile: repeated a turn around by a pitch along, they read as a helix. */
  private static threadTex: THREE.CanvasTexture | null = null;

  /**
   * Shaded cosmetic thread (FR-FT-054, SolidWorks' thread texture): a helically striped sleeve just off the
   * cylinder (inside it for a hole), from c along dir for length L.
   */
  private threadShade(c: V3, dir: V3, r: number, L: number, pitch: number, internal: boolean) {
    if (!(L > 0) || !(r > 0)) return;
    let base = ModelController.threadTex;
    if (!base) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 64;
      const g = cv.getContext("2d")!;
      g.strokeStyle = "rgba(20, 24, 32, 0.55)";
      g.lineWidth = 14;
      for (const k of [-1, 0, 1]) { g.beginPath(); g.moveTo(-8, 64 * k + 72); g.lineTo(72, 64 * k - 8); g.stroke(); }
      base = ModelController.threadTex = new THREE.CanvasTexture(cv);
      base.wrapS = base.wrapT = THREE.RepeatWrapping;
      base.colorSpace = THREE.SRGBColorSpace;
    }
    const tex = base.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, Math.min(L / pitch, 2000));
    const off = Math.max(r * 0.004, 0.005);
    const geo = new THREE.CylinderGeometry(r + (internal ? -off : off), r + (internal ? -off : off), L, 64, 1, true);
    geo.translate(0, L / 2, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir).normalize());
    mesh.position.set(...c);
    mesh.renderOrder = 2300;
    mesh.userData.threadShade = true;
    this.decor.add(mesh);
  }

  private drawHoles() {
    const m = this.mode;
    const end = this.doc.rollback ?? this.doc.features.length;
    const list = this.doc.features.slice(0, end).filter((f): f is HoleFeature => f.type === "hole" && !f.suppressed);
    if (m.kind === "feature" && m.draft.type === "hole") { const i = list.findIndex(x => x.id === m.draft.id); if (i >= 0) list[i] = m.draft; else list.push(m.draft); }
    const thread: number[] = [], marks: number[] = [];
    for (const h of list) {
      const fr = this.last?.frames[h.id];
      if (!fr) continue;
      const at = (p: [number, number], dx: number, dy: number) => [0, 1, 2].map(i => fr.o[i] + fr.x[i] * (p[0] + dx) + fr.y[i] * (p[1] + dy));
      for (const p of h.pts) {
        if (h.kind === "tapped" && h.major) {
          const td = h.threadDepth?.v ?? (h.end === "through" ? 0 : h.depth.v);
          const o = at(p, 0, 0) as V3;
          if (td > 0) this.threadShade(o, [-fr.n[0], -fr.n[1], -fr.n[2]], h.diameter.v / 2, td, h.pitch ?? Math.max(0.25, h.major * 0.15), true);
          const r = h.major / 2, n = 48;
          for (let k = 0; k < n; k++) {
            const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
            thread.push(...at(p, r * Math.cos(a0), r * Math.sin(a0)), ...at(p, r * Math.cos(a1), r * Math.sin(a1)));
          }
        }
        if (m.kind === "feature" && m.draft === h) {
          const c = Math.max(h.diameter.v * 0.8, 1.5);
          marks.push(...at(p, -c, 0), ...at(p, c, 0), ...at(p, 0, -c), ...at(p, 0, c));
        }
      }
    }
    if (thread.length) this.lines(thread, 0x2b8a3e, 1.6, true);
    if (marks.length) this.lines(marks, 0xf08c00, 2);
  }

  private drawPlanes(std: boolean) {
    const v = this.host.viewer;
    const b = v.parts.length ? v.bounds : null;
    const s = b && !b.isEmpty() ? Math.max(b.getSize(new THREE.Vector3()).length() * 0.45, 20) : 60;
    const m = this.mode;
    const square = (f: Frame, color: number, ref: PlaneRef, opacity: number, pick: boolean, centre?: THREE.Vector3, depth = false) => {
      const o = centre ?? new THREE.Vector3(...f.o);
      const c = (u: number, w: number) => o.clone().addScaledVector(new THREE.Vector3(...f.x), u * s).addScaledVector(new THREE.Vector3(...f.y), w * s);
      const p = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
      if (pick) {
        const g = new THREE.BufferGeometry().setFromPoints(p);
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
        mesh.userData.ref = ref;
        mesh.renderOrder = 2400;
        this.decor.add(mesh);
        this.planeMeshes.push(mesh);
      }
      const pos: number[] = [];
      for (let i = 0; i < 4; i++) pos.push(...p[i].toArray(), ...p[(i + 1) % 4].toArray());
      this.lines(pos, color, 1.2, false, depth);
    };
    // Standard planes: always while picking a plane; otherwise unless hidden, fainter, and clickable (context bar).
    const colors = { XY: 0x2f6fed, XZ: 0x2f9e44, YZ: 0xe8590c };
    const hiddenStd = this.doc.stdHidden ?? [];
    for (const k of ["XY", "XZ", "YZ"] as const) {
      const sel = this.selected === `std:${k}`;
      if (std || sel || !hiddenStd.includes(k)) square(STD_FRAMES[k], sel ? 0xf08c00 : colors[k], { std: k }, std ? 0.12 : sel ? 0.14 : 0.05, true, undefined, !std && !sel);
    }
    // Reference planes, centred where the model's centre projects onto them.
    const centre = b && !b.isEmpty() ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const onPlane = (f: Frame) => { const n = new THREE.Vector3(...f.n); return centre.clone().addScaledVector(n, new THREE.Vector3(...f.o).sub(centre).dot(n)); };
    const end = this.doc.rollback ?? this.doc.features.length;
    const draftId = m.kind === "feature" && m.draft.type === "plane" ? m.draft.id : null;
    this.doc.features.slice(0, end).forEach(f => {
      if (f.type !== "plane" || f.suppressed || f.hidden || f.id === draftId) return;
      const fr = this.last?.frames[f.id];
      if (fr) square(fr, this.selected === f.id ? 0xf08c00 : 0x7c8594, { plane: f.id }, this.selected === f.id ? 0.16 : 0.08, true, onPlane(fr));
    });
    if (draftId) { const fr = this.last?.frames[draftId]; if (fr) square(fr, 0xf08c00, { plane: draftId }, 0.18, false, onPlane(fr)); }
    // Coordinate systems: a red/green/blue triad.
    const openCs = m.kind === "feature" && m.draft.type === "csys" ? m.draft.id : null;
    const css = this.doc.features.slice(0, end).filter(f => f.type === "csys" && !f.suppressed && !f.hidden && f.id !== openCs).map(f => f.id);
    if (openCs) css.push(openCs);
    for (const id of css) {
      const fr = this.last?.frames[id];
      if (!fr) continue;
      const o = new THREE.Vector3(...fr.o);
      const k = this.host.viewer.pxWorld(o) * (id === openCs || this.selected === id ? 60 : 45);
      ([[fr.x, 0xe03131], [fr.y, 0x2f9e44], [fr.n, 0x1c7ed6]] as [V3, number][]).forEach(([d, col]) => this.lines([...o.toArray(), ...o.clone().addScaledVector(new THREE.Vector3(...d), k).toArray()], col, id === openCs || this.selected === id ? 3 : 2));
    }
    // Reference axes (dash-dot lines through the model) and points (small crosses).
    const open = m.kind === "feature" && (m.draft.type === "axis" || m.draft.type === "point") ? m.draft.id : null;
    const list = this.doc.features.slice(0, end).filter(f => (f.type === "axis" || f.type === "point") && !f.suppressed && !f.hidden && f.id !== open);
    if (open) list.push(m.kind === "feature" ? m.draft : list[0]);
    for (const f of list) {
      const fr = this.last?.frames[f.id];
      if (!fr) continue;
      const col = f.id === open || this.selected === f.id ? 0xf08c00 : 0x7c8594;
      const o = new THREE.Vector3(...fr.o);
      if (f.type === "axis") {
        const n = new THREE.Vector3(...fr.n);
        const c = o.clone().addScaledVector(n, centre.clone().sub(o).dot(n));
        const a = c.clone().addScaledVector(n, -s * 1.1), z = c.clone().addScaledVector(n, s * 1.1);
        this.lines([...a.toArray(), ...z.toArray()], col, f.id === open ? 2.4 : 1.6, true);
      } else {
        const k = this.host.viewer.pxWorld(o) * 7;
        const pos: number[] = [];
        for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) pos.push(...o.clone().addScaledVector(new THREE.Vector3(...d), -k).toArray(), ...o.clone().addScaledVector(new THREE.Vector3(...d), k).toArray());
        this.lines(pos, col, 2.2);
      }
    }
  }

  // ---------- extrude depth arrow (FR-FT-017, FR-UI-027) ----------

  /** The extrude or revolve being edited, or the one selected in the tree (dragging it edits it at once). */
  private arrowFeature(): ExtrudeFeature | RevolveFeature | null {
    const m = this.mode;
    const ok = (f: Feature | undefined): f is ExtrudeFeature | RevolveFeature => f?.type === "revolve" || (f?.type === "extrude" && (f.end === "blind" || f.end === "mid"));
    if (m.kind === "feature") return ok(m.draft) ? m.draft : null;
    if (m.kind !== "none" || !this.selected) return null;
    const f = this.store?.feature(this.selected);
    const st = this.last?.statuses.find(x => x.id === f?.id);
    const end = this.doc.rollback ?? this.doc.features.length;
    const i = this.doc.features.findIndex(x => x.id === f?.id);
    return ok(f) && !f.suppressed && st?.ok && i < end ? f : null;
  }

  private drawArrow() {
    this.arrow = null;
    const f = this.arrowFeature();
    if (!f) return;
    const sk = this.store!.feature(f.sketch);
    if (sk?.type !== "sketch") return;
    const fr = this.frameOf(sk);
    const pts = sk.ents.filter(e => e.t === "point") as { x: number; y: number }[];
    if (!pts.length) return;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const W = (x: number, y: number) => new THREE.Vector3(...fr.o).addScaledVector(new THREE.Vector3(...fr.x), x).addScaledVector(new THREE.Vector3(...fr.y), y);
    const base = W(cx, cy);
    if (f.type === "revolve") { if (f.end !== "upto") this.drawAngleHandle(f, sk, W); return; }
    if (f.start === "offset") base.addScaledVector(new THREE.Vector3(...fr.n), (f.startOffset?.v ?? 0) * (f.startReverse ? -1 : 1));
    const dir = new THREE.Vector3(...fr.n).multiplyScalar((f.op === "cut" ? -1 : 1) * (f.flip ? -1 : 1));
    const mid = f.end === "mid";
    const tip = base.clone().addScaledVector(dir, mid ? f.depth.v / 2 : f.depth.v);
    const obj = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xf08c00, depthTest: false, transparent: true });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 10).translate(0, 0.5, 0), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 18).translate(0, 1.25, 0), mat);
    // A fat invisible cylinder is what the pointer hits.
    const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8).translate(0, 0.8, 0), new THREE.MeshBasicMaterial({ visible: false }));
    obj.add(shaft, head, pick);
    obj.position.copy(tip);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    obj.renderOrder = 2600;
    shaft.renderOrder = head.renderOrder = 2600;
    this.decor.add(obj);
    this.arrow = { obj, pick, base, dir, scale: 1, mid };
    this.handleLabel(f.id, "depth", t("Drag the arrow to change the depth; click to type it"));
  }

  private handleLabel(id: string, num: string, title: string) {
    const label = document.createElement("button");
    label.className = "mc-handle";
    label.title = title;
    label.addEventListener("click", () => {
      if (this.mode.kind !== "feature") this.editFeature(id);
      setTimeout(() => ($("#mc-pm").querySelector<HTMLInputElement>(`input[data-num=${num}]`))?.focus(), 0);
    });
    $("#mc-layer").appendChild(label);
    this.sizeArrow();
  }

  /** Revolve angle handle (FR-FT-030): an arc swept about the axis through the profile's centre, with a grip at the end angle. */
  private drawAngleHandle(f: RevolveFeature, sk: SketchFeature, W: (x: number, y: number) => THREE.Vector3) {
    const ax = sk.ents.find(e => e.id === f.axis);
    if (!ax || ax.t !== "line") return;
    const pa = sk.ents.find(e => e.id === ax.a), pb = sk.ents.find(e => e.id === ax.b);
    if (pa?.t !== "point" || pb?.t !== "point") return;
    const A = W(pa.x, pa.y), u = W(pb.x, pb.y).sub(A);
    if (u.length() < 1e-9) return;
    u.normalize().multiplyScalar(f.flip ? -1 : 1);
    // Profile centre: the points of the sketch other than the axis's own.
    const pts = sk.ents.filter(e => e.t === "point" && e.id !== ax.a && e.id !== ax.b) as { x: number; y: number }[];
    if (!pts.length) return;
    const P = W(pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.y, 0) / pts.length);
    const c = A.clone().addScaledVector(u, P.clone().sub(A).dot(u));
    const r = P.clone().sub(c);
    if (r.length() < 1e-6) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xf08c00, depthTest: false, transparent: true });
    const arc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf08c00, depthTest: false, transparent: true }));
    arc.renderOrder = 2600;
    const head = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 18).translate(0, 0.25, 0), mat);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10), mat);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    cone.renderOrder = ball.renderOrder = 2600;
    head.add(cone, ball, pick);
    const obj = new THREE.Group();
    obj.add(arc, head);
    this.decor.add(obj);
    this.arrow = { obj, pick, base: c, dir: u, scale: 1, mid: !!f.mid, ang: { c, u, r, arc, head } };
    this.placeAngle(f.angle.v);
    this.handleLabel(f.id, "angle", t("Drag the handle to change the angle; click to type it"));
  }

  /** Moves the angle handle's arc and grip to a revolve angle (half of it each way for Mid plane). */
  private placeAngle(angle: number) {
    const a = this.arrow?.ang;
    if (!a) return;
    const from = this.arrow!.mid ? -angle / 2 : 0, to = this.arrow!.mid ? angle / 2 : angle;
    const at = (q: number) => a.c.clone().add(a.r.clone().applyAxisAngle(a.u, q));
    const n = Math.max(8, Math.ceil(((to - from) * 48) / Math.PI));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) pts.push(at(from + ((to - from) * i) / n));
    a.arc.geometry.dispose();
    a.arc.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    a.head.position.copy(at(to));
    // The cone points along the sweep (the tangent at the end).
    a.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.u.clone().cross(a.r.clone().applyAxisAngle(a.u, to)).normalize());
  }

  /** Signed angle of the pointer about the revolve axis, from the radius at 0°. */
  private pointerAngle(e: PointerEvent) {
    const a = this.arrow!.ang!;
    const ray = this.ray(e).ray;
    const den = ray.direction.dot(a.u);
    let q: THREE.Vector3;
    if (Math.abs(den) > 1e-6) q = ray.origin.clone().addScaledVector(ray.direction, a.c.clone().sub(ray.origin).dot(a.u) / den).sub(a.c);
    else q = ray.closestPointToPoint(a.c, new THREE.Vector3()).sub(a.c);
    q.addScaledVector(a.u, -q.dot(a.u));
    const x = a.r.clone().normalize(), y = a.u.clone().cross(x);
    return Math.atan2(q.dot(y), q.dot(x));
  }

  /** Keeps the arrow a constant size on screen and its value label beside the tip. */
  private sizeArrow() {
    const a = this.arrow;
    if (!a) return;
    const v = this.host.viewer;
    const holder = a.ang ? a.ang.head : a.obj;
    const px = v.pxWorld(holder.position);
    a.scale = px * 70;
    holder.scale.setScalar(a.scale);
    const label = $("#mc-layer").querySelector<HTMLElement>(".mc-handle");
    const f = this.arrowFeature();
    if (label && f) {
      const tip = a.ang ? a.ang.head.position.clone().add(a.ang.head.position.clone().sub(a.ang.c).setLength(a.scale * 0.9)) : a.obj.position.clone().addScaledVector(a.dir, a.scale * 1.5);
      const s = tip.project(v.camera);
      label.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      label.style.top = `${((1 - s.y) / 2) * v.size.y}px`;
      label.textContent = f.type === "revolve" ? `${trimNum((f.angle.v * 180) / Math.PI, 2)}°`
        : `${trimNum(f.depth.v * UNITS[units.current].f, units.decimals ?? this.doc.units.decimals)} ${units.current}`;
    }
  }

  private ray(e: PointerEvent) {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    return rc;
  }

  private arrowHit(e: PointerEvent) {
    if (!this.arrow) return false;
    this.arrow.obj.updateMatrixWorld(true);
    return this.ray(e).intersectObject(this.arrow.pick, false).length > 0;
  }

  /** Distance along the arrow's axis to the point nearest the pointer's ray. */
  private axisParam(e: PointerEvent) {
    const a = this.arrow!;
    const ray = this.ray(e).ray;
    const w0 = a.base.clone().sub(ray.origin);
    const b = a.dir.dot(ray.direction), d = a.dir.dot(w0), ee = ray.direction.dot(w0);
    const den = 1 - b * b;
    return Math.abs(den) < 1e-9 ? 0 : (b * ee - d) / den;
  }

  private startArrowDrag(e: PointerEvent) {
    const f = this.arrowFeature();
    if (!f) return;
    // Selected in the tree (no command open): dragging edits the feature and applies on release (Instant3D).
    if (this.mode.kind === "none") {
      const i = this.doc.features.findIndex(x => x.id === f.id);
      this.mode = { kind: "feature", draft: structuredClone(f), index: i, isNew: false, instant: true };
      this.renderAll();
    }
    this.arrowDrag = f.type === "revolve"
      ? { start: 0, depth: f.angle.v, moved: false, raw: this.pointerAngle(e) }
      : { start: this.axisParam(e), depth: f.depth.v, moved: false };
    const canvas = this.host.viewer.renderer.domElement;
    canvas.style.cursor = "grabbing";
    // Keep getting the moves and the release when the pointer leaves the view.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  }

  private moveArrow(e: PointerEvent) {
    const m = this.mode, d = this.arrowDrag, a = this.arrow;
    if (m.kind === "feature" && m.draft.type === "revolve" && d && a?.ang) { this.moveAngle(e, m.draft, d); return; }
    if (m.kind !== "feature" || m.draft.type !== "extrude" || !d || !a) return;
    const k = a.mid ? 2 : 1;
    let v = d.depth + (this.axisParam(e) - d.start) * k;
    // Round to a step that suits the zoom (Shift: finer).
    const px = this.host.viewer.pxWorld(a.obj.position) * (e.shiftKey ? 1 : 6);
    const step = 10 ** Math.floor(Math.log10(Math.max(px, 1e-6)));
    const fu = UNITS[units.current].f;
    v = (Math.round((v * fu) / step) * step) / fu;
    if (!(v > 1e-6)) v = step / fu;
    if (Math.abs(v - m.draft.depth.v) < 1e-12) return;
    d.moved = true;
    m.draft.depth = { v };
    const inp = $("#mc-pm").querySelector<HTMLInputElement>("input[data-num=depth]");
    if (inp) inp.value = trimNum(v * fu, 6);
    a.obj.position.copy(a.base).addScaledVector(a.dir, a.mid ? v / 2 : v);
    this.sizeArrow();
    void this.rebuild();
  }

  /** Dragging the revolve grip: the angle follows the pointer round the axis, unwrapped so it can reach 360°. */
  private moveAngle(e: PointerEvent, f: RevolveFeature, d: NonNullable<typeof this.arrowDrag>) {
    const raw = this.pointerAngle(e);
    let delta = raw - d.raw!;
    delta -= Math.round(delta / (2 * Math.PI)) * 2 * Math.PI;
    d.raw = raw;
    d.depth += delta * (this.arrow!.mid ? 2 : 1);
    // 1° steps (Shift: 0.1°), between a step and a full turn.
    const step = ((e.shiftKey ? 0.1 : 1) * Math.PI) / 180;
    let v = Math.round(d.depth / step) * step;
    v = Math.min(Math.max(v, step), 2 * Math.PI);
    if (Math.abs(v - f.angle.v) < 1e-12) return;
    d.moved = true;
    f.angle = { v };
    const inp = $("#mc-pm").querySelector<HTMLInputElement>("input[data-num=angle]");
    if (inp) inp.value = trimNum((v * 180) / Math.PI, 6);
    this.placeAngle(v);
    this.sizeArrow();
    void this.rebuild();
  }

  private endArrowDrag() {
    const m = this.mode, d = this.arrowDrag;
    this.arrowDrag = null;
    this.host.viewer.renderer.domElement.style.cursor = "";
    if (m.kind === "feature" && m.instant) {
      if (d?.moved) this.ok(); else { this.exitMode(false); void this.rebuild(); }
      return;
    }
    this.renderPanel();
  }

  /** The faces made by the feature selected in the tree (FR-HIS-003). */
  private drawFeatureFaces() {
    const m = this.mode;
    // While an extrude or revolve is open, its faces are tinted yellow like a SolidWorks preview.
    const draft = m.kind === "feature" && (m.draft.type === "extrude" || m.draft.type === "revolve") ? m.draft.id : null;
    const id = draft ?? (m.kind === "none" ? this.selected : null);
    if (!id) return;
    const part = this.host.viewer.parts[0];
    const names = this.last?.faceNames;
    if (!part || !names) return;
    const pre = `${id}:`;
    const geo = part.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position"), idx = geo.getIndex();
    const out: number[] = [];
    part.data.faces.forEach((fc, i) => {
      if (!names[i]?.startsWith(pre)) return;
      for (let tri = fc.triStart; tri < fc.triStart + fc.triCount; tri++) for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(tri * 3 + k) : tri * 3 + k;
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    });
    if (!out.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: draft ? 0xffd43b : 0x4dabf7, transparent: true, opacity: draft ? 0.5 : 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    mesh.applyMatrix4(part.mesh.matrixWorld);
    mesh.renderOrder = 2300;
    mesh.raycast = () => {};
    this.decor.add(mesh);
  }

  /**
   * Live preview of a fillet or chamfer (SolidWorks style): its new faces in see-through yellow over the
   * body the edges are picked on, and a callout with the size at the first edge (FR-FT-031).
   */
  /** The material an open cut removes, as a see-through yellow body (SolidWorks' cut preview). */
  private drawCutPreview() {
    const pv = this.last?.preview;
    if (!pv?.position.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pv.position, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd43b, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 2350;
    mesh.raycast = () => {};
    mesh.userData.cutPreview = true;
    this.decor.add(mesh);
    // Its outline, so the shape reads through the body.
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0xe8a800, depthTest: false, transparent: true, opacity: 0.9 }));
    e.renderOrder = 2351;
    e.raycast = () => {};
    this.decor.add(e);
  }

  private drawRoundPreview(f: FilletFeature | ChamferFeature) {
    const pv = this.last?.preview;
    if (pv?.position.length && roundReady(f)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pv.position, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd43b, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      // Drawn over the un-rounded body so the whole new face shows, as a see-through yellow ghost.
      mesh.renderOrder = 2350;
      mesh.raycast = () => {};
      this.decor.add(mesh);
    }
    const fu = UNITS[units.current].f, dec = units.decimals ?? this.doc.units.decimals;
    const size = (v: number) => `${trimNum(v * fu, dec)} ${units.current}`;
    if (f.type === "fillet" && f.variable) {
      // Variable radius: a callout at each end of every edge; `at` fixes which end is the start.
      let fixed = false;
      f.edges.forEach((r, i) => {
        const e = this.edgeOf(r);
        if (!e) return;
        if (!r.at) { r.at = e.start; fixed = true; }
        const startAt = Math.hypot(e.start[0] - r.at[0], e.start[1] - r.at[1], e.start[2] - r.at[2]) <= Math.hypot(e.end[0] - r.at[0], e.end[1] - r.at[1], e.end[2] - r.at[2]) ? e.start : e.end;
        const other = startAt === e.start ? e.end : e.start;
        ([[startAt, r.r ?? f.radius.v, "er", "a"], [other, r.r2 ?? r.r ?? f.radius.v, "er2", "b"]] as const).forEach(([p, v, key, tag]) => {
          const label = document.createElement("button");
          label.className = "mc-handle mc-callout";
          label.textContent = `R${i + 1}${tag}: ${size(v)}`;
          label.title = t("Click to type the size");
          label.dataset.at = JSON.stringify(p);
          label.addEventListener("click", () => { const inp = $("#mc-pm").querySelector<HTMLInputElement>(`input[data-${key}="${i}"]`); inp?.focus(); inp?.select(); });
          $("#mc-layer").appendChild(label);
        });
      });
      this.placeCallouts();
      if (fixed) void this.rebuild();
      return;
    }
    if (f.type === "fillet" && f.multi) {
      // Multiple radius: a callout on every edge, each opening its own field.
      f.edges.forEach((r, i) => {
        const e = this.edgeOf(r);
        if (!e) return;
        const label = document.createElement("button");
        label.className = "mc-handle mc-callout";
        label.textContent = `R${i + 1}: ${size(r.r ?? f.radius.v)}`;
        label.title = t("Click to type the size");
        label.dataset.at = JSON.stringify(e.mid);
        label.addEventListener("click", () => { const inp = $("#mc-pm").querySelector<HTMLInputElement>(`input[data-er="${i}"]`); inp?.focus(); inp?.select(); });
        $("#mc-layer").appendChild(label);
      });
      this.placeCallouts();
      return;
    }
    const ed = f.edges.length ? this.edgeOf(f.edges[0]) : null;
    if (!ed) return;
    const label = document.createElement("button");
    label.className = "mc-handle mc-callout";
    label.textContent = f.type === "fillet" ? `${t("Radius")}: ${size(f.radius.v)}`
      : (f.mode ?? "equal") === "two" ? `${size(f.distance.v)} × ${size(f.distance2?.v ?? f.distance.v)}`
      : (f.mode ?? "equal") === "angle" ? `${size(f.distance.v)} × ${trimNum(((f.angle?.v ?? 0) * 180) / Math.PI, 2)}°`
      : `${t("Distance")}: ${size(f.distance.v)}`;
    label.title = t("Click to type the size");
    label.dataset.at = JSON.stringify(ed.mid);
    label.addEventListener("click", () => ($("#mc-pm").querySelector<HTMLInputElement>(f.type === "fillet" ? "input[data-num=radius]" : "input[data-num=distance]"))?.focus());
    $("#mc-layer").appendChild(label);
    this.placeCallouts();
  }

  private placeCallouts() {
    const v = this.host.viewer;
    $("#mc-layer").querySelectorAll<HTMLElement>(".mc-callout").forEach(el => {
      const s = new THREE.Vector3(...(JSON.parse(el.dataset.at!) as V3)).project(v.camera);
      el.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      el.style.top = `${((1 - s.y) / 2) * v.size.y - 24}px`;
    });
  }

  /** "Start a sketch on a plane" over an empty part (FR-HLP-005). */
  private renderEmpty() {
    const el = $("#mc-empty");
    if (el) el.hidden = !this.store || this.mode.kind !== "none" || this.doc.features.length > 0;
  }

  // ---------- DOM: command bar, tree, panel ----------

  private renderAll() { this.renderBar(); this.renderTree(); this.renderPanel(); }

  private renderBar() {
    const bar = $("#mc-bar");
    if (!this.store) { bar.hidden = true; $("#mc-confirm").hidden = true; return; }
    bar.hidden = false;
    const m = this.mode;
    document.getElementById("app")!.classList.toggle("mc-cmd", m.kind !== "none");
    if (m.kind !== "sketch") {
      $("#mc-status").textContent = m.kind === "plane" ? t(m.edit ? "Pick the new plane or flat face for the sketch." : "Pick a plane or a flat face for the sketch.")
        : m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer") ? t("Click edges, or a face for all its edges; click again to remove.")
        : m.kind === "feature" ? t("Set the values in the panel; the view shows the result.") : "";
    }
    $("#mc-confirm").hidden = m.kind === "none";
    $("#mc-ok").title = m.kind === "sketch" ? t("Exit sketch (Enter)") : t("OK (Enter)");
    $("#mc-ok").setAttribute("aria-label", $("#mc-ok").title);
    const btn = (id: string, label: string, title: string, on = false, dis = false) =>
      `<button class="mc-b${on ? " on" : ""}" data-c="${id}" title="${esc(title)}"${on ? ' aria-pressed="true"' : ""}${dis ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${ICON_SVG[id] ?? ""}</span><span class="mc-l">${esc(label)}</span></button>`;
    let html: string;
    if (m.kind === "sketch") {
      const tool = m.editor.tool;
      const tools: [SkTool, string, string][] = [
        ["select", t("Select"), t("Select and drag (Esc)")], ["line", t("Line"), t("Line (L)")], ["rect", t("Rectangle"), t("Corner rectangle (R)")],
        ["crect", t("Centre rect"), t("Centre rectangle")], ["circle", t("Circle"), t("Circle (C)")], ["circle3", t("3-pt circle"), t("Circle through three points")],
        ["arc", t("Arc"), t("Centre-point arc (A)")], ["arc3", t("3-pt arc"), t("Arc through start, end and a point on it")],
        ["polygon", t("Polygon"), t("Polygon: centre, then a corner")], ["slot", t("Slot"), t("Straight slot: two centres, then the width (W)")],
        ["spline", t("Spline"), t("Spline: click points it passes through; double-click ends it")], ["ellipse", t("Ellipse"), t("Ellipse: centre, end of the major axis, then a point on it")], ["earc", t("Partial ellipse"), t("Partial ellipse: centre, major axis, start, then end")], ["point", t("Point"), t("Point (P)")],
        ["trim", t("Trim"), t("Trim: click the piece of a curve to remove (T)")], ["extend", t("Extend"), t("Extend a line or arc to the next curve (E)")], ["split", t("Split"), t("Split a line or arc where you click")],
        ["fillet", t("Fillet"), t("Sketch fillet: click a corner where two lines meet")], ["chamfer", t("Chamfer"), t("Sketch chamfer: click a corner where two lines meet")],
        ["offset", t("Offset"), t("Offset entities: a curve or a chain, to the cursor's side (O)")], ["convert", t("Convert"), t("Convert entities: copy model edges into the sketch")], ["intersect", t("Intersection curve"), t("Intersection curve: where the sketch plane cuts model faces")],
        ["dim", t("Dimension"), t("Smart dimension (D)")],
        ["hord", t("Horizontal ordinate"), t("Horizontal ordinate dimensions: X distances from one base")], ["vord", t("Vertical ordinate"), t("Vertical ordinate dimensions: Y distances from one base")],
      ];
      // Related tools share one button with a flyout (SolidWorks-style): the button shows the last one used.
      const groups: SkTool[][] = [["select"], ["dim", "hord", "vord"], ["line", "spline"], ["rect", "crect", "polygon"], ["circle", "circle3", "ellipse", "earc"], ["arc", "arc3"], ["slot"], ["point"], ["trim", "extend", "split"], ["fillet", "chamfer"], ["offset", "convert", "intersect"]];
      const info = new Map(tools.map(x => [x[0], x]));
      html = `<div class="mc-g" role="group" aria-label="${esc(t("Sketch"))}">${groups.map(g => {
        const cur = g.includes(tool) ? tool : (this.flyLast.get(g[0]) as SkTool | undefined) ?? g[0];
        const [id, l, ti] = info.get(cur)!;
        if (g.length === 1) return btn(`sk:${id}`, l, ti, tool === id);
        return `<span class="mc-fly">${btn(`sk:${id}`, l, ti, tool === id)}<button class="mc-caret" data-fly="${g[0]}" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(l)}">▾</button></span>`;
      }).join("")}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("cons", t("Construction"), t("Construction geometry on/off for the selection (Q)"))}${btn("skmirror", t("Mirror"), t("Mirror entities: select them and a line to mirror about, then click"))}${btn("skdxf", t("DXF"), t("Import a DXF drawing into the sketch"))}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("sklpat", t("Linear pattern"), t("Linear sketch pattern: select entities, then set count and spacing"))}${btn("skcpat", t("Circular pattern"), t("Circular sketch pattern: select entities (and a centre point), then set count and angle"))}${btn("skmove", t("Move"), t("Move or copy entities by a distance"))}${btn("skrot", t("Rotate"), t("Rotate entities about a point"))}${btn("skscale", t("Scale"), t("Scale entities about a point"))}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("undo", t("Undo"), t("Undo (Ctrl+Z)"), false, !this.store.canUndo)}${btn("redo", t("Redo"), t("Redo (Ctrl+Y)"), false, !this.store.canRedo)}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("exit", t("Exit sketch"), t("Exit sketch (Enter)"))}</div>`;
    } else {
      const busy = m.kind !== "none";
      html = `<div class="mc-g" role="group" aria-label="${esc(t("Features"))}">`
        + btn("sketch", t("Sketch"), t("Sketch on a plane or a flat face"), m.kind === "plane")
        + btn("extrude", t("Extrude"), t("Extruded boss: adds material from a sketch"), m.kind === "feature" && m.draft.type === "extrude" && m.draft.op === "boss")
        + btn("cut", t("Cut"), t("Extruded cut: removes material"), m.kind === "feature" && m.draft.type === "extrude" && m.draft.op === "cut")
        + btn("revolve", t("Revolve"), t("Revolve a sketch around a line"), m.kind === "feature" && m.draft.type === "revolve")
        + btn("fillet", t("Fillet"), t("Round edges"), m.kind === "feature" && m.draft.type === "fillet")
        + btn("chamfer", t("Chamfer"), t("Bevel edges"), m.kind === "feature" && m.draft.type === "chamfer")
        + btn("hole", t("Hole"), t("Hole wizard: simple, counterbore, countersink and tapped holes at points on a face"), m.kind === "feature" && m.draft.type === "hole")
        + btn("thread", t("Cosmetic thread"), t("Cosmetic thread: thread data on a round edge of a cylinder, drawn as dashed circles"), m.kind === "feature" && m.draft.type === "thread")
        + btn("shell", t("Shell"), t("Shell: hollow the body, leaving picked faces open"), m.kind === "feature" && m.draft.type === "shell")
        + btn("draft", t("Draft"), t("Draft: taper faces by an angle about a neutral plane"), m.kind === "feature" && m.draft.type === "draft")
        + (() => {
          // Sweep flyout (FRS 9.9): Sweep ▾ Cut-Sweep, Loft, Cut-Loft, Helix.
          const open = m.kind === "feature" ? (m.draft.type === "sweep" || m.draft.type === "loft" ? `${m.draft.type}${m.draft.op === "cut" ? "cut" : ""}` : m.draft.type) : null;
          const all = P3_TOOLS();
          const cur = all.find(r => r[0] === open) ?? all.find(r => r[0] === this.flyLast.get("sweep")) ?? all[0];
          return `<span class="mc-fly">${btn(cur[0], cur[1], cur[2], open === cur[0])}<button class="mc-caret" data-fly="sweep" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(cur[1])}">▾</button></span>`;
        })()
        + (() => {
          // Surface flyout (FRS 9.11): Extruded ▾ Planar, Offset, Knit, Thicken.
          const open = m.kind === "feature" ? m.draft.type : null;
          const all = SURF_TOOLS();
          const cur = all.find(r => r[0] === open) ?? all.find(r => r[0] === this.flyLast.get("surf")) ?? all[0];
          return `<span class="mc-fly">${btn(cur[0], cur[1], cur[2], open === cur[0])}<button class="mc-caret" data-fly="surf" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(cur[1])}">▾</button></span>`;
        })()
        + (() => {
          // Pattern flyout: Linear ▾ Circular, Mirror.
          const pats: [string, string, string][] = [["lpattern", t("Linear pattern"), t("Linear pattern: copies of features along one or two directions")], ["cpattern", t("Circular pattern"), t("Circular pattern: copies of features about an axis")], ["mirror", t("Mirror"), t("Mirror features, or the whole body, about a plane")]];
          const open = m.kind === "feature" ? m.draft.type : null;
          const cur = pats.find(r => r[0] === open) ?? pats.find(r => r[0] === this.flyLast.get("pattern")) ?? pats[0];
          return `<span class="mc-fly">${btn(cur[0], cur[1], cur[2], open === cur[0])}<button class="mc-caret" data-fly="pattern" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(cur[1])}">▾</button></span>`;
        })()
        + (() => {
          // Reference geometry flyout: Plane ▾ Axis, Point.
          const refs: [string, string, string][] = [["plane", t("Plane"), t("Reference plane: offset from a plane or face, or at an angle about an edge")], ["axis", t("Axis"), t("Reference axis: a straight edge, a round face's axis, or two planes")], ["point", t("Point"), t("Reference point: a vertex, an arc centre, a face centre or an edge midpoint")], ["csys", t("Coordinate system"), t("Coordinate system: an origin and X and Z directions, for measurements and export")]];
          const open = m.kind === "feature" ? m.draft.type : null;
          const cur = refs.find(r => r[0] === open) ?? refs.find(r => r[0] === this.flyLast.get("plane")) ?? refs[0];
          return `<span class="mc-fly">${btn(cur[0], cur[1], cur[2], open === cur[0])}<button class="mc-caret" data-fly="plane" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(cur[1])}">▾</button></span>`;
        })()
        + `</div><div class="mc-sep"></div><div class="mc-g">`
        + btn("filter", t("Filter"), t("Selection filter: faces, edges, vertices (F5)"), !!document.getElementById("mc-filter") || !(SEL_FILTER.faces && SEL_FILTER.edges && SEL_FILTER.vertices))
        + `</div><div class="mc-sep"></div><div class="mc-g">`
        + btn("undo", t("Undo"), t("Undo (Ctrl+Z)"), false, busy || !this.store.canUndo) + btn("redo", t("Redo"), t("Redo (Ctrl+Y)"), false, busy || !this.store.canRedo)
        + `</div><div class="mc-sep"></div><div class="mc-g">`
        + `<span class="mc-fly">${btn("save", t("Save"), t("Save the part as .mcadprt (Ctrl+S)"))}<button class="mc-caret" data-fly="save" aria-haspopup="menu" title="${esc(t("More save options"))}" aria-label="${esc(t("More save options"))}">▾</button></span>` + btn("step", t("STEP"), t("Export the body as STEP"))
        + `</div>`;
    }
    $("#mc-tools").innerHTML = html;
    $("#mc-tools").querySelectorAll<HTMLButtonElement>("[data-c]").forEach(b => b.addEventListener("click", () => this.command(b.dataset.c!)));
    $("#mc-tools").querySelectorAll<HTMLButtonElement>("[data-fly]").forEach(b => b.addEventListener("click", () => {
      const mm = this.mode;
      if (b.dataset.fly === "pattern" && mm.kind !== "sketch") {
        const r = b.getBoundingClientRect();
        this.showMenu(([["lpattern", t("Linear pattern")], ["cpattern", t("Circular pattern")], ["mirror", t("Mirror")]] as const).map(([id, l]) => [l, () => { this.flyLast.set("pattern", id); this.command(id); }, ICON_SVG[id]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="pattern"]')?.focus());
        return;
      }
      if (b.dataset.fly === "sweep" && mm.kind !== "sketch") {
        const r = b.getBoundingClientRect();
        this.showMenu(P3_TOOLS().map(([id, l]) => [l, () => { this.flyLast.set("sweep", id); this.command(id); }, ICON_SVG[id]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="sweep"]')?.focus());
        return;
      }
      if (b.dataset.fly === "surf" && mm.kind !== "sketch") {
        const r = b.getBoundingClientRect();
        this.showMenu(SURF_TOOLS().map(([id, l]) => [l, () => { this.flyLast.set("surf", id); this.command(id); }, ICON_SVG[id]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="surf"]')?.focus());
        return;
      }
      if (b.dataset.fly === "save") {
        const r = b.getBoundingClientRect();
        this.showMenu([[t("Save as…"), () => void this.save(true)], [t("Snapshots…"), () => void this.showSnapshots()]], r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="save"]')?.focus());
        return;
      }
      if (b.dataset.fly === "plane" && mm.kind !== "sketch") {
        const r = b.getBoundingClientRect();
        this.showMenu(([["plane", t("Plane")], ["axis", t("Axis")], ["point", t("Point")], ["csys", t("Coordinate system")]] as const).map(([id, l]) => [l, () => { this.flyLast.set("plane", id); this.command(id); }, ICON_SVG[id]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="plane"]')?.focus());
        return;
      }
      if (mm.kind !== "sketch") return;
      const g = ({ line: ["line", "spline"], rect: ["rect", "crect", "polygon"], circle: ["circle", "circle3", "ellipse", "earc"], arc: ["arc", "arc3"], trim: ["trim", "extend", "split"], fillet: ["fillet", "chamfer"], offset: ["offset", "convert", "intersect"], dim: ["dim", "hord", "vord"] } as Record<string, SkTool[]>)[b.dataset.fly!];
      const label: Record<string, string> = { line: t("Line"), spline: t("Spline"), rect: t("Corner rectangle"), crect: t("Centre rectangle"), polygon: t("Polygon"), circle: t("Circle"), circle3: t("3-point circle"), arc: t("Centre-point arc"), arc3: t("3-point arc"), ellipse: t("Ellipse"), earc: t("Partial ellipse"), trim: t("Trim"), extend: t("Extend"), split: t("Split"), fillet: t("Sketch fillet"), chamfer: t("Sketch chamfer"), offset: t("Offset entities"), convert: t("Convert entities"), intersect: t("Intersection curve"), dim: t("Smart dimension"), hord: t("Horizontal ordinate"), vord: t("Vertical ordinate") };
      const r = b.getBoundingClientRect();
      this.showMenu(g.map(id => [label[id], () => { this.flyLast.set(g[0], id); mm.editor.setTool(id); this.renderBar(); this.renderPanel(); }, ICON_SVG[`sk:${id}`]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
        () => $("#mc-tools").querySelector<HTMLElement>(`[data-fly="${b.dataset.fly}"]`)?.focus());
    }));
  }

  /** Last pointer position over the view (where the shortcut bar opens). */
  private pointer: { x: number; y: number } | null = null;

  /** The S-key shortcut bar: the commands for the current mode in a small bar at the cursor. */
  showShortcutBar() {
    const m = this.mode;
    this.hideShortcutBar();
    this.ctxPick = null;
    const items: [string, string][] = m.kind === "sketch"
      ? [["sk:line", t("Line")], ["sk:rect", t("Rectangle")], ["sk:circle", t("Circle")], ["sk:arc", t("Arc")], ["sk:slot", t("Slot")], ["sk:trim", t("Trim")], ["sk:offset", t("Offset")], ["sk:fillet", t("Fillet")], ["sk:dim", t("Dimension")], ["sk:select", t("Select")]]
      : [["sketch", t("Sketch")], ["extrude", t("Extrude")], ["cut", t("Cut")], ["revolve", t("Revolve")], ["fillet", t("Fillet")], ["chamfer", t("Chamfer")], ["plane", t("Plane")]];
    const vr = this.host.vp.getBoundingClientRect();
    this.popBar("mc-sbar", t("Shortcut bar"), items, this.pointer ?? { x: vr.left + vr.width / 2, y: vr.top + vr.height / 2 }, false);
  }

  /**
   * The context toolbar (FR-UI-026): after a click picks a face or an edge, the commands for it in a small
   * bar by the cursor, as in SolidWorks. It fades as the pointer moves away and goes at 160 px.
   */
  showContextBar(at: { x: number; y: number }, other = false) {
    this.hideShortcutBar();
    if (this.mode.kind !== "none" || !this.store || !this.last) return;
    const items: [string, string][] = [];
    const names = this.last.faceNames;
    const owner = (faceId: number) => {
      const id = names[faceId]?.split(":")[0];
      const f = id ? this.store!.feature(id) : undefined;
      return f && !f.suppressed ? f : undefined;
    };
    const addOwner = (f: Feature | undefined) => {
      if (!f) return;
      if ("sketch" in f && typeof f.sketch === "string" && this.store!.feature(f.sketch)) items.push([`editsk:${f.sketch}`, t("Edit sketch")]);
      items.push([`edit:${f.id}`, t("Edit feature")]);
    };
    // The entity under the click: with one entity already picked, Smart measure keeps that one as its selection.
    // Select other (Alt+click) picks a face behind the one under the cursor: the bar follows that pick.
    const sf = other ? this.host.selectedFace() : null;
    const hit = other ? (sf != null ? { faceId: sf } : null) : this.host.edgeAt(at.x, at.y);
    const edge = hit?.edge ?? null;
    const fid = edge ? null : hit?.faceId ?? null;
    this.ctxPick = { edge: edge ?? undefined, faceId: fid ?? undefined };
    if (edge) {
      items.push(["fillet", t("Fillet")], ["chamfer", t("Chamfer")]);
      const a = owner(edge.faces[0]), b = owner(edge.faces[1]);
      addOwner(a);
      if (b && b !== a) addOwner(b);
    } else if (fid != null) {
      const face = this.host.viewer.parts[0]?.data.faces[fid];
      if (face?.type === "plane") items.push(["sketch", t("Sketch")], ["normal", t("Normal to")]);
      addOwner(owner(fid));
    } else {
      // A standard or reference plane drawn in the view: select it (as in the tree) and offer Sketch, Normal to.
      const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((at.x - r.left) / r.width) * 2 - 1, -((at.y - r.top) / r.height) * 2 + 1);
      // Only off the model: a click on the body (even one the selection filter skips) never picks a plane behind it.
      const body = v.pickMeshes(ndc);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, v.camera);
      const ph = body ? undefined : rc.intersectObjects(this.planeMeshes, false)[0];
      const ref = ph?.object.userData.ref as PlaneRef | undefined;
      if (ref && ("std" in ref || "plane" in ref)) {
        this.selected = "std" in ref ? `std:${ref.std}` : ref.plane;
        this.ctxPick = { plane: ref };
        this.renderTree();
        this.drawDecor();
        items.push(["sketch", t("Sketch")], ["normal", t("Normal to")]);
      }
    }
    const seen = new Set<string>();
    const list = items.filter(([c]) => !seen.has(c) && !!seen.add(c));
    if (list.length) this.popBar("mc-cbar", t("Context toolbar"), list, at, true);
    else this.ctxPick = null;
  }

  /**
   * The selection filter bar (FR-SEL-003, F5): toggles for faces, edges and vertices that limit what a click
   * picks, in Smart measure and in the modelling commands alike. Closing the bar keeps the filter; Clear resets it.
   */
  toggleFilterBar(show = !document.getElementById("mc-filter")) {
    document.getElementById("mc-filter")?.remove();
    if (show) {
      const bar = document.createElement("div");
      bar.id = "mc-filter";
      bar.className = "mc-filter";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", t("Selection filter"));
      $("#mc-tools").after(bar);
      this.renderFilterBar();
    }
    this.renderBar();
  }

  private renderFilterBar() {
    const bar = document.getElementById("mc-filter");
    if (!bar) return;
    const items: [keyof typeof SEL_FILTER, string][] = [["faces", t("Faces")], ["edges", t("Edges")], ["vertices", t("Vertices")]];
    bar.innerHTML = `<span class="mc-filter-t">${esc(t("Selection filter"))}</span>`
      + items.map(([k, l]) => `<button data-f="${k}" aria-pressed="${SEL_FILTER[k]}" class="${SEL_FILTER[k] ? "on" : ""}" title="${esc(l)}"><span aria-hidden="true">${ICON_SVG[`sel:${k}`]}</span>${esc(l)}</button>`).join("")
      + `<button data-f="clear" title="${esc(t("Clear the filter: pick anything"))}">${esc(t("Clear"))}</button>`
      + `<button data-f="close" class="x" title="${esc(t("Close (F5)"))}" aria-label="${esc(t("Close (F5)"))}">✕</button>`;
    bar.querySelectorAll<HTMLButtonElement>("[data-f]").forEach(b => b.addEventListener("click", () => {
      const f = b.dataset.f!;
      if (f === "close") { this.toggleFilterBar(false); return; }
      if (f === "clear") { SEL_FILTER.faces = SEL_FILTER.edges = SEL_FILTER.vertices = true; }
      else {
        const k = f as keyof typeof SEL_FILTER;
        SEL_FILTER[k] = !SEL_FILTER[k];
        // Never filter everything out.
        if (!SEL_FILTER.faces && !SEL_FILTER.edges && !SEL_FILTER.vertices) SEL_FILTER[k] = true;
      }
      this.renderFilterBar();
      this.renderBar();
      bar.querySelector<HTMLElement>(`[data-f="${f}"]`)?.focus();
    }));
  }

  /** What the context toolbar was opened for: its commands act on that, not on Smart measure's first pick. */
  private ctxPick: { edge?: EdgeInfo; faceId?: number; plane?: PlaneRef } | null = null;
  private pickedEdge() { return this.ctxPick ? this.ctxPick.edge ?? null : this.host.selectedEdge?.() ?? null; }
  private pickedFace() { return this.ctxPick ? this.ctxPick.faceId ?? null : this.host.selectedFace(); }

  /** A small bar of icon buttons near a screen point; `fade` dims it as the pointer leaves. */
  private popBar(id: string, label: string, items: [string, string][], at: { x: number; y: number }, fade: boolean) {
    const bar = document.createElement("div");
    bar.id = id;
    bar.className = "mc-sbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", label);
    bar.innerHTML = items.map(([c, l]) => `<button data-c="${esc(c)}" title="${esc(l)}" aria-label="${esc(l)}"><span aria-hidden="true">${ICON_SVG[c.split(":")[0]] ?? ICON_SVG[c] ?? ""}</span></button>`).join("");
    document.body.appendChild(bar);
    const r = bar.getBoundingClientRect();
    const dx0 = fade ? 14 : -r.width / 2;
    bar.style.left = `${Math.max(4, Math.min(at.x + dx0, innerWidth - r.width - 4))}px`;
    bar.style.top = `${Math.max(4, Math.min(at.y - r.height - 12, innerHeight - r.height - 4))}px`;
    const btns = [...bar.querySelectorAll<HTMLButtonElement>("button")];
    btns.forEach(b => b.addEventListener("click", () => { this.hideShortcutBar(true); this.command(b.dataset.c!); this.ctxPick = null; }));
    bar.addEventListener("keydown", e => {
      const k = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); btns[(k + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.hideShortcutBar(); }
    });
    // It goes when the pointer moves well away from it, or on a click elsewhere.
    const away = (e: PointerEvent) => {
      const b = bar.getBoundingClientRect();
      const dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right), dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
      const d = Math.hypot(dx, dy);
      if (d > 160) this.hideShortcutBar();
      else if (fade) bar.style.opacity = String(Math.max(0.15, 1 - Math.max(0, d - 20) / 140));
    };
    const outside = (e: PointerEvent) => { if (!bar.contains(e.target as Node)) this.hideShortcutBar(); };
    window.addEventListener("pointermove", away);
    window.addEventListener("pointerdown", outside, true);
    this.sbarOff = () => { window.removeEventListener("pointermove", away); window.removeEventListener("pointerdown", outside, true); };
    // The S bar takes the focus for the keyboard; the context bar must not steal it from the view.
    if (!fade) btns[0]?.focus({ preventScroll: true });
  }

  private sbarOff: (() => void) | null = null;
  /** Removes the S bar and the context bar; `keepPick` keeps what the context bar was for (its command runs next). */
  hideShortcutBar(keepPick = false) {
    if (!keepPick) this.ctxPick = null;
    this.sbarOff?.();
    this.sbarOff = null;
    document.getElementById("mc-sbar")?.remove();
    document.getElementById("mc-cbar")?.remove();
  }

  /** The tool each sketch flyout shows (the last one picked from it). */
  private flyLast = new Map<string, string>();

  private command(c: string) {
    const m = this.mode;
    if (c.startsWith("sk:") && m.kind === "sketch") { m.editor.setTool(c.slice(3) as SkTool); this.renderBar(); return; }
    switch (c) {
      case "cons": if (m.kind === "sketch") m.editor.toggleConstruction(); break;
      case "skmirror": if (m.kind === "sketch") { m.editor.mirrorSelection(); this.renderPanel(); } break;
      case "skdxf": if (m.kind === "sketch") this.importDxf(); break;
      case "sklpat": case "skcpat": case "skmove": case "skrot": case "skscale":
        if (m.kind === "sketch" && m.editor.startPattern(({ sklpat: "linear", skcpat: "circular", skmove: "move", skrot: "rotate", skscale: "scale" } as const)[c])) this.renderPanel();
        break;
      case "exit": this.ok(); break;
      case "sketch": this.startSketch(); break;
      case "extrude": case "cut": case "revolve": case "fillet": case "chamfer": case "plane": case "axis": case "point": case "csys": case "shell": case "draft": case "mirror": case "lpattern": case "cpattern": case "hole": case "thread": case "helix": case "sweep": case "sweepcut": case "loft": case "loftcut": case "rib": case "split": case "combine": case "bsplit": case "delbody": case "movebody": case "scale": case "delface": case "moveface": case "planesurf": case "extsurf": case "offsurf": case "knit": case "thicken": case "replaceface": this.startFeature(c); break;
      case "import": this.importBodyFile(); break;
      case "undo": this.undo(); break;
      case "redo": this.redo(); break;
      case "save": void this.save(); break;
      case "step": void this.exportStep(); break;
      case "filter": this.toggleFilterBar(); break;
      case "normal": {
        const f = this.ctxPick?.faceId != null ? this.host.viewer.parts[0]?.data.faces[this.ctxPick.faceId] : undefined;
        const pl = this.ctxPick?.plane;
        const fr = pl ? ("std" in pl ? STD_FRAMES[pl.std] : "plane" in pl ? this.last?.frames[pl.plane] : undefined) : undefined;
        this.host.normalTo?.(f?.type === "plane" ? f.normal : fr ? fr.n : undefined);
        break;
      }
      default:
        if ((c.startsWith("edit:") || c.startsWith("editsk:")) && this.store?.feature(c.slice(c.indexOf(":") + 1))) this.editFeature(c.slice(c.indexOf(":") + 1));
    }
  }

  private renderStatus() {
    const st = this.last?.statuses ?? [];
    const bad = st.filter(s => !s.ok);
    const el = $("#mc-errors");
    el.hidden = !bad.length;
    el.textContent = bad.length ? t("{n} feature with errors|{n} features with errors", { n: bad.length }) : "";
    const p = this.last?.props;
    const stats = $("#st-stats");
    if (this.store && this.mode.kind !== "sketch") {
      const f = this.doc.features.length;
      stats.textContent = [t("{n} feature|{n} features", { n: f }), p ? `V ${trimNum(p.volume * UNITS[units.current].f ** 3, 3)} ${units.current}³` : t("no body"), `${t("rebuild")} ${Math.round(this.rebuildMs)} ms`].join(" · ");
    }
  }

  private renderTree() {
    const box = $("#mc-tree");
    if (!this.store) { box.innerHTML = ""; return; }
    const d = this.doc;
    const st = new Map((this.last?.statuses ?? []).map(s => [s.id, s]));
    const m = this.mode;
    const row = (id: string, icon: string, label: string, extra = "", cls = "", aria = "") =>
      `<div class="ft-row${cls}${this.selected === id ? " sel" : ""}" role="treeitem" aria-selected="${this.selected === id}"${aria} tabindex="${this.selected === id ? 0 : -1}" data-id="${esc(id)}"><span class="ft-ico" aria-hidden="true">${icon}</span><span class="ft-name" translate="no">${esc(label)}</span>${extra}</div>`;
    let html = row("part", ICONS.part, d.name, "", " ft-root");
    html += `<div class="ft-group" role="group">`;
    html += row("material", ICONS.material, d.material ? t(d.material.name) : t("Material <not specified>"), "", " ft-plane");
    html += row("configs", "◇", t("Configuration: {name}", { name: d.config ?? "Default" }), "", " ft-plane");
    html += row("equations", "Σ", d.vars?.length ? t("Equations ({n})", { n: d.vars.length }) : t("Equations"), "", " ft-plane");
    for (const std of ["XY", "XZ", "YZ"] as const) html += row(`std:${std}`, ICONS.plane, t(STD_NAMES[std]), "", " ft-plane");
    html += row("origin", "⊹", t("Origin"), "", " ft-plane");
    html += this.bodiesRows(row);
    html += `</div>`;
    const end = d.rollback ?? d.features.length;
    // A sketch used by exactly one later feature is shown under it (absorbed, FR-HIS-008).
    const users = new Map<string, number[]>();
    d.features.forEach((f, i) => { if (f.type === "extrude" || f.type === "revolve") users.set(f.sketch, [...(users.get(f.sketch) ?? []), i]); });
    const absorbed = new Map<number, number>();
    d.features.forEach((f, i) => {
      const u = users.get(f.id);
      if (f.type === "sketch" && u?.length === 1 && u[0] > i && (u[0] < end) === (i < end)) absorbed.set(i, u[0]);
    });
    // Parent/child (FR-HIS-007): with a feature selected, what it uses and what uses it are marked.
    const selF = this.selected ? d.features.find(x => x.id === this.selected) : undefined;
    const par = new Set(selF ? parents(d, selF) : []);
    const kids = new Set(selF ? d.features.filter(g => g.id !== selF.id && parents(d, g).includes(selF.id)).map(g => g.id) : []);
    const featRow = (f: Feature, i: number, child: boolean) => {
      const s = st.get(f.id);
      const rel = par.has(f.id) ? " ft-parent" : kids.has(f.id) ? " ft-child" : "";
      const relTip = par.has(f.id) ? t("Used by the selected feature") : kids.has(f.id) ? t("Uses the selected feature") : "";
      const editing = (m.kind === "sketch" && m.id === f.id) || (m.kind === "feature" && !m.isNew && m.index === i);
      const icon = f.type === "extrude" && f.op === "cut" ? ICONS.cut : ICONS[f.type];
      const badge = s && !s.ok ? `<span class="ft-err" title="${esc(statusText(s))}" role="img" aria-label="${esc(t("Error"))}: ${esc(statusText(s))}">⚠</span>`
        : s?.code === "warning" ? `<span class="ft-warn" title="${esc(statusText(s))}" role="img" aria-label="${esc(t("Warning"))}: ${esc(statusText(s))}">⚠</span>` : "";
      const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="sup" title="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}" aria-label="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}">${f.suppressed ? "◌" : "●"}</button><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
      const relMark = rel ? `<span class="ft-rel" title="${esc(relTip)}" role="img" aria-label="${esc(relTip)}">${par.has(f.id) ? "↑" : "↓"}</span>` : "";
      const ice = i < frozen ? `<span class="ft-ice" title="${esc(t("Frozen"))}" role="img" aria-label="${esc(t("Frozen"))}">❄</span>` : "";
      return row(f.id, icon, featureLabel(f.name), relMark + ice + badge + tools, `${child ? " child" : ""}${inFolder ? " infolder" : ""}${f.suppressed ? " sup" : ""}${i >= end ? " rolled" : ""}${i < frozen ? " frozen" : ""}${editing ? " editing" : ""}${s && !s.ok ? " bad" : ""}${rel}`, ` data-i="${i}" draggable="${m.kind === "none" && i >= frozen}"`);
    };
    // Folders (FR-HIS-009): a folder row comes before its first member; closed folders hide their members.
    const frozen = this.frozenCount();
    const folderOf = new Map<string, FeatureFolder>();
    for (const g of d.folders ?? []) for (const x of g.ids) folderOf.set(x, g);
    const shownFolder = new Set<string>();
    let inFolder = false;
    const freezeBar = `<div class="ft-freeze" role="separator" aria-label="${esc(t("Freeze bar"))}" title="${esc(t("Freeze bar: the features above it are not rebuilt"))}"><span>❄ ${esc(t("Freeze bar"))}</span></div>`;
    const bar = `<div class="ft-rollback" role="treeitem" tabindex="0" aria-selected="false" aria-label="${esc(t("Rollback bar: drag, or use the arrow keys"))}" title="${esc(t("Rollback bar: drag, or use the arrow keys"))}"></div>`;
    d.features.forEach((f, i) => {
      if (i === end) html += bar;
      if (i === frozen && frozen > 0) html += freezeBar;
      if (absorbed.has(i)) return;
      const g = folderOf.get(f.id);
      inFolder = !!g;
      if (g && !shownFolder.has(g.id)) {
        shownFolder.add(g.id);
        const open = !this.closedFolders.has(g.id);
        html += row(`folder:${g.id}`, open ? "▾" : "▸", g.name, `<span class="muted ft-count">${g.ids.length}</span>`, " ft-folder", ` aria-expanded="${open}"`);
      }
      if (g && this.closedFolders.has(g.id)) return;
      html += featRow(f, i, false);
      for (const [si, ui] of absorbed) if (ui === i) html += featRow(d.features[si], si, true);
    });
    if (frozen >= d.features.length && frozen > 0) html += freezeBar;
    if (end >= d.features.length) html += bar;
    box.innerHTML = html;
    // Name filter (FR-HIS-011): feature rows whose name doesn't match hide; a folder stays while a member matches.
    const q = (document.getElementById("ft-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
    if (q) {
      const keep = new Set<string>();
      for (const r of box.querySelectorAll<HTMLElement>(".ft-row[data-i]")) {
        const hit = (r.querySelector(".ft-name")?.textContent ?? "").toLowerCase().includes(q);
        r.hidden = !hit;
        const g = folderOf.get(r.dataset.id!);
        if (hit && g) keep.add(g.id);
      }
      for (const r of box.querySelectorAll<HTMLElement>(".ft-folder")) r.hidden = !keep.has(r.dataset.id!.slice(7)) && !(r.querySelector(".ft-name")?.textContent ?? "").toLowerCase().includes(q);
    }
    this.bindTree(box);
  }

  private bindTree(box: HTMLElement) {
    // Drag a feature row onto another to reorder (FR-HIS-006): the upper half drops before it, the lower half after.
    let dragId: string | null = null;
    const clearDrop = () => box.querySelectorAll(".drop-before, .drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
    box.querySelectorAll<HTMLElement>('.ft-row[draggable="true"]').forEach(r => {
      const id = r.dataset.id!;
      r.addEventListener("dragstart", e => { dragId = id; e.dataTransfer?.setData("text/plain", id); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; r.classList.add("dragging"); });
      r.addEventListener("dragend", () => { dragId = null; r.classList.remove("dragging"); clearDrop(); });
      r.addEventListener("dragover", e => {
        if (!dragId || dragId === id) return;
        e.preventDefault();
        const after = e.offsetY > r.offsetHeight / 2;
        clearDrop();
        r.classList.add(after ? "drop-after" : "drop-before");
      });
      r.addEventListener("dragleave", () => r.classList.remove("drop-before", "drop-after"));
      r.addEventListener("drop", e => {
        e.preventDefault();
        const from = dragId ?? e.dataTransfer?.getData("text/plain");
        const after = r.classList.contains("drop-after") || (!r.classList.contains("drop-before") && e.offsetY > r.offsetHeight / 2);
        clearDrop();
        if (!from || from === id) return;
        const to = this.dropIndex(from, id, after);
        if (to >= 0) this.moveFeature(from, to);
      });
    });
    box.querySelectorAll<HTMLInputElement>("input[data-bcolor]").forEach(inp => inp.addEventListener("change", () => {
      const key = inp.closest<HTMLElement>(".ft-row")!.dataset.id!.slice(5), h = inp.value;
      this.setBody(key, { color: [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as V3 });
    }));
    box.querySelectorAll<HTMLElement>(".ft-row").forEach(r => {
      const id = r.dataset.id!;
      r.addEventListener("click", e => {
        const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
        if (a === "sup") { this.toggleSuppress(id); return; }
        if (a === "del") { void this.deleteFeature(id); return; }
        if (id.startsWith("body:")) {
          const key = id.slice(5);
          if (a === "bhide") { this.setBody(key, { hidden: !this.doc.bodies?.[key]?.hidden }); return; }
          if (a === "bdel") { this.deleteBody(key); return; }
          if ((e.target as HTMLElement).matches("input")) return;
          this.selected = id;
          this.renderTree();
          return;
        }
        if ((e.target as HTMLElement).matches("input")) return;
        const mm = this.mode;
        if (mm.kind === "plane" && id.startsWith("std:")) { this.planePicked({ std: id.slice(4) as "XY" }); return; }
        if (mm.kind === "plane" && this.store!.feature(id)?.type === "plane") { this.planePicked({ plane: id }); return; }
        // Planes picked from the tree while a command needs one.
        const asRef: PlaneRef | null = id.startsWith("std:") ? { std: id.slice(4) as "XY" } : this.store!.feature(id)?.type === "plane" ? { plane: id } : null;
        if (mm.kind === "feature" && asRef && mm.draft.type === "plane" && mm.focus !== "axis" && mm.draft.id !== id) { mm.draft.base = asRef; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "extrude") {
          const tg = this.extrudeTarget(mm.draft, mm.focus), pt = this.store!.feature(id)?.type === "point" ? { point: id } : null;
          if (asRef && tg === "start-surface") { mm.draft.startRef = asRef; mm.focus = "upto"; this.draftChanged(); return; }
          if (asRef && tg === "upto") { mm.draft.upTo = asRef; this.draftChanged(); return; }
          if (pt && tg === "start-vertex") { mm.draft.startVertex = pt; mm.focus = "upto"; this.draftChanged(); return; }
          if (pt && tg === "vertex") { mm.draft.upToVertex = pt; this.draftChanged(); return; }
        }
        if (mm.kind === "feature" && mm.draft.type === "csys") {
          const ty = this.store!.feature(id)?.type;
          const fc = mm.focus ?? "origin";
          if (ty === "point" && fc === "origin") { mm.draft.origin = { point: id }; mm.focus = mm.draft.z ? "cx" : "cz"; this.draftChanged(); return; }
          if (ty === "axis" && (fc === "cx" || fc === "cz")) { if (fc === "cz") { mm.draft.z = { axis: id }; if (!mm.draft.x) mm.focus = "cx"; } else mm.draft.x = { axis: id }; this.draftChanged(); return; }
        }
        if (mm.kind === "feature" && asRef && mm.draft.type === "revolve" && mm.draft.end === "upto") { mm.draft.upTo = asRef; this.draftChanged(); return; }
        if (mm.kind === "feature" && asRef && mm.draft.type === "axis" && mm.draft.mode === "planes") { mm.draft.planes = [...(mm.draft.planes ?? []), asRef].slice(-2); this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "hole" && asRef && (mm.focus === "hplane" || !mm.draft.plane)) { mm.draft.plane = asRef; mm.draft.pts = []; mm.focus = "pts"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "draft" && asRef && (mm.focus === "nplane" || !mm.draft.plane)) { mm.draft.plane = asRef; mm.focus = "faces"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "mirror" && asRef && (mm.focus === "mplane" || !mm.draft.plane)) { mm.draft.plane = asRef; if (!mm.draft.features.length) mm.focus = "seeds"; this.draftChanged(); return; }
        if (mm.kind === "feature" && (mm.draft.type === "lpattern" || mm.draft.type === "cpattern") && (mm.focus === "dir" || mm.focus === "dir2") && this.store!.feature(id)?.type === "axis") {
          const ref: LineRef = { axis: id };
          if (mm.draft.type === "cpattern") mm.draft.axis = ref; else if (mm.focus === "dir2") mm.draft.dir2 = ref; else mm.draft.dir = ref;
          this.draftChanged();
          return;
        }
        if (mm.kind === "feature" && isCopy(mm.draft) && SEED_TYPES.has(this.store!.feature(id)?.type ?? "") && id !== mm.draft.id) { this.toggleSeed(mm.draft, id); return; }
        if (mm.kind === "feature" && (mm.draft.type === "extrude" || mm.draft.type === "revolve") && this.store!.feature(id)?.type === "sketch") {
          mm.draft.sketch = id;
          if (mm.draft.type === "revolve") { const sk = this.store!.feature(id) as SketchFeature; const ls = sk.ents.filter(x => x.t === "line"); mm.draft.axis = (ls.find(l => l.cons) ?? ls[0])?.id ?? ""; }
          this.draftChanged();
          return;
        }
        // A folder row opens or closes it.
        if (id.startsWith("folder:")) { this.toggleFolder(id.slice(7)); return; }
        // Equations is not geometry to select: a click opens it.
        if (id === "equations") { this.editEquations(); return; }
        if (id === "configs") { this.editConfigs(); return; }
        this.selected = id;
        this.renderTree();
        this.drawDecor();
      });
      r.addEventListener("dblclick", e => {
        if ((e.target as HTMLElement).matches("input")) return;
        if (id === "part" || id === "material") { this.editProps(); return; }
        if (id === "equations") { this.editEquations(); return; }
        if (id === "folder:bodies") return;
        if (id.startsWith("folder:") || id.startsWith("body:")) { if (id.startsWith("folder:")) this.toggleFolder(id.slice(7)); this.startRename(id); return; }
        if (this.store!.feature(id)) this.editFeature(id);
      });
      r.addEventListener("contextmenu", e => { e.preventDefault(); this.selected = id; this.renderTree(); this.drawDecor(); this.openMenu(id, e.clientX, e.clientY); });
      r.addEventListener("keydown", e => {
        if ((e.target as HTMLElement).matches("input")) return;
        const rows = [...box.querySelectorAll<HTMLElement>(".ft-row")];
        const i = rows.indexOf(r);
        const go = (n: HTMLElement) => { n.focus(); this.selected = n.dataset.id!; rows.forEach(x => x.classList.toggle("sel", x === n)); this.drawDecor(); };
        if (!e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); go(rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]); }
        else if (e.key === "Home" || e.key === "End") { e.preventDefault(); go(rows[e.key === "Home" ? 0 : rows.length - 1]); }
        else if (e.key === "Enter" && (id === "part" || id === "material")) { e.preventDefault(); this.editProps(); }
        else if (e.key === "Enter" && id === "equations") { e.preventDefault(); this.editEquations(); }
        else if (e.key === "Enter" && id === "configs") { e.preventDefault(); this.editConfigs(); }
        else if (id.startsWith("folder:") && (e.key === "Enter" || (e.key === "ArrowLeft") === !this.closedFolders.has(id.slice(7)) && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) { e.preventDefault(); this.toggleFolder(id.slice(7)); $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`)?.focus(); }
        else if (id.startsWith("folder:") && e.key === "F2") { e.preventDefault(); this.startRename(id); }
        else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && this.store!.feature(id)) {
          // Alt+↑/↓ moves the feature past its neighbour (keyboard reorder).
          e.preventDefault();
          e.stopPropagation();
          const fs = this.doc.features;
          const i = fs.findIndex(x => x.id === id);
          const nb = fs[i + (e.key === "ArrowUp" ? -1 : 1)];
          if (nb) { const to = this.dropIndex(id, nb.id, e.key === "ArrowDown"); if (to >= 0 && this.moveFeature(id, to)) $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${id}"]`)?.focus(); }
          return;
        }
        else if (e.key === "Enter" && this.store!.feature(id)) { e.preventDefault(); this.editFeature(id); }
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const b = r.getBoundingClientRect(); this.openMenu(id, b.left + 30, b.bottom); }
      });
    });
    // The rollback bar: drag it between rows, or move it with the arrow keys (FR-HIS-005).
    const bar = box.querySelector<HTMLElement>(".ft-rollback");
    if (!bar) return;
    const n = this.doc.features.length;
    const cur = this.doc.rollback ?? n;
    bar.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this.setRollback(Math.max(0, Math.min(n, cur + (e.key === "ArrowDown" ? 1 : -1))));
        setTimeout(() => $("#mc-tree").querySelector<HTMLElement>(".ft-rollback")?.focus(), 0);
      } else if (e.key === "End") { e.preventDefault(); this.setRollback(null); }
    });
    bar.addEventListener("pointerdown", e => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("drag");
      const rows = [...box.querySelectorAll<HTMLElement>(".ft-row[data-i]")];
      let target = cur;
      const move = (ev: PointerEvent) => {
        // The bar goes before the first feature row whose middle is below the pointer.
        target = n;
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) { target = Math.min(target, +r.dataset.i!); break; }
        }
        rows.forEach(r => r.classList.toggle("drop-target", +r.dataset.i! === target && !r.classList.contains("child")));
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.classList.remove("drag");
        rows.forEach(r => r.classList.remove("drop-target"));
        this.setRollback(target);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  }

  // ---------- context menu and rename ----------

  private openMenu(id: string, x: number, y: number) {
    if (!this.store) return;
    const f = this.store.feature(id);
    const i = this.doc.features.findIndex(g => g.id === id);
    const end = this.doc.rollback ?? this.doc.features.length;
    const items: ([string, () => void] | null)[] = [];
    if (id === "part" || id === "material") items.push([t("Properties…"), () => this.editProps()]);
    if (id.startsWith("body:")) {
      const key = id.slice(5);
      items.push([this.doc.bodies?.[key]?.hidden ? t("Show body") : t("Hide body"), () => this.setBody(key, { hidden: !this.doc.bodies?.[key]?.hidden })]);
      items.push([t("Rename"), () => this.startRename(id)]);
      if (this.doc.bodies?.[key]?.color) items.push([t("Reset colour"), () => this.setBody(key, { color: undefined })]);
      items.push([t("Delete body"), () => this.deleteBody(key)]);
    }
    if (id.startsWith("folder:") && id !== "folder:bodies") {
      items.push([t("Rename"), () => this.startRename(id)]);
      items.push([t("Delete folder (keep features)"), () => this.deleteFolder(id.slice(7))]);
    }
    if (id.startsWith("std:") || f?.type === "plane") items.push([t("Sketch on this plane"), () => void this.createSketch(id.startsWith("std:") ? { std: id.slice(4) as "XY" } : { plane: id })]);
    if (id.startsWith("std:")) items.push([(this.doc.stdHidden ?? []).includes(id.slice(4) as "XY") ? t("Show") : t("Hide"), () => this.toggleHidden(id)]);
    if (f?.type === "sketch") items.push([this.sketchShown(f) ? t("Hide") : t("Show"), () => this.toggleHidden(f.id)]);
    if (f) {
      items.push([f.type === "sketch" ? t("Edit sketch") : t("Edit feature"), () => this.editFeature(f.id)]);
      if (f.type === "extrude" || f.type === "revolve") items.push([t("Edit sketch"), () => void this.editSketch(f.sketch)]);
      if (f.type === "sketch") items.push([t("Edit sketch plane"), () => this.editSketchPlane(f.id)]);
      items.push([t("Rename"), () => this.startRename(f.id)]);
      items.push([f.suppressed ? t("Unsuppress") : t("Suppress"), () => this.toggleSuppress(f.id)]);
      if (f.type === "plane" || f.type === "axis" || f.type === "point" || f.type === "csys" || f.type === "helix") items.push([f.hidden ? t("Show") : t("Hide"), () => this.toggleHidden(f.id)]);
      if (f.type === "csys") items.push(csys.active?.src === f.id ? [t("Back to the global coordinate system"), () => this.useCsys(null)] : [t("Use for measurements and export"), () => this.useCsys(f.id)]);
      items.push(null);
      items.push([t("Roll back to here"), () => this.setRollback(i)]);
      if (i < end - 1 || i >= end) items.push([t("Roll forward past this"), () => this.setRollback(i + 1)]);
      if (this.doc.rollback != null) items.push([t("Roll to end"), () => this.setRollback(null)]);
      items.push([t("Freeze up to here"), () => this.setFreeze(f.id)]);
      if (this.doc.freezeAfter) items.push([t("Unfreeze all"), () => this.setFreeze(null)]);
      items.push(null);
      // Folders: a new one, the neighbour's (the row above or below), or out of its folder.
      const fd = this.doc.folders ?? [];
      const mine = fd.find(g => g.ids.includes(f.id));
      items.push([t("Add to new folder"), () => this.addToFolder(f.id, null)]);
      for (const nb of [this.doc.features[i - 1], this.doc.features[i + 1]]) {
        const g = nb && fd.find(x => x.ids.includes(nb.id));
        if (g && g !== mine && !items.some(it => it?.[0] === t("Add to {name}", { name: g.name }))) items.push([t("Add to {name}", { name: g.name }), () => this.addToFolder(f.id, g.id)]);
      }
      if (mine) items.push([t("Remove from folder"), () => this.removeFromFolder(f.id)]);
      items.push(null);
      items.push([t("Delete"), () => void this.deleteFeature(f.id)]);
    }
    if (!items.length) return;
    this.showMenu(items, x, y, () => $("#mc-tree").querySelector<HTMLElement>(".ft-row.sel")?.focus());
  }

  /** A pop-up menu at x, y; Esc or Tab closes it and calls `back` (focus returns there). */
  private showMenu(items: ([string, () => void, string?] | null)[], x: number, y: number, back: () => void) {
    const menu = $("#mc-menu");
    menu.innerHTML = items.map((it, k) => (it ? `<button role="menuitem" tabindex="-1" data-k="${k}">${it[2] ? `<span class="mc-i" aria-hidden="true">${it[2]}</span>` : ""}${esc(it[0])}</button>` : `<hr role="separator" />`)).join("");
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    const btns = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    btns.forEach(b => b.addEventListener("click", () => { this.closeMenu(); items[+b.dataset.k!]![1](); }));
    menu.onkeydown = e => {
      const k = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); btns[(k + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length].focus(); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); this.closeMenu(); back(); }
    };
    btns[0]?.focus();
  }

  private closeMenu() { const m = document.getElementById("mc-menu"); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ""; } }

  /** Rename in place (F2, or the menu). */
  /** A body's name in the Bodies folder: the user's, else the feature that made it (with [k] for its later bodies). */
  bodyName(key: string): string {
    const own = this.doc.bodies?.[key]?.name;
    if (own) return own;
    const [id, k] = key.split("#");
    const f = this.store?.feature(id);
    return `${f ? featureLabel(f.name) : t("Body")}${k ? `[${k}]` : ""}`;
  }

  /** The Solid Bodies folder (FR-BODY-001): one row per body with show/hide, colour and delete. */
  private bodiesRows(row: (id: string, icon: string, label: string, extra?: string, cls?: string, aria?: string) => string): string {
    const list = this.last?.bodies ?? [];
    if (!list.length) return "";
    const open = !this.closedFolders.has("bodies");
    let html = row("folder:bodies", open ? "▾" : "▸", t("Solid Bodies ({n})", { n: list.length }), "", " ft-bodies", ` aria-expanded="${open}"`);
    if (!open) return html;
    const st = this.doc.bodies ?? {};
    const hex = (c?: V3) => "#" + (c ?? this.doc.color ?? DEFAULT_COLOR).map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("");
    for (const b of list) {
      const hidden = !!st[b.key]?.hidden, name = this.bodyName(b.key);
      const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="bhide" title="${esc(hidden ? t("Show body") : t("Hide body"))}" aria-label="${esc(hidden ? t("Show body") : t("Hide body"))}: ${esc(name)}">${hidden ? "◌" : "◉"}</button>`
        + `<input type="color" class="ft-color" tabindex="-1" data-bcolor value="${hex(st[b.key]?.color)}" title="${esc(t("Body colour"))}" aria-label="${esc(t("Body colour"))}: ${esc(name)}" />`
        + `<button class="icon" tabindex="-1" data-a="bdel" title="${esc(t("Delete body"))}" aria-label="${esc(t("Delete body"))}: ${esc(name)}">✕</button></span>`;
      html += row(`body:${b.key}`, "▣", name, tools, ` infolder ft-body${hidden ? " sup" : ""}`);
    }
    return html;
  }

  /** Bodies folder actions: show/hide and colour are display state (one undo step each), delete adds a Body-Delete feature. */
  setBody(key: string, ch: { name?: string; hidden?: boolean; color?: V3 }) {
    if (!this.store) return;
    this.store.change(ch.hidden != null ? (ch.hidden ? "Hide body" : "Show body") : "color" in ch ? "Body colour" : "Rename body", d => {
      const cur = { ...(d.bodies?.[key] ?? {}), ...ch };
      if (!cur.hidden) delete cur.hidden;
      if (!cur.name) delete cur.name;
      if (!cur.color) delete cur.color;
      d.bodies = { ...(d.bodies ?? {}), [key]: cur };
      if (!Object.keys(cur).length) delete d.bodies[key];
      if (!Object.keys(d.bodies).length) delete d.bodies;
    });
    this.renderTree();
    void this.rebuild();
  }

  deleteBody(key: string) {
    const b = this.last?.bodies?.find(x => x.key === key);
    if (!this.store || !b) return;
    const d = this.doc, id = uid("f_"), name = nextName(d, "delbody");
    const feat: DeleteBodyFeature = { id, type: "delbody", name, bodies: [b.ref] };
    this.store.change(`Add ${name}`, x => { const at = x.rollback ?? x.features.length; x.features.splice(at, 0, feat); if (x.rollback != null) x.rollback++; });
    this.renderAll();
    void this.rebuild();
  }

  private toggleFolder(fid: string) {
    if (this.closedFolders.has(fid)) this.closedFolders.delete(fid); else this.closedFolders.add(fid);
    this.selected = `folder:${fid}`;
    this.renderTree();
  }

  startRename(id: string) {
    const folder = id.startsWith("folder:") ? this.doc.folders?.find(g => `folder:${g.id}` === id) : undefined;
    const body = id.startsWith("body:") ? id.slice(5) : null;
    const f = this.store?.feature(id);
    const row = $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`);
    const name = row?.querySelector<HTMLElement>(".ft-name");
    if ((!f && !folder && !body) || !row || !name) return;
    const inp = document.createElement("input");
    inp.className = "ft-ren";
    inp.value = folder ? folder.name : body ? this.bodyName(body) : featureLabel(f!.name);
    inp.setAttribute("aria-label", t("New name"));
    inp.setAttribute("translate", "no");
    name.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      if (apply) this.rename(id, inp.value);
      this.renderTree();
      $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`)?.focus();
    };
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  // ---------- property panel ----------

  private renderPanel() {
    const pm = $("#mc-pm");
    const m = this.mode;
    if (!this.store || m.kind === "none") { pm.hidden = true; pm.innerHTML = ""; return; }
    pm.hidden = false;
    const head = (title: string, help: string) => `<div class="pm-head"><h3>${esc(title)}</h3></div><p class="pm-help muted">${esc(help)}</p>`;
    if (m.kind === "plane") {
      const ed = m.edit, sk = ed ? this.store.feature(ed.id) : undefined;
      pm.innerHTML = (ed ? head(t("Sketch plane"), t("Pick another plane or flat face for {name}. The sketch keeps its shape; relations to model edges that no longer resolve become dangling.", { name: featureLabel(sk?.name ?? "") }))
        + `<p class="pm-help"><b>${esc(t("Plane"))}:</b> <span data-a="cur" translate="no">${esc(this.refLabel(ed.plane))}</span></p>`
        : head(t("Sketch"), t("Pick a plane or a flat face for the sketch.")))
        + `<div class="pm-planes">${(["XY", "XZ", "YZ"] as const).map(s => `<button class="btn small" data-std="${s}">${esc(t(STD_NAMES[s]))}</button>`).join("")}</div>`
        + (ed ? `<div class="pm-actions"><button class="btn primary small" data-a="ok">✓ ${esc(t("OK"))}</button><button class="btn small" data-a="cancel">✕ ${esc(t("Cancel"))}</button></div>` : "");
      pm.querySelectorAll<HTMLElement>("[data-std]").forEach(b => b.addEventListener("click", () => this.planePicked({ std: b.dataset.std as "XY" })));
      pm.querySelector("[data-a=ok]")?.addEventListener("click", () => this.ok());
      pm.querySelector("[data-a=cancel]")?.addEventListener("click", () => void this.cancel());
      return;
    }
    if (m.kind === "sketch") { this.renderSketchPanel(pm, m.editor); return; }
    if (m.kind === "props") { this.renderPropsPanel(pm, m.draft); return; }
    if (m.kind === "eq") { this.renderEqPanel(pm, m.draft); return; }
    if (m.kind === "cfg") { this.renderCfgPanel(pm); return; }
    const f = m.draft;
    const sketches = this.doc.features.slice(0, m.index).filter((x): x is SketchFeature => x.type === "sketch");
    const unit = units.current;
    const numField = (key: string, label: string, n: Num, q: "length" | "angle") => {
      const shown = n.expr ?? (q === "angle" ? trimNum((n.v * 180) / Math.PI, 4) : trimNum(n.v * UNITS[unit].f, 6));
      return `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-num="${key}" data-q="${q}" value="${esc(shown)}" spellcheck="false" /><span class="muted">${q === "angle" ? "°" : unit}</span></span></label>`;
    };
    const sketchSel = (cur: string) => `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${sketches.map(s => `<option value="${s.id}"${s.id === cur ? " selected" : ""}>${esc(featureLabel(s.name))}</option>`).join("")}</select></label>`;
    const name = `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-k="name" value="${esc(featureLabel(f.name))}" spellcheck="false" translate="no" /></label>`;
    const status = (f.type === "fillet" || f.type === "chamfer") ? this.last?.preview?.status as FeatureStatus | undefined : this.last?.statuses.find(s => s.id === f.id);
    const err = status && !status.ok ? `<p class="pm-err" role="alert">⚠ ${esc(statusText(status))}</p>` : "";
    let body = "";
    let title = "";
    // PropertyManager-style group boxes (FR-UI-040).
    const group = (legend: string, inner: string, extra = "") => `<fieldset class="pm-group"${extra}><legend>${esc(legend)}</legend>${inner}</fieldset>`;
    const chk = (k: string, on: boolean | undefined, label: string) => `<label class="chk pm-chk"><input type="checkbox" data-k="${k}"${on ? " checked" : ""} />${esc(label)}</label>`;
    const opSel = (op: string) => `<label class="pm-field"><span>${esc(t("Operation"))}</span><select data-k="op"><option value="boss"${op === "boss" ? " selected" : ""}>${esc(t("Add material"))}</option><option value="cut"${op === "cut" ? " selected" : ""}>${esc(t("Remove material"))}</option></select></label>`;
    if (f.type === "extrude") {
      title = f.op === "cut" ? t("Cut") : t("Extrude");
      const ends: [string, string][] = [["blind", t("Blind")], ["mid", t("Mid plane")], ["through", t("Through all")], ...(f.op === "cut" ? [["through2", t("Through all - both")] as [string, string]] : []), ["next", t("Up to next")], ["vertex", t("Up to vertex")], ["upto", t("Up to face or plane")], ["offset", t("Offset from surface")]];
      const tg = this.extrudeTarget(f, m.focus);
      const starts: [string, string][] = [["sketch", t("Sketch plane")], ["offset", t("Offset")], ["surface", t("Surface/Face/Plane")], ["vertex", t("Vertex")]];
      const startSel = `<label class="pm-field"><span>${esc(t("Start from"))}</span><select data-k="start">${starts.map(([v, l]) => `<option value="${v}"${(f.start ?? "sketch") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
        + (f.start === "offset" ? numField("startOffset", t("Start offset"), f.startOffset ?? { v: 10 }, "length") + chk("startReverse", f.startReverse, t("Reverse direction")) : "")
        + (f.start === "surface" || f.start === "vertex" ? `<div class="pm-field"><span>${esc(t("Start at"))}</span><button class="pm-box${tg?.startsWith("start") ? " focus" : ""}" data-focus="start" translate="no">${esc(f.start === "surface" ? this.refLabel(f.startRef) : this.vertexLabel(f.startVertex))}</button></div>` : "");
      const endSel = `<label class="pm-field"><span>${esc(t("End condition"))}</span><select data-k="end">${ends.map(([v, l]) => `<option value="${v}"${f.end === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
      const upto = f.end === "upto" || f.end === "offset";
      const thinSel = f.thin ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="thinMode">${([["inside", t("Inside the profile")], ["outside", t("Outside the profile")], ["mid", t("Mid-plane")]] as const).map(([v, l]) => `<option value="${v}"${f.thin!.mode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` + numField("thin.t", t("Thickness"), f.thin.t, "length") : "";
      body = group(t("From"), sketchSel(f.sketch) + opSel(f.op) + (f.op === "boss" && this.last?.data ? chk("merge", f.merge !== false, t("Merge result")) : "") + startSel)
        + group(t("Direction 1"), endSel
          + (upto ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "upto" ? " focus" : ""}" data-k="focus-upto" data-focus="upto" aria-label="${esc(t("Up to"))}: ${esc(this.refLabel(f.upTo))}" translate="no">${esc(this.refLabel(f.upTo))}</button></div><p class="pm-help muted">${esc(t("Click a flat face or a plane in the view or the tree."))}</p>` : "")
          + (f.end === "vertex" ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "vertex" ? " focus" : ""}" data-focus="upto" translate="no">${esc(this.vertexLabel(f.upToVertex))}</button></div><p class="pm-help muted">${esc(t("Click near the end of an edge, or a reference point in the tree."))}</p>` : "")
          + (f.end === "next" ? `<p class="pm-help muted">${esc(t("Stops at the next face the profile meets."))}</p>` : "")
          + (f.end === "offset" ? numField("upToOffset", t("Offset distance"), f.upToOffset ?? { v: 5 }, "length") + chk("reverseOffset", f.reverseOffset, t("Reverse offset")) : "")
          + (f.end === "through" || f.end === "through2" || f.end === "next" || f.end === "vertex" || upto ? "" : numField("depth", t("Depth"), f.depth, "length"))
          + (upto || f.end === "vertex" ? "" : chk("flip", f.flip, t("Reverse direction")))
          + (f.op === "cut" ? chk("outside", f.outside, t("Flip side to cut (keep inside the profile)")) : "")
          + (f.end === "blind" || f.end === "mid" ? chk("draftOn", !!f.draft, t("Draft on/off")) + (f.draft ? numField("draft.angle", t("Draft angle"), f.draft.angle, "angle") + chk("draftOut", f.draft.outward, t("Draft outward")) : "") : "")
          + (f.end === "blind" || f.end === "mid" ? `<p class="pm-help muted">${esc(t("Or drag the orange arrow in the view."))}</p>` : ""))
        + (f.end === "blind" ? group(t("Direction 2"), chk("dir2", !!(f.depth2 && f.depth2.v > 0), t("Direction 2")) + (f.depth2 && f.depth2.v > 0 ? numField("depth2", t("Depth 2"), f.depth2, "length") : "")) : "")
        + group(t("Thin feature"), chk("thinOn", !!f.thin, t("Thin feature")) + thinSel);
    } else if (f.type === "revolve") {
      title = t("Revolve");
      const sk = this.store.feature(f.sketch) as SketchFeature | undefined;
      const lines = sk?.ents.filter(e => e.t === "line") ?? [];
      const rvEnd = f.end === "upto" ? "upto" : f.mid ? "mid" : "blind";
      body = group(t("Axis of revolution"), `<label class="pm-field"><span>${esc(t("Axis"))}</span><select data-k="axis">${lines.map((l, i) => `<option value="${l.id}"${l.id === f.axis ? " selected" : ""}>${esc(t("Line {n}", { n: i + 1 }))}${l.cons ? ` (${esc(t("construction"))})` : ""}</option>`).join("")}</select></label>`)
        + group(t("Direction 1"), `<label class="pm-field"><span>${esc(t("Revolve type"))}</span><select data-k="rvEnd">${([["blind", t("Blind")], ["mid", t("Mid plane")], ["upto", t("Up to face or plane")]] as const).map(([v, l]) => `<option value="${v}"${rvEnd === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
          + (rvEnd === "upto" ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box focus" data-k="focus-upto" aria-label="${esc(t("Up to"))}: ${esc(this.refLabel(f.upTo))}" translate="no">${esc(this.refLabel(f.upTo))}</button></div><p class="pm-help muted">${esc(t("Click a flat face or a plane through the axis, in the view or the tree."))}</p>`
            : numField("angle", t("Angle"), f.angle, "angle"))
          + chk("flip", f.flip, t("Reverse direction")) + (rvEnd === "upto" ? "" : `<p class="pm-help muted">${esc(t("Or drag the orange handle in the view."))}</p>`))
        + (rvEnd === "blind" ? group(t("Direction 2"), chk("dir2", !!(f.angle2 && f.angle2.v > 0), t("Direction 2")) + (f.angle2 && f.angle2.v > 0 ? numField("angle2", t("Angle 2"), f.angle2, "angle") : "")) : "")
        + group(t("Profile"), sketchSel(f.sketch) + opSel(f.op) + (f.op === "boss" && this.last?.data ? chk("merge", f.merge !== false, t("Merge result")) : ""))
        + group(t("Thin feature"), chk("thinOn", !!f.thin, t("Thin feature")) + (f.thin ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="thinMode">${([["inside", t("Inside the profile")], ["outside", t("Outside the profile")], ["mid", t("Mid-plane")]] as const).map(([v, l]) => `<option value="${v}"${f.thin!.mode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` + numField("thin.t", t("Thickness"), f.thin.t, "length") : ""));
    } else if (f.type === "fillet" || f.type === "chamfer") {
      title = f.type === "fillet" ? t("Fillet") : t("Chamfer");
      const cm = f.type === "chamfer" ? f.mode ?? "equal" : "equal";
      const multi = f.type === "fillet" && !!f.multi;
      const vari = f.type === "fillet" && !!f.variable;
      const rIn = (key: string, i: number, v: number, label: string) => `<span class="pm-in"><input type="text" inputmode="decimal" data-${key}="${i}" value="${esc(trimNum(v * UNITS[unit].f, 6))}" aria-label="${esc(label)} ${esc(t("Edge {n}", { n: i + 1 }))}" spellcheck="false" /><span class="muted">${unit}</span></span>`;
      const fu = UNITS[unit].f;
      const items = `<ul class="pm-items" aria-label="${esc(t("Edges"))}">${f.edges.map((e, i) => `<li><span>${esc(t("Edge {n}", { n: i + 1 }))}</span>${vari ? rIn("er", i, (e as { r?: number }).r ?? (f as FilletFeature).radius.v, t("Start radius")) + rIn("er2", i, (e as { r2?: number; r?: number }).r2 ?? (e as { r?: number }).r ?? (f as FilletFeature).radius.v, t("End radius")) : ""}${multi ? `<span class="pm-in"><input type="text" inputmode="decimal" data-er="${i}" value="${esc(trimNum(((e as { r?: number }).r ?? (f as FilletFeature).radius.v) * fu, 6))}" aria-label="${esc(t("Radius"))} ${esc(t("Edge {n}", { n: i + 1 }))}" spellcheck="false" /><span class="muted">${unit}</span></span>` : ""}<button class="icon" data-rm="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(t("Edge {n}", { n: i + 1 }))}">✕</button></li>`).join("")}</ul>`
        + (f.edges.length ? `<button class="btn small" data-k="clear">${esc(t("Clear edges"))}</button>` : `<p class="pm-help muted">${esc(t("click edges or faces in the view"))}</p>`);
      const sizes = (f.type === "chamfer" ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mode"><option value="equal"${cm === "equal" ? " selected" : ""}>${esc(t("Equal distance"))}</option><option value="two"${cm === "two" ? " selected" : ""}>${esc(t("Two distances"))}</option><option value="angle"${cm === "angle" ? " selected" : ""}>${esc(t("Distance and angle"))}</option></select></label>` : "")
        + (f.type === "fillet" ? numField("radius", multi ? t("Default radius") : t("Radius"), f.radius, "length") + chk("multi", f.multi, t("Multiple radius fillet")) + chk("variable", f.variable, t("Variable radius fillet")) + (multi ? `<p class="pm-help muted">${esc(t("Type each edge's radius in the list, or click its callout in the view."))}</p>` : "") + (vari ? `<p class="pm-help muted">${esc(t("Each edge goes from its start radius (a) to its end radius (b): type them in the list or click the callouts at the edge ends."))}</p>` : "") : numField("distance", t("Distance"), f.distance, "length"))
        + (f.type === "chamfer" && cm === "two" ? numField("distance2", t("Distance 2"), f.distance2 ?? { v: f.distance.v }, "length") : "")
        + (f.type === "chamfer" && cm === "angle" ? numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 4 }, "angle") : "")
        + (f.type === "chamfer" && cm !== "equal" ? chk("flip", f.flip, t("Flip direction")) : "");
      const kindSel = f.type === "fillet" ? group(t("Fillet type"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="kind">${([["edge", t("Edge fillet")], ["face", t("Face fillet")], ["full", t("Full round fillet")]] as const).map(([v, l]) => `<option value="${v}"${(f.kind ?? "edge") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`) : "";
      if (f.type === "fillet" && f.kind) {
        const fbox = (fc: Focus, label: string, n: number) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === fc ? " focus" : ""}" data-focus="${fc}" translate="no">${esc(n ? t("{n} face|{n} faces", { n }) : t("None"))}</button></div>`;
        const full = f.kind === "full";
        body = kindSel + group(t("Items to fillet"), fbox("fs1", full ? t("Side face set 1") : t("Face set 1"), f.faces1?.length ?? 0)
            + (full ? fbox("fc", t("Center face set"), f.center?.length ?? 0) : "")
            + fbox("fs2", full ? t("Side face set 2") : t("Face set 2"), f.faces2?.length ?? 0)
            + `<button class="btn small" data-k="clearSets">${esc(t("Clear selections"))}</button>`
            + `<p class="pm-help muted">${esc(full ? t("Pick the faces on one side, the centre faces between them, then the faces on the other side. The centre becomes a half round touching both sides.") : t("Pick the faces of set 1, then set 2: the edges where they meet are rounded."))}</p>`)
          + (full ? "" : group(t("Fillet parameters"), numField("radius", t("Radius"), f.radius, "length")));
      } else
      body = kindSel + group(f.type === "fillet" ? t("Items to fillet") : t("Items to chamfer"), `<p class="pm-count">${esc(t("{n} edge|{n} edges", { n: f.edges.length }))}</p>` + items)
        + group(f.type === "fillet" ? t("Fillet parameters") : t("Chamfer parameters"), sizes)
        + group(f.type === "fillet" ? t("Fillet options") : t("Chamfer options"), `<label class="chk pm-chk"><input type="checkbox" data-ui="tangent"${this.tangentProp ? " checked" : ""} />${esc(t("Tangent propagation"))}</label>` + (f.type === "fillet" ? chk("keepFit", f.keepFit, t("Keep features that fit (skip edges that fail)")) : ""));
    }
    if (f.type === "axis" || f.type === "point") {
      title = f.type === "axis" ? t("Axis") : t("Point");
      const opts: [string, string][] = f.type === "axis"
        ? [["edge", t("Straight edge")], ["cylinder", t("Cylindrical or conical face")], ["planes", t("Two planes")]]
        : [["vertex", t("Vertex")], ["centre", t("Arc centre")], ["face", t("Centre of face")], ["mid", t("Midpoint of edge")]];
      const picked = f.type === "axis" && f.mode === "planes" ? (f.planes ?? []).map(p => this.refLabel(p)).join(", ") || t("None")
        : (f.type === "axis" && f.mode === "cylinder") || (f.type === "point" && f.mode === "face") ? (f.face ? t("Face picked") : t("None"))
        : f.edge ? t("Edge picked") : t("None");
      const help = f.type === "axis" && f.mode === "planes" ? t("Click two planes or flat faces in the view or the tree.")
        : (f.type === "axis" && f.mode === "cylinder") || (f.type === "point" && f.mode === "face") ? t("Click a face of the model.")
        : f.type === "point" && f.mode === "vertex" ? t("Click an edge near the end you want.") : t("Click an edge of the model.");
      body = group(t("Selections"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mode">${opts.map(([v, l]) => `<option value="${v}"${f.mode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
        + `<div class="pm-field"><span>${esc(t("Reference"))}</span><button class="pm-box focus" data-k="focus-ref" translate="no">${esc(picked)}</button></div>`)
        + `<p class="pm-help muted">${esc(help)}</p>`;
    }
    if (f.type === "csys") {
      title = t("Coordinate system");
      const fc = m.focus ?? "origin";
      const box = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${fc === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      body = group(t("Selections"), box("origin", t("Origin"), f.origin ? this.vertexLabel(f.origin) : t("Part origin"))
          + box("cx", t("X axis"), f.x ? this.lineLabel(f.x) : t("Global X")) + chk("flipX", f.flipX, t("Reverse X direction"))
          + box("cz", t("Z axis"), f.z ? this.lineLabel(f.z) : t("Global Z")) + chk("flipZ", f.flipZ, t("Reverse Z direction")))
        + `<p class="pm-help muted">${esc(fc === "origin" ? t("Click near the end of an edge, or a reference point in the tree.") : t("Click a straight or round edge, a flat or round face, or an axis in the tree."))}</p>`
        + `<p class="pm-help muted">${esc(t("Right-click it in the tree to use it for measurements, mass properties and mesh export."))}</p>`;
    }
    if (f.type === "thread") {
      title = f.modelled ? t("Thread") : t("Cosmetic thread");
      const sizes: [string, string][] = [["", t("Custom")], ...ISO_METRIC.map(h => [h.size, h.size] as [string, string])];
      body = group(t("Thread settings"), `<div class="pm-field"><span>${esc(t("Edge"))}</span><button class="pm-box focus" translate="no">${esc(f.edge ? t("Edge picked") : t("None"))}</button></div>`
          + `<p class="pm-help muted">${esc(f.edge ? (f.internal ? t("Internal thread (in a hole)") : t("External thread (on a shaft)")) : t("Click a round edge of a cylinder."))}</p>`
          + `<label class="pm-field"><span>${esc(t("Size"))}</span><select data-k="size">${sizes.map(([v, l]) => `<option value="${v}"${(f.size ?? "") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
          + numField("diameter", f.internal ? t("Major diameter") : t("Minor diameter"), f.diameter, "length")
          + chk("upToEnd", f.upToEnd, t("Up to the end of the cylinder"))
          + (f.upToEnd ? "" : numField("length", t("Length"), f.length, "length"))
          + (f.pitch ? `<p class="pm-help muted">${esc(t("Pitch {p} mm", { p: trimNum(f.pitch, 3) }))}</p>` : "")
          + chk("modelled", f.modelled, t("Modelled (helical) thread"))
          + (f.modelled ? `<p class="pm-help muted">${esc(t("Cuts the real thread form into the body, for 3D printing. Slower to rebuild than a cosmetic thread."))}</p>` : ""));
    }
    if (f.type === "hole") {
      title = t("Hole");
      const sel = (k: string, label: string, opts: [string, string][], cur: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
      const hbox = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      const favs = loadFavs();
      body = group(t("Favourites"), `<label class="pm-field"><span>${esc(t("Favourite"))}</span><select data-ui="fav"><option value="">${esc(t("None"))}</option>${favs.map((x, i) => `<option value="${i}" translate="no">${esc(x.name)}</option>`).join("")}</select></label>`
          + `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-ui="favName" value="${esc(holeTitle(f))}" spellcheck="false" translate="no" /></label>`
          + `<div class="pm-rels"><button class="btn small" data-ui="favSave">${esc(t("Save as favourite"))}</button>${favs.length ? `<button class="btn small" data-ui="favDel">${esc(t("Delete favourite"))}</button>` : ""}</div>`)
        + group(t("Hole type"), sel("kind", t("Type"), [["simple", t("Simple hole")], ["cbore", t("Counterbore")], ["csink", t("Countersink")], ["tapped", t("Tapped hole")], ["insert", t("Heat-set insert")]], f.kind)
          + sel("size", t("Size"), [["", t("Custom")], ...(f.kind === "insert" ? HEAT_INSERTS : ISO_METRIC).map(h => [h.size, h.size] as [string, string])], f.size ?? "")
          + (f.kind === "insert" && insertSize(f.size) ? `<p class="pm-help muted" data-insert>${esc(t("Insert length {l} mm; keep at least {w} mm of wall around the hole (boss Ø {b} mm).", { l: trimNum(insertSize(f.size)!.length, 2), w: trimNum(insertSize(f.size)!.wall, 2), b: trimNum(insertSize(f.size)!.hole + 2 * insertSize(f.size)!.wall, 2) }))}</p>` : "")
          + (f.kind !== "tapped" && f.kind !== "insert" && f.size ? sel("fit", t("Clearance fit"), [["close", t("Close fit")], ["normal", t("Normal fit")], ["loose", t("Loose fit")]], f.fit ?? "normal") : ""))
        + group(t("Hole specification"), numField("diameter", f.kind === "tapped" ? t("Tap drill diameter") : t("Diameter"), f.diameter, "length")
          + (f.kind === "cbore" ? numField("cbDia", t("Counterbore diameter"), f.cbDia ?? { v: f.diameter.v * 1.7 }, "length") + numField("cbDepth", t("Counterbore depth"), f.cbDepth ?? { v: f.diameter.v }, "length") : "")
          + (f.kind === "csink" ? numField("csDia", t("Countersink diameter"), f.csDia ?? { v: f.diameter.v * 2 }, "length") + numField("csAngle", t("Countersink angle"), f.csAngle ?? { v: Math.PI / 2 }, "angle") : "")
          + (f.kind === "tapped" ? numField("threadDepth", t("Thread depth"), f.threadDepth ?? { v: f.diameter.v * 2 }, "length") : ""))
        + group(t("End condition"), sel("end", t("End condition"), [["blind", t("Blind")], ["through", t("Through all")]], f.end)
          + (f.end === "blind" ? numField("depth", t("Depth"), f.depth, "length") + chk("flat", f.flat, t("Flat bottom (no drill point)")) : ""))
        + group(t("Positions"), hbox("hplane", t("Face"), this.refLabel(f.plane)) + hbox("pts", t("Hole positions"), t("{n} hole|{n} holes", { n: f.pts.length }))
          + (f.pts.length ? `<button class="btn small" data-k="clearPts">${esc(t("Clear holes"))}</button>` : "")
          + `<p class="pm-help muted">${esc(f.plane ? t("Click on the face to place holes; click a hole again to remove it.") : t("Click the flat face (or a plane) for the holes."))}</p>`);
    }
    if (f.type === "draft") {
      title = t("Draft");
      const dbox = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      body = group(t("Draft angle"), numField("angle", t("Angle"), f.angle, "angle"))
        + group(t("Neutral plane"), dbox("nplane", t("Plane"), this.refLabel(f.plane)) + chk("flip", f.flip, t("Reverse direction"))
          + `<p class="pm-help muted">${esc(t("The faces keep their size where they cross this plane and taper away from it."))}</p>`)
        + group(t("Faces to draft"), dbox("faces", t("Faces"), t("{n} face|{n} faces", { n: f.faces.length }))
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
          + `<p class="pm-help muted">${esc(m.focus === "nplane" || !f.plane ? t("Click a plane or a flat face in the view or the tree.") : t("Click the faces to draft; click a face again to remove it."))}</p>`);
    }
    if (f.type === "delface" || f.type === "moveface") {
      title = f.type === "delface" ? t("Delete Face") : t("Move Face");
      const mvMode = f.type === "moveface" ? f.mode ?? "offset" : "offset";
      const mvSel = f.type === "moveface" ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mvmode">${([["offset", t("Offset")], ["translate", t("Translate")], ["rotate", t("Rotate")]] as const).map(([v, l]) => `<option value="${v}"${mvMode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : "";
      const mvParams = f.type !== "moveface" ? ""
        : mvMode === "translate" ? numField("dx", t("Delta X"), f.dx ?? { v: 0 }, "length") + numField("dy", t("Delta Y"), f.dy ?? { v: 0 }, "length") + numField("dz", t("Delta Z"), f.dz ?? { v: 0 }, "length")
        : mvMode === "rotate" ? `<div class="pm-field"><span>${esc(t("Axis"))}</span><button class="pm-box${m.focus === "axis" ? " focus" : ""}" data-focus="axis" translate="no">${esc(f.axis ? this.lineLabel(f.axis) : t("None"))}</button></div>` + numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 18 }, "angle") + chk("flip", f.flip, t("Reverse direction"))
        : numField("distance", t("Distance"), f.distance, "length") + chk("flip", f.flip, t("Reverse direction"));
      body = (f.type === "moveface" ? group(t("Parameters"), mvSel + mvParams) : "")
        + group(f.type === "delface" ? t("Faces to delete") : t("Faces to move"), `<p class="pm-count">${esc(t("{n} face|{n} faces", { n: f.faces.length }))}</p>`
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
          + `<p class="pm-help muted">${esc(f.type === "delface" ? t("Click the faces to remove; the faces around them grow to close the gap.")
            : mvMode === "rotate" ? (m.focus === "axis" ? t("Click the edge to turn about: an edge of the face, or a reference axis in the tree.") : t("Click flat faces to turn them about the axis; the faces around them follow."))
            : mvMode === "translate" ? t("Click flat faces to move them; only the part of the move along each face's normal changes it.")
            : t("Click flat faces to move them along their normals; out adds material, reversed removes it."))}</p>`);
    }
    if (f.type === "shell" || isCopy(f)) {
      const box = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      const intField = (key: string, label: string, v: number) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="numeric" data-int="${key}" value="${v}" spellcheck="false" /></span></label>`;
      const seeds = isCopy(f) ? (f.features.map(id => this.store!.feature(id)).filter(Boolean).map(x => featureLabel(x!.name)).join(", ") || t("None")) : "";
      const seedGroup = isCopy(f) ? group(f.type === "mirror" ? t("Features to mirror") : t("Features to pattern"), box("seeds", t("Features"), seeds)
        + `<p class="pm-help muted">${esc(f.type === "mirror" ? t("Click faces of the features (or rows in the tree); none mirrors the whole body.") : t("Click faces of the features, or rows in the tree."))}</p>`) : "";
      const skip = (f.type === "lpattern" || f.type === "cpattern") ? group(t("Instances to skip"), `<label class="pm-field"><span>${esc(t("Skip"))}</span><input type="text" data-k="skip" value="${esc((f.skip ?? []).join("; "))}" spellcheck="false" placeholder="${f.type === "lpattern" && f.dir2 ? "1,1; 2,0" : "2; 3"}" /></label><p class="pm-help muted">${esc(f.type === "lpattern" && f.dir2 ? t("Instance numbers as column,row from 0 (the seed is 0,0), separated by semicolons.") : t("Instance numbers from 0 (the seed is 0), separated by semicolons."))}</p>`) : "";
      if (f.type === "shell") {
        title = t("Shell");
        body = group(t("Parameters"), numField("thickness", t("Thickness"), f.thickness, "length") + chk("outward", f.outward, t("Shell outward")))
          + group(t("Faces to remove"), `<p class="pm-count">${esc(t("{n} face|{n} faces", { n: f.faces.length }))}</p>`
            + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
            + `<p class="pm-help muted">${esc(t("Click the faces to leave open; none makes a closed hollow body."))}</p>`);
      } else if (f.type === "mirror") {
        title = t("Mirror");
        body = group(t("Mirror face/plane"), box("mplane", t("Plane"), this.refLabel(f.plane)) + `<p class="pm-help muted">${esc(t("Click a plane or a flat face in the view or the tree."))}</p>`) + seedGroup;
      } else if (f.type === "lpattern") {
        title = t("Linear pattern");
        body = group(t("Direction 1"), box("dir", t("Direction"), this.lineLabel(f.dir)) + numField("spacing", t("Spacing"), f.spacing, "length") + intField("count", t("Instances"), f.count) + chk("flip", f.flip, t("Reverse direction")))
          + group(t("Direction 2"), chk("useDir2", !!f.dir2 || m.focus === "dir2", t("Direction 2"))
            + (f.dir2 || m.focus === "dir2" ? box("dir2", t("Direction"), this.lineLabel(f.dir2)) + numField("spacing2", t("Spacing"), f.spacing2 ?? { v: f.spacing.v }, "length") + intField("count2", t("Instances"), f.count2 ?? 2) + chk("flip2", f.flip2, t("Reverse direction")) : ""))
          + seedGroup + skip
          + `<p class="pm-help muted">${esc(t("For a direction, click a straight edge, a flat face (its normal) or a reference axis in the tree."))}</p>`;
      } else {
        title = t("Circular pattern");
        body = group(t("Parameters"), box("dir", t("Axis"), this.lineLabel(f.axis)) + numField("angle", t("Angle"), f.angle, "angle") + intField("count", t("Instances"), f.count)
          + chk("equal", f.equal, t("Equal spacing")) + chk("flip", f.flip, t("Reverse direction")))
          + seedGroup + skip
          + `<p class="pm-help muted">${esc(t("For the axis, click a round edge or face, a straight edge, or a reference axis in the tree."))}</p>`;
      }
    }
    if (f.type === "helix" || f.type === "sweep" || f.type === "loft" || f.type === "rib" || f.type === "split") ({ title, body } = this.p3Panel(f, sketches, group, numField, chk));
    if (isBodyOp(f)) ({ title, body } = this.bodyPanel(f, m.focus, group, numField, chk));
    if (f.type === "planesurf" || f.type === "extsurf" || f.type === "offsurf" || f.type === "knit" || f.type === "thicken" || f.type === "replaceface") ({ title, body } = this.surfPanel(f, sketches, group, numField, chk));
    if (f.type === "import") {
      const st = this.last?.statuses.find(x => x.id === f.id);
      title = t("Imported body");
      body = group(t("File"), `<p class="pm-count" translate="no">${esc(f.file)}</p>`)
        + group(t("Check and heal"), chk("heal", f.heal, t("Check and heal (sew gaps into solids)")) + (f.heal ? numField("tol", t("Tolerance"), f.tol ?? { v: 0.1 }, "length") : "")
          + (st?.code === "warning" && st.warning ? `<p class="pm-help" role="status" data-heal>${esc(statusText(st))}</p>` : "")
          + `<p class="pm-help muted">${esc(t("Healing sews faces whose edges are closer than the tolerance and closes the result into solids."))}</p>`);
    }
    if (f.type === "plane") {
      title = t("Plane");
      body = group(t("First reference"), `<button class="pm-box${m.focus !== "axis" ? " focus" : ""}" data-k="focus-base" translate="no">${esc(this.refLabel(f.base))}</button>`)
        + group(t("Placement"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mode"><option value="offset"${f.mode === "offset" ? " selected" : ""}>${esc(t("Offset distance"))}</option><option value="angle"${f.mode === "angle" ? " selected" : ""}>${esc(t("At angle about an edge"))}</option></select></label>`
          + (f.mode === "offset" ? numField("offset", t("Distance"), f.offset, "length")
            : `<div class="pm-field"><span>${esc(t("Edge"))}</span><button class="pm-box${m.focus === "axis" ? " focus" : ""}" data-k="focus-axis">${esc(f.axis ? t("Edge picked") : t("None"))}</button></div>` + numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 4 }, "angle"))
          + chk("flip", f.flip, t("Flip")))
        + `<p class="pm-help muted">${esc(m.focus === "axis" ? t("Click a straight edge of the model.") : t("Click a plane or a flat face in the view or the tree."))}</p>`;
    }
    // SolidWorks habit: ✓ and ✕ at the top of the panel, then the message box, then the groups.
    // A rebuild re-renders the panel; keep what is being typed (and the caret) instead of the stored value.
    const typing = new Map<string, { value: string; focus: boolean; a: number | null; b: number | null }>();
    pm.querySelectorAll<HTMLInputElement>("input[data-num], input[type=text][data-k]").forEach(inp => {
      const key = inp.dataset.num ? `n:${inp.dataset.num}` : `k:${inp.dataset.k}`;
      const focus = document.activeElement === inp;
      if (focus || inp.value !== inp.defaultValue) typing.set(key, { value: inp.value, focus, a: inp.selectionStart, b: inp.selectionEnd });
    });
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(title)}</h3><span class="pm-okc"><button class="pm-ok" data-k="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-k="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>`
      + err + `<p class="pm-help muted">${esc(m.isNew ? t("Set the values; the view shows the result. ✓ or Enter keeps it, ✕ or Esc cancels.") : t("Editing: ✓ or Enter applies the change, ✕ or Esc cancels."))}</p>`
      + name + body;
    typing.forEach((st, key) => {
      const inp = pm.querySelector<HTMLInputElement>(key.startsWith("n:") ? `input[data-num="${key.slice(2)}"]` : `input[type=text][data-k="${key.slice(2)}"]`);
      if (!inp) return;
      inp.value = st.value;
      if (st.focus) { inp.focus(); try { inp.setSelectionRange(st.a, st.b); } catch { /* not a text input */ } }
    });
    const upd = (fn: () => void, structural = false) => { fn(); if (structural) this.renderPanel(); this.drawDecor(); this.renderBar(); void this.rebuild(); };
    pm.querySelectorAll<HTMLInputElement>("input[data-num]").forEach(inp => {
      const apply = () => {
        const key = inp.dataset.num!, q = inp.dataset.q as "length" | "angle";
        let v: number;
        try { v = evaluate(inp.value, q, q === "angle" ? "deg" : unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        // Helix start angle and taper may be 0 or negative.
        if (!(v > 0) && !(key === "start" || key === "taper")) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const n: Num = isPlain(inp.value) ? { v } : { v, expr: inp.value.trim() };
        // "thin.t" and "draft.angle" live one level down.
        const [k0, k1] = key.split(".");
        const host = (k1 ? (f as unknown as Record<string, Record<string, Num>>)[k0] : f) as unknown as Record<string, Num | undefined>;
        const cur = host?.[k1 ?? k0];
        if (cur && cur.v === n.v && cur.expr === n.expr) return;
        upd(() => {
          (host as Record<string, Num>)[k1 ?? k0] = n;
          // A typed size makes the hole custom (SolidWorks' "Show custom sizing").
          if (f.type === "hole" && key !== "depth" && key !== "threadDepth" && f.size) { delete f.size; delete f.fit; }
          if (f.type === "thread" && key === "diameter") { delete f.size; delete f.pitch; }
        }, f.type === "hole" || f.type === "thread");
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); apply(); this.ok(); }
        else if (e.key === "Escape") { e.preventDefault(); void this.cancel(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // Arrow keys step the value (Shift: ×10).
          e.preventDefault();
          const q = inp.dataset.q;
          const step = (q === "angle" ? 5 : 1) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
          const cur = parseFloat(inp.value.replace(",", "."));
          if (Number.isFinite(cur) && cur + step > 0) { inp.value = trimNum(cur + step, 6); apply(); }
        }
      });
    });
    pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-k]").forEach(el => {
      const k = el.dataset.k!;
      if (el instanceof HTMLButtonElement) return;
      el.addEventListener("change", () => {
        const val = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
        const g = f as unknown as Record<string, unknown>;
        if (k === "name") { const s = String(val).trim(); if (s) f.name = s === featureLabel(f.name) ? f.name : s; this.renderPanel(); return; }
        if (k === "mode" && (f.type === "axis" || f.type === "point")) { upd(() => { (f as { mode: string }).mode = String(val); delete f.edge; delete f.face; if (f.type === "axis") delete f.planes; if (f.type === "point") delete f.at; }, true); return; }
        if (k === "mode" && f.type === "plane") { upd(() => { f.mode = val as "offset" | "angle"; if (f.mode === "angle") { f.angle ??= { v: Math.PI / 4 }; if (!f.axis) m.focus = "axis"; } else m.focus = "base"; }, true); return; }
        if (k === "mode" && f.type === "chamfer") { upd(() => { f.mode = val as "equal" | "two" | "angle"; if (f.mode === "two") f.distance2 ??= { v: f.distance.v }; if (f.mode === "angle") f.angle ??= { v: Math.PI / 4 }; }, true); return; }
        if (f.type === "fillet" && k === "kind") {
          upd(() => {
            if (val === "face" || val === "full") {
              f.kind = val; f.faces1 ??= []; f.faces2 ??= []; f.edges = [];
              if (val === "full") f.center ??= []; else delete f.center;
              delete f.multi; delete f.variable; delete f.keepFit;
              m.focus = "fs1";
            } else { delete f.kind; delete f.faces1; delete f.faces2; delete f.center; m.focus = undefined; }
          }, true);
          return;
        }
        if (f.type === "fillet" && k === "multi") { upd(() => { if (val) { f.multi = true; delete f.variable; f.edges.forEach(e => { delete e.r2; delete e.at; }); } else { delete f.multi; f.edges.forEach(e => delete e.r); } }, true); return; }
        if (f.type === "fillet" && k === "variable") { upd(() => { if (val) { f.variable = true; delete f.multi; } else { delete f.variable; f.edges.forEach(e => { delete e.r; delete e.r2; delete e.at; }); } }, true); return; }
        if (f.type === "thread" && k === "size") { upd(() => this.applyThreadSize(f, String(val) || undefined), true); return; }
        if (f.type === "hole" && (k === "kind" || k === "size" || k === "fit")) {
          upd(() => {
            if (k === "kind") {
              f.kind = val as HoleFeature["kind"];
              if (f.size && !(f.kind === "insert" ? insertSize(f.size) : holeSize(f.size))) delete f.size;
              if (f.kind === "insert") f.size ??= "M3";
            }
            if (k === "size") { if (val) f.size = String(val); else delete f.size; }
            if (k === "fit") f.fit = val as HoleFeature["fit"];
            if (f.size) applyHoleSize(f);
            else {
              if (f.kind === "cbore") { f.cbDia ??= { v: Math.round(f.diameter.v * 17) / 10 }; f.cbDepth ??= { v: f.diameter.v }; }
              if (f.kind === "csink") { f.csDia ??= { v: f.diameter.v * 2 }; f.csAngle ??= { v: Math.PI / 2 }; }
              if (f.kind === "tapped") f.threadDepth ??= { v: f.diameter.v * 2 };
            }
          }, true);
          return;
        }
        if (k === "skip" && (f.type === "lpattern" || f.type === "cpattern")) {
          const list = String(val).split(/[;\s]+/).map(x => x.trim()).filter(Boolean);
          const ok = list.every(x => (f.type === "lpattern" && f.dir2 ? /^\d+,\d+$/ : /^\d+$/).test(x));
          if (!ok) { el.setAttribute("aria-invalid", "true"); toast(t("Write instance numbers like 2; 3 (or 1,1; 2,0 with two directions)."), true); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { if (list.length) f.skip = list; else delete f.skip; });
          return;
        }
        if (k === "useDir2" && f.type === "lpattern") {
          upd(() => { if (val) { m.focus = "dir2"; f.spacing2 ??= { v: f.spacing.v }; f.count2 ??= 2; } else { delete f.dir2; delete f.spacing2; delete f.count2; delete f.flip2; if (m.focus === "dir2") m.focus = "dir"; } }, true);
          return;
        }
        if (f.type === "extrude" && (k === "thinOn" || k === "thinMode" || k === "draftOn" || k === "draftOut")) {
          upd(() => {
            if (k === "thinOn") { if (val) f.thin = { t: { v: 2 }, mode: "inside" }; else delete f.thin; }
            if (k === "thinMode" && f.thin) f.thin.mode = val as "inside" | "outside" | "mid";
            if (k === "draftOn") { if (val) f.draft = { angle: { v: (5 * Math.PI) / 180 } }; else delete f.draft; }
            if (k === "draftOut" && f.draft) { if (val) f.draft.outward = true; else delete f.draft.outward; }
          }, true);
          return;
        }
        if (f.type === "revolve" && (k === "thinOn" || k === "thinMode" || k === "dir2" || k === "rvEnd")) {
          upd(() => {
            if (k === "thinOn") { if (val) f.thin = { t: { v: 2 }, mode: "inside" }; else delete f.thin; }
            if (k === "thinMode" && f.thin) f.thin.mode = val as "inside" | "outside" | "mid";
            if (k === "dir2") { if (val) f.angle2 = { v: Math.PI / 4 }; else delete f.angle2; }
            if (k === "rvEnd") {
              if (val === "mid") f.mid = true; else delete f.mid;
              if (val === "upto") f.end = "upto"; else { delete f.end; delete f.upTo; }
              if (val !== "blind") delete f.angle2;
            }
          }, true);
          return;
        }
        if (k === "start" && f.type === "extrude") {
          upd(() => {
            if (val === "sketch") delete f.start; else f.start = val as "offset" | "surface" | "vertex";
            if (val === "offset") f.startOffset ??= { v: 10 }; else { delete f.startOffset; delete f.startReverse; }
            if (val !== "surface") delete f.startRef;
            if (val !== "vertex") delete f.startVertex;
            if (val === "surface" || val === "vertex") m.focus = "start";
          }, true);
          return;
        }
        if (f.type === "helix" && (k === "taperOn" || k === "mode" || k === "hsketch")) {
          upd(() => {
            if (k === "taperOn") { if (val) f.taper = { v: (5 * Math.PI) / 180 }; else delete f.taper; }
            if (k === "mode") f.mode = val as HelixFeature["mode"];
            if (k === "hsketch") f.sketch = String(val);
          }, true);
          return;
        }
        if (f.type === "sweep" && (k === "profileKind" || k === "swProfile" || k === "swPath" || k === "orient")) {
          upd(() => {
            if (k === "profileKind") { if (val === "circular") { f.circular ??= { v: 2 }; delete f.profile; } else { delete f.circular; f.profile = sketches.find(s => sketchProfileOk(s))?.id; if (!f.profile) delete f.profile; } }
            if (k === "swProfile") { if (val) f.profile = String(val); else delete f.profile; }
            if (k === "swPath") { const v = String(val); if (!v) delete f.path; else f.path = v.startsWith("h:") ? { helix: v.slice(2) } : { sketch: v.slice(2) }; }
            if (k === "orient") { if (val === "normal") f.orient = "normal"; else delete f.orient; }
          }, true);
          return;
        }
        if (f.type === "loft" && /^lp\d+$/.test(k)) {
          upd(() => { const i = +k.slice(2); if (val) f.profiles[i] = String(val); else f.profiles.splice(i, 1); f.profiles = f.profiles.filter(Boolean); }, true);
          return;
        }
        if (k === "mvmode" && f.type === "moveface") {
          upd(() => {
            if (val === "offset") delete f.mode; else f.mode = val as "translate" | "rotate";
            if (val === "translate") { f.dx ??= { v: 0 }; f.dy ??= { v: 0 }; f.dz ??= { v: f.distance.v } }
            if (val === "rotate") { f.angle ??= { v: Math.PI / 18 }; m.focus = f.axis ? "faces" : "axis"; } else m.focus = "faces";
          }, true);
          return;
        }
        if (k === "merge") { upd(() => { if (val) delete (f as ExtrudeFeature).merge; else (f as ExtrudeFeature).merge = false; }); return; }
        if (k === "dir2") { upd(() => { (f as ExtrudeFeature).depth2 = val ? { v: (f as ExtrudeFeature).depth.v } : undefined; if (!val) delete (f as ExtrudeFeature).depth2; }, true); return; }
        if (k === "sketch" && f.type === "revolve") {
          const sk = this.store!.feature(String(val)) as SketchFeature;
          const ls = sk.ents.filter(x => x.t === "line");
          upd(() => { f.sketch = String(val); f.axis = (ls.find(l => l.cons) ?? ls[0])?.id ?? ""; }, true);
          return;
        }
        upd(() => {
          if (typeof val === "boolean" && !val) delete g[k]; else g[k] = val;
          if (k === "op" && val !== "cut") delete g.outside;
          if (k === "end" && val !== "upto" && val !== "offset") delete g.upTo;
          if (k === "end" && val !== "vertex") delete g.upToVertex;
          if (k === "end" && (val === "upto" || val === "offset" || val === "vertex")) m.focus = "upto";
          if (k === "end" && val === "offset") g.upToOffset ??= { v: 5 };
          if (k === "end" && val !== "offset") { delete g.upToOffset; delete g.reverseOffset; }
          if (k === "end" && val !== "blind" && val !== "mid") delete g.draft;
          if (k === "op" && val !== "cut" && g.end === "through2") g.end = "through";
        }, k === "end" || k === "op" || k === "sketch" || k === "modelled" || k === "axes");
      });
    });
    pm.querySelectorAll<HTMLInputElement>("input[data-er2]").forEach(inp => {
      const apply = () => {
        if (f.type !== "fillet") return;
        let v: number;
        try { v = evaluate(inp.value, "length", unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const e = f.edges[+inp.dataset.er2!];
        if (!e || e.r2 === v) return;
        e.r2 = v;
        this.drawDecor(); void this.rebuild();
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLInputElement>("input[data-er]").forEach(inp => {
      const apply = () => {
        if (f.type !== "fillet") return;
        let v: number;
        try { v = evaluate(inp.value, "length", unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const e = f.edges[+inp.dataset.er!];
        if (!e || e.r === v) return;
        e.r = v;
        this.drawDecor(); void this.rebuild();
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLElement>("[data-rm]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "fillet" && f.type !== "chamfer") return;
      f.edges.splice(+b.dataset.rm!, 1);
      this.drawDecor(); this.renderPanel(); void this.rebuild();
    }));
    pm.querySelector<HTMLInputElement>("[data-ui=tangent]")?.addEventListener("change", e => { this.tangentProp = (e.target as HTMLInputElement).checked; });
    pm.querySelector("[data-k=clear]")?.addEventListener("click", () => { if (f.type === "fillet" || f.type === "chamfer") { f.edges = []; this.drawDecor(); this.renderPanel(); void this.rebuild(); } });
    pm.querySelector("[data-k=focus-base]")?.addEventListener("click", () => { if (m.kind === "feature") { m.focus = "base"; this.renderPanel(); this.drawDecor(); } });
    pm.querySelector("[data-k=focus-axis]")?.addEventListener("click", () => { if (m.kind === "feature") { m.focus = "axis"; this.renderPanel(); this.drawDecor(); } });
    pm.querySelectorAll<HTMLElement>("[data-focus]").forEach(b => b.addEventListener("click", () => { if (m.kind === "feature") { m.focus = b.dataset.focus as Focus; this.renderPanel(); this.drawDecor(); } }));
    // Hole favourites (FR-FT-056): a saved definition (type, size, diameters, end) applied in one go; kept in this browser.
    if (f.type === "hole") {
      const favSel = pm.querySelector<HTMLSelectElement>("[data-ui=fav]");
      favSel?.addEventListener("change", () => {
        const fav = loadFavs()[+favSel.value];
        if (!fav || favSel.value === "") return;
        Object.assign(f, structuredClone(fav.def));
        for (const k of HOLE_DEF_KEYS) if (!(k in fav.def)) delete (f as unknown as Record<string, unknown>)[k];
        this.draftChanged();
      });
      pm.querySelector("[data-ui=favSave]")?.addEventListener("click", () => {
        const name = pm.querySelector<HTMLInputElement>("[data-ui=favName]")?.value ?? "";
        if (!name.trim()) { toast(t("Type a name for the favourite."), true); return; }
        const def: Record<string, unknown> = {};
        for (const k of HOLE_DEF_KEYS) if ((f as unknown as Record<string, unknown>)[k] !== undefined) def[k] = structuredClone((f as unknown as Record<string, unknown>)[k]);
        saveFavs([...loadFavs().filter(x => x.name !== name.trim()), { name: name.trim(), def: def as Partial<HoleFeature> }]);
        toast(t("Saved favourite {name}", { name: name.trim() }));
        this.renderPanel();
      });
      pm.querySelector("[data-ui=favDel]")?.addEventListener("click", () => {
        const i = favSel?.value ?? "";
        if (i === "") { toast(t("Choose the favourite to delete first.")); return; }
        saveFavs(loadFavs().filter((_x, k) => String(k) !== i));
        this.renderPanel();
      });
    }
    pm.querySelector("[data-k=clearSets]")?.addEventListener("click", () => { if (f.type === "fillet") { f.faces1 = []; f.faces2 = []; if (f.kind === "full") f.center = []; if (m.kind === "feature") m.focus = "fs1"; this.draftChanged(); } });
    pm.querySelector("[data-k=clearPts]")?.addEventListener("click", () => { if (f.type === "hole") { f.pts = []; this.draftChanged(); } });
    pm.querySelector("[data-k=clearSurfaces]")?.addEventListener("click", () => { if (f.type === "knit") { f.surfaces = []; this.draftChanged(); } });
    pm.querySelector("[data-k=clearFaces]")?.addEventListener("click", () => { if (f.type === "shell" || f.type === "draft" || f.type === "split" || f.type === "delface" || f.type === "moveface" || f.type === "offsurf" || f.type === "replaceface") { f.faces = []; this.draftChanged(); }
      if (isBodyOp(f)) { if (f.type === "combine") f.tools = []; else f.bodies = []; this.draftChanged(); } });
    pm.querySelectorAll<HTMLInputElement>("input[data-int]").forEach(inp => {
      const apply = () => {
        const v = Math.round(Number(inp.value.trim()));
        if (!Number.isFinite(v) || v < 1 || v > 500) { inp.setAttribute("aria-invalid", "true"); toast(t("Enter a whole number from 1 to 500."), true); return; }
        inp.removeAttribute("aria-invalid");
        const g = f as unknown as Record<string, number>;
        if (g[inp.dataset.int!] === v) return;
        upd(() => { g[inp.dataset.int!] = v; });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); apply(); this.ok(); }
        else if (e.key === "Escape") { e.preventDefault(); void this.cancel(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const cur = Math.round(Number(inp.value)) + (e.key === "ArrowUp" ? 1 : -1);
          if (cur >= 1 && cur <= 500) { inp.value = String(cur); apply(); }
        }
      });
    });
    pm.querySelector("[data-k=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-k=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  /** Equations panel: variables (name, value or expression, kind, result, comment) and the part's expressions. */
  private renderEqPanel(pm: HTMLElement, vars: GlobalVar[]) {
    const unit = units.current;
    const res = evalVars({ ...this.doc, vars }, unit);
    const shown = (v: GlobalVar) => {
      if (res.errors[v.name]) return `⚠ ${t(res.errors[v.name].key, res.errors[v.name].params)}`;
      const x = res.values[v.name];
      const n = typeof x === "number" ? x : x?.v;
      if (n == null) return "";
      return v.kind === "angle" ? `${trimNum((n * 180) / Math.PI, 4)}°` : v.kind === "length" ? `${trimNum(n * UNITS[unit].f, 6)} ${unit}` : trimNum(n, 6);
    };
    const kinds: [GlobalVar["kind"], string][] = [["length", t("Length")], ["angle", t("Angle")], ["number", t("Number")]];
    const rows = vars.map((v, i) => `<div class="eq-row" data-i="${i}">
        <input type="text" data-e="name" value="${esc(v.name)}" aria-label="${esc(t("Name"))}" spellcheck="false" translate="no" placeholder="${esc(t("Name"))}" />
        <input type="text" data-e="expr" value="${esc(v.expr)}" aria-label="${esc(t("Value or equation"))}" spellcheck="false" translate="no" placeholder="${esc(t("Value or equation"))}" />
        <select data-e="kind" aria-label="${esc(t("Type"))}">${kinds.map(([k, l]) => `<option value="${k}"${v.kind === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <span class="eq-val${res.errors[v.name] ? " err" : ""}" translate="no">${esc(shown(v))}</span>
        <button class="icon" data-e="rm" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(v.name)}">✕</button>
        <input type="text" data-e="comment" class="eq-c" value="${esc(v.comment ?? "")}" aria-label="${esc(t("Comment"))}" placeholder="${esc(t("Comment"))}" />
      </div>`).join("");
    const used = exprTargets(this.doc).map(x => `<li><span translate="no">${esc(featureLabel(x.owner.name))} · ${esc(x.key)}</span> = <code translate="no">${esc(x.num.expr!)}</code> → ${esc(x.q === "angle" ? `${trimNum((x.num.v * 180) / Math.PI, 4)}°` : `${trimNum(x.num.v * UNITS[unit].f, 6)} ${unit}`)}</li>`).join("");
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(t("Equations"))}</h3><span class="pm-okc"><button class="pm-ok" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-a="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>`
      + `<p class="pm-help muted">${esc(t("Global variables can be used by name in any value box, like Width/2. Dimensions are named like D1@Sketch1."))}</p>`
      + `<fieldset class="pm-group"><legend>${esc(t("Global variables"))}</legend><div class="eq-list">${rows || `<p class="pm-help muted">${esc(t("No variables yet."))}</p>`}</div><button class="btn small" data-a="add">${esc(t("Add variable"))}</button></fieldset>`
      + `<fieldset class="pm-group"><legend>${esc(t("Equations in the part"))}</legend>${used ? `<ul class="eq-used">${used}</ul>` : `<p class="pm-help muted">${esc(t("Type a variable's name or an expression in a value box to drive it."))}</p>`}</fieldset>`;
    pm.querySelectorAll<HTMLElement>(".eq-row").forEach(r => {
      const v = vars[+r.dataset.i!];
      r.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-e]").forEach(el => {
        const k = el.dataset.e!;
        if (k === "rm") { el.addEventListener("click", () => { vars.splice(+r.dataset.i!, 1); this.renderEqPanel(pm, vars); }); return; }
        el.addEventListener("change", () => {
          const val = el.value.trim();
          if (k === "name") v.name = val;
          else if (k === "expr") v.expr = val;
          else if (k === "kind") v.kind = val as GlobalVar["kind"];
          else if (val) v.comment = val; else delete v.comment;
          if (k !== "comment") { this.renderEqPanel(pm, vars); pm.querySelector<HTMLElement>(`.eq-row[data-i="${r.dataset.i}"] [data-e="${k}"]`)?.focus(); }
        });
        el.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); (el as HTMLElement).dispatchEvent(new Event("change")); } });
      });
    });
    pm.querySelector("[data-a=add]")!.addEventListener("click", () => {
      let n = vars.length + 1;
      while (vars.some(v => v.name === `Var${n}`)) n++;
      vars.push({ name: `Var${n}`, expr: "10", kind: "length" });
      this.renderEqPanel(pm, vars);
      pm.querySelector<HTMLInputElement>(`.eq-row[data-i="${vars.length - 1}"] [data-e="name"]`)?.select();
    });
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  /** Configurations panel: the active one is marked; switching rebuilds at once. */
  private renderCfgPanel(pm: HTMLElement) {
    const d = this.doc;
    const list = d.configs?.length ? d.configs.map(c => c.name) : ["Default"];
    const act = d.config ?? "Default";
    const rows = list.map((n, i) => `<div class="cfg-row${n === act ? " on" : ""}" data-i="${i}">
        <button class="cfg-act" data-c="act" aria-pressed="${n === act}" title="${esc(t("Make active"))}" aria-label="${esc(t("Make active"))}: ${esc(n)}">${n === act ? "●" : "○"}</button>
        <input type="text" data-c="name" value="${esc(n)}" aria-label="${esc(t("Name"))}" spellcheck="false" translate="no" />
        ${list.length > 1 ? `<button class="icon" data-c="rm" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))} ${esc(n)}">✕</button>` : ""}
      </div>`).join("");
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(t("Configurations"))}</h3><span class="pm-okc"><button class="pm-ok" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button></span></div>`
      + `<p class="pm-help muted">${esc(t("Each configuration keeps its own dimension and parameter values, variables, suppressed features and material. Change values while a configuration is active to set them for it."))}</p>`
      + `<fieldset class="pm-group"><legend>${esc(t("Configurations"))}</legend><div class="cfg-list">${rows}</div><button class="btn small" data-a="add">${esc(t("Add configuration"))}</button></fieldset>`;
    pm.querySelectorAll<HTMLElement>(".cfg-row").forEach(r => {
      const name = list[+r.dataset.i!];
      r.querySelector("[data-c=act]")!.addEventListener("click", () => this.setConfig(name));
      r.querySelector("[data-c=rm]")?.addEventListener("click", async () => {
        if (!(await confirmModal(t("Delete the configuration “{name}”?", { name }), t("Delete")))) return;
        this.store!.change(`Delete configuration ${name}`, dd => removeConfig(dd, name));
        this.renderAll();
        void this.rebuild();
      });
      const inp = r.querySelector<HTMLInputElement>("[data-c=name]")!;
      const commit = () => {
        const to = inp.value.trim();
        if (!to || to === name) { inp.value = name; return; }
        if (!d.configs?.length) {
          // Renaming the only (implicit) configuration makes it explicit.
          this.store!.change("Rename configuration", dd => { addConfig(dd, to); removeConfig(dd, "Default"); });
        } else if (d.configs.some(c => c.name === to)) { toast(t("There is already a configuration called “{name}”.", { name: to }), true); inp.value = name; return; }
        else this.store!.change("Rename configuration", dd => { renameConfig(dd, name, to); });
        this.renderAll();
      };
      inp.addEventListener("change", commit);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); } });
    });
    pm.querySelector("[data-a=add]")!.addEventListener("click", () => {
      const name = nextConfigName(d);
      this.store!.change(`Add configuration ${name}`, dd => addConfig(dd, name));
      this.renderAll();
      pm.querySelector<HTMLInputElement>(".cfg-row.on [data-c=name]")?.select();
    });
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
  }

  /** Part properties, material and colour (FR-DOC-007, FR-MAT-001/003). */
  private renderPropsPanel(pm: HTMLElement, d: PartDoc) {
    const text = (k: string, label: string, v: string | undefined) => `<label class="pm-field"><span>${esc(label)}</span><input type="text" data-p="${k}" value="${esc(v ?? "")}" spellcheck="false" translate="no" /></label>`;
    const mi = d.material ? MATERIALS.findIndex(x => x.name === d.material!.name && x.density === d.material!.density) : -2;
    const col = d.color ?? DEFAULT_COLOR;
    const hex = `#${col.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
    pm.innerHTML = `<div class="pm-head"><h3>${esc(t("Part properties"))}</h3></div>`
      + text("name", t("Name"), d.name) + text("title", t("Title"), d.props.title) + text("partNumber", t("Part number"), d.props.partNumber)
      + text("description", t("Description"), d.props.description) + text("revision", t("Revision"), d.props.revision) + text("author", t("Author"), d.props.author)
      + `<label class="pm-field"><span>${esc(t("Material"))}</span><select data-p="material"><option value="-2"${mi === -2 ? " selected" : ""}>${esc(t("Not specified"))}</option>${MATERIALS.map((x, i) => `<option value="${i}"${mi === i ? " selected" : ""}>${esc(t(x.name))} (${x.density})</option>`).join("")}<option value="-1"${mi === -1 ? " selected" : ""}>${esc(t("Custom…"))}</option></select></label>`
      + (mi === -1 ? text("matName", t("Material name"), d.material?.name) + `<label class="pm-field"><span>${esc(t("Density"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="density" value="${d.material?.density ?? ""}" /><span class="muted">g/cm³</span></span></label>` : "")
      + `<label class="pm-field"><span>${esc(t("Colour"))}</span><input type="color" data-p="color" value="${hex}" /></label>`
      + `<fieldset class="pm-group"><legend>${esc(t("Mass properties"))}</legend><label class="chk pm-chk"><input type="checkbox" data-p="ovr"${d.massOverride ? " checked" : ""} />${esc(t("Override mass properties"))}</label>`
      + (d.massOverride ? `<label class="pm-field"><span>${esc(t("Mass"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="ovrMass" value="${d.massOverride.mass ?? ""}" placeholder="${esc(t("calculated"))}" /><span class="muted">kg</span></span></label>`
        + (["x", "y", "z"] as const).map((a, i) => `<label class="pm-field"><span>${esc(t("Centre of mass"))} ${a.toUpperCase()}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="ovrCom" data-i="${i}" value="${d.massOverride!.com ? trimNum(d.massOverride!.com[i], 6) : ""}" placeholder="${esc(t("calculated"))}" /><span class="muted">mm</span></span></label>`).join("")
        + `<p class="pm-help muted">${esc(t("For purchased parts: the entered values replace the calculated ones in Mass properties. Leave the centre of mass empty to keep it calculated."))}</p>` : "")
      + `</fieldset>`
      + `<div class="pm-actions"><button class="btn primary small" data-a="ok">${esc(t("OK"))}</button><button class="btn small" data-a="cancel">${esc(t("Cancel"))}</button></div>`;
    pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-p]").forEach(el => el.addEventListener("change", () => {
      const k = el.dataset.p!, v = el.value;
      if (k === "name") { if (v.trim()) d.name = v.trim(); }
      else if (k === "material") {
        const i = +v;
        if (i >= 0) d.material = { ...MATERIALS[i] };
        else if (i === -1) d.material = { name: d.material?.name ?? "Custom", density: d.material?.density ?? 1 };
        else delete d.material;
        this.renderPanel();
      } else if (k === "matName") d.material = { name: v.trim() || "Custom", density: d.material?.density ?? 1 };
      else if (k === "density") {
        const x = parseFloat(v.replace(",", "."));
        if (!(x > 0)) { el.setAttribute("aria-invalid", "true"); toast(t("Density must be a number greater than 0 g/cm³."), true); return; }
        el.removeAttribute("aria-invalid");
        d.material = { name: d.material?.name ?? "Custom", density: x };
      } else if (k === "color") {
        d.color = [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255) as V3;
        void this.rebuild();
      } else if (k === "ovr") {
        if ((el as HTMLInputElement).checked) d.massOverride = {}; else delete d.massOverride;
        this.renderPanel();
      } else if (k === "ovrMass" || k === "ovrCom") {
        const o = d.massOverride ??= {};
        const x = parseFloat(v.replace(",", "."));
        const blank = v.trim() === "";
        if (!blank && (!isFinite(x) || (k === "ovrMass" && !(x > 0)))) { el.setAttribute("aria-invalid", "true"); toast(t(k === "ovrMass" ? "The mass must be a number greater than 0 kg." : "Enter a number in mm."), true); return; }
        el.removeAttribute("aria-invalid");
        if (k === "ovrMass") { if (blank) delete o.mass; else o.mass = x; }
        else {
          // The centre of mass is all three or none.
          const ins = [...pm.querySelectorAll<HTMLInputElement>('[data-p="ovrCom"]')].map(i => i.value.trim());
          if (ins.every(s => s === "")) delete o.com;
          else if (ins.every(s => isFinite(parseFloat(s.replace(",", "."))))) o.com = ins.map(s => parseFloat(s.replace(",", "."))) as V3;
        }
      } else {
        const p = d.props as Record<string, string | undefined>;
        if (v.trim()) p[k] = v.trim(); else delete p[k];
      }
    }));
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  private renderSketchPanel(pm: HTMLElement, ed: SketchEditor) {
    if (ed.pattern) { this.renderPatternPanel(pm, ed); return; }
    const sk = ed.sk;
    const info = ed.info;
    const def = info.status !== "ok" ? t("Over defined") : info.dof === 0 ? t("Fully defined") : t("Under defined, {n} DOF", { n: info.dof });
    const rels = ed.validRelations();
    const nSel = ed.selection.size;
    const plane = "std" in sk.plane ? t(STD_NAMES[sk.plane.std]) : t("Face");
    pm.innerHTML = `<div class="pm-head"><h3 translate="no">${esc(featureLabel(sk.name))}</h3></div>`
      + `<p class="pm-help muted">${esc(t("Plane"))}: ${esc(plane)} · <b class="pm-def" data-state="${info.status !== "ok" ? "over" : info.dof === 0 ? "full" : "under"}">${esc(def)}</b></p>`
      + `<p class="pm-help muted">${esc(t("Draw with the tools above. Blue is free to move, black is fixed by dimensions and relations. Double-click a dimension to change it."))}</p>`
      + `<div class="pm-sec"><h4>${esc(t("Selected"))}: ${nSel}</h4>`
      + (nSel ? `<div class="pm-rels">${rels.map(r => `<button class="btn small" data-rel="${r}">${esc(t(REL_NAME[r]))}</button>`).join("")}</div>`
        + `<div class="pm-rels"><button class="btn small" data-a="cons">${esc(t("Construction"))}</button>${ed.canMerge() ? `<button class="btn small" data-a="merge" title="${esc(t("Merge the two points into one"))}">${esc(t("Merge points"))}</button>` : ""}<button class="btn small danger" data-a="del">${esc(t("Delete"))}</button></div>`
        : `<p class="muted">${esc(t("Select sketch items to add relations (Ctrl+click for more)."))}</p>`)
      + `</div>`
      + (ed.tool === "polygon" ? `<label class="pm-field"><span>${esc(t("Sides"))}</span><input type="text" inputmode="numeric" class="pm-n" data-a="sides" value="${ed.polySides}" /></label>` : "")
      + (ed.tool === "fillet" ? `<label class="pm-field"><span>${esc(t("Radius"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="fr" value="${trimNum(ed.filletRadius * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>` : "")
      + (ed.tool === "chamfer" ? `<label class="pm-field"><span>${esc(t("Distance"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="cd" value="${trimNum(ed.chamferDist * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>` : "")
      + (ed.tool === "offset" ? `<label class="pm-field"><span>${esc(t("Distance"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="od" value="${trimNum(ed.offsetDist * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>` : "")
      + this.danglingBox(ed)
      + this.dimNameBox(ed)
      + this.assistant(ed)
      + `<div class="pm-sec"><h4>${esc(t("Relations"))}</h4>${this.relationList(ed)}</div>`
      + `<div class="pm-sec"><h4>${esc(t("Dimensions"))}</h4>${sk.dims.length ? `<label class="chk pm-chk"><input type="checkbox" data-a="shownames"${ed.showNames ? " checked" : ""} />${esc(t("Show dimension names"))}</label><ul class="pm-dims">${sk.dims.map(d => `<li><button class="link" data-dim="${d.id}" translate="no" title="${esc(`${d.name}@${sk.name}`)}">${esc(d.name)}</button> <span class="muted">${esc(d.val.expr ?? (d.t === "angle" ? `${trimNum((d.val.v * 180) / Math.PI, 3)}°` : `${trimNum(d.val.v * UNITS[units.current].f, 4)} ${units.current}`))}${d.driven ? ` (${esc(t("reference"))})` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">${esc(t("None yet: use Dimension (D)."))}</p>`}</div>`
      + `<div class="pm-actions"><button class="btn primary small" data-a="ok">${esc(t("Exit sketch"))}</button><button class="btn small" data-a="cancel">${esc(t("Cancel"))}</button></div>`;
    pm.querySelectorAll<HTMLElement>("[data-rel]").forEach(b => b.addEventListener("click", () => { ed.addRelation(b.dataset.rel as never); this.renderPanel(); }));
    pm.querySelector("[data-a=cons]")?.addEventListener("click", () => ed.toggleConstruction());
    pm.querySelector("[data-a=merge]")?.addEventListener("click", () => { ed.mergePoints(); this.renderPanel(); });
    pm.querySelector("[data-a=del]")?.addEventListener("click", () => { ed.deleteSelection(); this.renderPanel(); });
    pm.querySelectorAll<HTMLElement>("[data-dim]").forEach(b => b.addEventListener("click", () => ed.editDim(b.dataset.dim!)));
    pm.querySelectorAll<HTMLElement>("[data-delrel]").forEach(b => b.addEventListener("click", () => { ed.deleteItems([b.dataset.delrel!]); this.renderPanel(); }));
    pm.querySelectorAll<HTMLElement>("[data-selrel]").forEach(b => b.addEventListener("click", () => { ed.select([b.dataset.selrel!]); this.renderPanel(); }));
    pm.querySelectorAll<HTMLElement>("[data-reattach]").forEach(b => b.addEventListener("click", () => { ed.select([b.dataset.reattach!]); ed.startReattach(b.dataset.reattach!); this.renderBar(); this.renderPanel(); }));
    pm.querySelector("[data-a=deldangling]")?.addEventListener("click", () => { ed.deleteItems(ed.danglingRels().map(r => r.id)); this.renderPanel(); });
    pm.querySelector<HTMLInputElement>("[data-a=shownames]")?.addEventListener("change", e => { ed.showNames = (e.target as HTMLInputElement).checked; ed.render(); });
    pm.querySelector<HTMLInputElement>("[data-a=dimname]")?.addEventListener("change", e => {
      const inp = e.target as HTMLInputElement;
      const err = ed.renameDim(inp.dataset.id!, inp.value);
      if (err) { toast(t(err), true); inp.value = ed.sk.dims.find(d => d.id === inp.dataset.id)?.name ?? ""; return; }
      this.renderPanel();
    });
    pm.querySelectorAll<HTMLElement>("[data-fixshow]").forEach(b => b.addEventListener("click", () => { ed.select(b.dataset.fixshow!.split(",")); this.renderPanel(); }));
    pm.querySelectorAll<HTMLElement>("[data-fixapply]").forEach(b => b.addEventListener("click", () => {
      ed.deleteItems(b.dataset.fixapply!.split(","));
      if (ed.info.status === "ok") toast(t("The sketch solves again."), "success");
      this.renderPanel();
    }));
    pm.querySelector<HTMLInputElement>("[data-a=sides]")?.addEventListener("change", e => {
      const n = Math.round(+(e.target as HTMLInputElement).value);
      if (n >= 3 && n <= 64) ed.polySides = n; else { toast(t("A polygon has 3 to 64 sides."), true); (e.target as HTMLInputElement).value = String(ed.polySides); }
    });
    for (const [k, set] of [["fr", (v: number) => { ed.filletRadius = v; }], ["cd", (v: number) => { ed.chamferDist = v; }], ["od", (v: number) => { ed.offsetDist = v; }]] as const) {
      pm.querySelector<HTMLInputElement>(`[data-a=${k}]`)?.addEventListener("change", e => {
        try { const v = evaluate((e.target as HTMLInputElement).value, "length", units.current); if (v > 0) set(v); else throw new ExprError("The value must be more than 0."); }
        catch (err) { toast(t((err as Error).message), true); }
      });
    }
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  /** Sketch pattern PropertyManager (FR-SK-038): values preview live, ✓ adds the instances. */
  private renderPatternPanel(pm: HTMLElement, ed: SketchEditor) {
    const p = ed.pattern!;
    const f = UNITS[units.current].f, u = units.current;
    const len = (k: string, label: string, v: number) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-p="${k}" data-q="length" value="${trimNum(v * f, 6)}" /><span class="muted">${u}</span></span></label>`;
    const ang = (k: string, label: string, v: number) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-p="${k}" data-q="angle" value="${trimNum((v * 180) / Math.PI, 4)}" /><span class="muted">°</span></span></label>`;
    const cnt = (k: string, label: string, v: number) => `<label class="pm-field"><span>${esc(label)}</span><input type="text" inputmode="numeric" class="pm-n" data-p="${k}" data-q="count" value="${v}" /></label>`;
    const group = (legend: string, inner: string) => `<fieldset class="pm-group"><legend>${esc(legend)}</legend>${inner}</fieldset>`;
    const chkP = (k: string, on: boolean, label: string) => `<label class="chk pm-chk"><input type="checkbox" data-p="${k}"${on ? " checked" : ""} />${esc(label)}</label>`;
    const centre = (c: [number, number]) => len("cx", t("Centre X"), c[0]) + len("cy", t("Centre Y"), c[1]);
    const opts = (copy: boolean, keep: boolean) => group(t("Options"), chkP("copy", copy, t("Copy")) + (copy ? "" : chkP("keep", keep, t("Keep relations"))));
    const body = p.kind === "linear"
      ? group(t("Direction 1"), len("d", t("Spacing"), p.d) + cnt("n", t("Instances"), p.n) + ang("angle", t("Angle"), p.angle))
        + group(t("Direction 2"), len("d2", t("Spacing"), p.d2) + cnt("n2", t("Instances"), p.n2) + ang("angle2", t("Angle"), p.angle2))
      : p.kind === "circular" ? group(t("Parameters"), centre(p.c) + cnt("n", t("Instances"), p.n) + ang("total", t("Total angle"), p.total) + chkP("equal", p.equal, t("Equal spacing")))
      : p.kind === "move" ? group(t("Parameters"), len("dx", t("Delta X"), p.dx) + len("dy", t("Delta Y"), p.dy)) + opts(p.copy, p.keep)
      : p.kind === "rotate" ? group(t("Parameters"), centre(p.c) + ang("angle", t("Angle"), p.angle)) + opts(p.copy, p.keep)
      : group(t("Parameters"), centre(p.c) + `<label class="pm-field"><span>${esc(t("Scale factor"))}</span><input type="text" inputmode="decimal" class="pm-n" data-p="k" data-q="factor" value="${trimNum(p.k, 6)}" /></label>`) + opts(p.copy, p.keep);
    const titles = { linear: "Linear sketch pattern", circular: "Circular sketch pattern", move: "Move entities", rotate: "Rotate entities", scale: "Scale entities" } as const;
    const help = p.kind === "linear" || p.kind === "circular" ? "The green preview shows the instances. Copies keep equal relations to the selected entities." : "The green preview shows where the entities go.";
    pm.innerHTML = `<div class="pm-head"><h3>${esc(t(titles[p.kind]))}</h3></div>`
      + `<p class="pm-help muted">${esc(t(help))}</p>`
      + body
      + `<div class="pm-actions"><button class="btn primary small" data-a="pok">✓ ${esc(t("OK"))}</button><button class="btn small" data-a="pcancel">✕ ${esc(t("Cancel"))}</button></div>`;
    pm.querySelectorAll<HTMLInputElement>("[data-p]").forEach(inp => inp.addEventListener("change", () => {
      const k = inp.dataset.p!, q = inp.dataset.q;
      const pp = ed.pattern as unknown as Record<string, unknown> & { c?: [number, number] };
      if (!pp) return;
      try {
        if (inp.type === "checkbox") { pp[k] = inp.checked; if (k === "copy") { ed.render(); this.renderPanel(); return; } }
        else if (q === "factor") { const v = evaluate(inp.value, "number"); if (!(v > 1e-6)) throw new ExprError("The value must be more than 0."); pp.k = v; }
        else if (q === "count") {
          const n = Math.round(+inp.value);
          if (!(n >= 1 && n <= 500) || (k === "n" && n < 2 && p.kind === "circular")) throw new ExprError("Instances must be a whole number from 1 to 500.");
          pp[k] = n;
        } else {
          const v = q === "angle" ? evaluate(inp.value, "angle", "deg") : evaluate(inp.value, "length", units.current);
          if (k === "cx" || k === "cy") pp.c![k === "cx" ? 0 : 1] = v;
          else if (k === "d" || k === "d2") { if (!(Math.abs(v) > 1e-9)) throw new ExprError("The value must be more than 0."); pp[k] = v; }
          else pp[k] = v;
        }
      } catch (err) { toast(t((err as Error).message), true); this.renderPanel(); return; }
      ed.render();
    }));
    pm.querySelector("[data-a=pok]")!.addEventListener("click", () => { ed.applyPattern(); this.renderPanel(); });
    pm.querySelector("[data-a=pcancel]")!.addEventListener("click", () => { ed.cancelPattern(); this.renderPanel(); });
  }

  private assistMemo: { key: string; sets: string[][] } | null = null;

  /** Sketch assistant (FR-SLV-009): ways out of an over-defined sketch, each shown on the sketch first or applied at once. */
  private assistant(ed: SketchEditor) {
    if (ed.info.status === "ok") return "";
    const sk = ed.sk;
    const key = JSON.stringify([sk.ents, sk.rels, sk.dims]);
    if (this.assistMemo?.key !== key) this.assistMemo = { key, sets: repairs(sk) };
    const sets = this.assistMemo.sets;
    const name = (id: string) => { const r = sk.rels.find(x => x.id === id); if (r) return t(relName(r)); return sk.dims.find(x => x.id === id)?.name ?? id; };
    const sel = ed.selection;
    return `<div class="pm-sec pm-assist"><h4>${esc(t("Sketch assistant"))}</h4>`
      + (sets.length ? `<p class="muted">${esc(t("The sketch is over-defined. Deleting one of these makes it solve again:"))}</p><ul class="pm-rel-list">`
        + sets.map(s => `<li${s.every(id => sel.has(id)) && sel.size === s.length ? ' class="pm-on"' : ""}><span translate="no">${esc(s.map(name).join(" + "))}</span><span><button class="btn small" data-fixshow="${s.join(",")}">${esc(t("Show"))}</button> <button class="btn small" data-fixapply="${s.join(",")}">${esc(t("Delete"))}</button></span></li>`).join("") + `</ul>`
        : `<p class="muted">${esc(t("No single relation or dimension fixes it. Delete the ones marked conflicting until the sketch solves."))}</p>`)
      + `</div>`;
  }

  /** All relations of the sketch with their state (FR-SK-055): select or delete each. */
  /** PropertyManager groups for helix, sweep and loft (FRS 9.9). */
  private p3Panel(f: HelixFeature | SweepFeature | LoftFeature | RibFeature | SplitFeature, sketches: SketchFeature[], group: (legend: string, inner: string) => string,
    numField: (key: string, label: string, n: Num, q: "length" | "angle") => string, chk: (k: string, on: boolean | undefined, label: string) => string): { title: string; body: string } {
    const opt = (v: string, l: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""} translate="no">${esc(l)}</option>`;
    const skOpts = (list: SketchFeature[], cur: string, none?: string) => (none != null ? opt("", none, cur) : "") + list.map(s => opt(s.id, featureLabel(s.name), cur)).join("");
    const sel = (k: string, label: string, inner: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${k}">${inner}</select></label>`;
    if (f.type === "helix") {
      const withCircle = sketches.filter(s => s.ents.some(e => e.t === "circle"));
      const modes: [HelixFeature["mode"], string][] = [["pitchRev", t("Pitch and revolution")], ["heightRev", t("Height and revolution")], ["heightPitch", t("Height and pitch")]];
      const fields = f.mode === "pitchRev" ? numField("pitch", t("Pitch"), f.pitch, "length") + this.countField("revs", t("Revolutions"), f.revs)
        : f.mode === "heightRev" ? numField("height", t("Height"), f.height, "length") + this.countField("revs", t("Revolutions"), f.revs)
        : numField("height", t("Height"), f.height, "length") + numField("pitch", t("Pitch"), f.pitch, "length");
      return { title: t("Helix/Spiral"), body: group(t("Defined by"), sel("hsketch", t("Sketch with a circle"), skOpts(withCircle, f.sketch)) + sel("mode", t("Type"), modes.map(([v, l]) => `<option value="${v}"${v === f.mode ? " selected" : ""}>${esc(l)}</option>`).join("")))
        + group(t("Parameters"), fields + chk("reverse", f.reverse, t("Reverse direction")) + numField("start", t("Start angle"), f.start ?? { v: 0 }, "angle") + chk("cw", f.cw, t("Clockwise")))
        + group(t("Taper helix"), chk("taperOn", !!f.taper, t("Taper helix")) + (f.taper ? numField("taper", t("Angle"), f.taper, "angle") : ""))
        + `<p class="pm-help muted">${esc(t("The helix starts on the sketch's circle and runs along the sketch normal. Use it as a sweep path for springs and threads."))}</p>` };
    }
    if (f.type === "split") {
      const withCurves = sketches.filter(s => s.ents.some(e => !e.cons && e.t !== "point") || s.id === f.sketch);
      return { title: t("Split Line"), body: group(t("Sketch to project"), sel("sketch", t("Sketch"), skOpts(withCurves, f.sketch, f.sketch ? undefined : t("None"))))
        + group(t("Faces to split"), `<p class="pm-count">${esc(f.faces.length ? t("{n} face|{n} faces", { n: f.faces.length }) : t("All faces it crosses"))}</p>`
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : ""))
        + `<p class="pm-help muted">${esc(t("The sketch is projected along its normal, both ways. Click faces to split only those; the body keeps its shape."))}</p>` };
    }
    if (f.type === "rib") {
      const open = sketches.filter(s => sketchOpenOk(s) || s.id === f.sketch);
      const o = (v: string, l: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;
      return { title: t("Rib"), body: group(t("Parameters"), sel("sketch", t("Sketch"), skOpts(open, f.sketch, f.sketch ? undefined : t("None")))
        + sel("side", t("Thickness"), o("one", t("First side"), f.side) + o("mid", t("Both sides"), f.side) + o("other", t("Second side"), f.side))
        + numField("thickness", t("Rib thickness"), f.thickness, "length")
        + sel("dir", t("Extrusion direction"), o("parallel", t("Parallel to sketch"), f.dir) + o("normal", t("Normal to sketch"), f.dir))
        + chk("flip", f.flip, t("Flip material side")))
        + `<p class="pm-help muted">${esc(t("Sketch an open line or arc chain beside the part: the rib runs from it to the body, which closes it. Parallel grows it in the sketch plane, Normal along the sketch normal."))}</p>` };
    }
    if (f.type === "sweep") {
      const at = this.mode.kind === "feature" ? this.mode.index : this.doc.features.length;
      const helices = this.doc.features.slice(0, at).filter(g => g.type === "helix");
      const closed = sketches.filter(sketchProfileOk);
      const pathCur = f.path ? ("helix" in f.path ? `h:${f.path.helix}` : `s:${f.path.sketch}`) : "";
      const paths = opt("", t("None"), pathCur) + helices.map(h => opt(`h:${h.id}`, featureLabel(h.name), pathCur)).join("") + sketches.filter(s => s.id !== f.profile).map(s => opt(`s:${s.id}`, featureLabel(s.name), pathCur)).join("");
      return { title: f.op === "cut" ? t("Cut-Sweep") : t("Sweep"), body: group(t("Profile and path"),
        `<label class="pm-field"><span>${esc(t("Profile"))}</span><select data-k="profileKind"><option value="sketch"${f.circular ? "" : " selected"}>${esc(t("Sketch profile"))}</option><option value="circular"${f.circular ? " selected" : ""}>${esc(t("Circular profile"))}</option></select></label>`
        + (f.circular ? numField("circular", t("Diameter"), f.circular, "length") : sel("swProfile", t("Profile sketch"), skOpts(closed, f.profile ?? "", t("None"))))
        + sel("swPath", t("Path"), paths))
        + group(t("Options"), sel("orient", t("Profile orientation"), `<option value="follow"${f.orient === "normal" ? "" : " selected"}>${esc(t("Follow path"))}</option><option value="normal"${f.orient === "normal" ? " selected" : ""}>${esc(t("Keep normal constant"))}</option>`))
        + `<p class="pm-help muted">${esc(t("The profile moves along the path. A circular profile needs no sketch: it is centred on the start of the path, square to it."))}</p>` };
    }
    const closed = sketches.filter(sketchProfileOk);
    const rows = f.profiles.map((id, i) => sel(`lp${i}`, `${t("Profile")} ${i + 1}`, skOpts(closed, id, t("Remove")))).join("")
      + sel(`lp${f.profiles.length}`, t("Add profile"), skOpts(closed.filter(s => !f.profiles.includes(s.id)), "", "—"));
    return { title: f.op === "cut" ? t("Cut-Loft") : t("Loft"), body: group(t("Profiles"), rows + `<p class="pm-help muted">${esc(t("Profiles are joined in this order. Each is one closed region, usually on parallel planes."))}</p>`)
      + group(t("Options"), chk("ruled", f.ruled, t("Straight sections (ruled)")) + (f.profiles.length >= 3 ? chk("close", f.close, t("Close loft")) : "")) };
  }

  /** PropertyManager for Combine, Split body, Delete/Keep body and Move/Copy body (FRS 9.10). */
  private bodyPanel(f: BodyFeature, focus: Focus | undefined, group: (legend: string, inner: string) => string,
    numField: (key: string, label: string, n: Num, q: "length" | "angle") => string, chk: (k: string, on: boolean | undefined, label: string) => string): { title: string; body: string } {
    const box = (fc: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${focus === fc ? " focus" : ""}" data-focus="${fc}" translate="no">${esc(value)}</button></div>`;
    const n = (k: number) => t("{n} body|{n} bodies", { n: k });
    const list = f.type === "combine" ? f.tools : f.bodies;
    const clear = list.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear bodies"))}</button>` : "";
    const count = this.last?.props?.bodies;
    const status = count ? `<p class="pm-help muted">${esc(t("The part has {n} body|The part has {n} bodies", { n: count }))}</p>` : "";
    const help = `<p class="pm-help muted">${esc(t("Click any face of a body to pick it; click it again to drop it."))}</p>`;
    if (f.type === "combine") {
      const o = (v: string, l: string) => `<option value="${v}"${f.op === v ? " selected" : ""}>${esc(l)}</option>`;
      return { title: t("Combine"), body: group(t("Operation type"), `<label class="pm-field"><span>${esc(t("Operation"))}</span><select data-k="op">${o("add", t("Add"))}${o("subtract", t("Subtract"))}${o("common", t("Common"))}</select></label>`)
        + group(t("Main body"), box("main", t("Body"), f.main ? t("Body picked") : t("None")))
        + group(f.op === "subtract" ? t("Bodies to subtract") : t("Bodies to combine"), box("bodies", t("Bodies"), n(f.tools.length)) + clear) + help + status };
    }
    if (f.type === "bsplit") {
      return { title: t("Split"), body: group(t("Trim tool"), box("mplane", t("Plane"), this.refLabel(f.plane)) + `<p class="pm-help muted">${esc(t("Click a plane or a flat face in the view or the tree."))}</p>`)
        + group(t("Target bodies"), box("bodies", t("Bodies"), f.bodies.length ? n(f.bodies.length) : t("All bodies it cuts")) + clear) + status };
    }
    if (f.type === "delbody") {
      return { title: t("Body-Delete/Keep"), body: group(t("Type"), chk("keep", f.keep, t("Keep these bodies (delete the rest)")))
        + group(t("Bodies"), box("bodies", t("Bodies"), n(f.bodies.length)) + clear) + help + status };
    }
    if (f.type === "scale") {
      const o = (v: string, l: string) => `<option value="${v}"${f.about === v ? " selected" : ""}>${esc(l)}</option>`;
      return { title: t("Scale"), body: group(t("Bodies to scale"), box("bodies", t("Bodies"), f.bodies.length ? n(f.bodies.length) : t("All bodies")) + clear)
        + group(t("Scale parameters"), `<label class="pm-field"><span>${esc(t("Scale about"))}</span><select data-k="about">${o("centroid", t("Centroid"))}${o("origin", t("Origin"))}</select></label>`
          + chk("axes", f.axes, t("Non-uniform (per axis)"))
          + (f.axes ? this.countField("fx", "X", f.fx ?? { v: 1 }) + this.countField("fy", "Y", f.fy ?? { v: 1 }) + this.countField("fz", "Z", f.fz ?? { v: 1 }) : this.countField("factor", t("Scale factor"), f.factor)))
        + help + status };
    }
    return { title: t("Body-Move/Copy"), body: group(t("Bodies to move/copy"), box("bodies", t("Bodies"), n(f.bodies.length)) + clear + chk("copy", f.copy, t("Copy")))
      + group(t("Translate"), numField("dx", "ΔX", f.dx, "length") + numField("dy", "ΔY", f.dy, "length") + numField("dz", "ΔZ", f.dz, "length"))
      + group(t("Rotate"), box("axis", t("Axis"), this.lineLabel(f.axis)) + (f.axis ? numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 2 }, "angle") : ""))
      + help + status };
  }

  /** A positive number field that takes fractions (revolutions). */
  private countField(key: string, label: string, n: Num) {
    return `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-num="${key}" data-q="number" value="${esc(n.expr ?? trimNum(n.v, 6))}" spellcheck="false" /></span></label>`;
  }

  /** Dangling On edge relations (FR-SK-064): what to do about them. */
  private danglingBox(ed: SketchEditor) {
    const n = ed.sk.rels.filter(r => r.ext && r.dangling).length;
    if (!n) return "";
    const first = ed.danglingRels()[0];
    return `<div class="pm-sec pm-dangling" role="status"><p>⚠ ${esc(t("{n} converted curves lost their model edge (dangling). Re-attach them to another edge, or delete the relations to keep the curves free.", { n }))}</p>`
      + `<div class="pm-rels"><button class="btn small" data-reattach="${first.id}">${esc(t("Re-attach"))}</button><button class="btn small danger" data-a="deldangling">${esc(t("Delete dangling relations"))}</button></div>`
      + (ed.reattaching ? `<p class="muted">${esc(t("Click the model edge the curve should follow now."))}</p>` : "")
      + `</div>`;
  }

  /** One dimension selected: its name, as expressions use it (FR-SK-065). */
  private dimNameBox(ed: SketchEditor) {
    const ids = [...ed.selection];
    const d = ids.length === 1 ? ed.sk.dims.find(x => x.id === ids[0]) : undefined;
    if (!d) return "";
    return `<div class="pm-sec"><h4>${esc(t("Dimension"))}</h4><label class="pm-field"><span>${esc(t("Name"))}</span><span class="pm-in"><input type="text" data-a="dimname" data-id="${d.id}" value="${esc(d.name)}" spellcheck="false" translate="no" /><span class="muted" translate="no">@${esc(ed.sk.name)}</span></span></label></div>`;
  }

  private relationList(ed: SketchEditor) {
    const sk = ed.sk;
    const bad = new Set(ed.info.conflicting ?? []);
    const rels = sk.rels;
    if (!rels.length) return `<p class="muted">${esc(t("None yet."))}</p>`;
    const sel = ed.selection;
    const shown = sel.size ? rels.filter(r => sel.has(r.id) || r.e.some(x => sel.has(x))) : rels;
    return (sel.size ? `<p class="muted">${esc(t("Relations of the selection:"))}</p>` : "")
      + `<ul class="pm-rel-list">${shown.map(r => `<li${bad.has(r.id) ? ' class="pm-err"' : r.dangling ? ' class="pm-dangling"' : ""}><span><button class="link" data-selrel="${r.id}">${esc(t(relName(r)))}</button>${bad.has(r.id) ? ` · ${esc(t("conflicting"))}` : r.dangling ? ` · ${esc(t("dangling"))} <button class="link" data-reattach="${r.id}">${esc(t("Re-attach"))}</button>` : ""}</span><button class="icon" data-delrel="${r.id}" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))} ${esc(t(relName(r)))}">✕</button></li>`).join("")}</ul>`;
  }

  /** Exact body properties from the last rebuild (density 1). */
  bodyProps() { return this.last?.props ?? null; }

  /** The part's mass property override (FR-MAT-004), if any. */
  massOverride() { return this.store?.doc.massOverride ?? null; }

  /** The open sketch's normal (Normal to). */
  sketchNormal(): V3 | null { const m = this.mode; return m.kind === "sketch" ? m.editor.frame.n : null; }

  /** The normal of the standard or reference plane selected in the tree or the view, if any. */
  selectedPlaneNormal(): V3 | null {
    const id = this.selected;
    if (!id) return null;
    if (id.startsWith("std:")) return STD_FRAMES[id.slice(4) as "XY" | "XZ" | "YZ"]?.n ?? null;
    return this.store?.feature(id)?.type === "plane" ? this.last?.frames[id]?.n ?? null : null;
  }

  /** Test and debug handle. */
  debug() {
    const self = this;
    return { get store() { return self.store; }, last: () => this.last, mode: () => this.mode, editor: () => (this.mode.kind === "sketch" ? this.mode.editor : null), rebuild: () => this.rebuild(), panel: () => this.renderPanel(), kernel: this.kernel };
  }
}

// ---------- helpers ----------

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function pushEdge(pos: number[], ed: EdgeInfo) {
  const p = ed.pts;
  for (let i = 0; i + 5 < p.length; i += 3) pos.push(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]);
}

/** Line segments of a sketch's curves in world space (for sketches shown outside the sketcher). */
function sketchSegments(sk: SketchFeature, f: Frame): number[] {
  const pts = new Map<string, [number, number]>([[ORIGIN, [0, 0]]]);
  for (const e of sk.ents) if (e.t === "point") pts.set(e.id, [e.x, e.y]);
  const w = (p: [number, number]) => [f.o[0] + f.x[0] * p[0] + f.y[0] * p[1], f.o[1] + f.x[1] * p[0] + f.y[1] * p[1], f.o[2] + f.x[2] * p[0] + f.y[2] * p[1]];
  const out: number[] = [];
  const seg = (a: [number, number], b: [number, number]) => out.push(...w(a), ...w(b));
  const arc = (c: [number, number], r: number, a0: number, a1: number) => {
    const n = Math.max(8, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 64));
    for (let i = 0; i < n; i++) {
      const u = a0 + ((a1 - a0) * i) / n, v = a0 + ((a1 - a0) * (i + 1)) / n;
      seg([c[0] + r * Math.cos(u), c[1] + r * Math.sin(u)], [c[0] + r * Math.cos(v), c[1] + r * Math.sin(v)]);
    }
  };
  for (const e of sk.ents) {
    if (e.cons) continue;
    if (e.t === "line") seg(pts.get(e.a)!, pts.get(e.b)!);
    else if (e.t === "circle") arc(pts.get(e.c)!, e.r, 0, 2 * Math.PI);
    else if (e.t === "arc") {
      const c = pts.get(e.c)!, a = pts.get(e.a)!, b = pts.get(e.b)!;
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      while (a1 <= a0) a1 += 2 * Math.PI;
      arc(c, Math.hypot(a[0] - c[0], a[1] - c[1]), a0, a1);
    } else if (e.t === "ellipse") {
      const E = ellOf(pts.get(e.c)!, pts.get(e.a)!, pts.get(e.b)!);
      const t0 = e.p0 && e.p1 ? ellParam(E, pts.get(e.p0)!) : 0;
      const line = e.p0 && e.p1 ? ellPts(E, t0, ellSweep(t0, ellParam(E, pts.get(e.p1)!)), 48) : ellPts(E, 0, 2 * Math.PI, 64);
      for (let i = 0; i + 1 < line.length; i++) seg(line[i], line[i + 1]);
    } else if (e.t === "spline" && e.pts.length >= 2) {
      const line = bezPts(splineBezier(e.pts.map(q => pts.get(q)!), !!e.closed && e.pts.length >= 3), 16);
      for (let i = 0; i + 1 < line.length; i++) seg(line[i], line[i + 1]);
    }
  }
  return out;
}

const S = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/** Whether a feature uses a sketch up (SolidWorks hides it once used). */
function absorbs(g: Feature, sketch: string): boolean {
  if (g.type === "extrude" || g.type === "revolve" || g.type === "helix") return g.sketch === sketch;
  if (g.type === "sweep") return g.profile === sketch || (!!g.path && "sketch" in g.path && g.path.sketch === sketch);
  if (g.type === "loft") return g.profiles.includes(sketch);
  if (g.type === "rib" || g.type === "split" || g.type === "planesurf" || g.type === "extsurf") return g.sketch === sketch;
  return false;
}

/** A sketch with closed regions (usable as a sweep or loft profile). */
const sketchProfileOk = (s: SketchFeature) => !sketchProfile(s).error;
/** A sketch that is one open chain of curves (a rib line). */
const sketchOpenOk = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && !p.closed; };

/** The sweep flyout's commands (FRS 9.9). */
const P3_TOOLS = (): [string, string, string][] => [
  ["sweep", t("Sweep"), t("Swept boss: a profile (or a circle) along a path")],
  ["sweepcut", t("Cut-Sweep"), t("Swept cut: removes a profile moved along a path")],
  ["loft", t("Loft"), t("Lofted boss: through two or more profiles")],
  ["loftcut", t("Cut-Loft"), t("Lofted cut: removes material through two or more profiles")],
  ["helix", t("Helix/Spiral"), t("Helix: a curve round a sketch circle, for springs and threads")],
  ["rib", t("Rib"), t("Rib: a thin wall from an open sketch line to the body")],
  ["split", t("Split Line"), t("Split line: project a sketch onto faces to split them")],
  ["import", t("Insert body"), t("Insert body: a part, STEP, IGES or BREP file into this part, with check and heal")],
  ["combine", t("Combine"), t("Combine bodies: add, subtract or keep the common part")],
  ["bsplit", t("Split"), t("Split bodies with a plane into separate bodies")],
  ["movebody", t("Body-Move/Copy"), t("Move or copy bodies: translate and rotate")],
  ["delbody", t("Body-Delete/Keep"), t("Delete bodies, or keep only the picked ones")],
  ["scale", t("Scale"), t("Scale bodies: uniform or per axis, about the centroid or the origin")],
  ["moveface", t("Move Face"), t("Move face: push flat faces out or in along their normals, on any body")],
  ["delface", t("Delete Face"), t("Delete face: remove faces and heal the gap, on any body")],
];

/** The surface flyout's commands (FRS 9.11). */
type SurfTool = "planesurf" | "extsurf" | "offsurf" | "knit" | "thicken" | "replaceface";
const SURF_TYPES: ReadonlySet<string> = new Set(["planesurf", "extsurf", "offsurf", "knit", "thicken", "replaceface"]);
const SURF_TOOLS = (): [SurfTool, string, string][] => [
  ["extsurf", t("Extruded Surface"), t("Extruded surface: sketch curves swept into open surfaces")],
  ["planesurf", t("Planar Surface"), t("Planar surface: a flat surface inside a closed sketch")],
  ["offsurf", t("Offset Surface"), t("Offset surface: copies of faces at a distance")],
  ["knit", t("Knit Surface"), t("Knit surfaces into one, or into a solid when they close a volume")],
  ["thicken", t("Thicken"), t("Thicken a surface into a solid")],
  ["replaceface", t("Replace Face"), t("Replace faces of a solid with a surface")],
];

const ICON_SVG: Record<string, string> = {
  extsurf: S('<path d="M2 12c2-3 4-3 6 0s4 3 6 0"/><path d="M2 7c2-3 4-3 6 0s4 3 6 0"/><path d="M2 7v5M14 7v5"/>'),
  planesurf: S('<path d="M2 11l4-7h8l-4 7z" fill="currentColor" fill-opacity=".2"/>'),
  offsurf: S('<path d="M2 13c3-4 9-4 12 0"/><path d="M2 8c3-4 9-4 12 0" stroke-dasharray="2 1.5"/><path d="M8 10V6"/>'),
  knit: S('<path d="M2 4h5v8H2zM9 4h5v8H9z"/><path d="M7 6h2M7 8h2M7 10h2"/>'),
  replaceface: S('<path d="M2 14V7h10v7z"/><path d="M1 6c4-3 9-3 14 0" stroke-dasharray="2 1.5"/><path d="M7 9V5"/>'),
  thicken: S('<path d="M2 9c3-3 9-3 12 0v3c-3-3-9-3-12 0z" fill="currentColor" fill-opacity=".2"/>'),
  sweep: S('<path d="M3 13c0-6 4-10 10-10"/><circle cx="3" cy="13" r="1.8"/><circle cx="13" cy="3" r="1.8"/>'),
  sweepcut: S('<path d="M2 6h12v8H2z"/><path d="M4 12c2-4 5-5 8-5" stroke-dasharray="2 1.5"/>'),
  loft: S('<path d="M3 13h6v-2H3zM9 4h4v3H9z"/><path d="M3 11l6-7M9 11l4-4"/>'),
  loftcut: S('<path d="M2 6h12v8H2z"/><path d="M5 12h3l3-4H9z" fill="currentColor" fill-opacity=".3"/>'),
  import: S('<path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 11v3h10v-3"/>'),
  combine: S('<circle cx="6" cy="8" r="4"/><circle cx="10" cy="8" r="4"/>'),
  bsplit: S('<path d="M2 4h12v9H2z"/><path d="M9 2l-2 13"/>'),
  movebody: S('<path d="M2 9h6v5H2z"/><path d="M8 9l3-3h3v5l-3 3M9 3h5v5"/>'),
  scale: S('<path d="M2 14V8h6v6z"/><path d="M8 8l6-6M10 2h4v4"/>'),
  delbody: S('<path d="M3 5h10v9H3z"/><path d="M5 7l6 6M11 7l-6 6"/>'),
  moveface: S('<path d="M2 8h9v6H2z"/><path d="M6 8V3M4 5l2-2 2 2"/><path d="M2 8l3-3h9l-3 3M14 5v6l-3 3"/>'),
  delface: S('<path d="M2 6h9v8H2z"/><path d="M2 6l3-3h9l-3 3M14 3v8l-3 3"/><path d="M12 1l3 3M15 1l-3 3"/>'),
  split: S('<path d="M2 4h12v9H2z"/><path d="M8 1v14" stroke-dasharray="2 1.5"/>'),
  rib: S('<path d="M2 14h12M3 14V3"/><path d="M3 5l9 9" stroke-width="2.6"/>'),
  helix: S('<path d="M4 14c4 0 8-1 8-2s-8-1-8-2 8-1 8-2-8-1-8-2 8-1 8-2"/>'),
  sketch: S('<path d="M2.5 13.5 4 9.5l7-7 2.5 2.5-7 7z"/><path d="M9.5 4 12 6.5"/>'),
  extrude: S('<path d="M3 11h7v3H3z"/><path d="M3 11l3-3h7l-3 3M13 8v3l-3 3"/><path d="M8 7V2M6 4l2-2 2 2"/>'),
  cut: S('<path d="M2 6h12v8H2z"/><path d="M6 6v4h4V6" fill="currentColor" fill-opacity=".3"/><path d="M8 4V1M6.5 2.5 8 4l1.5-1.5"/>'),
  revolve: S('<path d="M8 1.5v13" stroke-dasharray="2 1.5"/><path d="M12.5 8a4.5 2 0 1 1-9 0"/><path d="M3.5 8a4.5 2 0 0 1 8-1.2M11.5 6.8l.4-1.6M11.5 6.8l-1.6-.2"/>'),
  fillet: S('<path d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5"/>'),
  chamfer: S('<path d="M2.5 13.5V7l4.5-4.5h6.5"/>'),
  undo: S('<path d="M5 3 2 6l3 3"/><path d="M2 6h7.5a4 4 0 0 1 0 8H6"/>'),
  redo: S('<path d="m11 3 3 3-3 3"/><path d="M14 6H6.5a4 4 0 0 0 0 8H10"/>'),
  save: S('<path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v3.5h5V2.5M5 13.5V9h6v4.5"/>'),
  step: S('<path d="M8 10V2M5 5l3-3 3 3M3 9.5v4h10v-4"/>'),
  exit: S('<path d="m3 8.5 3 3 7-7"/>'),
  normal: S('<path d="M1.5 12 4.5 7h10l-3 5z"/><path d="M8 9.5V1.5M6 3.5l2-2 2 2"/>'),
  edit: S('<path d="M2.5 2.5h7v4"/><path d="M2.5 2.5v11h5"/><path d="m8.5 13.5.5-2.5 4.5-4.5 2 2-4.5 4.5z"/>'),
  editsk: S('<path d="M2 12.5h7M2 12.5 6 5"/><path d="m9 13.5.5-2.5 4-4 2 2-4 4z"/>'),
  thread: S('<path d="M4 2.5h8M4 13.5h8M4 2.5v11M12 2.5v11"/><path d="M4 5.5l8-1.5M4 8.5l8-1.5M4 11.5l8-1.5" stroke-dasharray="1.6 1.2"/>'),
  hole: S('<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v7M13 4.5v7"/><path d="M3 11.5a5 2 0 0 0 10 0"/><ellipse cx="8" cy="4.5" rx="2.2" ry=".9" fill="currentColor"/>'),
  shell: S('<path d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3z"/><path d="M5 6.3 8 4.6l3 1.7v3.4L8 11.4 5 9.7z" fill="currentColor" fill-opacity=".3"/>'),
  draft: S('<path d="M3 13.5h10"/><path d="M4.5 13.5 6.5 3h4l1 10.5" fill="currentColor" fill-opacity=".3"/><path d="M8 2.5v4" stroke-dasharray="1.5 1.2"/>'),
  mirror: S('<path d="M8 1.5v13" stroke-dasharray="2 1.5"/><path d="M6 4 2.5 11H6z"/><path d="M10 4l3.5 7H10z" opacity=".55"/>'),
  lpattern: S('<rect x="1.5" y="6" width="3.5" height="3.5"/><rect x="6.25" y="6" width="3.5" height="3.5" opacity=".7"/><rect x="11" y="6" width="3.5" height="3.5" opacity=".45"/><path d="M2 13h12M12 11.5l2 1.5-2 1.5"/>'),
  cpattern: S('<circle cx="8" cy="8" r="1"/><circle cx="8" cy="3" r="1.6"/><circle cx="12.5" cy="10.5" r="1.6" opacity=".7"/><circle cx="3.5" cy="10.5" r="1.6" opacity=".45"/>'),
  filter: S('<path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"/>'),
  "sel:faces": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" fill="currentColor" fill-opacity=".35"/>'),
  "sel:edges": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" opacity=".35"/><path d="M8 8.5v6" stroke-width="2.4"/>'),
  "sel:vertices": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" opacity=".35"/><circle cx="8" cy="8.5" r="2" fill="currentColor"/>'),
  skmirror: S('<path d="M8 1.5v13" stroke-dasharray="1.6 1.4"/><path d="M6 4 2.5 12H6z"/><path d="M10 4l3.5 8H10z" opacity=".55"/>'),
  sklpat: S('<rect x="1.5" y="6" width="3" height="4"/><rect x="6.5" y="6" width="3" height="4" opacity=".6"/><rect x="11.5" y="6" width="3" height="4" opacity=".35"/>'),
  skcpat: S('<circle cx="8" cy="8" r="1"/><circle cx="8" cy="2.8" r="1.6"/><circle cx="12.5" cy="10.6" r="1.6" opacity=".6"/><circle cx="3.5" cy="10.6" r="1.6" opacity=".35"/>'),
  skmove: S('<path d="M8 1.5v13M1.5 8h13"/><path d="M6 3.5 8 1.5l2 2M6 12.5l2 2 2-2M3.5 6 1.5 8l2 2M12.5 6l2 2-2 2"/>'),
  skrot: S('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M12 1.8v2.9H9.1"/>'),
  skscale: S('<rect x="1.5" y="8.5" width="6" height="6"/><rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="1.6 1.4"/><path d="M8.5 7.5l4-4M9.5 3.5h3v3"/>'),
  skdxf: S('<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/><path d="M5.5 9.5h5M5.5 12h5"/>'),
  cons: S('<path d="M2 14 14 2" stroke-dasharray="2.2 1.8"/>'),
  "sk:select": S('<path d="M3 2l9 5-4 1.2L6.5 13z"/>'),
  "sk:line": S('<path d="M3 13 13 3"/><circle cx="3" cy="13" r="1.3" fill="currentColor"/><circle cx="13" cy="3" r="1.3" fill="currentColor"/>'),
  "sk:rect": S('<path d="M2.5 4h11v8h-11z"/>'),
  "sk:crect": S('<path d="M2.5 4h11v8h-11z"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:circle": S('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:arc": S('<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><circle cx="8" cy="11" r=".9" fill="currentColor"/>'),
  "sk:point": S('<circle cx="8" cy="8" r="2" fill="currentColor"/>'),
  axis: S('<path d="M2 14 14 2" stroke-dasharray="4 1.5 1 1.5"/>'),
  point: S('<path d="M8 3v10M3 8h10M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  csys: S('<path d="M3 13h10M3 13V3M3 13l-1.5 1.5"/><path d="M11 11l2 2-2 2M1.5 5 3 3l1.5 2"/>'),
  plane: S('<path d="M1.5 11 5 4h9.5L11 11z"/><path d="M8 7.5v-6M6.5 3 8 1.5 9.5 3" />'),
  "sk:circle3": S('<circle cx="8" cy="8" r="5.5"/><circle cx="2.5" cy="8" r="1.1" fill="currentColor"/><circle cx="12" cy="4.3" r="1.1" fill="currentColor"/><circle cx="11" cy="12.6" r="1.1" fill="currentColor"/>'),
  "sk:arc3": S('<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><circle cx="2.5" cy="11" r="1.1" fill="currentColor"/><circle cx="13.5" cy="11" r="1.1" fill="currentColor"/><circle cx="8" cy="5.5" r="1.1" fill="currentColor"/>'),
  "sk:polygon": S('<path d="M8 2 13.7 6.1 11.5 12.9h-7L2.3 6.1z"/>'),
  "sk:trim": S('<path d="M2 13 13 2" stroke-dasharray="2 2"/><path d="M2 8h12"/><circle cx="5" cy="11" r="1.6"/><circle cx="11" cy="11" r="1.6"/><path d="M6.2 9.9 9.8 6M9.8 9.9 6.2 6"/>'),
  "sk:spline": S('<path d="M2 12c2.5-8 5-8 6-4s3.5 4 6-4"/><circle cx="2" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="14" cy="4" r="1" fill="currentColor"/>'),
  "sk:ellipse": S('<ellipse cx="8" cy="8" rx="6" ry="3.5" transform="rotate(-25 8 8)"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/>'),
  "sk:earc": S('<path d="M2.6 10.5A6 3.5 -25 0 1 13.4 5.5"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><path d="M8 8 13.4 5.5" stroke-dasharray="1.2 1.4"/>'),
  "sk:slot": S('<path d="M5 4.5h6a3.5 3.5 0 0 1 0 7H5a3.5 3.5 0 0 1 0-7z"/><path d="M5 8h6" stroke-dasharray="1.5 1.5"/>'),
  "sk:extend": S('<path d="M2 12 9 5"/><path d="M9 5l3.5-3.5" stroke-dasharray="1.5 1.5"/><path d="M10 14 14 2"/>'),
  "sk:split": S('<path d="M2 12 7 7M9 5l5-5"/><circle cx="8" cy="6" r="1.4"/>'),
  "sk:chamfer": S('<path d="M2.5 13.5V7l4.5-4.5h6.5"/>'),
  "sk:offset": S('<path d="M2.5 13.5V5.5a3 3 0 0 1 3-3h8"/><path d="M6 13.5V8a2 2 0 0 1 2-2h5.5" stroke-dasharray="1.5 1.5"/>'),
  "sk:intersect": S('<path d="M2 11.5 8 8.5l6 3" opacity=".5"/><path d="M2 6h12" /><path d="M4.5 3.5v5M11.5 3.5v5" opacity=".5"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="11.5" cy="6" r="1.2" fill="currentColor"/>'),
  "sk:convert": S('<path d="M3 11 8 3l5 8z" opacity=".5"/><path d="M3 13.5h10"/><path d="M8 7v4m-2-2 2 2 2-2"/>'),
  "sk:fillet": S('<path d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5"/><path d="M2.5 2.5h3M2.5 2.5v3" stroke-dasharray="1.5 1.5"/>'),
  "sk:dim": S('<path d="M2.5 4v8M13.5 4v8M2.5 8h11M5 6 2.5 8 5 10M11 6l2.5 2L11 10"/>'),
  "sk:hord": S('<path d="M3 13V4M8 13V4M13 13V4"/><path d="M2 13h12" opacity=".5"/><path d="M2.5 2.5h1M7 2.5h2M12 2.5h2"/>'),
  "sk:vord": S('<path d="M3 3h9M3 8h9M3 13h9"/><path d="M3 2v12" opacity=".5"/><path d="M13.5 2.5v1M13.5 7v2M13.5 12v2"/>'),
};
