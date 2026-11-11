// Drawing views (FRS 11.2, FR-DRW-010/016): hidden-line projection of a body with
// OCCT's exact HLR (HLRBRep_Algo). A view is a direction and an "up" vector; the
// result is flat 2D geometry in model millimetres (x right, y up on the sheet),
// sorted into visible / hidden and sharp / tangent / silhouette edges. Lines and
// circular arcs stay exact (dimensions and centre marks need them); other curves
// become polylines within a small chord error.

export type V3 = [number, number, number];
/** Edge class: 0 sharp edge, 1 tangent (smooth) edge, 2 silhouette (outline). */
export type EdgeClass = 0 | 1 | 2;
export type Seg2 =
  | { k: "l"; c: EdgeClass; p: [number, number, number, number] }
  /** Arc counter-clockwise from a0 to a1 (radians, a1 > a0; a full circle has a1 − a0 = 2π). */
  | { k: "a"; c: EdgeClass; o: [number, number]; r: number; a0: number; a1: number }
  | { k: "p"; c: EdgeClass; p: number[] };
export interface Projection {
  vis: Seg2[];
  hid: Seg2[];
  /** Bounds of the visible geometry: [xmin, ymin, xmax, ymax]. */
  box: [number, number, number, number];
  ms: number;
  /** Section views: the cut faces as closed 2D loops (fill even-odd). */
  cut?: number[][];
  /** Section views: for each `cut` loop, the index of the input solid it lies on (TopExp order; -1 unknown). */
  cutOf?: number[];
  /** Section views: for each `cut` loop, who it belongs to (component id or body) and its material, set by the worker. */
  cutKey?: string[];
  cutMat?: (string | null)[];
  /** Shaded views (FR-DRW-010): triangles facing the viewer, back to front, 7 numbers each: u0 v0 u1 v1 u2 v2 grey. */
  shade?: number[];
  /** A quick polygonal preview (`projectPoly`): drawn, never measured. */
  preview?: boolean;
  /** Made by the fast hidden-line removal (`projectFast`, big models): lines and edge-on circles exact, visibility from a fine mesh. */
  fast?: boolean;
  /** Polygonal HLR: why some of its line sets could not be read (the fast path then tries again). */
  fail?: string;
  /** Section views: the cut faces' edges as model edges (model coordinates), each named `<model face>|§` after the
   * face the plane cut through, so dimensions can measure the section and find the edge again after a rebuild. */
  cutEdges?: MEdge[];
}
/** A view direction: `dir` points from the model towards the viewer; `up` is the sheet's +y. */
export interface ViewDir { dir: V3; up: V3 }

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Sheet x direction of a view (right-handed: x = up × dir). */
export function viewAxes(v: ViewDir): { x: V3; y: V3; n: V3 } {
  const n = unit(v.dir);
  let up = v.up;
  if (Math.abs(dot(unit(up), n)) > 0.999) up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const x = unit(cross(up, n));
  return { x, y: cross(n, x), n };
}

/**
 * A shape in OCCT's binary BREP format (exact doubles; with `mesh`, its triangulation too, so the reader need not mesh it
 * again), read back by `readBin`; compound children keep their order.
 */
export function shapeBin(oc: any, shape: any, mesh = false): Uint8Array {
  const path = `/drw-${Math.random().toString(36).slice(2)}.bin`;
  oc.BinTools.Write_4(shape, path, mesh, false, oc.BinTools_FormatVersion.BinTools_FormatVersion_CURRENT, new oc.Message_ProgressRange_1());
  try { return oc.FS.readFile(path); } finally { oc.FS.unlink(path); }
}

export function readBin(oc: any, bytes: Uint8Array): any {
  const path = `/drw-${Math.random().toString(36).slice(2)}.bin`;
  oc.FS.writeFile(path, bytes);
  try {
    const shape = new oc.TopoDS_Shape();
    oc.BinTools.Read_2(shape, path, new oc.Message_ProgressRange_1());
    if (shape.IsNull()) throw new Error("Could not read the model snapshot");
    return shape;
  } finally { oc.FS.unlink(path); }
}

/** A compound's direct children in order. */
export function childShapes(oc: any, shape: any): any[] {
  const out: any[] = [];
  for (const it = new oc.TopoDS_Iterator_2(shape, true, true); it.More(); it.Next()) out.push(it.Value());
  return out;
}

/** Reads STEP / IGES / BREP bytes into one shape (all roots in a compound). */
export function readShape(oc: any, bytes: Uint8Array, name: string): any {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const path = `/drw-${Math.random().toString(36).slice(2)}.${ext === "igs" || ext === "iges" ? "igs" : ext === "brep" ? "brep" : "stp"}`;
  oc.FS.writeFile(path, bytes);
  try {
    if (ext === "brep") {
      const shape = new oc.TopoDS_Shape();
      oc.BRepTools.Read_2(shape, path, new oc.BRep_Builder(), new oc.Message_ProgressRange_1());
      if (shape.IsNull()) throw new Error("Could not read the BREP file");
      return shape;
    }
    const reader = ext === "igs" || ext === "iges" ? new oc.IGESControl_Reader_1() : new oc.STEPControl_Reader_1();
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("Could not read the file");
    reader.TransferRoots(new oc.Message_ProgressRange_1());
    const shape = reader.OneShape();
    if (shape.IsNull()) throw new Error("The file has no geometry");
    return shape;
  } finally {
    try { oc.FS.unlink(path); } catch { /* gone */ }
  }
}

/** Projects `shape` along a view. `tol` is the chord error for free-form curves (mm). */
export function project(oc: any, shape: any, view: ViewDir, tol = 0.02): Projection {
  const t0 = Date.now();
  const { x, n } = viewAxes(view);
  const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
  const algo = new oc.HLRBRep_Algo_1();
  algo.Add_2(shape, 0);
  algo.Projector_1(new oc.HLRAlgo_Projector_2(ax));
  algo.Update();
  algo.Hide_1();
  const h = new oc.HLRBRep_HLRToShape(new oc.Handle_HLRBRep_Algo_2(algo));
  const vis: Seg2[] = [], hid: Seg2[] = [];
  const take = (s: any, out: Seg2[], c: EdgeClass) => { if (s && !s.IsNull()) edges(oc, s, out, c, tol); };
  take(h.VCompound_1(), vis, 0);
  take(h.Rg1LineVCompound_1(), vis, 1);
  take(h.OutLineVCompound_1(), vis, 2);
  take(h.HCompound_1(), hid, 0);
  take(h.Rg1LineHCompound_1(), hid, 1);
  take(h.OutLineHCompound_1(), hid, 2);
  return { vis, hid: unhide(hid, vis), box: bounds(vis.length ? vis : hid), ms: Date.now() - t0 };
}

/**
 * One HLRBRep_PolyHLRToShape per OpenCASCADE instance, reused by every polygonal view: deleting one does not give
 * its memory back (an engine assembly lost ~25 MB per view that way), while `Update` on a kept one reuses it.
 */
const polyReaders = new WeakMap<object, any>();
function polyReader(oc: any): any {
  let h = polyReaders.get(oc);
  if (!h) { h = new oc.HLRBRep_PolyHLRToShape(); polyReaders.set(oc, h); }
  return h;
}

/**
 * A quick preview of a view (FR-DRW-016, NFR-PERF-040): OCCT's polygonal HLR (HLRBRep_PolyAlgo) on the
 * shape's triangulation, meshed at `lin` mm chord error. Every line is a polyline, so it is for showing
 * only: dimensions and picking wait for the exact projection. The result is marked `preview`.
 */
export function projectPoly(oc: any, shape: any, view: ViewDir, lin: number, ang = 0.5): Projection {
  const t0 = Date.now();
  // Every OCCT object made here is deleted at the end: the polygonal HLR holds the whole model's mesh data,
  // ~100 MB for an engine assembly, and leaked objects ran the worker's heap out after a few views (exam round three).
  const made: any[] = [];
  const keep = <T,>(o: T): T => { made.push(o); return o; };
  keep(new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, ang, false));
  const { x, n } = viewAxes(view);
  const ax = keep(new oc.gp_Ax2_2(keep(new oc.gp_Pnt_3(0, 0, 0)), keep(new oc.gp_Dir_4(n[0], n[1], n[2])), keep(new oc.gp_Dir_4(x[0], x[1], x[2]))));
  const algo = new oc.HLRBRep_PolyAlgo_1();
  // The handle owns the algorithm: deleting the handle (and the reader holding a copy) frees it.
  const ha = new oc.Handle_HLRBRep_PolyAlgo_2(algo);
  const h = polyReader(oc);
  try {
  algo.Load(shape);
  algo.Projector_2(keep(new oc.HLRAlgo_Projector_2(ax)));
  algo.Update();
  h.Update(ha);
  const vis: Seg2[] = [], hid: Seg2[] = [];
  const fails: string[] = [];
  const take = (get: () => any, out: Seg2[], c: EdgeClass) => {
    let s: any;
    try { s = get(); } catch (e) { fails.push(e instanceof Error ? e.message : typeof e === "number" ? `OCCT exception ${e}` : String(e)); return; }
    if (s && !s.IsNull()) polyEdges(oc, s, out, c);
    s?.delete?.();
  };
  take(() => h.VCompound_1(), vis, 0);
  take(() => h.Rg1LineVCompound_1(), vis, 1);
  take(() => h.OutLineVCompound_1(), vis, 2);
  take(() => h.HCompound_1(), hid, 0);
  take(() => h.Rg1LineHCompound_1(), hid, 1);
  take(() => h.OutLineHCompound_1(), hid, 2);
  return { vis, hid, box: bounds(vis.length ? vis : hid), ms: Date.now() - t0, preview: true, ...(fails.length ? { fail: [...new Set(fails)].join("; ") } : {}) };
  } finally {
    try { algo.Clear(); } catch { /* older builds */ }
    ha.delete();
    for (const o of made) { try { o.delete(); } catch { /* already gone */ } }
  }
}

