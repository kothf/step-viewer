// Motion manager (FR-FT-122): SolidWorks' motion study pane under the view. A timeline with key tracks on
// distance/angle mates, motors on mates, exploded view and camera keys; play, loop, back and forth; record
// a WebM video or an animated GIF of the view. Frames are solved in order with the assembly's mate solver
// (each from the one before, so linkages do not flip) and cached until the study or the assembly changes.
import { makeGrip } from "../resize";
import { t, onLangChange } from "../i18n";
import { toast } from "../ui";
import { uid } from "../model/doc";
import { compose, invert } from "../asm/math";
import { download } from "../tools/exporters";
import type { AsmController } from "../asm/controller";
import type { Mate, Tf } from "../asm/types";
import type { V3 } from "../model/types";
import type { Viewer } from "../viewer/Viewer";
import { AXIS_MATES, VALUE_MATES, axisLock, cameraAt, explodeKeys, fadeKeys, frameAt, poseAt, posed, frameCount, motorAmount, orbitKeys, playTime, sortKeys, valueAt } from "./evaluate";
import { encodeGif } from "./gif";
import type { CamKey, Interp, Key, MotionStudy, MotorTrack, PoseKey, Track } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: number, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);
const num = (s: string) => Number(s.trim().replace(",", "."));
const DEG = Math.PI / 180;

