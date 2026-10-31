// 3D board built from the loaded Gerber / Excellon set: the outline extruded to the
// board thickness with its cut-outs and drilled holes, copper, solder mask and
// silkscreen as textured skins on both sides, and plated barrels in the holes.
// The GerberView keeps doing the picking, snapping and measuring in board
// millimetres; this class only maps board points to the screen and back
// through the 3D camera (on the face the camera looks at).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { tessArc } from "./build";
import { pointInPoly, type P2 } from "./geom";
import type { GerberView, LayerView } from "./GerberView";
import { defaultStyle } from "./load";

const BG = 0x0b0e13;
/** Physical colours used in 3D unless the user picked a colour for the layer. */
const PRESET = { copper: "#b87333", mask: "#0c4f2b", silk: "#f0f0ea", core: "#9c8a55", barrel: "#b87333" };
/** Height of each skin above the bare core surface (mm). */
const LIFT = { copper: 0.035, mask: 0.05, silk: 0.062 };
/** The plane the measurements are picked and drawn on, above the top skin. */
const FACE = 0.07;
/** Holes cut into the geometry; beyond this they are only cut out of the skins. */
const MAX_CUT_HOLES = 4000;

interface Hole { x1: number; y1: number; x2: number; y2: number; r: number; plated: boolean | null; lid: number }

export interface Board3DInfo {
  /** Board area after cut-outs and holes (mm²). */
  area: number;
  thickness: number;
  holes: number;
  cutHoles: number;
  cutouts: number;
  outline: boolean;
  skins: number;
  barrels: number;
}

