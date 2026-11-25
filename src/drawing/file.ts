// MöbiusCAD drawing files (.mcaddrw, FRS 12.1): a ZIP with manifest.json,
// drawing.json and, for a drawing of a STEP / IGES / BREP file, that file under
// model/. A part's document is kept inside drawing.json, so the file opens alone.
import { FORMAT, toJson, type Manifest } from "../model/file";
import { validFormat } from "./formats";
import { unzipLimited, zip } from "../model/zip";
import type { DrawingDoc } from "./types";
import type { Projection } from "../kernel/drawing";

export const DRAWING_EXT = ".mcaddrw";
export const isDrawingName = (n: string) => n.toLowerCase().endsWith(DRAWING_EXT);

/**
 * The lines each view was last drawn with (`views.json`, by view id: the view direction and its exact projection),
 * shown while the next open projects the views again. Older versions ignore the entry.
 */
export type SavedViews = Record<string, { dir: string; proj: Projection }>;
const VIEWS_FILE = "views.json";

export async function packDrawing(doc: DrawingDoc, app: string, model?: Uint8Array, views?: string | null): Promise<Uint8Array> {
  const manifest: Manifest = { format: FORMAT, schema: 1, kind: "drawing", app, modified: new Date().toISOString(), units: "mm" };
  const files: { name: string; data: Uint8Array | string }[] = [
    { name: "manifest.json", data: toJson(manifest) },
    { name: "drawing.json", data: toJson(doc) },
  ];
  if (doc.source.kind === "file" && model) files.push({ name: `model/${doc.source.name.replace(/[\\/]/g, "_")}`, data: model });
  if (views) files.push({ name: VIEWS_FILE, data: views });
  return zip(files);
}

export async function unpackDrawing(buf: ArrayBuffer): Promise<{ doc: DrawingDoc; model?: Uint8Array; views?: SavedViews }> {
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
  // A user title block (FR-DRW-004) is checked like an imported format; one that is not valid is dropped.
  for (const sh of doc.sheets) if (sh.tb) { const f = validFormat(sh.tb); if (f) sh.tb = f; else delete sh.tb; }
  const model = doc.source.kind === "file" ? files.get(`model/${doc.source.name.replace(/[\\/]/g, "_")}`) : undefined;
  if (doc.source.kind === "file" && !model) throw new Error("The drawing's model is missing from the file.");
  let views: SavedViews | undefined;
  const vj = files.get(VIEWS_FILE);
  if (vj) try { const v = JSON.parse(dec.decode(vj)) as SavedViews; if (v && typeof v === "object") views = v; } catch { /* only a speed-up */ }
  return { doc, model, views };
}

/** The views' last lines as kept in the file: exact projections of views still on a sheet, to 0.1 µm. */
export function savedViewsText(doc: DrawingDoc, shown: Map<string, { dir: string; proj: Projection }>): string | null {
  const ids = new Set(doc.sheets.flatMap(s => s.views.map(v => v.id)));
  const out: SavedViews = {};
  for (const [id, s] of shown) {
    if (!ids.has(id) || s.proj.preview) continue;
    const { cutEdges: _e, fail: _f, ...proj } = s.proj;
    out[id] = { dir: s.dir, proj: proj as Projection };
  }
  if (!Object.keys(out).length) return null;
  return JSON.stringify(out, (_k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v));
}
