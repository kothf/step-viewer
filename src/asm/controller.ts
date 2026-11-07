// Assembly mode (FRS 10, P4 slice 1): the assembly tree, Insert component, move/rotate (drag in the
// view or type the pose), fixed/floating, hide, delete, save and open .mcadasm. The kernel places the
// components (src/kernel/assembly.ts) and the viewer shows one part per component, so the measuring
// tools work across components as for an imported assembly.
import * as THREE from "three";
import { ModelKernel } from "../model/kernelClient";
import { newPart, uid } from "../model/doc";
import { PART_EXT, unpackPart } from "../model/file";
import { t, onLangChange } from "../i18n";
import { confirmModal, toast } from "../ui";
import { ASM_EXT, packAsm, unpackAsm } from "./file";
import { IDENTITY, applyDir, applyPoint, compose, eulerXYZ, fromPose, invert, translation } from "./math";
import { mateDefaults, mateTypes, placeGeo, solve, type Geo, type SolveResult } from "./solver";
import type { AsmComponentStatus, AsmDoc, Component, Mate, MateRef, MateType, Tf } from "./types";
import type { BodyProps, PartDoc, V3 } from "../model/types";
import type { PartData, TreeNode } from "../topology";
import type { Viewer } from "../viewer/Viewer";

export interface AsmHost {
  viewer: Viewer;
  vp: HTMLElement;
  /** Shows the placed components (one part each); `first` fits the view like a newly opened file. */
  show(parts: PartData[], tree: TreeNode, first: boolean): void;
  /** The component part index under a screen point, if any. */
  partAt(x: number, y: number): { idx: number; face: number; point: V3 } | null;
  setDoc(label: string): void;
  selectLeftTab(tab: string): void;
  /** Another document kind takes over (the part modeller closes). */
  leaveOthers(): void;
  appVersion: string;
}

const unit = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FOREIGN = /\.(step|stp|iges|igs|brep)$/i;
const MATE_TYPES: MateType[] = ["coincident", "parallel", "perpendicular", "tangent", "concentric", "lock", "distance", "angle"];
const MATE_LABEL: Record<MateType, string> = { coincident: "Coincident", parallel: "Parallel", perpendicular: "Perpendicular", tangent: "Tangent", concentric: "Concentric", lock: "Lock", distance: "Distance", angle: "Angle" };
const MATE_ICON: Record<MateType, string> = { coincident: "⊼", parallel: "∥", perpendicular: "⊥", tangent: "◠", concentric: "◎", lock: "🔒", distance: "↔", angle: "∠" };
/** The mate being made or edited in the Mate panel. */
interface MateDraft { edit?: string; a?: MateRef; b?: MateRef; type?: MateType; align?: "aligned" | "anti"; value?: number; flip?: boolean; problem?: string }

export class AsmController {
  doc: AsmDoc | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private savedAt = "";
  private fileName = "";
  private handle: FileSystemFileHandle | null = null;
  private kernel: ModelKernel;
  /** The components shown, in viewer part order. */
  private shownIds: string[] = [];
  private statuses: AsmComponentStatus[] = [];
  props: BodyProps | null = null;
  private selected: string | null = null;
  /** The move panel's component, when open. */
  private moving: string | null = null;
  private building = false;
  private again = false;
  private first = true;
  private drag: { id: string; idx: number; plane: THREE.Plane; start: THREE.Vector3; delta: THREE.Vector3; moved: boolean; mated: boolean; result?: Record<string, Tf> } | null = null;
  /** Mate geometry of each part's faces, in part coordinates, learnt from the shown meshes (by part key, face name). */
  private geo = new Map<string, Map<string, Geo>>();
  private centres = new Map<string, V3>();
  /** The transforms the shown meshes were made with, and their face names. */
  private shownTf: Record<string, Tf> = {};
  private faceNames: string[][] = [];
  /** The last mate solve: degrees of freedom and failing mates. */
  solved: SolveResult | null = null;
  mating: MateDraft | null = null;
  /** Interference detection results while its panel is open (FR-ASM-020). */
  interfere: { touch: boolean; pairs: { a: string; b: string; volume: number; position: number[] }[] | null; sel: number } | null = null;
  private overlay = new THREE.Group();
  /** Volume (mm³) of each part, from its shown mesh, for the BOM. */
  private volumes = new Map<string, number>();
  private mateDown: { x: number; y: number } | null = null;
  /** Resolves when the rebuild in flight and any queued one are done (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(private host: AsmHost, occtBase: string) {
    this.kernel = new ModelKernel(occtBase);
    this.kernel.onCrash = () => toast(t("The geometry kernel stopped; it was restarted."), "warn");
    this.bindDom();
    host.viewer.scene.add(this.overlay);
    onLangChange(() => { delete $("#asm-pm").dataset.id; if (this.doc) this.renderAll(); });
  }

  get active() { return !!this.doc; }
  /** Clicks in the view pick mate faces (Smart measure leaves them alone). */
  get picking() { return !!this.mating; }
  get dirty() { return !!this.doc && JSON.stringify(this.doc) !== this.savedAt; }
  isAsmName(name: string) { return name.toLowerCase().endsWith(ASM_EXT); }

  // ---------- open, new, close ----------

  newAssembly() {
    this.load({ schema: 1, kind: "assembly", id: uid("a_"), name: "Assembly1", units: { length: "mm", decimals: 2 }, components: [], parts: {} }, "", null);
    toast(t("New assembly: insert a part or a STEP model as the first component; it is fixed at the origin."));
  }

  async openFile(file: File | { name: string; data: ArrayBuffer }, handle: FileSystemFileHandle | null = null) {
    const buf = file instanceof File ? await file.arrayBuffer() : file.data;
    try { this.load(await unpackAsm(buf), file.name, handle); }
    catch (err) { toast(t("Could not open {name}: {err}", { name: file.name, err: t((err as Error).message) }), true); }
  }

