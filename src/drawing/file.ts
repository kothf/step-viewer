// MöbiusCAD drawing files (.mcaddrw, FRS 12.1): a ZIP with manifest.json,
// drawing.json and, for a drawing of a STEP / IGES / BREP file, that file under
// model/. A part's document is kept inside drawing.json, so the file opens alone.
import { FORMAT, toJson, type Manifest } from "../model/file";
import { unzipLimited, zip } from "../model/zip";
import type { DrawingDoc } from "./types";

export const DRAWING_EXT = ".mcaddrw";
export const isDrawingName = (n: string) => n.toLowerCase().endsWith(DRAWING_EXT);

export async function packDrawing(doc: DrawingDoc, app: string, model?: Uint8Array): Promise<Uint8Array> {
  const manifest: Manifest = { format: FORMAT, schema: 1, kind: "drawing", app, modified: new Date().toISOString(), units: "mm" };
  const files: { name: string; data: Uint8Array | string }[] = [
    { name: "manifest.json", data: toJson(manifest) },
    { name: "drawing.json", data: toJson(doc) },
  ];
  if (doc.source.kind === "file" && model) files.push({ name: `model/${doc.source.name.replace(/[\\/]/g, "_")}`, data: model });
  return zip(files);
}

export async function unpackDrawing(buf: ArrayBuffer): Promise<{ doc: DrawingDoc; model?: Uint8Array }> {
  const files = await unzipLimited(buf, 1024 ** 3);
  const dec = new TextDecoder();
  const mf = files.get("manifest.json"), dj = files.get("drawing.json");
  if (!mf || !dj) throw new Error("Not a MöbiusCAD drawing: manifest or drawing missing.");
  const manifest = JSON.parse(dec.decode(mf)) as Manifest;
  if (manifest.format !== FORMAT || manifest.kind !== "drawing") throw new Error("Not a MöbiusCAD drawing.");
  if (manifest.schema > 1) throw new Error(`This file was made by a newer MöbiusCAD (schema ${manifest.schema}). Update the app to open it.`);
  const doc = JSON.parse(dec.decode(dj)) as DrawingDoc;
  if (doc.kind !== "drawing" || !Array.isArray(doc.sheets) || !doc.sheets.length || !doc.source) throw new Error("The document is damaged.");
  doc.props ??= {};
  const model = doc.source.kind === "file" ? files.get(`model/${doc.source.name.replace(/[\\/]/g, "_")}`) : undefined;
  if (doc.source.kind === "file" && !model) throw new Error("The drawing's model is missing from the file.");
  return { doc, model };
}
