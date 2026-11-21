// What a study is drawn on: one part's display mesh, or every shown component of an assembly as one mesh.
// The solver's own geometry comes from the kernel; this is only the view's side (picking, marks, the plot).
import * as THREE from "three";
import type { EdgeInfo, FaceInfo } from "../topology";
import type { Part, Viewer } from "../viewer/Viewer";

export interface SimModel {
  /** The display mesh in the model's coordinates (indexed or not, with normals). */
  geometry: THREE.BufferGeometry;
  /** Its faces (`triStart`/`triCount` into `geometry`) and edges (`faces` index into `faces`). */
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** An object whose own coordinates are the model's: marks and the plot are added to it. */
  frame: THREE.Object3D;
  /** The view's meshes the plot stands in for. */
  meshes: THREE.Mesh[];
}

/** A part as the study's model. */
export function partModel(p: Part): SimModel {
  return { geometry: p.mesh.geometry, faces: p.data.faces, edges: p.data.edges, frame: p.group, meshes: [p.mesh] };
}

/** An assembly's model also knows where each component's faces and edges start in the joined lists. */
export interface AsmModel extends SimModel {
  /** Viewer part index of each joined component, and the first face and edge of each. */
  parts: number[];
  faceOff: number[];
  edgeOff: number[];
  /** `<component>@<face>` per joined face. */
  names: string[];
}

/**
 * The shown components (`which` = viewer part indices with the component id and face names of each) joined into
 * one model. Assembly parts are shown in world coordinates, so the joined mesh is too; the frame sits in the
 * view's model root at the origin.
 */
export function asmModel(viewer: Viewer, which: { idx: number; id: string; faces: string[] }[]): AsmModel | null {
  const use = which.filter(w => viewer.parts[w.idx]);
  if (!use.length) return null;
  let nv = 0, ni = 0;
  for (const w of use) {
    const g = viewer.parts[w.idx].mesh.geometry, n = g.getAttribute("position").count;
    nv += n;
    ni += g.getIndex()?.count ?? n;
  }
  const pos = new Float32Array(3 * nv), nrm = new Float32Array(3 * nv), index = new Uint32Array(ni);
  const faces: FaceInfo[] = [], edges: EdgeInfo[] = [], names: string[] = [], parts: number[] = [], faceOff: number[] = [], edgeOff: number[] = [], meshes: THREE.Mesh[] = [];
  let v0 = 0, i0 = 0;
  for (const w of use) {
    const p = viewer.parts[w.idx], g = p.mesh.geometry, pa = g.getAttribute("position"), na = g.getAttribute("normal"), ix = g.getIndex(), n = pa.count;
    for (let i = 0; i < n; i++) {
      pos[3 * (v0 + i)] = pa.getX(i); pos[3 * (v0 + i) + 1] = pa.getY(i); pos[3 * (v0 + i) + 2] = pa.getZ(i);
      if (na) { nrm[3 * (v0 + i)] = na.getX(i); nrm[3 * (v0 + i) + 1] = na.getY(i); nrm[3 * (v0 + i) + 2] = na.getZ(i); }
    }
    const cnt = ix?.count ?? n;
    for (let i = 0; i < cnt; i++) index[i0 + i] = v0 + (ix ? ix.getX(i) : i);
    const f0 = faces.length, e0 = edges.length, t0 = i0 / 3;
    parts.push(w.idx); faceOff.push(f0); edgeOff.push(e0); meshes.push(p.mesh);
    p.data.faces.forEach((f, k) => { faces.push({ ...f, id: f0 + k, triStart: f.triStart + t0, edges: f.edges.map(e => e + e0) }); names.push(`${w.id}@${w.faces[k] ?? ""}`); });
    for (const e of p.data.edges) edges.push({ ...e, id: e0 + e.id, faces: [e.faces[0] < 0 ? -1 : e.faces[0] + f0, e.faces[1] < 0 ? -1 : e.faces[1] + f0] });
    v0 += n; i0 += cnt;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  const frame = new THREE.Group();
  frame.name = "sim-frame";
  viewer.modelRoot.add(frame);
  return { geometry, faces, edges, frame, meshes, parts, faceOff, edgeOff, names };
}
