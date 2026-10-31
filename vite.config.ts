import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Relative base so the build works from any sub-path (e.g. aerocat.tech/tools/mobiuscad/).
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
