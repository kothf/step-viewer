import "./style.css";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Viewer, type DisplayMode, type Part } from "./viewer/Viewer";
import { NavCube } from "./viewer/NavCube";
import { SectionManager } from "./viewer/Section";
import { Snapper, SNAP_FILTERS, type Snap } from "./tools/Snapper";
import { Annotations } from "./tools/Annotations";
import {
  CIRCLE_MODES, describeEntity, entityFromSnap, formatMeasurement, measure, measureBBox, MeasureError, smartBody, smartMeasure, TOOL_INFO,
  type CircleMode,
  type Entity, type Measurement, type MeasureType,
} from "./tools/measure";
import { clearAnalysis, draftAnalysis, MATERIALS, massProperties, thicknessAnalysis } from "./tools/analysis";
import { exportMesh, inspectionReport, measurementsCsv, measurementsJson, snapshot, download } from "./tools/exporters";
import { fmtArea, fmtLen, fmtMass, fmtVec, fmtVol, unitMm, units, type Unit } from "./tools/units";
import { readStepMeta, type StepMeta } from "./stepMeta";
import type { EdgeInfo, PartData, TreeNode } from "./topology";
import ImportWorker from "./worker/import.worker?worker";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------- theme (before the viewer reads colours) ----------
const storage = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = storage.get("sv:theme") ?? (prefersDark ? "dark" : "light");

const vpEl = $("#viewport");
const viewer = new Viewer(vpEl);
const section = new SectionManager(viewer);
const snapper = new Snapper(viewer);
const annotations = new Annotations(viewer, $("#labels"));
new NavCube($<HTMLCanvasElement>("#navcube"), viewer);
applyThemeToViewer();
$("#app-version").textContent = `v${__APP_VERSION__}`;

// ---------- state ----------
const UNIT_LIST: Unit[] = ["mm", "cm", "m", "in", "ft"];
/** "plane3" picks three points for a section plane. */
type Tool = MeasureType | "select" | "plane3";
const state = {
  fileName: "",
  fileKey: "",
  meta: null as StepMeta | null,
  tool: "select" as Tool,
  picks: [] as Entity[],
  selection: null as Entity | null,
  selectedNode: null as TreeNode | null,
  selectedParts: [] as Part[],
  measurements: [] as Measurement[],
  selectedMeasurement: null as string | null,
  lastSnap: null as Snap | null,
  /** Smart measure result shown until the next click; Pin keeps it. */
  live: null as Measurement | null,
  /** The live result is between two entities, so the next click starts over. */
  livePair: false,
  /** Entities behind the live result, so a mode switch can measure them again. */
  livePicks: [] as Entity[],
  /** Two round features: centre to centre, nearest or farthest rims. Kept between picks. */
  circleMode: "center" as CircleMode,
  /** Last value copied from the readout. */
  lastCopied: "",
};
annotations.lookup = id => (state.live?.id === id ? state.live : state.measurements.find(m => m.id === id));

// ---------- highlight overlays ----------
const hl = {
  hoverFace: overlayFace(0x3d8bfd, 0.28),
  selFace: overlayFace(0xf59f00, 0.42),
  hoverEdge: overlayEdge(0x3d8bfd, 3.2),
  selEdge: overlayEdge(0xf59f00, 4),
  pickMarks: new THREE.Group(),
  com: new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xe03131, depthTest: false })),
};
hl.com.renderOrder = 2000;
hl.com.visible = false;
viewer.scene.add(hl.hoverFace, hl.selFace, hl.hoverEdge, hl.selEdge, hl.pickMarks, hl.com);

function overlayFace(color: number, opacity: number) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  m.visible = false; m.renderOrder = 1010; m.raycast = () => {};
  return m;
}
function overlayEdge(color: number, width: number) {
  const mat = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
  const l = new LineSegments2(new LineSegmentsGeometry(), mat);
  l.visible = false; l.renderOrder = 1011; l.raycast = () => {};
  return l;
}
function showFace(o: THREE.Mesh, part: Part | null, faceId?: number) {
  if (!part || faceId === undefined) { o.visible = false; return; }
  const f = part.data.faces[faceId];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", part.mesh.geometry.getAttribute("position"));
  g.setIndex(part.mesh.geometry.getIndex());
  g.setDrawRange(f.triStart * 3, f.triCount * 3);
  o.geometry = g;
  o.position.copy(part.group.position);
  (o.material as THREE.Material).clippingPlanes = viewer.clipPlanes;
  o.visible = true;
}
function showEdge(o: LineSegments2, part: Part | null, edge?: EdgeInfo) {
  if (!part || !edge) { o.visible = false; return; }
  const pts = edge.pts, seg: number[] = [];
  for (let i = 3; i < pts.length; i += 3) seg.push(pts[i - 3], pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2]);
  o.geometry.dispose();
  o.geometry = new LineSegmentsGeometry().setPositions(seg);
  o.position.copy(part.group.position);
  (o.material as LineMaterial).resolution.copy(viewer.size);
  o.visible = true;
}
function showEntity(face: THREE.Mesh, edge: LineSegments2, e: { part: Part; face?: { id: number }; edge?: EdgeInfo; kind?: string } | null) {
  const isEdge = !!e && (e.kind === "edge" || (!e.kind && !!e.edge && !e.face));
  showFace(face, e && !isEdge && e.face ? e.part : null, e?.face?.id);
  showEdge(edge, e && isEdge ? e.part : null, e?.edge);
  viewer.invalidate();
}

// ---------- loading ----------
const worker = new ImportWorker();
let loadToken = 0;

async function openFile(file: File) {
  const buffer = await file.arrayBuffer();
  await openBuffer(buffer, file.name);
}

