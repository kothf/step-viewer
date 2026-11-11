// The sketcher (FRS section 8): draws a sketch on its plane over the model,
// creates entities with snapping and automatic relations, places dimensions,
// applies relations, and drags geometry through the solver.
//
// The editor works on a copy of the sketch; every finished operation is handed
// to the host with a label (one undo step each) and solved again.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import type { ArcCond, EdgeRef, Frame, RelKind, SkDim, SkEnt, SketchFeature, SketchPicture, SkRel, TextFont, TextOutline, V2 } from "../model/types";
import { applyExt, piercePoint, projectEdge, uvOf, type ExtGeo, type ModelEdge } from "./external";
import { renameIn } from "../model/params";
export { refPts } from "./define";
import { ORIGIN, curveJoint, freeDirections, measureDim, solve, tryAdd, type SolveResult } from "./solver";
import { uid } from "../model/doc";
import { fullyDefineSketch, nextDimName, refPts } from "./define";
import { cutTriangles, thin } from "./intersect";
import { evaluate, ExprError, isPlain, type VarValue } from "../model/expr";
import type { DxfShape } from "./dxf";
import { t } from "../i18n";
import { ModifyBox } from "../modifyBox";
import { bezPts, nearestOn, splineBezier } from "./spline";
import { ellDist, earcDist, ellLocal, ellOf, ellParam, ellPt, ellPts, ellSweep, type Ell } from "./ellipse";
import { textBox, textKey, textOutline, textPolys } from "./text";
import { inPolygon, textPath } from "./profile";
import { quadCorners, perimeterCircle, type PerimItem } from "./shapes";
import { conicBezier, conicShoulder, entBezier, eqBezier, hasControl, parabolaFrom, rhoAt, styleBezier, type CurveEq } from "./conic";
import { DEFAULT_SNAPS, SNAP_KINDS, arcCurve, intersections, perpendicularFoot, quadrants, tangentPoints, type SnapCurve, type SnapKind } from "./snaps";
import { gridLines, gridStep, snapToGrid } from "./grid";
import { beginEditBlock, explodeInsert, finishEditBlock, insertBlock, insertEnts, insertOf, makeBlock, moveInsert, removeInserts, renameBlock } from "./blocks";
import type { BlockInsert, SketchBlock } from "../model/types";
import { stepFor } from "../prefs";
import { arcSlotCorners, arcSlotEnts, arcSlotHalfWidth, arcSlotOutline, centreArcAxis, threePointArcAxis, type ArcSlotAxis } from "./slots";

/** Points an entity refers to (its ends, centre, axis points). */
/** A conic's or equation curve's own fields, for a copy (a mirror image of an equation curve flips it). */
function splineExtra(e: SkEnt & { t: "spline" }, mirror = false) {
  if (!e.kind) return {};
  return { kind: e.kind, ...(e.rho !== undefined ? { rho: e.rho } : {}), ...(e.eq ? { eq: { ...e.eq, flip: mirror ? !e.eq.flip : e.eq.flip } } : {}) };
}

function arcPts(c: V2, r: number, a0: number, a1: number, n = 48): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) { const tt = a0 + ((a1 - a0) * i) / n; out.push([c[0] + r * Math.cos(tt), c[1] + r * Math.sin(tt)]); }
  return out;
}

/** Sketch pattern settings (FR-SK-038): spacing in mm, angles in radians. */
export type SketchPattern =
  | { kind: "linear"; n: number; d: number; angle: number; n2: number; d2: number; angle2: number }
  | { kind: "circular"; n: number; total: number; c: V2; centre: string | null; equal: boolean }
  /** Move / copy, rotate and scale entities (FR-SK-039): one transform, applied to the selection or to copies. */
  | { kind: "move"; dx: number; dy: number; copy: boolean; keep: boolean }
  | { kind: "rotate"; c: V2; centre: string | null; angle: number; copy: boolean; keep: boolean }
  | { kind: "scale"; c: V2; centre: string | null; k: number; copy: boolean; keep: boolean }
  /** Stretch entities (FR-SK-039): the selected points (and the points of selected curves) move, curves ending on them stretch. */
  | { kind: "stretch"; dx: number; dy: number };

/** Tools whose new entities get dimensions and the Modify box when Add dimensions is on (slots have their own switch). */
const AUTO_DIM_TOOLS = new Set<string>(["line", "cline", "mline", "tarc", "rect", "crect", "rect3", "crect3", "pgram", "circle", "circle3", "pcircle", "arc", "arc3", "polygon"]);

export type SkTool = "select" | "line" | "cline" | "mline" | "rect" | "crect" | "rect3" | "crect3" | "pgram" | "circle" | "circle3" | "pcircle" | "arc" | "arc3" | "tarc" | "polygon" | "slot" | "cslot" | "aslot" | "aslot3" | "ellipse" | "earc" | "spline" | "sspline" | "conic" | "parabola" | "eqn" | "point" | "text" | "trim" | "extend" | "split" | "jog" | "segment" | "fillet" | "chamfer" | "offset" | "convert" | "intersect" | "dim" | "hord" | "vord";

export interface SketchHost {
  viewer: Viewer;
  /** Element the dimension labels and inputs are placed in (over the canvas). */
  layer: HTMLElement;
  commit(label: string, sk: SketchFeature): void;
  status(text: string): void;
  toast(msg: string, kind?: "info" | "warn" | "error"): void;
  /** Display unit factor (mm per unit) and name, decimals. */
  unit(): { mm: number; name: string; decimals: number };
  /** Global variables and dimensions by name, for expressions typed in dimensions. */
  vars?(): Record<string, VarValue>;
  onSelection?(ids: string[]): void;
  /** Convert entities: the model edges under the pointer (an edge, or every edge of a face), in world coordinates. */
  modelEdges?(e: PointerEvent): ModelEdge[] | null;
  /** The model face under the pointer: its triangles (9 numbers each, world mm) and kind (intersection curve). */
  modelFace?(e: PointerEvent): { tri: ArrayLike<number>; type: string; axis?: [number, number, number]; center?: [number, number, number]; radius?: number } | null;
  /** A persistent reference to a shown model edge, so a converted curve follows it (FR-SK-064). */
  edgeRef?(ed: ModelEdge): EdgeRef | null;
  /** Model edges at the pointer (the one under it, then those meeting at the snapped vertex or centre), for snapping while drawing. */
  modelEdge?(e: PointerEvent): ModelEdge[];
  /** Dimension names typed by the user: rewrite "old@Sketch" in the other features' expressions (FR-SK-065). */
  renamedDim?(from: string, to: string): void;
}

export type { ModelEdge };

const SNAP_PX = 9;
/** Pixels within which the cursor lines up with a point's x or y (FR-SK-042). */
const ALIGN_PX = 6;
const HV_TOL = (3 * Math.PI) / 180;

type Hit = { id: string; kind: "point" | "line" | "circle" | "arc" | "ellipse" | "spline" | "origin" | "dim" | "rel"; d: number };
/** A snapped cursor point: an existing point, a curve, horizontal/vertical or an inferred relation (FR-SK-052). */
type Snap = { p: V2; id: string | null; curve: string | null; hv: "horizontal" | "vertical" | null; rel?: { t: "perpendicular" | "parallel" | "tangent"; ref: string } };

/** Under-defined analysis arrows (FR-SLV-010). */
const FREE_ARROW = 0xf08c00;
const COLORS = {
  light: { free: 0x1d4ed8, defined: 0x111827, cons: 0x7c8594, sel: 0xf08c00, hover: 0xf59f00, bad: 0xd32f2f, dim: 0x334155, pre: 0x2f9e44 },
  dark: { free: 0x6ea8ff, defined: 0xe8ecf2, cons: 0x8a94a6, sel: 0xffa94d, hover: 0xffc078, bad: 0xff6b5e, dim: 0xcbd5e1, pre: 0x51cf66 },
};
/** Curves whose model edge is gone (FR-SK-064): olive brown, as dangling items in CAD apps. */
const DANGLING = { light: 0x8f6a00, dark: 0xd8b13a };

const REL_GLYPH: Record<RelKind, string> = {
  coincident: "◉", horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "⫽", equal: "=",
  tangent: "T", concentric: "◎", midpoint: "M", fix: "⚓", onCurve: "◦", symmetric: "⇹", intersection: "✕", curvature: "κ", pierce: "⊕", offset: "⇉",
};
export const REL_NAME: Record<RelKind, string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular",
  collinear: "Collinear", equal: "Equal", tangent: "Tangent", concentric: "Concentric", midpoint: "Midpoint", fix: "Fix",
  onCurve: "On curve", symmetric: "Symmetric", intersection: "Intersection", curvature: "Equal curvature", pierce: "Pierce", offset: "Offset",
};

/** A relation's name: a fix that follows a model edge is "On edge". */
export const relName = (r: SkRel) => (r.ext ? "On edge" : REL_NAME[r.t]);

/** Dimension names: a letter, then letters, digits and underscores (usable as "D1@Sketch1" in expressions). */
export const validDimName = (s: string) => /^[a-z_а-я][\wа-я]*$/i.test(s);

