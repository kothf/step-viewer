// Structural analysis (FRS-structural 14, SA1): the Simulation command tab, the Study side tab (study tree,
// support and load panels with face picking), Solve with progress, and the result plot on the model.
// The study lives in `PartDoc.studies` (undo steps like any edit); results are view-only and go out of
// date when the model, the material or the study changes.
import * as THREE from "three";
import { cmTab, onCmTab, selectCmTab } from "../commandBar";
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { lang, onLangChange, t } from "../i18n";
import { pickMaterial } from "../materialPicker";
import { cacheGet, cacheKey, cachePut } from "../buildCache";
import type { ExprError } from "../model/expr";
import { evalVars } from "../model/params";
import type { FaceRef, Num, PartDoc } from "../model/types";
import { encodeGif, gifDelays } from "../motion/gif";
import { download, pdfWriter } from "../tools/exporters";
import { toRef } from "../tools/materials";
import { UNITS, units } from "../tools/units";
import { chooseModal, toast } from "../ui";
import type { Viewer } from "../viewer/Viewer";
import type { MatRef } from "../tools/materials";
import type { SimModel } from "./model";
import type { EdgeInfo } from "../topology";
import { SIM_STOPPED, SimClient } from "./client";
import { meshArea, plotTarget, refineMesh, type PlotMesh } from "./plotmesh";
import { locate, probeCsv, valueAt, type Located } from "./probes";
import { hotSpots, type HotSpot } from "./hotspots";
import type { SectionManager } from "../viewer/Section";
import { nearExcitation, parseExcitation } from "./excite";
import { pathChart, pathChartSvg, pathCsv, pathLength, pathPoints, pathRows, type PathRow } from "./path";
import { chartSvg, reportHtml, reportPdf, type ReportBlock, type SimReport } from "./report";
import { GLOBAL_PASSES, MAX_PASSES, envelope, positiveAxis, studyProblem, type PassResult, type SimBody } from "./run";
import { shownValue, typedValue } from "./values";
import { DEFAULT_GAP, DEFAULT_MODES, GRAVITY, LOAD_LABEL, MAX_MODES, MAX_REFINE, MODAL_PASSES, ON_TYPES, REFINE_LABEL, SUPPORT_LABEL, caseStudy, itemName, newCase, newStudy, nextId, pickCount, type LoadType, type PlotKind, type Study, type StudyKind, type StudyLoad, type StudyRefine, type StudySupport, type SupportType } from "./types";

/** What a study needs of its document: a part's, or an assembly's (which has no material or bodies of its own). */
export type SimDoc = Pick<PartDoc, "id" | "name"> & Partial<Pick<PartDoc, "studies" | "vars" | "material" | "bodies">>;

export interface SimHost {
  viewer: Viewer;
  /** The section planes of the view: their caps are painted with the results (FR-RES-030). */
  section: SectionManager;
  /** The part or assembly the studies live in. */
  doc(): SimDoc | null;
  change(label: string, fn: (d: SimDoc) => void): void;
  /** What the studies are drawn on: the part, or the assembly's shown components as one. */
  model(): SimModel | null;
  /** Everything of the model the results depend on (`head` before the study's own set-up in the key, `tail` after it). */
  stateKey(): { head: unknown[]; tail: unknown[] };
  /** The model is an assembly: every component is solved as its own body, joined to the others where they touch. */
  asm(): boolean;
  faceNames(): string[];
  faceAt(x: number, y: number): { faceId: number; point: [number, number, number] } | null;
  /** The snapped point under the pointer (part coordinates) and the edge it is on, if any. */
  snapAt(x: number, y: number): { kind: string; point: [number, number, number]; edge?: EdgeInfo } | null;
  /** `regions` of an assembly carry each solid's material and its component's name. */
  simGeo(lin: number, ang: number): Promise<{ geo: SimBody; solids: number; parts?: number; regions?: { key: string; tris: Float64Array; mat?: MatRef | null; name?: string }[] }>;
  /** No part command is open. */
  idle(): boolean;
  /** Draws the part's planes, sketches and marks again. */
  redraw(): void;
  /** Shows the Study side tab. */
  showTab(): void;
}

