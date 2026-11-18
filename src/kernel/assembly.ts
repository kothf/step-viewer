// Assemblies in the kernel worker (FRS 10, FR-ARC-016): each distinct part is evaluated once by its
// own Modeller (which keeps its feature cache) and meshed once; components place it by a location
// (shared geometry, no copy) and the mesh by transforming its vertices.
import { Modeller, type ModelMesh, type Named } from "./model";
import type { AsmComponentStatus, AsmDoc, AsmFeature, Tf } from "../asm/types";
import type { BodyProps, V3 } from "../model/types";
import type { OwnBody } from "../tools/inertia";

interface Source { json: string; modeller: Modeller; body: Named | null; error?: string; mesh?: ModelMesh; quality?: number; own?: OwnBody[] | null }

/** `src` is the evaluated source (same object while the part is unchanged), so callers can share work between its instances. */
export interface Placed { id: string; name: string; part: string; tf: Tf; body: Named; src: object; mesh: () => ModelMesh }

export class Assembler {
  private sources = new Map<string, Source>();
  constructor(private oc: any) {}

  /** The evaluated body of a part source (cached while its document is unchanged). */
  private source(key: string, doc: AsmDoc): Source {
    const p = doc.parts[key];
    const json = JSON.stringify(p.doc);
    let s = this.sources.get(key);
    if (s && s.json === json) return s;
    const modeller = s?.modeller ?? new Modeller(this.oc);
    s = { json, modeller, body: null };
    try {
      const r = modeller.evaluate(p.doc);
      const bad = r.statuses.find(x => !x.ok && x.code !== "suppressed");
      s.body = r.body;
      if (!r.body) s.error = bad?.message ?? "The part has no body.";
    } catch (err) { s.error = (err as Error).message; }
    this.sources.set(key, s);
    return s;
  }

  /** Evaluates a part source now (parallel builds: the worker takes its share before the assembly call). */
  prime(key: string, doc: AsmDoc, quality: number): { src: object; body: Named | null; mesh: () => ModelMesh } {
    const s = this.source(key, doc);
    return {
      src: s, body: s.body,
      mesh: () => {
        if (!s.mesh || s.quality !== quality) { s.mesh = s.modeller.mesh(s.body!, doc.parts[key].name, [0.72, 0.74, 0.78], quality); s.quality = quality; }
        return s.mesh;
      },
    };
  }

  /**
   * Takes a part source another kernel worker evaluated (FR-ARC-016, parallel builds): the body
   * comes as BREP text with its face order, so no feature is evaluated here. Returns the source.
   */
  adopt(key: string, doc: AsmDoc, pre: { brep?: string; order?: number[]; names?: string[]; error?: string }): object {
    const json = JSON.stringify(doc.parts[key].doc);
    const s: Source = { json, modeller: this.sources.get(key)?.modeller ?? new Modeller(this.oc), body: null };
    if (pre.brep && pre.order && pre.names) s.body = s.modeller.fromTransport(pre.brep, pre.order, pre.names);
    else s.error = pre.error ?? "The part has no body.";
    this.sources.set(key, s);
    return s;
  }

  /**
   * The bodies of a part source with their mass properties in part coordinates, when one of them has
   * its own material (FR-MAT-001); null otherwise. `src` is a `Placed.src`.
   */
  ownBodies(key: string, doc: AsmDoc, src: object): OwnBody[] | null {
    const s = this.sources.get(key), pd = doc.parts[key]?.doc;
    if (!s || s !== src || !s.body || !pd || !Object.values(pd.bodies ?? {}).some(b => b.material)) return null;
    if (s.own === undefined) {
      try { s.own = s.modeller.bodyInfo(s.body, pd).map(b => ({ key: b.key, volume: b.volume, ...s.modeller.bodyMass(b.part) })); }
      catch { s.own = null; }
    }
    return s.own;
  }

  /**
   * Each solid's material name (TopExp order) of a part source whose bodies have their own material
   * (FR-MAT-001): the body's, else the part's. Null when no body has one, or `src` is not the source.
   */
  bodyMats(key: string, doc: AsmDoc, src: object): (string | null)[] | null {
    const s = this.sources.get(key), pd = doc.parts[key]?.doc;
    if (!s || s !== src || !s.body || !pd || !Object.values(pd.bodies ?? {}).some(b => b.material)) return null;
    try { return s.modeller.bodyInfo(s.body, pd).map(b => pd.bodies?.[b.key]?.material?.name ?? pd.material?.name ?? null); }
    catch { return null; }
  }