export class SketchEditor {
  sk: SketchFeature;
  tool: SkTool = "select";
  /** Polygon sides (3–64) and the sketch fillet radius (mm), set in the panel. */
  polySides = 6;
  /** Text tool settings (FR-SK-020): what a click places; the panel edits a selected text's own. */
  textOpts: { text: string; h: number; font: TextFont; bold: boolean; italic: boolean } = { text: "Text", h: 5, font: "sans", bold: false, italic: false };
  filletRadius = 2;
  /** Sketch chamfer distance and offset distance (mm), set in the panel. */
  chamferDist = 2;
  /** Segment tool (FR-SK-032): how many equal pieces, and whether they become points on the curve or separate curves. */
  segCount = 4;
  segMode: "points" | "segments" = "points";
  offsetDist = 5;
  /** Offset options (FR-SK-034): both sides, end caps for an open chain offset both ways, and linked (offset relations + one dimension). */
  offsetBoth = false;
  offsetCap: "none" | "arc" | "line" = "arc";
  offsetLink = true;
  /** Offset preview under the cursor (polylines in sketch coordinates). */
  private offsetPreview: V2[][] = [];
  selection = new Set<string>();
  /** Free-motion arrows drawn for the selection (FR-SLV-010); read by the tests. */
  freeArrows = 0;
  info: SolveResult;
  private group = new THREE.Group();
  private hover: Hit | null = null;
  /** In-progress entity: its points so far, and the live cursor point. */
  /** The last pointer event, for model snapping (the snap works in sketch coordinates). */
  private lastEv: PointerEvent | null = null;
  /** Model snapping while drawing (CAD app inferencing to model geometry); off with the panel switch. */
  modelSnap = true;
  /** Centre-point arc: how far (radians, + counter-clockwise) the mouse has gone round the centre since the start point. */
  private arcTurn = 0;
  private arcLast: number | null = null;
  private trackArc(p: V2) {
    const c = this.draft.pts[0];
    if (!c || this.arcLast == null) return;
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    let d = a - this.arcLast;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d <= -Math.PI) d += Math.PI * 2;
    this.arcTurn += d;
    this.arcLast = a;
  }

  private draft: { pts: V2[]; ids: (string | null)[]; cursor: V2 | null; snap: string | null; chainStart?: string; snapCurve?: string | null; snapOrigin?: boolean; curves?: (string | null)[]; hoverCurve?: string | null;
    /** Line tool (FR-SK-011): the next click makes a tangent arc; `prev` = the chain's last curve; `back` = 0 just clicked, 1 moved away, 2 came back to the end point. */
    arc?: boolean; prev?: string; back?: 0 | 1 | 2 } = { pts: [], ids: [], cursor: null, snap: null };
  /** `side`: where a circle/arc was Shift+clicked, so the distance takes its near or far side (FR-SK-060). */
  private dimDraft: { picks: Hit[]; dim: SkDim | null; lock?: boolean; side?: Map<string, V2> } = { picks: [], dim: null };
  /** Instant 2D (FR-SK-067): the round handle on a selected driving dimension and its drag. */
  private grip: HTMLButtonElement | null = null;
  /** The arrow flip dot of the selected dimension (FR-SK-068). */
  private adot: HTMLButtonElement | null = null;
  private gripDrag: { id: string; base: SketchFeature; baseInfo: SolveResult; v0: number; p0: V2; dir: V2; k: number; from: V2; step: number; moved: boolean } | null = null;
  /** Ordinate dimensioning: the base picked first, then the row the values go on. */
  private ordDraft: { base: string | null; row: number | null } = { base: null, row: null };
  /** Box selection in progress (sketch coordinates), started at screen x0. */
  private box: { a: V2; b: V2; x0: number; base: Set<string> } | null = null;
  /**
   * A drag of sketch geometry. `point` = the one point dragged (drag to merge, FR-SK-043; `target` = what it would
   * join on release); `copy` = Ctrl+drag copies the selection (FR-SK-044), `untoggle` = a Ctrl+click without a move
   * deselects it.
   */
  private drag: { ids: string[]; start: V2; orig: Map<string, V2>; circle?: string; moved: boolean; base: SketchFeature; point?: string; target?: { t: "coincident" | "onCurve"; id: string } | null; copy?: boolean; untoggle?: string | null; made?: string[]; ins?: { id: string; x: number; y: number } } | null = null;
  /** The cursor in sketch coordinates, shown in the status bar (FR-SK-047). */
  private cursorUV: V2 | null = null;
  private labels = new Map<string, HTMLElement>();
  /** A dimension value or dangling relation glyph being dragged (FR-SK-066, FR-SK-064). */
  private labelDrag: { id: string; x0: number; y0: number; moved: boolean; base: SketchFeature } | null = null;
  /** Re-attach: the dangling On edge relation the next model edge click attaches (FR-SK-064). */
  reattaching: string | null = null;
  /** Pierce (FR-SK-051): the point the next model edge click pierces. */
  piercing: string | null = null;
  /** Show dimension names with their values (FR-SK-065). */
  showNames = false;
  /** Automatic relations while drawing (FR-SK-052); holding Ctrl suppresses them for one move or click. */
  autoRels = true;
  /** Relation glyphs next to the entities (FR-SK-053). */
  showRels = true;
  /** Snap types on while drawing (FR-SK-046 preferences, localStorage `mc:skSnaps`). */
  snaps = new Set<SnapKind>(DEFAULT_SNAPS);
  /** Sketch grid (FR-SK-041): shown, points snap to its nodes, and its spacing in mm (0 = automatic from the zoom). */
  grid = false;
  gridSnap = false;
  gridSpacing = 0;
  private gridObj: THREE.LineSegments | null = null;
  private gridKey = "";
  /** The spacing the grid was last drawn with (what Snap to grid rounds to). */
  gridAt = 0;
  /** Quick snap (FR-SK-046): the one snap type the next point uses; cleared once the point is placed. */
  quickSnap: SnapKind | null = null;
  /** Called when the quick snap changes (set, used or cancelled), so the bar can show it. */
  onQuickSnap: (() => void) | null = null;
  /** The relation glyph under the pointer: its entities are highlighted (FR-SK-053). */
  private hoverRel: string | null = null;
  private relHot = new Set<string>();
  /** The last sketch line hovered while drawing a line: parallel/perpendicular inference (FR-SK-052). */
  private inferLine: string | null = null;
  /** The glyph beside the cursor naming the relation the next click adds (FR-SK-052). */
  private inferEl: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private marker: THREE.Mesh;
  /** Dotted lines from the points the cursor lines up with (FR-SK-042), drawn while placing. */
  private alignObj: THREE.LineSegments | null = null;
  /** The points the last snap lined up with: [source, snapped point]. */
  aligned: [V2, V2][] = [];
  /** Points the cursor passed over while drawing ("woken", as in other CAD apps): the ones alignment looks at. */
  private woke: V2[] = [];
  private dark = false;

  constructor(private host: SketchHost, sk: SketchFeature, public frame: Frame) {
    this.sk = structuredClone(sk);
    this.lastCommitted = structuredClone(sk);
    this.info = solve(this.sk);
    this.group.renderOrder = 3000;
    host.viewer.scene.add(this.group);
    const ring = new THREE.RingGeometry(0.55, 1, 20);
    this.marker = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xf59f00, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    this.marker.renderOrder = 3100;
    this.marker.visible = false;
    host.viewer.scene.add(this.marker);
    host.viewer.onRender(() => this.placeLabels());
    this.render();
  }

  dispose() {
    this.closeInput(false);
    this.host.viewer.scene.remove(this.group, this.marker);
    this.dropGrid();
    for (const id of [...this.picObjs.keys()]) this.dropPicture(id);
    this.showAlign([]);
    this.clearGroup();
    for (const l of this.labels.values()) l.remove();
    this.labels.clear();
    this.grip = null;
    this.adot = null;
    this.gripDrag = null;
    this.host.layer.replaceChildren();
    this.host.viewer.invalidate();
    this.disposed = true;
  }
  private disposed = false;

  /** The stored sketch changed (undo/redo): take it over. */
  setSketch(sk: SketchFeature, frame: Frame) {
    this.sk = structuredClone(sk);
    this.lastCommitted = structuredClone(sk);
    this.frame = frame;
    for (const id of [...this.selection]) if (!this.has(id)) this.selection.delete(id);
    this.info = solve(this.sk);
    this.render();
  }

  setTool(tool: SkTool) {
    this.closeInput(false);
    this.reattaching = null;
    this.piercing = null;
    this.showAlign([]);
    this.woke = [];
    this.tool = tool;
    this.inferLine = null;
    this.setQuickSnap(null);
    this.showInfer(null);
    this.draft = { pts: [], ids: [], cursor: null, snap: null };
    this.dimDraft = { picks: [], dim: null };
    this.ordDraft = { base: null, row: null };
    if (tool !== "select" && tool !== "dim") this.selection.clear();
    this.render();
    this.statusHint();
  }

  /** Something is in progress (drag, drawing, value box): the stored sketch must not replace it now. */
  get busy() { return !!(this.drag || this.labelDrag || this.gripDrag || this.box || this.input || this.draft.pts.length || this.dimDraft.picks.length); }

  private has(id: string) {
    return id === ORIGIN || this.sk.ents.some(e => e.id === id) || this.sk.rels.some(r => r.id === id) || this.sk.dims.some(d => d.id === id);
  }

  // ---------- coordinates ----------

  private w(p: V2): THREE.Vector3 {
    const f = this.frame;
    return new THREE.Vector3(f.o[0] + f.x[0] * p[0] + f.y[0] * p[1], f.o[1] + f.x[1] * p[0] + f.y[1] * p[1], f.o[2] + f.x[2] * p[0] + f.y[2] * p[1]);
  }

  private uv(e: PointerEvent): V2 | null {
    const v = this.host.viewer, r = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, v.camera);
    const f = this.frame;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...f.n), new THREE.Vector3(...f.o));
    const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    hit.sub(new THREE.Vector3(...f.o));
    return [hit.dot(new THREE.Vector3(...f.x)), hit.dot(new THREE.Vector3(...f.y))];
  }

  private screen(p: V2): V2 {
    const v = this.host.viewer;
    const s = this.w(p).project(v.camera);
    return [((s.x + 1) / 2) * v.size.x, ((1 - s.y) / 2) * v.size.y];
  }

  /** Sketch units per screen pixel near a point. */
  private px(p: V2) { return this.host.viewer.pxWorld(this.w(p)); }

  private pt(id: string): V2 {
    if (id === ORIGIN) return [0, 0];
    const e = this.sk.ents.find(x => x.id === id);
    return e && e.t === "point" ? [e.x, e.y] : [0, 0];
  }
  private ent(id: string) { return this.sk.ents.find(e => e.id === id); }
  private ell(e: SkEnt & { t: "ellipse" }, mv: (q: V2) => V2 = q => q): Ell { return ellOf(mv(this.pt(e.c)), mv(this.pt(e.a)), mv(this.pt(e.b))); }
  /** Polyline of a spline, optionally moved point by point. */
  private splineLine(e: SkEnt & { t: "spline" }, mv: (q: V2) => V2 = q => q): V2[] {
    return bezPts(entBezier(e, q => mv(this.pt(q))), 16);
  }
  /** Polyline of an ellipse or elliptical arc, optionally moved point by point. */
  private ellLine(e: SkEnt & { t: "ellipse" }, mv: (q: V2) => V2 = q => q): V2[] {
    const E = this.ell(e, mv);
    if (!e.p0 || !e.p1) return ellPts(E);
    const t0 = ellParam(E, mv(this.pt(e.p0)));
    return ellPts(E, t0, ellSweep(t0, ellParam(E, mv(this.pt(e.p1)))), 64);
  }

  // ---------- hit testing ----------

  private hits(p: V2, opts: { points?: boolean; curves?: boolean; exclude?: Set<string> } = {}): Hit[] {
    const tol = this.px(p) * SNAP_PX;
    const out: Hit[] = [];
    const ex = opts.exclude ?? new Set();
    if (opts.points !== false) {
      const d0 = Math.hypot(p[0], p[1]);
      if (d0 < tol) out.push({ id: ORIGIN, kind: "origin", d: d0 * 0.9 });
      for (const e of this.sk.ents) if (e.t === "point" && !ex.has(e.id)) {
        const d = Math.hypot(e.x - p[0], e.y - p[1]);
        if (d < tol) out.push({ id: e.id, kind: "point", d: d * 0.9 });
      }
    }
    if (opts.curves !== false) for (const e of this.sk.ents) {
      if (ex.has(e.id)) continue;
      let d = Infinity;
      if (e.t === "line") d = segDist(p, this.pt(e.a), this.pt(e.b));
      else if (e.t === "circle") d = Math.abs(Math.hypot(p[0] - this.pt(e.c)[0], p[1] - this.pt(e.c)[1]) - e.r);
      else if (e.t === "arc") d = arcDist(p, this.pt(e.c), this.pt(e.a), this.pt(e.b));
      else if (e.t === "spline") d = nearestOn(this.splineLine(e), p).d;
      else if (e.t === "ellipse") d = e.p0 && e.p1 ? earcDist(this.ell(e), this.pt(e.p0), this.pt(e.p1), p) : ellDist(this.ell(e), p);
      else if (e.t === "text") {
        // Anywhere in the text's box picks it, the outline a little more surely.
        const at = this.pt(e.p), path = textPath(this.sk.ents, e);
        d = Math.min(...textPolys(e, at, path).map(l => nearestOn(l, p).d), Infinity);
        if (d >= tol && inPolygon(p, textBox(e, at, path))) d = tol * 0.6;
      }
      if (d < tol) out.push({ id: e.id, kind: e.t as Hit["kind"], d: d + tol * 0.25 });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // ---------- pointer ----------

  /** Returns true when the event was used (so the viewer does not orbit or measure). */
  pointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    this.lastEv = e;
    const p = this.uv(e);
    if (!p) return true;
    this.closeInput(true);
    this.syncDraft();
    if (this.tool === "select") {
      const h = this.hits(p)[0] ?? null;
      if (!h || h.kind === "origin") {
        if (!e.ctrlKey && !e.shiftKey) this.selection.clear();
        // The sketch origin can be selected (for Midpoint, Coincident or a dimension to it, exam bug 45); a drag from it still box-selects.
        if (h) { if ((e.ctrlKey || e.shiftKey) && this.selection.has(ORIGIN)) this.selection.delete(ORIGIN); else this.selection.add(ORIGIN); }
        // Box selection from empty space (FR-SEL-002): left to right takes what is fully inside, right to left what it crosses.
        this.box = { a: p, b: p, x0: e.clientX, base: new Set(this.selection) };
        try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* synthetic event */ }
        this.render();
        this.emitSel();
        return true;
      }
      // Ctrl+drag copies (FR-SK-044): a Ctrl+click on a selected item still deselects it, on release without a move.
      const ctrl = e.ctrlKey || e.metaKey;
      // A block instance is picked whole and dragged by its insertion point (FRS 2.2 blocks).
      const blk = this.lockedInsert(h.id);
      if (blk) {
        const ids = insertEnts(this.sk, blk.id), was = ids.every(x => this.selection.has(x));
        if (ctrl || e.shiftKey) { for (const x of ids) if (was) this.selection.delete(x); else this.selection.add(x); }
        else if (!was) this.selection = new Set(ids);
        this.emitSel();
        if (!ctrl && !e.shiftKey) this.drag = { ids: [], start: p, orig: new Map(), moved: false, base: structuredClone(this.sk), ins: { id: blk.id, x: blk.x, y: blk.y } };
        this.render();
        return true;
      }
      const was = this.selection.has(h.id);
      if (ctrl) { if (!was) this.selection.add(h.id); }
      else if (e.shiftKey) { if (was) this.selection.delete(h.id); else this.selection.add(h.id); }
      else if (!was) { this.selection.clear(); this.selection.add(h.id); }
      this.emitSel();
      const ent = this.ent(h.id);
      if (!ent) { this.render(); return true; }
      if (ctrl) {
        this.drag = { ids: [], start: p, orig: new Map(), moved: false, base: structuredClone(this.sk), copy: true, untoggle: was ? h.id : null };
        this.render();
        return true;
      }
      // Start a drag of what is under the cursor.
      const ids = ent.t === "point" ? [ent.id] : ent.t === "circle" ? [] : refPts(ent);
      const orig = new Map(ids.map(id => [id, this.pt(id)] as const));
      this.drag = { ids, start: p, orig, circle: ent.t === "circle" ? ent.id : undefined, moved: false, base: structuredClone(this.sk), ...(ent.t === "point" ? { point: ent.id } : {}) };
      this.render();
      return true;
    }
    if (this.tool === "dim") { this.dimClick(p, e); return true; }
    if (this.tool === "hord" || this.tool === "vord") { this.ordClick(p); return true; }
    if (["trim", "fillet", "chamfer", "extend", "split", "segment", "jog", "offset"].includes(this.tool)) {
      const h = this.hits(p)[0];
      if (h && this.lockedInsert(h.id)) { this.host.toast(t("Explode the block to change its entities."), "warn"); return true; }
    }
    if (this.tool === "trim") { this.trimAt(p); return true; }
    if (this.tool === "fillet") { this.filletAt(p); return true; }
    if (this.tool === "chamfer") { this.chamferAt(p); return true; }
    if (this.tool === "extend") { this.extendAt(p); return true; }
    if (this.tool === "split") { this.splitAt(p); return true; }
    if (this.tool === "segment") { this.segmentAt(p); return true; }
    if (this.tool === "jog") { this.jogClick(p); return true; }
    if (this.tool === "offset") { this.offsetAt(p, true); return true; }
    if (this.tool === "convert") { this.convertAt(e); return true; }
    if (this.tool === "intersect") { this.intersectAt(e); return true; }
    this.drawClick(p, e);
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (e.buttons & 6) return false; // panning / orbiting with the other buttons
    this.lastEv = e;
    const p = this.uv(e);
    if (!p) return true;
    this.cursorUV = p;
    if (!this.reattaching && !this.piercing) this.statusHint();
    if (this.box) {
      this.box.b = p;
      this.boxSelect(e.clientX < this.box.x0);
      this.render();
      return true;
    }
    if (this.drag) {
      const d = this.drag;
      if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < this.px(p) * 3) return true;
      d.moved = true;
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      this.sk = structuredClone(d.base);
      if (d.ins) {
        this.sk = moveInsert(this.sk, d.ins.id, { x: d.ins.x + dx, y: d.ins.y + dy });
        this.info = solve(this.sk);
        this.render();
        return true;
      }
      if (d.copy) {
        d.made = this.copyItems([dx, dy]);
        this.info = solve(this.sk);
        this.render();
        return true;
      }
      // Drag to merge (FR-SK-043): a point dropped on a point, the origin or a curve joins it; Ctrl leaves it free.
      d.target = d.point ? this.mergeTarget(d.point, p) : null;
      const to = d.target?.t === "coincident" ? this.pt(d.target.id) : d.target ? this.project(p, d.target.id) : null;
      this.showInfer(d.target ? { p: to!, id: d.target.t === "coincident" ? d.target.id : null, curve: d.target.t === "onCurve" ? d.target.id : null, hv: null } : null);
      const r = d.circle ? solve(this.sk, { circle: d.circle, to: p })
        : solve(this.sk, { points: d.ids.map(id => ({ id, to: to && id === d.point ? to : [d.orig.get(id)![0] + dx, d.orig.get(id)![1] + dy] as V2 })) });
      this.info = r;
      this.render();
      return true;
    }
    if (this.tool === "dim" && this.dimDraft.dim) { this.placeDimDraft(p); this.render(); return true; }
    const pick = ["trim", "extend", "split", "segment", "offset"].includes(this.tool) || (this.tool === "jog" && !this.draft.pts.length);
    const snap = this.snapPoint(p, !pick && !["select", "fillet", "chamfer", "convert", "intersect", "jog"].includes(this.tool));
    this.hover = this.tool === "select" || this.tool === "dim" || pick ? this.hits(p, { points: !pick })[0] ?? null
      : this.tool === "fillet" || this.tool === "chamfer" ? this.hits(p, { curves: false }).find(h => h.kind === "point") ?? null : null;
    this.offsetPreview = this.tool === "offset" ? this.offsetAt(p, false) : this.tool === "jog" ? [this.jogShape(p)?.poly ?? []].filter(x => x.length) : [];
    this.draft.cursor = snap.p;
    if (this.tool === "arc" && this.draft.pts.length === 2) this.trackArc(snap.p);
    if (this.lineTool) this.trackBack(snap.p);
    this.draft.snap = snap.id;
    this.draft.hoverCurve = snap.id ? null : snap.curve;
    this.showInfer(pick || ["select", "fillet", "chamfer", "convert", "intersect", "dim", "hord", "vord", "jog"].includes(this.tool) ? null : snap);
    this.render();
    return true;
  }

  /** What lies under the cursor for the hover glyph (FR-SEL-012): a hit kind, or "point"/"curve" from the drawing snap. */
  hoverHitKind(): string | null {
    if (this.hover) return this.hover.kind;
    if (this.draft.snap) return "point";
    if (this.draft.hoverCurve) return "curve";
    return null;
  }

  pointerUp(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    if (this.box) {
      const b = this.box;
      this.box = null;
      // A click (no box drawn) on a model edge or vertex (FR-SK-064): its reference copy is selected, so
      // relations such as parallel, tangent or coincident can be added against the model directly.
      const p = this.uv(e);
      if (p && Math.abs(e.clientX - b.x0) <= 4 && Math.hypot(p[0] - b.a[0], p[1] - b.a[1]) <= this.px(p) * 4) {
        const ms = this.modelSnapAt(p, false);
        if (ms) {
          const r = this.materialize(ms);
          const id = r.id ?? r.curve;
          if (id) {
            this.selection.add(id);
            this.commit("Reference model edge");
          }
        }
      }
      this.render(); this.emitSel(); return true;
    }
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this.showInfer(null);
      if (d.copy) {
        if (d.moved && d.made?.length) {
          this.selection = new Set(d.made);
          this.commit("Copy entities");
          this.emitSel();
        } else if (d.untoggle) { this.selection.delete(d.untoggle); this.render(); this.emitSel(); }
        return true;
      }
      if (d.moved && d.point && d.target && !(e.ctrlKey || e.metaKey)) {
        const rel: SkRel = { id: uid("r"), t: d.target.t, e: [d.point, d.target.id] };
        const r = tryAdd(this.sk, { rel });
        if (r.ok) { this.sk = r.sketch; this.info = r.result; this.commit(d.target.t === "coincident" ? "Merge points" : "Add relation"); this.render(); return true; }
      }
      if (d.moved) this.commit(d.ins ? "Move block" : "Drag sketch geometry");
      return true;
    }
    return true;
  }

  doubleClick(): boolean {
    if (this.lineTool && this.draft.pts.length) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; this.render(); return true; }
    if (this.tool === "select") {
      // Double-click a dimension label edits it; on geometry: nothing yet.
      return false;
    }
    return false;
  }

  /**
   * The sketch right-click menu (FR-SK-045), for a right-click without movement at `e`: rows of
   * [label, action, icon], null = separator. An item under the cursor that is not selected becomes the selection.
   * With the line tool in the middle of a chain the chain ends at once (as a double-click) and null comes back.
   */
  contextMenu(e: { clientX: number; clientY: number }): ([string, () => void, string?] | null)[] | null {
    const d = this.draft;
    if (this.lineTool && d.pts.length) { this.doubleClick(); this.statusHint(); return null; }
    // Placing a dimension: a right-click locks (or frees) its orientation, so the text can go anywhere (FR-SK-068).
    if (this.tool === "dim" && this.dimDraft.dim) { this.dimDraft.lock = !this.dimDraft.lock; this.render(); this.statusHint(); return null; }
    const rows: ([string, () => void, string?] | null)[] = [];
    const sep = () => { if (rows.length && rows.at(-1) !== null) rows.push(null); };
    if ((this.tool === "spline" || this.tool === "sspline") && d.pts.length >= 2) rows.push([t("End chain"), () => this.drawClick(d.pts.at(-1)!, { detail: 2 })]);
    if (d.pts.length || this.dimDraft.picks.length) rows.push([t("Cancel drawing"), () => this.setTool(this.tool), "✕"]);
    if (this.tool !== "select") rows.push([t("Select"), () => this.setTool("select")]);
    else {
      const p = this.uv(e as PointerEvent);
      const h = p ? this.hits(p)[0] : undefined;
      if (h && h.kind !== "dim" && h.kind !== "rel" && !this.selection.has(h.id)) { this.selection = new Set([h.id]); this.render(); this.emitSel(); }
    }
    if (!this.selection.size) {
      if (this.tool === "select" && this.info.status === "ok" && this.info.dof > 0) { sep(); rows.push([t("Fully define sketch"), () => this.fullyDefineUi()]); }
      return rows;
    }
    sep();
    const ids = [...this.selection];
    const oneDim = ids.length === 1 ? this.sk.dims.find(x => x.id === ids[0]) : undefined;
    if (oneDim && oneDim.t !== "angle" && oneDim.t !== "arclen" && !oneDim.ord) rows.push([t("Flip arrows"), () => this.flipArrows(oneDim.id), "⇄"]);
    const conds = oneDim ? this.arcCondRows(oneDim) : [];
    if (conds.length) { sep(); rows.push(...conds); sep(); }
    const one = ids.length === 1 ? this.ent(ids[0]) : undefined;
    if (one && (one.t === "line" || one.t === "arc") && !one.cons) rows.push([t("Select chain"), () => this.select(this.chainOf(one.id).segs.map(s => s.id))]);
    const curves = ids.map(id => this.ent(id)).filter(x => x && x.t !== "point");
    if (curves.length) rows.push([curves.every(x => x!.cons) ? t("Normal geometry") : t("Construction geometry"), () => this.toggleConstruction()]);
    const rels = this.relationRows();
    if (rels.length) { sep(); rows.push(...rels); }
    sep();
    rows.push([t("Delete"), () => this.deleteSelection(), "🗑"]);
    rows.push([t("Zoom to selection"), () => { const b = this.selectionBox(); if (b) this.host.viewer.fit(true, b); }]);
    return rows;
  }

  /** Add relation rows for the selection (FR-SK-054): the relations valid for it, then Merge points when it can. */
  relationRows(): [string, () => void, string?][] {
    const rows: [string, () => void, string?][] = this.validRelations().map(k => [t(REL_NAME[k]), () => this.addRelation(k), REL_GLYPH[k]]);
    if (this.canMerge()) rows.push([t("Merge points"), () => this.mergePoints()]);
    return rows;
  }

  /** World box of the selected sketch items, with a margin (Zoom to selection while sketching). */
  selectionBox(): THREE.Box3 | null { return this.boxOf(this.selection); }

  /**
   * World box of the sketch's curves and text with the same margin, or null when it has none (Edit sketch frames
   * it). Lone points are left out: a sketch of one far point opens where the view was, as before.
   */
  sketchBox(): THREE.Box3 | null { return this.boxOf(this.sk.ents.filter(e => e.t !== "point").map(e => e.id)); }

  private boxOf(ids: Iterable<string>): THREE.Box3 | null {
    const b = new THREE.Box3();
    for (const id of ids) {
      const e = id === ORIGIN ? null : this.ent(id);
      if (id === ORIGIN) b.expandByPoint(this.w([0, 0]));
      else if (!e) continue;
      else if (e.t === "circle") { const c = this.pt(e.c); for (const s of [[1, 0], [-1, 0], [0, 1], [0, -1]]) b.expandByPoint(this.w([c[0] + s[0] * e.r, c[1] + s[1] * e.r])); }
      else if (e.t === "point") b.expandByPoint(this.w([e.x, e.y]));
      else for (const q of refPts(e)) b.expandByPoint(this.w(this.pt(q)));
    }
    if (b.isEmpty()) return null;
    const s = b.getSize(new THREE.Vector3());
    return b.expandByScalar(Math.max(s.x, s.y, s.z, 1) * 0.1);
  }

  /**
   * What a dragged point would join (FR-SK-043): another point or the origin (coincident), else a curve (on curve).
   * Points and curves of the entities that use the dragged point are left out, so a line never folds onto itself.
   */
  private mergeTarget(id: string, p: V2): { t: "coincident" | "onCurve"; id: string } | null {
    if (this.suppressed()) return null;
    const own = this.sk.ents.filter(e => e.t !== "point" && refPts(e).includes(id));
    const exclude = new Set<string>([id, ...own.flatMap(e => refPts(e)), ...own.map(e => e.id)]);
    const h = this.hits(p, { curves: false, exclude })[0];
    if (h) return { t: "coincident", id: h.id };
    const c = this.hits(p, { points: false, exclude })[0];
    if (c && this.ent(c.id)?.t !== "text") return { t: "onCurve", id: c.id };
    return null;
  }

  /**
   * Copies of the selected entities moved by `d` (FR-SK-044). Relations and dimensions among the copied items are
   * copied too (fixes and model references are not); relations to the rest of the sketch are dropped.
   */
  private copyItems(d: V2): string[] {
    const items = this.sk.ents.filter(e => this.selection.has(e.id));
    const map = new Map<string, string>();
    const point = (id: string) => {
      if (id === ORIGIN) return id;
      let got = map.get(id);
      if (!got) { got = uid("p"); const q = this.pt(id); this.sk.ents.push({ id: got, t: "point", x: q[0] + d[0], y: q[1] + d[1] }); map.set(id, got); }
      return got;
    };
    const made: string[] = [];
    const add = (src: SkEnt, e: SkEnt) => { this.sk.ents.push(e); map.set(src.id, e.id); made.push(e.id); };
    for (const e of items) {
      const cons = e.cons ? { cons: true } : {};
      if (e.t === "point") { if (e.id !== ORIGIN) made.push(point(e.id)); }
      else if (e.t === "line") add(e, { id: uid("l"), t: "line", a: point(e.a), b: point(e.b), ...cons });
      else if (e.t === "circle") add(e, { id: uid("c"), t: "circle", c: point(e.c), r: e.r, ...cons });
      else if (e.t === "ellipse") add(e, { id: uid("e"), t: "ellipse", c: point(e.c), a: point(e.a), b: point(e.b), ...(e.p0 && e.p1 ? { p0: point(e.p0), p1: point(e.p1) } : {}), ...cons });
      else if (e.t === "spline") add(e, { id: uid("s"), t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...splineExtra(e), ...cons });
      else if (e.t === "text") { const c = { ...structuredClone(e), id: uid("t"), p: point(e.p) }; delete c.along; delete c.flip; add(e, c); }
      else add(e, { id: uid("a"), t: "arc", c: point(e.c), a: point(e.a), b: point(e.b), ...cons });
    }
    const inside = (ids: string[]) => ids.every(x => x === ORIGIN ? false : map.has(x));
    for (const r of [...this.sk.rels]) {
      if (r.t === "fix" || r.t === "pierce" || r.ext || !inside(r.e)) continue;
      const c: SkRel = { ...structuredClone(r), id: uid("r"), e: r.e.map(x => map.get(x)!) };
      delete c.of;
      this.sk.rels.push(c);
    }
    for (const dm of [...this.sk.dims]) {
      if (!inside(dm.e)) continue;
      this.sk.dims.push({ ...structuredClone(dm), id: uid("d"), name: this.nextDimName(), e: dm.e.map(x => map.get(x)!), ...(dm.pos ? { pos: [dm.pos[0] + d[0], dm.pos[1] + d[1]] as V2 } : {}) });
    }
    return made;
  }

  // ---------- snapping ----------

  /** Snaps a cursor point to points, the origin, curves and horizontal/vertical from the last point. */
  // ---------- grid (FR-SK-041) ----------

  /** The part of the sketch plane the view shows (corners and middle of the canvas), or null when edge-on. */
  private visibleBox(): [V2, V2] | null {
    const r = this.host.viewer.renderer.domElement.getBoundingClientRect();
    const xs: number[] = [], ys: number[] = [];
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
      const q = this.uv({ clientX: r.left + fx * r.width, clientY: r.top + fy * r.height } as PointerEvent);
      if (!q) return null;
      xs.push(q[0]); ys.push(q[1]);
    }
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  }

  /** The spacing Snap to grid uses now: the drawn one, else worked out at a point. */
  private snapStep(p: V2): number {
    if (this.gridAt > 0) return this.gridAt;
    const box = this.visibleBox();
    return gridStep(this.gridSpacing, this.px(p), box ?? [p, p]);
  }

  private dropGrid() {
    if (!this.gridObj) return;
    this.host.viewer.scene.remove(this.gridObj);
    this.gridObj.geometry.dispose();
    (this.gridObj.material as THREE.Material).dispose();
    this.gridObj = null;
  }

  /** Draws (or removes) the grid for the current view; runs on every render, rebuilding only when the view moved. */
  private syncGrid() {
    if (!this.grid) { if (this.gridObj) { this.dropGrid(); this.gridKey = ""; this.gridAt = 0; } return; }
    const box = this.visibleBox();
    if (!box) { this.dropGrid(); this.gridKey = ""; return; }
    const mid: V2 = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2];
    const step = gridStep(this.gridSpacing, this.px(mid), box);
    // Pad by a few steps so small pans need no rebuild.
    const pad = step * 4, k = (v: number) => Math.floor(v / pad);
    const key = `${step}|${k(box[0][0])}|${k(box[0][1])}|${k(box[1][0])}|${k(box[1][1])}|${this.dark ? 1 : 0}`;
    if (key === this.gridKey && this.gridObj) return;
    this.gridKey = key;
    this.gridAt = step;
    const lo: V2 = [Math.floor(box[0][0] / pad) * pad, Math.floor(box[0][1] / pad) * pad];
    const hi: V2 = [Math.ceil(box[1][0] / pad + 1) * pad, Math.ceil(box[1][1] / pad + 1) * pad];
    const pos: number[] = [], col: number[] = [];
    const bg = this.dark ? [0.09, 0.1, 0.12] : [1, 1, 1], ink = this.dark ? [0.75, 0.8, 0.88] : [0.35, 0.4, 0.5];
    const mix = (a: number) => bg.map((b, i) => b + (ink[i] - b) * a);
    for (const [a, b, major] of gridLines([lo, hi], step)) {
      const c = mix(major ? 0.32 : 0.14);
      for (const q of [a, b]) { const w = this.w(q); pos.push(w.x, w.y, w.z); col.push(...c); }
    }
    this.dropGrid();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.gridObj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    this.gridObj.renderOrder = 2990;
    this.gridObj.userData.skGrid = true;
    this.host.viewer.scene.add(this.gridObj);
  }

  // ---------- sketch pictures (FRS 2.2) ----------

  private picObjs = new Map<string, { src: string; mesh: THREE.Mesh; tex: THREE.Texture }>();

  private dropPicture(id: string) {
    const o = this.picObjs.get(id);
    if (!o) return;
    this.host.viewer.scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    (o.mesh.material as THREE.Material).dispose();
    o.tex.dispose();
    this.picObjs.delete(id);
  }

  /** Puts each picture on the sketch plane under the curves; a texture is made once per image. */
  private syncPictures() {
    const pics = this.sk.pictures ?? [];
    for (const id of [...this.picObjs.keys()]) if (!pics.some(p => p.id === id && p.src === this.picObjs.get(id)!.src)) this.dropPicture(id);
    const f = this.frame;
    for (const p of pics) {
      let o = this.picObjs.get(p.id);
      if (!o) {
        const tex = new THREE.TextureLoader().load(p.src, () => this.host.viewer.invalidate());
        tex.colorSpace = THREE.SRGBColorSpace;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        mesh.renderOrder = 2980;
        mesh.matrixAutoUpdate = false;
        mesh.userData.skPicture = p.id;
        this.host.viewer.scene.add(mesh);
        o = { src: p.src, mesh, tex };
        this.picObjs.set(p.id, o);
      }
      const ca = Math.cos(p.ang ?? 0), sa = Math.sin(p.ang ?? 0);
      const X = new THREE.Vector3(...f.x).multiplyScalar(ca).addScaledVector(new THREE.Vector3(...f.y), sa).multiplyScalar(p.w * (p.flip ? -1 : 1));
      const Y = new THREE.Vector3(...f.y).multiplyScalar(ca).addScaledVector(new THREE.Vector3(...f.x), -sa).multiplyScalar(p.h);
      o.mesh.matrix.makeBasis(X, Y, new THREE.Vector3(...f.n)).setPosition(this.w(p.c));
      o.mesh.matrixWorldNeedsUpdate = true;
      (o.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - Math.min(1, Math.max(0, p.alpha ?? 0));
    }
  }

  /** Adds a picture (a data URL of `wpx` × `hpx` pixels) at 96 dpi, its lower left corner on the origin (a CAD app). */
  addPicture(src: string, wpx: number, hpx: number, name?: string): string {
    const pics = (this.sk.pictures ??= []);
    let k = pics.length + 1;
    while (pics.some(p => p.id === `pic${k}`)) k++;
    const w = (wpx * 25.4) / 96, h = (hpx * 25.4) / 96;
    pics.push({ id: `pic${k}`, ...(name ? { name } : {}), src, c: [w / 2, h / 2], w, h });
    this.commit("Sketch picture");
    this.render();
    return `pic${k}`;
  }

  /** Changes a picture; with the size locked, a new width or height scales the other one too. */
  setPicture(id: string, patch: Partial<Omit<SketchPicture, "id" | "src">>) {
    const p = this.sk.pictures?.find(x => x.id === id);
    if (!p) return;
    if (!p.free && !patch.free) {
      if (patch.w !== undefined && patch.h === undefined && p.w > 0) patch.h = (p.h * patch.w) / p.w;
      else if (patch.h !== undefined && patch.w === undefined && p.h > 0) patch.w = (p.w * patch.h) / p.h;
    }
    if ((patch.w !== undefined && !(patch.w > 0)) || (patch.h !== undefined && !(patch.h > 0))) return;
    Object.assign(p, patch);
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined || patch[k] === false || (k === "alpha" && !patch.alpha) || (k === "ang" && !patch.ang)) delete p[k];
    this.commit("Sketch picture");
    this.render();
  }

  removePicture(id: string) {
    const pics = this.sk.pictures;
    if (!pics?.some(p => p.id === id)) return;
    this.sk.pictures = pics.filter(p => p.id !== id);
    if (!this.sk.pictures.length) delete this.sk.pictures;
    this.commit("Delete sketch picture");
    this.render();
  }

  /** Shows or hides the grid, sets Snap to grid and the spacing (mm, 0 = automatic). */
  setGrid(o: { show?: boolean; snap?: boolean; spacing?: number }) {
    if (o.show !== undefined) this.grid = o.show;
    if (o.snap !== undefined) this.gridSnap = o.snap;
    if (o.spacing !== undefined) this.gridSpacing = Math.max(0, o.spacing || 0);
    this.gridKey = "";
    this.gridAt = 0;
    this.syncGrid();
    this.host.viewer.invalidate();
  }

  private snapPoint(p: V2, active: boolean, materialize = false): Snap {
    const r = this.snapPointRaw(p, active, materialize);
    if (r.id && this.drawing && !this.woke.some(w => w[0] === r.p[0] && w[1] === r.p[1])) this.woke = [...this.woke, r.p].slice(-4);
    const free = active && !r.id && !r.curve && !r.rel && !this.suppressed() && !this.quickSnap;
    if (!free) { this.showAlign([]); return r; }
    // Alignment with existing points (FR-SK-042): an x or y within the snap radius of a sketch point's
    // lines up with it, shown by a dotted line from that point; no relation is added.
    let q: V2 = [r.p[0], r.p[1]];
    const lock = { x: r.hv === "vertical", y: r.hv === "horizontal" };
    const lines: [V2, V2][] = [];
    if (this.drawing && this.snaps.has("hv")) {
      const a = this.alignAt(q, lock);
      if (a.x) { q[0] = a.x[0]; lock.x = true; }
      if (a.y) { q[1] = a.y[1]; lock.y = true; }
      if (a.x) lines.push([a.x, q]);
      if (a.y) lines.push([a.y, q]);
    }
    // Snap to grid (FR-SK-041): a coordinate that snapped to nothing else goes to the nearest grid line.
    if (this.gridSnap) {
      const g = snapToGrid(q, this.snapStep(q));
      q = [lock.x ? q[0] : g[0], lock.y ? q[1] : g[1]];
      if (!lock.x && !lock.y) this.showMarker(q);
    }
    this.showAlign(lines);
    return { ...r, p: q };
  }

  /** The nearest woken point (one the cursor passed over while drawing) lined up in x and in y with `p`. */
  private alignAt(p: V2, lock: { x: boolean; y: boolean }): { x: V2 | null; y: V2 | null } {
    const tol = this.px(p) * ALIGN_PX;
    const near = this.px(p) * SNAP_PX * 2;
    const last = this.draft.pts.at(-1);
    const pts = this.woke.filter(w => !last || w[0] !== last[0] || w[1] !== last[1]);
    let bx: V2 | null = null, by: V2 | null = null, dx = tol, dy = tol;
    for (const s of pts) {
      // A point next to the cursor is a snap target, not an alignment, and the chain's last point gives H/V instead.
      if (Math.hypot(s[0] - p[0], s[1] - p[1]) < near) continue;
      if (!lock.x && Math.abs(s[0] - p[0]) < dx) { dx = Math.abs(s[0] - p[0]); bx = s; }
      if (!lock.y && Math.abs(s[1] - p[1]) < dy) { dy = Math.abs(s[1] - p[1]); by = s; }
    }
    return { x: bx, y: by };
  }

  /** Draws the dotted alignment lines (or clears them with an empty list). */
  private showAlign(lines: [V2, V2][]) {
    this.aligned = lines;
    if (this.alignObj) {
      this.host.viewer.scene.remove(this.alignObj);
      this.alignObj.geometry.dispose();
      (this.alignObj.material as THREE.Material).dispose();
      this.alignObj = null;
    }
    if (!lines.length) return;
    const pos: number[] = [];
    for (const [a, b] of lines) pos.push(...this.w(a).toArray(), ...this.w(b).toArray());
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const d = this.px(lines[0][1]) * 4;
    this.alignObj = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: this.dark ? 0x9ec5fe : 0x1c7ed6, dashSize: d, gapSize: d, depthTest: false, transparent: true }));
    this.alignObj.computeLineDistances();
    this.alignObj.renderOrder = 3050;
    this.alignObj.userData.skAlign = true;
    this.host.viewer.scene.add(this.alignObj);
  }

  private snapPointRaw(p: V2, active: boolean, materialize = false): Snap {
    this.marker.visible = false;
    // Ctrl held (or automatic relations off): the point goes where the cursor is, with no relation (FR-SK-052).
    if (!active || (this.suppressed() && !this.quickSnap)) return { p, id: null, curve: null, hv: null };
    if (this.quickSnap) return this.quickAt(this.quickSnap, p, materialize) ?? { p, id: null, curve: null, hv: null };
    const on = this.snaps;
    const centres = this.centreIds();
    const h = this.hits(p, { curves: false }).filter(x => on.has(centres.has(x.id) ? "centre" : "end"));
    if (h.length) { const q = this.pt(h[0].id); this.showMarker(q); return { p: q, id: h[0].id, curve: null, hv: null }; }
    // Model vertices, edge midpoints and circle centres (projected onto the sketch) come next.
    const ms = this.modelSnapAt(p, true);
    if (ms) {
      this.showMarker(ms.p);
      if (!materialize) return { p: ms.p, id: null, curve: null, hv: null };
      const r = this.materialize(ms);
      return { p: ms.p, id: r.id, curve: r.curve, hv: null };
    }
    // Midpoints, quadrants and intersections when turned on in the snap preferences (FR-SK-046).
    const tol = this.px(p) * SNAP_PX;
    const extra = (["mid", "quadrant", "intersection"] as const).filter(k => on.has(k))
      .flatMap(k => this.snapCands(k)).map(c => ({ c, d: Math.hypot(c.p[0] - p[0], c.p[1] - p[1]) }))
      .filter(x => x.d < tol).sort((a, b) => a.d - b.d)[0];
    if (extra) return this.useCand(extra.c, materialize);
    let q = p;
    let hv: "horizontal" | "vertical" | null = null;
    const last = this.draft.pts.at(-1);
    if (last && (this.lineTool || this.tool === "mline") && !this.draft.arc) {
      const a = Math.atan2(p[1] - last[1], p[0] - last[0]);
      if (!on.has("hv")) { /* off in the preferences */ }
      else if (Math.abs(Math.sin(a)) < Math.sin(HV_TOL)) { q = [p[0], last[1]]; hv = "horizontal"; }
      else if (Math.abs(Math.cos(a)) < Math.sin(HV_TOL)) { q = [last[0], p[1]]; hv = "vertical"; }
      if (!hv) {
        const inf = this.inferDir(last, p);
        if (inf) return { p: inf.p, id: null, curve: null, hv: null, rel: inf.rel };
      }
    }
    const c = this.hits(q, { points: false })[0];
    if (c && !hv) {
      // A line hovered while drawing a line becomes the parallel/perpendicular reference (CAD app inference).
      if (this.lineTool && this.sk.ents.find(x => x.id === c.id)?.t === "line") this.inferLine = c.id;
      if (!on.has("nearest")) return { p: q, id: null, curve: null, hv };
      const proj = this.project(q, c.id); this.showMarker(proj); return { p: proj, id: null, curve: c.id, hv: null };
    }
    return { p: q, id: null, curve: null, hv };
  }

  /** Is a tool that places points running (quick snaps apply)? */
  get drawing(): boolean {
    return !["select", "fillet", "chamfer", "convert", "intersect", "trim", "extend", "split", "jog", "segment", "offset", "dim", "hord", "vord", "eqn"].includes(this.tool);
  }

  /** Sets (or with null cancels) the quick snap for the next point (FR-SK-046). */
  setQuickSnap(k: SnapKind | null) {
    if (this.quickSnap === k) return;
    this.quickSnap = k;
    this.statusHint();
    this.onQuickSnap?.();
  }

  /** Ids of the centre points of circles, arcs and ellipses (the Centre snap; other points are end points). */
  private centreIds(): Set<string> {
    const s = new Set<string>();
    for (const e of this.sk.ents) if (e.t === "circle" || e.t === "arc" || e.t === "ellipse") s.add(e.c);
    return s;
  }

  /** Lines, circles and arcs as snap curves (construction ones too). */
  private snapCurves(): SnapCurve[] {
    const out: SnapCurve[] = [];
    for (const e of this.sk.ents) {
      if (e.t === "line") out.push({ id: e.id, k: "l", a: this.pt(e.a), b: this.pt(e.b) });
      else if (e.t === "circle") out.push({ id: e.id, k: "c", c: this.pt(e.c), r: e.r });
      else if (e.t === "arc") out.push(arcCurve(e.id, this.pt(e.c), this.pt(e.a), this.pt(e.b)));
    }
    return out;
  }

  /**
   * Snap points of one kind: line midpoints (a new point with a midpoint relation), circle and arc quadrants
   * (on the curve), or crossings of two curves (a new point with an intersection relation).
   */
  private snapCands(k: "mid" | "quadrant" | "intersection"): { p: V2; curve?: string; mid?: string; cross?: [string, string] }[] {
    const cs = this.snapCurves();
    if (k === "mid") return cs.filter(c => c.k === "l").map(c => { const l = c as SnapCurve & { k: "l" }; return { p: [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2] as V2, mid: l.id }; });
    if (k === "quadrant") return cs.flatMap(c => c.k === "c" ? quadrants(c).map(p => ({ p, curve: c.id })) : []);
    const out: { p: V2; cross: [string, string] }[] = [];
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) for (const p of intersections(cs[i], cs[j])) out.push({ p, cross: [cs[i].id, cs[j].id] });
    return out;
  }

  /** The snap a candidate point gives; with `materialize` the midpoint or crossing point is made (a click). */
  private useCand(c: { p: V2; curve?: string; mid?: string; cross?: [string, string] }, materialize: boolean): Snap {
    this.showMarker(c.p);
    // A crossing at an existing point (a shared end) just uses that point.
    const at = this.sk.ents.find(x => x.t === "point" && Math.hypot(x.x - c.p[0], x.y - c.p[1]) < 1e-7)?.id;
    if (at) return { p: c.p, id: at, curve: null, hv: null };
    if (c.curve) return { p: c.p, id: null, curve: c.curve, hv: null };
    if (!materialize) return { p: c.p, id: null, curve: null, hv: null };
    const id = uid("p");
    this.sk.ents.push({ id, t: "point", x: c.p[0], y: c.p[1] });
    this.sk.rels.push(c.mid ? { id: uid("r"), t: "midpoint", e: [id, c.mid] } : { id: uid("r"), t: "intersection", e: [id, ...c.cross!] });
    return { p: c.p, id, curve: null, hv: null };
  }

  /**
   * A quick snap (FR-SK-046): only the chosen kind snaps, in a wider radius; null leaves the point at the cursor.
   * Tangent, perpendicular, parallel and horizontal/vertical work from the last point of a line chain.
   */
  private quickAt(k: SnapKind, p: V2, materialize: boolean): Snap | null {
    const tol = this.px(p) * SNAP_PX * 3;
    const near = <T extends { p: V2 }>(xs: T[]) => xs.map(x => ({ x, d: Math.hypot(x.p[0] - p[0], x.p[1] - p[1]) })).filter(x => x.d < tol).sort((a, b) => a.d - b.d)[0]?.x;
    if (k === "end" || k === "centre") {
      const centres = this.centreIds();
      const pts = this.sk.ents.filter((e): e is SkEnt & { t: "point" } => e.t === "point" && centres.has(e.id) === (k === "centre")).map(e => ({ p: [e.x, e.y] as V2, id: e.id }));
      if (k === "end") pts.push({ p: [0, 0], id: ORIGIN });
      const b = near(pts);
      if (!b) return null;
      this.showMarker(b.p);
      return { p: b.p, id: b.id, curve: null, hv: null };
    }
    if (k === "mid" || k === "quadrant" || k === "intersection") { const b = near(this.snapCands(k)); return b ? this.useCand(b, materialize) : null; }
    if (k === "nearest") {
      const c = this.hits(p, { points: false }).find(h => this.ent(h.id)?.t !== "text");
      if (!c) return null;
      const q = this.project(p, c.id);
      this.showMarker(q);
      return { p: q, id: null, curve: c.id, hv: null };
    }
    const last = this.draft.pts.at(-1);
    if (!last || this.tool !== "line") return null;
    if (k === "hv") {
      const horiz = Math.abs(p[0] - last[0]) >= Math.abs(p[1] - last[1]);
      return { p: horiz ? [p[0], last[1]] : [last[0], p[1]], id: null, curve: null, hv: horiz ? "horizontal" : "vertical" };
    }
    // The curve nearest the cursor within the wide radius.
    const dist = (c: SnapCurve) => c.k === "l" ? segDist(p, c.a, c.b)
      : c.a0 === undefined ? Math.abs(Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r)
      : arcDist(p, c.c, [c.c[0] + c.r * Math.cos(c.a0), c.c[1] + c.r * Math.sin(c.a0)], [c.c[0] + c.r * Math.cos(c.a0 + c.sw!), c.c[1] + c.r * Math.sin(c.a0 + c.sw!)]);
    const startId = this.draft.ids.at(-1);
    const own = (c: SnapCurve) => { const e = this.ent(c.id); return !!startId && !!e && (e.t === "line" || e.t === "arc") && (e.a === startId || e.b === startId); };
    const curves = this.snapCurves().map(c => ({ c, d: dist(c) })).filter(x => x.d < tol).sort((a, b) => a.d - b.d);
    if (k === "tangent") {
      const c = curves.find(x => x.c.k === "c")?.c as (SnapCurve & { k: "c" }) | undefined;
      if (!c) return null;
      const q = tangentPoints(last, c).sort((a, b) => Math.hypot(a[0] - p[0], a[1] - p[1]) - Math.hypot(b[0] - p[0], b[1] - p[1]))[0];
      if (!q) return null;
      this.showMarker(q);
      return { p: q, id: null, curve: c.id, hv: null, rel: { t: "tangent", ref: c.id } };
    }
    if (k === "perpendicular") {
      const c = curves.find(x => x.c.k === "l" && !own(x.c))?.c as (SnapCurve & { k: "l" }) | undefined;
      const f = c ? perpendicularFoot(last, c) : null;
      if (!c || !f) return null;
      this.showMarker(f);
      return { p: f, id: null, curve: c.id, hv: null, rel: { t: "perpendicular", ref: c.id } };
    }
    // Parallel: hover a line to pick it, then the new line runs parallel to it.
    const hov = curves.find(x => x.c.k === "l" && !own(x.c) && x.d < tol / 3)?.c;
    if (hov) this.inferLine = hov.id;
    const ref = this.inferLine ? this.ent(this.inferLine) : undefined;
    if (ref?.t !== "line") return null;
    const a = this.pt(ref.a), b = this.pt(ref.b), u: V2 = [b[0] - a[0], b[1] - a[1]], l2 = u[0] * u[0] + u[1] * u[1];
    if (l2 < 1e-18) return null;
    const s = ((p[0] - last[0]) * u[0] + (p[1] - last[1]) * u[1]) / l2;
    return { p: [last[0] + u[0] * s, last[1] + u[1] * s], id: null, curve: null, hv: null, rel: { t: "parallel", ref: ref.id } };
  }

  /** Ctrl suppresses automatic relations while drawing, as in other CAD apps (FR-SK-052). */
  private suppressed(): boolean {
    return !this.autoRels || !!(this.lastEv && (this.lastEv.ctrlKey || this.lastEv.metaKey));
  }

  /**
   * Direction inference for the next line from `last` (FR-SK-052): perpendicular to the line the chain came
   * from, tangent to the arc it came from, parallel or perpendicular to the last line hovered. Returns the
   * cursor moved onto that direction and the relation the click adds.
   */
  private inferDir(last: V2, p: V2): { p: V2; rel: { t: "perpendicular" | "parallel" | "tangent"; ref: string } } | null {
    const w: V2 = [p[0] - last[0], p[1] - last[1]];
    const L = Math.hypot(w[0], w[1]);
    if (L < 1e-9) return null;
    const tol = Math.sin(HV_TOL);
    const onto = (u: V2): V2 => { const k = (w[0] * u[0] + w[1] * u[1]) / (u[0] * u[0] + u[1] * u[1]); return [last[0] + u[0] * k, last[1] + u[1] * k]; };
    const dirOf = (id: string): V2 | null => {
      const e = this.sk.ents.find(x => x.id === id);
      if (e?.t !== "line") return null;
      const a = this.pt(e.a), b = this.pt(e.b);
      const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return n > 1e-9 ? [(b[0] - a[0]) / n, (b[1] - a[1]) / n] : null;
    };
    const cands: { t: "perpendicular" | "parallel" | "tangent"; ref: string; u: V2 }[] = [];
    const at = this.draft.ids.at(-1);
    if (at) for (const e of this.sk.ents) {
      if (e.cons) continue;
      if (e.t === "line" && (e.a === at || e.b === at)) { const u = dirOf(e.id); if (u) cands.push({ t: "perpendicular", ref: e.id, u: [-u[1], u[0]] }); }
      else if (e.t === "arc" && (e.a === at || e.b === at)) {
        const c = this.pt(e.c);
        const r: V2 = [last[0] - c[0], last[1] - c[1]];
        const n = Math.hypot(r[0], r[1]);
        if (n > 1e-9) cands.push({ t: "tangent", ref: e.id, u: [-r[1] / n, r[0] / n] });
      }
    }
    const hov = this.inferLine && this.sk.ents.some(x => x.id === this.inferLine) ? this.inferLine : null;
    const hu = hov ? dirOf(hov) : null;
    if (hov && hu && !cands.some(c => c.ref === hov)) cands.push({ t: "parallel", ref: hov, u: hu }, { t: "perpendicular", ref: hov, u: [-hu[1], hu[0]] });
    let best: (typeof cands)[number] | null = null, bd = tol;
    for (const c of cands) {
      if (!this.snaps.has(c.t)) continue;
      const s = Math.abs(w[0] * c.u[1] - w[1] * c.u[0]) / L; // sine of the angle to the direction
      if (s < bd) { bd = s; best = c; }
    }
    if (!best) return null;
    return { p: onto(best.u), rel: { t: best.t, ref: best.ref } };
  }

  /** The glyph beside the cursor for the relation a click would add (FR-SK-052). */
  private showInfer(s: Snap | null) {
    const g = !s || !this.lastEv || this.tool === "select" ? ""
      : s.rel ? REL_GLYPH[s.rel.t]
      : s.hv ? REL_GLYPH[s.hv]
      : s.id ? REL_GLYPH.coincident
      : s.curve ? REL_GLYPH.onCurve : "";
    if (!g) { this.inferEl?.remove(); this.inferEl = null; return; }
    if (!this.inferEl) {
      this.inferEl = document.createElement("div");
      this.inferEl.className = "sk-infer";
      this.inferEl.setAttribute("aria-hidden", "true");
      this.host.layer.appendChild(this.inferEl);
    }
    const r = this.host.layer.getBoundingClientRect();
    this.inferEl.textContent = g;
    this.inferEl.dataset.rel = s!.rel?.t ?? s!.hv ?? (s!.id ? "coincident" : "onCurve");
    this.inferEl.style.left = `${this.lastEv!.clientX - r.left + 14}px`;
    this.inferEl.style.top = `${this.lastEv!.clientY - r.top + 14}px`;
  }

  /**
   * The model point (or, with `points` only false, the model edge) nearest the cursor: the edge under
   * the pointer projected onto the sketch plane, its ends, midpoint or centre within the snap radius.
   */
  private modelSnapAt(p: V2, pointsOnly: boolean): { p: V2; ed: ModelEdge; g: ExtGeo; at: "a" | "b" | "mid" | "c" | "on" } | null {
    if (!this.modelSnap || !this.lastEv || !this.host.modelEdge) return null;
    const tol = this.px(p) * SNAP_PX;
    let on: { p: V2; ed: ModelEdge; g: ExtGeo; at: "on" } | null = null;
    for (const ed of this.host.modelEdge(this.lastEv)) {
      const g = projectEdge(ed, this.frame);
      if (!g) continue;
      const cands: [V2, "a" | "b" | "mid" | "c"][] = g.t === "line" ? [[g.a, "a"], [g.b, "b"], [[(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2], "mid"]]
        : g.t === "circle" ? [[g.c, "c"]] : [[g.a, "a"], [g.b, "b"], [uvOf(this.frame, ed.mid), "mid"], [g.c, "c"]];
      let best: [V2, "a" | "b" | "mid" | "c"] | null = null, bd = tol;
      for (const c of cands) { const d = Math.hypot(c[0][0] - p[0], c[0][1] - p[1]); if (d < bd) { bd = d; best = c; } }
      if (best) return { p: best[0], ed, g, at: best[1] };
      on ??= { p, ed, g, at: "on" };
    }
    return pointsOnly ? null : on;
  }

  /**
   * Turns a model snap into sketch geometry: the edge converted as a construction curve with an On edge
   * relation (reused when the edge was converted before), and the point it gives (its end or centre,
   * or a new point at its midpoint), or the curve itself.
   */
  private materialize(ms: { p: V2; ed: ModelEdge; g: ExtGeo; at: "a" | "b" | "mid" | "c" | "on" }): { id: string | null; curve: string | null } {
    const ref = this.host.edgeRef?.(ms.ed) ?? null;
    const same = (r: EdgeRef) => !!ref && r.ctx?.comp === ref.ctx?.comp && [...r.faces].sort().join("|") === [...ref.faces].sort().join("|")
      && (!r.hint || !ref.hint || Math.hypot(r.hint[0] - ref.hint[0], r.hint[1] - ref.hint[1], r.hint[2] - ref.hint[2]) < 1e-3);
    let ent = ref ? this.sk.ents.find(x => this.sk.rels.some(r => r.ext && r.e[0] === x.id && same(r.ext))) : undefined;
    if (!ent) {
      ent = this.entFrom(ms.g);
      ent.cons = true;
      this.sk.rels.push({ id: uid("r"), t: "fix", e: [ent.id], ...(ref ? { ext: ref } : {}) });
    }
    if (ms.at === "on") return { id: null, curve: ent.id };
    if (ms.at === "c" && (ent.t === "circle" || ent.t === "arc")) return { id: ent.c, curve: null };
    if ((ms.at === "a" || ms.at === "b") && (ent.t === "line" || ent.t === "arc")) {
      const d = (id: string) => { const q = this.pt(id); return Math.hypot(q[0] - ms.p[0], q[1] - ms.p[1]); };
      return { id: d(ent.a) <= d(ent.b) ? ent.a : ent.b, curve: null };
    }
    if (ms.at === "mid" && ent.t === "line") {
      const id = uid("p");
      this.sk.ents.push({ id, t: "point", x: ms.p[0], y: ms.p[1] });
      this.sk.rels.push({ id: uid("r"), t: "midpoint", e: [id, ent.id] });
      return { id, curve: null };
    }
    return { id: null, curve: null };
  }

  private project(p: V2, id: string): V2 {
    const e = this.ent(id)!;
    if (e.t === "ellipse") { const E = this.ell(e); return ellPt(E, ellParam(E, p)); }
    if (e.t === "spline") return nearestOn(this.splineLine(e), p).q;
    if (e.t === "line") { const a = this.pt(e.a), b = this.pt(e.b); const d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] ** 2 + d[1] ** 2 || 1; const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2; return [a[0] + d[0] * t, a[1] + d[1] * t]; }
    const c = this.pt(e.t === "circle" || e.t === "arc" ? e.c : id), r = e.t === "circle" ? e.r : e.t === "arc" ? Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]) : 0;
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  }

  private showMarker(p: V2) {
    const s = this.px(p) * 7;
    this.marker.position.copy(this.w(p));
    this.marker.scale.setScalar(s);
    this.marker.quaternion.copy(this.host.viewer.camera.quaternion);
    this.marker.visible = true;
  }

  // ---------- drawing ----------

  /** The ellipse being drawn: centre c, major end a, and q on it (null when q cannot be on one). */
  /** The perimeter circle for three clicks, each a point or on a curve (line, circle or arc), FR-SK-014. */
  private perimFit(at: V2[], curves: (string | null)[]) {
    const items: PerimItem[] = at.map((p, i) => {
      const e = curves[i] ? this.ent(curves[i]!) : undefined;
      if (e?.t === "line") return { k: "l", a: this.pt(e.a), b: this.pt(e.b) };
      if (e?.t === "circle") return { k: "c", c: this.pt(e.c), r: e.r };
      if (e?.t === "arc") { const c = this.pt(e.c), a = this.pt(e.a); return { k: "c", c, r: Math.hypot(a[0] - c[0], a[1] - c[1]) }; }
      return { k: "p", p };
    });
    return perimeterCircle(items, at);
  }

  private draftEll(c: V2, a: V2, q: V2): Ell | null {
    const r1 = Math.hypot(a[0] - c[0], a[1] - c[1]);
    if (r1 < 1e-9) return null;
    const u: V2 = [(a[0] - c[0]) / r1, (a[1] - c[1]) / r1];
    const x = (q[0] - c[0]) * u[0] + (q[1] - c[1]) * u[1], y = -(q[0] - c[0]) * u[1] + (q[1] - c[1]) * u[0];
    // q on x²/r1² + y²/r2² = 1; near the major axis ends fall back to |y| so it never blows up.
    const k = 1 - (x / r1) ** 2;
    const r2 = k > 0.05 ? Math.abs(y) / Math.sqrt(k) : Math.abs(y);
    if (r2 < this.px(q) * 2) return null;
    return { c, u, r1, r2 };
  }

  /** Text tool: the outline is made first (the font loads once), then the text goes in as one step and is selected. */
  private async placeText(p: V2, snapId: string | null, curve: string | null, rels: SkRel[]) {
    const o = { ...this.textOpts };
    if (!o.text.trim()) { this.host.toast(t("Type the text first."), "error"); return; }
    let gl: TextOutline;
    try { gl = await textOutline(o); } catch { this.host.toast(t("The font could not be loaded."), "error"); return; }
    const pid = this.usePoint(p, snapId, curve, rels);
    const id = uid("t");
    this.sk.ents.push({ id, t: "text", p: pid, text: o.text, h: o.h, ...(o.font !== "sans" ? { font: o.font } : {}), ...(o.bold ? { bold: true } : {}), ...(o.italic ? { italic: true } : {}), gl });
    this.sk.rels.push(...rels);
    this.commit("Add text");
    this.setTool("select");
    this.selection = new Set([id]);
    this.render();
    this.host.onSelection?.([id]);
  }

  /** Equation driven curve (FR-SK-021) the panel is filling in. */
  eqDraft: CurveEq = { mode: "xy", y: "x^2/40", t0: "-20", t1: "20" };

  /** The equation curve's text checked: null when it makes a curve, else an English message key. */
  static eqProblem(eq: CurveEq): string | null {
    try { eqBezier(eq); return null; } catch (err) { return (err as Error).message; }
  }

  /**
   * Adds an equation driven curve in sketch coordinates (FR-SK-021): its two end points are fixed, so it is
   * fully defined, as in other CAD apps. Returns an error message key, or null.
   */
  addEquation(eq: CurveEq): string | null {
    let bz: V2[];
    try { bz = eqBezier(eq); } catch (err) { return (err as Error).message; }
    const a = bz[0], b = bz[bz.length - 1];
    const pa = uid("p"), pb = uid("p"), id = uid("s");
    this.sk.ents.push({ id: pa, t: "point", x: a[0], y: a[1] }, { id: pb, t: "point", x: b[0], y: b[1] });
    this.sk.ents.push({ id, t: "spline", pts: [pa, pb], kind: "eqn", eq: { ...eq } });
    this.sk.rels.push({ id: uid("r"), t: "fix", e: [pa] }, { id: uid("r"), t: "fix", e: [pb] });
    this.commit("Add equation curve");
    this.setTool("select");
    this.selection = new Set([id]);
    this.render();
    this.host.onSelection?.([id]);
    return null;
  }

  /**
   * Changes a conic's rho, or an equation curve's text (its end points move to the new ends while they
   * are fixed where the old ones were). One undo step; returns an error message key, or null.
   */
  setCurve(id: string, patch: { rho?: number; eq?: CurveEq }): string | null {
    const e = this.ent(id);
    if (!e || e.t !== "spline") return null;
    if (patch.rho !== undefined) {
      if (!(patch.rho > 0 && patch.rho < 1)) return "Rho must be between 0 and 1.";
      if (e.kind === "parabola" && Math.abs(patch.rho - 0.5) > 1e-9) e.kind = "conic";
      e.rho = patch.rho;
      if (e.kind === "conic" && Math.abs(patch.rho - 0.5) < 1e-12) delete e.rho;
      this.commit("Edit conic");
    }
    if (patch.eq && e.kind === "eqn") {
      let bz: V2[];
      try { bz = eqBezier(patch.eq); } catch (err) { return (err as Error).message; }
      const old = e.eq ? (() => { try { return eqBezier(e.eq!); } catch { return null; } })() : null;
      // Still where the old equation put it: the ends follow the new equation.
      const at = (k: number) => this.pt(e.pts[k]);
      const unmoved = !old || (Math.hypot(at(0)[0] - old[0][0], at(0)[1] - old[0][1]) < 1e-6 && Math.hypot(at(1)[0] - old[old.length - 1][0], at(1)[1] - old[old.length - 1][1]) < 1e-6);
      if (unmoved) for (const [k, q] of [[0, bz[0]], [1, bz[bz.length - 1]]] as [number, V2][]) {
        const pe = this.ent(e.pts[k]);
        if (pe && pe.t === "point") { pe.x = q[0]; pe.y = q[1]; }
      }
      e.eq = { ...patch.eq, ...(e.eq?.flip ? { flip: true } : {}) };
      this.commit("Edit equation curve");
    }
    this.render();
    return null;
  }

  /** Changes a text (FR-SK-020): its outline is remade when the text or the font changes, then one undo step. */
  async setText(id: string, patch: Partial<Pick<Extract<SkEnt, { t: "text" }>, "text" | "h" | "ang" | "font" | "bold" | "italic" | "along" | "flip">>) {
    const e = this.ent(id);
    if (!e || e.t !== "text") return;
    const next = { ...e, ...patch };
    if (!next.text.trim()) { this.host.toast(t("Type the text first."), "error"); return; }
    if (!(next.h > 0)) { this.host.toast(t("The value must be more than 0."), "error"); return; }
    let gl = e.gl;
    if (!gl || gl.key !== textKey(next)) {
      try { gl = await textOutline(next); } catch { this.host.toast(t("The font could not be loaded."), "error"); return; }
    }
    const cur = this.ent(id);
    if (!cur || cur.t !== "text") return;
    Object.assign(cur, patch, { gl });
    if (cur.font === "sans") delete cur.font;
    if (!cur.bold) delete cur.bold;
    if (!cur.italic) delete cur.italic;
    if (!cur.ang) delete cur.ang;
    if (!cur.along) { delete cur.along; delete cur.flip; }
    if (!cur.flip) delete cur.flip;
    this.commit("Edit text");
    this.render();
  }

  /**
   * The direction a line chain leaves its last point in (FR-SK-011): along the chain's last line or arc, or,
   * at the chain's first point, along the one line or arc already ending there.
   */
  private chainTangent(): V2 | null {
    const d = this.draft, at = d.ids.at(-1);
    if (!at || at === ORIGIN) return null;
    let e = d.prev ? this.ent(d.prev) : undefined;
    if (!e) {
      const ends = this.sk.ents.filter(x => !x.cons && (x.t === "line" || x.t === "arc") && (x.a === at || x.b === at));
      if (ends.length !== 1) return null;
      e = ends[0];
    }
    if (e.t === "line") {
      const a = this.pt(e.a), b = this.pt(e.b), s = e.b === at ? 1 : -1;
      const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return n > 1e-9 ? [(s * (b[0] - a[0])) / n, (s * (b[1] - a[1])) / n] : null;
    }
    if (e.t === "arc") {
      const c = this.pt(e.c), q = this.pt(at), s = e.b === at ? 1 : -1;
      const n = Math.hypot(q[0] - c[0], q[1] - c[1]);
      return n > 1e-9 ? [(-s * (q[1] - c[1])) / n, (s * (q[0] - c[0])) / n] : null;
    }
    return null;
  }

  /** The tangent arc from the chain's last point towards `p`: centre, radius and whether it runs counter-clockwise. */
  private tangentArc(p: V2): { c: V2; r: number; ccw: boolean; a0: number; sweep: number } | null {
    const d = this.draft, P0 = d.pts.at(-1), T = this.chainTangent();
    if (!P0 || !T) return null;
    const n: V2 = [-T[1], T[0]];
    const w: V2 = [p[0] - P0[0], p[1] - P0[1]];
    const side = w[0] * n[0] + w[1] * n[1], L2 = w[0] * w[0] + w[1] * w[1];
    if (Math.abs(side) < 1e-9 * Math.max(1, Math.sqrt(L2))) return null;
    const k = L2 / (2 * side);
    const c: V2 = [P0[0] + n[0] * k, P0[1] + n[1] * k];
    const ccw = side > 0;
    const a0 = Math.atan2(P0[1] - c[1], P0[0] - c[0]), a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
    let sweep = ccw ? a1 - a0 : a0 - a1;
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return { c, r: Math.abs(k), ccw, a0, sweep: ccw ? sweep : -sweep };
  }

  /** Moving back onto the chain's end point and away again switches the line tool to a tangent arc (SW habit). */
  private trackBack(p: V2) {
    const d = this.draft, last = d.pts.at(-1);
    if (!last || !this.chainTangent()) return;
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1]) / this.px(p);
    const back = d.back ?? 0;
    if (back === 0 && dist > 14) d.back = 1;
    else if (back === 1 && dist < 6) d.back = 2;
    else if (back === 2 && dist > 14) { d.arc = !d.arc; d.back = 1; this.statusHint(); }
  }

  /** A switches the line tool between lines and a tangent arc while a chain is open (FR-SK-011). */
  toggleTangentArc(): boolean {
    const d = this.draft;
    if (this.tool !== "line" || !d.pts.length) return false;
    if (!d.arc && !this.chainTangent()) { this.host.toast(t("A tangent arc starts at the end of a line or arc.")); return true; }
    d.arc = !d.arc;
    this.statusHint();
    this.render();
    return true;
  }

  /** Whether the line tool is drawing a tangent arc now. */
  /** Line or Centerline (FR-SK-012): both chain, take typed sizes and switch to tangent arcs. */
  private get lineTool() { return this.tool === "line" || this.tool === "cline"; }

  get arcMode() { return (this.lineTool || this.tool === "tarc") && !!this.draft.arc; }

  private tangentArcClick(p: V2, s: Snap, rels: SkRel[], finish: (label: string) => void, e: { detail: number }) {
    const d = this.draft;
    const g = this.tangentArc(p);
    if (!g) { this.host.toast(t("The arc's end must not lie on the tangent line.")); return; }
    const aId = d.ids.at(-1)!;
    const bId = this.usePoint(p, s.id, s.curve, rels);
    const cId = this.usePoint(g.c, null, null, rels);
    const id = uid("a");
    this.sk.ents.push({ id, t: "arc", c: cId, a: g.ccw ? aId : bId, b: g.ccw ? bId : aId });
    const prev = d.prev ?? this.sk.ents.find(x => !x.cons && x.id !== id && (x.t === "line" || x.t === "arc") && (x.a === aId || x.b === aId))?.id;
    if (prev) rels.push({ id: uid("r"), t: "tangent", e: [prev, id] });
    finish("Add tangent arc");
    // Back to lines, chaining on from the arc's end (a CAD app), unless the loop closed.
    const closed = !!s.id && (s.id !== ORIGIN || d.chainStart === ORIGIN);
    // The Tangent Arc tool chains arcs; the line tool goes back to lines.
    if (closed || e.detail >= 2) this.draft = { pts: [], ids: [], cursor: null, snap: null };
    else { d.pts.push(p); d.ids.push(bId); d.snapCurve = null; d.snapOrigin = false; d.prev = id; d.arc = this.tool === "tarc"; d.back = 0; }
    this.render();
  }

  /** A point for a new entity: an existing point, the origin (fixed by a relation), or a new one. */
  private usePoint(p: V2, snapId: string | null, curve: string | null, rels: SkRel[]): string {
    if (snapId && snapId !== ORIGIN) return snapId;
    const id = uid("p");
    this.sk.ents.push({ id, t: "point", x: p[0], y: p[1] });
    if (snapId === ORIGIN) rels.push({ id: uid("r"), t: "coincident", e: [id, ORIGIN] });
    else if (curve) rels.push({ id: uid("r"), t: "onCurve", e: [id, curve] });
    return id;
  }

  private drawClick(raw: V2, e: { detail: number }, exact?: { hv: "horizontal" | "vertical" | null; dims: (made: SkEnt[]) => SkDim[] }) {
    // A typed end that lands on an existing point (within 0.001 mm: typed angles are rounded) joins it, so a
    // typed chain closes on its start, as when clicked.
    const joinTol = Math.min(1e-3, this.px(raw));
    const onPt = exact ? this.sk.ents.find((x): x is SkEnt & { t: "point" } => x.t === "point" && Math.hypot(x.x - raw[0], x.y - raw[1]) <= joinTol)?.id ?? (Math.hypot(raw[0], raw[1]) <= joinTol ? ORIGIN : null) : null;
    const s: Snap = exact ? { p: raw, id: onPt, curve: null, hv: exact.hv } : this.snapPoint(raw, true, true);
    if (!exact && this.quickSnap) this.setQuickSnap(null);
    const p = s.p;
    const d = this.draft;
    const rels: SkRel[] = [];
    const auto = !exact && this.addDims && AUTO_DIM_TOOLS.has(this.tool);
    const before = exact || auto || this.dynMirror ? new Set(this.sk.ents.map(x => x.id)) : null;
    const finish = (label: string) => {
      this.sk.rels.push(...rels);
      let sizes: string[] = [];
      if (before && (exact || auto)) {
        const made = this.sk.ents.filter(x => !before.has(x.id));
        sizes = this.addTypedDims(exact ? exact.dims(made) : this.autoDims(made), made);
      }
      if (this.dynMirror && before) this.mirrorNew(before);
      this.commit(label);
      if (auto) this.openSizes(sizes);
    };
    if (this.tool === "eqn") return;
    if (this.tool === "point") { this.usePoint(p, s.id, s.curve, rels); finish("Add point"); return; }
    if (this.tool === "text") { void this.placeText(p, s.id, s.curve, rels); return; }
    if (this.tool === "tarc") {
      // Tangent Arc tool (FR-SK-015): starts at the end of a line or arc, tangent to it.
      if (!d.pts.length) {
        const ends = s.id && s.id !== ORIGIN ? this.sk.ents.filter(x => !x.cons && (x.t === "line" || x.t === "arc") && (x.a === s.id || x.b === s.id)) : [];
        if (ends.length !== 1) { this.host.toast(t("Click the end of a line or arc to start the tangent arc.")); return; }
        d.pts = [p]; d.ids = [s.id]; d.chainStart = s.id!; d.prev = ends[0].id; d.arc = true; d.back = 0;
        this.statusHint(); this.render(); return;
      }
      const a0 = d.pts.at(-1)!;
      if (!exact && Math.hypot(p[0] - a0[0], p[1] - a0[1]) < this.px(p) * 2) return;
      this.tangentArcClick(p, s, rels, finish, e);
      this.statusHint();
      return;
    }
    if (this.tool === "mline") {
      // Midpoint line (a CAD app): the first click is the middle, the second one end; the other end mirrors it.
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id]; d.snapCurve = s.curve; this.render(); return; }
      const m = d.pts[0];
      if (!exact && Math.hypot(p[0] - m[0], p[1] - m[1]) < this.px(p) * 2) return;
      const mId = this.usePoint(m, d.ids[0], d.snapCurve ?? null, rels);
      const aId = this.usePoint([2 * m[0] - p[0], 2 * m[1] - p[1]], null, null, rels);
      const bId = this.usePoint(p, s.id, s.curve, rels);
      const lid = uid("l");
      this.sk.ents.push({ id: lid, t: "line", a: aId, b: bId });
      rels.push({ id: uid("r"), t: "midpoint", e: [mId, lid] });
      if (s.hv) rels.push({ id: uid("r"), t: s.hv, e: [lid] });
      finish("Add midpoint line");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.lineTool) {
      if (!d.pts.length) { this.inferLine = null; d.pts = [p]; d.ids = [s.id && s.id !== ORIGIN ? s.id : null]; d.chainStart = s.id ?? undefined; d.snapCurve = s.curve; d.snapOrigin = s.id === ORIGIN; d.back = 0; this.render(); return; }
      const a0 = d.pts.at(-1)!;
      if (!exact && Math.hypot(p[0] - a0[0], p[1] - a0[1]) < this.px(p) * 2) return;
      if (d.arc) { this.tangentArcClick(p, s, rels, finish, e); return; }
      const aId = d.ids.at(-1) ?? this.usePoint(a0, d.snapOrigin ? ORIGIN : null, d.snapCurve ?? null, rels);
      const bId = this.usePoint(p, s.id, s.curve, rels);
      const lid = uid("l");
      this.sk.ents.push({ id: lid, t: "line", a: aId, b: bId, ...(this.tool === "cline" ? { cons: true } : {}) });
      if (s.hv) rels.push({ id: uid("r"), t: s.hv, e: [lid] });
      else if (s.rel) rels.push({ id: uid("r"), t: s.rel.t, e: [s.rel.ref, lid] });
      finish("Add line");
      // Chain on from the end, unless the loop closed on an existing point.
      const closed = !!s.id && (s.id !== ORIGIN || d.chainStart === ORIGIN) && d.ids.length > 0;
      if (closed || e.detail >= 2) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; }
      else { d.pts.push(p); d.ids.push(bId); d.snapCurve = null; d.snapOrigin = false; d.prev = lid; d.back = 0; }
      this.render();
      return;
    }
    if (this.tool === "circle" || this.tool === "rect" || this.tool === "crect") {
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id]; d.snapCurve = s.curve; this.render(); return; }
      const c = d.pts[0];
      if (!exact && Math.hypot(p[0] - c[0], p[1] - c[1]) < this.px(p) * 3) return;
      if (this.tool === "circle") {
        const cId = this.usePoint(c, d.ids[0], d.snapCurve ?? null, rels);
        this.sk.ents.push({ id: uid("c"), t: "circle", c: cId, r: Math.hypot(p[0] - c[0], p[1] - c[1]) });
        finish("Add circle");
      } else {
        const [x0, y0, x1, y1] = this.tool === "rect" ? [c[0], c[1], p[0], p[1]] : [2 * c[0] - p[0], 2 * c[1] - p[1], p[0], p[1]];
        const corners: V2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const ids = corners.map((q, i) => (this.tool === "rect" && i === 0 ? this.usePoint(q, d.ids[0], d.snapCurve ?? null, rels) : this.tool === "rect" && i === 2 ? this.usePoint(q, s.id, s.curve, rels) : this.usePoint(q, null, null, rels)));
        const lines = ids.map((a, i) => { const id = uid("l"); this.sk.ents.push({ id, t: "line", a, b: ids[(i + 1) % 4] }); return id; });
        rels.push({ id: uid("r"), t: "horizontal", e: [lines[0]] }, { id: uid("r"), t: "vertical", e: [lines[1]] }, { id: uid("r"), t: "horizontal", e: [lines[2]] }, { id: uid("r"), t: "vertical", e: [lines[3]] });
        if (this.tool === "crect") {
          const diag = uid("l");
          this.sk.ents.push({ id: diag, t: "line", a: ids[0], b: ids[2], cons: true });
          const centre = d.ids[0] === ORIGIN ? ORIGIN : this.usePoint(c, d.ids[0], d.snapCurve ?? null, rels);
          rels.push({ id: uid("r"), t: "midpoint", e: [centre, diag] });
        }
        finish(this.tool === "rect" ? "Add rectangle" : "Add centre rectangle");
      }
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "rect3" || this.tool === "crect3" || this.tool === "pgram") {
      // 3-point rectangles and the parallelogram (FR-SK-013, P2): two clicks set the first side (any angle), the third the other.
      if (d.pts.length && Math.hypot(p[0] - d.pts.at(-1)![0], p[1] - d.pts.at(-1)![1]) < this.px(p) * 3) return;
      if (d.pts.length < 2) { d.pts.push(p); d.ids.push(s.id); if (d.pts.length === 1) d.snapCurve = s.curve; this.render(); return; }
      const q = quadCorners(this.tool, d.pts[0], d.pts[1], p);
      if (!q) return;
      const centred = this.tool === "crect3";
      const ids = q.map((c, i) => this.usePoint(c, centred ? null : i === 0 ? d.ids[0] : i === 1 ? d.ids[1] : i === 2 && this.tool === "pgram" ? s.id : null, !centred && i === 0 ? d.snapCurve ?? null : null, rels));
      const lines = ids.map((a, i) => { const id = uid("l"); this.sk.ents.push({ id, t: "line", a, b: ids[(i + 1) % 4] }); return id; });
      if (this.tool !== "pgram") rels.push({ id: uid("r"), t: "perpendicular", e: [lines[0], lines[1]] });
      rels.push({ id: uid("r"), t: "parallel", e: [lines[0], lines[2]] }, { id: uid("r"), t: "parallel", e: [lines[1], lines[3]] });
      if (centred) {
        const diag = uid("l");
        this.sk.ents.push({ id: diag, t: "line", a: ids[0], b: ids[2], cons: true });
        rels.push({ id: uid("r"), t: "midpoint", e: [d.ids[0] === ORIGIN ? ORIGIN : this.usePoint(d.pts[0], d.ids[0], d.snapCurve ?? null, rels), diag] });
      }
      finish(this.tool === "pgram" ? "Add parallelogram" : centred ? "Add 3-point centre rectangle" : "Add 3-point rectangle");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "pcircle") {
      // Perimeter circle (FR-SK-014, P2): three clicks; one on a line, circle or arc makes the circle tangent to it.
      if (d.pts.length && Math.hypot(p[0] - d.pts.at(-1)![0], p[1] - d.pts.at(-1)![1]) < this.px(p) * 3) return;
      const curves = (d.curves ??= []);
      if (d.pts.length < 2) { d.pts.push(p); d.ids.push(s.id); curves.push(s.id ? null : s.curve); this.render(); return; }
      const all = [...curves, s.id ? null : s.curve], ids = [...d.ids, s.id], at = [...d.pts, p];
      const sol = this.perimFit(at, all);
      if (!sol) { this.host.toast(t("No circle touches those three."), "warn"); return; }
      const id = uid("c");
      this.sk.ents.push({ id, t: "circle", c: this.usePoint(sol.c, null, null, rels), r: sol.r });
      all.forEach((cv, i) => {
        if (cv) rels.push({ id: uid("r"), t: "tangent", e: [cv, id], ...(sol.inner[i] ? { inner: true } : {}) });
        else if (ids[i] && ids[i] !== ORIGIN) rels.push({ id: uid("r"), t: "onCurve", e: [ids[i]!, id] });
      });
      finish("Add perimeter circle");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "circle3" || this.tool === "arc3") {
      if (d.pts.length < 2) {
        if (d.pts.length && Math.hypot(p[0] - d.pts[0][0], p[1] - d.pts[0][1]) < this.px(p) * 3) return;
        d.pts.push(p); d.ids.push(s.id); this.render(); return;
      }
      const [p1, p2] = d.pts;
      const c = circumcentre(p1, p2, p);
      if (!c) { this.host.toast(t("The three points are on one line."), "warn"); return; }
      const r = Math.hypot(p1[0] - c[0], p1[1] - c[1]);
      const cId = this.usePoint(c, null, null, rels);
      if (this.tool === "circle3") {
        const id = uid("c");
        this.sk.ents.push({ id, t: "circle", c: cId, r });
        // Clicked existing points stay on the circle.
        for (const pid of [...d.ids, s.id]) if (pid && pid !== ORIGIN) rels.push({ id: uid("r"), t: "onCurve", e: [pid, id] });
        finish("Add circle");
      } else {
        // Counter-clockwise from start to end through the third point; otherwise the other way round.
        const ang = (q: V2) => Math.atan2(q[1] - c[1], q[0] - c[0]);
        const sweep = (a0: number, a1: number) => { let x = a1 - a0; while (x <= 0) x += Math.PI * 2; return x; };
        const ccw = sweep(ang(p1), ang(p)) < sweep(ang(p1), ang(p2));
        const aId = this.usePoint(p1, d.ids[0], null, rels), bId = this.usePoint(p2, d.ids[1], null, rels);
        this.sk.ents.push({ id: uid("a"), t: "arc", c: cId, a: ccw ? aId : bId, b: ccw ? bId : aId });
        finish("Add arc");
      }
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "conic" || this.tool === "parabola") {
      // FR-SK-021. Conic: start, end, top vertex (where the end tangents meet), then a point that sets rho.
      // Parabola: focus, vertex, then the start and end (moved square to the axis onto the curve).
      if (d.pts.length && Math.hypot(p[0] - d.pts.at(-1)![0], p[1] - d.pts.at(-1)![1]) < this.px(p) * 3) return;
      if (d.pts.length < 3) { d.pts.push(p); d.ids.push(s.id); this.render(); return; }
      let ids: string[], rho = 0.5;
      if (this.tool === "conic") {
        const [a, b, v] = d.pts;
        if (Math.abs((b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])) < 1e-9 * (1 + Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2)) { this.host.toast(t("The top vertex is on the line between the ends."), "warn"); return; }
        rho = rhoAt(a, v, b, p);
        ids = [this.usePoint(a, d.ids[0], null, rels), this.usePoint(v, d.ids[2], null, rels), this.usePoint(b, d.ids[1], null, rels)];
      } else {
        const q = parabolaFrom(d.pts[0], d.pts[1], d.pts[2], p);
        if (!q) { this.host.toast(t("Pick the ends on either side of the axis, away from each other."), "warn"); return; }
        ids = [this.usePoint(q[0], null, null, rels), this.usePoint(q[1], null, null, rels), this.usePoint(q[2], null, null, rels)];
      }
      const id = uid("s");
      this.sk.ents.push({ id, t: "spline", pts: ids, kind: this.tool, ...(this.tool === "conic" ? { rho: Math.round(rho * 1e4) / 1e4 } : {}) });
      finish(this.tool === "conic" ? "Add conic" : "Add parabola");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "spline" || this.tool === "sspline") {
      // Through the clicked points (FR-SK-019): a double-click ends it, the first point again closes it.
      // A style spline (P5) takes the clicks as its control polygon and stays open.
      const style = this.tool === "sspline";
      const near = (q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < this.px(p) * 3;
      const closing = !style && d.pts.length >= 3 && (near(d.pts[0]) || (!!s.id && s.id === d.ids[0]));
      const again = d.pts.length > 0 && near(d.pts.at(-1)!);
      if (!closing && !again) { d.pts.push(p); d.ids.push(s.id); if (d.pts.length === 1) d.snapCurve = s.curve; }
      if (!closing && !(e.detail >= 2 || again)) { this.render(); return; }
      if (d.pts.length < 2) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; this.render(); return; }
      const ids = d.pts.map((q, i) => this.usePoint(q, d.ids[i] ?? null, i === 0 ? d.snapCurve ?? null : null, rels));
      this.sk.ents.push({ id: uid("s"), t: "spline", pts: ids, ...(closing ? { closed: true } : {}), ...(style ? { kind: "style" as const } : {}) });
      finish(style ? "Add style spline" : "Add spline");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "ellipse" || this.tool === "earc") {
      // Centre, end of the major axis, then a point on the ellipse (sets the minor radius; an
      // elliptical arc starts there), and for an arc the end, counter-clockwise (FR-SK-018).
      const need = this.tool === "ellipse" ? 3 : 4;
      if (d.pts.length && Math.hypot(p[0] - d.pts.at(-1)![0], p[1] - d.pts.at(-1)![1]) < this.px(p) * 3) return;
      if (d.pts.length === 2 && !this.draftEll(d.pts[0], d.pts[1], p)) return;
      if (d.pts.length + 1 < need) { d.pts.push(p); d.ids.push(s.id); if (d.pts.length === 1) d.snapCurve = s.curve; this.render(); return; }
      const [c, a] = d.pts;
      const E = this.draftEll(c, a, d.pts[2] ?? p)!;
      const side = Math.sign(ellLocal(E, d.pts[2] ?? p)[1]) || 1;
      const cId = this.usePoint(c, d.ids[0], d.snapCurve ?? null, rels);
      const aId = this.usePoint(a, d.ids[1], null, rels);
      const bId = this.usePoint(ellPt(E, (side * Math.PI) / 2), null, null, rels);
      const id = uid("e");
      if (this.tool === "ellipse") {
        this.sk.ents.push({ id, t: "ellipse", c: cId, a: aId, b: bId });
        finish("Add ellipse");
      } else {
        const p0 = this.usePoint(ellPt(E, ellParam(E, d.pts[2])), null, null, rels);
        const p1 = this.usePoint(ellPt(E, ellParam(E, p)), null, null, rels);
        this.sk.ents.push({ id, t: "ellipse", c: cId, a: aId, b: bId, p0, p1 });
        finish("Add elliptical arc");
      }
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "slot" || this.tool === "cslot") {
      // Straight slot: two centres, or (centrepoint) the middle and one end, then the width (FR-SK-017).
      if (d.pts.length < 2) {
        if (d.pts.length && Math.hypot(p[0] - d.pts[0][0], p[1] - d.pts[0][1]) < this.px(p) * 3) return;
        d.pts.push(p); d.ids.push(s.id); this.render(); return;
      }
      const centred = this.tool === "cslot";
      const [c1, c2] = slotCentres(d.pts[0], d.pts[1], centred);
      const w = Math.abs(lineSide(c1, c2, p));
      if (w < this.px(p) * 2) return;
      const made = this.addSlot(c1, c2, w, centred ? null : d.ids[0], d.ids[1], rels);
      if (centred) rels.push({ id: uid("r"), t: "midpoint", e: [this.usePoint(d.pts[0], d.ids[0], null, rels), made.axis] });
      const u = norm2(sub2(c2, c1)), n: V2 = [-u[1], u[0]], g = this.px(p) * 28;
      this.sk.rels.push(...rels.splice(0));
      const sizes = this.slotSizes([
        { t: "diameter", e: [made.cap1], pos: [c1[0] - u[0] * (w + g), c1[1] - u[1] * (w + g)] },
        { t: "distance", e: [made.axis], pos: [(c1[0] + c2[0]) / 2 + n[0] * (w + g), (c1[1] + c2[1]) / 2 + n[1] * (w + g)] },
      ]);
      finish(centred ? "Add centerpoint slot" : "Add slot");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      this.openSizes(sizes);
      return;
    }
    if (this.tool === "aslot" || this.tool === "aslot3") {
      // Arc slots: centre, start, end (centrepoint) or start, end, a point on the arc (3-point), then the width.
      if (d.pts.length && Math.hypot(p[0] - d.pts.at(-1)![0], p[1] - d.pts.at(-1)![1]) < this.px(p) * 3) return;
      if (d.pts.length < 3) {
        if (d.pts.length === 2 && !this.slotAxis(d.pts[0], d.pts[1], p)) return;
        d.pts.push(p); d.ids.push(s.id); this.render(); return;
      }
      const ax = this.slotAxis(d.pts[0], d.pts[1], d.pts[2])!;
      const w = arcSlotHalfWidth(ax, p);
      if (w < this.px(p) * 2) return;
      // The centrepoint slot's end lies on the start's radius: it keeps the clicked point when that is on (or within 2 px of) that radius (exam bug 41).
      const endOn = d.ids[2] && Math.abs(Math.hypot(d.pts[2][0] - ax.o[0], d.pts[2][1] - ax.o[1]) - ax.r) < this.px(p) * 2;
      const [oId, c1Id, c2Id] = this.tool === "aslot" ? [d.ids[0], d.ids[1], endOn ? d.ids[2] : null]
        : ax.swapped ? [null, d.ids[1], d.ids[0]] : [null, d.ids[0], d.ids[1]];
      const k = arcSlotCorners(ax, w);
      const P = (q: V2, id: string | null) => this.usePoint(q, id, null, rels);
      const made = arcSlotEnts({ o: P(ax.o, oId), c1: P(ax.c1, c1Id), c2: P(ax.c2, c2Id), o1: P(k.o1, null), o2: P(k.o2, null), i1: P(k.i1, null), i2: P(k.i2, null) }, uid);
      this.sk.ents.push(...made.ents);
      this.sk.rels.push(...rels.splice(0), ...made.rels);
      const out = (c: V2, r: number): V2 => { const v = norm2(sub2(c, ax.o)); return [ax.o[0] + v[0] * r, ax.o[1] + v[1] * r]; };
      const g = this.px(p) * 28;
      const sizes = this.slotSizes([
        { t: "diameter", e: [made.cap1], pos: out(ax.c1, ax.r + w + g) },
        { t: "radius", e: [made.centre], pos: out(arcSlotOutline(ax, 0)[0][24], ax.r * 0.55) },
      ]);
      finish("Add arc slot");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      this.openSizes(sizes);
      return;
    }
    if (this.tool === "polygon") {
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id]; d.snapCurve = s.curve; this.render(); return; }
      const c = d.pts[0];
      const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (r < this.px(p) * 3) return;
      const n = this.polySides, a0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
      const cId = this.usePoint(c, d.ids[0], d.snapCurve ?? null, rels);
      const circ = uid("c");
      this.sk.ents.push({ id: circ, t: "circle", c: cId, r, cons: true });
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const q: V2 = [c[0] + r * Math.cos(a0 + (2 * Math.PI * i) / n), c[1] + r * Math.sin(a0 + (2 * Math.PI * i) / n)];
        const id = i === 0 ? this.usePoint(q, s.id, null, rels) : this.usePoint(q, null, null, rels);
        ids.push(id);
        rels.push({ id: uid("r"), t: "onCurve", e: [id, circ] });
      }
      const lines = ids.map((a, i) => { const id = uid("l"); this.sk.ents.push({ id, t: "line", a, b: ids[(i + 1) % n] }); return id; });
      for (let i = 1; i < n; i++) rels.push({ id: uid("r"), t: "equal", e: [lines[0], lines[i]] });
      finish("Add polygon");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
      return;
    }
    if (this.tool === "arc") {
      if (d.pts.length < 2) {
        d.pts.push(p); d.ids.push(s.id);
        if (d.pts.length === 2) { this.arcTurn = 0; this.arcLast = Math.atan2(p[1] - d.pts[0][1], p[0] - d.pts[0][0]); }
        this.render(); return;
      }
      const [c, a] = d.pts;
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const ang = Math.atan2(p[1] - c[1], p[0] - c[0]);
      const b: V2 = s.id ? p : [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
      const cId = this.usePoint(c, d.ids[0], null, rels), aId = this.usePoint(a, d.ids[1], null, rels), bId = this.usePoint(b, s.id, null, rels);
      // The arc runs the way the mouse went round the centre (a CAD app), clockwise as well as counter-clockwise (exam #92).
      this.trackArc(p);
      const cw = this.arcTurn < 0;
      this.sk.ents.push({ id: uid("a"), t: "arc", c: cId, a: cw ? bId : aId, b: cw ? aId : bId });
      finish("Add arc");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
    }
  }

  // ---------- dimensions ----------

  private dimClick(p: V2, e: PointerEvent) {
    const dd = this.dimDraft;
    // With one item picked, a click on another item (in the sketch or on the model) dimensions the pair.
    // Smart Dimension takes a model edge whole, as a CAD app does: its midpoint is not offered.
    const modelPick = () => { const ms = this.modelSnapAt(p, false); return ms?.at === "mid" ? { ...ms, p, at: "on" as const } : ms; };
    const other = dd.dim && dd.picks.length === 1 ? this.hits(p).find(x => x.id !== dd.picks[0].id) ?? (this.hits(p).length ? undefined : modelPick()) : undefined;
    // An arc and one of its ends picked: its other end makes an arc length (a CAD app: the arc and both ends).
    const third = dd.dim && dd.picks.length === 2 ? this.hits(p).find(x => this.arcLenSet([...dd.picks.map(q => q.id), x.id])) : undefined;
    if (other || third) dd.dim = null;
    if (dd.dim) {
      // Otherwise the next click places the dimension and asks for its value.
      this.placeDimDraft(p);
      const dim = dd.dim;
      this.dimDraft = { picks: [], dim: null };
      this.addDimension(dim);
      return;
    }
    let h = third ?? this.hits(p)[0];
    if (!h) {
      // A model vertex or edge: converted as construction geometry with an On edge relation, then dimensioned.
      const ms = modelPick();
      if (ms) {
        const r = this.materialize(ms);
        const id = r.id ?? r.curve;
        const ent = id ? this.ent(id) : undefined;
        if (ent && ent.t !== "ellipse" && ent.t !== "spline" && ent.t !== "text") h = { id: ent.id, kind: ent.t, d: 0 };
      }
    }
    if (!h) { this.selection.clear(); dd.picks = []; this.render(); return; }
    if (!dd.picks.some(x => x.id === h!.id)) dd.picks.push(h);
    if (e.shiftKey && (h.kind === "circle" || h.kind === "arc")) (dd.side ??= new Map()).set(h.id, p);
    this.selection = new Set(dd.picks.map(x => x.id));
    const kinds = dd.picks.map(x => (x.kind === "origin" ? "point" : x.kind));
    const ids = dd.picks.map(x => x.id);
    // One curve: its size. Two items: the relation between them.
    let dim: SkDim | null = null;
    const mk = (t: SkDim["t"], e: string[]): SkDim => ({ id: uid("d"), name: this.nextDimName(), t, e, val: { v: 0 }, pos: p });
    if (ids.length === 1) {
      if (kinds[0] === "line") dim = mk("distance", ids);
      else if (kinds[0] === "circle") dim = mk("diameter", ids);
      else if (kinds[0] === "arc") dim = mk("radius", ids);
    } else if (ids.length === 2) {
      if (kinds[0] === "line" && kinds[1] === "line") dim = this.parallel(ids[0], ids[1]) ? mk("distance", ids) : mk("angle", ids);
      else { dim = mk("distance", ids); this.shiftConds(dim, dd.side); }
    } else if (ids.length === 3) {
      const arc = this.arcLenSet(ids);
      if (arc) dim = mk("arclen", [arc]);
    }
    if (dim) { dd.dim = dim; this.placeDimDraft(p); }
    else if (ids.length > 2) { dd.picks = [h]; this.selection = new Set([h.id]); }
    this.render();
    void e;
  }

  /**
   * Ordinate dimensions (FR-SK-063): click the base (a point, circle or the origin), then where the row of
   * values goes, then each point to measure from the base along X (hord) or Y (vord).
   */
  private ordClick(p: V2) {
    const od = this.ordDraft;
    const h = this.hits(p).find(x => x.kind === "point" || x.kind === "origin" || x.kind === "circle" || x.kind === "arc");
    const ax = this.tool === "hord" ? 1 : 0;
    if (!od.base) {
      if (!h) return;
      od.base = h.id;
      this.selection = new Set([h.id]);
      this.render();
      return;
    }
    if (!h || h.id === od.base) {
      // An empty click (or the base again) sets the row of values.
      od.row = p[ax];
      this.render();
      return;
    }
    const base = this.centreOf(od.base), q = this.centreOf(h.id);
    if (od.row === null) od.row = base[ax] + (q[ax] >= base[ax] ? -1 : 1) * this.px(base) * 30;
    const pos: V2 = ax === 1 ? [q[0], od.row] : [od.row, q[1]];
    const dim: SkDim = { id: uid("d"), name: this.nextDimName(), t: this.tool === "hord" ? "hdistance" : "vdistance", e: [od.base, h.id], val: { v: 0 }, pos, ord: true };
    this.selection = new Set([od.base]);
    this.addDimension(dim);
  }

  /** The arc when the ids are an arc and both its end points, in any order (an arc length dimension). */
  private arcLenSet(ids: string[]): string | null {
    if (ids.length !== 3 || new Set(ids).size !== 3) return null;
    for (const id of ids) {
      const e = this.ent(id);
      if (e?.t === "arc" && ids.includes(e.a) && ids.includes(e.b)) return id;
    }
    return null;
  }

  /**
   * Arc conditions from Shift+clicks (FR-SK-060): a circle or arc clicked with Shift on the side towards the
   * other item is measured from its near side (min), on the side away from it from its far side (max).
   */
  private shiftConds(dim: SkDim, side: Map<string, V2> | undefined) {
    if (!side?.size) return;
    const cond: ArcCond[] = dim.e.map(() => "c");
    dim.e.forEach((id, i) => {
      const at = side.get(id), e = this.ent(id);
      if (!at || (e?.t !== "circle" && e?.t !== "arc")) return;
      const c = this.pt(e.c), o = dim.e[1 - i], oe = o === ORIGIN ? undefined : this.ent(o);
      // Towards the other item: its centre or point, or its foot on a line.
      let q = this.centreOf(o);
      if (oe?.t === "line") { const a = this.pt(oe.a), u = sub2(this.pt(oe.b), a), t0 = dot2(sub2(c, a), u) / (dot2(u, u) || 1); q = [a[0] + u[0] * t0, a[1] + u[1] * t0]; }
      cond[i] = dot2(sub2(at, c), sub2(q, c)) >= 0 ? "min" : "max";
    });
    if (cond.some(c => c !== "c")) dim.cond = cond;
  }

  /** Sets where a distance meets one of its circles/arcs (FR-SK-060), keeping the geometry where it is. */
  setArcCond(id: string, i: number, c: ArcCond) {
    const d = this.sk.dims.find(x => x.id === id);
    if (!d || (d.t !== "distance" && d.t !== "hdistance" && d.t !== "vdistance") || d.off || d.ord) return;
    const cond: ArcCond[] = d.e.map((_, k) => d.cond?.[k] ?? "c");
    cond[i] = c;
    if (cond.every(x => x === "c")) delete d.cond; else d.cond = cond;
    if (!d.val.expr) d.val.v = measureDim(this.sk, d);
    this.commit("Arc condition");
  }

  /** Context menu rows for the arc conditions of one selected distance (FR-SK-060). */
  private arcCondRows(d: SkDim): [string, () => void, string?][] {
    if ((d.t !== "distance" && d.t !== "hdistance" && d.t !== "vdistance") || d.off || d.ord || d.e.length !== 2) return [];
    const round = d.e.map((id, i) => ({ id, i })).filter(x => { const e = x.id === ORIGIN ? undefined : this.ent(x.id); return e?.t === "circle" || e?.t === "arc"; });
    const head = (i: number) => (round.length < 2 ? "Arc condition" : i === round[0].i ? "First arc condition" : "Second arc condition");
    const name: Record<ArcCond, string> = { c: "Centre", min: "Near side (min)", max: "Far side (max)" };
    return round.flatMap(({ i }) => (["c", "min", "max"] as ArcCond[]).map(c => [`${t(head(i))}: ${t(name[c])}`, () => this.setArcCond(d.id, i, c), (d.cond?.[i] ?? "c") === c ? "✓" : undefined] as [string, () => void, string?]));
  }

  private centreOf(id: string): V2 {
    const e = id === ORIGIN ? undefined : this.ent(id);
    return e && (e.t === "circle" || e.t === "arc") ? this.pt(e.c) : this.pt(id);
  }

  private parallel(l1: string, l2: string) {
    const a = this.ent(l1), b = this.ent(l2);
    if (a?.t !== "line" || b?.t !== "line") return false;
    const u = sub2(this.pt(a.b), this.pt(a.a)), v = sub2(this.pt(b.b), this.pt(b.a));
    return Math.abs(u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v) || 1) < 1e-6;
  }

  /** While placing: horizontal, vertical or aligned by where the cursor is; the angle's quadrant. */
  private placeDimDraft(p: V2) {
    const dim = this.dimDraft.dim!;
    dim.pos = p;
    if (this.dimDraft.lock) { dim.val.v = measureDim(this.sk, dim); return; }
    this.diaSide(dim, p);
    const pts = this.dimPoints(dim);
    if ((dim.t === "distance" || dim.t === "hdistance" || dim.t === "vdistance") && pts) {
      const [a, b] = pts;
      const inX = p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]);
      const inY = p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1]);
      const lineLen = dim.e.length === 1 || this.ent(dim.e[0])?.t === "line" && this.ent(dim.e[1] ?? "")?.t === "line";
      if (!dim.dia && (!lineLen || dim.e.length === 1)) {
        const span = (x: number) => Math.abs(x) > 1e-9;
        if (inX && !inY && span(b[0] - a[0]) && span(b[1] - a[1])) dim.t = "hdistance";
        else if (inY && !inX && span(b[0] - a[0]) && span(b[1] - a[1])) dim.t = "vdistance";
        else dim.t = "distance";
      }
    }
    if (dim.t === "angle") {
      const l1 = this.ent(dim.e[0]), l2 = this.ent(dim.e[1]);
      if (l1?.t === "line" && l2?.t === "line") {
        const I = intersect(this.pt(l1.a), this.pt(l1.b), this.pt(l2.a), this.pt(l2.b)) ?? this.pt(l1.a);
        const u = sub2(this.pt(l1.b), this.pt(l1.a)), v = sub2(this.pt(l2.b), this.pt(l2.a)), w = sub2(p, I);
        dim.flip = [dot2(w, u) < 0, dot2(w, v) < 0];
      }
    }
    dim.val.v = measureDim(this.sk, dim);
  }

  /**
   * A distance from a centerline (construction line) to a point or a parallel line becomes a diameter when
   * the text is placed on the far side of the centerline, as for a revolve profile (FR-SK-063).
   */
  private diaSide(dim: SkDim, p: V2) {
    delete dim.dia;
    if (dim.e.length !== 2 || (dim.t !== "distance" && dim.t !== "hdistance" && dim.t !== "vdistance")) return;
    const isCl = (id: string) => { const e = id === ORIGIN ? undefined : this.ent(id); return e?.t === "line" && !!e.cons; };
    if (!isCl(dim.e[0]) && isCl(dim.e[1])) dim.e.reverse();
    if (!isCl(dim.e[0])) return;
    const o = this.ent(dim.e[1]);
    if (o?.t === "line" && !this.parallel(dim.e[0], dim.e[1])) return;
    if (o && o.t !== "line" && o.t !== "point" && o.t !== "circle" && o.t !== "arc") return;
    const l = this.ent(dim.e[0]) as SkEnt & { t: "line" };
    const a = this.pt(l.a), u = sub2(this.pt(l.b), a);
    const q = o?.t === "line" ? this.pt(o.a) : this.centreOf(dim.e[1]);
    const side = (x: V2) => u[0] * (x[1] - a[1]) - u[1] * (x[0] - a[0]);
    if (side(q) * side(p) < 0) { dim.dia = true; dim.t = "distance"; }
  }

  private nextDimName(sk: SketchFeature = this.sk) { return nextDimName(sk); }

  /** Adds a placed dimension: driving when it adds information, otherwise as a reference. */
  private addDimension(dim: SkDim) {
    dim.val.v = measureDim(this.sk, dim);
    const r = tryAdd(this.sk, { dim });
    if (!r.ok || r.redundant) {
      dim.driven = true;
      this.sk.dims.push(dim);
      this.commit("Add dimension");
      this.host.toast(t("The sketch is already defined there: added as a reference dimension."), "info");
      return;
    }
    this.sk = r.sketch;
    this.info = r.result;
    this.commit("Add dimension");
    this.selection.clear();
    this.render();
    // After the click's own focus change, or the new box would lose focus at once.
    setTimeout(() => this.editDim(dim.id), 0);
  }

  /** Opens the Modify box on a dimension (FR-UI-114): the sketch follows the value as it is typed. */
  editDim(id: string, then?: () => void) {
    if (this.disposed) return;
    const dim = this.sk.dims.find(d => d.id === id);
    if (!dim || dim.driven) return;
    const label = this.labels.get(id);
    if (!label) return;
    this.closeInput(false);
    const u = this.host.unit();
    const orig = this.sk, origInfo = this.info;
    const lr = label.getBoundingClientRect();
    const value = dim.val.expr ?? (dim.t === "angle" ? trimNum((dim.val.v * 180) / Math.PI, 4) : trimNum(dim.val.v / u.mm, 6));
    // The sketch with the typed value, solved; an error key when it cannot be.
    const tryValue = (text: string): { sk: SketchFeature; r: SolveResult } | { err: string; params?: Record<string, string | number> } | null => {
      let v: number;
      try { v = evaluate(text, dim.t === "angle" ? "angle" : "length", dim.t === "angle" ? "deg" : this.host.unit().name, this.host.vars?.() ?? {}); }
      catch (err) { return { err: (err as ExprError).key ?? String(err), params: (err as ExprError).params }; }
      if (dim.t !== "angle" && !(v > 0)) return { err: "The value must be more than 0." };
      if (Math.abs(v - dim.val.v) < 1e-12 && (dim.val.expr ?? "") === (isPlain(text) ? "" : text.trim())) return null;
      const next: SketchFeature = structuredClone(orig);
      const nd = next.dims.find(d => d.id === dim.id)!;
      nd.val = isPlain(text) ? { v } : { v, expr: text.trim() };
      const r = solve(next);
      if (r.status !== "ok") return { err: "That value cannot be reached with the other relations and dimensions." };
      return { sk: next, r };
    };
    const restore = () => { if (this.sk !== orig && !this.disposed) { this.sk = orig; this.info = origInfo; this.render(); } };
    const box = new ModifyBox({
      at: { x: lr.right, y: lr.top + lr.height / 2 },
      title: `${dim.name}@${this.sk.name}`,
      name: {
        value: dim.name, suffix: this.sk.name,
        check: n => !validDimName(n) ? "A name starts with a letter and has only letters, digits and _." : orig.dims.some(d => d.id !== dim.id && d.name === n) ? "Another dimension of this sketch has that name." : "",
      },
      value,
      step: stepFor(dim.t === "angle" ? "angle" : "length", u.name),
      incKey: dim.t === "angle" ? "angle" : "length",
      live: true,
      preview: text => {
        if (this.disposed) return;
        const r = tryValue(text);
        if (!r || "err" in r) { restore(); return; }
        this.sk = r.sk;
        this.info = r.r;
        this.render();
      },
      accept: (text, name) => {
        if (this.input === box.input) this.input = null;
        if (this.disposed) return true;
        const r = tryValue(text);
        if (r && "err" in r) { restore(); this.host.toast(t(r.err, r.params), "error"); }
        else if (!r) restore();
        else {
          this.sk = r.sk;
          this.info = r.r;
          this.commit("Change dimension");
          this.render();
        }
        // A new name typed in the title (FR-SK-065) renames the dimension as its own step.
        if (name) { const err = this.renameDim(dim.id, name); if (err) this.host.toast(t(err), "error"); }
        if (then) setTimeout(then, 0);
        return true;
      },
      cancel: () => { if (this.input === box.input) this.input = null; restore(); },
    });
    this.input = box.input;
    this.modify = box;
  }

  private modify: ModifyBox | null = null;

  private closeInput(apply: boolean) {
    const box = this.modify;
    this.modify = null;
    if (box) box.close(apply);
    this.input = null;
  }

  /** Renames a dimension (FR-SK-065); expressions that use "old@Sketch" follow. Returns an error key, or "". */
  renameDim(id: string, name: string): string {
    const dim = this.sk.dims.find(d => d.id === id);
    name = name.trim();
    if (!dim || name === dim.name) return "";
    if (!validDimName(name)) return "A name starts with a letter and has only letters, digits and _.";
    if (this.sk.dims.some(d => d !== dim && d.name === name)) return "Another dimension of this sketch has that name.";
    const from = `${dim.name}@${this.sk.name}`, to = `${name}@${this.sk.name}`;
    dim.name = name;
    for (const d of this.sk.dims) if (d.val.expr) d.val.expr = renameIn(d.val.expr, from, to);
    this.commit("Rename dimension");
    this.host.renamedDim?.(from, to);
    this.render();
    return "";
  }

  // ---------- relations, construction, delete ----------

  /** Relations that make sense for the current selection. */
  validRelations(): RelKind[] {
    const kinds = [...this.selection].map(id => (id === ORIGIN ? "point" : this.ent(id)?.t)).filter(Boolean) as string[];
    const n = (k: string) => kinds.filter(x => x === k).length;
    const circ = n("circle") + n("arc");
    const out: RelKind[] = [];
    const total = kinds.length;
    if (!total) return out;
    if ((total === 1 && n("line") === 1) || (total === 2 && n("point") === 2)) out.push("horizontal", "vertical");
    if (total === 2 && n("point") === 2) out.push("coincident");
    if (total === 2 && n("point") === 1 && (n("line") || circ)) out.push("coincident");
    if (total === 2 && n("line") === 2) out.push("parallel", "perpendicular", "collinear", "equal");
    if (total === 2 && circ === 2) out.push("equal", "concentric", "tangent");
    if (total === 2 && n("line") === 1 && circ === 1) out.push("tangent");
    if (total === 2 && n("point") === 1 && circ === 1) out.push("concentric");
    if (total === 2 && n("point") === 1 && n("line") === 1) out.push("midpoint");
    if (total === 2 && n("point") === 1 && n("ellipse") === 1) out.push("coincident", "concentric");
    if (total === 2 && n("ellipse") + circ === 2 && n("ellipse")) out.push("concentric");
    if (total === 3 && n("line") >= 1 && (n("point") === 2 || n("line") === 3)) out.push("symmetric");
    if (total === 3 && n("point") === 1 && n("line") + circ + n("ellipse") === 2) out.push("intersection");
    // A spline and a line, arc or spline meeting at an end: tangent and equal curvature (FR-SK-050/051).
    if (total === 2 && n("spline") >= 1 && n("spline") + n("line") + n("arc") === 2) {
      const [a, b] = [...this.selection];
      if (curveJoint(this.sk, a, b)) out.push("tangent", "curvature");
    }
    // Pierce: one point, then a model edge that crosses the sketch plane (FR-SK-051).
    if (total === 1 && n("point") === 1 && !this.selection.has(ORIGIN) && this.host.modelEdges && this.host.edgeRef) out.push("pierce");
    if (total >= 1 && !this.selection.has(ORIGIN)) out.push("fix");
    return [...new Set(out)];
  }

  addRelation(kind: RelKind) {
    if (!this.validRelations().includes(kind)) return;
    let e = [...this.selection];
    if (kind === "pierce") { this.startPierce(e[0]); return; }
    const kindOf = (id: string) => (id === ORIGIN ? "point" : this.ent(id)?.t);
    if (kind === "symmetric") {
      // The line of symmetry last: a construction line if there is one.
      const lines = e.filter(id => kindOf(id) === "line");
      const axis = lines.find(id => (this.ent(id) as SkEnt & { cons?: boolean }).cons) ?? lines.at(-1)!;
      e = [...e.filter(id => id !== axis), axis];
    }
    if (kind === "midpoint" || kind === "coincident" || kind === "intersection") e.sort((a, b) => (kindOf(a) === "point" ? -1 : 0) - (kindOf(b) === "point" ? -1 : 0));
    const rels: SkRel[] = kind === "fix" ? [{ id: uid("r"), t: "fix", e }] : [{ id: uid("r"), t: kind === "coincident" && kindOf(e[1]) !== "point" ? "onCurve" : kind, e }];
    if (kind === "tangent" && e.every(id => kindOf(id) === "circle" || kindOf(id) === "arc")) {
      // Inside or outside: whichever is closer now.
      const [c1, c2] = e.map(id => this.ent(id)!) as (SkEnt & { t: "circle" | "arc" })[];
      const rOf = (c: SkEnt & { t: "circle" | "arc" }) => (c.t === "circle" ? c.r : Math.hypot(this.pt(c.a)[0] - this.pt(c.c)[0], this.pt(c.a)[1] - this.pt(c.c)[1]));
      const d = Math.hypot(this.pt(c1.c)[0] - this.pt(c2.c)[0], this.pt(c1.c)[1] - this.pt(c2.c)[1]);
      rels[0].inner = Math.abs(d - Math.abs(rOf(c1) - rOf(c2))) < Math.abs(d - rOf(c1) - rOf(c2));
    }
    const r = tryAdd(this.sk, { rel: rels[0] });
    if (!r.ok) { this.host.toast(t("That relation conflicts with the sketch's other relations and dimensions."), "error"); return; }
    this.sk = r.sketch;
    this.info = r.result;
    if (r.redundant) this.host.toast(t("The sketch already had that relation (redundant)."), "warn");
    this.commit(`Add ${REL_NAME[kind].toLowerCase()} relation`);
    this.render();
  }

  /**
   * Fully define sketch (FR-SK-045, a CAD app's Fully Define Sketch): adds horizontal/vertical relations to lines
   * within 1° of the axes, diameters of circles and radii of arcs, then horizontal and vertical dimensions from the
   * origin to each point (curve points first, nearest the origin first), keeping only items that remove freedom,
   * until nothing is free. Returns how many items were added (one undo step).
   */
  fullyDefine(): number {
    const { sketch, added } = fullyDefineSketch(this.sk);
    if (!added) return 0;
    this.sk = sketch;
    this.info = solve(this.sk);
    this.commit("Fully define sketch");
    this.render();
    return added;
  }

  /** Fully define sketch from a menu or button: runs it and says what happened. */
  fullyDefineUi(): number {
    const was = solve(this.sk);
    if (was.status !== "ok") { this.host.toast(t("Fix the sketch's errors first."), "error"); return 0; }
    if (was.dof === 0) { this.host.toast(t("The sketch is already fully defined.")); return 0; }
    const n = this.fullyDefine();
    if (!n) this.host.toast(t("Nothing could be added."), "warn");
    else this.host.toast(this.info.dof === 0 ? t("Fully defined: {n} items added.", { n }) : t("{n} items added; {d} degrees of freedom left.", { n, d: this.info.dof }));
    return n;
  }

  /** Two points selected (not the origin): they can be merged into one (FR-SK-051). */
  canMerge(): boolean {
    const ids = [...this.selection];
    return ids.length === 2 && !ids.includes(ORIGIN) && ids.every(id => this.ent(id)?.t === "point");
  }

  /** Merge points (FR-SK-051): the second point is replaced by the first everywhere, then removed. */
  mergePoints() {
    if (!this.canMerge()) return false;
    const [keep, drop] = [...this.selection];
    const probe = tryAdd(this.sk, { rel: { id: uid("r"), t: "coincident", e: [keep, drop] } });
    if (!probe.ok) { this.host.toast(t("Those points cannot meet with the sketch's other relations and dimensions."), "error"); return false; }
    const next: SketchFeature = structuredClone(probe.sketch);
    next.rels = next.rels.filter(r => !(r.t === "coincident" && r.e.includes(keep) && r.e.includes(drop)));
    const sw = (id: string) => (id === drop ? keep : id);
    for (const e of next.ents) {
      const o = e as unknown as Record<string, unknown>;
      for (const k of ["a", "b", "c", "p0", "p1"]) if (typeof o[k] === "string") o[k] = sw(o[k] as string);
      if (e.t === "spline") e.pts = e.pts.map(sw);
    }
    for (const r of next.rels) r.e = r.e.map(sw);
    for (const d of next.dims) d.e = d.e.map(sw);
    // Relations and dimensions left between a point and itself mean nothing now.
    next.rels = next.rels.filter(r => new Set(r.e).size === r.e.length);
    next.dims = next.dims.filter(d => new Set(d.e).size === d.e.length);
    // A line or arc between the two points has no length left: it goes, with what refers to it.
    const gone = new Set([drop, ...next.ents.filter(e => (e.t === "line" || e.t === "arc") && e.a === e.b).map(e => e.id)]);
    next.ents = next.ents.filter(e => !gone.has(e.id));
    next.rels = next.rels.filter(r => !r.e.some(x => gone.has(x)));
    next.dims = next.dims.filter(d => !d.e.some(x => gone.has(x)));
    this.sk = next;
    this.selection = new Set([keep]);
    this.info = solve(this.sk);
    this.commit("Merge points");
    this.render();
    this.emitSel();
    return true;
  }

  toggleConstruction() {
    let n = 0;
    for (const id of this.selection) {
      const e = this.ent(id);
      if (e && e.t !== "point") { e.cons = !e.cons; n++; }
    }
    if (n) { this.commit("Toggle construction"); this.render(); }
  }

  /** Ctrl+A: every sketch curve and point (the origin is not an entity). */
  // ---------- blocks (FRS 2.2) ----------

  /** The block instance an id belongs to, unless that instance is being edited (Edit Block). */
  private lockedInsert(id: string): BlockInsert | null {
    const ins = insertOf(this.sk, id);
    return ins && ins.id !== this.sk.editBlock?.insert ? ins : null;
  }

  /** The one block instance the selection is, when it is exactly one instance's entities. */
  selectedInsert(): BlockInsert | null {
    const sel = [...this.selection];
    if (!sel.length) return null;
    const ins = this.lockedInsert(sel[0]);
    if (!ins || !sel.every(id => insertOf(this.sk, id)?.id === ins.id)) return null;
    return ins;
  }

  /** Make Block from the selection; returns an English message key when it cannot. */
  makeBlock(): string | null {
    const r = makeBlock(this.sk, this.selection);
    if (r === "NOTHING") return "Select the sketch entities for the block first.";
    if (r === "TEXT") return "Text cannot go into a block.";
    if (r === "INSERT") return "A block cannot hold another block; explode it first.";
    this.sk = r.sk;
    this.selection = new Set(insertEnts(this.sk, r.insert.id));
    this.commit("Make block");
    this.render();
    this.emitSel();
    return null;
  }

  /** Insert Block: another instance at `at` (sketch coordinates), selected. */
  insertBlock(def: SketchBlock, at: V2 = [0, 0]) {
    const r = insertBlock(this.sk, def, at);
    this.sk = r.sk;
    this.selection = new Set(insertEnts(this.sk, r.insert.id));
    this.commit("Insert block");
    this.render();
    this.emitSel();
  }

  /** Places an instance again: position (mm), angle (rad), scale. */
  setInsert(id: string, patch: Partial<Pick<BlockInsert, "x" | "y" | "ang" | "scale">>) {
    if (patch.scale !== undefined && !(patch.scale > 0)) return;
    this.sk = moveInsert(this.sk, id, patch);
    this.selection = new Set(insertEnts(this.sk, id));
    this.commit("Move block");
    this.render();
  }

  /** Edit Block: the instance's entities come free with the block's relations and dimensions on them. */
  editBlock(id: string) {
    if (this.sk.editBlock) return;
    this.sk = beginEditBlock(this.sk, id);
    this.selection.clear();
    this.info = solve(this.sk);
    this.commit("Edit block");
    this.render();
    this.emitSel();
  }

  /** Ends Edit Block: the definition takes the edited entities and every instance follows. */
  finishEditBlock() {
    const id = this.sk.editBlock?.insert;
    if (!id) return;
    this.sk = finishEditBlock(this.sk);
    this.selection = new Set(insertEnts(this.sk, id));
    this.info = solve(this.sk);
    this.commit("Finish editing block");
    this.render();
    this.emitSel();
  }

  explodeBlock(id: string) {
    this.sk = explodeInsert(this.sk, id, k => uid(k));
    this.selection.clear();
    this.commit("Explode block");
    this.render();
    this.emitSel();
  }

  renameBlock(id: string, name: string) {
    this.sk = renameBlock(this.sk, id, name);
    this.commit("Rename block");
  }

  selectAll() {
    this.selection = new Set(this.sk.ents.map(e => e.id));
    this.render();
    this.emitSel();
  }

  deleteSelection() {
    if (!this.selection.size) return false;
    // Block instances go whole (their entities are the definition's).
    const ins = new Set([...this.selection].map(id => this.lockedInsert(id)?.id).filter((x): x is string => !!x));
    if (ins.size) {
      this.sk = removeInserts(this.sk, ins);
      for (const id of [...this.selection]) if (!this.sk.ents.some(e => e.id === id) && !this.sk.rels.some(r => r.id === id) && !this.sk.dims.some(d => d.id === id)) this.selection.delete(id);
      if (!this.selection.size) { this.info = solve(this.sk); this.commit("Delete block"); this.render(); this.emitSel(); return true; }
    }
    const del = new Set(this.selection);
    // Curves take their unshared points with them.
    for (const id of [...del]) {
      const e = this.ent(id);
      if (!e || e.t === "point") continue;
      for (const p of refPts(e)) {
        const used = this.sk.ents.some(o => !del.has(o.id) && o.id !== p && refPts(o).includes(p));
        if (!used) del.add(p);
      }
    }
    // Points still used by a kept curve stay.
    for (const id of [...del]) {
      const e = this.ent(id);
      if (e?.t === "point" && this.sk.ents.some(o => !del.has(o.id) && refPts(o).includes(id))) del.delete(id);
    }
    this.sk.ents = this.sk.ents.filter(e => !del.has(e.id));
    this.sk.rels = this.sk.rels.filter(r => !del.has(r.id) && !r.e.some(x => del.has(x)));
    this.sk.dims = this.sk.dims.filter(d => !del.has(d.id) && !d.e.some(x => del.has(x)));
    this.selection.clear();
    this.info = solve(this.sk);
    this.commit("Delete sketch items");
    this.render();
    this.emitSel();
    return true;
  }

  /** Deletes the given items (relations, dimensions, entities) as one step. */
  deleteItems(ids: string[]) { this.selection = new Set(ids); this.deleteSelection(); }

  select(ids: string[]) { this.selection = new Set(ids); this.render(); this.emitSel(); }

  // ---------- trim (FR-SK-030) ----------

  /** Where a curve meets the other curves: positions along it (line: 0..1 of a→b; circle/arc: angle from its start). */
  private cuts(id: string): { u: number; p: V2; other: string; pt?: string }[] {
    const e = this.ent(id)!;
    const out: { u: number; p: V2; other: string; pt?: string }[] = [];
    const geo = (x: SkEnt) => curveOf(x, q => this.pt(q));
    const me = geo(e);
    if (!me) return out;
    // Solved positions are only good to the solver's tolerance, so a shared end or a tangent touch is within this of the exact crossing.
    const tol = 1e-5;
    const near = (q: V2) => out.some(c => Math.hypot(c.p[0] - q[0], c.p[1] - q[1]) < tol);
    // Ends of other curves held on this one (On curve, e.g. a line drawn to it and made tangent) cut it there, even when the
    // carriers only touch and the numeric crossing is lost.
    for (const r of this.sk.rels) {
      if (r.t !== "onCurve" || r.e[1] !== id) continue;
      const o = this.sk.ents.find(x => x.id !== id && (x.t === "line" || x.t === "arc") && (x.a === r.e[0] || x.b === r.e[0]));
      if (!o) continue;
      const q = this.pt(r.e[0]);
      if (!near(q)) out.push({ u: paramOf(me, q), p: q, other: o.id, pt: r.e[0] });
    }
    for (const o of this.sk.ents) {
      if (o.id === id || o.t === "point") continue;
      const og = geo(o);
      if (!og) continue;
      for (const q of intersectCurves(me, og, tol)) {
        if (!onCurve(og, q, tol) || !onCurve(me, q, tol)) continue;
        // Where curves only touch, a point on one is off the other by just (slip)²/2r, so the solved touch point slips along
        // the tangent far more than the solver's tolerance: an end of the other curve that close is that touch, and a cut
        // already made with that curve there is the same one.
        const loose = 1e-3 * Math.max(1, "r" in me ? me.r : 0, "r" in og ? og.r : 0);
        const ends = o.t === "line" || o.t === "arc" ? [o.a, o.b] : [];
        if (out.some(c => c.other === o.id && Math.hypot(c.p[0] - q[0], c.p[1] - q[1]) < loose)) continue;
        // An existing point there (a shared end): reuse it, at its own place.
        const hit = ends.map(i => this.sk.ents.find(x => x.id === i)).find(x => x?.t === "point" && Math.hypot(x.x - q[0], x.y - q[1]) < loose)
          ?? this.sk.ents.find(x => x.t === "point" && Math.hypot(x.x - q[0], x.y - q[1]) < tol);
        const at: V2 = hit && hit.t === "point" ? [hit.x, hit.y] : q;
        if (near(at)) continue;
        out.push({ u: paramOf(me, at), p: at, other: o.id, pt: hit?.id });
      }
    }
    return out;
  }

  private trimAt(p: V2) {
    const h = this.hits(p, { points: false })[0];
    if (!h) return;
    const e = this.ent(h.id)!;
    const me = curveOf(e, q => this.pt(q))!;
    const u = paramOf(me, this.project(p, e.id));
    const span = me.kind === "line" ? 1 : me.kind === "circle" ? Math.PI * 2 : me.sweep;
    const eps = 1e-7 * (me.kind === "line" ? 1 : 1);
    const cuts = this.cuts(e.id).filter(c => c.u > eps && c.u < span - eps).sort((a, b) => a.u - b.u);
    const lo = [...cuts].reverse().find(c => c.u < u) ?? null, hi = cuts.find(c => c.u > u) ?? null;
    const rels: SkRel[] = [];
    const at = (c: { p: V2; other: string; pt?: string }) => {
      if (c.pt) return c.pt;
      const id = uid("p");
      this.sk.ents.push({ id, t: "point", x: c.p[0], y: c.p[1] });
      rels.push({ id: uid("r"), t: "onCurve", e: [id, c.other] });
      return id;
    };
    if (e.t === "circle") {
      if (cuts.length < 2) { this.deleteItems([e.id]); return; }
      // Keep the arc from the cut after the click round to the cut before it.
      const a = hi ?? cuts[0], b = lo ?? cuts[cuts.length - 1];
      const aId = at(a), bId = at(b);
      const i = this.sk.ents.indexOf(e);
      this.sk.ents[i] = { id: e.id, t: "arc", c: e.c, a: aId, b: bId, ...(e.cons ? { cons: true } : {}) };
      for (const d of this.sk.dims) if (d.e[0] === e.id && d.t === "diameter") { d.t = "radius"; d.val = { v: d.val.v / 2 }; }
    } else if (!lo && !hi) { this.deleteItems([e.id]); return; }
    else if (e.t === "line" || e.t === "arc") {
      const startKey = e.t === "line" ? "a" : "a", endKey = "b";
      if (!lo) { (e as { a: string })[startKey] = at(hi!); }
      else if (!hi) { (e as { b: string })[endKey] = at(lo); }
      else {
        // Split: this curve keeps its start up to the first cut; a new one runs from the second cut to the end.
        const oldEnd = e.b;
        const loId = at(lo), hiId = at(hi);
        e.b = loId;
        const nid = uid(e.t === "line" ? "l" : "a");
        this.sk.ents.push(e.t === "line" ? { id: nid, t: "line", a: hiId, b: oldEnd, ...(e.cons ? { cons: true } : {}) } : { id: nid, t: "arc", c: e.c, a: hiId, b: oldEnd, ...(e.cons ? { cons: true } : {}) });
        // Direction relations hold for both pieces.
        for (const r of [...this.sk.rels]) if (r.e.length === 1 && r.e[0] === e.id && (r.t === "horizontal" || r.t === "vertical" || r.t === "fix")) rels.push({ id: uid("r"), t: r.t, e: [nid] });
      }
      // A line's length dimension no longer applies.
      if (e.t === "line") this.sk.dims = this.sk.dims.filter(d => !(d.e.length === 1 && d.e[0] === e.id));
    }
    this.sk.rels.push(...rels);
    this.dropLoosePoints();
    this.commit("Trim");
    this.render();
  }

  /** Points no curve uses any more (left by a trim or fillet), with their relations and dimensions, unless they are sketch points of their own. */
  private dropLoosePoints(candidates?: Set<string>) {
    const used = new Set<string>();
    for (const o of this.sk.ents) for (const q of refPts(o)) used.add(q);
    const gone = new Set(this.sk.ents.filter(e => e.t === "point" && !used.has(e.id) && (candidates ? candidates.has(e.id) : this.wasEndpoint.has(e.id))).map(e => e.id));
    if (!gone.size) return;
    this.sk.ents = this.sk.ents.filter(e => !gone.has(e.id));
    this.sk.rels = this.sk.rels.filter(r => !r.e.some(x => gone.has(x)));
    this.sk.dims = this.sk.dims.filter(d => !d.e.some(x => gone.has(x)));
  }

  /** Points that were curve ends before the current operation (so lone sketch points stay). */
  private get wasEndpoint() {
    const out = new Set<string>();
    const base = this.lastCommitted;
    for (const o of base.ents) {
      if (o.t === "line") out.add(o.a).add(o.b);
      else if (o.t === "arc") out.add(o.a).add(o.b);
    }
    return out;
  }

  // ---------- sketch fillet (FR-SK-033) ----------

  /**
   * Before a corner is rounded or chamfered: a length dimension on either line becomes the distance from the
   * corner to the line's other end, so the sizes keep meaning the sharp corner (a CAD app's virtual sharp).
   */
  private keepSharpDims(V: string, lines: (SkEnt & { t: "line" })[]) {
    for (const d of this.sk.dims) {
      if (d.e.length !== 1 || (d.t !== "distance" && d.t !== "hdistance" && d.t !== "vdistance")) continue;
      const l = lines.find(x => x.id === d.e[0]);
      if (l) d.e = [V, l.a === V ? l.b : l.a];
    }
  }

  /**
   * After the corner is cut: a corner point that dimensions, relations or construction lines still use stays as
   * a virtual sharp where the two lines meet; otherwise it goes.
   */
  private settleCorner(V: string, lines: (SkEnt & { t: "line" })[]) {
    const used = this.sk.dims.some(d => d.e.includes(V)) || this.sk.rels.some(r => r.e.includes(V)) || this.sk.ents.some(o => refPts(o).includes(V));
    if (used) this.sk.rels.push({ id: uid("r"), t: "intersection", e: [V, lines[0].id, lines[1].id] });
    else this.dropLoosePoints(new Set([V]));
  }

  private filletAt(p: V2) {
    const h = this.hits(p, { curves: false }).find(x => x.kind === "point");
    if (!h) { this.host.toast(t("Click a corner where two lines meet.")); return; }
    const V = h.id;
    // Construction lines at the corner (a centre rectangle's diagonals) stay on the sharp corner, as in other CAD apps.
    const lines = this.sk.ents.filter(e => e.t === "line" && !e.cons && (e.a === V || e.b === V)) as (SkEnt & { t: "line" })[];
    const curves = this.sk.ents.filter(e => !("cons" in e && e.cons) && ((e.t === "arc" && (e.a === V || e.b === V)) || (e.t === "line" && (e.a === V || e.b === V))));
    if (curves.length === 2 && lines.length !== 2) { this.filletCurves(V, curves as (SkEnt & { t: "line" | "arc" })[]); return; }
    if (lines.length !== 2 || curves.length !== 2) { this.host.toast(t("Click a corner where two lines meet."), "warn"); return; }
    const v = this.pt(V);
    const far = lines.map(l => this.pt(l.a === V ? l.b : l.a));
    const u = far.map(q => norm2(sub2(q, v)));
    const len = far.map(q => Math.hypot(q[0] - v[0], q[1] - v[1]));
    const cos = Math.max(-1, Math.min(1, dot2(u[0], u[1])));
    const half = Math.acos(cos) / 2;
    const r = this.filletRadius;
    if (half < 1e-6 || Math.abs(half - Math.PI / 2) < 1e-6) { this.host.toast(t("The lines are in line: there is no corner to round."), "warn"); return; }
    const dist = r / Math.tan(half);
    if (dist >= len[0] - 1e-9 || dist >= len[1] - 1e-9) { this.host.toast(t("The radius is too large for these lines."), "error"); return; }
    const T = u.map(w => [v[0] + w[0] * dist, v[1] + w[1] * dist] as V2);
    const bis = norm2([u[0][0] + u[1][0], u[0][1] + u[1][1]]);
    const C: V2 = [v[0] + bis[0] * (r / Math.sin(half)), v[1] + bis[1] * (r / Math.sin(half))];
    this.keepSharpDims(V, lines);
    const tIds = T.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
    lines.forEach((l, i) => { if (l.a === V) l.a = tIds[i]; else l.b = tIds[i]; });
    const cId = uid("p");
    this.sk.ents.push({ id: cId, t: "point", x: C[0], y: C[1] });
    const ccw = (T[0][0] - C[0]) * (T[1][1] - C[1]) - (T[0][1] - C[1]) * (T[1][0] - C[0]) > 0;
    const arc = uid("a");
    this.sk.ents.push({ id: arc, t: "arc", c: cId, a: ccw ? tIds[0] : tIds[1], b: ccw ? tIds[1] : tIds[0] });
    this.sk.rels.push({ id: uid("r"), t: "tangent", e: [lines[0].id, arc] }, { id: uid("r"), t: "tangent", e: [lines[1].id, arc] });
    // The corner point goes when nothing else uses it; else it stays as a virtual sharp.
    this.settleCorner(V, lines);
    const dim: SkDim = { id: uid("d"), name: this.nextDimName(), t: "radius", e: [arc], val: { v: r }, pos: [C[0] + (v[0] - C[0]) * 1.6, C[1] + (v[1] - C[1]) * 1.6] };
    const res = tryAdd(this.sk, { dim });
    if (res.ok && !res.redundant) { this.sk = res.sketch; this.info = res.result; }
    else { dim.driven = true; this.sk.dims.push(dim); }
    this.commit("Sketch fillet");
    this.render();
  }

  /**
   * Rounds a corner where an arc meets a line or another arc (a CAD app's sketch fillet does any two curves): the
   * fillet's centre is where the curves' offsets by the radius cross, taking the one whose touching points lie on
   * both curves nearest the corner.
   */
  private filletCurves(V: string, curves: (SkEnt & { t: "line" | "arc" })[]) {
    const r = this.filletRadius;
    const v = this.pt(V);
    const gs = curves.map(e => curveOf(e, q => this.pt(q))!);
    // Each curve's offsets at distance r: lines move sideways, circles grow or shrink.
    type Loc = { kind: "line"; a: V2; b: V2 } | { kind: "circle"; c: V2; r: number };
    const offsets = (g: Curve): Loc[] => {
      if (g.kind === "line") {
        const u = norm2(sub2(g.b, g.a)), n: V2 = [-u[1], u[0]];
        return [1, -1].map(k => ({ kind: "line" as const, a: [g.a[0] + n[0] * r * k, g.a[1] + n[1] * r * k] as V2, b: [g.b[0] + n[0] * r * k, g.b[1] + n[1] * r * k] as V2 }));
      }
      const c = (g as { c: V2 }).c, R = (g as { r: number }).r;
      return [R + r, R - r].filter(x => x > 1e-9).map(x => ({ kind: "circle" as const, c, r: x }));
    };
    const touch = (g: Curve, C: V2): V2 => {
      if (g.kind === "line") { const u = norm2(sub2(g.b, g.a)); const k = dot2(sub2(C, g.a), u); return [g.a[0] + u[0] * k, g.a[1] + u[1] * k]; }
      const c = (g as { c: V2 }).c, R = (g as { r: number }).r, w = norm2(sub2(C, c));
      return [c[0] + w[0] * R, c[1] + w[1] * R];
    };
    let best: { C: V2; T: V2[]; d: number } | null = null;
    for (const o0 of offsets(gs[0])) for (const o1 of offsets(gs[1])) {
      for (const C of intersectCurves(o0 as Curve, o1 as Curve)) {
        const T = gs.map(g => touch(g, C));
        if (!T.every((q, i) => onCurve(gs[i], q, 1e-6))) continue;
        const d = T.reduce((s, q) => s + Math.hypot(q[0] - v[0], q[1] - v[1]), 0);
        if (d < 1e-7) continue;
        if (!best || d < best.d) best = { C, T, d };
      }
    }
    if (!best) { this.host.toast(t("The radius is too large for these curves."), "error"); return; }
    const lines = curves.filter(e => e.t === "line") as (SkEnt & { t: "line" })[];
    this.keepSharpDims(V, lines);
    const tIds = best.T.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
    curves.forEach((e, i) => { if (e.a === V) e.a = tIds[i]; else e.b = tIds[i]; });
    const C = best.C, T = best.T;
    const cId = uid("p");
    this.sk.ents.push({ id: cId, t: "point", x: C[0], y: C[1] });
    // The fillet runs the short way between its touching points.
    const ccw = (T[0][0] - C[0]) * (T[1][1] - C[1]) - (T[0][1] - C[1]) * (T[1][0] - C[0]) > 0;
    const arc = uid("a");
    this.sk.ents.push({ id: arc, t: "arc", c: cId, a: ccw ? tIds[0] : tIds[1], b: ccw ? tIds[1] : tIds[0] });
    this.sk.rels.push({ id: uid("r"), t: "tangent", e: [curves[0].id, arc] }, { id: uid("r"), t: "tangent", e: [curves[1].id, arc] });
    const used = this.sk.dims.some(d => d.e.includes(V)) || this.sk.rels.some(q => q.e.includes(V)) || this.sk.ents.some(o => refPts(o).includes(V));
    if (used) this.sk.rels.push({ id: uid("r"), t: "onCurve", e: [V, curves[0].id] }, { id: uid("r"), t: "onCurve", e: [V, curves[1].id] });
    else this.dropLoosePoints(new Set([V]));
    const dim: SkDim = { id: uid("d"), name: this.nextDimName(), t: "radius", e: [arc], val: { v: r }, pos: [C[0] + (v[0] - C[0]) * 1.6, C[1] + (v[1] - C[1]) * 1.6] };
    const res = tryAdd(this.sk, { dim });
    if (res.ok && !res.redundant) { this.sk = res.sketch; this.info = res.result; }
    else { dim.driven = true; this.sk.dims.push(dim); }
    this.commit("Sketch fillet");
    this.render();
  }

  /** Selects what the box holds: fully inside, or (crossing) anything it touches, added to what was selected before. */
  private boxSelect(crossing: boolean) {
    const b = this.box!;
    const x0 = Math.min(b.a[0], b.b[0]), x1 = Math.max(b.a[0], b.b[0]), y0 = Math.min(b.a[1], b.b[1]), y1 = Math.max(b.a[1], b.b[1]);
    const inside = (q: V2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
    const samples = (e: SkEnt): V2[] => {
      if (e.t === "point") return [[e.x, e.y]];
      if (e.t === "ellipse") return this.ellLine(e);
      if (e.t === "spline") return this.splineLine(e);
      if (e.t === "text") return textBox(e, this.pt(e.p), textPath(this.sk.ents, e));
      const g = curveOf(e, q => this.pt(q));
      if (!g) return [];
      const n = 48;
      if (g.kind === "line") return Array.from({ length: n + 1 }, (_, i) => [g.a[0] + ((g.b[0] - g.a[0]) * i) / n, g.a[1] + ((g.b[1] - g.a[1]) * i) / n] as V2);
      const sw = g.kind === "circle" ? Math.PI * 2 : g.sweep, a0 = g.kind === "circle" ? 0 : g.a0;
      return Array.from({ length: n + 1 }, (_, i) => [g.c[0] + g.r * Math.cos(a0 + (sw * i) / n), g.c[1] + g.r * Math.sin(a0 + (sw * i) / n)] as V2);
    };
    const sel = new Set(b.base);
    for (const e of this.sk.ents) {
      const pts = samples(e);
      if (pts.length && (crossing ? pts.some(inside) : pts.every(inside))) sel.add(e.id);
    }
    this.selection = sel;
  }

  // ---------- slot (FR-SK-017) ----------

  /** Straight slot: two centres, half-width w; two lines and two end arcs, tangent, on a construction centre line. */
  private addSlot(c1: V2, c2: V2, w: number, id1: string | null, id2: string | null, rels: SkRel[]): { axis: string; cap1: string } {
    const u = norm2(sub2(c2, c1)), n: V2 = [-u[1], u[0]];
    const P = (c: V2, k: number): V2 => [c[0] + n[0] * w * k, c[1] + n[1] * w * k];
    const c1Id = this.usePoint(c1, id1, null, rels), c2Id = this.usePoint(c2, id2, null, rels);
    const [a1, a2, b2, b1] = [P(c1, 1), P(c2, 1), P(c2, -1), P(c1, -1)].map(q => this.usePoint(q, null, null, rels));
    const axis = uid("l"), top = uid("l"), bottom = uid("l"), cap2 = uid("a"), cap1 = uid("a");
    this.sk.ents.push(
      { id: axis, t: "line", a: c1Id, b: c2Id, cons: true },
      { id: top, t: "line", a: a1, b: a2 }, { id: bottom, t: "line", a: b2, b: b1 },
      // Counter-clockwise arcs: round the far end from the lower side to the upper, round the near end the other way.
      { id: cap2, t: "arc", c: c2Id, a: b2, b: a2 }, { id: cap1, t: "arc", c: c1Id, a: a1, b: b1 },
    );
    rels.push(
      { id: uid("r"), t: "tangent", e: [top, cap2] }, { id: uid("r"), t: "tangent", e: [bottom, cap2] },
      { id: uid("r"), t: "tangent", e: [top, cap1] }, { id: uid("r"), t: "tangent", e: [bottom, cap1] },
      { id: uid("r"), t: "equal", e: [cap1, cap2] }, { id: uid("r"), t: "parallel", e: [top, axis] },
    );
    if (Math.abs(u[1]) < 1e-9) rels.push({ id: uid("r"), t: "horizontal", e: [axis] });
    else if (Math.abs(u[0]) < 1e-9) rels.push({ id: uid("r"), t: "vertical", e: [axis] });
    return { axis, cap1 };
  }

  /** The arc slot's centre line from the first three clicks of the tool in use. */
  private slotAxis(a: V2, b: V2, c: V2): ArcSlotAxis | null {
    return this.tool === "aslot" ? centreArcAxis(a, b, c) : threePointArcAxis(a, b, c);
  }

  /** Slot tools add their sizes as dimensions (a CAD app's "Add dimensions"), unless turned off. */
  slotDims = true;
  /** Lines, rectangles, circles, arcs and polygons add their sizes as dimensions and open the Modify box on each (FR-UI-052). */
  addDims = true;

  /** Adds the dimensions that tell something (a snapped end may already fix one); returns their ids. */
  private slotSizes(list: { t: SkDim["t"]; e: string[]; pos: V2 }[]): string[] {
    if (!this.slotDims) return [];
    const made: string[] = [];
    for (const x of list) {
      const dim: SkDim = { id: uid("d"), name: this.nextDimName(), t: x.t, e: x.e, val: { v: 0 }, pos: x.pos };
      dim.val.v = measureDim(this.sk, dim);
      const r = tryAdd(this.sk, { dim });
      if (!r.ok || r.redundant) continue;
      this.sk = r.sketch;
      made.push(dim.id);
    }
    return made;
  }

  /** Opens the Modify box on each new size in turn: width, then length or radius (FR-UI-114). */
  private openSizes(ids: string[]) {
    if (!ids.length) return;
    setTimeout(() => this.editDim(ids[0], () => this.openSizes(ids.slice(1))), 0);
  }

  // ---------- extend, split, chamfer (FR-SK-031, 032, 033) ----------

  /** Curves using a point as an end (or centre). */
  private usersOf(id: string) {
    return this.sk.ents.filter(o => refPts(o).includes(id));
  }

  private extendAt(p: V2) {
    const h = this.hits(p, { points: false })[0];
    const e = h && this.ent(h.id);
    if (!e || (e.t !== "line" && e.t !== "arc")) { this.host.toast(t("Click a line or an arc near the end to extend.")); return; }
    const me = curveOf(e, q => this.pt(q))!;
    const u = paramOf(me, this.project(p, e.id));
    const span = me.kind === "line" ? 1 : (me as { sweep: number }).sweep;
    const atEnd = me.kind === "line" ? u > 0.5 : u > span / 2 && u < span / 2 + Math.PI;
    const endId = atEnd ? e.b : e.a;
    if (this.usersOf(endId).length > 1) { this.host.toast(t("That end is joined to another curve."), "warn"); return; }
    // Crossings of this curve's carrier beyond the chosen end, on the other curves.
    let best: { p: V2; other: string; k: number } | null = null;
    for (const o of this.sk.ents) {
      if (o.id === e.id || o.t === "point" || o.cons) continue;
      const og = curveOf(o, q => this.pt(q));
      if (!og) continue;
      for (const q of intersectCurves(me, og)) {
        if (!onCurve(og, q)) continue;
        const v = paramOf(me, q);
        // How far past the end along the curve (line: in units of its length; arc: radians).
        const k = me.kind === "line" ? (atEnd ? v - 1 : -v) : atEnd ? v - span : Math.PI * 2 - v;
        if (k > 1e-7 && (me.kind === "line" || v > span + 1e-7) && (!best || k < best.k)) best = { p: q, other: o.id, k };
      }
    }
    if (!best) { this.host.toast(t("Nothing to extend to in that direction."), "warn"); return; }
    const pt = this.ent(endId) as SkEnt & { t: "point" };
    pt.x = best.p[0]; pt.y = best.p[1];
    this.sk.rels.push({ id: uid("r"), t: "onCurve", e: [endId, best.other] });
    if (e.t === "line") this.sk.dims = this.sk.dims.filter(d => !(d.e.length === 1 && d.e[0] === e.id));
    this.commit("Extend");
    this.render();
  }

  private splitAt(p: V2) {
    const h = this.hits(p, { points: false })[0];
    const e = h && this.ent(h.id);
    if (!e || (e.t !== "line" && e.t !== "arc")) { this.host.toast(t("Click a line or an arc to split.")); return; }
    const q = this.project(p, e.id);
    const ends = [this.pt(e.a), this.pt(e.b)];
    if (ends.some(x => Math.hypot(x[0] - q[0], x[1] - q[1]) < this.px(q) * 3)) { this.host.toast(t("Click away from the ends to split."), "warn"); return; }
    const id = uid("p");
    this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] });
    const oldEnd = e.b;
    e.b = id;
    const nid = uid(e.t === "line" ? "l" : "a");
    this.sk.ents.push(e.t === "line" ? { id: nid, t: "line", a: id, b: oldEnd, ...(e.cons ? { cons: true } : {}) } : { id: nid, t: "arc", c: e.c, a: id, b: oldEnd, ...(e.cons ? { cons: true } : {}) });
    if (e.t === "line") {
      this.sk.rels.push({ id: uid("r"), t: "collinear", e: [e.id, nid] });
      for (const r of [...this.sk.rels]) if (r.e.length === 1 && r.e[0] === e.id && (r.t === "horizontal" || r.t === "vertical" || r.t === "fix")) this.sk.rels.push({ id: uid("r"), t: r.t, e: [nid] });
      this.sk.dims = this.sk.dims.filter(d => !(d.e.length === 1 && d.e[0] === e.id));
    }
    this.selection = new Set([id]);
    this.commit("Split entity");
    this.render();
    this.emitSel();
  }

  // ---------- segment (CAD app Segment) ----------

  /** Segment: divides the clicked line, arc or circle into `segCount` equal pieces, marked by points on it or cut into that many curves. */
  segmentAt(p: V2) {
    const h = this.hits(p, { points: false })[0];
    const e = h && this.ent(h.id);
    if (!e || (e.t !== "line" && e.t !== "arc" && e.t !== "circle")) { this.host.toast(t("Click a line, an arc or a circle to divide.")); return; }
    const n = Math.max(2, Math.min(100, Math.round(this.segCount)));
    if (e.t === "circle" && this.segMode === "segments") { this.host.toast(t("A circle is divided by points: pick Sketch points."), "warn"); return; }
    let at: (k: number) => V2;
    if (e.t === "line") {
      const a = this.pt(e.a), b = this.pt(e.b);
      at = k => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
    } else {
      const c = this.pt(e.c);
      let r: number, a0: number, sw: number;
      if (e.t === "circle") { r = e.r; a0 = 0; sw = 2 * Math.PI; }
      else {
        const a = this.pt(e.a), b = this.pt(e.b);
        r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        sw = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
        while (sw <= 1e-12) sw += 2 * Math.PI;
      }
      at = k => [c[0] + r * Math.cos(a0 + sw * k / n), c[1] + r * Math.sin(a0 + sw * k / n)];
    }
    const first = e.t === "circle" ? 0 : 1;
    const ids: string[] = [];
    for (let k = first; k < n; k++) { const q = at(k), id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); ids.push(id); }
    const rel = (t: RelKind, ...x: string[]) => this.sk.rels.push({ id: uid("r"), t, e: x });
    if (this.segMode === "points" || e.t === "circle") {
      for (const id of ids) rel("onCurve", id, e.id);
      this.selection = new Set(ids);
      this.commit("Segment");
    } else {
      const cons = e.cons ? { cons: true } : {};
      const oldEnd = e.b, made: string[] = [];
      e.b = ids[0];
      const ends = [...ids, oldEnd];
      for (let k = 0; k < ends.length - 1; k++) {
        const id = uid(e.t === "line" ? "l" : "a");
        this.sk.ents.push(e.t === "line" ? { id, t: "line", a: ends[k], b: ends[k + 1], ...cons } : { id, t: "arc", c: e.c, a: ends[k], b: ends[k + 1], ...cons });
        made.push(id);
      }
      if (e.t === "line") {
        const hv = this.sk.rels.filter(r => r.e.length === 1 && r.e[0] === e.id && (r.t === "horizontal" || r.t === "vertical" || r.t === "fix"));
        for (const id of made) {
          rel("collinear", e.id, id);
          rel("equal", e.id, id);
          for (const r of hv) rel(r.t, id);
        }
        this.sk.dims = this.sk.dims.filter(d => !(d.e.length === 1 && d.e[0] === e.id));
      }
      this.selection = new Set([e.id, ...made]);
      this.commit("Segment");
    }
    this.render();
    this.emitSel();
  }

  // ---------- jog line (CAD app Jog Line) ----------

  /** The jog that the second click at `p` would make on the line picked first: two cuts along it and a step of `h` square to it. */
  private jogShape(p: V2): { line: string; a: V2; b: V2; u: V2; n: V2; t0: number; t1: number; h: number; poly: V2[] } | null {
    const d = this.draft, id = d.ids[0];
    const e = id ? this.ent(id) : null;
    if (!d.pts.length || !e || e.t !== "line") return null;
    const a = this.pt(e.a), b = this.pt(e.b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) return null;
    const u: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n: V2 = [-u[1], u[0]];
    const along = (q: V2) => (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1];
    const s0 = along(d.pts[0]), s1 = along(p), h = (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
    const eps = this.px(p) * 3;
    const t0 = Math.min(s0, s1), t1 = Math.max(s0, s1);
    if (t0 < eps || t1 > len - eps || t1 - t0 < eps || Math.abs(h) < eps) return null;
    const at = (s: number, k: number): V2 => [a[0] + u[0] * s + n[0] * k, a[1] + u[1] * s + n[1] * k];
    return { line: e.id, a, b, u, n, t0, t1, h, poly: [at(t0, 0), at(t0, h), at(t1, h), at(t1, 0)] };
  }

  /** Jog line: the first click picks the line and where the jog starts, the second where it ends and how far it steps out. */
  private jogClick(p: V2) {
    const d = this.draft;
    if (!d.pts.length) {
      const h = this.hits(p, { points: false })[0];
      const e = h && this.ent(h.id);
      if (!e || e.t !== "line") { this.host.toast(t("Click a line to jog.")); return; }
      const q = this.project(p, e.id);
      const ends = [this.pt(e.a), this.pt(e.b)];
      if (ends.some(x => Math.hypot(x[0] - q[0], x[1] - q[1]) < this.px(q) * 3)) { this.host.toast(t("Click away from the ends to jog."), "warn"); return; }
      this.draft = { pts: [q], ids: [e.id], cursor: q, snap: null };
      this.render();
      return;
    }
    const g = this.jogShape(p);
    if (!g) { this.host.toast(t("Move along the line and to the side: the jog must stay inside the line."), "warn"); return; }
    const e = this.ent(g.line) as SkEnt & { t: "line" };
    const ids = g.poly.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
    const oldEnd = e.b, cons = e.cons ? { cons: true } : {};
    e.b = ids[0];
    const line = (a: string, b: string) => { const id = uid("l"); this.sk.ents.push({ id, t: "line", a, b, ...cons }); return id; };
    const side0 = line(ids[0], ids[1]), top = line(ids[1], ids[2]), side1 = line(ids[2], ids[3]), rest = line(ids[3], oldEnd);
    const rel = (t: RelKind, ...e: string[]) => this.sk.rels.push({ id: uid("r"), t, e });
    rel("collinear", e.id, rest);
    rel("parallel", e.id, top);
    rel("perpendicular", e.id, side0);
    rel("perpendicular", e.id, side1);
    for (const r of [...this.sk.rels]) if (r.e.length === 1 && r.e[0] === e.id && (r.t === "horizontal" || r.t === "vertical" || r.t === "fix")) rel(r.t, rest);
    this.sk.dims = this.sk.dims.filter(x => !(x.e.length === 1 && x.e[0] === e.id));
    this.draft = { pts: [], ids: [], cursor: null, snap: null };
    this.offsetPreview = [];
    this.selection = new Set([top]);
    this.commit("Jog line");
    this.render();
    this.emitSel();
  }

  private chamferAt(p: V2) {
    const h = this.hits(p, { curves: false }).find(x => x.kind === "point");
    if (!h) { this.host.toast(t("Click a corner where two lines meet.")); return; }
    const V = h.id;
    const lines = this.sk.ents.filter(e => e.t === "line" && !e.cons && (e.a === V || e.b === V)) as (SkEnt & { t: "line" })[];
    if (lines.length !== 2 || this.usersOf(V).filter(o => !("cons" in o && o.cons)).length !== 2) { this.host.toast(t("Click a corner where two lines meet."), "warn"); return; }
    const v = this.pt(V), dist = this.chamferDist;
    const far = lines.map(l => this.pt(l.a === V ? l.b : l.a));
    const len = far.map(q => Math.hypot(q[0] - v[0], q[1] - v[1]));
    if (Math.abs(cross2(norm2(sub2(far[0], v)), norm2(sub2(far[1], v)))) < 1e-9) { this.host.toast(t("The lines are in line: there is no corner to round."), "warn"); return; }
    if (dist >= len[0] - 1e-9 || dist >= len[1] - 1e-9) { this.host.toast(t("The distance is too large for these lines."), "error"); return; }
    const T = far.map(q => { const w = norm2(sub2(q, v)); return [v[0] + w[0] * dist, v[1] + w[1] * dist] as V2; });
    this.keepSharpDims(V, lines);
    const tIds = T.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
    lines.forEach((l, i) => { if (l.a === V) l.a = tIds[i]; else l.b = tIds[i]; });
    this.sk.ents.push({ id: uid("l"), t: "line", a: tIds[0], b: tIds[1] });
    this.settleCorner(V, lines);
    this.commit("Sketch chamfer");
    this.render();
  }

  // ---------- offset entities (FR-SK-034) ----------

  /** The chain of lines and arcs joined end to end through the clicked curve, in order, and whether it closes. */
  private chainOf(id: string): { segs: { id: string; rev: boolean }[]; closed: boolean } {
    const curves = this.sk.ents.filter(o => (o.t === "line" || o.t === "arc") && !o.cons) as (SkEnt & { t: "line" | "arc" })[];
    const deg = (pid: string) => curves.filter(o => o.a === pid || o.b === pid).length;
    const get = (cid: string) => curves.find(o => o.id === cid)!;
    const startOf = (sg: { id: string; rev: boolean }) => (sg.rev ? get(sg.id).b : get(sg.id).a);
    const endOf = (sg: { id: string; rev: boolean }) => (sg.rev ? get(sg.id).a : get(sg.id).b);
    const segs = [{ id, rev: false }];
    const seen = new Set([id]);
    let closed = false;
    for (;;) {
      const end = endOf(segs.at(-1)!);
      if (deg(end) !== 2) break;
      const nx = curves.find(o => !seen.has(o.id) && (o.a === end || o.b === end));
      if (!nx) { closed = end === startOf(segs[0]) && segs.length > 1; break; }
      seen.add(nx.id);
      segs.push({ id: nx.id, rev: nx.b === end });
    }
    if (!closed) for (;;) {
      const st = startOf(segs[0]);
      if (deg(st) !== 2) break;
      const pv = curves.find(o => !seen.has(o.id) && (o.a === st || o.b === st));
      if (!pv) break;
      seen.add(pv.id);
      segs.unshift({ id: pv.id, rev: pv.a === st });
    }
    return { segs, closed };
  }

  /**
   * Offsets the clicked circle, or the chain of lines and arcs through the clicked curve, by `offsetDist` to the cursor's side
   * (and the other side too with `offsetBoth`, open chains then closed by `offsetCap` arcs or lines).
   * Corners are re-joined where the offset curves meet; arcs keep their centres (concentric). With `offsetLink` (a CAD app's
   * default) the copies keep offset relations and one distance dimension, so they follow the source; otherwise a static copy.
   * With apply false it only returns the preview polylines.
   */
  private offsetAt(p: V2, apply: boolean): V2[][] {
    const h = this.hits(p, { points: false })[0];
    const e = h && this.ent(h.id);
    if (!e || (e.t !== "line" && e.t !== "arc" && e.t !== "circle")) {
      if (apply) this.host.toast(t("Click a line, arc or circle to offset."));
      return [];
    }
    let side: number;
    if (e.t === "line") side = Math.sign(cross2(sub2(this.pt(e.b), this.pt(e.a)), sub2(p, this.pt(e.a)))) || 1;
    else {
      const c = this.pt(e.c), r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]);
      side = Math.hypot(p[0] - c[0], p[1] - c[1]) < r ? 1 : -1;
    }
    const sides = this.offsetBoth ? [side, -side] : [side];
    const built = sides.map(sd => this.offsetSide(e, sd));
    const bad = built.findIndex(b => !b);
    if (bad >= 0) { if (apply) this.host.toast(t("The offset is larger than the radius."), "error"); return []; }
    const parts = built as OffsetBuild[];
    if (!apply) {
      const out = parts.flatMap(b => b.preview);
      if (parts.length === 2 && !parts[0].closed && this.offsetCap !== "none") for (const k of [0, 1] as const) out.push(this.capPreview(parts, k));
      return out;
    }
    const link = this.offsetLink;
    let lead: SkRel | null = null;
    for (const b of parts) {
      const made = b.apply();
      if (!link) continue;
      made.forEach((m, i) => {
        const caps: string[] = [];
        if (!b.closed && i === 0) caps.push(m.srcStart, m.dstStart);
        if (!b.closed && i === made.length - 1) caps.push(m.srcEnd, m.dstEnd);
        const rel: SkRel = { id: uid("r"), t: "offset", e: [m.src, m.dst, ...caps] };
        if (lead) rel.of = lead.id; else lead = rel;
        this.sk.rels.push(rel);
      });
    }
    if (link && lead) {
      const L = lead as SkRel, src = this.ent(L.e[0])!, dst = this.ent(L.e[1])!;
      const isLine = src.t === "line";
      const dim: SkDim = { id: uid("d"), name: this.nextDimName(), t: "distance", e: [L.e[0], L.e[1]], val: { v: this.offsetDist } };
      if (!isLine) dim.off = true;
      // Text beside the middle of the offset curve, outside the gap.
      const pts = this.dimPoints(dim);
      if (pts) {
        const m: V2 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
        const along = isLine ? norm2(sub2(this.pt((dst as SkEnt & { t: "line" }).b), this.pt((dst as SkEnt & { t: "line" }).a))) : [-(pts[1][1] - pts[0][1]), pts[1][0] - pts[0][0]] as V2;
        const u = norm2(along), k = this.px(m) * 40;
        dim.pos = [m[0] + u[0] * k, m[1] + u[1] * k];
      }
      this.sk.dims.push(dim);
    }
    if (parts.length === 2 && !parts[0].closed && this.offsetCap !== "none") {
      for (const k of [0, 1] as const) {
        const a = parts[0].made![k === 0 ? 0 : parts[0].made!.length - 1], b = parts[1].made![k === 0 ? 0 : parts[1].made!.length - 1];
        const pa = k === 0 ? a.dstStart : a.dstEnd, pb = k === 0 ? b.dstStart : b.dstEnd, c = k === 0 ? a.srcStart : a.srcEnd;
        if (this.offsetCap === "line") { this.sk.ents.push({ id: uid("l"), t: "line", a: pa, b: pb }); continue; }
        // Arc about the source end, bulging away from the chain: counter-clockwise from one offset end to the other.
        const C = this.pt(c), A = this.pt(pa), out = this.capOut(parts[0], k);
        const ccwAB = cross2(sub2(A, C), out) > 0;
        this.sk.ents.push({ id: uid("a"), t: "arc", c, a: ccwAB ? pa : pb, b: ccwAB ? pb : pa });
      }
    }
    this.commit("Offset entities");
    this.offsetPreview = [];
    this.render();
    return [];
  }

  /** The outward direction at a chain end of the source (k = 0 start, 1 end): away from the chain along its end tangent. */
  private capOut(b: OffsetBuild, k: 0 | 1): V2 {
    const o = b.offs[k === 0 ? 0 : b.offs.length - 1];
    const s = k === 0 ? o.s : o.e;
    const src = this.ent(o.sg.id) as SkEnt & { t: "line" | "arc" };
    let tan: V2;
    if (src.t === "line") tan = norm2(sub2(o.e, o.s));
    else { const c = this.pt(src.c), rr = sub2(s, c); tan = norm2(o.sg.rev ? [rr[1], -rr[0]] : [-rr[1], rr[0]]); }
    return k === 0 ? [-tan[0], -tan[1]] : tan;
  }

  private capPreview(parts: OffsetBuild[], k: 0 | 1): V2[] {
    const a = k === 0 ? parts[0].starts[0] : parts[0].ends.at(-1)!, b = k === 0 ? parts[1].starts[0] : parts[1].ends.at(-1)!;
    if (this.offsetCap === "line") return [a, b];
    const o = parts[0].offs[k === 0 ? 0 : parts[0].offs.length - 1], C = k === 0 ? o.s : o.e, out = this.capOut(parts[0], k);
    const r = Math.hypot(a[0] - C[0], a[1] - C[1]), a0 = Math.atan2(a[1] - C[1], a[0] - C[0]);
    const dir = cross2(sub2(a, C), out) > 0 ? 1 : -1;
    return Array.from({ length: 25 }, (_, i) => [C[0] + r * Math.cos(a0 + (dir * Math.PI * i) / 24), C[1] + r * Math.sin(a0 + (dir * Math.PI * i) / 24)] as V2);
  }

  /** The offset of the clicked curve's chain (or circle) to one side: preview polylines, and `apply` that adds the entities. Null when an arc would vanish. */
  private offsetSide(e: SkEnt & { t: "line" | "arc" | "circle" }, side: number): OffsetBuild | null {
    const d = this.offsetDist;
    if (e.t === "circle") {
      const c = this.pt(e.c), r = e.r - side * d;
      if (!(r > 1e-9)) return null;
      const res: OffsetBuild = {
        closed: true, offs: [], starts: [], ends: [],
        preview: [Array.from({ length: 73 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 36), c[1] + r * Math.sin((i * Math.PI) / 36)] as V2)],
        apply: () => { const id = uid("c"); this.sk.ents.push({ id, t: "circle", c: e.c, r }); return (res.made = [{ src: e.id, dst: id, srcStart: "", dstStart: "", srcEnd: "", dstEnd: "" }]); },
      };
      return res;
    }
    const { segs, closed } = this.chainOf(e.id);
    // Side: +1 to the left of the clicked curve as the chain runs (it runs forward on the clicked curve; for an arc, left = inside).
    const offs: OffsetSeg[] = [];
    for (const sg of segs) {
      const o = this.ent(sg.id) as SkEnt & { t: "line" | "arc" };
      const s0 = this.pt(sg.rev ? o.b : o.a), e0 = this.pt(sg.rev ? o.a : o.b);
      if (o.t === "line") {
        const u = norm2(sub2(e0, s0)), n: V2 = [-u[1] * side * d, u[0] * side * d];
        const at = (x: V2): V2 => [x[0] + n[0], x[1] + n[1]];
        offs.push({ g: { kind: "line", a: at(s0), b: at(e0) }, at, sg, s: s0, e: e0 });
      } else {
        const c = this.pt(o.c), r = Math.hypot(s0[0] - c[0], s0[1] - c[1]);
        // Forward (counter-clockwise) the left side is the inside.
        const r2 = r + (sg.rev ? side : -side) * d;
        if (!(r2 > 1e-9)) return null;
        const at = (x: V2): V2 => [c[0] + ((x[0] - c[0]) * r2) / r, c[1] + ((x[1] - c[1]) * r2) / r];
        offs.push({ g: { kind: "circle", c, r: r2 }, at, sg, s: s0, e: e0 });
      }
    }
    // Joint points: the start of each offset curve, the end of the last one when open.
    const joint = (i: number, j: number): V2 => {
      const a = offs[i].at(offs[i].e), b = offs[j].at(offs[j].s);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) return a;
      const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const xs = intersectCurves(offs[i].g, offs[j].g);
      if (!xs.length) return a;
      return xs.reduce((best, q) => (Math.hypot(q[0] - m[0], q[1] - m[1]) < Math.hypot(best[0] - m[0], best[1] - m[1]) ? q : best));
    };
    const n = offs.length;
    const starts: V2[] = offs.map((_, i) => (i === 0 && !closed ? offs[0].at(offs[0].s) : joint((i - 1 + n) % n, i)));
    const ends: V2[] = offs.map((_, i) => (i === n - 1 && !closed ? offs[i].at(offs[i].e) : starts[(i + 1) % n]));
    const preview = offs.map((o, i) => {
      if (o.g.kind === "line") return [starts[i], ends[i]];
      const c = o.g.c, r = o.g.r;
      const a0 = Math.atan2(starts[i][1] - c[1], starts[i][0] - c[0]);
      let sw = Math.atan2(ends[i][1] - c[1], ends[i][0] - c[0]) - a0;
      if (o.sg.rev) { while (sw >= 0) sw -= Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; }
      return Array.from({ length: 49 }, (_, k) => [c[0] + r * Math.cos(a0 + (sw * k) / 48), c[1] + r * Math.sin(a0 + (sw * k) / 48)] as V2);
    });
    const res: OffsetBuild = {
      closed, offs, starts, ends, preview,
      apply: () => {
        const ptIds = starts.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
        const endIds = closed ? ptIds.map((_, i) => ptIds[(i + 1) % n]) : [...ptIds.slice(1), (() => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: ends[n - 1][0], y: ends[n - 1][1] }); return id; })()];
        const made: OffsetMade[] = [];
        offs.forEach((o, i) => {
          const src = this.ent(o.sg.id) as SkEnt & { t: "line" | "arc" };
          const srcStart = o.sg.rev ? src.b : src.a, srcEnd = o.sg.rev ? src.a : src.b;
          let dst: string;
          if (src.t === "line") { dst = uid("l"); this.sk.ents.push({ id: dst, t: "line", a: ptIds[i], b: endIds[i] }); this.sk.rels.push({ id: uid("r"), t: "parallel", e: [src.id, dst] }); }
          else { dst = uid("a"); this.sk.ents.push({ id: dst, t: "arc", c: src.c, a: o.sg.rev ? endIds[i] : ptIds[i], b: o.sg.rev ? ptIds[i] : endIds[i] }); }
          made.push({ src: src.id, dst, srcStart, dstStart: ptIds[i], srcEnd, dstEnd: endIds[i] });
        });
        return (res.made = made);
      },
    };
    return res;
  }

  // ---------- mirror entities (FR-SK-037) ----------

  /**
   * Mirrors the selected entities about the selected line (a construction line if one is picked,
   * otherwise the last line picked). Copies are tied to the originals by symmetric relations, so
   * they follow when the originals change; points on the line are shared.
   */
  mirrorSelection(): boolean {
    const sel = [...this.selection].map(id => this.ent(id)).filter((x): x is SkEnt => !!x);
    const lines = sel.filter((x): x is Extract<SkEnt, { t: "line" }> => x.t === "line");
    const axis = lines.find(l => l.cons) ?? lines.at(-1);
    const items = sel.filter(x => x !== axis);
    if (!axis || !items.length) { this.host.toast(t("Select the entities to mirror and the line to mirror about (Ctrl+click), then click Mirror.")); return false; }
    const made = this.mirrorItems(axis, items, new Map());
    if (!made) return false;
    this.selection = new Set(made);
    this.commit("Mirror entities");
    this.render();
    this.emitSel();
    return true;
  }

  /** Dynamic mirror (FR-SK-037): the line new entities are mirrored about while drawing, and the points mirrored so far. */
  dynMirror: string | null = null;
  private dynMap = new Map<string, string>();

  /** Turns dynamic mirror on about the selected line, or off. */
  toggleDynMirror(): boolean {
    if (this.dynMirror) { this.dynMirror = null; this.dynMap.clear(); this.statusHint(); this.render(); return true; }
    const lines = [...this.selection].map(id => this.ent(id)).filter((x): x is Extract<SkEnt, { t: "line" }> => x?.t === "line");
    const axis = lines.find(l => l.cons) ?? lines[0];
    if (!axis || lines.length !== 1) { this.host.toast(t("Select one line to mirror about, then click Dynamic mirror.")); return false; }
    this.dynMirror = axis.id; this.dynMap.clear();
    this.selection.clear(); this.emitSel();
    if (this.tool === "select") this.setTool("line");
    this.statusHint(); this.render();
    return true;
  }

  /** Mirrors the entities a drawing click just made (not in `before`) about the dynamic mirror line. */
  private mirrorNew(before: Set<string>) {
    const axis = this.dynMirror ? this.ent(this.dynMirror) : undefined;
    if (!axis || axis.t !== "line") { this.dynMirror = null; this.dynMap.clear(); return; }
    const fresh = this.sk.ents.filter(x => !before.has(x.id) && x.id !== axis.id);
    const used = new Set<string>();
    for (const e of fresh) if (e.t !== "point") for (const q of refPts(e)) used.add(q);
    const items = fresh.filter(e => e.t !== "point" || !used.has(e.id));
    if (items.length) this.mirrorItems(axis, items, this.dynMap);
  }

  /** Adds the mirror images of `items` about `axis` with symmetric relations; `map` = points already mirrored. */
  private mirrorItems(axis: Extract<SkEnt, { t: "line" }>, items: SkEnt[], map: Map<string, string>): string[] | null {
    const A = this.pt(axis.a), B = this.pt(axis.b);
    const d: V2 = [B[0] - A[0], B[1] - A[1]];
    const L = Math.hypot(d[0], d[1]);
    if (!(L > 1e-9)) return null;
    const u: V2 = [d[0] / L, d[1] / L];
    const reflect = (q: V2): V2 => {
      const w: V2 = [q[0] - A[0], q[1] - A[1]];
      const k = w[0] * u[0] + w[1] * u[1];
      return [2 * (A[0] + u[0] * k) - q[0], 2 * (A[1] + u[1] * k) - q[1]];
    };
    const point = (id: string) => {
      if (id === axis.a || id === axis.b) return id;
      const got = map.get(id);
      if (got && this.ent(got)) return got;
      const q = this.pt(id), r = reflect(q);
      if (Math.hypot(r[0] - q[0], r[1] - q[1]) < 1e-9) { map.set(id, id); return id; }
      const nid = uid("p");
      this.sk.ents.push({ id: nid, t: "point", x: r[0], y: r[1] });
      this.sk.rels.push({ id: uid("r"), t: "symmetric", e: [id, nid, axis.id] });
      map.set(id, nid);
      return nid;
    };
    const made: string[] = [];
    for (const e of items) {
      if (e.t === "point") { if (e.id !== ORIGIN) made.push(point(e.id)); }
      else if (e.t === "line") { const id = uid("l"); this.sk.ents.push({ id, t: "line", a: point(e.a), b: point(e.b), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
      else if (e.t === "circle") { const id = uid("c"); this.sk.ents.push({ id, t: "circle", c: point(e.c), r: e.r, ...(e.cons ? { cons: true } : {}) }); this.sk.rels.push({ id: uid("r"), t: "equal", e: [e.id, id] }); made.push(id); }
      // A mirror image runs the other way round: the ends swap.
      else if (e.t === "ellipse") { const id = uid("e"); this.sk.ents.push({ id, t: "ellipse", c: point(e.c), a: point(e.a), b: point(e.b), ...(e.p0 && e.p1 ? { p0: point(e.p1), p1: point(e.p0) } : {}), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
      else if (e.t === "spline") { const id = uid("s"); this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...splineExtra(e, true), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
      else if (e.t === "text") { const id = uid("t"); this.sk.ents.push({ ...structuredClone(e), id, p: point(e.p) }); made.push(id); }
      else { const id = uid("a"); this.sk.ents.push({ id, t: "arc", c: point(e.c), a: point(e.b), b: point(e.a), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
    }
    return made;
  }

  // ---------- linear and circular sketch patterns (FR-SK-038) ----------

  /** The pattern being set up in the panel (null when none); the preview follows its values live. */
  pattern: SketchPattern | null = null;

  /** Seed entities of a pattern: the selection without a lone centre point. */
  private patternSeed(): { items: SkEnt[]; centre: string | null } {
    const sel = [...this.selection].map(id => this.ent(id)).filter((x): x is SkEnt => !!x);
    const used = new Set<string>();
    for (const e of sel) for (const q of refPts(e)) used.add(q);
    const lone = sel.filter(e => e.t === "point" && !used.has(e.id));
    const centre = lone.length === 1 && sel.length > 1 ? lone[0].id : null;
    return { items: sel.filter(e => e.id !== centre && e.id !== ORIGIN), centre };
  }

  /** Starts a pattern of the selection (Linear or Circular), with the panel's defaults. */
  startPattern(kind: SketchPattern["kind"]): boolean {
    const { items, centre } = this.patternSeed();
    if (kind === "stretch") {
      if (!this.stretchPoints().size) { this.host.toast(t("Select the points or entities to stretch first (a box over one end of the shape), then click Stretch.")); return false; }
      if (this.tool !== "select") this.setTool("select");
      this.pattern = { kind, dx: 10, dy: 0 };
      this.render();
      return true;
    }
    if (!items.length) { this.host.toast(t("Select the entities to pattern first, then click the pattern tool.")); return false; }
    if (this.tool !== "select") this.setTool("select");
    const c: V2 = centre ? this.pt(centre) : [0, 0];
    this.pattern = kind === "linear" ? { kind, n: 3, d: 20, angle: 0, n2: 1, d2: 20, angle2: Math.PI / 2 }
      : kind === "circular" ? { kind, n: 6, total: Math.PI * 2, c, centre, equal: true }
      : kind === "move" ? { kind, dx: 10, dy: 0, copy: false, keep: true }
      : kind === "rotate" ? { kind, c, centre, angle: Math.PI / 2, copy: false, keep: true }
      : { kind: "scale", c, centre, k: 2, copy: false, keep: true };
    this.render();
    return true;
  }

  cancelPattern() { this.pattern = null; this.render(); }

  /** Transforms of the instances (the seed itself left out); k scales radii. */
  private patternMoves(): { f: (q: V2) => V2; k: number }[] {
    const p = this.pattern;
    if (!p) return [];
    const out: { f: (q: V2) => V2; k: number }[] = [];
    const rot = (c: V2, a: number) => { const co = Math.cos(a), si = Math.sin(a); return (q: V2): V2 => [c[0] + (q[0] - c[0]) * co - (q[1] - c[1]) * si, c[1] + (q[0] - c[0]) * si + (q[1] - c[1]) * co]; };
    if (p.kind === "linear") {
      const u: V2 = [Math.cos(p.angle), Math.sin(p.angle)], v: V2 = [Math.cos(p.angle2), Math.sin(p.angle2)];
      for (let j = 0; j < Math.max(1, p.n2); j++) for (let i = 0; i < Math.max(1, p.n); i++) {
        if (!i && !j) continue;
        const dx = u[0] * p.d * i + v[0] * p.d2 * j, dy = u[1] * p.d * i + v[1] * p.d2 * j;
        out.push({ f: q => [q[0] + dx, q[1] + dy], k: 1 });
      }
    } else if (p.kind === "circular") {
      const full = Math.abs(Math.abs(p.total) - Math.PI * 2) < 1e-9;
      const step = p.equal ? p.total / (full ? p.n : Math.max(1, p.n - 1)) : p.total;
      for (let i = 1; i < p.n; i++) out.push({ f: rot(p.c, step * i), k: 1 });
    } else if (p.kind === "move") out.push({ f: q => [q[0] + p.dx, q[1] + p.dy], k: 1 });
    else if (p.kind === "rotate") out.push({ f: rot(p.c, p.angle), k: 1 });
    else if (p.kind === "stretch") out.push({ f: q => [q[0] + p.dx, q[1] + p.dy], k: 1 });
    else { const c = p.c, k = p.k; out.push({ f: q => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k], k: Math.abs(k) }); }
    return out;
  }

  /**
   * Points a stretch moves: the selected points, and all points of a selected curve none of whose points are
   * selected. So a crossing box over one end moves the end points inside it and stretches the curves crossing
   * the box, while a curve picked on its own moves whole. The origin stays.
   */
  private stretchPoints(): Set<string> {
    const pts = new Set<string>();
    const sel = [...this.selection].map(id => this.ent(id)).filter((x): x is SkEnt => !!x);
    for (const e of sel) if (e.t === "point") pts.add(e.id);
    const picked = new Set(pts);
    for (const e of sel) if (e.t !== "point" && !refPts(e).some(q => picked.has(q))) for (const q of refPts(e)) pts.add(q);
    pts.delete(ORIGIN);
    return pts;
  }

  /** Entities a stretch changes: every entity using a moved point, and the moved points themselves. */
  private stretchItems(pts: Set<string>): SkEnt[] {
    return this.sk.ents.filter(e => e.t === "point" ? pts.has(e.id) : refPts(e).some(q => pts.has(q)));
  }

  /** Stretch preview: the entities drawn with the moved points displaced (the sketch is put back at once). */
  private stretchPreview(mv: (q: V2) => V2): V2[][] {
    const pts = this.stretchPoints();
    const keep = new Map<string, V2>();
    for (const id of pts) { const e = this.ent(id) as SkEnt & { t: "point" }; keep.set(id, [e.x, e.y]); const q = mv([e.x, e.y]); e.x = q[0]; e.y = q[1]; }
    try { return this.entPolys(this.stretchItems(pts), q => q, 1); }
    finally { for (const [id, q] of keep) { const e = this.ent(id) as SkEnt & { t: "point" }; e.x = q[0]; e.y = q[1]; } }
  }

  /** Preview polylines of the instances. */
  private patternPreview(): V2[][] {
    const out: V2[][] = [];
    if (this.pattern?.kind === "stretch") return this.stretchPreview(this.patternMoves()[0].f);
    const { items } = this.patternSeed();
    for (const { f: mv, k } of this.patternMoves()) out.push(...this.entPolys(items, mv, k));
    return out;
  }

  /** Polylines of entities moved by mv (k scales radii). */
  private entPolys(items: SkEnt[], mv: (q: V2) => V2, k: number): V2[][] {
    const out: V2[][] = [];
    {
      for (const e of items) {
        if (e.t === "point") { const q = mv(this.pt(e.id)), r = this.px(q) * 3; out.push(arcPts(q, r, 0, Math.PI * 2, 12)); }
        else if (e.t === "line") out.push([mv(this.pt(e.a)), mv(this.pt(e.b))]);
        else if (e.t === "circle") out.push(arcPts(mv(this.pt(e.c)), e.r * k, 0, Math.PI * 2, 72));
        else if (e.t === "ellipse") out.push(this.ellLine(e, mv));
        else if (e.t === "spline") out.push(this.splineLine(e, mv));
        else if (e.t === "text") out.push(...textPolys(e, this.pt(e.p), textPath(this.sk.ents, e)).map(l => l.map(mv)));
        else {
          const c = this.pt(e.c), a = this.pt(e.a), b = this.pt(e.b), r = Math.hypot(a[0] - c[0], a[1] - c[1]);
          const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
          let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
          while (a1 <= a0) a1 += Math.PI * 2;
          out.push(arcPts(c, r, a0, a1).map(mv));
        }
      }
    }
    return out;
  }

  /**
   * Adds the pattern instances. Each copy keeps an equal relation to its seed (lines also stay
   * parallel in a linear pattern), so changing the seed's size changes every instance.
   */
  applyPattern(): number {
    const p = this.pattern;
    const { items } = this.patternSeed();
    const moves = this.patternMoves();
    if (p?.kind === "stretch") return this.applyStretch(moves[0].f);
    if (!p || !items.length || !moves.length) { this.cancelPattern(); return 0; }
    if (p.kind === "move" || p.kind === "rotate" || p.kind === "scale") return this.applyTransform(p, items, moves[0]);
    const made: string[] = [];
    for (const { f: mv } of moves) {
      const map = new Map<string, string>();
      const point = (id: string) => {
        let got = map.get(id);
        if (!got) { got = uid("p"); const q = mv(this.pt(id)); this.sk.ents.push({ id: got, t: "point", x: q[0], y: q[1] }); map.set(id, got); }
        return got;
      };
      const cons = (e: SkEnt) => (e.cons ? { cons: true } : {});
      for (const e of items) {
        if (e.t === "point") { made.push(point(e.id)); continue; }
        if (e.t === "line") {
          const id = uid("l");
          this.sk.ents.push({ id, t: "line", a: point(e.a), b: point(e.b), ...cons(e) });
          this.sk.rels.push({ id: uid("r"), t: "equal", e: [e.id, id] });
          if (p.kind === "linear") this.sk.rels.push({ id: uid("r"), t: "parallel", e: [e.id, id] });
          made.push(id);
        } else if (e.t === "circle") {
          const id = uid("c");
          this.sk.ents.push({ id, t: "circle", c: point(e.c), r: e.r, ...cons(e) });
          this.sk.rels.push({ id: uid("r"), t: "equal", e: [e.id, id] });
          made.push(id);
        } else if (e.t === "spline") {
          const id = uid("s");
          this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...splineExtra(e), ...cons(e) });
          made.push(id);
        } else if (e.t === "ellipse") {
          const id = uid("e");
          this.sk.ents.push({ id, t: "ellipse", c: point(e.c), a: point(e.a), b: point(e.b), ...(e.p0 && e.p1 ? { p0: point(e.p0), p1: point(e.p1) } : {}), ...cons(e) });
          made.push(id);
        } else if (e.t === "text") {
          const id = uid("t");
          this.sk.ents.push({ ...structuredClone(e), id, p: point(e.p) });
          made.push(id);
        } else {
          const id = uid("a");
          this.sk.ents.push({ id, t: "arc", c: point(e.c), a: point(e.a), b: point(e.b), ...cons(e) });
          this.sk.rels.push({ id: uid("r"), t: "equal", e: [e.id, id] });
          made.push(id);
        }
      }
    }
    this.pattern = null;
    this.selection = new Set(made);
    this.commit(p.kind === "linear" ? "Linear sketch pattern" : "Circular sketch pattern");
    this.render();
    this.emitSel();
    return moves.length;
  }

  /**
   * Move, rotate or scale the selection in place, or add transformed copies (no relations).
   * In place, relations and dimensions tying the selection to other geometry are kept (the solver
   * then pulls against them) or, with keep off, deleted first.
   */
  private applyTransform(p: Extract<SketchPattern, { kind: "move" | "rotate" | "scale" }>, items: SkEnt[], mv: { f: (q: V2) => V2; k: number }): number {
    const label = p.kind === "move" ? (p.copy ? "Copy entities" : "Move entities") : p.kind === "rotate" ? "Rotate entities" : "Scale entities";
    const pts = new Set<string>();
    for (const e of items) { if (e.t === "point") pts.add(e.id); else for (const q of refPts(e)) pts.add(q); }
    pts.delete(ORIGIN);
    const made: string[] = [];
    if (p.copy) {
      const map = new Map<string, string>();
      const point = (id: string) => {
        let got = map.get(id);
        if (!got) { got = uid("p"); const q = mv.f(this.pt(id)); this.sk.ents.push({ id: got, t: "point", x: q[0], y: q[1] }); map.set(id, got); }
        return got;
      };
      for (const e of items) {
        const cons = e.cons ? { cons: true } : {};
        if (e.t === "point") { if (e.id !== ORIGIN) made.push(point(e.id)); }
        else if (e.t === "line") { const id = uid("l"); this.sk.ents.push({ id, t: "line", a: point(e.a), b: point(e.b), ...cons }); made.push(id); }
        else if (e.t === "circle") { const id = uid("c"); this.sk.ents.push({ id, t: "circle", c: point(e.c), r: e.r * mv.k, ...cons }); made.push(id); }
        else if (e.t === "ellipse") { const id = uid("e"); this.sk.ents.push({ id, t: "ellipse", c: point(e.c), a: point(e.a), b: point(e.b), ...(e.p0 && e.p1 ? { p0: point(e.p0), p1: point(e.p1) } : {}), ...cons }); made.push(id); }
        else if (e.t === "spline") { const id = uid("s"); this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...splineExtra(e), ...cons }); made.push(id); }
        else if (e.t === "text") { const id = uid("t"); this.sk.ents.push({ ...structuredClone(e), id, p: point(e.p), h: e.h * mv.k }); made.push(id); }
        else { const id = uid("a"); this.sk.ents.push({ id, t: "arc", c: point(e.c), a: point(e.a), b: point(e.b), ...cons }); made.push(id); }
      }
    } else {
      const moved = new Set<string>([...pts, ...items.map(e => e.id)]);
      if (!p.keep) {
        const outside = (ids: string[]) => ids.some(x => moved.has(x)) && ids.some(x => !moved.has(x));
        this.sk.rels = this.sk.rels.filter(r => !(outside(r.e) || (r.t === "fix" && r.e.some(x => moved.has(x)))));
        this.sk.dims = this.sk.dims.filter(d => !outside(d.e) || d.driven);
      }
      for (const id of pts) { const e = this.ent(id) as SkEnt & { t: "point" }; const q = mv.f([e.x, e.y]); e.x = q[0]; e.y = q[1]; }
      if (mv.k !== 1) {
        for (const e of items) if (e.t === "circle") e.r *= mv.k;
        // Scaled lengths: dimensions inside the selection scale with it.
        for (const d of this.sk.dims) if (d.t !== "angle" && !d.driven && d.e.every(x => moved.has(x)) && !d.val.expr) d.val = { v: d.val.v * mv.k };
      }
      made.push(...items.map(e => e.id));
    }
    this.pattern = null;
    this.selection = new Set(made);
    this.commit(label);
    this.render();
    this.emitSel();
    return 1;
  }

  /**
   * Stretch entities (CAD app Stretch Entities): the selected points move by the delta, so curves ending on
   * them stretch. Driving dimensions spanning moved and unmoved points take their new values (ones typed as an
   * expression keep it, and the solver pulls against them); relations stay.
   */
  private applyStretch(mv: (q: V2) => V2): number {
    const pts = this.stretchPoints();
    this.pattern = null;
    if (!pts.size) { this.render(); return 0; }
    const ptsOf = (id: string): string[] => { const e = this.ent(id); return !e ? [] : e.t === "point" ? [e.id] : refPts(e); };
    const touched = this.sk.dims.filter(d => {
      if (d.driven || d.val.expr) return false;
      const ps = d.e.flatMap(ptsOf);
      return ps.some(q => pts.has(q)) && ps.some(q => !pts.has(q));
    });
    for (const id of pts) { const e = this.ent(id) as SkEnt & { t: "point" }; const q = mv([e.x, e.y]); e.x = q[0]; e.y = q[1]; }
    for (const d of touched) { const v = measureDim(this.sk, d); if (Number.isFinite(v)) d.val = { v }; }
    this.commit("Stretch entities");
    this.render();
    this.emitSel();
    return 1;
  }

  // ---------- DXF import (FR-SK-040) ----------

  /** Adds DXF shapes to the sketch (shared end points join, so closed outlines make regions). */
  importShapes(shapes: DxfShape[]): number {
    const ptAt = new Map<string, string>();
    const point = (q: [number, number]) => {
      const key = `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)}`;
      let id = ptAt.get(key);
      if (!id) { id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); ptAt.set(key, id); }
      return id;
    };
    let n = 0;
    for (const s of shapes) {
      if (s.t === "line") { this.sk.ents.push({ id: uid("l"), t: "line", a: point(s.a), b: point(s.b) }); n++; }
      else if (s.t === "circle") { this.sk.ents.push({ id: uid("c"), t: "circle", c: point(s.c), r: s.r }); n++; }
      else {
        const at = (a: number): [number, number] => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)];
        this.sk.ents.push({ id: uid("a"), t: "arc", c: point(s.c), a: point(at(s.a0)), b: point(at(s.a1)) });
        n++;
      }
    }
    if (n) { this.commit("Import DXF"); this.render(); }
    return n;
  }

  // ---------- convert entities (FR-SK-035) ----------

  /**
   * Copies the model edges under the pointer into the sketch, projected onto its plane. Each copy gets an
   * On edge relation: it is fixed, and follows its edge when the model changes (FR-SK-064).
   */
  private convertAt(e: PointerEvent) {
    if (this.reattaching) { this.reattachAt(e); return; }
    if (this.piercing) { this.pierceAt(e); return; }
    const edges = this.host.modelEdges?.(e);
    if (!edges?.length) { this.host.toast(t("Click a model edge or face to convert.")); return; }
    const made: { id: string; ext: EdgeRef | null }[] = [];
    let skipped = 0;
    for (const ed of edges) {
      const g = projectEdge(ed, this.frame);
      if (!g) { skipped++; continue; }
      const ent = this.entFrom(g);
      made.push({ id: ent.id, ext: this.host.edgeRef?.(ed) ?? null });
    }
    if (!made.length) { this.host.toast(t("Only straight edges and circles square to the sketch can be converted."), "warn"); return; }
    for (const m of made) this.sk.rels.push({ id: uid("r"), t: "fix", e: [m.id], ...(m.ext ? { ext: m.ext } : {}) });
    if (skipped) this.host.toast(t("{n} edges were not converted (curves not square to the sketch).", { n: skipped }), "warn");
    this.commit("Convert entities");
    this.render();
  }

  /** A new sketch curve on projected edge geometry, reusing points already there. */
  private entFrom(g: ReturnType<typeof projectEdge> & object): SkEnt {
    const point = (q: V2) => {
      let id = this.sk.ents.find(x => x.t === "point" && Math.hypot(x.x - q[0], x.y - q[1]) < 1e-6)?.id;
      if (!id) { id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); }
      return id;
    };
    const ent: SkEnt = g.t === "line" ? { id: uid("l"), t: "line", a: point(g.a), b: point(g.b) }
      : g.t === "circle" ? { id: uid("c"), t: "circle", c: point(g.c), r: g.r }
      : { id: uid("a"), t: "arc", c: point(g.c), a: point(g.a), b: point(g.b) };
    this.sk.ents.push(ent);
    return ent;
  }

  /** Dangling On edge relations of the selection (or all of them when nothing dangling is selected). */
  danglingRels(): SkRel[] {
    const all = this.sk.rels.filter(r => r.ext && r.dangling);
    const sel = all.filter(r => this.selection.has(r.id) || r.e.some(x => this.selection.has(x)));
    return sel.length ? sel : all;
  }

  /** Re-attach (FR-SK-064): the next model edge clicked takes over the dangling relation. */
  startReattach(relId: string) {
    this.setTool("convert");
    this.reattaching = relId;
    this.host.status(t("Click the model edge the curve should follow now."));
  }

  /** Attaches the dangling relation being re-attached to the edge under the pointer. */
  private reattachAt(e: PointerEvent): boolean {
    const id = this.reattaching;
    const rel = this.sk.rels.find(r => r.id === id);
    const ed = this.host.modelEdges?.(e);
    if (!rel || !ed?.length || ed.length !== 1) { this.host.toast(t("Click one model edge.")); return false; }
    const ent = this.ent(rel.e[0]);
    const ref = this.host.edgeRef?.(ed[0]) ?? null;
    const next = structuredClone(this.sk);
    const ne = next.ents.find(x => x.id === ent?.id);
    if (rel.t === "pierce") {
      const q = ne?.t === "point" ? piercePoint(ed[0], this.frame, [ne.x, ne.y]) : null;
      if (!q || !ref || ne?.t !== "point") { this.host.toast(t("That edge does not cross the sketch plane."), "warn"); return false; }
      ne.x = q[0]; ne.y = q[1];
    } else {
      const g = projectEdge(ed[0], this.frame);
      if (!g || !ref || !ne || !applyExt(next, ne, g)) { this.host.toast(t("That edge is a different kind of curve: pick a {kind}.", { kind: t(ent?.t === "line" ? "straight edge" : ent?.t === "circle" ? "circular edge" : "arc edge") }), "warn"); return false; }
    }
    const nr = next.rels.find(r => r.id === id)!;
    nr.ext = ref!;
    delete nr.dangling;
    this.reattaching = null;
    this.sk = next;
    this.commit("Re-attach");
    this.setTool("select");
    this.host.onSelection?.([...this.selection]);
    return true;
  }

  /** Pierce (FR-SK-051): the next model edge clicked holds the point where it crosses the sketch plane. */
  startPierce(pointId: string) {
    this.setTool("convert");
    this.piercing = pointId;
    this.selection.add(pointId);
    this.host.status(t("Click a model edge that crosses the sketch plane: the point moves to where it pierces the plane."));
    this.host.onSelection?.([...this.selection]);
  }

  private pierceAt(e: PointerEvent): boolean {
    const id = this.piercing!;
    const ed = this.host.modelEdges?.(e);
    if (!ed?.length || ed.length !== 1) { this.host.toast(t("Click one model edge.")); return false; }
    const p = this.ent(id);
    const ref = this.host.edgeRef?.(ed[0]) ?? null;
    if (ref?.ctx) { this.host.toast(t("Pierce takes edges of this part only, not of other components."), "warn"); return false; }
    const q = p?.t === "point" ? piercePoint(ed[0], this.frame, [p.x, p.y]) : null;
    if (!q || !ref) { this.host.toast(t("That edge does not cross the sketch plane."), "warn"); return false; }
    const next = structuredClone(this.sk);
    const np = next.ents.find(x => x.id === id);
    if (np?.t !== "point") return false;
    np.x = q[0]; np.y = q[1];
    // A pierce replaces the point's fix and is the only thing holding it.
    next.rels = next.rels.filter(r => !(r.e.length === 1 && r.e[0] === id && (r.t === "fix" || r.t === "pierce")));
    const r = tryAdd(next, { rel: { id: uid("r"), t: "pierce", e: [id], ext: ref } });
    if (!r.ok) { this.host.toast(t("That relation conflicts with the sketch's other relations and dimensions."), "error"); return false; }
    this.piercing = null;
    this.sk = r.sketch;
    this.info = r.result;
    this.commit("Add pierce relation");
    this.setTool("select");
    this.selection.add(id);
    this.host.onSelection?.([...this.selection]);
    this.render();
    return true;
  }

  // ---------- intersection curve (FR-SK-036) ----------

  /** Where the sketch plane cuts the clicked face: lines on flat faces, arcs/circles on round faces square to the sketch, else splines; fixed, like converted edges. */
  private intersectAt(e: PointerEvent) {
    const face = this.host.modelFace?.(e);
    if (!face) { this.host.toast(t("Click a face of the model where the sketch plane cuts it.")); return; }
    const f = this.frame;
    const chains = cutTriangles(face.tri, f);
    if (!chains.length) { this.host.toast(t("The sketch plane does not cut that face."), "warn"); return; }
    const uv = (w: [number, number, number]): V2 => {
      const q = [w[0] - f.o[0], w[1] - f.o[1], w[2] - f.o[2]];
      return [q[0] * f.x[0] + q[1] * f.x[1] + q[2] * f.x[2], q[0] * f.y[0] + q[1] * f.y[1] + q[2] * f.y[2]];
    };
    const point = (q: V2) => {
      let id = this.sk.ents.find(x => x.t === "point" && Math.hypot(x.x - q[0], x.y - q[1]) < 1e-6)?.id;
      if (!id) { id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); }
      return id;
    };
    const along = face.axis ? Math.abs(face.axis[0] * f.n[0] + face.axis[1] * f.n[1] + face.axis[2] * f.n[2]) : 0;
    const straight = face.type === "plane" || (face.type === "cylinder" && along < 1e-6);
    const round = face.type === "cylinder" && face.center && face.radius && along > 1 - 1e-6;
    const made: string[] = [];
    for (const c of chains) {
      const p = c.pts, a = p[0], b = p[p.length - 1];
      if (straight && !c.closed) {
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
        const id = uid("l");
        this.sk.ents.push({ id, t: "line", a: point(a), b: point(b) });
        made.push(id);
      } else if (round && c.closed) {
        const id = uid("c");
        this.sk.ents.push({ id, t: "circle", c: point(uv(face.center!)), r: face.radius! });
        made.push(id);
      } else if (round) {
        const ctr = uv(face.center!), m = p[Math.floor(p.length / 2)];
        const ang = (q: V2) => Math.atan2(q[1] - ctr[1], q[0] - ctr[0]);
        const sw = (x: number, y: number) => { let k = y - x; while (k <= 0) k += Math.PI * 2; return k; };
        const ccw = sw(ang(a), ang(m)) < sw(ang(a), ang(b));
        // Ends exactly on the radius.
        const onR = (q: V2): V2 => { const t0 = ang(q); return [ctr[0] + face.radius! * Math.cos(t0), ctr[1] + face.radius! * Math.sin(t0)]; };
        const id = uid("a");
        this.sk.ents.push({ id, t: "arc", c: point(ctr), a: point(onR(ccw ? a : b)), b: point(onR(ccw ? b : a)) });
        made.push(id);
      } else {
        const pts = thin(c);
        if (pts.length < (c.closed ? 3 : 2)) continue;
        const id = uid("s");
        this.sk.ents.push({ id, t: "spline", pts: pts.map(point), ...(c.closed ? { closed: true } : {}) });
        made.push(id);
      }
    }
    if (!made.length) { this.host.toast(t("The sketch plane does not cut that face."), "warn"); return; }
    for (const id of made) this.sk.rels.push({ id: uid("r"), t: "fix", e: [id] });
    this.info = solve(this.sk);
    this.commit("Intersection curve");
    this.render();
  }

  /** The sketch as last handed to the host. */
  private lastCommitted: SketchFeature;

  private commit(label: string) {
    this.lastCommitted = structuredClone(this.sk);
    this.info = solve(this.sk);
    this.host.commit(label, structuredClone(this.sk));
    this.statusHint();
  }

  private emitSel() { this.host.onSelection?.([...this.selection]); }

  // ---------- keys ----------

  /**
   * Sizes typed while drawing (FR-UI-052): with an entity started, a digit opens a value box at the cursor
   * for its next size (line: length, then angle; rectangle: width, then height; circle: diameter).
   * The last Enter places the entity, with driving dimensions for the typed sizes.
   */
  private typedFields(): { name: string; q: "length" | "angle"; now: number }[] | null {
    const d = this.draft, c = d.cursor;
    const a = d.pts.at(-1);
    if (!a || !c) return null;
    const dx = c[0] - a[0], dy = c[1] - a[1];
    if ((this.lineTool || this.tool === "tarc") && d.arc) return null;
    if (this.lineTool) return [{ name: "Length", q: "length", now: Math.hypot(dx, dy) }, { name: "Angle", q: "angle", now: (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI) }];
    if ((this.tool === "rect" || this.tool === "crect") && d.pts.length === 1) {
      const k = this.tool === "crect" ? 2 : 1;
      return [{ name: "Width", q: "length", now: Math.abs(dx) * k }, { name: "Height", q: "length", now: Math.abs(dy) * k }];
    }
    if (this.tool === "circle" && d.pts.length === 1) return [{ name: "Diameter", q: "length", now: 2 * Math.hypot(dx, dy) }];
    return null;
  }

  private typed: HTMLElement | null = null;

  private openTyped(first: string) {
    const fields = this.typedFields();
    if (!fields || this.typed) return;
    this.closeInput(false);
    const vals: number[] = [];
    const box = document.createElement("div");
    box.className = "sk-typed";
    const lab = document.createElement("span");
    const inp = document.createElement("input");
    inp.className = "sk-input";
    box.append(lab, inp);
    const r = this.host.layer.getBoundingClientRect(), ev = this.lastEv;
    box.style.left = `${(ev ? ev.clientX - r.left : r.width / 2) + 16}px`;
    box.style.top = `${(ev ? ev.clientY - r.top : r.height / 2) + 16}px`;
    this.host.layer.appendChild(box);
    this.typed = box;
    const u = this.host.unit();
    const show = (i: number, text?: string) => {
      const f = fields[i];
      lab.textContent = `${t(f.name)}${f.q === "angle" ? " °" : ` ${u.name}`}`;
      inp.setAttribute("aria-label", t(f.name));
      inp.value = text ?? (f.q === "angle" ? trimNum((f.now * 180) / Math.PI, 2) : trimNum(f.now / u.mm, 4));
      if (text === undefined) inp.select();
    };
    const close = () => { box.remove(); if (this.typed === box) this.typed = null; this.host.layer.parentElement?.focus?.(); };
    const accept = () => {
      const f = fields[vals.length];
      let v: number;
      try { v = evaluate(inp.value, f.q, f.q === "angle" ? "deg" : u.name, this.host.vars?.() ?? {}); }
      catch (err) { this.host.toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), "error"); return; }
      if (f.q === "length" && !(v > 0)) { this.host.toast(t("The value must be more than 0."), "error"); return; }
      vals.push(v);
      if (vals.length < fields.length) { show(vals.length); return; }
      close();
      this.placeTyped(vals);
    };
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); accept(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (this.typed === box && document.activeElement !== inp) close(); }, 0));
    show(0, first);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }

  /** Places the started entity from typed sizes; signs follow the side the cursor is on. */
  private placeTyped(v: number[]) {
    const d = this.draft, a = d.pts.at(-1), c = d.cursor;
    if (!a || !c) return;
    const sx = c[0] < a[0] ? -1 : 1, sy = c[1] < a[1] ? -1 : 1;
    const lineOf = (made: SkEnt[]) => made.filter((x): x is SkEnt & { t: "line" } => x.t === "line" && (!x.cons || this.tool === "cline"));
    const dim = (t: SkDim["t"], e: string[], val: number): SkDim => ({ id: uid("d"), name: "", t, e, val: { v: val } });
    if (this.lineTool) {
      const [len, ang] = v;
      const deg = ((((ang * 180) / Math.PI) % 360) + 360) % 360;
      const hv = Math.abs(deg % 180) < 1e-9 || Math.abs((deg % 180) - 180) < 1e-9 ? "horizontal" : Math.abs(deg - 90) < 1e-9 || Math.abs(deg - 270) < 1e-9 ? "vertical" : null;
      const p: V2 = [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
      this.drawClick(p, { detail: 1 }, { hv, dims: made => lineOf(made).slice(0, 1).map(l => dim("distance", [l.id], len)) });
    } else if (this.tool === "rect" || this.tool === "crect") {
      const k = this.tool === "crect" ? 0.5 : 1;
      const p: V2 = [a[0] + sx * v[0] * k, a[1] + sy * v[1] * k];
      this.drawClick(p, { detail: 1 }, { hv: null, dims: made => { const ls = lineOf(made); return ls.length >= 2 ? [dim("distance", [ls[0].id], v[0]), dim("distance", [ls[1].id], v[1])] : []; } });
    } else if (this.tool === "circle") {
      this.drawClick([a[0] + v[0] / 2, a[1]], { detail: 1 }, { hv: null, dims: made => made.filter(x => x.t === "circle").slice(0, 1).map(x => dim("diameter", [x.id], v[0])) });
    }
    this.statusHint();
  }

  /** Typed sizes become driving dimensions where they add information (no toast when they do not). */
  private addTypedDims(dims: SkDim[], made: SkEnt[] = []): string[] {
    const added: string[] = [];
    // The new entities' centre: each label goes beside its line on the far side from it (not at the origin,
    // where a label without a place would sit and hide the origin from the next click).
    const pts = made.filter((x): x is SkEnt & { t: "point" } => x.t === "point").map(x => [x.x, x.y] as V2);
    const centre: V2 = pts.length ? [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length] : [0, 0];
    for (const dim of dims) {
      dim.name = this.nextDimName();
      if (!dim.pos) {
        const ent = this.ent(dim.e[0]);
        if (ent?.t === "line") {
          const a = this.pt(ent.a), b = this.pt(ent.b), mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          let n = norm2([a[1] - b[1], b[0] - a[0]]);
          if (dot2(n, sub2(mid, centre)) < 0) n = [-n[0], -n[1]];
          const off = this.px(mid) * 28;
          dim.pos = [mid[0] + n[0] * off, mid[1] + n[1] * off];
        } else if (ent?.t === "circle") {
          const c = this.pt(ent.c), k = ent.r + this.px(c) * 24;
          dim.pos = [c[0] + k * Math.SQRT1_2, c[1] + k * Math.SQRT1_2];
        } else if (ent?.t === "arc") {
          // Beside the middle of the arc, outside it.
          const c = this.pt(ent.c), a = this.pt(ent.a), b = this.pt(ent.b);
          const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
          let sw = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
          while (sw <= 0) sw += 2 * Math.PI;
          const r = Math.hypot(a[0] - c[0], a[1] - c[1]), k = r + this.px(c) * 24, m = a0 + sw / 2;
          dim.pos = [c[0] + k * Math.cos(m), c[1] + k * Math.sin(m)];
        }
      }
      const r = tryAdd(this.sk, { dim });
      if (!r.ok || r.redundant) continue;
      this.sk = r.sketch;
      this.info = r.result;
      added.push(dim.id);
    }
    return added;
  }

  /**
   * Add dimensions on creation (a CAD app's "Add dimensions"): the sizes of what the click just made.
   * Rectangles and parallelograms get width and height, a polygon its circle's diameter, circles a diameter,
   * arcs a radius and lines a length; ones the sketch already fixes are dropped by `addTypedDims`.
   */
  private autoDims(made: SkEnt[]): SkDim[] {
    const dim = (t: SkDim["t"], e: string): SkDim => {
      const d: SkDim = { id: uid("d"), name: "", t, e: [e], val: { v: 0 } };
      d.val.v = measureDim(this.sk, d);
      return d;
    };
    const lines = made.filter((x): x is SkEnt & { t: "line" } => x.t === "line" && (!x.cons || this.tool === "cline"));
    if (["rect", "crect", "rect3", "crect3", "pgram"].includes(this.tool)) return lines.slice(0, 2).map(l => dim("distance", l.id));
    if (this.tool === "polygon") return made.filter(x => x.t === "circle").slice(0, 1).map(x => dim("diameter", x.id));
    const out: SkDim[] = [];
    for (const x of made) {
      if (x.t === "circle" && !x.cons) out.push(dim("diameter", x.id));
      else if (x.t === "arc" && !x.cons) out.push(dim("radius", x.id));
    }
    for (const l of lines) out.push(dim("distance", l.id));
    return out;
  }

  /** After a Modify box changes a size mid-chain, the chain's clicked points follow the solved sketch. */
  private syncDraft() {
    const d = this.draft;
    d.ids.forEach((id, i) => { const e = id && id !== ORIGIN ? this.ent(id) : null; if (e?.t === "point" && d.pts[i]) d.pts[i] = [e.x, e.y]; });
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "escape") {
      if (this.gripDrag) { this.endGrip(false); return true; }
      if (this.quickSnap) { this.setQuickSnap(null); return true; }
      if (this.pattern) { this.cancelPattern(); this.host.onSelection?.([...this.selection]); return true; }
      if (this.draft.pts.length || this.dimDraft.picks.length) { this.setTool(this.tool); return true; }
      if (this.tool !== "select") { this.setTool("select"); return true; }
      if (this.selection.size) { this.selection.clear(); this.render(); this.emitSel(); return true; }
      return false;
    }
    if (k === "delete" || k === "backspace") return this.deleteSelection();
    if (/^[0-9.]$/.test(e.key) && this.typedFields()) { this.openTyped(e.key); return true; }
    if (k === "a" && this.lineTool && this.draft.pts.length) return this.toggleTangentArc();
    const tools: Record<string, SkTool> = { l: "line", r: "rect", c: "circle", a: "arc", d: "dim", p: "point", t: "trim", g: "polygon", f: "fillet", e: "extend", o: "offset", w: "slot" };
    if (tools[k]) { this.setTool(tools[k]); return true; }
    if (k === "q") { this.toggleConstruction(); return true; }
    return false;
  }

  statusHint() {
    const st = this.info;
    const def = st.status !== "ok" ? t("Over defined") : st.dof === 0 ? t("Fully defined") : t("Under defined, {n} DOF", { n: st.dof });
    const hints: Record<SkTool, string> = {
      select: "Click to select, drag to move; Delete removes",
      line: "Click points; double-click or Esc ends the chain",
      cline: "Click points; double-click or Esc ends the chain of construction lines",
      mline: "Click the middle of the line, then one end",
      rect: "Click two opposite corners",
      crect: "Click the centre, then a corner",
      circle: "Click the centre, then a point on the circle",
      arc: "Click the centre, the start, then the end (counter-clockwise)",
      point: "Click to place a point",
      text: "Type the text and its height in the panel, then click where it starts",
      circle3: "Click three points on the circle",
      pcircle: "Click three points or curves; the circle passes through the points and touches the lines, circles and arcs",
      arc3: "Click the start, the end, then a point on the arc",
      tarc: "Click the end of a line or arc, then the arc's end",
      polygon: "Click the centre, then a corner; set the sides in the panel",
      trim: "Click the piece of a curve to remove, up to where it crosses others",
      fillet: "Click a corner where two curves meet; set the radius in the panel",
      chamfer: "Click a corner where two lines meet; set the distance in the panel",
      extend: "Click a line or arc near the end to extend it to the next curve",
      split: "Click a line or arc where it should be split in two",
      segment: "Click a line, an arc or a circle to divide it into equal pieces",
      jog: "Click a line where the jog starts, then where it ends and how far it steps out",
      offset: "Move to the side to offset to, then click the curve or chain; set the distance in the panel",
      convert: "Click model edges (or a face for all its edges) to copy them into the sketch",
      intersect: "Click model faces: the curves where the sketch plane cuts them are added",
      slot: "Click the two centres, then the width",
      rect3: "Click two corners for the first side, then the width",
      crect3: "Click the centre, the middle of a side, then a corner",
      pgram: "Click three corners; the fourth follows",
      cslot: "Click the slot's centre, then one end, then the width",
      aslot: "Click the arc's centre, the start, the end (counter-clockwise), then the width",
      aslot3: "Click the start, the end, a point on the arc, then the width",
      spline: "Click points the spline passes through; double-click ends it, clicking the first point closes it",
      ellipse: "Click the centre, the end of the major axis, then a point on the ellipse",
      earc: "Click the centre, the end of the major axis, the start, then the end (counter-clockwise)",
      sspline: "Click the control points; the curve follows them without passing through. Double-click ends it",
      conic: "Click the start, the end, the top vertex where the end tangents meet, then a point the conic passes through",
      parabola: "Click the focus, the vertex, then the start and the end",
      eqn: "Type the equation and its range in the panel, then Add curve",
      dim: "Click one or two items, then click where the dimension goes",
      hord: "Click the base point, then where the values go, then each point to dimension along X",
      vord: "Click the base point, then where the values go, then each point to dimension along Y",
    };
    // Cursor position in sketch coordinates (FR-SK-047).
    const u = this.host.unit(), c = this.cursorUV;
    const at = c ? ` · x ${trimNum(c[0] / u.mm, u.decimals)}, y ${trimNum(c[1] / u.mm, u.decimals)} ${u.name}` : "";
    const qs = this.quickSnap ? ` · ${t("Quick snap")}: ${t(SNAP_KINDS.find(k => k[0] === this.quickSnap)![1])}` : "";
    const hint = this.tool === "tarc" && this.draft.pts.length ? "Tangent arc: click its end; the next arc goes on from it; Esc ends" : this.arcMode ? "Tangent arc: click its end; A goes back to lines" : this.lineTool && this.draft.pts.length ? "Click points; double-click or Esc ends the chain; A or moving back to the end point draws a tangent arc" : hints[this.tool];
    const dm = this.dynMirror ? ` · ${t("Dynamic mirror on")}` : "";
    this.host.status(`${def} · ${t(hint)}${dm}${qs}${at}`);
  }

  // ---------- drawing the sketch ----------

  private clearGroup() {
    for (const c of this.group.children) {
      const o = c as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose?.();
    }
    this.group.clear();
  }

  private dimPoints(d: SkDim): [V2, V2] | null {
    const pts = this.dimPoints0(d);
    if (!pts || !d.cond?.some(c => c !== "c") || d.e.length !== 2 || d.off) return pts;
    // Arc conditions (FR-SK-060): a circle/arc end moves from its centre to its near or far side along the measure.
    const [a, b] = pts;
    let u: V2 = d.t === "hdistance" ? [Math.sign(b[0] - a[0]) || 1, 0] : d.t === "vdistance" ? [0, Math.sign(b[1] - a[1]) || 1] : norm2(sub2(b, a));
    if (!(Math.hypot(...u) > 1e-12)) u = [1, 0];
    const out: [V2, V2] = [a, b];
    // With a line, the circle's centre is always the second point (the first is its foot on the line).
    const withLine = d.e.some(id => id !== ORIGIN && this.ent(id)?.t === "line");
    for (const i of [0, 1]) {
      const c = d.cond[i], e = d.e[i] === ORIGIN ? undefined : this.ent(d.e[i]);
      if ((c !== "min" && c !== "max") || (e?.t !== "circle" && e?.t !== "arc")) continue;
      const r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - this.pt(e.c)[0], this.pt(e.a)[1] - this.pt(e.c)[1]);
      const k = withLine ? 1 : i;
      // The first end moves along u for its near side, the second against it.
      const s = (c === "min" ? 1 : -1) * (k === 0 ? 1 : -1);
      out[k] = [out[k][0] + u[0] * r * s, out[k][1] + u[1] * r * s];
    }
    return out;
  }

  private dimPoints0(d: SkDim): [V2, V2] | null {
    const kind = (id: string) => (id === ORIGIN ? "point" : this.ent(id)?.t);
    const centreOf = (id: string): V2 => { const e = this.ent(id); return e && (e.t === "circle" || e.t === "arc") ? this.pt(e.c) : this.pt(id); };
    if (d.e.length === 1 && kind(d.e[0]) === "line") { const l = this.ent(d.e[0]) as SkEnt & { t: "line" }; return [this.pt(l.a), this.pt(l.b)]; }
    if (d.off) {
      // Radial offset of concentric curves: both rims on the ray from the centre towards the text.
      const e0 = this.ent(d.e[0]), e1 = this.ent(d.e[1]);
      if (!e0 || !e1 || (e0.t !== "arc" && e0.t !== "circle") || (e1.t !== "arc" && e1.t !== "circle")) return null;
      const c = this.pt(e0.c), rad = (x: SkEnt & { t: "arc" | "circle" }) => (x.t === "circle" ? x.r : Math.hypot(this.pt(x.a)[0] - this.pt(x.c)[0], this.pt(x.a)[1] - this.pt(x.c)[1]));
      const ref = d.pos && Math.hypot(d.pos[0] - c[0], d.pos[1] - c[1]) > 1e-9 ? d.pos : e1.t === "arc" ? this.pt(e1.a) : ([c[0] + 1, c[1]] as V2);
      const u = norm2(sub2(ref, c));
      return [[c[0] + u[0] * rad(e0), c[1] + u[1] * rad(e0)], [c[0] + u[0] * rad(e1), c[1] + u[1] * rad(e1)]];
    }
    if (d.e.length === 2 && kind(d.e[0]) !== "line" && kind(d.e[1]) !== "line") return [centreOf(d.e[0]), centreOf(d.e[1])];
    if (d.e.length === 2) {
      // Point/line or line/line: from the point (or second line's start) to its foot on the line.
      const li = kind(d.e[0]) === "line" ? 0 : 1;
      const l = this.ent(d.e[li]) as SkEnt & { t: "line" };
      const other = d.e[1 - li];
      const p = kind(other) === "line" ? this.pt((this.ent(other) as SkEnt & { t: "line" }).a) : centreOf(other);
      const a = this.pt(l.a), b = this.pt(l.b), u = sub2(b, a), l2 = dot2(u, u) || 1, tt = dot2(sub2(p, a), u) / l2;
      const foot: V2 = [a[0] + u[0] * tt, a[1] + u[1] * tt];
      // A diameter about a centerline spans from the mirror image of the point to the point.
      return [d.dia ? [2 * foot[0] - p[0], 2 * foot[1] - p[1]] : foot, p];
    }
    return null;
  }

  render() {
    if (this.disposed) return;
    this.syncPictures();
    this.dark = document.documentElement.dataset.theme === "dark";
    const C = this.dark ? COLORS.dark : COLORS.light;
    this.clearGroup();
    const segs: number[] = [], cols: number[] = [];
    const dimSegs: number[] = [], dimCols: number[] = [];
    const lost = new Set(this.sk.rels.filter(r => r.ext && r.dangling).map(r => r.e[0]));
    const hr = this.hoverRel ? this.sk.rels.find(r => r.id === this.hoverRel) : null;
    this.relHot = new Set(hr ? hr.e : []);
    const color = (id: string, cons?: boolean) => {
      if (this.selection.has(id)) return C.sel;
      if (this.hover?.id === id || this.relHot.has(id)) return C.hover;
      if (lost.has(id)) return this.dark ? DANGLING.dark : DANGLING.light;
      if (this.info.status !== "ok" && this.info.conflicting.length) return C.bad;
      if (cons) return C.cons;
      return this.info.defined.has(id) ? C.defined : C.free;
    };
    const push = (a: V2, b: V2, c: number, out = segs, oc = cols) => {
      const A = this.w(a), B = this.w(b);
      out.push(A.x, A.y, A.z, B.x, B.y, B.z);
      const k = new THREE.Color(c);
      oc.push(k.r, k.g, k.b, k.r, k.g, k.b);
    };
    const poly = (pts: V2[], c: number, out = segs, oc = cols) => { for (let i = 0; i + 1 < pts.length; i++) push(pts[i], pts[i + 1], c, out, oc); };

    // Sketch axes through the origin, short.
    const ax = this.px([0, 0]) * 40;
    push([-ax * 0.25, 0], [ax, 0], 0xd9480f, dimSegs, dimCols);
    push([0, -ax * 0.25], [0, ax], 0x2f9e44, dimSegs, dimCols);

    for (const e of this.sk.ents) {
      const c = color(e.id, e.cons);
      if (e.t === "line") push(this.pt(e.a), this.pt(e.b), c);
      else if (e.t === "circle") poly(arcPts(this.pt(e.c), e.r, 0, Math.PI * 2, 72), c);
      else if (e.t === "arc") {
        const cc = this.pt(e.c), a = this.pt(e.a), b = this.pt(e.b);
        const a0 = Math.atan2(a[1] - cc[1], a[0] - cc[0]);
        let a1 = Math.atan2(b[1] - cc[1], b[0] - cc[0]);
        while (a1 <= a0) a1 += Math.PI * 2;
        poly(arcPts(cc, Math.hypot(a[0] - cc[0], a[1] - cc[1]), a0, a1), c);
      } else if (e.t === "ellipse") poly(this.ellLine(e), c);
      else if (e.t === "spline") {
        poly(this.splineLine(e), c);
        // A conic's top vertex or a style spline's control polygon: thin lines between its points.
        if (hasControl(e)) { const q = e.pts.map(id => this.pt(id)); for (let i = 0; i + 1 < q.length; i++) push(q[i], q[i + 1], C.cons, dimSegs, dimCols); }
      } else if (e.t === "text") {
        const at = this.pt(e.p), path = textPath(this.sk.ents, e), ls = textPolys(e, at, path);
        for (const l of ls) poly(l, c);
        // Text whose outline is still loading: its box, dashed by the colour of construction.
        if (!ls.length) { const b = textBox(e, at, path); poly([...b, b[0]], C.cons); }
      }
    }
    // Under-defined analysis (FR-SLV-010): orange arrows show where the selected items can still move.
    if (this.tool === "select" && this.selection.size && this.info.status === "ok" && this.info.dof > 0) {
      const pts = new Set<string>();
      for (const id of this.selection) {
        const e = this.ent(id);
        if (!e) continue;
        if (e.t === "point") pts.add(e.id);
        else if (e.t === "line") { pts.add(e.a); pts.add(e.b); }
        else if (e.t === "circle" || e.t === "ellipse") pts.add(e.c);
        else if (e.t === "arc") { pts.add(e.c); pts.add(e.a); pts.add(e.b); }
        else if (e.t === "spline") e.pts.forEach(q => pts.add(q));
      }
      const L = this.px([0, 0]) * 26, H = L * 0.3;
      this.freeArrows = 0;
      for (const [id, dirs] of freeDirections(this.sk, [...pts])) {
        const o = this.pt(id);
        for (const u of dirs) for (const sg of [1, -1]) {
          const dx = u[0] * sg, dy = u[1] * sg;
          const a: V2 = [o[0] + dx * L * 0.3, o[1] + dy * L * 0.3], tip: V2 = [o[0] + dx * L, o[1] + dy * L];
          push(a, tip, FREE_ARROW, dimSegs, dimCols);
          push(tip, [tip[0] - dx * H - dy * H * 0.6, tip[1] - dy * H + dx * H * 0.6], FREE_ARROW, dimSegs, dimCols);
          push(tip, [tip[0] - dx * H + dy * H * 0.6, tip[1] - dy * H - dx * H * 0.6], FREE_ARROW, dimSegs, dimCols);
          this.freeArrows++;
        }
      }
    } else this.freeArrows = 0;
    // Preview of the entity being drawn.
    const d = this.draft;
    if (d.pts.length && d.cursor && this.tool !== "jog") {
      const p = d.cursor, a = d.pts[0];
      if ((this.lineTool || this.tool === "tarc") && d.arc) { const g = this.tangentArc(p); if (g) poly(arcPts(g.c, g.r, g.a0, g.a0 + g.sweep, 48), C.pre); else push(d.pts.at(-1)!, p, C.pre); }
      else if (this.lineTool) push(d.pts.at(-1)!, p, C.pre);
      else if (this.tool === "mline") push([2 * a[0] - p[0], 2 * a[1] - p[1]], p, C.pre);
      else if (this.tool === "circle") poly(arcPts(a, Math.hypot(p[0] - a[0], p[1] - a[1]), 0, Math.PI * 2, 72), C.pre);
      else if (this.tool === "rect" || this.tool === "crect") {
        const [x0, y0] = this.tool === "rect" ? a : [2 * a[0] - p[0], 2 * a[1] - p[1]];
        poly([[x0, y0], [p[0], y0], [p[0], p[1]], [x0, p[1]], [x0, y0]], C.pre);
      } else if (this.tool === "rect3" || this.tool === "crect3" || this.tool === "pgram") {
        const q = d.pts.length === 2 ? quadCorners(this.tool, d.pts[0], d.pts[1], p) : null;
        if (q) poly([...q, q[0]], C.pre);
        else poly([d.pts[0], d.pts.length === 2 ? d.pts[1] : p], C.pre);
      } else if (this.tool === "polygon") {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]), a0 = Math.atan2(p[1] - a[1], p[0] - a[0]), n = this.polySides;
        poly(Array.from({ length: n + 1 }, (_, i) => [a[0] + r * Math.cos(a0 + (2 * Math.PI * i) / n), a[1] + r * Math.sin(a0 + (2 * Math.PI * i) / n)] as V2), C.pre);
      } else if (this.tool === "pcircle") {
        const sol = d.pts.length === 2 ? this.perimFit([...d.pts, p], [...(d.curves ?? []), this.draft.hoverCurve ?? null]) : null;
        if (sol) poly(arcPts(sol.c, sol.r, 0, Math.PI * 2, 72), C.pre);
        else push(d.pts.at(-1)!, p, C.pre);
      } else if (this.tool === "circle3" || this.tool === "arc3") {
        const c = d.pts.length === 2 ? circumcentre(d.pts[0], d.pts[1], p) : null;
        if (!c) push(d.pts.at(-1)!, p, C.pre);
        else {
          const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
          if (this.tool === "circle3") poly(arcPts(c, r, 0, Math.PI * 2, 72), C.pre);
          else {
            const ang = (q: V2) => Math.atan2(q[1] - c[1], q[0] - c[0]);
            const sw = (a0: number, a1: number) => { let x = a1 - a0; while (x <= 0) x += Math.PI * 2; return x; };
            const [s0, s1] = sw(ang(d.pts[0]), ang(p)) < sw(ang(d.pts[0]), ang(d.pts[1])) ? [d.pts[0], d.pts[1]] : [d.pts[1], d.pts[0]];
            poly(arcPts(c, r, ang(s0), ang(s0) + sw(ang(s0), ang(s1))), C.pre);
          }
        }
      } else if (this.tool === "conic") {
        const [a0, b0, v0] = [d.pts[0], d.pts[1] ?? p, d.pts[2] ?? p];
        if (d.pts.length < 2) push(a0, p, C.pre);
        else if (d.pts.length === 2) { push(a0, b0, C.cons); poly(bezPts(conicBezier(a0, v0, b0, 0.5), 32), C.pre); push(a0, v0, C.cons); push(v0, b0, C.cons); }
        else { poly(bezPts(conicBezier(a0, v0, b0, rhoAt(a0, v0, b0, p)), 4), C.pre); push(a0, v0, C.cons); push(v0, b0, C.cons); const sh = conicShoulder(a0, v0, b0, rhoAt(a0, v0, b0, p)); push([(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], sh, C.cons); }
      } else if (this.tool === "parabola") {
        if (d.pts.length < 2) push(a, p, C.cons);
        else {
          const f = d.pts[0], v = d.pts[1];
          // Before the ends are picked, a wide piece of the parabola shows its shape.
          const s0 = d.pts[2] ?? [v[0] - (f[1] - v[1]) * 3, v[1] + (f[0] - v[0]) * 3] as V2;
          const s1 = d.pts.length === 3 ? p : ([v[0] + (f[1] - v[1]) * 3, v[1] - (f[0] - v[0]) * 3] as V2);
          push(f, v, C.cons);
          const q = parabolaFrom(f, v, s0, s1);
          if (q) poly(bezPts(conicBezier(q[0], q[1], q[2], 0.5), 48), d.pts.length === 3 ? C.pre : C.cons);
        }
      } else if (this.tool === "sspline") {
        const q = [...d.pts, p];
        poly(q, C.cons);
        poly(bezPts(styleBezier(q), 16), C.pre);
      } else if (this.tool === "spline") {
        const closing = d.pts.length >= 3 && Math.hypot(p[0] - a[0], p[1] - a[1]) < this.px(p) * 3;
        poly(bezPts(splineBezier(closing ? d.pts : [...d.pts, p], closing), 16), C.pre);
      } else if (this.tool === "ellipse" || this.tool === "earc") {
        if (d.pts.length === 1) push(a, p, C.pre);
        else {
          const E = this.draftEll(a, d.pts[1], d.pts[2] ?? p);
          push(a, d.pts[1], C.pre);
          if (E && d.pts.length === 2) poly(ellPts(E), C.pre);
          else if (E) {
            // Arc: the whole ellipse faint, the part kept from the start to the cursor.
            const t0 = ellParam(E, d.pts[2]);
            poly(ellPts(E, t0, ellSweep(t0, ellParam(E, p)), 64), C.pre);
          }
        }
      } else if (this.tool === "arc") {
        if (d.pts.length === 1) push(a, p, C.pre);
        else {
          const s = d.pts[1], r = Math.hypot(s[0] - a[0], s[1] - a[1]);
          const a0 = Math.atan2(s[1] - a[1], s[0] - a[0]);
          let a1 = Math.atan2(p[1] - a[1], p[0] - a[0]);
          while (a1 <= a0) a1 += Math.PI * 2;
          if (this.arcTurn < 0) poly(arcPts(a, r, a1 - Math.PI * 2, a0), C.pre);
          else poly(arcPts(a, r, a0, a1), C.pre);
        }
      }
    }
    for (const pl of this.offsetPreview) poly(pl, C.pre);
    if (this.pattern) for (const pl of this.patternPreview()) poly(pl, C.pre);
    if (this.box) {
      const { a: p0, b: p1 } = this.box;
      poly([p0, [p1[0], p0[1]], p1, [p0[0], p1[1]], p0], C.sel, dimSegs, dimCols);
    }
    if ((this.tool === "slot" || this.tool === "cslot") && d.pts.length && d.cursor) {
      const [c1, c2] = slotCentres(d.pts[0], d.pts.length === 1 ? d.cursor : d.pts[1], this.tool === "cslot");
      const w = d.pts.length === 1 ? this.px(c1) * 12 : Math.abs(lineSide(c1, c2, d.cursor));
      for (const pl of slotOutline(c1, c2, w)) poly(pl, C.pre);
    }
    if ((this.tool === "aslot" || this.tool === "aslot3") && d.pts.length && d.cursor) {
      const q = d.cursor;
      if (d.pts.length === 1) poly([d.pts[0], q], C.pre);
      else {
        const ax = d.pts.length === 2 ? this.slotAxis(d.pts[0], d.pts[1], q) : this.slotAxis(d.pts[0], d.pts[1], d.pts[2]);
        if (ax) for (const pl of arcSlotOutline(ax, d.pts.length === 2 ? 0 : arcSlotHalfWidth(ax, q))) poly(pl, C.pre);
        else poly([d.pts[0], d.pts[1], q], C.pre);
      }
    }
    // Dimension lines.
    const dims = [...this.sk.dims, ...(this.dimDraft.dim ? [this.dimDraft.dim] : [])];
    const triPos: number[] = [], triCol: number[] = [];
    for (const dm of dims) {
      const c = this.selection.has(dm.id) ? C.sel : C.dim;
      this.dimGeometry(dm, (a, b) => push(a, b, c, dimSegs, dimCols), (tip, w) => {
        const H = this.arrowLen(tip), q: V2 = [-w[1], w[0]];
        const base: V2 = [tip[0] - w[0] * H, tip[1] - w[1] * H];
        const k = new THREE.Color(c);
        for (const p of [tip, [base[0] + q[0] * H * 0.3, base[1] + q[1] * H * 0.3], [base[0] - q[0] * H * 0.3, base[1] - q[1] * H * 0.3]] as V2[]) {
          const W = this.w(p);
          triPos.push(W.x, W.y, W.z);
          triCol.push(k.r, k.g, k.b);
        }
      });
    }
    if (triPos.length) {
      const tg = new THREE.BufferGeometry();
      tg.setAttribute("position", new THREE.Float32BufferAttribute(triPos, 3));
      tg.setAttribute("color", new THREE.Float32BufferAttribute(triCol, 3));
      const tm = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, side: THREE.DoubleSide }));
      tm.renderOrder = 3000;
      tm.raycast = () => {};
      tm.userData.skArrows = true;
      this.group.add(tm);
    }
    // Instant 2D ruler: ticks every snap step along the drag, a longer one every fifth (FR-SK-067).
    const gd = this.gripDrag;
    if (gd) {
      const nrm: V2 = [-gd.dir[1], gd.dir[0]], h = this.px(gd.p0) * 4;
      const cur = this.sk.dims.find(x => x.id === gd.id)?.val.v ?? gd.v0;
      const n0 = Math.round(cur / gd.step);
      for (let n = Math.max(1, n0 - 12); n <= n0 + 12; n++) {
        const s = (n * gd.step) / gd.k, q: V2 = [gd.from[0] + gd.dir[0] * s, gd.from[1] + gd.dir[1] * s], L = n % 5 === 0 ? 2 : 1;
        push([q[0] - nrm[0] * h * L, q[1] - nrm[1] * h * L], [q[0] + nrm[0] * h * L, q[1] + nrm[1] * h * L], n === n0 ? C.sel : C.dim, dimSegs, dimCols);
      }
    }

    const v = this.host.viewer;
    const mkLines = (s: number[], c: number[], width: number) => {
      if (!s.length) return;
      const g = new LineSegmentsGeometry();
      g.setPositions(s);
      g.setColors(c);
      const m = new LineMaterial({ vertexColors: true, linewidth: width, worldUnits: false, depthTest: false, transparent: true });
      m.resolution.set(v.size.x, v.size.y);
      const l = new LineSegments2(g, m);
      l.renderOrder = 3000;
      l.raycast = () => {};
      this.group.add(l);
    };
    mkLines(segs, cols, 2.2);
    mkLines(dimSegs, dimCols, 1.1);

    // Points.
    const pp: number[] = [], pc: number[] = [];
    const addPt = (p: V2, c: number) => { const w = this.w(p); pp.push(w.x, w.y, w.z); const k = new THREE.Color(c); pc.push(k.r, k.g, k.b); };
    addPt([0, 0], this.selection.has(ORIGIN) ? color(ORIGIN) : 0xd9480f);
    for (const e of this.sk.ents) if (e.t === "point") addPt([e.x, e.y], color(e.id));
    if (d.cursor && !["select", "dim", "hord", "vord", "trim", "fillet", "chamfer", "extend", "split", "jog", "segment", "offset", "convert", "intersect", "eqn"].includes(this.tool)) addPt(d.cursor, C.pre);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
    pg.setAttribute("color", new THREE.Float32BufferAttribute(pc, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    pts.renderOrder = 3001;
    this.group.add(pts);

    this.syncLabels(dims);
    this.cursorLabel();
    v.invalidate();
  }

  /** The live size beside the cursor while drawing (a CAD app shows length, radius, angle). */
  private cursorLabel() {
    let el = this.host.layer.querySelector<HTMLElement>(".sk-cursor");
    const d = this.draft, p = d.cursor, a = d.pts[0];
    const u = this.host.unit();
    const L = (x: number) => trimNum(x / u.mm, u.decimals);
    let text = "";
    if (p && a) {
      const last = d.pts.at(-1)!;
      if ((this.lineTool || this.tool === "tarc") && d.arc) { const g = this.tangentArc(p); text = g ? `R ${L(g.r)} · ${trimNum((Math.abs(g.sweep) * 180) / Math.PI, 1)}°` : ""; }
      else if (this.tool === "mline") text = `L ${L(2 * Math.hypot(p[0] - a[0], p[1] - a[1]))}`;
      else if (this.lineTool) { const dx = p[0] - last[0], dy = p[1] - last[1]; text = `L ${L(Math.hypot(dx, dy))} · ${trimNum((((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360, 1)}°`; }
      else if (this.tool === "circle" || this.tool === "polygon") text = `R ${L(Math.hypot(p[0] - a[0], p[1] - a[1]))}`;
      else if ((this.tool === "ellipse" || this.tool === "earc") && d.pts.length < 3) {
        const E = d.pts.length === 2 ? this.draftEll(a, d.pts[1], p) : null;
        text = d.pts.length === 1 ? `R ${L(Math.hypot(p[0] - a[0], p[1] - a[1]))}` : E ? `${L(E.r1 * 2)} × ${L(E.r2 * 2)}` : "";
      }
      else if (this.tool === "conic" && d.pts.length === 3) text = `ρ ${trimNum(rhoAt(d.pts[0], d.pts[2], d.pts[1], p), 3)}`;
      else if (this.tool === "rect") text = `${L(Math.abs(p[0] - a[0]))} × ${L(Math.abs(p[1] - a[1]))}`;
      else if (this.tool === "crect") text = `${L(Math.abs(p[0] - a[0]) * 2)} × ${L(Math.abs(p[1] - a[1]) * 2)}`;
      else if (this.tool === "arc") text = d.pts.length === 1 ? `R ${L(Math.hypot(p[0] - a[0], p[1] - a[1]))}` : (() => { const s = d.pts[1]; let x = Math.atan2(p[1] - a[1], p[0] - a[0]) - Math.atan2(s[1] - a[1], s[0] - a[0]); while (x <= 0) x += Math.PI * 2; return `A ${trimNum((x * 180) / Math.PI, 1)}°`; })();
    }
    if (!text) { el?.remove(); return; }
    if (!el) { el = document.createElement("div"); el.className = "sk-cursor"; el.setAttribute("aria-hidden", "true"); this.host.layer.appendChild(el); }
    el.textContent = text;
    const [x, y] = this.screen(p!);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  /** Arrowhead length in sketch units at a point (9 px). */
  private arrowLen(p: V2) { return this.px(p) * 9; }

  /** Inside or outside arrowheads of a dimension (FR-SK-068): as stored, else outside when the inside is too short. */
  arrowsOf(dm: SkDim): "in" | "out" {
    if (dm.arrows) return dm.arrows;
    if (dm.t === "radius" || dm.t === "diameter") return "in";
    const g = this.linearEnds(dm);
    return g && Math.hypot(g.fb[0] - g.fa[0], g.fb[1] - g.fa[1]) < 3.2 * this.arrowLen(g.fa) ? "out" : "in";
  }

  /** The ends of a linear dimension's line (on the extension lines from the measured points a and b). */
  private linearEnds(dm: SkDim): { a: V2; b: V2; fa: V2; fb: V2; dir: V2 } | null {
    if (dm.t === "radius" || dm.t === "diameter" || dm.t === "angle" || dm.t === "arclen" || dm.ord) return null;
    const pts = this.dimPoints(dm);
    if (!pts) return null;
    const pos = dm.pos ?? [0, 0];
    const [a, b] = pts;
    let dir: V2 = dm.t === "hdistance" ? [1, 0] : dm.t === "vdistance" ? [0, 1] : norm2(sub2(b, a));
    if (Math.hypot(...dir) < 1e-12) dir = [1, 0];
    const nrm: V2 = [-dir[1], dir[0]];
    const off = (p: V2) => dot2(sub2(pos, p), nrm);
    return { a, b, dir, fa: [a[0] + nrm[0] * off(a), a[1] + nrm[1] * off(a)], fb: [b[0] + nrm[0] * off(b), b[1] + nrm[1] * off(b)] };
  }

  /** Where the arrow flip dot of a selected dimension sits: the first end of a linear one, the far rim of a diameter. */
  private arrowDotAt(dm: SkDim): V2 | null {
    if (dm.t === "diameter") {
      const e = this.ent(dm.e[0]);
      if (!e || (e.t !== "circle" && e.t !== "arc")) return null;
      const pos = dm.pos ?? [0, 0], c = this.pt(e.c), r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]);
      const a = Math.atan2(pos[1] - c[1], pos[0] - c[0]);
      return [c[0] - r * Math.cos(a), c[1] - r * Math.sin(a)];
    }
    return this.linearEnds(dm)?.fa ?? null;
  }

  /** Flips a dimension's arrowheads between inside and outside (FR-SK-068): one undo step. */
  flipArrows(id: string) {
    const dm = this.sk.dims.find(x => x.id === id);
    if (!dm || dm.t === "angle" || dm.t === "arclen" || dm.ord) return;
    dm.arrows = this.arrowsOf(dm) === "in" ? "out" : "in";
    this.commit("Flip dimension arrows");
  }

  private dimGeometry(dm: SkDim, line: (a: V2, b: V2) => void, arrow: (tip: V2, dir: V2) => void = () => {}) {
    const pos = dm.pos ?? [0, 0];
    if (dm.t === "radius" || dm.t === "diameter") {
      const e = this.ent(dm.e[0]);
      if (!e || (e.t !== "circle" && e.t !== "arc")) return;
      const c = this.pt(e.c), r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]);
      const a = Math.atan2(pos[1] - c[1], pos[0] - c[0]), u: V2 = [Math.cos(a), Math.sin(a)];
      const rim: V2 = [c[0] + r * u[0], c[1] + r * u[1]];
      line(dm.t === "diameter" ? [c[0] - r * u[0], c[1] - r * u[1]] : c, rim);
      line(rim, pos);
      // Arrowheads on the rim (FR-SK-068): inside pointing out at it, or outside pointing in with a short tail.
      const out = this.arrowsOf(dm) === "out", H = this.arrowLen(rim);
      const rims: [V2, V2][] = [[rim, u]];
      if (dm.t === "diameter") rims.push([[c[0] - r * u[0], c[1] - r * u[1]], [-u[0], -u[1]]]);
      for (const [q, w] of rims) {
        if (!out) { arrow(q, w); continue; }
        arrow(q, [-w[0], -w[1]]);
        line(q, [q[0] + w[0] * 2.2 * H, q[1] + w[1] * 2.2 * H]);
      }
      return;
    }
    if (dm.t === "angle") {
      const l1 = this.ent(dm.e[0]), l2 = this.ent(dm.e[1]);
      if (l1?.t !== "line" || l2?.t !== "line") return;
      const I = intersect(this.pt(l1.a), this.pt(l1.b), this.pt(l2.a), this.pt(l2.b));
      if (I) line(I, pos);
      return;
    }
    if (dm.t === "arclen") {
      // Arc length: radial extension lines from the arc's ends out to a concentric dimension arc through the text.
      const e = this.ent(dm.e[0]);
      if (e?.t !== "arc") return;
      const c = this.pt(e.c), A = this.pt(e.a), B = this.pt(e.b);
      const a0 = Math.atan2(A[1] - c[1], A[0] - c[0]);
      let sw = Math.atan2(B[1] - c[1], B[0] - c[0]) - a0;
      while (sw <= 1e-12) sw += Math.PI * 2;
      const R = Math.max(Math.hypot(pos[0] - c[0], pos[1] - c[1]), 1e-9);
      const at = (a: number): V2 => [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
      line(A, at(a0)); line(B, at(a0 + sw));
      const n = Math.max(8, Math.ceil(sw / 0.08));
      for (let k = 0; k < n; k++) line(at(a0 + (sw * k) / n), at(a0 + (sw * (k + 1)) / n));
      arrow(at(a0), [Math.sin(a0), -Math.cos(a0)]);
      arrow(at(a0 + sw), [-Math.sin(a0 + sw), Math.cos(a0 + sw)]);
      return;
    }
    const pts = this.dimPoints(dm);
    if (!pts) return;
    const [a, b] = pts;
    if (dm.ord) {
      // Ordinate: leaders from the base and the point to the row of values, no dimension line.
      const ax = dm.t === "hdistance" ? 1 : 0;
      for (const q of [a, b]) line(q, ax === 1 ? [q[0], pos[1]] : [pos[0], q[1]]);
      return;
    }
    let dir: V2 = dm.t === "hdistance" ? [1, 0] : dm.t === "vdistance" ? [0, 1] : norm2(sub2(b, a));
    if (Math.hypot(...dir) < 1e-12) dir = [1, 0];
    const nrm: V2 = [-dir[1], dir[0]];
    // The dimension line runs through pos, along dir; extension lines from a and b.
    const off = (p: V2) => dot2(sub2(pos, p), nrm);
    const fa: V2 = [a[0] + nrm[0] * off(a), a[1] + nrm[1] * off(a)], fb: V2 = [b[0] + nrm[0] * off(b), b[1] + nrm[1] * off(b)];
    line(a, fa); line(b, fb); line(fa, fb);
    // Arrowheads at the ends (FR-SK-068): inside pointing out at the extension lines, or outside pointing in with tails.
    const len = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]);
    const u: V2 = len > 1e-12 ? [(fb[0] - fa[0]) / len, (fb[1] - fa[1]) / len] : dir;
    if (this.arrowsOf(dm) === "in") { arrow(fa, [-u[0], -u[1]]); arrow(fb, u); }
    else {
      const T = 2.2 * this.arrowLen(fa);
      arrow(fa, u); arrow(fb, [-u[0], -u[1]]);
      line([fa[0] - u[0] * T, fa[1] - u[1] * T], fa); line(fb, [fb[0] + u[0] * T, fb[1] + u[1] * T]);
    }
  }

  // ---------- labels (dimension values, relation glyphs) ----------

  private syncLabels(dims: SkDim[]) {
    const seen = new Set<string>();
    const u = this.host.unit();
    const mk = (id: string, cls: string) => {
      let el = this.labels.get(id);
      if (!el) {
        const b = el = document.createElement("button");
        el.className = cls;
        el.dataset.id = id;
        // Dimension names are the user's ("D1@Sketch1"): not translated.
        if (cls.includes("sk-dim")) el.setAttribute("translate", "no");
        el.addEventListener("pointerdown", e => { e.stopPropagation(); this.labelDown(id, b, e); });
        el.addEventListener("click", ev => {
          ev.stopPropagation();
          if (b.dataset.dragged) { delete b.dataset.dragged; return; }
          if (cls.includes("sk-dim")) {
            if (this.tool === "select" && (ev.detail >= 2 || this.selection.has(id))) { this.editDim(id); return; }
          }
          if (!(ev as MouseEvent).ctrlKey && !(ev as MouseEvent).shiftKey) this.selection.clear();
          this.selection.add(id);
          this.render();
          this.emitSel();
        });
        el.addEventListener("dblclick", ev => { ev.stopPropagation(); if (cls.includes("sk-dim")) this.editDim(id); });
        if (cls.includes("sk-rel")) {
          // Hovering a relation glyph lights up the entities it ties (FR-SK-053).
          el.addEventListener("pointerenter", () => { this.hoverRel = id; this.render(); });
          el.addEventListener("pointerleave", () => { if (this.hoverRel === id) { this.hoverRel = null; this.render(); } });
        }
        this.host.layer.appendChild(el);
        this.labels.set(id, el);
      }
      seen.add(id);
      return el;
    };
    for (const d of dims) {
      const el = mk(d.id, "sk-dim");
      const v = d.t === "angle" ? `${trimNum((d.val.v * 180) / Math.PI, 2)}°` : `${d.t === "diameter" ? "⌀" : d.t === "radius" ? "R" : d.t === "arclen" ? "◠" : ""}${trimNum((d.driven ? measureDim(this.sk, d) : d.val.v) / u.mm, u.decimals)}`;
      el.textContent = d.driven ? `(${v})` : v;
      if (d.dia && !d.driven) el.textContent = `⌀${v}`;
      else if (d.dia) el.textContent = `(⌀${v})`;
      // Full name on hover (FR-SK-065), as expressions use it.
      el.title = `${d.name}@${this.sk.name}${d.val.expr ? ` = ${d.val.expr}` : ""}${d.driven ? ` · ${t("reference")}` : ""}`;
      if (this.showNames) { const n = document.createElement("span"); n.className = "sk-dname"; n.textContent = d.name; n.setAttribute("translate", "no"); el.prepend(n); }
      el.classList.toggle("sel", this.selection.has(d.id));
      el.classList.toggle("driven", !!d.driven);
      el.classList.toggle("draft", d === this.dimDraft.dim);
      el.classList.toggle("locked", d === this.dimDraft.dim && !!this.dimDraft.lock);
      el.dataset.pos = JSON.stringify(this.labelPos(d));
    }
    // Ordinate dimensions: a 0 at the base of each row.
    for (const d of dims) {
      if (!d.ord || !d.pos) continue;
      const pts = this.dimPoints(d);
      if (!pts) continue;
      const key = `ord0:${d.e[0]}:${d.t}:${Math.round(d.t === "hdistance" ? d.pos[1] : d.pos[0])}`;
      if (seen.has(key)) continue;
      const el = mk(key, "sk-dim ord0");
      el.textContent = "0";
      el.title = t("Base of the ordinate dimensions");
      el.dataset.pos = JSON.stringify(d.t === "hdistance" ? [pts[0][0], d.pos[1]] : [d.pos[0], pts[0][1]]);
    }
    // Relation glyphs next to the first entity of each relation (points: beside the point).
    const per = new Map<string, number>();
    for (const r of this.sk.rels) {
      if (r.t === "coincident" || r.t === "onCurve" || this.lockedInsert(r.id)) continue;
      // Hidden glyphs (FR-SK-053) still show while selected, so a relation picked in the list can be seen.
      if (!this.showRels && !this.selection.has(r.id)) continue;
      const el = mk(r.id, "sk-rel");
      el.textContent = r.ext ? "⊡" : REL_GLYPH[r.t];
      const name = t(relName(r)) + (r.dangling ? ` · ${t("dangling: drag onto a model edge to re-attach")}` : "");
      el.title = name;
      el.setAttribute("aria-label", name);
      el.classList.toggle("sel", this.selection.has(r.id));
      el.classList.toggle("dangling", !!r.dangling);
      const anchor = r.e.find(x => x !== ORIGIN) ?? ORIGIN;
      const k = per.get(anchor) ?? 0;
      per.set(anchor, k + 1);
      el.dataset.pos = JSON.stringify(this.anchorOf(anchor));
      el.dataset.k = String(k);
      // Beside a curve, not on it: a click on the curve must not land on its glyph (exam bug 47).
      const side = this.glyphSide(anchor);
      if (side) { el.dataset.pos = JSON.stringify(side.p); el.dataset.nrm = JSON.stringify(side.n); } else delete el.dataset.nrm;
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); if (this.hoverRel === id) this.hoverRel = null; }
    this.syncGrip();
    this.syncArrowDot();
    this.placeLabels();
  }

  /**
   * Dragging a dimension value moves its text, stored with the dimension (FR-SK-066); dragging a dangling
   * On edge glyph onto a model edge re-attaches it (FR-SK-064).
   */
  private labelDown(id: string, el: HTMLElement, e: PointerEvent) {
    if (e.button !== 0 || this.tool !== "select" || this.input) return;
    const dim = this.sk.dims.find(d => d.id === id);
    const rel = this.sk.rels.find(r => r.id === id && r.ext && r.dangling);
    if (!dim && !rel) return;
    this.labelDrag = { id, x0: e.clientX, y0: e.clientY, moved: false, base: structuredClone(this.sk) };
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const move = (ev: PointerEvent) => {
      const d = this.labelDrag;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 4) return;
      d.moved = true;
      if (rel) { el.style.left = `${ev.clientX - this.host.layer.getBoundingClientRect().left}px`; el.style.top = `${ev.clientY - this.host.layer.getBoundingClientRect().top}px`; return; }
      const p = this.uv(ev);
      const dm = this.sk.dims.find(x => x.id === id);
      if (!p || !dm) return;
      // Ordinate values stay on their row's line; the row moves sideways.
      if (dm.ord && dm.pos) dm.pos = dm.t === "hdistance" ? [dm.pos[0], p[1]] : [p[0], dm.pos[1]];
      else dm.pos = p;
      this.render();
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const d = this.labelDrag;
      this.labelDrag = null;
      if (!d?.moved) return;
      el.dataset.dragged = "1";
      setTimeout(() => delete el.dataset.dragged, 0);
      if (rel) {
        this.reattaching = rel.id;
        const ok = this.reattachAt(ev);
        this.reattaching = null;
        if (!ok) this.render();
        return;
      }
      this.commit("Move dimension text");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /**
   * Instant 2D (FR-SK-067): where a driving dimension's handle sits and which way dragging it changes the
   * value (k = value change per unit of pointer travel: 2 for diameters).
   */
  private gripGeo(d: SkDim): { at: V2; dir: V2; k: number } | null {
    if (d.driven || d.ord || d.off || d.t === "angle" || d.t === "arclen" || d.val.expr) return null;
    const pos = d.pos ?? [0, 0];
    if (d.t === "radius" || d.t === "diameter") {
      const e = this.ent(d.e[0]);
      if (!e || (e.t !== "circle" && e.t !== "arc")) return null;
      const c = this.pt(e.c), r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]);
      const a = Math.atan2(pos[1] - c[1], pos[0] - c[0]), dir: V2 = [Math.cos(a), Math.sin(a)];
      return { at: [c[0] + dir[0] * r, c[1] + dir[1] * r], dir, k: d.t === "diameter" ? 2 : 1 };
    }
    const pts = this.dimPoints(d);
    if (!pts) return null;
    const [a, b] = pts;
    let dir: V2 = d.t === "hdistance" ? [1, 0] : d.t === "vdistance" ? [0, 1] : norm2(sub2(b, a));
    const along = dot2(sub2(b, a), dir);
    if (!(Math.abs(along) > 1e-9)) return null;
    if (along < 0) dir = [-dir[0], -dir[1]];
    const nrm: V2 = [-dir[1], dir[0]], off = dot2(sub2(pos, b), nrm);
    return { at: [b[0] + nrm[0] * off, b[1] + nrm[1] * off], dir, k: d.dia ? 2 : 1 };
  }

  /** Shows the handle on the one selected driving dimension while the Select tool is on. */
  private syncGrip() {
    const ids = [...this.selection];
    const d = this.gripDrag ? this.sk.dims.find(x => x.id === this.gripDrag!.id)
      : ids.length === 1 && this.tool === "select" && !this.input && !this.pattern ? this.sk.dims.find(x => x.id === ids[0]) : undefined;
    const g = d ? this.gripGeo(d) : null;
    if (!d || !g) { this.grip?.remove(); this.grip = null; return; }
    if (!this.grip) {
      const b = this.grip = document.createElement("button");
      b.className = "sk-grip";
      b.title = t("Drag to change the value");
      b.setAttribute("aria-label", t("Drag to change the value"));
      b.addEventListener("pointerdown", e => { e.stopPropagation(); this.gripDown(e); });
      b.addEventListener("click", e => e.stopPropagation());
      this.host.layer.appendChild(b);
    }
    this.grip.dataset.id = d.id;
    this.grip.dataset.pos = JSON.stringify(g.at);
  }

  /** The arrow flip dot (FR-SK-068) on the one selected dimension while the Select tool is on. */
  private syncArrowDot() {
    const ids = [...this.selection];
    const d = !this.gripDrag && ids.length === 1 && this.tool === "select" && !this.input && !this.pattern ? this.sk.dims.find(x => x.id === ids[0]) : undefined;
    const at = d ? this.arrowDotAt(d) : null;
    if (!d || !at) { this.adot?.remove(); this.adot = null; return; }
    if (!this.adot) {
      const b = this.adot = document.createElement("button");
      b.className = "sk-adot";
      b.title = t("Flip arrows");
      b.setAttribute("aria-label", t("Flip arrows"));
      b.addEventListener("pointerdown", e => e.stopPropagation());
      b.addEventListener("click", e => { e.stopPropagation(); if (b.dataset.id) this.flipArrows(b.dataset.id); });
      this.host.layer.appendChild(b);
    }
    this.adot.dataset.id = d.id;
    this.adot.dataset.pos = JSON.stringify(at);
  }

  private gripDown(e: PointerEvent) {
    const b = this.grip, id = b?.dataset.id;
    const d = id ? this.sk.dims.find(x => x.id === id) : undefined;
    const g = d ? this.gripGeo(d) : null;
    const p0 = this.uv(e);
    if (e.button !== 0 || !b || !d || !g || !p0) return;
    this.closeInput(false);
    const u = this.host.unit();
    // Snap step to suit the zoom, in the display unit (Shift while dragging: ten times finer).
    const stepU = 10 ** Math.floor(Math.log10(Math.max((this.px(g.at) * 6) / u.mm, 1e-9)));
    this.gripDrag = { id: d.id, base: structuredClone(this.sk), baseInfo: this.info, v0: d.val.v, p0: g.at, dir: g.dir, k: g.k,
      from: [g.at[0] - (g.dir[0] * d.val.v) / g.k, g.at[1] - (g.dir[1] * d.val.v) / g.k], step: stepU * u.mm, moved: false };
    const start = p0;
    try { b.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const move = (ev: PointerEvent) => {
      const gd = this.gripDrag, p = this.uv(ev);
      if (!gd || !p) return;
      const step = ev.shiftKey ? gd.step / 10 : gd.step;
      let v = Math.round((gd.v0 + dot2(sub2(p, start), gd.dir) * gd.k) / step) * step;
      if (!(v > 1e-9)) v = step;
      const cur = this.sk.dims.find(x => x.id === gd.id);
      if (!cur || Math.abs(v - cur.val.v) < 1e-12) return;
      const next: SketchFeature = structuredClone(gd.base);
      const nd = next.dims.find(x => x.id === gd.id)!;
      nd.val = { v };
      const r = solve(next);
      // Values the other relations cannot reach are skipped: the sketch stays at the last one that solved.
      if (r.status !== "ok") return;
      gd.moved = true;
      this.sk = next;
      this.info = r;
      this.render();
    };
    const up = () => {
      b.removeEventListener("pointermove", move);
      b.removeEventListener("pointerup", up);
      b.removeEventListener("pointercancel", up);
      this.endGrip(true);
    };
    b.addEventListener("pointermove", move);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    this.render();
  }

  /** Ends a handle drag: one undo step when the value changed, or back to where it started. */
  private endGrip(keep: boolean) {
    const gd = this.gripDrag;
    if (!gd) return;
    this.gripDrag = null;
    const now = this.sk.dims.find(x => x.id === gd.id)?.val.v;
    if (keep && gd.moved && now !== undefined && Math.abs(now - gd.v0) > 1e-12) this.commit("Change dimension");
    else { this.sk = gd.base; this.info = gd.baseInfo; }
    this.render();
  }

  private anchorOf(id: string): V2 {
    const e = this.ent(id);
    if (!e) return [0, 0];
    if (e.t === "point") return [e.x, e.y];
    if (e.t === "line") { const a = this.pt(e.a), b = this.pt(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    if (e.t === "circle") { const c = this.pt(e.c); return [c[0] + e.r * 0.7071, c[1] + e.r * 0.7071]; }
    if (e.t === "ellipse") return ellPt(this.ell(e), Math.PI / 4);
    if (e.t === "spline") { const l = this.splineLine(e); return l[Math.floor(l.length / 2)]; }
    if (e.t === "text") { const b = textBox(e, this.pt(e.p), textPath(this.sk.ents, e)); return b[b.length >> 1]; }
    return this.pt(e.a);
  }

  /** A point on a line, arc or circle and the outward normal there, for placing relation glyphs beside it. */
  private glyphSide(id: string): { p: V2; n: V2 } | null {
    const e = this.ent(id);
    if (!e) return null;
    if (e.t === "line") {
      const a = this.pt(e.a), b = this.pt(e.b), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-12) return null;
      return { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], n: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] };
    }
    if (e.t === "circle" || e.t === "arc") {
      const c = this.pt(e.c);
      let ang = Math.PI / 4, r = e.t === "circle" ? e.r : 0;
      if (e.t === "arc") {
        const a = this.pt(e.a), b = this.pt(e.b);
        r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        let sw = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
        while (sw <= 0) sw += 2 * Math.PI;
        ang = a0 + sw / 2;
      }
      const n: V2 = [Math.cos(ang), Math.sin(ang)];
      return { p: [c[0] + n[0] * r, c[1] + n[1] * r], n };
    }
    return null;
  }

  /** Where a dimension's value is drawn: ordinate values follow their point along the row. */
  private labelPos(d: SkDim): V2 {
    const pos = d.pos ?? [0, 0];
    if (!d.ord) return pos;
    const q = this.dimPoints(d)?.[1];
    if (!q) return pos;
    return d.t === "hdistance" ? [q[0], pos[1]] : [pos[0], q[1]];
  }

  private placeLabels() {
    if (this.disposed) return;
    this.syncGrid();
    for (const g of [this.grip, this.adot]) if (g) { const [x, y] = this.screen(JSON.parse(g.dataset.pos ?? "[0,0]") as V2); g.style.left = `${x}px`; g.style.top = `${y}px`; }
    for (const el of this.labels.values()) {
      const p = JSON.parse(el.dataset.pos ?? "[0,0]") as V2;
      const [x, y] = this.screen(p);
      const k = Number(el.dataset.k ?? 0);
      if (el.dataset.nrm) {
        // 14 px out along the curve's normal, more glyphs on the same curve side by side along it.
        const n = JSON.parse(el.dataset.nrm) as V2, q = this.screen([p[0] + n[0] * this.px(p), p[1] + n[1] * this.px(p)]);
        let sx = q[0] - x, sy = q[1] - y;
        const l = Math.hypot(sx, sy) || 1;
        sx /= l; sy /= l;
        const cx = x + sx * 14 + -sy * k * 18, cy = y + sy * 14 + sx * k * 18;
        el.style.left = `${cx - 8}px`;
        el.style.top = `${cy - 8}px`;
        continue;
      }
      el.style.left = `${x + (el.classList.contains("sk-rel") ? 10 + k * 16 : 0)}px`;
      el.style.top = `${y + (el.classList.contains("sk-rel") ? 10 : 0)}px`;
    }
  }
}

