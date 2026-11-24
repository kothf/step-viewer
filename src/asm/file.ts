// MöbiusCAD assembly files (.mcadasm): manifest.json + document.json, the parts embedded (FR-ASM-003).
import { FORMAT, FileError, toJson, validate, type Manifest } from "../model/file";
import { unzipLimited, zip } from "../model/zip";
import { SCHEMA } from "../model/types";
import type { AsmDoc } from "./types";
import { PREVIEW_FILE } from "../model/preview";

export const ASM_EXT = ".mcadasm";

export async function packAsm(doc: AsmDoc, app: string, preview?: Uint8Array | null): Promise<Uint8Array> {
  const manifest: Manifest = { format: FORMAT, schema: SCHEMA, kind: "assembly", app, modified: new Date().toISOString(), units: doc.units.length };
  const files: { name: string; data: Uint8Array | string }[] = [{ name: "manifest.json", data: toJson(manifest) }, { name: "document.json", data: toJson(doc) }];
  // The parts' display meshes (src/asm/preview.ts), drawn while the next open builds; older versions ignore them.
  if (preview) files.push({ name: PREVIEW_FILE, data: preview });
  return zip(files);
}

export async function unpackAsm(buf: ArrayBuffer): Promise<AsmDoc> {
  return (await unpackAsmFile(buf)).doc;
}

/** The document and, when the file keeps them, the parts' display meshes (`preview.bin`). */
export async function unpackAsmFile(buf: ArrayBuffer): Promise<{ doc: AsmDoc; preview: Uint8Array | null }> {
  const files = await unzipLimited(buf, 512 * 1024 ** 2);
  const dec = new TextDecoder();
  const mf = files.get("manifest.json"), dj = files.get("document.json");
  if (!mf || !dj) throw new FileError("Not a MöbiusCAD file: manifest or document missing.");
  const manifest = JSON.parse(dec.decode(mf)) as Manifest;
  if (manifest.format !== FORMAT) throw new FileError("Not a MöbiusCAD file.");
  if (manifest.kind !== "assembly") throw new FileError("This is not an assembly file.");
  if (manifest.schema > SCHEMA) throw new FileError(`This file was made by a newer MöbiusCAD (schema ${manifest.schema}). Update the app to open it.`);
  const doc = JSON.parse(dec.decode(dj)) as AsmDoc;
  if (doc.kind !== "assembly" || !Array.isArray(doc.components) || typeof doc.parts !== "object") throw new FileError("The document is damaged.");
  for (const p of Object.values(doc.parts)) validate(p.doc as unknown as Record<string, unknown>);
  for (const c of doc.components) if (!doc.parts[c.part] || !Array.isArray(c.tf) || c.tf.length !== 12) throw new FileError("The document is damaged.");
  return { doc, preview: files.get(PREVIEW_FILE) ?? null };
}
