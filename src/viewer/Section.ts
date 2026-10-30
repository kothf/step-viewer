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
  /** Plane being edited with the gizmo. */
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

  constructor(private viewer: Viewer) {
    viewer.scene.add(this.profileRoot, this.pivot);
    this.planeHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(this.planeHelper.geometry), new THREE.LineBasicMaterial({ color: 0x3d8bfd }));
    this.planeHelper.add(border);
    this.planeHelper.raycast = () => {};
    this.planeHelper.renderOrder = MODEL_ORDER + 5;
    this.planeHelper.visible = false;
    this.pivot.add(this.planeHelper);
    this.hatchTex = makeHatchTexture();
  }

  get canAdd() { return this.planes.length < MAX_PLANES; }

  add(label: string, axis: THREE.Vector3, offset: number) {
    if (!this.canAdd) return null;
    const sp: SectionPlane = {
      id: Math.random().toString(36).slice(2, 8),
      label, axis: axis.clone().normalize(), offset, flipped: false, enabled: true,
      plane: new THREE.Plane(), result: null,
    };
    this.planes.push(sp);
    this.syncPlane(sp);
    this.rebuild();
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
    if (!sp || !mode || (this.active === sp && this.gizmoMode === mode)) {
      this.active = null; this.gizmoMode = null;
      if (this.gizmo) { this.gizmo.detach(); this.viewer.scene.remove(this.gizmo.getHelper()); this.gizmo.dispose(); this.gizmo = null; }
      this.planeHelper.visible = false;
      this.viewer.invalidate();
      return;
    }
    this.active = sp; this.gizmoMode = mode;
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
    this.gizmo.setMode(mode);
    this.gizmo.showX = mode === "rotate"; this.gizmo.showY = mode === "rotate"; this.gizmo.showZ = mode === "translate";
    this.placePivot(sp);
    this.gizmo.attach(this.pivot);
    const s = this.viewer.modelSize * 0.9;
    this.planeHelper.scale.set(s, s, 1);
    this.planeHelper.visible = true;
    this.viewer.invalidate();
  }

  private centerOn(sp: SectionPlane) {
    const c = this.viewer.computeBounds().getCenter(new THREE.Vector3());
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
