// Structural analysis (FR-SARC-002, FR-SARC-012): geometry the solver needs from the exact B-rep.
// A fine, watertight-per-face tessellation in double precision, with each triangle's face, so the
// solver can cut lines exactly at the boundary and pick the triangles of a support or load by face name.
// Runs where OpenCASCADE lives (kernel worker, node tests); the solver never holds OCCT objects.

export interface SimGeo {
  /** Triangles, 9 numbers each, wound outwards. */
  tris: Float64Array;
  /** Face index (into `faces`) of each triangle. */
  face: Int32Array;
  /** Box of the body. */
  lo: number[];
  hi: number[];
}

/**
 * Tessellates `faces` (a body's faces, in its own order) with chord deviation `lin` mm and angle `ang`
 * radians. The triangulation is cleaned off the shape afterwards so the view's mesh is not changed.
 */
export function simGeometry(oc: any, shape: any, faces: any[], lin: number, ang: number): SimGeo {
  oc.BRepTools.Clean(shape, true);
  new oc.BRepMesh_IncrementalMesh_2(shape, Math.max(lin, 1e-4), false, Math.max(ang, 0.005), false);
  const tris: number[] = [], face: number[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  try {
    faces.forEach((f, fi) => {
      const fc = oc.TopoDS.Face_1(f);
      const loc = new oc.TopLoc_Location_1();
      const h = oc.BRep_Tool.Triangulation(fc, loc, 0);
      if (h.IsNull()) return;
      const tri = h.get(), trsf = loc.Transformation();
      const P: number[] = [];
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = tri.Node(i).Transformed(trsf);
        const x = p.X(), y = p.Y(), z = p.Z();
        P.push(x, y, z);
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
        hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
      }
      const rev = fc.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let t = 1; t <= tri.NbTriangles(); t++) {
        const T = tri.Triangle(t);
        let a = T.Value(1) - 1, b = T.Value(2) - 1;
        const c = T.Value(3) - 1;
        if (rev) [a, b] = [b, a];
        tris.push(P[3 * a], P[3 * a + 1], P[3 * a + 2], P[3 * b], P[3 * b + 1], P[3 * b + 2], P[3 * c], P[3 * c + 1], P[3 * c + 2]);
        face.push(fi);
      }
    });
  } finally {
    oc.BRepTools.Clean(shape, true);
  }
  return { tris: Float64Array.from(tris), face: Int32Array.from(face), lo, hi };
}

/** The triangles of the given faces. */
export function faceTris(g: SimGeo, which: Set<number>): Float64Array {
  const out: number[] = [];
  for (let t = 0; t < g.face.length; t++) if (which.has(g.face[t])) for (let k = 0; k < 9; k++) out.push(g.tris[9 * t + k]);
  return Float64Array.from(out);
}