/** Edges at or above which a view is projected by `projectFast`: the exact HLR grows too slow (a 57-part engine ran 20+ min). */
export const FAST_EDGES = 1500;

/** How many edges a shape has. */
export function edgeCount(oc: any, shape: any): number {
  const m = new oc.TopTools_IndexedMapOfShape_1();
  try { oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, m); return m.Extent(); } finally { m.delete(); }
}

/** The exact HLR, or `projectFast` (chord 1/1000 of the model's size) for models of `FAST_EDGES` edges or more. */
export function projectAuto(oc: any, shape: any, view: ViewDir, tol = 0.02, fast = FAST_EDGES): Projection {
  if (edgeCount(oc, shape) < fast) return project(oc, shape, view, tol);
  const [lo, hi] = shapeBox(oc, shape);
  return projectFast(oc, shape, view, Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 1000));
}

/** A circle seen end-on in a view: centre on the sheet (model mm) and radius. */
export interface Circle2 { o: [number, number]; r: number }
/** A straight model edge on the sheet: unit direction `u` (pointing right, or up) and offset `d` = point · (−u.y, u.x). */
export interface Line2 { u: [number, number]; d: number }

/** The shape's circles (and arcs) whose axis lies along the view direction and its straight edges, as they show on the sheet. */
export function viewCurves(oc: any, shape: any, view: ViewDir): { circles: Circle2[]; lines: Line2[] } {
  const { x, y, n } = viewAxes(view), T = oc.GeomAbs_CurveType, out: Circle2[] = [], lines: Line2[] = [], seen = new Set<string>();
  const m = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, m);
  // Every wrapper is deleted: this runs on each fast view of a big assembly (see `polyEdges`).
  const gone: any[] = [];
  const own = <O,>(o: O): O => { gone.push(o); return o; };
  try {
    for (let i = 1; i <= m.Extent(); i++) {
      try {
        let ad: any;
        try { ad = own(new oc.BRepAdaptor_Curve_2(own(oc.TopoDS.Edge_1(own(m.FindKey(i)))))); } catch { continue; }
        const ty = ad.GetType();
        if (ty === T.GeomAbs_Line) {
          const a = own(ad.Value(ad.FirstParameter())), b = own(ad.Value(ad.LastParameter()));
          const A: V3 = [a.X(), a.Y(), a.Z()], B: V3 = [b.X(), b.Y(), b.Z()];
          const ax = dot(A, x), ay = dot(A, y);
          let ux = dot(B, x) - ax, uy = dot(B, y) - ay;
          const l = Math.hypot(ux, uy);
          if (l < 1e-9) continue;
          ux /= l; uy /= l;
          if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
          lines.push({ u: [ux, uy], d: ax * -uy + ay * ux });
          continue;
        }
        if (ty !== T.GeomAbs_Circle) continue;
        const c = own(ad.Circle()), axis = own(c.Axis()), a = own(axis.Direction()), p = own(c.Location());
        if (Math.abs(a.X() * n[0] + a.Y() * n[1] + a.Z() * n[2]) < 0.9999) continue;
        const P: V3 = [p.X(), p.Y(), p.Z()], o: [number, number] = [dot(P, x), dot(P, y)], r = c.Radius();
        const k = `${o[0].toFixed(4)},${o[1].toFixed(4)},${r.toFixed(4)}`;
        if (!seen.has(k)) { seen.add(k); out.push({ o, r }); }
      } finally {
        for (const o of gone.splice(0)) { try { o.delete(); } catch { /* not a wrapper */ } }
      }
    }
  } finally { m.delete(); }
  return { circles: out, lines };
}

/**
 * Fast hidden-line removal for big models (drawings exam: a 57-part assembly never finished the exact HLR):
 * OCCT's polygonal HLR on a fine mesh, then each polyline is rebuilt from what it really is. Mesh nodes on an
 * edge lie on the exact curve, so straight runs become lines with exact ends, and runs on an end-on circle of the
 * model become exact arcs of it (centre and radius from the B-rep, not fitted), so dimensions, centre marks and
 * picking work as on an exact view. Other curves stay polylines within `lin` mm.
 */
export function projectFast(oc: any, shape: any, view: ViewDir, lin: number): Projection {
  const t0 = Date.now();
  const poly = (l: number, a: number): Projection => {
    try { return projectPoly(oc, shape, view, l, a); } catch (e) { return { vis: [], hid: [], box: [0, 0, 0, 0], ms: 0, fail: e instanceof Error ? e.message : String(e) }; }
  };
  let p = poly(lin, 0.1);
  // The polygonal HLR can come back empty (drawings exam round three: an engine assembly got views with no
  // lines at all). Try again on a fresh, coarser mesh (what the previews use), then fall back to the exact HLR.
  if (!p.vis.length) {
    console.warn(`Fast view: the polygonal HLR gave ${p.hid.length} hidden and no visible lines${p.fail ? ` (${p.fail})` : ""}; trying a coarser mesh.`);
    try { oc.BRepTools.Clean(shape, true); } catch { /* keep the old mesh */ }
    p = poly(lin * 10 / 3, 0.5);
  }
  if (!p.vis.length) {
    console.warn(`Fast view: still no visible lines${p.fail ? ` (${p.fail})` : ""}; using the exact HLR.`);
    return project(oc, shape, view, 0.02);
  }
  const { circles, lines } = viewCurves(oc, shape, view);
  const vis = exactify(p.vis, circles, lin, lines), hid = underLines(exactify(p.hid, circles, lin, lines), vis, Math.max(1e-4, lin * 1.5));
  return { vis, hid: unhide(hid, vis), box: bounds(vis.length ? vis : hid), ms: Date.now() - t0, fast: true };
}

/** Polylines (and chords) of a polygonal HLR turned into lines, exact arcs of `circles` and leftover polylines (see `projectFast`). */
export function exactify(segs: Seg2[], circles: Circle2[], lin: number, lines: Line2[] = []): Seg2[] {
  // Mesh nodes lie on the exact curves, so straight runs are straight to rounding (sTol); a cut where a line goes
  // behind something can be off by up to the chord error (tol).
  // A chord of a straight edge lies on it exactly, also where it is cut (lTol).
  const tol = Math.max(1e-4, lin * 1.5), sTol = Math.max(1e-5, lin * 0.01), lTol = Math.max(1e-3, lin * 0.02), cell = Math.max(1, lin * 20);
  // Straight model edges by direction (buckets of 0.1°): a chord on one of them is that edge, not a piece of a curve.
  const AB = Math.PI / 1800, byAng = new Map<number, Line2[]>();
  const bucket = (ux: number, uy: number) => Math.round(Math.atan2(uy, ux) / AB);
  for (const L of lines) { const b = bucket(L.u[0], L.u[1]); (byAng.get(b) ?? byAng.set(b, []).get(b)!).push(L); }
  const onLine = (x0: number, y0: number, x1: number, y1: number) => {
    let ux = x1 - x0, uy = y1 - y0;
    const l = Math.hypot(ux, uy);
    if (l < 1e-9) return false;
    ux /= l; uy /= l;
    if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
    const b0 = bucket(ux, uy), span = Math.ceil(Math.atan2(2 * lTol, l) / AB) + 1;
    for (let b = b0 - span; b <= b0 + span; b++) for (const L of byAng.get(b) ?? [])
      if (Math.abs(x0 * -L.u[1] + y0 * L.u[0] - L.d) <= lTol && Math.abs(x1 * -L.u[1] + y1 * L.u[0] - L.d) <= lTol) return true;
    // Vertical lines sit at both ends of the angle range.
    if (Math.abs(b0) > 900 - span) for (let b = -b0 - span; b <= -b0 + span; b++) for (const L of byAng.get(b) ?? [])
      if (Math.abs(x0 * -L.u[1] + y0 * L.u[0] - L.d) <= lTol && Math.abs(x1 * -L.u[1] + y1 * L.u[0] - L.d) <= lTol) return true;
    return false;
  };
  const grid = new Map<string, Circle2[]>();
  const gk = (u: number, v: number) => `${Math.floor(u / cell)},${Math.floor(v / cell)}`;
  for (const c of circles) { const k = gk(c.o[0], c.o[1]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(c); }
  const near = (o: [number, number], r: number): Circle2 | null => {
    const i0 = Math.floor(o[0] / cell), j0 = Math.floor(o[1] / cell);
    let best: Circle2 | null = null, bd = Infinity;
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const c of grid.get(`${i},${j}`) ?? []) {
      const d = Math.hypot(c.o[0] - o[0], c.o[1] - o[1]) + Math.abs(c.r - r);
      if (d < bd) { bd = d; best = c; }
    }
    return best && bd < Math.max(tol * 4, best.r * 0.02) ? best : null;
  };
  const on = (c: Circle2, x: number, y: number) => Math.abs(Math.hypot(x - c.o[0], y - c.o[1]) - c.r) <= tol;
  const out: Seg2[] = [];
  for (const s0 of chains(segs, Math.min(1e-4, tol / 10))) {
    if (s0.k === "a") { out.push(s0); continue; }
    const s = { k: "p" as const, c: s0.c, p: s0.p as number[] };
    const P = s.p, n = P.length / 2, X = (i: number) => P[2 * i], Y = (i: number) => P[2 * i + 1], cls = s.c;
    let poly: number[] = [];
    const flushPoly = () => { if (poly.length >= 4) out.push(poly.length === 4 ? { k: "l", c: cls, p: [poly[0], poly[1], poly[2], poly[3]] } : { k: "p", c: cls, p: poly }); poly = []; };
    const addPoly = (i: number) => { if (!poly.length || poly[poly.length - 2] !== X(i) || poly[poly.length - 1] !== Y(i)) poly.push(X(i), Y(i)); };
    let i = 0;
    while (i < n - 1) {
      // An end-on circle of the model through three points in a row: follow it as far as the points stay on it.
      let arc: { c: Circle2; j: number } | null = null;
      if (i + 2 < n) {
        const f = circle3(X(i), Y(i), X(i + 1), Y(i + 1), X(i + 2), Y(i + 2));
        const c = f && near(f.o, f.r);
        if (c && on(c, X(i), Y(i)) && on(c, X(i + 1), Y(i + 1)) && on(c, X(i + 2), Y(i + 2))) {
          let j = i + 2;
          while (j + 1 < n && on(c, X(j + 1), Y(j + 1))) j++;
          arc = { c, j };
        }
      }
      if (arc) {
        flushPoly();
        const { c, j } = arc;
        let a = Math.atan2(Y(i) - c.o[1], X(i) - c.o[0]), sw = 0;
        const a0 = a;
        for (let k = i + 1; k <= j; k++) {
          const b = Math.atan2(Y(k) - c.o[1], X(k) - c.o[0]);
          let d = b - a;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          sw += d; a = b;
        }
        const full = Math.abs(sw) > 2 * Math.PI - 1e-3;
        const s0 = full ? a0 : sw >= 0 ? a0 : a0 + sw, s1 = full ? a0 + 2 * Math.PI : s0 + Math.abs(sw);
        out.push({ k: "a", c: cls, o: [c.o[0], c.o[1]], r: c.r, a0: s0, a1: s1 });
        i = j;
        continue;
      }
      // A straight run: as many points as stay within the tolerance of the chord from i.
      let j = i + 1;
      while (j + 1 < n && straight(P, i, j + 1, sTol)) j++;
      const len = Math.hypot(X(j) - X(i), Y(j) - Y(i));
      // A chord alone may be a piece of a curve: it is a line when it lies on a straight model edge, or is an outline
      // (a cylinder seen side-on), or the run is too long for one chord of a curve.
      if ((j - i >= 2 && len > 4 * tol) || (cls === 2 && len > 4 * tol) || (len > 20 * lTol && onLine(X(i), Y(i), X(j), Y(j))) || (!lines.length && len > 8 * tol)) { flushPoly(); out.push({ k: "l", c: cls, p: [X(i), Y(i), X(j), Y(j)] }); }
      else { addPoly(i); addPoly(j); }
      i = j;
    }
    flushPoly();
  }
  return mergeLines(out, tol);
}

