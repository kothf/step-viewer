import "./style.css";
import type { NamedView } from "./model/types";
import { bindCommandTips } from "./tooltip";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Viewer, type DisplayMode, type Part } from "./viewer/Viewer";
import { NavCube } from "./viewer/NavCube";
import { DocTabs, type DocTab } from "./docTabs";
import { journalDrop, packPart, PART_EXT } from "./model/file";
import type { PartTab } from "./model/controller";
import type { AsmTab } from "./asm/controller";
import type { DrawingTab } from "./drawing/workspace";
import { bindNavigation } from "./viewer/navigation";
import { SurfaceAnalysis } from "./viewer/Analysis";
import { SectionManager, type SectionPlane } from "./viewer/Section";
import { profileDrawing, toDxf, toSvg } from "./tools/profileExport";
import { quadrants, virtualCorners, Snapper, SNAP_FILTERS, SEL_FILTER, type Snap } from "./tools/Snapper";
import { Annotations } from "./tools/Annotations";
import { VaultPanel } from "./pdm/panel";
import { VaultMenu } from "./pdm/menu";
import { useMemoryFolders } from "./pdm/folders";
import {
  CIRCLE_MODES, describeEntity, entityFromSnap, formatMeasurement, makeNote, measure, measureBBox, MeasureError, smartBody, smartMeasure, TOOL_INFO, tx,
  type CircleMode,
  type Entity, type Measurement, type MeasureSource, type MeasureType, type PickRef,
} from "./tools/measure";
import { massProperties, type MassResult } from "./tools/analysis";
import { pickMaterial } from "./materialPicker";
import { combine, massReport, principal, type Combined, type Frame } from "./tools/inertia";
import { inertiaUnit, massPanelHtml, massText, type MassView } from "./tools/massPanel";
import { exportMesh, inspectionReport, measurementsCsv, measurementsJson, snapshot, download } from "./tools/exporters";
import { csys, makeCsys, type Csys } from "./tools/csys";
import { fmtArea, fmtLen, fmtMass, fmtNum, fmtVec, fmtVol, unitMm, units, type Unit } from "./tools/units";
import { readStepMeta, type StepMeta } from "./stepMeta";
import { analyzeMesh, type EdgeInfo, type PartData, type TreeNode, type V3 } from "./topology";
import ImportWorker from "./worker/import.worker?worker";
import { GerberView } from "./gerber/GerberView";
import { bindGerberPanel } from "./gerber/panel";
import { isPcbName, sniff } from "./gerber/load";
import { bindModal, bindTabs, busy, confirmModal, emptyState, initConfirmCorners, initModals, initPanels, storage, toast, trapFocus } from "./ui";
import { lang, onLangChange, setLang, startI18n, t, withLang } from "./i18n";
import { bindCommandBar, onCmTab, relabelCmTabs, setCmTabs, type CmTabId } from "./commandBar";
import { renderHelp } from "./help";
import { hint, relocalizeHint, setTips, tipsOn } from "./hints";
import { initTutorial } from "./tutorialUi";
import { KernelClient, type KernelStatus } from "./kernel/client";
import { isMeshName, parseMesh } from "./meshLoad";
import { isSolidWorksName } from "./sw/container";
import { ModelController } from "./model/controller";
import { gestureDialog } from "./gestureUi";
import { openPrefs } from "./prefsUi";
import { getPref, onPrefs } from "./prefs";
import { DrawingWorkspace } from "./drawing/workspace";
import { isDrawingName } from "./drawing/file";
import { AsmController } from "./asm/controller";
import { MotionManager } from "./motion/manager";
import { flattenSubs } from "./asm/patterns";
import { makeGrip, rememberDialogSizes } from "./resize";
import { FileMenu, type LiveKind, type PackDoc } from "./fileMenu";
import { recentAdd, recentFiles, recentList } from "./recent";
import { drawingOf, peekDrawing, uniqueDrawings, type FoundDrawing, type ModelKey } from "./drawing/findDrawing";
import { packAsm, ASM_EXT } from "./asm/file";
import { bindValueDrops, dragValue } from "./valueDrop";
import { bindLongPress } from "./longPress";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------- theme (before the viewer reads colours) ----------
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = storage.get("sv:theme") ?? (prefersDark ? "dark" : "light");
// Interface language: translate the static page now and whatever code adds later.
startI18n();

const vpEl = $("#viewport");
const viewer = new Viewer(vpEl);
const section = new SectionManager(viewer);
/** The plane of the sketch Section toggle (FR-SK-006), removed when the sketch closes. */
let skSection: SectionPlane | null = null;
const snapper = new Snapper(viewer);
const annotations = new Annotations(viewer, $("#labels"));
new NavCube($<HTMLCanvasElement>("#navcube"), viewer);
// A lost WebGL context blanks the 3D view (only the HTML labels stay). The browser usually gives it back within a
// moment and the viewer redraws; if it does not, say so instead of leaving an empty view that looks like lost work.
let ctxLostTimer = 0;
viewer.onContext(lost => {
  clearTimeout(ctxLostTimer);
  if (lost) ctxLostTimer = window.setTimeout(() => { if (viewer.contextLost) toast(t("The graphics card reset and the 3D view could not be restored. Save your work, then reload the page (unsaved parts are offered for recovery)."), true); }, 3000);
  else toast(t("The graphics card reset; the 3D view was restored."));
});
applyThemeToViewer();
// Part modelling: command bar, Features tab, sketcher; its parts show through showPartModel.
/** Document tabs at the bottom (FR-DOC-003); set up once the controllers exist. */
let docs: DocTabs | undefined;
const modeller = new ModelController({
  viewer,
  saved: (name, bytes) => void recentAdd([{ name, data: bytes }]),
  vp: vpEl,
  show: (data, name, first) => showPartModel(data, name, first),
  faceAt: (x, y) => {
    if (!SEL_FILTER.faces) return null;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const f = faceUnder(x - r.left, y - r.top);
    return f ? { faceId: f.face.id, point: f.point.toArray() as [number, number, number] } : null;
  },
  snapAt: (x, y) => {
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const s = snapper.pick(x - r.left, y - r.top);
    return s && s.kind !== "onEdge" && s.kind !== "onFace" && s.kind !== "onCap" ? { point: s.point.toArray() as [number, number, number], kind: s.kind } : null;
  },
  edgeAt: (x, y) => {
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const s = snapper.pick(x - r.left, y - r.top);
    if (s?.edge) return { edge: s.edge };
    if (s?.face) return { faceId: s.face.id };
    if (!SEL_FILTER.faces) return null;
    const f = faceUnder(x - r.left, y - r.top);
    return f ? { faceId: f.face.id } : null;
  },
  selectedFace: () => (state.selection?.kind === "face" && state.selection.face ? state.selection.face.id : null),
  selectedEdge: () => (state.selection?.kind === "edge" && state.selection.edge ? state.selection.edge : null),
  setUnits: u => applyUnits(u),
  setMaterial: m => {
    if (!m) return;
    massMat = m.name;
    renderMaterials();
    $<HTMLInputElement>("#density").value = String(m.density);
    validateDensity();
  },
  normalTo: n => normalTo(n),
  view: v => { if (v === "fit") viewer.fit(); else if (v === "normal") normalTo(); else if (VIEWS[v]) viewer.viewFrom(VIEWS[v]); },
  setCsys: (c, quiet) => setCsys(c ? { ...makeCsys(c.name, c.o, c.z, c.x), src: c.src } : null, true, quiet),
  clearPick: () => { if (state.tool !== "select") setTool("select"); handlePick(null); },
  setDoc: label => setDoc(label, "ready"),
  selectLeftTab: tab => showLeftTab(tab),
  sketchSection: pl => {
    if (skSection) { if (section.planes.includes(skSection)) section.remove(skSection); skSection = null; }
    if (pl) {
      if (!section.canAdd) toast(t("Up to 3 section planes"), true);
      else {
        const n = new THREE.Vector3(...pl.n).normalize();
        skSection = section.add("Sketch", n, n.dot(new THREE.Vector3(...pl.o)) + viewer.modelSize * 1e-4);
        section.setGizmo(null, null);
      }
    }
    renderSections();
  },
  leaveOthers: () => { docs?.before3d(); asm.close(); },
  opened: label => docs?.opened("part", label),
  openNames: () => (docs?.tabs ?? []).map(x => x.label.replace(/\s*•$/, "").replace(/\.[^.]+$/, "")),
  appVersion: __APP_VERSION__,
}, new URL("occt/", document.baseURI).href);
// Assemblies (FRS 10): components placed by the kernel, shown as one viewer part each.
const asm = new AsmController({
  viewer,
  saved: (name, bytes) => void recentAdd([{ name, data: bytes }]),
  vp: vpEl,
  show: (parts, tree, first) => showModelled(parts, tree, tree.name, first),
  partAt: (x, y) => {
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const f = faceUnder(x - r.left, y - r.top);
    return f ? { idx: viewer.parts.indexOf(f.part), face: f.part.data.faces.indexOf(f.face), point: f.point.toArray() as [number, number, number] } : null;
  },
  facesAt: (x, y) => {
    const r = viewer.renderer.domElement.getBoundingClientRect();
    return snapper.facesUnder(x - r.left, y - r.top).map(s => ({ idx: viewer.parts.indexOf(s.part!), face: s.part!.data.faces.indexOf(s.face!) }));
  },
  setDoc: label => setDoc(label, "ready"),
  selectLeftTab: tab => showLeftTab(tab),
  leaveOthers: () => { docs?.before3d(); ++loadToken; modeller.close(); },
  opened: label => docs?.opened("asm", label),
  openParts: () => (docs?.tabs ?? []).filter(x => x.kind === "part" && x.state).map(x => { const st = x.state as PartTab; return { doc: st.store.doc, fileName: st.fileName || `${st.store.doc.name}.mcadprt` }; }),
  // Edit part in place: the part takes over the assembly's tab, and Return to assembly takes it back.
  editPart: (doc, file, label, back, ctx) => (docs ? docs.inPlaceSwitch(() => modeller.editIn(doc, file, { label, back: d => docs!.inPlaceSwitch(() => back(d)) }, ctx)) : modeller.editIn(doc, file, { label, back }, ctx)),
  openPart: () => modeller.openPart(),
  appVersion: __APP_VERSION__,
}, new URL("occt/", document.baseURI).href);
// Motion studies (FR-FT-122): the timeline pane under the view, driving the assembly's mates.
const motion = new MotionManager(asm, viewer);
$("#app-version").textContent = `v${__APP_VERSION__}`;
// Offline start (FR-STO-030): the service worker keeps this version's app files. Not in dev, and not
// under test automation unless the page asks for it (?sw), so tests see the network as it is.
{
  const qs = new URLSearchParams(location.search);
  if (!import.meta.env.DEV && "serviceWorker" in navigator && location.protocol.startsWith("http") && (!navigator.webdriver || qs.has("sw")) && !qs.has("nosw")) {
    addEventListener("load", () => {
      const first = !navigator.serviceWorker.controller;
      // The version in the URL gives every release its own worker URL: a CDN that keeps sw.js for a day
      // (aerocat.tech's Cloudflare did) would otherwise hand out an old worker that precaches old files.
      navigator.serviceWorker.register(`./sw.js?v=${__APP_VERSION__}`, { updateViaCache: "none" }).then(reg => {
        const w = reg.installing;
        if (first && w) w.addEventListener("statechange", () => { if (w.state === "activated") toast(t("MöbiusCAD now also starts offline in this browser.")); });
      }).catch(() => { /* offline start is a bonus */ });
    });
  }
}
$(".brand").title = `MöbiusCAD v${__APP_VERSION__}`;

// ---------- state ----------
const UNIT_LIST: Unit[] = ["mm", "cm", "m", "in", "ft"];
/** "plane3" picks three points for a section plane; "sectionFace" cuts on the next face clicked (the Section button). */
type Tool = MeasureType | "select" | "plane3" | "sectionFace";
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
  /** Readout card beside the measurement (true) or docked in the bottom-left corner (default). */
  readoutFloat: storage.get("sv:readout") === "float",
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
screenSized(hl.com, 5);
hl.com.renderOrder = 2000;
hl.com.visible = false;
viewer.scene.add(hl.hoverFace, hl.selFace, hl.hoverEdge, hl.selEdge, hl.pickMarks, hl.com);
/** Principal axes of inertia through the centre of mass (Mass properties panel): Px red, Py green, Pz blue. */
const mpAxes = new THREE.Group();
for (const color of [0xe03131, 0x2f9e44, 0x1c7ed6]) {
  const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false }));
  l.renderOrder = 2000;
  mpAxes.add(l);
}
mpAxes.visible = false;
viewer.scene.add(mpAxes);
// X, Y, Z axes from the model origin (0, 0, 0), always on top, with letters at the tips.
const originAxes = (() => {
  const group = new THREE.Group();
  const tags: HTMLDivElement[] = [];
  ["#e03131", "#2f9e44", "#1c7ed6"].forEach((color, i) => {
    const tip = [0, 0, 0];
    tip[i] = 1;
    const geo = new LineSegmentsGeometry().setPositions([0, 0, 0, ...tip]);
    const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: 1.6, depthTest: false, transparent: true });
    mat.resolution.copy(viewer.size);
    const line = new LineSegments2(geo, mat);
    line.renderOrder = 1998;
    line.raycast = () => {};
    group.add(line);
    const tag = document.createElement("div");
    tag.className = "axis-tag";
    tag.style.setProperty("--c", color);
    tag.textContent = "XYZ"[i];
    $("#labels").appendChild(tag);
    tags.push(tag);
  });
  viewer.scene.add(group);
  const tmp = new THREE.Vector3();
  viewer.onRender(() => {
    const on = group.visible && viewer.parts.length > 0;
    group.scale.setScalar(viewer.modelSize * 0.3);
    group.children.forEach(c => ((c as LineSegments2).material as LineMaterial).resolution.copy(viewer.size));
    tags.forEach((tag, i) => {
      tmp.set(0, 0, 0).setComponent(i, viewer.modelSize * 0.3 * 1.06).project(viewer.camera);
      tag.hidden = !on || tmp.z > 1 || tmp.z < -1;
      tag.style.transform = `translate(${((tmp.x + 1) / 2) * viewer.size.x}px, ${((1 - tmp.y) / 2) * viewer.size.y}px) translate(-50%, -50%)`;
    });
  });
  return group;
})();
{
  const box = $<HTMLInputElement>("#origin-axes");
  box.checked = storage.get("sv:axes") !== "off";
  originAxes.visible = box.checked;
  box.addEventListener("change", () => {
    originAxes.visible = box.checked;
    storage.set("sv:axes", box.checked ? "on" : "off");
    viewer.invalidate();
  });
}
const csysMark = new THREE.AxesHelper(1);
(csysMark.material as THREE.LineBasicMaterial).depthTest = false;
csysMark.renderOrder = 2000;
csysMark.visible = false;
viewer.scene.add(csysMark);

/**
 * Keeps a marker the same size on screen (radius `px` pixels) however far the
 * camera zooms, so it never grows over the geometry around it. `billboard` turns
 * it to face the camera (for flat rings).
 */
function screenSized(o: THREE.Object3D, px: number, billboard = false) {
  const at = new THREE.Vector3();
  o.frustumCulled = false;
  o.onBeforeRender = (_r, _s, cam) => {
    o.scale.setScalar(px * viewer.pxWorld(o.getWorldPosition(at)));
    if (billboard) o.quaternion.copy(cam.quaternion);
    o.updateMatrixWorld();
  };
  return o;
}

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
  edgeDepth(o);
  o.visible = true;
}
/** Highlighted edges hide behind the model in opaque modes, like the model's own edges; Wire and X-ray show them through. */
function edgeDepth(o: LineSegments2) {
  const m = o.material as LineMaterial;
  const through = viewer.mode === "wireframe" || viewer.mode === "xray";
  if (m.depthTest === through) { m.depthTest = !through; m.needsUpdate = true; }
}
function showEntity(face: THREE.Mesh, edge: LineSegments2, e: { part: Part; face?: { id: number }; edge?: EdgeInfo; kind?: string } | null) {
  const isEdge = !!e && (e.kind === "edge" || (!e.kind && !!e.edge && !e.face));
  showFace(face, e && !isEdge && e.face ? e.part : null, e?.face?.id);
  showEdge(edge, e && isEdge ? e.part : null, e?.edge);
  viewer.invalidate();
}

// ---------- PCB (Gerber / Excellon) mode ----------
const gerber = new GerberView($("#gerber"), {
  setLoading: (on, text = "", pct = 0) => setLoading(on, text, pct),
  toast: (m, err) => toast(m, err),
  status: (coord, snap) => { $("#st-coord").textContent = coord; $("#st-snap").textContent = snap; },
  download: (b, n) => download(b, n),
});
const panels = initPanels($("#app"));
initModals();
initConfirmCorners();
const openPicker = () => $<HTMLInputElement>("#file-input").click();
$$("[data-open]").forEach(b => b.addEventListener("click", openPicker));
bindGerberPanel(gerber, {
  copy: text => { navigator.clipboard?.writeText(text).then(() => toast(t("Copied {v}", { v: text }), "success"), () => toast(t("Copy failed"), true)); },
  open: openPicker,
  openBody: openBoardModel,
  exportStep: () => exportBoardStep(),
  panels,
});

// Tutorial "Bracket in 10 steps" (FR-HLP-003): a new part with a self-ticking step list in the right panel.
const tutorial = initTutorial({
  doc: () => (modeller.active ? modeller.store?.doc ?? null : null),
  start: name => modeller.newPart(name),
});