async function openBuffer(buffer: ArrayBuffer, name: string) {
  const token = ++loadToken;
  setLoading(true, `Reading ${name}…`, 2);
  state.meta = readStepMeta(new Uint8Array(buffer));
  const quality = $<HTMLSelectElement>("#quality").value as "draft" | "normal" | "fine";
  const occtBase = new URL("occt/", document.baseURI).href;
  const t0 = performance.now();
  const result = await new Promise<{ parts: PartData[]; tree: TreeNode }>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === "progress") setLoading(true, d.text, d.pct);
      else if (d.type === "done") resolve(d);
      else reject(new Error(d.text));
    };
    worker.postMessage({ buffer, name, occtBase, quality }, [buffer]);
  }).catch(err => { setLoading(false); toast(`Could not open ${name}: ${err.message}`, true); return null; });
  if (!result || token !== loadToken) return;

  setLoading(true, "Building scene…", 97);
  await new Promise(r => setTimeout(r, 0));
  resetForNewModel();
  viewer.load(result.parts, result.tree);
  state.fileName = name;
  state.fileKey = `sv:m:${name}:${buffer.byteLength || ""}`;
  document.title = `${name} · STEP Viewer`;
  $("#empty").hidden = true;
  setLoading(false);
  buildTree();
  loadMeasurements();
  renderProps();
  const tris = result.parts.reduce((s, p) => s + p.index.length / 3, 0);
  const faces = result.parts.reduce((s, p) => s + p.faces.length, 0);
  $("#st-stats").textContent = `${result.parts.length} parts · ${faces.toLocaleString()} faces · ${tris.toLocaleString()} triangles · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
}

function resetForNewModel() {
  setTool("select");
  section.clear();
  renderSections();
  clearAnalysis(viewer);
  stopDrag();
  hl.com.visible = false;
  state.selection = null;
  state.selectedNode = null;
  state.selectedParts = [];
  state.measurements = [];
  state.live = null;
  annotations.clear();
  showEntity(hl.selFace, hl.selEdge, null);
  showEntity(hl.hoverFace, hl.hoverEdge, null);
  $<HTMLInputElement>("#explode").value = "0";
  $("#explode-val").textContent = "0%";
  viewer.explodeFactor = 0;
  $("#mass-out").innerHTML = "";
  $("#analysis-out").innerHTML = "";
}

function setLoading(on: boolean, text = "", pct = 0) {
  $("#loading").hidden = !on;
  if (on) { $("#loading-text").textContent = text; $("#loading-bar").style.width = `${pct}%`; }
}

let toastTimer = 0;
function toast(msg: string, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}

for (const id of ["#file-input", "#file-input-2"]) {
  $<HTMLInputElement>(id).addEventListener("change", e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) openFile(f);
    (e.target as HTMLInputElement).value = "";
  });
}
vpEl.addEventListener("dragover", e => { e.preventDefault(); vpEl.classList.add("drag"); });
vpEl.addEventListener("dragleave", () => vpEl.classList.remove("drag"));
vpEl.addEventListener("drop", e => {
  e.preventDefault();
  vpEl.classList.remove("drag");
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// ---------- model tree ----------
const nodeEls = new Map<TreeNode, HTMLElement>();

function partsUnder(n: TreeNode, out: Part[] = []) {
  n.parts.forEach(i => out.push(viewer.parts[i]));
  n.children.forEach(c => partsUnder(c, out));
  return out;
}

function buildTree() {
  const host = $("#tree");
  host.innerHTML = "";
  nodeEls.clear();
  if (!viewer.tree) return;
  const make = (n: TreeNode, depth: number): HTMLElement => {
    const el = document.createElement("div");
    el.className = "node";
    const leafPart = n.children.length === 0 && n.parts.length === 1 ? viewer.parts[n.parts[0]] : null;
    const count = partsUnder(n).length;
    const hasKids = n.children.length > 0 || n.parts.length > 1;
    const row = document.createElement("div");
    row.className = "row-n";
    row.style.setProperty("--d", String(depth));
    const sw = leafPart ? `<span class="swatch" style="background:#${leafPart.baseColor.getHexString()}"></span>` : "";
    row.innerHTML = `<span class="caret">${hasKids ? "▾" : ""}</span><button class="eye" title="Show/hide">●</button>${sw}<span class="nm" title="${esc(n.name)}">${esc(n.name)}</span><span class="cnt">${count > 1 ? count : ""}</span>`;
    el.appendChild(row);
    const kids = document.createElement("div");
    kids.className = "kids";
    n.children.forEach(c => kids.appendChild(make(c, depth + 1)));
    // A node holding several meshes directly lists them as leaves.
    if (n.parts.length > 1) n.parts.forEach(i => kids.appendChild(make({ name: viewer.parts[i].data.name, parts: [i], children: [] }, depth + 1)));
    el.appendChild(kids);
    row.querySelector(".caret")!.addEventListener("click", e => { e.stopPropagation(); el.classList.toggle("collapsed"); });
    row.querySelector(".eye")!.addEventListener("click", e => {
      e.stopPropagation();
      const ps = partsUnder(n);
      const show = !ps.every(p => p.visible);
      ps.forEach(p => setPartVisible(p, show));
      afterVisibilityChange();
    });
    row.addEventListener("click", () => selectNode(n));
    row.addEventListener("dblclick", () => { const b = new THREE.Box3(); partsUnder(n).forEach(p => b.expandByObject(p.mesh)); viewer.fit(true, b); });
    nodeEls.set(n, el);
    (el as any)._node = n;
    return el;
  };
  host.appendChild(make(viewer.tree, 0));
  refreshTreeVisibility();
}

function refreshTreeVisibility() {
  for (const [n, el] of nodeEls) {
    const ps = partsUnder(n);
    const vis = ps.filter(p => p.visible).length;
    el.classList.toggle("hidden-part", vis === 0);
    const eye = el.querySelector(":scope > .row-n .eye") as HTMLElement;
    eye.textContent = vis === 0 ? "○" : vis < ps.length ? "◐" : "●";
    el.classList.toggle("sel", n === state.selectedNode);
  }
}

function setPartVisible(p: Part, on: boolean) {
  p.visible = on;
  viewer.applyPartAppearance(p);
}
function afterVisibilityChange() {
  refreshTreeVisibility();
  section.rebuild();
  viewer.computeBounds();
  viewer.invalidate();
}

function selectNode(n: TreeNode | null, fromViewport = false) {
  state.selectedNode = n;
  state.selectedParts = n ? partsUnder(n) : [];
  for (const p of viewer.parts) {
    p.material.emissive.setHex(state.selectedParts.includes(p) && n !== viewer.tree ? 0x0c1c3a : 0x000000);
  }
  if (n && !fromViewport) { state.selection = null; showEntity(hl.selFace, hl.selEdge, null); }
  if (n) {
    // Reveal the node in the tree.
    let el = nodeEls.get(n)?.parentElement?.closest(".node");
    while (el) { el.classList.remove("collapsed"); el = el.parentElement?.closest(".node"); }
    if (fromViewport) nodeEls.get(n)?.scrollIntoView({ block: "nearest" });
  }
  refreshTreeVisibility();
  renderProps();
  viewer.invalidate();
}

function nodeForPart(p: Part): TreeNode | null {
  let found: TreeNode | null = null;
  for (const [n] of nodeEls) if (n.parts.length === 1 && n.parts[0] === p.idx && n.children.length === 0) found = n;
  return found;
}

// Filter: plain text matches names; size>N / size<N (largest bbox side, current units); vol>N / vol<N.
$<HTMLInputElement>("#tree-search").addEventListener("input", e => {
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const f = unitMm();
  const test = (n: TreeNode): boolean => {
    if (!tokens.length) return true;
    const ps = partsUnder(n);
    return tokens.every(t => {
      const m = t.match(/^(size|vol)([<>]=?)([\d.]+)$/);
      if (!m) return n.name.toLowerCase().includes(t);
      const limit = parseFloat(m[3]) * (m[1] === "vol" ? f ** 3 : f);
      return ps.some(p => {
        const d = p.data;
        const val = m[1] === "vol" ? d.volume : Math.max(d.bboxMax[0] - d.bboxMin[0], d.bboxMax[1] - d.bboxMin[1], d.bboxMax[2] - d.bboxMin[2]);
        return m[2].startsWith(">") ? val > limit : val < limit;
      });
    });
  };
  const visit = (el: HTMLElement): boolean => {
    const n = (el as any)._node as TreeNode;
    let any = false;
    el.querySelectorAll(":scope > .kids > .node").forEach(k => { if (visit(k as HTMLElement)) any = true; });
    const self = test(n);
    const show = self || any;
    el.style.display = show ? "" : "none";
    if (tokens.length && any) el.classList.remove("collapsed");
    return show;
  };
  const root = $("#tree").firstElementChild as HTMLElement | null;
  if (root) visit(root);
});

// ---------- properties panel ----------
function kv(rows: [string, string][]) {
  return `<div class="kv">${rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${v}</span>`).join("")}</div>`;
}

