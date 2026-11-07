import * as THREE from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { jsPDF } from "jspdf";
import type { TreeNode } from "../topology";
import type { Viewer } from "../viewer/Viewer";
import type { Annotations } from "./Annotations";
import { formatMeasurement, type Measurement } from "./measure";
import { units } from "./units";
import { csys } from "./csys";
import { zip } from "../model/zip";

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Plain meshes (no edge lines) with exploded offsets baked in, grouped like the assembly tree. */
function exportScene(v: Viewer) {
  const root = new THREE.Group();
  root.name = v.tree?.name ?? "model";
  const build = (n: TreeNode, parent: THREE.Object3D) => {
    const g = new THREE.Group();
    g.name = n.name;
    parent.add(g);
    for (const i of n.parts) {
      const p = v.parts[i];
      if (!p.visible) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", p.mesh.geometry.getAttribute("position"));
      geo.setAttribute("normal", p.mesh.geometry.getAttribute("normal"));
      geo.setIndex(p.mesh.geometry.getIndex());
      const mat = new THREE.MeshStandardMaterial({ color: p.material.color.clone(), metalness: 0.15, roughness: 0.55, name: p.data.name });
      if (p.data.colors) mat.color.copy(p.baseColor);
      const m = new THREE.Mesh(geo, mat);
      m.name = p.data.name;
      m.position.copy(p.group.position);
      g.add(m);
    }
    n.children.forEach(c => build(c, g));
  };
  if (v.tree) build(v.tree, root);
  root.updateMatrixWorld(true);
  return root;
}

/**
 * 3MF (FR-STO-021): one object per visible part, in millimetres, with its colour as a base material.
 * Vertices are welded so slicers see closed shells.
 */
export async function to3mf(scene: THREE.Object3D): Promise<Uint8Array> {
  const objs: string[] = [], items: string[] = [], mats: string[] = [];
  let id = 1;
  const f = (x: number) => (Math.abs(x) < 1e-12 ? "0" : String(Math.round(x * 1e6) / 1e6));
  const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getIndex();
    const key = new Map<string, number>(), verts: string[] = [], remap: number[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const k = `${f(v.x)},${f(v.y)},${f(v.z)}`;
      let j = key.get(k);
      if (j == null) { j = verts.length; key.set(k, j); verts.push(`<vertex x="${f(v.x)}" y="${f(v.y)}" z="${f(v.z)}"/>`); }
      remap.push(j);
    }
    const tris: string[] = [];
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = remap[idx ? idx.getX(t) : t], b = remap[idx ? idx.getX(t + 1) : t + 1], c = remap[idx ? idx.getX(t + 2) : t + 2];
      if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    if (!tris.length) return;
    const col = ((m.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0.7, 0.7, 0.7)).getHexString().toUpperCase();
    mats.push(`<base name="${xml(m.name || `Part${id}`)}" displaycolor="#${col}FF"/>`);
    const oid = id++;
    objs.push(`<object id="${oid + 1}" type="model" name="${xml(m.name || `Part${oid}`)}" pid="1" pindex="${mats.length - 1}"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${oid + 1}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">MöbiusCAD</metadata><resources><basematerials id="1">${mats.join("")}</basematerials>${objs.join("")}</resources><build>${items.join("")}</build></model>`;
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>` },
    { name: "3D/3dmodel.model", data: model },
  ]);
}

export async function exportMesh(v: Viewer, format: "stl" | "obj" | "glb" | "3mf", baseName: string) {
  const scene = exportScene(v);
  // Mesh exports are written in the active coordinate system (FR-REF-005).
  const c = csys.active;
  if (c) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...c.x), new THREE.Vector3(...c.y), new THREE.Vector3(...c.z)).setPosition(c.origin[0], c.origin[1], c.origin[2]);
    scene.applyMatrix4(m.invert());
    scene.updateMatrixWorld(true);
  }
  if (format === "stl") {
    const data = new STLExporter().parse(scene, { binary: true }) as DataView;
    download(new Blob([data.buffer as ArrayBuffer], { type: "model/stl" }), `${baseName}.stl`);
  } else if (format === "3mf") {
    const bytes = await to3mf(scene);
    download(new Blob([bytes as BlobPart], { type: "model/3mf" }), `${baseName}.3mf`);
  } else if (format === "obj") {
    download(new Blob([new OBJExporter().parse(scene)], { type: "text/plain" }), `${baseName}.obj`);
  } else {
    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    download(new Blob([glb], { type: "model/gltf-binary" }), `${baseName}.glb`);
  }
}

/** Renders the view at `scale`× and composites the measurement labels. */
export function snapshot(v: Viewer, ann: Annotations, opts: { scale: number; transparent: boolean; background: string }) {
  const r = v.renderer;
  const oldRatio = r.getPixelRatio();
  r.setPixelRatio(opts.scale);
  r.setSize(v.size.x, v.size.y, false);
  v.render();
  const out = document.createElement("canvas");
  out.width = r.domElement.width;
  out.height = r.domElement.height;
  const g = out.getContext("2d")!;
  if (!opts.transparent) { g.fillStyle = opts.background; g.fillRect(0, 0, out.width, out.height); }
  g.drawImage(r.domElement, 0, 0);
  const k = out.width / v.size.x;
  g.font = `600 ${12 * k}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const boxes = ann.labelBoxes();
  // Leaders first, so the note boxes cover their inner ends.
  for (const b of boxes) {
    if (!b.from) continue;
    g.strokeStyle = b.color;
    g.lineWidth = 1.5 * k;
    g.beginPath(); g.moveTo(b.from[0] * k, b.from[1] * k); g.lineTo(b.x * k, b.y * k); g.stroke();
    g.fillStyle = b.color;
    g.beginPath(); g.arc(b.from[0] * k, b.from[1] * k, 3 * k, 0, 2 * Math.PI); g.fill();
  }
  for (const b of boxes) {
    const lines = b.text.length ? b.text : [""];
    const lh = 15 * k;
    const w = Math.max(...lines.map(l => g.measureText(l).width)) + 14 * k, h = b.from ? lines.length * lh + 8 * k : 20 * k;
    g.fillStyle = "rgba(255,255,255,0.94)";
    g.strokeStyle = b.color;
    g.lineWidth = 2 * k;
    g.beginPath();
    g.roundRect(b.x * k - w / 2, b.y * k - h / 2, w, h, 5 * k);
    g.fill(); g.stroke();
    g.fillStyle = "#111827";
    lines.forEach((l, i) => g.fillText(l, b.x * k, b.y * k + (i - (lines.length - 1) / 2) * (b.from ? lh : 0) + 0.5 * k));
  }
  r.setPixelRatio(oldRatio);
  r.setSize(v.size.x, v.size.y, false);
  v.invalidate();
  return out;
}

export function measurementsCsv(list: Measurement[], fileName: string) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [["#", "Type", "Value", "Unit", "Component", "Details", "Colour"].join(",")];
  list.forEach((m, i) => {
    const f = formatMeasurement(m);
    rows.push([i + 1, esc(f.title), esc(f.value), units.current, esc(String(m.data.parts ?? "")), esc(f.details.join("; ")), m.color].join(","));
  });
  download(new Blob([`# ${fileName}\n` + rows.join("\n")], { type: "text/csv" }), `${fileName.replace(/\.[^.]+$/, "")}-measurements.csv`);
}

