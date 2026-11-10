// Mass properties maths (FR-MAT-002): second moments of tessellated solids, combining
// bodies, principal axes and the moments SolidWorks reports. Pure, so unit-tested.
//
// A body's inertia is kept as its covariance about its own centre of mass,
// C = ∫ (p − c)(p − c)ᵀ dV for unit density, stored as the six numbers
// [xx, yy, zz, xy, yz, zx] (mm⁵). Times a density it becomes g·mm² once the
// density is in g/mm³. The inertia tensor is tr(C)·E − C.

export type V3 = [number, number, number];
/** Symmetric 3×3 as [xx, yy, zz, xy, yz, zx]. */
export type Sym = [number, number, number, number, number, number];
/** Row-major 3×3 rotation. */
export type M3 = [V3, V3, V3];

export const ZERO_SYM: Sym = [0, 0, 0, 0, 0, 0];

/**
 * Volume, centre and covariance about the centre of a closed triangle mesh
 * (divergence theorem, one tetrahedron per triangle from a reference point
 * near the mesh, so far-off parts keep their precision). Open meshes give
 * numbers too, but not reliable ones.
 */
export function meshMoments(P: ArrayLike<number>, I: ArrayLike<number>): { volume: number; com: V3; cov: Sym } {
  const rx = P[0] ?? 0, ry = P[1] ?? 0, rz = P[2] ?? 0;
  let v = 0, sx = 0, sy = 0, sz = 0, xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ax = P[a] - rx, ay = P[a + 1] - ry, az = P[a + 2] - rz;
    const bx = P[b] - rx, by = P[b + 1] - ry, bz = P[b + 2] - rz;
    const cx = P[c] - rx, cy = P[c + 1] - ry, cz = P[c + 2] - rz;
    const tv = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const ux = ax + bx + cx, uy = ay + by + cy, uz = az + bz + cz;
    v += tv; sx += tv * ux / 4; sy += tv * uy / 4; sz += tv * uz / 4;
    const k = tv / 20;
    xx += k * (ax * ax + bx * bx + cx * cx + ux * ux);
    yy += k * (ay * ay + by * by + cy * cy + uy * uy);
    zz += k * (az * az + bz * bz + cz * cz + uz * uz);
    xy += k * (ax * ay + bx * by + cx * cy + ux * uy);
    yz += k * (ay * az + by * bz + cy * cz + uy * uz);
    zx += k * (az * ax + bz * bx + cz * cx + uz * ux);
  }
  if (v === 0) return { volume: 0, com: [rx, ry, rz], cov: [...ZERO_SYM] };
  const gx = sx / v, gy = sy / v, gz = sz / v, s = Math.sign(v);
  return {
    volume: Math.abs(v),
    com: [rx + gx, ry + gy, rz + gz],
    cov: [s * (xx - v * gx * gx), s * (yy - v * gy * gy), s * (zz - v * gz * gz), s * (xy - v * gx * gy), s * (yz - v * gy * gz), s * (zx - v * gz * gx)],
  };
}

/** Covariance from an inertia tensor at the centre (OCCT's MatrixOfInertia: diagonal ∫(y²+z²), off-diagonal −∫xy). */
export function covOfTensor(T: number[][]): Sym {
  const h = (T[0][0] + T[1][1] + T[2][2]) / 2;
  return [h - T[0][0], h - T[1][1], h - T[2][2], -T[0][1], -T[1][2], -T[2][0]];
}

export const symMat = (s: Sym): number[][] => [[s[0], s[3], s[5]], [s[3], s[1], s[4]], [s[5], s[4], s[2]]];
const matSym = (m: number[][]): Sym => [m[0][0], m[1][1], m[2][2], (m[0][1] + m[1][0]) / 2, (m[1][2] + m[2][1]) / 2, (m[2][0] + m[0][2]) / 2];

/** R C Rᵀ: a covariance turned by R (rows of R = the new axes in old coordinates, or the matrix taking old to new). */
export function rotateSym(s: Sym, R: number[][]): Sym {
  const C = symMat(s), out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) sum += R[i][k] * C[k][l] * R[j][l];
    out[i][j] = sum;
  }
  return matSym(out);
}

const scale = (s: Sym, k: number): Sym => s.map(v => v * k) as Sym;
const add = (a: Sym, b: Sym): Sym => a.map((v, i) => v + b[i]) as Sym;
/** m d dᵀ (parallel axis term). */
const outer = (d: V3, m: number): Sym => [m * d[0] * d[0], m * d[1] * d[1], m * d[2] * d[2], m * d[0] * d[1], m * d[1] * d[2], m * d[2] * d[0]];

/** One body for `combine`: world centre, world covariance (unit density) and density in g/cm³. */
export interface MassBody { volume: number; area: number; com: V3; cov?: Sym; density: number }

export interface Combined {
  volume: number; area: number;
  /** Grams. */
  mass: number;
  com: V3;
  /** Mass covariance about the centre of mass, g·mm², world axes. */
  cov: Sym;
  /** Some body had no second moments (its own inertia is left out). */
  partial: boolean;
}