function renderProps() {
  const el = $("#props");
  if (!viewer.parts.length) { el.innerHTML = `<p class="muted">Open a model to begin.</p>`; return; }
  const e = state.selection;
  let html = "";
  if (e) {
    const p = e.part;
    html += `<span class="badge">${esc(describeEntity(e))}</span><h3>${esc(p.data.name)}</h3>`;
    const rows: [string, string][] = [];
    if (e.kind === "face" && e.face) {
      const f = e.face;
      rows.push(["Surface", f.type], ["Area", fmtArea(f.area)]);
      if (f.normal) rows.push(["Normal", fmtVec(new THREE.Vector3(...f.normal), false)]);
      if (f.axis) rows.push(["Axis", fmtVec(new THREE.Vector3(...f.axis), false)]);
      if (f.radius) rows.push(["Radius", fmtLen(f.radius)], ["Diameter", fmtLen(f.radius * 2)]);
      rows.push([f.type === "plane" || f.type === "other" ? "Centroid" : "Centre", fmtVec(viewer.toWorld(p, f.center))]);
      rows.push(["Boundary edges", String(f.edges.length)], ["Face #", String(f.id)]);
    } else if (e.edge) {
      const ed = e.edge;
      rows.push(["Curve", ed.type], ["Length", fmtLen(ed.length)]);
      if (ed.radius) rows.push(["Radius", fmtLen(ed.radius)], ["Diameter", fmtLen(ed.radius * 2)], ["Centre", fmtVec(viewer.toWorld(p, ed.center!))]);
      if (ed.sweep && ed.type === "arc") rows.push(["Sweep", `${((ed.sweep * 180) / Math.PI).toFixed(3)}°`]);
      if (ed.dir) rows.push(["Direction", fmtVec(new THREE.Vector3(...ed.dir), false)]);
      rows.push(["Start", fmtVec(viewer.toWorld(p, ed.start))], ["End", fmtVec(viewer.toWorld(p, ed.end))]);
    }
    if (e.kind === "point") rows.push(["Point", fmtVec(e.point)]);
    html += kv(rows);
    html += `<hr style="border:0;border-top:1px solid var(--line)">`;
  }
  const n = state.selectedNode;
  if (n && n !== viewer.tree) {
    const ps = state.selectedParts;
    const b = new THREE.Box3();
    ps.forEach(p => b.expandByObject(p.mesh));
    const s = b.getSize(new THREE.Vector3());
    const vol = ps.reduce((a, p) => a + p.data.volume, 0), area = ps.reduce((a, p) => a + p.data.area, 0);
    const prod = state.meta?.products.find(x => x.name === n.name || x.id === n.name);
    if (!e) html += `<h3>${esc(n.name)}</h3>`;
    const rows: [string, string][] = [
      ["Path", esc(ps.length === 1 ? ps[0].path : n.name)],
      ["Parts", String(ps.length)],
      ["Size", `${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z)}`],
      ["Volume", fmtVol(vol)], ["Surface area", fmtArea(area)],
      ["Faces / edges", `${ps.reduce((a, p) => a + p.data.faces.length, 0)} / ${ps.reduce((a, p) => a + p.data.edges.length, 0)}`],
      ["Triangles", ps.reduce((a, p) => a + p.data.index.length / 3, 0).toLocaleString()],
    ];
    if (ps.some(p => !p.data.closed)) rows.push(["Note", "open shell: volume approximate"]);
    if (prod?.revision) rows.push(["Revision", esc(prod.revision)]);
    if (prod && prod.id !== prod.name) rows.push(["Part number", esc(prod.id)]);
    html += kv(rows);
    const first = ps[0];
    html += `<div class="row"><label>Colour <input type="color" id="p-color" value="#${first.baseColor.getHexString()}"></label>
      <label class="slider" style="flex:1">Opacity <input type="range" id="p-opacity" min="0.05" max="1" step="0.05" value="${first.opacity}"></label></div>
      <div class="row wrap"><button class="btn small" id="p-isolate">Isolate (I)</button><button class="btn small" id="p-hide">Hide (H)</button><button class="btn small" id="p-showall">Show all (U)</button><button class="btn small" id="p-fit">Zoom to</button><button class="btn small" id="p-reset">Reset look</button></div>`;
  } else if (!e) {
    html += `<h3>${esc(state.fileName)}</h3>`;
    const rows: [string, string][] = [];
    const m = state.meta;
    const b = viewer.computeBounds(), s = b.getSize(new THREE.Vector3());
    rows.push(["Parts", String(viewer.parts.length)], ["Overall size", `${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z)}`]);
    if (m) {
      rows.push(["Protocol", esc(m.protocol)], ["Schema", esc(m.schema)]);
      if (m.system) rows.push(["Created with", esc(m.system)]);
      if (m.timestamp) rows.push(["Timestamp", esc(m.timestamp)]);
      if (m.author.trim()) rows.push(["Author", esc(m.author)]);
      if (m.organization.trim()) rows.push(["Organisation", esc(m.organization)]);
      if (m.description) rows.push(["Description", esc(m.description)]);
      rows.push(["STEP entities", m.entityCount.toLocaleString()], ["Products", String(m.products.length)]);
      if (m.materials.length) rows.push(["Materials", esc(m.materials.join(", "))]);
      const pmi = Object.entries(m.pmi);
      rows.push(["PMI / GD&T", pmi.length ? esc(pmi.map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ")) + " (listed; not drawn)" : "none"]);
    }
    html += kv(rows) + `<p class="muted">Click a face or edge to inspect it, or a part in the tree.</p>`;
  }
  el.innerHTML = html;
  bindPropControls();
}

function bindPropControls() {
  const ps = state.selectedParts;
  $("#p-color")?.addEventListener("input", e => {
    const c = (e.target as HTMLInputElement).value;
    ps.forEach(p => { p.baseColor.set(c); p.material.color.set(c); p.material.vertexColors = false; p.material.needsUpdate = true; });
    viewer.invalidate();
  });
  $("#p-opacity")?.addEventListener("input", e => {
    const o = parseFloat((e.target as HTMLInputElement).value);
    ps.forEach(p => { p.opacity = o; viewer.applyPartAppearance(p); });
    viewer.invalidate();
  });
  $("#p-isolate")?.addEventListener("click", isolateSelected);
  $("#p-hide")?.addEventListener("click", hideSelected);
  $("#p-showall")?.addEventListener("click", showAll);
  $("#p-fit")?.addEventListener("click", () => { const b = new THREE.Box3(); ps.forEach(p => b.expandByObject(p.mesh)); viewer.fit(true, b); });
  $("#p-reset")?.addEventListener("click", () => {
    ps.forEach(p => {
      p.baseColor.setRGB(...p.data.color, THREE.SRGBColorSpace);
      p.material.color.set(p.data.colors ? 0xffffff : p.baseColor);
      p.material.vertexColors = !!p.data.colors;
      p.material.needsUpdate = true;
      p.opacity = 1;
      viewer.applyPartAppearance(p);
    });
    renderProps();
  });
}

function isolateSelected() {
  if (!state.selectedParts.length) return;
  viewer.parts.forEach(p => setPartVisible(p, state.selectedParts.includes(p)));
  afterVisibilityChange();
}
function hideSelected() {
  state.selectedParts.forEach(p => setPartVisible(p, false));
  afterVisibilityChange();
}
function showAll() {
  viewer.parts.forEach(p => setPartVisible(p, true));
  afterVisibilityChange();
}

// ---------- tools ----------
const TOOL_KEYS: Record<string, Tool> = { d: "distance", m: "minDistance", r: "radius", c: "centerDistance", l: "arcLength", a: "angle", n: "point", b: "bbox" };

function setTool(t: Tool) {
  if (t === "bbox") { addMeasurement(measureBBox(viewer, state.selectedParts.length && state.selectedNode !== viewer.tree ? state.selectedParts : viewer.parts.filter(p => p.visible), nextColor())); return; }
  state.tool = t;
  state.picks = [];
  hl.pickMarks.clear();
  clearLive();
  $$("#tools button").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  updateHint();
  viewer.invalidate();
}

function updateHint() {
  const h = $("#tool-hint");
  if (state.tool === "select") {
    h.hidden = !viewer.parts.length;
    h.innerHTML = state.selection && !state.livePair
      ? `<b>Smart measure</b> · click a second point, edge or face to measure between them · <span class="muted">Esc to clear</span>`
      : `<b>Smart measure</b> · click a point, edge or face; a second click measures between them`;
    return;
  }
  const info = state.tool === "plane3" ? PLANE3_INFO : TOOL_INFO[state.tool];
  const n = state.picks.length;
  h.hidden = false;
  h.innerHTML = `<b>${info.title}</b> · ${info.hint} · pick ${n + 1}/${info.picks} · <span class="muted">Esc to cancel</span>`;
}

$$("#tools button").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));
const PLANE3_INFO = { title: "Section plane", picks: 3, hint: "Pick three points on the plane" };

const PALETTE = ["#e8590c", "#2f9e44", "#1c7ed6", "#ae3ec9", "#f08c00", "#0ca678", "#e03131", "#5f3dc4"];
let colorIdx = 0;
function nextColor() {
  const input = $<HTMLInputElement>("#m-color");
  const c = input.value;
  input.value = PALETTE[++colorIdx % PALETTE.length];
  return c;
}

function addMeasurement(m: Measurement) {
  state.measurements.push(m);
  state.selectedMeasurement = m.id;
  saveMeasurements();
  refreshMeasurements();
  const f = formatMeasurement(m);
  toast(`${f.title}: ${f.value}`);
}

function pickMark(p: THREE.Vector3) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(viewer.modelSize * 0.004, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf59f00, depthTest: false }));
  m.position.copy(p);
  m.renderOrder = 2000;
  hl.pickMarks.add(m);
}

