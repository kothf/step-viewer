// Mesh files (STL, OBJ, 3MF) have only triangles. To measure them like a B-rep
// model, the triangles are grouped into faces first: flat regions become planar
// faces, and runs of small facets that bend gently (a tessellated cylinder,
// sphere or fillet) become one curved face. The result has the same shape as an
// occt-import-js mesh (faces as triangle ranges with their own vertices), so
// analyzeMesh rebuilds edges and fits circles, cylinders and spheres from it.

/** Same layout as an occt-import-js mesh, which analyzeMesh reads. */
export interface FacetedMesh {
  name: string;
  color?: number[];
  brep_faces: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: number[] }; normal: { array: number[] } };
  index: { array: number[] };
}

/** Facets closer than this (degrees) belong to the same flat region. */
const FLAT_DEG = 0.5;
/** Facets bending less than this (degrees) across an edge may be one curved face. */
const SMOOTH_DEG = 40;
/** A flat region is a plane of its own when it is this many times larger than its smooth neighbours. */
const PLANE_DOMINANCE = 4;

/**
 * Groups a triangle soup (`pos`: xyz per corner, 9 numbers per triangle, or
 * indexed with `idx`) into faces.
 */
export function facetFaces(name: string, pos: ArrayLike<number>, idx: ArrayLike<number> | null, color?: number[]): FacetedMesh {
  // ---- weld corners into shared vertices ----
  const nCorner = idx ? idx.length : pos.length / 3;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  if (!(lo[0] <= hi[0])) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const q = 1 / (diag * 1e-7);
  const weldMap = new Map<string, number>();
  const V: number[] = [];
  const corner = new Uint32Array(nCorner);
  for (let c = 0; c < nCorner; c++) {
    const i = (idx ? idx[c] : c) * 3;
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let w = weldMap.get(key);
    if (w === undefined) { w = V.length / 3; weldMap.set(key, w); V.push(x, y, z); }
    corner[c] = w;
  }

  // ---- triangles: drop degenerate ones, keep normals and areas ----
  const tris: number[] = [];
  const N: number[] = [], A: number[] = [];
  for (let c = 0; c + 2 < nCorner; c += 3) {
    const a = corner[c], b = corner[c + 1], d = corner[c + 2];
    if (a === b || b === d || a === d) continue;
    const ux = V[3 * b] - V[3 * a], uy = V[3 * b + 1] - V[3 * a + 1], uz = V[3 * b + 2] - V[3 * a + 2];
    const vx = V[3 * d] - V[3 * a], vy = V[3 * d + 1] - V[3 * a + 1], vz = V[3 * d + 2] - V[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-18) continue;
    tris.push(a, b, d);
    N.push(nx / l, ny / l, nz / l);
    A.push(l / 2);
  }
  const nt = tris.length / 3;

  // ---- edge adjacency (manifold edges only join triangles) ----
  const W = V.length / 3;
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = tris[3 * t + k], b = tris[3 * t + (k + 1) % 3];
    const key = a < b ? a * W + b : b * W + a;
    const l = edgeTris.get(key);
    if (l) l.push(t); else edgeTris.set(key, [t]);
  }
  const cosOf = (t: number, u: number) => N[3 * t] * N[3 * u] + N[3 * t + 1] * N[3 * u + 1] + N[3 * t + 2] * N[3 * u + 2];
  const nbrs: [number, number][] = []; // pairs of triangles sharing a manifold edge
  for (const l of edgeTris.values()) if (l.length === 2) nbrs.push([l[0], l[1]]);
  const adj: number[][] = Array.from({ length: nt }, () => []);
  for (const [t, u] of nbrs) { adj[t].push(u); adj[u].push(t); }

  // ---- flat regions ----
  const cosFlat = Math.cos((FLAT_DEG * Math.PI) / 180), cosSmooth = Math.cos((SMOOTH_DEG * Math.PI) / 180);
  const region = new Int32Array(nt).fill(-1);
  const regionArea: number[] = [];
  for (let s = 0; s < nt; s++) {
    if (region[s] >= 0) continue;
    const r = regionArea.length;
    let area = 0;
    const stack = [s];
    region[s] = r;
    while (stack.length) {
      const t = stack.pop()!;
      area += A[t];
      for (const u of adj[t]) if (region[u] < 0 && cosOf(s, u) > cosFlat && cosOf(t, u) > cosFlat) { region[u] = r; stack.push(u); }
    }
    regionArea.push(area);
  }

  // ---- curved faces: flat regions joined across gentle bends, unless a region dominates its neighbours (a plane) ----
  const R = regionArea.length;
  const smoothNb: Set<number>[] = Array.from({ length: R }, () => new Set());
  for (const [t, u] of nbrs) {
    const a = region[t], b = region[u];
    if (a !== b && cosOf(t, u) > cosSmooth) { smoothNb[a].add(b); smoothNb[b].add(a); }
  }
  const isPlane = regionArea.map((area, r) => {
    let big = 0;
    for (const b of smoothNb[r]) big = Math.max(big, regionArea[b]);
    return big === 0 || area >= PLANE_DOMINANCE * big;
  });
  const parent = Array.from({ length: R }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let r = 0; r < R; r++) {
    if (isPlane[r]) continue;
    for (const b of smoothNb[r]) if (!isPlane[b]) { const x = find(r), y = find(b); if (x !== y) parent[x] = y; }
  }

  // ---- write faces: each with its own vertices; curved faces get smooth normals ----
  const faceOf = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const f = find(region[t]);
    const l = faceOf.get(f);
    if (l) l.push(t); else faceOf.set(f, [t]);
  }
  const P: number[] = [], Nn: number[] = [], I: number[] = [];
  const faces: FacetedMesh["brep_faces"] = [];
  for (const [f, list] of faceOf) {
    const first = I.length / 3;
    const flat = isPlane[f] && parent[f] === f && list.every(t => region[t] === f);
    const local = new Map<number, number>();
    const acc = new Map<number, [number, number, number]>();
    if (!flat) for (const t of list) for (let k = 0; k < 3; k++) {
      const w = tris[3 * t + k];
      const s = acc.get(w) ?? [0, 0, 0];
      s[0] += N[3 * t] * A[t]; s[1] += N[3 * t + 1] * A[t]; s[2] += N[3 * t + 2] * A[t];
      acc.set(w, s);
    }
    for (const t of list) for (let k = 0; k < 3; k++) {
      const w = tris[3 * t + k];
      let li = local.get(w);
      if (li === undefined) {
        li = P.length / 3;
        local.set(w, li);
        P.push(V[3 * w], V[3 * w + 1], V[3 * w + 2]);
        if (flat) Nn.push(N[3 * t], N[3 * t + 1], N[3 * t + 2]);
        else { const s = acc.get(w)!, l = Math.hypot(s[0], s[1], s[2]) || 1; Nn.push(s[0] / l, s[1] / l, s[2] / l); }
      }
      I.push(li);
    }
    faces.push({ first, last: I.length / 3 - 1, color: null });
  }
  return { name, color, brep_faces: faces, attributes: { position: { array: P }, normal: { array: Nn } }, index: { array: I } };
}