// Drawings (FRS section 11): sheets of the open part or STEP model, in their own workspace.
const partListeners: (() => void)[] = [];
const drawing = new DrawingWorkspace({
  appVersion: __APP_VERSION__,
  saved: (name, bytes) => void recentAdd([{ name, data: bytes }]),
  fileMenu: btn => fileMenu.toggle(btn),
  occtBase: new URL("occt/", document.baseURI).href,
  async currentModel() {
    const live = modeller.store?.doc;
    if (modeller.active && live) {
      const m = live.material;
      return { name: modeller.partName.replace(/\s*•$/, "") || live.name, part: JSON.parse(JSON.stringify(live)), info: { title: live.props.title || live.name, number: live.props.partNumber, revision: live.props.revision, author: live.props.author, material: m?.name, density: m?.density } };
    }
    // An open assembly (FR-DRW-030): its document and the expanded one the kernel builds.
    if (asm.active && asm.doc) return { name: asm.doc.name, asm: { doc: JSON.parse(JSON.stringify(asm.doc)), flat: JSON.parse(JSON.stringify(asm.expanded?.doc ?? flattenSubs(asm.doc))) }, info: { title: asm.doc.name } };
    if (!viewer.parts.length || isPcbMode()) return null;
    if (kernelOff) { toast(t("Drawings need the geometry kernel, which is turned off (?nokernel)."), true); return null; }
    if (kernelJob && kernel.status === "loading") { toast(t("Loading the geometry kernel…")); await kernelJob; }
    if (!kernel.file) { toast(t("Drawings need a STEP, IGES or BREP model; mesh files have no B-rep."), true); return null; }
    const bytes = await kernel.step(null, viewer.parts.map(p => p.data.name), viewer.parts.map(p => p.data.color));
    const name = `${baseName()}.step`;
    return { name, file: { name, bytes }, info: { title: baseName() } };
  },
  // A drawing opened by itself carries its model: Model opens that copy in its own tab (or shows its parked tab).
  async openModel(m) {
    const tabOf = (kind: "part" | "asm", id: string) => docs?.tabs.find(x => x.kind === kind && x.state && (kind === "part" ? (x.state as PartTab).store.doc.id : (x.state as AsmTab).doc.id) === id);
    const ext = (name: string, e: string) => (name.toLowerCase().endsWith(e) ? name : `${name.replace(/\.[^.]+$/, "")}${e}`);
    if (m.part) {
      if (modeller.active && modeller.store?.doc.id === m.part.id) return false;
      const tab = tabOf("part", m.part.id);
      if (tab) await docs!.activate(tab.id);
      else { const b = await packPart(m.part, `MöbiusCAD ${__APP_VERSION__}`); await modeller.openFile({ name: ext(m.name, PART_EXT), data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }); }
      return true;
    }
    if (m.asm) {
      if (asm.active && asm.doc?.id === m.asm.id) return false;
      const tab = tabOf("asm", m.asm.id);
      if (tab) await docs!.activate(tab.id);
      else { const b = await packAsm(m.asm, `MöbiusCAD ${__APP_VERSION__}`); await asm.openFile({ name: ext(m.name, ASM_EXT), data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }); }
      return true;
    }
    if (m.file) {
      if (viewer.parts.length && !modeller.active && !asm.active && state.fileName === m.file.name) return false;
      await openFiles([new File([m.file.bytes as BlobPart], m.file.name)]);
      return true;
    }
    return false;
  },
  livePart: id => (modeller.store?.doc.id === id ? modeller.store.doc : null),
  liveAsm: id => (asm.active && asm.doc?.id === id ? { doc: asm.doc, flat: asm.expanded?.doc ?? flattenSubs(asm.doc) } : null),
  onPartChange: fn => { partListeners.push(fn); },
  currentView() {
    if (!viewer.parts.length && !modeller.active) return null;
    const cam = viewer.camera, d = cam.position.clone().sub(viewer.controls.target).normalize();
    return { dir: d.toArray() as [number, number, number], up: cam.up.toArray() as [number, number, number] };
  },
  download: (blob, name) => download(blob, name),
  beforeOpen: () => docs?.beforeDrawing(),
  opened: label => docs?.opened("drawing", label),
  onToggle: open => { if (!open) docs?.drawingHidden(); },
});
$("#new-drawing").addEventListener("click", () => {
  $("#new-menu").hidden = true;
  $("#new-more").setAttribute("aria-expanded", "false");
  const key = modeller.active ? `part:${modeller.store?.doc.id}` : asm.active ? `asm:${asm.doc?.id}` : state.fileKey || state.fileName;
  if (drawing.hasDrawing && drawing.modelKey === key) { drawing.show(); return; }
  // The model's drawing parked in a tab comes back instead of a second one.
  const parked = docs?.tabs.find(x => x.kind === "drawing" && (x.state as DrawingTab | null)?.modelKey === key);
  if (parked) { void docs!.activate(parked.id); return; }
  drawing.modelKey = key;
  void drawing.newFromModel();
});

/** The open 3D document a drawing can belong to (File ▸ Open drawing), or null. */
function liveModelKey(): { key: ModelKey; name: string } | null {
  if (drawing.open) return null;
  if (modeller.active && modeller.store) return { key: { part: modeller.store.doc.id }, name: plainLabel(modeller.partName) || modeller.store.doc.name };
  if (asm.active && asm.doc) return { key: { asm: asm.doc.id }, name: asm.doc.name };
  if (viewer.parts.length && !isPcbMode() && state.fileName) return { key: { file: state.fileName }, name: state.fileName };
  return null;
}

/**
 * File ▸ Open drawing: the drawing of the open part, assembly or model file, from the drawing workspace, a
 * document tab, the open vault or the recent documents. Several: the user picks one; none: offers New drawing.
 */
async function openDrawingOf() {
  const live = liveModelKey();
  if (!live) return;
  const { key, name } = live, found: FoundDrawing[] = [];
  const cur = drawing.current;
  if (cur && drawingOf(cur.source, key)) found.push({ id: cur.id, label: cur.name, where: "open", open: () => drawing.show() });
  for (const tab of docs?.tabs ?? []) {
    const st = tab.kind === "drawing" ? tab.state as DrawingTab | null : null;
    if (st && drawingOf(st.store.doc.source, key)) found.push({ id: st.store.doc.id, label: plainLabel(tab.label), where: "tab", open: () => docs!.activate(tab.id) });
  }
  const v = vaultPanel.vault;
  if (v) {
    try {
      for (const f of await v.files()) {
        if (f.deleted || !isDrawingName(f.path)) continue;
        const bytes = await v.working(f.path) ?? await v.versionBytes(f.id, v.latest(f).n);
        const d = await peekDrawing(bytes.slice().buffer as ArrayBuffer);
        if (d && drawingOf(d.source, key)) found.push({ id: d.id, label: f.path, where: "vault", open: () => vaultPanel.openFile(f.id) });
      }
    } catch { /* the vault folder went away: the other places still count */ }
  }
  const recent = await recentList();
  for (let i = 0; i < recent.length; i++) {
    if (!isDrawingName(recent[i].name)) continue;
    const fs = await recentFiles(i), file = fs?.find(x => isDrawingName(x.name));
    const d = file && await peekDrawing(await file.arrayBuffer());
    if (d && drawingOf(d.source, key)) found.push({ id: d.id, label: file!.name, where: "recent", open: () => openFiles(fs!) });
  }
  const list = uniqueDrawings(found);
  if (list.length === 1) { await list[0].open(); return; }
  if (!list.length) {
    if (await confirmModal(t("No drawing of {name} is open, in the vault or in the recent documents. Make a new drawing of it?", { name }), t("New drawing"), t("Open drawing"))) $("#new-drawing").click();
    return;
  }
  const pick = await pickDrawing(list, name);
  if (pick) await pick.open();
}

/** Lets the user pick one of several drawings of the model. */
function pickDrawing(list: FoundDrawing[], name: string): Promise<FoundDrawing | null> {
  let d = document.getElementById("drw-pick-dlg") as HTMLDialogElement | null;
  if (!d) {
    d = document.createElement("dialog");
    d.id = "drw-pick-dlg";
    d.className = "modal v-dlg";
    d.setAttribute("aria-labelledby", "drw-pick-title");
    document.body.appendChild(d);
    trapFocus(d, () => d!.open);
  }
  const dlg = d, where = { open: t("Open"), tab: t("In a tab"), vault: t("In the vault"), recent: t("Recent document") };
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  dlg.innerHTML = `<h3 id="drw-pick-title">${esc(t("Open drawing"))}</h3>`
    + `<p class="muted">${esc(t("Drawings of {name}:", { name }))}</p>`
    + `<div class="drw-pick-list">${list.map((x, i) => `<button class="btn" data-dp="${i}"><span translate="no">${esc(x.label)}</span> <span class="muted">${esc(where[x.where])}</span></button>`).join("")}</div>`
    + `<div class="row end"><button class="btn" data-a="cancel">${esc(t("Cancel"))}</button></div>`;
  return new Promise(res => {
    let picked: FoundDrawing | null = null;
    dlg.querySelectorAll<HTMLButtonElement>("[data-dp]").forEach(b => b.addEventListener("click", () => { picked = list[+b.dataset.dp!]; dlg.close(); }));
    dlg.querySelector("[data-a=cancel]")!.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => res(picked), { once: true });
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>("[data-dp]")?.focus();
  });
}

// ---------- document tabs (FR-DOC-003, FR-UI-120) ----------
/** The model file shown now (STEP/IGES/BREP/mesh), so its tab can open it again. */
let modelSrc: { name: string; data: ArrayBuffer } | null = null;
let pendingSrc: { name: string; data: ArrayBuffer } | null = null;
/** No 3D document: the start card again. */
function clearModelView() {
  resetForNewModel();
  viewer.clear();
  state.fileName = "";
  state.fileKey = "";
  modelSrc = null;
  document.title = "MöbiusCAD";
  setDoc("", "idle");
  buildTree();
  renderProps();
  $("#empty").hidden = false;
}
/** The camera a document tab was parked with, applied by its first show (FR-DOC-003). */
let tabView: ReturnType<Viewer["getView"]> | null = null;
docs = new DocTabs({
  view: () => ($("#empty").hidden && viewer.parts.length ? viewer.getView() : null),
  park(kind) {
    if (kind === "part") return modeller.park();
    if (kind === "asm") return asm.park();
    if (kind === "drawing") return drawing.park();
    const src = modelSrc;
    modelSrc = null;
    return src;
  },
  async resume(tab: DocTab) {
    tabView = tab.kind === "drawing" ? null : ((tab.view as typeof tabView) ?? null);
    if (tab.kind === "part") modeller.resume(tab.state as PartTab);
    else if (tab.kind === "asm") asm.resume(tab.state as AsmTab);
    else if (tab.kind === "drawing") await drawing.resume(tab.state as DrawingTab);
    else {
      const src = tab.state as { name: string; data: ArrayBuffer };
      modeller.close();
      asm.close();
      await openBuffer(src.data.slice(0), src.name);
      if (tabView && viewer.parts.length) viewer.setView(tabView, false);
      tabView = null;
    }
  },
  close(kind) {
    if (kind === "drawing") { drawing.park(); return; }
    // Closed for good: the recovery journal drops the part too.
    if (kind === "part") { const id = modeller.store?.doc.id; modeller.close(); if (id) journalDrop(id); }
    else if (kind === "asm") asm.close();
    clearModelView();
  },
  label: kind => (kind === "drawing" ? drawing.title || null : docState[0] || null),
  dirty(tab) {
    const st = tab.state;
    if (tab.kind === "part") return st ? (st as PartTab).store.dirty : modeller.dirty;
    if (tab.kind === "asm") return st ? JSON.stringify((st as AsmTab).doc) !== (st as AsmTab).savedAt : asm.dirty;
    if (tab.kind === "drawing") return st ? (st as DrawingTab).store.dirty : drawing.dirty;
    return false;
  },
  forget(tab) {
    // Closed without saving: no "recover unsaved part" card for it later.
    if (tab.kind === "part" && tab.state) journalDrop((tab.state as PartTab).store.doc.id);
  },
}, $("#doc-tabs"));

/** File name and status (idle / loading / ready / error) in the header. */
let docState: [string, "idle" | "loading" | "ready" | "error"] = ["", "idle"];
function setDoc(name: string, st: "idle" | "loading" | "ready" | "error") {
  docState = [name, st];
  const label = t({ idle: "no file open", loading: "loading", ready: "open", error: "could not open" }[st]);
  $("#doc-name").textContent = name || t("No file open");
  $("#doc").title = name ? `${name} (${label})` : t("No file open");
  $("#doc").dataset.state = st;
  $("#doc-status").dataset.state = st;
  $("#doc-status").setAttribute("aria-label", t("Status: {s}", { s: label }));
  docs?.render();
}
function setPcbMode(on: boolean) {
  $("#app").classList.toggle("gerber", on);
  if (on) $("#back-pcb").hidden = true;
  panels.apply();
  if (on) { $("#empty").hidden = true; } else { $("#st-coord").textContent = ""; $("#st-snap").textContent = ""; }
}
const isPcbMode = () => $("#app").classList.contains("gerber");

/** Opens the PCB's board body in the 3D model view, where the model tools (thickness, hole Ø, angles, sections, mass, STL) work on it. */
function openBoardModel() {
  const t0 = performance.now();
  const mesh = gerber.boardBody();
  if (!mesh) { toast(t("Open a board with an outline or layers first."), true); return; }
  const part = analyzeMesh(mesh);
  kernel.clear();
  showModel([part], { name: mesh.name, parts: [0], children: [] }, mesh.name, `sv:pcb:${mesh.name}:${gerber.thickness}`, t0);
  toast(t("Board body opened with the 3D model tools. Back to PCB returns to the layers."));
}

$("#back-pcb").addEventListener("click", () => {
  setPcbMode(true);
  document.title = `${gerber.name} · PCB · MöbiusCAD`;
  setDoc(gerber.name, "ready");
  gerber.render();
});

async function openPcb(files: File[] | { name: string; data: ArrayBuffer }[], append = false) {
  const list = await Promise.all(files.map(async f => (f instanceof File ? { name: f.name, data: await f.arrayBuffer() } : f)));
  ++loadToken;
  docs?.before3d();
  modeller.close();
  asm.close();
  if (!append) kernel.clear();
  setPcbMode(true);
  const label = list.length === 1 ? list[0].name : t("{n} PCB files", { n: list.length });
  setDoc(label, "loading");
  const ok = await gerber.load(list, append && gerber.loaded);
  if (!ok && !gerber.loaded) { setPcbMode(false); if (!viewer.parts.length) $("#empty").hidden = false; setDoc(label, "error"); return; }
  if (!append || !gerber.name) gerber.name = list.length === 1 ? list[0].name : list[0].name.replace(/[-_.][^-_.]*$/, "") || "pcb";
  document.title = `${gerber.name} · PCB · MöbiusCAD`;
  setDoc(gerber.name, "ready");
  pcbStats();
  hint("pcb");
}
gerber.onChange(() => { if (gerber.is3d) hint("pcb3d"); });
$("#tree-search").addEventListener("focus", () => hint("tree"));
function pcbStats() {
  const n = gerber.layers.length;
  $("#st-stats").textContent = `${t("{n} layer|{n} layers", { n })} · ${t("{n} objects", { n: gerber.layers.reduce((s, l) => s + l.L.objs.length, 0).toLocaleString() })}`;
}

const is3dName = (n: string) => /\.(step|stp|p21|iges|igs|brep|stl|obj|3mf|sldprt|sldasm)$/i.test(n);

/** Opens dropped or chosen files: one 3D model, a SolidWorks assembly with its parts, or any number of PCB layers / zips. */
async function openFiles(files: File[]) {
  if (!files.length) return;
  // File ▸ recent documents: the main file first (a drawing, part or assembly, else the biggest 3D model).
  {
    const main = files.find(f => isDrawingName(f.name) || modeller.isPartName(f.name) || asm.isAsmName(f.name)) ?? files.filter(f => is3dName(f.name)).sort((a, b) => b.size - a.size)[0] ?? files[0];
    void recentAdd([main, ...files.filter(f => f !== main)].map(f => ({ name: f.name, data: f })));
  }
  const drawingFile = files.find(f => isDrawingName(f.name));
  if (drawingFile) return drawing.openFile(drawingFile);
  const partFile = files.find(f => modeller.isPartName(f.name));
  if (partFile) return modeller.openFile(partFile);
  const asmFile = files.find(f => asm.isAsmName(f.name));
  if (asmFile) return asm.openFile(asmFile);
  const sw = files.filter(f => isSolidWorksName(f.name));
  if (sw.length) return openSolidWorks(sw);
  const model = files.find(f => is3dName(f.name));
  if (model && files.length === 1) return openFile(model);
  const pcb: File[] = [];
  for (const f of files) {
    if (is3dName(f.name)) continue;
    if (isPcbName(f.name) || sniff(new Uint8Array(await f.slice(0, 8192).arrayBuffer()))) pcb.push(f);
  }
  if (pcb.length) return openPcb(pcb);
  if (model) return openFile(model);
  return openFile(files[0]);
}

// ---------- loading ----------
const worker = new ImportWorker();
let loadToken = 0;
// Get OpenCASCADE (≈3 MB compressed) loaded and warmed up while the user picks a file.
{
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const warm = () => { if (!loadToken) worker.postMessage({ kind: "warm", occtBase: new URL("occt/", document.baseURI).href }); };
  if (!saveData) "requestIdleCallback" in window ? requestIdleCallback(warm, { timeout: 3000 }) : setTimeout(warm, 1500);
}

/**
 * SolidWorks: the kernel worker reads the Parasolid model inside each part,
 * places an assembly's parts and hands back STEP, which then opens as usual.
 * An assembly needs its part files dropped with it (or its whole folder).
 */
async function openSolidWorks(files: File[]) {
  const asm = files.filter(f => /\.sldasm$/i.test(f.name)).sort((a, b) => b.size - a.size);
  const main = asm[0] ?? files[0];
  const name = main.name;
  if (kernelOff) { toast(t("SolidWorks files need the geometry kernel, which is turned off (?nokernel)."), true); return; }
  ++loadToken;
  const token = loadToken;
  restoreEmpty();
  setDoc(name, "loading");
  setLoading(true, t("Reading the SolidWorks model in {name}…", { name }), 5);
  const parts = asm.length ? files : [main];
  if (!asm.length && files.length > 1) toast(t("Opening {name}. Open one part at a time, or drop the assembly with its parts.", { name }));
  let res: Awaited<ReturnType<typeof kernel.solidworks>>;
  try {
    res = await kernel.solidworks(await Promise.all(parts.map(async f => ({ name: f.name, buffer: await f.arrayBuffer() }))), name);
  } catch (err) {
    if (token !== loadToken) return;
    setLoading(false);
    setDoc(name, "error");
    toast(t("Could not open {name}: {err}", { name, err: t((err as Error).message) }), true);
    return;
  }
  if (token !== loadToken) return;
  const { bytes, report } = res;
  if (!bytes) {
    setLoading(false);
    setDoc(name, "error");
    if (report.missing.length) toast(t("{name} needs its part files: drop the assembly together with its parts, or the whole folder.", { name }), true);
    else toast(t("No geometry could be read from {name}.", { name }), true);
    if (report.preview) showPreview(report.preview, name);
    return;
  }
  await openBuffer(bytes.buffer as ArrayBuffer, name);
  // openBuffer takes the next load token itself; anything beyond that is a newer file.
  if (loadToken !== token + 1) return;
  if (report.missing.length) toast(t("{n} part file is missing and left out: {list}. Drop the assembly together with its parts, or the whole folder.|{n} part files are missing and left out: {list}. Drop the assembly together with its parts, or the whole folder.|{n} part files are missing and left out: {list}. Drop the assembly together with its parts, or the whole folder.", { n: report.missing.length, list: listNames(report.missing) }), "warn");
  else if (report.failedFaces) toast(t("{n} face could not be rebuilt and is left out.|{n} faces could not be rebuilt and are left out.|{n} faces could not be rebuilt and are left out.", { n: report.failedFaces }), "warn");
  if (report.notes.length) console.info("SolidWorks import notes:", report.notes);
}
const listNames = (a: string[]) => (a.length > 4 ? `${a.slice(0, 4).join(", ")} (+${a.length - 4})` : a.join(", "));

