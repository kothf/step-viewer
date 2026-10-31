// 2D PCB layer viewer (Gerber RS-274X / X2, Excellon) on Canvas 2D, with
// snapping and measurements: smart query, point to point, clearance,
// polyline and area. Everything is in board millimetres; display units are mm, in or mil.

import { arcSweep, centerlineBox, contourPts, trackRadius, FeatStore, flashArea, primD, regionArea, SNAP_CENTER, SNAP_MID, tessArc, type BuiltLayer, type Feature } from "./build";
import { featureGap, Grid, nearestOnBoundary, primContains, type P2 } from "./geom";
import { defaultStyle } from "./load";
import { G_UNITS, type GObj, type GUnit } from "./model";
import GerberWorker from "./gerber.worker?worker";

export type GTool = "smart" | "distance" | "clearance" | "polyline" | "area";
export type SnapKind = "vertex" | "center" | "mid" | "edge" | "perp" | "free";

export interface LayerView {
  id: number;
  L: BuiltLayer;
  visible: boolean;
  color: string;
  opacity: number;
  feats: FeatStore;
  grid: Grid;
  paths?: { dark: boolean; fill: Path2D[]; eo: Path2D | null; hair: Path2D | null }[];
  loops?: Map<string, number[]>;
  stats?: { tracks: number; pads: number; holes: number; minTrack: number; minHole: number; sizes: Set<number> };
  /** Outline layers: bounds of the cut line itself. */
  cbox?: [number, number, number, number] | null;
}

/** A feature: layer id (stable across reordering) and feature index. */
export interface FeatRef { lid: number; fi: number }
export interface SnapPick { p: P2; kind: SnapKind; feat: FeatRef | null }

export interface GMeasure {
  id: string;
  type: GTool | "info" | "relation" | "shapeArea";
  title: string;
  /** Primary numeric value in mm (or mm² for areas). */
  value: number;
  isArea?: boolean;
  /** Text shown for the value (in display units at creation time it is recomputed on demand). */
  pts: P2[];
  closed?: boolean;
  legs?: boolean;
  /** Clearance line drawn next to a pitch. */
  gap?: [P2, P2];
  feats?: FeatRef[];
  rows: () => [string, string][];
  text: () => string;
  visible: boolean;
}

const BG = "#0b0e13";
const MCOL = "#22d3ee";
const LEGX = "#ff6b6b", LEGY = "#51cf66";

export interface GerberHost {
  setLoading(on: boolean, text?: string, pct?: number): void;
  toast(msg: string, err?: boolean): void;
  status(coord: string, snap: string): void;
  download(blob: Blob, name: string): void;
  onChange?(): void;
}

// ---------- painters (canvas and SVG share the overlay drawing) ----------

interface LineStyle { color: string; width?: number; dash?: number[]; halo?: boolean }
interface Painter {
  line(a: P2, b: P2, s: LineStyle): void;
  poly(pts: P2[], closed: boolean, s: LineStyle, fill?: string): void;
  dot(p: P2, r: number, color: string): void;
  label(p: P2, text: string, color: string, small?: boolean): { x: number; y: number; w: number; h: number };
}

class CanvasPainter implements Painter {
  constructor(private c: CanvasRenderingContext2D) {}
  private stroke(s: LineStyle) {
    const c = this.c;
    c.setLineDash(s.dash ?? []);
    if (s.halo !== false) { c.strokeStyle = "rgba(0,0,0,0.85)"; c.lineWidth = (s.width ?? 1.6) + 2.4; c.stroke(); }
    c.strokeStyle = s.color; c.lineWidth = s.width ?? 1.6; c.stroke();
    c.setLineDash([]);
  }
  line(a: P2, b: P2, s: LineStyle) { const c = this.c; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); this.stroke(s); }
  poly(pts: P2[], closed: boolean, s: LineStyle, fill?: string) {
    const c = this.c;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    if (closed) c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    this.stroke(s);
  }
  dot(p: P2, r: number, color: string) {
    const c = this.c;
    c.beginPath(); c.arc(p[0], p[1], r, 0, 2 * Math.PI);
    c.fillStyle = color; c.fill(); c.lineWidth = 1.2; c.strokeStyle = "#000"; c.stroke();
  }
  label(p: P2, text: string, color: string, small = false) {
    const c = this.c;
    c.font = `${small ? 600 : 650} ${small ? 10 : 12}px ui-monospace, Menlo, monospace`;
    const w = c.measureText(text).width + 10, h = small ? 15 : 19;
    const x = Math.round(p[0] - w / 2), y = Math.round(p[1] - h / 2);
    c.fillStyle = "rgba(8,10,14,0.88)";
    c.strokeStyle = color; c.lineWidth = small ? 1 : 1.5;
    c.beginPath(); c.roundRect(x, y, w, h, 4); c.fill(); c.stroke();
    c.fillStyle = small ? color : "#fff"; c.textBaseline = "middle"; c.textAlign = "center";
    c.fillText(text, p[0], y + h / 2 + 0.5);
    return { x, y, w, h };
  }
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

class SvgPainter implements Painter {
  out: string[] = [];
  private attrs(s: LineStyle) { return `stroke="${s.color}" stroke-width="${s.width ?? 1.6}"${s.dash ? ` stroke-dasharray="${s.dash.join(" ")}"` : ""} stroke-linecap="round" stroke-linejoin="round"`; }
  private halo(s: LineStyle, geom: string) {
    if (s.halo !== false) this.out.push(geom.replace("/>", ` fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="${(s.width ?? 1.6) + 2.4}"${s.dash ? ` stroke-dasharray="${s.dash.join(" ")}"` : ""}/>`));
  }
  line(a: P2, b: P2, s: LineStyle) {
    const g = `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}"/>`;
    this.halo(s, g);
    this.out.push(g.replace("/>", ` ${this.attrs(s)}/>`));
  }
  poly(pts: P2[], closed: boolean, s: LineStyle, fill?: string) {
    const d = pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
    const g = `<${closed ? "polygon" : "polyline"} points="${d}"/>`;
    this.halo(s, g);
    this.out.push(g.replace("/>", ` fill="${fill ?? "none"}" ${this.attrs(s)}/>`));
  }
  dot(p: P2, r: number, color: string) { this.out.push(`<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="${r}" fill="${color}" stroke="#000" stroke-width="1.2"/>`); }
  label(p: P2, text: string, color: string, small = false) {
    const w = text.length * (small ? 6.1 : 7.3) + 10, h = small ? 15 : 19;
    const x = p[0] - w / 2, y = p[1] - h / 2;
    this.out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="4" fill="#080a0e" fill-opacity="0.88" stroke="${color}" stroke-width="${small ? 1 : 1.5}"/>`);
    this.out.push(`<text x="${p[0].toFixed(1)}" y="${(y + h / 2 + 0.5).toFixed(1)}" fill="${small ? color : "#fff"}" font-family="ui-monospace, Menlo, monospace" font-size="${small ? 10 : 12}" font-weight="650" text-anchor="middle" dominant-baseline="middle">${xmlEsc(text)}</text>`);
    return { x, y, w, h };
  }
}

// ---------- the view ----------

export class GerberView {
  layers: LayerView[] = [];
  name = "";
  view = { s: 10, ox: 0, oy: 0, mirror: false };
  tool: GTool = "smart";
  unit: GUnit = "mm";
  decimals = 3;
  snapOn = true;
  snapKinds = { vertex: true, center: true, edge: true };
  measurements: GMeasure[] = [];
  live: GMeasure | null = null;
  selected: string | null = null;
  picks: SnapPick[] = [];
  hover: FeatRef | null = null;
  snap: SnapPick | null = null;
  cursor: P2 | null = null;
  lastRenderMs = 0;