  /** A built part's body as BREP text with its face order (`Modeller.toTransport`), for the disk cache; null when it has none. */
  transport(key: string): { brep: string; order: number[] } | null {
    const s = this.sources.get(key);
    try { return s?.body ? s.modeller.toTransport(s.body) : null; } catch { return null; }
  }

  /** A part's evaluated body in its own coordinates (null when it has none). */
  sourceBody(key: string, doc: AsmDoc): Named | null { return this.source(key, doc).body; }

  /** Places every shown, unsuppressed component. */
  evaluate(doc: AsmDoc, quality = 1): { placed: Placed[]; statuses: AsmComponentStatus[] } {
    const oc = this.oc;
    for (const k of [...this.sources.keys()]) if (!doc.parts[k]) this.sources.delete(k);
    const placed: Placed[] = [], statuses: AsmComponentStatus[] = [];
    for (const c of doc.components) {
      if (c.suppressed) { statuses.push({ id: c.id, ok: true }); continue; }
      const s = this.source(c.part, doc);
      if (!s.body) { statuses.push({ id: c.id, ok: false, message: s.error }); continue; }
      statuses.push({ id: c.id, ok: true });
      const t = c.tf;
      const trsf = new oc.gp_Trsf_1();
      trsf.SetValues(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11]);
      const loc = new oc.TopLoc_Location_2(trsf);
      // Moved() gives a TopoDS_Shape: faces must stay TopoDS_Face, or the exact patch (BRepAdaptor_Surface) rejects every one.
      const body: Named = { shape: s.body.shape.Moved(loc, false), faces: s.body.faces.map(f => oc.TopoDS.Face_1(f.Moved(loc, false))), names: s.body.names };
      const src = s;
      placed.push({
        id: c.id, name: c.name, part: c.part, tf: t, body, src,
        mesh: () => {
          if (!src.mesh || src.quality !== quality) { src.mesh = src.modeller.mesh(src.body!, doc.parts[c.part].name, [0.72, 0.74, 0.78], quality); src.quality = quality; }
          return transformMesh(src.mesh, t, c.name);
        },
      });
    }
    this.applyFeatures(doc, placed, quality);
    return { placed, statuses };
  }

  /** Feature statuses of the last evaluation: a feature that cut nothing or failed has a message. */
  featureStatus: { id: string; ok: boolean; cut: string[]; message?: string }[] = [];

  /**
   * Assembly features (FR-ASM-027): each tool solid (a cylinder or box from the start face into the
   * material) is cut from the placed components it reaches. Cut components get their own world mesh.
   */
  private applyFeatures(doc: AsmDoc, placed: Placed[], quality: number) {
    const oc = this.oc;
    this.featureStatus = [];
    const feats = (doc.features ?? []).filter(f => !f.suppressed);
    if (!feats.length || !placed.length) return;
    const all = new oc.Bnd_Box_1();
    for (const p of placed) oc.BRepBndLib.Add(p.body.shape, all, false);
    const lo = all.CornerMin(), hi = all.CornerMax();
    const big = 2 * Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()) + 10;
    const m = new Modeller(oc);
    const cutIds = new Set<string>();
    for (const f of feats) {
      const st = { id: f.id, ok: true, cut: [] as string[], message: undefined as string | undefined };
      this.featureStatus.push(st);
      const owner = doc.components.find(c => c.id === f.ref.comp);
      if (!owner) { st.ok = false; st.message = "The component it starts on is gone."; continue; }
      const tool = this.toolOf(f, owner.tf, big);
      if (!tool) { st.ok = false; st.message = "The size must be more than 0."; continue; }
      const tb = new oc.Bnd_Box_1();
      oc.BRepBndLib.Add(tool, tb, false);
      for (const p of placed) {
        if (f.comps && !f.comps.includes(p.id)) continue;
        const pb = new oc.Bnd_Box_1();
        oc.BRepBndLib.Add(p.body.shape, pb, false);
        if (pb.IsOut_4(tb)) continue;
        try {
          const before = m.props(p.body).volume;
          const body = m.cutBy(p.body, tool, f.id);
          if (Math.abs(m.props(body).volume - before) < 1e-9 * Math.max(1, before)) continue;
          p.body = body;
          st.cut.push(p.id);
          cutIds.add(p.id);
        } catch (err) { st.ok = false; st.message = (err as Error).message; }
      }
      if (st.ok && !st.cut.length) { st.ok = false; st.message = "The feature does not cut any component."; }
    }
    for (const p of placed) {
      if (!cutIds.has(p.id)) continue;
      // Its own geometry now: meshed in place, not shared with the part's other instances.
      p.src = {};
      p.tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
      const name = p.name, body = p.body;
      let mesh: ModelMesh | null = null;
      p.mesh = () => (mesh ??= m.mesh(body, name, [0.72, 0.74, 0.78], quality));
    }
  }

  /** The tool solid of a feature in world coordinates (null for a zero size). */
  private toolOf(f: AsmFeature, tf: Tf, big: number): any {
    const oc = this.oc;
    const P = (v: number[]) => [tf[0] * v[0] + tf[1] * v[1] + tf[2] * v[2] + tf[3], tf[4] * v[0] + tf[5] * v[1] + tf[6] * v[2] + tf[7], tf[8] * v[0] + tf[9] * v[1] + tf[10] * v[2] + tf[11]];
    const D = (v: number[]) => { const w = [tf[0] * v[0] + tf[1] * v[1] + tf[2] * v[2], tf[4] * v[0] + tf[5] * v[1] + tf[6] * v[2], tf[8] * v[0] + tf[9] * v[1] + tf[10] * v[2]]; const l = Math.hypot(w[0], w[1], w[2]) || 1; return w.map(q => q / l); };
    const at = P(f.at), n = D(f.n);
    let x = D(f.x);
    const k = x[0] * n[0] + x[1] * n[1] + x[2] * n[2];
    x = [x[0] - k * n[0], x[1] - k * n[1], x[2] - k * n[2]];
    const xl = Math.hypot(x[0], x[1], x[2]);
    if (xl < 1e-9) return null;
    x = x.map(q => q / xl);
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    // From a hair above the face down to the depth (or through everything).
    const up = 1e-3, H = (f.depth ?? big) + up;
    const pnt = (v: number[]) => new oc.gp_Pnt_3(v[0], v[1], v[2]), dir = (v: number[]) => new oc.gp_Dir_4(v[0], v[1], v[2]);
    const base = [0, 1, 2].map(i => at[i] + n[i] * up - n[i] * H);
    if (f.type === "hole") {
      if (!(f.dia! > 0)) return null;
      return new oc.BRepPrimAPI_MakeCylinder_3(new oc.gp_Ax2_2(pnt(base), dir(n), dir(x)), f.dia! / 2, H).Shape();
    }
    if (!(f.w! > 0 && f.h! > 0)) return null;
    const o = [0, 1, 2].map(i => base[i] - x[i] * f.w! / 2 - y[i] * f.h! / 2);
    return new oc.BRepPrimAPI_MakeBox_5(new oc.gp_Ax2_2(pnt(o), dir(n), dir(x)), f.w!, f.h!, H).Shape();
  }

  /** Mass properties of the placed components together (density 1). */
  /**
   * Interference detection (FR-ASM-020): each pair of components whose boxes overlap is intersected;
   * pairs that share volume come back with it and the overlap's triangles (world positions) to show.
   * Touching faces are not interference unless `touch` is set (they then count with volume 0).
   */
  interference(placed: Placed[], touch = false): { a: string; b: string; volume: number; position: number[] }[] {
    const oc = this.oc;
    const boxes = placed.map(p => { const b = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(p.body.shape, b, false); return b; });
    const m = new Modeller(oc);
    const out: { a: string; b: string; volume: number; position: number[] }[] = [];
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      if (boxes[i].IsOut_4(boxes[j])) continue;
      const pr = new oc.Message_ProgressRange_1();
      const mk = new oc.BRepAlgoAPI_Common_3(placed[i].body.shape, placed[j].body.shape, pr);
      if (!mk.IsDone() || mk.HasErrors()) continue;
      const shape = mk.Shape();
      const gp = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(shape, gp, true, false, false);
      const volume = gp.Mass();
      const faces: any[] = [];
      const map = new oc.TopTools_IndexedMapOfShape_1();
      oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
      for (let k = 1; k <= map.Extent(); k++) faces.push(oc.TopoDS.Face_1(map.FindKey(k)));
      // Coincident faces (a pin in a bore of its own size, a foot on the plate) leave a sliver of round-off
      // volume; one thinner than 1e-4 mm on average (2·V / area) is touching, not interference (exam #83).
      let sliver = volume < 1e-6;
      if (!sliver && volume < 1) {
        const sp = new oc.GProp_GProps_1();
        oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
        sliver = sp.Mass() > 0 && (2 * volume) / sp.Mass() < 1e-4;
      }
      if (sliver) {
        if (!touch) continue;
        const dist = new oc.BRepExtrema_DistShapeShape_2(placed[i].body.shape, placed[j].body.shape, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
        if (!dist.IsDone() || dist.Value() > 1e-6) continue;
        out.push({ a: placed[i].id, b: placed[j].id, volume: 0, position: [] });
        continue;
      }
      const position: number[] = [];
      if (faces.length) {
        const mesh = m.mesh({ shape, faces, names: faces.map(() => "") }, "overlap", [1, 0, 0], 1);
        const P = mesh.attributes.position.array, I = mesh.index.array;
        for (const v of I) position.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
      out.push({ a: placed[i].id, b: placed[j].id, volume: Math.max(0, volume), position });
    }
    return out;
  }

  /**
   * Clearance check (FR-ASM-021): pairs of components closer than `min` (mm) without overlapping, with
   * the distance and the two nearest points. Boxes grown by `min` skip pairs that are clearly far apart.
   */
  clearance(placed: Placed[], min: number): { a: string; b: string; distance: number; p1: V3; p2: V3 }[] {
    const oc = this.oc;
    const boxes = placed.map(p => { const b = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(p.body.shape, b, false); b.Enlarge(min / 2); return b; });
    const out: { a: string; b: string; distance: number; p1: V3; p2: V3 }[] = [];
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      if (boxes[i].IsOut_4(boxes[j])) continue;
      const dist = new oc.BRepExtrema_DistShapeShape_2(placed[i].body.shape, placed[j].body.shape, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
      if (!dist.IsDone() || dist.NbSolution() < 1) continue;
      const d = dist.Value();
      if (d >= min) continue;
      const a = dist.PointOnShape1(1), b = dist.PointOnShape2(1);
      out.push({ a: placed[i].id, b: placed[j].id, distance: d, p1: [a.X(), a.Y(), a.Z()], p2: [b.X(), b.Y(), b.Z()] });
    }
    return out.sort((x, y) => x.distance - y.distance);
  }

  props(placed: Placed[]): BodyProps | null {
    if (!placed.length) return null;
    const m = new Modeller(this.oc);
    let V = 0, A = 0, n = 0;
    const c: V3 = [0, 0, 0];
    for (const p of placed) {
      const q = m.props(p.body);
      V += q.volume; A += q.area; n += q.bodies ?? 1;
      for (let k = 0; k < 3; k++) c[k] += q.com[k] * q.volume;
    }
    return { volume: V, area: A, com: V ? (c.map(x => x / V) as V3) : [0, 0, 0], bodies: n };
  }
}

/** A part's mesh moved by a component's transform (positions and normals). */
function transformMesh(m: ModelMesh, t: Tf, name: string): ModelMesh {
  const P = m.attributes.position.array, N = m.attributes.normal.array;
  const pos = new Array<number>(P.length), nrm = new Array<number>(N.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    pos[i] = t[0] * x + t[1] * y + t[2] * z + t[3];
    pos[i + 1] = t[4] * x + t[5] * y + t[6] * z + t[7];
    pos[i + 2] = t[8] * x + t[9] * y + t[10] * z + t[11];
    const a = N[i], b = N[i + 1], d = N[i + 2];
    nrm[i] = t[0] * a + t[1] * b + t[2] * d;
    nrm[i + 1] = t[4] * a + t[5] * b + t[6] * d;
    nrm[i + 2] = t[8] * a + t[9] * b + t[10] * d;
  }
  return { ...m, name, brep_faces: m.brep_faces.map(f => ({ ...f })), attributes: { position: { array: pos }, normal: { array: nrm } }, index: { array: m.index.array } };
}