type Edit = { kind: "support"; draft: StudySupport; isNew: boolean } | { kind: "load"; draft: StudyLoad; isNew: boolean } | { kind: "refine"; draft: StudyRefine; isNew: boolean };
/** `parts` = bodies of the part when there are several (they are analysed bonded). */
/** One load case's results; `job` names its solution in the worker (0 = not held). */
interface CaseResult { id: string; name: string; passes: PassResult[]; job: number }
/** `passes` are the shown ones: the study's, or with load cases the picked case's or the envelope (one made-up pass). */
interface Results { /** An assembly: its solids, by the solver's domain. */ comps?: { key: string; name: string }[]; study: string; key: string; passes: PassResult[]; ids: string[]; ms: number; mesh: PlotMesh; cached?: boolean; parts?: number; cases?: CaseResult[]; job?: number; env?: PassResult[]; /** Bodies with their own materials: each body's material name and yield strength (MPa, 0 = none), by `PassResult.dom`. */ bodyMats?: { name: string; sy: number }[] }
/** A percentage for a narrow table: tiny ones are not written out with an exponent. */
const pct = (v: number) => (Math.abs(v) < 0.01 ? (v === 0 ? "0" : "< 0.01") : sig(v));
const RELIEF_NOTE = "The part is held by nothing: its supports are left out and the loads are balanced by its own inertia, as for a part in free flight or afloat.";
/** The most load cases a study has. */
export const MAX_CASES = 8;
/** What the disk cache keeps of a finished solve (FR-SOL-030). */
interface Kept { comps?: { key: string; name: string }[]; passes: PassResult[]; ids: string[]; ms: number; mesh: PlotMesh; parts?: number; bodyMats?: { name: string; sy: number }[]; cases?: { id: string; name: string; passes: PassResult[] }[] }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SUPPORTS: SupportType[] = ["fixed", "sliding", "hinge", "dirs", "elastic", "disp"];
const LOADS: LoadType[] = ["force", "pressure", "moment", "torque", "bearing", "remote", "hydro", "gravity", "centrifugal"];
const ICON: Record<string, string> = { newmodal: "≈", new: "＋", mat: "◈", fixed: "⏚", sliding: "⇄", hinge: "◎", dirs: "✛", elastic: "≋", disp: "⇥", centrifugal: "⟳", torque: "⟲", bearing: "◒", hydro: "▽", remote: "⌖", refine: "⊞", force: "↓", pressure: "⇊", moment: "↻", gravity: "g", solve: "▶", stop: "■", results: "▦", report: "▤" };
const TIP: Record<string, string> = {
  fixed: "Fixed support: the faces cannot move",
  sliding: "Sliding support: the faces slide in their own plane but cannot move across it",
  hinge: "Hinge: cylindrical faces turn about their axis",
  dirs: "Fixed in directions: the faces are held along X, Y or Z",
  force: "Force on faces, spread over their area",
  pressure: "Pressure on faces",
  moment: "Moment on faces",
  gravity: "Gravity on the whole part",
  elastic: "Elastic support: the faces rest on springs",
  disp: "Enforced displacement: the faces are moved by a given distance",
  centrifugal: "Centrifugal load: the part spins about an axis",
  torque: "Torque on cylindrical faces, about their axis",
  bearing: "Bearing load: a force pressed onto the half of a hole or shaft that faces it",
  hydro: "Hydrostatic pressure: a fluid presses on the faces, more with depth",
  remote: "Remote load: a force and a moment at a point, carried to the faces",
};
const PLOTS: [PlotKind, string][] = [["vm", "von Mises stress"], ["u", "Displacement"], ["ux", "Displacement X"], ["uy", "Displacement Y"], ["uz", "Displacement Z"], ["sf", "Safety factor"], ["err", "Error estimate"]];
/** Safety factors above this are drawn as this (lightly loaded regions would hide the rest of the scale). */
const SF_TOP = 10;
/** What a mode shape can be coloured by. */
const MODE_PLOTS: PlotKind[] = ["u", "ux", "uy", "uz"];
/** One swing of an animated mode shape, ms. */
const MODE_PERIOD = 1600;
/** Section caps are painted on a grid of this many steps each way. */
const CAP_GRID = 160;
const PATH_COLOR = 0x111827;
/** Frames of a recorded mode shape: one swing. */
const GIF_FRAMES = 24;
const SUPPORT_COLOR = 0x2f9e44, LOAD_COLOR = 0xd6336c, REFINE_COLOR = 0x1c7ed6;
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
  /** The study state whose kept results were last asked for, so each is looked up once. */
  private asked = "";
  private cacheHits = 0;
  private docId: string | null = null;
  private marks = new THREE.Group();
  /** An assembly's solids as last sent to the solver (the solver names them by their place in this list). */
  private comps: { key: string; name: string }[] = [];
  private saved: { meshes: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] } | null = null;
  private overlay: THREE.Mesh | null = null;
  // results on section planes: the caps as the section manager last made them, and what was painted
  private caps: { mesh: THREE.Mesh }[] = [];
  private capGeos = new Map<THREE.Mesh, THREE.BufferGeometry>();
  private capBusy = false;
  private capAgain = false;
  private capsQueued = false;
  private capNote = false;
  private capInfo = { painted: 0, points: 0, hit: 0, min: 0, max: 0 };
  /** The results the solver worker still holds the solution of. */
  private solved: Results | null = null;
  private mats: THREE.Material[] = [];
  private range: [number, number] = [0, 0];
  private usedScale = 0;
  /** Probe mode: a click on the plot pins the value there. */
  private probing = false;
  // results along a path (FR-RES-031): picking its two points, and the values along it
  private pathing = false;
  private pathFirst: [number, number, number] | null = null;
  private pathKey = "";
  private pathData: { rows: PathRow[]; source: "solution" | "surface" } | null = null;
  private pathMark: THREE.Group | null = null;
  /** Remote load panel: the next click in the view sets the point. */
  private pickingAt = false;
  /** The study's probes found on the plot mesh: a triangle (three vertices) and the weights of the point in it. */
  private probes: Located[] = [];
  private probeKey = "";
  /** The plotted value per plot-mesh vertex, as drawn. */
  private vals: Float32Array | null = null;
  private probeLayer: HTMLElement | null = null;
  /** The last report saved (for tests). */
  private lastReport: { kind: string; blocks: number; images: number } | null = null;
  /** Modal results: the mode shown (−1 = the first elastic one) and whether its shape swings. */
  private modeSel = -1;
  private animate = true;
  /** Mode animation speed (1 = one swing in `MODE_PERIOD`) and whether the mode table adds the effective masses up; view only. */
  private speed = 1;
  private cumul = false;
  /** The load case shown (index into the results' cases); -1 = the envelope of them all. */
  private caseSel = -1;
  private errorIn = "";
  private recording = false;
  private gifs = 0;
  private lastGif: { bytes: number; frames: number; w: number; h: number } | null = null;
  private anim: { raf: number; base: Float32Array; u: Float32Array; scale: number; t0: number; frames: number } | null = null;

  constructor(private host: SimHost) {
    host.section.capSource = () => (this.overlay && this.plot.deformed && !this.anim ? this.overlay.geometry : null);
    host.section.onCaps = caps => this.capsChanged(caps);
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
      else if (a === "probe") { this.probing = !this.probing; this.pathing = false; this.pathFirst = null; this.drawPath(); this.renderLegend(); }
      else if (a === "path") { this.pathing = !this.pathing; this.pathFirst = null; this.probing = false; this.drawPath(); this.renderLegend(); }
      else if (a === "noprobes") this.setProbes(t("Clear probes"), () => []);
      else if (a === "probecsv") this.exportProbes();
    else if (a === "gif") void this.recordGif().then(b => { if (b) toast(t("GIF saved"), "success"); });
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
  private keyOf(_doc: SimDoc, st: Study) {
    const model = this.host.stateKey();
    const parts: unknown[] = [...model.head, st.supports, st.loads, st.settings, st.suppressed ?? null];
    if (st.refine?.length) parts.push(st.refine);
    parts.push(...model.tail);
    if (st.links?.length) parts.push(st.links);
    if (st.kind === "modal") parts.push("modal");
    else if (st.cases?.length) parts.push(st.cases.map(c => [c.id, c.off]));
    return JSON.stringify(parts);
  }

  private stale(): boolean {
    const doc = this.host.doc(), st = this.study();
    return !!this.res && (!doc || !st || st.id !== this.res.study || this.keyOf(doc, st) !== this.res.key);
  }

  /** With load cases: is the envelope shown, not one case? */
  private get enveloped() { const c = this.res?.cases; return !!c && c.length > 1 && this.caseSel < 0; }

  /** Points the results at the picked load case, or at the envelope of them all. */
  private applyCase() {
    const r = this.res, cs = r?.cases;
    if (!r || !cs?.length) return;
    if (this.caseSel >= cs.length) this.caseSel = -1;
    if (cs.length > 1 && this.caseSel < 0) r.passes = (r.env ??= [envelope(cs.map(c => c.passes.at(-1)!))]);
    else r.passes = cs[Math.max(0, this.caseSel)].passes;
  }

  /** A case's name as the study has it now (a rename does not make the results out of date). */
  private caseName(c: CaseResult) { return this.study()?.cases?.find(x => x.id === c.id)?.name ?? c.name; }

  private pickCase(i: number) {
    const r = this.res;
    if (!r?.cases || this.running) return;
    this.caseSel = i;
    this.applyCase();
    this.hot = null; this.hotSel = -1; this.probeKey = "";
    if (this.plot.on) this.showPlot();
    this.syncProbes();
    this.syncPath();
    this.capsSoon();
    this.renderAll();
  }

  /** The worker's solution behind the shown results; 0 when it holds none (the envelope has none). */
  private job(): number {
    const r = this.res;
    if (!r || this.solved !== r || this.running || this.enveloped) return 0;
    const j = r.cases ? r.cases[Math.max(0, this.caseSel)]?.job ?? 0 : r.job ?? 0;
    return j && this.client.holds(j) ? j : 0;
  }

  get active() { return !!this.edit || ((this.probing || this.pathing) && !!this.saved); }

  /** The mode shown of modal results: the picked one, else the first that is not a rigid-body motion. */
  private modeIndex(r: PassResult | undefined): number {
    const m = r?.modes;
    if (!m?.length) return -1;
    if (this.modeSel >= 0 && this.modeSel < m.length) return this.modeSel;
    return Math.max(0, m.findIndex(x => !x.rigid));
  }

  /** For tests and the debug handle. */
  state() {
    const last = this.res?.passes.at(-1);
    return {
      refine: (this.study()?.refine ?? []).map(r => [r.faces.length, r.level]), study: this.study()?.id ?? null, editing: this.edit ? this.edit.draft.id : null, running: this.running, error: this.error, stale: this.stale(),
      passes: this.res?.passes.map(p => ({ p: p.p, raised: p.raised ?? null, cells: p.cells, dofs: p.dofs, energy: p.energy, change: p.change, ms: p.ms })) ?? [], errors: last?.errors ?? [],
      maxU: last?.maxU ?? null, maxVm: last?.maxVm ?? null, done: !!last?.done && !this.running,
      reactions: last?.reactions ?? [], applied: last?.applied ?? null,
      plot: { ...this.plot, shown: !!this.saved, range: this.range, scale: this.usedScale, points: (this.res?.mesh.pos.length ?? 0) / 3 }, marks: this.marks.children.length,
      probing: this.probing, probes: this.probes.map(p => this.probeValue(p)), probeAt: this.study()?.probes ?? [], probeCsv: this.probeTable(), report: this.lastReport, cached: !!this.res?.cached, cacheHits: this.cacheHits,
      kind: this.study()?.kind ?? null, modes: last?.modes?.map(m => ({ hz: m.hz, rigid: m.rigid, eff: m.eff })) ?? [], mode: this.modeIndex(last), mass: last?.mass ?? null,
      animating: !!this.anim, frames: this.anim?.frames ?? 0, gifs: this.gifs, gif: this.lastGif, near: this.nearModes(this.res?.passes.at(-1)), bodies: this.res?.parts ?? 1, bodyMats: this.res?.bodyMats?.map(b => b.name) ?? null, speed: this.speed, cumul: this.cumul, more: !!this.res?.passes.at(-1)?.more, range: this.study()?.settings.range ?? null,
      caps: { n: this.caps.length, ...this.capInfo },
      asm: this.host.asm(), comps: this.res?.comps?.map(c => c.name) ?? null, contacts: (last?.contacts ?? []).map(c => ({ a: this.res?.comps?.[c.a]?.name ?? "", b: this.res?.comps?.[c.b]?.name ?? "", area: c.area, type: c.type })), links: this.study()?.links ?? [],
      relief: !!this.study()?.settings.relief, accel: last?.accel ? { a: last.accel.a, alpha: last.accel.alpha } : null,
      cases: (this.study()?.cases ?? []).map(c => ({ name: c.name, off: c.off })), caseSel: this.caseSel, enveloped: this.enveloped,
      caseResults: (this.res?.cases ?? []).map(c => ({ name: this.caseName(c), maxVm: c.passes.at(-1)?.maxVm ?? null, maxU: c.passes.at(-1)?.maxU ?? null, passes: c.passes.length })),
      path: (() => { const pv = this.pathValues(); let lo = Infinity, hi = -Infinity, inside = 0; if (pv) for (let i = 0; i < pv.v.length; i++) if (pv.ok[i]) { inside++; lo = Math.min(lo, pv.v[i]); hi = Math.max(hi, pv.v[i]); }
        return { at: this.study()?.path ?? null, picking: this.pathing, first: !!this.pathFirst, points: pv?.v.length ?? 0, inside, min: inside ? lo : null, max: inside ? hi : null, source: this.pathData?.source ?? null, csv: this.pathData ? pathCsv(this.pathData.rows) : null, drawn: this.pathMark?.userData.simPath ?? 0 }; })(),
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
      this.edit = null; this.res = null; this.error = null; this.problems.clear(); this.activeId = null; this.running = false; this.probes = []; this.probeKey = ""; this.probing = false; this.asked = "";
    }
    $("#t-sim").hidden = !doc;
    if (this.edit && !this.study()) this.edit = null;
    if (this.stale() && this.saved) this.clearPlot();
    if (this.saved) { this.syncProbes(); this.drawProbes(); }
    this.syncPath();
    this.renderAll();
    this.drawMarks();
    void this.restore();
  }

  /** Results of the last finished solve of this very study state, from the disk cache (FR-SOL-030). */
  private async restore() {
    const doc = this.host.doc(), st = this.study();
    if (!doc || !st || this.res || this.running || this.edit) return;
    const key = this.keyOf(doc, st), tag = `${doc.id}|${st.id}|${key}`;
    if (tag === this.asked) return;
    this.asked = tag;
    const kept = await cacheGet<Kept>(await cacheKey("sim", key));
    const now = this.host.doc(), s2 = this.study();
    if (!kept?.passes?.length || !kept.mesh || this.res || this.running || now !== doc && now?.id !== doc.id || !s2 || s2.id !== st.id || !now || this.keyOf(now, s2) !== key) return;
    this.res = { study: st.id, key, passes: kept.passes, ids: kept.ids, ms: kept.ms, mesh: kept.mesh, cached: true, ...(kept.parts ? { parts: kept.parts } : {}), ...(kept.comps ? { comps: kept.comps } : {}), ...(kept.bodyMats ? { bodyMats: kept.bodyMats } : {}),
      ...(kept.cases?.length ? { cases: kept.cases.map(c => ({ ...c, job: 0 })) } : {}) };
    this.caseSel = -1;
    this.applyCase();
    this.cacheHits++;
    this.plot.on = false;
    this.syncProbes();
    this.syncPath();
    this.renderAll();
  }

  /** The model was built and shown again: the mesh is new. */
  rebuilt() {
    if (this.saved && this.saved.meshes[0]?.mesh === this.host.model()?.meshes[0]) this.clearPlot();
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
    if (c === "newmodal") { this.newStudy("modal"); return; }
    if (c === "mat") { void this.pickMat(); return; }
    if (c === "solve") { void this.solve(); return; }
    if (c === "stop") { this.client.cancel(); return; }
    if (c === "report") { void this.report(); return; }
    if (c === "results") { this.plot.on = !this.plot.on; this.showPlot(); this.renderAll(); this.drawMarks(); return; }
    if (!this.study()) this.newStudy();
    const st = this.study();
    if (!st) return;
    if (c === "refine") {
      if (st.kind === "modal") { toast(t("Local accuracy is for static studies.")); return; }
      this.edit = { kind: "refine", isNew: true, draft: { id: nextId(st, "r"), name: itemName(st, "refine"), type: "refine", faces: [], level: 1 } };
      this.renderAll();
      this.drawMarks();
      return;
    }
    if ((SUPPORTS as string[]).includes(c)) {
      const type = c as SupportType;
      this.edit = { kind: "support", isNew: true, draft: { id: nextId(st, "s"), name: itemName(st, type), type, faces: [], ...(type === "dirs" ? { dirs: [true, true, true] as [boolean, boolean, boolean] } : {}),
        ...(type === "disp" ? { dirs: [true, true, true] as [boolean, boolean, boolean], disp: [0, 0, 0] as [number, number, number] } : {}), ...(type === "elastic" ? { kn: 100, kt: 100 } : {}) } };
    } else if ((LOADS as string[]).includes(c)) {
      if (st.kind === "modal") { toast(t("A modal study has no loads: it finds how the part vibrates on its own.")); return; }
      const type = c as LoadType;
      const d: StudyLoad = { id: nextId(st, "l"), name: itemName(st, type), type, faces: [] };
      if (type === "force") { d.normal = true; d.value = { v: 100 }; d.comp = [{ v: 0 }, { v: 0 }, { v: -100 }]; }
      else if (type === "pressure") d.value = { v: 1 };
      else if (type === "moment") d.comp = [{ v: 0 }, { v: 0 }, { v: 1000 }];
      else if (type === "centrifugal") { d.value = { v: 3000 }; d.axis = "z"; }
      else if (type === "torque") d.value = { v: 10000 };
      else if (type === "bearing") d.comp = [{ v: 0 }, { v: 0 }, { v: -1000 }];
      else if (type === "hydro") { d.value = { v: 1000 }; d.axis = "z"; d.level = 0; }
      else if (type === "remote") { d.comp = [{ v: 0 }, { v: 0 }, { v: -100 }]; d.mom = [{ v: 0 }, { v: 0 }, { v: 0 }]; d.at = [0, 0, 0]; }
      else d.comp = [{ v: 0 }, { v: 0 }, { v: -GRAVITY }];
      this.edit = { kind: "load", isNew: true, draft: d };
    } else return;
    this.renderAll();
    this.drawMarks();
  }

  private newStudy(kind: StudyKind = "static") {
    const doc = this.host.doc();
    if (!doc) return;
    const st = newStudy(doc.studies ?? [], kind);
    this.activeId = st.id;
    this.edit = null;
    this.host.change(kind === "modal" ? t("New modal study") : t("New study"), d => { (d.studies ??= []).push(st); });
    this.changed();
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
    else { const r = st.refine?.find(x => x.id === id); if (r) this.edit = { kind: "refine", isNew: false, draft: structuredClone(r) }; }
    this.renderAll();
    this.drawMarks();
  }

  private ok() {
    const e = this.edit, st = this.study();
    if (!e || !st) return;
    const d = e.draft;
    if (d.type !== "gravity" && d.type !== "centrifugal" && !pickCount(d)) {
      const on = (d as StudyLoad).on;
      toast(on === "edges" ? t("Click the edges on the model first.") : on === "points" ? t("Click the corner points on the model first.") : t("Click the faces on the model first."), "warn");
      return;
    }
    const sid = st.id;
    const label = e.isNew ? t(e.kind === "refine" ? REFINE_LABEL : (SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]) : t("Edit {name}", { name: d.name ?? "" });
    this.edit = null;
    this.pickingAt = false;
    this.problems.delete(d.id);
    this.host.change(label, doc => {
      const s = doc.studies?.find(x => x.id === sid);
      if (!s) return;
      const list = (e.kind === "support" ? s.supports : e.kind === "load" ? s.loads : (s.refine ??= [])) as (StudySupport | StudyLoad | StudyRefine)[];
      const i = list.findIndex(x => x.id === d.id);
      if (i >= 0) list[i] = d; else list.push(d);
    });
    this.renderAll();
    this.drawMarks();
  }

  private cancel() {
    this.edit = null;
    this.pickingAt = false;
    this.renderAll();
    this.drawMarks();
  }

  /** A click in the view while a panel is open: the face under it joins or leaves the item. */
  click(e: PointerEvent): boolean {
    const ed = this.edit;
    if (!ed && this.pathing && this.saved) { this.pathClick(e.clientX, e.clientY); return true; }
    if (!ed && this.probing && this.saved) { this.probeAt(e.clientX, e.clientY); return true; }
    if (!ed) return false;
    if (ed.draft.type === "gravity") return true;
    if (ed.draft.type === "remote" && this.pickingAt) {
      // the point the load acts at: a snapped point of the model, else the place on the face under the pointer
      const s = this.host.snapAt(e.clientX, e.clientY), q = s?.point ?? this.host.faceAt(e.clientX, e.clientY)?.point;
      if (!q) { toast(t("Click a point on the model."), "warn"); return true; }
      (ed.draft as StudyLoad).at = [q[0], q[1], q[2]].map(v => Math.round(v * 1e4) / 1e4) as [number, number, number];
      this.pickingAt = false;
      this.renderPanel();
      this.drawMarks();
      return true;
    }
    if (ed.kind !== "refine" && ed.draft.on) { this.pickEdgeOrPoint(ed.draft, e); return true; }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const name = hit ? this.host.faceNames()[hit.faceId] : undefined;
    if (!hit || !name) return true;
    const d = ed.draft;
    const i = d.faces.findIndex(f => f.name === name);
    if (i >= 0) d.faces.splice(i, 1);
    else {
      if (d.type === "hinge" && this.host.model()?.faces[hit.faceId]?.type !== "cylinder") { toast(t("A hinge needs a cylindrical face."), "warn"); return true; }
      if (d.type === "centrifugal" && this.host.model()?.faces[hit.faceId]?.type !== "cylinder") { toast(t("Click a cylindrical face: its axis is the spin axis."), "warn"); return true; }
      if ((d.type === "torque" || d.type === "bearing") && this.host.model()?.faces[hit.faceId]?.type !== "cylinder") { toast(t("Click a cylindrical face."), "warn"); return true; }
      d.faces.push({ name, hint: hit.point });
    }
    this.renderPanel();
    this.drawMarks();
    return true;
  }

  /** A force or a support on edges or points: the edge or corner under the pointer joins or leaves it. */
  private pickEdgeOrPoint(d: StudySupport | StudyLoad, e: PointerEvent) {
    const s = this.host.snapAt(e.clientX, e.clientY), names = this.host.faceNames(), part = this.host.model();
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
      for (const ed of part.edges) if (near(ed.start) || near(ed.end)) for (const f of ed.faces) if (names[f]) fs.add(names[f]);
      if (fs.size < 2) { toast(t("Click a corner point of the model."), "warn"); return; }
      const list = (d.points ??= []);
      const i = list.findIndex(x => near(x.at));
      if (i >= 0) list.splice(i, 1); else list.push({ faces: [...fs].sort(), at: s.point });
    }
    this.renderPanel();
    this.drawMarks();
  }

  /** "3 faces", "2 edges", "1 point". */
  private pickText(it: StudySupport | StudyLoad | StudyRefine): string {
    const on = (it as StudyLoad).on, n = pickCount(it);
    return on === "edges" ? t("{n} edge|{n} edges", { n }) : on === "points" ? t("{n} point|{n} points", { n }) : t("{n} face|{n} faces", { n });
  }

  key(e: KeyboardEvent): boolean {
    if (!this.edit && this.pathing && this.saved && e.key === "Escape") { this.pathing = false; this.pathFirst = null; this.drawPath(); this.renderLegend(); return true; }
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
    const m = doc.material, asm = this.host.asm();
    if (!asm && (!m || !m.E || m.nu == null)) {
      toast(t("Pick a material with an elastic modulus and Poisson's ratio first."), "warn");
      void this.pickMat();
      return;
    }
    const part = this.host.model();
    if (!part) { toast(asm ? t("The assembly has no components to analyse yet.") : t("The part has no body yet."), "warn"); return; }
    this.running = true; this.error = null; this.errorIn = ""; this.res = null; this.problems.clear(); this.probes = []; this.probeKey = ""; this.hot = null; this.hotSel = -1; this.modeSel = -1;
    const modal = st.kind === "modal";
    // a mode is a shape: it is drawn deformed, whatever the last static plot was set to
    if (modal) this.plot.deformed = true;
    this.clearPlot();
    this.progress = t("Reading the geometry…");
    this.renderAll();
    const key = this.keyOf(doc, st), t0 = performance.now();
    let whole = true, made: Results | null = null;
    try {
      const size = this.host.viewer.modelSize;
      const { geo, solids, parts, regions: bodies } = await this.host.simGeo(Math.max(0.002, size * 2e-5), 0.05);
      if (!asm && solids !== 1) throw new Error("E-SIM-BODIES");
      // bodies with a material of their own keep it: each body is then solved with its own stiffness and density
      const simMat = (q: NonNullable<typeof doc.material>) => ({ name: q.name, E: (q.E ?? 0) * 1000, nu: q.nu ?? 0, rho: q.density * 1e-9, sy: q.sy ?? undefined, su: q.su ?? undefined });
      let regions: { tris: Float64Array; mat: ReturnType<typeof simMat> }[] | undefined;
      // an assembly: every component is its own body with its part's material, joined to the others where they touch
      let joined: { gap: number; links: { a: number; b: number; type: "sliding" | "none" }[] } | undefined;
      if (asm) {
        if (!bodies?.length) throw new Error("E-SIM-NOBODY");
        regions = bodies.map(b => {
          if (!b.mat || !b.mat.E || b.mat.nu == null) throw new Error(`E-SIM-COMPMAT: ${b.name ?? b.key}`);
          return { tris: b.tris, mat: simMat(b.mat) };
        });
        this.comps = bodies.map(b => ({ key: b.key, name: b.name ?? b.key }));
        const at = new Map(bodies.map((b, i) => [b.key, i]));
        joined = { gap: st.settings.gap ?? DEFAULT_GAP, links: (st.links ?? []).flatMap(l => (at.has(l.a) && at.has(l.b) ? [{ a: at.get(l.a)!, b: at.get(l.b)!, type: l.type }] : [])) };
      } else if (m && bodies && bodies.length > 1 && bodies.some(b => doc.bodies?.[b.key]?.material)) {
        regions = bodies.map(b => {
          const q = doc.bodies?.[b.key]?.material ?? m;
          if (!q.E || q.nu == null) throw new Error(`E-SIM-BODYMAT: ${q.name}`);
          return { tris: b.tris, mat: simMat(q) };
        });
        if (regions.every(r => r.mat.name === regions![0].mat.name && r.mat.E === regions![0].mat.E)) regions = undefined;
      }
      // with load cases each one is solved on its own: the same supports, its own loads
      const cases = modal ? [] : st.cases ?? [];
      const runs = (cases.length ? cases : [null]).map(c => ({ c, problem: studyProblem(c ? caseStudy(st, c) : st, geo) }));
      for (const r of runs) if (r.problem.problems.length) {
        for (const p of r.problem.problems) this.problems.set(p.id, p.code);
        throw new Error(`${r.problem.problems[0].code}: ${r.problem.problems[0].id}`);
      }
      const problem = runs[0].problem;
      const g = part.geometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), n = pa.count;
      const p0 = new Float32Array(3 * n), n0 = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        p0[3 * i] = pa.getX(i); p0[3 * i + 1] = pa.getY(i); p0[3 * i + 2] = pa.getZ(i);
        if (na) { n0[3 * i] = na.getX(i); n0[3 * i + 1] = na.getY(i); n0[3 * i + 2] = na.getZ(i); }
      }
      // the results are drawn on a finer copy of the display mesh (a flat face has only two triangles)
      const idx = g.getIndex()?.array ?? null;
      const mesh = refineMesh(p0, n0, idx, plotTarget(meshArea(p0, idx), size / 70));
      const pos = mesh.pos, nrm = mesh.nrm;
      const total = Math.max(1, Math.min(modal ? MODAL_PASSES : MAX_PASSES, Math.round(st.settings.passes)));
      if (modal) problem.loads = [];
      const res: Results = { study: st.id, key, passes: [], ids: problem.supportIds, ms: 0, mesh, ...(parts && parts > 1 ? { parts } : {}), ...(asm ? { comps: this.comps } : {}), ...(cases.length ? { cases: [] } : {}), ...(regions ? { bodyMats: regions.map(r => ({ name: r.mat.name, sy: r.mat.sy ?? 0 })) } : {}) };
      made = res; whole = false;
      for (let ci = 0; ci < runs.length; ci++) {
      const run = runs[ci], problem = run.problem, pre = run.c ? `${run.c.name}: ` : "";
      const mine: PassResult[] = run.c ? [] : res.passes;
      if (run.c) { res.cases!.push({ id: run.c.id, name: run.c.name, passes: mine, job: 0 }); res.passes = mine; this.caseSel = ci; this.errorIn = run.c.name; this.hot = null; }
      this.progress = pre + t("Pass {n} of {m}…", { n: 1, m: total });
      this.renderAll();
      await this.client.solve({
        body: geo, problem, passes: total, energyTol: st.settings.energyTol, pos, nrm,
        ...(modal ? { modal: st.settings.range
          ? { count: DEFAULT_MODES, max: MAX_MODES, range: [st.settings.range.from, st.settings.range.to] as [number, number] }
          : { count: Math.max(1, Math.min(MAX_MODES, Math.round(st.settings.modes ?? DEFAULT_MODES))) } } : {}),
        mat: m && !asm ? simMat(m) : regions![0].mat, ...(regions ? { regions } : {}), ...(joined ? { asm: joined } : {}),
      }, p => {
        mine.push(p);
        res.ms = performance.now() - t0;
        this.res = res;
        this.plot.on = true;
        if (!p.done) this.progress = pre + t("Pass {n} of {m}…", { n: p.pass + 1, m: total });
        this.showPlot();
        this.renderAll();
        this.drawMarks();
      }, ci > 0);
      if (!mine.length) throw new Error(SIM_STOPPED);
      if (run.c) res.cases![ci].job = this.client.solution; else res.job = this.client.solution;
      }
      whole = true; this.errorIn = "";
      if (res.cases) { this.caseSel = res.cases.length > 1 ? -1 : 0; this.hot = null; }
      // the worker keeps the last solution: the section planes can show it
      if (res.passes.length && (this.res as Results | null) === res) {
        this.solved = res; this.running = false;
        if (res.cases) { this.applyCase(); this.showPlot(); }
        this.capsSoon(); this.syncPath();
      }
      // a finished solve is kept for the next time this document is opened
      if (res.passes.length) {
        const keep: Kept = { passes: res.cases ? res.cases.at(-1)!.passes : res.passes, ids: res.ids, ms: res.ms, mesh: res.mesh, parts: res.parts, ...(res.comps ? { comps: res.comps } : {}), ...(res.bodyMats ? { bodyMats: res.bodyMats } : {}), ...(res.cases ? { cases: res.cases.map(c => ({ id: c.id, name: c.name, passes: c.passes })) } : {}) };
        void cacheKey("sim", key).then(k => cachePut(k, keep));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== SIM_STOPPED) { this.error = msg; toast((this.errorIn ? `${this.errorIn}: ` : "") + this.errorText(msg), "error"); }
      // load cases are shown together or not at all
      if (!whole && made?.cases && this.res === made) { this.res = null; this.clearPlot(); }
    } finally {
      this.running = false;
      this.renderAll();
      this.drawMarks();
    }
  }

  /** An assembly study: how its components are joined, and after a solve the pairs found touching. */
  private linksHtml(st: Study): string {
    const res = this.res && !this.stale() ? this.res : null, comps = res?.comps ?? [], found = res?.passes.at(-1)?.contacts ?? [];
    const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const typed = new Map((st.links ?? []).map(l => [key(l.a, l.b), l.type]));
    const names = new Map(comps.map(c => [c.key, c.name]));
    const rows: { a: string; b: string; area: number | null }[] = found.map(c => ({ a: comps[c.a]?.key ?? "", b: comps[c.b]?.key ?? "", area: c.area })).filter(r => r.a && r.b);
    const seen = new Set(rows.map(r => key(r.a, r.b)));
    for (const l of st.links ?? []) if (!seen.has(key(l.a, l.b))) rows.push({ a: l.a, b: l.b, area: null });
    const f = UNITS[units.current].f;
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(t(label))}</option>`;
    let html = `<div class="sim-sec sim-links"><h4>${esc(t("Connections"))}</h4>`
      + `<p class="sim-note muted">${esc(t("Every component is analysed with its part's material. Components that touch, or come within the gap, are joined."))}</p>`
      + `<label class="sim-kv2">${esc(t("Gap tolerance"))} <input type="number" data-k="gap" min="0" step="0.05" value="${sig((st.settings.gap ?? DEFAULT_GAP) * f)}" aria-label="${esc(t("Gap tolerance"))}" /> ${esc(units.current)}</label>`;
    if (rows.length) {
      html += `<table class="sim-contacts"><thead><tr><th>${esc(t("Components"))}</th><th>${esc(t("Area"))}, ${esc(units.current)}²</th><th>${esc(t("Type"))}</th></tr></thead><tbody>`
        + rows.map(r => {
          const cur = typed.get(key(r.a, r.b)) ?? "bonded";
          return `<tr data-link="${esc(key(r.a, r.b))}"><td translate="no">${esc(names.get(r.a) ?? r.a)} – ${esc(names.get(r.b) ?? r.b)}</td><td>${r.area == null ? "" : sig(r.area * f * f)}</td>`
            + `<td><select data-k="link" data-a="${esc(r.a)}" data-b="${esc(r.b)}" aria-label="${esc(t("Type"))}">${opt("bonded", "Bonded", cur)}${opt("sliding", "Sliding", cur)}${opt("none", "Not joined", cur)}</select></td></tr>`;
        }).join("") + `</tbody></table>`;
    } else html += `<p class="sim-note muted" data-v="nolinks">${esc(res ? t("No components touch.") : t("The pairs found touching are listed here after a solve."))}</p>`;
    return html + `</div>`;
  }

  private nameOf(id: string) {
    const st = this.study();
    return [...(st?.supports ?? []), ...(st?.loads ?? []), ...(st?.refine ?? [])].find(x => x.id === id)?.name ?? id;
  }

  private errorText(msg: string): string {
    const [code, rest = ""] = msg.split(": ");
    const name = this.nameOf(rest.trim());
    switch (code) {
      case "E-SIM-NOLOAD": return t("Add a load first.");
      case "E-SIM-FREE": return rest.trim() === "6" && !this.study()?.supports.length ? t("Add a support first, or turn on Inertia relief for a part that nothing holds.") : t("The supports leave the part free to move ({n} free motions). Add or change the supports.", { n: rest.trim() });
      case "E-SIM-BODIES": return t("Some bodies of the part touch no other body. A study needs one connected piece: join the bodies or delete the loose ones.");
      case "E-SIM-COMPMAT": return t("The component {name} has no material with an elastic modulus and Poisson's ratio. Give its part one (right-click the component, Material…).", { name: msg.split(": ")[1] ?? "" });
      case "E-SIM-LOOSE": return t("Nothing holds {names}: they touch no held component and have no support. Add a support, move them into contact or raise the gap tolerance.", { names: rest.split(",").map(i => this.comps[Number(i)]?.name ?? i).join(", ") });
      case "E-SIM-BODYMAT": return t("The material {name} of a body has no elastic modulus or Poisson's ratio.", { name: msg.split(": ")[1] ?? "" });
      case "E-SIM-DENSITY": return t("The material has no density: a modal study needs one.");
      case "E-SIM-NOBODY": return this.host.asm() ? t("The assembly has no components to analyse yet.") : t("The part has no body yet.");
      case "E-SIM-REF": return t("{name}: a face is gone. Pick its faces again.", { name });
      case "E-SIM-EMPTY": return t("{name} has no faces.", { name });
      case "E-SIM-SPRING": return t("{name}: give a stiffness above 0.", { name });
      case "E-SIM-AXIS": return t("{name}: the picked faces have no one axis. Pick cylindrical faces on one axis.", { name });
      case "E-SIM-BEARING": return t("{name}: the force lies along the faces' axis. A bearing load presses across it.", { name });
      case "E-SIM-ONESPIN": return t("{name}: a study takes one centrifugal load.", { name });
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
  private faceGeo(part: SimModel, ids: number[]) {
    const g = part.geometry, pos = g.getAttribute("position"), idx = g.getIndex();
    const out: number[] = [], c = new THREE.Vector3(), nrm = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), w = new THREE.Vector3();
    let area = 0;
    for (const i of ids) {
      const fc = part.faces[i];
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
    const part = this.host.model(), st = this.study();
    this.marks.removeFromParent();
    if (!part || !st || cmTab() !== "simulation") { this.host.viewer.invalidate(); return; }
    part.frame.add(this.marks);
    const plotted = !!this.saved;
    const off = new Set(st.suppressed ?? []);
    const draw = (it: StudySupport | StudyLoad | StudyRefine, load: boolean, hot: boolean) => {
      const color = it.type === "refine" ? REFINE_COLOR : load ? LOAD_COLOR : SUPPORT_COLOR;
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
      const l = it as StudyLoad, len = this.host.viewer.modelSize * 0.14;
      let dir: THREE.Vector3 | null = null, at = g.centre;
      let picked = g.tris.length > 0;
      if (l.on) {
        const names = this.host.faceNames(), pts: number[] = [], sum = new THREE.Vector3();
        let n = 0;
        if (l.on === "edges") for (const e of l.edges ?? []) for (const ed of part.edges) {
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
      if (!load) return;
      const comp = () => new THREE.Vector3(...(l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v) as [number, number, number]);
      if (l.type === "centrifugal") {
        // the spin axis: along the picked cylinders' axis when there are faces (the solver finds the exact line), else the world axis at the origin
        if (!picked) { dir = new THREE.Vector3(l.axis === "x" ? 1 : 0, l.axis === "y" ? 1 : 0, !l.axis || l.axis === "z" ? 1 : 0); at = new THREE.Vector3(); }
        else return;
      }
      else if (l.type === "gravity") { dir = comp(); at = new THREE.Box3().setFromBufferAttribute(part.geometry.getAttribute("position") as THREE.BufferAttribute).getCenter(new THREE.Vector3()); }
      else if (!picked) return;
      else if (l.type === "torque") {
        // along the faces' axis, the way the torque turns right-handed (run.ts `positiveAxis`)
        const ax = part.faces[this.faceIds(l.faces)[0]]?.axis;
        dir = ax ? new THREE.Vector3(...positiveAxis(ax) as [number, number, number]).multiplyScalar(l.flip ? -1 : 1) : null;
      }
      else if (l.type === "hydro") dir = g.normal ? g.normal.clone().multiplyScalar(-1) : null;
      else if (l.type === "remote") {
        // the point, joined to the faces' centre; the arrow ends on the point
        const q = new THREE.Vector3(...(l.at ?? [0, 0, 0]));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([q.x, q.y, q.z, at.x, at.y, at.z], 3));
        const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
        const one = new THREE.BufferGeometry();
        one.setAttribute("position", new THREE.Float32BufferAttribute([q.x, q.y, q.z], 3));
        const dot = new THREE.Points(one, new THREE.PointsMaterial({ color, size: 11, sizeAttenuation: false, depthTest: false, transparent: true }));
        for (const o of [line, dot]) { o.renderOrder = 2940; o.userData.simMark = it.id; o.raycast = () => {}; this.marks.add(o); }
        at = q;
        dir = comp();
        if (dir.lengthSq() === 0) dir = new THREE.Vector3(...(l.mom ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v) as [number, number, number]);
      }
      else if (l.type === "pressure" || (l.type === "force" && l.normal)) dir = g.normal ? g.normal.clone().multiplyScalar(l.flip ? 1 : -1) : null;
      else dir = comp();
      if (!dir || dir.lengthSq() === 0) return;
      dir.normalize();
      // a pushing arrow ends on the face; a moment's arrow starts there, along its axis
      const from = l.type === "moment" || l.type === "torque" || l.type === "gravity" || l.type === "centrifugal" ? at.clone() : at.clone().addScaledVector(dir, -len);
      const arrow = new THREE.ArrowHelper(dir, from, len, l.type === "moment" || l.type === "torque" || l.type === "centrifugal" ? 0x7048e8 : color, len * 0.28, len * 0.12);
      arrow.traverse(o => { const mm = (o as THREE.Mesh).material as THREE.Material | undefined; if (mm) { mm.depthTest = false; mm.transparent = true; } o.renderOrder = 2950; });
      arrow.userData.simArrow = it.id;
      arrow.traverse(o => { o.raycast = () => {}; });
      this.marks.add(arrow);
    };
    const ed = this.edit;
    for (const s of st.supports) if (s.id !== ed?.draft.id && !off.has(s.id) && !plotted) draw(s, false, false);
    for (const l of st.loads) if (l.id !== ed?.draft.id && !off.has(l.id) && !plotted) draw(l, true, false);
    for (const r of st.refine ?? []) if (r.id !== ed?.draft.id && !off.has(r.id) && !plotted) draw(r, false, false);
    if (ed) draw(ed.draft, ed.kind === "load", true);
    this.host.viewer.invalidate();
  }

  /** Yield strength (MPa, 0 = none) of the material at a sample point: its body's when bodies have their own materials. */
  private yieldAt(r: PassResult, i: number): number {
    const B = this.res?.bodyMats;
    return B && r.dom ? B[r.dom[i]]?.sy ?? 0 : this.host.doc()?.material?.sy ?? 0;
  }
  /** A yield strength is known for the results (any body's). */
  private hasYield(): boolean {
    const B = this.res?.bodyMats;
    return B ? B.some(b => b.sy > 0) : !!this.host.doc()?.material?.sy;
  }
  /** Lowest safety factor against yield: the part's yield over `peak`, or body by body with their own materials. */
  private lowSf(r: PassResult, peak: number): number | null {
    const B = this.res?.bodyMats;
    if (B && r.dom) {
      let lo = Infinity;
      for (let i = 0; i < r.vm.length; i++) { const y = B[r.dom[i]]?.sy ?? 0; if (y > 0 && r.vm[i] > 0) lo = Math.min(lo, y / r.vm[i]); }
      return Number.isFinite(lo) ? lo : null;
    }
    const sy = this.host.doc()?.material?.sy;
    return sy && peak > 0 ? sy / peak : null;
  }

  private values(r: PassResult, kind: PlotKind): Float32Array {
    if (kind === "vm") return r.vm;
    if (kind === "err") return r.err;
    if (kind === "sf") {
      const out = new Float32Array(r.vm.length);
      for (let i = 0; i < out.length; i++) { const sy = this.yieldAt(r, i); out[i] = sy > 0 ? Math.min(SF_TOP, sy / Math.max(r.vm[i], 1e-9)) : SF_TOP; }
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
    const at = this.plotPointAt(x, y);
    if (at) this.setProbes(t("Probe"), list => [...list, at]);
  }

  /** The point of the undeformed model under the pointer, on the plot. */
  private plotPointAt(x: number, y: number): [number, number, number] | null {
    const ov = this.overlay, v = this.host.viewer;
    if (!ov) return null;
    const r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2), v.camera);
    const hits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(ov, rc, hits);
    hits.sort((a, b) => a.distance - b.distance);
    const h = hits.find(q => !v.clipPlanes.some(pl => pl.distanceToPoint(q.point) < 0)), f = h?.face;
    if (!h || !f) return null;
    const pa = ov.geometry.getAttribute("position"), P = (i: number) => new THREE.Vector3().fromBufferAttribute(pa, i);
    const w = THREE.Triangle.getBarycoord(ov.worldToLocal(h.point.clone()), P(f.a), P(f.b), P(f.c), new THREE.Vector3());
    if (!w) return null;
    // kept as a point of the undeformed model, so it is read again after every solve
    const p0 = this.res?.mesh.pos;
    if (!p0) return null;
    return [0, 1, 2].map(c => w.x * p0[3 * f.a + c] + w.y * p0[3 * f.b + c] + w.z * p0[3 * f.c + c]) as [number, number, number];
  }

  // ---------- results along a path (FR-RES-031) ----------

  private pathClick(x: number, y: number) {
    const p = this.plotPointAt(x, y);
    if (!p) return;
    if (!this.pathFirst) { this.pathFirst = p; this.drawPath(); this.renderLegend(); return; }
    const a = this.pathFirst;
    if (pathLength(a, p) < 1e-6 * this.host.viewer.modelSize) return;
    this.pathing = false; this.pathFirst = null;
    this.setPath(t("Path"), [a, p]);
  }

  private setPath(label: string, path: [[number, number, number], [number, number, number]] | null) {
    const sid = this.study()?.id;
    if (!sid) return;
    this.host.change(label, d => {
      const s = d.studies?.find(x => x.id === sid);
      if (!s) return;
      if (path) s.path = path; else delete s.path;
    });
    this.syncPath();
    this.renderAll();
  }

  /**
   * Reads the results along the study's path: at once from the plot's surface (right for a path on the surface),
   * then from the solver's kept solution when there is one, which also holds inside the part.
   */
  private syncPath() {
    const st = this.study(), res = this.res, r = res?.passes.at(-1), path = st?.path;
    const usable = !!path && !!res && !!r && !r.modes && !this.stale();
    const sol = usable ? this.job() : 0;
    const key = usable ? `${res!.key}|${r!.pass}|${JSON.stringify(path)}|${sol}|${res!.cases ? this.caseSel : ""}` : "";
    if (key === this.pathKey) { this.drawPath(); return; }
    this.pathKey = key;
    if (!usable || !path || !res || !r) { this.pathData = null; this.drawPath(); return; }
    const pos = pathPoints(path[0], path[1]), n = pos.length / 3, pm = res.mesh, tol = 1e-3 * this.host.viewer.modelSize;
    const vm = new Float32Array(n), u = new Float32Array(3 * n), near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const at = locate(pm.pos, pm.index, [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
      if (!at) continue;
      near[i] = at.d <= tol ? 1 : 0;
      vm[i] = valueAt(r.vm, at);
      for (let c = 0; c < 3; c++) u[3 * i + c] = valueAt(r.u, at, 3, c);
    }
    this.pathData = { rows: pathRows(pos, vm, u, near), source: "surface" };
    this.drawPath();
    if (!sol) return;
    void this.client.sample(Float32Array.from(pos), 0, true, sol).then(s => {
      if (!s || this.pathKey !== key) return;
      const ok = Uint8Array.from(near, (v, i) => (v || s.solid?.[i] ? 1 : 0));
      this.pathData = { rows: pathRows(pos, s.vm, s.u, ok), source: "solution" };
      this.drawPath();
      this.renderAll();
    });
  }

  /** The path (or its first picked point) on the model, while a plot is shown. */
  private drawPath() {
    if (this.pathMark) { this.pathMark.removeFromParent(); this.pathMark.traverse(o => { const m = o as THREE.Line; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); }); this.pathMark = null; }
    const part = this.host.model(), path = this.study()?.path, pts = this.pathFirst ? [this.pathFirst] : path && !this.pathing ? path : [];
    if (!part || !this.saved || !pts.length) { this.host.viewer.invalidate(); return; }
    // on a plot drawn deformed the path moves with the part
    const rows = pts.length > 1 && this.usedScale > 0 ? this.pathData?.rows : undefined, k = this.usedScale;
    const line = rows ? rows.flatMap(r => [r.at[0] + k * r.u[0], r.at[1] + k * r.u[1], r.at[2] + k * r.u[2]]) : pts.flat(), ends = pts.length > 1 ? [...line.slice(0, 3), ...line.slice(-3)] : line;
    const g = new THREE.Group(), geo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(line), 3));
    if (pts.length > 1) g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: PATH_COLOR, depthTest: false, transparent: true })));
    g.add(new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(ends), 3)), new THREE.PointsMaterial({ color: PATH_COLOR, size: 9, sizeAttenuation: false, depthTest: false, transparent: true })));
    g.traverse(o => { o.renderOrder = 3200; o.raycast = () => {}; });
    g.userData.simPath = pts.length;
    part.frame.add(g);
    this.pathMark = g;
    this.host.viewer.invalidate();
  }

  /** The values of the shown result along the path, in the solver's units. */
  private pathValues(): { d: Float32Array; v: Float32Array; ok: Uint8Array } | null {
    const rows = this.pathData?.rows;
    if (!rows?.length) return null;
    const n = rows.length, vm = new Float32Array(n), u = new Float32Array(3 * n), err = new Float32Array(n);
    rows.forEach((r, i) => { vm[i] = r.vm; u.set(r.u, 3 * i); });
    const kind = this.plot.kind === "err" ? "vm" : this.plot.kind;
    return { d: Float32Array.from(rows, r => r.d), v: this.values({ u, vm, err } as PassResult, kind), ok: Uint8Array.from(rows, r => (r.ok ? 1 : 0)) };
  }

  private pathHtml(): string {
    const pv = this.pathValues(), st = this.study();
    if (!pv || !st?.path || !this.pathData) return "";
    const kind = this.plot.kind === "err" ? "vm" : this.plot.kind, uf = UNITS[units.current].f;
    const [unit, f] = kind === "vm" ? ["MPa", 1] : kind === "sf" ? ["", 1] : [units.current, uf];
    const c = pathChart(pv.d, pv.v, pv.ok), label = t(PLOTS.find(p => p[0] === kind)?.[1] ?? "");
    return `<h5 class="sim-sub">${esc(t("Results along the path"))}</h5>`
      + (c ? pathChartSvg(c, label, v => sig(v * f), `${sig(c.length * uf)} ${units.current}`) : `<p class="sim-note muted">${esc(t("The path does not pass through the part."))}</p>`)
      + (c ? `<p class="sim-note muted" data-v="pathinfo">${esc(label)}${unit ? `, ${esc(unit)}` : ""}: ${sig(c.lo * f)} … ${sig(c.hi * f)}</p>` : "")
      + (this.pathData.source === "surface" ? `<p class="sim-note muted" data-v="pathsurface">${esc(t("Values at the nearest point of the surface. Solve again for the values inside the part."))}</p>` : "")
      + `<div class="sim-probebar"><button class="btn small" data-a="pathcsv" title="${esc(t("Save the places and values along the path as a CSV file"))}">${esc(t("Export CSV"))}</button><button class="btn small" data-a="rmpath">${esc(t("Remove path"))}</button></div>`;
  }

  private exportPath() {
    const doc = this.host.doc(), st = this.study(), rows = this.pathData?.rows;
    if (!doc || !st || !rows) return;
    download(new Blob([pathCsv(rows)], { type: "text/csv" }), `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-path.csv`);
  }

  /** Changes the study's probes (one undo step) and shows them. */
  private setProbes(label: string, fn: (list: [number, number, number][]) => [number, number, number][]) {
    const sid = this.study()?.id;
    if (!sid) return;
    this.host.change(label, d => {
      const s = d.studies?.find(x => x.id === sid);
      if (!s) return;
      const list = fn(s.probes ?? []);
      if (list.length) s.probes = list; else delete s.probes;
    });
    this.syncProbes();
    this.drawProbes();
    this.renderLegend();
  }

  /** Finds the study's probes on the plot mesh of the results. */
  private syncProbes() {
    const pm = this.res?.mesh, list = this.study()?.probes ?? [];
    const key = pm ? `${pm.pos.length}|${JSON.stringify(list)}` : "";
    if (key === this.probeKey && this.probes.length === (pm ? list.length : 0)) return;
    this.probeKey = key;
    this.probes = pm ? list.map(p => locate(pm.pos, pm.index, p)).filter((x): x is Located => !!x) : [];
  }

  private probeValue(p: Located) {
    const a = this.vals;
    return a ? valueAt(a, p) : NaN;
  }

  /** Every probe's place and results of the last pass, as CSV (null without results). */
  private probeTable(): string | null {
    const r = this.res?.passes.at(-1), pm = this.res?.mesh;
    if (!r || !pm || this.stale() || !this.probes.length) return null;
    return probeCsv(this.probes.map(p => {
      const vm = valueAt(r.vm, p), sy = this.yieldAt(r, p.i[0]);
      return { at: [0, 1, 2].map(c => valueAt(pm.pos, p, 3, c)), vm, u: [valueAt(r.u, p, 3, 0), valueAt(r.u, p, 3, 1), valueAt(r.u, p, 3, 2)], sf: sy > 0 ? sy / Math.max(vm, 1e-9) : null };
    }));
  }

  /** The probes as a table in the Study tab: place, stress, displacement, safety factor. */
  private probesHtml(): string {
    const r = this.res?.passes.at(-1), pm = this.res?.mesh;
    if (!r || !pm || this.stale() || !this.probes.length || r.modes) return "";
    const uf = UNITS[units.current].f;
    const place = (x: number) => String(Number((x * uf).toFixed(3)));
    // the safety factor is in the CSV; the side panel is too narrow for one more column
    return `<h5 class="sim-sub">${esc(t("Probes"))}</h5><div class="sim-wide"><table class="sim-ptable"><thead><tr><th>#</th><th>X, Y, Z, ${esc(units.current)}</th><th>${esc(t("von Mises stress"))}, MPa</th><th>${esc(t("Displacement"))}, ${esc(units.current)}</th><th></th></tr></thead><tbody>`
      + this.probes.map((p, i) => {
        const vm = valueAt(r.vm, p), u = Math.hypot(valueAt(r.u, p, 3, 0), valueAt(r.u, p, 3, 1), valueAt(r.u, p, 3, 2));
        return `<tr data-probe-row="${i}"><td>${i + 1}</td><td>${[0, 1, 2].map(c => place(valueAt(pm.pos, p, 3, c))).join(", ")}</td><td>${sig(vm)}</td><td>${sig(u * uf)}</td>`
          + `<td><button class="sim-x" data-a="rmprobe" data-i="${i}" title="${esc(t("Remove probe"))}" aria-label="${esc(t("Remove probe"))}">×</button></td></tr>`;
      }).join("") + `</tbody></table></div><button class="btn small" data-a="probecsv" title="${esc(t("Save the probes' places and values as a CSV file"))}">${esc(t("Export CSV"))}</button>`;
  }

  private exportProbes() {
    const doc = this.host.doc(), st = this.study(), csv = this.probeTable();
    if (!doc || !st || !csv) return;
    download(new Blob([csv], { type: "text/csv" }), `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-probes.csv`);
  }

  /** The plotted quantity's unit and the factor from the solver's units to it. */
  private plotUnit(): [string, number] {
    const k = this.plot.kind;
    if (this.res?.passes.at(-1)?.modes) return ["", 1];
    return k === "vm" ? ["MPa", 1] : k === "sf" ? ["", 1] : k === "err" ? ["%", 1] : [units.current, UNITS[units.current].f];
  }

  /** The hot spots of the last pass: the highest stress peaks, likely singularities flagged. */
  private hotList(): HotSpot[] {
    const r = this.res;
    if (!r || !r.passes.length || r.passes[0].modes) return [];
    if (this.hot?.res !== r || this.hot.n !== r.passes.length) this.hot = { res: r, n: r.passes.length, list: hotSpots(r.mesh.pos, r.mesh.index, r.passes, this.host.viewer.modelSize / 12) };
    return this.hot.list;
  }

  /** Labels of the highest and lowest values, and of the hot spots on a stress plot. */
  private peakLabels(): { v: number; html: string }[] {
    const a = this.vals;
    if (!a || !this.plot.marks || this.res?.passes.at(-1)?.modes) return [];
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
        if (b) { const k = Number(b.dataset.rm); this.setProbes(t("Remove probe"), list => list.filter((_, i) => i !== k)); }
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
    if (this.anim) { cancelAnimationFrame(this.anim.raf); this.anim = null; }
    if (this.overlay) { this.overlay.removeFromParent(); this.overlay.geometry.dispose(); this.overlay = null; }
    for (const m of this.mats) m.dispose();
    this.mats = [];
  }

  /** A result plot is on the model. */
  get plotting() { return !!this.saved; }

  // ---------- results on section planes (FR-RES-030) ----------

  /** The shown plot can be carried onto the section caps: a static result whose solution the worker still holds. */
  private capsPaintable() {
    return !!this.saved && !!this.res && !this.res.passes.at(-1)?.modes && !!this.job();
  }

  /** The plot came, went or changed: the section caps are made again (plain), then painted if they can be. */
  private capsSoon() {
    if (this.capsQueued) return;
    this.capsQueued = true;
    queueMicrotask(() => {
      this.capsQueued = false;
      if (this.host.section.planes.some(p => p.enabled)) this.host.section.rebuild();
    });
  }

  private capsChanged(caps: { mesh: THREE.Mesh }[]) {
    this.caps = caps;
    for (const [m, g] of this.capGeos) if (!caps.some(c => c.mesh === m)) { g.dispose(); this.capGeos.delete(m); }
    if (!this.capGeos.size) this.capInfo = { painted: 0, points: 0, hit: 0, min: 0, max: 0 };
    const note = !!this.saved && caps.length > 0 && !this.running && !this.res?.passes.at(-1)?.modes && !this.capsPaintable();
    if (note !== this.capNote) { this.capNote = note; this.renderLegend(); }
    if (caps.length && this.capsPaintable()) void this.paintCaps();
  }

  /** Colours every section cap by the shown result, read from the solution inside the body. */
  private async paintCaps() {
    if (this.capBusy) { this.capAgain = true; return; }
    this.capBusy = true;
    try {
      do {
        this.capAgain = false;
        const v = this.host.viewer, part = this.host.model();
        if (!part) return;
        const size = v.modelSize * 1.3, back = new THREE.Matrix4().copy(part.frame.matrixWorld).invert();
        const info = { painted: 0, points: 0, hit: 0, min: Infinity, max: -Infinity };
        for (const cap of [...this.caps]) {
          const mesh = cap.mesh;
          let geo = this.capGeos.get(mesh);
          if (!geo) {
            geo = new THREE.PlaneGeometry(size, size, CAP_GRID, CAP_GRID);
            geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * geo.getAttribute("position").count), 3));
          }
          const pa = geo.getAttribute("position"), n = pa.count, pos = new Float32Array(3 * n), p = new THREE.Vector3();
          mesh.updateMatrixWorld(true);
          const m = new THREE.Matrix4().multiplyMatrices(back, mesh.matrixWorld);
          for (let i = 0; i < n; i++) { p.fromBufferAttribute(pa, i).applyMatrix4(m); pos[3 * i] = p.x; pos[3 * i + 1] = p.y; pos[3 * i + 2] = p.z; }
          const kind = this.plot.kind, range = this.range, res = this.res;
          const s = await this.client.sample(pos, this.usedScale, false, this.job());
          if (!s || !this.capsPaintable() || this.res !== res || !this.caps.some(c => c.mesh === mesh)) continue;
          const val = Float32Array.from(this.values({ u: s.u, vm: s.vm, err: s.err } as PassResult, kind)), hit = s.hit, w = CAP_GRID + 1;
          for (let i = 0; i < n; i++) if (hit[i]) { info.hit++; if (val[i] < info.min) info.min = val[i]; if (val[i] > info.max) info.max = val[i]; }
          // points just outside the body's cells take a neighbour's value, so the cut's rim is not washed out
          for (let k = 0; k < 2; k++) {
            const was = Uint8Array.from(hit);
            for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
              const o = j * w + i;
              if (was[o]) continue;
              let sum = 0, cnt = 0;
              if (i > 0 && was[o - 1]) { sum += val[o - 1]; cnt++; }
              if (i < w - 1 && was[o + 1]) { sum += val[o + 1]; cnt++; }
              if (j > 0 && was[o - w]) { sum += val[o - w]; cnt++; }
              if (j < w - 1 && was[o + w]) { sum += val[o + w]; cnt++; }
              if (cnt) { val[o] = sum / cnt; hit[o] = 1; }
            }
          }
          const ca = geo.getAttribute("color") as THREE.BufferAttribute, col = ca.array as Float32Array, sf = kind === "sf", span = range[1] - range[0] || 1;
          for (let i = 0; i < n; i++) { const x = Math.max(0, Math.min(1, (val[i] - range[0]) / span)); ramp(sf ? 1 - x : x, col, 3 * i); }
          ca.needsUpdate = true;
          if (mesh.geometry !== geo) {
            mesh.geometry = geo;
            this.capGeos.set(mesh, geo);
            const mat = mesh.material as THREE.MeshStandardMaterial;
            mat.vertexColors = true; mat.color.set(0xffffff); mat.map = null; mat.needsUpdate = true;
            mesh.userData.simCap = true;
          }
          info.painted++; info.points += n;
        }
        if (info.painted) this.capInfo = info.hit ? info : { ...info, min: 0, max: 0 };
        this.host.viewer.invalidate();
      } while (this.capAgain);
    } finally { this.capBusy = false; }
  }

  private clearPlot() {
    const was = !!this.saved;
    if (this.saved) {
      const s = this.saved;
      for (const m of s.meshes) m.mesh.material = m.mat;
      this.saved = null;
    }
    this.disposePlot();
    this.drawProbes();
    if (was) { this.host.redraw(); this.capsSoon(); this.drawPath(); }
    this.host.viewer.invalidate();
  }

  /**
   * Colours the model by the chosen result of the last pass, on the refined plot mesh. The model itself is hidden
   * under it, or stays as a ghost when the plot is drawn deformed.
   */
  private showPlot() {
    this.clearPlot();
    const part = this.host.model(), res = this.res, r0 = res?.passes.at(-1);
    if (!part || !res || !r0 || !this.plot.on || this.stale()) return;
    const pm = res.mesh, n = pm.pos.length / 3;
    if (r0.vm.length !== n) return;
    // modal results: the picked mode's shape is what is drawn
    const mi = this.modeIndex(r0), shape = r0.shapes?.[mi];
    const r: PassResult = shape ? { ...r0, u: shape } : r0;
    if (r0.modes && !MODE_PLOTS.includes(this.plot.kind)) this.plot.kind = "u";
    // the safety factor needs a yield strength: without one the plot falls back to stress
    if (this.plot.kind === "sf" && !this.hasYield()) this.plot.kind = "vm";
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
    this.saved = { meshes: part.meshes.map(mesh => ({ mesh, mat: mesh.material })) };
    for (const mesh of part.meshes) mesh.material = under;
    this.host.redraw();
    const scale = this.plot.scale > 0 ? this.plot.scale : r.maxU > 0 ? ((r0.modes ? 0.08 : 0.05) * this.host.viewer.modelSize) / r.maxU : 1;
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
    part.frame.add(this.overlay);
    this.overlay.updateMatrixWorld(true);
    if (shape && this.plot.deformed && this.animate) this.startAnim(pm.pos, shape, scale);
    this.capsSoon();
    this.syncPath();
    this.syncProbes();
    this.drawProbes();
    this.host.viewer.invalidate();
  }

  /** Swings the drawn mode shape between its two extremes. */
  private startAnim(base: Float32Array, u: Float32Array, scale: number) {
    const a = this.anim = { raf: 0, base, u, scale, t0: performance.now(), frames: 0 };
    const step = () => {
      const ov = this.overlay;
      if (this.anim !== a || !ov) return;
      const k = scale * Math.cos((2 * Math.PI * (performance.now() - a.t0) * this.speed) / MODE_PERIOD);
      const pa = ov.geometry.getAttribute("position") as THREE.BufferAttribute, arr = pa.array as Float32Array;
      for (let i = 0; i < arr.length; i++) arr[i] = base[i] + k * u[i];
      pa.needsUpdate = true;
      a.frames++;
      this.host.viewer.invalidate();
      a.raf = requestAnimationFrame(step);
    };
    a.raf = requestAnimationFrame(step);
  }

  /** One swing of the shown mode shape as a looping GIF of the current view (up to `maxW` px wide). */
  async recordGif(maxW = 640): Promise<Blob | null> {
    const ov = this.overlay, r = this.res?.passes.at(-1), doc = this.host.doc(), st = this.study();
    const mi = this.modeIndex(r), shape = r?.shapes?.[mi], pm = this.res?.mesh;
    if (!ov || !r?.modes || !shape || !pm || !doc || !st || !this.plot.deformed || this.recording) return null;
    const v = this.host.viewer, src = v.renderer.domElement;
    if (!src.width || !src.height) return null;
    this.recording = true;
    const was = this.anim;
    this.anim = null;
    if (was) cancelAnimationFrame(was.raf);
    const n = GIF_FRAMES, fps = Math.round((1000 * n * this.speed) / MODE_PERIOD), k = Math.min(1, maxW / src.width);
    const c = document.createElement("canvas");
    c.width = Math.max(2, Math.round(src.width * k)); c.height = Math.max(2, Math.round(src.height * k));
    const g = c.getContext("2d", { willReadFrequently: true })!, frames: Uint8ClampedArray[] = [];
    const pa = ov.geometry.getAttribute("position") as THREE.BufferAttribute, arr = pa.array as Float32Array, scale = this.usedScale;
    const mode = r.modes[mi], label = `${t("Mode {n}", { n: mi + 1 })}: ${mode.rigid ? t("rigid body") : `${sig(mode.hz)} Hz`}`;
    v.bareKeep = new Set();
    try {
      for (let f = 0; f < n; f++) {
        const a = scale * Math.cos((2 * Math.PI * f) / n);
        for (let i = 0; i < arr.length; i++) arr[i] = pm.pos[i] + a * shape[i];
        pa.needsUpdate = true;
        v.render();
        g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(src, 0, 0, c.width, c.height);
        g.fillStyle = "#111827"; g.font = `13px "DejaVu Sans", system-ui, sans-serif`; g.textBaseline = "top"; g.textAlign = "left";
        g.fillText(label, 8, 8);
        frames.push(g.getImageData(0, 0, c.width, c.height).data);
        if (f % 6 === 5) await new Promise(res => setTimeout(res, 0));
      }
    } finally { v.bareKeep = null; this.recording = false; }
    const blob = new Blob([encodeGif(frames, c.width, c.height, gifDelays(n, fps))], { type: "image/gif" });
    this.gifs++;
    this.lastGif = { bytes: blob.size, frames: n, w: c.width, h: c.height };
    download(blob, `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-mode${mi + 1}.gif`);
    // back to the live swing (or the still shape)
    if (this.overlay === ov) { if (this.animate) this.startAnim(pm.pos, shape, scale); else { for (let i = 0; i < arr.length; i++) arr[i] = pm.pos[i] + scale * shape[i]; pa.needsUpdate = true; v.invalidate(); } }
    return blob;
  }

  /** Modes of the pass that lie within 10 % of the study's excitation frequency. */
  private nearModes(r: PassResult | undefined): number[] {
    const ex = parseExcitation(this.study()?.excite ?? "");
    return ex == null || !r?.modes ? [] : nearExcitation(r.modes.map(m => (m.rigid ? 0 : m.hz)), ex);
  }

  /** The modes as rows of text: number, frequency, effective mass along X, Y, Z (%). */
  private modeRows(r: PassResult, cumul = false): string[][] {
    const run = [0, 0, 0];
    return (r.modes ?? []).map((m, i) => [String(i + 1), m.rigid ? `0 (${t("rigid body")})` : sig(m.hz), ...m.eff.map((e, c) => (100 * (cumul ? (run[c] += e) : e)).toFixed(1))]);
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
    const mr = this.res?.passes.at(-1), mi = this.modeIndex(mr), mode = mr?.modes?.[mi];
    const label = mode ? `${t("Mode {n}", { n: mi + 1 })}, ${mode.rigid ? t("rigid body") : `${sig(mode.hz)} Hz`}. ${t(PLOTS.find(p => p[0] === kind)![1])}` : t(PLOTS.find(p => p[0] === kind)![1]);
    const caption = mode ? `${label}. ${t("Mode shapes have no scale: only the pattern of the motion is meaningful.")}` : `${label}: ${lo} … ${hi}${unit ? ` ${unit}` : ""}` + (this.plot.deformed ? `. ${t("Deformed shape")} ×${sig(this.usedScale)}` : "");
    return { src: c.toDataURL("image/jpeg", 0.9), w: c.width, h: c.height, caption };
  }

  /** The report's table of the materials bodies have of their own (nothing when no body has one). */
  private bodyMatBlocks(doc: SimDoc, blocks: ReportBlock[]) {
    const res = this.res;
    if (res?.comps) {
      // an assembly: its components with their materials, and the pairs joined
      blocks.push({ kind: "table", widths: [4, 4, 2], rows: [[t("Components"), t("Material"), t("Yield strength")], ...res.comps.map((c, i) => [c.name, res.bodyMats?.[i]?.name ?? "", res.bodyMats?.[i]?.sy ? `${sig(res.bodyMats[i].sy)} MPa` : "–"])] });
      const cs = res.passes.at(-1)?.contacts ?? [];
      if (cs.length) {
        blocks.push({ kind: "h", text: t("Connections") });
        blocks.push({ kind: "table", widths: [6, 2, 2], rows: [[t("Components"), `${t("Area")}, mm²`, t("Type")], ...cs.map(c => [`${res.comps![c.a]?.name ?? ""} – ${res.comps![c.b]?.name ?? ""}`, sig(c.area), t(c.type === "sliding" ? "Sliding" : "Bonded")])] });
      }
      return;
    }
    const seen = new Set<string>(), rows: string[][] = [];
    for (const b of Object.values(doc.bodies ?? {})) {
      const q = b.material;
      if (!q || q.name === doc.material?.name || seen.has(q.name)) continue;
      seen.add(q.name);
      rows.push([q.name, `${sig(q.E ?? NaN)} GPa`, sig(q.nu ?? NaN), `${sig(q.density)} g/cm³`, q.sy ? `${sig(q.sy)} MPa` : "–"]);
    }
    if (!rows.length) return;
    blocks.push({ kind: "p", text: t("Bodies with their own material:") });
    blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2], rows: [[t("Name"), t("Elastic modulus"), t("Poisson's ratio"), t("Density"), t("Yield strength")], ...rows] });
  }

  /** What the report says: the study, its set-up and the results of the last pass, in the UI language. */
  private reportOf(): SimReport | null {
    const doc = this.host.doc(), st = this.study(), res = this.res, last = res?.passes.at(-1);
    if (!doc || !st || !res || !last || this.stale()) return null;
    const m = doc.material, off = new Set(st.suppressed ?? []);
    const blocks: ReportBlock[] = [];
    const kv = (rows: string[][]) => blocks.push({ kind: "table", rows: [[t("Property"), t("Value")], ...rows], widths: [2, 3] });
    const n3 = (c: number[], f: number, unit: string) => `X ${sig(c[0] * f)}, Y ${sig(c[1] * f)}, Z ${sig(c[2] * f)} ${unit}`;
    const faces = (it: StudySupport | StudyLoad) => it.type === "gravity" ? "–" : it.type === "centrifugal" && !it.faces.length ? this.axisText(it as StudyLoad) : this.pickText(it);
    const name = (it: StudySupport | StudyLoad) => (it.name ?? it.id) + (off.has(it.id) ? ` (${t("left out")})` : "");
    blocks.push({ kind: "h", text: t("Study") });
    if (last.modes) return this.modalReport(doc, st, res, last);
    kv([[t("Document"), doc.name], [t("Study"), st.name], [t("Kind"), t("Static")], [t("Passes"), `${res.passes.length} / ${st.settings.passes}`],
      [t("Unknowns"), last.dofs.toLocaleString("en-US").replace(/,/g, " ")], [t("Time"), `${(res.ms / 1000).toFixed(1)} s`]]);
    blocks.push({ kind: "h", text: t("Material") });
    if (m) kv([[t("Name"), m.name], [t("Elastic modulus"), `${sig(m.E ?? NaN)} GPa`], [t("Poisson's ratio"), sig(m.nu ?? NaN)], [t("Density"), `${sig(m.density)} g/cm³`],
      ...(m.sy ? [[t("Yield strength"), `${sig(m.sy)} MPa`]] : [])]);
    this.bodyMatBlocks(doc, blocks);
    blocks.push({ kind: "h", text: t("Supports") });
    if (st.settings.relief) blocks.push({ kind: "p", text: `${t("Inertia relief")}. ${t(RELIEF_NOTE)}` });
    else blocks.push({ kind: "table", widths: [3, 3, 2, 4], rows: [[t("Name"), t("Type"), t("Applied to"), t("Details")], ...st.supports.map(s => [name(s), t(SUPPORT_LABEL[s.type]), faces(s),
      s.type === "hinge" && s.axialFree ? t("Free to slide along the axis") : s.type === "dirs" ? ["X", "Y", "Z"].filter((_, i) => (s.dirs ?? [true, true, true])[i]).join(", ")
        : s.type === "disp" ? ["X", "Y", "Z"].map((a, i) => ((s.dirs ?? [true, true, true])[i] ? `${a} ${sig((s.disp ?? [0, 0, 0])[i])} mm` : "")).filter(Boolean).join(", ")
        : s.type === "elastic" ? `${t("Normal")} ${sig(s.kn ?? 0)} N/mm³, ${t("In the face")} ${sig(s.kt ?? 0)} N/mm³` : ""])] });
    blocks.push({ kind: "h", text: t("Loads") });
    blocks.push({ kind: "table", widths: [3, 3, 2, 4], rows: [[t("Name"), t("Type"), t("Applied to"), t("Value")], ...st.loads.map(l => {
      const c = (l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => x.v), pull = l.flip ? `, ${t("Reverse (pull)")}` : "";
      const val = l.type === "force" ? (l.normal && !l.on ? `${sig(l.value?.v ?? 0)} N, ${t("Along the face normal")}${pull}` : n3(c, 1, "N"))
        : l.type === "pressure" ? `${sig(l.value?.v ?? 0)} MPa${pull}` : l.type === "centrifugal" ? `${sig(l.value?.v ?? 0)} rpm${l.accel ? `, ${sig(l.accel)} rad/s²` : ""}`
        : l.type === "torque" ? `${sig((l.value?.v ?? 0) * 1e-3)} N·m${l.flip ? `, ${t("Reverse direction")}` : ""}` : l.type === "bearing" ? n3(c, 1, "N")
        : l.type === "hydro" ? `${sig(l.value?.v ?? 0)} kg/m³, ${this.levelText(l)}`
        : l.type === "remote" ? `${n3(c, 1, "N")}; ${n3((l.mom ?? []).map(x => x?.v ?? 0), 1e-3, "N·m")}; ${t("at ({x}, {y}, {z}) mm", { x: sig((l.at ?? [0, 0, 0])[0]), y: sig((l.at ?? [0, 0, 0])[1]), z: sig((l.at ?? [0, 0, 0])[2]) })}` : l.type === "moment" ? n3(c, 1e-3, "N·m") : n3(c, 1e-3, "m/s²");
      return [name(l), t(LOAD_LABEL[l.type]), faces(l), val];
    })] });
    if (res.cases?.length) {
      blocks.push({ kind: "h", text: t("Load cases") });
      blocks.push({ kind: "table", widths: [3, 5, 2, 2], rows: [[t("Name"), t("Loads"), `${t("Max von Mises stress")}, MPa`, `${t("Max displacement")}, ${units.current}`],
        ...res.cases.map(c => { const cs = st.cases?.find(x => x.id === c.id), lp = c.passes.at(-1)!;
          return [this.caseName(c), st.loads.filter(l => !off.has(l.id) && !cs?.off.includes(l.id)).map(l => l.name ?? l.id).join(", "), sig(lp.maxVm), sig(lp.maxU * UNITS[units.current].f)]; })] });
    }
    if (st.refine?.length) {
      blocks.push({ kind: "h", text: t(REFINE_LABEL) });
      blocks.push({ kind: "table", widths: [3, 2, 1], rows: [[t("Name"), t("Applied to"), t("Level")], ...st.refine.map(r => [(r.name ?? r.id) + (off.has(r.id) ? ` (${t("left out")})` : ""), this.pickText(r), String(r.level)])] });
    }
    blocks.push({ kind: "h", text: t("Results") });
    const f = (v: number[]) => sig(Math.hypot(v[0], v[1], v[2]));
    const hs = this.hotList(), singular = hs.some(h => h.singular), real = singular ? hs.find(h => !h.singular) : undefined, peak = real?.vm ?? last.maxVm;
    const rows: string[][] = [[t("Max von Mises stress"), `${sig(last.maxVm)} MPa${singular ? ` (${t("Stress singularity: value depends on refinement")})` : ""}`]];
    if (res.cases?.length) rows.unshift([t("Load case"), this.enveloped ? t("Envelope (highest of all cases)") : this.caseName(res.cases[Math.max(0, this.caseSel)])]);
    if (real) rows.push([t("Highest stress away from singularities"), `${sig(real.vm)} MPa`]);
    rows.push([t("Max displacement"), this.lenText(last.maxU)]);
    if (last.accel && !this.enveloped) {
      rows.push([t("Acceleration"), `${sig(Math.hypot(...last.accel.a) * 1e-3)} m/s² (${last.accel.a.map(x => sig(x * 1e-3)).join(", ")})`]);
      if (Math.hypot(...last.accel.alpha) > 1e-9) rows.push([t("Angular acceleration"), `${sig(Math.hypot(...last.accel.alpha))} rad/s² (${last.accel.alpha.map(x => sig(x)).join(", ")})`]);
    }
    const lowSf = this.lowSf(last, peak);
    if (lowSf != null) rows.push([t("Lowest safety factor (yield)"), sig(lowSf)]);
    const errs = last.errors, eLast = errs.at(-1), eBefore = errs.length > 1 ? errs[errs.length - 2] : null;
    if (eLast != null) rows.push([t("Estimated error"), `≈ ${sig(eLast)} %`]);
    else if (eBefore != null) rows.push([t("Estimated error"), `< ${sig(eBefore)} %`]);
    if (!this.enveloped) rows.push([t("Applied load"), `${f(last.applied.force)} N (${last.applied.force.map(x => sig(x)).join(", ")})`]);
    last.reactions.forEach((re, i) => rows.push([`${t("Reaction")} ${this.nameOf(res.ids[i] ?? "")}`, `${f(re.force)} N (${re.force.map(x => sig(x)).join(", ")})`]));
    kv(rows);
    const keep = { ...this.plot };
    const kinds: PlotKind[] = ["vm", "u", ...(this.hasYield() ? ["sf" as PlotKind] : [])];
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
    if (!this.enveloped) blocks.push({ kind: "h", text: t("Convergence") });
    if (!this.enveloped) blocks.push({ kind: "table", widths: [1, 2, 2, 2, 2], rows: [[t("Pass"), t("Unknowns"), t("Energy change"), t("Est. error"), t("Time")],
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

  private modalReport(doc: SimDoc, st: Study, res: Results, last: PassResult): SimReport {
    const m = doc.material, off = new Set(st.suppressed ?? []), blocks: ReportBlock[] = [];
    const kv = (rows: string[][]) => blocks.push({ kind: "table", rows: [[t("Property"), t("Value")], ...rows], widths: [2, 3] });
    blocks.push({ kind: "h", text: t("Study") });
    kv([[t("Document"), doc.name], [t("Study"), st.name], [t("Kind"), t("Modal")], [t("Passes"), `${res.passes.length} / ${Math.min(MODAL_PASSES, st.settings.passes)}`],
      [t("Unknowns"), last.dofs.toLocaleString("en-US").replace(/,/g, " ")], [t("Time"), `${(res.ms / 1000).toFixed(1)} s`], [t("Mass"), `${sig((last.mass ?? 0) * 1000)} kg`]]);
    blocks.push({ kind: "h", text: t("Material") });
    if (m) kv([[t("Name"), m.name], [t("Elastic modulus"), `${sig(m.E ?? NaN)} GPa`], [t("Poisson's ratio"), sig(m.nu ?? NaN)], [t("Density"), `${sig(m.density)} g/cm³`]]);
    this.bodyMatBlocks(doc, blocks);
    blocks.push({ kind: "h", text: t("Supports") });
    if (st.supports.length) blocks.push({ kind: "table", widths: [3, 3, 2, 4], rows: [[t("Name"), t("Type"), t("Applied to"), t("Details")], ...st.supports.map(s => [(s.name ?? s.id) + (off.has(s.id) ? ` (${t("left out")})` : ""), t(SUPPORT_LABEL[s.type]), this.pickText(s),
      s.type === "hinge" && s.axialFree ? t("Free to slide along the axis") : s.type === "dirs" ? ["X", "Y", "Z"].filter((_, i) => (s.dirs ?? [true, true, true])[i]).join(", ") : ""])] });
    else blocks.push({ kind: "p", text: t("No supports: the part is free.") });
    blocks.push({ kind: "h", text: t("Modes") });
    if (st.settings.range) blocks.push({ kind: "p", text: t("Modes between {a} and {b} Hz.", { a: sig(st.settings.range.from), b: sig(st.settings.range.to) }) + (last.more ? " " + t("{n} modes were found, the most a study finds, and the range goes on: more modes may lie in it.", { n: MAX_MODES }) : "") });
    const sum = [0, 1, 2].map(c => (last.modes ?? []).reduce((a, x) => a + x.eff[c], 0));
    blocks.push({ kind: "table", widths: [1, 3, 2, 2, 2], rows: [["#", `${t("Frequency")}, Hz`, `${t("Effective mass")} X, %`, "Y, %", "Z, %"], ...this.modeRows(last), ["", t("Sum"), ...sum.map(v => (100 * v).toFixed(1))]] });
    if ((last.modes ?? []).length > 1) {
      blocks.push({ kind: "p", muted: true, text: t("Effective mass added up over the modes:") });
      blocks.push({ kind: "table", widths: [1, 3, 2, 2, 2], rows: [["#", `${t("Frequency")}, Hz`, "X, %", "Y, %", "Z, %"], ...this.modeRows(last, true)] });
    }
    const ex = parseExcitation(st.excite ?? ""), near = this.nearModes(last);
    if (ex != null) blocks.push({ kind: "p", text: near.length
      ? t("Resonance risk: mode {list} lies within 10 % of the excitation at {f} Hz.|Resonance risk: modes {list} lie within 10 % of the excitation at {f} Hz.", { n: near.length, list: near.map(i => `${i + 1} (${sig(last.modes![i].hz)} Hz)`).join(", "), f: sig(ex) })
      : t("No mode found lies within 10 % of the excitation at {f} Hz.", { f: sig(ex) }) });
    const keep = { ...this.plot }, sel = this.modeSel, anim = this.animate;
    this.animate = false;
    const elastic = (last.modes ?? []).map((x, i) => (x.rigid ? -1 : i)).filter(i => i >= 0).slice(0, 4);
    for (const i of elastic) { this.modeSel = i; const im = this.capture("u"); if (im) blocks.push({ kind: "image", ...im }); }
    this.plot = keep; this.modeSel = sel; this.animate = anim;
    this.showPlot();
    blocks.push({ kind: "h", text: t("Convergence") });
    blocks.push({ kind: "table", widths: [1, 2, 2, 2], rows: [[t("Pass"), t("Unknowns"), t("Frequency change"), t("Time")],
      ...res.passes.map(p => [String(p.pass), p.dofs.toLocaleString("en-US").replace(/,/g, " "), p.change == null ? "–" : `${sig(p.change)} %`, `${(p.ms / 1000).toFixed(1)} s`])] });
    blocks.push({ kind: "p", muted: true, text: this.modalNote(st, last) });
    blocks.push({ kind: "h", text: t("Assumptions") });
    blocks.push({ kind: "p", text: t(ASSUMPTIONS) });
    return { title: t("Structural analysis report"), sub: `${doc.name} · ${st.name} · ${new Date().toLocaleString(lang())} · MöbiusCAD ${__APP_VERSION__}`, blocks };
  }

  /** A hydrostatic pressure's fluid surface. */
  private levelText(l: StudyLoad): string { return t("surface at {a} = {v} mm", { a: (l.axis ?? "z").toUpperCase(), v: sig(l.level ?? 0) }); }

  /** A centrifugal load without faces: its world axis. */
  private axisText(l: StudyLoad): string { return t("Axis {a} at the origin", { a: (l.axis ?? "z").toUpperCase() }); }

  private modalNote(st: Study, last: PassResult): string {
    return last.converged ? t("Converged: the last pass changed the frequencies by at most {n} %.", { n: sig(last.change ?? 0) })
      : last.change != null ? t("Not converged to {tol} % yet (last change {n} %).", { tol: sig(st.settings.energyTol), n: sig(last.change) })
      : t("One pass only: no convergence check.");
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
    const noLoads = st?.kind === "modal";
    el.innerHTML = group(t("Study"), btn("new", t("New study"), this.host.asm() ? t("New static study of this assembly") : t("New static study of this part"), { dis: busy }) + btn("newmodal", t("Modal study"), this.host.asm() ? t("New modal study: the natural frequencies and mode shapes of this assembly") : t("New modal study: the natural frequencies and mode shapes of this part"), { dis: busy }) + (this.host.asm() ? "" : btn("mat", t("Material"), t("The part's material: elastic modulus, Poisson's ratio, strength"), { dis: busy })))
      + sep + group(t("Supports"), SUPPORTS.map(k => btn(k, t(SUPPORT_LABEL[k]), t(TIP[k]), { dis: busy })).join(""))
      + sep + group(t("Loads"), LOADS.map(k => btn(k, t(LOAD_LABEL[k]), t(TIP[k]), { dis: busy || noLoads })).join(""))
      + sep + group(t("Solve"), btn("refine", t(REFINE_LABEL), t("Local accuracy: the solution starts finer at the picked faces"), { dis: busy || noLoads }) + (busy ? btn("stop", t("Stop"), t("Stop the analysis")) : btn("solve", t("Solve"), t("Run the analysis"), { dis: !st }))
        + btn("results", t("Results"), t("Show or hide the result plot on the model"), { on: this.plot.on && !!this.res && !this.stale(), dis: !this.res || this.stale() })
        + btn("report", t("Report"), t("Save the study and its results as a report"), { dis: busy || !this.res || this.stale() }));
  }

  private renderTree() {
    const el = $("#sim-tree");
    const doc = this.host.doc();
    if (!doc) { el.innerHTML = ""; return; }
    const st = this.study();
    if (!st) {
      el.innerHTML = `<div class="sim-empty"><p>${esc(this.host.asm() ? t("A study holds the supports and loads of one analysis. The assembly is solved as it is, without a mesh: every component with its part's material, joined where they touch.") : t("A study holds the supports and loads of one analysis. The part is solved as it is, without a mesh."))}</p><button class="btn" data-a="new">${esc(t("New study"))}</button> <button class="btn" data-a="newmodal">${esc(t("Modal study"))}</button></div>`;
      return;
    }
    const list = doc.studies ?? [];
    const m = doc.material, matOk = !!m && !!m.E && m.nu != null;
    const ownMats = [...new Set(Object.values(doc.bodies ?? {}).map(b => b.material?.name).filter((n): n is string => !!n && n !== m?.name))];
    const off = new Set(st.suppressed ?? []);
    const row = (it: StudySupport | StudyLoad | StudyRefine, load: boolean) => {
      const bad = this.problems.get(it.id);
      const isOff = off.has(it.id);
      return `<li class="sim-row${isOff ? " off" : ""}${bad ? " bad" : ""}${this.edit?.draft.id === it.id ? " cur" : ""}" data-id="${it.id}">`
        + `<button class="sim-name" data-a="edit" translate="no" title="${esc(t("Edit"))}"><i class="sim-dot ${it.type === "refine" ? "ref" : load ? "load" : "sup"}" aria-hidden="true"></i>${esc(it.name ?? it.id)}</button>`
        + `<span class="sim-meta">${it.type === "gravity" ? "" : it.type === "centrifugal" && !it.faces.length ? esc(this.axisText(it as StudyLoad)) : esc(this.pickText(it))}${it.type === "refine" ? ` · ${esc(t("level {n}", { n: it.level }))}` : ""}</span>`
        + `<button class="sim-ib" data-a="toggle" aria-pressed="${isOff}" title="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}" aria-label="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}">${isOff ? "○" : "●"}</button>`
        + `<button class="sim-ib" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">×</button>`
        + (bad ? `<p class="sim-prob">${esc(this.errorText(`${bad}: ${it.id}`))}</p>` : "")
        + `</li>`;
    };
    const none = (text: string) => `<li class="sim-none muted">${esc(text)}</li>`;
    let html = `<div class="sim-head">`
      + (list.length > 1 ? `<select data-k="study" aria-label="${esc(t("Study"))}" translate="no">${list.map(s => `<option value="${s.id}"${s.id === st.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`
        : `<b translate="no">${esc(st.name)}</b>`)
      + `<span class="muted" data-v="kind">${esc(st.kind === "modal" ? t("Modal") : t("Static"))}</span><button class="sim-ib" data-a="delstudy" title="${esc(t("Delete study"))}" aria-label="${esc(t("Delete study"))}">×</button></div>`;
    if (this.host.asm()) html += this.linksHtml(st);
    else html += `<div class="sim-sec"><h4>${esc(t("Material"))}</h4><button class="pm-box${matOk ? "" : " sim-warn"}" data-a="mat">${m ? `<span translate="no">${esc(m.name)}</span>` : esc(t("No material"))}</button>`
      + (m && matOk ? `<p class="sim-note muted">E ${sig(m.E!)} GPa · ν ${sig(m.nu!)}${m.sy ? ` · ${esc(t("yield"))} ${sig(m.sy)} MPa` : ""}</p>` : `<p class="sim-prob">${esc(t("The analysis needs a material with an elastic modulus and Poisson's ratio."))}</p>`)
      + (ownMats.length ? `<p class="sim-note muted sim-bodymats">${esc(t("Bodies with their own material:"))} <span translate="no">${esc(ownMats.join(", "))}</span></p>` : "") + `</div>`;
    const modal = st.kind === "modal";
    const relief = !modal && !!st.settings.relief;
    html += `<div class="sim-sec${relief ? " sim-relieved" : ""}"><h4>${esc(t("Supports"))}</h4><ul class="sim-list">${st.supports.map(s => row(s, false)).join("") || none(modal ? t("None: the part is free. Supports are optional here.") : relief ? t("None: the part is free.") : t("None yet: pick one in the Simulation tab."))}</ul>`
      + (modal ? "" : `<label class="chk sim-relief" title="${esc(t(RELIEF_NOTE))}"><input type="checkbox" data-k="relief"${relief ? " checked" : ""} />${esc(t("Inertia relief"))}</label>` + (relief ? `<p class="sim-note muted">${esc(t(RELIEF_NOTE))}</p>` : "")) + `</div>`;
    if (!modal) html += `<div class="sim-sec"><h4>${esc(t("Loads"))}</h4><ul class="sim-list">${st.loads.map(l => row(l, true)).join("") || none(t("None yet: pick one in the Simulation tab."))}</ul></div>`;
    if (!modal && (st.loads.length > 1 || st.cases?.length)) {
      const cs = st.cases ?? [];
      html += `<div class="sim-sec sim-cases"><h4>${esc(t("Load cases"))}</h4>`
        + cs.map(c => `<div class="sim-case" data-c="${c.id}"><div class="sim-case-h"><input type="text" data-k="cname" value="${esc(c.name)}" aria-label="${esc(t("Name"))}" translate="no" spellcheck="false" /><button class="sim-ib" data-a="rmcase" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">×</button></div>`
          + st.loads.map(l => `<label class="chk"><input type="checkbox" data-k="cload" data-l="${l.id}"${c.off.includes(l.id) || off.has(l.id) ? "" : " checked"}${off.has(l.id) ? " disabled" : ""} /><span translate="no">${esc(l.name ?? l.id)}</span></label>`).join("") + `</div>`).join("")
        + `<p class="sim-note muted">${esc(cs.length ? t("Each case is solved on its own with its ticked loads and the same supports. The results show one case, or the highest values of them all.") : t("All the loads act together. Add cases to solve different sets of the loads in one go."))}</p>`
        + (cs.length < MAX_CASES ? `<button class="btn small" data-a="addcase">${esc(t("Add load case"))}</button>` : "") + `</div>`;
    }
    if (modal) html += `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Find"))}</span><select data-k="find"><option value="count"${st.settings.range ? "" : " selected"}>${esc(t("The lowest modes"))}</option><option value="range"${st.settings.range ? " selected" : ""}>${esc(t("Modes in a frequency range"))}</option></select></label>`
      + (st.settings.range
        ? `<label class="pm-field"><span>${esc(t("From"))}, Hz</span><input type="number" data-k="rfrom" min="0" step="any" value="${sig(st.settings.range.from)}"></label><label class="pm-field"><span>${esc(t("To"))}, Hz</span><input type="number" data-k="rto" min="0" step="any" value="${sig(st.settings.range.to)}"></label>`
        : `<label class="pm-field"><span>${esc(t("Modes"))}</span><input type="number" data-k="modes" min="1" max="${MAX_MODES}" step="1" value="${st.settings.modes ?? DEFAULT_MODES}"></label>`)
      + `<label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: MODAL_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === Math.min(MODAL_PASSES, st.settings.passes) ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
      + `<label class="pm-field"><span>${esc(t("Stop at frequency change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
      + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once no frequency changes by more than {n} %.", { n: sig(st.settings.energyTol) }))}</p>`
      + `<label class="pm-field"><span>${esc(t("Excitation"))}</span><input type="text" data-k="excite" value="${esc(st.excite ?? "")}" placeholder="${esc(t("e.g. 3000 rpm or 50 Hz"))}" title="${esc(t("A frequency the part is shaken at, such as a motor speed: modes within 10 % of it are marked"))}" spellcheck="false" /></label></div>`;
    else html += `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: MAX_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === st.settings.passes ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
      + `<label class="pm-field"><span>${esc(t("Stop at energy change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
      + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once the strain energy changes by less than {n} %.", { n: sig(st.settings.energyTol) }))} ${esc(t("Passes after the third raise it only where the estimated error is highest."))}</p>`
      + (st.refine?.length ? `<ul class="sim-list sim-refs">${st.refine.map(r => row(r, false)).join("")}</ul>` : "") + `</div>`;
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
    if (this.error && !this.running) html += `<p class="sim-prob">${this.errorIn ? `<span translate="no">${esc(this.errorIn)}</span>: ` : ""}${esc(this.errorText(this.error))}</p>`;
    if (!r || !last) return html || `<p class="sim-note muted">${esc(t("Not solved yet."))}</p><button class="btn small" data-a="solve">${esc(t("Solve"))}</button>`;
    if (this.stale()) html += `<p class="sim-prob">${esc(t("Out of date: the model or the study changed."))} <button class="btn small" data-a="solve">${esc(t("Solve"))}</button></p>`;
    if (last.modes) return html + this.modalHtml(r, last);
    const f = (v: number[]) => sig(Math.hypot(v[0], v[1], v[2]));
    const env = this.enveloped;
    if (r.cases?.length && !this.running) {
      html += `<label class="pm-field"><span>${esc(t("Load case"))}</span><select data-k="case" translate="no">${r.cases.map((c, i) => `<option value="${i}"${!env && i === Math.max(0, this.caseSel) ? " selected" : ""}>${esc(this.caseName(c))}</option>`).join("")}`
        + (r.cases.length > 1 ? `<option value="-1"${env ? " selected" : ""}>${esc(t("Envelope (highest of all cases)"))}</option>` : "") + `</select></label>`;
      if (r.cases.length > 1) html += `<table class="sim-passes sim-casetable"><thead><tr><th>${esc(t("Load case"))}</th><th>${esc(t("von Mises stress"))}, MPa</th><th>${esc(t("Displacement"))}, ${esc(units.current)}</th></tr></thead><tbody>`
        + r.cases.map((c, i) => { const lp = c.passes.at(-1)!; return `<tr data-a="case" data-case="${i}" tabindex="0" class="${!env && i === this.caseSel ? "sel" : ""}"><td translate="no">${esc(this.caseName(c))}</td><td>${sig(lp.maxVm)}</td><td>${sig(lp.maxU * UNITS[units.current].f)}</td></tr>`; }).join("") + `</tbody></table>`;
      if (env) html += `<p class="sim-note muted sim-env">${esc(t("Envelope: at every point the highest stress of any case, and the displacement of the case that moves it most."))}</p>`;
    }
    const hs = this.hotList(), singular = hs.some(h => h.singular), real = singular ? hs.find(h => !h.singular) : undefined, peak = real?.vm ?? last.maxVm;
    const warn = `<span class="sim-warn" title="${esc(t("Stress singularity: value depends on refinement"))}">⚠</span>`;
    html += `<dl class="sim-kv"><dt>${esc(t("Max von Mises stress"))}</dt><dd data-v="maxvm">${sig(last.maxVm)} MPa${singular ? ` ${warn}` : ""}</dd>`;
    if (real) html += `<dt>${esc(t("Highest stress away from singularities"))}</dt><dd data-v="realvm">${sig(real.vm)} MPa</dd>`;
    html += `<dt>${esc(t("Max displacement"))}</dt><dd>${esc(this.lenText(last.maxU))}</dd>`;
    if (last.accel && !env) {
      const al = Math.hypot(...last.accel.alpha);
      html += `<dt title="${esc(t("Inertia relief: the acceleration the loads give the free part"))}">${esc(t("Acceleration"))}</dt><dd data-v="accel" title="${last.accel.a.map(x => sig(x * 1e-3)).join(", ")} m/s²">${sig(Math.hypot(...last.accel.a) * 1e-3)} m/s²</dd>`;
      if (al > 1e-9) html += `<dt>${esc(t("Angular acceleration"))}</dt><dd data-v="alpha" title="${last.accel.alpha.map(x => sig(x)).join(", ")} rad/s²">${sig(al)} rad/s²</dd>`;
    }
    const lowSf = this.lowSf(last, peak);
    if (lowSf != null) html += `<dt>${esc(t("Lowest safety factor (yield)"))}</dt><dd data-v="sf"${lowSf < 1 ? ' class="sim-low"' : ""}>${sig(lowSf)}</dd>`;
    const errs = last.errors, eLast = errs.at(-1), eBefore = errs.length > 1 ? errs[errs.length - 2] : null;
    if (eLast != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">${pct(eLast).startsWith("<") ? "" : "≈ "}${pct(eLast).replace("<", "&lt;")} %</dd>`;
    else if (eBefore != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">&lt; ${pct(eBefore).replace("< ", "")} %</dd>`;
    if (!env) html += `<dt>${esc(t("Applied load"))}</dt><dd>${f(last.applied.force)} N</dd>`;
    last.reactions.forEach((re, i) => { html += `<dt>${esc(t("Reaction"))} <span translate="no">${esc(this.nameOf(r.ids[i] ?? ""))}</span></dt><dd title="${re.force.map(x => sig(x)).join(", ")} N">${f(re.force)} N</dd>`; });
    html += `</dl>`;
    if (!env) html += `<table class="sim-passes"><thead><tr><th>${esc(t("Pass"))}</th><th>${esc(t("Unknowns"))}</th><th>${esc(t("Energy change"))}</th><th>${esc(t("Est. error"))}</th><th>${esc(t("Time"))}</th></tr></thead><tbody>`
      + r.passes.map((p, i) => `<tr><td>${p.pass}</td><td>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${pct(p.change).replace("<", "&lt;")} %`}</td><td>${errs[i] == null ? "–" : `${i === errs.length - 1 && !pct(errs[i]!).startsWith("<") ? "≈ " : ""}${pct(errs[i]!).replace("<", "&lt;")} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`
      + chartSvg(errs, t("Estimated error per pass"));
    for (const line of this.localNotes(r.passes)) html += `<p class="sim-note muted sim-local">${esc(line)}</p>`;
    if (hs.length) {
      const uf = UNITS[units.current].f;
      html += `<h5 class="sim-sub">${esc(t("Hot spots"))}</h5><table class="sim-hot"><thead><tr><th>#</th><th>${esc(t("von Mises stress"))}</th><th>X, Y, Z, ${esc(units.current)}</th></tr></thead><tbody>`
        + hs.map((h, i) => `<tr data-a="hot" data-hot="${i}" tabindex="0" class="${h.singular ? "sing" : ""}${i === this.hotSel ? " sel" : ""}"><td>${i + 1}</td><td>${sig(h.vm)} MPa${h.singular ? ` ${warn}` : ""}</td><td>${h.at.map(x => String(Number((x * uf).toFixed(3)))).join(", ")}</td></tr>`).join("") + `</tbody></table>`;
      if (singular) html += `<p class="sim-note sim-sing">⚠ ${esc(t("Stress singularity: value depends on refinement"))}. ${esc(real ? t("The safety factor uses the highest stress away from singularities.") : "")}</p>`;
    }
    html += this.probesHtml();
    html += this.pathHtml();
    if (!this.running) {
      if (r.cached) html += `<p class="sim-note muted sim-kept">${esc(t("From the last solve of this model and study."))}</p>`;
      if (!env) html += `<p class="sim-note muted">${esc(last.converged ? t("Converged: the last pass changed the strain energy by {n} %.", { n: sig(last.change ?? 0) })
        : last.change != null ? t("Not converged to {tol} % yet (last change {n} %). Stress near sharp corners keeps rising with accuracy.", { tol: sig(this.study()?.settings.energyTol ?? 2), n: sig(last.change) })
        : t("One pass only: no convergence check."))}</p>`;
      if (r.parts) html += `<p class="sim-note muted sim-bonded">${esc(t("The part's {n} bodies are analysed bonded: joined wherever they touch.", { n: r.parts }))}${r.bodyMats ? ` ${esc(t("Each body has its own material."))}` : ""}</p>`;
      html += `<p class="sim-note muted sim-assume">${esc(t(ASSUMPTIONS))}</p>`;
      if (!this.stale()) html += `<button class="btn small" data-a="report">${esc(t("Report…"))}</button>`;
    }
    return html;
  }

  /** Modal results: the mode table (a click shows a mode), the passes and what they mean. */
  private modalHtml(r: Results, last: PassResult): string {
    const modes = last.modes ?? [], sel = this.modeIndex(last), first = modes.find(m => !m.rigid), rigid = modes.filter(m => m.rigid).length;
    const sum = [0, 1, 2].map(c => modes.reduce((a, x) => a + x.eff[c], 0));
    const near = new Set(this.nearModes(last));
    let html = `<dl class="sim-kv">` + (first ? `<dt>${esc(t("Lowest natural frequency"))}</dt><dd data-v="f1">${sig(first.hz)} Hz</dd>` : "")
      + `<dt>${esc(t("Mass"))}</dt><dd data-v="mass">${sig((last.mass ?? 0) * 1000)} kg</dd></dl>`;
    const range = this.study()?.settings.range;
    if (range && !modes.length) html += `<p class="sim-note sim-norange">${esc(t("No mode lies between {a} and {b} Hz.", { a: sig(range.from), b: sig(range.to) }))}</p>`;
    if (last.more) html += `<p class="sim-note sim-more">${esc(t("{n} modes were found, the most a study finds, and the range goes on: more modes may lie in it.", { n: MAX_MODES }))}</p>`;
    if (modes.length) html += `<label class="chk sim-cumul"><input type="checkbox" data-k="cumul"${this.cumul ? " checked" : ""} />${esc(t("Add the effective masses up"))}</label>`;
    html += `<table class="sim-hot sim-modes"${modes.length ? "" : " hidden"}><thead><tr><th>#</th><th>${esc(t("Frequency"))}, Hz</th><th title="${esc(t("Effective mass: the share of the part's mass that moves with the mode along each axis"))}">X, %</th><th>Y, %</th><th>Z, %</th></tr></thead><tbody>`
      + this.modeRows(last, this.cumul).map((c, i) => `<tr data-a="mode" data-mode="${i}" tabindex="0" class="${modes[i].rigid ? "rigid" : ""}${i === sel ? " sel" : ""}${near.has(i) ? " near" : ""}">${c.map((x, j) => `<td>${esc(x)}${j === 1 && near.has(i) ? ` <span class="sim-warn" title="${esc(t("Within 10 % of the excitation frequency"))}">⚠</span>` : ""}</td>`).join("")}</tr>`).join("")
      + `</tbody><tfoot><tr><td></td><td>${esc(t("Sum"))}</td>${sum.map(v => `<td>${(100 * v).toFixed(1)}</td>`).join("")}</tr></tfoot></table>`;
    if (modes.length) html += `<p class="sim-note muted">${esc(this.cumul ? t("X, Y, Z: the effective mass of this mode and the ones before it, added up. Modes that reach 90 % along an axis describe the motion along it well.") : t("X, Y, Z: effective mass, the share of the part's mass that moves with the mode along each axis. Click a mode to see its shape."))}</p>`;
    const ex = parseExcitation(this.study()?.excite ?? "");
    if (ex != null) html += near.size
      ? `<p class="sim-note sim-excite warn">${esc(t("Resonance risk: mode {list} lies within 10 % of the excitation at {f} Hz.|Resonance risk: modes {list} lie within 10 % of the excitation at {f} Hz.", { n: near.size, list: [...near].map(i => `${i + 1} (${sig(modes[i].hz)} Hz)`).join(", "), f: sig(ex) }))}</p>`
      : `<p class="sim-note muted sim-excite">${esc(t("No mode found lies within 10 % of the excitation at {f} Hz.", { f: sig(ex) }))}</p>`;
    if (rigid) html += `<p class="sim-note muted sim-rigid">${esc(t("{n} mode at 0 Hz is a motion of the whole part: the supports leave it free.|{n} modes at 0 Hz are motions of the whole part: the supports leave it free.", { n: rigid }))}</p>`;
    html += `<table class="sim-passes"><thead><tr><th>${esc(t("Pass"))}</th><th>${esc(t("Unknowns"))}</th><th>${esc(t("Frequency change"))}</th><th>${esc(t("Time"))}</th></tr></thead><tbody>`
      + r.passes.map(p => `<tr><td>${p.pass}</td><td>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${sig(p.change)} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`;
    if (!this.running) {
      const st = this.study();
      if (r.cached) html += `<p class="sim-note muted sim-kept">${esc(t("From the last solve of this model and study."))}</p>`;
      if (st) html += `<p class="sim-note muted">${esc(this.modalNote(st, last))}</p>`;
      if (r.parts) html += `<p class="sim-note muted sim-bonded">${esc(t("The part's {n} bodies are analysed bonded: joined wherever they touch.", { n: r.parts }))}${r.bodyMats ? ` ${esc(t("Each body has its own material."))}` : ""}</p>`;
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
    const title = t(e.kind === "refine" ? REFINE_LABEL : (SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]);
    const group = (legend: string, inner: string) => `<fieldset class="pm-group"><legend>${esc(legend)}</legend>${inner}</fieldset>`;
    const chk = (k: string, on: boolean | undefined, label: string) => `<label class="chk pm-chk"><input type="checkbox" data-k="${k}"${on ? " checked" : ""} />${esc(label)}</label>`;
    const hint = t("A number, an expression, a unit or a global variable: 2 kN, 3 * F");
    const nf = (k: string, label: string, v: Num | undefined, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" data-n="${k}" value="${esc(shownValue(v, d.type as LoadType))}" title="${esc(hint)}" spellcheck="false" translate="no" /><span class="muted">${esc(unit)}</span></span></label>`;
    let body = `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-k="name" value="${esc(d.name ?? "")}" spellcheck="false" translate="no" /></label>`;
    if (d.type !== "gravity") {
      const on = (d as StudyLoad).on, n = pickCount(d);
      const ask = on === "edges" ? t("Click edges on the model") : on === "points" ? t("Click corner points on the model") : d.type === "hinge" || d.type === "torque" || d.type === "bearing" ? t("Click cylindrical faces on the model") : d.type === "centrifugal" ? t("Click a cylindrical face for the axis, or leave it empty and choose an axis below") : t("Click faces on the model");
      const sel = ON_TYPES.includes(d.type) ? `<label class="pm-field"><span>${esc(e.kind === "load" ? t("Acts on") : t("Holds"))}</span><select data-k="on">${[["", "Faces"], ["edges", "Edges"], ["points", "Points"]].map(([v, l]) => `<option value="${v}"${(on ?? "") === v ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>` : "";
      body += group(on === "edges" ? t("Edges") : on === "points" ? t("Points") : t("Faces"), sel + `<div class="pm-box focus sim-faces" role="status">${n ? esc(this.pickText(d)) : esc(ask)}</div>`
        + (n ? `<button class="btn small" data-k="clear">${esc(t("Clear"))}</button>` : ""));
    }
    if (e.kind === "refine") {
      body += group(t("Level"), `<label class="pm-field"><span>${esc(t("Level"))}</span><select data-k="level">${Array.from({ length: MAX_REFINE }, (_, i) => i + 1).map(k => `<option value="${k}"${k === e.draft.level ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
        + `<p class="pm-help muted">${esc(t("The solution starts this many steps more accurate where it meets these faces, from the first pass on. Use it at fillets, holes and other places where the stress peaks."))}</p>`);
    } else if (e.kind === "support") {
      const s = e.draft;
      if (s.type === "hinge") body += group(t("Options"), chk("axialFree", s.axialFree, t("Free to slide along the axis")));
      if (s.type === "dirs") body += group(t("Held directions"), ["X", "Y", "Z"].map((a, i) => chk(`dir${i}`, (s.dirs ?? [true, true, true])[i], a)).join(""));
      const q = (k: string, label: string, v: number, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="${k}" value="${trim(v)}" spellcheck="false" /><span class="muted">${esc(unit)}</span></span></label>`;
      if (s.type === "disp") {
        const on = s.dirs ?? [true, true, true], v = s.disp ?? [0, 0, 0];
        body += group(t("Displacement"), ["X", "Y", "Z"].map((a, i) => `<div class="sim-dv">${chk(`dir${i}`, on[i], a)}${on[i] ? `<span class="pm-in"><input type="text" inputmode="decimal" data-q="d${i}" value="${trim(v[i])}" aria-label="${a}" spellcheck="false" /><span class="muted">mm</span></span>` : `<span class="muted">${esc(t("free"))}</span>`}</div>`).join("")
          + `<p class="pm-help muted">${esc(t("Ticked directions are moved by the given distance (0 holds them); the others stay free."))}</p>`);
      }
      if (s.type === "elastic") body += group(t("Stiffness per area"), q("kn", t("Normal"), s.kn ?? 0, "N/mm³") + q("kt", t("In the face"), s.kt ?? 0, "N/mm³")
        + `<p class="pm-help muted">${esc(t("The faces rest on springs: a pressure of 1 MPa moves them 1 / stiffness mm. 0 leaves that direction free."))}</p>`);
      if (s.on) body += `<p class="pm-help muted">${esc(t("An edge or a point holds the part, but the stress right at it has no meaning: it grows with every pass."))}</p>`;
      if (s.type === "sliding") body += `<p class="pm-help muted">${esc(t("Use it on flat faces, or as a symmetry plane."))}</p>`;
    } else {
      const l = e.draft, c = l.comp ?? [];
      if (l.type === "force") {
        body += group(t("Force"), (l.on ? "" : chk("normal", l.normal, t("Along the face normal")))
          + (l.normal && !l.on ? nf("value", t("Force"), l.value, "N") + chk("flip", l.flip, t("Reverse (pull)"))
            : nf("c0", "X", c[0], "N") + nf("c1", "Y", c[1], "N") + nf("c2", "Z", c[2], "N"))
          + `<p class="pm-help muted">${esc(l.on === "edges" ? t("The total, spread over the length of the picked edges.") : l.on === "points" ? t("The total, shared equally by the picked points.") : t("The total over the picked faces."))}</p>`);
      } else if (l.type === "pressure") body += group(t("Pressure"), nf("value", t("Pressure"), l.value, "MPa") + chk("flip", l.flip, t("Reverse (pull)")));
      else if (l.type === "moment") body += group(t("Moment"), nf("m0", "X", c[0], "N·m") + nf("m1", "Y", c[1], "N·m") + nf("m2", "Z", c[2], "N·m") + `<p class="pm-help muted">${esc(t("About the centre of the picked faces."))}</p>`);
      else if (l.type === "centrifugal") body += group(t("Spin"), (l.faces.length ? "" : `<label class="pm-field"><span>${esc(t("Axis"))}</span><select data-k="axis">${["x", "y", "z"].map(a => `<option value="${a}"${(l.axis ?? "z") === a ? " selected" : ""}>${a.toUpperCase()}</option>`).join("")}</select></label>`)
        + nf("value", t("Speed"), l.value, "rpm")
        + `<label class="pm-field"><span>${esc(t("Acceleration"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="accel" value="${trim(l.accel ?? 0)}" spellcheck="false" /><span class="muted">rad/s²</span></span></label>`
        + `<p class="pm-help muted">${esc(t("The whole part spins about the axis. Uses the material's density."))}</p>`);
      else if (l.type === "torque") body += group(t("Torque"), nf("value", t("Torque"), l.value, "N·m") + chk("flip", l.flip, t("Reverse direction"))
        + `<p class="pm-help muted">${esc(t("About the faces' axis, spread over them. The arrow shows the axis it turns about, right-handed."))}</p>`);
      else if (l.type === "bearing") body += group(t("Force"), nf("c0", "X", c[0], "N") + nf("c1", "Y", c[1], "N") + nf("c2", "Z", c[2], "N")
        + `<p class="pm-help muted">${esc(t("Pressed onto the half of the faces that faces the force, most in the middle. The part of the force along the axis is left out."))}</p>`);
      else if (l.type === "hydro") body += group(t("Fluid"), nf("value", t("Density"), l.value, "kg/m³")
        + `<label class="pm-field"><span>${esc(t("Up"))}</span><select data-k="up">${["x", "y", "z", "-x", "-y", "-z"].map(a => `<option value="${a}"${(l.flip ? "-" : "") + (l.axis ?? "z") === a ? " selected" : ""}>${a.length > 1 ? "−" : "+"}${a.slice(-1).toUpperCase()}</option>`).join("")}</select></label>`
        + `<label class="pm-field"><span>${esc(t("Surface at"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="level" value="${trim(l.level ?? 0)}" spellcheck="false" /><span class="muted">${(l.axis ?? "z").toUpperCase()}, mm</span></span></label>`
        + `<p class="pm-help muted">${esc(t("The pressure grows with the depth below the fluid's surface; faces above it carry none."))}</p>`);
      else if (l.type === "remote") {
        const at = l.at ?? [0, 0, 0], m = l.mom ?? [];
        const mf = (k: string, label: string, v: Num | undefined) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" data-n="${k}" value="${esc(shownValue(v, "moment"))}" title="${esc(hint)}" spellcheck="false" translate="no" /><span class="muted">N·m</span></span></label>`;
        body += group(t("Point"), ["X", "Y", "Z"].map((a, i) => `<label class="pm-field"><span>${a}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="a${i}" value="${trim(at[i])}" spellcheck="false" /><span class="muted">mm</span></span></label>`).join("")
          + `<button class="btn small${this.pickingAt ? " on" : ""}" data-k="pickat" aria-pressed="${this.pickingAt}">${esc(this.pickingAt ? t("Click a point on the model") : t("Pick on the model"))}</button>`)
          + group(t("Force"), nf("c0", "X", c[0], "N") + nf("c1", "Y", c[1], "N") + nf("c2", "Z", c[2], "N"))
          + group(t("Moment"), mf("r0", "X", m[0]) + mf("r1", "Y", m[1]) + mf("r2", "Z", m[2])
            + `<p class="pm-help muted">${esc(t("The force and the moment act at the point and are spread over the faces, as if the point were joined to them."))}</p>`);
      }
      else body += group(t("Acceleration"), nf("g0", "X", c[0], "m/s²") + nf("g1", "Y", c[1], "m/s²") + nf("g2", "Z", c[2], "m/s²") + `<p class="pm-help muted">${esc(t("Uses the material's density."))}</p>`);
    }
    // keep the caret when the panel is drawn again after a pick
    const act = document.activeElement as HTMLInputElement | null, keep = act && pm.contains(act) ? (act.dataset.n ?? act.dataset.q ?? act.dataset.k) : null;
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(title)}</h3><span class="pm-okc"><button class="pm-ok" data-k="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-k="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>${body}`;
    if (keep) pm.querySelector<HTMLElement>(`[data-n="${keep}"], [data-q="${keep}"], [data-k="${keep}"]`)?.focus();
  }

  private renderLegend() {
    const el = $("#sim-legend");
    const r = this.res?.passes.at(-1);
    const show = !!r && !!this.saved && !!this.host.doc();
    el.hidden = !show;
    if (!show) { el.innerHTML = ""; $("#viewport").classList.remove("sim-probing"); return; }
    const k = this.plot.kind, sf = k === "sf";
    const [unit, f] = this.plotUnit();
    const modes = r!.modes, mi = this.modeIndex(r);
    const plots = PLOTS.filter(([id]) => modes ? MODE_PLOTS.includes(id) : (id !== "sf" || this.hasYield()) && (id !== "err" || r!.pass > 1));
    const top = sf && this.range[1] >= SF_TOP ? `${SF_TOP}+` : sig(this.range[1] * f);
    const modeSel = modes ? `<label class="ana-row"><span>${esc(t("Mode shape"))}</span><select data-k="mode" aria-label="${esc(t("Mode shape"))}">${modes.map((m, i) => `<option value="${i}"${i === mi ? " selected" : ""}>${i + 1}: ${m.rigid ? esc(t("rigid body")) : `${sig(m.hz)} Hz`}</option>`).join("")}</select></label>` : "";
    el.innerHTML = modeSel + `<div class="ana-head"><select data-k="kind" aria-label="${esc(t("Result"))}">${plots.map(([id, l]) => `<option value="${id}"${id === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select>`
      + `<button class="sim-ib" data-a="close" title="${esc(t("Hide the plot"))}" aria-label="${esc(t("Hide the plot"))}">×</button></div>`
      + `<div class="ana-ramp" style="background:${RAMP_CSS}${sf ? ";transform:scaleX(-1)" : ""}"></div><div class="ana-scale"><span data-v="min">${sig(this.range[0] * f)}</span><span>${esc(unit)}</span><span data-v="max">${top}</span></div>`
      + (sf ? `<p class="ana-note">${esc(t("Yield strength divided by the von Mises stress; below 1 the material yields."))}</p>` : "")
      + (this.capNote ? `<p class="ana-note" data-v="capnote">${esc(t("Solve again to see the results on the section planes."))}</p>` : "")
      + (k === "err" ? `<p class="ana-note">${esc(t("Where the last pass still changed the solution: the places that would gain most from more accuracy."))}</p>` : "")
      + `<label class="chk"><input type="checkbox" data-k="deformed"${this.plot.deformed ? " checked" : ""} />${esc(t("Deformed shape"))}</label>`
      + (this.plot.deformed ? `<label class="ana-row"><span>${esc(t("Scale"))}</span><input type="text" inputmode="decimal" data-k="scale" value="${this.plot.scale > 0 ? trim(this.plot.scale) : ""}" placeholder="${esc(t("auto"))} ×${sig(this.usedScale)}" aria-label="${esc(t("Deformation scale"))}" /></label>` : "")
      + (modes ? (this.plot.deformed ? `<label class="chk"><input type="checkbox" data-k="animate"${this.animate ? " checked" : ""} />${esc(t("Animate"))}</label><label class="ana-row"><span>${esc(t("Speed"))}</span><select data-k="speed">${[0.25, 0.5, 1, 2, 4].map(x => `<option value="${x}"${x === this.speed ? " selected" : ""}>×${x}</option>`).join("")}</select></label><button class="btn small" data-a="gif" title="${esc(t("Save one swing of this mode shape as an animated GIF of the current view"))}">${esc(t("Record GIF"))}</button>` : "") + `<p class="ana-note">${esc(t("Mode shapes have no scale: only the pattern of the motion is meaningful."))}</p>` : "")
      + (modes ? "" : `<label class="chk"><input type="checkbox" data-k="marks"${this.plot.marks ? " checked" : ""} />${esc(t("Highest and lowest values"))}</label>`)
      + (modes ? "" : `<div class="sim-probebar"><button class="btn small${this.probing ? " on" : ""}" data-a="probe" aria-pressed="${this.probing}" title="${esc(t("Click the plot to read the value at a point"))}">${esc(t("Probe"))}</button>`
      + `<button class="btn small${this.pathing ? " on" : ""}" data-a="path" aria-pressed="${this.pathing}" title="${esc(t("Click two points on the plot: the result is charted along the line between them"))}">${esc(t("Path"))}</button>`
      + (this.probes.length ? `<button class="btn small" data-a="noprobes">${esc(t("Clear probes"))}</button><button class="btn small" data-a="probecsv" title="${esc(t("Save the probes' places and values as a CSV file"))}">${esc(t("Export CSV"))}</button>` : "") + `</div>`);
    if (this.pathing) el.insertAdjacentHTML("beforeend", `<p class="ana-note" data-v="pathhint">${esc(t(this.pathFirst ? "Click the end point of the path." : "Click the start point of the path."))}</p>`);
    if (modes && (this.probing || this.pathing)) { this.probing = false; this.pathing = false; }
    $("#viewport").classList.toggle("sim-probing", this.probing || this.pathing);
  }

  // ---------- events ----------

  private treeClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!b) return;
    const a = b.dataset.a!, id = b.closest<HTMLElement>("[data-id]")?.dataset.id;
    const st = this.study();
    if (a === "new") this.command("new");
    else if (a === "newmodal") this.command("newmodal");
    else if (a === "mode") {
      this.modeSel = Number(b.dataset.mode);
      this.plot.on = true;
      this.showPlot();
      this.renderAll();
    }
    else if (a === "case") this.pickCase(Number(b.dataset.case));
    else if (a === "addcase" && st) {
      this.host.change(t("Add load case"), d => { const s = d.studies?.find(x => x.id === st.id); if (s && (s.cases?.length ?? 0) < MAX_CASES) (s.cases ??= []).push(newCase(s)); });
    }
    else if (a === "rmcase" && st) {
      const cid = b.closest<HTMLElement>("[data-c]")?.dataset.c;
      this.host.change(t("Delete load case"), d => { const s = d.studies?.find(x => x.id === st.id); if (s?.cases) { s.cases = s.cases.filter(c => c.id !== cid); if (!s.cases.length) delete s.cases; } });
    }
    else if (a === "mat") void this.pickMat();
    else if (a === "solve") void this.solve();
    else if (a === "report") void this.report();
    else if (a === "probecsv") this.exportProbes();
    else if (a === "gif") void this.recordGif().then(b => { if (b) toast(t("GIF saved"), "success"); });
    else if (a === "pathcsv") this.exportPath();
    else if (a === "rmpath") this.setPath(t("Remove path"), null);
    else if (a === "rmprobe") { const i = Number(b.dataset.i); this.setProbes(t("Remove probe"), l => l.filter((_p, k) => k !== i)); this.renderAll(); }
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
        if (s.refine) { s.refine = s.refine.filter(x => x.id !== id); if (!s.refine.length) delete s.refine; }
        if (s.suppressed) s.suppressed = s.suppressed.filter(x => x !== id);
        for (const c of s.cases ?? []) c.off = c.off.filter(x => x !== id);
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
      this.edit = null; this.res = null; this.error = null; this.probes = []; this.probeKey = ""; this.probing = false;
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
    else if (el.dataset.k === "modes") {
      const v = Math.round(Number(el.value));
      if (!(v >= 1 && v <= MAX_MODES)) { el.value = String(st.settings.modes ?? DEFAULT_MODES); return; }
      this.host.change(t("Modes"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.modes = v; });
    }
    else if (el.dataset.k === "cumul") { this.cumul = el.checked; this.renderTree(); }
    else if (el.dataset.k === "gap") {
      const v = Math.max(0, Number(el.value) / UNITS[units.current].f);
      if (!Number.isFinite(v)) return;
      this.host.change(t("Gap tolerance"), d => { const s2 = d.studies?.find(x => x.id === st.id); if (s2) { if (Math.abs(v - DEFAULT_GAP) < 1e-12) delete s2.settings.gap; else s2.settings.gap = v; } });
    } else if (el.dataset.k === "link") {
      const a = el.dataset.a!, b = el.dataset.b!, v = el.value;
      this.host.change(t("Connection type"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        if (!s2) return;
        const rest = (s2.links ?? []).filter(l => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (v === "sliding" || v === "none") rest.push({ a, b, type: v });
        if (rest.length) s2.links = rest; else delete s2.links;
      });
    }
    else if (el.dataset.k === "relief") this.host.change(t("Inertia relief"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) { if (el.checked) s.settings.relief = true; else delete s.settings.relief; } });
    else if (el.dataset.k === "case") this.pickCase(Number(el.value));
    else if (el.dataset.k === "cname" || el.dataset.k === "cload") {
      const cid = el.closest<HTMLElement>("[data-c]")?.dataset.c, cur = st.cases?.find(c => c.id === cid), lid = el.dataset.l ?? "";
      if (!cur) return;
      const name = el.value.trim();
      if (el.dataset.k === "cname" && (!name || name === cur.name)) { el.value = cur.name; return; }
      this.host.change(el.dataset.k === "cname" ? t("Rename load case") : t("Loads of a load case"), d => {
        const c = d.studies?.find(x => x.id === st.id)?.cases?.find(x => x.id === cid);
        if (!c) return;
        if (el.dataset.k === "cname") c.name = name;
        else c.off = el.checked ? c.off.filter(x => x !== lid) : [...new Set([...c.off, lid])];
      });
    }
    else if (el.dataset.k === "find") {
      const on = el.value === "range";
      if (on === !!st.settings.range) return;
      this.host.change(t("Modes"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) { if (on) s.settings.range = { from: 0, to: 1000 }; else delete s.settings.range; } });
    }
    else if (el.dataset.k === "rfrom" || el.dataset.k === "rto") {
      const r = st.settings.range, v = Number(el.value), from = el.dataset.k === "rfrom";
      if (!r) return;
      if (!el.value.trim() || !(v >= 0) || (from ? v >= r.to : v <= r.from)) { el.value = sig(from ? r.from : r.to); toast(t("The range must run from a lower to a higher frequency."), "warn"); return; }
      this.host.change(t("Frequency range"), d => { const s = d.studies?.find(x => x.id === st.id); if (s?.settings.range) { if (from) s.settings.range.from = v; else s.settings.range.to = v; } });
    }
    else if (el.dataset.k === "excite") {
      const v = el.value.trim();
      if (v && parseExcitation(v) == null) { el.setAttribute("aria-invalid", "true"); toast(t("Type a frequency such as 50 Hz or 3000 rpm."), "warn"); return; }
      this.host.change(t("Excitation"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) { if (v) s.excite = v; else delete s.excite; } });
    }
    else if (el.dataset.k === "tol") {
      const v = Number(el.value);
      if (!(v >= 0 && v <= 20) || el.value.trim() === "") { el.value = sig(st.settings.energyTol); return; }
      this.host.change(st.kind === "modal" ? t("Stop at frequency change") : t("Stop at energy change"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.energyTol = v; });
    }
  }

  private panelClick(e: Event) {
    const k = (e.target as HTMLElement).closest<HTMLElement>("button[data-k]")?.dataset.k;
    if (k === "ok") this.ok();
    else if (k === "cancel") this.cancel();
    else if (k === "pickat" && this.edit) { this.pickingAt = !this.pickingAt; this.renderPanel(); }
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
      if (v) { l.on = v; if (e.kind === "load") l.normal = false; if (v === "edges") l.edges = []; else l.points = []; } else delete l.on;
    }
    else if (k === "flip") d.flip = el.checked || undefined;
    else if (k === "axis") (e.draft as StudyLoad).axis = el.value as "x" | "y" | "z";
    else if (k === "level" && e.kind === "refine") e.draft.level = Math.max(1, Math.min(MAX_REFINE, Number(el.value) || 1));
    else if (k === "up") { const l = e.draft as StudyLoad; l.axis = el.value.slice(-1) as "x" | "y" | "z"; l.flip = el.value.length > 1 || undefined; }
    else if (el.dataset.q) {
      const q = el.dataset.q, v = num(el.value), sup = e.draft as StudySupport;
      const bad = v == null || ((q === "kn" || q === "kt") && v < 0);
      el.setAttribute("aria-invalid", String(bad));
      if (bad) return;
      if (q === "kn") sup.kn = v; else if (q === "kt") sup.kt = v;
      else if (q === "accel") (e.draft as StudyLoad).accel = v || undefined;
      else if (q === "level") (e.draft as StudyLoad).level = v;
      else if (q[0] === "a") { const l = e.draft as StudyLoad, a = [...(l.at ?? [0, 0, 0])] as [number, number, number]; a[Number(q[1])] = v; l.at = a; }
      else { const a = [...(sup.disp ?? [0, 0, 0])] as [number, number, number]; a[Number(q[1])] = v; sup.disp = a; }
    }
    else if (k?.startsWith("dir")) { const a = [...(d.dirs ?? [true, true, true])] as [boolean, boolean, boolean]; a[Number(k[3])] = el.checked; d.dirs = a; }
    else if (nk) {
      let v: Num;
      const doc = this.host.doc();
      try { v = typedValue(el.value, nk[0] === "r" ? "moment" : e.draft.type as LoadType, doc && !this.host.asm() ? evalVars(doc as PartDoc, units.current).values : {}); el.setAttribute("aria-invalid", "false"); el.title = ""; }
      catch (err) {
        const x = err as ExprError;
        el.setAttribute("aria-invalid", "true");
        el.title = x.key ? t(x.key, x.params) : String(err);
        return;
      }
      if (nk === "value") d.value = v;
      else if (nk[0] === "r") {
        const l = e.draft as StudyLoad, m = (l.mom ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => ({ ...x })) as NonNullable<StudyLoad["mom"]>;
        m[Number(nk[1])] = v;
        l.mom = m;
      }
      else {
        const c = (d.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(x => ({ ...x })) as NonNullable<StudyLoad["comp"]>;
        c[Number(nk[1])] = v;
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
    else if (k === "animate") this.animate = el.checked;
    else if (k === "speed") this.speed = Number(el.value) || 1;
    else if (k === "mode") { this.modeSel = Number(el.value); this.renderTree(); }
    else if (k === "scale") { const v = num(el.value); this.plot.scale = el.value.trim() && v != null && v > 0 ? v : 0; }
    else return;
    this.showPlot();
    if (k === "kind" && this.pathData) this.renderTree();
    this.renderLegend();
  }

  /** Opens the Simulation tab (menus, tests). */
  open() { selectCmTab("simulation"); this.host.showTab(); }
}
