// Reads STL, OBJ and 3MF files with the three.js loaders into triangle soups
// (world positions, one per object) for the import worker, which groups the
// triangles into faces. Mesh files carry no units: millimetres are assumed.
import * as THREE from "three";
import type { MeshRequest } from "./worker/import.worker";

export const isMeshName = (n: string) => /\.(stl|obj|3mf)$/i.test(n);

export async function parseMesh(buffer: ArrayBuffer, name: string): Promise<MeshRequest["meshes"]> {
  const ext = name.split(".").pop()!.toLowerCase();
  const base = name.replace(/\.[^.]+$/, "");
  let root: THREE.Object3D;
  if (ext === "stl") {
    const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
    root = new THREE.Mesh(new STLLoader().parse(buffer));
    root.name = base;
  } else if (ext === "obj") {
    const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  } else {
    const { ThreeMFLoader } = await import("three/addons/loaders/3MFLoader.js");
    root = new ThreeMFLoader().parse(buffer);
  }
  root.updateMatrixWorld(true);
  const out: MeshRequest["meshes"] = [];
  const v = new THREE.Vector3();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry;
    const at = g.getAttribute("position");
    if (!at || at.count < 3) return;
    const pos = new Float32Array(at.count * 3);
    for (let i = 0; i < at.count; i++) { v.fromBufferAttribute(at, i).applyMatrix4(m.matrixWorld); pos[3 * i] = v.x; pos[3 * i + 1] = v.y; pos[3 * i + 2] = v.z; }
    const ix = g.getIndex();
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial | undefined;
    const c = mat?.color && ext !== "stl" ? [mat.color.r, mat.color.g, mat.color.b] : undefined;
    let label = m.name || m.parent?.name || "";
    if (!label || label === root.name) label = base;
    out.push({ name: label, pos, idx: ix ? Uint32Array.from(ix.array as ArrayLike<number>) : null, color: c });
  });
  // Same names get a number, so the tree tells them apart.
  const seen = new Map<string, number>();
  for (const m of out) { const k = (seen.get(m.name) ?? 0) + 1; seen.set(m.name, k); if (k > 1) m.name = `${m.name} ${k}`; }
  if (!out.length) throw new Error("No triangles in this file");
  return out;
}
