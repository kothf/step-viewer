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
  define: { __APP_VERSION__: '"test"', __BUILD_ID__: '"test"' },
  logLevel: "warning",
  // Vite's `?url` imports become the file's absolute path, so modules that fetch assets still bundle.
  plugins: [{
    name: "url",
    setup(b) {
      b.onResolve({ filter: /\?url$/ }, a => ({ path: a.path.slice(0, -4), namespace: "url", pluginData: a.resolveDir }));
      b.onLoad({ filter: /.*/, namespace: "url" }, async a => {
        const { createRequire } = await import("node:module");
        const file = createRequire(join(a.pluginData ?? root, "x.js")).resolve(a.path);
        return { contents: `export default ${JSON.stringify(file)};`, loader: "js" };
      });
    },
  }],
});
const pat = process.env.UNIT_PATTERN ? [`--test-name-pattern=${process.env.UNIT_PATTERN}`] : [];
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...pat, ...files.map(f => join(out, f.replace(/\.ts$/, ".mjs")))], { stdio: "inherit" });
process.exit(r.status ?? 1);
