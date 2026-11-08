// Surface analysis display (FR-MEA-005): colours the shown parts by draft, curvature, wall thickness or undercut,
// or puts zebra stripes on them, with a legend panel in the viewport. The parts' own materials stay as they are;
// each mesh gets an analysis material (and a colour attribute) until the analysis is turned off.
import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { onLangChange, t } from "../i18n";
import {
  curvature, draft, thickness, undercut, DRAFT_CLASSES, RAMP_CSS, THICK_CLASSES, UNDERCUT_CLASSES,
  type Analysis, type AnalysisKind, type MeshIn, type RayHit, type V3,
} from "../tools/surfaceAnalysis";
import type { Part, Viewer } from "./Viewer";

export interface AnalysisHost {
  /** The selected flat face's normal, world, if any. */
  faceNormal(): V3 | null;
}

export interface AnalysisSettings { pull: string; face: V3 | null; minDraft: number; minWall: number; stripes: number }

const DIRS: Record<string, V3> = { "+Z": [0, 0, 1], "-Z": [0, 0, -1], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+X": [1, 0, 0], "-X": [-1, 0, 0] };
const KINDS: AnalysisKind[] = ["draft", "zebra", "curvature", "thickness", "undercut"];
const NAMES: Record<AnalysisKind, string> = { draft: "Draft", zebra: "Zebra stripes", curvature: "Curvature", thickness: "Thickness", undercut: "Undercut" };

interface Saved { color: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined; mat: THREE.Material }

export class SurfaceAnalysis {
  kind: AnalysisKind | null = null;
  readonly s: AnalysisSettings = { pull: "+Z", face: null, minDraft: 1, minWall: 1, stripes: 16 };
  /** Area per class over the shown parts, and the total, from the last run (also read by the smoke test). */
  areas: Record<string, number> = {};
  total = 0;
  max = 0;
  busy = false;
  private saved = new Map<THREE.Mesh, Saved>();
  private mats: THREE.Material[] = [];
  private zebra: THREE.ShaderMaterial | null = null;
  private run = 0;
  private panel: HTMLElement;

  constructor(private viewer: Viewer, private host: AnalysisHost, panel: HTMLElement, private onChange: (k: AnalysisKind | null) => void = () => {}) {
    this.panel = panel;
    panel.addEventListener("change", e => this.input(e.target as HTMLInputElement));
    panel.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
      if (b?.dataset.a === "close") this.set(null);
      if (b?.dataset.a === "face") this.useFace();
    });
    onLangChange(() => this.render());
  }

  /** Starts an analysis (null turns it off). */
  set(kind: AnalysisKind | null) {
    this.kind = kind;
    this.onChange(kind);
    void this.refresh();
  }

  /** Runs the analysis again on the parts the viewer shows now (after a load, a rebuild or a setting). */
  async refresh() {
    const run = ++this.run;
    this.restore();
    this.areas = {}; this.total = 0; this.max = 0;
    if (!this.kind) { this.busy = false; this.render(); this.viewer.invalidate(); return; }
    this.busy = this.kind === "thickness" || this.kind === "undercut";
    this.render();
    const kind = this.kind, size = this.viewer.modelSize, stop = () => run !== this.run;
    for (const p of this.viewer.parts) {
      if (kind === "zebra") { this.wear(p, this.zebraMat(), null); continue; }
      const m = meshOf(p), hit = rayOf(p), pull = this.localPull(p);
      let r: Analysis | null;
      if (kind === "draft") r = draft(m, pull, this.s.minDraft);
      else if (kind === "curvature") r = curvature(m);
      else if (kind === "thickness") r = await thickness(m, hit, this.s.minWall, size, stop);
      else r = await undercut(m, hit, pull, size, stop);
      if (stop() || !r) return;
      this.wear(p, this.colorMat(), r.colors);
      if (p.visible) {
        for (const [k, a] of Object.entries(r.areas)) { this.areas[k] = (this.areas[k] ?? 0) + a; this.total += a; }
        this.max = Math.max(this.max, r.max ?? 0);
      }
      this.viewer.invalidate();
    }
    this.busy = false;
    this.render();
    this.viewer.invalidate();
  }

  /** The pull direction in world coordinates. */
  pull(): V3 { return this.s.pull === "face" && this.s.face ? this.s.face : DIRS[this.s.pull] ?? DIRS["+Z"]; }

  private localPull(p: Part): V3 {
    p.mesh.updateWorldMatrix(true, false);
    const v = new THREE.Vector3(...this.pull()).transformDirection(p.mesh.matrixWorld.clone().invert());
    return [v.x, v.y, v.z];
  }

  private useFace() {
    const n = this.host.faceNormal();
    if (!n) { import("../ui").then(u => u.toast(t("Select a flat face first."))); return; }
    this.s.face = n; this.s.pull = "face";
    void this.refresh();
  }

  private input(el: HTMLInputElement) {
    const k = el.dataset.k;
    if (k === "pull") { if (el.value === "face" && !this.s.face) { this.useFace(); return; } this.s.pull = el.value; }
    else if (k === "minDraft") this.s.minDraft = Math.max(0, Number(el.value) || 0);
    else if (k === "minWall") this.s.minWall = Math.max(1e-3, Number(el.value) || 1);
    else if (k === "stripes") this.s.stripes = Number(el.value) || 16;
    else if (k === "kind") { this.set((el.value || null) as AnalysisKind | null); return; }
    else return;
    void this.refresh();
  }

  private wear(p: Part, mat: THREE.Material, colors: Float32Array | null) {
    const g = p.mesh.geometry;
    if (!this.saved.has(p.mesh)) this.saved.set(p.mesh, { color: g.getAttribute("color"), mat: p.mesh.material });
    if (colors) g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    mat.clippingPlanes = this.viewer.clipPlanes;
    p.mesh.material = mat;
  }

  private restore() {
    for (const [mesh, s] of this.saved) {
      mesh.material = s.mat;
      if (s.color) mesh.geometry.setAttribute("color", s.color); else mesh.geometry.deleteAttribute("color");
    }
    this.saved.clear();
    for (const m of this.mats) m.dispose();
    this.mats = [];
  }

  private colorMat() {
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0, roughness: 0.75, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.mats.push(m);
    return m;
  }

  /** Zebra stripes: bands of the view ray reflected off the surface, so they flow over curved faces like a light box would. */
  private zebraMat() {
    if (this.zebra) { this.zebra.uniforms.n.value = this.s.stripes; return this.zebra; }
    this.zebra = new THREE.ShaderMaterial({
      uniforms: { n: { value: this.s.stripes } },
      clipping: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      vertexShader: `
        #include <clipping_planes_pars_vertex>
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vP = mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: `
        #include <clipping_planes_pars_fragment>
        uniform float n;
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          #include <clipping_planes_fragment>
          vec3 nn = normalize(vN);
          if (!gl_FrontFacing) nn = -nn;
          vec3 v = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(vP);
          vec3 r = reflect(v, nn);
          float a = asin(clamp(r.y, -1.0, 1.0)) / 3.14159265 + 0.5;
          float c = sin(a * n * 6.2831853);
          float w = fwidth(c) + 1e-4;
          float band = smoothstep(-w, w, c);
          float shade = 0.75 + 0.25 * abs(nn.z);
          gl_FragColor = vec4(vec3(mix(0.96, 0.08, clamp(band, 0.0, 1.0)) * shade), 1.0);
        }`,
    });
    return this.zebra;
  }

  // ---------- panel ----------

  private render() {
    const P = this.panel, k = this.kind;
    P.hidden = !k;
    if (!k) { P.innerHTML = ""; return; }
    const pct = (key: string) => (this.total > 0 ? `${((this.areas[key] ?? 0) / this.total * 100).toFixed(1)} %` : "");
    const rows = (cls: readonly { key: string; color: string; label: string }[]) =>
      `<ul class="ana-legend">${cls.map(c => `<li data-cls="${c.key}"><i style="background:${c.color}"></i><span>${t(c.label)}</span><b>${pct(c.key)}</b></li>`).join("")}</ul>`;
    const dir = `<label class="ana-row">${t("Pull direction")} <select data-k="pull">${Object.keys(DIRS).map(d => `<option value="${d}"${this.s.pull === d ? " selected" : ""}>${d}</option>`).join("")}<option value="face"${this.s.pull === "face" ? " selected" : ""}>${t("Selected face")}</option></select></label>
      <button class="btn small" data-a="face" title="${t("Pull along the normal of the selected flat face")}">${t("Use selected face")}</button>`;
    let body = "";
    if (k === "draft") {
      body = `${dir}<label class="ana-row">${t("Minimum draft (°)")} <input type="number" data-k="minDraft" min="0" step="0.5" value="${this.s.minDraft}"></label>${rows(DRAFT_CLASSES)}`;
    } else if (k === "undercut") {
      body = `${dir}${rows(UNDERCUT_CLASSES)}`;
    } else if (k === "thickness") {
      body = `<label class="ana-row">${t("Minimum wall (mm)")} <input type="number" data-k="minWall" min="0.01" step="0.1" value="${this.s.minWall}"></label>${rows(THICK_CLASSES)}
        <div class="ana-ramp" style="background:${RAMP_CSS}; transform: scaleX(-1)"></div><div class="ana-scale"><span>${fmt(this.s.minWall)}</span><span>${fmt(this.s.minWall * 4)}+</span></div>
        ${this.max ? `<p class="ana-note">${t("Thickest wall: {v}", { v: fmt(this.max) })}</p>` : ""}`;
    } else if (k === "curvature") {
      const r = this.max ? 1 / this.max : 0;
      body = `<div class="ana-ramp" style="background:${RAMP_CSS}"></div><div class="ana-scale"><span>${t("Flat")}</span><span>${r ? `R ${fmt(r)}` : ""}</span></div>
        <p class="ana-note">${t("Red marks the tightest curves (radius {r} or less).", { r: fmt(r) })}</p>`;
    } else {
      body = `<label class="ana-row">${t("Stripes")} <select data-k="stripes">${[8, 16, 32].map(n => `<option${n === this.s.stripes ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        <p class="ana-note">${t("Stripes that run on smoothly across an edge mean the faces are tangent there; a kink or a jump means they are not.")}</p>`;
    }
    P.innerHTML = `<div class="ana-head"><select data-k="kind" aria-label="${t("Surface analysis")}">${KINDS.map(x => `<option value="${x}"${x === k ? " selected" : ""}>${t(NAMES[x])}</option>`).join("")}</select>
      <button class="icon" data-a="close" title="${t("Turn the analysis off")}" aria-label="${t("Turn the analysis off")}">✕</button></div>
      ${body}${this.busy ? `<p class="ana-note" role="status">${t("Casting rays…")}</p>` : ""}`;
  }
}

const fmt = (mm: number) => `${mm >= 100 ? mm.toFixed(0) : mm >= 10 ? mm.toFixed(1) : mm.toFixed(2)} mm`;

function meshOf(p: Part): MeshIn {
  return { positions: p.data.positions, normals: p.data.normals, index: p.data.index, faces: p.data.faces };
}

function rayOf(p: Part): RayHit {
  const bvh = (p.mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree;
  const ray = new THREE.Ray();
  return (o, d, far) => {
    if (!bvh) return null;
    ray.origin.set(...o); ray.direction.set(...d);
    const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
    return h && h.distance <= far ? h.distance : null;
  };
}
