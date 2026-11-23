// Build ids for the disk cache of built geometry (src/buildCache.ts). Each kind of entry is keyed by a hash of the
// code that makes it: the source files reachable by import from the worker that builds it and the page code that
// stores it, plus the locked packages (OpenCASCADE among them) and the scripts that patch the kernel's glue. A
// release that changes only other code (the analysis, the UI) keeps everything a user opened before; one that
// changes the kernel misses, so a new build never shows geometry an older one made.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Value imports and re-exports, dynamic imports (not `import("x").Type` in type positions), side-effect imports and `new URL(…, import.meta.url)`. */
const IMPORT = /(?:import|export)\s(?!type\s)[^;"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)(?!\.[A-Z])|import\s*["']([^"']+)["']|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;

function resolve(from, spec) {
  spec = spec.split("?")[0];
  if (!spec.startsWith(".")) return null; // a package: covered by package-lock.json
  const b = normalize(join(dirname(from), spec));
  for (const c of [b, `${b}.ts`, `${b}.js`, `${b}.mjs`, join(b, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** Every file reachable from `entries` (paths relative to the project), sorted. */
export function moduleGraph(entries) {
  const seen = new Set(), todo = [...entries];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT)) { const r = resolve(f, m[1] ?? m[2] ?? m[3] ?? m[4]); if (r) todo.push(r); }
  }
  return [...seen].sort();
}

const COMMON = ["scripts/occt-patch.mjs", "scripts/copy-occt.mjs", "scripts/build-ids.mjs"];
const KERNEL = ["src/kernel/kernel.worker.ts", "src/model/kernelClient.ts", "src/kernel/client.ts"];

/** Entry files per cache kind; a kind not listed here is keyed by all of `src/` (`all`). */
export const KINDS = {
  part: KERNEL,
  asmpart: KERNEL,
  exact: KERNEL,
  import: ["src/worker/import.worker.ts", "src/meshLoad.ts"],
  drawing: ["src/drawing/drawing.worker.ts", "src/drawing/client.ts", ...KERNEL],
  view: ["src/drawing/drawing.worker.ts", "src/drawing/client.ts", ...KERNEL],
};

/** The locked packages without the app's own entry, whose version changes with every release. */
function lockedPackages() {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const pk = { ...lock.packages };
  delete pk[""];
  return JSON.stringify(pk);
}

function hashFiles(files) {
  const h = createHash("sha256");
  h.update(lockedPackages());
  for (const f of files) { h.update(f); h.update(readFileSync(f)); }
  return h.digest("hex").slice(0, 16);
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** `{ all, <kind>: id }`: `all` hashes every source file, each kind its own module graph. */
export function buildIds() {
  const ids = { all: hashFiles([...walk("src"), ...COMMON]) };
  for (const [k, entries] of Object.entries(KINDS)) ids[k] = hashFiles([...moduleGraph(entries), ...COMMON]);
  return ids;
}