// ---------- offset helpers ----------

type OffsetSeg = { g: Curve; at: (x: V2) => V2; sg: { id: string; rev: boolean }; s: V2; e: V2 };
/** One offset curve made: source and copy, and their end points in chain order. */
type OffsetMade = { src: string; dst: string; srcStart: string; dstStart: string; srcEnd: string; dstEnd: string };
type OffsetBuild = { closed: boolean; offs: OffsetSeg[]; starts: V2[]; ends: V2[]; preview: V2[][]; apply: () => OffsetMade[]; made?: OffsetMade[] };

// ---------- 2D helpers ----------

const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const norm2 = (a: V2): V2 => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

function segDist(p: V2, a: V2, b: V2) {
  const u = sub2(b, a), l2 = dot2(u, u) || 1e-18;
  const tt = Math.max(0, Math.min(1, dot2(sub2(p, a), u) / l2));
  return Math.hypot(p[0] - a[0] - u[0] * tt, p[1] - a[1] - u[1] * tt);
}

function arcDist(p: V2, c: V2, a: V2, b: V2) {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  while (a1 <= a0) a1 += Math.PI * 2;
  let ap = Math.atan2(p[1] - c[1], p[0] - c[0]);
  while (ap < a0) ap += Math.PI * 2;
  if (ap <= a1) return Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - r);
  return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1]));
}

