import * as THREE from "three";
import type { Viewer } from "./Viewer";

/** Orientation cube: 6 faces, 12 edges and 8 corners are clickable (26 views). */
export class NavCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
  private cube: THREE.Mesh;
  private hover = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.55, depthTest: false }),
  );
  private ray = new THREE.Raycaster();

  constructor(private canvas: HTMLCanvasElement, private viewer: Viewer) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();

    // Box built Y-up, then rotated so that labels read upright in a Z-up world.
    const labels = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"];
    const mats = labels.map(l => new THREE.MeshBasicMaterial({ map: this.labelTexture(l) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
    this.cube.rotation.x = Math.PI / 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x6b7280 }));
    this.cube.add(edges);
    this.scene.add(this.cube);
    this.hover.visible = false;
    this.hover.renderOrder = 2;
    this.scene.add(this.hover);

    const axes = new THREE.AxesHelper(1.6);
    axes.position.set(-1.25, -1.25, -1.25);
    this.scene.add(axes);

    canvas.addEventListener("pointermove", e => this.onMove(e));
    canvas.addEventListener("pointerleave", () => { this.hover.visible = false; this.render(); });
    canvas.addEventListener("click", e => {
      const dir = this.dirAt(e);
      if (dir) viewer.viewFrom(dir);
    });
    viewer.onRender(() => this.render());
  }

  resize() {
    this.renderer.setSize(this.canvas.clientWidth || 110, this.canvas.clientHeight || 110, false);
  }

  private labelTexture(text: string) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "#f4f6fa"); grad.addColorStop(1, "#dfe4ec");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#334155";
    g.font = "600 24px system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 64, 66);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  private dirAt(e: PointerEvent | MouseEvent): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const snap = (c: number) => (Math.abs(c) > 0.62 ? Math.sign(c) : 0);
    const d = new THREE.Vector3(snap(p.x), snap(p.y), snap(p.z));
    return d.lengthSq() ? d : null;
  }

  private onMove(e: PointerEvent) {
    const d = this.dirAt(e);
    this.hover.visible = !!d;
    if (d) {
      // Highlight the zone: face, edge strip or corner block.
      const s = (c: number) => (c === 0 ? 1.3 : 0.7);
      this.hover.scale.set(s(d.x), s(d.y), s(d.z));
      this.hover.position.set(d.x * 0.68, d.y * 0.68, d.z * 0.68);
    }
    this.render();
  }

  render() {
    const cam = this.viewer.camera;
    const dir = cam.position.clone().sub(this.viewer.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(8));
    this.camera.quaternion.copy(cam.quaternion);
    this.renderer.render(this.scene, this.camera);
  }
}