/** SolidWorks' own thumbnail of a file whose geometry could not be read. */
let emptyHtml = "";
function showPreview(png: Uint8Array, name: string) {
  const card = $("#empty .empty-card");
  emptyHtml ||= card.innerHTML;
  const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
  card.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = t("Preview of {name}", { name });
  const img = document.createElement("img");
  img.className = "sw-preview";
  img.src = url;
  img.alt = t("Preview of {name}", { name });
  const p = document.createElement("p");
  p.textContent = t("This is the picture SolidWorks saved in the file. Its geometry could not be read, so nothing can be measured.");
  const b = document.createElement("button");
  b.className = "btn primary";
  b.textContent = t("Choose files…");
  b.addEventListener("click", openPicker);
  card.append(h, img, p, b);
  $("#empty").hidden = false;
}
function restoreEmpty() {
  if (!emptyHtml) return;
  const card = $("#empty .empty-card");
  card.innerHTML = emptyHtml;
  card.querySelector("[data-open]")?.addEventListener("click", openPicker);
  emptyHtml = "";
}

async function openFile(file: File) {
  const buffer = await file.arrayBuffer();
  await openBuffer(buffer, file.name);
}

/** Runs the import worker on one request; null when it failed (the error is shown). */
function runImport(name: string, msg: unknown, transfer: Transferable[]) {
  return new Promise<{ parts: PartData[]; tree: TreeNode; timing?: Record<string, number> }>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === "progress") setLoading(true, t(d.text, d.params), d.pct);
      else if (d.type === "done") resolve(d);
      else reject(new Error(d.text));
    };
    worker.postMessage(msg, transfer);
  }).catch(err => { setLoading(false); setDoc(name, "error"); toast(t("Could not open {name}: {err}", { name, err: t(err.message) }), true); return null; });
}

/** STL, OBJ or 3MF: triangles only, grouped into faces so the measuring tools work. No B-rep, so no exact values or STEP. */
async function openMesh(buffer: ArrayBuffer, name: string) {
  pendingSrc = { name, data: buffer.slice(0) };
  const token = ++loadToken;
  kernel.clear();
  setDoc(name, "loading");
  setLoading(true, t("Reading {name}…", { name }), 2);
  state.meta = null;
  const t0 = performance.now();
  let meshes;
  try { meshes = await parseMesh(buffer, name); }
  catch (err) { setLoading(false); setDoc(name, "error"); toast(t("Could not open {name}: {err}", { name, err: t((err as Error).message) }), true); return; }
  const result = await runImport(name, { kind: "mesh", name, meshes }, meshes.flatMap(m => (m.idx ? [m.pos.buffer, m.idx.buffer] : [m.pos.buffer])));
  if (!result || token !== loadToken) return;
  setLoading(true, t("Building scene…"), 97);
  await new Promise(r => setTimeout(r, 0));
  showModel(result.parts, result.tree, name, `sv:m:${name}:${buffer.byteLength || ""}`, t0);
  showKernelStatus();
  toast(t("Mesh file: faces are found from the triangles, sizes in millimetres. Exact geometry and STEP export need a STEP, IGES or BREP file."));
}

async function openBuffer(buffer: ArrayBuffer, name: string) {
  if (isMeshName(name)) return openMesh(buffer, name);
  if (!is3dName(name) && sniff(new Uint8Array(buffer, 0, Math.min(8192, buffer.byteLength)))) return openPcb([{ name, data: buffer }]);
  pendingSrc = { name, data: buffer.slice(0) };
  const token = ++loadToken;
  setDoc(name, "loading");
  setLoading(true, t("Reading {name}…", { name }), 2);
  state.meta = readStepMeta(new Uint8Array(buffer));
  const quality = $<HTMLSelectElement>("#quality").value as "draft" | "normal" | "fine";
  const occtBase = new URL("occt/", document.baseURI).href;
  const t0 = performance.now();
  timings = {};
  // The kernel worker reads the file again, with its B-rep, alongside the import.
  const size = buffer.byteLength;
  const parts = startKernel(buffer.slice(0), name, token, t0);
  const result = await runImport(name, { buffer, name, occtBase, quality }, [buffer]);
  parts(result?.parts ?? null);
  if (!result || token !== loadToken) return;
  Object.assign(timings, result.timing, { worker: performance.now() - t0 });

  setLoading(true, t("Building scene…"), 97);
  await new Promise(r => setTimeout(r, 0));
  const ts = performance.now();
  showModel(result.parts, result.tree, name, `sv:m:${name}:${size || ""}`, t0);
  timings.scene = performance.now() - ts;
  timings.shown = performance.now() - t0;
}

/** Where the last open spent its time (ms), for `?debug` profiling. */
let timings: Record<string, number> = {};

// ---------- exact geometry (full OpenCASCADE in the background) ----------
const kernel = new KernelClient(new URL("occt/", document.baseURI).href);
let kernelJob: Promise<number> | null = null;
let kernelNote = "";
/** `?nokernel` keeps mesh values only (tests that check the tessellation path). */
const kernelOff = new URLSearchParams(location.search).has("nokernel");
function warmKernel() { if (!kernelOff && kernelAlongside) kernel.warm(); }
/** With fewer cores the kernel waits for the model to be on screen instead of reading alongside the import. */
const kernelAlongside = (navigator.hardwareConcurrency || 2) >= 6;
/** Starts the exact-geometry read of a file; call the result with the imported parts (null: the import failed). */
function startKernel(bytes: ArrayBuffer, name: string, token: number, t0: number): (parts: PartData[] | null) => void {
  if (kernelOff) return () => {};
  let give!: (parts: PartData[] | null) => void;
  const parts = new Promise<PartData[] | null>(r => (give = r));
  const current = () => token === loadToken;
  const start = kernelAlongside ? Promise.resolve()
    // Let the first frames draw before the kernel starts.
    : parts.then(() => new Promise<void>(r => setTimeout(r, 300)));
  kernelJob = start.then(() => (current() ? kernel.open(bytes, name, parts, current) : 0));
  kernelJob.then(n => {
    if (!n || !current()) return;
    timings.exact = performance.now() - t0;
    exactReady();
  });
  return give;
}
/** The parts now carry exact values: show them wherever a number is on screen. */
function exactReady() {
  if (state.live && state.livePicks.length) showLive(state.livePicks);
  renderProps();
  if (lastMassRun || mp.open) runMass();
}
function showKernelStatus() {
  const el = $("#st-kernel");
  const s: KernelStatus = kernel.status;
  const n = viewer.parts.filter(p => p.data.exact).length;
  el.dataset.state = s;
  el.textContent = s === "loading" ? t("Exact geometry: loading…") : s === "ready" ? t("Exact geometry") : s === "partial" ? t("Exact geometry: {n} of {m} parts", { n, m: viewer.parts.length }) : s === "error" ? t("Mesh values") : "";
  el.title = s === "loading" ? t("Values come from the mesh until the full geometry kernel has read the file")
    : s === "ready" || s === "partial" ? t("Volumes, areas, lengths, radii and curvature come from the exact B-rep surfaces and curves")
    : s === "error" ? t("The full geometry kernel could not match this file; values come from the mesh") + (kernelNote ? ` (${kernelNote})` : "") : "";
  el.hidden = s === "off";
}
kernel.onStatus = (_s, note) => { kernelNote = note ?? ""; showKernelStatus(); };

/** Saves the visible parts as STEP (the whole file, with its assembly, when everything is visible). */
async function exportStep() {
  // A modelled part or an assembly has no imported file: its own kernel writes the STEP.
  if (modeller.active) return modeller.exportStep();
  if (asm.active) return asm.exportStep();
  if (!viewer.parts.length) return;
  if (state.fileKey.startsWith("sv:pcb:")) return exportBoardStep();
  if (kernelJob && kernel.status === "loading") { toast(t("Loading the geometry kernel…")); await kernelJob; }
  if (!kernel.file) { toast(t("STEP export needs a STEP, IGES or BREP model; mesh files have no B-rep."), true); return; }
  const vis = viewer.parts.filter(p => p.visible);
  if (!vis.length) { toast(t("Nothing is visible to export"), true); return; }
  const all = vis.length === viewer.parts.length;
  try {
    const bytes = await kernel.step(all ? null : vis.map(p => p.idx), vis.map(p => p.data.name), vis.map(p => p.data.color));
    download(new Blob([bytes], { type: "model/step" }), `${baseName()}${all ? "" : "-parts"}.step`);
    toast(all ? t("Saved as STEP") : t("Saved {n} visible parts as STEP", { n: vis.length }));
  } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
}
/** The PCB board body as a STEP solid: outline, cut-outs and drilled holes as true cylinders. */
async function exportBoardStep() {
  const body = gerber.boardStepBody();
  if (!body) { toast(t("Open a board with an outline or layers first."), true); return; }
  toast(t("Loading the geometry kernel…"));
  try {
    const bytes = await kernel.board(body);
    download(new Blob([bytes], { type: "model/step" }), `${gerber.baseName()}-board.step`);
    toast(t("Saved as STEP"));
  } catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
}

/** Shows parsed parts in the 3D model view (a STEP file, or a PCB's board body). */
function showModel(parts: PartData[], tree: TreeNode, name: string, key: string, t0: number) {
  const result = { parts, tree };
  const pcbBody = key.startsWith("sv:pcb:");
  docs?.before3d();
  modeller.close();
  asm.close();
  resetForNewModel();
  setPcbMode(false);
  $("#back-pcb").hidden = !key.startsWith("sv:pcb:");
  viewer.load(result.parts, result.tree);
  if (surfAna.kind) void surfAna.refresh();
  state.fileName = name;
  state.fileKey = key;
  document.title = `${name} · MöbiusCAD`;
  setDoc(name, "ready");
  $("#empty").hidden = true;
  setLoading(false);
  buildTree();
  loadMeasurements();
  renderProps();
  if (mp.open) runMass();
  const tris = result.parts.reduce((s, p) => s + p.index.length / 3, 0);
  const faces = result.parts.reduce((s, p) => s + p.faces.length, 0);
  modelStats = { parts: result.parts.length, faces, tris, s: (performance.now() - t0) / 1000 };
  showModelStats();
  viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
  // A model file gets a tab (a PCB's board body belongs to the PCB view and gets none).
  modelSrc = pcbBody ? null : pendingSrc;
  pendingSrc = null;
  if (modelSrc) docs?.opened("model", name);
  hint("model");
}

/** A modelled part's body after a rebuild: the first time like a newly opened file, later keeping the view and tools. */
function showPartModel(data: PartData | null, name: string, first: boolean) {
  showModelled(data ? [data] : [], { name, parts: data ? [0] : [], children: [] }, name, first);
}

/** Parts the modeller or the assembly built: the first time like a newly opened file, later keeping the view and tools. */
function showModelled(parts: PartData[], tree: TreeNode, name: string, first: boolean) {
  ++loadToken;
  if (first) {
    resetForNewModel();
    // A STEP file shown before (another tab) must not lend its header to the part's Properties.
    state.meta = null;
    setPcbMode(false);
    kernel.clear();
    showKernelStatus();
    $("#back-pcb").hidden = true;
  } else {
    state.selection = null;
    state.picks = [];
    hl.pickMarks.clear();
    clearLive();
    showEntity(hl.selFace, hl.selEdge, null);
    showEntity(hl.hoverFace, hl.hoverEdge, null);
  }
  viewer.load(parts, tree, first && parts.length > 0);
  if (surfAna.kind) void surfAna.refresh();
  if (!first) remeasure();
  state.fileName = name;
  state.fileKey = "";
  document.title = `${name} · MöbiusCAD`;
  $("#empty").hidden = true;
  setLoading(false);
  buildTree();
  renderProps();
  updateHint();
  if (first && parts.length) viewer.viewFrom(new THREE.Vector3(1, -1, 0.8), false);
  // A document coming back from a parked tab is shown as it was left.
  if (first && parts.length && tabView) { viewer.setView(tabView, false); tabView = null; }
  if (lastMassRun || mp.open) runMass();
  for (const f of partListeners) f();
}

let modelStats = { parts: 0, faces: 0, tris: 0, s: 0 };
function showModelStats() {
  const m = modelStats;
  $("#st-stats").textContent = [t("{n} parts", { n: m.parts }), t("{n} faces", { n: m.faces.toLocaleString() }), t("{n} triangles", { n: m.tris.toLocaleString() }), `${m.s.toFixed(1)} ${t("s")}`].join(" · ");
}

function resetForNewModel() {
  setTool("select");
  section.clear();
  syncSectionHud();
  renderSections();
  stopDrag();
  hl.com.visible = false;
  setCsys(null, false);
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
  lastMassRun = null;
  lastMass = [];
  mp.picking = false; mp.typing = false;
  mpAxes.visible = false; mpFrameMark.visible = false;
  if (mp.open) renderMassPanel();
}

/** Skeleton loaders replace panel content when loading takes longer than this. */
const SKELETON_MS = 300;
let slowTimer = 0;
function setLoading(on: boolean, text = "", pct = 0) {
  const app = $("#app");
  if (on && $("#loading").hidden) {
    clearTimeout(slowTimer);
    app.dataset.busy = "on";
    slowTimer = window.setTimeout(() => { if (app.dataset.busy) app.dataset.busy = "slow"; }, SKELETON_MS);
  }
  if (!on) { clearTimeout(slowTimer); delete app.dataset.busy; }
  $("#loading").hidden = !on;
  if (on) { $("#loading-text").textContent = text; $("#loading-bar").style.width = `${pct}%`; }
}

$<HTMLInputElement>("#file-input").addEventListener("change", e => {
  const fs = (e.target as HTMLInputElement).files;
  if (fs?.length) openFiles([...fs]);
  (e.target as HTMLInputElement).value = "";
});
vpEl.addEventListener("dragover", e => { e.preventDefault(); vpEl.classList.add("drag"); });
// The user is about to open a file: start the exact-geometry kernel now (it takes seconds to set up).
$("#file-input").addEventListener("click", () => warmKernel());
window.addEventListener("dragenter", e => { if (e.dataTransfer?.types.includes("Files")) warmKernel(); });
vpEl.addEventListener("dragleave", () => vpEl.classList.remove("drag"));
vpEl.addEventListener("drop", e => {
  e.preventDefault();
  vpEl.classList.remove("drag");
  const dt = e.dataTransfer;
  if (!dt) return;
  // A dropped folder (an assembly with its parts) is read through its entries.
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  if (entries.some(x => x.isDirectory)) { filesOf(entries).then(fs => { if (fs.length) openFiles(fs); }); return; }
  const files = [...dt.files];
  // On an open assembly, parts and STEP/IGES/BREP models (a McMaster-Carr download, say) become components.
  if (files.length && asm.active && $("#app").classList.contains("asm") && files.every(f => /\.(step|stp|iges|igs|brep|mcadprt)$/i.test(f.name))) { void asm.dropFiles(files); return; }
  if (files.length) openFiles(files);
});