/** Raw data: values in millimetres and radians, points in world millimetres, plus the text as displayed. */
export function measurementsJson(list: Measurement[], fileName: string) {
  const out = {
    file: fileName,
    exported: new Date().toISOString(),
    units: { length: "mm", angle: "rad", display: units.current },
    measurements: list.map((m, i) => {
      const f = formatMeasurement(m);
      const { rows, ...data } = m.data;
      return {
        n: i + 1, id: m.id, type: m.type, title: f.title, value: m.value, display: f.value,
        points: m.points, data,
        ...(rows ? { rows: (JSON.parse(String(rows)) as [string, string, unknown][]).map(([label, kind, value]) => ({ label, kind, value })) } : {}),
        details: f.details,
      };
    }),
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), `${fileName.replace(/\.[^.]+$/, "")}-measurements.json`);
  return out;
}

export interface ReportInfo {
  fileName: string;
  meta: [string, string][];
  mass: [string, string][];
  measurements: Measurement[];
  image: HTMLCanvasElement;
}

export function inspectionReport(info: ReportInfo) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setProperties({ title: `Inspection report: ${info.fileName}`, creator: "MöbiusCAD" });
  const W = 210, M = 14;
  let y = M;
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text("Inspection report", M, y + 4);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
  doc.text(`MöbiusCAD  ·  ${info.fileName}  ·  ${new Date().toLocaleString()}  ·  units: ${units.current}`, M, y + 10);
  doc.setTextColor(0);
  y += 16;
  const img = info.image;
  const iw = W - 2 * M, ih = Math.min(120, (iw * img.height) / img.width);
  doc.addImage(img.toDataURL("image/png"), "PNG", M, y, (ih * img.width) / img.height, ih);
  y += ih + 6;

  const table = (title: string, rows: string[][], widths: number[]) => {
    if (y > 270) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text(title, M, y); y += 5;
    doc.setFontSize(8.5);
    rows.forEach((r, ri) => {
      const lines = r.map((c, i) => doc.splitTextToSize(c, widths[i] - 2) as string[]);
      const h = Math.max(...lines.map(l => l.length)) * 3.8 + 1.5;
      if (y + h > 285) { doc.addPage(); y = M; }
      doc.setFont("helvetica", ri === 0 ? "bold" : "normal");
      if (ri === 0) { doc.setFillColor(238, 241, 246); doc.rect(M, y - 3.2, widths.reduce((a, b) => a + b, 0), h, "F"); }
      let x = M;
      lines.forEach((l, i) => { doc.text(l, x + 1, y); x += widths[i]; });
      y += h;
    });
    y += 4;
  };

  if (info.meta.length) table("Model", [["Property", "Value"], ...info.meta], [50, 132]);
  if (info.mass.length) table("Mass properties", [["Property", "Value"], ...info.mass], [50, 132]);
  if (info.measurements.length) {
    table("Measurements", [["#", "Type", "Value", "Component", "Details"], ...info.measurements.map((m, i) => {
      const f = formatMeasurement(m);
      return [String(i + 1), f.title, f.value, String(m.data.parts ?? ""), f.details.join("; ")];
    })], [8, 32, 36, 40, 66]);
  }
  doc.save(`${info.fileName.replace(/\.[^.]+$/, "")}-inspection.pdf`);
}