function intersect(a: V2, b: V2, c: V2, d: V2): V2 | null {
  const u = sub2(b, a), v = sub2(d, c);
  const den = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(den) < 1e-12) return null;
  const tt = ((c[0] - a[0]) * v[1] - (c[1] - a[1]) * v[0]) / den;
  return [a[0] + u[0] * tt, a[1] + u[1] * tt];
}

export function trimNum(v: number, places: number) {
  const s = v.toFixed(places);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function circumcentre(a: V2, b: V2, c: V2): V2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12 * (1 + Math.abs(a[0]) + Math.abs(b[0]) + Math.abs(c[0])) ** 2) return null;
  const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, C = c[0] ** 2 + c[1] ** 2;
  return [(A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d, (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d];
}

type Curve =
  | { kind: "line"; a: V2; b: V2 }
  | { kind: "circle"; c: V2; r: number }
  | { kind: "arc"; c: V2; r: number; a0: number; sweep: number };

function curveOf(e: SkEnt, pt: (id: string) => V2): Curve | null {
  if (e.t === "line") return { kind: "line", a: pt(e.a), b: pt(e.b) };
  if (e.t === "circle") return { kind: "circle", c: pt(e.c), r: e.r };
  if (e.t === "arc") {
    const c = pt(e.c), a = pt(e.a), b = pt(e.b);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    return { kind: "arc", c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), a0, sweep };
  }
  return null;
}

