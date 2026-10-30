// Rebuilds B-rep topology (faces, edges, analytic surface/curve types) from the
// tessellation OpenCASCADE produces. Runs in the import worker.
//
// occt-import-js gives each B-rep face as a contiguous triangle range with its
// own (unshared) vertices. Shared edges are discretized identically on both
// faces, so welding vertices by position recovers face adjacency exactly.

export type V3 = [number, number, number];
export type FaceType = "plane" | "cylinder" | "sphere" | "other";
export type EdgeType = "line" | "circle" | "arc" | "curve";

export interface FaceInfo {
  id: number;
  triStart: number;
  triCount: number;
  type: FaceType;
  area: number;
  centroid: V3;
  /** Snap point: area centroid (plane/other), axis midpoint (cylinder), center (sphere). */
  center: V3;
  normal?: V3;
  axis?: V3;
  radius?: number;
  color: V3 | null;
  edges: number[];
}

export interface EdgeInfo {
  id: number;
  pts: number[];
  faces: [number, number];
  closed: boolean;
  length: number;
  type: EdgeType;
  start: V3;
  end: V3;
  mid: V3;
  dir?: V3;
  center?: V3;
  axis?: V3;
  radius?: number;
  sweep?: number;
}

export interface PartData {
  name: string;
  color: V3;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array | null;
  index: Uint32Array;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  edgeSegs: Float32Array;
  closed: boolean;
  volume: number;
  area: number;
  com: V3;
  bboxMin: V3;
  bboxMax: V3;
}

export interface TreeNode {
  name: string;
  parts: number[];
  children: TreeNode[];
}

interface OcctMesh {
  name: string;
  color?: number[];
  brep_faces: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
}

// ---------- small linear algebra ----------

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const addS = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Jacobi eigen-decomposition of a symmetric 3x3 (row-major). Ascending eigenvalues; vectors[i] pairs with values[i]. */
export function eigSym3(m: number[]): { values: number[]; vectors: V3[] } {
  const a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map(i => a[i][i]), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]] as V3) };
}

function solve3(A: number[], b: V3): V3 | null {
  const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  if (Math.abs(det) < 1e-18) return null;
  const r = (c0: V3, c1: V3, c2: V3) =>
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  const col = (i: number): V3 => [A[i], A[3 + i], A[6 + i]];
  return [r(b, col(1), col(2)) / det, r(col(0), b, col(2)) / det, r(col(0), col(1), b) / det];
}

function basisFor(n: V3): [V3, V3] {
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, helper));
  return [u, cross(n, u)];
}

/** Least-squares (Kasa) circle in the plane through `origin` with normal `n`. */
function fitCircleInPlane(pts: V3[], origin: V3, n: V3) {
  const [u, v] = basisFor(n);
  const xy = pts.map(p => { const d = sub(p, origin); return [dot(d, u), dot(d, v)]; });
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
  for (const [x, y] of xy) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; sxz += x * z; syz += y * z;
  }
  const N = xy.length;
  const sol = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, N], [-sxz, -syz, -sz]);
  if (!sol) return null;
  let cx = -sol[0] / 2, cy = -sol[1] / 2;
  const r2 = cx * cx + cy * cy - sol[2];
  if (!(r2 > 0)) return null;
  let radius = Math.sqrt(r2);
  // Späth iterations: refine the algebraic fit to the geometric (orthogonal) one.
  const mx = sx / N, my = sy / N;
  for (let it = 0; it < 30; it++) {
    let sd = 0, gx = 0, gy = 0;
    for (const [x, y] of xy) {
      const d = Math.hypot(cx - x, cy - y) || 1e-300;
      sd += d; gx += (cx - x) / d; gy += (cy - y) / d;
    }
    radius = sd / N;
    const nx = mx + radius * gx / N, ny = my + radius * gy / N;
    const step = Math.hypot(nx - cx, ny - cy);
    cx = nx; cy = ny;
    if (step < radius * 1e-12) break;
  }
  let maxErr = 0;
  for (const [x, y] of xy) maxErr = Math.max(maxErr, Math.abs(Math.hypot(x - cx, y - cy) - radius));
  const center = addS(addS(origin, u, cx), v, cy);
  return { center, radius, maxErr, u, v, cx, cy, xy };
}