/** Files in dropped entries, folders included (up to 2000 files, 8 levels). */
async function filesOf(entries: FileSystemEntry[], depth = 0, out: File[] = []): Promise<File[]> {
  for (const en of entries) {
    if (out.length >= 2000) break;
    if (en.isFile) out.push(await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej)));
    else if (en.isDirectory && depth < 8) {
      const reader = (en as FileSystemDirectoryEntry).createReader();
      const kids: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        kids.push(...batch);
      }
      await filesOf(kids, depth + 1, out);
    }
  }
  // In a folder, only the 3D files matter when there are any (PCB sets are picked up by openFiles).
  return out;
}

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
  if (!viewer.tree) { emptyState(host, { icon: "model", title: t("No model loaded"), text: t("Open a STEP, IGES or BREP file to see its assembly tree."), cta: t("Open file"), action: openPicker }); return; }
  const make = (n: TreeNode, depth: number): HTMLElement => {
    const el = document.createElement("div");
    el.className = "node";
    const leafPart = n.children.length === 0 && n.parts.length === 1 ? viewer.parts[n.parts[0]] : null;
    const count = partsUnder(n).length;
    const hasKids = n.children.length > 0 || n.parts.length > 1;
    const row = document.createElement("div");
    row.className = "row-n";
    row.style.setProperty("--d", String(depth));
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    row.setAttribute("aria-selected", "false");
    if (hasKids) row.setAttribute("aria-expanded", "true");
    row.tabIndex = depth === 0 ? 0 : -1;
    const sw = leafPart ? `<span class="swatch" aria-hidden="true" style="background:#${leafPart.baseColor.getHexString()}"></span>` : "";
    row.innerHTML = `<span class="caret" aria-hidden="true">${hasKids ? "▾" : ""}</span><button class="eye" title="${esc(t("Show/hide"))}" aria-label="${esc(t("Show or hide {name}", { name: n.name }))}" tabindex="-1">●</button>${sw}<span class="nm" translate="no" title="${esc(n.name)}">${esc(n.name)}</span><span class="cnt">${count > 1 ? count : ""}</span>`;
    el.appendChild(row);
    const kids = document.createElement("div");
    kids.className = "kids";
    n.children.forEach(c => kids.appendChild(make(c, depth + 1)));
    // A node holding several meshes directly lists them as leaves.
    if (n.parts.length > 1) n.parts.forEach(i => kids.appendChild(make({ name: viewer.parts[i].data.name, parts: [i], children: [] }, depth + 1)));
    el.appendChild(kids);
    const setOpen = (open: boolean) => { el.classList.toggle("collapsed", !open); if (hasKids) row.setAttribute("aria-expanded", String(open)); };
    row.querySelector(".caret")!.addEventListener("click", e => { e.stopPropagation(); setOpen(el.classList.contains("collapsed")); });
    row.addEventListener("keydown", e => {
      if (e.target !== row) return;
      const rows = [...host.querySelectorAll<HTMLElement>(".row-n")].filter(r => r.offsetParent !== null);
      const i = rows.indexOf(row);
      const go = (r?: HTMLElement) => { if (!r) return; rows.forEach(x => (x.tabIndex = -1)); r.tabIndex = 0; r.focus(); };
      const k = e.key;
      if (k === "ArrowDown") go(rows[i + 1]);
      else if (k === "ArrowUp") go(rows[i - 1]);
      else if (k === "Home") go(rows[0]);
      else if (k === "End") go(rows.at(-1));
      else if (k === "ArrowRight" && hasKids) { if (el.classList.contains("collapsed")) setOpen(true); else go(rows[i + 1]); }
      else if (k === "ArrowLeft") { if (hasKids && !el.classList.contains("collapsed")) setOpen(false); else go(el.parentElement?.closest(".node")?.querySelector<HTMLElement>(":scope > .row-n") ?? undefined); }
      else if (k === "Enter" || k === " ") selectNode(n);
      else if (k.toLowerCase() === "h" && !e.ctrlKey && !e.metaKey) { (row.querySelector(".eye") as HTMLElement).click(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
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
    el.querySelector(":scope > .row-n")!.setAttribute("aria-selected", String(n === state.selectedNode));
  }
}

function setPartVisible(p: Part, on: boolean) {
  p.visible = on;
  viewer.applyPartAppearance(p);
}
function afterVisibilityChange() {
  refreshTreeVisibility();
  massChanged();
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
  massChanged();
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
  return `<div class="kv">${rows.map(([k, v]) => `<span class="k">${esc(t(k))}</span><span class="v" translate="no">${v}</span>`).join("")}</div>`;
}

/** Overall size: a modelled part's exact box when every body shows, else the shown meshes' box (exam #12). */
function overallSize(): THREE.Vector3 {
  const box = modeller.active && viewer.parts.every(p => p.visible) ? modeller.bodyProps()?.box : undefined;
  if (box) return new THREE.Vector3(box[1][0] - box[0][0], box[1][1] - box[0][1], box[1][2] - box[0][2]);
  return viewer.computeBounds().getSize(new THREE.Vector3());
}

function renderProps() {
  const el = $("#props");
  if (!viewer.parts.length) {
    // A new part has nothing to show yet: say how to start, not "open a model" (exam #11).
    const part = $("#app").classList.contains("model");
    // Editing an early sketch rolls the bodies back: the part is not empty then (exam #93).
    const feats = part && (modeller.store?.doc.features.length ?? 0) > 0;
    el.innerHTML = `<p class="muted">${t(feats ? "No bodies before the feature being edited." : part ? "This part is empty. Start a sketch on a plane to begin." : "Open a model to begin.")}</p>`;
    return;
  }
  const e = state.selection;
  let html = "";
  if (e) {
    const p = e.part;
    html += `<span class="badge">${esc(tx(describeEntity(e)))}</span><h3 translate="no">${esc(p.data.name)}</h3>`;
    const rows: [string, string][] = [];
    if (e.kind === "face" && e.face) {
      const f = e.face;
      rows.push(["Surface", t(f.type)], ["Area", fmtArea(f.area)]);
      if (f.normal) rows.push(["Normal", fmtVec(new THREE.Vector3(...f.normal), false)]);
      if (f.axis) rows.push(["Axis", fmtVec(new THREE.Vector3(...f.axis), false)]);
      if (f.radius) rows.push(["Radius", fmtLen(f.radius)], ["Diameter", fmtLen(f.radius * 2)]);
      rows.push([f.type === "plane" || f.type === "other" ? "Centroid" : "Centre", fmtVec(viewer.toWorld(p, f.center))]);
      rows.push(["Boundary edges", String(f.edges.length)], ["Face #", String(f.id)]);
    } else if (e.edge) {
      const ed = e.edge;
      rows.push(["Curve", t(ed.type)], ["Length", fmtLen(ed.length)]);
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
    if (!e) html += `<h3 translate="no">${esc(n.name)}</h3>`;
    const rows: [string, string][] = [
      ["Path", esc(ps.length === 1 ? ps[0].path : n.name)],
      ["Parts", String(ps.length)],
      ["Size", `${fmtLen(s.x, false)} × ${fmtLen(s.y, false)} × ${fmtLen(s.z)}`],
      ["Volume", fmtVol(vol)], ["Surface area", fmtArea(area)],
      ["Faces / edges", `${ps.reduce((a, p) => a + p.data.faces.length, 0)} / ${ps.reduce((a, p) => a + p.data.edges.length, 0)}`],
      ["Triangles", ps.reduce((a, p) => a + p.data.index.length / 3, 0).toLocaleString()],
    ];
    if (ps.some(p => !p.data.closed)) rows.push(["Note", t("open shell: volume approximate")]);
    if (prod?.revision) rows.push(["Revision", esc(prod.revision)]);
    if (prod && prod.id !== prod.name) rows.push(["Part number", esc(prod.id)]);
    html += kv(rows);
    const first = ps[0];
    html += `<div class="row"><label>${t("Colour")} <input type="color" id="p-color" value="#${first.baseColor.getHexString()}"></label>
      <label class="slider" style="flex:1">${t("Opacity")} <input type="range" id="p-opacity" min="0.05" max="1" step="0.05" value="${first.opacity}"></label></div>
      <div class="row wrap"><button class="btn small" id="p-isolate">${t("Isolate (I)")}</button><button class="btn small" id="p-hide">${t("Hide (H)")}</button><button class="btn small" id="p-showall">${t("Show all (U)")}</button><button class="btn small" id="p-fit">${t("Zoom to")}</button><button class="btn small" id="p-reset">${t("Reset look")}</button></div>`;
  } else if (!e) {
    html += `<h3 translate="no">${esc(state.fileName)}</h3>`;
    const rows: [string, string][] = [];
    const m = state.meta;
    const s = overallSize();
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
      rows.push(["PMI / GD&T", pmi.length ? esc(pmi.map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ")) + " " + t("(listed; not drawn)") : t("none")]);
    }
    html += kv(rows) + `<p class="muted">${t("Click a face or edge to inspect it, or a part in the tree.")}</p>`;
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
const TOOL_KEYS: Record<string, Tool> = { d: "distance", m: "minDistance", r: "radius", c: "centerDistance", l: "arcLength", a: "angle", v: "point", b: "bbox", t: "note" };

function setTool(t: Tool) {
  if (t === "bbox") {
    const parts = state.selectedParts.length && state.selectedNode !== viewer.tree ? state.selectedParts : viewer.parts.filter(p => p.visible);
    addMeasurement(tagParts(measureBBox(viewer, parts, nextColor()), parts));
    return;
  }
  state.tool = t;
  state.picks = [];
  hl.pickMarks.clear();
  clearLive();
  $$("#tools button").forEach(b => { const on = b.dataset.tool === t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  updateHint();
  viewer.invalidate();
}

function updateHint() {
  const h = $("#tool-hint");
  const st = $("#st-hint");
  // The default tool's prompt sits in the status bar so it never covers the model; the banner is for
  // tools the user picked on purpose (they count picks and end with Esc).
  if (state.tool === "select") {
    h.hidden = true;
    st.innerHTML = !viewer.parts.length ? "" : state.selection && !state.livePair
      ? `<b>${t("Smart measure")}</b>: ${t("click a second point, edge or face to measure between them")} · ${t("Esc to clear")}`
      : `<b>${t("Smart measure")}</b>: ${t("click a point, edge or face; a second click measures between them")}`;
    return;
  }
  st.innerHTML = "";
  if (state.tool === "sectionFace") {
    h.hidden = false;
    h.innerHTML = `<b>${t("Section")}</b> · ${t("click a flat face to cut there, or a cylinder to cut through its axis")} · <span class="muted">${t("Esc to cancel")}</span>`;
    return;
  }
  const info = state.tool === "plane3" ? PLANE3_INFO : TOOL_INFO[state.tool];
  const n = state.picks.length;
  h.hidden = false;
  h.innerHTML = `<b>${t(info.title)}</b> · ${t(info.hint)} · ${t("pick {i}/{n}", { i: n + 1, n: info.picks })} · <span class="muted">${t("Esc to cancel")}</span>`;
}

$$("#tools button").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));

// ---------- tool strip and right-panel pages ----------
// The right panel shows one page (Properties, Section, Explode, Mass, Export) picked from the tabs at its top
// (FR-UI-118), so nothing sits below the fold. The header's panel button hides and shows the panel.
const rpTabs = $("#rp-tabs");
rpTabs.querySelectorAll<HTMLButtonElement>("[role=tab]").forEach(b => b.addEventListener("click", () => panels.show("right"), true));
/** The page tabs show their names while all five fit; else only the open page's (the rest keep icon + tooltip). */
function fitRpTabs() {
  rpTabs.classList.toggle("rp-icons", false);
  if (rpTabs.scrollWidth > rpTabs.clientWidth + 1) rpTabs.classList.toggle("rp-icons", true);
}
const showPage = bindTabs(rpTabs, tab => {
  $$(".rp").forEach(s => s.classList.toggle("on", s.id === `rp-${tab}`));
  fitRpTabs();
});
new ResizeObserver(fitRpTabs).observe(rpTabs);
onLangChange(fitRpTabs);
// The Section button works like CAD: press it, then click the face to cut on.
$("#rt-section").addEventListener("click", () => {
  const open = $("#rp-section").classList.contains("on") && !$("#app").classList.contains("no-right");
  if (open && viewer.parts.length && section.canAdd) setTool("sectionFace");
  else if (state.tool === "sectionFace") setTool("select");
});
/** Labels fold into icons (measuring tools first, then the page tabs) when the strip runs out of room. */
function fitToolbar() {
  const top = $(".topbar");
  top.classList.remove("tb-icons", "tb-nodisp", "tb-nobrand", "tb-wrap");
  if (isPcbMode()) return;
  if (innerWidth <= 900) { top.classList.add("tb-icons", "tb-wrap"); return; }
  const full = () => top.scrollWidth > top.clientWidth + 1;
  // Fold step by step: page labels into icons, the Display label, the name beside the logo, then wrap.
  for (const c of ["tb-icons", "tb-nodisp", "tb-nobrand", "tb-wrap"]) if (full()) top.classList.add(c);
}
new ResizeObserver(() => fitToolbar()).observe($(".topbar"));
// Resizable side panels and dialogs (FR-UI-002): the widths are remembered per panel side.
{
  const app = $("#app");
  const width = (name: string) => (px: number | null) => { if (px == null) app.style.removeProperty(name); else app.style.setProperty(name, `${px}px`); };
  const gl = makeGrip({ key: "left", axis: "x", sign: 1, def: 270, min: 200, max: () => Math.min(640, window.innerWidth * 0.4), apply: width("--left-w"), measure: () => document.querySelector<HTMLElement>("#app > .left:not([hidden])")?.offsetWidth || 270, label: "Resize the left panel" });
  const gr = makeGrip({ key: "right", axis: "x", sign: -1, def: 300, min: 240, max: () => Math.min(760, window.innerWidth * 0.45), apply: width("--right-w"), measure: () => document.querySelector<HTMLElement>("#app > .right:not([hidden])")?.offsetWidth || 300, label: "Resize the right panel" });
  gl.classList.add("grip-left");
  gr.classList.add("grip-right");
  app.append(gl, gr);
  rememberDialogSizes();
}
// Text that changes inside the header (the open file, its status, the kernel's state) can overflow it
// without resizing the bar itself, so fit again after such changes too.
{
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitToolbar(); });
  }).observe($(".topbar"), { childList: true, characterData: true, subtree: true });
}
new MutationObserver(() => fitToolbar()).observe($("#app"), { attributes: true, attributeFilter: ["class"] });
onLangChange(() => requestAnimationFrame(fitToolbar));

// ---------- command bar (FRS 13.2, FR-UI-010): tabs follow what is open ----------
bindCommandBar();
function syncCmTabs() {
  const app = $("#app");
  const list: CmTabId[] = app.classList.contains("gerber") ? []
    : app.classList.contains("model") ? ["features", "sketch", "surfaces", "sheetmetal", "weldments", "evaluate"]
    : app.classList.contains("asm") ? ["assembly", "evaluate"]
    : $("#empty").hidden ? ["evaluate"] : [];
  setCmTabs(list);
  fitCm();
}
/** Labels fold into icons (with tooltips) when the selected tab's buttons do not fit on one row. */
function fitCm() {
  const cm = $("#cm"), body = $("#cm-body");
  cm.classList.remove("cm-icons");
  if (!cm.hidden && body.scrollWidth > body.clientWidth + 1) cm.classList.add("cm-icons");
}
new MutationObserver(syncCmTabs).observe($("#app"), { attributes: true, attributeFilter: ["class"] });
new MutationObserver(syncCmTabs).observe($("#empty"), { attributes: true, attributeFilter: ["hidden"] });
{
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fitCm(); }); }).observe($("#cm-body"), { childList: true, subtree: true });
}
new ResizeObserver(() => fitCm()).observe($("#cm"));
onCmTab(() => requestAnimationFrame(fitCm));
onLangChange(() => { relabelCmTabs(); requestAnimationFrame(fitCm); });
syncCmTabs();
const PLANE3_INFO = { title: "Section plane", picks: 3, hint: "Pick three points on the plane" };

const PALETTE = ["#e8590c", "#2f9e44", "#1c7ed6", "#ae3ec9", "#f08c00", "#0ca678", "#e03131", "#5f3dc4"];
let colorIdx = 0;
function nextColor() {
  const input = $<HTMLInputElement>("#m-color");
  const c = input.value;
  input.value = PALETTE[++colorIdx % PALETTE.length];
  return c;
}

// ---------- associative measurements (modelling): re-measured after every rebuild, like SolidWorks reference dimensions ----------
/** Picks by persistent face and edge names, or null when one cannot be named (then the measurement stays fixed). */
function pickRefs(picks: Entity[]): PickRef[] | null {
  if (!modeller.active || !picks.length) return null;
  const out: PickRef[] = [];
  for (const e of picks) {
    const point = e.point.toArray() as V3, normal = e.normal?.toArray() as V3 | undefined;
    if (e.edge) {
      const ref = modeller.entityRef({ edge: e.edge });
      if (!ref) return null;
      const tol = 1e-6 * viewer.modelSize + 1e-9;
      const is = (q?: V3) => !!q && viewer.toWorld(e.part, q).distanceTo(e.point) <= tol;
      const at = is(e.edge.center) ? "center" : !e.edge.closed && is(e.edge.mid) ? "mid" : is(e.edge.start) ? "start" : is(e.edge.end) ? "end" : "near";
      out.push({ kind: e.kind, ref, at, point, normal });
    } else if (e.face) {
      const ref = modeller.entityRef({ faceId: e.face.id });
      if (!ref) return null;
      out.push({ kind: e.kind, ref, at: "near", point, normal });
    } else out.push({ kind: e.kind, point, normal });
  }
  return out;
}

/** The point of a polyline edge nearest to p. */
function nearestOnEdge(part: Part, pts: number[], p: THREE.Vector3) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3(), best = new THREE.Vector3();
  let bd = Infinity;
  for (let i = 3; i < pts.length; i += 3) {
    a.set(pts[i - 3], pts[i - 2], pts[i - 1]); b.set(pts[i], pts[i + 1], pts[i + 2]);
    new THREE.Line3(viewer.toWorld(part, a), viewer.toWorld(part, b)).closestPointToPoint(p, true, q);
    const d = q.distanceToSquared(p);
    if (d < bd) { bd = d; best.copy(q); }
  }
  return bd < Infinity ? best : p.clone();
}

/** The entities a measurement source names in the rebuilt part, or null if one has gone. */
function entitiesOf(src: MeasureSource): Entity[] | null {
  const part = viewer.parts[0];
  if (!part) return null;
  const out: Entity[] = [];
  for (const r of src.picks) {
    const old = new THREE.Vector3(...r.point), normal = r.normal ? new THREE.Vector3(...r.normal) : undefined;
    if (!r.ref) { out.push({ kind: r.kind, point: old, part, normal }); continue; }
    const hit = modeller.resolveRef(r.ref);
    if (hit?.edge) {
      const e = hit.edge, q = r.at === "center" ? e.center : r.at === "mid" ? e.mid : r.at === "start" ? e.start : r.at === "end" ? e.end : undefined;
      out.push({ kind: r.kind, part, edge: e, point: q ? viewer.toWorld(part, q) : nearestOnEdge(part, e.pts, old), normal });
    } else if (hit?.faceId != null) {
      const f = part.data.faces[hit.faceId];
      if (!f) return null;
      let point = old, n = normal;
      if (f.type === "plane" && f.normal) {
        n = new THREE.Vector3(...f.normal);
        const c = viewer.toWorld(part, f.center);
        point = old.clone().addScaledVector(n, -old.clone().sub(c).dot(n));
      }
      out.push({ kind: r.kind, part, face: f, point, normal: n });
    } else return null;
  }
  return out;
}

/** Re-measures the pinned measurements that follow the model, after a rebuild. */
function remeasure() {
  let lost = 0;
  for (const m of state.measurements) {
    if (!m.src) continue;
    const ents = entitiesOf(m.src);
    try {
      if (!ents) throw new Error("gone");
      const n = m.src.type === "smart" ? smartMeasure(viewer, ents, m.color, { circleMode: m.src.mode }) : measure(viewer, m.src.type, ents, m.color);
      const keep = { id: m.id, color: m.color, visible: m.visible, src: m.src };
      for (const k of Object.keys(m)) delete (m as unknown as Record<string, unknown>)[k];
      Object.assign(m, tagParts(n, ents.map(e => e.part)), keep);
    } catch {
      if (!m.stale) lost++;
      m.stale = true;
    }
  }
  if (lost) toast(t("{n} measurement lost its geometry and keeps its old value|{n} measurements lost their geometry and keep their old values", { n: lost }), true);
  refreshMeasurements();
}

function addMeasurement(m: Measurement) {
  state.measurements.push(m);
  state.selectedMeasurement = m.id;
  saveMeasurements();
  refreshMeasurements();
  const f = formatMeasurement(m);
  toast(`${f.title}: ${f.value}`);
}

/** A hollow ring, constant on screen, so the picked point and what is around it stay visible. */
const pickRing = new THREE.RingGeometry(0.6, 1, 24);
const pickRingMat = new THREE.MeshBasicMaterial({ color: 0xf59f00, depthTest: false, transparent: true, side: THREE.DoubleSide });
function pickMark(p: THREE.Vector3) {
  const m = new THREE.Mesh(pickRing, pickRingMat);
  m.position.copy(p);
  m.renderOrder = 2000;
  m.raycast = () => {};
  hl.pickMarks.add(screenSized(m, 6, true));
}

