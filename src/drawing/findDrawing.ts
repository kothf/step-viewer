// File ▸ Open drawing: the drawings that belong to the open part, assembly or model file. A drawing names its
// model in `source` (a part or assembly by document id, a model file by name), so it is found wherever it is:
// the drawing workspace, a parked tab, the recent documents or the open vault.
import { unpackDrawing } from "./file";
import type { DrawingDoc } from "./types";

/** The open 3D document a drawing can belong to. */
export type ModelKey = { part: string } | { asm: string } | { file: string };

const stem = (n: string) => n.replace(/\.[^./\\]+$/, "").trim().toLowerCase();

/** Whether a drawing's source is that model: same part or assembly document, or a model file of the same name (any extension, as the drawing keeps a STEP copy). */
export function drawingOf(src: DrawingDoc["source"] | null | undefined, key: ModelKey): boolean {
  if (!src) return false;
  if ("part" in key) return src.kind === "part" && src.doc?.id === key.part;
  if ("asm" in key) return src.kind === "asm" && src.doc?.id === key.asm;
  return src.kind === "file" && !!key.file && stem(src.name) === stem(key.file);
}

/** A drawing file's id, name and source, without loading its model; null when the bytes are not a drawing. */
export async function peekDrawing(buf: ArrayBuffer): Promise<{ id: string; name: string; source: DrawingDoc["source"] } | null> {
  try {
    const { doc } = await unpackDrawing(buf);
    return { id: doc.id, name: doc.name, source: doc.source };
  } catch { return null; }
}

export type DrawingWhere = "open" | "tab" | "vault" | "recent";
/** One drawing found for the model. */
export interface FoundDrawing { id: string; label: string; where: DrawingWhere; open(): Promise<void> | void }

const RANK: Record<DrawingWhere, number> = { open: 0, tab: 1, vault: 2, recent: 3 };
/** One entry per drawing document, the nearest place first (an open drawing before its file in the vault or the recent list). */
export function uniqueDrawings(found: FoundDrawing[]): FoundDrawing[] {
  const best = new Map<string, FoundDrawing>();
  for (const f of found) { const o = best.get(f.id); if (!o || RANK[f.where] < RANK[o.where]) best.set(f.id, f); }
  return [...best.values()].sort((a, b) => RANK[a.where] - RANK[b.where] || a.label.localeCompare(b.label));
}
