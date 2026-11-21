// Structural analysis (FRS-structural 14, SA1): the Simulation command tab, the Study side tab (study tree,
// support and load panels with face picking), Solve with progress, and the result plot on the model.
// The study lives in `PartDoc.studies` (undo steps like any edit); results are view-only and go out of
// date when the model, the material or the study changes.
import * as THREE from "three";
import { cmTab, onCmTab, selectCmTab } from "../commandBar";
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { lang, onLangChange, t } from "../i18n";
import { pickMaterial } from "../materialPicker";
import type { FaceRef, PartDoc } from "../model/types";
import { download, pdfWriter } from "../tools/exporters";
import { toRef } from "../tools/materials";
import { UNITS, units } from "../tools/units";
import { chooseModal, toast } from "../ui";
import type { Part, Viewer } from "../viewer/Viewer";
import type { EdgeInfo } from "../topology";
import { SIM_STOPPED, SimClient } from "./client";
import { meshArea, plotTarget, refineMesh, type PlotMesh } from "./plotmesh";
import { hotSpots, type HotSpot } from "./hotspots";
import { chartSvg, reportHtml, reportPdf, type ReportBlock, type SimReport } from "./report";
import { GLOBAL_PASSES, MAX_PASSES, studyProblem, type PassResult, type SimBody } from "./run";
import { GRAVITY, LOAD_LABEL, SUPPORT_LABEL, itemName, newStudy, nextId, pickCount, type LoadType, type PlotKind, type Study, type StudyLoad, type StudySupport, type SupportType } from "./types";

export interface SimHost {
  viewer: Viewer;
  doc(): PartDoc | null;
  change(label: string, fn: (d: PartDoc) => void): void;
  faceNames(): string[];
  faceAt(x: number, y: number): { faceId: number; point: [number, number, number] } | null;
  /** The snapped point under the pointer (part coordinates) and the edge it is on, if any. */
  snapAt(x: number, y: number): { kind: string; point: [number, number, number]; edge?: EdgeInfo } | null;
  simGeo(lin: number, ang: number): Promise<{ geo: SimBody; solids: number }>;
  /** No part command is open. */
  idle(): boolean;
  /** Draws the part's planes, sketches and marks again. */
  redraw(): void;
  /** Shows the Study side tab. */
  showTab(): void;
}