function handlePick(snap: Snap | null) {
  // Mass properties ▸ Pick axes: the click makes the output axes and selects nothing.
  if (mp.picking && snap) {
    const c = csysFrom(entityFromSnap(snap));
    if (!c) { toast(t("Pick a flat face, a straight edge, a circle, a cylinder or a point."), true); return; }
    addMassAxes({ ...c, name: t("Axes {n}", { n: mp.user.length + 1 }) });
    return;
  }
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
    if (!sp) toast(t("The three points are in line; pick points that span a plane"), true);
    setTool("select");
    renderSections();
    return;
  }
  if (state.tool === "sectionFace") {
    if (snap.face) sectionOnFace({ part: snap.part, face: snap.face, point: snap.point.clone() });
    return;
  }
  if (state.tool === "note") {
    const point = snap.point.clone(), part = snap.part;
    pickMark(point);
    viewer.invalidate();
    noteDialog("").then(text => {
      hl.pickMarks.clear();
      viewer.invalidate();
      if (text) { addMeasurement(tagParts(makeNote(point, text, nextColor()), [part])); hint("note"); }
    });
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
    const m = tagParts(measure(viewer, state.tool as MeasureType, state.picks, nextColor()), state.picks.map(p => p.part));
    const refs = pickRefs(state.picks);
    if (refs) m.src = { type: state.tool as MeasureType, picks: refs };
    addMeasurement(m);
  } catch (err) {
    toast(err instanceof MeasureError ? t(err.message) : t("Measurement failed: {err}", { err: (err as Error).message }), true);
  }
  state.picks = [];
  hl.pickMarks.clear();
  updateHint();
  viewer.invalidate();
}

/** Records which components a measurement was taken on (tree path and part number), for reports. */
function tagParts(m: Measurement, parts: Part[]) {
  const ids = [...new Set(parts.map(p => `${p.path || p.data.name} #${p.idx + 1}`))];
  if (ids.length) m.data.parts = ids.slice(0, 6).join("; ") + (ids.length > 6 ? `; +${ids.length - 6} more` : "");
  return m;
}

function sameEntity(a: Entity, b: Entity) {
  if (a.part !== b.part || a.kind !== b.kind) return false;
  if (a.kind === "point") return a.point.distanceToSquared(b.point) < 1e-12;
  return a.kind === "edge" ? a.edge === b.edge : a.face === b.face;
}

/** Measures one entity (its size) or two (the relation between them) and shows it until the next click. */
function showLive(picks: Entity[]) {
  try {
    state.live = tagParts(smartMeasure(viewer, picks, $<HTMLInputElement>("#m-color").value, { circleMode: state.circleMode }), picks.map(p => p.part));
    state.livePicks = picks;
  } catch (err) {
    state.live = null;
    state.livePicks = [];
    toast(t("Measurement failed: {err}", { err: (err as Error).message }), true);
  }
  state.livePair = picks.length === 2;
  if (state.livePair) state.selection = null;
  refreshMeasurements();
  updateHint();
  viewer.invalidate();
  if (state.live) hint(state.live.data.modes ? "pair" : "live");
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
  state.live = tagParts(smartBody(viewer, part, $<HTMLInputElement>("#m-color").value), [part]);
  state.livePicks = [];
  state.livePair = true;
  state.selection = null;
  hl.pickMarks.clear();
  showEntity(hl.selFace, hl.selEdge, null);
  refreshMeasurements();
  updateHint();
  viewer.invalidate();
}

/** Makes `c` the active coordinate system (null: global); positions, directions and ΔX/ΔY/ΔZ follow it. */
function setCsys(c: Csys | null, refresh = true, quiet = false) {
  csys.active = c;
  csysMark.visible = !!c;
  const reset = $("#csys-reset");
  reset.hidden = !c;
  if (c) reset.textContent = `⌖ ${t("CSYS: {name} · back to global", { name: t(c.name) })}`;
  fitToolbar();
  if (c) {
    csysMark.position.set(...c.origin);
    csysMark.setRotationFromMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...c.x), new THREE.Vector3(...c.y), new THREE.Vector3(...c.z)));
    csysMark.scale.setScalar(viewer.modelSize * 0.08);
  }
  if (!refresh) return;
  refreshMeasurements();
  renderProps();
  renderMass();
  showMassMarks();
  if (c && !quiet) toast(t("Coordinates relative to {name}", { name: t(c.name) }));
  viewer.invalidate();
}

/** A frame on a picked entity: planar face (Z its normal), straight edge (X along it), circle (Z its axis) or vertex (world axes). */
function csysFrom(e: Entity): Csys | null {
  const t = (v: THREE.Vector3) => v.toArray() as [number, number, number];
  if (e.kind === "point") return makeCsys("vertex", t(e.point), [0, 0, 1]);
  if (e.kind === "edge") {
    const ed = e.edge!;
    if (ed.type === "line") {
      const dir = new THREE.Vector3(...ed.dir!);
      // Z: the normal of a planar face on the edge, else world Z, made square to the edge.
      const plane = ed.faces.map(i => e.part.data.faces[i]).find(f => f?.type === "plane" && f.normal);
      let z = plane ? new THREE.Vector3(...plane.normal!) : new THREE.Vector3(0, 0, 1);
      if (Math.abs(z.dot(dir)) > 0.999) z = new THREE.Vector3(0, Math.abs(dir.z) > 0.9 ? 1 : 0, Math.abs(dir.z) > 0.9 ? 0 : 1);
      z.addScaledVector(dir, -z.dot(dir));
      return makeCsys("edge", t(viewer.toWorld(e.part, ed.start)), t(z), ed.dir!);
    }
    if (ed.center && ed.axis) return makeCsys("circle centre", t(viewer.toWorld(e.part, ed.center)), ed.axis);
    return null;
  }
  const f = e.face!;
  if (f.type === "plane" && f.normal) {
    // X along the face's longest straight edge, if it has one.
    const lines = f.edges.map(i => e.part.data.edges[i]).filter(x => x?.type === "line").sort((a, b) => b.length - a.length);
    return makeCsys("face", t(viewer.toWorld(e.part, f.centroid)), f.normal, lines[0]?.dir);
  }
  if (f.type === "cylinder" && f.axis) return makeCsys("cylinder axis", t(viewer.toWorld(e.part, f.center)), f.axis);
  return null;
}

function setCircleMode(mode: CircleMode) {
  state.circleMode = mode;
  if (state.livePicks.length === 2) showLive(state.livePicks);
}

function pinLive() {
  const m = state.live;
  if (!m) return;
  state.live = null;
  const refs = pickRefs(state.livePicks);
  if (refs) m.src = { type: "smart", mode: state.circleMode, picks: refs };
  nextColor();
  addMeasurement(m);
}

/**
 * Details of the live result (or the selected pinned measurement) in a card in
 * the viewport corner, away from the model; the label on the model stays one line.
 */
/** Copies a displayed value; a single number with a unit is copied as the bare number. */
function copyValue(text: string) {
  const txt = text.trim();
  const bare = /^[RØ]?S?Ø?\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|m|in|ft|°)$/.exec(txt);
  const out = bare ? bare[1] : txt;
  state.lastCopied = out;
  navigator.clipboard?.writeText(out).then(() => toast(t("Copied {v}", { v: out })), () => toast(t("Copy failed; value {v}", { v: out }), true));
}

function renderReadout() {
  const box = $("#readout");
  const m = state.live ?? state.measurements.find(x => x.id === state.selectedMeasurement);
  if (!m || !m.visible) { box.hidden = true; return; }
  const f = formatMeasurement(m);
  box.style.setProperty("--c", m.color);
  const det = f.pairs
    ? f.pairs.map(([k, x]) => `<span>${esc(k)} <b class="cp" translate="no" title="${esc(t("Click to copy, or drag into a box"))}">${esc(x)}</b></span>`)
    : f.details.map(d => `<span>${esc(d)}</span>`);
  const unitOpts = UNIT_LIST.map(u => `<option${u === units.current ? " selected" : ""}>${u}</option>`).join("");
  const decOpts = ["", "0", "1", "2", "3", "4", "5", "6"].map(d => `<option value="${d}"${String(units.decimals ?? "") === d ? " selected" : ""}>${d === "" ? t("auto") : t("{n} dp", { n: d })}</option>`).join("");
  box.classList.toggle("floating", state.readoutFloat);
  box.innerHTML = `<div class="ttl"><span>${esc(f.title)}</span><span class="hud-units"><button class="x dock" title="${t(state.readoutFloat ? "Dock in the corner" : "Float next to the measurement")}">${state.readoutFloat ? "⇲" : "⇱"}</button><select data-hud="units" title="${t("Units")}">${unitOpts}</select><select data-hud="decimals" title="${t("Decimal places")}">${decOpts}</select><button class="x close" title="${t("Close (Esc)")}">✕</button></span></div>
    <div class="val"><b class="cp" translate="no" title="${t("Click to copy, or drag into a box")}">${esc(f.value)}</b></div>${m === state.live && m.data.modes ? `<div class="modes seg">${CIRCLE_MODES.map(x => `<button data-cmode="${x.mode}" class="${x.mode === m.data.mode ? "on" : ""}">${t(x.label)}</button>`).join("")}</div>` : ""}<div class="det">${det.join("")}</div><div class="acts"></div>`;
  box.querySelector(".dock")!.addEventListener("click", () => {
    state.readoutFloat = !state.readoutFloat;
    storage.set("sv:readout", state.readoutFloat ? "float" : "dock");
    renderReadout();
  });
  box.querySelectorAll<HTMLElement>(".cp").forEach(el => { el.addEventListener("click", () => copyValue(el.textContent ?? "")); dragValue(el); });
  box.querySelector<HTMLSelectElement>('[data-hud="units"]')!.addEventListener("change", e => setUnits((e.target as HTMLSelectElement).value as Unit));
  box.querySelector<HTMLSelectElement>('[data-hud="decimals"]')!.addEventListener("change", e => setDecimals((e.target as HTMLSelectElement).value));
  box.querySelector(".close")!.addEventListener("click", () => {
    if (m === state.live) handlePick(null);
    else { state.selectedMeasurement = null; refreshMeasurements(); }
  });
  box.querySelectorAll<HTMLElement>("[data-cmode]").forEach(b => b.addEventListener("click", () => setCircleMode(b.dataset.cmode as CircleMode)));
  const acts = box.querySelector(".acts")!;
  const add = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = t(label);
    b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (m === state.live) {
    add("📌 Pin", pinLive);
    const e = state.selection;
    if (e && !state.livePair && e.kind === "face" && e.face?.type === "plane") add("✂ Section here", () => addSectionFromFace(e));
    if (e && !state.livePair) add("⬚ Whole part", () => showBody(e.part));
    const frame = e && !state.livePair ? csysFrom(e) : null;
    if (frame) add("⌖ CSYS here", () => setCsys(frame));
  }
  if (csys.active) add("⌖ Global CSYS", () => setCsys(null));
  box.hidden = false;
  placeReadout();
}

/**
 * A floating readout sits beside its measurement's label and follows it as the
 * view turns, flipping sides and staying inside the viewport; docked, it keeps to the corner.
 */
function placeReadout() {
  const box = $("#readout");
  if (box.hidden) return;
  const m = state.live ?? state.measurements.find(x => x.id === state.selectedMeasurement);
  if (!state.readoutFloat || !m) { box.style.left = box.style.top = ""; return; }
  const p = new THREE.Vector3(...m.labelAt).project(viewer.camera);
  const x = ((p.x + 1) / 2) * viewer.size.x, y = ((1 - p.y) / 2) * viewer.size.y;
  const w = box.offsetWidth, h = box.offsetHeight, gap = 24, pad = 8;
  let left = x + gap;
  if (left + w > viewer.size.x - pad) left = x - gap - w;
  let top = y + gap;
  if (top + h > viewer.size.y - pad) top = y - gap - h;
  box.style.left = `${Math.max(pad, Math.min(left, viewer.size.x - w - pad))}px`;
  box.style.top = `${Math.max(pad, Math.min(top, viewer.size.y - h - pad))}px`;
}
viewer.onRender(placeReadout);


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
  if (moved > 4 || btn !== 0 || !viewer.parts.length || modeller.picking || asm.picking) return;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const r = canvas.getBoundingClientRect();
  if (state.tool === "sectionFace") { sectionOnFace(faceUnder(e.clientX - r.left, e.clientY - r.top)); return; }
  if (e.altKey && state.tool === "select") { selectOther(e.clientX - r.left, e.clientY - r.top); return; }
  handlePick(snapper.pick(e.clientX - r.left, e.clientY - r.top));
});
/** Select other (FR-SEL-004): Alt+click picks the next face behind, cycling at the same spot. */
let otherAt: { x: number; y: number; i: number } | null = null;
function selectOther(x: number, y: number) {
  const faces = snapper.facesUnder(x, y);
  if (!faces.length) { handlePick(null); return; }
  const same = otherAt && Math.hypot(otherAt.x - x, otherAt.y - y) <= 4;
  const i = same ? (otherAt!.i + 1) % faces.length : Math.min(1, faces.length - 1);
  otherAt = { x, y, i };
  handlePick(null);
  handlePick(faces[i]);
  toast(t("Face {i} of {n} under the cursor (Alt+click for the next)", { i: i + 1, n: faces.length }));
}
canvas.addEventListener("pointermove", e => {
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  if (moveQueued || !viewer.parts.length) return;
  moveQueued = true;
  requestAnimationFrame(() => { moveQueued = false; hover(); });
});
canvas.addEventListener("pointerleave", () => { hideSnapMarks(); showEntity(hl.hoverFace, hl.hoverEdge, null); });
canvas.addEventListener("contextmenu", e => e.preventDefault());

function hideSnapMarks() { $("#snap-marker").hidden = true; $("#snap-hint").hidden = true; }

function hover() {
  if (downAt && (Math.abs(lastPointer.x - downAt.x) > 4 || Math.abs(lastPointer.y - downAt.y) > 4)) {
    hideSnapMarks(); return; // orbiting
  }
  if (section.arrowHot) { hideSnapMarks(); showEntity(hl.hoverFace, hl.hoverEdge, null); return; }
  const r = canvas.getBoundingClientRect();
  if (state.tool === "sectionFace") {
    // Picking a face to cut on: light up the whole face under the cursor, no point snapping.
    hideSnapMarks();
    const f = faceUnder(lastPointer.x - r.left, lastPointer.y - r.top);
    showEntity(hl.hoverFace, hl.hoverEdge, f ? { part: f.part, face: f.face, kind: "face" } : null);
    return;
  }
  const snap = snapper.pick(lastPointer.x - r.left, lastPointer.y - r.top);
  state.lastSnap = snap;
  // The hovered edge's centre or midpoint, shown faintly so it can be picked (SolidWorks-style inference).
  const hint = snapper.hint, hintEl = $("#snap-hint");
  hintEl.hidden = !hint || (!!snap && snap.point.distanceTo(hint.point) < 1e-9);
  if (hint && !hintEl.hidden) {
    const hs = hint.point.clone().project(viewer.camera);
    hintEl.dataset.kind = hint.kind;
    hintEl.style.transform = `translate(${((hs.x + 1) / 2) * viewer.size.x}px, ${((1 - hs.y) / 2) * viewer.size.y}px)`;
  }
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
  const labels: Record<string, string> = { onCap: "Section", vertex: "Vertex", midpoint: "Midpoint", quadrant: "Quadrant", intersection: "Intersection", circleCenter: "Centre", faceCenter: "Face centre", onEdge: "Edge", onFace: "Face" };
  const tag = snap.section && snap.kind !== "onCap" ? t("Cut {what}", { what: t(labels[snap.kind]).toLowerCase() }) : t(labels[snap.kind]);
  marker.innerHTML = `<i class="glyph"></i>` + (snap.kind === "onFace" ? "" : `<span class="snap-tag">${tag}</span>`);
  $("#st-snap").textContent = tag;
  $("#st-coord").textContent = fmtVec(snap.point) + (snap.normal ? `   n ${fmtVec(snap.normal, false)}` : "");
  const ent = entityFromSnap(snap);
  showEntity(hl.hoverFace, hl.hoverEdge, ent.kind === "point" ? null : ent);
}

// ---------- measurements list ----------
function refreshMeasurements() {
  const host = $("#m-list");
  $("#m-count").textContent = String(state.measurements.length);
  for (const id of ["#m-csv", "#m-json", "#m-pdf", "#m-clear"]) $<HTMLButtonElement>(id).disabled = !state.measurements.length && id !== "#m-pdf" || !viewer.parts.length;
  if (!state.measurements.length) emptyState(host, {
    icon: "ruler", title: t("No measurements yet"),
    text: t(viewer.parts.length ? "Click a face or edge with Smart measure; pin a result to keep it here." : "Open a model, then click faces and edges to measure them."),
    cta: t(viewer.parts.length ? "Start Smart measure" : "Open file"),
    action: () => { if (!viewer.parts.length) openPicker(); else { setTool("select"); vpEl.querySelector("canvas")?.focus(); } },
  });
  else {
    const focusedIdx = document.activeElement?.closest("#m-list .m-item") ? [...host.children].indexOf(document.activeElement.closest(".m-item")!) : -1;
    host.innerHTML = "";
    state.measurements.forEach((m, i) => {
      const f = formatMeasurement(m);
      const el = document.createElement("div");
      el.className = "m-item" + (m.id === state.selectedMeasurement ? " sel" : "");
      el.setAttribute("role", "listitem");
      el.style.setProperty("--c", m.color);
      const title = `${i + 1}. ${f.title}` + (m.stale ? ` (${t("out of date")})` : "");
      el.innerHTML = `<span class="dot" aria-hidden="true"></span><button class="m-main" aria-pressed="${m.id === state.selectedMeasurement}" title="${esc(`${title}: ${f.value}`)}"><span class="t">${esc(title)}</span><span class="val">${esc(f.value)}</span></button>
        <span class="acts"><input type="color" value="${m.color}" title="${t("Colour")}" aria-label="${t("Colour of measurement {n}", { n: i + 1 })}"><button title="${t("Show/hide")}" aria-label="${t(m.visible ? "Hide measurement {n}" : "Show measurement {n}", { n: i + 1 })}" aria-pressed="${m.visible}">${m.visible ? "👁" : "◌"}</button><button title="${t("Delete")}" aria-label="${t("Delete measurement {n}", { n: i + 1 })}">✕</button></span>`;
      el.querySelector(".m-main")!.addEventListener("click", () => { state.selectedMeasurement = m.id; refreshMeasurements(); });
      const [color, vis, del] = el.querySelectorAll<HTMLElement>(".acts input, .acts button");
      color.addEventListener("click", e => e.stopPropagation());
      color.addEventListener("input", e => { m.color = (e.target as HTMLInputElement).value; saveMeasurements(); refreshMeasurements(); });
      vis.addEventListener("click", e => { e.stopPropagation(); m.visible = !m.visible; saveMeasurements(); refreshMeasurements(); });
      del.addEventListener("click", e => { e.stopPropagation(); deleteMeasurement(m.id); });
      host.appendChild(el);
    });
    if (focusedIdx >= 0) (host.children[Math.min(focusedIdx, host.children.length - 1)] as HTMLElement | undefined)?.querySelector<HTMLElement>(".m-main")?.focus();
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
  const el = (e.target as HTMLElement).closest<HTMLElement>(".m-label");
  const id = el?.dataset.id;
  if (!id) return;
  if (el!.dataset.dragged) { delete el!.dataset.dragged; return; }
  state.selectedMeasurement = state.selectedMeasurement === id ? null : id;
  refreshMeasurements();
});

