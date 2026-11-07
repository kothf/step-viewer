// Assemblies in the kernel worker (FRS 10, FR-ARC-016): each distinct part is evaluated once by its
// own Modeller (which keeps its feature cache) and meshed once; components place it by a location
// (shared geometry, no copy) and the mesh by transforming its vertices.
import { Modeller, type ModelMesh, type Named } from "./model";
import type { AsmComponentStatus, AsmDoc, Tf } from "../asm/types";
import type { BodyProps, V3 } from "../model/types";

interface Source { json: string; modeller: Modeller; body: Named | null; error?: string; mesh?: ModelMesh; quality?: number }

export interface Placed { id: string; name: string; part: string; tf: Tf; body: Named; mesh: () => ModelMesh }

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
      const body: Named = { shape: s.body.shape.Moved(loc, false), faces: s.body.faces.map(f => f.Moved(loc, false)), names: s.body.names };
      const src = s;
      placed.push({
        id: c.id, name: c.name, part: c.part, tf: t, body,
        mesh: () => {
          if (!src.mesh || src.quality !== quality) { src.mesh = src.modeller.mesh(src.body!, doc.parts[c.part].name, [0.72, 0.74, 0.78], quality); src.quality = quality; }
          return transformMesh(src.mesh, t, c.name);
        },
      });
    }
    return { placed, statuses };
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
      if (volume < 1e-6) {
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
export function transformMesh(m: ModelMesh, t: Tf, name: string): ModelMesh {
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