function handlePick(snap: Snap | null) {
  if (state.tool === "select") {
    if (!snap) {
      state.selection = null;
      clearLive();
      showEntity(hl.selFace, hl.selEdge, null);
          selectNode(null);
      updateHint();
      return;
    }
    const ent = entityFromSnap(snap);
    // Highlight the edge a vertex sits on, but measure from the vertex itself.
    const shown = ent.kind === "point" && snap.edge ? { ...ent, kind: "edge" as const, edge: snap.edge } : ent;
    const first = state.selection;
    if (first && !state.livePair && !sameEntity(first, ent)) {
      showLive([first, ent]);
      showEntity(hl.selFace, hl.selEdge, shown);
      pickMark(first.point);
      return;
    }
    hl.pickMarks.clear();
    state.selection = ent;
    showEntity(hl.selFace, hl.selEdge, shown);
    const node = nodeForPart(snap.part);
    state.selectedNode = node;
    state.selectedParts = [snap.part];
    selectNode(node ?? null, true);
    if (!node) { state.selectedParts = [snap.part]; renderProps(); }
    showLive([ent]);
    return;
  }
  if (!snap) return;
  if (state.tool === "plane3") {
    state.picks.push(entityFromSnap(snap));
    pickMark(snap.point);
    if (state.picks.length < 3) { updateHint(); viewer.invalidate(); return; }
    const sp = section.addFromPoints(state.picks.map(p => p.point));
    if (!sp) toast("The three points are in line; pick points that span a plane", true);
    setTool("select");
    renderSections();
    return;
  }
  const info = TOOL_INFO[state.tool];
  const ent = entityFromSnap(snap);
  const needsPoint = state.tool === "distance" || state.tool === "angle3" || state.tool === "point";
  if (needsPoint) ent.kind = ent.kind === "face" && state.tool === "point" ? "face" : ent.kind;
  state.picks.push(ent);
  pickMark(ent.point);
  if (state.picks.length < info.picks) { updateHint(); viewer.invalidate(); return; }
  try {
    addMeasurement(measure(viewer, state.tool as MeasureType, state.picks, nextColor()));
  } catch (err) {
    toast(err instanceof MeasureError ? err.message : `Measurement failed: ${(err as Error).message}`, true);
  }
  state.picks = [];
  hl.pickMarks.clear();
  updateHint();
  viewer.invalidate();
}

function sameEntity(a: Entity, b: Entity) {
  if (a.part !== b.part || a.kind !== b.kind) return false;
  if (a.kind === "point") return a.point.distanceToSquared(b.point) < 1e-12;
  return a.kind === "edge" ? a.edge === b.edge : a.face === b.face;
}

/** Measures one entity (its size) or two (the relation between them) and shows it until the next click. */
function showLive(picks: Entity[]) {
  try {
    state.live = smartMeasure(viewer, picks, $<HTMLInputElement>("#m-color").value, { circleMode: state.circleMode });
    state.livePicks = picks;
  } catch (err) {
    state.live = null;
    state.livePicks = [];
    toast(`Measurement failed: ${(err as Error).message}`, true);
  }
  state.livePair = picks.length === 2;
  if (state.livePair) state.selection = null;
  refreshMeasurements();
  updateHint();
  viewer.invalidate();
}

function clearLive() {
  if (!state.live && !state.livePair) return;
  state.live = null;
  state.livePair = false;
  state.livePicks = [];
  hl.pickMarks.clear();
  refreshMeasurements();
}

/** Bounding box, volume, area and centre of gravity of the part the live entity belongs to. */
function showBody(part: Part) {
  state.live = smartBody(viewer, part, $<HTMLInputElement>("#m-color").value);
  state.livePicks = [];
  state.livePair = true;
  state.selection = null;
  hl.pickMarks.clear();
  showEntity(hl.selFace, hl.selEdge, null);
  refreshMeasurements();
  updateHint();
  viewer.invalidate();
}

function setCircleMode(mode: CircleMode) {
  state.circleMode = mode;
  if (state.livePicks.length === 2) showLive(state.livePicks);
}

function pinLive() {
  const m = state.live;
  if (!m) return;
  state.live = null;
  nextColor();
  addMeasurement(m);
}

/**
 * Details of the live result (or the selected pinned measurement) in a card in
 * the viewport corner, away from the model; the label on the model stays one line.
 */
/** Copies a displayed value; a single number with a unit is copied as the bare number. */
function copyValue(text: string) {
  const t = text.trim();
  const bare = /^[RØ]?S?Ø?\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|m|in|ft|°)$/.exec(t);
  const out = bare ? bare[1] : t;
  state.lastCopied = out;
  navigator.clipboard?.writeText(out).then(() => toast(`Copied ${out}`), () => toast(`Copy failed; value ${out}`, true));
}

