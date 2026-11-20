// Runs the human-style tests (real clicks, drags and keys on the packaged app, screenshots of each step) and
// writes report.md beside the screenshots. Serve dist/step-viewer first (HT_URL, default http://localhost:8123).
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const out = process.env.HT_OUT || "/mnt/project-files/gap-tests";
mkdirSync(out, { recursive: true });
const lines = [];
let fails = 0;
for (const f of (process.argv.slice(2).length ? process.argv.slice(2) : ["sketch", "model", "asm", "asm2", "select", "drawing", "keys", "polish", "polish2", "gtol", "attach", "clip", "drwmenu", "cutflow", "convert", "vaultusers"])) {
  const r = spawnSync("node", [join(dir, `${f}.mjs`)], { encoding: "utf8", env: { ...process.env, HT_OUT: out } });
  const rows = (r.stdout + r.stderr).split("\n").filter(l => /^(PASS|FAIL) /.test(l));
  if (r.status) rows.push(`FAIL ${f}: the script stopped: ${(r.stderr.split("\n").find(l => /Error/.test(l)) ?? "").trim()}`);
  fails += rows.filter(l => l.startsWith("FAIL")).length;
  lines.push(`## ${f}`, "", ...rows.map(l => `- ${l.replace(/ \{.*$/, "")}`), "");
}
writeFileSync(join(out, "report.md"), `# Hands-on tests\n\n${lines.join("\n")}`);
console.log(lines.join("\n"));
process.exit(fails ? 1 : 0);
