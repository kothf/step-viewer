// Structural analysis (FRS-structural 14, SA1): the Simulation command tab, the Study side tab (study tree,
// support and load panels with face picking), Solve with progress, and the result plot on the model.
// The study lives in `PartDoc.studies` (undo steps like any edit); results are view-only and go out of
// date when the model, the material or the study changes.
import * as THREE from "three";
import { cmTab, onCmTab, selectCmTab } from "../commandBar";
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { lang, layerLabel, onLangChange, t, withLang } from "../i18n";
import { pickMaterial } from "../materialPicker";
import { cacheGet, cacheKey, cachePut } from "../buildCache";
import type { ExprError } from "../model/expr";
import { evalVars } from "../model/params";
import type { FaceRef, Num, PartDoc } from "../model/types";
import { encodeGif, gifDelays } from "../motion/gif";
import { download, pdfWriter } from "../tools/exporters";
import { zip } from "../model/zip";
import { packageFiles, partBoxes, type ExportPart } from "../thermal/export";
import type { ThermalMesh } from "../thermal/vtu";
import { balanceCsv } from "../thermal/csv";
import { nearHot } from "../thermal/package";
import { toRef } from "../tools/materials";
import { UNITS, units } from "../tools/units";
import { chooseModal, toast } from "../ui";
import type { Viewer } from "../viewer/Viewer";
import type { MatRef } from "../tools/materials";
import type { AsmModel, SimModel } from "./model";
import type { EdgeInfo } from "../topology";
import { SIM_STOPPED, SimClient } from "./client";
import type { Connection } from "./connect";
import { boltCheck } from "./bolts";
import { DEFAULT_CLASS, PROPERTY_CLASSES, proofStress } from "../asm/fasteners";
import { hotCsv, loadBalance, stlBytes } from "./exports";
import { aloneIndex, isoIndex, componentRows, moveWithParts, vertexParts, withoutParts, type CompRow } from "./comps";
import { meshArea, plotTarget, refineMesh, type PlotMesh } from "./plotmesh";
import { locate, probeCsv, valueAt, type Located } from "./probes";
import { hotSpots, type HotSpot } from "./hotspots";
import type { SectionManager } from "../viewer/Section";
import { nearExcitation, parseExcitation } from "./excite";
import { compareRows, noteSummary, parseSummaries, type CompareRow, type Summary, type SummaryStore } from "./compare";
import { pathChart, pathChartSvg, pathCsv, pathLength, pathPoints, pathRows, type PathRow } from "./path";
import { chartSvg, reportHtml, reportPdf, type ReportBlock, type SimReport } from "./report";
import { MEMORY_LIMIT } from "./static";
import { BOARD_MATERIAL, DEFAULT_STACK, boardConductivity, boardK, plateAxis, type BoardStack } from "../thermal/study";
import { boardMap, gerberName, mapPicture, stackK, type CopperMap } from "../thermal/copper";
import { copperFromGerber } from "../thermal/copperRaster";
import { GLOBAL_PASSES, MAX_PASSES, edgeLines, spotPoints, envelope, positiveAxis, studyProblem, thermalSetup, withoutFaces, type PassResult, type RunInput, type SimBody } from "./run";
import { shownValue, typedValue } from "./values";
import { BOLTED_TCC, DEFAULT_AIR_GAP, PAD_LIBRARY, padEntry, THERMAL_LINK_TYPES, DEFAULT_FORCED, FLOWS, fanSpeed, type ForcedAir, NUT_FACTOR, boltPreload, DEFAULT_PAD, DEFAULT_TCC, linkConductance, DEFAULT_AMBIENT, DOWNS, ENCLOSURES, enclosureFactor, type Enclosure, FILM_PRESETS, THERMAL_LOADS, THERMAL_PASSES, PACKAGE_MIN_POWER, type PackageHeat, THERMAL_SUPPORTS, isThermalType, type StudyBolt } from "./types";
import { BOARD_RC, SERIES_COLORS, parseProfile, profileText, timeChartSvg, timeText as timeIn, timeToReach, transientCsv, type PowerProfile } from "./transient";
import { fluxArrows } from "./arrows";
import { parseKTable, kTableText, ktFactors, type KTable } from "./ktable";
import { DEFAULT_GAP, DEFAULT_MODES, DEFAULT_REF, GRAVITY, LOAD_LABEL, MAX_MODES, MAX_REFINE, MODAL_PASSES, ON_TYPES, REFINE_LABEL, SUPPORT_LABEL, WELD_LABEL, SPOT_LABEL, DEFAULT_SPOT, DEFAULT_GLUE, glueStiffness, DEFAULT_THROAT, CONNECTOR_LABEL, MASS_LABEL, DEFAULT_SPRING, extrasOf, type StudyWeld, type StudyConnector, type StudyMass, type StudyExtra, caseStudy, compOf, offComps, itemName, newCase, newStudy, nextId, pickCount, type LoadType, type PlotKind, type Study, type StudyKind, type StudyComp, type StudyLoad, type StudyRefine, type StudySupport, type SupportType } from "./types";

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
  /** An assembly's shown components with their parts' material names ("" = none). */
  comps(): { id: string; name: string; material: string; /** Its material's thermal conductivity, W/(m·K), when it has one. */ k?: number | null; fastener?: { role: "screw" | "nut" | "washer"; d: number; pitch: number; o: number[]; z: number[] } }[];
  /** An assembly's hinge and concentric mates, by component id (FR-CON-008). */
  mates(): { a: string; b: string; type: string; name: string }[];
  /** A part's solid bodies, by Bodies folder key (none for an assembly). */
  bodies(): { key: string; name: string }[];
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

type Edit = { kind: "support"; draft: StudySupport; isNew: boolean } | { kind: "load"; draft: StudyLoad; isNew: boolean } | { kind: "refine"; draft: StudyRefine; isNew: boolean } | { kind: "weld"; draft: StudyWeld; isNew: boolean } | { kind: "connector"; draft: StudyConnector; isNew: boolean } | { kind: "mass"; draft: StudyMass; isNew: boolean };
/** `parts` = bodies of the part when there are several (they are analysed bonded). */
/** One load case's results; `job` names its solution in the worker (0 = not held). */
/** A highest or lowest value of a plot: in display units, `at` in the display length unit, `hidden` = behind the model in the picture. */
interface Extreme { max: boolean; value: number; unit: string; at: number[]; hidden: boolean }
/** A plot captured for the report. */
interface Captured { src: string; w: number; h: number; caption: string; extremes: Extreme[] }
interface CaseResult { id: string; name: string; passes: PassResult[]; job: number }
/** `passes` are the shown ones: the study's, or with load cases the picked case's or the envelope (one made-up pass). */
/** A bolt of a solve: its screw's component id and name, every fastener it stands for, its thread. */
type BoltKept = { id: string; name: string; members: string[]; d: number; pitch: number; tapped: boolean };
/** A bolt found among the fasteners, with the patches it joins. */
interface BoltUse extends BoltKept { a: Float64Array; b: Float64Array; E: number; /** Components of the patch under the head and of the nut or thread. */ ca: string; cb: string }
interface Results { /** Transient thermal studies: the last pass as solved (every output time); the last entry of `passes` is the time shown. */ tr?: PassResult; /** The welds, in the order of `PassResult.welds`. */ welds?: { id: string; name: string }[]; /** The connectors, in the order of `PassResult.connectors`. */ conns?: { id: string; name: string; spring: boolean }[]; /** The bolts, in the order of `PassResult.bolts`. */ bolts?: BoltKept[]; /** An assembly: its solids, by the solver's domain. */ comps?: { key: string; name: string }[]; /** Components the solve left out (ids). */ off?: string[]; study: string; key: string; passes: PassResult[]; ids: string[]; /** Thermal: radiation between face sets, in the order of `thermal.exchanges`. */ xids?: string[]; ms: number; mesh: PlotMesh; cached?: boolean; parts?: number; cases?: CaseResult[]; job?: number; env?: PassResult[]; /** Bodies with their own materials: each body's material name and yield strength (MPa, 0 = none), by `PassResult.dom`. */ bodyMats?: { name: string; sy: number; rigid?: boolean; /** Thermal studies: conductivity, W/(m·K); `kz` = through a board, when it differs. */ k?: number; kz?: number }[] }
const BOLT_NOTE = "Tension, shear and bending of each bolt as a beam. The safety factor compares their combined stress on the thread's stress area with the proof stress of the property class.";
/** A percentage for a narrow table: tiny ones are not written out with an exponent. */
/** Solve on change: how long after the last change the solve starts, ms. */
const AUTO_DELAY = 700;
/** The memory budget typed in the address (`?simmem=<MB>`, for tests), bytes; 0 = the default. */
const memLimit = () => { const v = Number(new URLSearchParams(location.search).get("simmem")); return v > 0 ? v * 2 ** 20 : 0; };
const pct = (v: number) => (Math.abs(v) < 0.01 ? (v === 0 ? "0" : "< 0.01") : sig(v));
const RELIEF_NOTE = "The part is held by nothing: its supports are left out and the loads are balanced by its own inertia, as for a part in free flight or afloat.";
/** The most load cases a study has. */
export const MAX_CASES = 8;
/** What the disk cache keeps of a finished solve (FR-SOL-030). */
interface Kept { xids?: string[]; welds?: { id: string; name: string }[]; conns?: { id: string; name: string; spring: boolean }[]; bolts?: BoltKept[]; comps?: { key: string; name: string }[]; off?: string[]; passes: PassResult[]; ids: string[]; ms: number; mesh: PlotMesh; parts?: number; bodyMats?: { name: string; sy: number; rigid?: boolean; /** Thermal studies: conductivity, W/(m·K); `kz` = through a board, when it differs. */ k?: number; kz?: number }[]; cases?: { id: string; name: string; passes: PassResult[] }[] }

/** A time in the UI's language. */
const timeText = (s: number) => timeIn(s, { s: t("s"), min: t("min"), h: t("h") });
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const SUPPORTS: SupportType[] = ["fixed", "sliding", "hinge", "dirs", "elastic", "disp"];
const LOADS: LoadType[] = ["force", "pressure", "moment", "torque", "bearing", "remote", "hydro", "gravity", "centrifugal", "temperature"];
const ICON: Record<string, string> = { spot: "⊙", weld: "∿", connector: "⊷", mass: "◉", newmodal: "≈", new: "＋", mat: "◈", fixed: "⏚", sliding: "⇄", hinge: "◎", dirs: "✛", elastic: "≋", disp: "⇥", centrifugal: "⟳", torque: "⟲", bearing: "◒", hydro: "▽", remote: "⌖", refine: "⊞", force: "↓", pressure: "⇊", moment: "↻", gravity: "g", solve: "▶", stop: "■", results: "▦", report: "▤", "mode-structural": "σ", "mode-thermal": "℃", newthermal: "＋", ambient: "◌", heat: "✹", vheat: "▣", pkgheat: "✹", hflux: "⇶", temp: "⊜", conv: "≈", fan: "⤳", rad: "☼", radx: "⇌", transient: "◷", temperature: "ϑ" };
/** A forced air condition's speed, m/s (from the fan when it has one). */
const forcedSpeed = (f: ForcedAir) => (f.fan ? fanSpeed(f.fan.q, f.fan.a) : f.speed);
/** The flow direction's label (+X…−Z), or the nearest. */
const flowLabel = (d: ArrayLike<number>) => {
  let best = "+X", top = -Infinity;
  for (const [l, v] of FLOWS) { const c = v[0] * d[0] + v[1] * d[1] + v[2] * d[2]; if (c > top) { top = c; best = l; } }
  return best;
};

