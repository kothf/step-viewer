// Board thermal maps (FRS-thermal section 7, phase TH1): a thermal package shown on the model it belongs to.
// The package's own surfaces are drawn in colour in place of the matched bodies, which stay in the scene for
// picking, measuring and sections. One map per model file (by its file key), kept while the tab is parked.
import * as THREE from "three";
import { cmTab, onCmTab } from "../commandBar";
import { onLangChange, t } from "../i18n";
import { download } from "../tools/exporters";
import { chooseModal, toast } from "../ui";
import { deltaRange, mapOnto, partChanges, type PartChange } from "./compare";
import type { Viewer } from "../viewer/Viewer";
import { matchParts, misfit, paletteColor, paletteCss, PALETTE_NAMES, triWeights, type ModelBody, type PaletteName, type PartMatch } from "./match";
import { byMargin, DEFAULT_LIMITS, partMargin, partStats, partTemp, problems, summary, type CheckLimits, type PartStat, type ThermalPackage, type ThermalPart, type ThermalProblem } from "./package";
import type { ThermalReply } from "./thermal.worker";
import ThermalWorker from "./thermal.worker?worker";
import { ThermalError } from "./vtu";
import { looksLikeBoard } from "./study";
import { gerberName } from "./copper";
import { pcbFit, pcbUvs, WHITE_PX } from "./pcbTexture";
import { pcbAtlas, pcbFromGerber, type PcbLayers } from "./pcbRaster";

export interface ThermalHost {
  viewer: Viewer;
  /** Key of the model file on screen ("" when a part, an assembly or nothing is shown). */
  key(): string;
  /** The map of the shown model came or went: tabs and panes follow. */
  changed(): void;
  /** Shows the Thermal side page. */
  showTab(): void;
  /** Asks for a package to attach (file picker). */
  addMap(): void;
  /** Makes an assembly of the model with a thermal study from the package (Simulate in MöbiusCAD). */
  simulate(pkg: ThermalPackage, match: PartMatch, bodies: ModelBody[]): void;
  /** Saves the view as a PNG (File ▸ Export PNG), which draws the map's legend in through `decorate`. */
  savePicture(): void;
  /** A Gerber set went under the map: kept as the board's for a study and Pack and Go (FR-TBRD-020). */
  gerber?(files: { name: string; data: ArrayBuffer }[]): void;
}

type V3 = [number, number, number];
interface Probe { p: V3; t: number; part: number }
type SortCol = "name" | "p" | "t" | "limit" | "margin" | "life";
interface Attached {
  pkg: ThermalPackage;
  stats: Map<number, PartStat>;
  match: PartMatch;
  /** The map was moved onto the model by `match.shift`. */
  fitted: boolean;
  /** The model is the package's own mesh (no STEP). */
  own: boolean;
  on: boolean;
  probes: Probe[];
  sel: number | null;
  /** The part shown alone, the others faded (FR-TMAP-020), or null. */
  iso: number | null;
  /** Fixed colour range (°C), or null = automatic. */
  range: [number, number] | null;
  sort: { col: SortCol; up: boolean };
  filter: string;
  top: boolean;
  picture?: string;
  /** A second map of the same model to compare with (FR-TMAP-030): B's temperatures at A's points, ΔT = B − A. */
  cmp?: { pkg: ThermalPackage; stats: Map<number, PartStat>; tb: Float32Array; delta: Float32Array; changes: { rows: PartChange[]; onlyA: string[]; onlyB: string[] }; view: "a" | "b" | "d" };
  /** The board's Gerber layers under the map (FR-TMAP-012): moved by (du, dv) mm, `shown` = drawn. */
  pcb?: { layers: PcbLayers; du: number; dv: number; shown: boolean };
}