/**
 * The bodies of a multibody part as `combine` input (FR-MAT-001): a body with its own material takes
 * that density, the others `fallback` (the part's). Null when the bodies carry no mass properties.
 */
export function bodyMasses(bodies: { key: string; volume: number; area?: number; com?: V3; cov?: Sym }[], own: (key: string) => number | undefined, fallback: number): MassBody[] | null {
  if (!bodies.length || bodies.some(b => !b.com)) return null;
  return bodies.map(b => ({ volume: b.volume, area: b.area ?? 0, com: b.com!, cov: b.cov, density: own(b.key) ?? fallback }));
}

/** Adds bodies with their densities: mass, centre of mass and the mass covariance about it. */
export function combine(bodies: MassBody[]): Combined {
  let volume = 0, area = 0, mass = 0, partial = false;
  const c: V3 = [0, 0, 0];
  for (const b of bodies) {
    const m = b.volume * b.density / 1000;
    volume += b.volume; area += b.area; mass += m;
    for (let k = 0; k < 3; k++) c[k] += b.com[k] * m;
  }
  // Massless models (density 0 everywhere) still get a geometric centre.
  if (mass > 0) for (let k = 0; k < 3; k++) c[k] /= mass;
  else if (volume > 0) { c.fill(0); for (const b of bodies) for (let k = 0; k < 3; k++) c[k] += b.com[k] * b.volume / volume; }
  let cov: Sym = [...ZERO_SYM];
  for (const b of bodies) {
    const rho = b.density / 1000, m = b.volume * rho;
    if (b.cov) cov = add(cov, scale(b.cov, rho)); else if (b.volume > 0) partial = true;
    cov = add(cov, outer([b.com[0] - c[0], b.com[1] - c[1], b.com[2] - c[2]], m));
  }
  return { volume, area, mass, com: c, cov, partial };
}

/** Moments and products of inertia (SolidWorks' positive notation: Lxy = ∫xy dm) from a mass covariance. */
export function inertiaOf(cov: Sym): { xx: number; yy: number; zz: number; xy: number; yz: number; zx: number } {
  return { xx: cov[1] + cov[2], yy: cov[0] + cov[2], zz: cov[0] + cov[1], xy: cov[3], yz: cov[4], zx: cov[5] };
}

/** Principal moments (ascending) and their unit axes, at the centre of mass. */
export function principal(cov: Sym): { moments: V3; axes: [V3, V3, V3] } {
  const t = cov[0] + cov[1] + cov[2];
  // Eigenvectors of the tensor are those of the covariance; moment = trace − eigenvalue.
  const { values, vectors } = eigenSym3(symMat(cov));
  const order = [2, 1, 0];
  const axes = order.map(i => tidy(vectors[i] as V3)) as [V3, V3, V3];
  // Right-handed triad.
  const z = cross(axes[0], axes[1]);
  if (dot(z, axes[2]) < 0) axes[2] = axes[2].map(v => -v) as V3;
  return { moments: order.map(i => t - values[i]) as V3, axes };
}

/** An axis with its largest component positive, so the reported direction does not flip between runs. */
function tidy(a: V3): V3 {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(a[i]) > Math.abs(a[k]) + 1e-9) k = i;
  return a[k] < 0 ? a.map(v => -v || 0) as V3 : a;
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** An output coordinate system: origin and orthonormal axes in world coordinates. */
export interface Frame { origin: V3; x: V3; y: V3; z: V3 }

/** What SolidWorks' Mass Properties lists, in an output frame (identity = world). */
export interface MassReport extends Combined {
  /** Centre of mass in the frame. */
  local: V3;
  principal: { moments: V3; axes: [V3, V3, V3] };
  /** At the centre of mass, aligned with the frame (Lxx…). */
  atCom: ReturnType<typeof inertiaOf>;
  /** At the frame origin (Ixx…). */
  atOrigin: ReturnType<typeof inertiaOf>;
}

export function massReport(c: Combined, frame?: Frame | null): MassReport {
  const R = frame ? [frame.x, frame.y, frame.z] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const o = frame?.origin ?? [0, 0, 0];
  const w: V3 = [c.com[0] - o[0], c.com[1] - o[1], c.com[2] - o[2]];
  const local = R.map(r => dot(r as V3, w)) as V3;
  const covL = rotateSym(c.cov, R);
  const p = principal(c.cov);
  return {
    ...c, local,
    principal: { moments: p.moments, axes: p.axes.map(a => R.map(r => dot(r as V3, a)) as V3) as [V3, V3, V3] },
    atCom: inertiaOf(covL),
    atOrigin: inertiaOf(add(covL, outer(local, c.mass))),
  };
}

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric 3×3 matrix (Jacobi rotations). */
export function eigenSym3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map(r => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map(i => a[i][i]), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]]) };
}