/** Position along a curve: 0..1 on a line, the angle from the start on a circle (from +x) or arc. */
function paramOf(g: Curve, p: V2): number {
  if (g.kind === "line") { const u = sub2(g.b, g.a); return dot2(sub2(p, g.a), u) / (dot2(u, u) || 1); }
  let a = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - (g.kind === "arc" ? g.a0 : 0);
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a;
}

/** Whether p (on the carrier) lies within the curve's ends; `tol` is a distance (mm) past an end that still counts. */
function onCurve(g: Curve, p: V2, tol = 1e-7): boolean {
  if (g.kind === "line") { const u = paramOf(g, p), k = tol / (Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1); return u >= -k && u <= 1 + k; }
  if (g.kind === "circle") return true;
  const u = paramOf(g, p), k = tol / (g.r || 1);
  return u <= g.sweep + k || u >= Math.PI * 2 - k;
}

/** Points where two curves' carriers (infinite line, full circle) meet; carriers within `tol` (mm) of touching meet once. */
function intersectCurves(g: Curve, h: Curve, tol = 0): V2[] {
  if (g.kind === "line" && h.kind === "line") { const p = intersect(g.a, g.b, h.a, h.b); return p ? [p] : []; }
  if (g.kind === "line") return lineCircle(g.a, g.b, (h as { c: V2 }).c, (h as { r: number }).r, tol);
  if (h.kind === "line") return lineCircle(h.a, h.b, g.c, g.r, tol);
  return circleCircle(g.c, g.r, h.c, h.r, tol);
}