/** Joins lines of one class that lie on one line and touch or overlap (the mesh gives an edge as many short pieces). */
export function mergeLines(segs: Seg2[], tol: number): Seg2[] {
  const rest: Seg2[] = [], groups = new Map<string, { c: EdgeClass; u: [number, number]; t: number[][]; d: number }>();
  const aq = 1e-3, dq = Math.max(tol * 2, 1e-3);
  for (const s of segs) {
    if (s.k !== "l") { rest.push(s); continue; }
    let [x0, y0, x1, y1] = s.p;
    let dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy);
    if (l < 1e-12) continue;
    dx /= l; dy /= l;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }
    const d = x0 * -dy + y0 * dx, ang = Math.atan2(dy, dx);
    const key = `${s.c}|${Math.round(ang / aq)}|${Math.round(d / dq)}`;
    const g = groups.get(key) ?? groups.set(key, { c: s.c, u: [dx, dy], t: [], d }).get(key)!;
    const ta = x0 * g.u[0] + y0 * g.u[1], tb = x1 * g.u[0] + y1 * g.u[1];
    g.t.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }
  const out = rest;
  for (const g of groups.values()) {
    g.t.sort((a, b) => a[0] - b[0]);
    const n: [number, number] = [-g.u[1], g.u[0]];
    let cur = g.t[0].slice();
    const emit = () => out.push({ k: "l", c: g.c, p: [n[0] * g.d + g.u[0] * cur[0], n[1] * g.d + g.u[1] * cur[0], n[0] * g.d + g.u[0] * cur[1], n[1] * g.d + g.u[1] * cur[1]] });
    for (let i = 1; i < g.t.length; i++) {
      if (g.t[i][0] <= cur[1] + tol) cur[1] = Math.max(cur[1], g.t[i][1]);
      else { emit(); cur = g.t[i].slice(); }
    }
    emit();
  }
  return out;
}

/**
 * Chords and polylines of one class joined end to end into the longest runs (the mesh HLR gives each mesh edge on
 * its own and in no order); a run stops where three or more pieces meet. Arcs pass through.
 */
export function chains(segs: Seg2[], eps: number): Seg2[] {
  const out: Seg2[] = [];
  const byClass = new Map<EdgeClass, number[][]>();
  for (const s of segs) {
    if (s.k === "a") { out.push(s); continue; }
    (byClass.get(s.c) ?? byClass.set(s.c, []).get(s.c)!).push(s.k === "l" ? [...s.p] : [...s.p]);
  }
  const key = (x: number, y: number) => `${Math.round(x / eps)},${Math.round(y / eps)}`;
  for (const [c, runs] of byClass) {
    const ends = new Map<string, number[]>(); // node → run ends at it (2·run + 0 start / 1 end)
    const at = (r: number[], e: number) => e ? key(r[r.length - 2], r[r.length - 1]) : key(r[0], r[1]);
    runs.forEach((r, i) => { for (const e of [0, 1]) { const k = at(r, e); (ends.get(k) ?? ends.set(k, []).get(k)!).push(2 * i + e); } });
    const used = new Uint8Array(runs.length);
    // From run i's end e, the one other run meeting there (only when exactly two meet).
    const next = (i: number, e: number): number | null => {
      const l = ends.get(at(runs[i], e))!;
      if (l.length !== 2) return null;
      const o = l[0] >> 1 === i && (l[0] & 1) === e ? l[1] : l[0];
      return (o >> 1) === i || used[o >> 1] ? null : o;
    };
    const rev = (r: number[]) => { const o: number[] = []; for (let k = r.length - 2; k >= 0; k -= 2) o.push(r[k], r[k + 1]); return o; };
    for (let i = 0; i < runs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      let pts = runs[i].slice();
      // Grow forward from the end, then backward from the start.
      for (let cur = i, e = 1; ;) {
        const o = next(cur, e);
        if (o === null) break;
        const j = o >> 1, r = (o & 1) === 0 ? runs[j] : rev(runs[j]);
        used[j] = 1; pts.push(...r.slice(2)); cur = j; e = (o & 1) === 0 ? 1 : 0;
      }
      for (let cur = i, e = 0; ;) {
        const o = next(cur, e);
        if (o === null) break;
        const j = o >> 1, r = (o & 1) === 1 ? runs[j] : rev(runs[j]);
        used[j] = 1; pts = [...r.slice(0, -2), ...pts]; cur = j; e = (o & 1) === 1 ? 0 : 1;
      }
      out.push(pts.length === 4 ? { k: "l", c, p: [pts[0], pts[1], pts[2], pts[3]] } : { k: "p", c, p: pts });
    }
  }
  return out;
}