  private load(doc: AsmDoc, fileName: string, handle: FileSystemFileHandle | null) {
    this.host.leaveOthers();
    this.doc = doc;
    this.savedAt = JSON.stringify(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.fileName = fileName;
    this.handle = handle;
    this.selected = null;
    this.moving = null;
    this.mating = null;
    this.interfere = null;
    this.clearOverlay();
    this.solved = null;
    this.geo.clear();
    this.centres.clear();
    this.first = true;
    document.getElementById("app")!.classList.add("asm");
    $("#empty").hidden = true;
    this.host.viewer.emptySize = 50;
    $("#t-asm").hidden = false;
    this.host.selectLeftTab("asm");
    this.kernel.warm();
    this.renderAll();
    this.rebuild();
  }

  close() {
    if (!this.doc) return;
    this.doc = null;
    this.drag = null;
    this.mating = null;
    this.interfere = null;
    this.clearOverlay();
    this.kernel.stop();
    document.getElementById("app")!.classList.remove("asm");
    this.host.viewer.emptySize = 1;
    $("#t-asm").hidden = true;
    $("#asm-bar").hidden = true;
    this.host.selectLeftTab("tree");
  }

  private label() { return `${this.fileName || `${this.doc!.name}${ASM_EXT}`}${this.dirty ? " •" : ""}`; }

  // ---------- changes, undo ----------

  /** Applies a change as one undo step and rebuilds. */
  change(fn: (d: AsmDoc) => void) {
    if (!this.doc) return;
    const before = JSON.stringify(this.doc);
    const next = JSON.parse(before) as AsmDoc;
    fn(next);
    this.applySolve(next);
    if (this.interfere?.pairs) { this.interfere.pairs = null; this.clearOverlay(); }
    if (JSON.stringify(next) === before) { this.renderTree(); return; }
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.renderAll();
    this.rebuild();
  }

  undo() { this.step(this.undoStack, this.redoStack); }
  redo() { this.step(this.redoStack, this.undoStack); }
  private step(from: string[], to: string[]) {
    const s = from.pop();
    if (!s || !this.doc) return;
    to.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    if (this.moving && !this.doc!.components.some(c => c.id === this.moving)) this.moving = null;
    this.renderAll();
    this.rebuild();
  }

  // ---------- rebuild ----------

  /** Places the components in the kernel and shows them; while one runs, the newest request waits. */
  rebuild() {
    if (!this.doc) return;
    if (this.building) { this.again = true; return; }
    this.building = true;
    this.idle = (async () => {
      do {
        this.again = false;
        const doc = this.doc;
        if (!doc) break;
        $("#asm-busy").hidden = false;
        try {
          const r = await this.kernel.assembly(doc);
          if (this.doc !== doc && this.again) continue;
          this.statuses = r.statuses;
          this.props = r.props;
          this.shownIds = r.parts.map(p => p.id);
          this.learn(doc, r.parts);
          const tree: TreeNode = { name: doc.name, parts: [], children: r.parts.map((p, i) => ({ name: p.data.name, parts: [i], children: [] })) };
          this.host.show(r.parts.map(p => p.data), tree, this.first && r.parts.length > 0);
          if (r.parts.length) this.first = false;
        } catch (err) { toast(t("The assembly could not be rebuilt: {err}", { err: (err as Error).message }), true); }
      } while (this.again);
      $("#asm-busy").hidden = true;
      this.building = false;
      // A part's geometry may have changed under its mates (AT-P4-2): solve again, as part of the same state.
      if (this.doc?.mates?.length) {
        const r = this.solveDoc(this.doc);
        this.solved = r;
        if (r.ok && r.moved) { for (const c of this.doc.components) c.tf = r.tfs[c.id]; this.renderTree(); this.rebuild(); return; }
      }
      this.renderTree();
      this.renderBar();
      if (this.mating) this.drawPicks();
    })();
  }

  // ---------- interference, BOM, STEP (FR-ASM-020/024, AT-P4-4..6) ----------

  /** Interference detection: every overlapping pair with its volume; the overlaps are drawn red. */
  async runInterference(touch = this.interfere?.touch ?? false) {
    if (!this.doc) return;
    if (this.mating) this.cancelMate();
    this.moving = null;
    this.interfere = { touch, pairs: null, sel: -1 };
    this.renderAll();
    $("#asm-busy").hidden = false;
    try {
      const pairs = await this.kernel.interference(this.doc, touch);
      if (!this.interfere) return;
      this.interfere.pairs = pairs;
      this.drawOverlay();
    } catch (err) { toast(t("Interference detection failed: {err}", { err: (err as Error).message }), true); }
    finally { $("#asm-busy").hidden = true; }
    this.renderPanel();
  }

  closeInterference() {
    this.interfere = null;
    this.clearOverlay();
    this.renderAll();
  }

  private drawOverlay() {
    this.clearOverlay();
    const it = this.interfere;
    it?.pairs?.forEach((p, i) => {
      if (!p.position.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.position, 3));
      const on = it.sel === i || it.sel < 0;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xe03131, transparent: true, opacity: on ? 0.85 : 0.25, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      mesh.renderOrder = 10;
      this.overlay.add(mesh);
    });
    this.host.viewer.invalidate();
  }

  private clearOverlay() {
    for (const o of [...this.overlay.children]) { this.overlay.remove(o); (o as THREE.Mesh).geometry.dispose(); }
    this.host.viewer.invalidate();
  }

