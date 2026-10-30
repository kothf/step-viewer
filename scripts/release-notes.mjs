#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for one version (used as GitHub release notes).
 *   node scripts/release-notes.mjs 1.0.0
 * Exits non-zero if the version has no section, so a release can't ship
 * without a changelog entry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) { console.error("usage: release-notes.mjs <version>"); process.exit(2); }
const log = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md"), "utf8");
const esc = version.replace(/\./g, "\\.");
const m = log.match(new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]: |(?![\\s\\S]))`, "m"));
if (!m || !m[1].trim()) { console.error(`CHANGELOG.md has no entry for ${version}`); process.exit(1); }
process.stdout.write(m[1].trim() + "\n");
