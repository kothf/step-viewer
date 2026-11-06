import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "./Viewer";
import { computeSection, type SectionResult } from "./SectionProfile";

export const MAX_PLANES = 3;

export interface SectionPlane {
  id: string;
  label: string;
  plane: THREE.Plane;
  /** Unit normal before flip; offset is measured along it. */
  axis: THREE.Vector3;
  offset: number;
  flipped: boolean;
  enabled: boolean;
  result: SectionResult | null;
  /** Where the plane was picked (a face click); the sheet and drag arrows sit there instead of at the model centre. */
  anchor?: THREE.Vector3;
}

/** Caps, profiles and other overlays render before the model (caps) or after it. */
const MODEL_ORDER = 1000;

/**
 * Multi-plane section with solid caps. Caps use the stencil parity trick: for a
 * closed solid, pixels where the cut face is visible see an odd number of
 * remaining surfaces, so back faces increment and front faces decrement the
 * stencil, and the cap quad is drawn where the result is non-zero. Coloured
 * caps per part repeat that per part. Profiles (the cut curves) are computed on
 * the CPU and drawn on top; they also feed the snapper.
 */
export class SectionManager {
  planes: SectionPlane[] = [];
  capsEnabled = true;
  hatch = true;
  capsByPart = false;
  showProfiles = true;
  capColor = new THREE.Color(0xd4553f);
  profileColor = new THREE.Color(0xffd43b);
  /** Plane being edited: "translate" shows the plane with two drag arrows, "rotate" the rings. */
  active: SectionPlane | null = null;
  gizmoMode: "translate" | "rotate" | null = null;
  onChange: (() => void) | null = null;
  onDragging: ((on: boolean) => void) | null = null;

  private capObjects: THREE.Object3D[] = [];
  private capMeshes: { mesh: THREE.Mesh; sp: SectionPlane }[] = [];
  private profileRoot = new THREE.Group();
  private pivot = new THREE.Object3D();
  private planeHelper: THREE.Mesh;
  private gizmo: TransformControls | null = null;
  private hatchTex: THREE.CanvasTexture;
  private profileQueued = false;
  /** Two arrows along the normal at the plane's centre, sized in screen pixels. */
  private arrows = new THREE.Group();
  private arrowMats: THREE.MeshBasicMaterial[] = [];
  private hot = -1;
  private drag: { pointer: number; offset: number; s0: number; origin: THREE.Vector3; y0: number } | null = null;

