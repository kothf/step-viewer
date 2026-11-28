// Pack and Go names (FR-IO-011): the files of a packed assembly may go into one folder (flattened) and get a prefix
// or suffix, as other CAD apps' Pack and Go offers. The references inside the assembly and its sub-assemblies are
// rewritten to the new names, so the packed folder still opens.
import type { AsmDoc } from "./types";

export interface PackNames {
  /** Every file in the zip's top folder (part files no longer in subfolders). */
  flatten?: boolean;
  /** Put in front of every file name. */
  prefix?: string;
  /** Put after every file name, before the extension. */
  suffix?: string;
}

const SAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const dirOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const join = (dir: string, p: string) => {
  const out: string[] = dir ? dir.split("/") : [];
  for (const s of p.replace(/\\/g, "/").split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return out.join("/");
};

/** True when the options change any name. */
export function renames(o: PackNames | undefined): boolean {
  return !!o && (!!o.flatten || !!o.prefix?.trim() || !!o.suffix?.trim());
}

/** A file's path in the zip with the options applied (folders kept unless flattened). */
export function packedName(path: string, o: PackNames = {}): string {
  const dir = o.flatten ? "" : dirOf(path), base = path.split("/").at(-1) ?? path;
  const dot = base.lastIndexOf("."), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : "";
  const name = `${(o.prefix ?? "").trim()}${stem}${(o.suffix ?? "").trim()}`.replace(SAFE, "_") + ext;
  return dir ? `${dir}/${name}` : name;
}

/** The path from folder `from` to file `to` (both relative to the zip's top), with ".." where needed. */
export function relPath(from: string, to: string): string {
  const a = from ? from.split("/") : [], b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/**
 * Rewrites every reference of `doc` (placed at `asmPath` in the zip; sub-assemblies recurse from their own new
 * place) to the packed names. Two different documents that would get one name are told apart by " (2)"; one
 * document used twice keeps one file. Returns the new document and the assembly's own new name.
 */
export function renameRefs(doc: AsmDoc, asmPath: string, o: PackNames): { doc: AsmDoc; name: string } {
  const out = structuredClone(doc);
  const used = new Map<string, string>(), byOld = new Map<string, string>();
  const claim = (want: string, id: string) => {
    const dot = want.lastIndexOf("."), stem = dot > 0 ? want.slice(0, dot) : want, ext = dot > 0 ? want.slice(dot) : "";
    for (let n = 1; ; n++) {
      const p = n === 1 ? want : `${stem} (${n})${ext}`, k = p.toLowerCase(), has = used.get(k);
      if (has === undefined || has === id) { used.set(k, id); return p; }
    }
  };
  const name = claim(packedName(asmPath, o), doc.id);
  const walk = (d: AsmDoc, oldAt: string, newAt: string) => {
    for (const e of Object.values(d.parts)) {
      if (!e.link) continue;
      const id = e.asm?.id ?? e.doc?.id ?? e.name, old = join(oldAt, e.link.path), key = `${old.toLowerCase()}|${id}`;
      const now = byOld.get(key) ?? claim(packedName(old, o), id);
      byOld.set(key, now);
      e.link = { path: relPath(newAt, now), hash: "" };
      e.file = now.split("/").at(-1)!;
      if (e.asm) walk(e.asm, dirOf(old), dirOf(now));
    }
  };
  walk(out, dirOf(asmPath), dirOf(name));
  return { doc: out, name };
}