function renderReadout() {
  const box = $("#readout");
  const m = state.live ?? state.measurements.find(x => x.id === state.selectedMeasurement);
  if (!m || !m.visible) { box.hidden = true; return; }
  const f = formatMeasurement(m);
  box.style.setProperty("--c", m.color);
  const det = f.pairs
    ? f.pairs.map(([k, x]) => `<span>${esc(k)} <b class="cp" title="Click to copy">${esc(x)}</b></span>`)
    : f.details.map(d => `<span>${esc(d)}</span>`);
  const unitOpts = UNIT_LIST.map(u => `<option${u === units.current ? " selected" : ""}>${u}</option>`).join("");
  const decOpts = ["", "0", "1", "2", "3", "4", "5", "6"].map(d => `<option value="${d}"${String(units.decimals ?? "") === d ? " selected" : ""}>${d === "" ? "auto" : `${d} dp`}</option>`).join("");
  box.innerHTML = `<div class="ttl"><span>${esc(f.title)}</span><span class="hud-units"><select data-hud="units" title="Units">${unitOpts}</select><select data-hud="decimals" title="Decimal places">${decOpts}</select><button class="x" title="Close (Esc)">✕</button></span></div>
    <div class="val"><b class="cp" title="Click to copy">${esc(f.value)}</b></div>${m === state.live && m.data.modes ? `<div class="modes seg">${CIRCLE_MODES.map(x => `<button data-cmode="${x.mode}" class="${x.mode === m.data.mode ? "on" : ""}">${x.label}</button>`).join("")}</div>` : ""}<div class="det">${det.join("")}</div><div class="acts"></div>`;
  box.querySelectorAll<HTMLElement>(".cp").forEach(el => el.addEventListener("click", () => copyValue(el.textContent ?? "")));
  box.querySelector<HTMLSelectElement>('[data-hud="units"]')!.addEventListener("change", e => setUnits((e.target as HTMLSelectElement).value as Unit));
  box.querySelector<HTMLSelectElement>('[data-hud="decimals"]')!.addEventListener("change", e => setDecimals((e.target as HTMLSelectElement).value));
  box.querySelector(".x")!.addEventListener("click", () => {
    if (m === state.live) handlePick(null);
    else { state.selectedMeasurement = null; refreshMeasurements(); }
  });
  box.querySelectorAll<HTMLElement>("[data-cmode]").forEach(b => b.addEventListener("click", () => setCircleMode(b.dataset.cmode as CircleMode)));
  const acts = box.querySelector(".acts")!;
  const add = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = label;
    b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (m === state.live) {
    add("📌 Pin", pinLive);
    const e = state.selection;
    if (e && !state.livePair && e.kind === "face" && e.face?.type === "plane") add("✂ Section here", () => addSectionFromFace(e));
    if (e && !state.livePair) add("⬚ Whole part", () => showBody(e.part));
  }
  box.hidden = false;
}


// ---------- pointer handling ----------
const lastPointer = { x: 0, y: 0 };
let downAt: { x: number; y: number; button: number } | null = null;
let moveQueued = false;
const canvas = viewer.renderer.domElement;

canvas.addEventListener("pointerdown", e => { downAt = { x: e.clientX, y: e.clientY, button: e.button }; });
canvas.addEventListener("pointerup", e => {
  if (!downAt || dragging) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const btn = downAt.button;
  downAt = null;
  if (moved > 4 || btn !== 0 || !viewer.parts.length) return;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const r = canvas.getBoundingClientRect();
  handlePick(snapper.pick(e.clientX - r.left, e.clientY - r.top));
});
canvas.addEventListener("pointermove", e => {
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  if (moveQueued || !viewer.parts.length) return;
  moveQueued = true;
  requestAnimationFrame(() => { moveQueued = false; hover(); });
});
canvas.addEventListener("pointerleave", () => { $("#snap-marker").hidden = true; showEntity(hl.hoverFace, hl.hoverEdge, null); });
canvas.addEventListener("contextmenu", e => e.preventDefault());

function hover() {
  if (downAt && (Math.abs(lastPointer.x - downAt.x) > 4 || Math.abs(lastPointer.y - downAt.y) > 4)) {
    $("#snap-marker").hidden = true; return; // orbiting
  }
  const r = canvas.getBoundingClientRect();
  const snap = snapper.pick(lastPointer.x - r.left, lastPointer.y - r.top);
  state.lastSnap = snap;
  const marker = $("#snap-marker");
  if (!snap) {
    marker.hidden = true;
    showEntity(hl.hoverFace, hl.hoverEdge, null);
    $("#st-snap").textContent = "";
    $("#st-coord").textContent = "";
    return;
  }
  const scr = snap.point.clone().project(viewer.camera);
  marker.hidden = false;
  marker.dataset.kind = snap.kind;
  marker.style.transform = `translate(${((scr.x + 1) / 2) * viewer.size.x}px, ${((1 - scr.y) / 2) * viewer.size.y}px)`;
  const labels: Record<string, string> = { onCap: "Section", vertex: "Vertex", midpoint: "Midpoint", circleCenter: "Centre", faceCenter: "Face centre", onEdge: "Edge", onFace: "Face" };
  const tag = (snap.section && snap.kind !== "onCap" ? "Cut " : "") + labels[snap.kind];
  marker.innerHTML = snap.kind === "onFace" ? "" : `<span class="snap-tag">${tag}</span>`;
  $("#st-snap").textContent = tag;
  $("#st-coord").textContent = fmtVec(snap.point) + (snap.normal ? `   n ${fmtVec(snap.normal, false)}` : "");
  const ent = entityFromSnap(snap);
  showEntity(hl.hoverFace, hl.hoverEdge, ent.kind === "point" ? null : ent);
}

// ---------- measurements list ----------
function refreshMeasurements() {
  const host = $("#m-list");
  $("#m-count").textContent = String(state.measurements.length);
  if (!state.measurements.length) host.innerHTML = `<p class="muted pad">Measurements you take appear here.</p>`;
  else {
    host.innerHTML = "";
    state.measurements.forEach((m, i) => {
      const f = formatMeasurement(m);
      const el = document.createElement("div");
      el.className = "m-item" + (m.id === state.selectedMeasurement ? " sel" : "");
      el.style.setProperty("--c", m.color);
      el.innerHTML = `<span class="dot"></span><span class="t">${i + 1}. ${esc(f.title)}</span>
        <span class="acts"><input type="color" value="${m.color}" title="Colour"><button title="Show/hide">${m.visible ? "👁" : "◌"}</button><button title="Delete">✕</button></span>
        <span class="val">${esc(f.value)}</span>`;
      el.addEventListener("click", () => { state.selectedMeasurement = m.id; refreshMeasurements(); });
      const [color, vis, del] = el.querySelectorAll<HTMLElement>("input, button");
      color.addEventListener("click", e => e.stopPropagation());
      color.addEventListener("input", e => { m.color = (e.target as HTMLInputElement).value; saveMeasurements(); refreshMeasurements(); });
      vis.addEventListener("click", e => { e.stopPropagation(); m.visible = !m.visible; saveMeasurements(); refreshMeasurements(); });
      del.addEventListener("click", e => { e.stopPropagation(); deleteMeasurement(m.id); });
      host.appendChild(el);
    });
  }
  annotations.sync(state.live ? [...state.measurements, state.live] : state.measurements, state.live?.id ?? state.selectedMeasurement);
  renderReadout();
}

function deleteMeasurement(id: string) {
  state.measurements = state.measurements.filter(m => m.id !== id);
  if (state.selectedMeasurement === id) state.selectedMeasurement = null;
  saveMeasurements();
  refreshMeasurements();
}

$("#labels").addEventListener("click", e => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".m-label")?.dataset.id;
  if (!id) return;
  state.selectedMeasurement = state.selectedMeasurement === id ? null : id;
  refreshMeasurements();
});

function saveMeasurements() { if (state.fileKey) storage.set(state.fileKey, JSON.stringify(state.measurements)); }
function loadMeasurements() {
  try { state.measurements = JSON.parse(storage.get(state.fileKey) ?? "[]"); } catch { state.measurements = []; }
  state.selectedMeasurement = null;
  refreshMeasurements();
  if (state.measurements.length) toast(`Restored ${state.measurements.length} saved measurement(s)`);
}

$("#m-clear").addEventListener("click", () => {
  if (!state.measurements.length || !confirm("Delete all measurements for this model?")) return;
  state.measurements = [];
  saveMeasurements();
  refreshMeasurements();
});
$("#m-json").addEventListener("click", () => state.measurements.length ? measurementsJson(state.measurements, state.fileName) : toast("No measurements yet"));
$("#m-csv").addEventListener("click", () => state.measurements.length ? measurementsCsv(state.measurements, state.fileName) : toast("No measurements yet"));

