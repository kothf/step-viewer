// SLDPRT/SLDASM files to STEP, inside the kernel worker: each part's Parasolid
// model becomes OCCT solids (parasolid.ts), an assembly places its parts from
// its component tree, and the result is written as one STEP file that the
// viewer then opens like any other (so every tool works on it).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ParasolidBuilder, type PsModel } from "./parasolid";
import { parseComponentTree, readSolidWorks, type SolidWorksFile, type SwComponent } from "../sw/container";
import type { ParasolidReader } from "../sw/parasolid";

export interface SwInput { name: string; bytes: Uint8Array }

export interface SwReport {
  /** Parts placed (assembly) or 1. */
  parts: number;
  bodies: number;
  faces: number;
  /** Faces that could not be rebuilt and were left out. */
  failedFaces: number;
  /** Part files the assembly needs that were not given. */
  missing: string[];
  /** Parts that had no readable geometry. */
  empty: string[];
  notes: string[];
  /** The file's own thumbnail (PNG), for when nothing could be read. */
  preview: Uint8Array | null;
  kind: "part" | "assembly";
}

interface PartShapes { bodies: { shape: any; color: [number, number, number] | null }[]; label: any | null }

export async function solidworksToStep(oc: any, reader: ParasolidReader, inputs: SwInput[], mainName: string, writeDoc: (doc: any) => Uint8Array): Promise<{ bytes: Uint8Array | null; report: SwReport }> {
  const byName = new Map<string, SwInput>();
  for (const f of inputs) byName.set(baseName(f.name).toLowerCase(), f);
  const main = byName.get(baseName(mainName).toLowerCase()) ?? inputs[0];
  const report: SwReport = { parts: 0, bodies: 0, faces: 0, failedFaces: 0, missing: [], empty: [], notes: [], preview: null, kind: "part" };

  const read = new Map<string, Promise<SolidWorksFile>>();
  const swFile = (f: SwInput) => {
    const k = baseName(f.name).toLowerCase();
    let p = read.get(k);
    if (!p) { p = readSolidWorks(f.bytes, f.name); read.set(k, p); }
    return p;
  };

  const top = await swFile(main);
  report.preview = top.preview;
  report.kind = top.kind;

  const doc = new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2("XmlXCAF", false)));
  oc.XCAFDoc_DocumentTool.SetLengthUnit_2(doc, 1, oc.UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter);
  const docMain = doc.get().Main();
  const st = oc.XCAFDoc_DocumentTool.ShapeTool(docMain).get();
  const ct = oc.XCAFDoc_DocumentTool.ColorTool(docMain).get();
  const setName = (label: any, name: string) => oc.TDataStd_Name.Set_1(label, new oc.TCollection_ExtendedString_2(name, true));
  const setColor = (label: any, c: [number, number, number]) =>
    ct.SetColor_2(label, new oc.Quantity_Color_3(c[0], c[1], c[2], oc.Quantity_TypeOfColor.Quantity_TOC_RGB), oc.XCAFDoc_ColorType.XCAFDoc_ColorGen);

  /** A part's bodies as OCCT shapes. */
  const partShapes = (sw: SolidWorksFile): PartShapes => {
    const models: PsModel[] = [];
    const parse = (data: Uint8Array) => {
      const m = reader.parse(data);
      if (!m.ok) report.notes.push(`${sw.name}: ${m.error}`);
      return m;
    };
    // The partition holds the part as last rebuilt (configuration 0); bodies kept elsewhere are the fallback.
    const first = sw.partitions[0];
    if (first) { const m = reader.parse(first.data); if (m.ok && m.faces.length) models.push(m); else if (!m.ok && !/missing_body/.test(m.error ?? "")) report.notes.push(`${sw.name}: ${m.error}`); }
    if (!models.length) for (const b of sw.bodies) { const m = parse(b); if (m.ok && m.faces.length) models.push(m); }
    const bodies: PartShapes["bodies"] = [];
    for (const m of models) {
      const b = new ParasolidBuilder(oc, m);
      for (const body of b.build()) {
        bodies.push({ shape: body.shape, color: body.color });
        report.bodies++;
        report.faces += body.faces;
        report.failedFaces += body.failed;
      }
      for (const n of b.notes.slice(0, 5)) report.notes.push(`${sw.name}: ${n}`);
    }
    if (!bodies.length) report.empty.push(sw.name);
    return { bodies, label: null };
  };

  /** The XCAF label of a part (one body: the solid; several: a sub-assembly of bodies). */
  const partLabel = (sw: SolidWorksFile, shapes: PartShapes, name: string) => {
    if (shapes.label) return shapes.label;
    if (!shapes.bodies.length) return null;
    let label: any;
    if (shapes.bodies.length === 1) {
      label = st.AddShape(shapes.bodies[0].shape, false, true);
      if (shapes.bodies[0].color) setColor(label, shapes.bodies[0].color);
    } else {
      label = st.NewShape();
      shapes.bodies.forEach((b, i) => {
        const bl = st.AddShape(b.shape, false, true);
        setName(bl, `${name} body ${i + 1}`);
        if (b.color) setColor(bl, b.color);
        setName(st.AddComponent_1(label, bl, new oc.TopLoc_Location_1()), `${name} body ${i + 1}`);
      });
    }
    setName(label, name);
    shapes.label = label;
    return label;
  };

  if (top.kind === "part") {
    report.parts = 1;
    const name = stripExt(baseName(top.name));
    partLabel(top, partShapes(top), name);
  } else {
    if (!top.tree) throw new Error("This assembly has no component list");
    const tree = parseComponentTree(top.tree);
    const cache = new Map<string, { sw: SolidWorksFile; shapes: PartShapes } | null>();
    const loadPart = async (file: string) => {
      const k = file.toLowerCase();
      if (cache.has(k)) return cache.get(k)!;
      const f = byName.get(k);
      let v: { sw: SolidWorksFile; shapes: PartShapes } | null = null;
      if (f) {
        try { const sw = await swFile(f); v = { sw, shapes: sw.kind === "part" ? partShapes(sw) : { bodies: [], label: null } }; }
        catch (err) { report.notes.push(`${file}: ${(err as Error).message}`); }
      } else if (!report.missing.includes(file)) report.missing.push(file);
      cache.set(k, v);
      return v;
    };
    const place = async (parent: any, comps: SwComponent[], depth: number) => {
      for (const c of comps) {
        if (c.suppressed || depth > 16) continue;
        let label: any = null;
        if (c.children.length || /\.sldasm$/i.test(c.file)) {
          label = st.NewShape();
          setName(label, stripExt(c.file) || c.name);
          await place(label, c.children, depth + 1);
        } else {
          const p = await loadPart(c.file);
          if (p) label = partLabel(p.sw, p.shapes, stripExt(c.file));
          if (label) report.parts++;
        }
        if (!label) continue;
        const comp = st.AddComponent_1(parent, label, location(oc, c.matrix));
        setName(comp, c.name);
      }
    };
    const root = st.NewShape();
    setName(root, tree.name || stripExt(baseName(top.name)));
    await place(root, tree.components, 0);
  }
  st.UpdateAssemblies();
  if (!report.bodies) return { bytes: null, report };
  return { bytes: writeDoc(doc), report };
}

function location(oc: any, m: number[] | null) {
  if (!m) return new oc.TopLoc_Location_1();
  const t = new oc.gp_Trsf_1();
  // Column-major 4x4 to OCCT's 3x4 rows.
  t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  return new oc.TopLoc_Location_2(t);
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stripExt = (n: string) => n.replace(/\.(sldprt|sldasm)$/i, "");
