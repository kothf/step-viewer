import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { PartData, TreeNode, V3 } from "../topology";

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type DisplayMode = "shadedEdges" | "shaded" | "wireframe" | "hlr" | "xray";

export interface Part {
  idx: number;
  data: PartData;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  edges: LineSegments2;
  material: THREE.MeshStandardMaterial;
  edgeMaterial: LineMaterial;
  triFace: Uint32Array;
  baseColor: THREE.Color;
  visible: boolean;
  opacity: number;
  path: string;
  /** Explode direction at factor 1, and manual drag offset. */
  explodeVec: THREE.Vector3;
  userOffset: THREE.Vector3;
  center: THREE.Vector3;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly modelRoot = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  parts: Part[] = [];
  tree: TreeNode | null = null;
  mode: DisplayMode = "shadedEdges";
  /** Section planes shared by every model material (see Section.ts). */
  clipPlanes: THREE.Plane[] = [];
  bounds = new THREE.Box3();
  aoEnabled = false;
  edgeColor = new THREE.Color(0x111418);

  private dirty = true;
  private anim: ((t: number) => boolean) | null = null;
  private headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  private composer: EffectComposer;
  private gtao: GTAOPass;
  private renderPass: RenderPass;
  private listeners: (() => void)[] = [];
  private resizeObs: ResizeObserver;
  readonly size = new THREE.Vector2(1, 1);

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.01, 1e7);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.persp.position.set(200, -300, 200);
    this.camera = this.persp;

    this.makeEnvironment();
    this.scene.environmentIntensity = 0.55;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 0.6));
    this.scene.add(this.headlight, this.headlight.target);
    this.scene.add(this.modelRoot, this.overlay);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => this.invalidate());
    // The orbit controls also update from their own pointer handlers: every update goes through the pivot (FR-UI-100).
    const update = this.controls.update.bind(this.controls);
    this.controls.update = (dt?: number | null) => {
      const cam = this.controls.object;
      const q0 = this.pivot && !this.anim ? cam.quaternion.clone() : null;
      const moved = update(dt);
      if (q0 && moved) this.turnAboutPivot(q0);
      return moved;
    };
    // A drag or wheel zoom starts from a camera Previous view can return to.
    this.controls.addEventListener("start", () => { const now = performance.now(); if (now - this.lastStart > 600) this.pushView(); this.lastStart = now; });

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, stencilBuffer: true });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(t => this.tick(t));
    // A lost WebGL context (GPU reset, driver hiccup, too much GPU memory) leaves the canvas blank while the HTML
    // labels stay. three.js restores its own state, but the environment map is rendered on the GPU and the view only
    // draws when invalidated, so both are redone here; until then the page says what happened.
    const cv = this.renderer.domElement;
    cv.addEventListener("webglcontextlost", () => { this.contextLost = true; for (const f of this.contextListeners) f(true); });
    cv.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.makeEnvironment();
      this.resize();
      this.invalidate();
      for (const f of this.contextListeners) f(false);
    });
  }

  /** True while the WebGL context is lost (the view is blank until the browser gives it back). */
  contextLost = false;
  private contextListeners: ((lost: boolean) => void)[] = [];
  /** Called when the WebGL context is lost (true) and when it comes back (false). */
  onContext(fn: (lost: boolean) => void) { this.contextListeners.push(fn); }

  private makeEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const old = this.scene.environment;
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    old?.dispose();
    pmrem.dispose();
  }

  onRender(fn: () => void) { this.listeners.push(fn); }

  /** World size of one screen pixel at a point, for the current camera. */
  pxWorld(p: THREE.Vector3) {
    const cam = this.camera;
    if (cam instanceof THREE.OrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / this.size.y;
    const depth = this.pxTmp.copy(p).applyMatrix4(cam.matrixWorldInverse).z;
    return (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * Math.abs(depth)) / this.size.y;
  }
  private pxTmp = new THREE.Vector3();
  invalidate() { this.dirty = true; }
  private hookFailed = false;
  /** Called each frame after the camera settles, before drawing (screen-sized overlays). */
  readonly beforeRender: (() => void)[] = [];

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.size.set(w, h);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    for (const p of this.parts) p.edgeMaterial.resolution.set(w, h);
    this.overlay.traverse(o => { const m = (o as any).material; if (m instanceof LineMaterial) m.resolution.set(w, h); });
    this.invalidate();
  }

  private updateOrthoFrustum() {
    const dist = this.ortho.position.distanceTo(this.controls?.target ?? new THREE.Vector3());
    const h = this.orthoHeight ?? dist * 2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const a = this.size.x / this.size.y;
    this.ortho.left = (-h * a) / 2; this.ortho.right = (h * a) / 2;
    this.ortho.top = h / 2; this.ortho.bottom = -h / 2;
    this.ortho.updateProjectionMatrix();
  }
  private orthoHeight: number | null = null;

  private tick(t: number) {
    if (this.anim && !this.anim(t)) this.anim = null;
    const moved = this.controls.update();
    if (!this.dirty && !this.anim && !moved) return;
    this.dirty = false;
    this.updateClipRange();
    this.headlight.position.copy(this.camera.position);
    this.headlight.target.position.copy(this.controls.target);
    // One failing hook must not stop the view from drawing (exam bug 40: a closed part's hook froze the assembly's view).
    for (const fn of this.beforeRender) { try { fn(); } catch (err) { if (!this.hookFailed) { this.hookFailed = true; console.error(err); } } }
    this.render();
    for (const fn of this.listeners) fn();
  }

  /** Tight near/far from the model bounds keeps depth precision (and edge polygon offset) good. */
  private updateClipRange() {
    const s = this.bounds.getBoundingSphere(new THREE.Sphere());
    const d = this.camera.position.distanceTo(s.center);
    const r = Math.max(s.radius, 1e-3) * 4;
    this.persp.near = Math.max(d - r, r * 1e-4);
    this.persp.far = d + r;
    this.persp.updateProjectionMatrix();
    this.ortho.near = d - r; this.ortho.far = d + r;
    this.ortho.updateProjectionMatrix();
  }

  render() {
    const useAO = this.aoEnabled && this.clipPlanes.length === 0 && this.mode !== "xray" && this.mode !== "wireframe";
    if (useAO) {
      this.renderPass.camera = this.camera;
      this.gtao.camera = this.camera;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ---------- model ----------

  clear() {
    for (const p of this.parts) {
      p.mesh.geometry.disposeBoundsTree();
      p.mesh.geometry.dispose();
      p.material.dispose();
      p.edges.geometry.dispose();
      p.edgeMaterial.dispose();
    }
    this.modelRoot.clear();
    this.overlay.clear();
    this.parts = [];
    this.tree = null;
  }

  load(partsData: PartData[], tree: TreeNode, fit = true) {
    this.clear();
    this.tree = tree;
    const paths = new Map<number, string>();
    const walk = (n: TreeNode, path: string) => {
      const p = path ? `${path} / ${n.name}` : n.name;
      n.parts.forEach(i => paths.set(i, p));
      n.children.forEach(c => walk(c, p));
    };
    walk(tree, "");

    partsData.forEach((data, idx) => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      if (data.colors) geom.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
      geom.setIndex(new THREE.BufferAttribute(data.index, 1));
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      // Indirect keeps the index buffer in B-rep face order (triangle -> face lookups rely on it).
      geom.computeBoundsTree({ indirect: true } as Parameters<typeof geom.computeBoundsTree>[0]);

      const baseColor = new THREE.Color().setRGB(...data.color, THREE.SRGBColorSpace);
      const material = new THREE.MeshStandardMaterial({
        color: data.colors ? 0xffffff : baseColor, vertexColors: !!data.colors,
        metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geom, material as THREE.Material);
      mesh.renderOrder = 1000; // after section caps (Section.ts)
      mesh.userData.partIdx = idx;

      const eg = new LineSegmentsGeometry();
      eg.setPositions(data.edgeSegs.length ? data.edgeSegs : new Float32Array(6));
      const edgeMaterial = new LineMaterial({ color: this.edgeColor.getHex(), linewidth: 1.3, worldUnits: false });
      edgeMaterial.resolution.set(this.size.x, this.size.y);
      const edges = new LineSegments2(eg, edgeMaterial);
      edges.renderOrder = 1001;
      edges.visible = data.edgeSegs.length > 0;
      edges.raycast = () => {};

      const group = new THREE.Group();
      group.name = data.name;
      group.add(mesh, edges);
      this.modelRoot.add(group);

      const triFace = new Uint32Array(data.index.length / 3);
      for (const f of data.faces) triFace.fill(f.id, f.triStart, f.triStart + f.triCount);
      const center = new THREE.Vector3(...data.bboxMin).add(new THREE.Vector3(...data.bboxMax)).multiplyScalar(0.5);

      this.parts.push({
        idx, data, group, mesh, edges, material, edgeMaterial, triFace, baseColor,
        visible: true, opacity: 1, path: paths.get(idx) ?? data.name,
        explodeVec: new THREE.Vector3(), userOffset: new THREE.Vector3(), center,
      });
    });
    this.computeBounds();
    this.computeExplodeVectors();
    this.setMode(this.mode);
    if (fit) { this.fit(false); this.views = []; this.setPivot(null); }
  }

  /** Half size of the box the view fits when nothing is shown (a new part: 50 mm). */
  emptySize = 1;

  computeBounds() {
    this.bounds.makeEmpty();
    for (const p of this.parts) if (p.visible) this.bounds.expandByObject(p.mesh);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1, -1, -1).multiplyScalar(this.emptySize), new THREE.Vector3(1, 1, 1).multiplyScalar(this.emptySize));
    return this.bounds;
  }

  get modelSize() { return this.bounds.getSize(new THREE.Vector3()).length() || 1; }

  // ---------- display ----------

  setMode(mode: DisplayMode) {
    this.mode = mode;
    for (const p of this.parts) this.applyPartAppearance(p);
    this.invalidate();
  }

  applyPartAppearance(p: Part) {
    const m = p.material;
    const xray = this.mode === "xray";
    const op = xray ? Math.min(0.22, p.opacity) : p.opacity;
    m.transparent = op < 1;
    m.opacity = op;
    m.depthWrite = op >= 1;
    m.colorWrite = this.mode !== "hlr";
    m.clippingPlanes = this.clipPlanes;
    p.mesh.visible = p.visible && this.mode !== "wireframe";
    p.edges.visible = p.visible && this.mode !== "shaded" && p.data.edgeSegs.length > 0;
    p.edgeMaterial.clippingPlanes = this.clipPlanes;
    p.edgeMaterial.color.copy(xray ? new THREE.Color(0x5a6b85) : this.edgeColor);
    p.edgeMaterial.opacity = xray ? 0.6 : 1;
    p.edgeMaterial.transparent = xray;
    m.needsUpdate = true;
    p.edgeMaterial.needsUpdate = true;
    // A surface analysis wears its own material: keep it clipped like the part's.
    const am = p.mesh.material;
    if (am !== m) { am.clippingPlanes = this.clipPlanes; am.needsUpdate = true; }
  }

  setEdgeColor(c: THREE.ColorRepresentation) {
    this.edgeColor.set(c);
    for (const p of this.parts) this.applyPartAppearance(p);
    this.invalidate();
  }

  setProjection(kind: "perspective" | "orthographic") {
    const from = this.camera;
    const to = kind === "orthographic" ? this.ortho : this.persp;
    if (from === to) return;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    if (to === this.ortho) {
      const dist = from.position.distanceTo(this.controls.target);
      this.orthoHeight = dist * 2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    } else {
      const h = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const dist = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      const dir = from.position.clone().sub(this.controls.target).normalize();
      to.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.orthoHeight = null;
    }
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.invalidate();
  }

  // ---------- camera ----------

  fit(animate = true, box?: THREE.Box3) {
    const b = box && !box.isEmpty() ? box : this.computeBounds();
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(1, -1, 0.8);
    dir.normalize();
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    this.animateTo(sphere.center, sphere.center.clone().addScaledVector(dir, dist), animate, sphere.radius * 2.2);
  }

  /** View direction = vector from target toward the camera. */
  viewFrom(dir: THREE.Vector3, animate = true, extra?: THREE.Box3 | null) {
    const d = dir.clone().normalize();
    if (Math.abs(d.z) > 0.9999) d.y -= 1e-4;
    const b = this.computeBounds().clone();
    if (extra && !extra.isEmpty()) b.union(extra);
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    this.animateTo(sphere.center, sphere.center.clone().addScaledVector(d.normalize(), dist), animate, sphere.radius * 2.2);
  }

  // ---------- view navigation (FRS 13.13: FR-UI-102/103) ----------

  /** Height of the view at the target, in world units. */
  viewHeight() {
    if (this.camera === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
    return this.camera.position.distanceTo(this.controls.target) * 2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
  }

  /** Turns the view about the target: `h` about the world up axis, `v` about the screen's horizontal axis (degrees). */
  rotateView(h: number, v: number, animate = true) {
    const end = this.viewEnd(), tgt = end.t;
    const r = end.p.clone().sub(tgt);
    const up = THREE.Object3D.DEFAULT_UP;
    r.applyAxisAngle(up, THREE.MathUtils.degToRad(-h));
    if (v) {
      // Over the top stops just short of the pole (the orbit keeps Z up). A positive turn about
      // up × r lowers the camera, so the turn is kept between the two poles. Looking straight down
      // or up (Top, Bottom) up × r is zero: the screen's right axis tilts the view instead.
      const right = new THREE.Vector3().crossVectors(up, r);
      if (right.lengthSq() < 1e-12 * r.lengthSq()) right.setFromMatrixColumn(this.camera.matrixWorld, 0).projectOnPlane(up);
      if (right.lengthSq() > 1e-12) {
        right.normalize();
        const polar = r.angleTo(up), lim = 1e-3;
        r.applyAxisAngle(right, THREE.MathUtils.clamp(THREE.MathUtils.degToRad(v), lim - polar, Math.PI - lim - polar));
      }
    }
    this.animateTo(tgt, tgt.clone().add(r), animate, end.h);
  }

  /** Moves the view by fractions of its height (x right, y up). */
  panView(fx: number, fy: number, animate = true) {
    const end = this.viewEnd(), h = end.h;
    // Screen axes of the camera at the end of any running move.
    const look = end.t.clone().sub(end.p).normalize();
    const camUp = this.camera.up.clone();
    const right = new THREE.Vector3().crossVectors(look, camUp);
    if (right.lengthSq() < 1e-12) right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.normalize();
    const upv = new THREE.Vector3().crossVectors(right, look).normalize();
    const d = right.multiplyScalar(-fx * h).addScaledVector(upv, -fy * h);
    this.animateTo(end.t.clone().add(d), end.p.clone().add(d), animate, h);
  }

  /** Zooms about the view centre: factor < 1 zooms in. */
  zoomView(factor: number, animate = true) {
    const end = this.viewEnd(), tgt = end.t;
    const r = end.p.clone().sub(tgt);
    const pos = this.camera === this.ortho ? end.p : tgt.clone().addScaledVector(r, factor);
    this.animateTo(tgt, pos, animate, end.h * factor);
  }

  /** Frames a screen rectangle (canvas pixels): Zoom to area. */
  zoomToRect(x0: number, y0: number, x1: number, y1: number) {
    const w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
    if (w < 4 || hh < 4) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const cam = this.camera, tgt = this.controls.target.clone();
    const ndc = new THREE.Vector2((cx / this.size.x) * 2 - 1, -(cy / this.size.y) * 2 + 1);
    this.raycaster.setFromCamera(ndc, cam);
    const n = cam.getWorldDirection(new THREE.Vector3());
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, tgt), new THREE.Vector3()) ?? tgt;
    const f = Math.max(w / this.size.x, hh / this.size.y);
    const r = cam.position.clone().sub(tgt);
    const pos = cam === this.ortho ? hit.clone().add(r) : hit.clone().addScaledVector(r, f);
    this.animateTo(hit, pos, true, this.viewHeight() * f);
  }

  private lastStart = -1e9;
  /** Forgets earlier cameras (a new model). */
  clearViews() { this.views = []; }

  /**
   * Rotation centre (FR-UI-100): orbiting turns about this point instead of the view centre. The orbit controls
   * still turn about their target; each frame the turn R they made is moved over to the pivot P by shifting
   * camera and target by (I − R)(P − T), which is exactly the difference between the two rotations.
   */
  pivot: THREE.Vector3 | null = null;
  private pivotMark: THREE.Sprite | null = null;

  setPivot(p: THREE.Vector3 | null) {
    this.pivot = p ? p.clone() : null;
    if (!p) { if (this.pivotMark) { this.scene.remove(this.pivotMark); this.pivotMark.material.map?.dispose(); this.pivotMark.material.dispose(); this.pivotMark = null; } this.invalidate(); return; }
    if (!this.pivotMark) {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      const ring = (w: number, col: string) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(32, 32, 18, 0, Math.PI * 2); g.moveTo(32, 4); g.lineTo(32, 60); g.moveTo(4, 32); g.lineTo(60, 32); g.stroke(); };
      ring(9, "rgba(255,255,255,0.9)");
      ring(4, "#0b6bcb");
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.pivotMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
      this.pivotMark.scale.set(0.045, 0.045, 1);
      this.pivotMark.renderOrder = 999;
      this.pivotMark.userData.pivot = true;
      this.scene.add(this.pivotMark);
    }
    this.pivotMark.position.copy(p);
    this.invalidate();
  }

  private turnAboutPivot(q0: THREE.Quaternion) {
    const R = this.camera.quaternion.clone().multiply(q0.invert());
    if (Math.abs(R.w) > 1 - 1e-12) return;
    const d = this.pivot!.clone().sub(this.controls.target);
    const shift = d.clone().sub(d.clone().applyQuaternion(R));
    this.controls.target.add(shift);
    this.camera.position.add(shift);
  }
  /** Earlier cameras for Previous view, newest last. */
  private views: { t: THREE.Vector3; p: THREE.Vector3; h: number }[] = [];
  /** Remembers the current camera (before a command or a drag moves it). */
  pushView() {
    const v = { t: this.controls.target.clone(), p: this.camera.position.clone(), h: this.viewHeight() };
    const last = this.views.at(-1);
    if (last && last.t.distanceTo(v.t) < 1e-9 && last.p.distanceTo(v.p) < 1e-9 && Math.abs(last.h - v.h) < 1e-9) return;
    this.views.push(v);
    if (this.views.length > 20) this.views.shift();
  }
  /** The camera as a named view stores it (FR-UI-104): where it will be once a running move ends. */
  getView(): { t: [number, number, number]; p: [number, number, number]; h: number } {
    const v = this.viewEnd();
    return { t: v.t.toArray(), p: v.p.toArray(), h: v.h };
  }
  /** Goes to a stored camera (Previous view comes back from it). */
  setView(v: { t: [number, number, number]; p: [number, number, number]; h: number }, animate = true) {
    this.animateTo(new THREE.Vector3(...v.t), new THREE.Vector3(...v.p), animate, v.h);
  }
  /** A camera move is still running. */
  get animating() { return !!this.anim; }
  get canGoBack() { return this.views.length > 0; }
  /** Previous view: back to the camera before the last view change. */
  previousView() {
    const v = this.views.pop();
    if (!v) return false;
    this.animateTo(v.t, v.p, true, v.h, false);
    return true;
  }

  /** Where the running camera move ends: a key pressed meanwhile turns/pans/zooms from there, not from mid-flight. */
  private animEnd: { t: THREE.Vector3; p: THREE.Vector3; h: number } | null = null;
  /** The camera as it will be once the running move ends (now when none runs). */
  private viewEnd() {
    if (this.anim && this.animEnd) return { t: this.animEnd.t.clone(), p: this.animEnd.p.clone(), h: this.animEnd.h };
    return { t: this.controls.target.clone(), p: this.camera.position.clone(), h: this.viewHeight() };
  }

  private animateTo(target: THREE.Vector3, pos: THREE.Vector3, animate: boolean, orthoH: number, remember = true) {
    if (remember) this.pushView();
    this.animEnd = { t: target.clone(), p: pos.clone(), h: orthoH };
    // Reduced motion: camera changes apply in one frame.
    if (animate && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) animate = false;
    const cam = this.camera;
    const t0 = this.controls.target.clone(), p0 = cam.position.clone();
    const h0 = cam === this.ortho ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom : orthoH;
    const r0 = p0.clone().sub(t0), r1 = pos.clone().sub(target);
    const len0 = r0.length(), len1 = r1.length();
    const q = new THREE.Quaternion().setFromUnitVectors(r0.clone().normalize(), r1.clone().normalize());
    const apply = (k: number) => {
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const tgt = t0.clone().lerp(target, e);
      const qi = new THREE.Quaternion().slerp(q, e);
      const r = r0.clone().normalize().applyQuaternion(qi).multiplyScalar(THREE.MathUtils.lerp(len0, len1, e));
      this.controls.target.copy(tgt);
      cam.position.copy(tgt).add(r);
      if (cam === this.ortho) {
        this.orthoHeight = THREE.MathUtils.lerp(h0, orthoH, e);
        this.ortho.zoom = 1;
        this.updateOrthoFrustum();
      }
      cam.lookAt(tgt);
      this.invalidate();
    };
    if (!animate) { apply(1); return; }
    let start = -1;
    this.anim = t => {
      if (start < 0) start = t;
      const k = Math.min(1, (t - start) / 300);
      apply(k);
      return k < 1;
    };
  }

  // ---------- picking ----------

  readonly raycaster = new THREE.Raycaster();

  pickMeshes(ndc: THREE.Vector2) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.parts.filter(p => p.visible).map(p => p.mesh);
    (this.raycaster as any).firstHitOnly = this.clipPlanes.length === 0;
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.find(h => this.clipPlanes.every(pl => pl.distanceToPoint(h.point) >= -1e-6)) ?? null;
  }

  partOf(obj: THREE.Object3D) { return this.parts[obj.userData.partIdx as number]; }

  toWorld(p: Part, v: V3 | THREE.Vector3) {
    const w = Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
    return w.add(p.group.position);
  }

  // ---------- explode ----------

  explodeFactor = 0;

  computeExplodeVectors() {
    if (!this.tree) return;
    const centerOf = (n: TreeNode): THREE.Vector3 | null => {
      const b = new THREE.Box3();
      const add = (m: TreeNode) => { m.parts.forEach(i => { const d = this.parts[i].data; b.expandByPoint(new THREE.Vector3(...d.bboxMin)); b.expandByPoint(new THREE.Vector3(...d.bboxMax)); }); m.children.forEach(add); };
      add(n);
      return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
    };
    const walk = (n: TreeNode, acc: THREE.Vector3, parentCenter: THREE.Vector3) => {
      const c = centerOf(n) ?? parentCenter;
      const here = acc.clone().add(c.clone().sub(parentCenter));
      for (const i of n.parts) this.parts[i].explodeVec.copy(here).add(this.parts[i].center.clone().sub(c));
      for (const ch of n.children) walk(ch, here, c);
    };
    const root = centerOf(this.tree) ?? new THREE.Vector3();
    walk(this.tree, new THREE.Vector3(), root);
  }

  setExplode(f: number) {
    this.explodeFactor = f;
    this.updatePartPositions();
  }

  updatePartPositions() {
    for (const p of this.parts) p.group.position.copy(p.explodeVec).multiplyScalar(this.explodeFactor * 1.2).add(p.userOffset);
    this.modelRoot.updateMatrixWorld(true);
    this.invalidate();
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    this.clear();
    this.renderer.dispose();
  }
}