type Edit = { kind: "support"; draft: StudySupport; isNew: boolean } | { kind: "load"; draft: StudyLoad; isNew: boolean };
interface Results { study: string; key: string; passes: PassResult[]; ids: string[]; ms: number; mesh: PlotMesh }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SUPPORTS: SupportType[] = ["fixed", "sliding", "hinge", "dirs"];
const LOADS: LoadType[] = ["force", "pressure", "moment", "gravity"];
const ICON: Record<string, string> = { new: "＋", mat: "◈", fixed: "⏚", sliding: "⇄", hinge: "◎", dirs: "✛", force: "↓", pressure: "⇊", moment: "↻", gravity: "g", solve: "▶", stop: "■", results: "▦", report: "▤" };
const TIP: Record<string, string> = {
  fixed: "Fixed support: the faces cannot move",
  sliding: "Sliding support: the faces slide in their own plane but cannot move across it",
  hinge: "Hinge: cylindrical faces turn about their axis",
  dirs: "Fixed in directions: the faces are held along X, Y or Z",
  force: "Force on faces, spread over their area",
  pressure: "Pressure on faces",
  moment: "Moment on faces",
  gravity: "Gravity on the whole part",
};
const PLOTS: [PlotKind, string][] = [["vm", "von Mises stress"], ["u", "Displacement"], ["ux", "Displacement X"], ["uy", "Displacement Y"], ["uz", "Displacement Z"], ["sf", "Safety factor"], ["err", "Error estimate"]];
/** Safety factors above this are drawn as this (lightly loaded regions would hide the rest of the scale). */
const SF_TOP = 10;
const SUPPORT_COLOR = 0x2f9e44, LOAD_COLOR = 0xd6336c;
/** Blue, cyan, green, yellow, red. */
const RAMP: [number, number, number][] = [[0.11, 0.3, 0.85], [0.1, 0.75, 0.85], [0.25, 0.75, 0.3], [0.95, 0.85, 0.2], [0.88, 0.2, 0.15]];
const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(c => `rgb(${c.map(x => Math.round(x * 255)).join(",")})`).join(", ")})`;

function ramp(x: number, out: Float32Array, o: number) {
  const s = Math.min(1, Math.max(0, x)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(s)), f = s - i;
  for (let k = 0; k < 3; k++) out[o + k] = RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * f;
}

/** Three significant digits, without an exponent for everyday sizes. */
export function sig(x: number): string {
  if (!isFinite(x)) return "–";
  if (x === 0) return "0";
  const a = Math.abs(x);
  return a >= 1e6 || a < 1e-4 ? x.toExponential(2) : String(Number(x.toPrecision(3)));
}
const num = (s: string) => { const v = Number(s.trim().replace(",", ".")); return isFinite(v) ? v : null; };
const trim = (v: number) => String(Number(v.toPrecision(8)));

/** Shown with every result and in every report (FR-RES-060). */
const ASSUMPTIONS = "Linear elastic analysis with small displacements. Results are estimates for design and depend on the loads, supports and connections chosen. They do not replace a validated analysis where one is required.";

export class SimController {
  /** The study shown (view-only; the first one when unset or gone). */
  private activeId: string | null = null;
  private edit: Edit | null = null;
  private res: Results | null = null;
  private running = false;
  private progress = "";
  private error: string | null = null;
  /** Item id → problem text, from the last Solve. */
  private problems = new Map<string, string>();
  private plot: { kind: PlotKind; deformed: boolean; scale: number; on: boolean; marks: boolean } = { kind: "vm", deformed: true, scale: 0, on: true, marks: true };
  /** Hot spots of the results, found once per pass. */
  private hot: { res: Results; n: number; list: HotSpot[] } | null = null;
  /** The hot spot picked in the list (its label is drawn on the model). */
  private hotSel = -1;
  /** What the labels on the plot stand on: a plot-mesh triangle and the weights of the point in it. */
  private pins: { i: number[]; w: number[] }[] = [];
  private client = new SimClient();
  private docId: string | null = null;
  private marks = new THREE.Group();
  private saved: { mesh: THREE.Mesh; mat: THREE.Material } | null = null;
  private overlay: THREE.Mesh | null = null;
  private mats: THREE.Material[] = [];
  private range: [number, number] = [0, 0];
  private usedScale = 0;
  /** Probe mode: a click on the plot pins the value there. */
  private probing = false;
  /** Pinned probes: a triangle of the plot mesh (three vertices) and the weights of the point in it. */
  private probes: { i: [number, number, number]; w: [number, number, number] }[] = [];
  /** The plotted value per plot-mesh vertex, as drawn. */
  private vals: Float32Array | null = null;
  private probeLayer: HTMLElement | null = null;
  /** The last report saved (for tests). */
  private lastReport: { kind: string; blocks: number; images: number } | null = null;

  constructor(private host: SimHost) {
    this.marks.name = "sim-marks";
    $("#sim-tools").addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-s]");
      if (b && !b.disabled) this.command(b.dataset.s!);
    });
    const tree = $("#sim-tree");
    tree.addEventListener("click", e => this.treeClick(e));
    tree.addEventListener("change", e => this.treeChange(e.target as HTMLInputElement));
    const pm = $("#sim-pm");
    pm.addEventListener("click", e => this.panelClick(e));
    pm.addEventListener("change", e => this.panelChange(e.target as HTMLInputElement));
    const lg = $("#sim-legend");
    lg.addEventListener("change", e => this.legendChange(e.target as HTMLInputElement));
    lg.addEventListener("click", e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
      if (a === "close") { this.plot.on = false; this.probing = false; this.showPlot(); this.renderAll(); }
      else if (a === "probe") { this.probing = !this.probing; this.renderLegend(); }
      else if (a === "noprobes") { this.probes = []; this.drawProbes(); this.renderLegend(); }
    });
    onCmTab(tab => { if (tab === "simulation" && this.host.doc()) this.host.showTab(); this.renderAll(); this.drawMarks(); });
    onLangChange(() => this.renderAll());
    this.renderAll();
  }

  // ---------- state ----------

  private study(): Study | null {
    const list = this.host.doc()?.studies ?? [];
    return list.find(s => s.id === this.activeId) ?? list[0] ?? null;
  }

  /** What the results depend on: the model, the material and the study's set-up. */
  private keyOf(doc: PartDoc, st: Study) {
    return JSON.stringify([doc.features, doc.rollback, doc.vars ?? null, doc.material ?? null, st.supports, st.loads, st.settings, st.suppressed ?? null]);
  }

  private stale(): boolean {
    const doc = this.host.doc(), st = this.study();
    return !!this.res && (!doc || !st || st.id !== this.res.study || this.keyOf(doc, st) !== this.res.key);
  }

  get active() { return !!this.edit || (this.probing && !!this.saved); }

  /** For tests and the debug handle. */
  state() {
    const last = this.res?.passes.at(-1);
    return {
      study: this.study()?.id ?? null, editing: this.edit ? this.edit.draft.id : null, running: this.running, error: this.error, stale: this.stale(),
      passes: this.res?.passes.map(p => ({ p: p.p, raised: p.raised ?? null, cells: p.cells, dofs: p.dofs, energy: p.energy, change: p.change, ms: p.ms })) ?? [], errors: last?.errors ?? [],
      maxU: last?.maxU ?? null, maxVm: last?.maxVm ?? null, done: !!last?.done && !this.running,
      reactions: last?.reactions ?? [], applied: last?.applied ?? null,
      plot: { ...this.plot, shown: !!this.saved, range: this.range, scale: this.usedScale, points: (this.res?.mesh.pos.length ?? 0) / 3 }, marks: this.marks.children.length,
      probing: this.probing, probes: this.probes.map(p => this.probeValue(p)), report: this.lastReport,
      hot: this.hotList().map(h => ({ vm: h.vm, at: h.at, singular: h.singular, growth: h.growth })), labels: this.pins.length - this.probes.length,
    };
  }

  /** The document changed (edit, undo, another part, closed). */
  changed() {
    const doc = this.host.doc();
    if ((doc?.id ?? null) !== this.docId) {
      this.docId = doc?.id ?? null;
      this.client.cancel();
      this.clearPlot();
      this.edit = null; this.res = null; this.error = null; this.problems.clear(); this.activeId = null; this.running = false; this.probes = []; this.probing = false;
    }
    $("#t-sim").hidden = !doc;
    if (this.edit && !this.study()) this.edit = null;
    if (this.stale() && this.saved) this.clearPlot();
    this.renderAll();
    this.drawMarks();
  }

  /** The model was built and shown again: the mesh is new. */
  rebuilt() {
    if (this.saved && this.saved.mesh === this.host.viewer.parts[0]?.mesh) this.clearPlot();
    this.saved = null;
    this.disposePlot();
    this.showPlot();
    this.renderAll();
    this.drawMarks();
  }

  // ---------- commands ----------

  private command(c: string) {
    const doc = this.host.doc();
    if (!doc) return;
    if (!this.host.idle()) { toast(t("Finish the open command first.")); return; }
    this.host.showTab();
    if (c === "new") { this.newStudy(); return; }
    if (c === "mat") { void this.pickMat(); return; }
    if (c === "solve") { void this.solve(); return; }
    if (c === "stop") { this.client.cancel(); return; }
    if (c === "report") { void this.report(); return; }
    if (c === "results") { this.plot.on = !this.plot.on; this.showPlot(); this.renderAll(); this.drawMarks(); return; }
    if (!this.study()) this.newStudy();
    const st = this.study();
    if (!st) return;
    if ((SUPPORTS as string[]).includes(c)) {
      const type = c as SupportType;
      this.edit = { kind: "support", isNew: true, draft: { id: nextId(st, "s"), name: itemName(st, type), type, faces: [], ...(type === "dirs" ? { dirs: [true, true, true] as [boolean, boolean, boolean] } : {}) } };
    } else if ((LOADS as string[]).includes(c)) {
      const type = c as LoadType;
      const d: StudyLoad = { id: nextId(st, "l"), name: itemName(st, type), type, faces: [] };
      if (type === "force") { d.normal = true; d.value = { v: 100 }; d.comp = [{ v: 0 }, { v: 0 }, { v: -100 }]; }
      else if (type === "pressure") d.value = { v: 1 };
      else if (type === "moment") d.comp = [{ v: 0 }, { v: 0 }, { v: 1000 }];
      else d.comp = [{ v: 0 }, { v: 0 }, { v: -GRAVITY }];
      this.edit = { kind: "load", isNew: true, draft: d };
    } else return;
    this.renderAll();
    this.drawMarks();
  }

  private newStudy() {
    const doc = this.host.doc();
    if (!doc) return;
    const st = newStudy(doc.studies ?? []);
    this.activeId = st.id;
    this.host.change(t("New study"), d => { (d.studies ??= []).push(st); });
    this.renderAll();
  }

  private async pickMat() {
    const doc = this.host.doc();
    if (!doc) return;
    const r = await pickMaterial({ current: doc.material ?? null });
    if (!r?.material) return;
    const ref = toRef(r.material);
    this.host.change(t("Material"), d => { d.material = ref; });
  }

  private editItem(id: string) {
    const st = this.study();
    if (!st || !this.host.idle()) return;
    const s = st.supports.find(x => x.id === id), l = st.loads.find(x => x.id === id);
    if (s) this.edit = { kind: "support", isNew: false, draft: structuredClone(s) };
    else if (l) this.edit = { kind: "load", isNew: false, draft: structuredClone(l) };
    this.renderAll();
    this.drawMarks();
  }

  private ok() {
    const e = this.edit, st = this.study();
    if (!e || !st) return;
    const d = e.draft;
    if (d.type !== "gravity" && !pickCount(d)) {
      const on = (d as StudyLoad).on;
      toast(on === "edges" ? t("Click the edges on the model first.") : on === "points" ? t("Click the corner points on the model first.") : t("Click the faces on the model first."), "warn");
      return;
    }
    const sid = st.id;
    const label = e.isNew ? t((SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]) : t("Edit {name}", { name: d.name ?? "" });
    this.edit = null;
    this.problems.delete(d.id);
    this.host.change(label, doc => {
      const s = doc.studies?.find(x => x.id === sid);
      if (!s) return;
      const list = (e.kind === "support" ? s.supports : s.loads) as (StudySupport | StudyLoad)[];
      const i = list.findIndex(x => x.id === d.id);
      if (i >= 0) list[i] = d; else list.push(d);
    });
    this.renderAll();
    this.drawMarks();
  }

  private cancel() {
    this.edit = null;
    this.renderAll();
    this.drawMarks();
  }

  /** A click in the view while a panel is open: the face under it joins or leaves the item. */
  click(e: PointerEvent): boolean {
    const ed = this.edit;
    if (!ed && this.probing && this.saved) { this.probeAt(e.clientX, e.clientY); return true; }
    if (!ed) return false;
    if (ed.draft.type === "gravity") return true;
    if (ed.kind === "load" && ed.draft.on) { this.pickEdgeOrPoint(ed.draft, e); return true; }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const name = hit ? this.host.faceNames()[hit.faceId] : undefined;
    if (!hit || !name) return true;
    const d = ed.draft;
    const i = d.faces.findIndex(f => f.name === name);
    if (i >= 0) d.faces.splice(i, 1);
    else {
      if (d.type === "hinge" && this.host.viewer.parts[0]?.data.faces[hit.faceId]?.type !== "cylinder") { toast(t("A hinge needs a cylindrical face."), "warn"); return true; }
      d.faces.push({ name, hint: hit.point });
    }
    this.renderPanel();
    this.drawMarks();
    return true;
  }

  /** A force on edges or points: the edge or corner under the pointer joins or leaves it. */
  private pickEdgeOrPoint(d: StudyLoad, e: PointerEvent) {
    const s = this.host.snapAt(e.clientX, e.clientY), names = this.host.faceNames(), part = this.host.viewer.parts[0];
    if (!part) return;
    if (d.on === "edges") {
      const ed = s?.edge, a = ed ? names[ed.faces[0]] : undefined, b = ed ? names[ed.faces[1]] : undefined;
      if (!ed || !a || !b || a === b) { toast(t("Click an edge between two faces."), "warn"); return; }
      const list = (d.edges ??= []), key = [a, b].sort().join("|");
      const i = list.findIndex(x => [...x.faces].sort().join("|") === key);
      if (i >= 0) list.splice(i, 1); else list.push({ faces: [a, b], hint: [...ed.mid] as [number, number, number] });
    } else {
      if (!s || s.kind !== "vertex") { toast(t("Click a corner point of the model."), "warn"); return; }
      const tol = 1e-4 * this.host.viewer.modelSize, near = (q: number[]) => Math.hypot(q[0] - s.point[0], q[1] - s.point[1], q[2] - s.point[2]) <= tol;
      const fs = new Set<string>();
      for (const ed of part.data.edges) if (near(ed.start) || near(ed.end)) for (const f of ed.faces) if (names[f]) fs.add(names[f]);
      if (fs.size < 2) { toast(t("Click a corner point of the model."), "warn"); return; }
      const list = (d.points ??= []);
      const i = list.findIndex(x => near(x.at));
      if (i >= 0) list.splice(i, 1); else list.push({ faces: [...fs].sort(), at: s.point });
    }
    this.renderPanel();
    this.drawMarks();
  }

  /** "3 faces", "2 edges", "1 point". */
  private pickText(it: StudySupport | StudyLoad): string {
    const on = (it as StudyLoad).on, n = pickCount(it);
    return on === "edges" ? t("{n} edge|{n} edges", { n }) : on === "points" ? t("{n} point|{n} points", { n }) : t("{n} face|{n} faces", { n });
  }

  key(e: KeyboardEvent): boolean {
    if (!this.edit && this.probing && this.saved && e.key === "Escape") { this.probing = false; this.renderLegend(); return true; }
    if (!this.edit) return false;
    if (e.key === "Escape") { this.cancel(); return true; }
    if (e.key === "Enter") { this.ok(); return true; }
    return false;
  }

  // ---------- solve ----------

  async solve() {
    const doc = this.host.doc(), st = this.study();
    if (!doc || !st || this.running) return;
    if (this.edit) { toast(t("Finish the open command first.")); return; }
    const m = doc.material;
    if (!m || !m.E || m.nu == null) {
      toast(t("Pick a material with an elastic modulus and Poisson's ratio first."), "warn");
      void this.pickMat();
      return;
    }
    const part = this.host.viewer.parts[0];
    if (!part) { toast(t("The part has no body yet."), "warn"); return; }
    this.running = true; this.error = null; this.res = null; this.problems.clear(); this.probes = []; this.hot = null; this.hotSel = -1;
    this.clearPlot();
    this.progress = t("Reading the geometry…");
    this.renderAll();
    const key = this.keyOf(doc, st), t0 = performance.now();
    try {
      const size = this.host.viewer.modelSize;
      const { geo, solids } = await this.host.simGeo(Math.max(0.002, size * 2e-5), 0.05);
      if (solids !== 1) throw new Error("E-SIM-BODIES");
      const problem = studyProblem(st, geo);
      if (problem.problems.length) {
        for (const p of problem.problems) this.problems.set(p.id, p.code);
        throw new Error(`${problem.problems[0].code}: ${problem.problems[0].id}`);
      }
      const g = part.mesh.geometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), n = pa.count;
      const p0 = new Float32Array(3 * n), n0 = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        p0[3 * i] = pa.getX(i); p0[3 * i + 1] = pa.getY(i); p0[3 * i + 2] = pa.getZ(i);
        if (na) { n0[3 * i] = na.getX(i); n0[3 * i + 1] = na.getY(i); n0[3 * i + 2] = na.getZ(i); }
      }
      // the results are drawn on a finer copy of the display mesh (a flat face has only two triangles)
      const idx = g.getIndex()?.array ?? null;
      const mesh = refineMesh(p0, n0, idx, plotTarget(meshArea(p0, idx), size / 70));
      const pos = mesh.pos, nrm = mesh.nrm;
      const total = Math.max(1, Math.min(MAX_PASSES, Math.round(st.settings.passes)));
      this.progress = t("Pass {n} of {m}…", { n: 1, m: total });
      this.renderAll();
      const res: Results = { study: st.id, key, passes: [], ids: problem.supportIds, ms: 0, mesh };
      await this.client.solve({
        body: geo, problem, passes: total, energyTol: st.settings.energyTol, pos, nrm,
        mat: { name: m.name, E: m.E * 1000, nu: m.nu, rho: m.density * 1e-9, sy: m.sy ?? undefined, su: m.su ?? undefined },
      }, p => {
        res.passes.push(p);
        res.ms = performance.now() - t0;
        this.res = res;
        this.plot.on = true;
        if (!p.done) this.progress = t("Pass {n} of {m}…", { n: p.pass + 1, m: total });
        this.showPlot();
        this.renderAll();
        this.drawMarks();
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== SIM_STOPPED) { this.error = msg; toast(this.errorText(msg), "error"); }
    } finally {
      this.running = false;
      this.renderAll();
      this.drawMarks();
    }
  }

  private nameOf(id: string) {
    const st = this.study();
    return [...(st?.supports ?? []), ...(st?.loads ?? [])].find(x => x.id === id)?.name ?? id;
  }

  private errorText(msg: string): string {
    const [code, rest = ""] = msg.split(": ");
    const name = this.nameOf(rest.trim());
    switch (code) {
      case "E-SIM-NOLOAD": return t("Add a load first.");
      case "E-SIM-FREE": return rest.trim() === "6" && !this.study()?.supports.length ? t("Add a support first.") : t("The supports leave the part free to move ({n} free motions). Add or change the supports.", { n: rest.trim() });
      case "E-SIM-BODIES": return t("Static analysis works on one solid body for now.");
      case "E-SIM-NOBODY": return t("The part has no body yet.");
      case "E-SIM-REF": return t("{name}: a face is gone. Pick its faces again.", { name });
      case "E-SIM-EMPTY": return t("{name} has no faces.", { name });
      case "E-SIM-HINGE": return t("{name}: a hinge needs cylindrical faces on one axis.", { name });
      case "E-SIM-SINGULAR": return t("The solver could not solve this set-up. Check the supports.");
      default: return t("The analysis failed: {msg}", { msg });
    }
  }

  // ---------- drawing on the model ----------

  private faceIds(faces: FaceRef[]): number[] {
    const names = this.host.faceNames(), out: number[] = [];
    for (const f of faces) names.forEach((n, i) => { if (n === f.name) out.push(i); });
    return out;
  }

  /** Triangles of the faces, in the part's coordinates, with their area-weighted centre and normal. */
  private faceGeo(part: Part, ids: number[]) {
    const g = part.mesh.geometry, pos = g.getAttribute("position"), idx = g.getIndex();
    const out: number[] = [], c = new THREE.Vector3(), nrm = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), w = new THREE.Vector3();
    let area = 0;
    for (const i of ids) {
      const fc = part.data.faces[i];
      if (!fc) continue;
      for (let tri = fc.triStart; tri < fc.triStart + fc.triCount; tri++) {
        const v = [0, 1, 2].map(k => (idx ? idx.getX(tri * 3 + k) : tri * 3 + k));
        a.fromBufferAttribute(pos, v[0]); b.fromBufferAttribute(pos, v[1]); d.fromBufferAttribute(pos, v[2]);
        out.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
        w.subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
        const ar = w.length() / 2;
        area += ar;
        c.addScaledVector(a, ar / 3).addScaledVector(b, ar / 3).addScaledVector(d, ar / 3);
        nrm.addScaledVector(w, 0.5);
      }
    }
    if (area > 0) c.multiplyScalar(1 / area);
    return { tris: out, centre: c, normal: nrm.lengthSq() > 0 ? nrm.normalize() : null };
  }

  /** Coloured faces of the supports and loads, and an arrow per load, while the Simulation tab is open. */
  private drawMarks() {
    for (const o of [...this.marks.children]) {
      this.marks.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
      if (o instanceof THREE.ArrowHelper) o.dispose();
    }
    const part = this.host.viewer.parts[0], st = this.study();
    this.marks.removeFromParent();
    if (!part || !st || cmTab() !== "simulation") { this.host.viewer.invalidate(); return; }
    part.group.add(this.marks);
    const plotted = !!this.saved;
    const off = new Set(st.suppressed ?? []);
    const draw = (it: StudySupport | StudyLoad, load: boolean, hot: boolean) => {
      const color = load ? LOAD_COLOR : SUPPORT_COLOR;
      const g = this.faceGeo(part, this.faceIds(it.faces));
      if (g.tris.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(g.tris, 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: hot ? 0.6 : 0.4, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        mesh.renderOrder = 2900;
        mesh.userData.simMark = it.id;
        mesh.raycast = () => {};
        this.marks.add(mesh);
      }
      if (!load) return;
      const l = it as StudyLoad, len = this.host.viewer.modelSize * 0.14;
      let dir: THREE.Vector3 | null = null, at = g.centre;
      let picked = g.tris.length > 0;
      if (l.type === "force" && l.on) {
        const names = this.host.faceNames(), pts: number[] = [], sum = new THREE.Vector3();
        let n = 0;
        if (l.on === "edges") for (const e of l.edges ?? []) for (const ed of part.data.edges) {
          const a = names[ed.faces[0]], b = names[ed.faces[1]];
          if (!((a === e.faces[0] && b === e.faces[1]) || (a === e.faces[1] && b === e.faces[0]))) continue;
          for (let k = 0; k + 5 < ed.pts.length; k += 3) pts.push(ed.pts[k], ed.pts[k + 1], ed.pts[k + 2], ed.pts[k + 3], ed.pts[k + 4], ed.pts[k + 5]);
          sum.add(new THREE.Vector3(...ed.mid)); n++;
        }
        else for (const q of l.points ?? []) { pts.push(...q.at); sum.add(new THREE.Vector3(...q.at)); n++; }
        if (pts.length) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
          const o = l.on === "edges"
            ? new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
            : new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 11, sizeAttenuation: false, depthTest: false, transparent: true }));
          o.renderOrder = 2940;
          o.userData.simMark = it.id;
          o.raycast = () => {};
          this.marks.add(o);
        }
        picked = n > 0;
        if (n) at = sum.multiplyScalar(1 / n);
      }
      const comp = () => new THREE.Vector3(...(l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v) as [number, number, number]);
      if (l.type === "gravity") { dir = comp(); at = new THREE.Box3().setFromBufferAttribute(part.mesh.geometry.getAttribute("position") as THREE.BufferAttribute).getCenter(new THREE.Vector3()); }
      else if (!picked) return;
      else if (l.type === "pressure" || (l.type === "force" && l.normal)) dir = g.normal ? g.normal.clone().multiplyScalar(l.flip ? 1 : -1) : null;
      else dir = comp();
      if (!dir || dir.lengthSq() === 0) return;
      dir.normalize();
      // a pushing arrow ends on the face; a moment's arrow starts there, along its axis
      const from = l.type === "moment" || l.type === "gravity" ? at.clone() : at.clone().addScaledVector(dir, -len);
      const arrow = new THREE.ArrowHelper(dir, from, len, l.type === "moment" ? 0x7048e8 : color, len * 0.28, len * 0.12);
      arrow.traverse(o => { const mm = (o as THREE.Mesh).material as THREE.Material | undefined; if (mm) { mm.depthTest = false; mm.transparent = true; } o.renderOrder = 2950; });
      arrow.userData.simArrow = it.id;
      arrow.traverse(o => { o.raycast = () => {}; });
      this.marks.add(arrow);
    };
    const ed = this.edit;
    for (const s of st.supports) if (s.id !== ed?.draft.id && !off.has(s.id) && !plotted) draw(s, false, false);
    for (const l of st.loads) if (l.id !== ed?.draft.id && !off.has(l.id) && !plotted) draw(l, true, false);
    if (ed) draw(ed.draft, ed.kind === "load", true);
    this.host.viewer.invalidate();
  }

  private values(r: PassResult, kind: PlotKind): Float32Array {
    if (kind === "vm") return r.vm;
    if (kind === "err") return r.err;
    if (kind === "sf") {
      const sy = this.host.doc()?.material?.sy ?? 0, out = new Float32Array(r.vm.length);
      for (let i = 0; i < out.length; i++) out[i] = Math.min(SF_TOP, sy / Math.max(r.vm[i], 1e-9));
      return out;
    }
    const n = r.vm.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = r.u[3 * i], y = r.u[3 * i + 1], z = r.u[3 * i + 2];
      out[i] = kind === "ux" ? x : kind === "uy" ? y : kind === "uz" ? z : Math.hypot(x, y, z);
    }
    return out;
  }

  // ---------- probes ----------

  /** Pins the plotted value at the point of the plot under the pointer. */
  private probeAt(x: number, y: number) {
    const ov = this.overlay, v = this.host.viewer;
    if (!ov) return;
    const r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2), v.camera);
    const hits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(ov, rc, hits);
    hits.sort((a, b) => a.distance - b.distance);
    const h = hits.find(q => !v.clipPlanes.some(pl => pl.distanceToPoint(q.point) < 0)), f = h?.face;
    if (!h || !f) return;
    const pa = ov.geometry.getAttribute("position"), P = (i: number) => new THREE.Vector3().fromBufferAttribute(pa, i);
    const w = THREE.Triangle.getBarycoord(ov.worldToLocal(h.point.clone()), P(f.a), P(f.b), P(f.c), new THREE.Vector3());
    if (!w) return;
    this.probes.push({ i: [f.a, f.b, f.c], w: [w.x, w.y, w.z] });
    this.drawProbes();
    this.renderLegend();
  }

  private probeValue(p: { i: [number, number, number]; w: [number, number, number] }) {
    const a = this.vals;
    return a ? p.w[0] * a[p.i[0]] + p.w[1] * a[p.i[1]] + p.w[2] * a[p.i[2]] : NaN;
  }

  /** The plotted quantity's unit and the factor from the solver's units to it. */
  private plotUnit(): [string, number] {
    const k = this.plot.kind;
    return k === "vm" ? ["MPa", 1] : k === "sf" ? ["", 1] : k === "err" ? ["%", 1] : [units.current, UNITS[units.current].f];
  }

  /** The hot spots of the last pass: the highest stress peaks, likely singularities flagged. */
  private hotList(): HotSpot[] {
    const r = this.res;
    if (!r || !r.passes.length) return [];
    if (this.hot?.res !== r || this.hot.n !== r.passes.length) this.hot = { res: r, n: r.passes.length, list: hotSpots(r.mesh.pos, r.mesh.index, r.passes, this.host.viewer.modelSize / 12) };
    return this.hot.list;
  }

  /** Labels of the highest and lowest values, and of the hot spots on a stress plot. */
  private peakLabels(): { v: number; html: string }[] {
    const a = this.vals;
    if (!a || !this.plot.marks) return [];
    const [unit, f] = this.plotUnit(), val = (x: number) => `${sig(x * f)}${unit ? ` ${esc(unit)}` : ""}`;
    const out: { v: number; html: string }[] = [];
    const sing = esc(t("Stress singularity: value depends on refinement"));
    let lo = 0, hi = 0;
    for (let i = 1; i < a.length; i++) { if (a[i] < a[lo]) lo = i; if (a[i] > a[hi]) hi = i; }
    const label = (cls: string, key: string, text: string, v: number, warn = false) => out.push({ v, html: `<div class="sim-probe sim-peak ${cls}${warn ? " warn" : ""}" data-peak="${key}"${warn ? ` title="${sing}"` : ""}><i></i><span>${warn ? "⚠ " : ""}${text}</span></div>` });
    if (this.plot.kind === "vm") {
      const hs = this.hotList(), top = hs.findIndex(h => !h.singular);
      hs.forEach((h, i) => { if (h.singular || i === top || i === this.hotSel) label("hot", `h${i}`, `<b>${i + 1}</b> <span translate="no">${val(h.vm)}</span>`, h.v, h.singular); });
      if (!hs.length) label("max", "max", `${esc(t("Max"))} <span translate="no">${val(a[hi])}</span>`, hi);
    } else if (this.plot.kind === "sf") label("min", "min", `${esc(t("Min"))} <span translate="no">${val(a[lo])}</span>`, lo);
    else {
      label("max", "max", `${esc(t("Max"))} <span translate="no">${val(a[hi])}</span>`, hi);
      if (a[lo] < 0) label("min", "min", `${esc(t("Min"))} <span translate="no">${val(a[lo])}</span>`, lo);
    }
    return out;
  }

  /** Labels on the plot (pinned probes, highest and lowest values, hot spots), kept on their points as the view moves. */
  private drawProbes() {
    const peaks = this.saved && this.overlay ? this.peakLabels() : [];
    const show = !!this.saved && !!this.overlay && this.probes.length + peaks.length > 0;
    if (!show) { this.probeLayer?.replaceChildren(); this.pins = []; return; }
    if (!this.probeLayer) {
      const el = this.probeLayer = document.createElement("div");
      el.id = "sim-probes";
      $("#viewport").appendChild(el);
      el.addEventListener("click", e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rm]");
        if (b) { this.probes.splice(Number(b.dataset.rm), 1); this.drawProbes(); this.renderLegend(); }
      });
      this.host.viewer.onRender(() => this.placeProbes());
    }
    const [unit, f] = this.plotUnit();
    this.probeLayer.innerHTML = this.probes.map((p, i) => `<div class="sim-probe" data-probe="${i}"><i></i><span translate="no">${sig(this.probeValue(p) * f)}${unit ? ` ${esc(unit)}` : ""}</span>`
      + `<button data-rm="${i}" title="${esc(t("Remove probe"))}" aria-label="${esc(t("Remove probe"))}">×</button></div>`).join("") + peaks.map(p => p.html).join("");
    this.pins = [...this.probes, ...peaks.map(p => ({ i: [p.v], w: [1] }))];
    this.placeProbes();
  }

  private placeProbes() {
    const el = this.probeLayer, ov = this.overlay;
    if (!el || !ov || !el.childElementCount) return;
    const v = this.host.viewer, c = v.renderer.domElement, pa = ov.geometry.getAttribute("position");
    const q = new THREE.Vector3(), s = new THREE.Vector3();
    this.pins.forEach((p, k) => {
      const d = el.children[k] as HTMLElement | undefined;
      if (!d) return;
      s.set(0, 0, 0);
      for (let j = 0; j < p.i.length; j++) s.addScaledVector(q.fromBufferAttribute(pa, p.i[j]), p.w[j]);
      ov.localToWorld(s).project(v.camera);
      d.style.left = `${c.offsetLeft + ((s.x + 1) / 2) * c.clientWidth}px`;
      d.style.top = `${c.offsetTop + ((1 - s.y) / 2) * c.clientHeight}px`;
      d.hidden = s.z > 1 || s.z < -1;
    });
  }

  private disposePlot() {
    if (this.overlay) { this.overlay.removeFromParent(); this.overlay.geometry.dispose(); this.overlay = null; }
    for (const m of this.mats) m.dispose();
    this.mats = [];
  }

  /** A result plot is on the model. */
  get plotting() { return !!this.saved; }

  private clearPlot() {
    const was = !!this.saved;
    if (this.saved) {
      const s = this.saved;
      s.mesh.material = s.mat;
      this.saved = null;
    }
    this.disposePlot();
    this.drawProbes();
    if (was) this.host.redraw();
    this.host.viewer.invalidate();
  }

  /**
   * Colours the model by the chosen result of the last pass, on the refined plot mesh. The model itself is hidden
   * under it, or stays as a ghost when the plot is drawn deformed.
   */
  private showPlot() {
    this.clearPlot();
    const part = this.host.viewer.parts[0], res = this.res, r = res?.passes.at(-1);
    if (!part || !res || !r || !this.plot.on || this.stale()) return;
    const pm = res.mesh, n = pm.pos.length / 3;
    if (r.vm.length !== n) return;
    // the safety factor needs a yield strength: without one the plot falls back to stress
    if (this.plot.kind === "sf" && !this.host.doc()?.material?.sy) this.plot.kind = "vm";
    // the error estimate compares two passes
    if (this.plot.kind === "err" && r.pass < 2) this.plot.kind = "vm";
    const val = this.values(r, this.plot.kind), sf = this.plot.kind === "sf";
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (val[i] < lo) lo = val[i]; if (val[i] > hi) hi = val[i]; }
    if (this.plot.kind === "vm" || this.plot.kind === "u" || this.plot.kind === "err") lo = 0;
    this.range = [lo, hi];
    this.vals = val;
    const colors = new Float32Array(3 * n), span = hi - lo || 1;
    // a low safety factor is the red end
    for (let i = 0; i < n; i++) ramp(sf ? 1 - (val[i] - lo) / span : (val[i] - lo) / span, colors, 3 * i);
    const colorMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    colorMat.clippingPlanes = this.host.viewer.clipPlanes;
    const under = new THREE.MeshBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    under.clippingPlanes = this.host.viewer.clipPlanes;
    under.visible = this.plot.deformed;
    this.mats.push(colorMat, under);
    this.saved = { mesh: part.mesh, mat: part.mesh.material };
    part.mesh.material = under;
    this.host.redraw();
    const scale = this.plot.scale > 0 ? this.plot.scale : r.maxU > 0 ? (0.05 * this.host.viewer.modelSize) / r.maxU : 1;
    this.usedScale = this.plot.deformed ? scale : 0;
    let at = pm.pos;
    if (this.plot.deformed) {
      at = new Float32Array(3 * n);
      for (let i = 0; i < 3 * n; i++) at[i] = pm.pos[i] + scale * r.u[i];
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(pm.index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(at, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(pm.nrm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.overlay = new THREE.Mesh(geo, colorMat);
    this.overlay.userData.simPlot = true;
    this.overlay.raycast = () => {};
    part.mesh.parent?.add(this.overlay);
    this.overlay.position.copy(part.mesh.position);
    this.overlay.quaternion.copy(part.mesh.quaternion);
    this.overlay.scale.copy(part.mesh.scale);
    this.overlay.updateMatrixWorld(true);
    if (this.probes.some(p => Math.max(...p.i) >= n)) this.probes = [];
    this.drawProbes();
    this.host.viewer.invalidate();
  }

  // ---------- report ----------

  /** The plot of one result as a picture, in the current view, with its colour scale drawn in. */
  private capture(kind: PlotKind): { src: string; w: number; h: number; caption: string } | null {
    this.plot.kind = kind;
    this.plot.on = true;
    this.showPlot();
    if (!this.saved || this.plot.kind !== kind) return null;
    const v = this.host.viewer, src = v.renderer.domElement;
    v.render();
    if (!src.width || !src.height) return null;
    const k = Math.min(1, 1400 / src.width), c = document.createElement("canvas");
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    const [unit, f] = this.plotUnit(), sf = kind === "sf";
    const lo = sig(this.range[0] * f), hi = sf && this.range[1] >= SF_TOP ? `${SF_TOP}+` : sig(this.range[1] * f);
    // the colour scale, bottom left
    const s = Math.max(1, c.width / 900), bw = 190 * s, bh = 10 * s, x0 = 14 * s, y0 = c.height - 30 * s;
    g.fillStyle = "rgba(255,255,255,0.9)"; g.fillRect(x0 - 6 * s, y0 - 6 * s, bw + 12 * s, bh + 28 * s);
    const gr = g.createLinearGradient(sf ? x0 + bw : x0, 0, sf ? x0 : x0 + bw, 0);
    RAMP.forEach((col, i) => gr.addColorStop(i / (RAMP.length - 1), `rgb(${col.map(x => Math.round(x * 255)).join(",")})`));
    g.fillStyle = gr; g.fillRect(x0, y0, bw, bh);
    g.fillStyle = "#111827"; g.font = `${11 * s}px "DejaVu Sans", system-ui, sans-serif`; g.textBaseline = "top";
    g.textAlign = "left"; g.fillText(lo, x0, y0 + bh + 3 * s);
    g.textAlign = "center"; g.fillText(unit, x0 + bw / 2, y0 + bh + 3 * s);
    g.textAlign = "right"; g.fillText(hi, x0 + bw, y0 + bh + 3 * s);
    const label = t(PLOTS.find(p => p[0] === kind)![1]);
    const caption = `${label}: ${lo} … ${hi}${unit ? ` ${unit}` : ""}` + (this.plot.deformed ? `. ${t("Deformed shape")} ×${sig(this.usedScale)}` : "");
    return { src: c.toDataURL("image/jpeg", 0.9), w: c.width, h: c.height, caption };
  }

  /** What the report says: the study, its set-up and the results of the last pass, in the UI language. */
  private reportOf(): SimReport | null {
    const doc = this.host.doc(), st = this.study(), res = this.res, last = res?.passes.at(-1);
    if (!doc || !st || !res || !last || this.stale()) return null;
    const m = doc.material, off = new Set(st.suppressed ?? []);
    const blocks: ReportBlock[] = [];
    const kv = (rows: string[][]) => blocks.push({ kind: "table", rows: [[t("Property"), t("Value")], ...rows], widths: [2, 3] });
    const n3 = (c: number[], f: number, unit: string) => `X ${sig(c[0] * f)}, Y ${sig(c[1] * f)}, Z ${sig(c[2] * f)} ${unit}`;
    const faces = (it: StudySupport | StudyLoad) => it.type === "gravity" ? "–" : this.pickText(it);
    const name = (it: StudySupport | StudyLoad) => (it.name ?? it.id) + (off.has(it.id) ? ` (${t("left out")})` : "");
    blocks.push({ kind: "h", text: t("Study") });
    kv([[t("Document"), doc.name], [t("Study"), st.name], [t("Kind"), t("Static")], [t("Passes"), `${res.passes.length} / ${st.settings.passes}`],
      [t("Unknowns"), last.dofs.toLocaleString("en-US").replace(/,/g, " ")], [t("Time"), `${(res.ms / 1000).toFixed(1)} s`]]);
    blocks.push({ kind: "h", text: t("Material") });
    if (m) kv([[t("Name"), m.name], [t("Elastic modulus"), `${sig(m.E ?? NaN)} GPa`], [t("Poisson's ratio"), sig(m.nu ?? NaN)], [t("Density"), `${sig(m.density)} g/cm³`],
      ...(m.sy ? [[t("Yield strength"), `${sig(m.sy)} MPa`]] : [])]);
    blocks.push({ kind: "h", text: t("Supports") });
    blocks.push({ kind: "table", widths: [3, 3, 2, 4], rows: [[t("Name"), t("Type"), t("Applied to"), t("Details")], ...st.supports.map(s => [name(s), t(SUPPORT_LABEL[s.type]), faces(s),
      s.type === "hinge" && s.axialFree ? t("Free to slide along the axis") : s.type === "dirs" ? ["X", "Y", "Z"].filter((_, i) => (s.dirs ?? [true, true, true])[i]).join(", ") : ""])] });
    blocks.push({ kind: "h", text: t("Loads") });
    blocks.push({ kind: "table", widths: [3, 3, 2, 4], rows: [[t("Name"), t("Type"), t("Applied to"), t("Value")], ...st.loads.map(l => {
      const c = (l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v), pull = l.flip ? `, ${t("Reverse (pull)")}` : "";
      const val = l.type === "force" ? (l.normal && !l.on ? `${sig(l.value?.v ?? 0)} N, ${t("Along the face normal")}${pull}` : n3(c, 1, "N"))
        : l.type === "pressure" ? `${sig(l.value?.v ?? 0)} MPa${pull}` : l.type === "moment" ? n3(c, 1e-3, "N·m") : n3(c, 1e-3, "m/s²");
      return [name(l), t(LOAD_LABEL[l.type]), faces(l), val];
    })] });
    blocks.push({ kind: "h", text: t("Results") });
    const f = (v: number[]) => sig(Math.hypot(v[0], v[1], v[2]));
    const hs = this.hotList(), singular = hs.some(h => h.singular), real = singular ? hs.find(h => !h.singular) : undefined, peak = real?.vm ?? last.maxVm;
    const rows: string[][] = [[t("Max von Mises stress"), `${sig(last.maxVm)} MPa${singular ? ` (${t("Stress singularity: value depends on refinement")})` : ""}`]];
    if (real) rows.push([t("Highest stress away from singularities"), `${sig(real.vm)} MPa`]);
    rows.push([t("Max displacement"), this.lenText(last.maxU)]);
    if (m?.sy && peak > 0) rows.push([t("Lowest safety factor (yield)"), sig(m.sy / peak)]);
    const errs = last.errors, eLast = errs.at(-1), eBefore = errs.length > 1 ? errs[errs.length - 2] : null;
    if (eLast != null) rows.push([t("Estimated error"), `≈ ${sig(eLast)} %`]);
    else if (eBefore != null) rows.push([t("Estimated error"), `< ${sig(eBefore)} %`]);
    rows.push([t("Applied load"), `${f(last.applied.force)} N (${last.applied.force.map(x => sig(x)).join(", ")})`]);
    last.reactions.forEach((re, i) => rows.push([`${t("Reaction")} ${this.nameOf(res.ids[i] ?? "")}`, `${f(re.force)} N (${re.force.map(x => sig(x)).join(", ")})`]));
    kv(rows);
    const keep = { ...this.plot };
    const kinds: PlotKind[] = ["vm", "u", ...(m?.sy ? ["sf" as PlotKind] : [])];
    for (const k of kinds) { const im = this.capture(k); if (im) blocks.push({ kind: "image", ...im }); }
    this.plot = keep;
    this.showPlot();
    if (this.probes.length && this.saved) {
      const [unit, uf] = this.plotUnit(), label = t(PLOTS.find(p => p[0] === this.plot.kind)![1]);
      blocks.push({ kind: "table", widths: [2, 3], rows: [[t("Probe"), `${label}${unit ? `, ${unit}` : ""}`], ...this.probes.map((p, i) => [String(i + 1), sig(this.probeValue(p) * uf)])] });
    }
    if (hs.length) {
      const uf = UNITS[units.current].f;
      blocks.push({ kind: "h", text: t("Hot spots") });
      blocks.push({ kind: "table", widths: [1, 3, 4, 5], rows: [["#", `${t("von Mises stress")}, MPa`, `X, Y, Z, ${units.current}`, t("Note")],
        ...hs.map((h, i) => [String(i + 1), sig(h.vm), h.at.map(x => String(Number((x * uf).toFixed(3)))).join(", "), h.singular ? t("Stress singularity: value depends on refinement") : ""])] });
    }
    blocks.push({ kind: "h", text: t("Convergence") });
    blocks.push({ kind: "table", widths: [1, 2, 2, 2, 2], rows: [[t("Pass"), t("Unknowns"), t("Energy change"), t("Est. error"), t("Time")],
      ...res.passes.map((p, i) => [String(p.pass), p.dofs.toLocaleString("en-US").replace(/,/g, " "), p.change == null ? "–" : `${sig(p.change)} %`, errs[i] == null ? "–" : `${i === errs.length - 1 ? "≈ " : ""}${sig(errs[i]!)} %`, `${(p.ms / 1000).toFixed(1)} s`])] });
    if (errs.filter(e => e != null).length > 1) blocks.push({ kind: "chart", errs, label: t("Estimated error per pass") });
    for (const line of this.localNotes(res.passes)) blocks.push({ kind: "p", muted: true, text: line });
    blocks.push({ kind: "p", muted: true, text: last.converged ? t("Converged: the last pass changed the strain energy by {n} %.", { n: sig(last.change ?? 0) })
      : last.change != null ? t("Not converged to {tol} % yet (last change {n} %). Stress near sharp corners keeps rising with accuracy.", { tol: sig(st.settings.energyTol), n: sig(last.change) })
      : t("One pass only: no convergence check.") });
    blocks.push({ kind: "h", text: t("Assumptions") });
    blocks.push({ kind: "p", text: t(ASSUMPTIONS) });
    return { title: t("Structural analysis report"), sub: `${doc.name} · ${st.name} · ${new Date().toLocaleString(lang())} · MöbiusCAD ${__APP_VERSION__}`, blocks };
  }

  /** Report: asks for the format, then saves the file. `as` skips the question. */
  async report(as?: "pdf" | "html") {
    if (this.running || !this.res || this.stale()) { toast(t("Solve the study first.")); return; }
    const kind = as ?? await chooseModal(t("Report"), t("The study, its supports and loads, the results with pictures of the current view, and the convergence."), [{ key: "pdf", label: "PDF" }, { key: "html", label: t("Web page (HTML)") }]);
    if (!kind) return;
    const rep = this.reportOf();
    this.renderAll();
    if (!rep) return;
    const doc = this.host.doc()!, st = this.study()!;
    const stem = `${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_");
    try {
      if (kind === "html") download(new Blob([reportHtml(rep, lang())], { type: "text/html" }), `${stem}-report.html`);
      else {
        const [jsPDF, bytes] = await Promise.all([pdfWriter(), fetch(fontUrl).then(r => r.arrayBuffer())]);
        const u8 = new Uint8Array(bytes);
        let bin = "";
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        download(reportPdf(jsPDF, rep, btoa(bin)), `${stem}-report.pdf`);
      }
      this.lastReport = { kind, blocks: rep.blocks.length, images: rep.blocks.filter(b => b.kind === "image").length };
    } catch (e) {
      toast(t("Could not save: {err}", { err: (e as Error).message }), true);
    }
  }

  // ---------- rendering ----------

  private renderAll() {
    this.renderBar();
    this.renderTree();
    this.renderPanel();
    this.renderLegend();
  }

  private renderBar() {
    const el = $("#sim-tools");
    if (cmTab() !== "simulation") return;
    const st = this.study(), busy = this.running;
    const btn = (id: string, label: string, title: string, o: { on?: boolean; dis?: boolean } = {}) =>
      `<button class="mc-b${o.on ? " on" : ""}" data-s="${id}" title="${esc(title)}"${o.on != null ? ` aria-pressed="${!!o.on}"` : ""}${o.dis ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${ICON[id]}</span><span class="mc-l">${esc(label)}</span></button>`;
    const group = (label: string, inner: string) => `<div class="mc-g" role="group" aria-label="${esc(label)}">${inner}</div>`;
    const sep = `<div class="mc-sep"></div>`;
    el.innerHTML = group(t("Study"), btn("new", t("New study"), t("New static study of this part"), { dis: busy }) + btn("mat", t("Material"), t("The part's material: elastic modulus, Poisson's ratio, strength"), { dis: busy }))
      + sep + group(t("Supports"), SUPPORTS.map(k => btn(k, t(SUPPORT_LABEL[k]), t(TIP[k]), { dis: busy })).join(""))
      + sep + group(t("Loads"), LOADS.map(k => btn(k, t(LOAD_LABEL[k]), t(TIP[k]), { dis: busy })).join(""))
      + sep + group(t("Solve"), (busy ? btn("stop", t("Stop"), t("Stop the analysis")) : btn("solve", t("Solve"), t("Run the analysis"), { dis: !st }))
        + btn("results", t("Results"), t("Show or hide the result plot on the model"), { on: this.plot.on && !!this.res && !this.stale(), dis: !this.res || this.stale() })
        + btn("report", t("Report"), t("Save the study and its results as a report"), { dis: busy || !this.res || this.stale() }));
  }

  private renderTree() {
    const el = $("#sim-tree");
    const doc = this.host.doc();
    if (!doc) { el.innerHTML = ""; return; }
    const st = this.study();
    if (!st) {
      el.innerHTML = `<div class="sim-empty"><p>${esc(t("A study holds the supports and loads of one analysis. The part is solved as it is, without a mesh."))}</p><button class="btn" data-a="new">${esc(t("New study"))}</button></div>`;
      return;
    }
    const list = doc.studies ?? [];
    const m = doc.material, matOk = !!m && !!m.E && m.nu != null;
    const off = new Set(st.suppressed ?? []);
    const row = (it: StudySupport | StudyLoad, load: boolean) => {
      const bad = this.problems.get(it.id);
      const isOff = off.has(it.id);
      return `<li class="sim-row${isOff ? " off" : ""}${bad ? " bad" : ""}${this.edit?.draft.id === it.id ? " cur" : ""}" data-id="${it.id}">`
        + `<button class="sim-name" data-a="edit" translate="no" title="${esc(t("Edit"))}"><i class="sim-dot ${load ? "load" : "sup"}" aria-hidden="true"></i>${esc(it.name ?? it.id)}</button>`
        + `<span class="sim-meta">${it.type === "gravity" ? "" : esc(this.pickText(it))}</span>`
        + `<button class="sim-ib" data-a="toggle" aria-pressed="${isOff}" title="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}" aria-label="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}">${isOff ? "○" : "●"}</button>`
        + `<button class="sim-ib" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">×</button>`
        + (bad ? `<p class="sim-prob">${esc(this.errorText(`${bad}: ${it.id}`))}</p>` : "")
        + `</li>`;
    };
    const none = (text: string) => `<li class="sim-none muted">${esc(text)}</li>`;
    let html = `<div class="sim-head">`
      + (list.length > 1 ? `<select data-k="study" aria-label="${esc(t("Study"))}" translate="no">${list.map(s => `<option value="${s.id}"${s.id === st.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`
        : `<b translate="no">${esc(st.name)}</b>`)
      + `<span class="muted">${esc(t("Static"))}</span><button class="sim-ib" data-a="delstudy" title="${esc(t("Delete study"))}" aria-label="${esc(t("Delete study"))}">×</button></div>`;
    html += `<div class="sim-sec"><h4>${esc(t("Material"))}</h4><button class="pm-box${matOk ? "" : " sim-warn"}" data-a="mat">${m ? `<span translate="no">${esc(m.name)}</span>` : esc(t("No material"))}</button>`
      + (m && matOk ? `<p class="sim-note muted">E ${sig(m.E!)} GPa · ν ${sig(m.nu!)}${m.sy ? ` · ${esc(t("yield"))} ${sig(m.sy)} MPa` : ""}</p>` : `<p class="sim-prob">${esc(t("The analysis needs a material with an elastic modulus and Poisson's ratio."))}</p>`) + `</div>`;
    html += `<div class="sim-sec"><h4>${esc(t("Supports"))}</h4><ul class="sim-list">${st.supports.map(s => row(s, false)).join("") || none(t("None yet: pick one in the Simulation tab."))}</ul></div>`;
    html += `<div class="sim-sec"><h4>${esc(t("Loads"))}</h4><ul class="sim-list">${st.loads.map(l => row(l, true)).join("") || none(t("None yet: pick one in the Simulation tab."))}</ul></div>`;
    html += `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: MAX_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === st.settings.passes ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
      + `<label class="pm-field"><span>${esc(t("Stop at energy change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
      + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once the strain energy changes by less than {n} %.", { n: sig(st.settings.energyTol) }))} ${esc(t("Passes after the third raise it only where the estimated error is highest."))}</p></div>`;
    html += `<div class="sim-sec sim-res" aria-live="polite"><h4>${esc(t("Results"))}</h4>${this.resultsHtml()}</div>`;
    el.innerHTML = html;
  }

  private lenText(mm: number) { return `${sig(mm * UNITS[units.current].f)} ${units.current}`; }

  /** One line per local pass: where the accuracy was raised. */
  private localNotes(passes: PassResult[]): string[] {
    return passes.filter(p => p.raised != null && p.pass > GLOBAL_PASSES).map(p => t("Pass {n}: accuracy raised in {k} of {m} cells.", { n: p.pass, k: p.raised!, m: p.cells }));
  }

  private resultsHtml(): string {
    const r = this.res, last = r?.passes.at(-1);
    let html = "";
    if (this.running) html += `<p class="sim-run"><i class="spin" aria-hidden="true"></i>${esc(this.progress)} <button class="btn small" data-a="stop">${esc(t("Stop"))}</button></p>`;
    if (this.error && !this.running) html += `<p class="sim-prob">${esc(this.errorText(this.error))}</p>`;
    if (!r || !last) return html || `<p class="sim-note muted">${esc(t("Not solved yet."))}</p><button class="btn small" data-a="solve">${esc(t("Solve"))}</button>`;
    if (this.stale()) html += `<p class="sim-prob">${esc(t("Out of date: the model or the study changed."))} <button class="btn small" data-a="solve">${esc(t("Solve"))}</button></p>`;
    const f = (v: number[]) => sig(Math.hypot(v[0], v[1], v[2]));
    const hs = this.hotList(), singular = hs.some(h => h.singular), real = singular ? hs.find(h => !h.singular) : undefined, peak = real?.vm ?? last.maxVm;
    const warn = `<span class="sim-warn" title="${esc(t("Stress singularity: value depends on refinement"))}">⚠</span>`;
    html += `<dl class="sim-kv"><dt>${esc(t("Max von Mises stress"))}</dt><dd data-v="maxvm">${sig(last.maxVm)} MPa${singular ? ` ${warn}` : ""}</dd>`;
    if (real) html += `<dt>${esc(t("Highest stress away from singularities"))}</dt><dd data-v="realvm">${sig(real.vm)} MPa</dd>`;
    html += `<dt>${esc(t("Max displacement"))}</dt><dd>${esc(this.lenText(last.maxU))}</dd>`;
    const sy = this.host.doc()?.material?.sy;
    if (sy && peak > 0) html += `<dt>${esc(t("Lowest safety factor (yield)"))}</dt><dd data-v="sf"${sy / peak < 1 ? ' class="sim-low"' : ""}>${sig(sy / peak)}</dd>`;
    const errs = last.errors, eLast = errs.at(-1), eBefore = errs.length > 1 ? errs[errs.length - 2] : null;
    if (eLast != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">≈ ${sig(eLast)} %</dd>`;
    else if (eBefore != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">&lt; ${sig(eBefore)} %</dd>`;
    html += `<dt>${esc(t("Applied load"))}</dt><dd>${f(last.applied.force)} N</dd>`;
    last.reactions.forEach((re, i) => { html += `<dt>${esc(t("Reaction"))} <span translate="no">${esc(this.nameOf(r.ids[i] ?? ""))}</span></dt><dd title="${re.force.map(x => sig(x)).join(", ")} N">${f(re.force)} N</dd>`; });
    html += `</dl><table class="sim-passes"><thead><tr><th>${esc(t("Pass"))}</th><th>${esc(t("Unknowns"))}</th><th>${esc(t("Energy change"))}</th><th>${esc(t("Est. error"))}</th><th>${esc(t("Time"))}</th></tr></thead><tbody>`
      + r.passes.map((p, i) => `<tr><td>${p.pass}</td><td>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${sig(p.change)} %`}</td><td>${errs[i] == null ? "–" : `${i === errs.length - 1 ? "≈ " : ""}${sig(errs[i]!)} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`
      + chartSvg(errs, t("Estimated error per pass"));
    for (const line of this.localNotes(r.passes)) html += `<p class="sim-note muted sim-local">${esc(line)}</p>`;
    if (hs.length) {
      const uf = UNITS[units.current].f;
      html += `<h5 class="sim-sub">${esc(t("Hot spots"))}</h5><table class="sim-hot"><thead><tr><th>#</th><th>${esc(t("von Mises stress"))}</th><th>X, Y, Z, ${esc(units.current)}</th></tr></thead><tbody>`
        + hs.map((h, i) => `<tr data-a="hot" data-hot="${i}" tabindex="0" class="${h.singular ? "sing" : ""}${i === this.hotSel ? " sel" : ""}"><td>${i + 1}</td><td>${sig(h.vm)} MPa${h.singular ? ` ${warn}` : ""}</td><td>${h.at.map(x => String(Number((x * uf).toFixed(3)))).join(", ")}</td></tr>`).join("") + `</tbody></table>`;
      if (singular) html += `<p class="sim-note sim-sing">⚠ ${esc(t("Stress singularity: value depends on refinement"))}. ${esc(real ? t("The safety factor uses the highest stress away from singularities.") : "")}</p>`;
    }
    if (!this.running) {
      html += `<p class="sim-note muted">${esc(last.converged ? t("Converged: the last pass changed the strain energy by {n} %.", { n: sig(last.change ?? 0) })
        : last.change != null ? t("Not converged to {tol} % yet (last change {n} %). Stress near sharp corners keeps rising with accuracy.", { tol: sig(this.study()?.settings.energyTol ?? 2), n: sig(last.change) })
        : t("One pass only: no convergence check."))}</p>`;
      html += `<p class="sim-note muted sim-assume">${esc(t(ASSUMPTIONS))}</p>`;
      if (!this.stale()) html += `<button class="btn small" data-a="report">${esc(t("Report…"))}</button>`;
    }
    return html;
  }

  private renderPanel() {
    const pm = $("#sim-pm");
    const e = this.edit;
    pm.hidden = !e;
    if (!e) { pm.innerHTML = ""; return; }
    const d = e.draft;
    const title = t((SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]);
    const group = (legend: string, inner: string) => `<fieldset class="pm-group"><legend>${esc(legend)}</legend>${inner}</fieldset>`;
    const chk = (k: string, on: boolean | undefined, label: string) => `<label class="chk pm-chk"><input type="checkbox" data-k="${k}"${on ? " checked" : ""} />${esc(label)}</label>`;
    const nf = (k: string, label: string, v: number, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-n="${k}" value="${esc(trim(v))}" spellcheck="false" /><span class="muted">${esc(unit)}</span></span></label>`;
    let body = `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-k="name" value="${esc(d.name ?? "")}" spellcheck="false" translate="no" /></label>`;
    if (d.type !== "gravity") {
      const on = (d as StudyLoad).on, n = pickCount(d);
      const ask = on === "edges" ? t("Click edges on the model") : on === "points" ? t("Click corner points on the model") : d.type === "hinge" ? t("Click cylindrical faces on the model") : t("Click faces on the model");
      const sel = d.type === "force" ? `<label class="pm-field"><span>${esc(t("Acts on"))}</span><select data-k="on">${[["", "Faces"], ["edges", "Edges"], ["points", "Points"]].map(([v, l]) => `<option value="${v}"${(on ?? "") === v ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>` : "";
      body += group(on === "edges" ? t("Edges") : on === "points" ? t("Points") : t("Faces"), sel + `<div class="pm-box focus sim-faces" role="status">${n ? esc(this.pickText(d)) : esc(ask)}</div>`
        + (n ? `<button class="btn small" data-k="clear">${esc(t("Clear"))}</button>` : ""));
    }
    if (e.kind === "support") {
      const s = e.draft;
      if (s.type === "hinge") body += group(t("Options"), chk("axialFree", s.axialFree, t("Free to slide along the axis")));
      if (s.type === "dirs") body += group(t("Held directions"), ["X", "Y", "Z"].map((a, i) => chk(`dir${i}`, (s.dirs ?? [true, true, true])[i], a)).join(""));
      if (s.type === "sliding") body += `<p class="pm-help muted">${esc(t("Use it on flat faces, or as a symmetry plane."))}</p>`;
    } else {
      const l = e.draft, c = (l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v);
      if (l.type === "force") {
        body += group(t("Force"), (l.on ? "" : chk("normal", l.normal, t("Along the face normal")))
          + (l.normal && !l.on ? nf("value", t("Force"), l.value?.v ?? 0, "N") + chk("flip", l.flip, t("Reverse (pull)"))
            : nf("c0", "X", c[0], "N") + nf("c1", "Y", c[1], "N") + nf("c2", "Z", c[2], "N"))
          + `<p class="pm-help muted">${esc(l.on === "edges" ? t("The total, spread over the length of the picked edges.") : l.on === "points" ? t("The total, shared equally by the picked points.") : t("The total over the picked faces."))}</p>`);
      } else if (l.type === "pressure") body += group(t("Pressure"), nf("value", t("Pressure"), l.value?.v ?? 0, "MPa") + chk("flip", l.flip, t("Reverse (pull)")));
      else if (l.type === "moment") body += group(t("Moment"), nf("m0", "X", c[0] / 1000, "N·m") + nf("m1", "Y", c[1] / 1000, "N·m") + nf("m2", "Z", c[2] / 1000, "N·m") + `<p class="pm-help muted">${esc(t("About the centre of the picked faces."))}</p>`);
      else body += group(t("Acceleration"), nf("g0", "X", c[0] / 1000, "m/s²") + nf("g1", "Y", c[1] / 1000, "m/s²") + nf("g2", "Z", c[2] / 1000, "m/s²") + `<p class="pm-help muted">${esc(t("Uses the material's density."))}</p>`);
    }
    // keep the caret when the panel is drawn again after a pick
    const act = document.activeElement as HTMLInputElement | null, keep = act && pm.contains(act) ? (act.dataset.n ?? act.dataset.k) : null;
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(title)}</h3><span class="pm-okc"><button class="pm-ok" data-k="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-k="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>${body}`;
    if (keep) pm.querySelector<HTMLElement>(`[data-n="${keep}"], [data-k="${keep}"]`)?.focus();
  }

  private renderLegend() {
    const el = $("#sim-legend");
    const r = this.res?.passes.at(-1);
    const show = !!r && !!this.saved && !!this.host.doc();
    el.hidden = !show;
    if (!show) { el.innerHTML = ""; $("#viewport").classList.remove("sim-probing"); return; }
    const k = this.plot.kind, sf = k === "sf";
    const [unit, f] = this.plotUnit();
    const plots = PLOTS.filter(([id]) => (id !== "sf" || !!this.host.doc()?.material?.sy) && (id !== "err" || r!.pass > 1));
    const top = sf && this.range[1] >= SF_TOP ? `${SF_TOP}+` : sig(this.range[1] * f);
    el.innerHTML = `<div class="ana-head"><select data-k="kind" aria-label="${esc(t("Result"))}">${plots.map(([id, l]) => `<option value="${id}"${id === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select>`
      + `<button class="sim-ib" data-a="close" title="${esc(t("Hide the plot"))}" aria-label="${esc(t("Hide the plot"))}">×</button></div>`
      + `<div class="ana-ramp" style="background:${RAMP_CSS}${sf ? ";transform:scaleX(-1)" : ""}"></div><div class="ana-scale"><span data-v="min">${sig(this.range[0] * f)}</span><span>${esc(unit)}</span><span data-v="max">${top}</span></div>`
      + (sf ? `<p class="ana-note">${esc(t("Yield strength divided by the von Mises stress; below 1 the material yields."))}</p>` : "")
      + (k === "err" ? `<p class="ana-note">${esc(t("Where the last pass still changed the solution: the places that would gain most from more accuracy."))}</p>` : "")
      + `<label class="chk"><input type="checkbox" data-k="deformed"${this.plot.deformed ? " checked" : ""} />${esc(t("Deformed shape"))}</label>`
      + (this.plot.deformed ? `<label class="ana-row"><span>${esc(t("Scale"))}</span><input type="text" inputmode="decimal" data-k="scale" value="${this.plot.scale > 0 ? trim(this.plot.scale) : ""}" placeholder="${esc(t("auto"))} ×${sig(this.usedScale)}" aria-label="${esc(t("Deformation scale"))}" /></label>` : "")
      + `<label class="chk"><input type="checkbox" data-k="marks"${this.plot.marks ? " checked" : ""} />${esc(t("Highest and lowest values"))}</label>`
      + `<div class="sim-probebar"><button class="btn small${this.probing ? " on" : ""}" data-a="probe" aria-pressed="${this.probing}" title="${esc(t("Click the plot to read the value at a point"))}">${esc(t("Probe"))}</button>`
      + (this.probes.length ? `<button class="btn small" data-a="noprobes">${esc(t("Clear probes"))}</button>` : "") + `</div>`;
    $("#viewport").classList.toggle("sim-probing", this.probing);
  }

  // ---------- events ----------

  private treeClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!b) return;
    const a = b.dataset.a!, id = b.closest<HTMLElement>("[data-id]")?.dataset.id;
    const st = this.study();
    if (a === "new") this.command("new");
    else if (a === "mat") void this.pickMat();
    else if (a === "solve") void this.solve();
    else if (a === "report") void this.report();
    else if (a === "hot") {
      const i = Number(b.dataset.hot);
      this.hotSel = this.hotSel === i ? -1 : i;
      if (this.plot.kind !== "vm" || !this.plot.on) { this.plot.kind = "vm"; this.plot.on = true; this.showPlot(); }
      else this.drawProbes();
      this.renderAll();
    }
    else if (a === "stop") this.client.cancel();
    else if (a === "edit" && id) this.editItem(id);
    else if (a === "del" && id && st) {
      if (this.edit?.draft.id === id) this.edit = null;
      this.host.change(t("Delete {name}", { name: this.nameOf(id) }), d => {
        const s = d.studies?.find(x => x.id === st.id);
        if (!s) return;
        s.supports = s.supports.filter(x => x.id !== id);
        s.loads = s.loads.filter(x => x.id !== id);
        if (s.suppressed) s.suppressed = s.suppressed.filter(x => x !== id);
      });
    } else if (a === "toggle" && id && st) {
      this.host.change(t("Suppress"), d => {
        const s = d.studies?.find(x => x.id === st.id);
        if (!s) return;
        const set = new Set(s.suppressed ?? []);
        if (set.has(id)) set.delete(id); else set.add(id);
        if (set.size) s.suppressed = [...set]; else delete s.suppressed;
      });
    } else if (a === "delstudy" && st) {
      this.client.cancel();
      this.edit = null; this.res = null; this.error = null; this.probes = []; this.probing = false;
      this.clearPlot();
      this.host.change(t("Delete study"), d => { d.studies = (d.studies ?? []).filter(x => x.id !== st.id); if (!d.studies.length) delete d.studies; });
      this.activeId = null;
    }
  }

  private treeChange(el: HTMLInputElement) {
    const st = this.study();
    if (!st) return;
    if (el.dataset.k === "study") { this.activeId = el.value; this.edit = null; this.changed(); }
    else if (el.dataset.k === "passes") this.host.change(t("Passes"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.passes = Number(el.value) || 3; });
    else if (el.dataset.k === "tol") {
      const v = Number(el.value);
      if (!(v >= 0 && v <= 20) || el.value.trim() === "") { el.value = sig(st.settings.energyTol); return; }
      this.host.change(t("Stop at energy change"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.energyTol = v; });
    }
  }

  private panelClick(e: Event) {
    const k = (e.target as HTMLElement).closest<HTMLElement>("button[data-k]")?.dataset.k;
    if (k === "ok") this.ok();
    else if (k === "cancel") this.cancel();
    else if (k === "clear" && this.edit) {
      const d = this.edit.draft as StudyLoad;
      d.faces = [];
      if (d.edges) d.edges = [];
      if (d.points) d.points = [];
      this.renderPanel(); this.drawMarks();
    }
  }

  private panelChange(el: HTMLInputElement) {
    const e = this.edit;
    if (!e) return;
    const d = e.draft as unknown as Omit<StudySupport, "type"> & Omit<StudyLoad, "type">, k = el.dataset.k, nk = el.dataset.n;
    if (k === "name") d.name = el.value.trim() || d.name;
    else if (k === "axialFree") d.axialFree = el.checked || undefined;
    else if (k === "normal") d.normal = el.checked;
    else if (k === "on") {
      const l = e.draft as StudyLoad, v = el.value as "" | "edges" | "points";
      l.faces = []; delete l.edges; delete l.points;
      if (v) { l.on = v; l.normal = false; if (v === "edges") l.edges = []; else l.points = []; } else delete l.on;
    }
    else if (k === "flip") d.flip = el.checked || undefined;
    else if (k?.startsWith("dir")) { const a = [...(d.dirs ?? [true, true, true])] as [boolean, boolean, boolean]; a[Number(k[3])] = el.checked; d.dirs = a; }
    else if (nk) {
      const v = num(el.value);
      el.setAttribute("aria-invalid", String(v == null));
      if (v == null) return;
      if (nk === "value") d.value = { v };
      else {
        const f = nk[0] === "c" ? 1 : 1000, c = (d.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => ({ v: x.v })) as NonNullable<StudyLoad["comp"]>;
        c[Number(nk[1])] = { v: v * f };
        d.comp = c;
      }
    } else return;
    this.renderPanel();
    this.drawMarks();
  }

  private legendChange(el: HTMLInputElement) {
    const k = el.dataset.k;
    if (k === "kind") this.plot.kind = el.value as PlotKind;
    else if (k === "deformed") this.plot.deformed = el.checked;
    else if (k === "marks") this.plot.marks = el.checked;
    else if (k === "scale") { const v = num(el.value); this.plot.scale = el.value.trim() && v != null && v > 0 ? v : 0; }
    else return;
    this.showPlot();
    this.renderLegend();
  }

  /** Opens the Simulation tab (menus, tests). */
  open() { selectCmTab("simulation"); this.host.showTab(); }
}
