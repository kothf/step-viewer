// Copies the OpenCASCADE WASM build into public/ so it ships as static files
// (loaded at runtime by the import and kernel workers, never bundled).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/occt-import-js/dist");
const dest = join(root, "public/occt");
mkdirSync(dest, { recursive: true });
for (const f of ["occt-import-js.js", "occt-import-js.wasm", "license.occt.txt", "license.occt-import-js.txt"]) {
  cpSync(join(src, f), join(dest, f));
}
// The full OpenCASCADE build (opencascade.js) for exact geometry and STEP export, loaded in the background.
const full = join(root, "node_modules/opencascade.js");
for (const f of ["opencascade.full.js", "opencascade.full.wasm"]) cpSync(join(full, "dist", f), join(dest, f));
cpSync(join(full, "LICENSE"), join(dest, "license.opencascade.js.txt"));
console.log("occt-import-js and opencascade.js copied to public/occt");
