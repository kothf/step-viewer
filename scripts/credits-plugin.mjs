// Vite plugin: lists the open-source packages that actually end up in the build, for the
// About / Credits page, and ships their licence texts as required by their licences.
//
// At build time it walks the bundle's module ids, maps each one under node_modules/ to its
// package, and emits two files next to index.html:
//   credits.json                name, version, licence, copyright, link of every bundled package
//   THIRD-PARTY-LICENSES.txt    the full licence text of each of them
// Packages loaded at runtime instead of bundled (the OpenCASCADE WASM in occt/) are passed in
// `extra`. In dev, the same list is built from the production dependency tree and served at
// /credits.json so the page works there too.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const LICENSE_RE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;

function packageRootOf(id) {
  const clean = id.replace(/^\0/, "").split("?")[0];
  const i = clean.lastIndexOf(`${sep}node_modules${sep}`);
  if (i < 0) return null;
  const rest = clean.slice(i + 14).split(sep);
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return { name, dir: join(clean.slice(0, i + 14), name) };
}

function repoUrl(repository) {
  const u = typeof repository === "string" ? repository : repository?.url;
  if (!u) return "";
  if (/^(github:)?[\w.-]+\/[\w.-]+$/.test(u)) return `https://github.com/${u.replace(/^github:/, "")}`;
  return u.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
}

function authorName(a) {
  if (!a) return "";
  return typeof a === "string" ? a.replace(/\s*[<(].*$/, "").trim() : a.name || "";
}

/** "Copyright (c) 2010 - present Jane Doe (jane@x.org) - https://…" → "Jane Doe" */
function holderOf(text) {
  for (const line of text.split("\n")) {
    if (!/copyright|\(c\)|©/i.test(line) || /free software foundation/i.test(line)) continue;
    const who = line
      .replace(/copyright|\(c\)|©|all rights reserved\.?/gi, "")
      .replace(/\b\d{4}(\s*[-–]\s*(\d{4}|present))?\b|\bpresent\b/gi, "")
      .replace(/<[^>]*>|\([^)]*@[^)]*\)|https?:\/\/\S+/g, "")
      .replace(/^[\s,.:-]+|[\s,.:-]+$/g, "").replace(/\s+/g, " ");
    if (/[a-z]/i.test(who)) return who;
  }
  return "";
}

/** Reads one package's credit entry and licence text from its folder. */
export function readPackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir).filter(f => LICENSE_RE.test(f)).sort();
  const text = files.map(f => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type || "see licence text";
  return {
    entry: {
      name: pkg.name, version: pkg.version, license,
      author: authorName(pkg.author) || holderOf(text),
      url: pkg.homepage?.startsWith("http") ? pkg.homepage.replace(/#readme$/, "") : repoUrl(pkg.repository) || `https://www.npmjs.com/package/${pkg.name}`,
    },
    text,
  };
}

function render(packages, extra, overrides = {}) {
  const all = [...packages, ...extra].map(p => ({ ...p, entry: { ...p.entry, ...overrides[p.entry.name] } })).sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  const json = JSON.stringify(all.map(p => ({ ...p.entry, ...(p.note ? { note: p.note } : {}) })), null, 1);
  const txt = "Third-party software in this build\n" + "=".repeat(34) + "\n\n" + all.map(p =>
    `${p.entry.name} ${p.entry.version}\nLicence: ${p.entry.license}\n${p.entry.url}\n${p.note ? p.note + "\n" : ""}\n${p.text || "(no licence file in the package)"}\n`).join("\n" + "-".repeat(72) + "\n\n");
  return { json, txt };
}

/** Production dependency tree (dev only, where there is no bundle to look at). */
function prodTree(root) {
  const seen = new Map();
  const visit = (name, from) => {
    let dir = from;
    for (;;) {
      const cand = join(dir, "node_modules", name);
      if (existsSync(join(cand, "package.json"))) { dir = cand; break; }
      const up = dirname(dir);
      if (up === dir) return;
      dir = up;
    }
    if (seen.has(dir)) return;
    const p = readPackage(dir);
    seen.set(dir, p);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const d of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(d, dir);
  };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const d of Object.keys(pkg.dependencies || {})) visit(d, root);
  return [...seen.values()];
}

/**
 * @param {{ extra?: { dir?: string, entry?: object, files?: string[], note?: string }[], overrides?: Record<string, object> }} [opts]
 * `extra`: things that are not bundled. `dir` reads a package folder; `entry` sets or overrides
 * fields (name, version, license, author, url); `files` are licence texts to include instead.
 * `overrides`: per package name, fields to correct where package.json says something unhelpful.
 */
export default function credits(opts = {}) {
  const extraOf = () => (opts.extra || []).map(e => {
    const base = e.dir ? readPackage(e.dir) : { entry: {}, text: "" };
    const text = e.files ? e.files.map(f => readFileSync(f, "utf8").trim()).join("\n\n") : base.text;
    return { entry: { ...base.entry, ...e.entry }, text, note: e.note };
  });
  const skip = new Set(extraOf().map(e => e.entry.name));
  let root = process.cwd();
  return {
    name: "credits",
    configResolved(c) { root = c.root; },
    configureServer(server) {
      server.middlewares.use("/credits.json", (_req, res) => {
        const { json } = render(prodTree(root).filter(p => !skip.has(p.entry.name)), extraOf(), opts.overrides);
        res.setHeader("Content-Type", "application/json");
        res.end(json);
      });
    },
    generateBundle() {
      const pkgs = new Map();
      for (const id of this.getModuleIds()) {
        const r = packageRootOf(id);
        if (r && !pkgs.has(r.dir) && existsSync(join(r.dir, "package.json"))) pkgs.set(r.dir, readPackage(r.dir));
      }
      // one entry per package name (a package can sit in two folders)
      const byName = new Map();
      for (const p of pkgs.values()) if (!skip.has(p.entry.name)) byName.set(p.entry.name, p);
      const { json, txt } = render([...byName.values()], extraOf(), opts.overrides);
      this.emitFile({ type: "asset", fileName: "credits.json", source: json });
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-LICENSES.txt", source: txt });
    },
  };
}