  private main: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private comp = document.createElement("canvas");
  private scratch = document.createElement("canvas");
  private compView: { s: number; ox: number; oy: number; mirror: boolean } | null = null;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private nextId = 1;
  private layerSeq = 1;
  private frame = 0;
  private fullTimer = 0;
  private overlayQueued = false;
  private labelRects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  private spaceDown = false;
  private worker: Worker | null = null;
  private listeners: (() => void)[] = [];

  constructor(private root: HTMLElement, private host: GerberHost) {
    this.main = root.querySelector<HTMLCanvasElement>("#g-canvas")!;
    this.over = root.querySelector<HTMLCanvasElement>("#g-overlay")!;
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.bindPointer();
    window.addEventListener("keyup", e => { if (e.key === " ") { this.spaceDown = false; this.root.classList.remove("grab"); } });
  }

  /** Subscribe to state changes (layers, measurements, tool, units). */
  onChange(fn: () => void) { this.listeners.push(fn); }
  private changed() { for (const f of this.listeners) f(); }

  // ---------- loading ----------

  load(files: { name: string; data: ArrayBuffer }[], append = false): Promise<boolean> {
    this.worker ??= new GerberWorker();
    const w = this.worker;
    this.host.setLoading(true, "Reading PCB layers…", 3);
    return new Promise<boolean>(resolve => {
      w.onmessage = (e: MessageEvent) => {
        const d = e.data;
        if (d.type === "progress") { this.host.setLoading(true, d.text, d.pct); return; }
        this.host.setLoading(false);
        if (d.type === "error") { this.host.toast(`Could not read the PCB files: ${d.text}`, true); resolve(false); return; }
        const layers = d.layers as BuiltLayer[];
        if (!layers.length) { this.host.toast(`No Gerber or Excellon layers found${d.skipped.length ? ` (skipped ${d.skipped.join(", ")})` : ""}.`, true); resolve(false); return; }
        this.setLayers(layers, append);
        const warn = layers.flatMap(l => l.warnings.map(x => `${l.name}: ${x}`));
        if (d.skipped.length) this.host.toast(`Skipped files that are not PCB layers: ${d.skipped.join(", ")}`);
        else if (warn.length) this.host.toast(warn.slice(0, 2).join(" · "));
        resolve(true);
      };
      w.postMessage({ files }, files.map(f => f.data));
    });
  }

  setLayers(built: BuiltLayer[], append = false) {
    if (!append) { this.layers = []; this.measurements = []; this.live = null; this.picks = []; this.selected = null; this.hover = null; }
    const add = built.map(L => {
      const st = defaultStyle(L.kind, L.side);
      const feats = new FeatStore(L.packed);
      return { id: this.layerSeq++, L, feats, visible: true, color: st.color, opacity: st.opacity, grid: new Grid(feats, L.bbox) } as LayerView;
    });
    // Top of the list draws last: sort by rank, highest first.
    this.layers = [...this.layers, ...add].sort((a, b) => b.L.rank - a.L.rank);
    this.fit(false);
    this.changed();
  }

  get loaded() { return this.layers.length > 0; }

  // ---------- view ----------

  private resize() {
    const r = this.root.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    for (const c of [this.main, this.over, this.comp, this.scratch]) { c.width = Math.round(this.w * this.dpr); c.height = Math.round(this.h * this.dpr); }
    for (const c of [this.main, this.over]) { c.style.width = `${this.w}px`; c.style.height = `${this.h}px`; }
    this.compView = null;
    this.render(true);
  }

  toScreen(x: number, y: number): P2 { const v = this.view; return [v.ox + v.s * (v.mirror ? -x : x), v.oy - v.s * y]; }
  toBoard(sx: number, sy: number): P2 { const v = this.view; const x = (sx - v.ox) / v.s; return [v.mirror ? -x : x, (v.oy - sy) / v.s]; }

  boardBox(visibleOnly = true): [number, number, number, number] | null {
    const ls = this.layers.filter(l => !visibleOnly || l.visible);
    const outline = ls.find(l => l.L.kind === "outline" && l.L.bbox[0] <= l.L.bbox[2]);
    if (outline) { if (outline.cbox === undefined) outline.cbox = centerlineBox(outline.L.objs); if (outline.cbox) return outline.cbox; }
    const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of ls) { const b = l.L.bbox; if (!(b[0] <= b[2])) continue; bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
    return bb[0] <= bb[2] ? bb : null;
  }

  fit(animate = true) {
    void animate;
    const bb = this.boardBox(true) ?? this.boardBox(false);
    if (!bb) return;
    const w = Math.max(bb[2] - bb[0], 1e-3), h = Math.max(bb[3] - bb[1], 1e-3);
    const s = Math.min((this.w * 0.9) / w, (this.h * 0.9) / h);
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    this.view.s = s;
    this.view.ox = this.w / 2 - s * (this.view.mirror ? -cx : cx);
    this.view.oy = this.h / 2 + s * cy;
    this.viewChanged();
  }

  zoomAt(sx: number, sy: number, k: number) {
    const [bx, by] = this.toBoard(sx, sy);
    this.view.s = Math.min(Math.max(this.view.s * k, 1e-3), 1e6);
    const [nx, ny] = this.toScreen(bx, by);
    this.view.ox += sx - nx; this.view.oy += sy - ny;
    this.viewChanged();
  }

  setMirror(on: boolean) {
    const c = this.toBoard(this.w / 2, this.h / 2);
    this.view.mirror = on;
    const [sx] = this.toScreen(c[0], c[1]);
    this.view.ox += this.w / 2 - sx;
    this.compView = null;
    this.viewChanged();
    this.changed();
  }