function centroidOf(pts: V3[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

function covariance(pts: V3[], c: V3): number[] {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += d[i] * d[j];
  }
  return m;
}

// ---------- edge classification ----------

function classifyEdge(pts: V3[], closed: boolean, tol: number): Partial<EdgeInfo> {
  const n = pts.length;
  const a = pts[0], b = pts[n - 1];
  const chord = sub(b, a);
  const chordLen = len(chord);
  if (!closed && chordLen > tol) {
    const d = norm(chord);
    let dev = 0;
    for (const p of pts) { const w = sub(p, a); dev = Math.max(dev, len(sub(w, [d[0] * dot(w, d), d[1] * dot(w, d), d[2] * dot(w, d)]))); }
    if (dev < tol) return { type: "line", dir: d };
  }
  const unique = closed ? pts.slice(0, -1) : pts;
  if (unique.length >= 4 || (closed && unique.length >= 3)) {
    const c = centroidOf(unique);
    const { values, vectors } = eigSym3(covariance(unique, c));
    const nrm = vectors[0];
    const planarDev = Math.max(...unique.map(p => Math.abs(dot(sub(p, c), nrm))));
    if (planarDev < tol && values[1] > 0) {
      const fit = fitCircleInPlane(unique, c, nrm);
      if (fit && fit.maxErr < Math.max(tol, fit.radius * 1e-3) && fit.radius < 1e3 * (chordLen + len(sub(unique[1], unique[0])) * unique.length)) {
        let sweep = 0;
        const ang = fit.xy.map(([x, y]) => Math.atan2(y - fit.cy, x - fit.cx));
        const seq = closed ? [...ang, ang[0]] : ang;
        for (let i = 1; i < seq.length; i++) {
          let d = seq[i] - seq[i - 1];
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          sweep += d;
        }
        sweep = Math.abs(sweep);
        const full = closed || sweep > 2 * Math.PI - 1e-3;
        return { type: full ? "circle" : "arc", center: fit.center, axis: nrm, radius: fit.radius, sweep: full ? 2 * Math.PI : sweep };
      }
    }
  }
  return { type: "curve" };
}

// ---------- face classification ----------

function classifyFace(pts: V3[], nrms: V3[], tol: number): Partial<FaceInfo> {
  let m: V3 = [0, 0, 0];
  for (const n of nrms) m = addS(m, n, 1);
  m = norm(m);
  if (nrms.every(n => dot(n, m) > 1 - 1e-6)) return { type: "plane", normal: m };

  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const n of nrms) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] += n[i] * n[j];
  const { values, vectors } = eigSym3(M);
  const total = values[0] + values[1] + values[2];
  if (values[0] / total < 1e-6 && values[1] / total > 1e-4) {
    const axis = vectors[0];
    const c = centroidOf(pts);
    const fit = fitCircleInPlane(pts, c, axis);
    if (fit && fit.maxErr < Math.max(tol, fit.radius * 1e-3)) {
      let lo = Infinity, hi = -Infinity;
      for (const p of pts) { const t = dot(sub(p, fit.center), axis); lo = Math.min(lo, t); hi = Math.max(hi, t); }
      return { type: "cylinder", axis, radius: fit.radius, center: addS(fit.center, axis, (lo + hi) / 2) };
    }
  }

  // Sphere: the point closest to every normal line.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let b: V3 = [0, 0, 0];
  for (let k = 0; k < pts.length; k++) {
    const n = nrms[k], p = pts[k];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i * 3 + j] += (i === j ? 1 : 0) - n[i] * n[j];
    const pn = dot(p, n);
    b = [b[0] + p[0] - n[0] * pn, b[1] + p[1] - n[1] * pn, b[2] + p[2] - n[2] * pn];
  }
  const sc = solve3(A, b);
  if (sc) {
    const rs = pts.map(p => len(sub(p, sc)));
    const r = rs.reduce((s, x) => s + x, 0) / rs.length;
    if (rs.every(x => Math.abs(x - r) < Math.max(tol, r * 1e-3))) return { type: "sphere", center: sc, radius: r };
  }
  return { type: "other" };
}

// ---------- main analysis ----------