$$(".tabs button").forEach(b => b.addEventListener("click", () => {
  $$(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  $$(".tab").forEach(t => t.classList.toggle("on", t.id === `tab-${b.dataset.tab}`));
}));

// ---------- display / views ----------
function setMode(m: DisplayMode) {
  viewer.setMode(m);
  section.rebuild();
  $$("#display-mode button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
}
$$("#display-mode button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode as DisplayMode)));
function setProjection(p: "perspective" | "orthographic") {
  viewer.setProjection(p);
  $$("#projection button").forEach(b => b.classList.toggle("on", b.dataset.proj === p));
  if (dragControls) dragControls.camera = viewer.camera;
  section.updateCamera();
}
$$("#projection button").forEach(b => b.addEventListener("click", () => setProjection(b.dataset.proj as "perspective")));
const VIEWS: Record<string, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1, 0.8), front: new THREE.Vector3(0, -1, 0), back: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, 0, 1), bottom: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), left: new THREE.Vector3(-1, 0, 0),
};
$$("#views button").forEach(b => b.addEventListener("click", () => {
  const v = b.dataset.view!;
  if (v === "fit") viewer.fit(); else viewer.viewFrom(VIEWS[v]);
}));
$<HTMLInputElement>("#ao").addEventListener("change", e => { viewer.aoEnabled = (e.target as HTMLInputElement).checked; viewer.invalidate(); });

function applyThemeToViewer() {
  const dark = document.documentElement.dataset.theme === "dark";
  viewer.setEdgeColor(dark ? 0x0b0d12 : 0x14181f);
}
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  storage.set("sv:theme", next);
  applyThemeToViewer();
});
$("#help-btn").addEventListener("click", () => $<HTMLDialogElement>("#help").showModal());

function setUnits(u: Unit) {
  units.current = u;
  $<HTMLSelectElement>("#units").value = u;
  storage.set("sv:units", u);
  refreshMeasurements();
  renderProps();
  renderSections();
}
function setDecimals(d: string) {
  units.decimals = d === "" ? null : Number(d);
  $<HTMLSelectElement>("#decimals").value = d;
  storage.set("sv:decimals", d);
  refreshMeasurements();
  renderProps();
  renderSections();
}
$<HTMLSelectElement>("#units").addEventListener("change", e => setUnits((e.target as HTMLSelectElement).value as Unit));
$<HTMLSelectElement>("#decimals").addEventListener("change", e => setDecimals((e.target as HTMLSelectElement).value));
{
  const u = storage.get("sv:units") as Unit | null;
  if (u && UNIT_LIST.includes(u)) { units.current = u; $<HTMLSelectElement>("#units").value = u; }
  const d = storage.get("sv:decimals");
  if (d && /^[0-6]$/.test(d)) { units.decimals = Number(d); $<HTMLSelectElement>("#decimals").value = d; }
}
$$<HTMLInputElement>("[data-snap]").forEach(c => c.addEventListener("change", () => {
  (SNAP_FILTERS as Record<string, boolean>)[c.dataset.snap!] = c.checked;
}));

// ---------- section ----------
snapper.sectionSource = () => section.profiles();
section.onDragging = on => { dragging = on; };
section.onChange = () => updateSectionReadouts();

function addSection(kind: string) {
  if (!viewer.parts.length) return;
  if (!section.canAdd) { toast("Up to 3 section planes", true); return; }
  const c = viewer.computeBounds().getCenter(new THREE.Vector3());
  let axis: THREE.Vector3, label: string;
  if (kind === "x" || kind === "y" || kind === "z") {
    axis = new THREE.Vector3(kind === "x" ? 1 : 0, kind === "y" ? 1 : 0, kind === "z" ? 1 : 0);
    label = { x: "YZ", y: "XZ", z: "XY" }[kind];
  } else if (kind === "view") {
    axis = viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
    label = "View";
  } else if (kind === "3pt") {
    setTool("plane3");
    return;
  } else {
    const e = state.selection;
    if (!e || e.kind !== "face" || e.face?.type !== "plane") { toast("Select a planar face first", true); return; }
    addSectionFromFace(e);
    return;
  }
  section.add(label, axis, c.dot(axis));
  renderSections();
}
function addSectionFromFace(e: Entity) {
  if (!section.canAdd) { toast("Up to 3 section planes", true); return null; }
  const n = new THREE.Vector3(...e.face!.normal!);
  const p = viewer.toWorld(e.part, e.face!.centroid);
  const sp = section.add("Face", n, p.dot(n) - viewer.modelSize * 1e-4);
  renderSections();
  return sp;
}
$$("[data-sec]").forEach(b => b.addEventListener("click", () => addSection(b.dataset.sec!)));
$("#sec-clear").addEventListener("click", () => { section.clear(); renderSections(); });
const onChk = (id: string, fn: (on: boolean) => void) => $<HTMLInputElement>(id).addEventListener("change", e => fn((e.target as HTMLInputElement).checked));
onChk("#caps", on => section.setCaps(on));
onChk("#hatch", on => section.setHatch(on));
onChk("#caps-part", on => section.setCapsByPart(on));
onChk("#profiles", on => section.setProfiles(on));
onChk("#snap-plane", on => { SNAP_FILTERS.planeOnly = on; });
$<HTMLInputElement>("#cap-color").addEventListener("input", e => section.setCapColor((e.target as HTMLInputElement).value));
$<HTMLInputElement>("#profile-color").addEventListener("input", e => section.setProfileColor((e.target as HTMLInputElement).value));

const unitFactor = unitMm;

function renderSections() {
  const host = $("#sec-list");
  host.innerHTML = section.planes.length ? "" : `<p class="muted" style="margin:4px 0">Up to 3 planes. The cut curves are drawn and can be snapped to for measuring.</p>`;
  $$<HTMLButtonElement>("#sec-add button").forEach(b => (b.disabled = !section.canAdd));
  const f = unitFactor();
  for (const sp of section.planes) {
    const [lo, hi] = section.range(sp);
    const ang = section.angles(sp);
    const el = document.createElement("div");
    el.className = "sp" + (section.active === sp ? " active" : "");
    el.dataset.id = sp.id;
    const g = section.active === sp ? section.gizmoMode : null;
    el.innerHTML = `<div class="hd"><input type="checkbox" ${sp.enabled ? "checked" : ""} title="Enable"><span>${esc(sp.label)}</span>
      <span class="spacer"></span>
      <button class="btn tiny ${g === "translate" ? "on" : ""}" data-a="move" title="Move gizmo (drag the arrow)">↕</button>
      <button class="btn tiny ${g === "rotate" ? "on" : ""}" data-a="rot" title="Rotate gizmo (drag the rings)">⟳</button>
      <button class="btn tiny" data-a="flip" title="Flip the kept side">⇅</button>
      <button class="btn tiny" data-a="del" title="Remove">✕</button></div>
      <div class="ctl"><input type="range" data-k="range" min="${lo}" max="${hi}" step="${(hi - lo) / 1000 || 0.001}" value="${sp.offset}">
      <input type="number" data-k="off" step="any" value="${(sp.offset / f).toFixed(4)}" title="Offset along the normal (${units.current})"></div>
      <div class="ctl"><span class="lbl">Step</span><input type="number" data-k="step" step="any" min="0" value="${(Math.max((hi - lo) / 100, 1e-6) / f).toPrecision(3)}" title="Step (${units.current})">
      <button class="btn tiny" data-a="minus">−</button><button class="btn tiny" data-a="plus">+</button></div>
      <div class="ctl angles"><span class="lbl">Az</span><input type="number" data-k="az" step="1" value="${ang.az.toFixed(2)}" title="Normal azimuth from +X about Z (°)">
      <span class="lbl">El</span><input type="number" data-k="el" step="1" value="${ang.el.toFixed(2)}" title="Normal elevation from the XY plane (°)"></div>
      <div class="stat" data-k="stat"></div>`;
    const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const chk = q<HTMLInputElement>('input[type="checkbox"]'), range = q<HTMLInputElement>('[data-k="range"]'), num = q<HTMLInputElement>('[data-k="off"]');
    const step = q<HTMLInputElement>('[data-k="step"]'), az = q<HTMLInputElement>('[data-k="az"]'), elv = q<HTMLInputElement>('[data-k="el"]');
    chk.addEventListener("change", () => { section.setEnabled(sp, chk.checked); updateSectionDeps(); });
    range.addEventListener("input", () => { section.setOffset(sp, parseFloat(range.value)); num.value = (sp.offset / f).toFixed(4); });
    num.addEventListener("change", () => { const v = parseFloat(num.value) * f; if (isFinite(v)) { section.setOffset(sp, v); range.value = String(v); } });
    const nudge = (k: number) => {
      const d = (parseFloat(step.value) || 0) * f * k;
      section.setOffset(sp, sp.offset + d);
      num.value = (sp.offset / f).toFixed(4); range.value = String(sp.offset);
    };
    q('[data-a="minus"]').addEventListener("click", () => nudge(-1));
    q('[data-a="plus"]').addEventListener("click", () => nudge(1));
    const angChange = () => { const a = parseFloat(az.value), e = parseFloat(elv.value); if (isFinite(a) && isFinite(e)) { section.setAngles(sp, a, e); renderSections(); } };
    az.addEventListener("change", angChange);
    elv.addEventListener("change", angChange);
    q('[data-a="move"]').addEventListener("click", () => { section.setGizmo(sp, "translate"); renderSections(); });
    q('[data-a="rot"]').addEventListener("click", () => { section.setGizmo(sp, "rotate"); renderSections(); });
    q('[data-a="flip"]').addEventListener("click", () => section.flip(sp));
    q('[data-a="del"]').addEventListener("click", () => { section.remove(sp); renderSections(); });
    host.appendChild(el);
  }
  updateSectionReadouts();
  updateSectionDeps();
}

