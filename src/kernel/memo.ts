// Values computed from OpenCASCADE shapes, remembered while the shapes are in use.
//
// A rebuild changes a few faces of a body and keeps the rest (a Boolean hands unmodified faces on as the same
// shapes), yet the worker used to measure every face, the bounding box and the mass properties again after each
// one: on a part with a few hundred faces that cost more than the feature itself. Here each value is kept by the
// shape it was computed from (same TShape and location), so only what a rebuild really made is measured.
//
// Entries hold the shape's wrapper, so callers must not `delete()` a shape they pass in.

type V3 = [number, number, number];

interface Entry { shape: any; value: unknown; used: number }

/** Entries kept before the least recently used half is dropped. */
const LIMIT = 40000;

export class ShapeMemo {
  private map = new Map<string, Entry[]>();
  private clock = 0;
  private size = 0;
  /** Lookups answered from the memo and values computed, for tests and benchmarks. */
  hits = 0;
  misses = 0;

  /**
   * The value of `kind` for `shape`, computed by `make` the first time. `oriented`: a reversed copy of the shape
   * is another shape (mass properties change sign); otherwise only the TShape and location count.
   * A `make` that throws stores nothing. Callers must treat the value as read-only.
   */
  get<T>(kind: string, shape: any, make: () => T, oriented = false): T {
    const key = `${kind}|${shape.HashCode(0x7fffffff)}`;
    let list = this.map.get(key);
    if (list) for (const e of list) if (oriented ? e.shape.IsEqual(shape) : e.shape.IsSame(shape)) { e.used = ++this.clock; this.hits++; return e.value as T; }
    const value = make();
    this.misses++;
    if (!list) this.map.set(key, list = []);
    list.push({ shape, value, used: ++this.clock });
    if (++this.size > LIMIT) this.prune();
    return value;
  }

  private prune() {
    const cut = this.clock - LIMIT / 2;
    let n = 0;
    for (const [k, list] of this.map) {
      const keep = list.filter(e => e.used > cut);
      if (keep.length) { this.map.set(k, keep); n += keep.length; } else this.map.delete(k);
    }
    this.size = n;
  }

  clear() { this.map.clear(); this.size = 0; }
}

const memos = new WeakMap<object, ShapeMemo>();
/** The memo of one OpenCASCADE instance (one per worker). */
export function memoOf(oc: object): ShapeMemo {
  let m = memos.get(oc);
  if (!m) memos.set(oc, m = new ShapeMemo());
  return m;
}

/** Volume properties of a shape: signed volume, centre of mass and the matrix of inertia about it (unit density). */
export interface Mass { volume: number; com: V3; inertia: number[][] }

/** `BRepGProp::VolumeProperties` (closed shells only), once per shape. */
export function massOf(oc: any, shape: any): Mass {
  return memoOf(oc).get("mass", shape, () => {
    const vp = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, vp, true, false, false);
    const c = vp.CentreOfMass(), m = vp.MatrixOfInertia();
    const out: Mass = { volume: vp.Mass(), com: [c.X(), c.Y(), c.Z()], inertia: [0, 1, 2].map(r => [0, 1, 2].map(k => m.Value(r + 1, k + 1))) };
    m.delete(); c.delete(); vp.delete();
    return out;
  }, true);
}

/** `BRepGProp::SurfaceProperties` area, once per shape. */
export function areaOf(oc: any, shape: any): number {
  return memoOf(oc).get("area", shape, () => {
    const sp = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
    const a = sp.Mass();
    sp.delete();
    return a;
  });
}

/**
 * The exact bounding box of a shape (`BRepBndLib::AddOptimal`, no triangulation, no tolerance), as the union of
 * its faces' boxes, each computed once: OCCT's own loop adds the faces one by one in the same way, and the
 * optimal box of a curved face is the slow part (0.5 s for a flywheel). A shape without faces is boxed whole.
 */
export function optimalBox(oc: any, shape: any, faces?: any[]): [V3, V3] | null {
  const memo = memoOf(oc);
  const boxOf = (s: any): [V3, V3] | null => memo.get("box", s, () => {
    const b = new oc.Bnd_Box_1();
    try {
      oc.BRepBndLib.AddOptimal(s, b, false, false);
      if (b.IsVoid()) return null;
      const lo = b.CornerMin(), hi = b.CornerMax();
      const out: [V3, V3] = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]];
      lo.delete(); hi.delete();
      return out;
    } finally { b.delete(); }
  });
  if (!faces?.length) return boxOf(shape);
  // A face whose quick box (triangulation or curve bounds, enlarged by deflection and tolerance, so never smaller
  // than the face) lies inside the exact box of the faces done so far cannot widen it: its exact box is skipped.
  // The outermost faces go first, so most inner ones are skipped (flywheel: 26 → 6 optimal boxes).
  const quick = faces.map(f => looseBox(oc, f));
  let all: [V3, V3] | null = null;
  for (const q of quick) if (q) all = all ? union(all, q) : [[...q[0]], [...q[1]]];
  const reach = (q: [V3, V3] | null) => {
    if (!q || !all) return Infinity;
    let r = 0;
    for (let k = 0; k < 3; k++) {
      const c = (all[0][k] + all[1][k]) / 2, h = (all[1][k] - all[0][k]) / 2 || 1;
      r = Math.max(r, (q[1][k] - c) / h, (c - q[0][k]) / h);
    }
    return r;
  };
  const order = faces.map((_, i) => i).sort((a, b) => reach(quick[b]) - reach(quick[a]));
  let out: [V3, V3] | null = null;
  for (const i of order) {
    const q = quick[i];
    if (out && q && inside(q, out)) continue;
    const b = boxOf(faces[i]);
    if (!b) continue;
    out = out ? union(out, b) : [[...b[0]], [...b[1]]];
  }
  return out;
}

function union(a: [V3, V3], b: [V3, V3]): [V3, V3] {
  return [[0, 1, 2].map(k => Math.min(a[0][k], b[0][k])) as V3, [0, 1, 2].map(k => Math.max(a[1][k], b[1][k])) as V3];
}

function inside(q: [V3, V3], b: [V3, V3]): boolean {
  for (let k = 0; k < 3; k++) if (q[0][k] < b[0][k] || q[1][k] > b[1][k]) return false;
  return true;
}

/** A box sure to hold the face: `BRepBndLib::Add` (its triangulation, else its curves' bounds), enlarged by OCCT. */
function looseBox(oc: any, face: any): [V3, V3] | null {
  return memoOf(oc).get("lbox", face, () => {
    const b = new oc.Bnd_Box_1();
    try {
      oc.BRepBndLib.Add(face, b, true);
      if (b.IsVoid()) return null;
      const lo = b.CornerMin(), hi = b.CornerMax();
      const out: [V3, V3] = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]];
      lo.delete(); hi.delete();
      return out;
    } catch { return null; } finally { b.delete(); }
  });
}

/** Whether `p` is inside, on or outside a solid: one classifier per shape, kept for the next point. */
export function stateAt(oc: any, shape: any, p: V3, tol: number): "in" | "on" | "out" | "unknown" {
  const cls = memoOf(oc).get("classifier", shape, () => new oc.BRepClass3d_SolidClassifier_2(shape));
  const q = new oc.gp_Pnt_3(p[0], p[1], p[2]);
  cls.Perform(q, tol);
  q.delete();
  const s = cls.State(), S = oc.TopAbs_State;
  return s === S.TopAbs_IN ? "in" : s === S.TopAbs_ON ? "on" : s === S.TopAbs_OUT ? "out" : "unknown";
}
