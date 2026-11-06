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
import type { Frame, RelKind, SkDim, SkEnt, SketchFeature, SkRel, V2 } from "../model/types";
import { ORIGIN, measureDim, solve, tryAdd, type SolveResult } from "./solver";
import { uid } from "../model/doc";
import { evaluate, ExprError, isPlain } from "../model/expr";
import { t } from "../i18n";

export type SkTool = "select" | "line" | "rect" | "crect" | "circle" | "arc" | "point" | "dim";

export interface SketchHost {
  viewer: Viewer;
  /** Element the dimension labels and inputs are placed in (over the canvas). */
  layer: HTMLElement;
  commit(label: string, sk: SketchFeature): void;
  status(text: string): void;
  toast(msg: string, kind?: "info" | "warn" | "error"): void;
  /** Display unit factor (mm per unit) and name, decimals. */
  unit(): { mm: number; name: string; decimals: number };
  onSelection?(ids: string[]): void;
}

const SNAP_PX = 9;
const HV_TOL = (3 * Math.PI) / 180;

type Hit = { id: string; kind: "point" | "line" | "circle" | "arc" | "origin" | "dim" | "rel"; d: number };

const COLORS = {
  light: { free: 0x1d4ed8, defined: 0x111827, cons: 0x7c8594, sel: 0xf08c00, hover: 0xf59f00, bad: 0xd32f2f, dim: 0x334155, pre: 0x2f9e44 },
  dark: { free: 0x6ea8ff, defined: 0xe8ecf2, cons: 0x8a94a6, sel: 0xffa94d, hover: 0xffc078, bad: 0xff6b5e, dim: 0xcbd5e1, pre: 0x51cf66 },
};

const REL_GLYPH: Record<RelKind, string> = {
  coincident: "◉", horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "⫽", equal: "=",
  tangent: "T", concentric: "◎", midpoint: "M", fix: "⚓", onCurve: "◦", symmetric: "⇹",
};
export const REL_NAME: Record<RelKind, string> = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular",
  collinear: "Collinear", equal: "Equal", tangent: "Tangent", concentric: "Concentric", midpoint: "Midpoint", fix: "Fix",
  onCurve: "On curve", symmetric: "Symmetric",
};

export class SketchEditor {
  sk: SketchFeature;
  tool: SkTool = "select";
  selection = new Set<string>();
  info: SolveResult;
  private group = new THREE.Group();
  private hover: Hit | null = null;
  /** In-progress entity: its points so far, and the live cursor point. */
  private draft: { pts: V2[]; ids: (string | null)[]; cursor: V2 | null; snap: string | null; chainStart?: string; snapCurve?: string | null; snapOrigin?: boolean } = { pts: [], ids: [], cursor: null, snap: null };
  private dimDraft: { picks: Hit[]; dim: SkDim | null } = { picks: [], dim: null };
  private drag: { ids: string[]; start: V2; orig: Map<string, V2>; circle?: string; moved: boolean; base: SketchFeature } | null = null;
  private labels = new Map<string, HTMLElement>();
  private input: HTMLInputElement | null = null;
  private marker: THREE.Mesh;
  private dark = false;

  constructor(private host: SketchHost, sk: SketchFeature, public frame: Frame) {
    this.sk = structuredClone(sk);
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
    this.frame = frame;
    for (const id of [...this.selection]) if (!this.has(id)) this.selection.delete(id);
    this.info = solve(this.sk);
    this.render();
  }

  setTool(tool: SkTool) {
    this.closeInput(false);
    this.tool = tool;
    this.draft = { pts: [], ids: [], cursor: null, snap: null };
    this.dimDraft = { picks: [], dim: null };
    if (tool !== "select" && tool !== "dim") this.selection.clear();
    this.render();
    this.statusHint();
  }

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
      if (d < tol) out.push({ id: e.id, kind: e.t as Hit["kind"], d: d + tol * 0.25 });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // ---------- pointer ----------