/** Refreshes numbers in the plane cards in place (gizmo drags, profile updates) without rebuilding them. */
function updateSectionReadouts() {
  const f = unitFactor();
  for (const sp of section.planes) {
    const el = document.querySelector<HTMLElement>(`#sec-list .sp[data-id="${sp.id}"]`);
    if (!el) continue;
    const set = (k: string, val: string) => {
      const i = el.querySelector<HTMLInputElement>(`[data-k="${k}"]`);
      if (i && document.activeElement !== i) i.value = val;
    };
    const ang = section.angles(sp);
    set("off", (sp.offset / f).toFixed(4));
    set("az", ang.az.toFixed(2));
    set("el", ang.el.toFixed(2));
    if (section.active === sp) {
      const [lo, hi] = section.range(sp);
      const r = el.querySelector<HTMLInputElement>('[data-k="range"]')!;
      r.min = String(lo); r.max = String(hi);
      if (document.activeElement !== r) r.value = String(sp.offset);
    }
    const stat = el.querySelector<HTMLElement>('[data-k="stat"]')!;
    const res = sp.result;
    if (!sp.enabled || !res) { stat.textContent = ""; continue; }
    const curves = res.profiles.reduce((a, p) => a + p.edges.length, 0);
    const circles = res.profiles.reduce((a, p) => a + p.edges.filter(e => e.type === "circle").length, 0);
    stat.textContent = `Cut area ${fmtArea(res.area)} · ${res.profiles.length} part(s) · ${curves} curves${circles ? ` · ${circles} circles` : ""}`;
  }
}
function updateSectionDeps() {
  // Overlays follow the same clipping.
  for (const o of [hl.hoverFace, hl.selFace]) (o.material as THREE.Material).clippingPlanes = viewer.clipPlanes;
  viewer.invalidate();
}

// ---------- explode & manual drag ----------
$<HTMLInputElement>("#explode").addEventListener("input", e => {
  const f = parseFloat((e.target as HTMLInputElement).value);
  viewer.setExplode(f);
  $("#explode-val").textContent = `${Math.round(f * 100)}%`;
  section.rebuild();
  refreshSelectionOverlays();
});
let dragControls: TransformControls | null = null;
let dragging = false;
function stopDrag() {
  if (!dragControls) return;
  dragControls.detach();
  viewer.scene.remove(dragControls.getHelper());
  dragControls.dispose();
  dragControls = null;
  $("#drag-part").classList.remove("on");
  viewer.invalidate();
}
$("#drag-part").addEventListener("click", () => {
  if (dragControls) { stopDrag(); return; }
  const p = state.selectedParts.length === 1 ? state.selectedParts[0] : state.selection?.part;
  if (!p) { toast("Select a single part first", true); return; }
  dragControls = new TransformControls(viewer.camera, canvas);
  dragControls.setMode("translate");
  dragControls.setSize(0.8);
  dragControls.attach(p.group);
  viewer.scene.add(dragControls.getHelper());
  $("#drag-part").classList.add("on");
  dragControls.addEventListener("dragging-changed", (ev: any) => {
    dragging = ev.value;
    viewer.controls.enabled = !ev.value;
    if (!ev.value) {
      const base = p.explodeVec.clone().multiplyScalar(viewer.explodeFactor * 1.2);
      p.userOffset.copy(p.group.position).sub(base);
      section.rebuild();
      refreshSelectionOverlays();
    }
  });
  dragControls.addEventListener("change", () => viewer.invalidate());
});
$("#reset-drag").addEventListener("click", () => {
  viewer.parts.forEach(p => p.userOffset.set(0, 0, 0));
  viewer.updatePartPositions();
  section.rebuild();
  refreshSelectionOverlays();
});
function refreshSelectionOverlays() {
  showEntity(hl.selFace, hl.selEdge, state.selection);
  hl.pickMarks.clear();
}

// ---------- mass properties ----------
const matSel = $<HTMLSelectElement>("#material");
matSel.innerHTML = MATERIALS.map((m, i) => `<option value="${i}">${m.name} (${m.density})</option>`).join("") + `<option value="custom">Custom…</option>`;
matSel.addEventListener("change", () => {
  if (matSel.value !== "custom") $<HTMLInputElement>("#density").value = String(MATERIALS[+matSel.value].density);
});
$<HTMLInputElement>("#density").addEventListener("input", () => (matSel.value = "custom"));
let lastMass: [string, string][] = [];
function runMass() {
  if (!viewer.parts.length) return;
  const parts = state.selectedParts.length && state.selectedNode !== viewer.tree ? state.selectedParts : viewer.parts.filter(p => p.visible);
  const density = parseFloat($<HTMLInputElement>("#density").value) || 0;
  const r = massProperties(viewer, parts, density);
  lastMass = [
    ["Scope", parts.length === viewer.parts.length ? "whole model" : `${parts.length} part(s)`],
    ["Density", `${density} g/cm³`],
    ["Volume", fmtVol(r.volume)], ["Mass", fmtMass(r.mass)], ["Surface area", fmtArea(r.area)],
    ["Centre of mass", fmtVec(r.com)],
    ["Bounding box", `${fmtLen(r.bbox.x, false)} × ${fmtLen(r.bbox.y, false)} × ${fmtLen(r.bbox.z)}`],
    ["Box volume", fmtVol(r.bboxVolume)], ["Fill ratio", r.bboxVolume ? `${((r.volume / r.bboxVolume) * 100).toFixed(1)} %` : "-"],
  ];
  if (r.openParts.length) lastMass.push(["Warning", `${r.openParts.length} open shell(s): volume not reliable`]);
  $("#mass-out").innerHTML = kv(lastMass.map(([k, v]) => [k, esc(v)]));
  hl.com.position.copy(r.com);
  hl.com.scale.setScalar(viewer.modelSize * 0.006);
  hl.com.visible = $<HTMLInputElement>("#com-show").checked;
  viewer.invalidate();
}
$("#mass-run").addEventListener("click", runMass);
$<HTMLInputElement>("#com-show").addEventListener("change", e => { hl.com.visible = (e.target as HTMLInputElement).checked && lastMass.length > 0; viewer.invalidate(); });