const TIP: Record<string, string> = {
  temperature: "Temperature: the part expands as it warms, uniformly or as a thermal study found; held, it is stressed",
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
  heat: "Heat power: watts made in the part or entering through faces",
  transient: "Over time: warm-up, cool-down and heaters switched on and off, from a start temperature",
  vheat: "Volume heat: watts per cubic metre made throughout the part, like a resistor or a coil",
  hflux: "Heat flux: watts per area entering through faces",
  temp: "Fixed temperature: the faces are held at a temperature, like a cold plate",
  conv: "Convection: the faces are cooled by air or a liquid",
  fan: "Forced air: a fan blows air over the faces; each face's film coefficient comes from the air speed and its length along the flow",
  rad: "Radiation: the faces radiate heat to the surroundings",
  radx: "Radiation between faces: two sets of faces exchange heat by radiation, like a valve bulb and the board under it",
  newthermal: "New thermal study: the temperatures of this part and where its heat goes",
  ambient: "Ambient temperature: the surroundings that convection and radiation give heat to",
};
/** What a thermal study plots. */
const THERMAL_PLOTS: PlotKind[] = ["temp", "rise", "flux", "err"];
const THERMAL_ASSUMPTIONS = "Steady heat conduction with constant material properties. Results are estimates for design and depend on the heat sources and the cooling chosen: film coefficients above all are rough figures. They do not replace a validated analysis where one is required.";
const PLOTS: [PlotKind, string][] = [["vm", "von Mises stress"], ["u", "Displacement"], ["ux", "Displacement X"], ["uy", "Displacement Y"], ["uz", "Displacement Z"], ["sf", "Safety factor"], ["temp", "Temperature"], ["rise", "Temperature rise"], ["flux", "Heat flux"], ["err", "Error estimate"]];
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
const SUPPORT_COLOR = 0x2f9e44, LOAD_COLOR = 0xd6336c, REFINE_COLOR = 0x1c7ed6, WELD_COLOR = 0xf08c00, CONNECTOR_COLOR = 0x9c36b5, MASS_COLOR = 0x0c8599;
/** A picked connection's patch: on its first component and on its second. */
const PATCH_A = 0xf59f00, PATCH_B = 0x1c7ed6;
const WELD_NOTE = "A weld joins two components along the picked edges. Set their connection to Sliding or Not joined, else the bonded faces carry the load and the weld almost nothing.";
const CONNECTOR_NOTE = "A connector ties the faces of its two sides together, each side moving as a whole: rigidly, or through a spring.";
const MASS_NOTE = "A mass is spread over its faces: it weighs under gravity and spinning, and lowers the natural frequencies.";
const SPOT_RESULT_NOTE = "Spot weld stress: the largest force of one spot over its area. Compare it with the allowable shear stress of the weld.";
const GLUE_NOTE = "Adhesive: the two components are joined through an elastic layer of this thickness and modulus. Set the gap tolerance to at least the layer's thickness when they are modelled apart.";
const WELD_RESULT_NOTE = "Weld stress: the largest force per length over the throat. Compare it with the allowable stress of the weld metal.";
const BOLT_COLOR = 0x7048e8;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
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
  private plot: { kind: PlotKind; deformed: boolean; scale: number; on: boolean; marks: boolean; vectors: boolean } = { kind: "vm", deformed: true, scale: 0, on: true, marks: true, vectors: false };
  /** Heat flux arrows drawn on the plot (thermal results). */
  private arrows = 0;
  /** Which analysis the command bar shows the commands of; it follows the open study's kind (`modeFor` = the study it was last set from). */
  private mode: "structural" | "thermal" = "structural";
  /** Transient results: the output time shown (index), and the playback timer. */
  private frame = -1;
  private playTimer = 0;
  /** Transient results: the temperature typed for "time to reach", °C. */
  private reach: number | null = null;
  /** The conductivity table open for editing: "" = the part's, else a component id (view only). */
  private ktOpen: string | null = null;
  private modeFor: string | null = null;
  /** Hot spots of the results, found once per pass. */
  private hot: { res: Results; n: number; list: HotSpot[] } | null = null;
  /** The hot spot picked in the list (its label is drawn on the model). */
  private hotSel = -1;
  /** Results of an assembly: the component (solver domain) shown alone, -1 = all of them. View only. */
  private compSel = -1;
  /** Plot-mesh vertices in view when one component is shown alone (1 = shown). */
  private mask: Uint8Array | null = null;
  /** The pairs found touching before a solve (FR-CON-003), for the model state and gap they were found with. */
  private found: { key: string; comps: { key: string; name: string }[]; list: Connection[] } | null = null;
  private finding = false;
  /** The bolts found among the fasteners (FR-CON-020), for the model state they were found in. */
  private boltsFound: { key: string; list: BoltUse[]; missed: { id: string; why: string }[] } | null = null;
  /** The connection whose patch is shown (its pair key), and what the Connections table is narrowed to. */
  private linkSel = "";
  private linkFilter = { comp: "", type: "" };
  /** What the labels on the plot stand on: a plot-mesh triangle and the weights of the point in it. */
  private pins: { i: number[]; w: number[] }[] = [];
  private client = new SimClient();
  /** The study state whose kept results were last asked for, so each is looked up once. */
  private asked = "";
  /** Solve on change: the timer of the next look, the state it last started a solve for, and how many it started. */
  private autoTimer = 0;
  private autoFor = "";
  private autoRuns = 0;
  private cacheHits = 0;
  private docId: string | null = null;
  private marks = new THREE.Group();
  /** An assembly's solids as last sent to the solver (the solver names them by their place in this list). */
  private comps: { key: string; name: string }[] = [];
  private saved: { meshes: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] } | null = null;
  private overlay: THREE.Mesh | null = null;
  // an assembly's plot follows its components (FR-CON-031): the part of each plot vertex, what is drawn, and how
  // the view shows each part now (moved by an exploded view or a drag, hidden, see-through)
  private partOf: Int32Array | null = null;
  private posed: { model: AsmModel; base: Float32Array; u: ArrayLike<number> | null; k: number; index: Uint32Array; nrm: Float32Array; dressed: (THREE.Material | THREE.Material[])[] } | null = null;
  private pose: { key: string; tfs: (Float32Array | null)[]; off: boolean[]; moved: number } = { key: "", tfs: [], off: [], moved: 0 };
  private poseBound = false;
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
  private weldIds: string[] = [];
  private connIds: string[] = [];
  /** Which side of a connector the next clicked face goes to. */
  private connSide: 1 | 2 = 1;
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
  private lastReport: { kind: string; blocks: number; images: number; marks: Extreme[][] } | null = null;
  /** The highest and lowest values marked on each picture of the report being made. */
  private repMarks: Extreme[][] = [];
  /** Modal results: the mode shown (−1 = the first elastic one) and whether its shape swings. */
  private modeSel = -1;
  private animate = true;
  /** Mode animation speed (1 = one swing in `MODE_PERIOD`) and whether the mode table adds the effective masses up; view only. */
  private speed = 1;
  private cumul = false;
  /** Iso-clipping (FR-RES-007, view only): only the places at or beyond a value of the plotted result are drawn. */
  private iso: { on: boolean; below: boolean; value: number | null } = { on: false, below: false, value: null };
  /** The study's name is being typed. */
  private renaming = false;
  /** Peak values of the studies' last results (and the ones before the last change), kept per document in localStorage. */
  private sums: SummaryStore = {};
  private sumsDoc = "";
  /** What each study is compared with: "prev" or another study's id (view only). */
  private cmpSel: Record<string, string> = {};
  /** The load case shown (index into the results' cases); -1 = the envelope of them all. */
  private caseSel = -1;
  private errorIn = "";
  private recording = false;
  private gifs = 0;
  private lastGif: { bytes: number; frames: number; w: number; h: number } | null = null;
  private anim: { raf: number; base: Float32Array; u: Float32Array; scale: number; t0: number; frames: number } | null = null;

  constructor(private host: SimHost) {
    host.section.capSource = () => (this.overlay && this.plot.deformed && !this.anim && !this.pose.moved ? this.overlay.geometry : null);
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
    // the time slider moves the shown time as it is dragged
    lg.addEventListener("input", e => { const el = e.target as HTMLInputElement; if (el.dataset.k === "time") { this.stopPlay(); this.seek(Number(el.value), true); } });
    lg.addEventListener("click", e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
      if (a === "close") { this.plot.on = false; this.probing = false; this.showPlot(); this.renderAll(); }
      else if (a === "probe") { this.probing = !this.probing; this.pathing = false; this.pathFirst = null; this.drawPath(); this.renderLegend(); }
      else if (a === "path") { this.pathing = !this.pathing; this.pathFirst = null; this.probing = false; this.drawPath(); this.renderLegend(); }
      else if (a === "noprobes") this.setProbes(t("Clear probes"), () => []);
      else if (a === "probecsv") this.exportProbes();
    else if (a === "gif") void this.recordGif().then(b => { if (b) toast(t("GIF saved"), "success"); });
      else if (a === "tplay") { if (this.playTimer) { this.stopPlay(); this.seek(this.frame); } else this.startPlay(); }
    });
    onCmTab(tab => { if (tab === "simulation" && this.host.doc()) this.host.showTab(); this.renderAll(); this.drawMarks(); });
    onLangChange(() => this.renderAll());
    this.renderAll();
  }

  // ---------- state ----------

  private study(): Study | null {
    const doc = this.host.doc(), list = doc?.studies ?? [];
    // the study used last in this document is the one shown (FR-STU-003)
    if (this.activeId == null && doc && list.length > 1) { try { this.activeId = localStorage.getItem(`mc:simStudy:${doc.id}`); } catch { /* no storage */ } }
    return list.find(s => s.id === this.activeId) ?? list[0] ?? null;
  }
  private setActive(id: string) {
    this.activeId = id; this.renaming = false;
    const doc = this.host.doc();
    if (doc) { try { localStorage.setItem(`mc:simStudy:${doc.id}`, id); } catch { /* no storage */ } }
  }
  /** The value iso-clipping cuts at, in the solver's units: the typed one, else 2 for a safety factor, else the middle of the range. */
  private isoValue(): number {
    if (this.iso.value != null) return this.iso.value;
    const [lo, hi] = this.range;
    return this.plot.kind === "sf" && lo < 2 && hi > 2 ? 2 : (lo + hi) / 2;
  }
  /** The scale the deformed shape is drawn at. */
  private shapeScale(r: PassResult): number {
    return this.plot.scale > 0 ? this.plot.scale : r.maxU > 0 ? ((r.modes ? 0.08 : 0.05) * this.host.viewer.modelSize) / r.maxU : 1;
  }
  private fileBase(): string {
    const doc = this.host.doc(), st = this.study();
    return `${doc?.name ?? "model"}-${st?.name ?? "study"}`.replace(/[\\/:*?"<>|]+/g, "_");
  }
  private exportHot() {
    const hs = this.hotList();
    if (hs.length) download(new Blob([hotCsv(hs)], { type: "text/csv" }), `${this.fileBase()}-hot-spots.csv`);
  }
  /** The deformed shape (a modal study: the shown mode's) at the scale drawn, as a binary STL (FR-REP-003). */
  private exportStl() {
    const res = this.res, r0 = res?.passes.at(-1);
    if (!res || !r0 || this.stale()) return;
    const shape = r0.shapes?.[this.modeIndex(r0)], r: PassResult = shape ? { ...r0, u: shape } : r0;
    const k = this.shapeScale(r), bytes = stlBytes(res.mesh.pos, res.mesh.index, r.u, k);
    this.lastStl = { bytes: bytes.length, tris: new DataView(bytes.buffer).getUint32(80, true), scale: k };
    download(new Blob([bytes.buffer as ArrayBuffer], { type: "model/stl" }), `${this.fileBase()}-deformed.stl`);
  }
  private lastStl: { bytes: number; tris: number; scale: number } | null = null;

  /**
   * The thermal result as a thermal package (FR-TREP-010): surface temperatures on the plot mesh, one part per heat
   * load's package part or component (the board = part 0), the heat-source table, the view and the manifest.
   */
  private async exportPackage() {
    // a component "R14<1>" came from the STEP solid "R14" (its second solid is "…#2")
    const bodyName = (n: string) => n.replace(/#\d+$/, "").replace(/<\d+>$/, "");
    const res = this.res, last = res?.passes.at(-1), T = last?.thermal, st = this.study(), doc = this.host.doc();
    if (!res || !last || !T || !st || !doc || this.stale()) return;
    const tris = res.mesh.index.length / 3, part = new Int32Array(tris), dom = last.dom;
    const parts: ExportPart[] = [];
    if (res.comps && dom && T.comps) {
      const off = new Set(st.suppressed ?? []), pk = st.loads.find(l => l.type === "pkgheat" && !off.has(l.id));
      const boards = new Set<string>([...(pk?.board ? [pk.board] : []), ...Object.entries(st.comps ?? {}).filter(([, c]) => c.board).map(([id]) => id)]);
      const idOf = new Int32Array(res.comps.length).fill(-1), byComp = new Map<string, number[]>();
      res.comps.forEach((c, d) => { const id = compOf(c.key); if (boards.has(id)) idOf[d] = 0; else byComp.set(id, [...(byComp.get(id) ?? []), d]); });
      const add = (id: number, doms: number[], extra: Partial<ExportPart>, name: string) => {
        const rows = doms.map(d => T.comps![d]).filter(Boolean);
        for (const d of doms) idOf[d] = id;
        parts.push({ id, designator: name, bodies: [...new Set(doms.map(d => bodyName(res.comps![d].name)))], p: rows.reduce((a, x) => a + (x.power ?? 0), 0), t: rows.length ? Math.max(...rows.map(x => x.max)) : undefined, ...extra });
      };
      let next = 1;
      for (const x of pk?.parts ?? []) next = Math.max(next, x.id + 1);
      for (const x of pk?.parts ?? []) {
        const doms = x.comps.flatMap(c => byComp.get(c) ?? []).filter(d => idOf[d] < 0);
        if (doms.length) add(x.id, doms, { path: x.path, limit: x.limit }, x.name);
      }
      for (const [, doms] of byComp) { const left = doms.filter(d => idOf[d] < 0); if (left.length) add(next++, left, {}, bodyName(res.comps[left[0]].name)); }
      // a triangle belongs to the component whose mesh it came from (the sampled domain is ambiguous where two touch)
      const am = this.host.model() as AsmModel | null, vp = am?.parts ? this.partsOfMesh(am, res.mesh) : null, all = new Map<string, number[]>();
      res.comps.forEach((c, d) => { const id = compOf(c.key); all.set(id, [...(all.get(id) ?? []), d]); });
      const meshComp = am?.parts ? am.parts.map((_p, k) => compOf(am.names[am.faceOff[k]] ?? "")) : [];
      for (let t3 = 0; t3 < tris; t3++) {
        const v = res.mesh.index[3 * t3];
        let d = dom[v];
        if (vp && vp[v] >= 0) { const ds = all.get(meshComp[vp[v]]); if (ds?.length && !ds.includes(d)) d = ds[0]; }
        part[t3] = Math.max(0, idOf[d] ?? 0);
      }
    } else {
      part.fill(1);
      parts.push({ id: 1, designator: doc.name, bodies: [doc.name], p: T.applied, t: T.max });
    }
    const pOf = new Map(parts.map(x => [x.id, x.p ?? 0])), power = new Float32Array(tris);
    for (let i = 0; i < tris; i++) power[i] = pOf.get(part[i]) ?? 0;
    // board faces: top, bottom or edge by the normal (the package frame has z up from the board's bottom face)
    let face: Int8Array | undefined;
    if (part.some(x => x === 0)) {
      face = new Int8Array(tris);
      const n = res.mesh.nrm, ix = res.mesh.index;
      for (let i = 0; i < tris; i++) if (part[i] === 0) { const z = n[3 * ix[3 * i] + 2] + n[3 * ix[3 * i + 1] + 2] + n[3 * ix[3 * i + 2] + 2]; face[i] = z > 2.1 ? 1 : z < -2.1 ? 2 : 3; }
    }
    const temp = Float32Array.from(last.vm);
    let lo = Infinity, hi = -Infinity;
    for (const v of temp) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const mesh: ThermalMesh = { pos: Float32Array.from(res.mesh.pos), temp, tri: Uint32Array.from(res.mesh.index), part, face, power, ambient: st.settings.ambient ?? DEFAULT_AMBIENT, range: [lo, hi] };
    const boxes = partBoxes(mesh);
    for (const x of parts) x.box = boxes.get(x.id);
    // the view, as the report draws it
    const was = { ...this.plot }, im = this.capture("temp", "image/png", false);
    this.plot = was;
    this.showPlot();
    const picture = im ? Uint8Array.from(atob(im.src.split(",")[1] ?? ""), c => c.charCodeAt(0)) : undefined;
    const enc = st.settings.enclosure, run = res.tr?.transient;
    const name = this.fileBase();
    const files = await packageFiles({
      name, design: doc.name, app: `MöbiusCAD ${__APP_VERSION__}`, created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), mesh, parts, picture,
      settings: { ambient: st.settings.ambient ?? DEFAULT_AMBIENT, enclosure: typeof enc === "string" ? enc : undefined },
      study: { name: st.name, kind: run ? "transient" : "steady", time: run ? run.times[Math.max(0, this.frame)] : undefined },
    });
    const bytes = await zip(files);
    this.lastPkg = { name: `${name}-thermal.zip`, files: files.map(f => f.name), parts: parts.map(x => ({ id: x.id, designator: x.designator, p: x.p ?? 0, t: x.t ?? null })), bytes: bytes.length, data: bytes };
    download(new Blob([bytes as BlobPart], { type: "application/zip" }), `${name}-thermal.zip`);
  }
  private lastPkg: { name: string; files: string[]; parts: { id: number; designator: string; p: number; t: number | null }[]; bytes: number; data: Uint8Array } | null = null;

  /** What the results depend on: the model, the material and the study's set-up. */
  private keyOf(_doc: SimDoc, st: Study) {
    const model = this.host.stateKey();
    const parts: unknown[] = [...model.head, st.supports, st.loads, st.settings, st.suppressed ?? null];
    if (st.refine?.length) parts.push(st.refine);
    // thermal stress: the temperatures come from another study, so its set-up counts too
    const from = st.loads.find(l => l.type === "temperature" && l.from)?.from, src = from ? this.host.doc()?.studies?.find(x => x.id === from) : null;
    if (src) parts.push(["temp-from", src.supports, src.loads, src.settings, src.mats ?? null, src.suppressed ?? null, ...(src.links?.length || src.comps ? [src.links ?? null, src.comps ?? null] : []), ...(src.kt && Object.keys(src.kt).length ? [["kt", src.kt]] : [])]);
    if (st.mats && Object.keys(st.mats).length) parts.push(Object.entries(st.mats).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (st.kind === "thermal" && st.kt && Object.keys(st.kt).length) parts.push(["kt", Object.entries(st.kt).sort(([a], [b]) => (a < b ? -1 : 1))]);
    if (st.welds?.length) parts.push(st.welds.map(w => (w.on === "points" ? [w.id, w.edges, w.points ?? [], w.dia ?? DEFAULT_SPOT] : [w.id, w.edges])));
    if (st.connectors?.length) parts.push(st.connectors.map(c => [c.id, c.faces.map(f => f.name), c.faces2.map(f => f.name), c.kind, c.k, c.kr ?? null]));
    if (st.masses?.length) parts.push(st.masses.map(m => [m.id, m.faces.map(f => f.name), m.mass]));
    parts.push(...model.tail);
    if (st.links?.length) parts.push(st.links);
    if (st.comps && Object.keys(st.comps).length) parts.push(Object.entries(st.comps).sort(([a], [b]) => (a < b ? -1 : 1)));
    const bolts = this.boltSettings(st);
    if (bolts.length) parts.push(bolts);
    if (st.kind === "modal") parts.push("modal");
    else if (st.kind === "thermal") parts.push(this.powerCases(st).length ? ["thermal", st.cases!.map(c => [c.id, c.off])] : "thermal");
    else if (st.cases?.length) parts.push(st.cases.map(c => [c.id, c.off]));
    return JSON.stringify(parts);
  }

  private foundKey(st: Study) { const off = [...offComps(st), ...(st.kind === "thermal" ? ["*thermal"] : this.solidScrews(st).map(id => `-${id}`))].sort(); return JSON.stringify(off.length ? [this.host.stateKey(), st.settings.gap ?? DEFAULT_GAP, off] : [this.host.stateKey(), st.settings.gap ?? DEFAULT_GAP]); }
  /** What of the bolts' settings a solve depends on (the property class only rates the result). */
  private boltSettings(st: Study) {
    return Object.entries(st.bolts ?? {}).filter(([, b]) => b.off || (b.preload ?? 0) > 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, b]) => [id, b.off ? 1 : 0, b.off ? 0 : b.preload ?? 0, b.torque ? b.k ?? NUT_FACTOR : 0]);
  }
  /** The screws the study takes as solids, not as bolts. */
  private solidScrews(st: Study) { return Object.entries(st.bolts ?? {}).filter(([, b]) => b.off).map(([id]) => id).sort(); }
  private boltKey(st: Study) { return JSON.stringify([this.host.stateKey(), [...offComps(st)].sort(), this.solidScrews(st)]); }
  private freshBolts(st: Study | null | undefined) { return st && this.boltsFound && this.boltsFound.key === this.boltKey(st) ? this.boltsFound : null; }
  /** The screws of the assembly a study can take as bolts. */
  private screws(st: Study) { const off = offComps(st); return this.host.asm() ? this.host.comps().filter(c => c.fastener?.role === "screw" && !off.has(c.id)) : []; }

  /**
   * The bolts of the study among the solver's bodies: every toolbox screw (unless the study takes it as a
   * solid) with the nut and washers on its axis, and the two patches it holds together.
   */
  private async boltsOf(st: Study, bodies: { key: string; tris: Float64Array; mat?: { E?: number | null } | null }[]): Promise<BoltUse[]> {
    const key = this.boltKey(st), had = this.freshBolts(st);
    if (had) return had.list;
    const off = offComps(st), live = bodies.filter(b => !off.has(compOf(b.key))), comps = this.host.comps();
    const solid = new Set(this.solidScrews(st));
    const fs = comps.filter(c => c.fastener && !off.has(c.id) && !solid.has(c.id));
    if (!fs.some(c => c.fastener!.role === "screw")) { this.boltsFound = { key, list: [], missed: [] }; return []; }
    const fast = fs.flatMap(c => { const body = live.findIndex(b => compOf(b.key) === c.id), f = c.fastener!; return body < 0 ? [] : [{ body, kind: f.role, d: f.d, pitch: f.pitch, o: f.o, z: f.z }]; });
    const r = await this.client.bolts(live.map(b => b.tris), fast);
    const idOf = (i: number) => compOf(live[i]?.key ?? ""), nameOf = (id: string) => comps.find(c => c.id === id)?.name ?? id;
    const list = r.bolts.map(b => {
      const id = idOf(b.screw), E = live[b.screw]?.mat?.E;
      return { id, name: nameOf(id), members: b.members.map(idOf), d: b.d, pitch: b.pitch, tapped: b.tapped, a: b.a, b: b.b, E: E && E > 0 ? E * 1000 : 210000, ca: idOf(b.ia), cb: idOf(b.ib) };
    });
    this.boltsFound = { key, list, missed: r.missed.map(m => ({ id: idOf(m.screw), why: m.why })) };
    return list;
  }
  /** Component pairs a bolt clamps (FR-TCON-003), as `pairKey`s; `uses` = the bolts found, or the cached ones. */
  private boltedPairs(uses: BoltUse[] | null | undefined): Set<string> {
    return new Set((uses ?? []).filter(b => b.ca && b.cb && b.ca !== b.cb).map(b => pairKey(b.ca, b.cb)));
  }
  private freshFound(st: Study | null | undefined) { return st && this.found && this.found.key === this.foundKey(st) ? this.found : null; }

  /** Finds the pairs of components that touch or come within the gap, without solving (FR-CON-003). */
  async findLinks() {
    const st = this.study();
    if (!st || !this.host.asm() || this.finding || this.running) return;
    if (!this.host.model()) { toast(t("The assembly has no components to analyse yet."), "warn"); return; }
    this.finding = true;
    this.renderAll();
    try {
      const size = this.host.viewer.modelSize, key = this.foundKey(st);
      const { regions } = await this.host.simGeo(Math.max(0.002, size * 2e-5), 0.05);
      const off = offComps(st);
      // a thermal study keeps the fasteners as solids: heat passes through them
      const uses = await this.boltsOf(st, regions ?? []);
      // (its bolts still give the pairs they clamp a bolted joint's conductance)
      if (st.kind !== "thermal") for (const b of uses) for (const m of b.members) off.add(m);
      await this.findFrom((regions ?? []).filter(b => !off.has(compOf(b.key))), st.settings.gap ?? DEFAULT_GAP, key);
      const n = this.found?.key === key ? this.found.list.length : 0;
      toast(n ? t("Connections found: {n}", { n }) : t("No components touch within the gap tolerance."), n ? "success" : "warn");
    } catch (e) {
      toast(this.errorText(e instanceof Error ? e.message : String(e)), "error");
    } finally {
      this.finding = false;
      this.renderAll();
      this.drawMarks();
    }
  }

  private async findFrom(bodies: { key: string; tris: Float64Array; name?: string }[], gap: number, key: string) {
    const list = await this.client.find(bodies.map(b => b.tris), gap);
    if (list) this.found = { key, comps: bodies.map(b => ({ key: b.key, name: b.name ?? b.key })), list };
  }

  private stale(): boolean {
    const doc = this.host.doc(), st = this.study();
    return !!this.res && (!doc || !st || st.id !== this.res.study || this.keyOf(doc, st) !== this.res.key);
  }

  /** A thermal study's power cases (FR-TSTU-005): none in a transient study, which runs every load on its profile. */
  private powerCases(st: Study) { return st.kind === "thermal" && !st.settings.transient ? st.cases ?? [] : []; }

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
      passes: this.res?.passes.map(p => ({ p: p.p, raised: p.raised ?? null, cells: p.cells, dofs: p.dofs, energy: p.energy, change: p.change, ms: p.ms, memory: p.memory ?? null })) ?? [], errors: last?.errors ?? [], capped: last?.capped ?? null, auto: !!this.study()?.auto, autoRuns: this.autoRuns,
      maxU: last?.maxU ?? null, maxVm: last?.maxVm ?? null, done: !!last?.done && !this.running,
      reactions: last?.reactions ?? [], applied: last?.applied ?? null,
      plot: { ...this.plot, arrows: this.arrows, shown: !!this.saved, range: this.range, scale: this.usedScale, points: (this.res?.mesh.pos.length ?? 0) / 3 }, marks: this.marks.children.length,
      probing: this.probing, probes: this.probes.map(p => this.probeValue(p)), probeAt: this.study()?.probes ?? [], probeCsv: this.probeTable(), report: this.lastReport, cached: !!this.res?.cached, cacheHits: this.cacheHits,
      compare: this.compared(), iso: { ...this.iso, at: this.isoValue() }, renaming: this.renaming, balance: last && !last.modes ? loadBalance(last.reactions, last.applied) : null, stl: this.lastStl, pkg: this.lastPkg ? { ...this.lastPkg, data: undefined } : null, balanceCsv: this.balanceCsvText(), hotCsv: this.res && !this.stale() && !last?.modes ? hotCsv(this.hotList()) : null, kind: this.study()?.kind ?? null, barMode: this.mode, transient: (() => { const T = this.res?.tr?.transient; if (!T) return null; const k = Math.max(0, this.frame); return { times: T.times, max: T.max, min: T.min, put: T.put, out: T.out, steps: T.steps, rejected: T.rejected, steady: T.steady, capacity: T.capacity, frame: k, time: T.times[k], shown: last?.thermal?.max ?? null, playing: !!this.playTimer, probes: this.probeSeries().map(x => Array.from(x.v)), reach: this.reach, csv: this.transientCsvText() }; })(), thermal: last?.thermal ? { contacts: (last.thermal.contacts ?? []).map(c => ({ a: this.res?.comps?.[c.a]?.name ?? "", b: this.res?.comps?.[c.b]?.name ?? "", area: c.area, type: c.type, heat: c.heat, ta: c.ta, tb: c.tb })), comps: (last.thermal.comps ?? []).map((c, i) => ({ name: this.res?.comps?.[i]?.name ?? "", ...c })), paths: this.heatPaths(), near: this.nearHotRows(), min: last.thermal.min, max: last.thermal.max, applied: last.thermal.applied, out: last.thermal.flows.map(f => f.out), flows: last.thermal.flows, solves: last.thermal.solves, exchanges: (last.thermal.exchanges ?? []).map((x, i) => ({ id: this.res?.xids?.[i] ?? "", ...x })) } : null, modes: last?.modes?.map(m => ({ hz: m.hz, rigid: m.rigid, eff: m.eff })) ?? [], mode: this.modeIndex(last), mass: last?.mass ?? null,
      animating: !!this.anim, frames: this.anim?.frames ?? 0, gifs: this.gifs, gif: this.lastGif, near: this.nearModes(this.res?.passes.at(-1)), bodies: this.res?.parts ?? 1, bodyMats: this.res?.bodyMats?.map(b => b.name) ?? null, speed: this.speed, cumul: this.cumul, more: !!this.res?.passes.at(-1)?.more, range: this.study()?.settings.range ?? null,
      caps: { n: this.caps.length, ...this.capInfo },
      compRows: this.compRows().map(x => ({ name: this.res!.comps![x.d].name, vm: x.maxVm, u: x.maxU, sf: x.sf })), compSel: this.aloneDom(), drawn: this.overlay ? this.drawnTris() : 0, pose: { moved: this.pose.moved, off: this.pose.off.filter(Boolean).length }, plotBox: this.plotBox(),
      asm: this.host.asm(), comps: this.res?.comps?.map(c => c.name) ?? null, contacts: (last?.contacts ?? []).map(c => ({ a: this.res?.comps?.[c.a]?.name ?? "", b: this.res?.comps?.[c.b]?.name ?? "", area: c.area, type: c.type, force: c.force ?? null, moment: c.moment ?? null, at: c.at ?? null })), links: this.study()?.links ?? [],
      compList: this.host.asm() ? this.host.comps().map(c => { const o = this.study()?.comps?.[c.id]; return { id: c.id, name: c.name, off: !!o?.off, rigid: !!o?.rigid, board: o?.board ?? null, material: o?.material?.name ?? c.material, own: !!o?.material }; }) : null, excluded: this.res?.off ?? [],
      found: this.freshFound(this.study())?.list.map(c => ({ a: this.found!.comps[c.a]?.name ?? "", b: this.found!.comps[c.b]?.name ?? "", area: c.area, gap: c.gap, at: c.at })) ?? null, finding: this.finding, linkSel: this.linkSel,
      patches: this.marks.children.filter(o => o.userData.simPatch).map(o => ({ side: o.userData.simPatch as string, tris: ((o as THREE.Mesh).geometry.getAttribute("position")?.count ?? 0) / 3 })),
      conns: this.connRows(), connList: (this.study()?.connectors ?? []).map(c => ({ id: c.id, a: c.faces.length, b: c.faces2.length, kind: c.kind, k: c.k, kr: c.kr ?? null })), massList: (this.study()?.masses ?? []).map(m => ({ id: m.id, faces: m.faces.length, mass: m.mass })), connSide: this.connSide,
      welds: this.weldRows(), weldList: (this.study()?.welds ?? []).map(w => ({ id: w.id, edges: w.edges.length, throat: w.throat, ...(w.on === "points" ? { points: w.points?.length ?? 0, dia: w.dia ?? DEFAULT_SPOT } : {}) })),
      boltMarks: this.marks.children.filter(o => o.userData.simBolt).length,
      bolts: this.boltRows().map(x => ({ id: x.id, name: x.name, cls: x.cls, tapped: x.tapped, preload: x.preload, axial: x.axial, shear: x.shear, moment: x.moment, eq: x.eq, sf: x.sf })),
      boltList: this.study() ? this.screws(this.study()!).map(c => { const st = this.study()!, f = this.freshBolts(st); return { id: c.id, name: c.name, off: !!st.bolts?.[c.id]?.off, found: !!f?.list.some(x => x.id === c.id), missed: f?.missed.find(x => x.id === c.id)?.why ?? null }; }) : [],
      relief: !!this.study()?.settings.relief, accel: last?.accel ? { a: last.accel.a, alpha: last.accel.alpha } : null,
      cases: (this.study()?.cases ?? []).map(c => ({ name: c.name, off: c.off })), caseSel: this.caseSel, enveloped: this.enveloped,
      caseResults: (this.res?.cases ?? []).map(c => ({ name: this.caseName(c), maxVm: c.passes.at(-1)?.maxVm ?? null, maxU: c.passes.at(-1)?.maxU ?? null, passes: c.passes.length })),
      path: (() => { const pv = this.pathValues(); let lo = Infinity, hi = -Infinity, inside = 0; if (pv) for (let i = 0; i < pv.v.length; i++) if (pv.ok[i]) { inside++; lo = Math.min(lo, pv.v[i]); hi = Math.max(hi, pv.v[i]); }
        return { at: this.study()?.path ?? null, picking: this.pathing, first: !!this.pathFirst, points: pv?.v.length ?? 0, inside, min: inside ? lo : null, max: inside ? hi : null, source: this.pathData?.source ?? null, csv: this.pathData ? pathCsv(this.pathData.rows, !!this.res?.passes.at(-1)?.thermal) : null, drawn: this.pathMark?.userData.simPath ?? 0 }; })(),
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
    this.autoSoon();
  }

  /** Solve on change (FR-STU-022): a little after the last change, a study that asks for it is solved again. */
  private autoSoon() {
    clearTimeout(this.autoTimer);
    if (!this.study()?.auto) return;
    this.autoTimer = window.setTimeout(() => this.autoSolve(), AUTO_DELAY);
  }

  private autoSolve() {
    const doc = this.host.doc(), st = this.study();
    if (!doc || !st?.auto) return;
    // a solve under way, an open panel or an open command: look again later
    if (this.running || this.edit || !this.host.idle()) { this.autoSoon(); return; }
    if (this.res && !this.stale()) return;
    // nothing to solve yet: no support (unless the body is free on purpose), or no load
    const off = new Set(st.suppressed ?? []), on = <T extends { id: string }>(l: T[]) => l.filter(x => !off.has(x.id));
    if (st.kind === "thermal") { if (!on(st.supports).length || !this.matOf(doc)?.k) return; }
    else {
    if (st.kind !== "modal" && !st.settings.relief && !on(st.supports).length) return;
    if (st.kind !== "modal" && !on(st.loads).length && !on(st.supports).some(s => s.type === "disp")) return;
    const am = this.matOf(doc);
    if (!this.host.asm() && !(am?.E && am.nu != null)) return;
    }
    if (!this.host.model()) return;
    const tag = `${doc.id}|${st.id}|${this.keyOf(doc, st)}`;
    if (tag === this.autoFor) return;
    this.autoFor = tag;
    this.autoRuns++;
    void this.solve();
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
    this.res = { study: st.id, key, passes: kept.passes, ids: kept.ids, ...(kept.xids ? { xids: kept.xids } : {}), ms: kept.ms, mesh: kept.mesh, cached: true, ...(kept.parts ? { parts: kept.parts } : {}), ...(kept.comps ? { comps: kept.comps } : {}), ...(kept.off ? { off: kept.off } : {}), ...(kept.bolts ? { bolts: kept.bolts } : {}), ...(kept.welds ? { welds: kept.welds } : {}), ...(kept.conns ? { conns: kept.conns } : {}), ...(kept.bodyMats ? { bodyMats: kept.bodyMats } : {}),
      ...(kept.cases?.length ? { cases: kept.cases.map(c => ({ ...c, job: 0 })) } : {}) };
    this.caseSel = -1; this.compSel = -1;
    this.applyCase();
    this.frame = -1; this.stopPlay();
    if (this.res.passes.at(-1)?.transient) this.useFrame(this.res, this.res.passes.at(-1)!.transient!.times.length - 1);
    this.cacheHits++;
    this.noteResult();
    this.plot.on = false;
    this.syncProbes();
    this.syncPath();
    this.renderAll();
  }

  /** The model was built and shown again: the mesh is new. */
  rebuilt() {
    this.autoSoon();
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
    if (c === "mode-structural" || c === "mode-thermal") { this.setMode(c === "mode-thermal" ? "thermal" : "structural"); return; }
    if (c === "new") { this.newStudy(); return; }
    if (c === "newmodal") { this.newStudy("modal"); return; }
    if (c === "newthermal") { this.newStudy("thermal"); return; }
    if (c === "transient") {
      const cur = this.study();
      if (cur?.kind !== "thermal") return;
      const on = !cur.settings.transient;
      this.host.change(t(on ? "Transient study" : "Steady study"), d => { const x = d.studies?.find(y => y.id === cur.id); if (!x) return; if (on) x.settings.transient = { end: 3600, out: 60 }; else delete x.settings.transient; });
      this.host.showTab();
      return;
    }
    if (c === "ambient") {
      if (this.study()?.kind !== "thermal") this.useStudy(true);
      const el = document.querySelector<HTMLInputElement>('#sim-tree input[data-k="ambient"]');
      el?.scrollIntoView({ block: "nearest" }); el?.focus(); el?.select();
      return;
    }
    if (c === "mat") { void this.pickMat(); return; }
    if (c === "solve") { void this.solve(); return; }
    if (c === "stop") { this.client.cancel(); return; }
    if (c === "report") { void this.report(); return; }
    if (c === "results") { this.plot.on = !this.plot.on; this.showPlot(); this.renderAll(); this.drawMarks(); return; }
    // a command of the other analysis than the open study's: the study of that kind used last, or a new one
    if (c !== "mat") this.useStudy(c === "fan" || isThermalType(c));
    const st = this.study();
    if (!st) return;
    if (c === "fan") {
      this.connSide = 1;
      this.edit = { kind: "support", isNew: true, draft: { id: nextId(st, "s"), name: t("Forced air"), type: "conv", faces: [], h: FILM_PRESETS[1][1], forced: { ...DEFAULT_FORCED, dir: [...DEFAULT_FORCED.dir] } } };
      this.renderAll(); this.drawMarks();
      return;
    }
    if ((THERMAL_SUPPORTS as string[]).includes(c)) {
      const type = c as SupportType, amb = st.settings.ambient ?? DEFAULT_AMBIENT;
      this.connSide = 1;
      this.edit = { kind: "support", isNew: true, draft: { id: nextId(st, "s"), name: itemName(st, type), type, faces: [], ...(type === "temp" ? { temp: amb } : type === "conv" ? { h: FILM_PRESETS[0][1] } : type === "radx" ? { faces2: [], emis: 0.9, emis2: 0.9 } : { emis: 0.9 }) } };
      this.renderAll(); this.drawMarks();
      return;
    }
    if ((THERMAL_LOADS as string[]).includes(c)) {
      const type = c as LoadType;
      this.edit = { kind: "load", isNew: true, draft: { id: nextId(st, "l"), name: itemName(st, type), type, faces: [], value: { v: type === "heat" ? 1 : type === "vheat" ? 1e6 : 1000 } } };
      this.renderAll(); this.drawMarks();
      return;
    }
    if (c === "weld" || c === "spot") {
      if (!this.host.asm()) { toast(t("Welds join the components of an assembly.")); return; }
      this.edit = { kind: "weld", isNew: true, draft: c === "spot"
        ? { id: nextId(st, "w"), name: itemName(st, "spot"), type: "weld", faces: [], on: "points", edges: [], points: [], dia: DEFAULT_SPOT, throat: DEFAULT_THROAT }
        : { id: nextId(st, "w"), name: itemName(st, "weld"), type: "weld", faces: [], on: "edges", edges: [], throat: DEFAULT_THROAT } };
      this.renderAll();
      this.drawMarks();
      return;
    }
    if (c === "connector" || c === "mass") {
      this.connSide = 1;
      this.edit = c === "connector" ? { kind: "connector", isNew: true, draft: { id: nextId(st, "k"), name: itemName(st, "connector"), type: "connector", faces: [], faces2: [], kind: "rigid", k: [DEFAULT_SPRING, DEFAULT_SPRING, DEFAULT_SPRING] } }
        : { kind: "mass", isNew: true, draft: { id: nextId(st, "m"), name: itemName(st, "mass"), type: "mass", faces: [], mass: 1 } };
      this.renderAll();
      this.drawMarks();
      return;
    }
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
      if (c === "temperature" && st.loads.some(l => l.type === "temperature")) { toast(t("A study takes one temperature load.")); return; }
      const type = c as LoadType;
      const d: StudyLoad = { id: nextId(st, "l"), name: itemName(st, type), type, faces: [] };
      if (type === "force") { d.normal = true; d.value = { v: 100 }; d.comp = [{ v: 0 }, { v: 0 }, { v: -100 }]; }
      else if (type === "pressure") d.value = { v: 1 };
      else if (type === "moment") d.comp = [{ v: 0 }, { v: 0 }, { v: 1000 }];
      else if (type === "centrifugal") { d.value = { v: 3000 }; d.axis = "z"; }
      else if (type === "torque") d.value = { v: 10000 };
      else if (type === "bearing") d.comp = [{ v: 0 }, { v: 0 }, { v: -1000 }];
      else if (type === "hydro") { d.value = { v: 1000 }; d.axis = "z"; d.level = 0; }
      else if (type === "temperature") { d.value = { v: 100 }; d.ref = DEFAULT_REF; const th = this.thermalStudies().at(-1); if (th) d.from = th.id; }
      else if (type === "remote") { d.comp = [{ v: 0 }, { v: 0 }, { v: -100 }]; d.mom = [{ v: 0 }, { v: 0 }, { v: 0 }]; d.at = [0, 0, 0]; }
      else d.comp = [{ v: 0 }, { v: 0 }, { v: -GRAVITY }];
      this.edit = { kind: "load", isNew: true, draft: d };
    } else return;
    this.renderAll();
    this.drawMarks();
  }

  /** The command bar's analysis: the study of that kind used last becomes the open one (none: the bar alone changes). */
  private setMode(m: "structural" | "thermal") {
    const doc = this.host.doc(), cur = this.study();
    this.mode = m;
    this.modeFor = cur?.id ?? null;
    if (cur && (cur.kind === "thermal") !== (m === "thermal")) {
      const other = [...(doc?.studies ?? [])].reverse().find(s => (s.kind === "thermal") === (m === "thermal"));
      if (other && !this.running && !this.edit) { this.setActive(other.id); this.changed(); return; }
    }
    this.renderAll();
  }

  /** Makes the open study one of the wanted analysis: the last such study, else a new one. */
  private useStudy(thermal: boolean) {
    const doc = this.host.doc(), cur = this.study();
    if (cur && (cur.kind === "thermal") === thermal) return;
    const other = [...(doc?.studies ?? [])].reverse().find(s => (s.kind === "thermal") === thermal);
    if (other) { this.setActive(other.id); this.changed(); }
    else this.newStudy(thermal ? "thermal" : "static");
  }

  private newStudy(kind: StudyKind = "static") {
    const doc = this.host.doc();
    if (!doc) return;
    const st = newStudy(doc.studies ?? [], kind);
    this.setActive(st.id);
    this.edit = null;
    this.host.change(kind === "modal" ? t("New modal study") : kind === "thermal" ? t("New thermal study") : t("New study"), d => { (d.studies ??= []).push(st); });
    this.changed();
  }

  /**
   * A thermal study of a board made from its thermal package (FR-TBRD-001): the package's ambient, one Heat from
   * package load, and convection and radiation from every surface open to the air.
   */
  boardStudy(spec: { ambient?: number; emissivity?: number; enclosure?: "open" | "vented" | "closed"; down?: [number, number, number]; heat: PackageHeat[]; board?: { comp: string; t: number; stack?: Partial<BoardStack> } }): string | null {
    const doc = this.host.doc();
    if (!doc) return null;
    const st = newStudy(doc.studies ?? [], "thermal");
    if (spec.enclosure) st.settings.enclosure = spec.enclosure;
    // the package's ambient wins over the enclosure preset's
    st.settings.ambient = spec.ambient !== undefined && Number.isFinite(spec.ambient) ? spec.ambient : ENCLOSURES.find(x => x.id === spec.enclosure)?.ambient ?? DEFAULT_AMBIENT;
    if (spec.down) st.settings.down = spec.down;
    if (spec.board?.comp) st.comps = { [spec.board.comp]: { board: { ...DEFAULT_STACK, ...(spec.board.stack ?? {}), ...(spec.board.t > 0 ? { t: Math.round(spec.board.t * 1000) / 1000 } : {}) } } };
    st.loads.push({ id: "l1", name: itemName(st, "pkgheat"), type: "pkgheat", faces: [], parts: spec.heat, ...(spec.board?.comp ? { board: spec.board.comp } : {}) });
    st.supports.push({ id: "s1", name: itemName(st, "conv"), type: "conv", faces: [], all: true, natural: true, h: FILM_PRESETS[0][1] });
    const emis = spec.emissivity !== undefined && spec.emissivity > 0 && spec.emissivity <= 1 ? spec.emissivity : 0.9;
    st.supports.push({ id: "s2", name: itemName(st, "rad"), type: "rad", faces: [], all: true, emis });
    this.setActive(st.id);
    this.edit = null;
    this.mode = "thermal";
    this.modeFor = st.id;
    this.host.change(t("New thermal study"), d => { (d.studies ??= []).push(st); });
    this.changed();
    return st.id;
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
    if (s) { this.connSide = 1; this.edit = { kind: "support", isNew: false, draft: structuredClone(s) }; }
    else if (l) this.edit = { kind: "load", isNew: false, draft: structuredClone(l) };
    else {
      const r = st.refine?.find(x => x.id === id), w = st.welds?.find(x => x.id === id);
      if (r) this.edit = { kind: "refine", isNew: false, draft: structuredClone(r) };
      else if (w) this.edit = { kind: "weld", isNew: false, draft: structuredClone(w) };
      else {
        const k = st.connectors?.find(x => x.id === id), m = st.masses?.find(x => x.id === id);
        this.connSide = 1;
        if (k) this.edit = { kind: "connector", isNew: false, draft: structuredClone(k) };
        else if (m) this.edit = { kind: "mass", isNew: false, draft: structuredClone(m) };
      }
    }
    this.renderAll();
    this.drawMarks();
  }

  private ok() {
    const e = this.edit, st = this.study();
    if (!e || !st) return;
    const d = e.draft;
    if (d.type !== "gravity" && d.type !== "centrifugal" && !this.unpicked(d) && !pickCount(d)) {
      const on = (d as StudyLoad).on;
      toast(on === "edges" ? t("Click the edges on the model first.") : on === "points" ? t("Click the corner points on the model first.") : t("Click the faces on the model first."), "warn");
      return;
    }
    if (this.twoSided(e) && !this.twoSided(e)!.faces2.length) { this.connSide = 2; this.renderPanel(); toast(t("Click the faces of the second side on the model."), "warn"); return; }
    if (e.kind === "mass" && !(e.draft.mass > 0)) { toast(t("Type a mass above 0."), "warn"); return; }
    const sid = st.id;
    const label = e.isNew ? t(e.kind === "refine" ? REFINE_LABEL : e.kind === "connector" ? CONNECTOR_LABEL : e.kind === "mass" ? MASS_LABEL : e.kind === "weld" ? (e.draft.on === "points" ? SPOT_LABEL : WELD_LABEL) : (SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]) : t("Edit {name}", { name: d.name ?? "" });
    this.edit = null;
    this.pickingAt = false;
    this.problems.delete(d.id);
    this.host.change(label, doc => {
      const s = doc.studies?.find(x => x.id === sid);
      if (!s) return;
      const list = (e.kind === "support" ? s.supports : e.kind === "load" ? s.loads : e.kind === "weld" ? (s.welds ??= []) : e.kind === "connector" ? (s.connectors ??= []) : e.kind === "mass" ? (s.masses ??= []) : (s.refine ??= [])) as (StudySupport | StudyLoad | StudyRefine | StudyExtra)[];
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
    if (ed.draft.type === "gravity" || this.unpicked(ed.draft)) return true;
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
    if (ed.kind === "weld" && ed.draft.on === "points") {
      // a spot weld: the place on the face under the pointer; a click on a spot takes it away
      const hit = this.host.faceAt(e.clientX, e.clientY), name = hit ? this.host.faceNames()[hit.faceId] : undefined;
      if (!hit || !name) { toast(t("Click a point on a face of the model."), "warn"); return true; }
      if (offComps(this.study()).has(compOf(name))) { toast(t("This component is left out of the study."), "warn"); return true; }
      const w = ed.draft, list = (w.points ??= []), r = (w.dia ?? DEFAULT_SPOT) / 2;
      const i = list.findIndex(q => Math.hypot(q.at[0] - hit.point[0], q.at[1] - hit.point[1], q.at[2] - hit.point[2]) <= r);
      if (i >= 0) list.splice(i, 1);
      else list.push({ faces: [name], at: hit.point.map(v => Math.round(v * 1e4) / 1e4) as [number, number, number] });
      this.renderPanel();
      this.drawMarks();
      return true;
    }
    if (ed.kind !== "refine" && (ed.draft as StudyLoad).on) { this.pickEdgeOrPoint(ed.draft as StudyLoad, e); return true; }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const name = hit ? this.host.faceNames()[hit.faceId] : undefined;
    if (!hit || !name) return true;
    if (this.host.asm() && offComps(this.study()).has(compOf(name))) { toast(t("This component is left out of the study."), "warn"); return true; }
    const d = ed.draft;
    const two = this.twoSided(ed);
    if (two) {
      // a face is on one side only; the first click on side one moves on to side two once it has a face
      const c = two, mine = this.connSide === 2 ? c.faces2 : c.faces, other = this.connSide === 2 ? c.faces : c.faces2;
      const j = mine.findIndex(f => f.name === name), o = other.findIndex(f => f.name === name);
      if (j >= 0) mine.splice(j, 1);
      else { if (o >= 0) other.splice(o, 1); mine.push({ name, hint: hit.point }); }
      this.renderPanel();
      this.drawMarks();
      return true;
    }
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
  /** An item that takes no picks: heat throughout a part, cooling of every open surface, a package's heat. */
  /** An item with two sets of faces (a connector, radiation between faces): its draft, else null. */
  private twoSided(e: NonNullable<SimController["edit"]>): { faces: FaceRef[]; faces2: FaceRef[] } | null {
    if (e.kind === "connector") return e.draft;
    if (e.kind === "support" && e.draft.type === "radx") { const s = e.draft; s.faces2 ??= []; return s as { faces: FaceRef[]; faces2: FaceRef[] }; }
    return null;
  }

  private unpicked(d: { type: string; body?: boolean; all?: boolean }): boolean {
    return ((d.type === "heat" && !!d.body || d.type === "vheat") && !this.host.asm()) || d.type === "pkgheat" || d.type === "temperature" || ((d.type === "conv" || d.type === "rad") && !!d.all);
  }

  /** The part's thermal studies (sources of a temperature load). */
  private thermalStudies(): Study[] {
    return (this.host.doc()?.studies ?? []).filter(x => x.kind === "thermal");
  }

  /** "120 °C, stress-free at 20 °C" or "from Thermal 1, stress-free at 20 °C". */
  private tempText(l: StudyLoad, html = false): string {
    const src = l.from ? this.thermalStudies().find(x => x.id === l.from) : null, name = src?.name ?? "?";
    // a study's name is the user's text: it stays as typed in a translated page
    const what = l.from ? (html ? esc(t("from {name}", { name: "\u0000" })).replace("\u0000", `<span translate="no">${esc(name)}</span>`) : t("from {name}", { name })) : `${sig(l.value?.v ?? DEFAULT_REF)} °C`;
    const rest = t("stress-free at {t} °C", { t: sig(l.ref ?? DEFAULT_REF) });
    return `${what}, ${html ? esc(rest) : rest}`;
  }

  private pickText(it: StudySupport | StudyLoad | StudyRefine | StudyExtra): string {
    if ((it.type === "conv" || it.type === "rad") && (it as StudySupport).all) return t("all open surfaces");
    if (it.type === "radx") return `${t("{n} face|{n} faces", { n: it.faces.length })} ⇌ ${t("{n} face|{n} faces", { n: (it as StudySupport).faces2?.length ?? 0 })}`;
    if (it.type === "pkgheat") return t("{n} part|{n} parts", { n: ((it as StudyLoad).parts ?? []).filter(x => !x.off && x.p >= PACKAGE_MIN_POWER && x.comps.length).length });
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
    if (st.kind === "thermal") { await this.solveThermal(doc, st); return; }
    const m = this.matOf(doc), asm = this.host.asm();
    if (!asm && (!m || !m.E || m.nu == null)) {
      toast(t("Pick a material with an elastic modulus and Poisson's ratio first."), "warn");
      void this.pickMat();
      return;
    }
    const part = this.host.model();
    if (!part) { toast(asm ? t("The assembly has no components to analyse yet.") : t("The part has no body yet."), "warn"); return; }
    this.running = true; this.error = null; this.errorIn = ""; this.res = null; this.problems.clear(); this.probes = []; this.probeKey = ""; this.hot = null; this.hotSel = -1; this.compSel = -1; this.modeSel = -1;
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
      const got = await this.host.simGeo(Math.max(0.002, size * 2e-5), 0.05), { solids, parts } = got;
      // components the study leaves out are not there for the solver: no body, no faces to hold or load
      const off = asm ? offComps(st) : new Set<string>();
      // a bolt stands for its fasteners: they are not solids of the study
      const uses = asm ? await this.boltsOf(st, got.regions ?? []) : [];
      for (const b of uses) for (const m of b.members) off.add(m);
      const bolts = uses.map(b => { const pre = modal ? 0 : boltPreload(st.bolts?.[b.id], b.d); return { a: b.a, b: b.b, d: b.d, E: b.E, ...(pre > 0 ? { preload: pre } : {}) }; });
      const geo = off.size ? withoutFaces(got.geo, n => off.has(compOf(n))) : got.geo;
      const bodies = off.size ? got.regions?.filter(b => !off.has(compOf(b.key))) : got.regions;
      // welds: the lines of their edges in the solver's own triangles
      const gone = new Set(st.suppressed ?? []), weldUse = asm ? (st.welds ?? []).filter(w => !gone.has(w.id)) : [];
      const welds = weldUse.map(w => {
        if (w.on === "points") {
          const spots = spotPoints(geo, w.points ?? []);
          if (!spots || !spots.length) throw new Error(`E-SIM-REF: ${w.id}`);
          return { lines: new Float64Array(0), spots, d: w.dia ?? DEFAULT_SPOT };
        }
        const all: number[] = [];
        for (const ed of w.edges) {
          const ln = edgeLines(geo, ed.faces[0], ed.faces[1]);
          if (!ln || !ln.length) throw new Error(`E-SIM-REF: ${w.id}`);
          for (let i = 0; i < ln.length; i++) all.push(ln[i]);
        }
        return { lines: Float64Array.from(all) };
      });
      this.weldIds = weldUse.map(w => w.id);
      if (!asm && solids !== 1) throw new Error("E-SIM-BODIES");
      // bodies with a material of their own keep it: each body is then solved with its own stiffness and density
      const simMat = (q: NonNullable<typeof doc.material>) => ({ name: q.name, E: (q.E ?? 0) * 1000, nu: q.nu ?? 0, rho: q.density * 1e-9, sy: q.sy ?? undefined, su: q.su ?? undefined });
      let regions: { tris: Float64Array; mat: ReturnType<typeof simMat>; rigid?: boolean }[] | undefined;
      // each region's thermal expansion, 1e-6/K (a temperature load): null = its material gives none
      let alphas: { name: string; a: number | null }[] = [];
      // an assembly: every component is its own body with its part's material, joined to the others where they touch
      let joined: { gap: number; links: { a: number; b: number; type: "sliding" | "none" | "adhesive"; kn?: number; kt?: number }[] } | undefined;
      if (asm) {
        if (!bodies?.length) throw new Error("E-SIM-NOBODY");
        const steelParts = new Set(this.host.comps().filter(c => c.fastener).map(c => c.id));
        regions = bodies.map(b => {
          const sc = st.comps?.[compOf(b.key)];
          let q = sc?.material ?? b.mat;
          // a toolbox part made before its steel had elastic constants
          if (q && !q.E && steelParts.has(compOf(b.key))) q = { ...q, E: 210, nu: 0.3 };
          // a rigid component needs no elastic constants: only its density counts (weight, spinning)
          if (sc?.rigid) { alphas.push({ name: b.name ?? b.key, a: 0 }); return { tris: b.tris, mat: q ? { ...simMat(q), sy: undefined, su: undefined } : { name: "", E: 0, nu: 0.3, rho: 0, sy: undefined, su: undefined }, rigid: true }; }
          if (!q || !q.E || q.nu == null) throw new Error(`E-SIM-COMPMAT: ${b.name ?? b.key}`);
          alphas.push({ name: b.name ?? b.key, a: q.alpha ?? null });
          return { tris: b.tris, mat: simMat(q) };
        });
        if (regions.every(r => r.rigid)) throw new Error("E-SIM-ALLRIGID");
        this.comps = bodies.map(b => ({ key: b.key, name: b.name ?? b.key }));
        const at = new Map(bodies.map((b, i) => [b.key, i]));
        // the pairs with their gaps and patches are found beside the solve, for the Connections table
        if (!this.freshFound(st)) void this.findFrom(bodies, st.settings.gap ?? DEFAULT_GAP, this.foundKey(st)).then(() => { this.renderAll(); this.drawMarks(); }).catch(() => {});
        joined = { gap: st.settings.gap ?? DEFAULT_GAP, links: (st.links ?? []).flatMap(l => (l.type !== "resist" && l.type !== "pad" && l.type !== "bolted" && l.type !== "perfect" && l.type !== "air" && at.has(l.a) && at.has(l.b) ? [{ a: at.get(l.a)!, b: at.get(l.b)!, type: l.type, ...(l.type === "adhesive" ? { kn: glueStiffness(l)[0], kt: glueStiffness(l)[1] } : {}) }] : [])) };
      } else if (m && bodies && bodies.length > 1 && bodies.some(b => this.bodyMatOf(doc, b.key))) {
        regions = bodies.map(b => {
          const q = this.bodyMatOf(doc, b.key) ?? m;
          if (!q.E || q.nu == null) throw new Error(`E-SIM-BODYMAT: ${q.name}`);
          alphas.push({ name: q.name, a: q.alpha ?? null });
          return { tris: b.tris, mat: simMat(q) };
        });
        if (regions.every(r => r.mat.name === regions![0].mat.name && r.mat.E === regions![0].mat.E)) { regions = undefined; alphas = []; }
      }
      // with load cases each one is solved on its own: the same supports, its own loads
      const cases = modal ? [] : st.cases ?? [];
      const runs = (cases.length ? cases : [null]).map(c => ({ c, problem: studyProblem(c ? caseStudy(st, c) : st, geo) }));
      for (const r of runs) if (r.problem.problems.length) {
        for (const p of r.problem.problems) this.problems.set(p.id, p.code);
        throw new Error(`${r.problem.problems[0].code}: ${r.problem.problems[0].id}`);
      }
      const problem = runs[0].problem;
      // a temperature field from a thermal study of the assembly: that study's bolted pairs, found now
      { const from = !modal && asm ? st.loads.find(l => l.type === "temperature" && l.from && !(st.suppressed ?? []).includes(l.id))?.from : undefined, th = from ? this.thermalStudies().find(x => x.id === from) : null; if (th) await this.boltsOf(th, got.regions ?? []); }
      const temp = modal ? undefined : this.tempInput(doc, st, geo, regions ? alphas : undefined, got);
      const g = part.geometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), n = pa.count;
      const p0 = new Float32Array(3 * n), n0 = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        p0[3 * i] = pa.getX(i); p0[3 * i + 1] = pa.getY(i); p0[3 * i + 2] = pa.getZ(i);
        if (na) { n0[3 * i] = na.getX(i); n0[3 * i + 1] = na.getY(i); n0[3 * i + 2] = na.getZ(i); }
      }
      // the results are drawn on a finer copy of the display mesh (a flat face has only two triangles)
      let idx: ArrayLike<number> | null = g.getIndex()?.array ?? null;
      if (off.size) {
        // the plot covers only the analysed components
        const am = part as AsmModel, keep: number[] = [];
        am.faces.forEach((f, i) => {
          if (off.has(compOf(am.names[i] ?? ""))) return;
          for (let q = 3 * f.triStart; q < 3 * (f.triStart + f.triCount); q++) keep.push(idx ? idx[q] : q);
        });
        idx = Uint32Array.from(keep);
      }
      const mesh = refineMesh(p0, n0, idx, plotTarget(meshArea(p0, idx), size / 70));
      const pos = mesh.pos, nrm = mesh.nrm;
      const total = Math.max(1, Math.min(modal ? MODAL_PASSES : MAX_PASSES, Math.round(st.settings.passes)));
      if (modal) problem.loads = [];
      this.connIds = problem.connectorIds ?? [];
      const connUse = this.connIds.map(id => st.connectors!.find(c => c.id === id)!);
      const res: Results = { study: st.id, key, passes: [], ids: problem.supportIds, ms: 0, mesh, ...(connUse.length ? { conns: connUse.map(c => ({ id: c.id, name: c.name ?? c.id, spring: c.kind === "spring" })) } : {}), ...(parts && parts > 1 ? { parts } : {}), ...(asm ? { comps: this.comps } : {}), ...(off.size ? { off: [...off] } : {}), ...(weldUse.length ? { welds: weldUse.map(w => ({ id: w.id, name: w.name ?? w.id })) } : {}), ...(uses.length ? { bolts: uses.map(b => ({ id: b.id, name: b.name, members: b.members, d: b.d, pitch: b.pitch, tapped: b.tapped })) } : {}), ...(cases.length ? { cases: [] } : {}), ...(regions ? { bodyMats: regions.map(r => ({ name: r.mat.name, sy: r.mat.sy ?? 0, ...(r.rigid ? { rigid: true } : {}) })) } : {}) };
      made = res; whole = false;
      for (let ci = 0; ci < runs.length; ci++) {
      const run = runs[ci], problem = run.problem, pre = run.c ? `${run.c.name}: ` : "";
      const mine: PassResult[] = run.c ? [] : res.passes;
      if (run.c) { res.cases!.push({ id: run.c.id, name: run.c.name, passes: mine, job: 0 }); res.passes = mine; this.caseSel = ci; this.errorIn = run.c.name; this.hot = null; }
      this.progress = pre + t("Pass {n} of {m}…", { n: 1, m: total });
      this.renderAll();
      await this.client.solve({
        body: geo, problem, passes: total, energyTol: st.settings.energyTol, pos, nrm, ...(memLimit() ? { memory: memLimit() } : {}),
        ...(modal ? { modal: st.settings.range
          ? { count: DEFAULT_MODES, max: MAX_MODES, range: [st.settings.range.from, st.settings.range.to] as [number, number] }
          : { count: Math.max(1, Math.min(MAX_MODES, Math.round(st.settings.modes ?? DEFAULT_MODES))) } } : {}),
        mat: m && !asm ? simMat(m) : regions![0].mat, ...(regions ? { regions } : {}), ...(joined ? { asm: joined } : {}), ...(temp ? { temp } : {}), ...(bolts.length ? { bolts } : {}), ...(welds.length ? { welds } : {}),
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
        const keep: Kept = { passes: res.cases ? res.cases.at(-1)!.passes : res.passes, ids: res.ids, ms: res.ms, mesh: res.mesh, parts: res.parts, ...(res.comps ? { comps: res.comps } : {}), ...(res.off ? { off: res.off } : {}), ...(res.bolts ? { bolts: res.bolts } : {}), ...(res.welds ? { welds: res.welds } : {}), ...(res.conns ? { conns: res.conns } : {}), ...(res.bodyMats ? { bodyMats: res.bodyMats } : {}), ...(res.cases ? { cases: res.cases.map(c => ({ id: c.id, name: c.name, passes: c.passes })) } : {}) };
        void cacheKey("sim", key).then(k => cachePut(k, keep));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== SIM_STOPPED) { this.error = msg; toast((this.errorIn ? `${this.errorIn}: ` : "") + this.errorText(msg), "error"); }
      // load cases are shown together or not at all
      if (!whole && made?.cases && this.res === made) { this.res = null; this.clearPlot(); }
    } finally {
      this.running = false;
      if (whole) this.noteResult();
      this.renderAll();
      this.drawMarks();
    }
  }

  /**
   * A temperature load's input (FR-LOAD-011): the material's α, 1/K, and for temperatures from a thermal study
   * that study's own run input (the worker solves it first). Undefined without a temperature load.
   */
  private tempInput(doc: SimDoc, st: Study, geo: Parameters<typeof thermalSetup>[1], regions: { name: string; a: number | null }[] | undefined, got: Awaited<ReturnType<SimHost["simGeo"]>>): RunInput["temp"] | undefined {
    const gone = new Set(st.suppressed ?? []), tl = st.loads.find(l => l.type === "temperature" && !gone.has(l.id));
    if (!tl) return undefined;
    // several bodies (an assembly's components, a part's bodies of their own material): each expands by its own α
    let a: number, alphas: number[] | undefined;
    if (regions) {
      const no = regions.find(r => r.a == null);
      if (no) throw new Error(`E-TH-COMPALPHA: ${no.name}`);
      alphas = regions.map(r => r.a! * 1e-6);
      a = Math.max(...regions.map(r => r.a!));
      if (!(a > 0)) throw new Error("E-TH-ALPHA");
    } else {
      const ma = this.matOf(doc)?.alpha;
      if (!ma) throw new Error("E-TH-ALPHA");
      a = ma;
    }
    const base = { alpha: a * 1e-6, ...(alphas ? { alphas } : {}) };
    if (!tl.from) return base;
    const th = this.thermalStudies().find(x => x.id === tl.from);
    if (!th) throw new Error("E-TH-NOFIELD");
    const tr = { problem: { fixed: [], loads: [], problems: [], supportIds: [] }, passes: Math.max(1, Math.min(THERMAL_PASSES, Math.round(th.settings.passes))), energyTol: th.settings.energyTol, pos: new Float32Array(3), nrm: new Float32Array(3) };
    if (this.host.asm()) {
      // the thermal study of the same assembly: its own components, materials and contacts
      let tp: ReturnType<SimController["thermalParts"]>;
      try { tp = this.thermalParts(th, got, this.boltedPairs(this.freshBolts(th)?.list)); } catch { throw new Error("E-TH-NOFIELD"); }
      if (tp.setup.problems.length) throw new Error("E-TH-NOFIELD");
      const { bodies, bks, kOf, nameOf, kts, kmaps } = tp;
      return { ...base, thermal: { ...tr, body: tp.geo, mat: { name: nameOf(0), E: 0, nu: 0, rho: 0 }, regions: bodies.map((b, i) => ({ tris: b.tris, mat: { name: nameOf(i), E: 0, nu: 0, rho: 0 } })),
        thermal: { k: kOf(0) * 1e-3, setup: tp.setup, ks: bodies.map((_b, i) => kOf(i) * 1e-3), k3s: bks.map(q => (q?.k3 ? q.k3.map(v => v * 1e-3) : null)), gap: th.settings.gap ?? DEFAULT_GAP, links: tp.links, ...(kts ? { kts } : {}), ...(kmaps ? { kmaps } : {}) } } };
    }
    const q = th.mats?.[""] ?? doc.material;
    if (!q?.k) throw new Error("E-TH-NOFIELD");
    const setup = thermalSetup(th, geo);
    if (setup.problems.length) throw new Error("E-TH-NOFIELD");
    const kt = th.kt?.[""]?.length ? ktFactors(th.kt[""], q.k) : undefined;
    return { ...base, thermal: { ...tr, body: geo, mat: { name: q.name, E: 0, nu: 0, rho: 0 }, thermal: { k: q.k * 1e-3, setup, ...(kt ? { kt } : {}) } } };
  }


  /**
   * A thermal study's bodies and set-up on the geometry `got` (one solid for a part; an assembly's components, less
   * those the study leaves out, each with its conductivity, joined where they touch as its links say).
   */
  /** The found gap between two components, mm (rounded, at least 0.01), else the default air layer. */
  private pairGap(st: Study, a: string, b: string): number {
    const f = this.freshFound(st), ia = f?.comps.findIndex(c => c.key === a) ?? -1, ib = f?.comps.findIndex(c => c.key === b) ?? -1;
    const c = f?.list.find(x => (x.a === ia && x.b === ib) || (x.a === ib && x.b === ia));
    return c && c.gap > 0.005 ? Math.max(0.01, Math.round(c.gap * 100) / 100) : DEFAULT_AIR_GAP;
  }

  private thermalParts(st: Study, got: Awaited<ReturnType<SimHost["simGeo"]>>, bolted: Set<string> = new Set()) {
    const asm = this.host.asm();
    // an assembly: every component is its own body with its material's conductivity, joined where they touch
    const off = asm ? offComps(st) : new Set<string>();
    const geo = off.size ? withoutFaces(got.geo, n => off.has(compOf(n))) : got.geo;
    const bodies = asm ? (off.size ? got.regions?.filter(b => !off.has(compOf(b.key))) : got.regions) ?? [] : [];
    if (asm && !bodies.length) throw new Error("E-SIM-NOBODY");
    // a toolbox part made before its steel had thermal values conducts like carbon steel
    const steel = new Set(asm ? this.host.comps().filter(c => c.fastener).map(c => c.id) : []);
    const mats = bodies.map(b => { const q = st.comps?.[compOf(b.key)]?.material ?? b.mat ?? null; return q && !q.k && steel.has(compOf(b.key)) ? { ...q, k: 54, cp: q.cp ?? 461 } : q; });
    // a board conducts by its copper: along it far better than through it
    const bks = bodies.map(b => { const bd = st.comps?.[compOf(b.key)]?.board; return bd ? boardK(b.tris, bd, bd.t) : null; });
    mats.forEach((q, i) => { if (!bks[i] && !q?.k) throw new Error(`E-TH-COMPMAT: ${bodies[i].name ?? bodies[i].key}`); });
    const kOf = (i: number) => bks[i]?.along ?? mats[i]!.k!, nameOf = (i: number) => (bks[i] ? BOARD_MATERIAL : mats[i]!.name);
    const at = new Map(bodies.map((b, i) => [b.key, i]));
    const links = (st.links ?? []).flatMap(l => (at.has(l.a) && at.has(l.b) && (l.type === "none" || l.type === "resist" || l.type === "pad" || l.type === "bolted" || l.type === "air")
      ? [l.type === "none" ? { a: at.get(l.a)!, b: at.get(l.b)!, type: "none" as const }
        : { a: at.get(l.a)!, b: at.get(l.b)!, type: "resistance" as const, h: linkConductance(l), ...(l.type === "air" ? { air: l.t ?? DEFAULT_AIR_GAP } : {}) }] : []));
    // pairs a bolt clamps pass heat by a bolted joint's conductance unless a type is typed for them (FR-TCON-003)
    if (bolted.size) {
      const typed = new Set((st.links ?? []).filter(l => THERMAL_LINK_TYPES.has(l.type) || l.type === "none").map(l => pairKey(l.a, l.b)));
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const ka = bodies[i].key, kb = bodies[j].key;
        if (bolted.has(pairKey(compOf(ka), compOf(kb))) && !typed.has(pairKey(ka, kb))) links.push({ a: i, b: j, type: "resistance" as const, h: BOLTED_TCC * 1e-6 });
      }
    }
    const setup = thermalSetup(st, geo, asm ? bodies.map(b => b.key) : undefined);
    // a conductivity table (FR-TMAT-004) as factors on each body's k; a board keeps its copper's conductivity
    const kts = bodies.map((b, i) => { const rows = st.kt?.[compOf(b.key)]; return rows?.length && !bks[i] ? ktFactors(rows, kOf(i)) : null; });
    // a board with its Gerber set: the conductivity follows its copper cell by cell (FR-TBRD-020)
    const kmaps = bodies.map((b, i) => { const bd = st.comps?.[compOf(b.key)]?.board; return bd?.map && bks[i] ? boardMap(b.tris, bd, bks[i]!.t) : null; });
    return { off, geo, bodies, mats, bks, kOf, nameOf, links, setup, kts: kts.some(Boolean) ? kts : undefined, kmaps: kmaps.some(Boolean) ? kmaps : undefined };
  }

  /** A thermal study's solve (FRS-thermal TH2): the part's temperatures from its heat sources and cooling. */
  private async solveThermal(doc: SimDoc, st: Study) {
    const asm = this.host.asm();
    const m = this.matOf(doc);
    if (!asm && !m?.k) { toast(t("Pick a material with a thermal conductivity first."), "warn"); void this.pickMat(); return; }
    const part = this.host.model();
    if (!part) { toast(asm ? t("The assembly has no components to analyse yet.") : t("The part has no body yet."), "warn"); return; }
    this.running = true; this.error = null; this.errorIn = ""; this.res = null; this.problems.clear(); this.probes = []; this.probeKey = ""; this.hot = null; this.hotSel = -1; this.compSel = -1; this.modeSel = -1;
    this.plot.kind = "temp";
    this.clearPlot();
    this.progress = t("Reading the geometry…");
    this.renderAll();
    const key = this.keyOf(doc, st), t0 = performance.now();
    let done = false;
    try {
      const size = this.host.viewer.modelSize;
      const got = await this.host.simGeo(Math.max(0.002, size * 2e-5), 0.05);
      if (!asm && got.solids !== 1) throw new Error("E-SIM-BODIES");
      const bolted = asm ? this.boltedPairs(await this.boltsOf(st, got.regions ?? [])) : undefined;
      const { off, geo, bodies, mats, bks, kOf, nameOf, links, setup, kts, kmaps } = this.thermalParts(st, got, bolted);
      const kt = !asm && st.kt?.[""]?.length ? ktFactors(st.kt[""], m!.k!) : undefined;
      if (asm) {
        this.comps = bodies.map(b => ({ key: b.key, name: b.name ?? b.key }));
        if (!this.freshFound(st)) void this.findFrom(bodies, st.settings.gap ?? DEFAULT_GAP, this.foundKey(st)).then(() => { this.renderAll(); this.drawMarks(); }).catch(() => {});
      }
      // power cases (FR-TSTU-005): each solved on its own with its ticked heat loads and the same cooling
      const cases = this.powerCases(st);
      const runs = cases.length ? cases.map(c => ({ c: c as typeof c | null, setup: this.thermalParts(caseStudy(st, c), got, bolted).setup })) : [{ c: null, setup }];
      for (const r of runs) if (r.setup.problems.length) {
        for (const p of r.setup.problems) this.problems.set(p.id, p.code);
        throw new Error(`${r.setup.problems[0].code}: ${r.setup.problems[0].id}`);
      }
      // a transient study needs each body's heat capacity ρ·cp, J/(mm³·K): g/cm³ × 1e-6 × J/(kg·K)
      const tr = st.settings.transient;
      let transient: NonNullable<NonNullable<Parameters<SimClient["solve"]>[0]["thermal"]>["transient"]> | undefined;
      if (tr) {
        const rcOf = (q: MatRef | null | undefined, name: string, board: boolean) => {
          if (q?.density && q.cp) return q.density * 1e-6 * q.cp;
          if (board) return BOARD_RC;
          throw new Error(`E-TH-NOCP: ${name}`);
        };
        const rcs = asm ? bodies.map((b, i) => rcOf(mats[i], b.name ?? b.key, !!bks[i])) : [rcOf(m, m!.name, false)];
        const profiles: Record<string, PowerProfile> = {};
        for (const l of st.loads) if (l.profile) profiles[l.id] = l.profile;
        transient = { rc: rcs[0], ...(asm ? { rcs } : {}), t0: tr.t0 ?? st.settings.ambient ?? DEFAULT_AMBIENT, end: tr.end, out: tr.out, profiles };
      }
      const g = part.geometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), n = pa.count;
      const p0 = new Float32Array(3 * n), n0 = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        p0[3 * i] = pa.getX(i); p0[3 * i + 1] = pa.getY(i); p0[3 * i + 2] = pa.getZ(i);
        if (na) { n0[3 * i] = na.getX(i); n0[3 * i + 1] = na.getY(i); n0[3 * i + 2] = na.getZ(i); }
      }
      let idx: ArrayLike<number> | null = g.getIndex()?.array ?? null;
      if (off.size) {
        // the plot covers only the analysed components
        const am = part as AsmModel, keep: number[] = [];
        am.faces.forEach((f, i) => {
          if (off.has(compOf(am.names[i] ?? ""))) return;
          for (let q = 3 * f.triStart; q < 3 * (f.triStart + f.triCount); q++) keep.push(idx ? idx[q] : q);
        });
        idx = Uint32Array.from(keep);
      }
      const mesh = refineMesh(p0, n0, idx, plotTarget(meshArea(p0, idx), size / 70));
      const total = Math.max(1, Math.min(THERMAL_PASSES, Math.round(st.settings.passes)));
      const res: Results = { study: st.id, key, passes: [], ids: setup.sinkIds, ...(setup.exchangeIds?.length ? { xids: setup.exchangeIds } : {}), ms: 0, mesh, ...(asm ? { comps: this.comps, bodyMats: bodies.map((_b, i) => ({ name: nameOf(i), sy: 0, k: kOf(i), ...(bks[i]?.k3 ? { kz: bks[i]!.through } : {}) })) } : {}), ...(off.size ? { off: [...off] } : {}), ...(cases.length ? { cases: [] } : {}) };
      this.frame = -1; this.stopPlay();
      for (let ci = 0; ci < runs.length; ci++) {
      const run = runs[ci], setup = run.setup, pre = run.c ? `${run.c.name}: ` : "";
      const mine: PassResult[] = run.c ? [] : res.passes;
      if (run.c) { res.cases!.push({ id: run.c.id, name: run.c.name, passes: mine, job: 0 }); res.passes = mine; this.caseSel = ci; this.errorIn = run.c.name; this.hot = null; }
      this.progress = pre + t("Pass {n} of {m}…", { n: 1, m: total });
      this.renderAll();
      await this.client.solve({
        body: geo, problem: { fixed: [], loads: [], problems: [], supportIds: [] }, passes: total, energyTol: st.settings.energyTol, pos: mesh.pos, nrm: mesh.nrm, ...(memLimit() ? { memory: memLimit() } : {}),
        mat: { name: asm ? nameOf(0) : m!.name, E: 0, nu: 0, rho: 0 },
        ...(asm ? { regions: bodies.map((b, i) => ({ tris: b.tris, mat: { name: nameOf(i), E: 0, nu: 0, rho: 0 } })) } : {}),
        thermal: asm ? { k: kOf(0) * 1e-3, setup, ks: bodies.map((_b, i) => kOf(i) * 1e-3), k3s: bks.map(q => (q?.k3 ? q.k3.map(v => v * 1e-3) : null)), gap: st.settings.gap ?? DEFAULT_GAP, links, ...(kts ? { kts } : {}), ...(kmaps ? { kmaps } : {}), ...(transient ? { transient } : {}) } : { k: m!.k! * 1e-3, setup, ...(kt ? { kt } : {}), ...(transient ? { transient } : {}) },
      }, p => {
        mine.push(p);
        res.ms = performance.now() - t0;
        this.res = res;
        this.plot.on = true;
        if (!p.done) this.progress = transient && (p.pass >= Math.min(2, total) || !st.loads.length) ? t("Stepping in time…") : pre + t("Pass {n} of {m}…", { n: p.pass + 1, m: total });
        if (p.transient) this.useFrame(res, p.transient.times.length - 1);
        this.showPlot();
        this.renderAll();
        this.drawMarks();
      }, ci > 0);
      if (!mine.length) throw new Error(SIM_STOPPED);
      if (run.c) res.cases![ci].job = this.client.solution; else res.job = this.client.solution;
      }
      this.errorIn = "";
      if (res.cases) { this.caseSel = res.cases.length > 1 ? -1 : 0; this.hot = null; this.applyCase(); if ((this.res as Results | null) === res) this.showPlot(); }
      done = true;
      if ((this.res as Results | null) === res) { this.solved = res; this.running = false; this.capsSoon(); this.syncPath(); }
      const keep: Kept = { passes: res.tr ? [...res.passes.slice(0, -1), res.tr] : res.cases ? res.cases.at(-1)!.passes : res.passes, ids: res.ids, ...(res.xids ? { xids: res.xids } : {}), ms: res.ms, mesh: res.mesh, ...(res.comps ? { comps: res.comps } : {}), ...(res.off ? { off: res.off } : {}), ...(res.bodyMats ? { bodyMats: res.bodyMats } : {}), ...(res.cases ? { cases: res.cases.map(c => ({ id: c.id, name: c.name, passes: c.passes })) } : {}) };
      void cacheKey("sim", key).then(k => cachePut(k, keep));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // power cases are shown together or not at all
      const shown = this.res as Results | null;
      if (shown?.cases && shown.study === st.id) { this.res = null; this.clearPlot(); }
      if (msg !== SIM_STOPPED) { this.error = msg; toast((this.errorIn ? `${this.errorIn}: ` : "") + this.errorText(msg), "error"); }
    } finally {
      this.running = false;
      void done;
      this.renderAll();
      this.drawMarks();
    }
  }

  /** An assembly study: which components are analysed, and with which material (FR-CON-001/002). */
  /** "200 W/(m·K) at 20 °C … 150 W/(m·K) at 300 °C" for a conductivity table. */
  private ktRange(rows: KTable) {
    const a = rows[0], b = rows[rows.length - 1];
    return rows.length === 1 ? `${sig(a[1])} W/(m·K)` : t("{a} W/(m·K) at {ta} °C … {b} W/(m·K) at {tb} °C", { a: sig(a[1]), ta: sig(a[0]), b: sig(b[1]), tb: sig(b[0]) });
  }

  /** The conductivity table of the part ("") or a component (FR-TMAT-004): the toggle for the part, and the editor while open. */
  private ktHtml(st: Study, key: string) {
    const rows = st.kt?.[key], open = this.ktOpen === key, dis = this.running ? " disabled" : "";
    const toggle = key === "" ? `<button class="btn small sim-ktbtn${rows?.length ? " on" : ""}" data-a="ktab" data-b="" aria-pressed="${open ? "true" : "false"}"${dis}>${esc(rows?.length ? t("Conductivity by temperature ({n} rows)", { n: rows.length }) : t("Conductivity changes with temperature…"))}</button>` : "";
    if (!open) return toggle;
    return toggle + `<div class="sim-kt" data-kt="${esc(key)}"><label class="pm-field pm-col"><span>${esc(t("Temperature, °C and conductivity, W/(m·K), one row per line"))}</span>`
      + `<textarea data-k="ktab" data-b="${esc(key)}" rows="5" spellcheck="false" placeholder="20 200&#10;300 160"${dis}>${esc(rows ? kTableText(rows) : "")}</textarea></label>`
      + `<p class="sim-note muted">${esc(t("Between the rows k is linear; below the first and above the last it keeps their value. The solve is repeated with each place's k at its temperature until k changes by less than 0.5 %."))}</p>`
      + (rows?.length ? `<button class="btn small" data-a="ktclear" data-b="${esc(key)}"${dis}>${esc(t("Constant conductivity"))}</button>` : "") + `</div>`;
  }

  private setKt(key: string, rows: KTable | null) {
    const st = this.study();
    if (!st) return;
    this.host.change(rows ? t("Conductivity by temperature") : t("Constant conductivity"), d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const kt = { ...(s.kt ?? {}) };
      if (rows) kt[key] = rows; else delete kt[key];
      if (Object.keys(kt).length) s.kt = kt; else delete s.kt;
    });
  }

  private compsHtml(st: Study): string {
    const list = this.host.comps();
    if (!list.length) return "";
    const dis = this.running ? " disabled" : "", thermal = st.kind === "thermal";
    if (thermal) return `<div class="sim-sec sim-comps"><h4>${esc(t("Components"))}</h4>`
      + `<p class="sim-note muted">${esc(t("A component is analysed with its part's material unless another is picked here: the analysis needs each one's thermal conductivity. Untick a component to leave it out of the study."))}</p>`
      + `<ul class="sim-complist">` + list.map(c => {
        const o = st.comps?.[c.id], own = o?.material, name = own?.name ?? c.material, k = own ? own.k : c.k, bd = o?.board;
        const brd = `<button class="btn small sim-crigid${bd ? " on" : ""}" data-a="compboard" data-c="${esc(c.id)}" aria-pressed="${bd ? "true" : "false"}" title="${esc(t("Circuit board: it conducts by its copper layers, along it far better than through it"))}"${dis || (o?.off ? " disabled" : "")}>${esc(t("Board"))}</button>`;
        if (bd) {
          const mp = bd.map, bk = mp ? stackK(bd.t ?? 1.6, bd, mp.means) : boardConductivity(bd.t ?? 1.6, bd), off = dis || (o?.off ? " disabled" : "");
          return `<li data-comp="${esc(c.id)}" class="${o?.off ? "off" : ""}"><label><input type="checkbox" data-k="compon" data-c="${esc(c.id)}"${o?.off ? "" : " checked"}${dis} /> <span class="sim-cname" translate="no">${esc(c.name)}</span></label>`
            + `<span class="sim-ck muted" data-v="compk" title="${esc(t("Thermal conductivity along the board / through it"))}">${sig(bk.along)} / ${sig(bk.through)} W/(m·K)</span>${brd}`
            + `<span class="sim-boardset"><label>${esc(t("Copper layers"))} <input type="text" inputmode="numeric" data-k="blayers" data-c="${esc(c.id)}" value="${bd.layers}"${off} /></label>`
            + `<label>${esc(t("Copper"))}, µm <input type="text" inputmode="decimal" data-k="bcopper" data-c="${esc(c.id)}" value="${sig(bd.copper)}"${off} /></label>`
            + (mp ? "" : `<label>${esc(t("Coverage"))}, % <input type="text" inputmode="decimal" data-k="bcover" data-c="${esc(c.id)}" value="${sig(bd.cover * 100)}"${off} /></label>`) + `</span>`
            + this.boardMapHtml(c.id, bd, off) + `</li>`;
        }
        return `<li data-comp="${esc(c.id)}" class="th ${o?.off ? "off" : ""}"><label><input type="checkbox" data-k="compon" data-c="${esc(c.id)}"${o?.off ? "" : " checked"}${dis} /> <span class="sim-cname" translate="no">${esc(c.name)}</span></label>`
          + `<span class="sim-ck muted" data-v="compk" title="${esc(t("Thermal conductivity"))}">${st.kt?.[c.id]?.length ? this.ktRange(st.kt[c.id]) : k ? `${sig(k)} W/(m·K)` : ""}</span>${brd}`
          + `<button class="btn small sim-crigid${st.kt?.[c.id]?.length ? " on" : ""}" data-a="ktab" data-b="${esc(c.id)}" aria-pressed="${this.ktOpen === c.id ? "true" : "false"}" title="${esc(t("Conductivity that changes with temperature"))}"${dis || (o?.off ? " disabled" : "")}><span translate="no">k(T)</span></button>`
          + `<button class="btn small${own ? " own" : ""}${name && k ? "" : " sim-warn"}" data-a="compmat" data-c="${esc(c.id)}" title="${esc(!name ? t("Pick a material") : !k ? t("This material has no thermal conductivity") : own ? t("Material picked for this study") : t("The part's material"))}"${dis}>${name ? `<span translate="no">${esc(name)}</span>` : esc(t("No material"))}</button>${this.ktOpen === c.id ? this.ktHtml(st, c.id) : ""}</li>`;
      }).join("") + `</ul></div>`;
    return `<div class="sim-sec sim-comps"><h4>${esc(t("Components"))}</h4>`
      + `<p class="sim-note muted">${esc(t("A component is analysed with its part's material unless another is picked here. Untick a component to leave it out of the study. A rigid component moves as a body: it does not deform, and its mass still counts."))}</p>`
      + `<ul class="sim-complist">` + list.map(c => {
        const o = st.comps?.[c.id], own = o?.material?.name, name = own ?? c.material;
        return `<li data-comp="${esc(c.id)}" class="${o?.off ? "off" : ""}"><label><input type="checkbox" data-k="compon" data-c="${esc(c.id)}"${o?.off ? "" : " checked"}${dis} /> <span class="sim-cname" translate="no">${esc(c.name)}</span></label>`
          + `<button class="btn small sim-crigid${o?.rigid ? " on" : ""}" data-a="comprigid" data-c="${esc(c.id)}" aria-pressed="${o?.rigid ? "true" : "false"}" title="${esc(t("Rigid: the component moves as a body, without strain"))}"${dis || (o?.off ? " disabled" : "")}>${esc(t("Rigid"))}</button>`
          + `<button class="btn small${own ? " own" : ""}${name ? "" : " sim-warn"}" data-a="compmat" data-c="${esc(c.id)}" title="${esc(own ? t("Material picked for this study") : t("The part's material"))}"${dis}>${name ? `<span translate="no">${esc(name)}</span>` : esc(t("No material"))}</button></li>`;
      }).join("") + `</ul></div>`;
  }

  /** An assembly study: the toolbox screws it takes as bolts, each with its property class and tightening. */
  private boltsHtml(st: Study): string {
    const list = this.screws(st);
    if (!list.length) return "";
    const dis = this.running ? " disabled" : "", found = this.freshBolts(st);
    const classes = (cur: string) => Object.keys(PROPERTY_CLASSES).map(c => `<option value="${c}"${c === cur ? " selected" : ""}>${c}</option>`).join("");
    const fields = (id: string, b: StudyBolt | undefined, d: number, off: boolean) => {
      const tq = !!b?.torque, v = b?.preload ? trim(tq ? b.preload / 1000 : b.preload) : "";
      const tension = tq && b?.preload ? ` title="${esc(t("Tension: {n} N", { n: sig(boltPreload(b, d)) }))}"` : "";
      return `<span class="sim-boltset"><select data-k="boltcls" data-c="${esc(id)}" title="${esc(t("Property class"))}"${dis || (off ? " disabled" : "")}>${id === "*" ? `<option value="">${esc(t("Class"))}</option>` : ""}${classes(id === "*" ? "" : b?.cls ?? DEFAULT_CLASS)}</select>`
        + `<input type="text" inputmode="decimal" data-k="boltpre" data-c="${esc(id)}" value="${esc(v)}" placeholder="${esc(t("Preload"))}"${tension} aria-label="${esc(t("Preload"))}"${dis || (off ? " disabled" : "")} />`
        + `<select data-k="boltby" data-c="${esc(id)}" aria-label="${esc(t("Preload as"))}" title="${esc(t("Preload as a tension, or as a tightening torque (nut factor {k})", { k: NUT_FACTOR }))}"${dis || (off ? " disabled" : "")}><option value="n"${tq ? "" : " selected"}>N</option><option value="nm"${tq ? " selected" : ""}>N·m</option></select></span>`;
    };
    const why: Record<string, string> = { head: "nothing under its head", nut: "its nut presses on nothing", thread: "no nut and no tapped hole" };
    return `<div class="sim-sec sim-bolts"><h4>${esc(t("Bolts"))}</h4>`
      + `<p class="sim-note muted">${esc(t("A toolbox screw is analysed as a bolt: a beam between the face under its head and its nut or tapped hole. Untick one to analyse it as a solid. The parts a bolt clamps stay joined where they touch unless their connection is set to Sliding or Not joined."))}</p>`
      + (list.length > 1 ? `<div class="sim-boltall"><span>${esc(t("All bolts"))}</span>${fields("*", undefined, 0, false)}</div>` : "")
      + `<ul class="sim-boltlist">` + list.map(c => {
        const b = st.bolts?.[c.id], hit = found?.list.find(x => x.id === c.id), miss = found?.missed.find(x => x.id === c.id);
        const note = b?.off ? "" : hit ? t(hit.tapped ? "in a tapped hole" : "with a nut") : miss ? t("not a bolt: {why}", { why: t(why[miss.why] ?? miss.why) }) : "";
        return `<li data-bolt="${esc(c.id)}" class="${b?.off ? "off" : ""}${miss && !b?.off ? " miss" : ""}"><label><input type="checkbox" data-k="bolton" data-c="${esc(c.id)}"${b?.off ? "" : " checked"}${dis} /> <span class="sim-cname" translate="no">${esc(c.name)}</span></label>`
          + (note ? `<span class="sim-boltnote muted" data-v="boltnote">${esc(note)}</span>` : "") + fields(c.id, b, c.fastener!.d, !!b?.off) + `</li>`;
      }).join("") + `</ul></div>`;
  }

  /** Changes a bolt's settings in the study (`*` = every screw's). */
  private setBolt(id: string, name: string, fn: (b: StudyBolt) => void) {
    const st = this.study();
    if (!st || this.running) return;
    const ids = id === "*" ? this.screws(st).map(c => c.id) : [id];
    this.host.change(name, d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const all = { ...(s.bolts ?? {}) };
      for (const k of ids) {
        const b = { ...(all[k] ?? {}) };
        fn(b);
        if (!b.preload) { delete b.preload; delete b.torque; delete b.k; }
        if (b.cls === DEFAULT_CLASS) delete b.cls;
        if (Object.keys(b).length) all[k] = b; else delete all[k];
      }
      if (Object.keys(all).length) s.bolts = all; else delete s.bolts;
    });
  }

  /** The bolts' results of the shown pass, each rated by its property class. */
  private boltRows() {
    const r = this.res, last = r?.passes.at(-1), st = this.study();
    if (!r?.bolts || !last?.bolts || last.bolts.length !== r.bolts.length) return [];
    return r.bolts.map((b, i) => {
      const v = last.bolts![i], set = st?.bolts?.[b.id], cls = set?.cls ?? DEFAULT_CLASS;
      return { id: b.id, name: b.name, cls, tapped: b.tapped, d: b.d, preload: boltPreload(set, b.d), axial: v.axial, shear: v.shear, moment: v.moment, a: v.a, b: v.b, ...boltCheck(v, b.d, b.pitch, proofStress(cls, b.d)) };
    });
  }

  /** The connectors' results of the shown pass: the force and moment each passes on, and how far a spring gave. */
  private connRows() {
    const r = this.res, last = r?.passes.at(-1);
    if (!r?.conns || !last?.connectors || last.connectors.length !== r.conns.length) return [];
    return r.conns.map((c, i) => {
      const v = last.connectors![i];
      return { id: c.id, name: c.name, spring: c.spring, force: Math.hypot(v.force[0], v.force[1], v.force[2]), moment: Math.hypot(v.moment[0], v.moment[1], v.moment[2]), stretch: Math.hypot(v.stretch[0], v.stretch[1], v.stretch[2]), f: v.force };
    });
  }

  private connTableHtml(): string {
    const rows = this.connRows();
    if (!rows.length) return "";
    return `<h5 class="sim-sub">${esc(t("Connectors"))}</h5><table class="sim-passes sim-bolttable sim-conntable"><thead><tr><th>${esc(t("Connector"))}</th><th>${esc(t("Force"))}, N</th><th>${esc(t("Moment"))}, N·m</th><th title="${esc(t("How far the spring gave"))}">mm</th></tr></thead><tbody>`
      + rows.map(x => `<tr data-conn="${esc(x.id)}" title="X ${sig(x.f[0])}, Y ${sig(x.f[1])}, Z ${sig(x.f[2])} N"><td translate="no">${esc(x.name)}</td><td data-v="kforce">${sig(x.force)}</td><td data-v="kmoment">${sig(x.moment * 1e-3)}</td><td data-v="kstretch">${x.spring ? sig(x.stretch) : "–"}</td></tr>`).join("")
      + `</tbody></table>`;
  }

  /** The welds' results of the shown pass: what each carries, and the stress on its throat. */
  private weldRows() {
    const r = this.res, last = r?.passes.at(-1), st = this.study();
    if (!r?.welds || !last?.welds || last.welds.length !== r.welds.length) return [];
    return r.welds.map((w, i) => {
      const v = last.welds![i], sw = st?.welds?.find(x => x.id === w.id), a = sw?.throat ?? DEFAULT_THROAT;
      const spot = v.spots !== undefined || sw?.on === "points", dia = sw?.dia ?? DEFAULT_SPOT;
      return { id: w.id, name: w.name, throat: a, length: v.length, force: Math.hypot(v.force[0], v.force[1], v.force[2]), peak: v.peak, mean: v.mean, stress: spot ? v.peak / (Math.PI * dia * dia / 4) : v.peak / a, at: v.at, spot, spots: v.spots ?? 0, dia };
    });
  }

  private weldTableHtml(): string {
    const every = this.weldRows(), rows = every.filter(x => !x.spot), spots = every.filter(x => x.spot);
    if (!every.length) return "";
    const spotHtml = spots.length ? `<h5 class="sim-sub">${esc(t("Spot welds"))}</h5><table class="sim-passes sim-bolttable sim-spottable"><thead><tr><th>${esc(t(SPOT_LABEL))}</th><th>${esc(t("Spots"))}</th><th title="${esc(t("Largest force of one spot"))}">N</th><th title="${esc(t("Largest force of one spot over its area"))}">MPa</th></tr></thead><tbody>`
      + spots.map(x => `<tr data-weld="${esc(x.id)}" title="${esc(`${t("Diameter")}: ${trim(x.dia)} mm. ${t("Force")}: ${sig(x.force)} N. ${t("Mean")}: ${sig(x.mean)} N`)}"><td translate="no">${esc(x.name)}</td><td data-v="scount">${x.spots}</td><td data-v="speak">${sig(x.peak)}</td><td data-v="sstress">${sig(x.stress)}</td></tr>`).join("")
      + `</tbody></table><p class="sim-note muted" data-v="spotnote">${esc(t(SPOT_RESULT_NOTE))}</p>` : "";
    if (!rows.length) return spotHtml;
    return spotHtml + `<h5 class="sim-sub">${esc(t("Welds"))}</h5><table class="sim-passes sim-bolttable sim-weldtable"><thead><tr><th>${esc(t("Weld"))}</th><th>${esc(t("Force"))}, N</th><th title="${esc(t("Largest force per length"))}">N/mm</th><th title="${esc(t("Largest force per length over the throat"))}">MPa</th></tr></thead><tbody>`
      + rows.map(x => `<tr data-weld="${esc(x.id)}" title="${esc(`${t("Length")}: ${sig(x.length)} mm. ${t("Throat")}: ${trim(x.throat)} mm. ${t("Mean")}: ${sig(x.mean)} N/mm`)}"><td translate="no">${esc(x.name)}</td><td data-v="wforce">${sig(x.force)}</td><td data-v="wpeak">${sig(x.peak)}</td><td data-v="wstress">${sig(x.stress)}</td></tr>`).join("")
      + `</tbody></table><p class="sim-note muted" data-v="weldnote">${esc(t(WELD_RESULT_NOTE))}</p>`;
  }

  private boltTableHtml(): string {
    const rows = this.boltRows();
    if (!rows.length) return "";
    return `<h5 class="sim-sub">${esc(t("Bolts"))}</h5><table class="sim-passes sim-bolttable"><thead><tr><th>${esc(t("Bolt"))}</th><th>${esc(t("Tension"))}, N</th><th>${esc(t("Shear"))}, N</th><th title="${esc(t("Safety factor against the proof stress of the property class"))}">${esc(t("SF"))}</th></tr></thead><tbody>`
      + rows.map(x => `<tr data-bolt="${esc(x.id)}" class="${x.sf < 1 ? "bad" : ""}" title="${esc(`${t("Bending moment")}: ${sig(x.moment * 1e-3)} N·m. ${t("Stress")}: ${sig(x.eq)} MPa. ${t("Class")} ${x.cls}`)}"><td translate="no">${esc(x.name)}</td><td data-v="baxial">${sig(x.axial)}</td><td data-v="bshear">${sig(x.shear)}</td><td data-v="bsf">${isFinite(x.sf) ? sig(x.sf) : "–"}</td></tr>`).join("")
      + `</tbody></table><p class="sim-note muted" data-v="boltnote2">${esc(t(BOLT_NOTE))}</p>`;
  }

  /** The material a component is analysed with in this study: a picked one, or (No material) its part's again. */
  private async pickCompMat(id: string) {
    const st = this.study();
    if (!st || this.running) return;
    const got = await pickMaterial({ current: st.comps?.[id]?.material ?? null, allowNone: true });
    if (!got) return;
    const ref = got.material ? toRef(got.material) : null;
    this.host.change(t("Component material"), d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const c = { ...(s.comps?.[id] ?? {}) };
      if (ref) c.material = ref; else delete c.material;
      this.setComp(s, id, c);
    });
    if (!ref) toast(t("The component is analysed with its part's material again."), "info");
  }

  /** A thermal study: the component is a circuit board (its conductivity from its copper), or an ordinary body again. */
  private toggleBoard(id: string) {
    const st = this.study();
    if (!st || this.running) return;
    const on = !st.comps?.[id]?.board, thick = on ? this.compThickness(id) : null;
    this.host.change(on ? t("Circuit board") : t("Ordinary component"), d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const c = { ...(s.comps?.[id] ?? {}) };
      if (on) c.board = { ...DEFAULT_STACK, ...(thick ? { t: thick } : {}) }; else delete c.board;
      this.setComp(s, id, c);
    });
    if (on && !thick) toast(t("The component is not a flat plate square to an axis: it is analysed with the board's in-plane conductivity in every direction."), "info");
  }

  /** The components marked as circuit boards in the active thermal study of an assembly (Gerber drops go to them). */
  boardComps(): string[] {
    const st = this.study();
    if (!st || st.kind !== "thermal" || !this.host.asm()) return [];
    return Object.entries(st.comps ?? {}).filter(([, c]) => c.board).map(([id]) => id);
  }

  /** A board's copper from its Gerber set (FR-TBRD-020): the button to read one, or the map with what it holds. */
  private boardMapHtml(id: string, bd: BoardStack & { map?: CopperMap }, off: string): string {
    const m = bd.map;
    if (!m) return `<span class="sim-bmap"><button class="btn small" data-a="bgerber" data-c="${esc(id)}" title="${esc(t("Read the board's Gerber files: the conductivity then follows its copper and plated holes cell by cell"))}"${off}>${esc(t("Copper from Gerber…"))}</button></span>`;
    const layers = m.labels.map((l, i) => `${esc(layerLabel(l))} ${Math.round(m.means[i] * 100)} %`).join(", ");
    return `<span class="sim-bmap on"><img data-v="bmap" alt="${esc(t("Copper map"))}" src="${this.mapImage(m)}" />`
      + `<span class="muted" data-v="bmapinfo"><span translate="no">${esc(m.name)}</span>: ${layers}; ${esc(t("{n} plated holes", { n: m.holes }))}; ${esc(t("cells of {s} mm", { s: sig(m.cell) }))}</span>`
      + `<button class="btn small" data-a="bgerber" data-c="${esc(id)}"${off}>${esc(t("Other Gerber files…"))}</button><button class="btn small" data-a="bgerberclear" data-c="${esc(id)}"${off}>${esc(t("Even copper"))}</button></span>`;
  }

  private mapImages = new WeakMap<CopperMap, string>();
  /** A copper map as a picture (cached per map). */
  private mapImage(m: CopperMap): string {
    let u = this.mapImages.get(m);
    if (u) return u;
    const p = mapPicture(m), cv = document.createElement("canvas");
    cv.width = p.w; cv.height = p.h;
    cv.getContext("2d")!.putImageData(new ImageData(p.rgba, p.w, p.h), 0, 0);
    u = cv.toDataURL("image/png");
    this.mapImages.set(m, u);
    return u;
  }

  /** Reads Gerber files picked by the user into the board's copper map. */
  private pickGerber(id: string) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true;
    inp.onchange = async () => {
      const files = [...(inp.files ?? [])];
      if (files.length) await this.readGerber(id, await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() }))));
    };
    inp.click();
  }

  /** The board's copper map from Gerber files (or zips of them); `null` = even copper again. */
  async readGerber(id: string, files: { name: string; data: ArrayBuffer }[] | null): Promise<boolean> {
    const st = this.study();
    if (!st || this.running) return false;
    let map: CopperMap | null = null;
    if (files) {
      try { map = await copperFromGerber(files, gerberName(files.map(f => f.name))); }
      catch (err) { toast(String((err as Error).message).startsWith("E-TH-GERBER") ? t("These files hold no copper layer: pick the board's Gerber files or a zip of them.") : t("The Gerber files could not be read: {e}", { e: (err as Error).message }), "warn"); return false; }
    }
    this.host.change(map ? t("Copper from Gerber") : t("Even copper"), d => {
      const s = d.studies?.find(x => x.id === st.id), b = s?.comps?.[id]?.board;
      if (!s || !b) return;
      const nb = { ...b };
      if (map) { nb.map = map; nb.layers = map.labels.length; } else delete nb.map;
      this.setComp(s, id, { ...s.comps![id], board: nb });
    });
    if (map) toast(t("Copper read from {n} layers: the board's conductivity now follows its copper.", { n: map.labels.length }), "info");
    return true;
  }

  /** The thickness of a component that is a flat plate square to an axis, mm, from the shown model. */
  private compThickness(id: string): number | null {
    const m = this.host.model() as AsmModel | null;
    if (!m?.names) return null;
    const g = m.geometry, pa = g.getAttribute("position"), idx = g.getIndex()?.array ?? null, tris: number[] = [];
    m.faces.forEach((f, i) => {
      if (compOf(m.names[i] ?? "") !== id) return;
      for (let q = 3 * f.triStart; q < 3 * (f.triStart + f.triCount); q++) { const v = idx ? idx[q] : q; tris.push(pa.getX(v), pa.getY(v), pa.getZ(v)); }
    });
    const pl = plateAxis(tris);
    return pl ? Math.round(pl.t * 1000) / 1000 : null;
  }

  private setBoard(id: string, key: keyof BoardStack, v: number) {
    const st = this.study();
    if (!st) return;
    this.host.change(t("Board copper"), d => {
      const s = d.studies?.find(x => x.id === st.id), b = s?.comps?.[id]?.board;
      if (!s || !b) return;
      this.setComp(s, id, { ...s.comps![id], board: { ...b, [key]: v } });
    });
  }

  /** Makes a component rigid in this study, or elastic again. */
  private toggleRigid(id: string) {
    const st = this.study();
    if (!st || this.running) return;
    const on = !st.comps?.[id]?.rigid;
    this.host.change(on ? t("Rigid component") : t("Elastic component"), d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const c = { ...(s.comps?.[id] ?? {}) };
      if (on) c.rigid = true; else delete c.rigid;
      this.setComp(s, id, c);
    });
  }

  private setComp(s: Study, id: string, c: StudyComp) {
    const all = { ...(s.comps ?? {}) };
    if (c.off || c.material || c.rigid || c.board) all[id] = c; else delete all[id];
    if (Object.keys(all).length) s.comps = all; else delete s.comps;
  }

  /** An assembly study: how its components are joined, and after a solve the pairs found touching. */
  private linksHtml(st: Study): string {
    const res = this.res && !this.stale() ? this.res : null, comps = res?.comps ?? [], found = res?.passes.at(-1)?.contacts ?? [];
    const pre = this.freshFound(st);
    const key = pairKey;
    const typed = new Map((st.links ?? []).filter(l => !THERMAL_LINK_TYPES.has(l.type)).map(l => [key(l.a, l.b), l.type]));
    const glue = new Map((st.links ?? []).filter(l => l.type === "adhesive").map(l => [key(l.a, l.b), l]));
    const names = new Map([...(pre?.comps ?? []), ...comps].map(c => [c.key, c.name]));
    type Row = { a: string; b: string; area: number | null; gap?: number; force?: number[]; moment?: number[] };
    // what was found before the solve (with its gaps), then what the solve joined, then pairs only typed
    const rows: Row[] = (pre?.list ?? []).map(c => ({ a: pre!.comps[c.a]?.key ?? "", b: pre!.comps[c.b]?.key ?? "", area: c.area, gap: c.gap })).filter(r => r.a && r.b);
    const at = new Map(rows.map(r => [key(r.a, r.b), r]));
    for (const c of found) {
      const a = comps[c.a]?.key ?? "", b = comps[c.b]?.key ?? "";
      if (!a || !b) continue;
      const r = at.get(key(a, b));
      // the solver's own row: its components in its order, since the force is what its first passes to its second
      if (r) { r.a = a; r.b = b; r.area = c.area; r.force = c.force; r.moment = c.moment; }
      else { const n: Row = { a, b, area: c.area, force: c.force, moment: c.moment }; rows.push(n); at.set(key(a, b), n); }
    }
    const mag = (v: number[]) => Math.hypot(v[0], v[1], v[2]), forces = rows.some(r => r.force), gaps = rows.some(r => r.gap != null);
    for (const l of st.links ?? []) if (!THERMAL_LINK_TYPES.has(l.type) && !at.has(key(l.a, l.b))) rows.push({ a: l.a, b: l.b, area: null });
    const all = rows.length, fl = this.linkFilter;
    const used = [...new Set(rows.flatMap(r => [r.a, r.b]))];
    if (fl.comp && !used.includes(fl.comp)) fl.comp = "";
    const shown = rows.filter(r => (!fl.comp || r.a === fl.comp || r.b === fl.comp) && (!fl.type || (typed.get(key(r.a, r.b)) ?? "bonded") === fl.type));
    const f = UNITS[units.current].f;
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(t(label))}</option>`;
    let html = `<div class="sim-sec sim-links"><h4>${esc(t("Connections"))}</h4>`
      + `<p class="sim-note muted">${esc(t("Components that touch, or come within the gap, are joined."))}</p>`
      + `<label class="sim-kv2">${esc(t("Gap tolerance"))} <input type="number" data-k="gap" min="0" step="0.05" value="${sig((st.settings.gap ?? DEFAULT_GAP) * f)}" aria-label="${esc(t("Gap tolerance"))}" /> ${esc(units.current)}</label>`
      + `<button class="btn small sim-find" data-a="findlinks"${this.finding || this.running ? " disabled" : ""}>${esc(this.finding ? t("Finding the connections…") : t("Find connections"))}</button>`;
    if (all >= 4) html += `<div class="sim-lfilter"><select data-k="cfilter" aria-label="${esc(t("Component"))}"><option value="">${esc(t("All components"))}</option>${used.map(k => `<option value="${esc(k)}"${k === fl.comp ? " selected" : ""} translate="no">${esc(names.get(k) ?? k)}</option>`).join("")}</select>`
      + `<select data-k="tfilter" aria-label="${esc(t("Type"))}">${opt("", "All types", fl.type)}${opt("bonded", "Bonded", fl.type)}${opt("sliding", "Sliding", fl.type)}${opt("adhesive", "Adhesive", fl.type)}${opt("none", "Not joined", fl.type)}</select></div>`;
    if (all) {
      const rows = shown;
      html += `<table class="sim-contacts"><thead><tr><th>${esc(t("Components"))}</th><th>${esc(t("Area"))}, ${esc(units.current)}²${gaps ? `<br />${esc(t("Gap"))}, ${esc(units.current)}` : ""}</th>${forces ? `<th>${esc(t("Force"))}, N<br />${esc(t("Moment"))}, N·m</th>` : ""}<th>${esc(t("Type"))}</th></tr></thead><tbody>`
        + rows.map(r => {
          const cur = typed.get(key(r.a, r.b)) ?? "bonded";
          const k = key(r.a, r.b), patch = !!pre?.list.some(c => key(pre.comps[c.a]?.key ?? "", pre.comps[c.b]?.key ?? "") === k);
          return `<tr data-link="${esc(k)}"${patch ? ` data-a="link" tabindex="0"` : ""} class="${k === this.linkSel ? "sel" : ""}"><td translate="no">${esc(names.get(r.a) ?? r.a)} – ${esc(names.get(r.b) ?? r.b)}</td><td>${r.area == null ? "" : sig(r.area * f * f)}${gaps ? `<br /><span data-v="cgap">${r.gap == null ? "" : String(Number((r.gap * f).toPrecision(2)))}</span>` : ""}</td>`
            + (forces ? `<td><span data-v="cforce" title="${r.force ? `${r.force.map(x => sig(x)).join(", ")} N` : ""}">${r.force ? sig(mag(r.force)) : ""}</span><br /><span data-v="cmoment" title="${r.moment ? `${r.moment.map(x => sig(x * 1e-3)).join(", ")} N·m` : ""}">${r.moment ? sig(mag(r.moment) * 1e-3) : ""}</span></td>` : "")
            + `<td><select data-k="link" data-a="${esc(r.a)}" data-b="${esc(r.b)}" aria-label="${esc(t("Type"))}">${opt("bonded", "Bonded", cur)}${opt("sliding", "Sliding", cur)}${opt("adhesive", "Adhesive", cur)}${opt("none", "Not joined", cur)}</select></td></tr>`
            + (cur === "adhesive" ? `<tr class="sim-glue" data-glue="${esc(k)}"><td colspan="${forces ? 4 : 3}"><label title="${esc(t("Thickness of the adhesive layer"))}">${esc(t("Thickness"))} <input type="number" data-k="gluet" data-a="${esc(r.a)}" data-b="${esc(r.b)}" min="0" step="0.05" value="${trim(glue.get(k)?.t ?? DEFAULT_GLUE.t)}" /> mm</label> <label title="${esc(t("Elastic modulus of the adhesive"))}">E <input type="number" data-k="gluee" data-a="${esc(r.a)}" data-b="${esc(r.b)}" min="0" step="100" value="${trim(glue.get(k)?.E ?? DEFAULT_GLUE.E)}" /> MPa</label></td></tr>` : "");
        }).join("") + `</tbody></table>`;
      if (shown.length >= 2) html += `<label class="sim-kv2">${esc(t("All shown:"))} <select data-k="linkall" aria-label="${esc(t("All shown:"))}"><option value="">${esc(t("Set type…"))}</option>${opt("bonded", "Bonded", "-")}${opt("sliding", "Sliding", "-")}${opt("adhesive", "Adhesive", "-")}${opt("none", "Not joined", "-")}</select></label>`;
      if (glue.size) html += `<p class="sim-note muted" data-v="gluenote">${esc(t(GLUE_NOTE))}</p>`;
      // mates guide the defaults (FR-CON-008): a pair turning on a hinge or concentric mate is proposed as sliding
      const mates = this.host.mates(), of = (k: string) => compOf(k).split("/")[0];
      for (const r of rows) {
        if (typed.has(key(r.a, r.b))) continue;
        const mt = mates.find(x => (x.a === of(r.a) && x.b === of(r.b)) || (x.a === of(r.b) && x.b === of(r.a)));
        if (mt) html += `<p class="sim-note sim-matehint" data-v="matehint">${esc(t(mt.type === "hinge" ? "A hinge mate joins {a} and {b}." : "A concentric mate joins {a} and {b}.", { a: names.get(r.a) ?? r.a, b: names.get(r.b) ?? r.b }))} <button class="btn small" data-a="matelink" data-la="${esc(r.a)}" data-lb="${esc(r.b)}" title="${esc(t("Sliding lets the two turn and slide on each other; Bonded holds them as one piece."))}">${esc(t("Make sliding"))}</button></p>`;
      }
    if (pre?.list.length) html += `<p class="sim-note muted" data-v="cpatchnote">${esc(t("Click a row to show the contact: orange on the first component, blue on the second."))}</p>`;
      if (forces) html += `<p class="sim-note muted" data-v="cforcenote">${esc(t("Force: what the first component passes to the second. Moment: about the centre of the contact."))}</p>`;
    } else html += `<p class="sim-note muted" data-v="nolinks">${esc(res || pre ? t("No components touch.") : t("Find connections lists the pairs that touch; a solve lists them too."))}</p>`;
    return html + `</div>`;
  }

  /**
   * A thermal study of an assembly: how heat passes where the components touch (FR-TCON-001..004), and after a
   * solve the heat through each contact with the temperature step across it.
   */
  private thermalLinksHtml(st: Study): string {
    const res = this.res && !this.stale() ? this.res : null, comps = res?.comps ?? [], found = res?.passes.at(-1)?.thermal?.contacts ?? [];
    const pre = this.freshFound(st), key = pairKey, bolts = this.freshBolts(st)?.list ?? [], bolted = this.boltedPairs(bolts);
    const typed = new Map((st.links ?? []).filter(l => l.type === "none" || THERMAL_LINK_TYPES.has(l.type)).map(l => [key(l.a, l.b), l]));
    const isBolted = (a: string, b: string) => bolted.has(key(compOf(a), compOf(b)));
    const names = new Map([...(pre?.comps ?? []), ...comps].map(c => [c.key, c.name]));
    type Row = { a: string; b: string; area: number | null; heat?: number; drop?: number };
    const rows: Row[] = (pre?.list ?? []).map(c => ({ a: pre!.comps[c.a]?.key ?? "", b: pre!.comps[c.b]?.key ?? "", area: c.area })).filter(r => r.a && r.b);
    const at = new Map(rows.map(r => [key(r.a, r.b), r]));
    for (const c of found) {
      const a = comps[c.a]?.key ?? "", b = comps[c.b]?.key ?? "";
      if (!a || !b) continue;
      const r = at.get(key(a, b));
      if (r) { r.a = a; r.b = b; r.area = c.area; r.heat = c.heat; r.drop = c.ta - c.tb; }
      else { const n: Row = { a, b, area: c.area, heat: c.heat, drop: c.ta - c.tb }; rows.push(n); at.set(key(a, b), n); }
    }
    for (const l of typed.values()) if (!at.has(key(l.a, l.b))) rows.push({ a: l.a, b: l.b, area: null });
    const heats = rows.some(r => r.heat != null), f = UNITS[units.current].f, dis = this.running ? " disabled" : "";
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(t(label))}</option>`;
    const padOpts = (pt: number, pk: number) => { const i = padEntry(pt, pk);
      return `<option value=""${i < 0 ? " selected" : ""}>${esc(t("Typed values"))}</option>` + PAD_LIBRARY.map((p, j) => `<option value="${j}"${j === i ? " selected" : ""}>${esc(t(p.name))}</option>`).join(""); };
    let html = `<div class="sim-sec sim-links sim-tlinks"><h4>${esc(t("Connections"))}</h4>`
      + `<p class="sim-note muted">${esc(t("Components that touch, or come within the gap, pass heat to each other. A contact is perfect unless a pad, a contact resistance, an air gap or no contact is set for it."))}</p>`
      + `<label class="sim-kv2">${esc(t("Gap tolerance"))} <input type="number" data-k="gap" min="0" step="0.05" value="${sig((st.settings.gap ?? DEFAULT_GAP) * f)}" aria-label="${esc(t("Gap tolerance"))}" /> ${esc(units.current)}</label>`
      + `<button class="btn small sim-find" data-a="findlinks"${this.finding || this.running ? " disabled" : ""}>${esc(this.finding ? t("Finding the connections…") : t("Find connections"))}</button>`;
    if (!rows.length) return html + `<p class="sim-note muted" data-v="nolinks">${esc(res || pre ? t("No components touch.") : t("Find connections lists the pairs that touch; a solve lists them too."))}</p></div>`;
    html += `<table class="sim-contacts"><thead><tr><th>${esc(t("Components"))}<br />${esc(t("Area"))}, ${esc(units.current)}²</th>${heats ? `<th>${esc(t("Heat"))}, W<br />ΔT, °C</th>` : ""}<th>${esc(t("Contact"))}</th></tr></thead><tbody>`
      + rows.map(r => {
        const bt = isBolted(r.a, r.b), k = key(r.a, r.b), l = typed.get(k), cur = l?.type ?? (bt ? "bolted" : "perfect");
        const patch = !!pre?.list.some(c => key(pre.comps[c.a]?.key ?? "", pre.comps[c.b]?.key ?? "") === k);
        const ab = `data-a="${esc(r.a)}" data-b="${esc(r.b)}"`;
        return `<tr data-link="${esc(k)}"${patch ? ` data-a="link" tabindex="0"` : ""} class="${k === this.linkSel ? "sel" : ""}"><td><span translate="no">${esc(names.get(r.a) ?? r.a)} – ${esc(names.get(r.b) ?? r.b)}</span><br /><span class="muted" data-v="carea">${r.area == null ? "" : sig(r.area * f * f)}</span></td>`
          + (heats ? `<td><span data-v="cheat">${r.heat == null ? "" : sig(Math.abs(r.heat))}</span><br /><span data-v="cdrop">${r.drop == null ? "" : pct(Math.abs(r.drop))}</span></td>` : "")
          + `<td><select data-k="tlink" ${ab} aria-label="${esc(t("Contact"))}"${dis}>${opt("perfect", "Perfect", cur)}${bt ? opt("bolted", "Bolted joint", cur) : ""}${opt("pad", "Pad or paste", cur)}${opt("resist", "Contact resistance", cur)}${opt("air", "Air gap", cur)}${opt("none", "No contact", cur)}</select></td></tr>`
          + (cur === "pad" ? `<tr class="sim-glue" data-tpad="${esc(k)}"><td colspan="${heats ? 3 : 2}"><label>${esc(t("Material"))} <select data-k="padlib" ${ab}${dis}>${padOpts(l?.t ?? DEFAULT_PAD.t, l?.k ?? DEFAULT_PAD.k)}</select></label> <label title="${esc(t("Thickness of the pad or paste layer"))}">${esc(t("Thickness"))} <input type="number" data-k="padt" ${ab} min="0" step="0.05" value="${trim(l?.t ?? DEFAULT_PAD.t)}"${dis} /> mm</label> <label title="${esc(t("Thermal conductivity of the pad or paste"))}">k <input type="number" data-k="padk" ${ab} min="0" step="0.5" value="${trim(l?.k ?? DEFAULT_PAD.k)}"${dis} /> W/(m·K)</label></td></tr>` : "")
          + (cur === "air" ? `<tr class="sim-glue" data-tair="${esc(k)}"><td colspan="${heats ? 3 : 2}"><label title="${esc(t("Thickness of the air layer between the two faces"))}">${esc(t("Air layer"))} <input type="number" data-k="airt" ${ab} min="0.01" step="0.05" value="${trim(l?.t ?? DEFAULT_AIR_GAP)}"${dis} /> mm</label></td></tr>` : "")
          + (cur === "resist" || cur === "bolted" ? `<tr class="sim-glue" data-tres="${esc(k)}"><td colspan="${heats ? 3 : 2}"><label title="${esc(t("Heat passed per area and per degree of difference between the two surfaces"))}">${esc(t("Contact conductance"))} <input type="number" data-k="tcch" ${ab} min="0" step="500" value="${trim(l?.h ?? (cur === "bolted" ? BOLTED_TCC : DEFAULT_TCC))}"${dis} /> W/(m²·K)</label></td></tr>` : "");
      }).join("") + `</tbody></table>`;
    if (rows.some(r => typed.get(key(r.a, r.b))?.type === "air")) html += `<p class="sim-note muted" data-v="airnote">${esc(t("An air gap conducts only through the air (no convection or radiation across it), with air's conductivity at the joint's mean temperature."))}</p>`;
    if (rows.some(r => isBolted(r.a, r.b))) html += `<p class="sim-note muted" data-v="boltnote">${esc(t("A pair a toolbox bolt clamps is a bolted joint: it passes heat by a contact conductance of {h} W/(m²·K) unless you set another.", { h: String(BOLTED_TCC) }))}</p>`;
    if (heats) html += `<p class="sim-note muted" data-v="cheatnote">${esc(t("Heat: what passes through the contact. ΔT: the temperature difference between its two sides."))}</p>`;
    if (pre?.list.length) html += `<p class="sim-note muted" data-v="cpatchnote">${esc(t("Click a row to show the contact: orange on the first component, blue on the second."))}</p>`;
    return html + `</div>`;
  }

  /** A thermal study's results by component: its temperatures and the heat made in it. */
  /** Temperature limits of the components a board's package gives one (FR-TBRD-022), by component id. */
  private compLimits(): Map<string, number> {
    const out = new Map<string, number>(), st = this.study(), off = new Set(st?.suppressed ?? []);
    for (const l of st?.loads ?? []) if (l.type === "pkgheat" && !off.has(l.id)) for (const x of l.parts ?? []) if (x.limit !== undefined) for (const c of x.comps) out.set(c, x.limit);
    return out;
  }

  /**
   * Where each package part's heat went in the solve (FR-TBRD-003): conducted into the board, off its own surface
   * into the air, and elsewhere (a heatsink, other parts, the chassis share left out), beside the package's split.
   */
  private heatPaths(r: Results | null = this.res && !this.stale() ? this.res : null) {
    const last = r?.passes.at(-1), rows = last?.thermal?.comps, st = this.study(), off = new Set(st?.suppressed ?? []);
    const l = st?.loads.find(x => x.type === "pkgheat" && !off.has(x.id) && x.board);
    if (!r?.comps || !rows || !l || (r.env && r.passes === r.env)) return [];
    const board = r.comps.findIndex(c => compOf(c.key) === l.board), contacts = last!.thermal!.contacts ?? [];
    if (board < 0) return [];
    const out: { name: string; p: number; board: number; air: number; other: number; pkg: { board: number; air: number; sink: number } | null }[] = [];
    for (const x of l.parts ?? []) {
      if (x.off || !(x.p >= PACKAGE_MIN_POWER) || !x.comps.length) continue;
      const comps = new Set(x.comps), doms = new Set<number>();
      r.comps.forEach((c, d) => { if (d !== board && comps.has(compOf(c.key))) doms.add(d); });
      if (!doms.size) continue;
      let own = 0, air = 0, toBoard = 0;
      for (const d of doms) { own += rows[d]?.power ?? 0; air += rows[d]?.out ?? 0; }
      for (const c of contacts) { if (doms.has(c.a) && c.b === board) toBoard += c.heat; else if (doms.has(c.b) && c.a === board) toBoard -= c.heat; }
      const chassis = l.split && x.path === "chassis" ? Math.min(x.p, Math.max(0, x.sink ?? 0)) : 0;
      const direct = l.split ? Math.max(0, x.p - own - chassis) : 0;
      const b = toBoard + direct, pkg = x.board !== undefined || x.sink !== undefined ? { board: x.board ?? 0, sink: x.sink ?? 0, air: Math.max(0, x.p - (x.board ?? 0) - (x.sink ?? 0)) } : null;
      out.push({ name: x.name, p: x.p, board: b, air, other: x.p - b - air, pkg });
    }
    return out;
  }

  private heatPathsHtml(): string {
    const rows = this.heatPaths();
    if (!rows.length) return "";
    const share = (v: number, p: number) => `${Math.round((100 * v) / p)}`;
    const split = !!this.study()?.loads.find(x => x.type === "pkgheat" && x.split);
    return `<h5 class="sim-sub">${esc(t("Heat paths"))}</h5>`
      + `<table class="sim-comptable sim-paths"><thead><tr><th>${esc(t("Part"))}</th><th title="${esc(t("Heat made in the part"))}">W</th><th title="${esc(t("Conducted into the board"))}">${esc(t("Board"))}<br />%</th><th title="${esc(t("Off the part's own surface: convection, radiation, or a heatsink resistance on it"))}">${esc(t("Surface"))}<br />%</th><th title="${esc(t("Into a heatsink, other parts or the chassis"))}">${esc(t("Other"))}<br />%</th></tr></thead><tbody>`
      + rows.map(x => `<tr data-path="${esc(x.name)}"${x.pkg ? ` title="${esc(t("The package's split: board {b} %, air {a} %, heatsink or chassis {s} %", { b: share(x.pkg.board, x.p), a: share(x.pkg.air, x.p), s: share(x.pkg.sink, x.p) }))}"` : ""}><td translate="no">${esc(x.name)}</td><td>${sig(x.p)}</td><td data-v="pboard"${x.board < 0 ? ` title="${esc(t("It takes heat in from the board"))}"` : ""}>${share(x.board, x.p).replace("-", "−")}</td><td data-v="pair">${share(x.air, x.p)}</td><td data-v="pother">${share(Math.max(0, x.other), x.p)}</td></tr>`).join("") + `</tbody></table>`
      + `<p class="sim-note muted" data-v="pathnote">${esc(split ? t("The package's split is kept: its board shares enter the board under each part as fixed powers.") : t("The heat goes where the conductances send it; hover a row for the package's split."))}</p>`;
  }

  /** Box of each component on the plot mesh (min x, y, z, max x, y, z), by component id; an assembly only. */
  private compBoxes(r: Results): Map<string, number[]> {
    const out = new Map<string, number[]>(), am = this.host.model() as AsmModel | null;
    if (!am?.parts) return out;
    const vp = this.partsOfMesh(am, r.mesh), comp = am.parts.map((_p, k) => compOf(am.names[am.faceOff[k]] ?? "")), pos = r.mesh.pos;
    for (let v = 0; v < vp.length; v++) {
      if (vp[v] < 0) continue;
      const id = comp[vp[v]];
      let b = out.get(id);
      if (!b) out.set(id, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < 3; i++) { const x = pos[3 * v + i]; if (x < b[i]) b[i] = x; if (x > b[i + 3]) b[i + 3] = x; }
    }
    return out;
  }

  /**
   * Electrolytics of a board study next to a package part over 1 W (FR-TBRD-023): the capacitor, the hot part, the gap
   * between their boxes (mm) and the spread of the capacitor's surface temperature in the solve (K).
   */
  private nearHotRows(r: Results | null = this.res && !this.stale() ? this.res : null) {
    const last = r?.passes.at(-1), rows = last?.thermal?.comps, st = this.study(), off = new Set(st?.suppressed ?? []);
    const l = st?.loads.find(x => x.type === "pkgheat" && !off.has(x.id));
    if (!r?.comps || !rows || !l?.parts?.some(x => x.elyt) || (r.env && r.passes === r.env)) return [];
    const boxes = this.compBoxes(r), parts = l.parts.filter(x => !x.off || x.elyt);
    const boxOf = (comps: string[]) => {
      const bs = comps.map(c => boxes.get(c)).filter((b): b is number[] => !!b);
      return bs.length ? [0, 1, 2].map(i => Math.min(...bs.map(b => b[i]))).concat([3, 4, 5].map(i => Math.max(...bs.map(b => b[i])))) : undefined;
    };
    const near = nearHot(parts.map(x => ({ id: x.id, box: boxOf(x.comps), p: x.off ? 0 : x.p, elyt: !!x.elyt })));
    return near.map(n => {
      const cap = parts.find(x => x.id === n.cap)!, hot = parts.find(x => x.id === n.hot)!, cs = new Set(cap.comps);
      let lo = Infinity, hi = -Infinity;
      r.comps!.forEach((c, d) => { if (cs.has(compOf(c.key)) && rows[d]) { lo = Math.min(lo, rows[d].min); hi = Math.max(hi, rows[d].max); } });
      return { cap: cap.name, hot: hot.name, gap: n.gap, p: n.p, spread: hi > lo ? hi - lo : 0, max: hi };
    });
  }

  private nearHtml(r: Results) {
    const near = this.nearHotRows(r);
    if (!near.length) return "";
    return `<ul class="sim-near" data-v="tnear">${near.map(n => `<li class="sim-warn" data-near="${esc(n.cap)}">${esc(t("{name}: {gap} mm from {hot} ({p} W), {k} K across it", { name: n.cap, gap: sig(n.gap), hot: n.hot, p: sig(n.p), k: sig(n.spread) }))}</li>`).join("")}</ul>`
      + `<p class="sim-note muted" data-v="nearnote">${esc(t("Electrolytic capacitors within 10 mm of a part over 1 W: heat from that part runs across them, so their hot side ages faster than the mean says."))}</p>`;
  }

  private thermalCompsHtml(r: Results, last: PassResult): string {
    const rows = last.thermal?.comps;
    if (!r.comps || !rows || rows.length < 2) return "";
    const alone = this.aloneDom(), power = rows.some(x => x.power), limits = this.compLimits();
    const lim = (d: number) => limits.get(compOf(r.comps![d].key)), over = rows.filter((x, d) => lim(d) !== undefined && x.max > lim(d)!).length;
    return `<h5 class="sim-sub">${esc(t("By component"))}</h5>`
      + (limits.size ? `<p class="${over ? "sim-warn" : "sim-note muted"}" data-v="tover">${esc(over ? t("{n} part is over its temperature limit.|{n} parts are over their temperature limits.", { n: over }) : t("Every part is within its temperature limit."))}</p>` : "")
      + this.nearHtml(r)
      + `<table class="sim-comptable sim-tcomps"><thead><tr><th>${esc(t("Component"))}</th><th title="${esc(t("Highest temperature"))}">${esc(t("Max"))}, °C</th>${limits.size ? `<th title="${esc(t("Temperature limit from the package"))}">${esc(t("Limit"))}, °C</th>` : `<th title="${esc(t("Mean temperature of its surface"))}">${esc(t("Mean"))}, °C</th>`}${power ? `<th title="${esc(t("Heat made in the component"))}">${esc(t("Heat"))}, W</th>` : ""}</tr></thead><tbody>`
      + rows.map((x, d) => `<tr data-a="rcomp" data-rcomp="${d}" tabindex="0" class="${d === alone ? "sel" : ""}${lim(d) !== undefined && x.max > lim(d)! ? " bad" : ""}"><td translate="no" title="${esc(r.comps![d].name)}">${esc(r.comps![d].name)}</td><td data-v="tcmax">${sig(x.max)}</td>${limits.size ? `<td data-v="tclimit">${lim(d) === undefined ? "" : sig(lim(d)!)}</td>` : `<td>${sig(x.mean)}</td>`}${power ? `<td data-v="tcpower">${x.power ? sig(x.power) : ""}</td>` : ""}</tr>`).join("") + `</tbody></table>`
      + `<p class="sim-note muted" data-v="compnote">${alone >= 0 ? `${esc(t("Showing {name} alone, on its own colour scale.", { name: r.comps[alone].name }))} <button class="btn small" data-a="rcompall">${esc(t("Show all"))}</button>` : esc(t("Click a row to show that component alone."))}</p>`;
  }

  /** The part's material as the active study takes it: the study's own when it has one (FR-SMAT-003). */
  private matOf(doc: SimDoc | null | undefined) {
    return (!this.host.asm() && this.study()?.mats?.[""]) || doc?.material || null;
  }
  /** A body's own material in the active study: the study's, else the part document's (null: the part's material). */
  private bodyMatOf(doc: SimDoc, key: string) {
    return this.study()?.mats?.[key] ?? doc.bodies?.[key]?.material ?? null;
  }
  /** The bodies that have a material of their own in the active study. */
  private bodyKeys(doc: SimDoc): string[] {
    return [...new Set([...Object.keys(doc.bodies ?? {}), ...Object.keys(this.study()?.mats ?? {})])].filter(k => k && this.bodyMatOf(doc, k));
  }
  /** Picks a material for this study only: the part's (`key` "") or one body's; None goes back to the document's. */
  private async pickStudyMat(key: string) {
    const st = this.study();
    if (!st || this.running || this.host.asm()) return;
    const got = await pickMaterial({ current: st.mats?.[key] ?? null, allowNone: true });
    if (!got) return;
    const ref = got.material ? toRef(got.material) : null;
    this.host.change(t("Study material"), d => {
      const s = d.studies?.find(x => x.id === st.id);
      if (!s) return;
      const all = { ...(s.mats ?? {}) };
      if (ref) all[key] = ref; else delete all[key];
      if (Object.keys(all).length) s.mats = all; else delete s.mats;
    });
  }

  private nameOf(id: string) {
    const st = this.study();
    return [...(st?.supports ?? []), ...(st?.loads ?? []), ...(st?.refine ?? []), ...extrasOf(st)].find(x => x.id === id)?.name ?? id;
  }

  private errorText(msg: string): string {
    const [code, rest = ""] = msg.split(": ");
    const name = this.nameOf(rest.trim());
    switch (code) {
      case "E-SIM-NOLOAD": return t("Add a load first.");
      case "E-TH-ALPHA": return t("The material has no thermal expansion coefficient. Pick one that has it, or make your own with it.");
      case "E-TH-COMPALPHA": return t("{name} has no thermal expansion coefficient: pick a material that gives one.", { name: rest });
      case "E-TH-NOFIELD": return t("The thermal study the temperature load takes its temperatures from cannot be solved. Open it and solve it first.");
      case "E-SIM-ONETEMP": return t("A study takes one temperature load.");
      case "E-TH-NOSINK": return t("Nothing takes the heat away. Add convection, radiation or a fixed temperature: without one the part would heat up for ever.");
      case "E-TH-NOHEAT": return t("Nothing heats or cools the part. Add a heat source, or surface conditions at different temperatures.");
      case "E-TH-NOK": return t("The material has no thermal conductivity. Pick another material or add the value to it.");
      case "E-TH-NOCP": return rest ? t("Set a material with density and specific heat for {name} (needed for transient studies).", { name: rest }) : t("A transient study needs a material with a density and a specific heat.");
      case "E-TH-TIME": return t("Type an end time above zero.");
      case "E-TH-COMPMAT": return t("{name} has no material with a thermal conductivity. Pick one for it under Components, or leave the component out.", { name: rest });
      case "E-TH-LOOSE": return t("Nothing takes the heat away from {names}: they touch no cooled component and have no cooling of their own. Add cooling or radiation between faces, move them into contact or raise the gap tolerance.", { names: rest.split(",").map(i => this.comps[Number(i)]?.name ?? i).join(", ") });
      case "E-TH-CONTACT": return t("A contact needs a conductance above 0.");
      case "E-TH-VALUE": return t("{name}: give a value above 0 (an emissivity is between 0 and 1).", { name });
      case "E-SIM-FREE": return rest.trim() === "6" && !this.study()?.supports.length ? t("Add a support first, or turn on Inertia relief for a part that nothing holds.") : t("The supports leave the part free to move ({n} free motions). Add or change the supports.", { n: rest.trim() });
      case "E-SIM-BODIES": return t("Some bodies of the part touch no other body. A study needs one connected piece: join the bodies or delete the loose ones.");
      case "E-SIM-COMPMAT": return t("The component {name} has no material with an elastic modulus and Poisson's ratio. Give its part one (right-click the component, Material…).", { name: msg.split(": ")[1] ?? "" });
      case "E-SIM-LOOSE": return t("Nothing holds {names}: they touch no held component and have no support. Add a support, move them into contact or raise the gap tolerance.", { names: rest.split(",").map(i => this.comps[Number(i)]?.name ?? i).join(", ") });
      case "E-SIM-BODYMAT": return t("The material {name} of a body has no elastic modulus or Poisson's ratio.", { name: msg.split(": ")[1] ?? "" });
      case "E-SIM-DENSITY": return t("The material has no density: a modal study needs one.");
      case "E-SIM-MEMORY": return this.host.asm()
        ? t("The study needs about {n} MB of memory, more than a solve may take ({m} MB). Leave components out of the study or make some rigid.", { n: rest.trim(), m: Math.round((memLimit() || MEMORY_LIMIT) / 2 ** 20) })
        : t("The study needs about {n} MB of memory, more than a solve may take ({m} MB). Remove local accuracy settings or simplify the part.", { n: rest.trim(), m: Math.round((memLimit() || MEMORY_LIMIT) / 2 ** 20) });
      case "E-SIM-CONNECTOR": return t("The connector {name} cannot be placed on its faces. Pick faces with some area on each side.", { name: this.nameOf(this.connIds[Number(msg.split(": ")[1])] ?? "") });
      case "E-SIM-MASS": return t("A mass has no faces left to sit on.");
      case "E-SIM-ADHESIVE": return t("An adhesive connection needs a thickness and an elastic modulus above zero.");
      case "E-SIM-WELD": if (this.study()?.welds?.find(w => w.id === this.weldIds[Number(msg.split(": ")[1])])?.on === "points") return t("The spot weld {name} reaches no other component: click points on a face that has another component behind it.", { name: this.nameOf(this.weldIds[Number(msg.split(": ")[1])] ?? "") });
        return t("The weld {name} lies beside no other component: click edges of one component that lie on another.", { name: this.nameOf(this.weldIds[Number(msg.split(": ")[1])] ?? "") });
      case "E-SIM-PRELOAD": return t("A preloaded bolt clamps components that are not joined where they touch, so nothing takes the preload. Set their connection to Bonded or Sliding.");
      case "E-SIM-BOLT": return t("A bolt's seat could not be placed on the components. Untick that bolt to analyse it as a solid.");
      case "E-SIM-ALLRIGID": return t("Every component is rigid, so nothing can deform. Make at least one component elastic.");
      case "E-SIM-NOBODY": return this.host.asm() ? t("The assembly has no components to analyse yet.") : t("The part has no body yet.");
      case "E-SIM-REF": {
        const st = this.study(), off = offComps(st), it = [...(st?.supports ?? []), ...(st?.loads ?? []), ...(st?.refine ?? []), ...extrasOf(st)].find(x => x.id === rest.trim()) as { faces?: FaceRef[]; faces2?: FaceRef[]; edges?: { faces: string[] }[]; points?: { faces: string[] }[] } | undefined;
        const on = [...(it?.faces ?? []).map(f => f.name), ...(it?.faces2 ?? []).map(f => f.name), ...(it?.edges ?? []).flatMap(e => e.faces), ...(it?.points ?? []).flatMap(p => p.faces)];
        if (off.size && on.some(n => off.has(compOf(n)))) return t("{name} is on a component left out of the study. Pick other faces, or include the component.", { name });
        return t("{name}: a face is gone. Pick its faces again.", { name });
      }
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
    const draw = (it: StudySupport | StudyLoad | StudyRefine | StudyExtra, load: boolean, hot: boolean) => {
      const color = it.type === "refine" ? REFINE_COLOR : it.type === "connector" ? CONNECTOR_COLOR : it.type === "mass" ? MASS_COLOR : it.type === "weld" ? WELD_COLOR : load ? LOAD_COLOR : SUPPORT_COLOR;
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
    // the picked connection: where the two components face each other, each side in its own colour
    const pre = this.host.asm() ? this.freshFound(st) : null;
    const sel = pre?.list.find(c => pairKey(pre.comps[c.a]?.key ?? "", pre.comps[c.b]?.key ?? "") === this.linkSel);
    if (sel) for (const [side, tris, color] of [["a", sel.pa, PATCH_A], ["b", sel.pb, PATCH_B]] as const) {
      if (!tris.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(tris, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.BackSide, depthTest: false, depthWrite: false }));
      // each side is drawn from behind only: looking through a component one sees its own side of the contact
      mesh.renderOrder = side === "a" ? 2960 : 2961;
      mesh.userData.simPatch = side;
      mesh.raycast = () => {};
      this.marks.add(mesh);
    }
    // the bolts found: a line from the seat under each head to its nut or thread
    const bl = this.host.asm() ? this.freshBolts(st)?.list ?? [] : [];
    if (bl.length) {
      const mid = (T: Float64Array) => { const c = [0, 0, 0]; for (let i = 0; i < T.length; i++) c[i % 3] += T[i]; return c.map(v => v / (T.length / 3 || 1)); };
      const pts = bl.flatMap(b => [...mid(b.a), ...mid(b.b)]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pts), 3));
      const mat = { color: BOLT_COLOR, depthTest: false, depthWrite: false, transparent: true };
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial(mat)), dots = new THREE.Points(geo.clone(), new THREE.PointsMaterial({ ...mat, size: 7, sizeAttenuation: false }));
      for (const o of [lines, dots]) { o.renderOrder = 2962; o.userData.simBolt = bl.length; o.raycast = () => {}; this.marks.add(o); }
    }
    const ed = this.edit;
    for (const s of st.supports) if (s.id !== ed?.draft.id && !off.has(s.id) && !plotted) { draw(s, false, false); if (s.type === "radx" && s.faces2) draw({ ...s, faces: s.faces2 }, false, false); }
    for (const l of st.loads) if (l.id !== ed?.draft.id && !off.has(l.id) && !plotted) draw(l, true, false);
    for (const r of st.refine ?? []) if (r.id !== ed?.draft.id && !off.has(r.id) && !plotted) draw(r, false, false);
    for (const w of extrasOf(st)) if (w.id !== ed?.draft.id && !off.has(w.id) && !plotted) { draw(w, false, false); if (w.type === "connector") draw({ ...w, faces: w.faces2 }, false, false); }
    const two = ed ? this.twoSided(ed) : null;
    if (ed && two) draw({ ...ed.draft, faces: this.connSide === 2 ? two.faces : two.faces2 } as typeof ed.draft, false, false);
    if (ed) draw(ed.draft, ed.kind === "load", true);
    this.host.viewer.invalidate();
  }

  /** Yield strength (MPa, 0 = none) of the material at a sample point: its body's when bodies have their own materials. */
  private yieldAt(r: PassResult, i: number): number {
    const B = this.res?.bodyMats;
    return B && r.dom ? B[r.dom[i]]?.sy ?? 0 : this.matOf(this.host.doc())?.sy ?? 0;
  }
  /** A yield strength is known for the results (any body's). */
  private hasYield(): boolean {
    const B = this.res?.bodyMats;
    return B ? B.some(b => b.sy > 0) : !!this.matOf(this.host.doc())?.sy;
  }
  /** Lowest safety factor against yield: the part's yield over `peak`, or body by body with their own materials. */
  private lowSf(r: PassResult, peak: number): number | null {
    const B = this.res?.bodyMats;
    if (B && r.dom) {
      let lo = Infinity;
      for (let i = 0; i < r.vm.length; i++) { const y = B[r.dom[i]]?.sy ?? 0; if (y > 0 && r.vm[i] > 0) lo = Math.min(lo, y / r.vm[i]); }
      return Number.isFinite(lo) ? lo : null;
    }
    const sy = this.matOf(this.host.doc())?.sy;
    return sy && peak > 0 ? sy / peak : null;
  }

  /** The study's ambient temperature (°C): what a temperature rise is measured from. */
  private ambient(): number { return this.study()?.settings.ambient ?? DEFAULT_AMBIENT; }

  private values(r: PassResult, kind: PlotKind): Float32Array {
    if (kind === "vm" || kind === "temp") return r.vm;
    if (kind === "err") return r.err;
    if (kind === "rise") { const amb = this.ambient(); return Float32Array.from(r.vm, v => v - amb); }
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
    download(new Blob([pathCsv(rows, !!this.res?.passes.at(-1)?.thermal)], { type: "text/csv" }), `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-path.csv`);
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
    }), !!r.thermal);
  }

  /** The probes as a table in the Study tab: place, stress, displacement, safety factor. */
  private probesHtml(): string {
    const r = this.res?.passes.at(-1), pm = this.res?.mesh;
    if (!r || !pm || this.stale() || !this.probes.length || r.modes) return "";
    const uf = UNITS[units.current].f;
    const place = (x: number) => String(Number((x * uf).toFixed(3)));
    // the safety factor is in the CSV; the side panel is too narrow for one more column
    return `<h5 class="sim-sub">${esc(t("Probes"))}</h5><div class="sim-wide"><table class="sim-ptable"><thead><tr><th>#</th><th>X, Y, Z, ${esc(units.current)}</th><th>${r.thermal ? `${esc(t("Temperature"))}, °C` : `${esc(t("von Mises stress"))}, MPa`}</th><th>${r.thermal ? `${esc(t("Heat flux"))}, W/m²` : `${esc(t("Displacement"))}, ${esc(units.current)}`}</th><th></th></tr></thead><tbody>`
      + this.probes.map((p, i) => {
        const vm = valueAt(r.vm, p), u = Math.hypot(valueAt(r.u, p, 3, 0), valueAt(r.u, p, 3, 1), valueAt(r.u, p, 3, 2));
        return `<tr data-probe-row="${i}"><td>${i + 1}</td><td>${[0, 1, 2].map(c => place(valueAt(pm.pos, p, 3, c))).join(", ")}</td><td>${sig(vm)}</td><td>${sig(u * (r.thermal ? 1e6 : uf))}</td>`
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
    if (k === "temp") return ["°C", 1];
    if (k === "rise") return ["K", 1];
    if (k === "flux") return ["W/m²", 1e6];
    return k === "vm" ? ["MPa", 1] : k === "sf" ? ["", 1] : k === "err" ? ["%", 1] : [units.current, UNITS[units.current].f];
  }

  /** Triangles of the plot that are drawn (a component shown alone leaves the others out). */
  /** The box of the plot as drawn (its own triangles only), in the model's coordinates. */
  private plotBox(): number[] | null {
    const g = this.overlay?.geometry, ix = g?.getIndex(), pa = g?.getAttribute("position");
    if (!ix || !pa) return null;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ix.count; i += 3) {
      if (ix.getX(i) === ix.getX(i + 1)) continue;
      for (let j = 0; j < 3; j++) { const v = ix.getX(i + j), q = [pa.getX(v), pa.getY(v), pa.getZ(v)]; for (let c = 0; c < 3; c++) { if (q[c] < b[c]) b[c] = q[c]; if (q[c] > b[3 + c]) b[3 + c] = q[c]; } }
    }
    return Number.isFinite(b[0]) ? b : null;
  }

  private drawnTris(): number {
    const ix = this.overlay?.geometry.getIndex();
    if (!ix) return 0;
    let n = 0;
    for (let i = 0; i < ix.count; i += 3) if (ix.getX(i) !== ix.getX(i + 1)) n++;
    return n;
  }

  /** The solver domain shown alone, -1 when all components are shown (or the results have none). */
  private aloneDom(): number {
    const r = this.res, last = r?.passes.at(-1);
    return r?.comps && last?.dom && !last.modes && this.compSel >= 0 && this.compSel < r.comps.length ? this.compSel : -1;
  }

  /** An assembly's results per component (FR-CON-030): empty for a part or a modal study. */
  private compRows(): CompRow[] {
    const r = this.res, last = r?.passes.at(-1);
    if (!r?.comps || !last?.dom || last.modes) return [];
    return componentRows(last.dom, last.vm, last.u, r.comps.length, r.bodyMats?.map(b => b.sy) ?? []);
  }

  /** The table of results per component: a row shows its component alone. */
  private compTableHtml(): string {
    const r = this.res, rows = this.compRows();
    if (!r?.comps || rows.length < 2) return "";
    const uf = UNITS[units.current].f, alone = this.aloneDom(), sf = rows.some(x => x.sf != null);
    return `<h5 class="sim-sub">${esc(t("By component"))}</h5><table class="sim-passes sim-comptable"><thead><tr><th>${esc(t("Component"))}</th><th title="${esc(t("von Mises stress"))}">${esc(t("Stress"))}, MPa</th><th title="${esc(t("Displacement"))}">${esc(t("Displ."))}, ${esc(units.current)}</th>${sf ? `<th title="${esc(t("Lowest safety factor (yield)"))}">${esc(t("SF"))}</th>` : ""}</tr></thead><tbody>`
      + rows.map(x => `<tr data-a="rcomp" data-rcomp="${x.d}" tabindex="0" class="${x.d === alone ? "sel" : ""}"><td translate="no" title="${esc(r.comps![x.d].name)}">${esc(r.comps![x.d].name)}</td><td${r.bodyMats?.[x.d]?.rigid ? ' data-v="crigid"' : ""}>${r.bodyMats?.[x.d]?.rigid ? esc(t("Rigid").toLowerCase()) : sig(x.maxVm)}</td><td>${sig(x.maxU * uf)}</td>${sf ? `<td${x.sf != null && x.sf < 1 ? ' class="sim-low"' : ""}>${x.sf == null ? "–" : sig(x.sf)}</td>` : ""}</tr>`).join("") + `</tbody></table>`
      + `<p class="sim-note muted" data-v="compnote">${alone >= 0 ? `${esc(t("Showing {name} alone, on its own colour scale.", { name: r.comps[alone].name }))} <button class="btn small" data-a="rcompall">${esc(t("Show all"))}</button>` : esc(t("Click a row to show that component alone."))}</p>`;
  }

  /** Shows one component's results alone (the same again: all of them). */
  private pickComp(d: number) {
    this.compSel = d === this.compSel ? -1 : d;
    if (!this.plot.on) this.plot.on = true;
    this.showPlot();
    this.renderAll();
  }

  /** The hot spots of the last pass: the highest stress peaks, likely singularities flagged. */
  private hotList(): HotSpot[] {
    const r = this.res;
    if (!r || !r.passes.length || r.passes[0].modes || r.passes[0].thermal) return [];
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
    const mk = this.mask;
    let lo = -1, hi = -1;
    for (let i = 0; i < a.length; i++) { if (mk && !mk[i]) continue; if (lo < 0 || a[i] < a[lo]) lo = i; if (hi < 0 || a[i] > a[hi]) hi = i; }
    if (lo < 0) return [];
    const label = (cls: string, key: string, text: string, v: number, warn = false) => out.push({ v, html: `<div class="sim-probe sim-peak ${cls}${warn ? " warn" : ""}" data-peak="${key}"${warn ? ` title="${sing}"` : ""}><i></i><span>${warn ? "⚠ " : ""}${text}</span></div>` });
    if (this.plot.kind === "vm") {
      const hs = this.hotList(), top = hs.findIndex(h => !h.singular);
      hs.forEach((h, i) => { if (mk && !mk[h.v]) return; if (h.singular || i === top || i === this.hotSel) label("hot", `h${i}`, `<b>${i + 1}</b> <span translate="no">${val(h.vm)}</span>`, h.v, h.singular); });
      if (!hs.length || (mk && !hs.some(h => mk[h.v]))) label("max", "max", `${esc(t("Max"))} <span translate="no">${val(a[hi])}</span>`, hi);
    } else if (this.plot.kind === "sf") label("min", "min", `${esc(t("Min"))} <span translate="no">${val(a[lo])}</span>`, lo);
    else {
      label("max", "max", `${esc(t("Max"))} <span translate="no">${val(a[hi])}</span>`, hi);
      if (a[lo] < 0 || this.plot.kind === "temp" || this.plot.kind === "rise") label("min", "min", `${esc(t("Min"))} <span translate="no">${val(a[lo])}</span>`, lo);
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
      d.hidden = s.z > 1 || s.z < -1 || !!(this.partOf && this.pose.off[this.partOf[p.i[0]]]);
    });
  }

  private disposePlot() {
    if (this.anim) { cancelAnimationFrame(this.anim.raf); this.anim = null; }
    if (this.overlay) {
      for (const c of this.overlay.children) if (c.userData.simArrows) (c as THREE.LineSegments).geometry.dispose();
      this.overlay.removeFromParent(); this.overlay.geometry.dispose(); this.overlay = null;
    }
    this.arrows = 0;
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.mask = null;
    this.posed = null;
    this.partOf = null;
    this.pose = { key: "", tfs: [], off: [], moved: 0 };
  }

  /**
   * Heat flux arrows (FR-TRES-001) on the drawn triangles of the plot, as a child of the overlay so they go with it;
   * a transient result keeps the flux of its last time.
   */
  private drawArrows() {
    const ov = this.overlay, last = this.res?.passes.at(-1), pm = this.res?.mesh;
    for (const c of [...(ov?.children ?? [])]) if (c.userData.simArrows) { c.removeFromParent(); (c as THREE.LineSegments).geometry.dispose(); }
    this.arrows = 0;
    if (!ov || !last?.thermal || !pm || !this.plot.vectors || last.u.length !== pm.pos.length) return;
    const ix = ov.geometry.getIndex();
    if (!ix) return;
    const a = fluxArrows(pm.pos, pm.nrm, last.u, ix.array as ArrayLike<number>);
    if (!a.at.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(a.lines, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x14181f });
    mat.clippingPlanes = this.host.viewer.clipPlanes;
    this.mats.push(mat);
    const lines = new THREE.LineSegments(geo, mat);
    lines.userData.simArrows = a.at.length;
    lines.raycast = () => {};
    ov.add(lines);
    this.arrows = a.at.length;
    this.host.viewer.invalidate();
  }

  /** A result plot is on the model. */
  get plotting() { return !!this.saved; }

  // ---------- results on section planes (FR-RES-030) ----------

  /** The shown plot can be carried onto the section caps: a static result whose solution the worker still holds. */
  private capsPaintable() {
    // components moved apart (an exploded view) are cut where they are shown, not where they were analysed
    return !!this.saved && !!this.res && !this.res.passes.at(-1)?.modes && !!this.job() && !this.pose.moved;
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

  /** Transient results: shows output time `i` (FR-TRES-006): the shown pass becomes that time's temperatures. */
  private useFrame(r: Results, i: number) {
    const full = r.tr ?? r.passes.at(-1);
    if (!full?.transient) return;
    r.tr = full;
    const T = full.transient, k = Math.max(0, Math.min(T.times.length - 1, i));
    this.frame = k;
    r.passes[r.passes.length - 1] = { ...full, vm: T.frames[k], maxVm: T.max[k], thermal: { ...full.thermal!, min: T.min[k], max: T.max[k], applied: T.put[k] } };
  }

  /** Steps the shown time; `paint` = only the colours (playback), else the whole plot, probes and labels. */
  private seek(i: number, paint = false) {
    const r = this.res;
    if (!r?.tr?.transient) return;
    this.useFrame(r, i);
    if (paint && this.overlay && (this.plot.kind === "temp" || this.plot.kind === "rise") && !this.iso.on && !this.mask) this.paintFrame();
    else if (this.plot.on) this.showPlot();
    this.probeKey = "";
    this.syncProbes();
    if (!paint) this.syncPath();
    this.renderLegendTime();
    if (!paint) this.renderAll();
  }

  /** Recolours the plot for the shown time with the range kept over the whole run. */
  private paintFrame() {
    const ov = this.overlay, last = this.res?.passes.at(-1);
    if (!ov || !last) return;
    const col = ov.geometry.getAttribute("color") as THREE.BufferAttribute, arr = col.array as Float32Array, [lo, hi] = this.range, span = hi - lo || 1;
    const v = this.values(last, this.plot.kind === "rise" ? "rise" : "temp");
    for (let i = 0; i < v.length; i++) ramp((v[i] - lo) / span, arr, 3 * i);
    col.needsUpdate = true;
    this.vals = v;
    this.host.redraw();
  }

  private startPlay() {
    const T = this.res?.tr?.transient;
    if (!T || this.playTimer) return;
    if (this.frame >= T.times.length - 1) this.seek(0, true);
    const fps = 8 * this.speed;
    this.playTimer = window.setInterval(() => {
      const n = this.res?.tr?.transient?.times.length ?? 0;
      if (!n || this.frame >= n - 1) { this.stopPlay(); this.seek(this.frame); return; }
      this.seek(this.frame + 1, true);
    }, 1000 / fps);
    this.renderLegendTime();
  }

  private stopPlay() {
    if (!this.playTimer) return;
    clearInterval(this.playTimer);
    this.playTimer = 0;
    this.renderLegendTime();
  }

  /** The legend's time row, updated in place while playing. */
  private renderLegendTime() {
    const T = this.res?.tr?.transient, el = document.querySelector<HTMLElement>("#sim-legend .sim-time");
    if (!T || !el) return;
    const k = Math.max(0, this.frame), r = el.querySelector<HTMLInputElement>("input[data-k=time]"), v = el.querySelector("[data-v=ttime]"), b = el.querySelector("[data-a=tplay]");
    if (r && document.activeElement !== r) r.value = String(k);
    if (v) v.textContent = timeText(T.times[k]);
    if (b) { b.textContent = this.playTimer ? "❚❚" : "▶"; b.setAttribute("aria-pressed", String(!!this.playTimer)); b.setAttribute("title", t(this.playTimer ? "Pause" : "Play the warm-up")); }
  }

  /** The legend row of a transient result: time slider, play/pause and the time shown. */
  private legendTimeHtml(): string {
    const T = this.res?.tr?.transient;
    if (!T) return "";
    const k = Math.max(0, this.frame);
    return `<div class="sim-time"><button class="btn small" data-a="tplay" aria-pressed="${!!this.playTimer}" title="${esc(t(this.playTimer ? "Pause" : "Play the warm-up"))}">${this.playTimer ? "❚❚" : "▶"}</button>`
      + `<input type="range" data-k="time" min="0" max="${T.times.length - 1}" step="1" value="${k}" aria-label="${esc(t("Time"))}" />`
      + `<span data-v="ttime" translate="no">${esc(timeText(T.times[k]))}</span>`
      + `<button class="btn small" data-a="gif" title="${esc(t("Save the warm-up as an animated GIF of the current view"))}">GIF</button></div>`;
  }

  /** Each probe's temperature over the run (from the plot surface), °C per output time. */
  private probeSeries(): { name: string; v: Float32Array }[] {
    const r = this.res, T = r?.tr?.transient;
    if (!r || !T) return [];
    const st = this.study();
    return (st?.probes ?? []).flatMap((p, i) => {
      const at = locate(r.mesh.pos, r.mesh.index, p);
      return at ? [{ name: `${t("Probe")} ${i + 1}`, v: Float32Array.from(T.frames, f => valueAt(f, at)) }] : [];
    });
  }

  /** Transient results in the Study tab: the run, a chart of the hottest point and the probes over time, time to reach. */
  private transientHtml(): string {
    const T = this.res?.tr?.transient;
    if (!T) return "";
    const end = T.times[T.times.length - 1], hot = T.max[T.max.length - 1], series = this.probeSeries();
    const lines = [{ name: t("Hottest point"), v: Float32Array.from(T.max), color: "#e03131" }, ...series.map((s, i) => ({ ...s, color: SERIES_COLORS[i % SERIES_COLORS.length] }))];
    let html = `<h5 class="sim-sub">${esc(t("Over time"))}</h5><dl class="sim-kv">`
      + `<dt>${esc(t("Start"))}</dt><dd data-v="tstart">${sig(T.t0)} °C</dd>`
      + `<dt>${esc(t("Hottest at the end"))}</dt><dd data-v="tend">${sig(hot)} °C ${esc(t("after {t}", { t: timeText(end) }))}</dd>`
      + (T.steady != null ? `<dt>${esc(t("Steady state at full power"))}</dt><dd data-v="tsteady">${sig(T.steady)} °C</dd>` : "")
      + `<dt>${esc(t("Time steps"))}</dt><dd data-v="tsteps" title="${esc(t("Shortest {a}, longest {b}", { a: timeText(T.dt[0]), b: timeText(T.dt[1]) }))}">${T.steps}</dd>`
      + `<dt>${esc(t("Heat capacity"))}</dt><dd data-v="tcap">${sig(T.capacity)} J/K</dd></dl>`;
    html += timeChartSvg(T.times, lines, this.frame, timeText);
    html += `<div class="sim-legline">${lines.map(l => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join("")}</div>`;
    html += `<label class="pm-field sim-reach"><span>${esc(t("Time to reach"))}</span><input type="text" inputmode="decimal" data-k="reach" value="${this.reach ?? ""}" placeholder="°C" aria-label="${esc(t("Time to reach, °C"))}" /></label>`;
    if (this.reach != null) html += `<ul class="sim-reachlist">${lines.map(l => { const at = timeToReach(T.times, l.v, this.reach!); return `<li data-v="treach">${esc(l.name)}: ${at == null ? esc(t("not reached")) : esc(timeText(at))}</li>`; }).join("")}</ul>`;
    html += `<button class="btn small" data-a="tcsv" title="${esc(t("Save the temperatures over time (hottest point and probes) as a CSV file"))}">${esc(t("Export CSV"))}</button>`;
    return html;
  }

  private exportTransient() {
    const doc = this.host.doc(), st = this.study(), text = this.transientCsvText();
    if (!doc || !st || !text) return;
    download(new Blob([text], { type: "text/csv" }), `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-over-time.csv`);
  }

  private transientCsvText(): string {
    const T = this.res?.tr?.transient;
    if (!T) return "";
    return withLang("en", () => transientCsv(T.times, [{ name: t("Hottest point"), v: T.max }, ...this.probeSeries()]));
  }

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
    // thermal results: temperature and heat flux, never a deformed shape
    if (r0.thermal) { if (!THERMAL_PLOTS.includes(this.plot.kind)) this.plot.kind = "temp"; this.plot.deformed = false; }
    else if (this.plot.kind === "temp" || this.plot.kind === "rise" || this.plot.kind === "flux") this.plot.kind = "vm";
    // the safety factor needs a yield strength: without one the plot falls back to stress
    if (this.plot.kind === "sf" && !this.hasYield()) this.plot.kind = "vm";
    // the error estimate compares two passes
    if (this.plot.kind === "err" && r.pass < 2) this.plot.kind = "vm";
    const val = this.values(r, this.plot.kind), sf = this.plot.kind === "sf";
    // one component alone: only its points are drawn, and the colour scale is its own
    const alone = this.aloneDom(), dom = r0.dom;
    const mask = alone >= 0 && dom ? Uint8Array.from(dom, d => (d === alone ? 1 : 0)) : null;
    this.mask = mask;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (mask && !mask[i]) continue; if (val[i] < lo) lo = val[i]; if (val[i] > hi) hi = val[i]; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
    // a transient result keeps one colour scale over the whole run, so the slider shows the part warming
    const run = res.tr?.transient;
    if (run && (this.plot.kind === "temp" || this.plot.kind === "rise") && !mask) { const d = this.plot.kind === "rise" ? this.ambient() : 0; lo = Math.min(...run.min) - d; hi = Math.max(...run.max) - d; }
    if (this.plot.kind === "vm" || this.plot.kind === "u" || this.plot.kind === "err" || this.plot.kind === "flux") lo = 0;
    this.range = [lo, hi];
    this.vals = val;
    const colors = new Float32Array(3 * n), span = hi - lo || 1;
    // a low safety factor is the red end
    for (let i = 0; i < n; i++) ramp(sf ? 1 - (val[i] - lo) / span : (val[i] - lo) / span, colors, 3 * i);
    const colorMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    colorMat.clippingPlanes = this.host.viewer.clipPlanes;
    const under = new THREE.MeshBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    under.clippingPlanes = this.host.viewer.clipPlanes;
    const isoOn = this.iso.on && !r0.modes;
    under.visible = this.plot.deformed || isoOn;
    this.mats.push(colorMat, under);
    this.saved = { meshes: part.meshes.map(mesh => ({ mesh, mat: mesh.material })) };
    // a component the study leaves out stays in view as a ghost, whatever the plot
    const out = new Set(res.off ?? []), am = part as AsmModel;
    // with one component alone, the others stay as ghosts too
    const only = mask && res.comps?.[alone] ? compOf(res.comps[alone].key) : "";
    if (only && am.names) for (const c of new Set(am.names.map(compOf))) if (c !== only) out.add(c);
    let ghost: THREE.Material | null = null;
    if (out.size && am.names) {
      ghost = new THREE.MeshBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      ghost.clippingPlanes = this.host.viewer.clipPlanes;
      this.mats.push(ghost);
    }
    part.meshes.forEach((mesh, k) => { mesh.material = ghost && out.has(compOf(am.names[am.faceOff[k]] ?? "")) ? ghost : under; });
    const dressed = part.meshes.map(mesh => mesh.material);
    this.host.redraw();
    const scale = this.shapeScale(r);
    this.usedScale = this.plot.deformed ? scale : 0;
    const at = new Float32Array(3 * n);
    for (let i = 0; i < 3 * n; i++) at[i] = this.plot.deformed ? pm.pos[i] + scale * r.u[i] : pm.pos[i];
    const index0 = mask && dom ? aloneIndex(pm.index, dom, alone) : pm.index;
    // iso-clipping: only the places at or beyond the value are drawn in colour, the rest stays a ghost
    const index = isoOn ? isoIndex(index0, val, this.isoValue(), !this.iso.below) : index0;
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(at, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(pm.nrm, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.overlay = new THREE.Mesh(geo, colorMat);
    this.overlay.userData.simPlot = true;
    this.overlay.raycast = () => {};
    part.frame.add(this.overlay);
    this.overlay.updateMatrixWorld(true);
    this.drawArrows();
    // an assembly's plot goes where its components are shown
    this.pose = { key: "", tfs: [], off: [], moved: 0 };
    this.posed = null;
    this.partOf = null;
    if (am.parts) {
      this.partOf = this.partsOfMesh(am, pm);
      this.posed = { model: am, base: pm.pos, u: this.plot.deformed ? r.u : null, k: this.plot.deformed ? scale : 0, index, nrm: pm.nrm, dressed };
      if (!this.poseBound) { this.poseBound = true; this.host.viewer.onRender(() => this.applyPose()); }
      this.applyPose();
    }
    if (shape && this.plot.deformed && this.animate) this.startAnim(pm.pos, shape, scale);
    this.capsSoon();
    this.syncPath();
    this.syncProbes();
    this.drawProbes();
    this.host.viewer.invalidate();
  }

  private partsMemo = new WeakMap<PlotMesh, Int32Array>();
  /** The part (place in the model's list) of every vertex of the plot mesh. */
  private partsOfMesh(am: AsmModel, pm: PlotMesh): Int32Array {
    let of = this.partsMemo.get(pm);
    if (!of) { of = vertexParts(pm.index, am.meshes.map(m => m.geometry.getAttribute("position").count), pm.pos.length / 3); this.partsMemo.set(pm, of); }
    return of;
  }

  /** How the view shows each part of the model now: moved (an exploded view, a drag), hidden or see-through. */
  private readPose(am: AsmModel) {
    const v = this.host.viewer, tfs: (Float32Array | null)[] = [], off: boolean[] = [];
    let key = "", moved = 0;
    am.parts.forEach((idx, k) => {
      const p = v.parts[idx];
      if (!p) { tfs.push(null); off.push(false); return; }
      p.group.updateMatrix();
      const e = p.group.matrix.elements;
      let same = true;
      for (let i = 0; i < 16; i++) if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-7) { same = false; break; }
      const o = !p.visible || p.opacity < 1;
      tfs.push(same ? null : Float32Array.from(e));
      off.push(o);
      if (!same) moved++;
      if (!same || o) key += `${k}:${same ? "" : Array.from(e, x => x.toFixed(4)).join(",")}${o ? (p.visible ? "t" : "h") : ""}|`;
    });
    return { key, tfs, off, moved };
  }

  /** Writes `base + k u` into the plot's points, each moved with its part. */
  private place(arr: Float32Array, base: ArrayLike<number>, k: number, u: ArrayLike<number> | null) {
    if (u && k) for (let i = 0; i < arr.length; i++) arr[i] = base[i] + k * u[i];
    else for (let i = 0; i < arr.length; i++) arr[i] = base[i];
    if (this.pose.moved && this.partOf) moveWithParts(arr, this.partOf, this.pose.tfs);
  }

  /**
   * Brings an assembly's plot to where the view shows its components (FR-CON-031): contours move with exploded
   * components, a hidden component's are not drawn, and a see-through one is shown as itself, so what lies behind
   * it can be read.
   */
  private applyPose() {
    const ov = this.overlay, ps = this.posed, of = this.partOf;
    if (!ov || !ps || !of || this.recording) return;
    const now = this.readPose(ps.model);
    if (now.key === this.pose.key) return;
    const was = this.pose.moved;
    this.pose = now;
    const g = ov.geometry, pa = g.getAttribute("position") as THREE.BufferAttribute;
    if (!this.anim) { this.place(pa.array as Float32Array, ps.base, ps.k, ps.u); pa.needsUpdate = true; }
    let nrm = ps.nrm;
    if (now.moved) { nrm = Float32Array.from(ps.nrm); moveWithParts(nrm, of, now.tfs, true); }
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(now.off.some(Boolean) ? withoutParts(ps.index, of, now.off) : ps.index, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    // a see-through component wears its own look again
    const saved = this.saved?.meshes;
    ps.model.meshes.forEach((mesh, k) => { mesh.material = now.off[k] && saved?.[k] ? saved[k].mat : ps.dressed[k]; });
    if (!!was !== !!now.moved) this.capsSoon();
    this.placeProbes();
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
      this.place(arr, base, k, u);
      pa.needsUpdate = true;
      a.frames++;
      this.host.viewer.invalidate();
      a.raf = requestAnimationFrame(step);
    };
    a.raf = requestAnimationFrame(step);
  }

  /** One swing of the shown mode shape as a looping GIF of the current view (up to `maxW` px wide). */
  async recordGif(maxW = 640): Promise<Blob | null> {
    if (this.res?.tr?.transient) return this.recordWarmGif(maxW);
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
        this.place(arr, pm.pos, a, shape);
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
    if (this.overlay === ov) { if (this.animate) this.startAnim(pm.pos, shape, scale); else { this.place(arr, pm.pos, scale, shape); pa.needsUpdate = true; v.invalidate(); } }
    return blob;
  }

  /**
   * The warm-up of a transient thermal result as a GIF of the current view (FR-TRES-007, AT-TH4-4): one frame per
   * output time at the playback rate, the colours on the range of the whole run, the time and hottest temperature in
   * the corner and the colour scale below; the time shown before is put back.
   */
  async recordWarmGif(maxW = 640): Promise<Blob | null> {
    const r = this.res, T = r?.tr?.transient, doc = this.host.doc(), st = this.study();
    if (!r || !T || !doc || !st || !this.overlay || !this.plot.on || this.recording) return null;
    const v = this.host.viewer, src = v.renderer.domElement;
    if (!src.width || !src.height) return null;
    this.stopPlay();
    this.recording = true;
    const was = this.frame, n = T.times.length, k = Math.min(1, maxW / src.width), temp = (this.plot.kind === "temp" || this.plot.kind === "rise") && !this.iso.on && !this.mask;
    const c = document.createElement("canvas");
    c.width = Math.max(2, Math.round(src.width * k)); c.height = Math.max(2, Math.round(src.height * k));
    const g = c.getContext("2d", { willReadFrequently: true })!, frames: Uint8ClampedArray[] = [];
    const [unit, f] = this.plotUnit();
    const scale = (lo: number, hi: number) => {
      const w = Math.min(160, c.width - 16), h = 10, x = 8, y = c.height - 28, rgb = new Float32Array(3);
      for (let i = 0; i < w; i++) { ramp(i / (w - 1), rgb, 0); g.fillStyle = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`; g.fillRect(x + i, y, 1, h); }
      g.strokeStyle = "#111827"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      g.fillStyle = "#111827"; g.font = `11px "DejaVu Sans", system-ui, sans-serif`; g.textBaseline = "top";
      g.textAlign = "left"; g.fillText(`${sig(lo * f)}`, x, y + h + 2);
      g.textAlign = "right"; g.fillText(`${sig(hi * f)} ${unit}`, x + w, y + h + 2);
    };
    v.bareKeep = new Set();
    try {
      for (let i = 0; i < n; i++) {
        this.useFrame(r, i);
        if (temp) this.paintFrame(); else this.showPlot();
        v.render();
        g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(src, 0, 0, c.width, c.height);
        g.fillStyle = "#111827"; g.font = `13px "DejaVu Sans", system-ui, sans-serif`; g.textBaseline = "top"; g.textAlign = "left";
        g.fillText(`${st.name} · ${timeText(T.times[i])}`, 8, 8);
        g.fillText(`${t("Max")}: ${sig(T.max[i])} °C`, 8, 26);
        scale(this.range[0], this.range[1]);
        frames.push(g.getImageData(0, 0, c.width, c.height).data);
        if (i % 6 === 5) await new Promise(res => setTimeout(res, 0));
      }
    } finally {
      v.bareKeep = null;
      this.recording = false;
      this.seek(was);
    }
    const blob = new Blob([encodeGif(frames, c.width, c.height, gifDelays(n, Math.max(1, Math.round(8 * this.speed))))], { type: "image/gif" });
    this.gifs++;
    this.lastGif = { bytes: blob.size, frames: n, w: c.width, h: c.height };
    download(blob, `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-warmup.gif`);
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
  private capture(kind: PlotKind, type = "image/jpeg", marks = true): Captured | null {
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
    const extremes = marks && !mode ? this.markExtremes(g, k, s, kind) : [];
    const label = mode ? `${t("Mode {n}", { n: mi + 1 })}, ${mode.rigid ? t("rigid body") : `${sig(mode.hz)} Hz`}. ${t(PLOTS.find(p => p[0] === kind)![1])}` : t(PLOTS.find(p => p[0] === kind)![1]);
    const caption = mode ? `${label}. ${t("Mode shapes have no scale: only the pattern of the motion is meaningful.")}` : `${label}: ${lo} … ${hi}${unit ? ` ${unit}` : ""}` + (this.plot.deformed ? `. ${t("Deformed shape")} ×${sig(this.usedScale)}` : "");
    return { src: c.toDataURL(type, 0.9), w: c.width, h: c.height, caption, extremes };
  }

  /**
   * The highest and lowest values of the shown plot: an arrow and a label on the picture `g` (the canvas scaled by `k`
   * from the view, `s` = text scale) at each, and their places for the report's table. A safety factor shows only its
   * lowest value. A point hidden behind the model still gets its arrow, and its label says so.
   */
  private markExtremes(g: CanvasRenderingContext2D, k: number, s: number, kind: PlotKind): Extreme[] {
    const a = this.vals, ov = this.overlay, r = this.res;
    if (!a || !ov || !r) return [];
    const mk = this.mask;
    let lo = -1, hi = -1;
    for (let i = 0; i < a.length; i++) { if (mk && !mk[i]) continue; if (lo < 0 || a[i] < a[lo]) lo = i; if (hi < 0 || a[i] > a[hi]) hi = i; }
    if (lo < 0) return [];
    const picks: { max: boolean; i: number }[] = kind === "sf" ? [{ max: false, i: lo }] : [{ max: true, i: hi }, ...(a[lo] < a[hi] ? [{ max: false, i: lo }] : [])];
    const [unit, f] = this.plotUnit(), uf = UNITS[units.current].f, v = this.host.viewer, cv = v.renderer.domElement;
    const pa = ov.geometry.getAttribute("position"), W = g.canvas.width, H = g.canvas.height;
    const ray = new THREE.Raycaster(), hits: THREE.Intersection[] = [];
    const out: Extreme[] = [], spots: { x: number; y: number }[] = [];
    for (const p of picks) {
      const w = ov.localToWorld(new THREE.Vector3().fromBufferAttribute(pa, p.i)), q = w.clone().project(v.camera);
      if (q.z > 1 || q.z < -1) continue;
      spots.push({ x: ((q.x + 1) / 2) * cv.width * k, y: ((1 - q.y) / 2) * cv.height * k });
      // hidden: the plot surface lies in front of the point along the line of sight
      hits.length = 0;
      const eye = v.camera.position.clone(), dir = w.clone().sub(eye), dist = dir.length();
      ray.set(eye, dir.normalize());
      if ((v.camera as THREE.OrthographicCamera).isOrthographicCamera) { const back = v.camera.getWorldDirection(new THREE.Vector3()); ray.set(w.clone().addScaledVector(back, -1e6), back); }
      THREE.Mesh.prototype.raycast.call(ov, ray, hits);
      const far = (v.camera as THREE.OrthographicCamera).isOrthographicCamera ? 1e6 : dist, hidden = hits.some(h => h.distance < far - 1e-3 * v.modelSize);
      const at = [0, 1, 2].map(c => r.mesh.pos[3 * p.i + c] * uf);
      out.push({ max: p.max, value: a[p.i] * f, unit, at, hidden });
    }
    // the arrows come in from outside the model, away from the middle of the marked points (or of the picture)
    const cx = spots.length > 1 ? (spots[0].x + spots[1].x) / 2 : W / 2, cy = spots.length > 1 ? (spots[0].y + spots[1].y) / 2 : H / 2;
    out.forEach((e, n) => {
      const p = spots[n];
      let dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
      if (d < 1) { dx = e.max ? -1 : 1; dy = -1; d = Math.SQRT2; }
      dx /= d; dy /= d;
      // lean the arrow up a little so it reads like a pointer
      const L = 80 * s, ux = dx * 0.8, uy = dy * 0.8 - 0.6, ul = Math.hypot(ux, uy);
      let sx = p.x + (ux / ul) * L, sy = p.y + (uy / ul) * L;
      sx = Math.min(W - 10 * s, Math.max(10 * s, sx)); sy = Math.min(H - 50 * s, Math.max(20 * s, sy));
      const col = e.max ? "#c92a2a" : "#1864ab", bx = p.x - sx, by = p.y - sy, bl = Math.hypot(bx, by) || 1, hx = bx / bl, hy = by / bl, hl = 11 * s;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2.2 * s;
      if (e.hidden) g.setLineDash([6 * s, 4 * s]);
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(p.x - hx * hl * 0.8, p.y - hy * hl * 0.8); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - hx * hl - hy * hl * 0.45, p.y - hy * hl + hx * hl * 0.45); g.lineTo(p.x - hx * hl + hy * hl * 0.45, p.y - hy * hl - hx * hl * 0.45); g.closePath(); g.fill();
      const text = `${t(e.max ? "Max" : "Min")} ${sig(e.value)}${e.unit ? ` ${e.unit}` : ""}${e.hidden ? ` (${t("hidden from view")})` : ""}`;
      g.font = `bold ${12 * s}px "DejaVu Sans", system-ui, sans-serif`; g.textBaseline = "middle";
      const tw = g.measureText(text).width, left = bx > 0, tx = Math.min(W - tw - 8 * s, Math.max(8 * s, left ? sx - tw - 6 * s : sx + 6 * s));
      g.fillStyle = "rgba(255,255,255,0.92)"; g.fillRect(tx - 4 * s, sy - 10 * s, tw + 8 * s, 20 * s);
      g.strokeStyle = col; g.lineWidth = 1 * s; g.strokeRect(tx - 4 * s, sy - 10 * s, tw + 8 * s, 20 * s);
      g.fillStyle = col; g.textAlign = "left"; g.fillText(text, tx, sy);
    });
    return out;
  }

  /** A captured plot into the report, with a table of where its highest and lowest values are. */
  private pushImage(blocks: ReportBlock[], im: Captured | null) {
    if (!im) return;
    const { extremes, ...img } = im;
    blocks.push({ kind: "image", ...img });
    this.repMarks.push(extremes);
    if (!extremes.length) return;
    const unit = extremes[0].unit;
    blocks.push({ kind: "table", widths: [2, 2, 4], rows: [["", `${t("Value")}${unit ? `, ${unit}` : ""}`, `X, Y, Z, ${units.current}`],
      ...extremes.map(e => [t(e.max ? "Max" : "Min") + (e.hidden ? ` (${t("hidden from view")})` : ""), sig(e.value), e.at.map(x => String(Number(x.toFixed(3)))).join(", ")])] });
  }

  /** The report's tables of the connectors' results and of the masses. */
  private connBlocks(blocks: ReportBlock[]) {
    const st = this.study(), off = new Set(st?.suppressed ?? []);
    const kr = this.connRows();
    if (kr.length) {
      blocks.push({ kind: "h", text: t("Connectors") });
      blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2], rows: [[t("Connector"), t("Type"), `${t("Force")}, N`, `${t("Moment")}, N·m`, `${t("How far the spring gave")}, mm`],
        ...kr.map(x => [x.name, t(x.spring ? "spring" : "rigid"), sig(x.force), sig(x.moment * 1e-3), x.spring ? sig(x.stretch) : "–"])] });
    }
    if (st?.masses?.some(x => !off.has(x.id))) {
      blocks.push({ kind: "h", text: t("Masses") });
      blocks.push({ kind: "table", widths: [4, 2, 2], rows: [[t("Mass"), t("Faces"), "kg"], ...st.masses.filter(x => !off.has(x.id)).map(x => [x.name ?? x.id, this.pickText(x), trim(x.mass)])] });
    }
  }

  /** The report's table of the materials bodies have of their own (nothing when no body has one). */
  private bodyMatBlocks(doc: SimDoc, blocks: ReportBlock[]) {
    const res = this.res;
    this.connBlocks(blocks);
    if (res?.comps) {
      // an assembly: its components with their materials, and the pairs joined
      blocks.push({ kind: "table", widths: [4, 4, 2], rows: [[t("Components"), t("Material"), t("Yield strength")], ...res.comps.map((c, i) => [c.name, `${res.bodyMats?.[i]?.name ?? ""}${res.bodyMats?.[i]?.rigid ? ` (${t("Rigid").toLowerCase()})` : ""}`, res.bodyMats?.[i]?.sy ? `${sig(res.bodyMats[i].sy)} MPa` : "–"])] });
      const asBolt = new Set((res.bolts ?? []).flatMap(b => b.members)), left = (res.off ?? []).filter(id => !asBolt.has(id));
      if (left.length) { const cs = this.host.comps(); blocks.push({ kind: "p", text: `${t("Left out of the study")}: ${left.map(id => cs.find(c => c.id === id)?.name ?? id).join(", ")}` }); }
      const br = this.boltRows();
      if (br.length) {
        blocks.push({ kind: "h", text: t("Bolts") });
        blocks.push({ kind: "table", widths: [4, 1.5, 2, 2, 2, 2, 2, 1.5], rows: [[t("Bolt"), t("Class"), `${t("Preload")}, N`, `${t("Tension")}, N`, `${t("Shear")}, N`, `${t("Bending moment")}, N·m`, `${t("Stress")}, MPa`, t("Safety factor")],
          ...br.map(x => [x.name, x.cls, x.preload ? sig(x.preload) : "–", sig(x.axial), sig(x.shear), sig(x.moment * 1e-3), sig(x.eq), isFinite(x.sf) ? sig(x.sf) : "–"])] });
        blocks.push({ kind: "p", text: t(BOLT_NOTE) });
      }
      const wall = this.weldRows(), wr = wall.filter(x => !x.spot), ws = wall.filter(x => x.spot);
      if (ws.length) {
        blocks.push({ kind: "h", text: t("Spot welds") });
        blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2, 2], rows: [[t(SPOT_LABEL), t("Spots"), `${t("Diameter")}, mm`, `${t("Force")}, N`, `${t("Largest force of one spot")}, N`, `${t("Stress")}, MPa`],
          ...ws.map(x => [x.name, String(x.spots), trim(x.dia), sig(x.force), sig(x.peak), sig(x.stress)])] });
        blocks.push({ kind: "p", text: t(SPOT_RESULT_NOTE) });
      }
      if (wr.length) {
        blocks.push({ kind: "h", text: t("Welds") });
        blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2, 2], rows: [[t("Weld"), `${t("Length")}, mm`, `${t("Throat")}, mm`, `${t("Force")}, N`, `${t("Largest force per length")}, N/mm`, `${t("Stress")}, MPa`],
          ...wr.map(x => [x.name, sig(x.length), trim(x.throat), sig(x.force), sig(x.peak), sig(x.stress)])] });
        blocks.push({ kind: "p", text: t(WELD_RESULT_NOTE) });
      }
      const cs = res.passes.at(-1)?.contacts ?? [];
      if (cs.length) {
        blocks.push({ kind: "h", text: t("Connections") });
        const v3 = (v: number[] | undefined, k: number) => (v ? `${sig(Math.hypot(v[0], v[1], v[2]) * k)} (${v.map(x => sig(x * k)).join(", ")})` : "–");
        blocks.push({ kind: "table", widths: [4, 1.5, 3, 3, 1.5], rows: [[t("Components"), `${t("Area")}, mm²`, `${t("Force")}, N`, `${t("Moment")}, N·m`, t("Type")], ...cs.map(c => [`${res.comps![c.a]?.name ?? ""} – ${res.comps![c.b]?.name ?? ""}`, sig(c.area), v3(c.force, 1), v3(c.moment, 1e-3), t(c.type === "sliding" ? "Sliding" : c.type === "adhesive" ? "Adhesive" : "Bonded")])] });
        blocks.push({ kind: "p", text: t("Force: what the first component passes to the second. Moment: about the centre of the contact.") });
      }
      const rows = this.compRows();
      if (rows.length > 1) {
        const uf = UNITS[units.current].f;
        blocks.push({ kind: "h", text: t("By component") });
        blocks.push({ kind: "table", widths: [4, 2, 2, 2], rows: [[t("Component"), `${t("von Mises stress")}, MPa`, `${t("Displacement")}, ${units.current}`, t("Lowest safety factor (yield)")], ...rows.map(x => [res.comps![x.d].name, res.bodyMats?.[x.d]?.rigid ? t("Rigid").toLowerCase() : sig(x.maxVm), sig(x.maxU * uf), x.sf == null ? "–" : sig(x.sf)])] });
      }
      return;
    }
    const seen = new Set<string>(), rows: string[][] = [];
    for (const key of this.bodyKeys(doc)) {
      const q = this.bodyMatOf(doc, key);
      if (!q || q.name === this.matOf(doc)?.name || seen.has(q.name)) continue;
      seen.add(q.name);
      rows.push([q.name, `${sig(q.E ?? NaN)} GPa`, sig(q.nu ?? NaN), `${sig(q.density)} g/cm³`, q.sy ? `${sig(q.sy)} MPa` : "–"]);
    }
    if (!rows.length) return;
    blocks.push({ kind: "p", text: t("Bodies with their own material:") });
    blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2], rows: [[t("Name"), t("Elastic modulus"), t("Poisson's ratio"), t("Density"), t("Yield strength")], ...rows] });
  }

  /** What the report says: the study, its set-up and the results of the last pass, in the UI language. */
  private reportOf(): SimReport | null {
    this.repMarks = [];
    const doc = this.host.doc(), st = this.study(), res = this.res, last = res?.passes.at(-1);
    if (!doc || !st || !res || !last || this.stale()) return null;
    const m = this.matOf(doc), off = new Set(st.suppressed ?? []);
    const blocks: ReportBlock[] = [];
    const kv = (rows: string[][]) => blocks.push({ kind: "table", rows: [[t("Property"), t("Value")], ...rows], widths: [2, 3] });
    const n3 = (c: number[], f: number, unit: string) => `X ${sig(c[0] * f)}, Y ${sig(c[1] * f)}, Z ${sig(c[2] * f)} ${unit}`;
    const faces = (it: StudySupport | StudyLoad) => it.type === "gravity" || it.type === "temperature" ? "–" : it.type === "centrifugal" && !it.faces.length ? this.axisText(it as StudyLoad) : this.pickText(it);
    const name = (it: StudySupport | StudyLoad) => (it.name ?? it.id) + (off.has(it.id) ? ` (${t("left out")})` : "");
    blocks.push({ kind: "h", text: t("Study") });
    if (last.modes) return this.modalReport(doc, st, res, last);
    if (last.thermal) return this.thermalReport(doc, st, res, last);
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
        : l.type === "hydro" ? `${sig(l.value?.v ?? 0)} kg/m³, ${this.levelText(l)}` : l.type === "temperature" ? this.tempText(l)
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
    for (const k of kinds) this.pushImage(blocks, this.capture(k));
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
    this.compareBlocks(blocks);
    blocks.push({ kind: "h", text: t("Assumptions") });
    blocks.push({ kind: "p", text: t(ASSUMPTIONS) });
    return { title: t("Structural analysis report"), sub: `${doc.name} · ${st.name} · ${new Date().toLocaleString(lang())} · MöbiusCAD ${__APP_VERSION__}`, blocks };
  }

  private modalReport(doc: SimDoc, st: Study, res: Results, last: PassResult): SimReport {
    const m = this.matOf(doc), off = new Set(st.suppressed ?? []), blocks: ReportBlock[] = [];
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
    for (const i of elastic) { this.modeSel = i; this.pushImage(blocks, this.capture("u")); }
    this.plot = keep; this.modeSel = sel; this.animate = anim;
    this.showPlot();
    blocks.push({ kind: "h", text: t("Convergence") });
    blocks.push({ kind: "table", widths: [1, 2, 2, 2], rows: [[t("Pass"), t("Unknowns"), t("Frequency change"), t("Time")],
      ...res.passes.map(p => [String(p.pass), p.dofs.toLocaleString("en-US").replace(/,/g, " "), p.change == null ? "–" : `${sig(p.change)} %`, `${(p.ms / 1000).toFixed(1)} s`])] });
    blocks.push({ kind: "p", muted: true, text: this.modalNote(st, last) });
    this.compareBlocks(blocks);
    blocks.push({ kind: "h", text: t("Assumptions") });
    blocks.push({ kind: "p", text: t(ASSUMPTIONS) });
    return { title: t("Structural analysis report"), sub: `${doc.name} · ${st.name} · ${new Date().toLocaleString(lang())} · MöbiusCAD ${__APP_VERSION__}`, blocks };
  }

  /** A hydrostatic pressure's fluid surface. */
  private levelText(l: StudyLoad): string { return t("surface at {a} = {v} mm", { a: (l.axis ?? "z").toUpperCase(), v: sig(l.level ?? 0) }); }

  /** A centrifugal load without faces: its world axis. */
  private axisText(l: StudyLoad): string { return t("Axis {a} at the origin", { a: (l.axis ?? "z").toUpperCase() }); }

  /** Where the model sits and which way is down: what natural convection goes by (FR-TBC-010/011). */
  private enclosureHtml(st: Study): string {
    const e = st.settings.enclosure ?? "open", d = st.settings.down ?? [0, 0, -1];
    const dk = DOWNS.find(([, v]) => v.every((x, i) => x === d[i]))?.[0] ?? "";
    return `<label class="pm-field" title="${esc(t("Natural convection is weaker in a chassis: its film coefficients are multiplied by this factor. A preset also sets the ambient temperature."))}"><span>${esc(t("Enclosure"))}</span><select data-k="enclosure">`
      + ENCLOSURES.map(x => `<option value="${x.id}"${x.id === e ? " selected" : ""}>${esc(t(x.label))} (${sig(x.factor)})</option>`).join("")
      + `<option value="custom"${e === "custom" ? " selected" : ""}>${esc(t("Custom"))}</option></select></label>`
      + (e === "custom" ? `<label class="pm-field"><span>${esc(t("Convection factor"))}</span><input type="number" data-k="efactor" min="0.05" max="1" step="0.05" value="${sig(enclosureFactor(st.settings))}"></label>` : "")
      + `<label class="pm-field" title="${esc(t("Gravity's direction: natural convection depends on which faces stand upright and which face up or down"))}"><span>${esc(t("Down"))}</span><select data-k="down">`
      + DOWNS.map(([l]) => `<option value="${l}"${l === dk ? " selected" : ""}>${l}</option>`).join("") + (dk ? "" : `<option value="" selected>${esc(t("Custom"))}</option>`) + `</select></label>`;
  }

  /** What a thermal item is set to, for the tree and the report. */
  /** A heat load's power over time (FR-TLOAD-005), in a transient study only. */
  private profileGroup(l: StudyLoad, group: (legend: string, inner: string) => string): string {
    if (!this.study()?.settings.transient) return "";
    const p = l.profile, kind = p?.kind ?? "";
    const qf = (q: string, label: string, v: number | undefined) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="${q}" value="${v != null ? trim(v) : ""}" spellcheck="false" /><span class="muted">s</span></span></label>`;
    let inner = `<label class="pm-field"><span>${esc(t("Power"))}</span><select data-k="profile">${[["", "Constant"], ["step", "Switched on later"], ["duty", "Duty cycle"], ["table", "Table"]].map(([v, l2]) => `<option value="${v}"${v === kind ? " selected" : ""}>${esc(t(l2))}</option>`).join("")}</select></label>`;
    if (p?.kind === "step") inner += qf("pat", t("On from"), p.at ?? 0);
    else if (p?.kind === "duty") inner += qf("pon", t("On for"), p.on) + qf("pper", t("Every"), p.period) + qf("pdel", t("Starting at"), p.delay ?? 0);
    else if (p?.kind === "table") inner += `<label class="pm-field pm-col"><span>${esc(t("Time, s and share of the power"))}</span><textarea data-k="ptable" rows="5" spellcheck="false">${esc(p.pts.map(r => `${trim(r[0])} ${trim(r[1])}`).join("\n"))}</textarea></label>`;
    inner += `<p class="pm-help muted">${esc(kind === "duty" ? t("Full power for the on time of every cycle, none for the rest.") : kind === "table" ? t("One row per line: time and the share of the power (1 = full), straight between rows.") : kind === "step" ? t("No power until then, full power after.") : t("Full power from the start."))}</p>`;
    return group(t("Over time"), inner);
  }

  /** A thermal study's Time section (FR-TSOL-006): steady, or over time with its end, output interval and start temperature. */
  private timeHtml(st: Study, doc: SimDoc): string {
    const tr = st.settings.transient, amb = st.settings.ambient ?? DEFAULT_AMBIENT, dis = this.running ? " disabled" : "";
    let html = `<div class="sim-sec sim-tsec"><h4>${esc(t("Time"))}</h4><label class="chk" title="${esc(t(TIP.transient))}"><input type="checkbox" data-k="transient"${tr ? " checked" : ""}${dis} />${esc(t("Over time (transient)"))}</label>`;
    if (!tr) return html + `<p class="sim-note muted">${esc(t("Steady state: the temperatures the part settles at once it has warmed up."))}</p></div>`;
    html += `<label class="pm-field"><span>${esc(t("End time"))}, s</span><input type="number" data-k="tend" min="0" step="any" value="${sig(tr.end)}"${dis}></label>`
      + `<label class="pm-field"><span>${esc(t("Results every"))}, s</span><input type="number" data-k="tout" min="0" step="any" value="${sig(tr.out)}"${dis}></label>`
      + `<label class="pm-field"><span>${esc(t("Start temperature"))}, °C</span><input type="number" data-k="tstart" step="any" value="${tr.t0 != null ? sig(tr.t0) : ""}" placeholder="${esc(t("ambient"))} ${sig(amb)}"${dis}></label>`;
    if (!this.host.asm()) {
      const m = this.matOf(doc);
      html += m?.density && m.cp ? `<p class="sim-note muted" data-v="rcp">${esc(t("Density"))} ${sig(m.density)} g/cm³ · ${esc(t("specific heat"))} ${sig(m.cp)} J/(kg·K)</p>` : `<p class="sim-prob" data-v="rcp">${esc(t("A transient study needs a material with a density and a specific heat."))}</p>`;
    }
    return html + `<p class="sim-note muted">${esc(t("The solver picks its own time steps. Each heat source can be switched on later or cycled: open it to set its power over time."))}</p></div>`;
  }

  /** Forced air fields: speed (or a fan's flow through an opening) and the flow direction (FR-TBC-005). */
  private forcedHtml(f: ForcedAir, q: (k: string, label: string, v: number, unit: string) => string): string {
    const d = flowLabel(f.dir);
    return (f.fan ? q("fanq", t("Fan flow"), f.fan.q, "m³/h") + q("fana", t("Opening the air passes through"), f.fan.a, "cm²")
      + `<div class="pm-field"><span>${esc(t("Air speed"))}</span><span data-v="fanv">${sig(forcedSpeed(f))} m/s</span></div>` : q("speed", t("Air speed"), f.speed, "m/s"))
      + `<label class="chk pm-chk"><input type="checkbox" data-k="fanon"${f.fan ? " checked" : ""} />${esc(t("Speed from a fan's flow"))}</label>`
      + `<label class="pm-field" title="${esc(t("Which way the air moves over the faces"))}"><span>${esc(t("Flow direction"))}</span><select data-k="flow">${FLOWS.map(([l]) => `<option value="${l}"${l === d ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
  }

  private thermalText(it: StudySupport | StudyLoad, st: Study): string {
    const amb = (s: StudySupport) => `${sig(s.ambient ?? st.settings.ambient ?? DEFAULT_AMBIENT)} °C`;
    if (it.type === "temp") return `${sig(it.temp ?? 0)} °C`;
    if (it.type === "conv" && it.rth !== undefined && !it.all) return `${sig(it.rth)} K/W, ${amb(it)}`;
    if (it.type === "conv" && it.natural) return `${t("natural convection")}, ${amb(it)}`;
    if (it.type === "conv" && it.forced) return `${t("forced air")} ${sig(forcedSpeed(it.forced))} m/s ${flowLabel(it.forced.dir)}, ${amb(it)}`;
    if (it.type === "conv") return `${sig(it.h ?? 0)} W/(m²·K), ${amb(it)}`;
    if (it.type === "rad") return `ε ${sig(it.emis ?? 0)}, ${amb(it)}`;
    if (it.type === "radx") return `ε ${sig(it.emis ?? 0.9)} / ${sig(it.emis2 ?? it.emis ?? 0.9)}`;
    const prof = (l: StudyLoad) => (st.settings.transient && l.profile ? `, ${profileText(l.profile, t)}` : "");
    if (it.type === "heat") return `${sig(it.value?.v ?? 0)} W${prof(it)}`;
    if (it.type === "vheat") return `${sig(it.value?.v ?? 0)} W/m³${prof(it)}`;
    if (it.type === "hflux") return `${sig(it.value?.v ?? 0)} W/m²${prof(it)}`;
    if (it.type === "pkgheat") return `${sig((it.parts ?? []).reduce((a, x) => a + (x.off || !(x.p >= PACKAGE_MIN_POWER) || !x.comps.length ? 0 : x.p), 0))} W${prof(it)}`;
    return "";
  }

  private thermalReport(doc: SimDoc, st: Study, res: Results, last: PassResult): SimReport {
    const m = this.matOf(doc), off = new Set(st.suppressed ?? []), T = last.thermal!;
    const blocks: ReportBlock[] = [{ kind: "h", text: t("Study") }];
    const kv = (rows: string[][]) => blocks.push({ kind: "table", rows: [[t("Property"), t("Value")], ...rows], widths: [2, 3] });
    const name = (it: StudySupport | StudyLoad) => (it.name ?? it.id) + (off.has(it.id) ? ` (${t("left out")})` : "");
    const on = (it: StudySupport | StudyLoad) => ((it.type === "heat" && it.body) || it.type === "vheat" ? (res.comps ? t("whole component") : t("whole body")) : this.pickText(it));
    kv([[t("Document"), doc.name], [t("Study"), st.name], [t("Kind"), st.settings.transient ? t("Transient thermal") : t("Thermal")], [t("Ambient temperature"), `${sig(st.settings.ambient ?? DEFAULT_AMBIENT)} °C`], [t("Enclosure"), `${t(ENCLOSURES.find(x => x.id === (st.settings.enclosure ?? "open"))?.label ?? "Custom")} (${sig(enclosureFactor(st.settings))})`], [t("Passes"), `${res.passes.length} / ${Math.min(THERMAL_PASSES, st.settings.passes)}`],
      ...(res.comps ? [] : [[t("Material"), m?.name ?? "–"], [t("Thermal conductivity"), `${sig(m?.k ?? 0)} W/(m·K)`]])]);
    if (res.comps && res.bodyMats) {
      blocks.push({ kind: "h", text: t("Components") });
      blocks.push({ kind: "table", widths: [3, 3, 2], rows: [[t("Component"), t("Material"), `${t("Thermal conductivity")}, W/(m·K)`], ...res.comps.map((c, i) => [c.name, res.bodyMats![i]?.name ?? "–", res.bodyMats![i]?.kz ? `${sig(res.bodyMats![i].k ?? 0)} / ${sig(res.bodyMats![i].kz!)}` : sig(res.bodyMats![i]?.k ?? 0)])] });
    }
    blocks.push({ kind: "h", text: t("Heat sources") });
    if (!st.loads.length) blocks.push({ kind: "p", text: t("None.") });
    else blocks.push({ kind: "table", widths: [3, 3, 2, 3], rows: [[t("Name"), t("Type"), t("Applied to"), t("Details")], ...st.loads.map(l => [name(l), t(LOAD_LABEL[l.type]), on(l), this.thermalText(l, st)])] });
    blocks.push({ kind: "h", text: t("Cooling and fixed temperatures") });
    blocks.push({ kind: "table", widths: [3, 3, 2, 3], rows: [[t("Name"), t("Type"), t("Applied to"), t("Details")], ...st.supports.map(s => [name(s), t(SUPPORT_LABEL[s.type]), on(s), this.thermalText(s, st)])] });
    blocks.push({ kind: "h", text: t("Results") });
    if (res.cases?.length) {
      blocks.push({ kind: "table", widths: [3, 2, 2, 3], rows: [[t("Power case"), `${t("Highest temperature")}, °C`, `${t("Heat put in")}, W`, t("Heat sources")],
        ...res.cases.map(c => { const cs = st.cases?.find(x => x.id === c.id), T = c.passes.at(-1)!.thermal!;
          return [this.caseName(c), sig(T.max), sig(T.applied), st.loads.filter(l => !cs?.off.includes(l.id) && !off.has(l.id)).map(l => l.name ?? l.id).join(", ") || "–"]; })] });
      kv([[t("Power case shown"), this.enveloped ? t("Envelope (hottest of all cases)") : this.caseName(res.cases[Math.max(0, this.caseSel)])]]);
    }
    const out = T.flows.reduce((a, f) => a + f.out, 0);
    kv([[t("Highest temperature"), `${sig(T.max)} °C`], [t("Lowest temperature"), `${sig(T.min)} °C`], [t("Heat put in"), `${sig(T.applied)} W`],
      ...T.flows.map((f, i) => [`${f.out < 0 ? t("Heat brought in") : t("Heat taken away")}: ${this.nameOf(res.ids[i] ?? "")}`, `${sig(Math.abs(f.out))} W (${t("mean")} ${sig(f.mean)} °C${f.h !== undefined ? `, ${sig(f.h * 1e6)} W/(m²·K)` : ""})`]), [t("Heat taken away in total"), `${sig(out)} W`]]);
    const run = res.tr?.transient;
    if (run) {
      const k = Math.max(0, this.frame), end = run.times[run.times.length - 1];
      kv([[t("Time shown"), timeText(run.times[k])], [t("Start"), `${sig(run.t0)} °C`], [t("Hottest at the end"), `${sig(run.max[run.max.length - 1])} °C ${t("after {t}", { t: timeText(end) })}`],
        ...(run.steady != null ? [[t("Steady state at full power"), `${sig(run.steady)} °C`]] : []), [t("Time steps"), String(run.steps)], [t("Heat capacity"), `${sig(run.capacity)} J/K`]]);
      const step = Math.max(1, Math.ceil(run.times.length / 12));
      blocks.push({ kind: "table", widths: [2, 2, 2, 2], rows: [[`${t("Time")}`, `${t("Hottest point")}, °C`, `${t("Heat put in")}, W`, `${t("Heat taken away")}, W`],
        ...run.times.flatMap((tm, i) => (i % step === 0 || i === run.times.length - 1 ? [[timeText(tm), sig(run.max[i]), sig(run.put[i]), sig(run.out[i])]] : []))] });
    }
    if (T.exchanges?.length) {
      blocks.push({ kind: "h", text: t("Radiation between faces") });
      blocks.push({ kind: "table", widths: [3, 2, 2, 3], rows: [[t("Name"), t("View factor"), `${t("Heat")}, W`, `${t("Mean temperatures")}, °C`], ...T.exchanges.map((x, i) => [this.nameOf(res.xids?.[i] ?? ""), sig(x.f), sig(x.heat), Number.isFinite(x.ta) ? `${sig(x.ta)} → ${sig(x.tb)}` : "–"])] });
    }
    if (res.comps && T.comps) blocks.push({ kind: "table", widths: [3, 2, 2, 2], rows: [[t("Component"), `${t("Max")}, °C`, `${t("Mean")}, °C`, `${t("Heat")}, W`], ...T.comps.map((c, i) => [res.comps![i]?.name ?? "", sig(c.max), sig(c.mean), c.power ? sig(c.power) : "–"])] });
    if (res.comps && T.contacts?.length) {
      blocks.push({ kind: "h", text: t("Connections") });
      blocks.push({ kind: "table", widths: [4, 2, 2, 2, 2], rows: [[t("Components"), t("Contact"), `${t("Area")}, mm²`, `${t("Heat")}, W`, "ΔT, °C"],
        ...T.contacts.map(c => [`${res.comps![c.a]?.name ?? ""} – ${res.comps![c.b]?.name ?? ""}`, t(c.type === "perfect" ? "Perfect" : "Pad or contact resistance"), sig(c.area), sig(Math.abs(c.heat)), pct(Math.abs(c.ta - c.tb))])] });
    }
    const paths = this.heatPaths(res);
    if (paths.length) {
      const sh = (v: number, p: number) => `${Math.round((100 * v) / p)} %`;
      blocks.push({ kind: "h", text: t("Heat paths") });
      blocks.push({ kind: "table", widths: [3, 1, 2, 2, 2], rows: [[t("Part"), "W", t("Board"), t("Surface"), t("Other")], ...paths.map(x => [x.name, sig(x.p), sh(x.board, x.p), sh(x.air, x.p), sh(Math.max(0, x.other), x.p)])] });
    }
    const was = { ...this.plot };
    for (const k of ["temp", "flux"] as PlotKind[]) this.pushImage(blocks, this.capture(k));
    this.plot = was;
    this.showPlot();
    blocks.push({ kind: "h", text: t("Convergence") });
    blocks.push({ kind: "table", widths: [1, 2, 2, 2, 2], rows: [[t("Pass"), t("Unknowns"), t("Temperature change"), t("Est. error"), t("Time")],
      ...res.passes.map((p, i) => [String(p.pass), String(p.dofs), p.change == null ? "–" : `${pct(p.change)} %`, last.errors[i] == null ? "–" : `${pct(last.errors[i]!)} %`, `${(p.ms / 1000).toFixed(1)} s`])] });
    blocks.push({ kind: "p", text: t(THERMAL_ASSUMPTIONS) });
    return { title: t("Thermal analysis report"), sub: `${doc.name} · ${st.name} · ${new Date().toLocaleString(lang())} · MöbiusCAD ${__APP_VERSION__}`, blocks };
  }

  private modalNote(st: Study, last: PassResult): string {
    return last.converged ? t("Converged: the last pass changed the frequencies by at most {n} %.", { n: sig(last.change ?? 0) })
      : last.change != null ? t("Not converged to {tol} % yet (last change {n} %).", { tol: sig(st.settings.energyTol), n: sig(last.change) })
      : t("One pass only: no convergence check.");
  }

  /** Report: asks for the format, then saves the file. `as` skips the question. */
  async report(as?: "pdf" | "html") {
    if (this.running || !this.res || this.stale()) { toast(t("Solve the study first.")); return; }
    const kind = as ?? await chooseModal(t("Report"), this.study()?.kind === "thermal" ? t("The study, its heat sources and cooling, the results with pictures of the current view, and the convergence.") : t("The study, its supports and loads, the results with pictures of the current view, and the convergence."), [{ key: "pdf", label: "PDF" }, { key: "html", label: t("Web page (HTML)") }]);
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
      this.lastReport = { kind, blocks: rep.blocks.length, images: rep.blocks.filter(b => b.kind === "image").length, marks: this.repMarks };
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
    if (!st) this.modeFor = null;
    else if (st.id !== this.modeFor) { this.modeFor = st.id; this.mode = st.kind === "thermal" ? "thermal" : "structural"; }
    const asm = this.host.asm();
    const thermal = this.mode === "thermal";
    const mode = (id: "mode-structural" | "mode-thermal", label: string, title: string, on: boolean, why = "") =>
      `<button class="mc-b sim-mode-b${on ? " on" : ""}" data-s="${id}" role="radio" aria-checked="${on}" title="${esc(title)}"${why ? ` disabled data-why="${esc(why)}"` : busy && !on ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${ICON[id]}</span><span class="mc-l">${esc(label)}</span></button>`;
    const pick = `<div class="mc-g sim-mode" role="radiogroup" aria-label="${esc(t("Analysis"))}">`
      + mode("mode-structural", t("Structural"), t("Structural analysis: stress, displacement and natural frequencies"), !thermal)
      + mode("mode-thermal", t("Thermal"), t("Thermal analysis: temperatures and heat flow"), thermal) + `</div>`;
    const solve = (busy ? btn("stop", t("Stop"), t("Stop the analysis")) : btn("solve", t("Solve"), t("Run the analysis"), { dis: !st }))
      + btn("results", t("Results"), t("Show or hide the result plot on the model"), { on: this.plot.on && !!this.res && !this.stale(), dis: !this.res || this.stale() })
      + btn("report", t("Report"), t("Save the study and its results as a report"), { dis: busy || !this.res || this.stale() });
    if (thermal) {
      el.innerHTML = pick + sep + group(t("Study"), btn("newthermal", t("Thermal study"), t(asm ? "New thermal study: the temperatures of this assembly and where its heat goes" : TIP.newthermal), { dis: busy }) + (asm ? "" : btn("mat", t("Material"), t("The part's material: thermal conductivity"), { dis: busy })) + btn("ambient", t("Ambient"), t(TIP.ambient), { dis: busy }) + btn("transient", t("Over time"), t(TIP.transient), { dis: busy || st?.kind !== "thermal", on: !!(st?.kind === "thermal" && st.settings.transient) }))
        + sep + group(t("Heat sources"), THERMAL_LOADS.filter(k => k !== "pkgheat").map(k => btn(k, t(LOAD_LABEL[k]), t(TIP[k]), { dis: busy })).join(""))
        + sep + group(t("Cooling"), THERMAL_SUPPORTS.map(k => btn(k, t(SUPPORT_LABEL[k]), t(TIP[k]), { dis: busy })).join("").replace(/(<button[^>]*data-s="conv"[\s\S]*?<\/button>)/, `$1${btn("fan", t("Forced air"), t(TIP.fan), { dis: busy })}`))
        + sep + group(t("Solve"), solve);
      return;
    }
    const noLoads = st?.kind === "modal";
    el.innerHTML = pick + sep + group(t("Study"), btn("new", t("New study"), asm ? t("New static study of this assembly") : t("New static study of this part"), { dis: busy }) + btn("newmodal", t("Modal study"), asm ? t("New modal study: the natural frequencies and mode shapes of this assembly") : t("New modal study: the natural frequencies and mode shapes of this part"), { dis: busy }) + (asm ? "" : btn("mat", t("Material"), t("The part's material: elastic modulus, Poisson's ratio, strength"), { dis: busy })))
      + sep + group(t("Supports"), SUPPORTS.map(k => btn(k, t(SUPPORT_LABEL[k]), t(TIP[k]), { dis: busy })).join(""))
      + (noLoads ? "" : sep + group(t("Loads"), LOADS.map(k => btn(k, t(LOAD_LABEL[k]), t(TIP[k]), { dis: busy })).join("")))
      + sep + group(t("Connections"), (asm ? btn("weld", t(WELD_LABEL), t("A weld along edges where two components meet"), { dis: busy }) + btn("spot", t(SPOT_LABEL), t("Spot welds at points, through one component into the next"), { dis: busy }) : "") + btn("connector", t(CONNECTOR_LABEL), t("A rigid or spring connector between two sets of faces"), { dis: busy }) + btn("mass", t(MASS_LABEL), t("A mass spread over faces: it weighs and lowers the natural frequencies"), { dis: busy }))
      + sep + group(t("Solve"), btn("refine", t(REFINE_LABEL), t("Local accuracy: the solution starts finer at the picked faces"), { dis: busy || noLoads }) + solve);
  }

  private renderTree() {
    const el = $("#sim-tree");
    const doc = this.host.doc();
    if (!doc) { el.innerHTML = ""; return; }
    const st = this.study();
    if (!st) {
      el.innerHTML = `<div class="sim-empty"><p>${esc(this.host.asm() ? t("A study holds the supports and loads of one analysis. The assembly is solved as it is, without a mesh: every component with its part's material, joined where they touch.") : t("A study holds the supports and loads of one analysis. The part is solved as it is, without a mesh."))}</p><button class="btn" data-a="new">${esc(t("New study"))}</button> <button class="btn" data-a="newmodal">${esc(t("Modal study"))}</button> <button class="btn" data-a="newthermal">${esc(t("Thermal study"))}</button></div>`;
      return;
    }
    const list = doc.studies ?? [];
    const thermal = st.kind === "thermal";
    const m = this.matOf(doc), matOk = thermal ? !!m && !!m.k : !!m && !!m.E && m.nu != null, own = st.mats?.[""], solids = this.host.asm() ? [] : this.host.bodies();
    const ownMats = [...new Set(this.bodyKeys(doc).map(k => this.bodyMatOf(doc, k)?.name).filter((n): n is string => !!n && n !== m?.name))];
    const studyMat = `<div class="sim-smat"><span>${esc(t("In this study"))}</span><button class="btn small${own ? " own" : ""}" data-a="smat" data-b="" title="${esc(t("Another material for this study only: the part keeps its own"))}">${own ? `<span translate="no">${esc(own.name)}</span>` : esc(t("As the part"))}</button></div>`
      + (solids.length > 1 ? `<ul class="sim-complist sim-smats">${solids.map(b => { const q = st.mats?.[b.key], cur = this.bodyMatOf(doc, b.key); return `<li data-body="${esc(b.key)}"><span class="sim-cname" translate="no">${esc(b.name)}</span><button class="btn small${q ? " own" : ""}" data-a="smat" data-b="${esc(b.key)}" title="${esc(q ? t("Material picked for this study") : t("The body's material in the part"))}">${cur ? `<span translate="no">${esc(cur.name)}</span>` : esc(t("As the part"))}</button></li>`; }).join("")}</ul>` : "");
    const off = new Set(st.suppressed ?? []);
    const row = (it: StudySupport | StudyLoad | StudyRefine | StudyExtra, load: boolean) => {
      const bad = this.problems.get(it.id);
      const isOff = off.has(it.id);
      return `<li class="sim-row${isOff ? " off" : ""}${bad ? " bad" : ""}${this.edit?.draft.id === it.id ? " cur" : ""}" data-id="${it.id}">`
        + `<button class="sim-name" data-a="edit" translate="no" title="${esc(t("Edit"))}"><i class="sim-dot ${it.type === "refine" ? "ref" : it.type === "connector" ? "conn" : it.type === "mass" ? "mass" : it.type === "weld" ? "weld" : load ? "load" : "sup"}" aria-hidden="true"></i>${esc(it.name ?? it.id)}</button>`
        + `<span class="sim-meta">${isThermalType(it.type) ? esc(`${(it.type === "heat" && (it as StudyLoad).body) || it.type === "vheat" ? (this.host.asm() ? t("whole component") : t("whole body")) : this.pickText(it)} · ${this.thermalText(it as StudyLoad, st)}`) : it.type === "gravity" ? "" : it.type === "temperature" ? this.tempText(it as StudyLoad, true) : it.type === "centrifugal" && !it.faces.length ? esc(this.axisText(it as StudyLoad)) : esc(it.type === "connector" ? t(it.kind === "spring" ? "spring" : "rigid") : this.pickText(it))}${it.type === "mass" ? ` · ${trim(it.mass)} kg` : it.type === "refine" ? ` · ${esc(t("level {n}", { n: it.level }))}` : it.type === "weld" ? (it.on === "points" ? ` · ⌀ ${trim(it.dia ?? DEFAULT_SPOT)} mm` : ` · a ${trim(it.throat)} mm`) : ""}</span>`
        + `<button class="sim-ib" data-a="toggle" aria-pressed="${isOff}" title="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}" aria-label="${esc(isOff ? t("Include in the analysis") : t("Leave out of the analysis"))}">${isOff ? "○" : "●"}</button>`
        + `<button class="sim-ib" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">×</button>`
        + (bad ? `<p class="sim-prob">${esc(this.errorText(`${bad}: ${it.id}`))}</p>` : "")
        + `</li>`;
    };
    const none = (text: string) => `<li class="sim-none muted">${esc(text)}</li>`;
    let html = `<div class="sim-head">`
      + (this.renaming ? `<input type="text" data-k="sname" value="${esc(st.name)}" aria-label="${esc(t("Study name"))}" translate="no" />` : list.length > 1 ? `<select data-k="study" aria-label="${esc(t("Study"))}" translate="no">${list.map(s => `<option value="${s.id}"${s.id === st.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`
        : `<b translate="no">${esc(st.name)}</b>`)
      + `<span class="muted" data-v="kind">${esc(st.kind === "modal" ? t("Modal") : thermal ? t(st.settings.transient ? "Transient thermal" : "Thermal") : t("Static"))}</span><button class="sim-ib" data-a="renstudy" aria-pressed="${this.renaming}" title="${esc(t("Rename study"))}" aria-label="${esc(t("Rename study"))}">✎</button><button class="sim-ib" data-a="dupstudy" title="${esc(t("Duplicate study"))}" aria-label="${esc(t("Duplicate study"))}">⧉</button><button class="sim-ib" data-a="delstudy" title="${esc(t("Delete study"))}" aria-label="${esc(t("Delete study"))}">×</button></div>`;
    if (this.host.asm() && thermal) html += this.compsHtml(st) + this.thermalLinksHtml(st);
    else if (this.host.asm()) html += this.compsHtml(st) + this.boltsHtml(st)
      + (st.welds?.length ? `<div class="sim-sec sim-welds"><h4>${esc(t("Welds"))}</h4><p class="sim-note muted">${esc(t(WELD_NOTE))}</p><ul class="sim-list">${st.welds.map(w => row(w, false)).join("")}</ul></div>` : "")
      + this.linksHtml(st);
    else html += `<div class="sim-sec sim-mat"><h4>${esc(t("Material"))}</h4><button class="pm-box${matOk ? "" : " sim-warn"}" data-a="mat">${doc.material ? `<span translate="no">${esc(doc.material.name)}</span>` : esc(t("No material"))}</button>` + studyMat
      + (thermal ? (m && matOk ? `<p class="sim-note muted" data-v="kcond">${esc(t("Thermal conductivity"))} ${st.kt?.[""]?.length ? this.ktRange(st.kt[""]) : `${sig(m.k!)} W/(m·K)`}</p>${this.ktHtml(st, "")}` : `<p class="sim-prob">${esc(t("The analysis needs a material with a thermal conductivity."))}</p>`)
        : m && matOk ? `<p class="sim-note muted">E ${sig(m.E!)} GPa · ν ${sig(m.nu!)}${m.sy ? ` · ${esc(t("yield"))} ${sig(m.sy)} MPa` : ""}</p>` : `<p class="sim-prob">${esc(t("The analysis needs a material with an elastic modulus and Poisson's ratio."))}</p>`)
      + (ownMats.length ? `<p class="sim-note muted sim-bodymats">${esc(t("Bodies with their own material:"))} <span translate="no">${esc(ownMats.join(", "))}</span></p>` : "") + `</div>`;
    const auto = `<label class="chk sim-auto" title="${esc(t("After every change to the model or to the study, the study is solved again by itself"))}"><input type="checkbox" data-k="auto"${st.auto ? " checked" : ""} />${esc(t("Solve on change"))}</label>`;
    // load cases (static) or power cases (steady thermal): sets of the loads solved in one go
    const casesHtml = () => {
      if (st.kind === "modal" || (thermal && st.settings.transient) || !(st.loads.length > 1 || st.cases?.length)) return "";
      const cs = st.cases ?? [];
      return `<div class="sim-sec sim-cases"><h4>${esc(thermal ? t("Power cases") : t("Load cases"))}</h4>`
        + cs.map(c => `<div class="sim-case" data-c="${c.id}"><div class="sim-case-h"><input type="text" data-k="cname" value="${esc(c.name)}" aria-label="${esc(t("Name"))}" translate="no" spellcheck="false" /><button class="sim-ib" data-a="rmcase" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">×</button></div>`
          + st.loads.map(l => `<label class="chk"><input type="checkbox" data-k="cload" data-l="${l.id}"${c.off.includes(l.id) || off.has(l.id) ? "" : " checked"}${off.has(l.id) ? " disabled" : ""} /><span translate="no">${esc(l.name ?? l.id)}</span></label>`).join("") + `</div>`).join("")
        + `<p class="sim-note muted">${esc(thermal
          ? (cs.length ? t("Each case is solved on its own with its ticked heat sources and the same cooling. The results show one case, or the hottest of them all.") : t("All the heat sources work together. Add cases (idle, full power…) to solve different sets of them in one go."))
          : (cs.length ? t("Each case is solved on its own with its ticked loads and the same supports. The results show one case, or the highest values of them all.") : t("All the loads act together. Add cases to solve different sets of the loads in one go.")))}</p>`
        + (cs.length < MAX_CASES ? `<button class="btn small" data-a="addcase">${esc(thermal ? t("Add power case") : t("Add load case"))}</button>` : "") + `</div>`;
    };
    if (thermal) {
      const amb = st.settings.ambient ?? DEFAULT_AMBIENT, passes = Math.min(THERMAL_PASSES, st.settings.passes);
      html += `<div class="sim-sec sim-heat"><h4>${esc(t("Heat sources"))}</h4><ul class="sim-list">${st.loads.map(l => row(l, true)).join("") || none(t("None yet: pick one in the Simulation tab."))}</ul></div>` + casesHtml()
        + `<div class="sim-sec sim-cool"><h4>${esc(t("Cooling and fixed temperatures"))}</h4><ul class="sim-list">${st.supports.map(x => row(x, false)).join("") || none(t("None yet: the heat needs a way out. Pick one in the Simulation tab."))}</ul>`
        + `<label class="pm-field"><span>${esc(t("Ambient temperature"))}, °C</span><input type="number" data-k="ambient" step="any" value="${sig(amb)}" title="${esc(t(TIP.ambient))}"></label>`
        + this.enclosureHtml(st)
        + `<p class="sim-note muted">${esc(t("Faces with no condition are insulated: no heat crosses them."))}</p></div>`
        + this.timeHtml(st, doc)
        + `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: THERMAL_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === passes ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
        + `<label class="pm-field"><span>${esc(t("Stop at temperature change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
        + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once no temperature changes by more than {n} % of the temperature range.", { n: sig(st.settings.energyTol) }))}</p>` + auto + `</div>`;
    }
    const modal = st.kind === "modal";
    const relief = !modal && !!st.settings.relief;
    if (!thermal) html += `<div class="sim-sec${relief ? " sim-relieved" : ""}"><h4>${esc(t("Supports"))}</h4><ul class="sim-list">${st.supports.map(s => row(s, false)).join("") || none(modal ? t("None: the part is free. Supports are optional here.") : relief ? t("None: the part is free.") : t("None yet: pick one in the Simulation tab."))}</ul>`
      + (modal ? "" : `<label class="chk sim-relief" title="${esc(t(RELIEF_NOTE))}"><input type="checkbox" data-k="relief"${relief ? " checked" : ""} />${esc(t("Inertia relief"))}</label>` + (relief ? `<p class="sim-note muted">${esc(t(RELIEF_NOTE))}</p>` : "")) + `</div>`;
    if (!thermal && st.connectors?.length) html += `<div class="sim-sec sim-conns"><h4>${esc(t("Connectors"))}</h4><p class="sim-note muted">${esc(t(CONNECTOR_NOTE))}</p><ul class="sim-list">${st.connectors.map(c => row(c, false)).join("")}</ul></div>`;
    if (!thermal && st.masses?.length) html += `<div class="sim-sec sim-masses"><h4>${esc(t("Masses"))}</h4><p class="sim-note muted">${esc(t(MASS_NOTE))}</p><ul class="sim-list">${st.masses.map(c => row(c, false)).join("")}</ul></div>`;
    if (!modal && !thermal) html += `<div class="sim-sec sim-loads"><h4>${esc(t("Loads"))}</h4><ul class="sim-list">${st.loads.map(l => row(l, true)).join("") || none(t("None yet: pick one in the Simulation tab."))}</ul></div>`;
    if (!thermal) html += casesHtml();
    if (thermal) { /* its sections are above */ }
    else if (modal) html += `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Find"))}</span><select data-k="find"><option value="count"${st.settings.range ? "" : " selected"}>${esc(t("The lowest modes"))}</option><option value="range"${st.settings.range ? " selected" : ""}>${esc(t("Modes in a frequency range"))}</option></select></label>`
      + (st.settings.range
        ? `<label class="pm-field"><span>${esc(t("From"))}, Hz</span><input type="number" data-k="rfrom" min="0" step="any" value="${sig(st.settings.range.from)}"></label><label class="pm-field"><span>${esc(t("To"))}, Hz</span><input type="number" data-k="rto" min="0" step="any" value="${sig(st.settings.range.to)}"></label>`
        : `<label class="pm-field"><span>${esc(t("Modes"))}</span><input type="number" data-k="modes" min="1" max="${MAX_MODES}" step="1" value="${st.settings.modes ?? DEFAULT_MODES}"></label>`)
      + `<label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: MODAL_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === Math.min(MODAL_PASSES, st.settings.passes) ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
      + `<label class="pm-field"><span>${esc(t("Stop at frequency change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
      + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once no frequency changes by more than {n} %.", { n: sig(st.settings.energyTol) }))}</p>`
      + `<label class="pm-field"><span>${esc(t("Excitation"))}</span><input type="text" data-k="excite" value="${esc(st.excite ?? "")}" placeholder="${esc(t("e.g. 3000 rpm or 50 Hz"))}" title="${esc(t("A frequency the part is shaken at, such as a motor speed: modes within 10 % of it are marked"))}" spellcheck="false" /></label>`
      + `<label class="chk sim-auto" title="${esc(t("After every change to the model or to the study, the study is solved again by itself"))}"><input type="checkbox" data-k="auto"${st.auto ? " checked" : ""} />${esc(t("Solve on change"))}</label>` + `</div>`;
    else html += `<div class="sim-sec"><h4>${esc(t("Accuracy"))}</h4><label class="pm-field"><span>${esc(t("Passes"))}</span><select data-k="passes">${Array.from({ length: MAX_PASSES }, (_, i) => i + 1).map(k => `<option value="${k}"${k === st.settings.passes ? " selected" : ""}>${k}</option>`).join("")}</select></label>`
      + `<label class="pm-field"><span>${esc(t("Stop at energy change"))}, %</span><input type="number" data-k="tol" min="0" max="20" step="0.1" value="${sig(st.settings.energyTol)}"></label>`
      + `<p class="sim-note muted">${esc(t("Each pass raises the accuracy on the same geometry and stops early once the strain energy changes by less than {n} %.", { n: sig(st.settings.energyTol) }))} ${esc(t("Passes after the third raise it only where the estimated error is highest."))}</p>`
      + (st.refine?.length ? `<ul class="sim-list sim-refs">${st.refine.map(r => row(r, false)).join("")}</ul>` : "")
      + `<label class="chk sim-auto" title="${esc(t("After every change to the model or to the study, the study is solved again by itself"))}"><input type="checkbox" data-k="auto"${st.auto ? " checked" : ""} />${esc(t("Solve on change"))}</label>` + `</div>`;
    html += `<div class="sim-sec sim-res" aria-live="polite"><h4>${esc(t("Results"))}</h4>${this.resultsHtml()}</div>`;
    el.innerHTML = html;
  }

  private sumStore(): SummaryStore {
    const id = this.host.doc()?.id ?? "";
    if (id !== this.sumsDoc) {
      this.sumsDoc = id; this.sums = {};
      try { this.sums = parseSummaries(localStorage.getItem(`mc:simSum:${id}`)); } catch { /* no storage */ }
    }
    return this.sums;
  }
  /** Keeps the shown results' peak values, so that a later result or another study can be compared with them (FR-STU-023). */
  private noteResult() {
    const st = this.study(), r = this.res, last = r?.passes.at(-1);
    if (!st || !r || !last || r.study !== st.id || this.running || last.thermal) return;
    let h = 5381;
    for (let i = 0; i < r.key.length; i++) h = ((h << 5) + h + r.key.charCodeAt(i)) | 0;
    const base = { name: st.name, key: String(h >>> 0), at: Date.now() };
    let s: Summary;
    if (last.modes) s = { ...base, kind: "modal", mass: (last.mass ?? 0) * 1000, freqs: last.modes.filter(m => !m.rigid).map(m => m.hz) };
    else {
      const hs = this.hotList(), real = hs.some(x => x.singular) ? hs.find(x => !x.singular) : undefined;
      s = { ...base, kind: "static", maxU: last.maxU, maxVm: last.maxVm, sf: this.lowSf(last, real?.vm ?? last.maxVm) };
    }
    this.sums = noteSummary(this.sumStore(), st.id, s);
    try { localStorage.setItem(`mc:simSum:${this.sumsDoc}`, JSON.stringify(this.sums)); } catch { /* no storage */ }
  }
  /** What the shown results can be compared with, and the pick. */
  private compareWith(st: Study): { opts: { v: string; label: string; s: Summary }[]; sel: string; mine: Summary | null } {
    const store = this.sumStore(), me = store[st.id], kind = st.kind === "modal" ? "modal" : "static";
    const opts: { v: string; label: string; s: Summary }[] = [];
    if (me?.before && me.before.kind === kind) opts.push({ v: "prev", label: t("Before the last change"), s: me.before });
    for (const o of this.host.doc()?.studies ?? []) { const n = store[o.id]?.now; if (o.id !== st.id && n && n.kind === kind) opts.push({ v: o.id, label: o.name, s: n }); }
    const want = this.cmpSel[st.id];
    return { opts, sel: opts.some(o => o.v === want) ? want : opts[0]?.v ?? "", mine: me?.now && me.now.kind === kind ? me.now : null };
  }
  private compareLabel(k: string) { return k === "maxvm" ? t("von Mises stress") : k === "maxu" ? t("Displacement") : k === "sf" ? t("Safety factor") : k === "mass" ? t("Mass") : t("Mode {n}", { n: k.slice(1) }); }
  private compareValue(k: string, v: number | null) { return v == null ? "–" : k === "maxvm" ? `${sig(v)} MPa` : k === "maxu" ? this.lenText(v) : k === "sf" ? sig(v) : k === "mass" ? `${sig(v)} kg` : `${sig(v)} Hz`; }
  private compareChange(r: CompareRow) { return r.change == null ? "–" : Math.abs(r.change) < 0.05 ? "0 %" : `${r.change > 0 ? "+" : "−"}${Math.abs(r.change) < 10 ? Math.abs(r.change).toFixed(1) : Math.abs(r.change).toFixed(0)} %`; }
  private compared(): { with: string; label: string; rows: CompareRow[] } | null {
    const st = this.study();
    if (!st || !this.res || this.running || this.stale()) return null;
    const c = this.compareWith(st), o = c.opts.find(x => x.v === c.sel);
    return c.mine && o ? { with: o.v, label: o.label, rows: compareRows(c.mine, o.s) } : null;
  }
  /** This result beside another study's, or beside this study's own before the last change. */
  private compareHtml(): string {
    const st = this.study();
    if (!st || !this.res || this.running || this.stale()) return "";
    const c = this.compareWith(st), cmp = this.compared();
    let html = `<h5 class="sim-sub">${esc(t("Compare"))}</h5>`;
    if (!cmp) return html + `<p class="sim-note muted" data-v="cmpnone">${esc(t("Nothing to compare with yet: solve another study of this kind, or change the model and solve again."))}</p>`;
    html += `<label class="pm-field"><span>${esc(t("With"))}</span><select data-k="cmp">${c.opts.map(o => `<option value="${esc(o.v)}"${o.v === c.sel ? " selected" : ""}${o.v === "prev" ? "" : ' translate="no"'}>${esc(o.label)}</option>`).join("")}</select></label>`;
    html += `<table class="sim-cmptable"><thead><tr><th></th><th>${esc(t("This"))}</th><th>${esc(t("Other"))}</th><th>${esc(t("Difference"))}</th></tr></thead><tbody>`
      + cmp.rows.map(r => `<tr data-cmp="${r.key}"><td>${esc(this.compareLabel(r.key))}</td><td>${esc(this.compareValue(r.key, r.a))}</td><td>${esc(this.compareValue(r.key, r.b))}</td><td data-v="cmpchange">${esc(this.compareChange(r))}</td></tr>`).join("") + `</tbody></table>`;
    return html;
  }
  private compareBlocks(blocks: ReportBlock[]) {
    const cmp = this.compared();
    if (!cmp) return;
    blocks.push({ kind: "h", text: t("Compare") });
    blocks.push({ kind: "table", widths: [4, 3, 3, 2], rows: [["", t("This"), `${t("Other")}: ${cmp.label}`, t("Difference")], ...cmp.rows.map(r => [this.compareLabel(r.key), this.compareValue(r.key, r.a), this.compareValue(r.key, r.b), this.compareChange(r)])] });
  }

  private lenText(mm: number) { return `${sig(mm * UNITS[units.current].f)} ${units.current}`; }

  /** The passes ended early: the next one would not fit in memory (FR-SOL-020). */
  private cappedNote(last: PassResult): string {
    return last.capped ? `<p class="sim-note sim-capped" data-v="capped">${esc(t("The passes ended here: the next one would need about {n} MB of memory, more than a solve may take ({m} MB).", { n: last.capped, m: Math.round((memLimit() || MEMORY_LIMIT) / 2 ** 20) }))}</p>` : "";
  }

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
    if (last.thermal) return html + this.thermalHtml(r, last);
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
    last.reactions.forEach((re, i) => { html += `<dt>${esc(t("Reaction"))} <span translate="no">${esc(this.nameOf(r.ids[i] ?? ""))}</span></dt><dd title="${re.force.map(x => sig(x)).join(", ")} N; ${esc(t("moment about the origin"))} ${re.moment.map(x => sig(x / 1000)).join(", ")} N·m">${f(re.force)} N</dd>`; });
    if (!env) {
      const bal = loadBalance(last.reactions, last.applied);
      if (last.reactions.length > 1) html += `<dt>${esc(t("Reactions in total"))}</dt><dd data-v="rtotal" title="${bal.force.map(x => sig(x)).join(", ")} N; ${esc(t("moment about the origin"))} ${bal.moment.map(x => sig(x / 1000)).join(", ")} N·m">${f(bal.force)} N</dd>`;
      if (bal.off != null) html += `<dt title="${esc(t("How far the reactions are from balancing the applied loads, as a share of the load"))}">${esc(t("Out of balance"))}</dt><dd data-v="balance"${bal.off > 1 ? ' class="sim-low"' : ""}>${pct(bal.off).replace("<", "&lt;")} %</dd>`;
    }
    html += `</dl>`;
    if (!env) html += `<table class="sim-passes"><thead><tr><th>${esc(t("Pass"))}</th><th>${esc(t("Unknowns"))}</th><th>${esc(t("Energy change"))}</th><th>${esc(t("Est. error"))}</th><th>${esc(t("Time"))}</th></tr></thead><tbody>`
      + r.passes.map((p, i) => `<tr><td>${p.pass}</td><td${p.memory ? ` title="${esc(t("Memory: about {n} MB", { n: Math.max(1, Math.round(p.memory / 2 ** 20)) }))}"` : ""}>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${pct(p.change).replace("<", "&lt;")} %`}</td><td>${errs[i] == null ? "–" : `${i === errs.length - 1 && !pct(errs[i]!).startsWith("<") ? "≈ " : ""}${pct(errs[i]!).replace("<", "&lt;")} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`
      + chartSvg(errs, t("Estimated error per pass"));
    for (const line of this.localNotes(r.passes)) html += `<p class="sim-note muted sim-local">${esc(line)}</p>`;
    html += this.cappedNote(last);
    if (hs.length) {
      const uf = UNITS[units.current].f;
      html += `<h5 class="sim-sub">${esc(t("Hot spots"))}</h5><table class="sim-hot"><thead><tr><th>#</th><th>${esc(t("von Mises stress"))}</th><th>X, Y, Z, ${esc(units.current)}</th></tr></thead><tbody>`
        + hs.map((h, i) => `<tr data-a="hot" data-hot="${i}" tabindex="0" class="${h.singular ? "sing" : ""}${i === this.hotSel ? " sel" : ""}"><td>${i + 1}</td><td>${sig(h.vm)} MPa${h.singular ? ` ${warn}` : ""}</td><td>${h.at.map(x => String(Number((x * uf).toFixed(3)))).join(", ")}</td></tr>`).join("") + `</tbody></table><button class="btn small" data-a="hotcsv" title="${esc(t("Save the hot spots' places and values as a CSV file"))}">${esc(t("Export CSV"))}</button>`;
      if (singular) html += `<p class="sim-note sim-sing">⚠ ${esc(t("Stress singularity: value depends on refinement"))}. ${esc(real ? t("The safety factor uses the highest stress away from singularities.") : "")}</p>`;
    }
    html += this.compTableHtml();
    html += this.boltTableHtml() + this.weldTableHtml() + this.connTableHtml();
    html += this.probesHtml();
    html += this.pathHtml();
    html += this.compareHtml();
    if (!this.running) {
      if (r.cached) html += `<p class="sim-note muted sim-kept">${esc(t("From the last solve of this model and study."))}</p>`;
      if (!env) html += `<p class="sim-note muted">${esc(last.converged ? t("Converged: the last pass changed the strain energy by {n} %.", { n: sig(last.change ?? 0) })
        : last.change != null ? t("Not converged to {tol} % yet (last change {n} %). Stress near sharp corners keeps rising with accuracy.", { tol: sig(this.study()?.settings.energyTol ?? 2), n: sig(last.change) })
        : t("One pass only: no convergence check."))}</p>`;
      if (r.parts) html += `<p class="sim-note muted sim-bonded">${esc(t("The part's {n} bodies are analysed bonded: joined wherever they touch.", { n: r.parts }))}${r.bodyMats ? ` ${esc(t("Each body has its own material."))}` : ""}</p>`;
      html += `<p class="sim-note muted sim-assume">${esc(t(ASSUMPTIONS))}</p>`;
      if (!this.stale()) html += `<button class="btn small" data-a="report">${esc(t("Report…"))}</button> <button class="btn small" data-a="stl" title="${esc(t("Save the deformed shape, at the scale shown, as an STL file"))}">${esc(t("Deformed shape as"))} <span translate="no">STL</span></button>`;
    }
    return html;
  }

  /** Thermal results: the temperatures, where the heat goes, the passes and what they mean. */
  /** Power cases on a thermal result: the case shown (or the envelope) and each case's hottest point and heat. */
  private powerCasesHtml(r: Results): string {
    if (!r.cases?.length || this.running) return "";
    const env = this.enveloped;
    let html = `<label class="pm-field"><span>${esc(t("Power case"))}</span><select data-k="case" translate="no">${r.cases.map((c, i) => `<option value="${i}"${!env && i === Math.max(0, this.caseSel) ? " selected" : ""}>${esc(this.caseName(c))}</option>`).join("")}`
      + (r.cases.length > 1 ? `<option value="-1"${env ? " selected" : ""}>${esc(t("Envelope (hottest of all cases)"))}</option>` : "") + `</select></label>`;
    if (r.cases.length > 1) html += `<table class="sim-passes sim-casetable"><thead><tr><th>${esc(t("Power case"))}</th><th>${esc(t("Highest temperature"))}, °C</th><th>${esc(t("Heat put in"))}, W</th></tr></thead><tbody>`
      + r.cases.map((c, i) => { const T = c.passes.at(-1)!.thermal; return `<tr data-a="case" data-case="${i}" tabindex="0" class="${!env && i === this.caseSel ? "sel" : ""}"><td translate="no">${esc(this.caseName(c))}</td><td data-v="cmax">${T ? sig(T.max) : "–"}</td><td data-v="cheat">${T ? sig(T.applied) : "–"}</td></tr>`; }).join("") + `</tbody></table>`;
    if (env) html += `<p class="sim-note muted sim-env">${esc(t("Envelope: at every point the highest temperature of any case."))}</p>`;
    return html;
  }

  private thermalHtml(r: Results, last: PassResult): string {
    if (this.enveloped) {
      const T = last.thermal!;
      return this.powerCasesHtml(r) + `<dl class="sim-kv"><dt>${esc(t("Highest temperature"))}</dt><dd data-v="tmax">${sig(T.max)} °C</dd><dt>${esc(t("Lowest temperature"))}</dt><dd data-v="tmin">${sig(T.min)} °C</dd></dl>`
        + this.thermalCompsHtml(r, last) + this.thermalPassesHtml(r, last);
    }
    return this.powerCasesHtml(r) + this.thermalHtml0(r, last);
  }

  private thermalHtml0(r: Results, last: PassResult): string {
    const T = last.thermal!;
    const out = T.flows.reduce((a, f) => a + f.out, 0), size = Math.max(Math.abs(T.applied), T.flows.reduce((a, f) => a + Math.abs(f.out), 0) / 2);
    const off = size > 0 ? 100 * Math.abs(out - T.applied) / size : null;
    let html = `<dl class="sim-kv"><dt>${esc(t("Highest temperature"))}</dt><dd data-v="tmax">${sig(T.max)} °C</dd><dt>${esc(t("Lowest temperature"))}</dt><dd data-v="tmin">${sig(T.min)} °C</dd>`;
    const errs = last.errors, eLast = errs.at(-1), eBefore = errs.length > 1 ? errs[errs.length - 2] : null;
    if (eLast != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">${pct(eLast).startsWith("<") ? "" : "≈ "}${pct(eLast).replace("<", "&lt;")} %</dd>`;
    else if (eBefore != null) html += `<dt title="${esc(t("In the energy norm, from how the passes converge"))}">${esc(t("Estimated error"))}</dt><dd data-v="error">&lt; ${pct(eBefore).replace("< ", "")} %</dd>`;
    const run = r.tr?.transient;
    if (run) {
      // over time: what goes in, what the surfaces take at the time shown, and the rest warming the part
      const k = Math.max(0, this.frame);
      html += `<dt>${esc(t("Time shown"))}</dt><dd data-v="ttime">${esc(timeText(run.times[k]))}</dd><dt>${esc(t("Heat put in"))}</dt><dd data-v="heatin">${sig(run.put[k])} W</dd><dt>${esc(t("Heat taken away"))}</dt><dd data-v="heatout">${sig(run.out[k])} W</dd><dt title="${esc(t("Heat put in less heat taken away: what warms the part at this time"))}">${esc(t("Heat stored"))}</dt><dd data-v="stored">${sig(run.put[k] - run.out[k])} W</dd></dl>`;
      return html + this.transientHtml() + this.thermalPassesHtml(r, last);
    }
    html += `<dt>${esc(t("Heat put in"))}</dt><dd data-v="heatin">${sig(T.applied)} W</dd>`;
    T.flows.forEach((f, i) => {
      html += `<dt>${esc(f.out < 0 ? t("Heat brought in") : t("Heat taken away"))} <span translate="no">${esc(this.nameOf(r.ids[i] ?? ""))}</span></dt><dd data-v="flow" title="${esc(t("Mean temperature of the faces"))}: ${sig(f.mean)} °C">${sig(Math.abs(f.out))} W</dd>`;
      if (f.h !== undefined) html += `<dt>${esc(t("Mean film coefficient"))}</dt><dd data-v="hnat" title="${esc(t("The film coefficient these faces came to on average"))}">${sig(f.h * 1e6)} W/(m²·K)</dd>`;
    });
    if (T.flows.length > 1) html += `<dt>${esc(t("Heat taken away in total"))}</dt><dd data-v="heatout">${sig(out)} W</dd>`;
    if (off != null) html += `<dt title="${esc(t("How far the heat taken away is from the heat put in, as a share of it"))}">${esc(t("Out of balance"))}</dt><dd data-v="balance"${off > 1 ? ' class="sim-low"' : ""}>${pct(off).replace("<", "&lt;")} %</dd>`;
    html += `</dl><div class="sim-probebar"><button class="btn small" data-a="balcsv" title="${esc(t("Save the heat balance (heat put in, taken away by each item, contacts and components) as a CSV file"))}">${esc(t("Export heat balance CSV"))}</button></div>` + this.exchangeHtml(r, last) + this.thermalCompsHtml(r, last) + this.heatPathsHtml();
    return html + this.thermalPassesHtml(r, last);
  }

  /** A steady thermal result's heat balance as CSV (FR-TREP-011), English like the other exports; null without one. */
  balanceCsvText(): string | null {
    const r = this.res, last = r?.passes.at(-1), T = last?.thermal;
    if (!r || !T || r.tr || this.enveloped) return null;
    const comp = (i: number) => r.comps?.[i]?.name ?? `#${i + 1}`;
    return withLang("en", () => balanceCsv({
      applied: T.applied,
      flows: T.flows.map((f, i) => ({ name: this.nameOf(r.ids[i] ?? ""), out: f.out, area: f.area, mean: f.mean, h: f.h })),
      exchanges: (T.exchanges ?? []).map((x, i) => ({ name: this.nameOf(r.xids?.[i] ?? ""), heat: x.heat, ta: x.ta, tb: x.tb })),
      contacts: (T.contacts ?? []).map(c => ({ a: comp(c.a), b: comp(c.b), heat: c.heat, area: c.area, ta: c.ta, tb: c.tb })),
      comps: (r.comps ? T.comps ?? [] : []).map((c, i) => ({ name: comp(i), power: c.power, min: c.min, max: c.max, mean: c.mean })),
    }));
  }
  private exportBalance() {
    const text = this.balanceCsvText(), doc = this.host.doc(), st = this.study();
    if (!text || !doc || !st) return;
    download(new Blob([text], { type: "text/csv" }), `${`${doc.name}-${st.name}`.replace(/[\\/:*?"<>|]+/g, "_")}-heat-balance.csv`);
  }

  /** Radiation between face sets: what each passes, from which mean temperature to which, and the view factor found. */
  private exchangeHtml(r: Results, last: PassResult): string {
    const X = last.thermal?.exchanges;
    if (!X?.length) return "";
    return `<table class="sim-comptable sim-xtable"><thead><tr><th>${esc(t("Radiation between faces"))}</th><th title="${esc(t("The share of the radiation leaving the first faces that reaches the second"))}">${esc(t("View factor"))}</th><th>${esc(t("Heat"))}, W</th><th title="${esc(t("Mean temperatures of the first and the second faces"))}">°C</th></tr></thead><tbody>`
      + X.map((x, i) => `<tr data-x="${esc(r.xids?.[i] ?? "")}"><td translate="no">${esc(this.nameOf(r.xids?.[i] ?? ""))}</td><td data-v="xf">${sig(x.f)}</td><td data-v="xheat">${sig(x.heat)}</td><td data-v="xt">${Number.isFinite(x.ta) ? `${sig(x.ta)} → ${sig(x.tb)}` : "–"}</td></tr>`).join("")
      + `</tbody></table><p class="sim-note muted" data-v="xnote">${esc(t("Heat from the first faces to the second; negative = the second faces are hotter and warm the first."))}</p>`
      + (X.some(x => !(x.f > 0)) ? `<p class="sim-prob" data-v="xnone">${esc(t("Some of these face sets do not see each other (view factor 0): they exchange nothing. Check that the faces face each other."))}</p>` : "");
  }

  /** The passes table of a thermal result, its convergence chart and notes. */
  private thermalPassesHtml(r: Results, last: PassResult): string {
    const T = last.thermal!, errs = last.errors, st = this.study();
    let html = `<table class="sim-passes"><thead><tr><th>${esc(t("Pass"))}</th><th>${esc(t("Unknowns"))}</th><th title="${esc(t("Temperature change"))}">${esc(t("Temp. change"))}</th><th>${esc(t("Est. error"))}</th><th>${esc(t("Time"))}</th></tr></thead><tbody>`
      + r.passes.map((p, i) => `<tr><td>${p.pass}</td><td${p.memory ? ` title="${esc(t("Memory: about {n} MB", { n: Math.max(1, Math.round(p.memory / 2 ** 20)) }))}"` : ""}>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${pct(p.change).replace("<", "&lt;")} %`}</td><td>${errs[i] == null ? "–" : `${i === errs.length - 1 && !pct(errs[i]!).startsWith("<") ? "≈ " : ""}${pct(errs[i]!).replace("<", "&lt;")} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`
      + chartSvg(errs, t("Estimated error per pass"));
    html += this.cappedNote(last);
    if (r.passes.length && r.passes.every(q => q.thermal?.reused)) html += `<p class="sim-note muted" data-v="reused">${esc(t("Only powers or temperatures changed: solved again on the same grid and matrix, so it took a fraction of the time."))}</p>`;
    if (T.airSteps) html += `<p class="sim-note muted" data-v="airsteps">${esc(t("Air gaps conduct by air's k at their temperature: the last pass was solved {n} times until it settled.", { n: T.airSteps }))}</p>`;
    if (T.kSteps) html += `<p class="sim-note muted" data-v="ksteps">${esc(t("Conductivity changes with temperature: the last pass was solved {n} times until k settled.", { n: T.kSteps }))}</p>`;
    if (T.solves > 1) html += `<p class="sim-note muted sim-radnote">${esc(t("Radiation depends on the surface temperature itself: the last pass was solved {n} times until the temperatures settled.", { n: T.solves }))}</p>`;
    html += this.probesHtml();
    html += this.pathHtml();
    if (!this.running) {
      if (r.cached) html += `<p class="sim-note muted sim-kept">${esc(t("From the last solve of this model and study."))}</p>`;
      if (last.transient || r.tr) html += `<p class="sim-note muted sim-trnote">${esc(t("The steady passes chose the accuracy; the last row is the run in time from the start temperature."))}</p>`;
      else html += `<p class="sim-note muted">${esc(last.converged ? t("Converged: the last pass changed the temperatures by {n} % of their range.", { n: sig(last.change ?? 0) })
        : last.change != null ? t("Not converged to {tol} % yet (last change {n} %).", { tol: sig(st?.settings.energyTol ?? 1), n: sig(last.change) })
        : t("One pass only: no convergence check."))}</p>`;
      html += `<p class="sim-note muted sim-assume">${esc(t(THERMAL_ASSUMPTIONS))}</p>`;
      if (!this.stale()) html += `<button class="btn small" data-a="report">${esc(t("Report…"))}</button> <button class="btn small" data-a="tpkg" title="${esc(t("Save the temperatures as a thermal package: a zip that opens in ParaView, PyVista or FreeCAD, and as a thermal map on the model here"))}">${esc(t("Thermal package"))}</button>`;
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
    html += this.cappedNote(last);
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
      + r.passes.map(p => `<tr><td>${p.pass}</td><td${p.memory ? ` title="${esc(t("Memory: about {n} MB", { n: Math.max(1, Math.round(p.memory / 2 ** 20)) }))}"` : ""}>${p.dofs.toLocaleString("en-US").replace(/,/g, " ")}</td><td>${p.change == null ? "–" : `${sig(p.change)} %`}</td><td>${(p.ms / 1000).toFixed(1)} s</td></tr>`).join("") + `</tbody></table>`;
    html += this.compareHtml();
    if (!this.running) {
      const st = this.study();
      if (r.cached) html += `<p class="sim-note muted sim-kept">${esc(t("From the last solve of this model and study."))}</p>`;
      if (st) html += `<p class="sim-note muted">${esc(this.modalNote(st, last))}</p>`;
      if (r.parts) html += `<p class="sim-note muted sim-bonded">${esc(t("The part's {n} bodies are analysed bonded: joined wherever they touch.", { n: r.parts }))}${r.bodyMats ? ` ${esc(t("Each body has its own material."))}` : ""}</p>`;
      html += `<p class="sim-note muted sim-assume">${esc(t(ASSUMPTIONS))}</p>`;
      if (!this.stale()) html += `<button class="btn small" data-a="report">${esc(t("Report…"))}</button> <button class="btn small" data-a="stl" title="${esc(t("Save the deformed shape, at the scale shown, as an STL file"))}">${esc(t("Deformed shape as"))} <span translate="no">STL</span></button>`;
    }
    return html;
  }

  private renderPanel() {
    const pm = $("#sim-pm");
    const e = this.edit;
    pm.hidden = !e;
    if (!e) { pm.innerHTML = ""; return; }
    const d = e.draft;
    const title = t(e.kind === "refine" ? REFINE_LABEL : e.kind === "connector" ? CONNECTOR_LABEL : e.kind === "mass" ? MASS_LABEL : e.kind === "weld" ? (e.draft.on === "points" ? SPOT_LABEL : WELD_LABEL) : (SUPPORT_LABEL as Record<string, string>)[d.type] ?? (LOAD_LABEL as Record<string, string>)[d.type]);
    const group = (legend: string, inner: string) => `<fieldset class="pm-group"><legend>${esc(legend)}</legend>${inner}</fieldset>`;
    const chk = (k: string, on: boolean | undefined, label: string) => `<label class="chk pm-chk"><input type="checkbox" data-k="${k}"${on ? " checked" : ""} />${esc(label)}</label>`;
    const hint = t("A number, an expression, a unit or a global variable: 2 kN, 3 * F");
    const nf = (k: string, label: string, v: Num | undefined, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" data-n="${k}" value="${esc(shownValue(v, d.type as LoadType))}" title="${esc(hint)}" spellcheck="false" translate="no" /><span class="muted">${esc(unit)}</span></span></label>`;
    let body = `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-k="name" value="${esc(d.name ?? "")}" spellcheck="false" translate="no" /></label>`;
    if (e.kind === "connector") {
      const c = e.draft, side = (k: 1 | 2, list: FaceRef[]) => `<div class="pm-box${this.connSide === k ? " focus" : ""} sim-faces" role="button" tabindex="0" data-side="${k}" aria-pressed="${this.connSide === k}">${list.length ? esc(t("{n} face|{n} faces", { n: list.length })) : esc(t("Click faces on the model"))}</div>`;
      const kf = (q: string, label: string, v: number | undefined, unit: string, ph = "") => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="${q}" value="${v === undefined ? "" : trim(v)}" placeholder="${esc(ph)}" spellcheck="false" /><span class="muted">${esc(unit)}</span></span></label>`;
      body += group(t("Side 1"), side(1, c.faces)) + group(t("Side 2"), side(2, c.faces2))
        + group(t("Type"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="ckind"><option value="rigid"${c.kind === "rigid" ? " selected" : ""}>${esc(t("Rigid"))}</option><option value="spring"${c.kind === "spring" ? " selected" : ""}>${esc(t("Spring"))}</option></select></label>`
          + (c.kind === "spring" ? kf("k0", t("Stiffness along X"), c.k[0], "N/mm") + kf("k1", t("Stiffness along Y"), c.k[1], "N/mm") + kf("k2", t("Stiffness along Z"), c.k[2], "N/mm") + kf("kr", t("Against turning"), c.kr === undefined ? undefined : c.kr * 1e-3, "N·m/rad", t("rigid")) : "")
          + `<p class="pm-help muted">${esc(c.kind === "spring" ? t("Each side moves as a whole. The spring acts between the two sides; leave Against turning empty to keep them from turning against each other.") : t("Each side moves as a whole, and the two sides move together as one rigid piece."))}</p>`);
    } else if (d.type === "radx") {
      const r = d as StudySupport, side = (k: 1 | 2, list: FaceRef[]) => `<div class="pm-box${this.connSide === k ? " focus" : ""} sim-faces" role="button" tabindex="0" data-side="${k}" aria-pressed="${this.connSide === k}">${list.length ? esc(t("{n} face|{n} faces", { n: list.length })) : esc(t("Click faces on the model"))}</div>`;
      body += group(t("First faces"), side(1, r.faces)) + group(t("Second faces"), side(2, r.faces2 ?? []));
    } else if (d.type !== "gravity" && !this.unpicked(d)) {
      const on = (d as StudyLoad).on, n = pickCount(d);
      const ask = on === "edges" ? t("Click edges on the model") : on === "points" ? (e.kind === "weld" ? t("Click points on a face of the model") : t("Click corner points on the model")) : d.type === "hinge" || d.type === "torque" || d.type === "bearing" ? t("Click cylindrical faces on the model") : d.type === "centrifugal" ? t("Click a cylindrical face for the axis, or leave it empty and choose an axis below") : t("Click faces on the model");
      const sel = ON_TYPES.includes(d.type) ? `<label class="pm-field"><span>${esc(e.kind === "load" ? t("Acts on") : t("Holds"))}</span><select data-k="on">${[["", "Faces"], ["edges", "Edges"], ["points", "Points"]].map(([v, l]) => `<option value="${v}"${(on ?? "") === v ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>` : "";
      body += group(on === "edges" ? t("Edges") : on === "points" ? t("Points") : t("Faces"), sel + `<div class="pm-box focus sim-faces" role="status">${n ? esc(this.pickText(d)) : esc(ask)}</div>`
        + (n ? `<button class="btn small" data-k="clear">${esc(t("Clear"))}</button>` : ""));
    }
    if (e.kind === "mass") {
      body += group(t("Mass"), `<label class="pm-field"><span>${esc(t("Mass"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="mass" value="${trim(e.draft.mass)}" spellcheck="false" /><span class="muted">kg</span></span></label>`
        + `<p class="pm-help muted">${esc(t(MASS_NOTE))}</p>`);
    } else if (e.kind === "connector") {
      // its groups are above
    } else if (e.kind === "weld" && e.draft.on === "points") {
      body += group(t("Size"), `<label class="pm-field"><span>${esc(t("Diameter"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="dia" value="${trim(e.draft.dia ?? DEFAULT_SPOT)}" spellcheck="false" /><span class="muted">mm</span></span></label>`
        + `<p class="pm-help muted">${esc(t("Click points on a face: each spot goes through that component and joins it to the one behind it over a disc of this diameter. A click on a spot takes it away."))}</p>`);
    } else if (e.kind === "weld") {
      body += group(t("Size"), `<label class="pm-field"><span>${esc(t("Throat"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="throat" value="${trim(e.draft.throat)}" spellcheck="false" /><span class="muted">mm</span></span></label>`
        + `<p class="pm-help muted">${esc(t("Click the edges of one component that lie on another: the two are joined along them. The stress in the weld is its force per length over the throat."))}</p>`);
    } else if (e.kind === "refine") {
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
      const amb = this.study()?.settings.ambient ?? DEFAULT_AMBIENT;
      const ambient = `<label class="pm-field"><span>${esc(t("Ambient temperature"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="amb" value="${s.ambient === undefined ? "" : trim(s.ambient)}" placeholder="${trim(amb)}" title="${esc(t("Empty: the study's ambient temperature"))}" spellcheck="false" /><span class="muted">°C</span></span></label>`;
      if (s.type === "temp") body += group(t("Temperature"), q("temp", t("Temperature"), s.temp ?? amb, "°C")
        + `<p class="pm-help muted">${esc(t("The faces are held at this temperature, like a cold plate or a mounting surface whose temperature is known."))}</p>`);
      if (s.type === "conv" || s.type === "rad") body += group(t("Surfaces"), chk("all", s.all, t("All surfaces open to the air"))
        + (s.all ? `<p class="pm-help muted">${esc(t("Every surface of the model, without the areas where components lie on each other."))}</p>` : ""));
      const nat = !!s.natural, fan = !nat && !!s.forced, sink = s.rth !== undefined && !s.all && !nat && !fan, worked = nat || fan;
      const fanHtml = fan ? this.forcedHtml(s.forced!, q) : "";
      if (s.type === "conv") body += group(t("Convection"), `<label class="pm-field"><span>${esc(t("Cooling by"))}</span><select data-k="film"><option value="nat"${nat ? " selected" : ""}>${esc(t("Natural convection (worked out)"))}</option><option value="fan"${fan ? " selected" : ""}>${esc(t("Forced air (worked out)"))}</option>${FILM_PRESETS.map(([l, v]) => `<option value="${v}"${!sink && !worked && s.h === v ? " selected" : ""}>${esc(t(l))}</option>`).join("")}${s.all ? "" : `<option value="rth"${sink ? " selected" : ""}>${esc(t("Heatsink (thermal resistance)"))}</option>`}<option value=""${sink || worked || FILM_PRESETS.some(([, v]) => v === s.h) ? "" : " selected"}>${esc(t("Custom"))}</option></select></label>`
        + (sink ? q("rth", t("Thermal resistance"), s.rth!, "K/W") : worked ? fanHtml : q("hc", t("Film coefficient"), s.h ?? FILM_PRESETS[0][1], "W/(m²·K)")) + ambient
        + (fan ? `<p class="pm-help muted">${esc(t("Each face gets its own film coefficient from the air speed and how long it is along the flow (flat plate correlations, laminar and turbulent). Faces facing the flow are taken by their size. The air is taken at the ambient temperature and does not warm up as it passes."))}</p>` : "")
        + (nat ? `<p class="pm-help muted">${esc(t("Each face gets its own film coefficient from how it is tilted, how big it is and how much hotter it is than the air (plate correlations for still air), times the study's enclosure factor."))}</p>` : "")
        + (sink ? `<p class="pm-help muted">${esc(t("A heatsink that is not modelled: the picked faces pass their heat to the air through this thermal resistance, as its data sheet gives it."))}</p>` : "")
        + `<p class="pm-help muted">${esc(t("The faces give heat to the air or liquid around them: film coefficient × area × how much hotter they are than the surroundings. The presets are typical figures."))}</p>`);
      if (s.type === "radx") body += group(t("Radiation"), q("emis", t("Emissivity of the first faces"), s.emis ?? 0.9, "0…1") + q("emis2", t("Emissivity of the second faces"), s.emis2 ?? s.emis ?? 0.9, "0…1")
        + `<p class="pm-help muted">${esc(t("The two sets of faces exchange heat by radiation, in either direction: the hotter one warms the other. How much each sees of the other (the view factor) is found by casting rays, so other bodies in between shade it."))}</p>`);
      if (s.type === "rad") body += group(t("Radiation"), q("emis", t("Emissivity"), s.emis ?? 0.9, "0…1") + ambient
        + `<p class="pm-help muted">${esc(t("The faces radiate to surroundings at the ambient temperature. About 0.9 for paint, plastics and anodised aluminium, 0.05 to 0.1 for bare polished metal."))}</p>`);
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
      else if (l.type === "temperature") {
        const ths = this.thermalStudies(), src = ths.find(x => x.id === l.from);
        body += group(t("Temperature"), `<label class="pm-field"><span>${esc(t("Temperatures from"))}</span><select data-k="tfrom"><option value=""${src ? "" : " selected"}>${esc(t("One temperature everywhere"))}</option>${ths.map(x => `<option value="${esc(x.id)}"${x.id === src?.id ? " selected" : ""} translate="no">${esc(x.name)}</option>`).join("")}</select></label>`
          + (src ? `<p class="pm-help muted">${esc(src.settings.transient ? t("The temperatures of that study's last result at full power (its steady state), solved again with this study.") : t("The temperatures of that study's result, solved again with this study."))}</p>` : nf("value", t("Temperature"), l.value, "°C"))
          + `<label class="pm-field"><span>${esc(t("Stress-free at"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-q="tref" value="${trim(l.ref ?? DEFAULT_REF)}" spellcheck="false" /><span class="muted">°C</span></span></label>`
          + `<p class="pm-help muted">${esc(t("The part grows by its expansion coefficient α times how much warmer it is than the stress-free temperature. Where the supports stop it growing, it is stressed. Uses the material's α."))}</p>`);
      }
      else if (l.type === "heat") body += group(t("Heat"), chk("body", l.body, this.host.asm() ? t("Throughout the whole component") : t("Throughout the whole body")) + nf("value", t("Power"), l.value, "W")
        + `<p class="pm-help muted">${esc(l.body ? (this.host.asm() ? t("The total power, made evenly throughout the components the picked faces are on.") : t("The total power, made evenly throughout the part's volume.")) : t("The total power, spread evenly over the picked faces."))}</p>`) + this.profileGroup(l, group);
      else if (l.type === "pkgheat") {
        const parts = l.parts ?? [];
        body += group(t("Parts"), `<table class="sim-pkparts"><thead><tr><th></th><th>${esc(t("Part"))}</th><th>${esc(t("Power, W"))}</th></tr></thead><tbody>${parts.map((x, i) => {
          const low = !(x.p >= PACKAGE_MIN_POWER), lost = !x.comps.length;
          return `<tr data-pk="${x.id}" class="${low || lost ? "muted" : ""}"${lost ? ` title="${esc(t("No body of the model was matched to this part."))}"` : low ? ` title="${esc(t("Under 10 mW: left out."))}"` : ""}><td><input type="checkbox" data-k="pkon" data-i="${i}" aria-label="${esc(x.name)}"${x.off ? "" : " checked"}${lost ? " disabled" : ""} /></td><td translate="no">${esc(x.name)}</td><td><input type="text" inputmode="decimal" data-q="pkp" data-i="${i}" value="${trim(x.p)}" spellcheck="false"${lost ? " disabled" : ""} /></td></tr>`;
        }).join("")}</tbody></table>`
          + `<p class="pm-help muted">${esc(t("The power of each part from the board's thermal package, made throughout the part's bodies. Untick a part to leave it out, or type another power."))}</p>`)
          + (l.board ? group(t("Heat paths"), chk("split", l.split, t("Keep the package's split"))
            + `<p class="pm-help muted">${esc(l.split ? t("Each part's board share enters the board under the part as a fixed power, and a chassis share leaves the model; the rest is made in the part.") : t("Off: all the heat is made in the parts and goes where the conductances send it."))}</p>`) : "")
          + this.profileGroup(l, group);
      }
      else if (l.type === "vheat") body += group(t("Volume heat"), nf("value", t("Heat per volume"), l.value, "W/m³")
        + `<p class="pm-help muted">${esc(this.host.asm() ? t("Heat made in each cubic metre of the components the picked faces are on; the power grows with their volume. 1 W/cm³ = 1,000,000 W/m³.") : t("Heat made in each cubic metre of the part; the power grows with its volume. 1 W/cm³ = 1,000,000 W/m³."))}</p>`) + this.profileGroup(l, group);
      else if (l.type === "hflux") body += group(t("Heat flux"), nf("value", t("Heat flux"), l.value, "W/m²")
        + `<p class="pm-help muted">${esc(t("Power per area going into the picked faces."))}</p>`) + this.profileGroup(l, group);
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
    const thermal = !!r!.thermal;
    const plots = PLOTS.filter(([id]) => thermal ? THERMAL_PLOTS.includes(id) && (id !== "err" || r!.pass > 1) : modes ? MODE_PLOTS.includes(id) : !THERMAL_PLOTS.includes(id) || id === "err" ? (id !== "sf" || this.hasYield()) && (id !== "err" || r!.pass > 1) : false);
    const top = sf && this.range[1] >= SF_TOP ? `${SF_TOP}+` : sig(this.range[1] * f);
    const modeSel = modes ? `<label class="ana-row"><span>${esc(t("Mode shape"))}</span><select data-k="mode" aria-label="${esc(t("Mode shape"))}">${modes.map((m, i) => `<option value="${i}"${i === mi ? " selected" : ""}>${i + 1}: ${m.rigid ? esc(t("rigid body")) : `${sig(m.hz)} Hz`}</option>`).join("")}</select></label>` : "";
    el.innerHTML = modeSel + `<div class="ana-head"><select data-k="kind" aria-label="${esc(t("Result"))}">${plots.map(([id, l]) => `<option value="${id}"${id === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select>`
      + `<button class="sim-ib" data-a="close" title="${esc(t("Hide the plot"))}" aria-label="${esc(t("Hide the plot"))}">×</button></div>`
      + this.legendTimeHtml()
      + `<div class="ana-ramp" style="background:${RAMP_CSS}${sf ? ";transform:scaleX(-1)" : ""}"></div><div class="ana-scale"><span data-v="min">${sig(this.range[0] * f)}</span><span>${esc(unit)}</span><span data-v="max">${top}</span></div>`
      + (sf ? `<p class="ana-note">${esc(t("Yield strength divided by the von Mises stress; below 1 the material yields."))}</p>` : "")
      + (this.capNote ? `<p class="ana-note" data-v="capnote">${esc(t("Solve again to see the results on the section planes."))}</p>` : "")
      + (k === "err" ? `<p class="ana-note">${esc(t("Where the last pass still changed the solution: the places that would gain most from more accuracy."))}</p>` : "")
      + (thermal ? "" : `<label class="chk"><input type="checkbox" data-k="deformed"${this.plot.deformed ? " checked" : ""} />${esc(t("Deformed shape"))}</label>`)
      + (this.plot.deformed && !thermal ? `<label class="ana-row"><span>${esc(t("Scale"))}</span><input type="text" inputmode="decimal" data-k="scale" value="${this.plot.scale > 0 ? trim(this.plot.scale) : ""}" placeholder="${esc(t("auto"))} ×${sig(this.usedScale)}" aria-label="${esc(t("Deformation scale"))}" /></label>` : "")
      + (modes ? (this.plot.deformed ? `<label class="chk"><input type="checkbox" data-k="animate"${this.animate ? " checked" : ""} />${esc(t("Animate"))}</label><label class="ana-row"><span>${esc(t("Speed"))}</span><select data-k="speed">${[0.25, 0.5, 1, 2, 4].map(x => `<option value="${x}"${x === this.speed ? " selected" : ""}>×${x}</option>`).join("")}</select></label><button class="btn small" data-a="gif" title="${esc(t("Save one swing of this mode shape as an animated GIF of the current view"))}">${esc(t("Record GIF"))}</button>` : "") + `<p class="ana-note">${esc(t("Mode shapes have no scale: only the pattern of the motion is meaningful."))}</p>` : "")
      + (thermal ? `<label class="chk" title="${esc(t("Arrows on the surface show which way the heat flows; the longest is where the heat flux is highest"))}"><input type="checkbox" data-k="vectors"${this.plot.vectors ? " checked" : ""} />${esc(t("Heat flow arrows"))}</label>` : "")
      + (modes ? "" : `<label class="chk"><input type="checkbox" data-k="marks"${this.plot.marks ? " checked" : ""} />${esc(t("Highest and lowest values"))}</label>`)
      + (modes ? "" : `<label class="chk"><input type="checkbox" data-k="iso"${this.iso.on ? " checked" : ""} />${esc(t("Show only a range of values"))}</label>`
        + (this.iso.on ? `<div class="ana-row"><select data-k="isoside" aria-label="${esc(t("Show only a range of values"))}"><option value="above"${this.iso.below ? "" : " selected"}>${esc(t("At or above"))}</option><option value="below"${this.iso.below ? " selected" : ""}>${esc(t("At or below"))}</option></select><input type="text" inputmode="decimal" data-k="isoval" value="${sig(this.isoValue() * f)}" aria-label="${esc(t("Value"))}" /></div>` : ""))
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
    if (a === "tcsv") { this.exportTransient(); return; }
    if (a === "balcsv") { this.exportBalance(); return; }
    if (a === "new") this.command("new");
    else if (a === "newmodal") this.command("newmodal");
    else if (a === "newthermal") this.command("newthermal");
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
    else if (a === "findlinks") void this.findLinks();
    else if (a === "compmat") void this.pickCompMat(b.dataset.c ?? "");
    else if (a === "smat") void this.pickStudyMat(b.dataset.b ?? "");
    else if (a === "matelink") {
      const st = this.study(), la = b.dataset.la ?? "", lb = b.dataset.lb ?? "";
      if (st && la && lb) this.host.change(t("Connection type"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        if (!s2) return;
        const rest = (s2.links ?? []).filter(l => !((l.a === la && l.b === lb) || (l.a === lb && l.b === la)));
        rest.push({ a: la, b: lb, type: "sliding" });
        s2.links = rest;
      });
    }
    else if (a === "comprigid") this.toggleRigid(b.dataset.c ?? "");
    else if (a === "compboard") this.toggleBoard(b.dataset.c ?? "");
    else if (a === "bgerber") this.pickGerber(b.dataset.c ?? "");
    else if (a === "bgerberclear") void this.readGerber(b.dataset.c ?? "", null);
    else if (a === "ktab") { const k = b.dataset.b ?? ""; this.ktOpen = this.ktOpen === k ? null : k; this.renderTree(); if (this.ktOpen != null) ($("#sim-tree").querySelector(`textarea[data-k="ktab"]`) as HTMLTextAreaElement | null)?.focus(); }
    else if (a === "ktclear") this.setKt(b.dataset.b ?? "", null);
    else if (a === "link") {
      if ((e.target as HTMLElement).closest("select")) return;
      const k = b.dataset.link ?? "";
      this.linkSel = this.linkSel === k ? "" : k;
      this.renderTree();
      this.drawMarks();
    }
    else if (a === "rcomp") this.pickComp(Number(b.dataset.rcomp));
    else if (a === "rcompall") this.pickComp(this.compSel);
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
        if (s.welds) { s.welds = s.welds.filter(x => x.id !== id); if (!s.welds.length) delete s.welds; }
        if (s.connectors) { s.connectors = s.connectors.filter(x => x.id !== id); if (!s.connectors.length) delete s.connectors; }
        if (s.masses) { s.masses = s.masses.filter(x => x.id !== id); if (!s.masses.length) delete s.masses; }
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
    } else if (a === "renstudy" && st) {
      this.renaming = !this.renaming;
      this.renderTree();
      const box = document.querySelector<HTMLInputElement>('#sim-tree [data-k="sname"]');
      if (box) { box.focus(); box.select(); }
      return;
    } else if (a === "hotcsv") { this.exportHot(); return; }
    else if (a === "stl") { this.exportStl(); return; }
    else if (a === "tpkg") { void this.exportPackage(); return; }
    else if (a === "dupstudy" && st) {
      const list = this.host.doc()?.studies ?? [], blank = newStudy(list, st.kind === "modal" ? "modal" : "static");
      let k = 2;
      while (list.some(x => x.name === `${st.name} (${k})`)) k++;
      const copy: Study = { ...(JSON.parse(JSON.stringify(st)) as Study), id: blank.id, name: `${st.name} (${k})` };
      this.client.cancel();
      this.edit = null; this.res = null; this.error = null; this.probes = []; this.probeKey = ""; this.probing = false;
      this.clearPlot();
      this.setActive(copy.id);
      this.host.change(t("Duplicate study"), d => { (d.studies ??= []).push(copy); });
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
    if (el.dataset.k === "study") { this.setActive(el.value); this.edit = null; this.changed(); }
    else if (el.dataset.k === "sname") {
      const st0 = this.study(), name = el.value.trim();
      this.renaming = false;
      if (st0 && name && name !== st0.name) this.host.change(t("Rename study"), d => { const x = d.studies?.find(y => y.id === st0.id); if (x) x.name = name; });
      else this.renderTree();
    }
    else if (el.dataset.k === "passes") this.host.change(t("Passes"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.passes = Number(el.value) || 3; });
    else if (el.dataset.k === "modes") {
      const v = Math.round(Number(el.value));
      if (!(v >= 1 && v <= MAX_MODES)) { el.value = String(st.settings.modes ?? DEFAULT_MODES); return; }
      this.host.change(t("Modes"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) s.settings.modes = v; });
    }
    else if (el.dataset.k === "transient") {
      this.host.change(t(el.checked ? "Transient study" : "Steady study"), d => { const x = d.studies?.find(y => y.id === st.id); if (!x) return; if (el.checked) x.settings.transient = { end: 3600, out: 60 }; else delete x.settings.transient; });
    }
    else if (el.dataset.k === "tend" || el.dataset.k === "tout" || el.dataset.k === "tstart") {
      const v = Number(el.value), k = el.dataset.k, tr = st.settings.transient;
      if (!tr) return;
      if (k === "tstart" ? el.value.trim() !== "" && (!Number.isFinite(v) || v < -273.15) : !(v > 0)) { el.value = k === "tend" ? sig(tr.end) : k === "tout" ? sig(tr.out) : tr.t0 != null ? sig(tr.t0) : ""; return; }
      this.host.change(t(k === "tend" ? "End time" : k === "tout" ? "Results every" : "Start temperature"), d => {
        const x = d.studies?.find(y => y.id === st.id)?.settings.transient;
        if (!x) return;
        if (k === "tend") x.end = v; else if (k === "tout") x.out = v; else if (el.value.trim() === "") delete x.t0; else x.t0 = v;
      });
    }
    else if (el.dataset.k === "reach") {
      const v = Number(el.value);
      this.reach = el.value.trim() && Number.isFinite(v) ? v : null;
      this.renderTree();
    }
    else if (el.dataset.k === "ktab") {
      const key = el.dataset.b ?? "", text = el.value.trim();
      if (!text) { this.setKt(key, null); return; }
      const rows = parseKTable(text);
      if (!rows) { toast(t("Type one row per line: a temperature in °C and a conductivity in W/(m·K) above 0, the temperatures rising."), "warn"); return; }
      this.setKt(key, rows);
    }
    else if (el.dataset.k === "ambient") {
      const v = Number(el.value);
      if (!el.value.trim() || !Number.isFinite(v) || v < -273.15) { el.value = sig(st.settings.ambient ?? DEFAULT_AMBIENT); return; }
      this.host.change(t("Ambient temperature"), d => { const x = d.studies?.find(y => y.id === st.id); if (x) x.settings.ambient = v; });
    }
    else if (el.dataset.k === "enclosure") {
      const v = el.value as Enclosure, pre = ENCLOSURES.find(x => x.id === v);
      this.host.change(t("Enclosure"), d => {
        const x = d.studies?.find(y => y.id === st.id);
        if (!x) return;
        if (v === "custom") { x.settings.factor = enclosureFactor(x.settings); x.settings.enclosure = "custom"; }
        else { x.settings.enclosure = v; delete x.settings.factor; if (pre) x.settings.ambient = pre.ambient; }
      });
    }
    else if (el.dataset.k === "efactor") {
      const v = Number(el.value);
      if (!(v > 0 && v <= 1)) { el.value = sig(enclosureFactor(st.settings)); return; }
      this.host.change(t("Convection factor"), d => { const x = d.studies?.find(y => y.id === st.id); if (x) x.settings.factor = v; });
    }
    else if (el.dataset.k === "down") {
      const v = DOWNS.find(([l]) => l === el.value)?.[1];
      if (v) this.host.change(t("Down"), d => { const x = d.studies?.find(y => y.id === st.id); if (x) x.settings.down = [...v]; });
    }
    else if (el.dataset.k === "cumul") { this.cumul = el.checked; this.renderTree(); }
    else if (el.dataset.k === "bolton") {
      const on = el.checked;
      this.setBolt(el.dataset.c ?? "", on ? t("Analyse as a bolt") : t("Analyse as a solid"), b => { if (on) delete b.off; else b.off = true; });
    } else if (el.dataset.k === "boltcls") {
      const v = el.value;
      if (v) this.setBolt(el.dataset.c ?? "", t("Property class"), b => { b.cls = v; });
    } else if (el.dataset.k === "boltpre" || el.dataset.k === "boltby") {
      const row = el.closest(".sim-boltset"), inp = row?.querySelector<HTMLInputElement>("[data-k=boltpre]"), by = row?.querySelector<HTMLSelectElement>("[data-k=boltby]");
      const v = inp && inp.value.trim() ? num(inp.value) : 0, tq = by?.value === "nm";
      if (v == null || v < 0) { toast(t("Type the preload as a number."), "warn"); this.renderTree(); return; }
      if (el.dataset.c === "*" && el.dataset.k === "boltby" && !v) return;
      this.setBolt(el.dataset.c ?? "", t("Bolt preload"), b => { if (v > 0) { b.preload = tq ? v * 1000 : v; if (tq) b.torque = true; else delete b.torque; } else delete b.preload; });
    }
    else if (el.dataset.k === "blayers" || el.dataset.k === "bcopper" || el.dataset.k === "bcover") {
      const k = el.dataset.k, v = num(el.value);
      const ok = v != null && (k === "blayers" ? Number.isInteger(v) && v >= 1 && v <= 32 : k === "bcopper" ? v > 0 && v <= 500 : v >= 0 && v <= 100);
      if (!ok) { toast(k === "blayers" ? t("Type the copper layers as a whole number from 1 to 32.") : k === "bcopper" ? t("Type the copper thickness in µm, up to 500.") : t("Type the copper coverage as a percentage from 0 to 100."), "warn"); this.renderTree(); return; }
      this.setBoard(el.dataset.c ?? "", k === "blayers" ? "layers" : k === "bcopper" ? "copper" : "cover", k === "bcover" ? v! / 100 : v!);
    }
    else if (el.dataset.k === "compon") {
      const id = el.dataset.c ?? "", on = el.checked;
      if (!on && this.host.comps().filter(c => !offComps(st).has(c.id)).length <= 1) { el.checked = true; toast(t("A study needs at least one component."), "warn"); return; }
      this.host.change(on ? t("Include component") : t("Leave component out"), d => {
        const s = d.studies?.find(x => x.id === st.id);
        if (!s) return;
        const c = { ...(s.comps?.[id] ?? {}) };
        if (on) delete c.off; else c.off = true;
        this.setComp(s, id, c);
      });
    }
    else if (el.dataset.k === "gap") {
      const v = Math.max(0, Number(el.value) / UNITS[units.current].f);
      if (!Number.isFinite(v)) return;
      this.host.change(t("Gap tolerance"), d => { const s2 = d.studies?.find(x => x.id === st.id); if (s2) { if (Math.abs(v - DEFAULT_GAP) < 1e-12) delete s2.settings.gap; else s2.settings.gap = v; } });
    } else if (el.dataset.k === "cfilter" || el.dataset.k === "tfilter") {
      if (el.dataset.k === "cfilter") this.linkFilter.comp = el.value; else this.linkFilter.type = el.value;
      this.renderTree();
    } else if (el.dataset.k === "linkall") {
      const v = el.value, pairs = [...document.querySelectorAll<HTMLSelectElement>("#sim-tree select[data-k=link]")].map(s => [s.dataset.a!, s.dataset.b!]);
      if (!v || !pairs.length) return;
      this.host.change(t("Connection type"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        if (!s2) return;
        const rest = (s2.links ?? []).filter(l => !pairs.some(([a, b]) => (l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (v === "sliding" || v === "none") for (const [a, b] of pairs) rest.push({ a, b, type: v });
        else if (v === "adhesive") for (const [a, b] of pairs) rest.push((s2.links ?? []).find(l => l.type === "adhesive" && ((l.a === a && l.b === b) || (l.a === b && l.b === a))) ?? { a, b, type: v, ...DEFAULT_GLUE });
        if (rest.length) s2.links = rest; else delete s2.links;
      });
    } else if (el.dataset.k === "link") {
      const a = el.dataset.a!, b = el.dataset.b!, v = el.value;
      this.host.change(t("Connection type"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        if (!s2) return;
        const rest = (s2.links ?? []).filter(l => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (v === "sliding" || v === "none") rest.push({ a, b, type: v });
        else if (v === "adhesive") rest.push({ a, b, type: v, ...DEFAULT_GLUE });
        if (rest.length) s2.links = rest; else delete s2.links;
      });
    } else if (el.dataset.k === "tlink") {
      const a = el.dataset.a!, b = el.dataset.b!, v = el.value;
      this.host.change(t("Contact type"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        if (!s2) return;
        const rest = (s2.links ?? []).filter(l => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        // a bolted pair is a bolted joint unless told otherwise: Perfect is then kept as a type of its own
        const bt = this.boltedPairs(this.freshBolts(st)?.list).has(pairKey(compOf(a), compOf(b)));
        if (v === "none") rest.push({ a, b, type: v });
        else if (v === "pad") rest.push({ a, b, type: v, ...DEFAULT_PAD });
        else if (v === "resist") rest.push({ a, b, type: v, h: DEFAULT_TCC });
        else if (v === "air") rest.push({ a, b, type: v, t: this.pairGap(st, a, b) });
        else if (v === "perfect" && bt) rest.push({ a, b, type: v });
        else if (v === "bolted" && !bt) rest.push({ a, b, type: v, h: BOLTED_TCC });
        if (rest.length) s2.links = rest; else delete s2.links;
      });
    } else if (el.dataset.k === "padlib") {
      const a = el.dataset.a!, b = el.dataset.b!, p = PAD_LIBRARY[Number(el.value)];
      if (el.value === "" || !p) return;
      this.host.change(t("Pad material"), d => {
        const l = d.studies?.find(x => x.id === st.id)?.links?.find(l => l.type === "pad" && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (l) { l.t = p.t; l.k = p.k; }
      });
    } else if (el.dataset.k === "airt") {
      const a = el.dataset.a!, b = el.dataset.b!, v = Number(el.value);
      el.setAttribute("aria-invalid", String(!(v > 0)));
      if (!(v > 0)) return;
      this.host.change(t("Air layer"), d => {
        const l = d.studies?.find(x => x.id === st.id)?.links?.find(l => l.type === "air" && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (l) l.t = v;
      });
    } else if (el.dataset.k === "padt" || el.dataset.k === "padk" || el.dataset.k === "tcch") {
      const a = el.dataset.a!, b = el.dataset.b!, v = Number(el.value), k = el.dataset.k;
      el.setAttribute("aria-invalid", String(!(v > 0)));
      if (!(v > 0)) return;
      this.host.change(t(k === "padt" ? "Pad thickness" : k === "padk" ? "Pad conductivity" : "Contact conductance"), d => {
        const s2 = d.studies?.find(x => x.id === st.id);
        const l = s2?.links?.find(l => (l.type === "pad" || l.type === "resist" || l.type === "bolted") && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (l) { if (k === "padt") l.t = v; else if (k === "padk") l.k = v; else l.h = v; }
        // a bolted joint by default gets its typed conductance as a link of its own
        else if (s2 && k === "tcch") (s2.links ??= []).push({ a, b, type: "bolted", h: v });
      });
    } else if (el.dataset.k === "gluet" || el.dataset.k === "gluee") {
      const a = el.dataset.a!, b = el.dataset.b!, v = Number(el.value), thick = el.dataset.k === "gluet";
      el.setAttribute("aria-invalid", String(!(v > 0)));
      if (!(v > 0)) return;
      this.host.change(t(thick ? "Adhesive thickness" : "Adhesive modulus"), d => {
        const l = d.studies?.find(x => x.id === st.id)?.links?.find(l => l.type === "adhesive" && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));
        if (l) { if (thick) l.t = v; else l.E = v; }
      });
    }
    else if (el.dataset.k === "relief") this.host.change(t("Inertia relief"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) { if (el.checked) s.settings.relief = true; else delete s.settings.relief; } });
    else if (el.dataset.k === "case") this.pickCase(Number(el.value));
    else if (el.dataset.k === "cmp") { const s = this.study(); if (s) { this.cmpSel[s.id] = el.value; this.renderTree(); } }
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
    else if (el.dataset.k === "auto") this.host.change(t("Solve on change"), d => { const s = d.studies?.find(x => x.id === st.id); if (s) { if (el.checked) s.auto = true; else delete s.auto; } });
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
    const side = (e.target as HTMLElement).closest<HTMLElement>("[data-side]")?.dataset.side;
    if (side && this.edit && this.twoSided(this.edit)) { this.connSide = side === "2" ? 2 : 1; this.renderPanel(); this.drawMarks(); return; }
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
    else if (k === "body") { const l = e.draft as StudyLoad; l.body = el.checked || undefined; if (l.body && !this.host.asm()) l.faces = []; }
    else if (k === "all") { const sp = e.draft as StudySupport; sp.all = el.checked || undefined; if (sp.all) { sp.faces = []; delete sp.rth; } }
    else if (k === "split") { const l = e.draft as StudyLoad; l.split = el.checked || undefined; }
    else if (k === "pkon") { const x = (e.draft as StudyLoad).parts?.[Number(el.dataset.i)]; if (x) x.off = el.checked ? undefined : true; }
    else if (k === "profile") {
      const l = e.draft as StudyLoad;
      if (el.value === "step") l.profile = { kind: "step", at: 60 };
      else if (el.value === "duty") l.profile = { kind: "duty", on: 30, period: 60 };
      else if (el.value === "table") l.profile = { kind: "table", pts: [[0, 0], [60, 1], [600, 1], [660, 0]] };
      else delete l.profile;
    }
    else if (k === "ptable") {
      const l = e.draft as StudyLoad, pts = parseProfile(el.value), bad = !pts;
      el.setAttribute("aria-invalid", String(bad));
      if (bad || l.profile?.kind !== "table") return;
      l.profile = { kind: "table", pts: pts! };
      this.renderTree();
      return;
    }
    else if (k === "film") {
      const sp = e.draft as StudySupport;
      delete sp.forced;
      if (el.value === "nat") { sp.natural = true; delete sp.rth; }
      else if (el.value === "fan") { sp.forced = { ...DEFAULT_FORCED, dir: [...DEFAULT_FORCED.dir] }; delete sp.rth; delete sp.natural; }
      else if (el.value === "rth") { sp.rth ??= 10; delete sp.natural; }
      else { delete sp.rth; delete sp.natural; if (el.value) sp.h = Number(el.value); }
    }
    else if (k === "flow") { const f = (e.draft as StudySupport).forced, d = FLOWS.find(x => x[0] === el.value); if (f && d) f.dir = [...d[1]]; }
    else if (k === "fanon") { const f = (e.draft as StudySupport).forced; if (f) { if (el.checked) f.fan = { q: 50, a: Math.round(50 / 3600 / Math.max(0.1, f.speed) * 1e4) }; else { if (f.fan) f.speed = fanSpeed(f.fan.q, f.fan.a) || f.speed; delete f.fan; } } }
    else if (k === "axis") (e.draft as StudyLoad).axis = el.value as "x" | "y" | "z";
    else if (k === "tfrom") { const l = e.draft as StudyLoad; if (el.value) l.from = el.value; else { delete l.from; l.value ??= { v: 100 }; } this.renderPanel(); }
    else if (k === "ckind" && e.kind === "connector") e.draft.kind = el.value === "spring" ? "spring" : "rigid";
    else if (k === "level" && e.kind === "refine") e.draft.level = Math.max(1, Math.min(MAX_REFINE, Number(el.value) || 1));
    else if (k === "up") { const l = e.draft as StudyLoad; l.axis = el.value.slice(-1) as "x" | "y" | "z"; l.flip = el.value.length > 1 || undefined; }
    else if (el.dataset.q) {
      const q = el.dataset.q, v = num(el.value), sup = e.draft as StudySupport;
      if (q === "pkp") {
        const x = (e.draft as StudyLoad).parts?.[Number(el.dataset.i)], bad = v == null || v < 0;
        el.setAttribute("aria-invalid", String(bad));
        if (!bad && x) { x.p = v!; this.renderTree(); }
        return;
      }
      if (q === "pat" || q === "pon" || q === "pper" || q === "pdel") {
        const p = (e.draft as StudyLoad).profile;
        const bad = v == null || v < 0 || (q === "pper" && !(v > 0)) || (p?.kind === "duty" && ((q === "pon" && v >= p.period) || (q === "pper" && v <= p.on)));
        el.setAttribute("aria-invalid", String(bad));
        if (bad || !p) return;
        if (p.kind === "step" && q === "pat") p.at = v || undefined;
        else if (p.kind === "duty") { if (q === "pon") p.on = v; else if (q === "pper") p.period = v; else if (q === "pdel") p.delay = v || undefined; }
        this.renderTree();
        return;
      }
      if (q === "speed" || q === "fanq" || q === "fana") {
        const f = sup.forced, bad = v == null || !(v > 0) || (q === "speed" && v > 100);
        el.setAttribute("aria-invalid", String(bad));
        if (bad || !f) return;
        if (q === "speed") f.speed = v!;
        else if (f.fan) { if (q === "fanq") f.fan.q = v!; else f.fan.a = v!; f.speed = fanSpeed(f.fan.q, f.fan.a); }
        this.renderTree();
        const out = document.querySelector('#sim-pm [data-v="fanv"]');
        if (out) out.textContent = `${sig(f.speed)} m/s`;
        return;
      }
      if (q === "tref") { const bad = v == null || v < -273.15; el.setAttribute("aria-invalid", String(bad)); if (!bad) { (e.draft as StudyLoad).ref = v!; this.renderTree(); } return; }
      if (q === "amb" && !el.value.trim()) { delete sup.ambient; el.setAttribute("aria-invalid", "false"); this.renderTree(); return; }
      if (q === "kr" && e.kind === "connector" && !el.value.trim()) { delete e.draft.kr; el.setAttribute("aria-invalid", "false"); return; }
      const bad = v == null || ((q === "kn" || q === "kt" || q === "kr" || (e.kind === "connector" && q[0] === "k")) && v < 0) || ((q === "throat" || q === "mass" || q === "dia" || q === "hc" || q === "rth") && !(v > 0)) || ((q === "emis" || q === "emis2") && !(v > 0 && v <= 1)) || ((q === "temp" || q === "amb") && v < -273.15);
      el.setAttribute("aria-invalid", String(bad));
      if (bad) return;
      if (e.kind === "connector") { if (q === "kr") e.draft.kr = v * 1e3; else if (/^k[012]$/.test(q)) e.draft.k[Number(q[1])] = v; return; }
      if (q === "mass" && e.kind === "mass") { e.draft.mass = v; return; }
      if (q === "dia") { (e.draft as StudyWeld).dia = v; this.drawMarks(); }
      else if (q === "throat") (e.draft as StudyWeld).throat = v;
      else if (q === "kn") sup.kn = v; else if (q === "kt") sup.kt = v;
      else if (q === "temp") sup.temp = v; else if (q === "hc") sup.h = v; else if (q === "rth") sup.rth = v; else if (q === "emis") sup.emis = v; else if (q === "emis2") sup.emis2 = v; else if (q === "amb") sup.ambient = v;
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
    if (k === "kind") { this.plot.kind = el.value as PlotKind; this.iso.value = null; }
    else if (k === "deformed") this.plot.deformed = el.checked;
    else if (k === "marks") this.plot.marks = el.checked;
    else if (k === "vectors") this.plot.vectors = el.checked;
    else if (k === "iso") { this.iso.on = el.checked; if (el.checked && this.iso.value == null) this.iso.below = this.plot.kind === "sf"; }
    else if (k === "isoside") this.iso.below = el.value === "below";
    else if (k === "isoval") { const v = num(el.value), fu = this.plotUnit()[1]; this.iso.value = el.value.trim() && v != null ? v / fu : null; }
    else if (k === "animate") this.animate = el.checked;
    else if (k === "speed") this.speed = Number(el.value) || 1;
    else if (k === "mode") { this.modeSel = Number(el.value); this.renderTree(); }
    else if (k === "time") { this.seek(Number(el.value)); return; }
    else if (k === "scale") { const v = num(el.value); this.plot.scale = el.value.trim() && v != null && v > 0 ? v : 0; }
    else return;
    this.showPlot();
    if (k === "kind" && this.pathData) this.renderTree();
    this.renderLegend();
  }

  /** Opens the Simulation tab (menus, tests). */
  open() { selectCmTab("simulation"); this.host.showTab(); }
}
