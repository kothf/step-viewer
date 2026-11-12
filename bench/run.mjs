import { build } from "esbuild";
import { spawnSync } from "node:child_process";
const [entry, ...args] = process.argv.slice(2);
const out = `node_modules/.cache/bench/${entry.replace(/\W/g, "_")}.mjs`;
await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", external: ["opencascade.js"], define: { __APP_VERSION__: '"bench"', __BUILD_ID__: '"bench"' }, logLevel: "warning",
  plugins: [{ name: "url", setup(b) { b.onResolve({ filter: /\?url$/ }, a => ({ path: a.path.slice(0, -4), namespace: "url", pluginData: a.resolveDir })); b.onLoad({ filter: /.*/, namespace: "url" }, async a => { const { createRequire } = await import("node:module"); return { contents: `export default ${JSON.stringify(createRequire(a.pluginData + "/x.js").resolve(a.path))};`, loader: "js" }; }); } }] });
process.exit(spawnSync(process.execPath, [...(process.env.PROF ? ["--cpu-prof", "--cpu-prof-dir=node_modules/.cache/bench/prof"] : []), out, ...args], { stdio: "inherit" }).status ?? 1);
