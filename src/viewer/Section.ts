import * as THREE from "three";
import type { Viewer } from "./Viewer";

export interface SectionPlane {
  id: string;
  label: string;
  plane: THREE.Plane;
  /** Unit normal before flip; offset is measured along it. */
  axis: THREE.Vector3;
  offset: number;
  flipped: boolean;
  enabled: boolean;
}

/**
 * Multi-plane section with solid caps. Caps use the stencil parity trick: for a
 * closed solid, pixels where the cut face is visible see an odd number of
 * remaining surfaces, so back faces increment and front faces decrement the
 * stencil, and the cap quad is drawn where the result is non-zero.
 */
export class SectionManager {
  planes: SectionPlane[] = [];
  capsEnabled = true;
  capColor = new THREE.Color(0xd4553f);
  private capObjects: THREE.Object3D[] = [];
  private capMeshes: { mesh: THREE.Mesh; sp: SectionPlane }[] = [];

  constructor(private viewer: Viewer) {}

  add(label: string, axis: THREE.Vector3, offset: number) {
    const sp: SectionPlane = {
      id: Math.random().toString(36).slice(2, 8),
      label, axis: axis.clone().normalize(), offset, flipped: false, enabled: true,
      plane: new THREE.Plane(),
    };
    this.planes.push(sp);
    this.syncPlane(sp);
    this.rebuild();
    return sp;
  }

  remove(sp: SectionPlane) {
    this.planes = this.planes.filter(p => p !== sp);
    this.rebuild();
  }

  clear() { this.planes = []; this.rebuild(); }

  /** Keeps material clipping arrays in step with the enabled planes. */
  rebuild() {
    const v = this.viewer;
    for (const o of this.capObjects) o.removeFromParent();
    this.capObjects = [];
    this.capMeshes = [];
    const active = this.planes.filter(p => p.enabled);
    v.clipPlanes = active.map(p => p.plane);
    for (const p of v.parts) v.applyPartAppearance(p);

    if (this.capsEnabled && v.mode !== "wireframe") {
      const size = v.modelSize * 4;
      active.forEach((sp, i) => {
        const order = i + 1;
        for (const part of v.parts) {
          if (!part.visible || !part.data.closed) continue;
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
          color: this.capColor, metalness: 0.05, roughness: 0.8, side: THREE.DoubleSide,
          clippingPlanes: active.filter(p => p !== sp).map(p => p.plane),
          stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
        });
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat);
        cap.renderOrder = order + 0.1;
        cap.raycast = () => {};
        cap.onAfterRender = r => r.clearStencil();
        v.scene.add(cap);
        this.capObjects.push(cap);
        this.capMeshes.push({ mesh: cap, sp });
      });
    }
    this.syncCaps();
    v.invalidate();
  }

  setOffset(sp: SectionPlane, offset: number) { sp.offset = offset; this.syncPlane(sp); this.syncCaps(); this.viewer.invalidate(); }
  flip(sp: SectionPlane) { sp.flipped = !sp.flipped; this.syncPlane(sp); this.syncCaps(); this.viewer.invalidate(); }
  setEnabled(sp: SectionPlane, on: boolean) { sp.enabled = on; this.rebuild(); }
  setCaps(on: boolean) { this.capsEnabled = on; this.rebuild(); }
  setCapColor(c: string) { this.capColor.set(c); this.rebuild(); }

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

  private syncPlane(sp: SectionPlane) {
    // Three.js keeps the positive side; by default we keep material behind the plane (axis·p <= offset).
    const n = sp.axis.clone().multiplyScalar(sp.flipped ? 1 : -1);
    sp.plane.normal.copy(n);
    sp.plane.constant = sp.flipped ? -sp.offset : sp.offset;
  }

  private syncCaps() {
    const o = new THREE.Vector3();
    for (const { mesh, sp } of this.capMeshes) {
      sp.plane.coplanarPoint(o);
      mesh.position.copy(o);
      mesh.lookAt(o.clone().sub(sp.plane.normal));
    }
  }
}