interface Prefs { palette: PaletteName; labels: boolean; rise: boolean; life: number; board: number; folded: boolean; pcbMix: number }
const PREFS_KEY = "mc:thermalMap";
/** Model files that were shown the "looks like a board" hint (FR-TPKG-005): once per file. */
const HINT_KEY = "mc:thermalHint";
const HINT_MAX = 200;
function hintedFiles(): string[] {
  try { const j = JSON.parse(localStorage.getItem(HINT_KEY) ?? "[]"); return Array.isArray(j) ? j.filter(x => typeof x === "string") : []; } catch { return []; }
}
/** Opacity of the other parts while one is isolated. */
const ISO_FADE = 0.18;
const DEFAULT_PREFS: Prefs = { palette: "heat", labels: true, rise: false, life: DEFAULT_LIMITS.life, board: DEFAULT_LIMITS.board, folded: false, pcbMix: 0.6 };
function loadPrefs(): Prefs {
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      palette: PALETTE_NAMES.includes(j.palette as PaletteName) ? j.palette! : "heat", labels: j.labels !== false, rise: j.rise === true,
      life: Number.isFinite(j.life) && j.life! > 0 ? j.life! : DEFAULT_LIMITS.life, board: Number.isFinite(j.board) ? j.board! : DEFAULT_LIMITS.board, folded: j.folded === true,
      pcbMix: Number.isFinite(j.pcbMix) ? Math.max(0, Math.min(1, j.pcbMix!)) : 0.6,
    };
  } catch { return { ...DEFAULT_PREFS }; }
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (s: string) => { const v = Number(s.trim().replace(",", ".")); return s.trim() && isFinite(v) ? v : null; };
/** A temperature for reading: whole degrees from 100, one decimal below. */
export const deg = (x: number | undefined) => (x === undefined || !isFinite(x) ? "–" : Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
const watts = (x: number | undefined) => (x === undefined ? "–" : x >= 10 ? x.toFixed(1) : x >= 0.1 ? String(+x.toFixed(2)) : String(+x.toPrecision(2)));
const hours = (x: number) => Math.round(x).toLocaleString("en-US").replace(/,/g, " ");
/** Hours in a narrow table column: 6.5k, 19k. */
const kHours = (x: number) => (x >= 1000 ? `${+(x / 1000).toPrecision(x >= 100000 ? 3 : 2)}k` : String(Math.round(x)));
/** What the package says about the enclosure and how the board lies, in words (unknown values are shown as written). */
const SETTING_LABEL: Record<string, string> = { closed: "closed enclosure", open: "open air", vented: "vented enclosure", "horizontal-up": "horizontal, parts up", "horizontal-down": "horizontal, parts down", vertical: "standing upright" };
const setting = (v: string) => (SETTING_LABEL[v] ? t(SETTING_LABEL[v]) : v);
const PALETTE_LABEL: Record<PaletteName, string> = { heat: "Heat colours", rainbow: "Rainbow", grey: "Grey" };
const PATH_LABEL: Record<string, string> = { board: "board", air: "air", heatsink: "heatsink", chassis: "chassis" };
const KIND_LABEL: Record<string, string> = { body: "body", case: "case", junction: "junction", bulb: "bulb" };
const ICON: Record<string, string> = {
  simulate: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.2v9.6L12.5 8z"/></svg>`,
  map: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.6V3a1.5 1.5 0 0 1 3 0v6.6a3 3 0 1 1-3 0z"/><path d="M8 6v5"/><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  flip: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h11l-2-3h-7zM2.5 10.5h11l-2 3h-7z"/><path d="M8 7v2"/></svg>`,
  labels: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3h8l3 3-3 3h-8z"/><path d="M5 13.5h6"/><circle cx="5" cy="6" r=".8" fill="currentColor" stroke="none"/></svg>`,
  probe: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/></svg>`,
  parts: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>`,
  add: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>`,
  remove: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  isolate: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" stroke="none"/><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" opacity=".6"/></svg>`,
  gerber: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M5 5.5h3l2 2v3"/><circle cx="5" cy="5.5" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="10.5" r=".9" fill="currentColor" stroke="none"/></svg>`,
  png: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l4-4 3 3 2-2 2.5 2.5"/></svg>`,
  csv: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 13.5h10"/></svg>`,
};

/** Reads a package from its files in a worker (the error is a `ThermalError`). */
export function readPackageInWorker(files: Map<string, Uint8Array>, name: string, field?: string): Promise<ThermalPackage> {
  return new Promise((resolve, reject) => {
    const w = new ThermalWorker();
    w.onmessage = (e: MessageEvent<ThermalReply>) => {
      w.terminate();
      const d = e.data;
      if (d.ok) resolve(d.pkg);
      else reject(new ThermalError(d.code as "E-TH-PKG", d.reason, d.params));
    };
    w.onerror = e => { w.terminate(); reject(new ThermalError("E-TH-PKG", "{err}", { err: e.message || "worker failed" })); };
    w.postMessage({ id: 1, files: [...files], name, field });
  });
}

/**
 * Reads a package; a plain .vtu with several possible temperature arrays (E-TH-FIELD, FR-TPKG-014) asks which one in
 * a small list. Null when the list is cancelled.
 */
export async function readPackageAsking(files: Map<string, Uint8Array>, name: string): Promise<ThermalPackage | null> {
  try { return await readPackageInWorker(files, name); }
  catch (err) {
    if (!(err instanceof ThermalError) || err.code !== "E-TH-FIELD") throw err;
    const list = String(err.params.list ?? "").split("\n").filter(Boolean);
    const pick = await chooseModal(t("Which array is the temperature?"), t("{name} has no Temperature_C array. Pick the point array that holds the temperatures (°C; a name ending in K is read as kelvin).", { name }),
      list.map(n => ({ key: n, label: n })));
    return pick ? readPackageInWorker(files, name, pick) : null;
  }
}

/** What a reader error says to the user. */
export function thermalErrorText(err: unknown, name: string) {
  if (err instanceof ThermalError) {
    if (err.code === "E-TH-VERSION") return t(err.reason, err.params);
    return t("Could not open the thermal package {name}: {err}", { name, err: t(err.reason, err.params) });
  }
  return t("Could not open the thermal package {name}: {err}", { name, err: err instanceof Error ? err.message : String(err) });
}

/** The package's mesh as one model part per package part, for a package opened without its STEP (FR-TPKG-003). */
export function packageMeshes(pkg: ThermalPackage) {
  const m = pkg.mesh, by = new Map<number, number[]>();
  for (let k = 0; k < m.part.length; k++) { const id = m.part[k]; let l = by.get(id); if (!l) by.set(id, l = []); l.push(k); }
  const name = new Map(pkg.manifest.parts.map(p => [p.id, p.designator]));
  const out: { name: string; pos: Float32Array; idx: Uint32Array | null; color?: number[] }[] = [];
  for (const id of [...by.keys()].sort((a, b) => a - b)) {
    const tris = by.get(id)!, pos = new Float32Array(tris.length * 9);
    tris.forEach((k, j) => { for (let c = 0; c < 3; c++) { const i = m.tri[k * 3 + c]; pos[j * 9 + c * 3] = m.pos[i * 3]; pos[j * 9 + c * 3 + 1] = m.pos[i * 3 + 1]; pos[j * 9 + c * 3 + 2] = m.pos[i * 3 + 2]; } });
    out.push({ name: id === 0 ? "Board" : name.get(id) ?? `#${id}`, pos, idx: null, color: id === 0 ? [0.16, 0.42, 0.25] : [0.6, 0.62, 0.66] });
  }
  return out;
}

export class ThermalMaps {
  private maps = new Map<string, Attached>();
  private prefs = loadPrefs();
  private overlay: THREE.Mesh | null = null;
  /** The other parts, see-through, while one is isolated. */
  private fade: THREE.Mesh | null = null;
  private mats: THREE.Material[] = [];
  private saved: { mesh: THREE.Mesh; mat: THREE.Material }[] = [];
  /** Package triangle of each drawn triangle. */
  private drawn: Uint32Array | null = null;
  private visKey = "";
  private probing = false;
  private layer: HTMLElement | null = null;
  private pins: { p: V3; el: HTMLElement }[] = [];
  private card: HTMLElement | null = null;
  private hoverAt: { x: number; y: number } | null = null;
  private hoverQueued = false;
  private down: { x: number; y: number } | null = null;
  private bound = false;
  /** The Gerber atlas drawn on the map, and its texture (FR-TMAP-012). */
  private atlas: HTMLCanvasElement | null = null;
  private atlasTex: THREE.CanvasTexture | null = null;
  private pcbBoard = 0;

  constructor(readonly host: ThermalHost) {
    onCmTab(() => this.renderBar());
    onLangChange(() => this.renderAll());
    $("#th-tools").addEventListener("click", e => this.barClick(e));
    const side = $("#th-side");
    side.addEventListener("click", e => this.sideClick(e));
    side.addEventListener("dblclick", e => this.sideClick(e, true));
    side.addEventListener("change", e => this.sideChange(e));
    side.addEventListener("input", e => { const el = e.target as HTMLInputElement; if (el.dataset.k === "filter") { const a = this.cur(); if (a) { a.filter = el.value; this.renderRows(); } } });
    const lg = $("#th-legend");
    lg.addEventListener("click", e => this.legendClick(e));
    lg.addEventListener("change", e => this.legendChange(e));
    lg.addEventListener("input", e => { const el = e.target as HTMLInputElement; if (el.dataset.k === "pcbmix") this.setPcbMix(Number(el.value) / 100); });
    $("#th-summary").addEventListener("click", e => this.summaryClick(e));
    $("#st-thermal").addEventListener("click", e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
      if (!a) return;
      this.hideHint();
      if (a === "thadd") this.host.addMap();
    });
    const vp = $("#viewport");
    vp.addEventListener("pointermove", e => { if (!this.active() || e.buttons) { this.hideCard(); return; } this.hoverAt = { x: e.clientX, y: e.clientY }; if (!this.hoverQueued) { this.hoverQueued = true; requestAnimationFrame(() => { this.hoverQueued = false; this.hover(); }); } });
    vp.addEventListener("pointerleave", () => { this.hoverAt = null; this.hideCard(); });
    vp.addEventListener("pointerdown", e => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
    vp.addEventListener("pointerup", e => {
      const d = this.down;
      this.down = null;
      if (!d || !this.active() || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || (e.target as HTMLElement).tagName !== "CANVAS") return;
      this.click(e);
    }, true);
    window.addEventListener("keydown", e => {
      const tg = e.target as HTMLElement;
      if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey && this.active() && this.cur()?.cmp && !/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) && !tg.isContentEditable) {
        // B flips between the two maps (FR-TMAP-031)
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setView(this.cur()!.cmp!.view === "b" ? "a" : "b");
      }
    }, true);
    vp.addEventListener("dblclick", e => {
      // a double-click on a part shows it alone; on the board or empty space, everything again (FR-TMAP-020)
      const a = this.cur();
      if (!a || !this.active() || this.probing || (e.target as HTMLElement).tagName !== "CANVAS") return;
      const h = this.hit(e.clientX, e.clientY), id = h && h.part > 0 ? h.part : null;
      this.isolate(id !== null && id !== a.iso ? id : null);
    });
    window.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !this.active()) return;
      const a = this.cur()!;
      if (this.probing) { this.probing = false; this.renderAll(); } else if (a.iso !== null) this.isolate(null); else if (a.sel !== null) { a.sel = null; this.renderAll(); }
    });
  }

  // ---------- state ----------

  /** The map of the model on screen. */
  cur(): Attached | null { const k = this.host.key(); return k ? this.maps.get(k) ?? null : null; }
  has() { return !!this.cur(); }
  /** The map is attached and drawn. */
  active() { const a = this.cur(); return !!a && a.on && !!this.overlay; }
  /** Number of problems, for the tab's badge. */
  problemCount() { const a = this.cur(); return a ? this.problemsOf(a).length : 0; }

  private limits(): CheckLimits { return { life: this.prefs.life, board: this.prefs.board }; }
  private savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* private mode */ } }
  private problemsOf(a: Attached): ThermalProblem[] { return problems(a.pkg, a.stats, this.limits()); }
  private partOf(a: Attached, id: number): ThermalPart | undefined { return a.pkg.manifest.parts.find(p => p.id === id); }
  private nameOf(a: Attached, id: number) { return id === 0 ? t("Board") : this.partOf(a, id)?.designator ?? `#${id}`; }
  private ambient(a: Attached) { return a.pkg.manifest.settings.ambient; }

  private bodies(): ModelBody[] {
    const v = this.host.viewer;
    return v.parts.map(p => {
      const b = new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.getAttribute("position") as THREE.BufferAttribute);
      return { name: p.data.name ?? "", box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] };
    });
  }

  /** Attaches a package to the model on screen (replacing its map). `own`: the model is the package's own mesh. */
  attach(pkg: ThermalPackage, own = false, ask = true) {
    const key = this.host.key();
    if (!key) return false;
    this.hideHint();
    const had = this.maps.get(key);
    if (ask && had && !had.own && !own && !had.pkg.sourcesOnly && !pkg.sourcesOnly) { void this.second(pkg); return true; }
    const stats = partStats(pkg.mesh);
    const match = matchParts(pkg.manifest.parts, stats, this.bodies());
    const a: Attached = { pkg, stats, match, fitted: false, own, on: true, probes: [], sel: null, iso: null, range: null, sort: { col: "margin", up: true }, filter: "", top: true };
    if (pkg.picture) a.picture = URL.createObjectURL(new Blob([pkg.picture as BlobPart], { type: "image/png" }));
    const old = this.maps.get(key);
    if (old?.picture) URL.revokeObjectURL(old.picture);
    this.maps.set(key, a);
    this.show();
    this.host.changed();
    this.renderAll();
    for (const n of pkg.notes) toast(t(n.text, n.params));
    return true;
  }

  /** A second package for a model that has a map: Replace, or Keep both and compare (FR-TPKG-004). */
  private async second(pkg: ThermalPackage) {
    const a = this.cur();
    if (!a) return;
    const k = await chooseModal(t("Second thermal map"), t("This model already has the map {a}. Compare {b} with it, or put {b} in its place?", { a: a.pkg.manifest.design || a.pkg.name, b: pkg.manifest.design || pkg.name }),
      [{ key: "compare", label: t("Keep both and compare") }, { key: "replace", label: t("Replace") }]);
    if (k === "compare") this.compare(pkg);
    else if (k === "replace") this.attach(pkg, false, false);
  }

  /** Compares the map on screen with another package of the same model (FR-TMAP-030): ΔT = B − A. */
  compare(pkg: ThermalPackage) {
    const a = this.cur();
    if (!a) return false;
    const stats = partStats(pkg.mesh), tb = mapOnto(a.pkg.mesh, pkg.mesh), ta = a.pkg.mesh.temp;
    const delta = new Float32Array(ta.length);
    for (let i = 0; i < ta.length; i++) delta[i] = tb[i] - ta[i];
    a.cmp = { pkg, stats, tb, delta, changes: partChanges(a.pkg.manifest.parts, a.stats, pkg.manifest.parts, stats), view: "d" };
    a.range = null;
    a.on = true;
    this.show();
    this.host.changed();
    this.renderAll();
    return true;
  }

  /** Stops comparing: map A alone again. */
  uncompare() { const a = this.cur(); if (!a?.cmp) return; delete a.cmp; a.range = null; this.colour(); this.renderAll(); }

  /** Which map shows: A, B or the change (B − A). */
  setView(view: "a" | "b" | "d") { const a = this.cur(); if (!a?.cmp) return; a.cmp.view = view; this.colour(); this.renderAll(); }

  /** The temperatures drawn now, one per point of map A. */
  private tempOf(a: Attached): Float32Array { return !a.cmp || a.cmp.view === "a" ? a.pkg.mesh.temp : a.cmp.view === "b" ? a.cmp.tb : a.cmp.delta; }
  private delta(a: Attached) { return a.cmp?.view === "d"; }

  /** A value read off the map as shown: a temperature, or a change in K. */
  private here(a: Attached, v: number) {
    if (!this.delta(a)) return this.shown(a, v);
    return `${v >= 0 ? "+" : "−"}${deg(Math.abs(v))} K`;
  }

  /** Removes the map of the model on screen. */
  detach() {
    const key = this.host.key(), a = this.maps.get(key);
    if (!a) return;
    if (a.picture) URL.revokeObjectURL(a.picture);
    this.maps.delete(key);
    this.clear();
    this.host.changed();
    this.renderAll();
  }

  /** A model was shown (opened, or its tab came back): its map goes on again; another model's map goes off. */
  modelShown() {
    this.clear();
    const a = this.cur();
    if (a) { a.match = matchParts(a.pkg.manifest.parts, a.stats, this.bodies()); this.show(); }
    this.probing = false;
    this.host.changed();
    this.renderAll();
    // after the caller has had its turn: a STEP opened with its package gets the map, not the hint
    setTimeout(() => this.boardHint(), 0);
  }
  /** The model is going away (another document takes the view). */
  modelGone() { this.clear(); this.probing = false; this.hideHint(); this.renderAll(); }

  /**
   * A model that looks like a circuit board and has no map gets a status-bar hint with an Add thermal map… link
   * (FR-TPKG-005, UX-6), once per file.
   */
  private boardHint() {
    const key = this.host.key();
    if (!key || this.cur()) { this.hideHint(); return; }
    const seen = hintedFiles();
    if (seen.includes(key) || !looksLikeBoard(this.bodies())) { this.hideHint(); return; }
    try { localStorage.setItem(HINT_KEY, JSON.stringify([...seen, key].slice(-HINT_MAX))); } catch { /* private mode */ }
    const el = $("#st-thermal");
    el.innerHTML = `<span>${esc(t("This looks like a circuit board."))}</span> <button type="button" class="st-link" data-a="thadd">${esc(t("Add thermal map…"))}</button>`
      + `<button type="button" class="st-x" data-a="thx" aria-label="${esc(t("Close"))}" title="${esc(t("Close"))}">×</button>`;
    el.title = t("Open the board's thermal package (temperatures from the board design app) to see them on the model");
    el.hidden = false;
  }
  private hideHint() { const el = $("#st-thermal"); el.hidden = true; el.innerHTML = ""; }
  /** Whether the board hint is on screen (tests). */
  hintShown() { return !$("#st-thermal").hidden; }
  /** A model file was closed for good: its map is dropped. */
  forget(key: string) { const a = this.maps.get(key); if (a?.picture) URL.revokeObjectURL(a.picture); this.maps.delete(key); }

  // ---------- drawing ----------

  private shiftOf(a: Attached): V3 { return a.fitted ? a.match.shift : [0, 0, 0]; }
  /** Colour range in °C: fixed, else the package's own range, else what the mesh holds. */
  rangeOf(a: Attached): [number, number] {
    if (a.cmp?.view === "d") return a.range ?? deltaRange(a.cmp.delta);
    if (a.range) return a.range;
    if (a.cmp) {
      // A and B on one range, so flipping between them compares like with like (FR-TMAP-031)
      const r = a.pkg.manifest.range ?? a.pkg.mesh.range, q = a.cmp.pkg.manifest.range ?? a.cmp.pkg.mesh.range;
      const lo = Math.min(r[0], q[0]), hi = Math.max(r[1], q[1]);
      return hi > lo ? [lo, hi] : [lo, lo + 1];
    }
    const r = a.pkg.manifest.range ?? a.pkg.mesh.range;
    return r[1] > r[0] ? [r[0], r[1]] : [r[0], r[0] + 1];
  }

  private clear() {
    for (const s of this.saved) s.mesh.material = s.mat;
    this.saved = [];
    if (this.fade) { this.fade.removeFromParent(); this.fade.geometry.dispose(); this.fade = null; }
    if (this.overlay) { this.overlay.removeFromParent(); (this.overlay.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void }).disposeBoundsTree?.(); this.overlay.geometry.dispose(); this.overlay = null; }
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.atlasTex?.dispose();
    this.atlasTex = null;
    this.atlas = null;
    this.pcbBoard = 0;
    this.drawn = null;
    this.visKey = "";
    this.hideCard();
    this.host.viewer.invalidate();
  }

  /** Bodies of the model hidden by the user, as a key: the map leaves their parts out too. */
  private visibility(a: Attached) {
    const v = this.host.viewer;
    let s = "";
    for (const [id, list] of a.match.bodies) if (list.every(i => v.parts[i] && !v.parts[i].visible)) s += `${id},`;
    return s;
  }

  private show() {
    this.clear();
    const a = this.cur(), v = this.host.viewer;
    // a heat-source table alone has nothing to draw
    if (!a || !a.on || a.pkg.sourcesOnly) return;
    const m = a.pkg.mesh, n = m.temp.length, sh = this.shiftOf(a);
    const pos = new Float32Array(m.pos.length);
    for (let i = 0; i < n; i++) { pos[i * 3] = m.pos[i * 3] + sh[0]; pos[i * 3 + 1] = m.pos[i * 3 + 1] + sh[1]; pos[i * 3 + 2] = m.pos[i * 3 + 2] + sh[2]; }
    // parts whose bodies are hidden in the model are left out
    const off = new Set<number>();
    const vis = this.visibility(a);
    for (const s of vis.split(",")) if (s) off.add(Number(s));
    // an isolated part is drawn alone (and picked alone); the rest goes into a see-through mesh
    const iso = a.iso !== null && a.stats.has(a.iso) && !off.has(a.iso) ? a.iso : null;
    const keep: number[] = [], rest: number[] = [];
    for (let k = 0; k < m.part.length; k++) { const id = m.part[k]; if (off.has(id)) continue; (iso === null || id === iso ? keep : rest).push(k); }
    const indexOf = (ks: number[]) => { const ix = new Uint32Array(ks.length * 3); ks.forEach((k, j) => { ix[j * 3] = m.tri[k * 3]; ix[j * 3 + 1] = m.tri[k * 3 + 1]; ix[j * 3 + 2] = m.tri[k * 3 + 2]; }); return ix; };
    const drawn = Uint32Array.from(keep), index = keep.length === m.part.length ? m.tri : indexOf(keep);
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.computeVertexNormals();
    (geo as THREE.BufferGeometry & { computeBoundsTree?: (o: object) => void }).computeBoundsTree?.({ indirect: true });
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    mat.clippingPlanes = v.clipPlanes;
    this.pcbTexture(a, geo, mat);
    const under = new THREE.MeshBasicMaterial({ visible: false });
    this.mats.push(mat, under);
    // the matched bodies stay for picking and measuring, unseen (a map that does not fit hides nothing)
    if (!misfit(a.match) || a.fitted) for (const list of a.match.bodies.values()) for (const i of list) {
      const p = v.parts[i];
      if (!p) continue;
      this.saved.push({ mesh: p.mesh, mat: p.mesh.material });
      p.mesh.material = under;
    }
    this.overlay = new THREE.Mesh(geo, mat);
    this.overlay.userData.thermalMap = true;
    this.overlay.raycast = () => {};
    v.modelRoot.add(this.overlay);
    if (rest.length) {
      const fg = new THREE.BufferGeometry();
      fg.setIndex(new THREE.BufferAttribute(indexOf(rest), 1));
      fg.setAttribute("position", geo.getAttribute("position"));
      fg.setAttribute("normal", geo.getAttribute("normal"));
      fg.setAttribute("color", geo.getAttribute("color"));
      if (geo.getAttribute("uv")) fg.setAttribute("uv", geo.getAttribute("uv"));
      const fm = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.8, side: THREE.DoubleSide, transparent: true, opacity: ISO_FADE, depthWrite: false, map: this.atlasTex });
      fm.clippingPlanes = v.clipPlanes;
      this.mats.push(fm);
      this.fade = new THREE.Mesh(fg, fm);
      this.fade.userData.thermalFade = true;
      this.fade.raycast = () => {};
      this.fade.renderOrder = 1;
      v.modelRoot.add(this.fade);
    }
    this.drawn = drawn;
    this.visKey = vis;
    this.colour();
    if (!this.bound) {
      this.bound = true;
      v.onRender(() => {
        const c = this.cur();
        if (c && c.on && this.overlay && this.visibility(c) !== this.visKey) { this.show(); this.renderLabels(); return; }
        this.place();
      });
    }
    v.invalidate();
  }

  private colour() {
    const a = this.cur(), ov = this.overlay;
    if (!a || !ov) return;
    const [lo, hi] = this.rangeOf(a), span = hi - lo || 1, temp = this.tempOf(a), pal = this.delta(a) ? "diverging" : this.prefs.palette;
    const at = ov.geometry.getAttribute("color") as THREE.BufferAttribute, arr = at.array as Float32Array;
    for (let i = 0; i < temp.length; i++) paletteColor(pal, (temp[i] - lo) / span, arr, i * 3);
    at.needsUpdate = true;
    this.host.viewer.invalidate();
  }

  // ---------- board layers under the map (FR-TMAP-012) ----------

  /** Puts the Gerber atlas on the map's board faces: texture coordinates per point and the material's map. */
  private pcbTexture(a: Attached, geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial) {
    const pc = a.pcb;
    if (!pc?.shown) return;
    const m = a.pkg.mesh, L = pc.layers;
    const pos = geo.getAttribute("position").array as Float32Array;
    const f = pcbFit(pos, m.tri, m.part, L.box, pc.du, pc.dv, m.face);
    if (!f) return;
    const { uv, board } = pcbUvs(pos, m.tri, m.part, f, L.box, L.w);
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.atlas = pcbAtlas(L, this.prefs.pcbMix, WHITE_PX);
    const tex = new THREE.CanvasTexture(this.atlas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.atlasTex = tex;
    this.pcbBoard = board;
    mat.map = tex;
  }

  /** How strongly the board's layers show under the map (0..1). */
  setPcbMix(mix: number) {
    this.prefs.pcbMix = Math.max(0, Math.min(1, mix));
    this.savePrefs();
    const a = this.cur();
    if (this.atlas && this.atlasTex && a?.pcb) { pcbAtlas(a.pcb.layers, this.prefs.pcbMix, WHITE_PX, this.atlas); this.atlasTex.needsUpdate = true; this.host.viewer.invalidate(); }
    const out = $("#th-legend").querySelector<HTMLElement>("[data-v=pcbmix]");
    if (out) out.textContent = `${Math.round(this.prefs.pcbMix * 100)} %`;
  }

  /** Asks for the board's Gerber set (files or a zip) and puts it under the map. */
  pickGerber() {
    let inp = document.querySelector<HTMLInputElement>("#th-gerber-input");
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file"; inp.multiple = true; inp.id = "th-gerber-input"; inp.hidden = true;
      inp.accept = ".zip,.gbr,.ger,.gtl,.gbl,.gto,.gbo,.gts,.gbs,.gm1,.gko,.drl,.xln,.txt,.art,.pho";
      inp.addEventListener("change", () => { const fs = [...(inp!.files ?? [])]; inp!.value = ""; if (fs.length) void this.addGerber(fs); });
      document.body.appendChild(inp);
    }
    inp.click();
  }

  /** Reads a Gerber set and draws it under the map of the model on screen. */
  async addGerber(files: File[]) {
    await this.addGerberData(await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() }))));
  }

  /** Reads a Gerber set (files or zips, as bytes) and draws it under the map; false when it could not be read. */
  async addGerberData(data: { name: string; data: ArrayBuffer }[], tell = true): Promise<boolean> {
    const a = this.cur();
    if (!a) return false;
    const name = gerberName(data.map(f => f.name));
    try {
      const layers = await pcbFromGerber(data, name);
      if (this.cur() !== a) return false;
      a.pcb = { layers, du: 0, dv: 0, shown: true };
      if (!a.on) a.on = true;
      this.show();
      this.renderAll();
      this.host.gerber?.(data);
      if (tell) toast(t("Board layers {name} under the map: {layers}", { name, layers: layers.labels.join(", ") }), "success");
      return true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast(m === "E-TH-GERBER" ? t("{name} has no copper or silkscreen layer.", { name }) : t("Could not read the board layers {name}: {err}", { name, err: m }), "error");
      return false;
    }
  }

  /** The map on screen already has board layers under it. */
  hasLayers() { return !!this.cur()?.pcb; }

  /** Moves the board's layers on the map (manual offset, mm). */
  setPcbOffset(du: number, dv: number) {
    const a = this.cur();
    if (!a?.pcb) return;
    a.pcb.du = du; a.pcb.dv = dv;
    this.show();
    this.renderAll();
  }

  /** The map's point under a place of the window: the package triangle, the point (package frame) and its temperature. */
  private hit(x: number, y: number): Probe & { tri: number } | null {
    const a = this.cur(), ov = this.overlay, v = this.host.viewer;
    if (!a || !ov || !this.drawn) return null;
    const r = v.renderer.domElement.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), v.camera);
    const hits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(ov, rc, hits);
    hits.sort((p, q) => p.distance - q.distance);
    const h = hits.find(x => v.clipPlanes.every(pl => pl.distanceToPoint(x.point) >= -1e-6));
    if (!h || h.faceIndex == null) return null;
    const k = this.drawn[h.faceIndex], m = a.pkg.mesh, sh = this.shiftOf(a);
    const p = ov.worldToLocal(h.point.clone());
    const q: V3 = [p.x - sh[0], p.y - sh[1], p.z - sh[2]];
    const c = (j: number): V3 => { const i = m.tri[k * 3 + j]; return [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]]; };
    const w = triWeights(q, c(0), c(1), c(2));
    const T = this.tempOf(a), tt = w[0] * T[m.tri[k * 3]] + w[1] * T[m.tri[k * 3 + 1]] + w[2] * T[m.tri[k * 3 + 2]];
    return { tri: k, p: q, t: tt, part: m.part[k] };
  }

  /** Temperature as shown: absolute, or the rise above ambient. */
  private shown(a: Attached, tC: number | undefined) {
    if (tC === undefined) return "–";
    const amb = this.ambient(a);
    return this.prefs.rise && amb !== undefined ? `+${deg(tC - amb)} °C` : `${deg(tC)} °C`;
  }

  // ---------- hover card, clicks ----------

  private hideCard() { if (this.card) this.card.hidden = true; }

  private cardHtml(a: Attached, id: number, at?: Probe & { tri: number }) {
    const dd = (l: string, v: string, cls = "") => `<dt>${esc(l)}</dt><dd${cls ? ` class="${cls}"` : ""} translate="no">${v}</dd>`;
    if (id === 0) {
      const flux = at && a.pkg.mesh.flux ? a.pkg.mesh.flux[at.tri] : undefined;
      return `<h4>${esc(t("Board"))}</h4><dl>${at ? dd(this.delta(a) ? t("Change here") : t("Temperature here"), esc(this.here(a, at.t))) : ""}${flux !== undefined && flux > 0 ? dd(t("Heat leaving to air"), `${esc(String(Math.round(flux)))} W/m²`) : ""}${dd(t("Hottest point"), esc(this.shown(a, a.stats.get(0)?.max)))}</dl>`;
    }
    const p = this.partOf(a, id);
    if (!p) return `<h4 translate="no">#${id}</h4>`;
    const tC = partTemp(p, a.stats), mg = partMargin(p, a.stats);
    const split = [p.pBoard ? `${t(PATH_LABEL.board)} ${watts(p.pBoard)} W` : "", p.pAir ? `${t(PATH_LABEL.air)} ${watts(p.pAir)} W` : "", p.pSink ? `${t(PATH_LABEL[p.path === "chassis" ? "chassis" : "heatsink"])} ${watts(p.pSink)} W` : ""].filter(Boolean).join(" / ");
    const cls = mg === undefined ? "" : mg < 0 ? "bad" : mg < 10 ? "warn" : "";
    return `<h4><span translate="no">${esc(p.designator)}</span>${p.part ? ` <small translate="no">${esc(p.part)}</small>` : ""}</h4><dl>`
      + (p.p !== undefined ? dd(t("Power"), `${esc(watts(p.p))} W`) : "")
      + (split ? dd(t("Heat goes to"), esc(split)) : "")
      + dd(p.tKind && KIND_LABEL[p.tKind] ? t("Temperature ({kind})", { kind: t(KIND_LABEL[p.tKind]) }) : t("Temperature"), esc(this.shown(a, tC)), cls)
      + (at ? dd(this.delta(a) ? t("Change here") : t("Temperature here"), esc(this.here(a, at.t))) : "")
      + (p.limit !== undefined ? dd(t("Limit"), `${esc(deg(p.limit))} °C`) : "")
      + (mg !== undefined ? dd(t("Margin"), `${esc(deg(mg))} °C`, cls) : "")
      + (p.life !== undefined ? dd(t("Estimated life"), `${esc(hours(p.life))} ${esc(t("h"))}${p.lifeBy === "computed" ? ` (${esc(t("computed"))})` : ""}`, p.life < this.prefs.life ? "bad" : "") : "")
      + (p.source ? dd(t("Operating point"), esc(p.source)) : "")
      + `</dl>`;
  }

  private hover() {
    const at = this.hoverAt, a = this.cur();
    if (!at || !a || !this.active()) return this.hideCard();
    const el = document.elementFromPoint(at.x, at.y);
    if (!el || el.tagName !== "CANVAS") return this.hideCard();
    const h = this.hit(at.x, at.y);
    if (!h) return this.hideCard();
    if (!this.card) { this.card = document.createElement("div"); this.card.id = "th-card"; this.card.className = "th-card"; this.card.setAttribute("role", "status"); $("#viewport").appendChild(this.card); }
    const c = this.card, vr = $("#viewport").getBoundingClientRect();
    const key = `${h.part}`;
    if (c.dataset.part !== key || this.probing || h.part === 0) { c.innerHTML = this.cardHtml(a, h.part, h); c.dataset.part = key; }
    c.hidden = false;
    const w = c.offsetWidth, hh = c.offsetHeight;
    let x = at.x - vr.left + 16, y = at.y - vr.top + 16;
    if (x + w > vr.width - 8) x = at.x - vr.left - w - 12;
    if (y + hh > vr.height - 8) y = at.y - vr.top - hh - 12;
    c.style.left = `${Math.max(4, x)}px`;
    c.style.top = `${Math.max(4, y)}px`;
  }

  private click(e: PointerEvent) {
    const a = this.cur();
    if (!a) return;
    const h = this.hit(e.clientX, e.clientY);
    if (this.probing) {
      if (!h) return;
      a.probes.push({ p: h.p, t: h.t, part: h.part });
      this.renderAll();
      return;
    }
    const id = h && h.part > 0 ? h.part : null;
    if (id === a.sel) return;
    a.sel = id;
    this.renderAll();
    if (id !== null) $("#th-side").querySelector<HTMLElement>(`tr[data-part="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /** Selects a part, turns the view to it and frames it. */
  private zoomTo(a: Attached, id: number, at?: V3) {
    const s = a.stats.get(id), sh = this.shiftOf(a);
    if (id > 0) a.sel = id;
    if (at) {
      const r = Math.max(8, this.host.viewer.modelSize / 12);
      this.host.viewer.fit(true, new THREE.Box3(new THREE.Vector3(at[0] + sh[0] - r, at[1] + sh[1] - r, at[2] + sh[2] - r), new THREE.Vector3(at[0] + sh[0] + r, at[1] + sh[1] + r, at[2] + sh[2] + r)));
    } else if (s) {
      const pad = Math.max(4, this.host.viewer.modelSize / 30);
      this.host.viewer.fit(true, new THREE.Box3(new THREE.Vector3(s.box[0] + sh[0] - pad, s.box[1] + sh[1] - pad, s.box[2] + sh[2] - pad), new THREE.Vector3(s.box[3] + sh[0] + pad, s.box[4] + sh[1] + pad, s.box[5] + sh[2] + pad)));
    } else if (a.match.bodies.get(id)?.length) {
      // no map (heat sources alone): the part's bodies in the model
      const v = this.host.viewer, box = new THREE.Box3(), pad = Math.max(4, v.modelSize / 30);
      for (const i of a.match.bodies.get(id)!) if (v.parts[i]) box.union(new THREE.Box3().setFromObject(v.parts[i].mesh));
      if (!box.isEmpty()) v.fit(true, box.expandByScalar(pad));
    }
    this.renderAll();
  }

  // ---------- labels ----------

  private renderLabels() {
    const a = this.cur();
    const on = !!a && this.active();
    if (!on) { this.layer?.replaceChildren(); this.pins = []; return; }
    if (!this.layer) {
      const el = this.layer = document.createElement("div");
      el.id = "th-labels";
      el.className = "sim-labels";
      $("#viewport").appendChild(el);
      el.addEventListener("click", e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rm]"), c = this.cur();
        if (b && c) { c.probes.splice(Number(b.dataset.rm), 1); this.renderAll(); }
      });
    }
    const items: { p: V3; html: string }[] = [];
    a!.probes.forEach((p, i) => items.push({ p: p.p, html: `<div class="sim-probe" data-probe="${i}"><i></i><span translate="no">${esc(this.here(a!, p.t))}</span><button data-rm="${i}" title="${esc(t("Remove probe"))}" aria-label="${esc(t("Remove probe"))}">×</button></div>` }));
    if (this.prefs.labels) {
      const peak = (id: number, warn: boolean) => {
        const s = a!.stats.get(id);
        if (!s) return;
        const p = id > 0 ? this.partOf(a!, id) : undefined;
        const row = a!.cmp && a!.cmp.view !== "a" ? a!.cmp.changes.rows.find(r => r.ia === id) : undefined;
        if (a!.cmp && a!.cmp.view !== "a" && !row) return;
        const txt = row ? (a!.cmp!.view === "d" ? this.here(a!, row.d) : this.shown(a!, row.b)) : this.shown(a!, p ? partTemp(p, a!.stats) : s.max);
        items.push({ p: s.at, html: `<div class="sim-probe sim-peak${warn ? " warn" : ""}${a!.sel === id && id > 0 ? " sel" : ""}" data-peak="${id}"><i></i><span><b translate="no">${esc(this.nameOf(a!, id))}</b> <span translate="no">${esc(txt)}</span></span></div>` });
      };
      const over = this.problemsOf(a!).filter(p => p.kind === "over").slice(0, 12).map(p => p.id);
      const sm = summary(a!.pkg, a!.stats);
      const hot = sm.hottest?.id ?? sm.peak.id;
      const done = new Set<number>();
      if (a!.iso !== null) { done.add(a!.iso); peak(a!.iso, over.includes(a!.iso)); over.length = 0; done.add(hot); done.add(0); }
      for (const id of over) { done.add(id); peak(id, true); }
      if (!done.has(hot)) { done.add(hot); peak(hot, false); }
      if (a!.stats.has(0) && !done.has(0)) { done.add(0); peak(0, (a!.stats.get(0)!.max) > this.prefs.board); }
      if (a!.sel !== null && !done.has(a!.sel)) peak(a!.sel, false);
      // comparing: the parts that changed most
      if (a!.iso === null && a!.cmp && a!.cmp.view !== "a") {
        const rs = a!.cmp.changes.rows, up = rs.reduce<PartChange | null>((m, r) => (r.d > 0 && (!m || r.d > m.d) ? r : m), null);
        for (const r of [...(up ? [up] : []), ...rs.slice(0, 5)]) if (!done.has(r.ia)) { done.add(r.ia); peak(r.ia, false); }
      }
    }
    this.layer.innerHTML = items.map(i => i.html).join("");
    this.pins = items.map((it, k) => ({ p: it.p, el: this.layer!.children[k] as HTMLElement }));
    this.place();
  }

  private place() {
    const a = this.cur(), ov = this.overlay;
    if (!a || !ov || !this.pins.length) return;
    const v = this.host.viewer, c = v.renderer.domElement, sh = this.shiftOf(a), q = new THREE.Vector3();
    const vr = $("#viewport").getBoundingClientRect(), cr = c.getBoundingClientRect();
    for (const pin of this.pins) {
      q.set(pin.p[0] + sh[0], pin.p[1] + sh[1], pin.p[2] + sh[2]);
      ov.localToWorld(q).project(v.camera);
      const out = q.z > 1 || q.z < -1;
      pin.el.style.display = out ? "none" : "";
      pin.el.style.left = `${cr.left - vr.left + (q.x * 0.5 + 0.5) * cr.width}px`;
      pin.el.style.top = `${cr.top - vr.top + (-q.y * 0.5 + 0.5) * cr.height}px`;
    }
  }

  // ---------- panes ----------

  renderAll() {
    this.renderBar();
    this.renderSide();
    this.renderLegend();
    this.renderSummary();
    this.renderLabels();
    $("#viewport").classList.toggle("sim-probing", this.probing && this.active());
  }

  private renderBar() {
    const el = $("#th-tools");
    if (cmTab() !== "thermal") return;
    const a = this.cur();
    if (!a) { el.innerHTML = ""; return; }
    const bare = !!a.pkg.sourcesOnly;
    const btn = (id: string, label: string, title: string, o: { on?: boolean; dis?: boolean } = {}) =>
      `<button class="mc-b${o.on ? " on" : ""}" data-th="${id}" title="${esc(title)}"${o.on != null ? ` aria-pressed="${!!o.on}"` : ""}${o.dis ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${ICON[id]}</span><span class="mc-l">${esc(label)}</span></button>`;
    const group = (label: string, inner: string) => `<div class="mc-g" role="group" aria-label="${esc(label)}">${inner}</div>`;
    const sep = `<div class="mc-sep"></div>`;
    if (bare) {
      // heat sources alone (FR-TPKG-015): no map to show, only the powers to simulate with
      el.innerHTML = group(t("Parts"), btn("parts", t("Parts"), t("The heat sources with their power and limit")))
        + sep + group(t("Study"), btn("simulate", t("Simulate"), t("Simulate in MöbiusCAD: an assembly of the board's parts with a thermal study whose heat comes from this table, where you can add a heatsink or change the cooling")))
        + sep + group(t("Package"), btn("add", t("Thermal map"), t("Open a thermal package for this model in place of the heat sources")) + btn("remove", t("Remove heat sources"), t("Take the heat sources off this model")));
      return;
    }
    el.innerHTML = group(t("Thermal map"), btn("map", t("Map"), t("Show or hide the temperatures on the model"), { on: a.on })
      + btn("flip", a.top ? t("Bottom") : t("Top"), t("Turn the view to the board's other face"), { dis: !a.on })
      + btn("labels", t("Hot spots"), t("Labels on the hottest point and on every part over its limit"), { on: this.prefs.labels, dis: !a.on })
      + btn("probe", t("Probe"), t("Click the map to read the temperature at a point"), { on: this.probing, dis: !a.on })
      + btn("isolate", t("Isolate"), t("Show the selected part alone, the others see-through (double-click a part)"), { on: a.iso !== null, dis: !a.on || (a.sel === null && a.iso === null) })
      + btn("gerber", t("Board layers"), a.pcb ? t("Show or hide the board's copper and silkscreen under the temperatures") : t("Open the board's Gerber set to see its copper and silkscreen under the temperatures"), { on: !!a.pcb?.shown, dis: !a.on }))
      + sep + group(t("Parts"), btn("parts", t("Parts"), t("The parts of the map with their power, temperature and margin")))
      + sep + group(t("Study"), btn("simulate", t("Simulate"), a.own ? t("Open the board's STEP to measure it or simulate it.") : t("Simulate in MöbiusCAD: an assembly of the board's parts with a thermal study from this package, where you can add a heatsink or change the cooling"), { dis: a.own }))
      + sep + group(t("Package"), btn("png", t("Save picture"), t("Save the view as a PNG with the colour scale, the hottest part and the accuracy drawn in"), { dis: !a.on }) + btn("add", t("Another map"), t("Open another thermal package for this model: put it in place of this one, or compare the two")) + btn("remove", t("Remove map"), t("Take the thermal map off this model")));
  }

  private barClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-th]"), a = this.cur();
    if (!b || !a) return;
    const k = b.dataset.th;
    if (k === "map") this.setOn(!a.on);
    else if (k === "flip") { a.top = !a.top; this.host.viewer.viewFrom(new THREE.Vector3(0, 0, a.top ? 1 : -1)); this.renderBar(); }
    else if (k === "labels") { this.prefs.labels = !this.prefs.labels; this.savePrefs(); this.renderAll(); }
    else if (k === "probe") { this.probing = !this.probing; this.renderAll(); }
    else if (k === "isolate") this.isolate(a.iso !== null ? null : a.sel);
    else if (k === "gerber") { if (!a.pcb) this.pickGerber(); else { a.pcb.shown = !a.pcb.shown; this.show(); this.renderAll(); } }
    else if (k === "png") this.host.savePicture();
    else if (k === "parts") this.host.showTab();
    else if (k === "simulate") this.host.simulate(a.pkg, a.match, this.bodies());
    else if (k === "add") this.host.addMap();
    else if (k === "remove") this.detach();
  }

  /** Shows or hides the map of the model on screen. */
  setOn(on: boolean) {
    const a = this.cur();
    if (!a || a.on === on) return;
    a.on = on;
    if (!on) this.probing = false;
    this.show();
    this.renderAll();
  }

  /** Shows one part alone, the others faded (FR-TMAP-020), or every part again (null). */
  isolate(id: number | null) {
    const a = this.cur();
    if (!a || a.iso === id) return;
    a.iso = id;
    if (id !== null) a.sel = id;
    if (!a.on) a.on = true;
    this.show();
    this.renderAll();
  }

  private sorted(a: Attached): ThermalPart[] {
    const f = a.filter.trim().toLowerCase();
    let list = a.pkg.manifest.parts.filter(p => !f || p.designator.toLowerCase().includes(f) || p.part.toLowerCase().includes(f));
    const { col, up } = a.sort;
    if (col === "margin" && up) return byMargin(list, a.stats);
    const val = (p: ThermalPart): number | string | undefined => col === "name" ? p.designator : col === "p" ? p.p : col === "t" ? partTemp(p, a.stats) : col === "limit" ? p.limit : col === "margin" ? partMargin(p, a.stats) : p.life;
    list = [...list].sort((x, y) => {
      const u = val(x), w = val(y);
      if (u === undefined || w === undefined) return u === w ? x.id - y.id : u === undefined ? 1 : -1;
      const c = typeof u === "string" ? u.localeCompare(String(w), undefined, { numeric: true }) : u - (w as number);
      return (up ? c : -c) || x.id - y.id;
    });
    return list;
  }

  private rowsHtml(a: Attached) {
    const miss = new Set(a.match.missing), changed = new Set(a.match.changed);
    return this.sorted(a).map(p => {
      const tC = partTemp(p, a.stats), mg = partMargin(p, a.stats);
      const cls = [mg === undefined ? "" : mg < 0 ? "bad" : mg < 10 ? "warn" : "", a.sel === p.id ? "sel" : "", !a.own && miss.has(p.id) ? "miss" : "", changed.has(p.id) ? "chg" : ""].filter(Boolean).join(" ");
      return `<tr data-part="${p.id}" tabindex="0"${cls ? ` class="${cls}"` : ""}><td><span translate="no">${esc(p.designator)}</span>${p.part ? ` <small translate="no">${esc(p.part)}</small>` : ""}</td>`
        + `<td translate="no">${esc(watts(p.p))}</td><td data-v="t" translate="no">${esc(deg(tC))}</td><td translate="no">${esc(deg(p.limit))}</td><td data-v="margin" translate="no">${esc(deg(mg))}</td><td translate="no"${p.life !== undefined ? ` title="${esc(hours(p.life))}"` : ""}>${p.life !== undefined ? esc(kHours(p.life)) : ""}</td></tr>`;
    }).join("");
  }
  private renderRows() { const a = this.cur(), tb = $("#th-side").querySelector("tbody[data-v=rows]"); if (a && tb) tb.innerHTML = a.pkg.sourcesOnly ? this.sourceRows(a) : this.rowsHtml(a); }

  private problemText(a: Attached, p: ThermalProblem) {
    const name = this.nameOf(a, p.id);
    if (p.kind === "over") return t("{name}: {v} °C over its limit of {limit} °C", { name, v: deg(p.value), limit: deg(p.limit) });
    if (p.kind === "life") return t("{name}: estimated life {h} h", { name, h: hours(p.value) });
    return t("Board: {v} °C, over its limit of {limit} °C", { v: deg(p.value), limit: deg(p.limit) });
  }

  private renderSide() {
    const el = $("#th-side"), a = this.cur();
    if (!a) { el.innerHTML = ""; return; }
    if (a.pkg.sourcesOnly) { el.innerHTML = this.sourcesHtml(a); return; }
    const mf = a.pkg.manifest, s = mf.settings, sm = summary(a.pkg, a.stats);
    const probs = this.problemsOf(a);
    const total = a.pkg.manifest.parts.length + (a.stats.has(0) ? 1 : 0), found = total - a.match.missing.length;
    const src = [mf.app, mf.created ? mf.created.slice(0, 10) : ""].filter(Boolean).join(", ");
    const set = [s.ambient !== undefined ? t("ambient {v} °C", { v: deg(s.ambient) }) : "", s.enclosure ? setting(s.enclosure) : "", s.orientation ? setting(s.orientation) : "", s.operatingPoint ? t("operating point {v}", { v: s.operatingPoint }) : "", s.grid ? t("grid {v} mm", { v: String(s.grid) }) : ""].filter(Boolean).join(" · ");
    const th = (col: SortCol, label: string, title = "") => `<th data-sort="${col}" tabindex="0" role="columnheader" aria-sort="${a.sort.col === col ? (a.sort.up ? "ascending" : "descending") : "none"}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}${a.sort.col === col ? (a.sort.up ? " ▲" : " ▼") : ""}</th>`;
    const extra = [
      ...(!a.own ? a.match.missing.map(id => `<li class="miss" data-goto="${id}">${esc(t("{name}: not in this model", { name: this.nameOf(a, id) }))}</li>`) : []),
      ...a.match.changed.map(id => `<li class="chg" data-goto="${id}">${esc(t("{name}: changed since the map was made", { name: this.nameOf(a, id) }))}</li>`),
    ];
    const bad = misfit(a.match) && !a.fitted;
    el.innerHTML = `<div class="th-sec th-src"><h4 translate="no">${esc(mf.design || a.pkg.name)}</h4>`
      + (src ? `<p class="muted" data-v="source">${esc(t("From {app}", { app: "\u0001" })).replace("\u0001", `<span translate="no">${esc(src)}</span>`)}</p>` : "")
      + (set ? `<p class="muted" data-v="settings">${esc(set)}</p>` : "")
      + (mf.accuracy !== undefined ? `<p class="muted" data-v="accuracy">${esc(t("Estimate ±{v} °C", { v: deg(mf.accuracy) }))}</p>` : "")
      + (a.own ? `<p class="th-note" data-v="own">${esc(t("Open the board's STEP to measure it or simulate it."))}</p>`
        : `<p class="${a.match.missing.length ? "th-note" : "muted"}" data-v="matched">${esc(t("{n} of {m} parts matched", { n: found, m: total }))}</p>`)
      + (bad ? `<p class="th-warn" data-v="misfit">${esc(t("The map does not fit this model (about {v} mm off).", { v: a.match.off.toFixed(1) }))} <button class="btn small" data-a="fit">${esc(t("Fit by parts"))}</button></p>` : "")
      + (a.picture ? `<a class="th-pic" href="${a.picture}" target="_blank" rel="noopener" title="${esc(t("Picture from the design app"))}"><img src="${a.picture}" alt="${esc(t("Picture from the design app"))}" /></a>` : "")
      + `</div>`
      + this.compareHtml(a)
      + `<div class="th-sec th-probs"><h4>${esc(t("Problems"))} <span class="pill" data-v="nprob">${probs.length + extra.length}</span></h4>`
      + (probs.length + extra.length ? `<ul class="th-list">${probs.map((p, i) => `<li class="${p.kind === "over" || p.kind === "board" ? "bad" : "warn"}" data-prob="${i}" tabindex="0">${esc(this.problemText(a, p))}</li>`).join("")}${extra.join("")}</ul>` : `<p class="muted" data-v="noprob">${esc(t("No part is over its limit."))}</p>`)
      + `</div>`
      + `<div class="th-sec th-parts"><h4>${esc(t("Parts"))} <span class="pill">${mf.parts.length}</span></h4>`
      + `<input type="search" data-k="filter" value="${esc(a.filter)}" placeholder="${esc(t("Filter by designator or value"))}" aria-label="${esc(t("Filter by designator or value"))}" />`
      + `<div class="th-tablewrap"><table class="th-table"><thead><tr>${th("name", t("Part"))}${th("p", "W", t("Power"))}${th("t", "°C", t("Temperature"))}${th("limit", t("Limit"))}${th("margin", t("Margin"))}${th("life", t("Life, h"), t("Estimated life of electrolytic capacitors"))}</tr></thead><tbody data-v="rows">${this.rowsHtml(a)}</tbody></table></div></div>`
      + `<div class="th-sec th-budget"><h4>${esc(t("Heat budget"))}</h4><dl class="sim-kv"><dt>${esc(t("Total power"))}</dt><dd data-v="power" translate="no">${esc(watts(sm.power))} W</dd>`
      + (["board", "air", "heatsink", "chassis"] as const).filter(k => sm.split[k] > 0).map(k => `<dt>${esc(t("To the {path}", { path: t(PATH_LABEL[k]) }))}</dt><dd translate="no">${esc(watts(sm.split[k]))} W</dd>`).join("") + `</dl></div>`
      + (a.probes.length ? `<div class="th-sec th-probes"><h4>${esc(t("Probes"))}</h4><table class="th-table"><thead><tr><th>#</th><th>X</th><th>Y</th><th>Z</th><th>°C</th><th></th></tr></thead><tbody>${a.probes.map((p, i) => `<tr><td>${i + 1}</td><td translate="no">${p.p[0].toFixed(1)}</td><td translate="no">${p.p[1].toFixed(1)}</td><td translate="no">${p.p[2].toFixed(1)}</td><td data-v="probe" translate="no">${esc(deg(p.t))}</td><td><button class="sim-ib" data-a="rmprobe" data-i="${i}" title="${esc(t("Remove probe"))}" aria-label="${esc(t("Remove probe"))}">×</button></td></tr>`).join("")}</tbody></table><button class="btn small" data-a="probecsv">${esc(t("Export CSV"))}</button></div>` : "")
      + `<div class="th-sec th-set"><h4>${esc(t("Checks"))}</h4>`
      + `<label class="ana-row"><span>${esc(t("Shortest capacitor life, h"))}</span><input type="text" inputmode="decimal" data-k="life" value="${this.prefs.life}" /></label>`
      + `<label class="ana-row"><span>${esc(t("Highest board temperature, °C"))}</span><input type="text" inputmode="decimal" data-k="board" value="${this.prefs.board}" /></label></div>`;
  }

  private sourceRows(a: Attached) {
    const miss = new Set(a.match.missing);
    return this.sorted(a).map(p => `<tr data-part="${p.id}" tabindex="0" class="${[miss.has(p.id) ? "miss" : "", a.sel === p.id ? "sel" : ""].filter(Boolean).join(" ")}"><td><span translate="no">${esc(p.designator)}</span>${p.part ? ` <small translate="no">${esc(p.part)}</small>` : ""}</td><td translate="no">${esc(watts(p.p))}</td><td translate="no">${esc(deg(p.limit))}</td></tr>`).join("");
  }

  /** The side panel for a heat-source table alone (FR-TPKG-015): what was found in the model and the powers. */
  private sourcesHtml(a: Attached) {
    const mf = a.pkg.manifest, sm = summary(a.pkg, a.stats);
    const total = mf.parts.length, found = total - a.match.missing.length;
    const rows = this.sourceRows(a);
    const th = (col: SortCol, label: string, title = "") => `<th data-sort="${col}" tabindex="0" role="columnheader" aria-sort="${a.sort.col === col ? (a.sort.up ? "ascending" : "descending") : "none"}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}${a.sort.col === col ? (a.sort.up ? " ▲" : " ▼") : ""}</th>`;
    return `<div class="th-sec th-src"><h4 translate="no">${esc(a.pkg.name)}</h4>`
      + `<p class="muted" data-v="sources">${esc(t("Heat sources alone: no temperature map. Simulate makes a thermal study with these powers."))}</p>`
      + `<p class="${a.match.missing.length ? "th-note" : "muted"}" data-v="matched">${esc(t("{n} of {m} parts matched", { n: found, m: total }))}</p>`
      + (a.match.missing.length ? `<ul class="th-list">${a.match.missing.map(id => `<li class="miss" data-goto="${id}">${esc(t("{name}: not in this model", { name: this.nameOf(a, id) }))}</li>`).join("")}</ul>` : "")
      + `<button class="btn small primary" data-a="simulate">${esc(t("Simulate"))}</button></div>`
      + `<div class="th-sec th-parts"><h4>${esc(t("Parts"))} <span class="pill">${total}</span></h4>`
      + `<input type="search" data-k="filter" value="${esc(a.filter)}" placeholder="${esc(t("Filter by designator or value"))}" aria-label="${esc(t("Filter by designator or value"))}" />`
      + `<div class="th-tablewrap"><table class="th-table th-stable"><thead><tr>${th("name", t("Part"))}${th("p", "W", t("Power"))}${th("limit", t("Limit"))}</tr></thead><tbody data-v="rows">${rows}</tbody></table></div></div>`
      + `<div class="th-sec th-budget"><h4>${esc(t("Heat budget"))}</h4><dl class="sim-kv"><dt>${esc(t("Total power"))}</dt><dd data-v="power" translate="no">${esc(watts(sm.power))} W</dd></dl></div>`;
  }

  /** The parts by how much their temperature changed between the two maps (FR-TMAP-030). */
  private compareHtml(a: Attached) {
    const c = a.cmp;
    if (!c) return "";
    const nm = (x: ThermalPackage) => x.manifest.design || x.name, ch = c.changes;
    const d = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${deg(Math.abs(v))}`;
    return `<div class="th-sec th-cmp"><h4>${esc(t("Compare"))}</h4><p class="muted" data-v="pair">A <span translate="no">${esc(nm(a.pkg))}</span> · B <span translate="no">${esc(nm(c.pkg))}</span></p>`
      + `<div class="th-tablewrap"><table class="th-table th-ctable"><thead><tr><th>${esc(t("Part"))}</th><th>A, °C</th><th>B, °C</th><th title="${esc(t("B − A"))}">Δ, K</th></tr></thead><tbody>`
      + ch.rows.map(r => `<tr data-cpart="${r.ia}" class="${r.d > 0.05 ? "up" : r.d < -0.05 ? "down" : ""}"><td translate="no">${esc(r.ia === 0 ? t("Board") : r.name)}</td><td translate="no">${esc(deg(r.a))}</td><td translate="no">${esc(deg(r.b))}</td><td data-v="dt" translate="no">${esc(d(r.d))}</td></tr>`).join("")
      + `</tbody></table></div>`
      + (ch.onlyA.length ? `<p class="muted" data-v="onlya">${esc(t("Only in A:"))} <span translate="no">${esc(ch.onlyA.join(", "))}</span></p>` : "")
      + (ch.onlyB.length ? `<p class="muted" data-v="onlyb">${esc(t("Only in B:"))} <span translate="no">${esc(ch.onlyB.join(", "))}</span></p>` : "")
      + `</div>`;
  }

  private sideClick(e: Event, dbl = false) {
    const a = this.cur(), tg = e.target as HTMLElement;
    if (!a) return;
    const act = tg.closest<HTMLElement>("[data-a]");
    if (act && !dbl) {
      const k = act.dataset.a;
      if (k === "fit") { a.fitted = true; this.show(); this.renderAll(); }
      else if (k === "rmprobe") { a.probes.splice(Number(act.dataset.i), 1); this.renderAll(); }
      else if (k === "probecsv") this.probeCsv(a);
      else if (k === "simulate") this.host.simulate(a.pkg, a.match, this.bodies());
      return;
    }
    const sort = tg.closest<HTMLElement>("[data-sort]");
    if (sort && !dbl) { const col = sort.dataset.sort as SortCol; a.sort = { col, up: a.sort.col === col ? !a.sort.up : col === "name" || col === "margin" || col === "life" }; this.renderSide(); return; }
    if (dbl) return;
    if ((e as MouseEvent).detail === 2) {
      // a second click on a row: that part alone (FR-TMAP-020). Counted on the click, since the first click
      // redraws the table and a dblclick then has no row to land on.
      const r = tg.closest<HTMLElement>("tr[data-part], tr[data-cpart]");
      if (r && !a.pkg.sourcesOnly) { const id = Number(r.dataset.part ?? r.dataset.cpart); if (id > 0) { this.isolate(a.iso === id ? null : id); return; } }
    }
    const crow = tg.closest<HTMLElement>("tr[data-cpart]");
    if (crow) { if (!a.on) this.setOn(true); this.zoomTo(a, Number(crow.dataset.cpart)); return; }
    const row = tg.closest<HTMLElement>("tr[data-part]");
    if (row) { if (!a.on) this.setOn(true); this.zoomTo(a, Number(row.dataset.part)); return; }
    const prob = tg.closest<HTMLElement>("[data-prob]");
    if (prob) { const p = this.problemsOf(a)[Number(prob.dataset.prob)]; if (p) { if (!a.on) this.setOn(true); this.zoomTo(a, p.id, p.id === 0 ? p.at : undefined); } return; }
    const go = tg.closest<HTMLElement>("[data-goto]");
    if (go) this.zoomTo(a, Number(go.dataset.goto));
  }

  private sideChange(e: Event) {
    const el = e.target as HTMLInputElement, k = el.dataset.k;
    if (k !== "life" && k !== "board") return;
    const v = num(el.value);
    if (v === null || (k === "life" && v <= 0)) { el.value = String(this.prefs[k]); return; }
    this.prefs[k] = v;
    this.savePrefs();
    this.host.changed();
    this.renderAll();
  }

  private probeCsv(a: Attached) {
    const rows = [["Probe", "X (mm)", "Y (mm)", "Z (mm)", "Part", "Temperature (°C)"], ...a.probes.map((p, i) => [String(i + 1), p.p[0].toFixed(3), p.p[1].toFixed(3), p.p[2].toFixed(3), p.part === 0 ? "Board" : this.partOf(a, p.part)?.designator ?? `#${p.part}`, String(+p.t.toFixed(2))])];
    download(new Blob([rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" }), `${a.pkg.name}-probes.csv`);
  }

  private renderLegend() {
    const el = $("#th-legend"), a = this.cur();
    const show = !!a && this.active();
    el.hidden = !show;
    if (!show) { el.innerHTML = ""; return; }
    const [lo, hi] = this.rangeOf(a!), mr = a!.pkg.mesh.range, amb = this.ambient(a!), mf = a!.pkg.manifest;
    const rise = this.prefs.rise && amb !== undefined, off = rise ? amb! : 0;
    const src = [mf.app, mf.created ? mf.created.slice(0, 10) : ""].filter(Boolean).join(", ");
    const cmp = a!.cmp, dl = cmp?.view === "d";
    const nm = (x: ThermalPackage) => x.manifest.design || x.name;
    el.innerHTML = `<div class="ana-head"><strong>${esc(dl ? t("Temperature change") : rise ? t("Temperature rise") : t("Temperature"))}</strong>`
      + `<button class="sim-ib" data-a="close" title="${esc(t("Hide the map"))}" aria-label="${esc(t("Hide the map"))}">×</button></div>`
      + (cmp ? `<label class="ana-row" title="${esc(t("B flips between the two maps"))}"><span>${esc(t("Show"))}</span><select data-k="show"><option value="a"${cmp.view === "a" ? " selected" : ""}>A: ${esc(nm(a!.pkg))}</option><option value="b"${cmp.view === "b" ? " selected" : ""}>B: ${esc(nm(cmp.pkg))}</option><option value="d"${dl ? " selected" : ""}>${esc(t("Change (B − A)"))}</option></select></label>` : "")
      + (a!.iso !== null ? `<p class="ana-note" data-v="iso">${esc(t("Showing {name} only", { name: "\u0001" })).replace("\u0001", `<b translate="no">${esc(this.nameOf(a!, a!.iso))}</b>`)}</p><button class="btn small" data-a="unisolate">${esc(t("Show all parts"))}</button>` : "")
      + `<div class="ana-ramp" style="background:${paletteCss(dl ? "diverging" : this.prefs.palette)}"></div>`
      + (dl ? `<div class="ana-scale"><span data-v="min" translate="no">${esc(this.here(a!, lo).replace(" K", ""))}</span><span>K</span><span data-v="max" translate="no">${esc(this.here(a!, hi).replace(" K", ""))}</span></div>`
        : `<div class="ana-scale"><span data-v="min" translate="no">${mr[0] < lo - 1e-6 ? "▼ " : ""}${rise ? "+" : ""}${esc(deg(lo - off))}</span><span>°C</span><span data-v="max" translate="no">${mr[1] > hi + 1e-6 ? "▲ " : ""}${rise ? "+" : ""}${esc(deg(hi - off))}</span></div>`)
      + (cmp ? `<p class="ana-note" data-v="cmpnote">${esc(dl ? t("Blue: cooler in B, red: hotter in B.") : t("A and B share one colour range."))}</p><button class="btn small" data-a="uncompare">${esc(t("Stop comparing"))}</button>` : "")
      + (src ? `<p class="ana-note" data-v="source">${esc(t("From {app}", { app: "\u0001" })).replace("\u0001", `<span translate="no">${esc(src)}</span>`)}</p>` : "")
      + (amb !== undefined ? `<p class="ana-note" data-v="ambient">${esc(t("Ambient {v} °C", { v: deg(amb) }))}${mf.settings.operatingPoint ? ` · ${esc(t("operating point {v}", { v: mf.settings.operatingPoint }))}` : ""}</p>` : "")
      + (mf.accuracy !== undefined ? `<p class="ana-note" data-v="accuracy">${esc(t("Estimate ±{v} °C", { v: deg(mf.accuracy) }))}</p>` : "")
      + (misfit(a!.match) && !a!.fitted ? `<p class="th-warn" data-v="misfit">${esc(t("The map does not fit this model (about {v} mm off).", { v: a!.match.off.toFixed(1) }))} <button class="btn small" data-a="fit">${esc(t("Fit by parts"))}</button></p>` : "")
      + (a!.match.changed.length ? `<p class="th-warn" data-v="older">${esc(t("The map is older than the model: {n} part changed|The map is older than the model: {n} parts changed", { n: a!.match.changed.length }))}</p>` : "")
      + `<label class="ana-row"><span>${esc(t("Colours"))}</span><select data-k="palette">${PALETTE_NAMES.map(p => `<option value="${p}"${p === this.prefs.palette ? " selected" : ""}>${esc(t(PALETTE_LABEL[p]))}</option>`).join("")}</select></label>`
      + `<label class="ana-row"><span>${esc(t("Range"))}</span><select data-k="range"><option value="auto"${a!.range ? "" : " selected"}>${esc(t("Automatic"))}</option><option value="fixed"${a!.range ? " selected" : ""}>${esc(t("Fixed range"))}</option></select></label>`
      + (a!.range ? `<div class="ana-row"><input type="text" inputmode="decimal" data-k="rmin" value="${deg(lo)}" aria-label="${esc(t("Lowest temperature of the scale, °C"))}" /><span>…</span><input type="text" inputmode="decimal" data-k="rmax" value="${deg(hi)}" aria-label="${esc(t("Highest temperature of the scale, °C"))}" /></div>` : "")
      + this.pcbHtml(a!)
      + `<label class="chk"><input type="checkbox" data-k="labels"${this.prefs.labels ? " checked" : ""} />${esc(t("Hot spot labels"))}</label>`
      + (amb !== undefined ? `<label class="chk"><input type="checkbox" data-k="rise"${this.prefs.rise ? " checked" : ""} />${esc(t("Rise above ambient"))}</label>` : "")
      + `<div class="sim-probebar"><button class="btn small${this.probing ? " on" : ""}" data-a="probe" aria-pressed="${this.probing}" title="${esc(t("Click the map to read the temperature at a point"))}">${esc(t("Probe"))}</button>`
      + (a!.probes.length ? `<button class="btn small" data-a="noprobes">${esc(t("Clear probes"))}</button><button class="btn small" data-a="probecsv">${esc(t("Export CSV"))}</button>` : "") + `</div>`;
  }

  /** The legend's board layers rows (FR-TMAP-012). */
  private pcbHtml(a: Attached) {
    const pc = a.pcb;
    if (!pc) return "";
    const mix = Math.round(this.prefs.pcbMix * 100);
    return `<div class="th-pcb" data-v="pcb"><p class="ana-note">${esc(t("Board layers: {name}", { name: "\u0001" })).replace("\u0001", `<span translate="no">${esc(pc.layers.name)}</span>`)}</p>`
      + (pc.shown ? `<label class="ana-row" title="${esc(t("How strongly the copper and silkscreen show under the temperatures"))}"><span>${esc(t("Layers"))}</span><input type="range" min="0" max="100" step="5" data-k="pcbmix" value="${mix}" aria-label="${esc(t("How strongly the copper and silkscreen show under the temperatures"))}" /><output data-v="pcbmix" translate="no">${mix} %</output></label>`
        + `<div class="ana-row" title="${esc(t("Move the layers on the board when the outline is not centred on it, mm"))}"><span>${esc(t("Offset, mm"))}</span><input type="text" inputmode="decimal" data-k="pcbdx" value="${pc.du}" aria-label="${esc(t("Offset along the board's first axis, mm"))}" /><input type="text" inputmode="decimal" data-k="pcbdy" value="${pc.dv}" aria-label="${esc(t("Offset along the board's second axis, mm"))}" /></div>` : "")
      + `<div class="sim-probebar"><button class="btn small" data-a="pcbpick">${esc(t("Other Gerber set…"))}</button><button class="btn small" data-a="pcbclear">${esc(t("Remove layers"))}</button></div></div>`;
  }

  private legendClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]"), a = this.cur();
    if (!b || !a) return;
    const k = b.dataset.a;
    if (k === "close") this.setOn(false);
    else if (k === "probe") { this.probing = !this.probing; this.renderAll(); }
    else if (k === "noprobes") { a.probes = []; this.renderAll(); }
    else if (k === "probecsv") this.probeCsv(a);
    else if (k === "fit") { a.fitted = true; this.show(); this.renderAll(); }
    else if (k === "uncompare") this.uncompare();
    else if (k === "unisolate") this.isolate(null);
    else if (k === "pcbpick") this.pickGerber();
    else if (k === "pcbclear") { delete a.pcb; this.show(); this.renderAll(); }
  }

  private legendChange(e: Event) {
    const el = e.target as HTMLInputElement, k = el.dataset.k, a = this.cur();
    if (!a || !k) return;
    if (k === "show") { this.setView(el.value as "a" | "b" | "d"); return; }
    if (k === "pcbmix") return;
    if ((k === "pcbdx" || k === "pcbdy") && a.pcb) { const v = num(el.value); if (v !== null) this.setPcbOffset(k === "pcbdx" ? v : a.pcb.du, k === "pcbdy" ? v : a.pcb.dv); return; }
    if (k === "palette") { this.prefs.palette = el.value as PaletteName; this.savePrefs(); }
    else if (k === "labels") { this.prefs.labels = el.checked; this.savePrefs(); }
    else if (k === "rise") { this.prefs.rise = el.checked; this.savePrefs(); }
    else if (k === "range") a.range = el.value === "fixed" ? this.rangeOf(a) : null;
    else if (k === "rmin" || k === "rmax") {
      const v = num(el.value), r = this.rangeOf(a);
      const next: [number, number] = k === "rmin" ? [v ?? r[0], r[1]] : [r[0], v ?? r[1]];
      if (v !== null && next[1] > next[0]) a.range = next;
    }
    this.colour();
    this.renderAll();
  }

  private renderSummary() {
    const el = $("#th-summary"), a = this.cur();
    const show = !!a && this.active();
    el.hidden = !show;
    if (!show) { el.innerHTML = ""; return; }
    const sm = summary(a!.pkg, a!.stats), probs = this.problemsOf(a!), mf = a!.pkg.manifest;
    const hot = sm.hottest ?? { id: sm.peak.id, t: sm.peak.t };
    const life = sm.life;
    const head = `<button class="th-sum-h" data-a="fold" aria-expanded="${!this.prefs.folded}" title="${esc(this.prefs.folded ? t("Show the summary") : t("Fold the summary"))}"><span data-v="hottest">${esc(t("Hottest"))} <b translate="no">${esc(this.nameOf(a!, hot.id))} ${esc(this.shown(a!, hot.t))}</b></span><i aria-hidden="true">${this.prefs.folded ? "▸" : "▾"}</i></button>`;
    const over = probs.filter(p => p.kind === "over").length;
    const lines = this.prefs.folded ? "" : `<ul>`
      + `<li data-go="${hot.id}" tabindex="0" data-v="over" class="${over ? "bad" : ""}">${esc(over ? t("{n} part over its limit|{n} parts over their limits", { n: over }) : t("No part is over its limit."))}</li>`
      + (life ? `<li data-go="${life.id}" tabindex="0" data-v="life" class="${life.h < this.prefs.life ? "warn" : ""}">${esc(t("Shortest life: {name} {h} h", { name: this.nameOf(a!, life.id), h: hours(life.h) }))}</li>` : "")
      + (sm.board !== undefined ? `<li data-go="0" tabindex="0" data-v="board" class="${sm.board > this.prefs.board ? "bad" : ""}">${esc(t("Board up to {v}", { v: this.shown(a!, sm.board) }))}</li>` : "")
      + (mf.accuracy !== undefined ? `<li class="muted" data-v="accuracy">${esc(t("Estimate ±{v} °C", { v: deg(mf.accuracy) }))}</li>` : "")
      + `</ul>`;
    el.innerHTML = head + lines;
    el.classList.toggle("folded", this.prefs.folded);
  }

  private summaryClick(e: Event) {
    const a = this.cur(), tg = e.target as HTMLElement;
    if (!a) return;
    if (tg.closest("[data-a=fold]")) { this.prefs.folded = !this.prefs.folded; this.savePrefs(); this.renderSummary(); return; }
    const li = tg.closest<HTMLElement>("[data-go]");
    if (!li) return;
    const id = Number(li.dataset.go);
    if (li.dataset.v === "over") {
      const worst = this.problemsOf(a).find(p => p.kind === "over");
      this.zoomTo(a, worst ? worst.id : id);
    } else this.zoomTo(a, id, id === 0 ? a.stats.get(0)?.at : undefined);
    this.host.showTab();
  }

  // ---------- picture (FR-TMAP-042) ----------

  /** What a saved picture says beside the colours: the scale's title and ends, and the lines under it. */
  pictureText() {
    const a = this.cur();
    if (!a || !this.active()) return null;
    const [lo, hi] = this.rangeOf(a), amb = this.ambient(a), mf = a.pkg.manifest, cmp = a.cmp, dl = cmp?.view === "d";
    const rise = !dl && this.prefs.rise && amb !== undefined, off = rise ? amb! : 0;
    const nm = (x: ThermalPackage) => x.manifest.design || x.name;
    const title = dl ? t("Temperature change") : rise ? t("Temperature rise") : t("Temperature");
    const end = (v: number) => (dl ? this.here(a, v).replace(" K", "") : `${rise ? "+" : ""}${deg(v - off)}`);
    const sm = summary(a.pkg, a.stats), hot = sm.hottest ?? { id: sm.peak.id, t: sm.peak.t };
    const over = this.problemsOf(a).filter(p => p.kind === "over").length;
    const lines: string[] = [];
    if (cmp) lines.push(cmp.view === "a" ? `A: ${nm(a.pkg)}` : cmp.view === "b" ? `B: ${nm(cmp.pkg)}` : `${t("Change (B − A)")}: ${nm(a.pkg)} → ${nm(cmp.pkg)}`);
    else lines.push(nm(a.pkg));
    if (a.iso !== null) lines.push(t("Showing {name} only", { name: this.nameOf(a, a.iso) }));
    lines.push(`${t("Hottest")} ${this.nameOf(a, hot.id)} ${this.shown(a, hot.t)} · ${over ? t("{n} part over its limit|{n} parts over their limits", { n: over }) : t("No part is over its limit.")}`);
    if (mf.accuracy !== undefined) lines.push(t("Estimate ±{v} °C", { v: deg(mf.accuracy) }));
    if (amb !== undefined) lines.push(t("Ambient {v} °C", { v: deg(amb) }));
    return { title, lo: end(lo), hi: end(hi), unit: dl ? "K" : "°C", palette: (dl ? "diverging" : this.prefs.palette) as PaletteName, lines };
  }

  /** Draws the hot-spot labels, probes and the colour scale with its lines into a snapshot of the view. */
  decorate(c: HTMLCanvasElement) {
    const a = this.cur(), ov = this.overlay, txt = this.pictureText();
    if (!a || !ov || !txt) return;
    const v = this.host.viewer, g = c.getContext("2d")!, k = c.width / Math.max(1, v.size.x), sh = this.shiftOf(a), q = new THREE.Vector3();
    const font = (px: number, bold = false) => `${bold ? "600 " : ""}${px * k}px "DejaVu Sans", system-ui, sans-serif`;
    g.save();
    g.textBaseline = "middle";
    // labels where they are on screen
    for (const pin of this.pins) {
      q.set(pin.p[0] + sh[0], pin.p[1] + sh[1], pin.p[2] + sh[2]);
      ov.localToWorld(q).project(v.camera);
      if (q.z > 1 || q.z < -1) continue;
      const x = (q.x * 0.5 + 0.5) * c.width, y = (-q.y * 0.5 + 0.5) * c.height;
      const text = (pin.el.querySelector("span")?.textContent ?? "").replace(/\s+/g, " ").trim();
      const warn = pin.el.classList.contains("warn");
      g.fillStyle = warn ? "#c92a2a" : "#1f2937";
      g.beginPath(); g.arc(x, y, 3.5 * k, 0, 2 * Math.PI); g.fill();
      if (!text) continue;
      g.font = font(11, true);
      const w = g.measureText(text).width + 10 * k, h = 18 * k, bx = x + 8 * k, by = y - h - 4 * k;
      g.fillStyle = "rgba(255,255,255,0.94)"; g.fillRect(bx, by, w, h);
      g.strokeStyle = warn ? "#c92a2a" : "#9ca3af"; g.lineWidth = k; g.strokeRect(bx, by, w, h);
      g.fillStyle = warn ? "#c92a2a" : "#111827"; g.textAlign = "left"; g.fillText(text, bx + 5 * k, by + h / 2);
    }
    // the colour scale and its lines, bottom left
    const pad = 10 * k, bw = 220 * k, bh = 12 * k, lh = 15 * k;
    g.font = font(11);
    const width = Math.max(bw, ...txt.lines.map(l => g.measureText(l).width)) + 2 * pad;
    const height = pad + 16 * k + bh + 16 * k + txt.lines.length * lh + pad;
    const x0 = 14 * k, y0 = c.height - 14 * k - height;
    g.fillStyle = "rgba(255,255,255,0.94)"; g.fillRect(x0, y0, width, height);
    g.strokeStyle = "#d1d5db"; g.lineWidth = k; g.strokeRect(x0, y0, width, height);
    let y = y0 + pad + 8 * k;
    g.fillStyle = "#111827"; g.font = font(12, true); g.textAlign = "left"; g.fillText(txt.title, x0 + pad, y);
    y += 10 * k;
    const gr = g.createLinearGradient(x0 + pad, 0, x0 + pad + bw, 0), rgb = new Float32Array(3);
    for (let i = 0; i <= 16; i++) { paletteColor(txt.palette, i / 16, rgb, 0); gr.addColorStop(i / 16, `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`); }
    g.fillStyle = gr; g.fillRect(x0 + pad, y, bw, bh);
    y += bh + 9 * k;
    g.fillStyle = "#111827"; g.font = font(11);
    g.textAlign = "left"; g.fillText(txt.lo, x0 + pad, y);
    g.textAlign = "center"; g.fillText(txt.unit, x0 + pad + bw / 2, y);
    g.textAlign = "right"; g.fillText(txt.hi, x0 + pad + bw, y);
    g.textAlign = "left";
    y += 7 * k;
    for (const l of txt.lines) { y += lh; g.fillText(l, x0 + pad, y - lh / 2); }
    g.restore();
  }

  // ---------- debug (window.__sv.thermal) ----------

  state() {
    const a = this.cur();
    if (!a) return null;
    const sm = summary(a.pkg, a.stats);
    return {
      name: a.pkg.name, on: a.on, own: a.own, sourcesOnly: !!a.pkg.sourcesOnly, drawn: !!this.overlay, tris: this.overlay ? this.overlay.geometry.getIndex()!.count / 3 : 0,
      range: this.rangeOf(a), parts: a.pkg.manifest.parts.length, matched: a.match.bodies.size, missing: a.match.missing, changed: a.match.changed, off: a.match.off, fitted: a.fitted,
      hidden: this.saved.length, problems: this.problemsOf(a).map(p => ({ kind: p.kind, id: p.id, value: p.value })), hottest: sm.hottest, peak: sm.peak, power: sm.power,
      sel: a.sel, iso: a.iso, faded: this.fade ? this.fade.geometry.getIndex()!.count / 3 : 0, picture: this.pictureText(), probes: a.probes.map(p => ({ p: p.p, t: p.t, part: p.part })), probing: this.probing, palette: this.prefs.palette, labels: this.pins.length,
      pcb: a.pcb ? { name: a.pcb.layers.name, shown: a.pcb.shown, mix: this.prefs.pcbMix, du: a.pcb.du, dv: a.pcb.dv, labels: a.pcb.layers.labels, w: a.pcb.layers.w, h: a.pcb.layers.h, box: a.pcb.layers.box, board: this.pcbBoard, textured: !!this.atlasTex } : null,
      compare: a.cmp ? { name: a.cmp.pkg.name, view: a.cmp.view, rows: a.cmp.changes.rows.map(r => ({ name: r.name, a: r.a, b: r.b, d: r.d })), onlyA: a.cmp.changes.onlyA, onlyB: a.cmp.changes.onlyB } : null,
    };
  }
  /** Where a point of the package is on screen (window pixels), for tests that click the map. */
  screenOf(p: V3) {
    const a = this.cur(), ov = this.overlay;
    if (!a || !ov) return null;
    const v = this.host.viewer, sh = this.shiftOf(a), r = v.renderer.domElement.getBoundingClientRect();
    const q = ov.localToWorld(new THREE.Vector3(p[0] + sh[0], p[1] + sh[1], p[2] + sh[2])).project(v.camera);
    return { x: r.left + (q.x * 0.5 + 0.5) * r.width, y: r.top + (-q.y * 0.5 + 0.5) * r.height };
  }
  /** The map's value under a place of the window. */
  valueAt(x: number, y: number) { const h = this.hit(x, y); return h ? { t: h.t, part: h.part, p: h.p } : null; }
}
