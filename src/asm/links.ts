// Linked components (FR-ASM-003, FR-IO-011): a part entry can point at its source file by a path
// relative to the assembly's folder and the SHA-256 of the file's bytes. The document stays in the
// assembly as the last loaded copy, so a missing file still shows (marked) and the assembly opens anywhere.
import type { AsmDoc } from "./types";

export interface LinkFile { path: string; hash: string }
export interface LinkPlan {
  /** Part key → the file that now holds it (its content changed, or it was found under another path). */
  update: Map<string, LinkFile>;
  /** Linked part keys whose file is unchanged. */
  same: string[];
  /** Linked part keys with no file at their path (nor a single file of the same name). */
  missing: string[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
const base = (p: string) => norm(p).split("/").at(-1)!.toLowerCase();

/**
 * What reloading links from a folder does: each linked part looks for its path, else for the one file of
 * that name anywhere in the folder; a different hash (or path) means its document is read again.
 */
export function planLinks(parts: AsmDoc["parts"], files: LinkFile[]): LinkPlan {
  const byPath = new Map(files.map(f => [norm(f.path).toLowerCase(), f]));
  const plan: LinkPlan = { update: new Map(), same: [], missing: [] };
  for (const [key, p] of Object.entries(parts)) {
    if (!p.link) continue;
    let f = byPath.get(norm(p.link.path).toLowerCase());
    if (!f) {
      const named = files.filter(x => base(x.path) === base(p.link!.path));
      if (named.length === 1) f = named[0];
    }
    if (!f) plan.missing.push(key);
    else if (f.hash === p.link.hash && norm(f.path) === norm(p.link.path)) plan.same.push(key);
    else plan.update.set(key, { path: norm(f.path), hash: f.hash });
  }
  return plan;
}

/** A path inside a picked folder: `webkitRelativePath` starts with the folder's own name. */
export function folderPath(rel: string): string {
  const p = norm(rel).split("/");
  return p.length > 1 ? p.slice(1).join("/") : p[0];
}

/** Hex SHA-256 of a file's bytes. */
export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", (data instanceof Uint8Array ? data : new Uint8Array(data)) as BufferSource);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