  constructor(private viewer: Viewer) {
    viewer.scene.add(this.profileRoot, this.pivot);
    this.planeHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(this.planeHelper.geometry), new THREE.LineBasicMaterial({ color: 0x3d8bfd }));
    this.planeHelper.add(border);
    this.planeHelper.raycast = () => {};
    this.planeHelper.renderOrder = MODEL_ORDER + 5;
    this.planeHelper.visible = false;
    this.pivot.add(this.planeHelper);
    this.hatchTex = makeHatchTexture();
    this.buildArrows();
  }

  get canAdd() { return this.planes.length < MAX_PLANES; }

  add(label: string, axis: THREE.Vector3, offset: number, anchor?: THREE.Vector3) {
    if (!this.canAdd) return null;
    const sp: SectionPlane = {
      id: Math.random().toString(36).slice(2, 8),
      label, axis: axis.clone().normalize(), offset, flipped: false, enabled: true,
      plane: new THREE.Plane(), result: null, anchor: anchor?.clone(),
    };
    this.planes.push(sp);
    this.syncPlane(sp);
    this.rebuild();
    // A new plane comes up ready to drag, like a section view in CAD.
    this.setGizmo(sp, "translate");
    return sp;
  }

  /** Plane through three points; the normal faces the camera's side. */
  addFromPoints(pts: THREE.Vector3[]) {
    const n = new THREE.Vector3().crossVectors(pts[1].clone().sub(pts[0]), pts[2].clone().sub(pts[0]));
    if (n.lengthSq() < 1e-18) return null;
    n.normalize();
    if (n.dot(this.viewer.camera.position.clone().sub(pts[0])) < 0) n.negate();
    return this.add("3-point", n, n.dot(pts[0]));
  }

  remove(sp: SectionPlane) {
    if (this.active === sp) this.setGizmo(null, null);
    this.planes = this.planes.filter(p => p !== sp);
    this.rebuild();
  }

  clear() { this.setGizmo(null, null); this.planes = []; this.rebuild(); }

  /** Keeps material clipping arrays in step with the enabled planes and rebuilds caps. */
  rebuild() {
    const v = this.viewer;
    for (const o of this.capObjects) o.removeFromParent();
    this.capObjects = [];
    this.capMeshes = [];
    const active = this.planes.filter(p => p.enabled);
    v.clipPlanes = active.map(p => p.plane);
    for (const p of v.parts) v.applyPartAppearance(p);

    const solids = v.parts.filter(p => p.visible && p.data.closed);
    if (this.capsEnabled && v.mode !== "wireframe" && solids.length) {
      // One stencil pass + cap per part (coloured caps) or one for the whole model.
      const groups = this.capsByPart && solids.length * active.length < MODEL_ORDER - 10
        ? solids.map(p => ({ parts: [p], color: p.baseColor })) : [{ parts: solids, color: this.capColor }];
      const size = v.modelSize * 4;
      let order = 1;
      for (const sp of active) {
        for (const g of groups) {
          for (const part of g.parts) {
            for (const [side, op] of [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]] as const) {
              const mat = new THREE.MeshBasicMaterial({
                side, clippingPlanes: [sp.plane],
                depthWrite: false, depthTest: false, colorWrite: false,
                stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
                stencilFail: op, stencilZFail: op, stencilZPass: op,
              });
              const m = new THREE.Mesh(part.mesh.geometry, mat);
              m.renderOrder = order;
              m.raycast = () => {};
              part.group.add(m);
              this.capObjects.push(m);
            }
          }
          const capMat = new THREE.MeshStandardMaterial({
            color: g.color, metalness: 0.05, roughness: 0.8, side: THREE.DoubleSide,
            map: this.hatch ? this.hatchTex : null,
            clippingPlanes: active.filter(p => p !== sp).map(p => p.plane),
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
            stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
          });
          const geo = new THREE.PlaneGeometry(size, size);
          const repeat = size / (v.modelSize / 70);
          const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
          for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * repeat, uv.getY(i) * repeat);
          const cap = new THREE.Mesh(geo, capMat);
          cap.renderOrder = order + 0.5;
          cap.raycast = () => {};
          cap.onAfterRender = r => r.clearStencil();
          v.scene.add(cap);
          this.capObjects.push(cap);
          this.capMeshes.push({ mesh: cap, sp });
          order++;
        }
      }
    }
    this.syncCaps();
    this.updateProfiles();
    v.invalidate();
  }

  setOffset(sp: SectionPlane, offset: number) { sp.offset = offset; this.planeMoved(sp); }

  /** Normal from azimuth (around Z from +X) and elevation (from the XY plane), degrees; keeps the plane through its current centre point. */
  setAngles(sp: SectionPlane, azDeg: number, elDeg: number) {
    const through = this.centerOn(sp);
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
    sp.axis.set(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).normalize();
    sp.offset = sp.axis.dot(through);
    this.planeMoved(sp);
  }

  angles(sp: SectionPlane) {
    const a = sp.axis;
    return { az: THREE.MathUtils.radToDeg(Math.atan2(a.y, a.x)), el: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(a.z, -1, 1))) };
  }

  flip(sp: SectionPlane) { sp.flipped = !sp.flipped; this.planeMoved(sp); }
  setEnabled(sp: SectionPlane, on: boolean) { sp.enabled = on; this.rebuild(); }
  setCaps(on: boolean) { this.capsEnabled = on; this.rebuild(); }
  setCapColor(c: string) { this.capColor.set(c); this.rebuild(); }
  setHatch(on: boolean) { this.hatch = on; this.rebuild(); }
  setCapsByPart(on: boolean) { this.capsByPart = on; this.rebuild(); }
  setProfiles(on: boolean) { this.showProfiles = on; this.updateProfiles(); this.viewer.invalidate(); }
  setProfileColor(c: string) { this.profileColor.set(c); this.updateProfiles(); this.viewer.invalidate(); }

  /** Offset range along the plane axis covering the model. */
  range(sp: SectionPlane): [number, number] {
    const b = this.viewer.computeBounds();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      const d = c.dot(sp.axis);
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return [lo, hi];
  }

  /** Profiles of the enabled planes, for snapping. */
  profiles() {
    return this.planes.filter(p => p.enabled && p.result).flatMap(p => p.result!.profiles.map(r => ({ sp: p, ...r })));
  }

  // ---------- gizmo ----------

  /** After switching perspective/orthographic. */
  updateCamera() { if (this.gizmo) this.gizmo.camera = this.viewer.camera; }

  setGizmo(sp: SectionPlane | null, mode: "translate" | "rotate" | null) {
    this.endDrag();
    if (!sp || !mode || (this.active === sp && this.gizmoMode === mode)) {
      this.active = null; this.gizmoMode = null;
      this.disposeRings();
      this.planeHelper.visible = false;
      this.arrows.visible = false;
      this.setHot(-1);
      this.viewer.invalidate();
      return;
    }
    this.active = sp; this.gizmoMode = mode;
    if (mode === "rotate") {
      if (!this.gizmo) {
        const g = new TransformControls(this.viewer.camera, this.viewer.renderer.domElement);
        g.setSpace("local");
        g.setSize(0.9);
        g.addEventListener("dragging-changed", (e: any) => { this.viewer.controls.enabled = !e.value; this.onDragging?.(e.value); });
        g.addEventListener("objectChange", () => this.fromPivot());
        g.addEventListener("change", () => this.viewer.invalidate());
        this.viewer.scene.add(g.getHelper());
        this.gizmo = g;
      }
      this.gizmo.camera = this.viewer.camera;
      this.gizmo.setMode("rotate");
      this.gizmo.showZ = false;
    } else {
      this.disposeRings();
    }
    this.placePivot(sp);
    if (this.gizmo) this.gizmo.attach(this.pivot);
    const s = this.viewer.modelSize * 0.9;
    this.planeHelper.scale.set(s, s, 1);
    this.planeHelper.visible = true;
    this.arrows.visible = mode === "translate";
    this.viewer.invalidate();
  }

  private disposeRings() {
    if (!this.gizmo) return;
    this.gizmo.detach(); this.viewer.scene.remove(this.gizmo.getHelper()); this.gizmo.dispose(); this.gizmo = null;
  }

  // ---------- drag arrows ----------

  /** Arrow geometry in CSS pixels: shaft from the plane outwards, cone at the tip. Scaled each frame to stay the same size on screen. */
  private static readonly ARROW = { gap: 6, shaft: 66, head: 26, r: 2.8, headR: 9.5, hitPx: 14 };

  private buildArrows() {
    const A = SectionManager.ARROW;
    for (const sign of [1, -1]) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
      this.arrowMats.push(mat);
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(A.r, A.r, A.shaft, 12), mat);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = A.gap + A.shaft / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(A.headR, A.head, 24), mat);
      head.rotation.x = Math.PI / 2;
      head.position.z = A.gap + A.shaft + A.head / 2;
      for (const m of [shaft, head]) { m.renderOrder = MODEL_ORDER + 20; m.raycast = () => {}; g.add(m); }
      if (sign < 0) g.rotation.x = Math.PI;
      this.arrows.add(g);
    }
    this.arrows.visible = false;
    this.pivot.add(this.arrows);
    this.viewer.beforeRender.push(() => {
      if (!this.arrows.visible) return;
      const k = this.viewer.pxWorld(this.pivot.position);
      this.arrows.scale.setScalar(k);
      this.arrows.updateMatrixWorld(true);
    });
    const el = this.viewer.renderer.domElement;
    // Capture phase so a press on an arrow never reaches the orbit controls or the picker.
    el.addEventListener("pointerdown", e => this.onDown(e), { capture: true });
    el.addEventListener("pointermove", e => this.onMove(e), { capture: true });
    el.addEventListener("pointerup", e => this.onUp(e), { capture: true });
    el.addEventListener("pointercancel", e => this.onUp(e), { capture: true });
    el.addEventListener("pointerleave", () => { if (!this.drag) this.setHot(-1); });
  }

  /** Screen position (CSS px, canvas-relative) of a point on arrow i (0 = along the normal, 1 = against it), t from 0 (base) to 1 (tip). */
  arrowScreen(i: number, t = 0.7) {
    const A = SectionManager.ARROW;
    const c = this.pivot.position;
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pivot.quaternion);
    const len = (A.gap + (A.shaft + A.head) * t) * this.viewer.pxWorld(c) * (i === 0 ? 1 : -1);
    return this.toScreen(c.clone().addScaledVector(n, len));
  }

  private toScreen(p: THREE.Vector3) {
    const v = p.clone().project(this.viewer.camera);
    return new THREE.Vector2((v.x + 1) / 2 * this.viewer.size.x, (1 - v.y) / 2 * this.viewer.size.y);
  }

  private local(e: PointerEvent) {
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  /** Index of the arrow under the pointer, or -1. Tested in screen space against each arrow's projected segment. */
  private hitArrow(m: THREE.Vector2) {
    if (!this.arrows.visible || !this.active) return -1;
    let best = -1, bestD = SectionManager.ARROW.hitPx;
    for (const i of [0, 1]) {
      const a = this.arrowScreen(i, 0), b = this.arrowScreen(i, 1);
      const ab = b.clone().sub(a), l2 = ab.lengthSq();
      const t = l2 > 1e-9 ? THREE.MathUtils.clamp(m.clone().sub(a).dot(ab) / l2, 0, 1) : 0;
      const d = a.addScaledVector(ab, t).distanceTo(m);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** The pointer is over (or dragging) a drag arrow, so hover snapping should stand aside. */
  get arrowHot() { return this.hot >= 0 || this.drag !== null; }

  private setHot(i: number) {
    if (i === this.hot) return;
    this.hot = i;
    this.arrowMats.forEach((m, k) => m.color.set(k === i ? 0xffa21f : 0x1f6feb));
    const el = this.viewer.renderer.domElement;
    el.style.cursor = this.drag ? "grabbing" : i >= 0 ? "grab" : "";
    this.viewer.invalidate();
  }

  /** Position along the plane axis (through origin) closest to the pointer's ray. */
  private axisParam(m: THREE.Vector2, origin: THREE.Vector3, axis: THREE.Vector3) {
    const ndc = new THREE.Vector2(m.x / this.viewer.size.x * 2 - 1, -(m.y / this.viewer.size.y) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    const r = ray.ray.direction, w = ray.ray.origin.clone().sub(origin);
    const b = r.dot(axis), den = 1 - b * b;
    if (den < 4e-3) return null; // looking straight down the normal
    return (axis.dot(w) - b * r.dot(w)) / den;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.active || this.gizmoMode !== "translate") return;
    const m = this.local(e);
    const i = this.hitArrow(m);
    if (i < 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const sp = this.active;
    const origin = this.pivot.position.clone();
    this.drag = { pointer: e.pointerId, offset: sp.offset, s0: this.axisParam(m, origin, sp.axis) ?? 0, origin, y0: m.y };
    this.viewer.renderer.domElement.setPointerCapture?.(e.pointerId);
    this.viewer.controls.enabled = false;
    this.hot = -2; this.setHot(i);
    this.onDragging?.(true);
  }

  private onMove(e: PointerEvent) {
    const m = this.local(e);
    if (!this.drag) { if (this.gizmoMode === "translate" && e.buttons === 0) this.setHot(this.hitArrow(m)); return; }
    if (e.pointerId !== this.drag.pointer || !this.active) return;
    e.stopImmediatePropagation();
    const sp = this.active, d = this.drag;
    const s = this.axisParam(m, d.origin, sp.axis);
    if (s === null) {
      // Looking along the normal the arrows have no length on screen: up/down moves the plane instead.
      this.setOffset(sp, sp.offset + (d.y0 - m.y) * this.viewer.pxWorld(d.origin));
      d.s0 = NaN;
    } else if (Number.isNaN(d.s0)) {
      d.s0 = s; d.offset = sp.offset;
    } else {
      this.setOffset(sp, d.offset + s - d.s0);
    }
    d.y0 = m.y;
    this.onChange?.();
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    e.stopImmediatePropagation();
    this.endDrag();
    this.setHot(this.hitArrow(this.local(e)));
  }

  private endDrag() {
    if (!this.drag) return;
    const el = this.viewer.renderer.domElement;
    if (el.hasPointerCapture?.(this.drag.pointer)) el.releasePointerCapture(this.drag.pointer);
    this.drag = null;
    this.viewer.controls.enabled = true;
    el.style.cursor = "";
    this.hot = -2; this.setHot(-1);
    this.onDragging?.(false);
  }

  private centerOn(sp: SectionPlane) {
    const c = sp.anchor ? sp.anchor.clone() : this.viewer.computeBounds().getCenter(new THREE.Vector3());
    return c.addScaledVector(sp.axis, sp.offset - sp.axis.dot(c));
  }

  private placePivot(sp: SectionPlane) {
    this.pivot.position.copy(this.centerOn(sp));
    this.pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sp.axis);
    this.pivot.updateMatrixWorld(true);
  }

  private fromPivot() {
    const sp = this.active;
    if (!sp) return;
    sp.axis.set(0, 0, 1).applyQuaternion(this.pivot.quaternion).normalize();
    sp.offset = sp.axis.dot(this.pivot.position);
    this.syncPlane(sp);
    this.syncCaps();
    this.queueProfiles();
    this.viewer.invalidate();
    this.onChange?.();
  }

  // ---------- internals ----------

  private planeMoved(sp: SectionPlane) {
    this.syncPlane(sp);
    this.syncCaps();
    if (this.active === sp) this.placePivot(sp);
    this.queueProfiles();
    this.viewer.invalidate();
  }

  private syncPlane(sp: SectionPlane) {
    // Three.js keeps the positive side; by default we keep material behind the plane (axis·p <= offset).
    sp.plane.normal.copy(sp.axis).multiplyScalar(sp.flipped ? 1 : -1);
    sp.plane.constant = sp.flipped ? -sp.offset : sp.offset;
  }

  private syncCaps() {
    const o = new THREE.Vector3();
    for (const { mesh, sp } of this.capMeshes) {
      sp.plane.coplanarPoint(o);
      // Centre the quad on the model so the hatch does not swim while dragging.
      const c = this.viewer.computeBounds().getCenter(new THREE.Vector3());
      o.copy(c).addScaledVector(sp.plane.normal, -sp.plane.distanceToPoint(c));
      mesh.position.copy(o);
      mesh.lookAt(o.clone().sub(sp.plane.normal));
    }
  }

  private queueProfiles() {
    if (this.profileQueued) return;
    this.profileQueued = true;
    requestAnimationFrame(() => { this.profileQueued = false; this.updateProfiles(); this.onChange?.(); });
  }

  /** Recomputes the cut curves of every enabled plane and redraws them. */
  updateProfiles() {
    for (const o of [...this.profileRoot.children]) {
      o.removeFromParent();
      const x = o as any; x.geometry?.dispose(); x.material?.dispose();
    }
    const v = this.viewer;
    const active = this.planes.filter(p => p.enabled);
    for (const sp of this.planes) sp.result = null;
    for (const sp of active) {
      const others = active.filter(p => p !== sp).map(p => p.plane);
      sp.result = computeSection(v, sp.plane, others);
      if (!this.showProfiles) continue;
      for (const [part, segs] of sp.result.segs) {
        const g = new LineSegmentsGeometry().setPositions(segs);
        const mat = new LineMaterial({ color: this.profileColor.getHex(), linewidth: 2.2, clippingPlanes: others });
        mat.resolution.copy(v.size);
        const l = new LineSegments2(g, mat);
        l.position.copy(part.group.position);
        l.renderOrder = MODEL_ORDER + 2;
        l.raycast = () => {};
        this.profileRoot.add(l);
      }
    }
  }
}

/** ANSI31: 45° lines, equally spaced; tiles seamlessly. White ground so the material colour shows through. */
function makeHatchTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = "rgba(0,0,0,0.55)";
  g.lineWidth = 3;
  for (const k of [-1, 0, 1]) {
    g.beginPath();
    g.moveTo(k * 64, 64);
    g.lineTo(k * 64 + 64, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
