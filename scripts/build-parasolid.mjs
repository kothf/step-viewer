// Rebuilds src/sw/parasolid.wasm from native/parasolid-wasm (parasolid-core from
// parasolid-kit, pinned in its Cargo.toml). Needs Rust with the wasm32 target:
//   rustup target add wasm32-unknown-unknown
// The built module is committed, so the app builds without Rust.
import { execFileSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "native/parasolid-wasm");
execFileSync("cargo", ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit" });
const out = join(root, "src/sw/parasolid.wasm");
copyFileSync(join(crate, "target/wasm32-unknown-unknown/release/parasolid_wasm.wasm"), out);
console.log(`src/sw/parasolid.wasm: ${(statSync(out).size / 1024).toFixed(0)} kB`);
