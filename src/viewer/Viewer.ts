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

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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
  }

  onRender(fn: () => void) { this.listeners.push(fn); }
  invalidate() { this.dirty = true; }

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

  load(partsData: PartData[], tree: TreeNode) {
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
    this.fit(false);
  }

  computeBounds() {
    this.bounds.makeEmpty();
    for (const p of this.parts) if (p.visible) this.bounds.expandByObject(p.mesh);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
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
  viewFrom(dir: THREE.Vector3, animate = true) {
    const d = dir.clone().normalize();
    if (Math.abs(d.z) > 0.9999) d.y -= 1e-4;
    const b = this.computeBounds();
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    this.animateTo(sphere.center, sphere.center.clone().addScaledVector(d.normalize(), dist), animate, sphere.radius * 2.2);
  }

  private animateTo(target: THREE.Vector3, pos: THREE.Vector3, animate: boolean, orthoH: number) {
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
      const k = Math.min(1, (t - start) / 450);
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
