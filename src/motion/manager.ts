// Motion manager (FR-FT-122): SolidWorks' motion study pane under the view. A timeline with key tracks on
// distance/angle mates, motors on mates, exploded view and camera keys; play, loop, back and forth; record
// a WebM video or an animated GIF of the view. Frames are solved in order with the assembly's mate solver
// (each from the one before, so linkages do not flip) and cached until the study or the assembly changes.
import { makeGrip } from "../resize";
import { t, onLangChange, withLang } from "../i18n";
import { toast } from "../ui";
import { uid } from "../model/doc";
import * as THREE from "three";
import { applyPoint, compose, invert } from "../asm/math";
import { download } from "../tools/exporters";
import type { AsmController } from "../asm/controller";
import type { Mate, Tf } from "../asm/types";
import type { V3 } from "../model/types";
import type { Viewer } from "../viewer/Viewer";
import { AXIS_MATES, VALUE_MATES, axisLock, cameraAt, explodeKeys, fadeKeys, frameAt, poseAt, posed, frameCount, motorAmount, orbitKeys, playTime, sortKeys, valueAt } from "./evaluate";
import { encodeGif } from "./gif";
import { frameName, frameTimes } from "./frames";
import { zip } from "../model/zip";
import { clashCsv, clashItems, pairKey, type ClashItem } from "./interfere";
import { GAP_PLOTS, gapCsv, plotFile, MATE_PLOTS, TRACE_COLORS, TRACE_PLOTS, accels, alertSpans, outOfRange, tripFrame, mateCsv, mateMeasures, pathLength, plotSvg, plotUnit, rates, relativeFrames, speeds, traceAngles, traceCsv, tracePoints, traceSeries, type TracePlot } from "./trace";
import type { CamKey, Interp, Key, MotionStudy, MotorTrack, PoseKey, TracePath, Track } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: number, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);
const num = (s: string) => Number(s.trim().replace(",", "."));
const DEG = Math.PI / 180;
/** A rigid 3×4 transform as a three.js matrix. */
const tfMatrix = (m: Tf) => new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);

/** The selected key (by index into the track's sorted keys) or motor bar. */
type Sel = { track: string; key?: number } | null;
type AnyKey = Key | CamKey | PoseKey;
/** A key named by its track and time (times are unique on a track). */
type KeyRef = { track: string; t: number };
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Key interpolations, as SolidWorks' key point menu lists them. */
const INTERPS: [Interp, string][] = [["linear", "Linear"], ["snap", "Snap (jump)"], ["easein", "Ease in"], ["easeout", "Ease out"], ["ease", "Ease in/out"]];
const MAX_ZOOM = 64;
const interpOf = (raw: string): Interp | undefined => (INTERPS.some(([v]) => v === raw) && raw !== "linear" ? raw as Interp : undefined);

export class MotionManager {
  open = false;
  /** The study shown, by id ("" = the default study not saved yet). */
  studyId = "";
  time = 0;
  playing = false;
  speed = 1;
  private _sel: Sel = null;
  /** More selected keys (Ctrl/Shift+click, a box on the timeline, Ctrl+A), by track and time; `sel` is the one the panel shows. */
  private more: KeyRef[] = [];
  /** When a key drag ended: the click that follows it must not select or toggle. */
  private noClick = false;
  /** The selected trace path (its row and panel), or null. */
  selTrace: string | null = null;
  /** Waiting for a click on a component to start a trace path. */
  tracing = false;
  /** The drawn paths and markers, rebuilt when the frames or the traces change. */
  private traceGroup = new THREE.Group();
  private traceKey = "";
  /** Each trace's world points per frame (by trace id). */
  private tracePts = new Map<string, V3[]>();
  /** Mate value results: distance and angle per frame. */
  private mateVals = new Map<string, { dist: number[]; angle: number[] }>();
  /** Proximity results: the smallest distance per frame. */
  private gapVals = new Map<string, number[]>();
  /** Each sensor's out-of-range bands for its timeline lane (made when the traces are solved). */
  private alertHtml = new Map<string, string>();
  /** Each trace's component angle (degrees from the first frame) per frame (by trace id). */
  private traceAng = new Map<string, number[]>();
  /** The last interference check (Results → Interference): pairs with their time spans, for the frames it was run on. */
  clash: { study: string; key: string; items: ClashItem[]; ignored: number } | null = null;
  /** The interference results are what the panel under the timeline shows (until a key, motor or trace is selected). */
  private clashOpen = false;
  /** Count pairs that already touch at the start (SolidWorks: treat coincidence as interference). */
  clashAll = false;
  /** Pause playback where an interference from the last check starts (view-only, like the check itself). */
  clashStop = false;
  /** The selected key or motor; setting it drops the other selected keys. */
  get sel(): Sel { return this._sel; }
  set sel(v: Sel) { this._sel = v; this.more = []; if (v) { this.selTrace = null; this.clashOpen = false; } }
  /** The copied keys (Ctrl+C or the key menu): each with its track, the unit of that track and its time after the first. */
  private clip: { items: { track: string; unit: string; dt: number; key: AnyKey }[] } | null = null;
  /** Timeline zoom (view only): 1 shows the whole study, 2 half of it, … (SolidWorks' Zoom In / Zoom Out / Zoom to Fit). */
  zoom = 1;
  /** Solved component transforms per frame, from frame 0 up. */
  private frames: Record<string, Tf>[] = [];
  /** Frames where the mates could not all be solved. */
  private badFrames = new Set<number>();
  private cacheKey = "";
  private raf = 0;
  private playStart = 0;
  private playFrom = 0;
  private pane: HTMLElement;
  /** Recording: the canvas frames are composed on, and what to do after each render. */
  private capture: ((src: HTMLCanvasElement) => void) | null = null;
  private renderWaiters: (() => void)[] = [];
  recording: "webm" | "gif" | "png" | null = null;
  private grip: HTMLDivElement;

  constructor(private asm: AsmController, private viewer: Viewer) {
    this.pane = document.createElement("section");
    this.pane.id = "motion";
    this.pane.className = "motion step-only";
    this.pane.setAttribute("aria-label", "Motion study");
    this.pane.hidden = true;
    $("#viewport").appendChild(this.pane);
    // The timeline pane resizes from its top edge and keeps its height (FR-UI-002).
    this.grip = makeGrip({ key: "motion", axis: "y", sign: -1, def: 240, min: 120, measure: () => this.pane.offsetHeight, max: () => Math.max(160, this.viewer.size.y - 60), apply: px => { this.pane.style.height = px == null ? "" : `${px}px`; this.pane.style.maxHeight = px == null ? "" : "none"; }, label: "Resize the motion study" });
    this.grip.classList.add("mo-grip");
    asm.motion = { open: () => this.show(), rebuilt: () => this.rebuilt(), close: () => this.hide() };
    // Picking a trace point: the click on the view goes to the study, not to the assembly's tools or the orbit controls.
    window.addEventListener("pointerdown", e => {
      if (!this.tracing || e.button !== 0 || e.target !== viewer.renderer.domElement) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.pickTrace(e.clientX, e.clientY);
    }, true);
    viewer.onRender(() => {
      if (this.capture) this.capture(viewer.renderer.domElement);
      const w = this.renderWaiters.splice(0);
      for (const f of w) f();
    });
    this.pane.addEventListener("keydown", e => this.key(e));
    onLangChange(() => { if (this.open) this.render(); });
  }

  // ---------- study ----------

  /** The studies stored in the assembly. */
  private get studies(): MotionStudy[] { return this.asm.doc?.motions ?? []; }

  /** The study shown: a stored one, or a new default one until it is first changed. */
  get study(): MotionStudy {
    return this.studies.find(s => s.id === this.studyId) ?? this.studies[0] ?? { id: "", name: "Motion Study 1", duration: 5, fps: 30, play: "once", tracks: [] };
  }

  /** Changes the shown study as one undo step (storing the default study on its first change). */
  edit(fn: (s: MotionStudy) => void) {
    const cur = this.study;
    let id = cur.id;
    this.asm.changeMotions(d => {
      d.motions ??= [];
      let s = d.motions.find(x => x.id === id);
      if (!s) { s = { ...JSON.parse(JSON.stringify(cur)), id: id = uid("ms_") } as MotionStudy; d.motions.push(s); }
      fn(s);
    });
    this.studyId = id;
    this.time = Math.min(this.time, this.study.duration);
    this.render();
    this.showAt(this.time);
  }

  newStudy() {
    const n = this.studies.length + 1;
    const s: MotionStudy = { id: uid("ms_"), name: `Motion Study ${n}`, duration: 5, fps: 30, play: "once", tracks: [] };
    this.stop();
    this.asm.changeMotions(d => { d.motions ??= []; d.motions.push(s); });
    this.studyId = s.id;
    this.sel = null;
    this.time = 0;
    this.render();
    this.showAt(0);
  }

  deleteStudy() {
    const id = this.study.id;
    this.stop();
    if (id) this.asm.changeMotions(d => { d.motions = (d.motions ?? []).filter(s => s.id !== id); if (!d.motions.length) delete d.motions; });
    this.studyId = this.studies[0]?.id ?? "";
    this.sel = null;
    this.time = 0;
    this.render();
    this.showAt(0);
  }

  /** Mates a key track or a motor can drive. */
  private drivable() {
    const mates = (this.asm.doc?.mates ?? []).filter(m => !m.suppressed);
    return { value: mates.filter(m => VALUE_MATES.has(m.type)), axis: mates.filter(m => AXIS_MATES.has(m.type)) };
  }

  /** Components a placement track can move: top-level ones that no mate holds (the mates would fight it). */
  private movable() {
    const d = this.asm.doc;
    if (!d) return [];
    const held = new Set((d.mates ?? []).filter(m => !m.suppressed).flatMap(m => [m.a.comp, m.b.comp, m.c?.comp, m.d?.comp].filter(Boolean)));
    return d.components.filter(c => !c.suppressed && !held.has(c.id));
  }

  /** A component's own opacity (what an appearance track starts from). */
  private compOpacity(id: string) { return this.asm.doc?.components.find(c => c.id === id)?.opacity ?? 1; }

