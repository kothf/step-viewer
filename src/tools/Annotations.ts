import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import { formatMeasurement, type Measurement } from "./measure";

interface Drawn { group: THREE.Group; label: HTMLDivElement }

/** Draws measurements as always-on-top lines, dots and DOM labels. */
export class Annotations {
  private drawn = new Map<string, Drawn>();
  readonly root = new THREE.Group();
  private tmp = new THREE.Vector3();

  constructor(private viewer: Viewer, private layer: HTMLElement) {
    viewer.scene.add(this.root);
    viewer.onRender(() => this.place());
  }

  sync(list: Measurement[], selectedId: string | null) {
    const ids = new Set(list.map(m => m.id));
    for (const [id, d] of this.drawn) if (!ids.has(id)) { this.dispose(d); this.drawn.delete(id); }
    for (const m of list) {
      const old = this.drawn.get(m.id);
      if (old) { this.dispose(old); this.drawn.delete(m.id); }
      const d = this.build(m, m.id === selectedId);
      this.drawn.set(m.id, d);
    }
    this.viewer.invalidate();
  }

  private build(m: Measurement, selected: boolean): Drawn {
    const group = new THREE.Group();
    group.visible = m.visible;
    const color = new THREE.Color(m.color);
    if (m.segments.length) {
      const pos: number[] = [];
      for (const [a, b] of m.segments) pos.push(...m.points[a], ...m.points[b]);
      const g = new LineSegmentsGeometry().setPositions(pos);
      const mat = new LineMaterial({ color: color.getHex(), linewidth: selected ? 3.2 : 2.2, depthTest: false, transparent: true, dashed: m.type === "bbox", dashSize: 3, gapSize: 2 });
      mat.resolution.copy(this.viewer.size);
      const line = new LineSegments2(g, mat);
      if (m.type === "bbox") line.computeLineDistances();
      line.renderOrder = 2000;
      line.raycast = () => {};
      group.add(line);
    }
    const dotPts = m.type === "bbox" || m.type === "arcLength" ? [] : m.points;
    if (dotPts.length) {
      const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(dotPts.flat(), 3));
      const dots = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
      dots.renderOrder = 2001;
      dots.raycast = () => {};
      group.add(dots);
    }
    this.root.add(group);

    const f = formatMeasurement(m);
    const label = document.createElement("div");
    label.className = "m-label" + (selected ? " selected" : "");
    label.style.setProperty("--c", m.color);
    label.dataset.id = m.id;
    label.innerHTML = `<b>${f.value}</b>` + (selected ? f.details.map(t => `<small>${t}</small>`).join("") : "");
    label.hidden = !m.visible;
    this.layer.appendChild(label);
    return { group, label };
  }

  private dispose(d: Drawn) {
    d.group.traverse(o => { const x = o as any; x.geometry?.dispose(); x.material?.dispose(); });
    d.group.removeFromParent();
    d.label.remove();
  }

  private place() {
    const { camera, size } = this.viewer;
    for (const [id, d] of this.drawn) {
      const m = this.lookup?.(id);
      if (!m || !m.visible) { d.label.hidden = true; continue; }
      this.tmp.set(...m.labelAt).project(camera);
      const off = this.tmp.z > 1 || this.tmp.z < -1;
      d.label.hidden = off;
      d.label.style.transform = `translate(${((this.tmp.x + 1) / 2) * size.x}px, ${((1 - this.tmp.y) / 2) * size.y}px) translate(-50%, -50%)`;
    }
  }

  lookup: ((id: string) => Measurement | undefined) | null = null;

  /** Screen-space label boxes, for compositing labels into snapshots. */
  labelBoxes() {
    const out: { x: number; y: number; text: string[]; color: string }[] = [];
    const host = this.layer.getBoundingClientRect();
    for (const [id, d] of this.drawn) {
      const m = this.lookup?.(id);
      if (!m || d.label.hidden) continue;
      const r = d.label.getBoundingClientRect();
      const f = formatMeasurement(m);
      out.push({ x: r.left - host.left + r.width / 2, y: r.top - host.top + r.height / 2, text: [f.value], color: m.color });
    }
    return out;
  }

  clear() { for (const d of this.drawn.values()) this.dispose(d); this.drawn.clear(); }
}