export function analyzeMesh(m: OcctMesh): PartData {
  const P = m.attributes.position.array;
  const N = m.attributes.normal?.array;
  const I = m.index.array;
  const nv = P.length / 3, nt = I.length / 3;
  const positions = Float32Array.from(P);
  const index = Uint32Array.from(I);
  const vec = (i: number): V3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];

  const bboxMin: V3 = [Infinity, Infinity, Infinity], bboxMax: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
    bboxMin[k] = Math.min(bboxMin[k], P[3 * i + k]); bboxMax[k] = Math.max(bboxMax[k], P[3 * i + k]);
  }
  const diag = len(sub(bboxMax, bboxMin)) || 1;
  const tol = diag * 2e-5;

  // Normals: OCCT gives them for every face; fall back to flat normals.
  let normals: Float32Array;
  if (N && N.length === P.length) normals = Float32Array.from(N);
  else {
    normals = new Float32Array(P.length);
    for (let t = 0; t < nt; t++) {
      const a = vec(I[3 * t]), b = vec(I[3 * t + 1]), c = vec(I[3 * t + 2]);
      const n = cross(sub(b, a), sub(c, a));
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) normals[3 * I[3 * t + k] + j] += n[j];
    }
    for (let i = 0; i < nv; i++) {
      const n = norm([normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]]);
      normals.set(n, 3 * i);
    }
  }

  // Weld vertices by position.
  const q = 1 / Math.max(tol * 0.01, 1e-9);
  const weldMap = new Map<string, number>();
  const weld = new Uint32Array(nv);
  const weldPos: V3[] = [];
  for (let i = 0; i < nv; i++) {
    const key = `${Math.round(P[3 * i] * q)},${Math.round(P[3 * i + 1] * q)},${Math.round(P[3 * i + 2] * q)}`;
    let w = weldMap.get(key);
    if (w === undefined) { w = weldPos.length; weldMap.set(key, w); weldPos.push(vec(i)); }
    weld[i] = w;
  }
  const W = weldPos.length;
  const ekey = (a: number, b: number) => (a < b ? a * W + b : b * W + a);

  const brepFaces = m.brep_faces.length ? m.brep_faces : [{ first: 0, last: nt - 1, color: null }];
  const triFace = new Uint32Array(nt);
  const faces: FaceInfo[] = [];
  let hasFaceColor = false;
  let volume = 0, area = 0;
  const com: V3 = [0, 0, 0];

  // Boundary segment -> faces using it.
  const segFaces = new Map<number, number[]>();

  brepFaces.forEach((bf, fid) => {
    const triStart = bf.first, triCount = bf.last - bf.first + 1;
    const count = new Map<number, number>();
    const vset = new Set<number>();
    let fArea = 0;
    const fc: V3 = [0, 0, 0];
    for (let t = triStart; t < triStart + triCount; t++) {
      triFace[t] = fid;
      const ia = I[3 * t], ib = I[3 * t + 1], ic = I[3 * t + 2];
      vset.add(ia); vset.add(ib); vset.add(ic);
      const a = vec(ia), b = vec(ib), c = vec(ic);
      const ta = len(cross(sub(b, a), sub(c, a))) / 2;
      fArea += ta;
      for (let k = 0; k < 3; k++) fc[k] += ta * (a[k] + b[k] + c[k]) / 3;
      const tv = dot(a, cross(b, c)) / 6;
      volume += tv;
      for (let k = 0; k < 3; k++) com[k] += tv * (a[k] + b[k] + c[k]) / 4;
      for (const [x, y] of [[ia, ib], [ib, ic], [ic, ia]]) {
        const wa = weld[x], wb = weld[y];
        if (wa === wb) continue;
        const k = ekey(wa, wb);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    for (const [k, c] of count) {
      if (c !== 1) continue;
      const list = segFaces.get(k);
      if (list) { if (!list.includes(fid)) list.push(fid); } else segFaces.set(k, [fid]);
    }
    area += fArea;
    const centroid: V3 = fArea > 0 ? [fc[0] / fArea, fc[1] / fArea, fc[2] / fArea] : [0, 0, 0];
    const verts = [...vset];
    const pts = verts.map(vec);
    const nrms = verts.map(i => [normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]] as V3);
    const cls = classifyFace(pts, nrms, tol);
    if (bf.color) hasFaceColor = true;
    faces.push({
      id: fid, triStart, triCount, area: fArea, centroid,
      center: cls.center ?? centroid,
      type: cls.type ?? "other", normal: cls.normal, axis: cls.axis, radius: cls.radius,
      color: (bf.color as V3) ?? null, edges: [],
    });
  });

  // Group boundary segments by the pair of faces they separate, then chain them.
  const groups = new Map<string, [number, number][]>();
  let freeSegs = 0;
  for (const [k, fs] of segFaces) {
    const a = Math.floor(k / W), b = k % W;
    const pair: [number, number] = fs.length >= 2 ? [Math.min(fs[0], fs[1]), Math.max(fs[0], fs[1])] : [fs[0], -1];
    if (fs.length < 2) freeSegs++;
    const gk = pair.join("|");
    const g = groups.get(gk);
    if (g) g.push([a, b]); else groups.set(gk, [[a, b]]);
  }

  const edges: EdgeInfo[] = [];
  const segOut: number[] = [];
  for (const [gk, segs] of groups) {
    const [fa, fb] = gk.split("|").map(Number) as [number, number];
    for (const chain of chainSegments(segs, weldPos)) {
      const pts = chain.map(w => weldPos[w]);
      const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += len(sub(pts[i], pts[i - 1]));
      if (length <= 0) continue;
      // Midpoint by arc length.
      let acc = 0, mid: V3 = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const sl = len(sub(pts[i], pts[i - 1]));
        if (acc + sl >= length / 2) { const t = (length / 2 - acc) / (sl || 1); mid = addS(pts[i - 1], sub(pts[i], pts[i - 1]), t); break; }
        acc += sl;
      }
      const cls = classifyEdge(pts, closed, tol);
      const id = edges.length;
      edges.push({
        id, pts: pts.flat(), faces: [fa, fb], closed, length,
        type: cls.type ?? "curve", start: pts[0], end: pts[pts.length - 1], mid,
        dir: cls.dir, center: cls.center, axis: cls.axis, radius: cls.radius, sweep: cls.sweep,
      });
      faces[fa]?.edges.push(id);
      if (fb >= 0) faces[fb]?.edges.push(id);
      for (let i = 1; i < pts.length; i++) segOut.push(...pts[i - 1], ...pts[i]);
    }
  }

  let colors: Float32Array | null = null;
  const base: V3 = (m.color as V3) ?? [0.72, 0.74, 0.78];
  if (hasFaceColor) {
    colors = new Float32Array(nv * 3);
    for (let t = 0; t < nt; t++) {
      const c = faces[triFace[t]].color ?? base;
      for (let k = 0; k < 3; k++) colors.set(c, 3 * I[3 * t + k]);
    }
  }

  const closed = freeSegs === 0;
  const absV = Math.abs(volume);
  return {
    name: m.name || "Part",
    color: base,
    positions, normals, colors, index, faces, edges,
    edgeSegs: Float32Array.from(segOut),
    closed,
    volume: absV,
    area,
    com: volume !== 0 ? [com[0] / volume, com[1] / volume, com[2] / volume] : [0, 0, 0],
    bboxMin, bboxMax,
  };
}