/** Hidden polylines left out where every point lies on a visible line (an edge-on circle seen behind an outline). */
function underLines(hid: Seg2[], vis: Seg2[], tol: number): Seg2[] {
  const ls = vis.filter(s => s.k === "l");
  if (!ls.length) return hid;
  const b = bounds(ls), cell = Math.max(1e-3, Math.max(b[2] - b[0], b[3] - b[1]) / 50), grid = new Map<string, number[]>();
  ls.forEach((s, i) => {
    const [x0, y0, x1, y1] = s.p;
    for (let gx = Math.floor((Math.min(x0, x1) - tol) / cell); gx <= Math.floor((Math.max(x0, x1) + tol) / cell); gx++)
      for (let gy = Math.floor((Math.min(y0, y1) - tol) / cell); gy <= Math.floor((Math.max(y0, y1) + tol) / cell); gy++) {
        const k = `${gx},${gy}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
  });
  const onVis = (x: number, y: number) => (grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []).some(i => {
    const [ax, ay, bx, by] = ls[i].p, dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= tol;
  });
  return hid.filter(s => s.k !== "p" || !s.p.every((v, i) => i % 2 === 1 || onVis(v, s.p[i + 1])));
}

/** Circle through three points (null when they are in a line). */
function circle3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): { o: [number, number]; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { o: [ox, oy], r: Math.hypot(ax - ox, ay - oy) };
}

/** Whether the points i..j of a flat point list all lie within `tol` of the chord from i to j. */
function straight(P: number[], i: number, j: number, tol: number): boolean {
  const ax = P[2 * i], ay = P[2 * i + 1], dx = P[2 * j] - ax, dy = P[2 * j + 1] - ay, l = Math.hypot(dx, dy);
  if (l < 1e-12) return false;
  for (let k = i + 1; k < j; k++) {
    const ex = P[2 * k] - ax, ey = P[2 * k + 1] - ay;
    if (Math.abs(ex * dy - ey * dx) / l > tol) return false;
    const t = (ex * dx + ey * dy) / (l * l);
    if (t < -1e-6 || t > 1 + 1e-6) return false;
  }
  return true;
}

/** The straight pieces of a polygonal HLR result (its edges are lines between mesh points), joined end to end. */
function polyEdges(oc: any, comp: any, out: Seg2[], c: EdgeClass) {
  const A = oc.TopAbs_ShapeEnum;
  let run: number[] | null = null;
  const flush = () => { if (run && run.length >= 4) out.push(run.length === 4 ? { k: "l", c, p: [run[0], run[1], run[2], run[3]] } : { k: "p", c, p: run }); run = null; };
  // Every wrapper is deleted: a live adaptor or edge keeps the HLR result's edges and curves in the wasm heap,
  // which leaked ~100 MB per fast view of an engine assembly (drawings exam round three).
  const ex = new oc.TopExp_Explorer_2(comp, A.TopAbs_EDGE, A.TopAbs_SHAPE);
  try {
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current(), e = oc.TopoDS.Edge_1(cur);
      let ad: any = null, a: any = null, b: any = null;
      try {
        ad = new oc.BRepAdaptor_Curve_2(e);
        a = ad.Value(ad.FirstParameter()); b = ad.Value(ad.LastParameter());
        const ax = a.X(), ay = a.Y(), bx = b.X(), by = b.Y();
        if (Math.hypot(bx - ax, by - ay) < 1e-9) continue;
        if (run && Math.abs(run[run.length - 2] - ax) < 1e-7 && Math.abs(run[run.length - 1] - ay) < 1e-7) run.push(bx, by);
        else { flush(); run = [ax, ay, bx, by]; }
      } catch { continue; } finally {
        a?.delete(); b?.delete(); ad?.delete(); e.delete(); cur.delete?.();
      }
    }
  } finally { ex.delete(); }
  flush();
}

/** Removes the parts of hidden lines and arcs that lie under visible ones (a back edge behind the outline). */
export function unhide(hid: Seg2[], vis: Seg2[], eps = 1e-4): Seg2[] {
  const out: Seg2[] = [];
  const sub = (iv: [number, number][], a: number, b: number) => {
    const r: [number, number][] = [];
    for (const [s, e] of iv) {
      if (b <= s + eps || a >= e - eps) { r.push([s, e]); continue; }
      if (a > s + eps) r.push([s, a]);
      if (b < e - eps) r.push([b, e]);
    }
    return r;
  };
  for (const h of hid) {
    if (h.k === "l") {
      const [x0, y0, x1, y1] = h.p, L = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      let iv: [number, number][] = [[0, L]];
      for (const v of vis) {
        if (v.k !== "l") continue;
        const d0 = (v.p[0] - x0) * uy - (v.p[1] - y0) * ux, d1 = (v.p[2] - x0) * uy - (v.p[3] - y0) * ux;
        if (Math.abs(d0) > eps || Math.abs(d1) > eps) continue;
        const t0 = (v.p[0] - x0) * ux + (v.p[1] - y0) * uy, t1 = (v.p[2] - x0) * ux + (v.p[3] - y0) * uy;
        iv = sub(iv, Math.min(t0, t1), Math.max(t0, t1));
        if (!iv.length) break;
      }
      for (const [a, b] of iv) if (b - a > eps * 10) out.push({ k: "l", c: h.c, p: [x0 + ux * a, y0 + uy * a, x0 + ux * b, y0 + uy * b] });
    } else if (h.k === "a") {
      let iv: [number, number][] = [[h.a0, h.a1]];
      const ae = eps / Math.max(h.r, eps);
      for (const v of vis) {
        if (v.k !== "a" || Math.abs(v.r - h.r) > eps || Math.hypot(v.o[0] - h.o[0], v.o[1] - h.o[1]) > eps) continue;
        // Compare in the hidden arc's turn: try the visible arc shifted by whole turns.
        for (const k of [-2, -1, 0, 1, 2]) iv = sub(iv, v.a0 + k * 2 * Math.PI - ae, v.a1 + k * 2 * Math.PI + ae);
        if (!iv.length) break;
      }
      for (const [a, b] of iv) if (b - a > ae * 10) out.push({ ...h, a0: a, a1: b });
    } else out.push(h);
  }
  return out;
}

function edges(oc: any, comp: any, out: Seg2[], c: EdgeClass, tol: number) {
  const A = oc.TopAbs_ShapeEnum, T = oc.GeomAbs_CurveType;
  for (const ex = new oc.TopExp_Explorer_2(comp, A.TopAbs_EDGE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const e = oc.TopoDS.Edge_1(ex.Current());
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { continue; }
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0)) continue;
    const P = (u: number): [number, number] => { const p = ad.Value(u); return [p.X(), p.Y()]; };
    const ty = ad.GetType();
    if (ty === T.GeomAbs_Line) {
      const a = P(u0), b = P(u1);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-7) out.push({ k: "l", c, p: [a[0], a[1], b[0], b[1]] });
    } else if (ty === T.GeomAbs_Circle) {
      const ci = ad.Circle(), loc = ci.Location(), r = ci.Radius();
      const o: [number, number] = [loc.X(), loc.Y()];
      const a = P(u0), b = P(u1), m = P((u0 + u1) / 2);
      const ang = (p: [number, number]) => Math.atan2(p[1] - o[1], p[0] - o[0]);
      if (u1 - u0 > 2 * Math.PI - 1e-9) { out.push({ k: "a", c, o, r, a0: 0, a1: 2 * Math.PI }); continue; }
      let a0 = ang(a), a1 = ang(b);
      const am = ang(m);
      const norm = (v: number) => { while (v < 0) v += 2 * Math.PI; while (v >= 2 * Math.PI) v -= 2 * Math.PI; return v; };
      // Counter-clockwise from a0 must pass the middle point; otherwise swap the ends.
      if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
      let sweep = norm(a1 - a0);
      if (sweep < 1e-9) sweep = 2 * Math.PI;
      out.push({ k: "a", c, o, r, a0, a1: a0 + sweep });
    } else {
      const pts: number[] = [];
      try {
        const d = new oc.GCPnts_TangentialDeflection_2(ad, 0.1, tol, 2, 1e-9, 1e-7);
        for (let i = 1; i <= d.NbPoints(); i++) { const p = d.Value(i); pts.push(p.X(), p.Y()); }
      } catch {
        for (let i = 0; i <= 32; i++) { const p = P(u0 + (u1 - u0) * i / 32); pts.push(p[0], p[1]); }
      }
      if (pts.length < 4) continue;
      // A straight run (a circle seen edge-on) becomes a line, so it can hide under a visible one.
      const n = pts.length, x0 = pts[0], y0 = pts[1], x1 = pts[n - 2], y1 = pts[n - 1], L = Math.hypot(x1 - x0, y1 - y0);
      let straight = L > 1e-7;
      for (let i = 2; straight && i < n - 2; i += 2) straight = Math.abs((pts[i] - x0) * (y1 - y0) - (pts[i + 1] - y0) * (x1 - x0)) / L < 1e-6
        && (pts[i] - x0) * (x1 - x0) + (pts[i + 1] - y0) * (y1 - y0) >= -1e-9 && (pts[i] - x1) * (x0 - x1) + (pts[i + 1] - y1) * (y0 - y1) >= -1e-9;
      if (straight) out.push({ k: "l", c, p: [x0, y0, x1, y1] });
      else out.push({ k: "p", c, p: pts });
    }
  }
}

/** Bounds of 2D segments: [xmin, ymin, xmax, ymax]. */
export function bounds(segs: Seg2[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const s of segs) {
    if (s.k === "l") { add(s.p[0], s.p[1]); add(s.p[2], s.p[3]); }
    else if (s.k === "p") for (let i = 0; i < s.p.length; i += 2) add(s.p[i], s.p[i + 1]);
    else {
      add(s.o[0] + s.r * Math.cos(s.a0), s.o[1] + s.r * Math.sin(s.a0));
      add(s.o[0] + s.r * Math.cos(s.a1), s.o[1] + s.r * Math.sin(s.a1));
      for (let q = Math.ceil(s.a0 / (Math.PI / 2)); q * Math.PI / 2 <= s.a1; q++) add(s.o[0] + s.r * Math.cos(q * Math.PI / 2), s.o[1] + s.r * Math.sin(q * Math.PI / 2));
    }
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Tight bounds and volume of a shape (model mm). */
export function shapeInfo(oc: any, shape: any): { box: [V3, V3]; volume: number } {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
  const volume = Math.abs(p.Mass());
  p.delete();
  return { box: shapeBox(oc, shape), volume };
}

/**
 * An aligned section's model (FR-DRW-012): the part of `shape` on the `s` side of the plane through `c` is turned by
 * `ang` about the axis through `c` along `axis`, so the second leg's cut lies in the first leg's plane; the other part
 * stays. Both go into one compound, which is then cut like a straight section.
 */
export function alignedShape(oc: any, shape: any, al: { c: V3; s: V3; axis: V3; ang: number }): any {
  const [lo, hi] = shapeBox(oc, shape);
  const L = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10
    + 2 * Math.hypot(al.c[0] - (lo[0] + hi[0]) / 2, al.c[1] - (lo[1] + hi[1]) / 2, al.c[2] - (lo[2] + hi[2]) / 2);
  const half = (n: V3) => {
    // A box L deep on the n side of the plane, 2L wide across it.
    const t: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u0: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]], ul = Math.hypot(...u0);
    const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
    const w: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const o = [0, 1, 2].map(i => al.c[i] - u[i] * L - w[i] * L);
    const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(o[0], o[1], o[2]), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(u[0], u[1], u[2]));
    const box = new oc.BRepPrimAPI_MakeBox_5(ax, 2 * L, 2 * L, L).Shape();
    const mk = new oc.BRepAlgoAPI_Common_3(shape, box, new oc.Message_ProgressRange_1());
    mk.Build(new oc.Message_ProgressRange_1());
    if (!mk.IsDone()) throw new Error("The section could not be cut");
    return mk.Shape();
  };
  const keep = half([-al.s[0], -al.s[1], -al.s[2]]), turn = half(al.s);
  const tr = new oc.gp_Trsf_1();
  tr.SetRotation_1(new oc.gp_Ax1_2(new oc.gp_Pnt_3(al.c[0], al.c[1], al.c[2]), new oc.gp_Dir_4(al.axis[0], al.axis[1], al.axis[2])), al.ang);
  const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  b.Add(comp, keep);
  b.Add(comp, new oc.BRepBuilderAPI_Transform_2(turn, tr, true).Shape());
  return comp;
}

/** The shapes of a TopTools_ListOfShape (the bindings have no list iterator: walk a copy). */
function shapeList(oc: any, l: any): any[] {
  const out: any[] = [];
  const copy = new oc.TopTools_ListOfShape_3(l);
  while (copy.Size() > 0) { const s = copy.First_1(); out.push(s.Oriented(s.Orientation_1())); copy.RemoveFirst(); }
  copy.delete();
  return out;
}

/** How far (mm) a section's cutting plane is moved off the picked place (see `section`). */
export const SECTION_NUDGE = 1e-3;

/** Boxes already found, by shape wrapper: a tight box of an engine assembly takes ~1 s, and every view wanted it. */
const boxes = new WeakMap<object, [V3, V3]>();

/** The shape's tight bounding box (no mass properties), kept per shape object. */
export function shapeBox(oc: any, shape: any): [V3, V3] {
  const have = boxes.get(shape);
  if (have) return [[...have[0]], [...have[1]]];
  const b = new oc.Bnd_Box_1();
  oc.BRepBndLib.AddOptimal(shape, b, false, false);
  const lo = b.CornerMin(), hi = b.CornerMax();
  const box: [V3, V3] = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]];
  b.delete();
  boxes.set(shape, box);
  return [[...box[0]], [...box[1]]];
}

/** One input solid of a section: the pieces left of it (itself when the cutter cannot reach it) and its own Boolean. */
export interface CutPart { solid: any; pieces: any[]; cutter: any | null }

/**
 * Cuts `box` from each solid on its own. `half` (a plain section) = the box is the half space n · q > d: a solid wholly
 * on that side is dropped and one wholly on the other kept whole, from its bounding box; otherwise a solid whose box
 * misses the cutter's is kept whole. A shape without solids is cut as one.
 */
export function cutSolids(oc: any, shape: any, solids: any[], box: any, half: { n: V3; d: number } | null): { rest: any; parts: CutPart[] } {
  const b = new oc.BRep_Builder(), rest = new oc.TopoDS_Compound();
  b.MakeCompound(rest);
  const cutOne = (s: any): CutPart => {
    const c = new oc.BRepAlgoAPI_Cut_3(s, box, new oc.Message_ProgressRange_1());
    c.Build(new oc.Message_ProgressRange_1());
    if (!c.IsDone()) throw new Error("The section could not be cut");
    return { solid: s, pieces: [c.Shape()], cutter: c };
  };
  if (!solids.length) {
    const pc = cutOne(shape);
    b.Add(rest, pc.pieces[0]);
    return { rest, parts: [pc] };
  }
  let cb: any = null;
  if (!half) { cb = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(box, cb, false); }
  const parts = solids.map(s => {
    const sb = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(s, sb, true);
    let where = 0;
    if (sb.IsVoid()) where = 0;
    else if (half) {
      const lo = sb.CornerMin(), hi = sb.CornerMax(), xs = [lo.X(), hi.X()], ys = [lo.Y(), hi.Y()], zs = [lo.Z(), hi.Z()];
      let mn = Infinity, mx = -Infinity;
      for (const x of xs) for (const y of ys) for (const z of zs) { const v = x * half.n[0] + y * half.n[1] + z * half.n[2] - half.d; mn = Math.min(mn, v); mx = Math.max(mx, v); }
      where = mx < -1e-6 ? -1 : mn > 1e-6 ? 1 : 0;
    } else if (sb.IsOut_4(cb)) where = -1;
    sb.delete();
    const pc: CutPart = where < 0 ? { solid: s, pieces: [s], cutter: null } : where > 0 ? { solid: s, pieces: [], cutter: null } : cutOne(s);
    for (const piece of pc.pieces) b.Add(rest, piece);
    return pc;
  });
  cb?.delete();
  return { rest, parts };
}

/** A section view (FR-DRW-012): `view.dir` is the plane's normal, pointing at the viewer; material on the viewer's side of the plane through `p` is cut away. `cut` holds the cut faces as closed 2D loops (outer and holes alike; fill them even-odd). */
/**
 * `stair` (offset and half sections): the cutter is a staircase polygon of (t, o) points in the plane through `o`
 * spanned by `e` and `m`, run through the model square to that plane; values of 1e8 or more stand for "beyond the
 * model". Cut faces lying on any of `planes` (n · p) are hatched. `keep` is drawn whole (components left uncut).
 */
export function section(oc: any, shape: any, view: ViewDir, p0: V3, tol = 0.02, poly?: number[], opts: { stair?: SectionStair; keep?: any; namer?: (face: any) => string | null; fast?: number } = {}): Projection {
  return sectionFinish(oc, sectionCut(oc, shape, view, p0, poly, opts), view, tol, opts);
}

export interface SectionStair { o: V3; e: V3; m: V3; pts: number[]; planes: number[] }

/**
 * A section's cut (the slow Boolean part), kept so a quick preview and the exact lines can share it: `drawn` = what
 * is drawn (cut pieces + `keep`), `cut`/`cutOf` = the cut faces' loops in view axes and the input solid of each.
 */
export interface SectionCut {
  drawn: any; rest: any; parts: CutPart[]; cut: number[][]; cutOf: number[]; capEdges: any;
  st?: SectionStair; n: V3; x: V3; y: V3;
}

/** The cut of a section (see `section`), with the plane SECTION_NUDGE towards the viewer. Free it with `freeSection`. */
export function sectionCut(oc: any, shape: any, view: ViewDir, p0: V3, poly?: number[], opts: { stair?: SectionStair; keep?: any } = {}): SectionCut {
  const { x, y, n } = viewAxes(view);
  const [lo, hi] = shapeBox(oc, shape);
  const L = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
  let box: any;
  // The cutting plane goes SECTION_NUDGE towards the viewer from the picked place: a plane exactly through a
  // revolved face's axis (a piston cut along its centre line) took OCCT's Boolean minutes; 1 µm off it takes 0.1 s.
  const p: V3 = [p0[0] + n[0] * SECTION_NUDGE, p0[1] + n[1] * SECTION_NUDGE, p0[2] + n[2] * SECTION_NUDGE];
  const st = opts.stair && { ...opts.stair, o: opts.stair.o.map((v, j) => v + opts.stair!.m[j] * SECTION_NUDGE) as V3, planes: opts.stair.planes.map(d => d + SECTION_NUDGE) };
  if (st) {
    const { o, e, m } = st;
    const w: V3 = [e[1] * m[2] - e[2] * m[1], e[2] * m[0] - e[0] * m[2], e[0] * m[1] - e[1] * m[0]];
    const far = L + Math.hypot(o[0] - (lo[0] + hi[0]) / 2, o[1] - (lo[1] + hi[1]) / 2, o[2] - (lo[2] + hi[2]) / 2);
    const cl = (k: number) => Math.abs(k) >= 1e8 ? Math.sign(k) * far : k;
    const mp = new oc.BRepBuilderAPI_MakePolygon_1();
    let last: number[] | null = null;
    for (let i = 0; i + 1 < st.pts.length; i += 2) {
      const t = cl(st.pts[i]), k = cl(st.pts[i + 1]);
      const q = [0, 1, 2].map(j => o[j] + e[j] * t + m[j] * k - w[j] * far);
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < 1e-7) continue;
      mp.Add_1(new oc.gp_Pnt_3(q[0], q[1], q[2]));
      last = q;
    }
    mp.Close();
    if (!mp.IsDone()) throw new Error("The section could not be cut");
    const face = new oc.BRepBuilderAPI_MakeFace_15(mp.Wire(), true).Face();
    box = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(w[0] * 2 * far, w[1] * 2 * far, w[2] * 2 * far), false, true).Shape();
  } else if (poly && poly.length >= 6) {
    // Broken-out section (FR-DRW-015): only the material inside the outline (view axes u, v),
    // from the plane through p towards the viewer, is taken away.
    const d = dot(p, n);
    const mp = new oc.BRepBuilderAPI_MakePolygon_1();
    for (let i = 0; i + 1 < poly.length; i += 2) {
      const u = poly[i], v = poly[i + 1];
      mp.Add_1(new oc.gp_Pnt_3(x[0] * u + y[0] * v + n[0] * d, x[1] * u + y[1] * v + n[1] * d, x[2] * u + y[2] * v + n[2] * d));
    }
    mp.Close();
    if (!mp.IsDone()) throw new Error("The section could not be cut");
    const face = new oc.BRepBuilderAPI_MakeFace_15(mp.Wire(), true).Face();
    box = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(n[0] * L, n[1] * L, n[2] * L), false, true).Shape();
  } else {
    const o = [p[0] - x[0] * L - y[0] * L, p[1] - x[1] * L - y[1] * L, p[2] - x[2] * L - y[2] * L];
    const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(o[0], o[1], o[2]), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
    box = new oc.BRepPrimAPI_MakeBox_5(ax, 2 * L, 2 * L, L).Shape();
  }
  // Each solid is cut on its own, and only when the cutter can reach it (drawings exam round four: one Boolean of a
  // 57-part engine with the box ran for 25+ minutes, since the operation also intersects the parts with each other).
  // A solid the cutter cannot reach stays whole; one wholly on the viewer's side of a plain section's plane is dropped.
  const plain = !st && !(poly && poly.length >= 6), d0 = dot(p, n);
  const A0 = oc.TopAbs_ShapeEnum, solids: any[] = [];
  for (const ex = new oc.TopExp_Explorer_2(shape, A0.TopAbs_SOLID, A0.TopAbs_SHAPE); ex.More(); ex.Next()) solids.push(ex.Current());
  const cuts = cutSolids(oc, shape, solids, box, plain ? { n, d: d0 } : null);
  const rest = cuts.rest;
  // Which input solid each piece of the result came from, so each component or body is hatched on its own.
  const owned: { f: any; i: number }[] = [];
  cuts.parts.forEach((pc, i) => {
    for (const piece of pc.pieces) for (const fx = new oc.TopExp_Explorer_2(piece, A0.TopAbs_FACE, A0.TopAbs_SHAPE); fx.More(); fx.Next()) owned.push({ f: fx.Current(), i });
  });
  let drawn = rest;
  if (opts.keep) {
    const b = new oc.BRep_Builder(), c = new oc.TopoDS_Compound();
    b.MakeCompound(c); b.Add(c, rest); b.Add(c, opts.keep);
    drawn = c;
  }
  // Faces on the cutting plane: their wires, flattened into the view's axes.
  const cut: number[][] = [], cutOf: number[] = [];
  const A = oc.TopAbs_ShapeEnum;
  const capEdges = new oc.TopTools_IndexedMapOfShape_1();
  for (const ex = new oc.TopExp_Explorer_2(rest, A.TopAbs_FACE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const f = oc.TopoDS.Face_1(ex.Current());
    const ad = new oc.BRepAdaptor_Surface_2(f, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
    const pl = ad.Plane(), dn = pl.Axis().Direction(), lp = pl.Location(), N = st ? st.m : n;
    if (Math.abs(Math.abs(dn.X() * N[0] + dn.Y() * N[1] + dn.Z() * N[2]) - 1) > 1e-7) continue;
    const ld = lp.X() * N[0] + lp.Y() * N[1] + lp.Z() * N[2];
    if (!(st ? st.planes : [d0]).some(d => Math.abs(ld - d) <= 1e-5)) continue;
    const owner = owned.find(o => o.f.IsSame(f))?.i ?? -1;
    oc.TopExp.MapShapes_1(f, A.TopAbs_EDGE, capEdges);
    for (const wx = new oc.TopExp_Explorer_2(f, A.TopAbs_WIRE, A.TopAbs_SHAPE); wx.More(); wx.Next()) {
      const loop: number[] = [];
      for (const it = new oc.BRepTools_WireExplorer_2(oc.TopoDS.Wire_1(wx.Current())); it.More(); it.Next()) {
        const c = new oc.BRepAdaptor_Curve_2(it.Current());
        const fwd = it.Current().Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD;
        const u0 = c.FirstParameter(), u1 = c.LastParameter();
        const nSeg = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : Math.max(8, Math.ceil((u1 - u0) / 0.1));
        for (let i = 0; i < nSeg; i++) {
          const u = fwd ? u0 + (u1 - u0) * i / nSeg : u1 - (u1 - u0) * i / nSeg;
          const q = c.Value(u), P: V3 = [q.X(), q.Y(), q.Z()];
          loop.push(dot(P, x), dot(P, y));
        }
      }
      if (loop.length >= 6) { cut.push(loop); cutOf.push(owner); }
    }
  }
  return { drawn, rest, parts: cuts.parts, cut, cutOf, capEdges, st, n, x, y };
}

/** The exact lines of a cut section (projected like any view), its cut edges named by `namer`; frees the cut. */
export function sectionFinish(oc: any, sc: SectionCut, view: ViewDir, tol = 0.02, opts: { namer?: (face: any) => string | null; fast?: number } = {}): Projection {
  const { st, n, x, y, cut, cutOf } = sc;
  const proj = projectAuto(oc, sc.drawn, view, tol, opts.fast);
  if (st) dropSteps(proj, st, x, y, cut);
  const cutEdges = opts.namer ? sectionEdges(oc, sc.parts, sc.capEdges, opts.namer, st ? st.m.map(v => v * SECTION_NUDGE) as V3 : [n[0] * SECTION_NUDGE, n[1] * SECTION_NUDGE, n[2] * SECTION_NUDGE]) : undefined;
  freeSection(sc);
  return cutEdges ? { ...proj, cut, cutOf, cutEdges } : { ...proj, cut, cutOf };
}

/**
 * A quick preview of a cut section (FR-DRW-016): the polygonal HLR of the cut shape at `lin` chord error, with the
 * same cut loops, so the view shows its outline and hatching while the exact lines are on the way. Keeps the cut.
 */
export function sectionPreview(oc: any, sc: SectionCut, view: ViewDir, lin: number): Projection {
  const proj = projectPoly(oc, sc.drawn, view, lin);
  if (sc.st) dropSteps(proj, sc.st, sc.x, sc.y, sc.cut);
  return { ...proj, cut: sc.cut, cutOf: sc.cutOf };
}

/** Frees a section's Booleans (once). */
export function freeSection(sc: SectionCut) {
  if (!sc.capEdges) return;
  sc.capEdges.delete();
  sc.capEdges = null;
  for (const pc of sc.parts) pc.cutter?.delete();
}

/**
 * An offset or half section's steps (the cutter's walls square to the cut planes, at a constant t inside the model) are
 * no edges of the part: ISO 128-44 and SolidWorks leave them out of the section, so the hatching on both sides meets on
 * no line. Their edges lie on one line each in the view; where cut faces lie on both sides of it the line is dropped
 * (drawings exam #12). Where the step meets material that is not cut, it stays: there it is the cut face's outline.
 */
export function dropSteps(proj: { vis: Seg2[]; hid: Seg2[] }, st: { o: V3; e: V3; pts: number[] }, x: V3, y: V3, cut: number[][]) {
  const ex = dot(st.e, x), ey = dot(st.e, y), len = Math.hypot(ex, ey);
  if (len < 1e-9 || !cut.length) return;
  const nx = ex / len, ny = ey / len, cs: number[] = [];
  for (let i = 0; i + 3 < st.pts.length; i += 2) {
    const t = st.pts[i];
    if (Math.abs(t) >= 1e8 || Math.abs(st.pts[i + 2] - t) > 1e-9) continue;
    const P: V3 = [st.o[0] + st.e[0] * t, st.o[1] + st.e[1] * t, st.o[2] + st.e[2] * t];
    cs.push(nx * dot(P, x) + ny * dot(P, y));
  }
  if (!cs.length) return;
  // Even-odd over all cut loops: is (u, v) on a cut (hatched) face?
  const hatched = (u: number, v: number) => {
    let inside = false;
    for (const l of cut) for (let i = 0, j = l.length - 2; i < l.length; j = i, i += 2) {
      const yi = l[i + 1], yj = l[j + 1];
      if ((yi > v) !== (yj > v) && u < (l[j] - l[i]) * (v - yi) / (yj - yi) + l[i]) inside = !inside;
    }
    return inside;
  };
  const on = (u: number, v: number) => cs.some(c => Math.abs(nx * u + ny * v - c) < 1e-4);
  const cutLine = (u: number, v: number) => hatched(u + nx * 0.05, v + ny * 0.05) && hatched(u - nx * 0.05, v - ny * 0.05);
  const split = (list: Seg2[]) => list.flatMap((g): Seg2[] => {
    if (g.k !== "l" || !on(g.p[0], g.p[1]) || !on(g.p[2], g.p[3])) return [g];
    // Keep the stretches where the step borders material that is not cut (it is a real outline there).
    const [a, b, c, d] = g.p, L = Math.hypot(c - a, d - b), n = Math.max(2, Math.ceil(L / 0.25)), out: Seg2[] = [];
    let start = -1;
    for (let k = 0; k <= n; k++) {
      const keep = k < n && !cutLine(a + (c - a) * (k + 0.5) / n, b + (d - b) * (k + 0.5) / n);
      if (keep && start < 0) start = k;
      if (!keep && start >= 0) { out.push({ ...g, p: [a + (c - a) * start / n, b + (d - b) * start / n, a + (c - a) * k / n, b + (d - b) * k / n] }); start = -1; }
    }
    return out;
  });
  proj.vis = split(proj.vis);
  proj.hid = split(proj.hid);
}

/** The cut faces' edges as model edges, each named after the input face it lies on (`<name>|§`); unnamed ones are left out. */
function sectionEdges(oc: any, parts: CutPart[], capEdges: any, namer: (face: any) => string | null, back: V3 = [0, 0, 0]): MEdge[] {
  const A = oc.TopAbs_ShapeEnum, T = oc.GeomAbs_CurveType, n = capEdges.Extent();
  if (!n) return [];
  const name: (string | null)[] = new Array(n + 1).fill(null);
  for (const pc of parts) {
    if (!pc.pieces.length) continue;
    for (const ex = new oc.TopExp_Explorer_2(pc.solid, A.TopAbs_FACE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const of = ex.Current(), nm = namer(of);
      if (!nm) continue;
      let pieces = pc.cutter ? shapeList(oc, pc.cutter.Modified(of)) : [];
      if (!pieces.length && !pc.cutter?.IsDeleted(of)) pieces = [of];
      for (const p of pieces) for (const ix = new oc.TopExp_Explorer_2(p, A.TopAbs_EDGE, A.TopAbs_SHAPE); ix.More(); ix.Next()) {
        const k = capEdges.FindIndex(ix.Current());
        if (k > 0 && !name[k]) name[k] = nm;
      }
    }
  }
  // Put back on the picked plane (the cut was made SECTION_NUDGE off it).
  const xyz = (q: any): V3 => [q.X() - back[0], q.Y() - back[1], q.Z() - back[2]];
  const out: MEdge[] = [];
  for (let i = 1; i <= n; i++) {
    if (!name[i]) continue;
    const e = oc.TopoDS.Edge_1(capEdges.FindKey(i));
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { continue; }
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0) || oc.BRep_Tool.Degenerated(e)) continue;
    const k = `${name[i]}|§`, a = xyz(ad.Value(u0)), b = xyz(ad.Value(u1)), m = xyz(ad.Value((u0 + u1) / 2)), ty = ad.GetType();
    if (ty === T.GeomAbs_Line) out.push({ k, t: "l", a, b, m });
    else if (ty === T.GeomAbs_Circle) {
      const ci = ad.Circle();
      out.push({ k, t: "c", a, b, m, c: xyz(ci.Location()), ax: ((d: any): V3 => [d.X(), d.Y(), d.Z()])(ci.Axis().Direction()), r: ci.Radius(), sp: Math.min(2 * Math.PI, u1 - u0) });
    } else out.push({ k, t: "o", a, b, m });
  }
  return out;
}

// ---------- model topology for dimensions and centre marks (FR-DRW-021/023) ----------

/**
 * A model edge for dimensions: `k` names it by the faces it joins (persistent face names for parts,
 * face indices for files), so a dimension finds it again after the part changes; `m` is its middle.
 * Circles carry centre, axis, radius and the angle they sweep.
 */
export interface MEdge { k: string; t: "l" | "c" | "o"; a: V3; b: V3; m: V3; c?: V3; ax?: V3; r?: number; sp?: number }
/** A cylindrical face: axis point and direction, radius, extent along the axis from `o`, angle swept. */
/** `in`: material lies outside the cylinder (a hole, a slot end), not inside (a shaft). */
export interface MCyl { o: V3; ax: V3; r: number; v0: number; v1: number; sp: number; f?: string; in?: boolean }
/** A cone, torus or surface of revolution: its axis like a cylinder's, extent along it from `o`, angle swept (FR-DRW-023 centrelines). */
/** A cone, torus, revolved face or sphere (`o` = its centre, `r` = its radius) and the span of its axis it covers. */
export interface MRev { k: "cone" | "torus" | "rev" | "sphere"; o: V3; ax: V3; v0: number; v1: number; sp: number; r?: number; f?: string }
/** `com`: the shape's centre of mass (uniform density), for a drawing's centre of mass point; absent for sheets. */
export interface Topo { edges: MEdge[]; cyls: MCyl[]; revs?: MRev[]; com?: V3; holes?: MHole[] }
/** One piece of a hole: a cylinder (r0 = r1) or a cone, from v0 to v1 along the hole's axis. */
export interface MHoleSeg { k: "cyl" | "cone"; v0: number; v1: number; r0: number; r1: number }
/**
 * A hole read from the geometry (FR-DRW-022: callouts without a hole feature, e.g. STEP files): coaxial cylinders and
 * cones with material outside that follow on from each other, sorted along `ax` from `o`; `open` says whether air lies
 * just past the first and the last piece (both = a through hole).
 */
export interface MHole { o: V3; ax: V3; segs: MHoleSeg[]; open: [boolean, boolean]; f?: string }

/** Edges and cylinders of a shape. `names` are the faces' persistent names in TopExp order (else f<i>). */
export function topology(oc: any, shape: any, names?: string[]): Topo {
  const A = oc.TopAbs_ShapeEnum, T = oc.GeomAbs_CurveType;
  const emap = new oc.TopTools_IndexedMapOfShape_1(), fmap = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, A.TopAbs_EDGE, emap);
  oc.TopExp.MapShapes_1(shape, A.TopAbs_FACE, fmap);
  // The solids and which one each face is on: a hole end is checked against the solids its own faces belong to
  // (see `holeStacks`), not against a pin or bolt of another component sitting in it.
  const solidList: any[] = [], faceSolid: number[] = [];
  for (const ex = new oc.TopExp_Explorer_2(shape, A.TopAbs_SOLID, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const so = ex.Current(), m = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(so, A.TopAbs_FACE, m);
    for (let j = 1; j <= m.Extent(); j++) { const k = fmap.FindIndex(m.FindKey(j)); if (k > 0 && faceSolid[k] == null) faceSolid[k] = solidList.length; }
    m.delete();
    solidList.push(so);
  }
  const faceOf: string[][] = Array.from({ length: emap.Extent() + 1 }, () => []);
  const faceEdges: number[][] = [];
  for (let i = 1; i <= fmap.Extent(); i++) {
    const f = fmap.FindKey(i), name = names?.[i - 1] ?? `f${i - 1}`;
    const m = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(f, A.TopAbs_EDGE, m);
    const list: number[] = [];
    for (let j = 1; j <= m.Extent(); j++) { const k = emap.FindIndex(m.FindKey(j)); if (k > 0) { if (!faceOf[k].includes(name)) faceOf[k].push(name); list.push(k); } }
    faceEdges.push(list);
    m.delete();
  }
  const xyz = (p: any): V3 => [p.X(), p.Y(), p.Z()];
  const edges: MEdge[] = [];
  const byIndex: (MEdge | null)[] = [null];
  for (let i = 1; i <= emap.Extent(); i++) {
    const e = oc.TopoDS.Edge_1(emap.FindKey(i));
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { byIndex.push(null); continue; }
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0) || oc.BRep_Tool.Degenerated(e)) { byIndex.push(null); continue; }
    const k = [...faceOf[i]].sort().join("|") || `e${i}`;
    const a = xyz(ad.Value(u0)), b = xyz(ad.Value(u1)), m = xyz(ad.Value((u0 + u1) / 2));
    const ty = ad.GetType();
    let me: MEdge;
    if (ty === T.GeomAbs_Line) me = { k, t: "l", a, b, m };
    else if (ty === T.GeomAbs_Circle) {
      const ci = ad.Circle();
      me = { k, t: "c", a, b, m, c: xyz(ci.Location()), ax: xyz(ci.Axis().Direction()), r: ci.Radius(), sp: Math.min(2 * Math.PI, u1 - u0) };
    } else me = { k, t: "o", a, b, m };
    edges.push(me);
    byIndex.push(me);
  }
  const cyls: MCyl[] = [], revs: MRev[] = [], bores: Bore[] = [];
  // Material outside a cylinder or cone: its face normal points at the axis (a direct frame's natural normal points away).
  const inward = (f: any, ax3: any) => (f.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) === ax3.Direct();
  for (let i = 1; i <= fmap.Extent(); i++) {
    const f = oc.TopoDS.Face_1(fmap.FindKey(i));
    let sa: any;
    try { sa = new oc.BRepAdaptor_Surface_2(f, true); } catch { continue; }
    const S = oc.GeomAbs_SurfaceType, st = sa.GetType();
    if (st === S.GeomAbs_Cone || st === S.GeomAbs_Torus || st === S.GeomAbs_SurfaceOfRevolution) {
      // Cones, tori and revolved faces carry their axis too, so a side view draws it (a taper, a countersink, a groove).
      let o: V3, ax: V3;
      try {
        if (st === S.GeomAbs_SurfaceOfRevolution) { const a1 = sa.AxeOfRevolution(); o = xyz(a1.Location()); ax = unit(xyz(a1.Direction())); }
        else { const a3 = (st === S.GeomAbs_Cone ? sa.Cone() : sa.Torus()).Position(); o = xyz(a3.Location()); ax = unit(xyz(a3.Direction())); }
      } catch { continue; }
      let v0 = Infinity, v1 = -Infinity;
      for (const k of faceEdges[i - 1]) {
        const me = byIndex[k];
        if (!me) continue;
        for (const p of [me.a, me.b, me.m]) { const v = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], ax); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      }
      const sp = Math.min(2 * Math.PI, sa.LastUParameter() - sa.FirstUParameter());
      if (v1 > v0 && st === S.GeomAbs_Cone) {
        const cn = sa.Cone(), R = cn.RefRadius(), ta = Math.tan(cn.SemiAngle());
        if (inward(f, cn.Position())) bores.push({ o, ax, k: "cone", v0, v1, r0: R + v0 * ta, r1: R + v1 * ta, sp, f: names?.[i - 1] ?? `f${i - 1}`, s: faceSolid[i] });
      }
      if (v1 > v0) revs.push({ k: st === S.GeomAbs_Cone ? "cone" : st === S.GeomAbs_Torus ? "torus" : "rev", o, ax, v0, v1, sp, f: names?.[i - 1] ?? `f${i - 1}` });
      continue;
    }
    if (st === S.GeomAbs_Sphere) {
      // A ball end or a sphere seen from any side gets a centre mark; only spheres that go all round (not corner blends).
      try {
        const sp = Math.min(2 * Math.PI, sa.LastUParameter() - sa.FirstUParameter()), a3 = sa.Sphere().Position(), r = sa.Sphere().Radius();
        if (sp >= 2 * Math.PI - 1e-3) revs.push({ k: "sphere", o: xyz(a3.Location()), ax: unit(xyz(a3.Direction())), v0: -r, v1: r, sp, r, f: names?.[i - 1] ?? `f${i - 1}` });
      } catch { /* no sphere */ }
      continue;
    }
    if (st !== S.GeomAbs_Cylinder) continue;
    const cy = sa.Cylinder(), ax3 = cy.Position();
    const o = xyz(ax3.Location()), ax = unit(xyz(ax3.Direction())), r = cy.Radius();
    let v0 = Infinity, v1 = -Infinity;
    for (const k of faceEdges[i - 1]) {
      const me = byIndex[k];
      if (!me) continue;
      for (const p of [me.a, me.b, me.m]) { const v = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], ax); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    }
    const sp = Math.min(2 * Math.PI, sa.LastUParameter() - sa.FirstUParameter());
    if (v1 > v0) cyls.push({ o, ax, r, v0, v1, sp, f: names?.[i - 1] ?? `f${i - 1}`, ...(inward(f, ax3) ? { in: true } : {}) });
    if (v1 > v0 && inward(f, ax3)) bores.push({ o, ax, k: "cyl", v0, v1, r0: r, r1: r, sp, f: names?.[i - 1] ?? `f${i - 1}`, s: faceSolid[i] });
  }
  emap.delete(); fmap.delete();
  // A point is in the air when it is outside the hole's own solid (all solids when unknown). One classifier per solid,
  // made once and tried only where the solid's box holds the point: a fresh classifier of the whole compound per point
  // took 45 s on an engine assembly, and it took a pin in a hole for air or not depending on the faces' parity.
  const solids: ({ box: any; cls: any } | undefined)[] = [];
  const solid = (k: number) => {
    let s = solids[k];
    if (!s) {
      const so = solidList.length ? solidList[k] : shape, box = new oc.Bnd_Box_1();
      oc.BRepBndLib.Add(so, box, false);
      box.Enlarge(1e-6);
      s = solids[k] = { box, cls: new oc.BRepClass3d_SolidClassifier_2(so) };
    }
    return s;
  };
  const holes = holeStacks(bores, (p, own) => {
    try {
      const P = new oc.gp_Pnt_3(p[0], p[1], p[2]);
      try {
        const ks = own != null ? [own] : solidList.length ? solidList.map((_, k) => k) : [0];
        for (const k of ks) {
          const s = solid(k);
          if (s.box.IsOut_1(P)) continue;
          s.cls.Perform(P, 1e-7);
          if (s.cls.State() !== oc.TopAbs_State.TopAbs_OUT) return false;
        }
        return true;
      } finally { P.delete(); }
    } catch { return false; }
  });
  for (const s of solids) { s?.cls.delete(); s?.box.delete(); }
  let com: V3 | undefined;
  try {
    const g = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, g, true, false, false);
    if (Math.abs(g.Mass()) > 1e-9) { const c = g.CentreOfMass(); com = [c.X(), c.Y(), c.Z()]; }
    g.delete();
  } catch { /* no volume */ }
  const out: Topo = { edges, cyls, revs };
  if (com) out.com = com;
  if (holes.length) out.holes = holes;
  return out;
}

/** A cylinder or cone face with material outside, before it is put into a hole. */
export type Bore = MHoleSeg & { o: V3; ax: V3; sp: number; f?: string; /** Index of the solid the face is on. */ s?: number };

/**
 * Hole stacks from bore faces: faces on one axis line (split halves of one surface summed) that follow on from each
 * other along it; only whole holes (every piece goes all the way round). `out(p)` says whether a point is in the air.
 */
export function holeStacks(bores: Bore[], out: (p: V3, solid?: number) => boolean): MHole[] {
  const lines: { o: V3; ax: V3; f?: string; s?: number; segs: (MHoleSeg & { sp: number })[] }[] = [];
  for (const b of bores) {
    // One line per solid: a bolt hole through two plates of an assembly is a hole in each plate (as each part's own
    // drawing shows it), not one stack.
    let L = lines.find(l => l.s === b.s && Math.abs(Math.abs(dot(l.ax, b.ax)) - 1) < 1e-6 && (() => {
      const w: V3 = [b.o[0] - l.o[0], b.o[1] - l.o[1], b.o[2] - l.o[2]], al = dot(w, l.ax);
      return Math.hypot(w[0] - l.ax[0] * al, w[1] - l.ax[1] * al, w[2] - l.ax[2] * al) < 1e-4;
    })());
    if (!L) lines.push(L = { o: b.o, ax: b.ax, f: b.f, s: b.s, segs: [] });
    // Express the piece along the line's axis: shift by the origins' offset, flip when the axes are opposite.
    const sh = dot([b.o[0] - L.o[0], b.o[1] - L.o[1], b.o[2] - L.o[2]], L.ax), sg = dot(b.ax, L.ax) > 0 ? 1 : -1;
    let v0 = sh + sg * b.v0, v1 = sh + sg * b.v1, r0 = b.r0, r1 = b.r1;
    if (v0 > v1) { [v0, v1] = [v1, v0]; [r0, r1] = [r1, r0]; }
    const same = L.segs.find(s => s.k === b.k && Math.abs(s.v0 - v0) < 1e-6 && Math.abs(s.v1 - v1) < 1e-6 && Math.abs(s.r0 - r0) < 1e-6 && Math.abs(s.r1 - r1) < 1e-6);
    if (same) same.sp += b.sp; else L.segs.push({ k: b.k, v0, v1, r0, r1, sp: b.sp });
  }
  const holes: MHole[] = [];
  for (const L of lines) {
    const segs = L.segs.sort((a, b) => a.v0 - b.v0);
    let run: typeof segs = [], end = -Infinity;
    const flush = () => {
      if (run.length && run.every(s => s.sp >= 2 * Math.PI - 1e-3)) {
        const a = run[0].v0, b = end, d = Math.max(1e-3, (b - a) * 1e-3);
        const at = (v: number): V3 => [L.o[0] + L.ax[0] * v, L.o[1] + L.ax[1] * v, L.o[2] + L.ax[2] * v];
        holes.push({ o: L.o, ax: L.ax, segs: run.map(({ k, v0, v1, r0, r1 }) => ({ k, v0, v1, r0, r1 })), open: [out(at(a - d), L.s), out(at(b + d), L.s)], ...(L.f ? { f: L.f } : {}) });
      }
      run = [];
    };
    for (const s of segs) {
      if (run.length && s.v0 > end + 1e-6) flush();
      if (!run.length) end = -Infinity;
      run.push(s); end = Math.max(end, s.v1);
    }
    flush();
  }
  return holes;
}

// ---------- geometry compare (FR-PDM-050) ----------

/** Triangles of a shape (positions and indices, no normals: the viewer computes them). */
export interface Tris { position: number[]; index: number[] }

export function triangles(oc: any, shape: any, lin: number): Tris {
  new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, 0.4, false);
  const pos: number[] = [], idx: number[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const face = oc.TopoDS.Face_1(ex.Current());
    const loc = new oc.TopLoc_Location_1();
    const h = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (h.IsNull()) continue;
    const tri = h.get(), trsf = loc.Transformation(), base = pos.length / 3;
    for (let i = 1; i <= tri.NbNodes(); i++) { const p = tri.Node(i).Transformed(trsf); pos.push(p.X(), p.Y(), p.Z()); }
    const rev = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    for (let t = 1; t <= tri.NbTriangles(); t++) {
      const T = tri.Triangle(t);
      let a = T.Value(1) - 1, b = T.Value(2) - 1;
      if (rev) [a, b] = [b, a];
      idx.push(base + a, base + b, base + T.Value(3) - 1);
    }
  }
  return { position: pos, index: idx };
}

/**
 * Shading for a view (FR-DRW-010): the shape's triangles that face the viewer, in the view's axes, sorted back to
 * front for painting, each with a grey from a light over the viewer's left shoulder. `lin` is the mesh's chord error.
 */
export function shadeTris(oc: any, shape: any, view: ViewDir, lin: number): number[] {
  const { x, y, n } = viewAxes(view);
  const L = unit([n[0] + 0.35 * y[0] - 0.3 * x[0], n[1] + 0.35 * y[1] - 0.3 * x[1], n[2] + 0.35 * y[2] - 0.3 * x[2]]);
  const { position: P, index: I } = triangles(oc, shape, lin);
  const tris: { d: number; q: number[] }[] = [];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const A: V3 = [P[a], P[a + 1], P[a + 2]], B: V3 = [P[b], P[b + 1], P[b + 2]], C: V3 = [P[c], P[c + 1], P[c + 2]];
    const nn = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    const len = Math.hypot(...nn);
    if (len < 1e-12) continue;
    const N: V3 = [nn[0] / len, nn[1] / len, nn[2] / len];
    if (dot(N, n) <= 1e-6) continue;
    const g = Math.round((0.32 + 0.6 * Math.max(0, dot(N, L))) * 64) / 64;
    tris.push({ d: (dot(A, n) + dot(B, n) + dot(C, n)) / 3, q: [dot(A, x), dot(A, y), dot(B, x), dot(B, y), dot(C, x), dot(C, y), g] });
  }
  tris.sort((p, q) => p.d - q.d);
  return tris.flatMap(t => t.q);
}

export interface ShapeFacts { volume: number; area: number; com: V3; box: [V3, V3] }

export function shapeFacts(oc: any, shape: any): ShapeFacts {
  const vp = new oc.GProp_GProps_1(), sp = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, vp, true, false, false);
  oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
  const c = vp.CentreOfMass();
  return { volume: Math.abs(vp.Mass()), area: sp.Mass(), com: [c.X(), c.Y(), c.Z()], box: shapeInfo(oc, shape).box };
}

export interface GeomDiff {
  a: ShapeFacts; b: ShapeFacts;
  /** Material only in the older version, only in the newer one, and in both. */
  removed: { volume: number; mesh: Tris }; added: { volume: number; mesh: Tris }; common: Tris;
}

/** Two versions of a body: what each has that the other lacks, by booleans, with meshes to show it. */
export function geometryDiff(oc: any, a: any, b: any): GeomDiff {
  const fa = shapeFacts(oc, a), fb = shapeFacts(oc, b);
  const size = Math.max(...[0, 1, 2].map(k => Math.max(fa.box[1][k], fb.box[1][k]) - Math.min(fa.box[0][k], fb.box[0][k])));
  const lin = Math.max(size * 1e-3, 1e-3);
  const run = (kind: "cut" | "common", x: any, y: any) => {
    const pr = new oc.Message_ProgressRange_1();
    const mk = kind === "cut" ? new oc.BRepAlgoAPI_Cut_3(x, y, pr) : new oc.BRepAlgoAPI_Common_3(x, y, pr);
    if (!mk.IsDone() || mk.HasErrors()) throw new Error("The two versions could not be compared.");
    return mk.Shape();
  };
  const rem = run("cut", a, b), add = run("cut", b, a), com = run("common", a, b);
  const vol = (s: any) => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(s, p, true, false, false); return Math.abs(p.Mass()); };
  return {
    a: fa, b: fb,
    removed: { volume: vol(rem), mesh: triangles(oc, rem, lin) },
    added: { volume: vol(add), mesh: triangles(oc, add, lin) },
    common: triangles(oc, com, lin),
  };
}
