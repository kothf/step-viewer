// Copies the OpenCASCADE WASM build into public/ so it ships as static files
// (loaded at runtime by the import worker, never bundled).
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
console.log("occt-import-js copied to public/occt");
