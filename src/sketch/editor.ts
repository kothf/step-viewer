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
import type { EdgeRef, Frame, RelKind, SkDim, SkEnt, SketchFeature, SkRel, V2 } from "../model/types";
import { applyExt, projectEdge, uvOf, type ExtGeo, type ModelEdge } from "./external";
import { renameIn } from "../model/params";
import { ORIGIN, freeDirections, measureDim, solve, tryAdd, type SolveResult } from "./solver";
import { uid } from "../model/doc";
import { cutTriangles, thin } from "./intersect";
import { evaluate, ExprError, isPlain, type VarValue } from "../model/expr";
import type { DxfShape } from "./dxf";
import { t } from "../i18n";
import { bezPts, nearestOn, splineBezier } from "./spline";
import { ellDist, earcDist, ellLocal, ellOf, ellParam, ellPt, ellPts, ellSweep, type Ell } from "./ellipse";

/** Points an entity refers to (its ends, centre, axis points). */
export function refPts(e: SkEnt): string[] {
  if (e.t === "point") return [];
  if (e.t === "line") return [e.a, e.b];
  if (e.t === "circle") return [e.c];
  if (e.t === "arc") return [e.c, e.a, e.b];
  if (e.t === "spline") return e.pts.slice();
  return [e.c, e.a, e.b, ...(e.p0 ? [e.p0] : []), ...(e.p1 ? [e.p1] : [])];
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
  | { kind: "scale"; c: V2; centre: string | null; k: number; copy: boolean; keep: boolean };

export type SkTool = "select" | "line" | "rect" | "crect" | "circle" | "circle3" | "arc" | "arc3" | "polygon" | "slot" | "ellipse" | "earc" | "spline" | "point" | "trim" | "extend" | "split" | "fillet" | "chamfer" | "offset" | "convert" | "intersect" | "dim" | "hord" | "vord";

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
const HV_TOL = (3 * Math.PI) / 180;

type Hit = { id: string; kind: "point" | "line" | "circle" | "arc" | "ellipse" | "spline" | "origin" | "dim" | "rel"; d: number };

/** Under-defined analysis arrows (FR-SLV-010). */
const FREE_ARROW = 0xf08c00;
const COLORS = {
  light: { free: 0x1d4ed8, defined: 0x111827, cons: 0x7c8594, sel: 0xf08c00, hover: 0xf59f00, bad: 0xd32f2f, dim: 0x334155, pre: 0x2f9e44 },
  dark: { free: 0x6ea8ff, defined: 0xe8ecf2, cons: 0x8a94a6, sel: 0xffa94d, hover: 0xffc078, bad: 0xff6b5e, dim: 0xcbd5e1, pre: 0x51cf66 },
};
/** Curves whose model edge is gone (FR-SK-064): olive brown, as dangling items in SolidWorks. */
const DANGLING = { light: 0x8f6a00, dark: 0xd8b13a };

const REL_GLYPH: Record<RelKind, string> = {
  coincident: "◉", horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "⫽", equal: "=",
  tangent: "T", concentric: "◎", midpoint: "M", fix: "⚓", onCurve: "◦", symmetric: "⇹", intersection: "✕",
};
export const REL_NAME: Record<RelKind, string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular",
  collinear: "Collinear", equal: "Equal", tangent: "Tangent", concentric: "Concentric", midpoint: "Midpoint", fix: "Fix",
  onCurve: "On curve", symmetric: "Symmetric", intersection: "Intersection",
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
  filletRadius = 2;
  /** Sketch chamfer distance and offset distance (mm), set in the panel. */
  chamferDist = 2;
  offsetDist = 5;
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
  /** Model snapping while drawing (SolidWorks inferencing to model geometry); off with the panel switch. */
  modelSnap = true;
  private draft: { pts: V2[]; ids: (string | null)[]; cursor: V2 | null; snap: string | null; chainStart?: string; snapCurve?: string | null; snapOrigin?: boolean } = { pts: [], ids: [], cursor: null, snap: null };
  private dimDraft: { picks: Hit[]; dim: SkDim | null } = { picks: [], dim: null };
  /** Ordinate dimensioning: the base picked first, then the row the values go on. */
  private ordDraft: { base: string | null; row: number | null } = { base: null, row: null };
  /** Box selection in progress (sketch coordinates), started at screen x0. */
  private box: { a: V2; b: V2; x0: number; base: Set<string> } | null = null;
  private drag: { ids: string[]; start: V2; orig: Map<string, V2>; circle?: string; moved: boolean; base: SketchFeature } | null = null;
  private labels = new Map<string, HTMLElement>();
  /** A dimension value or dangling relation glyph being dragged (FR-SK-066, FR-SK-064). */
  private labelDrag: { id: string; x0: number; y0: number; moved: boolean; base: SketchFeature } | null = null;
  /** Re-attach: the dangling On edge relation the next model edge click attaches (FR-SK-064). */
  reattaching: string | null = null;
  /** Show dimension names with their values (FR-SK-065). */
  showNames = false;
  private input: HTMLInputElement | null = null;
  private marker: THREE.Mesh;
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
    this.clearGroup();
    for (const l of this.labels.values()) l.remove();
    this.labels.clear();
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
    this.tool = tool;
    this.draft = { pts: [], ids: [], cursor: null, snap: null };
    this.dimDraft = { picks: [], dim: null };
    this.ordDraft = { base: null, row: null };
    if (tool !== "select" && tool !== "dim") this.selection.clear();
    this.render();
    this.statusHint();
  }

  /** Something is in progress (drag, drawing, value box): the stored sketch must not replace it now. */
  get busy() { return !!(this.drag || this.labelDrag || this.box || this.input || this.draft.pts.length || this.dimDraft.picks.length); }

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
    return bezPts(splineBezier(e.pts.map(q => mv(this.pt(q))), !!e.closed && e.pts.length >= 3), 16);
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
    if (this.tool === "select") {
      const h = this.hits(p)[0] ?? null;
      if (!h || h.kind === "origin") {
        if (!e.ctrlKey && !e.shiftKey) this.selection.clear();
        // Box selection from empty space (FR-SEL-002): left to right takes what is fully inside, right to left what it crosses.
        this.box = { a: p, b: p, x0: e.clientX, base: new Set(this.selection) };
        try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* synthetic event */ }
        this.render();
        this.emitSel();
        return true;
      }
      if (e.ctrlKey || e.shiftKey || e.metaKey) { if (this.selection.has(h.id)) this.selection.delete(h.id); else this.selection.add(h.id); }
      else if (!this.selection.has(h.id)) { this.selection.clear(); this.selection.add(h.id); }
      this.emitSel();
      // Start a drag of what is under the cursor.
      const ent = this.ent(h.id)!;
      const ids = ent.t === "point" ? [ent.id] : ent.t === "circle" ? [] : refPts(ent);
      const orig = new Map(ids.map(id => [id, this.pt(id)] as const));
      this.drag = { ids, start: p, orig, circle: ent.t === "circle" ? ent.id : undefined, moved: false, base: structuredClone(this.sk) };
      this.render();
      return true;
    }
    if (this.tool === "dim") { this.dimClick(p, e); return true; }
    if (this.tool === "hord" || this.tool === "vord") { this.ordClick(p); return true; }
    if (this.tool === "trim") { this.trimAt(p); return true; }
    if (this.tool === "fillet") { this.filletAt(p); return true; }
    if (this.tool === "chamfer") { this.chamferAt(p); return true; }
    if (this.tool === "extend") { this.extendAt(p); return true; }
    if (this.tool === "split") { this.splitAt(p); return true; }
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
    if (this.box) {
      this.box.b = p;
      this.boxSelect(e.clientX < this.box.x0);
      this.render();
      return true;
    }
    if (this.drag) {
      const d = this.drag;
      d.moved = true;
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      this.sk = structuredClone(d.base);
      const r = d.circle ? solve(this.sk, { circle: d.circle, to: p })
        : solve(this.sk, { points: d.ids.map(id => ({ id, to: [d.orig.get(id)![0] + dx, d.orig.get(id)![1] + dy] as V2 })) });
      this.info = r;
      this.render();
      return true;
    }
    if (this.tool === "dim" && this.dimDraft.dim) { this.placeDimDraft(p); this.render(); return true; }
    const pick = ["trim", "extend", "split", "offset"].includes(this.tool);
    const snap = this.snapPoint(p, !pick && !["select", "fillet", "chamfer", "convert", "intersect"].includes(this.tool));
    this.hover = this.tool === "select" || this.tool === "dim" || pick ? this.hits(p, { points: !pick })[0] ?? null
      : this.tool === "fillet" || this.tool === "chamfer" ? this.hits(p, { curves: false }).find(h => h.kind === "point") ?? null : null;
    this.offsetPreview = this.tool === "offset" ? this.offsetAt(p, false) : [];
    this.draft.cursor = snap.p;
    this.draft.snap = snap.id;
    this.render();
    return true;
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
      if (d.moved) this.commit("Drag sketch geometry");
      return true;
    }
    return true;
  }

  doubleClick(): boolean {
    if (this.tool === "line" && this.draft.pts.length) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; this.render(); return true; }
    if (this.tool === "select") {
      // Double-click a dimension label edits it; on geometry: nothing yet.
      return false;
    }
    return false;
  }

  // ---------- snapping ----------

  /** Snaps a cursor point to points, the origin, curves and horizontal/vertical from the last point. */
  private snapPoint(p: V2, active: boolean, materialize = false): { p: V2; id: string | null; curve: string | null; hv: "horizontal" | "vertical" | null } {
    this.marker.visible = false;
    if (!active) return { p, id: null, curve: null, hv: null };
    const exclude = new Set<string>();
    const h = this.hits(p, { curves: false, exclude });
    if (h.length) { const q = this.pt(h[0].id); this.showMarker(q); return { p: q, id: h[0].id, curve: null, hv: null }; }
    // Model vertices, edge midpoints and circle centres (projected onto the sketch) come next.
    const ms = this.modelSnapAt(p, true);
    if (ms) {
      this.showMarker(ms.p);
      if (!materialize) return { p: ms.p, id: null, curve: null, hv: null };
      const r = this.materialize(ms);
      return { p: ms.p, id: r.id, curve: r.curve, hv: null };
    }
    let q = p;
    let hv: "horizontal" | "vertical" | null = null;
    const last = this.draft.pts.at(-1);
    if (last && (this.tool === "line")) {
      const a = Math.atan2(p[1] - last[1], p[0] - last[0]);
      if (Math.abs(Math.sin(a)) < Math.sin(HV_TOL)) { q = [p[0], last[1]]; hv = "horizontal"; }
      else if (Math.abs(Math.cos(a)) < Math.sin(HV_TOL)) { q = [last[0], p[1]]; hv = "vertical"; }
    }
    const c = this.hits(q, { points: false })[0];
    if (c && !hv) { const proj = this.project(q, c.id); this.showMarker(proj); return { p: proj, id: null, curve: c.id, hv: null }; }
    return { p: q, id: null, curve: null, hv };
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
    const same = (r: EdgeRef) => !!ref && [...r.faces].sort().join("|") === [...ref.faces].sort().join("|")
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
    const s = exact ? { p: raw, id: onPt, curve: null, hv: exact.hv } : this.snapPoint(raw, true, true);
    const p = s.p;
    const d = this.draft;
    const rels: SkRel[] = [];
    const before = exact ? new Set(this.sk.ents.map(x => x.id)) : null;
    const finish = (label: string) => {
      this.sk.rels.push(...rels);
      if (exact && before) { const made = this.sk.ents.filter(x => !before.has(x.id)); this.addTypedDims(exact.dims(made), made); }
      this.commit(label);
    };
    if (this.tool === "point") { this.usePoint(p, s.id, s.curve, rels); finish("Add point"); return; }
    if (this.tool === "line") {
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id && s.id !== ORIGIN ? s.id : null]; d.chainStart = s.id ?? undefined; d.snapCurve = s.curve; d.snapOrigin = s.id === ORIGIN; this.render(); return; }
      const a0 = d.pts.at(-1)!;
      if (!exact && Math.hypot(p[0] - a0[0], p[1] - a0[1]) < this.px(p) * 2) return;
      const aId = d.ids.at(-1) ?? this.usePoint(a0, d.snapOrigin ? ORIGIN : null, d.snapCurve ?? null, rels);
      const bId = this.usePoint(p, s.id, s.curve, rels);
      const lid = uid("l");
      this.sk.ents.push({ id: lid, t: "line", a: aId, b: bId });
      if (s.hv) rels.push({ id: uid("r"), t: s.hv, e: [lid] });
      finish("Add line");
      // Chain on from the end, unless the loop closed on an existing point.
      const closed = !!s.id && (s.id !== ORIGIN || d.chainStart === ORIGIN) && d.ids.length > 0;
      if (closed || e.detail >= 2) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; }
      else { d.pts.push(p); d.ids.push(bId); d.snapCurve = null; d.snapOrigin = false; }
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
    if (this.tool === "spline") {
      // Through the clicked points (FR-SK-019): a double-click ends it, the first point again closes it.
      const near = (q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < this.px(p) * 3;
      const closing = d.pts.length >= 3 && (near(d.pts[0]) || (!!s.id && s.id === d.ids[0]));
      const again = d.pts.length > 0 && near(d.pts.at(-1)!);
      if (!closing && !again) { d.pts.push(p); d.ids.push(s.id); if (d.pts.length === 1) d.snapCurve = s.curve; }
      if (!closing && !(e.detail >= 2 || again)) { this.render(); return; }
      if (d.pts.length < 2) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; this.render(); return; }
      const ids = d.pts.map((q, i) => this.usePoint(q, d.ids[i] ?? null, i === 0 ? d.snapCurve ?? null : null, rels));
      this.sk.ents.push({ id: uid("s"), t: "spline", pts: ids, ...(closing ? { closed: true } : {}) });
      finish("Add spline");
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
    if (this.tool === "slot") {
      if (d.pts.length < 2) {
        if (d.pts.length && Math.hypot(p[0] - d.pts[0][0], p[1] - d.pts[0][1]) < this.px(p) * 3) return;
        d.pts.push(p); d.ids.push(s.id); this.render(); return;
      }
      const [c1, c2] = d.pts;
      const w = Math.abs(lineSide(c1, c2, p));
      if (w < this.px(p) * 2) return;
      this.addSlot(c1, c2, w, d.ids[0], d.ids[1], rels);
      finish("Add slot");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
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
      if (d.pts.length < 2) { d.pts.push(p); d.ids.push(s.id); this.render(); return; }
      const [c, a] = d.pts;
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const ang = Math.atan2(p[1] - c[1], p[0] - c[0]);
      const b: V2 = s.id ? p : [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
      const cId = this.usePoint(c, d.ids[0], null, rels), aId = this.usePoint(a, d.ids[1], null, rels), bId = this.usePoint(b, s.id, null, rels);
      this.sk.ents.push({ id: uid("a"), t: "arc", c: cId, a: aId, b: bId });
      finish("Add arc");
      this.draft = { pts: [], ids: [], cursor: null, snap: null };
      this.render();
    }
  }

  // ---------- dimensions ----------

  private dimClick(p: V2, e: PointerEvent) {
    const dd = this.dimDraft;
    // With one item picked, a click on another item (in the sketch or on the model) dimensions the pair.
    const other = dd.dim && dd.picks.length === 1 ? this.hits(p).find(x => x.id !== dd.picks[0].id) ?? (this.hits(p).length ? undefined : this.modelSnapAt(p, false)) : undefined;
    if (other) dd.dim = null;
    if (dd.dim) {
      // Otherwise the next click places the dimension and asks for its value.
      this.placeDimDraft(p);
      const dim = dd.dim;
      this.dimDraft = { picks: [], dim: null };
      this.addDimension(dim);
      return;
    }
    let h = this.hits(p)[0];
    if (!h) {
      // A model vertex or edge: converted as construction geometry with an On edge relation, then dimensioned.
      const ms = this.modelSnapAt(p, false);
      if (ms) {
        const r = this.materialize(ms);
        const id = r.id ?? r.curve;
        const ent = id ? this.ent(id) : undefined;
        if (ent && ent.t !== "ellipse" && ent.t !== "spline") h = { id: ent.id, kind: ent.t, d: 0 };
      }
    }
    if (!h) { this.selection.clear(); dd.picks = []; this.render(); return; }
    if (!dd.picks.some(x => x.id === h!.id)) dd.picks.push(h);
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
      else dim = mk("distance", ids);
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

  private nextDimName() {
    const used = new Set(this.sk.dims.map(d => d.name));
    let n = 1;
    while (used.has(`D${n}`)) n++;
    return `D${n}`;
  }

  /** Adds a placed dimension: driving when it adds information, otherwise as a reference. */
  private addDimension(dim: SkDim) {
    dim.val.v = measureDim(this.sk, dim);
    const r = tryAdd(this.sk, { dim });
    if (!r.ok || r.redundant) {
      dim.driven = true;
      this.sk.dims.push(dim);
      this.commit("Add dimension");
      this.host.toast(t("The sketch is already defined there: added as a reference dimension."), "warn");
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

  /** Opens the value box on a dimension. */
  editDim(id: string) {
    const dim = this.sk.dims.find(d => d.id === id);
    if (!dim || dim.driven) return;
    const label = this.labels.get(id);
    if (!label) return;
    this.closeInput(false);
    const inp = document.createElement("input");
    inp.className = "sk-input";
    inp.setAttribute("aria-label", t("Dimension value"));
    const u = this.host.unit();
    inp.value = dim.val.expr ?? (dim.t === "angle" ? trimNum((dim.val.v * 180) / Math.PI, 4) : trimNum(dim.val.v / u.mm, 6));
    inp.style.left = label.style.left;
    inp.style.top = label.style.top;
    this.host.layer.appendChild(inp);
    this.input = inp;
    inp.dataset.dim = id;
    inp.focus();
    inp.select();
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.closeInput(true); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeInput(false); }
    });
    inp.addEventListener("blur", () => setTimeout(() => this.closeInput(true), 0));
  }

  private closeInput(apply: boolean) {
    const inp = this.input;
    if (!inp) return;
    this.input = null;
    inp.remove();
    if (!apply || this.disposed) return;
    const dim = this.sk.dims.find(d => d.id === inp.dataset.dim);
    if (!dim) return;
    let v: number;
    try { v = evaluate(inp.value, dim.t === "angle" ? "angle" : "length", dim.t === "angle" ? "deg" : this.host.unit().name, this.host.vars?.() ?? {}); }
    catch (err) { this.host.toast(t((err as ExprError).key ?? String(err), (err as ExprError).params), "error"); return; }
    if (dim.t !== "angle" && !(v > 0)) { this.host.toast(t("The value must be more than 0."), "error"); return; }
    if (Math.abs(v - dim.val.v) < 1e-12 && (dim.val.expr ?? "") === (isPlain(inp.value) ? "" : inp.value)) return;
    const next: SketchFeature = structuredClone(this.sk);
    const nd = next.dims.find(d => d.id === dim.id)!;
    nd.val = isPlain(inp.value) ? { v } : { v, expr: inp.value.trim() };
    const r = solve(next);
    if (r.status !== "ok") {
      this.host.toast(t("That value cannot be reached with the other relations and dimensions."), "error");
      return;
    }
    this.sk = next;
    this.info = r;
    this.commit("Change dimension");
    this.render();
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
    if (total >= 1 && !this.selection.has(ORIGIN)) out.push("fix");
    return [...new Set(out)];
  }

  addRelation(kind: RelKind) {
    if (!this.validRelations().includes(kind)) return;
    let e = [...this.selection];
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

  deleteSelection() {
    if (!this.selection.size) return false;
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
    for (const o of this.sk.ents) {
      if (o.id === id || o.t === "point") continue;
      const og = geo(o);
      if (!og) continue;
      for (const q of intersectCurves(me, og)) {
        if (!onCurve(og, q) || !onCurve(me, q)) continue;
        // An existing point there (a shared end): reuse it.
        const pt = this.sk.ents.find(x => x.t === "point" && Math.hypot(x.x - q[0], x.y - q[1]) < 1e-7)?.id;
        out.push({ u: paramOf(me, q), p: q, other: o.id, pt });
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
   * corner to the line's other end, so the sizes keep meaning the sharp corner (SolidWorks' virtual sharp).
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
    // Construction lines at the corner (a centre rectangle's diagonals) stay on the sharp corner, as in SolidWorks.
    const lines = this.sk.ents.filter(e => e.t === "line" && !e.cons && (e.a === V || e.b === V)) as (SkEnt & { t: "line" })[];
    const curves = this.sk.ents.filter(e => !("cons" in e && e.cons) && ((e.t === "arc" && (e.a === V || e.b === V)) || (e.t === "line" && (e.a === V || e.b === V))));
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

  /** Selects what the box holds: fully inside, or (crossing) anything it touches, added to what was selected before. */
  private boxSelect(crossing: boolean) {
    const b = this.box!;
    const x0 = Math.min(b.a[0], b.b[0]), x1 = Math.max(b.a[0], b.b[0]), y0 = Math.min(b.a[1], b.b[1]), y1 = Math.max(b.a[1], b.b[1]);
    const inside = (q: V2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
    const samples = (e: SkEnt): V2[] => {
      if (e.t === "point") return [[e.x, e.y]];
      if (e.t === "ellipse") return this.ellLine(e);
      if (e.t === "spline") return this.splineLine(e);
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
  private addSlot(c1: V2, c2: V2, w: number, id1: string | null, id2: string | null, rels: SkRel[]) {
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
   * Offsets the clicked circle, or the chain of lines and arcs through the clicked curve, by `offsetDist` to the cursor's side.
   * Corners are re-joined where the offset curves meet; arcs keep their centres (concentric). Static copy (P1).
   * With apply false it only returns the preview polylines.
   */
  private offsetAt(p: V2, apply: boolean): V2[][] {
    const h = this.hits(p, { points: false })[0];
    const e = h && this.ent(h.id);
    if (!e || (e.t !== "line" && e.t !== "arc" && e.t !== "circle")) {
      if (apply) this.host.toast(t("Click a line, arc or circle to offset."));
      return [];
    }
    const d = this.offsetDist;
    if (e.t === "circle") {
      const c = this.pt(e.c), r = e.r + (Math.hypot(p[0] - c[0], p[1] - c[1]) < e.r ? -d : d);
      if (!(r > 1e-9)) { if (apply) this.host.toast(t("The offset is larger than the radius."), "error"); return []; }
      if (!apply) return [Array.from({ length: 73 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 36), c[1] + r * Math.sin((i * Math.PI) / 36)] as V2)];
      this.sk.ents.push({ id: uid("c"), t: "circle", c: e.c, r });
      this.commit("Offset entities");
      this.render();
      return [];
    }
    const { segs, closed } = this.chainOf(e.id);
    // Side: +1 to the left of the clicked curve as the chain runs (it runs forward on the clicked curve).
    let side: number;
    if (e.t === "line") side = Math.sign(cross2(sub2(this.pt(e.b), this.pt(e.a)), sub2(p, this.pt(e.a)))) || 1;
    else { const c = this.pt(e.c); side = Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]) ? 1 : -1; }
    type Off = { g: Curve; at: (x: V2) => V2; sg: { id: string; rev: boolean }; s: V2; e: V2 };
    const offs: Off[] = [];
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
        if (!(r2 > 1e-9)) { if (apply) this.host.toast(t("The offset is larger than the radius."), "error"); return []; }
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
    if (!apply) {
      return offs.map((o, i) => {
        if (o.g.kind === "line") return [starts[i], ends[i]];
        const c = o.g.c, r = o.g.r;
        const a0 = Math.atan2(starts[i][1] - c[1], starts[i][0] - c[0]);
        let sw = Math.atan2(ends[i][1] - c[1], ends[i][0] - c[0]) - a0;
        if (o.sg.rev) { while (sw >= 0) sw -= Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; }
        return Array.from({ length: 49 }, (_, k) => [c[0] + r * Math.cos(a0 + (sw * k) / 48), c[1] + r * Math.sin(a0 + (sw * k) / 48)] as V2);
      });
    }
    const ptIds = starts.map(q => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: q[0], y: q[1] }); return id; });
    const endIds = closed ? ptIds.map((_, i) => ptIds[(i + 1) % n]) : [...ptIds.slice(1), (() => { const id = uid("p"); this.sk.ents.push({ id, t: "point", x: ends[n - 1][0], y: ends[n - 1][1] }); return id; })()];
    offs.forEach((o, i) => {
      const src = this.ent(o.sg.id) as SkEnt & { t: "line" | "arc" };
      if (src.t === "line") { const id = uid("l"); this.sk.ents.push({ id, t: "line", a: ptIds[i], b: endIds[i] }); this.sk.rels.push({ id: uid("r"), t: "parallel", e: [src.id, id] }); }
      else this.sk.ents.push({ id: uid("a"), t: "arc", c: src.c, a: o.sg.rev ? endIds[i] : ptIds[i], b: o.sg.rev ? ptIds[i] : endIds[i] });
    });
    this.commit("Offset entities");
    this.offsetPreview = [];
    this.render();
    return [];
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
    const A = this.pt(axis.a), B = this.pt(axis.b);
    const d: V2 = [B[0] - A[0], B[1] - A[1]];
    const L = Math.hypot(d[0], d[1]);
    if (!(L > 1e-9)) return false;
    const u: V2 = [d[0] / L, d[1] / L];
    const reflect = (q: V2): V2 => {
      const w: V2 = [q[0] - A[0], q[1] - A[1]];
      const k = w[0] * u[0] + w[1] * u[1];
      return [2 * (A[0] + u[0] * k) - q[0], 2 * (A[1] + u[1] * k) - q[1]];
    };
    const map = new Map<string, string>();
    const point = (id: string) => {
      if (id === axis.a || id === axis.b) return id;
      const got = map.get(id);
      if (got) return got;
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
      else if (e.t === "spline") { const id = uid("s"); this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
      else { const id = uid("a"); this.sk.ents.push({ id, t: "arc", c: point(e.c), a: point(e.b), b: point(e.a), ...(e.cons ? { cons: true } : {}) }); made.push(id); }
    }
    this.selection = new Set(made);
    this.commit("Mirror entities");
    this.render();
    this.emitSel();
    return true;
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
    if (!items.length) { this.host.toast(t("Select the entities to pattern first, then click the pattern tool.")); return false; }
    if (this.tool !== "select") this.setTool("select");
    const c: V2 = centre ? this.pt(centre) : [0, 0];
    this.pattern = kind === "linear" ? { kind, n: 3, d: 20, angle: 0, n2: 1, d2: 20, angle2: Math.PI / 2 }
      : kind === "circular" ? { kind, n: 6, total: Math.PI * 2, c, centre, equal: true }
      : kind === "move" ? { kind, dx: 10, dy: 0, copy: false, keep: true }
      : kind === "rotate" ? { kind, c, centre, angle: Math.PI / 2, copy: false, keep: true }
      : { kind, c, centre, k: 2, copy: false, keep: true };
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
    else { const c = p.c, k = p.k; out.push({ f: q => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k], k: Math.abs(k) }); }
    return out;
  }

  /** Preview polylines of the instances. */
  private patternPreview(): V2[][] {
    const { items } = this.patternSeed();
    const out: V2[][] = [];
    for (const { f: mv, k } of this.patternMoves()) {
      for (const e of items) {
        if (e.t === "point") { const q = mv(this.pt(e.id)), r = this.px(q) * 3; out.push(arcPts(q, r, 0, Math.PI * 2, 12)); }
        else if (e.t === "line") out.push([mv(this.pt(e.a)), mv(this.pt(e.b))]);
        else if (e.t === "circle") out.push(arcPts(mv(this.pt(e.c)), e.r * k, 0, Math.PI * 2, 72));
        else if (e.t === "ellipse") out.push(this.ellLine(e, mv));
        else if (e.t === "spline") out.push(this.splineLine(e, mv));
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
          this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...cons(e) });
          made.push(id);
        } else if (e.t === "ellipse") {
          const id = uid("e");
          this.sk.ents.push({ id, t: "ellipse", c: point(e.c), a: point(e.a), b: point(e.b), ...(e.p0 && e.p1 ? { p0: point(e.p0), p1: point(e.p1) } : {}), ...cons(e) });
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
        else if (e.t === "spline") { const id = uid("s"); this.sk.ents.push({ id, t: "spline", pts: e.pts.map(point), ...(e.closed ? { closed: true } : {}), ...cons }); made.push(id); }
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
    const g = projectEdge(ed[0], this.frame);
    const ref = this.host.edgeRef?.(ed[0]) ?? null;
    const next = structuredClone(this.sk);
    const ne = next.ents.find(x => x.id === ent?.id);
    if (!g || !ne || !ref || !applyExt(next, ne, g)) { this.host.toast(t("That edge is a different kind of curve: pick a {kind}.", { kind: t(ent?.t === "line" ? "straight edge" : ent?.t === "circle" ? "circular edge" : "arc edge") }), "warn"); return false; }
    const nr = next.rels.find(r => r.id === id)!;
    nr.ext = ref;
    delete nr.dangling;
    this.reattaching = null;
    this.sk = next;
    this.commit("Re-attach");
    this.setTool("select");
    this.host.onSelection?.([...this.selection]);
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
    if (this.tool === "line") return [{ name: "Length", q: "length", now: Math.hypot(dx, dy) }, { name: "Angle", q: "angle", now: (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI) }];
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
    const lineOf = (made: SkEnt[]) => made.filter((x): x is SkEnt & { t: "line" } => x.t === "line" && !x.cons);
    const dim = (t: SkDim["t"], e: string[], val: number): SkDim => ({ id: uid("d"), name: "", t, e, val: { v: val } });
    if (this.tool === "line") {
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
  private addTypedDims(dims: SkDim[], made: SkEnt[] = []) {
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
        }
      }
      const r = tryAdd(this.sk, { dim });
      if (!r.ok || r.redundant) continue;
      this.sk = r.sketch;
      this.info = r.result;
    }
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "escape") {
      if (this.pattern) { this.cancelPattern(); this.host.onSelection?.([...this.selection]); return true; }
      if (this.draft.pts.length || this.dimDraft.picks.length) { this.setTool(this.tool); return true; }
      if (this.tool !== "select") { this.setTool("select"); return true; }
      if (this.selection.size) { this.selection.clear(); this.render(); this.emitSel(); return true; }
      return false;
    }
    if (k === "delete" || k === "backspace") return this.deleteSelection();
    if (/^[0-9.]$/.test(e.key) && this.typedFields()) { this.openTyped(e.key); return true; }
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
      rect: "Click two opposite corners",
      crect: "Click the centre, then a corner",
      circle: "Click the centre, then a point on the circle",
      arc: "Click the centre, the start, then the end (counter-clockwise)",
      point: "Click to place a point",
      circle3: "Click three points on the circle",
      arc3: "Click the start, the end, then a point on the arc",
      polygon: "Click the centre, then a corner; set the sides in the panel",
      trim: "Click the piece of a curve to remove, up to where it crosses others",
      fillet: "Click a corner where two lines meet; set the radius in the panel",
      chamfer: "Click a corner where two lines meet; set the distance in the panel",
      extend: "Click a line or arc near the end to extend it to the next curve",
      split: "Click a line or arc where it should be split in two",
      offset: "Move to the side to offset to, then click the curve or chain; set the distance in the panel",
      convert: "Click model edges (or a face for all its edges) to copy them into the sketch",
      intersect: "Click model faces: the curves where the sketch plane cuts them are added",
      slot: "Click the two centres, then the width",
      spline: "Click points the spline passes through; double-click ends it, clicking the first point closes it",
      ellipse: "Click the centre, the end of the major axis, then a point on the ellipse",
      earc: "Click the centre, the end of the major axis, the start, then the end (counter-clockwise)",
      dim: "Click one or two items, then click where the dimension goes",
      hord: "Click the base point, then where the values go, then each point to dimension along X",
      vord: "Click the base point, then where the values go, then each point to dimension along Y",
    };
    this.host.status(`${def} · ${t(hints[this.tool])}`);
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
    const kind = (id: string) => (id === ORIGIN ? "point" : this.ent(id)?.t);
    const centreOf = (id: string): V2 => { const e = this.ent(id); return e && (e.t === "circle" || e.t === "arc") ? this.pt(e.c) : this.pt(id); };
    if (d.e.length === 1 && kind(d.e[0]) === "line") { const l = this.ent(d.e[0]) as SkEnt & { t: "line" }; return [this.pt(l.a), this.pt(l.b)]; }
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
    this.dark = document.documentElement.dataset.theme === "dark";
    const C = this.dark ? COLORS.dark : COLORS.light;
    this.clearGroup();
    const segs: number[] = [], cols: number[] = [];
    const dimSegs: number[] = [], dimCols: number[] = [];
    const lost = new Set(this.sk.rels.filter(r => r.ext && r.dangling).map(r => r.e[0]));
    const color = (id: string, cons?: boolean) => {
      if (this.selection.has(id)) return C.sel;
      if (this.hover?.id === id) return C.hover;
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
      else if (e.t === "spline") poly(this.splineLine(e), c);
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
    if (d.pts.length && d.cursor) {
      const p = d.cursor, a = d.pts[0];
      if (this.tool === "line") push(d.pts.at(-1)!, p, C.pre);
      else if (this.tool === "circle") poly(arcPts(a, Math.hypot(p[0] - a[0], p[1] - a[1]), 0, Math.PI * 2, 72), C.pre);
      else if (this.tool === "rect" || this.tool === "crect") {
        const [x0, y0] = this.tool === "rect" ? a : [2 * a[0] - p[0], 2 * a[1] - p[1]];
        poly([[x0, y0], [p[0], y0], [p[0], p[1]], [x0, p[1]], [x0, y0]], C.pre);
      } else if (this.tool === "polygon") {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]), a0 = Math.atan2(p[1] - a[1], p[0] - a[0]), n = this.polySides;
        poly(Array.from({ length: n + 1 }, (_, i) => [a[0] + r * Math.cos(a0 + (2 * Math.PI * i) / n), a[1] + r * Math.sin(a0 + (2 * Math.PI * i) / n)] as V2), C.pre);
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
          poly(arcPts(a, r, a0, a1), C.pre);
        }
      }
    }
    for (const pl of this.offsetPreview) poly(pl, C.pre);
    if (this.pattern) for (const pl of this.patternPreview()) poly(pl, C.pre);
    if (this.box) {
      const { a: p0, b: p1 } = this.box;
      poly([p0, [p1[0], p0[1]], p1, [p0[0], p1[1]], p0], C.sel, dimSegs, dimCols);
    }
    if (this.tool === "slot" && d.pts.length && d.cursor) {
      const [c1, c2] = d.pts.length === 1 ? [d.pts[0], d.cursor] : [d.pts[0], d.pts[1]];
      const w = d.pts.length === 1 ? this.px(c1) * 12 : Math.abs(lineSide(c1, c2, d.cursor));
      for (const pl of slotOutline(c1, c2, w)) poly(pl, C.pre);
    }
    // Dimension lines.
    const dims = [...this.sk.dims, ...(this.dimDraft.dim ? [this.dimDraft.dim] : [])];
    for (const dm of dims) this.dimGeometry(dm, (a, b) => push(a, b, this.selection.has(dm.id) ? C.sel : C.dim, dimSegs, dimCols));

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
    addPt([0, 0], 0xd9480f);
    for (const e of this.sk.ents) if (e.t === "point") addPt([e.x, e.y], color(e.id));
    if (d.cursor && !["select", "dim", "hord", "vord", "trim", "fillet", "chamfer", "extend", "split", "offset", "convert", "intersect"].includes(this.tool)) addPt(d.cursor, C.pre);
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

  /** The live size beside the cursor while drawing (SolidWorks shows length, radius, angle). */
  private cursorLabel() {
    let el = this.host.layer.querySelector<HTMLElement>(".sk-cursor");
    const d = this.draft, p = d.cursor, a = d.pts[0];
    const u = this.host.unit();
    const L = (x: number) => trimNum(x / u.mm, u.decimals);
    let text = "";
    if (p && a) {
      const last = d.pts.at(-1)!;
      if (this.tool === "line") { const dx = p[0] - last[0], dy = p[1] - last[1]; text = `L ${L(Math.hypot(dx, dy))} · ${trimNum((((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360, 1)}°`; }
      else if (this.tool === "circle" || this.tool === "polygon") text = `R ${L(Math.hypot(p[0] - a[0], p[1] - a[1]))}`;
      else if ((this.tool === "ellipse" || this.tool === "earc") && d.pts.length < 3) {
        const E = d.pts.length === 2 ? this.draftEll(a, d.pts[1], p) : null;
        text = d.pts.length === 1 ? `R ${L(Math.hypot(p[0] - a[0], p[1] - a[1]))}` : E ? `${L(E.r1 * 2)} × ${L(E.r2 * 2)}` : "";
      }
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

  private dimGeometry(dm: SkDim, line: (a: V2, b: V2) => void) {
    const pos = dm.pos ?? [0, 0];
    if (dm.t === "radius" || dm.t === "diameter") {
      const e = this.ent(dm.e[0]);
      if (!e || (e.t !== "circle" && e.t !== "arc")) return;
      const c = this.pt(e.c), r = e.t === "circle" ? e.r : Math.hypot(this.pt(e.a)[0] - c[0], this.pt(e.a)[1] - c[1]);
      const a = Math.atan2(pos[1] - c[1], pos[0] - c[0]);
      const rim: V2 = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
      line(dm.t === "diameter" ? [c[0] - r * Math.cos(a), c[1] - r * Math.sin(a)] : c, rim);
      line(rim, pos);
      return;
    }
    if (dm.t === "angle") {
      const l1 = this.ent(dm.e[0]), l2 = this.ent(dm.e[1]);
      if (l1?.t !== "line" || l2?.t !== "line") return;
      const I = intersect(this.pt(l1.a), this.pt(l1.b), this.pt(l2.a), this.pt(l2.b));
      if (I) line(I, pos);
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
    // Small ticks at the ends.
    const s = this.px(fa) * 5;
    for (const f of [fa, fb]) line([f[0] - (dir[0] + nrm[0]) * s, f[1] - (dir[1] + nrm[1]) * s], [f[0] + (dir[0] + nrm[0]) * s, f[1] + (dir[1] + nrm[1]) * s]);
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
        this.host.layer.appendChild(el);
        this.labels.set(id, el);
      }
      seen.add(id);
      return el;
    };
    for (const d of dims) {
      const el = mk(d.id, "sk-dim");
      const v = d.t === "angle" ? `${trimNum((d.val.v * 180) / Math.PI, 2)}°` : `${d.t === "diameter" ? "⌀" : d.t === "radius" ? "R" : ""}${trimNum((d.driven ? measureDim(this.sk, d) : d.val.v) / u.mm, u.decimals)}`;
      el.textContent = d.driven ? `(${v})` : v;
      if (d.dia && !d.driven) el.textContent = `⌀${v}`;
      else if (d.dia) el.textContent = `(⌀${v})`;
      // Full name on hover (FR-SK-065), as expressions use it.
      el.title = `${d.name}@${this.sk.name}${d.val.expr ? ` = ${d.val.expr}` : ""}${d.driven ? ` · ${t("reference")}` : ""}`;
      if (this.showNames) { const n = document.createElement("span"); n.className = "sk-dname"; n.textContent = d.name; n.setAttribute("translate", "no"); el.prepend(n); }
      el.classList.toggle("sel", this.selection.has(d.id));
      el.classList.toggle("driven", !!d.driven);
      el.classList.toggle("draft", d === this.dimDraft.dim);
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
      if (r.t === "coincident" || r.t === "onCurve") continue;
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
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
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

  private anchorOf(id: string): V2 {
    const e = this.ent(id);
    if (!e) return [0, 0];
    if (e.t === "point") return [e.x, e.y];
    if (e.t === "line") { const a = this.pt(e.a), b = this.pt(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    if (e.t === "circle") { const c = this.pt(e.c); return [c[0] + e.r * 0.7071, c[1] + e.r * 0.7071]; }
    if (e.t === "ellipse") return ellPt(this.ell(e), Math.PI / 4);
    if (e.t === "spline") { const l = this.splineLine(e); return l[Math.floor(l.length / 2)]; }
    return this.pt(e.a);
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
    for (const el of this.labels.values()) {
      const p = JSON.parse(el.dataset.pos ?? "[0,0]") as V2;
      const [x, y] = this.screen(p);
      const k = Number(el.dataset.k ?? 0);
      el.style.left = `${x + (el.classList.contains("sk-rel") ? 10 + k * 16 : 0)}px`;
      el.style.top = `${y + (el.classList.contains("sk-rel") ? 10 : 0)}px`;
    }
  }
}

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

function onCurve(g: Curve, p: V2): boolean {
  const tol = 1e-7;
  if (g.kind === "line") { const u = paramOf(g, p); return u >= -tol && u <= 1 + tol; }
  if (g.kind === "circle") return true;
  const u = paramOf(g, p);
  return u <= g.sweep + tol || u >= Math.PI * 2 - tol;
}

/** Points where two curves' carriers (infinite line, full circle) meet. */
function intersectCurves(g: Curve, h: Curve): V2[] {
  if (g.kind === "line" && h.kind === "line") { const p = intersect(g.a, g.b, h.a, h.b); return p ? [p] : []; }
  if (g.kind === "line") return lineCircle(g.a, g.b, (h as { c: V2 }).c, (h as { r: number }).r);
  if (h.kind === "line") return lineCircle(h.a, h.b, g.c, g.r);
  return circleCircle(g.c, g.r, h.c, h.r);
}

function lineCircle(a: V2, b: V2, c: V2, r: number): V2[] {
  const d = sub2(b, a), f = sub2(a, c);
  const A = dot2(d, d), B = 2 * dot2(f, d), C = dot2(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-12 * A * r * r || A < 1e-18) return [];
  const s = Math.sqrt(Math.max(0, disc));
  const ts = s < 1e-12 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.map(t => [a[0] + d[0] * t, a[1] + d[1] * t] as V2);
}

function circleCircle(c1: V2, r1: number, c2: V2, r2: number): V2[] {
  const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
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

/** Outline of a straight slot round the centres c1, c2 with half-width w, as polylines. */
function slotOutline(c1: V2, c2: V2, w: number): V2[][] {
  const len = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  if (len < 1e-9) return [];
  const u = norm2(sub2(c2, c1)), n: V2 = [-u[1], u[0]], a = Math.atan2(n[1], n[0]);
  const P = (c: V2, k: number): V2 => [c[0] + n[0] * w * k, c[1] + n[1] * w * k];
  const arc = (c: V2, a0: number) => Array.from({ length: 25 }, (_, i) => [c[0] + w * Math.cos(a0 + (Math.PI * i) / 24), c[1] + w * Math.sin(a0 + (Math.PI * i) / 24)] as V2);
  return [[P(c1, 1), P(c2, 1)], [P(c1, -1), P(c2, -1)], arc(c2, a - Math.PI), arc(c1, a), [c1, c2]];
}