function lineCircle(a: V2, b: V2, c: V2, r: number, tol = 0): V2[] {
  const d = sub2(b, a), f = sub2(a, c);
  const A = dot2(d, d), B = 2 * dot2(f, d), C = dot2(f, f) - r * r;
  if (A < 1e-18) return [];
  // A tangent line (to the solver's tolerance): one touch point at the foot of the perpendicular from the centre.
  const t0 = -B / (2 * A), foot: V2 = [a[0] + d[0] * t0, a[1] + d[1] * t0];
  const dist = Math.hypot(foot[0] - c[0], foot[1] - c[1]);
  if (tol > 0 && Math.abs(dist - r) < tol) return [foot];
  const disc = B * B - 4 * A * C;
  if (disc < -1e-12 * A * r * r) return [];
  const s = Math.sqrt(Math.max(0, disc));
  const ts = s < 1e-12 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.map(t => [a[0] + d[0] * t, a[1] + d[1] * t] as V2);
}

function circleCircle(c1: V2, r1: number, c2: V2, r2: number, tol = 0): V2[] {
  const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  const slack = Math.max(1e-9, tol);
  if (d < 1e-12 || d > r1 + r2 + slack || d < Math.abs(r1 - r2) - slack) return [];
  // Touching (to the tolerance): one point on the line of centres.
  if (tol > 0 && (Math.abs(d - r1 - r2) < tol || Math.abs(d - Math.abs(r1 - r2)) < tol)) {
    const s = Math.abs(d - r1 - r2) < tol ? r1 : (r1 >= r2 ? r1 : -r1);
    return [[c1[0] + ((c2[0] - c1[0]) * s) / d, c1[1] + ((c2[1] - c1[1]) * s) / d]];
  }
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m: V2 = [c1[0] + ((c2[0] - c1[0]) * a) / d, c1[1] + ((c2[1] - c1[1]) * a) / d];
  if (h < 1e-12) return [m];
  const ox = (-(c2[1] - c1[1]) * h) / d, oy = ((c2[0] - c1[0]) * h) / d;
  return [[m[0] + ox, m[1] + oy], [m[0] - ox, m[1] - oy]];
}