  addTrack(spec: string) {
    const [kind, ref] = [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)];
    const s = this.study, mate = (this.asm.doc?.mates ?? []).find(m => m.id === ref);
    const tr: Track | null =
      kind === "mate" && mate ? { id: uid("mt_"), kind: "mate", mate: ref, keys: [{ t: 0, v: mate.value ?? 0 }, { t: s.duration, v: mate.value ?? 0 }] }
      : kind === "motor" && mate ? { id: uid("mt_"), kind: "motor", mate: ref, motion: mate.type === "distance" ? "linear" : "rotary", profile: "constant", speed: 10, amp: mate.type === "distance" ? 10 : 30 * DEG, freq: 0.5, start: 0, end: s.duration }
      : kind === "explode" && ref ? { id: uid("mt_"), kind: "explode", view: ref, keys: explodeKeys(s.duration) }
      : kind === "pose" && this.movable().some(c => c.id === ref) ? { id: uid("mt_"), kind: "pose", comp: ref, keys: [{ t: 0, d: [0, 0, 0], r: [0, 0, 0] }, { t: s.duration, d: [0, 0, 0], r: [0, 0, 0] }] }
      : kind === "look" && this.asm.doc?.components.some(c => c.id === ref) ? { id: uid("mt_"), kind: "look", comp: ref, keys: fadeKeys(0, s.duration, false, this.compOpacity(ref)) }
      : kind === "camera" ? { id: uid("mt_"), kind: "camera", keys: [this.camKey(0)] }
      : null;
    if (!tr) return;
    this.edit(st => st.tracks.push(tr));
    this.sel = { track: tr.id, ...(tr.kind === "motor" ? {} : { key: tr.kind === "camera" ? 0 : 1 }) };
    this.render();
  }

  deleteTrack(id: string) {
    if (this.sel?.track === id) this.sel = null;
    this.edit(s => { s.tracks = s.tracks.filter(k => k.id !== id); });
  }

  /** Adds a key at the playhead to a key track with the value it has there now (camera: the current view). */
  addKey(trackId: string, at = this.time) {
    const tr = this.study.tracks.find(k => k.id === trackId);
    if (!tr || tr.kind === "motor") return;
    const tq = this.snap(at);
    let idx = 0;
    this.edit(s => {
      const k = s.tracks.find(x => x.id === trackId)!;
      if (k.kind === "camera") { k.keys = k.keys.filter(x => Math.abs(x.t - tq) > 1e-9); k.keys.push(this.camKey(tq)); k.keys = sortKeys(k.keys); idx = k.keys.findIndex(x => x.t === tq); }
      else if (k.kind === "pose") {
        const p = poseAt(k.keys, tq) ?? { d: [0, 0, 0], r: [0, 0, 0] };
        k.keys = sortKeys([...k.keys.filter(x => Math.abs(x.t - tq) > 1e-9), { t: tq, d: p.d, r: p.r }]);
        idx = k.keys.findIndex(x => x.t === tq);
      }
      else if (k.kind === "mate" || k.kind === "explode" || k.kind === "look") {
        const v = valueAt(k.keys, tq) ?? (k.kind === "mate" ? (this.asm.doc?.mates ?? []).find(m => m.id === k.mate)?.value ?? 0 : k.kind === "look" ? this.compOpacity(k.comp) : 0);
        k.keys = k.keys.filter(x => Math.abs(x.t - tq) > 1e-9);
        k.keys.push({ t: tq, v });
        k.keys = sortKeys(k.keys);
        idx = k.keys.findIndex(x => x.t === tq);
      }
    });
    this.sel = { track: trackId, key: idx };
    this.render();
  }

  private deleteSel() {
    const sel = this.sel;
    if (!sel) return;
    const tr = this.study.tracks.find(k => k.id === sel.track);
    if (!tr) return;
    if (sel.key == null || tr.kind === "motor") { this.deleteTrack(tr.id); return; }
    const ps = this.picked();
    this.sel = null;
    if (ps.length > 1) {
      this.edit(s => { for (const k of s.tracks) if (k.kind !== "motor") (k as { keys: AnyKey[] }).keys = (k.keys as AnyKey[]).filter(x => !ps.some(p => p.track === k.id && same(p.t, x.t))); });
      return;
    }
    this.edit(s => { const k = s.tracks.find(x => x.id === sel.track); if (k && k.kind !== "motor") { const keys = sortKeys(k.keys as Key[]); keys.splice(sel.key!, 1); (k as { keys: unknown[] }).keys = keys; } });
  }

  /** The camera now, as a key at `t`. */
  private camKey(tq: number): CamKey {
    const c = this.viewer.camera, g = this.viewer.controls.target;
    return { t: tq, pos: c.position.toArray() as V3, target: g.toArray() as V3, up: c.up.toArray() as V3, ...("isOrthographicCamera" in c && c.isOrthographicCamera ? { zoom: c.zoom } : {}) };
  }

  /** Animation wizard (SolidWorks): explode or collapse an exploded view, or rotate the model, over the study. */
  wizard(what: "explode" | "collapse" | "orbit") {
    const s = this.study;
    if (what === "orbit") {
      const k = this.camKey(0);
      this.edit(st => { st.tracks = st.tracks.filter(x => x.kind !== "camera"); st.tracks.push({ id: uid("mt_"), kind: "camera", keys: orbitKeys(k.pos, k.target, k.up ?? [0, 0, 1], 0, s.duration) }); });
      return;
    }
    const view = this.asm.exploded ?? this.asm.doc?.explodes?.[0]?.id;
    if (!view) { toast(t("Make an exploded view first (Explode)."), "warn"); return; }
    // Like SolidWorks' animation wizard, several steps run one after another (collapsing goes back in reverse).
    const steps = this.asm.doc?.explodes?.find(v => v.id === view)?.steps.length ?? 0;
    this.edit(st => { st.tracks = st.tracks.filter(x => !(x.kind === "explode" && x.view === view)); st.tracks.push({ id: uid("mt_"), kind: "explode", view, keys: explodeKeys(s.duration, what === "collapse"), ...(steps > 1 ? { seq: true as const } : {}) }); });
  }

  private snap(tq: number) { const s = this.study; return Math.max(0, Math.min(s.duration, Math.round(tq * s.fps) / s.fps)); }

  // ---------- solving ----------

  /** Everything the solved frames depend on. */
  private key0() {
    const d = this.asm.doc, s = this.study;
    return JSON.stringify([s.fps, s.duration, s.tracks.filter(k => (k.kind === "mate" || k.kind === "motor") && !k.off), d?.mates, d?.components.map(c => [c.id, c.tf, c.suppressed, c.fixed, c.subTfs])]);
  }

  /** Solves frames up to `i` (each from the frame before). */
  private ensure(i: number) {
    const key = this.key0();
    if (key !== this.cacheKey) { this.frames = []; this.badFrames.clear(); this.cacheKey = key; }
    const s = this.study, doc = this.asm.doc;
    if (!doc) return;
    const mates = new Map((doc.mates ?? []).map(m => [m.id, m]));
    const rest = this.asm.restTfs();
    const moving = s.tracks.some(k => !k.off && (k.kind === "mate" || k.kind === "motor"));
    while (this.frames.length <= i) {
      const n = this.frames.length;
      if (!moving) { this.frames.push(rest); continue; }
      const f = frameAt(s, n / s.fps, mates);
      const extra: Mate[] = [];
      for (const a of f.axis) {
        const m = mates.get(a.mate)!, g = this.asm.localGeo(m.a);
        const ta = rest[m.a.comp], tb = rest[m.b.comp];
        if (!g || g.k !== "axis" || !ta || !tb) continue;
        extra.push(axisLock(m, g, compose(invert(ta), tb), a.motion, a.amount));
      }
      const r = this.asm.motionSolve(f.values, extra, n ? this.frames[n - 1] : undefined);
      if (!r.ok) this.badFrames.add(n);
      this.frames.push(r.tfs);
    }
  }

  /** Poses the view at study time `tq` (mates, exploded views, camera). */
  showAt(tq: number) {
    if (!this.open || !this.asm.doc) return;
    const s = this.study, i = Math.min(frameCount(s) - 1, Math.max(0, Math.round(tq * s.fps)));
    this.ensure(i);
    const f = frameAt(s, tq, new Map((this.asm.doc.mates ?? []).map(m => [m.id, m])));
    const tfs = this.tfsAt(i, tq);
    this.asm.motionShow(tfs, f.explode);
    this.syncTraces(i);
    this.asm.motionLook(f.look);
    if (f.camera) this.setCamera(f.camera);
    this.viewer.invalidate();
    this.updateHead(i);
  }

  /** Component transforms at frame `i` (time `tq`): the solved frame with placement keys applied. */
  private tfsAt(i: number, tq = i / this.study.fps): Record<string, Tf> {
    const s = this.study;
    let tfs = this.frames[i] ?? this.asm.restTfs();
    const f = frameAt(s, tq, new Map((this.asm.doc?.mates ?? []).map(m => [m.id, m])));
    if (Object.keys(f.pose).length) {
      const rest = this.asm.restTfs();
      tfs = { ...tfs };
      for (const [id, p] of Object.entries(f.pose)) if (rest[id]) tfs[id] = posed(rest[id], p);
    }
    return tfs;
  }

  // ---------- interference (Results → Interference Detection) ----------

  /** What an interference check depends on: the solved frames, placement and explode keys. */
  private clashKey() {
    return JSON.stringify([this.key0(), this.study.tracks.filter(k => (k.kind === "pose" || k.kind === "explode") && !k.off), this.clashAll]);
  }

  /** Poses every frame and lists the pairs of components that enter one another, with when; shows them in the panel. */
  checkInterference(): ClashItem[] {
    const s = this.study, n = frameCount(s), doc = this.asm.doc;
    if (!doc) return [];
    this.ensure(n - 1);
    const mates = new Map((doc.mates ?? []).map(m => [m.id, m]));
    const per: [string, string][][] = [];
    for (let k = 0; k < n; k++) {
      this.asm.motionShow(this.tfsAt(k), frameAt(s, k / s.fps, mates).explode);
      per.push(this.asm.motionClashes());
    }
    // Pairs touching at the start (a pin in its hole, faces mated together) are left out unless asked for.
    const ignore = this.clashAll ? new Set<string>() : new Set(per[0].map(([a, b]) => pairKey(a, b)));
    const items = clashItems(per, s.fps, ignore);
    this.clash = { study: s.id, key: this.clashKey(), items, ignored: ignore.size };
    this.sel = null;
    this.selTrace = null;
    this.clashOpen = true;
    this.render();
    this.showAt(this.time);
    return items;
  }

  private compName(id: string) { return this.asm.doc?.components.find(c => c.id === id)?.name ?? id; }

  /** Red bands along the bottom of the ruler where anything interferes (from the last check). */
  private clashLane(): string {
    const c = this.clash;
    if (!c?.items.length || c.study !== this.study.id) return "";
    const spans = c.items.flatMap(it => it.spans), f = 1 / this.study.fps;
    return spans.map(([a, b]) => `<span class="mo-cspan" aria-hidden="true" style="left:${this.x(a)};width:calc(${this.x(Math.min(this.study.duration, b + f) - a)})"></span>`).join("");
  }

  private clashProps(): string {
    const c = this.clash!, stale = c.key !== this.clashKey();
    const rows = c.items.map(it => `<li class="mo-clash"><span translate="no">${esc(this.compName(it.a))} ↔ ${esc(this.compName(it.b))}</span> `
      + it.spans.map(([a, b]) => `<button class="btn small" data-clt="${a}" title="${esc(t("Go to {t} s", { t: fmt(a) }))}">${esc(a === b ? `${fmt(a)} ${t("s")}` : `${fmt(a)}–${fmt(b)} ${t("s")}`)}</button>`).join(" ") + `</li>`).join("");
    return `<strong>${esc(t("Interference"))}</strong> `
      + `<span class="muted">${esc(c.items.length ? t("{n} pairs of components interfere.", { n: c.items.length }) : t("No interference found."))}${c.ignored ? " " + esc(t("{n} pairs touching at the start left out.", { n: c.ignored })) : ""}${stale ? " " + esc(t("The study changed since the check.")) : ""}</span>`
      + `<label class="mo-f"><input type="checkbox" data-mo="clashall"${this.clashAll ? " checked" : ""} /><span>${esc(t("Treat coincidence as interference"))}</span></label>`
      + `<label class="mo-f" title="${esc(t("Pause playback where an interference starts"))}"><input type="checkbox" data-mo="clashstop"${this.clashStop ? " checked" : ""} /><span>${esc(t("Stop playback"))}</span></label>`
      + `<button class="btn small" data-mo="clash">${esc(t("Check again"))}</button>`
      + (c.items.length ? `<button class="btn small" data-mo="clashcsv" title="${esc(t("Save the interfering pairs and times as CSV"))}">CSV</button>` : "")
      + `<button class="btn small" data-mo="clashclose">${esc(t("Close"))}</button>`
      + (rows ? `<ul class="mo-clashes">${rows}</ul>` : "");
  }

  // ---------- trace paths (Results → Trace Path) ----------

  private get traces(): TracePath[] { return this.study.traces ?? []; }

  /** Starts picking a point to trace: the next click on a component in the view (Esc cancels). */
  startTrace() {
    this.tracing = true;
    this.setStatus(t("Click a point on a moving component to trace its path (Esc cancels)."));
    this.viewer.renderer.domElement.style.cursor = "crosshair";
  }

  private stopTracing() {
    this.tracing = false;
    this.viewer.renderer.domElement.style.cursor = "";
    this.setStatus("");
  }

  /** The click while picking: the component under it and the point in that component's coordinates at the shown frame. */
  pickTrace(x: number, y: number): boolean {
    const hit = this.asm.shownAt(x, y);
    const i = Math.round(this.time * this.study.fps), tfs = this.tfsAt(i, this.time);
    const comp = hit && (tfs[hit.id] ? hit.id : tfs[hit.top] ? hit.top : null);
    if (!hit || !comp) { toast(t("Click a component that moves in the study."), "warn"); return false; }
    this.stopTracing();
    this.addTrace(comp, applyPoint(invert(tfs[comp]), hit.point));
    return true;
  }

  /** Adds a trace path of point `p` (component coordinates) on `comp` and selects it. */
  addTrace(comp: string, p: V3) {
    const id = uid("tr_"), color = TRACE_COLORS[this.traces.length % TRACE_COLORS.length];
    this.edit(st => { (st.traces ??= []).push({ id, comp, p: [p[0], p[1], p[2]], color }); });
    this.sel = null;
    this.selTrace = id;
    this.render();
    this.showAt(this.time);
  }

  /** Adds a mate value result (Results → Plot of a mate's distance or angle) and selects it. */
  addMatePlot(mate: string) {
    const m = (this.asm.doc?.mates ?? []).find(k => k.id === mate);
    if (!m) return;
    const id = uid("tr_"), color = TRACE_COLORS[this.traces.length % TRACE_COLORS.length];
    const angular = m.type === "angle" || m.type === "limitangle" || m.type === "gear" || m.type === "hinge";
    this.edit(st => { (st.traces ??= []).push({ id, comp: "", mate, p: [0, 0, 0], color, plot: angular ? "angle" : "dist" }); });
    this.sel = null;
    this.selTrace = id;
    this.render();
    this.showAt(this.time);
  }

  /** A mate value result's distance (mm) and angle (degrees) over the whole study. */
  mateValues(id: string): { dist: number[]; angle: number[] } {
    this.tracePath(id);
    return this.mateVals.get(id) ?? { dist: [], angle: [] };
  }

  deleteTrace(id: string) {
    this.edit(st => { st.traces = (st.traces ?? []).filter(x => x.id !== id); if (!st.traces.length) delete st.traces; });
    if (this.selTrace === id) this.selTrace = null;
    this.render();
    this.showAt(this.time);
  }

  private setTrace(id: string, fn: (x: TracePath) => void) {
    this.edit(st => { const x = st.traces?.find(k => k.id === id); if (x) fn(x); });
    this.render();
    this.showAt(this.time);
  }

  /** A trace's points over the whole study (every frame solved). */
  /** A trace's component angle (degrees from the start, unwrapped) over the whole study. */
  traceAngle(id: string): number[] {
    this.tracePath(id);
    return this.traceAng.get(id) ?? [];
  }

  tracePath(id: string): V3[] {
    this.ensure(frameCount(this.study) - 1);
    this.syncTraces(Math.round(this.time * this.study.fps));
    return this.tracePts.get(id) ?? [];
  }

  /** Draws the paths (solving every frame once when the study or the traces change) and moves the markers to frame `i`. */
  private syncTraces(i: number) {
    const tr = this.traces, g = this.traceGroup;
    if (!tr.length || !this.open) { if (g.parent) g.removeFromParent(); this.traceKey = ""; this.tracePts.clear(); this.traceAng.clear(); this.mateVals.clear(); this.gapVals.clear(); return; }
    const s = this.study, n = frameCount(s);
    const key = JSON.stringify([this.key0(), s.tracks.filter(k => k.kind === "pose" && !k.off), tr]);
    if (key !== this.traceKey) {
      this.ensure(n - 1);
      this.traceKey = key;
      this.tracePts.clear();
      this.traceAng.clear();
      this.mateVals.clear();
      this.gapVals.clear();
      for (const c of [...g.children]) {
        c.removeFromParent();
        c.traverse(o => { const m = o as THREE.Line; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
      }
      const all: Record<string, Tf>[] = [];
      for (let k = 0; k < n; k++) all.push(this.tfsAt(k));
      const mates = new Map((this.asm.doc?.mates ?? []).map(m => [m.id, m]));
      // Proximity: pose every frame and measure the gap between the two components, then show frame i again.
      const gaps = tr.filter(x => x.gap);
      if (gaps.length) {
        for (const x of gaps) this.gapVals.set(x.id, []);
        for (let k = 0; k < n; k++) {
          this.asm.motionShow(all[k], frameAt(s, k / s.fps, mates).explode);
          for (const x of gaps) this.gapVals.get(x.id)!.push(this.asm.motionGap(x.gap![0], x.gap![1]));
        }
        this.asm.motionShow(this.tfsAt(i), frameAt(s, i / s.fps, mates).explode);
      }
      for (const x of tr) {
        if (x.gap) {
          // A line between the nearest points, moved every frame.
          const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
          const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: x.color, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true }));
          line.renderOrder = 998;
          line.userData.gapLine = x.id;
          const sub = new THREE.Group();
          sub.userData.trace = x.id;
          sub.matrixAutoUpdate = false;
          sub.add(line);
          g.add(sub);
          continue;
        }
        if (x.mate) {
          const m = mates.get(x.mate), ga = m && this.asm.localGeo(m.a), gb = m && this.asm.localGeo(m.b);
          this.mateVals.set(x.id, m && ga && gb ? mateMeasures(all, m.a.comp, m.b.comp, ga, gb) : { dist: [], angle: [] });
          continue;
        }
        // Relative to a component: the path is kept in its coordinates and drawn in a group that moves with it.
        const fr = x.rel ? relativeFrames(all, x.rel) : all, pts = tracePoints(fr, x.comp, x.p);
        this.tracePts.set(x.id, pts);
        this.traceAng.set(x.id, traceAngles(fr, x.comp));
        if (x.off || pts.length < 1) continue;
        const geo = new THREE.BufferGeometry().setFromPoints(pts.map(q => new THREE.Vector3(q[0], q[1], q[2])));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: x.color, depthTest: false, transparent: true }));
        line.renderOrder = 998;
        line.userData.trace = x.id;
        const dot = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3)),
          new THREE.PointsMaterial({ color: x.color, size: x.id === this.selTrace ? 9 : 7, sizeAttenuation: false, depthTest: false, transparent: true }));
        dot.renderOrder = 999;
        dot.userData.dot = x.id;
        const sub = new THREE.Group();
        sub.userData.trace = x.id;
        sub.userData.rel = x.rel;
        sub.matrixAutoUpdate = false;
        sub.add(line, dot);
        g.add(sub);
      }
      this.alertHtml.clear();
      for (const x of tr) {
        if (!x.alert) continue;
        const f = 1 / s.fps;
        this.alertHtml.set(x.id, alertSpans(this.seriesOf(x), s.fps, x.alert).map(([a, b]) =>
          `<span class="mo-aspan" aria-hidden="true" style="left:${this.x(a)};width:calc(${this.x(Math.min(s.duration, b + f) - a)})"></span>`).join(""));
      }
    }
    for (const lane of this.pane.querySelectorAll<HTMLElement>(".mo-tlane[data-tlane]")) {
      const h = this.alertHtml.get(lane.dataset.tlane!) ?? "";
      if (lane.dataset.ah !== h) { lane.innerHTML = h; lane.dataset.ah = h; }
    }
    if (!g.parent) this.viewer.scene.add(g);
    const now = tr.some(x => x.rel) ? this.tfsAt(i) : null;
    for (const sub of g.children) {
      const rel = sub.userData.rel as string | undefined, r = rel && now?.[rel];
      sub.matrix.copy(r ? tfMatrix(r) : new THREE.Matrix4());
      sub.matrixWorldNeedsUpdate = true;
      for (const c of sub.children) {
        const id = c.userData.dot as string | undefined, pts = id ? this.tracePts.get(id) : null;
        if (pts?.length) { const q = pts[Math.min(pts.length - 1, Math.max(0, i))]; c.position.set(q[0], q[1], q[2]); }
        const gid = c.userData.gapLine as string | undefined, gx = gid ? tr.find(x => x.id === gid) : null;
        if (gx?.gap) {
          const r = this.asm.motionGapPts(gx.gap[0], gx.gap[1]), line = c as THREE.Line;
          line.visible = !!r && r.d > 1e-6;
          if (r) {
            const a = line.geometry.getAttribute("position") as THREE.BufferAttribute;
            a.setXYZ(0, ...r.p[0]); a.setXYZ(1, ...r.p[1]); a.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.computeLineDistances();
          }
        }
      }
    }
    this.updatePlot(i);
  }

  /** Moves the plot's playhead line and the readout under it (no re-render while playing). */
  private updatePlot(i: number) {
    const x = this.traces.find(k => k.id === this.selTrace), box = this.pane.querySelector<HTMLElement>(".mo-trace-plot");
    if (!x || !box) return;
    box.innerHTML = this.plotHtml(x, i);
  }

  private plotHtml(x: TracePath, i: number): string {
    const body = this.plotBody(x, i);
    if (!x.alert || !body) return body;
    const v = this.seriesOf(x), j = Math.min(v.length - 1, Math.max(0, i));
    return body + (j >= 0 && outOfRange([v[j]], x.alert)[0] ? `<span class="mo-alert" role="status">${esc(t("Out of range"))}</span>` : "");
  }

  /** The plotted quantity of a trace or mate value result at every frame (as its plot shows it). */
  private seriesOf(x: TracePath): number[] {
    const q = (x.plot ?? "dist") as TracePlot, fps = this.study.fps;
    if (x.gap) { const v = this.gapVals.get(x.id) ?? []; return q === "speed" ? rates(v, fps) : v; }
    if (x.mate) {
      const mv = this.mateVals.get(x.id);
      if (!mv?.dist.length) return [];
      return q === "speed" ? rates(mv.dist, fps) : q === "angle" ? mv.angle : q === "aspeed" ? rates(mv.angle, fps) : mv.dist;
    }
    const pts = this.tracePts.get(x.id) ?? [];
    return pts.length ? traceSeries(pts, fps, q, this.traceAng.get(x.id) ?? []) : [];
  }

  /** A sensor's out-of-range spans as [first, last] times (s), every frame solved. */
  alertSpansOf(id: string): [number, number][] {
    this.tracePath(id);
    const x = this.traces.find(k => k.id === id);
    return x?.alert ? alertSpans(this.seriesOf(x), this.study.fps, x.alert) : [];
  }

  /** The earliest frame in (i0, i1] where a stopping sensor trips. */
  private tripAt(i0: number, i1: number): { i: number; x?: TracePath } | null {
    let best: { i: number; x?: TracePath } | null = null;
    for (const k of this.clashStarts()) if (k > i0 && k <= i1 && (!best || k < best.i)) best = { i: k };
    for (const x of this.traces) {
      if (!x.alert?.stop) continue;
      const k = tripFrame(this.seriesOf(x), x.alert, i0, i1);
      if (k >= 0 && (!best || k < best.i)) best = { i: k, x };
    }
    return best;
  }

  /** Frames where an interference starts, when playback should stop there (the last check is for this study and still current). */
  private clashStarts(): number[] {
    const c = this.clash;
    if (!this.clashStop || !c || c.study !== this.study.id || c.key !== this.clashKey()) return [];
    return c.items.flatMap(it => it.spans.map(([a]) => Math.round(a * this.study.fps)));
  }

  /** The selected result's plot as a stand-alone SVG file, titled with its name and plotted quantity. */
  plotSvgFile(x: TracePath): string {
    const svg = /<svg[\s\S]*<\/svg>/.exec(this.plotBody(x, Math.round(this.time * this.study.fps)))?.[0] ?? "";
    const label = /aria-label="([^"]*)"/.exec(svg)?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") ?? "";
    return plotFile(svg, `${this.study.name}: ${label}`);
  }

  private plotBody(x: TracePath, i: number): string {
    if (x.gap) return this.gapPlotHtml(x, i);
    if (x.mate) return this.matePlotHtml(x, i);
    const pts = this.tracePts.get(x.id) ?? [], s = this.study, q = (x.plot ?? "dist") as TracePlot;
    if (!pts.length) return "";
    const ang = this.traceAng.get(x.id) ?? [], vals = traceSeries(pts, s.fps, q, ang), j = Math.min(pts.length - 1, Math.max(0, i)), p = pts[j];
    const unit = t(plotUnit(q)), label = t(TRACE_PLOTS.find(([k]) => k === q)?.[1] ?? "Distance from start");
    const read = q === "angle" || q === "aspeed"
      ? t("At {t} s: angle {a}°; angular speed {w}°/s", { t: fmt(j / s.fps), a: fmt(ang[j] ?? 0), w: fmt(rates(ang, s.fps)[j] ?? 0) })
      : t("At {t} s: X {x}, Y {y}, Z {z} mm; speed {v} mm/s", { t: fmt(j / s.fps), x: fmt(p[0]), y: fmt(p[1]), z: fmt(p[2]), v: fmt(speeds(pts, s.fps)[j]) })
        + (q === "accel" ? " " + t("acceleration {a} mm/s²", { a: fmt(accels(pts, s.fps)[j]) }) : "");
    return plotSvg(vals, s.fps, this.time, unit, x.color, esc(label)) + `<span class="mo-tread muted">${esc(read)}</span>`;
  }

  private gapPlotHtml(x: TracePath, i: number): string {
    const v = this.gapVals.get(x.id) ?? [], s = this.study, q = (x.plot ?? "dist") as TracePlot;
    if (!v.length || v.some(d => !Number.isFinite(d))) return `<span class="muted">${esc(t("The components are not shown."))}</span>`;
    const j = Math.min(v.length - 1, Math.max(0, i)), r = rates(v, s.fps);
    const label = t(GAP_PLOTS.find(([k]) => k === q)?.[1] ?? "Distance");
    const read = t("At {t} s: distance {d} mm ({v} mm/s)", { t: fmt(j / s.fps), d: fmt(v[j]), v: fmt(r[j]) });
    return plotSvg(q === "speed" ? r : v, s.fps, this.time, t(plotUnit(q)), x.color, esc(label)) + `<span class="mo-tread muted">${esc(read)}</span>`;
  }

  /** A proximity result's smallest distance (mm) per frame, every frame solved. */
  gapValues(id: string): number[] {
    this.tracePath(id);
    return this.gapVals.get(id) ?? [];
  }

  /** Adds a proximity result between two top-level components (the first two shown; the panel changes them). */
  addGap(a?: string, b?: string) {
    const comps = (this.asm.doc?.components ?? []).filter(c => !c.suppressed);
    a ??= comps[0]?.id; b ??= comps.find(c => c.id !== a)?.id;
    if (!a || !b) { toast(t("A proximity result needs two components.")); return; }
    const id = uid("tr_"), color = TRACE_COLORS[this.traces.length % TRACE_COLORS.length];
    this.edit(st => { (st.traces ??= []).push({ id, comp: "", gap: [a!, b!], p: [0, 0, 0], color }); });
    this.sel = null;
    this.selTrace = id;
    this.render();
    this.showAt(this.time);
  }

  private matePlotHtml(x: TracePath, i: number): string {
    const mv = this.mateVals.get(x.id), s = this.study, q = (x.plot ?? "dist") as TracePlot;
    if (!mv?.dist.length) return `<span class="muted">${esc(t("The mate's references are not available."))}</span>`;
    const j = Math.min(mv.dist.length - 1, Math.max(0, i)), dr = rates(mv.dist, s.fps), ar = rates(mv.angle, s.fps);
    const vals = q === "speed" ? dr : q === "angle" ? mv.angle : q === "aspeed" ? ar : mv.dist;
    const label = t(MATE_PLOTS.find(([k]) => k === q)?.[1] ?? "Distance");
    const read = t("At {t} s: distance {d} mm ({v} mm/s); angle {a}° ({w}°/s)", { t: fmt(j / s.fps), d: fmt(mv.dist[j]), v: fmt(dr[j]), a: fmt(mv.angle[j]), w: fmt(ar[j]) });
    return plotSvg(vals, s.fps, this.time, t(plotUnit(q)), x.color, esc(label)) + `<span class="mo-tread muted">${esc(read)}</span>`;
  }

  private traceProps(x: TracePath): string {
    if (x.gap) {
      const i = Math.round(this.time * this.study.fps), comps = (this.asm.doc?.components ?? []).filter(c => !c.suppressed);
      const sel = (k: "ga" | "gb", l: string, v: string) => `<label class="mo-f"><span>${esc(t(l))}</span><select data-tr="${k}">`
        + comps.map(c => `<option value="${esc(c.id)}" translate="no"${c.id === v ? " selected" : ""}>${esc(c.name)}</option>`).join("") + `</select></label>`;
      return sel("ga", "Component 1", x.gap[0]) + sel("gb", "Component 2", x.gap[1])
        + `<label class="mo-f"><span>${esc(t("Plot"))}</span><select data-tr="plot">${GAP_PLOTS.map(([k, l]) => `<option value="${k}"${(x.plot ?? "dist") === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`
        + `<label class="mo-f"><span>${esc(t("Colour"))}</span><input type="color" data-tr="color" value="${esc(x.color)}" /></label>`
        + this.alertFields(x)
        + `<button class="btn small" data-tr="csv" title="${esc(t("Save the distances as CSV (time, distance)"))}">CSV</button>`
        + `<button class="btn small" data-tr="svg" title="${esc(t("Save the plot as an SVG image"))}">SVG</button>`
        + `<button class="btn small" data-tr="del">${esc(t("Delete"))}</button>`
        + `<div class="mo-trace-plot">${this.plotHtml(x, i)}</div>`;
    }
    if (x.mate) {
      const i = Math.round(this.time * this.study.fps);
      return `<label class="mo-f"><span>${esc(t("Plot"))}</span><select data-tr="plot">${MATE_PLOTS.map(([k, l]) => `<option value="${k}"${(x.plot ?? "dist") === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`
        + `<label class="mo-f"><span>${esc(t("Colour"))}</span><input type="color" data-tr="color" value="${esc(x.color)}" /></label>`
        + this.alertFields(x)
        + `<button class="btn small" data-tr="csv" title="${esc(t("Save the values as CSV (time, distance, angle)"))}">CSV</button>`
        + `<button class="btn small" data-tr="svg" title="${esc(t("Save the plot as an SVG image"))}">SVG</button>`
        + `<button class="btn small" data-tr="del">${esc(t("Delete"))}</button>`
        + `<div class="mo-trace-plot">${this.plotHtml(x, i)}</div>`;
    }
    const pts = this.tracePts.get(x.id) ?? [], i = Math.round(this.time * this.study.fps);
    return `<label class="mo-f"><span>${esc(t("Plot"))}</span><select data-tr="plot">${TRACE_PLOTS.map(([k, l]) => `<option value="${k}"${(x.plot ?? "dist") === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`
      + this.relField(x)
      + `<label class="mo-f"><span>${esc(t("Colour"))}</span><input type="color" data-tr="color" value="${esc(x.color)}" /></label>`
      + `<span class="muted">${esc(t("Path length {l} mm", { l: fmt(pathLength(pts)) }))}</span>`
      + this.alertFields(x)
      + `<button class="btn small" data-tr="csv" title="${esc(t("Save the path as CSV (time, X, Y, Z, speed, acceleration, angle)"))}">CSV</button>`
        + `<button class="btn small" data-tr="svg" title="${esc(t("Save the plot as an SVG image"))}">SVG</button>`
      + `<button class="btn small" data-tr="del">${esc(t("Delete"))}</button>`
      + `<div class="mo-trace-plot">${this.plotHtml(x, i)}</div>`;
  }

  /** Sensor limits on the plotted quantity (empty = no limit) and whether playback stops where it trips. */
  private alertFields(x: TracePath): string {
    const a = x.alert ?? {}, u = t(plotUnit((x.plot ?? "dist") as TracePlot));
    const f = (k: "amin" | "amax", l: string, v?: number) => `<label class="mo-f"><span>${esc(t(l))} (${esc(u)})</span><input type="number" step="any" data-tr="${k}" value="${v ?? ""}" placeholder="${esc(t("none"))}" /></label>`;
    return f("amin", "Alert below", a.min) + f("amax", "Alert above", a.max)
      + `<label class="mo-f" title="${esc(t("Pause playback where the value goes out of range"))}"><input type="checkbox" data-tr="astop"${a.stop ? " checked" : ""} /><span>${esc(t("Stop playback"))}</span></label>`;
  }

  /** "Relative to": world, or another top-level component the path is seen from (it then moves with that component). */
  private relField(x: TracePath): string {
    const own = x.comp.split("/")[0], comps = (this.asm.doc?.components ?? []).filter(c => !c.suppressed && c.id !== own);
    return `<label class="mo-f"><span>${esc(t("Relative to"))}</span><select data-tr="rel"><option value="">${esc(t("World"))}</option>`
      + comps.map(c => `<option value="${esc(c.id)}" translate="no"${x.rel === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("") + `</select></label>`;
  }

  private setCamera(k: CamKey) {
    const c = this.viewer.camera;
    if (k.up) c.up.set(k.up[0], k.up[1], k.up[2]);
    this.viewer.controls.target.set(k.target[0], k.target[1], k.target[2]);
    c.position.set(k.pos[0], k.pos[1], k.pos[2]);
    c.lookAt(this.viewer.controls.target);
    if ("isOrthographicCamera" in c && c.isOrthographicCamera && k.zoom && Math.abs(c.zoom - k.zoom) > 1e-9) { c.zoom = k.zoom; c.updateProjectionMatrix(); }
  }

  // ---------- playback ----------

  play() {
    if (this.playing) { this.pause(); return; }
    const s = this.study;
    if ((s.play ?? "once") === "once" && this.time >= s.duration - 1e-9) this.time = 0;
    this.playing = true;
    this.playStart = performance.now();
    this.playFrom = this.time;
    const stopper = this.traces.find(x => x.alert?.stop);
    if (stopper) this.tracePath(stopper.id);
    const sensors = !!stopper || this.clashStarts().length > 0;
    let last = Math.round(this.time * s.fps);
    const step = () => {
      if (!this.playing) return;
      const p = playTime(this.playFrom + ((performance.now() - this.playStart) / 1000) * this.speed, this.study);
      const i = Math.round(p.t * this.study.fps), trip = sensors && i > last ? this.tripAt(last, i) : null;
      last = i;
      if (trip) {
        this.time = trip.i / this.study.fps;
        this.showAt(this.time);
        this.pause();
        toast(trip.x ? t("Sensor tripped at {t} s", { t: fmt(this.time) }) : t("Interference at {t} s", { t: fmt(this.time) }));
        return;
      }
      this.time = p.t;
      this.showAt(p.t);
      if (p.done) { this.pause(); return; }
      this.raf = requestAnimationFrame(step);
    };
    this.renderTransport();
    step();
  }

  pause() { this.playing = false; cancelAnimationFrame(this.raf); this.renderTransport(); }
  stop() { this.pause(); this.time = 0; this.showAt(0); }
  seek(tq: number) { this.pause(); this.time = Math.max(0, Math.min(this.study.duration, tq)); this.showAt(this.time); }

  // ---------- recording ----------

  /** Draws the rendered view onto a canvas of at most `maxW` pixels wide, on the viewport's background. */
  private composer(maxW: number) {
    const src = this.viewer.renderer.domElement, k = Math.min(1, maxW / src.width);
    const out = document.createElement("canvas");
    out.width = Math.max(2, Math.round((src.width * k) / 2) * 2);
    out.height = Math.max(2, Math.round((src.height * k) / 2) * 2);
    const g = out.getContext("2d", { willReadFrequently: true })!;
    const css = getComputedStyle(document.documentElement);
    const top = css.getPropertyValue("--vp-top").trim() || "#ffffff", bottom = css.getPropertyValue("--vp-bottom").trim() || top;
    const draw = (from: HTMLCanvasElement) => {
      const gr = g.createLinearGradient(0, 0, 0, out.height);
      gr.addColorStop(0, top); gr.addColorStop(1, bottom);
      g.fillStyle = gr;
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(from, 0, 0, out.width, out.height);
    };
    return { out, g, draw };
  }

  private nextRender() { return new Promise<void>(res => { this.renderWaiters.push(res); this.viewer.invalidate(); }); }

  /** Records the study once through as a WebM video in real time (FR-FT-122). */
  async recordWebm(): Promise<Blob | null> {
    if (this.recording || !this.asm.doc) return null;
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(m => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mime) { toast(t("This browser cannot record video; save a GIF instead."), true); return null; }
    const s = this.study;
    this.pause();
    this.ensure(frameCount(s) - 1);
    const c = this.composer(1920), stream = c.out.captureStream(0), track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>(res => { rec.onstop = () => res(); });
    this.recording = "webm";
    this.renderTransport();
    this.capture = from => { c.draw(from); track.requestFrame?.(); };
    rec.start();
    const t0 = performance.now();
    await new Promise<void>(res => {
      const step = () => {
        if (!this.recording) { res(); return; }
        const tq = Math.min(s.duration, (performance.now() - t0) / 1000);
        this.time = tq;
        this.showAt(tq);
        if (tq >= s.duration) { void this.nextRender().then(() => res()); return; }
        this.raf = requestAnimationFrame(step);
      };
      step();
    });
    this.capture = null;
    rec.stop();
    await done;
    this.recording = null;
    this.renderTransport();
    const blob = new Blob(chunks, { type: "video/webm" });
    download(blob, `${this.fileBase()}.webm`);
    return blob;
  }

  /** Renders every frame (at most 15 per second, 480 px wide) and saves an animated GIF. */
  async recordGif(maxW = 480): Promise<Blob | null> {
    if (this.recording || !this.asm.doc) return null;
    const s = this.study, fps = Math.min(15, s.fps), n = Math.max(1, Math.round(s.duration * fps)) + 1;
    this.pause();
    this.recording = "gif";
    this.renderTransport();
    const c = this.composer(maxW), frames: Uint8ClampedArray[] = [];
    this.capture = from => { c.draw(from); frames.push(c.g.getImageData(0, 0, c.out.width, c.out.height).data); };
    try {
      for (let i = 0; i < n && this.recording; i++) {
        this.time = Math.min(s.duration, i / fps);
        this.showAt(this.time);
        await this.nextRender();
        this.setStatus(t("Recording frame {i} of {n}…", { i: i + 1, n }));
      }
    } finally { this.capture = null; }
    if (!this.recording) { this.renderTransport(); return null; }
    this.setStatus(t("Writing the GIF…"));
    await new Promise(r => setTimeout(r, 0));
    const bytes = encodeGif(frames, c.out.width, c.out.height, 100 / fps);
    this.recording = null;
    this.renderTransport();
    const blob = new Blob([bytes], { type: "image/gif" });
    download(blob, `${this.fileBase()}.gif`);
    return blob;
  }

  /** Renders every frame of the study at its own frame rate (up to `maxW` px wide) and saves them as numbered PNG images in a ZIP. */
  async recordFrames(maxW = 1920): Promise<Blob | null> {
    if (this.recording || !this.asm.doc) return null;
    const s = this.study, times = frameTimes(s.duration, s.fps), n = times.length, base = this.fileBase();
    this.pause();
    this.ensure(frameCount(s) - 1);
    this.recording = "png";
    this.renderTransport();
    const c = this.composer(maxW), shots: Promise<Blob | null>[] = [];
    this.capture = from => { c.draw(from); shots.push(new Promise(res => c.out.toBlob(res, "image/png"))); };
    try {
      for (let i = 0; i < n && this.recording; i++) {
        this.time = times[i];
        this.showAt(this.time);
        await this.nextRender();
        this.setStatus(t("Recording frame {i} of {n}…", { i: i + 1, n }));
      }
    } finally { this.capture = null; }
    if (!this.recording) { this.renderTransport(); return null; }
    this.setStatus(t("Writing the ZIP…"));
    const blobs = await Promise.all(shots);
    const files: { name: string; data: Uint8Array }[] = [];
    for (let i = 0; i < blobs.length; i++) if (blobs[i]) files.push({ name: frameName(base, i, n), data: new Uint8Array(await blobs[i]!.arrayBuffer()) });
    const bytes = await zip(files);
    this.recording = null;
    this.renderTransport();
    this.setStatus("");
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    download(blob, `${base}-frames.zip`);
    return blob;
  }

  private fileBase() { return `${this.asm.doc?.name ?? "Assembly"}-${this.study.name}`.replace(/[\\/:*?"<>|]+/g, "_"); }

  // ---------- pane ----------

  show() {
    if (this.open) { this.hide(); return; }
    if (!this.asm.doc) return;
    this.asm.closeTools();
    this.open = true;
    this.pane.hidden = false;
    document.getElementById("app")?.classList.add("motion-on");
    if (!this.studies.some(s => s.id === this.studyId)) this.studyId = this.studies[0]?.id ?? "";
    this.time = 0;
    this.sel = null;
    this.render();
    this.showAt(0);
    this.viewer.invalidate();
  }

  hide() {
    if (!this.open) return;
    this.recording = null;
    this.capture = null;
    this.pause();
    this.open = false;
    this.pane.hidden = true;
    document.getElementById("app")?.classList.remove("motion-on");
    this.frames = [];
    this.cacheKey = "";
    if (this.tracing) this.stopTracing();
    this.syncTraces(0);
    this.viewer.invalidate();
    if (this.asm.doc) this.asm.motionRestore();
  }

  private rebuilt() {
    if (!this.open) return;
    if (!this.asm.doc) { this.hide(); return; }
    if (this.studyId && !this.studies.some(s => s.id === this.studyId)) this.studyId = this.studies[0]?.id ?? "";
    this.frames = [];
    this.cacheKey = "";
    this.render();
    this.showAt(this.time);
  }

  private trackLabel(k: Track): { icon: string; kind: string; name: string } {
    const mate = k.kind === "mate" || k.kind === "motor" ? (this.asm.doc?.mates ?? []).find(m => m.id === k.mate) : null;
    if (k.kind === "mate") return { icon: "◆", kind: t("Mate keys"), name: mate?.name ?? "?" };
    if (k.kind === "motor") return { icon: k.motion === "rotary" ? "⟳" : "⇄", kind: k.motion === "rotary" ? t("Rotary motor") : t("Linear motor"), name: mate?.name ?? "?" };
    if (k.kind === "explode") return { icon: "✸", kind: t("Explode"), name: this.asm.doc?.explodes?.find(v => v.id === k.view)?.name ?? "?" };
    if (k.kind === "pose") return { icon: "✥", kind: t("Placement"), name: this.asm.doc?.components.find(c => c.id === k.comp)?.name ?? "?" };
    if (k.kind === "look") return { icon: "◐", kind: t("Appearance"), name: this.asm.doc?.components.find(c => c.id === k.comp)?.name ?? "?" };
    return { icon: "◉", kind: t("Camera"), name: "" };
  }

  private x(tq: number) { return `${(100 * tq) / Math.max(1e-6, this.study.duration)}%`; }

  render() {
    if (!this.open || !this.asm.doc) return;
    const s = this.study, doc = this.asm.doc, dr = this.drivable();
    const studyOpts = (this.studies.length ? this.studies : [s]).map(x => `<option value="${esc(x.id)}"${x.id === s.id ? " selected" : ""} translate="no">${esc(x.name)}</option>`).join("");
    const addOpts = [`<option value="">${esc(t("Add track…"))}</option>`,
      ...dr.value.map(m => `<option value="mate:${esc(m.id)}" translate="no">${esc(t("Mate keys"))}: ${esc(m.name)}</option>`),
      ...[...dr.value, ...dr.axis].map(m => `<option value="motor:${esc(m.id)}" translate="no">${esc(t("Motor"))}: ${esc(m.name)}</option>`),
      ...(doc.explodes ?? []).map(v => `<option value="explode:${esc(v.id)}" translate="no">${esc(t("Explode"))}: ${esc(v.name)}</option>`),
      ...this.movable().filter(c => !s.tracks.some(k => k.kind === "pose" && k.comp === c.id)).map(c => `<option value="pose:${esc(c.id)}" translate="no">${esc(t("Placement"))}: ${esc(c.name)}</option>`),
      ...doc.components.filter(c => !c.suppressed && !s.tracks.some(k => k.kind === "look" && k.comp === c.id)).map(c => `<option value="look:${esc(c.id)}" translate="no">${esc(t("Appearance"))}: ${esc(c.name)}</option>`),
      ...(s.tracks.some(k => k.kind === "camera") ? [] : [`<option value="camera:">${esc(t("Camera"))}</option>`]),
      `<option value="trace:">${esc(t("Trace path…"))}</option>`,
      ...(doc.components.filter(c => !c.suppressed).length > 1 ? [`<option value="gap:">${esc(t("Proximity"))}</option>`] : []),
      ...(doc.mates ?? []).filter(m => !m.suppressed).map(m => `<option value="mplot:${esc(m.id)}" translate="no">${esc(t("Mate value"))}: ${esc(m.name)}</option>`)].join("");
    const ib = (a: string, glyph: string, title: string, extra = "") => `<button class="icon mo-ib" data-mo="${a}" title="${esc(title)}" aria-label="${esc(title)}"${extra}>${glyph}</button>`;
    const shown = s.duration / this.zoom;
    const step = shown <= 0.6 ? 0.05 : shown <= 1.5 ? 0.1 : shown <= 3 ? 0.5 : shown <= 20 ? 1 : shown <= 60 ? 5 : 10;
    let ticks = "";
    for (let v = 0; v <= s.duration + 1e-9; v += step) ticks += `<span class="mo-tick" style="left:${this.x(v)}">${esc(fmt(v, 1))}</span>`;
    const picked = this.picked();
    const names = s.tracks.map(k => {
      const l = this.trackLabel(k), sel = this.sel?.track === k.id && this.sel.key == null;
      return `<div class="mo-name${sel ? " sel" : ""}${k.off ? " off" : ""}" data-track="${esc(k.id)}"><span class="mo-ico" aria-hidden="true">${l.icon}</span><span class="mo-kind">${esc(l.kind)}</span>${l.name ? `<span class="mo-tn" translate="no">${esc(l.name)}</span>` : ""}`
        + `<span class="mo-acts"><input type="checkbox" data-on="${esc(k.id)}"${k.off ? "" : " checked"} title="${esc(t("Track on"))}" aria-label="${esc(t("Track on"))}" />${ib(`del:${k.id}`, "✕", t("Delete track"))}</span></div>`;
    }).join("") + this.traces.map(x => {
      if (x.gap) {
        const nm = (id: string) => doc.components.find(k => k.id === id)?.name ?? "?";
        return `<div class="mo-name mo-trace${this.selTrace === x.id ? " sel" : ""}" data-trace="${esc(x.id)}"><span class="mo-ico" aria-hidden="true" style="color:${esc(x.color)}">↔</span><span class="mo-kind">${esc(t("Proximity"))}</span><span class="mo-tn" translate="no">${esc(nm(x.gap[0]))} ↔ ${esc(nm(x.gap[1]))}</span>`
          + `<span class="mo-acts">${ib(`tdel:${x.id}`, "✕", t("Delete result"))}</span></div>`;
      }
      if (x.mate) {
        const m = (doc.mates ?? []).find(k => k.id === x.mate);
        return `<div class="mo-name mo-trace${this.selTrace === x.id ? " sel" : ""}" data-trace="${esc(x.id)}"><span class="mo-ico" aria-hidden="true" style="color:${esc(x.color)}">∿</span><span class="mo-kind">${esc(t("Mate value"))}</span><span class="mo-tn" translate="no">${esc(m?.name ?? "?")}</span>`
          + `<span class="mo-acts">${ib(`tdel:${x.id}`, "✕", t("Delete result"))}</span></div>`;
      }
      const c = doc.components.find(k => k.id === x.comp || k.id === x.comp.split("/")[0]);
      return `<div class="mo-name mo-trace${this.selTrace === x.id ? " sel" : ""}${x.off ? " off" : ""}" data-trace="${esc(x.id)}"><span class="mo-ico" aria-hidden="true" style="color:${esc(x.color)}">〰</span><span class="mo-kind">${esc(t("Trace path"))}</span><span class="mo-tn" translate="no">${esc(c?.name ?? "?")}</span>`
        + `<span class="mo-acts"><input type="checkbox" data-ton="${esc(x.id)}"${x.off ? "" : " checked"} title="${esc(t("Show the path"))}" aria-label="${esc(t("Show the path"))}" />${ib(`tdel:${x.id}`, "✕", t("Delete trace path"))}</span></div>`;
    }).join("");
    const tlanes = this.traces.map(x => `<div class="mo-tlane${x.off ? " off" : ""}" data-tlane="${esc(x.id)}"></div>`).join("");
    const lanes = s.tracks.map(k => {
      let inner = "";
      if (k.kind === "motor") inner = `<button class="mo-bar${this.sel?.track === k.id ? " sel" : ""}" data-bar="${esc(k.id)}" style="left:${this.x(k.start)};width:calc(${this.x(Math.max(0, k.end - k.start))})" title="${esc(t("Motor"))}" aria-label="${esc(t("Motor"))} ${esc(fmt(k.start))}–${esc(fmt(k.end))} ${esc(t("s"))}"></button>`;
      else {
        const keys = sortKeys(k.keys as AnyKey[]);
        if (keys.length > 1) inner += `<span class="mo-span" style="left:${this.x(keys[0].t)};width:calc(${this.x(keys[keys.length - 1].t - keys[0].t)})"></span>`;
        inner += keys.map((key, i) => `<button class="mo-key${key.interp ? ` i-${key.interp}` : ""}${picked.some(p => p.track === k.id && same(p.t, key.t)) ? " sel" : ""}" data-key="${esc(k.id)}:${i}" style="left:${this.x(key.t)}" title="${esc(t("Key at {t} s", { t: fmt(key.t) }))}" aria-label="${esc(t("Key at {t} s", { t: fmt(key.t) }))}"></button>`).join("");
      }
      return `<div class="mo-lane${k.off ? " off" : ""}" data-lane="${esc(k.id)}">${inner}</div>`;
    }).join("");
    const empty = s.tracks.length || this.traces.length ? "" : `<p class="mo-empty muted">${esc(dr.value.length + dr.axis.length || doc.explodes?.length ? t("Add a track: keys or a motor on a mate, an exploded view or camera keys.") : t("Add a distance, angle, concentric or hinge mate (or an exploded view) to animate it."))}</p>`;
    const playMode = s.play ?? "once";
    this.pane.innerHTML = `<div class="mo-head">`
      + `<h2 class="mo-title">${esc(t("Motion study"))}</h2>`
      + `<label class="mo-f"><select data-mo="study" aria-label="${esc(t("Study"))}">${studyOpts}</select></label>`
      + `<label class="mo-f"><span>${esc(t("Name"))}</span><input type="text" data-mo="name" value="${esc(s.name)}" translate="no" spellcheck="false" /></label>`
      + ib("new", "＋", t("New motion study")) + ib("delstudy", "🗑", t("Delete motion study"), s.id ? "" : " disabled")
      + `<label class="mo-f"><span>${esc(t("Duration"))}</span><input type="text" inputmode="decimal" data-mo="duration" value="${esc(fmt(s.duration))}" class="mo-n" /><span class="muted">${esc(t("s"))}</span></label>`
      + `<label class="mo-f"><span>fps</span><select data-mo="fps">${[15, 24, 30, 60].map(v => `<option${v === s.fps ? " selected" : ""}>${v}</option>`).join("")}</select></label>`
      + `<span class="mo-sp"></span>` + ib("close", "✕", t("Close motion study"))
      + `</div><div class="mo-head mo-transport" role="toolbar" aria-label="${esc(t("Playback"))}">`
      + ib("start", "⏮", t("To start")) + ib("play", this.playing ? "⏸" : "▶", this.playing ? t("Pause") : t("Play")) + ib("stop", "⏹", t("Stop")) + ib("end", "⏭", t("To end"))
      + `<label class="mo-f"><select data-mo="mode" aria-label="${esc(t("Playback mode"))}">${(["once", "loop", "reciprocate"] as const).map(m => `<option value="${m}"${m === playMode ? " selected" : ""}>${esc(t(m === "once" ? "Play once" : m === "loop" ? "Loop" : "Reciprocate"))}</option>`).join("")}</select></label>`
      + `<label class="mo-f"><select data-mo="speed" aria-label="${esc(t("Playback speed"))}">${[0.25, 0.5, 1, 2, 4].map(v => `<option value="${v}"${v === this.speed ? " selected" : ""}>${v}×</option>`).join("")}</select></label>`
      + `<span class="mo-time" data-mo="time" aria-live="off"></span>`
      + ib("zin", "⊕", t("Zoom in on the timeline"), this.zoom >= MAX_ZOOM ? " disabled" : "") + ib("zout", "⊖", t("Zoom out on the timeline"), this.zoom <= 1 ? " disabled" : "") + ib("zfit", "⤢", t("Fit the whole study"), this.zoom <= 1 ? " disabled" : "")
      + `<select data-mo="add" aria-label="${esc(t("Add track…"))}">${addOpts}</select>`
      + `<button class="btn small" data-mo="addkey"${this.sel && this.study.tracks.find(k => k.id === this.sel!.track)?.kind !== "motor" ? "" : " disabled"} title="${esc(t("Add a key at the playhead to the selected track"))}">${esc(t("Add key"))}</button>`
      + `<button class="btn small" data-mo="wexplode"${doc.explodes?.length ? "" : " disabled"} title="${esc(t("Animate the exploded view over the study"))}">${esc(t("Explode"))}</button>`
      + `<button class="btn small" data-mo="wcollapse"${doc.explodes?.length ? "" : " disabled"} title="${esc(t("Animate collapsing the exploded view over the study"))}">${esc(t("Collapse"))}</button>`
      + `<button class="btn small" data-mo="orbit" title="${esc(t("Rotate the model once round over the study (camera keys)"))}">${esc(t("Rotate model"))}</button>`
      + `<button class="btn small" data-mo="clash" title="${esc(t("Check where components enter one another over the study"))}">${esc(t("Interference"))}</button>`
      + `<span class="mo-sp"></span>`
      + `<button class="btn small" data-mo="webm" title="${esc(t("Record the study as a WebM video"))}">${esc(this.recording === "webm" ? t("Stop recording") : t("Video"))}</button>`
      + `<button class="btn small" data-mo="gif" title="${esc(t("Save the study as an animated GIF"))}">${esc(this.recording === "gif" ? t("Stop recording") : "GIF")}</button>`
      + `<button class="btn small" data-mo="png" title="${esc(t("Save every frame of the study as PNG images in a ZIP"))}">${esc(this.recording === "png" ? t("Stop recording") : t("Images"))}</button>`
      + `</div><div class="mo-body"><div class="mo-names"><div class="mo-name mo-rhead">${esc(t("Tracks"))}</div>${names}</div>`
      + `<div class="mo-tlw"><div class="mo-tl" style="width:calc(${this.zoom * 100}% - 20px)"><div class="mo-ruler" data-ruler title="${esc(t("Click or drag to move the playhead"))}">${ticks}${this.clashLane()}</div>${lanes}${tlanes}${empty}<div class="mo-head-line" aria-hidden="true"></div></div></div></div>`
      + `<div class="mo-props">${this.propsHtml()}</div><div class="mo-status muted" role="status"></div>`;
    this.pane.prepend(this.grip);
    const tlw = this.pane.querySelector<HTMLElement>(".mo-tlw");
    if (tlw) tlw.scrollLeft = this.scrollX;
    this.bind();
    this.updateHead(Math.round(this.time * s.fps));
  }

  /** The timeline's horizontal scroll, kept across re-renders. */
  private scrollX = 0;

  /** Zooms the timeline by `f` (clamped to 1…MAX_ZOOM), keeping the time at `at` (default the playhead) where it is on screen. */
  setZoom(z: number, at = this.time) {
    const tlw = this.pane.querySelector<HTMLElement>(".mo-tlw"), tl = tlw?.querySelector<HTMLElement>(".mo-tl");
    const nz = Math.max(1, Math.min(MAX_ZOOM, z));
    if (!tlw || !tl || Math.abs(nz - this.zoom) < 1e-9) return;
    const d = this.study.duration, w0 = tl.offsetWidth, screen = (at / d) * w0 - tlw.scrollLeft;
    this.zoom = nz;
    this.render();
    const tl2 = this.pane.querySelector<HTMLElement>(".mo-tl"), tlw2 = this.pane.querySelector<HTMLElement>(".mo-tlw");
    if (tl2 && tlw2) { tlw2.scrollLeft = Math.max(0, (at / d) * tl2.offsetWidth - screen); this.scrollX = tlw2.scrollLeft; }
  }

  /** Scrolls the zoomed timeline so that the playhead stays in view. */
  private followHead() {
    if (this.zoom <= 1) return;
    const tlw = this.pane.querySelector<HTMLElement>(".mo-tlw"), tl = tlw?.querySelector<HTMLElement>(".mo-tl");
    if (!tlw || !tl) return;
    const x = (this.time / this.study.duration) * tl.offsetWidth, l = tlw.scrollLeft, w = tlw.clientWidth;
    if (x < l + 10 || x > l + w - 10) { tlw.scrollLeft = Math.max(0, x - w * 0.2); this.scrollX = tlw.scrollLeft; }
  }

  /** The selected key's or motor's properties. */
  private propsHtml(): string {
    const tx = this.selTrace ? this.traces.find(k => k.id === this.selTrace) : undefined;
    if (tx) return this.traceProps(tx);
    const sel = this.sel, tr = sel && this.study.tracks.find(k => k.id === sel.track);
    if ((!sel || !tr) && this.clashOpen && this.clash?.study === this.study.id) return this.clashProps();
    if (!sel || !tr) return `<span class="muted">${esc(t("Select a key or a motor to edit it; double-click a track to add a key."))}</span>`;
    const field = (label: string, key: string, v: string, unitTxt = "") => `<label class="mo-f"><span>${esc(label)}</span><input type="text" inputmode="decimal" class="mo-n" data-p="${key}" value="${esc(v)}" />${unitTxt ? `<span class="muted">${esc(unitTxt)}</span>` : ""}</label>`;
    const interpSel = (v: Interp | undefined) => `<label class="mo-f"><span>${esc(t("Interpolation"))}</span><select data-p="interp">${INTERPS.map(([k, l]) => `<option value="${k}"${(v ?? "linear") === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`;
    if (tr.kind === "motor") {
      const mate = (this.asm.doc?.mates ?? []).find(m => m.id === tr.mate);
      const canRot = !mate || mate.type !== "distance", canLin = !mate || (mate.type !== "angle" && mate.type !== "hinge");
      const rot = tr.motion === "rotary";
      return `<label class="mo-f"><span>${esc(t("Motor"))}</span><select data-p="motion"><option value="rotary"${rot ? " selected" : ""}${canRot ? "" : " disabled"}>${esc(t("Rotary motor"))}</option><option value="linear"${!rot ? " selected" : ""}${canLin ? "" : " disabled"}>${esc(t("Linear motor"))}</option></select></label>`
        + `<label class="mo-f"><span>${esc(t("Profile"))}</span><select data-p="profile"><option value="constant"${tr.profile === "constant" ? " selected" : ""}>${esc(t("Constant speed"))}</option><option value="oscillate"${tr.profile === "oscillate" ? " selected" : ""}>${esc(t("Oscillating"))}</option></select></label>`
        + (tr.profile === "oscillate"
          ? field(t("Amplitude"), "amp", fmt(rot ? (tr.amp ?? 0) / DEG : tr.amp ?? 0), rot ? "°" : "mm") + field(t("Frequency"), "freq", fmt(tr.freq ?? 1), t("Hz"))
          : field(t("Speed"), "speed", fmt(tr.speed), rot ? t("rpm") : t("mm/s")))
        + field(t("Start"), "start", fmt(tr.start), t("s")) + field(t("End"), "end", fmt(tr.end), t("s"))
        + `<label class="mo-f"><input type="checkbox" data-p="flip"${tr.flip ? " checked" : ""} /><span>${esc(t("Reverse direction"))}</span></label>`;
    }
    const keys = sortKeys(tr.keys as Key[]), key = keys[sel.key ?? -1];
    if (!key) return "";
    const n = this.picked().length;
    if (n > 1) {
      const all = this.picked().map(p => (this.study.tracks.find(k => k.id === p.track) as { keys: AnyKey[] }).keys.find(x => same(x.t, p.t))?.interp ?? "linear");
      const one = all.every(v => v === all[0]) ? all[0] : "";
      return `<span class="mo-multi">${esc(t("{n} keys selected", { n }))}</span>`
        + `<label class="mo-f"><span>${esc(t("Interpolation"))}</span><select data-p="interp">${one ? "" : `<option value="" selected disabled>—</option>`}${INTERPS.map(([v, l]) => `<option value="${v}"${one === v ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`
        + field(t("Time scale"), "scale", "100", "%")
        + `<span class="muted">${esc(t("Drag one of them or press Alt+←/→ to move them together. Alt+drag stretches their timing, Ctrl+drag copies them."))}</span>`;
    }
    if (tr.kind === "camera") return field(t("Time"), "t", fmt(key.t), t("s")) + interpSel(key.interp) + `<button class="btn small" data-p="setcam">${esc(t("Set to current view"))}</button>`;
    if (tr.kind === "pose") {
      const pk = key as unknown as PoseKey;
      return field(t("Time"), "t", fmt(pk.t), t("s"))
        + (["x", "y", "z"] as const).map((a, j) => field(t("Move {axis}", { axis: a.toUpperCase() }), `d${a}`, fmt(pk.d[j]), "mm")).join("")
        + (["x", "y", "z"] as const).map((a, j) => field(t("Rotate {axis}", { axis: a.toUpperCase() }), `r${a}`, fmt(pk.r[j]), "°")).join("")
        + interpSel(pk.interp);
    }
    const k = key as Key;
    if (tr.kind === "explode") return field(t("Time"), "t", fmt(k.t), t("s")) + field(t("Exploded"), "v", fmt(k.v * 100, 1), "%") + interpSel(k.interp)
      + `<label class="mo-f" title="${esc(t("Move the explode steps one after another instead of all at once"))}"><input type="checkbox" data-p="seq"${tr.seq ? " checked" : ""} /><span>${esc(t("Step by step"))}</span></label>`;
    if (tr.kind === "look") return field(t("Time"), "t", fmt(k.t), t("s")) + field(t("Opacity"), "v", fmt(k.v * 100, 1), "%") + interpSel(k.interp)
      + `<button class="btn small" data-p="hide">${esc(t("Hidden"))}</button><button class="btn small" data-p="show">${esc(t("Shown"))}</button>`;
    const mate = (this.asm.doc?.mates ?? []).find(m => m.id === tr.mate), ang = mate?.type === "angle";
    return field(t("Time"), "t", fmt(k.t), t("s")) + field(ang ? t("Angle") : t("Distance"), "v", fmt(ang ? k.v / DEG : k.v), ang ? "°" : "mm") + interpSel(k.interp);
  }

  private setStatus(s: string) { const e = this.pane.querySelector(".mo-status"); if (e) e.textContent = s; }

  private updateHead(i: number) {
    const s = this.study, line = this.pane.querySelector<HTMLElement>(".mo-head-line");
    if (line) { line.style.left = this.x(this.time); this.followHead(); }
    const tm = this.pane.querySelector<HTMLElement>("[data-mo=time]");
    if (tm) tm.textContent = `${fmt(this.time)} / ${fmt(s.duration)} ${t("s")}`;
    if (!this.recording) this.setStatus(this.badFrames.has(i) ? t("The mates cannot be solved at {t} s; the components stay where they were.", { t: fmt(i / s.fps) }) : "");
  }

  private renderTransport() {
    if (!this.open) return;
    const p = this.pane.querySelector<HTMLButtonElement>("[data-mo=play]");
    if (p) { p.textContent = this.playing ? "⏸" : "▶"; const l = this.playing ? t("Pause") : t("Play"); p.title = l; p.setAttribute("aria-label", l); }
    const w = this.pane.querySelector<HTMLButtonElement>("[data-mo=webm]"), g = this.pane.querySelector<HTMLButtonElement>("[data-mo=gif]");
    if (w) { w.textContent = this.recording === "webm" ? t("Stop recording") : t("Video"); w.disabled = !!this.recording && this.recording !== "webm"; }
    if (g) { g.textContent = this.recording === "gif" ? t("Stop recording") : "GIF"; g.disabled = !!this.recording && this.recording !== "gif"; }
    const pg = this.pane.querySelector<HTMLButtonElement>("[data-mo=png]");
    if (pg) { pg.textContent = this.recording === "png" ? t("Stop recording") : t("Images"); pg.disabled = !!this.recording && this.recording !== "png"; }
  }

  private bind() {
    const pane = this.pane, s = this.study;
    const on = (sel: string, ev: string, fn: (e: Event, el: HTMLElement) => void) => pane.querySelectorAll<HTMLElement>(sel).forEach(el => el.addEventListener(ev, e => fn(e, el)));
    on("[data-mo]", "click", (_e, el) => {
      const a = el.dataset.mo!;
      if (el.tagName !== "BUTTON") return;
      if (a === "close") this.hide();
      else if (a === "new") this.newStudy();
      else if (a === "delstudy") this.deleteStudy();
      else if (a === "play") this.play();
      else if (a === "stop") this.stop();
      else if (a === "start") this.seek(0);
      else if (a === "end") this.seek(this.study.duration);
      else if (a === "addkey" && this.sel) this.addKey(this.sel.track);
      else if (a === "zin") this.setZoom(this.zoom * 2);
      else if (a === "zout") this.setZoom(this.zoom / 2);
      else if (a === "zfit") { this.scrollX = 0; this.setZoom(1); }
      else if (a === "wexplode") this.wizard("explode");
      else if (a === "wcollapse") this.wizard("collapse");
      else if (a === "orbit") this.wizard("orbit");
      else if (a === "webm") { if (this.recording) this.recording = null; else void this.recordWebm(); }
      else if (a === "gif") { if (this.recording) this.recording = null; else void this.recordGif(); }
      else if (a === "png") { if (this.recording) this.recording = null; else void this.recordFrames(); }
      else if (a.startsWith("del:")) this.deleteTrack(a.slice(4));
      else if (a.startsWith("tdel:")) this.deleteTrace(a.slice(5));
      else if (a === "clash") this.checkInterference();
      else if (a === "clashclose") { this.clashOpen = false; this.render(); }
      else if (a === "clashcsv" && this.clash) download(new Blob([clashCsv(this.clash.items, id => this.compName(id))], { type: "text/csv" }), `${this.fileBase()}-interference.csv`);
    });
    on("input[data-mo=clashall]", "change", (_e, el) => { this.clashAll = (el as HTMLInputElement).checked; this.checkInterference(); });
    on("input[data-mo=clashstop]", "change", (_e, el) => { this.clashStop = (el as HTMLInputElement).checked; });
    on("button[data-clt]", "click", (_e, el) => this.seek(Number(el.dataset.clt)));
    on("select[data-mo=study]", "change", (_e, el) => { this.stop(); this.studyId = (el as HTMLSelectElement).value; this.sel = null; this.render(); this.showAt(0); });
    on("select[data-mo=add]", "change", (_e, el) => { const v = (el as HTMLSelectElement).value; if (v === "trace:") { (el as HTMLSelectElement).value = ""; this.startTrace(); } else if (v.startsWith("mplot:")) this.addMatePlot(v.slice(6)); else if (v === "gap:") this.addGap(); else if (v) this.addTrack(v); });
    on(".mo-name[data-trace]", "click", (e, el) => { if ((e.target as HTMLElement).closest("input, button")) return; this.sel = null; this.selTrace = el.dataset.trace!; this.render(); this.showAt(this.time); });
    on("input[data-ton]", "change", (_e, el) => { const v = (el as HTMLInputElement).checked; this.setTrace(el.dataset.ton!, x => { if (v) delete x.off; else x.off = true; }); });
    on("select[data-tr=plot]", "change", (_e, el) => { const v = (el as HTMLSelectElement).value as TracePlot; this.setTrace(this.selTrace!, x => { if (v === "dist") delete x.plot; else x.plot = v; }); });
    on("select[data-tr=rel]", "change", (_e, el) => { const v = (el as HTMLSelectElement).value; this.setTrace(this.selTrace!, x => { if (v) x.rel = v; else delete x.rel; }); });
    on("input[data-tr=color]", "change", (_e, el) => { const v = (el as HTMLInputElement).value; this.setTrace(this.selTrace!, x => { x.color = v; }); });
    on("select[data-tr=ga], select[data-tr=gb]", "change", (_e, el) => {
      const v = (el as HTMLSelectElement).value, k = el.dataset.tr === "ga" ? 0 : 1;
      this.setTrace(this.selTrace!, x => { if (x.gap) x.gap[k] = v; });
    });
    on("input[data-tr=amin], input[data-tr=amax]", "change", (_e, el) => {
      const raw = (el as HTMLInputElement).value.trim(), v = num(raw), k = el.dataset.tr === "amin" ? "min" : "max";
      if (raw && !Number.isFinite(v)) { el.setAttribute("aria-invalid", "true"); return; }
      this.setTrace(this.selTrace!, x => { const a = { ...(x.alert ?? {}) }; if (raw) a[k] = v; else delete a[k]; if (a.min === undefined && a.max === undefined && !a.stop) delete x.alert; else x.alert = a; });
    });
    on("input[data-tr=astop]", "change", (_e, el) => {
      const v = (el as HTMLInputElement).checked;
      this.setTrace(this.selTrace!, x => { const a = { ...(x.alert ?? {}) }; if (v) a.stop = true; else delete a.stop; if (a.min === undefined && a.max === undefined && !a.stop) delete x.alert; else x.alert = a; });
    });
    on("button[data-tr=del]", "click", () => { if (this.selTrace) this.deleteTrace(this.selTrace); });
    on("button[data-tr=svg]", "click", () => {
      const x = this.traces.find(k => k.id === this.selTrace);
      if (x) download(new Blob([withLang("en", () => this.plotSvgFile(x))], { type: "image/svg+xml" }), `${this.fileBase()}-${x.gap ? "proximity" : x.mate ? "mate" : "trace"}.svg`);
    });
    on("button[data-tr=csv]", "click", () => {
      const x = this.traces.find(k => k.id === this.selTrace);
      if (x?.gap) download(new Blob([gapCsv(this.gapValues(x.id), this.study.fps)], { type: "text/csv" }), `${this.fileBase()}-proximity.csv`);
      else if (x?.mate) { const mv = this.mateValues(x.id); download(new Blob([mateCsv(mv.dist, mv.angle, this.study.fps)], { type: "text/csv" }), `${this.fileBase()}-mate.csv`); }
      else if (x) download(new Blob([traceCsv(this.tracePath(x.id), this.study.fps, this.traceAngle(x.id))], { type: "text/csv" }), `${this.fileBase()}-trace.csv`);
    });
    on("select[data-mo=mode]", "change", (_e, el) => this.edit(st => { st.play = (el as HTMLSelectElement).value as MotionStudy["play"]; }));
    on("select[data-mo=speed]", "change", (_e, el) => { this.speed = Number((el as HTMLSelectElement).value); if (this.playing) { this.pause(); this.play(); } });
    on("select[data-mo=fps]", "change", (_e, el) => this.edit(st => { st.fps = Number((el as HTMLSelectElement).value); }));
    on("input[data-mo=name]", "change", (_e, el) => { const v = (el as HTMLInputElement).value.trim(); if (v) this.edit(st => { st.name = v; }); });
    on("input[data-mo=duration]", "change", (_e, el) => {
      const v = num((el as HTMLInputElement).value);
      if (!Number.isFinite(v) || v <= 0 || v > 600) { el.setAttribute("aria-invalid", "true"); return; }
      // Keys and motors scale with the study, as SolidWorks stretches the key points.
      this.edit(st => {
        const k = v / st.duration;
        for (const tr of st.tracks) { if (tr.kind === "motor") { tr.start *= k; tr.end *= k; } else for (const key of tr.keys) key.t *= k; }
        st.duration = v;
      });
    });
    on("input[data-on]", "change", (_e, el) => { const id = el.dataset.on!, v = (el as HTMLInputElement).checked; this.edit(st => { const k = st.tracks.find(x => x.id === id); if (k) { if (v) delete k.off; else k.off = true; } }); });
    on(".mo-name[data-track]", "click", (e, el) => { if ((e.target as HTMLElement).closest("input, button")) return; this.sel = { track: el.dataset.track! }; this.render(); });
    // Ruler: click or drag to scrub.
    const ruler = pane.querySelector<HTMLElement>("[data-ruler]");
    // Ctrl+wheel zooms the timeline about the pointer; plain wheel scrolls as usual.
    const tlw = pane.querySelector<HTMLElement>(".mo-tlw");
    tlw?.addEventListener("scroll", () => { this.scrollX = tlw.scrollLeft; });
    tlw?.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const tl = tlw.querySelector<HTMLElement>(".mo-tl")!, r = tl.getBoundingClientRect();
      const at = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))) * s.duration;
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.5 : 1 / 1.5), at);
    }, { passive: false });
    const tAt = (ev: PointerEvent, el: HTMLElement) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))) * s.duration; };
    ruler?.addEventListener("pointerdown", e => {
      ruler.setPointerCapture(e.pointerId);
      this.seek(this.snap(tAt(e, ruler)));
      const move = (ev: PointerEvent) => this.seek(this.snap(tAt(ev, ruler)));
      const up = () => { ruler.removeEventListener("pointermove", move); ruler.removeEventListener("pointerup", up); };
      ruler.addEventListener("pointermove", move);
      ruler.addEventListener("pointerup", up);
    });
    // Lanes: a click moves the playhead, a double-click adds a key there.
    // Dragging on an empty part of the tracks draws a box that selects the keys in it (Ctrl or Shift adds to the selection).
    on(".mo-lane", "pointerdown", (e, el) => {
      const pe = e as PointerEvent;
      if ((e.target as HTMLElement) !== el || pe.button !== 0) return;
      this.seek(this.snap(tAt(pe, el)));
      const x0 = pe.clientX, y0 = pe.clientY, add = pe.ctrlKey || pe.metaKey || pe.shiftKey;
      el.setPointerCapture(pe.pointerId);
      let box: HTMLElement | null = null;
      const rect = (ev: PointerEvent) => ({ l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) });
      const move = (ev: PointerEvent) => {
        if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        if (!box) { box = document.createElement("div"); box.className = "mo-box"; document.body.appendChild(box); }
        const b = rect(ev);
        Object.assign(box.style, { left: `${b.l}px`, top: `${b.t}px`, width: `${b.r - b.l}px`, height: `${b.b - b.t}px` });
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
        if (!box) return;
        box.remove();
        this.boxSelect(rect(ev), add);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    on(".mo-lane", "dblclick", (e, el) => { if ((e.target as HTMLElement) === el) this.addKey(el.dataset.lane!, tAt(e as unknown as PointerEvent, el)); });
    // Keys and motor bars: select, drag along the timeline.
    type Mods = { alt: boolean; copy: boolean };
    const drag = (el: HTMLElement, apply: (dt: number, m: Mods) => void, group: (m: Mods) => HTMLElement[] = () => [el], shift?: (g: HTMLElement, dt: number, m: Mods) => number) => {
      el.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const m: Mods = { alt: e.altKey, copy: e.ctrlKey || e.metaKey };
        const lane = el.parentElement!, r = lane.getBoundingClientRect(), x0 = e.clientX, w = Math.max(1, r.width);
        // Ctrl+drag leaves the keys where they are and drags copies of them.
        const els = group(m).map(g => {
          if (!m.copy || !shift) return g;
          const c = g.cloneNode(true) as HTMLElement;
          c.removeAttribute("data-key"); c.classList.add("mo-ghost"); c.setAttribute("aria-hidden", "true");
          g.parentElement!.appendChild(c);
          return c;
        });
        const srcs = group(m);
        el.setPointerCapture(e.pointerId);
        let dt = 0;
        const move = (ev: PointerEvent) => {
          dt = ((ev.clientX - x0) / w) * s.duration;
          els.forEach((g, j) => { const d = shift ? shift(srcs[j], dt, m) : dt; g.style.transform = `translateX(${(d / s.duration) * w}px)`; });
        };
        const up = () => {
          el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
          els.forEach(g => { if (g.classList.contains("mo-ghost")) g.remove(); else g.style.transform = ""; });
          if (Math.abs(dt) * s.fps >= 0.5) { this.noClick = true; setTimeout(() => { this.noClick = false; }, 0); apply(dt, m); }
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      });
    };
    on("[data-key]", "click", (e, el) => {
      if (this.noClick) return;
      const [id, i] = el.dataset.key!.split(":"), me = e as MouseEvent;
      if (me.ctrlKey || me.metaKey || me.shiftKey) { this.toggleKey(id, Number(i)); return; }
      this.sel = { track: id, key: Number(i) }; const k = sortKeys((this.study.tracks.find(x => x.id === id) as { keys: Key[] }).keys)[Number(i)]; if (k) this.seek(k.t); this.render(); });
    const inGroup = (el: HTMLElement) => el.classList.contains("sel") && this.picked().length > 1;
    const refOf = (el: HTMLElement): KeyRef | null => {
      const [id, i] = el.dataset.key!.split(":"), tr = this.study.tracks.find(k => k.id === id);
      const key = tr && tr.kind !== "motor" ? sortKeys(tr.keys as AnyKey[])[Number(i)] : undefined;
      return key ? { track: id, t: key.t } : null;
    };
    // Alt+drag stretches the timing (SolidWorks): several selected keys about the one at the other end, one key every key of the study about 0.
    const stretch = (el: HTMLElement) => {
      const me = refOf(el);
      if (!me) return null;
      const ps = inGroup(el) ? this.picked() : this.allKeys();
      const ts = ps.map(p => p.t), lo = Math.min(...ts), hi = Math.max(...ts);
      const anchor = !inGroup(el) ? 0 : same(me.t, lo) ? hi : lo;
      return same(me.t, anchor) ? null : { ps, anchor, t0: me.t, motors: !inGroup(el) };
    };
    const shiftOf = (g: HTMLElement, dt: number, m: Mods, el: HTMLElement) => {
      if (!m.alt || m.copy) return dt;
      const st = stretch(el), r = refOf(g);
      if (!st || !r) return 0;
      const f = (st.t0 + dt - st.anchor) / (st.t0 - st.anchor);
      return (r.t - st.anchor) * (f - 1);
    };
    pane.querySelectorAll<HTMLElement>("[data-key]").forEach(el => drag(el, (dt, m) => {
      if (m.copy) { const me = refOf(el); if (me && this.copyKeys(inGroup(el) ? this.picked() : [me], dt)) { this.render(); this.showAt(this.time); } return; }
      if (m.alt) {
        const st = stretch(el);
        if (st && this.scaleKeys(st.ps, st.anchor, (st.t0 + dt - st.anchor) / (st.t0 - st.anchor), st.motors)) { this.render(); this.showAt(this.time); }
        return;
      }
      if (inGroup(el)) { if (this.moveGroup(dt)) { this.render(); this.showAt(this.time); } return; }
      const [id, i] = el.dataset.key!.split(":");
      let idx = Number(i);
      this.edit(st => {
        const tr = st.tracks.find(x => x.id === id);
        if (!tr || tr.kind === "motor") return;
        const keys = sortKeys(tr.keys as Key[]), k = keys[idx];
        k.t = this.snap(k.t + dt);
        const rest = keys.filter((x, j) => j !== idx && Math.abs(x.t - k.t) > 1e-9);
        (tr as { keys: Key[] }).keys = sortKeys([...rest, k]);
        idx = (tr as { keys: Key[] }).keys.indexOf(k);
      });
      this.sel = { track: id, key: idx };
      this.render();
    }, m => m.alt && !m.copy && !inGroup(el) ? [...pane.querySelectorAll<HTMLElement>("[data-key]")]
      : inGroup(el) ? [...pane.querySelectorAll<HTMLElement>(".mo-key.sel")] : [el],
    (g, dt, m) => shiftOf(g, dt, m, el)));
    on("[data-key]", "contextmenu", (e, el) => {
      e.preventDefault();
      const [id, i] = el.dataset.key!.split(":");
      // A right-click on one of several selected keys keeps them all (the menu acts on the group).
      if (!inGroup(el)) { this.sel = { track: id, key: Number(i) }; this.render(); }
      const me = e as MouseEvent;
      this.keyMenu(me.clientX, me.clientY);
    });
    on(".mo-lane", "contextmenu", (e, el) => {
      if ((e.target as HTMLElement) !== el) return;
      e.preventDefault();
      const me = e as MouseEvent, at = this.snap(tAt(me as PointerEvent, el)), id = el.dataset.lane!;
      this.laneMenu(id, at, me.clientX, me.clientY);
    });
    on("[data-bar]", "click", (_e, el) => { this.sel = { track: el.dataset.bar! }; this.render(); });
    pane.querySelectorAll<HTMLElement>("[data-bar]").forEach(el => drag(el, dt => this.edit(st => {
      const tr = st.tracks.find(x => x.id === el.dataset.bar) as MotorTrack | undefined;
      if (!tr) return;
      const len = tr.end - tr.start, a = Math.max(0, Math.min(st.duration - len, this.snap(tr.start + dt)));
      tr.start = a; tr.end = a + len;
    })));
    // Properties.
    on("[data-p]", "change", (_e, el) => this.setProp(el.dataset.p!, el as HTMLInputElement));
    on("button[data-p=setcam]", "click", () => this.setProp("setcam", null));
    on("button[data-p=hide]", "click", () => this.setProp("hide", null));
    on("button[data-p=show]", "click", () => this.setProp("show", null));
  }

  private setProp(p: string, el: HTMLInputElement | HTMLSelectElement | null) {
    const sel = this.sel;
    if (!sel) return;
    const raw = el?.value ?? "", v = num(raw);
    const bad = () => el?.setAttribute("aria-invalid", "true");
    const tr0 = this.study.tracks.find(k => k.id === sel.track);
    if (!tr0) return;
    if (p === "interp" && this.picked().length > 1) { this.setInterp(interpOf(raw) ?? "linear"); return; }
    if (p === "scale") {
      const ps = this.picked();
      if (!Number.isFinite(v) || v <= 0 || ps.length < 2) { bad(); return; }
      if (!this.scaleKeys(ps, Math.min(...ps.map(q => q.t)), v / 100)) { bad(); toast(t("The keys can't be stretched that far."), "warn"); return; }
      this.render(); this.showAt(this.time); return;
    }
    const numeric = !["interp", "motion", "profile", "flip", "setcam", "hide", "show", "seq"].includes(p);
    if (numeric && !Number.isFinite(v)) { bad(); return; }
    let newIdx = sel.key;
    this.edit(st => {
      const tr = st.tracks.find(k => k.id === sel.track);
      if (!tr) return;
      if (tr.kind === "motor") {
        const rot = tr.motion === "rotary";
        if (p === "motion") tr.motion = raw as MotorTrack["motion"];
        else if (p === "profile") tr.profile = raw as MotorTrack["profile"];
        else if (p === "flip") tr.flip = (el as HTMLInputElement).checked || undefined;
        else if (p === "speed") tr.speed = v;
        else if (p === "amp") tr.amp = rot ? v * DEG : v;
        else if (p === "freq") { if (v > 0) tr.freq = v; }
        else if (p === "start") { tr.start = Math.max(0, Math.min(st.duration, v)); tr.end = Math.max(tr.start, tr.end); }
        else if (p === "end") tr.end = Math.max(tr.start, Math.min(st.duration, v));
        if (!tr.flip) delete tr.flip;
        return;
      }
      if (p === "seq" && tr.kind === "explode") { if ((el as HTMLInputElement).checked) tr.seq = true; else delete tr.seq; return; }
      const keys = sortKeys(tr.keys as (Key | CamKey | PoseKey)[]), k = keys[sel.key ?? -1];
      if (!k) return;
      if (p === "t") k.t = this.snap(v);
      else if (p === "interp") { const i = interpOf(raw); if (i) k.interp = i; else delete k.interp; }
      else if (p === "setcam" && tr.kind === "camera") Object.assign(k, this.camKey(k.t));
      else if (p === "v" && (tr.kind === "explode" || tr.kind === "look")) (k as Key).v = Math.max(0, Math.min(1, v / 100));
      else if (/^[dr][xyz]$/.test(p) && tr.kind === "pose") { const pk = k as unknown as PoseKey; (p[0] === "d" ? pk.d : pk.r)["xyz".indexOf(p[1])] = v; }
      else if ((p === "hide" || p === "show") && tr.kind === "look") (k as Key).v = p === "hide" ? 0 : 1;
      else if (p === "v" && tr.kind === "mate") { const mate = (this.asm.doc?.mates ?? []).find(m => m.id === tr.mate); (k as Key).v = mate?.type === "angle" ? v * DEG : v; }
      const sorted = sortKeys(keys.filter(x => x === k || Math.abs(x.t - k.t) > 1e-9));
      (tr as { keys: unknown[] }).keys = sorted;
      newIdx = sorted.indexOf(k);
    });
    if (newIdx != null) this.sel = { track: sel.track, key: newIdx };
    this.render();
  }

  /** Moves the selected key by `dt` seconds (Alt+←/→, Shift for ten frames), keeping it inside the study and off its neighbours. */
  moveKey(dt: number) {
    if (this.picked().length > 1) {
      if (!this.moveGroup(dt)) return;
      const s = this.selKey();
      if (s) this.time = s.key.t;
      this.render();
      this.showAt(this.time);
      this.focusSel();
      return;
    }
    const sel = this.sel, tr0 = sel && this.study.tracks.find(k => k.id === sel.track);
    if (!sel || sel.key == null || !tr0 || tr0.kind === "motor") return;
    const keys = sortKeys(tr0.keys as { t: number }[]), k = keys[sel.key];
    if (!k) return;
    const lo = sel.key > 0 ? keys[sel.key - 1].t + 1 / this.study.fps : 0;
    const hi = sel.key < keys.length - 1 ? keys[sel.key + 1].t - 1 / this.study.fps : this.study.duration;
    const tq = this.snap(Math.max(lo, Math.min(hi, k.t + dt)));
    if (Math.abs(tq - k.t) < 1e-9) return;
    this.edit(st => {
      const tr = st.tracks.find(x => x.id === sel.track) as { keys: { t: number }[] } | undefined;
      if (!tr) return;
      const ks = sortKeys(tr.keys);
      ks[sel.key!].t = tq;
      tr.keys = ks;
    });
    this.time = tq;
    this.render();
    this.showAt(tq);
    (this.pane.querySelector(`[data-key="${CSS.escape(`${sel.track}:${sel.key}`)}"]`) as HTMLElement | null)?.focus();
  }

  /** The selected key and its track, if a key (not a motor or a whole track) is selected. */
  private selKey(): { tr: Track; key: AnyKey } | null {
    const sel = this.sel, tr = sel && this.study.tracks.find(k => k.id === sel.track);
    if (!sel || sel.key == null || !tr || tr.kind === "motor") return null;
    const key = sortKeys(tr.keys as AnyKey[])[sel.key];
    return key ? { tr, key } : null;
  }

  /** Every selected key by track and time, the panel's key first. */
  private picked(): KeyRef[] {
    const out: KeyRef[] = [], s = this.selKey();
    if (s) out.push({ track: s.tr.id, t: s.key.t });
    for (const m of this.more) {
      const tr = this.study.tracks.find(k => k.id === m.track);
      if (!tr || tr.kind === "motor" || !(tr.keys as AnyKey[]).some(k => same(k.t, m.t))) continue;
      if (!out.some(o => o.track === m.track && same(o.t, m.t))) out.push(m);
    }
    return out;
  }

  /** Selects keys by track and time; the first one is shown in the panel. */
  private pick(list: KeyRef[]) {
    const tr = list[0] && this.study.tracks.find(k => k.id === list[0].track);
    if (!tr || tr.kind === "motor") { this.sel = null; return; }
    this.sel = { track: tr.id, key: sortKeys(tr.keys as AnyKey[]).findIndex(k => same(k.t, list[0].t)) };
    this.more = list.slice(1);
  }

  /** Ctrl/Shift+click: adds a key to the selection or takes it out. */
  toggleKey(trackId: string, idx: number) {
    const tr = this.study.tracks.find(k => k.id === trackId);
    const key = tr && tr.kind !== "motor" ? sortKeys(tr.keys as AnyKey[])[idx] : undefined;
    if (!key) return;
    const cur = this.picked(), i = cur.findIndex(p => p.track === trackId && same(p.t, key.t));
    if (i >= 0) cur.splice(i, 1); else cur.unshift({ track: trackId, t: key.t });
    this.pick(cur);
    this.render();
    this.focusSel();
  }

  /** Ctrl+A: every key of the study. */
  selectAll() {
    const cur = this.picked();
    const all = this.study.tracks.flatMap(k => k.kind === "motor" ? [] : sortKeys(k.keys as AnyKey[]).map(x => ({ track: k.id, t: x.t })));
    this.pick([...cur, ...all.filter(a => !cur.some(c => c.track === a.track && same(c.t, a.t)))]);
    this.render();
  }

  /** Selects the keys a box on the screen touches (`add`: as well as those selected). */
  private boxSelect(b: { l: number; r: number; t: number; b: number }, add: boolean) {
    const hit: KeyRef[] = [];
    this.pane.querySelectorAll<HTMLElement>("[data-key]").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right < b.l || r.left > b.r || r.bottom < b.t || r.top > b.b) return;
      const [id, i] = el.dataset.key!.split(":"), tr = this.study.tracks.find(k => k.id === id);
      const key = tr && tr.kind !== "motor" ? sortKeys(tr.keys as AnyKey[])[Number(i)] : undefined;
      if (key) hit.push({ track: id, t: key.t });
    });
    const cur = add ? this.picked() : [];
    this.pick([...cur, ...hit.filter(h => !cur.some(c => c.track === h.track && same(c.t, h.t)))]);
    this.render();
  }

  /** Moves every selected key by `dt` (whole frames), as far as the study's ends and the keys left behind allow. */
  private moveGroup(dt: number): boolean {
    const ps = this.picked(), s = this.study, f = 1 / s.fps;
    let lo = -Infinity, hi = Infinity;
    for (const p of ps) {
      lo = Math.max(lo, -p.t); hi = Math.min(hi, s.duration - p.t);
      for (const k of (s.tracks.find(x => x.id === p.track) as { keys: AnyKey[] }).keys) {
        if (ps.some(q => q.track === p.track && same(q.t, k.t))) continue;
        if (k.t < p.t) lo = Math.max(lo, k.t + f - p.t); else hi = Math.min(hi, k.t - f - p.t);
      }
    }
    let d = Math.round(Math.max(lo, Math.min(hi, dt)) * s.fps) / s.fps;
    if (d < lo - 1e-9) d += f;
    if (d > hi + 1e-9) d -= f;
    if (same(d, 0) || d < lo - 1e-9 || d > hi + 1e-9) return false;
    this.edit(st => {
      for (const tr of st.tracks) {
        if (tr.kind === "motor") continue;
        const keys = tr.keys as AnyKey[];
        for (const k of keys) if (ps.some(p => p.track === tr.id && same(p.t, k.t))) k.t += d;
        (tr as { keys: AnyKey[] }).keys = sortKeys(keys);
      }
    });
    this.pick(ps.map(p => ({ track: p.track, t: p.t + d })));
    return true;
  }

  /** Every key of the study (motors are bars, not keys). */
  private allKeys(): KeyRef[] {
    return this.study.tracks.flatMap(k => k.kind === "motor" ? [] : (k.keys as AnyKey[]).map(x => ({ track: k.id, t: x.t })));
  }

  /**
   * Stretches the timing of keys about `anchor` by `f` (snapped to frames). The factor is held where the keys would leave the
   * study, pass a key that is not stretched or land on one another; `motors` stretches motor bars too (a whole-study stretch).
   */
  scaleKeys(ps: KeyRef[], anchor: number, f: number, motors = false): boolean {
    const s = this.study, fr = 1 / s.fps, before = this.picked();
    if (!ps.length || !Number.isFinite(f)) return false;
    let lo = 1e-6, hi = Infinity;
    const limit = (t: number, a: number, b: number) => {
      const d = t - anchor;
      if (Math.abs(d) < 1e-9) return;
      const x = (a - anchor) / d, y = (b - anchor) / d;
      lo = Math.max(lo, Math.min(x, y)); hi = Math.min(hi, Math.max(x, y));
    };
    for (const p of ps) {
      const tr = s.tracks.find(x => x.id === p.track) as { keys: AnyKey[] } | undefined;
      if (!tr) continue;
      let a = 0, b = s.duration;
      for (const k of tr.keys) {
        if (ps.some(q => q.track === p.track && same(q.t, k.t))) continue;
        if (k.t < p.t) a = Math.max(a, k.t + fr); else b = Math.min(b, k.t - fr);
      }
      limit(p.t, a, b);
      // Neighbouring stretched keys on the track keep at least a frame between them.
      const next = ps.filter(q => q.track === p.track && q.t > p.t + 1e-9).map(q => q.t);
      if (next.length) lo = Math.max(lo, fr / (Math.min(...next) - p.t));
    }
    if (motors) for (const tr of s.tracks) if (tr.kind === "motor") { limit(tr.start, 0, s.duration); limit(tr.end, 0, s.duration); }
    if (lo > hi + 1e-9) return false;
    const k = Math.max(lo, Math.min(hi, f));
    const to = (t: number) => Math.max(0, Math.min(s.duration, Math.round((anchor + (t - anchor) * k) * s.fps) / s.fps));
    const moved = ps.map(p => ({ ...p, n: to(p.t) }));
    if (moved.every(m => same(m.n, m.t))) return false;
    // Snapping must not stack two keys of a track on one frame.
    for (const tr of s.tracks) {
      if (tr.kind === "motor") continue;
      const times = (tr.keys as AnyKey[]).map(x => moved.find(m => m.track === tr.id && same(m.t, x.t))?.n ?? x.t);
      if (new Set(times.map(v => Math.round(v * s.fps))).size !== times.length) return false;
    }
    this.edit(st => {
      for (const tr of st.tracks) {
        if (tr.kind === "motor") { if (motors) { tr.start = to(tr.start); tr.end = Math.max(tr.start, to(tr.end)); } continue; }
        const keys = tr.keys as AnyKey[];
        for (const x of keys) { const m = moved.find(q => q.track === tr.id && same(q.t, x.t)); if (m) x.t = m.n; }
        (tr as { keys: AnyKey[] }).keys = sortKeys(keys);
      }
    });
    this.pick(before.map(p => ({ track: p.track, t: moved.find(m => m.track === p.track && same(m.t, p.t))?.n ?? p.t })));
    return true;
  }

  /** Ctrl+drag: copies keys `dt` along the timeline on their own tracks (whole frames, inside the study), replacing keys there. */
  copyKeys(ps: KeyRef[], dt: number): boolean {
    const s = this.study;
    if (!ps.length) return false;
    const lo = -Math.min(...ps.map(p => p.t)), hi = s.duration - Math.max(...ps.map(p => p.t));
    const d = Math.round(Math.max(lo, Math.min(hi, dt)) * s.fps) / s.fps;
    if (same(d, 0)) return false;
    const put = ps.map(p => {
      const key = (s.tracks.find(x => x.id === p.track) as { keys: AnyKey[] }).keys.find(k => same(k.t, p.t))!;
      return { track: p.track, t: Math.max(0, Math.min(s.duration, p.t + d)), key: structuredClone(key) };
    });
    this.edit(st => {
      for (const p of put) {
        const tr = st.tracks.find(x => x.id === p.track) as { keys: AnyKey[] } | undefined;
        if (tr) tr.keys = sortKeys([...tr.keys.filter(x => !same(x.t, p.t)), { ...p.key, t: p.t }]);
      }
    });
    this.pick(put.map(p => ({ track: p.track, t: p.t })));
    return true;
  }

  private focusSel() {
    const sel = this.sel;
    if (sel?.key != null) (this.pane.querySelector(`[data-key="${CSS.escape(`${sel.track}:${sel.key}`)}"]`) as HTMLElement | null)?.focus();
  }

  /** What a key's value means on a track: keys paste only onto tracks of the same kind and unit. */
  private unitOf(tr: Track): string {
    if (tr.kind !== "mate") return tr.kind;
    return (this.asm.doc?.mates ?? []).find(m => m.id === tr.mate)?.type === "angle" ? "mate:angle" : "mate:distance";
  }

  /** Copies the selected keys (Ctrl+C). */
  copyKey() {
    const ps = this.picked();
    if (!ps.length) return;
    const t0 = Math.min(...ps.map(p => p.t));
    this.clip = {
      items: ps.map(p => {
        const tr = this.study.tracks.find(k => k.id === p.track)!;
        return { track: p.track, unit: this.unitOf(tr), dt: p.t - t0, key: structuredClone((tr as { keys: AnyKey[] }).keys.find(k => same(k.t, p.t))!) };
      }),
    };
    toast(ps.length > 1 ? t("{n} keys copied", { n: ps.length }) : t("Key copied"));
  }

  /** Keys copied from one track go on any track of the same unit; keys from several tracks go back on their own tracks. */
  private oneTrackClip(): boolean { return !!this.clip && new Set(this.clip.items.map(i => i.track)).size === 1; }

  /** Can the copied keys be pasted (onto this track, when they came from one track)? */
  private canPaste(trackId: string): boolean {
    if (!this.clip) return false;
    const fits = (id: string, unit: string) => { const tr = this.study.tracks.find(k => k.id === id); return !!tr && tr.kind !== "motor" && this.unitOf(tr) === unit; };
    return this.oneTrackClip() ? fits(trackId, this.clip.items[0].unit) : this.clip.items.every(i => fits(i.track, i.unit));
  }

  /** Pastes the copied keys at `at` (Ctrl+V: the playhead), the first onto `trackId` when they came from one track, replacing keys there. */
  pasteKey(trackId: string, at: number) {
    if (!this.clip) return;
    if (!this.canPaste(trackId)) { toast(this.oneTrackClip() ? t("The copied key is for another kind of track.") : t("Some tracks of the copied keys are gone."), "warn"); return; }
    const tq = this.snap(at), one = this.oneTrackClip(), d = this.study.duration;
    const put = this.clip.items.map(i => ({ track: one ? trackId : i.track, t: this.snap(tq + i.dt), key: i.key })).filter(p => p.t <= d + 1e-9);
    this.edit(st => {
      for (const p of put) {
        const tr = st.tracks.find(x => x.id === p.track) as { keys: AnyKey[] } | undefined;
        if (tr) tr.keys = sortKeys([...tr.keys.filter(x => !same(x.t, p.t)), { ...structuredClone(p.key), t: p.t }]);
      }
    });
    this.pick(put.map(p => ({ track: p.track, t: p.t })));
    this.time = tq;
    this.render();
    this.showAt(tq);
  }

  /** Sets the selected key's interpolation (how the motion runs into it). */
  setInterp(i: Interp) {
    const ps = this.picked();
    if (!ps.length) return;
    this.edit(st => {
      for (const p of ps) {
        const k = (st.tracks.find(x => x.id === p.track) as { keys: AnyKey[] } | undefined)?.keys.find(x => same(x.t, p.t));
        if (!k) continue;
        if (i === "linear") delete k.interp; else k.interp = i;
      }
    });
    this.render();
  }

  /** The key point menu (right-click a key, the menu key or Shift+F10): interpolation, copy, paste, delete. */
  private keyMenu(x: number, y: number) {
    const s = this.selKey(), sel = this.sel;
    if (!s || !sel) return;
    const all = this.picked().map(p => (this.study.tracks.find(k => k.id === p.track) as { keys: AnyKey[] }).keys.find(x => same(x.t, p.t))?.interp ?? "linear");
    const cur = all.every(v => v === all[0]) ? all[0] : "";
    this.menu([
      ...INTERPS.map(([v, l]) => ({ label: t(l), checked: cur === v, run: () => this.setInterp(v) })),
      null,
      { label: t("Copy"), keys: "Ctrl+C", run: () => this.copyKey() },
      { label: t("Paste at the playhead"), keys: "Ctrl+V", run: () => this.pasteKey(sel.track, this.time), off: !this.canPaste(sel.track) },
      null,
      { label: t("Delete"), keys: "Del", run: () => this.deleteSel() },
    ], x, y);
  }

  /** A right-click on an empty part of a track: add a key or paste the copied one there. */
  private laneMenu(trackId: string, at: number, x: number, y: number) {
    const tr = this.study.tracks.find(k => k.id === trackId);
    if (!tr || tr.kind === "motor") return;
    this.menu([
      { label: t("Add key here"), run: () => this.addKey(trackId, at) },
      { label: t("Paste here"), run: () => this.pasteKey(trackId, at), off: !this.canPaste(trackId) },
    ], x, y);
  }

  private menu(items: ({ label: string; run: () => void; checked?: boolean; keys?: string; off?: boolean } | null)[], x: number, y: number) {
    document.getElementById("mo-menu")?.remove();
    const m = document.createElement("div");
    m.id = "mo-menu";
    m.className = "mc-menu";
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", t("Key point"));
    const real = items.filter((it): it is NonNullable<typeof it> => !!it);
    m.innerHTML = items.map(it => !it ? `<hr role="separator" />`
      : `<button role="${it.checked == null ? "menuitem" : "menuitemradio"}"${it.checked == null ? "" : ` aria-checked="${it.checked}"`} data-i="${real.indexOf(it)}"${it.off ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${it.checked ? "●" : ""}</span>${esc(it.label)}${it.keys ? `<span class="mo-mk" translate="no">${esc(it.keys)}</span>` : ""}</button>`).join("");
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    const btns = [...m.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const back = () => (this.pane.querySelector<HTMLElement>(this.sel?.key != null ? `[data-key="${CSS.escape(`${this.sel.track}:${this.sel.key}`)}"]` : "[data-mo=play]") ?? this.pane).focus();
    const close = (refocus: boolean) => { m.remove(); document.removeEventListener("pointerdown", outside, true); if (refocus) back(); };
    const outside = (ev: Event) => { if (!m.contains(ev.target as Node)) close(false); };
    m.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.addEventListener("click", () => { close(false); real[Number(b.dataset.i)].run(); back(); }));
    m.addEventListener("keydown", ev => {
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (ev.key === "Escape" || ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); close(true); }
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); btns[(i + (ev.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus(); }
      else if (ev.key === "Home" || ev.key === "End") { ev.preventDefault(); btns[ev.key === "Home" ? 0 : btns.length - 1]?.focus(); }
    });
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    (btns.find(b => b.getAttribute("aria-checked") === "true") ?? btns[0])?.focus();
  }

  private key(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "Escape" && this.tracing) { e.preventDefault(); this.stopTracing(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selTrace && !this.sel) { e.preventDefault(); this.deleteTrace(this.selTrace); return; }
    if (e.key === " ") { e.preventDefault(); this.play(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && this.sel) { e.preventDefault(); this.deleteSel(); }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") { e.preventDefault(); this.selectAll(); }
    else if (e.key === "Escape" && this.picked().length) { e.preventDefault(); this.sel = null; this.render(); }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c" && this.sel?.key != null) { e.preventDefault(); this.copyKey(); }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v" && this.sel) { e.preventDefault(); this.pasteKey(this.sel.track, this.time); }
    else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && this.sel?.key != null) {
      e.preventDefault();
      const b = this.pane.querySelector<HTMLElement>(`[data-key="${CSS.escape(`${this.sel.track}:${this.sel.key}`)}"]`)?.getBoundingClientRect();
      this.keyMenu(b ? b.right : 0, b ? b.bottom : 0);
    }
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.altKey && this.sel?.key != null) { e.preventDefault(); this.moveKey((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1) / this.study.fps); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); this.seek(this.snap(this.time + (e.key === "ArrowRight" ? 1 : -1) / this.study.fps)); }
    else if ((e.key === "+" || e.key === "=") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.setZoom(this.zoom * 2); }
    else if (e.key === "-" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.setZoom(this.zoom / 2); }
    else if (e.key === "Home") { e.preventDefault(); this.seek(0); }
    else if (e.key === "End") { e.preventDefault(); this.seek(this.study.duration); }
  }

  /** For tests: a motor's driven amount and the camera at `tq`. */
  probe(tq: number) {
    const s = this.study;
    return { motors: s.tracks.filter((k): k is MotorTrack => k.kind === "motor").map(k => motorAmount(k, tq)), camera: cameraAt((s.tracks.find(k => k.kind === "camera") as { keys: CamKey[] } | undefined)?.keys ?? [], tq) };
  }
}
