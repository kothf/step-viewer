// Unit tests (FRS NFR-QA-001): bundles tests/unit/*.test.ts with esbuild and runs them with node --test.
// The kernel tests load the full OpenCASCADE build from node_modules (slow to start, ~10 s).
import { build } from "esbuild";
import { readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "tests/unit");
const out = join(root, "node_modules/.cache/unit");
const only = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter(f => f.endsWith(".test.ts") && (!only.length || only.some(o => f.includes(o))));
await build({
  entryPoints: files.map(f => join(dir, f)),
  outdir: out,
  bundle: true,
  platform: "node",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  external: ["opencascade.js"],
  define: { __APP_VERSION__: '"test"' },
  logLevel: "warning",
});
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files.map(f => join(out, f.replace(/\.ts$/, ".mjs")))], { stdio: "inherit" });
process.exit(r.status ?? 1);
