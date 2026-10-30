import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import { formatMeasurement, type Measurement } from "./measure";
import { csys } from "./csys";

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
    const boxy = m.type === "bbox" || m.data.style === "box";
    if (m.segments.length) {
      const pos: number[] = [];
      for (const [a, b] of m.segments) pos.push(...m.points[a], ...m.points[b]);
      const g = new LineSegmentsGeometry().setPositions(pos);
      const mat = new LineMaterial({ color: color.getHex(), linewidth: selected ? 3.2 : 2.2, depthTest: false, transparent: true, dashed: boxy, dashSize: 3, gapSize: 2 });
      mat.resolution.copy(this.viewer.size);
      const line = new LineSegments2(g, mat);
      if (boxy) line.computeLineDistances();
      line.renderOrder = 2000;
      line.raycast = () => {};
      group.add(line);
    }
    if (m.data.triad && m.points.length >= 2) group.add(this.triad(m.points[0], m.points[1]));
    const dotPts = boxy || m.type === "arcLength" ? [] : m.points;
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
    // One line only, so labels never cover the model; details go to the readout card.
    label.innerHTML = `<b>${f.value}</b>`;
    label.title = [f.title, ...f.details].join("\n");
    label.hidden = !m.visible;
    this.layer.appendChild(label);
    return { group, label };
  }

  /** ΔX, ΔY, ΔZ legs from a to b along the axes of the active CSYS (world by default): red, green, blue. */
  private triad(a: number[], b: number[]) {
    const g = new THREE.Group();
    const c = csys.active;
    const axes = c ? [c.x, c.y, c.z] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const corners = [new THREE.Vector3(...a)];
    for (const ax of axes) corners.push(corners.at(-1)!.clone().addScaledVector(new THREE.Vector3(...ax), d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]));
    [0xe03131, 0x2f9e44, 0x1c7ed6].forEach((color, i) => {
      if (corners[i + 1].distanceTo(corners[i]) < 1e-9) return;
      const geo = new LineSegmentsGeometry().setPositions([...corners[i].toArray(), ...corners[i + 1].toArray()]);
      const mat = new LineMaterial({ color, linewidth: 1.6, depthTest: false, transparent: true, dashed: true, dashSize: 2, gapSize: 1.5 });
      mat.resolution.copy(this.viewer.size);
      const line = new LineSegments2(geo, mat);
      line.computeLineDistances();
      line.renderOrder = 1999;
      line.raycast = () => {};
      line.userData.axis = "xyz"[i];
      g.add(line);
    });
    return g;
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