/** The selected key (by index into the track's sorted keys) or motor bar. */
type Sel = { track: string; key?: number } | null;
type AnyKey = Key | CamKey | PoseKey;

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
  sel: Sel = null;
  /** The copied key (Ctrl+C or the key menu) and the kind of track it came from. */
  private clip: { kind: Track["kind"]; unit: string; key: AnyKey } | null = null;
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
  recording: "webm" | "gif" | null = null;
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
    this.sel = null;
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
    this.edit(st => { st.tracks = st.tracks.filter(x => !(x.kind === "explode" && x.view === view)); st.tracks.push({ id: uid("mt_"), kind: "explode", view, keys: explodeKeys(s.duration, what === "collapse") }); });
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
    let tfs = this.frames[i] ?? this.asm.restTfs();
    if (Object.keys(f.pose).length) {
      const rest = this.asm.restTfs();
      tfs = { ...tfs };
      for (const [id, p] of Object.entries(f.pose)) if (rest[id]) tfs[id] = posed(rest[id], p);
    }
    this.asm.motionShow(tfs, f.explode);
    this.asm.motionLook(f.look);
    if (f.camera) this.setCamera(f.camera);
    this.viewer.invalidate();
    this.updateHead(i);
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
    const step = () => {
      if (!this.playing) return;
      const p = playTime(this.playFrom + ((performance.now() - this.playStart) / 1000) * this.speed, this.study);
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
      ...(s.tracks.some(k => k.kind === "camera") ? [] : [`<option value="camera:">${esc(t("Camera"))}</option>`])].join("");
    const ib = (a: string, glyph: string, title: string, extra = "") => `<button class="icon mo-ib" data-mo="${a}" title="${esc(title)}" aria-label="${esc(title)}"${extra}>${glyph}</button>`;
    const shown = s.duration / this.zoom;
    const step = shown <= 0.6 ? 0.05 : shown <= 1.5 ? 0.1 : shown <= 3 ? 0.5 : shown <= 20 ? 1 : shown <= 60 ? 5 : 10;
    let ticks = "";
    for (let v = 0; v <= s.duration + 1e-9; v += step) ticks += `<span class="mo-tick" style="left:${this.x(v)}">${esc(fmt(v, 1))}</span>`;
    const names = s.tracks.map(k => {
      const l = this.trackLabel(k), sel = this.sel?.track === k.id && this.sel.key == null;
      return `<div class="mo-name${sel ? " sel" : ""}${k.off ? " off" : ""}" data-track="${esc(k.id)}"><span class="mo-ico" aria-hidden="true">${l.icon}</span><span class="mo-kind">${esc(l.kind)}</span>${l.name ? `<span class="mo-tn" translate="no">${esc(l.name)}</span>` : ""}`
        + `<span class="mo-acts"><input type="checkbox" data-on="${esc(k.id)}"${k.off ? "" : " checked"} title="${esc(t("Track on"))}" aria-label="${esc(t("Track on"))}" />${ib(`del:${k.id}`, "✕", t("Delete track"))}</span></div>`;
    }).join("");
    const lanes = s.tracks.map(k => {
      let inner = "";
      if (k.kind === "motor") inner = `<button class="mo-bar${this.sel?.track === k.id ? " sel" : ""}" data-bar="${esc(k.id)}" style="left:${this.x(k.start)};width:calc(${this.x(Math.max(0, k.end - k.start))})" title="${esc(t("Motor"))}" aria-label="${esc(t("Motor"))} ${esc(fmt(k.start))}–${esc(fmt(k.end))} ${esc(t("s"))}"></button>`;
      else {
        const keys = sortKeys(k.keys as AnyKey[]);
        if (keys.length > 1) inner += `<span class="mo-span" style="left:${this.x(keys[0].t)};width:calc(${this.x(keys[keys.length - 1].t - keys[0].t)})"></span>`;
        inner += keys.map((key, i) => `<button class="mo-key${key.interp ? ` i-${key.interp}` : ""}${this.sel?.track === k.id && this.sel.key === i ? " sel" : ""}" data-key="${esc(k.id)}:${i}" style="left:${this.x(key.t)}" title="${esc(t("Key at {t} s", { t: fmt(key.t) }))}" aria-label="${esc(t("Key at {t} s", { t: fmt(key.t) }))}"></button>`).join("");
      }
      return `<div class="mo-lane${k.off ? " off" : ""}" data-lane="${esc(k.id)}">${inner}</div>`;
    }).join("");
    const empty = s.tracks.length ? "" : `<p class="mo-empty muted">${esc(dr.value.length + dr.axis.length || doc.explodes?.length ? t("Add a track: keys or a motor on a mate, an exploded view or camera keys.") : t("Add a distance, angle, concentric or hinge mate (or an exploded view) to animate it."))}</p>`;
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
      + `<span class="mo-sp"></span>`
      + `<button class="btn small" data-mo="webm" title="${esc(t("Record the study as a WebM video"))}">${esc(this.recording === "webm" ? t("Stop recording") : t("Video"))}</button>`
      + `<button class="btn small" data-mo="gif" title="${esc(t("Save the study as an animated GIF"))}">${esc(this.recording === "gif" ? t("Stop recording") : "GIF")}</button>`
      + `</div><div class="mo-body"><div class="mo-names"><div class="mo-name mo-rhead">${esc(t("Tracks"))}</div>${names}</div>`
      + `<div class="mo-tlw"><div class="mo-tl" style="width:calc(${this.zoom * 100}% - 20px)"><div class="mo-ruler" data-ruler title="${esc(t("Click or drag to move the playhead"))}">${ticks}</div>${lanes}${empty}<div class="mo-head-line" aria-hidden="true"></div></div></div></div>`
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
    const sel = this.sel, tr = sel && this.study.tracks.find(k => k.id === sel.track);
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
    if (tr.kind === "camera") return field(t("Time"), "t", fmt(key.t), t("s")) + interpSel(key.interp) + `<button class="btn small" data-p="setcam">${esc(t("Set to current view"))}</button>`;
    if (tr.kind === "pose") {
      const pk = key as unknown as PoseKey;
      return field(t("Time"), "t", fmt(pk.t), t("s"))
        + (["x", "y", "z"] as const).map((a, j) => field(t("Move {axis}", { axis: a.toUpperCase() }), `d${a}`, fmt(pk.d[j]), "mm")).join("")
        + (["x", "y", "z"] as const).map((a, j) => field(t("Rotate {axis}", { axis: a.toUpperCase() }), `r${a}`, fmt(pk.r[j]), "°")).join("")
        + interpSel(pk.interp);
    }
    const k = key as Key;
    if (tr.kind === "explode") return field(t("Time"), "t", fmt(k.t), t("s")) + field(t("Exploded"), "v", fmt(k.v * 100, 1), "%") + interpSel(k.interp);
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
    if (w) { w.textContent = this.recording === "webm" ? t("Stop recording") : t("Video"); w.disabled = this.recording === "gif"; }
    if (g) { g.textContent = this.recording === "gif" ? t("Stop recording") : "GIF"; g.disabled = this.recording === "webm"; }
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
      else if (a.startsWith("del:")) this.deleteTrack(a.slice(4));
    });
    on("select[data-mo=study]", "change", (_e, el) => { this.stop(); this.studyId = (el as HTMLSelectElement).value; this.sel = null; this.render(); this.showAt(0); });
    on("select[data-mo=add]", "change", (_e, el) => { const v = (el as HTMLSelectElement).value; if (v) this.addTrack(v); });
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
    on(".mo-lane", "pointerdown", (e, el) => { if ((e.target as HTMLElement) === el) this.seek(this.snap(tAt(e as PointerEvent, el))); });
    on(".mo-lane", "dblclick", (e, el) => { if ((e.target as HTMLElement) === el) this.addKey(el.dataset.lane!, tAt(e as unknown as PointerEvent, el)); });
    // Keys and motor bars: select, drag along the timeline.
    const drag = (el: HTMLElement, apply: (dt: number) => void) => {
      el.addEventListener("pointerdown", e => {
        e.stopPropagation();
        const lane = el.parentElement!, r = lane.getBoundingClientRect(), x0 = e.clientX;
        el.setPointerCapture(e.pointerId);
        let dt = 0;
        const move = (ev: PointerEvent) => { dt = ((ev.clientX - x0) / Math.max(1, r.width)) * s.duration; el.style.transform = `translateX(${ev.clientX - x0}px)`; };
        const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.style.transform = ""; if (Math.abs(dt) * s.fps >= 0.5) apply(dt); };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      });
    };
    on("[data-key]", "click", (_e, el) => { const [id, i] = el.dataset.key!.split(":"); this.sel = { track: id, key: Number(i) }; const k = sortKeys((this.study.tracks.find(x => x.id === id) as { keys: Key[] }).keys)[Number(i)]; if (k) this.seek(k.t); this.render(); });
    pane.querySelectorAll<HTMLElement>("[data-key]").forEach(el => drag(el, dt => {
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
    }));
    on("[data-key]", "contextmenu", (e, el) => {
      e.preventDefault();
      const [id, i] = el.dataset.key!.split(":");
      this.sel = { track: id, key: Number(i) };
      this.render();
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
    const numeric = !["interp", "motion", "profile", "flip", "setcam", "hide", "show"].includes(p);
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

  /** What a key's value means on a track: keys paste only onto tracks of the same kind and unit. */
  private unitOf(tr: Track): string {
    if (tr.kind !== "mate") return tr.kind;
    return (this.asm.doc?.mates ?? []).find(m => m.id === tr.mate)?.type === "angle" ? "mate:angle" : "mate:distance";
  }

  /** Copies the selected key (Ctrl+C). */
  copyKey() {
    const s = this.selKey();
    if (!s) return;
    this.clip = { kind: s.tr.kind, unit: this.unitOf(s.tr), key: structuredClone(s.key) };
    toast(t("Key copied"));
  }

  /** Can the copied key go on this track? */
  private canPaste(trackId: string): boolean {
    const tr = this.study.tracks.find(k => k.id === trackId);
    return !!(this.clip && tr && tr.kind !== "motor" && this.unitOf(tr) === this.clip.unit);
  }

  /** Pastes the copied key onto a track at `at` (Ctrl+V: the selected track at the playhead), replacing a key there. */
  pasteKey(trackId: string, at: number) {
    if (!this.clip) return;
    if (!this.canPaste(trackId)) { toast(t("The copied key is for another kind of track."), "warn"); return; }
    const tq = this.snap(at), key = { ...structuredClone(this.clip.key), t: tq };
    let idx = 0;
    this.edit(st => {
      const tr = st.tracks.find(x => x.id === trackId) as { keys: AnyKey[] } | undefined;
      if (!tr) return;
      tr.keys = sortKeys([...tr.keys.filter(x => Math.abs(x.t - tq) > 1e-9), key]);
      idx = tr.keys.indexOf(key);
    });
    this.sel = { track: trackId, key: idx };
    this.time = tq;
    this.render();
    this.showAt(tq);
  }

  /** Sets the selected key's interpolation (how the motion runs into it). */
  setInterp(i: Interp) {
    const sel = this.sel;
    if (!this.selKey() || !sel) return;
    this.edit(st => {
      const tr = st.tracks.find(x => x.id === sel.track) as { keys: AnyKey[] } | undefined;
      const k = tr && sortKeys(tr.keys)[sel.key!];
      if (!k) return;
      if (i === "linear") delete k.interp; else k.interp = i;
    });
    this.render();
  }

  /** The key point menu (right-click a key, the menu key or Shift+F10): interpolation, copy, paste, delete. */
  private keyMenu(x: number, y: number) {
    const s = this.selKey(), sel = this.sel;
    if (!s || !sel) return;
    const cur = s.key.interp ?? "linear";
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
    if (e.key === " ") { e.preventDefault(); this.play(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && this.sel) { e.preventDefault(); this.deleteSel(); }
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
