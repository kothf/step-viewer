// Geometry compare of two versions (FR-PDM-050): both are built in a kernel of their own and cut against each
// other. The table gives volume, mass, area, size and centre of mass; the view shows material only in the older
// version in red and only in the newer one in green, over what both share.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { GeomDiff, ShapeFacts, Tris } from "../kernel/drawing";
import type { DiffSrc } from "../drawing/drawing.worker";

export const GEO_OLD = "#d32f2f", GEO_NEW = "#1b8a3a";

/** A part's or an assembly's document as the kernel builds it, with its material density (g/cm³) if any. */
async function srcOf(path: string, bytes: Uint8Array): Promise<{ src: DiffSrc; density: number | null }> {
  if (/\.mcadprt$/i.test(path)) {
    const { unpackPart } = await import("../model/file");
    const doc = await unpackPart(bytes.slice().buffer);
    return { src: { part: doc }, density: doc.material?.density ?? null };
  }
  const [{ unpackAsm }, { flattenSubs }] = await Promise.all([import("../asm/file"), import("../asm/patterns")]);
  return { src: { asm: flattenSubs(await unpackAsm(bytes.slice().buffer)) }, density: null };
}

/** Whether a file is a document this compare can build. */
export const geomComparable = (path: string) => /\.mcad(prt|asm)$/i.test(path);

export async function geometryCompare(path: string, a: Uint8Array, b: Uint8Array, base = new URL("occt/", document.baseURI).href): Promise<{ diff: GeomDiff; density: [number | null, number | null] }> {
  const [sa, sb] = await Promise.all([srcOf(path, a), srcOf(path, b)]);
  const { DrawingKernel } = await import("../drawing/client");
  const k = new DrawingKernel(base);
  try { return { diff: await k.diff(sa.src, sb.src), density: [sa.density, sb.density] }; } finally { k.stop(); }
}

const num = (v: number, d = 2) => (Math.abs(v) >= 1e4 ? v.toFixed(0) : v.toFixed(d));
const sgn = (v: number, d = 2) => { const z = Math.abs(v) < 0.5 * 10 ** -d; return `${z ? "±" : v > 0 ? "+" : "−"}${num(z ? 0 : Math.abs(v), d)}`; };
const size = (f: ShapeFacts) => [0, 1, 2].map(k => f.box[1][k] - f.box[0][k]);

/** The table rows: [quantity, older, newer, change]; English labels, translated by the caller. */
export function geomRows(d: GeomDiff, density: [number | null, number | null]): [string, string, string, string][] {
  const rows: [string, string, string, string][] = [];
  const pct = (x: number, y: number) => (x > 0 ? ` (${sgn((y - x) / x * 100, 1)} %)` : "");
  rows.push(["Volume (mm³)", num(d.a.volume), num(d.b.volume), `${sgn(d.b.volume - d.a.volume)}${pct(d.a.volume, d.b.volume)}`]);
  if (density[0] != null || density[1] != null) {
    const ma = density[0] != null ? d.a.volume * density[0] * 1e-6 : null, mb = density[1] != null ? d.b.volume * density[1] * 1e-6 : null;
    rows.push(["Mass (kg)", ma != null ? ma.toFixed(4) : "", mb != null ? mb.toFixed(4) : "", ma != null && mb != null ? sgn(mb - ma, 4) : ""]);
  }
  rows.push(["Surface area (mm²)", num(d.a.area), num(d.b.area), `${sgn(d.b.area - d.a.area)}${pct(d.a.area, d.b.area)}`]);
  const sa = size(d.a), sb = size(d.b);
  rows.push(["Size X × Y × Z (mm)", sa.map(v => num(v)).join(" × "), sb.map(v => num(v)).join(" × "), sb.map((v, i) => sgn(v - sa[i])).join(" × ")]);
  rows.push(["Centre of mass (mm)", d.a.com.map(v => num(v)).join(", "), d.b.com.map(v => num(v)).join(", "), d.b.com.map((v, i) => sgn(v - d.a.com[i])).join(", ")]);
  rows.push(["Material removed (mm³)", "", "", num(d.removed.volume)]);
  rows.push(["Material added (mm³)", "", "", num(d.added.volume)]);
  return rows;
}

function meshOf(t: Tris, mat: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(t.position, 3));
  g.setIndex(t.index);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/** Puts a small 3D view of the difference into `host`; returns a function that frees it. */
export function mountDiffView(host: HTMLElement, d: GeomDiff): () => void {
  const W = Math.min(560, host.clientWidth || 560), H = 320;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { return () => {}; }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(W, H);
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.2), new THREE.AmbientLight(0xffffff, 0.4));
  const both = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  const old = new THREE.MeshStandardMaterial({ color: GEO_OLD, side: THREE.DoubleSide });
  const neu = new THREE.MeshStandardMaterial({ color: GEO_NEW, side: THREE.DoubleSide });
  const meshes = [meshOf(d.removed.mesh, old), meshOf(d.added.mesh, neu), meshOf(d.common, both)];
  meshes[2].renderOrder = 1;
  scene.add(...meshes);
  const box = new THREE.Box3();
  for (const m of meshes) if (m.geometry.getAttribute("position").count) box.expandByObject(m);
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()), r = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const cam = new THREE.PerspectiveCamera(35, W / H, r / 100, r * 100);
  cam.up.set(0, 0, 1);
  cam.position.copy(c).add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(r * 3.4));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  cam.add(light);
  scene.add(cam);
  const controls = new OrbitControls(cam, renderer.domElement);
  controls.target.copy(c);
  const draw = () => renderer.render(scene, cam);
  controls.addEventListener("change", draw);
  controls.update();
  draw();
  return () => {
    controls.dispose();
    for (const m of meshes) m.geometry.dispose();
    for (const m of [both, old, neu]) m.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