  private viewChanged() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (this.lastRenderMs < 28 || !this.compView) this.render(true);
      else {
        this.preview();
        clearTimeout(this.fullTimer);
        this.fullTimer = window.setTimeout(() => this.render(true), 140);
      }
    });
  }

  /** Cheap redraw during pan/zoom: the last full render, transformed. */
  private preview() {
    const cv = this.compView!, v = this.view;
    if (cv.mirror !== v.mirror) { this.render(true); return; }
    const c = this.main.getContext("2d")!;
    const k = v.s / cv.s;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = BG; c.fillRect(0, 0, this.main.width, this.main.height);
    const d = this.dpr;
    c.setTransform(k, 0, 0, k, d * (v.ox - k * cv.ox), d * (v.oy - k * cv.oy));
    c.drawImage(this.comp, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.drawOverlay();
  }

  private paths(lv: LayerView) {
    lv.paths ??= lv.L.batches.map(b => ({
      dark: b.dark,
      fill: b.fill.map(d => new Path2D(d)),
      eo: b.eo.length ? new Path2D(b.eo.join("")) : null,
      hair: b.hair ? new Path2D(b.hair) : null,
    }));
    return lv.paths;
  }

  private applyView(c: CanvasRenderingContext2D) {
    const v = this.view, d = this.dpr;
    c.setTransform(d * v.s * (v.mirror ? -1 : 1), 0, 0, -d * v.s, d * v.ox, d * v.oy);
  }

  render(full = true) {
    void full;
    const t0 = performance.now();
    const c = this.main.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = BG; c.fillRect(0, 0, this.main.width, this.main.height);
    const sc = this.scratch.getContext("2d")!;
    const [vx0, vy1] = this.toBoard(0, 0), [vx1, vy0] = this.toBoard(this.w, this.h);
    const vb = [Math.min(vx0, vx1), Math.min(vy0, vy1), Math.max(vx0, vx1), Math.max(vy0, vy1)];
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const lv = this.layers[i];
      const b = lv.L.bbox;
      if (!lv.visible || !(b[0] <= vb[2] && b[2] >= vb[0] && b[1] <= vb[3] && b[3] >= vb[1])) continue;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.globalCompositeOperation = "source-over";
      sc.clearRect(0, 0, this.scratch.width, this.scratch.height);
      this.applyView(sc);
      sc.fillStyle = lv.color; sc.strokeStyle = lv.color;
      sc.lineWidth = 1.2 / this.view.s; sc.lineCap = "round"; sc.lineJoin = "round";
      for (const p of this.paths(lv)) {
        sc.globalCompositeOperation = p.dark ? "source-over" : "destination-out";
        for (const f of p.fill) sc.fill(f);
        if (p.eo) sc.fill(p.eo, "evenodd");
        if (p.hair) sc.stroke(p.hair);
      }
      c.globalAlpha = lv.opacity;
      c.drawImage(this.scratch, 0, 0);
      c.globalAlpha = 1;
    }
    const cc = this.comp.getContext("2d")!;
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.clearRect(0, 0, this.comp.width, this.comp.height);
    cc.drawImage(this.main, 0, 0);
    this.compView = { ...this.view };
    this.lastRenderMs = performance.now() - t0;
    this.drawOverlay();
  }

  // ---------- formatting ----------

  fmtLen(mm: number, unit = true) { return (mm * G_UNITS[this.unit]).toFixed(this.decimals) + (unit ? ` ${this.unit}` : ""); }
  fmtArea(mm2: number) { return (mm2 * G_UNITS[this.unit] ** 2).toFixed(this.decimals) + ` ${this.unit}²`; }
  fmtPt(p: P2) { return `X ${this.fmtLen(p[0], false)}  Y ${this.fmtLen(p[1], false)}`; }
  setUnits(u: GUnit) { this.unit = u; this.drawOverlay(); this.changed(); }
  setDecimals(d: number) { this.decimals = Math.max(0, Math.min(4, Math.round(d))); this.drawOverlay(); this.changed(); }

  // ---------- picking and snapping ----------

  lay(r: FeatRef): LayerView { return this.layers.find(l => l.id === r.lid)!; }
  feature(r: FeatRef): Feature { return this.lay(r)?.feats.get(r.fi); }
  obj(r: FeatRef): GObj { return this.lay(r).L.objs[r.fi]; }

  /** The feature under a board point: topmost visible layer, smallest shape first (pads before pours). */
  hitTest(x: number, y: number, tolMm = 0): FeatRef | null {
    for (let li = 0; li < this.layers.length; li++) {
      const lv = this.layers[li];
      if (!lv.visible) continue;
      let best: FeatRef | null = null, bestA = Infinity;
      for (const fi of lv.grid.query(x - tolMm, y - tolMm, x + tolMm, y + tolMm)) {
        const f = lv.feats.get(fi);
        const o = lv.L.objs[f.o];
        if ("dark" in o && !o.dark) continue;
        if (x < f.bb[0] - tolMm || x > f.bb[2] + tolMm || y < f.bb[1] - tolMm || y > f.bb[3] + tolMm) continue;
        const hit = f.prims.some(p => primContains(p.k === "c" ? { ...p, r: p.r + tolMm } : p, x, y));
        if (!hit) continue;
        const a = (f.bb[2] - f.bb[0]) * (f.bb[3] - f.bb[1]);
        if (a < bestA) { bestA = a; best = { lid: lv.id, fi }; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Snap at a screen position. */
  snapAt(sx: number, sy: number): SnapPick {
    const q = this.toBoard(sx, sy);
    const R = 10 / this.view.s;
    const tol = 3 / this.view.s;
    const feat = this.hitTest(q[0], q[1], tol);
    if (!this.snapOn) return { p: q, kind: "free", feat };
    let best: SnapPick | null = null, bd = R;
    const first = this.picks[this.picks.length - 1]?.p;
    let edge: SnapPick | null = null, ed = R * 0.8;
    let perp: SnapPick | null = null, pd = R * 1.2;
    for (let li = 0; li < this.layers.length; li++) {
      const lv = this.layers[li];
      if (!lv.visible) continue;
      for (const fi of lv.grid.query(q[0] - R, q[1] - R, q[0] + R, q[1] + R)) {
        const f = lv.feats.get(fi);
        if (q[0] < f.bb[0] - R || q[0] > f.bb[2] + R || q[1] < f.bb[1] - R || q[1] > f.bb[3] + R) continue;
        const o = lv.L.objs[f.o];
        if ("dark" in o && !o.dark) continue;
        const s = f.snaps;
        for (let i = 0; i < s.length; i += 3) {
          const k = s[i + 2];
          if (k === SNAP_CENTER ? !this.snapKinds.center : !this.snapKinds.vertex) continue;
          const d = Math.hypot(s[i] - q[0], s[i + 1] - q[1]);
          // Centres win ties against corners within a pixel.
          if (d < bd - (k === SNAP_CENTER ? 1 / this.view.s : 0)) { bd = d; best = { p: [s[i], s[i + 1]], kind: k === SNAP_CENTER ? "center" : k === SNAP_MID ? "mid" : "vertex", feat: { lid: lv.id, fi } }; }
        }
        if (!this.snapKinds.edge) continue;
        for (const p of f.prims) {
          const nb = nearestOnBoundary(p, q[0], q[1]);
          if (nb) { const d = Math.hypot(nb[0] - q[0], nb[1] - q[1]); if (d < ed) { ed = d; edge = { p: nb, kind: "edge", feat: { lid: lv.id, fi } }; } }
          // Perpendicular foot from the previous pick onto a straight track edge.
          if (first && p.k === "c" && p.r > 0 && (p.ax !== p.bx || p.ay !== p.by)) {
            const l = Math.hypot(p.bx - p.ax, p.by - p.ay), ux = (p.bx - p.ax) / l, uy = (p.by - p.ay) / l;
            for (const sgn of [1, -1]) {
              const ox = p.ax - uy * p.r * sgn, oy = p.ay + ux * p.r * sgn;
              const t = (first[0] - ox) * ux + (first[1] - oy) * uy;
              if (t < 0 || t > l) continue;
              const foot: P2 = [ox + ux * t, oy + uy * t];
              const d = Math.hypot(foot[0] - q[0], foot[1] - q[1]);
              if (d < pd) { pd = d; perp = { p: foot, kind: "perp", feat: { lid: lv.id, fi } }; }
            }
          }
        }
      }
    }
    return best ?? perp ?? edge ?? { p: q, kind: "free", feat };
  }

  // ---------- describing features ----------

  private attrRows(r: FeatRef, rows: [string, string][]) {
    const o = this.obj(r);
    const L = this.lay(r).L;
    const a = "a" in o ? o.a : undefined;
    const ap = "ap" in o ? L.apertures[o.ap] : undefined;
    if (ap?.attrs?.[".AperFunction"]) rows.push(["Function", ap.attrs[".AperFunction"].replace(/,/g, ", ")]);
    if (a?.[".N"]) rows.push(["Net", a[".N"]]);
    if (a?.[".P"]) { const [ref, pin, fn] = a[".P"].split(","); rows.push(["Pin", `${ref} ${pin}${fn ? ` (${fn})` : ""}`]); }
    else if (a?.[".C"]) rows.push(["Component", a[".C"]]);
    rows.push(["Layer", `${this.lay(r).L.label} · ${L.name}`]);
  }

  private apText(r: FeatRef): string {
    const o = this.obj(r);
    if (!("ap" in o)) return "";
    const ap = this.lay(r).L.apertures[o.ap];
    if (!ap) return `D${o.ap} (undefined)`;
    const P = ap.params;
    const sz = ap.shape === "C" ? `Ø${this.fmtLen(P[0])}`
      : ap.shape === "R" ? `rect ${this.fmtLen(P[0], false)} × ${this.fmtLen(P[1])}`
      : ap.shape === "O" ? `oval ${this.fmtLen(P[0], false)} × ${this.fmtLen(P[1])}`
      : ap.shape === "P" ? `${P[1]}-gon Ø${this.fmtLen(P[0])}`
      : `macro ${ap.shape}`;
    return `D${ap.code} ${sz}${ap.clear.length && ap.shape.length === 1 ? `, hole Ø${this.fmtLen(ap.clear[0].k === "c" ? ap.clear[0].r * 2 : 0)}` : ""}`;
  }

  /** Centre of a feature, when it has a natural one (pad, hole, arc, slot). */
  centerOf(r: FeatRef): P2 | null {
    const o = this.obj(r);
    if (o.t === "flash" || o.t === "hole") return [o.x, o.y];
    if (o.t === "slot") return [(o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2];
    if (o.t === "arc") return [o.cx, o.cy];
    return null;
  }

  /** A closed chain of tracks/arcs through this one (board outline, cut-out): area and perimeter. */
  loopOf(r: FeatRef): { area: number; length: number; pts: P2[]; feats: number[] } | null {
    const lv = this.lay(r);
    const L = lv.L;
    const start = L.objs[r.fi];
    if (start.t !== "track" && start.t !== "arc") return null;
    const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    if (!lv.loops) {
      lv.loops = new Map();
      L.objs.forEach((o, fi) => {
        if ((o.t !== "track" && o.t !== "arc") || !o.dark) return;
        if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 1e-9 && o.t === "track") return;
        for (const k of [key(o.x1, o.y1), key(o.x2, o.y2)]) (lv.loops!.get(k) ?? lv.loops!.set(k, []).get(k)!).push(fi);
      });
    }
    const used = new Set<number>([r.fi]);
    const seq: { fi: number; rev: boolean }[] = [{ fi: r.fi, rev: false }];
    const k0 = key(start.x1, start.y1);
    let end = key(start.x2, start.y2);
    if (start.t === "arc" && end === k0) { // a full circle on its own
      const { sw, r: R } = arcSweep(start.x1, start.y1, start.x2, start.y2, start.cx, start.cy, start.ccw);
      return { area: Math.PI * R * R, length: Math.abs(sw) * R, pts: tessArc(start.cx, start.cy, R, 0, 2 * Math.PI).reduce<P2[]>((a, v, i, s) => (i % 2 ? a : (a.push([v, s[i + 1]]), a)), []), feats: [r.fi] };
    }
    for (let guard = 0; guard < 200000 && end !== k0; guard++) {
      const next = (lv.loops.get(end) ?? []).find(fi => !used.has(fi));
      if (next === undefined) return null;
      used.add(next);
      const o = L.objs[next] as Extract<GObj, { t: "track" | "arc" }>;
      const rev = key(o.x1, o.y1) !== end;
      seq.push({ fi: next, rev });
      end = rev ? key(o.x1, o.y1) : key(o.x2, o.y2);
    }
    if (end !== k0) return null;
    let area = 0, length = 0;
    const pts: P2[] = [];
    for (const { fi, rev } of seq) {
      const o = L.objs[fi] as Extract<GObj, { t: "track" | "arc" }>;
      const [x1, y1, x2, y2] = rev ? [o.x2, o.y2, o.x1, o.y1] : [o.x1, o.y1, o.x2, o.y2];
      area += (x1 * y2 - x2 * y1) / 2;
      if (o.t === "arc") {
        let { a0, sw, r: R } = arcSweep(o.x1, o.y1, o.x2, o.y2, o.cx, o.cy, o.ccw);
        if (rev) { a0 += sw; sw = -sw; }
        area += (R * R / 2) * (sw - Math.sin(sw));
        length += Math.abs(sw) * R;
        const t = tessArc(o.cx, o.cy, R, a0, sw);
        for (let i = 0; i < t.length - 2; i += 2) pts.push([t[i], t[i + 1]]);
      } else { length += Math.hypot(x2 - x1, y2 - y1); pts.push([x1, y1]); }
    }
    return { area: Math.abs(area), length, pts, feats: seq.map(s => s.fi) };
  }

  /** One feature's size and metadata (the smart tool's single-click result). */
  describe(r: FeatRef): GMeasure {
    const o = this.obj(r);
    const L = this.lay(r).L;
    const f = this.feature(r);
    const rows: () => [string, string][] = () => {
      const out: [string, string][] = [];
      const ap = "ap" in o ? L.apertures[o.ap] : undefined;
      if (o.t === "flash") {
        out.push(["Centre", this.fmtPt([o.x, o.y])]);
        if (ap) out.push(["Aperture", this.apText(r)]);
        const bw = f.bb[2] - f.bb[0], bh = f.bb[3] - f.bb[1];
        out.push(["Size", `${this.fmtLen(bw, false)} × ${this.fmtLen(bh)}`]);
        if (ap) { const a = flashArea(ap); out.push(["Area", (a.exact ? "" : "≈ ") + this.fmtArea(a.area)]); }
      } else if (o.t === "track") {
        const l = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        out.push(["Width", this.fmtLen(f.prims[0]?.k === "c" ? f.prims[0].r * 2 : 0)], ["Length", this.fmtLen(l)]);
        out.push(["Angle", `${((Math.atan2(o.y2 - o.y1, o.x2 - o.x1) * 180) / Math.PI).toFixed(2)}°`]);
        out.push(["From", this.fmtPt([o.x1, o.y1])], ["To", this.fmtPt([o.x2, o.y2])], ["Aperture", this.apText(r)]);
      } else if (o.t === "arc") {
        const { sw, r: R } = arcSweep(o.x1, o.y1, o.x2, o.y2, o.cx, o.cy, o.ccw);
        out.push(["Width", this.fmtLen(f.prims[0]?.k === "c" ? f.prims[0].r * 2 : 0)], ["Radius", this.fmtLen(R)], ["Sweep", `${((Math.abs(sw) * 180) / Math.PI).toFixed(2)}°`], ["Arc length", this.fmtLen(Math.abs(sw) * R)], ["Centre", this.fmtPt([o.cx, o.cy])], ["Aperture", this.apText(r)]);
      } else if (o.t === "region") {
        let per = 0;
        for (const c of o.contours) { const p = contourPts(c); for (let i = 2; i < p.length; i += 2) per += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); }
        out.push(["Perimeter", this.fmtLen(per)], ["Size", `${this.fmtLen(f.bb[2] - f.bb[0], false)} × ${this.fmtLen(f.bb[3] - f.bb[1])}`], ["Vertices", String(o.contours.reduce((s, c) => s + c.length - 1, 0))]);
      } else if (o.t === "hole") {
        out.push(["Centre", this.fmtPt([o.x, o.y])], ["Tool", `T${o.tool}`], ["Plating", o.plated === false ? "Non-plated (NPTH)" : o.plated ? "Plated (PTH)" : "Not stated"]);
      } else if (o.t === "slot") {
        out.push(["Length", this.fmtLen(Math.hypot(o.x2 - o.x1, o.y2 - o.y1) + o.d)], ["From", this.fmtPt([o.x1, o.y1])], ["To", this.fmtPt([o.x2, o.y2])], ["Tool", `T${o.tool}`], ["Plating", o.plated === false ? "Non-plated (NPTH)" : o.plated ? "Plated (PTH)" : "Not stated"]);
      }
      const loop = (o.t === "track" || o.t === "arc") ? this.loopOf(r) : null;
      if (loop) out.push(["Closed outline", `${this.fmtArea(loop.area)}, perimeter ${this.fmtLen(loop.length)}`]);
      this.attrRows(r, out);
      return out;
    };
    let title = "", value = 0, isArea = false, text: () => string;
    const ap = "ap" in o ? L.apertures[o.ap] : undefined;
    switch (o.t) {
      case "flash": {
        const fn = ap?.attrs?.[".AperFunction"]?.split(",")[0];
        title = fn === "ViaPad" ? "Via pad" : fn === "ComponentPad" || fn === "SMDPad" ? (fn === "SMDPad" ? "SMD pad" : "Pad") : "Pad";
        if (ap?.shape === "C") { value = ap.params[0]; text = () => `Ø${this.fmtLen(value)}`; }
        else { const w = f.bb[2] - f.bb[0], h = f.bb[3] - f.bb[1]; value = Math.min(w, h); text = () => `${this.fmtLen(w, false)} × ${this.fmtLen(h)}`; }
        break;
      }
      case "track": title = "Track"; value = f.prims[0]?.k === "c" ? f.prims[0].r * 2 : 0; text = () => `w ${this.fmtLen(value)}`; break;
      case "arc": title = "Arc track"; value = f.prims[0]?.k === "c" ? f.prims[0].r * 2 : 0; text = () => `w ${this.fmtLen(value)}`; break;
      case "region": title = "Region / pour"; isArea = true; value = o.contours.reduce((s, c) => s + Math.abs(regionArea(c)), 0); text = () => this.fmtArea(value); break;
      case "hole": title = "Drill hole"; value = o.d; text = () => `Ø${this.fmtLen(value)}`; break;
      case "slot": title = "Slot"; value = o.d; text = () => `Ø${this.fmtLen(value)}`; break;
    }
    const anchor = this.centerOf(r) ?? [(f.bb[0] + f.bb[2]) / 2, (f.bb[1] + f.bb[3]) / 2];
    return { id: `g${this.nextId++}`, type: "info", title, value, isArea, pts: [anchor], feats: [r], rows, text: text!, visible: true };
  }

  /** Two features: pitch (centre to centre) when both have centres, else clearance, with both in the rows. */
  relation(a: FeatRef, b: FeatRef): GMeasure {
    const ca = this.centerOf(a), cb = this.centerOf(b);
    const g = featureGap(this.feature(a), this.feature(b));
    const da = this.describe(a), db = this.describe(b);
    const pitch = ca && cb ? Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) : null;
    const pts: P2[] = ca && cb ? [ca, cb] : [g.p, g.q];
    const value = pitch ?? g.d;
    const m: GMeasure = {
      id: `g${this.nextId++}`, type: "relation", title: pitch !== null ? "Pitch (centre to centre)" : "Clearance (edge to edge)", value, pts, legs: true,
      gap: pitch !== null && g.d > 0 ? [g.p, g.q] : undefined, feats: [a, b], visible: true,
      text: () => this.fmtLen(value),
      rows: () => {
        const out: [string, string][] = [];
        if (pitch !== null) out.push(["Centre to centre", this.fmtLen(pitch)]);
        out.push(["Clearance", g.d > 0 ? this.fmtLen(g.d) : "0 (touching or overlapping)"]);
        out.push(["ΔX", this.fmtLen(Math.abs(pts[1][0] - pts[0][0]))], ["ΔY", this.fmtLen(Math.abs(pts[1][1] - pts[0][1]))]);
        out.push(["First", `${da.title} ${da.text()}`], ["Second", `${db.title} ${db.text()}`]);
        return out;
      },
    };
    return m;
  }

  // ---------- measurements ----------

  private mkDistance(p: P2, q: P2, title = "Distance"): GMeasure {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return {
      id: `g${this.nextId++}`, type: "distance", title, value: d, pts: [p, q], legs: true, visible: true,
      text: () => this.fmtLen(d),
      rows: () => [["Distance", this.fmtLen(d)], ["ΔX", this.fmtLen(Math.abs(q[0] - p[0]))], ["ΔY", this.fmtLen(Math.abs(q[1] - p[1]))],
        ["Angle", `${((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI).toFixed(2)}°`], ["From", this.fmtPt(p)], ["To", this.fmtPt(q)]],
    };
  }

  private mkClearance(a: FeatRef, b: FeatRef): GMeasure {
    const g = featureGap(this.feature(a), this.feature(b));
    const da = this.describe(a), db = this.describe(b);
    return {
      id: `g${this.nextId++}`, type: "clearance", title: "Clearance", value: g.d, pts: [g.p, g.q], feats: [a, b], visible: true,
      text: () => this.fmtLen(g.d),
      rows: () => [["Clearance", g.d > 0 ? this.fmtLen(g.d) : "0 (touching or overlapping)"], ["ΔX", this.fmtLen(Math.abs(g.q[0] - g.p[0]))], ["ΔY", this.fmtLen(Math.abs(g.q[1] - g.p[1]))],
        ["First", `${da.title} ${da.text()}`], ["Second", `${db.title} ${db.text()}`]],
    };
  }

  private mkPolyline(pts: P2[]): GMeasure {
    let len = 0;
    const segs: number[] = [];
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(l); len += l; }
    return {
      id: `g${this.nextId++}`, type: "polyline", title: "Polyline length", value: len, pts, visible: true,
      text: () => this.fmtLen(len),
      rows: () => [["Total length", this.fmtLen(len)], ["Segments", String(segs.length)], ...segs.slice(0, 12).map((l, i) => [`Segment ${i + 1}`, this.fmtLen(l)] as [string, string])],
    };
  }

  private mkArea(pts: P2[], title = "Area", per?: number): GMeasure {
    let a = 0, p = 0;
    for (let i = 0; i < pts.length; i++) {
      const u = pts[i], v = pts[(i + 1) % pts.length];
      a += u[0] * v[1] - v[0] * u[1];
      p += Math.hypot(v[0] - u[0], v[1] - u[1]);
    }
    const area = Math.abs(a) / 2, perim = per ?? p;
    return {
      id: `g${this.nextId++}`, type: title === "Area" ? "area" : "shapeArea", title, value: area, isArea: true, pts, closed: true, visible: true,
      text: () => this.fmtArea(area),
      rows: () => [["Area", this.fmtArea(area)], ["Perimeter", this.fmtLen(perim)], ["Vertices", String(pts.length)]],
    };
  }

  /** The enclosed area of a clicked shape: a closed track outline, a region or a pad. */
  shapeArea(r: FeatRef): GMeasure | null {
    const o = this.obj(r);
    const loop = this.loopOf(r);
    if (loop) { const m = this.mkArea(loop.pts, "Enclosed area", loop.length); m.value = loop.area; m.text = () => this.fmtArea(loop.area); m.rows = () => [["Area", this.fmtArea(loop.area)], ["Perimeter", this.fmtLen(loop.length)], ["Layer", this.lay(r).L.label]]; return m; }
    if (o.t === "region" || o.t === "flash" || o.t === "hole" || o.t === "slot") {
      const d = this.describe(r);
      const f = this.feature(r);
      const ring: P2[] = [];
      const p = f.prims[0];
      if (p?.k === "p") for (let i = 0; i < p.pts.length; i += 2) ring.push([p.pts[i], p.pts[i + 1]]);
      else if (p?.k === "c") { const t = tessArc((p.ax + p.bx) / 2, (p.ay + p.by) / 2, p.r, 0, 2 * Math.PI); for (let i = 0; i < t.length - 2; i += 2) ring.push([t[i], t[i + 1]]); }
      let area = d.isArea ? d.value : 0;
      if (!d.isArea) {
        if (o.t === "flash") { const ap = this.lay(r).L.apertures[o.ap]; area = ap ? flashArea(ap).area : 0; }
        else if (o.t === "hole") area = Math.PI * (o.d / 2) ** 2;
        else if (o.t === "slot") area = Math.PI * (o.d / 2) ** 2 + o.d * Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      }
      const m = this.mkArea(ring, "Shape area");
      m.value = area;
      m.feats = [r];
      m.text = () => this.fmtArea(area);
      m.rows = () => [["Area", this.fmtArea(area)], ["Shape", `${d.title} ${d.text()}`], ["Layer", this.lay(r).L.label]];
      return m;
    }
    return null;
  }

  addMeasurement(m: GMeasure) {
    this.measurements.push(m);
    this.selected = m.id;
    this.drawOverlay();
    this.changed();
  }
  deleteMeasurement(id: string) {
    this.measurements = this.measurements.filter(m => m.id !== id);
    if (this.selected === id) this.selected = null;
    this.drawOverlay(); this.changed();
  }
  clearMeasurements() { this.measurements = []; this.selected = null; this.live = null; this.picks = []; this.drawOverlay(); this.changed(); }
  pinLive() { if (this.live) { const m = this.live; this.live = null; this.picks = []; this.addMeasurement(m); } }

  setTool(t: GTool) {
    this.tool = t;
    this.picks = [];
    if (t !== "smart") this.live = null;
    this.drawOverlay();
    this.changed();
  }

  /** Esc: drop the points in progress, then the live result, then return to Smart. */
  cancel() {
    if (this.picks.length && this.tool !== "smart") this.picks = [];
    else if (this.live || this.picks.length) { this.live = null; this.picks = []; }
    else if (this.selected) this.selected = null;
    else if (this.tool !== "smart") { this.setTool("smart"); return; }
    this.drawOverlay(); this.changed();
  }

  finish() {
    if (this.tool === "polyline" && this.picks.length >= 2) this.addMeasurement(this.mkPolyline(this.picks.map(p => p.p)));
    else if (this.tool === "area" && this.picks.length >= 3) this.addMeasurement(this.mkArea(this.picks.map(p => p.p)));
    else return;
    this.picks = [];
    this.drawOverlay();
  }

  /** A click on the board at a screen position (also the test entry point). */
  click(sx: number, sy: number, shift = false) {
    // Labels first: clicking a measurement selects it.
    const lab = this.labelRects.find(r => sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h);
    if (lab && (this.tool === "smart" || !this.picks.length)) { this.selected = lab.id; this.drawOverlay(); this.changed(); return; }
    const pk = this.snapAt(sx, sy);
    this.clickPick(pk, shift);
  }

  clickPick(pk: SnapPick, shift = false) {
    this.selected = null;
    switch (this.tool) {
      case "smart": {
        if (!pk.feat) { this.live = null; this.picks = []; break; }
        if (shift) { this.live = this.shapeArea(pk.feat); this.picks = []; break; }
        const prev = this.picks.length === 1 ? this.picks[0].feat : null;
        if (prev && !(prev.lid === pk.feat.lid && prev.fi === pk.feat.fi)) { this.live = this.relation(prev, pk.feat); this.picks = []; }
        else { this.picks = [pk]; this.live = this.describe(pk.feat); }
        break;
      }
      case "distance":
        this.picks.push(pk);
        if (this.picks.length === 2) { this.addMeasurement(this.mkDistance(this.picks[0].p, this.picks[1].p)); this.picks = []; }
        break;
      case "clearance":
        if (!pk.feat) { this.host.toast("Click a pad, track, hole or region."); break; }
        this.picks.push(pk);
        if (this.picks.length === 2) { this.addMeasurement(this.mkClearance(this.picks[0].feat!, this.picks[1].feat!)); this.picks = []; }
        break;
      case "polyline": this.picks.push(pk); break;
      case "area": {
        if (shift && pk.feat && !this.picks.length) { const m = this.shapeArea(pk.feat); if (m) this.addMeasurement(m); break; }
        const f = this.picks[0];
        if (f && this.picks.length >= 3) {
          const [a, b] = this.toScreen(f.p[0], f.p[1]), [c, d] = this.toScreen(pk.p[0], pk.p[1]);
          if (Math.hypot(a - c, b - d) < 8) { this.finish(); break; }
        }
        this.picks.push(pk);
        break;
      }
    }
    this.drawOverlay();
    this.changed();
  }

  // ---------- overlay ----------

  drawOverlay() {
    if (this.overlayQueued) return;
    this.overlayQueued = true;
    requestAnimationFrame(() => { this.overlayQueued = false; this.paintOverlay(); });
  }

  /** Draws hover/selection outlines and every measurement; synchronous (tests call it). */
  paintOverlay() {
    const c = this.over.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.over.width, this.over.height);
    // Feature outlines in board space.
    const outline = (r: FeatRef, color: string, fill?: string) => {
      const f = this.feature(r);
      if (!f) return;
      this.applyView(c);
      for (const p of f.prims) {
        const path = new Path2D(primD(p.k === "c" && p.r <= 0 ? { ...p, r: 1.5 / this.view.s } : p));
        if (fill) { c.fillStyle = fill; c.fill(path); }
        c.strokeStyle = color; c.lineWidth = 2 / this.view.s; c.stroke(path);
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
    };
    if (this.hover) outline(this.hover, "rgba(255,255,255,0.9)", "rgba(255,255,255,0.12)");
    for (const p of this.picks) if (p.feat && this.tool !== "distance" && this.tool !== "polyline" && this.tool !== "area") outline(p.feat, MCOL, "rgba(34,211,238,0.18)");
    if (this.live?.feats) for (const r of this.live.feats) outline(r, MCOL, "rgba(34,211,238,0.18)");
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.labelRects = [];
    const P = new CanvasPainter(c);
    this.paintMeasures(P, true);
    // In-progress geometry and the cursor snap.
    const sp = (b: P2) => this.toScreen(b[0], b[1]);
    if (this.picks.length && this.tool !== "smart" && this.tool !== "clearance") {
      const pts = this.picks.map(p => sp(p.p));
      if (this.snap) pts.push(sp(this.snap.p));
      if (this.tool === "area" && pts.length >= 3) P.poly(pts, true, { color: MCOL, dash: [6, 4] }, "rgba(34,211,238,0.12)");
      else P.poly(pts, false, { color: MCOL, dash: this.tool === "distance" ? undefined : [6, 4] });
      if (this.tool === "distance" && this.snap) this.paintLegs(P, this.picks[0].p, this.snap.p, false);
      for (const p of this.picks) P.dot(sp(p.p), 3.5, MCOL);
    }
    if (this.snap && this.snap.kind !== "free") this.paintSnap(c, sp(this.snap.p), this.snap.kind);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  private paintSnap(c: CanvasRenderingContext2D, p: P2, kind: SnapKind) {
    c.save();
    c.translate(p[0], p[1]);
    c.lineWidth = 2;
    c.strokeStyle = "#000";
    const col = kind === "center" ? "#22b8cf" : kind === "vertex" ? "#ff922b" : kind === "mid" ? "#51cf66" : kind === "perp" ? "#e64980" : "#ffd43b";
    c.fillStyle = col;
    c.beginPath();
    if (kind === "center") { c.arc(0, 0, 6, 0, 2 * Math.PI); c.moveTo(-9, 0); c.lineTo(9, 0); c.moveTo(0, -9); c.lineTo(0, 9); c.stroke(); c.strokeStyle = col; c.lineWidth = 1.4; c.stroke(); }
    else if (kind === "vertex") { c.rect(-5, -5, 10, 10); c.fill(); c.stroke(); }
    else if (kind === "mid") { c.moveTo(0, -6); c.lineTo(6, 5); c.lineTo(-6, 5); c.closePath(); c.fill(); c.stroke(); }
    else if (kind === "perp") { c.moveTo(-6, 6); c.lineTo(6, 6); c.moveTo(-6, 6); c.lineTo(-6, -6); c.moveTo(-6, 0); c.lineTo(0, 0); c.lineTo(0, 6); c.strokeStyle = col; c.stroke(); }
    else { c.arc(0, 0, 4.5, 0, 2 * Math.PI); c.fill(); c.stroke(); }
    c.restore();
  }

  private paintLegs(P: Painter, a: P2, b: P2, labels: boolean) {
    const sp = (x: number, y: number) => this.toScreen(x, y);
    const k: P2 = [b[0], a[1]];
    const A = sp(a[0], a[1]), K = sp(k[0], k[1]), B = sp(b[0], b[1]);
    if (Math.hypot(K[0] - A[0], K[1] - A[1]) > 2) P.line(A, K, { color: LEGX, width: 1.2, dash: [5, 4], halo: false });
    if (Math.hypot(K[0] - B[0], K[1] - B[1]) > 2) P.line(K, B, { color: LEGY, width: 1.2, dash: [5, 4], halo: false });
    if (!labels) return;
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    if (Math.hypot(K[0] - A[0], K[1] - A[1]) > 60) P.label([(A[0] + K[0]) / 2, (A[1] + K[1]) / 2], `ΔX ${this.fmtLen(dx, false)}`, LEGX, true);
    if (Math.hypot(K[0] - B[0], K[1] - B[1]) > 40) P.label([(K[0] + B[0]) / 2, (K[1] + B[1]) / 2], `ΔY ${this.fmtLen(dy, false)}`, LEGY, true);
  }

  private paintMeasures(P: Painter, recordLabels: boolean) {
    const sp = (b: P2) => this.toScreen(b[0], b[1]);
    const all = [...this.measurements.filter(m => m.visible), ...(this.live ? [this.live] : [])];
    for (const m of all) {
      const sel = m.id === this.selected || m === this.live;
      const col = sel ? "#ffffff" : MCOL;
      const width = sel ? 2.2 : 1.6;
      let at: P2;
      if (m.type === "info") at = sp(m.pts[0]);
      else if (m.closed) {
        const pts = m.pts.map(sp);
        P.poly(pts, true, { color: col, width }, "rgba(34,211,238,0.14)");
        let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; }
        at = [cx / pts.length, cy / pts.length];
      } else if (m.type === "polyline") {
        const pts = m.pts.map(sp);
        P.poly(pts, false, { color: col, width });
        for (const p of pts) P.dot(p, 3, col);
        at = pts[pts.length - 1];
        at = [at[0], at[1] - 16];
      } else {
        const [a, b] = m.pts.map(sp);
        if (m.legs) this.paintLegs(P, m.pts[0], m.pts[1], true);
        P.line(a, b, { color: col, width });
        P.dot(a, 3, col); P.dot(b, 3, col);
        if (m.gap) { const [g1, g2] = m.gap.map(sp); P.line(g1, g2, { color: "#ffd43b", width: 1.6 }); }
        at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
      const r = P.label(at, m.text(), sel ? "#ffffff" : MCOL);
      if (recordLabels) this.labelRects.push({ id: m.id, ...r });
    }
  }

  /** Live text for the cursor tooltip. */
  tipText(): string {
    const s = this.snap;
    if (!s) return "";
    const last = this.picks[this.picks.length - 1]?.p;
    if (last && (this.tool === "distance" || this.tool === "polyline" || this.tool === "area")) {
      const d = Math.hypot(s.p[0] - last[0], s.p[1] - last[1]);
      const dx = Math.abs(s.p[0] - last[0]), dy = Math.abs(s.p[1] - last[1]);
      let t = `d ${this.fmtLen(d)}\nΔX ${this.fmtLen(dx)}  ΔY ${this.fmtLen(dy)}`;
      if (this.tool === "polyline") { let L = d; for (let i = 1; i < this.picks.length; i++) L += Math.hypot(this.picks[i].p[0] - this.picks[i - 1].p[0], this.picks[i].p[1] - this.picks[i - 1].p[1]); t += `\nTotal ${this.fmtLen(L)}`; }
      if (this.tool === "area" && this.picks.length >= 2) { const m = this.mkArea([...this.picks.map(p => p.p), s.p]); t += `\nArea ${m.text()}`; this.nextId--; }
      return t;
    }
    if (this.hover) {
      const d = this.describe(this.hover);
      this.nextId--;
      const net = d.rows().find(r => r[0] === "Net")?.[1];
      return `${d.title} ${d.text()}${net ? ` · ${net}` : ""}`;
    }
    return "";
  }

  // ---------- pointer ----------

  private bindPointer() {
    const el = this.over;
    const pts = new Map<number, P2>();
    let down: { x: number; y: number; btn: number; pan: boolean; moved: boolean } | null = null;
    let pinch: { d: number; mid: P2 } | null = null;
    const local = (e: PointerEvent | MouseEvent | WheelEvent): P2 => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener("contextmenu", e => e.preventDefault());
    el.addEventListener("pointerdown", e => {
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        down = null;
        return;
      }
      down = { x: p[0], y: p[1], btn: e.button, pan: e.button === 1 || e.button === 2 || this.spaceDown, moved: false };
      if (down.pan) this.root.classList.add("panning");
    });
    el.addEventListener("pointermove", e => {
      const p = local(e);
      const prev = pts.get(e.pointerId);
      if (prev) pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.view.ox += mid[0] - pinch.mid[0]; this.view.oy += mid[1] - pinch.mid[1];
        this.zoomAt(mid[0], mid[1], d / (pinch.d || d));
        pinch = { d, mid };
        return;
      }
      if (down && prev) {
        if (!down.moved && Math.hypot(p[0] - down.x, p[1] - down.y) > 4) { down.moved = true; down.pan = true; this.root.classList.add("panning"); }
        if (down.pan && down.moved || down.pan && down.btn !== 0) {
          this.view.ox += p[0] - prev[0]; this.view.oy += p[1] - prev[1];
          this.viewChanged();
          return;
        }
      }
      this.moveTo(p[0], p[1]);
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      this.root.classList.remove("panning");
      if (down && !down.moved && down.btn === 0 && !this.spaceDown && e.type === "pointerup") { const p = local(e); this.click(p[0], p[1], e.shiftKey); }
      down = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", () => { if (!down) { this.hover = null; this.snap = null; this.tip(null); this.drawOverlay(); } });
    el.addEventListener("dblclick", e => { e.preventDefault(); if (this.tool === "polyline" || this.tool === "area") { this.picks.pop(); this.finish(); this.changed(); } });
    el.addEventListener("wheel", e => {
      e.preventDefault();
      const p = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(p[0], p[1], Math.exp(-dy * 0.0015));
    }, { passive: false });
  }

  /** Hover at a screen position: snap, highlight, tooltip, status bar. */
  moveTo(sx: number, sy: number) {
    this.cursor = [sx, sy];
    this.snap = this.snapAt(sx, sy);
    this.hover = this.snap.feat ?? null;
    if (this.tool === "distance" || this.tool === "polyline" || this.tool === "area") this.hover = null;
    const tip = this.tipText();
    this.tip(tip ? { x: sx, y: sy, text: tip } : null);
    const kindTxt: Record<SnapKind, string> = { vertex: "Corner / end", center: "Centre", mid: "Midpoint", edge: "Edge", perp: "Perpendicular", free: "" };
    this.host.status(`${this.fmtPt(this.snap.p)} ${this.unit}`, kindTxt[this.snap.kind]);
    this.drawOverlay();
  }

  private tip(t: { x: number; y: number; text: string } | null) {
    const el = this.root.querySelector<HTMLElement>("#g-tip")!;
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = t.text;
    const x = Math.min(t.x + 16, this.w - el.offsetWidth - 6), y = t.y + 18 + el.offsetHeight > this.h ? t.y - el.offsetHeight - 10 : t.y + 18;
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.key === " ") { this.spaceDown = true; this.root.classList.add("grab"); e.preventDefault(); return true; }
    if (k === "escape") { this.cancel(); return true; }
    if (k === "enter") { this.finish(); this.changed(); return true; }
    if (k === "backspace" && this.picks.length && this.tool !== "smart") { this.picks.pop(); this.drawOverlay(); this.changed(); return true; }
    if ((k === "delete" || k === "backspace") && this.selected) { this.deleteMeasurement(this.selected); return true; }
    const tools: Record<string, GTool> = { m: "distance", d: "distance", q: "smart", s: "smart", c: "clearance", l: "polyline", a: "area" };
    if (tools[k]) { this.setTool(tools[k]); return true; }
    if (k === "f") { this.fit(); return true; }
    if (k === "b") { this.setMirror(!this.view.mirror); return true; }
    if (k === "p" && this.live) { this.pinLive(); return true; }
    if (k === "+" || k === "=") { this.zoomAt(this.w / 2, this.h / 2, 1.25); return true; }
    if (k === "-") { this.zoomAt(this.w / 2, this.h / 2, 0.8); return true; }
    return false;
  }

  // ---------- layers ----------

  moveLayer(from: number, to: number) {
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.render(); this.changed();
  }
  removeLayer(i: number) {
    const id = this.layers[i].id;
    this.layers.splice(i, 1);
    const keep = (m: GMeasure) => !m.feats?.some(r => r.lid === id);
    this.measurements = this.measurements.filter(keep);
    if (this.live && !keep(this.live)) this.live = null;
    this.picks = this.picks.filter(p => !p.feat || p.feat.lid !== id);
    this.hover = null;
    this.render(); this.changed();
  }

  setLayerStyle(i: number, s: Partial<Pick<LayerView, "visible" | "color" | "opacity">>) {
    Object.assign(this.layers[i], s);
    if (s.visible === false) this.hover = null;
    this.render(); this.changed();
  }

  // ---------- stats ----------

  private layerStats(l: LayerView) {
    if (l.stats) return l.stats;
    let tracks = 0, pads = 0, holes = 0, minTrack = Infinity, minHole = Infinity;
    const sizes = new Set<number>();
    for (const o of l.L.objs) {
      if ((o.t === "track" || o.t === "arc") && l.L.kind === "copper" && o.dark) { tracks++; const w = 2 * trackRadius(l.L.apertures[o.ap]); if (w > 0) minTrack = Math.min(minTrack, w); }
      else if (o.t === "flash" && l.L.kind === "copper" && o.dark) pads++;
      else if (o.t === "hole" || o.t === "slot") { holes++; minHole = Math.min(minHole, o.d); sizes.add(Math.round(o.d * 1000)); }
    }
    return (l.stats = { tracks, pads, holes, minTrack, minHole, sizes });
  }

  stats() {
    let tracks = 0, pads = 0, holes = 0, minTrack = Infinity, minHole = Infinity;
    const sizes = new Set<number>();
    for (const l of this.layers) {
      const s = this.layerStats(l);
      tracks += s.tracks; pads += s.pads; holes += s.holes;
      minTrack = Math.min(minTrack, s.minTrack); minHole = Math.min(minHole, s.minHole);
      s.sizes.forEach(x => sizes.add(x));
    }
    const bb = this.boardBox(false);
    return { bb, tracks, pads, holes, drillSizes: sizes.size, minTrack: isFinite(minTrack) ? minTrack : null, minHole: isFinite(minHole) ? minHole : null };
  }


  // ---------- export ----------

  png() {
    const out = document.createElement("canvas");
    out.width = this.main.width; out.height = this.main.height;
    const c = out.getContext("2d")!;
    this.render();
    this.paintOverlay();
    c.drawImage(this.main, 0, 0);
    c.drawImage(this.over, 0, 0);
    out.toBlob(b => b && this.host.download(b, `${this.baseName()}.png`), "image/png");
  }

  svg(): string {
    const v = this.view, m = v.mirror ? -1 : 1;
    const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}">`, `<rect width="100%" height="100%" fill="${BG}"/>`, "<defs>"];
    const body: string[] = [];
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (!l.visible) continue;
      const g: string[] = [];
      const hasClear = l.L.batches.some(b => !b.dark);
      for (const b of l.L.batches) {
        const col = hasClear ? (b.dark ? "#fff" : "#000") : l.color;
        for (const d of b.fill) g.push(`<path d="${d}" fill="${col}"/>`);
        if (b.eo.length) g.push(`<path d="${b.eo.join("")}" fill="${col}" fill-rule="evenodd"/>`);
        if (b.hair) g.push(`<path d="${b.hair}" fill="none" stroke="${col}" stroke-width="${(1.2 / v.s).toFixed(5)}" stroke-linecap="round"/>`);
      }
      const tf = `matrix(${v.s * m} 0 0 ${-v.s} ${v.ox} ${v.oy})`;
      if (hasClear) {
        const bb = l.L.bbox;
        parts.push(`<mask id="m${l.id}" maskUnits="userSpaceOnUse" x="${bb[0]}" y="${bb[1]}" width="${bb[2] - bb[0]}" height="${bb[3] - bb[1]}">${g.join("")}</mask>`);
        body.push(`<g transform="${tf}" opacity="${l.opacity}"><rect x="${bb[0]}" y="${bb[1]}" width="${bb[2] - bb[0]}" height="${bb[3] - bb[1]}" fill="${l.color}" mask="url(#m${l.id})"/></g>`);
      } else body.push(`<g transform="${tf}" opacity="${l.opacity}"><title>${xmlEsc(l.L.label)}</title>${g.join("")}</g>`);
    }
    parts.push("</defs>", ...body);
    const P = new SvgPainter();
    this.paintMeasures(P, false);
    parts.push(...P.out, "</svg>");
    return parts.join("\n");
  }

  exportSvg() { this.host.download(new Blob([this.svg()], { type: "image/svg+xml" }), `${this.baseName()}.svg`); }

  csv(): string {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [["#", "Type", "Value", "Unit", "Details"].join(",")];
    this.measurements.forEach((m, i) => {
      const v = m.isArea ? m.value * G_UNITS[this.unit] ** 2 : m.value * G_UNITS[this.unit];
      lines.push([i + 1, q(m.title), v.toFixed(this.decimals), m.isArea ? `${this.unit}2` : this.unit, q(m.rows().map(r => `${r[0]}: ${r[1]}`).join("; "))].join(","));
    });
    return lines.join("\n") + "\n";
  }

  private baseName() { return (this.name || "pcb").replace(/\.[^.]+$/, ""); }
}
