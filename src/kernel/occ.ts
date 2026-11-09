// Exact B-rep geometry with the full OpenCASCADE build (opencascade.js).
//
// The model is first opened with occt-import-js (small and fast), which keeps
// only triangles. This module reads the same file again with the full kernel,
// walks it in exactly the order occt-import-js does (so mesh i and its face j
// are the same B-rep shapes here), and answers with exact values: volumes,
// areas, edge lengths, radii and curvature, plus STEP export.
//
// Works on a raw emscripten instance (`oc: any`): the generated typings are
// 9 MB and would slow every type check down.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { covOfTensor, type Sym } from "../tools/inertia";

export type V3 = [number, number, number];

/** What the main thread sends about each part, so we can check and match it. */
export interface PartProbe {
  /** Number of B-rep faces in the tessellation (brep_faces). */
  faces: number;
  /** Tessellated area of each face, mm². */
  faceArea: number[];
  /** Sample points (tessellation vertices) on freeform faces: [faceId, xyz...]. */
  samples: [number, number[]][];
  /** Rebuilt edges: the two faces it separates (-1 for a free edge), its polyline length, mid point and ends. */
  edges: { faces: [number, number]; length: number; mid: V3; start: V3; end: V3; closed: boolean }[];
}

export interface FacePatch {
  area: number;
  type?: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "freeform";
  radius?: number;
  axis?: V3;
  center?: V3;
  /** Principal curvature range over the samples (1/mm), freeform faces. */
  kMin?: number;
  kMax?: number;
  /** Cone half angle (rad) or torus minor radius. */
  angle?: number;
  minor?: number;
}

export interface EdgePatch {
  length: number;
  type?: "line" | "circle" | "arc" | "ellipse" | "curve";
  radius?: number;
  center?: V3;
  axis?: V3;
  sweep?: number;
}

export interface PartPatch {
  /** False when the shape did not match the tessellation (the part keeps its mesh values). */
  ok: boolean;
  reason?: string;
  volume?: number;
  area?: number;
  com?: V3;
  /** Covariance about `com` for unit density (src/tools/inertia.ts). */
  inertia?: Sym;
  faces?: (FacePatch | null)[];
  edges?: (EdgePatch | null)[];
}

const P = (p: any): V3 => [p.X(), p.Y(), p.Z()];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** One mesh of the occt-import-js output: its B-rep shape and its faces in output order. */
interface MeshShape {
  shape: any;
  faces: any[];
  name: string;
  color: V3 | null;
  /** Shell or solid (closed volume possible); false for loose faces. */
  solid: boolean;
}

export class Kernel {
  private doc: any = null;
  private shapeTool: any = null;
  private colorTool: any = null;
  /** The whole model, for STEP export of files without an XCAF document (BREP). */
  private root: any = null;
  meshes: MeshShape[] = [];
  private seq = 0;

  constructor(private oc: any) {}

  // ---------- reading ----------

  /** Reads a STEP, IGES or BREP file and lists its meshes like occt-import-js. Returns the face count per mesh. */
  /** Everything the last `load` read, as BREP text without triangles (an imported body, FR-FT-130). */
  brepText(): { brep: string; solids: number; faces: number } {
    const oc = this.oc;
    const comp = new oc.TopoDS_Compound(), b = new oc.BRep_Builder();
    b.MakeCompound(comp);
    let solids = 0, faces = 0;
    for (const m of this.meshes) { b.Add(comp, m.shape); if (m.solid) solids++; faces += m.faces.length; }
    const path = `/out${++this.seq}.brep`;
    oc.BRepTools.Write_4(comp, path, false, false, oc.TopTools_FormatVersion.TopTools_FormatVersion_CURRENT, new oc.Message_ProgressRange_1());
    const brep = oc.FS.readFile(path, { encoding: "utf8" }) as string;
    oc.FS.unlink(path);
    return { brep, solids, faces };
  }

