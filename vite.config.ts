import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import credits from "./scripts/credits-plugin.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Relative base so the build works from any sub-path (e.g. aerocat.tech/tools/step-viewer/).
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: "es" },
  // credits.json + THIRD-PARTY-LICENSES.txt for the About page; occt-import-js is loaded from occt/ at runtime
  plugins: [credits({
    extra: [
      { dir: "node_modules/occt-import-js", entry: { author: "Viktor Kovács" },
        files: ["node_modules/occt-import-js/dist/license.occt-import-js.txt"], note: "Loaded at runtime from the occt/ folder, unmodified." },
      { entry: { name: "Open CASCADE Technology", version: "(in occt-import-js)", license: "LGPL-2.1 with the OCCT exception", author: "Open Cascade SAS", url: "https://dev.opencascade.org" },
        files: ["node_modules/occt-import-js/dist/license.occt.txt"], note: "Compiled into occt-import-js.wasm; shipped unmodified in the occt/ folder." },
    ],
    // package.json names one maintainer; the licence names the copyright holders
    overrides: { three: { author: "three.js authors" }, jspdf: { author: "James Hall, yWorks GmbH" } },
  })],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
