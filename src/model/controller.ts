// Part modelling UI (FRS phases P0/P1): the command bar over the view, the
// Features tab (feature tree and the property panel of the open command), the
// ✓/✕ confirm corner, sketch editing, picking faces and edges, and part files.
//
// The document (DocStore) is the source of truth; every rebuild sends it to the
// kernel worker and shows the returned body with the viewer's own pipeline, so
// the measuring tools work on modelled parts unchanged.
import { fullyDefineSketch } from "../sketch/define";
import type { VaultTie } from "../pdm/panel";
import type { NamedView, V2 } from "./types";
import type { NamedViews } from "../viewer/navigation";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import type { EdgeInfo, PartData } from "../topology";
import { edgeLoop, sameEdges, tangentChain } from "./chain";
import { DocStore, dependants, moved, newPart, nextName, orderProblem, parents, uid } from "./doc";
import { canCopy, copyClip, pasteClip, type Clip } from "./paste";
import { activate, addConfig, applyConfigTable, configTable, nextConfigName, removeConfig, renameConfig } from "./configs";
import { download } from "../tools/exporters";
import { evaluate, ExprError, isPlain } from "./expr";
import { journalDrop, journalList, journalSave, packPart, unpackPart, PART_EXT, type JournalEntry } from "./file";
import { snapshotList, snapshotRead, snapshotSave, SNAPSHOT_KEEP } from "./snapshots";
import { ModelKernel, type Rebuild } from "./kernelClient";
import { pathId, hasDir2, dir2Apart, dir2Blind, clearDir2, threadThrough, holeExits, DIR2_ENDS, type Dir2End } from "./types";
import { parseXyz } from "./curves";
import { textPolys, TEXT_FONTS } from "../sketch/text";
import { ctxRefs, type PartContext } from "./context";
import { applyDir as tfDir, applyPoint as tfPoint, invert as tfInvert } from "../asm/math";
import { segPoints, solve3d } from "../sketch/sketch3d";
import type { CtxRef, SkEnt, SketchPatternFeature, FeatureFolder, ThreadFeature, Sketch3dFeature, Sk3Rel, CurveFeature, SweepSurfFeature, SweepPath,
  AxisFeature, ChamferFeature, CsysFeature, CircularPatternFeature, EdgeRef, ExtrudeFeature, Feature, FeatureStatus, FilletFeature, ScaleFeature, Frame, LinearPatternFeature, LineRef,
  GlobalVar, HelixFeature, LoftFeature, RibFeature, SplitFeature, FaceRef, RecognizedHole, ImportFeature, HealFeature, HoleSink, CombineFeature, IndentFeature, SplitBodyFeature, DeleteBodyFeature, MoveBodyFeature, DeleteFaceFeature, MoveFaceFeature, PlaneSurfFeature, ExtrudeSurfFeature, OffsetSurfFeature, KnitFeature, ThickenFeature, ReplaceFaceFeature, RevolveSurfFeature, LoftSurfFeature, TrimSurfFeature, FillSurfFeature, ExtendSurfFeature, UntrimSurfFeature, IntersectFeature, SweepFeature, HoleFeature, MirrorFeature, Num, PartDoc, PlaneFeature, PlaneRef, PointFeature, RevolveFeature, ShellFeature, DraftFeature, SketchFeature, V3, VertexRef,
} from "./types";
import { hexRgb, toRef, type MatRef } from "../tools/materials";
import { pickMaterial } from "../materialPicker";
import { holeCallout, holeDiagram, holeIcon, holeSection, HOLE_KINDS } from "./holeView";
import { ISO_METRIC, HEAT_INSERTS, HOLE_STANDARDS, holeSize, insertSize, majorOf, recognizedHoleFeatures, standardOf, type HoleStandard } from "./holes";

/** What a hole favourite keeps: the definition, not the placement. */
/** Drag data of a Features tree row (FR-HIS-014: Ctrl+drag onto a face or plane pastes a copy). */
const FEATURE_DRAG = "application/x-mcad-feature";
const HOLE_DEF_KEYS = ["kind", "standard", "size", "fit", "diameter", "end", "depth", "flat", "cbDia", "cbDepth", "csDia", "csAngle", "threadDepth", "threadEnd", "nearCs", "underCs", "farCs", "headClear", "drillAngle", "major", "pitch", "cdDia", "cdDepth", "cdAngle", "slotLen", "slotAngle"] as const;
interface HoleFav { name: string; def: Partial<HoleFeature> }
function loadFavs(): HoleFav[] { try { const v = JSON.parse(localStorage.getItem("mc:holeFavs") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveFavs(list: HoleFav[]) { try { localStorage.setItem("mc:holeFavs", JSON.stringify(list)); } catch { /* storage blocked: kept for this page only */ } }
/** A hole's thread/screw standard: the stored one, else the one its size belongs to. */
function holeStd(f: HoleFeature): HoleStandard { return f.standard ?? (f.size ? standardOf(f.size) : "iso"); }
function holeTitle(f: HoleFeature) { return `${f.size ?? `Ø${trimNum(f.diameter.v, 2)}`} ${f.kind}`; }

import { evalVars, exprTargets, refreshExprs, renameEverywhere, validVarName } from "./params";
import { STD_FRAMES } from "../kernel/model";
import { ellOf, ellParam, ellPts, ellSweep } from "../sketch/ellipse";
import { entBezier } from "../sketch/conic";
import { bezPts } from "../sketch/spline";
import { SketchEditor, REL_NAME, relName, trimNum, type SkTool } from "../sketch/editor";
import { SNAP_KINDS, parseSnaps, type SnapKind } from "../sketch/snaps";
import { ORIGIN, repairs, solve } from "../sketch/solver";
import { sketchPath, sketchProfile, textPath } from "../sketch/profile";
import { regionAt, regionPoint, sketchRegions, type Region } from "../sketch/regions";
import { SEL_FILTER } from "../tools/Snapper";
import { bodyMasses } from "../tools/inertia";
import { units, UNITS } from "../tools/units";
import { csys } from "../tools/csys";
import { askFileName, bindTabs, confirmModal, toast, trapFocus } from "../ui";
import { cmTab, onCmTab, selectCmTab } from "../commandBar";
import { rememberWeld } from "../weldments/defaults";
import { WELD_ICONS, WELD_TOOLS, WELD_TOOL_SET, bindWeldPanel, cornerSpots, cutListRows, locateSpots, isWeldFeature, showCutList, weldChange, weldSymbols, weldDraft, weldFocus, weldMissing, weldPanel, weldPick, type WeldCtx, type WeldTool } from "../weldments/ui";
import type { EndCapFeature, GussetFeature } from "../weldments/types";
import { capDir, splitSubs } from "../weldments/types";
import { showSheetProps } from "../sheetmetal/propsUi";
import { bindSmPanel, smCheck, smDraft, smPanel, SM_BASES, SM_ICONS, SM_TOOLS, SM_TREE_ICONS } from "../sheetmetal/ui";
import { isSheet, isSheetBase, type SmFlangeFeature, type SmFormFeature, type SmUnfoldFeature, type SmReliefFeature, type SmGussetFeature, type SmConvertFeature, type SmInsertFeature, type SmTabSlotFeature } from "../sheetmetal/types";
import { apply as smApply, applyDir as smApplyDir, bendOfFace, reliefCorners, crossBreakLines, flatBendLines, flatPointOn, panelOfFace, placedState, unfoldBendLines } from "../sheetmetal/sheet";
import { flatDxf } from "../sheetmetal/flat";
import { modelItems, type ModelItem } from "../drawing/items";
import { ModifyBox } from "../modifyBox";
import { checkSketch, SKETCH_USES, type CheckResult, type SketchUse } from "../sketch/check";
import { lang, onLangChange, t, withLang } from "../i18n";
import { gestureSlot, loadGestures, GESTURE_SHOW, type GestureMode } from "../gestures";
import { isLongPress } from "../longPress";
import { gestureGuide } from "../gestureUi";
import { autosaveDelay, getPref, loadPrefs, onPrefs, qualityFactor, stepFor, type Prefs } from "../prefs";

/** A drag handle in the view: an arrow, or the revolve angle grip (`ang`: centre on the axis, unit axis, radius vector at 0°). */
type DragArrow = { obj: THREE.Group; pick: THREE.Mesh; base: THREE.Vector3; dir: THREE.Vector3; scale: number; mid: boolean; key: string; label?: HTMLElement; ang?: { c: THREE.Vector3; u: THREE.Vector3; r: THREE.Vector3; arc: THREE.Line; head: THREE.Group } };

export interface ModelHost {
  viewer: Viewer;
  /** A part was saved to a file (File ▸ recent documents). */
  saved?(name: string, bytes: Uint8Array): void;
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
  setMaterial?(m: MatRef | undefined): void;
  /** The open part's length unit became the display unit (FR-UI-116). */
  setUnits?(u: PartDoc["units"]["length"]): void;
  /** Normal to the picked flat face (the view's "8"). */
  normalTo?(normal?: V3): void;
  /** A standard view by name (front, top, iso, ..., "normal", "fit"), for mouse gestures. */
  view?(name: string): void;
  /** Makes a coordinate system feature the active measurement and export frame (null: back to global); `src` is its feature id. */
  setCsys?(c: { name: string; src: string; o: V3; x: V3; z: V3 } | null, quiet?: boolean): void;
  /** Section view at the sketch plane (FR-SK-006): cuts away what lies in front of the plane; null removes it. */
  sketchSection?(plane: { o: V3; n: V3 } | null): void;
  /** Another document kind gives way (an open assembly closes). */
  leaveOthers?(): void;
  /** A part was opened or made (document tabs). */
  opened?(label: string): void;
  /** Names of the documents open in tabs, so a new part does not take one of them. */
  openNames?(): string[];
  appVersion: string;
}

type Mode =
  | { kind: "none" }
  /** Picking a sketch plane: for a new sketch, or for an existing one (`edit`: Edit sketch plane, FR-SK-007). */
  | { kind: "plane"; edit?: { id: string; plane: PlaneRef; xAxis?: SketchFeature["xAxis"]; pickX?: boolean } }
  | { kind: "sketch"; id: string; editor: SketchEditor; entry: string; isNew: boolean }
  | { kind: "feature"; draft: Feature; index: number; isNew: boolean; focus?: Focus; instant?: boolean }
  | { kind: "props"; draft: PartDoc }
  | { kind: "eq"; draft: GlobalVar[] }
  | { kind: "cfg" };

/** Which selection box of the feature panel the next click in the view fills. */
/** Features that take a Feature scope (FR-FT-007). */
type ScopedFeature = ExtrudeFeature | RevolveFeature | SweepFeature | LoftFeature | HoleFeature;
const isScoped = (f: Feature): f is ScopedFeature => f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "hole";
type Focus = "wbodies" | "wbound" | "wfaces" | "wf1" | "wf2" | "tsurf" | "ttool" | "keep" | "fs1" | "fs2" | "fc" | "main" | "bodies" | "base" | "axis" | "upto" | "start" | "origin" | "cx" | "cz" | "seeds" | "psketch" | "hupto" | "upbody" | "upto2" | "upbody2" | "mthick" | "dir" | "dir2" | "mplane" | "faces" | "hplane" | "pts" | "nplane" | "sbv" | "contours" | "skip" | "pref" | "pref2" | "scope";
type CopyFeature = MirrorFeature | LinearPatternFeature | CircularPatternFeature | SketchPatternFeature;
type BodyFeature = IntersectFeature | CombineFeature | IndentFeature | SplitBodyFeature | DeleteBodyFeature | MoveBodyFeature | ScaleFeature;
/** A fillet or chamfer has what it needs to preview: edges, or the face sets of a face fillet / full round. */
/** FR-UI-110: the panel fields shown as value callouts on the model, in this order, and the features that have handles instead. */
const VALUE_KEYS = ["thickness", "depth", "distance", "offset", "angle", "radius", "spacing", "count", "spacing2", "count2", "pitch", "height", "length", "factor"];
/** Feature values shown with its dimensions on the model (FR-UI-115): key, quantity, English label. */
const INSTANT_VALUES: [string, "length" | "angle" | "count", string][] = [
  ["angle", "angle", "Angle"], ["angle2", "angle", "Angle"], ["radius", "length", "Radius"], ["diameter", "length", "Diameter"],
  ["distance", "length", "Distance"], ["distance2", "length", "Distance"], ["thickness", "length", "Thickness"], ["depth", "length", "Depth"],
  ["offset", "length", "Offset"], ["spacing", "length", "Spacing"], ["count", "count", "Instances"], ["spacing2", "length", "Spacing"],
  ["count2", "count", "Instances"], ["pitch", "length", "Pitch"], ["height", "length", "Height"], ["length", "length", "Length"]];
/** Features with a `flip` the Modify box can reverse. */
const FLIP_TYPES = new Set(["extrude", "revolve", "plane", "moveface", "draft", "lpattern", "hole"]);
const VALUE_CALLOUT_SKIP = new Set(["extrude", "revolve", "fillet", "chamfer", "endcap", "gusset", "smflange", "sketch", "sketch3d"]);
const roundReady = (f: FilletFeature | ChamferFeature) => f.type === "fillet" && f.kind
  ? !!f.faces1?.length && !!f.faces2?.length && (f.kind !== "full" || !!f.center?.length)
  : f.type === "chamfer" && f.mode === "vertex" ? !!f.vertices?.length : f.edges.length > 0;
const isBodyOp = (f: Feature): f is BodyFeature => f.type === "intersect" || f.type === "combine" || f.type === "indent" || f.type === "bsplit" || f.type === "delbody" || f.type === "movebody" || f.type === "scale";
const isCopy = (f: Feature): f is CopyFeature => f.type === "mirror" || f.type === "lpattern" || f.type === "cpattern" || f.type === "spattern";
/** A sketch's free points (not the ends or centres of its curves): where a sketch-driven pattern puts copies. */
function freePoints(sk: Feature): { id: string; x: number; y: number }[] {
  if (sk.type !== "sketch") return [];
  const used = new Set<string>();
  for (const e of sk.ents) if (e.t !== "point") for (const k of ["a", "b", "c", "p0", "p1", "p"] as const) { const v = (e as Record<string, unknown>)[k]; if (typeof v === "string") used.add(v); }
  for (const e of sk.ents) if (e.t === "spline") for (const q of e.pts) used.add(q);
  return sk.ents.filter(e => e.t === "point" && !used.has(e.id)) as { id: string; x: number; y: number }[];
}
/** Features whose result mirror and patterns can copy. */
const SEED_TYPES = new Set(["extrude", "revolve", "mirror", "lpattern", "cpattern", "spattern", "hole"]);

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
  delete f.cbDia; delete f.cbDepth; delete f.csDia; delete f.csAngle; delete f.threadDepth; delete f.major; delete f.pitch; delete f.cdDia; delete f.cdDepth; delete f.cdAngle;
  if (f.kind === "tapped") {
    f.diameter = { v: h.tap };
    f.major = majorOf(h);
    f.pitch = h.pitch;
    f.threadDepth = { v: Math.round(f.major * 2 * 10) / 10 };
    if (f.end === "blind" && f.depth.v < f.threadDepth.v + h.pitch * 2) f.depth = { v: Math.round((f.threadDepth.v + f.major * 0.5) * 10) / 10 };
  } else f.diameter = { v: h.clear[fit] };
  if (f.kind === "cbore") { f.cbDia = { v: h.cbore[0] }; f.cbDepth = { v: h.cbore[1] }; }
  if (f.kind === "csink") { f.csDia = { v: h.csink }; f.csAngle = { v: ((h.csAng ?? 90) * Math.PI) / 180 }; }
  // Counterdrill: as wide as the screw head's counterbore, to the same depth, with a 118° bottom.
  if (f.kind === "cdrill") { f.cdDia = { v: h.cbore[0] }; f.cdDepth = { v: h.cbore[1] }; f.cdAngle = { v: (118 * Math.PI) / 180 }; }
}

const DEFAULT_COLOR: V3 = [0.72, 0.75, 0.8];
const STD_NAMES: Record<"XY" | "XZ" | "YZ", string> = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };
const ICONS: Record<string, string> = { sketch3d: "⟁", curve: "〰", sweepsurf: "⤼", helix: "∿", sweep: "⤳", loft: "⏢", rib: "⊿", split: "⊘", import: "⇩", combine: "⊕", indent: "⊔", intersect: "⧇", untrimsurf: "⬚", bsplit: "◨", delbody: "⊖", movebody: "⇲", moveface: "⇧", delface: "⌫", planesurf: "▢", extsurf: "⊓", offsurf: "⫽", knit: "⧉", thicken: "▤", replaceface: "⇄", revsurf: "◠", loftsurf: "⏥", trimsurf: "✂", fillsurf: "◈", extendsurf: "⇱", scale: "⤢", thread: "≋", hole: "◎", sketch: "✎", extrude: "▰", cut: "▱", revolve: "↻", fillet: "◜", chamfer: "◺", plane: "▭", axis: "⟋", point: "✳", csys: "⊹", shell: "◫", draft: "◿", mirror: "⧎", lpattern: "⋯", cpattern: "✲", spattern: "⁘", part: "◆", material: "▦", ...SM_TREE_ICONS };
const BASES = [...SM_BASES, "Revolve cut", "Sketch", "Extrude", "Cut", "Revolve", "Fillet", "Chamfer", "Plane", "Axis", "Point", "Coordinate system", "Shell", "Draft", "Mirror", "LPattern", "CirPattern", "Hole", "Thread", "Cut-Sweep", "Cut-Loft", "Helix", "Sweep", "Loft", "Rib", "Split Line", "Combine", "Split", "Body-Delete/Keep", "Body-Move/Copy", "Imported", "Scale", "DeleteFace", "MoveFace", "Surface-Plane", "Surface-Extrude", "Surface-Offset", "Surface-Knit", "Thicken", "ReplaceFace", "Surface-Revolve", "Surface-Loft", "Surface-Trim", "Structural Member", "Trim/Extend", "End cap", "Gusset", "Fillet Bead", "SketchPattern", "TablePattern"];

const d3v = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
/** Selection box colours (FR-SEL-011), in box order: orange, blue, green, purple (3:1 on the model grey and the background). */
const BOX_COLORS = [0xe8590c, 0x1971c2, 0x2b8a3e, 0x9c36b5];
/** Eye icons for the tree's show/hide buttons (FR-HIS-013). */
const EYE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3"/></svg>`;
const eyeButton = (hidden: boolean, name: string) => {
  const tip = hidden ? t("Show") : t("Hide");
  return `<button class="icon ft-eye${hidden ? " off" : ""}" tabindex="-1" data-a="eye" title="${esc(tip)}" aria-label="${esc(tip)}: ${esc(name)}" aria-pressed="${!hidden}">${hidden ? EYE_OFF : EYE}</button>`;
};

/** A default feature name ("Extrude2") in the interface language; renamed features stay as typed. */
export function featureLabel(name: string) {
  for (const b of BASES) { const m = name.match(new RegExp(`^${b}(\\d+)$`)); if (m) return `${t(b)}${m[1]}`; }
  return name;
}

/** The sketch editor settings from Preferences (FR-UI-080). */
function sketchPrefs(ed: SketchEditor, p: Prefs) {
  ed.modelSnap = p.modelSnap; ed.autoRels = p.autoRels; ed.showRels = p.showRels; ed.slotDims = p.slotDims; ed.addDims = p.addDims;
  ed.setGrid({ show: p.grid, snap: p.gridSnap, spacing: p.gridStep });
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

/** A part kept in a document tab while another document is shown. */
export interface PartTab { store: DocStore; fileName: string; handle: FileSystemFileHandle | null; vault: ModelController["vault"]; returnTo: ModelController["returnTo"]; context: PartContext | null; sel: string | null }

/**
 * Hole positions in the panel (FR-FT-052): on a face square to a world axis they show as the world coordinates
 * of the other two axes (a face square to Y shows X and Z), so a typed value means what the drawing says
 * whatever way the face's own sketch axes point; on any other face, the face's sketch X/Y.
 */
function holeAxes(fr: Frame | undefined): { names: string[]; show: (p: [number, number]) => [number, number]; store: (q: [number, number]) => [number, number] } {
  const plain = { names: ["X", "Y"], show: (p: [number, number]) => [p[0], p[1]] as [number, number], store: (q: [number, number]) => [q[0], q[1]] as [number, number] };
  if (!fr) return plain;
  const k = [0, 1, 2].find(a => Math.abs(Math.abs(fr.n[a]) - 1) < 1e-9);
  if (k === undefined) return plain;
  const [a, b] = [0, 1, 2].filter(x => x !== k);
  // World (a, b) = o + x·fx + y·fy restricted to the two axes; fx, fy lie in that plane.
  const m = [[fr.x[a], fr.y[a]], [fr.x[b], fr.y[b]]], det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (Math.abs(det) < 1e-12) return plain;
  const q = (x: number) => Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e9) / 1e9;
  return {
    names: ["XYZ"[a], "XYZ"[b]],
    show: p => [q(fr.o[a] + fr.x[a] * p[0] + fr.y[a] * p[1]), q(fr.o[b] + fr.x[b] * p[0] + fr.y[b] * p[1])],
    store: w => { const u = w[0] - fr.o[a], v = w[1] - fr.o[b]; return [q((u * m[1][1] - v * m[0][1]) / det), q((m[0][0] * v - m[1][0] * u) / det)]; },
  };
}

/** PropertyManager header: title with ✓ and ✕ on the right. The panel pins it (sticky), so they never scroll away. */
function okHead(title: string, o: { ok?: string; okKey?: string; cancelKey?: string; noTranslate?: boolean } = {}) {
  const ok = o.ok ?? t("OK (Enter)"), cancel = t("Cancel (Esc)");
  return `<div class="pm-head pm-top"><h3${o.noTranslate ? ' translate="no"' : ""}>${esc(title)}</h3><span class="pm-okc">`
    + `<button class="pm-ok" data-a="${o.okKey ?? "ok"}" title="${esc(ok)}" aria-label="${esc(ok)}">✓</button>`
    + `<button class="pm-cancel" data-a="${o.cancelKey ?? "cancel"}" title="${esc(cancel)}" aria-label="${esc(cancel)}">✕</button></span></div>`;
}

/**
 * Recognised sketches come back dimensioned, as FeatureWorks gives them (FR-FT-102): Fully define sketch
 * (FR-SK-045) adds horizontal/vertical relations, diameters/radii and dimensions from the sketch origin.
 */
function defineRecognised(feats: Feature[]) {
  feats.forEach((f, i) => {
    if (f.type !== "sketch") return;
    try { feats[i] = fullyDefineSketch(f, { sizes: true }).sketch; } catch { /* keep it as found */ }
  });
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
  vault: VaultTie | null = null;

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
  editIn(doc: PartDoc, fileName: string, ret: { label: string; back(doc: PartDoc): void }, ctx?: PartContext) {
    this.load(doc, fileName, null);
    this.store!.markSaved();
    this.returnTo = ret;
    this.setContext(ctx ?? null);
    this.renderReturnBar();
  }

  /**
   * Edit in context (FR-ASM-030): the assembly around the part, drawn see-through in the part's own
   * coordinates. Its flat faces take sketches (external references, `{ ctx }` planes).
   */
  private context: PartContext | null = null;
  private ctxView = new THREE.Group();

  private setContext(ctx: PartContext | null) {
    this.context = ctx;
    for (const o of this.ctxView.children) { const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.ctxView.clear();
    if (!ctx) { this.host.viewer.invalidate(); return; }
    if (!this.ctxView.parent) this.host.viewer.scene.add(this.ctxView);
    const inv = tfInvert(ctx.tf), e = inv;
    const mat = new THREE.Matrix4().set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
    for (const c of ctx.comps) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(c.positions, 3));
      g.setIndex(new THREE.BufferAttribute(c.index, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8c99a6, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
      m.matrixAutoUpdate = false;
      m.matrix.copy(mat);
      m.userData.ctx = c;
      m.renderOrder = 2;
      this.ctxView.add(m);
    }
    this.ctxView.updateMatrixWorld(true);
    this.host.viewer.invalidate();
  }

  /** A flat face of a context component under the pointer, as an external reference, and how far it is. */
  private ctxAt(x: number, y: number): { ref: PlaneRef | null; dist: number } | null {
    if (!this.context || !this.ctxView.children.length) return null;
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), v.camera);
    const hit = rc.intersectObjects(this.ctxView.children, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const c = hit.object.userData.ctx as PartContext["comps"][number];
    const face = c.faces.find(f => hit.faceIndex! >= f.triStart && hit.faceIndex! < f.triStart + f.triCount);
    if (!face?.plane || !face.name) return { ref: null, dist: hit.distance };
    const inv = tfInvert(this.context.tf);
    const ref = { ctx: { comp: c.comp, face: face.name, host: this.context.host, label: c.label, p: tfPoint(inv, face.plane.p), n: tfDir(inv, face.plane.n) } };
    return { ref, dist: hit.distance };
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
    this.setContext(null);
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
    bar.innerHTML = `<span>${esc(this.context ? t("Editing a part in the context of {asm}", { asm: this.returnTo.label }) : t("Editing a part of {asm}", { asm: this.returnTo.label }))}</span><button class="btn small primary" data-a="ret">${esc(t("Return to assembly"))}</button>`;
    bar.querySelector("button")!.addEventListener("click", () => this.returnToAssembly());
  }

  /** Marks the open part saved (the vault wrote it). */
  markSaved() { if (!this.store) return; this.store.markSaved(); journalDrop(this.doc.id); }
  private selected: string | null = null;
  private journalTimer = 0;
  private shownOnce = false;
  private decor = new THREE.Group();
  /** Hover link (FR-UI-061): the feature whose faces are lit because the pointer is on its tree row or on one of its faces. */
  private hoverGroup = new THREE.Group();
  /** The sketch region under the pointer while Selected Contours has focus, and its index (-1 none, -2 = redraw). */
  private ctHoverGroup = new THREE.Group();
  private ctHover = -1;
  private hoverId: string | null = null;
  private hoverFrom: "tree" | "view" | null = null;
  private hoverRaf = 0;
  private planeMeshes: THREE.Mesh[] = [];
  private lineMats: LineMaterial[] = [];
  private down: { x: number; y: number } | null = null;
  private busyCount = 0;
  private rebuildMs = 0;
  /** Undo mark taken when a sketch was opened: leaving it merges its steps (FR-UND-003). */
  private sketchMark = 0;
  /** The depth arrow of an extrude (FR-FT-017): its mesh, and the drag in progress. */
  /** Drag handle: the extrude depth arrow, or the revolve angle handle (`ang` set: centre on the axis, unit axis, radius vector at 0°). */
  /** `key`: the feature's number it drags; `label`: its value button. Several may show (gusset legs); `arrow` is the one in use. */
  private arrow: DragArrow | null = null;
  private arrows: DragArrow[] = [];
  private arrowDrag: { start: number; depth: number; moved: boolean; raw?: number; key?: string } | null = null;

  constructor(private host: ModelHost, occtBase: string) {
    this.kernel = new ModelKernel(occtBase);
    document.getElementById("ft-search")?.addEventListener("input", () => this.renderTree());
    this.kernel.onCrash = () => toast(t("The geometry kernel stopped; it was restarted."), "warn");
    host.viewer.scene.add(this.decor);
    host.viewer.scene.add(this.hoverGroup, this.ctHoverGroup);
    this.ghostGroup.visible = false;
    host.viewer.scene.add(this.ghostGroup);
    this.bindHover();
    // Preferences (FR-UI-080): an open sketch takes the new sketch settings; quality and verification rebuild.
    onPrefs((p, changed) => {
      const m = this.mode;
      if (m.kind === "sketch") {
        const ed = m.editor;
        sketchPrefs(ed, p);
        const pm = document.getElementById("mc-pm");
        const box = (a: string, v: boolean) => { const i = pm?.querySelector<HTMLInputElement>(`[data-a=${a}]`); if (i) i.checked = v; };
        box("grid", ed.grid); box("gridsnap", ed.gridSnap); box("autorels", ed.autoRels); box("showrels", ed.showRels); box("slotdims", ed.slotDims); box("adddims", ed.addDims); box("modelsnap", ed.modelSnap);
        const gs = pm?.querySelector<HTMLInputElement>("[data-a=gridstep]");
        if (gs) gs.value = ed.gridSpacing ? String(ed.gridSpacing) : "";
        ed.render();
        this.renderQuick();
      }
      if (this.store && (changed.includes("quality") || changed.includes("verify"))) void this.rebuild();
    });
    onCmTab(() => { if (this.store && !this.inBar) { this.renderBar(); } });
    matchMedia("(max-width: 767px)").addEventListener("change", () => this.syncFlyTree());
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
  /** The open part and its file name (null when no part is open). */
  openPart() { return this.store ? { doc: this.store.doc, fileName: this.fileName } : null; }

  // ---------- opening and closing ----------

  /** Starts a new, empty part. */
  newPart(base?: string) {
    let n = 1;
    const used = new Set([...journalList().map(j => j.doc.name), ...(this.host.openNames?.() ?? [])]);
    const name = (k: number) => (base ? (k === 1 ? base : `${base} ${k}`) : `Part${k}`);
    while (used.has(name(n))) n++;
    const doc = newPart(name(n));
    this.load(doc, "", null);
    this.warm();
    // The tutorial (FR-HLP-003) names its part and gives the directions itself.
    if (!base) toast(t("New part: click Sketch, pick a plane and draw a closed profile, then Extrude."));
    return doc.id;
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

  /** Document tabs (FR-DOC-003): the open part with its undo history, kept while another document is shown. */
  park(): PartTab | null {
    if (!this.store) return null;
    if (this.mode.kind === "sketch") this.ok();
    else if (this.mode.kind !== "none") this.exitMode(false);
    const tab: PartTab = { store: this.store, fileName: this.fileName, handle: this.handle, vault: this.vault, returnTo: this.returnTo, context: this.context, sel: this.selected };
    this.close();
    return tab;
  }

  /** Shows a parked part again, history and all. */
  resume(tab: PartTab) {
    this.load(tab.store.doc, tab.fileName, tab.handle, tab.store);
    this.vault = tab.vault;
    this.renderVaultBar();
    this.returnTo = tab.returnTo;
    this.setContext(tab.context);
    this.renderReturnBar();
    this.host.setDoc(this.docLabel());
    // The row that was selected when the tab was left (FR-DOC-003).
    if (tab.sel && (tab.sel.includes(":") || this.store?.feature(tab.sel))) { this.selected = tab.sel; this.renderTree(); this.drawDecor(); }
  }

  /** Whether the part has unsaved changes. */
  get dirty() { return !!this.store?.dirty; }

  private load(doc: PartDoc, fileName: string, handle: FileSystemFileHandle | null, keep?: DocStore) {
    this.host.leaveOthers?.();
    this.exitMode(false);
    this.vault = null;
    this.renderVaultBar();
    this.returnTo = null;
    this.renderReturnBar();
    this.setContext(null);
    this.setContext(null);
    this.fileName = fileName;
    this.handle = handle;
    this.selected = null;
    this.shownOnce = false;
    this.last = null;
    // A parked part keeps its own store (its undo history); a new document gets a fresh one, so a parked store is never reused.
    if (keep) this.store = keep;
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
    // A part saved rolled back reopens rolled back, with a notice (FR-HIS-012); a parked tab keeps its own state.
    if (!keep) { this.rollNotice = doc.rollback != null; this.rollPrev = undefined; this.closedFeats.clear(); }
    this.clearGhosts();
    document.getElementById("app")!.classList.add("model");
    // The start card goes at once, not when the kernel's first rebuild comes back (that can take seconds).
    $("#empty").hidden = true;
    this.host.viewer.emptySize = 50;
    $("#t-features").hidden = false;
    this.host.selectLeftTab("features");
    this.host.setMaterial?.(doc.material);
    // The part's units are the display units while it is open (FR-UI-116).
    if (doc.units.length !== units.current) this.host.setUnits?.(doc.units.length);
    this.renderAll();
    this.host.opened?.(this.docLabel());
    if (!doc.features.length) {
      // A new part needs no kernel to show: the origin and the three planes go up at once (the kernel
      // still loads in the background for the first feature).
      this.shownOnce = true;
      this.host.show(null, doc.name, true);
      this.host.setDoc(this.docLabel());
      this.host.viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
      this.drawDecor();
    }
    void this.rebuild();
  }

  /** Another file was opened in the viewer: leave modelling (the journal keeps unsaved work). */
  close() {
    if (!this.store) return;
    this.exitMode(false);
    if (this.store.dirty) journalSave(this.doc, this.fileName);
    if (csys.active?.src) this.host.setCsys?.(null, true);
    this.store = null;
    this.selected = null;
    // Hide the part bar and the empty-part card, or they show through in the assembly after New assembly.
    $("#mc-bar").hidden = true;
    $("#mc-confirm").hidden = true;
    document.getElementById("mc-crumbs")?.remove();
    this.syncFlyTree();
    this.renderEmpty();
    this.renderQuick();
    this.vault = null;
    this.renderVaultBar();
    this.returnTo = null;
    this.renderReturnBar();
    this.instant = null;
    this.instantDoc = null;
    this.last = null;
    this.clearDecor();
    this.hoverId = null; this.drawHover();
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
    if (this.doc.units.length !== units.current) this.host.setUnits?.(this.doc.units.length);
    if (why !== "saved" && why !== "open") {
      clearTimeout(this.journalTimer);
      const wait = autosaveDelay();
      if (wait !== null) this.journalTimer = window.setTimeout(() => { if (this.store?.dirty) journalSave(this.doc, this.fileName); }, wait);
    }
  }

  private docLabel() { return `${this.displayName()}${this.vault ? ` · ${this.vault.label}` : ""}${this.store?.dirty ? " •" : ""}`; }

  /** The document as shown: with the open command's draft, rolled back while a sketch or a pick is open. */
  private displayDoc(): PartDoc {
    const m = this.mode;
    // A value typed in the Modify box of a feature dimension, rebuilt before it is accepted (FR-UI-115).
    if (m.kind === "none" && this.instantDoc) return structuredClone(this.instantDoc);
    const d: PartDoc = structuredClone(this.doc);
    if (m.kind === "sketch") {
      const i = d.features.findIndex(f => f.id === m.id);
      d.rollback = i + 1;
    } else if (m.kind === "plane" && m.edit) {
      // Edit sketch plane: rolled back to the sketch, which shows on the plane picked so far.
      const i = d.features.findIndex(f => f.id === m.edit!.id);
      const sk = d.features[i];
      if (sk?.type === "sketch") {
        sk.plane = m.edit.plane; sk.hidden = false; d.rollback = i + 1;
        if (m.edit.xAxis) sk.xAxis = m.edit.xAxis; else delete sk.xAxis;
      }
    } else if (m.kind === "feature") {
      const f = structuredClone(m.draft);
      if (m.isNew) d.features.splice(m.index, 0, f); else d.features[m.index] = f;
      // Fillet and chamfer pick edges on the body before them; extrude, revolve and planes preview live.
      d.rollback = f.type === "fillet" || f.type === "chamfer" || f.type === "smconvert" || f.type === "sminsert" ? m.index : m.index + 1;
    } else if (m.kind === "props") d.color = m.draft.color;
    return d;
  }

  private async rebuild() {
    if (!this.store) return;
    this.noteDraft();
    const doc = this.displayDoc();
    // An empty part has nothing to build: no busy sign while the kernel loads behind it.
    const quiet = !doc.features.length;
    if (!quiet) this.setBusy(1);
    const m = this.mode;
    const d = m.kind === "feature" ? m.draft : null;
    const previewAt = m.kind === "feature" && d && (((d.type === "fillet" || d.type === "chamfer") && roundReady(d)) || ((d.type === "smconvert" || d.type === "sminsert") && !!d.face.name) || ((d.type === "extrude" || d.type === "revolve" || d.type === "sweep" || d.type === "loft") && d.op === "cut")) ? m.index : undefined;
    const r = await this.kernel.rebuild(doc, doc.color ?? DEFAULT_COLOR, qualityFactor(getPref("quality")), previewAt, getPref("verify"));
    if (!quiet) this.setBusy(-1);
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
        if (e?.t === "point") pts.add(e.id);
        else if (e?.t === "line") { pts.add(e.a); pts.add(e.b); }
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

  /** The features Ctrl+C took (FR-HIS-014); kept for this window only, like SolidWorks' clipboard. */
  private clip: Clip | null = null;

  /** Ctrl+C on the selected tree row: a sketch, an extrude or revolve (with its sketch) or a hole. */
  copyFeature(id = this.selected, quiet = false): boolean {
    const f = id ? this.store?.feature(id) : undefined;
    if (!this.store || !f || !canCopy(f)) return false;
    this.clip = copyClip(this.doc, f.id);
    if (this.clip && !quiet) toast(t("Copied {name}: select a plane or a flat face and press Ctrl+V.", { name: featureLabel(f.name) }));
    return !!this.clip;
  }

  /** The plane a paste or a new sketch goes on: the picked flat face, else the selected plane in the tree. */
  private targetPlane(): PlaneRef | null {
    const cp = this.ctxPick?.plane;
    if (cp) return cp;
    const fid = this.pickedFace();
    if (fid != null) return this.planeOfFace(fid);
    if (this.selected?.startsWith("std:")) return { std: this.selected.slice(4) as "XY" };
    const pl = this.selected ? this.store?.feature(this.selected) : undefined;
    return pl?.type === "plane" && !pl.suppressed ? { plane: pl.id } : null;
  }

  /** Ctrl+V: the copied features on the selected plane or face, as one undo step (FR-HIS-014). */
  pasteFeature(plane: PlaneRef | null = this.targetPlane()) {
    if (!this.store || !this.clip) return;
    if (this.isFrozen(this.doc.features[(this.doc.rollback ?? this.doc.features.length) - 1]?.id ?? "")) { this.frozenToast(); return; }
    if (!plane) { toast(t("Select a plane or a flat face to paste on."), true); return; }
    const { feats, lost } = pasteClip(this.doc, this.clip, plane);
    this.store.change("Paste", d => {
      const at = d.rollback ?? d.features.length;
      d.features.splice(at, 0, ...feats);
      if (d.rollback != null) d.rollback += feats.length;
    });
    this.selected = feats[feats.length - 1].id;
    this.ctxPick = null;
    this.host.clearPick();
    this.renderTree();
    toast(lost.length ? t("Pasted. References that could not follow: {list}", { list: lost.map(x => t(x)).join("; ") }) : t("Pasted {name}.", { name: featureLabel(feats[feats.length - 1].name) }), lost.length > 0);
  }

  /** Sketch: on the picked flat face or the selected plane; otherwise asks for one. */
  startSketch() {
    if (!this.store) return;
    this.exitMode(false);
    const cp = this.ctxPick?.plane;
    if (cp && "ctx" in cp) { void this.createSketch(cp); return; }
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
    if (face.type !== "plane") { toast(t("Pick a flat face or a plane: this one is curved."), true); return null; }
    return { face: { name, hint: face.centroid }, ax: 1 };
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
      modelEdge: e => {
        // The edge under the pointer, then every edge that ends or is centred at the snapped point (a vertex
        // snap may name an edge square to the sketch, which projects to nothing).
        const out: EdgeInfo[] = [];
        const hit = this.host.edgeAt(e.clientX, e.clientY);
        if (hit?.edge) out.push(hit.edge);
        const sp = this.host.snapAt?.(e.clientX, e.clientY), data = this.host.viewer.parts[0]?.data;
        if (sp && data) {
          const near = (q?: V3) => !!q && Math.hypot(q[0] - sp.point[0], q[1] - sp.point[1], q[2] - sp.point[2]) < 1e-4 * (1 + Math.hypot(...sp.point));
          for (const x of data.edges) if (!out.includes(x) && (near(x.start) || near(x.end) || near(x.center) || near(x.mid))) out.push(x);
        }
        return out;
      },
      renamedDim: (from, to) => this.store!.change("Rename dimension", d => renameEverywhere(d, from, to)),
    }, sk, this.frameOf(sk));
    sketchPrefs(editor, loadPrefs());
    try { editor.snaps = parseSnaps(localStorage.getItem("mc:skSnaps")); } catch { /* private mode */ }
    editor.onQuickSnap = () => this.renderQuick();
    this.mode = { kind: "sketch", id, editor, entry, isNew };
    document.getElementById("app")!.classList.add("sketching");
    this.renderAll();
    editor.statusHint();
    await this.rebuild();
    const m = this.mode as Mode;
    if (m.kind === "sketch" && m.id === id) {
      const f = this.frameOf(sk);
      m.editor.setSketch(this.store!.feature(id) as SketchFeature, f);
      // Normal to the sketch, framing the model and the whole sketch, which may reach past the body (exam #96).
      if (getPref("rotateToSketch")) this.host.viewer.viewFrom(new THREE.Vector3(...f.n), true, m.editor.sketchBox());
    }
  }

  /** Extrude / Cut / Revolve / Fillet / Chamfer: opens the property panel with a draft. */
  startFeature(type: "extrude" | "cut" | "revolve" | "fillet" | "chamfer" | "plane" | "axis" | "point" | "csys" | "shell" | "draft" | "mirror" | "lpattern" | "cpattern" | "spattern" | "tpattern" | "hole" | "thread" | "helix" | "sweep" | "sweepcut" | "loft" | "loftcut" | "rib" | "split" | "combine" | "indent" | "intersect" | "bsplit" | "delbody" | "movebody" | "scale" | "delface" | "moveface" | "heal" | "smbase" | "smloft" | "smflange" | "smhem" | "smbend" | "smjog" | "smcorner" | "smclosed" | "smrelief" | "smgusset" | "smcross" | "smvent" | "smcut" | "smconvert" | "sminsert" | "smform" | "smunfold" | "smfold" | "smmiter" | "smswept" | "smtabslot" | "smrip" | CurveTool | SurfTool | WeldTool) {
    if (!this.store) return;
    // Starting a feature from inside a sketch exits the sketch and uses it (FR-SK-004).
    const fromSketch = this.mode.kind === "sketch" ? this.mode.id : null;
    if (fromSketch) { this.ok(); this.selected = fromSketch; }
    // Pre-selected edges for fillet and chamfer (FR-SEL-006): the edge picked with Smart measure.
    const selEdge = (type === "fillet" || type === "chamfer") ? this.pickedEdge() : null;
    const threadEdge = type === "thread" ? this.pickedEdge() : null;
    const smEdge = type === "smflange" || type === "smhem" || type === "smcorner" || type === "smmiter" || type === "smswept" || type === "smtabslot" || type === "smrip" ? this.pickedEdge() : null;
    const pre = selEdge ? this.refOfEdge(selEdge) : null;
    const preFace = type === "plane" ? this.pickedFace() : null;
    // Axis and point take a picked edge or face too.
    const refEdge = type === "axis" || type === "point" ? this.pickedEdge() : null;
    const refFace = type === "axis" || type === "point" ? this.pickedFace() : null;
    const csysEdge = type === "csys" ? this.pickedEdge() : null;
    const shellFace = type === "shell" || type === "hole" || type === "draft" || type === "delface" || type === "moveface" || type === "offsurf" || type === "knit" || type === "thicken" || type === "replaceface" || type === "trimsurf" || type === "fillsurf" || type === "extendsurf" || type === "untrimsurf" ? this.pickedFace() : null;
    const weldFace = WELD_TOOL_SET.has(type) ? this.pickedFace() : null;
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
      // A cut goes against the sketch normal, which suits a sketch on a face. From a plane beside the part that may
      // point away from it and cut nothing: when the whole body lies on the normal's side, start reversed (exam #24).
      if (cut && this.last?.data && this.host.viewer.parts.length) {
        const fr = this.frameOf(pick), b = this.host.viewer.computeBounds(), tol = 1e-6 * Math.max(1, b.getSize(new THREE.Vector3()).length());
        let lo = Infinity;
        for (let i = 0; i < 8; i++) lo = Math.min(lo, ((i & 1 ? b.max.x : b.min.x) - fr.o[0]) * fr.n[0] + ((i & 2 ? b.max.y : b.min.y) - fr.o[1]) * fr.n[1] + ((i & 4 ? b.max.z : b.min.z) - fr.o[2]) * fr.n[2]);
        if (lo > -tol && !b.isEmpty()) (draft as ExtrudeFeature).flip = true;
      }
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
    } else if (type === "heal") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      draft = { id, type: "heal", name: nextName(d, "heal"), tol: { v: 0.01 } } satisfies HealFeature;
    } else if (type === "combine" || type === "indent" || type === "intersect" || type === "bsplit" || type === "delbody" || type === "movebody" || type === "scale") {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      const nm = nextName(d, type);
      draft = type === "intersect" ? { id, type, name: nm, bodies: [], exclude: [] } satisfies IntersectFeature
        : type === "combine" ? { id, type, name: nm, op: "add", tools: [] } satisfies CombineFeature
        : type === "indent" ? { id, type, name: nm, tools: [], thickness: { v: 2 }, clearance: { v: 0 } } satisfies IndentFeature
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
    } else if (type === "smbase" || type === "smloft" || type === "smflange" || type === "smhem" || type === "smbend" || type === "smjog" || type === "smcorner" || type === "smclosed" || type === "smrelief" || type === "smgusset" || type === "smcross" || type === "smvent" || type === "smcut" || type === "smconvert" || type === "sminsert" || type === "smform" || type === "smunfold" || type === "smfold" || type === "smmiter" || type === "smswept" || type === "smtabslot" || type === "smrip") {
      // Sheet metal (FR-FT-120): src/sheetmetal/ui.ts makes the draft.
      const smFace = type === "smtabslot" || type === "smconvert" || type === "sminsert" || type === "smclosed" || type === "smgusset" || type === "smcross" || type === "smform" || type === "smunfold" || type === "smfold" ? this.pickedFace() : null;
      const sm = smDraft(type, { id, doc: d, sketches, used, selected: this.selected, name: ty => nextName(d, ty), edge: smEdge ? this.refOfEdge(smEdge) : null, face: smFace != null ? this.faceRef(smFace) : null, hasBody: !!this.last?.data, sheet: this.last?.sheet });
      if (typeof sm === "string") { toast(sm, true); return; }
      draft = sm;
    } else if (type === "sketch3d") {
      draft = { id, type: "sketch3d", name: nextName(d, "sketch3d"), pts: [], segs: [], rels: [], dims: [] } satisfies Sketch3dFeature;
      this.sk3 = { id, tool: "line", plane: "XY", anchor: null, spline: null, sel: [] };
    } else if (type === "xyzcurve" || type === "compcurve" || type === "projcurve") {
      const cf: CurveFeature = { id, type: "curve", name: nextName(d, "curve"), kind: type === "xyzcurve" ? "xyz" : type === "compcurve" ? "composite" : "projected" };
      if (cf.kind === "xyz") cf.pts = [[0, 0, 0], [20, 10, 20], [40, 0, 40]];
      else if (cf.kind === "composite") {
        if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
        const ed = this.pickedEdge(), r = ed ? this.refOfEdge(ed) : null;
        cf.edges = r ? [r] : [];
      } else {
        if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
        // The selected sketch with one chain of curves, else the last unused one.
        const chain = (s: SketchFeature) => !sketchPath(s).error;
        const sel = this.selected ? sketches.find(s => s.id === this.selected && chain(s)) : undefined;
        const sk = sel ?? sketches.filter(s => !used.has(s.id) && !d.features.some(g => absorbs(g, s.id)) && chain(s)).at(-1);
        cf.sketch = sk?.id ?? ""; cf.faces = [];
      }
      draft = cf;
    } else if (type === "helix" || type === "sweep" || type === "sweepcut" || type === "loft" || type === "loftcut") {
      const p3 = this.p3Draft(type, id, sketches, used);
      if (!p3) return;
      draft = p3;
    } else if (WELD_TOOL_SET.has(type)) {
      // Weldments (FR-FT-121).
      const wf = weldDraft(this.weldCtx(end), type as WeldTool, id, nextName(d, type as WeldTool), weldFace);
      if (!wf) return;
      draft = wf;
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
    } else if (type === "shell" || type === "mirror" || type === "lpattern" || type === "cpattern" || type === "spattern" || type === "tpattern" || type === "delface" || type === "moveface") {
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
      else if (type === "spattern" || type === "tpattern") {
        // Sketch-driven: the last sketch with free points; table-driven: two rows to start from.
        const sk = type === "spattern" ? [...d.features.slice(0, end)].reverse().find(x => x.type === "sketch" && freePoints(x).length) : undefined;
        draft = type === "spattern" ? { id, type: "spattern", name: nextName(d, "spattern"), features: seeds, src: "sketch", ...(sk ? { sketch: sk.id } : {}) } satisfies SketchPatternFeature
          : { id, type: "spattern", name: nextName(d, "spattern").replace("SketchPattern", "TablePattern"), features: seeds, src: "table", table: [{ x: { v: 20 }, y: { v: 0 } }, { x: { v: 40 }, y: { v: 0 } }] } satisfies SketchPatternFeature;
      }
      else draft = { id, type: "cpattern", name: nextName(d, "cpattern"), features: seeds, count: 4, angle: { v: 2 * Math.PI }, equal: true } satisfies CircularPatternFeature;
    } else {
      if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
      draft = type === "fillet"
        ? { id, type: "fillet", name: nextName(d, "fillet"), radius: { v: 2 }, edges: [] } satisfies FilletFeature
        : { id, type: "chamfer", name: nextName(d, "chamfer"), distance: { v: 1 }, edges: [] } satisfies ChamferFeature;
      if (pre) (draft as FilletFeature).edges = [pre];
    }
    this.recallOptions(type, draft);
    // The flat pattern stays last (SolidWorks): new features go in before it.
    const index = d.features[end - 1]?.type === "smflat" ? end - 1 : end;
    const focus: Focus | undefined = type === "plane" ? "base" : type === "shell" || type === "delface" || type === "moveface" || type === "offsurf" ? "faces" : type === "trimsurf" ? ((draft as TrimSurfFeature).surface ? "ttool" : "tsurf") : type === "draft" ? ((draft as DraftFeature).plane ? "faces" : "nplane") : type === "hole" ? ((draft as HoleFeature).plane ? "pts" : "hplane")
      : type === "mirror" ? ((draft as MirrorFeature).features.length ? "mplane" : "seeds")
      : type === "lpattern" || type === "cpattern" ? ((draft as CopyFeature).features.length ? "dir" : "seeds")
      : type === "spattern" ? ((draft as SketchPatternFeature).sketch || (draft as CopyFeature).features.length ? "seeds" : "psketch")
      : type === "tpattern" ? "seeds"
      : type === "csys" ? ((draft as CsysFeature).origin ? "cz" : "origin")
      : type === "combine" || type === "indent" ? "main" : type === "bsplit" ? "mplane" : type === "delbody" || type === "movebody" || type === "scale" || type === "intersect" ? "bodies"
      : WELD_TOOL_SET.has(type) ? weldFocus(draft) as Focus | undefined : undefined;
    this.mode = { kind: "feature", draft, index, isNew: true, focus: this.openFocus(draft, focus) };
    this.flowWas.set(this.mode, this.boxFlow(draft).filter(b => b.filled).map(b => b.focus).join(","));
    this.host.clearPick();
    this.renderAll();
    if (draft.type === "extrude" || draft.type === "revolve") {
      // The cursor starts in Depth (or Angle), so a typed size goes there (SolidWorks; exam #7).
      const inp = $("#mc-pm").querySelector<HTMLInputElement>("input[data-num=depth], input[data-num=angle]");
      if (inp) { inp.focus(); inp.select(); }
      // Seen straight on, an extrude shows no depth: turn to the three-quarter view on the sketch's side (exam #8).
      const sk = draft.type === "extrude" ? this.store.feature(draft.sketch) : undefined;
      if (sk?.type === "sketch" && getPref("rotateToSketch")) {
        const n = new THREE.Vector3(...this.frameOf(sk).n), v = this.host.viewer, look = v.camera.position.clone().sub(v.controls.target).normalize();
        if (Math.abs(look.dot(n)) > 0.985) {
          let best = new THREE.Vector3(1, -1, 0.8), top = -Infinity;
          for (const z of [0.8, -0.8]) for (const [x, y] of [[1, -1], [-1, -1], [1, 1], [-1, 1]]) {
            const c = new THREE.Vector3(x, y, z), d = c.clone().normalize().dot(n) * Math.sign(look.dot(n) || 1);
            if (d > top + 1e-9) { top = d; best = c; }
          }
          v.viewFrom(best);
        }
      }
    }
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
    // The last helix or 3D curve is the likely path (FR-FT-083/085).
    const helix = d.features.slice(0, end).filter(f => (f.type === "helix" || f.type === "curve" || f.type === "sketch3d") && !f.suppressed).at(-1);
    const profile = (sel && closed(sel) ? sel : null) ?? free.filter(closed).at(-1);
    const pathSk = free.filter(s => s !== profile && !closed(s)).at(-1);
    const sw: SweepFeature = { id, type: "sweep", name: nextName(d, "sweep", cut), op: cut ? "cut" : "boss" };
    if (helix) sw.path = helix.type === "helix" ? { helix: helix.id } : { curve: helix.id }; else if (pathSk) sw.path = { sketch: pathSk.id };
    if (profile && !(helix?.type === "helix" && profile.id === helix.sketch)) sw.profile = profile.id; else sw.circular = { v: 2 };
    return sw;
  }

  editFeature(id: string) {
    const i = this.doc.features.findIndex(f => f.id === id);
    const f = this.doc.features[i];
    if (!f) return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    if (f.type === "sketch") { void this.editSketch(id); return; }
    this.exitMode(false);
    const draft = structuredClone(f);
    this.mode = { kind: "feature", draft, index: i, isNew: false, focus: this.openFocus(draft, undefined) };
    if (!this.mode.focus) delete this.mode.focus;
    this.flowWas.set(this.mode, this.boxFlow(draft).filter(b => b.filled).map(b => b.focus).join(","));
    this.host.clearPick();
    this.renderAll();
    void this.rebuild();
  }

  /** ✓: keeps the sketch or the feature. */
  ok(repeat = false) {
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
      const { id, plane, xAxis } = m.edit;
      this.mode = { kind: "none" };
      this.store!.change("Edit sketch plane", d => {
        const f = d.features.find(x => x.id === id);
        if (f?.type !== "sketch") return;
        f.plane = plane;
        if (xAxis) f.xAxis = xAxis; else delete f.xAxis;
      });
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
    if ((f.type === "fillet" || f.type === "chamfer") && !roundReady(f)) { toast(t(f.type === "fillet" && f.kind === "full" ? "Pick side face set 1, the centre face set and side face set 2." : f.type === "fillet" && f.kind === "face" ? "Pick the faces of face set 1 and face set 2." : f.type === "chamfer" && f.mode === "vertex" ? "Pick at least one vertex." : "Pick at least one edge."), true); return; }
    if (f.type === "revolve" && !f.axis) { toast(t("Pick a line of the sketch as the axis."), true); return; }
    if (f.type === "revolve" && f.end === "upto" && !f.upTo) { toast(t("Pick the face or plane the revolve goes up to."), true); return; }
    if (f.type === "extrude" && (f.end === "upto" || f.end === "offset") && !f.upTo) { toast(t("Pick the face or plane the extrusion goes up to."), true); return; }
    if (f.type === "extrude" && f.end === "vertex" && !f.upToVertex) { toast(t("Pick the vertex the extrusion goes up to."), true); return; }
    if (f.type === "extrude" && ((f.start === "surface" && !f.startRef) || (f.start === "vertex" && !f.startVertex))) { toast(t("Pick where the extrusion starts."), true); return; }
    if (f.type === "plane" && f.mode === "angle" && !f.axis && !f.about) { toast(t("Pick a straight edge to turn the plane about."), true); return; }
    if (f.type === "axis" && !(f.mode === "edge" ? f.edge : f.mode === "cylinder" ? f.face : (f.planes?.length ?? 0) >= 2)) { toast(t(f.mode === "planes" ? "Pick two planes or flat faces." : f.mode === "edge" ? "Pick a straight edge." : "Pick a cylindrical or conical face."), true); return; }
    if (f.type === "thread" && !f.edge) { toast(t("Pick a round edge of a cylinder."), true); return; }
    if (f.type === "hole" && f.end === "upto" && !f.upTo) { toast(t("Pick the face or plane the hole goes up to."), true); return; }
    if (f.type === "extrude" && f.end === "body" && !f.upToBody) { toast(t("Pick the body the extrusion goes up to."), true); return; }
    if (f.type === "extrude" && dir2Apart(f)) {
      const e2 = f.end2;
      if ((e2 === "upto" || e2 === "offset") && !f.upTo2) { toast(t("Pick the face or plane direction 2 goes up to."), true); return; }
      if (e2 === "vertex" && !f.upToVertex2) { toast(t("Pick the vertex direction 2 goes up to."), true); return; }
      if (e2 === "body" && !f.upToBody2) { toast(t("Pick the body direction 2 goes up to."), true); return; }
    }
    if (f.type === "hole" && (!f.plane || !f.pts.length)) { toast(t(f.plane ? "Click on the face to place the holes." : "Pick a flat face or a plane for the holes."), true); return; }
    if (f.type === "mirror" && !f.plane) { toast(t("Pick a plane or a flat face to mirror about."), true); return; }
    if ((f.type === "lpattern" || f.type === "cpattern" || f.type === "spattern") && (f.copy ?? "features") === "features" && !f.features.length) { toast(t("Pick the features to copy."), true); return; }
    if (isCopy(f) && f.copy === "faces" && !f.faces?.length) { toast(t("Pick the faces to copy."), true); return; }
    if (isCopy(f) && f.copy === "bodies" && !f.bodies?.length) { toast(t("Pick the bodies to copy."), true); return; }
    if (f.type === "spattern" && f.src === "sketch" && !f.sketch) { toast(t("Pick a sketch with points."), true); return; }
    if (f.type === "spattern" && f.src === "table" && !f.table?.length) { toast(t("Add table rows with offsets other than 0, 0."), true); return; }
    if (f.type === "lpattern" && !f.dir) { toast(t("Pick a direction: an edge, a face or an axis."), true); return; }
    if (f.type === "cpattern" && !f.axis) { toast(t("Pick an axis: a round edge or face, a straight edge or a reference axis."), true); return; }
    if ((f.type === "sweep" || f.type === "sweepsurf") && !f.path) { toast(t("Pick a path: a sketch, a helix or a curve."), true); return; }
    if (f.type === "sweepsurf" && !f.profile) { toast(t("Pick a profile sketch."), true); return; }
    if (f.type === "sketch3d" && !f.segs.length) { toast(t("Draw at least one line or spline."), true); return; }
    if (f.type === "curve" && f.kind === "xyz" && (f.pts?.length ?? 0) < 2) { toast(t("A curve needs at least two different points."), true); return; }
    if (f.type === "curve" && f.kind === "composite" && !f.edges?.length) { toast(t("Pick the edges to join."), true); return; }
    if (f.type === "curve" && f.kind === "projected" && !f.sketch) { toast(t("Pick a sketch to project."), true); return; }
    if (f.type === "sweep" && !f.profile && !f.circular) { toast(t("Pick a profile sketch, or use a circular profile."), true); return; }
    if (f.type === "combine" && (!f.main || !f.tools.length)) { toast(t("Pick the main body and at least one other body."), true); return; }
    if (f.type === "indent" && (!f.main || !f.tools.length)) { toast(t("Pick the target body and at least one tool body."), true); return; }
    if (f.type === "bsplit" && !f.plane) { toast(t("Pick a plane or a flat face to split with."), true); return; }
    if ((f.type === "delbody" || f.type === "movebody") && !f.bodies.length) { toast(t("Pick the bodies."), true); return; }
    if ((f.type === "delface" || f.type === "moveface") && !f.faces.length) { toast(t("Pick the faces."), true); return; }
    if (f.type === "split" && !f.sketch) { toast(t("Pick the sketch to project."), true); return; }
    if ((f.type === "planesurf" || f.type === "extsurf") && !f.sketch) { toast(t("Pick a sketch."), true); return; }
    if (f.type === "offsurf" && !f.faces.length) { toast(t("Pick the faces."), true); return; }
    if (f.type === "knit" && f.surfaces.length < (f.solid ? 1 : 2)) { toast(t("Pick two or more surface bodies."), true); return; }
    if (f.type === "thicken" && !f.surface) { toast(t("Pick the surface to thicken."), true); return; }
    if ((f.type === "revsurf" || f.type === "loftsurf") && (f.type === "revsurf" ? !f.sketch : f.profiles.length < 2)) { toast(t(f.type === "revsurf" ? "Pick a sketch." : "Pick two or more profile sketches."), true); return; }
    if (f.type === "untrimsurf" && !f.surface) { toast(t("Pick the surface to untrim."), true); return; }
    if ((f.type === "fillsurf" || f.type === "extendsurf") && !f.surface) { toast(t(f.type === "fillsurf" ? "Pick the surface whose opening to fill." : "Pick the surface to extend."), true); return; }
    if (f.type === "trimsurf" && (!f.surface || !f.tool)) { toast(t(f.surface ? "Pick a plane or a surface to trim with." : "Pick the surface to trim."), true); return; }
    if (f.type === "replaceface" && (!f.faces.length || !f.surface)) { toast(t(f.faces.length ? "Pick the replacement surface." : "Click the faces to replace."), true); return; }
    const wm = weldMissing(f);
    if (wm) { toast(t(wm), true); return; }
    if (f.type === "rib" && !f.sketch) { toast(t("Pick an open sketch: the line the rib is built on."), true); return; }
    if (f.type === "loft" && f.profiles.length < 2) { toast(t("Pick two or more profile sketches."), true); return; }
    const smWhy = smCheck(f);
    if (smWhy) { toast(smWhy, true); return; }
    if (f.type === "point" && !(f.mode === "face" ? f.face : f.edge)) { toast(t(f.mode === "face" ? "Pick a face." : "Pick an edge."), true); return; }
    this.mode = { kind: "none" };
    this.store!.change(m.isNew ? `Add ${f.name}` : `Edit ${f.name}`, d => {
      if (m.isNew) d.features.splice(m.index, 0, f); else d.features[m.index] = f;
      if (m.isNew && d.rollback != null) d.rollback++;
    });
    this.selected = f.id;
    this.clearDecor();
    this.renderAll();
    // Pushpin or Ctrl+Enter: the same command again once the part has rebuilt (FR-UI-106).
    if (m.isNew && this.activeCmd) this.rememberOptions(this.activeCmd, f);
    if (m.isNew && isWeldFeature(f)) rememberWeld(f);
    const again = m.isNew && (repeat || this.pinned) ? this.activeCmd : null;
    void Promise.resolve(this.rebuild()).then(() => { if (again && this.mode.kind === "none") this.command(again); });
  }

  /**
   * Options a new feature panel starts with: the ones used last for that command (FR-UI-043). Only
   * choices are kept (end condition, merge, side...), never sizes or picked geometry.
   */
  private static readonly OPTION_KEYS: Record<string, { keys: string[]; ok?: (k: string, v: unknown) => boolean }> = {
    extrude: { keys: ["end", "merge"], ok: (k, v) => k !== "end" || ["blind", "through", "mid", "through2"].includes(String(v)) },
    cut: { keys: ["end", "flip", "outside"], ok: (k, v) => k !== "end" || ["blind", "through", "mid", "through2"].includes(String(v)) },
    revolve: { keys: ["mid", "merge"] },
    fillet: { keys: ["keepFit"] },
    chamfer: { keys: ["mode"] },
    shell: { keys: ["outward"] },
    rib: { keys: ["side", "dir"] },
    cpattern: { keys: ["equal"] },
  };
  private rememberOptions(cmd: string, f: Feature) {
    const spec = ModelController.OPTION_KEYS[cmd];
    if (!spec) return;
    const g = f as unknown as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const k of spec.keys) if (g[k] !== undefined && (spec.ok?.(k, g[k]) ?? true)) keep[k] = g[k];
    try { localStorage.setItem(`mc:opts:${cmd}`, JSON.stringify(keep)); } catch { /* storage blocked: not remembered */ }
  }
  private recallOptions(cmd: string, f: Feature) {
    const spec = ModelController.OPTION_KEYS[cmd];
    if (!spec) return;
    let saved: Record<string, unknown> = {};
    try { saved = JSON.parse(localStorage.getItem(`mc:opts:${cmd}`) ?? "{}"); } catch { return; }
    const g = f as unknown as Record<string, unknown>;
    for (const k of spec.keys) if (k in saved && (spec.ok?.(k, saved[k]) ?? true) && ["string", "boolean"].includes(typeof saved[k])) g[k] = saved[k];
    // A chamfer mode needs its second value.
    if (f.type === "chamfer") { if (f.mode === "two") f.distance2 ??= { v: f.distance.v }; if (f.mode === "angle") f.angle ??= { v: Math.PI / 4 }; }
  }

  /** Undo/redo step names in the UI language; null when a name has no translation (FR-UND-005). */
  private stepName(label: string): string | null {
    // A step with its own translation ("Delete sketch items") is used whole, not as Delete + a feature name.
    const tr = t(label);
    if (tr !== label) return tr;
    const m = /^(Add|Edit|Delete) (.+)$/.exec(label);
    if (m) return t(`${m[1]} {name}`, { name: featureLabel(m[2]) });
    return tr === label && lang() !== "en" ? null : tr;
  }
  private undoTip(redo = false) {
    const s = this.store;
    const label = s ? (redo ? s.redoLabel : s.undoLabel) : "";
    const name = label ? this.stepName(label) : null;
    return name ? t(redo ? "Redo: {what} (Ctrl+Y)" : "Undo: {what} (Ctrl+Z)", { what: name }) : t(redo ? "Redo (Ctrl+Y)" : "Undo (Ctrl+Z)");
  }

  /** The Undo ▾ list: the last steps by name; picking one undoes (or redoes) back to it. */
  private historyMenu(at: HTMLElement) {
    if (!this.store) return;
    const h = this.store.history(20);
    const items: ([string, () => void, string?] | null)[] = [];
    h.undo.forEach((l, i) => items.push([this.stepName(l) ?? t("Step {n}", { n: i + 1 }), () => { for (let k = 0; k <= i; k++) this.undo(); }, "↶"]));
    if (h.undo.length && h.redo.length) items.push(null);
    h.redo.forEach((l, i) => items.push([this.stepName(l) ?? t("Step {n}", { n: i + 1 }), () => { for (let k = 0; k <= i; k++) this.redo(); }, "↷"]));
    if (!items.length) { toast(t("Nothing to undo.")); return; }
    const r = at.getBoundingClientRect();
    this.showMenu(items, r.left - 40, r.bottom + 4, () => $("#mc-tools").querySelector<HTMLElement>('[data-fly="undo"]')?.focus());
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
  /** The cut list as shown: the last rebuild's items split by sub-weldment (`splitSubs`); tree rows `cut:<i>` index it. */
  cutItems() { return splitSubs(this.last?.cutList ?? [], this.doc.subWelds); }
  /** The bodies a cut list row, body row or sub-weldment row stands for (only bodies the cut list knows). */
  private cutBodies(id: string): string[] {
    const known = new Set((this.last?.cutList ?? []).flatMap(c => c.bodies));
    if (id.startsWith("cut:")) return this.cutItems()[+id.slice(4)]?.bodies ?? [];
    if (id.startsWith("body:")) return known.has(id.slice(5)) ? [id.slice(5)] : [];
    if (id.startsWith("wsub:")) return this.doc.subWelds?.find(x => x.id === id.slice(5))?.bodies.filter(b => known.has(b)) ?? [];
    return [];
  }
  /**
   * Moves bodies into a sub-weldment (SolidWorks' Create Sub-weldment): `sub` null makes a new one, "" takes them out of
   * every one. One undo step; sub-weldments left empty by a move stay until dissolved.
   */
  moveToSub(bodies: string[], sub: string | null) {
    if (!this.store || !bodies.length) return;
    let made = "";
    this.store.change(sub === null ? "Create sub-weldment" : sub ? "Add to sub-weldment" : "Remove from sub-weldment", d => {
      const all = (d.subWelds ?? []).map(x => ({ ...x, bodies: x.bodies.filter(b => !bodies.includes(b)) }));
      if (sub === null) {
        let n = 1;
        while (all.some(g => g.name === `Sub-weldment${n}`)) n++;
        made = uid("sw");
        all.push({ id: made, name: `Sub-weldment${n}`, bodies: [...bodies] });
      } else if (sub) all.find(x => x.id === sub)?.bodies.push(...bodies);
      if (all.length) d.subWelds = all; else delete d.subWelds;
    });
    if (made) { this.selected = `wsub:${made}`; this.closedFolders.delete("cutlist"); this.renderTree(); }
  }
  /** Dissolve sub-weldment: its items go back to the top of the cut list. */
  dissolveSub(id: string) {
    this.store?.change("Dissolve sub-weldment", d => {
      const all = (d.subWelds ?? []).filter(x => x.id !== id);
      if (all.length) d.subWelds = all; else delete d.subWelds;
    });
  }
  /** Fillet/chamfer picking adds the tangent chain of an edge (FR-SEL-005). */
  private tangentProp = true;
  /** Hole panel tab (view-only) and the draft it belongs to: a new hole panel opens on Type. */
  private holeTab: "type" | "pos" = "type";
  private holeTabOf?: HoleFeature;
  /** Folders collapsed in the tree (view state, not saved). */
  private closedFolders = new Set<string>();
  /** Features whose absorbed sketch rows are folded away (view state, FR-HIS-013). */
  private closedFeats = new Set<string>();
  /** Where the rollback bar was before it last moved (FR-HIS-012 Roll to previous); undefined: not moved yet. */
  private rollPrev: number | null | undefined = undefined;
  /** The part opened rolled back: the notice above the tree shows until it is rolled to the end (FR-HIS-012). */
  private rollNotice = false;

  /** Moves the rollback bar: features from `index` on are not evaluated (null: none). */
  setRollback(index: number | null) {
    if (!this.store) return;
    if (index != null && index < this.frozenCount()) { toast(t("The rollback bar can't go above the freeze bar."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    const n = this.doc.features.length;
    const rb = index == null || index >= n ? null : Math.max(0, index);
    if (rb === this.doc.rollback) return;
    this.rollPrev = this.doc.rollback;
    this.store.change(rb == null ? "Roll to end" : "Roll back", d => { d.rollback = rb; });
  }

  /** Roll to previous (FR-HIS-012): back to where the bar was before its last move, else one feature up. */
  rollToPrevious() {
    if (!this.store) return;
    const cur = this.doc.rollback ?? this.doc.features.length;
    const to = this.rollPrev !== undefined && this.rollPrev !== this.doc.rollback ? this.rollPrev : Math.max(this.frozenCount(), cur - 1);
    this.setRollback(to);
  }

  /** The notice of a part opened rolled back (AT-UX-14): how many features are not shown, and Roll to end. */
  private renderRollNotice() {
    let bar = document.getElementById("mc-rolled");
    const n = this.store && this.doc.rollback != null ? this.doc.features.length - this.doc.rollback : 0;
    if (!n) this.rollNotice = false;
    if (!this.rollNotice) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "mc-rolled";
      bar.className = "mc-ro";
      bar.setAttribute("role", "status");
      document.getElementById("tab-features")!.prepend(bar);
    }
    bar.innerHTML = `<span>${esc(t("The part is rolled back: {n} feature is not shown|The part is rolled back: {n} features are not shown", { n }))}</span><button class="btn small primary" data-a="rollend">${esc(t("Roll to end"))}</button>`;
    bar.querySelector("button")!.addEventListener("click", () => this.setRollback(null));
  }

  /** Units from the status bar (FR-UI-116): the part's length unit, as one undo step; values stay in mm. */
  setDocUnits(u: PartDoc["units"]["length"]) {
    if (!this.store || this.doc.units.length === u) return;
    this.store.change(`Units: ${u}`, d => { d.units = { ...d.units, length: u }; });
  }

  /**
   * Hide/show under the cursor (FR-UI-105). Hidden bodies are not meshed, so each one keeps the triangles it had
   * when it was hidden (world coordinates) as a see-through ghost: Shift+Tab shows the one under the cursor, and
   * holding Ctrl+Shift+Tab draws them all so one can be clicked.
   */
  private ghostGroup = new THREE.Group();
  private pointerIn = false;

  private keepGhost(key: string) {
    const m = this.featureFaceMesh(`body:${key}`, 0x8c99a6, 0.28);
    if (!m) return;
    this.dropGhost(key);
    m.userData.ghost = key;
    m.raycast = THREE.Mesh.prototype.raycast;
    this.ghostGroup.add(m);
  }

  private dropGhost(key: string) {
    for (const o of [...this.ghostGroup.children]) if (o.userData.ghost === key) { this.ghostGroup.remove(o); const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  }

  private clearGhosts() { for (const o of [...this.ghostGroup.children]) this.dropGhost(o.userData.ghost); this.showGhosts(false); }

  private showGhosts(on: boolean) {
    if (this.ghostGroup.visible === on) return;
    this.ghostGroup.visible = on;
    this.host.viewer.invalidate();
  }

  /** The hidden body whose ghost is under a screen point (only bodies that are still hidden). */
  private ghostAt(x: number, y: number): string | null {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), v.camera);
    const live = this.ghostGroup.children.filter(o => this.doc.bodies?.[o.userData.ghost]?.hidden);
    return (rc.intersectObjects(live, false)[0]?.object.userData.ghost as string | undefined) ?? null;
  }

  /** The shown body under a screen point. */
  /** The part's named views (FR-UI-104): stored in the document, out of the undo history. */
  namedViews(): NamedViews | null {
    const st = this.store;
    if (!st) return null;
    const set = (list: NamedView[]) => { st.amend(d => { if (list.length) d.views = list; else delete d.views; }); this.host.setDoc(this.docLabel()); };
    return {
      list: () => [...(st.doc.views ?? [])],
      save: v => set([...(st.doc.views ?? []).filter(x => x.name !== v.name), v]),
      remove: name => set((st.doc.views ?? []).filter(x => x.name !== name)),
    };
  }

  bodyAt(x: number, y: number): string | null {
    const hit = this.host.faceAt(x, y), bodies = this.last?.bodies ?? [];
    if (!hit) return null;
    let at = 0;
    for (const b of bodies) { const n = b.faces ?? 0; if (hit.faceId >= at && hit.faceId < at + n) return b.key; at += n; }
    return null;
  }

  /** Tab / Shift+Tab / Ctrl+Shift+Tab over the view; false when the keys are not for it. */
  private tabKey(e: KeyboardEvent): boolean {
    if (e.key !== "Tab" || e.altKey || this.mode.kind !== "none" || !this.pointerIn || !this.pointer) return false;
    const tg = e.target as HTMLElement;
    if (!(tg === document.body || tg === document.documentElement || tg === this.host.viewer.renderer.domElement || tg.id === "viewport")) return false;
    const { x, y } = this.pointer;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) { this.showGhosts(true); return true; }
    if (e.ctrlKey || e.metaKey) return false;
    if (e.shiftKey) {
      const key = this.ghostAt(x, y);
      if (key) this.setBody(key, { hidden: false });
      else toast(t("No hidden body under the cursor."));
      return true;
    }
    const key = this.bodyAt(x, y);
    if (key) this.setBody(key, { hidden: true });
    return !!key;
  }

  /** Shift+C (FR-HIS-013): folds every folder and every feature's absorbed sketch. */
  collapseAll() {
    if (!this.store) return;
    for (const g of this.doc.folders ?? []) this.closedFolders.add(g.id);
    this.closedFolders.add("bodies");
    this.closedFolders.add("cutlist");
    for (const f of this.doc.features) if (f.type === "extrude" || f.type === "revolve") this.closedFeats.add(f.id);
    this.renderTree();
  }

  rename(id: string, name: string) {
    if (id.startsWith("body:")) { const key = id.slice(5), v = name.trim(); if (v && v !== this.bodyName(key)) this.setBody(key, { name: v }); return; }
    if (id.startsWith("wsub:")) {
      const g = this.doc.subWelds?.find(x => `wsub:${x.id}` === id), v = name.trim();
      if (g && v && v !== g.name) this.store!.change(`Rename ${g.name}`, d => { d.subWelds!.find(x => x.id === g.id)!.name = v; });
      return;
    }
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
    if (f?.type !== "plane" && f?.type !== "axis" && f?.type !== "point" && f?.type !== "csys" && f?.type !== "helix" && f?.type !== "curve" && f?.type !== "sketch3d") return;
    this.store!.change(f.hidden ? `Show ${f.name}` : `Hide ${f.name}`, d => {
      const g = d.features.find(x => x.id === id) as PlaneFeature | AxisFeature | PointFeature | CsysFeature | HelixFeature | CurveFeature | Sketch3dFeature;
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

  /**
   * Feature recognition (FR-FT-102), like FeatureWorks: round holes in the body (an imported one above
   * all) are filled with a Delete Face and made again as Hole features, so their sizes can be edited.
   */
  async recognizeHoles() {
    if (!this.store) return;
    if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    this.setBusy(1);
    let rec: { faces: FaceRef[]; holes: RecognizedHole[]; cuts?: Feature[] };
    try { rec = await this.kernel.recognizeHoles(this.doc); }
    catch (err) { toast(t("Feature recognition failed: {msg}", { msg: (err as Error).message }), true); return; }
    finally { this.setBusy(-1); }
    const cuts = rec.cuts ?? [], n = rec.holes.length + cuts.filter(f => f.type === "hole" || f.type === "extrude").length;
    if (!n) { toast(t("No holes were found to recognise.")); return; }
    const holes = recognizedHoleFeatures(rec.holes, () => uid("f_"));
    this.store.change("Recognize holes", d => {
      let at = d.rollback ?? d.features.length;
      const add = (f: Feature) => { d.features.splice(at++, 0, f); if (d.rollback != null) d.rollback++; };
      add({ id: uid("f_"), type: "delface", name: nextName(d, "delface"), faces: rec.faces } satisfies DeleteFaceFeature);
      for (const h of holes) add({ ...h, name: nextName(d, "hole") });
      // Cross holes through a shaft come back as a sketch and a Through All cut.
      for (const f of cuts) add({ ...f, name: nextName(d, f.type, f.type === "extrude") } as Feature);
    });
    toast(t("{n} hole recognised|{n} holes recognised", { n }));
  }

  /**
   * Feature recognition (FR-FT-102): the body's fillets and chamfers are removed with Delete Face and
   * made again as Fillet and Chamfer features, so their sizes can be edited or the features deleted.
   */
  async recognizeBlends() {
    if (!this.store) return;
    if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    this.setBusy(1);
    let feats: Feature[];
    try { feats = await this.kernel.recognizeBlends(this.doc); }
    catch (err) { toast(t("Feature recognition failed: {msg}", { msg: (err as Error).message }), true); return; }
    finally { this.setBusy(-1); }
    const made = feats.filter(f => f.type === "fillet" || f.type === "chamfer");
    if (!made.length) { toast(t("No fillets or chamfers were found to recognise.")); return; }
    this.store.change("Recognize fillets", d => {
      let at = d.rollback ?? d.features.length;
      for (const f of feats) {
        f.name = nextName(d, f.type);
        d.features.splice(at++, 0, f);
        if (d.rollback != null) d.rollback++;
      }
    });
    const n = made.reduce((a, f) => a + (f as FilletFeature | ChamferFeature).edges.length, 0);
    toast(t("Fillets and chamfers recognised: {n} edge|Fillets and chamfers recognised: {n} edges", { n }));
  }

  /**
   * Feature recognition (FR-FT-102): prismatic pockets and bosses are removed with Delete Face and made
   * again as sketches with Extruded Cut / Boss features, so their shape and depth can be edited.
   */
  async recognizeExtrudes() {
    if (!this.store) return;
    if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    this.setBusy(1);
    let feats: Feature[];
    try { feats = await this.kernel.recognizeExtrudes(this.doc); }
    catch (err) { toast(t("Feature recognition failed: {msg}", { msg: (err as Error).message }), true); return; }
    finally { this.setBusy(-1); }
    const rev = feats.some(f => f.type === "revolve");
    const n = feats.filter(f => f.type === "extrude" || f.type === "revolve").length;
    if (!n) { toast(t("No pockets or bosses were found to recognise.")); return; }
    defineRecognised(feats);
    this.store.change("Recognize extrudes", d => {
      let at = d.rollback ?? d.features.length;
      for (const f of feats) {
        f.name = nextName(d, f.type);
        d.features.splice(at++, 0, f);
        if (d.rollback != null) d.rollback++;
      }
    });
    toast(rev ? t("{n} feature recognised|{n} features recognised", { n }) : t("{n} extrude recognised|{n} extrudes recognised", { n }));
  }

  /**
   * Recognize Features (FR-FT-102), like FeatureWorks' automatic mode: the base, pockets and bosses, holes,
   * fillets and chamfers all at once, added as one undo step in modelling order.
   */
  async recognizeFeatures() {
    if (!this.store) return;
    if (!this.last?.data) { toast(t("There is no body yet."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    this.setBusy(1);
    let feats: Feature[];
    try { feats = await this.kernel.recognizeFeatures(this.doc); }
    catch (err) { toast(t("Feature recognition failed: {msg}", { msg: (err as Error).message }), true); return; }
    finally { this.setBusy(-1); }
    const n = feats.filter(f => f.type !== "sketch" && f.type !== "delface" && f.type !== "delbody" && f.type !== "plane" && f.type !== "axis").length;
    if (!n) { toast(t("No features were found to recognise.")); return; }
    defineRecognised(feats);
    this.store.change("Recognize features", d => {
      let at = d.rollback ?? d.features.length;
      for (const f of feats) {
        f.name = nextName(d, f.type, f.type === "extrude" && f.op === "cut");
        d.features.splice(at++, 0, f);
        if (d.rollback != null) d.rollback++;
      }
    });
    toast(t("{n} feature recognised|{n} features recognised", { n }));
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

  undo() { if (this.mode.kind === "feature") { this.stepDraft(-1); return; } if (this.mode.kind === "plane") this.exitMode(false); this.store?.undo(); }
  redo() { if (this.mode.kind === "feature") { this.stepDraft(1); return; } if (this.mode.kind === "plane") this.exitMode(false); this.store?.redo(); }

  /**
   * Undo inside a command (FR-UI-108): every state of the open feature's draft (picks, values, options, the box in
   * focus) is kept per command; Ctrl+Z / Ctrl+Y step through them without leaving the panel, and the document's own
   * undo stack is not touched until OK.
   */
  private drafts = new WeakMap<object, { snaps: string[]; at: number }>();

  private draftSnap(m: Extract<Mode, { kind: "feature" }>) { return JSON.stringify({ d: m.draft, f: m.focus ?? null }); }

  /** Records the draft's state when it differs from the last one kept. */
  private noteDraft() {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const snap = this.draftSnap(m), h = this.drafts.get(m);
    if (!h) { this.drafts.set(m, { snaps: [snap], at: 0 }); return; }
    if (h.snaps[h.at] === snap) return;
    h.snaps.length = h.at + 1;
    h.snaps.push(snap);
    if (h.snaps.length > 100) h.snaps.shift();
    h.at = h.snaps.length - 1;
    this.renderQuick();
  }

  /** Whether the open command has a step to undo (-1) or redo (+1). */
  draftCan(dir: -1 | 1) {
    const m = this.mode, h = m.kind === "feature" ? this.drafts.get(m) : undefined;
    return !!h && (dir < 0 ? h.at > 0 : h.at < h.snaps.length - 1);
  }

  private stepDraft(dir: -1 | 1) {
    const m = this.mode;
    if (m.kind !== "feature") return;
    this.noteDraft();
    const h = this.drafts.get(m)!;
    const to = h.at + dir;
    if (to < 0 || to >= h.snaps.length) { toast(dir < 0 ? t("Nothing to undo in this command.") : t("Nothing to redo in this command.")); return; }
    h.at = to;
    const { d, f } = JSON.parse(h.snaps[to]) as { d: Feature; f: Focus | null };
    // The draft object keeps its identity: view state keyed by it (3D sketch tools) stays.
    const dr = m.draft as unknown as Record<string, unknown>;
    for (const k of Object.keys(dr)) delete dr[k];
    Object.assign(dr, d);
    if (f) m.focus = f; else delete m.focus;
    this.renderQuick();
    this.renderPanel();
    this.drawDecor();
    void this.rebuild();
  }

  // ---------- files ----------

  async save(as = false) {
    if (!this.store) return;
    if (this.mode.kind === "sketch") this.ok();
    let bytes = await packPart(this.doc, `MöbiusCAD ${this.host.appVersion}`);
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
    let blob = new Blob([bytes], { type: "application/zip" });
    const suggested = this.fileName || `${this.doc.name}${PART_EXT}`;
    // The part takes the name of the file it is saved as, as in SolidWorks (exam #69): its tab, its title and
    // Insert component's list of open documents then show that name, not "Part1".
    const named = async (file: string) => {
      const base = file.replace(/\.[^.]+$/, "");
      if (!base || base === this.doc.name) return;
      this.store!.amend(d => { d.name = base; });
      bytes = await packPart(this.doc, `MöbiusCAD ${this.host.appVersion}`);
      blob = new Blob([bytes], { type: "application/zip" });
    };
    const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
    try {
      if (w.showSaveFilePicker) {
        if (!this.handle || as) {
          this.handle = await w.showSaveFilePicker({ suggestedName: suggested, types: [{ description: "MöbiusCAD part", accept: { "application/zip": [PART_EXT] } }] });
        }
        await named(this.handle.name);
        const out = await (this.handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await out.write(blob);
        await out.close();
        this.fileName = this.handle.name;
      } else {
        // No save dialog in this browser: ask for the name on the first save and on Save as (exam #9).
        const file = this.fileName && !as ? this.fileName : await askFileName(suggested, PART_EXT);
        if (!file) return;
        await named(file);
        downloadBlob(blob, file);
        this.fileName = file;
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
    this.host.saved?.(this.fileName, bytes);
    // The title and the document tab drop the unsaved mark and show the file's name.
    this.host.setDoc(this.docLabel());
    this.renderTree?.();
    toast(t("Saved {name}", { name: this.fileName }), "success");
  }

  /** Snapshots of the open part (FR-STO-005): restore one, or open it as a copy. */
  /**
   * External references (FR-ASM-030): every in-context plane of the part, with the component face it
   * follows and its state; each can be locked, and Lock all freezes them all (`PartDoc.ctxLocked`).
   */
  showExtRefs() {
    if (!this.store) return;
    let d = document.getElementById("mc-xref") as HTMLDialogElement | null;
    if (!d) {
      d = document.createElement("dialog");
      d.id = "mc-xref";
      d.className = "modal v-dlg";
      d.setAttribute("aria-labelledby", "mc-xref-title");
      document.body.appendChild(d);
      trapFocus(d, () => d!.open);
    }
    const dlg = d;
    const draw = () => {
      const refs = ctxRefs(this.doc), all = !!this.doc.ctxLocked;
      const found = (r: CtxRef) => !!this.context?.comps.some(c => c.comp === r.comp && c.faces.some(f => f.name === r.face));
      const state = (r: CtxRef) => (all || r.locked ? t("Locked") : !this.context ? t("Out of context") : found(r) ? t("In context") : t("Missing"));
      dlg.innerHTML = `<h3 id="mc-xref-title">${esc(t("External References"))}</h3>`
        + `<p class="muted">${esc(t("Planes this part takes from faces of other components, made while editing it in the context of an assembly. Unlocked ones follow the faces when the assembly changes."))}</p>`
        + (refs.length ? `<div class="v-scroll"><table class="v-table"><thead><tr><th>${esc(t("Feature"))}</th><th>${esc(t("Referenced face"))}</th><th>${esc(t("State"))}</th><th>${esc(t("Lock"))}</th></tr></thead><tbody>${refs.map(({ f, ref }, i) => `<tr><td translate="no">${esc(featureLabel(f.name))}</td><td translate="no">${esc(ref.label ?? ref.comp)}</td><td>${esc(state(ref))}</td><td><input type="checkbox" data-xlock="${i}"${ref.locked || all ? " checked" : ""}${all ? " disabled" : ""} aria-label="${esc(t("Lock"))} ${esc(featureLabel(f.name))}" /></td></tr>`).join("")}</tbody></table></div>`
          : `<p>${esc(t("This part has no external references. Edit it in context from an assembly (right-click a component) and sketch on another component's face to make one."))}</p>`)
        + `<div class="row end">${refs.length ? `<button class="btn" data-a="lockall">${esc(all ? t("Unlock all") : t("Lock all"))}</button>` : ""}<button class="btn" data-a="close">${esc(t("Close"))}</button></div>`;
      dlg.querySelector("[data-a=close]")!.addEventListener("click", () => dlg.close());
      dlg.querySelector("[data-a=lockall]")?.addEventListener("click", () => {
        this.store!.change(all ? "Unlock external references" : "Lock external references", doc => { if (all) delete doc.ctxLocked; else doc.ctxLocked = true; });
        draw();
      });
      dlg.querySelectorAll<HTMLInputElement>("[data-xlock]").forEach(b => b.addEventListener("change", () => {
        const i = +b.dataset.xlock!, on = b.checked;
        this.store!.change(on ? "Lock external reference" : "Unlock external reference", doc => { const r = ctxRefs(doc)[i]?.ref; if (r) { if (on) r.locked = true; else delete r.locked; } });
        draw();
      }));
    };
    draw();
    if (!dlg.open) dlg.showModal();
  }

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
    // In a sketch the left button draws, so the middle button orbits (as in SolidWorks) and the right one pans.
    // Ctrl+drag of a tree row onto a flat face or a plane pastes a copy there (FR-HIS-014), before the file drop.
    const featDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes(FEATURE_DRAG) && this.mode.kind === "none";
    vp.addEventListener("dragover", e => {
      if (!featDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "none";
    }, true);
    vp.addEventListener("drop", e => {
      if (!featDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      const id = e.dataTransfer!.getData(FEATURE_DRAG);
      if (!e.ctrlKey || !id) return;
      const plane = this.pickRef(e as unknown as PointerEvent);
      if (!plane) { toast(t("Select a plane or a flat face to paste on."), true); return; }
      if (this.copyFeature(id, true)) this.pasteFeature(plane);
    }, true);
    vp.addEventListener("pointerdown", () => {
      const mb = this.host.viewer.controls.mouseButtons;
      mb.MIDDLE = this.mode.kind === "sketch" || getPref("middle") === "rotate" ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    }, true);
    vp.addEventListener("pointerdown", e => {
      if (!onCanvas(e)) return;
      this.down = { x: e.clientX, y: e.clientY };
      const m = this.mode;
      // The edge under a right-click, taken before the view controls react to the button.
      this.rightHit = e.button === 2 && m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer") ? this.host.edgeAt(e.clientX, e.clientY) : null;
      // Mouse gestures (FR-UI-024): a right-drag runs a command; the view controls never see this button.
      if (e.button === 2 && this.gestureStart(e)) { e.stopPropagation(); e.preventDefault(); return; }
      if (m.kind === "sketch" && m.editor.pointerDown(e)) { e.stopPropagation(); e.preventDefault(); return; }
      if (e.button === 0 && this.arrowHit(e)) {
        // Dragging the depth arrow: the orbit controls never see this button.
        e.stopPropagation();
        e.preventDefault();
        this.startArrowDrag(e);
      }
    }, true);
    vp.addEventListener("pointermove", e => { this.pointer = { x: e.clientX, y: e.clientY }; this.pointerIn = e.target === this.host.viewer.renderer.domElement; }, true);
    vp.addEventListener("pointerleave", () => { this.pointerIn = false; });
    // Ctrl+Shift+Tab held (FR-UI-105): a click on a see-through hidden body shows it.
    window.addEventListener("pointerdown", e => {
      if (!this.ghostGroup.visible || e.button !== 0 || e.target !== this.host.viewer.renderer.domElement) return;
      const key = this.ghostAt(e.clientX, e.clientY);
      if (!key) return;
      e.preventDefault(); e.stopPropagation();
      this.setBody(key, { hidden: false });
    }, true);
    window.addEventListener("keyup", e => { if (this.ghostGroup.visible && (e.key === "Tab" || e.key === "Control" || e.key === "Shift" || e.key === "Meta")) this.showGhosts(false); });
    window.addEventListener("blur", () => this.showGhosts(false));
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
      if (m.kind === "sketch") {
        const d0 = this.down;
        this.down = null;
        // Right-click without a drag: the sketch menu (FR-SK-045). Not stopped: the view controls must see the button go up.
        if (e.button === 2 && d0 && Math.hypot(e.clientX - d0.x, e.clientY - d0.y) <= 4) { this.sketchMenu(e); return; }
        if (m.editor.pointerUp(e)) e.stopPropagation();
        return;
      }
      const d = this.down;
      this.down = null;
      // Not stopped either: the view controls must see the right button go up.
      if (e.button === 2 && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4) { if (!this.edgeMenu(e)) this.commandMenu(e); return; }
      if (e.button !== 0 || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      // Not stopped: the orbit controls must see the button go up. Smart measure skips these clicks (`picking`).
      if (m.kind === "none") { if (e.detail < 2) this.hideInstant(); const at = { x: e.clientX, y: e.clientY }, alt = e.altKey; setTimeout(() => this.showContextBar(at, alt), 0); }
      else if (m.kind === "plane") this.pickPlane(e);
      else if (m.kind === "feature" && m.draft.type === "fillet" && m.draft.kind) this.pickFaceSet(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "chamfer" && m.draft.mode === "vertex") this.pickChamferVertex(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "fillet" && m.focus === "sbv") this.pickSetback(e, m.draft);
      else if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer" || (m.draft.type === "curve" && m.draft.kind === "composite"))) this.pickEdge(e);
      else if (m.kind === "feature" && (m.draft.type === "smflange" || m.draft.type === "smhem" || m.draft.type === "smcorner" || m.draft.type === "smrip" || m.draft.type === "smmiter" || m.draft.type === "smswept")) this.pickSmEdge(e, m.draft);
      else if (m.kind === "feature" && (m.draft.type === "smclosed" || m.draft.type === "smcross")) this.pickSmFace(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "smform") this.placeForm(e, m.draft);
      else if (m.kind === "feature" && (m.draft.type === "smunfold" || m.draft.type === "smfold")) this.pickUnfold(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "smrelief") this.pickRelief(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "smgusset") this.pickGusset(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "smtabslot") this.pickTabSlot(e, m.draft);
      else if (m.kind === "feature" && (m.draft.type === "smconvert" || m.draft.type === "sminsert")) this.pickConvert(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "curve" && m.draft.kind === "projected") this.pickCopy(e);
      else if (m.kind === "feature" && m.draft.type === "sketch3d") this.pick3d(e, m.draft);
      else if (m.kind === "feature" && isScoped(m.draft) && m.focus === "scope") this.pickScope(e, m.draft);
      else if (m.kind === "feature" && hasContours(m.draft) && m.focus === "contours") this.pickContour(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "plane") {
        if (m.focus === "axis") this.pickAxis(e);
        else { const r = this.pickRef(e); if (r) { m.draft.base = r; if (m.draft.mode === "angle" && !m.draft.axis && !m.draft.about) m.focus = "axis"; this.draftChanged(); } }
      } else if (m.kind === "feature" && m.draft.type === "extrude" && this.extrudeTarget(m.draft, m.focus)) {
        const f = m.draft, tg = this.extrudeTarget(f, m.focus)!;
        if (tg === "body") {
          const h = this.host.faceAt(e.clientX, e.clientY);
          const fr = h ? this.faceRef(h.faceId) : null;
          if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Click a face of a body.")); return; }
          f.upToBody = fr;
        } else if (tg === "body2") {
          const h = this.host.faceAt(e.clientX, e.clientY);
          const fr = h ? this.faceRef(h.faceId) : null;
          if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Click a face of a body.")); return; }
          f.upToBody2 = fr;
        } else if (tg === "start-vertex" || tg === "vertex" || tg === "vertex2") {
          const v = this.pickVertex(e);
          if (!v) return;
          if (tg === "vertex") f.upToVertex = v; else if (tg === "vertex2") f.upToVertex2 = v; else { f.startVertex = v; m.focus = "upto"; }
        } else {
          const r = this.pickRef(e);
          if (!r) return;
          if (tg === "upto") f.upTo = r; else if (tg === "upto2") f.upTo2 = r; else { f.startRef = r; m.focus = "upto"; }
        }
        this.draftChanged();
      } else if (m.kind === "feature" && m.draft.type === "revolve" && m.draft.end === "upto") {
        const r = this.pickRef(e);
        if (r) { m.draft.upTo = r; this.draftChanged(); }
      } else if (m.kind === "feature" && (m.draft.type === "axis" || m.draft.type === "point")) this.pickRefGeometry(e, m.draft);
      else if (m.kind === "feature" && m.draft.type === "csys") this.pickCsys(e, m.draft);
      else if (m.kind === "feature" && isBodyOp(m.draft)) this.pickBody(e);
      else if (m.kind === "feature" && (m.draft.type === "shell" || m.draft.type === "draft" || m.draft.type === "split" || m.draft.type === "delface" || m.draft.type === "moveface" || m.draft.type === "offsurf" || isCopy(m.draft))) this.pickCopy(e);
      else if (m.kind === "feature" && (m.draft.type === "knit" || m.draft.type === "thicken" || m.draft.type === "replaceface" || m.draft.type === "trimsurf" || m.draft.type === "fillsurf" || m.draft.type === "extendsurf" || m.draft.type === "untrimsurf")) this.pickSurface(e);
      else if (m.kind === "feature" && isWeldFeature(m.draft)) { m.focus = weldPick(this.weldCtx(m.index), e, m.draft, m.focus) as Focus | undefined; this.draftChanged(); }
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
      // A finger held still (FR-UI-091) opens what a right-click without a drag opens; lifting it then picks nothing.
      if (isLongPress(e) && onCanvas(e) && this.active) {
        e.preventDefault();
        this.down = null;
        if (m.kind === "sketch") this.sketchMenu(e);
        else if (m.kind === "none") this.showContextBar({ x: e.clientX, y: e.clientY }, false);
        else { this.rightHit = m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer") ? this.host.edgeAt(e.clientX, e.clientY) : null; if (!this.edgeMenu(e)) this.commandMenu(e); }
        return;
      }
      if (onCanvas(e) && (m.kind === "sketch" || (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")))) e.preventDefault();
    }, true);
    vp.addEventListener("dblclick", e => {
      const m = this.mode;
      if (onCanvas(e) && m.kind === "sketch" && m.editor.doubleClick()) e.stopPropagation();
      else if (onCanvas(e) && m.kind === "none") this.showInstant(e.clientX, e.clientY);
    }, true);
    window.addEventListener("keydown", e => this.key(e), true);
    window.addEventListener("beforeunload", e => { if (this.store?.dirty) { journalSave(this.doc, this.fileName); e.preventDefault(); } });

    $("#new-part").addEventListener("click", () => this.newPart());
    $("#empty-new").addEventListener("click", () => this.newPart());
    // The corner mirrors the panel: a sketch pattern / move / rotate panel takes its own ✓ and ✕ first.
    const inner = (k: string) => this.mode.kind === "sketch" && this.mode.editor.pattern ? $("#mc-pm").querySelector<HTMLButtonElement>(`[data-a=${k}]`) : null;
    $("#mc-ok").addEventListener("click", () => { const b = inner("pok"); if (b) b.click(); else this.ok(); });
    document.querySelectorAll<HTMLElement>("#mc-empty [data-plane]").forEach(b => b.addEventListener("click", () => void this.createSketch({ std: b.dataset.plane as "XY" })));
    // The menu closes on a click elsewhere, Esc, scrolling or resizing.
    document.addEventListener("pointerdown", e => { if (!(e.target as HTMLElement).closest?.("#mc-menu")) this.closeMenu(); }, true);
    window.addEventListener("resize", () => this.closeMenu());
    $("#mc-cancel").addEventListener("click", () => { const b = inner("pcancel"); if (b) b.click(); else void this.cancel(); });
  }

  private key(e: KeyboardEvent) {
    if (!this.store) return;
    // An open drawing owns the keyboard: Ctrl+Z there undid the part's last feature (drawings exam #1).
    if (document.getElementById("app")?.classList.contains("drawing")) return;
    const tg = e.target as HTMLElement;
    if (tg.matches?.("input, select, textarea") || tg.closest?.("dialog")) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (this.tabKey(e)) { stop(); return; }
    if (mod && k === "s") { stop(); void this.save(e.shiftKey); return; }
    if (mod && !e.shiftKey && k === "z") { stop(); this.undo(); return; }
    if (mod && (k === "y" || (e.shiftKey && k === "z"))) { stop(); this.redo(); return; }
    if (mod && k === "b") { stop(); this.forceRebuild(false); return; }
    if (mod && k === "k" && !e.shiftKey && !e.altKey) { stop(); this.commandSearch(); return; }
    if (mod && k === "q") { stop(); this.forceRebuild(true); return; }
    // Copy and paste features (FR-HIS-014): Ctrl+C on a tree row, Ctrl+V with a plane or flat face selected.
    if (mod && !e.shiftKey && !e.altKey && k === "c" && this.mode.kind === "none" && !window.getSelection()?.toString()) { if (this.copyFeature()) stop(); return; }
    if (mod && !e.shiftKey && !e.altKey && k === "v" && this.mode.kind === "none" && this.clip) { stop(); this.pasteFeature(); return; }
    // Ctrl+Enter: OK and the same command again in a feature; leaves a sketch (FR-UI-044, FR-UI-106).
    if (mod && k === "enter" && !e.altKey && (this.mode.kind === "feature" || this.mode.kind === "sketch")) { stop(); this.ok(this.mode.kind === "feature"); return; }
    // Ctrl+A in a sketch selects every sketch entity, as in SolidWorks, not the page's text (exam #91).
    if (mod && k === "a" && !e.shiftKey && !e.altKey && this.mode.kind === "sketch") { stop(); this.mode.editor.selectAll(); this.renderPanel(); return; }
    if (mod || e.altKey) return;
    if (e.key === "F5") { stop(); this.toggleFilterBar(); return; }
    // Esc closes the magnifying glass first (FR-SEL-010; its own listener takes it).
    if (k === "escape" && document.querySelector(".mag-lens")) return;
    // Shift+D: breadcrumbs and the confirmation corner to the cursor (FR-SEL-009; D stays the distance tool).
    if (k === "d" && e.shiftKey && this.pointerIn && (document.getElementById("mc-crumbs") || this.mode.kind !== "none")) { stop(); this.crumbsToCursor(); return; }
    if (k === "escape" && this.mode.kind === "none") this.hideCrumbs();
    if (k === "escape" && document.querySelector("#mc-sbar, #mc-cbar")) { stop(); this.hideShortcutBar(); return; }
    if (k === "escape" && this.instant && this.mode.kind === "none" && !document.querySelector("#mc-menu:not([hidden])")) { stop(); this.hideInstant(); return; }
    const m = this.mode;
    // S: the shortcut bar at the cursor (SolidWorks habit, FR-UI-023).
    if (k === "s" && !e.shiftKey && (m.kind === "sketch" || m.kind === "none")) { stop(); this.showShortcutBar(); return; }
    if (m.kind === "sketch") {
      if (k === "enter") { stop(); this.ok(); return; }
      // K: Add relation (FR-UI-054): the relations valid for the selection in a menu at the cursor.
      if (k === "k" && !e.shiftKey) { stop(); this.relationMenu(); return; }
      // A tool key also refreshes the panel: the fillet radius, chamfer and offset distances show there.
      if (m.editor.key(e)) { stop(); this.renderBar(); this.renderPanel(); return; }
      // Esc with nothing left to clear leaves an unchanged sketch; a changed one stays open (✕ discards), so a stray Esc
      // followed by Enter can't throw the sketch away (exam bug 44).
      if (k === "escape") { stop(); if (JSON.stringify(this.doc) === m.entry) void this.cancel(); else toast(t("The sketch has changes: ✓ keeps them, ✕ discards them.")); }
      return;
    }
    if (m.kind === "feature" && m.draft.type === "sketch3d") {
      // 3D sketch (FR-SK-080): Tab turns the sketch plane, Esc ends the chain, Delete removes the selection.
      const s3 = this.s3(m.draft);
      if (k === "tab") { stop(); s3.plane = s3.plane === "XY" ? "YZ" : s3.plane === "YZ" ? "ZX" : "XY"; this.renderPanel(); this.drawDecor(); return; }
      if (k === "escape" && (s3.anchor || s3.tool)) { stop(); if (s3.anchor) { s3.anchor = null; s3.spline = null; } else s3.tool = null; this.renderPanel(); this.drawDecor(); return; }
      if ((k === "delete" || k === "backspace") && s3.sel.length) { stop(); this.delete3d(m.draft); return; }
    }
    if (m.kind === "feature" || m.kind === "plane" || m.kind === "props" || m.kind === "eq" || m.kind === "cfg") {
      if (k === "escape") { stop(); void this.cancel(); }
      else if (k === "enter" && !tg.closest?.("#mc-tree")) { stop(); this.ok(); }
      return;
    }
    const inTree = !!tg.closest?.("#tab-features");
    // Enter with no command running repeats the last feature command (FR-UI-111).
    if (k === "enter" && !inTree && !e.shiftKey && this.lastCmd && !tg.matches?.("button, a, summary, [role=treeitem], [role=tab], [role=menuitem]")) { stop(); toast(t("Repeat: {name}", { name: this.cmdLabel(this.lastCmd) })); this.command(this.lastCmd); return; }
    // Shift+C folds the whole tree (FR-HIS-013).
    if (k === "c" && e.shiftKey && m.kind === "none") { stop(); this.collapseAll(); return; }
    const feat = this.selected ? this.store.feature(this.selected) : undefined;
    if ((k === "delete" || k === "backspace") && feat && inTree) { stop(); void this.deleteFeature(feat.id); }
    else if (k === "f2" && feat) { stop(); this.startRename(feat.id); }
  }

  private pickPlane(e: PointerEvent) {
    const m = this.mode;
    if (m.kind === "plane" && m.edit?.pickX) { this.pickSketchX(e, m.edit); return; }
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

  /** Sketch orientation (FR-SK-002 P2): a straight model edge clicked while choosing the X axis. */
  private pickSketchX(e: PointerEvent, ed: NonNullable<Extract<Mode, { kind: "plane" }>["edit"]>) {
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    if (!hit?.edge || hit.edge.type !== "line") { toast(t("Click a straight edge for the sketch X axis."), true); return; }
    const ref = this.refOfEdge(hit.edge);
    if (!ref) return;
    ed.xAxis = { edge: ref, ...(ed.xAxis?.flip ? { flip: true } : {}) };
    ed.pickX = false;
    this.renderPanel();
    this.renderBar();
    void this.rebuild();
  }

  /** Edit sketch plane (FR-SK-007): pick another plane or flat face; the sketch keeps its geometry in its own coordinates. */
  editSketchPlane(id: string) {
    const sk = this.store?.feature(id);
    if (!sk || sk.type !== "sketch") return;
    if (this.isFrozen(id)) { this.frozenToast(); return; }
    this.exitMode(false);
    this.mode = { kind: "plane", edit: { id, plane: structuredClone(sk.plane), ...(sk.xAxis ? { xAxis: structuredClone(sk.xAxis) } : {}) } };
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
    // A face of another component (edit in context) counts when nothing of the part is nearer.
    const cx = this.ctxAt(e.clientX, e.clientY);
    if (cx && cx.dist < fd && (!ph || "std" in (ph.object.userData.ref as PlaneRef) || cx.dist <= ph.distance)) {
      if (!cx.ref) toast(t("A sketch needs a flat face or a plane."), true);
      return cx.ref;
    }
    if (f && (!ph || "std" in (ph.object.userData.ref as PlaneRef) || fd <= ph.distance + 1e-6)) return this.planeOfFace(f.faceId);
    return ph ? (ph.object.userData.ref as PlaneRef) : null;
  }

  /** Angle plane: the straight edge it turns about. */
  /** Plane at angle (FR-REF-002): turn about a picked edge, a standard axis or a reference axis before the plane. */
  private aboutField(f: PlaneFeature, focus: boolean): string {
    const at = this.doc.features.findIndex(x => x.id === f.id);
    const axes = this.doc.features.slice(0, at < 0 ? this.doc.features.length : at).filter(x => x.type === "axis" && !x.suppressed);
    const cur = f.about?.std ?? (f.about?.axis ? `axis:${f.about.axis}` : "edge");
    const opt = (v: string, label: string, raw = false) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}${raw ? ' translate="no"' : ""}>${esc(label)}</option>`;
    return `<label class="pm-field"><span>${esc(t("Axis"))}</span><select data-k="about">${opt("edge", t("Straight edge"))}${opt("X", t("X axis"))}${opt("Y", t("Y axis"))}${opt("Z", t("Z axis"))}${axes.map(a => opt(`axis:${a.id}`, featureLabel(a.name), true)).join("")}</select></label>`
      + (f.about ? "" : `<div class="pm-field"><span>${esc(t("Edge"))}</span><button class="pm-box${focus ? " focus" : ""}" data-k="focus-axis">${esc(f.axis ? t("Edge picked") : t("None"))}</button></div>`);
  }

  private pickAxis(e: PointerEvent) {
    const m = this.mode;
    if (m.kind !== "feature" || m.draft.type !== "plane") return;
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    if (!hit?.edge) { toast(t("Pick a straight edge to turn the plane about.")); return; }
    if (hit.edge.type !== "line") { toast(t("The plane turns about a straight edge."), true); return; }
    const ref = this.refOfEdge(hit.edge);
    if (!ref) return;
    m.draft.axis = ref;
    delete m.draft.about;
    m.focus = "base";
    this.draftChanged();
  }

  /** The open feature's draft changed: panel, decorations and preview. */
  /** What the weldment panels and picks see (FR-FT-121); `index` is where the edited feature goes. */
  private weldCtx(index: number): WeldCtx {
    return {
      doc: this.doc, before: this.doc.features.slice(0, index), selected: this.selected, last: this.last,
      faceAt: (x, y) => this.host.faceAt(x, y), faceRef: id => this.faceRef(id), faceType: id => this.host.viewer.parts[0]?.data.faces[id]?.type,
      toScreen: p => {
        const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect(), q = new THREE.Vector3(...p).project(v.camera);
        return q.z > 1 ? null : [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
      },
      changed: () => this.draftChanged(),
    };
  }
  private draftChanged() { this.flowFocus(); this.renderPanel(); this.drawDecor(); void this.rebuild(); }

  /**
   * FR-UI-109: the required selection boxes of a panel in order. `one` = the box is done with one item (a plane, an
   * edge, a body), so focus moves on by itself once it has it; boxes that take many items keep focus.
   */
  /** The sketch regions an extrude or revolve can pick from (FR-FT-010): the axis of a revolve left out when it is construction. */
  private contourRegions(f: ContourFeature): { sk: SketchFeature; regions: Region[] } | null {
    const sk = this.store?.feature(f.sketch);
    if (sk?.type !== "sketch") return null;
    const ax = f.type === "revolve" ? sk.ents.find(e => e.id === f.axis) : undefined;
    return { sk, regions: sketchRegions(sk, new Set(ax?.cons ? [ax.id] : [])) };
  }

  /** The sketch does not make plain closed regions (crossing or branching curves), but its curves still bound some: the contours must be picked. */
  private needsContours(f: ContourFeature): boolean {
    const sk = this.store?.feature(f.sketch);
    if (sk?.type !== "sketch" || !sketchProfile(sk).error) return false;
    return !!this.contourRegions(f)?.regions.length;
  }

  /** The sketch region under a screen point (FR-FT-010), -1 when the pointer is outside every region. */
  private contourAt(x: number, y: number, f: ContourFeature): { cr: { sk: SketchFeature; regions: Region[] }; i: number } | null {
    const cr = this.contourRegions(f);
    if (!cr) return null;
    const fr = this.frameOf(cr.sk);
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), v.camera);
    const n = new THREE.Vector3(...fr.n), o = new THREE.Vector3(...fr.o);
    const hit = rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), new THREE.Vector3());
    const at: V2 | null = hit ? [hit.clone().sub(o).dot(new THREE.Vector3(...fr.x)), hit.clone().sub(o).dot(new THREE.Vector3(...fr.y))] : null;
    return { cr, i: at ? regionAt(cr.regions, at) : -1 };
  }

  /** A click while Selected Contours has focus: the region under the pointer is added, or taken off when picked already. */
  private pickContour(e: PointerEvent, f: ContourFeature) {
    const hit = this.contourAt(e.clientX, e.clientY, f);
    if (!hit) return;
    const { cr, i } = hit;
    if (i < 0) { toast(t("Click inside a closed region of the sketch.")); return; }
    const list = (f.contours ?? []).filter(q => regionAt(cr.regions, q) >= 0);
    const k = list.findIndex(q => regionAt(cr.regions, q) === i);
    if (k >= 0) list.splice(k, 1); else list.push(regionPoint(cr.regions[i]));
    if (list.length) f.contours = list; else delete f.contours;
    this.ctHover = -2;
    this.draftChanged();
  }

  /** Hovering while Selected Contours has focus (SolidWorks' region pre-highlight): the region under the pointer lights up blue. */
  private hoverContour(x: number | null, y = 0) {
    const m = this.mode;
    const f = m.kind === "feature" && m.focus === "contours" && hasContours(m.draft) ? m.draft : null;
    const hit = f && x !== null ? this.contourAt(x, y, f) : null;
    const i = hit?.i ?? -1;
    if (i === this.ctHover) return;
    this.ctHover = i;
    for (const c of [...this.ctHoverGroup.children]) {
      this.ctHoverGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      ((c as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
    }
    if (hit && i >= 0) {
      const fr = this.frameOf(hit.cr.sk);
      const mesh = this.regionMesh(hit.cr.regions[i], fr, 0x339af0, 0.3);
      mesh.userData.contourHover = i;
      this.ctHoverGroup.add(mesh);
    }
    this.host.viewer.renderer.domElement.style.cursor = f && i >= 0 ? "pointer" : "";
    this.host.viewer.invalidate();
  }

  /** A sketch region as a flat see-through fill on its sketch plane, drawn over the model. */
  private regionMesh(rg: Region, fr: Frame, color: number, opacity: number): THREE.Mesh {
    const mtx = new THREE.Matrix4().makeBasis(new THREE.Vector3(...fr.x), new THREE.Vector3(...fr.y), new THREE.Vector3(...fr.n)).setPosition(...fr.o);
    const shape = new THREE.Shape(rg.outer.map(p => new THREE.Vector2(p[0], p[1])));
    shape.holes = rg.holes.map(h => new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    mesh.applyMatrix4(mtx);
    mesh.renderOrder = 2400;
    return mesh;
  }

  /** Selected contours on the sketch plane: the sketch while they are picked, and the picked regions filled. */
  private drawContours(f: ContourFeature, picking: boolean, dark: boolean) {
    if (!picking && !f.contours?.length) return;
    const cr = this.contourRegions(f);
    if (!cr) return;
    const fr = this.frameOf(cr.sk);
    if (picking) this.lines(sketchSegments(cr.sk, fr), dark ? 0x8ab4ff : 0x1d4ed8, 1.4);
    const picked = new Set((f.contours ?? []).map(q => regionAt(cr.regions, q)).filter(i => i >= 0));
    // A cut's regions take the cut preview's yellow, so a picked region never reads as material being added.
    const cut = f.type !== "planesurf" && f.op === "cut";
    const [fill, edge] = cut ? CONTOUR_CUT : CONTOUR_BOSS;
    const outline: number[] = [];
    const at = (p: [number, number]) => [0, 1, 2].map(k => fr.o[k] + fr.x[k] * p[0] + fr.y[k] * p[1]);
    for (const i of picked) {
      const rg = cr.regions[i];
      const mesh = this.regionMesh(rg, fr, fill, picking ? 0.35 : 0.18);
      mesh.userData.contour = i;
      mesh.userData.contourCut = cut;
      this.decor.add(mesh);
      // Its outline in a darker shade, so neighbouring picked regions stay apart.
      for (const loop of [rg.outer, ...rg.holes]) loop.forEach((p, k) => outline.push(...at(p), ...at(loop[(k + 1) % loop.length])));
    }
    this.lines(outline, edge, picking ? 2 : 1.4);
  }

  /** The Selected Contours box (FR-FT-010): how many regions are picked, or that the whole sketch is used. */
  /**
   * Feature scope (FR-FT-007): for a cut, or a boss with Merge result, in a part with several bodies,
   * All bodies or the bodies picked in the view.
   */
  private scopeGroup(f: ScopedFeature, focus: Focus | undefined): string {
    const op = f.type === "hole" ? "cut" : f.op;
    if (f.type !== "hole" && f.op === "boss" && f.merge === false) return "";
    if ((this.last?.bodies?.length ?? 0) < 2 && f.scope === undefined) return "";
    const all = f.scope === undefined, n = f.scope?.length ?? 0, on = focus === "scope";
    const label = n ? t("{n} body|{n} bodies", { n }) : t("None");
    return `<fieldset class="pm-group"><legend>${esc(t("Feature scope"))}</legend>`
      + `<label class="chk pm-chk"><input type="checkbox" data-k="scopeAll"${all ? " checked" : ""} />${esc(t("All bodies"))}</label>`
      + (all ? "" : `<div class="pm-field"><span>${esc(t("Bodies"))}</span><button class="pm-box${on ? " focus" : ""}" data-focus="scope" aria-label="${esc(t("Feature scope"))}: ${esc(label)}" translate="no">${esc(label)}</button></div>`
        + `<p class="pm-help muted">${esc(op === "cut" ? t("Click a face of each body to cut; the other bodies are left as they are.") : t("Click a face of each body to merge with; the other bodies are left as they are."))}</p>`)
      + `</fieldset>`;
  }

  /** Feature scope: a click on a body's face adds it, a click on a picked body takes it off. */
  private pickScope(e: PointerEvent, f: ScopedFeature) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Click a face of a body.")); return; }
    const list = f.scope ?? (f.scope = []);
    const j = list.findIndex(x => x.name === fr.name);
    if (j >= 0) list.splice(j, 1); else list.push(fr);
    this.draftChanged();
  }

  private contoursGroup(f: ContourFeature, focus: Focus | undefined): string {
    const n = f.contours?.length ?? 0, need = this.needsContours(f), on = focus === "contours";
    const label = n ? t("{n} region|{n} regions", { n }) : t("All regions");
    return `<fieldset class="pm-group"><legend>${esc(t("Selected Contours"))}</legend>`
      + `<div class="pm-field"><span>${esc(t("Contours"))}</span><button class="pm-box${on ? " focus" : ""}" data-focus="contours" data-k="focus-contours" aria-label="${esc(t("Selected Contours"))}: ${esc(label)}">${esc(label)}</button></div>`
      + (on || need ? `<p class="pm-help muted">${esc(need && !n ? t("The sketch's curves cross or branch: click the regions to use in the view.") : t("Click regions of the sketch in the view; click a picked one again to take it off."))}</p>` : "")
      + (n ? `<button class="btn small" data-k="clearContours">${esc(t("Use all regions"))}</button>` : "")
      + `</fieldset>`;
  }

  private boxFlow(d: Feature): { focus: Focus; filled: boolean; one: boolean }[] {
    const seeds = (f: CopyFeature) => f.copy === "faces" ? !!f.faces?.length : f.copy === "bodies" ? !!f.bodies?.length : f.features.length > 0;
    switch (d.type) {
      case "plane": return [{ focus: "base", filled: !!d.base, one: true }, ...(d.mode === "angle" ? [{ focus: "axis" as Focus, filled: !!(d.axis || d.about), one: true }] : [])];
      case "draft": return [{ focus: "nplane", filled: !!d.plane, one: true }, { focus: "faces", filled: d.kind === "parting" ? !!d.parting?.length : d.faces.length > 0, one: false }];
      case "hole": return [{ focus: "hplane", filled: !!d.plane, one: true }, ...(d.end === "upto" || d.end === "offset" ? [{ focus: "hupto" as Focus, filled: !!d.upTo, one: true }] : d.end === "vertex" ? [{ focus: "hupto" as Focus, filled: !!d.upToVertex, one: true }] : []), { focus: "pts", filled: d.pts.length > 0, one: false }];
      case "mirror": return [{ focus: "mplane", filled: !!d.plane, one: true }, { focus: "seeds", filled: seeds(d), one: false }];
      case "lpattern": return [{ focus: "seeds", filled: seeds(d), one: false }, { focus: "dir", filled: !!d.dir, one: true }];
      case "cpattern": return [{ focus: "seeds", filled: seeds(d), one: false }, { focus: "dir", filled: !!d.axis, one: true }];
      case "csys": return [{ focus: "origin", filled: !!d.origin, one: true }, { focus: "cz", filled: !!d.z, one: true }, { focus: "cx", filled: !!d.x, one: true }];
      case "combine": case "indent": return [{ focus: "main", filled: !!d.main, one: true }, { focus: "bodies", filled: d.tools.length > 0, one: false }];
      case "trimsurf": return [{ focus: "tsurf", filled: !!d.surface, one: true }, { focus: "ttool", filled: !!d.tool, one: true }];
      case "revolve": case "planesurf": return this.needsContours(d) ? [{ focus: "contours", filled: !!d.contours?.length, one: false }] : [];
      case "extrude": return [
        ...(this.needsContours(d) ? [{ focus: "contours" as Focus, filled: !!d.contours?.length, one: false }] : []),
        ...(d.start === "surface" ? [{ focus: "start" as Focus, filled: !!d.startRef, one: true }] : d.start === "vertex" ? [{ focus: "start" as Focus, filled: !!d.startVertex, one: true }] : []),
        ...(d.end === "upto" || d.end === "offset" ? [{ focus: "upto" as Focus, filled: !!d.upTo, one: true }] : d.end === "vertex" ? [{ focus: "upto" as Focus, filled: !!d.upToVertex, one: true }] : d.end === "body" ? [{ focus: "upbody" as Focus, filled: !!d.upToBody, one: true }] : []),
        ...(!dir2Apart(d) ? [] : d.end2 === "upto" || d.end2 === "offset" ? [{ focus: "upto2" as Focus, filled: !!d.upTo2, one: true }] : d.end2 === "vertex" ? [{ focus: "upto2" as Focus, filled: !!d.upToVertex2, one: true }] : d.end2 === "body" ? [{ focus: "upbody2" as Focus, filled: !!d.upToBody2, one: true }] : [])];
      default: return [];
    }
  }
  private flowWas = new WeakMap<object, string>();
  /** Moves focus to the next empty required box when the focused one-item box has just been filled (FR-UI-109). */
  private flowFocus() {
    const m = this.mode;
    if (m.kind !== "feature") return;
    const flow = this.boxFlow(m.draft);
    const key = flow.filter(b => b.filled).map(b => b.focus).join(",");
    const was = this.flowWas.get(m);
    this.flowWas.set(m, key);
    if (was == null) return;
    const i = flow.findIndex(b => b.focus === m.focus);
    if (i < 0 || !flow[i].one || !flow[i].filled || was.split(",").includes(flow[i].focus)) return;
    const next = flow.slice(i + 1).find(b => !b.filled) ?? flow.slice(0, i).find(b => !b.filled);
    if (next) m.focus = next.focus;
  }
  /** The box a panel opens on (FR-UI-109): the given one, unless it is a filled one-item box, then the first empty required box. */
  private openFocus(d: Feature, focus: Focus | undefined): Focus | undefined {
    const flow = this.boxFlow(d);
    const cur = flow.find(b => b.focus === focus);
    if (focus && (!cur || !cur.filled || !cur.one)) return focus;
    return flow.find(b => !b.filled)?.focus ?? focus;
  }

  /** A plane reference in words: "Top (XY)", "Plane1", "Face of Extrude1". */
  /** What a click in the view sets while an extrude is edited (FR-FT-012/013). */
  private extrudeTarget(f: ExtrudeFeature, focus: Focus | undefined): "start-surface" | "start-vertex" | "upto" | "vertex" | "body" | "upto2" | "vertex2" | "body2" | null {
    const e2 = dir2Apart(f) ? f.end2 : undefined;
    const t2 = e2 === "upto" || e2 === "offset" ? "upto2" : e2 === "vertex" ? "vertex2" : e2 === "body" ? "body2" : null;
    const filled2 = t2 === "upto2" ? !!f.upTo2 : t2 === "vertex2" ? !!f.upToVertex2 : !!f.upToBody2;
    if (t2 && (focus === "upto2" || focus === "upbody2")) return t2;
    if (f.start === "surface" && (focus === "start" || !f.startRef)) return "start-surface";
    if (f.start === "vertex" && (focus === "start" || !f.startVertex)) return "start-vertex";
    const t1 = f.end === "upto" || f.end === "offset" ? "upto" : f.end === "vertex" ? "vertex" : f.end === "body" ? "body" : null;
    const filled1 = t1 === "upto" ? !!f.upTo : t1 === "vertex" ? !!f.upToVertex : !!f.upToBody;
    // Direction 1's box unless it is filled and Direction 2 still waits for its reference.
    if (t1 && !(t2 && filled1 && !filled2)) return t1;
    return t2;
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

  /** Vertex chamfer (FR-FT-041): a click near an edge end toggles that corner. */
  private pickChamferVertex(e: PointerEvent, f: ChamferFeature) {
    const v = this.pickVertex(e);
    if (!v || "point" in v) return;
    const list = (f.vertices ??= []);
    const i = list.findIndex(x => !("point" in x) && Math.hypot(x.at[0] - v.at[0], x.at[1] - v.at[1], x.at[2] - v.at[2]) < 1e-6);
    if (i >= 0) list.splice(i, 1); else list.push(v);
    this.drawDecor(); this.renderPanel(); void this.rebuild();
  }

  /** Setback fillet (FR-FT-033): a click near an edge end toggles that corner, set back twice the radius to start with. */
  private pickSetback(e: PointerEvent, f: FilletFeature) {
    const v = this.pickVertex(e);
    if (!v || "point" in v) return;
    const list = (f.setbacks ??= []);
    const i = list.findIndex(x => !("point" in x.v) && Math.hypot(x.v.at[0] - v.at[0], x.v.at[1] - v.at[1], x.v.at[2] - v.at[2]) < 1e-6);
    if (i >= 0) list.splice(i, 1); else list.push({ v, d: 2 * f.radius.v });
    if (!list.length) delete f.setbacks;
    this.drawDecor(); this.renderPanel(); void this.rebuild();
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
    if ("ctx" in r) return t("Face of {name} (external)", { name: r.ctx.label ?? r.ctx.comp });
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

  /** Edge flange and hem (FR-FT-120): a click toggles a straight sheet edge; edges the draft itself made are skipped. */
  /** Closed corner: a click toggles a flange end face (a side face across the sheet's thickness). */
  private pickSmFace(e: PointerEvent, f: { id: string; type: string; faces: { name: string; hint?: V3 }[] }) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (f.type === "smcross") {
      // Cross break: a flat face of a panel, its top or bottom.
      if (!fr || fr.name.startsWith(`${f.id}:`) || !/:p\d+:(top|bot)$/.test(fr.name)) { toast(t("Pick a flat face of the sheet (its top or bottom).")); return; }
    } else if (!fr || fr.name.startsWith(`${f.id}:`) || /:(top|bot|in|out)$/.test(fr.name) || !/:p\d+:/.test(fr.name)) { toast(t("Pick an end face of a flange (a side face across its thickness).")); return; }
    const i = f.faces.findIndex(x => x.name === fr.name);
    if (i >= 0) f.faces.splice(i, 1); else f.faces.push(fr);
    this.draftChanged();
  }

  /** Forming tool: a click on a panel's top or bottom face adds a tool there (a click on another face starts over on it). */
  private placeForm(e: PointerEvent, f: SmFormFeature) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    const st = this.last?.sheet;
    if (!hit || !fr || !st || fr.name.startsWith(`${f.id}:`) || !/:p\d+:(top|bot)$/.test(fr.name)) { toast(t("Pick a flat face of the sheet (its top or bottom).")); return; }
    const p = flatPointOn(st, fr.name, hit.point);
    if (!p) { toast(t("Pick a flat face of the sheet (its top or bottom).")); return; }
    if (fr.name !== f.face.name) { f.face = fr; f.pts = []; }
    f.pts.push([p[0], p[1]]);
    this.draftChanged();
  }

  /** Sheet metal gusset: a click on a bend puts the rib there (centred when the panel says so). */
  private pickGusset(e: PointerEvent, f: SmGussetFeature) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    const st = this.last?.sheet;
    const b = fr && st ? bendOfFace(st, fr.name) : undefined;
    if (!b || !hit) { toast(t("Pick a bend for the gusset.")); return; }
    if (f.bend !== b.id) f.bend = b.id;
    if (f.at) {
      const l = Math.hypot(b.a1[0] - b.a0[0], b.a1[1] - b.a0[1]), e2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l];
      const p0 = smApply(b.M, [b.a0[0], b.a0[1], 0]), d = smApplyDir(b.M, [e2[0], e2[1], 0]);
      const at = (hit.point[0] - p0[0]) * d[0] + (hit.point[1] - p0[1]) * d[1] + (hit.point[2] - p0[2]) * d[2];
      const w = f.width.v / 2;
      f.at = { v: Math.round(Math.min(Math.max(at, w), l - w) * 100) / 100 };
    }
    this.draftChanged();
  }

  /** Tab and slot: a click on a straight outline edge of a flat sheet face sets the tab edge; a click on a face sets the slot face. */
  private pickTabSlot(e: PointerEvent, f: SmTabSlotFeature) {
    const ed = this.host.edgeAt(e.clientX, e.clientY)?.edge;
    const ref = ed && ed.type === "line" ? this.edgeRefs([ed])[0] : undefined;
    if (ref && !ref.faces.some(n => n.startsWith(`${f.id}:`)) && ref.faces.some(n => /:p\d+:(top|bot)$/.test(n)) && ref.faces.some(n => /:p\d+:(?!top$|bot$)[^:]+$/.test(n))) {
      f.edge = ref;
      this.draftChanged();
      return;
    }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(f.edge ? t("Pick the face the tabs go through.") : t("Pick a straight edge of the sheet for the tabs.")); return; }
    f.face = fr;
    this.draftChanged();
  }

  /** Convert to Sheet Metal: the first click picks the fixed face; then clicks on its straight edges toggle bend edges
   * (a click on another face makes that the fixed face). Picks are on the solid before the feature. */
  private pickConvert(e: PointerEvent, f: SmConvertFeature | SmInsertFeature) {
    const ed = f.type === "smconvert" && f.face.name ? this.host.edgeAt(e.clientX, e.clientY)?.edge : undefined;
    const ref = ed && ed.type === "line" ? this.edgeRefs([ed])[0] : undefined;
    // An edge of the fixed face, or a wall's far edge (it shares a face with a picked edge): a further wall.
    if (f.type === "smconvert" && ref && (ref.faces.includes(f.face.name) || f.edges.some(x => x.faces.some(n => n !== f.face.name && ref.faces.includes(n))))) {
      const key = (r: EdgeRef) => [...r.faces].sort().join("|");
      const i = f.edges.findIndex(x => key(x) === key(ref));
      if (i >= 0) f.edges.splice(i, 1); else f.edges.push(ref);
      this.draftChanged();
      return;
    }
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    if (!fr || fr.name.startsWith(`${f.id}:`)) { toast(f.face.name && f.type === "smconvert" ? t("Pick a straight edge of the fixed face, or another flat face to stay fixed.") : t("Pick a flat face of the solid to stay fixed.")); return; }
    if (fr.name !== f.face.name) { f.face = fr; if (f.type === "smconvert") f.edges = []; }
    this.draftChanged();
  }

  /** Corner relief: a click near a two-bend corner toggles it (none picked = every corner). */
  private pickRelief(e: PointerEvent, f: SmReliefFeature) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const st = this.last?.sheet;
    const all = st && !st.faceted ? reliefCorners(st) : [];
    let best: (typeof all)[number] | undefined, bd = Infinity;
    if (hit) for (const c of all) {
      const q = smApply(c.M, [c.c0[0] + (c.oa[0] * c.baA + c.ob[0] * c.baB) / 2, c.c0[1] + (c.oa[1] * c.baA + c.ob[1] * c.baB) / 2, st!.T / 2]);
      const d = Math.hypot(hit.point[0] - q[0], hit.point[1] - q[1], hit.point[2] - q[2]);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best || bd > 4 * (best.baA + best.baB + st!.T)) { toast(t("Click near a corner where two bends meet.")); return; }
    const i = f.corners.indexOf(best.key);
    if (i >= 0) f.corners.splice(i, 1); else f.corners.push(best.key);
    this.draftChanged();
  }

  /** Unfold / Fold: a click on a bend (folded or flat) toggles it; for Unfold, a click on a flat face makes it the fixed face. */
  private pickUnfold(e: PointerEvent, f: SmUnfoldFeature) {
    const hit = this.host.faceAt(e.clientX, e.clientY);
    const fr = hit ? this.faceRef(hit.faceId) : null;
    const st = this.last?.sheet;
    const bend = fr && st ? bendOfFace(st, fr.name) : undefined;
    if (bend) {
      const i = f.bends.indexOf(bend.id);
      if (i >= 0) f.bends.splice(i, 1); else f.bends.push(bend.id);
      this.draftChanged();
      return;
    }
    if (f.type === "smunfold" && fr && st && /:(top|bot)$/.test(fr.name) && panelOfFace(st, fr.name)) { f.face = fr; this.draftChanged(); return; }
    toast(f.type === "smunfold" ? t("Pick a bend, or a flat face of the sheet to stay fixed.") : t("Pick an unfolded bend."));
  }

  private pickSmEdge(e: PointerEvent, f: { id: string; type: string; edges: EdgeRef[] }) {
    // Break corner takes the short edges across the thickness, between two side faces.
    const corner = f.type === "smcorner";
    const msg = corner ? t("Pick an edge across the thickness at an outside corner.") : f.type === "smrip" ? t("Pick a straight edge where two flat walls meet.") : t("Pick a straight edge of the sheet.");
    const hit = this.host.edgeAt(e.clientX, e.clientY);
    if (!hit?.edge || hit.edge.type !== "line") { toast(msg); return; }
    const ref = this.edgeRefs([hit.edge])[0];
    if (!ref || ref.faces.some(n => n.startsWith(`${f.id}:`))) { toast(msg); return; }
    if (corner && ref.faces.some(n => /:(top|bot)$/.test(n))) { toast(msg); return; }
    const key = (r: EdgeRef) => [...r.faces].sort().join("|");
    const i = f.edges.findIndex(x => key(x) === key(ref));
    if (i >= 0) f.edges.splice(i, 1); else f.edges.push(ref);
    this.draftChanged();
  }

  /** Flatten (FR-FT-120): shows the flat pattern (a Flat-Pattern feature kept last), or folds the part back. */
  private toggleFlat() {
    if (!this.store) return;
    const d = this.doc;
    if (!d.features.some(isSheetBase)) { toast(t("Make a base flange first."), true); return; }
    if (this.mode.kind !== "none") this.exitMode(false);
    const fp = d.features.find(f => f.type === "smflat");
    if (fp) this.store.change(fp.suppressed ? "Flatten" : "Fold", dd => { const x = dd.features.find(g => g.id === fp.id)!; if (x.suppressed) delete x.suppressed; else x.suppressed = true; });
    else this.store.change("Flatten", dd => { dd.features.push({ id: uid("f_"), type: "smflat", name: nextName(dd, "smflat") }); if (dd.rollback != null) dd.rollback = null; });
  }

  /** Sheet metal cut-list properties (FR-FT-120): bounding box, thickness, cutting lengths, bends, mass. */
  private sheetProps() {
    const vol = this.last?.props?.volume, rho = this.doc.material?.density;
    showSheetProps(this.last?.sheet, this.doc.name, vol != null && rho != null ? vol * rho / 1000 : undefined);
  }

  /** The flat pattern with its bend lines as DXF (R12, mm). */
  private exportFlatDxf() {
    const st = this.last?.sheet;
    if (!st) { toast(t("Make a base flange first."), true); return; }
    downloadBlob(new Blob([flatDxf(st, this.doc.name)], { type: "image/vnd.dxf" }), `${this.doc.name}-flat.dxf`);
    // Cuts by later features reach the DXF through the flat pattern; folded, only the sheet outline is known.
    const fs = this.doc.features, at = fs.findIndex(isSheetBase);
    const cuts = !st.flatEdges && fs.slice(at + 1).some(f => !f.suppressed && !isSheet(f) && f.type !== "sketch" && f.type !== "plane");
    toast(cuts ? t("Flat pattern saved as DXF. Flatten the part first to include its cuts.") : t("Flat pattern saved as DXF."));
  }

  /** The edge list a click toggles: fillet and chamfer edges, or a composite curve's (FR-FT-085). */
  private pickedEdges(): { edges: EdgeRef[] } | null {
    const m = this.mode;
    if (m.kind !== "feature") return null;
    const f = m.draft;
    if (f.type === "fillet" || f.type === "chamfer") return f;
    if (f.type === "curve" && f.kind === "composite") { f.edges ??= []; return f as { edges: EdgeRef[] }; }
    return null;
  }

  private pickEdge(e: PointerEvent) {
    if (!this.pickedEdges()) return;
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
  /** The thickness the next multi-thickness face gets: the last one typed. */
  private multiT: number | null = null;
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
      ...this.okItems(),
      [t("Select loop"), () => this.addEdges(edgeLoop(data.edges, ed, face))],
      [t("Select tangency"), () => this.addEdges(tangentChain(data.edges, ed))],
      [round ? t("Select round edges of the same radius") : t("Select straight edges of the same length"), () => this.addEdges(sameEdges(data.edges, ed))],
    ], e.clientX, e.clientY, back);
    return true;
  }

  /** A command's name as the toolbar shows it. */
  private cmdLabel(c: string) {
    const fixed: Record<string, string> = { extrude: "Extrude", cut: "Cut", revolve: "Revolve", fillet: "Fillet", chamfer: "Chamfer", plane: "Plane", axis: "Axis", point: "Point", csys: "Coordinate system", shell: "Shell", draft: "Draft", mirror: "Mirror", lpattern: "Linear pattern", cpattern: "Circular pattern", hole: "Hole", thread: "Thread", sketch: "Sketch" };
    if (fixed[c]) return t(fixed[c]);
    const hit = [...P3_TOOLS(), ...SURF_TOOLS()].find(x => x[0] === c);
    return hit ? hit[1] : c;
  }

  /** Commands Ctrl+K can run now: [id, label in the UI language, English label]. */
  private searchable(): [string, string, string][] {
    const m = this.mode;
    if (m.kind !== "none" && m.kind !== "sketch") return [];
    let fixed: [string, string][] = [["sketch", "Sketch"], ["extrude", "Extrude"], ["cut", "Cut"], ["revolve", "Revolve"], ["fillet", "Fillet"], ["chamfer", "Chamfer"], ["hole", "Hole"], ["thread", "Thread"], ["shell", "Shell"], ["draft", "Draft"], ["mirror", "Mirror"], ["lpattern", "Linear pattern"], ["cpattern", "Circular pattern"], ["plane", "Plane"], ["axis", "Axis"], ["point", "Point"], ["csys", "Coordinate system"], ["import", "Insert body"], ["save", "Save"], ["step", "Export STEP"], ["filter", "Selection filter"], ["undo", "Undo"], ["redo", "Redo"]];
    // In a sketch: Exit sketch, then the features, which exit the sketch and use it (FR-SK-004).
    if (m.kind === "sketch") fixed = [["exit", "Exit sketch"], ...fixed.filter(([id]) => !FROM_SKETCH_SKIP.has(id))];
    let en = withLang("en", () => [...P3_TOOLS(), ...SURF_TOOLS(), ...SM_TOOLS()].map(x => [x[0], x[1]] as [string, string]));
    if (m.kind === "sketch") en = en.filter(([id]) => !FROM_SKETCH_SKIP.has(id));
    const loc = new Map([...P3_TOOLS(), ...SURF_TOOLS(), ...SM_TOOLS()].map(x => [x[0] as string, x[1]]));
    return [...fixed.map(([id, l]) => [id, t(l), l] as [string, string, string]), ...en.map(([id, l]) => [id, loc.get(id) ?? l, l] as [string, string, string])];
  }

  /** Command search (FR-UI-014, Ctrl+K): type part of a command's name, in English or Russian, and run it. */
  commandSearch() {
    document.getElementById("mc-cmdk")?.remove();
    const all = this.searchable();
    if (!all.length) { toast(t("Finish the current command first.")); return; }
    const back = document.activeElement as HTMLElement | null;
    const box = document.createElement("div");
    box.id = "mc-cmdk";
    box.className = "mc-cmdk";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", t("Command search"));
    box.innerHTML = `<input type="search" role="combobox" aria-expanded="true" aria-controls="mc-cmdk-l" aria-autocomplete="list" placeholder="${esc(t("Type a command (Ctrl+K)"))}" aria-label="${esc(t("Command search"))}" /><ul id="mc-cmdk-l" role="listbox"></ul>`;
    document.body.appendChild(box);
    const inp = box.querySelector("input")!, list = box.querySelector("ul")!;
    let shown: [string, string, string][] = [], cur = 0;
    const close = () => { box.remove(); back?.focus?.(); };
    const run = (id: string) => { close(); if (id === "import") this.importBodyFile(); else this.command(id); };
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      shown = all.filter(([, l, e]) => !q || l.toLowerCase().includes(q) || e.toLowerCase().includes(q)).slice(0, 12);
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map(([id, l], i) => `<li role="option" id="mc-cmdk-${i}" aria-selected="${i === cur}" data-id="${esc(id)}"><span class="mc-i" aria-hidden="true">${ICON_SVG[id] ?? ""}</span>${esc(l)}</li>`).join("")
        : `<li class="muted" role="option" aria-disabled="true">${esc(t("No command matches."))}</li>`;
      inp.setAttribute("aria-activedescendant", shown.length ? `mc-cmdk-${cur}` : "");
      list.querySelectorAll<HTMLElement>("[data-id]").forEach(li => li.addEventListener("pointerdown", e => { e.preventDefault(); run(li.dataset.id!); }));
    };
    inp.addEventListener("input", () => { cur = 0; draw(); });
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (shown.length) { cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; draw(); } }
      else if (e.key === "Enter") { e.preventDefault(); if (shown[cur]) run(shown[cur][0]); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== inp) box.remove(); }, 0));
    draw();
    inp.focus();
  }

  /** The right-drag in progress (FR-UI-024). */
  private gesture: { x: number; y: number; slot: number; guide: ReturnType<typeof gestureGuide> | null; end: () => void } | null = null;

  /**
   * Starts a mouse gesture on a right-button press in a part or a sketch when the preference is on (FR-UI-024).
   * A release without a drag is left to the viewport (the right-click menu); a drag shows the radial guide and
   * a release past `GESTURE_RUN` runs the slot's command. Esc cancels.
   */
  private gestureStart(e: PointerEvent): boolean {
    const m = this.mode;
    const mode: GestureMode | null = m.kind === "sketch" ? (m.editor.pattern ? null : "sketch") : m.kind === "none" && this.store ? "part" : null;
    if (!mode) return false;
    const cfg = loadGestures();
    if (!cfg.on) return false;
    this.gesture?.end();
    this.hideShortcutBar();
    this.closeMenu();
    const canvas = this.host.viewer.renderer.domElement;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    let done = false;
    const g = {
      x: e.clientX, y: e.clientY, slot: -1, guide: null as ReturnType<typeof gestureGuide> | null,
      end: () => {
        if (done) return;
        done = true;
        g.guide?.remove();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("keydown", key, true);
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
        if (this.gesture === g) this.gesture = null;
      },
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
      if (!g.guide && Math.hypot(dx, dy) >= GESTURE_SHOW) g.guide = gestureGuide(g.x, g.y, mode, cfg);
      if (g.guide) { g.slot = gestureSlot(dx, dy, cfg.n); g.guide.set(g.slot); }
      ev.stopPropagation();
    };
    const up = (ev: PointerEvent) => {
      if (ev.button !== 2) return;
      const shown = !!g.guide, slot = g.slot;
      g.end();
      // A right-click: the viewport's own handler opens the menu.
      if (!shown && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) <= 4) return;
      ev.stopPropagation();
      this.down = null;
      const id = slot >= 0 ? cfg[mode][slot] : "";
      if (id) this.runGesture(id);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); g.end(); this.down = null; } };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", key, true);
    this.gesture = g;
    return true;
  }

  /** Runs a gesture's command (ids from `GESTURE_CMDS`). */
  private runGesture(id: string) {
    const m = this.mode;
    if (id.startsWith("view:")) { this.host.view?.(id.slice(5)); return; }
    if (id.startsWith("sk:") && m.kind !== "sketch") return;
    if (id === "exit" && m.kind !== "sketch") return;
    if (m.kind === "sketch" && !id.startsWith("sk:") && id !== "exit" && id !== "undo" && id !== "redo") return;
    this.command(id);
    if (id.startsWith("sk:")) this.renderPanel();
  }

  /** OK / Cancel at the top of a right-click menu while a command runs (FR-UI-107). */
  private okItems(): ([string, () => void, string?] | null)[] {
    return [[t("OK"), () => this.ok(), "✓"], [t("Cancel"), () => void this.cancel(), "✕"], null];
  }

  /** The sketch right-click menu (FR-SK-045): the editor's rows, then Exit sketch and Discard. */
  private sketchMenu(e: MouseEvent) {
    const m = this.mode;
    if (m.kind !== "sketch" || m.editor.pattern) return;
    const rows = m.editor.contextMenu(e);
    if (!rows) return;
    // Quick snaps (FR-SK-046) while a drawing tool runs: a second menu picks the snap for the next point.
    if (m.editor.drawing) {
      if (rows.length && rows.at(-1) !== null) rows.push(null);
      rows.push([t("Quick snaps") + " ▸", () => this.quickSnapMenu(e.clientX, e.clientY, () => this.host.viewer.renderer.domElement.focus())]);
    }
    if (rows.length && rows.at(-1) !== null) rows.push(null);
    // Features straight from the open sketch (FR-SK-004): it is exited and used as the profile.
    for (const id of ["extrude", "cut", "revolve"] as const) rows.push([this.cmdInfo(id)[0], () => this.command(id), ICON_SVG[id]]);
    rows.push(null);
    rows.push([t("Exit sketch"), () => this.ok(), "✓"], [t("Discard"), () => void this.cancel(), "✕"]);
    this.showMenu(rows, e.clientX, e.clientY, () => this.host.viewer.renderer.domElement.focus());
  }

  /** Add relation on K (FR-UI-054, FR-SK-054): a menu of the relations valid for the selection, at the pointer. */
  private relationMenu() {
    const m = this.mode;
    if (m.kind !== "sketch" || m.editor.pattern) return;
    const ed = m.editor;
    if (!ed.selection.size) { toast(t("Select sketch items first, then press K to add a relation.")); return; }
    const rows = ed.relationRows();
    if (!rows.length) { toast(t("No relation fits the selection.")); return; }
    const r = this.host.viewer.renderer.domElement.getBoundingClientRect();
    const at = this.pointerIn && this.pointer ? this.pointer : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this.showMenu(rows, at.x, at.y, () => this.host.viewer.renderer.domElement.focus());
    document.getElementById("mc-menu")?.insertAdjacentHTML("afterbegin", `<div class="mc-menu-h" role="presentation">${esc(t("Add relation"))}</div>`);
  }

  /** The quick snap menu (FR-SK-046): one snap type for the next point; the active one first offers Clear. */
  private quickSnapMenu(x: number, y: number, back: () => void) {
    const m = this.mode;
    if (m.kind !== "sketch") return;
    const ed = m.editor;
    const rows: ([string, () => void, string?] | null)[] = SNAP_KINDS.map(([k, label]) => [t(label), () => ed.setQuickSnap(k), ed.quickSnap === k ? "✓" : undefined] as [string, () => void, string?]);
    if (ed.quickSnap) rows.push(null, [t("Clear quick snap"), () => ed.setQuickSnap(null), "✕"]);
    this.showMenu(rows, x, y, back);
  }

  /** World box of the selected sketch items while sketching (Zoom to selection), else null. */
  sketchSelectionBox() { return this.mode.kind === "sketch" ? this.mode.editor.selectionBox() : null; }

  /** Right-click without a drag while a feature or plane pick runs: OK and Cancel. */
  private commandMenu(e: MouseEvent) {
    const m = this.mode;
    if (m.kind === "none") return this.emptyMenu(e);
    if (m.kind !== "feature" && m.kind !== "plane") return false;
    const items = this.okItems();
    items.pop();
    this.showMenu(items, e.clientX, e.clientY, () => this.host.viewer.renderer.domElement.focus());
    return true;
  }

  /**
   * Right-click on empty space with no command running (FR-UI-113): the last 5 commands ("Recent commands"),
   * newest first, above Zoom to fit and the standard views.
   */
  private emptyMenu(e: MouseEvent) {
    if (!this.store || this.host.faceAt(e.clientX, e.clientY)) return false;
    const items: ([string, () => void, string?] | null)[] = this.recent.map(c => [this.cmdLabel(c), () => this.command(c), ICON_SVG[c]] as [string, () => void, string?]);
    if (items.length) items.push(null);
    items.push([t("Zoom to fit"), () => this.host.view?.("fit")], [t("Isometric"), () => this.host.view?.("iso")], [t("Normal to"), () => this.host.view?.("normal")]);
    this.showMenu(items, e.clientX, e.clientY, () => this.host.viewer.renderer.domElement.focus());
    const menu = document.getElementById("mc-menu");
    if (menu && this.recent.length) menu.insertAdjacentHTML("afterbegin", `<div class="mc-menu-h" role="presentation">${esc(t("Recent commands"))}</div>`);
    return true;
  }

  /** The last feature commands, newest first (FR-UI-113). */
  private recent: string[] = [];
  private noteRecent(c: string) {
    this.recent = [c, ...this.recent.filter(x => x !== c)].slice(0, 5);
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
    const dr = this.pickedEdges();
    if (!dr) return;
    const refs = this.edgeRefs(edges);
    if (!refs.length) { toast(t("That edge cannot be rounded (it is not between two faces).")); return; }
    const list = dr.edges;
    const same = (x: EdgeRef, y: EdgeRef) => this.edgeOf(x) === this.edgeOf(y) && this.edgeOf(x) != null;
    // One edge toggles; a face adds its edges (or removes them when all are in).
    if (refs.length === 1 && list.some(x => same(x, refs[0]))) dr.edges = list.filter(x => !same(x, refs[0]));
    else if (refs.every(r => list.some(x => same(x, r)))) dr.edges = list.filter(x => !refs.some(r => same(x, r)));
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
    if (f.type === "draft" && f.kind === "parting") {
      // Parting line draft: a click toggles an edge of the parting line.
      const hit = this.host.edgeAt(e.clientX, e.clientY);
      const er = hit?.edge ? this.refOfEdge(hit.edge) : null;
      if (!er || er.faces.some(own)) { toast(t("Click an edge of the parting line.")); return; }
      const list = (f.parting ??= []);
      const same = (x: EdgeRef) => this.edgeOf(x) === this.edgeOf(er) && this.edgeOf(x) != null;
      const i = list.findIndex(same);
      if (i >= 0) list.splice(i, 1); else list.push(er);
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
    if (f.type === "curve") {
      const hit = this.host.faceAt(e.clientX, e.clientY);
      const fr = hit ? this.faceRef(hit.faceId) : null;
      if (!fr) { toast(t("Pick a face.")); return; }
      const list = (f.faces ??= []);
      const i = list.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
      if (i >= 0) list.splice(i, 1); else list.push(fr);
      this.draftChanged();
      return;
    }
    if (f.type === "shell" || f.type === "draft" || f.type === "split" || f.type === "delface" || f.type === "moveface" || f.type === "offsurf") {
      const hit = this.host.faceAt(e.clientX, e.clientY);
      const fr = hit ? this.faceRef(hit.faceId) : null;
      if (!fr || own(fr.name)) { toast(t("Pick a face.")); return; }
      if (f.type === "shell" && m.focus === "mthick") {
        // Multi-thickness (FR-FT-060): a click toggles a face with its own wall thickness.
        const list = (f.multi ??= []);
        const j = list.findIndex(x => x.name === fr.name);
        if (j >= 0) list.splice(j, 1);
        else { list.push({ ...fr, t: this.multiT ?? f.thickness.v * 2 }); const k = f.faces.findIndex(x => x.name === fr.name); if (k >= 0) f.faces.splice(k, 1); }
        if (!list.length) delete f.multi;
        this.draftChanged();
        return;
      }
      const i = f.faces.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
      if (i >= 0) f.faces.splice(i, 1); else f.faces.push(fr);
      this.draftChanged();
      return;
    }
    if (!isCopy(f)) return;
    if (m.focus === "skip") { toast(t("Click the dots to skip instances, or another box to pick again.")); return; }
    if ((m.focus === "pref" || m.focus === "pref2") && f.type === "lpattern") {
      const r = this.pickRef(e);
      if (!r || ("face" in r && own(r.face.name))) return;
      if (m.focus === "pref2") f.upTo2 = r; else f.upTo = r;
      this.draftChanged();
      return;
    }
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
    if (f.copy === "faces" || f.copy === "bodies") {
      // Faces of a boss or cut, or bodies (any face names its body).
      const h = this.host.faceAt(e.clientX, e.clientY);
      const fr = h ? this.faceRef(h.faceId) : null;
      if (!fr || own(fr.name)) { toast(t(f.copy === "faces" ? "Pick a face." : "Click a face of a body.")); return; }
      const list = f.copy === "faces" ? (f.faces ??= []) : (f.bodies ??= []);
      const i = list.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
      if (i >= 0) list.splice(i, 1); else list.push(fr);
      this.draftChanged();
      return;
    }
    if (f.type === "spattern" && m.focus === "psketch") { toast(t("Pick the sketch in the Features tree.")); return; }
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
    if (m.kind !== "feature" || (m.draft.type !== "knit" && m.draft.type !== "thicken" && m.draft.type !== "replaceface" && m.draft.type !== "trimsurf" && m.draft.type !== "fillsurf" && m.draft.type !== "extendsurf" && m.draft.type !== "untrimsurf")) return;
    const f = m.draft;
    if (f.type === "fillsurf" || f.type === "extendsurf" || f.type === "untrimsurf") {
      // Fill: the clicked point says which opening; Extend: the surface body to grow.
      const h = this.host.faceAt(e.clientX, e.clientY);
      const fr = h ? this.faceRef(h.faceId) : null;
      if (!fr || !this.isSheetFace(h!.faceId) || fr.name.startsWith(`${f.id}:`)) { toast(t("Pick a surface body.")); return; }
      f.surface = fr;
      if (f.type === "fillsurf") f.at = h!.point;
      this.draftChanged();
      return;
    }
    if (f.type === "trimsurf") {
      // Trim: the surface, then the tool (a plane or flat face, or another surface), then the pieces to keep.
      const focus = m.focus ?? "tsurf";
      if (focus === "ttool" && f.toolKind !== "surface") {
        const r = this.pickRef(e);
        if (!r) { toast(t("Pick a plane or a flat face.")); return; }
        f.tool = { plane: r };
        m.focus = "keep";
        this.draftChanged();
        return;
      }
      const h = this.host.faceAt(e.clientX, e.clientY);
      const fr = h ? this.faceRef(h.faceId) : null;
      if (!fr || !this.isSheetFace(h!.faceId)) { toast(t("Pick a surface body.")); return; }
      if (focus === "tsurf") { f.surface = fr; m.focus = "ttool"; }
      else if (focus === "ttool") { f.tool = { surface: fr }; m.focus = "keep"; }
      else { const i = f.keep.findIndex(x => x.name === fr.name && !!x.hint && !!fr.hint && d3v(x.hint, fr.hint) < 1e-3); if (i >= 0) f.keep.splice(i, 1); else f.keep = [fr]; }
      this.draftChanged();
      return;
    }
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
      const ok = type === "planesurf" ? sketchRegionsOk : curves;
      const sk = (sel && ok(sel) ? sel : undefined) ?? sketches.filter(s => !used.has(s.id) && !this.doc.features.some(g => absorbs(g, s.id)) && ok(s)).at(-1) ?? sketches.filter(ok).at(-1);
      if (!sk) { toast(t(type === "planesurf" ? "Draw a closed sketch first." : "Draw a sketch first."), true); return null; }
      return type === "planesurf" ? { id, type, name: nm, sketch: sk.id } satisfies PlaneSurfFeature
        : { id, type, name: nm, sketch: sk.id, depth: { v: 10 } } satisfies ExtrudeSurfFeature;
    }
    if (type === "revsurf") {
      const hasLine = (s: SketchFeature) => s.ents.some(e => e.t === "line") && s.ents.filter(e => !e.cons && e.t !== "point").length > 0;
      const sk = (sel && hasLine(sel) ? sel : undefined) ?? sketches.filter(s => !used.has(s.id) && !this.doc.features.some(g => absorbs(g, s.id)) && hasLine(s)).at(-1) ?? sketches.filter(hasLine).at(-1);
      if (!sk) { toast(t("Draw a sketch with a line for the axis first."), true); return null; }
      const lines = sk.ents.filter(e => e.t === "line");
      return { id, type, name: nm, sketch: sk.id, axis: (lines.find(l => l.cons) ?? lines[0]).id, angle: { v: 2 * Math.PI } } satisfies RevolveSurfFeature;
    }
    if (type === "sweepsurf") {
      // Profile: the selected (or last unused) chain sketch; path: the last helix or curve, else another unused sketch.
      const chain = (s: SketchFeature) => !sketchPath(s).error;
      const free = sketches.filter(s => !used.has(s.id) && !this.doc.features.some(g => absorbs(g, s.id)) && chain(s));
      const sel = this.selected ? sketches.find(s => s.id === this.selected && chain(s)) : undefined;
      const end = this.doc.rollback ?? this.doc.features.length;
      const curve = this.doc.features.slice(0, end).filter(g => (g.type === "helix" || g.type === "curve" || g.type === "sketch3d") && !g.suppressed).at(-1);
      const profile = sel ?? (curve ? free.at(-1) : free.at(-2) ?? free.at(-1));
      if (!profile) { toast(t("Draw a profile sketch first: one chain of curves, open or closed."), true); return null; }
      const pathSk = free.filter(s => s !== profile).at(-1);
      const sw: SweepSurfFeature = { id, type, name: nm, profile: profile.id };
      if (curve) sw.path = curve.type === "helix" ? { helix: curve.id } : { curve: curve.id }; else if (pathSk) sw.path = { sketch: pathSk.id };
      return sw;
    }
    if (type === "loftsurf") {
      const chain = (s: SketchFeature) => !sketchPath(s).error;
      const free = sketches.filter(s => !used.has(s.id) && !this.doc.features.some(g => absorbs(g, s.id)) && chain(s));
      return { id, type, name: nm, profiles: free.slice(-2).map(s => s.id) } satisfies LoftSurfFeature;
    }
    if (!this.last?.data) { toast(t("There is no body yet."), true); return null; }
    const fr = face != null ? this.faceRef(face) : null;
    if (type === "offsurf") return { id, type, name: nm, faces: fr ? [fr] : [], distance: { v: 5 } } satisfies OffsetSurfFeature;
    const onSheet = fr && face != null && this.isSheetFace(face) ? fr : null;
    if (!(this.last.sheetFaces ?? 0)) { toast(t("There are no surface bodies yet."), true); return null; }
    if (type === "knit") return { id, type, name: nm, surfaces: onSheet ? [onSheet] : [], tol: { v: 0.01 } } satisfies KnitFeature;
    if (type === "trimsurf") return { id, type, name: nm, surface: onSheet ?? undefined, keep: [] } satisfies TrimSurfFeature;
    if (type === "fillsurf") return { id, type, name: nm, surface: onSheet ?? undefined } satisfies FillSurfFeature;
    if (type === "extendsurf") return { id, type, name: nm, surface: onSheet ?? undefined, distance: { v: 5 } } satisfies ExtendSurfFeature;
    if (type === "untrimsurf") return { id, type, name: nm, surface: onSheet ?? undefined } satisfies UntrimSurfFeature;
    if (type === "replaceface") return { id, type, name: nm, faces: fr && !onSheet ? [fr] : [], surface: onSheet ?? undefined } satisfies ReplaceFaceFeature;
    return { id, type, name: nm, surface: onSheet ?? undefined, thickness: { v: 2 }, side: "one" } satisfies ThickenFeature;
  }

  /** PropertyManager groups for the surface features (FRS 9.11). */
  private surfPanel(f: PlaneSurfFeature | ExtrudeSurfFeature | OffsetSurfFeature | KnitFeature | ThickenFeature | ReplaceFaceFeature | RevolveSurfFeature | LoftSurfFeature | TrimSurfFeature | FillSurfFeature | ExtendSurfFeature | UntrimSurfFeature, sketches: SketchFeature[], group: (legend: string, inner: string) => string,
    numField: (key: string, label: string, n: Num, q: "length" | "angle") => string, chk: (k: string, on: boolean | undefined, label: string) => string): { title: string; body: string } {
    const opt = (v: string, l: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;
    const sel = (k: string, label: string, inner: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${k}">${inner}</select></label>`;
    const skOpts = (list: SketchFeature[], cur: string) => list.map(s => `<option value="${esc(s.id)}"${s.id === cur ? " selected" : ""} translate="no">${esc(featureLabel(s.name))}</option>`).join("");
    const help = (s: string) => `<p class="pm-help muted">${esc(s)}</p>`;
    if (f.type === "planesurf") {
      const list = sketches.filter(s => sketchRegionsOk(s) || s.id === f.sketch);
      const ct = this.contoursGroup(f, this.mode.kind === "feature" ? this.mode.focus : undefined);
      return { title: t("Planar Surface"), body: (this.needsContours(f) ? ct : "") + group(t("Bounding entities"), sel("sketch", t("Sketch"), skOpts(list, f.sketch))) + (this.needsContours(f) ? "" : ct) + help(t("A closed sketch becomes a flat surface body: no volume, ready to knit or thicken.")) };
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
    if (f.type === "revsurf") {
      const list = sketches.filter(s => s.ents.some(e => e.t === "line") || s.id === f.sketch);
      const sk = sketches.find(s => s.id === f.sketch);
      const lines = (sk?.ents ?? []).filter(e => e.t === "line");
      return { title: t("Surface-Revolve"), body: group(t("Axis of revolution"), sel("sketch", t("Sketch"), skOpts(list, f.sketch))
          + sel("rsaxis", t("Axis"), lines.map((l, i) => opt(l.id, `${t("Line")} ${i + 1}${l.cons ? ` (${t("construction")})` : ""}`, f.axis)).join("")))
        + group(t("Direction 1"), numField("angle", t("Angle"), f.angle, "angle") + chk("flip", f.flip, t("Reverse direction")))
        + help(t("Every curve of the sketch but the axis turns about it into a surface.")) };
    }
    if (f.type === "loftsurf") {
      const chains = sketches.filter(s => !sketchPath(s).error || f.profiles.includes(s.id));
      const pick = (cur: string, none: string) => (cur ? "" : `<option value="" selected>${esc(none)}</option>`) + chains.map(s => `<option value="${esc(s.id)}"${s.id === cur ? " selected" : ""} translate="no">${esc(featureLabel(s.name))}</option>`).join("");
      const rows = f.profiles.map((id, i) => sel(`lp${i}`, `${t("Profile")} ${i + 1}`, `<option value="">${esc(t("Remove"))}</option>` + pick(id, ""))).join("")
        + sel(`lp${f.profiles.length}`, t("Add profile"), pick("", "—"));
      return { title: t("Surface-Loft"), body: group(t("Profiles"), rows) + group(t("Options"), chk("ruled", f.ruled, t("Ruled surface")))
        + help(t("Each profile is one chain of curves, open or closed; the surface runs through them in order.")) };
    }
    if (f.type === "trimsurf") {
      const m = this.mode.kind === "feature" ? this.mode : null;
      const fc = m?.focus ?? "tsurf";
      const box = (focus: string, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${fc === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      const toolLabel = !f.tool ? t("None") : "plane" in f.tool ? this.refLabel(f.tool.plane) : t("Surface picked");
      return { title: t("Trim Surface"), body: group(t("Trim tool"), box("tsurf", t("Surface to trim"), f.surface ? t("Surface picked") : t("None"))
          + sel("toolKind", t("Trim with"), opt("plane", t("Plane or flat face"), f.toolKind ?? "plane") + opt("surface", t("Surface"), f.toolKind ?? "plane"))
          + box("ttool", t("Trim tool"), toolLabel) + box("keep", t("Piece to keep"), f.keep.length ? t("Picked") : t("Larger piece")))
        + help(fc === "tsurf" ? t("Click the surface body to trim.") : fc === "ttool" ? t("Click a plane or flat face, or a surface, that crosses it.") : t("Click the piece to keep; the other side of the tool goes.")) };
    }
    if (f.type === "fillsurf") {
      return { title: t("Filled Surface"), body: group(t("Patch boundary"), `<div class="pm-field"><span>${esc(t("Surface"))}</span><button class="pm-box focus" translate="no">${esc(f.surface ? t("Surface picked") : t("None"))}</button></div>`
          + chk("merge", f.merge !== false, t("Merge result")))
        + help(t("Click a surface body next to the opening to fill: the patch runs through its edges. With Merge result the patch is sewn to the surface.")) };
    }
    if (f.type === "untrimsurf") {
      const o = (v: string, l: string) => `<option value="${v}"${(f.mode ?? "all") === v ? " selected" : ""}>${esc(l)}</option>`;
      return { title: t("Untrim Surface"), body: group(t("Selections"), `<div class="pm-field"><span>${esc(t("Surface"))}</span><button class="pm-box focus" translate="no">${esc(f.surface ? t("Surface picked") : t("None"))}</button></div>`
          + `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="untrimMode">${o("all", t("All edges (natural bounds)"))}${o("holes", t("Internal edges (fill holes)"))}</select></label>`)
        + help(t("Click a surface body of one face: it goes back to the bounds of its underlying surface, or only its holes are filled.")) };
    }
    if (f.type === "extendsurf") {
      return { title: t("Extend Surface"), body: group(t("End condition"), `<div class="pm-field"><span>${esc(t("Surface"))}</span><button class="pm-box focus" translate="no">${esc(f.surface ? t("Surface picked") : t("None"))}</button></div>`
          + numField("distance", t("Distance"), f.distance, "length"))
        + help(t("Click a surface body of one face: it grows past all its edges by this distance, following its own shape.")) };
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
    if ((f.type === "combine" || f.type === "indent") && (m.focus === "main" || !f.main)) { f.main = fr; m.focus = "bodies"; this.draftChanged(); return; }
    const list = f.type === "combine" || f.type === "indent" ? f.tools : f.bodies;
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
    if (m.focus === "hupto" && f.end === "vertex") {
      const v = this.pickVertex(e);
      if (!v) return;
      f.upToVertex = v;
      m.focus = "pts";
      this.draftChanged();
      return;
    }
    if (m.focus === "hupto" && (f.end === "upto" || f.end === "offset")) {
      const r = this.pickRef(e);
      if (!r || ("face" in r && own(r.face.name))) return;
      f.upTo = r;
      m.focus = "pts";
      this.draftChanged();
      return;
    }
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

  /** Hole panel preview (FR-FT-051 UX): the half section of the hole in a plate and the callout it gets on drawings. */
  private holePreview(f: HoleFeature): string {
    const fu = UNITS[units.current].f, dec = units.decimals ?? this.doc.units.decimals;
    const len = (v: number) => trimNum(v * fu, Math.max(dec, 2)), ang = (v: number) => trimNum(v, 2);
    const s = holeSection(f), lines = holeCallout(f, len, ang, x => t(x), f.pts.length);
    return `<div class="pm-hpreview" data-hpreview>${s ? holeDiagram(s) : ""}<div class="pm-hcallout" translate="no" aria-label="${esc(t("Callout"))}">${lines.map(l => `<div>${esc(l)}</div>`).join("")}</div>`
      + `<p class="pm-help muted">${esc(f.plane ? t("Click on the face to place holes; click a hole again to remove it.") : t("Click the flat face (or a plane) for the holes."))}</p></div>`;
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

  /** The part's coordinate system features that are built (not suppressed or rolled back), with their frames. */
  csysList(): { id: string; name: string; o: V3; x: V3; z: V3 }[] {
    if (!this.store || !this.last) return [];
    const end = this.doc.rollback ?? this.doc.features.length;
    return this.doc.features.slice(0, end).flatMap(f => {
      const fr = f.type === "csys" && !f.suppressed ? this.last!.frames[f.id] : undefined;
      return fr ? [{ id: f.id, name: featureLabel(f.name), o: fr.o, x: fr.x, z: fr.n }] : [];
    });
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
    this.arrows = [];
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
    this.drawHover();
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
    if (m.kind === "feature" && hasContours(m.draft)) this.drawContours(m.draft, m.focus === "contours", dark);
    if (!(m.kind === "feature" && m.focus === "contours") && this.ctHover !== -1) this.hoverContour(null);
    // Helix and 3D curves (FR-FT-083, FR-FT-085): drawn like sketch curves; the one being edited highlighted.
    for (const [id, pts] of Object.entries(this.last?.curves ?? {})) {
      const hf = this.doc.features.find(x => x.id === id);
      const editing = m.kind === "feature" && m.draft.id === id;
      if (!editing && ((hf?.type !== "helix" && hf?.type !== "curve") || hf.hidden || hf.suppressed)) continue;
      const pos: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) pos.push(...pts[i], ...pts[i + 1]);
      this.lines(pos, editing ? 0xf08c00 : dark ? 0x8ab4ff : 0x1d4ed8, editing ? 2.2 : 1.4);
    }
    this.draw3dSketches();
    // Flattened sheet metal (FR-FT-120): bend lines on the flat pattern, up bends one colour, down the other.
    const fp = this.doc.features.find(f => f.type === "smflat");
    const fpAt = fp ? this.doc.features.indexOf(fp) : -1;
    if (fp && !fp.suppressed && fpAt < end && this.last?.sheet && this.last.statuses.find(s => s.id === fp.id)?.ok) {
      for (const up of [true, false]) {
        const pos: number[] = [];
        for (const b of flatBendLines(this.last.sheet)) if (b.up === up) pos.push(...b.a, ...b.b);
        if (pos.length) this.lines(pos, up ? 0x2f9e44 : 0xc2255c, 1.6);
      }
    }
    // Cross breaks: crossed lines on the faces (or the flat pattern), dashed look by a lighter colour.
    if (this.last?.sheet?.crosses?.length) {
      const flat = !!fp && !fp.suppressed && fpAt < end && !!this.last.statuses.find(s => s.id === fp.id)?.ok;
      const pos: number[] = [];
      for (const c of crossBreakLines(flat ? this.last.sheet : placedState(this.last.sheet), flat)) pos.push(...c.a, ...c.b);
      if (pos.length) this.lines(pos, 0x7048e8, 1.4);
    }
    // Unfolded bends: their bend lines on the flat strips.
    if (this.last?.sheet?.unfold) {
      for (const up of [true, false]) {
        const pos: number[] = [];
        for (const b of unfoldBendLines(this.last.sheet)) if (b.up === up) pos.push(...b.a, ...b.b);
        if (pos.length) this.lines(pos, up ? 0x2f9e44 : 0xc2255c, 1.6);
      }
    }
    const picksPlanes = m.kind === "plane" || (m.kind === "feature" && ((m.draft.type === "plane" && m.focus !== "axis") || (m.draft.type === "extrude" && ["upto", "upto2", "start-surface"].includes(this.extrudeTarget(m.draft, m.focus) ?? "")) || (m.draft.type === "revolve" && m.draft.end === "upto") || (m.draft.type === "lpattern" && (m.focus === "pref" || m.focus === "pref2"))));
    this.drawPlanes(picksPlanes);
    this.drawHoles();
    this.drawThreads();
    this.drawWeldSymbols();
    this.drawCornerCallouts();
    this.drawPatternSpots();
    this.drawInstant();
    if (m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer")) {
      // The picked edges are drawn by drawBoxPicks in the Edges box's colour (FR-SEL-011).
      this.drawRoundPreview(m.draft);
    }
    if (m.kind === "feature" && m.draft.type === "curve" && m.draft.kind === "composite") {
      const pos: number[] = [];
      for (const r of m.draft.edges ?? []) { const ed = this.edgeOf(r); if (ed) pushEdge(pos, ed); }
      this.lines(pos, 0xf08c00, 4);
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
    this.drawBoxPicks();
    this.drawValueCallouts();
    this.host.viewer.invalidate();
  }

  /**
   * Value callouts (FR-UI-110): the main values of the open feature (thickness, angle, distance, spacing, count…)
   * in small labels on the model by its result, as in SolidWorks. A click opens the Modify box; the value goes
   * through the panel's own field, so both stay in step. A ⇄ beside the first one reverses the direction.
   * Features with drag handles or their own callouts (extrude, revolve, fillet, chamfer, end cap, gusset, flange) keep those.
   */
  private drawValueCallouts() {
    const layer = document.getElementById("mc-layer");
    layer?.querySelectorAll(".mc-vcall").forEach(x => x.remove());
    const m = this.mode, pm = document.getElementById("mc-pm");
    if (m.kind !== "feature" || !layer || !pm || !this.last) return;
    const f = m.draft;
    if (VALUE_CALLOUT_SKIP.has(f.type)) return;
    // Picking instances to skip: the instance dots stand where the callouts would, so the callouts step aside.
    if (m.focus === "skip") return;
    const fields = VALUE_KEYS.map(k => pm.querySelector<HTMLInputElement>(`input[data-num="${k}"], input[data-int="${k}"]`)).filter((x): x is HTMLInputElement => !!x && !x.closest("[hidden]"));
    if (!fields.length) return;
    const at = this.calloutPoint(f);
    if (!at) return;
    const flip = pm.querySelector<HTMLInputElement>('input[type=checkbox][data-k="flip"]');
    fields.forEach((inp, row) => {
      const lab = inp.closest(".pm-field")?.querySelector("span")?.textContent ?? "";
      const unit = inp.parentElement?.querySelector(".muted")?.textContent ?? "";
      const key = inp.dataset.num ?? inp.dataset.int!;
      const el = document.createElement("span");
      el.className = "mc-callout mc-vcall";
      el.dataset.at = JSON.stringify(at);
      el.dataset.row = String(row);
      el.dataset.v = key;
      const b = document.createElement("button");
      b.className = "mc-handle";
      b.title = t("Click to type the value");
      b.textContent = `${lab}: ${inp.value}${unit === "°" ? "°" : unit ? ` ${unit}` : ""}`;
      b.addEventListener("click", () => {
        const r = b.getBoundingClientRect();
        new ModifyBox({
          at: { x: r.right, y: r.top + r.height / 2 }, title: lab, value: inp.value,
          step: inp.dataset.int ? 1 : stepFor(inp.dataset.q === "angle" ? "angle" : "length", units.current),
          accept: text => {
            inp.value = text;
            inp.dispatchEvent(new Event("change"));
            return inp.getAttribute("aria-invalid") !== "true";
          },
          cancel: () => {},
        });
      });
      el.append(b);
      if (row === 0 && flip) {
        const fb = document.createElement("button");
        fb.className = "mc-handle mc-vflip";
        fb.textContent = "⇄";
        fb.title = t("Reverse direction");
        fb.setAttribute("aria-label", t("Reverse direction"));
        fb.addEventListener("click", () => { flip.click(); });
        el.append(fb);
      }
      layer.append(el);
    });
    this.placeCallouts();
  }

  /** Where a feature's value callouts sit: the middle of its own faces in the last rebuild, else of the faces it picked. */
  private calloutPoint(f: Feature): V3 | null {
    const data = this.host.viewer.parts[0]?.data, names = this.last?.faceNames;
    if (!data || !names) return null;
    const pre = `${f.id}:`, own: number[] = [];
    names.forEach((n, i) => { if (n?.startsWith(pre)) own.push(i); });
    if (!own.length) {
      const refs = ((f as { faces?: FaceRef[] }).faces ?? []);
      for (const r of refs) { const i = names.indexOf(r.name); if (i >= 0) own.push(i); }
    }
    if (!own.length) return null;
    const c = [0, 0, 0];
    for (const i of own) { const fc = data.faces[i]; if (!fc) continue; c[0] += fc.center[0]; c[1] += fc.center[1]; c[2] += fc.center[2]; }
    return [c[0] / own.length, c[1] / own.length, c[2] / own.length];
  }

  /**
   * Colour-coded selection boxes (FR-SEL-011): each selection box of the open feature's panel has its own colour,
   * its picks are drawn in that colour in the view, with a small tag naming the box at the first one.
   */
  private boxPicks(d: Feature): { focus: string; label: string; faces?: FaceRef[]; edges?: EdgeRef[]; sel?: string }[] {
    const pf = (p?: PlaneRef) => (p && "face" in p ? [p.face] : []);
    switch (d.type) {
      case "fillet":
        if (d.kind === "face" || d.kind === "full") return [
          { focus: "fs1", label: d.kind === "full" ? t("Side face set 1") : t("Face set 1"), faces: d.faces1 ?? [] },
          ...(d.kind === "full" ? [{ focus: "fc", label: t("Center face set"), faces: d.center ?? [] }] : []),
          { focus: "fs2", label: d.kind === "full" ? t("Side face set 2") : t("Face set 2"), faces: d.faces2 ?? [] }];
        return [{ focus: "edges", label: t("Edges"), edges: d.edges, sel: ".pm-count" }];
      case "chamfer": return d.mode === "vertex" ? [] : [{ focus: "edges", label: t("Edges"), edges: d.edges, sel: ".pm-count" }];
      case "draft": return [{ focus: "nplane", label: d.kind === "parting" ? t("Direction of pull") : t("Neutral plane"), faces: pf(d.plane) },
        d.kind === "parting" ? { focus: "faces", label: t("Parting line"), edges: d.parting ?? [] } : { focus: "faces", label: t("Faces to draft"), faces: d.faces }];
      case "shell": return [{ focus: "faces", label: t("Faces to remove"), faces: d.faces }, ...(d.multi?.length ? [{ focus: "mthick", label: t("Multi-thickness settings"), faces: d.multi.map(x => ({ name: x.name, ...(x.hint ? { hint: x.hint } : {}) })) }] : [])];
      case "delface": case "moveface": case "offsurf": case "replaceface": case "split":
        return [{ focus: "faces", label: t("Faces"), faces: d.faces }];
      // End and start references (AT-UX-6): the target face in the Up to box's colour, named by its tag.
      case "extrude": return [
        ...(d.start === "surface" ? [{ focus: "start", label: t("Start at"), faces: pf(d.startRef) }] : []),
        ...(d.end === "upto" || d.end === "offset" ? [{ focus: "upto", label: t("Up to"), faces: pf(d.upTo) }] : []),
        ...(d.end === "body" ? [{ focus: "upbody", label: t("Body"), faces: d.upToBody ? [d.upToBody] : [] }] : []),
        ...(dir2Apart(d) && (d.end2 === "upto" || d.end2 === "offset") ? [{ focus: "upto2", label: t("Up to (direction 2)"), faces: pf(d.upTo2) }] : []),
        ...(dir2Apart(d) && d.end2 === "body" ? [{ focus: "upbody2", label: t("Body (direction 2)"), faces: d.upToBody2 ? [d.upToBody2] : [] }] : [])];
      case "revolve": return d.end === "upto" ? [{ focus: "upto", label: t("Up to"), faces: pf(d.upTo), sel: '.pm-box[data-k="focus-upto"]' }] : [];
      case "hole": return [{ focus: "hplane", label: t("Face"), faces: pf(d.plane) },
        ...(d.end === "upto" || d.end === "offset" ? [{ focus: "hupto", label: t("Up to"), faces: pf(d.upTo) }] : [])];
      case "mirror": return [{ focus: "mplane", label: t("Plane"), faces: pf(d.plane) },
        ...(d.copy === "faces" ? [{ focus: "faces", label: t("Faces"), faces: d.faces ?? [] }] : [])];
      case "lpattern": case "cpattern": case "spattern":
        return d.copy === "faces" ? [{ focus: "faces", label: t("Faces"), faces: d.faces ?? [] }] : [];
      case "bsplit": return [{ focus: "mplane", label: t("Plane"), faces: pf(d.plane) }];
      default: return [];
    }
  }

  /** The panel's selection boxes take their colours (also after a panel re-render). */
  private tintBoxes() {
    const m = this.mode, pm = document.getElementById("mc-pm");
    pm?.querySelectorAll<HTMLElement>("[data-boxc]").forEach(el => { el.style.removeProperty("--box-c"); delete el.dataset.boxc; });
    if (m.kind !== "feature" || !pm) return;
    this.boxPicks(m.draft).forEach((g, k) => {
      const el = pm.querySelector<HTMLElement>(g.sel ?? `.pm-box[data-focus="${g.focus}"]`);
      if (el) { el.style.setProperty("--box-c", `#${BOX_COLORS[k % BOX_COLORS.length].toString(16).padStart(6, "0")}`); el.dataset.boxc = String(k); }
    });
  }

  private drawBoxPicks() {
    const m = this.mode;
    this.tintBoxes();
    if (m.kind !== "feature") return;
    const part = this.host.viewer.parts[0], names = this.last?.faceNames;
    const groups = this.boxPicks(m.draft);
    groups.forEach((g, k) => {
      const col = BOX_COLORS[k % BOX_COLORS.length];
      const css = `#${col.toString(16).padStart(6, "0")}`;
      let at: V3 | null = null;
      // Edges in the box's colour (the fillet/chamfer edges keep their usual width).
      if (g.edges?.length) {
        const pos: number[] = [];
        for (const r of g.edges) { const ed = this.edgeOf(r); if (ed) { pushEdge(pos, ed); at ??= ed.mid; } }
        if (pos.length) this.lines(pos, col, 4);
      }
      // Faces: a see-through overlay in the colour.
      if (g.faces?.length && part && names) {
        const want = new Set(g.faces.map(f => f.name));
        const geo = part.mesh.geometry as THREE.BufferGeometry, pos = geo.getAttribute("position"), idx = geo.getIndex();
        const out: number[] = [];
        part.data.faces.forEach((fc, i) => {
          if (!want.has(names[i] ?? "")) return;
          for (let tri = fc.triStart; tri < fc.triStart + fc.triCount; tri++) for (let q = 0; q < 3; q++) {
            const vi = idx ? idx.getX(tri * 3 + q) : tri * 3 + q;
            out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          }
          if (!at && fc.center) at = new THREE.Vector3(...fc.center).applyMatrix4(part.mesh.matrixWorld).toArray() as V3;
        });
        if (out.length) {
          const gm = new THREE.BufferGeometry();
          gm.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
          const mesh = new THREE.Mesh(gm, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }));
          mesh.applyMatrix4(part.mesh.matrixWorld);
          mesh.renderOrder = 2310;
          mesh.raycast = () => {};
          mesh.userData.boxPick = g.focus;
          this.decor.add(mesh);
        }
      }
      if (!at || groups.length < 2 && !g.faces?.length) return;
      const tag = document.createElement("span");
      tag.className = "mc-callout mc-boxtag";
      tag.dataset.box = g.focus;
      tag.style.setProperty("--box-c", css);
      tag.textContent = g.label;
      tag.dataset.at = JSON.stringify(at);
      $("#mc-layer").appendChild(tag);
    });
    this.placeCallouts();
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
  /** Weld symbols (FR-FT-121): a one-line ISO 2553 callout on every fillet bead's weld face; a click edits the bead. */
  private drawWeldSymbols() {
    const data = this.host.viewer.parts[0]?.data, names = this.last?.faceNames;
    if (!data || !names) return;
    const m = this.mode, draft = m.kind === "feature" && m.draft.type === "weldbead" ? m.draft : null;
    const end = this.doc.rollback ?? this.doc.features.length;
    const ok = new Set((this.last?.statuses ?? []).filter(s => s.ok).map(s => s.id));
    for (const { id, text } of weldSymbols(this.doc.features.slice(0, end), draft, ok)) {
      // The weld face of its first piece (any of its faces when that one is gone).
      let i = names.findIndex(n => n.startsWith(`${id}:`) && n.endsWith(":face"));
      if (i < 0) i = names.findIndex(n => n.startsWith(`${id}:`));
      const fi = i >= 0 ? data.faces[i] : undefined;
      if (!fi) continue;
      const label = document.createElement("button");
      label.className = "mc-handle mc-callout wld-sym";
      label.dataset.weld = id;
      label.textContent = text;
      label.title = t("Weld symbol: click to edit the bead");
      label.dataset.at = JSON.stringify(fi.center);
      label.addEventListener("click", () => { if (this.mode.kind === "none") this.editFeature(id); });
      $("#mc-layer").appendChild(label);
    }
    this.placeCallouts();
  }

  /**
   * Corner callouts of an open structural member (FR-FT-121, SolidWorks' corner spheres): the treatment at
   * each corner where its segments meet; a click offers the treatments for that corner alone.
   */
  /** The Locate profile focus the view was last zoomed for (zoom once per start). */
  private locateFit: string | null = null;
  private drawCornerCallouts() {
    const m = this.mode;
    if (m.kind !== "feature" || m.draft.type !== "member") { this.locateFit = null; return; }
    const f = m.draft, ctx = this.weldCtx(m.index);
    // Locate profile: the profile's points at the start of the group's first segment; a click puts that point on the path.
    const fo = m.focus as string | undefined;
    if (!fo?.startsWith("wlocate")) this.locateFit = null;
    if (fo?.startsWith("wlocate")) {
      const gi = fo === "wlocate" ? 0 : +fo.slice(8);
      const spots = locateSpots(ctx, f, gi);
      // Zoom to the profile once when locating starts, so its points are far enough apart to click.
      if (this.locateFit !== fo && spots.length) {
        this.locateFit = fo;
        const b = new THREE.Box3();
        for (const p of spots) b.expandByPoint(new THREE.Vector3(...p.at));
        b.expandByScalar(Math.max(1, b.getSize(new THREE.Vector3()).length() / 2));
        this.host.viewer.fit(true, b);
      }
      for (const p of spots) {
        const dot = document.createElement("button");
        dot.className = `mc-handle wld-pierce${p.cur ? " cur" : ""}`;
        dot.dataset.pierce = p.key;
        dot.dataset.at = JSON.stringify(p.at);
        dot.title = p.label;
        dot.setAttribute("aria-label", t("Locate profile: {point}", { point: p.label }));
        dot.addEventListener("click", e => {
          e.stopPropagation();
          const fn = weldChange(f, gi ? `wganchor:${gi - 1}` : "anchor", p.key, ctx);
          if (fn) { fn(); m.focus = undefined; this.renderPanel(); this.drawDecor(); this.renderBar(); void this.rebuild(); }
        });
        $("#mc-layer").appendChild(dot);
      }
    }
    for (const c of cornerSpots(ctx, f)) {
      const label = document.createElement("button");
      label.className = `mc-handle mc-callout wld-corner${c.own ? " own" : ""}`;
      label.dataset.corner = c.key;
      label.dataset.at = JSON.stringify(c.at);
      label.textContent = c.text;
      label.title = t("Corner {corner}: click to change its treatment", { corner: c.label });
      label.setAttribute("aria-haspopup", "menu");
      label.addEventListener("pointerdown", e => e.stopPropagation());
      label.addEventListener("click", e => {
        e.stopPropagation();
        const r = label.getBoundingClientRect();
        this.showMenu(c.opts.map(([v, l]): [string, () => void] => [(v === c.cur ? "✓ " : "") + l, () => {
          const fn = weldChange(f, `wcorner:${c.key}`, v, ctx);
          if (fn) { fn(); this.renderPanel(); this.drawDecor(); this.renderBar(); void this.rebuild(); }
        }]), r.left, r.bottom + 4, () => label.focus());
      });
      $("#mc-layer").appendChild(label);
    }
    this.placeCallouts();
  }

  /**
   * Instances to skip (FR-FT-070/071, SolidWorks' pink dots): while the box has focus, a dot at each instance of
   * the linear or circular pattern being edited; a click skips the instance or brings it back.
   */
  private drawPatternSpots() {
    const m = this.mode;
    if (m.kind !== "feature" || m.focus !== "skip" || (m.draft.type !== "lpattern" && m.draft.type !== "cpattern")) return;
    const f = m.draft;
    const spots = this.last?.spots?.[f.id] ?? [];
    const skip = new Set(f.skip ?? []);
    for (const s of spots) {
      const off = skip.has(s.key);
      const dot = document.createElement("button");
      dot.className = `mc-handle pat-spot${off ? " off" : ""}`;
      dot.dataset.spot = s.key;
      dot.dataset.at = JSON.stringify(s.p);
      dot.setAttribute("aria-pressed", String(off));
      const label = t("Instance {n}", { n: s.key });
      dot.title = `${label}: ${off ? t("skipped, click to bring it back") : t("click to skip it")}`;
      dot.setAttribute("aria-label", t("Skip {instance}", { instance: label }));
      dot.addEventListener("pointerdown", e => e.stopPropagation());
      dot.addEventListener("click", e => {
        e.stopPropagation();
        const list = (f.skip ?? []).filter(k => k !== s.key);
        if (!off) list.push(s.key);
        list.sort((a, b) => { const pa = a.split(",").map(Number), pb = b.split(",").map(Number); return (pa[1] ?? 0) - (pb[1] ?? 0) || pa[0] - pb[0]; });
        if (list.length) f.skip = list; else delete f.skip;
        this.draftChanged();
        $("#mc-layer").querySelector<HTMLElement>(`.pat-spot[data-spot="${s.key}"]`)?.focus();
      });
      $("#mc-layer").appendChild(dot);
    }
    this.placeCallouts();
  }

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
      h.pts.forEach((p, i) => {
        if (h.kind === "tapped" && h.major) {
          const td = threadThrough(h) ? fr.len?.[i] ?? 0 : h.threadDepth?.v ?? (h.end === "through" ? 0 : h.depth.v);
          const o = at(p, 0, 0) as V3;
          if (td > 0) this.threadShade(o, (h.flip ? fr.n : [-fr.n[0], -fr.n[1], -fr.n[2]]) as V3, h.diameter.v / 2, td, h.pitch ?? Math.max(0.25, h.major * 0.15), true);
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
      });
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
  private arrowFeature(): ExtrudeFeature | RevolveFeature | EndCapFeature | GussetFeature | SmFlangeFeature | null {
    const m = this.mode;
    // Sheet metal flanges show their arrow while folded only (the flat pattern hides where the flange stands).
    const folded = () => !this.doc.features.some(x => x.type === "smflat" && !x.suppressed);
    const ok = (f: Feature | undefined): f is ExtrudeFeature | RevolveFeature | EndCapFeature | GussetFeature | SmFlangeFeature => f?.type === "revolve" || (f?.type === "extrude" && (f.end === "blind" || f.end === "mid" || dir2Blind(f)))
      || (f?.type === "endcap" && f.faces.length > 0) || (f?.type === "gusset" && !!f.face1 && !!f.face2) || (f?.type === "smflange" && f.edges.length > 0 && folded());
    if (m.kind === "feature") return ok(m.draft) ? m.draft : null;
    // A part that was closed or handed back to its assembly has no store; its last selection must not draw (exam bug 40).
    if (m.kind !== "none" || !this.selected || !this.store) return null;
    const f = this.store.feature(this.selected);
    const st = this.last?.statuses.find(x => x.id === f?.id);
    const end = this.doc.rollback ?? this.doc.features.length;
    const i = this.doc.features.findIndex(x => x.id === f?.id);
    return ok(f) && !f.suppressed && st?.ok && i < end ? f : null;
  }

  private drawArrow() {
    // While dragging, the redrawn arrows keep the one in use (a gusset has two).
    const using = this.arrowDrag?.key;
    this.drawArrows();
    if (using) this.arrow = this.arrows.find(a => a.key === using) ?? this.arrow;
  }

  private drawArrows() {
    this.arrow = null;
    this.arrows = [];
    const f = this.arrowFeature();
    if (!f) return;
    if (f.type === "endcap") { this.drawCapArrow(f); return; }
    if (f.type === "gusset") { this.drawGussetArrows(f); return; }
    if (f.type === "smflange") { this.drawFlangeArrow(f); return; }
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
    if (f.end === "blind" || mid) {
      this.placeArrow(base.clone(), dir.clone(), f.depth.v, mid, "depth");
      this.handleLabel(f.id, "depth", t("Drag the arrow to change the depth; click to type it"));
    }
    // Direction 2 (FR-FT-011): its own arrow the other way, as SolidWorks shows one per direction.
    if (dir2Blind(f)) {
      this.placeArrow(base.clone(), dir.clone().negate(), f.depth2!.v, false, "depth2");
      this.handleLabel(f.id, "depth2", t("Drag the arrow to change the depth in direction 2; click to type it"));
    }
  }

  /** The thickness arrow of an end cap (FR-FT-121): from the first capped face, outwards (or into the member). */
  private drawCapArrow(f: EndCapFeature) {
    const data = this.host.viewer.parts[0]?.data, names = this.last?.faceNames, out = capDir(f) === "out";
    // Inward / internal caps sit inside the old end: the arrow runs from the plate's outer face into the member.
    const ref = out ? f.faces[0] : { name: `${f.id}:c0:start` };
    if (!data || !names || !ref) return;
    let best = -1, bd = Infinity;
    names.forEach((n, i) => {
      const fi = data.faces[i];
      if (n !== ref.name || fi?.type !== "plane" || !fi.normal) return;
      const d = ref.hint ? Math.hypot(fi.center[0] - ref.hint[0], fi.center[1] - ref.hint[1], fi.center[2] - ref.hint[2]) : 0;
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return;
    const fi = data.faces[best];
    const base = new THREE.Vector3(...fi.center);
    const dir = new THREE.Vector3(...fi.normal!).normalize().multiplyScalar(out ? 1 : -1);
    this.placeArrow(base, dir, f.thickness.v, false, "thickness");
    this.handleLabel(f.id, "thickness", t("Drag the arrow to change the thickness; click to type it"));
  }

  /** The length arrow of an edge flange (FR-FT-120): at the tip of its first flange, pointing away from the bend. */
  private drawFlangeArrow(f: SmFlangeFeature) {
    const st = this.last?.sheet;
    const p = st?.panels.find(x => x.id === `${f.id}:p0`);
    const tip = p?.outer.find(s => s.ent === "tip"), att = p?.outer.find(s => s.ent === "att");
    if (!st || !p || tip?.kind !== "line" || att?.kind !== "line") return;
    const mid = (s: { a: [number, number]; b: [number, number] }): [number, number] => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    const m1 = mid(tip), m0 = mid(att), l = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]);
    if (!(l > 1e-9)) return;
    const end = new THREE.Vector3(...smApply(p.M, [m1[0], m1[1], st.T / 2]));
    const dir = new THREE.Vector3(...smApplyDir(p.M, [(m1[0] - m0[0]) / l, (m1[1] - m0[1]) / l, 0])).normalize();
    // The arrow's tip sits on the flange's tip at the current length; dragging moves the tip with the pointer.
    this.placeArrow(end.clone().addScaledVector(dir, -f.length.v), dir, f.length.v, false, "length");
    this.handleLabel(f.id, "length", t("Drag the arrow to change the flange length; click to type it"));
  }

  /** The leg arrows of a gusset (FR-FT-121): from the inner corner along each supporting face. */
  private drawGussetArrows(f: GussetFeature) {
    const data = this.host.viewer.parts[0]?.data, names = this.last?.faceNames;
    if (!data || !names) return;
    const faceOf = (name: string) => { const i = names.indexOf(name); const fi = i >= 0 ? data.faces[i] : undefined; return fi?.type === "plane" && fi.normal ? fi : null; };
    // The plate's faces lying on face 1 and face 2 (their normals point away from those faces).
    const on1 = faceOf(`${f.id}:on1`), on2 = faceOf(`${f.id}:on2`);
    if (!on1 || !on2) return;
    const n1 = new THREE.Vector3(...on1.normal!).negate(), n2 = new THREE.Vector3(...on2.normal!).negate();
    const L = n1.clone().cross(n2);
    if (L.length() < 1e-6) return;
    L.normalize();
    const leg = (n: THREE.Vector3, other: THREE.Vector3) => { const d = L.clone().cross(n).normalize(); return d.dot(other) < 0 ? d.negate() : d; };
    const u1 = leg(n1, n2), u2 = leg(n2, n1);
    const c = Math.min(f.chamfer?.v ?? 0, Math.min(f.d1.v, f.d2.v) * 0.9);
    // Each face runs from the chamfer (or the corner) to the leg's end along its leg: its centre is half way.
    const P = new THREE.Vector3(...on1.center).addScaledVector(u1, -(c + f.d1.v) / 2);
    const P2 = new THREE.Vector3(...on2.center).addScaledVector(u2, -(c + f.d2.v) / 2);
    P.add(P2).multiplyScalar(0.5);
    this.placeArrow(P.clone(), u1, f.d1.v, false, "d1");
    this.handleLabel(f.id, "d1", t("Drag the arrow to change the length along face 1; click to type it"));
    this.placeArrow(P.clone(), u2, f.d2.v, false, "d2");
    this.handleLabel(f.id, "d2", t("Drag the arrow to change the length along face 2; click to type it"));
  }

  /** A straight drag arrow from `base` along `dir`, its tip at `value` (Mid plane: half of it), dragging the number `key`. */
  private placeArrow(base: THREE.Vector3, dir: THREE.Vector3, value: number, mid: boolean, key: string) {
    const obj = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xf08c00, depthTest: false, transparent: true });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 10).translate(0, 0.5, 0), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 18).translate(0, 1.25, 0), mat);
    const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8).translate(0, 0.8, 0), new THREE.MeshBasicMaterial({ visible: false }));
    obj.add(shaft, head, pick);
    obj.position.copy(base).addScaledVector(dir, mid ? value / 2 : value);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    obj.renderOrder = shaft.renderOrder = head.renderOrder = 2600;
    this.decor.add(obj);
    this.arrow = { obj, pick, base, dir, scale: 1, mid, key };
    this.arrows.push(this.arrow);
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
    const a = this.arrows.at(-1);
    if (a) a.label = label;
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
    this.arrow = { obj, pick, base: c, dir: u, scale: 1, mid: !!f.mid, key: "angle", ang: { c, u, r, arc, head } };
    this.arrows.push(this.arrow);
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
    const v = this.host.viewer;
    const f = this.arrowFeature();
    for (const a of this.arrows) {
    const holder = a.ang ? a.ang.head : a.obj;
    const px = v.pxWorld(holder.position);
    a.scale = px * 70;
    holder.scale.setScalar(a.scale);
    const label = a.label;
    if (label && f) {
      const tip = a.ang ? a.ang.head.position.clone().add(a.ang.head.position.clone().sub(a.ang.c).setLength(a.scale * 0.9)) : a.obj.position.clone().addScaledVector(a.dir, a.scale * 1.5);
      const s = tip.project(v.camera);
      label.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      label.style.top = `${((1 - s.y) / 2) * v.size.y}px`;
      const val = (f as unknown as Record<string, Num | undefined>)[a.key]?.v ?? 0;
      label.textContent = a.key === "angle" ? `${trimNum((val * 180) / Math.PI, 2)}°`
        : `${trimNum(val * UNITS[units.current].f, units.decimals ?? this.doc.units.decimals)} ${units.current}`;
    }
    }
  }

  private ray(e: PointerEvent) {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    return rc;
  }

  /** Whether the pointer is on a drag arrow; the one hit becomes the arrow in use. */
  private arrowHit(e: PointerEvent) {
    const ray = this.ray(e);
    for (const a of this.arrows) {
      a.obj.updateMatrixWorld(true);
      if (ray.intersectObject(a.pick, false).length) { this.arrow = a; return true; }
    }
    return false;
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
    if (!f || !this.arrow) return;
    const key = this.arrow.key;
    // Selected in the tree (no command open): dragging edits the feature and applies on release (Instant3D).
    if (this.mode.kind === "none") {
      const i = this.doc.features.findIndex(x => x.id === f.id);
      this.mode = { kind: "feature", draft: structuredClone(f), index: i, isNew: false, instant: true };
      this.renderAll();
      // The arrows were drawn again: keep dragging the same one.
      this.arrow = this.arrows.find(a => a.key === key) ?? this.arrow;
    }
    this.arrowDrag = f.type === "revolve"
      ? { start: 0, depth: f.angle.v, moved: false, raw: this.pointerAngle(e), key }
      : { start: this.axisParam(e), depth: (f as unknown as Record<string, Num>)[key].v, moved: false, key };
    const canvas = this.host.viewer.renderer.domElement;
    canvas.style.cursor = "grabbing";
    // Keep getting the moves and the release when the pointer leaves the view.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  }

  private moveArrow(e: PointerEvent) {
    const m = this.mode, d = this.arrowDrag, a = this.arrow;
    if (m.kind === "feature" && m.draft.type === "revolve" && d && a?.ang) { this.moveAngle(e, m.draft, d); return; }
    if (m.kind !== "feature" || (m.draft.type !== "extrude" && m.draft.type !== "endcap" && m.draft.type !== "gusset" && m.draft.type !== "smflange") || !d || !a) return;
    const key = a.key;
    const k = a.mid ? 2 : 1;
    let v = d.depth + (this.axisParam(e) - d.start) * k;
    // Round to a step that suits the zoom (Shift: finer).
    const px = this.host.viewer.pxWorld(a.obj.position) * (e.shiftKey ? 1 : 6);
    const step = 10 ** Math.floor(Math.log10(Math.max(px, 1e-6)));
    const fu = UNITS[units.current].f;
    v = (Math.round((v * fu) / step) * step) / fu;
    if (!(v > 1e-6)) v = step / fu;
    const draft = m.draft as unknown as Record<string, Num>;
    if (Math.abs(v - draft[key]!.v) < 1e-12) return;
    d.moved = true;
    draft[key] = { v };
    const inp = $("#mc-pm").querySelector<HTMLInputElement>(`input[data-num=${key}]`);
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
    const draft = m.kind === "feature" && (m.draft.type === "extrude" || m.draft.type === "revolve" || isSheet(m.draft)) ? m.draft.id : null;
    const id = draft ?? (m.kind === "none" ? this.selected : null);
    if (!id) return;
    const mesh = this.featureFaceMesh(id, draft ? 0xffd43b : 0x4dabf7, draft ? 0.5 : 0.45);
    if (mesh) this.decor.add(mesh);
  }

  /** A see-through overlay of the faces a feature made (or a body / cut list item's faces), in world space; null when it has none. */
  private featureFaceMesh(id: string, color: number, opacity: number): THREE.Mesh | null {
    const part = this.host.viewer.parts[0];
    const names = this.last?.faceNames;
    if (!part || !names) return null;
    const pre = `${id}:`;
    // A body or a cut list item selected in the tree lights up its bodies' faces.
    const keys = id.startsWith("body:") ? [id.slice(5)] : id.startsWith("cut:") || id.startsWith("wsub:") ? this.cutBodies(id) : null;
    const inBody = keys ? bodyFaces(this.last?.bodies ?? [], keys) : null;
    const geo = part.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position"), idx = geo.getIndex();
    const out: number[] = [];
    part.data.faces.forEach((fc, i) => {
      if (inBody ? !inBody(i) : !names[i]?.startsWith(pre)) return;
      for (let tri = fc.triStart; tri < fc.triStart + fc.triCount; tri++) for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(tri * 3 + k) : tri * 3 + k;
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    });
    if (!out.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    mesh.applyMatrix4(part.mesh.matrixWorld);
    mesh.renderOrder = 2300;
    mesh.raycast = () => {};
    return mesh;
  }

  /** Tree rows and the view light each other up on hover (FR-UI-061), only while no command is open. */
  private bindHover() {
    const tree = document.getElementById("mc-tree");
    tree?.addEventListener("pointerover", e => {
      if (e.pointerType === "touch") return;
      const row = (e.target as HTMLElement).closest?.<HTMLElement>(".ft-row[data-id]");
      this.setHover(row?.dataset.id ?? null, "tree");
    });
    tree?.addEventListener("pointerleave", () => { if (this.hoverFrom === "tree") this.setHover(null, "tree"); });
    const canvas = this.host.viewer.renderer.domElement;
    canvas.addEventListener("pointermove", e => {
      if (e.buttons || e.pointerType === "touch") { if (this.hoverFrom === "view") this.setHover(null, "view"); this.hoverContour(null); return; }
      const x = e.clientX, y = e.clientY;
      if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
      this.hoverRaf = requestAnimationFrame(() => { this.hoverRaf = 0; this.setHover(this.featureAt(x, y), "view"); this.hoverContour(x, y); });
    });
    canvas.addEventListener("pointerleave", () => {
      if (this.hoverRaf) { cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0; }
      this.hoverContour(null);
      if (this.hoverFrom === "view") this.setHover(null, "view");
    });
  }

  /** The (unsuppressed) feature that made the face under a screen point. */
  featureAt(x: number, y: number): string | null {
    if (!this.store || !this.last || this.mode.kind !== "none") return null;
    const hit = this.host.faceAt(x, y);
    const id = hit ? this.last.faceNames[hit.faceId]?.split(":")[0] : undefined;
    const f = id ? this.store.feature(id) : undefined;
    return f && !f.suppressed ? f.id : null;
  }

  /** The hovered feature: from the tree its faces light up in the view (unless it is the selected one); from the view its tree row is marked. */
  setHover(id: string | null, from: "tree" | "view") {
    if (this.mode.kind !== "none" || !this.store) id = null;
    if (id === this.hoverId && (id === null || from === this.hoverFrom)) return;
    this.hoverId = id;
    this.hoverFrom = id ? from : null;
    this.drawHover();
  }

  private drawHover() {
    for (const c of [...this.hoverGroup.children]) {
      this.hoverGroup.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    const tree = document.getElementById("mc-tree");
    tree?.querySelectorAll(".ft-row.hover").forEach(r => r.classList.remove("hover"));
    const id = this.mode.kind === "none" ? this.hoverId : null;
    if (id && this.hoverFrom === "view") tree?.querySelector(`.ft-row[data-id="${CSS.escape(id)}"]`)?.classList.add("hover");
    // Geometry under the pointer only marks its row; the view itself already shows what is hovered.
    if (id && this.hoverFrom === "tree" && id !== this.selected) {
      const mesh = this.featureFaceMesh(id, 0x74c0fc, 0.3);
      if (mesh) this.hoverGroup.add(mesh);
    }
    this.host.viewer.invalidate();
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
    $("#mc-layer").querySelectorAll<HTMLElement>(".mc-fdim").forEach(el => {
      const s = new THREE.Vector3(...(JSON.parse(el.dataset.at!) as V3)).project(v.camera);
      el.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      el.style.top = `${((1 - s.y) / 2) * v.size.y}px`;
    });
    $("#mc-layer").querySelectorAll<HTMLElement>(".wld-pierce, .pat-spot").forEach(el => {
      const s = new THREE.Vector3(...(JSON.parse(el.dataset.at!) as V3)).project(v.camera);
      el.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      el.style.top = `${((1 - s.y) / 2) * v.size.y}px`;
    });
    $("#mc-layer").querySelectorAll<HTMLElement>(".mc-callout").forEach(el => {
      const s = new THREE.Vector3(...(JSON.parse(el.dataset.at!) as V3)).project(v.camera);
      el.style.left = `${((s.x + 1) / 2) * v.size.x}px`;
      el.style.top = `${((1 - s.y) / 2) * v.size.y - 24 + 28 * Number(el.dataset.row ?? 0)}px`;
    });
  }

  /** "Start a sketch on a plane" over an empty part (FR-HLP-005). */
  private renderEmpty() {
    const el = $("#mc-empty");
    if (el) el.hidden = !this.store || this.mode.kind !== "none" || this.doc.features.length > 0;
  }

  // ---------- DOM: command bar, tree, panel ----------

  private renderAll() { this.renderBar(); this.renderTree(); this.renderPanel(); }

  /** Label and tooltip of a part command, for the command bar, its flyouts and Ctrl+K. */
  private cmdInfo(id: string): [string, string] {
    const base: Record<string, [string, string]> = {
      sketch: [t("Sketch"), t("Sketch on a plane or a flat face")],
      extrude: [t("Extrude"), t("Extruded boss: adds material from a sketch")],
      cut: [t("Cut"), t("Extruded cut: removes material")],
      revolve: [t("Revolve"), t("Revolve a sketch around a line")],
      fillet: [t("Fillet"), t("Round edges")],
      chamfer: [t("Chamfer"), t("Bevel edges")],
      hole: [t("Hole"), t("Hole wizard: simple, counterbore, countersink and tapped holes at points on a face")],
      thread: [t("Cosmetic thread"), t("Cosmetic thread: thread data on a round edge of a cylinder, drawn as dashed circles")],
      shell: [t("Shell"), t("Shell: hollow the body, leaving picked faces open")],
      draft: [t("Draft"), t("Draft: taper faces by an angle about a neutral plane")],
      lpattern: [t("Linear pattern"), t("Linear pattern: copies of features along one or two directions")],
      cpattern: [t("Circular pattern"), t("Circular pattern: copies of features about an axis")],
      mirror: [t("Mirror"), t("Mirror features, or the whole body, about a plane")],
      spattern: [t("Sketch driven pattern"), t("Sketch driven pattern: a copy at each point of a sketch")],
      tpattern: [t("Table driven pattern"), t("Table driven pattern: copies at X/Y offsets from a table")],
      plane: [t("Plane"), t("Reference plane: offset from a plane or face, or at an angle about an edge")],
      axis: [t("Axis"), t("Reference axis: a straight edge, a round face's axis, or two planes")],
      point: [t("Point"), t("Reference point: a vertex, an arc centre, a face centre or an edge midpoint")],
      csys: [t("Coordinate system"), t("Coordinate system: an origin and X and Z directions, for measurements and export")],
      extrefs: [t("External References"), t("External references: the faces of other components this part was built on in context; lock or unlock them")],
    };
    if (base[id]) return base[id];
    const hit = [...P3_TOOLS(), ...SURF_TOOLS(), ...SM_TOOLS(), ...WELD_TOOLS()].find(x => x[0] === id);
    return hit ? [hit[1], hit[2]] : [id, id];
  }

  /** The command a running feature belongs to, to mark its button. */
  private openCmd(d: Feature): string {
    if ((d.type === "sweep" || d.type === "loft") && d.op === "cut") return `${d.type}cut`;
    if (d.type === "extrude" && d.op === "cut") return "cut";
    if (d.type === "spattern" && d.src === "table") return "tpattern";
    if (d.type === "smtab") return "smbase";
    return d.type;
  }

  /** Quick commands at the right of the tab strip (SolidWorks keeps them in the menu bar): filter, undo, save. */
  private renderQuick() {
    const q = $("#mc-quick");
    if (!this.store) { q.hidden = true; q.innerHTML = ""; return; }
    q.hidden = false;
    const m = this.mode, busy = m.kind !== "none" && m.kind !== "sketch", sk = m.kind === "sketch";
    // A disabled button says why (FR-UI-112): `data-why` shows in its tooltip.
    const btn = (id: string, label: string, title: string, on = false, dis = false, why = "") =>
      `<button class="mc-b${on ? " on" : ""}" data-c="${id}" title="${esc(title)}"${on ? ' aria-pressed="true"' : ""}${dis ? " disabled" : ""}${dis && why ? ` data-why="${esc(why)}"` : ""}><span class="mc-i" aria-hidden="true">${ICON_SVG[id] ?? ""}</span><span class="mc-l">${esc(label)}</span></button>`;
    // Inside a feature command, Undo / Redo step the panel's own changes (FR-UI-108).
    const inCmd = m.kind === "feature";
    const canUndo = sk ? this.store.canUndo : inCmd ? this.draftCan(-1) : !busy && this.store.canUndo, canRedo = sk ? this.store.canRedo : inCmd ? this.draftCan(1) : !busy && this.store.canRedo;
    const whyNot = (redo: boolean) => busy && !inCmd ? t("Finish or cancel the command first.") : inCmd ? t(redo ? "Nothing to redo in this command." : "Nothing to undo in this command.") : t(redo ? "Nothing to redo." : "Nothing to undo.");
    q.innerHTML = (sk ? "" : btn("filter", t("Filter"), t("Selection filter: faces, edges, vertices (F5)"), !!document.getElementById("mc-filter") || !(SEL_FILTER.faces && SEL_FILTER.edges && SEL_FILTER.vertices)) + `<div class="mc-sep"></div>`)
      + `<span class="mc-fly">${btn("undo", t("Undo"), inCmd ? t("Undo in this command (Ctrl+Z)") : this.undoTip(), false, !canUndo, whyNot(false))}${sk ? "" : `<button class="mc-caret" data-fly="undo" aria-haspopup="menu" title="${esc(t("Undo list"))}" aria-label="${esc(t("Undo list"))}"${busy || !(this.store.canUndo || this.store.canRedo) ? " disabled" : ""}>▾</button>`}</span>`
      + btn("redo", t("Redo"), inCmd ? t("Redo in this command (Ctrl+Y)") : this.undoTip(true), false, !canRedo, whyNot(true))
      + (sk && m.kind === "sketch" ? this.quickSnapButton(m.editor) + this.sketchToggles(m.editor) : "")
      + (sk ? "" : `<div class="mc-sep"></div><span class="mc-fly">${btn("save", t("Save"), t("Save the part as .mcadprt (Ctrl+S)"))}<button class="mc-caret" data-fly="save" aria-haspopup="menu" title="${esc(t("More save options"))}" aria-label="${esc(t("More save options"))}">▾</button></span>` + btn("step", t("STEP"), t("Export the body as STEP")));
    q.querySelectorAll<HTMLButtonElement>("[data-c]").forEach(b => b.addEventListener("click", () => this.command(b.dataset.c!)));
    q.querySelector<HTMLElement>('[data-fly="undo"]')?.addEventListener("click", e => this.historyMenu(e.currentTarget as HTMLElement));
    q.querySelectorAll<HTMLButtonElement>("[data-qt]").forEach(b => b.addEventListener("click", () => this.sketchToggle(b.dataset.qt as "grid" | "gridsnap" | "autorels" | "adddims")));
    q.querySelector<HTMLElement>('[data-fly="qsnap"]')?.addEventListener("click", e => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.quickSnapMenu(r.left, r.bottom + 4, () => $("#mc-quick").querySelector<HTMLElement>('[data-fly="qsnap"]')?.focus());
    });
    q.querySelector<HTMLElement>('[data-fly="save"]')?.addEventListener("click", e => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.showMenu([[t("Save as…"), () => void this.save(true)], [t("Snapshots…"), () => void this.showSnapshots()]], r.left - 40, r.bottom + 4,
        () => $("#mc-quick").querySelector<HTMLElement>('[data-fly="save"]')?.focus());
    });
  }

  /** The quick snap button in the quick access bar while sketching (FR-SK-046); shows the active snap. */
  private quickSnapButton(ed: SketchEditor): string {
    const on = ed.quickSnap ? SNAP_KINDS.find(k => k[0] === ed.quickSnap)![1] : null;
    const title = t("Quick snaps: pick one snap type for the next point");
    return `<div class="mc-sep"></div><button class="mc-b mc-qsnap${on ? " on" : ""}" data-fly="qsnap" aria-haspopup="menu" title="${esc(title)}"${on ? ' aria-pressed="true"' : ""}><span class="mc-i" aria-hidden="true">⌖</span><span class="mc-l">${esc(on ? t(on) : t("Quick snaps"))} ▾</span></button>`;
  }

  /** Grid, snap to grid and automatic relations toggles in the quick access bar while sketching (FR-UI-055). */
  private sketchToggles(ed: SketchEditor): string {
    const tg = (k: string, icon: string, label: string, title: string, on: boolean) =>
      `<button class="mc-b mc-qt${on ? " on" : ""}" data-qt="${k}" title="${esc(title)}" aria-pressed="${on}"><span class="mc-i" aria-hidden="true">${icon}</span><span class="mc-l">${esc(label)}</span></button>`;
    return tg("grid", "#", t("Grid"), t("Show grid"), ed.grid)
      + tg("gridsnap", "⌗", t("Snap to grid"), t("Points that snap to nothing else go to the nearest grid point; hold Ctrl to place freely."), ed.gridSnap)
      + tg("autorels", "⊥", t("Inferences"), t("Lines snap horizontal, vertical, perpendicular, parallel or tangent and keep that relation; hold Ctrl to draw without them."), ed.autoRels)
      + tg("adddims", "↔", t("Add dimensions"), t("New lines, rectangles, circles and arcs get their sizes as dimensions and the Modify box opens on each."), ed.addDims);
  }

  /** Flips one sketch toggle, remembers it, and keeps the quick bar and the sketch panel in step. */
  private sketchToggle(k: "grid" | "gridsnap" | "autorels" | "adddims") {
    const m = this.mode;
    if (m.kind !== "sketch") return;
    const ed = m.editor;
    if (k === "grid") ed.setGrid({ show: !ed.grid });
    else if (k === "gridsnap") ed.setGrid({ snap: !ed.gridSnap, show: ed.gridSnap ? undefined : true });
    else if (k === "adddims") ed.addDims = !ed.addDims;
    else ed.autoRels = !ed.autoRels;
    try {
      localStorage.setItem("mc:skAddDims", ed.addDims ? "1" : "0");
      localStorage.setItem("mc:skGrid", ed.grid ? "1" : "0");
      localStorage.setItem("mc:skGridSnap", ed.gridSnap ? "1" : "0");
      localStorage.setItem("mc:autoRels", ed.autoRels ? "1" : "0");
    } catch { /* private mode */ }
    const pm = document.getElementById("mc-pm");
    const box = (a: string, v: boolean) => { const i = pm?.querySelector<HTMLInputElement>(`[data-a=${a}]`); if (i) i.checked = v; };
    box("grid", ed.grid); box("gridsnap", ed.gridSnap); box("autorels", ed.autoRels); box("adddims", ed.addDims);
    this.renderQuick();
    $("#mc-quick").querySelector<HTMLElement>(`[data-qt="${k}"]`)?.focus();
  }

  private wasSketch = false;
  private inBar = false;
  private wasCmd = false;
  /** The fly-out tree is folded to its title row, as SolidWorks shows it, until opened (kept per browser). */
  private flyClosed = (() => { try { return localStorage.getItem("mc:flyTree") !== "1"; } catch { return true; } })();

  /**
   * Fly-out tree (FR-UI-003, SolidWorks' fly-out FeatureManager): while a panel is open it fills the Features tab,
   * and the tree itself moves to the top left of the view, so planes and features can still be picked from it.
   * The same `#mc-tree` element moves, so its rows, listeners and selectors stay as they are. Phones keep it in the panel.
   */
  private syncFlyTree() {
    const tree = document.getElementById("mc-tree"), tab = document.getElementById("tab-features");
    if (!tree || !tab) return;
    const fly0 = document.getElementById("mc-treefly");
    const on = !!this.store && this.mode.kind !== "none" && !$("#mc-bar").hidden && !matchMedia("(max-width: 767px)").matches;
    tab.classList.toggle("pm-full", on);
    if (!on) {
      if (fly0) { document.getElementById("ft-search")?.after(tree); fly0.remove(); }
      tree.hidden = false;
      return;
    }
    let fly = fly0;
    if (!fly) {
      fly = document.createElement("div");
      fly.id = "mc-treefly";
      fly.className = "mc-treefly";
      fly.innerHTML = `<button type="button" class="mc-treefly-h" data-a="fly"><span class="mc-treefly-tw" aria-hidden="true"></span><span class="mc-treefly-n" translate="no"></span></button>`;
      fly.querySelector("[data-a=fly]")!.addEventListener("click", () => {
        this.flyClosed = !this.flyClosed;
        try { localStorage.setItem("mc:flyTree", this.flyClosed ? "0" : "1"); } catch { /* private mode */ }
        this.syncFlyTree();
      });
      $("#mc-bar").append(fly);
    }
    if (tree.parentElement !== fly) fly.append(tree);
    const h = fly.querySelector<HTMLElement>("[data-a=fly]")!;
    h.setAttribute("aria-expanded", String(!this.flyClosed));
    h.title = this.flyClosed ? t("Show the feature tree") : t("Fold the feature tree");
    fly.querySelector(".mc-treefly-tw")!.textContent = this.flyClosed ? "▸" : "▾";
    fly.querySelector(".mc-treefly-n")!.textContent = this.doc.name;
    fly.classList.toggle("closed", this.flyClosed);
    tree.hidden = this.flyClosed;
  }

  private renderBar() {
    const bar = $("#mc-bar");
    if (!this.store) { bar.hidden = true; $("#mc-confirm").hidden = true; this.renderQuick(); return; }
    bar.hidden = false;
    const m = this.mode;
    // Entering a sketch selects the Sketch tab; leaving it goes back to Features (FR-UI-013).
    if ((m.kind === "sketch") !== this.wasSketch) {
      this.wasSketch = m.kind === "sketch";
      this.inBar = true;
      selectCmTab(this.wasSketch ? "sketch" : "features");
      this.inBar = false;
    }
    document.getElementById("app")!.classList.toggle("mc-cmd", m.kind !== "none");
    // A command takes the left panel to the Feature tab (FR-UI-003), once as it starts.
    if ((m.kind !== "none") !== this.wasCmd) { this.wasCmd = m.kind !== "none"; if (this.wasCmd) this.host.selectLeftTab("features"); }
    this.syncFlyTree();
    this.syncSketchSection();
    if (m.kind !== "sketch") {
      $("#mc-status").textContent = m.kind === "plane" ? t(m.edit?.pickX ? "Click a straight edge for the sketch X axis." : m.edit ? "Pick the new plane or flat face for the sketch." : "Pick a plane or a flat face for the sketch.")
        : m.kind === "feature" && (m.draft.type === "fillet" || m.draft.type === "chamfer") ? t("Click edges, or a face for all its edges; click again to remove.")
        : m.kind === "feature" ? t("Set the values in the panel; the view shows the result.") : "";
    }
    $("#mc-confirm").hidden = m.kind === "none";
    if (m.kind !== "none") document.getElementById("mc-crumbs")?.remove();
    if (m.kind !== this.crumbMode) { this.crumbMode = m.kind; this.crumbAt = null; this.placeCrumbs(); }
    $("#mc-ok").title = m.kind === "sketch" ? t("Exit sketch (Enter)") : t("OK (Enter)");
    $("#mc-ok").setAttribute("aria-label", $("#mc-ok").title);
    const btn = (id: string, label: string, title: string, on = false, dis = false) =>
      `<button class="mc-b${on ? " on" : ""}" data-c="${id}" title="${esc(title)}"${on ? ' aria-pressed="true"' : ""}${dis ? " disabled" : ""}><span class="mc-i" aria-hidden="true">${ICON_SVG[id] ?? ""}</span><span class="mc-l">${esc(label)}</span></button>`;
    let html: string;
    // While a sketch is open the Sketch tab shows its tools; the other tabs keep their commands, and picking one
    // exits the sketch and starts the feature on it (FR-SK-004).
    if (m.kind === "sketch" && cmTab() === "sketch") {
      const tool = m.editor.tool;
      const tools: [SkTool, string, string][] = [
        ["select", t("Select"), t("Select and drag (Esc)")], ["line", t("Line"), t("Line (L)")], ["cline", t("Centerline"), t("Centerline: construction lines for mirrors, revolve axes and symmetry")], ["mline", t("Midpoint line"), t("Midpoint line: the middle, then one end")], ["rect", t("Rectangle"), t("Corner rectangle (R)")],
        ["crect", t("Centre rect"), t("Centre rectangle")],
        ["rect3", t("3-pt rectangle"), t("3-point corner rectangle: two corners, then the width")], ["crect3", t("3-pt centre rect"), t("3-point centre rectangle: centre, middle of a side, then a corner")], ["pgram", t("Parallelogram"), t("Parallelogram: three corners")], ["circle", t("Circle"), t("Circle (C)")], ["circle3", t("3-pt circle"), t("Circle through three points")], ["pcircle", t("Perimeter circle"), t("Perimeter circle: click three points or curves; it touches the lines, circles and arcs")],
        ["arc", t("Arc"), t("Centre-point arc (A)")], ["arc3", t("3-pt arc"), t("Arc through start, end and a point on it")], ["tarc", t("Tangent arc"), t("Tangent arc: from the end of a line or arc, tangent to it")],
        ["polygon", t("Polygon"), t("Polygon: centre, then a corner")], ["slot", t("Slot"), t("Straight slot: two centres, then the width (W)")],
        ["cslot", t("Centre slot"), t("Centerpoint straight slot: the centre, one end, then the width")], ["aslot", t("Arc slot"), t("Centerpoint arc slot: the arc's centre, start, end, then the width")],
        ["aslot3", t("3-pt arc slot"), t("3-point arc slot: start, end, a point on the arc, then the width")],
        ["spline", t("Spline"), t("Spline: click points it passes through; double-click ends it")], ["sspline", t("Style spline"), t("Style spline: click its control points; double-click ends it")], ["ellipse", t("Ellipse"), t("Ellipse: centre, end of the major axis, then a point on it")], ["earc", t("Partial ellipse"), t("Partial ellipse: centre, major axis, start, then end")], ["parabola", t("Parabola"), t("Parabola: focus, vertex, then the start and the end")], ["conic", t("Conic"), t("Conic: start, end, the top vertex, then a point that sets rho")], ["eqn", t("Equation curve"), t("Equation driven curve: y = f(x), or x(t) and y(t)")], ["point", t("Point"), t("Point (P)")], ["text", t("Text"), t("Text: letters for embossing or engraving, from the bundled fonts")],
        ["trim", t("Trim"), t("Trim: click the piece of a curve to remove (T)")], ["extend", t("Extend"), t("Extend a line or arc to the next curve (E)")], ["split", t("Split"), t("Split a line or arc where you click")], ["jog", t("Jog line"), t("Jog line: click a line where the jog starts, then where it ends and how far it steps out")], ["segment", t("Segment"), t("Segment: divide a line, arc or circle into equal pieces")],
        ["fillet", t("Fillet"), t("Sketch fillet: click a corner where two lines meet")], ["chamfer", t("Chamfer"), t("Sketch chamfer: click a corner where two lines meet")],
        ["offset", t("Offset"), t("Offset entities: a curve or a chain, to the cursor's side (O)")], ["convert", t("Convert"), t("Convert entities: copy model edges into the sketch")], ["intersect", t("Intersection curve"), t("Intersection curve: where the sketch plane cuts model faces")],
        ["dim", t("Dimension"), t("Smart dimension (D)")],
        ["hord", t("Horizontal ordinate"), t("Horizontal ordinate dimensions: X distances from one base")], ["vord", t("Vertical ordinate"), t("Vertical ordinate dimensions: Y distances from one base")],
      ];
      // Related tools share one button with a flyout (SolidWorks-style): the button shows the last one used.
      const groups: SkTool[][] = [["select"], ["dim", "hord", "vord"], ["line", "cline", "mline", "spline", "sspline", "eqn"], ["rect", "crect", "rect3", "crect3", "pgram", "polygon"], ["circle", "circle3", "pcircle", "ellipse", "earc", "parabola", "conic"], ["arc", "arc3", "tarc"], ["slot", "cslot", "aslot", "aslot3"], ["point", "text"], ["trim", "extend", "split", "jog", "segment"], ["fillet", "chamfer"], ["offset", "convert", "intersect"]];
      const info = new Map(tools.map(x => [x[0], x]));
      html = `<div class="mc-g" role="group" aria-label="${esc(t("Sketch"))}">${groups.map(g => {
        const cur = g.includes(tool) ? tool : (this.flyLast.get(g[0]) as SkTool | undefined) ?? g[0];
        const [id, l, ti] = info.get(cur)!;
        if (g.length === 1) return btn(`sk:${id}`, l, ti, tool === id);
        return `<span class="mc-fly">${btn(`sk:${id}`, l, ti, tool === id)}<button class="mc-caret" data-fly="${g[0]}" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(l)}">▾</button></span>`;
      }).join("")}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("cons", t("Construction"), t("Construction geometry on/off for the selection (Q)"))}${btn("skmirror", t("Mirror"), t("Mirror entities: select them and a line to mirror about, then click"))}${btn("skdynmirror", t("Dynamic mirror"), t("Dynamic mirror: select a line, click, then draw; each new entity is mirrored about it"), !!m.editor.dynMirror)}${btn("skdxf", t("DXF"), t("Import a DXF drawing into the sketch"))}${btn("sksec", t("Section"), t("Section view at the sketch plane: hides the material in front of it"), this.skSection)}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("sklpat", t("Linear pattern"), t("Linear sketch pattern: select entities, then set count and spacing"))}${btn("skcpat", t("Circular pattern"), t("Circular sketch pattern: select entities (and a centre point), then set count and angle"))}${btn("skmove", t("Move"), t("Move or copy entities by a distance"))}${btn("skrot", t("Rotate"), t("Rotate entities about a point"))}${btn("skscale", t("Scale"), t("Scale entities about a point"))}${btn("skstretch", t("Stretch"), t("Stretch entities: select points or one end of a shape, then move them; lines ending there stretch"))}</div>`
        + `<div class="mc-sep"></div><div class="mc-g" role="group" aria-label="${esc(t("Features from this sketch"))}">${(["extrude", "cut", "revolve"] as const).map(id => { const [l, ti] = this.cmdInfo(id); return btn(id, l, ti); }).join("")}</div>`
        + `<div class="mc-sep"></div><div class="mc-g">${btn("exit", t("Exit sketch"), t("Exit sketch (Enter)"))}</div>`;
    } else {
      // Command manager tabs (FR-UI-010): Features, Sketch, Surfaces, Weldments; Evaluate is main.ts's pane.
      const open = m.kind === "feature" ? this.openCmd(m.draft) : m.kind === "plane" ? "sketch" : null;
      const one = (id: string) => { const [l, ti] = this.cmdInfo(id); return btn(id, l, ti, open === id); };
      const fly = (key: string) => {
        const ids = CM_FLY[key];
        const cur = ids.find(id => id === open) ?? ids.find(id => id === this.flyLast.get(key)) ?? ids[0];
        const [l, ti] = this.cmdInfo(cur);
        return `<span class="mc-fly">${btn(cur, l, ti, open === cur)}<button class="mc-caret" data-fly="${key}" aria-haspopup="menu" title="${esc(t("More tools like this"))}" aria-label="${esc(t("More tools like this"))}: ${esc(l)}">▾</button></span>`;
      };
      const group = (label: string, inner: string) => `<div class="mc-g" role="group" aria-label="${esc(label)}">${inner}</div>`;
      const sep = `<div class="mc-sep"></div>`;
      const tab = cmTab();
      html = tab === "sketch" ? group(t("Sketch"), one("sketch") + one("sketch3d"))
        + `<p class="cm-note muted">${esc(t("Pick a plane or a flat face, then Sketch; the sketch tools show here while you draw."))}</p>`
        : tab === "surfaces" ? group(t("Surfaces"), SURF_TOOLS().map(([id]) => one(id)).join(""))
        : tab === "sheetmetal" ? (() => {
          // Sheet metal tab (FR-FT-120): Flatten stays pressed while the flat pattern shows.
          const flat = this.doc.features.some(f => f.type === "smflat" && !f.suppressed);
          return group(t("Sheet Metal"), SM_TOOLS().map(([id]) => id === "smflat" ? (() => { const [l, ti] = this.cmdInfo(id); return btn(id, l, ti, flat); })() : one(id)).join(""));
        })()
        : tab === "weldments" ? group(t("Weldments"), WELD_TOOLS().map(([id]) => one(id)).join(""))
        : group(t("Sketch"), one("sketch")) + sep
          + group(t("Boss"), one("extrude") + one("revolve") + fly("sweep")) + sep
          + group(t("Cut"), one("cut") + one("hole") + fly("sweepcut")) + sep
          + group(t("Features"), one("fillet") + one("chamfer") + fly("pattern") + one("rib") + one("shell") + one("draft") + one("thread")) + sep
          + group(t("Reference geometry"), fly("plane") + fly("curves")) + sep
          + group(t("Bodies"), fly("bodies") + fly("direct"));
    }
    $("#mc-tools").innerHTML = html;
    this.renderQuick();
    $("#mc-tools").querySelectorAll<HTMLButtonElement>("[data-c]").forEach(b => b.addEventListener("click", () => this.command(b.dataset.c!)));
    $("#mc-tools").querySelectorAll<HTMLButtonElement>("[data-fly]").forEach(b => b.addEventListener("click", () => {
      const mm = this.mode;
      const key = b.dataset.fly!;
      if (CM_FLY[key] && (mm.kind !== "sketch" || cmTab() !== "sketch")) {
        const r = b.getBoundingClientRect();
        this.showMenu(CM_FLY[key].map(id => [this.cmdInfo(id)[0], () => { if (id !== "cutlist") this.flyLast.set(key, id); this.command(id); }, ICON_SVG[id]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
          () => $("#mc-tools").querySelector<HTMLElement>(`[data-fly="${key}"]`)?.focus());
        return;
      }
      if (mm.kind !== "sketch" || cmTab() !== "sketch") return;
      const g = ({ line: ["line", "cline", "mline", "spline", "sspline", "eqn"], rect: ["rect", "crect", "rect3", "crect3", "pgram", "polygon"], circle: ["circle", "circle3", "pcircle", "ellipse", "earc", "parabola", "conic"], arc: ["arc", "arc3", "tarc"], slot: ["slot", "cslot", "aslot", "aslot3"], trim: ["trim", "extend", "split", "jog", "segment"], fillet: ["fillet", "chamfer"], offset: ["offset", "convert", "intersect"], dim: ["dim", "hord", "vord"], point: ["point", "text"] } as Record<string, SkTool[]>)[key];
      const label: Record<string, string> = { point: t("Point"), text: t("Text"), line: t("Line"), cline: t("Centerline"), mline: t("Midpoint line"), spline: t("Spline"), sspline: t("Style spline"), rect: t("Corner rectangle"), crect: t("Centre rectangle"), rect3: t("3-point corner rectangle"), crect3: t("3-point centre rectangle"), pgram: t("Parallelogram"), polygon: t("Polygon"), circle: t("Circle"), circle3: t("3-point circle"), pcircle: t("Perimeter circle"), arc: t("Centre-point arc"), arc3: t("3-point arc"), tarc: t("Tangent arc"), slot: t("Straight slot"), cslot: t("Centerpoint straight slot"), aslot: t("Centerpoint arc slot"), aslot3: t("3-point arc slot"), ellipse: t("Ellipse"), earc: t("Partial ellipse"), parabola: t("Parabola"), conic: t("Conic"), eqn: t("Equation driven curve"), trim: t("Trim"), extend: t("Extend"), split: t("Split"), jog: t("Jog line"), segment: t("Segment"), fillet: t("Sketch fillet"), chamfer: t("Sketch chamfer"), offset: t("Offset entities"), convert: t("Convert entities"), intersect: t("Intersection curve"), dim: t("Smart dimension"), hord: t("Horizontal ordinate"), vord: t("Vertical ordinate") };
      const r = b.getBoundingClientRect();
      this.showMenu(g.map(id => [label[id], () => { this.flyLast.set(g[0], id); mm.editor.setTool(id); this.renderBar(); this.renderPanel(); }, ICON_SVG[`sk:${id}`]] as [string, () => void, string]), r.left - 40, r.bottom + 4,
        () => $("#mc-tools").querySelector<HTMLElement>(`[data-fly="${b.dataset.fly}"]`)?.focus());
    }));
  }

  /** Last pointer position over the view (where the shortcut bar opens). */
  private pointer: { x: number; y: number } | null = null;

  /** The feature whose dimensions are shown on the model (FR-UI-115), and the document a Modify box previews. */
  private instant: string | null = null;
  private instantDoc: PartDoc | null = null;

  /** The dimensions a feature shows on the model: its sketch's driving dimensions and its own depth. */
  private instantItems(f: Feature): ModelItem[] {
    if (!this.last) return [];
    const sk = "sketch" in f && typeof f.sketch === "string" ? f.sketch : f.type === "sketch" ? f.id : null;
    let items: ModelItem[] = [];
    try { items = modelItems(this.doc, this.last.frames).items; } catch { return []; }
    return items.filter(it => (sk && it.src.startsWith(`${sk}:`)) || it.src === `${f.id}:depth`);
  }

  /** A feature's own values shown beside its dimensions (FR-UI-115): angles, radii, thicknesses, counts… */
  private featureValues(f: Feature): { key: string; q: "length" | "angle" | "count"; label: string }[] {
    if (f.type === "sketch" || f.type === "sketch3d" || f.suppressed) return [];
    const g = f as unknown as Record<string, unknown>, out: { key: string; q: "length" | "angle" | "count"; label: string }[] = [];
    for (const [key, q, label] of INSTANT_VALUES) {
      if (f.type === "extrude" && key === "depth") continue;
      // The revolve angle has its own drag handle with the value on it.
      if (f.type === "revolve" && key === "angle") continue;
      if (key === "depth" && typeof g.end === "string" && g.end !== "blind") continue;
      const v = g[key];
      if (q === "count" ? typeof v === "number" : !!v && typeof v === "object" && typeof (v as Num).v === "number") out.push({ key, q, label: t(label) });
    }
    return out;
  }

  private hasInstant(f: Feature) { return this.instantItems(f).length > 0 || this.featureValues(f).length > 0; }

  /** Double-click on the model: the dimensions of the feature that made the face or edge show on it, as in SolidWorks. */
  showInstant(x: number, y: number) {
    if (!this.store || !this.last || this.mode.kind !== "none") return;
    const hit = this.host.edgeAt(x, y);
    const faceId = hit?.edge ? hit.edge.faces[0] : hit?.faceId;
    const id = faceId != null ? this.last.faceNames[faceId]?.split(":")[0] : undefined;
    const f = id ? this.store.feature(id) : undefined;
    if (!f || f.suppressed) { this.hideInstant(); return; }
    this.hideShortcutBar();
    if (!this.hasInstant(f)) { this.hideInstant(); toast(t("{name} has no dimensions to show on the model.", { name: f.name })); return; }
    this.instant = f.id;
    this.selected = f.id;
    this.renderTree();
    this.drawDecor();
  }

  hideInstant() {
    if (!this.instant) return;
    this.instant = null;
    this.drawDecor();
  }

  /** Draws the shown feature's dimensions: lines in the view and a value label on each. */
  private drawInstant() {
    const f = this.instant ? this.store?.feature(this.instant) : undefined;
    if (!f || this.mode.kind !== "none") { if (this.mode.kind !== "none") this.instant = null; return; }
    const dark = document.documentElement.dataset.theme === "dark";
    const fu = UNITS[units.current].f, dec = units.decimals ?? this.doc.units.decimals;
    const pos: number[] = [];
    const layer = $("#mc-layer");
    for (const it of this.instantItems(f)) {
      const [a, b] = it.p;
      let mid: V3;
      if (it.k === "lin") {
        // Along a direction: the dimension line runs from the first point along it, with a leg to the second.
        let e = b;
        if (it.dir) { const k = (b[0] - a[0]) * it.dir[0] + (b[1] - a[1]) * it.dir[1] + (b[2] - a[2]) * it.dir[2]; e = [a[0] + it.dir[0] * k, a[1] + it.dir[1] * k, a[2] + it.dir[2] * k]; pos.push(...e, ...b); }
        pos.push(...a, ...e);
        mid = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2, (a[2] + e[2]) / 2];
      } else {
        const o: V3 = it.k === "dia" ? [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]] : a;
        pos.push(...o, ...b);
        mid = b;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "mc-fdim";
      el.dataset.src = it.src;
      el.dataset.at = JSON.stringify(mid);
      el.setAttribute("translate", "no");
      el.textContent = `${it.k === "rad" ? "R" : it.k === "dia" ? "Ø" : ""}${trimNum(it.value * fu, dec)}`;
      el.title = t("{name}: click to change", { name: it.name });
      el.addEventListener("click", ev => { ev.stopPropagation(); this.editInstant(it.src, el); });
      layer.appendChild(el);
    }
    this.lines(pos, dark ? 0x8ab4ff : 0x1d4ed8, 1.4);
    // The feature's own values (angle, radius, thickness, count…) stacked by the middle of its faces.
    const at = this.calloutPoint(f), g = f as unknown as Record<string, unknown>;
    if (at) this.featureValues(f).forEach((fv, row) => {
      const v = g[fv.key] as Num | number;
      const el = document.createElement("span");
      el.className = "mc-callout mc-ival";
      el.dataset.at = JSON.stringify(at);
      el.dataset.row = String(row);
      el.dataset.v = fv.key;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mc-handle";
      b.dataset.src = `${f.id}:${fv.key}`;
      b.textContent = `${fv.label}: ${typeof v === "number" ? v : fv.q === "angle" ? `${trimNum(v.v * 180 / Math.PI, dec)}°` : trimNum(v.v * fu, dec)}`;
      b.title = t("{name}: click to change", { name: fv.label });
      b.addEventListener("click", ev => { ev.stopPropagation(); this.editInstant(`${f.id}:${fv.key}`, b); });
      el.append(b);
      layer.appendChild(el);
    });
    this.placeCallouts();
  }

  /** Opens the Modify box on a shown feature dimension; ⟲ rebuilds with the typed value, ✓ keeps it as one undo step. */
  private editInstant(src: string, el: HTMLElement) {
    if (!this.store) return;
    const [fid, key] = src.split(":");
    const f = this.store.feature(fid);
    if (!f) return;
    const fu = UNITS[units.current].f;
    let num: Num, title: string, q: "length" | "angle" | "count" = "length";
    const fv = f.type === "extrude" && key === "depth" ? undefined : this.featureValues(f).find(x => x.key === key);
    if (key === "depth" && f.type === "extrude") { num = f.depth; title = `${t("Depth")}@${f.name}`; }
    else if (fv) {
      const raw = (f as unknown as Record<string, unknown>)[key] as Num | number;
      num = typeof raw === "number" ? { v: raw } : raw;
      q = fv.q;
      title = `${fv.label}@${f.name}`;
    } else if (f.type === "sketch") {
      const d = f.dims.find(x => x.id === key);
      if (!d) return;
      num = d.val;
      title = `${d.name}@${f.name}`;
    } else return;
    const value = num.expr ?? (q === "count" ? String(num.v) : trimNum(q === "angle" ? num.v * 180 / Math.PI : num.v * fu, 6));
    const canFlip = FLIP_TYPES.has(f.type) && (key === "depth" || key === "distance" || key === "offset" || key === "angle" || key === "spacing");
    let flipped = false;
    // The document with the typed value (and the direction reversed, when asked), or an error.
    const docWith = (text: string): PartDoc | string | null => {
      let v: number;
      if (q === "count") {
        v = Number(text.trim());
        if (!Number.isInteger(v) || v < 1) return t("Enter a whole number of 1 or more.");
        if (v === num.v && !flipped) return null;
      } else {
        try { v = q === "angle" ? evaluate(text, "angle", "deg", evalVars(this.doc, units.current).values) : evaluate(text, "length", units.current, evalVars(this.doc, units.current).values); }
        catch (err) { return t((err as ExprError).key ?? String(err), (err as ExprError).params); }
        if (!(v > 0)) return t("The value must be more than 0.");
      }
      const val: Num = q === "count" || isPlain(text) ? { v } : { v, expr: text.trim() };
      if (!flipped && q !== "count" && Math.abs(v - num.v) < 1e-12 && (num.expr ?? "") === (val.expr ?? "")) return null;
      const d = structuredClone(this.doc);
      const g = d.features.find(x => x.id === fid)!;
      if (flipped) { const gf = g as { flip?: boolean }; if (gf.flip) delete gf.flip; else gf.flip = true; }
      if (fv) (g as unknown as Record<string, unknown>)[key] = q === "count" ? v : val;
      else if (g.type === "extrude") g.depth = val;
      else if (g.type === "sketch") {
        g.dims.find(x => x.id === key)!.val = val;
        if (solve(g).status !== "ok") return t("That value cannot be reached with the other relations and dimensions.");
      }
      return d;
    };
    const unpreview = () => { if (this.instantDoc) { this.instantDoc = null; void this.rebuild(); } };
    el.classList.add("on");
    const r = el.getBoundingClientRect();
    new ModifyBox({
      at: { x: r.right, y: r.top + r.height / 2 },
      title,
      value,
      step: q === "count" ? 1 : stepFor(q, units.current),
      incKey: q,
      // Reverse direction (FR-UI-114) for features that have one: previewed with the value, kept by ✓.
      ...(canFlip ? { reverse: () => { flipped = !flipped; } } : {}),
      preview: text => {
        const d = docWith(text);
        if (typeof d === "string") { toast(d, "error"); return; }
        if (!d) { unpreview(); return; }
        this.instantDoc = d;
        void this.rebuild();
      },
      accept: text => {
        el.classList.remove("on");
        if (!this.store) return true;
        const d = docWith(text);
        if (typeof d === "string") { toast(d, "error"); unpreview(); return true; }
        if (!d) { unpreview(); return true; }
        this.instantDoc = null;
        const g = d.features.find(x => x.id === fid)!;
        this.store.change(`Change ${title}`, doc => { const i = doc.features.findIndex(x => x.id === fid); if (i >= 0) doc.features[i] = structuredClone(g); });
        return true;
      },
      cancel: () => { el.classList.remove("on"); unpreview(); },
    });
  }

  /** Where Shift+D put the breadcrumbs and the confirmation corner (FR-SEL-009); null = their usual places. */
  private crumbAt: { x: number; y: number } | null = null;
  private crumbMode = "none";

  /**
   * Selection breadcrumbs (FR-SEL-009): after a pick, the chain from the picked face or edge up to the part (face →
   * feature → sketch → body → part) at the top left of the view. Hovering a crumb lights it up, a click selects it as
   * in the tree, a right-click opens its tree menu.
   */
  private showCrumbs(pick: { edge?: EdgeInfo; faceId?: number; plane?: PlaneRef } | null) {
    const list: { id: string; icon: string; label: string }[] = [];
    if (this.mode.kind === "none" && this.store && this.last && pick) {
      const fid = pick.edge ? pick.edge.faces[0] : pick.faceId;
      if (fid != null) {
        list.push({ id: "", icon: pick.edge ? "╱" : "▱", label: pick.edge ? t("Edge") : t("Face") });
        const f = this.store.feature(this.last.faceNames[fid]?.split(":")[0] ?? "");
        if (f) {
          list.push({ id: f.id, icon: f.type === "extrude" && f.op === "cut" ? ICONS.cut : ICONS[f.type] ?? "•", label: featureLabel(f.name) });
          const sk = "sketch" in f && typeof f.sketch === "string" ? this.store.feature(f.sketch) : undefined;
          if (sk) list.push({ id: sk.id, icon: ICONS.sketch, label: featureLabel(sk.name) });
        }
        let at = 0;
        for (const b of this.last.bodies ?? []) {
          const n = b.faces ?? 0;
          if (fid >= at && fid < at + n) { list.push({ id: `body:${b.key}`, icon: "▣", label: this.bodyName(b.key) }); break; }
          at += n;
        }
      } else if (pick.plane && ("std" in pick.plane || "plane" in pick.plane)) {
        list.push({ id: "std" in pick.plane ? `std:${pick.plane.std}` : pick.plane.plane, icon: ICONS.plane, label: this.refLabel(pick.plane) });
      }
      if (list.length) list.push({ id: "part", icon: ICONS.part, label: this.displayName() });
    }
    let el = document.getElementById("mc-crumbs");
    if (!list.length) { el?.remove(); if (this.mode.kind === "none") this.crumbAt = null; return; }
    if (!el) {
      el = document.createElement("nav");
      el.id = "mc-crumbs";
      el.className = "mc-crumbs";
      el.setAttribute("aria-label", t("Selection breadcrumbs"));
      $("#mc-bar").append(el);
    }
    el.innerHTML = list.map((c, i) => (i ? `<span class="mc-crumb-sep" aria-hidden="true">›</span>` : "")
      + `<button class="mc-crumb${c.id ? "" : " here"}"${c.id ? ` data-id="${esc(c.id)}"` : ` aria-current="true"`} translate="no"><span aria-hidden="true">${esc(c.icon)}</span>${esc(c.label)}</button>`).join("");
    this.placeCrumbs();
    el.querySelectorAll<HTMLElement>(".mc-crumb[data-id]").forEach(b => {
      const id = b.dataset.id!;
      b.addEventListener("pointerenter", () => this.setHover(id, "tree"));
      b.addEventListener("pointerleave", () => { if (this.hoverId === id) this.setHover(null, "tree"); });
      b.addEventListener("click", () => this.selectRow(id));
      b.addEventListener("contextmenu", e => { e.preventDefault(); this.selectRow(id); this.openMenu(id, e.clientX, e.clientY); });
    });
  }

  private hideCrumbs() { this.showCrumbs(null); }

  /** Selects a Features tree row as a click on it would (opening folded folders on the way). */
  private selectRow(id: string) {
    this.setHover(null, "tree");
    this.selected = id;
    if (id.startsWith("body:")) this.closedFolders.delete("bodies");
    this.renderTree();
    this.drawDecor();
    document.querySelector(`#mc-tree .ft-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /** Shift+D: the breadcrumbs and the confirmation corner come to the cursor (FR-SEL-009). */
  private crumbsToCursor() {
    if (!this.pointer) return;
    this.crumbAt = { ...this.pointer };
    this.placeCrumbs();
  }

  private placeCrumbs() {
    const vr = this.host.vp.getBoundingClientRect(), at = this.crumbAt;
    for (const el of [document.getElementById("mc-crumbs"), document.getElementById("mc-confirm")]) {
      if (!el) continue;
      el.classList.toggle("at-cursor", !!at);
      if (!at) { el.style.left = el.style.top = ""; continue; }
      const crumbs = el.id === "mc-crumbs", w = el.offsetWidth || 120, h = el.offsetHeight || 40;
      // The crumbs sit just below-right of the cursor, the corner just above-right, both kept inside the view.
      const x = Math.max(vr.left + 4, Math.min(at.x + 12, vr.right - w - 4));
      const y = Math.max(vr.top + 4, Math.min(at.y + (crumbs ? 16 : -h - 12), vr.bottom - h - 4));
      el.style.left = `${x}px`; el.style.top = `${y}px`;
    }
  }


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
      const cx = body ? null : this.ctxAt(at.x, at.y);
      if (cx?.ref && (!ph || cx.dist <= ph.distance)) {
        this.ctxPick = { plane: cx.ref };
        items.push(["sketch", t("Sketch")]);
      } else if (ref && ("std" in ref || "plane" in ref)) {
        this.selected = "std" in ref ? `std:${ref.std}` : ref.plane;
        this.ctxPick = { plane: ref };
        this.renderTree();
        this.drawDecor();
        items.push(["sketch", t("Sketch")], ["normal", t("Normal to")]);
      }
    }
    this.showCrumbs(this.ctxPick);
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
      $("#mc-bar").prepend(bar);
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
  /** The last feature command (Enter repeats it, FR-UI-111) and the one whose panel is open. */
  private lastCmd: string | null = null;
  private activeCmd: string | null = null;
  /** Keep visible pushpin (FR-UI-106): OK opens the same command again. */
  private pinned = (() => { try { return localStorage.getItem("mc:pin") === "1"; } catch { return false; } })();

  private command(c: string) {
    const m = this.mode;
    if (c.startsWith("sk:") && m.kind === "sketch") { m.editor.setTool(c.slice(3) as SkTool); this.renderBar(); this.renderPanel(); return; } // the panel shows the tool's fields (fillet radius, exam #89)
    switch (c) {
      case "cons": if (m.kind === "sketch") m.editor.toggleConstruction(); break;
      case "skmirror": if (m.kind === "sketch") { m.editor.mirrorSelection(); this.renderPanel(); } break;
      case "skdynmirror": if (m.kind === "sketch") { m.editor.toggleDynMirror(); this.renderBar(); this.renderPanel(); } break;
      case "skdxf": if (m.kind === "sketch") this.importDxf(); break;
      case "sksec": if (m.kind === "sketch") { this.skSection = !this.skSection; this.renderBar(); } break;
      case "sklpat": case "skcpat": case "skmove": case "skrot": case "skscale": case "skstretch":
        if (m.kind === "sketch" && m.editor.startPattern(({ sklpat: "linear", skcpat: "circular", skmove: "move", skrot: "rotate", skscale: "scale", skstretch: "stretch" } as const)[c])) this.renderPanel();
        break;
      case "exit": this.ok(); break;
      case "sketch": this.noteRecent(c); this.startSketch(); break;
      case "extrude": case "cut": case "revolve": case "fillet": case "chamfer": case "plane": case "axis": case "point": case "csys": case "shell": case "draft": case "mirror": case "lpattern": case "cpattern": case "spattern": case "tpattern": case "hole": case "thread": case "helix": case "sweep": case "sweepcut": case "loft": case "loftcut": case "rib": case "split": case "combine": case "indent": case "intersect": case "bsplit": case "delbody": case "movebody": case "scale": case "delface": case "moveface": case "heal": case "planesurf": case "extsurf": case "offsurf": case "knit": case "thicken": case "replaceface": case "revsurf": case "loftsurf": case "trimsurf": case "fillsurf": case "extendsurf": case "untrimsurf": case "sweepsurf": case "xyzcurve": case "compcurve": case "projcurve": case "sketch3d": case "member": case "trimext": case "endcap": case "gusset": case "weldbead": this.lastCmd = this.activeCmd = c; this.noteRecent(c); this.startFeature(c); break;
      case "cutlist": if (m.kind === "sketch") this.ok(); this.cutList(); break;
      case "import": if (m.kind === "sketch") this.ok(); this.importBodyFile(); break;
      case "smbase": case "smloft": case "smflange": case "smhem": case "smbend": case "smjog": case "smcorner": case "smclosed": case "smrelief": case "smgusset": case "smcross": case "smvent": case "smcut": case "smconvert": case "sminsert": case "smform": case "smunfold": case "smfold": case "smmiter": case "smswept": case "smtabslot": case "smrip": this.startFeature(c); break;
      case "smflat": if (m.kind === "sketch") this.ok(); this.toggleFlat(); break;
      case "smdxf": if (m.kind === "sketch") this.ok(); this.exportFlatDxf(); break;
      case "smprops": if (m.kind === "sketch") this.ok(); this.sheetProps(); break;
      case "recognize": if (m.kind === "sketch") this.ok(); void this.recognizeHoles(); break;
      case "recblend": if (m.kind === "sketch") this.ok(); void this.recognizeBlends(); break;
      case "recext": if (m.kind === "sketch") this.ok(); void this.recognizeExtrudes(); break;
      case "recall": if (m.kind === "sketch") this.ok(); void this.recognizeFeatures(); break;
      case "extrefs": if (m.kind === "sketch") this.ok(); this.showExtRefs(); break;
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
    this.renderWhatsWrong(st);
    const p = this.last?.props;
    const stats = $("#st-stats");
    if (this.store && this.mode.kind !== "sketch") {
      const f = this.doc.features.length;
      stats.textContent = [t("{n} feature|{n} features", { n: f }), p ? `V ${trimNum(p.volume * UNITS[units.current].f ** 3, 3)} ${units.current}³` : t("no body"), `${t("rebuild")} ${Math.round(this.rebuildMs)} ms`].join(" · ");
    }
  }

  /** Opened What's wrong list (view state). */
  private wrongOpen = false;

  /**
   * What's wrong (FR-HIS-022): above the tree, the count of features with errors and warnings; opening it
   * lists each with its message, and a click selects the feature (double click edits it).
   */
  private renderWhatsWrong(st: FeatureStatus[]) {
    const el = $("#mc-errors");
    const items = st.filter(s => !s.ok || s.code === "warning").map(s => ({ s, f: this.store?.feature(s.id) })).filter(x => x.f);
    const nBad = items.filter(x => !x.s.ok).length, nWarn = items.length - nBad;
    el.hidden = !items.length;
    if (!items.length) { el.innerHTML = ""; this.wrongOpen = false; return; }
    const head = [nBad ? t("{n} feature with errors|{n} features with errors", { n: nBad }) : "", nWarn ? t("{n} warning|{n} warnings", { n: nWarn }) : ""].filter(Boolean).join(", ");
    el.className = `pm-err pad mc-wrong${nBad ? "" : " warn"}`;
    el.innerHTML = `<button type="button" class="mc-wrong-h" aria-expanded="${this.wrongOpen}">${esc(head)} · ${esc(t("What's wrong"))} ${this.wrongOpen ? "▴" : "▾"}</button>`
      + (this.wrongOpen ? `<ul class="mc-wrong-l">${items.map(({ s, f }) => `<li><button type="button" data-wid="${esc(f!.id)}" class="${s.ok ? "warn" : "bad"}" title="${esc(t("Click to select, double-click to edit"))}"><b>${esc(featureLabel(f!.name))}</b>: ${esc(statusText(s))}</button></li>`).join("")}</ul>` : "");
    el.querySelector(".mc-wrong-h")!.addEventListener("click", () => { this.wrongOpen = !this.wrongOpen; this.renderWhatsWrong(this.last?.statuses ?? []); });
    el.querySelectorAll<HTMLElement>("[data-wid]").forEach(b => {
      const id = b.dataset.wid!;
      b.addEventListener("click", () => { this.selected = id; this.renderTree(); this.drawDecor(); $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }); });
      b.addEventListener("dblclick", () => { if (this.mode.kind === "none") this.editFeature(id); });
    });
  }

  private renderTree() {
    const box = $("#mc-tree");
    this.renderRollNotice();
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
    for (const std of ["XY", "XZ", "YZ"] as const) {
      const hid = (d.stdHidden ?? []).includes(std);
      html += row(`std:${std}`, ICONS.plane, t(STD_NAMES[std]), `<span class="ft-tools">${eyeButton(hid, t(STD_NAMES[std]))}</span>`, ` ft-plane${hid ? " hid" : ""}`);
    }
    html += row("origin", "⊹", t("Origin"), "", " ft-plane");
    html += this.bodiesRows(row);
    html += cutListRows(this.cutItems(), !this.closedFolders.has("cutlist"), row, this.doc.cutProps, this.doc.subWelds);
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
      const hid = this.isHidden(f);
      const tools = `<span class="ft-tools">${hid == null ? "" : eyeButton(hid, featureLabel(f.name))}<button class="icon" tabindex="-1" data-a="sup" title="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}" aria-label="${esc(f.suppressed ? t("Unsuppress") : t("Suppress"))}">${f.suppressed ? "◌" : "●"}</button><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
      const relMark = rel ? `<span class="ft-rel" title="${esc(relTip)}" role="img" aria-label="${esc(relTip)}">${par.has(f.id) ? "↑" : "↓"}</span>` : "";
      const ice = i < frozen ? `<span class="ft-ice" title="${esc(t("Frozen"))}" role="img" aria-label="${esc(t("Frozen"))}">❄</span>` : "";
      // External reference (FR-ASM-030): -> in context, ->* locked, ->? out of context (SolidWorks marks).
      const pl = (f as { plane?: PlaneRef }).plane, cr = pl && "ctx" in pl ? pl.ctx : null;
      const xm = cr ? (d.ctxLocked || cr.locked ? ["->*", t("External reference (locked)")] : this.context ? ["->", t("External reference")] : ["->?", t("External reference (out of context)")]) : null;
      const ext = xm ? `<span class="ft-ext" title="${esc(xm[1])}" role="img" aria-label="${esc(xm[1])}" translate="no">${xm[0]}</span>` : "";
      // A feature with an absorbed sketch folds it away (FR-HIS-013).
      const kidsOf = [...absorbed.values()].includes(i), open = !this.closedFeats.has(f.id);
      const twist = kidsOf ? `<button class="icon ft-twist" tabindex="-1" data-a="twist" aria-expanded="${open}" title="${esc(open ? t("Collapse") : t("Expand"))}" aria-label="${esc(open ? t("Collapse") : t("Expand"))}">${open ? "▾" : "▸"}</button>` : "";
      return row(f.id, icon, featureLabel(f.name), ext + relMark + ice + badge + tools, `${hid ? " hid" : ""}${child ? " child" : ""}${inFolder ? " infolder" : ""}${f.suppressed ? " sup" : ""}${i >= end ? " rolled" : ""}${i < frozen ? " frozen" : ""}${editing ? " editing" : ""}${s && !s.ok ? " bad" : ""}${rel}${kidsOf ? " ft-parentrow" : ""}`, ` data-i="${i}" draggable="${m.kind === "none" && i >= frozen}"${kidsOf ? ` aria-expanded="${open}"` : ""}`).replace('<span class="ft-ico"', `${twist}<span class="ft-ico"`);
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
      if (!this.closedFeats.has(f.id)) for (const [si, ui] of absorbed) if (ui === i) html += featRow(d.features[si], si, true);
    });
    if (frozen >= d.features.length && frozen > 0) html += freezeBar;
    if (end >= d.features.length) html += bar;
    box.innerHTML = html;
    const flyName = document.querySelector("#mc-treefly .mc-treefly-n");
    if (flyName) flyName.textContent = d.name;
    if (this.hoverId && this.hoverFrom === "view") box.querySelector(`.ft-row[data-id="${CSS.escape(this.hoverId)}"]`)?.classList.add("hover");
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
      r.addEventListener("dragstart", e => {
        dragId = id;
        e.dataTransfer?.setData("text/plain", id);
        // Ctrl+drag onto a flat face in the view pastes a copy there (FR-HIS-014).
        if (canCopy(this.store?.feature(id))) e.dataTransfer?.setData(FEATURE_DRAG, id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        r.classList.add("dragging");
      });
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
        if (a === "eye") { this.toggleHidden(id); return; }
        if (a === "twist") { this.toggleFeat(id); return; }
        if (a === "del") { void this.deleteFeature(id); return; }
        if (id.startsWith("body:")) {
          const key = id.slice(5);
          if (a === "bhide") { this.setBody(key, { hidden: !this.doc.bodies?.[key]?.hidden }); return; }
          if (a === "bdel") { this.deleteBody(key); return; }
          if ((e.target as HTMLElement).matches("input")) return;
          this.selected = id;
          this.renderTree();
          this.drawDecor();
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
          if (asRef && tg === "upto2") { mm.draft.upTo2 = asRef; this.draftChanged(); return; }
          if (pt && tg === "vertex2") { mm.draft.upToVertex2 = pt; this.draftChanged(); return; }
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
        if (mm.kind === "feature" && mm.draft.type === "hole" && asRef && mm.focus === "hupto" && (mm.draft.end === "upto" || mm.draft.end === "offset")) { mm.draft.upTo = asRef; mm.focus = "pts"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "hole" && mm.focus === "hupto" && mm.draft.end === "vertex" && this.store!.feature(id)?.type === "point") { mm.draft.upToVertex = { point: id }; mm.focus = "pts"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "hole" && asRef && (mm.focus === "hplane" || !mm.draft.plane)) { mm.draft.plane = asRef; mm.draft.pts = []; mm.focus = "pts"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "draft" && asRef && (mm.focus === "nplane" || !mm.draft.plane)) { mm.draft.plane = asRef; mm.focus = "faces"; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "lpattern" && asRef && (mm.focus === "pref" || mm.focus === "pref2")) { if (mm.focus === "pref2") mm.draft.upTo2 = asRef; else mm.draft.upTo = asRef; this.draftChanged(); return; }
        if (mm.kind === "feature" && mm.draft.type === "mirror" && asRef && (mm.focus === "mplane" || !mm.draft.plane)) { mm.draft.plane = asRef; if (!mm.draft.features.length) mm.focus = "seeds"; this.draftChanged(); return; }
        if (mm.kind === "feature" && (mm.draft.type === "lpattern" || mm.draft.type === "cpattern") && (mm.focus === "dir" || mm.focus === "dir2") && this.store!.feature(id)?.type === "axis") {
          const ref: LineRef = { axis: id };
          if (mm.draft.type === "cpattern") mm.draft.axis = ref; else if (mm.focus === "dir2") mm.draft.dir2 = ref; else mm.draft.dir = ref;
          this.draftChanged();
          return;
        }
        if (mm.kind === "feature" && mm.draft.type === "spattern" && mm.draft.src === "sketch" && this.store!.feature(id)?.type === "sketch" && (mm.focus === "psketch" || !mm.draft.sketch)) {
          mm.draft.sketch = id; delete mm.draft.refPt; mm.focus = "seeds"; this.draftChanged(); return;
        }
        if (mm.kind === "feature" && mm.draft.type === "spattern" && mm.draft.src === "table" && this.store!.feature(id)?.type === "csys") { mm.draft.csys = id; this.draftChanged(); return; }
        if (mm.kind === "feature" && isCopy(mm.draft) && (mm.draft.copy ?? "features") === "features" && SEED_TYPES.has(this.store!.feature(id)?.type ?? "") && id !== mm.draft.id) { this.toggleSeed(mm.draft, id); return; }
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
        // A feature picked in the tree shows its dimensions and values on the model, as in SolidWorks (FR-UI-115).
        if (mm.kind === "none") { const f = this.store!.feature(id); this.instant = f && !f.suppressed && this.hasInstant(f) ? id : null; }
        this.selected = id;
        this.renderTree();
        this.drawDecor();
      });
      r.addEventListener("dblclick", e => {
        if ((e.target as HTMLElement).matches("input")) return;
        if (id === "part" || id === "material") { this.editProps(); return; }
        if (id === "equations") { this.editEquations(); return; }
        if (id === "folder:bodies" || id === "folder:cutlist") return;
        if (id.startsWith("cut:")) { this.cutList(); return; }
        if (id.startsWith("folder:") || id.startsWith("body:") || id.startsWith("wsub:")) { if (id.startsWith("folder:")) this.toggleFolder(id.slice(7)); this.startRename(id); return; }
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
        else if (r.classList.contains("ft-parentrow") && (e.key === "ArrowLeft") === !this.closedFeats.has(id) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); this.toggleFeat(id); $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`)?.focus(); }
        else if ((id.startsWith("folder:") || id.startsWith("wsub:")) && e.key === "F2") { e.preventDefault(); this.startRename(id); }
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
      else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const b = bar.getBoundingClientRect(); this.barMenu(b.left + 30, b.bottom); }
    });
    bar.addEventListener("contextmenu", e => { e.preventDefault(); this.barMenu(e.clientX, e.clientY); });
    bar.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
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
      items.push([t("Material…"), () => void this.pickBodyMaterial(key)]);
      if (this.doc.bodies?.[key]?.color) items.push([t("Reset colour"), () => this.setBody(key, { color: undefined })]);
      items.push([t("Delete body"), () => this.deleteBody(key)]);
    }
    if (id === "folder:cutlist" || id.startsWith("cut:") || id.startsWith("wsub:")) items.push([t("Cut List…"), () => this.cutList()]);
    // Sub-weldments (SolidWorks): a cut list item or a weldment body goes into a new or an existing one.
    const wb = this.cutBodies(id);
    if (wb.length && !id.startsWith("wsub:")) {
      const subs = this.doc.subWelds ?? [];
      const inSub = subs.filter(x => wb.some(b => x.bodies.includes(b)));
      items.push([t("Create sub-weldment"), () => this.moveToSub(wb, null)]);
      for (const x of subs) if (!(inSub.length === 1 && inSub[0] === x)) items.push([t("Add to {name}", { name: x.name }), () => this.moveToSub(wb, x.id)]);
      if (inSub.length) items.push([t("Remove from sub-weldment"), () => this.moveToSub(wb, "")]);
    }
    if (id.startsWith("wsub:")) {
      items.push([t("Rename"), () => this.startRename(id)]);
      items.push([t("Dissolve sub-weldment"), () => this.dissolveSub(id.slice(5))]);
    }
    if (id.startsWith("folder:") && id !== "folder:bodies" && id !== "folder:cutlist") {
      items.push([t("Rename"), () => this.startRename(id)]);
      items.push([t("Delete folder (keep features)"), () => this.deleteFolder(id.slice(7))]);
    }
    if (this.clip && (id.startsWith("std:") || (f?.type === "plane" && !f.suppressed))) items.push([t("Paste (Ctrl+V)"), () => this.pasteFeature(id.startsWith("std:") ? { std: id.slice(4) as "XY" } : { plane: id })]);
    if (id.startsWith("std:") || f?.type === "plane") items.push([t("Sketch on this plane"), () => void this.createSketch(id.startsWith("std:") ? { std: id.slice(4) as "XY" } : { plane: id })]);
    if (id.startsWith("std:")) items.push([(this.doc.stdHidden ?? []).includes(id.slice(4) as "XY") ? t("Show") : t("Hide"), () => this.toggleHidden(id)]);
    if (f?.type === "sketch") items.push([this.sketchShown(f) ? t("Hide") : t("Show"), () => this.toggleHidden(f.id)]);
    if (f) {
      items.push([f.type === "sketch" ? t("Edit sketch") : t("Edit feature"), () => this.editFeature(f.id)]);
      if (f.type === "extrude" || f.type === "revolve") items.push([t("Edit sketch"), () => void this.editSketch(f.sketch)]);
      if (f.type === "sketch") items.push([t("Edit sketch plane"), () => this.editSketchPlane(f.id)]);
      if (canCopy(f)) items.push([t("Copy (Ctrl+C)"), () => { this.copyFeature(f.id); }]);
      items.push([t("Rename"), () => this.startRename(f.id)]);
      items.push([f.suppressed ? t("Unsuppress") : t("Suppress"), () => this.toggleSuppress(f.id)]);
      if (f.type === "plane" || f.type === "axis" || f.type === "point" || f.type === "csys" || f.type === "helix" || f.type === "curve" || f.type === "sketch3d") items.push([f.hidden ? t("Show") : t("Hide"), () => this.toggleHidden(f.id)]);
      if (f.type === "csys") items.push(csys.active?.src === f.id ? [t("Back to the global coordinate system"), () => this.useCsys(null)] : [t("Use for measurements and export"), () => this.useCsys(f.id)]);
      items.push(null);
      items.push(...this.rollItems(i, end));
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

  /** The rollback bar's own menu: Roll to previous and Roll to end. */
  private barMenu(x: number, y: number) {
    const items = this.rollItems(null, this.doc.rollback ?? this.doc.features.length);
    if (items.length) this.showMenu(items, x, y, () => $("#mc-tree").querySelector<HTMLElement>(".ft-rollback")?.focus());
  }

  /** Rollback commands of the tree menu (FR-HIS-012): Roll back to here, Roll to previous, Roll forward past this, Roll to end. */
  private rollItems(i: number | null, end: number): [string, () => void][] {
    const items: [string, () => void][] = [];
    if (i != null && i !== end) items.push([t("Roll back to here"), () => this.setRollback(i)]);
    if (this.doc.rollback != null || this.rollPrev !== undefined) items.push([t("Roll to previous"), () => this.rollToPrevious()]);
    if (i != null && (i < end - 1 || i >= end)) items.push([t("Roll forward past this"), () => this.setRollback(i + 1)]);
    if (this.doc.rollback != null) items.push([t("Roll to end"), () => this.setRollback(null)]);
    return items;
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
      const tools = `<span class="ft-tools"><button class="icon ft-eye${hidden ? " off" : ""}" tabindex="-1" data-a="bhide" title="${esc(hidden ? t("Show body") : t("Hide body"))}" aria-label="${esc(hidden ? t("Show body") : t("Hide body"))}: ${esc(name)}">${hidden ? EYE_OFF : EYE}</button>`
        + `<input type="color" class="ft-color" tabindex="-1" data-bcolor value="${hex(st[b.key]?.color)}" title="${esc(t("Body colour"))}" aria-label="${esc(t("Body colour"))}: ${esc(name)}" />`
        + `<button class="icon" tabindex="-1" data-a="bdel" title="${esc(t("Delete body"))}" aria-label="${esc(t("Delete body"))}: ${esc(name)}">✕</button></span>`;
      html += row(`body:${b.key}`, "▣", name, tools, ` infolder ft-body${hidden ? " sup hid" : ""}`);
    }
    return html;
  }

  /** Bodies folder actions: show/hide and colour are display state (one undo step each), delete adds a Body-Delete feature. */
  setBody(key: string, ch: { name?: string; hidden?: boolean; color?: V3; material?: MatRef }) {
    if (!this.store) return;
    // A body being hidden leaves a see-through copy, so Shift+Tab / Ctrl+Shift+Tab can find it again (FR-UI-105).
    // (A shown body keeps its ghost: undo may hide it again; only still-hidden bodies are picked.)
    if (ch.hidden === true) this.keepGhost(key);
    this.store.change(ch.hidden != null ? (ch.hidden ? "Hide body" : "Show body") : "color" in ch ? "Body colour" : "material" in ch ? "Body material" : "Rename body", d => {
      const cur = { ...(d.bodies?.[key] ?? {}), ...ch };
      if (!cur.hidden) delete cur.hidden;
      if (!cur.name) delete cur.name;
      if (!cur.color) delete cur.color;
      if (!cur.material) delete cur.material;
      d.bodies = { ...(d.bodies ?? {}), [key]: cur };
      if (!Object.keys(cur).length) delete d.bodies[key];
      if (!Object.keys(d.bodies).length) delete d.bodies;
    });
    this.renderTree();
    void this.rebuild();
  }

  /** A body's own material from the library (FR-MAT-001); None gives it the part's again. */
  async pickBodyMaterial(key: string) {
    const r = await pickMaterial({ current: this.doc.bodies?.[key]?.material ?? this.doc.material ?? null, allowNone: true });
    if (r) this.setBody(key, { material: r.material ? toRef(r.material) : undefined });
  }

  /**
   * The bodies for mass properties when any has its own material: shown ones (all with `hidden`), each
   * with its density, `fallback` for bodies without one. Null when no body has a material.
   */
  bodyMasses(fallback: number, hidden = false) {
    const st = this.store?.doc.bodies;
    if (!st || !Object.values(st).some(b => b.material)) return null;
    return bodyMasses((this.last?.bodies ?? []).filter(b => hidden || b.faces), k => st[k]?.material?.density, fallback);
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

  /** Folds or unfolds a feature's absorbed sketch row (FR-HIS-013). */
  private toggleFeat(id: string) {
    if (this.closedFeats.has(id)) this.closedFeats.delete(id); else this.closedFeats.add(id);
    this.selected = id;
    this.renderTree();
  }

  /** Whether a feature is hidden in the view (eye button, FR-HIS-013); null: it can't be hidden. */
  private isHidden(f: Feature): boolean | null {
    if (f.type === "sketch") return !this.sketchShown(f);
    if (f.type === "plane" || f.type === "axis" || f.type === "point" || f.type === "csys" || f.type === "helix" || f.type === "curve" || f.type === "sketch3d") return !!f.hidden;
    return null;
  }

  private toggleFolder(fid: string) {
    if (this.closedFolders.has(fid)) this.closedFolders.delete(fid); else this.closedFolders.add(fid);
    this.selected = `folder:${fid}`;
    this.renderTree();
  }

  startRename(id: string) {
    const folder = id.startsWith("folder:") ? this.doc.folders?.find(g => `folder:${g.id}` === id) : undefined;
    const body = id.startsWith("body:") ? id.slice(5) : null;
    const sw = id.startsWith("wsub:") ? this.doc.subWelds?.find(x => `wsub:${x.id}` === id) : undefined;
    const f = this.store?.feature(id);
    const row = $("#mc-tree").querySelector<HTMLElement>(`.ft-row[data-id="${CSS.escape(id)}"]`);
    const name = row?.querySelector<HTMLElement>(".ft-name");
    if ((!f && !folder && !body && !sw) || !row || !name) return;
    const inp = document.createElement("input");
    inp.className = "ft-ren";
    inp.value = folder ? folder.name : sw ? sw.name : body ? this.bodyName(body) : featureLabel(f!.name);
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
    this.noteDraft();
    // Selection box colours (FR-SEL-011) once the panel's markup is in.
    queueMicrotask(() => { this.tintBoxes(); this.drawValueCallouts(); });
    const head = (title: string, help: string, ok = false) => (ok ? okHead(title) : `<div class="pm-head"><h3>${esc(title)}</h3></div>`) + `<p class="pm-help muted">${esc(help)}</p>`;
    if (m.kind === "plane") {
      const ed = m.edit, sk = ed ? this.store.feature(ed.id) : undefined;
      pm.innerHTML = (ed ? head(t("Sketch plane"), t("Pick another plane or flat face for {name}. The sketch keeps its shape; relations to model edges that no longer resolve become dangling.", { name: featureLabel(sk?.name ?? "") }), true)
        + `<p class="pm-help"><b>${esc(t("Plane"))}:</b> <span data-a="cur" translate="no">${esc(this.refLabel(ed.plane))}</span></p>`
        + `<div class="pm-field"><span>${esc(t("X axis"))}</span><button class="pm-box${ed.pickX ? " focus" : ""}" data-a="xpick" title="${esc(t("Click, then click a straight edge: the sketch X axis runs along it"))}">${esc(ed.xAxis ? t("Edge") : t("Plane direction"))}</button></div>`
        + (ed.xAxis ? `<label class="chk pm-chk"><input type="checkbox" data-a="xflip"${ed.xAxis.flip ? " checked" : ""} />${esc(t("Reverse X axis"))}</label><button class="btn small" data-a="xclear">${esc(t("Use the plane direction"))}</button>` : "")
        : head(t("Sketch"), t("Pick a plane or a flat face for the sketch.")))
        + `<div class="pm-planes">${(["XY", "XZ", "YZ"] as const).map(s => `<button class="btn small" data-std="${s}">${esc(t(STD_NAMES[s]))}</button>`).join("")}</div>`;
      pm.querySelectorAll<HTMLElement>("[data-std]").forEach(b => b.addEventListener("click", () => this.planePicked({ std: b.dataset.std as "XY" })));
      pm.querySelector("[data-a=ok]")?.addEventListener("click", () => this.ok());
      pm.querySelector("[data-a=cancel]")?.addEventListener("click", () => void this.cancel());
      if (ed) {
        pm.querySelector("[data-a=xpick]")?.addEventListener("click", () => { ed.pickX = !ed.pickX; this.renderPanel(); this.renderBar(); });
        pm.querySelector<HTMLInputElement>("[data-a=xflip]")?.addEventListener("change", ev => { if (ed.xAxis) { if ((ev.target as HTMLInputElement).checked) ed.xAxis.flip = true; else delete ed.xAxis.flip; } this.renderPanel(); void this.rebuild(); });
        pm.querySelector("[data-a=xclear]")?.addEventListener("click", () => { delete ed.xAxis; ed.pickX = false; this.renderPanel(); void this.rebuild(); });
      }
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
      const ends: [string, string][] = [["blind", t("Blind")], ["mid", t("Mid plane")], ["through", t("Through all")], ...(f.op === "cut" ? [["through2", t("Through all - both")] as [string, string]] : []), ["next", t("Up to next")], ["vertex", t("Up to vertex")], ["upto", t("Up to face or plane")], ["offset", t("Offset from surface")], ["body", t("Up to body")]];
      const tg = this.extrudeTarget(f, m.focus);
      const starts: [string, string][] = [["sketch", t("Sketch plane")], ["offset", t("Offset")], ["surface", t("Surface/Face/Plane")], ["vertex", t("Vertex")]];
      const startSel = `<label class="pm-field"><span>${esc(t("Start from"))}</span><select data-k="start">${starts.map(([v, l]) => `<option value="${v}"${(f.start ?? "sketch") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
        + (f.start === "offset" ? numField("startOffset", t("Start offset"), f.startOffset ?? { v: 10 }, "length") + chk("startReverse", f.startReverse, t("Reverse direction")) : "")
        + (f.start === "surface" || f.start === "vertex" ? `<div class="pm-field"><span>${esc(t("Start at"))}</span><button class="pm-box${tg?.startsWith("start") ? " focus" : ""}" data-focus="start" translate="no">${esc(f.start === "surface" ? this.refLabel(f.startRef) : this.vertexLabel(f.startVertex))}</button></div>` : "");
      const endSel = `<label class="pm-field"><span>${esc(t("End condition"))}</span><select data-k="end">${ends.map(([v, l]) => `<option value="${v}"${f.end === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
      const upto = f.end === "upto" || f.end === "offset";
      const thinSel = f.thin ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="thinMode">${([["inside", t("Inside the profile")], ["outside", t("Outside the profile")], ["mid", t("Mid-plane")]] as const).map(([v, l]) => `<option value="${v}"${f.thin!.mode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` + numField("thin.t", t("Thickness"), f.thin.t, "length") : "";
      // Direction 2 (FR-FT-011): its own end condition, as SolidWorks offers (no mid plane or through all - both).
      const e2 = f.end2 ?? "blind";
      const bodyName = (r: FaceRef | undefined) => r ? t("Body of {name}", { name: featureLabel(this.store?.feature(r.name.split(":")[0])?.name ?? "?") }) : t("None");
      const draft2On = !!f.draft2 && Math.abs(f.draft2.angle.v) > 1e-9;
      const dir2Body = `<label class="pm-field"><span>${esc(t("End condition"))}</span><select data-k="end2">${DIR2_ENDS.map(v => `<option value="${v}"${e2 === v ? " selected" : ""}>${esc(ends.find(x => x[0] === v)![1])}</option>`).join("")}</select></label>`
        + (e2 === "upto" || e2 === "offset" ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "upto2" ? " focus" : ""}" data-focus="upto2" aria-label="${esc(t("Up to (direction 2)"))}: ${esc(this.refLabel(f.upTo2))}" translate="no">${esc(this.refLabel(f.upTo2))}</button></div>` : "")
        + (e2 === "vertex" ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "vertex2" ? " focus" : ""}" data-focus="upto2" translate="no">${esc(this.vertexLabel(f.upToVertex2))}</button></div>` : "")
        + (e2 === "body" ? `<div class="pm-field"><span>${esc(t("Body"))}</span><button class="pm-box${tg === "body2" ? " focus" : ""}" data-focus="upbody2" translate="no">${esc(bodyName(f.upToBody2))}</button></div>` : "")
        + (e2 === "offset" ? numField("upToOffset2", t("Offset distance"), f.upToOffset2 ?? { v: 5 }, "length") + chk("reverseOffset2", f.reverseOffset2, t("Reverse offset")) : "")
        + (e2 === "blind" ? numField("depth2", t("Depth 2"), f.depth2 ?? f.depth, "length")
          // Direction 2's own draft (FR-FT-014), as SolidWorks: off at 0°.
          + chk("draft2On", draft2On, t("Draft on/off")) + (draft2On ? numField("draft2.angle", t("Draft angle"), f.draft2!.angle, "angle") + chk("draft2Out", f.draft2!.outward, t("Draft outward")) : "") : "");
      // Selected Contours comes first when the sketch needs it, as SolidWorks opens that box.
      const needCt = this.needsContours(f);
      body = (needCt ? this.contoursGroup(f, m.focus) : "") + group(t("From"), sketchSel(f.sketch) + opSel(f.op) + (f.op === "boss" && this.last?.data ? chk("merge", f.merge !== false, t("Merge result")) : "") + startSel)
        + group(t("Direction 1"), endSel
          + (upto ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "upto" ? " focus" : ""}" data-k="focus-upto" data-focus="upto" aria-label="${esc(t("Up to"))}: ${esc(this.refLabel(f.upTo))}" translate="no">${esc(this.refLabel(f.upTo))}</button></div><p class="pm-help muted">${esc(t("Click a flat face or a plane in the view or the tree."))}</p>` : "")
          + (f.end === "vertex" ? `<div class="pm-field"><span>${esc(t("Up to"))}</span><button class="pm-box${tg === "vertex" ? " focus" : ""}" data-focus="upto" translate="no">${esc(this.vertexLabel(f.upToVertex))}</button></div><p class="pm-help muted">${esc(t("Click near the end of an edge, or a reference point in the tree."))}</p>` : "")
          + (f.end === "next" ? `<p class="pm-help muted">${esc(t("Stops at the next face the profile meets."))}</p>` : "")
          + (f.end === "body" ? `<div class="pm-field"><span>${esc(t("Body"))}</span><button class="pm-box${tg === "body" ? " focus" : ""}" data-focus="upbody" translate="no">${esc(f.upToBody ? t("Body of {name}", { name: featureLabel(this.store?.feature(f.upToBody.name.split(":")[0])?.name ?? "?") }) : t("None"))}</button></div><p class="pm-help muted">${esc(t("Click any face of the body the extrusion stops at."))}</p>` : "")
          + (f.end === "offset" ? numField("upToOffset", t("Offset distance"), f.upToOffset ?? { v: 5 }, "length") + chk("reverseOffset", f.reverseOffset, t("Reverse offset")) : "")
          + (f.end === "through" || f.end === "through2" || f.end === "next" || f.end === "vertex" || f.end === "body" || upto ? "" : numField("depth", t("Depth"), f.depth, "length"))
          + (upto || f.end === "vertex" ? "" : chk("flip", f.flip, t("Reverse direction")))
          + (f.op === "cut" ? chk("outside", f.outside, t("Flip side to cut (keep inside the profile)")) : "")
          + (f.end === "blind" || f.end === "mid" ? chk("draftOn", !!f.draft, t("Draft on/off")) + (f.draft ? numField("draft.angle", t("Draft angle"), f.draft.angle, "angle") + chk("draftOut", f.draft.outward, t("Draft outward")) : "") : "")
          + (f.end === "blind" || f.end === "mid" ? `<p class="pm-help muted">${esc(t("Or drag the orange arrow in the view."))}</p>` : ""))
        + (f.end !== "mid" && f.end !== "through2" ? group(t("Direction 2"), chk("dir2", hasDir2(f), t("Direction 2")) + (hasDir2(f) ? dir2Body : "")) : "")
        + group(t("Thin feature"), chk("thinOn", !!f.thin, t("Thin feature")) + thinSel)
        + (needCt ? "" : this.contoursGroup(f, m.focus)) + this.scopeGroup(f, m.focus);
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
        + group(t("Thin feature"), chk("thinOn", !!f.thin, t("Thin feature")) + (f.thin ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="thinMode">${([["inside", t("Inside the profile")], ["outside", t("Outside the profile")], ["mid", t("Mid-plane")]] as const).map(([v, l]) => `<option value="${v}"${f.thin!.mode === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` + numField("thin.t", t("Thickness"), f.thin.t, "length") : ""))
        + this.contoursGroup(f, m.focus) + this.scopeGroup(f, m.focus);
    } else if (f.type === "fillet" || f.type === "chamfer") {
      title = f.type === "fillet" ? t("Fillet") : t("Chamfer");
      const cm = f.type === "chamfer" ? f.mode ?? "equal" : "equal";
      const multi = f.type === "fillet" && !!f.multi;
      const vari = f.type === "fillet" && !!f.variable;
      const rIn = (key: string, i: number, v: number, label: string) => `<span class="pm-in"><input type="text" inputmode="decimal" data-${key}="${i}" value="${esc(trimNum(v * UNITS[unit].f, 6))}" aria-label="${esc(label)} ${esc(t("Edge {n}", { n: i + 1 }))}" spellcheck="false" /><span class="muted">${unit}</span></span>`;
      const fu = UNITS[unit].f;
      const items = `<ul class="pm-items" aria-label="${esc(t("Edges"))}">${f.edges.map((e, i) => `<li><span>${esc(t("Edge {n}", { n: i + 1 }))}</span>${vari ? rIn("er", i, (e as { r?: number }).r ?? (f as FilletFeature).radius.v, t("Start radius")) + rIn("er2", i, (e as { r2?: number; r?: number }).r2 ?? (e as { r?: number }).r ?? (f as FilletFeature).radius.v, t("End radius")) : ""}${multi ? `<span class="pm-in"><input type="text" inputmode="decimal" data-er="${i}" value="${esc(trimNum(((e as { r?: number }).r ?? (f as FilletFeature).radius.v) * fu, 6))}" aria-label="${esc(t("Radius"))} ${esc(t("Edge {n}", { n: i + 1 }))}" spellcheck="false" /><span class="muted">${unit}</span></span>` : ""}<button class="icon" data-rm="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(t("Edge {n}", { n: i + 1 }))}">✕</button></li>`).join("")}</ul>`
        + (f.edges.length ? `<button class="btn small" data-k="clear">${esc(t("Clear edges"))}</button>` : `<p class="pm-help muted">${esc(t("click edges or faces in the view"))}</p>`);
      const sizes = (f.type === "chamfer" ? `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mode"><option value="equal"${cm === "equal" ? " selected" : ""}>${esc(t("Equal distance"))}</option><option value="two"${cm === "two" ? " selected" : ""}>${esc(t("Two distances"))}</option><option value="angle"${cm === "angle" ? " selected" : ""}>${esc(t("Distance and angle"))}</option><option value="offset"${cm === "offset" ? " selected" : ""}>${esc(t("Offset face"))}</option><option value="vertex"${cm === "vertex" ? " selected" : ""}>${esc(t("Vertex"))}</option></select></label>` : "")
        + (f.type === "fillet" ? numField("radius", multi ? t("Default radius") : t("Radius"), f.radius, "length") + chk("multi", f.multi, t("Multiple radius fillet")) + chk("variable", f.variable, t("Variable radius fillet")) + (multi ? `<p class="pm-help muted">${esc(t("Type each edge's radius in the list, or click its callout in the view."))}</p>` : "") + (vari ? `<p class="pm-help muted">${esc(t("Each edge goes from its start radius (a) to its end radius (b): type them in the list or click the callouts at the edge ends."))}</p>` : "") : numField("distance", t("Distance"), f.distance, "length"))
        + (f.type === "chamfer" && (cm === "two" || cm === "vertex") ? numField("distance2", t("Distance 2"), f.distance2 ?? { v: f.distance.v }, "length") : "")
        + (f.type === "chamfer" && cm === "vertex" ? numField("distance3", t("Distance 3"), f.distance3 ?? { v: f.distance.v }, "length") + `<p class="pm-help muted">${esc(t("Distance 1 runs along the edge you clicked next to the corner; 2 and 3 along the other two edges."))}</p>` : "")
        + (f.type === "chamfer" && cm === "offset" ? `<p class="pm-help muted">${esc(t("Both faces move in by the distance; the chamfer runs where they meet, so it stays even on faces that are not square."))}</p>` : "")
        + (f.type === "chamfer" && cm === "angle" ? numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 4 }, "angle") : "")
        + (f.type === "chamfer" && (cm === "two" || cm === "angle") ? chk("flip", f.flip, t("Flip direction")) : "");
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
      } else if (f.type === "chamfer" && cm === "vertex") {
        const vs = f.vertices ?? [];
        body = group(t("Items to chamfer"), `<p class="pm-count">${esc(t("{n} vertex|{n} vertices", { n: vs.length }))}</p><ul class="pm-items" aria-label="${esc(t("Vertices"))}">${vs.map((v, i) => `<li><span translate="no">${esc(this.vertexLabel(v))}</span><button class="icon" data-rmv="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(this.vertexLabel(v))}">✕</button></li>`).join("")}</ul>`
            + `<p class="pm-help muted">${esc(t("Click near a corner on one of its edges: the corner of three straight edges is cut off."))}</p>`)
          + group(t("Chamfer parameters"), sizes);
      } else
      body = kindSel + group(f.type === "fillet" ? t("Items to fillet") : t("Items to chamfer"), `<p class="pm-count">${esc(t("{n} edge|{n} edges", { n: f.edges.length }))}</p>` + items)
        + group(f.type === "fillet" ? t("Fillet parameters") : t("Chamfer parameters"), sizes)
        + (f.type === "fillet" ? group(t("Setback parameters"), `<div class="pm-field"><span>${esc(t("Setback vertices"))}</span><button class="pm-box${m.focus === "sbv" ? " focus" : ""}" data-k="sbfocus" aria-pressed="${m.focus === "sbv"}" translate="no">${esc(f.setbacks?.length ? t("{n} vertex|{n} vertices", { n: f.setbacks.length }) : t("None"))}</button></div>`
          + (f.setbacks?.length ? `<ul class="pm-items" aria-label="${esc(t("Setback vertices"))}">${f.setbacks.map((s, i) => `<li><span translate="no">${esc(this.vertexLabel(s.v))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-sb="${i}" value="${esc(trimNum(s.d * fu, 6))}" aria-label="${esc(t("Setback distance"))} ${i + 1}" spellcheck="false" /><span class="muted">${unit}</span></span><button class="icon" data-rmsb="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(this.vertexLabel(s.v))}">✕</button></li>`).join("")}</ul>` : "")
          + `<p class="pm-help muted">${esc(t("Click the box, then near a corner where three or more filleted edges meet: the fillets stop the setback distance from the corner and one smooth patch blends it. Click the box again to go back to picking edges."))}</p>`) : "")
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
      // FR-FT-051 UX: Type and Positions tabs as in SolidWorks; view picks work on either tab.
      if (this.holeTabOf !== f) { this.holeTabOf = f; this.holeTab = "type"; }
      const tab = this.holeTab;
      const kindNames: Record<HoleFeature["kind"], string> = { simple: t("Simple hole"), clear: t("Clearance hole"), cbore: t("Counterbore"), cdrill: t("Counterdrill"), csink: t("Countersink"), tapped: t("Tapped hole"), slot: t("Slot"), insert: t("Heat-set insert") };
      const favOpen = (() => { try { return localStorage.getItem("mc:holeFavOpen") === "1"; } catch { return false; } })();
      const typeTab = this.holePreview(f)
        + `<details class="pm-group pm-favs" data-ui="favs"${favOpen ? " open" : ""}><summary>${esc(t("Favourites"))}${favs.length ? ` <span class="muted">(${favs.length})</span>` : ""}</summary><label class="pm-field"><span>${esc(t("Favourite"))}</span><select data-ui="fav"><option value="">${esc(t("None"))}</option>${favs.map((x, i) => `<option value="${i}" translate="no">${esc(x.name)}</option>`).join("")}</select></label>`
          + `<label class="pm-field"><span>${esc(t("Name"))}</span><input type="text" data-ui="favName" value="${esc(holeTitle(f))}" spellcheck="false" translate="no" /></label>`
          + `<div class="pm-rels"><button class="btn small" data-ui="favSave">${esc(t("Save as favourite"))}</button>${favs.length ? `<button class="btn small" data-ui="favDel">${esc(t("Delete favourite"))}</button>` : ""}</div></details>`
        + group(t("Hole type"), `<div class="pm-hkinds" role="group" aria-label="${esc(t("Hole type"))}">${HOLE_KINDS.map(k => `<button type="button" class="pm-hkind${f.kind === k ? " on" : ""}" data-hkind="${k}" aria-pressed="${f.kind === k}" title="${esc(kindNames[k])}" aria-label="${esc(kindNames[k])}">${holeIcon(k)}</button>`).join("")}</div>` + sel("kind", t("Type"), [["simple", t("Simple hole")], ["clear", t("Clearance hole")], ["cbore", t("Counterbore")], ["cdrill", t("Counterdrill")], ["csink", t("Countersink")], ["tapped", t("Tapped hole")], ["slot", t("Slot")], ["insert", t("Heat-set insert")]], f.kind)
          + (f.kind !== "insert" ? sel("standard", t("Standard"), [["iso", t("ISO metric")], ["isofine", t("ISO metric fine")], ["unc", t("ANSI inch UNC")], ["unf", t("ANSI inch UNF")]], holeStd(f)) : "")
          + sel("size", t("Size"), [["", t("Custom")], ...(f.kind === "insert" ? HEAT_INSERTS : HOLE_STANDARDS[holeStd(f)]).map(h => [h.size, h.size] as [string, string])], f.size ?? "")
          + (f.kind === "insert" && insertSize(f.size) ? `<p class="pm-help muted" data-insert>${esc(t("Insert length {l} mm; keep at least {w} mm of wall around the hole (boss Ø {b} mm).", { l: trimNum(insertSize(f.size)!.length, 2), w: trimNum(insertSize(f.size)!.wall, 2), b: trimNum(insertSize(f.size)!.hole + 2 * insertSize(f.size)!.wall, 2) }))}</p>` : "")
          + (f.kind !== "tapped" && f.kind !== "insert" && f.size ? sel("fit", t("Clearance fit"), [["close", t("Close fit")], ["normal", t("Normal fit")], ["loose", t("Loose fit")]], f.fit ?? "normal") : ""))
        + group(t("Hole specification"), numField("diameter", f.kind === "tapped" ? t("Tap drill diameter") : t("Diameter"), f.diameter, "length")
          + (f.kind === "cbore" ? numField("cbDia", t("Counterbore diameter"), f.cbDia ?? { v: f.diameter.v * 1.7 }, "length") + numField("cbDepth", t("Counterbore depth"), f.cbDepth ?? { v: f.diameter.v }, "length") : "")
          + (f.kind === "csink" ? numField("csDia", t("Countersink diameter"), f.csDia ?? { v: f.diameter.v * 2 }, "length") + numField("csAngle", t("Countersink angle"), f.csAngle ?? { v: Math.PI / 2 }, "angle") : "")
          + (f.kind === "cdrill" ? numField("cdDia", t("Counterdrill diameter"), f.cdDia ?? { v: f.diameter.v * 1.7 }, "length") + numField("cdDepth", t("Counterdrill depth"), f.cdDepth ?? { v: f.diameter.v }, "length") + numField("cdAngle", t("Counterdrill angle"), f.cdAngle ?? { v: (118 * Math.PI) / 180 }, "angle") : "")
          + (f.kind === "slot" ? numField("slotLen", t("Slot length"), f.slotLen ?? { v: f.diameter.v * 2 }, "length") + numField("slotAngle", t("Slot angle"), f.slotAngle ?? { v: 0 }, "angle") : ""))
        + group(t("End condition"), sel("end", t("End condition"), [["blind", t("Blind")], ["through", t("Through all")], ["next", t("Up to next")], ["vertex", t("Up to vertex")], ["upto", t("Up to face or plane")], ["offset", t("Offset from surface")]], f.end)
          + (f.end === "upto" || f.end === "offset" ? hbox("hupto", t("Up to"), this.refLabel(f.upTo)) + `<p class="pm-help muted">${esc(t("Click a flat face or a plane in the view or the tree."))}</p>` : "")
          + (f.end === "offset" ? numField("upToOffset", t("Offset distance"), f.upToOffset ?? { v: 5 }, "length") + chk("reverseOffset", f.reverseOffset, t("Reverse offset")) : "")
          + (f.end === "vertex" ? hbox("hupto", t("Up to"), this.vertexLabel(f.upToVertex)) + `<p class="pm-help muted">${esc(t("Click near the end of an edge, or a reference point in the tree."))}</p>` : "")
          + (f.end === "next" ? `<p class="pm-help muted">${esc(t("Each hole stops where it leaves the material."))}</p>` : "")
          + (f.end === "blind" ? numField("depth", t("Depth"), f.depth, "length") + chk("flat", f.flat, t("Flat bottom (no drill point)")) + (f.flat ? "" : numField("drillAngle", t("Drill angle"), f.drillAngle ?? { v: (118 * Math.PI) / 180 }, "angle")) : "")
          // The thread's own end condition sits under the hole's, as in SolidWorks' End Condition box.
          + (f.kind === "tapped" && holeExits(f) ? sel("threadEnd", t("Thread"), [["blind", t("Blind")], ["through", t("Through all")]], f.threadEnd ?? "blind") : "")
          + (f.kind === "tapped" && !threadThrough(f) ? numField("threadDepth", t("Thread depth"), f.threadDepth ?? { v: f.diameter.v * 2 }, "length") : "")
          + chk("flip", f.flip, t("Reverse direction")))
        + (f.kind === "insert" ? "" : group(t("Options"),
          (f.kind === "cbore" || f.kind === "csink" ? chk("optHead", !!f.headClear, t("Head clearance")) + (f.headClear ? numField("headClear", t("Head clearance"), f.headClear, "length") : "") : "")
          + (f.kind !== "csink" ? chk("optNear", !!f.nearCs, t("Near side countersink")) + (f.nearCs ? numField("nearCs.dia", t("Diameter"), f.nearCs.dia, "length") + numField("nearCs.angle", t("Angle"), f.nearCs.angle, "angle") : "") : "")
          + (f.kind === "cbore" ? chk("optUnder", !!f.underCs, t("Under head countersink")) + (f.underCs ? numField("underCs.dia", t("Diameter"), f.underCs.dia, "length") + numField("underCs.angle", t("Angle"), f.underCs.angle, "angle") : "") : "")
          + (holeExits(f) && f.kind !== "slot" ? chk("optFar", !!f.farCs, t("Far side countersink")) + (f.farCs ? numField("farCs.dia", t("Diameter"), f.farCs.dia, "length") + numField("farCs.angle", t("Angle"), f.farCs.angle, "angle") : "") : "")));
      const posTab = group(t("Positions"), hbox("hplane", t("Face"), this.refLabel(f.plane)) + hbox("pts", t("Hole positions"), t("{n} hole|{n} holes", { n: f.pts.length }))
          + (f.pts.length ? `<ul class="pm-items pm-hpts" aria-label="${esc(t("Hole positions"))}">${f.pts.map((p, i) => `<li><span>${i + 1}</span>${holeAxes(this.last?.frames[f.id]).names.map((ax, j) => `<span class="pm-in"><span class="muted">${ax}</span><input type="text" inputmode="decimal" data-hp="${i}:${j}" value="${esc(trimNum(holeAxes(this.last?.frames[f.id]).show(p)[j] * UNITS[unit].f, 6))}" aria-label="${esc(t("Hole {n}", { n: i + 1 }))} ${ax}" spellcheck="false" /></span>`).join("")}<button class="icon" data-rmh="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(t("Hole {n}", { n: i + 1 }))}">✕</button></li>`).join("")}</ul>` : "")
          + (f.plane ? `<button class="btn small" data-k="addPt">${esc(t("Add hole"))}</button> ` : "")
          + (f.pts.length ? `<button class="btn small" data-k="clearPts">${esc(t("Clear holes"))}</button>` : "")
          + `<p class="pm-help muted">${esc(f.plane ? t("Click on the face to place holes; click a hole again to remove it.") : t("Click the flat face (or a plane) for the holes."))}</p>`);
      const tabBtn = (k: "type" | "pos", label: string) => `<button type="button" role="tab" data-tab="${k}" data-htab="${k}" class="${tab === k ? "on" : ""}" aria-selected="${tab === k}" tabindex="${tab === k ? 0 : -1}">${esc(label)}</button>`;
      body = `<div class="tabs pm-htabs" role="tablist" aria-label="${esc(t("Hole"))}">${tabBtn("type", t("Type"))}${tabBtn("pos", f.pts.length ? `${t("Positions")} (${f.pts.length})` : t("Positions"))}</div>`
        + `<div class="pm-htab" data-hpane="type"${tab === "type" ? "" : " hidden"}>${typeTab}</div><div class="pm-htab" data-hpane="pos"${tab === "pos" ? "" : " hidden"}>${posTab}</div>`;
    }
    if (f.type === "draft") {
      title = t("Draft");
      const dbox = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      const parting = f.kind === "parting";
      const kindSel = `<label class="pm-field"><span>${esc(t("Type of draft"))}</span><select data-k="dkind"><option value="neutral"${parting ? "" : " selected"}>${esc(t("Neutral plane"))}</option><option value="parting"${parting ? " selected" : ""}>${esc(t("Parting line"))}</option></select></label>`;
      if (parting) body = group(t("Type of draft"), kindSel) + group(t("Draft angle"), numField("angle", t("Angle"), f.angle, "angle"))
        + group(t("Direction of pull"), dbox("nplane", t("Plane"), this.refLabel(f.plane)) + chk("flip", f.flip, t("Reverse direction")))
        + group(t("Parting line"), dbox("faces", t("Edges"), t("{n} edge|{n} edges", { n: f.parting?.length ?? 0 }))
          + (f.parting?.length ? `<button class="btn small" data-k="clearParting">${esc(t("Clear edges"))}</button>` : "") + chk("other", f.other, t("Other face"))
          + `<p class="pm-help muted">${esc(m.focus === "nplane" || !f.plane ? t("Click a plane or a flat face in the view or the tree.") : t("Click the edges of the parting line: the face on one side of each tapers from it. Other face drafts the face on the far side."))}</p>`);
      else
      body = group(t("Type of draft"), kindSel) + group(t("Draft angle"), numField("angle", t("Angle"), f.angle, "angle"))
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
      const dfSel = f.type === "delface" ? group(t("Options"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="dfmode">${([["patch", t("Delete and patch")], ["delete", t("Delete (leave a surface)")]] as const).map(([v, l]) => `<option value="${v}"${(f.mode ?? "patch") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`) : "";
      body = dfSel + (f.type === "moveface" ? group(t("Parameters"), mvSel + mvParams) : "")
        + group(f.type === "delface" ? t("Faces to delete") : t("Faces to move"), `<p class="pm-count">${esc(t("{n} face|{n} faces", { n: f.faces.length }))}</p>`
          + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
          + `<p class="pm-help muted">${esc(f.type === "delface" ? (f.mode === "delete" ? t("Click the faces to remove; the rest of the solid becomes an open surface body.") : t("Click the faces to remove; the faces around them grow to close the gap."))
            : mvMode === "rotate" ? (m.focus === "axis" ? t("Click the edge to turn about: an edge of the face, or a reference axis in the tree.") : t("Click flat faces to turn them about the axis; the faces around them follow."))
            : mvMode === "translate" ? t("Click flat faces to move them; only the part of the move along each face's normal changes it.")
            : t("Click flat faces to move them along their normals; out adds material, reversed removes it."))}</p>`);
    }
    if (f.type === "shell" || isCopy(f)) {
      const box = (focus: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${m.focus === focus ? " focus" : ""}" data-focus="${focus}" translate="no">${esc(value)}</button></div>`;
      const intField = (key: string, label: string, v: number) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="numeric" data-int="${key}" value="${v}" spellcheck="false" /></span></label>`;
      const seeds = isCopy(f) ? (f.features.map(id => this.store!.feature(id)).filter(Boolean).map(x => featureLabel(x!.name)).join(", ") || t("None")) : "";
      const what = isCopy(f) ? f.copy ?? "features" : "features";
      const whatSel = isCopy(f) ? `<label class="pm-field"><span>${esc(t("Copy"))}</span><select data-k="copyKind">${([["features", t("Features")], ["faces", t("Faces")], ["bodies", t("Bodies")]] as const).map(([v, l]) => `<option value="${v}"${what === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : "";
      const picked = isCopy(f) ? (what === "faces" ? f.faces ?? [] : f.bodies ?? []) : [];
      const seedGroup = !isCopy(f) ? "" : what === "features" ? group(f.type === "mirror" ? t("Features to mirror") : t("Features to pattern"), whatSel + box("seeds", t("Features"), seeds)
        + `<p class="pm-help muted">${esc(f.type === "mirror" ? t("Click faces of the features (or rows in the tree); none mirrors the whole body.") : t("Click faces of the features, or rows in the tree."))}</p>`
        + chk("geometry", !f.vary, t("Geometry pattern"))
        + `<p class="pm-help muted">${esc(t("Off: each instance is built again where it lands, so end conditions such as up to face hold there."))}</p>`)
        : group(what === "faces" ? t("Faces to copy") : t("Bodies to copy"), whatSel + `<p class="pm-count">${esc(what === "faces" ? t("{n} face|{n} faces", { n: picked.length }) : t("{n} body|{n} bodies", { n: picked.length }))}</p>`
          + (picked.length ? `<button class="btn small" data-k="clearCopy">${esc(what === "faces" ? t("Clear faces") : t("Clear bodies"))}</button>` : "")
          + (f.type === "mirror" && what === "bodies" ? chk("merge", f.merge, t("Merge solids")) : "")
          + `<p class="pm-help muted">${esc(what === "faces" ? t("Click all the faces of a boss or a cut: the copies add or remove the same shape.") : t("Click a face of each body to copy; the copies become new bodies."))}</p>`);
      const skipN = (f.type === "lpattern" || f.type === "cpattern") ? (f.skip ?? []).length : 0;
      const skip = (f.type === "lpattern" || f.type === "cpattern") ? group(t("Instances to skip"), box("skip", t("Instances"), skipN ? t("{n} skipped", { n: skipN }) : t("None"))
        + `<p class="pm-help muted">${esc(t("Click this box, then the dots in the view: a filled dot is an instance, a hollow one is skipped."))}</p>`
        + `<label class="pm-field"><span>${esc(t("Skip"))}</span><input type="text" data-k="skip" value="${esc((f.skip ?? []).join("; "))}" spellcheck="false" placeholder="${f.type === "lpattern" && f.dir2 ? "1,1; 2,0" : "2; 3"}" /></label><p class="pm-help muted">${esc(f.type === "lpattern" && f.dir2 ? t("Instance numbers as column,row from 0 (the seed is 0,0), separated by semicolons.") : f.type === "cpattern" && f.dir2 ? t("Instance numbers from 0 (the seed is 0), direction 2 as -1, -2…, separated by semicolons.") : t("Instance numbers from 0 (the seed is 0), separated by semicolons."))}</p>`) : "";
      if (f.type === "shell") {
        title = t("Shell");
        body = group(t("Parameters"), numField("thickness", t("Thickness"), f.thickness, "length") + chk("outward", f.outward, t("Shell outward")))
          + group(t("Faces to remove"), `<div class="pm-field"><span>${esc(t("Faces"))}</span><button class="pm-box${m.focus !== "mthick" ? " focus" : ""}" data-focus="faces" translate="no">${esc(f.faces.length ? t("{n} face|{n} faces", { n: f.faces.length }) : t("None"))}</button></div>`
            + (f.faces.length ? `<button class="btn small" data-k="clearFaces">${esc(t("Clear faces"))}</button>` : "")
            + `<p class="pm-help muted">${esc(t("Click the faces to leave open; none makes a closed hollow body."))}</p>`)
          + group(t("Multi-thickness settings"), `<div class="pm-field"><span>${esc(t("Faces"))}</span><button class="pm-box${m.focus === "mthick" ? " focus" : ""}" data-focus="mthick" translate="no">${esc(f.multi?.length ? t("{n} face|{n} faces", { n: f.multi.length }) : t("None"))}</button></div>`
            + `<ul class="pm-items" aria-label="${esc(t("Multi-thickness faces"))}">${(f.multi ?? []).map((x, i) => `<li><span>${esc(t("Face {n}", { n: i + 1 }))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-mt="${i}" value="${esc(trimNum(x.t * UNITS[unit].f, 6))}" aria-label="${esc(t("Thickness"))} ${esc(t("Face {n}", { n: i + 1 }))}" spellcheck="false" /><span class="muted">${unit}</span></span><button class="icon" data-rmt="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${esc(t("Face {n}", { n: i + 1 }))}">✕</button></li>`).join("")}</ul>`
            + `<p class="pm-help muted">${esc(t("Click this box, then flat faces whose walls need their own thickness; type each one in the list."))}</p>`);
      } else if (f.type === "mirror") {
        title = t("Mirror");
        body = group(t("Mirror face/plane"), box("mplane", t("Plane"), this.refLabel(f.plane)) + `<p class="pm-help muted">${esc(t("Click a plane or a flat face in the view or the tree."))}</p>`) + seedGroup;
      } else if (f.type === "lpattern") {
        title = t("Linear pattern");
        // Spacing and instances, or Up to distance (the distance from the seed to the last instance), per direction.
        const how = (k: "total" | "total2", cur: string) => `<label class="pm-field"><span>${esc(t("Spacing"))}</span><select data-k="${k}">${([["", t("Spacing and instances")], ["1", t("Up to distance")], ["ref", t("Up to reference")]] as const).map(([v, l]) => `<option value="${v}"${cur === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
        // Up to reference: a plane or flat face to stop at, an offset short of it, and the spacing that follows.
        const refPart = (two: boolean) => {
          const ref = two ? f.upTo2 : f.upTo, off = (two ? f.upToOffset2 : f.upToOffset) ?? { v: 0 };
          return box(two ? "pref2" : "pref", t("Reference"), this.refLabel(ref)) + numField(two ? "upToOffset2" : "upToOffset", t("Offset distance"), off, "length")
            + `<p class="pm-help muted">${esc(t("Click a plane or flat face across the direction: the last instance stops the offset short of it, measured from the seed's centre."))}</p>`;
        };
        const mode1 = f.upTo || m.focus === "pref" ? "ref" : f.total ? "1" : "", mode2 = f.upTo2 || m.focus === "pref2" ? "ref" : f.total2 ? "1" : "";
        body = group(t("Direction 1"), box("dir", t("Direction"), this.lineLabel(f.dir)) + how("total", mode1) + (mode1 === "ref" ? refPart(false) : numField("spacing", f.total ? t("Distance") : t("Spacing"), f.spacing, "length")) + intField("count", t("Instances"), f.count) + chk("flip", f.flip, t("Reverse direction")))
          + group(t("Direction 2"), chk("useDir2", !!f.dir2 || m.focus === "dir2", t("Direction 2"))
            + (f.dir2 || m.focus === "dir2" ? box("dir2", t("Direction"), this.lineLabel(f.dir2)) + how("total2", mode2) + (mode2 === "ref" ? refPart(true) : numField("spacing2", f.total2 ? t("Distance") : t("Spacing"), f.spacing2 ?? { v: f.spacing.v }, "length")) + intField("count2", t("Instances"), f.count2 ?? 2) + chk("flip2", f.flip2, t("Reverse direction"))
              + chk("seedOnly", f.seedOnly, t("Pattern seed only")) : ""))
          + seedGroup + skip
          + `<p class="pm-help muted">${esc(t("For a direction, click a straight edge, a flat face (its normal) or a reference axis in the tree."))}</p>`;
      } else if (f.type === "spattern") {
        title = f.src === "table" ? t("Table driven pattern") : t("Sketch driven pattern");
        if (f.src === "sketch") {
          const sk = sketches.find(x => x.id === f.sketch);
          const pts = sk ? freePoints(sk) : [];
          const u = { mm: 1 / UNITS[this.doc.units.length].f, label: this.doc.units.length };
          body = group(t("Selections"), box("psketch", t("Reference sketch"), sk ? featureLabel(sk.name) : t("None"))
            + `<label class="pm-field"><span>${esc(t("Reference point"))}</span><select data-k="refPt"><option value="">${esc(t("Centroid"))}</option>${pts.map(q => `<option value="${q.id}"${f.refPt === q.id ? " selected" : ""}>${esc(`(${trimNum(q.x / u.mm, 3)}, ${trimNum(q.y / u.mm, 3)})`)}</option>`).join("")}</select></label>`
            + `<p class="pm-count">${esc(t("{n} point|{n} points", { n: pts.length }))}</p>`
            + `<p class="pm-help muted">${esc(t("Pick a sketch in the Features tree: a copy goes to each of its points (not the ends of lines and arcs), moved from the seed's reference point."))}</p>`)
            + seedGroup;
        } else {
          const u = { mm: 1 / UNITS[this.doc.units.length].f, label: this.doc.units.length };
          const rows = (f.table ?? []).map(r => `${trimNum(r.x.v / u.mm, 6)}, ${trimNum(r.y.v / u.mm, 6)}`).join("\n");
          const csyss = this.doc.features.slice(0, m.index).filter(x => x.type === "csys");
          body = group(t("Coordinate system"), `<label class="pm-field"><span>${esc(t("Axes"))}</span><select data-k="csys"><option value="">${esc(t("Part origin"))}</option>${csyss.map(c => `<option value="${c.id}"${f.csys === c.id ? " selected" : ""} translate="no">${esc(featureLabel(c.name))}</option>`).join("")}</select></label>`)
            + group(t("Points"), `<label class="pm-field pm-col"><span>${esc(t("X, Y offsets ({u}), one row per copy", { u: u.label }))}</span><textarea data-k="tableText" rows="5" spellcheck="false">${esc(rows)}</textarea></label>`
              + `<p class="pm-help muted">${esc(t("Each row moves a copy of the seed by X and Y along the coordinate system's axes."))}</p>`)
            + seedGroup;
        }
      } else {
        title = t("Circular pattern");
        body = group(t("Parameters"), box("dir", t("Axis"), this.lineLabel(f.axis)) + numField("angle", t("Angle"), f.angle, "angle") + intField("count", t("Instances"), f.count)
          + chk("equal", f.equal, t("Equal spacing")) + chk("flip", f.flip, t("Reverse direction")))
          + group(t("Direction 2"), chk("cdir2", f.dir2, t("Direction 2"))
            + (f.dir2 ? chk("sym", f.sym, t("Symmetric"))
              + (f.sym ? "" : numField("angle2", t("Angle"), f.angle2 ?? f.angle, "angle") + intField("count2", t("Instances"), f.count2 ?? f.count) + chk("equal2", f.equal2 ?? f.equal, t("Equal spacing")))
              + `<p class="pm-help muted">${esc(t("Copies turned the other way about the same axis."))}</p>` : ""))
          + seedGroup + skip
          + `<p class="pm-help muted">${esc(t("For the axis, click a round edge or face, a straight edge, or a reference axis in the tree."))}</p>`;
      }
    }
    if (f.type === "sketch3d") ({ title, body } = this.sk3Panel(f, group));
    if (f.type === "helix" || f.type === "sweep" || f.type === "loft" || f.type === "rib" || f.type === "split" || f.type === "curve" || f.type === "sweepsurf") ({ title, body } = this.p3Panel(f, sketches, group, numField, chk));
    if (f.type === "sweep" || f.type === "loft" || f.type === "hole") body += this.scopeGroup(f, m.focus);
    if (isBodyOp(f)) ({ title, body } = this.bodyPanel(f, m.focus, group, numField, chk));
    if (isSheet(f)) ({ title, body } = smPanel(f, { esc, group, numField, chk, sketches, label: featureLabel, sheet: this.last?.sheet, unit, f: UNITS[unit].f }));
    if (isWeldFeature(f)) ({ title, body } = weldPanel(f, this.weldCtx(m.index), m.focus, group, numField, chk));
    if (f.type === "planesurf" || f.type === "extsurf" || f.type === "offsurf" || f.type === "knit" || f.type === "thicken" || f.type === "replaceface" || f.type === "revsurf" || f.type === "loftsurf" || f.type === "trimsurf" || f.type === "fillsurf" || f.type === "extendsurf" || f.type === "untrimsurf") ({ title, body } = this.surfPanel(f, sketches, group, numField, chk));
    if (f.type === "import") {
      const st = this.last?.statuses.find(x => x.id === f.id);
      title = t("Imported body");
      body = group(t("File"), `<p class="pm-count" translate="no">${esc(f.file)}</p>`)
        + group(t("Check and heal"), chk("heal", f.heal, t("Check and heal (sew gaps into solids)")) + (f.heal ? numField("tol", t("Tolerance"), f.tol ?? { v: 0.1 }, "length") : "")
          + (st?.code === "warning" && st.warning ? `<p class="pm-help" role="status" data-heal>${esc(statusText(st))}</p>` : "")
          + `<p class="pm-help muted">${esc(t("Healing sews faces whose edges are closer than the tolerance and closes the result into solids."))}</p>`);
    }
    if (f.type === "heal") {
      const st = this.last?.statuses.find(x => x.id === f.id);
      title = t("Check-Heal");
      body = group(t("Check and heal"), numField("tol", t("Tolerance"), f.tol, "length") + chk("unify", f.unify, t("Merge faces that lie on one surface"))
          + (st?.code === "warning" && st.warning ? `<p class="pm-help" role="status" data-heal>${esc(statusText(st))}</p>` : "")
          + `<p class="pm-help muted">${esc(t("Every body is checked: faces whose edges are closer than the tolerance are sewn, faulty faces fixed and closed shells made solid. The report compares before and after."))}</p>`);
    }
    if (f.type === "plane") {
      title = t("Plane");
      body = group(t("First reference"), `<button class="pm-box${m.focus !== "axis" ? " focus" : ""}" data-k="focus-base" translate="no">${esc(this.refLabel(f.base))}</button>`)
        + group(t("Placement"), `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-k="mode"><option value="offset"${f.mode === "offset" ? " selected" : ""}>${esc(t("Offset distance"))}</option><option value="angle"${f.mode === "angle" ? " selected" : ""}>${esc(t("At angle about an edge or axis"))}</option></select></label>`
          + (f.mode === "offset" ? numField("offset", t("Distance"), f.offset, "length")
            : this.aboutField(f, m.focus === "axis") + numField("angle", t("Angle"), f.angle ?? { v: Math.PI / 4 }, "angle"))
          + chk("flip", f.flip, t("Flip")))
        + `<p class="pm-help muted">${esc(m.focus === "axis" ? t("Click a straight edge of the model.") : t("Click a plane or a flat face in the view or the tree."))}</p>`;
    }
    // SolidWorks habit: ✓ and ✕ at the top of the panel, then the message box, then the groups.
    // A rebuild re-renders the panel; keep what is being typed (and the caret) instead of the stored value.
    const typing = new Map<string, { value: string; focus: boolean; a: number | null; b: number | null }>();
    pm.querySelectorAll<HTMLInputElement>("input[data-num], input[type=text][data-k], input[data-hp]").forEach(inp => {
      const key = inp.dataset.num ? `n:${inp.dataset.num}` : inp.dataset.hp ? `h:${inp.dataset.hp}` : `k:${inp.dataset.k}`;
      const focus = document.activeElement === inp;
      if (focus || inp.value !== inp.defaultValue) typing.set(key, { value: inp.value, focus, a: inp.selectionStart, b: inp.selectionEnd });
    });
    pm.innerHTML = `<div class="pm-head pm-top"><h3>${esc(title)}</h3><span class="pm-okc"><button class="pm-pin${this.pinned ? " on" : ""}" data-k="pin" aria-pressed="${this.pinned}" title="${esc(t("Keep visible: OK starts the same command again (Ctrl+Enter does it once)"))}" aria-label="${esc(t("Keep visible"))}">📌</button><button class="pm-ok" data-k="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button><button class="pm-cancel" data-k="cancel" title="${esc(t("Cancel (Esc)"))}" aria-label="${esc(t("Cancel (Esc)"))}">✕</button></span></div>`
      + err + `<p class="pm-help muted">${esc(m.isNew ? t("Set the values; the view shows the result. ✓ or Enter keeps it, ✕ or Esc cancels.") : t("Editing: ✓ or Enter applies the change, ✕ or Esc cancels."))}</p>`
      + name + body;
    typing.forEach((st, key) => {
      const inp = pm.querySelector<HTMLInputElement>(key.startsWith("n:") ? `input[data-num="${key.slice(2)}"]` : key.startsWith("h:") ? `input[data-hp="${key.slice(2)}"]` : `input[type=text][data-k="${key.slice(2)}"]`);
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
        if (!(v > 0) && !(key === "start" || key === "span.start" || key === "taper" || key === "twist" || ((key === "angle" || /^groups\.\d+\.angle$/.test(key)) && f.type === "member") || /^vpitch\.0\.h$/.test(key)) && !(key === "clearance" && f.type === "indent" && v === 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const n: Num = isPlain(inp.value) ? { v } : { v, expr: inp.value.trim() };
        // "thin.t" and "draft.angle" live one level down, "vpitch.0.h" two.
        const path = key.split("."), last = path.pop()!;
        const host = path.reduce<Record<string, unknown> | undefined>((o, p) => o?.[p] as Record<string, unknown> | undefined, f as unknown as Record<string, unknown>) as Record<string, Num | undefined> | undefined;
        const cur = host?.[last];
        if (cur && cur.v === n.v && cur.expr === n.expr) return;
        upd(() => {
          // Head sizes still at their automatic values (the size's ISO table, or the custom defaults) follow
          // a typed diameter: a Ø3.2 countersink kept the M6 head (Ø13.44) before.
          if (f.type === "hole" && key === "diameter" && cur && cur.v > 0) {
            const auto: HoleFeature = JSON.parse(JSON.stringify(f));
            if (f.size) applyHoleSize(auto);
            else {
              const d0 = cur.v;
              auto.cbDia = { v: Math.round(d0 * 17) / 10 }; auto.cbDepth = { v: d0 }; auto.csDia = { v: d0 * 2 }; auto.threadDepth = { v: d0 * 2 };
              auto.cdDia = { v: Math.round(d0 * 17) / 10 }; auto.cdDepth = { v: d0 }; auto.slotLen = { v: Math.round(d0 * 20) / 10 };
            }
            const k = n.v / cur.v;
            for (const h of ["cbDia", "cbDepth", "csDia", "threadDepth", "cdDia", "cdDepth", "slotLen"] as const) {
              const x = f[h], a = auto[h];
              if (x && a && !x.expr && Math.abs(x.v - a.v) < 1e-9) f[h] = { v: Math.round(x.v * k * 100) / 100 };
            }
          }
          (host as Record<string, Num>)[last] = n;
          // A typed size makes the hole custom (SolidWorks' "Show custom sizing").
          if (f.type === "hole" && key !== "depth" && key !== "threadDepth" && key !== "headClear" && key !== "drillAngle" && key !== "upToOffset" && !/^(near|under|far)Cs\./.test(key) && f.size) { delete f.size; delete f.fit; }
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
          const step = stepFor(q === "angle" ? "angle" : "length", units.current) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
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
        if (k === "about" && f.type === "plane") {
          upd(() => {
            const v = String(val);
            if (v === "edge") { delete f.about; if (!f.axis) m.focus = "axis"; }
            else { f.about = v.startsWith("axis:") ? { axis: v.slice(5) } : { std: v as "X" | "Y" | "Z" }; delete f.axis; m.focus = "base"; }
          }, true);
          return;
        }
        if (k === "mode" && f.type === "plane") { upd(() => { f.mode = val as "offset" | "angle"; if (f.mode === "angle") { f.angle ??= { v: Math.PI / 4 }; if (!f.axis && !f.about) m.focus = "axis"; } else m.focus = "base"; }, true); return; }
        if (k === "dkind" && f.type === "draft") { upd(() => { if (val === "parting") { f.kind = "parting"; f.parting ??= []; f.faces = []; } else { delete f.kind; delete f.parting; delete f.other; } m.focus = f.plane ? "faces" : "nplane"; }, true); return; }
        if (k === "endTan" && f.type === "sweep") { upd(() => { if (val === "path") f.endTangent = true; else delete f.endTangent; }, true); return; }
        if (k === "startTan" && f.type === "sweep") { upd(() => { if (val === "path") f.startTangent = true; else delete f.startTangent; }, true); return; }
        if (k === "ribDraft" && f.type === "rib") { upd(() => { if (val) f.draft = { v: Math.PI / 180 }; else { delete f.draft; delete f.draftOut; } }, true); return; }
        if ((k === "startC" || k === "endC") && f.type === "loft") { upd(() => { const key = k === "startC" ? "startNormal" : "endNormal"; if (val === "normal") f[key] = true; else delete f[key]; }, true); return; }
        if ((k === "startLen" || k === "endLen") && f.type === "loft") {
          const v = Number(String(val).replace(",", "."));
          if (!(v > 0 && v <= 10)) { toast(t("The tangent length must be between 0 and 10."), true); this.renderPanel(); return; }
          upd(() => { if (v === 1) delete f[k]; else f[k] = v; });
          return;
        }
        if (k === "mode" && f.type === "chamfer") { upd(() => { f.mode = val as NonNullable<ChamferFeature["mode"]>; if (f.mode === "two" || f.mode === "vertex") f.distance2 ??= { v: f.distance.v }; if (f.mode === "vertex") { f.distance3 ??= { v: f.distance.v }; f.vertices ??= []; } if (f.mode === "angle") f.angle ??= { v: Math.PI / 4 }; }, true); return; }
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
        if (f.type === "hole" && k === "threadEnd") { upd(() => { if (val === "through") f.threadEnd = "through"; else { delete f.threadEnd; f.threadDepth ??= { v: Math.round((f.major ?? f.diameter.v) * 20) / 10 }; } }, true); return; }
        if (f.type === "thread" && k === "size") { upd(() => this.applyThreadSize(f, String(val) || undefined), true); return; }
        if (f.type === "hole" && (k === "optHead" || k === "optNear" || k === "optUnder" || k === "optFar")) {
          upd(() => {
            // Defaults: 1 mm of head clearance; countersinks 1 mm wider than what they open, at 90°.
            const sink = (d: number): HoleSink => ({ dia: { v: Math.round((d + 1) * 100) / 100 }, angle: { v: Math.PI / 2 } });
            const topDia = f.kind === "cbore" ? f.cbDia?.v ?? f.diameter.v : f.kind === "cdrill" ? f.cdDia?.v ?? f.diameter.v : f.diameter.v;
            if (k === "optHead") { if (val) f.headClear = { v: 1 }; else delete f.headClear; }
            if (k === "optNear") { if (val) f.nearCs = sink(topDia); else delete f.nearCs; }
            if (k === "optUnder") { if (val) f.underCs = sink(f.diameter.v); else delete f.underCs; }
            if (k === "optFar") { if (val) f.farCs = sink(f.diameter.v); else delete f.farCs; }
          }, true);
          return;
        }
        if (f.type === "hole" && k === "standard") {
          upd(() => {
            if (val === "iso") delete f.standard; else f.standard = val as Exclude<HoleStandard, "iso">;
            // The size nearest the old one by diameter, as SolidWorks keeps a size when the standard changes.
            const list = HOLE_STANDARDS[val as HoleStandard] ?? HOLE_STANDARDS.iso, old = holeSize(f.size), d = old ? majorOf(old) : 6;
            f.size = list.reduce((b, h) => (Math.abs(majorOf(h) - d) < Math.abs(majorOf(b) - d) ? h : b)).size;
            applyHoleSize(f);
          }, true);
          return;
        }
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
              if (f.kind === "cdrill") { f.cdDia ??= { v: Math.round(f.diameter.v * 17) / 10 }; f.cdDepth ??= { v: f.diameter.v }; f.cdAngle ??= { v: (118 * Math.PI) / 180 }; }
            }
            if (f.kind === "slot") { f.slotLen ??= { v: Math.round(f.diameter.v * 20) / 10 }; f.slotAngle ??= { v: 0 }; } else { delete f.slotLen; delete f.slotAngle; }
            if (f.kind === "clear" && !f.size) { f.size = "M6"; applyHoleSize(f); }
          }, true);
          return;
        }
        if (k === "copyKind" && isCopy(f)) {
          upd(() => { if (val === "features") delete f.copy; else f.copy = val as "faces" | "bodies"; delete f.faces; delete f.bodies; delete (f as MirrorFeature).merge; f.features = []; m.focus = "seeds"; }, true);
          return;
        }
        if (k === "geometry" && isCopy(f)) { upd(() => { if (val) delete f.vary; else f.vary = true; }, true); return; }
        if (k === "merge" && f.type === "mirror") { upd(() => { if (val) f.merge = true; else delete f.merge; }, true); return; }
        if (f.type === "spattern" && (k === "refPt" || k === "csys")) { upd(() => { if (val) f[k] = String(val); else delete f[k]; }, true); return; }
        if (f.type === "spattern" && k === "tableText") {
          const u = { mm: 1 / UNITS[this.doc.units.length].f, label: this.doc.units.length };
          const rows = String(val).split(/\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[\s,;]+/).map(x => parseFloat(x)));
          if (rows.some(r => r.length < 2 || !r.slice(0, 2).every(Number.isFinite))) { el.setAttribute("aria-invalid", "true"); toast(t("Write one row per copy: X and Y, like 20, 0."), true); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { f.table = rows.map(r => ({ x: { v: r[0] * u.mm }, y: { v: r[1] * u.mm } })); }, true);
          return;
        }
        if (k === "skip" && (f.type === "lpattern" || f.type === "cpattern")) {
          const list = String(val).split(/[;\s]+/).map(x => x.trim()).filter(Boolean);
          const ok = list.every(x => (f.type === "lpattern" && f.dir2 ? /^\d+,\d+$/ : f.type === "cpattern" && f.dir2 ? /^-?\d+$/ : /^\d+$/).test(x));
          if (!ok) { el.setAttribute("aria-invalid", "true"); toast(t("Write instance numbers like 2; 3 (or 1,1; 2,0 with two directions)."), true); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { if (list.length) f.skip = list; else delete f.skip; });
          return;
        }
        if ((k === "total" || k === "total2") && f.type === "lpattern") {
          const two = k === "total2";
          upd(() => {
            if (val === "1") f[k] = true; else delete f[k];
            if (val !== "ref") { if (two) { delete f.upTo2; delete f.upToOffset2; } else { delete f.upTo; delete f.upToOffset; } if (m.focus === (two ? "pref2" : "pref")) m.focus = undefined; }
            else m.focus = two ? "pref2" : "pref";
          }, true);
          return;
        }
        if (k === "cdir2" && f.type === "cpattern") {
          upd(() => { if (val) { f.dir2 = true; f.sym = true; } else { delete f.dir2; delete f.sym; delete f.count2; delete f.angle2; delete f.equal2; if (f.skip) { f.skip = f.skip.filter(x => !x.startsWith("-")); if (!f.skip.length) delete f.skip; } } }, true);
          return;
        }
        if (k === "sym" && f.type === "cpattern") { upd(() => { if (val) { f.sym = true; delete f.count2; delete f.angle2; delete f.equal2; } else { delete f.sym; f.count2 = f.count; f.angle2 = { ...f.angle }; f.equal2 = f.equal; } }, true); return; }
        if (k === "equal2" && f.type === "cpattern") { upd(() => { f.equal2 = !!val; }, true); return; }
        if (k === "useDir2" && f.type === "lpattern") {
          upd(() => { if (val) { m.focus = "dir2"; f.spacing2 ??= { v: f.spacing.v }; f.count2 ??= 2; } else { delete f.dir2; delete f.spacing2; delete f.count2; delete f.flip2; if (m.focus === "dir2") m.focus = "dir"; } }, true);
          return;
        }
        if (f.type === "extrude" && (k === "draft2On" || k === "draft2Out")) {
          upd(() => {
            if (k === "draft2On") { if (val) f.draft2 = { angle: { v: (5 * Math.PI) / 180 } }; else f.draft2 = { angle: { v: 0 } }; }
            if (k === "draft2Out" && f.draft2) { if (val) f.draft2.outward = true; else delete f.draft2.outward; }
          }, true);
          return;
        }
        if (f.type === "extrude" && (k === "thinOn" || k === "thinMode" || k === "draftOn" || k === "draftOut")) {
          upd(() => {
            if (k === "thinOn") { if (val) f.thin = { t: { v: 2 }, mode: "inside" }; else delete f.thin; }
            if (k === "thinMode" && f.thin) f.thin.mode = val as "inside" | "outside" | "mid";
            if (k === "draftOn") { if (val) f.draft = { angle: { v: (5 * Math.PI) / 180 } }; else delete f.draft; }
            // Turning the draft on with Direction 2 on drafts each direction on its own (FR-FT-014).
            if (k === "draftOn" && val && hasDir2(f)) f.draft2 ??= { angle: { v: 0 } };
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
        if (f.type === "helix" && (k === "taperOn" || k === "mode" || k === "hsketch" || k === "vpitchOn")) {
          upd(() => {
            if (k === "vpitchOn") {
              if (!val) delete f.vpitch;
              else {
                // Start from the plain helix: its pitch at the bottom and top, the circle's diameter.
                const sk = sketches.find(s => s.id === f.sketch), c = sk?.ents.find(e => e.t === "circle") as { r: number } | undefined;
                const P = f.mode === "heightRev" ? f.height.v / f.revs.v : f.pitch.v, H = f.mode === "pitchRev" ? f.pitch.v * f.revs.v : f.height.v, d = 2 * (c?.r ?? 10);
                f.vpitch = [{ h: { v: 0 }, p: { v: P }, d: { v: d } }, { h: { v: H }, p: { v: P }, d: { v: d } }];
              }
            }
            if (k === "taperOn") { if (val) f.taper = { v: (5 * Math.PI) / 180 }; else delete f.taper; }
            if (k === "mode") f.mode = val as HelixFeature["mode"];
            if (k === "hsketch") f.sketch = String(val);
          }, true);
          return;
        }
        if (f.type === "sweep" && (k === "profileKind" || k === "swProfile" || k === "swPath" || k === "orient" || k === "swGuide" || k === "twistOn")) {
          upd(() => {
            if (k === "swGuide") { const p = pathOf(String(val)); if (p) { f.guide = p; delete f.twist; delete f.orient; } else delete f.guide; }
            if (k === "twistOn") { if (val) f.twist = { v: Math.PI / 2 }; else delete f.twist; }
            if (k === "orient" && val === "normal") delete f.twist;
            if (k === "profileKind") { if (val === "circular") { f.circular ??= { v: 2 }; delete f.profile; } else { delete f.circular; f.profile = sketches.find(s => sketchProfileOk(s))?.id; if (!f.profile) delete f.profile; } }
            if (k === "swProfile") { if (val) f.profile = String(val); else delete f.profile; }
            if (k === "swPath") { const p = pathOf(String(val)); if (p) f.path = p; else delete f.path; }
            if (k === "orient") { if (val === "normal") f.orient = "normal"; else delete f.orient; }
          }, true);
          return;
        }
        if (f.type === "sweepsurf" && (k === "swProfile" || k === "swPath" || k === "orient")) {
          upd(() => {
            if (k === "swProfile") f.profile = String(val);
            if (k === "swPath") { const p = pathOf(String(val)); if (p) f.path = p; else delete f.path; }
            if (k === "orient") { if (val === "normal") f.orient = "normal"; else delete f.orient; }
          }, true);
          return;
        }
        if (f.type === "revsurf" && k === "rsaxis") { upd(() => { f.axis = String(val); }, true); return; }
        if (f.type === "revsurf" && k === "sketch") {
          const sk = this.store!.feature(String(val)) as SketchFeature;
          const ls = sk.ents.filter(x => x.t === "line");
          upd(() => { f.sketch = String(val); f.axis = (ls.find(l => l.cons) ?? ls[0])?.id ?? ""; }, true);
          return;
        }
        if (f.type === "untrimsurf" && k === "untrimMode") { upd(() => { if (val === "holes") f.mode = "holes"; else delete f.mode; }, true); return; }
        if (f.type === "trimsurf" && k === "toolKind") { upd(() => { if (val === "surface") f.toolKind = "surface"; else delete f.toolKind; delete f.tool; m.focus = "ttool"; }, true); return; }
        if (f.type === "loftsurf" && /^lp\d+$/.test(k)) {
          upd(() => { const i = +k.slice(2); if (val) f.profiles[i] = String(val); else f.profiles.splice(i, 1); f.profiles = f.profiles.filter(Boolean); }, true);
          return;
        }
        if (f.type === "loft" && k === "lcPath") { upd(() => { const p = pathOf(String(val)); if (p) { f.centerline = p; delete f.ruled; delete f.close; delete f.guides; } else delete f.centerline; }, true); return; }
        if (f.type === "loft" && /^lg\d+$/.test(k)) {
          upd(() => {
            const i = +k.slice(2), gs = [...(f.guides ?? [])], p = pathOf(String(val));
            if (p) gs[i] = p; else gs.splice(i, 1);
            if (gs.length) { f.guides = gs.filter(Boolean); delete f.ruled; delete f.close; delete f.startNormal; delete f.endNormal; } else delete f.guides;
          }, true);
          return;
        }
        if (f.type === "loft" && /^lp\d+$/.test(k)) {
          upd(() => {
            const i = +k.slice(2);
            if (val) { f.profiles[i] = String(val); if (f.connectors) f.connectors[i] = ""; } else { f.profiles.splice(i, 1); f.connectors?.splice(i, 1); }
            f.profiles = f.profiles.filter(Boolean);
            if (f.connectors && !f.connectors.some(Boolean)) delete f.connectors;
          }, true);
          return;
        }
        if (f.type === "loft" && /^lc\d+$/.test(k)) {
          upd(() => {
            const cs = f.profiles.map((_, i) => f.connectors?.[i] ?? "");
            cs[+k.slice(2)] = String(val);
            if (cs.some(Boolean)) f.connectors = cs; else delete f.connectors;
          }, true);
          return;
        }
        if (k === "dfmode" && f.type === "delface") { upd(() => { if (val === "delete") f.mode = "delete"; else delete f.mode; }, true); return; }
        if (k === "mvmode" && f.type === "moveface") {
          upd(() => {
            if (val === "offset") delete f.mode; else f.mode = val as "translate" | "rotate";
            if (val === "translate") { f.dx ??= { v: 0 }; f.dy ??= { v: 0 }; f.dz ??= { v: f.distance.v } }
            if (val === "rotate") { f.angle ??= { v: Math.PI / 18 }; m.focus = f.axis ? "faces" : "axis"; } else m.focus = "faces";
          }, true);
          return;
        }
        if (isWeldFeature(f)) { const fn = weldChange(f, k, val, this.weldCtx(m.index)); if (fn) { upd(fn, true); return; } }
        if (k === "merge") { upd(() => { if (val) delete (f as ExtrudeFeature).merge; else (f as ExtrudeFeature).merge = false; }); return; }
        if (k === "scopeAll" && isScoped(f)) {
          upd(() => { if (val) { delete f.scope; if (m.focus === "scope") m.focus = undefined; } else { f.scope = []; m.focus = "scope"; } }, true);
          return;
        }
        if (k === "dir2") {
          upd(() => {
            const x = f as ExtrudeFeature;
            if (val) { x.depth2 = { v: x.depth.v }; if (x.end !== "blind") x.end2 = "blind"; x.draft2 = { angle: { v: 0 } }; }
            else { delete x.depth2; clearDir2(x); }
          }, true);
          return;
        }
        if (k === "end2" && f.type === "extrude") {
          upd(() => {
            const e2 = String(val) as Dir2End;
            if (e2 === "blind" && f.end === "blind") delete f.end2; else f.end2 = e2;
            if (e2 !== "upto" && e2 !== "offset") delete f.upTo2;
            if (e2 !== "vertex") delete f.upToVertex2;
            if (e2 !== "body") delete f.upToBody2;
            if (e2 === "offset") f.upToOffset2 ??= { v: 5 }; else { delete f.upToOffset2; delete f.reverseOffset2; }
            if (e2 !== "blind") delete f.draft;
            if (e2 === "upto" || e2 === "offset" || e2 === "vertex") m.focus = "upto2";
            if (e2 === "body") m.focus = "upbody2";
          }, true);
          return;
        }
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
          if (k === "end" && (val === "upto" || val === "offset" || val === "vertex")) m.focus = f.type === "hole" ? "hupto" : "upto";
          if (k === "end" && val !== "body") delete g.upToBody;
          if (k === "end" && val === "body") m.focus = "upbody";
          if (k === "end" && val === "offset") g.upToOffset ??= { v: 5 };
          if (k === "end" && val !== "offset") { delete g.upToOffset; delete g.reverseOffset; }
          if (k === "end" && val !== "blind" && val !== "mid") delete g.draft;
          // Direction 2 stays on when Direction 1 leaves blind: it keeps its own (blind) end condition.
          if (k === "end" && f.type === "extrude" && f.depth2 && f.depth2.v > 0 && val !== "blind") f.end2 ??= "blind";
          if (k === "end" && f.type === "extrude" && (val === "mid" || val === "through2")) { delete f.depth2; clearDir2(f); }
          if (k === "op" && val !== "cut" && g.end === "through2") g.end = "through";
        }, k === "end" || k === "op" || k === "sketch" || k === "modelled" || k === "axes" || (k === "cut" && f.type === "indent"));
      });
    });
    if (isSheet(f)) bindSmPanel(pm, f, upd, () => this.exportFlatDxf(), msg => toast(msg, true), UNITS[units.current].f, this.last?.sheet?.T ?? 1);
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
    pm.querySelector("[data-k=clearParting]")?.addEventListener("click", () => { if (f.type === "draft") { f.parting = []; this.draftChanged(); } });
    pm.querySelector("[data-k=sbfocus]")?.addEventListener("click", () => { if (m.kind === "feature") { m.focus = m.focus === "sbv" ? undefined : "sbv"; this.renderPanel(); this.drawDecor(); } });
    pm.querySelectorAll<HTMLElement>("[data-rmsb]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "fillet" || !f.setbacks) return;
      f.setbacks.splice(+b.dataset.rmsb!, 1);
      if (!f.setbacks.length) delete f.setbacks;
      this.drawDecor(); this.renderPanel(); void this.rebuild();
    }));
    pm.querySelectorAll<HTMLInputElement>("input[data-sb]").forEach(inp => {
      const apply = () => {
        if (f.type !== "fillet" || !f.setbacks) return;
        let v: number;
        try { v = evaluate(inp.value, "length", unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const s = f.setbacks[+inp.dataset.sb!];
        if (!s || s.d === v) return;
        s.d = v;
        void this.rebuild();
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLElement>("[data-rmv]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "chamfer" || !f.vertices) return;
      f.vertices.splice(+b.dataset.rmv!, 1);
      this.drawDecor(); this.renderPanel(); void this.rebuild();
    }));
    pm.querySelectorAll<HTMLElement>("[data-rmt]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "shell" || !f.multi) return;
      f.multi.splice(+b.dataset.rmt!, 1);
      if (!f.multi.length) delete f.multi;
      this.draftChanged();
    }));
    pm.querySelectorAll<HTMLInputElement>("input[data-mt]").forEach(inp => {
      const apply = () => {
        if (f.type !== "shell" || !f.multi) return;
        let v: number;
        try { v = evaluate(inp.value, "length", unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        inp.removeAttribute("aria-invalid");
        const e = f.multi[+inp.dataset.mt!];
        if (!e || e.t === v) return;
        e.t = v; this.multiT = v;
        void this.rebuild();
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLElement>("[data-rm]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "fillet" && f.type !== "chamfer") return;
      f.edges.splice(+b.dataset.rm!, 1);
      this.drawDecor(); this.renderPanel(); void this.rebuild();
    }));
    if (isWeldFeature(f)) bindWeldPanel(pm, f, this.weldCtx(m.index));
    pm.querySelector<HTMLInputElement>("[data-ui=tangent]")?.addEventListener("change", e => { this.tangentProp = (e.target as HTMLInputElement).checked; });
    pm.querySelector("[data-k=clearContours]")?.addEventListener("click", () => { if (hasContours(f)) { delete f.contours; this.draftChanged(); } });
    pm.querySelector("[data-k=clear]")?.addEventListener("click", () => { if (f.type === "fillet" || f.type === "chamfer") { f.edges = []; this.drawDecor(); this.renderPanel(); void this.rebuild(); } });
    pm.querySelector("[data-k=focus-base]")?.addEventListener("click", () => { if (m.kind === "feature") { m.focus = "base"; this.renderPanel(); this.drawDecor(); } });
    pm.querySelector("[data-k=focus-axis]")?.addEventListener("click", () => { if (m.kind === "feature") { m.focus = "axis"; this.renderPanel(); this.drawDecor(); } });
    pm.querySelectorAll<HTMLElement>("[data-focus]").forEach(b => b.addEventListener("click", () => { if (m.kind === "feature") { m.focus = b.dataset.focus as Focus; this.renderPanel(); this.drawDecor(); } }));
    // Hole favourites (FR-FT-056): a saved definition (type, size, diameters, end) applied in one go; kept in this browser.
    if (f.type === "hole") {
      const tabs = pm.querySelector<HTMLElement>(".pm-htabs");
      if (tabs) bindTabs(tabs, k => {
        this.holeTab = k === "pos" ? "pos" : "type";
        pm.querySelectorAll<HTMLElement>("[data-hpane]").forEach(p => { p.hidden = p.dataset.hpane !== this.holeTab; });
      });
      pm.querySelectorAll<HTMLButtonElement>("[data-hkind]").forEach(b => b.addEventListener("click", () => {
        const s = pm.querySelector<HTMLSelectElement>("select[data-k=kind]");
        if (!s || s.value === b.dataset.hkind) return;
        s.value = b.dataset.hkind!;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }));
      pm.querySelector<HTMLDetailsElement>("[data-ui=favs]")?.addEventListener("toggle", e => { try { localStorage.setItem("mc:holeFavOpen", (e.target as HTMLDetailsElement).open ? "1" : "0"); } catch { /* private window */ } });
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
    if (f.type === "curve") this.bindCurvePanel(pm, f, unit, upd);
    if (f.type === "helix") {
      pm.querySelector<HTMLButtonElement>("[data-vpadd]")?.addEventListener("click", () => upd(() => {
        const rows = f.vpitch!, a = rows[rows.length - 1], b = rows[rows.length - 2];
        rows.push({ h: { v: a.h.v + (a.h.v - b.h.v || 10) }, p: { v: a.p.v }, d: { v: a.d.v } });
      }, true));
      pm.querySelectorAll<HTMLButtonElement>("[data-vpdel]").forEach(b => b.addEventListener("click", () => upd(() => {
        f.vpitch!.splice(+b.dataset.vpdel!, 1);
        f.vpitch![0].h = { v: 0 };
      }, true)));
    }
    if (f.type === "sketch3d") this.bindSk3Panel(pm, f, unit);
    pm.querySelector("[data-k=clearSets]")?.addEventListener("click", () => { if (f.type === "fillet") { f.faces1 = []; f.faces2 = []; if (f.kind === "full") f.center = []; if (m.kind === "feature") m.focus = "fs1"; this.draftChanged(); } });
    pm.querySelector("[data-k=clearPts]")?.addEventListener("click", () => { if (f.type === "hole") { f.pts = []; this.draftChanged(); } });
    // Hole positions typed as X/Y in the face's sketch axes (FR-FT-052): a clicked position can be made exact.
    pm.querySelector("[data-k=addPt]")?.addEventListener("click", () => {
      if (f.type !== "hole") return;
      const last = f.pts.at(-1);
      f.pts.push(last ? [last[0] + Math.max(f.diameter.v * 2, 5), last[1]] : [0, 0]);
      this.draftChanged();
      setTimeout(() => { const inp = $("#mc-pm").querySelector<HTMLInputElement>(`input[data-hp="${f.pts.length - 1}:0"]`); inp?.focus(); inp?.select(); }, 0);
    });
    pm.querySelectorAll<HTMLElement>("[data-rmh]").forEach(b => b.addEventListener("click", () => {
      if (f.type !== "hole") return;
      f.pts.splice(+b.dataset.rmh!, 1);
      this.draftChanged();
    }));
    pm.querySelectorAll<HTMLInputElement>("input[data-hp]").forEach(inp => {
      const apply = () => {
        if (f.type !== "hole") return;
        const [i, j] = inp.dataset.hp!.split(":").map(Number);
        let v: number;
        try { v = evaluate(inp.value, "length", unit, evalVars(this.doc, unit).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        inp.removeAttribute("aria-invalid");
        const p = f.pts[i];
        if (!p) return;
        const ha = holeAxes(this.last?.frames[f.id]), shown = ha.show(p);
        if (shown[j] === v) return;
        shown[j] = v;
        f.pts[i] = ha.store(shown);
        this.draftChanged();
      };
      inp.addEventListener("change", apply);
      // Enter applies and goes on to the next coordinate (X, Y, then the next hole), so a table of holes is typed in one go.
      inp.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        e.preventDefault(); e.stopPropagation();
        const [i, j] = inp.dataset.hp!.split(":").map(Number);
        const next = j === 0 ? `${i}:1` : `${i + 1}:0`;
        apply();
        setTimeout(() => { const n = $("#mc-pm").querySelector<HTMLInputElement>(`input[data-hp="${next}"]`); n?.focus(); n?.select(); }, 0);
      });
    });
    pm.querySelector("[data-k=clearSurfaces]")?.addEventListener("click", () => { if (f.type === "knit") { f.surfaces = []; this.draftChanged(); } });
    pm.querySelector("[data-k=clearCopy]")?.addEventListener("click", () => { if (isCopy(f)) { if (f.copy === "faces") f.faces = []; else f.bodies = []; this.draftChanged(); } });
    pm.querySelector("[data-k=clearFaces]")?.addEventListener("click", () => { if (f.type === "shell" || f.type === "draft" || f.type === "split" || f.type === "delface" || f.type === "moveface" || f.type === "offsurf" || f.type === "replaceface") { f.faces = []; this.draftChanged(); }
      if (isBodyOp(f)) { if (f.type === "combine" || f.type === "indent") f.tools = []; else f.bodies = []; if (f.type === "intersect") f.exclude = []; this.draftChanged(); } });
    if (f.type === "intersect") {
      pm.querySelector<HTMLButtonElement>('[data-k="keepAll"]')?.addEventListener("click", () => upd(() => { f.exclude = []; }, true));
      pm.querySelectorAll<HTMLInputElement>("input[data-rgn]").forEach(inp => inp.addEventListener("change", () => {
        const r = this.last?.regions?.[f.id]?.[+inp.dataset.rgn!];
        if (!r) return;
        upd(() => {
          if (inp.checked) f.exclude = f.exclude.filter((_, i) => !(r.ex ?? []).includes(i));
          else f.exclude.push(r.c);
        }, true);
      }));
    }
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
    pm.querySelector("[data-k=pin]")?.addEventListener("click", e => {
      this.pinned = !this.pinned;
      try { localStorage.setItem("mc:pin", this.pinned ? "1" : "0"); } catch { /* storage blocked: this page only */ }
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle("on", this.pinned);
      b.setAttribute("aria-pressed", String(this.pinned));
    });
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
      + `<fieldset class="pm-group"><legend>${esc(t("Configurations"))}</legend><div class="cfg-list">${rows}</div><button class="btn small" data-a="add">${esc(t("Add configuration"))}</button></fieldset>`
      + `<fieldset class="pm-group"><legend>${esc(t("Configuration table"))}</legend><p class="pm-help muted">${esc(t("One row per configuration and one column per value, as CSV: lengths in mm, angles in degrees, S or U to suppress, expressions allowed. Rows with a new name add configurations."))}</p>`
      + `<div class="cfg-tbl"><button class="btn small" data-a="cfgcsv">${esc(t("Export table"))}</button><button class="btn small" data-a="cfgin">${esc(t("Import table…"))}</button></div></fieldset>`;
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
    pm.querySelector("[data-a=cfgcsv]")!.addEventListener("click", () => download(new Blob([configTable(this.doc)], { type: "text/csv" }), `${this.doc.name || "part"}-configurations.csv`));
    pm.querySelector("[data-a=cfgin]")!.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".csv,.txt,text/csv";
      inp.onchange = async () => { const f = inp.files?.[0]; if (f) this.importConfigTable(await f.text()); };
      inp.click();
    });
    pm.querySelector("[data-a=add]")!.addEventListener("click", () => {
      const name = nextConfigName(d);
      this.store!.change(`Add configuration ${name}`, dd => addConfig(dd, name));
      this.renderAll();
      pm.querySelector<HTMLInputElement>(".cfg-row.on [data-c=name]")?.select();
    });
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
  }

  /** Section at the sketch plane (FR-SK-006): on while sketching; it stays on for the next sketch until turned off. */
  skSection = false;
  private skSectionKey = "";
  private syncSketchSection() {
    const m = this.mode;
    const f = m.kind === "sketch" && this.skSection ? m.editor.frame : null;
    const key = f ? JSON.stringify([f.o, f.n]) : "";
    if (key === this.skSectionKey) return;
    this.skSectionKey = key;
    this.host.sketchSection?.(f ? { o: [...f.o] as V3, n: [...f.n] as V3 } : null);
  }

  /** Configuration table (FR-CFG-003): one undo step; the active configuration's row rebuilds the part. */
  importConfigTable(text: string) {
    let res: ReturnType<typeof applyConfigTable> | null = null;
    try { this.store!.change("Import configuration table", dd => { res = applyConfigTable(dd, text); }); }
    catch (e) { toast(t((e as Error).message), true); return null; }
    const r = res as ReturnType<typeof applyConfigTable> | null;
    if (!r) return null;
    toast(t("Configuration table: {n} updated, {m} added.", { n: r.changed.length, m: r.added.length }) + (r.unknown.length ? " " + t("Columns not found: {cols}", { cols: r.unknown.join(", ") }) : ""), !!r.unknown.length);
    this.renderAll();
    void this.rebuild();
    return r;
  }

  /** Part properties, material and colour (FR-DOC-007, FR-MAT-001/003). */
  private renderPropsPanel(pm: HTMLElement, d: PartDoc) {
    const text = (k: string, label: string, v: string | undefined) => `<label class="pm-field"><span>${esc(label)}</span><input type="text" data-p="${k}" value="${esc(v ?? "")}" spellcheck="false" translate="no" /></label>`;
    const col = d.color ?? DEFAULT_COLOR;
    const hex = `#${col.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
    pm.innerHTML = okHead(t("Part properties"))
      + text("name", t("Name"), d.name) + text("title", t("Title"), d.props.title) + text("partNumber", t("Part number"), d.props.partNumber)
      + text("description", t("Description"), d.props.description) + text("revision", t("Revision"), d.props.revision) + text("author", t("Author"), d.props.author)
      + `<div class="pm-field"><span>${esc(t("Material"))}</span><button type="button" class="btn small pm-mat" data-a="matpick" title="${esc(t("Choose a material from the library"))}"><span translate="no">${esc(d.material ? t(d.material.name) : t("Not specified"))}</span> …</button></div>`
      + (d.material ? `<label class="pm-field"><span>${esc(t("Density"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="density" value="${d.material.density}" /><span class="muted">g/cm³</span></span></label>` : "")
      + `<label class="pm-field"><span>${esc(t("Colour"))}</span><input type="color" data-p="color" value="${hex}" /></label>`
      + `<fieldset class="pm-group"><legend>${esc(t("Mass properties"))}</legend><label class="chk pm-chk"><input type="checkbox" data-p="ovr"${d.massOverride ? " checked" : ""} />${esc(t("Override mass properties"))}</label>`
      + (d.massOverride ? `<label class="pm-field"><span>${esc(t("Mass"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="ovrMass" value="${d.massOverride.mass ?? ""}" placeholder="${esc(t("calculated"))}" /><span class="muted">kg</span></span></label>`
        + (["x", "y", "z"] as const).map((a, i) => `<label class="pm-field"><span>${esc(t("Centre of mass"))} ${a.toUpperCase()}</span><span class="pm-in"><input type="text" inputmode="decimal" data-p="ovrCom" data-i="${i}" value="${d.massOverride!.com ? trimNum(d.massOverride!.com[i], 6) : ""}" placeholder="${esc(t("calculated"))}" /><span class="muted">mm</span></span></label>`).join("")
        + `<p class="pm-help muted">${esc(t("For purchased parts: the entered values replace the calculated ones in Mass properties. Leave the centre of mass empty to keep it calculated."))}</p>` : "")
      + `</fieldset>`;
    pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-p]").forEach(el => el.addEventListener("change", () => {
      const k = el.dataset.p!, v = el.value;
      if (k === "name") { if (v.trim()) d.name = v.trim(); }
      else if (k === "density") {
        const x = parseFloat(v.replace(",", "."));
        if (!(x > 0)) { el.setAttribute("aria-invalid", "true"); toast(t("Density must be a number greater than 0 g/cm³."), true); return; }
        el.removeAttribute("aria-invalid");
        d.material = { ...(d.material ?? { name: "Custom" }), density: x };
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
    pm.querySelector("[data-a=matpick]")!.addEventListener("click", () => void pickMaterial({ current: d.material, allowNone: true, colour: true }).then(r => {
      if (!r || this.mode.kind !== "props" || this.mode.draft !== d) return;
      if (r.material) d.material = toRef(r.material); else delete d.material;
      if (r.colour && r.material?.color) { d.color = hexRgb(r.material.color); void this.rebuild(); }
      this.renderPanel();
      pm.querySelector<HTMLElement>("[data-a=matpick]")?.focus();
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
    pm.innerHTML = okHead(featureLabel(sk.name), { ok: t("Exit sketch (Enter)"), noTranslate: true })
      + `<p class="pm-help muted">${esc(t("Plane"))}: ${esc(plane)} · <b class="pm-def" data-state="${info.status !== "ok" ? "over" : info.dof === 0 ? "full" : "under"}">${esc(def)}</b>${info.status === "ok" && info.dof > 0 ? ` <button class="btn small" data-a="fulldef" title="${esc(t("Add horizontal/vertical relations and dimensions from the origin until nothing is free"))}">${esc(t("Fully define sketch"))}</button>` : ""}</p>`
      + `<p class="pm-help muted">${esc(t("Draw with the tools above. Blue is free to move, black is fixed by dimensions and relations. Double-click a dimension to change it."))}</p>`
      + `<label class="chk pm-chk" title="${esc(t("Points snap to model vertices, edge midpoints and circle centres, and stay attached to them; Smart Dimension takes model edges."))}"><input type="checkbox" data-a="modelsnap"${ed.modelSnap ? " checked" : ""} />${esc(t("Snap to model geometry"))}</label>`
      + `<label class="chk pm-chk" title="${esc(t("Lines snap horizontal, vertical, perpendicular, parallel or tangent and keep that relation; hold Ctrl to draw without them."))}"><input type="checkbox" data-a="autorels"${ed.autoRels ? " checked" : ""} />${esc(t("Automatic relations"))}</label>`
      + `<label class="chk pm-chk" title="${esc(t("Relation glyphs next to the entities; hover one to see what it ties, click to select it."))}"><input type="checkbox" data-a="showrels"${ed.showRels ? " checked" : ""} />${esc(t("Show relations"))}</label>`
      + `<details class="pm-snaps"><summary>${esc(t("Snaps"))}</summary><div class="pm-snapgrid">${SNAP_KINDS.map(([k, label]) => `<label class="chk pm-chk"><input type="checkbox" data-snap="${k}"${ed.snaps.has(k) ? " checked" : ""} />${esc(t(label))}</label>`).join("")}</div></details>`
      + `<details class="pm-snaps pm-grid"${ed.grid || ed.gridSnap ? " open" : ""}><summary>${esc(t("Grid"))}</summary><div class="pm-snapgrid">`
        + `<label class="chk pm-chk"><input type="checkbox" data-a="grid"${ed.grid ? " checked" : ""} />${esc(t("Show grid"))}</label>`
        + `<label class="chk pm-chk" title="${esc(t("Points that snap to nothing else go to the nearest grid point; hold Ctrl to place freely."))}"><input type="checkbox" data-a="gridsnap"${ed.gridSnap ? " checked" : ""} />${esc(t("Snap to grid"))}</label>`
        + `<label class="pm-field">${esc(t("Grid spacing"))} <input type="number" min="0" step="any" data-a="gridstep" value="${ed.gridSpacing || ""}" placeholder="${esc(t("Automatic"))}" title="${esc(t("Millimetres between grid lines; empty follows the zoom."))}" /></label>`
        + `</div></details>`
      + `<div class="pm-sec"><h4>${esc(t("Selected"))}: ${nSel}</h4>`
      + (nSel ? `<div class="pm-rels">${rels.map(r => `<button class="btn small" data-rel="${r}">${esc(t(REL_NAME[r]))}</button>`).join("")}</div>`
        + `<div class="pm-rels"><button class="btn small" data-a="cons">${esc(t("Construction"))}</button>${ed.canMerge() ? `<button class="btn small" data-a="merge" title="${esc(t("Merge the two points into one"))}">${esc(t("Merge points"))}</button>` : ""}<button class="btn small danger" data-a="del">${esc(t("Delete"))}</button></div>`
        : `<p class="muted">${esc(t("Select sketch items or model edges to add relations (Ctrl+click for more)."))}</p>`)
      + (ed.piercing ? `<p class="muted pm-pierce" role="status">${esc(t("Click a model edge that crosses the sketch plane: the point moves to where it pierces the plane."))}</p>` : "")
      + `</div>`
      + this.textBox(ed)
      + this.curveBox(ed)
      + (["line", "cline", "mline", "tarc", "rect", "crect", "rect3", "crect3", "pgram", "circle", "circle3", "pcircle", "arc", "arc3", "polygon"].includes(ed.tool) ? `<label class="chk pm-chk" title="${esc(t("New lines, rectangles, circles and arcs get their sizes as dimensions and the Modify box opens on each."))}"><input type="checkbox" data-a="adddims"${ed.addDims ? " checked" : ""} />${esc(t("Add dimensions"))}</label>` : "")
      + (["slot", "cslot", "aslot", "aslot3"].includes(ed.tool) ? `<label class="chk pm-chk" title="${esc(t("Slots get width and length (or radius) dimensions, and the Modify box opens on them."))}"><input type="checkbox" data-a="slotdims"${ed.slotDims ? " checked" : ""} />${esc(t("Add dimensions"))}</label>` : "")
      + (ed.tool === "polygon" ? `<label class="pm-field"><span>${esc(t("Sides"))}</span><input type="text" inputmode="numeric" class="pm-n" data-a="sides" value="${ed.polySides}" /></label>` : "")
      + (ed.tool === "fillet" ? `<label class="pm-field"><span>${esc(t("Radius"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="fr" value="${trimNum(ed.filletRadius * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>` : "")
      + (ed.tool === "segment" ? `<label class="pm-field"><span>${esc(t("Number of pieces"))}</span><input type="text" inputmode="numeric" class="pm-n" data-a="segn" value="${ed.segCount}" /></label>`
        + `<label class="pm-field"><span>${esc(t("Mark with"))}</span><select data-a="segmode">${(["points", "segments"] as const).map(k => `<option value="${k}"${ed.segMode === k ? " selected" : ""}>${esc(t(k === "points" ? "Sketch points" : "Sketch segments"))}</option>`).join("")}</select></label>` : "")
      + (ed.tool === "chamfer" ? `<label class="pm-field"><span>${esc(t("Distance"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="cd" value="${trimNum(ed.chamferDist * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>` : "")
      + (ed.tool === "offset" ? `<label class="pm-field"><span>${esc(t("Distance"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-a="od" value="${trimNum(ed.offsetDist * UNITS[units.current].f, 4)}" /><span class="muted">${units.current}</span></span></label>`
        + `<label class="chk pm-chk"><input type="checkbox" data-a="oboth"${ed.offsetBoth ? " checked" : ""} />${esc(t("Both sides"))}</label>`
        + (ed.offsetBoth ? `<label class="pm-field"><span>${esc(t("Cap ends"))}</span><select data-a="ocap">${(["none", "arc", "line"] as const).map(k => `<option value="${k}"${ed.offsetCap === k ? " selected" : ""}>${esc(t(k === "none" ? "None" : k === "arc" ? "Arcs" : "Lines"))}</option>`).join("")}</select></label>` : "")
        + `<label class="chk pm-chk"><input type="checkbox" data-a="olink"${ed.offsetLink ? " checked" : ""} />${esc(t("Follow the source (offset relations)"))}</label>` : "")
      + this.danglingBox(ed)
      + this.dimNameBox(ed)
      + this.assistant(ed)
      + this.checkBox(ed)
      + `<div class="pm-sec"><h4>${esc(t("Relations"))}</h4>${this.relationList(ed)}</div>`
      + `<div class="pm-sec"><h4>${esc(t("Dimensions"))}</h4>${sk.dims.length ? `<label class="chk pm-chk"><input type="checkbox" data-a="shownames"${ed.showNames ? " checked" : ""} />${esc(t("Show dimension names"))}</label><ul class="pm-dims">${sk.dims.map(d => `<li><button class="link" data-dim="${d.id}" translate="no" title="${esc(`${d.name}@${sk.name}`)}">${esc(d.name)}</button> <span class="muted">${esc(d.val.expr ?? (d.t === "angle" ? `${trimNum((d.val.v * 180) / Math.PI, 3)}°` : `${trimNum(d.val.v * UNITS[units.current].f, 4)} ${units.current}`))}${d.driven ? ` (${esc(t("reference"))})` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">${esc(t("None yet: use Dimension (D)."))}</p>`}</div>`;
    pm.querySelectorAll<HTMLElement>("[data-rel]").forEach(b => b.addEventListener("click", () => { ed.addRelation(b.dataset.rel as never); this.renderPanel(); }));
    pm.querySelector("[data-a=cons]")?.addEventListener("click", () => ed.toggleConstruction());
    pm.querySelector("[data-a=merge]")?.addEventListener("click", () => { ed.mergePoints(); this.renderPanel(); });
    pm.querySelector("[data-a=fulldef]")?.addEventListener("click", () => { ed.fullyDefineUi(); this.renderPanel(); });
    pm.querySelector("[data-a=del]")?.addEventListener("click", () => { ed.deleteSelection(); this.renderPanel(); });
    pm.querySelectorAll<HTMLElement>("[data-dim]").forEach(b => b.addEventListener("click", () => ed.editDim(b.dataset.dim!)));
    pm.querySelectorAll<HTMLElement>("[data-delrel]").forEach(b => b.addEventListener("click", () => { ed.deleteItems([b.dataset.delrel!]); this.renderPanel(); }));
    pm.querySelectorAll<HTMLElement>("[data-selrel]").forEach(b => b.addEventListener("click", () => { ed.select([b.dataset.selrel!]); this.renderPanel(); }));
    pm.querySelectorAll<HTMLElement>("[data-reattach]").forEach(b => b.addEventListener("click", () => { ed.select([b.dataset.reattach!]); ed.startReattach(b.dataset.reattach!); this.renderBar(); this.renderPanel(); }));
    pm.querySelector("[data-a=deldangling]")?.addEventListener("click", () => { ed.deleteItems(ed.danglingRels().map(r => r.id)); this.renderPanel(); });
    pm.querySelector<HTMLInputElement>("[data-a=shownames]")?.addEventListener("change", e => { ed.showNames = (e.target as HTMLInputElement).checked; ed.render(); });
    pm.querySelector<HTMLInputElement>("[data-a=slotdims]")?.addEventListener("change", e => { ed.slotDims = (e.target as HTMLInputElement).checked; try { localStorage.setItem("mc:slotDims", ed.slotDims ? "1" : "0"); } catch { /* private mode */ } });
    pm.querySelector<HTMLInputElement>("[data-a=adddims]")?.addEventListener("change", e => { ed.addDims = (e.target as HTMLInputElement).checked; try { localStorage.setItem("mc:skAddDims", ed.addDims ? "1" : "0"); } catch { /* private mode */ } this.renderQuick(); });
    pm.querySelector<HTMLInputElement>("[data-a=autorels]")?.addEventListener("change", e => { ed.autoRels = (e.target as HTMLInputElement).checked; try { localStorage.setItem("mc:autoRels", ed.autoRels ? "1" : "0"); } catch { /* private mode */ } this.renderQuick(); });
    pm.querySelector<HTMLInputElement>("[data-a=showrels]")?.addEventListener("change", e => { ed.showRels = (e.target as HTMLInputElement).checked; try { localStorage.setItem("mc:skRels", ed.showRels ? "1" : "0"); } catch { /* private mode */ } ed.render(); });
    const saveGrid = () => { try { localStorage.setItem("mc:skGrid", ed.grid ? "1" : "0"); localStorage.setItem("mc:skGridSnap", ed.gridSnap ? "1" : "0"); localStorage.setItem("mc:skGridStep", String(ed.gridSpacing || "")); } catch { /* private mode */ } };
    pm.querySelector<HTMLInputElement>("[data-a=grid]")?.addEventListener("change", e => { ed.setGrid({ show: (e.target as HTMLInputElement).checked }); saveGrid(); this.renderQuick(); });
    pm.querySelector<HTMLInputElement>("[data-a=gridsnap]")?.addEventListener("change", e => { ed.setGrid({ snap: (e.target as HTMLInputElement).checked }); saveGrid(); this.renderQuick(); });
    pm.querySelector<HTMLInputElement>("[data-a=gridstep]")?.addEventListener("change", e => { const v = Number((e.target as HTMLInputElement).value); ed.setGrid({ spacing: isFinite(v) && v > 0 ? v : 0 }); saveGrid(); });
    pm.querySelectorAll<HTMLInputElement>("[data-snap]").forEach(i => i.addEventListener("change", () => {
      const k = i.dataset.snap as SnapKind;
      if (i.checked) ed.snaps.add(k); else ed.snaps.delete(k);
      try { localStorage.setItem("mc:skSnaps", JSON.stringify([...ed.snaps])); } catch { /* private mode */ }
    }));
    pm.querySelector<HTMLInputElement>("[data-a=modelsnap]")?.addEventListener("change", e => { ed.modelSnap = (e.target as HTMLInputElement).checked; try { localStorage.setItem("mc:modelSnap", ed.modelSnap ? "1" : "0"); } catch { /* private mode */ } });
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
    this.bindTextBox(pm, ed);
    this.bindCurveBox(pm, ed);
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
    pm.querySelector<HTMLInputElement>("[data-a=segn]")?.addEventListener("change", e => {
      const n = Math.round(+(e.target as HTMLInputElement).value);
      if (n >= 2 && n <= 100) ed.segCount = n; else { toast(t("Divide into 2 to 100 pieces."), true); (e.target as HTMLInputElement).value = String(ed.segCount); }
    });
    pm.querySelector<HTMLSelectElement>("[data-a=segmode]")?.addEventListener("change", e => { ed.segMode = (e.target as HTMLSelectElement).value as typeof ed.segMode; });
    pm.querySelector<HTMLInputElement>("[data-a=oboth]")?.addEventListener("change", e => { ed.offsetBoth = (e.target as HTMLInputElement).checked; this.renderPanel(); });
    pm.querySelector<HTMLSelectElement>("[data-a=ocap]")?.addEventListener("change", e => { ed.offsetCap = (e.target as HTMLSelectElement).value as typeof ed.offsetCap; });
    pm.querySelector<HTMLInputElement>("[data-a=olink]")?.addEventListener("change", e => { ed.offsetLink = (e.target as HTMLInputElement).checked; });
    pm.querySelector<HTMLSelectElement>("[data-a=chkuse]")?.addEventListener("change", e => { this.checkUse = (e.target as HTMLSelectElement).value as SketchUse; this.renderPanel(); });
    pm.querySelector("[data-a=check]")?.addEventListener("click", () => {
      this.checkMemo = { key: JSON.stringify(ed.sk.ents), use: this.checkUse, res: checkSketch(ed.sk, this.checkUse) };
      this.renderPanel();
      pm.querySelector<HTMLElement>("[data-a=check]")?.focus();
    });
    pm.querySelectorAll<HTMLElement>("[data-chk]").forEach(b => b.addEventListener("click", () => { ed.select(b.dataset.chk!.split(",")); this.renderPanel(); }));
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => this.ok());
    pm.querySelector("[data-a=cancel]")!.addEventListener("click", () => void this.cancel());
  }

  /**
   * Sketch text (FR-SK-020): with the Text tool, what the next click places; with one text selected, its
   * own text, font, height and angle (each change remakes the outline as one undo step).
   */
  private textBox(ed: SketchEditor): string {
    const sel = ed.selection.size === 1 ? ed.sk.ents.find(e => e.id === [...ed.selection][0] && e.t === "text") as Extract<SkEnt, { t: "text" }> | undefined : undefined;
    if (ed.tool !== "text" && !sel) return "";
    const o = sel ? { text: sel.text, h: sel.h, font: sel.font ?? "sans", bold: !!sel.bold, italic: !!sel.italic, ang: sel.ang ?? 0 } : { ...ed.textOpts, ang: 0 };
    const f = UNITS[units.current].f;
    return `<div class="pm-sec pm-text"><h4>${esc(t("Text"))}</h4>`
      + `<label class="pm-field"><span>${esc(t("Text"))}</span><input type="text" data-tx="text" value="${esc(o.text)}" spellcheck="false" /></label>`
      + `<label class="pm-field"><span>${esc(t("Font"))}</span><select data-tx="font">${TEXT_FONTS.map(([k, l]) => `<option value="${k}"${o.font === k ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>`
      + `<label class="chk pm-chk"><input type="checkbox" data-tx="bold"${o.bold ? " checked" : ""} />${esc(t("Bold"))}</label><label class="chk pm-chk"><input type="checkbox" data-tx="italic"${o.italic ? " checked" : ""} />${esc(t("Italic"))}</label>`
      + `<label class="pm-field"><span>${esc(t("Height"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-tx="h" value="${trimNum(o.h * f, 4)}" /><span class="muted">${units.current}</span></span></label>`
      + (sel && !sel.along ? `<label class="pm-field"><span>${esc(t("Angle"))}</span><span class="pm-in"><input type="text" inputmode="decimal" class="pm-n" data-tx="ang" value="${trimNum((o.ang * 180) / Math.PI, 4)}" /><span class="muted">°</span></span></label>` : "")
      + (sel ? this.alongField(ed, sel) : "")
      + `<p class="pm-help muted">${esc(sel ? t("The height is that of a capital letter. Drag the text by its start point; dimension or relate that point like any other.") : t("Click in the sketch where the text starts (the left end of its baseline)."))}</p></div>`;
  }

  /**
   * Conics and equation curves (FR-SK-021): with the Equation curve tool, the equation to add; with one
   * conic or equation curve selected, its rho or its equation.
   */
  private curveBox(ed: SketchEditor): string {
    const one = ed.selection.size === 1 ? ed.sk.ents.find(e => e.id === [...ed.selection][0]) : undefined;
    const sel = one && one.t === "spline" && one.kind ? one : undefined;
    if (sel && (sel.kind === "conic" || sel.kind === "parabola")) {
      return `<div class="pm-sec pm-curve"><h4>${esc(t(sel.kind === "conic" ? "Conic" : "Parabola"))}</h4>`
        + `<label class="pm-field"><span>${esc(t("Rho"))}</span><input type="text" inputmode="decimal" class="pm-n" data-cq="rho" value="${trimNum(sel.kind === "parabola" ? 0.5 : sel.rho ?? 0.5, 4)}" /></label>`
        + `<p class="pm-help muted">${esc(t("Rho below 0.5 makes an ellipse, 0.5 a parabola, above 0.5 a hyperbola. Drag the ends or the top vertex to shape it."))}</p></div>`;
    }
    const eq = sel?.kind === "eqn" ? sel.eq : ed.tool === "eqn" ? ed.eqDraft : undefined;
    if (!eq) return "";
    const v = (k: string, label: string, val: string) => `<label class="pm-field"><span>${esc(label)}</span><input type="text" data-cq="${k}" value="${esc(val)}" spellcheck="false" translate="no" /></label>`;
    const xy = eq.mode === "xy";
    return `<div class="pm-sec pm-curve"><h4>${esc(t("Equation driven curve"))}</h4>`
      + `<label class="pm-field"><span>${esc(t("Type"))}</span><select data-cq="mode"><option value="xy"${xy ? " selected" : ""}>${esc(t("Explicit: y = f(x)"))}</option><option value="param"${xy ? "" : " selected"}>${esc(t("Parametric: x(t), y(t)"))}</option></select></label>`
      + (xy ? v("y", "y(x) =", eq.y) : v("x", "x(t) =", eq.x ?? "t") + v("y", "y(t) =", eq.y))
      + v("t0", xy ? t("From x") : t("From t"), eq.t0) + v("t1", xy ? t("To x") : t("To t"), eq.t1)
      + `<p class="pm-help muted">${esc(t("Lengths in millimetres, angles in radians; sin, cos, sqrt, ^ and pi work. The end points are fixed where the equation puts them."))}</p>`
      + (sel ? "" : `<div class="pm-actions"><button class="btn primary small" data-cq="add">${esc(t("Add curve"))}</button></div>`)
      + `</div>`;
  }

  private bindCurveBox(pm: HTMLElement, ed: SketchEditor) {
    const one = ed.selection.size === 1 ? ed.sk.ents.find(e => e.id === [...ed.selection][0]) : undefined;
    const sel = one && one.t === "spline" && one.kind ? one : undefined;
    const fields = () => {
      const eq = { ...(sel?.kind === "eqn" && sel.eq ? sel.eq : ed.eqDraft) };
      pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-cq]").forEach(el => {
        const k = el.dataset.cq!;
        if (k === "mode") eq.mode = el.value === "param" ? "param" : "xy";
        else if (k === "x" || k === "y" || k === "t0" || k === "t1") eq[k] = el.value;
      });
      if (eq.mode === "param" && eq.x === undefined) eq.x = "t";
      if (eq.mode === "xy") delete eq.x;
      return eq;
    };
    pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-cq]").forEach(el => {
      const k = el.dataset.cq!;
      if (k === "add") { el.addEventListener("click", () => { const err = ed.addEquation(fields()); if (err) toast(t(err), true); this.renderPanel(); }); return; }
      el.addEventListener("change", () => {
        if (k === "rho" && sel) {
          let r: number;
          try { r = evaluate(el.value, "number"); } catch (err) { toast(t((err as Error).message), true); return; }
          const err = ed.setCurve(sel.id, { rho: r });
          if (err) { el.setAttribute("aria-invalid", "true"); toast(t(err), true); return; }
          this.renderPanel();
          return;
        }
        const eq = fields();
        if (!sel) {
          // A new type starts from an example of it.
          if (k === "mode") Object.assign(eq, eq.mode === "param" ? { x: "10*cos(t)", y: "5*sin(t)", t0: "0", t1: "pi" } : { y: "x^2/40", t0: "-20", t1: "20" });
          ed.eqDraft = eq; if (k === "mode") this.renderPanel(); return;
        }
        const err = ed.setCurve(sel.id, { eq });
        if (err) { el.setAttribute("aria-invalid", "true"); toast(t(err), true); return; }
        this.renderPanel();
      });
    });
  }

  /** Text along a curve (FR-SK-020): pick a curve of the sketch for the baseline, and the side the letters stand on. */
  private alongField(ed: SketchEditor, sel: Extract<SkEnt, { t: "text" }>): string {
    const KINDS: Partial<Record<SkEnt["t"], string>> = { line: t("Line"), arc: t("Arc"), circle: t("Circle"), spline: t("Spline"), ellipse: t("Ellipse") };
    const seen = new Map<string, number>();
    const opts = ed.sk.ents.filter(e => KINDS[e.t]).map(e => { const n = (seen.get(e.t) ?? 0) + 1; seen.set(e.t, n); return `<option value="${e.id}"${sel.along === e.id ? " selected" : ""}>${esc(`${KINDS[e.t]} ${n}`)}</option>`; }).join("");
    return `<label class="pm-field"><span>${esc(t("Along curve"))}</span><select data-tx="along"><option value="">${esc(t("None"))}</option>${opts}</select></label>`
      + (sel.along ? `<label class="chk pm-chk"><input type="checkbox" data-tx="flip"${sel.flip ? " checked" : ""} />${esc(t("Flip side"))}</label>` : "");
  }

  private bindTextBox(pm: HTMLElement, ed: SketchEditor) {
    const sel = ed.selection.size === 1 ? ed.sk.ents.find(e => e.id === [...ed.selection][0] && e.t === "text") : undefined;
    pm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-tx]").forEach(el => el.addEventListener("change", () => {
      const k = el.dataset.tx!;
      let v: string | number | boolean = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
      if (k === "h" || k === "ang") {
        try { v = k === "h" ? evaluate(String(v), "length", units.current) : evaluate(String(v), "angle"); }
        catch (err) { el.setAttribute("aria-invalid", "true"); toast(t((err as Error).message), true); return; }
        if (k === "h" && !(v > 0)) { el.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        el.removeAttribute("aria-invalid");
      }
      if (sel) void ed.setText(sel.id, { [k]: v }).then(() => this.renderPanel());
      else (ed.textOpts as Record<string, unknown>)[k] = v;
    }));
  }

  private checkUse: SketchUse = "region";
  private checkMemo: { key: string; use: SketchUse; res: CheckResult } | null = null;

  /** Check sketch for feature (FR-SK-073): pick what the sketch is for and list what stops it, each with Show. */
  private checkBox(ed: SketchEditor) {
    const m = this.checkMemo;
    const res = m && m.use === this.checkUse && m.key === JSON.stringify(ed.sk.ents) ? m.res : null;
    return `<div class="pm-sec pm-skchk"><h4>${esc(t("Check sketch for feature"))}</h4>`
      + `<div class="pm-check-row"><select data-a="chkuse" aria-label="${esc(t("Feature"))}">${SKETCH_USES.map(([k, l]) => `<option value="${k}"${k === this.checkUse ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select>`
      + `<button class="btn small" data-a="check">${esc(t("Check"))}</button></div>`
      + (res ? `<p class="pm-check-r ${res.ok ? "ok" : "bad"}" role="status">${res.ok ? "✓" : "⚠"} ${esc(t(res.summary.message, res.summary.params))}</p>`
        + (res.issues.length ? `<ul class="pm-rel-list pm-check-l">${res.issues.map(i => `<li><span>${esc(t(i.message, i.params))}</span>${i.ents.length ? `<button class="btn small" data-chk="${esc(i.ents.join(","))}">${esc(t("Show"))}</button>` : ""}</li>`).join("")}</ul>` : "")
        : "")
      + `</div>`;
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
      : p.kind === "stretch" ? group(t("Parameters"), len("dx", t("Delta X"), p.dx) + len("dy", t("Delta Y"), p.dy))
      : p.kind === "rotate" ? group(t("Parameters"), centre(p.c) + ang("angle", t("Angle"), p.angle)) + opts(p.copy, p.keep)
      : group(t("Parameters"), centre(p.c) + `<label class="pm-field"><span>${esc(t("Scale factor"))}</span><input type="text" inputmode="decimal" class="pm-n" data-p="k" data-q="factor" value="${trimNum(p.k, 6)}" /></label>`) + opts(p.copy, p.keep);
    const titles = { linear: "Linear sketch pattern", circular: "Circular sketch pattern", move: "Move entities", rotate: "Rotate entities", scale: "Scale entities", stretch: "Stretch entities" } as const;
    const help = p.kind === "linear" || p.kind === "circular" ? "The green preview shows the instances. Copies keep equal relations to the selected entities."
      : p.kind === "stretch" ? "The selected points move; lines and arcs ending on them stretch. Dimensions across the stretch take the new sizes."
      : "The green preview shows where the entities go.";
    pm.innerHTML = okHead(t(titles[p.kind]), { okKey: "pok", cancelKey: "pcancel" })
      + `<p class="pm-help muted">${esc(t(help))}</p>`
      + body;
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
  private p3Panel(f: HelixFeature | SweepFeature | LoftFeature | RibFeature | SplitFeature | CurveFeature | SweepSurfFeature, sketches: SketchFeature[], group: (legend: string, inner: string) => string,
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
      const u = UNITS[this.doc.units.length], cell = (n: Num, key: string, label: string, i: number) => `<td><input type="text" inputmode="decimal" class="pm-n" data-num="vpitch.${i}.${key}" data-q="length" value="${esc(n.expr ?? trimNum(n.v * u.f, 6))}" aria-label="${esc(label)} ${i + 1}" spellcheck="false"${key === "h" && i === 0 ? " disabled" : ""} /></td>`;
      const table = f.vpitch ? `<table class="pm-pts"><thead><tr><th>${esc(t("Height"))}</th><th>${esc(t("Pitch"))}</th><th>${esc(t("Diameter"))}</th><th></th></tr></thead><tbody>${f.vpitch.map((r, i) => `<tr>${cell(r.h, "h", t("Height"), i)}${cell(r.p, "p", t("Pitch"), i)}${cell(r.d, "d", t("Diameter"), i)}<td>${f.vpitch!.length > 2 ? `<button class="icon" data-vpdel="${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))} ${i + 1}">✕</button>` : ""}</td></tr>`).join("")}</tbody></table><button class="btn small" data-vpadd="1">${esc(t("Add row"))}</button>` : "";
      const params = f.vpitch ? table + chk("reverse", f.reverse, t("Reverse direction")) + numField("start", t("Start angle"), f.start ?? { v: 0 }, "angle") + chk("cw", f.cw, t("Clockwise"))
        : fields + chk("reverse", f.reverse, t("Reverse direction")) + numField("start", t("Start angle"), f.start ?? { v: 0 }, "angle") + chk("cw", f.cw, t("Clockwise"));
      return { title: t("Helix/Spiral"), body: group(t("Defined by"), sel("hsketch", t("Sketch with a circle"), skOpts(withCircle, f.sketch)) + (f.vpitch ? "" : sel("mode", t("Type"), modes.map(([v, l]) => `<option value="${v}"${v === f.mode ? " selected" : ""}>${esc(l)}</option>`).join(""))) + chk("vpitchOn", !!f.vpitch, t("Variable pitch")))
        + group(t("Parameters"), params)
        + (f.vpitch ? "" : group(t("Taper helix"), chk("taperOn", !!f.taper, t("Taper helix")) + (f.taper ? numField("taper", t("Angle"), f.taper, "angle") : "")))
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
        + (f.dir === "normal" ? group(t("Draft"), chk("ribDraft", !!f.draft, t("Draft on")) + (f.draft ? numField("draft", t("Draft angle"), f.draft, "angle") + chk("draftOut", f.draftOut, t("Draft outward")) : "")) : "")
        + `<p class="pm-help muted">${esc(t("Sketch an open line or arc chain beside the part: the rib runs from it to the body, which closes it. Parallel grows it in the sketch plane, Normal along the sketch normal."))}</p>` };
    }
    if (f.type === "curve") return this.curvePanel(f, sketches, group, chk, sel, skOpts);
    const orient = (o: "follow" | "normal" | undefined) => sel("orient", t("Profile orientation"), `<option value="follow"${o === "normal" ? "" : " selected"}>${esc(t("Follow path"))}</option><option value="normal"${o === "normal" ? " selected" : ""}>${esc(t("Keep normal constant"))}</option>`);
    if (f.type === "sweep" || f.type === "sweepsurf") {
      const at = this.mode.kind === "feature" ? this.mode.index : this.doc.features.length;
      const curves = this.doc.features.slice(0, at).filter(g => g.type === "helix" || g.type === "curve" || g.type === "sketch3d");
      const closed = sketches.filter(sketchProfileOk);
      const pathCur = f.path ? pathKey(f.path) : "";
      const paths = opt("", t("None"), pathCur) + curves.map(h => opt(`${h.type === "helix" ? "h" : "c"}:${h.id}`, featureLabel(h.name), pathCur)).join("") + sketches.filter(s => s.id !== f.profile).map(s => opt(`s:${s.id}`, featureLabel(s.name), pathCur)).join("");
      if (f.type === "sweepsurf") {
        const chains = sketches.filter(s => !sketchPath(s).error || s.id === f.profile);
        return { title: t("Swept Surface"), body: group(t("Profile and path"), sel("swProfile", t("Profile sketch"), skOpts(chains, f.profile, f.profile ? undefined : t("None"))) + sel("swPath", t("Path"), paths))
          + group(t("Options"), orient(f.orient))
          + `<p class="pm-help muted">${esc(t("The profile's curves, open or closed, move along the path into an open surface."))}</p>` };
      }
      return { title: f.op === "cut" ? t("Cut-Sweep") : t("Sweep"), body: group(t("Profile and path"),
        `<label class="pm-field"><span>${esc(t("Profile"))}</span><select data-k="profileKind"><option value="sketch"${f.circular ? "" : " selected"}>${esc(t("Sketch profile"))}</option><option value="circular"${f.circular ? " selected" : ""}>${esc(t("Circular profile"))}</option></select></label>`
        + (f.circular ? numField("circular", t("Diameter"), f.circular, "length") : sel("swProfile", t("Profile sketch"), skOpts(closed, f.profile ?? "", t("None"))))
        + sel("swPath", t("Path"), paths))
        + group(t("Guide curve"), sel("swGuide", t("Guide curve"), opt("", t("None"), f.guide ? pathKey(f.guide) : "") + curves.map(h => opt(`${h.type === "helix" ? "h" : "c"}:${h.id}`, featureLabel(h.name), f.guide ? pathKey(f.guide) : "")).join("") + sketches.filter(s => s.id !== f.profile && (!f.path || !("sketch" in f.path) || s.id !== f.path.sketch)).map(s => opt(`s:${s.id}`, featureLabel(s.name), f.guide ? pathKey(f.guide) : "")).join(""))
          + (f.guide ? `<p class="pm-help muted">${esc(t("The profile grows, shrinks and turns so that its edge keeps touching the guide curve. Start the guide on the profile."))}</p>` : ""))
        + (f.circular ? "" : group(t("Start and End Tangency"), `<label class="pm-field"><span>${esc(t("Start tangency"))}</span><select data-k="startTan"><option value=""${f.startTangent ? "" : " selected"}>${esc(t("None"))}</option><option value="path"${f.startTangent ? " selected" : ""}>${esc(t("Path tangent"))}</option></select></label>`
          + (f.startTangent ? `<p class="pm-help muted">${esc(t("The profile is turned square to the path where the path starts."))}</p>` : "")
          + `<label class="pm-field"><span>${esc(t("End tangency"))}</span><select data-k="endTan"><option value=""${f.endTangent ? "" : " selected"}>${esc(t("None"))}</option><option value="path"${f.endTangent ? " selected" : ""}>${esc(t("Path tangent"))}</option></select></label>`
          + (f.endTangent ? `<p class="pm-help muted">${esc(t("The sweep ends with the profile square to the path. Not with a guide curve or a closed path."))}</p>` : "")))
        + group(t("Options"), (f.guide ? "" : orient(f.orient)) + (f.guide || f.orient === "normal" ? "" : chk("twistOn", !!f.twist, t("Twist along path")) + (f.twist ? numField("twist", t("Twist angle"), f.twist, "angle") : ""))
          + (f.op === "boss" && this.last?.data ? chk("merge", f.merge !== false, t("Merge result")) : ""))
        + `<p class="pm-help muted">${esc(t("The profile moves along the path. A circular profile needs no sketch: it is centred on the start of the path, square to it."))}</p>` };
    }
    const closed = sketches.filter(sketchProfileOk);
    const rows = f.profiles.map((id, i) => sel(`lp${i}`, `${t("Profile")} ${i + 1}`, skOpts(closed, id, t("Remove")))).join("")
      + sel(`lp${f.profiles.length}`, t("Add profile"), skOpts(closed.filter(s => !f.profiles.includes(s.id)), "", "—"));
    return { title: f.op === "cut" ? t("Cut-Loft") : t("Loft"), body: group(t("Profiles"), rows + `<p class="pm-help muted">${esc(t("Profiles are joined in this order. Each is one closed region, usually on parallel planes."))}</p>`)
      + group(t("Centerline"), (() => {
        const at = this.mode.kind === "feature" ? this.mode.index : this.doc.features.length;
        const curves = this.doc.features.slice(0, at).filter(g => g.type === "helix" || g.type === "curve" || g.type === "sketch3d");
        const cur = f.centerline ? pathKey(f.centerline) : "";
        return sel("lcPath", t("Centerline"), opt("", t("None"), cur) + curves.map(h => opt(`${h.type === "helix" ? "h" : "c"}:${h.id}`, featureLabel(h.name), cur)).join("") + sketches.filter(s => !f.profiles.includes(s.id) && !sketchProfileOk(s)).map(s => opt(`s:${s.id}`, featureLabel(s.name), cur)).join(""))
          + (f.centerline ? `<p class="pm-help muted">${esc(t("The loft follows the centreline between its profiles. Each profile should sit across it, in its order."))}</p>` : "");
      })())
      + (f.centerline || f.profiles.length < 2 ? "" : group(t("Connectors"), f.profiles.map((id, i) => {
        const sk = sketches.find(x => x.id === id);
        const cur = f.connectors?.[i] ?? "";
        const pts = (sk?.ents ?? []).filter(e => e.t === "point" && sk!.ents.some(c => c.t === "line" && !c.cons && (c.a === e.id || c.b === e.id)));
        return sel(`lc${i}`, `${t("Start point")} ${i + 1}`, opt("", t("Automatic"), cur) + pts.map(e => e.t === "point" ? `<option value="${esc(e.id)}"${e.id === cur ? " selected" : ""}>(${esc(trimNum(e.x, 2))}, ${esc(trimNum(e.y, 2))})</option>` : "").join(""));
      }).join("") + `<p class="pm-help muted">${esc(t("The loft joins the start points of the profiles. Pick matching corners to stop it twisting."))}</p>`))
      + (f.centerline ? "" : group(t("Guide curves"), (() => {
        const at = this.mode.kind === "feature" ? this.mode.index : this.doc.features.length;
        const curves = this.doc.features.slice(0, at).filter(g => g.type === "curve" || g.type === "sketch3d");
        const gs = f.guides ?? [];
        const opts = (cur: string, none: string) => opt("", none, cur) + curves.map(h => opt(`c:${h.id}`, featureLabel(h.name), cur)).join("")
          + sketches.filter(s => !f.profiles.includes(s.id) && !sketchProfileOk(s)).map(s => opt(`s:${s.id}`, featureLabel(s.name), cur)).join("");
        return gs.map((g, i) => sel(`lg${i}`, `${t("Guide curve")} ${i + 1}`, opts(pathKey(g), t("Remove")))).join("")
          + sel(`lg${gs.length}`, t("Add guide curve"), opts("", "—"))
          + `<p class="pm-help muted">${esc(t("Each guide touches every profile. The loft's sections grow and shrink so that they pass through the guides."))}</p>`;
      })()))
      + (f.centerline || f.ruled || f.close || f.guides?.length ? "" : group(t("Start/End Constraints"), (["start", "end"] as const).map(w => {
        const on = w === "start" ? !!f.startNormal : !!f.endNormal, len = (w === "start" ? f.startLen : f.endLen) ?? 1;
        return sel(`${w}C`, w === "start" ? t("Start constraint") : t("End constraint"), `<option value="none"${on ? "" : " selected"}>${esc(t("None"))}</option><option value="normal"${on ? " selected" : ""}>${esc(t("Normal to profile"))}</option>`)
          + (on ? `<label class="pm-field"><span>${esc(t("Tangent length"))}</span><input type="text" inputmode="decimal" data-k="${w}Len" value="${esc(trimNum(len, 3))}" spellcheck="false" /></label>` : "");
      }).join("")))
      + (f.centerline || f.guides?.length ? "" : group(t("Options"), chk("ruled", f.ruled, t("Straight sections (ruled)")) + (f.profiles.length >= 3 ? chk("close", f.close, t("Close loft")) : "")
        + (f.op === "boss" && this.last?.data ? chk("merge", f.merge !== false, t("Merge result")) : ""))) };
  }

  /** 3D sketch editing state (view-only): tool, sketch plane, the chain's last point, the spline being drawn, selection. */
  private sk3: { id: string; tool: "line" | "spline" | null; plane: "XY" | "YZ" | "ZX"; anchor: string | null; spline: string | null; sel: string[] } = { id: "", tool: null, plane: "XY", anchor: null, spline: null, sel: [] };
  private s3(f: Sketch3dFeature) {
    if (this.sk3.id !== f.id) this.sk3 = { id: f.id, tool: f.segs.length ? null : "line", plane: "XY", anchor: null, spline: null, sel: [] };
    return this.sk3;
  }

  /** A change to the 3D sketch, then a solve; a change that leaves the relations unsolvable is undone (FR-SK-080). */
  private change3d(f: Sketch3dFeature, fn: () => void) {
    const before = JSON.stringify({ pts: f.pts, segs: f.segs, rels: f.rels, dims: f.dims });
    fn();
    const r = solve3d(f);
    if (!r.ok) {
      Object.assign(f, JSON.parse(before));
      toast(t("The relations and dimensions conflict; the change was undone."), true);
    } else for (const p of f.pts) p.p = r.pts[p.id];
    const s3 = this.s3(f);
    s3.sel = s3.sel.filter(id => f.pts.some(p => p.id === id) || f.segs.some(g => g.id === id));
    this.renderPanel();
    this.draftChanged();
  }

  /** Where a click in the view puts a 3D sketch point: an existing point, a snap point, a face, else the sketch plane through the last point. */
  private click3d(e: PointerEvent, f: Sketch3dFeature): { id?: string; p?: V3 } | null {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const scr = (p: V3) => { const q = new THREE.Vector3(...p).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; };
    const near = f.pts.find(p => { const [x, y] = scr(p.p); return Math.hypot(x - e.clientX, y - e.clientY) < 8; });
    if (near) return { id: near.id };
    const snap = this.host.snapAt?.(e.clientX, e.clientY);
    if (snap) return { p: snap.point };
    const face = this.host.faceAt(e.clientX, e.clientY);
    if (face) return { p: face.point };
    const s3 = this.s3(f);
    const o = (s3.anchor && f.pts.find(p => p.id === s3.anchor)?.p) || [0, 0, 0];
    const n = s3.plane === "XY" ? [0, 0, 1] : s3.plane === "YZ" ? [1, 0, 0] : [0, 1, 0];
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
    const hit = rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...n), new THREE.Vector3(...o)), new THREE.Vector3());
    if (!hit) return null;
    const q: V3 = [hit.x, hit.y, hit.z];
    // The point stays on the plane: round the in-plane coordinates to 0.01 mm.
    return { p: q.map((c, i) => n[i] ? o[i] : Math.round(c * 100) / 100) as V3 };
  }

  private pick3d(e: PointerEvent, f: Sketch3dFeature) {
    const s3 = this.s3(f);
    if (!s3.tool) {
      // Select: a point, else the nearest segment on screen.
      const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
      const scr = (p: V3) => { const q = new THREE.Vector3(...p).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; };
      let id = f.pts.find(p => { const [x, y] = scr(p.p); return Math.hypot(x - e.clientX, y - e.clientY) < 8; })?.id;
      if (!id) {
        let bd = 6;
        for (const sg of f.segs) {
          const line = segPoints(f, sg).map(scr);
          for (let i = 0; i + 1 < line.length; i++) {
            const [ax, ay] = line[i], [bx, by] = line[i + 1], ux = bx - ax, uy = by - ay, l2 = ux * ux + uy * uy || 1e-9;
            const tt = Math.max(0, Math.min(1, ((e.clientX - ax) * ux + (e.clientY - ay) * uy) / l2));
            const d = Math.hypot(e.clientX - ax - ux * tt, e.clientY - ay - uy * tt);
            if (d < bd) { bd = d; id = sg.id; }
          }
        }
      }
      if (!id) { s3.sel = []; } else s3.sel = s3.sel.includes(id) ? s3.sel.filter(x => x !== id) : [...s3.sel, id];
      this.renderPanel(); this.drawDecor();
      return;
    }
    const at = this.click3d(e, f);
    if (!at) return;
    this.change3d(f, () => {
      let pid = at.id;
      if (!pid) { pid = uid("p"); f.pts.push({ id: pid, p: at.p! }); }
      const a = s3.anchor;
      if (a && a !== pid) {
        if (s3.tool === "line") f.segs.push({ id: uid("l"), t: "line", pts: [a, pid] });
        else {
          const sg = s3.spline ? f.segs.find(x => x.id === s3.spline) : undefined;
          if (sg) sg.pts.push(pid); else { const sid = uid("s"); f.segs.push({ id: sid, t: "spline", pts: [a, pid] }); s3.spline = sid; }
        }
      }
      s3.anchor = pid;
    });
  }

  /** Deletes the selected points (with the segments on them) and segments, and the relations and dimensions on them. */
  private delete3d(f: Sketch3dFeature) {
    const s3 = this.s3(f), sel = new Set(s3.sel);
    this.change3d(f, () => {
      const gone = f.segs.filter(g => sel.has(g.id) || g.pts.some(q => sel.has(q)));
      f.segs = f.segs.filter(g => !gone.includes(g));
      // Points of removed segments go too when nothing else uses them.
      const used = new Set(f.segs.flatMap(g => g.pts)), loose = new Set(gone.flatMap(g => g.pts).filter(q => !used.has(q)));
      f.pts = f.pts.filter(p => !sel.has(p.id) && !loose.has(p.id));
      const ids = new Set([...f.pts.map(p => p.id), ...f.segs.map(g => g.id)]);
      f.rels = f.rels.filter(r => r.e.every(x => ids.has(x)));
      f.dims = f.dims.filter(d => d.e.every(x => ids.has(x)));
      s3.sel = [];
      if (s3.anchor && !ids.has(s3.anchor)) { s3.anchor = null; s3.spline = null; }
    });
  }

  /** 3D sketches in the view: shown ones in the sketch colour, the one being edited with its points, selection and plane. */
  private draw3dSketches() {
    const m = this.mode, dark = document.documentElement.dataset.theme === "dark";
    const end = this.doc.rollback ?? this.doc.features.length;
    const editing = m.kind === "feature" && m.draft.type === "sketch3d" ? m.draft : null;
    const list = this.doc.features.slice(0, end).filter((g): g is Sketch3dFeature => g.type === "sketch3d" && !g.suppressed && !g.hidden && g.id !== editing?.id);
    const segPos = (f: Sketch3dFeature, only?: (id: string) => boolean) => {
      const pos: number[] = [];
      for (const sg of f.segs) { if (only && !only(sg.id)) continue; const q = segPoints(f, sg); for (let i = 0; i + 1 < q.length; i++) pos.push(...q[i], ...q[i + 1]); }
      return pos;
    };
    for (const f of list) this.lines(segPos(f), dark ? 0x8ab4ff : 0x1d4ed8, 1.6);
    if (!editing) return;
    const s3 = this.s3(editing), sel = new Set(s3.sel);
    this.lines(segPos(editing, id => !sel.has(id)), dark ? 0x8ab4ff : 0x1d4ed8, 2);
    this.lines(segPos(editing, id => sel.has(id)), 0xf08c00, 3.5);
    const ptsGeo = (list: V3[]) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(list.flat(), 3)); return g; };
    const dots = (list: V3[], color: number, size: number) => {
      if (!list.length) return;
      const o = new THREE.Points(ptsGeo(list), new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }));
      o.renderOrder = 2600;
      this.decor.add(o);
    };
    dots(editing.pts.filter(p => !sel.has(p.id) && !p.fixed).map(p => p.p), dark ? 0xe5e7eb : 0x111827, 6);
    dots(editing.pts.filter(p => !sel.has(p.id) && p.fixed).map(p => p.p), 0x16a34a, 7);
    dots(editing.pts.filter(p => sel.has(p.id)).map(p => p.p), 0xf08c00, 8);
    if (s3.tool) {
      // The sketch plane through the last point: a dashed square.
      const o = (s3.anchor && editing.pts.find(p => p.id === s3.anchor)?.p) || [0, 0, 0];
      const [u, w]: [V3, V3] = s3.plane === "XY" ? [[1, 0, 0], [0, 1, 0]] : s3.plane === "YZ" ? [[0, 1, 0], [0, 0, 1]] : [[0, 0, 1], [1, 0, 0]];
      const h = 25, c = (a: number, b: number) => o.map((x, i) => x + a * h * u[i] + b * h * w[i]);
      const sq = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
      const pos: number[] = [];
      for (let i = 0; i < 4; i++) pos.push(...sq[i], ...sq[(i + 1) % 4]);
      this.lines(pos, 0xf08c00, 1, true);
    }
  }

  /** PropertyManager for the 3D sketch: tools and plane, points, segments, relations and dimensions (FR-SK-080). */
  private sk3Panel(f: Sketch3dFeature, group: (legend: string, inner: string) => string): { title: string; body: string } {
    const s3 = this.s3(f), u = UNITS[units.current].f, sel = new Set(s3.sel);
    const pIdx = (id: string) => f.pts.findIndex(p => p.id === id) + 1;
    const segName = (id: string) => { const sg = f.segs.find(g => g.id === id); if (!sg) return "?"; const k = f.segs.filter(g => g.t === sg.t).indexOf(sg) + 1; return sg.t === "line" ? t("Line {n}", { n: k }) : t("Spline {n}", { n: k }); };
    const entName = (id: string) => f.pts.some(p => p.id === id) ? `P${pIdx(id)}` : segName(id);
    const tb = (id: string, label: string, on: boolean) => `<button class="btn small${on ? " primary" : ""}" data-s3t="${id}" aria-pressed="${on}">${esc(label)}</button>`;
    const tools = `<div class="pm-rels">${tb("select", t("Select"), !s3.tool)}${tb("line", t("Line"), s3.tool === "line")}${tb("spline", t("Spline"), s3.tool === "spline")}${s3.anchor ? `<button class="btn small" data-s3a="end">${esc(t("End chain"))}</button>` : ""}</div>`
      + `<label class="pm-field"><span>${esc(t("Sketch plane"))}</span><select data-s3p translate="no">${(["XY", "YZ", "ZX"] as const).map(p => `<option value="${p}"${p === s3.plane ? " selected" : ""}>${p}</option>`).join("")}</select></label>`
      + `<p class="pm-help muted">${esc(t("Click to place points; each click draws to the last one. Points land on model vertices and faces, else on the sketch plane through the last point. Tab turns the plane, Esc ends the chain."))}</p>`;
    const rows = f.pts.map((p, i) => `<tr${sel.has(p.id) ? ' class="on"' : ""}><th scope="row"><button class="link" data-s3sel="${p.id}" translate="no">P${i + 1}</button></th>${p.p.map((v, j) => `<td><input type="text" inputmode="decimal" class="pm-n" data-s3x="${i}:${j}" value="${trimNum(v * u, 4)}" aria-label="${"XYZ"[j]}${i + 1}" /></td>`).join("")}<td><input type="checkbox" data-s3f="${i}"${p.fixed ? " checked" : ""} title="${esc(t("Fixed"))}" aria-label="${esc(t("Fixed"))} P${i + 1}" /></td></tr>`).join("");
    const pts = f.pts.length ? `<table class="pm-pts"><thead><tr><th>#</th><th>X</th><th>Y</th><th>Z</th><th>${esc(t("Fixed"))}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="pm-help muted">${esc(t("None yet."))}</p>`;
    const L = (sg: Sketch3dFeature["segs"][number]) => { const a = f.pts.find(p => p.id === sg.pts[0])?.p, b = f.pts.find(p => p.id === sg.pts[sg.pts.length - 1])?.p; return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : 0; };
    const segs = f.segs.length ? `<ul class="pm-dims">${f.segs.map(sg => `<li><button class="link${sel.has(sg.id) ? " on" : ""}" data-s3sel="${sg.id}" aria-pressed="${sel.has(sg.id)}">${esc(segName(sg.id))}</button> <span class="muted" translate="no">${sg.pts.map(q => `P${pIdx(q)}`).join("–")}${sg.t === "line" ? ` · ${trimNum(L(sg) * u, 3)} ${units.current}` : ""}</span></li>`).join("")}</ul>` : "";
    // Relations and dimensions that fit the selection.
    const lines = s3.sel.filter(id => f.segs.find(g => g.id === id)?.t === "line"), points = s3.sel.filter(id => f.pts.some(p => p.id === id));
    const rb = (k: string, label: string) => `<button class="btn small" data-s3r="${k}">${esc(label)}</button>`;
    let add = "";
    if (lines.length === 1 && !points.length) add = rb("alongX", t("Along X")) + rb("alongY", t("Along Y")) + rb("alongZ", t("Along Z")) + (["XY", "YZ", "ZX"] as const).map(p => rb(`parallelPlane:${p}`, t("Parallel to {p}", { p }))).join("") + rb("dim:length", t("Length"));
    if (lines.length === 2 && !points.length) add = rb("parallel", t("Parallel")) + rb("perpendicular", t("Perpendicular")) + rb("equal", t("Equal"));
    if (points.length === 2 && !lines.length) add = rb("coincident", t("Coincident")) + rb("dim:distance", t("Distance"));
    if (points.length && !lines.length) add += rb("fix", points.every(id => f.pts.find(p => p.id === id)?.fixed) ? t("Unfix") : t("Fix"));
    if (s3.sel.length) add += `<button class="btn small danger" data-s3a="del">${esc(t("Delete"))}</button>`;
    const relLabel = (r: Sk3Rel) => r.t === "alongX" ? t("Along X") : r.t === "alongY" ? t("Along Y") : r.t === "alongZ" ? t("Along Z") : r.t === "parallelPlane" ? t("Parallel to {p}", { p: r.plane ?? "XY" })
      : r.t === "parallel" ? t("Parallel") : r.t === "perpendicular" ? t("Perpendicular") : r.t === "equal" ? t("Equal") : t("Coincident");
    const rels = f.rels.map(r => `<li>${esc(relLabel(r))} <span class="muted" translate="no">${r.e.map(entName).join(", ")}</span> <button class="icon" data-s3rdel="${r.id}" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></li>`).join("");
    const dims = f.dims.map((d, i) => `<li><label class="pm-field"><span translate="no">D${i + 1} (${esc(d.e.map(entName).join(", "))})</span><input type="text" inputmode="decimal" class="pm-n" data-s3dim="${d.id}" value="${esc(d.val.expr ?? trimNum(d.val.v * u, 4))}" /></label> <button class="icon" data-s3ddel="${d.id}" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></li>`).join("");
    const st = solve3d(f);
    const status = !st.ok ? t("The relations and dimensions conflict.") : st.dof === 0 ? t("Fully defined") : t("{n} degree of freedom left|{n} degrees of freedom left", { n: st.dof });
    return { title: t("3D Sketch"), body: group(t("Tools"), tools)
      + group(t("Points"), pts)
      + group(t("Lines and splines"), segs || `<p class="pm-help muted">${esc(t("None yet."))}</p>`)
      + group(t("Relations"), (add ? `<div class="pm-rels">${add}</div>` : `<p class="pm-help muted">${esc(t("Select a line, two lines or two points (in the view or above) to add relations and dimensions."))}</p>`) + (rels ? `<ul class="pm-dims">${rels}</ul>` : ""))
      + group(t("Dimensions"), dims ? `<ul class="pm-dims">${dims}</ul>` : `<p class="pm-help muted">${esc(t("None yet."))}</p>`)
      + `<p class="pm-help" role="status" data-s3status>${esc(status)}</p>` };
  }

  private bindSk3Panel(pm: HTMLElement, f: Sketch3dFeature, unit: string) {
    const s3 = this.s3(f);
    const num = (inp: HTMLInputElement): number | null => {
      try { const v = evaluate(inp.value, "length", unit as never, evalVars(this.doc, unit as never).values); inp.removeAttribute("aria-invalid"); return v; }
      catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return null; }
    };
    pm.querySelectorAll<HTMLButtonElement>("[data-s3t]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.s3t; s3.tool = k === "line" || k === "spline" ? k : null; s3.spline = null; if (!s3.tool) s3.anchor = null; this.renderPanel(); this.drawDecor(); }));
    pm.querySelector<HTMLSelectElement>("[data-s3p]")?.addEventListener("change", ev => { s3.plane = (ev.target as HTMLSelectElement).value as "XY" | "YZ" | "ZX"; this.drawDecor(); });
    pm.querySelectorAll<HTMLButtonElement>("[data-s3sel]").forEach(b => b.addEventListener("click", () => { const id = b.dataset.s3sel!; s3.sel = s3.sel.includes(id) ? s3.sel.filter(x => x !== id) : [...s3.sel, id]; this.renderPanel(); this.drawDecor(); }));
    pm.querySelectorAll<HTMLInputElement>("input[data-s3x]").forEach(inp => {
      const apply = () => { const [i, j] = inp.dataset.s3x!.split(":").map(Number); const v = num(inp); const p = f.pts[i]; if (v == null || !p || p.p[j] === v) return; this.change3d(f, () => { p.p = p.p.map((c, k) => k === j ? v : c) as V3; }); };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLInputElement>("input[data-s3f]").forEach(inp => inp.addEventListener("change", () => { const p = f.pts[+inp.dataset.s3f!]; if (p) this.change3d(f, () => { if (inp.checked) p.fixed = true; else delete p.fixed; }); }));
    pm.querySelectorAll<HTMLButtonElement>("[data-s3r]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.s3r!;
      const lines = s3.sel.filter(id => f.segs.some(g => g.id === id)), points = s3.sel.filter(id => f.pts.some(p => p.id === id));
      this.change3d(f, () => {
        if (k === "fix") { const all = points.every(id => f.pts.find(p => p.id === id)?.fixed); for (const id of points) { const p = f.pts.find(q => q.id === id)!; if (all) delete p.fixed; else p.fixed = true; } return; }
        if (k.startsWith("dim:")) {
          const P = (id: string) => f.pts.find(p => p.id === id)!.p;
          const sg = f.segs.find(g => g.id === lines[0]);
          const [a, c] = k === "dim:length" && sg ? [P(sg.pts[0]), P(sg.pts[sg.pts.length - 1])] : [P(points[0]), P(points[1])];
          f.dims.push({ id: uid("d"), t: k === "dim:length" ? "length" : "distance", e: k === "dim:length" ? [lines[0]] : points.slice(0, 2), val: { v: Math.round(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) * 1000) / 1000 } });
          return;
        }
        const [tp, plane] = k.split(":");
        const r: Sk3Rel = { id: uid("r"), t: tp as Sk3Rel["t"], e: tp === "coincident" ? points.slice(0, 2) : lines.slice(0, tp.startsWith("along") || tp === "parallelPlane" ? 1 : 2) };
        if (plane) r.plane = plane as Sk3Rel["plane"];
        f.rels.push(r);
      });
    }));
    pm.querySelector("[data-s3a=end]")?.addEventListener("click", () => { s3.anchor = null; s3.spline = null; this.renderPanel(); this.drawDecor(); });
    pm.querySelector("[data-s3a=del]")?.addEventListener("click", () => this.delete3d(f));
    pm.querySelectorAll<HTMLButtonElement>("[data-s3rdel]").forEach(b => b.addEventListener("click", () => this.change3d(f, () => { f.rels = f.rels.filter(r => r.id !== b.dataset.s3rdel); })));
    pm.querySelectorAll<HTMLButtonElement>("[data-s3ddel]").forEach(b => b.addEventListener("click", () => this.change3d(f, () => { f.dims = f.dims.filter(d => d.id !== b.dataset.s3ddel); })));
    pm.querySelectorAll<HTMLInputElement>("input[data-s3dim]").forEach(inp => {
      const apply = () => {
        const d = f.dims.find(x => x.id === inp.dataset.s3dim); const v = num(inp);
        if (!d || v == null) return;
        if (!(v > 0)) { inp.setAttribute("aria-invalid", "true"); toast(t("The value must be more than 0."), true); return; }
        this.change3d(f, () => { d.val = isPlain(inp.value) ? { v } : { v, expr: inp.value.trim() }; });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
  }

  /** PropertyManager for 3D curves (FR-FT-085): a point table with CSV import, picked edges, or a sketch projected onto faces. */
  private curvePanel(f: CurveFeature, sketches: SketchFeature[], group: (legend: string, inner: string) => string, chk: (k: string, on: boolean | undefined, label: string) => string,
    sel: (k: string, label: string, inner: string) => string, skOpts: (list: SketchFeature[], cur: string, none?: string) => string): { title: string; body: string } {
    if (f.kind === "xyz") {
      const u = UNITS[units.current].f;
      const rows = (f.pts ?? []).map((q, i) => `<tr><th scope="row">${i + 1}</th>${q.map((v, j) => `<td><input type="text" inputmode="decimal" class="pm-n" data-cx="${i}:${j}" value="${trimNum(v * u, 4)}" aria-label="${"XYZ"[j]}${i + 1}" /></td>`).join("")}<td><button class="icon" data-crvdel="${i}" title="${esc(t("Delete point"))}" aria-label="${esc(t("Delete point"))} ${i + 1}">✕</button></td></tr>`).join("");
      return { title: t("Curve Through XYZ Points"), body: group(t("Points"), `<table class="pm-pts"><thead><tr><th>#</th><th>X</th><th>Y</th><th>Z</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          + `<div class="pm-rels"><button class="btn small" data-crv="add">${esc(t("Add point"))}</button><button class="btn small" data-crv="csv">${esc(t("Import CSV…"))}</button></div>`
          + chk("closed", f.closed, t("Closed curve")))
        + `<p class="pm-help muted">${esc(t("A smooth curve through the points in order, in part coordinates ({u}). A CSV or text file has one point per line: x, y, z.", { u: units.current }))}</p>` };
    }
    if (f.kind === "composite") {
      const n = f.edges?.length ?? 0;
      return { title: t("Composite Curve"), body: group(t("Edges to join"), `<p class="pm-count">${esc(n ? t("{n} edge|{n} edges", { n }) : t("None"))}</p>` + (n ? `<button class="btn small" data-crv="clear">${esc(t("Clear edges"))}</button>` : ""))
        + `<p class="pm-help muted">${esc(t("Click edges of the model, in any order: they must join end to end into one chain. Use the curve as a sweep path."))}</p>` };
    }
    const chains = sketches.filter(s => !sketchPath(s).error || s.id === f.sketch);
    const nf = f.faces?.length ?? 0;
    return { title: t("Projected Curve"), body: group(t("Sketch to project"), sel("sketch", t("Sketch"), skOpts(chains, f.sketch ?? "", f.sketch ? undefined : t("None"))) + chk("flip", f.flip, t("Reverse projection")))
      + group(t("Faces to project onto"), `<p class="pm-count">${esc(nf ? t("{n} face|{n} faces", { n: nf }) : t("All faces of the part"))}</p>` + (nf ? `<button class="btn small" data-crv="clearf">${esc(t("Clear faces"))}</button>` : ""))
      + `<p class="pm-help muted">${esc(t("The sketch's chain of curves is projected along its normal onto the faces; the nearest piece is kept. Click faces to project onto only those."))}</p>` };
  }

  private bindCurvePanel(pm: HTMLElement, f: CurveFeature, unit: string, upd: (fn: () => void, structural?: boolean) => void) {
    pm.querySelectorAll<HTMLInputElement>("input[data-cx]").forEach(inp => {
      const apply = () => {
        const [i, j] = inp.dataset.cx!.split(":").map(Number);
        let v: number;
        try { v = evaluate(inp.value, "length", unit as never, evalVars(this.doc, unit as never).values); }
        catch (err) { inp.setAttribute("aria-invalid", "true"); toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), true); return; }
        inp.removeAttribute("aria-invalid");
        const q = f.pts?.[i];
        if (!q || q[j] === v) return;
        upd(() => { q[j] = v; });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    pm.querySelectorAll<HTMLButtonElement>("[data-crvdel]").forEach(b => b.addEventListener("click", () => upd(() => { f.pts?.splice(+b.dataset.crvdel!, 1); }, true)));
    pm.querySelectorAll<HTMLButtonElement>("[data-crv]").forEach(b => b.addEventListener("click", () => {
      const a = b.dataset.crv;
      if (a === "add") upd(() => { const pts = (f.pts ??= []); const last = pts.at(-1) ?? [0, 0, 0]; pts.push([last[0] + 10, last[1], last[2]]); }, true);
      else if (a === "clear") upd(() => { f.edges = []; }, true);
      else if (a === "clearf") upd(() => { f.faces = []; }, true);
      else if (a === "csv") {
        const input = document.createElement("input");
        input.type = "file"; input.accept = ".csv,.txt,.xyz,text/csv,text/plain";
        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          if (!file) return;
          const pts = parseXyz(await file.text(), 1 / UNITS[units.current].f);
          if (pts.length < 2) { toast(t("The file has fewer than two points (x, y, z per line)."), true); return; }
          upd(() => { f.pts = pts; }, true);
          toast(t("{n} point read|{n} points read", { n: pts.length }));
        });
        input.click();
      }
    }));
  }

  /** PropertyManager for Combine, Split body, Delete/Keep body and Move/Copy body (FRS 9.10). */
  private bodyPanel(f: BodyFeature, focus: Focus | undefined, group: (legend: string, inner: string) => string,
    numField: (key: string, label: string, n: Num, q: "length" | "angle") => string, chk: (k: string, on: boolean | undefined, label: string) => string): { title: string; body: string } {
    const box = (fc: Focus, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${focus === fc ? " focus" : ""}" data-focus="${fc}" translate="no">${esc(value)}</button></div>`;
    const n = (k: number) => t("{n} body|{n} bodies", { n: k });
    const list = f.type === "combine" || f.type === "indent" ? f.tools : f.bodies;
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
    if (f.type === "indent") {
      return { title: t("Indent"), body: group(t("Selections"), box("main", t("Target body"), f.main ? t("Body picked") : t("None"))
          + box("bodies", t("Tool bodies"), n(f.tools.length)) + clear)
        + group(t("Parameters"), chk("cut", f.cut, t("Cut (no wall)")) + (f.cut ? "" : numField("thickness", t("Thickness"), f.thickness, "length")) + numField("clearance", t("Clearance"), f.clearance, "length"))
        + `<p class="pm-help muted">${esc(t("The target body takes the shape of the tool bodies: they are cut out, grown by the clearance, and a wall of the thickness follows them on the side they press into. The tool bodies stay."))}</p>` + help + status };
    }
    if (f.type === "intersect") {
      const regions = this.last?.regions?.[f.id] ?? [];
      const u = UNITS[this.doc.units.length], vol = (v: number) => `${trimNum(v * u.f ** 3, 2)} ${this.doc.units.length}³`;
      const rows = regions.length ? `<ul class="pm-items" aria-label="${esc(t("Regions"))}">${regions.map((r, i) => `<li><label class="chk pm-chk"><input type="checkbox" data-rgn="${i}"${r.out ? "" : " checked"} />${esc(t("Region {n}", { n: i + 1 }))}</label><span class="muted" translate="no">${esc(vol(r.v))}</span></li>`).join("")}</ul>` : `<p class="pm-count">${esc(t("No regions yet"))}</p>`;
      return { title: t("Intersect"), body: group(t("Selections"), box("bodies", t("Bodies and surfaces"), list.length ? t("{n} picked", { n: list.length }) : t("All bodies and surfaces")) + clear)
        + group(t("Regions to keep"), rows + (f.exclude.length ? `<button class="btn small" data-k="keepAll">${esc(t("Keep all"))}</button>` : ""))
        + group(t("Options"), chk("merge", f.merge !== false, t("Merge result")) + chk("consume", f.consume, t("Consume surfaces")))
        + `<p class="pm-help muted">${esc(t("Solids and surfaces cut each other into closed regions. Untick the regions to leave out; the rest replace the picked solids."))}</p>` + status };
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
  /** The weldment Cut List dialog; typed item properties go into `PartDoc.cutProps` as one undo step each. */
  cutList() {
    showCutList(this.cutItems(), this.doc, (key, p) => this.store?.change("Cut list properties", d => {
      const all = { ...(d.cutProps ?? {}) };
      if (Object.keys(p).length) all[key] = p; else delete all[key];
      if (Object.keys(all).length) d.cutProps = all; else delete d.cutProps;
    }), s => this.store?.change("Stock bar length", d => {
      if (Object.keys(s).length) d.stock = s; else delete d.stock;
    }));
  }

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
      const line = bezPts(entBezier(e, q => pts.get(q)!), 16);
      for (let i = 0; i + 1 < line.length; i++) seg(line[i], line[i + 1]);
    }
    else if (e.t === "text") for (const line of textPolys(e, pts.get(e.p)!, textPath(sk.ents, e))) for (let i = 0; i + 1 < line.length; i++) seg(line[i], line[i + 1]);
  }
  return out;
}

const S = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/** Whether a feature uses a sketch up (SolidWorks hides it once used). */
/** Whether view face i belongs to one of the bodies `keys` (the worker lists shown faces body by body). */
function bodyFaces(bodies: { key: string; faces?: number }[], keys: string[]): (i: number) => boolean {
  const ranges: [number, number][] = [];
  let at = 0;
  for (const b of bodies) { const n = b.faces ?? 0; if (keys.includes(b.key)) ranges.push([at, at + n]); at += n; }
  return i => ranges.some(([a, z]) => i >= a && i < z);
}

function absorbs(g: Feature, sketch: string): boolean {
  if (g.type === "extrude" || g.type === "revolve" || g.type === "helix" || g.type === "smbase" || g.type === "smbend" || g.type === "smjog" || g.type === "smtab" || g.type === "smmiter" || g.type === "smswept" || g.type === "smvent" || g.type === "smcut") return g.sketch === sketch;
  if (g.type === "smloft") return g.sketch1 === sketch || g.sketch2 === sketch;
  const onPath = (p?: SweepPath) => !!p && "sketch" in p && p.sketch === sketch;
  if (g.type === "sweep") return g.profile === sketch || onPath(g.path) || onPath(g.guide);
  if (g.type === "sweepsurf") return g.profile === sketch || onPath(g.path);
  if (g.type === "curve") return g.sketch === sketch;
  if (g.type === "loft") return g.profiles.includes(sketch) || onPath(g.centerline) || (g.guides ?? []).some(onPath);
  if (g.type === "rib" || g.type === "split" || g.type === "planesurf" || g.type === "extsurf" || g.type === "spattern") return g.sketch === sketch;
  if (g.type === "member") return g.profile === "sketch" && g.psketch === sketch;
  return false;
}

/** A sketch with closed regions (usable as a sweep or loft profile). */
const sketchProfileOk = (s: SketchFeature) => !sketchProfile(s).error;
/** A sketch a Planar Surface can use: closed profiles, or curves that cross or branch but still bound regions to pick (FR-FT-010). */
const sketchRegionsOk = (s: SketchFeature) => sketchProfileOk(s) || sketchRegions(s).length > 0;
/** Features with Selected Contours (FR-FT-010). */
type ContourFeature = ExtrudeFeature | RevolveFeature | PlaneSurfFeature;
/** Fill and outline of picked Selected Contours: orange for material added, the cut preview's yellow for a cut. */
const CONTOUR_BOSS = [0xf08c00, 0xd9480f] as const;
const CONTOUR_CUT = [0xffd43b, 0xe8a800] as const;
const hasContours = (f: Feature): f is ContourFeature => f.type === "extrude" || f.type === "revolve" || f.type === "planesurf";
/** A sketch that is one open chain of curves (a rib line). */
const sketchOpenOk = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && !p.closed; };

/** The sweep flyout's commands (FRS 9.9). */
/** Flyout buttons of the Features tab (FR-UI-011): related commands share one button that shows the last one used. */
/** Commands Ctrl+K leaves out while a sketch is open (the rest exit the sketch and start on it). */
const FROM_SKETCH_SKIP = new Set(["sketch", "import", "save", "step", "filter", "undo", "redo", "smflat", "smdxf", "smprops"]);

const CM_FLY: Record<string, string[]> = {
  sweep: ["sweep", "loft"],
  sweepcut: ["sweepcut", "loftcut"],
  pattern: ["lpattern", "cpattern", "mirror", "spattern", "tpattern"],
  plane: ["plane", "axis", "point", "csys", "extrefs"],
  curves: ["helix", "sketch3d", "xyzcurve", "compcurve", "projcurve", "split"],
  bodies: ["import", "heal", "combine", "indent", "intersect", "bsplit", "movebody", "delbody", "scale"],
  direct: ["moveface", "delface", "recall", "recognize", "recblend", "recext"],
};

const P3_TOOLS = (): [string, string, string][] => [
  ["sweep", t("Sweep"), t("Swept boss: a profile (or a circle) along a path")],
  ["sweepcut", t("Cut-Sweep"), t("Swept cut: removes a profile moved along a path")],
  ["loft", t("Loft"), t("Lofted boss: through two or more profiles")],
  ["loftcut", t("Cut-Loft"), t("Lofted cut: removes material through two or more profiles")],
  ["helix", t("Helix/Spiral"), t("Helix: a curve round a sketch circle, for springs and threads")],
  ["sketch3d", t("3D Sketch"), t("3D sketch: lines and splines in space, for sweep paths")],
  ["xyzcurve", t("Curve Through XYZ Points"), t("3D curve through points typed in or read from a CSV file")],
  ["compcurve", t("Composite Curve"), t("Composite curve: model edges joined into one curve")],
  ["projcurve", t("Projected Curve"), t("Projected curve: a sketch projected onto faces")],
  ["rib", t("Rib"), t("Rib: a thin wall from an open sketch line to the body")],
  ["split", t("Split Line"), t("Split line: project a sketch onto faces to split them")],
  ["import", t("Insert body"), t("Insert body: a part, STEP, IGES or BREP file into this part, with check and heal")],
  ["heal", t("Check-Heal"), t("Check and heal: sew gaps, fix faces and close shells into solids, with a before and after report")],
  ["combine", t("Combine"), t("Combine bodies: add, subtract or keep the common part")],
  ["indent", t("Indent"), t("Indent: a body takes the shape of tool bodies pressed into it, with a wall or as a cut")],
  ["intersect", t("Intersect"), t("Intersect: solids and surfaces cut each other into regions; keep the ones you want")],
  ["bsplit", t("Split"), t("Split bodies with a plane into separate bodies")],
  ["movebody", t("Body-Move/Copy"), t("Move or copy bodies: translate and rotate")],
  ["delbody", t("Body-Delete/Keep"), t("Delete bodies, or keep only the picked ones")],
  ["scale", t("Scale"), t("Scale bodies: uniform or per axis, about the centroid or the origin")],
  ["moveface", t("Move Face"), t("Move face: push flat faces out or in along their normals, on any body")],
  ["delface", t("Delete Face"), t("Delete face: remove faces and heal the gap, on any body")],
  ["recall", t("Recognize Features"), t("Recognize features: the body's base, pockets, bosses, holes, fillets and chamfers become features you can edit, in modelling order")],
  ["recognize", t("Recognize Holes"), t("Recognize holes: round holes in the body become Hole features you can edit")],
  ["recblend", t("Recognize Fillets"), t("Recognize fillets and chamfers: the body's fillets and chamfers become Fillet and Chamfer features you can edit")],
  ["recext", t("Recognize Extrudes"), t("Recognize extrudes: pockets and bosses of the body become sketches with Extrude features you can edit")],
];

/** The surface flyout's commands (FRS 9.11). */
type SurfTool = "planesurf" | "extsurf" | "offsurf" | "knit" | "thicken" | "replaceface" | "revsurf" | "loftsurf" | "sweepsurf" | "trimsurf" | "fillsurf" | "extendsurf" | "untrimsurf";
const SURF_TYPES: ReadonlySet<string> = new Set(["planesurf", "extsurf", "offsurf", "knit", "thicken", "replaceface", "revsurf", "loftsurf", "sweepsurf", "trimsurf", "fillsurf", "extendsurf", "untrimsurf"]);
/** The 3D curve commands in Sweep ▾ (FR-FT-085). */
type CurveTool = "xyzcurve" | "compcurve" | "projcurve" | "sketch3d";
/** A sweep path's select value: h:/c:/s: + id. */
const pathKey = (p: SweepPath) => `${"helix" in p ? "h" : "curve" in p ? "c" : "s"}:${pathId(p)}`;
const pathOf = (v: string): SweepPath | null => !v ? null : v.startsWith("h:") ? { helix: v.slice(2) } : v.startsWith("c:") ? { curve: v.slice(2) } : { sketch: v.slice(2) };
const SURF_TOOLS = (): [SurfTool, string, string][] => [
  ["extsurf", t("Extruded Surface"), t("Extruded surface: sketch curves swept into open surfaces")],
  ["revsurf", t("Revolved Surface"), t("Revolved surface: sketch curves turned about a line")],
  ["loftsurf", t("Lofted Surface"), t("Lofted surface: an open surface through profile sketches")],
  ["sweepsurf", t("Swept Surface"), t("Swept surface: sketch curves, open or closed, moved along a path")],
  ["planesurf", t("Planar Surface"), t("Planar surface: a flat surface inside a closed sketch")],
  ["offsurf", t("Offset Surface"), t("Offset surface: copies of faces at a distance")],
  ["fillsurf", t("Filled Surface"), t("Filled surface: a patch across an opening of a surface")],
  ["trimsurf", t("Trim Surface"), t("Trim a surface with a plane or another surface")],
  ["extendsurf", t("Extend Surface"), t("Extend a surface past its edges")],
  ["untrimsurf", t("Untrim Surface"), t("Untrim a surface: back to its natural bounds, or fill its holes")],
  ["knit", t("Knit Surface"), t("Knit surfaces into one, or into a solid when they close a volume")],
  ["thicken", t("Thicken"), t("Thicken a surface into a solid")],
  ["replaceface", t("Replace Face"), t("Replace faces of a solid with a surface")],
];

const ICON_SVG: Record<string, string> = {
  ...SM_ICONS,
  extsurf: S('<path d="M2 12c2-3 4-3 6 0s4 3 6 0"/><path d="M2 7c2-3 4-3 6 0s4 3 6 0"/><path d="M2 7v5M14 7v5"/>'),
  planesurf: S('<path d="M2 11l4-7h8l-4 7z" fill="currentColor" fill-opacity=".2"/>'),
  offsurf: S('<path d="M2 13c3-4 9-4 12 0"/><path d="M2 8c3-4 9-4 12 0" stroke-dasharray="2 1.5"/><path d="M8 10V6"/>'),
  knit: S('<path d="M2 4h5v8H2zM9 4h5v8H9z"/><path d="M7 6h2M7 8h2M7 10h2"/>'),
  revsurf: S('<path d="M8 1v14" stroke-dasharray="2 1.5"/><path d="M12 3c2 3 2 7 0 10M4 3c-2 3-2 7 0 10"/>'),
  loftsurf: S('<path d="M2 13l4-3M14 13l-4-3M2 13h12M6 10h4"/><path d="M5 4h6M5 4l1 6M11 4l-1 6"/>'),
  trimsurf: S('<path d="M2 11l4-7h8l-4 7z"/><path d="M9 2v13" stroke-dasharray="2 1.5"/>'),
  fillsurf: S('<path d="M3 5l5-3 5 3v6l-5 3-5-3z"/><path d="M5 6l3-2 3 2v4l-3 2-3-2z" fill="currentColor" fill-opacity=".3" stroke="none"/>'),
  extendsurf: S('<path d="M2 12l3-6h6l-3 6z"/><path d="M11 6h4M8 12h4l3-6" stroke-dasharray="2 1.5"/>'),
  untrimsurf: S('<path d="M2 12l3-6h9l-3 6z" stroke-dasharray="2 1.5"/><path d="M5 11l2-4h4l-2 4z" fill="currentColor" fill-opacity=".3"/>'),
  intersect: S('<rect x="2" y="3" width="8" height="8"/><rect x="6" y="6" width="8" height="8"/><path d="M6 6h4v5H6z" fill="currentColor" fill-opacity=".35" stroke="none"/>'),
  replaceface: S('<path d="M2 14V7h10v7z"/><path d="M1 6c4-3 9-3 14 0" stroke-dasharray="2 1.5"/><path d="M7 9V5"/>'),
  thicken: S('<path d="M2 9c3-3 9-3 12 0v3c-3-3-9-3-12 0z" fill="currentColor" fill-opacity=".2"/>'),
  sweep: S('<path d="M3 13c0-6 4-10 10-10"/><circle cx="3" cy="13" r="1.8"/><circle cx="13" cy="3" r="1.8"/>'),
  sweepcut: S('<path d="M2 6h12v8H2z"/><path d="M4 12c2-4 5-5 8-5" stroke-dasharray="2 1.5"/>'),
  loft: S('<path d="M3 13h6v-2H3zM9 4h4v3H9z"/><path d="M3 11l6-7M9 11l4-4"/>'),
  loftcut: S('<path d="M2 6h12v8H2z"/><path d="M5 12h3l3-4H9z" fill="currentColor" fill-opacity=".3"/>'),
  import: S('<path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 11v3h10v-3"/>'),
  combine: S('<circle cx="6" cy="8" r="4"/><circle cx="10" cy="8" r="4"/>'),
  indent: S('<path d="M2 7h4v3h4V7h4v4H2z"/><path d="M6 2h4v8H6z" stroke-dasharray="2 1.5"/>'),
  bsplit: S('<path d="M2 4h12v9H2z"/><path d="M9 2l-2 13"/>'),
  movebody: S('<path d="M2 9h6v5H2z"/><path d="M8 9l3-3h3v5l-3 3M9 3h5v5"/>'),
  scale: S('<path d="M2 14V8h6v6z"/><path d="M8 8l6-6M10 2h4v4"/>'),
  delbody: S('<path d="M3 5h10v9H3z"/><path d="M5 7l6 6M11 7l-6 6"/>'),
  moveface: S('<path d="M2 8h9v6H2z"/><path d="M6 8V3M4 5l2-2 2 2"/><path d="M2 8l3-3h9l-3 3M14 5v6l-3 3"/>'),
  heal: S('<path d="M3 13l7-7 3 3-7 7H3z"/><path d="M9 3l4 4M12 2l2 2"/>'),
  recognize: S('<path d="M2 5h12v8H2z"/><circle cx="8" cy="9" r="2.2"/><path d="M5 2l-2 2M11 2l2 2"/>'),
  recblend: S('<path d="M2 13V7a5 5 0 0 1 5-5h7v11z"/><path d="M5 2l-2 2M11 2l2 2"/>'),
  recall: S('<path d="M2 7h12v7H2z"/><path d="M6 7V4h4v3"/><circle cx="5" cy="10.5" r="1.3"/><path d="M8 1.5l1 1.6 1.8.3-1.3 1.3.3 1.8L8 5.6 6.2 6.5l.3-1.8-1.3-1.3 1.8-.3z"/>'),
  recext: S('<path d="M2 6h12v7H2z"/><path d="M6 6V3h4v3"/><path d="M5 1l-2 2M11 1l2 2"/>'),
  delface: S('<path d="M2 6h9v8H2z"/><path d="M2 6l3-3h9l-3 3M14 3v8l-3 3"/><path d="M12 1l3 3M15 1l-3 3"/>'),
  split: S('<path d="M2 4h12v9H2z"/><path d="M8 1v14" stroke-dasharray="2 1.5"/>'),
  rib: S('<path d="M2 14h12M3 14V3"/><path d="M3 5l9 9" stroke-width="2.6"/>'),
  sketch3d: S('<path d="M2 12l5 2 7-4M7 14V7l7-4M7 7L2 5"/><path d="M2 12V5" stroke-dasharray="1.5 1.5"/>'),
  xyzcurve: S('<path d="M2 13c3-1 3-7 6-7s3 5 6 3"/><circle cx="2" cy="13" r="1"/><circle cx="8" cy="6" r="1"/><circle cx="14" cy="9" r="1"/>'),
  compcurve: S('<path d="M2 12h5l3-6h4"/><circle cx="7" cy="12" r="1"/><circle cx="10" cy="6" r="1"/>'),
  projcurve: S('<path d="M3 3h10M5 3v6M11 3v6" stroke-dasharray="1.5 1.5"/><path d="M2 13c2-3 4-3 6-3s4 0 6 3"/>'),
  sweepsurf: S('<path d="M2 12c3 0 4-8 8-8h4"/><path d="M2 12l3 2M14 4l-2 3M5 14c3 0 4-7 7-7"/>'),
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
  spattern: S('<path d="M2 13 14 3" stroke-dasharray="1.5 1.5"/><rect x="1" y="11" width="3.5" height="3.5"/><rect x="6.25" y="6.25" width="3.5" height="3.5" opacity=".7"/><rect x="11.5" y="1.5" width="3.5" height="3.5" opacity=".45"/>'),
  tpattern: S('<path d="M1.5 2.5h13v11h-13zM1.5 6h13M1.5 9.5h13M6 2.5v11"/>'),
  cpattern: S('<circle cx="8" cy="8" r="1"/><circle cx="8" cy="3" r="1.6"/><circle cx="12.5" cy="10.5" r="1.6" opacity=".7"/><circle cx="3.5" cy="10.5" r="1.6" opacity=".45"/>'),
  filter: S('<path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"/>'),
  "sel:faces": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" fill="currentColor" fill-opacity=".35"/>'),
  "sel:edges": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" opacity=".35"/><path d="M8 8.5v6" stroke-width="2.4"/>'),
  "sel:vertices": S('<path d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3z" opacity=".35"/><circle cx="8" cy="8.5" r="2" fill="currentColor"/>'),
  skdynmirror: S('<path d="M8 1.5v13" stroke-dasharray="1.6 1.4"/><path d="M2.5 12 6 4"/><path d="M13.5 12 10 4" opacity=".55"/><circle cx="6" cy="4" r="1.1" fill="currentColor"/>'),
  skmirror: S('<path d="M8 1.5v13" stroke-dasharray="1.6 1.4"/><path d="M6 4 2.5 12H6z"/><path d="M10 4l3.5 8H10z" opacity=".55"/>'),
  sklpat: S('<rect x="1.5" y="6" width="3" height="4"/><rect x="6.5" y="6" width="3" height="4" opacity=".6"/><rect x="11.5" y="6" width="3" height="4" opacity=".35"/>'),
  skcpat: S('<circle cx="8" cy="8" r="1"/><circle cx="8" cy="2.8" r="1.6"/><circle cx="12.5" cy="10.6" r="1.6" opacity=".6"/><circle cx="3.5" cy="10.6" r="1.6" opacity=".35"/>'),
  skmove: S('<path d="M8 1.5v13M1.5 8h13"/><path d="M6 3.5 8 1.5l2 2M6 12.5l2 2 2-2M3.5 6 1.5 8l2 2M12.5 6l2 2-2 2"/>'),
  skrot: S('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M12 1.8v2.9H9.1"/>'),
  skscale: S('<rect x="1.5" y="8.5" width="6" height="6"/><rect x="1.5" y="1.5" width="13" height="13" stroke-dasharray="1.6 1.4"/><path d="M8.5 7.5l4-4M9.5 3.5h3v3"/>'),
  skstretch: S('<path d="M1.5 3.5h6l3 4.5-3 4.5h-6z" stroke-dasharray="1.6 1.4"/><path d="M1.5 3.5h9l3 4.5-3 4.5h-9z"/><path d="M9 8h5M12 6l2 2-2 2"/>'),
  sksec: S('<path d="M2 12 8 9l6 3-6 3z"/><path d="M8 1.5v7.5M3 6.5l5-2.5 5 2.5"/>'),
  skdxf: S('<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/><path d="M5.5 9.5h5M5.5 12h5"/>'),
  cons: S('<path d="M2 14 14 2" stroke-dasharray="2.2 1.8"/>'),
  "sk:select": S('<path d="M3 2l9 5-4 1.2L6.5 13z"/>'),
  "sk:line": S('<path d="M3 13 13 3"/><circle cx="3" cy="13" r="1.3" fill="currentColor"/><circle cx="13" cy="3" r="1.3" fill="currentColor"/>'),
  "sk:rect": S('<path d="M2.5 4h11v8h-11z"/>'),
  "sk:crect": S('<path d="M2.5 4h11v8h-11z"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:circle": S('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
  "sk:arc": S('<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><circle cx="8" cy="11" r=".9" fill="currentColor"/>'),
  "sk:point": S('<circle cx="8" cy="8" r="2" fill="currentColor"/>'),
  "sk:text": S('<path d="M3 13L8 3l5 10M5 9h6"/>'),
  axis: S('<path d="M2 14 14 2" stroke-dasharray="4 1.5 1 1.5"/>'),
  point: S('<path d="M8 3v10M3 8h10M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  csys: S('<path d="M3 13h10M3 13V3M3 13l-1.5 1.5"/><path d="M11 11l2 2-2 2M1.5 5 3 3l1.5 2"/>'),
  plane: S('<path d="M1.5 11 5 4h9.5L11 11z"/><path d="M8 7.5v-6M6.5 3 8 1.5 9.5 3" />'),
  "sk:pcircle": S('<circle cx="8" cy="8" r="4.5"/><path d="M1.5 3.5h13M1.5 12.5h13M3.5 1.5v13"/>'),
  "sk:circle3": S('<circle cx="8" cy="8" r="5.5"/><circle cx="2.5" cy="8" r="1.1" fill="currentColor"/><circle cx="12" cy="4.3" r="1.1" fill="currentColor"/><circle cx="11" cy="12.6" r="1.1" fill="currentColor"/>'),
  "sk:tarc": S('<path d="M1.5 12.5h6"/><path d="M7.5 12.5a5 5 0 0 0 5-5"/><circle cx="7.5" cy="12.5" r="1.1" fill="currentColor"/><circle cx="12.5" cy="7.5" r="1.1" fill="currentColor"/>'),
  "sk:cline": S('<path d="M2 14 14 2" stroke-dasharray="3 1.5 1 1.5"/>'),
  "sk:mline": S('<path d="M2 12 14 4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>'),
  "sk:arc3": S('<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><circle cx="2.5" cy="11" r="1.1" fill="currentColor"/><circle cx="13.5" cy="11" r="1.1" fill="currentColor"/><circle cx="8" cy="5.5" r="1.1" fill="currentColor"/>'),
  "sk:polygon": S('<path d="M8 2 13.7 6.1 11.5 12.9h-7L2.3 6.1z"/>'),
  "sk:trim": S('<path d="M2 13 13 2" stroke-dasharray="2 2"/><path d="M2 8h12"/><circle cx="5" cy="11" r="1.6"/><circle cx="11" cy="11" r="1.6"/><path d="M6.2 9.9 9.8 6M9.8 9.9 6.2 6"/>'),
  "sk:spline": S('<path d="M2 12c2.5-8 5-8 6-4s3.5 4 6-4"/><circle cx="2" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="14" cy="4" r="1" fill="currentColor"/>'),
  "sk:ellipse": S('<ellipse cx="8" cy="8" rx="6" ry="3.5" transform="rotate(-25 8 8)"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/>'),
  "sk:sspline": S('<path d="M2 13 5 3 11 13 14 3" stroke-dasharray="1.2 1.4"/><path d="M2 13C4 6 7 6 8 8S12 10 14 3"/>'),
  "sk:parabola": S('<path d="M2.5 2.5Q8 20 13.5 2.5"/><circle cx="8" cy="7" r="0.9" fill="currentColor"/>'),
  "sk:conic": S('<path d="M2.5 13Q3 3 13 2.5"/><path d="M2.5 13 2.5 2.5 13 2.5" stroke-dasharray="1.2 1.4"/>'),
  "sk:eqn": S('<path d="M1.5 9c2-5 3.5-5 5 0s3 5 5 0 2.5-3 3-3"/><path d="M1.5 14.5h13M1.5 1.5v13" stroke-width="1"/>'),
  "sk:earc": S('<path d="M2.6 10.5A6 3.5 -25 0 1 13.4 5.5"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><path d="M8 8 13.4 5.5" stroke-dasharray="1.2 1.4"/>'),
  "sk:slot": S('<path d="M5 4.5h6a3.5 3.5 0 0 1 0 7H5a3.5 3.5 0 0 1 0-7z"/><path d="M5 8h6" stroke-dasharray="1.5 1.5"/>'),
  "sk:rect3": S('<path d="M3 9.5 9.5 3l3.5 3.5L6.5 13z"/><circle cx="3" cy="9.5" r="1.1" fill="currentColor"/><circle cx="9.5" cy="3" r="1.1" fill="currentColor"/><circle cx="13" cy="6.5" r="1.1" fill="currentColor"/>'),
  "sk:crect3": S('<path d="M3 9.5 9.5 3l3.5 3.5L6.5 13z"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="11.25" cy="4.75" r="1.1" fill="currentColor"/>'),
  "sk:pgram": S('<path d="M5 4h9l-3 8H2z"/>'),
  "sk:cslot": S('<path d="M5 4.5h6a3.5 3.5 0 0 1 0 7H5a3.5 3.5 0 0 1 0-7z"/><path d="M5 8h6" stroke-dasharray="1.5 1.5"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/>'),
  "sk:aslot": S('<path d="M2.5 12.5a5.5 5.5 0 0 1 11 0M5.5 12.5a2.5 2.5 0 0 1 5 0M2.5 12.5a1.5 1.5 0 0 0 3 0M10.5 12.5a1.5 1.5 0 0 0 3 0"/><circle cx="8" cy="12.5" r="1" fill="currentColor"/>'),
  "sk:aslot3": S('<path d="M2.5 12.5a5.5 5.5 0 0 1 11 0M5.5 12.5a2.5 2.5 0 0 1 5 0M2.5 12.5a1.5 1.5 0 0 0 3 0M10.5 12.5a1.5 1.5 0 0 0 3 0"/><circle cx="4" cy="12.5" r="1" fill="currentColor"/><circle cx="12" cy="12.5" r="1" fill="currentColor"/><circle cx="8" cy="5.5" r="1" fill="currentColor"/>'),
  "sk:extend": S('<path d="M2 12 9 5"/><path d="M9 5l3.5-3.5" stroke-dasharray="1.5 1.5"/><path d="M10 14 14 2"/>'),
  "sk:split": S('<path d="M2 12 7 7M9 5l5-5"/><circle cx="8" cy="6" r="1.4"/>'),
  "sk:segment": S('<path d="M1.5 12.5l13-9"/><circle cx="5.8" cy="9.5" r="1.2" fill="currentColor"/><circle cx="10.2" cy="6.5" r="1.2" fill="currentColor"/><path d="M1.5 14.5v-2M14.5 5.5v-2"/>'),
  "sk:jog": S('<path d="M1.5 11.5h4v-6h5v6h4"/><circle cx="5.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="11.5" r="1" fill="currentColor"/>'),
  "sk:chamfer": S('<path d="M2.5 13.5V7l4.5-4.5h6.5"/>'),
  "sk:offset": S('<path d="M2.5 13.5V5.5a3 3 0 0 1 3-3h8"/><path d="M6 13.5V8a2 2 0 0 1 2-2h5.5" stroke-dasharray="1.5 1.5"/>'),
  "sk:intersect": S('<path d="M2 11.5 8 8.5l6 3" opacity=".5"/><path d="M2 6h12" /><path d="M4.5 3.5v5M11.5 3.5v5" opacity=".5"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="11.5" cy="6" r="1.2" fill="currentColor"/>'),
  "sk:convert": S('<path d="M3 11 8 3l5 8z" opacity=".5"/><path d="M3 13.5h10"/><path d="M8 7v4m-2-2 2 2 2-2"/>'),
  "sk:fillet": S('<path d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5"/><path d="M2.5 2.5h3M2.5 2.5v3" stroke-dasharray="1.5 1.5"/>'),
  "sk:dim": S('<path d="M2.5 4v8M13.5 4v8M2.5 8h11M5 6 2.5 8 5 10M11 6l2.5 2L11 10"/>'),
  "sk:hord": S('<path d="M3 13V4M8 13V4M13 13V4"/><path d="M2 13h12" opacity=".5"/><path d="M2.5 2.5h1M7 2.5h2M12 2.5h2"/>'),
  "sk:vord": S('<path d="M3 3h9M3 8h9M3 13h9"/><path d="M3 2v12" opacity=".5"/><path d="M13.5 2.5v1M13.5 7v2M13.5 12v2"/>'),
};
Object.assign(ICON_SVG, WELD_ICONS);