function cross2(a: V2, b: V2) { return a[0] * b[1] - a[1] * b[0]; }

/** Signed distance of p from the line through a and b (left positive). */
function lineSide(a: V2, b: V2, p: V2) { const u = norm2(sub2(b, a)); return cross2(u, sub2(p, a)); }

/** Slot centres from the first two clicks: both centres, or the middle and one end (centrepoint slot). */
function slotCentres(a: V2, b: V2, centred: boolean): [V2, V2] {
  return centred ? [[2 * a[0] - b[0], 2 * a[1] - b[1]], b] : [a, b];
}

/** Outline of a straight slot round the centres c1, c2 with half-width w, as polylines. */
function slotOutline(c1: V2, c2: V2, w: number): V2[][] {
  const len = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  if (len < 1e-9) return [];
  const u = norm2(sub2(c2, c1)), n: V2 = [-u[1], u[0]], a = Math.atan2(n[1], n[0]);
  const P = (c: V2, k: number): V2 => [c[0] + n[0] * w * k, c[1] + n[1] * w * k];
  const arc = (c: V2, a0: number) => Array.from({ length: 25 }, (_, i) => [c[0] + w * Math.cos(a0 + (Math.PI * i) / 24), c[1] + w * Math.sin(a0 + (Math.PI * i) / 24)] as V2);
  return [[P(c1, 1), P(c2, 1)], [P(c1, -1), P(c2, -1)], arc(c2, a - Math.PI), arc(c1, a), [c1, c2]];
}
