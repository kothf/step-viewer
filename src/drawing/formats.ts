// User sheet formats (FR-DRW-004): title blocks the user lays out (cells, fields, a logo).
// A sheet keeps its own copy (`Sheet.tb`), so a drawing file opens the same anywhere;
// the library of saved formats lives in this browser (localStorage), and a format can be
// exported to / imported from a small JSON file to share it.
import type { TbCell, TbKey, TitleFormat } from "./types";

const KEY = "mc:sheetFormats";
export const FORMAT_EXT = ".mcadfmt.json";
/** Every value a cell can show, in the order the editor lists them. */
export const TB_KEYS: TbKey[] = ["title", "number", "revision", "material", "mass", "company", "author", "checked", "approved", "date", "scale", "sheet", "size", "units", "projection"];
/** Logos larger than this are refused: they would bloat every drawing file. */
export const LOGO_MAX = 512 * 1024;

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** A title format from untrusted JSON (a file or the library), or null when it is not one. Cells outside the block are dropped. */
export function validFormat(x: unknown): TitleFormat | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const w = num(o.w, 20, 420), h = num(o.h, 5, 297);
  if (w == null || h == null || !Array.isArray(o.cells)) return null;
  const cells: TbCell[] = [];
  for (const c0 of o.cells.slice(0, 200)) {
    if (!c0 || typeof c0 !== "object") continue;
    const c = c0 as Record<string, unknown>;
    const cx = num(c.x, 0, w), cy = num(c.y, 0, h), cw = num(c.w, 1, w), ch = num(c.h, 1, h);
    if (cx == null || cy == null || cw == null || ch == null || cx + cw > w + 1e-6 || cy + ch > h + 1e-6) continue;
    const cell: TbCell = { x: cx, y: cy, w: cw, h: ch };
    if (typeof c.key === "string" && (TB_KEYS as string[]).includes(c.key)) cell.key = c.key as TbKey;
    if (typeof c.label === "string" && c.label.trim()) cell.label = c.label.slice(0, 80);
    if (c.big === true) cell.big = true;
    cells.push(cell);
  }
  const out: TitleFormat = { id: typeof o.id === "string" && o.id ? o.id.slice(0, 40) : `fmt_${Math.random().toString(36).slice(2, 10)}`, name: typeof o.name === "string" && o.name.trim() ? o.name.slice(0, 80) : "Title block", w, h, cells };
  const l = o.logo as Record<string, unknown> | undefined;
  if (l && typeof l.src === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(l.src) && l.src.length <= LOGO_MAX * 1.4) {
    const lx = num(l.x, 0, w), ly = num(l.y, 0, h), lw = num(l.w, 1, w), lh = num(l.h, 1, h);
    if (lx != null && ly != null && lw != null && lh != null) out.logo = { src: l.src, x: lx, y: ly, w: Math.min(lw, w - lx), h: Math.min(lh, h - ly) };
  }
  return out;
}

/** The saved formats, newest last. */
export function loadFormats(): TitleFormat[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map(validFormat).filter((f): f is TitleFormat => !!f) : [];
  } catch { return []; }
}

function store(list: TitleFormat[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Adds or replaces (by id) a format in the library; false when the browser refused (storage full). */
export function saveFormat(f: TitleFormat): boolean {
  const list = loadFormats().filter(x => x.id !== f.id);
  list.push(structuredClone(f));
  return store(list);
}

export function deleteFormat(id: string): boolean { return store(loadFormats().filter(x => x.id !== id)); }

/** A format as a file to share. */
export function formatFile(f: TitleFormat): string { return JSON.stringify({ format: "mobiuscad-sheet-format", version: 1, ...f }, null, 1); }
