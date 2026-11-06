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
import { DocStore, dependants, newPart, nextName, uid } from "./doc";
import { evaluate, ExprError, isPlain } from "./expr";
import { journalDrop, journalList, journalSave, packPart, unpackPart, PART_EXT, type JournalEntry } from "./file";
import { ModelKernel, type Rebuild } from "./kernelClient";
import type {
  ChamferFeature, EdgeRef, ExtrudeFeature, Feature, FeatureStatus, FilletFeature, Frame, Num, PartDoc, PlaneRef,
  RevolveFeature, SketchFeature, V3,
} from "./types";
import { STD_FRAMES } from "../kernel/model";
import { SketchEditor, REL_NAME, trimNum, type SkTool } from "../sketch/editor";
import { ORIGIN } from "../sketch/solver";
import { units, UNITS } from "../tools/units";
import { confirmModal, toast } from "../ui";
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
  /** The face picked with Smart measure, if any (used as the sketch plane). */
  selectedFace(): number | null;
  /** Clears Smart measure's pick and highlights. */
  clearPick(): void;
  setDoc(label: string): void;
  selectLeftTab(tab: "features" | "tree"): void;
  appVersion: string;
}

type Mode =
  | { kind: "none" }
  | { kind: "plane" }
  | { kind: "sketch"; id: string; editor: SketchEditor; entry: string; isNew: boolean }
  | { kind: "feature"; draft: Feature; index: number; isNew: boolean };

const DEFAULT_COLOR: V3 = [0.72, 0.75, 0.8];
const STD_NAMES: Record<"XY" | "XZ" | "YZ", string> = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };
const ICONS: Record<string, string> = { sketch: "✎", extrude: "▰", cut: "▱", revolve: "↻", fillet: "◜", chamfer: "◺", plane: "▭", part: "◆" };
const BASES = ["Revolve cut", "Sketch", "Extrude", "Cut", "Revolve", "Fillet", "Chamfer"];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** A default feature name ("Extrude2") in the interface language; renamed features stay as typed. */
export function featureLabel(name: string) {
  for (const b of BASES) { const m = name.match(new RegExp(`^${b}(\\d+)$`)); if (m) return `${t(b)}${m[1]}`; }
  return name;
}