// Double-click a note to change its text.
$("#labels").addEventListener("dblclick", async e => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".m-note")?.dataset.id;
  const m = state.measurements.find(x => x.id === id);
  if (!m) return;
  const text = await noteDialog(String(m.data.text ?? ""));
  if (text === null) return;
  if (!text) { deleteMeasurement(m.id); return; }
  m.data.text = text;
  saveMeasurements();
  refreshMeasurements();
});
annotations.onNoteMoved = () => saveMeasurements();

/** Asks for a note's text. Resolves with the trimmed text ("" when emptied), or null on Cancel / Esc. */
function noteDialog(initial: string): Promise<string | null> {
  const d = $<HTMLDialogElement>("#note-dlg");
  const area = $<HTMLTextAreaElement>("#note-text");
  area.value = initial;
  $("#note-title").textContent = t(initial ? "Edit note" : "Add a note");
  if (d.open) d.close();
  const opener = document.activeElement as HTMLElement | null;
  d.returnValue = "";
  d.showModal();
  area.focus();
  area.select();
  return new Promise(resolve => {
    const onClick = (e: Event) => { const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a; if (a) d.close(a); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); d.close("ok"); } };
    const onClose = () => {
      if (d.open) return;
      d.removeEventListener("click", onClick);
      d.removeEventListener("close", onClose);
      area.removeEventListener("keydown", onKey);
      opener?.focus?.();
      resolve(d.returnValue === "ok" ? area.value.trim().slice(0, 500) : null);
    };
    d.addEventListener("click", onClick);
    d.addEventListener("close", onClose);
    area.addEventListener("keydown", onKey);
  });
}

function saveMeasurements() { if (state.fileKey) storage.set(state.fileKey, JSON.stringify(state.measurements)); }
function loadMeasurements() {
  try { state.measurements = JSON.parse(storage.get(state.fileKey) ?? "[]"); } catch { state.measurements = []; }
  state.selectedMeasurement = null;
  refreshMeasurements();
  if (state.measurements.length) toast(t("Restored {n} saved measurement|Restored {n} saved measurements", { n: state.measurements.length }));
}

$("#m-clear").addEventListener("click", async () => {
  if (!state.measurements.length || !await confirmModal(t("Delete all measurements for this model?"), t("Delete all"))) return;
  state.measurements = [];
  saveMeasurements();
  refreshMeasurements();
});
$("#m-json").addEventListener("click", () => state.measurements.length ? measurementsJson(state.measurements, state.fileName) : toast(t("No measurements yet")));
$("#m-csv").addEventListener("click", () => state.measurements.length ? measurementsCsv(state.measurements, state.fileName) : toast(t("No measurements yet")));

const showLeftTab = bindTabs($(".tabs"), tab => { $$(".tab").forEach(t => t.classList.toggle("on", t.id === `tab-${tab}`)); if (tab === "vault") void vaultPanel.render(); });
// Local vault (FRS 12.5): the Vault tab.
const vaultPanel = new VaultPanel($("#vault-panel"), {
  open: async (name, data, replace) => {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const go = async () => {
      if (modeller.isPartName(name)) await modeller.openFile({ name, data: buf });
      else if (asm.isAsmName(name)) await asm.openFile({ name, data: buf });
      else await openFiles([new File([buf], name)]);
    };
    // A vault file reloaded after a vault action stays in its own tab instead of opening a second one.
    if (replace && docs) await docs.replacing(go); else await go();
  },
  show: async id => {
    const tab = docs?.tabs.find(x => x !== docs!.active && (x.state as { vault?: { id: string } | null } | null)?.vault?.id === id);
    if (!tab) return false;
    await docs!.activate(tab.id);
    return true;
  },
  doc: () => {
    const k = fileMenuLive();
    if (k === "drawing") return { name: drawing.title, kind: "drawing", tie: drawing.vault, bytes: async () => (await drawing.packed())?.data ?? null, setVault: v => drawing.setVault(v), markSaved: () => drawing.markSaved() };
    if (k === "part" && modeller.active) return { name: plainLabel(modeller.partName), kind: "part", tie: modeller.vault, bytes: () => modeller.partBytes(), setVault: v => modeller.setVault(v), markSaved: () => modeller.markSaved() };
    if (k === "asm" && asm.active) return { name: asm.title, kind: "assembly", tie: asm.vault, bytes: async () => asm.bytes(), setVault: v => asm.setVault(v), markSaved: () => asm.markSaved() };
    return null;
  },
});
/**
 * Shows the vault's file list: the Vault tab of the side panel, or, when that panel is not on screen (a
 * drawing, a PCB, a phone, the panel folded away), the same list in a window.
 */
function showVault() {
  const panel = $("#vault-panel"), home = $("#tab-vault");
  const win = document.getElementById("vault-win") as HTMLDialogElement | null;
  if (win?.open) return;
  const side = $("#tree-panel");
  if (!drawing.open && side.offsetParent !== null && side.getBoundingClientRect().width > 150) { showLeftTab("vault"); return; }
  let d = win;
  if (!d) {
    d = document.createElement("dialog");
    d.id = "vault-win";
    d.className = "modal v-dlg vault-win";
    d.setAttribute("aria-labelledby", "vault-win-title");
    d.innerHTML = `<div class="vault-win-h"><h3 id="vault-win-title">${t("Vault")}</h3><button class="btn small" data-a="close">${t("Close")}</button></div><div class="vault-win-b"></div>`;
    document.body.appendChild(d);
    trapFocus(d, () => d!.open);
    d.querySelector("[data-a=close]")!.addEventListener("click", () => d!.close());
    d.addEventListener("close", () => home.appendChild(panel));
  }
  d.querySelector(".vault-win-b")!.appendChild(panel);
  void vaultPanel.render();
  d.showModal();
}
const vaultMenu = new VaultMenu({ panel: vaultPanel, showPanel: showVault });
/** The Vault button says which vault is open. */
function syncVaultButton() {
  const b = $("#vault-btn"), v = vaultPanel.vault;
  b.classList.toggle("on", !!v);
  b.title = v ? t("Vault {name}: check out, check in, history, versions", { name: v.info.name }) : t("Vault: keep every version of your files, in a folder or in the browser");
  b.setAttribute("aria-label", b.title);
}
vaultPanel.onChange = syncVaultButton;
onLangChange(syncVaultButton);
$("#vault-btn").addEventListener("click", e => vaultMenu.toggle(e.currentTarget as HTMLElement));

// ---------- display / views ----------
function setMode(m: DisplayMode) {
  viewer.setMode(m);
  edgeDepth(hl.hoverEdge); edgeDepth(hl.selEdge);
  section.rebuild();
  $$("#display-mode button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
}
$$("#display-mode button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode as DisplayMode)));
function setProjection(p: "perspective" | "orthographic") {
  viewer.setProjection(p);
  storage.set("sv:proj", p);
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
  if (v === "more") viewsMenu(b); else if (v === "fit") viewer.fit(); else if (v === "normal") normalTo(); else viewer.viewFrom(VIEWS[v]);
}));
/** The standard views a narrow header hides, as a menu under the ▾ button beside Fit. */
function viewsMenu(btn: HTMLElement) {
  const was = document.querySelector("#views-menu");
  if (was) { was.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.className = "mc-menu";
  m.id = "views-menu";
  m.setAttribute("role", "menu");
  const close = () => { m.remove(); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  const away = (e: Event) => { if (!m.contains(e.target as Node) && e.target !== btn) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); } };
  for (const b of $$<HTMLButtonElement>("#views button")) {
    const v = b.dataset.view!;
    if (v === "fit" || v === "more") continue;
    const it = document.createElement("button");
    it.setAttribute("role", "menuitem");
    it.dataset.view = v;
    it.textContent = b.textContent;
    it.title = b.title;
    it.addEventListener("click", () => { close(); b.click(); });
    m.append(it);
  }
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.round(r.left)}px`;
  m.style.top = `${Math.round(r.bottom + 4)}px`;
  document.body.append(m);
  btn.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", esc, true);
  m.querySelector("button")?.focus();
}
/** World box of the picked face, edge or parts, for Zoom to selection (FR-UI-103). */
function selectionBox(): THREE.Box3 | null {
  const sk = modeller.sketchSelectionBox();
  if (sk) return sk;
  const s = state.selection;
  const b = new THREE.Box3();
  if (s?.face) {
    const g = s.part.mesh.geometry, pos = g.attributes.position, idx = g.index;
    const v = new THREE.Vector3();
    for (let i = s.face.triStart * 3; i < (s.face.triStart + s.face.triCount) * 3; i++) b.expandByPoint(v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(s.part.mesh.matrixWorld));
    return b;
  }
  if (s?.edge) {
    const v = new THREE.Vector3(), q = s.edge.pts;
    for (let i = 0; i + 2 < q.length; i += 3) b.expandByPoint(v.set(q[i], q[i + 1], q[i + 2]).applyMatrix4(s.part.mesh.matrixWorld));
    return b;
  }
  if (s) return b.expandByPoint(s.point.clone());
  const parts = state.selectedParts.length && state.selectedNode !== viewer.tree ? state.selectedParts : [];
  parts.forEach(p => b.expandByObject(p.mesh));
  return parts.length ? b : null;
}
bindValueDrops();
bindLongPress();
const nav = bindNavigation({
  viewer,
  views: VIEWS,
  active: () => !drawing.open && !isPcbMode() && viewer.parts.length + (modeller.active ? 1 : 0) > 0,
  normalTo: () => normalTo(),
  selectionBox,
  pointAt: (x, y) => {
    const r = viewer.renderer.domElement.getBoundingClientRect();
    return snapper.pick(x - r.left, y - r.top)?.point.clone() ?? faceUnder(x - r.left, y - r.top)?.point ?? null;
  },
  // Named views (FR-UI-104): a part or an assembly keeps them in its document; a model file for this session.
  namedViews: () => {
    if (modeller.active) return modeller.namedViews();
    if (asm.active) return asm.namedViews();
    const key = state.fileKey || state.fileName;
    if (!key) return null;
    const list = () => sessionViews.get(key) ?? [];
    return {
      list: () => [...list()],
      save: v => sessionViews.set(key, [...list().filter(x => x.name !== v.name), v]),
      remove: name => sessionViews.set(key, list().filter(x => x.name !== name)),
    };
  },
});
const sessionViews = new Map<string, NamedView[]>();
// Heads-up view bar (FR-UI-022): with a part or an assembly open, the view commands float at the top centre of the
// view (as in SolidWorks): Zoom to area, Previous view, the standard views, projection and display style. The
// header's own groups are moved there (their buttons and handlers stay the same) and go back for model files.
{
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.className = "hud";
  // A plain group, not role=toolbar: a toolbar's arrow keys would move focus along it, so after a click on Front the
  // arrows did nothing at all; here they turn the view, as in SolidWorks (exam #78).
  hud.setAttribute("role", "group");
  hud.setAttribute("aria-label", t("View"));
  hud.hidden = true;
  hud.innerHTML = `<div class="seg" role="group"><button type="button" data-hud="area" title="${t("Zoom to area")}" aria-label="${t("Zoom to area")}">⬚</button>`
    + `<button type="button" data-hud="prev" title="${t("Previous view (Alt+Z)")}" aria-label="${t("Previous view (Alt+Z)")}">↶</button>`
    + `<button type="button" data-hud="section" aria-pressed="false" title="${t("Section view")}" aria-label="${t("Section view")}">◫</button></div>`;
  hud.querySelector('[data-hud="section"]')!.addEventListener("click", () => toggleSectionView());
  hud.querySelector('[data-hud="area"]')!.addEventListener("click", () => nav.startZoomArea());
  hud.querySelector('[data-hud="prev"]')!.addEventListener("click", () => nav.previousView());
  $("#viewport").append(hud);
  const moved = ["#views", "#projection", "#display-mode"].map(sel => { const el = $(sel), mark = document.createComment(sel); el.before(mark); return { el, mark }; });
  const sync = () => {
    const app = $("#app"), on = (app.classList.contains("model") || app.classList.contains("asm")) && !app.classList.contains("gerber");
    if (on === !hud.hidden) return;
    hud.hidden = !on;
    for (const { el, mark } of moved) { if (on) hud.append(el); else mark.after(el); }
    requestAnimationFrame(fitToolbar);
    place();
  };
  // Centred on the view, but moved left when it would reach the confirmation corner or the view cube.
  const place = () => {
    if (hud.hidden) return;
    const vp = $("#viewport").getBoundingClientRect(), w = hud.offsetWidth;
    let limit = vp.right;
    for (const el of document.querySelectorAll<HTMLElement>("#navcube, #mc-confirm:not([hidden]):not(.at-cursor), #asm-confirm:not([hidden]):not(.at-cursor)")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.top < vp.top + 60) limit = Math.min(limit, r.left);
    }
    const left = Math.max(8, Math.min((vp.width - w) / 2, limit - vp.left - 8 - w));
    hud.style.left = `${Math.round(left)}px`;
  };
  new ResizeObserver(place).observe($("#viewport"));
  new ResizeObserver(place).observe(hud);
  for (const id of ["#mc-confirm", "#asm-confirm"]) new MutationObserver(place).observe($(id), { attributes: true, attributeFilter: ["hidden", "class"] });
  new MutationObserver(sync).observe($("#app"), { attributes: true, attributeFilter: ["class"] });
  sync();
  onLangChange(() => {
    for (const [k, label] of [["area", "Zoom to area"], ["prev", "Previous view (Alt+Z)"], ["section", "Section view"]] as const) {
      const b = hud.querySelector<HTMLElement>(`[data-hud="${k}"]`)!;
      b.title = t(label); b.setAttribute("aria-label", t(label));
    }
  });
}
void nav;
/** Normal to the sketch plane, or the selected flat face; again flips to the other side. */
let lastNormal: THREE.Vector3 | null = null;
function normalTo(given?: [number, number, number]) {
  let n: THREE.Vector3 | null = null;
  const sn = modeller.sketchNormal();
  if (given) n = new THREE.Vector3(...given);
  else if (sn) n = new THREE.Vector3(...sn);
  else if (state.selection?.kind === "face" && state.selection.face?.normal && state.selection.face.type === "plane") n = new THREE.Vector3(...state.selection.face.normal);
  else { const pn = modeller.selectedPlaneNormal(); if (pn) n = new THREE.Vector3(...pn); }
  if (!n) { toast(t("Select a flat face first (or open a sketch).")); return; }
  const cam = viewer.camera.position.clone().sub(viewer.controls.target).normalize();
  if (lastNormal && lastNormal.equals(n) && cam.dot(n) > 0.999) n.negate();
  lastNormal = n.clone();
  viewer.viewFrom(n);
}
// Display menu: a small popover under the header button; Esc, a click outside or the button closes it.
{
  const btn = $("#display-btn"), menu = $("#display-menu");
  const set = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.querySelector<HTMLElement>("input")?.focus();
  };
  btn.addEventListener("click", () => set(menu.hidden));
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) set(false); });
  menu.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); set(false); btn.focus(); } });
  window.addEventListener("resize", () => set(false));
}
// Mouse gestures (FR-UI-024): the settings dialog; the part controller reads the stored settings on each right press.
$("#gestures-btn").addEventListener("click", () => { $("#display-menu").hidden = true; $("#display-btn").setAttribute("aria-expanded", "false"); gestureDialog(c => toast(t(c.on ? "Mouse gestures on: right-drag in a part or a sketch." : "Mouse gestures off."))); });
// Preferences (FR-UI-080). The mouse page acts on the view controls here; the part controller reads the rest.
const applyMousePrefs = () => {
  viewer.controls.mouseButtons.MIDDLE = getPref("middle") === "rotate" ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  viewer.controls.zoomSpeed = getPref("wheel") === "reverse" ? -1 : 1;
};
applyMousePrefs();
onPrefs(applyMousePrefs);
$("#prefs-btn").addEventListener("click", () => {
  $("#display-menu").hidden = true; $("#display-btn").setAttribute("aria-expanded", "false");
  openPrefs({
    units: () => units.current, decimals: () => (units.decimals === null ? "" : String(units.decimals)),
    setUnits: u => setUnits(u as Unit), setDecimals: d => setDecimals(d),
    gestures: () => gestureDialog(c => toast(t(c.on ? "Mouse gestures on: right-drag in a part or a sketch." : "Mouse gestures off."))),
  });
});
$<HTMLInputElement>("#ao").addEventListener("change", e => { viewer.aoEnabled = (e.target as HTMLInputElement).checked; viewer.invalidate(); });
// Surface analyses (FR-MEA-005): picked in the Display menu, set up and explained in a panel in the view.
const surfAna = new SurfaceAnalysis(viewer, {
  faceNormal: () => (state.selection?.kind === "face" && state.selection.face?.normal && state.selection.face.type === "plane" ? state.selection.face.normal : null),
}, $("#ana-panel"), k => { $<HTMLSelectElement>("#analysis").value = k ?? ""; });
$<HTMLSelectElement>("#analysis").addEventListener("change", e => surfAna.set(((e.target as HTMLSelectElement).value || null) as Parameters<typeof surfAna.set>[0]));

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
const help = bindModal($<HTMLDialogElement>("#help"));
$("#help-btn").addEventListener("click", () => help.open());
renderHelp($("#help-body"));
const tipsBox = $<HTMLInputElement>("#tips-on");
tipsBox.checked = tipsOn();
tipsBox.addEventListener("change", () => setTips(tipsBox.checked));
$("#help").addEventListener("close", () => { tipsBox.checked = tipsOn(); });
$("#help-btn").addEventListener("click", () => { tipsBox.checked = tipsOn(); });

// ---------- interface language ----------
function showLang() {
  const b = $("#lang-btn");
  b.textContent = lang().toUpperCase();
  // The accessible name starts with the visible code (WCAG 2.5.3, label in name).
  b.setAttribute("aria-label", `${lang().toUpperCase()}: ${t("Interface language: English. Switch to Russian")}`);
  b.title = t("Interface language: English. Switch to Russian");
}
$("#lang-btn").addEventListener("click", () => setLang(lang() === "ru" ? "en" : "ru"));
showLang();
setDoc("", "idle");
onLangChange(() => {
  showLang();
  renderHelp($("#help-body"));
  relocalizeHint();
  setDoc(...docState);
  if (isPcbMode()) pcbStats(); else if (viewer.parts.length) showModelStats();
  if (viewer.parts.length) document.title = isPcbMode() ? `${gerber.name} · PCB · MöbiusCAD` : `${state.fileName} · MöbiusCAD`;
  if (!viewer.tree) buildTree();
  else for (const [n, el] of nodeEls) el.querySelector(":scope > .row-n .eye")?.setAttribute("aria-label", t("Show or hide {name}", { name: n.name }));
  renderProps();
  refreshMeasurements();
  updateHint();
  renderSections();
  renderMaterials();
  renderMass();
  validateDensity();
  if (csys.active) $("#csys-reset").textContent = `⌖ ${t("CSYS: {name} · back to global", { name: t(csys.active.name) })}`;
  fitToolbar();
  syncUnitsButton();
  gerber.relocalize();
});

/** A unit picked anywhere: with a part open it is the part's unit, one undo step (FR-UI-116). */
function setUnits(u: Unit) {
  if (modeller.active && modeller.store) { modeller.setDocUnits(u); applyUnits(u); return; }
  applyUnits(u);
}
function applyUnits(u: Unit) {
  units.current = u;
  $<HTMLSelectElement>("#units").value = u;
  syncUnitsButton();
  storage.set("sv:units", u);
  refreshMeasurements();
  renderProps();
  renderSections();
  renderMass();
}
function setDecimals(d: string) {
  units.decimals = d === "" ? null : Number(d);
  $<HTMLSelectElement>("#decimals").value = d;
  syncUnitsButton();
  storage.set("sv:decimals", d);
  refreshMeasurements();
  renderProps();
  renderSections();
  renderMass();
}
// Units in the status bar (FR-UI-116): the unit and decimals; a click opens the choices.
const UNIT_NAMES: Record<Unit, string> = { mm: "Millimetres (mm)", cm: "Centimetres (cm)", m: "Metres (m)", in: "Inches (in)", ft: "Feet (ft)" };
function syncUnitsButton() {
  const b = document.getElementById("st-units");
  if (!b) return;
  b.textContent = `${units.current} · ${units.decimals ?? t("auto")}`;
  b.title = t("Units and decimals: click to change");
}
function openUnitsMenu() {
  const b = $("#st-units"), old = document.getElementById("st-units-menu");
  if (old) { old.remove(); b.setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.id = "st-units-menu";
  m.className = "menu st-units-menu";
  m.setAttribute("role", "menu");
  m.innerHTML = `<p class="menu-h">${t("Units")}</p>` + UNIT_LIST.map(u => `<button type="button" role="menuitemradio" aria-checked="${u === units.current}" data-u="${u}">${esc(t(UNIT_NAMES[u]))}</button>`).join("")
    + `<p class="menu-h">${t("Decimals")}</p><div class="st-dec">` + ["", "0", "1", "2", "3", "4", "5", "6"].map(d => `<button type="button" role="menuitemradio" aria-checked="${(units.decimals === null ? "" : String(units.decimals)) === d}" data-d="${d}">${d === "" ? esc(t("Auto")) : d}</button>`).join("") + `</div>`;
  document.body.appendChild(m);
  const r = b.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${r.top - m.offsetHeight - 6}px`;
  b.setAttribute("aria-expanded", "true");
  const close = () => { m.remove(); b.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", away, true); };
  const away = (e: Event) => { if (!m.contains(e.target as Node) && e.target !== b) close(); };
  document.addEventListener("pointerdown", away, true);
  m.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); b.focus(); } });
  m.querySelectorAll<HTMLButtonElement>("[data-u]").forEach(x => x.addEventListener("click", () => { close(); setUnits(x.dataset.u as Unit); }));
  m.querySelectorAll<HTMLButtonElement>("[data-d]").forEach(x => x.addEventListener("click", () => { close(); setDecimals(x.dataset.d!); }));
  m.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}