/** Chains undirected segments into polylines, breaking at junctions and sharp corners. */
function chainSegments(segs: [number, number][], pos: V3[]): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of segs) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const used = new Set<string>();
  const sk = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const walk = (start: number, next: number) => {
    const chain = [start, next];
    used.add(sk(start, next));
    let prev = start, cur = next;
    while ((adj.get(cur)?.length ?? 0) === 2) {
      const nb = adj.get(cur)!.find(x => x !== prev && !used.has(sk(cur, x))) ?? adj.get(cur)!.find(x => !used.has(sk(cur, x)));
      if (nb === undefined) break;
      used.add(sk(cur, nb));
      chain.push(nb);
      prev = cur; cur = nb;
      if (cur === start) break;
    }
    return chain;
  };
  const chains: number[][] = [];
  for (const [v, nbs] of adj) {
    if (nbs.length === 2) continue;
    for (const nb of nbs) if (!used.has(sk(v, nb))) chains.push(walk(v, nb));
  }
  for (const [v, nbs] of adj) for (const nb of nbs) if (!used.has(sk(v, nb))) chains.push(walk(v, nb));

  // Split at sharp turns (> 50°) so corners become separate edges.
  const out: number[][] = [];
  const cosLim = Math.cos((50 * Math.PI) / 180);
  for (let chain of chains) {
    const closed = chain.length > 3 && chain[0] === chain[chain.length - 1];
    const sharp = (i: number, c: number[]) => {
      const a = pos[c[i - 1]], b = pos[c[i]], d = pos[c[i + 1]];
      return dot(norm(sub(b, a)), norm(sub(d, b))) < cosLim;
    };
    if (closed) {
      const ring = chain.slice(0, -1);
      const ext = [ring[ring.length - 1], ...ring, ring[0]];
      const corner = ring.findIndex((_, i) => sharp(i + 1, ext));
      if (corner < 0) { out.push(chain); continue; }
      chain = [...ring.slice(corner), ...ring.slice(0, corner), ring[corner]];
    }
    let cur = [chain[0]];
    for (let i = 1; i < chain.length; i++) {
      cur.push(chain[i]);
      if (i < chain.length - 1 && sharp(i, chain)) { out.push(cur); cur = [chain[i]]; }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

export function convertTree(node: { name: string; meshes: number[]; children: unknown[] }): TreeNode {
  return {
    name: node.name || "Assembly",
    parts: node.meshes ?? [],
    children: (node.children as typeof node[]).map(convertTree),
  };
}
