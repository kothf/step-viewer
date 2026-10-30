import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Viewer } from "../viewer/Viewer";
import { formatMeasurement, type Measurement } from "./measure";
import { fmtLen } from "./units";
import { csys } from "./csys";

interface Leg { el: HTMLDivElement; at: number[] }
interface Drawn { group: THREE.Group; label: HTMLDivElement; legs: Leg[] }

const AXIS_COLORS = ["#e03131", "#2f9e44", "#1c7ed6"];

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
    // ΔX/ΔY/ΔZ legs: between the given endpoints, or the first two points (pinned 1.3.0 measurements store 1).
    const t = m.data.triad;
    const ends = Array.isArray(t) && t.length === 6 ? [t.slice(0, 3), t.slice(3)] : t && m.points.length >= 2 ? [m.points[0], m.points[1]] : null;
    const legs: Leg[] = [];
    if (ends) group.add(this.triad(ends[0], ends[1], m, legs));
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
    return { group, label, legs };
  }

  /**
   * ΔX, ΔY, ΔZ legs from a to b along the axes of the active CSYS (world by default):
   * thin red, green and blue lines, each with its own small dimension label.
   */
  private triad(a: number[], b: number[], m: Measurement, legs: Leg[]) {
    const g = new THREE.Group();
    const c = csys.active;
    const axes = c ? [c.x, c.y, c.z] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const corners = [new THREE.Vector3(...a)];
    for (const ax of axes) corners.push(corners.at(-1)!.clone().addScaledVector(new THREE.Vector3(...ax), d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]));
    const span = Math.hypot(...d);
    AXIS_COLORS.forEach((color, i) => {
      const len = corners[i + 1].distanceTo(corners[i]);
      if (len < 1e-9 || len < span * 1e-6) return;
      const geo = new LineSegmentsGeometry().setPositions([...corners[i].toArray(), ...corners[i + 1].toArray()]);
      const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: 1.2, depthTest: false, transparent: true, opacity: 0.9 });
      mat.resolution.copy(this.viewer.size);
      const line = new LineSegments2(geo, mat);
      line.renderOrder = 1999;
      line.raycast = () => {};
      line.userData.axis = "xyz"[i];
      g.add(line);
      const el = document.createElement("div");
      el.className = "m-leg";
      el.style.setProperty("--c", color);
      el.dataset.id = m.id;
      el.dataset.axis = "XYZ"[i];
      el.textContent = `Δ${"XYZ"[i]} ${fmtLen(len)}`;
      el.hidden = !m.visible;
      this.layer.appendChild(el);
      legs.push({ el, at: corners[i].clone().add(corners[i + 1]).multiplyScalar(0.5).toArray() });
    });
    return g;
  }

  private dispose(d: Drawn) {
    d.group.traverse(o => { const x = o as any; x.geometry?.dispose(); x.material?.dispose(); });
    d.group.removeFromParent();
    d.label.remove();
    for (const l of d.legs) l.el.remove();
  }

  private place() {
    const { camera, size } = this.viewer;
    for (const [id, d] of this.drawn) {
      const m = this.lookup?.(id);
      const shown = !!m && m.visible;
      if (!shown) d.label.hidden = true;
      for (const l of d.legs) if (!shown) l.el.hidden = true;
      if (!shown) continue;
      const put = (el: HTMLElement, at: number[]) => {
        this.tmp.set(at[0], at[1], at[2]).project(camera);
        el.hidden = this.tmp.z > 1 || this.tmp.z < -1;
        el.style.transform = `translate(${((this.tmp.x + 1) / 2) * size.x}px, ${((1 - this.tmp.y) / 2) * size.y}px) translate(-50%, -50%)`;
      };
      put(d.label, m.labelAt);
      for (const l of d.legs) put(l.el, l.at);
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
      for (const l of d.legs) {
        if (l.el.hidden) continue;
        const q = l.el.getBoundingClientRect();
        out.push({ x: q.left - host.left + q.width / 2, y: q.top - host.top + q.height / 2, text: [l.el.textContent ?? ""], color: l.el.style.getPropertyValue("--c") });
      }
    }
    return out;
  }

  clear() { for (const d of this.drawn.values()) this.dispose(d); this.drawn.clear(); }
}