$("#st-units").addEventListener("click", openUnitsMenu);
bindCommandTips($("#cm"));
syncUnitsButton();
$("#csys-reset").addEventListener("click", () => setCsys(null));
$<HTMLSelectElement>("#units").addEventListener("change", e => setUnits((e.target as HTMLSelectElement).value as Unit));
$<HTMLSelectElement>("#decimals").addEventListener("change", e => setDecimals((e.target as HTMLSelectElement).value));
{
  const u = storage.get("sv:units") as Unit | null;
  if (u && UNIT_LIST.includes(u)) { units.current = u; $<HTMLSelectElement>("#units").value = u; }
  const d = storage.get("sv:decimals");
  if (d && /^[0-6]$/.test(d)) { units.decimals = Number(d); $<HTMLSelectElement>("#decimals").value = d; }
  syncUnitsButton();
}
$$<HTMLInputElement>("[data-snap]").forEach(c => c.addEventListener("change", () => {
  (SNAP_FILTERS as Record<string, boolean>)[c.dataset.snap!] = c.checked;
}));

// ---------- section ----------
snapper.sectionSource = () => section.profiles();
section.onDragging = on => { dragging = on; };
section.onChange = () => updateSectionReadouts();

/** The heads-up Section view button is pressed while a section plane cuts the model. */
function syncSectionHud() {
  const hb = document.querySelector<HTMLElement>('#hud [data-hud="section"]');
  if (!hb) return;
  const on = section.planes.some(sp => sp.enabled && sp.label !== "Sketch");
  hb.setAttribute("aria-pressed", String(on));
  hb.classList.toggle("on", on);
}
/** Heads-up Section view (FR-UI-022): turns every section plane off or on again; with none it cuts at the selected flat face, else through the middle on the front plane. */
function toggleSectionView() {
  if (!viewer.parts.length) return;
  const ps = section.planes.filter(sp => sp.label !== "Sketch");
  if (!ps.length) {
    const e = state.selection;
    addSection(e && e.kind === "face" && e.face?.type === "plane" ? "face" : "y");
  } else {
    const on = !ps.some(sp => sp.enabled);
    for (const sp of ps) section.setEnabled(sp, on);
    renderSections();
  }
}
function addSection(kind: string) {
  if (!viewer.parts.length) return;
  if (state.tool === "sectionFace") setTool("select");
  if (!section.canAdd) { toast(t("Up to 3 section planes"), true); return; }
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
    if (!e || e.kind !== "face" || e.face?.type !== "plane") { toast(t("Select a planar face first"), true); return; }
    addSectionFromFace(e);
    return;
  }
  section.add(label, axis, c.dot(axis));
  renderSections();
  hint("section");
}
/** The B-rep face under a canvas point (section clipping respected), or null. */
function faceUnder(sx: number, sy: number) {
  const hit = viewer.pickMeshes(new THREE.Vector2((sx / viewer.size.x) * 2 - 1, -(sy / viewer.size.y) * 2 + 1));
  if (!hit || hit.faceIndex == null) return null;
  const part = viewer.partOf(hit.object);
  const face = part?.data.faces[part.triFace[hit.faceIndex]];
  return face ? { part, face, point: hit.point.clone() } : null;
}