// ---------- analysis ----------
let thkJob: { cancelled: boolean } | null = null;
$("#draft-run").addEventListener("click", () => {
  if (!viewer.parts.length) return;
  clearAnalysis(viewer);
  const sel = $<HTMLSelectElement>("#pull").value;
  let pull: THREE.Vector3;
  if (sel === "face") {
    const e = state.selection;
    if (!e || e.kind !== "face" || !e.face?.normal) { toast("Select a planar face for the pull direction", true); return; }
    pull = new THREE.Vector3(...e.face.normal);
  } else if (sel === "view") pull = viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
  else pull = new THREE.Vector3(...sel.split(",").map(Number));
  const min = parseFloat($<HTMLInputElement>("#draft-min").value) || 0;
  const s = draftAnalysis(viewer, pull, min);
  const tot = s.positive + s.negative + s.insufficient || 1;
  $("#draft-legend").hidden = false;
  $("#thk-legend").hidden = true;
  $("#analysis-out").innerHTML = kv([
    ["Pull", fmtVec(pull.normalize(), false)],
    ["Positive", `${((s.positive / tot) * 100).toFixed(1)} % of vertices`],
    ["Negative", `${((s.negative / tot) * 100).toFixed(1)} %`],
    ["Needs draft", `${((s.insufficient / tot) * 100).toFixed(1)} %`],
  ]);
});
$("#thk-run").addEventListener("click", async () => {
  if (!viewer.parts.length) return;
  if (thkJob) { thkJob.cancelled = true; return; }
  clearAnalysis(viewer);
  const f = unitMm();
  const tMin = (parseFloat($<HTMLInputElement>("#thk-min").value) || 0) * f;
  const tMax = (parseFloat($<HTMLInputElement>("#thk-max").value) || 1) * f;
  thkJob = { cancelled: false };
  const btn = $("#thk-run");
  btn.textContent = "Cancel";
  const r = await thicknessAnalysis(viewer, tMin, tMax, k => ($("#analysis-out").innerHTML = `<span class="muted">Ray casting… ${(k * 100).toFixed(0)} %</span>`), thkJob);
  btn.textContent = "Analyse";
  const cancelled = thkJob.cancelled;
  thkJob = null;
  if (cancelled) { clearAnalysis(viewer); $("#analysis-out").innerHTML = ""; return; }
  $("#thk-legend").hidden = false;
  $("#draft-legend").hidden = true;
  $("#analysis-out").innerHTML = kv([
    ["Thinnest wall", isFinite(r.min) ? fmtLen(r.min) : "-"],
    ["At", r.at ? fmtVec(r.at) : "-"],
    ["Below min", `${r.thin} of ${r.samples} samples`],
  ]);
  if (r.at) { hl.com.position.copy(r.at); hl.com.scale.setScalar(viewer.modelSize * 0.006); hl.com.visible = true; }
  viewer.invalidate();
});
$("#analysis-clear").addEventListener("click", () => {
  clearAnalysis(viewer);
  $("#analysis-out").innerHTML = "";
  $("#draft-legend").hidden = $("#thk-legend").hidden = true;
  hl.com.visible = false;
  viewer.invalidate();
});

// ---------- export ----------
const baseName = () => state.fileName.replace(/\.[^.]+$/, "") || "model";
function bgColor() { return getComputedStyle(document.documentElement).getPropertyValue("--vp-top").trim() || "#ffffff"; }
for (const [id, transparent] of [["#png", false], ["#png-t", true]] as const) {
  $(id).addEventListener("click", () => {
    if (!viewer.parts.length) return;
    const scale = parseInt($<HTMLSelectElement>("#png-scale").value);
    const c = snapshot(viewer, annotations, { scale, transparent, background: bgColor() });
    c.toBlob(b => b && download(b, `${baseName()}${transparent ? "-transparent" : ""}.png`), "image/png");
  });
}
$$("[data-export]").forEach(b => b.addEventListener("click", async () => {
  if (!viewer.parts.length) return;
  try { await exportMesh(viewer, b.dataset.export as "stl", baseName()); }
  catch (err) { toast(`Export failed: ${(err as Error).message}`, true); }
}));
function report() {
  if (!viewer.parts.length) return;
  if (!lastMass.length) runMass();
  const s = viewer.computeBounds().getSize(new THREE.Vector3());
  const m = state.meta;
  const meta: [string, string][] = [
    ["File", state.fileName], ["Parts", String(viewer.parts.length)],
    ["Overall size", `${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z)}`],
  ];
  if (m) {
    meta.push(["Protocol", m.protocol]);
    if (m.system) meta.push(["Created with", m.system]);
    if (m.timestamp) meta.push(["Timestamp", m.timestamp]);
    if (m.materials.length) meta.push(["Materials", m.materials.join(", ")]);
  }
  const image = snapshot(viewer, annotations, { scale: 2, transparent: false, background: "#ffffff" });
  inspectionReport({ fileName: state.fileName, meta, mass: lastMass, measurements: state.measurements, image });
}
$("#report").addEventListener("click", report);
$("#m-pdf").addEventListener("click", report);

// ---------- keyboard ----------
window.addEventListener("keydown", e => {
  const t = e.target as HTMLElement;
  if (t.matches("input, select, textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); $<HTMLInputElement>("#file-input").click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "escape") {
    if (state.tool !== "select") setTool("select");
    else { handlePick(null); state.selectedMeasurement = null; refreshMeasurements(); }
    stopDrag();
    if (section.active) { section.setGizmo(null, null); renderSections(); }
    return;
  }
  if (!viewer.parts.length) return;
  if (k === "f") viewer.fit();
  else if (k === "0") viewer.viewFrom(VIEWS.iso);
  else if ("12345".includes(k)) setMode((["shadedEdges", "shaded", "wireframe", "hlr", "xray"] as DisplayMode[])[+k - 1]);
  else if (k === "p") setProjection("perspective");
  else if (k === "o") setProjection("orthographic");
  else if (k === "i") isolateSelected();
  else if (k === "h") hideSelected();
  else if (k === "u") showAll();
  else if ((k === "delete" || k === "backspace") && state.selectedMeasurement) deleteMeasurement(state.selectedMeasurement);
  else if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

// ---------- fps ----------
{
  let frames = 0, last = performance.now();
  viewer.onRender(() => frames++);
  setInterval(() => {
    const now = performance.now();
    $("#st-fps").textContent = frames ? `${Math.round((frames * 1000) / (now - last))} fps` : "idle";
    frames = 0; last = now;
  }, 1000);
}

// ?url=… opens a STEP file from a URL (same origin or CORS-enabled).
{
  const url = new URLSearchParams(location.search).get("url");
  if (url) {
    fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(buf => openBuffer(buf, decodeURIComponent(url.split("/").pop() || "model.step")))
      .catch(err => toast(`Could not load ${url}: ${err.message}`, true));
  }
}

renderProps();

// Debug/test handle: always in dev, and with ?debug in a build (used by tests/smoke.mjs).
if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) Object.assign(window, { __sv: { viewer, state, snapper, section, annotations, handlePick, setTool, showBody, setCircleMode, setUnits, setDecimals } });