  load(bytes: Uint8Array, name: string): number[] {
    const oc = this.oc;
    this.dispose();
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const path = `/in${++this.seq}.${ext === "igs" || ext === "iges" ? "igs" : ext === "brep" ? "brep" : "stp"}`;
    oc.FS.writeFile(path, bytes);
    try {
      if (ext === "brep") {
        const shape = new oc.TopoDS_Shape();
        const builder = new oc.BRep_Builder();
        oc.BRepTools.Read_2(shape, path, builder, new oc.Message_ProgressRange_1());
        if (shape.IsNull()) throw new Error("Could not read the BREP file");
        this.root = shape;
        this.enumerateShape(shape, "", null);
      } else {
        const doc = new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2("XmlXCAF", false)));
        oc.XCAFDoc_DocumentTool.SetLengthUnit_2(doc, 1, oc.UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter);
        const reader = ext === "igs" || ext === "iges" ? new oc.IGESCAFControl_Reader_1() : new oc.STEPCAFControl_Reader_1();
        reader.SetColorMode(true);
        reader.SetNameMode(true);
        if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("Could not read the file");
        const ok = ext === "igs" || ext === "iges" ? reader.Transfer(doc, new oc.Message_ProgressRange_1()) : reader.Transfer_1(doc, new oc.Message_ProgressRange_1());
        if (!ok) throw new Error("Could not transfer the file");
        this.doc = doc;
        const main = doc.get().Main();
        this.shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(main).get();
        this.colorTool = oc.XCAFDoc_DocumentTool.ColorTool(main).get();
        this.walkRoot();
      }
    } finally {
      try { oc.FS.unlink(path); } catch { /* already gone */ }
    }
    return this.meshes.map(m => m.faces.length);
  }

  private isFree(label: any) {
    const tmp = new this.oc.TopoDS_Shape();
    return this.oc.XCAFDoc_ShapeTool.GetShape_1(label, tmp) && this.oc.XCAFDoc_ShapeTool.IsFree(label);
  }

  private children(label: any): any[] {
    const out: any[] = [];
    for (const it = new this.oc.TDF_ChildIterator_2(label, false); it.More(); it.Next()) out.push(it.Value());
    return out;
  }

  /** occt-import-js XcafRootNode: free shapes under the shape tool's label, skipping empty ones. */
  private walkRoot() {
    const oc = this.oc;
    for (const child of this.children(this.shapeTool.Label())) {
      if (!this.isFree(child)) continue;
      const shape = oc.XCAFDoc_ShapeTool.GetShape_2(child);
      const box = new oc.Bnd_Box_1();
      oc.BRepBndLib.Add(shape, box, false);
      if (box.IsVoid()) continue;
      this.walkNode(child);
    }
  }

  /** XcafNode: a mesh node enumerates its shape's meshes; otherwise recurse into free-shape children. */
  private walkNode(label: any) {
    const oc = this.oc;
    const kids = this.children(label);
    const isMesh = !label.HasChild()
      || kids.some(c => oc.XCAFDoc_ShapeTool.IsSubShape_1(c))
      || !kids.some(c => this.isFree(c));
    if (isMesh) {
      const shape = oc.XCAFDoc_ShapeTool.GetShape_2(label);
      this.enumerateShape(shape, this.labelName(label), this.labelColor(label));
      return;
    }
    for (const c of kids) if (this.isFree(c)) this.walkNode(c);
  }

  /** Solids, then shells outside solids, then loose faces: the order occt-import-js writes meshes in. */
  private enumerateShape(shape: any, name: string, color: V3 | null) {
    const oc = this.oc;
    const A = oc.TopAbs_ShapeEnum;
    const faces = (s: any, avoid = A.TopAbs_SHAPE) => {
      const out: any[] = [];
      for (const ex = new oc.TopExp_Explorer_2(s, A.TopAbs_FACE, avoid); ex.More(); ex.Next()) out.push(oc.TopoDS.Face_1(ex.Current()));
      return out;
    };
    for (const ex = new oc.TopExp_Explorer_2(shape, A.TopAbs_SOLID, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const s = ex.Current();
      this.meshes.push({ shape: s, faces: faces(s), name: this.shapeName(s) || name, color: this.shapeColor(s) ?? color, solid: true });
    }
    for (const ex = new oc.TopExp_Explorer_2(shape, A.TopAbs_SHELL, A.TopAbs_SOLID); ex.More(); ex.Next()) {
      const s = ex.Current();
      this.meshes.push({ shape: s, faces: faces(s), name: this.shapeName(s) || name, color: this.shapeColor(s) ?? color, solid: false });
    }
    const loose = faces(shape, A.TopAbs_SHELL);
    if (loose.length) {
      const comp = new oc.TopoDS_Compound();
      const b = new oc.BRep_Builder();
      b.MakeCompound(comp);
      for (const f of loose) b.Add(comp, f);
      this.meshes.push({ shape: comp, faces: loose, name, color, solid: false });
    }
  }

  private labelName(label: any): string {
    const oc = this.oc;
    try {
      let l = label;
      if (oc.XCAFDoc_ShapeTool.IsReference(l)) { const r = new oc.TDF_Label(); if (oc.XCAFDoc_ShapeTool.GetReferredShape(l, r)) l = r; }
      const h = new oc.Handle_TDataStd_Name_1();
      if (!l.FindAttribute_1(oc.TDataStd_Name.GetID(), h)) return "";
      return h.get().Get().ToExtString?.() ?? new oc.TCollection_AsciiString_13(h.get().Get(), 63).ToCString();
    } catch { return ""; }
  }

  private labelColor(label: any): V3 | null {
    const oc = this.oc;
    if (!this.colorTool) return null;
    try {
      const c = new oc.Quantity_Color_1();
      const T = oc.XCAFDoc_ColorType;
      for (const t of [T.XCAFDoc_ColorSurf, T.XCAFDoc_ColorCurv, T.XCAFDoc_ColorGen]) {
        if (this.colorTool.GetColor_2(label, t, c)) return [c.Red(), c.Green(), c.Blue()];
      }
      if (oc.XCAFDoc_ShapeTool.IsReference(label)) {
        const r = new oc.TDF_Label();
        if (oc.XCAFDoc_ShapeTool.GetReferredShape(label, r)) return this.labelColor(r);
      }
    } catch { /* no colour */ }
    return null;
  }

  private shapeLabel(s: any) {
    if (!this.shapeTool) return null;
    const l = new this.oc.TDF_Label();
    try { return this.shapeTool.Search(s, l, true, true, true) ? l : null; } catch { return null; }
  }
  private shapeName(s: any) { const l = this.shapeLabel(s); return l ? this.labelName(l) : ""; }
  private shapeColor(s: any) { const l = this.shapeLabel(s); return l ? this.labelColor(l) : null; }

  // ---------- exact geometry ----------

  /** Exact values for mesh `i`, checked against what the tessellation says. */
  exact(i: number, probe: PartProbe): PartPatch {
    const oc = this.oc;
    const m = this.meshes[i];
    if (!m) return { ok: false, reason: "no shape" };
    if (m.faces.length !== probe.faces) return { ok: false, reason: `face count ${m.faces.length} ≠ ${probe.faces}` };

    const faces: (FacePatch | null)[] = [];
    let bad = 0, checked = 0;
    for (let f = 0; f < m.faces.length; f++) {
      const fp = this.face(m.faces[f]);
      faces.push(fp);
      const ma = probe.faceArea[f];
      if (!fp || !(ma > 0)) continue;
      checked++;
      // The tessellation sits within a small deflection of the surface; a different face would be far off.
      if (Math.abs(fp.area - ma) > Math.max(0.05 * fp.area, 1e-6)) bad++;
    }
    if (checked && bad > Math.max(1, checked * 0.1)) return { ok: false, reason: `${bad}/${checked} faces differ` };

    for (const [f, pts] of probe.samples) {
      const fp = faces[f];
      if (fp && fp.type === "freeform") Object.assign(fp, this.curvature(m.faces[f], pts));
    }

    const out: PartPatch = { ok: true, faces, edges: this.edges(m, probe) };
    // The faces' areas add up to the part's; integrate the whole shape only when a face failed.
    if (faces.every(f => f)) out.area = faces.reduce((s, f) => s + f!.area, 0);
    else {
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.SurfaceProperties_1(m.shape, props, false, false);
      out.area = props.Mass();
    }
    if (m.solid && this.allSolid(m.shape)) {
      const vp = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(m.shape, vp, true, false, false);
      const vol = vp.Mass();
      if (vol !== 0) {
        out.volume = Math.abs(vol); out.com = P(vp.CentreOfMass());
        const mi = vp.MatrixOfInertia();
        out.inertia = covOfTensor([0, 1, 2].map(r => [0, 1, 2].map(c => mi.Value(r + 1, c + 1) * Math.sign(vol))));
      }
    }
    return out;
  }

  /** A solid, or a compound (multibody part) made only of solids. */
  private allSolid(shape: any): boolean {
    const oc = this.oc, T = oc.TopAbs_ShapeEnum, t = shape.ShapeType();
    if (t === T.TopAbs_SOLID) return true;
    if (t !== T.TopAbs_COMPOUND && t !== T.TopAbs_COMPSOLID) return false;
    let n = 0;
    for (const it = new oc.TopoDS_Iterator_2(shape, true, true); it.More(); it.Next(), n++) if (!this.allSolid(it.Value())) return false;
    return n > 0;
  }

  private face(face: any): FacePatch | null {
    const oc = this.oc;
    try {
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
      const out: FacePatch = { area: props.Mass() };
      const s = new oc.BRepAdaptor_Surface_2(face, true);
      const T = oc.GeomAbs_SurfaceType;
      const t = s.GetType();
      const ax = (a: any): [V3, V3] => [P(a.Location()), P(a.Direction())];
      if (t === T.GeomAbs_Plane) out.type = "plane";
      else if (t === T.GeomAbs_Cylinder) {
        const c = s.Cylinder();
        const [loc, dir] = ax(c.Axis());
        Object.assign(out, { type: "cylinder", radius: c.Radius(), axis: dir, center: loc });
      } else if (t === T.GeomAbs_Sphere) {
        const c = s.Sphere();
        Object.assign(out, { type: "sphere", radius: c.Radius(), center: P(c.Location()) });
      } else if (t === T.GeomAbs_Cone) {
        const c = s.Cone();
        const [loc, dir] = ax(c.Axis());
        Object.assign(out, { type: "cone", radius: c.RefRadius(), angle: c.SemiAngle(), axis: dir, center: loc });
      } else if (t === T.GeomAbs_Torus) {
        const c = s.Torus();
        const [loc, dir] = ax(c.Axis());
        Object.assign(out, { type: "torus", radius: c.MajorRadius(), minor: c.MinorRadius(), axis: dir, center: loc });
      } else out.type = "freeform";
      return out;
    } catch { return null; }
  }

  /** Principal curvatures at the sample points (projected onto the surface). */
  private curvature(face: any, pts: number[]): Pick<FacePatch, "kMin" | "kMax"> {
    const oc = this.oc;
    try {
      const surf = oc.BRep_Tool.Surface_2(face);
      const sas = new oc.ShapeAnalysis_Surface(surf);
      const ad = new oc.BRepAdaptor_Surface_2(face, true);
      let kMin = Infinity, kMax = 0;
      for (let k = 0; k + 2 < pts.length; k += 3) {
        const uv = sas.ValueOfUV(new oc.gp_Pnt_3(pts[k], pts[k + 1], pts[k + 2]), 1e-6);
        const pr = new oc.BRepLProp_SLProps_1(ad, uv.X(), uv.Y(), 2, 1e-9);
        if (!pr.IsCurvatureDefined()) continue;
        const a = Math.abs(pr.MinCurvature()), b = Math.abs(pr.MaxCurvature());
        kMin = Math.min(kMin, a, b);
        kMax = Math.max(kMax, a, b);
      }
      return kMin === Infinity ? {} : { kMin, kMax };
    } catch { return {}; }
  }

  /** B-rep edges of mesh `m`: which faces use each, and their exact data (lazily). */
  private edges(m: MeshShape, probe: PartProbe): (EdgePatch | null)[] {
    const oc = this.oc;
    const A = oc.TopAbs_ShapeEnum;
    const map = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(m.shape, A.TopAbs_EDGE, map);
    const edgeFaces = new Map<number, Set<number>>();
    const faceEdges: number[][] = m.faces.map((f, fi) => {
      const ids: number[] = [];
      for (const ex = new oc.TopExp_Explorer_2(f, A.TopAbs_EDGE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
        const id = map.FindIndex(ex.Current());
        if (id <= 0 || ids.includes(id)) continue;
        ids.push(id);
        (edgeFaces.get(id) ?? edgeFaces.set(id, new Set()).get(id)!).add(fi);
      }
      return ids;
    });
    const info = new Map<number, ReturnType<Kernel["edgeInfo"]>>();
    const get = (id: number) => {
      if (!info.has(id)) info.set(id, this.edgeInfo(oc.TopoDS.Edge_1(map.FindKey(id))));
      return info.get(id)!;
    };

    return probe.edges.map(pe => {
      const [fa, fb] = pe.faces;
      const cand = (faceEdges[fa] ?? []).filter(id => {
        const fs = edgeFaces.get(id)!;
        return fb < 0 ? fs.size === 1 : fb === fa ? true : fs.has(fb);
      });
      if (!cand.length) return null;
      const scale = Math.max(pe.length, dist(pe.start, pe.end), 1e-9);
      const tol = Math.max(scale * 0.02, 1e-4);
      // The rebuilt edge may be several B-rep edges joined (a circle in two halves): take every
      // candidate whose ends and middle lie on the polyline's span.
      const parts = cand.map(get).filter((e): e is NonNullable<typeof e> => !!e).filter(e => {
        if (pe.closed) return true;
        const near = (p: V3) => dist(p, pe.start) < tol || dist(p, pe.end) < tol || dist(p, pe.mid) < scale * 0.75;
        return near(e.start) && near(e.end);
      });
      if (!parts.length) return null;
      const length = parts.reduce((s, e) => s + e.length, 0);
      if (Math.abs(length - pe.length) > Math.max(pe.length * 0.03, 1e-4)) return null;
      const out: EdgePatch = { length };
      const circ = parts.every(e => e.circle) && parts.every(e => dist(e.circle!.center, parts[0].circle!.center) < tol && Math.abs(e.circle!.radius - parts[0].circle!.radius) < tol);
      if (circ) {
        const c = parts[0].circle!;
        const sweep = length / c.radius;
        Object.assign(out, { type: sweep > 2 * Math.PI - 1e-6 ? "circle" : "arc", radius: c.radius, center: c.center, axis: c.axis, sweep: Math.min(sweep, 2 * Math.PI) });
      } else if (parts.length === 1) out.type = parts[0].kind;
      return out;
    });
  }

  private edgeInfo(edge: any) {
    const oc = this.oc;
    try {
      if (oc.BRep_Tool.Degenerated(edge)) return null;
      const c = new oc.BRepAdaptor_Curve_2(edge);
      const T = oc.GeomAbs_CurveType;
      const t = c.GetType();
      const u0 = c.FirstParameter(), u1 = c.LastParameter();
      const length = oc.GCPnts_AbscissaPoint.Length_1(c);
      const kind: EdgePatch["type"] = t === T.GeomAbs_Line ? "line" : t === T.GeomAbs_Circle ? "arc" : t === T.GeomAbs_Ellipse ? "ellipse" : "curve";
      let circle: { center: V3; radius: number; axis: V3 } | null = null;
      if (t === T.GeomAbs_Circle) {
        const g = c.Circle();
        circle = { center: P(g.Location()), radius: g.Radius(), axis: P(g.Axis().Direction()) };
      }
      return { length, kind, circle, start: P(c.Value(u0)), end: P(c.Value(u1)) };
    } catch { return null; }
  }

  // ---------- STEP export ----------

  /**
   * STEP (AP214) of the given meshes, or of the whole file when `which` is null.
   * Whole files keep their assembly, names and colours; a subset becomes one
   * assembly of the chosen parts with their names and colours.
   */
  writeStep(which: number[] | null, names: string[] = [], colors: (V3 | null)[] = []): Uint8Array {
    const oc = this.oc;
    const path = `/out${++this.seq}.stp`;
    const progress = () => new oc.Message_ProgressRange_1();
    const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
    try {
      if (!which && this.doc) {
        const w = new oc.STEPCAFControl_Writer_1();
        w.SetColorMode(true);
        w.SetNameMode(true);
        if (!w.Transfer_1(this.doc, mode, null, progress())) throw new Error("STEP transfer failed");
        if (w.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("STEP write failed");
      } else {
        const list = which ?? this.meshes.map((_, i) => i);
        if (!this.root && !list.length) throw new Error("Nothing to export");
        const doc = new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2("XmlXCAF", false)));
        oc.XCAFDoc_DocumentTool.SetLengthUnit_2(doc, 1, oc.UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter);
        const main = doc.get().Main();
        const st = oc.XCAFDoc_DocumentTool.ShapeTool(main).get();
        const ct = oc.XCAFDoc_DocumentTool.ColorTool(main).get();
        const shapes = !which && this.root && !this.meshes.length ? [{ shape: this.root, name: "", color: null }]
          : list.map((i, k) => ({ shape: this.meshes[i].shape, name: names[k] ?? this.meshes[i].name, color: colors[k] ?? this.meshes[i].color }));
        for (const s of shapes) {
          const l = st.AddShape(s.shape, false, true);
          if (s.name) oc.TDataStd_Name.Set_1(l, new oc.TCollection_ExtendedString_2(s.name, true));
          if (s.color) ct.SetColor_2(l, new oc.Quantity_Color_3(s.color[0], s.color[1], s.color[2], oc.Quantity_TypeOfColor.Quantity_TOC_RGB), oc.XCAFDoc_ColorType.XCAFDoc_ColorGen);
        }
        const w = new oc.STEPCAFControl_Writer_1();
        w.SetColorMode(true);
        w.SetNameMode(true);
        if (!w.Transfer_1(doc, mode, null, progress())) throw new Error("STEP transfer failed");
        if (w.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("STEP write failed");
      }
      return oc.FS.readFile(path) as Uint8Array;
    } finally {
      try { oc.FS.unlink(path); } catch { /* not written */ }
    }
  }

  /**
   * A PCB board as a solid: the outline loops (the first is the outside, the rest
   * cut-outs, x/y pairs) extruded from z0 by `thickness`, with drilled holes ([x, y, Ø]) as true cylinders.
   */
  /**
   * STEP of an assembly (AT-P4-6): one shared product per part, placed by each component's
   * transform (3×4 row-major), with the assembly, part and instance names and part colours.
   */
  writeAssemblyStep(name: string, parts: { key: string; shape: any; name: string; color: V3 | null }[], comps: { part: string; name: string; tf: number[] }[]): Uint8Array {
    const oc = this.oc;
    const doc = new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2("XmlXCAF", false)));
    oc.XCAFDoc_DocumentTool.SetLengthUnit_2(doc, 1, oc.UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter);
    const main = doc.get().Main();
    const st = oc.XCAFDoc_DocumentTool.ShapeTool(main).get();
    const ct = oc.XCAFDoc_DocumentTool.ColorTool(main).get();
    const setName = (l: any, n: string) => oc.TDataStd_Name.Set_1(l, new oc.TCollection_ExtendedString_2(n, true));
    const labels = new Map<string, any>();
    for (const p of parts) {
      const l = st.AddShape(p.shape, false, true);
      setName(l, p.name);
      if (p.color) ct.SetColor_2(l, new oc.Quantity_Color_3(p.color[0], p.color[1], p.color[2], oc.Quantity_TypeOfColor.Quantity_TOC_RGB), oc.XCAFDoc_ColorType.XCAFDoc_ColorGen);
      labels.set(p.key, l);
    }
    const root = st.NewShape();
    setName(root, name);
    for (const c of comps) {
      const l = labels.get(c.part);
      if (!l) continue;
      const t = new oc.gp_Trsf_1();
      t.SetValues(c.tf[0], c.tf[1], c.tf[2], c.tf[3], c.tf[4], c.tf[5], c.tf[6], c.tf[7], c.tf[8], c.tf[9], c.tf[10], c.tf[11]);
      setName(st.AddComponent_1(root, l, new oc.TopLoc_Location_2(t)), c.name);
    }
    st.UpdateAssemblies();
    return this.stepOfDoc(doc);
  }

  /** STEP of an XCAF document built elsewhere (a converted SolidWorks model). */
  stepOfDoc(doc: any): Uint8Array {
    const oc = this.oc;
    const path = `/out${++this.seq}.stp`;
    try {
      const w = new oc.STEPCAFControl_Writer_1();
      w.SetColorMode(true);
      w.SetNameMode(true);
      if (!w.Transfer_1(doc, oc.STEPControl_StepModelType.STEPControl_AsIs, null, new oc.Message_ProgressRange_1())) throw new Error("STEP transfer failed");
      if (w.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("STEP write failed");
      return (oc.FS.readFile(path) as Uint8Array).slice();
    } finally {
      try { oc.FS.unlink(path); } catch { /* not written */ }
    }
  }

  /** The raw OpenCASCADE module, for converters that build their own shapes. */
  get module() { return this.oc; }

  boardStep(loops: number[][], holes: [number, number, number][], z0: number, thickness: number, name: string): Uint8Array {
    const oc = this.oc;
    const wireOf = (pts: number[], ccw: boolean) => {
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      const xy: [number, number][] = [];
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const last = xy[xy.length - 1];
        if (!last || Math.hypot(pts[k] - last[0], pts[k + 1] - last[1]) > 1e-6) xy.push([pts[k], pts[k + 1]]);
      }
      if (xy.length > 1 && Math.hypot(xy[0][0] - xy[xy.length - 1][0], xy[0][1] - xy[xy.length - 1][1]) <= 1e-6) xy.pop();
      if (xy.length < 3) throw new Error("Board outline has fewer than 3 points");
      let a = 0;
      for (let k = 0; k < xy.length; k++) { const p = xy[k], q = xy[(k + 1) % xy.length]; a += p[0] * q[1] - q[0] * p[1]; }
      if ((a > 0) !== ccw) xy.reverse();
      for (const [x, y] of xy) poly.Add_1(new oc.gp_Pnt_3(x, y, z0));
      poly.Close();
      return poly.Wire();
    };
    const circleWire = (x: number, y: number, r: number) => {
      const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(x, y, z0), new oc.gp_Dir_4(0, 0, 1));
      const e = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, r)).Edge();
      return new oc.BRepBuilderAPI_MakeWire_2(e).Wire();
    };
    const mk = new oc.BRepBuilderAPI_MakeFace_15(wireOf(loops[0], true), true);
    for (const l of loops.slice(1)) mk.Add(wireOf(l, false));
    for (const [x, y, d] of holes) mk.Add(oc.TopoDS.Wire_1(circleWire(x, y, d / 2).Reversed()));
    let face = mk.Face();
    const fix = new oc.ShapeFix_Face_2(face);
    fix.Perform();
    face = fix.Face();
    const solid = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, thickness), false, true).Shape();
    const k = this.meshes.length;
    this.meshes.push({ shape: solid, faces: [], name, color: [0.13, 0.42, 0.22], solid: true });
    try { return this.writeStep([k], [name]); } finally { this.meshes.pop(); }
  }

  dispose() {
    this.meshes = [];
    this.doc = null;
    this.shapeTool = null;
    this.colorTool = null;
    this.root = null;
  }
}