/** Section from a face click: on a flat face the plane lies on it; on a cylinder it runs through the axis, square to the view. */
function sectionOnFace(f: ReturnType<typeof faceUnder>) {
  if (!f) return null;
  if (!section.canAdd) { toast(t("Up to 3 section planes"), true); setTool("select"); return null; }
  const { part, face, point } = f;
  let sp: SectionPlane | null = null;
  if (face.type === "plane" && face.normal) {
    const n = new THREE.Vector3(...face.normal);
    const p = viewer.toWorld(part, face.centroid);
    sp = section.add("Face", n, p.dot(n) - viewer.modelSize * 1e-4, point);
  } else if (face.type === "cylinder" && face.axis) {
    const a = new THREE.Vector3(...face.axis).normalize();
    const n = viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
    n.addScaledVector(a, -n.dot(a));
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1).cross(a).lengthSq() > 1e-8 ? n.set(0, 0, 1).cross(a) : n.set(1, 0, 0).cross(a);
    n.normalize();
    const c = viewer.toWorld(part, face.center);
    sp = section.add("Axis", n, c.dot(n), c);
  } else {
    toast(t("Click a flat or cylindrical face"), true);
    return null;
  }
  setTool("select");
  renderSections();
  hint("section");
  return sp;
}
function addSectionFromFace(e: Entity) {
  if (!section.canAdd) { toast(t("Up to 3 section planes"), true); return null; }
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

let sectionCount = 0;
function renderSections() {
  syncSectionHud();
  // A new plane (from the strip, a face, the result card or three points) brings up the Section page.
  if (section.planes.length > sectionCount) showPage("section");
  sectionCount = section.planes.length;
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
      <button class="btn tiny ${g === "translate" ? "on" : ""}" data-a="move" title="Show the drag arrows">↕</button>
      <button class="btn tiny ${g === "rotate" ? "on" : ""}" data-a="rot" title="Rotate gizmo (drag the rings)">⟳</button>
      <button class="btn tiny" data-a="flip" title="Flip the kept side">⇅</button>
      <button class="btn tiny" data-a="del" title="Remove">✕</button></div>
      <div class="ctl"><input type="range" data-k="range" min="${lo}" max="${hi}" step="${(hi - lo) / 1000 || 0.001}" value="${sp.offset}">
      <input type="number" data-k="off" step="any" value="${(sp.offset / f).toFixed(4)}" title="${t("Offset along the normal ({u})", { u: units.current })}"></div>
      <div class="ctl"><span class="lbl">Step</span><input type="number" data-k="step" step="any" min="0" value="${(Math.max((hi - lo) / 100, 1e-6) / f).toPrecision(3)}" title="${t("Step ({u})", { u: units.current })}">
      <button class="btn tiny" data-a="minus">−</button><button class="btn tiny" data-a="plus">+</button></div>
      <div class="ctl angles"><span class="lbl">Az</span><input type="number" data-k="az" step="1" value="${ang.az.toFixed(2)}" title="Normal azimuth from +X about Z (°)">
      <span class="lbl">El</span><input type="number" data-k="el" step="1" value="${ang.el.toFixed(2)}" title="Normal elevation from the XY plane (°)"></div>
      <div class="stat" data-k="stat"></div>
      <div class="ctl"><span class="lbl">${t("Cut profile")}</span><button class="btn tiny" data-a="dxf" title="${t("Save the cut curves as a 2D DXF drawing (mm) for CAD, laser or waterjet")}">DXF</button><button class="btn tiny" data-a="svg" title="${t("Save the cut curves as SVG at 1:1 (mm)")}">SVG</button></div>`;
    const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const chk = q<HTMLInputElement>('input[type="checkbox"]'), range = q<HTMLInputElement>('[data-k="range"]'), num = q<HTMLInputElement>('[data-k="off"]');
    const step = q<HTMLInputElement>('[data-k="step"]'), az = q<HTMLInputElement>('[data-k="az"]'), elv = q<HTMLInputElement>('[data-k="el"]');
    chk.addEventListener("change", () => { section.setEnabled(sp, chk.checked); updateSectionDeps(); syncSectionHud(); });
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
    q('[data-a="dxf"]').addEventListener("click", () => saveProfile(sp, "dxf"));
    q('[data-a="svg"]').addEventListener("click", () => saveProfile(sp, "svg"));
    host.appendChild(el);
  }
  updateSectionReadouts();
  updateSectionDeps();
}

/** The plane's cut curves as a 2D drawing file. */
function saveProfile(sp: SectionPlane, kind: "dxf" | "svg") {
  if (sp.result === null) section.updateProfiles();
  const d = sp.enabled ? profileDrawing(viewer, sp) : null;
  if (!d) { toast(t("This plane does not cut the model"), true); return; }
  const title = `${state.fileName} · ${sp.label} @ ${sp.offset.toFixed(3)} mm`;
  const name = `${baseName()}-section-${sp.label.toLowerCase()}`;
  if (kind === "dxf") download(new Blob([toDxf(d, title)], { type: "image/vnd.dxf" }), `${name}.dxf`);
  else download(new Blob([toSvg(d, title)], { type: "image/svg+xml" }), `${name}.svg`);
  toast(t("Saved {n} curves", { n: d.entities.length }));
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
    stat.textContent = [t("Cut area {a}", { a: fmtArea(res.area) }), t("{n} parts", { n: res.profiles.length }), t("{n} curves", { n: curves }), ...(circles ? [t("{n} circles", { n: circles })] : [])].join(" · ");
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
  if (!p) { toast(t("Select a single part first"), true); return; }
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
const matBtn = $<HTMLButtonElement>("#material");
/** The material the density on the Mass page came from (its name), or null for a typed density. */
let massMat: string | null = "Steel (carbon)";
function renderMaterials() {
  matBtn.innerHTML = `<span translate="no">${esc(massMat ? t(massMat) : t("Custom…"))}</span> …`;
}
renderMaterials();
matBtn.addEventListener("click", () => void pickMaterial({ current: massMat ? { name: massMat, density: +$<HTMLInputElement>("#density").value || 1 } : null }).then(r => {
  if (!r?.material) return;
  massMat = r.material.name;
  $<HTMLInputElement>("#density").value = String(r.material.density);
  renderMaterials();
  validateDensity();
}));
$<HTMLInputElement>("#density").addEventListener("input", () => { massMat = null; renderMaterials(); validateDensity(); });
/** Inline validation of the density field; returns the density or null when it is not usable. */
function validateDensity(): number | null {
  const inp = $<HTMLInputElement>("#density"), err = $("#density-err");
  const v = parseFloat(inp.value);
  const msg = t(inp.value.trim() === "" ? "Enter a density in g/cm³, for example 7.85 for steel." : !(v > 0) || !isFinite(v) ? "Density must be a number greater than 0 g/cm³." : "");
  err.textContent = msg;
  err.hidden = !msg;
  inp.setAttribute("aria-invalid", String(!!msg));
  $<HTMLButtonElement>("#mass-run").disabled = !!msg;
  return msg ? null : v;
}
let lastMass: [string, string][] = [];
/** Inputs of the last mass calculation, so the table can be rebuilt in another language (the PDF is English). */
let lastMassRun: { r: MassResult; c: Combined; n: number; whole: boolean; density: number; perPart: boolean; exact: boolean; ovr: { mass: boolean; com: boolean } } | null = null;
/** Mass Properties panel (Evaluate ▸ Mass properties): open, Include hidden bodies, Show principal axes, output frame. */
const mp = {
  open: false, hidden: false, axes: true,
  /** Output frame key: "active" (the active CSYS), "global", "f:<feature id>" (a part coordinate system) or "u:<i>" (axes added here). */
  frame: "active",
  /** Axes the user added in the panel (picked on the model or typed), world mm. */
  user: [] as Csys[],
  /** The next click on the model makes axes (picked, not selected). */
  picking: false,
  typing: false,
};
const frameOf = (c: Csys | null): Frame | null => (c ? { origin: c.origin, x: c.x, y: c.y, z: c.z } : null);
/** The output coordinate system: the active one unless the panel asks for the global one. */
function mpFrame(): Csys | null {
  const k = mp.frame;
  if (k === "active") return csys.active;
  if (k.startsWith("u:")) return mp.user[+k.slice(2)] ?? null;
  if (k.startsWith("f:") && modeller.active) {
    const f = modeller.csysList().find(x => x.id === k.slice(2));
    return f ? makeCsys(f.name, f.o, f.z, f.x) : null;
  }
  return null;
}
/** Adds user axes and makes them the output frame. */
function addMassAxes(c: Csys) {
  mp.user.push(c);
  mp.frame = `u:${mp.user.length - 1}`;
  mp.picking = false; mp.typing = false;
  renderMassPanel(); showMassMarks();
}
const fmtI = (v: number, massG: number) => { const u = inertiaUnit(massG); return `${fmtNum(v * u.k)}`; };
function massRows(): [string, string][] {
  if (!lastMassRun) return [];
  const { r, c, n, whole, density, perPart, ovr } = lastMassRun;
  const rep = massReport(c, frameOf(csys.active)), u = inertiaUnit(c.mass).label, sfx = ` (${t("overridden")})`;
  const tri = (a: number, b: number, d: number) => `${fmtI(a, c.mass)}, ${fmtI(b, c.mass)}, ${fmtI(d, c.mass)} ${u}`;
  const rows: [string, string][] = [
    ["Scope", whole ? t("whole model") : t("{n} parts", { n })],
    ["Density", perPart ? t("from part materials") : `${density} g/cm³`],
    ["Volume", fmtVol(c.volume)], ["Mass", fmtMass(c.mass) + (ovr.mass ? sfx : "")], ["Surface area", fmtArea(c.area)],
    ["Centre of mass", fmtVec(new THREE.Vector3(...c.com)) + (ovr.com ? sfx : "")],
    ["Principal moments", tri(...rep.principal.moments)],
    ["Principal axes", rep.principal.axes.map(a => `(${a.map(x => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(3)).join(", ")})`).join(" ")],
    ["Moments at centre of mass", `Lxx, Lyy, Lzz = ${tri(rep.atCom.xx, rep.atCom.yy, rep.atCom.zz)}`],
    ["Products at centre of mass", `Lxy, Lyz, Lzx = ${tri(rep.atCom.xy, rep.atCom.yz, rep.atCom.zx)}`],
    ["Moments at origin", `Ixx, Iyy, Izz = ${tri(rep.atOrigin.xx, rep.atOrigin.yy, rep.atOrigin.zz)}`],
    ["Bounding box", `${fmtLen(r.bbox.x, false)} × ${fmtLen(r.bbox.y, false)} × ${fmtLen(r.bbox.z)}`],
    ["Box volume", fmtVol(r.bboxVolume)], ["Fill ratio", r.bboxVolume ? `${((c.volume / r.bboxVolume) * 100).toFixed(1)} %` : "-"],
  ];
  if (r.openParts.length) rows.push(["Warning", t("{n} open shells: volume not reliable", { n: r.openParts.length })]);
  return rows;
}
function renderMass() {
  $("#mass-out").innerHTML = lastMassRun ? kv(massRows().map(([k, v]) => [k, esc(v)])) : "";
  renderMassPanel();
}
/** The parts mass properties are taken of: the selected ones, else the shown ones (all with Include hidden bodies). */
function massParts() {
  const sel = state.selectedParts.length && state.selectedNode !== viewer.tree ? state.selectedParts : null;
  return sel ?? (mp.hidden ? viewer.parts : viewer.parts.filter(p => p.visible));
}
function runMass() {
  if (!viewer.parts.length) return;
  const parts = massParts();
  const density = validateDensity();
  if (density === null) return;
  // Assemblies take each component's part material (the field's density where a part has none), like the BOM.
  const each = asm.active ? (p: Part) => { const i = viewer.parts.indexOf(p); return asm.partMasses(i, density) ?? asm.partDensity(i) ?? density; } : density;
  let r = massProperties(viewer, parts, each);
  // A modelled part whose bodies have their own materials (FR-MAT-001): each body weighs with its density.
  const own = modeller.active && parts.length === 1 ? modeller.bodyMasses(density) : null;
  if (own) {
    const c = combine(own.map(b => ({ ...b, area: 0 })));
    r = { ...r, ...c, volume: r.volume, area: r.area, com3: new THREE.Vector3(...c.com), densities: [...new Set(own.map(b => b.density))] };
  }
  const whole = !(state.selectedParts.length && state.selectedNode !== viewer.tree);
  // Mass property override of a modelled part (FR-MAT-004): an entered mass scales the moments with it; an entered centre moves it.
  const o = whole && modeller.active ? modeller.massOverride() : null;
  let c: Combined = r;
  const ovr = { mass: false, com: false };
  if (o?.mass !== undefined && r.mass > 0) {
    const k = (o.mass * 1000) / r.mass;
    c = { ...c, mass: o.mass * 1000, cov: c.cov.map(v => v * k) as Combined["cov"] };
    ovr.mass = true;
  }
  if (o?.com) { c = { ...c, com: [...o.com] }; ovr.com = true; }
  lastMassRun = { r, c, n: parts.length, whole, density, perPart: r.densities.length > 1 || (asm.active && r.densities.some(d => d !== density)), exact: parts.every(p => p.data.exact), ovr };
  lastMass = withLang("en", massRows);
  renderMass();
  showMassMarks();
}
/** Centre of mass ball (Show CoM or the panel) and principal axes (panel) in the view. */
function showMassMarks() {
  const c = lastMassRun?.c;
  hl.com.visible = !!c && ($<HTMLInputElement>("#com-show").checked || mp.open);
  mpAxes.visible = !!c && mp.open && mp.axes && c.mass > 0;
  const f = mp.open ? mpFrame() : null;
  mpFrameMark.visible = !!f && f !== csys.active;
  if (f) {
    mpFrameMark.position.set(...f.origin);
    mpFrameMark.setRotationFromMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z)));
    mpFrameMark.scale.setScalar(Math.max(viewer.modelSize * 0.1, 1));
  }
  if (c) {
    hl.com.position.set(...c.com);
    mpAxes.position.set(...c.com);
    const p = principal(c.cov), L = Math.max(viewer.modelSize * 0.35, 1);
    p.axes.forEach((a, i) => {
      const g = (mpAxes.children[i] as THREE.Line).geometry;
      g.setAttribute("position", new THREE.Float32BufferAttribute([-a[0] * L, -a[1] * L, -a[2] * L, a[0] * L, a[1] * L, a[2] * L], 3));
      g.computeBoundingSphere();
    });
  }
  viewer.invalidate();
}
$("#mass-run").addEventListener("click", e => busy(e.currentTarget as HTMLElement, runMass));
// Mass properties panel (FR-MAT-002): Evaluate ▸ Mass properties, like SolidWorks' dialog but beside the view,
// following the selection, visibility, units and coordinate system while it is open.
const mpPanel = $("#mp-panel"), mpBtn = $("#mp-btn");
function massView(): MassView | null {
  const run = lastMassRun;
  if (!run) return null;
  const active = csys.active, f = mpFrame();
  const options = [
    { key: "global", name: t("Default (global)") },
    ...(active ? [{ key: "active", name: `${t(active.name)} (${t("active")})` }] : []),
    ...(modeller.active ? modeller.csysList().map(c => ({ key: `f:${c.id}`, name: c.name })) : []),
    ...mp.user.map((c, i) => ({ key: `u:${i}`, name: c.name })),
  ];
  const key = f ? mp.frame : "global";
  const notes: string[] = [];
  if (run.r.openParts.length) notes.push(t("{n} open shells: volume not reliable", { n: run.r.openParts.length }));
  if (!run.exact) notes.push(t("Some values come from the tessellation, so curved faces make them approximate."));
  if (run.c.partial) notes.push(t("Some bodies have no moments of inertia; only their mass is counted."));
  if (run.perPart) notes.push(t("Each part uses its own material; parts without one use {d} g/cm³.", { d: run.density }));
  if (run.c.mass <= 0) notes.push(t("The density is 0, so there is no mass."));
  return {
    rep: massReport(run.c, frameOf(f)),
    scope: run.whole ? t("Whole model ({n} parts)", { n: run.n }) : t("{n} selected parts", { n: run.n }),
    density: run.perPart ? t("from part materials") : `${run.density} g/cm³`,
    frame: { name: f ? t(f.name) : t("Default (global)"), options, key, picking: mp.picking, typing: mp.typing, user: key.startsWith("u:"), unit: units.current },
    hidden: mp.hidden, axes: mp.axes, notes, overridden: run.ovr, canMaterial: !asm.active,
  };
}
function renderMassPanel() {
  mpPanel.hidden = !mp.open;
  mpBtn.classList.toggle("on", mp.open);
  mpBtn.setAttribute("aria-pressed", String(mp.open));
  if (mp.open) mpPanel.innerHTML = massPanelHtml(massView(), t("Open a model to begin."));
}
function openMassPanel(on = !mp.open) {
  mp.open = on;
  if (on && viewer.parts.length) runMass();
  renderMassPanel();
  showMassMarks();
}
/** Runs again while the panel is open (selection, visibility or a rebuild changed what it measures). */
function massChanged() { if (mp.open && viewer.parts.length) runMass(); }
/** Output axes other than the global ones, drawn while the panel is open. */
const mpFrameMark = new THREE.AxesHelper(1);
(mpFrameMark.material as THREE.LineBasicMaterial).depthTest = false;
mpFrameMark.renderOrder = 2000;
mpFrameMark.visible = false;
viewer.scene.add(mpFrameMark);
mpBtn.addEventListener("click", () => openMassPanel());
mpPanel.addEventListener("click", e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-mp]")?.dataset.mp;
  if (a === "close") openMassPanel(false);
  else if (a === "recalc") runMass();
  else if (a === "pick") { mp.picking = !mp.picking; mp.typing = false; if (mp.picking && state.tool !== "select") setTool("select"); renderMassPanel(); }
  else if (a === "type") { mp.typing = !mp.typing; mp.picking = false; renderMassPanel(); mpPanel.querySelector<HTMLInputElement>("[data-ax]")?.focus(); }
  else if (a === "delframe" && mp.frame.startsWith("u:")) {
    mp.user.splice(+mp.frame.slice(2), 1);
    mp.frame = "global";
    renderMassPanel(); showMassMarks();
  } else if (a === "addaxes") {
    const num = (k: string) => parseFloat(mpPanel.querySelector<HTMLInputElement>(`[data-ax="${k}"]`)?.value.replace(",", ".") ?? "");
    const v3 = (k: string): V3 => [num(`${k}0`), num(`${k}1`), num(`${k}2`)];
    const o = v3("o").map(x => x * unitMm()) as V3, x = v3("x"), z = v3("z");
    const bad = [...o, ...x, ...z].some(n => !isFinite(n)) || Math.hypot(...x) < 1e-9 || Math.hypot(...z) < 1e-9;
    const cr = Math.hypot(x[1] * z[2] - x[2] * z[1], x[2] * z[0] - x[0] * z[2], x[0] * z[1] - x[1] * z[0]) / (Math.hypot(...x) * Math.hypot(...z) || 1);
    if (bad || cr < 1e-6) { toast(t("Enter an origin and two directions that are not parallel."), true); return; }
    const name = mpPanel.querySelector<HTMLInputElement>('[data-ax="name"]')?.value.trim() || t("Axes {n}", { n: mp.user.length + 1 });
    addMassAxes(makeCsys(name, o, z, x));
  }
  else if (a === "copy") {
    const v = massView();
    if (v) navigator.clipboard?.writeText(massText(v)).then(() => toast(t("Mass properties copied")), () => toast(t("Could not copy to the clipboard"), true));
  } else if (a === "material") {
    if (modeller.active) modeller.editProps();
    else { panels.show("right"); showPage("mass"); $("#material").focus(); }
  }
});
mpPanel.addEventListener("change", e => {
  const el = e.target as HTMLInputElement, k = el.dataset.mp;
  if (k === "frame") { mp.frame = el.value; renderMassPanel(); showMassMarks(); }
  else if (k === "hidden") { mp.hidden = el.checked; runMass(); }
  else if (k === "axes") { mp.axes = el.checked; showMassMarks(); }
});
mpPanel.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); openMassPanel(false); mpBtn.focus(); } });
onLangChange(renderMassPanel);

$<HTMLInputElement>("#com-show").addEventListener("change", showMassMarks);

// ---------- export ----------
/** An empty new part or assembly: say so instead of doing nothing. */
const nothingToExport = () => toast(t("There is no body to export yet."), true);
const baseName = () => state.fileName.replace(/\.[^.]+$/, "") || "model";
function bgColor() { return getComputedStyle(document.documentElement).getPropertyValue("--vp-top").trim() || "#ffffff"; }
for (const [id, transparent] of [["#png", false], ["#png-t", true]] as const) {
  $(id).addEventListener("click", () => {
    if (!viewer.parts.length) { nothingToExport(); return; }
    const scale = parseInt($<HTMLSelectElement>("#png-scale").value);
    const c = snapshot(viewer, annotations, { scale, transparent, background: bgColor() });
    c.toBlob(b => b && download(b, `${baseName()}${transparent ? "-transparent" : ""}.png`), "image/png");
  });
}
$$("[data-export]").forEach(b => b.addEventListener("click", async () => {
  if (!viewer.parts.length) { nothingToExport(); return; }
  try { await exportMesh(viewer, b.dataset.export as "stl", baseName()); }
  catch (err) { toast(t("Export failed: {err}", { err: (err as Error).message }), true); }
}));
function report() {
  if (!viewer.parts.length) { nothingToExport(); return; }
  if (!lastMass.length) runMass();
  const s = overallSize();
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
  withLang("en", () => inspectionReport({ fileName: state.fileName, meta, mass: lastMass, measurements: state.measurements, image }));
}
$("#report").addEventListener("click", e => busy(e.currentTarget as HTMLElement, report));
$("#step-export").addEventListener("click", e => busy(e.currentTarget as HTMLElement, exportStep));
$("#m-pdf").addEventListener("click", e => busy(e.currentTarget as HTMLElement, report));

// ---------- File menu (FR-UI-010) ----------
/** Prints the 3D view as it is shown (File ▸ Print, Ctrl+P). */
function print3d() {
  if (!viewer.parts.length) { toast(t("Nothing to print yet.")); return; }
  const url = snapshot(viewer, annotations, { scale: 2, transparent: false, background: "#ffffff" }).toDataURL("image/png");
  const fr = document.createElement("iframe");
  fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  fr.setAttribute("aria-hidden", "true");
  document.body.appendChild(fr);
  const d = fr.contentDocument!;
  const title = (docState[0] || baseName()).replace(/\s*•$/, "");
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[&<>]/g, "")}</title><style>@page{margin:10mm}html,body{margin:0}img{display:block;max-width:100%;max-height:100vh;margin:auto;object-fit:contain}</style></head><body><img src="${url}" alt=""></body></html>`);
  d.close();
  const img = d.querySelector("img")!;
  const go = () => { try { fr.contentWindow!.focus(); fr.contentWindow!.print(); } finally { setTimeout(() => fr.remove(), 60_000); } };
  if (img.complete) setTimeout(go, 50); else img.onload = () => setTimeout(go, 50);
}
const appGen = `MöbiusCAD ${__APP_VERSION__}`;
const plainLabel = (s: string) => s.replace(/\s*•$/, "");
/** Saves the live document (File ▸ Save / Save as). A model file has no document of ours: Save as keeps a copy of it. */
async function saveLive(as: boolean) {
  const k = fileMenuLive();
  if (k === "drawing") await drawing.save(as);
  else if (k === "part") await modeller.save(as);
  else if (k === "asm") await asm.save(as);
  else if (k === "model" && modelSrc && as) download(new Blob([modelSrc.data]), modelSrc.name);
}
function fileMenuLive(): LiveKind {
  if (drawing.open) return "drawing";
  if (isPcbMode()) return "pcb";
  const k = docs?.active?.kind;
  if (k && k !== "drawing") return k;
  return modeller.active ? "part" : asm.active ? "asm" : viewer.parts.length ? "model" : null;
}
const fileMenu = new FileMenu({
  live: fileMenuLive,
  docCount: () => docs?.tabs.length ?? 0,
  dirtyCount: () => docs?.dirtyTabs().length ?? 0,
  open: () => { warmKernel(); openPicker(); },
  openFiles: fs => void openFiles(fs),
  newPart: () => $("#new-part").click(),
  newAsm: () => $("#new-asm").click(),
  newDrawing: () => $("#new-drawing").click(),
  get openDrawing() { return liveModelKey() ? () => void openDrawingOf() : null; },
  get asmFromPart() { return modeller.active && !drawing.open ? () => $("#new-asm-part").click() : null; },
  async close() { const a = docs?.active; if (a) await docs!.close(a.id); },
  async closeAll() {
    if (!docs) return true;
    for (const tab of [...docs.tabs].reverse()) { await docs.close(tab.id); if (docs.tabs.includes(tab)) return false; }
    return true;
  },
  save: as => saveLive(as),
  async saveAll() {
    if (!docs) return;
    const todo = docs.dirtyTabs().filter(x => x.kind !== "model");
    if (!todo.length) { toast(t("Nothing to save: every document is saved.")); return; }
    const start = docs.active;
    for (const tab of todo) {
      if (tab.state != null) await docs.activate(tab.id);
      else if (tab.kind === "drawing" ? !drawing.open : drawing.open && docs.active?.kind === "drawing") await docs.activate(tab.id);
      await saveLive(false);
    }
    if (start && docs.active !== start && docs.tabs.includes(start)) await docs.activate(start.id);
  },
  packDocs() {
    if (!docs) return [];
    return docs.tabs.map((tab): PackDoc => {
      const live = tab.state == null, label = plainLabel(tab.label);
      if (tab.kind === "part") {
        const st = tab.state as PartTab | null;
        return { label, kind: "part", live, async files() {
          const doc = st ? st.store.doc : modeller.store!.doc;
          const data = st ? await packPart(doc, appGen) : (await modeller.partBytes())!;
          return [{ name: (st ? st.fileName : plainLabel(modeller.partName)) || `${doc.name}${PART_EXT}`, data }];
        } };
      }
      if (tab.kind === "asm") {
        const st = tab.state as AsmTab | null;
        const doc = () => (st ? st.doc : asm.doc!);
        return {
          label, kind: "asm", live,
          async files() { return [{ name: (st ? st.fileName : asm.title) || `${doc().name}${ASM_EXT}`, data: await packAsm(doc(), appGen) }]; },
          async parts() {
            return Promise.all(Object.values(doc().parts).map(async p => p.asm
              ? { name: `${p.asm.name || p.name}${ASM_EXT}`, data: await packAsm(p.asm, appGen) }
              : { name: /\.mcadprt$/i.test(p.file) ? p.file : `${p.doc.name || p.name}${PART_EXT}`, data: await packPart(p.doc, appGen) }));
          },
        };
      }
      if (tab.kind === "drawing") {
        const st = tab.state as DrawingTab | null;
        return { label, kind: "drawing", live, async files() { const r = await drawing.packed(st ?? undefined); return r ? [r] : []; } };
      }
      const src = (tab.state as { name: string; data: ArrayBuffer } | null) ?? modelSrc;
      return { label, kind: "model", live, async files() { return src ? [{ name: src.name, data: new Uint8Array(src.data.slice(0)) }] : []; } };
    });
  },
  download: (b, n) => download(b, n),
  exportDoc() {
    if (drawing.open) { drawing.openExportMenu(); return; }
    $("#rt-export").click();
  },
  print() {
    if (drawing.open) void drawing.exportAs("print");
    else print3d();
  },
  vault: btn => vaultMenu.toggle(btn),
  properties() {
    if (drawing.open) drawing.sheetProperties();
    else if (fileMenuLive() === "part") modeller.editProps();
    else $("#rt-props").click();
  },
});
$("#file-btn").addEventListener("click", e => fileMenu.toggle(e.currentTarget as HTMLElement));

// ---------- keyboard ----------
window.addEventListener("keydown", e => {
  if (drawing.open) return;
  const t = e.target as HTMLElement;
  if (t.matches("input, select, textarea")) return;
  // Keyboard users: let Enter / Space press the focused control, and keep keys inside dialogs and sheets.
  if ((e.key === "Enter" || e.key === " ") && t.matches("button, summary, a, [role=treeitem], [role=tab]")) return;
  if (t.closest("dialog") || ($("#app").dataset.sheet && t.closest(".sheet"))) return;
  // Standard views Ctrl+1..7 and Normal to Ctrl+8 (FR-UI-030/031).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[1-8]$/.test(e.key) && viewer.parts.length + (modeller.active ? 1 : 0) > 0 && !isPcbMode()) {
    e.preventDefault();
    if (e.key === "8") normalTo();
    else viewer.viewFrom(VIEWS[["front", "back", "left", "right", "top", "bottom", "iso"][+e.key - 1]]);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "F1" || e.key === "?") { e.preventDefault(); help.open(); return; }
  if (isPcbMode()) { if (gerber.onKey(e)) e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === "escape") {
    if (state.tool !== "select") setTool("select");
    else { handlePick(null); state.selectedMeasurement = null; refreshMeasurements(); }
    stopDrag();
    if (section.active) { section.setGizmo(null, null); renderSections(); }
    return;
  }
  if (k === "n" && viewer.parts.length + (modeller.active ? 1 : 0) > 0) { normalTo(); return; }
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
    $("#st-fps").textContent = frames ? `${Math.round((frames * 1000) / (now - last))} fps` : t("idle");
    frames = 0; last = now;
  }, 1000);
}

// ?url=… opens a STEP file from a URL (same origin or CORS-enabled).
{
  const url = new URLSearchParams(location.search).get("url");
  if (url) {
    fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(buf => openBuffer(buf, decodeURIComponent(url.split("/").pop() || "model.step")))
      .catch(err => toast(t("Could not load {url}: {err}", { url, err: err.message }), true));
  }
}

renderProps();
buildTree();
refreshMeasurements();

// Debug/test handle: always in dev, and with ?debug in a build (used by tests/smoke.mjs).
// Orthographic by default (true dimensions on screen); the last choice is remembered.
setProjection(storage.get("sv:proj") === "perspective" ? "perspective" : "orthographic");

if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) Object.assign(window, { __sv: { tutorial, surfAna, modeller, asm, motion, drawing, drw: drawing.debug(), vault: vaultPanel, vaultFolders: { useMemory: useMemoryFolders }, model: modeller.debug(), gerber, openPcb, toast, viewer, state, snapper, setMode, section, annotations, handlePick, setTool, showBody, setCircleMode, setUnits, setDecimals, setCsys, csysFrom, csys, quadrants, virtualCorners, originAxes, hl, kernel, exportStep, renderSections, timings: () => Object.assign(timings, kernel.timing) } });