/** Kernel messages are fixed English sentences; a lost reference names internal ids, so it gets a plain one. */
function statusText(s: FeatureStatus) {
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
  private selected: string | null = null;
  private journalTimer = 0;
  private shownOnce = false;
  private decor = new THREE.Group();
  private planeMeshes: THREE.Mesh[] = [];
  private lineMats: LineMaterial[] = [];
  private down: { x: number; y: number } | null = null;
  private busyCount = 0;
  private rebuildMs = 0;

  constructor(private host: ModelHost, occtBase: string) {
    this.kernel = new ModelKernel(occtBase);
    this.kernel.onCrash = () => toast(t("The geometry kernel stopped; it was restarted."), "warn");
    host.viewer.scene.add(this.decor);
    host.viewer.beforeRender.push(() => { for (const m of this.lineMats) m.resolution.set(host.viewer.size.x, host.viewer.size.y); });
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
  get picking() { return this.mode.kind !== "none"; }
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
    this.exitMode(false);
    this.fileName = fileName;
    this.handle = handle;
    this.selected = null;
    this.shownOnce = false;
    this.last = null;
    if (this.store) this.store.reset(doc);
    else {
      this.store = new DocStore(doc);
      this.store.onChange(why => this.changed(why));
    }
    document.getElementById("app")!.classList.add("model");
    this.host.viewer.emptySize = 50;
    $("#t-features").hidden = false;
    this.host.selectLeftTab("features");
    this.renderAll();
    void this.rebuild();
  }

  /** Another file was opened in the viewer: leave modelling (the journal keeps unsaved work). */
  close() {
    if (!this.store) return;
    this.exitMode(false);
    if (this.store.dirty) journalSave(this.doc, this.fileName);
    this.store = null;
    this.last = null;
    this.clearDecor();
    this.kernel.stop();
    document.getElementById("app")!.classList.remove("model");
    this.host.viewer.emptySize = 1;
    $("#t-features").hidden = true;
    this.host.selectLeftTab("tree");
    this.renderRecovery();
  }

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
    this.host.setDoc(this.docLabel());
    if (why !== "saved" && why !== "open") {
      clearTimeout(this.journalTimer);
      this.journalTimer = window.setTimeout(() => { if (this.store?.dirty) journalSave(this.doc, this.fileName); }, 800);
    }
  }

  private docLabel() { return `${this.displayName()}${this.store?.dirty ? " •" : ""}`; }

  /** The document as shown: with the open command's draft, rolled back while a sketch or a pick is open. */
  private displayDoc(): PartDoc {
    const d: PartDoc = structuredClone(this.doc);
    const m = this.mode;
    if (m.kind === "sketch") {
      const i = d.features.findIndex(f => f.id === m.id);
      d.rollback = i + 1;
    } else if (m.kind === "feature") {
      const f = structuredClone(m.draft);
      if (m.isNew) d.features.splice(m.index, 0, f); else d.features[m.index] = f;
      // Fillet and chamfer pick edges on the body before them; extrude and revolve preview live.
      d.rollback = f.type === "fillet" || f.type === "chamfer" ? m.index : m.index + 1;
    }
    return d;
  }

  private async rebuild() {
    if (!this.store) return;
    const doc = this.displayDoc();
    this.setBusy(1);
    const r = await this.kernel.rebuild(doc, doc.color ?? DEFAULT_COLOR, 1);
    this.setBusy(-1);
    if (!r || !this.store) return;
    this.last = r;
    this.rebuildMs = r.ms.eval + r.ms.mesh;
    const first = !this.shownOnce;
    this.shownOnce = true;
    this.host.show(r.data, this.doc.name, first);
    this.host.setDoc(this.docLabel());
    if (first && !r.data) this.host.viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
    this.drawDecor();
    this.renderTree();
    this.renderStatus();
    if (this.mode.kind === "feature") this.renderPanel();
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
    const fid = this.host.selectedFace();
    const pr = fid != null ? this.planeOfFace(fid) : null;
    if (pr) { void this.createSketch(pr); return; }
    const sel = this.selected && this.selected.startsWith("std:") ? this.selected.slice(4) as "XY" | "XZ" | "YZ" : null;
    if (sel) { void this.createSketch({ std: sel }); return; }
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
    this.mode = { kind: "none" };
    this.store!.change("New sketch", d => { d.features.push({ id, type: "sketch", name: nextName(d, "sketch"), plane, ents: [], rels: [], dims: [] }); });
    await this.editSketch(id, before, true);
  }

  async editSketch(id: string, entry = JSON.stringify(this.doc), isNew = false) {
    const sk = this.store?.feature(id);
    if (!sk || sk.type !== "sketch") return;
    this.exitMode(false);
    this.host.clearPick();
    // Face sketches need the face's frame from a rebuild up to the sketch.
    const editor = new SketchEditor({
      viewer: this.host.viewer,
      layer: $("#sk-layer"),
      commit: (label, next) => this.store!.change(label, d => { const i = d.features.findIndex(f => f.id === id); if (i >= 0) d.features[i] = next; }),
      status: text => { $("#mc-status").textContent = text; },
      toast: (msg, kind) => toast(msg, kind ?? "info"),
      unit: () => ({ mm: 1 / UNITS[units.current].f, name: units.current, decimals: units.decimals ?? this.doc.units.decimals }),
      onSelection: () => this.renderPanel(),
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
  startFeature(type: "extrude" | "cut" | "revolve" | "fillet" | "chamfer") {
    if (!this.store) return;
    this.exitMode(false);
    const d = this.doc;
    const sketches = d.features.filter((f): f is SketchFeature => f.type === "sketch");
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
    } else {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      draft = type === "fillet"
        ? { id, type: "fillet", name: nextName(d, "fillet"), radius: { v: 2 }, edges: [] } satisfies FilletFeature
        : { id, type: "chamfer", name: nextName(d, "chamfer"), distance: { v: 1 }, edges: [] } satisfies ChamferFeature;
    }
    const index = d.rollback ?? d.features.length;
    this.mode = { kind: "feature", draft, index, isNew: true };
    this.host.clearPick();
    this.renderAll();
    void this.rebuild();
  }

  editFeature(id: string) {
    const i = this.doc.features.findIndex(f => f.id === id);
    const f = this.doc.features[i];
    if (!f) return;
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
    if (m.kind === "sketch") { this.exitMode(true); void this.rebuild(); return; }
    if (m.kind === "plane") { toast(t("Pick a plane or a flat face for the sketch.")); return; }
    if (m.kind !== "feature") return;
    const f = m.draft;
    if ((f.type === "fillet" || f.type === "chamfer") && !f.edges.length) { toast(t("Pick at least one edge."), true); return; }
    if (f.type === "revolve" && !f.axis) { toast(t("Pick a line of the sketch as the axis."), true); return; }
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
    this.clearDecor();
    if (this.store) this.renderAll();
  }

  toggleSuppress(id: string) {
    const f = this.store?.feature(id);
    if (!f) return;
    this.store!.change(f.suppressed ? `Unsuppress ${f.name}` : `Suppress ${f.name}`, d => {
      const g = d.features.find(x => x.id === id)!;
      if (g.suppressed) delete g.suppressed; else g.suppressed = true;
    });
  }

  async deleteFeature(id: string) {
    const f = this.store?.feature(id);
    if (!f) return;
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
    toast(t("Saved {name}", { name: this.fileName }), "success");
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
      if (m.kind === "sketch" && m.editor.pointerDown(e)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    vp.addEventListener("pointermove", e => {
      if (!onCanvas(e)) return;
      const m = this.mode;
      if (m.kind === "sketch" && m.editor.pointerMove(e)) e.stopPropagation();
    }, true);
    vp.addEventListener("pointerup", e => {
      if (!onCanvas(e)) return;
      const m = this.mode;
      if (m.kind === "sketch") { if (m.editor.pointerUp(e)) e.stopPropagation(); return; }
      const d = this.down;
      this.down = null;
      if (e.button !== 0 || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      // Not stopped: the orbit controls must see the button go up. Smart measure skips these clicks (`picking`).
      if (m.kind === "plane") this.pickPlane(e);
      else if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) this.pickEdge(e);
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
    if (mod || e.altKey) return;
    const m = this.mode;
    if (m.kind === "sketch") {
      if (k === "enter") { stop(); this.ok(); return; }
      if (m.editor.key(e)) { stop(); this.renderBar(); return; }
      if (k === "escape") { stop(); void this.cancel(); }
      return;
    }
    if (m.kind === "feature" || m.kind === "plane") {
      if (k === "escape") { stop(); void this.cancel(); }
      else if (k === "enter") { stop(); this.ok(); }
      return;
    }
    if ((k === "delete" || k === "backspace") && this.selected && !this.selected.startsWith("std:") && tg.closest?.("#tab-features")) { stop(); void this.deleteFeature(this.selected); }
  }

  private pickPlane(e: PointerEvent) {
    // Standard planes drawn in the view first, then model faces.
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const ph = rc.intersectObjects(this.planeMeshes, false)[0];
    const f = this.host.faceAt(e.clientX, e.clientY);
    const fd = f ? new THREE.Vector3(...f.point).distanceTo(rc.ray.origin) : Infinity;
    if (f && (!ph || fd <= ph.distance + 1e-6)) {
      const pr = this.planeOfFace(f.faceId);
      if (pr) void this.createSketch(pr);
      return;
    }
    if (ph) void this.createSketch({ std: ph.object.userData.std });
  }

  private pickEdge(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || (m.draft.type !== "fillet" && m.draft.type !== "chamfer")) return;
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    const data = this.host.viewer.parts[0]?.data;
    const names = this.last?.faceNames ?? [];
    if (!hit || !data) return;
    const edges = hit.edge ? [hit.edge] : data.edges.filter(x => x.faces.includes(hit.faceId!));
    const refs: EdgeRef[] = [];
    for (const ed of edges) {
      const [a, b] = ed.faces;
      if (a === b || !names[a] || !names[b]) continue;
      refs.push({ faces: [names[a], names[b]], hint: ed.mid });
    }
    if (!refs.length) { toast(t("That edge cannot be rounded (it is not between two faces).")); return; }
    const list = m.draft.edges;
    const same = (x: EdgeRef, y: EdgeRef) => this.edgeOf(x) === this.edgeOf(y) && this.edgeOf(x) != null;
    // One edge toggles; a face adds its edges (or removes them when all are in).
    if (refs.length === 1 && list.some(x => same(x, refs[0]))) m.draft.edges = list.filter(x => !same(x, refs[0]));
    else if (refs.every(r => list.some(x => same(x, r)))) m.draft.edges = list.filter(x => !refs.some(r => same(x, r)));
    else for (const r of refs) if (!list.some(x => same(x, r))) list.push(r);
    this.drawDecor();
    this.renderPanel();
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
      (o.material as THREE.Material)?.dispose?.();
    }
    this.decor.clear();
    this.planeMeshes = [];
    this.lineMats = [];
    this.host.viewer.invalidate();
  }

  private lines(pos: number[], color: number, width: number, dashed = false) {
    if (!pos.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    const mat = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest: false, transparent: true, dashed, dashSize: 3, gapSize: 2 });
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
    const used = new Set(this.doc.features.flatMap(f => (f.type === "extrude" || f.type === "revolve" ? [f.sketch] : [])));
    if (m.kind === "feature" && (m.draft.type === "extrude" || m.draft.type === "revolve")) used.add(m.draft.sketch);
    const end = this.doc.rollback ?? this.doc.features.length;
    this.doc.features.slice(0, end).forEach(f => {
      if (f.type !== "sketch" || f.suppressed || used.has(f.id) || (m.kind === "sketch" && m.id === f.id)) return;
      this.lines(sketchSegments(f, this.frameOf(f)), dark ? 0x8ab4ff : 0x1d4ed8, 1.4);
    });
    if (m.kind === "plane") this.drawPlanes();
    if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) {
      const pos: number[] = [];
      for (const r of m.draft.edges) { const ed = this.edgeOf(r); if (ed) pushEdge(pos, ed); }
      this.lines(pos, 0xf08c00, 4);
    }
    this.host.viewer.invalidate();
  }

  private drawPlanes() {
    const v = this.host.viewer;
    const b = v.parts.length ? v.bounds : null;
    const s = b && !b.isEmpty() ? Math.max(b.getSize(new THREE.Vector3()).length() * 0.45, 20) : 60;
    const colors = { XY: 0x2f6fed, XZ: 0x2f9e44, YZ: 0xe8590c };
    for (const std of ["XY", "XZ", "YZ"] as const) {
      const f = STD_FRAMES[std];
      const c = (u: number, w: number) => new THREE.Vector3(...f.o).addScaledVector(new THREE.Vector3(...f.x), u * s).addScaledVector(new THREE.Vector3(...f.y), w * s);
      const g = new THREE.BufferGeometry().setFromPoints([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]);
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colors[std], transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      mesh.userData.std = std;
      mesh.renderOrder = 2400;
      this.decor.add(mesh);
      this.planeMeshes.push(mesh);
      const p = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
      const pos: number[] = [];
      for (let i = 0; i < 4; i++) pos.push(...p[i].toArray(), ...p[(i + 1) % 4].toArray());
      this.lines(pos, colors[std], 1.2);
    }
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
      $("#mc-status").textContent = m.kind === "plane" ? t("Pick a plane or a flat face for the sketch.")
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
        ["select", t("Select"), t("Select and drag (S)")], ["line", t("Line"), t("Line (L)")], ["rect", t("Rectangle"), t("Corner rectangle (R)")],
        ["crect", t("Centre rect"), t("Centre rectangle")], ["circle", t("Circle"), t("Circle (C)")], ["arc", t("Arc"), t("Centre-point arc (A)")],
        ["point", t("Point"), t("Point (P)")], ["dim", t("Dimension"), t("Smart dimension (D)")],
      ];
      html = `<div class="mc-g" role="group" aria-label="${esc(t("Sketch"))}">${tools.map(([id, l, ti]) => btn(`sk:${id}`, l, ti, tool === id)).join("")}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("cons", t("Construction"), t("Construction geometry on/off for the selection (Q)"))}</div>`
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
        + `</div><div class="mc-sep"></div><div class="mc-g">`
        + btn("undo", t("Undo"), t("Undo (Ctrl+Z)"), false, busy || !this.store.canUndo) + btn("redo", t("Redo"), t("Redo (Ctrl+Y)"), false, busy || !this.store.canRedo)
        + `</div><div class="mc-sep"></div><div class="mc-g">`
        + btn("save", t("Save"), t("Save the part as .mcadprt (Ctrl+S)")) + btn("step", t("STEP"), t("Export the body as STEP"))
        + `</div>`;
    }
    $("#mc-tools").innerHTML = html;
    $("#mc-tools").querySelectorAll<HTMLButtonElement>("[data-c]").forEach(b => b.addEventListener("click", () => this.command(b.dataset.c!)));
  }

  private command(c: string) {
    const m = this.mode;
    if (c.startsWith("sk:") && m.kind === "sketch") { m.editor.setTool(c.slice(3) as SkTool); this.renderBar(); return; }
    switch (c) {
      case "cons": if (m.kind === "sketch") m.editor.toggleConstruction(); break;
      case "exit": this.ok(); break;
      case "sketch": this.startSketch(); break;
      case "extrude": case "cut": case "revolve": case "fillet": case "chamfer": this.startFeature(c); break;
      case "undo": this.undo(); break;
      case "redo": this.redo(); break;
      case "save": void this.save(); break;
      case "step": void this.exportStep(); break;
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
    const row = (id: string, icon: string, label: string, extra = "", cls = "") =>
      `<div class="ft-row${cls}${this.selected === id ? " sel" : ""}" role="treeitem" aria-selected="${this.selected === id}" tabindex="${this.selected === id ? 0 : -1}" data-id="${esc(id)}"><span class="ft-ico" aria-hidden="true">${icon}</span><span class="ft-name" translate="no">${esc(label)}</span>${extra}</div>`;
    let html = row("part", ICONS.part, d.name, "", " ft-root");
    html += `<div class="ft-group" role="group">`;
    for (const std of ["XY", "XZ", "YZ"] as const) html += row(`std:${std}`, ICONS.plane, t(STD_NAMES[std]), "", " ft-plane");
    html += row("origin", "⊹", t("Origin"), "", " ft-plane");
    html += `</div>`;
    const end = d.rollback ?? d.features.length;
    d.features.forEach((f, i) => {
      const s = st.get(f.id);
      const editing = (m.kind === "sketch" && m.id === f.id) || (m.kind === "feature" && !m.isNew && m.index === i);
      const icon = f.type === "extrude" && f.op === "cut" ? ICONS.cut : ICONS[f.type];
      const badge = s && !s.ok ? `<span class="ft-err" title="${esc(statusText(s))}" role="img" aria-label="${esc(t("Error"))}: ${esc(statusText(s))}">⚠</span>` : "";
      const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="sup" title="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}" aria-label="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}">${f.suppressed ? "◌" : "●"}</button><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
      html += row(f.id, icon, featureLabel(f.name), badge + tools, `${f.suppressed ? " sup" : ""}${i >= end ? " rolled" : ""}${editing ? " editing" : ""}${s && !s.ok ? " bad" : ""}`);
    });
    box.innerHTML = html;
    box.querySelectorAll<HTMLElement>(".ft-row").forEach(r => {
      const id = r.dataset.id!;
      r.addEventListener("click", e => {
        const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
        if (a === "sup") { this.toggleSuppress(id); return; }
        if (a === "del") { void this.deleteFeature(id); return; }
        if (this.mode.kind === "plane" && id.startsWith("std:")) { void this.createSketch({ std: id.slice(4) as "XY" }); return; }
        const mm = this.mode;
        if (mm.kind === "feature" && (mm.draft.type === "extrude" || mm.draft.type === "revolve") && this.store!.feature(id)?.type === "sketch") {
          mm.draft.sketch = id;
          if (mm.draft.type === "revolve") { const sk = this.store!.feature(id) as SketchFeature; const ls = sk.ents.filter(x => x.t === "line"); mm.draft.axis = (ls.find(l => l.cons) ?? ls[0])?.id ?? ""; }
          this.renderPanel();
          this.drawDecor();
          void this.rebuild();
          return;
        }
        this.selected = id;
        this.renderTree();
      });
      r.addEventListener("dblclick", () => { if (this.store!.feature(id)) this.editFeature(id); });
      r.addEventListener("keydown", e => {
        const rows = [...box.querySelectorAll<HTMLElement>(".ft-row")];
        const i = rows.indexOf(r);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]; n.focus(); this.selected = n.dataset.id!; rows.forEach(x => x.classList.toggle("sel", x === n)); }
        else if (e.key === "Enter" && this.store!.feature(id)) { e.preventDefault(); this.editFeature(id); }
      });
    });
  }

  // ---------- property panel ----------

  private renderPanel() {
    const pm = $("#mc-pm");
    const m = this.mode;
    if (!this.store || m.kind === "none") { pm.hidden = true; pm.innerHTML = ""; return; }
    pm.hidden = false;
    const head = (title: string, help: string) => `<div class="pm-head"><h3>${esc(title)}</h3></div><p class="pm-help muted">${esc(help)}</p>`;
    if (m.kind === "plane") {
      pm.innerHTML = head(t("Sketch"), t("Pick a plane or a flat face for the sketch."))
        + `<div class="pm-planes">${(["XY", "XZ", "YZ"] as const).map(s => `<button class="btn small" data-std="${s}">${esc(t(STD_NAMES[s]))}</button>`).join("")}</div>`;
      pm.querySelectorAll<HTMLElement>("[data-std]").forEach(b => b.addEventListener("click", () => void this.createSketch({ std: b.dataset.std as "XY" })));
      return;
    }
    if (m.kind === "sketch") { this.renderSketchPanel(pm, m.editor); return; }
    const f = m.draft;
    const sketches = this.doc.features.slice(0, m.index).filter((x): x is SketchFeature => x.type === "sketch");
    const unit = units.current;
    const numField = (key: string, label: string, n: Num, q: "length" | "angle") => {
      const shown = n.expr ?? (q === "angle" ? trimNum((n.v * 180) / Math.PI, 4) : trimNum(n.v * UNITS[unit].f, 6));
      return `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-num="${key}" data-q="${q}" value="${esc(shown)}" spellcheck="false" /><span class="muted">${q === "angle" ? "°" : unit}</span></span></label>`;
    };
    const sketchSel = (cur: string) => `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${sketches.map(s => `<option value="${s.id}"${s.id === cur ? " selected" : ""}>${esc(featureLabel(s.name))}</option>`).join("")}</select></label>`;
    const name = `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-k="name" value="${esc(featureLabel(f.name))}" spellcheck="false" translate="no" /></label>`;
    const status = this.last?.statuses.find(s => s.id === f.id);
    const err = status && !status.ok ? `<p class="pm-err" role="alert">⚠ ${esc(statusText(status))}</p>` : "";
    let body = "";
    let title = "";
    if (f.type === "extrude") {
      title = f.op === "cut" ? t("Cut") : t("Extrude");
      body = sketchSel(f.sketch)
        + `<label class="pm-field"><span>${esc(t("Operation"))}</span><select data-k="op"><option value="boss"${f.op === "boss" ? " selected" : ""}>${esc(t("Add material"))}</option><option value="cut"${f.op === "cut" ? " selected" : ""}>${esc(t("Remove material"))}</option></select></label>`
        + `<label class="pm-field"><span>${esc(t("End condition"))}</span><select data-k="end"><option value="blind"${f.end === "blind" ? " selected" : ""}>${esc(t("Blind"))}</option><option value="mid"${f.end === "mid" ? " selected" : ""}>${esc(t("Mid plane"))}</option><option value="through"${f.end === "through" ? " selected" : ""}>${esc(t("Through all"))}</option></select></label>`
        + (f.end === "through" ? "" : numField("depth", t("Depth"), f.depth, "length"))
        + `<label class="chk pm-chk"><input type="checkbox" data-k="flip"${f.flip ? " checked" : ""} />${esc(t("Reverse direction"))}</label>`
        + (f.end === "blind" ? `<label class="chk pm-chk"><input type="checkbox" data-k="dir2"${f.depth2 && f.depth2.v > 0 ? " checked" : ""} />${esc(t("Direction 2"))}</label>` + (f.depth2 && f.depth2.v > 0 ? numField("depth2", t("Depth 2"), f.depth2, "length") : "") : "");
    } else if (f.type === "revolve") {
      title = t("Revolve");
      const sk = this.store.feature(f.sketch) as SketchFeature | undefined;
      const lines = sk?.ents.filter(e => e.t === "line") ?? [];
      body = sketchSel(f.sketch)
        + `<label class="pm-field"><span>${esc(t("Axis"))}</span><select data-k="axis">${lines.map((l, i) => `<option value="${l.id}"${l.id === f.axis ? " selected" : ""}>${esc(t("Line {n}", { n: i + 1 }))}${l.cons ? ` (${esc(t("construction"))})` : ""}</option>`).join("")}</select></label>`
        + `<label class="pm-field"><span>${esc(t("Operation"))}</span><select data-k="op"><option value="boss"${f.op === "boss" ? " selected" : ""}>${esc(t("Add material"))}</option><option value="cut"${f.op === "cut" ? " selected" : ""}>${esc(t("Remove material"))}</option></select></label>`
        + numField("angle", t("Angle"), f.angle, "angle")
        + `<label class="chk pm-chk"><input type="checkbox" data-k="mid"${f.mid ? " checked" : ""} />${esc(t("Mid plane"))}</label>`
        + `<label class="chk pm-chk"><input type="checkbox" data-k="flip"${f.flip ? " checked" : ""} />${esc(t("Reverse direction"))}</label>`;
    } else if (f.type === "fillet" || f.type === "chamfer") {
      title = f.type === "fillet" ? t("Fillet") : t("Chamfer");
      body = (f.type === "fillet" ? numField("radius", t("Radius"), f.radius, "length") : numField("distance", t("Distance"), f.distance, "length"))
        + `<div class="pm-field"><span>${esc(t("Edges"))}</span><span class="pm-edges"><b>${f.edges.length}</b> <span class="muted">${esc(t("click edges or faces in the view"))}</span></span></div>`
        + (f.edges.length ? `<button class="btn small" data-k="clear">${esc(t("Clear edges"))}</button>` : "");
    }
    pm.innerHTML = head(title, m.isNew ? t("Set the values; the view shows the result. ✓ or Enter keeps it, ✕ or Esc cancels.") : t("Editing: ✓ or Enter applies the change, ✕ or Esc cancels.")) + name + body + err
      + `<div class="pm-actions"><button class="btn primary small" data-k="ok">${esc(t("OK"))}</button><button class="btn small" data-k="cancel">${esc(t("Cancel"))}</button></div>`;
    const upd = (fn: () => void, structural = false) => { fn(); if (structural) this.renderPanel(); this.drawDecor(); this.renderBar(); void this.rebuild(); };
    pm.querySelectorAll<HTMLInputElement>("input[data-num]").forEach(inp => {
      const apply = () => {
        const key = inp.dataset.num!, q = inp.dataset.q as "length" | "angle";
        let v: number;
        try { v = evaluate(inp.value, q, q === "angle" ? "deg" : unit); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).message), true); return; }
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const n: Num = isPlain(inp.value) ? { v } : { v, expr: inp.value.trim() };
        const cur = (f as unknown as Record<string, Num | undefined>)[key];
        if (cur && cur.v === n.v && cur.expr === n.expr) return;
        upd(() => { (f as unknown as Record<string, Num>)[key] = n; });
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
        if (k === "dir2") { upd(() => { (f as ExtrudeFeature).depth2 = val ? { v: (f as ExtrudeFeature).depth.v } : undefined; if (!val) delete (f as ExtrudeFeature).depth2; }, true); return; }
        if (k === "sketch" && f.type === "revolve") {
          const sk = this.store!.feature(String(val)) as SketchFeature;
          const ls = sk.ents.filter(x => x.t === "line");
          upd(() => { f.sketch = String(val); f.axis = (ls.find(l => l.cons) ?? ls[0])?.id ?? ""; }, true);
          return;
        }
        upd(() => { if (typeof val === "boolean" && !val) delete g[k]; else g[k] = val; }, k === "end" || k === "op" || k === "sketch");
      });
    });
    pm.querySelector("[data-k=clear]")?.addEventListener("click", () => { if (f.type === "fillet" || f.type === "chamfer") { f.edges = []; this.drawDecor(); this.renderPanel(); } });
    pm.querySelector("[data-k=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-k=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  private renderSketchPanel(pm: HTMLElement, ed: SketchEditor) {
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
        + `<div class="pm-rels"><button class="btn small" data-a="cons">${esc(t("Construction"))}</button><button class="btn small danger" data-a="del">${esc(t("Delete"))}</button></div>`
        : `<p class="muted">${esc(t("Select sketch items to add relations (Ctrl+click for more)."))}</p>`)
      + `</div>`
      + `<div class="pm-sec"><h4>${esc(t("Dimensions"))}</h4>${sk.dims.length ? `<ul class="pm-dims">${sk.dims.map(d => `<li><button class="link" data-dim="${d.id}">${esc(d.name)}</button> <span class="muted">${esc(d.val.expr ?? (d.t === "angle" ? `${trimNum((d.val.v * 180) / Math.PI, 3)}°` : `${trimNum(d.val.v * UNITS[units.current].f, 4)} ${units.current}`))}${d.driven ? ` (${esc(t("reference"))})` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">${esc(t("None yet: use Dimension (D)."))}</p>`}</div>`
      + `<div class="pm-actions"><button class="btn primary small" data-a="ok">${esc(t("Exit sketch"))}</button><button class="btn small" data-a="cancel">${esc(t("Cancel"))}</button></div>`;
    pm.querySelectorAll<HTMLElement>("[data-rel]").forEach(b => b.addEventListener("click", () => { ed.addRelation(b.dataset.rel as never); this.renderPanel(); }));
    pm.querySelector("[data-a=cons]")?.addEventListener("click", () => ed.toggleConstruction());
    pm.querySelector("[data-a=del]")?.addEventListener("click", () => { ed.deleteSelection(); this.renderPanel(); });
    pm.querySelectorAll<HTMLElement>("[data-dim]").forEach(b => b.addEventListener("click", () => ed.editDim(b.dataset.dim!)));
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  /** Test and debug handle. */
  debug() {
    const self = this;
    return { get store() { return self.store; }, last: () => this.last, mode: () => this.mode, editor: () => (this.mode.kind === "sketch" ? this.mode.editor : null), rebuild: () => this.rebuild(), kernel: this.kernel };
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
    }
  }
  return out;
}

const S = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON_SVG: Record<string, string> = {
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
  cons: S('<path d="M2 14 14 2" stroke-dasharray="2.2 1.8"/>'),
  "sk:select": S('<path d="M3 2l9 5-4 1.2L6.5 13z"/>'),
  "sk:line": S('<path d="M3 13 13 3"/><circle cx="3" cy="13" r="1.3" fill="currentColor"/><circle cx="13" cy="3" r="1.3" fill="currentColor"/>'),
  "sk:rect": S('<path d="M2.5 4h11v8h-11z"/>'),
  "sk:crect": S('<path d="M2.5 4h11v8h-11z"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:circle": S('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:arc": S('<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><circle cx="8" cy="11" r=".9" fill="currentColor"/>'),
  "sk:point": S('<circle cx="8" cy="8" r="2" fill="currentColor"/>'),
  "sk:dim": S('<path d="M2.5 4v8M13.5 4v8M2.5 8h11M5 6 2.5 8 5 10M11 6l2.5 2L11 10"/>'),
};