  private renderInterference() {
    const pm = $("#asm-pm"), it = this.interfere!;
    pm.hidden = false;
    pm.dataset.id = "interfere";
    const name = (id: string) => this.comp(id)?.name ?? "?";
    const vol = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 3 })} mm³`;
    const rows = it.pairs?.map((p, i) => `<button class="pm-box${it.sel === i ? " focus" : ""}" data-pair="${i}" translate="no">${esc(name(p.a))} ↔ ${esc(name(p.b))}: ${esc(p.volume > 0 ? vol(p.volume) : t("touching"))}</button>`).join("") ?? "";
    const total = it.pairs?.reduce((s, p) => s + p.volume, 0) ?? 0;
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(t("Interference detection"))}</h3><span class="pm-okc"><button class="pm-ok" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button></span></div>`
      + `<fieldset class="pm-group"><legend>${esc(t("Results"))}</legend>`
      + (it.pairs === null ? `<p class="pm-help muted" role="status">${esc(t("Checking…"))}</p>`
        : it.pairs.length ? `<p class="pm-help" role="status" data-istatus>${esc(t("{n} interference|{n} interferences", { n: it.pairs.length }))} · ${esc(vol(total))}</p><div class="pm-items">${rows}</div>`
        : `<p class="pm-help" role="status" data-istatus>${esc(t("No interference."))}</p>`)
      + `</fieldset><fieldset class="pm-group"><legend>${esc(t("Options"))}</legend><label class="pm-field pm-check"><input type="checkbox" data-a="touch"${it.touch ? " checked" : ""} /> ${esc(t("Treat coincidence as interference"))}</label><p class="pm-help muted">${esc(t("Hidden components are left out."))}</p><button class="btn small" data-a="again">${esc(t("Calculate"))}</button></fieldset>`;
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.closeInterference());
    pm.querySelector("[data-a=again]")!.addEventListener("click", () => void this.runInterference());
    pm.querySelector<HTMLInputElement>("[data-a=touch]")!.addEventListener("change", e => void this.runInterference((e.target as HTMLInputElement).checked));
    pm.querySelectorAll<HTMLElement>("[data-pair]").forEach(b => b.addEventListener("click", () => { it.sel = it.sel === Number(b.dataset.pair) ? -1 : Number(b.dataset.pair); this.drawOverlay(); this.renderPanel(); }));
  }

  /** BOM rows (FR-ASM-024): one per part, in the order first used, with quantity and mass. */
  bom() {
    if (!this.doc) return [];
    const rows: { item: number; part: string; number: string; description: string; material: string; qty: number; mass: number | null }[] = [];
    const at = new Map<string, number>();
    for (const c of this.doc.components) {
      if (c.suppressed) continue;
      let i = at.get(c.part);
      if (i === undefined) {
        const p = this.doc.parts[c.part], d = p.doc, v = this.volumes.get(c.part);
        i = rows.length;
        at.set(c.part, i);
        rows.push({ item: i + 1, part: p.name, number: d.props?.partNumber ?? "", description: d.props?.description ?? "", material: d.material?.name ?? "", qty: 0, mass: v !== undefined && d.material ? (v / 1000) * d.material.density / 1000 : null });
      }
      rows[i].qty++;
    }
    return rows;
  }

  showBom() {
    const dlg = $<HTMLDialogElement>("#asm-bom"), rows = this.bom();
    const kg = (m: number | null) => (m === null ? "" : m.toLocaleString(undefined, { maximumFractionDigits: 4 }));
    $("#asm-bom-body").innerHTML = `<table class="v-table"><thead><tr><th>${esc(t("Item"))}</th><th>${esc(t("Part"))}</th><th>${esc(t("Part number"))}</th><th>${esc(t("Description"))}</th><th>${esc(t("Material"))}</th><th>${esc(t("Qty"))}</th><th>${esc(t("Mass (kg)"))}</th></tr></thead><tbody>`
      + rows.map(r => `<tr><td>${r.item}</td><td translate="no">${esc(r.part)}</td><td translate="no">${esc(r.number)}</td><td translate="no">${esc(r.description)}</td><td>${esc(r.material ? t(r.material) : "")}</td><td>${r.qty}</td><td>${kg(r.mass)}</td></tr>`).join("") + `</tbody></table>`;
    const done = () => dlg.close();
    dlg.querySelector<HTMLButtonElement>("[data-a=close]")!.onclick = done;
    dlg.querySelector<HTMLButtonElement>("[data-a=csv]")!.onclick = () => this.bomCsv();
    dlg.showModal();
  }

  /** The BOM as CSV (English headers, like the other exports). */
  bomCsvText() {
    const q = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["Item", "Part", "Part number", "Description", "Material", "Qty", "Mass (kg)"].join(",")];
    for (const r of this.bom()) lines.push([r.item, r.part, r.number, r.description, r.material, r.qty, r.mass === null ? "" : r.mass.toFixed(6)].map(q).join(","));
    return `${lines.join("\r\n")}\r\n`;
  }

  private bomCsv() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([this.bomCsvText()], { type: "text/csv" }));
    a.download = `${this.doc?.name ?? "assembly"}-bom.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** STEP of the assembly (AT-P4-6): reopens with one named part per component, in place. */
  async exportStep() {
    if (!this.doc) return;
    $("#asm-busy").hidden = false;
    try {
      const bytes = await this.kernel.assemblyStep(this.doc);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "model/step" }));
      a.download = `${this.doc.name}.step`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(t("Saved as STEP"), "success");
    } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
    finally { $("#asm-busy").hidden = true; }
  }

  /** The STEP bytes, for tests. */
  stepBytes() { return this.doc ? this.kernel.assemblyStep(this.doc) : null; }

  // ---------- mates (FR-MATE-003/008) ----------

  /** Records each part's face geometry in part coordinates from the first shown instance. */
  private learn(doc: AsmDoc, parts: { id: string; data: PartData; faces: string[] }[]) {
    this.faceNames = parts.map(p => p.faces);
    this.shownTf = {};
    const seen = new Set<string>();
    for (const p of parts) {
      const c = doc.components.find(x => x.id === p.id);
      if (!c) continue;
      this.shownTf[c.id] = c.tf.slice();
      if (seen.has(c.part)) continue;
      seen.add(c.part);
      const inv = invert(c.tf), m = new Map<string, Geo>();
      p.data.faces.forEach((f, j) => {
        const name = p.faces[j];
        if (!name) return;
        if (f.type === "plane" && f.normal) m.set(name, { k: "plane", p: applyPoint(inv, f.centroid), n: unit(applyDir(inv, f.normal)) });
        else if (f.type === "cylinder" && f.axis) m.set(name, { k: "axis", p: applyPoint(inv, f.center), d: unit(applyDir(inv, f.axis)), r: f.radius ?? 0 });
      });
      this.geo.set(c.part, m);
      this.volumes.set(c.part, p.data.volume);
      const b0 = p.data.bboxMin, b1 = p.data.bboxMax;
      this.centres.set(c.part, applyPoint(inv, [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2, (b0[2] + b1[2]) / 2]));
    }
  }

  private solveDoc(doc: AsmDoc, extra: Mate[] = [], start?: Record<string, Tf>) {
    return solve({ doc, extra, start, geo: (part, face) => this.geo.get(part)?.get(face) ?? null, centre: part => this.centres.get(part) ?? [0, 0, 0], size: Math.max(10, this.host.viewer.parts.length ? this.host.viewer.modelSize : 100) });
  }

  /** Solves a changed document's mates into its transforms; when they conflict nothing moves. */
  private applySolve(d: AsmDoc) {
    if (!d.mates?.length) { this.solved = null; return; }
    const r = this.solveDoc(d);
    this.solved = r;
    if (r.ok) for (const c of d.components) c.tf = r.tfs[c.id];
  }

  /** Moves the shown meshes to these transforms without a rebuild (drag and mate previews). */
  private previewTfs(tfs: Record<string, Tf>) {
    const v = this.host.viewer;
    this.shownIds.forEach((id, i) => {
      const part = v.parts[i], t0 = this.shownTf[id], t1 = tfs[id];
      if (!part || !t0 || !t1) return;
      const M = compose(t1, invert(t0));
      new THREE.Matrix4().set(M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], M[9], M[10], M[11], 0, 0, 0, 1).decompose(part.group.position, part.group.quaternion, part.group.scale);
    });
    v.invalidate();
  }

  private worldGeo(ref: MateRef): Geo | null {
    const c = this.comp(ref.comp), g = c && this.geo.get(c.part)?.get(ref.face);
    return c && g ? placeGeo(g, c.tf) : null;
  }

  private mateLive(id: string) { return (this.doc?.mates ?? []).some(m => !m.suppressed && (m.a.comp === id || m.b.comp === id)); }

  /** Mate (FR-MATE-003/006): pick two faces, the likely mate type is chosen and previewed. */
  startMate(edit?: Mate) {
    if (!this.doc) return;
    this.moving = null;
    if (this.interfere) this.closeInterference();
    this.mating = edit ? { edit: edit.id, a: { ...edit.a }, b: { ...edit.b }, type: edit.type, align: edit.align, value: edit.value, flip: edit.flip } : {};
    this.renderAll();
    this.drawPicks();
    this.previewMate();
  }

  cancelMate() {
    if (!this.mating) return;
    this.mating = null;
    this.clearPicks();
    this.previewTfs(this.shownTf);
    this.renderAll();
  }

  /** The draft as a mate, when it has both faces and a type that fits them. */
  private draftMate(): Mate | null {
    const m = this.mating;
    if (!m?.a || !m.b || !m.type || !this.doc) return null;
    const n = (this.doc.mates ?? []).filter(x => x.type === m.type).length + 1;
    const old = m.edit ? this.doc.mates?.find(x => x.id === m.edit) : undefined;
    const mate: Mate = { id: m.edit ?? uid("m_"), name: old && old.type === m.type ? old.name : `${MATE_LABEL[m.type]}${n}`, type: m.type, a: m.a, b: m.b };
    if (m.align) mate.align = m.align;
    if (m.type === "distance" || m.type === "angle") { mate.value = m.value ?? 0; if (m.flip) mate.flip = true; }
    if (m.type === "lock") { const a = this.comp(m.a.comp), b = this.comp(m.b.comp); if (a && b) mate.rel = compose(invert(a.tf), b.tf); }
    return mate;
  }

  private withoutEdited(): AsmDoc {
    const d = { ...this.doc! };
    if (this.mating?.edit) d.mates = (d.mates ?? []).filter(x => x.id !== this.mating!.edit);
    return d;
  }

  private previewMate() {
    const m = this.mating, mate = this.draftMate();
    if (!m) return;
    m.problem = undefined;
    if (!mate) { this.previewTfs(this.shownTf); this.renderPanel(); return; }
    const r = this.solveDoc(this.withoutEdited(), [mate]);
    if (r.ok) this.previewTfs(r.tfs);
    else { this.previewTfs(this.shownTf); m.problem = r.bad.includes(mate.id) || r.missing.includes(mate.id) ? t("This mate cannot be solved with the others: the assembly would be over-defined.") : t("The assembly mates cannot all be solved."); }
    this.renderPanel();
  }

  /** ✓: adds (or replaces) the mate and keeps the panel open for the next one; with nothing picked it closes. */
  okMate() {
    const m = this.mating;
    if (!m || !this.doc) return;
    if (!m.a && !m.b) { this.cancelMate(); return; }
    const mate = this.draftMate();
    if (!mate) { toast(t("Pick two faces on different components, and a mate type that fits them."), true); return; }
    const r = this.solveDoc(this.withoutEdited(), [mate]);
    if (!r.ok) { m.problem = t("This mate cannot be solved with the others: the assembly would be over-defined."); this.renderPanel(); toast(m.problem, true); return; }
    const edit = m.edit;
    this.mating = {};
    this.clearPicks();
    this.change(d => {
      d.mates ??= [];
      const i = edit ? d.mates.findIndex(x => x.id === edit) : -1;
      if (i >= 0) d.mates[i] = mate; else d.mates.push(mate);
    });
    if (edit) this.cancelMate();
  }

  /** A click in the view while the Mate panel is open: the face goes into the next empty selection. */
  private pickMateFace(x: number, y: number) {
    const m = this.mating;
    const hit = this.host.partAt(x, y);
    if (!m || !hit) return;
    const id = this.shownIds[hit.idx], c = this.comp(id), face = this.faceNames[hit.idx]?.[hit.face];
    if (!c || !face) return;
    if (!this.geo.get(c.part)?.get(face)) { toast(t("Pick a flat or cylindrical face."), true); return; }
    const ref = { comp: id, face };
    if (m.a && !m.b && m.a.comp !== id) m.b = ref;
    else if (m.a && m.a.comp === id && !m.b) m.a = ref;
    else { m.a = ref; m.b = undefined; }
    m.type = undefined;
    if (m.a && m.b) {
      const ga = this.worldGeo(m.a)!, gb = this.worldGeo(m.b)!;
      m.type = mateTypes(ga.k, gb.k)[0];
      Object.assign(m, { align: undefined, value: undefined, flip: undefined }, mateDefaults(m.type, ga, gb));
      if (m.type === "coincident" && ga.k === "plane" && gb.k === "plane") m.align = "anti";
    }
    this.drawPicks();
    this.previewMate();
  }

  private setMateType(type: MateType) {
    const m = this.mating;
    if (!m) return;
    m.type = type;
    const ga = m.a && this.worldGeo(m.a), gb = m.b && this.worldGeo(m.b);
    if (ga && gb) {
      const d = mateDefaults(type, ga, gb);
      m.align = d.align ?? (type === "coincident" && ga.k === "plane" && gb.k === "plane" ? "anti" : undefined);
      if (type === "distance" || type === "angle") { m.value = d.value; m.flip = d.flip; } else { m.value = undefined; m.flip = undefined; }
      if (type === "coincident" && ga.k === "plane" && gb.k === "plane") m.align = "anti";
    }
    this.previewMate();
  }

  /** Coloured faces for the picked references (on the parts' groups, so they follow previews). */
  private drawPicks() {
    this.clearPicks();
    const m = this.mating;
    if (!m) return;
    ([[m.a, 0x1f78ff], [m.b, 0xa23cff]] as [MateRef | undefined, number][]).forEach(([ref, color]) => {
      if (!ref) return;
      const i = this.shownIds.indexOf(ref.comp), part = this.host.viewer.parts[i];
      const j = this.faceNames[i]?.indexOf(ref.face) ?? -1;
      const f = part?.data.faces[j];
      if (!part || !f) return;
      const P = part.data.positions, I = part.data.index, pos: number[] = [];
      for (let tr = f.triStart; tr < f.triStart + f.triCount; tr++) for (let k = 0; k < 3; k++) { const v = I[tr * 3 + k]; pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }));
      mesh.userData.matePick = true;
      mesh.renderOrder = 5;
      part.group.add(mesh);
    });
    this.host.viewer.invalidate();
  }

  private clearPicks() {
    for (const p of this.host.viewer.parts) for (const o of [...p.group.children]) if (o.userData.matePick) { p.group.remove(o); (o as THREE.Mesh).geometry.dispose(); }
    this.host.viewer.invalidate();
  }

  setMate(id: string, ch: Partial<Mate>) {
    this.change(d => { const m = d.mates?.find(x => x.id === id); if (m) { Object.assign(m, ch); for (const k of Object.keys(ch) as (keyof Mate)[]) if (ch[k] === undefined) delete m[k]; } });
  }

  async deleteMate(id: string) {
    const m = this.doc?.mates?.find(x => x.id === id);
    if (!m) return;
    this.change(d => { d.mates = (d.mates ?? []).filter(x => x.id !== id); if (!d.mates.length) delete d.mates; });
    if (this.selected === id) this.selected = null;
    this.renderAll();
  }

  // ---------- commands ----------

  /** Insert component (FR-ASM-002): a part or a STEP/IGES/BREP model, embedded. */
  insertComponent(file?: File) {
    if (!this.doc) return;
    const run = async (f: File) => {
      let pd: PartDoc;
      try {
        if (f.name.toLowerCase().endsWith(PART_EXT)) pd = await unpackPart(await f.arrayBuffer());
        else if (FOREIGN.test(f.name)) {
          if (f.size > 100 * 1024 * 1024) { toast(t("The file is too large to import (over 100 MB)."), true); return; }
          $("#asm-busy").hidden = false;
          const r = await this.kernel.importBody(await f.arrayBuffer(), f.name);
          if (!r.faces) { toast(t("No faces or solids were found in the file."), true); return; }
          const base = f.name.replace(/\.[^.]+$/, "");
          pd = newPart(base);
          pd.features.push({ id: "i", type: "import", name: "Imported1", file: f.name, brep: r.brep, ...(r.solids ? {} : { heal: true, tol: { v: 0.1 } }) });
        } else { toast(t("Insert a MöbiusCAD part, or a STEP, IGES or BREP model."), true); return; }
      } catch (err) { toast(t("The file could not be read: {msg}", { msg: (err as Error).message }), true); return; }
      finally { $("#asm-busy").hidden = true; }
      // Components are named after their file, as in SolidWorks.
      const base = f.name.replace(/\.[^.]+$/, "") || pd.name;
      // The same document again shares its source (FR-ASM-005).
      const json = JSON.stringify(pd);
      const key = Object.entries(this.doc!.parts).find(([, p]) => JSON.stringify(p.doc) === json)?.[0] ?? uid("p_");
      const n = this.doc!.components.filter(c => c.part === key).length + 1;
      const id = uid("c_");
      const firstOne = !this.doc!.components.length;
      // Later components go beside what is there, along X.
      const box = this.host.viewer.parts.length ? this.host.viewer.computeBounds() : null;
      const at: V3 = firstOne || !box ? [0, 0, 0] : [box.max.x + Math.max(10, (box.max.x - box.min.x) * 0.2), 0, 0];
      this.change(d => {
        d.parts[key] ??= { name: base, file: f.name, doc: pd };
        d.components.push({ id, name: `${base}<${n}>`, part: key, tf: firstOne ? IDENTITY : translation(at), ...(firstOne ? { fixed: true } : {}) });
      });
      this.selected = id;
      this.renderTree();
    };
    if (file) { void run(file); return; }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = `${PART_EXT},.step,.stp,.iges,.igs,.brep`;
    inp.addEventListener("change", () => { const f = inp.files?.[0]; if (f) void run(f); });
    inp.click();
  }

  private comp(id: string | null) { return id ? this.doc?.components.find(c => c.id === id) ?? null : null; }

  setFixed(id: string, fixed: boolean) { this.change(d => { const c = d.components.find(x => x.id === id); if (c) { if (fixed) c.fixed = true; else delete c.fixed; } }); }
  setHidden(id: string, hidden: boolean) { this.change(d => { const c = d.components.find(x => x.id === id); if (c) { if (hidden) c.hidden = true; else delete c.hidden; } }); }

  async deleteComponent(id: string) {
    const c = this.comp(id);
    if (!c || !(await confirmModal(t("Delete {name} from the assembly?", { name: c.name })))) return;
    this.change(d => {
      d.components = d.components.filter(x => x.id !== id);
      if (d.mates) { d.mates = d.mates.filter(m => m.a.comp !== id && m.b.comp !== id); if (!d.mates.length) delete d.mates; }
      // A part no component uses any more leaves the file.
      for (const k of Object.keys(d.parts)) if (!d.components.some(x => x.part === k)) delete d.parts[k];
    });
    if (this.moving === id) this.moving = null;
    if (this.selected === id) this.selected = null;
    this.renderAll();
  }

  /** The move panel (FR-MATE-002): position and rotation typed, or the component dragged in the view. */
  moveComponent(id: string) {
    if (!this.comp(id)) return;
    this.moving = id;
    this.selected = id;
    this.renderAll();
  }

  async save(as = false) {
    if (!this.doc) return;
    const bytes = await packAsm(this.doc, `MöbiusCAD ${this.host.appVersion}`);
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    const suggested = this.fileName || `${this.doc.name}${ASM_EXT}`;
    const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
    try {
      if (w.showSaveFilePicker) {
        if (!this.handle || as) this.handle = await w.showSaveFilePicker({ suggestedName: suggested, types: [{ description: "MöbiusCAD assembly", accept: { "application/zip": [ASM_EXT] } }] });
        const out = await (this.handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await out.write(blob);
        await out.close();
        this.fileName = this.handle.name;
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        this.fileName = suggested;
      }
    } catch (err) { if ((err as Error).name !== "AbortError") toast(t("Could not save: {err}", { err: (err as Error).message }), true); return; }
    this.savedAt = JSON.stringify(this.doc);
    this.renderAll();
    toast(t("Saved {name}", { name: this.fileName }), "success");
  }

  /** The bytes of the open assembly, as saved. */
  bytes() { return this.doc ? packAsm(this.doc, `MöbiusCAD ${this.host.appVersion}`) : null; }

  // ---------- view dragging (FR-MATE-001) ----------

  private bindDom() {
    // New ▾: the part / assembly menu beside New part.
    const more = document.getElementById("new-more"), menu = document.getElementById("new-menu");
    const shut = () => { if (menu) menu.hidden = true; more?.setAttribute("aria-expanded", "false"); };
    more?.addEventListener("click", () => {
      if (!menu) return;
      if (!menu.hidden) { shut(); return; }
      const r = more.getBoundingClientRect();
      menu.style.left = `${Math.max(4, r.right - 190)}px`;
      menu.style.top = `${r.bottom + 4}px`;
      menu.hidden = false;
      more.setAttribute("aria-expanded", "true");
      menu.querySelector<HTMLButtonElement>("button")?.focus();
    });
    document.addEventListener("pointerdown", e => { if (menu && !menu.hidden && !menu.contains(e.target as Node) && !more?.contains(e.target as Node)) shut(); });
    menu?.addEventListener("keydown", e => { if (e.key === "Escape") { shut(); more?.focus(); } });
    document.getElementById("new-menu-part")?.addEventListener("click", () => { shut(); document.getElementById("new-part")?.click(); });
    document.getElementById("new-asm")?.addEventListener("click", () => { shut(); this.newAssembly(); });
    document.getElementById("empty-asm")?.addEventListener("click", () => this.newAssembly());
    document.addEventListener("keydown", e => {
      if (this.doc && this.mating && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target as HTMLElement).closest("input, textarea, select, dialog[open]")) {
        if (e.key === "Enter") { e.preventDefault(); this.okMate(); return; }
        if (e.key === "Escape") { e.preventDefault(); this.cancelMate(); return; }
      }
      if (!this.doc || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tg = e.target as HTMLElement;
      if (tg.closest("input, textarea, select, [contenteditable=true], dialog[open]")) return;
      const k = e.key.toLowerCase();
      if (this.mating && !(e.ctrlKey || e.metaKey)) return;
      if (k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); this.redo(); }
      else if (k === "s") { e.preventDefault(); void this.save(e.shiftKey); }
    });
    const vp = this.host.vp;
    const canvas = () => this.host.viewer.renderer.domElement;
    const ray = (e: PointerEvent) => {
      const r = canvas().getBoundingClientRect();
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.host.viewer.camera);
      return rc.ray;
    };
    vp.addEventListener("pointerdown", e => {
      if (!this.doc || e.button !== 0 || e.target !== canvas()) return;
      // The Mate panel picks faces on a click (the view still orbits on a drag).
      if (this.mating) { this.mateDown = { x: e.clientX, y: e.clientY }; return; }
      const hit = this.host.partAt(e.clientX, e.clientY);
      if (!hit) return;
      const id = this.shownIds[hit.idx], c = this.comp(id);
      if (!c) return;
      this.selected = id;
      if (c.fixed) { this.renderTree(); return; }
      // Left-drag on a floating component moves it in the view plane; the orbit controls never see it.
      e.stopPropagation();
      e.preventDefault();
      const n = this.host.viewer.camera.getWorldDirection(new THREE.Vector3());
      const p = new THREE.Vector3(...hit.point);
      this.drag = { id, idx: hit.idx, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, p), start: p, delta: new THREE.Vector3(), moved: false, mated: this.mateLive(id) };
      canvas().setPointerCapture?.(e.pointerId);
    }, true);
    vp.addEventListener("pointermove", e => {
      const d = this.drag;
      if (!d) return;
      e.stopPropagation();
      const q = ray(e).intersectPlane(d.plane, new THREE.Vector3());
      if (!q) return;
      d.delta.copy(q).sub(d.start);
      d.moved = d.delta.lengthSq() > 1e-12;
      const c = this.comp(d.id);
      if (!c || !this.doc) return;
      const tfs: Record<string, Tf> = {};
      for (const x of this.doc.components) tfs[x.id] = x.tf;
      tfs[d.id] = compose(translation([d.delta.x, d.delta.y, d.delta.z]), c.tf);
      // A mated component moves only where its mates let it (FR-MATE-001): solved from the dragged position.
      if (d.mated) { const r = this.solveDoc(this.doc, [], tfs); if (!r.ok) return; d.result = r.tfs; this.previewTfs(r.tfs); }
      else { d.result = tfs; this.previewTfs(tfs); }
    }, true);
    vp.addEventListener("pointerup", e => {
      const md = this.mateDown;
      this.mateDown = null;
      if (this.mating && md && e.button === 0 && e.target === canvas() && Math.hypot(e.clientX - md.x, e.clientY - md.y) <= 4) { this.pickMateFace(e.clientX, e.clientY); return; }
      const d = this.drag;
      if (!d) return;
      e.stopPropagation();
      this.drag = null;
      if (!d.moved || !d.result) { this.renderTree(); this.renderBar(); return; }
      const res = d.result;
      this.change(doc => { for (const c of doc.components) if (res[c.id]) c.tf = res[c.id]; });
    }, true);
  }

  // ---------- rendering ----------

  renderAll() {
    if (!this.doc) return;
    this.renderBar();
    this.renderTree();
    this.renderPanel();
    this.host.setDoc(this.label());
    document.title = `${this.doc.name} · MöbiusCAD`;
  }

  private renderBar() {
    const bar = $("#asm-bar");
    bar.hidden = !this.doc;
    if (!this.doc) return;
    const sel = this.comp(this.selected);
    const b = (c: string, label: string, title: string, dis = false) => `<button class="mc-b" data-ac="${c}" title="${esc(title)}"${dis ? " disabled" : ""}><span class="mc-l">${esc(label)}</span></button>`;
    $("#asm-tools").innerHTML = b("insert", t("Insert component"), t("Insert component: a part, STEP, IGES or BREP model"))
      + b("mate", t("Mate"), t("Mate: pick two faces to position components relative to each other"), this.doc.components.length < 2)
      + b("interfere", t("Interference"), t("Interference detection: components whose solids overlap"), this.doc.components.length < 2)
      + b("bom", t("BOM"), t("Bill of materials: parts and quantities, CSV export"), !this.doc.components.length)
      + b("step", t("STEP"), t("Export the assembly as STEP, one named part per component"), !this.doc.components.length)
      + b("move", t("Move component"), t("Move or rotate the selected component (or drag it in the view)"), !sel || !!sel.fixed)
      + b("fix", sel?.fixed ? t("Float") : t("Fix"), t("Fix or float the selected component"), !sel)
      + b("undo", t("Undo"), t("Undo (Ctrl+Z)"), !this.undoStack.length) + b("redo", t("Redo"), t("Redo (Ctrl+Y)"), !this.redoStack.length)
      + b("save", t("Save"), t("Save the assembly (.mcadasm)"));
    $("#asm-tools").querySelectorAll<HTMLButtonElement>("[data-ac]").forEach(x => x.addEventListener("click", () => this.command(x.dataset.ac!)));
    const n = this.doc.components.length;
    $("#asm-status").textContent = n ? `${t("{n} component|{n} components", { n })} · ${t(this.defState())}` : t("Insert a part or a STEP model to start.");
  }

  /** SolidWorks' status: fully defined, under defined or over defined. */
  private defState() {
    const s = this.solved;
    if (s && (!s.ok || s.missing.length)) return "Over defined";
    const free = this.doc!.components.filter(c => !c.fixed && !c.suppressed);
    return free.every(c => s?.dof[c.id] === 0) ? "Fully defined" : "Under defined";
  }

  command(c: string) {
    const sel = this.comp(this.selected);
    if (c === "insert") this.insertComponent();
    else if (c === "mate") { if (this.mating) this.cancelMate(); else this.startMate(); }
    else if (c === "interfere") { if (this.interfere) this.closeInterference(); else void this.runInterference(); }
    else if (c === "bom") this.showBom();
    else if (c === "step") void this.exportStep();
    else if (c === "move" && sel) this.moveComponent(sel.id);
    else if (c === "fix" && sel) this.setFixed(sel.id, !sel.fixed);
    else if (c === "undo") this.undo();
    else if (c === "redo") this.redo();
    else if (c === "save") void this.save();
  }

  private renderTree() {
    const box = $("#asm-tree");
    if (!this.doc) { box.innerHTML = ""; return; }
    const st = new Map(this.statuses.map(s => [s.id, s]));
    const doc = this.doc;
    const row = (id: string, icon: string, label: string, cls = "", extra = "") =>
      `<div class="ft-row${cls}${this.selected === id ? " sel" : ""}" role="treeitem" aria-selected="${this.selected === id}" tabindex="${this.selected === id ? 0 : -1}" data-id="${esc(id)}"><span class="ft-ico" aria-hidden="true">${icon}</span><span class="ft-name" translate="no">${esc(label)}</span>${extra}</div>`;
    let html = row("asm", "◆", this.doc.name, " ft-root");
    html += `<div class="ft-group" role="group">${row("origin", "⊹", t("Origin"), " ft-plane")}</div>`;
    for (const c of this.doc.components) {
      const s = st.get(c.id);
      // SolidWorks marks: (f) fixed, (-) under defined, (+) over defined, none when fully defined.
      const sv = this.solved, over = !!sv && (doc.mates ?? []).some(m => (sv.bad.includes(m.id) || sv.missing.includes(m.id)) && (m.a.comp === c.id || m.b.comp === c.id));
      const mark = c.fixed ? "(f) " : over ? "(+) " : sv && sv.dof[c.id] === 0 ? "" : "(-) ";
      const err = s && !s.ok ? `<span class="ft-err" title="${esc(s.message ?? "")}" role="img" aria-label="${esc(t("Error"))}: ${esc(s.message ?? "")}">⚠</span>` : "";
      const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="hide" title="${esc(c.hidden ? t("Show component") : t("Hide component"))}" aria-label="${esc(c.hidden ? t("Show component") : t("Hide component"))}">${c.hidden ? "◌" : "◉"}</button><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
      html += row(c.id, "▣", mark + c.name, `${c.hidden ? " sup" : ""} ft-comp`, err + tools);
    }
    if (doc.mates?.length) {
      html += row("folder:mates", "⧉", t("Mates"), " ft-mates");
      html += `<div class="ft-group" role="group">`;
      for (const m of doc.mates) {
        const sv = this.solved, bad = !!sv && (sv.bad.includes(m.id) || sv.missing.includes(m.id));
        const names = `${this.comp(m.a.comp)?.name ?? "?"}, ${this.comp(m.b.comp)?.name ?? "?"}`;
        const msg = sv?.missing.includes(m.id) ? t("A face of this mate is missing.") : t("This mate cannot be solved with the others: the assembly would be over-defined.");
        const err = bad ? `<span class="ft-err" title="${esc(msg)}" role="img" aria-label="${esc(t("Error"))}: ${esc(msg)}">⚠</span>` : "";
        const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
        html += row(m.id, MATE_ICON[m.type], `${m.name} (${names})`, `${m.suppressed ? " sup" : ""} ft-mate${bad ? " bad" : ""}`, err + tools);
      }
      html += `</div>`;
    }
    if (!this.doc.components.length) html += `<p class="pm-help muted pad">${esc(t("Insert a part or a STEP model to start."))}</p>`;
    box.innerHTML = html;
    box.querySelectorAll<HTMLElement>(".ft-row").forEach(r => {
      const id = r.dataset.id!;
      r.addEventListener("click", e => {
        const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
        const c = this.comp(id), mt = this.doc?.mates?.find(x => x.id === id);
        if (mt && a === "del") { void this.deleteMate(id); return; }
        if (mt) { this.selected = id; this.renderTree(); this.renderBar(); return; }
        if (c && a === "hide") { this.setHidden(id, !c.hidden); return; }
        if (c && a === "del") { void this.deleteComponent(id); return; }
        this.selected = c ? id : null;
        this.renderTree();
        this.renderBar();
      });
      r.addEventListener("dblclick", () => { const c = this.comp(id), mt = this.doc?.mates?.find(x => x.id === id); if (mt) this.startMate(mt); else if (c && !c.fixed) this.moveComponent(id); });
      r.addEventListener("contextmenu", e => {
        e.preventDefault();
        const c = this.comp(id), mt = this.doc?.mates?.find(x => x.id === id);
        if (c) this.menu(c, e.clientX, e.clientY);
        else if (mt) this.popup([
          [t("Edit mate"), () => this.startMate(mt)],
          ...(mt.align ? [[t("Flip mate alignment"), () => this.setMate(mt.id, { align: mt.align === "aligned" ? "anti" : "aligned" })] as [string, () => void]] : []),
          [mt.suppressed ? t("Unsuppress") : t("Suppress"), () => this.setMate(mt.id, { suppressed: mt.suppressed ? undefined : true })],
          [t("Delete"), () => void this.deleteMate(mt.id)],
        ], e.clientX, e.clientY);
      });
    });
  }

  private menu(c: Component, x: number, y: number) {
    this.popup([
      [c.fixed ? t("Float") : t("Fix"), () => this.setFixed(c.id, !c.fixed)],
      ...(c.fixed ? [] : [[t("Move component"), () => this.moveComponent(c.id)] as [string, () => void]]),
      [c.hidden ? t("Show component") : t("Hide component"), () => this.setHidden(c.id, !c.hidden)],
      [t("Delete"), () => void this.deleteComponent(c.id)],
    ], x, y);
  }

  private popup(items: [string, () => void][], x: number, y: number) {
    document.getElementById("asm-menu")?.remove();
    const m = document.createElement("div");
    m.id = "asm-menu";
    m.className = "mc-menu";
    m.setAttribute("role", "menu");
    m.innerHTML = items.map(([l], i) => `<button role="menuitem" data-i="${i}">${esc(l)}</button>`).join("");
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    document.body.appendChild(m);
    m.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.addEventListener("click", () => { m.remove(); items[Number(b.dataset.i)][1](); }));
    setTimeout(() => document.addEventListener("pointerdown", ev => { if (!m.contains(ev.target as Node)) m.remove(); }, { once: true }), 0);
    m.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private renderPanel() {
    if (this.mating) { this.renderMatePanel(); return; }
    if (this.interfere) { this.renderInterference(); return; }
    const pm = $("#asm-pm");
    if (pm.dataset.id === "mate") delete pm.dataset.id;
    const c = this.comp(this.moving);
    pm.hidden = !c;
    if (!c) { pm.innerHTML = ""; delete pm.dataset.id; return; }
    const p: V3 = [c.tf[3], c.tf[7], c.tf[11]], r = eulerXYZ(c.tf);
    const now: Record<string, number> = { x: p[0], y: p[1], z: p[2], rx: r[0], ry: r[1], rz: r[2] };
    const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);
    // The same component: refresh the values in place, so typing on into the next box is not lost.
    if (pm.dataset.id === c.id) {
      pm.querySelectorAll<HTMLInputElement>("input[data-pose]").forEach(i => { if (i !== document.activeElement && Number(i.value.replace(",", ".")) !== now[i.dataset.pose!]) i.value = fmt(now[i.dataset.pose!]); });
      return;
    }
    pm.dataset.id = c.id;
    const f = (k: string, label: string, v: number, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-pose="${k}" value="${esc(fmt(v))}" spellcheck="false" /><span class="muted">${unit}</span></span></label>`;
    pm.innerHTML = `<div class="pm-head"><h3>${esc(t("Move component"))}</h3><button class="icon" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button></div>`
      + `<p class="pm-help" translate="no">${esc(c.name)}</p>`
      + `<fieldset class="pm-sec"><legend>${esc(t("Position"))}</legend>${f("x", "X", p[0], "mm")}${f("y", "Y", p[1], "mm")}${f("z", "Z", p[2], "mm")}</fieldset>`
      + `<fieldset class="pm-sec"><legend>${esc(t("Rotation"))}</legend>${f("rx", t("About X"), r[0], "°")}${f("ry", t("About Y"), r[1], "°")}${f("rz", t("About Z"), r[2], "°")}</fieldset>`
      + `<p class="pm-help muted">${esc(t("Or drag the component in the view."))}</p>`;
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => { this.moving = null; this.renderPanel(); });
    pm.onkeydown = e => { if (e.key === "Escape") { this.moving = null; this.renderPanel(); } };
    pm.querySelectorAll<HTMLInputElement>("input[data-pose]").forEach(inp => {
      const apply = () => {
        const vals: Record<string, number> = {};
        for (const i of pm.querySelectorAll<HTMLInputElement>("input[data-pose]")) {
          const v = Number(i.value.replace(",", "."));
          if (!Number.isFinite(v)) { i.setAttribute("aria-invalid", "true"); return; }
          i.removeAttribute("aria-invalid");
          vals[i.dataset.pose!] = v;
        }
        const tf = fromPose([vals.x, vals.y, vals.z], [vals.rx, vals.ry, vals.rz]);
        this.change(d => { const x = d.components.find(k => k.id === c.id); if (x) x.tf = tf; });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); this.moving = null; this.renderPanel(); } });
    });
  }

  private refText(ref?: MateRef) {
    if (!ref) return t("Click a face");
    const c = this.comp(ref.comp), g = c && this.geo.get(c.part)?.get(ref.face);
    return `${c?.name ?? "?"}: ${g?.k === "axis" ? t("Cylindrical face") : t("Flat face")}`;
  }

  /** The Mate PropertyManager: selections, standard mates, alignment and value, with a live preview. */
  private renderMatePanel() {
    const pm = $("#asm-pm"), m = this.mating!;
    pm.hidden = false;
    pm.dataset.id = "mate";
    const ga = m.a && this.worldGeo(m.a), gb = m.b && this.worldGeo(m.b);
    const fits = ga && gb ? new Set(mateTypes(ga.k, gb.k)) : new Set<MateType>();
    const typeBtn = (k: MateType) => `<button class="btn small${m.type === k ? " on" : ""}" data-mt="${k}" aria-pressed="${m.type === k}"${fits.has(k) ? "" : " disabled"}><span aria-hidden="true">${MATE_ICON[k]}</span> ${esc(t(MATE_LABEL[k]))}</button>`;
    const val = m.type === "distance" ? `<label class="pm-field"><span>${esc(t("Distance"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-mv value="${esc(String(Math.round((m.value ?? 0) * 1e6) / 1e6))}" spellcheck="false" /><span class="muted">mm</span></span></label>`
      : m.type === "angle" ? `<label class="pm-field"><span>${esc(t("Angle"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-mv value="${esc(String(Math.round(((m.value ?? 0) * 180) / Math.PI * 1e6) / 1e6))}" spellcheck="false" /><span class="muted">°</span></span></label>` : "";
    const canAlign = m.type === "coincident" || m.type === "parallel" || m.type === "distance";
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(m.edit ? t("Edit mate") : t("Mate"))}</h3><span class="pm-okc"><button class="pm-ok" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-a="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>`
      + `<fieldset class="pm-group"><legend>${esc(t("Mate selections"))}</legend>`
      + `<div class="pm-field"><span>1</span><button class="pm-box${!m.a ? " focus" : ""}" data-a="sa" translate="no">${esc(this.refText(m.a))}</button></div>`
      + `<div class="pm-field"><span>2</span><button class="pm-box${m.a && !m.b ? " focus" : ""}" data-a="sb" translate="no">${esc(this.refText(m.b))}</button></div>`
      + `<p class="pm-help muted">${esc(t("Click a flat or cylindrical face on each of two components."))}</p>`
      + `<button class="btn small" data-a="clear"${m.a || m.b ? "" : " disabled"}>${esc(t("Clear selections"))}</button></fieldset>`
      + `<fieldset class="pm-group"><legend>${esc(t("Standard mates"))}</legend><div class="pm-mates">${MATE_TYPES.map(typeBtn).join("")}</div>${val}`
      + (m.type === "distance" || m.type === "angle" ? `<label class="pm-field pm-check"><input type="checkbox" data-a="flip"${m.flip ? " checked" : ""} /> ${esc(t("Flip dimension"))}</label>` : "")
      + `</fieldset>`
      + (canAlign && m.type ? `<fieldset class="pm-group"><legend>${esc(t("Mate alignment"))}</legend><div class="pm-mates"><button class="btn small${m.align === "aligned" ? " on" : ""}" data-al="aligned" aria-pressed="${m.align === "aligned"}">${esc(t("Aligned"))}</button><button class="btn small${m.align !== "aligned" ? " on" : ""}" data-al="anti" aria-pressed="${m.align !== "aligned"}">${esc(t("Anti-aligned"))}</button></div></fieldset>` : "")
      + `<p class="${m.problem ? "pm-err" : "pm-help muted"}" role="status" data-mstatus>${esc(m.problem ?? (m.a && m.b && m.type ? t("Previewed in the view. ✓ adds the mate; the panel stays open for the next one.") : t("✓ with nothing picked closes the panel.")))}</p>`;
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.okMate());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => this.cancelMate());
    pm.querySelector("[data-a=clear]")?.addEventListener("click", () => { m.a = m.b = m.type = undefined; this.drawPicks(); this.previewMate(); });
    pm.querySelectorAll<HTMLButtonElement>("[data-mt]").forEach(b => b.addEventListener("click", () => this.setMateType(b.dataset.mt as MateType)));
    pm.querySelectorAll<HTMLButtonElement>("[data-al]").forEach(b => b.addEventListener("click", () => { m.align = b.dataset.al as "aligned" | "anti"; this.previewMate(); }));
    pm.querySelector<HTMLInputElement>("[data-a=flip]")?.addEventListener("change", e => { m.flip = (e.target as HTMLInputElement).checked; this.previewMate(); });
    const vi = pm.querySelector<HTMLInputElement>("[data-mv]");
    vi?.addEventListener("change", () => {
      const v = Number(vi.value.replace(",", "."));
      if (!Number.isFinite(v) || v < 0) { vi.setAttribute("aria-invalid", "true"); return; }
      m.value = m.type === "angle" ? (v * Math.PI) / 180 : v;
      this.previewMate();
    });
    vi?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); vi.dispatchEvent(new Event("change")); this.okMate(); } });
  }
}
