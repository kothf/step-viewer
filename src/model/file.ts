// MöbiusCAD part files (.mcadprt, FRS 12.1): a ZIP with manifest.json,
// document.json (the feature history) and an optional thumbnail. Plus the
// autosave journal in the browser, for crash recovery (FR-STO-003).
import { SCHEMA, type PartDoc } from "./types";
import { unzipLimited, zip } from "./zip";
import { FEATURE_TYPES } from "./doc";

export const PART_EXT = ".mcadprt";
export const FORMAT = "mobiuscad";

export interface Manifest { format: string; schema: number; kind: "part" | "assembly" | "drawing"; app: string; created?: string; modified: string; units: string }

/** Stable key order, two-space indent: files diff well in git (FR-IO-004). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
export const toJson = (v: unknown) => `${JSON.stringify(stable(v), null, 2)}\n`;

export async function packPart(doc: PartDoc, app: string, thumbnail?: Uint8Array): Promise<Uint8Array> {
  const manifest: Manifest = { format: FORMAT, schema: SCHEMA, kind: "part", app, modified: new Date().toISOString(), units: doc.units.length };
  const files: { name: string; data: Uint8Array | string }[] = [
    { name: "manifest.json", data: toJson(manifest) },
    { name: "document.json", data: toJson(doc) },
  ];
  if (thumbnail) files.push({ name: "thumbnail.png", data: thumbnail });
  return zip(files);
}

export class FileError extends Error {}

/** Older schemas are migrated here, one step at a time (FR-IO-030). */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {};

export async function unpackPart(buf: ArrayBuffer): Promise<PartDoc> {
  const files = await unzipLimited(buf, 512 * 1024 ** 2);
  const dec = new TextDecoder();
  const mf = files.get("manifest.json"), dj = files.get("document.json");
  if (!mf || !dj) throw new FileError("Not a MöbiusCAD file: manifest or document missing.");
  const manifest = JSON.parse(dec.decode(mf)) as Manifest;
  if (manifest.format !== FORMAT) throw new FileError("Not a MöbiusCAD file.");
  if (manifest.kind !== "part") throw new FileError("Only part files can be opened in this version.");
  if (manifest.schema > SCHEMA) throw new FileError(`This file was made by a newer MöbiusCAD (schema ${manifest.schema}). Update the app to open it.`);
  let doc = JSON.parse(dec.decode(dj)) as Record<string, unknown>;
  for (let s = Number(doc.schema ?? 1); s < SCHEMA; s++) doc = MIGRATIONS[s](doc);
  return validate(doc);
}

/** Checks the shape of a document read from a file or the journal. */
export function validate(d: Record<string, unknown>): PartDoc {
  if (d.kind !== "part" || !Array.isArray(d.features)) throw new FileError("The document is damaged.");
  const doc = d as unknown as PartDoc;
  doc.units ??= { length: "mm", decimals: 2 };
  doc.props ??= {};
  doc.rollback ??= null;
  const known = new Set(FEATURE_TYPES);
  for (const f of doc.features) if (!known.has(f.type)) throw new FileError(`Unknown feature type "${f.type}". Update the app to open this file.`);
  return doc;
}

// ---------- autosave journal ----------

const JOURNAL = "mcad:journal";

export interface JournalEntry { doc: PartDoc; at: string; fileName: string }

export function journalSave(doc: PartDoc, fileName: string) {
  try { localStorage.setItem(`${JOURNAL}:${doc.id}`, JSON.stringify({ doc, at: new Date().toISOString(), fileName })); } catch { /* full or private */ }
}
export function journalDrop(id: string) {
  try { localStorage.removeItem(`${JOURNAL}:${id}`); } catch { /* private mode */ }
}
export function journalList(): JournalEntry[] {
  const out: JournalEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${JOURNAL}:`)) continue;
      try { const e = JSON.parse(localStorage.getItem(k)!) as JournalEntry; e.doc = validate(e.doc as unknown as Record<string, unknown>); out.push(e); }
      catch { localStorage.removeItem(k); }
    }
  } catch { /* private mode */ }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
