// Copies the OpenCASCADE WASM build into public/ so it ships as static files
// (loaded at runtime by the import and kernel workers, never bundled).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchOcctGlue } from "./occt-patch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/occt-import-js/dist");
const dest = join(root, "public/occt");
mkdirSync(dest, { recursive: true });
for (const f of ["occt-import-js.js", "occt-import-js.wasm", "license.occt.txt", "license.occt-import-js.txt"]) {
  cpSync(join(src, f), join(dest, f));
}
// The full OpenCASCADE build (opencascade.js) for exact geometry and STEP export, loaded in the background.
const full = join(root, "node_modules/opencascade.js");
cpSync(join(full, "dist/opencascade.full.wasm"), join(dest, "opencascade.full.wasm"));
// Its JavaScript glue with embind's invokers made on first use (scripts/occt-patch.mjs): workers start in half the time.
const glue = readFileSync(join(full, "dist/opencascade.full.js"), "utf8");
const patched = patchOcctGlue(glue);
if (!patched) console.warn("opencascade.full.js: start-up patch not applied (the glue changed); copied as it is");
writeFileSync(join(dest, "opencascade.full.js"), patched ?? glue);
cpSync(join(full, "LICENSE"), join(dest, "license.opencascade.js.txt"));
console.log("occt-import-js and opencascade.js copied to public/occt");
