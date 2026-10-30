#!/usr/bin/env node
/**
 * Build the distributable viewer: dist/step-viewer/ plus a versioned archive.
 *
 *   node scripts/package.mjs            # version from package.json
 *   node scripts/package.mjs 1.1.0      # explicit version (CI passes the tag)
 *
 * Output:
 *   dist/step-viewer/                       static site (relative URLs, any sub-path)
 *   dist/step-viewer-<version>.tar.gz       release asset
 *   dist/step-viewer-<version>.tar.gz.sha256
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = (process.argv[2] || pkg.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Not a semver version: ${version}`);
if (version !== pkg.version) throw new Error(`Version ${version} does not match package.json ${pkg.version}`);

const dist = join(root, "dist");
const out = join(dist, "step-viewer");
rmSync(dist, { recursive: true, force: true });
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("node", ["scripts/copy-occt.mjs"]);
run("npx", ["tsc"]);
run("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"]);
rmSync(join(out, "samples"), { recursive: true, force: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(join(out, "VERSION"), `${version}\n`);

const archive = `step-viewer-${version}.tar.gz`;
// --sort/--mtime/--owner/--mode and gzip -n make the archive byte-identical for
// identical input on any machine (checkout permissions and umask differ)
execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u=rwX,go=rX",
  "--use-compress-program=gzip -n", "-C", dist, "-cf", join(dist, archive), "step-viewer"]);
const sha = createHash("sha256").update(readFileSync(join(dist, archive))).digest("hex");
writeFileSync(join(dist, `${archive}.sha256`), `${sha}  ${archive}\n`);

console.log(`Packaged step-viewer ${version}\n  ${archive}\n  sha256 ${sha}`);