export class Board3D {
  thickness = 1.6;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e5);
  readonly controls: OrbitControls;
  info: Board3DInfo | null = null;
  /** Bounds the textures cover: [x0, y0, x1, y1]. */
  private bb: [number, number, number, number] = [0, 0, 1, 1];
  private board = new THREE.Group();
  private skins = new Map<number, THREE.Mesh>();
  private barrels = new Map<number, THREE.InstancedMesh>();
  private textures = new Map<number, { key: string; tex: THREE.CanvasTexture }>();
  private holes: Hole[] = [];
  private dirty = true;
  /** The board body as built: outline, cut-outs and the holes cut into it. */
  private body: { outer: number[]; cutouts: number[][]; holes: number[][] } | null = null;
  private queued = false;
  private fitted = false;
  private w = 1;
  private h = 1;
  private ray = new THREE.Raycaster();
  private lastBottom = false;

  constructor(readonly canvas: HTMLCanvasElement, overlay: HTMLElement, private onView: () => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(BG);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303844, 0.55));
    const head = new THREE.DirectionalLight(0xffffff, 1.1);
    head.position.set(0.3, 0.4, 1);
    this.camera.add(head);
    this.scene.add(this.camera, this.board);
    this.camera.up.set(0, 0, 1);
    // Same feel as the STEP view: left orbits, middle/right pans, wheel zooms to the cursor.
    this.controls = new OrbitControls(this.camera, overlay);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.enabled = false;
    this.controls.addEventListener("change", () => { this.invalidate(); this.onView(); });
  }

  set enabled(on: boolean) { this.controls.enabled = on; if (on) this.invalidate(); }

  markDirty() { this.dirty = true; }

  resize(w: number, h: number) {
    this.w = Math.max(1, w); this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`;
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.controls.enabled) return;
      const moving = this.controls.update();
      this.renderNow();
      if (moving) this.invalidate();
    });
  }

  renderNow() { this.renderer.render(this.scene, this.camera); }

  // ---------- building ----------

  /** Rebuilds geometry when the layer set or thickness changed, then syncs colours and visibility. */
  sync(g: GerberView) {
    if (this.dirty) this.build(g);
    const t = this.thickness;
    const order: Record<string, number> = {};
    for (const lv of g.layers) {
      const mesh = this.skins.get(lv.id);
      if (mesh) {
        const kind = lv.L.kind as "copper" | "mask" | "silk";
        const side = lv.L.side === "bottom" ? -1 : 1;
        const k = `${kind}:${side}`;
        const n = (order[k] = (order[k] ?? -1) + 1);
        mesh.position.z = side * (t / 2 + LIFT[kind] + n * 0.002);
        mesh.visible = lv.visible;
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.color.set(this.colorOf(lv));
        if (lv.visible) {
          const tex = this.texture(g, lv);
          if (m.alphaMap !== tex) { m.alphaMap = tex; m.needsUpdate = true; }
        }
      }
      const b = this.barrels.get(lv.id);
      if (b) b.visible = lv.visible;
    }
    this.syncBottom();
    this.invalidate();
  }

  private colorOf(lv: LayerView) {
    const custom = lv.color.toLowerCase() !== defaultStyle(lv.L.kind, lv.L.side).color.toLowerCase();
    if (custom) return lv.color;
    return lv.L.kind === "copper" ? PRESET.copper : lv.L.kind === "mask" ? PRESET.mask : PRESET.silk;
  }

  private build(g: GerberView) {
    this.dirty = false;
    for (const o of [...this.board.children]) {
      this.board.remove(o);
      o.traverse(c => { const m = c as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    }
    this.skins.clear(); this.barrels.clear();
    this.body = null;
    this.info = null;
    if (!g.layers.length) return;
    const t = this.thickness;

    // Outline: closed chains on the outline layer; the largest is the board, the rest inside it are cut-outs.
    const loops = this.outlineLoops(g);
    let outer: number[] | null = null, outerA = 0;
    for (const l of loops) { const a = Math.abs(areaOf(l)); if (a > outerA) { outerA = a; outer = l; } }
    const box = g.boardBox(false);
    if (!box) return;
    const hasOutline = !!outer && outerA > 1e-3;
    if (!hasOutline) outer = [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]];
    const cutouts = hasOutline ? loops.filter(l => l !== outer && pointInPoly(l[0], l[1], outer!) && Math.abs(areaOf(l)) < outerA) : [];
    const ob = boxOf(outer!);
    this.bb = [ob[0], ob[1], ob[2], ob[3]];

    // Holes from every drill layer that sit on the board, without overlaps (the triangulator needs simple holes).
    this.holes = [];
    for (const lv of g.layers) {
      if (lv.L.kind !== "drill") continue;
      for (const o of lv.L.objs) {
        if (o.t === "hole") this.holes.push({ x1: o.x, y1: o.y, x2: o.x, y2: o.y, r: o.d / 2, plated: o.plated, lid: lv.id });
        else if (o.t === "slot") this.holes.push({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, r: o.d / 2, plated: o.plated, lid: lv.id });
      }
    }
    const inside = (x: number, y: number) => pointInPoly(x, y, outer!) && !cutouts.some(c => pointInPoly(x, y, c));
    const cut: Hole[] = [];
    if (this.holes.length <= MAX_CUT_HOLES) {
      const cell = 2, grid = new Map<string, Hole[]>();
      const cells = (h: Hole) => { const out: string[] = []; for (let i = Math.floor((Math.min(h.x1, h.x2) - h.r) / cell); i <= Math.floor((Math.max(h.x1, h.x2) + h.r) / cell); i++) for (let j = Math.floor((Math.min(h.y1, h.y2) - h.r) / cell); j <= Math.floor((Math.max(h.y1, h.y2) + h.r) / cell); j++) out.push(`${i},${j}`); return out; };
      for (const h of this.holes) {
        if (h.r <= 0 || !inside(h.x1, h.y1) || !inside(h.x2, h.y2)) continue;
        // Keep a small web of board between the hole and the outline.
        const pts = holePts(h);
        if (!pts.every((v, i) => i % 2 || inside(v, pts[i + 1]))) continue;
        const cs = cells(h);
        if (cs.some(c => grid.get(c)?.some(o => capsuleGap(h, o) < 0.01))) continue;
        for (const c of cs) (grid.get(c) ?? grid.set(c, []).get(c)!).push(h);
        cut.push(h);
      }
    }

    this.body = { outer: outer!, cutouts, holes: cut.map(holePts) };
    const shape = new THREE.Shape(v2(outer!));
    for (const c of cutouts) shape.holes.push(new THREE.Path(v2(c)));
    for (const h of cut) shape.holes.push(new THREE.Path(v2(holePts(h))));
    const geo = new THREE.ShapeGeometry(shape, 1);
    const pos = geo.getAttribute("position");
    const uv = new Float32Array(pos.count * 2);
    const [x0, y0, x1, y1] = this.bb, W = x1 - x0 || 1, H = y1 - y0 || 1;
    for (let i = 0; i < pos.count; i++) { uv[2 * i] = (pos.getX(i) - x0) / W; uv[2 * i + 1] = (pos.getY(i) - y0) / H; }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));

    // Core: both faces and the walls of every contour.
    const coreMat = new THREE.MeshStandardMaterial({ color: PRESET.core, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    for (const s of [1, -1]) { const cap = new THREE.Mesh(geo, coreMat); cap.position.z = (s * t) / 2; this.board.add(cap); }
    const walls = wallGeo([outer!, ...cutouts, ...cut.map(holePts)], t);
    this.board.add(new THREE.Mesh(walls, new THREE.MeshStandardMaterial({ color: PRESET.core, roughness: 0.75, metalness: 0, side: THREE.DoubleSide })));

    // Skins: one textured copy of the board face per copper / mask / silk layer on the outside.
    let skins = 0;
    for (const lv of g.layers) {
      const k = lv.L.kind;
      if ((k !== "copper" && k !== "mask" && k !== "silk") || lv.L.side === "inner") continue;
      const common = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - skins, polygonOffsetUnits: -1 - skins };
      const mat = k === "copper" ? new THREE.MeshStandardMaterial({ ...common, metalness: 0.55, roughness: 0.4, alphaTest: 0.5 })
        : k === "mask" ? new THREE.MeshStandardMaterial({ ...common, metalness: 0, roughness: 0.4, transparent: true, opacity: 0.9, depthWrite: false })
        : new THREE.MeshStandardMaterial({ ...common, metalness: 0, roughness: 0.85, alphaTest: 0.5 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = k === "mask" ? 2 : 1;
      mesh.name = `${k}:${lv.L.side}`;
      this.skins.set(lv.id, mesh);
      this.board.add(mesh);
      skins++;
    }

    // Plated barrels (plating not stated counts as plated, the usual case for a PTH file).
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true).rotateX(Math.PI / 2);
    const barrelMat = new THREE.MeshStandardMaterial({ color: PRESET.barrel, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide });
    const byLayer = new Map<number, Hole[]>();
    for (const h of cut) if (h.plated !== false && h.x1 === h.x2 && h.y1 === h.y2) (byLayer.get(h.lid) ?? byLayer.set(h.lid, []).get(h.lid)!).push(h);
    let barrels = 0;
    const m4 = new THREE.Matrix4();
    for (const [lid, hs] of byLayer) {
      const im = new THREE.InstancedMesh(cyl, barrelMat, hs.length);
      hs.forEach((h, i) => im.setMatrixAt(i, m4.makeScale(h.r, h.r, t + 2 * LIFT.copper).setPosition(h.x1, h.y1, 0)));
      im.instanceMatrix.needsUpdate = true;
      this.barrels.set(lid, im);
      this.board.add(im);
      barrels += hs.length;
    }

    let area = outerA || (box[2] - box[0]) * (box[3] - box[1]);
    for (const c of cutouts) area -= Math.abs(areaOf(c));
    for (const h of cut) area -= Math.abs(areaOf(holePts(h)));
    this.info = { area, thickness: t, holes: this.holes.length, cutHoles: cut.length, cutouts: cutouts.length, outline: hasOutline, skins, barrels };
    // Drop textures of layers that are gone, and redraw the rest (the hole set may have changed).
    for (const [id, e] of this.textures) { e.tex.dispose(); this.textures.delete(id); }
    if (!this.fitted) { this.fitted = true; this.fit(); }
  }

  private outlineLoops(g: GerberView): number[][] {
    const out: number[][] = [];
    for (const lv of g.layers) {
      if (lv.L.kind !== "outline") continue;
      const used = new Set<number>();
      const objs = lv.L.objs;
      if (objs.length > 50000) continue;
      objs.forEach((o, fi) => {
        if (o.t === "region" && o.dark) { for (const c of o.contours) if (c.length >= 3) out.push(contour(c)); return; }
        if ((o.t !== "track" && o.t !== "arc") || used.has(fi)) return;
        const loop = g.loopOf({ lid: lv.id, fi });
        if (!loop) { used.add(fi); return; }
        for (const f of loop.feats) used.add(f);
        if (loop.pts.length >= 3) out.push(loop.pts.flat());
      });
    }
    return out;
  }

  /** A white alpha mask of the layer in board space, with the drilled holes cut out. */
  private texture(g: GerberView, lv: LayerView): THREE.CanvasTexture {
    const key = `${this.bb.join()}:${this.holes.length}`;
    const hit = this.textures.get(lv.id);
    if (hit && hit.key === key) return hit.tex;
    hit?.tex.dispose();
    const [x0, y0, x1, y1] = this.bb, W = x1 - x0 || 1, H = y1 - y0 || 1;
    const coarse = matchMedia?.("(pointer: coarse)").matches;
    const maxSide = Math.min(this.renderer.capabilities.maxTextureSize, coarse ? 2048 : 4096);
    const ppm = Math.min(maxSide / Math.max(W, H), 40);
    const cw = Math.max(2, Math.round(W * ppm)), ch = Math.max(2, Math.round(H * ppm));
    const draw = document.createElement("canvas");
    draw.width = cw; draw.height = ch;
    const c = draw.getContext("2d")!;
    const toBoard = (cx: CanvasRenderingContext2D) => cx.setTransform(cw / W, 0, 0, -ch / H, (-x0 * cw) / W, (y1 * ch) / H);
    toBoard(c);
    c.fillStyle = "#fff"; c.strokeStyle = "#fff";
    c.lineWidth = 1.5 / ppm; c.lineCap = "round"; c.lineJoin = "round";
    for (const p of g.layerPaths(lv)) {
      c.globalCompositeOperation = p.dark ? "source-over" : "destination-out";
      for (const f of p.fill) c.fill(f);
      if (p.eo) c.fill(p.eo, "evenodd");
      if (p.hair) c.stroke(p.hair);
    }
    let canvas = draw;
    if (lv.L.kind === "mask") {
      // Mask files draw the openings: the mask is everywhere else.
      canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const m = canvas.getContext("2d")!;
      m.fillStyle = "#fff"; m.fillRect(0, 0, cw, ch);
      m.globalCompositeOperation = "destination-out";
      m.drawImage(draw, 0, 0);
    }
    const hc = canvas.getContext("2d")!;
    toBoard(hc);
    hc.globalCompositeOperation = "destination-out";
    hc.fillStyle = "#000";
    for (const h of this.holes) {
      hc.beginPath();
      if (h.x1 === h.x2 && h.y1 === h.y2) hc.arc(h.x1, h.y1, h.r, 0, 2 * Math.PI);
      else { const p = holePts(h); hc.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) hc.lineTo(p[i], p[i + 1]); hc.closePath(); }
      hc.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.colorSpace = THREE.NoColorSpace;
    this.textures.set(lv.id, { key, tex });
    return tex;
  }

  /** Builds the geometry now if the layer set or thickness changed. */
  ensureBuilt(g: GerberView) { if (this.dirty) this.build(g); return !!this.body; }

  /**
   * The board body as an OpenCASCADE-style mesh (one B-rep face per top, bottom,
   * straight wall run, rounded wall run and hole) for the 3D model view and its tools.
   */
  bodyMesh(name: string, color: number[]) {
    if (!this.body) return null;
    const t = this.thickness, z0 = -t / 2, z1 = t / 2;
    const P: number[] = [], N: number[] = [], I: number[] = [];
    const faces: { first: number; last: number; color: null }[] = [];
    let tri = 0;
    const face = (fn: () => void) => { const first = tri; fn(); if (tri > first) faces.push({ first, last: tri - 1, color: null }); };
    const vert = (x: number, y: number, z: number, n: number[]) => { P.push(x, y, z); N.push(n[0], n[1], n[2]); return P.length / 3 - 1; };
    const ccwPts = (pts: number[], ccw: boolean) => (areaOf(pts) > 0) === ccw ? pts : rev(pts);
    const outer = ccwPts(this.body.outer, true);
    const inner = [...this.body.cutouts, ...this.body.holes].map(c => ccwPts(c, false));
    const tris = THREE.ShapeUtils.triangulateShape(v2(outer), inner.map(v2));
    const flat = [...outer, ...inner.flat()];
    for (const zs of [z1, z0]) face(() => {
      const up = zs > 0, n = [0, 0, up ? 1 : -1];
      for (const [a, b, c] of tris) {
        const ar = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
        const order = (ar > 0) === up ? [a, b, c] : [a, c, b];
        for (const k of order) I.push(vert(flat[2 * k], flat[2 * k + 1], zs, n));
        tri++;
      }
    });
    // Walls: outward is to the right of travel (outer CCW, inner CW); split into faces at sharp corners.
    [outer, ...inner].forEach(c => {
      const n = c.length / 2;
      const dir = (i: number) => { const j = (i + 1) % n; const dx = c[2 * j] - c[2 * i], dy = c[2 * j + 1] - c[2 * i + 1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
      // Faces break at sharp corners and where a straight run meets a curved one (a tangent arc).
      const turn = (i: number) => { const a = dir((i - 1 + n) % n), b = dir(i); return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))); };
      const len = (i: number) => { const j = (i + 1) % n; return Math.hypot(c[2 * j] - c[2 * i], c[2 * j + 1] - c[2 * i + 1]) || 1e-9; };
      const curv = (i: number) => (turn(i) + turn((i + 1) % n)) / (2 * len(i));
      const breaks = Array.from({ length: n }, (_, i) => {
        if (turn(i) > (20 * Math.PI) / 180) return true;
        const a = curv((i - 1 + n) % n), b = curv(i), lo = Math.min(a, b), hi = Math.max(a, b);
        return hi > 1e-6 && hi > 3 * lo + 1e-9;
      });
      let start = breaks.indexOf(true);
      if (start < 0) start = 0;
      let k = 0;
      while (k < n) {
        face(() => {
          do {
            const i = (start + k) % n, j = (i + 1) % n;
            const d = dir(i), nn = [d[1], -d[0], 0];
            const ax = c[2 * i], ay = c[2 * i + 1], bx = c[2 * j], by = c[2 * j + 1];
            const v = [vert(ax, ay, z0, nn), vert(bx, by, z0, nn), vert(bx, by, z1, nn), vert(ax, ay, z1, nn)];
            I.push(v[0], v[1], v[2], v[0], v[2], v[3]);
            tri += 2;
            k++;
          } while (k < n && !breaks[(start + k) % n]);
        });
      }
    });
    return { name, color, brep_faces: faces, attributes: { position: { array: P }, normal: { array: N } }, index: { array: I } };
  }

  // ---------- camera ----------

  get bottom() { return this.camera.position.z < this.controls.target.z; }

  private syncBottom() { this.lastBottom = this.bottom; }
  /** True once after the camera crossed to the other side of the board. */
  sideChanged() { const b = this.bottom; if (b === this.lastBottom) return false; this.lastBottom = b; return true; }

  /** Frames the board, tilted, from the side the camera is on (or the given one). */
  fit(bottom = this.bottom) {
    const [x0, y0, x1, y1] = this.bb;
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
    const r = Math.max(Math.hypot(x1 - x0, y1 - y0) / 2, 1);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = (r / Math.sin(fit / 2)) * 1.05;
    const dir = new THREE.Vector3(0, -0.55, bottom ? -1 : 1).normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = dist / 200; this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.lastBottom = bottom;
    this.invalidate();
    this.onView();
  }

  setBottom(on: boolean) { if (on !== this.bottom) this.fit(on); }

  dolly(k: number) {
    const t = this.controls.target, p = this.camera.position;
    p.sub(t).multiplyScalar(1 / k).add(t);
    this.controls.update();
    this.invalidate();
    this.onView();
  }

  /** Z of the face the camera looks at: picks and measurements live there. */
  faceZ() { return (this.bottom ? -1 : 1) * (this.thickness / 2 + FACE); }

  toScreen(x: number, y: number): P2 {
    const v = new THREE.Vector3(x, y, this.faceZ()).project(this.camera);
    if (v.z > 1) return [-1e5, -1e5];
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h];
  }

  toBoard(sx: number, sy: number): P2 {
    this.ray.setFromCamera(new THREE.Vector2((sx / this.w) * 2 - 1, 1 - (sy / this.h) * 2), this.camera);
    const hit = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.faceZ()), new THREE.Vector3());
    return hit ? [hit.x, hit.y] : [NaN, NaN];
  }

  /** Screen pixels per board millimetre around a board point. */
  scaleAt(q: P2) {
    const a = this.toScreen(q[0], q[1]), b = this.toScreen(q[0] + 1, q[1]), c = this.toScreen(q[0], q[1] + 1);
    const s = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - a[0], c[1] - a[1])) / 2;
    return isFinite(s) && s > 1e-6 ? s : 1;
  }
}

// ---------- helpers ----------

const v2 = (pts: number[]) => { const out: THREE.Vector2[] = []; for (let i = 0; i < pts.length; i += 2) out.push(new THREE.Vector2(pts[i], pts[i + 1])); return out; };

function rev(pts: number[]) { const out: number[] = []; for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]); return out; }

function areaOf(pts: number[]) {
  let a = 0;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) a += (pts[j] * pts[i + 1] - pts[i] * pts[j + 1]) / 2;
  return a;
}

function boxOf(pts: number[]) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 2) { b[0] = Math.min(b[0], pts[i]); b[1] = Math.min(b[1], pts[i + 1]); b[2] = Math.max(b[2], pts[i]); b[3] = Math.max(b[3], pts[i + 1]); }
  return b;
}

function contour(c: { x: number; y: number; arc?: { cx: number; cy: number; ccw: boolean } }[]): number[] {
  const out: number[] = [c[0].x, c[0].y];
  for (let i = 1; i < c.length; i++) {
    const v = c[i], p = c[i - 1];
    if (v.arc) {
      const a0 = Math.atan2(p.y - v.arc.cy, p.x - v.arc.cx);
      let sw = Math.atan2(v.y - v.arc.cy, v.x - v.arc.cx) - a0;
      if (v.arc.ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
      tessArc(v.arc.cx, v.arc.cy, Math.hypot(p.x - v.arc.cx, p.y - v.arc.cy), a0, sw, out, true);
    } else out.push(v.x, v.y);
  }
  // Drop the closing duplicate.
  if (out.length > 4 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 1e-9) out.length -= 2;
  return out;
}

/** A drilled hole or slot as a polygon (segment count from its size). */
function holePts(h: Hole): number[] {
  const n = Math.max(12, Math.min(48, Math.ceil((2 * Math.PI * h.r) / 0.12)));
  const out: number[] = [];
  if (h.x1 === h.x2 && h.y1 === h.y2) { for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push(h.x1 + h.r * Math.cos(a), h.y1 + h.r * Math.sin(a)); } return out; }
  const ang = Math.atan2(h.y2 - h.y1, h.x2 - h.x1), m = Math.ceil(n / 2);
  for (let i = 0; i <= m; i++) { const a = ang - Math.PI / 2 + (Math.PI * i) / m; out.push(h.x2 + h.r * Math.cos(a), h.y2 + h.r * Math.sin(a)); }
  for (let i = 0; i <= m; i++) { const a = ang + Math.PI / 2 + (Math.PI * i) / m; out.push(h.x1 + h.r * Math.cos(a), h.y1 + h.r * Math.sin(a)); }
  return out;
}

/** Edge-to-edge gap between two holes/slots (negative when they overlap). */
function capsuleGap(a: Hole, b: Hole) {
  const seg = (px: number, py: number, h: Hole) => {
    const dx = h.x2 - h.x1, dy = h.y2 - h.y1, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - h.x1) * dx + (py - h.y1) * dy) / l2)) : 0;
    return Math.hypot(px - (h.x1 + t * dx), py - (h.y1 + t * dy));
  };
  const d = Math.min(seg(a.x1, a.y1, b), seg(a.x2, a.y2, b), seg(b.x1, b.y1, a), seg(b.x2, b.y2, a));
  return d - a.r - b.r;
}

/** Vertical walls along closed contours from -t/2 to t/2, smooth across shallow corners. */
function wallGeo(contours: number[][], t: number) {
  const pos: number[] = [], nor: number[] = [];
  const z0 = -t / 2, z1 = t / 2;
  for (const c of contours) {
    const n = c.length / 2;
    if (n < 3) continue;
    const segN: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, dx = c[2 * j] - c[2 * i], dy = c[2 * j + 1] - c[2 * i + 1], l = Math.hypot(dx, dy) || 1;
      segN.push([dy / l, -dx / l]);
    }
    const vn = (seg: number, vert: number): [number, number] => {
      const other = vert === seg ? (seg - 1 + n) % n : (seg + 1) % n;
      const a = segN[seg], b = segN[other];
      if (a[0] * b[0] + a[1] * b[1] < 0.85) return a;
      const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = c[2 * i], ay = c[2 * i + 1], bx = c[2 * j], by = c[2 * j + 1];
      const na = vn(i, i), nb = vn(i, j);
      pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
      nor.push(na[0], na[1], 0, nb[0], nb[1], 0, nb[0], nb[1], 0, na[0], na[1], 0, nb[0], nb[1], 0, na[0], na[1], 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