  /** Returns true when the event was used (so the viewer does not orbit or measure). */
  pointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    const p = this.uv(e);
    if (!p) return true;
    this.closeInput(true);
    if (this.tool === "select") {
      const h = this.hits(p)[0] ?? null;
      if (!h || h.kind === "origin") {
        if (!e.ctrlKey && !e.shiftKey) this.selection.clear();
        this.render();
        this.emitSel();
        return true;
      }
      if (e.ctrlKey || e.shiftKey || e.metaKey) { if (this.selection.has(h.id)) this.selection.delete(h.id); else this.selection.add(h.id); }
      else if (!this.selection.has(h.id)) { this.selection.clear(); this.selection.add(h.id); }
      this.emitSel();
      // Start a drag of what is under the cursor.
      const ent = this.ent(h.id)!;
      const ids = ent.t === "point" ? [ent.id] : ent.t === "line" ? [ent.a, ent.b] : ent.t === "arc" ? [ent.c, ent.a, ent.b] : [];
      const orig = new Map(ids.map(id => [id, this.pt(id)] as const));
      this.drag = { ids, start: p, orig, circle: ent.t === "circle" ? ent.id : undefined, moved: false, base: structuredClone(this.sk) };
      this.render();
      return true;
    }
    if (this.tool === "dim") { this.dimClick(p, e); return true; }
    this.drawClick(p, e);
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (e.buttons & 6) return false; // panning / orbiting with the other buttons
    const p = this.uv(e);
    if (!p) return true;
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
    const snap = this.snapPoint(p, this.tool !== "select");
    this.hover = this.tool === "select" || this.tool === "dim" ? this.hits(p)[0] ?? null : null;
    this.draft.cursor = snap.p;
    this.draft.snap = snap.id;
    this.render();
    return true;
  }

  pointerUp(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
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
  private snapPoint(p: V2, active: boolean): { p: V2; id: string | null; curve: string | null; hv: "horizontal" | "vertical" | null } {
    this.marker.visible = false;
    if (!active) return { p, id: null, curve: null, hv: null };
    const exclude = new Set<string>();
    const h = this.hits(p, { curves: false, exclude });
    if (h.length) { const q = this.pt(h[0].id); this.showMarker(q); return { p: q, id: h[0].id, curve: null, hv: null }; }
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

  private project(p: V2, id: string): V2 {
    const e = this.ent(id)!;
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

  /** A point for a new entity: an existing point, the origin (fixed by a relation), or a new one. */
  private usePoint(p: V2, snapId: string | null, curve: string | null, rels: SkRel[]): string {
    if (snapId && snapId !== ORIGIN) return snapId;
    const id = uid("p");
    this.sk.ents.push({ id, t: "point", x: p[0], y: p[1] });
    if (snapId === ORIGIN) rels.push({ id: uid("r"), t: "coincident", e: [id, ORIGIN] });
    else if (curve) rels.push({ id: uid("r"), t: "onCurve", e: [id, curve] });
    return id;
  }

  private drawClick(raw: V2, e: PointerEvent) {
    const s = this.snapPoint(raw, true);
    const p = s.p;
    const d = this.draft;
    const rels: SkRel[] = [];
    const finish = (label: string) => { this.sk.rels.push(...rels); this.commit(label); };
    if (this.tool === "point") { this.usePoint(p, s.id, s.curve, rels); finish("Add point"); return; }
    if (this.tool === "line") {
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id && s.id !== ORIGIN ? s.id : null]; d.chainStart = s.id ?? undefined; d.snapCurve = s.curve; d.snapOrigin = s.id === ORIGIN; this.render(); return; }
      const a0 = d.pts.at(-1)!;
      if (Math.hypot(p[0] - a0[0], p[1] - a0[1]) < this.px(p) * 2) return;
      const aId = d.ids.at(-1) ?? this.usePoint(a0, d.snapOrigin ? ORIGIN : null, d.snapCurve ?? null, rels);
      const bId = this.usePoint(p, s.id, s.curve, rels);
      const lid = uid("l");
      this.sk.ents.push({ id: lid, t: "line", a: aId, b: bId });
      if (s.hv) rels.push({ id: uid("r"), t: s.hv, e: [lid] });
      finish("Add line");
      // Chain on from the end, unless the loop closed on an existing point.
      const closed = !!s.id && s.id !== ORIGIN && d.ids.length > 0;
      if (closed || e.detail >= 2) { this.draft = { pts: [], ids: [], cursor: null, snap: null }; }
      else { d.pts.push(p); d.ids.push(bId); d.snapCurve = null; d.snapOrigin = false; }
      this.render();
      return;
    }
    if (this.tool === "circle" || this.tool === "rect" || this.tool === "crect") {
      if (!d.pts.length) { d.pts = [p]; d.ids = [s.id]; d.snapCurve = s.curve; this.render(); return; }
      const c = d.pts[0];
      if (Math.hypot(p[0] - c[0], p[1] - c[1]) < this.px(p) * 3) return;
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
    if (dd.dim) {
      // Second click places the dimension and asks for its value.
      this.placeDimDraft(p);
      const dim = dd.dim;
      this.dimDraft = { picks: [], dim: null };
      this.addDimension(dim);
      return;
    }
    const h = this.hits(p)[0];
    if (!h) { this.selection.clear(); dd.picks = []; this.render(); return; }
    if (!dd.picks.some(x => x.id === h.id)) dd.picks.push(h);
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
    const pts = this.dimPoints(dim);
    if ((dim.t === "distance" || dim.t === "hdistance" || dim.t === "vdistance") && pts) {
      const [a, b] = pts;
      const inX = p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]);
      const inY = p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1]);
      const lineLen = dim.e.length === 1 || this.ent(dim.e[0])?.t === "line" && this.ent(dim.e[1] ?? "")?.t === "line";
      if (!lineLen || dim.e.length === 1) {
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
    try { v = evaluate(inp.value, dim.t === "angle" ? "angle" : "length", dim.t === "angle" ? "deg" : this.host.unit().name); }
    catch (err) { this.host.toast(t((err as ExprError).message), "error"); return; }
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
    if (total === 3 && n("line") >= 1 && (n("point") === 2 || n("line") === 3)) out.push("symmetric");
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
    if (kind === "midpoint" || kind === "coincident") e.sort((a, b) => (kindOf(a) === "point" ? -1 : 0) - (kindOf(b) === "point" ? -1 : 0));
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
      const pts = e.t === "line" ? [e.a, e.b] : e.t === "circle" ? [e.c] : [e.c, e.a, e.b];
      for (const p of pts) {
        const used = this.sk.ents.some(o => !del.has(o.id) && o.id !== p && o.t !== "point" && (o.t === "line" ? o.a === p || o.b === p : o.t === "circle" ? o.c === p : o.c === p || o.a === p || o.b === p));
        if (!used) del.add(p);
      }
    }
    // Points still used by a kept curve stay.
    for (const id of [...del]) {
      const e = this.ent(id);
      if (e?.t === "point" && this.sk.ents.some(o => !del.has(o.id) && o.t !== "point" && (o.t === "line" ? o.a === id || o.b === id : o.t === "circle" ? o.c === id : o.c === id || o.a === id || o.b === id))) del.delete(id);
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

  private commit(label: string) {
    this.info = solve(this.sk);
    this.host.commit(label, structuredClone(this.sk));
    this.statusHint();
  }

  private emitSel() { this.host.onSelection?.([...this.selection]); }

  // ---------- keys ----------

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "escape") {
      if (this.draft.pts.length || this.dimDraft.picks.length) { this.setTool(this.tool); return true; }
      if (this.tool !== "select") { this.setTool("select"); return true; }
      if (this.selection.size) { this.selection.clear(); this.render(); this.emitSel(); return true; }
      return false;
    }
    if (k === "delete" || k === "backspace") return this.deleteSelection();
    const tools: Record<string, SkTool> = { l: "line", r: "rect", c: "circle", a: "arc", d: "dim", p: "point", s: "select" };
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
      dim: "Click one or two items, then click where the dimension goes",
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
      return [[a[0] + u[0] * tt, a[1] + u[1] * tt], p];
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
    const color = (id: string, cons?: boolean) => {
      if (this.selection.has(id)) return C.sel;
      if (this.hover?.id === id) return C.hover;
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
    const arcPts = (c: V2, r: number, a0: number, a1: number, n = 48) => {
      const out: V2[] = [];
      for (let i = 0; i <= n; i++) { const tt = a0 + ((a1 - a0) * i) / n; out.push([c[0] + r * Math.cos(tt), c[1] + r * Math.sin(tt)]); }
      return out;
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
      }
    }
    // Preview of the entity being drawn.
    const d = this.draft;
    if (d.pts.length && d.cursor) {
      const p = d.cursor, a = d.pts[0];
      if (this.tool === "line") push(d.pts.at(-1)!, p, C.pre);
      else if (this.tool === "circle") poly(arcPts(a, Math.hypot(p[0] - a[0], p[1] - a[1]), 0, Math.PI * 2, 72), C.pre);
      else if (this.tool === "rect" || this.tool === "crect") {
        const [x0, y0] = this.tool === "rect" ? a : [2 * a[0] - p[0], 2 * a[1] - p[1]];
        poly([[x0, y0], [p[0], y0], [p[0], p[1]], [x0, p[1]], [x0, y0]], C.pre);
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
    if (d.cursor && this.tool !== "select" && this.tool !== "dim") addPt(d.cursor, C.pre);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
    pg.setAttribute("color", new THREE.Float32BufferAttribute(pc, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    pts.renderOrder = 3001;
    this.group.add(pts);

    this.syncLabels(dims);
    v.invalidate();
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
        el = document.createElement("button");
        el.className = cls;
        el.dataset.id = id;
        el.addEventListener("pointerdown", e => e.stopPropagation());
        el.addEventListener("click", ev => {
          ev.stopPropagation();
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
      el.title = `${d.name}${d.val.expr ? ` = ${d.val.expr}` : ""}${d.driven ? ` · ${t("reference")}` : ""}`;
      el.classList.toggle("sel", this.selection.has(d.id));
      el.classList.toggle("driven", !!d.driven);
      el.classList.toggle("draft", d === this.dimDraft.dim);
      el.dataset.pos = JSON.stringify(d.pos ?? [0, 0]);
    }
    // Relation glyphs next to the first entity of each relation (points: beside the point).
    const per = new Map<string, number>();
    for (const r of this.sk.rels) {
      if (r.t === "coincident" || r.t === "onCurve") continue;
      const el = mk(r.id, "sk-rel");
      el.textContent = REL_GLYPH[r.t];
      el.title = t(REL_NAME[r.t]);
      el.setAttribute("aria-label", t(REL_NAME[r.t]));
      el.classList.toggle("sel", this.selection.has(r.id));
      const anchor = r.e.find(x => x !== ORIGIN) ?? ORIGIN;
      const k = per.get(anchor) ?? 0;
      per.set(anchor, k + 1);
      el.dataset.pos = JSON.stringify(this.anchorOf(anchor));
      el.dataset.k = String(k);
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
    this.placeLabels();
  }

  private anchorOf(id: string): V2 {
    const e = this.ent(id);
    if (!e) return [0, 0];
    if (e.t === "point") return [e.x, e.y];
    if (e.t === "line") { const a = this.pt(e.a), b = this.pt(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    if (e.t === "circle") { const c = this.pt(e.c); return [c[0] + e.r * 0.7071, c[1] + e.r * 0.7071]; }
    return this.pt(e.a);
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
