#!/usr/bin/env node
/**
 * End-to-end smoke test of a built viewer in headless Chromium.
 *
 *   node tests/smoke.mjs dist/step-viewer
 *
 * Opens public CAX-IF / sample STEP files that ship with occt-import-js
 * (node_modules/occt-import-js/test/testfiles) and checks parsing, topology,
 * measurements, sections, mass properties and the tree.
 * Set CHROMIUM_PATH to use a specific browser binary, SMOKE_SHARD=i/n to run one shard (see inShard).
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { createRequire } from "node:module";

const root = resolve(process.argv[2] || "dist/step-viewer");
const fixtures = resolve("node_modules/occt-import-js/test/testfiles");
const pcbDir = resolve("tests/fixtures/pcb");

/** A zip (deflate) of the given files, to test .zip Gerber sets. */
function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, data] of files) {
    const nm = Buffer.from(name), comp = deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    locals.push(h, nm, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** A large synthetic copper layer: a grid of pads joined by tracks. */
function bigGerber(n) {
  const L = ["%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,0.200000*%", "%ADD11R,1.000000X0.600000*%", "G01*"];
  const c = v => Math.round(v * 1e6);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = i * 2, y = j * 1.5;
    L.push("D11*", `X${c(x)}Y${c(y)}D03*`, "D10*", `X${c(x)}Y${c(y)}D02*`, `X${c(x + 2)}Y${c(y)}D01*`, `X${c(x + 2)}Y${c(y + 1.5)}D01*`);
  }
  L.push("M02*");
  return Buffer.from(L.join("\n"));
}
const pcbFiles = {};
for (const f of await readdir(pcbDir)) pcbFiles[f] = await readFile(join(pcbDir, f));
pcbFiles["board.zip"] = zip(Object.entries(pcbFiles).map(([n, d]) => [`gerbers/${n}`, d]));
pcbFiles["big-F_Cu.gbr"] = bigGerber(300);
// Mesh files: a 48-sided cylinder (OBJ) and a 20×10×4 box (3MF).
{
  const n = 48, r = 5, h = 10, v = [], f = [];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; v.push(`v ${r * Math.cos(a)} ${r * Math.sin(a)} 0`, `v ${r * Math.cos(a)} ${r * Math.sin(a)} ${h}`); }
  v.push("v 0 0 0", `v 0 0 ${h}`);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, b0 = 2 * i + 1, t0 = 2 * i + 2, b1 = 2 * j + 1, t1 = 2 * j + 2;
    f.push(`f ${b0} ${b1} ${t1}`, `f ${b0} ${t1} ${t0}`, `f ${2 * n + 1} ${b1} ${b0}`, `f ${2 * n + 2} ${t0} ${t1}`);
  }
  pcbFiles["cyl.obj"] = Buffer.from(["o Cylinder", ...v, ...f].join("\n"));
  const bx = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0], [0, 0, 4], [20, 0, 4], [20, 10, 4], [0, 10, 4]];
  const bt = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Block"><mesh><vertices>${bx.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")}</vertices><triangles>${bt.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  pcbFiles["block.3mf"] = zip([["_rels/.rels", Buffer.from(rels)], ["3D/3dmodel.model", Buffer.from(model)]]);
}
const occtImport = await createRequire(import.meta.url)("occt-import-js")();
/** Reads a STEP file back with occt-import-js: meshes and their faces. */
const readStep = buf => {
  const r = occtImport.ReadStepFile(new Uint8Array(buf), { linearUnit: "millimeter" });
  return { ok: r.success, meshes: r.meshes.length, faces: r.meshes.reduce((s, m) => s + m.brep_faces.length, 0) };
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.startsWith("/pcb/")) {
    const b = pcbFiles[rel.slice(5)];
    res.writeHead(b ? 200 : 404, { "content-type": "application/octet-stream" });
    return res.end(b);
  }
  const [base, sub] = rel.startsWith("/fixtures/") ? [fixtures, rel.slice("/fixtures".length)] : [root, rel.replace(/\/$/, "/index.html")];
  const path = join(base, sub);
  if (path !== base && !path.startsWith(base + sep)) { res.writeHead(403); return res.end(); }
  let body;
  try { body = await readFile(path); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
  res.end(body);
}).listen(0);
// Served from a sub-path, like aerocat.tech/tools/step-viewer/.
const origin = `http://localhost:${server.address().port}`;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
// Shards: SMOKE_SHARD=i/n runs only the blocks marked inShard(k) with (k - 1) % n + 1 === i (CI runs
// 1/4 … 4/4 as parallel jobs); unset, every block runs. A block must not rely on what another block
// left behind (blocks 1 and 2 hold several sections that share `page`). A new section goes in its own
// `if (inShard(k)) { … }` block, k = the shard with the shortest time (printed at the end of a run).
const [shardI, shardN] = (process.env.SMOKE_SHARD || "1/1").split("/").map(Number);
if (!(shardN >= 1 && shardI >= 1 && shardI <= shardN)) throw new Error(`SMOKE_SHARD must be i/n, got ${process.env.SMOKE_SHARD}`);
const inShard = k => (k - 1) % shardN + 1 === shardI;
/**
 * Runs a part command by its label from the command bar (FR-UI-010): looks through the part's tabs and
 * their flyouts, picks the tab, then the button or the flyout entry (exact label first, else one starting with it).
 */
async function runCmd(pg, label) {
  // Exact label first, on every tab and flyout; then the first label that starts with it.
  for (const exact of [true, false]) {
    const pick = async sel => {
      const texts = await pg.$$eval(sel, els => els.map(e => (e.querySelector(".mc-l") ?? e).textContent.trim()));
      return exact ? texts.indexOf(label) : texts.findIndex(x => x.startsWith(label));
    };
    for (const tab of ["features", "surfaces", "sheetmetal", "weldments", "sketch"]) {
      if (!(await pg.$(`#cm-t-${tab}`))) continue;
      await pg.click(`#cm-t-${tab}`);
      const i = await pick("#mc-tools [data-c]");
      if (i >= 0) { await pg.locator("#mc-tools [data-c]").nth(i).click(); return; }
      for (const key of await pg.$$eval("#mc-tools [data-fly]", els => els.map(e => e.dataset.fly))) {
        await pg.click(`#mc-tools [data-fly="${key}"]`);
        const j = await pick("#mc-menu button");
        if (j >= 0) { await pg.locator("#mc-menu button").nth(j).click(); return; }
        await pg.keyboard.press("Escape");
      }
    }
  }
  throw new Error(`No command labelled ${label}`);
}
const started = Date.now();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

async function open(file, kernel = false) {
  await page.goto(`${origin}/index.html?debug${kernel ? "" : "&nokernel"}&url=${encodeURIComponent(`/fixtures/${file}`)}`);
  await page.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
}

try {
  if (inShard(1)) { // these sections share `page`: keep them together
  // --- a 10 mm cube: exact topology and every basic measurement ---
  await open("cube-10x10mm/Cube 10x10.stp");
  // --- branding: name, header logo, favicon and web manifest ---
  const brand = await page.evaluate(async () => {
    const logo = document.querySelector(".brand-logo");
    const ok = async href => { const r = await fetch(href); return r.ok && (await r.blob()).size > 0; };
    const man = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
    return {
      title: document.title, txt: document.querySelector(".brand-txt").firstChild.textContent,
      logo: logo?.complete && logo.naturalWidth > 0,
      icons: (await Promise.all([...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map(l => ok(l.href)))).every(Boolean),
      man: man.name, manIcons: (await Promise.all(man.icons.map(i => ok(new URL(i.src, document.querySelector('link[rel="manifest"]').href).href)))).every(Boolean),
    };
  });
  check(brand.title === "Cube 10x10.stp · MöbiusCAD" && brand.txt === "MöbiusCAD", `app is named MöbiusCAD (${brand.title} / ${brand.txt})`);
  check(brand.logo && brand.icons && brand.man === "MöbiusCAD" && brand.manIcons, "header logo, favicons and manifest icons load");

  // --- command bar (FR-UI-010): the Evaluate tab holds every measuring tool on one row under a one-row header;
  //     the right panel's pages are tabs at its top. Phones may scroll the command row sideways. ---
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const inView = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth + 0.5 && b.top >= 0 && b.bottom <= innerHeight; };
      const tb = document.querySelector(".topbar"), cm = document.querySelector("#cm");
      const tools = [...document.querySelectorAll("#tools button")], pages = [...document.querySelectorAll("#rp-tabs [role=tab]")];
      return {
        n: tools.length, off: tools.filter(b => !inView(b)).map(b => b.dataset.tool), tab: document.querySelector("#cm-tabs [aria-selected=true]")?.dataset.cm,
        pages: pages.length, pagesOff: pages.filter(b => !inView(b)).map(b => b.dataset.tab),
        named: [...tools, ...pages].every(b => b.textContent.trim().length > 1 && b.title),
        over: tb.scrollWidth - tb.clientWidth, page: document.documentElement.scrollWidth - innerWidth,
        h: Math.round(tb.getBoundingClientRect().height), cmH: Math.round(cm.getBoundingClientRect().height),
      };
    });
    check(r.n === 12 && r.pages === 5 && r.tab === "evaluate" && r.named && r.over <= 1 && r.page <= 0 && (w < 1024 || r.h <= 48) && r.cmH <= 80
      && (w < 1024 || r.off.length === 0) && (w < 1280 || r.pagesOff.length === 0),
      `command bar ${w}px: Evaluate holds the 12 tools${w >= 1024 ? " on screen" : ""}, ${w >= 1280 ? "5 panel pages in view, " : ""}one-row header (${JSON.stringify(r)})`);
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(150);
  // Section, Explode, Mass and Export each open as one page in the right panel, with their controls above the fold.
  const pages = {};
  for (const [tab, ctl] of [["section", "#sec-add [data-sec=z]"], ["explode", "#explode"], ["mass", "#mass-run"], ["export", "#png"], ["props", "#props"]]) {
    await page.click(`#rt-${tab}`);
    pages[tab] = await page.evaluate(([tab, ctl]) => {
      const e = document.querySelector(ctl), b = e.getBoundingClientRect(), right = document.querySelector("#right");
      return document.querySelectorAll(".rp.on").length === 1 && document.querySelector(`#rp-${tab}`).classList.contains("on")
        && document.querySelector(`#rt-${tab}`).getAttribute("aria-selected") === "true" && b.width > 0 && b.bottom <= innerHeight && right.scrollTop === 0;
    }, [tab, ctl]);
  }
  check(Object.values(pages).every(Boolean), `right panel: each page opens from the tool strip with its controls in view (${JSON.stringify(pages)})`);
  // The panel button hides the panel and brings it back on the page it had. A new section plane shows the Section page.
  await page.click("#rt-mass");
  await page.click("#panel-toggle");
  const hiddenPanel = await page.evaluate(() => document.querySelector("#app").classList.contains("no-right"));
  await page.click("#panel-toggle");
  const shownPanel = await page.evaluate(() => !document.querySelector("#app").classList.contains("no-right") && document.querySelector("#rp-mass").classList.contains("on"));
  await page.click("#rt-props");
  await page.$eval("#sec-add [data-sec=z]", el => el.click());
  const secShown = await page.evaluate(() => document.querySelector("#rp-section").classList.contains("on"));
  await page.evaluate(() => { window.__sv.section.clear(); window.__sv.renderSections(); });
  await page.click("#rt-props");
  // Display menu: axes and ambient occlusion live in a header menu, not loose in the header.
  const inHeader = await page.evaluate(() => !!document.querySelector(".topbar #ao, .topbar #origin-axes"));
  await page.click("#display-btn");
  const menuOpen = await page.evaluate(() => { const m = document.querySelector("#display-menu"), b = m.getBoundingClientRect(); return { open: !m.hidden && document.querySelector("#display-btn").getAttribute("aria-expanded") === "true", inView: b.left >= 0 && b.right <= innerWidth && b.top >= 40, focus: m.contains(document.activeElement) }; });
  await page.click("#ao");
  const aoOn = await page.evaluate(() => window.__sv.viewer.aoEnabled === true);
  await page.click("#ao");
  await page.keyboard.press("Escape");
  const menuClosed = await page.evaluate(() => document.querySelector("#display-menu").hidden && document.activeElement?.id === "display-btn");
  check(!inHeader && menuOpen.open && menuOpen.inView && menuOpen.focus && aoOn && menuClosed, `display menu: axes and AO in a header menu that opens, toggles AO and closes on Esc (${JSON.stringify({ inHeader, menuOpen, aoOn, menuClosed })})`);
  // Tool buttons report their state.
  await page.click("#tools [data-tool=radius]");
  const pressed = await page.evaluate(() => [...document.querySelectorAll("#tools button")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.tool));
  await page.keyboard.press("Escape");
  check(hiddenPanel && shownPanel && secShown && pressed.join() === "radius", `tool strip: the panel button hides and shows the panel, a new plane shows Section, aria-pressed on the active tool (${JSON.stringify({ hiddenPanel, shownPanel, secShown, pressed })})`);
  const cube =await page.evaluate(() => {
    const { viewer, state, handlePick, setTool } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const faces = p.data.faces, edges = p.data.edges;
    const snapF = f => ({ kind: "onFace", point: new V3(...f.centroid), part: p, face: f, normal: new V3(...f.normal), px: 0 });
    const top = faces.find(f => f.normal?.[2] > 0.99), bottom = faces.find(f => f.normal?.[2] < -0.99), side = faces.find(f => Math.abs(f.normal?.[0]) > 0.99);
    setTool("minDistance"); handlePick(snapF(top)); handlePick(snapF(bottom));
    setTool("angle"); handlePick(snapF(top)); handlePick(snapF(side));
    const e = edges[0];
    setTool("arcLength"); handlePick({ kind: "onEdge", point: new V3(...e.mid), part: p, edge: e, px: 0 });
    setTool("bbox");
    setTool("select");
    document.querySelector("#mass-run").click();
    return {
      faces: faces.length, planes: faces.filter(f => f.type === "plane").length, edges: edges.length,
      lines: edges.filter(x => x.type === "line").length, closed: p.data.closed, volume: p.data.volume, area: p.data.area,
      ms: state.measurements.map(m => [m.type, m.value]),
      mass: document.querySelector("#mass-out").textContent,
      analysisUi: !!document.querySelector("#draft-run, #thk-run, #analysis-out"),
    };
  });
  check(cube.faces === 6 && cube.planes === 6, `cube has 6 planar faces (${cube.planes}/${cube.faces})`);
  check(cube.edges === 12 && cube.lines === 12, `cube has 12 straight edges (${cube.lines}/${cube.edges})`);
  check(cube.closed && near(cube.volume, 1000, 1e-6) && near(cube.area, 600, 1e-6), `closed solid, V=${cube.volume}, A=${cube.area}`);
  const m = Object.fromEntries(cube.ms);
  check(near(m.minDistance, 10, 1e-9), `face-to-face distance 10 mm (${m.minDistance})`);
  check(near(m.angle, Math.PI / 2, 1e-9), `face angle 90° (${(m.angle * 180) / Math.PI})`);
  check(near(m.arcLength, 10, 1e-9), `edge length 10 mm (${m.arcLength})`);
  check(near(m.bbox, Math.sqrt(300), 1e-6), `bounding box diagonal √300 (${m.bbox})`);
  // Calculate shows a busy spinner for a frame first, so the result arrives asynchronously.
  await page.waitForFunction(() => /Mass/.test(document.querySelector("#mass-out").textContent), null, { timeout: 5000 }).catch(() => {});
  cube.mass = await page.$eval("#mass-out", el => el.textContent);
  check(/Mass\s*7\.850 g/.test(cube.mass), "steel cube mass 7.850 g");
  check(!cube.analysisUi, "draft angle and wall thickness controls are gone");

  // Occlusion-aware snapping: in opaque modes an edge behind the body is not pickable, in X-ray it is.
  const occl = await page.evaluate(async () => {
    const { viewer, snapper, setMode } = window.__sv;
    const V3 = viewer.camera.position.constructor;
    viewer.viewFrom(new V3(1, -1, 0.8), false);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    viewer.camera.updateMatrixWorld(true);
    const p = viewer.parts[0];
    const fwd = viewer.camera.getWorldDirection(new V3());
    const back = e => e.faces.every(fi => new V3(...p.data.faces[fi].normal).dot(fwd) > 0);
    const front = e => e.faces.every(fi => new V3(...p.data.faces[fi].normal).dot(fwd) < 0);
    const scr = w => { const s = w.clone().project(viewer.camera); return [(s.x + 1) / 2 * viewer.size.x, (1 - s.y) / 2 * viewer.size.y]; };
    const at = (e, mode) => { setMode(mode); snapper.reset(); const [x, y] = scr(viewer.toWorld(p, e.mid)); return snapper.pick(x, y); };
    const hidden = p.data.edges.filter(back), shown = p.data.edges.filter(front);
    const res = { hidden: hidden.length, shown: shown.length, opaque: [], xray: [], hlr: [], visible: [] };
    for (const e of hidden) {
      for (const mode of ["shadedEdges", "hlr", "xray"]) {
        const s = at(e, mode);
        res[mode === "shadedEdges" ? "opaque" : mode].push(s ? [s.kind, s.edge === e, snapper.isVisible(s.point)] : null);
      }
    }
    for (const e of shown) { const s = at(e, "shaded"); res.visible.push(s && s.edge === e ? s.kind : null); }
    setMode("shadedEdges");
    return res;
  });
  check(occl.hidden === 3 && occl.opaque.every(s => s && !s[1] && s[2]) && occl.hlr.every(s => s && !s[1]),
    `opaque modes ignore the ${occl.hidden} cube edges behind the body (${JSON.stringify(occl.opaque)})`);
  check(occl.xray.every(s => s && s[1] && s[0] === "midpoint"), `X-ray still snaps to hidden edges (${JSON.stringify(occl.xray)})`);
  check(occl.shown === 3 && occl.visible.every(k => k === "midpoint"), `visible edges still snap (${JSON.stringify(occl.visible)})`);

  // --- smart measure (the default tool): one click gives a size, two give the relation ---
  const smart = await page.evaluate(() => {
    const { viewer, state, handlePick, setTool } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const faces = p.data.faces;
    const snapF = f => ({ kind: "faceCenter", point: new V3(...f.center), part: p, face: f, normal: new V3(...f.normal), px: 0 });
    const top = faces.find(f => f.normal?.[2] > 0.99), bottom = faces.find(f => f.normal?.[2] < -0.99), side = faces.find(f => Math.abs(f.normal?.[0]) > 0.99);
    setTool("select");
    const read = () => [state.live?.data.title, state.live?.value];
    handlePick(snapF(top)); const one = read();
    handlePick(snapF(bottom)); const par = read();
    handlePick(snapF(top)); handlePick(snapF(side)); const ang = read();
    handlePick(null);
    const ver = document.querySelector("#app-version");
    return { one, par, ang, cleared: state.live === null, version: ver.textContent, verShown: ver.getBoundingClientRect().width > 0, tip: document.querySelector(".brand").title };
  });
  check(smart.one[0] === "Planar face" && near(smart.one[1], 100, 1e-6), `smart: one face gives its area (${smart.one})`);
  check(smart.par[0] === "Parallel faces" && near(smart.par[1], 10, 1e-9), `smart: opposite faces 10 mm apart (${smart.par})`);
  check(smart.ang[0] === "Angle" && near(smart.ang[1], Math.PI / 2, 1e-9), `smart: adjacent faces at 90° (${smart.ang})`);
  check(smart.cleared, "smart: clicking empty space clears the result");
  check(/^v\d+\.\d+\.\d+$/.test(smart.version) && smart.verShown && smart.tip === `MöbiusCAD ${smart.version}`, `version shown under the name at 1400 px and in the logo tooltip (${smart.version}, ${smart.verShown}, ${smart.tip})`);

  // --- pick marker keeps its screen size when zooming, so it never covers the model ---
  const mark = await page.evaluate(() => {
    const { viewer, state, handlePick, setTool, hl } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const faces = p.data.faces;
    const snapF = f => ({ kind: "faceCenter", point: new V3(...f.center), part: p, face: f, normal: new V3(...f.normal), px: 0 });
    setTool("select");
    handlePick(snapF(faces.find(f => f.normal?.[2] > 0.99)));
    handlePick(snapF(faces.find(f => f.normal?.[2] < -0.99)));
    const m = hl.pickMarks.children[0];
    const px = () => { viewer.render(); return m.scale.x / viewer.pxWorld(m.getWorldPosition(new V3())); };
    const far = px(), worldFar = m.scale.x;
    // Zoom in 20x: ortho cameras zoom, perspective ones move closer.
    const cam = viewer.camera, pos0 = cam.position.clone(), zoom0 = cam.zoom;
    if (cam.isOrthographicCamera) { cam.zoom *= 20; cam.updateProjectionMatrix(); }
    else { cam.position.lerp(m.position, 0.95); cam.updateMatrixWorld(); }
    const zoomed = px(), worldNear = m.scale.x;
    cam.position.copy(pos0); cam.zoom = zoom0; cam.updateProjectionMatrix(); cam.updateMatrixWorld(); px();
    const out = { n: hl.pickMarks.children.length, far, zoomed, shrank: worldNear < worldFar / 5, hollow: m.geometry.type };
    handlePick(null);
    return out;
  });
  check(mark.n === 1 && near(mark.far, 6, 1e-6) && near(mark.zoomed, 6, 1e-6) && mark.shrank && mark.hollow === "RingGeometry",
    `pick marker stays a 6 px ring when zooming in (${JSON.stringify(mark)})`);

  // --- smart metric matrix: edges, vertices, planes and the whole part ---
  const mx = await page.evaluate(() => {
    const { viewer, state, handlePick, setTool, showBody } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const faces = p.data.faces, edges = p.data.edges;
    const F = f => ({ kind: "faceCenter", point: new V3(...f.center), part: p, face: f, normal: new V3(...f.normal), px: 0 });
    const E = e => ({ kind: "onEdge", point: new V3(...e.mid), part: p, edge: e, px: 0 });
    const P = (x, e) => ({ kind: "vertex", point: new V3(...x), part: p, edge: e, px: 0 });
    const eq = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const top = faces.find(f => f.normal?.[2] > 0.99), side = faces.find(f => Math.abs(f.normal?.[0]) > 0.99);
    const read = () => {
      const rows = Object.fromEntries(JSON.parse(state.live.data.rows).map(([k, , x]) => [k, x]));
      return { title: state.live.data.title, value: state.live.value, rows };
    };
    const one = x => { handlePick(null); handlePick(x); const r = read(); handlePick(null); return r; };
    const two = (a, b) => { handlePick(null); handlePick(a); handlePick(b); const r = read(); handlePick(null); return r; };
    setTool("select");
    const e0 = edges[0];
    // Edges touching e0 at its start, parallel to it on the same face, and skew to it.
    const touching = edges.find(e => e !== e0 && (eq(e.start, e0.start) || eq(e.end, e0.start)));
    const par = edges.find(e => e !== e0 && Math.abs(dot(e.dir, e0.dir)) > 0.99 && e.faces.some(f => e0.faces.includes(f)));
    const skew = edges.find(e => Math.abs(dot(e.dir, e0.dir)) < 0.01 && !eq(e.start, e0.start) && !eq(e.end, e0.start) && !eq(e.start, e0.end) && !eq(e.end, e0.end));
    // A corner not on top: 10 mm under the top face.
    const low = edges.flatMap(e => [e.start, e.end]).find(x => x[2] < top.center[2] - 5);
    // A corner off e0's line, and how far from it.
    const offLine = edges.flatMap(e => [e.start, e.end]).find(x => { const w = [x[0] - e0.start[0], x[1] - e0.start[1], x[2] - e0.start[2]]; const t = dot(w, e0.dir); return Math.hypot(w[0] - t * e0.dir[0], w[1] - t * e0.dir[1], w[2] - t * e0.dir[2]) > 5; });
    const offW = [offLine[0] - e0.start[0], offLine[1] - e0.start[1], offLine[2] - e0.start[2]], offT = dot(offW, e0.dir);
    const offD = Math.hypot(offW[0] - offT * e0.dir[0], offW[1] - offT * e0.dir[1], offW[2] - offT * e0.dir[2]);
    const r = {
      edge: one(E(e0)), face: one(F(top)),
      ptPlane: two(P(low), F(top)), ptLine: { ...two(P(offLine), E(e0)), expect: offD },
      par: two(E(e0), E(par)), meet: { ...two(E(e0), E(touching)), at: e0.start }, skew: two(E(e0), E(skew)),
      planes: two(F(top), F(side)),
    };
    r.topZ = top.center[2];
    r.mid = [0, 1, 2].map(k => (p.data.bboxMin[k] + p.data.bboxMax[k]) / 2);
    handlePick(F(top)); showBody(p); r.body = read(); handlePick(null);
    return r;
  });
  check(mx.edge.title === "Edge length" && near(mx.edge.value, 10, 1e-9) && mx.edge.rows.Midpoint?.length === 3 && mx.edge.rows.Direction?.length === 3,
    `smart: straight edge gives length, direction and midpoint (${mx.edge.value})`);
  check(near(mx.face.rows.Perimeter, 40, 1e-9) && mx.face.rows.Centroid?.length === 3, `smart: planar face perimeter 40 mm (${mx.face.rows.Perimeter})`);
  check(mx.ptPlane.title === "Point to plane" && near(mx.ptPlane.value, 10, 1e-9) && near(mx.ptPlane.rows["Foot on plane"][2], mx.topZ, 1e-9),
    `smart: corner to top plane 10 mm with its foot on the plane (${mx.ptPlane.value})`);
  check(mx.ptLine.title === "Point to line" && near(mx.ptLine.value, mx.ptLine.expect, 1e-9) && mx.ptLine.rows["Foot on line"]?.length === 3,
    `smart: corner to line, square to it (${mx.ptLine.value} vs ${mx.ptLine.expect})`);
  check(mx.par.title === "Parallel lines" && near(mx.par.value, 10, 1e-9) && near(mx.par.rows["Alignment offset"], 0, 1e-9),
    `smart: parallel edges 10 mm apart, aligned (${mx.par.value}, offset ${mx.par.rows["Alignment offset"]})`);
  check(mx.meet.title === "Angle" && near(mx.meet.value, Math.PI / 2, 1e-9) && mx.meet.rows["Intersection is"] === "on both edges"
    && Math.hypot(...mx.meet.rows.Intersection.map((x, i) => x - mx.meet.at[i])) < 1e-6,
    `smart: touching edges meet at their shared corner at 90° (${mx.meet.rows.Intersection})`);
  check(mx.skew.title === "Angle" && near(mx.skew.rows["Skew distance (lines)"], 10, 1e-9) && near(mx.skew.rows["Shortest distance"], 10, 1e-9),
    `smart: skew edges 10 mm apart (${mx.skew.rows["Skew distance (lines)"]})`);
  check(mx.planes.title === "Angle" && near(Math.abs(mx.planes.rows["Intersection line"][1]), 1, 1e-9),
    `smart: top and side faces meet along Y (${mx.planes.rows["Intersection line"]})`);
  check(mx.body.title === "Part" && near(mx.body.value, 1000, 1e-6) && near(mx.body.rows["Surface area"], 600, 1e-6)
    && mx.body.rows.Box.every(x => near(x, 10, 1e-6)) && mx.body.rows["Centre of gravity"].every((x, i) => near(x, mx.mid[i], 1e-6)),
    `smart: whole part 10×10×10, V=${mx.body.value}, CG ${mx.body.rows["Centre of gravity"]}`);

  // --- readout: ΔX/ΔY/ΔZ triad, units and decimals, click to copy, JSON export ---
  const hud = await page.evaluate(() => {
    const { viewer, state, annotations, handlePick, setUnits, setDecimals } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const e = p.data.edges[0];
    handlePick(null);
    handlePick({ kind: "vertex", point: new V3(...e.start), part: p, edge: e, px: 0 });
    handlePick({ kind: "vertex", point: new V3(...e.end), part: p, edge: e, px: 0 });
    const axes = [];
    annotations.root.children.at(-1).traverse(o => { if (o.userData.axis) axes.push(o.userData.axis); });
    const legLabels = [...document.querySelectorAll("#labels .m-leg")].filter(el => el.dataset.id === state.live.id).map(el => el.textContent);
    const origin = window.__sv.originAxes;
    const tags = [...document.querySelectorAll("#labels .axis-tag")].filter(el => !el.hidden).map(el => el.textContent).join("");
    const val = () => document.querySelector("#readout .val").textContent.trim();
    const mm = val();
    setUnits("ft"); const ft = val();
    setDecimals("2"); const ft2 = val();
    setUnits("mm"); setDecimals("");
    document.querySelector("#readout .val .cp").click();
    const copied = state.lastCopied;
    const box = document.querySelector("#readout");
    const docked = !box.classList.contains("floating") && box.style.left === "";
    box.querySelector(".dock").click();
    const floating = box.classList.contains("floating") && box.style.left !== "";
    box.querySelector(".dock").click();
    const ortho = viewer.camera.isOrthographicCamera === true && document.querySelector('[data-proj="orthographic"]').classList.contains("on");
    const parts = state.live.data.parts;
    document.querySelector("#readout .acts button").click(); // Pin
    return { title: state.measurements.at(-1)?.data.title, triad: state.measurements.at(-1)?.data.triad, axes, legLabels, origin: origin.visible && origin.children.length, tags, mm, ft, ft2, copied, floating, docked, parts, ortho };
  });
  check(hud.title === "Distance" && Array.isArray(hud.triad) && hud.axes.length === 1 && hud.legLabels.join() === "ΔZ 10.000 mm",
    `smart: point to point draws the axis legs with their dimensions (${hud.axes.join(",")}: ${hud.legLabels.join(", ")})`);
  check(hud.origin === 3 && hud.tags === "XYZ", `origin axes shown with X, Y, Z tags (${hud.origin}, ${hud.tags})`);
  check(hud.mm === "10.000 mm" && hud.ft === "0.03281 ft" && hud.ft2 === "0.03 ft", `readout units and decimals: ${hud.mm} / ${hud.ft} / ${hud.ft2}`);
  check(hud.copied === "10.000", `click copies the bare value (${hud.copied})`);
  check(hud.docked && hud.floating, `readout docked in the corner by default, floats on request (${hud.docked}, ${hud.floating})`);
  check(hud.ortho, "orthographic projection by default");
  check(/Cube 10x10 #1$/.test(hud.parts ?? ""), `measurement records its component (${hud.parts})`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.$eval("#m-json", el => el.click())]);
  const json = JSON.parse(await readFile(await dl.path(), "utf8"));
  const last = json.measurements.at(-1);
  check(json.units.length === "mm" && last.title === "Distance" && near(last.value, 10, 1e-9) && last.rows.some(r => r.label === "ΔX") && last.points.length === 2,
    `JSON export: ${json.measurements.length} measurements, last ${last.title} ${last.value}`);

  // --- user CSYS: values re-expressed in a frame on an edge ---
  const cs = await page.evaluate(() => {
    const { viewer, state, handlePick, setCsys, csysFrom } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const e = p.data.edges.find(x => x.type === "line" && Math.abs(x.dir[0]) < 0.5);
    const V = x => ({ kind: "vertex", point: new V3(...x), part: p, edge: e, px: 0 });
    const det = () => [...document.querySelectorAll("#readout .det span")].map(s => s.textContent.trim());
    handlePick(null);
    setCsys(csysFrom({ kind: "edge", point: new V3(...e.mid), part: p, edge: e }));
    handlePick(V(e.start)); const origin = state.live && document.querySelector("#readout .val").textContent.trim();
    handlePick(V(e.end)); const local = det().filter(t => t.startsWith("Δ"));
    const reset = !document.querySelector("#csys-reset").hidden;
    setCsys(null); const world = det().filter(t => t.startsWith("Δ"));
    handlePick(null);
    return { origin, local, world, reset, dir: e.dir };
  });
  check(cs.origin === "X 0.000  Y 0.000  Z 0.000" && cs.reset, `CSYS on an edge: its start is the origin (${cs.origin})`);
  check(cs.local.join("|") === "ΔX 10.000 mm|ΔY 0.000 mm|ΔZ 0.000 mm" && cs.world.join("|") !== cs.local.join("|"),
    `CSYS on an edge: ΔX runs along it (${cs.local.join(", ")}; global ${cs.world.join(", ")})`);

  // --- section: caps, profile curves, cut area, snapping and measuring on the cut ---
  await page.$eval('[data-sec="z"]', el => el.click());
  await page.waitForTimeout(200);
  const sec = await page.evaluate(() => {
    const { viewer, section, state, handlePick, setTool } = window.__sv;
    const V3 = viewer.camera.position.constructor;
    const sp = section.planes[0];
    const area = sp.result.area;
    const edges = section.profiles().flatMap(p => p.edges);
    const part = viewer.parts[0];
    const lines = edges.filter(e => e.type === "line");
    // Opposite sides of the 10×10 square cut.
    const a = lines[0], b = lines.find(e => Math.abs(e.dir[0] * a.dir[0] + e.dir[1] * a.dir[1] + e.dir[2] * a.dir[2]) > 0.99 && e !== a);
    state.measurements = [];
    setTool("minDistance");
    handlePick({ kind: "onEdge", point: new V3(...a.mid), part, edge: a, section: true, px: 0 });
    handlePick({ kind: "onEdge", point: new V3(...b.mid), part, edge: b, section: true, px: 0 });
    setTool("select");
    // A second and third plane, then a fourth must be refused.
    document.querySelector('[data-sec="x"]').click();
    document.querySelector('[data-sec="y"]').click();
    const fourth = section.add("extra", new V3(1, 1, 0), 0);
    return {
      planes: viewer.clipPlanes.length, area, quarter: sp.result.area, curves: edges.length, lines: lines.length,
      gap: state.measurements[0]?.value, fourth: fourth === null,
    };
  });
  check(near(sec.area, 100, 1e-6), `Z cut of the cube has area 100 mm² (${sec.area})`);
  check(near(sec.quarter, 25, 1e-6), `with X and Y planes too the Z cut is a quarter (${sec.quarter})`);
  check(sec.curves === 4 && sec.lines === 4, `cut profile is 4 straight curves (${sec.lines}/${sec.curves})`);
  check(near(sec.gap, 10, 1e-6), `distance across the cut 10 mm (${sec.gap})`);
  check(sec.planes === 3 && sec.fourth, `three planes at most (${sec.planes} active, fourth refused: ${sec.fourth})`);

  // 3-point plane
  const p3 = await page.evaluate(() => {
    const { section } = window.__sv;
    const V3 = window.__sv.viewer.camera.position.constructor;
    section.clear();
    const sp = section.addFromPoints([new V3(0, 0, 4), new V3(10, 0, 4), new V3(0, 10, 4)]);
    return { axisZ: Math.abs(sp.axis.z), offset: Math.abs(sp.offset) };
  });
  check(near(p3.axisZ, 1, 1e-9) && near(p3.offset, 4, 1e-9), `3-point plane z=4 (|nz| ${p3.axisZ}, |offset| ${p3.offset})`);

  // Drag arrows: a new plane shows a see-through sheet with two arrows along its normal; dragging one slides the plane, not the camera.
  await page.evaluate(() => { const { viewer } = window.__sv; const V3 = viewer.camera.position.constructor; viewer.viewFrom(new V3(1, -1, 0.6).normalize(), false); viewer.invalidate(); });
  await page.waitForTimeout(500);
  const arrowAt = await page.evaluate(() => {
    const { section, viewer } = window.__sv;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const a = section.arrowScreen(0, 0.75), b = section.arrowScreen(0, 1);
    const sp = section.active;
    return { x: r.left + a.x, y: r.top + a.y, dx: b.x - a.x, dy: b.y - a.y, offset: sp.offset, mode: section.gizmoMode, cam: viewer.camera.position.toArray() };
  });
  const len = Math.hypot(arrowAt.dx, arrowAt.dy) || 1;
  await page.mouse.move(arrowAt.x, arrowAt.y);
  await page.waitForTimeout(100);
  const cursor = await page.evaluate(() => window.__sv.viewer.renderer.domElement.style.cursor);
  await page.mouse.down();
  for (let k = 1; k <= 5; k++) await page.mouse.move(arrowAt.x + arrowAt.dx / len * 12 * k, arrowAt.y + arrowAt.dy / len * 12 * k);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const dragged = await page.evaluate(() => {
    const { section, viewer } = window.__sv;
    return { offset: section.planes[0].offset, cam: viewer.camera.position.toArray(), active: section.active === section.planes[0] };
  });
  const camMoved = Math.hypot(...dragged.cam.map((x, i) => x - arrowAt.cam[i]));
  check(arrowAt.mode === "translate" && dragged.active && cursor === "grab" && dragged.offset > arrowAt.offset + 0.5 && camMoved < 1e-6,
    `section arrows: dragging the arrow moves the plane along its normal (${arrowAt.offset.toFixed(3)} → ${dragged.offset.toFixed(3)} mm, cursor ${cursor}, camera moved ${camMoved})`);

  // Section button, then a face click: the plane appears on that face (CAD-style), with its arrows at the click.
  await page.evaluate(() => { const { section, renderSections } = window.__sv; section.clear(); renderSections(); document.querySelector("#rt-props").click(); });
  await page.click("#rt-section");
  const armed = await page.evaluate(() => {
    const { state, viewer } = window.__sv;
    const part = viewer.parts[0];
    const dir = viewer.camera.getWorldDirection(viewer.camera.position.clone());
    // A planar face turned towards the camera; click its centroid.
    const f = part.data.faces.filter(f => f.type === "plane" && f.normal)
      .sort((a, b) => (a.normal[0] * dir.x + a.normal[1] * dir.y + a.normal[2] * dir.z) - (b.normal[0] * dir.x + b.normal[1] * dir.y + b.normal[2] * dir.z))[0];
    const c = viewer.toWorld(part, f.centroid);
    const s = c.clone().project(viewer.camera);
    const r = viewer.renderer.domElement.getBoundingClientRect();
    return { tool: state.tool, hint: document.querySelector("#tool-hint").textContent, n: f.normal, x: r.left + (s.x + 1) / 2 * r.width, y: r.top + (1 - s.y) / 2 * r.height };
  });
  await page.mouse.click(armed.x, armed.y);
  await page.waitForTimeout(150);
  const onFace = await page.evaluate(() => {
    const { state, section } = window.__sv;
    const sp = section.planes[0];
    return { tool: state.tool, planes: section.planes.length, axis: sp && sp.axis.toArray(), anchored: !!sp?.anchor, arrows: section.gizmoMode };
  });
  check(armed.tool === "sectionFace" && /flat face/.test(armed.hint) && onFace.planes === 1 && onFace.tool === "select" && onFace.anchored && onFace.arrows === "translate"
    && onFace.axis.every((x, i) => Math.abs(x - armed.n[i]) < 1e-6),
    `section button: press Section, click a face, the plane lies on that face with its arrows (${JSON.stringify({ armed: armed.tool, onFace })})`);

  // --- CAX-IF as1 assembly: tree, circles and holes ---
  await open("cax-if/as1-oc-214.stp");
  const as1 = await page.evaluate(() => {
    const { viewer } = window.__sv;
    const edges = viewer.parts.flatMap(p => p.data.edges);
    const faces = viewer.parts.flatMap(p => p.data.faces);
    return {
      parts: viewer.parts.length,
      treeRows: document.querySelectorAll("#tree .node").length,
      circles: edges.filter(e => e.type === "circle" || e.type === "arc").length,
      cylinders: faces.filter(f => f.type === "cylinder").length,
      allClosed: viewer.parts.every(p => p.data.closed),
      protocol: document.querySelector("#props").innerText.includes("AP214"),
    };
  });
  check(as1.parts >= 10 && as1.treeRows > as1.parts, `as1 assembly: ${as1.parts} parts, ${as1.treeRows} tree rows`);
  check(as1.circles > 0 && as1.cylinders > 0, `as1 circles ${as1.circles}, cylinders ${as1.cylinders}`);
  check(as1.allClosed, "every as1 part is a closed solid");
  check(as1.protocol, "header shows AP214");

  // Plate thickness with smart measure: the biggest planar face (holes make it many triangles) against
  // its opposite face. A brute-force triangle search froze the app for ~30 s on a 4,000-triangle PCB face.
  const thk = await page.evaluate(() => {
    const { viewer, state, handlePick, setTool } = window.__sv;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let best = null;
    for (const p of viewer.parts) for (const A of p.data.faces) {
      if (A.type !== "plane" || (best && A.triCount <= best.A.triCount)) continue;
      const B = p.data.faces.filter(f => f.type === "plane" && dot(f.normal, A.normal) < -1 + 1e-9 && f.triCount > 1)
        .sort((x, y) => Math.abs(dot([x.centroid[0] - A.centroid[0], x.centroid[1] - A.centroid[1], x.centroid[2] - A.centroid[2]], A.normal))
          - Math.abs(dot([y.centroid[0] - A.centroid[0], y.centroid[1] - A.centroid[1], y.centroid[2] - A.centroid[2]], A.normal)))
        .find(f => f.area > 0.5 * A.area);
      if (B) best = { p, A, B };
    }
    const { p, A, B } = best;
    const V3 = p.group.position.constructor;
    const snapF = f => ({ kind: "onFace", point: new V3(...f.centroid), part: p, face: f, normal: new V3(...f.normal), px: 0 });
    const gap = Math.abs(dot([B.centroid[0] - A.centroid[0], B.centroid[1] - A.centroid[1], B.centroid[2] - A.centroid[2]], A.normal));
    setTool("select"); handlePick(null);
    const t0 = performance.now();
    handlePick(snapF(A)); handlePick(snapF(B));
    const ms = performance.now() - t0;
    const r = [state.live?.data.title, state.live?.value];
    // A straight edge of the opposite face against the big face: the same gap, through the face's BVH.
    const e = p.data.edges.find(x => x.type === "line" && Math.abs(dot(x.dir, A.normal)) < 1e-9
      && Math.abs(Math.abs(dot([x.mid[0] - A.centroid[0], x.mid[1] - A.centroid[1], x.mid[2] - A.centroid[2]], A.normal)) - gap) < 1e-6);
    setTool("minDistance");
    handlePick({ kind: "onEdge", point: new V3(...e.mid), part: p, edge: e, px: 0 }); handlePick(snapF(A));
    const ef = state.measurements.at(-1)?.value;
    setTool("select"); handlePick(null);
    return { tris: A.triCount + B.triCount, gap, r, ms, ef };
  });
  check(thk.r[0] === "Parallel faces" && near(thk.r[1], thk.gap, 1e-6), `smart: plate thickness ${thk.r} = plane gap ${thk.gap}`);
  check(thk.ms < 1000, `smart: plate thickness over ${thk.tris} triangles in ${thk.ms.toFixed(0)} ms`);
  check(near(thk.ef, thk.gap, 1e-4), `edge to big face ${thk.ef} = gap ${thk.gap}`);

  // Quadrant snaps: at the radius, in the plane, and only where an arc actually runs (STEP halves get 2-3 each).
  const quad = await page.evaluate(() => {
    const { viewer, quadrants } = window.__sv;
    const V3 = viewer.camera.position.constructor;
    const circles = viewer.parts.flatMap(p => p.data.edges).filter(e => e.type === "circle" || e.type === "arc");
    let worst = 0, counts = new Set();
    for (const e of circles) {
      const q = quadrants(e), c = new V3(...e.center), n = new V3(...e.axis);
      counts.add(q.length);
      for (const p of q) worst = Math.max(worst, Math.abs(p.distanceTo(c) - e.radius), Math.abs(p.clone().sub(c).dot(n)));
    }
    return { circles: circles.length, counts: [...counts].sort(), worst };
  });
  check(quad.circles > 0 && quad.counts.every(n => n <= 4) && quad.counts.some(n => n >= 2 && n < 4) && quad.worst < 1e-9,
    `quadrants on ${quad.circles} circles/arcs: ${quad.counts.join(", ")} per edge (max error ${quad.worst})`);

  // Coplanar round faces of two different parts: pitch between their centres, never 0.
  const pitch = await page.evaluate(() => {
    const { viewer, state, handlePick, setTool } = window.__sv;
    const V3 = viewer.camera.position.constructor;
    setTool("select");
    const rounds = [];
    for (const p of viewer.parts) for (const f of p.data.faces) {
      if (f.type !== "plane") continue;
      handlePick({ kind: "faceCenter", point: viewer.toWorld(p, f.center), part: p, face: f, normal: new V3(...f.normal), px: 0 });
      if (state.live?.data.title === "Circular face") rounds.push({ p, f, c: viewer.toWorld(p, f.center) });
      handlePick(null);
    }
    for (const a of rounds) for (const b of rounds) {
      if (a.p === b.p || Math.abs(new V3(...a.f.normal).dot(new V3(...b.f.normal))) < 0.999999) continue;
      if (Math.abs(b.c.clone().sub(a.c).dot(new V3(...a.f.normal))) > 1e-6) continue;
      const pick = r => ({ kind: "faceCenter", point: r.c, part: r.p, face: r.f, normal: new V3(...r.f.normal), px: 0 });
      handlePick(pick(a)); handlePick(pick(b));
      const res = { rounds: rounds.length, title: state.live.data.title, value: state.live.value, expect: a.c.distanceTo(b.c) };
      const [da, db] = JSON.parse(state.live.data.rows).find(r => r[0] === "Ø")[2];
      const { setCircleMode } = window.__sv;
      setCircleMode("min"); res.min = [state.live.data.title, state.live.value, res.expect - (da + db) / 2];
      setCircleMode("max"); res.max = [state.live.data.title, state.live.value, res.expect + (da + db) / 2];
      setCircleMode("center"); res.back = state.live.value;
      res.legs = [...document.querySelectorAll("#labels .m-leg")].filter(el => el.dataset.id === state.live.id).map(el => [el.dataset.axis, parseFloat(el.textContent.slice(3))]);
      const d = b.c.clone().sub(a.c);
      res.expectLegs = [["X", Math.abs(d.x)], ["Y", Math.abs(d.y)], ["Z", Math.abs(d.z)]].filter(([, x]) => x > 1e-6);
      res.toggle = document.querySelectorAll("#readout [data-cmode]").length;
      return res;
    }
    return { rounds: rounds.length };
  });
  check(pitch.title === "Pitch (axis to axis)" && near(pitch.value, pitch.expect, 1e-3) && pitch.value > 0,
    `smart: coplanar round faces give the pitch (${pitch.rounds} round faces, ${pitch.value} vs ${pitch.expect})`);
  check(pitch.legs?.length === pitch.expectLegs?.length && pitch.legs.every(([k, x], i) => k === pitch.expectLegs[i][0] && near(x, pitch.expectLegs[i][1], 2e-3)),
    `smart: centre to centre draws ΔX/ΔY/ΔZ legs with dimensions (${JSON.stringify(pitch.legs)})`);
  check(pitch.toggle === 3 && near(pitch.min?.[1], pitch.min?.[2], 1e-3) && near(pitch.max?.[1], pitch.max?.[2], 1e-3) && near(pitch.back, pitch.value, 1e-9),
    `smart: round features toggle min ${pitch.min?.[1]} / max ${pitch.max?.[1]} edge distance`);

  // explode moves parts apart
  await page.$eval("#explode", el => { el.value = "1"; el.dispatchEvent(new Event("input")); });
  const moved = await page.evaluate(() => window.__sv.viewer.parts.filter(p => p.group.position.length() > 1e-6).length);
  check(moved > 0, `explode moved ${moved} parts`);

  // --- virtual corners: where a rounded corner's straight edges would meet ---
  await open("rounded-cube/rounded-cube.step");
  const vc = await page.evaluate(() => {
    const { viewer, virtualCorners } = window.__sv;
    const p = viewer.parts[0];
    const fs = p.data.faces.filter(f => f.type === "plane" && p.data.edges.some(e => f.edges.includes(e.id) && e.type !== "line"));
    return { faces: fs.length, corners: fs.map(f => virtualCorners(p, f)), max: p.data.bboxMax, plain: virtualCorners(p, p.data.faces.find(f => f.type === "plane" && f.edges.every(i => p.data.edges[i].type === "line"))).length };
  });
  check(vc.faces === 2 && vc.corners.every(c => c.length === 1 && Math.abs(c[0][0] - vc.max[0]) < 1e-6 && Math.abs(c[0][2] - vc.max[2]) < 1e-6) && vc.plain === 0,
    `intersection snaps: the rounded corner's sharp point on ${vc.faces} faces (${JSON.stringify(vc.corners)}), none on a plain square`);

  // --- freeform face: radii of curvature from the tessellation (a cone: finite across, flat along) ---
  await open("conical-surface/conical-surface.step");
  const cone = await page.evaluate(() => {
    const { viewer, state, handlePick } = window.__sv;
    const p = viewer.parts[0];
    const V3 = p.group.position.constructor;
    const f = p.data.faces.find(x => x.type === "other");
    handlePick({ kind: "onFace", point: viewer.toWorld(p, f.centroid), part: p, face: f, normal: new V3(0, 0, 1), px: 0 });
    const rows = Object.fromEntries(JSON.parse(state.live.data.rows).map(([k, , x]) => [k, x]));
    handlePick(null);
    return { min: rows["Min radius of curvature ≈"], max: rows["Max radius of curvature ≈"] };
  });
  check(typeof cone.min === "number" && cone.min > 1 && cone.min < 20 && /flat/.test(cone.max), `smart: cone face curvature radii ${cone.min} / ${cone.max}`);

  // --- UI standards on the 3D side: inline field validation, keyboard tree ---
  const ui3d = await page.evaluate(async () => {
    const d = document.querySelector("#density"), err = document.querySelector("#density-err");
    d.value = ""; d.dispatchEvent(new Event("input"));
    const r = { shown: !err.hidden && /density/i.test(err.textContent), invalid: d.getAttribute("aria-invalid"), disabled: document.querySelector("#mass-run").disabled, role: err.getAttribute("role"), described: d.getAttribute("aria-describedby") };
    d.value = "7.85"; d.dispatchEvent(new Event("input"));
    r.cleared = err.hidden && d.getAttribute("aria-invalid") === "false" && !document.querySelector("#mass-run").disabled;
    const rows = [...document.querySelectorAll("#tree .row-n")];
    r.treeRole = rows[0]?.getAttribute("role");
    r.firstTabbable = rows[0]?.tabIndex === 0;
    return r;
  });
  await page.focus("#tree .row-n");
  await page.keyboard.press("ArrowDown");
  const treeKey = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#tree .row-n")];
    return { moved: rows.length < 2 || document.activeElement === rows[1] };
  });
  await page.keyboard.press("Enter");
  const treeSel = await page.evaluate(() => document.activeElement?.getAttribute("aria-selected"));
  check(ui3d.shown && ui3d.invalid === "true" && ui3d.disabled && ui3d.role === "alert" && ui3d.described === "density-err" && ui3d.cleared, `ui: density field shows an inline error and clears it (${JSON.stringify(ui3d)})`);
  check(ui3d.treeRole === "treeitem" && ui3d.firstTabbable && treeKey.moved && treeSel === "true", "ui: model tree is reachable and operable with the keyboard");

  // --- PCB view: a zipped Gerber + Excellon set, layers, snapping and measurements ---
  await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/board.zip")}`);
  await page.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
  const pcb = await page.evaluate(() => {
    const g = window.__sv.gerber;
    g.setUnits("mm"); g.setDecimals(3);
    const L = label => g.layers.find(l => l.L.label === label);
    const find = (label, pred) => { const l = L(label); const fi = l.L.objs.findIndex(pred); return fi < 0 ? null : { lid: l.id, fi }; };
    const cu = "Top copper";
    const pad1 = find(cu, o => o.t === "flash" && o.x === 10), pad2 = find(cu, o => o.t === "flash" && o.x === 12.54);
    const rectPad = find(cu, o => o.t === "flash" && o.x === 20), track = find(cu, o => o.t === "track");
    const arc = find(cu, o => o.t === "arc"), macro = find(cu, o => o.t === "flash" && o.x === 5 && o.y === 15);
    const holed = find(cu, o => o.t === "flash" && o.x === 5 && o.y === 5), region = find(cu, o => o.t === "region" && o.dark);
    const edge = find("Board outline", o => o.t === "track");
    const npth = find("Drill (NPTH)", o => o.t === "hole"), slot = find("Drill (PTH)", o => o.t === "slot");
    const rows = m => Object.fromEntries(m.rows());
    const r = { mode: document.querySelector("#app").classList.contains("gerber"), labels: g.layers.map(l => l.L.label).sort(), name: g.name };
    // Smart: one pad, then a second one -> pitch and clearance.
    g.setTool("smart");
    g.clickPick({ p: [10, 10], kind: "center", feat: pad1 });
    r.one = [g.live.title, g.live.text(), rows(g.live).Net, rows(g.live).Pin];
    g.clickPick({ p: [12.54, 10], kind: "center", feat: pad2 });
    r.pair = [g.live.title, g.live.value, rows(g.live).Clearance];
    g.clickPick({ p: [0, 0], kind: "free", feat: null });
    r.cleared = g.live === null;
    const info = f => { g.clickPick({ p: [0, 0], kind: "free", feat: null }); g.clickPick({ p: [0, 0], kind: "free", feat: f }); const m = g.live; return [m.title, m.text(), rows(m)]; };
    r.macro = info(macro)[1];
    const a = info(arc); r.arc = [a[1], a[2].Radius, a[2].Sweep];
    r.track = info(track)[2].Length;
    r.region = info(region)[1];
    r.npth = info(npth); r.slot = info(slot)[2].Length;
    r.outline = info(edge)[2]["Closed outline"];
    g.clickPick({ p: [0, 0], kind: "free", feat: null });
    // Shift+click areas: closed outline (with an arc corner) and a pad with a hole.
    r.loop = g.shapeArea(edge).value;
    r.holed = g.shapeArea(holed).value;
    // Clearance between the rectangular pad and the track above it.
    g.setTool("clearance");
    g.clickPick({ p: [20, 10], kind: "center", feat: rectPad }); g.clickPick({ p: [20, 15], kind: "edge", feat: track });
    r.clear = g.measurements.at(-1).value;
    // Point to point through real screen-space snapping.
    g.setTool("distance");
    g.render(); g.setMirror(false); g.fit();
    const snapAt = (x, y, dx = 0, dy = 0) => { const s = g.toScreen(x, y); g.moveTo(s[0] + dx, s[1] + dy); return { kind: g.snap.kind, p: g.snap.p }; };
    r.snapCenter = snapAt(10, 10, 3, -2);
    r.snapEdge = snapAt(20.6, 15.125, 0, -2);
    const s1 = g.toScreen(10, 10), s2 = g.toScreen(12.54, 10);
    g.picks = [{ p: [22, 10], kind: "free", feat: null }];
    r.snapPerp = snapAt(22.05, 14.875, 0, 3);
    g.picks = [];
    g.click(s1[0] + 2, s1[1] + 2); g.click(s2[0] - 2, s2[1] + 1);
    const d = g.measurements.at(-1);
    r.dist = [d.value, rows(d)["ΔX"], rows(d)["ΔY"]];
    g.setUnits("mil"); r.mil = d.text(); g.setUnits("in"); r.inch = d.text(); g.setUnits("mm");
    // Polyline and polygon area from free points.
    g.setTool("polyline");
    for (const p of [[0, 0], [30, 0], [30, 18]]) g.clickPick({ p, kind: "free", feat: null });
    g.finish(); r.poly = g.measurements.at(-1).value;
    g.setTool("area");
    for (const p of [[0, 0], [10, 0], [10, 10], [0, 10]]) g.clickPick({ p, kind: "free", feat: null });
    g.finish(); r.area = g.measurements.at(-1).value;
    r.count = g.measurements.length;
    // Hiding a layer removes it from picking; reordering keeps measurements.
    const ci = g.layers.findIndex(l => l.L.label === cu);
    g.setLayerStyle(ci, { visible: false }); r.hiddenHit = g.hitTest(5, 15); g.setLayerStyle(ci, { visible: true }); r.shownHit = !!g.hitTest(12.54, 10);
    g.moveLayer(ci, g.layers.length - 1); r.afterMove = g.relation(pad1, pad2).value;
    // Hide / delete measurements, exports.
    g.measurements[0].visible = false;
    g.deleteMeasurement(g.measurements.at(-1).id); r.afterDelete = g.measurements.length;
    const svg = g.svg(); r.svg = [svg.startsWith("<svg"), svg.includes("<mask"), svg.includes("2.540 mm")];
    r.csv = g.csv().split("\n").length;
    g.render(); g.paintOverlay();
    const s = g.toScreen(12.54 + 0.6, 10);
    const px = document.querySelector("#g-canvas").getContext("2d").getImageData(Math.round(s[0] * devicePixelRatio), Math.round(s[1] * devicePixelRatio), 1, 1).data;
    r.pixel = [...px.slice(0, 3)];
    r.panel = { visible: g.layers.every(l => l.visible), sliders: document.querySelectorAll("#g-layers input[type=range], #g-layers .x").length, addBtn: !!document.querySelector("#g-add-btn") };
    r.ui = { layersListed: document.querySelectorAll("#g-layers .g-layer").length, list: document.querySelectorAll("#g-m-list .m-item").length, stats: document.querySelector("#g-stats").textContent };
    return r;
  });
  const near3 = (a, b) => near(a, b, 1e-6);
  check(pcb.mode && JSON.stringify(pcb.labels) === JSON.stringify(["Board outline", "Drill (NPTH)", "Drill (PTH)", "Top copper"]), `pcb: zip opens four classified layers (${pcb.labels})`);
  check(pcb.one[0] === "Pad" && pcb.one[1] === "Ø1.600 mm" && pcb.one[2] === "GND" && pcb.one[3] === "J1 1", `pcb smart: pad size and X2 net/pin (${pcb.one})`);
  check(pcb.pair[0].startsWith("Pitch") && near3(pcb.pair[1], 2.54) && pcb.pair[2] === "0.940 mm" && pcb.cleared, `pcb smart: pitch 2.54 and clearance 0.94 (${pcb.pair})`);
  check(pcb.macro === "0.500 × 1.000 mm", `pcb: rotated macro pad 0.5 × 1.0 (${pcb.macro})`);
  check(pcb.arc[0] === "w 0.250 mm" && pcb.arc[1] === "2.000 mm" && pcb.arc[2] === "90.00°", `pcb: arc track width, radius, sweep (${pcb.arc})`);
  check(pcb.track === "10.000 mm" && pcb.region === "4.000 mm²", `pcb: track length and region area (${pcb.track}, ${pcb.region})`);
  check(pcb.npth[0] === "Drill hole" && pcb.npth[1] === "Ø3.175 mm" && pcb.npth[2].Centre === "X 25.400  Y 12.700" && /NPTH/.test(pcb.npth[2].Plating), `pcb: inch Excellon (TZ) hole Ø3.175 at 25.4, 12.7 (${JSON.stringify(pcb.npth)})`);
  check(pcb.slot === "3.000 mm", `pcb: G85 slot length 3 mm (${pcb.slot})`);
  check(near(pcb.loop, 600 - (4 - Math.PI), 1e-6) && /599\.142 mm², perimeter 99\.142 mm/.test(pcb.outline), `pcb: board outline area with an arc corner (${pcb.loop}, ${pcb.outline})`);
  check(near(pcb.holed, Math.PI * (0.16 - 0.04), 1e-9), `pcb: pad area minus its hole (${pcb.holed})`);
  check(near3(pcb.clear, 15 - 0.125 - 10.6), `pcb: rect pad to track clearance 4.275 (${pcb.clear})`);
  check(pcb.snapCenter.kind === "center" && near3(pcb.snapCenter.p[0], 10), `pcb snap: pad centre (${JSON.stringify(pcb.snapCenter)})`);
  check(pcb.snapEdge.kind === "edge" && near3(pcb.snapEdge.p[1], 15.125), `pcb snap: track edge (${JSON.stringify(pcb.snapEdge)})`);
  check(pcb.snapPerp.kind === "perp" && near3(pcb.snapPerp.p[0], 22) && near3(pcb.snapPerp.p[1], 14.875), `pcb snap: perpendicular foot on a track edge (${JSON.stringify(pcb.snapPerp)})`);
  check(near3(pcb.dist[0], 2.54) && pcb.dist[1] === "2.540 mm" && pcb.dist[2] === "0.000 mm", `pcb point–point: 2.54 with ΔX/ΔY (${pcb.dist})`);
  check(pcb.mil === "100.000 mil" && pcb.inch === "0.100 in", `pcb units: mil and inch (${pcb.mil}, ${pcb.inch})`);
  check(near3(pcb.poly, 48) && near3(pcb.area, 100) && pcb.count === 4, `pcb: polyline 48 and area 100 (${pcb.poly}, ${pcb.area})`);
  check(pcb.hiddenHit === null && pcb.shownHit && near3(pcb.afterMove, 2.54) && pcb.afterDelete === 3, "pcb: hidden layers are not picked; reorder and delete keep the list consistent");
  check(pcb.svg.every(Boolean) && pcb.csv === 5, `pcb: SVG (with clear-polarity mask and labels) and CSV export (${pcb.svg}, ${pcb.csv} lines)`);
  check(pcb.pixel[0] > 150 && pcb.pixel[1] > 100 && pcb.pixel[2] < 120, `pcb: copper pad drawn in copper colour (${pcb.pixel})`);
  check(pcb.ui.layersListed === 4 && pcb.ui.list === 3 && /Board30\.000 × 20\.000 mm/.test(pcb.ui.stats), `pcb: layer panel, measurement list and board size (${pcb.ui.stats})`);

  check(pcb.panel.visible && pcb.panel.sliders === 0 && !pcb.panel.addBtn, `pcb: all layers shown, panel has only show/hide and colour (${JSON.stringify(pcb.panel)})`);

  // --- 3D board from the Gerber set: geometry, picking and measuring in 3D, board body in the model view ---
  {
    await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/board.zip")}`);
    await page.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
    await page.click('[data-gdim="3d"]');
    await page.waitForTimeout(400);
    const b3 = await page.evaluate(async () => {
      const g = window.__sv.gerber;
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      g.setUnits("mm"); g.setDecimals(3);
      const r = { is3d: g.is3d, pressed: document.querySelector('[data-gdim="3d"]').getAttribute("aria-pressed"), canvas: getComputedStyle(document.querySelector("#g-3d")).display, flat: getComputedStyle(document.querySelector("#g-canvas")).display, info: { ...g.b3.info } };
      g.b3.renderNow();
      const meshes = []; g.b3.scene.traverse(o => o.isMesh && meshes.push(o));
      r.faces = meshes.filter(m => (m.name === "top" || m.name === "bottom") && m.material.map).length;
      r.stacked = meshes.filter(m => m.material.alphaMap || m.material.alphaTest > 0 || (m.material.transparent && m.material.opacity < 1)).length;
      const c = document.querySelector("#g-3d"), s = g.toScreen(15, 4);
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const px = new Uint8Array(4);
      gl.readPixels(Math.round(s[0] * c.width / c.clientWidth), Math.round(c.height - s[1] * c.height / c.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      r.pixel = [...px.slice(0, 3)];
      const q = g.toBoard(...g.toScreen(12.54, 10)); r.round = Math.hypot(q[0] - 12.54, q[1] - 10);
      // Smart measure through real screen-space picking on the top face.
      g.setTool("smart");
      const at = (x, y, dx = 0, dy = 0) => { const p = g.toScreen(x, y); return [p[0] + dx, p[1] + dy]; };
      g.click(...at(5, 15)); r.macro = g.live && [g.live.title, g.live.text()];
      g.click(...at(25.4, 12.7)); r.pair = g.live && [g.live.title, g.live.value];
      g.cancel();
      // Point to point with snapping to hole centres.
      g.setTool("distance");
      g.moveTo(...at(10, 10, 2, 1)); g.click(...at(10, 10, 2, 1)); g.moveTo(...at(12.54, 10, -1, 2)); g.click(...at(12.54, 10, -1, 2));
      r.dist = g.measurements.at(-1)?.value;
      // Bottom view: top-side layers are no longer picked, drills still are.
      g.setMirror(true); await frame();
      r.bottom = g.b3.bottom; r.topHidden = g.hitTest(5, 15) === null; r.holeSeen = !!g.hitTest(25.4, 12.7);
      r.flipPressed = document.querySelector("[data-gview=flip]").getAttribute("aria-pressed");
      g.setMirror(false); await frame();
      // Thickness rebuilds the board.
      const t = document.querySelector("#g-thick"); t.value = "2.4"; t.dispatchEvent(new Event("change"));
      await frame();
      r.thick = g.b3.info.thickness;
      g.set3d(false); r.back2d = !g.is3d && getComputedStyle(document.querySelector("#g-canvas")).display !== "none";
      return r;
    });
    check(b3.is3d && b3.pressed === "true" && b3.canvas === "block" && b3.flat === "none", `pcb 3d: switch shows the 3D canvas (${JSON.stringify([b3.pressed, b3.canvas, b3.flat])})`);
    check(b3.info.outline && b3.info.holes === 5 && b3.info.cutHoles === 5 && b3.info.barrels === 3 && b3.info.skins === 1 && b3.info.area > 580 && b3.info.area < 599.142, `pcb 3d: outline extruded with 5 holes cut, 3 plated barrels, copper skin (${JSON.stringify(b3.info)})`);
    check(b3.faces === 2 && b3.stacked === 0, `pcb 3d: one textured surface per side, no stacked see-through skins to flicker (${b3.faces}, ${b3.stacked})`);
    check(b3.pixel[0] > 60 && b3.pixel.some(v => v > 40), `pcb 3d: board rendered (${b3.pixel})`);
    check(b3.round < 1e-6, `pcb 3d: screen ↔ board mapping round trip (${b3.round})`);
    check(b3.macro?.[0] === "Pad" && b3.macro?.[1] === "0.500 × 1.000 mm" && b3.pair?.[0].startsWith("Pitch"), `pcb 3d: smart measure picks pads and holes on the board (${JSON.stringify([b3.macro, b3.pair])})`);
    check(near(b3.dist, 2.54, 1e-6), `pcb 3d: point to point snaps to hole centres, 2.54 (${b3.dist})`);
    check(b3.bottom && b3.topHidden && b3.holeSeen && b3.flipPressed === "true", "pcb 3d: bottom view picks only bottom-side layers and drills");
    check(b3.thick === 2.4 && b3.back2d, `pcb 3d: thickness 2.4 rebuilds the board, 2D comes back (${b3.thick})`);
    await page.click("#g-body");
    await page.waitForFunction(() => !document.querySelector("#app").classList.contains("gerber") && window.__sv.viewer.parts.length === 1, null, { timeout: 10000 });
    const body = await page.evaluate(() => {
      const d = window.__sv.viewer.parts[0].data, g = window.__sv.gerber;
      return { closed: d.closed, vol: d.volume, expect: g.b3.info.area * 2.4, z: [d.bboxMin[2], d.bboxMax[2]], cyl: d.faces.filter(f => f.type === "cylinder").length, planes: d.faces.filter(f => f.type === "plane").length, back: !document.querySelector("#back-pcb").hidden };
    });
    check(body.closed && near(body.vol, body.expect, 1e-3) && near(body.z[0], -1.2) && near(body.z[1], 1.2) && body.cyl >= 6 && body.planes >= 6 && body.back, `pcb 3d: board body opens as a closed solid in the model view (${JSON.stringify(body)})`);
    await page.click("#back-pcb");
    check(await page.evaluate(() => document.querySelector("#app").classList.contains("gerber")), "pcb 3d: Back to PCB returns to the layers");
  }

  // --- UI/UX standards in the PCB view (FRS: layout, tokens, states, feedback, a11y QA) ---
  {
    const axeSrc = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
    const boardUrl = `${origin}/index.html?debug&url=${encodeURIComponent("/pcb/board.zip")}`;
    const openBoard = async (pg, theme = "light") => {
      await pg.addInitScript(t => { try { localStorage.setItem("sv:theme", t); } catch {} }, theme);
      await pg.goto(boardUrl);
      await pg.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
      await pg.waitForTimeout(250);
    };

    // Responsive layout at the standard breakpoints: no horizontal scroll, header fits, right navigation per size.
    for (const [w, h] of [[1920, 1080], [1440, 900], [1024, 768], [768, 1024], [375, 812]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const pg = await ctx.newPage();
      pg.on("pageerror", e => errors.push(e.message));
      await openBoard(pg);
      const r = await pg.evaluate(() => {
        const vis = sel => { const e = document.querySelector(sel); if (!e) return false; const s = getComputedStyle(e); return s.display !== "none" && e.getBoundingClientRect().width > 0; };
        const top = document.querySelector(".topbar"), ts = getComputedStyle(top);
        // Text that does not fit must end in an ellipsis and keep the full text in a tooltip.
        const clipped = [];
        for (const e of document.querySelectorAll("#app *")) {
          if (!e.childNodes.length || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
          const s = getComputedStyle(e);
          if (s.display === "none" || e.getBoundingClientRect().width === 0 || e.scrollWidth <= e.clientWidth + 1) continue;
          if (e.closest(".tool-hint, .readout, .g-tip, .labels")) continue;
          const tip = e.closest("[title]");
          if (s.textOverflow !== "ellipsis" || !tip) clipped.push(`${e.tagName}.${e.className}:${e.textContent.slice(0, 20)}`);
        }
        return {
          scroll: document.documentElement.scrollWidth - innerWidth, bodyScroll: document.body.scrollWidth - innerWidth,
          header: top.scrollWidth - top.clientWidth, z: ts.zIndex, pos: ts.position,
          left: vis("#g-left"), leftPos: getComputedStyle(document.querySelector("#g-left")).position, right: vis("#g-right"), nav: vis("#g-bottomnav"), status: vis(".status"),
          canvas: document.querySelector("#g-canvas").getBoundingClientRect().width, clipped,
        };
      });
      const layout = w >= 1280 ? r.left && r.leftPos !== "fixed" && r.right && !r.nav
        : w >= 768 ? !r.left && r.right && !r.nav
        : !r.left && !r.right && r.nav && !r.status;
      check(r.scroll <= 0 && r.bodyScroll <= 0 && r.header <= 1 && r.canvas > 0 && r.clipped.length === 0, `ui ${w}px: no horizontal scroll, header fits, clipped text has ellipsis + tooltip (${JSON.stringify({ s: r.scroll, h: r.header, clipped: r.clipped.slice(0, 3) })})`);
      check(layout && r.z === "1000" && /sticky|fixed/.test(r.pos), `ui ${w}px: ${w >= 1280 ? "docked panels" : w >= 768 ? "floating layer panel, docked tools" : "bottom navigation"}; header z-index 1000 (${JSON.stringify({ left: r.left, leftPos: r.leftPos, right: r.right, nav: r.nav })})`);
      if (w === 1024) {
        await pg.keyboard.press("Control+BracketLeft");
        await pg.waitForTimeout(250);
        const fl = await pg.evaluate(() => { const e = document.querySelector("#g-left"); const s = getComputedStyle(e); return { pos: s.position, shown: s.display !== "none", z: +s.zIndex }; });
        check(fl.shown && fl.pos === "fixed" && fl.z >= 900, `ui tablet: Ctrl+[ opens the layer panel floating over the board (${JSON.stringify(fl)})`);
      }
      if (w === 375) {
        await pg.click("#g-bottomnav [data-sheet=layers]");
        await pg.waitForTimeout(250);
        const sh = await pg.evaluate(() => { const e = document.querySelector("#g-left"), b = e.getBoundingClientRect(); return { full: b.left <= 0 && b.width >= innerWidth - 1 && b.top <= 0, role: e.getAttribute("role"), modal: e.getAttribute("aria-modal"), focus: e.contains(document.activeElement) }; });
        await pg.keyboard.press("Escape");
        await pg.waitForTimeout(100);
        const closed = await pg.evaluate(() => !document.querySelector("#app").dataset.sheet && getComputedStyle(document.querySelector("#g-left")).display === "none");
        check(sh.full && sh.role === "dialog" && sh.modal === "true" && sh.focus && closed, `ui mobile: Layers opens a full-screen sheet with focus inside, Esc closes it (${JSON.stringify(sh)})`);
      }
      await ctx.close();
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", e => errors.push(e.message));
    await openBoard(pg, "light");

    // Sidebar: Ctrl+[ collapses within 200 ms, the board widens, the state survives a reload.
    const w0 = await pg.$eval("#g-canvas", c => c.getBoundingClientRect().width);
    const dur = await pg.$eval("#app", a => parseFloat(getComputedStyle(a).transitionDuration) * 1000);
    await pg.keyboard.press("Control+BracketLeft");
    await pg.waitForTimeout(300);
    const col = await pg.evaluate(() => ({ cls: document.querySelector("#app").classList.contains("no-left"), w: document.querySelector("#g-canvas").getBoundingClientRect().width, exp: document.querySelector("#nav-toggle").getAttribute("aria-expanded") }));
    await openBoard(pg, "light");
    const kept = await pg.evaluate(() => document.querySelector("#app").classList.contains("no-left"));
    await pg.click("#nav-toggle");
    await pg.waitForTimeout(300);
    const back = await pg.evaluate(() => !document.querySelector("#app").classList.contains("no-left") && getComputedStyle(document.querySelector("#g-left")).display !== "none");
    check(col.cls && col.w > w0 + 200 && col.exp === "false" && kept && back && dur > 0 && dur < 200, `ui: Ctrl+[ / hamburger collapse the layer panel (${dur} ms), state kept after reload`);

    // Header: active file name and a status badge with a text alternative.
    const hdr = await pg.evaluate(() => ({ name: document.querySelector("#doc-name").textContent, st: document.querySelector("#doc-status").dataset.state, label: document.querySelector("#doc-status").getAttribute("aria-label") }));
    check(/board/.test(hdr.name) && hdr.st === "ready" && /Status/.test(hdr.label), `ui: header shows the open file and its status (${JSON.stringify(hdr)})`);

    // Pin a measurement so the list, the readout card and all controls are on screen for the audits.
    await pg.evaluate(() => {
      const g = window.__sv.gerber;
      const cu = g.layers.find(l => l.L.label === "Top copper");
      const fi = cu.L.objs.findIndex(o => o.t === "flash" && o.x === 10);
      g.setTool("smart");
      g.addMeasurement(g.shapeArea({ lid: cu.id, fi }));
      document.querySelector("#gt-measures").click();
    });

    // axe-core: WCAG 2.1 A/AA, including colour contrast, in light and dark themes.
    for (const theme of ["light", "dark"]) {
      await pg.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await pg.waitForTimeout(250);
      await pg.addScriptTag({ content: axeSrc });
      const res = await pg.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
        return r.violations.map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", ")}`);
      });
      check(res.length === 0, `ui axe (${theme}): 0 WCAG 2.1 AA violations, contrast included${res.length ? ": " + res.join(" | ") : ""}`);
    }
    await pg.evaluate(() => { document.documentElement.dataset.theme = "light"; });

    // Keyboard: every visible control is reachable with Tab and shows a 2 px focus ring.
    await pg.evaluate(() => document.activeElement?.blur());
    const reached = new Set();
    let ring = null;
    for (let i = 0; i < 160; i++) {
      await pg.keyboard.press("Tab");
      const f = await pg.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        if (!a.dataset.uiId) a.dataset.uiId = String(Math.random());
        const s = getComputedStyle(a);
        return { id: a.dataset.uiId, outline: `${s.outlineStyle} ${s.outlineWidth}`, btn: a.matches(".btn") };
      });
      if (f) { reached.add(f.id); if (f.btn && !ring) ring = f.outline; }
    }
    const unreachable = await pg.evaluate(ids => {
      const want = [...document.querySelectorAll("#app button, #app select, #app input:not([type=hidden]), #app summary, #app [tabindex='0']")]
        .filter(e => !e.disabled && e.tabIndex >= 0 && !e.closest("[hidden]") && getComputedStyle(e).visibility !== "hidden" && e.getClientRects().length && !e.closest(".step-only"));
      return want.filter(e => !ids.includes(e.dataset.uiId)).map(e => e.outerHTML.slice(0, 60));
    }, [...reached]);
    check(unreachable.length === 0, `ui keyboard: all PCB controls reachable with Tab${unreachable.length ? ": " + unreachable.slice(0, 4).join(" | ") : ""}`);
    check(ring === "solid 2px", `ui keyboard: visible 2 px focus ring (${ring})`);

    // Keyboard reorder of layers.
    const order0 = await pg.evaluate(() => window.__sv.gerber.layers.map(l => l.id).join());
    await pg.click("#gt-layers");
    await pg.focus("#g-layers .g-layer .grip");
    await pg.keyboard.press("Alt+ArrowDown");
    const reorder = await pg.evaluate(() => ({ order: window.__sv.gerber.layers.map(l => l.id).join(), focus: document.activeElement === document.querySelectorAll("#g-layers .g-layer .grip")[1] }));
    check(reorder.order !== order0 && reorder.focus, "ui keyboard: Alt+↓ moves a layer and keeps focus on it");

    // States: transitions 150–250 ms, disabled state, busy spinner on a background action.
    const st = await pg.evaluate(() => {
      const t = getComputedStyle(document.querySelector("#g-png")), d = document.querySelector("#g-all-on");
      return { dur: parseFloat(t.transitionDuration) * 1000, ease: t.transitionTimingFunction };
    });
    const busySeen = await pg.evaluate(() => { document.querySelector("#g-png").click(); return document.querySelector("#g-png").classList.contains("busy"); });
    check(st.dur >= 150 && st.dur <= 250 && /ease-in-out/.test(st.ease) && busySeen, `ui states: ${st.dur} ms ${st.ease} transitions, spinner on export`);

    // Toasts: bottom-right, info dismisses after 4 s, errors stay until dismissed.
    await pg.evaluate(() => { window.__sv.toast("Info toast"); window.__sv.toast("Error toast", true); });
    const tpos = await pg.evaluate(() => { const r = document.querySelector("#toasts").getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom }; });
    await pg.waitForTimeout(4300);
    const tAfter = await pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(t => [t.dataset.kind, t.getAttribute("role")]));
    await pg.click("#toasts .toast.error .x");
    const tGone = await pg.evaluate(() => !document.querySelector("#toasts .toast.error"));
    check(tpos.right <= 24 && tpos.bottom <= 60 && tAfter.length === 1 && tAfter[0][0] === "error" && tAfter[0][1] === "alert" && tGone, `ui toasts: bottom-right, info auto-dismissed at 4 s, error sticky until closed (${JSON.stringify(tAfter)})`);

    // Modal: blurred backdrop, focus trapped, Esc and backdrop click close; destructive confirm ignores the backdrop.
    await pg.click("#help-btn");
    const blur = await pg.evaluate(() => getComputedStyle(document.querySelector("#help"), "::backdrop").backdropFilter);
    let trapped = true;
    for (let i = 0; i < 6; i++) { await pg.keyboard.press("Tab"); trapped &&= await pg.evaluate(() => !!document.activeElement.closest("#help")); }
    await pg.mouse.click(8, 400);
    const helpClosed = await pg.evaluate(() => !document.querySelector("#help").open);
    await pg.click("#help-btn");
    await pg.keyboard.press("Escape");
    const escClosed = await pg.evaluate(() => !document.querySelector("#help").open && document.activeElement?.id === "help-btn");
    check(blur === "blur(4px)" && trapped && helpClosed && escClosed, `ui modal: blur(4px) backdrop, focus trap, backdrop click and Esc close, focus returns (${blur})`);

    await pg.click("#gt-measures");
    await pg.$eval("#g-clear", b => b.click());
    await pg.waitForTimeout(100);
    const opened = await pg.evaluate(() => document.querySelector("#confirm").open);
    await pg.mouse.click(8, 400);
    const stillOpen = await pg.evaluate(() => document.querySelector("#confirm").open);
    await pg.keyboard.press("Escape");
    await pg.waitForFunction(() => !document.querySelector("#confirm").open, null, { timeout: 2000 }).catch(() => {});
    const kept2 = await pg.evaluate(() => window.__sv.gerber.measurements.length);
    await pg.$eval("#g-clear", b => b.click());
    await pg.waitForFunction(() => document.querySelector("#confirm").open, null, { timeout: 2000 }).catch(() => {});
    await pg.click("#confirm [data-a=ok]");
    await pg.waitForFunction(() => window.__sv.gerber.measurements.length === 0, null, { timeout: 2000 }).catch(() => {});
    // Empty state: illustration, description and a call to action that starts Smart measure.
    const empty = await pg.evaluate(() => {
      const e = document.querySelector("#g-m-list .empty-state");
      window.__sv.gerber.setTool("distance");
      e?.querySelector("button.primary")?.click();
      return { n: window.__sv.gerber.measurements.length, svg: !!e?.querySelector("svg"), h: e?.querySelector("h3")?.textContent, cta: e?.querySelector("button.primary")?.textContent, tool: window.__sv.gerber.tool, disabled: document.querySelector("#g-clear").disabled && document.querySelector("#g-csv").disabled };
    });
    check(opened && stillOpen && kept2 === 1 && empty.n === 0, `ui modal: Clear all asks first, a backdrop click does not dismiss it (${JSON.stringify({ opened, stillOpen, kept2, n: empty.n })})`);
    check(empty.svg && /No measurements/.test(empty.h) && /Smart/.test(empty.cta) && empty.tool === "smart" && empty.disabled, `ui empty state: illustration, text and CTA; export buttons disabled (${JSON.stringify(empty)})`);
    await ctx.close();
  }

  // --- Interface language (EN / RU), Help and first-use tips ---
  {
    const boardUrl = `${origin}/index.html?debug&url=${encodeURIComponent("/pcb/board.zip")}`;
    const modelUrl = `${origin}/index.html?debug&url=${encodeURIComponent("/fixtures/cax-if/as1-oc-214.stp")}`;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const pg = await ctx.newPage();
    pg.on("pageerror", e => errors.push(e.message));
    const waitBoard = () => pg.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
    const waitModel = () => pg.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
    // Visible text and labels with English words left in Russian mode (file names, formats and units excepted).
    const untranslated = () => pg.evaluate(() => {
      const OK = /^(MöbiusCAD|STEP|DXF|IGES|BREP|SolidWorks|Parasolid|sldprt|sldasm|Gerber|Excellon|PCB|PNG|SVG|CSV|JSON|PDF|STL|OBJ|MF|DXF|opencascade|glTF|GLB|HLR|AO|EN|RU|mm|cm|in|ft|mil|fps|PTH|NPTH|ANSI31|XY|YZ|XZ|Ctrl|Alt|Esc|Shift|Enter|Tab|Del|Backspace|macOS|OpenCASCADE|occt|import|js|WebAssembly|RS|X2|AP\d+|rep|B|size|vol|zip|F1|SMD|PMI|GD|T|ComponentPad|SMDPad|ViaPad|GND|ambient|occlusion|Delrin|ABS|PLA|PEEK|POM|PA6|Ti|Al|V|D\d+|J\d+)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n.parentElement)) test(n.data, "text");
      for (const e of document.querySelectorAll("[title], [aria-label], [placeholder]")) {
        if (skip(e) || e.closest("#tree")) continue; // tree rows carry the model's own part names
        for (const a of ["title", "aria-label", "placeholder"]) { const v = e.getAttribute(a); if (v && !/\.(gbr|drl|zip|stp)\b/.test(v)) test(v, a); }
      }
      return [...bad];
    });

    await pg.goto(boardUrl);
    await waitBoard();
    const en = await pg.evaluate(() => ({ lang: document.documentElement.lang, btn: document.querySelector("#lang-btn").textContent, open: document.querySelector("[data-open] .open-long").textContent }));
    // First-use tip on the first board, with Got it / Turn off.
    const tip1 = await pg.evaluate(() => { const h = document.querySelector("#hint"); return { shown: !h.hidden, text: h.textContent, btns: h.querySelectorAll("button").length }; });
    await pg.click("#hint [data-h=ok]");
    await pg.click("#lang-btn");
    await pg.waitForTimeout(100);
    const ru = await pg.evaluate(() => ({
      lang: document.documentElement.lang, btn: document.querySelector("#lang-btn").textContent, label: document.querySelector("#lang-btn").getAttribute("aria-label"),
      open: document.querySelector("[data-open] .open-long").textContent, layers: document.querySelector("#gt-layers").textContent, tool: document.querySelector("[data-gtool=smart]").textContent,
      layer: document.querySelector("#g-layers .g-name b")?.textContent, stats: document.querySelector("#g-stats .k")?.textContent, doc: document.querySelector("#doc-status").getAttribute("aria-label"),
    }));
    check(en.lang === "en" && en.btn === "EN" && en.open === "Open file" && tip1.shown && /Tip/.test(tip1.text) && tip1.btns === 2, `i18n: English by default, first-use tip on the first board (${JSON.stringify([en, tip1.text.slice(0, 30)])})`);
    check(ru.lang === "ru" && ru.btn === "RU" && ru.label.startsWith("RU") && ru.open === "Открыть файл" && ru.layers === "Слои" && ru.tool === "✦ Умное" && /Медь|Контур|Сверловка|Маска|Шелкография/.test(ru.layer) && ru.stats === "Плата" && /Состояние/.test(ru.doc),
      `i18n: RU switches header, panels, layer names and stats at once (${JSON.stringify(ru)})`);
    // Results and the empty measurement list in Russian, then a scan for anything left in English.
    await pg.evaluate(() => {
      const g = window.__sv.gerber;
      const cu = g.layers.find(l => l.L.label === "Top copper");
      const pads = cu.L.objs.map((o, fi) => [o, fi]).filter(([o]) => o.t === "flash").map(([, fi]) => fi);
      g.setTool("smart");
      g.live = g.describe({ lid: cu.id, fi: pads[0] });
      g.addMeasurement(g.relation({ lid: cu.id, fi: pads[0] }, { lid: cu.id, fi: pads[1] }));
      document.querySelector("#gt-measures").click();
    });
    await pg.waitForTimeout(150);
    const card = await pg.evaluate(() => [document.querySelector("#g-readout .ttl span")?.textContent, document.querySelector("#g-m-list .m-item .t")?.textContent]);
    const leftPcb = await untranslated();
    check(/Шаг|Зазор/.test(card[1]) && card[0] && !/[A-Za-z]{3}/.test(card[0]), `i18n: PCB result card and list in Russian (${JSON.stringify(card)})`);
    check(leftPcb.length === 0, `i18n: no English left in the PCB view${leftPcb.length ? ": " + leftPcb.slice(0, 6).join(" | ") : ""}`);
    // Help: tabs in Russian, with the shortcuts table.
    await pg.click("#help-btn");
    const help = await pg.evaluate(() => ({ title: document.querySelector("#help-title").textContent, tabs: [...document.querySelectorAll("#help .help-tabs [role=tab]")].map(b => b.textContent), kbd: document.querySelectorAll("#help kbd").length, tips: document.querySelector("#tips-on").checked }));
    await pg.click("#help [data-tab=keys]");
    const keysShown = await pg.evaluate(() => !document.querySelector("#hp-keys").hidden && document.querySelector("#hp-keys").textContent.includes("Ctrl+["));
    const leftHelp = await untranslated();
    // About / Credits: the open-source list comes from the build's credits.json, licence texts ship alongside.
    await pg.click("#help [data-tab=about]");
    await pg.waitForFunction(() => document.querySelectorAll("#hp-about [data-credits-table] tr").length > 1, null, { timeout: 5000 }).catch(() => {});
    await pg.click("#hp-about .credits-all summary");
    const about = await pg.evaluate(async () => {
      const list = await (await fetch("credits.json")).json();
      const lic = await (await fetch("THIRD-PARTY-LICENSES.txt")).text();
      const img = document.querySelector("#hp-about .about-head img");
      return {
        n: list.length, rows: document.querySelectorAll("#hp-about [data-credits-table] tr").length - 1,
        main: [...document.querySelectorAll("#hp-about [data-credits-main] li a")].map(a => a.textContent),
        names: list.map(c => c.name), licOk: list.every(c => c.license && c.url && lic.includes(`${c.name} ${c.version}`)),
        logo: img?.complete && img.naturalWidth > 0, version: document.querySelector("#hp-about .about-name")?.textContent,
      };
    });
    const leftAbout = await untranslated();
    check(about.n > 5 && about.rows === about.n && about.main.includes("three.js") && about.main.includes("occt-import-js") && about.names.includes("Open CASCADE Technology") && about.licOk && about.logo && /v\d+\.\d+\.\d+/.test(about.version),
      `about: credits list from the build (${about.n} packages, ${about.rows} rows), main libraries, licence texts, logo and version (${JSON.stringify({ main: about.main, version: about.version })})`);
    check(leftAbout.length === 0, `i18n: no English left in About${leftAbout.length ? ": " + leftAbout.slice(0, 6).join(" | ") : ""}`);
    await pg.keyboard.press("Escape");
    check(help.title === "Справка" && help.tabs.length === 7 && help.tabs.includes("Моделирование") && help.tabs.includes("Клавиши") && help.kbd > 10 && keysShown && help.tips, `i18n: Help in Russian with sections and shortcuts (${JSON.stringify(help)})`);
    check(leftHelp.length === 0, `i18n: no English left in Help${leftHelp.length ? ": " + leftHelp.slice(0, 6).join(" | ") : ""}`);
    // axe in Russian too.
    await pg.addScriptTag({ content: await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8") });
    const axeRu = await pg.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations.map(v => v.id));
    check(axeRu.length === 0, `i18n: 0 WCAG 2.1 AA violations in Russian${axeRu.length ? ": " + axeRu.join(", ") : ""}`);

    // The choice survives a reload; the model view is Russian too and its header fits from 1024 px.
    await pg.goto(modelUrl);
    await waitModel();
    await pg.evaluate(() => {
      const { viewer, handlePick } = window.__sv;
      const p = viewer.parts.find(p => p.data.faces.filter(f => f.type === "cylinder").length >= 2) ?? viewer.parts[0];
      const V3 = p.group.position.constructor;
      const cyl = p.data.faces.filter(f => f.type === "cylinder");
      const pick = f => ({ kind: "onFace", point: new V3(...f.centroid), part: p, face: f, normal: new V3(...(f.normal ?? [0, 0, 1])), px: 0 });
      handlePick(pick(cyl[0] ?? p.data.faces[0]));
      document.querySelector("#readout .acts button")?.click();
      handlePick(pick(p.data.faces[0]));
      document.querySelectorAll("details").forEach(d => (d.open = true));
      document.querySelectorAll(".rp").forEach(p => p.classList.add("on"));
      document.querySelector("#display-menu").hidden = false;
    });
    await pg.waitForTimeout(200);
    const model = await pg.evaluate(() => ({ lang: document.documentElement.lang, tree: document.querySelector("#t-tree").textContent, card: document.querySelector("#readout .ttl span")?.textContent, list: document.querySelector("#m-list .m-item .t")?.textContent, hint: document.querySelector("#tool-hint").textContent }));
    const leftModel = await untranslated();
    check(model.lang === "ru" && model.tree === "Дерево модели" && !/[A-Za-z]{3}/.test(model.card ?? "x") && /\d\. [А-Яа-я]/.test(model.list ?? "") && /Умное измерение/.test(model.hint), `i18n: language kept after reload; model view, result card and list in Russian (${JSON.stringify(model)})`);
    check(leftModel.length === 0, `i18n: no English left in the model view${leftModel.length ? ": " + leftModel.slice(0, 6).join(" | ") : ""}`);
    for (const lang of ["ru", "en"]) {
      for (const w of [1024, 1280, 1440]) {
        await pg.setViewportSize({ width: w, height: 800 });
        await pg.waitForTimeout(100);
        const over = await pg.evaluate(() => { const t = document.querySelector(".topbar"); return t.scrollWidth - t.clientWidth; });
        check(over <= 1, `i18n: model header fits at ${w}px in ${lang.toUpperCase()} (${over})`);
      }
      if (lang === "ru") await pg.click("#lang-btn");
    }
    await pg.setViewportSize({ width: 1440, height: 900 });
    const back = await pg.evaluate(() => ({ lang: document.documentElement.lang, tree: document.querySelector("#t-tree").textContent, card: document.querySelector("#readout .ttl span")?.textContent, stored: localStorage.getItem("sv:lang") }));
    check(back.lang === "en" && back.tree === "Model tree" && back.stored === "en" && /^[A-Za-z]/.test(back.card ?? "A"), `i18n: back to English restores the static and rendered text (${JSON.stringify(back)})`);
    // Tips: each shows once; "Turn off tips" stops them and Help turns them back on.
    const tipsSeen = await pg.evaluate(() => localStorage.getItem("sv:tips-seen"));
    await pg.evaluate(() => { localStorage.setItem("sv:tips-seen", ""); });
    await pg.goto(boardUrl);
    await waitBoard();
    await pg.click("#hint [data-h=off]");
    const off = await pg.evaluate(() => ({ hidden: document.querySelector("#hint").hidden, v: localStorage.getItem("sv:tips") }));
    await pg.goto(modelUrl);
    await waitModel();
    const quiet = await pg.evaluate(() => document.querySelector("#hint").hidden);
    check(/pcb/.test(tipsSeen) && /model/.test(tipsSeen) && off.hidden && off.v === "off" && quiet, `hints: each tip once, Turn off tips stops them (${JSON.stringify({ tipsSeen, off, quiet })})`);
    await ctx.close();
  }
  }

  if (inShard(2)) { // these sections share `page`: keep them together
  // --- exact geometry: the full kernel reads the file again; values switch to the B-rep ---
  {
    await open("rounded-cube/rounded-cube.step", true);
    const mesh = await page.evaluate(() => ({ vol: window.__sv.viewer.parts[0].data.volume, exact: !!window.__sv.viewer.parts[0].data.exact }));
    await page.waitForFunction(() => ["ready", "partial", "error"].includes(document.querySelector("#st-kernel").dataset.state), null, { timeout: 120000 });
    const ex = await page.evaluate(() => {
      const { viewer, handlePick, showBody, state } = window.__sv;
      const p = viewer.parts[0], d = p.data;
      const V3 = p.group.position.constructor;
      const el = document.querySelector("#st-kernel");
      const free = d.faces.filter(f => f.type === "other");
      handlePick(null);
      handlePick({ kind: "faceCenter", point: new V3(...d.faces[0].center), part: p, face: d.faces[0], normal: new V3(0, 0, 1), px: 0 });
      showBody(p);
      const rows = Object.fromEntries(JSON.parse(state.live.data.rows).map(([k, , x]) => [k, x]));
      handlePick(null);
      return { state: el.dataset.state, text: el.textContent, exact: d.exact, vol: d.volume, area: d.area, edges: d.edges.filter(e => e.exact).length, nEdges: d.edges.length,
        surfaces: d.faces.map(f => f.surface), curv: free.filter(f => f.curvature).length, nFree: free.length, from: rows["Values from"], bodyVol: state.live?.value };
    });
    check(!mesh.exact && ex.state === "ready" && ex.text === "Exact geometry" && ex.exact, `exact: kernel reads the file in the background, status ${ex.state} (${ex.text})`);
    // OCCT's exact volume of rounded-cube.step; the 'Normal' mesh gives 946.148.
    check(near(ex.vol, 946.3497, 1e-3) && Math.abs(mesh.vol - ex.vol) > 0.1 && ex.from === "exact B-rep geometry",
      `exact: volume ${ex.vol.toFixed(4)} mm³ from the B-rep (mesh ${mesh.vol.toFixed(4)}), readout says ${ex.from}`);
    check(ex.edges === ex.nEdges && ex.surfaces.every(Boolean), `exact: all ${ex.nEdges} edges and every face matched to the B-rep (${ex.edges}, ${[...new Set(ex.surfaces)]})`);
    check(ex.curv === ex.nFree, `exact: curvature from the surface on ${ex.curv}/${ex.nFree} freeform faces`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.$eval("#step-export", el => el.click())]);
    const back = readStep(await readFile(await dl.path()));
    check(dl.suggestedFilename() === "rounded-cube.step" && back.ok && back.meshes === 1 && back.faces === ex.surfaces.length,
      `STEP export: ${dl.suggestedFilename()} reads back with ${back.meshes} solid and ${back.faces} faces`);
  }
  {
    await open("cax-if/as1_pe_203.stp", true); // this one has true circles (as1-oc-214 has B-splines)
    await page.waitForFunction(() => ["ready", "partial", "error"].includes(document.querySelector("#st-kernel").dataset.state), null, { timeout: 120000 });
    const as = await page.evaluate(() => {
      const { viewer } = window.__sv;
      const ps = viewer.parts;
      // Hide all but the first three parts: STEP export then saves only those.
      ps.slice(3).forEach(p => { p.visible = false; p.group.visible = false; });
      // Hole edges come as half circles. Exact ones have the file's radius (a round number) and length R·sweep.
      const arcs = ps.flatMap(p => p.data.edges).filter(e => e.exact && (e.type === "circle" || e.type === "arc") && Math.abs(e.radius * 1000 - Math.round(e.radius * 1000)) < 1e-6);
      return { n: ps.length, exact: ps.filter(p => p.data.exact).length, state: document.querySelector("#st-kernel").dataset.state, circles: arcs.length,
        round: arcs.filter(e => Math.abs(e.length - e.sweep * e.radius) < 1e-9 * e.length).length };
    });
    check(as.state === "ready" && as.exact === as.n, `exact: all ${as.n} parts of the as1 assembly matched (${as.exact})`);
    check(as.round > 10, `exact: ${as.round} hole edges have the exact radius, arcs of length R·sweep`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.$eval("#step-export", el => el.click())]);
    const back = readStep(await readFile(await dl.path()));
    check(/-parts\.step$/.test(dl.suggestedFilename()) && back.ok && back.meshes === 3, `STEP export: only the 3 visible parts (${dl.suggestedFilename()}, ${back.meshes} read back)`);
  }

  // --- SolidWorks: a generated block part (Parasolid X_T inside) and an assembly placing it twice ---
  {
    const sw = resolve("tests/fixtures/sw");
    const swLoad = async (files, title) => {
      await page.goto(`${origin}/index.html?debug`);
      await page.waitForFunction(() => window.__sv);
      await page.setInputFiles("#file-input", files.map(f => join(sw, f)));
      if (title) await page.waitForFunction(t => document.title.startsWith(t) && window.__sv.viewer.parts.length > 0 && document.querySelector("#loading").hidden, title, { timeout: 120000 });
    };
    const swState = () => page.evaluate(() => {
      const { viewer } = window.__sv;
      const b = viewer.computeBounds(), s = b.getSize(b.min.clone());
      return { n: viewer.parts.length, vol: viewer.parts.map(p => p.data.volume), planes: viewer.parts.map(p => p.data.faces.filter(f => f.type === "plane").length),
        closed: viewer.parts.every(p => p.data.closed), size: [s.x, s.y, s.z].map(v => +v.toFixed(6)),
        toasts: [...document.querySelectorAll("#toasts .toast")].map(t => `${t.dataset.kind}: ${t.dataset.msg}`) };
    });
    await swLoad(["block.SLDPRT"], "block.SLDPRT");
    const part = await swState();
    check(part.n === 1 && near(part.vol[0], 24000, 1e-6) && part.planes[0] === 6 && part.closed && part.size.join() === "40,30,20",
      `SolidWorks part: the block opens as one closed solid, 6 planes, 40 x 30 x 20 mm, V=${part.vol[0]} (${JSON.stringify(part)})`);
    await swLoad(["pair.SLDASM", "block.SLDPRT"], "pair.SLDASM");
    const asm = await swState();
    check(asm.n === 2 && asm.vol.every(v => near(v, 24000, 1e-6)) && asm.size.join() === "100,40,20",
      `SolidWorks assembly: two blocks, the second turned 90° and moved 100 mm, overall ${asm.size.join(" x ")} mm`);
    check(asm.toasts.some(t => /^warn: .*lid\.SLDPRT/.test(t)), `SolidWorks assembly: the missing part is named (${asm.toasts})`);
    await swLoad(["pair.SLDASM"]);
    await page.waitForSelector("#empty img.sw-preview", { timeout: 60000 });
    const alone = await page.evaluate(() => ({ toasts: [...document.querySelectorAll("#toasts .toast")].map(t => t.dataset.kind), img: document.querySelector("#empty img.sw-preview").naturalWidth }));
    check(alone.toasts.includes("error") && alone.img === 1, `SolidWorks assembly without its parts: error toast and SolidWorks' own preview (${JSON.stringify(alone)})`);
  }

  // --- opening speed: the import engine warms up while idle, and the kernel worker is kept for the next file ---
  {
    await page.goto(`${origin}/index.html?debug`);
    await page.waitForFunction(() => window.__sv);
    await page.waitForTimeout(4000); // idle: OpenCASCADE loads and reads its warm-up block
    await page.setInputFiles("#file-input", join(fixtures, "cax-if/as1_pe_203.stp"));
    await page.waitForFunction(() => document.querySelector("#st-kernel").dataset.state === "ready" && window.__sv.timings().exact, null, { timeout: 120000 });
    const a = await page.evaluate(() => ({ ...window.__sv.timings() }));
    await page.setInputFiles("#file-input", join(fixtures, "rounded-cube/rounded-cube.step"));
    await page.waitForFunction(() => document.title.startsWith("rounded-cube") && window.__sv.timings().exact, null, { timeout: 120000 });
    const b = await page.evaluate(() => ({ ...window.__sv.timings(), state: document.querySelector("#st-kernel").dataset.state, vol: window.__sv.viewer.parts[0].data.volume }));
    check(a.wasm < 50 && b.wasm < 50, `speed: OpenCASCADE was loaded before the first file (${a.wasm.toFixed(0)} ms, then ${b.wasm.toFixed(0)} ms to load it)`);
    check(b.state === "ready" && near(b.vol, 946.3497, 1e-3) && b.init < 200 && b.init < a.init / 5,
      `speed: the second file reuses the kernel worker (start-up ${a.init.toFixed(0)} ms, then ${b.init.toFixed(0)} ms) and still gets exact values (${b.vol.toFixed(4)} mm³)`);
    console.log(`  timings (ms): first ${JSON.stringify(a, (k, v) => typeof v === "number" ? Math.round(v) : v)}, second ${JSON.stringify(b, (k, v) => typeof v === "number" ? Math.round(v) : v)}`);
  }

  // --- section profile to DXF and SVG ---
  {
    await open("cube-10x10mm/Cube 10x10.stp");
    await page.$eval('[data-sec="z"]', el => el.click());
    await page.waitForTimeout(200);
    const [dxf] = await Promise.all([page.waitForEvent("download"), page.$eval('#sec-list [data-a="dxf"]', el => el.click())]);
    const txt = await readFile(await dxf.path(), "utf8");
    const lines = (txt.match(/\n0\nLINE\n/g) || []).length;
    const pairs = txt.split("\n").reduce((a, l, i, all) => (i % 2 ? a : [...a, [all[i].trim(), all[i + 1]]]), []);
    const ents = pairs.slice(pairs.findIndex(([c, v]) => c === "2" && v === "ENTITIES"));
    const xs = ents.filter(([c]) => c === "10" || c === "11").map(([, v]) => +v);
    check(/\.dxf$/.test(dxf.suggestedFilename()) && /\$ACADVER\n1\nAC1009/.test(txt) && txt.trim().endsWith("EOF") && lines === 4 && near(Math.max(...xs) - Math.min(...xs), 10, 1e-6),
      `section DXF: the cube's Z cut is 4 lines spanning 10 mm (${dxf.suggestedFilename()}, ${lines} lines, x ${Math.min(...xs)}…${Math.max(...xs)})`);
    const [svg] = await Promise.all([page.waitForEvent("download"), page.$eval('#sec-list [data-a="svg"]', el => el.click())]);
    const sv = await readFile(await svg.path(), "utf8");
    check(/<svg[^>]+width="10\.\d+mm"/.test(sv) && (sv.match(/<line /g) || []).length === 4, "section SVG: 4 lines at 1:1 in millimetres");
    await open("cax-if/as1-oc-214.stp");
    const circ = await page.evaluate(async () => {
      const { section, viewer } = window.__sv;
      const V3 = viewer.camera.position.constructor;
      // Through the plate with the holes: a plane across their axes.
      const holes = viewer.parts.flatMap(p => p.data.faces.filter(f => f.type === "cylinder").map(f => ({ p, f })));
      const { p, f } = holes[0];
      const ax = new V3(...f.axis), c = viewer.toWorld(p, f.center);
      section.add("Hole", ax, c.dot(ax));
      section.updateProfiles();
      window.__sv.renderSections();
      return section.planes.length;
    });
    const [d2] = await Promise.all([page.waitForEvent("download"), page.$eval('#sec-list [data-a="dxf"]', el => el.click())]);
    const t2 = await readFile(await d2.path(), "utf8");
    const nCirc = (t2.match(/\n0\nCIRCLE\n/g) || []).length;
    check(circ === 1 && nCirc > 0, `section DXF: holes cut square to their axis are CIRCLE entities (${nCirc}, ${(t2.match(/\n0\nARC\n/g) || []).length} arcs)`);
  }

  // --- markup notes: text with a leader, kept, in snapshots ---
  {
    await open("cube-10x10mm/Cube 10x10.stp");
    await page.evaluate(() => {
      const { viewer, handlePick, setTool } = window.__sv;
      const p = viewer.parts[0], f = p.data.faces.find(x => x.normal?.[2] > 0.99);
      const V3 = p.group.position.constructor;
      setTool("note");
      handlePick({ kind: "faceCenter", point: new V3(...f.center), part: p, face: f, normal: new V3(0, 0, 1), px: 0 });
    });
    await page.waitForSelector("#note-dlg[open]");
    await page.fill("#note-text", "Deburr all edges\nRa 1.6");
    await page.click('#note-dlg [data-a="ok"]');
    await page.waitForTimeout(100);
    const note = await page.evaluate(async () => {
      const { state, annotations, setTool } = window.__sv;
      setTool("select");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const m = state.measurements.find(x => x.type === "note");
      const el = document.querySelector("#labels .m-note"), leader = document.querySelector("#labels .m-leader");
      const boxes = annotations.labelBoxes().filter(b => b.from);
      const saved = JSON.parse(localStorage.getItem(state.fileKey) || "[]").some(x => x.type === "note" && x.data.text === "Deburr all edges\nRa 1.6");
      return { text: m?.data.text, label: el?.textContent, leader: leader && parseFloat(leader.style.width), box: boxes[0]?.text, saved, translate: el?.getAttribute("translate"), item: document.querySelector("#m-list")?.textContent.includes("Deburr") };
    });
    check(note.text === "Deburr all edges\nRa 1.6" && note.label === note.text && note.translate === "no" && note.leader > 30, `note: text box with a leader on the model (${JSON.stringify(note.label)}, leader ${note.leader?.toFixed(0)} px)`);
    check(note.saved && note.item && note.box?.length === 2, `note: kept with the file's measurements, listed, and drawn into snapshots (${JSON.stringify(note.box)})`);
  }

  // --- mesh files: STL, OBJ and 3MF are grouped into faces for measuring ---
  {
    await open("cube-10x10mm/Cube 10x10.stl");
    const stl = await page.evaluate(() => {
      const d = window.__sv.viewer.parts[0].data, el = document.querySelector("#st-kernel");
      return { planes: d.faces.filter(f => f.type === "plane").length, faces: d.faces.length, lines: d.edges.filter(e => e.type === "line").length, edges: d.edges.length, vol: d.volume, closed: d.closed, kernel: el.hidden };
    });
    check(stl.planes === 6 && stl.faces === 6 && stl.lines === 12 && stl.edges === 12 && stl.closed && near(stl.vol, 1000, 1e-6) && stl.kernel,
      `STL: 12 triangles become 6 planar faces and 12 edges, V=${stl.vol} (${JSON.stringify(stl)})`);
    await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/cyl.obj")}`);
    await page.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
    const obj = await page.evaluate(() => {
      const d = window.__sv.viewer.parts[0].data;
      const cyl = d.faces.find(f => f.type === "cylinder");
      return { faces: d.faces.map(f => f.type).sort().join(","), r: cyl?.radius, circles: d.edges.filter(e => e.type === "circle").map(e => e.radius), name: d.name };
    });
    check(obj.faces === "cylinder,plane,plane" && near(obj.r, 5, 1e-6) && obj.circles.length === 2 && obj.circles.every(r => near(r, 5, 1e-6)),
      `OBJ: a 48-sided cylinder reads as one cylinder R${obj.r?.toFixed(4)} with two circular edges (${obj.faces})`);
    await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/block.3mf")}`);
    await page.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
    const tmf = await page.evaluate(() => { const d = window.__sv.viewer.parts[0].data; return { planes: d.faces.filter(f => f.type === "plane").length, vol: d.volume, box: [0, 1, 2].map(k => d.bboxMax[k] - d.bboxMin[k]) }; });
    check(tmf.planes === 6 && near(tmf.vol, 800, 1e-6) && tmf.box.join() === "20,10,4", `3MF: a 20×10×4 block, 6 planar faces, V=${tmf.vol}`);
    // 3MF export (FR-STO): written in millimetres with colours, it reads back as the same closed block.
    const [d3] = await Promise.all([page.waitForEvent("download"), page.$eval('[data-export="3mf"]', el => el.click())]);
    const b3 = await readFile(await d3.path());
    await page.evaluate(() => { window.__sv.viewer.parts[0].data.__old = true; });
    await page.setInputFiles("#file-input", { name: "back.3mf", mimeType: "model/3mf", buffer: b3 });
    await page.waitForFunction(() => document.querySelector("#loading").hidden && window.__sv.viewer.parts[0]?.data && !window.__sv.viewer.parts[0].data.__old, null, { timeout: 30000 });
    const t2 = await page.evaluate(() => { const d = window.__sv.viewer.parts[0].data; return { planes: d.faces.filter(f => f.type === "plane").length, vol: d.volume, box: [0, 1, 2].map(k => +(d.bboxMax[k] - d.bboxMin[k]).toFixed(6)) }; });
    check(/\.3mf$/.test(d3.suggestedFilename()) && b3.subarray(0, 2).toString() === "PK" && t2.planes === 6 && near(t2.vol, 800, 1e-6) && t2.box.join() === "20,10,4",
      `3MF export: ${d3.suggestedFilename()} reads back as the 20×10×4 block (${t2.planes} planes, V=${t2.vol})`);
  }

  // --- PCB board body as a STEP solid ---
  {
    await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/board.zip")}`);
    await page.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 30000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.$eval("#g-step", el => el.click())]);
    const buf = await readFile(await dl.path());
    const back = readStep(buf);
    const cyl = (buf.toString("latin1").match(/CYLINDRICAL_SURFACE/g) || []).length;
    const res = occtImport.ReadStepFile(new Uint8Array(buf), { linearUnit: "millimeter" });
    const zs = res.meshes[0].attributes.position.array.filter((_, i) => i % 3 === 2);
    const holes = await page.evaluate(() => window.__sv.gerber.boardStepBody().holes.length);
    check(/-board\.step$/.test(dl.suggestedFilename()) && back.ok && back.meshes === 1 && holes > 0 && cyl >= holes && near(Math.min(...zs), -0.8) && near(Math.max(...zs), 0.8),
      `PCB STEP: board body is one solid, 1.6 mm thick, ${holes} holes as ${cyl} cylinders (${dl.suggestedFilename()}, ${back.meshes} solid, z ${Math.min(...zs)}…${Math.max(...zs)})`);
  }

  // --- PCB performance: ~270k objects ---
  const t0 = Date.now();
  await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent("/pcb/big-F_Cu.gbr")}`);
  // Loading longer than 300 ms shows skeletons in the panels.
  const skel = await page.waitForFunction(() => document.querySelector("#app")?.dataset.busy === "slow" && getComputedStyle(document.querySelector("#g-tab-layers .skel-group")).display === "flex", null, { timeout: 20000, polling: 50 }).then(() => true, () => false);
  check(skel, "ui: skeleton loaders while a slow PCB load runs");
  await page.waitForFunction(() => window.__sv?.gerber.layers.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
  const loadS = (Date.now() - t0) / 1000;
  const perf = await page.evaluate(() => {
    const g = window.__sv.gerber;
    g.render();
    const objs = g.layers[0].L.objs.length, render = g.lastRenderMs;
    g.zoomAt(700, 450, 20);
    const t = performance.now();
    for (let i = 0; i < 200; i++) { g.moveTo(300 + i * 2, 300 + (i % 7) * 3); g.paintOverlay(); }
    return { objs, render, move: (performance.now() - t) / 200 };
  });
  check(perf.objs === 270000 && loadS < 30, `pcb perf: ${perf.objs} objects load in ${loadS.toFixed(1)} s`);
  check(perf.move < 16, `pcb perf: snap + overlay per mouse move ${perf.move.toFixed(2)} ms (full redraw ${perf.render.toFixed(0)} ms)`);
  }

  // --- Part modelling (FRS P1): new part, sketch with dimensions, extrude, cut on a face, fillet, edit, undo, save/open, STEP, recovery, RU ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    // First-use tips stay out of the way here (they are tested elsewhere).
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const last = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: l.props?.volume ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.code), n: window.__sv.model.store.doc.features.length }; });
    /** Sketch point (editor frame) or world point to page coordinates. */
    const toPage = (p, sketch) => mp.evaluate(([p, sketch]) => {
      const v = window.__sv.viewer, f = sketch ? window.__sv.model.editor().frame : null;
      const w = f ? [0, 1, 2].map(i => f.o[i] + f.x[i] * p[0] + f.y[i] * p[1]) : p;
      const q = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, [p, sketch]);
    const click = async (p, sketch = true) => { const [x, y] = await toPage(p, sketch); await mp.mouse.move(x, y); await mp.waitForTimeout(30); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(60); };
    const dimension = async (at, place, value) => {
      await click(at); await click(place);
      await mp.waitForSelector(".sk-input", { timeout: 5000 });
      await mp.fill(".sk-input", value); await mp.press(".sk-input", "Enter");
      await mp.waitForTimeout(100);
    };
    const sketchInfo = () => mp.evaluate(() => { const e = window.__sv.model.editor(); return { dof: e.info.dof, status: e.info.status, ents: e.sk.ents.length, dims: e.sk.dims.map(d => +d.val.v.toFixed(6)), pm: document.querySelector("#mc-pm .pm-def")?.textContent }; });
    const iso = () => mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });

    await mp.click("#new-part");
    await mp.waitForSelector("#mc-tools:not([hidden])");
    const start = await mp.evaluate(() => ({ tab: document.querySelector("#t-features").getAttribute("aria-selected"), rows: [...document.querySelectorAll("#mc-tree .ft-name")].map(e => e.textContent) }));
    check(start.tab === "true" && start.rows.join("|") === "Part1|Material <not specified>|Configuration: Default|Equations|Top (XY)|Front (XZ)|Right (YZ)|Origin", `model: New part opens the Features tab with the origin planes (${JSON.stringify(start)})`);
    // Sketch on Top: corner rectangle from the origin, then 100 × 60 by dimensions (AT-P1-1 style).
    await mp.click('[data-c="sketch"]');
    await mp.click('#mc-pm [data-std="XY"]');
    await idle();
    await mp.waitForTimeout(600);
    await mp.keyboard.press("r");
    await click([0, 0]); await click([80, 50]);
    await mp.keyboard.press("d");
    await dimension([40, 50], [40, 62], "100");
    await dimension([0, 25], [-12, 25], "60");
    const sk1 = await sketchInfo();
    check(sk1.ents === 8 && sk1.dof === 0 && sk1.status === "ok" && sk1.dims.join() === "100,60" && /Fully defined/.test(sk1.pm), `model sketch: rectangle snapped to the origin, two dimensions, fully defined (${JSON.stringify(sk1)})`);
    // Undo inside the sketch takes the last dimension back.
    await mp.keyboard.press("Control+z");
    const undone = await sketchInfo();
    await mp.keyboard.press("Control+y");
    const redone = await sketchInfo();
    check(undone.dims.map(v => +v.toFixed(3)).join() === "100,50" && redone.dims.join() === "100,60" && redone.dof === 0, `model sketch: Ctrl+Z / Ctrl+Y step the dimension value back and forth (${undone.dims} → ${redone.dims})`);
    await mp.keyboard.press("Enter");
    await idle();
    // Extrude 20 mm: the 100 × 60 × 20 block.
    await mp.click('[data-c="extrude"]');
    await mp.fill('#mc-pm input[data-num="depth"]', "20");
    await mp.press('#mc-pm input[data-num="depth"]', "Enter");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const ex = await last();
    const shown = await mp.evaluate(() => ({ parts: window.__sv.viewer.parts.length, exact: !!window.__sv.viewer.parts[0]?.data.exact, faces: window.__sv.viewer.parts[0]?.data.faces.length }));
    check(near(ex.v, 120000, 1e-3) && !ex.bad.length && shown.parts === 1 && shown.faces === 6, `model: Extrude 20 mm gives the 100 × 60 × 20 block, 120000 mm³, 6 faces (${ex.v}, ${JSON.stringify(shown)})`);
    // Sketch on the top face (picked with Smart measure), a circle, then Cut through all.
    await iso();
    const topFace = await mp.evaluate(() => {
      const { viewer, handlePick } = window.__sv, p = viewer.parts[0], V3 = p.group.position.constructor;
      const f = p.data.faces.find(f => f.normal?.[2] > 0.99);
      handlePick({ kind: "faceCenter", point: new V3(...f.center), part: p, face: f, normal: new V3(...f.normal), px: 0 });
      return f.id;
    });
    await mp.click('[data-c="sketch"]');
    await idle();
    await mp.waitForTimeout(600);
    const onFace = await mp.evaluate(() => { const e = window.__sv.model.editor(); const sk = window.__sv.model.store.doc.features.at(-1); return { plane: sk.plane, n: e.frame.n, z: e.frame.o[2] }; });
    check(onFace.plane.face?.name?.endsWith(":end") && near(onFace.n[2], 1, 1e-9) && near(onFace.z, 20, 1e-9), `model: Sketch on the picked top face (face ${topFace}: ${JSON.stringify(onFace.plane)})`);
    // A circle centred on the block, at world (50, 30, 20) in the face sketch's own axes.
    const loc = w => mp.evaluate(w => { const f = window.__sv.model.editor().frame, d = [0, 1, 2].map(i => w[i] - f.o[i]); return [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2]]; }, w);
    await mp.keyboard.press("c");
    await click(await loc([50, 30, 20])); await click(await loc([62, 30, 20]));
    await mp.keyboard.press("d");
    await click(await loc([62, 30, 20])); await click(await loc([72, 42, 20]));
    await mp.waitForSelector(".sk-input", { timeout: 5000 });
    await mp.fill(".sk-input", "20"); await mp.press(".sk-input", "Enter");
    await mp.waitForTimeout(100);
    const circ = await mp.evaluate(() => { const c = window.__sv.model.editor().sk.ents.find(e => e.t === "circle"); return c?.r; });
    await mp.keyboard.press("Enter");
    await idle();
    await mp.click('[data-c="cut"]');
    await mp.waitForSelector("#mc-pm select[data-k=end]");
    const cutEnd = await mp.$eval("#mc-pm select[data-k=end]", s => s.value);
    await mp.click("#mc-ok");
    await idle();
    const cut = await last();
    check(near(circ, 10, 1e-6) && cutEnd === "through" && near(cut.v, 120000 - Math.PI * 100 * 20, 1e-3) && !cut.bad.length, `model: ⌀20 circle on the face, Cut through all removes π·10²·20 (${cut.v}, r ${circ}, end ${cutEnd}, ${cut.bad})`);
    // Fillet R5 on the four vertical edges, picked in the view.
    await iso();
    await mp.click('[data-c="fillet"]');
    await mp.waitForSelector('#mc-pm input[data-num="radius"]');
    await iso();
    await mp.waitForTimeout(200);
    for (const p of [[100, 0, 10], [0, 0, 10], [100, 60, 10]]) await click(p, false);
    const picked = await mp.evaluate(() => window.__sv.model.mode().draft.edges.length);
    await idle();
    const prev = await mp.evaluate(() => ({ tris: (window.__sv.model.last().preview?.position.length ?? 0) / 9, callout: document.querySelector("#mc-layer .mc-callout")?.textContent, groups: [...document.querySelectorAll("#mc-pm legend")].map(l => l.textContent).join("|"), items: document.querySelectorAll("#mc-pm .pm-items li").length }));
    check(prev.tris > 10 && /Radius: 2 mm/.test(prev.callout ?? "") && prev.groups === "Fillet type|Items to fillet|Fillet parameters|Setback parameters|Fillet options" && prev.items === 3, `model: the fillet previews live (yellow faces) while edges are picked, with a radius callout (${JSON.stringify(prev)})`);
    // The fourth (hidden) edge: from the other side.
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(-1, 1, 0.8), false); });
    await mp.waitForTimeout(200);
    await click([0, 60, 10], false);
    await mp.fill('#mc-pm input[data-num="radius"]', "5");
    await mp.press('#mc-pm input[data-num="radius"]', "Enter");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const fil = await last();
    const corner = (r, h) => (r * r - (Math.PI * r * r) / 4) * h;
    const v20 = 120000 - Math.PI * 100 * 20 - 4 * corner(5, 20);
    check(picked === 3 && near(fil.v, v20, 1e-3) && !fil.bad.length && fil.n === 5, `model: Fillet R5 on four edges picked in the view (${picked}+1 picks, ${fil.v} vs ${v20.toFixed(3)})`);
    // 1.42: Multiple radius fillet: edge 1 at 8 mm, a callout per edge; off again restores R5 everywhere.
    const filId = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), filId);
    await mp.waitForSelector('#mc-pm input[data-k="multi"]');
    await mp.check('#mc-pm input[data-k="multi"]');
    await mp.waitForSelector('#mc-pm input[data-er="0"]');
    // The panel redraws once the rebuild after the tick ends: type into the redrawn one.
    await idle();
    await mp.fill('#mc-pm input[data-er="0"]', "8");
    await mp.press('#mc-pm input[data-er="0"]', "Enter");
    await mp.waitForFunction(() => { const m = window.__sv.model.mode(); return m.kind === "feature" && m.draft.edges[0]?.r === 8; });
    await idle();
    const multiUi = await mp.evaluate(() => ({ inputs: document.querySelectorAll("#mc-pm input[data-er]").length, callouts: [...document.querySelectorAll("#mc-layer .mc-callout")].map(c => c.textContent).join("|") }));
    await mp.click("#mc-ok");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const filM = await last();
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), filId);
    await mp.waitForSelector('#mc-pm input[data-k="multi"]');
    await mp.uncheck('#mc-pm input[data-k="multi"]');
    await idle();
    await mp.click("#mc-ok");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const filBack = await last();
    const vMulti = v20 - corner(8, 20) + corner(5, 20);
    check(multiUi.inputs === 4 && /R1: 8 mm/.test(multiUi.callouts) && /R2: 5 mm/.test(multiUi.callouts) && near(filM.v, vMulti, 1e-3) && near(filBack.v, v20, 1e-3), `model 1.42: multiple radius fillet, one edge at 8 mm (${JSON.stringify(multiUi)}, ${filM.v} vs ${vMulti.toFixed(3)}, back ${filBack.v})`);
    // Edit Extrude1 to 30 mm: the face sketch, the cut and the fillets follow (topological naming).
    await mp.evaluate(() => { const ex = window.__sv.model.store.doc.features.find(f => f.type === "extrude"); window.__sv.modeller.editFeature(ex.id); });
    await mp.waitForSelector('#mc-pm input[data-num="depth"]');
    await mp.fill('#mc-pm input[data-num="depth"]', "30");
    await mp.press('#mc-pm input[data-num="depth"]', "Enter");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const ed = await last();
    const v30 = 180000 - Math.PI * 100 * 30 - 4 * corner(5, 30);
    check(near(ed.v, v30, 1e-3) && !ed.bad.length, `model: editing the extrude depth to 30 rebuilds the cut and fillets on the moved faces (${ed.v} vs ${v30.toFixed(3)})`);
    await mp.click('[data-c="undo"]');
    await idle();
    const un = await last();
    await mp.click('[data-c="redo"]');
    await idle();
    const re = await last();
    check(near(un.v, v20, 1e-3) && near(re.v, v30, 1e-3), `model: Undo / Redo restore the 20 mm and 30 mm bodies (${un.v}, ${re.v})`);
    // Suppress the fillet: the corners come back.
    await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.find(f => f.type === "fillet"); window.__sv.modeller.toggleSuppress(f.id); });
    await idle();
    const sup = await last();
    await mp.evaluate(() => window.__sv.modeller.undo());
    await idle();
    check(near(sup.v, 180000 - Math.PI * 100 * 30, 1e-3), `model: suppressing the fillet restores the sharp corners (${sup.v})`);
    // Measuring tools work on the modelled body: exact cylinder radius of the hole.
    const hole = await mp.evaluate(() => { const p = window.__sv.viewer.parts[0]; const c = p.data.faces.find(f => f.type === "cylinder" && f.radius > 9); return c?.radius; });
    check(near(hole, 10, 1e-6), `model: Smart measure data on the body: hole radius ${hole}`);
    // Save as .mcadprt (download fallback), STEP export, reopen.
    await mp.evaluate(() => { window.showSaveFilePicker = undefined; });
    const [dlPart] = await Promise.all([mp.waitForEvent("download"), mp.click('[data-c="save"]')]);
    const partBytes = await readFile(await dlPart.path());
    const saved = await mp.evaluate(() => ({ dirty: window.__sv.model.store.dirty, doc: document.querySelector("#doc-name").textContent }));
    check(/Part1\.mcadprt$/.test(dlPart.suggestedFilename()) && partBytes.readUInt32LE(0) === 0x04034b50 && !saved.dirty && !/•/.test(saved.doc), `model: Save writes ${dlPart.suggestedFilename()} (${partBytes.length} bytes, a zip) and clears the unsaved mark`);
    const [dlStep] = await Promise.all([mp.waitForEvent("download"), mp.click('[data-c="step"]')]);
    const stepBack = readStep(await readFile(await dlStep.path()));
    check(stepBack.ok && stepBack.meshes === 1 && stepBack.faces === 11, `model: STEP export of the body reads back (${JSON.stringify(stepBack)})`);
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const recov0 = await mp.evaluate(() => document.querySelector("#mc-recover").hidden);
    await mp.setInputFiles("#file-input", { name: "Part1.mcadprt", mimeType: "application/zip", buffer: partBytes });
    await mp.waitForFunction(() => window.__sv.model.last(), null, { timeout: 60000 });
    await idle();
    const reopened = await last();
    check(recov0 && reopened.n === 5 && near(reopened.v, v30, 1e-3), `model: the saved file opens again with 5 features and the same volume (${reopened.v})`);
    // 1.44: the save made a snapshot; after suppressing the fillet, Restore brings the saved part back, Open as copy opens it under a new id.
    await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.find(f => f.type === "fillet"); window.__sv.modeller.toggleSuppress(f.id); });
    await idle();
    await mp.click('#mc-quick [data-fly="save"]');
    await mp.click('#mc-menu button:has-text("Snapshots…")');
    await mp.waitForSelector("#mc-snaps[open] [data-snap-restore]");
    const snapRows = await mp.evaluate(() => document.querySelectorAll("#mc-snaps tbody tr").length);
    await mp.click('#mc-snaps [data-snap-restore="0"]');
    // Restore reads the snapshot first, then changes the part: wait for the fillet to come back.
    await mp.waitForFunction(() => !window.__sv.model.store.doc.features.find(f => f.type === "fillet").suppressed);
    await mp.waitForFunction(v => Math.abs((window.__sv.model.last()?.props?.volume ?? 0) - v) < 1, v30, { timeout: 30000 }).catch(() => {});
    await idle();
    const restored = await last();
    const idBefore = await mp.evaluate(() => window.__sv.model.store.doc.id);
    await mp.click('#mc-quick [data-fly="save"]');
    await mp.click('#mc-menu button:has-text("Snapshots…")');
    await mp.waitForSelector("#mc-snaps[open] [data-snap-copy]");
    await mp.click('#mc-snaps [data-snap-copy="0"]');
    await mp.waitForFunction(id => window.__sv.model.store.doc.id !== id, idBefore);
    await idle();
    const copy = await mp.evaluate(() => ({ name: document.querySelector("#doc-name").textContent, n: window.__sv.model.store.doc.features.length }));
    check(snapRows >= 1 && near(restored.v, v30, 1e-3) && restored.n === 5 && /\(copy\)/.test(copy.name) && copy.n === 5, `model 1.44: save snapshots, Restore and Open as copy (${snapRows} rows, ${restored.v}, ${JSON.stringify(copy)})`);
    // Autosave journal: an unsaved change is offered after a reload.
    await mp.evaluate(() => { const ex = window.__sv.model.store.doc.features.find(f => f.type === "extrude"); window.__sv.model.store.change("Rename", d => { d.features.find(f => f.id === ex.id).name = "Base"; }); });
    await mp.waitForTimeout(1200);
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const rec = await mp.evaluate(() => ({ shown: !document.querySelector("#mc-recover").hidden, btn: document.querySelector("#mc-recover [data-rec]")?.textContent }));
    await mp.click("#mc-recover [data-rec]");
    await mp.waitForFunction(() => window.__sv.model.last(), null, { timeout: 60000 });
    await idle();
    const recName = await mp.evaluate(() => window.__sv.model.store.doc.features.map(f => f.name).join(","));
    check(rec.shown && /Recover/.test(rec.btn) && recName.includes("Base"), `model: unsaved work is recovered after a reload (${rec.btn}: ${recName})`);
    // Accessibility and Russian with the sketcher open.
    await mp.evaluate(() => window.__sv.modeller.editSketch(window.__sv.model.store.doc.features[0].id));
    await idle();
    await mp.addScriptTag({ content: await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8") });
    const axeModel = await mp.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", ")}`));
    check(axeModel.length === 0, `model: 0 WCAG 2.1 AA violations with the sketcher open${axeModel.length ? ": " + axeModel.join(" | ") : ""}`);
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const leftRu = await mp.evaluate(() => {
      const OK = /^(MöbiusCAD|STEP|IGES|BREP|DXF|XY|YZ|XZ|Ctrl|Esc|Enter|Shift|Del|Delete|mcadprt|mm|DOF|D\d+|Part\d+|Base|S|L|R|C|A|P|D|Q|Y|Z|H|V|T|M)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      for (const root of document.querySelectorAll("#tab-features, #mc-bar, #cm, #mc-confirm, #sk-layer, #t-features")) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n.parentElement)) test(n.data, "text");
        for (const e of [root, ...root.querySelectorAll("[title], [aria-label]")]) for (const a of ["title", "aria-label"]) { const v = e.getAttribute(a); if (v && !skip(e)) test(v, a); }
      }
      return [...bad];
    });
    check(leftRu.length === 0, `model i18n: command bar, feature tree and sketch panel in Russian${leftRu.length ? ": " + leftRu.slice(0, 6).join(" | ") : ""}`);
    await mp.click("#lang-btn");
    await ctx.close();
  }

  // --- Part modelling 1.19.0 (FRS P1 rest): empty-state planes, polygon, drag arrow, rollback bar, rename, menu, reference plane, up to face, trim, sketch fillet, views, properties ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const last = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: l.props?.volume ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.code), n: window.__sv.model.store.doc.features.length }; });
    const toPage = (p, sketch) => mp.evaluate(([p, sketch]) => {
      const v = window.__sv.viewer, f = sketch ? window.__sv.model.editor().frame : null;
      const w = f ? [0, 1, 2].map(i => f.o[i] + f.x[i] * p[0] + f.y[i] * p[1]) : p;
      const q = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, [p, sketch]);
    const click = async (p, sketch = true) => { const [x, y] = await toPage(p, sketch); await mp.mouse.move(x, y); await mp.waitForTimeout(30); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(60); };
    const iso = () => mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    const ents = () => mp.evaluate(() => window.__sv.model.editor().sk.ents);

    await mp.click("#empty-new");
    const cardGone = await mp.evaluate(() => document.querySelector("#empty").hidden);
    check(cardGone, "model 1.19: New part on the start card hides the card at once");
    await mp.waitForSelector("#mc-empty:not([hidden])");
    const rows0 = await mp.evaluate(() => [...document.querySelectorAll("#mc-tree .ft-name")].map(e => e.textContent).join("|"));
    await mp.click('#mc-empty [data-plane="XY"]');
    await idle();
    await mp.waitForTimeout(500);
    const onTop = await mp.evaluate(() => ({ kind: window.__sv.model.mode().kind, plane: window.__sv.model.store.doc.features[0]?.plane, empty: document.querySelector("#mc-empty").hidden }));
    check(rows0.startsWith("Part1|Material <not specified>|Configuration: Default|Equations|Top (XY)") && onTop.kind === "sketch" && onTop.plane?.std === "XY" && onTop.empty, `model 1.19: an empty part offers the three planes; Top starts a sketch (${rows0}, ${JSON.stringify(onTop)})`);
    // Polygon: six equal sides on a construction circle.
    await mp.keyboard.press("g");
    await click([0, 0]);
    { const [x, y] = await toPage([30, 0], true); await mp.mouse.move(x, y); await mp.waitForTimeout(60); }
    const cursorTxt = await mp.evaluate(() => document.querySelector("#sk-layer .sk-cursor")?.textContent);
    check(/^R 30(\.0+)?$|^R 29\.99|^R 30\.0/.test(cursorTxt ?? ""), `model 1.19: the live size shows beside the cursor while drawing (${cursorTxt})`);
    await click([30, 0]);
    const poly = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk; return { lines: sk.ents.filter(e => e.t === "line").length, cons: sk.ents.filter(e => e.t === "circle" && e.cons).length, eq: sk.rels.filter(r => r.t === "equal").length, ok: window.__sv.model.editor().info.status }; });
    check(poly.lines === 6 && poly.cons === 1 && poly.eq === 5 && poly.ok === "ok", `model 1.19: polygon makes 6 equal lines on a construction circle (${JSON.stringify(poly)})`);
    // 1.45: under-defined analysis: a selected polygon side shows orange free-motion arrows (FR-SLV-010).
    const freeArr = await mp.evaluate(() => { const ed = window.__sv.model.editor(); const l = ed.sk.ents.find(e => e.t === "line"), prev = ed.tool; ed.setTool("select"); ed.selection.clear(); ed.selection.add(l.id); ed.render(); const n = ed.freeArrows; ed.selection.clear(); ed.render(); const after = ed.freeArrows; ed.setTool(prev); return { n, dof: ed.info.dof, after }; });
    check(freeArr.n >= 2 && freeArr.dof > 0 && freeArr.after === 0, `model 1.45: a selected under-defined line shows free-motion arrows (${JSON.stringify(freeArr)})`);
    // 1.48: sketch assistant (FR-SLV-009): two different sizes on equal sides over-define it; the panel offers deletions that fix it.
    const assist = await mp.evaluate(() => {
      const m = window.__sv.model, ed = m.editor(), orig = structuredClone(ed.sk);
      const ls = ed.sk.ents.filter(e => e.t === "line");
      const bad = structuredClone(ed.sk);
      bad.dims.push({ id: "xd1", name: "X1", t: "distance", e: [ls[0].id], val: { v: 30 } }, { id: "xd2", name: "X2", t: "distance", e: [ls[1].id], val: { v: 40 } });
      ed.setSketch(bad, ed.frame);
      m.panel();
      const over = ed.info.status;
      const rows = [...document.querySelectorAll("#mc-pm .pm-assist [data-fixapply]")].map(b => b.dataset.fixapply);
      document.querySelector("#mc-pm .pm-assist [data-fixshow]")?.click();
      const shown = [...ed.selection].join(",");
      document.querySelector("#mc-pm .pm-assist [data-fixapply]")?.click();
      const after = { status: ed.info.status, gone: !document.querySelector("#mc-pm .pm-assist") };
      ed.setSketch(orig, ed.frame); ed.commit("Restore"); m.panel();
      return { over, rows, shown, after };
    });
    check(assist.over === "conflict" && assist.rows.length >= 2 && assist.rows.includes("xd1") && assist.shown === assist.rows[0] && assist.after.status === "ok" && assist.after.gone, `model 1.48: the sketch assistant lists deletions that fix an over-defined sketch and applies one (${JSON.stringify(assist)})`);
    // 1.50: Merge points and the Intersection relation (FR-SK-051).
    const merge = await mp.evaluate(() => {
      const m = window.__sv.model, ed = m.editor(), orig = structuredClone(ed.sk);
      const next = structuredClone(ed.sk);
      next.ents.push({ id: "m1", t: "point", x: 100, y: 100 }, { id: "m2", t: "point", x: 104, y: 100 }, { id: "m3", t: "point", x: 120, y: 120 }, { id: "ml", t: "line", a: "m2", b: "m3" });
      ed.setSketch(next, ed.frame);
      ed.select(["m1", "m2"]);
      m.panel();
      const btn = !!document.querySelector('#mc-pm [data-a="merge"]');
      document.querySelector('#mc-pm [data-a="merge"]')?.click();
      const line = ed.sk.ents.find(e => e.id === "ml");
      const res = { btn, gone: !ed.sk.ents.some(e => e.id === "m2"), a: line?.a, status: ed.info.status };
      const ls = ed.sk.ents.filter(e => e.t === "line" && e.id !== "ml");
      ed.select(["m3", ls[0].id, ls[1].id]);
      res.inter = ed.validRelations().includes("intersection");
      ed.setSketch(orig, ed.frame); ed.commit("Restore"); m.panel();
      return res;
    });
    check(merge.btn && merge.gone && merge.a === "m1" && merge.status === "ok" && merge.inter, `model 1.50: Merge points joins two points into one; a point and two lines offer Intersection (${JSON.stringify(merge)})`);
    // 1.51: ordinate dimensions from a base, and a diameter about a centerline (FR-SK-063).
    const ordDia = await mp.evaluate(async () => {
      const m = window.__sv.model, ed = m.editor(), orig = structuredClone(ed.sk);
      const next = structuredClone(ed.sk);
      next.ents.push({ id: "o1", t: "point", x: 130, y: 50 }, { id: "o2", t: "point", x: 160, y: 70 }, { id: "o3", t: "point", x: 175, y: 45 },
        { id: "c1", t: "point", x: 220, y: 0 }, { id: "c2", t: "point", x: 220, y: 30 }, { id: "cl", t: "line", a: "c1", b: "c2", cons: true }, { id: "dp", t: "point", x: 232, y: 15 });
      ed.setSketch(next, ed.frame);
      const tick = () => new Promise(r => setTimeout(r, 30));
      ed.setTool("hord");
      ed.ordClick([130, 50]); ed.ordClick([145, 30]); ed.ordClick([160, 70]); await tick(); ed.closeInput(false); ed.ordClick([175, 45]); await tick(); ed.closeInput(false);
      const ords = ed.sk.dims.filter(d => d.ord).map(d => `${d.t}:${d.e.join("-")}:${Math.round(d.val.v)}:${Math.round(d.pos[1])}`);
      const zero = [...document.querySelectorAll(".sk-dim.ord0")].map(e => e.textContent);
      ed.setTool("dim");
      ed.dimClick([232, 15], {}); ed.dimClick([220, 20], {}); ed.dimClick([205, 15], {}); await tick(); ed.closeInput(false);
      const dd = ed.sk.dims.find(d => d.e.includes("dp"));
      const dia = { e: dd?.e.join("-"), dia: !!dd?.dia, v: dd && Math.round(dd.val.v), label: [...document.querySelectorAll(".sk-dim")].find(e => e.dataset.id === dd?.id)?.textContent };
      ed.setTool("select");
      ed.setSketch(orig, ed.frame); ed.commit("Restore"); m.panel();
      return { ords, zero, dia };
    });
    check(ordDia.ords.join() === "hdistance:o1-o2:30:30,hdistance:o1-o3:45:30" && ordDia.zero.join() === "0" && ordDia.dia.e === "cl-dp" && ordDia.dia.dia && ordDia.dia.v === 24 && ordDia.dia.label === "⌀24", `model 1.51: horizontal ordinate dimensions from a base, and a ⌀ dimension about a centerline (${JSON.stringify(ordDia)})`);
    // Ctrl+8: normal to the sketch.
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); });
    await mp.keyboard.press("Control+8");
    await mp.waitForTimeout(700);
    const nz = await mp.evaluate(() => { const v = window.__sv.viewer; return v.camera.position.clone().sub(v.controls.target).normalize().z; });
    check(nz > 0.999, `model 1.19: Ctrl+8 turns the view normal to the sketch (${nz})`);
    // Leaving the sketch merges its steps into one undo step.
    await mp.keyboard.press("Enter");
    await idle();
    const und = await mp.evaluate(() => { const s = window.__sv.model.store; const label = s.undoLabel; s.undo(); const n = s.doc.features.length; s.redo(); return { label, n, after: s.doc.features.length }; });
    await idle();
    check(und.label === "Add Sketch1" && und.n === 0 && und.after === 1, `model 1.19: a sketch is one undo step on the part (${JSON.stringify(und)})`);
    // Extrude, then drag the depth arrow.
    await mp.click('[data-c="extrude"]');
    await idle();
    await iso();
    await mp.waitForTimeout(300);
    const handle = await mp.evaluate(() => !!document.querySelector("#mc-layer .mc-handle"));
    const area = await mp.evaluate(() => { const sk = window.__sv.model.store.doc.features[0]; const p = sk.ents.filter(e => e.t === "point" && e.id !== sk.ents.find(x => x.t === "circle").c); const ls = sk.ents.filter(e => e.t === "line"); const P = id => sk.ents.find(e => e.id === id); return Math.abs(ls.reduce((a, l) => a + P(l.a).x * P(l.b).y - P(l.b).x * P(l.a).y, 0) / 2); });
    const tip = await toPage([0, 0, 10 + 0.5], false);
    const far = await toPage([0, 0, 25], false);
    await mp.mouse.move(tip[0], tip[1]);
    await mp.mouse.down();
    for (let i = 1; i <= 6; i++) { await mp.mouse.move(tip[0] + ((far[0] - tip[0]) * i) / 6, tip[1] + ((far[1] - tip[1]) * i) / 6); await mp.waitForTimeout(40); }
    await mp.mouse.up();
    await idle();
    const dragged = await mp.evaluate(() => window.__sv.model.mode().draft?.depth?.v);
    const camOk = await mp.evaluate(() => window.__sv.viewer.controls.enabled !== false);
    await mp.click("#mc-ok");
    await idle();
    const exv = await last();
    check(handle && dragged > 18 && dragged < 32 && near(exv.v, area * dragged, 1e-3 * exv.v) && camOk, `model 1.19: dragging the extrude arrow sets the depth (${dragged} mm, ${exv.v.toFixed(1)} mm³ = area ${area.toFixed(2)} × depth)`);
    // Select it in the tree: the arrow edits it at once (one undo step).
    await mp.click(`#mc-tree .ft-row[data-id="${await mp.evaluate(() => window.__sv.model.store.doc.features[1].id)}"]`);
    await mp.waitForTimeout(200);
    const t2 = await toPage([0, 0, dragged + 0.5], false), f2 = await toPage([0, 0, dragged - 8], false);
    await mp.mouse.move(t2[0], t2[1]);
    await mp.mouse.down();
    for (let i = 1; i <= 5; i++) { await mp.mouse.move(t2[0] + ((f2[0] - t2[0]) * i) / 5, t2[1] + ((f2[1] - t2[1]) * i) / 5); await mp.waitForTimeout(40); }
    await mp.mouse.up();
    await idle();
    const inst = await mp.evaluate(() => ({ d: window.__sv.model.store.doc.features[1].depth.v, mode: window.__sv.model.mode().kind, label: window.__sv.model.store.undoLabel }));
    check(inst.d < dragged - 4 && inst.mode === "none" && inst.label === "Edit Extrude1", `model 1.19: dragging the arrow of the selected extrude edits it in place (${dragged} → ${inst.d}, ${inst.label})`);
    // Rollback bar with the keyboard, then back to the end.
    await mp.focus("#mc-tree .ft-rollback");
    await mp.keyboard.press("ArrowUp");
    await idle();
    const rb = await mp.evaluate(() => ({ rb: window.__sv.model.store.doc.rollback, v: window.__sv.model.last().props?.volume ?? 0, rolled: document.querySelectorAll("#mc-tree .ft-row.rolled").length }));
    await mp.focus("#mc-tree .ft-rollback");
    await mp.keyboard.press("End");
    await idle();
    const rb2 = await mp.evaluate(() => window.__sv.model.store.doc.rollback);
    check(rb.rb === 1 && rb.v === 0 && rb.rolled === 1 && rb2 === null, `model 1.19: the rollback bar moves up a feature and back to the end (${JSON.stringify(rb)}, ${rb2})`);
    // Rename with F2, and the context menu.
    const exId = await mp.evaluate(() => window.__sv.model.store.doc.features[1].id);
    await mp.click(`#mc-tree .ft-row[data-id="${exId}"]`);
    await mp.keyboard.press("F2");
    await mp.fill("#mc-tree .ft-ren", "Hex body");
    await mp.keyboard.press("Enter");
    const ren = await mp.evaluate(() => window.__sv.model.store.doc.features[1].name);
    await mp.click(`#mc-tree .ft-row[data-id="${exId}"]`, { button: "right" });
    const menu = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent));
    await mp.keyboard.press("Escape");
    const menuGone = await mp.evaluate(() => document.querySelector("#mc-menu").hidden);
    check(ren === "Hex body" && menu.includes("Roll back to here") && menu.includes("Rename") && menu.includes("Edit sketch") && menuGone, `model 1.19: F2 renames; the row menu has the feature actions (${ren}; ${menu.join(", ")})`);
    // Absorbed sketch nested under the extrude.
    const nested = await mp.evaluate(() => { const r = [...document.querySelectorAll("#mc-tree .ft-row[data-i]")]; return r.map(x => (x.classList.contains("child") ? ">" : "") + x.textContent.replace(/[●◌✕]/g, "").trim().slice(1)).join("|"); });
    check(/Hex body\|>Sketch1/.test(nested), `model 1.19: the extrude's sketch is shown under it (${nested})`);
    // Reference plane 40 mm above Top, then a Ø10 boss on it extruded up to the hexagon's top face.
    await mp.click('#mc-tree .ft-row[data-id="std:XY"]');
    await mp.click('[data-c="plane"]');
    await mp.waitForSelector('#mc-pm input[data-num="offset"]');
    await mp.fill('#mc-pm input[data-num="offset"]', "40");
    // A rebuild finishing while the value is typed must not put the old value back.
    await mp.evaluate(() => window.__sv.model.panel());
    const kept = await mp.evaluate(() => { const i = document.querySelector('#mc-pm input[data-num="offset"]'); return { v: i.value, focus: document.activeElement === i }; });
    check(kept.v === "40" && kept.focus, `model 1.19: a value being typed survives a rebuild of the panel (${JSON.stringify(kept)})`);
    await mp.press('#mc-pm input[data-num="offset"]', "Enter");
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    const pl = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.at(-1); return { type: f.type, o: window.__sv.model.last().frames[f.id]?.o, id: f.id }; });
    check(pl.type === "plane" && near(pl.o?.[2], 40, 1e-9), `model 1.19: Plane offset 40 mm from Top (${JSON.stringify(pl)})`);
    await mp.click(`#mc-tree .ft-row[data-id="${pl.id}"]`);
    await mp.click('[data-c="sketch"]');
    await idle();
    await mp.waitForTimeout(500);
    await mp.keyboard.press("c");
    await click([0, 0]); await click([5, 0]);
    const r5 = await mp.evaluate(() => window.__sv.model.editor().sk.ents.find(e => e.t === "circle")?.r);
    await mp.keyboard.press("Enter");
    await idle();
    await mp.click('[data-c="extrude"]');
    await mp.selectOption("#mc-pm select[data-k=end]", "upto");
    await idle();
    await iso();
    await mp.waitForTimeout(300);
    // The hexagon's top face, off the boss.
    await click([15, 8, inst.d], false);
    await idle();
    const upLabel = await mp.$eval("#mc-pm [data-k=focus-upto]", b => b.textContent);
    await mp.click("#mc-ok");
    await idle();
    const up = await last();
    const vUp = area * inst.d + Math.PI * r5 * r5 * (40 - inst.d);
    check(/Face of Hex body/.test(upLabel) && near(up.v, vUp, 1e-3 * vUp) && !up.bad.length, `model 1.19: Extrude up to face stops at the picked face (${upLabel}; ${up.v.toFixed(2)} vs ${vUp.toFixed(2)})`);
    // Sketch tools: trim, 3-point circle and sketch fillet on Front.
    await mp.evaluate(() => window.__sv.modeller.startSketch());
    await mp.click('#mc-pm [data-std="XZ"]');
    await idle();
    await mp.waitForTimeout(1000);
    await mp.keyboard.press("l");
    await click([-30, 10]); await click([10, 10]); await mp.keyboard.press("Escape");
    await mp.keyboard.press("l");
    await click([-10, 0]); await click([-10, 20]); await mp.keyboard.press("Escape");
    await mp.keyboard.press("t");
    await click([5, 10]);
    const trimmed = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk; const P = id => sk.ents.find(e => e.id === id); const h = sk.ents.filter(e => e.t === "line").find(l => Math.abs(P(l.a).y - P(l.b).y) < 1e-6); return h ? Math.max(P(h.a).x, P(h.b).x) : null; });
    check(trimmed !== null && near(trimmed, -10, 0.01), `model 1.19: Trim cuts the line back to the crossing (end at x = ${trimmed})`);
    // 3-point circle sits in the Circle flyout.
    await mp.click('#mc-tools [data-fly="circle"]');
    await mp.click("#mc-menu button:nth-child(2)");
    await click([15, 5]); await click([35, 5]); await click([25, 15]);
    const c3 = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk; const c = sk.ents.find(e => e.t === "circle"); const P = sk.ents.find(e => e.id === c?.c); return c && [c.r, P.x, P.y]; });
    check(c3 && near(c3[0], 10, 0.3) && near(c3[1], 25, 0.3) && near(c3[2], 5, 0.3), `model 1.19: 3-point circle through three clicks (${c3})`);
    await mp.keyboard.press("r");
    await click([-35, -15]); await click([-15, -5]);
    await mp.keyboard.press("f");
    await click([-15, -5]);
    const fl = await mp.evaluate(() => { const e = window.__sv.model.editor(); const sk = e.sk; return { arcs: sk.ents.filter(x => x.t === "arc").length, tan: sk.rels.filter(r => r.t === "tangent").length, dim: sk.dims.some(d => d.t === "radius" && Math.abs(d.val.v - 2) < 1e-9), ok: e.info.status }; });
    check(fl.arcs === 1 && fl.tan === 2 && fl.dim && fl.ok === "ok", `model 1.19: sketch fillet rounds the corner with a tangent R2 arc (${JSON.stringify(fl)})`);
    // RU and accessibility with the sketch panel (relations list) open.
    await mp.addScriptTag({ content: await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8") });
    const axe = () => mp.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", ")}`));
    const ax1 = await axe();
    const ruScan = () => mp.evaluate(() => {
      const OK = /^(MöbiusCAD|STEP|IGES|BREP|DXF|XY|YZ|XZ|Ctrl|Esc|Enter|Shift|Del|Delete|mcadprt|mm|DOF|D\d+|Part\d+|Base|Hex|body|S|L|R|C|A|P|D|Q|Y|Z|H|V|T|M|g|cm|Ti|Al|ABS|PLA|PA6|POM|Delrin|PEEK)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      for (const root of document.querySelectorAll("#tab-features, #mc-bar, #cm, #mc-confirm, #sk-layer, #mc-layer, #mc-menu, #t-features")) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n.parentElement)) test(n.data, "text");
        for (const e of [root, ...root.querySelectorAll("[title], [aria-label]")]) for (const a of ["title", "aria-label"]) { const v = e.getAttribute(a); if (v && !skip(e)) test(v, a); }
      }
      return [...bad];
    });
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru1 = await ruScan();
    await mp.click("#lang-btn");
    await mp.keyboard.press("Enter");
    await idle();
    // Part properties: material Aluminium; the mass panel shows principal moments.
    await mp.dblclick('#mc-tree .ft-row[data-id="part"]');
    await mp.waitForSelector("#mc-pm select[data-p=material]");
    await mp.selectOption("#mc-pm select[data-p=material]", { label: "Aluminium 6061 (2.7)" });
    await mp.fill("#mc-pm input[data-p=partNumber]", "HX-001");
    await mp.press("#mc-pm input[data-p=partNumber]", "Tab");
    const ax2 = await axe();
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru2 = await ruScan();
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await idle();
    const props = await mp.evaluate(() => ({ m: window.__sv.model.store.doc.material, pn: window.__sv.model.store.doc.props.partNumber, row: document.querySelector('#mc-tree .ft-row[data-id="material"] .ft-name').textContent, dens: document.querySelector("#density").value }));
    check(props.m?.density === 2.7 && props.pn === "HX-001" && props.row === "Aluminium 6061" && props.dens === "2.7", `model 1.19: part properties set the material, part number and the mass panel's density (${JSON.stringify(props)})`);
    await mp.evaluate(() => document.querySelector("#mass-run").click());
    await mp.waitForTimeout(300);
    const massTxt = await mp.evaluate(() => document.querySelector("#mass-out").textContent);
    check(/Principal moments.*kg·mm²/.test(massTxt) && /Principal axes/.test(massTxt), `model 1.19: mass properties list the principal moments of the modelled part (${massTxt.match(/Principal moments[^A-Z]*/)?.[0]})`);
    // 1.43: mass property override (FR-MAT-004): 1.25 kg and a centre of mass replace the calculated values.
    await mp.dblclick('#mc-tree .ft-row[data-id="part"]');
    await mp.waitForSelector("#mc-pm input[data-p=ovr]");
    await mp.check("#mc-pm input[data-p=ovr]");
    await mp.waitForSelector("#mc-pm input[data-p=ovrMass]");
    await mp.fill("#mc-pm input[data-p=ovrMass]", "1.25");
    await mp.press("#mc-pm input[data-p=ovrMass]", "Tab");
    for (const [i, v] of [[0, "1"], [1, "2"], [2, "3"]]) { await mp.fill(`#mc-pm input[data-p=ovrCom][data-i="${i}"]`, v); await mp.press(`#mc-pm input[data-p=ovrCom][data-i="${i}"]`, "Tab"); }
    await mp.click("#mc-ok");
    await idle();
    await mp.evaluate(() => document.querySelector("#mass-run").click());
    await mp.waitForTimeout(300);
    const ovrTxt = await mp.evaluate(() => ({ out: document.querySelector("#mass-out").textContent, doc: JSON.stringify(window.__sv.model.store.doc.massOverride) }));
    check(/1\.2500 kg \(overridden\)/.test(ovrTxt.out) && /\(overridden\)/.test(ovrTxt.out.split("Centre of mass")[1] ?? "") && ovrTxt.doc === '{"mass":1.25,"com":[1,2,3]}', `model 1.43: mass property override replaces mass and centre of mass (${ovrTxt.doc}, ${ovrTxt.out.match(/Mass[^S]*/)?.[0]})`);
    check(ax1.length === 0 && ax2.length === 0, `model 1.19: 0 WCAG 2.1 AA violations with the sketch and properties panels open${ax1.length + ax2.length ? ": " + [...ax1, ...ax2].join(" | ") : ""}`);
    check(ru1.length === 0 && ru2.length === 0, `model 1.19 i18n: new tools, relations list and properties in Russian${ru1.length + ru2.length ? ": " + [...ru1, ...ru2].slice(0, 8).join(" | ") : ""}`);
    await ctx.close();
  }

  // --- Part modelling 1.19.4: revolve angle handle, cut preview of the removed material ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 60000 });
    const scr = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 10 × 10 square 10 mm from a construction axis, revolved 90°.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); window.__sv.model.store.change("Revolve", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("o", 0, 0), P("q", 0, 10), { id: "ax", t: "line", a: "o", b: "q", cons: true }, P("a", 10, 0), P("b", 20, 0), P("c", 20, 10), P("d", 10, 10), { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }, { id: "l3", t: "line", a: "c", b: "d" }, { id: "l4", t: "line", a: "d", b: "a" }] }, { id: "r", type: "revolve", name: "Revolve1", sketch: "s", op: "boss", axis: "ax", angle: { v: Math.PI / 2 } }); }); });
    await idle();
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(0.2, 1, 0.6), false); v.fit(false); v.camera.zoom *= 0.6; v.camera.updateProjectionMatrix(); v.invalidate(); });
    await mp.click('#mc-tree .ft-row[data-id="r"]');
    await mp.waitForTimeout(300);
    const st = await mp.evaluate(() => { const a = window.__sv.modeller.arrow; return a?.ang ? { head: a.ang.head.position.toArray(), c: a.ang.c.toArray(), u: a.ang.u.toArray(), r: a.ang.r.toArray(), label: document.querySelector("#mc-layer .mc-handle")?.textContent } : null; });
    // Drag the grip round the axis from 90° to 180° (Rodrigues rotation of the 0° radius).
    const at = q => { const [ux, uy, uz] = st.u, [rx, ry, rz] = st.r, c = Math.cos(q), s = Math.sin(q), d = ux * rx + uy * ry + uz * rz, cr = [uy * rz - uz * ry, uz * rx - ux * rz, ux * ry - uy * rx]; return [0, 1, 2].map(i => st.c[i] + [rx, ry, rz][i] * c + cr[i] * s + [ux, uy, uz][i] * d * (1 - c)); };
    if (st) {
      const h = await scr(st.head);
      await mp.mouse.move(h[0], h[1]);
      await mp.mouse.down();
      for (let i = 1; i <= 12; i++) { const s = await scr(at(Math.PI / 2 + (Math.PI / 2 * i) / 12)); await mp.mouse.move(s[0], s[1]); await mp.waitForTimeout(30); }
      await mp.mouse.up();
      await idle();
    }
    const rv = await mp.evaluate(() => ({ a: Math.round(window.__sv.model.store.doc.features[1].angle.v * 180 / Math.PI), v: window.__sv.model.last().props.volume, mode: window.__sv.model.mode().kind, label: window.__sv.model.store.undoLabel }));
    check(st?.label === "90°" && rv.a === 180 && near(rv.v, Math.PI * 300 * 10 / 2, 1e-3) && rv.mode === "none" && rv.label === "Edit Revolve1", `model 1.19.4: dragging the revolve handle round the axis sets the angle (${st?.label} → ${JSON.stringify(rv)})`);
    // 1.29 revolve options (FR-FT-022): up to the YZ plane through the axis (a quarter turn), then a 2 mm thin wall; cancelled.
    await mp.evaluate(() => window.__sv.modeller.editFeature("r"));
    await mp.waitForSelector('#mc-pm select[data-k="rvEnd"]');
    await mp.selectOption('#mc-pm select[data-k="rvEnd"]', "upto");
    await mp.click('#mc-tree .ft-row[data-id="std:YZ"]');
    await mp.waitForFunction(() => window.__sv.model.mode().draft?.upTo, null, { timeout: 10000 });
    await idle();
    await mp.waitForTimeout(200);
    await idle();
    const vUpto = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.check('#mc-pm input[data-k="thinOn"]');
    await mp.waitForTimeout(200);
    await idle();
    const vThinRv = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.keyboard.press("Escape");
    await idle();
    const vBack = await mp.evaluate(() => window.__sv.model.last().props.volume);
    check(near(vUpto, Math.PI * 300 * 10 / 4, 0.01) && near(vThinRv, 2 * Math.PI * 15 * 64 / 4, 0.01) && near(vBack, Math.PI * 300 * 10 / 2, 0.01), `model 1.29: revolve up to a plane through the axis, thin revolve, cancel restores (${vUpto.toFixed(1)}, ${vThinRv.toFixed(1)}, ${vBack.toFixed(1)})`);
    // Cut preview: a Ø6 × 4 blind cut into the ring from its flat side shows the removed material in yellow.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); window.__sv.model.store.change("Cut", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XZ" }, rels: [], dims: [], ents: [P("o2", 0, -15), { id: "c2", t: "circle", c: "o2", r: 3 }] }, { id: "k", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "blind", depth: { v: 4 } }); }); });
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editFeature("k"));
    await mp.waitForTimeout(300);
    await idle();
    await mp.waitForTimeout(300);
    const cp = await mp.evaluate(() => { const l = window.__sv.model.last(); const P = l.preview?.position ?? []; let vol = 0; for (let i = 0; i < P.length; i += 9) { const [ax, ay, az, bx, by, bz, cx, cy, cz] = P.slice(i, i + 9); vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6; } return { tris: P.length / 9, vol: Math.abs(vol), drawn: window.__sv.modeller.decor.children.some(c => c.userData.cutPreview) }; });
    check(cp.drawn && near(cp.vol, Math.PI * 9 * 4, 0.05 * Math.PI * 9 * 4), `model 1.19.4: an open cut previews the material it removes (${JSON.stringify(cp)} vs ${(Math.PI * 36).toFixed(2)} mm³)`);
    await mp.keyboard.press("Escape");
    await ctx.close();
  }

  // --- Part modelling 1.20.0: slot, extend, split, sketch chamfer, offset and convert entities, sketch-bar flyouts ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const toPage = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const click = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(80); };
    const tool = t => mp.evaluate(t => window.__sv.model.editor().setTool(t), t);
    const lines = () => mp.evaluate(() => { const sk = window.__sv.model.editor().sk; const P = id => sk.ents.find(e => e.id === id); return sk.ents.filter(e => e.t === "line").map(e => [P(e.a).x, P(e.a).y, P(e.b).x, P(e.b).y].map(x => Math.round(x * 1000) / 1000).join(" ")); });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", 10, 10), P("b", 50, 10), P("c", 50, 30), P("d", 10, 30), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a"), P("e", 60, 10), P("f", 60, 20), L("v", "e", "f"), P("g", 55, 40), P("h", 70, 40), L("hz", "g", "h")] }); }); });
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    await idle();
    // Flyout: Trim ▾ → Extend.
    await mp.click('#mc-tools [data-fly="trim"]');
    const fly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent));
    await mp.click("#mc-menu button:nth-child(2)");
    const flyTool = await mp.evaluate(() => ({ tool: window.__sv.model.editor().tool, shown: document.querySelector('#mc-tools [data-c^="sk:"][data-c="sk:extend"]')?.textContent?.trim() }));
    check(fly.join("|") === "Trim|Extend|Split" && flyTool.tool === "extend" && flyTool.shown === "Extend", `model 1.20: the sketch bar groups Trim, Extend and Split in a flyout (${fly.join("|")}, ${JSON.stringify(flyTool)})`);
    // Offset the rectangle 5 mm inwards: a closed chain of four parallel lines.
    await tool("offset");
    await mp.evaluate(() => { window.__sv.model.editor().offsetDist = 5; });
    await click([30, 10.4]);
    const off = await lines();
    check(["15 15 45 15", "45 15 45 25", "45 25 15 25", "15 25 15 15"].every(l => off.includes(l)), `model 1.20: Offset entities insets the rectangle's chain by 5 mm (${off.slice(-4).join(", ")})`);
    // Extend the vertical line up to the horizontal one; split the top edge; chamfer a corner.
    await tool("extend");
    await click([60, 19]);
    const ext = await lines();
    await tool("split");
    await click([20, 30]);
    const nSplit = (await lines()).length;
    await tool("chamfer");
    await mp.evaluate(() => { window.__sv.model.editor().chamferDist = 3; });
    await click([50, 10]);
    const ch = await lines();
    check(ext.includes("60 10 60 40") && nSplit === ext.length + 1 && ch.includes("47 10 50 13"), `model 1.20: Extend reaches the next line, Split makes two, sketch chamfer cuts the corner 3 mm (${ext[4]}, ${nSplit}, ${ch.at(-1)})`);
    // Slot: two centres 20 apart, half-width 4.
    await tool("slot");
    await click([80, 0]); await click([100, 0]); await click([90, 4]);
    const slot = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk; const arcs = sk.ents.filter(e => e.t === "arc"); const P = id => sk.ents.find(e => e.id === id); return { arcs: arcs.length, r: arcs.map(a => Math.hypot(P(a.a).x - P(a.c).x, P(a.a).y - P(a.c).y)), tan: sk.rels.filter(r => r.t === "tangent").length, ok: window.__sv.model.editor().info.status }; });
    check(slot.arcs === 2 && slot.r.every(r => near(r, 4, 0.01)) && slot.tan === 4 && slot.ok === "ok", `model 1.20: Slot makes two lines and two R4 end arcs, tangent (${JSON.stringify(slot)})`);
    // 1.240.0 (FR-SK-034): offset both sides with arc caps round the open top line, linked to its source by one dimension.
    await tool("offset");
    await mp.evaluate(() => window.__sv.modeller.renderPanel());
    await mp.waitForSelector('#mc-pm [data-a="oboth"]');
    await mp.click('#mc-pm [data-a="oboth"]');
    await mp.waitForSelector('#mc-pm [data-a="ocap"]');
    const capOpts = await mp.evaluate(() => [...document.querySelectorAll('#mc-pm [data-a="ocap"] option')].map(o => o.value).join("|"));
    await mp.evaluate(() => { window.__sv.model.editor().offsetDist = 3; });
    await click([62, 41]);
    const ob = await mp.evaluate(() => {
      const sk = window.__sv.model.editor().sk, P = id => sk.ents.find(e => e.id === id);
      const offs = sk.rels.filter(r => r.t === "offset"), lead = offs.find(r => !r.of && r.e[0] === "hz");
      const dm = lead && sk.dims.find(d => d.e[0] === "hz" && d.e[1] === lead.e[1]);
      const caps = sk.ents.filter(e => e.t === "arc" && e.c && (e.c === "g" || e.c === "h"));
      return { offs: offs.filter(r => r.e[0] === "hz").length, linked: offs.filter(r => r.e[0] === "hz" && r.of === lead?.id).length, dim: dm?.val.v, dimId: dm?.id, caps: caps.length, r: caps.map(a => Math.round(Math.hypot(P(a.a).x - P(a.c).x, P(a.a).y - P(a.c).y) * 1000) / 1000) };
    });
    // Change the offset dimension to 5: both copies and the caps follow.
    await mp.evaluate(id => { const ed = window.__sv.model.editor(); ed.sk.dims.find(d => d.id === id).val.v = 5; ed.commit("Offset 5"); }, ob.dimId);
    await mp.waitForTimeout(200);
    const ob5 = await mp.evaluate(() => {
      const sk = window.__sv.model.editor().sk, P = id => sk.ents.find(e => e.id === id);
      const ys = sk.rels.filter(r => r.t === "offset" && r.e[0] === "hz").map(r => { const l = sk.ents.find(e => e.id === r.e[1]); return Math.round(P(l.a).y * 1000) / 1000; }).sort((a, b) => a - b);
      return { ys, status: window.__sv.model.editor().info.status };
    });
    check(capOpts === "none|arc|line" && ob.offs === 2 && ob.linked === 1 && ob.dim === 3 && ob.caps === 2 && ob.r.every(r => near(r, 3, 0.01)) && ob5.ys.join(",") === "35,45" && ob5.status === "ok",
      `model 1.240: Offset both sides caps the open line with arcs and one dimension drives both copies (${capOpts}, ${JSON.stringify(ob)}, ${JSON.stringify(ob5)})`);
    // 1.251.0 (FR-SK-052/053): a line drawn on from a slanted one snaps perpendicular (glyph at the cursor, relation
    // added), Ctrl suppresses it, a hovered line gives parallel; hovering a relation glyph lights up its entities.
    await tool("line");
    const lineIds = () => mp.evaluate(() => window.__sv.model.editor().sk.ents.filter(e => e.t === "line").map(e => e.id));
    const before = await lineIds();
    await click([72, 12]); await click([82, 17]);
    const [mx, my] = await toPage([77.15, 27]);
    await mp.mouse.move(mx, my); await mp.waitForTimeout(60);
    const glyph = await mp.evaluate(() => document.querySelector(".sk-infer")?.dataset.rel ?? null);
    await click([77.15, 27]);
    await mp.keyboard.down("Control");
    await click([87.15, 32.2]);
    await mp.keyboard.up("Control");
    await mp.keyboard.press("Escape");
    await click([95, 28]);
    const [hx, hy] = await toPage([77, 14.5]);
    await mp.mouse.move(hx, hy); await mp.waitForTimeout(60);
    await click([84.9, 23]);
    await mp.keyboard.press("Escape");
    const inf = await mp.evaluate(old => {
      const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id);
      const made = sk.ents.filter(e => e.t === "line" && !old.includes(e.id));
      const dir = l => { const a = P(l.a), b = P(l.b); return [b.x - a.x, b.y - a.y]; };
      const rel = (t, a, b) => sk.rels.find(r => r.t === t && r.e[0] === a && r.e[1] === b);
      if (made.length !== 4) return { n: made.length };
      const [l1, l2, l3, l4] = made;
      const d1 = dir(l1), d2 = dir(l2), d4 = dir(l4);
      const perp = rel("perpendicular", l1.id, l2.id);
      const end3 = P(l3.b);
      return {
        n: made.length, perp: !!perp, dot: Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / Math.hypot(...d1) / Math.hypot(...d2),
        ctrlFree: !sk.rels.some(r => r.e.includes(l3.id)) && Math.abs(end3.x - 87.15) < 0.05 && Math.abs(end3.y - 32.2) < 0.05,
        par: !!rel("parallel", l1.id, l4.id), cross: Math.abs(d1[0] * d4[1] - d1[1] * d4[0]) / Math.hypot(...d1) / Math.hypot(...d4),
        perpId: perp?.id, l1: l1.id, status: ed.info.status,
      };
    }, before);
    const hot = await mp.evaluate(({ id, l1 }) => {
      const ed = window.__sv.model.editor(), el = document.querySelector(`.sk-rel[data-id="${id}"]`);
      if (!el) return { glyph: false };
      el.dispatchEvent(new PointerEvent("pointerenter"));
      const lit = ed.relHot.has(l1);
      el.dispatchEvent(new PointerEvent("pointerleave"));
      ed.showRels = false; ed.render();
      const hidden = !document.querySelector(`.sk-rel[data-id="${id}"]`);
      ed.showRels = true; ed.render();
      return { glyph: true, lit, cleared: ed.relHot.size === 0, hidden };
    }, { id: inf.perpId, l1: inf.l1 });
    check(glyph === "perpendicular" && inf.n === 4 && inf.perp && inf.dot < 1e-6 && inf.ctrlFree && inf.par && inf.cross < 1e-6 && inf.status === "ok" && hot.lit && hot.cleared && hot.hidden,
      `model 1.251: automatic perpendicular/parallel relations while drawing, Ctrl suppresses them, relation glyphs light up their entities (${glyph}, ${JSON.stringify(inf)}, ${JSON.stringify(hot)})`);
    // 1.266.0 (FR-SK-043/044/047): dragging the last line's start onto the free end of the Ctrl line merges them
    // (coincident relation); Ctrl+drag of that line copies it; the status bar shows the cursor position.
    await tool("select");
    const ends = await mp.evaluate(old => {
      const sk = window.__sv.model.editor().sk, P = id => sk.ents.find(e => e.id === id);
      const made = sk.ents.filter(e => e.t === "line" && !old.includes(e.id));
      return { a: made[3].a, b: made[2].b, pa: [P(made[3].a).x, P(made[3].a).y], pb: [P(made[2].b).x, P(made[2].b).y], l4: made[3].id };
    }, before);
    const drag = async (from, to, ctrl) => {
      const [fx, fy] = await toPage(from), [tx, ty] = await toPage(to);
      if (ctrl) await mp.keyboard.down("Control");
      await mp.mouse.move(fx, fy); await mp.waitForTimeout(40); await mp.mouse.down();
      for (let i = 1; i <= 6; i++) { await mp.mouse.move(fx + ((tx - fx) * i) / 6, fy + ((ty - fy) * i) / 6); await mp.waitForTimeout(30); }
      await mp.mouse.up(); await mp.waitForTimeout(120);
      if (ctrl) await mp.keyboard.up("Control");
    };
    await drag(ends.pa, ends.pb, false);
    const statusText = await mp.evaluate(() => document.querySelector("#mc-status")?.textContent ?? "");
    const merged = await mp.evaluate(({ a, b }) => {
      const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id);
      return { rel: sk.rels.some(r => r.t === "coincident" && r.e[0] === a && r.e[1] === b), gap: Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y), status: ed.info.status };
    }, ends);
    const mid = await mp.evaluate(id => { const sk = window.__sv.model.editor().sk, P = x => sk.ents.find(e => e.id === x), l = P(id); return [(P(l.a).x + P(l.b).x) / 2, (P(l.a).y + P(l.b).y) / 2]; }, ends.l4);
    const nBefore = (await lineIds()).length;
    await click(mid);
    await drag(mid, [mid[0] + 8, mid[1]], true);
    const copied = await mp.evaluate(({ id, n }) => {
      const ed = window.__sv.model.editor(), sk = ed.sk, P = x => sk.ents.find(e => e.id === x);
      const lines = sk.ents.filter(e => e.t === "line");
      const src = P(id), cp = lines.at(-1);
      const dx = [P(cp.a).x - P(src.a).x, P(cp.b).x - P(src.b).x], dy = [P(cp.a).y - P(src.a).y, P(cp.b).y - P(src.b).y];
      return { n: lines.length - n, dx, dy, sel: [...ed.selection].includes(cp.id), rels: sk.rels.filter(r => r.e.includes(cp.id)).length };
    }, { id: ends.l4, n: nBefore });
    check(merged.rel && merged.gap < 1e-6 && merged.status === "ok" && /x -?[\d.]+, y -?[\d.]+/.test(statusText) && copied.n === 1 && copied.dx.every(v => near(v, 8, 0.05)) && copied.dy.every(v => near(v, 0, 0.05)) && copied.sel && copied.rels === 0,
      `model 1.266: drag a point onto a point merges them, Ctrl+drag copies the selection, status shows x/y (${JSON.stringify(merged)}, ${statusText}, ${JSON.stringify(copied)})`);
    // Sketch right-click (FR-SK-045): with the line tool it ends the chain; with Select it opens the menu for the item under it.
    const rclick = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down({ button: "right" }); await mp.mouse.up({ button: "right" }); await mp.waitForTimeout(150); };
    const linesBefore = (await lineIds()).length;
    await tool("line");
    await click([30, 38]);
    await click([46, 38]);
    await rclick([60, 30]);
    const ended = await mp.evaluate(() => { const ed = window.__sv.model.editor(); return { tool: ed.tool, pts: ed.draft.pts.length, menu: !document.querySelector("#mc-menu").hidden }; });
    const added = (await lineIds()).filter(id => !before.includes(id)).at(-1);
    await tool("select");
    await rclick([38, 38]);
    const menuItems = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent));
    await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].find(b => b.textContent === "Construction geometry")?.click());
    const ctxAfter = await mp.evaluate(id => { const ed = window.__sv.model.editor(); return { sel: [...ed.selection], cons: !!ed.sk.ents.find(e => e.id === id)?.cons }; }, added);
    check(ended.tool === "line" && ended.pts === 0 && !ended.menu && (await lineIds()).length === linesBefore + 1
      && ["Select chain", "Construction geometry", "Horizontal", "Delete", "Exit sketch", "Discard"].every(l => menuItems.some(m => m.endsWith(l))) && ctxAfter.sel.includes(added) && ctxAfter.cons,
      `model 1.275: right-click ends a line chain, and the sketch menu sets construction on the line under the cursor (${JSON.stringify(ended)}, ${JSON.stringify(menuItems)}, ${JSON.stringify(ctxAfter)})`);
    // Instant 2D (FR-SK-067/068): a right-click while placing locks the dimension horizontal; dragging the selected
    // dimension's handle by 10 mm changes 30 to 40, and one Ctrl+Z puts it back.
    await tool("line");
    await click([20, -25]);
    await click([50, -10]);
    await rclick([70, 0]);
    const slant = (await lineIds()).at(-1);
    await tool("dim");
    await click([35, -17.5]);
    const hover = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(60); };
    await hover([35, -2]);
    const tFree = await mp.evaluate(() => window.__sv.model.editor().dimDraft.dim?.t);
    await rclick([35, -2]);
    await hover([65, -17]);
    const tLocked = await mp.evaluate(() => ({ t: window.__sv.model.editor().dimDraft.dim?.t, lock: !!window.__sv.model.editor().dimDraft.lock, cls: !!document.querySelector(".sk-dim.draft.locked") }));
    await click([65, -17]);
    await mp.waitForTimeout(150);
    await mp.keyboard.press("Escape");
    await mp.waitForTimeout(100);
    const dimNow = () => mp.evaluate(id => { const sk = window.__sv.model.editor().sk; const d = sk.dims.filter(x => x.e.includes(id)).at(-1); return d && { id: d.id, t: d.t, v: d.val.v }; }, slant);
    const placed = await dimNow();
    await tool("select");
    await mp.evaluate(id => document.querySelector(`.sk-dim[data-id="${id}"]`).click(), placed.id);
    await mp.waitForTimeout(80);
    const gripPos = await mp.evaluate(() => { const g = document.querySelector(".sk-grip"); return g ? JSON.parse(g.dataset.pos) : null; });
    if (gripPos) {
      const [fx, fy] = await toPage(gripPos), [tx, ty] = await toPage([gripPos[0] + 10, gripPos[1]]);
      await mp.mouse.move(fx, fy); await mp.waitForTimeout(40); await mp.mouse.down();
      for (let i = 1; i <= 8; i++) { await mp.mouse.move(fx + ((tx - fx) * i) / 8, fy + ((ty - fy) * i) / 8); await mp.waitForTimeout(30); }
      await mp.mouse.up(); await mp.waitForTimeout(120);
    }
    const dragged = await dimNow();
    await mp.keyboard.press("Control+z");
    await mp.waitForTimeout(150);
    const undoneDim = await dimNow();
    check(tFree === "hdistance" && tLocked.t === "hdistance" && tLocked.lock && tLocked.cls && placed?.t === "hdistance" && near(placed.v, 30, 0.01) && gripPos && near(gripPos[0], 50, 0.01)
      && near(dragged?.v, 40, 1e-6) && near(undoneDim?.v, placed?.v, 1e-9),
      `model 1.278: right-click locks a dimension while placing, and dragging its handle changes the value with one undo step (${tFree}, ${JSON.stringify(tLocked)}, ${JSON.stringify(placed)}, ${JSON.stringify(gripPos)}, ${JSON.stringify(dragged)}, ${JSON.stringify(undoneDim)})`);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    // Convert entities: the top face of a block into a sketch on it, four fixed lines.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a2", 0, -60), P("b2", 40, -60), P("c2", 40, -30), P("d2", 0, -30), { id: "m1", t: "line", a: "a2", b: "b2" }, { id: "m2", t: "line", a: "b2", b: "c2" }, { id: "m3", t: "line", a: "c2", b: "d2" }, { id: "m4", t: "line", a: "d2", b: "a2" }] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 } }, { id: "s3", type: "sketch", name: "Sketch3", plane: { face: { name: "x:end", hint: [20, -45, 10] } }, rels: [], dims: [], ents: [] }); }); });
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s3"));
    await mp.waitForTimeout(1200);
    await idle();
    await tool("convert");
    await click([20, -45]);
    const conv = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk; return { lines: sk.ents.filter(e => e.t === "line").length, fix: sk.rels.filter(r => r.t === "fix").length, dof: window.__sv.model.editor().info.dof }; });
    check(conv.lines === 4 && conv.fix === 4 && conv.dof === 0, `model 1.20: Convert entities copies the face's 4 edges into the sketch, fixed (${JSON.stringify(conv)})`);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await ctx.close();
  }

  // --- Part modelling 1.21.0: reference axes and points, S shortcut bar, sketch box selection ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const world = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -50, -30), P("b", 50, -30), P("c", 50, 30), P("d", -50, 30), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a")] }, { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } }); }); });
    await idle();
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    // Reference geometry flyout → Axis, where Top and Right meet.
    await mp.click('#mc-tools [data-fly="plane"]');
    const refMenu = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent));
    await mp.click("#mc-menu button:nth-child(2)");
    await mp.selectOption('#mc-pm select[data-k="mode"]', "planes");
    await mp.click('#mc-tree .ft-row[data-id="std:XY"]');
    await mp.click('#mc-tree .ft-row[data-id="std:YZ"]');
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const ax = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.at(-1); const fr = window.__sv.model.last().frames[f.id]; return { type: f.type, name: f.name, n: fr?.n.map(v => Math.round(Math.abs(v) * 1e6) / 1e6), row: !!document.querySelector(`#mc-tree .ft-row[data-id="${f.id}"]`) }; });
    check(refMenu.join("|") === "Plane|Axis|Point|Coordinate system|External References" && ax.type === "axis" && ax.n?.join(",") === "0,1,0" && ax.row, `model 1.21: Axis from two planes, from the Plane ▾ flyout (${refMenu.join("|")}, ${JSON.stringify(ax)})`);
    // Point at the centre of the top face, picked in the view.
    await mp.click('#mc-tools [data-fly="plane"]');
    await mp.click("#mc-menu button:nth-child(3)");
    await mp.selectOption('#mc-pm select[data-k="mode"]', "face");
    const top = await world([-20, -10, 20]);
    await mp.mouse.click(top[0], top[1]);
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const pt = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.at(-1); return { type: f.type, o: window.__sv.model.last().frames[f.id]?.o.map(v => Math.round(v * 1e6) / 1e6) }; });
    check(pt.type === "point" && pt.o?.join(",") === "0,0,20", `model 1.21: Point at the centre of a picked face (${JSON.stringify(pt)})`);
    // 1.46: coordinate system (FR-REF-005): origin the point (tree), Z the top face (view), X the axis (tree); then the measurement frame.
    await mp.click('#mc-tools [data-fly="plane"]');
    await mp.click("#mc-menu button:nth-child(4)");
    const ids = await mp.evaluate(() => { const fs = window.__sv.model.store.doc.features; return { pt: fs.find(f => f.type === "point").id, ax: fs.find(f => f.type === "axis").id }; });
    await mp.click(`#mc-tree .ft-row[data-id="${ids.pt}"]`);
    await idle();
    const topZ = await world([20, 10, 20]);
    await mp.mouse.click(topZ[0], topZ[1]);
    await idle();
    await mp.click(`#mc-tree .ft-row[data-id="${ids.ax}"]`);
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const cs = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.at(-1); const fr = window.__sv.model.last().frames[f.id]; const R = v => v?.map(x => Math.round(x * 1e6) / 1e6 + 0).join(","); return { id: f.id, type: f.type, name: f.name, o: R(fr?.o), n: R(fr?.n), x: R(fr?.x?.map(Math.abs)), origin: !!f.origin?.point, z: !!f.z?.face, xr: !!f.x?.axis }; });
    check(cs.type === "csys" && cs.name === "Coordinate system1" && cs.o === "0,0,20" && cs.n === "0,0,1" && cs.x === "0,1,0" && cs.origin && cs.z && cs.xr, `model 1.46: Coordinate system from a point, a face and an axis (${JSON.stringify(cs)})`);
    await mp.evaluate(id => window.__sv.modeller.useCsys(id), cs.id);
    await mp.waitForTimeout(100);
    const csOn = await mp.evaluate(() => ({ shown: !document.querySelector("#csys-reset").hidden, txt: document.querySelector("#csys-reset").textContent }));
    // It follows a rebuild: the point moves with the top face when the block gets taller.
    await mp.evaluate(() => window.__sv.model.store.change("Taller", d => { d.features.find(f => f.id === "f1").depth = { v: 30 }; }));
    await idle();
    const csZ = await mp.evaluate(() => window.__sv.csys.active?.src ? window.__sv.csys.active.origin[2] : null);
    await mp.evaluate(() => window.__sv.model.store.change("Back", d => { d.features.find(f => f.id === "f1").depth = { v: 20 }; }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.useCsys(null));
    const csOff = await mp.evaluate(() => document.querySelector("#csys-reset").hidden);
    check(csOn.shown && /Coordinate system1/.test(csOn.txt) && Math.abs(csZ - 30) < 1e-6 && csOff, `model 1.46: Use for measurements makes it the active CSYS and it follows rebuilds (${JSON.stringify(csOn)}, z ${csZ}, off ${csOff})`);
    // 1.49: intersection curve (FR-SK-036): a sketch on Front (y = 0) cut against the top face and the +X side.
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "sx", type: "sketch", name: "SketchX", plane: { std: "XZ" }, rels: [], dims: [], ents: [] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("sx"));
    await idle();
    // Opening the sketch turns the view normal to it (animated): wait, then look from the side so the cut faces show.
    await mp.waitForTimeout(900);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    await mp.waitForTimeout(200);
    const cutTop = await world([10, 0, 20]), cutSide = await world([50, -5, 10]);
    const icut = await mp.evaluate(([a, b]) => {
      const ed = window.__sv.model.editor();
      ed.setTool("intersect");
      ed.intersectAt({ clientX: a[0], clientY: a[1] });
      ed.intersectAt({ clientX: b[0], clientY: b[1] });
      const P = id => ed.sk.ents.find(e => e.id === id);
      const lens = ed.sk.ents.filter(e => e.t === "line").map(l => Math.round(Math.hypot(P(l.a).x - P(l.b).x, P(l.a).y - P(l.b).y) * 1000) / 1000).sort((x, y) => x - y);
      return { lens, fixed: ed.sk.rels.filter(r => r.t === "fix").length, status: ed.info.status };
    }, [cutTop, cutSide]);
    await mp.click('#mc-pm [data-a="ok"]');
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Drop", d => { d.features = d.features.filter(f => f.id !== "sx"); }));
    await idle();
    await mp.waitForTimeout(900);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    check(icut.lens.join(",") === "20,100" && icut.fixed === 2 && icut.status === "ok", `model 1.49: Intersection curve adds the fixed lines where Front cuts the top and a side face (${JSON.stringify(icut)})`);
    // S: the shortcut bar at the cursor; Esc closes it.
    const mid = await world([0, 0, 10]);
    await mp.mouse.move(mid[0], mid[1]);
    await mp.keyboard.press("s");
    const sbar = await mp.evaluate(() => { const b = document.querySelector("#mc-sbar"); return b ? { n: b.querySelectorAll("button").length, labels: [...b.querySelectorAll("button")].map(x => x.getAttribute("aria-label")).join("|") } : null; });
    await mp.keyboard.press("Escape");
    const sbarGone = await mp.evaluate(() => !document.querySelector("#mc-sbar"));
    check(sbar?.n === 7 && /^Sketch\|Extrude/.test(sbar.labels) && sbarGone, `model 1.21: S shows the shortcut bar with the part commands, Esc hides it (${JSON.stringify(sbar)})`);
    // 1.22: the context toolbar after a click on a face or an edge.
    const cbar = () => mp.evaluate(() => { const b = document.querySelector("#mc-cbar"); return b ? [...b.querySelectorAll("button")].map(x => x.getAttribute("aria-label")).join("|") : null; });
    const topF = await world([20, 10, 20]);
    await mp.mouse.click(topF[0], topF[1]);
    await mp.waitForTimeout(150);
    const faceBar = await cbar();
    await mp.click('#mc-cbar button[data-c="normal"]');
    await mp.waitForTimeout(700);
    const camDir = await mp.evaluate(() => { const v = window.__sv.viewer; const d = v.camera.position.clone().sub(v.controls.target).normalize(); return [d.x, d.y, d.z].map(x => Math.round(x * 100) / 100); });
    const cbarGone = await mp.evaluate(() => !document.querySelector("#mc-cbar"));
    check(faceBar === "Sketch|Normal to|Edit sketch|Edit feature" && camDir.join() === "0,0,1" && cbarGone, `model 1.22: a flat face shows the context toolbar; Normal to turns the view (${faceBar}, ${camDir})`);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    const edgeP = await world([0, -30, 20]);
    await mp.mouse.click(edgeP[0], edgeP[1]);
    await mp.waitForTimeout(150);
    const edgeBar = await cbar();
    await mp.click('#mc-cbar button[data-c="fillet"]');
    await idle();
    const filletMode = await mp.evaluate(() => { const m = window.__sv.model.mode(); return m.kind === "feature" ? `${m.draft.type}:${m.draft.edges?.length ?? 0}` : m.kind; });
    await mp.click("#mc-cancel");
    await idle();
    check(/^Fillet\|Chamfer\|Edit sketch\|Edit feature/.test(edgeBar ?? "") && filletMode === "fillet:1", `model 1.22: an edge shows Fillet/Chamfer in the context toolbar, and Fillet starts with that edge (${edgeBar}, ${filletMode})`);
    // 1.22: selection filter (F5): edges only, so a click inside a face picks nothing and an edge still shows its bar.
    await mp.mouse.move(topF[0], topF[1]);
    await mp.keyboard.press("F5");
    const filterBar = await mp.evaluate(() => !!document.querySelector("#mc-filter"));
    await mp.click('#mc-filter [data-f="faces"]');
    await mp.click('#mc-filter [data-f="vertices"]');
    const fState = await mp.evaluate(() => [...document.querySelectorAll("#mc-filter [data-f]")].filter(b => b.classList.contains("on")).map(b => b.dataset.f).join());
    await mp.mouse.click(topF[0], topF[1]);
    await mp.waitForTimeout(150);
    const faceFiltered = await cbar();
    await mp.keyboard.press("Escape");
    await mp.mouse.click(edgeP[0], edgeP[1]);
    await mp.waitForTimeout(150);
    const edgeStill = await cbar();
    await mp.keyboard.press("Escape");
    await mp.click('#mc-filter [data-f="clear"]');
    await mp.keyboard.press("F5");
    const filterOff = await mp.evaluate(() => !document.querySelector("#mc-filter") && [...document.querySelectorAll("#mc-quick [data-c=filter]")].every(b => !b.classList.contains("on")));
    check(filterBar && fState === "edges" && faceFiltered === null && /^Fillet/.test(edgeStill ?? "") && filterOff, `model 1.22: the selection filter limits picks to edges (${fState}, face → ${faceFiltered}, edge → ${edgeStill}, ${filterOff})`);
    // 1.22: Select other: Alt+click on the top face picks the back face behind it (the ray leaves through y = 30), and the context bar follows.
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    const topO = await world([20, 10, 20]);
    await mp.keyboard.down("Alt");
    await mp.mouse.click(topO[0], topO[1]);
    await mp.keyboard.up("Alt");
    await mp.waitForTimeout(150);
    const other = await mp.evaluate(() => { const s = window.__sv.state?.selection; return s?.face ? s.face.normal.map(v => Math.round(v)).join() : null; });
    const otherBar = await cbar();
    await mp.keyboard.press("Escape");
    check(other === "0,1,0" && /^Sketch\|Normal to/.test(otherBar ?? ""), `model 1.22: Alt+click selects the face behind (normal ${other}, bar ${otherBar})`);
    // Box selection in a sketch: left to right takes only what is fully inside.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s9", type: "sketch", name: "Sketch9", plane: { std: "XY" }, rels: [], dims: [], ents: [P("q1", -20, -10), P("q2", 0, -10), L("m1", "q1", "q2"), P("q3", -20, 10), P("q4", 40, 10), L("m2", "q3", "q4")] }); }); });
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s9"));
    await mp.waitForTimeout(1200);
    await idle();
    const sk = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const drag = async (a, b) => { const p0 = await sk(a), p1 = await sk(b); await mp.mouse.move(p0[0], p0[1]); await mp.mouse.down(); for (let i = 1; i <= 5; i++) { await mp.mouse.move(p0[0] + ((p1[0] - p0[0]) * i) / 5, p0[1] + ((p1[1] - p0[1]) * i) / 5); await mp.waitForTimeout(20); } await mp.mouse.up(); await mp.waitForTimeout(80); };
    await drag([-25, -15], [10, 15]);
    const win = await mp.evaluate(() => [...window.__sv.model.editor().selection].filter(id => id.startsWith("m")).sort());
    await mp.keyboard.press("Escape");
    await drag([10, 15], [-25, -15]);
    const cross = await mp.evaluate(() => [...window.__sv.model.editor().selection].filter(id => id.startsWith("m")).sort());
    check(win.join() === "m1" && cross.join() === "m1,m2", `model 1.21: sketch box selection, window then crossing (${win.join()} / ${cross.join()})`);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    // 1.23 (P2): linear pattern of a hole, mirror of the pattern, shell.
    await mp.evaluate(() => window.__sv.model.store.change("Hole", d => { d.features.push({ id: "s20", type: "sketch", name: "Sketch20", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [{ id: "h0", t: "point", x: -40, y: -15 }, { id: "hk", t: "circle", c: "h0", r: 4 }] }, { id: "c20", type: "extrude", name: "Cut20", sketch: "s20", op: "cut", end: "through", depth: { v: 0 } }); }));
    await idle();
    const vol = () => mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    const lastSt = () => mp.evaluate(() => { const r = window.__sv.model.last(), f = window.__sv.model.store.doc.features.at(-1); const s = r.statuses.find(x => x.id === f.id); return `${f.type}:${s?.code ?? (s?.ok ? "ok" : "err")}`; });
    const hole = 16 * Math.PI * 20;
    await mp.click('#mc-tree .ft-row[data-id="c20"]');
    await mp.click('#mc-tools [data-fly="pattern"]');
    const patMenu = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(1)");
    const eX = await world([0, -30, 20]);
    await mp.mouse.click(eX[0], eX[1]);
    await idle();
    await mp.fill('#mc-pm input[data-num="spacing"]', "20");
    await mp.press('#mc-pm input[data-num="spacing"]', "Tab");
    await idle();
    await mp.fill('#mc-pm input[data-int="count"]', "4");
    await mp.press('#mc-pm input[data-int="count"]', "Tab");
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vLp = await vol(), stLp = await lastSt();
    check(patMenu === "Linear pattern|Circular pattern|Mirror|Sketch driven pattern|Table driven pattern" && Math.abs(vLp - (120000 - 4 * hole)) < 1 && stLp === "lpattern:ok", `model 1.23: linear pattern of a hole along a picked edge, 4 × 20 mm (${patMenu}, ${Math.round(vLp)}, ${stLp})`);
    // Mirror the pattern about Right (YZ): three mirrored holes land on existing ones and are skipped with a warning.
    await mp.click('#mc-tools [data-fly="pattern"]');
    await mp.click("#mc-menu button:nth-child(3)");
    await mp.click('#mc-tree .ft-row[data-id="std:YZ"]');
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vMi = await vol(), stMi = await lastSt();
    check(Math.abs(vMi - (120000 - 5 * hole)) < 1 && stMi === "mirror:warning", `model 1.23: mirror of the pattern about Right; copies on existing holes are skipped (${Math.round(vMi)}, ${stMi})`);
    // Shell 2 mm, open at the top.
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-c="shell"]');
    const topS = await world([30, 15, 20]);
    await mp.mouse.click(topS[0], topS[1]);
    await idle();
    const shellFaces = await mp.evaluate(() => document.querySelector('#mc-pm [data-focus="faces"]')?.textContent);
    await mp.click("#mc-ok");
    await idle();
    const vSh = await vol(), stSh = await lastSt();
    check(shellFaces === "1 face" && stSh === "shell:ok" && vSh > 15000 && vSh < 30000, `model 1.23: shell 2 mm with the top face open (${shellFaces}, ${Math.round(vSh)}, ${stSh})`);
    // 1.24: hole wizard: two tapped M6 holes placed by clicking the top face (the shell suppressed first).
    await mp.evaluate(() => window.__sv.model.store.change("Suppress", d => { d.features.at(-1).suppressed = true; }));
    await idle();
    const vNoShell = await vol();
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-c="hole"]');
    const hA = await world([30, 15, 20]), hB = await world([-30, 15, 20]);
    await mp.mouse.click(hA[0], hA[1]);
    await idle();
    await mp.waitForFunction(() => document.querySelector('#mc-pm [data-focus="pts"]')?.textContent === "1 hole", null, { timeout: 15000 }).catch(() => {});
    await idle();
    await mp.mouse.click(hB[0], hB[1]);
    await idle();
    await mp.selectOption('#mc-pm select[data-k="kind"]', "tapped");
    await idle();
    const holePanel = await mp.evaluate(() => ({ n: document.querySelector('#mc-pm [data-focus="pts"]')?.textContent, d: document.querySelector('#mc-pm input[data-num="diameter"]')?.value, td: document.querySelector('#mc-pm input[data-num="threadDepth"]')?.value }));
    await mp.click("#mc-ok");
    await idle();
    const vHole = await vol(), stHole = await lastSt();
    const pts = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).pts);
    check(holePanel.n === "2 holes" && holePanel.d === "5" && stHole === "hole:ok" && Math.abs(vNoShell - vHole - 2 * Math.PI * 6.25 * 20) < 1 && pts.every(p => Math.abs(Math.abs(p[0]) - 30) < 1.5 && Math.abs(p[1] - 15) < 1.5), `model 1.24: two tapped M6 holes clicked on the top face (${JSON.stringify(holePanel)}, ${(vNoShell - vHole).toFixed(1)}, ${stHole}, ${JSON.stringify(pts)})`);
    // 1.25: equations: a global variable drives Extrude1's depth; changing it in the panel rebuilds the part.
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tree .ft-row[data-id="equations"]');
    await mp.click('#mc-pm [data-a="add"]');
    await mp.fill('#mc-pm .eq-row [data-e="name"]', "Height");
    await mp.press('#mc-pm .eq-row [data-e="name"]', "Enter");
    await mp.fill('#mc-pm .eq-row [data-e="expr"]', "20");
    await mp.press('#mc-pm .eq-row [data-e="expr"]', "Enter");
    await mp.click('#mc-pm [data-a="ok"]');
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude1 depth", d => { d.features.find(f => f.name === "Extrude1").depth = { v: 20, expr: "Height" }; }));
    await idle();
    const vH20 = await vol();
    await mp.click('#mc-tree .ft-row[data-id="equations"]');
    const eqShown = await mp.evaluate(() => ({ val: document.querySelector("#mc-pm .eq-val")?.textContent, used: document.querySelector("#mc-pm .eq-used li")?.textContent }));
    await mp.fill('#mc-pm .eq-row [data-e="expr"]', "Height0 + 1");
    await mp.press('#mc-pm .eq-row [data-e="expr"]', "Enter");
    const eqErr = await mp.evaluate(() => document.querySelector("#mc-pm .eq-val.err")?.textContent ?? "");
    await mp.fill('#mc-pm .eq-row [data-e="expr"]', "25");
    await mp.press('#mc-pm .eq-row [data-e="expr"]', "Enter");
    await mp.click('#mc-pm [data-a="ok"]');
    await idle();
    const vH25 = await vol();
    const dep25 = await mp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.name === "Extrude1").depth.v);
    const okAll = await mp.evaluate(() => window.__sv.model.last().statuses.every(s => s.ok));
    check(eqShown.val === "20 mm" && /Extrude1/.test(eqShown.used ?? "") && /Unknown name/.test(eqErr) && Math.abs(dep25 - 25) < 1e-9 && vH25 > vH20 + 1000 && okAll, `model 1.25: global variable Height drives Extrude1's depth, 20 → 25 mm (${JSON.stringify(eqShown)}, ${eqErr}, ${dep25}, ${Math.round(vH20)} → ${Math.round(vH25)}, ${okAll})`);
    // 1.26: draft 5° on the front face about Top (XY): a wedge 100 · ½ · 25 · 25·tan 5° comes off.
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-c="draft"]');
    await mp.click('#mc-tree .ft-row[data-id="std:XY"]');
    await idle();
    const front = await world([0, -30, 12]);
    await mp.mouse.click(front[0], front[1]);
    await idle();
    await mp.fill('#mc-pm input[data-num="angle"]', "5");
    await mp.press('#mc-pm input[data-num="angle"]', "Tab");
    await idle();
    const draftPanel = await mp.evaluate(() => ({ plane: document.querySelector('#mc-pm [data-focus="nplane"]')?.textContent, faces: document.querySelector('#mc-pm [data-focus="faces"]')?.textContent }));
    await mp.click("#mc-ok");
    await idle();
    const vDr = await vol(), stDr = await lastSt();
    const wedge = 100 * 0.5 * 25 * 25 * Math.tan(5 * Math.PI / 180);
    check(draftPanel.faces === "1 face" && stDr === "draft:ok" && Math.abs(vH25 - vDr - wedge) < 30, `model 1.26: draft 5° on the front face about Top (${JSON.stringify(draftPanel)}, ${stDr}, ${(vH25 - vDr).toFixed(1)} ≈ ${wedge.toFixed(1)})`);
    // 1.26: reorder: Alt+↑ moves Draft1 above Hole1 (independent); dragging it above Extrude1 (its parent) is refused.
    const fid = n => mp.evaluate(n => window.__sv.model.store.doc.features.find(f => f.name === n).id, n);
    const order = () => mp.evaluate(() => window.__sv.model.store.doc.features.map(f => f.name).join(","));
    const drId = await fid("Draft1"), exId = await fid("Extrude1");
    await mp.click(`#mc-tree .ft-row[data-id="${drId}"]`);
    const relMarks = await mp.evaluate(() => [...document.querySelectorAll("#mc-tree .ft-row.ft-parent .ft-name")].map(e => e.textContent).join(","));
    await mp.focus(`#mc-tree .ft-row[data-id="${drId}"]`);
    await mp.keyboard.press("Alt+ArrowUp");
    await idle();
    const ord1 = await order(), vMv = await vol();
    await mp.dragAndDrop(`#mc-tree .ft-row[data-id="${drId}"]`, `#mc-tree .ft-row[data-id="${exId}"]`, { targetPosition: { x: 20, y: 2 } });
    await idle();
    const ord2 = await order();
    const refused = await mp.evaluate(() => [...document.querySelectorAll(".toast")].map(e => e.textContent).join(" | "));
    check(/Draft1,Hole1$/.test(ord1) && Math.abs(vMv - vDr) < 1 && ord2 === ord1 && /Draft1 can't come before Extrude1/.test(refused) && /Extrude1/.test(relMarks), `model 1.26: reorder with Alt+↑ works; a drag above the parent is refused (${ord1}, ${Math.round(vMv)}, ${refused}, marks ${relMarks})`);
    // 1.26: configurations: a second one with Height 15; switching back restores the 25 mm part.
    await mp.click('#mc-tree .ft-row[data-id="configs"]');
    await mp.click('#mc-pm [data-a="add"]');
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Height 15", d => { d.vars[0].expr = "15"; }));
    await idle();
    const vCfg2 = await vol();
    const cfgRows = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm .cfg-row input")].map(e => e.value).join(","));
    await mp.click('#mc-pm .cfg-row[data-i="0"] [data-c="act"]');
    await idle();
    const vCfg1 = await vol(), cfgLabel = await mp.evaluate(() => document.querySelector('#mc-tree .ft-row[data-id="configs"] .ft-name')?.textContent);
    await mp.click('#mc-pm .cfg-row[data-i="1"] [data-c="act"]');
    await idle();
    const vCfg2b = await vol();
    await mp.click('#mc-pm [data-a="ok"]');
    check(cfgRows === "Default,Config2" && Math.abs(vCfg1 - vMv) < 1 && vCfg2 < vCfg1 - 1000 && Math.abs(vCfg2b - vCfg2) < 1 && cfgLabel === "Configuration: Default", `model 1.26: configurations Default (25 mm) and Config2 (15 mm) switch the part (${cfgRows}, ${Math.round(vCfg1)} / ${Math.round(vCfg2)} / ${Math.round(vCfg2b)}, ${cfgLabel})`);
    // 1.27: DXF into a sketch on Top (a gasket: bulge corners and two holes), a mirrored third hole, extruded 10 mm down.
    const vBeforeDxf = await vol();
    await mp.click('[data-c="sketch"]');
    await mp.click('#mc-tree .ft-row[data-id="std:XY"]');
    await idle();
    const [dxfChooser] = await Promise.all([mp.waitForEvent("filechooser"), mp.click('#mc-tools [data-c="skdxf"]')]);
    await dxfChooser.setFiles(resolve("tests/fixtures/dxf/gasket.dxf"));
    await mp.waitForFunction(() => window.__sv.model.editor()?.sk.ents.filter(e => e.t === "circle").length === 2, null, { timeout: 10000 });
    const dxfEnts = await mp.evaluate(() => { const e = window.__sv.model.editor(); return ["line", "arc", "circle"].map(k => e.sk.ents.filter(x => x.t === k && !x.cons).length).join(","); });
    // A vertical construction line at x = −20 and the left hole selected: Mirror puts a hole at x = −10.
    await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      e.sk.ents.push({ id: "mpa", t: "point", x: -20, y: -15 }, { id: "mpb", t: "point", x: -20, y: 15 }, { id: "mln", t: "line", a: "mpa", b: "mpb", cons: true });
      const left = e.sk.ents.find(x => x.t === "circle" && e.sk.ents.find(p => p.id === x.c).x < 0);
      e.selection = new Set([left.id, "mln"]);
    });
    await mp.click('#mc-tools [data-c="skmirror"]');
    const mir = await mp.evaluate(() => { const e = window.__sv.model.editor(); const c = e.sk.ents.filter(x => x.t === "circle").map(x => { const p = e.sk.ents.find(q => q.id === x.c); return [Math.round(p.x * 1000) / 1000, x.r]; }); return { c: JSON.stringify(c), sym: e.sk.rels.filter(r => r.t === "symmetric").length }; });
    await mp.click("#mc-ok");
    await idle();
    await mp.click('#mc-tools [data-c="extrude"]');
    await idle();
    await mp.check('#mc-pm input[data-k="flip"]');
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vDxf = await vol(), stDxf = await lastSt();
    const gasket = 3900 - 23 * Math.PI;
    check(dxfEnts === "4,4,2" && mir.c.includes("[-10,4]") && mir.sym === 1 && stDxf === "extrude:ok" && Math.abs(vDxf - vBeforeDxf - gasket * 10) < 1, `model 1.27: DXF gasket into a sketch, a mirrored hole, extruded 10 mm (${dxfEnts}, ${mir.c}, ${mir.sym}, ${stDxf}, ${(vDxf - vBeforeDxf).toFixed(1)} ≈ ${(gasket * 10).toFixed(1)})`);
    // 1.28: the gasket extrude as a 2 mm thin wall, then solid again with a 5° draft (exact values in the unit tests).
    const gid = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    await mp.dblclick(`#mc-tree .ft-row[data-id="${gid}"] .ft-name`);
    await idle();
    await mp.check('#mc-pm input[data-k="thinOn"]');
    await idle();
    const thinUi = await mp.evaluate(() => ({ mode: document.querySelector('#mc-pm select[data-k="thinMode"]')?.value, t: document.querySelector('#mc-pm input[data-num="thin.t"]')?.value }));
    await mp.click("#mc-ok");
    await idle();
    const vThin = await vol(), stThin = await lastSt();
    await mp.dblclick(`#mc-tree .ft-row[data-id="${gid}"] .ft-name`);
    await idle();
    await mp.uncheck('#mc-pm input[data-k="thinOn"]');
    await idle();
    await mp.check('#mc-pm input[data-k="draftOn"]');
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vDraftEx = await vol(), stDraftEx = await lastSt();
    check(thinUi.mode === "inside" && thinUi.t === "2" && stThin === "extrude:ok" && vThin - vBeforeDxf > 1000 && vThin - vBeforeDxf < gasket * 10 - 1000 && stDraftEx === "extrude:ok" && vDraftEx - vBeforeDxf < gasket * 10 - 100 && vDraftEx - vBeforeDxf > gasket * 10 * 0.8, `model 1.28: thin wall and draft on an extrude (${JSON.stringify(thinUi)}, ${stThin}, ${(vThin - vBeforeDxf).toFixed(0)}, ${stDraftEx}, ${(vDraftEx - vBeforeDxf).toFixed(0)} of ${(gasket * 10).toFixed(0)})`);
    // 1.41: Start from offset on the gasket extrude, and the new end conditions in the panel (exact values in the unit tests).
    await mp.dblclick(`#mc-tree .ft-row[data-id="${gid}"] .ft-name`);
    await idle();
    await mp.uncheck('#mc-pm input[data-k="draftOn"]');
    await idle();
    await mp.selectOption('#mc-pm select[data-k="start"]', "offset");
    await idle();
    const startUi = await mp.evaluate(() => ({ off: document.querySelector('#mc-pm input[data-num="startOffset"]')?.value, ends: [...document.querySelectorAll('#mc-pm select[data-k="end"] option')].map(o => o.value).join(",") }));
    await mp.click("#mc-ok");
    await idle();
    const vStart = await vol(), stStart = await lastSt();
    const startF = await mp.evaluate(id => { const f = window.__sv.model.store.doc.features.find(x => x.id === id); return `${f.start}:${f.startOffset?.v}`; }, gid);
    await mp.dblclick(`#mc-tree .ft-row[data-id="${gid}"] .ft-name`);
    await idle();
    await mp.selectOption('#mc-pm select[data-k="end"]', "vertex");
    await idle();
    const vtxUi = await mp.evaluate(() => document.querySelector('#mc-pm .pm-box.focus[data-focus="upto"]')?.textContent);
    await mp.selectOption('#mc-pm select[data-k="end"]', "blind");
    await mp.selectOption('#mc-pm select[data-k="start"]', "sketch");
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vBack = await vol();
    check(startUi.off === "10" && startUi.ends.includes("next,vertex") && stStart === "extrude:ok" && startF === "offset:10" && Math.abs(vStart - vDxf) > 1 && /None|Нет/.test(vtxUi ?? "") && Math.abs(vBack - vDxf) < 1, `model 1.41: extrude Start from offset, Up to next/vertex in the panel (${JSON.stringify(startUi)}, ${stStart}, ${startF}, ${(vStart - vBeforeDxf).toFixed(1)}, ${vtxUi}, ${vBack.toFixed(1)} = ${vDxf.toFixed(1)})`);
    // 1.29: sketch patterns on Top: a Ø3 hole at (0,18) four times round the origin, one at (−35,−20) three times 10 mm apart in X; cut through all.
    const vBeforePat = await vol();
    await mp.click('[data-c="sketch"]');
    await mp.click('#mc-tree .ft-row[data-id="std:XY"]');
    await idle();
    await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      e.sk.ents.push({ id: "pc1", t: "point", x: 0, y: 18 }, { id: "pcc", t: "circle", c: "pc1", r: 1.5 });
      e.selection = new Set(["pcc"]);
    });
    await mp.click('#mc-tools [data-c="skcpat"]');
    const patTitle = await mp.evaluate(() => document.querySelector("#mc-pm h3")?.textContent);
    await mp.fill('#mc-pm input[data-p="n"]', "4");
    await mp.press('#mc-pm input[data-p="n"]', "Tab");
    await mp.click('#mc-pm [data-a="pok"]');
    await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      e.sk.ents.push({ id: "pl1", t: "point", x: -35, y: -20 }, { id: "plc", t: "circle", c: "pl1", r: 1.5 });
      e.selection = new Set(["plc"]);
    });
    await mp.click('#mc-tools [data-c="sklpat"]');
    await mp.fill('#mc-pm input[data-p="d"]', "10");
    await mp.press('#mc-pm input[data-p="d"]', "Tab");
    await mp.click('#mc-pm [data-a="pok"]');
    // Move/copy, rotate, scale (FR-SK-039): a Ø3 at (25,−15) copied 30 mm up, the copy turned 180° about the origin, the original scaled ×2 about its centre.
    await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      e.sk.ents.push({ id: "pm1", t: "point", x: 25, y: -15 }, { id: "pmc", t: "circle", c: "pm1", r: 1.5 });
      e.selection = new Set(["pmc"]);
    });
    await mp.click('#mc-tools [data-c="skmove"]');
    await mp.check('#mc-pm input[data-p="copy"]');
    await mp.fill('#mc-pm input[data-p="dx"]', "0");
    await mp.press('#mc-pm input[data-p="dx"]', "Tab");
    await mp.fill('#mc-pm input[data-p="dy"]', "30");
    await mp.press('#mc-pm input[data-p="dy"]', "Tab");
    await mp.click('#mc-pm [data-a="pok"]');
    await mp.click('#mc-tools [data-c="skrot"]');
    await mp.fill('#mc-pm input[data-p="angle"]', "180");
    await mp.press('#mc-pm input[data-p="angle"]', "Tab");
    await mp.click('#mc-pm [data-a="pok"]');
    await mp.evaluate(() => { window.__sv.model.editor().selection = new Set(["pmc"]); });
    await mp.click('#mc-tools [data-c="skscale"]');
    await mp.fill('#mc-pm input[data-p="cx"]', "25");
    await mp.press('#mc-pm input[data-p="cx"]', "Tab");
    await mp.fill('#mc-pm input[data-p="cy"]', "-15");
    await mp.press('#mc-pm input[data-p="cy"]', "Tab");
    await mp.click('#mc-pm [data-a="pok"]');
    const xf = await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      return e.sk.ents.filter(x => x.t === "circle" && Math.abs(e.sk.ents.find(q => q.id === x.c).y + 15) < 1e-6).map(x => { const p = e.sk.ents.find(q => q.id === x.c); return `${Math.round(p.x)},${x.r}`; }).sort().join(" ");
    });
    const pat = await mp.evaluate(() => {
      const e = window.__sv.model.editor();
      const cs = e.sk.ents.filter(x => x.t === "circle" && x.r === 1.5).map(x => { const p = e.sk.ents.find(q => q.id === x.c); return `${Math.round(p.x)},${Math.round(p.y)}`; }).sort();
      return { cs: cs.join(" "), eq: e.sk.rels.filter(r => r.t === "equal").length, st: e.info.status };
    });
    await mp.click("#mc-ok");
    await idle();
    await mp.click('#mc-tools [data-c="cut"]');
    await idle();
    await mp.selectOption('#mc-pm select[data-k="end"]', "through");
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const vPat = await vol(), stPat = await lastSt();
    const holes7 = 8 * Math.PI * 2.25 * 10 + Math.PI * 9 * 10;
    check(patTitle === "Circular sketch pattern" && pat.cs === "-15,-20 -18,0 -25,-15 -25,-20 -35,-20 0,-18 0,18 18,0" && xf === "-25,1.5 25,3" && pat.eq === 5 && pat.st === "ok" && stPat === "extrude:ok" && vBeforePat - vPat > holes7 - 1, `model 1.29: sketch patterns, move/copy, rotate and scale, cut through the gasket (${patTitle}, ${pat.cs}, ${xf}, ${pat.eq} equal, ${pat.st}, ${stPat}, ${(vBeforePat - vPat).toFixed(1)} ≥ ${holes7.toFixed(1)})`);
    // 1.30: tree folders (FR-HIS-009) and the freeze bar (FR-HIS-024) from the context menu.
    const cutId = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    const menuPick = async (id, label) => {
      await mp.click(`#mc-tree .ft-row[data-id="${id}"] .ft-name`, { button: "right" });
      await mp.locator("#mc-menu button", { hasText: label }).first().click();
      await idle();
    };
    await menuPick(cutId, "Add to new folder");
    const fold1 = await mp.evaluate(id => ({ name: document.querySelector("#mc-tree .ft-folder .ft-name")?.textContent, inside: document.querySelector(`#mc-tree .ft-row[data-id="${id}"]`)?.classList.contains("infolder") }), cutId);
    await mp.click("#mc-tree .ft-folder .ft-name");
    const folded = await mp.evaluate(id => ({ gone: !document.querySelector(`#mc-tree .ft-row[data-id="${id}"]`), exp: document.querySelector("#mc-tree .ft-folder")?.getAttribute("aria-expanded") }), cutId);
    await mp.click("#mc-tree .ft-folder .ft-name");
    const vFz0 = await vol();
    await menuPick(gid, "Freeze up to here");
    const fz = await mp.evaluate(id => ({ bar: !!document.querySelector("#mc-tree .ft-freeze"), frozen: document.querySelector(`#mc-tree .ft-row[data-id="${id}"]`)?.classList.contains("frozen"), after: window.__sv.model.store.doc.freezeAfter }), gid);
    await mp.dblclick(`#mc-tree .ft-row[data-id="${gid}"] .ft-name`);
    const fzMode = await mp.evaluate(() => window.__sv.model.mode().kind);
    const fzToast = await mp.evaluate(() => [...document.querySelectorAll(".toast")].map(e => e.textContent).join(" | "));
    await menuPick(gid, "Unfreeze all");
    const vFz1 = await vol();
    check(fold1.name === "Folder1" && fold1.inside && folded.gone && folded.exp === "false" && fz.bar && fz.frozen && fz.after === gid && fzMode === "none" && /above the freeze bar/.test(fzToast) && Math.abs(vFz1 - vFz0) < 1e-6 && !(await mp.evaluate(() => window.__sv.model.store.doc.freezeAfter)), `model 1.30: a tree folder that collapses; a freeze bar that blocks editing (${JSON.stringify(fold1)}, ${JSON.stringify(folded)}, ${JSON.stringify(fz)}, ${fzMode})`);
    // 1.31: the Features tree filter (FR-HIS-011): "cut" leaves the cuts (and their folder), Extrude rows hide.
    await mp.fill("#ft-search", "cut");
    const flt = await mp.evaluate(gid => { const rows = [...document.querySelectorAll("#mc-tree .ft-row[data-i]")]; const vis = rows.filter(r => !r.hidden).map(r => r.querySelector(".ft-name").textContent); return { vis, gidHidden: document.querySelector(`#mc-tree .ft-row[data-id="${gid}"]`)?.hidden, folder: !document.querySelector("#mc-tree .ft-folder")?.hidden }; }, gid);
    await mp.fill("#ft-search", "");
    const fltAll = await mp.evaluate(() => [...document.querySelectorAll("#mc-tree .ft-row[data-i]")].every(r => !r.hidden));
    check(flt.vis.length > 0 && flt.vis.every(n => /cut/i.test(n)) && flt.gidHidden && flt.folder && fltAll, `model 1.31: the feature filter shows only matching rows (${JSON.stringify(flt)}, ${fltAll})`);
    // 1.32: cosmetic thread (FR-FT-054) on one of the gasket's Ø8 holes: internal, nearest ISO size by tap drill (M10), dashed circles, no volume change.
    const vTh0 = await vol();
    await mp.click('#mc-tools [data-c="thread"]');
    await mp.waitForFunction(() => window.__sv.model.mode().draft?.type === "thread");
    await mp.evaluate(() => {
      const c = window.__sv.modeller, ed = window.__sv.viewer.parts[0].data.edges.find(e => (e.type === "circle" || e.type === "arc") && Math.abs((e.radius ?? 0) - 4) < 1e-3);
      if (ed && c.setThreadEdge(window.__sv.model.mode().draft, ed)) c.draftChanged();
    });
    await idle();
    const th = await mp.evaluate(() => ({ size: document.querySelector('#mc-pm select[data-k="size"]')?.value, internal: window.__sv.model.mode().draft.internal, dia: window.__sv.model.mode().draft.diameter.v, drawn: window.__sv.modeller.decor.children.some(o => o.userData.thread) }));
    await mp.click("#mc-ok");
    await idle();
    const stTh = await lastSt(), vTh1 = await vol();
    check(th.size === "M10" && th.internal === true && th.dia === 10 && th.drawn && stTh === "thread:ok" && Math.abs(vTh1 - vTh0) < 1e-6, `model 1.32: cosmetic thread on a Ø8 hole (${JSON.stringify(th)}, ${stTh}, ${(vTh1 - vTh0).toFixed(6)})`);
    // 1.33: hole favourites (FR-FT-056): an M8 counterbore saved under a name, then applied to a simple hole.
    await mp.click('#mc-tools [data-c="hole"]');
    await mp.waitForSelector('#mc-pm select[data-k="kind"]');
    await mp.selectOption('#mc-pm select[data-k="kind"]', "cbore");
    await idle();
    await mp.selectOption('#mc-pm select[data-k="size"]', "M8");
    await idle();
    await mp.fill('#mc-pm input[data-ui="favName"]', "M8 cbore");
    await mp.click('#mc-pm [data-ui="favSave"]');
    await mp.selectOption('#mc-pm select[data-k="kind"]', "simple");
    await mp.selectOption('#mc-pm select[data-k="size"]', "M4");
    await idle();
    const favIdx = await mp.evaluate(() => [...document.querySelectorAll('#mc-pm select[data-ui="fav"] option')].find(o => o.textContent === "M8 cbore")?.value);
    await mp.selectOption('#mc-pm select[data-ui="fav"]', favIdx ?? "");
    const favApplied = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { kind: d.kind, size: d.size, cb: d.cbDia?.v }; });
    // 1.50: heat-set insert holes: M2–M8 sizes, M4 is a Ø5.6 flat-bottomed hole 9.1 mm deep, with the wall hint.
    await mp.selectOption('#mc-pm select[data-k="kind"]', "insert");
    await idle();
    await mp.selectOption('#mc-pm select[data-k="size"]', "M4");
    await idle();
    const ins = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { sizes: [...document.querySelectorAll('#mc-pm select[data-k="size"] option')].map(o => o.value).filter(Boolean).join(","), d: d.diameter.v, depth: d.depth.v, end: d.end, flat: d.flat, fit: !!document.querySelector('#mc-pm select[data-k="fit"]'), hint: document.querySelector("#mc-pm [data-insert]")?.textContent }; });
    check(ins.sizes === "M2,M2.5,M3,M4,M5,M6,M8" && ins.d === 5.6 && Math.abs(ins.depth - 9.1) < 1e-9 && ins.end === "blind" && ins.flat && !ins.fit && /8\.1 mm.*2\.1 mm.*9\.8 mm/.test(ins.hint ?? ""), `model 1.50: heat-set insert hole presets (${JSON.stringify(ins)})`);
    await mp.keyboard.press("Escape");
    check(favIdx != null && favApplied.kind === "cbore" && favApplied.size === "M8" && favApplied.cb === 15, `model 1.33: a saved hole favourite applies type, size and counterbore (${favIdx}, ${JSON.stringify(favApplied)})`);
    await ctx.close();
  }

  // --- Part modelling 1.34.0: ellipse and partial ellipse in sketches (FR-SK-018) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const toPage = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const click = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(80); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    // The Circle flyout also holds Ellipse and Partial ellipse.
    await mp.click('#mc-tools [data-fly="circle"]');
    const elFly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(4)");
    // Ellipse 2 × 30 by 2 × 12 round the origin (the centre snaps to it: 3 DOF left); the third click is on the ellipse at x = 18.
    await click([0, 0]); await click([30, 0]); await click([18, 12 * Math.sqrt(1 - 0.36)]);
    const el = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id); const e = sk.ents.find(x => x.t === "ellipse"); return e ? { r1: Math.hypot(P(e.a).x - P(e.c).x, P(e.a).y - P(e.c).y), r2: Math.hypot(P(e.b).x - P(e.c).x, P(e.b).y - P(e.c).y), st: ed.info.status, dof: ed.info.dof } : null; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude", d => { d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }); }));
    await idle();
    const vEl = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    // Partial ellipse 20 × 8 on the end face: from (16, 4.8) over the top to (-16, 4.8), closed by a line, cut 2 deep.
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "x:end", hint: [0, 0, 5] } }, rels: [], dims: [], ents: [] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s2"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => window.__sv.model.editor().setTool("earc"));
    await click([0, 0]); await click([20, 0]); await click([16, 4.8]); await click([-16, 4.8]);
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    const ends = await mp.evaluate(() => { const sk = window.__sv.model.editor().sk, P = id => sk.ents.find(e => e.id === id); const e = sk.ents.find(x => x.t === "ellipse"); return e?.p0 ? [P(e.p0), P(e.p1)].map(p => [p.x, p.y]) : null; });
    if (ends) { await click(ends[1]); await click(ends[0]); }
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Cut", d => { d.features.push({ id: "c", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "blind", depth: { v: 2 } }); }));
    await idle();
    const cut = await mp.evaluate(() => { const r = window.__sv.model.last(); return { v: r.props?.volume ?? 0, ok: r.statuses.every(s => s.ok) }; });
    const dT = Math.PI - 2 * Math.atan2(0.6, 0.8), half = 80 * (dT - Math.sin(dT)) * 2;
    check(elFly === "Circle|3-point circle|Perimeter circle|Ellipse|Partial ellipse|Parabola|Conic" && el && near(el.r1, 30, 0.01) && near(el.r2, 12, 0.01) && el.st === "ok" && el.dof === 3 && near(vEl, Math.PI * 30 * 12 * 5, 0.5) && cut.ok && near(vEl - cut.v, half, 1), `model 1.34: ellipse and partial ellipse tools, extruded and cut (${elFly}, ${JSON.stringify(el)}, ${vEl.toFixed(1)}, ${(vEl - cut.v).toFixed(1)} ≈ ${half.toFixed(1)}, ${cut.ok})`);
    // 1.35: a closed spline (FR-SK-019) from the Line flyout on the end face, cut through all.
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s3", type: "sketch", name: "Sketch3", plane: { face: { name: "x:end", hint: [-15, 0, 5] } }, rels: [], dims: [], ents: [] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s3"));
    await mp.waitForTimeout(1200);
    await mp.click('#mc-tools [data-fly="line"]');
    const lnFly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(2)");
    await click([-22, 0]); await click([-15, -3]); await click([-8, 0]); await click([-15, 3]); await click([-22, 0]);
    const spl = await mp.evaluate(() => { const ed = window.__sv.model.editor(), e = ed.sk.ents.find(x => x.t === "spline"); return e ? { n: e.pts.length, closed: !!e.closed, dof: ed.info.dof } : null; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Cut", d => { d.features.push({ id: "c3", type: "extrude", name: "Cut2", sketch: "s3", op: "cut", end: "through", depth: { v: 0 } }); }));
    await idle();
    const cut3 = await mp.evaluate(() => { const r = window.__sv.model.last(); return { v: r.props?.volume ?? 0, ok: r.statuses.every(s => s.ok), faces: window.__sv.viewer.parts[0]?.data.faces.length }; });
    const dSpl = cut.v - cut3.v;
    check(lnFly === "Line|Spline|Style spline|Equation driven curve" && spl?.n === 4 && spl.closed && spl.dof === 8 && cut3.ok && dSpl > 42 * 5 && dSpl < 42 * 5 * 1.7, `model 1.35: a closed spline through four clicks, cut through the part (${lnFly}, ${JSON.stringify(spl)}, ${cut3.ok}, ${dSpl.toFixed(1)})`);
    await ctx.close();
  }

  // --- Part modelling 1.137.0: sketch text (FR-SK-020), embossed by Extrude ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const toPage = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const click = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(80); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    // The Point flyout holds Text; the panel takes the text and height before the click.
    await mp.click('#mc-tools [data-fly="point"]');
    const ptFly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(2)");
    await mp.waitForSelector("#mc-pm [data-tx=text]");
    await mp.evaluate(() => { const set = (k, v) => { const el = document.querySelector(`#mc-pm [data-tx=${k}]`); el.value = v; el.dispatchEvent(new Event("change")); }; set("text", "MC"); set("h", "10"); });
    await click([5, 5]);
    await mp.waitForFunction(() => window.__sv.model.editor().sk.ents.some(e => e.t === "text" && e.gl), null, { timeout: 30000 });
    const tx = await mp.evaluate(() => { const ed = window.__sv.model.editor(), e = ed.sk.ents.find(x => x.t === "text"), p = ed.sk.ents.find(x => x.id === e.p); return { text: e.text, h: e.h, at: [p.x, p.y].map(v => Math.round(v * 10) / 10), dof: ed.info.dof }; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude", d => { d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 2 } }); }));
    await idle();
    const emb = await mp.evaluate(() => { const r = window.__sv.model.last(); return { v: r.props?.volume ?? 0, ok: r.statuses.every(s => s.ok), solids: r.props?.bodies }; });
    // The text panel in Russian, with the text selected.
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => { const ed = window.__sv.model.editor(); ed.select([ed.sk.ents.find(x => x.t === "text").id]); window.__sv.modeller.renderPanel(); });
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    await mp.waitForTimeout(300);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm .pm-text h4, #mc-pm .pm-text label, #mc-pm .pm-text .pm-help")].map(e => e.textContent.trim()).join("|"));
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    check(ptFly === "Point|Text" && tx.text === "MC" && tx.h === 10 && Math.abs(tx.at[0] - 5) < 1.5 && Math.abs(tx.at[1] - 5) < 1.5 && tx.dof === 2 && emb.ok && emb.v > 2 * 25 && emb.v < 2 * 160, `model 1.137: Text tool from the Point flyout, embossed 2 mm (${ptFly}, ${JSON.stringify(tx)}, ${JSON.stringify(emb)})`);
    check(/Шрифт/.test(ru) && /Жирный/.test(ru) && /Высота/.test(ru) && /заглавной/.test(ru) && !/Font|Bold|capital/.test(ru), `model 1.137: the text panel in Russian (${ru})`);
    await ctx.close();
  }

  // --- Part modelling 1.139.0: section at the sketch plane (FR-SK-006), configuration table CSV (FR-CFG-003) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 40 block 20 high, then a sketch on the XZ plane through its middle.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [{ id: "d1", name: "D1", t: "distance", e: ["p1", "p2"], val: { v: 40 } }], ents: [
        { id: "p1", t: "point", x: -20, y: -20 }, { id: "p2", t: "point", x: 20, y: -20 }, { id: "p3", t: "point", x: 20, y: 20 }, { id: "p4", t: "point", x: -20, y: 20 },
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] });
      d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } });
      d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XZ" }, rels: [], dims: [], ents: [] });
    }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s2"));
    await mp.waitForTimeout(1000);
    await mp.click('#mc-tools [data-c="sksec"]');
    await mp.waitForTimeout(300);
    const on = await mp.evaluate(() => { const sp = window.__sv.section.planes.find(p => p.label === "Sketch"); return sp ? { n: sp.axis.toArray().map(v => Math.round(v * 1000) / 1000), off: Math.round(sp.offset * 1000) / 1000, pressed: document.querySelector('#mc-tools [data-c="sksec"]').getAttribute("aria-pressed"), clip: window.__sv.viewer.renderer.clippingPlanes?.length ?? 0 } : null; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    const off = await mp.evaluate(() => window.__sv.section.planes.filter(p => p.label === "Sketch").length);
    check(on && Math.abs(Math.abs(on.n[1]) - 1) < 1e-6 && Math.abs(on.off) < 0.1 && on.pressed === "true" && off === 0, `model 1.139: Section at the sketch plane while sketching, gone on exit (${JSON.stringify(on)}, ${off})`);
    // Configuration table: export lists both configurations; importing a CSV edits one and adds another.
    await mp.evaluate(() => window.__sv.modeller.editConfigs());
    await mp.click("#mc-pm [data-a=add]");
    await idle();
    const dl = mp.waitForEvent("download");
    await mp.click("#mc-pm [data-a=cfgcsv]");
    const csv = await (await dl).createReadStream().then(r => new Promise(res => { let t = ""; r.on("data", c => (t += c)); r.on("end", () => res(t)); }));
    await mp.evaluate(() => window.__sv.modeller.importConfigTable("Configuration,depth@Extrude1,D1@Sketch1\nConfig2,35,30\nTall,60,\n"));
    await idle();
    const cfg = await mp.evaluate(() => { const d = window.__sv.model.store.doc; return { names: d.configs.map(c => c.name), act: d.config, depth: d.features[1].depth.v, d1: d.features[0].dims[0].val.v, ok: window.__sv.model.last().statuses.every(s => s.ok) }; });
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    await mp.waitForTimeout(300);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm fieldset:last-of-type legend, #mc-pm [data-a=cfgcsv], #mc-pm [data-a=cfgin]")].map(e => e.textContent.trim()).join("|"));
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    check(/^Configuration,\$STATE@Sketch1,/.test(csv) && /\nDefault,/.test(csv) && /\nConfig2,/.test(csv) && /D1@Sketch1/.test(csv) && cfg.names.join() === "Default,Config2,Tall" && cfg.act === "Config2" && cfg.depth === 35 && cfg.d1 === 30 && cfg.ok, `model 1.139: configuration table export and import (${csv.split("\n")[0]}, ${JSON.stringify(cfg)})`);
    check(ru === "Таблица конфигураций|Экспорт таблицы|Импорт таблицы…", `model 1.139: configuration table in Russian (${ru})`);
    await ctx.close();
  }

  // --- Part modelling 1.141.0: geometry pattern option (FR-FT-074) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A block whose top slopes from z = 10 (x = 0) to z = 20 (x = 60); an Ø6 pocket from the bottom up to the slope, patterned 3 × 20 mm along X.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const pts = [[0, 0], [60, 0], [60, 20], [0, 10]];
      d.features.push({ id: "w", type: "sketch", name: "Sketch1", plane: { std: "XZ" }, rels: [], dims: [], ents: [...pts.map(([x, y], i) => ({ id: `wp${i}`, t: "point", x, y })), ...pts.map((_p, i) => ({ id: `wl${i}`, t: "line", a: `wp${i}`, b: `wp${(i + 1) % 4}` }))] });
      d.features.push({ id: "eb", type: "extrude", name: "Extrude1", sketch: "w", op: "boss", end: "mid", depth: { v: 20 } });
      d.features.push({ id: "c", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "cc", t: "point", x: 10, y: 0 }, { id: "ck", t: "circle", c: "cc", r: 3 }] });
      d.features.push({ id: "ec", type: "extrude", name: "Cut1", sketch: "c", op: "cut", end: "upto", flip: true, depth: { v: 1 }, upTo: { face: { name: "eb:side:wl2" } } });
      d.features.push({ id: "p", type: "lpattern", name: "LPattern1", features: ["ec"], dir: { edge: { faces: ["eb:side:wl0", "eb:end"] } }, spacing: { v: 20 }, count: 3 });
    }));
    await idle();
    const vol = () => mp.evaluate(() => window.__sv.model.last().props.volume);
    const v0 = 60 * 15 * 20, a = Math.PI * 9, h = x => 10 + x / 6;
    const geo = await vol();
    await mp.evaluate(() => window.__sv.modeller.editFeature("p"));
    await mp.waitForSelector('#mc-pm [data-k="geometry"]');
    const was = await mp.evaluate(() => document.querySelector('#mc-pm [data-k="geometry"]').checked);
    await mp.click('#mc-pm [data-k="geometry"]');
    await mp.waitForTimeout(500);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    const vary = await vol();
    const flag = await mp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.id === "p").vary);
    check(was && flag === true && Math.abs(v0 - geo - 3 * a * h(10)) < 0.5 && Math.abs(v0 - vary - a * (h(10) + h(30) + h(50))) < 0.5, `model 1.141: geometry pattern off rebuilds each pocket up to the slope (${(v0 - geo).toFixed(1)} → ${(v0 - vary).toFixed(1)})`);
    await mp.evaluate(() => window.__sv.modeller.editFeature("p"));
    await mp.waitForSelector('#mc-pm [data-k="geometry"]');
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    await mp.waitForTimeout(300);
    const ru = await mp.evaluate(() => document.querySelector('#mc-pm [data-k="geometry"]').parentElement.textContent.trim());
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    check(ru === "Геометрический массив", `model 1.141: Geometry pattern in Russian (${ru})`);
    await ctx.close();
  }

  // --- Part modelling 1.142.0: text along a curve (FR-SK-020) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A construction circle R20 and a text whose start point sits on top of it (its outline is made by the panel).
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [
      { id: "c0", t: "point", x: 0, y: 0 }, { id: "k", t: "circle", c: "c0", r: 20, cons: true }, { id: "p", t: "point", x: 0, y: 20 }, { id: "t", t: "text", p: "p", text: "MOBIUS", h: 4 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => { const ed = window.__sv.model.editor(); ed.select(["t"]); window.__sv.modeller.renderPanel(); });
    await mp.waitForSelector("#mc-pm [data-tx=along]");
    const opts = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm [data-tx=along] option")].map(o => o.textContent).join("|"));
    await mp.selectOption("#mc-pm [data-tx=along]", "k");
    await mp.waitForSelector("#mc-pm [data-tx=flip]", { timeout: 30000 });
    await mp.click("#mc-pm [data-tx=flip]");
    await mp.waitForFunction(() => window.__sv.model.editor().sk.ents.find(e => e.id === "t").flip === true && window.__sv.model.editor().sk.ents.find(e => e.id === "t").gl, null, { timeout: 30000 });
    const ru = await (async () => {
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      await mp.waitForTimeout(300);
      const r = await mp.evaluate(() => [document.querySelector("#mc-pm [data-tx=along]").closest("label").querySelector("span"), document.querySelector("#mc-pm [data-tx=flip]").closest("label")].map(e => e.textContent.trim()).join("|"));
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      return r;
    })();
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude", d => { d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 1 } }); }));
    await idle();
    const res = await mp.evaluate(() => { const r = window.__sv.model.last(); return { ok: r.statuses.every(s => s.ok), v: r.props?.volume ?? 0, t: window.__sv.model.store.doc.features[0].ents.find(e => e.id === "t") }; });
    check(opts.startsWith("None|Circle 1") && res.t.along === "k" && res.t.flip === true && res.ok && res.v > 10, `model 1.142: text along a circle, flipped, extruded (${opts}, ${JSON.stringify({ ok: res.ok, v: res.v, along: res.t.along, flip: res.t.flip })})`);
    check(ru === "Вдоль кривой|Другая сторона", `model 1.142: text along a curve in Russian (${ru})`);
    await ctx.close();
  }

  // --- Part modelling 1.144.0: arc and centrepoint slot tools with the Modify box (FR-SK-017) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const toPage = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const click = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(80); };
    const modify = async v => { await mp.waitForSelector(".mod-box .mod-in", { timeout: 10000 }); await mp.fill(".mod-box .mod-in", v); await mp.keyboard.press("Enter"); await mp.waitForTimeout(150); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "q", t: "point", x: 100, y: 100 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; v.fit(false); v.camera.zoom = 1; });
    // Slot ▾ lists the four slot tools; pick Centerpoint arc slot.
    await mp.click('#mc-tools [data-fly="slot"]');
    const fly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(3)");
    const picked = await mp.evaluate(() => window.__sv.model.editor().tool);
    // Centre (0, 0) on the origin, start (40, 0), end towards (0, 60), width click 5 out: R40 × 10, a quarter turn.
    await click([0, 0]); await click([40, 0]); await click([0, 60]);
    const preview = await mp.evaluate(() => window.__sv.model.editor().draft.pts.length);
    await click([0, 45]);
    // The Modify box opens on the width (12), then on the radius (50).
    await modify("12");
    await modify("50");
    const arc = await mp.evaluate(() => {
      const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id);
      const rad = a => Math.hypot(P(a.a).x - P(a.c).x, P(a.a).y - P(a.c).y);
      const arcs = sk.ents.filter(e => e.t === "arc");
      return { arcs: arcs.length, cons: arcs.filter(a => a.cons).map(rad), caps: arcs.filter(a => !a.cons && rad(a) < 10).map(rad), dims: sk.dims.map(d => `${d.t}:${Math.round(d.val.v * 1000) / 1000}`).join(","), ok: ed.info.status, dof: ed.info.dof };
    });
    check(fly === "Straight slot|Centerpoint straight slot|Centerpoint arc slot|3-point arc slot" && picked === "aslot" && preview === 3 && arc.arcs === 5 && Math.abs(arc.cons[0] - 50) < 1e-3 && arc.caps.length === 2 && arc.caps.every(r => Math.abs(r - 6) < 1e-3) && arc.dims === "diameter:12,radius:50" && arc.ok === "ok" && arc.dof <= 4,
      `model 1.144: Centerpoint arc slot from the Slot menu, width and radius set in the Modify box (${fly}, ${picked}, ${JSON.stringify(arc)})`);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude", d => { d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }); }));
    await idle();
    const vol = await mp.evaluate(() => { const r = window.__sv.model.last(); return { ok: r.statuses.every(s => s.ok), v: r.props?.volume ?? 0 }; });
    const want = (Math.PI / 2 * 50 * 12 + Math.PI * 36) * 5;
    check(vol.ok && Math.abs(vol.v - want) < want * 0.002, `model 1.144: the arc slot extrudes to (π/2·50·12 + π·6²)·5 = ${want.toFixed(1)} mm³ (${JSON.stringify(vol)})`);
    // A second sketch: 3-point arc slot without dimensions, then a centrepoint straight slot.
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "q2", t: "point", x: 100, y: 100 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s2"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => { window.__sv.model.editor().setTool("aslot3"); window.__sv.modeller.renderPanel(); });
    await mp.waitForSelector("#mc-pm [data-a=slotdims]");
    await mp.click("#mc-pm [data-a=slotdims]");
    // Start (-25, 10) → end (-25, 50) through (-15, 30): R25 about (-40, 30), half-width 3.
    await click([-25, 10]); await click([-25, 50]); await click([-15, 30]); await click([-12, 30]);
    const a3 = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk; return { arcs: sk.ents.filter(e => e.t === "arc").length, dims: sk.dims.length, ok: ed.info.status, box: !!document.querySelector(".mod-box"), off: ed.slotDims, saved: localStorage.getItem("mc:slotDims") }; });
    await mp.click("#mc-pm [data-a=slotdims]");
    await mp.evaluate(() => window.__sv.model.editor().setTool("cslot"));
    await click([15, 15]); await click([25, 15]); await click([20, 18]);
    await modify("8");
    await modify("30");
    const cs = await mp.evaluate(() => {
      const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id);
      const mid = sk.rels.find(r => r.t === "midpoint"), m = P(mid?.e[0]), ax = P(mid?.e[1]);
      return { mid: m && ax ? [m.x, m.y, P(ax.a).x, P(ax.b).x].map(v => Math.round(v * 1000) / 1000) : null, dims: sk.dims.map(d => `${d.t}:${d.val.v}`).join(","), ok: ed.info.status };
    });
    check(a3.arcs === 5 && a3.dims === 0 && a3.ok === "ok" && !a3.box && a3.off === false && a3.saved === "0", `model 1.144: 3-point arc slot with Add dimensions off (${JSON.stringify(a3)})`);
    check(cs.mid && cs.mid[0] === 15 && cs.mid[1] === 15 && cs.mid[2] === 0 && cs.mid[3] === 30 && cs.dims === "diameter:8,distance:30" && cs.ok === "ok",
      `model 1.144: Centerpoint straight slot stays centred on its first click as the length changes (${JSON.stringify(cs)})`);
    const ru = await (async () => {
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      await mp.waitForTimeout(300);
      const r = await mp.evaluate(() => document.querySelector("#mc-pm [data-a=slotdims]").closest("label").textContent.trim());
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      return r;
    })();
    // 1.152.0: 3-point rectangle and parallelogram from the Rectangle menu (FR-SK-013).
    await mp.click('#mc-tools [data-fly="rect"]');
    const rfly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(3)");
    const nl0 = await mp.evaluate(() => window.__sv.model.editor().sk.ents.filter(e => e.t === "line").length);
    await click([5, -5]); await click([25, -12]); await click([20, -18]);
    await mp.evaluate(() => window.__sv.model.editor().setTool("pgram"));
    await click([40, -5]); await click([60, -5]); await click([66, -16]);
    const quads = await mp.evaluate(n0 => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id); const ls = sk.ents.filter(e => e.t === "line").slice(n0); const last = ls.slice(-4); const d = last.map(l => [P(l.a).x, P(l.a).y]); return { n: ls.length, perp: sk.rels.filter(r => r.t === "perpendicular").length, par: sk.rels.filter(r => r.t === "parallel").length, fourth: d[3].map(v => Math.round(v * 100) / 100), ok: ed.info.status }; }, nl0);
    check(rfly === "Corner rectangle|Centre rectangle|3-point corner rectangle|3-point centre rectangle|Parallelogram|Polygon" && quads.n === 8 && quads.perp === 1 && quads.par >= 4 && quads.fourth.join(",") === "46,-16" && quads.ok === "ok",
      `model 1.152: 3-point rectangle and parallelogram (${rfly}, ${JSON.stringify(quads)})`);
    check(ru === "Добавить размеры", `model 1.144: Add dimensions in Russian (${ru})`);
    await ctx.close();
  }

  // --- Part modelling 1.157.0: conic, parabola and equation driven curve (FR-SK-021) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const toPage = q => mp.evaluate(q => { const v = window.__sv.viewer, f = window.__sv.model.editor().frame; const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * q[0] + f.y[i] * q[1]); const s = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, q);
    const click = async q => { const [x, y] = await toPage(q); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(80); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "q", t: "point", x: 100, y: 100 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.fit(false); v.camera.zoom = 1; });
    // Circle ▾ lists Parabola and Conic after the ellipses; pick Conic.
    await mp.click('#mc-tools [data-fly="circle"]');
    const fly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(7)");
    const picked = await mp.evaluate(() => window.__sv.model.editor().tool);
    // Start (0, 0), end (40, 0), top vertex (20, 30), shoulder (20, 12): rho 0.4.
    await click([0, 0]); await click([40, 0]); await click([20, 30]);
    const [sx, sy] = await toPage([20, 12]);
    await mp.mouse.move(sx, sy); await mp.waitForTimeout(80);
    const label = await mp.evaluate(() => document.querySelector(".sk-cursor")?.textContent ?? "");
    await click([20, 12]);
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    await click([40, 0]); await click([0, 0]);
    await mp.keyboard.press("Escape");
    const con = await mp.evaluate(() => { const ed = window.__sv.model.editor(), c = ed.sk.ents.find(e => e.kind === "conic"); return { rho: c?.rho, pts: c?.pts.length, lines: ed.sk.ents.filter(e => e.t === "line").length, ok: ed.info.status }; });
    check(fly === "Circle|3-point circle|Perimeter circle|Ellipse|Partial ellipse|Parabola|Conic" && picked === "conic" && label === "ρ 0.4" && con.rho === 0.4 && con.pts === 3 && con.lines === 1 && con.ok === "ok",
      `model 1.157: Conic from the Circle menu: start, end, top vertex, rho from the fourth click (${fly}, ${picked}, ${label}, ${JSON.stringify(con)})`);
    // The panel edits rho; the conic region extrudes exactly (rational quadratic edge).
    await mp.evaluate(() => { const ed = window.__sv.model.editor(); ed.setTool("select"); ed.select([ed.sk.ents.find(e => e.kind === "conic").id]); window.__sv.modeller.renderPanel(); });
    await mp.waitForSelector("#mc-pm [data-cq=rho]");
    await mp.fill("#mc-pm [data-cq=rho]", "0.6");
    await mp.dispatchEvent("#mc-pm [data-cq=rho]", "change");
    const rho2 = await mp.evaluate(() => window.__sv.model.editor().sk.ents.find(e => e.kind === "conic")?.rho);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await idle();
    await mp.evaluate(() => window.__sv.model.store.change("Extrude", d => { d.features.push({ id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }); }));
    await idle();
    const vol = await mp.evaluate(() => { const r = window.__sv.model.last(); return { ok: r.statuses.every(s => s.ok), v: r.props?.volume ?? 0 }; });
    // Area under the rational quadratic (0,0) (20,30) (40,0) with w = 0.6/0.4, by many samples.
    const want = (() => { const w = 1.5, n = 20000; let a = 0, prev = [0, 0]; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t, D = u * u + 2 * w * u * t + t * t; const q = [(2 * w * u * t * 20 + t * t * 40) / D, (2 * w * u * t * 30) / D]; a += (prev[0] * q[1] - q[0] * prev[1]) / 2; prev = q; } return Math.abs(a) * 5; })();
    check(rho2 === 0.6 && vol.ok && Math.abs(vol.v - want) < want * 1e-4, `model 1.157: rho 0.6 from the panel; the conic region extrudes to ${want.toFixed(2)} mm³ (${rho2}, ${JSON.stringify(vol)})`);
    // Sketch 2: a parabola by focus and vertex, and an equation driven curve from the panel.
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "q2", t: "point", x: 100, y: 100 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("s2"));
    await mp.waitForTimeout(1200);
    await mp.evaluate(() => window.__sv.model.editor().setTool("parabola"));
    // Focus (20, -8), vertex (20, -12): f = 4; ends over x = 10 and x = 35 → (10, -5.75), (35, 2.0625); tangents meet at (22.5, -21.375).
    await click([20, -8]); await click([20, -12]); await click([10, -15]); await click([35, -15]);
    const par = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id), c = sk.ents.find(e => e.kind === "parabola"); return c ? c.pts.map(id => [P(id).x, P(id).y].map(v => Math.round(v * 1000) / 1000).join(",")).join(" ") : ""; });
    check(par === "10,-5.75 22.5,-21.375 35,2.063", `model 1.157: parabola from focus, vertex and two ends (${par})`);
    await mp.click('#mc-tools [data-fly="line"]');
    const lfly = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(4)");
    await mp.waitForSelector("#mc-pm [data-cq=add]");
    await mp.selectOption("#mc-pm [data-cq=mode]", "param");
    await mp.waitForSelector("#mc-pm [data-cq=x]");
    await mp.fill("#mc-pm [data-cq=x]", "-30 + 10*cos(t)"); await mp.dispatchEvent("#mc-pm [data-cq=x]", "change");
    await mp.fill("#mc-pm [data-cq=y]", "10*sin(t)"); await mp.dispatchEvent("#mc-pm [data-cq=y]", "change");
    const ruAdd = await (async () => {
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      await mp.waitForTimeout(300);
      const r = await mp.evaluate(() => document.querySelector("#mc-pm [data-cq=add]").textContent.trim());
      await mp.evaluate(() => document.querySelector("#lang-btn").click());
      await mp.waitForTimeout(300);
      return r;
    })();
    await mp.click("#mc-pm [data-cq=add]");
    const eq = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id), c = sk.ents.find(e => e.kind === "eqn"); return c ? { ends: c.pts.map(id => [P(id).x, P(id).y].map(v => Math.round(v * 1000) / 1000).join(",")).join(" "), fixes: sk.rels.filter(r => r.t === "fix").length, sel: [...ed.selection][0] === c.id, ok: ed.info.status, panel: !!document.querySelector("#mc-pm [data-cq=y]") } : null; });
    check(lfly === "Line|Spline|Style spline|Equation driven curve" && eq && eq.ends === "-20,0 -40,0" && eq.fixes === 2 && eq.sel && eq.ok === "ok" && eq.panel,
      `model 1.157: equation driven curve x(t), y(t) added from the panel with fixed ends (${lfly}, ${JSON.stringify(eq)})`);
    check(ruAdd === "Добавить кривую", `model 1.157: Add curve in Russian (${ruAdd})`);
    // 1.164: a style spline (FR-SK-019 P5) from the Line flyout: four control points, the last clicked again ends it.
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-fly="line"]');
    await mp.click("#mc-menu button:nth-child(3)");
    const sTool = await mp.evaluate(() => window.__sv.model.editor().tool);
    for (const q of [[12, -15], [17, -9], [24, -15], [30, -9], [30, -9]]) await click(q);
    const sty = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id), c = sk.ents.find(e => e.kind === "style"); return c ? { n: c.pts.length, closed: !!c.closed, ends: [c.pts[0], c.pts.at(-1)].map(id => [P(id).x, P(id).y].map(v => Math.round(v)).join(",")).join(" "), ok: ed.info.status } : null; });
    check(sTool === "sspline" && sty && sty.n === 4 && !sty.closed && sty.ends === "12,-15 30,-9" && sty.ok === "ok",
      `model 1.164: style spline from four control points (${sTool}, ${JSON.stringify(sty)})`);
    // 1.167: Perimeter circle (FR-SK-014 P2) from the Circle menu, clicked on the three sides of a triangle: its incircle.
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    for (const q of [[0, -14], [10, -14], [0, -4], [0, -14]]) await click(q);
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-fly="circle"]');
    await mp.click("#mc-menu button:nth-child(3)");
    const pTool = await mp.evaluate(() => window.__sv.model.editor().tool);
    for (const q of [[3.5, -14], [7, -11], [0, -7.5]]) await click(q);
    const pc = await mp.evaluate(() => { const ed = window.__sv.model.editor(), sk = ed.sk, P = id => sk.ents.find(e => e.id === id), c = sk.ents.filter(e => e.t === "circle").at(-1); return c ? { r: Math.round(c.r * 1000) / 1000, c: [P(c.c).x, P(c.c).y].map(v => Math.round(v * 1000) / 1000).join(","), tan: sk.rels.filter(r => r.t === "tangent" && r.e.includes(c.id)).length, ok: ed.info.status } : null; });
    // Legs 10 and 10: r = (10 + 10 − 10√2) / 2 = 2.929 at (r, −14 + r).
    check(pTool === "pcircle" && pc && pc.r === 2.929 && pc.c === "2.929,-11.071" && pc.tan === 3 && pc.ok === "ok",
      `model 1.167: perimeter circle tangent to three sides of a triangle (${pTool}, ${JSON.stringify(pc)})`);
    // 1.215: a spline leaving a line's end takes Tangent and Equal curvature (FR-SK-050/051); Tangent turns its end along the line.
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    for (const q of [[14, -6], [20, -6], [20, -6]]) await click(q);
    await mp.keyboard.press("Escape");
    await mp.evaluate(() => window.__sv.model.editor().setTool("spline"));
    for (const q of [[20, -6], [26, -2.5], [32, -6], [32, -6]]) await click(q);
    await mp.keyboard.press("Escape");
    await mp.evaluate(() => window.__sv.model.editor().setTool("select"));
    await click([17, -6]);
    const onSp = await mp.evaluate(() => { const ed = window.__sv.model.editor(), c = ed.sk.ents.filter(e => e.t === "spline" && !e.kind).at(-1), l = ed.splineLine(c); return l[Math.floor(l.length / 4)]; });
    { const [x, y] = await toPage(onSp); await mp.mouse.move(x, y); await mp.waitForTimeout(40); await mp.keyboard.down("Control"); await mp.mouse.down(); await mp.mouse.up(); await mp.keyboard.up("Control"); await mp.waitForTimeout(150); }
    const relBtns = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm [data-rel]")].map(b => b.dataset.rel).join(","));
    if (await mp.$('#mc-pm [data-rel="tangent"]')) await mp.click('#mc-pm [data-rel="tangent"]');
    await mp.waitForTimeout(150);
    const st = await mp.evaluate(() => { const ed = window.__sv.model.editor(), c = ed.sk.ents.filter(e => e.t === "spline" && !e.kind).at(-1), l = ed.splineLine(c); const d = [l[1][0] - l[0][0], l[1][1] - l[0][1]]; return { tan: ed.sk.rels.filter(r => r.t === "tangent" && r.e.includes(c.id)).length, slope: Math.round(Math.abs(d[1] / d[0]) * 1000) / 1000, dir: Math.sign(d[0]), ok: ed.info.status }; });
    check(/tangent/.test(relBtns) && /curvature/.test(relBtns) && st.tan === 1 && st.slope < 0.01 && st.dir === 1 && st.ok === "ok",
      `model 1.215: spline tangent to the line it leaves; Equal curvature offered (${relBtns}, ${JSON.stringify(st)})`);
    await ctx.close();
  }

  // --- Part modelling 1.215.0: sketch orientation, X axis along a model edge (FR-SK-002); 1.234.0 pierce (FR-SK-051) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const world = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 30 × 20 block and a sketch on its top face.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -15), P("b", 20, -15), P("c", 20, 15), P("d", -20, 15), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a")] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }, { id: "t", type: "sketch", name: "Sketch2", plane: { face: { name: "x:end" } }, hidden: false, rels: [], dims: [], ents: [P("q", 5, 0)] }); }); });
    await idle();
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    const x0 = await mp.evaluate(() => window.__sv.model.last().frames.t.x.map(v => Math.round(v * 1000) / 1000).join(","));
    // Edit sketch plane → X axis → click the top edge on the +X side (it runs along Y) → OK.
    await mp.evaluate(() => window.__sv.modeller.editSketchPlane("t"));
    await idle();
    await mp.click('#mc-pm [data-a="xpick"]');
    const status = await mp.evaluate(() => document.querySelector("#mc-status")?.textContent ?? "");
    const [ex, ey] = await world([20, 0, 20]);
    await mp.mouse.move(ex, ey); await mp.waitForTimeout(80); await mp.mouse.down(); await mp.mouse.up();
    await mp.waitForTimeout(300);
    await idle();
    const box = await mp.evaluate(() => document.querySelector('#mc-pm [data-a="xpick"]')?.textContent ?? "");
    await mp.click('#mc-pm [data-a="ok"]');
    await idle();
    const after = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.find(x => x.id === "t"); return { edge: f.xAxis?.edge?.faces?.slice().sort().join("+") ?? null, x: window.__sv.model.last().frames.t.x.map(v => Math.round(v * 1000) / 1000).join(",") }; });
    check(x0 === "1,0,0" && /straight edge/.test(status) && box === "Edge" && after.edge === "x:end+x:side:l2" && after.x === "0,1,0",
      `model 1.215: sketch X axis along a picked model edge (${x0} → ${after.x}, ${after.edge}, ${box}, ${status})`);
    // Pierce (FR-SK-051): a point in a sketch on XZ, then the top edge at x = 20 (it crosses y = 0 at z = 20).
    await mp.evaluate(() => window.__sv.model.store.change("Sketch3", d => { d.features.push({ id: "u", type: "sketch", name: "Sketch3", plane: { std: "XZ" }, hidden: false, rels: [], dims: [], ents: [{ id: "q2", t: "point", x: -10, y: 5 }] }); }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("u"));
    await idle();
    await mp.waitForTimeout(800);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); const ed = window.__sv.model.editor(); ed.setTool("select"); ed.selection.add("q2"); ed.host.onSelection([...ed.selection]); });
    const pierceBtn = await mp.$('#mc-pm [data-rel="pierce"]');
    if (pierceBtn) await pierceBtn.click();
    const pStatus = await mp.evaluate(() => document.querySelector("#mc-pm .pm-pierce")?.textContent ?? "");
    const [px, py] = await world([20, 4, 20]);
    await mp.mouse.move(px, py); await mp.waitForTimeout(80); await mp.mouse.down(); await mp.mouse.up();
    await mp.waitForTimeout(300);
    await idle();
    const pierced = await mp.evaluate(() => {
      const ed = window.__sv.model.editor(), q = ed.sk.ents.find(e => e.id === "q2"), r = ed.sk.rels.find(x => x.t === "pierce"), f = ed.frame;
      const w = [0, 1, 2].map(k => Math.round((f.o[k] + q.x * f.x[k] + q.y * f.y[k]) * 1000) / 1000);
      return { w: w.join(","), edge: r?.ext?.faces?.slice().sort().join("+") ?? null };
    });
    check(!!pierceBtn && /pierces/.test(pStatus) && pierced.w === "20,0,20" && pierced.edge === "x:end+x:side:l2",
      `model 1.234: Pierce puts the point where the picked edge crosses the sketch plane (${!!pierceBtn}, ${pierced.w}, ${pierced.edge}, ${pStatus})`);
    await ctx.close();
  }

  // --- Part modelling 1.36.0: selection helpers while picking fillet edges (FR-SEL-005) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const world = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 30 × 20 block with two Ø10 holes through it.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -15), P("b", 20, -15), P("c", 20, 15), P("d", -20, 15), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a"), P("h1", -10, 0), P("h2", 10, 0), { id: "k1", t: "circle", c: "h1", r: 5 }, { id: "k2", t: "circle", c: "h2", r: 5 }] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }); }); });
    await idle();
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    await mp.click('#mc-tools [data-c="fillet"]');
    await mp.waitForFunction(() => window.__sv.model.mode().draft?.type === "fillet");
    // Right-click the top front edge: Select loop takes the four edges round its face.
    const [ex, ey] = await world([0, -15, 20]);
    await mp.mouse.click(ex, ey, { button: "right" });
    // OK and Cancel come first (FR-UI-107), then the edge helpers.
    const items = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].slice(2).map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(4)");
    const nLoop = await mp.evaluate(() => window.__sv.model.mode().draft.edges.length);
    await idle();
    await mp.waitForTimeout(300);
    // Right-click a hole's top edge: the same-radius helper adds the other hole's circles too (4 in all).
    // The view may still be easing: wait for the camera to settle before aiming.
    await mp.waitForFunction(() => { const p = window.__sv.viewer.camera.position.toArray().join(); const same = window.__camLast === p; window.__camLast = p; return same; }, null, { polling: 250, timeout: 10000 });
    // A point on the rim away from vertices and quadrant points (those snap as points, not the edge).
    const [hx, hy] = await world([-10 + 5 * Math.cos(-1.1), 5 * Math.sin(-1.1), 20]);
    await mp.mouse.click(hx, hy, { button: "right" });
    const items2 = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].slice(2).map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(6)");
    const nSame = await mp.evaluate(() => window.__sv.model.mode().draft.edges.length);
    await mp.keyboard.press("Escape");
    check(items === "Select loop|Select tangency|Select straight edges of the same length" && nLoop === 4 && /same radius/.test(items2) && nSame === 8, `model 1.36: fillet edge helpers, select loop and same radius (${items}, ${nLoop}, ${items2}, ${nSame})`);
    await ctx.close();
  }

  // --- Part modelling 1.37.0: sketch Show/Hide, visible main planes, Normal to (N), hole snapping to the origin ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const world = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    const settle = () => mp.waitForFunction(() => { const p = window.__sv.viewer.camera.position.toArray().join(); const same = window.__camLast === p; window.__camLast = p; return same; }, null, { polling: 250, timeout: 10000 });
    const camDir = () => mp.evaluate(() => { const v = window.__sv.viewer; return v.camera.position.clone().sub(v.controls.target).normalize().toArray(); });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -15), P("b", 20, -15), P("c", 20, 15), P("d", -20, 15), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a"), P("h", 10, 0), { id: "k", t: "circle", c: "h", r: 5 }] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }); }); });
    await idle();
    // An absorbed sketch is hidden; Show in the tree draws it over the body.
    const skLines = () => mp.evaluate(() => window.__sv.modeller.decor.children.filter(o => o.isLineSegments2 && [0x1d4ed8, 0x8ab4ff].includes(o.material.color.getHex())).length);
    const before = await skLines();
    await mp.click('#mc-tree .ft-row[data-id="s"]', { button: "right" });
    const skMenu = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].find(b => b.textContent === "Show")?.click());
    await idle();
    const after = await skLines(), skHidden = await mp.evaluate(() => window.__sv.model.store.doc.features[0].hidden);
    // The three main planes are drawn (faintly) and a click on one, off the model, offers Sketch and Normal to.
    const nPlanes = await mp.evaluate(() => window.__sv.modeller.planeMeshes.length);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(0, -1, 0), false); v.fit(false); });
    await settle();
    const [px, py] = await world([-23, 0, 23]);
    await mp.mouse.click(px, py);
    await mp.waitForSelector("#mc-cbar", { timeout: 5000 }).catch(() => {});
    const cbar = await mp.evaluate(() => [...document.querySelectorAll("#mc-cbar button")].map(b => b.dataset.c).join("|"));
    const selPlane = await mp.evaluate(() => window.__sv.modeller.selected);
    // N turns the view normal to the selected plane, from an iso view.
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    await settle();
    await mp.mouse.move(5, 5);
    await mp.keyboard.press("n");
    await settle();
    const dN = await camDir();
    const hasBtn = await mp.evaluate(() => !!document.querySelector('#views [data-view="normal"]'));
    // Hovering a hole's edge offers its centre (shown faintly, then picked); hovering a straight edge its midpoint.
    const hover = async w => { const [x, y] = await world(w); await mp.mouse.move(x, y, { steps: 3 }); await mp.waitForTimeout(200); };
    const hintOf = () => mp.evaluate(() => { const h = window.__sv.snapper.hint; return h ? { kind: h.kind, p: h.point.toArray().map(x => +x.toFixed(4)), shown: !document.querySelector("#snap-hint").hidden } : null; });
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    await settle();
    await hover([10 + 5 * Math.cos(-1.1), 5 * Math.sin(-1.1), 20]);
    const hC = await hintOf();
    await hover([10, 0, 20]);
    const atC = await mp.evaluate(() => { const s = window.__sv.state.lastSnap; return s ? { kind: s.kind, p: s.point.toArray().map(x => +x.toFixed(4)) } : null; });
    await hover([-12, -15, 20]);
    const hM = await hintOf();
    // Hole wizard: a click a fraction of a millimetre off the origin's projection on the top face lands exactly on it.
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 0.8), false); v.fit(false); });
    await settle();
    await mp.keyboard.press("Escape");
    await mp.click('#mc-tools [data-c="hole"]');
    const [hx, hy] = await world([0.3, 0.2, 20]);
    await mp.mouse.click(hx, hy);
    await idle();
    await mp.waitForFunction(() => document.querySelector('#mc-pm [data-focus="pts"]')?.textContent === "1 hole", null, { timeout: 15000 }).catch(() => {});
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const hole = await mp.evaluate(() => { const r = window.__sv.model.last(), f = window.__sv.model.store.doc.features.at(-1), fr = r.frames[f.id], p = f.pts[0]; return { type: f.type, st: r.statuses.at(-1)?.ok, at: p && fr ? [0, 1, 2].map(i => fr.o[i] + fr.x[i] * p[0] + fr.y[i] * p[1]) : null }; });
    // Shaded cosmetic thread: a striped sleeve inside the hole.
    await mp.evaluate(() => { const ed = window.__sv.viewer.parts[0].data.edges.find(e => e.center && Math.hypot(e.center[0] - 10, e.center[1], e.center[2] - 20) < 1e-6); const ref = window.__sv.modeller.entityRef({ edge: ed }); window.__sv.model.store.change("Thread", d => { d.features.push({ id: "t", type: "thread", name: "Thread1", edge: ref.edge, size: "M12", diameter: { v: 12 }, length: { v: 10 }, upToEnd: true, pitch: 1.75, internal: true }); }); });
    await idle();
    const shade = await mp.evaluate(() => window.__sv.modeller.decor.children.filter(o => o.userData.threadShade).map(o => ({ r: +o.geometry.parameters.radiusTop.toFixed(2), h: +o.geometry.parameters.height.toFixed(2), rep: +o.material.map.repeat.y.toFixed(2) })));
    // Pinned measurements follow the model: the top front edge (40) and the hole's rim, then the block widens and the hole grows.
    await mp.keyboard.press("Escape");
    const pin = async w => { await hover(w); await mp.mouse.down(); await mp.mouse.up(); await mp.waitForTimeout(250); await mp.evaluate(() => [...document.querySelectorAll("#readout button")].find(b => /Pin/.test(b.textContent))?.click()); await mp.waitForTimeout(100); };
    await settle();
    await pin([5, -15, 20]);
    await mp.evaluate(() => window.__sv.handlePick(null));
    await pin([10 + 5 * Math.cos(-1.1), 5 * Math.sin(-1.1), 20]);
    const vals = () => mp.evaluate(() => window.__sv.state.measurements.map(m => ({ v: +m.value.toFixed(4), src: !!m.src, stale: !!m.stale, ty: m.type, k: m.src?.picks.map(p => p.kind + ":" + p.at).join() })));
    const m0 = await vals();
    await mp.evaluate(() => window.__sv.model.store.change("Widen", d => { const sk = d.features[0], P = id => sk.ents.find(e => e.id === id); P("a").x = -25; P("d").x = -25; P("b").x = 25; P("c").x = 25; sk.ents.find(e => e.id === "k").r = 6; }));
    await idle();
    await mp.waitForTimeout(200);
    const m1 = await vals();
    check(before === 0 && /Show/.test(skMenu) && skHidden === false && after > 0, `model 1.37: an absorbed sketch shows from the tree (${before} → ${after}, ${skMenu}, ${skHidden})`);
    check(nPlanes >= 3 && selPlane === "std:XZ" && cbar.includes("sketch") && cbar.includes("normal"), `model 1.37: main planes drawn and clickable (${nPlanes}, ${selPlane}, ${cbar})`);
    check(hasBtn && Math.abs(dN[1]) > 0.999, `model 1.37: Normal to button and N turn the view to the selected plane (${hasBtn}, ${dN.map(x => x.toFixed(3))})`);
    check(hC?.kind === "circleCenter" && hC.shown && hC.p.join() === "10,0,20" && atC?.kind === "circleCenter" && hM?.kind === "midpoint" && hM.p.join() === "0,-15,20", `model 1.37: hovering an edge offers its centre or midpoint (${JSON.stringify(hC)}, ${JSON.stringify(atC)}, ${JSON.stringify(hM)})`);
    check(shade.length === 1 && shade[0].r < 5 && shade[0].r > 4.9 && shade[0].h === 20 && Math.abs(shade[0].rep - 20 / 1.75) < 0.01, `model 1.37: a cosmetic thread is shaded with a helical texture (${JSON.stringify(shade)})`);
    check(m0.length === 2 && m0.every(m => m.src) && m0[0].v === 40 && m1.length === 2 && m1[0].v === 50 && !m1[0].stale && Math.abs(m1[1].v / m0[1].v - 1.2) < 1e-6 && !m1[1].stale, `model 1.37: pinned measurements re-measure after a rebuild (${JSON.stringify(m0)} → ${JSON.stringify(m1)})`);
    check(hole.type === "hole" && hole.st && hole.at && Math.hypot(hole.at[0], hole.at[1], hole.at[2] - 20) < 1e-6, `model 1.37: a hole clicked near the origin snaps onto it (${JSON.stringify(hole)})`);
    await ctx.close();
  }

  // --- Part modelling 1.38.0: modelled (helical) thread from the thread panel (FR-FT-055) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -20), P("b", 20, -20), P("c", 20, 20), P("d", -20, 20), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a"), P("h", 0, 0), { id: "k", t: "circle", c: "h", r: 2.5 }] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }); }); });
    await idle();
    const v0 = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.evaluate(() => { const ed = window.__sv.viewer.parts[0].data.edges.find(e => e.center && Math.hypot(e.center[0], e.center[1], e.center[2] - 20) < 1e-6); const ref = window.__sv.modeller.entityRef({ edge: ed }); window.__sv.model.store.change("Thread", d => { d.features.push({ id: "t", type: "thread", name: "Thread1", edge: ref.edge, size: "M6", diameter: { v: 6 }, length: { v: 10 }, upToEnd: true, pitch: 1, internal: true }); }); });
    await idle();
    // Edit the thread and tick Modelled: the panel says what it does, and OK cuts the groove.
    await mp.evaluate(() => window.__sv.modeller.editFeature("t"));
    await mp.waitForSelector('#mc-pm input[data-k="modelled"]');
    await mp.click('#mc-pm input[data-k="modelled"]');
    const help = await mp.evaluate(() => /3D printing/.test(document.querySelector("#mc-pm").textContent));
    await idle();
    await mp.click("#mc-ok");
    await idle();
    const r = await mp.evaluate(() => { const l = window.__sv.model.last(); return { v: l.props.volume, st: l.statuses.at(-1), shade: window.__sv.modeller.decor.children.filter(o => o.userData.threadShade || o.userData.thread).length }; });
    const removed = v0 - r.v;
    check(help && r.st.ok && removed > 40 && removed < 54 && r.shade === 0, `model 1.38: a modelled M6 thread cuts its helical groove (${help}, ${removed.toFixed(2)} mm³, ${JSON.stringify(r.st)}, ${r.shade})`);
    await ctx.close();
  }

  // --- 1.39.0: local vault in the browser: save a part, check in, read-only bar, history, roll back, audit trail (FR-PDM) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 60000 });
    const vol = () => mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Block", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -10, -10), P("b", 10, -10), P("c", 10, 10), P("d", -10, 10), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a")] }, { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }); }); });
    await idle();
    // A new vault in the browser workspace, then Save part to vault.
    await mp.click("#t-vault");
    await mp.fill("#v-name", "Smoke vault");
    await mp.click('#vault-panel [data-a="new-ws"]');
    await mp.waitForSelector('#vault-panel [data-a="savepart"]:not([disabled])');
    await mp.click('#vault-panel [data-a="savepart"]');
    await mp.waitForSelector("#vault-panel .v-row");
    const row1 = await mp.evaluate(() => document.querySelector("#vault-panel .v-row").textContent.replace(/\s+/g, " ").trim());
    const title1 = await mp.evaluate(() => document.querySelector("#doc-name").textContent);
    // Edit, save (into the working copy), check in with a comment: version 2.
    await mp.evaluate(() => window.__sv.model.store.change("Depth", d => { d.features[1].depth = { v: 20 }; }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.save());
    await mp.click("#vault-panel .v-row");
    await mp.click('#vault-panel [data-a="ci"]');
    await mp.fill('#vault-dlg textarea[name="comment"]', "Twice as deep");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForFunction(() => /v2/.test(document.querySelector("#vault-panel .v-row")?.textContent ?? ""));
    // Checked in: the part is read-only, with a bar to check it out, and saving is refused.
    await mp.waitForSelector("#mc-ro", { state: "attached" });
    await mp.evaluate(() => window.__sv.model.store.change("Depth", d => { d.features[1].depth = { v: 25 }; }));
    await idle();
    await mp.evaluate(() => window.__sv.modeller.save());
    const dirty = await mp.evaluate(() => window.__sv.model.store.dirty);
    // History: two versions; roll back to version 1 makes version 3 and reopens the part as it was.
    await mp.click('#vault-panel [data-a="hist"]');
    await mp.waitForSelector("#vault-dlg tbody tr");
    const hist = await mp.evaluate(() => [...document.querySelectorAll("#vault-dlg tbody tr")].map(r => r.cells[0].textContent + ":" + r.cells[3].textContent).join("|"));
    await mp.click('#vault-dlg [data-rb="1"]');
    await mp.waitForSelector("#confirm[open]");
    await mp.click('#confirm [data-a="ok"]');
    await mp.waitForFunction(() => /v3/.test(document.querySelector("#vault-panel .v-row")?.textContent ?? ""));
    await mp.waitForFunction(() => window.__sv.model.store?.doc.features[1]?.depth.v === 10, null, { timeout: 15000 }).catch(() => {});
    await idle();
    const vBack = await vol();
    const audit = await mp.evaluate(async () => (await window.__sv.vault.vault.auditTrail()).map(e => e.action).join(","));
    const chk = await mp.evaluate(async () => { const r = await window.__sv.vault.vault.verify(); return `${r.files}/${r.objects}/${r.missing.length + r.corrupt.length}`; });
    check(/Part1\.mcadprt/.test(row1) && /v1/.test(row1) && /Andrey/.test(row1) && /v1 · .*checked out/.test(title1) && dirty === true && hist === "v2:Twice as deep|v1:Added" && Math.abs(vBack - 4000) < 1e-3, `vault 1.39: save to vault, check in, read-only, history and roll back (${row1}, ${title1}, ${dirty}, ${hist}, ${vBack})`);
    check(audit === "create vault,add,check out,check in,roll back" && chk === "1/2/0", `vault 1.39: audit trail and integrity check (${audit}, ${chk})`);
    await ctx.close();
  }

  // --- 1.40.0: vault export to ZIP and import, storage report and purge (FR-PDM-007/008) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#t-vault");
    // The tab may redraw once it has read the stored vaults: type the name into the settled field.
    await mp.waitForSelector("#v-name");
    await mp.waitForTimeout(300);
    await mp.fill("#v-name", "Backup test");
    await mp.waitForTimeout(100);
    if (await mp.inputValue("#v-name") !== "Backup test") await mp.fill("#v-name", "Backup test");
    await mp.click('#vault-panel [data-a="new-ws"]');
    await mp.waitForSelector('#vault-panel [data-a="export"]');
    // Three versions of one file and a PDF.
    await mp.evaluate(async () => {
      const p = window.__sv.vault, v = p.vault, b = s => new TextEncoder().encode(s);
      await p.addFiles([new File(["v1"], "note.txt"), new File(["%PDF"], "spec.pdf")]);
      const f = (await v.files()).find(x => x.path === "note.txt");
      for (const x of ["v2", "v3"]) { await v.checkOut(f.id); await v.saveWorking(f.id, b(x)); await v.checkIn(f.id, x); }
      await p.refresh();
    });
    // Export ZIP from the tab (all versions) and import it as a second vault.
    await mp.click('#vault-panel [data-a="export"]');
    const [dl] = await Promise.all([mp.waitForEvent("download"), mp.click('#vault-dlg button[value="ok"]')]);
    const zipPath = await dl.path();
    const name = dl.suggestedFilename();
    await mp.click('#vault-panel [data-a="close"]');
    await mp.waitForSelector('#vault-panel [data-a="import"]');
    await mp.setInputFiles("#v-zip", zipPath);
    await mp.waitForFunction(() => window.__sv.vault.vault?.root.name === "Backup test (2)", null, { timeout: 10000 }).catch(() => {});
    const imported = await mp.evaluate(async () => { const v = window.__sv.vault.vault; const fs = await v.files(); const f = fs.find(x => x.path === "note.txt"); return { root: v.root.name, n: fs.length, v1: new TextDecoder().decode(await v.versionBytes(f.id, 1)), ok: (await v.verify()).missing.length === 0 }; });
    // Storage report and purge from the tab.
    await mp.click('#vault-panel [data-a="storage"]');
    await mp.waitForSelector("#vault-dlg tbody tr");
    const rep = await mp.evaluate(() => [...document.querySelectorAll("#vault-dlg tbody tr")].map(r => [...r.cells].map(c => c.textContent).join(":")).join("|"));
    await mp.fill('#vault-dlg [name="keep"]', "1");
    await mp.click('#vault-dlg button[value="purge"]');
    await mp.waitForSelector("#confirm[open]");
    await mp.click('#confirm [data-a="ok"]');
    // The purge ends with a toast (or an error toast); reading storage while it still writes would race it.
    await mp.waitForFunction(() => [...document.querySelectorAll("#toasts .toast")].some(x => /Purged|error/i.test(x.textContent)), null, { polling: 100, timeout: 20000 }).catch(() => {});
    const toasts = await mp.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(x => x.textContent).join(" / "));
    const after = await mp.evaluate(async () => (await window.__sv.vault.vault.storage()).map(r => `${r.path}:${r.kept}/${r.versions}:${r.bytes}`).join("|")) + ` [${toasts}]`;
    check(name === "Backup test.mcadvault.zip" && imported.root === "Backup test (2)" && imported.n === 2 && imported.v1 === "v1" && imported.ok, `vault 1.40: export to ZIP and import as a new vault (${name}, ${JSON.stringify(imported)})`);
    check(rep === "note.txt:3:3:6 B|spec.pdf:1:1:4 B" && after.startsWith("note.txt:1/3:2|spec.pdf:1/1:4 "), `vault 1.40: storage report and purge old versions (${rep} → ${after})`);
    await ctx.close();
  }

  // --- Drawings (FRS 11, FR-DRW-001/002/003/010/011/016/030/031): standard 3 views, model and projected views, drag, title block, export, .mcaddrw, associative update, RU, axe ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwblock", name: "Block", units: { length: "mm", decimals: 2 }, props: { partNumber: "BLK-001" }, material: { name: "Steel", density: 7.85 }, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [P("c0", 10, 0), { id: "c1", t: "circle", c: "c0", r: 8 }] },
      { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-07T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Block.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const views = () => dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.map(v => ({ id: v.id, x: v.x, y: v.y, side: v.side ?? null, orient: v.orient ?? null, style: v.style ?? null })));
    const box = id => dp.evaluate(i => window.__sv.drw.placement(i).box.map(v => Math.round(v * 1000) / 1000), id);
    const v3 = await views();
    const sheet = await dp.evaluate(() => { const s = window.__sv.drw.doc().sheets[0]; return `${s.size} ${s.scale.join(":")} ${s.projection} ${s.format}`; });
    const fb = await box(v3[0].id);
    const prims = await dp.evaluate(() => { const p = window.__sv.drw.prims(); return { hidden: p.filter(x => x.layer === "HIDDEN").length, circles: p.filter(x => x.t === "a" && x.layer === "VISIBLE" && Math.abs(x.r - 8) < 1e-6).length, text: p.filter(x => x.t === "t").map(x => x.s) }; });
    check(sheet === "A3 1:1 first iso" && v3.length === 3 && fb.join(",") === "-50,0,50,20" && v3[1].x === v3[0].x && v3[1].y < v3[0].y && v3[2].y === v3[0].y && v3[2].x > v3[0].x,
      `drawing: new drawing of a part gets the standard 3 views, lined up in first angle, at 1:1 on A3 (${sheet}, ${JSON.stringify(v3)}, front ${fb})`);
    check(prims.hidden === 4 && prims.circles === 1 && prims.text.includes("BLK-001") && prims.text.includes("Steel") && prims.text.includes("0.910 kg") && prims.text.includes("1:1"),
      `drawing: exact HLR lines (hidden hole edges dashed, the hole a true circle) and title block from the part (number, material, mass) (${prims.hidden} hidden, ${prims.circles} circle, ${prims.text.filter(s => /BLK|Steel|kg/.test(s)).join(" / ")})`);
    // Drag the front view: its projected views follow; a projected view only slides along its alignment.
    const pt = (x, y) => dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]);
    let [sx, sy] = await pt(v3[0].x, v3[0].y + 9);
    let [ex, ey] = await pt(v3[0].x - 20, v3[0].y + 9 + 15);
    await dp.mouse.move(sx, sy); await dp.mouse.down(); await dp.mouse.move((sx + ex) / 2, (sy + ey) / 2); await dp.mouse.move(ex, ey); await dp.mouse.up();
    const moved = await views();
    [sx, sy] = await pt(moved[2].x, moved[2].y);
    [ex, ey] = await pt(moved[2].x + 10, moved[2].y + 30);
    await dp.mouse.move(sx, sy); await dp.mouse.down(); await dp.mouse.move(ex, ey); await dp.mouse.up();
    const slid = await views();
    const d = (a, b) => [Math.round(b.x - a.x), Math.round(b.y - a.y)].join(",");
    const flat = (a, b) => Math.abs(b.y - a.y) < 1e-9;
    check(d(v3[0], moved[0]) === "-20,15" && d(v3[1], moved[1]) === "-20,15" && d(v3[2], moved[2]) === "-20,15" && d(moved[2], slid[2]) === "10,0" && flat(moved[2], slid[2]),
      `drawing: dragging the parent moves its projected views; a side view only slides sideways (${d(v3[0], moved[0])} ${d(v3[1], moved[1])} ${d(v3[2], moved[2])}, side ${d(moved[2], slid[2])})`);
    await dp.keyboard.press("Control+z"); await dp.keyboard.press("Control+z");
    const undone = await views();
    check(undone.length === 3 && d(v3[0], undone[0]) === "0,0" && d(v3[2], undone[2]) === "0,0", "drawing: Ctrl+Z undoes the moves");
    // Model view ▾ Isometric: the preview follows the cursor; the click places it, then projected views come off it.
    await dp.click('#drw [data-a="model"]');
    await dp.click('#drw [data-orient="iso"]');
    [sx, sy] = await pt(330, 220);
    await dp.mouse.move(sx, sy); await dp.mouse.move(sx + 3, sy + 3);
    await dp.waitForFunction(() => document.querySelectorAll("#drw .drw-preview line, #drw .drw-preview path, #drw .drw-preview circle").length > 5, null, { timeout: 30000 });
    await dp.mouse.click(sx, sy);
    const [rx, ry] = await pt(390, 220);
    await dp.mouse.move(rx, ry); await dp.mouse.click(rx, ry);
    await dp.keyboard.press("Escape");
    await ready();
    const v5 = await views();
    const iso = v5.find(v => v.orient === "iso"), isoKid = v5.find(v => v.side && v.side[0] === 1 && iso && v.y === iso.y && v.x > iso.x);
    check(v5.length === 5 && iso?.style === "hlr" && !!isoKid, `drawing: model view (isometric, hidden lines removed) placed with a live preview, then a projected view off it (${JSON.stringify(v5.slice(3))})`);
    // Exports: SVG, DXF (layers with linetypes) and PDF; then save the drawing.
    const grab = async x => {
      await dp.click('#drw [data-a="export"]');
      const [dl] = await Promise.all([dp.waitForEvent("download"), dp.click(`#drw [data-x="${x}"]`)]);
      return { name: dl.suggestedFilename(), data: await readFile(await dl.path()) };
    };
    const svg = await grab("svg"), dxf = await grab("dxf"), pdf = await grab("pdf");
    const dxfT = dxf.data.toString();
    check(svg.name === "Block-Sheet1.svg" && /width="420mm" height="297mm"/.test(svg.data.toString()) && dxf.name === "Block-Sheet1.dxf" && /AC1009/.test(dxfT) && /\nHIDDEN\n/.test(dxfT) && /\nLTYPE\n/.test(dxfT) && pdf.name === "Block.pdf" && pdf.data.subarray(0, 4).toString() === "%PDF" && pdf.data.length > 20000,
      `drawing: export SVG (sheet size in mm), DXF R12 with line-type layers, PDF with the font embedded (${svg.name}, ${dxf.name} ${dxf.data.length} B, ${pdf.name} ${pdf.data.length} B)`);
    const [sv] = await Promise.all([dp.waitForEvent("download"), dp.keyboard.press("Control+s")]);
    const drwBytes = await readFile(await sv.path());
    // Associative: a change in the part updates the drawing's views.
    await dp.click('#drw [data-a="back"]');
    await dp.evaluate(() => window.__sv.modeller.store.change("Width", d => { const e = d.features[0].ents; e[1].x = 70; e[2].x = 70; }));
    await dp.waitForFunction(() => document.querySelector("#mc-busy").hidden, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForTimeout(400);
    await ready();
    const fb2 = await box(v3[0].id);
    check(sv.suggestedFilename() === "Block.mcaddrw" && drwBytes.readUInt32LE(0) === 0x04034b50 && fb2.join(",") === "-50,0,70,20", `drawing: Ctrl+S saves ${sv.suggestedFilename()}; the views follow a change of the part (front ${fb2})`);
    // Russian: nothing left in English in the drawing workspace; axe on it.
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.waitForTimeout(200);
    const left = await dp.evaluate(() => {
      const OK = /^(MöbiusCAD|ISO|ANSI|Y14|PDF|SVG|DXF|PNG|dpi|GOST|Ctrl|Esc|Delete|mcaddrw|mm|kg|F|A\d|B|C|D|E|S|Z|Y|P)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      const root = document.querySelector("#drw");
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (!skip(n.parentElement)) test(n.data, "text");
      for (const e of root.querySelectorAll("[title], [aria-label], [placeholder]")) { if (skip(e)) continue; for (const a of ["title", "aria-label", "placeholder"]) { const v = e.getAttribute(a); if (v) test(v, a); } }
      return [...bad];
    });
    const ruSheet = await dp.evaluate(() => window.__sv.drw.prims().filter(x => x.t === "t").map(x => x.s));
    check(left.length === 0 && ruSheet.includes("Разработал") && ruSheet.includes("Проецирование по первому углу"), `drawing: Russian workspace and title block labels${left.length ? ": " + left.slice(0, 6).join(" | ") : ""}`);
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.addScriptTag({ content: await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8") });
    const ax = await dp.evaluate(async () => (await window.axe.run(document.querySelector("#drw"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", ")}`));
    check(ax.length === 0, `drawing: 0 WCAG 2.1 AA violations in the workspace${ax.length ? ": " + ax.join(" | ") : ""}`);
    // Reopen the saved file in a fresh page: the drawing (with its part inside) comes back.
    const dp2 = await ctx.newPage();
    dp2.on("pageerror", e => errors.push(e.message));
    await dp2.goto(`${origin}/index.html?debug`);
    await dp2.waitForFunction(() => window.__sv);
    await dp2.setInputFiles("#file-input", { name: "Block.mcaddrw", mimeType: "application/zip", buffer: drwBytes });
    await dp2.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 5 && window.__sv.drw.ready(), null, { timeout: 90000 });
    const reb = await dp2.evaluate(() => ({ open: !document.querySelector("#drw").hidden, name: document.querySelector("#drw .drw-name").textContent }));
    check(reb.open && reb.name === "Block.mcaddrw", `drawing: a saved .mcaddrw opens with its views (${JSON.stringify(reb)})`);
    await ctx.close();
  }

  // --- Drawings: section, detail and auxiliary views (FR-DRW-012/013/014, AT-P5-2) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwsec", name: "Block", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [P("c0", 10, 0), { id: "c1", t: "circle", c: "c0", r: 8 }] },
      { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-07T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Block.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const views = () => dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.map(v => JSON.parse(JSON.stringify(v))));
    const [front, top] = await views();
    // Sheet point of a model point (u, w) of a view, then the screen point.
    const at = (id, u, w) => dp.evaluate(([i, a, b]) => { const p = window.__sv.drw.placement(i); return window.__sv.drw.sheetPt(p.x + (a - p.uc) * p.s, p.y + (b - p.vc) * p.s); }, [id, u, w]);
    const scr = (x, y) => dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]);
    // Section ▾ Vertical: the cutting line follows the cursor over the front view; click through the hole, place the view on the left.
    await dp.click('#drw [data-a="section"]'); await dp.click('#drw [data-cut="v"]');
    let [x, y] = await at(front.id, 10, 5);
    await dp.mouse.move(x - 5, y); await dp.mouse.move(x, y);
    const cutPreview = await dp.evaluate(() => document.querySelectorAll("#drw .drw-cut").length);
    await dp.mouse.click(x, y);
    [x, y] = await scr(front.x - 110, front.y + 25);
    await dp.mouse.move(x + 5, y); await dp.mouse.move(x, y);
    await dp.waitForFunction(() => document.querySelectorAll("#drw .drw-preview line").length > 10, null, { timeout: 30000 });
    await dp.mouse.click(x, y);
    await ready();
    let vs = await views();
    const sec = vs.find(v => v.kind === "section");
    const secProj = await dp.evaluate(i => window.__sv.drw.proj(i), sec?.id);
    const area = l => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return a / 2; };
    const cutArea = (secProj?.cut ?? []).reduce((t, l) => t + Math.abs(area(l)), 0);
    let prims = await dp.evaluate(() => window.__sv.drw.prims().map(p => ({ t: p.t, layer: p.layer, s: p.s, r: p.r, pen: p.pen })));
    const hatchN = prims.filter(p => p.layer === "HATCH").length, texts = prims.filter(p => p.t === "t").map(p => p.s);
    check(cutPreview > 0 && sec && sec.letter === "A" && sec.look === -1 && Math.abs(sec.line[0] - 10) < 0.05 && sec.line[0] === sec.line[2] && Math.abs(sec.y - front.y) < 0.02 && sec.x < front.x,
      `drawing: section view from a vertical cutting line through the hole, placed on the left and lined up with the front view (${JSON.stringify(sec && { line: sec.line, look: sec.look, x: sec.x, y: sec.y })}, front ${front.x},${front.y})`);
    check(Math.abs(cutArea - (60 * 20 - 16 * 20)) < 0.5 && hatchN > 20 && texts.includes("SECTION A-A") && prims.filter(p => p.t === "t" && p.layer === "ANNOT" && p.s === "A").length === 2 && prims.some(p => p.layer === "ANNOT" && p.pen === "center"),
      `drawing: section A-A is hatched over the cut faces (area ${cutArea.toFixed(2)} mm² = 60×20 − 16×20), with its label and a lettered cutting line on the front view (${hatchN} hatch lines)`);
    // Drag: the section view only slides along its viewing direction. Flip: it looks the other way and moves to the other side.
    [x, y] = await scr(sec.x, sec.y);
    const [ex, ey] = await scr(sec.x - 10, sec.y + 20);
    await dp.mouse.move(x, y); await dp.mouse.down(); await dp.mouse.move((x + ex) / 2, (y + ey) / 2); await dp.mouse.move(ex, ey); await dp.mouse.up();
    vs = await views();
    const dragged = vs.find(v => v.id === sec.id);
    await dp.click('#drw [data-a="flip"]');
    await ready();
    vs = await views();
    const flipped = vs.find(v => v.id === sec.id);
    check(Math.round(dragged.x - sec.x) === -10 && Math.abs(dragged.y - sec.y) < 1e-9 && flipped.look === 1 && flipped.x > front.x && Math.abs(flipped.y - sec.y) < 1e-9,
      `drawing: a section view slides only along its direction; Flip direction puts it on the other side (${dragged.x - sec.x},${dragged.y - sec.y}; flipped x ${flipped.x}, look ${flipped.look})`);
    await dp.keyboard.press("Control+z");
    // Detail: centre on the hole in the top view (it snaps to the circle's centre), radius 15, then place: 2:1, clipped, with its circle and label.
    await dp.click('#drw [data-a="detail"]'); await dp.click('#drw [data-det="circle"]');
    [x, y] = await at(top.id, 10.6, 0.5);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top.id, 25, 0);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await scr(330, 230);
    await dp.mouse.move(x + 4, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await ready();
    vs = await views();
    const det = vs.find(v => v.kind === "detail");
    prims = await dp.evaluate(() => window.__sv.drw.prims().map(p => ({ t: p.t, layer: p.layer, s: p.s, r: p.r, pen: p.pen })));
    const detTexts = prims.filter(p => p.t === "t").map(p => p.s);
    check(det && det.letter === "B" && det.parent === top.id && det.c.join(",") === "10,0" && Math.abs(det.r - 15) < 0.05 && prims.some(p => p.t === "a" && p.layer === "VISIBLE" && Math.abs(p.r - 16) < 1e-6) && detTexts.includes("DETAIL B") && detTexts.includes("Scale 2:1") && detTexts.includes("B"),
      `drawing: detail view B of the hole at 2:1 (centre snapped, circle Ø32 on the sheet, label and circle on the parent) (${JSON.stringify(det && { c: det.c, r: det.r })})`);
    // Auxiliary: click the front view's top edge, place the view above it, square to the edge.
    await dp.click('#drw [data-a="aux"]');
    [x, y] = await at(front.id, -30, 20);
    await dp.mouse.move(x, y + 2); await dp.mouse.move(x, y);
    const edgeHi = await dp.evaluate(() => document.querySelectorAll("#drw .drw-edge").length);
    await dp.mouse.click(x, y);
    [x, y] = await scr(front.x + 30, front.y + 55);
    await dp.mouse.move(x, y + 3); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await ready();
    vs = await views();
    const aux = vs.find(v => v.kind === "aux");
    const auxBox = aux && await dp.evaluate(i => window.__sv.drw.placement(i).box.map(v => Math.round(v * 1000) / 1000), aux.id);
    check(edgeHi === 1 && aux && aux.letter === "C" && aux.look === 1 && Math.abs(aux.x - front.x) < 0.02 && aux.y > front.y && auxBox && Math.round(auxBox[2] - auxBox[0]) === 100 && Math.round(auxBox[3] - auxBox[1]) === 60,
      `drawing: auxiliary view C square to a picked edge, lined up with its parent (${JSON.stringify(aux && { x: aux.x, y: aux.y, look: aux.look })}, box ${auxBox})`);
    // 1.114.0 offset section (FR-DRW-012): a path on the top view at y = 10 left of x = 0, a step down to y = 0, then through the hole.
    await dp.click('#drw [data-a="section"]'); await dp.click('#drw [data-cut="off"]');
    for (const [u, w] of [[-45, 10], [0, 10], [0, 0], [45, 0]]) { [x, y] = await at(top.id, u, w); await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y); }
    const pathPreview = await dp.evaluate(() => document.querySelectorAll("#drw polyline.drw-cut").length);
    await dp.mouse.click(x, y);
    [x, y] = await scr(top.x, top.y - 75);
    await dp.mouse.move(x + 5, y); await dp.mouse.move(x, y);
    await dp.waitForFunction(() => document.querySelectorAll("#drw .drw-preview line").length > 10, null, { timeout: 30000 });
    await dp.mouse.click(x, y);
    await ready();
    vs = await views();
    const off = vs.find(v => v.kind === "section" && v.path);
    const offProj = off && await dp.evaluate(i => window.__sv.drw.proj(i), off.id);
    const offArea = (offProj?.cut ?? []).reduce((t, l) => t + Math.abs(area(l)), 0);
    prims = await dp.evaluate(() => window.__sv.drw.prims().map(p => ({ t: p.t, layer: p.layer, s: p.s, pen: p.pen })));
    check(pathPreview === 1 && off && off.path.length === 8 && off.letter === "D" && Math.abs(offArea - (50 * 20 + (50 - 16) * 20)) < 0.5 && prims.filter(p => p.t === "t" && p.layer === "ANNOT" && p.s === "D").length === 2,
      `drawing: offset section D through two planes, both hatched (area ${offArea.toFixed(2)} mm² = 50×20 + 34×20; path ${JSON.stringify(off?.path)})`);
    // Aligned section (FR-DRW-012): first leg along −x on the top view, centre at the origin, second leg up +y; it turns into the first leg's plane.
    await dp.click('#drw [data-a="section"]'); await dp.click('#drw [data-cut="aligned"]');
    for (const [u, w] of [[-45, 0], [0, 0], [0, 25]]) { [x, y] = await at(top.id, u, w); await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y); }
    [x, y] = await scr(top.x, top.y - 75);
    await dp.mouse.move(x + 5, y); await dp.mouse.move(x, y);
    await dp.waitForFunction(() => document.querySelectorAll("#drw .drw-preview line").length > 10, null, { timeout: 30000 });
    await dp.mouse.click(x, y);
    await ready();
    vs = await views();
    const alv = vs.find(v => v.kind === "section" && v.aligned);
    const alProj = alv && await dp.evaluate(i => window.__sv.drw.proj(i), alv.id);
    const alArea = (alProj?.cut ?? []).reduce((t, l) => t + Math.abs(area(l)), 0);
    prims = await dp.evaluate(() => window.__sv.drw.prims().map(p => ({ t: p.t, layer: p.layer, s: p.s, pen: p.pen })));
    check(alv && alv.path.length === 6 && alv.letter === "E" && Math.abs(alArea - (50 * 20 + 30 * 20)) < 0.5 && prims.filter(p => p.t === "t" && p.layer === "ANNOT" && p.s === "E").length === 2,
      `drawing: aligned section E, the second leg turned into the first leg's plane (area ${alArea.toFixed(2)} mm² = 50×20 + 30×20; path ${JSON.stringify(alv?.path)})`);
    // Detail profile (FR-DRW-013): four corners round the hole on the top view, closed by clicking the first again.
    await dp.click('#drw [data-a="detail"]'); await dp.click('#drw [data-det="profile"]');
    for (const [u, w] of [[0, -12], [22, -12], [22, 12], [5, 12], [0, -12]]) { [x, y] = await at(top.id, u, w); await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y); }
    [x, y] = await scr(330, 170);
    await dp.mouse.move(x + 4, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await ready();
    vs = await views();
    const pdet = vs.find(v => v.kind === "detail" && v.outline);
    const pprims = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "ANNOT" && p.t === "p" && p.closed && p.p.length === 8).length);
    const ptexts = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t").map(p => p.s));
    check(pdet && pdet.outline.length === 8 && pdet.letter === "F" && pprims >= 2 && ptexts.includes("DETAIL F"),
      `drawing: detail F framed by a clicked profile, outlined on its parent and on the view (${JSON.stringify(pdet?.outline)}, ${pprims} outlines)`);
    // 1.122.0 shaded with edges (FR-DRW-010): select the top view and pick the style; grey triangles under the visible edges.
    [x, y] = await at(top.id, -45, -25);
    await dp.mouse.click(x, y);
    await dp.click('#drw .drw-props [data-style="shadedEdges"]');
    await ready();
    const shadeP = await dp.evaluate(() => { const p = window.__sv.drw.prims(); return { tris: p.filter(q => q.layer === "SHADE").length, greys: new Set(p.filter(q => q.layer === "SHADE").map(q => q.gray)).size, svg: /data-l="SHADE"/.test(window.__sv.drw.svg()), dxf: /\nSHADE\n/.test(window.__sv.drw.dxf()) }; });
    vs = await views();
    check(vs.find(v => v.id === top.id)?.style === "shadedEdges" && shadeP.tris > 20 && shadeP.svg && !shadeP.dxf,
      `drawing: a view shaded with edges draws grey triangles under its lines; DXF leaves the shading out (${JSON.stringify(shadeP)})`);
    // DXF has the hatch on its own layer; Russian labels; a saved drawing keeps the views.
    await dp.click('#drw [data-a="export"]');
    const [dl] = await Promise.all([dp.waitForEvent("download"), dp.click('#drw [data-x="dxf"]')]);
    const dxfT = (await readFile(await dl.path())).toString();
    // DXF 2000 (FR-DRW-030): AC1015 with handles, LWPOLYLINE and the same layers; Cyrillic kept as \U+ escapes.
    await dp.click('#drw [data-a="export"]');
    const [dl2] = await Promise.all([dp.waitForEvent("download"), dp.click('#drw [data-x="dxf2000"]')]);
    const dxf2 = (await readFile(await dl2.path())).toString();
    check(/\nAC1015\n/.test(dxf2) && /\nLWPOLYLINE\n/.test(dxf2) && /\nHATCH\n/.test(dxf2) && /\*Model_Space/.test(dxf2) && !/[^\x00-\x7f]/.test(dxf2),
      `drawing: DXF 2000 export (AC1015, LWPOLYLINE, HATCH layer, ASCII only; ${dxf2.length} bytes)`);
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.waitForTimeout(200);
    const ru = await dp.evaluate(() => ({ t: window.__sv.drw.prims().filter(x => x.t === "t").map(x => x.s), tb: document.querySelector('#drw [data-a="section"]').textContent }));
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    check(/\nHATCH\n/.test(dxfT) && ru.t.includes("A-A") && ru.t.includes("Масштаб 2:1") && /Сечение/.test(ru.tb), `drawing: DXF hatch layer; Russian section/detail labels (${ru.t.filter(s => /^[A-C]/.test(s) || /Масштаб/.test(s)).join(" / ")}, ${ru.tb.trim()})`);
    await ctx.close();
  }

  // --- Drawings: dimensions, model items, hole callouts, centre marks, notes (FR-DRW-020..023, AT-P5-1/3) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwdim", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }],
        dims: [{ id: "d1", name: "D1", t: "hdistance", e: ["p1", "p2"], val: { v: 100 } }, { id: "d2", name: "D2", t: "vdistance", e: ["p2", "p3"], val: { v: 60 } }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [{ id: "d3", name: "D3", t: "diameter", e: ["c1"], val: { v: 16 } }], ents: [P("c0", 10, 0), { id: "c1", t: "circle", c: "c0", r: 8 }] },
      { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Plate.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const [front, top] = await dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.map(v => ({ id: v.id, x: v.x, y: v.y })));
    const at = (id, u, w) => dp.evaluate(([i, a, b]) => { const p = window.__sv.drw.placement(i); return window.__sv.drw.sheetPt(p.x + (a - p.uc) * p.s, p.y + (b - p.vc) * p.s); }, [id, u, w]);
    const prims = () => dp.evaluate(() => window.__sv.drw.prims().map(p => ({ t: p.t, layer: p.layer, s: p.s, pen: p.pen })));
    const texts = async () => (await prims()).filter(p => p.t === "t" && p.layer === "ANNOT").map(p => p.s);
    const annots = () => dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).map(a => JSON.parse(JSON.stringify(a))));
    let pr = await prims();
    const centre = pr.filter(p => p.layer === "CENTER" && p.pen === "center").length;
    check(centre === 4, `drawing: centre marks on the hole seen end-on and centrelines on it from the front and the side (${centre} centre lines)`);
    // Model items: the sketch's 100 and 60 and the Ø16 go to the top view, the extrude depth 20 to the front.
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="items"]');
    await dp.waitForTimeout(150);
    let an = await annots();
    let tx = await texts();
    const where = an.map(a => `${a.src}@${a.view === front.id ? "front" : a.view === top.id ? "top" : "?"}`).sort().join(" ");
    check(an.length === 4 && where === "f1:depth@front s1:d1@top s1:d2@top s2:d3@top" && ["100", "60", "Ø16", "20"].every(s => tx.includes(s)),
      `drawing: model items imported once each into the view where they read best (${where}; ${tx.join(" ")})`);
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="items"]');
    await dp.waitForTimeout(150);
    check((await annots()).length === 4, "drawing: model items are not inserted twice");
    // Smart dimension: the front view's top edge, placed above it, is a horizontal 100; the hole's circle gives Ø16.
    await dp.click('#drw [data-a="dim"]');
    let [x, y] = await at(front.id, -20, 20);
    await dp.mouse.move(x, y + 3); await dp.mouse.move(x, y);
    const hov = await dp.evaluate(() => document.querySelectorAll("#drw .drw-edge").length);
    await dp.mouse.click(x, y);
    [x, y] = await at(front.id, 0, 38);
    await dp.mouse.move(x + 3, y); await dp.mouse.move(x, y);
    const pv = await dp.evaluate(() => document.querySelectorAll("#drw .drw-preview text").length);
    await dp.mouse.click(x, y);
    [x, y] = await at(top.id, 18, 0);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top.id, 30, 25);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await dp.keyboard.press("Escape");
    an = await annots();
    const smart = an.filter(a => !a.src);
    tx = await texts();
    check(hov >= 1 && pv >= 1 && smart.length === 2 && smart[0].k === "h" && smart[0].view === front.id && smart[1].k === "dia" && tx.filter(s => s === "100").length === 2 && tx.filter(s => s === "Ø16").length === 2,
      `drawing: Smart dimension: an edge placed above it gives a horizontal 100, a circle gives Ø16, with a live preview (${JSON.stringify(smart.map(a => a.k))}, ${tx.join(" ")})`);
    // Select the 100 by its text and give it a ± tolerance.
    [x, y] = await at(front.id, 0, 40.5);
    await dp.mouse.click(x, y);
    const selA = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-tolt="sym"]'));
    if (selA) await dp.click('#drw [data-tolt="sym"]');
    tx = await texts();
    check(selA && tx.includes("100±0.1"), `drawing: a dimension selected by its text takes a ± tolerance (${tx.filter(s => /±/.test(s)).join(" ")})`);
    // ISO 286 fit (FR-DRW-021): the Ø16 takes H7, shown with its deviations from the table (+0.018 / 0).
    const dia = await dp.evaluate(() => { const p = window.__sv.drw.prims().find(q => q.t === "t" && q.layer === "ANNOT" && q.s === "Ø16"); return p && [p.x, p.y + p.h / 2]; });
    [x, y] = await dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), dia);
    await dp.mouse.click(x, y);
    const fitOk = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-tolt="fit"]'));
    if (fitOk) { await dp.click('#drw [data-tolt="fit"]'); await dp.selectOption('#drw .drw-props [data-d="fshow"]', "both"); }
    tx = await texts();
    const fitNote = await dp.evaluate(() => document.querySelector("#drw .drw-fitlim")?.textContent ?? "");
    check(fitOk && tx.includes("Ø16H7") && tx.includes("+0.018") && fitNote.includes("H7: +0.018 / 0"),
      `drawing: a diameter takes the H7 fit with its ISO 286 deviations (${tx.filter(s => /H7|0\.018/.test(s)).join(" ")}; ${fitNote})`);
    // The deviations start right of the drawn "Ø16H7", measured on the rendered glyphs (exam bug 39). The screen font may not be
    // DejaVu (exports embed it), and glyph boxes include side bearings, so a sliver under 0.15·h counts as clear; the bug was ~1·h.
    const devGap = await dp.evaluate(() => { const els = [...document.querySelectorAll("#drw svg text")], r = s => els.find(e => e.textContent === s)?.getBoundingClientRect(); const m = r("Ø16H7"), u = r("+0.018"), l = [...els].filter(e => e.textContent === "0").map(e => e.getBoundingClientRect()).find(q => m && Math.abs(q.left - u.left) < 2); return m && u ? { gap: +(u.left - m.right).toFixed(1), lo: l ? +(l.left - m.right).toFixed(1) : null, h: +m.height.toFixed(1) } : null; });
    check(devGap && devGap.gap > -0.15 * devGap.h && (devGap.lo === null || devGap.lo > -0.15 * devGap.h), `drawing: fit deviations clear the dimension text (${JSON.stringify(devGap)})`);
    // Hole callout and a note.
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="hole"]');
    [x, y] = await at(top.id, 10, -8);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top.id, 40, -45);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    dp.once("dialog", d => d.accept("BREAK SHARP EDGES"));
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="note"]');
    [x, y] = await dp.evaluate(() => window.__sv.drw.sheetPt(40, 60));
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await dp.waitForTimeout(150);
    tx = await texts();
    an = await annots();
    check(tx.includes("Ø16 THRU") && tx.includes("BREAK SHARP EDGES") && an.some(a => a.t === "hole") && an.some(a => a.t === "note" && !a.view),
      `drawing: hole callout from the model (Ø16 THRU) and a note on the sheet (${tx.filter(s => /THRU|BREAK/.test(s)).join(" / ")})`);
    // Property link in a note (FR-DRW-023): $PRP:"Scale" shows the sheet scale.
    dp.once("dialog", d => d.accept('SCALE $PRP:"Scale"'));
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="note"]');
    [x, y] = await dp.evaluate(() => window.__sv.drw.sheetPt(40, 75));
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await dp.waitForTimeout(150);
    tx = await texts();
    const scaleNote = tx.find(s => s.startsWith("SCALE "));
    check(scaleNote && !scaleNote.includes("$PRP") && /^SCALE \d+:\d+$/.test(scaleNote), `drawing: a note's $PRP:"Scale" link shows the sheet scale (${scaleNote})`);
    // Ordinate and chain dimensions (FR-DRW-021): base corner, hole centre, far corner; one click adds each dimension.
    const clicks = async (id, pts) => { for (const [u, w] of pts) { const [cx, cy] = await at(id, u, w); await dp.mouse.move(cx + 2, cy); await dp.mouse.move(cx, cy); await dp.mouse.click(cx, cy); } };
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="ord"]');
    await clicks(top.id, [[-50, -30], [10, 0], [50, -30]]);
    await dp.keyboard.press("Escape");
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="chain"]');
    await clicks(top.id, [[-50, 30], [10, 0], [50, 30]]);
    await dp.keyboard.press("Escape");
    an = await annots();
    tx = await texts();
    const ords = an.filter(a => a.k === "oh").length, chain = an.filter(a => !a.src && a.k === "h" && a.view === top.id).length;
    check(ords === 3 && chain === 2 && tx.includes("0") && tx.includes("40") && tx.filter(s => s === "60").length >= 3,
      `drawing: ordinate dimensions 0 / 60 / 100 from the base corner and a chain 60 + 40 along the top edge (${ords} ordinates, ${chain} chain; ${tx.join(" ")})`);
    // Hole table (FR-DRW-024): origin at the corner, the Ø16 hole tagged A1 at X 60 / Y 30, the table placed below the view.
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="htable"]');
    await clicks(top.id, [[-50, -30], [-50, -60]]);
    tx = await texts();
    const htab = (await annots()).find(a => a.t === "htable");
    check(!!htab && htab.holes.length === 1 && ["Tag", "X LOC", "Size", "Ø16 THRU"].every(s => tx.includes(s)) && tx.filter(s => s === "A1").length === 2 && tx.includes("30"),
      `drawing: hole table lists the hole from the origin and tags it on the view (${tx.filter(s => /^(Tag|A1|Ø16|30|60)/.test(s)).join(" ")})`);
    if (process.env.SMOKE_SHOTS) await dp.screenshot({ path: `${process.env.SMOKE_SHOTS}/drawing-dims.png` });
    // Exports carry the annotations; Russian uses the decimal comma.
    const svgT = await dp.evaluate(() => window.__sv.drw.svg());
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.waitForTimeout(200);
    const ru = await texts();
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    check(/100±0\.1/.test(svgT) && /data-l="CENTER"/.test(svgT) && ru.includes("100±0,1") && ru.some(s => /^Ø16 /.test(s) && !/THRU/.test(s)), `drawing: SVG export has the dimensions and centre lines; Russian uses the decimal comma (${ru.filter(s => /±|Ø16 /.test(s)).join(" / ")})`);
    // Associative (AT-P5-3): the part gets 20 mm wider; the dimensions find their edges again and read 120.
    await dp.click('#drw [data-a="back"]');
    await dp.evaluate(() => window.__sv.modeller.store.change("Width", d => { const e = d.features[0].ents; e[1].x = 70; e[2].x = 70; }));
    await dp.waitForFunction(() => document.querySelector("#mc-busy").hidden, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForTimeout(400);
    await ready();
    tx = await texts();
    check(tx.includes("120±0.1") && tx.includes("120") && !tx.includes("?"), `drawing: after the part changes, the dimensions re-attach and update (${tx.filter(s => /^1[02]0/.test(s)).join(" ")})`);
    await ctx.close();
  }

  // --- Drawings: GD&T, datums, surface finish, tables, GOST, PNG, dangling warning (FR-DRW-023/024/026/031) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwgdt", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [P("c0", 10, 0), { id: "c1", t: "circle", c: "c0", r: 8 }] },
      { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Plate.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const [front, top] = await dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.map(v => ({ id: v.id })));
    const at = (id, u, w) => dp.evaluate(([i, a, b]) => { const p = window.__sv.drw.placement(i); return window.__sv.drw.sheetPt(p.x + (a - p.uc) * p.s, p.y + (b - p.vc) * p.s); }, [id, u, w]);
    const texts = async () => (await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT").map(p => p.s)));
    const annots = () => dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).map(a => JSON.parse(JSON.stringify(a))));
    const tool = async an => { await dp.click('#drw [data-a="annot"]'); await dp.click(`#drw [data-an="${an}"]`); };
    const click = async (id, u, w) => { const [x, y] = await at(id, u, w); await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y); };
    // Geometric tolerance with a leader to the front view's top edge: a perpendicularity frame to datum A.
    await tool("gtol");
    await click(front.id, -30, 20);
    const [gx, gy] = await at(front.id, -40, 45);
    await dp.mouse.move(gx, gy); await dp.mouse.click(gx, gy);
    // Datum A on the bottom edge, the letter below; a datum on the hole's circle in the top view.
    await tool("datum");
    await click(front.id, -20, 0);
    await click(front.id, -20, -15);
    await tool("datum");
    await click(top.id, 18, 0);
    await click(top.id, 35, 20);
    // Surface finish right on the top edge.
    await tool("surf");
    await click(front.id, 35, 20);
    await click(front.id, 35, 20);
    let an = await annots(), tx = await texts();
    const g = an.find(a => a.t === "gtol"), ds = an.filter(a => a.t === "datum").map(a => a.letter).join(""), sf = an.find(a => a.t === "surf");
    check(g?.leader && g.view === front.id && g.rows[0].sym === "perp" && ds === "AB" && sf?.ref && tx.includes("0.05") && tx.includes("A") && tx.includes("B") && tx.includes("Ra 3.2"),
      `drawing: tolerance frame with a leader, datums A and B, surface finish on an edge (${JSON.stringify({ g: g?.rows, ds, sf: !!sf?.ref })}; ${tx.join(" ")})`);
    // The frame's properties: a Ø zone, (M) and a second row.
    await dp.mouse.move(gx + 8, gy + 4); await dp.mouse.click(gx + 8, gy + 4);
    const gsel = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-grow="+"]'));
    if (gsel) {
      await dp.selectOption('#drw [data-d="g:0:sym"]', "pos");
      await dp.check('#drw [data-d="g:0:dia"]');
      await dp.selectOption('#drw [data-d="g:0:mod"]', "M");
      await dp.click('#drw [data-grow="+"]');
    }
    an = await annots(); tx = await texts();
    const g2 = an.find(a => a.t === "gtol");
    check(gsel && g2.rows.length === 2 && g2.rows[0].sym === "pos" && g2.rows[0].dia && tx.includes("Ø0.05") && tx.includes("M"), `drawing: tolerance frame edited: position, Ø, (M), second row (${JSON.stringify(g2?.rows)})`);
    // Revision table at the frame's top-right corner, then a second revision B.
    await tool("rev");
    await dp.waitForTimeout(100);
    if (await dp.$('#drw [data-trow="+"]')) await dp.click('#drw [data-trow="+"]');
    an = await annots(); tx = await texts();
    const rt = an.find(a => a.t === "table");
    check(rt?.kind === "rev" && rt.rows.length === 2 && rt.rows[1][0] === "B" && tx.includes("REVISIONS") && tx.includes("Description"), `drawing: revision table with revisions A and B (${JSON.stringify(rt?.rows)})`);
    // Russian: the table's headers and title follow the language.
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.waitForTimeout(200);
    const ru = await texts();
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    check(ru.includes("ИЗМЕНЕНИЯ") && ru.includes("Описание"), `drawing: table headers in Russian (${ru.filter(s => /[А-Я]/.test(s)).slice(0, 6).join(" ")})`);
    // GOST 2.104 title block.
    await dp.keyboard.press("Escape");
    const [ex, ey] = await dp.evaluate(() => window.__sv.drw.sheetPt(5, 150));
    await dp.mouse.click(ex, ey);
    const hasFmt = !!(await dp.$('#drw [data-s="format"]'));
    if (hasFmt) await dp.selectOption('#drw [data-s="format"]', "gost");
    const fmt = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "FORMAT").map(p => p.s));
    check(hasFmt && fmt.includes("Developed") && fmt.includes("N. control") && fmt.includes("Lit."), `drawing: GOST 2.104 title block (${fmt.slice(0, 8).join(" | ")})`);
    // PNG at 300 dpi: A3 is 4961 × 3508 px with a pHYs chunk of 11811 px/m.
    const [png] = await Promise.all([dp.waitForEvent("download", { timeout: 60000 }), (async () => { await dp.click('#drw [data-a="export"]'); await dp.click('#drw [data-x="png"]'); })()]);
    const pb = await readFile(await png.path());
    const pw = pb.readUInt32BE(16), ph = pb.readUInt32BE(20), phys = pb.indexOf("pHYs"), ppm = phys > 0 ? pb.readUInt32BE(phys + 4) : 0;
    check(pb.subarray(1, 4).toString() === "PNG" && pw === 4961 && ph === 3508 && ppm === 11811 && pb.length > 50000, `drawing: PNG export at 300 dpi (${pw}×${ph}, ${ppm} px/m, ${pb.length} bytes)`);
    // FR-DRW-026: suppress the hole; the datum on its circle turns into a warning, the rest stays.
    await dp.click('#drw [data-a="back"]');
    await dp.evaluate(() => window.__sv.modeller.store.change("Suppress", d => { d.features[3].suppressed = true; }));
    await dp.waitForFunction(() => document.querySelector("#mc-busy").hidden, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForTimeout(400);
    await ready();
    const dangle = await dp.evaluate(() => document.querySelectorAll("#drw .drw-dangle").length);
    tx = await texts();
    check(dangle === 1 && tx.filter(s => s === "B").length === 2 && tx.includes("Ra 3.2"), `drawing: the datum on the removed hole shows as a warning, the others stay (${dangle} warnings; ${tx.join(" ")})`);
    if (process.env.SMOKE_SHOTS) await dp.screenshot({ path: `${process.env.SMOKE_SHOTS}/drawing-gdt.png` });
    await ctx.close();
  }

  // --- Drawings: assembly drawing, BOM, balloons and auto balloon (FR-DRW-030) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const box = (id, w, h, d) => ({ schema: 1, kind: "part", id, name: id, units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -w / 2, -h / 2), P("p2", w / 2, -h / 2), P("p3", w / 2, h / 2), P("p4", -w / 2, h / 2),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: d } }] });
    const pin = { schema: 1, kind: "part", id: "pin", name: "Pin", units: { length: "mm", decimals: 2 }, props: { partNumber: "PN-7", description: "Dowel pin" }, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("c0", 0, 0), { id: "c1", t: "circle", c: "c0", r: 4 }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 15 } }] };
    const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
    const asmDoc = { schema: 1, kind: "assembly", id: "a_drw", name: "Fixture", units: { length: "mm", decimals: 2 }, parts: {
      plate: { name: "Plate", file: "Plate.mcadprt", doc: box("plate", 100, 60, 20) }, pin: { name: "Pin", file: "Pin.mcadprt", doc: pin } },
      components: [{ id: "c1", name: "Plate<1>", part: "plate", tf: T(0, 0, 0), fixed: true }, { id: "c2", name: "Pin<1>", part: "pin", tf: T(30, 0, 20) }, { id: "c3", name: "Pin<2>", part: "pin", tf: T(-30, 0, 20) }] };
    const amf = { format: "mobiuscad", schema: 1, kind: "assembly", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const ab = zip(Object.entries({ "manifest.json": JSON.stringify(amf), "document.json": JSON.stringify(asmDoc) }));
    await dp.evaluate(b => window.__sv.asm.openFile({ name: "Fixture.mcadasm", data: new Uint8Array(b).buffer }), [...ab]);
    await dp.waitForFunction(() => window.__sv.viewer.parts.length === 3, null, { timeout: 90000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const front = await dp.evaluate(() => window.__sv.drw.doc().sheets[0].views[0].id);
    const top = await dp.evaluate(() => window.__sv.drw.doc().sheets[0].views[1].id);
    const at = (id, u, w) => dp.evaluate(([i, a, b]) => { const p = window.__sv.drw.placement(i); return window.__sv.drw.sheetPt(p.x + (a - p.uc) * p.s, p.y + (b - p.vc) * p.s); }, [id, u, w]);
    const texts = async () => (await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT").map(p => p.s)));
    const annots = () => dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).map(a => JSON.parse(JSON.stringify(a))));
    const tool = async an => { await dp.click('#drw [data-a="annot"]'); await dp.click(`#drw [data-an="${an}"]`); };
    const src = await dp.evaluate(() => window.__sv.drw.doc().source.kind);
    // BOM on the title block: Plate ×1, PN-7 (the pin's part number) ×2.
    await tool("bom");
    await dp.waitForTimeout(150);
    let tx = await texts();
    const bomOk = ["Item", "Part number", "Description", "Qty", "Plate", "PN-7", "Dowel pin"].every(s => tx.includes(s)) && tx.includes("2");
    // Auto balloon on the front view: one balloon per item, numbered 1 and 2.
    await dp.keyboard.press("Escape");
    const [fx, fy] = await at(front, 0, 10);
    await dp.mouse.click(fx, fy);
    await tool("auto");
    await dp.waitForTimeout(300);
    let an = await annots();
    const auto = an.filter(a => a.t === "balloon");
    const autoNums = (await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT" && p.h === 5).map(p => p.s))).sort().join();
    check(src === "asm" && bomOk && auto.length === 2 && auto.every(a => a.view === front) && autoNums === "1,2", `drawing: assembly drawing with a BOM (Plate ×1, PN-7 ×2) and auto balloons 1 and 2 (${src}; ${auto.length} balloons ${autoNums}; ${tx.join(" ")})`);
    // A balloon by hand on a pin's circle in the top view reads 2.
    await tool("balloon");
    let [x, y] = await at(top, 34, 0);
    await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top, 55, 35);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await dp.keyboard.press("Escape");
    an = await annots();
    const hand = an.filter(a => a.t === "balloon" && a.view === top);
    const nums = (await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT" && p.h === 5).map(p => p.s))).sort().join();
    check(hand.length === 1 && hand[0].ref.e.startsWith("c2@") && nums === "1,2,2", `drawing: a balloon on a pin reads its item number 2 (${JSON.stringify(hand.map(a => a.ref.e))}; ${nums})`);
    // Stack item 1 under the hand balloon: two circles share its leader.
    [x, y] = await at(top, 55, 35);
    await dp.mouse.click(x, y);
    await dp.waitForSelector('#drw [data-d="bstack"]');
    await dp.selectOption('#drw [data-d="bstack"]', "c1");
    await dp.waitForTimeout(150);
    an = await annots();
    const stacked = an.find(a => a.t === "balloon" && a.view === top);
    const circles = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "a" && p.layer === "ANNOT" && p.r === 5 && p.a1 - p.a0 > 6).length);
    const nums2 = (await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT" && p.h === 5).map(p => p.s))).sort().join();
    check(JSON.stringify(stacked?.stack) === '["c1"]' && circles === 4 && nums2 === "1,1,2,2", `drawing: stacked balloon adds item 1 under item 2 (${JSON.stringify(stacked?.stack)}; ${circles} circles; ${nums2})`);
    await dp.keyboard.press("Escape");
    // 1.99.0 alternate position (FR-DRW-015): select the top view, pick Pin<1>'s circle, drop that point 30 mm higher: the pin is drawn again in phantom lines.
    [x, y] = await at(top, -45, -25);
    await dp.mouse.click(x, y);
    await dp.click('#drw .drw-props [data-a="altpos"]');
    [x, y] = await at(top, 34, 0);
    await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top, 34, 30);
    await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    await ready();
    const alt = await dp.evaluate(id => JSON.parse(JSON.stringify(window.__sv.drw.doc().sheets[0].views.find(v => v.id === id).alt ?? null)), top);
    const ph = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "PHANTOM" && p.pen === "phantom"));
    const phc = ph.find(p => p.t === "a" && p.a1 - p.a0 > 6);
    const tpl = await dp.evaluate(id => { const p = window.__sv.drw.placement(id); return { x: p.x, y: p.y, s: p.s, uc: p.uc, vc: p.vc }; }, top);
    const want = [tpl.x + (30 - tpl.uc) * tpl.s, tpl.y + (30 - tpl.vc) * tpl.s];
    check(alt?.length === 1 && alt[0].comp === "c2" && Math.abs(alt[0].dv - 30) < 1 && Math.abs(alt[0].du) < 1 && phc && Math.abs(phc.r - 4 * tpl.s) < 0.05 && Math.hypot(phc.o[0] - want[0], phc.o[1] - want[1]) < 1.5,
      `drawing: alternate position draws the moved pin in phantom lines (${JSON.stringify([alt, ph.length, phc?.o, want])})`);
    // Typing a turn keeps the circle where it is (it turns about its own centre line seen end-on).
    await dp.fill('#drw .drw-props [data-v="alt:0:ang"]', "90");
    await dp.keyboard.press("Enter");
    await ready();
    const phc2 = await dp.evaluate(() => window.__sv.drw.prims().find(p => p.layer === "PHANTOM" && p.t === "a" && p.a1 - p.a0 > 6) ?? null);
    await dp.click('#drw .drw-props [data-a="altrm"]');
    await ready();
    const left = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "PHANTOM").length);
    check(phc2 && left === 0, `drawing: an alternate position can be turned and removed (${JSON.stringify([phc2?.o, left])})`);
    // 1.114.0 (FR-DRW-012): a section through both pins cuts them; Don't cut Pin<1> draws it whole.
    await dp.keyboard.press("Escape");
    await dp.click('#drw [data-a="section"]'); await dp.click('#drw [data-cut="h"]');
    [x, y] = await at(top, -45, 0);
    await dp.mouse.move(x + 2, y); await dp.mouse.move(x, y); await dp.mouse.click(x, y);
    [x, y] = await at(top, 0, -95);
    await dp.mouse.move(x + 3, y); await dp.mouse.move(x, y);
    await dp.waitForFunction(() => document.querySelectorAll("#drw .drw-preview line").length > 4, null, { timeout: 30000 });
    await dp.mouse.click(x, y);
    await ready();
    const asec = await dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.find(v => v.kind === "section")?.id);
    const carea = async () => { const pr = await dp.evaluate(i => window.__sv.drw.proj(i), asec); return (pr?.cut ?? []).reduce((t, l) => { let a = 0; for (let i = 0; i < l.length; i += 2) { const j = (i + 2) % l.length; a += l[i] * l[j + 1] - l[j] * l[i + 1]; } return t + Math.abs(a / 2); }, 0); };
    const a0 = await carea();
    await dp.check('#drw .drw-props [data-ex="c2"]');
    await ready();
    const a1 = await carea();
    const exc = await dp.evaluate(i => window.__sv.drw.doc().sheets[0].views.find(v => v.id === i)?.exclude ?? null, asec);
    check(asec && Math.abs(a0 - (100 * 20 + 2 * 8 * 15)) < 0.5 && Math.abs(a1 - (100 * 20 + 8 * 15)) < 0.5 && JSON.stringify(exc) === '["c2"]',
      `drawing: an assembly section cuts both pins, and Don't cut leaves Pin<1> whole (${a0.toFixed(1)} → ${a1.toFixed(1)} mm²; ${JSON.stringify(exc)})`);
    // 1.146.0 (FR-DRW-012): hatched by material, the base and the cut pin are told apart (the pin at 135°); ANSI37 crosses every cut face.
    const hatchLines = () => dp.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "HATCH" && p.t === "l").map(p => Math.round(Math.atan2(p.p[3] - p.p[1], p.p[2] - p.p[0]) * 180 / Math.PI + 360) % 180));
    const ckeys = await dp.evaluate(i => [...new Set(window.__sv.drw.proj(i)?.cutKey ?? [])].sort().join(), asec);
    const hl0 = await hatchLines();
    await dp.selectOption('#drw .drw-props [data-v="hpat"]', "ansi37");
    await ready();
    const hl1 = await hatchLines();
    const hpat = await dp.evaluate(i => window.__sv.drw.doc().sheets[0].views.find(v => v.id === i)?.hatch?.pattern ?? null, asec);
    const angs = l => [...new Set(l)].sort((a, b) => a - b).join();
    check(ckeys === "c1,c3" && angs(hl0) === "45,135" && hl0.filter(a => a === 135).length < hl0.length / 4 && hpat === "ansi37" && hl1.length > 1.5 * hl0.length,
      `drawing: assembly section hatching follows each component, and a fixed pattern applies to all (${ckeys}; ${angs(hl0)} ${hl0.length} → ${hl1.length} lines; ${hpat})`);
    await dp.keyboard.press("Escape");
    if (process.env.SMOKE_SHOTS) await dp.screenshot({ path: `${process.env.SMOKE_SHOTS}/drawing-asm.png` });
    // Associative: suppress Pin<2> in the assembly; the BOM says 1 pin and the balloons stay.
    await dp.click('#drw [data-a="back"]');
    await dp.evaluate(() => window.__sv.asm.setSuppressed("c3", true));
    await dp.waitForFunction(() => window.__sv.viewer.parts.length === 2, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForTimeout(400);
    await ready();
    tx = await texts();
    const qty = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "t" && p.layer === "ANNOT" && p.h === 2.5).map(p => p.s));
    const dangle = await dp.evaluate(() => document.querySelectorAll("#drw .drw-dangle").length);
    check(qty[qty.indexOf("PN-7") + 2] === "1" && dangle === 0, `drawing: the BOM follows the assembly (one pin left: ${qty.join(" ")}; ${dangle} warnings)`);
    // A model view of one component alone (a part's detail views on the assembly drawing); its projected views follow.
    await dp.keyboard.press("Escape");
    const vb = () => dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.filter(v => !v.kind).map(v => { const p = window.__sv.drw.placement(v.id); return { id: v.id, parent: v.parent ?? null, w: +((p.box[2] - p.box[0]) / p.s).toFixed(2), h: +((p.box[3] - p.box[1]) / p.s).toFixed(2), only: v.only ?? null }; }));
    const fv = await dp.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); return window.__sv.drw.sheetPt(v.x, v.y); }, front);
    await dp.mouse.click(fv[0], fv[1]);
    await dp.waitForSelector('#drw .drw-props [data-v="only"]');
    const onlyOpts = await dp.evaluate(() => [...document.querySelectorAll('#drw .drw-props [data-v="only"] option')].map(o => o.textContent));
    await dp.selectOption('#drw .drw-props [data-v="only"]', "c2");
    await dp.waitForTimeout(200);
    await ready();
    const ob = await vb(), of = ob.find(v => v.id === front), okid = ob.find(v => v.parent === front);
    check(onlyOpts.join("|").startsWith("All components|Plate<1>|Pin<1>") && of?.only?.[0] === "c2" && Math.abs(of.w - 8) < 0.3 && Math.abs(of.h - 15) < 0.3 && okid && Math.abs(okid.w - 8) < 0.3,
      `drawing: a model view shows one component of the assembly alone and its projected views follow (${JSON.stringify({ onlyOpts, ob })})`);
    // Its centre marks come from that component only (the plate's holes no longer draw centre lines across the sheet).
    const stray = await dp.evaluate(id => { const pl = window.__sv.drw.placement(id), b = pl.box, m = 8; const inb = (x, y, e) => x >= b[0] - e && x <= b[2] + e && y >= b[1] - e && y <= b[3] + e; return window.__sv.drw.prims().filter(p => p.layer === "CENTER" && p.t === "l").filter(p => { const i0 = inb(p.p[0], p.p[1], 0.5), i1 = inb(p.p[2], p.p[3], 0.5); return (i0 || i1) && !(inb(p.p[0], p.p[1], m) && inb(p.p[2], p.p[3], m)); }).length; }, front);
    check(stray === 0, `drawing: a one-component view draws no centre lines of other components (${stray} outside it)`);
    // First → third angle: the projected views keep showing the same thing and move across their parent (exam bug 34).
    const pv0 = await dp.evaluate(() => { const s = window.__sv.drw.doc().sheets[0]; return { proj: s.projection, v: s.views.filter(v => v.side).map(v => ({ id: v.id, side: v.side, y: v.y, x: v.x, py: s.views.find(p => p.id === v.parent).y, px: s.views.find(p => p.id === v.parent).x })) }; });
    await dp.keyboard.press("Escape");
    await dp.mouse.click(...(await dp.evaluate(() => window.__sv.drw.sheetPt(15, 290))));
    await dp.waitForSelector('#drw .drw-props [data-s="projection"]');
    await dp.selectOption('#drw .drw-props [data-s="projection"]', pv0.proj === "first" ? "third" : "first");
    await ready();
    const pv1 = await dp.evaluate(() => { const s = window.__sv.drw.doc().sheets[0]; return { proj: s.projection, v: s.views.filter(v => v.side).map(v => ({ id: v.id, side: v.side, y: v.y, x: v.x, py: s.views.find(p => p.id === v.parent).y, px: s.views.find(p => p.id === v.parent).x })) }; });
    const crossed = pv0.v.every(a => { const b = pv1.v.find(x => x.id === a.id); return b && b.side[0] === -a.side[0] && b.side[1] === -a.side[1] && Math.abs((b.y - b.py) + (a.y - a.py)) < 1e-6 && Math.abs((b.x - b.px) + (a.x - a.px)) < 1e-6; });
    check(pv1.proj !== pv0.proj && pv0.v.length >= 2 && crossed, `drawing: switching first/third angle moves the projected views across their parent and keeps what they show (${JSON.stringify({ pv0, pv1 })})`);
    // Dragging a projected view across its parent stops on its own side (exam bug 34).
    const tv = pv1.v.find(a => a.side[1] !== 0);
    const [ax0, ay0] = await dp.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [tv.x, tv.y]);
    const [ax1, ay1] = await dp.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [tv.x, tv.py - 2 * (tv.y - tv.py)]);
    await dp.mouse.move(ax0, ay0); await dp.mouse.down(); await dp.mouse.move((ax0 + ax1) / 2, (ay0 + ay1) / 2, { steps: 4 }); await dp.mouse.move(ax1, ay1, { steps: 4 }); await dp.mouse.up();
    await ready();
    const tv2 = await dp.evaluate(id => { const s = window.__sv.drw.doc().sheets[0], v = s.views.find(x => x.id === id), p = s.views.find(x => x.id === v.parent); return { y: v.y, py: p.y, side: v.side }; }, tv.id);
    check((tv2.y - tv2.py) * tv2.side[1] > 0 && tv2.side[1] === tv.side[1], `drawing: a projected view dragged across its parent stops on its own side (${JSON.stringify({ tv, tv2 })})`);
    await ctx.close();
  }

  // --- PDM: drawing compare, an assembly added with its parts (FR-PDM-051, FR-PDM-003/020) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const vp = await ctx.newPage();
    vp.on("pageerror", e => errors.push(e.message));
    vp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await vp.goto(`${origin}/index.html?debug`);
    await vp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await vp.goto(`${origin}/index.html?debug`);
    await vp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const plate = { schema: 1, kind: "part", id: "plate", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -40, -25), P("p2", 40, -25), P("p3", 40, 25), P("p4", -40, 25),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } }] };
    const asmDoc = { schema: 1, kind: "assembly", id: "a_v", name: "Base", units: { length: "mm", decimals: 2 }, parts: { plate: { name: "Plate", file: "Plate.mcadprt", doc: plate } },
      components: [{ id: "c1", name: "Plate<1>", part: "plate", tf: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], fixed: true }] };
    const amf = { format: "mobiuscad", schema: 1, kind: "assembly", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const ab = zip(Object.entries({ "manifest.json": JSON.stringify(amf), "document.json": JSON.stringify(asmDoc) }));
    // A drawing of it (standard 3 views); version 2 loses the side view.
    await vp.evaluate(b => window.__sv.asm.openFile({ name: "Base.mcadasm", data: new Uint8Array(b).buffer }), [...ab]);
    await vp.waitForFunction(() => window.__sv.viewer.parts.length === 1, null, { timeout: 90000 });
    await vp.click("#new-more"); await vp.click("#new-drawing");
    await vp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    const d1 = await vp.evaluate(() => JSON.parse(JSON.stringify(window.__sv.drw.doc())));
    const d2 = { ...d1, sheets: [{ ...d1.sheets[0], views: d1.sheets[0].views.slice(0, 2) }] };
    const dmf = { format: "mobiuscad", schema: 1, kind: "drawing", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const drw = d => [...zip(Object.entries({ "manifest.json": JSON.stringify(dmf), "drawing.json": JSON.stringify(d) }))];
    await vp.click('#drw [data-a="back"]');
    await vp.click("#t-vault");
    await vp.waitForSelector("#v-name");
    await vp.fill("#v-name", "Compare test");
    await vp.click('#vault-panel [data-a="new-ws"]');
    await vp.waitForSelector('#vault-panel [data-a="settings"]');
    // The assembly with its embedded part: the part goes in as a file first and the assembly references it.
    const refs = await vp.evaluate(async b => {
      const p = window.__sv.vault;
      await p.addFiles([new File([new Uint8Array(b)], "Base.mcadasm")], true);
      const files = await p.vault.files();
      const asm = files.find(f => f.path === "Base.mcadasm"), part = files.find(f => f.path === "Plate.mcadprt");
      return { part: !!part, refs: asm ? p.vault.latest(asm).refs.map(r => [r.path, r.id === part?.id, r.qty]) : null };
    }, [...ab]);
    check(refs.part && JSON.stringify(refs.refs) === '[["Plate.mcadprt",true,1]]', `vault: adding an assembly adds its part and references it (${JSON.stringify(refs)})`);
    // Two versions of the drawing, compared as an overlay: the side view's lines are only in v1.
    const id = await vp.evaluate(async ([a, b]) => {
      const p = window.__sv.vault, v = p.vault;
      const f = await v.add("Base.mcaddrw", new Uint8Array(a));
      await v.checkOut(f.id);
      await v.saveWorking(f.id, new Uint8Array(b));
      await v.checkIn(f.id, "no side view");
      return f.id;
    }, [drw(d1), drw(d2)]);
    await vp.evaluate(i => window.__sv.vault.compareDlg(i, 1, 2), id);
    await vp.waitForSelector("#vault-dlg .v-overlay", { timeout: 120000 });
    const ov = await vp.evaluate(() => [...document.querySelectorAll("#vault-dlg .v-overlay")].map(x => [+x.dataset.removed, +x.dataset.added, x.querySelectorAll('[stroke="#d32f2f"]').length]));
    check(ov.length === 1 && ov[0][0] >= 4 && ov[0][1] === 0 && ov[0][2] >= 4, `vault: drawing compare overlays the versions, the removed view in red (${JSON.stringify(ov)})`);
    if (process.env.SMOKE_SHOTS) await vp.screenshot({ path: `${process.env.SMOKE_SHOTS}/vault-drawing-compare.png` });
    await vp.keyboard.press("Escape");
    // Full-text search: a component name inside the assembly.
    const found = await vp.evaluate(async () => (await window.__sv.vault.vault.search({ content: "Plate<1>" })).map(f => f.path).sort());
    check(JSON.stringify(found) === '["Base.mcadasm"]', `vault: full-text search finds the assembly by a component name (${JSON.stringify(found)})`);
    // Releasing the part and the drawing stores Plate_revA.step (revision in it) and Base_revA.pdf beside them.
    const rel = await vp.evaluate(async did => {
      const p = window.__sv.vault, v = p.vault;
      const part = (await v.files()).find(f => f.path === "Plate.mcadprt");
      for (const id of [part.id, did]) { await p.transitionDlg(id, "Submit for review", "ok", [], ""); await p.transitionDlg(id, "Approve", "ok", [], ""); }
      const files = await v.files(), step = files.find(f => f.path === "Plate_revA.step"), pdf = files.find(f => f.path === "Base_revA.pdf");
      const text = step ? new TextDecoder().decode(await v.versionBytes(step.id, 1)) : "";
      const head = pdf ? new TextDecoder().decode((await v.versionBytes(pdf.id, 1)).slice(0, 5)) : "";
      return { step: !!step, rev: /PRODUCT_DEFINITION_FORMATION[A-Z_]*\('A'/.test(text), pdf: head };
    }, id);
    check(rel.step && rel.rev && rel.pdf === "%PDF-", `vault: a release stores the part's STEP with its revision and the drawing's PDF (${JSON.stringify(rel)})`);
    await ctx.close();
  }

  // --- PDM vault thread (FRS 12.5 P4): lifecycle and revisions, data card, search, rename, recycle bin ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#t-vault");
    await mp.waitForSelector("#v-name");
    await mp.waitForTimeout(300);
    await mp.fill("#v-name", "Lifecycle test");
    await mp.waitForTimeout(100);
    if (await mp.inputValue("#v-name") !== "Lifecycle test") await mp.fill("#v-name", "Lifecycle test");
    await mp.click('#vault-panel [data-a="new-ws"]');
    await mp.waitForSelector('#vault-panel [data-a="settings"]');
    await mp.evaluate(async () => { await window.__sv.vault.addFiles([new File(["bracket"], "bracket.txt"), new File(["spare"], "spare.txt")]); });
    const rowText = n => mp.evaluate(i => document.querySelectorAll("#vault-panel .v-row")[i]?.textContent.replace(/\s+/g, " ").trim() ?? "", n);
    await mp.waitForFunction(() => document.querySelectorAll("#vault-panel .v-row").length === 2);
    const row0 = await rowText(0);
    // Data card: check out, fill the part number, check in.
    await mp.click("#vault-panel .v-row >> nth=0");
    await mp.click('#vault-panel [data-a="co"]');
    await mp.waitForSelector('#vault-panel [data-a="ci"]');
    await mp.click('#vault-panel [data-a="card"]');
    await mp.fill('#vault-dlg [name="c:Part number"]', "BR-001");
    await mp.fill('#vault-dlg [name="c:Description"]', "Bracket");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForFunction(() => /BR-001/.test(document.querySelector("#vault-panel .v-row")?.textContent ?? ""));
    await mp.click('#vault-panel [data-a="ci"]');
    await mp.fill('#vault-dlg textarea[name="comment"]', "numbered");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForSelector('#vault-panel [data-a="co"]');
    // Submit for review, then Approve: revision A, Released, no check-out any more.
    await mp.click('#vault-panel [data-tr="Submit for review"]');
    await mp.waitForSelector("#vault-dlg .v-check li");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForSelector('#vault-panel [data-tr="Approve"]');
    const checks = await mp.evaluate(() => { document.querySelector('#vault-panel [data-tr="Approve"]').click(); return true; });
    await mp.waitForSelector("#vault-dlg .v-check li");
    const dlgTitle = await mp.textContent("#vault-dlg-title");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForFunction(() => /Rev A/.test(document.querySelector("#vault-panel .v-row")?.textContent ?? ""));
    const row1 = await rowText(0);
    const canCheckOut = await mp.$('#vault-panel [data-a="co"]') !== null;
    // Search by part number.
    await mp.fill("#v-q", "br-001");
    await mp.press("#v-q", "Enter");
    await mp.waitForSelector("#vault-panel .v-found");
    const found = await mp.evaluate(() => [...document.querySelectorAll("#vault-panel .v-row .v-name")].map(x => x.textContent).join("|"));
    await mp.click('#vault-panel [data-a="clearq"]');
    // Rename / move into a folder.
    await mp.click("#vault-panel .v-row >> nth=0");
    await mp.click('#vault-panel [data-a="rename"]');
    await mp.fill('#vault-dlg [name="path"]', "parts/bracket.txt");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForFunction(() => [...document.querySelectorAll("#vault-panel .v-name")].some(x => x.textContent === "parts/bracket.txt"));
    // Delete the spare file to the recycle bin and restore it.
    await mp.click('#vault-panel .v-row:has-text("spare.txt")');
    await mp.click('#vault-panel [data-a="del"]');
    await mp.waitForSelector("#confirm[open]");
    await mp.click('#confirm [data-a="ok"]');
    await mp.waitForFunction(() => document.querySelectorAll("#vault-panel .v-row").length === 1);
    await mp.click('#vault-panel [data-a="bin"]');
    await mp.waitForSelector("#vault-dlg [data-restore]");
    await mp.click("#vault-dlg [data-restore]");
    await mp.waitForFunction(() => document.querySelectorAll("#vault-panel .v-row").length === 2);
    const audit = await mp.evaluate(async () => (await window.__sv.vault.vault.auditTrail()).map(e => e.action).filter(a => /transition|data card|move|rename|delete|restore/.test(a)).join(","));
    // Russian: state and revision are translated.
    await mp.click("#lang-btn");
    await mp.waitForFunction(() => /Выпущен/.test(document.querySelector("#vault-panel .v-row")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    const ruRow = await rowText(0);
    await mp.click("#lang-btn");
    check(/Work in progress/.test(row0) && checks && /Approve/.test(dlgTitle) && /Released/.test(row1) && /Rev A/.test(row1) && /BR-001/.test(row1) && !canCheckOut, `vault P4: data card, Submit for review and Approve give revision A (${row0} → ${row1}; ${dlgTitle})`);
    check(found === "bracket.txt" && audit === "data card,transition,transition,move,delete,restore", `vault P4: search, move, recycle bin and audit (${found}; ${audit})`);
    check(/Выпущен/.test(ruRow) && /Ред\. A/.test(ruRow), `vault P4: lifecycle in Russian (${ruRow})`);
    await ctx.close();
  }

  // --- PDM vault thread (FRS 12.5 P5): change order, release package, workflow editor, notifications ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#t-vault");
    await mp.waitForSelector("#v-name");
    await mp.waitForTimeout(300);
    await mp.fill("#v-name", "Team test");
    await mp.waitForTimeout(100);
    if (await mp.inputValue("#v-name") !== "Team test") await mp.fill("#v-name", "Team test");
    await mp.click('#vault-panel [data-a="new-ws"]');
    await mp.waitForSelector('#vault-panel [data-a="changes"]');
    // Two released files (one transition on both: a release package).
    await mp.evaluate(async () => {
      const p = window.__sv.vault, v = p.vault;
      await p.addFiles([new File(["arm"], "arm.txt"), new File(["pin"], "pin.txt")]);
      const ids = (await v.files()).map(f => f.id);
      await v.transition(ids, "Submit for review");
      await v.transition(ids, "Approve");
      await p.refresh();
    });
    // Request a change on arm.txt from the tab, approve it, then close it.
    await mp.click('#vault-panel .v-row:has-text("arm.txt")');
    await mp.click('#vault-panel [data-a="eco"]');
    await mp.fill('#vault-dlg [name="title"]', "Longer arm");
    await mp.fill('#vault-dlg [name="reason"]', "Clash");
    await mp.click('#vault-dlg button[value="ok"]');
    // Waits for an async condition in the page (waitForFunction treats a promise as truthy).
    const until = async (fn, ms = 10000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await mp.waitForTimeout(100)) if (await mp.evaluate(fn)) return true; return false; };
    await until(async () => (await window.__sv.vault.vault.changes()).length === 1);
    await mp.click('#vault-panel [data-a="changes"]');
    await mp.waitForSelector("#vault-dlg [data-eco-ok]");
    await mp.click("#vault-dlg [data-eco-ok]");
    await mp.waitForSelector("#vault-dlg [data-eco-close]");
    const pending = await mp.evaluate(async () => (await window.__sv.vault.vault.files()).map(f => `${f.path}:${f.state}`).join("|"));
    await mp.click("#vault-dlg [data-eco-close]");
    await until(async () => (await window.__sv.vault.vault.changes())[0].state === "Closed");
    // The list reopens once the order is closed.
    await mp.waitForSelector("#vault-dlg[open] [data-eco-ok], #vault-dlg[open] tbody tr", { timeout: 10000 }).catch(() => {});
    await mp.waitForTimeout(300);
    const after = await mp.evaluate(async () => (await window.__sv.vault.vault.files()).map(f => `${f.path}:${f.state}:${f.revision}`).join("|"));
    await mp.evaluate(() => document.querySelector("#vault-dlg")?.open && document.querySelector("#vault-dlg").close());
    // Release packages: two (the joint release and the change order), exported as a ZIP.
    await mp.click('#vault-panel [data-a="packages"]');
    await mp.waitForSelector("#vault-dlg [data-zip]");
    const pkgs = await mp.$$eval("#vault-dlg [data-zip]", x => x.length);
    const [dl] = await Promise.all([mp.waitForEvent("download"), mp.click("#vault-dlg [data-zip] >> nth=0")]);
    const zipName = dl.suggestedFilename();
    await mp.click('#vault-dlg button[value="cancel"]');
    // Workflow editor: add a state, save; it is in the settings.
    await mp.click('#vault-panel [data-a="workflow"]');
    await mp.waitForSelector("#vault-dlg [data-add-s]");
    await mp.click("#vault-dlg [data-add-s]");
    await mp.waitForSelector('#vault-dlg [data-s="5"]');
    await mp.fill('#vault-dlg [data-s="5"] [name="name"]', "Archived");
    await mp.click('#vault-dlg button[value="ok"]');
    await mp.waitForFunction(() => window.__sv.vault.vault.info.workflow?.states.some(s => s.name === "Archived"), null, { timeout: 5000 }).catch(() => {});
    const states = await mp.evaluate(() => window.__sv.vault.vault.info.workflow?.states.map(s => s.name).join(",") ?? "");
    // Notifications: another user's check-in shows up with a count.
    await mp.evaluate(async () => {
      const p = window.__sv.vault, v = p.vault;
      v.user = "Olga";
      const f = (await v.files()).find(x => x.path === "arm.txt");
      await v.transition([f.id], "Change");
      v.user = "Andrey";
      await p.refresh();
    });
    const badge = await mp.evaluate(() => document.querySelector('#vault-panel [data-a="notes"] .v-badge')?.textContent ?? "");
    await mp.click('#vault-panel [data-a="notes"]');
    await mp.waitForSelector("#vault-dlg .v-log li");
    const note = await mp.textContent("#vault-dlg .v-log li");
    check(/arm\.txt:Change pending/.test(pending) && /pin\.txt:Released/.test(pending) && after === "arm.txt:Released:B|pin.txt:Released:A", `vault P5: change request, approve, close and release (${pending} → ${after})`);
    check(pkgs === 2 && /\.zip$/.test(zipName) && /Archived/.test(states) && badge === "1" && /Olga/.test(note), `vault P5: release packages, workflow editor and notifications (${pkgs}, ${zipName}, ${states}, ${badge}, ${note})`);
    await ctx.close();
  }

  // 1.47: offline start (FR-STO-030): the service worker precaches the app; a reload offline still starts it.
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx.newPage();
    await pg.goto(`${origin}/index.html?sw`);
    await pg.evaluate(async () => { for (let i = 0; i < 240; i++) { const r = await navigator.serviceWorker.getRegistration(); if (r?.active?.state === "activated" && navigator.serviceWorker.controller) return; await new Promise(f => setTimeout(f, 250)); } });
    const swState = await pg.evaluate(async () => { const ks = (await caches.keys()).filter(k => k.startsWith("mobiuscad-")); const c = ks.length ? await caches.open(ks[0]) : null; const urls = c ? (await c.keys()).map(r => new URL(r.url).pathname) : []; const reg = await navigator.serviceWorker.getRegistration(); return { script: new URL(reg.active.scriptURL).search, caches: ks.length, n: urls.length, index: urls.includes("/index.html"), occt: urls.some(u => u.endsWith("occt-import-js.wasm")), full: urls.some(u => u.endsWith("opencascade.full.wasm")), ctl: !!navigator.serviceWorker.controller }; });
    await ctx.setOffline(true);
    let offVer = "";
    try { await pg.reload({ timeout: 20000 }); await pg.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector("#app-version")?.textContent ?? ""), null, { timeout: 20000 }); offVer = await pg.evaluate(() => document.querySelector("#app-version").textContent); } catch (e) { offVer = String(e).slice(0, 80); }
    await ctx.setOffline(false);
    check(/^\?v=\d+\.\d+\.\d+$/.test(swState.script) && swState.caches === 1 && swState.index && swState.occt && !swState.full && swState.n > 10 && swState.ctl && /^v\d/.test(offVer), `1.47: service worker precaches the app and it starts offline (${JSON.stringify(swState)}, ${offVer})`);
    await ctx.close();
  }

  // --- 1.53: sketch: converted edges follow the model and dangle (FR-SK-064), dimension names (065), draggable text (066), edit sketch plane (007) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    const s3x = () => mp.evaluate(() => { const sk = window.__sv.model.store.doc.features.find(f => f.id === "s3"); const st = window.__sv.model.last().statuses.find(s => s.id === "s3"); return { xs: sk.ents.filter(e => e.t === "point").map(e => Math.round(Math.abs(e.x) * 1000) / 1000), dangling: sk.rels.filter(r => r.dangling).length, code: st?.code ?? "", ok: st?.ok }; });
    await mp.evaluate(() => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), L = (id, a, b) => ({ id, t: "line", a, b });
      window.__sv.model.store.change("Block", d => {
        d.features.push(
          { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -50, -30), P("b", 50, -30), P("c", 50, 30), P("d", -50, 30), L("s1l1", "a", "b"), L("s1l2", "b", "c"), L("s1l3", "c", "d"), L("s1l4", "d", "a")] },
          { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
          { id: "s3", type: "sketch", name: "Sketch3", hidden: false, plane: { face: { name: "f1:end" } }, dims: [], ents: [P("q1", 40, -10), P("q2", 40, 10), L("ln", "q1", "q2")], rels: [{ id: "r1", t: "fix", e: ["ln"], ext: { faces: ["f1:end", "f1:side:s1l2"] } }] });
      });
    });
    await settle();
    const a1 = await s3x();
    await mp.evaluate(() => window.__sv.model.store.change("Wider", d => { for (const e of d.features[0].ents) if (e.t === "point") e.x = Math.sign(e.x) * 70; }));
    await settle();
    const a2 = await s3x();
    check(a1.xs.every(x => Math.abs(x - 50) < 1e-6) && !a1.dangling && a2.xs.every(x => Math.abs(x - 70) < 1e-6) && !a2.dangling && a2.ok, `model 1.53: a converted edge follows the model when it changes (FR-SK-064) (${JSON.stringify(a1)} → ${JSON.stringify(a2)})`);
    // The edge goes: the relation dangles, the line stays, the sketch warns.
    await mp.evaluate(() => window.__sv.model.store.change("Lose edge", d => { d.features.find(f => f.id === "s3").rels[0].ext.faces = ["f1:end", "f9:side:zz"]; }));
    await settle();
    const a3 = await s3x();
    check(a3.dangling === 1 && a3.code === "warning" && a3.xs.every(x => Math.abs(x - 70) < 1e-6), `model 1.53: a lost edge leaves a dangling relation and a warning (${JSON.stringify(a3)})`);
    // In the sketch: the dangling glyph and panel; Re-attach by clicking the block's right top edge.
    await mp.evaluate(() => window.__sv.modeller.editSketch("s3"));
    await mp.waitForFunction(() => window.__sv.model.editor());
    await settle();
    const ui = await mp.evaluate(() => ({ glyph: !!document.querySelector("#sk-layer .sk-rel.dangling"), box: !!document.querySelector("#mc-pm .pm-dangling [data-reattach]"), name: document.querySelector("#sk-layer .sk-rel.dangling")?.title ?? "" }));
    await mp.click("#mc-pm .pm-dangling [data-reattach]");
    const edgeAt = await mp.evaluate(() => {
      const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect();
      const q = new (v.camera.position.constructor)(70, 15, 20).project(v.camera);
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    });
    await mp.mouse.move(edgeAt[0], edgeAt[1]); await mp.waitForTimeout(40); await mp.mouse.down(); await mp.mouse.up();
    await settle();
    const re = await mp.evaluate(() => { const ed = window.__sv.model.editor(), r = ed.sk.rels.find(x => x.id === "r1"); return { dangling: !!r.dangling, faces: r.ext?.faces.join("|"), tool: ed.tool, box: !!document.querySelector("#mc-pm .pm-dangling") }; });
    check(ui.glyph && ui.box && /On edge/.test(ui.name) && !re.dangling && /f1:side:s1l2/.test(re.faces ?? "") && re.tool === "select" && !re.box, `model 1.53: Re-attach puts a dangling curve back on a clicked model edge (${JSON.stringify(ui)}, ${JSON.stringify(re)})`);
    // Dimension text drags and is stored; the full name shows on hover and can be renamed; expressions follow (FR-SK-065/066).
    await mp.evaluate(() => {
      const ed = window.__sv.model.editor(), next = structuredClone(ed.sk);
      next.ents.push({ id: "w1", t: "point", x: -30, y: 0 }, { id: "w2", t: "point", x: 0, y: 0 }, { id: "wl", t: "line", a: "w1", b: "w2" });
      next.dims.push({ id: "dd", name: "D1", t: "distance", e: ["wl"], val: { v: 30 }, pos: [-15, 6] });
      ed.setSketch(next, ed.frame); ed.commit("Add");
      window.__sv.model.store.change("Var", d => { d.vars = [{ name: "half", kind: "length", expr: "D1@Sketch3 / 2" }]; });
    });
    await settle();
    const lab = await mp.evaluate(() => { const el = [...document.querySelectorAll("#sk-layer .sk-dim")].find(e => e.dataset.id === "dd"); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, title: el.title }; });
    await mp.mouse.move(lab.x, lab.y); await mp.mouse.down(); await mp.mouse.move(lab.x + 30, lab.y + 30, { steps: 4 }); await mp.mouse.move(lab.x + 60, lab.y + 60, { steps: 4 }); await mp.mouse.up();
    await mp.waitForTimeout(100);
    const moved = await mp.evaluate(() => { const ed = window.__sv.model.editor(); const d = ed.sk.dims.find(x => x.id === "dd"); const st = window.__sv.model.store.doc.features.find(f => f.id === "s3").dims.find(x => x.id === "dd"); return { pos: d.pos, stored: st.pos, input: !!document.querySelector(".sk-input"), v: d.val.v }; });
    check(lab.title === "D1@Sketch3" && Math.hypot(moved.pos[0] + 15, moved.pos[1] - 6) > 3 && JSON.stringify(moved.pos) === JSON.stringify(moved.stored) && !moved.input && moved.v === 30, `model 1.53: dimension text drags and stays where it is put; hover shows D1@Sketch3 (FR-SK-065/066) (${lab.title}, ${JSON.stringify(moved)})`);
    await mp.evaluate(() => { window.__sv.model.editor().select(["dd"]); window.__sv.model.panel(); });
    await mp.fill('#mc-pm input[data-a="dimname"]', "Width");
    await mp.press('#mc-pm input[data-a="dimname"]', "Enter");
    await mp.evaluate(() => document.querySelector('#mc-pm input[data-a="dimname"]')?.dispatchEvent(new Event("change")));
    await mp.waitForTimeout(100);
    await mp.check('#mc-pm input[data-a="shownames"]');
    const ren = await mp.evaluate(() => ({ name: window.__sv.model.editor().sk.dims.find(x => x.id === "dd").name, varExpr: window.__sv.model.store.doc.vars?.[0]?.expr, shown: [...document.querySelectorAll("#sk-layer .sk-dim .sk-dname")].map(e => e.textContent).join(","), title: [...document.querySelectorAll("#sk-layer .sk-dim")].find(e => e.dataset.id === "dd")?.title }));
    check(ren.name === "Width" && ren.varExpr === "Width@Sketch3 / 2" && ren.shown.includes("Width") && ren.title === "Width@Sketch3", `model 1.53: renaming a dimension updates expressions that use it; names can be shown (${JSON.stringify(ren)})`);
    await mp.evaluate(() => window.__sv.modeller.ok());
    await settle();
    // Edit sketch plane (FR-SK-007): move Sketch3 from the block's top face to Top; its curves keep following the edge.
    await mp.evaluate(() => window.__sv.modeller.editSketchPlane("s3"));
    await mp.waitForSelector('#mc-pm [data-std="XY"]');
    await mp.click('#mc-pm [data-std="XY"]');
    await settle();
    const live = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { kind: m.kind, plane: m.edit?.plane, cur: document.querySelector('#mc-pm [data-a="cur"]')?.textContent, doc: window.__sv.model.store.doc.features.find(f => f.id === "s3").plane }; });
    await mp.click('#mc-pm [data-a="ok"]');
    await settle();
    const pl = await mp.evaluate(() => ({ plane: window.__sv.model.store.doc.features.find(f => f.id === "s3").plane, kind: window.__sv.model.mode().kind, undo: window.__sv.model.store.undoLabel }));
    const a4 = await s3x();
    check(live.kind === "plane" && live.plane?.std === "XY" && "face" in live.doc && pl.plane.std === "XY" && pl.kind === "none" && pl.undo === "Edit sketch plane" && !a4.dangling && a4.ok, `model 1.53: Edit sketch plane previews and moves the sketch to another plane (FR-SK-007) (${JSON.stringify(live)}, ${JSON.stringify(pl)}, ${JSON.stringify(a4)})`);
    await ctx.close();
  }

  // --- 1.56: rib (FR-FT-062) from the Sweep ▾ menu: an L bracket's corner gusset, previewed live, panel in Russian ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Bracket", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const rect = (id, x0, y0, x1, y1) => ({ id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [P(id + "a", x0, y0), P(id + "b", x1, y0), P(id + "c", x1, y1), P(id + "d", x0, y1), Ln(id + "1", id + "a", id + "b"), Ln(id + "2", id + "b", id + "c"), Ln(id + "3", id + "c", id + "d"), Ln(id + "4", id + "d", id + "a")] });
      d.features.push(rect("Sketch1", -50, -30, 50, 30), { id: "bx", type: "extrude", name: "Extrude1", sketch: "Sketch1", op: "boss", end: "blind", depth: { v: 10 } },
        rect("Sketch2", -50, -30, -40, 30), { id: "wx", type: "extrude", name: "Extrude2", sketch: "Sketch2", op: "boss", end: "blind", depth: { v: 60 } },
        { id: "rs", type: "sketch", name: "Sketch3", plane: { std: "XZ" }, rels: [], dims: [], ents: [P("ra", -40, 50), P("rb", 40, 10), Ln("rl", "ra", "rb")] });
    }));
    await settle();
    const v0 = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await runCmd(mp, "Rib");
    await settle();
    const r0 = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { type: m.draft?.type, sketch: m.draft?.sketch, title: document.querySelector("#mc-pm h3")?.textContent, live: window.__sv.model.last().props.volume }; });
    await mp.fill('#mc-pm input[data-num="thickness"]', "4");
    await mp.press('#mc-pm input[data-num="thickness"]', "Tab");
    await settle();
    const live4 = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.click("#mc-ok");
    await settle();
    const rib = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    check(r0.type === "rib" && r0.sketch === "rs" && r0.title === "Rib" && Math.abs(r0.live - v0 - 8000) < 1e-3 && Math.abs(live4 - v0 - 6400) < 1e-3 && Math.abs(rib.v - v0 - 6400) < 1e-3 && !rib.bad && /Rib1/.test(rib.names),
      `model 1.56: Rib from an open line fills the bracket's corner, previewed live (FR-FT-062) (${JSON.stringify(r0)}, ${v0}, ${live4}, ${JSON.stringify(rib)})`);
    // Split line (FR-FT-084): a circle on Top, clear of the rib, splits the base's top and bottom faces; the volume stays.
    await mp.evaluate(() => window.__sv.model.store.change("Circle", d => { d.features.push({ id: "cs", type: "sketch", name: "Sketch4", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "o", t: "point", x: 20, y: 15 }, { id: "k", t: "circle", c: "o", r: 6 }] }); }));
    await settle();
    const nf0 = await mp.evaluate(() => window.__sv.model.last().faceNames.length);
    await runCmd(mp, "Split Line");
    await settle();
    const sp0 = await mp.evaluate(() => ({ sketch: window.__sv.model.mode().draft?.sketch, count: document.querySelector("#mc-pm .pm-count")?.textContent, faces: window.__sv.model.last().faceNames.length }));
    await mp.click("#mc-ok");
    await settle();
    const sp = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, faces: window.__sv.model.last().faceNames.length }));
    check(sp0.sketch === "cs" && sp0.count === "All faces it crosses" && sp0.faces === nf0 + 2 && sp.faces === nf0 + 2 && !sp.bad && Math.abs(sp.v - rib.v) < 1e-6,
      `model 1.56: Split Line splits the faces a projected circle crosses, previewed live (FR-FT-084) (${nf0}, ${JSON.stringify(sp0)}, ${JSON.stringify(sp)})`);
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "rib").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, opts: [...document.querySelectorAll('#mc-pm select[data-k="dir"] option')].map(o => o.textContent).join("|") }));
    check(ru.title === "Ребро" && ru.opts === "Параллельно эскизу|Перпендикулярно эскизу", `model 1.56: rib panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.57: multibody (FRS 9.10, AT-P3-3): split a body by a plane and combine it back, a boss that does not merge ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Box", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } },
        { id: "p", type: "plane", name: "Plane1", base: { std: "YZ" }, mode: "offset", offset: { v: 5 } });
    }));
    await settle();
    const menu = async label => { await runCmd(mp, label); await settle(); };
    // Split: the plane picked (as a click on it would), previewed as two bodies.
    await menu("Split");
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.plane = { plane: "p" }; m.focus = "bodies"; window.__sv.modeller.draftChanged(); });
    await settle();
    const sp0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, bodies: window.__sv.model.last().props.bodies, status: [...document.querySelectorAll("#mc-pm .pm-help")].map(e => e.textContent).find(x => /The part has/.test(x)) }));
    await mp.click("#mc-ok");
    await settle();
    const sp = await mp.evaluate(() => window.__sv.model.last().props);
    // Combine (add) the two pieces back into one body: AT-P3-3, volume kept.
    await menu("Combine");
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.main = { name: "x:side:l4" }; m.draft.tools = [{ name: "x:side:l2" }]; window.__sv.modeller.draftChanged(); });
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const cb = await mp.evaluate(() => ({ ...window.__sv.model.last().props, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    check(sp0.title === "Split" && sp0.bodies === 2 && sp0.status === "The part has 2 bodies" && sp.bodies === 2 && Math.abs(sp.volume - 8000) < 1e-6 && cb.bodies === 1 && Math.abs(cb.volume - 8000) < 1e-6 && !cb.bad && /Split1,Combine1/.test(cb.names),
      `model 1.57: Split a body by a plane into two and Combine them back, volume kept (AT-P3-3) (${JSON.stringify(sp0)}, ${sp.bodies}/${sp.volume}, ${JSON.stringify(cb)})`);
    // Extrude panel: Merge result, on by default; off makes a second body.
    await mp.evaluate(() => window.__sv.model.store.change("Circle", d => { d.features.push({ id: "k", type: "sketch", name: "Sketch2", plane: { face: { name: "x:end" } }, rels: [], dims: [], ents: [{ id: "o", t: "point", x: 0, y: 0 }, { id: "c", t: "circle", c: "o", r: 4 }] }); }));
    await settle();
    await mp.evaluate(() => window.__sv.modeller.command("extrude"));
    await settle();
    const on = await mp.evaluate(() => document.querySelector('#mc-pm input[data-k="merge"]')?.checked);
    await mp.click('#mc-pm input[data-k="merge"]');
    await settle();
    const mb = await mp.evaluate(() => ({ merge: window.__sv.model.mode().draft?.merge, bodies: window.__sv.model.last().props.bodies }));
    await mp.click("#mc-ok");
    await settle();
    check(on === true && mb.merge === false && mb.bodies === 2, `model 1.57: Extrude with Merge result off makes a new body (FR-FT-006) (${on}, ${JSON.stringify(mb)})`);
    // Variable radius fillet on a corner edge: callouts at both ends, the end radius typed in the list.
    const v1 = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await mp.evaluate(() => window.__sv.modeller.command("fillet"));
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.edges = [{ faces: ["x:side:l1", "x:side:l2"] }]; window.__sv.modeller.draftChanged(); });
    await settle();
    await mp.click('#mc-pm input[data-k="variable"]');
    await settle();
    await mp.fill('#mc-pm input[data-er2="0"]', "4");
    await mp.press('#mc-pm input[data-er2="0"]', "Enter");
    await settle();
    const vf = await mp.evaluate(() => ({ calls: [...document.querySelectorAll("#mc-layer .mc-callout")].map(e => e.textContent), d: window.__sv.model.mode().draft, v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    await mp.click("#mc-ok");
    await settle();
    vf.v = await mp.evaluate(() => window.__sv.model.last().props.volume);
    const removed = v1 - vf.v, want = (1 - Math.PI / 4) * 10 * (4 + 8 + 16) / 3;
    check(vf.d.variable && vf.d.edges[0].r2 === 4 && vf.d.edges[0].at && vf.calls.length === 2 && /^R1a: 2/.test(vf.calls[0]) && /^R1b: 4/.test(vf.calls[1]) && !vf.bad && Math.abs(removed - want) / want < 0.03,
      `model 1.57: Variable radius fillet from 2 to 4 mm, callouts at both ends (FR-FT-032) (${JSON.stringify(vf.calls)}, ${removed.toFixed(3)} vs ${want.toFixed(3)})`);
    await ctx.close();
  }

  // --- 1.58: Insert body (FR-FT-130/131): a STEP cube into a new part, then Check and heal ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    const bytes = [...(await readFile(join(fixtures, "cube-10x10mm", "Cube 10x10.stp")))];
    await mp.evaluate(b => window.__sv.modeller.importBodyFile(new File([new Uint8Array(b)], "Cube 10x10.stp")), bytes);
    await mp.waitForFunction(() => window.__sv.model.mode().kind !== "none", null, { timeout: 120000 });
    await settle();
    const ib = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, file: document.querySelector("#mc-pm")?.textContent.includes("Cube 10x10.stp"), ...window.__sv.model.last().props }));
    await mp.click('#mc-pm input[data-k="heal"]');
    await settle();
    const heal = await mp.evaluate(() => document.querySelector("#mc-pm [data-heal]")?.textContent ?? "");
    await mp.click("#mc-ok");
    await settle();
    const done = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, f: window.__sv.model.store.doc.features.map(f => f.type + ":" + f.name).join(",") }));
    check(ib.title === "Imported body" && ib.file && Math.abs(ib.volume - 1000) < 1 && ib.bodies === 1 && /^Check and heal: \d+ free edges before, 0 after; valid before, valid after; 1 solid bodies\.$/.test(heal) && !done.bad && Math.abs(done.v - 1000) < 1 && /import:Imported1/.test(done.f),
      `model 1.58: Insert body reads a STEP cube into the part and Check and heal reports it (FR-FT-130/131) (${JSON.stringify(ib)}, ${heal}, ${JSON.stringify(done)})`);
    await ctx.close();
  }

  // --- 1.59: full round fillet and face fillet (FR-FT-032), Scale (FR-BODY-006) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Wall", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -2), P("b", 20, -2), P("c", 20, 2), P("d", -20, 2), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await settle();
    // Full round: Fillet type, then the three face sets (as clicks would fill them), previewed live.
    await mp.evaluate(() => window.__sv.modeller.command("fillet"));
    await settle();
    await mp.selectOption('#mc-pm select[data-k="kind"]', "full");
    await settle();
    const boxes = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm .pm-box")].map(b => b.dataset.focus));
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.faces1 = [{ name: "x:side:l1" }]; m.draft.center = [{ name: "x:end" }]; m.draft.faces2 = [{ name: "x:side:l3" }]; window.__sv.modeller.draftChanged(); });
    await settle();
    const pv = await mp.evaluate(() => window.__sv.model.last().preview?.position.length ?? 0);
    await mp.click("#mc-ok");
    await settle();
    const fr = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    const wantFr = 40 * 4 * 10 - (8 - 2 * Math.PI) * 40;
    check(boxes.join() === "fs1,fc,fs2" && pv > 0 && !fr.bad && Math.abs(fr.v - wantFr) < 0.05,
      `model 1.59: Full round fillet replaces the top of a 4 mm wall with a half round, previewed live (FR-FT-032) (${boxes}, ${pv}, ${JSON.stringify(fr)} vs ${wantFr.toFixed(3)})`);
    // Scale ×2 about the origin from the Sweep ▾ menu: volume ×8.
    await runCmd(mp, "Scale");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="about"]', "origin");
    await mp.fill('#mc-pm input[data-num="factor"]', "2");
    await mp.press('#mc-pm input[data-num="factor"]', "Enter");
    await settle();
    const sc = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, f: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    check(!sc.bad && Math.abs(sc.v - 8 * wantFr) < 0.4 && /Scale1/.test(sc.f), `model 1.59: Scale ×2 about the origin multiplies the volume by 8 (FR-BODY-006) (${JSON.stringify(sc)})`);
    await ctx.close();
  }

  // --- 1.60: Solid Bodies folder (FR-BODY-001): list, hide, colour, rename, delete ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Two bodies", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } },
        { id: "k", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "c0", t: "point", x: 40, y: 0 }, { id: "cc", t: "circle", c: "c0", r: 5 }] },
        { id: "e", type: "extrude", name: "Extrude2", sketch: "k", op: "boss", end: "blind", depth: { v: 10 }, merge: false });
    }));
    await settle();
    const t0 = await mp.evaluate(() => ({ folder: document.querySelector('#mc-tree .ft-row[data-id="folder:bodies"] .ft-name')?.textContent, rows: [...document.querySelectorAll("#mc-tree .ft-body .ft-name")].map(e => e.textContent), faces: window.__sv.model.last().faceNames.length }));
    // Hide the cylinder from its row: it leaves the view, the mass properties keep it.
    await mp.hover('#mc-tree .ft-row[data-id="body:e"]');
    await mp.click('#mc-tree .ft-row[data-id="body:e"] [data-a="bhide"]');
    await settle();
    const hid = await mp.evaluate(() => ({ faces: window.__sv.model.last().faceNames, v: window.__sv.model.last().props.volume, cls: document.querySelector('#mc-tree .ft-row[data-id="body:e"]').className }));
    // Colour the box, rename it by double-click.
    await mp.evaluate(() => window.__sv.modeller.setBody("x", { color: [1, 0, 0] }));
    await settle();
    const red = await mp.evaluate(() => window.__sv.viewer.parts[0].data.faces.filter(f => f.color && f.color[0] === 1 && f.color[1] === 0).length);
    await mp.dblclick('#mc-tree .ft-row[data-id="body:x"] .ft-name');
    await mp.keyboard.press("ControlOrMeta+a");
    await mp.keyboard.type("Base plate");
    await mp.keyboard.press("Enter");
    await settle();
    const nm = await mp.evaluate(() => [window.__sv.model.store.doc.bodies?.x?.name, document.querySelector('#mc-tree .ft-row[data-id="body:x"] .ft-name')?.textContent]);
    // Delete the cylinder: a Body-Delete/Keep feature, one body left.
    await mp.hover('#mc-tree .ft-row[data-id="body:e"]');
    await mp.click('#mc-tree .ft-row[data-id="body:e"] [data-a="bdel"]');
    await settle();
    const del = await mp.evaluate(() => ({ n: window.__sv.model.last().bodies.length, f: window.__sv.model.store.doc.features.map(f => f.name).join(","), bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    check(t0.folder === "Solid Bodies (2)" && t0.rows.join() === "Extrude1,Extrude2" && t0.faces === 9 && hid.faces.length === 6 && !hid.faces.some(n => n.startsWith("e:")) && Math.abs(hid.v - (8000 + Math.PI * 250)) < 0.1 && / sup/.test(hid.cls)
      && red === 6 && nm[0] === "Base plate" && nm[1] === "Base plate" && del.n === 1 && /Body-Delete\/Keep1/.test(del.f) && !del.bad,
      `model 1.60: Solid Bodies folder lists, hides, colours, renames and deletes bodies (FR-BODY-001) (${JSON.stringify({ t0, hid: { n: hid.faces.length, v: hid.v, cls: hid.cls }, red, nm, del })})`);
    // Insert part (FR-BODY-005): this part saved, then inserted into itself as a second body.
    await mp.evaluate(async () => { const b = await window.__sv.modeller.partBytes(); window.__sv.modeller.importBodyFile(new File([b], "plate.mcadprt")); });
    await mp.waitForFunction(() => window.__sv.model.mode().kind === "feature", null, { timeout: 120000 });
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const ip = await mp.evaluate(() => ({ n: window.__sv.model.last().bodies.length, v: window.__sv.model.last().props.volume, f: window.__sv.model.store.doc.features.at(-1)?.file, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    check(ip.n === 2 && Math.abs(ip.v - 16000) < 0.1 && ip.f === "plate.mcadprt" && !ip.bad, `model 1.61: Insert part puts a saved part in as a body (FR-BODY-005) (${JSON.stringify(ip)})`);
    await ctx.close();
  }

  // --- 1.62: assemblies (FRS 10, FR-ASM-001..005, FR-MATE-001/002): new assembly, insert parts and a STEP model, move, hide, undo, save and reopen ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Plate", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await mp.waitForTimeout(150);
    await idle();
    const part = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    // Make assembly from part: the open part becomes the first, fixed component.
    await mp.click("#new-more");
    const fpShown = await mp.isVisible("#new-asm-part");
    await mp.click("#new-asm-part");
    await mp.waitForFunction(() => window.__sv.asm.doc?.components.length === 1 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 1, null, { timeout: 120000 });
    const fp = await mp.evaluate(() => { const d = window.__sv.asm.doc; const c = d.components[0]; return { fixed: !!c.fixed, feats: d.parts[c.part].doc.features.length, model: document.querySelector("#app").classList.contains("model") }; });
    check(fpShown && fp.fixed && fp.feats >= 2 && !fp.model, `assembly: Make assembly from part puts the open part in a new assembly, fixed (${JSON.stringify({ fpShown, ...fp })})`);
    // New assembly closes the part; the Assembly tab and bar take over.
    await mp.click("#new-more");
    const fpHidden = await mp.isHidden("#new-asm-part");
    check(fpHidden, "assembly: Make assembly from part is offered only while a part is open");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    const swap = await mp.evaluate(() => ({ model: document.querySelector("#app").classList.contains("model"), tab: document.querySelector("#t-asm").getAttribute("aria-selected"), bar: !document.querySelector("#asm-bar").hidden, partBar: !document.querySelector("#mc-bar").hidden || !document.querySelector("#mc-empty").hidden }));
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), part);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), part);
    await shown(2);
    const cube = [...(await readFile(join(fixtures, "cube-10x10mm", "Cube 10x10.stp")))];
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "Cube 10x10.stp")), cube);
    await shown(3);
    const a0 = await mp.evaluate(() => ({ rows: [...document.querySelectorAll("#asm-tree .ft-comp .ft-name")].map(e => e.textContent), keys: Object.keys(window.__sv.asm.doc.parts).length, v: window.__sv.asm.props?.volume, status: document.querySelector("#asm-status").textContent, exact: window.__sv.viewer.parts[0].data.faces.filter(f => f.surface === "plane").length }));
    // Move the second plate by typing its pose: X = 100, 90° about Z.
    await mp.click("#asm-tree .ft-comp >> nth=1");
    await mp.click('#asm-tools [data-ac="move"]');
    await mp.fill('#asm-pm input[data-pose="x"]', "100");
    await mp.fill('#asm-pm input[data-pose="rz"]', "90");
    await mp.press('#asm-pm input[data-pose="rz"]', "Enter");
    await shown(3);
    const mv = await mp.evaluate(() => { const c = window.__sv.asm.doc.components[1], d = window.__sv.viewer.parts[1].data; return { tf: c.tf.map(v => Math.round(v * 1e6) / 1e6), min: d.bboxMin.map(v => Math.round(v * 1e3) / 1e3), max: d.bboxMax.map(v => Math.round(v * 1e3) / 1e3), pm: document.querySelector("#asm-pm").hidden }; });
    // Typing About X, then About Y = -90, then About Z keeps the X turn (the panel used to read X back as 0 there).
    await mp.click("#asm-tree .ft-comp >> nth=2");
    await mp.click('#asm-tools [data-ac="move"]');
    for (const [k, v] of [["rx", "60"], ["ry", "-90"], ["rz", "30"]]) {
      await mp.fill(`#asm-pm input[data-pose="${k}"]`, v);
      await mp.press(`#asm-pm input[data-pose="${k}"]`, "Tab");
      await shown(3);
    }
    const gim = await mp.evaluate(() => ({ rx: document.querySelector('#asm-pm input[data-pose="rx"]').value, tf: window.__sv.asm.doc.components[2].tf }));
    const rad = d => d * Math.PI / 180, [ax, ay, az] = [60, -90, 30].map(rad);
    // R = Rz·Ry·Rx, row-major
    const gimWant = [
      Math.cos(az) * Math.cos(ay), Math.cos(az) * Math.sin(ay) * Math.sin(ax) - Math.sin(az) * Math.cos(ax), Math.cos(az) * Math.sin(ay) * Math.cos(ax) + Math.sin(az) * Math.sin(ax),
      Math.sin(az) * Math.cos(ay), Math.sin(az) * Math.sin(ay) * Math.sin(ax) + Math.cos(az) * Math.cos(ax), Math.sin(az) * Math.sin(ay) * Math.cos(ax) - Math.cos(az) * Math.sin(ax),
      -Math.sin(ay), Math.cos(ay) * Math.sin(ax), Math.cos(ay) * Math.cos(ax)];
    const gimOk = gim.rx === "60" && [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i, k) => Math.abs(gim.tf[i] - gimWant[k]) < 1e-6);
    await mp.keyboard.press("Escape");
    for (let i = 0; i < 3; i++) { await mp.keyboard.press("ControlOrMeta+z"); await shown(3); }
    check(gimOk, `asm 1.189: Move component keeps the typed X turn at -90° about Y (${JSON.stringify(gim)})`);
    // Hide the cube from its row (it still counts in the mass properties), then undo.
    await mp.hover("#asm-tree .ft-comp >> nth=2");
    await mp.click('#asm-tree .ft-comp >> nth=2 >> [data-a="hide"]');
    await shown(2);
    const hid = await mp.evaluate(() => window.__sv.asm.props?.volume);
    await mp.keyboard.press("ControlOrMeta+z");
    await shown(3);
    // Save to bytes and reopen: the same components and poses.
    const re = await mp.evaluate(async () => {
      const sig = () => JSON.stringify(window.__sv.asm.doc.components.map(c => [c.id, c.name, c.part, c.tf, !!c.fixed, !!c.hidden]));
      const before = sig();
      const b = await window.__sv.asm.bytes();
      await window.__sv.asm.openFile({ name: "rig.mcadasm", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      return { same: sig() === before, doc: document.querySelector("#st-doc, .doc-name")?.textContent ?? "" };
    });
    await shown(3);
    // Opening a part leaves the assembly.
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !document.querySelector("#app").classList.contains("asm"));
    const left = await mp.evaluate(() => ({ asm: !!window.__sv.asm.doc, tab: document.querySelector("#t-asm").hidden }));
    check(!swap.model && swap.tab === "true" && swap.bar && !swap.partBar && a0.rows.join() === "(f) plate<1>,(-) plate<2>,(-) Cube 10x10<1>" && a0.keys === 2 && Math.abs(a0.v - 17000) < 1 && a0.status === "3 components · Under defined" && a0.exact > 0
      && mv.tf[3] === 100 && Math.abs(mv.tf[1] + 1) < 1e-6 && Math.abs(mv.min[0] - 90) < 0.01 && Math.abs(mv.max[0] - 110) < 0.01 && Math.abs(mv.min[1] + 20) < 0.01 && mv.pm
      && Math.abs(hid - 17000) < 1 && re.same && !left.asm && left.tab,
      `asm 1.62: new assembly, insert parts and STEP, move by pose, hide, undo, save and reopen (FR-ASM-001..005, FR-MATE-002) (${JSON.stringify({ swap, a0, mv, hid, re, left })})`);
    await ctx.close();
  }

  // --- 1.62: mates (FR-MATE-003/006/008/009, AT-P4-1/3): pick faces in the view, preview, DOF, conflict refused, constrained drag ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    // Two parts: a plate with a ⌀6 hole at (5, 0), and a ⌀6 × 20 pin.
    const makePart = async feats => {
      await mp.click("#new-part");
      await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), feats);
      await mp.waitForTimeout(150);
      await idle();
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    const plate = await makePart([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a"), P("h", 5, 0), { id: "hc", t: "circle", c: "h", r: 3 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }]);
    const pin = await makePart([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("o", 0, 0), { id: "c", t: "circle", c: "o", r: 3 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }]);
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin);
    await shown(2);
    await mp.evaluate(() => window.__sv.viewer.fit(false));
    await mp.waitForTimeout(200);
    // Screen point of a world point, and a point on a vertical cylinder facing the camera.
    const onCyl = (axis, r, out = true) => mp.evaluate(([a, rr, o]) => {
      const v = window.__sv.viewer, c = v.camera;
      c.updateMatrixWorld();
      const h = [c.position.x - a[0], c.position.y - a[1]], l = Math.hypot(h[0], h[1]), s = o ? 1 : -1;
      const p = [a[0] + (s * rr * h[0]) / l, a[1] + (s * rr * h[1]) / l, a[2]];
      const V = c.matrixWorldInverse.elements, Pm = c.projectionMatrix.elements;
      const mul = (M, x) => [0, 1, 2, 3].map(i => M[i] * x[0] + M[4 + i] * x[1] + M[8 + i] * x[2] + M[12 + i] * x[3]);
      const q = mul(Pm, mul(V, [...p, 1])), rect = v.renderer.domElement.getBoundingClientRect();
      return [rect.left + ((q[0] / q[3] + 1) / 2) * rect.width, rect.top + ((1 - q[1] / q[3]) / 2) * rect.height];
    }, [axis, r, out]);
    await mp.click('#asm-tools [data-ac="mate"]');
    const pinAt = await mp.evaluate(() => window.__sv.asm.doc.components[1].tf.filter((_, i) => i % 4 === 3));
    const p1 = await onCyl([pinAt[0], pinAt[1], pinAt[2] + 12], 3, true);
    await mp.mouse.click(p1[0], p1[1]);
    const p2 = await onCyl([5, 0, 9.3], 3, false);
    await mp.mouse.click(p2[0], p2[1]);
    await mp.waitForTimeout(100);
    const pick = await mp.evaluate(() => { const m = window.__sv.asm.mating, g = window.__sv.viewer.parts[1].group.position; return { a: m.a?.comp, b: m.b?.comp, type: m.type, title: document.querySelector("#asm-pm h3")?.textContent, boxes: [...document.querySelectorAll("#asm-pm .pm-box")].map(e => e.textContent), moved: Math.hypot(g.x, g.y, g.z) > 1, picks: window.__sv.viewer.parts.reduce((s, p) => s + p.group.children.filter(o => o.userData.matePick).length, 0) }; });
    await mp.click("#asm-pm [data-a=ok]");
    await shown(2);
    // Coincident: plate top on the pin's bottom face (picked by name), then close the panel with ✓.
    const ref = await mp.evaluate(() => {
      const a = window.__sv.asm, d = a.doc, faces = (k, f) => [...a.geo.get(k).entries()].find(([, g]) => f(g))?.[0];
      return { top: faces(d.components[0].part, g => g.k === "plane" && g.n[2] > 0.99 && Math.abs(g.p[2] - 10) < 1e-6), bottom: faces(d.components[1].part, g => g.k === "plane" && g.n[2] < -0.99) };
    });
    await mp.evaluate(r => { const a = window.__sv.asm; Object.assign(a.mating, { a: { comp: a.doc.components[0].id, face: r.top }, b: { comp: a.doc.components[1].id, face: r.bottom } }); a.setMateType("coincident"); a.okMate(); }, ref);
    await shown(2);
    await mp.click("#asm-pm [data-a=ok]");
    const m2 = await mp.evaluate(() => { const a = window.__sv.asm, t = a.doc.components[1].tf; return { n: a.doc.mates.length, types: a.doc.mates.map(m => m.type).join(), dof: a.solved.dof[a.doc.components[1].id], at: [t[3], t[7], t[11]].map(v => Math.round(v * 1e4) / 1e4), mark: document.querySelectorAll("#asm-tree .ft-comp .ft-name")[1].textContent, rows: document.querySelectorAll("#asm-tree .ft-mate").length, status: document.querySelector("#asm-status").textContent, panel: document.querySelector("#asm-pm").hidden }; });
    // A conflicting distance mate is refused and nothing moves (AT-P4-3).
    const conflict = await mp.evaluate(r => { const a = window.__sv.asm; a.startMate(); Object.assign(a.mating, { a: { comp: a.doc.components[0].id, face: r.top }, b: { comp: a.doc.components[1].id, face: r.bottom } }); a.setMateType("distance"); a.mating.value = 5; a.okMate(); return { n: a.doc.mates.length, problem: a.mating?.problem ?? "", err: document.querySelector("#asm-pm [data-mstatus]")?.className }; }, ref);
    await mp.evaluate(() => window.__sv.asm.cancelMate());
    // Dragging the mated pin sideways: it cannot leave the hole axis (FR-MATE-001).
    const p3 = await onCyl([5, 0, 20], 3, true);
    await mp.mouse.move(p3[0], p3[1]);
    await mp.mouse.down();
    await mp.mouse.move(p3[0] + 60, p3[1] + 10, { steps: 5 });
    await mp.mouse.up();
    await shown(2);
    const drag = await mp.evaluate(() => { const t = window.__sv.asm.doc.components[1].tf; return [t[3], t[7], t[11]].map(v => Math.round(v * 1e4) / 1e4); });
    // Delete the coincident mate from the tree: the pin can slide along the axis again.
    await mp.hover("#asm-tree .ft-mate >> nth=1");
    await mp.click('#asm-tree .ft-mate >> nth=1 >> [data-a="del"]');
    await shown(2);
    const after = await mp.evaluate(() => ({ n: window.__sv.asm.doc.mates.length, dof: window.__sv.asm.solved.dof[window.__sv.asm.doc.components[1].id] }));
    const re = await mp.evaluate(async () => { const b = await window.__sv.asm.bytes(); await window.__sv.asm.openFile({ name: "m.mcadasm", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }); return window.__sv.asm.doc.mates?.map(m => m.type).join(); });
    check(pick.a && pick.b && pick.a !== pick.b && pick.type === "concentric" && pick.title === "Mate" && pick.boxes.every(t => /: Cylindrical face$/.test(t)) && pick.moved && pick.picks === 2
      && m2.n === 2 && m2.types === "concentric,coincident" && m2.dof === 1 && Math.abs(m2.at[0] - 5) < 1e-3 && Math.abs(m2.at[1]) < 1e-3 && Math.abs(m2.at[2] - 10) < 1e-3 && m2.mark === "(-) pin<1>" && m2.rows === 2 && m2.status === "2 components · Under defined" && m2.panel
      && conflict.n === 2 && /over-defined/.test(conflict.problem) && conflict.err === "pm-err"
      && Math.abs(drag[0] - 5) < 1e-3 && Math.abs(drag[1]) < 1e-3 && Math.abs(drag[2] - 10) < 1e-3 && after.n === 1 && after.dof === 2 && re === "concentric",
      `asm 1.62: mates picked in the view, previewed, DOF, conflict refused, constrained drag, delete (FR-MATE-003/008, AT-P4-1/3) (${JSON.stringify({ pick, m2, conflict, drag, after, re })})`);
    await ctx.close();
  }

  // --- 1.63: interference detection, BOM and assembly STEP (FR-ASM-020/024, AT-P4-4..6) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Box", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.props.partNumber = "BX-10";
      d.material = { name: "Aluminium 6061", density: 2.7 };
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -5, -5), P("b", 5, -5), P("c", 5, 5), P("d", -5, 5), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const box = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    for (let k = 1; k <= 2; k++) { await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "box.mcadprt")), box); await shown(k); }
    // Second box 1 mm into the first: X = 9 (the first spans -5..5).
    await mp.evaluate(() => { const a = window.__sv.asm, id = a.doc.components[1].id; a.change(d => { d.components[1].tf = [1, 0, 0, 9, 0, 1, 0, 0, 0, 0, 1, 0]; }); return id; });
    await shown(2);
    await mp.click('#asm-tools [data-ac="interfere"]');
    await mp.waitForFunction(() => window.__sv.asm.interfere?.pairs, null, { timeout: 120000 });
    const inf = await mp.evaluate(() => ({ title: document.querySelector("#asm-pm h3")?.textContent, status: document.querySelector("#asm-pm [data-istatus]")?.textContent, rows: [...document.querySelectorAll("#asm-pm [data-pair]")].map(e => e.textContent), v: window.__sv.asm.interfere.pairs[0]?.volume }));
    await mp.click("#asm-pm [data-a=ok]");
    // BOM: one row, quantity 2, mass from the part's material.
    await mp.click('#asm-tools [data-ac="bom"]');
    const bom = await mp.evaluate(() => ({ open: document.querySelector("#asm-bom").open, cells: [...document.querySelectorAll("#asm-bom tbody td")].map(e => e.textContent), csv: window.__sv.asm.bomCsvText() }));
    await mp.click('#asm-bom [data-a="close"]');
    // STEP of the assembly reopens with the same names and placements (AT-P4-6).
    const step = [...await mp.evaluate(async () => [...await window.__sv.asm.stepBytes()])];
    await mp.setInputFiles("#file-input", { name: "rig.step", mimeType: "model/step", buffer: Buffer.from(step) });
    await mp.waitForFunction(() => !window.__sv.asm.doc && window.__sv.viewer.parts.length === 2, null, { timeout: 120000 });
    const re = await mp.evaluate(() => { const flat = n => [n.name, ...n.children.flatMap(flat)]; return { tree: flat(window.__sv.viewer.tree), parts: window.__sv.viewer.parts.map(p => ({ name: p.data.name, x: [Math.round(p.data.bboxMin[0] * 1000) / 1000, Math.round(p.data.bboxMax[0] * 1000) / 1000] })) }; });
    check(inf.title === "Interference detection" && inf.status === "1 interference · 100 mm³" && inf.rows.length === 1 && /^box<1> ↔ box<2>: 100 mm³$/.test(inf.rows[0]) && Math.abs(inf.v - 100) < 1e-6
      && bom.open && bom.cells.join("|") === "1|box|BX-10||Aluminium 6061|2|0.0027|" && bom.csv.split("\r\n")[1] === "1,box,BX-10,,Aluminium 6061,2,0.002700,,"
      && re.parts.map(p => p.name).join() === "box,box" && re.tree.includes("Assembly1") && Math.abs(re.parts[1].x[0] - 4) < 1e-3 && Math.abs(re.parts[1].x[1] - 14) < 1e-3,
      `asm 1.63: interference finds the 1 mm overlap, BOM counts and weighs, assembly STEP reopens placed (FR-ASM-020/024, AT-P4-4..6) (${JSON.stringify({ inf, bom, re })})`);
    await ctx.close();
  }

  // --- 1.63: component patterns and exploded views (FR-ASM-022/023, AT-P4-5) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const makePart = async feats => {
      await mp.click("#new-part");
      await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), feats);
      await mp.waitForTimeout(150);
      await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    const plate = await makePart([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -20), P("b", 20, -20), P("c", 20, 20), P("d", -20, 20), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a"), P("h", 0, 0), { id: "hc", t: "circle", c: "h", r: 4 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }]);
    const pin = await makePart([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("o", 0, 0), { id: "c", t: "circle", c: "o", r: 2 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }]);
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin);
    await shown(2);
    // The pin at (12, 0, 5); a circular pattern of 4 about the plate's hole axis.
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 12, 0, 1, 0, 0, 0, 0, 1, 5]; }));
    await shown(2);
    await mp.click("#asm-tree .ft-comp >> nth=1");
    await mp.click('#asm-tools [data-ac="pattern"]');
    await mp.click('#asm-pm [data-pk="circular"]');
    await mp.evaluate(() => { const a = window.__sv.asm, d = a.doc, hole = [...a.geo.get(d.components[0].part).entries()].find(([, g]) => g.k === "axis")[0]; a.patterning.dir = { comp: d.components[0].id, face: hole }; a.drawPatternPreview(); a.renderAll(); });
    const pv = await mp.evaluate(() => ({ title: document.querySelector("#asm-pm h3")?.textContent, ghosts: window.__sv.asm.overlay.children.length, seeds: document.querySelector('#asm-pm [data-focus="seeds"]')?.textContent }));
    await mp.click("#asm-pm [data-a=ok]");
    await shown(5);
    const pat = await mp.evaluate(() => {
      const v = window.__sv.viewer.parts.map(p => { const c = [(p.data.bboxMin[0] + p.data.bboxMax[0]) / 2, (p.data.bboxMin[1] + p.data.bboxMax[1]) / 2]; return c.map(x => Math.round(x * 1000) / 1000); });
      return { name: window.__sv.asm.doc.patterns[0].name, inst: [...document.querySelectorAll("#asm-tree .ft-inst .ft-name")].map(e => e.textContent), at: v.slice(1), bom: window.__sv.asm.bom().map(r => `${r.part}:${r.qty}`).join() };
    });
    // Auto explode, then collapse from the tree.
    await mp.click('#asm-tools [data-ac="explode"]');
    await mp.click('#asm-pm [data-a="auto"]');
    const steps = await mp.evaluate(() => window.__sv.asm.exploding.steps.length);
    await mp.click("#asm-pm [data-a=ok]");
    await shown(5);
    await mp.waitForTimeout(100);
    const ex = await mp.evaluate(() => ({ row: document.querySelector("#asm-tree .ft-explode")?.className, moved: window.__sv.viewer.parts.slice(1).every(p => p.group.position.length() > 5), plate: window.__sv.viewer.parts[0].group.position.length() }));
    await mp.hover("#asm-tree .ft-explode");
    await mp.click('#asm-tree .ft-explode [data-a="xp"]');
    await mp.waitForTimeout(800);
    const col = await mp.evaluate(() => ({ exploded: window.__sv.asm.exploded, back: window.__sv.viewer.parts.every(p => p.group.position.length() < 1e-6) }));
    const re = await mp.evaluate(async () => { const b = await window.__sv.asm.bytes(); await window.__sv.asm.openFile({ name: "p.mcadasm", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }); return [window.__sv.asm.doc.patterns?.length, window.__sv.asm.doc.explodes?.[0]?.steps.length]; });
    await shown(5);
    check(pv.title === "Circular component pattern" && pv.ghosts === 3 && pv.seeds === "pin<1>" && pat.name === "CircPattern1" && pat.inst.join() === "pin<2>,pin<3>,pin<4>"
      && JSON.stringify(pat.at) === JSON.stringify([[12, 0], [0, 12], [-12, 0], [0, -12]]) && pat.bom === "plate:1,pin:4"
      && steps === 4 && / on/.test(ex.row) && ex.moved && ex.plate < 1e-9 && col.exploded === null && col.back && re[0] === 1 && re[1] === 4,
      `asm 1.63: circular component pattern previewed and counted in the BOM, auto explode and collapse (FR-ASM-022/023, AT-P4-5) (${JSON.stringify({ pv, pat, steps, ex, col, re })})`);
    await ctx.close();
  }

  // --- 1.65: sub-assemblies, replace, suppress, colour, BOM modes (FR-ASM-001/006/008/024) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    await mp.evaluate(() => window.__sv.model.store.change("Part", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", 0, 0), P("b", 10, 0), P("c", 10, 10), P("d", 0, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await mp.waitForTimeout(150);
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const box = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    const newAsm = async () => { await mp.click("#new-more"); await mp.click("#new-asm"); await mp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length); };
    const insert = (b, name) => mp.evaluate(([b, name]) => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], name)), [b, name]);
    // Assembly A: two boxes, the second 20 mm along X.
    await newAsm();
    await insert(box, "box.mcadprt");
    await shown(1);
    await insert(box, "box.mcadprt");
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]; }));
    await shown(2);
    const A = [...await mp.evaluate(async () => [...await window.__sv.asm.bytes()])];
    // Assembly B: a box, then A as a sub-assembly placed 50 mm along Y.
    await newAsm();
    await insert(box, "box.mcadprt");
    await shown(1);
    await insert(A, "A.mcadasm");
    await shown(3);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1, 0]; }));
    await shown(3);
    const sub = await mp.evaluate(() => {
      const r = n => Math.round(n * 1000) / 1000;
      const a = window.__sv.asm;
      return {
        sub: [...document.querySelectorAll("#asm-tree .ft-sub .ft-name")].map(e => e.textContent),
        kids: [...document.querySelectorAll("#asm-tree .ft-sub + .ft-group .ft-inst .ft-name")].map(e => e.textContent),
        at: window.__sv.viewer.parts.map(p => [r(p.data.bboxMin[0]), r(p.data.bboxMin[1])]),
        top: a.bom("top").map(x => `${x.part}:${x.qty}`).join(), parts: a.bom("parts").map(x => `${x.part}:${x.qty}`).join(),
        v: Math.round(a.props?.volume ?? 0),
      };
    });
    // Colour the sub-assembly: its parts take it.
    const subId = await mp.evaluate(() => window.__sv.asm.doc.components[1].id);
    await mp.evaluate(id => window.__sv.asm.setColor(id, [1, 0, 0]), subId);
    await shown(3);
    const col = await mp.evaluate(() => window.__sv.asm.expanded.doc.components.filter(c => c.color?.[0] === 1).length);
    // Suppress the top box: it leaves the view and the BOM.
    const boxId = await mp.evaluate(() => window.__sv.asm.doc.components[0].id);
    await mp.evaluate(id => window.__sv.asm.setSuppressed(id, true), boxId);
    await shown(2);
    const sup = await mp.evaluate(() => ({ parts: window.__sv.asm.bom("parts").map(x => `${x.part}:${x.qty}`).join(), row: document.querySelector("#asm-tree .ft-comp")?.className }));
    await mp.evaluate(id => window.__sv.asm.setSuppressed(id, false), boxId);
    await shown(3);
    // Replace the top box with the 10 mm cube STEP.
    const cube = [...(await readFile(join(fixtures, "cube-10x10mm", "Cube 10x10.stp")))];
    await mp.evaluate(([b, id]) => window.__sv.asm.replaceComponent(id, new File([new Uint8Array(b)], "Cube 10x10.stp")), [cube, boxId]);
    await mp.waitForFunction(() => window.__sv.asm.doc.components[0].name.startsWith("Cube"), null, { timeout: 120000 });
    await shown(3);
    const rep = await mp.evaluate(() => ({ name: window.__sv.asm.doc.components[0].name, keys: Object.keys(window.__sv.asm.doc.parts).length, top: window.__sv.asm.bom("top").map(x => `${x.part}:${x.qty}`).join() }));
    const re = await mp.evaluate(async () => { const b = await window.__sv.asm.bytes(); await window.__sv.asm.openFile({ name: "b.mcadasm", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }); return window.__sv.asm.doc.components.length; });
    await shown(3);
    check(sub.sub.join() === "(-) A<1>" && sub.kids.join() === "box<1>,box<2>" && JSON.stringify(sub.at) === JSON.stringify([[0, 0], [0, 50], [20, 50]])
      && sub.top === "box:1,A:1" && sub.parts === "box:3" && sub.v === 3000 && col === 2 && sup.parts === "box:2" && / sup/.test(sup.row)
      && rep.name === "Cube 10x10<1>" && rep.keys === 2 && rep.top === "Cube 10x10:1,A:1" && re === 2,
      `asm 1.65: sub-assembly placed rigidly with its parts in the tree, BOM top level and parts only, colour, suppress, replace (FR-ASM-001/006/008/024) (${JSON.stringify({ sub, col, sup, rep, re })})`);
    await ctx.close();
  }

  // --- 1.74: flexible sub-assemblies (FR-ASM-006), linked components (FR-ASM-003, FR-IO-011) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const cubePart = async h => {
      await mp.evaluate(h => window.__sv.model.store.change("Part", d => {
        const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
        d.features = [{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", 0, 0), P("b", 10, 0), P("c", 10, 10), P("d", 0, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
          { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: h } }];
      }), h);
      await mp.waitForTimeout(150);
      await mp.waitForFunction(h => document.querySelector("#mc-busy").hidden && Math.abs((window.__sv.model.last()?.props?.volume ?? 0) - 100 * h) < 1e-6, h, { timeout: 120000 });
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const tall = await cubePart(20);
    const box = await cubePart(10);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    const newAsm = async () => { await mp.click("#new-more"); await mp.click("#new-asm"); await mp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length); };
    const insert = (b, name) => mp.evaluate(([b, name]) => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], name)), [b, name]);
    // Sub-assembly A: a fixed box and a floating box 20 mm along X.
    await newAsm();
    await insert(box, "box.mcadprt");
    await shown(1);
    await insert(box, "box.mcadprt");
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]; }));
    await shown(2);
    const A = [...await mp.evaluate(async () => [...await window.__sv.asm.bytes()])];
    // Parent: a fixed box, A 50 mm along Y, made flexible; A's floating box is put on top of the parent box.
    await newAsm();
    await insert(box, "box.mcadprt");
    await shown(1);
    await insert(A, "A.mcadasm");
    await shown(3);
    const ids = await mp.evaluate(() => { const a = window.__sv.asm; a.change(d => { d.components[1].tf = [1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1, 0]; d.components[1].fixed = true; }); return { top: a.doc.components[0].id, sub: a.doc.components[1].id, kid: a.doc.parts[a.doc.components[1].part].asm.components[1].id }; });
    await shown(3);
    const zOf = () => mp.evaluate(id => { const i = window.__sv.asm.shownIds.indexOf(id); return Math.round(window.__sv.viewer.parts[i].data.bboxMin[2] * 1000) / 1000; }, `${ids.sub}/${ids.kid}`);
    await mp.evaluate(ids => window.__sv.asm.setFlexible(ids.sub, true), ids);
    await shown(3);
    await mp.evaluate(ids => window.__sv.asm.change(d => { d.mates = [{ id: "m1", name: "Coincident1", type: "coincident", align: "anti", a: { comp: ids.top, face: "x:end" }, b: { comp: `${ids.sub}/${ids.kid}`, face: "x:start" } }]; }), ids);
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id); return !a.building && i >= 0 && Math.abs(window.__sv.viewer.parts[i].data.bboxMin[2] - 10) < 1e-3; }, `${ids.sub}/${ids.kid}`, { timeout: 120000 });
    const flex = { z: await zOf(), mark: await mp.evaluate(() => document.querySelector("#asm-tree .ft-flexible .ft-flex")?.textContent ?? null), ok: await mp.evaluate(() => !!window.__sv.asm.solved?.ok) };
    // Rigid again: the box goes back where A has it, and the mate cannot reach it.
    await mp.evaluate(ids => window.__sv.asm.setFlexible(ids.sub, false), ids);
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id); return !a.building && i >= 0 && Math.abs(window.__sv.viewer.parts[i].data.bboxMin[2]) < 1e-3; }, `${ids.sub}/${ids.kid}`, { timeout: 120000 });
    const rigid = { z: await zOf(), missing: await mp.evaluate(() => window.__sv.asm.solved?.missing ?? []) };
    check(flex.z === 10 && flex.mark === "flexible" && flex.ok && rigid.z === 0 && rigid.missing.includes("m1"),
      `asm 1.74: flexible sub-assembly solves its parts with the parent's mates; rigid puts them back (FR-ASM-006) (${JSON.stringify({ flex, rigid })})`);
    // Linked component: link the top box to box.mcadprt, change the file to a 20 mm tall box and update links from the folder.
    await mp.evaluate(ids => window.__sv.asm.change(d => { delete d.mates; }), ids);
    await mp.evaluate(([b, id]) => window.__sv.asm.linkComponent(id, new File([new Uint8Array(b)], "box.mcadprt")), [box, ids.top]);
    await mp.waitForFunction(() => Object.values(window.__sv.asm.doc.parts).some(p => p.link));
    await mp.evaluate(([b]) => { const f = new File([new Uint8Array(b)], "box.mcadprt"); Object.defineProperty(f, "webkitRelativePath", { value: "proj/parts/box.mcadprt" }); window.__sv.asm.updateLinks([f, new File(["x"], "other.txt")]); }, [tall]);
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id); return !a.building && i >= 0 && Math.abs(window.__sv.viewer.parts[i].data.bboxMax[2] - 20) < 1e-3; }, ids.top, { timeout: 120000 });
    const linked = await mp.evaluate(id => { const a = window.__sv.asm, c = a.doc.components.find(x => x.id === id), p = a.doc.parts[c.part]; return { path: p.link?.path, hash: p.link?.hash?.length, row: !!document.querySelector(`#asm-tree [data-id="${id}"] .ft-link`) }; }, ids.top);
    // A folder without the file: the link is marked missing and the last copy stays.
    await mp.evaluate(() => window.__sv.asm.updateLinks([new File(["x"], "other.txt")]));
    await mp.waitForFunction(id => !!document.querySelector(`#asm-tree [data-id="${id}"] .ft-link.ft-err`), ids.top);
    const gone = await mp.evaluate(() => window.__sv.viewer.parts.length);
    // Saved and opened again, the link is kept; Embed drops it.
    const re = await mp.evaluate(async id => { const a = window.__sv.asm, b = await a.bytes(); await a.openFile({ name: "p.mcadasm", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }); const c = a.doc.components.find(x => x.id === id); const kept = !!a.doc.parts[c.part].link; a.setLink(c.part, null); return { kept, embedded: !a.doc.parts[c.part].link }; }, ids.top);
    check(linked.path === "parts/box.mcadprt" && linked.hash === 64 && linked.row && gone === 3 && re.kept && re.embedded,
      `asm 1.74: linked component reads its file again when it changed, marks it missing, embeds (FR-ASM-003, FR-IO-011) (${JSON.stringify({ linked, gone, re })})`);
    await ctx.close();
  }

  // --- 1.81: assembly features (FR-ASM-027), assembly configurations (FR-ASM-026) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ap = await ctx.newPage();
    ap.on("pageerror", e => errors.push(e.message));
    ap.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await ap.goto(`${origin}/index.html?debug`);
    await ap.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await ap.goto(`${origin}/index.html?debug`);
    await ap.waitForFunction(() => window.__sv);
    const partOf = async (w, h, d) => {
      await ap.click("#new-part");
      await ap.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await ap.evaluate(([w, h, d]) => window.__sv.model.store.change("Part", doc => {
        const pt = (id, x, y) => ({ id, t: "point", x, y }), ln = (id, a, b) => ({ id, t: "line", a, b });
        doc.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [pt("a", 0, 0), pt("b", w, 0), pt("c", w, h), pt("d", 0, h), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d"), ln("l4", "d", "a")] },
          { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: d } });
      }), [w, h, d]);
      await ap.waitForTimeout(150);
      await ap.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
      return [...await ap.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const plate = await partOf(40, 20, 5), block = await partOf(10, 10, 10);
    const shown = n => ap.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await ap.click("#new-more");
    await ap.click("#new-asm");
    await ap.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length);
    await ap.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await ap.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "block.mcadprt")), block);
    await shown(2);
    // The block on the plate's corner; an M6 cap screw (a part with configurations) off to the side.
    await ap.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5]; }));
    await shown(2);
    await ap.evaluate(() => { const a = window.__sv.asm; a.startFasteners(); a.setFastener({ kind: "iso4762", size: "M6", length: 12 }); a.insertFastener([1, 0, 0, 80, 0, 1, 0, 0, 0, 0, 1, 0]); a.closeTools(); });
    await shown(3);
    const v0 = await ap.evaluate(() => window.__sv.asm.props.volume);
    // Assembly hole Ø4 through all from the block's top: it cuts the block and the plate.
    await ap.click('#asm-tools [data-ac="afeat"]');
    const title = await ap.evaluate(() => {
      const a = window.__sv.asm, c = a.doc.components, top = [...a.geo.get(c[1].part).entries()].find(([, g]) => g.k === "plane" && g.n[2] > 0.99)[0];
      Object.assign(a.featuring, { ref: { comp: c[1].id, face: top }, at: [5, 5, 10], n: [0, 0, 1], x: [1, 0, 0], dia: 4 });
      a.renderAll();
      return document.querySelector("#asm-pm h3")?.textContent;
    });
    await ap.evaluate(() => window.__sv.asm.okFeature());
    await ap.waitForFunction(() => window.__sv.asm.doc.features?.length === 1 && window.__sv.asm.featStatus.length === 1, null, { timeout: 120000 });
    await shown(3);
    const feat = await ap.evaluate(v0 => { const a = window.__sv.asm, c = a.doc.components; return { cut: a.featStatus[0].cut.map(id => c.findIndex(x => x.id === id)), dv: Math.round((v0 - a.props.volume) * 1000) / 1000, row: !!document.querySelector(`#asm-tree .ft-afeat[data-id="${a.doc.features[0].id}"]`), wall: [...a.geo.get(c[0].part).keys()].some(k => k.includes(":t")) }; }, v0);
    // Configurations: in "Configuration 2" the hole is suppressed and the screw is M10; Default brings both back.
    const cfg = await ap.evaluate(async () => {
      const a = window.__sv.asm, sid = a.doc.components[2].id;
      const id = a.addAsmConfig();
      a.change(d => { d.features[0].suppressed = true; });
      a.setComponentConfig(sid, "M10");
      await a.idle;
      const label = () => document.querySelector(`#asm-tree .ft-row[data-id="${sid}"] .ft-name`)?.textContent;
      const inCfg2 = { active: a.doc.activeConfig === id, sup: !!a.doc.features[0].suppressed, label: label(), configs: document.querySelectorAll("#asm-tree .ft-config").length };
      a.activateAsmConfig("cf_default");
      await a.idle;
      const inDef = { sup: !!a.doc.features[0].suppressed, label: label(), parts: Object.keys(a.doc.parts).length };
      a.activateAsmConfig(id);
      await a.idle;
      return { inCfg2, inDef, back: label() };
    });
    await shown(3);
    check(title === "Assembly hole" && JSON.stringify(feat.cut) === "[0,1]" && Math.abs(feat.dv - 60 * Math.PI) < 0.05 && feat.row && feat.wall
      && cfg.inCfg2.active && cfg.inCfg2.sup && /\(M10\)$/.test(cfg.inCfg2.label ?? "") && cfg.inCfg2.configs === 2
      && !cfg.inDef.sup && /\(M6\)$/.test(cfg.inDef.label ?? "") && cfg.inDef.parts === 4 && /\(M10\)$/.test(cfg.back ?? ""),
      `asm 1.81: an assembly hole cuts the block and the plate; assembly configurations swap feature suppression and the screw's size (FR-ASM-027, FR-ASM-026) (${JSON.stringify({ title, feat, cfg })})`);
    await ctx.close();
  }

  // --- 1.79: fastener library (FR-ASM-028), mate references (FR-MATE-011) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const fp = await ctx.newPage();
    fp.on("pageerror", e => errors.push(e.message));
    fp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await fp.goto(`${origin}/index.html?debug`);
    await fp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await fp.goto(`${origin}/index.html?debug`);
    await fp.waitForFunction(() => window.__sv);
    const partOf = async features => {
      await fp.click("#new-part");
      await fp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await fp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), features);
      await fp.waitForTimeout(150);
      await fp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
      return [...await fp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    // A 40 × 20 × 5 plate with two Ø6.4 holes at x = 10 and 30; a Ø6 × 20 pin.
    const pt = (id, x, y) => ({ id, t: "point", x, y }), ln = (id, a, b) => ({ id, t: "line", a, b });
    const plate = await partOf([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [pt("a", 0, 0), pt("b", 40, 0), pt("c", 40, 20), pt("d", 0, 20), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d"), ln("l4", "d", "a"),
      pt("h1", 10, 10), { id: "k1", t: "circle", c: "h1", r: 3.2 }, pt("h2", 30, 10), { id: "k2", t: "circle", c: "h2", r: 3.2 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }]);
    const pin = await partOf([{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [pt("o", 0, 0), { id: "c", t: "circle", c: "o", r: 3 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } }]);
    const shown = n => fp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await fp.click("#new-more");
    await fp.click("#new-asm");
    await fp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length);
    await fp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    // Fastener panel: ISO 4762 M6 x 12 on hole 1 from the top, then an ISO 4032 nut on its bottom end.
    await fp.click('#asm-tools [data-ac="fastener"]');
    const panel = await fp.evaluate(() => {
      window.__sv.asm.setFastener({ kind: "iso4762", size: "M6", length: 12 });
      return { kinds: document.querySelectorAll('#asm-pm select[data-f="kind"] option').length, sizes: document.querySelectorAll('#asm-pm select[data-f="size"] option').length, len: document.querySelector('#asm-pm select[data-f="length"]')?.value };
    });
    const hole = (x, z) => fp.evaluate(([x, z]) => {
      const a = window.__sv.asm, d = window.__sv.viewer.parts[0].data;
      const j = d.faces.findIndex(f => f.type === "cylinder" && Math.abs(f.center[0] - x) < 0.01 && Math.abs(f.center[1] - 10) < 0.01);
      a.fastenHole(0, j, [x + 3.2, 10, z]);
    }, [x, z]);
    await hole(10, 4.5);
    await shown(2);
    await fp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 2 && !window.__sv.asm.building, null, { timeout: 120000 });
    await fp.evaluate(() => window.__sv.asm.setFastener({ kind: "iso4032" }));
    await hole(10, 0.5);
    await shown(3);
    await fp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 4 && !window.__sv.asm.building, null, { timeout: 120000 });
    await shown(3);
    const fast = await fp.evaluate(() => {
      const a = window.__sv.asm, c = a.doc.components, r = v => Math.round(v * 1e3) / 1e3;
      const at = k => { const t = c[k].tf; return [t[3], t[7], t[11], t[10]].map(r); };
      return { names: c.map(x => x.name), mates: a.doc.mates.map(m => m.type), screw: at(1), nut: at(2), dof: [a.solved?.dof[c[1].id], a.solved?.dof[c[2].id]], status: document.querySelector("#asm-pm [data-fstatus]")?.textContent, configs: a.doc.parts[c[1].part].doc.configs?.length };
    });
    await fp.evaluate(() => window.__sv.asm.closeTools());
    // Mate references: the plate names hole 2 + its top face "Pin", a pin names its side + bottom "Pin";
    // a second pin inserted with the plate selected mates itself onto hole 2.
    await fp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin);
    await shown(4);
    const refs = await fp.evaluate(() => {
      const a = window.__sv.asm, c = a.doc.components, gp = [...a.geo.get(c[0].part).entries()], gn = [...a.geo.get(c[3].part).entries()];
      a.startMateRef(c[0].id);
      const title = document.querySelector("#asm-pm h3")?.textContent;
      Object.assign(a.refing, { name: "Pin", faces: [gp.find(([, g]) => g.k === "axis" && Math.abs(g.p[0] - 30) < 0.01)[0], gp.find(([, g]) => g.k === "plane" && g.n[2] > 0.99)[0]] });
      a.okMateRef();
      a.startMateRef(c[3].id);
      Object.assign(a.refing, { name: "Pin", faces: [gn.find(([, g]) => g.k === "axis")[0], gn.find(([, g]) => g.k === "plane" && g.n[2] < -0.99)[0]] });
      a.okMateRef();
      return { title, plate: a.doc.parts[c[0].part].doc.mateRefs?.[0]?.faces.length, pin: a.doc.parts[c[3].part].doc.mateRefs?.[0]?.faces.length };
    });
    await shown(4);
    await fp.evaluate(() => { const a = window.__sv.asm, c = a.doc.components; a.selected = c[0].id; a.insertPart(structuredClone(a.doc.parts[c[3].part].doc), "pin.mcadprt"); });
    await shown(5);
    await fp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 6 && !window.__sv.asm.building, null, { timeout: 120000 });
    await shown(5);
    const auto = await fp.evaluate(() => { const a = window.__sv.asm, c = a.doc.components, t = c[4].tf, r = v => Math.round(v * 1e3) / 1e3; return { mates: a.doc.mates.slice(4).map(m => [m.type, m.a.comp === c[0].id, m.b.comp === c[4].id]), at: [t[3], t[7], t[11]].map(r) }; });
    check(panel.kinds === 17 && panel.sizes === 11 && panel.len === "12"
      && /^ISO 4762 M6 x 12<1>$/.test(fast.names[1]) && /^ISO 4032 M6<1>$/.test(fast.names[2]) && JSON.stringify(fast.mates) === '["concentric","coincident","concentric","coincident"]'
      && JSON.stringify(fast.screw) === "[10,10,5,1]" && JSON.stringify(fast.nut) === "[10,10,0,-1]" && JSON.stringify(fast.dof) === "[1,1]" && /2 parts placed/.test(fast.status ?? "") && fast.configs === 11
      && refs.title === "Mate reference" && refs.plate === 2 && refs.pin === 2
      && JSON.stringify(auto.mates) === '[["concentric",true,true],["coincident",true,true]]' && JSON.stringify(auto.at) === "[30,10,5]",
      `asm 1.79: ISO fasteners placed on a hole with concentric + coincident mates; mate references mate a part on insert (FR-ASM-028, FR-MATE-011) (${JSON.stringify({ panel, fast, refs, auto })})`);
    await ctx.close();
  }

  // --- 1.158: toolbox (FR-ASM-028): size from the hole, flush parts; McMaster-Carr STEP drop-in ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tp = await ctx.newPage();
    tp.on("pageerror", e => errors.push(e.message));
    tp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await tp.goto(`${origin}/index.html?debug`);
    await tp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await tp.goto(`${origin}/index.html?debug`);
    await tp.waitForFunction(() => window.__sv);
    // A 60 × 40 × 10 block with a Ø32 bearing bore at x = 20 and a Ø6 pin hole at x = 48.
    await tp.click("#new-part");
    await tp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const pt = (id, x, y) => ({ id, t: "point", x, y }), ln = (id, a, b) => ({ id, t: "line", a, b });
    await tp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), [
      { id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [pt("a", 0, 0), pt("b", 60, 0), pt("c", 60, 40), pt("d", 0, 40), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d"), ln("l4", "d", "a"),
        pt("h1", 20, 20), { id: "k1", t: "circle", c: "h1", r: 16 }, pt("h2", 48, 20), { id: "k2", t: "circle", c: "h2", r: 3 }] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }]);
    await tp.waitForTimeout(150);
    await tp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const block = [...await tp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    const shown = n => tp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await tp.click("#new-more");
    await tp.click("#new-asm");
    await tp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length);
    await tp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "block.mcadprt")), block);
    await shown(1);
    await tp.click('#asm-tools [data-ac="fastener"]');
    const hole = (x, r, z) => tp.evaluate(([x, r, z]) => {
      const a = window.__sv.asm, d = window.__sv.viewer.parts[0].data;
      const j = d.faces.findIndex(f => f.type === "cylinder" && Math.abs(f.center[0] - x) < 0.01 && Math.abs(f.center[1] - 20) < 0.01);
      a.fastenHole(0, j, [x + r, 20, z]);
    }, [x, r, z]);
    // A 625 bearing picked, the Ø32 bore clicked near the top: the size follows the bore (62xx series kept: 6201).
    const panel = await tp.evaluate(() => {
      window.__sv.asm.setFastener({ kind: "bearing", size: "625" });
      return { title: document.querySelector("#asm-pm h3")?.textContent, groups: document.querySelectorAll('#asm-pm select[data-f="kind"] optgroup').length, auto: !!document.querySelector('#asm-pm [data-a="auto"]')?.checked };
    });
    await hole(20, 16, 9.5);
    await shown(2);
    await tp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 2 && !window.__sv.asm.building, null, { timeout: 120000 });
    // A dowel pin (size 2 picked) on the Ø6 hole: size 6, its top flush with the block.
    await tp.evaluate(() => window.__sv.asm.setFastener({ kind: "iso2338", size: "2" }));
    await hole(48, 3, 9.5);
    await shown(3);
    await tp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 4 && !window.__sv.asm.building, null, { timeout: 120000 });
    await shown(3);
    const tb = await tp.evaluate(() => {
      const a = window.__sv.asm, c = a.doc.components, r = v => Math.round(v * 1e3) / 1e3;
      const at = k => { const t = c[k].tf; return [t[3], t[7], t[11], t[10]].map(r); };
      return { names: c.map(x => x.name), mates: a.doc.mates.map(m => [m.type, m.align ?? ""]), brg: at(1), pin: at(2), dof: [a.solved?.dof[c[1].id], a.solved?.dof[c[2].id]] };
    });
    await tp.evaluate(() => window.__sv.asm.closeTools());
    // McMaster-Carr: a downloaded STEP named "<part number>_<description>.STEP" keeps its part number and a buy link.
    const cube = [...await readFile(join(fixtures, "cube-10x10mm/Cube 10x10.stp"))];
    await tp.evaluate(b => window.__sv.asm.dropFiles([new File([new Uint8Array(b)], "91290A115_Black-Oxide Alloy Steel Socket Head Screw.STEP")]), cube);
    await shown(4);
    const mc = await tp.evaluate(() => {
      const a = window.__sv.asm, c = a.doc.components[3], pd = a.doc.parts[c.part].doc;
      a.showBom();
      const link = document.querySelector("#asm-bom-body a[data-buy]");
      const row = link?.closest("tr")?.textContent ?? "";
      document.querySelector("#asm-bom [data-a=close]").click();
      return { pn: pd.props?.partNumber, desc: pd.props?.description, vendor: pd.props?.custom?.Vendor, href: link?.getAttribute("href"), target: link?.getAttribute("target"), row, csv: a.bomCsvText().split("\r\n").slice(0, 1)[0], csvRow: a.bomCsvText().split("\r\n").find(l => l.includes("91290A115")) };
    });
    check(panel.title === "Toolbox" && panel.groups === 6 && panel.auto
      && /^Ball bearing 6201<1>$/.test(tb.names[1]) && /^ISO 2338 6 x \d+<1>$/.test(tb.names[2])
      && JSON.stringify(tb.mates) === '[["concentric",""],["coincident","aligned"],["concentric",""],["coincident","aligned"]]'
      && JSON.stringify(tb.brg) === "[20,20,10,1]" && JSON.stringify(tb.pin) === "[48,20,10,1]" && JSON.stringify(tb.dof) === "[1,1]"
      && mc.pn === "91290A115" && mc.desc === "Black-Oxide Alloy Steel Socket Head Screw" && mc.vendor === "McMaster-Carr"
      && mc.href === "https://www.mcmaster.com/91290A115/" && mc.target === "_blank" && mc.row.includes("91290A115")
      && mc.csv.endsWith("Vendor,Vendor URL") && mc.csvRow?.endsWith("McMaster-Carr,https://www.mcmaster.com/91290A115/"),
      `asm 1.158: toolbox parts take their size from the hole and seat flush; a McMaster-Carr STEP keeps its part number and buy link (FR-ASM-028) (${JSON.stringify({ panel, tb, mc })})`);
    await ctx.close();
  }

  // --- 1.76: mechanical mates (FR-MATE-005), clearance check (FR-ASM-021) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    // A pin: Ø6 × 20 mm cylinder on the origin.
    await mp.evaluate(() => window.__sv.model.store.change("Pin", d => {
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "o", t: "point", x: 0, y: 0 }, { id: "c", t: "circle", c: "o", r: 3 }] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await mp.waitForTimeout(150);
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const pin = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length);
    for (let k = 0; k < 3; k++) { await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin); await shown(k + 1); }
    // Pin 2 sideways and tilted, pin 3 with a 4 mm gap beside pin 1 (centres 10 mm apart).
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 30, 0, 0, -1, 15, 0, 1, 0, 5]; d.components[2].tf = [1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1, 0]; }));
    await shown(3);
    const faces = await mp.evaluate(() => { const a = window.__sv.asm, k = a.doc.components[0].part, g = [...a.geo.get(k).entries()]; return { side: g.find(([, x]) => x.k === "axis")?.[0], top: g.find(([, x]) => x.k === "plane" && x.n[2] > 0.99)?.[0], bottom: g.find(([, x]) => x.k === "plane" && x.n[2] < -0.99)?.[0] }; });
    // Mate panel: two cylinders offer Hinge, Gear and Screw (not Slot); Gear shows its ratio (1: equal radii).
    await mp.click('#asm-tools [data-ac="mate"]');
    const offer = await mp.evaluate(f => {
      const a = window.__sv.asm, c = a.doc.components;
      Object.assign(a.mating, { a: { comp: c[0].id, face: f.side }, b: { comp: c[1].id, face: f.side } });
      a.setMateType("gear");
      const on = k => !document.querySelector(`#asm-pm [data-mt="${k}"]`)?.disabled;
      return { legend: [...document.querySelectorAll("#asm-pm legend")].some(e => e.textContent === "Mechanical mates"), hinge: on("hinge"), gear: on("gear"), screw: on("screw"), slot: on("slot"), ratio: document.querySelector("#asm-pm [data-ratio]")?.value };
    }, faces);
    // Hinge: pin 2 on top of pin 1, sharing its axis, one turn left.
    const hinge = await mp.evaluate(f => {
      const a = window.__sv.asm, c = a.doc.components;
      a.setMateType("hinge");
      Object.assign(a.mating, { c: { comp: c[0].id, face: f.top }, d: { comp: c[1].id, face: f.bottom } });
      a.okMate();
      const m = a.doc.mates?.[0], t = a.doc.components[1].tf;
      return { type: m?.type, refs: !!(m?.c && m?.d), dof: a.solved?.dof[c[1].id], at: [t[3], t[7], t[11]].map(v => Math.round(v * 1e4) / 1e4), up: Math.round(t[10] * 1e4) / 1e4 };
    }, faces);
    await mp.evaluate(() => window.__sv.asm.cancelMate());
    await shown(3);
    // Clearance check at 5 mm: pin 3 is 4 mm from pin 1 and from pin 2 above it; orange lines join the nearest points.
    await mp.click('#asm-tools [data-ac="interfere"]');
    await mp.waitForFunction(() => window.__sv.asm.interfere?.near, null, { timeout: 120000 });
    await mp.fill("#asm-pm [data-clear]", "5");
    await mp.press("#asm-pm [data-clear]", "Enter");
    await mp.waitForFunction(() => window.__sv.asm.interfere?.clear === 5 && window.__sv.asm.interfere?.near, null, { timeout: 120000 });
    const clear = await mp.evaluate(() => { const it = window.__sv.asm.interfere; return { near: it.near.map(p => Math.round(p.distance * 1000) / 1000), status: document.querySelector("#asm-pm [data-cstatus]")?.textContent, lines: window.__sv.asm.overlay.children.filter(o => o.isLine).length }; });
    check(offer.legend && offer.hinge && offer.gear && offer.screw && !offer.slot && offer.ratio === "1"
      && hinge.type === "hinge" && hinge.refs && hinge.dof === 1 && JSON.stringify(hinge.at) === "[0,0,20]" && hinge.up === 1
      && JSON.stringify(clear.near) === "[4,4]" && clear.lines === 2 && /2 pairs/.test(clear.status ?? ""),
      `asm 1.76: mechanical mates in the Mate panel (hinge: one turn left), clearance check below a minimum (FR-MATE-005, FR-ASM-021) (${JSON.stringify({ offer, hinge, clear })})`);
    await ctx.close();
  }

  // --- motion study (FR-FT-122): mate keys, motors, explode and camera animation, GIF and WebM ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    await mp.evaluate(() => window.__sv.model.store.change("Pin", d => {
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "o", t: "point", x: 0, y: 0 }, { id: "c", t: "circle", c: "o", r: 3 }] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await mp.waitForTimeout(150);
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const pin = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc && !window.__sv.asm.doc.components.length);
    for (let k = 0; k < 2; k++) { await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin); await shown(k + 1); }
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 30, 0, 1, 0, 0, 0, 0, 1, 0]; }));
    await shown(2);
    // Pin 2 on pin 1's axis, 10 mm above its top face; an exploded view moving pin 2 along +X.
    await mp.evaluate(() => {
      const a = window.__sv.asm, k = a.doc.components[0].part, g = [...a.geo.get(k).entries()], c = a.doc.components;
      const side = g.find(([, x]) => x.k === "axis")[0], top = g.find(([, x]) => x.k === "plane" && x.n[2] > 0.99)[0], bottom = g.find(([, x]) => x.k === "plane" && x.n[2] < -0.99)[0];
      a.change(d => {
        d.mates = [{ id: "mc", name: "Concentric1", type: "concentric", a: { comp: c[0].id, face: side }, b: { comp: c[1].id, face: side } },
          { id: "md", name: "Distance1", type: "distance", a: { comp: c[0].id, face: top }, b: { comp: c[1].id, face: bottom }, align: "anti", value: 10 }];
        d.explodes = [{ id: "x1", name: "Exploded1", steps: [{ comps: [c[1].id], dir: [1, 0, 0], dist: 50 }] }];
      });
    });
    await shown(2);
    await mp.click('#asm-tools [data-ac="motion"]');
    await mp.waitForFunction(() => !document.querySelector("#motion").hidden);
    const pos = () => mp.evaluate(() => { const g = window.__sv.viewer.parts[1].group, q = g.quaternion; return { x: Math.round(g.position.x * 1000) / 1000, z: Math.round(g.position.z * 1000) / 1000, rz: Math.round(2 * Math.atan2(q.z, q.w) * 1000) / 1000 }; });
    // Mate keys: Distance1 from 10 to 40 mm over 5 s.
    const keys = await mp.evaluate(async () => {
      const m = window.__sv.motion;
      m.addTrack("mate:md");
      const tr = m.study.tracks[0];
      m.sel = { track: tr.id, key: 1 };
      m.render();
      const inp = document.querySelector('#motion [data-p="v"]');
      inp.value = "40"; inp.dispatchEvent(new Event("change"));
      return { n: window.__sv.asm.doc.motions?.length, keys: m.study.tracks[0].keys.map(k => [k.t, k.v]), rows: document.querySelectorAll("#motion .mo-key").length };
    });
    await mp.evaluate(() => window.__sv.motion.seek(2.5));
    const mid = await pos();
    await mp.evaluate(() => window.__sv.motion.seek(5));
    const end = await pos();
    // A 60 rpm rotary motor on Concentric1: half a turn at 0.5 s.
    await mp.evaluate(() => { const m = window.__sv.motion; m.addTrack("motor:mc"); m.edit(s => { const k = s.tracks.find(x => x.kind === "motor"); k.speed = 60; }); m.seek(0.5); });
    const turn = await pos();
    // Motor profiles from its panel: Distance 180° over the study (half way at 2.5 s), Data points 0 → 90° in 1 s.
    const setP = (sel, v) => mp.evaluate(([sel, v]) => { const el = document.querySelector(`#motion ${sel}`); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, [sel, v]);
    await mp.evaluate(() => { const m = window.__sv.motion; const k = m.study.tracks.find(x => x.kind === "motor"); m.sel = { track: k.id }; m.render(); });
    await setP("select[data-p=profile]", "distance");
    await setP("input[data-p=dist]", "180");
    await mp.evaluate(() => window.__sv.motion.seek(2.5));
    const dist = await pos();
    await setP("select[data-p=profile]", "points");
    await setP("textarea[data-p=pts]", "0, 0\n1; 90");
    await mp.evaluate(() => window.__sv.motion.seek(0.5));
    const ptsAt = await pos();
    const ptsEnd = await mp.evaluate(() => window.__sv.motion.study.tracks.find(x => x.kind === "motor").end);
    await setP("textarea[data-p=pts]", "1, 0\n0, 5");
    const ptsBad = await mp.evaluate(() => document.querySelector("#motion textarea[data-p=pts]").getAttribute("aria-invalid"));
    const motorProf = { dist, ptsAt, ptsEnd, ptsBad };
    // Animation wizard: explode over the study, and rotate the model (camera keys).
    const cam0 = await mp.evaluate(() => window.__sv.viewer.camera.position.toArray());
    await mp.evaluate(() => { const m = window.__sv.motion; m.edit(s => { s.tracks = s.tracks.filter(k => k.kind !== "motor"); }); m.wizard("explode"); m.wizard("orbit"); m.seek(5); });
    const exploded = await pos();
    await mp.evaluate(() => window.__sv.motion.seek(2.5));
    const cam1 = await mp.evaluate(() => { const v = window.__sv.viewer; return { p: v.camera.position.toArray(), t: v.controls.target.toArray() }; });
    // Appearance keys: pin 2 fades out over the study (half way at 2.5 s, hidden at 5 s); Alt+← moves the end key a frame.
    const look = await mp.evaluate(async () => {
      const m = window.__sv.motion, a = window.__sv.asm, id = a.doc.components[1].id, p = () => window.__sv.viewer.parts[a.shownIds.indexOf(id)];
      const listed = [...document.querySelectorAll('#motion select[data-mo="add"] option')].some(o => o.value === `look:${id}`);
      m.addTrack(`look:${id}`);
      m.seek(2.5);
      const half = { op: p().opacity, vis: p().visible, mat: p().material.transparent };
      m.seek(5);
      const end = { vis: p().visible };
      const tr = m.study.tracks.find(k => k.kind === "look");
      m.sel = { track: tr.id, key: 1 };
      m.render();
      document.querySelector("#motion .mo-key.sel").focus();
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
      const moved = m.study.tracks.find(k => k.kind === "look").keys.map(k => k.t);
      const label = document.querySelector(`#motion [data-track="${tr.id}"] .mo-kind`)?.textContent;
      m.deleteTrack(tr.id);
      m.seek(5);
      return { listed, half, end, moved, label, back: { op: p().opacity, vis: p().visible } };
    });
    // Recording: a GIF of a 1 s study and a WebM video.
    const rec = await mp.evaluate(async () => {
      const m = window.__sv.motion;
      m.edit(s => { s.duration = 1; });
      const gif = await m.recordGif(160), head = new Uint8Array(await gif.slice(0, 6).arrayBuffer());
      const webm = await m.recordWebm();
      const wh = webm ? new Uint8Array(await webm.slice(0, 4).arrayBuffer()) : [];
      const pz = await m.recordFrames(160), pb = new Uint8Array(await pz.arrayBuffer());
      const eocd = new DataView(pb.buffer, pb.length - 22), pngs = { pk: String.fromCharCode(pb[0], pb[1]), n: eocd.getUint16(10, true), want: Math.round(m.study.duration * m.study.fps) + 1, name: new TextDecoder().decode(pb.slice(30, 30 + (pb[26] | (pb[27] << 8)))) };
      return { pngs, gif: String.fromCharCode(...head), gifSize: gif.size, webm: webm ? [...wh].map(b => b.toString(16)).join("") : null, webmSize: webm?.size ?? 0 };
    });
    // Undo takes back the last motion edit; Russian pane has no English left; closing puts pin 2 back.
    const undo = await mp.evaluate(async () => { const a = window.__sv.asm; a.undo(); await new Promise(r => setTimeout(r, 50)); return a.doc.motions[0].duration; });
    await shown(2);
    await mp.click("#lang-btn");
    await mp.waitForTimeout(150);
    const ru = await mp.evaluate(() => {
      const bad = [], ok = /^(fps|mm|GIF|WebM|PNG|ZIP)$/;
      const test = s => { for (const w of s.split(/[^A-Za-z0-9]+/)) if (/^[A-Za-z]{2,}$/.test(w) && !ok.test(w)) bad.push(s.trim().slice(0, 40)); };
      const root = document.querySelector("#motion");
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!n.parentElement.closest('[translate="no"]')) test(n.data);
      for (const e of root.querySelectorAll("[title], [aria-label]")) for (const at of ["title", "aria-label"]) { const v = e.getAttribute(at); if (v) test(v); }
      return { bad, title: root.querySelector(".mo-title").textContent };
    });
    await mp.click("#lang-btn");
    await mp.click('#motion [data-mo="close"]');
    const back = await pos();
    // Placement keys (unmated components only): a third pin moves 20 mm up and turns 90° over the study.
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "pin.mcadprt")), pin);
    await shown(3);
    await mp.click('#asm-tools [data-ac="motion"]');
    await mp.waitForFunction(() => !document.querySelector("#motion").hidden);
    const pose = await mp.evaluate(() => {
      const m = window.__sv.motion, a = window.__sv.asm, c = a.doc.components, id = c[2].id, g = () => window.__sv.viewer.parts[a.shownIds.indexOf(id)].group;
      const opts = [...document.querySelectorAll('#motion select[data-mo="add"] option')].map(o => o.value);
      m.edit(s => { s.duration = 2; });
      m.addTrack(`pose:${id}`);
      const tr = m.study.tracks.find(k => k.kind === "pose");
      m.sel = { track: tr.id, key: 1 };
      m.render();
      for (const [k, v] of [["dz", "20"], ["rz", "90"]]) { const inp = document.querySelector(`#motion [data-p="${k}"]`); inp.value = v; inp.dispatchEvent(new Event("change")); }
      const [x0, y0] = [c[2].tf[3], c[2].tf[7]], q = Math.SQRT1_2;
      m.seek(1);
      const mid = { z: g().position.z, dx: g().position.x - (x0 - (q * x0 - q * y0)), dy: g().position.y - (y0 - (q * x0 + q * y0)), rz: 2 * Math.atan2(g().quaternion.z, g().quaternion.w) };
      m.seek(2);
      const end = { z: g().position.z };
      // Trace path: Add track… → Trace path… then a click on the pin picks a point on it; the pin's own origin traced
      // through the study rises 20 mm in a straight line (the turn is about it), one point per frame, plotted and saved as CSV.
      m.seek(0);
      window.__sv.viewer.fit(false);
      window.__sv.viewer.camera.updateMatrixWorld(true);
      const canvas = window.__sv.viewer.renderer.domElement, rc = canvas.getBoundingClientRect(), d = window.__sv.viewer.parts[a.shownIds.indexOf(id)].data;
      const ctr = g().position.clone().set((d.bboxMin[0] + d.bboxMax[0]) / 2, (d.bboxMin[1] + d.bboxMax[1]) / 2, (d.bboxMin[2] + d.bboxMax[2]) / 2).project(window.__sv.viewer.camera);
      const addSel = document.querySelector('#motion select[data-mo="add"]');
      addSel.value = "trace:"; addSel.dispatchEvent(new Event("change"));
      const picking = m.tracing;
      // The pin's centre on screen, else the first point of a grid that hits a component (the motion pane covers the lower view).
      let at = [rc.left + (ctr.x + 1) / 2 * rc.width, rc.top + (1 - ctr.y) / 2 * rc.height];
      // Else the first triangle middle of the pin's mesh that a click there hits.
      if (a.shownAt(at[0], at[1])?.top !== id) {
        const mesh = window.__sv.viewer.parts[a.shownIds.indexOf(id)].mesh, pos = mesh.geometry.attributes.position, ix = mesh.geometry.index;
        mesh.updateMatrixWorld(true);
        for (let k = 0; k + 2 < (ix ? ix.count : pos.count); k += 3) {
          const v = g().position.clone().set(0, 0, 0);
          for (let j = 0; j < 3; j++) { const vi = ix ? ix.getX(k + j) : k + j; v.x += pos.getX(vi) / 3; v.y += pos.getY(vi) / 3; v.z += pos.getZ(vi) / 3; }
          v.applyMatrix4(mesh.matrixWorld).project(window.__sv.viewer.camera);
          const q = [rc.left + (v.x + 1) / 2 * rc.width, rc.top + (1 - v.y) / 2 * rc.height];
          if (a.shownAt(q[0], q[1])?.top === id) { at = q; break; }
        }
      }
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: at[0], clientY: at[1] }));
      if (m.tracing) document.querySelector("#motion").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const pickedTrace = { picking, after: m.tracing, n: (m.study.traces ?? []).length, at };
      m.addTrace(id, [0, 0, 0]);
      const tr0 = m.study.traces.at(-1), path = m.tracePath(tr0.id), o = [c[2].tf[3], c[2].tf[7], c[2].tf[11]];
      const plot = !!document.querySelector("#motion .mo-trace-plot svg polyline"), row = !!document.querySelector(`#motion .mo-name[data-trace="${tr0.id}"]`);
      const psel = document.querySelector('#motion select[data-tr="plot"]'); if (psel) { psel.value = "speed"; psel.dispatchEvent(new Event("change")); }
      const speedPlot = m.study.traces.at(-1).plot;
      // Results → Plot: acceleration and the component's angle (the pose key turns the pin 90° about Z by the end).
      const plotAs = q => { const el = document.querySelector('#motion select[data-tr="plot"]'); if (el) { el.value = q; el.dispatchEvent(new Event("change")); } return { plot: m.study.traces.at(-1).plot, svg: !!document.querySelector("#motion .mo-trace-plot svg polyline"), read: document.querySelector("#motion .mo-tread")?.textContent ?? "" }; };
      const accelPlot = plotAs("accel"), anglePlot = plotAs("angle"), angles = m.traceAngle(tr0.id);
      const angleOk = angles.length === path.length && Math.abs(angles[0]) < 1e-9 && angles.every(Number.isFinite);
      const angleEnd = angles.at(-1);
      const lines = window.__sv.viewer.scene.children.some(ch => ch.children?.some(x => x.userData?.trace === tr0.id));
      const len = path.reduce((s2, q, k) => k ? s2 + Math.hypot(q[0] - path[k - 1][0], q[1] - path[k - 1][1], q[2] - path[k - 1][2]) : 0, 0);
      // Relative to: the first pin's origin seen from the moving third pin. Its distance from the third pin's origin is
      // the world distance in every frame; the path differs from the world one and is drawn in a group that moves with the pin.
      m.addTrace(c[0].id, [0, 0, 0]);
      const tr1 = m.study.traces.at(-1), world1 = m.tracePath(tr1.id).map(q => [...q]);
      const relOpts = [...document.querySelectorAll('#motion select[data-tr="rel"] option')].map(o => o.value);
      const rsel = document.querySelector('#motion select[data-tr="rel"]'); if (rsel) { rsel.value = id; rsel.dispatchEvent(new Event("change")); }
      const relPath = m.tracePath(tr1.id);
      const relDist = relPath.length === path.length && relPath.every((q, k) => Math.abs(Math.hypot(...q) - Math.hypot(...world1[k].map((v, j) => v - path[k][j]))) < 1e-6);
      const relMoved = relPath.some((q, k) => Math.hypot(...q.map((v, j) => v - world1[k][j])) > 1);
      const relGroup = window.__sv.viewer.scene.children.some(ch => ch.children?.some(x => x.userData?.trace === tr1.id && x.userData.rel === id));
      const relative = { stored: m.study.traces.at(-1).rel === id, noSelf: !relOpts.includes(c[0].id) && relOpts.includes(id) && relOpts[0] === "", relDist, relMoved, relGroup };
      // Mate value: Add track… → Mate value: Distance1 plots the gap between pin 1's top and pin 2's bottom; the faces
      // face each other, so the angle stays at 180°; the plot switches to the angle and the row deletes with ✕.
      const madd = document.querySelector('#motion select[data-mo="add"]'), mopt = [...madd.options].some(o => o.value === "mplot:md");
      madd.value = "mplot:md"; madd.dispatchEvent(new Event("change"));
      const mt = m.study.traces.at(-1), mv = m.mateValues(mt.id);
      const mrow = !!document.querySelector(`#motion .mo-name[data-trace="${mt.id}"]`), msvg = !!document.querySelector("#motion .mo-trace-plot svg polyline");
      const mAngle = plotAs("angle");
      const mateVal = { mopt, mate: mt.mate, plot0: mt.plot ?? "dist", n: mv.dist.length === path.length, finite: mv.dist.every(Number.isFinite), d0: mv.dist[0],
        a180: mv.angle.every(v => Math.abs(Math.abs(v) - 180) < 1e-6), mrow, msvg, angle: mAngle.plot, read: /°/.test(mAngle.read) && /mm/.test(mAngle.read) };
      document.querySelector(`#motion [data-mo="tdel:${mt.id}"]`)?.click();
      mateVal.gone = !m.study.traces.some(x => x.id === mt.id);
      // Sensor: Alert above 10 mm on the distance from start (the pin rises 20 mm over 2 s) marks the frames after 1 s,
      // shows Out of range at the end, and with Stop playback the trip is the first frame past 1 s.
      m.sel = null; m.selTrace = tr0.id; m.render(); m.showAt(m.time);
      plotAs("dist");
      const amax = document.querySelector('#motion input[data-tr="amax"]'); amax.value = "10"; amax.dispatchEvent(new Event("change"));
      const astop = document.querySelector('#motion input[data-tr="astop"]'); astop.checked = true; astop.dispatchEvent(new Event("change"));
      m.seek(2);
      const spans = m.alertSpansOf(tr0.id), sfps = m.study.fps;
      const sensor = { alert: m.study.traces.find(x => x.id === tr0.id).alert, spans, from: spans[0]?.[0], to: spans[0]?.[1], one: spans.length === 1,
        bands: document.querySelectorAll(`#motion .mo-tlane[data-tlane="${tr0.id}"] .mo-aspan`).length, out: !!document.querySelector("#motion .mo-alert"),
        trip: m.tripAt(0, 2 * sfps)?.i, want: sfps + 1, fromOk: Math.abs(spans[0]?.[0] - (sfps + 1) / sfps) < 1e-9 };
      // Proximity: Add track… → Proximity measures the smallest gap between two components every frame; the panel
      // switches the second component and the values follow; frame 0 matches the gap measured in the view there, drawn as a line.
      const gadd = document.querySelector('#motion select[data-mo="add"]'), gopt = [...gadd.options].some(o => o.value === "gap:");
      gadd.value = "gap:"; gadd.dispatchEvent(new Event("change"));
      const gt = m.study.traces.at(-1);
      const gb = document.querySelector('#motion select[data-tr="gb"]'); gb.value = id; gb.dispatchEvent(new Event("change"));
      const gv = m.gapValues(gt.id);
      const prox = { gopt, pair: m.study.traces.at(-1).gap?.[1] === id, n: gv.length === path.length, ok: gv.every(v => Number.isFinite(v) && v >= 0),
        same: (m.seek(0), Math.abs(a.motionGap(gt.gap[0], id) - gv[0]) < 1e-6), row: !!document.querySelector(`#motion .mo-name[data-trace="${gt.id}"]`),
        read: /mm/.test(document.querySelector("#motion .mo-tread")?.textContent ?? "") };
      // The view draws a line between the nearest points as long as the gap.
      let gl = null; window.__sv.viewer.scene.traverse(o => { if (o.userData?.gapLine === gt.id) gl = o; });
      const gpa = gl?.geometry.getAttribute("position");
      prox.line = !!gpa && (gv[0] < 1e-6 || Math.abs(Math.hypot(gpa.getX(1) - gpa.getX(0), gpa.getY(1) - gpa.getY(0), gpa.getZ(1) - gpa.getZ(0)) - gv[0]) < 1e-3);
      // Its plot saves as a stand-alone SVG (English, no playhead line).
      const gsvg = m.plotSvgFile(m.study.traces.find(x => x.id === gt.id));
      prox.svg = !!document.querySelector('#motion button[data-tr="svg"]') && gsvg.startsWith("<?xml") && gsvg.includes("<polyline") && !gsvg.includes("mo-ph");
      m.deleteTrace(gt.id);
      const trace = { prox, sensor, mateVal, relative, pickedTrace, n: path.length, want: 2 * m.study.fps + 1, start: path[0].map((v, k) => v - o[k]), end: path.at(-1).map((v, k) => v - o[k]), len, plot, row, speedPlot, accelPlot, anglePlot, angleOk, angleEnd, lines };
      for (const x of [...m.study.traces]) m.deleteTrace(x.id);
      trace.gone = !(m.study.traces ?? []).length && !document.querySelector("#motion .mo-name[data-trace]");
      m.sel = { track: tr.id, key: 1 };
      m.render();
      m.seek(2);
      // Key point menu: right-click the end key, pick Snap (jump): the pin stays put until the key, then jumps.
      // Ctrl+C / Ctrl+V copy the key to the playhead (1.5 s).
      const kb = document.querySelector("#motion .mo-key.sel");
      kb.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      const items = [...document.querySelectorAll('#mo-menu [role="menuitemradio"]')].map(b => b.textContent);
      document.querySelectorAll('#mo-menu [role="menuitemradio"]')[1].click();
      const menuGone = !document.querySelector("#mo-menu");
      m.seek(1);
      const snapMid = g().position.z;
      m.seek(1.5);
      document.querySelector("#motion .mo-key.sel").focus();
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
      const pasted = m.study.tracks.find(k => k.kind === "pose").keys.map(k => [k.t, k.d[2], k.interp ?? ""]);
      const snapKey = document.querySelectorAll("#motion .mo-key.i-snap").length;
      const menu = { items, menuGone, snapMid, pasted, z15: g().position.z, snapKey };
      // Timeline zoom: ⊕ twice shows a quarter of the study; the playhead at the end scrolls into view; ⤢ fits again.
      document.querySelector('#motion [data-mo="zin"]').click();
      document.querySelector('#motion [data-mo="zin"]').click();
      const tlw = () => document.querySelector("#motion .mo-tlw"), tl = () => document.querySelector("#motion .mo-tl");
      const ratio = tl().offsetWidth / tlw().clientWidth;
      m.seek(2);
      const scrolled = tlw().scrollLeft;
      const keyLeft = document.querySelector("#motion .mo-key").getBoundingClientRect().left;
      document.querySelector('#motion [data-mo="zfit"]').click();
      const zoomed = { z: m.zoom, ratio, scrolled, fit: tl().offsetWidth / tlw().clientWidth, keyLeft: Number.isFinite(keyLeft) };
      // Several keys: Ctrl+click adds the first key to the pasted one, Alt+→ moves both a frame (the last key stays);
      // Ctrl+A selects all three, the key menu sets Ease in on all of them, Ctrl+C copies three, Esc clears.
      const fps = m.study.fps, ptrack = () => m.study.tracks.find(k => k.kind === "pose"), nSel = () => document.querySelectorAll("#motion .mo-key.sel").length;
      const fields = document.querySelectorAll('#motion [data-p^="r"], #motion [data-p^="d"]').length;
      document.querySelector(`#motion .mo-lane[data-lane="${ptrack().id}"] .mo-key`).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
      const two = nSel(), note = document.querySelector("#motion .mo-multi")?.textContent ?? "";
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
      const moved = ptrack().keys.map(k => Math.round(k.t * fps));
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
      const all = nSel() === m.study.tracks.reduce((n, k) => n + (k.keys?.length ?? 0), 0);
      document.querySelector("#motion .mo-key.sel").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      document.querySelectorAll('#mo-menu [role="menuitemradio"]')[2].click();
      const interps = ptrack().keys.map(k => k.interp ?? "");
      document.querySelector("#motion .mo-key.sel").focus();
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
      const copied = m.clip?.items.length === m.study.tracks.reduce((n, k) => n + (k.keys?.length ?? 0), 0);
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const multi = { two, note, moved, want: [1, Math.round(1.5 * fps) + 1, 2 * fps], all, interps, copied, cleared: nSel(), lane: ptrack().id };
      // Interference over the study (Results → Interference): in a new study a placement key carries pin 3 onto pin 2 by the
      // end, so that pair interferes from some time to the end; a time button seeks there; the list closes.
      const prevStudy = m.studyId, prevTime = m.time;
      m.newStudy();
      m.edit(st => { st.duration = 2; });
      m.addTrack(`pose:${id}`);
      const ct = m.study.tracks.find(k => k.kind === "pose");
      const to = [c[1].tf[3] - c[2].tf[3], c[1].tf[7] - c[2].tf[7], c[1].tf[11] - c[2].tf[11]];
      m.edit(st => { st.tracks.find(k => k.id === ct.id).keys[1].d = to; });
      document.querySelector('#motion [data-mo="clash"]').click();
      const ci = m.clash?.items ?? [], pair = ci.find(x => [x.a, x.b].sort().join() === [c[1].id, id].sort().join());
      const sp = pair?.spans ?? [];
      const listed = document.querySelectorAll("#motion .mo-clashes .mo-clash").length, bands = document.querySelectorAll("#motion .mo-ruler .mo-cspan").length;
      document.querySelector("#motion [data-clt]")?.click();
      const sought = m.time;
      const all0 = ci.length;
      const box = document.querySelector('#motion input[data-mo="clashall"]'); box.checked = true; box.dispatchEvent(new Event("change"));
      const withTouching = m.clash.items.length + 0, ignoredAfter = m.clash.ignored;
      const box2 = document.querySelector('#motion input[data-mo="clashall"]'); box2.checked = false; box2.dispatchEvent(new Event("change"));
      // Stop playback at interference: playing from 0 trips where the first span starts.
      const cstop = document.querySelector('#motion input[data-mo="clashstop"]'); cstop.checked = true; cstop.dispatchEvent(new Event("change"));
      const stopTrip = m.tripAt(0, Math.round(m.study.duration * m.study.fps)), stopWant = Math.round(sp[0]?.[0] * m.study.fps);
      m.clashStop = false;
      const stopOff = m.tripAt(0, Math.round(m.study.duration * m.study.fps));
      document.querySelector('#motion [data-mo="clashclose"]')?.click();
      const closed = !document.querySelector("#motion .mo-clashes");
      const interfere = { found: !!pair, starts: sp[0]?.[0], ends: sp.at(-1)?.[1], listed, bands, sought, all0, withTouching, ignoredAfter, closed, clashAll: m.clashAll, stopTrip: stopTrip && !stopTrip.x && stopTrip.i === stopWant, stopOff: stopOff === null };
      // Explode keys: Step by step on the key panel sets the track's seq; the one-step wizard leaves it off.
      m.wizard("explode");
      const et = m.study.tracks.find(k => k.kind === "explode");
      m.sel = { track: et.id, key: 0 }; m.render();
      const seqBox = document.querySelector('#motion input[data-p="seq"]'), seqBefore = !!et.seq;
      if (seqBox) { seqBox.checked = true; seqBox.dispatchEvent(new Event("change")); }
      interfere.seq = { box: !!seqBox, before: seqBefore, after: !!m.study.tracks.find(k => k.id === et.id)?.seq };
      m.deleteStudy();
      m.studyId = prevStudy; m.render(); m.seek(prevTime);
      trace.interfere = interfere;
      return { opts: [opts.includes(`pose:${id}`), opts.includes(`pose:${c[1].id}`)], fields, mid, end, menu, zoomed, multi, trace };
    }).catch(e => ({ err: String(e) }));
    // A box dragged over the empty top of the placement track selects its three keys; Delete removes them all.
    let boxed = { err: "no track" }, stretched = { err: "no track" };
    if (pose.multi) {
      const laneEl = mp.locator(`#motion .mo-lane[data-lane="${pose.multi.lane}"]`);
      await laneEl.scrollIntoViewIfNeeded();
      let lane = await laneEl.boundingBox();
      const boxAll = async () => {
        await laneEl.scrollIntoViewIfNeeded();
        lane = await laneEl.boundingBox();
        await mp.mouse.move(lane.x + 1, lane.y + 1);
        await mp.mouse.down();
        await mp.mouse.move(lane.x + lane.width / 2, lane.y + lane.height - 1, { steps: 4 });
        await mp.mouse.move(lane.x + lane.width - 1, lane.y + lane.height - 1, { steps: 4 });
        await mp.mouse.up();
      };
      // Stretch: the three keys (frames 1, 46, 60) at a 50 % time scale stretch about the first one; Alt+dragging the last
      // one to the end of the track stretches them back; a plain click then a Ctrl+drag of the first key copies it to 1 s.
      const frames = () => mp.evaluate(() => { const m = window.__sv.motion; return m.study.tracks.find(k => k.kind === "pose").keys.map(k => Math.round(k.t * m.study.fps)); });
      // The panel under the timeline changes with the selection, so the track is measured again before each drag.
      const keyBox = async i => { await laneEl.scrollIntoViewIfNeeded(); lane = await laneEl.boundingBox(); return mp.locator(`#motion .mo-lane[data-lane="${pose.multi.lane}"] .mo-key`).nth(i).boundingBox(); };
      await boxAll();
      const scaleField = await mp.locator('#motion [data-p="scale"]').count();
      await mp.locator('#motion [data-p="scale"]').fill("50");
      await mp.locator('#motion [data-p="scale"]').press("Enter");
      const half = await frames();
      const k2 = await keyBox(2);
      await mp.keyboard.down("Alt");
      await mp.mouse.move(k2.x + k2.width / 2, k2.y + k2.height / 2);
      await mp.mouse.down();
      await mp.mouse.move(lane.x + lane.width - 1, k2.y + k2.height / 2, { steps: 6 });
      await mp.mouse.up();
      await mp.keyboard.up("Alt");
      const back = await frames();
      let k0 = await keyBox(0);
      await mp.mouse.click(k0.x + k0.width / 2, k0.y + k0.height / 2);
      k0 = await keyBox(0);
      await mp.keyboard.down("Control");
      await mp.mouse.move(k0.x + k0.width / 2, k0.y + k0.height / 2);
      await mp.mouse.down();
      await mp.mouse.move(lane.x + lane.width / 2, k0.y + k0.height / 2, { steps: 6 });
      await mp.mouse.up();
      await mp.keyboard.up("Control");
      const copied = await frames();
      const nSel = await mp.locator("#motion .mo-key.sel").count(), ghosts = await mp.locator("#motion .mo-ghost").count();
      stretched = { scaleField, half, back, copied, nSel, ghosts };
      await boxAll();
      boxed = await mp.evaluate(() => {
        const n = document.querySelectorAll("#motion .mo-key.sel").length, boxGone = !document.querySelector(".mo-box");
        document.querySelector("#motion .mo-key.sel")?.focus();
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        return { n, boxGone, left: window.__sv.motion.study.tracks.find(k => k.kind === "pose").keys.length };
      });
    }
    await mp.click('#motion [data-mo="close"]');
    const mu = pose.multi;
    check(mu?.two === 2 && mu.note === "2 keys selected" && JSON.stringify(mu.moved) === JSON.stringify(mu.want) && mu.all === true
      && mu.interps.every(v => v === "easein") && mu.copied === true && mu.cleared === 0 && boxed.n === 4 && boxed.boxGone && boxed.left === 0,
      `motion study: several keys selected (Ctrl+click, Ctrl+A, a box) move, take an interpolation, copy and delete together (FR-FT-122) (${JSON.stringify({ mu, boxed })})`);
    const tc = pose.trace;
    check(tc?.pickedTrace.picking === true && tc.pickedTrace.after === false && tc.pickedTrace.n === 1 && tc.n === tc.want
      && tc.start.every(v => Math.abs(v) < 0.01) && Math.abs(tc.end[0]) < 0.01 && Math.abs(tc.end[1]) < 0.01 && Math.abs(tc.end[2] - 20) < 0.01
      && Math.abs(tc.len - 20) < 0.05 && tc.plot && tc.row && tc.speedPlot === "speed" && tc.lines && tc.gone
      && tc.accelPlot.plot === "accel" && tc.accelPlot.svg && /mm\/s²/.test(tc.accelPlot.read)
      && tc.anglePlot.plot === "angle" && tc.anglePlot.svg && tc.anglePlot.read.includes("°") && tc.angleOk && Math.abs(Math.abs(tc.angleEnd) - 90) < 0.1
      && Object.values(tc.relative).every(v => v === true)
      && tc.mateVal.mopt && tc.mateVal.mate === "md" && tc.mateVal.plot0 === "dist" && tc.mateVal.n && tc.mateVal.finite && tc.mateVal.a180 && tc.mateVal.mrow && tc.mateVal.msvg
      && tc.mateVal.angle === "angle" && tc.mateVal.read && tc.mateVal.gone
      && tc.interfere.found && tc.interfere.starts > 0 && Math.abs(tc.interfere.ends - 2) < 1e-9 && tc.interfere.listed >= 1 && tc.interfere.bands >= 1
      && Math.abs(tc.interfere.sought - tc.interfere.starts) < 1e-9 && tc.interfere.withTouching >= tc.interfere.all0 && tc.interfere.ignoredAfter === 0 && tc.interfere.closed && tc.interfere.clashAll === false && tc.interfere.stopTrip && tc.interfere.stopOff
      && tc.sensor.alert?.max === 10 && tc.sensor.alert?.stop === true && tc.sensor.one && tc.sensor.fromOk && Math.abs(tc.sensor.to - 2) < 1e-9
      && Object.values(tc.prox).every(v => v === true)
      && tc.sensor.bands === 1 && tc.sensor.out && tc.sensor.trip === tc.sensor.want
      && tc.interfere.seq.box && tc.interfere.seq.before === false && tc.interfere.seq.after === true,
      `motion study: a trace path follows a picked point, is drawn, plotted (speed, acceleration, angle), traced relative to another component, a mate value plotted, interference listed over the study, and deleted (FR-FT-122) (${JSON.stringify(tc)})`);
    const st = stretched;
    check(st.scaleField === 1 && JSON.stringify(st.half) === "[1,24,31]" && JSON.stringify(st.back) === "[1,46,60]"
      && st.copied?.length === 4 && st.copied[0] === 1 && Math.abs(st.copied[1] - 30) <= 1 && st.nSel === 1 && st.ghosts === 0,
      `motion study: a time scale and Alt+drag stretch selected keys, Ctrl+drag copies a key (FR-FT-122) (${JSON.stringify(st)})`);
    check(pose.opts?.[0] === true && pose.opts[1] === false && pose.fields >= 6 && Math.abs(pose.mid.z - 10) < 0.01 && Math.abs(pose.mid.dx) < 0.01 && Math.abs(pose.mid.dy) < 0.01
      && Math.abs(Math.abs(pose.mid.rz) - Math.PI / 4) < 0.01 && Math.abs(pose.end.z - 20) < 0.01, `motion study: placement keys move and turn an unmated component (FR-FT-122) (${JSON.stringify(pose)})`);
    check(pose.menu?.items.length === 5 && pose.menu.items[1] === "Snap (jump)" && pose.menu.menuGone && Math.abs(pose.menu.snapMid) < 0.01
      && JSON.stringify(pose.menu.pasted) === '[[0,0,""],[1.5,20,"snap"],[2,20,"snap"]]' && Math.abs(pose.menu.z15 - 20) < 0.01 && pose.menu.snapKey === 2,
      `motion study: key point menu sets Snap interpolation; Ctrl+C / Ctrl+V copy a key to the playhead (FR-FT-122) (${JSON.stringify(pose.menu)})`);
    check(pose.zoomed?.z === 1 && pose.zoomed.ratio > 3.5 && pose.zoomed.scrolled > 0 && pose.zoomed.fit < 1.05,
      `motion study: the timeline zooms in, follows the playhead and fits again (FR-FT-122) (${JSON.stringify(pose.zoomed)})`);
    check(keys.n === 1 && JSON.stringify(keys.keys) === "[[0,10],[5,40]]" && keys.rows === 2
      && Math.abs(mid.z - 15) < 0.01 && Math.abs(end.z - 30) < 0.01 && Math.abs(Math.abs(turn.rz) - Math.PI) < 0.01 && Math.abs(turn.z - 3) < 0.01
      && Math.abs(Math.abs(dist.rz) - Math.PI / 2) < 0.01 && Math.abs(Math.abs(ptsAt.rz) - Math.PI / 4) < 0.01 && ptsEnd === 1 && ptsBad === "true"
      && Math.abs(exploded.x - 50) < 0.01
      && look.listed && Math.abs(look.half.op - 0.5) < 0.02 && look.half.vis && look.half.mat && !look.end.vis && look.label === "Appearance"
      && Math.abs(look.moved[1] - (5 - 1 / 30)) < 1e-6 && look.back.op === 1 && look.back.vis && Math.abs(Math.hypot(cam1.p[0] - cam1.t[0], cam1.p[1] - cam1.t[1]) - Math.hypot(cam0[0] - cam1.t[0], cam0[1] - cam1.t[1])) < 1e-3 * Math.hypot(...cam0)
      && rec.gif === "GIF89a" && rec.gifSize > 1000 && rec.pngs.pk === "PK" && rec.pngs.n === rec.pngs.want && /_0001\.png$/.test(rec.pngs.name) && rec.webm === "1a45dfa3" && rec.webmSize > 1000 && undo === 5
      && !ru.bad.length && ru.title === "Исследование движения" && Math.abs(back.z) < 0.01 && Math.abs(back.x) < 0.01,
      `motion study: mate keys, rotary motor (constant, distance, data points), explode and orbit wizard, appearance keys, GIF and WebM, undo, Russian (FR-FT-122) (${JSON.stringify({ keys, mid, end, turn, motorProf, exploded, cam1, look, rec, undo, ru, back })})`);
    await ctx.close();
  }

  // --- 1.65: advanced mates, display states, transparency, open part (FR-MATE-004, FR-ASM-025/007) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    const rect = (w, h, depth) => [{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -w / 2, -h / 2), P("b", w / 2, -h / 2), P("c", w / 2, h / 2), P("d", -w / 2, h / 2), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: depth } }];
    const makePart = async feats => {
      await mp.click("#new-part");
      await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), feats);
      await mp.waitForTimeout(150);
      await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const plate = await makePart(rect(60, 60, 5)), box = await makePart(rect(10, 10, 10));
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "box.mcadprt")), box);
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 30]; }));
    await shown(2);
    // Limit distance 0..8 between the plate top and the box bottom, made in the Mate panel.
    await mp.click('#asm-tools [data-ac="mate"]');
    await mp.evaluate(() => {
      const a = window.__sv.asm, d = a.doc, face = (k, f) => [...a.geo.get(k).entries()].find(([, g]) => f(g))?.[0];
      Object.assign(a.mating, { a: { comp: d.components[0].id, face: face(d.components[0].part, g => g.k === "plane" && g.n[2] > 0.99) }, b: { comp: d.components[1].id, face: face(d.components[1].part, g => g.k === "plane" && g.n[2] < -0.99) } });
      a.renderAll();
    });
    await mp.click('#asm-pm [data-mt="limitdist"]');
    const lim = await mp.evaluate(() => ({ adv: [...document.querySelectorAll("#asm-pm fieldset")].some(f => /Advanced mates/.test(f.textContent)), max: document.querySelector('#asm-pm [data-lim="max"]')?.value, sym: document.querySelector('#asm-pm [data-mt="symmetric"]')?.disabled }));
    await mp.fill('#asm-pm [data-lim="max"]', "8");
    await mp.press('#asm-pm [data-lim="max"]', "Enter");
    await mp.waitForFunction(() => window.__sv.asm.doc.mates?.length === 1);
    await mp.click("#asm-pm [data-a=ok]");
    await shown(2);
    await mp.waitForFunction(() => Math.abs(window.__sv.viewer.parts[1].data.bboxMin[2] - 13) < 1e-3, null, { timeout: 60000 });
    const mated = await mp.evaluate(() => ({ row: document.querySelector("#asm-tree .ft-mate .ft-name")?.textContent, z: window.__sv.viewer.parts[1].data.bboxMin[2], status: document.querySelector("#asm-status").textContent }));
    // Display states: a second state hides the plate and makes the box see-through; the default keeps both plain.
    const boxId = await mp.evaluate(() => window.__sv.asm.doc.components[1].id), plateId = await mp.evaluate(() => window.__sv.asm.doc.components[0].id);
    await mp.evaluate(() => window.__sv.asm.addDisplayState());
    await shown(2);
    await mp.evaluate(([b, p]) => { window.__sv.asm.setOpacity(b, 0.35); window.__sv.asm.setHidden(p, true); }, [boxId, plateId]);
    await mp.waitForFunction(() => !window.__sv.asm.building && window.__sv.viewer.parts.length >= 1 && document.querySelector("#asm-busy").hidden);
    await mp.waitForTimeout(300);
    await mp.waitForFunction(() => !window.__sv.asm.building);
    const st2 = await mp.evaluate(id => { const i = window.__sv.asm.shownIds.indexOf(id), p = window.__sv.viewer.parts[i]; return { rows: [...document.querySelectorAll("#asm-tree .ft-state .ft-name")].map(e => e.textContent), on: document.querySelector("#asm-tree .ft-state.on .ft-name")?.textContent, op: p?.opacity, tr: p?.material.transparent }; }, boxId);
    await mp.click("#asm-tree .ft-state >> nth=0");
    await mp.waitForFunction(() => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden);
    await mp.waitForTimeout(300);
    await mp.waitForFunction(() => !window.__sv.asm.building);
    const st1 = await mp.evaluate(([b, p]) => { const a = window.__sv.asm, c = id => a.doc.components.find(x => x.id === id); const i = a.shownIds.indexOf(b); return { hid: !!c(p).hidden, op: c(b).opacity ?? 1, vop: window.__sv.viewer.parts[i]?.opacity, on: document.querySelector("#asm-tree .ft-state.on .ft-name")?.textContent }; }, [boxId, plateId]);
    // Open part: the box goes to the modeller, gets 20 mm tall, and comes back as one undo step.
    await mp.evaluate(id => window.__sv.asm.editPart(id), boxId);
    await mp.waitForFunction(() => document.querySelector("#app").classList.contains("model") && document.querySelector("#mc-ret"));
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const bar = await mp.evaluate(() => document.querySelector("#mc-ret")?.textContent);
    await mp.evaluate(() => window.__sv.model.store.change("Depth", d => { d.features.find(f => f.type === "extrude").depth = { v: 20 }; }));
    await mp.waitForTimeout(150);
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    await mp.click("#mc-ret button");
    await mp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    await shown(2);
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id), d = window.__sv.viewer.parts[i]?.data; return d && Math.abs(d.bboxMax[2] - d.bboxMin[2] - 20) < 1e-3; }, boxId, { timeout: 60000 });
    const back = await mp.evaluate(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id), d = window.__sv.viewer.parts[i].data; return { h: d.bboxMax[2] - d.bboxMin[2], z: d.bboxMin[2], dirty: a.dirty, model: document.querySelector("#app").classList.contains("model"), mates: a.doc.mates.length }; }, boxId);
    await mp.evaluate(() => window.__sv.asm.undo());
    await shown(2);
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id), d = window.__sv.viewer.parts[i]?.data; return d && Math.abs(d.bboxMax[2] - d.bboxMin[2] - 10) < 1e-3; }, boxId, { timeout: 60000 });
    check(lim.adv && lim.max === "25" && lim.sym === false && /^LimitDistance1 /.test(mated.row) && Math.abs(mated.z - 13) < 1e-3
      && st2.rows.join() === "Default,Display State 2" && st2.on === "Display State 2" && st2.op === 0.35 && st2.tr === true
      && !st1.hid && st1.op === 1 && st1.vop === 1 && st1.on === "Default"
      && /Return to assembly/.test(bar) && Math.abs(back.h - 20) < 1e-3 && Math.abs(back.z - 13) < 1e-3 && back.dirty && !back.model && back.mates === 1,
      `asm 1.65: limit distance from the Mate panel, display states with transparency, open part and return (FR-MATE-004, FR-ASM-007/025) (${JSON.stringify({ lim, mated, st2, st1, bar, back })})`);
    await ctx.close();
  }

  // --- 1.135: edit in context, sketch on another component, external references (FR-ASM-030) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    const rectEnts = (w, h) => [P("a", -w / 2, -h / 2), P("b", w / 2, -h / 2), P("c", w / 2, h / 2), P("d", -w / 2, h / 2), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")];
    const rect = (w, h, depth) => [{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: rectEnts(w, h) },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: depth } }];
    const modelIdle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const makePart = async feats => {
      await mp.click("#new-part");
      await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), feats);
      await mp.waitForTimeout(150);
      await modelIdle();
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const plate = await makePart(rect(60, 60, 5)), box = await makePart(rect(10, 10, 10));
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "box.mcadprt")), box);
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 30]; }));
    await shown(2);
    const [plateId, boxId] = await mp.evaluate(() => window.__sv.asm.doc.components.map(c => c.id));
    const menu = await mp.evaluate(() => { const a = window.__sv.asm; a.menu(a.doc.components[1], 300, 300); const t = [...document.querySelectorAll(".mc-menu button, .asm-menu button, [role=menu] button")].map(b => b.textContent); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return t; });
    // Edit the box in context: the plate shows around it; click the plate's top face (world z = 5, the box part's z = −25) for a sketch.
    await mp.evaluate(id => window.__sv.asm.editPart(id, true), boxId);
    await mp.waitForFunction(() => document.querySelector("#app").classList.contains("model") && document.querySelector("#mc-ret"));
    await modelIdle();
    const inCtx = await mp.evaluate(() => ({ meshes: window.__sv.modeller.ctxView.children.length, bar: document.querySelector("#mc-ret")?.textContent }));
    await mp.evaluate(() => window.__sv.viewer.viewFrom(new window.__sv.viewer.camera.position.constructor(1, -1, 0.8), false));
    await mp.evaluate(() => { const v = window.__sv.viewer, V = v.camera.position.constructor; v.fit(false, new v.bounds.constructor(new V(-30, -30, -25), new V(30, 30, 10))); });
    await mp.waitForTimeout(200);
    await runCmd(mp, "Sketch");
    await mp.waitForTimeout(100);
    const [cx, cy] = await mp.evaluate(p => {
      const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, [-22, -22, -25]);
    await mp.mouse.move(cx, cy); await mp.waitForTimeout(50); await mp.mouse.down(); await mp.mouse.up();
    await mp.waitForFunction(() => window.__sv.model.store.doc.features.some(f => f.type === "sketch" && f.plane.ctx), null, { timeout: 30000 });
    const ref = await mp.evaluate(() => structuredClone(window.__sv.model.store.doc.features.find(f => f.plane?.ctx).plane.ctx));
    await mp.evaluate(() => window.__sv.modeller.ok());
    await mp.waitForTimeout(150);
    await mp.evaluate(ents => window.__sv.model.store.change("Pad", d => {
      const sk = d.features.find(f => f.plane?.ctx);
      sk.ents = ents.map(e => ({ ...e, id: `k${e.id}`, ...(e.a ? { a: `k${e.a}`, b: `k${e.b}` } : {}) }));
      d.features.push({ id: "pad", type: "extrude", name: "Extrude2", sketch: sk.id, op: "boss", merge: false, end: "blind", depth: { v: 5 } });
    }), rectEnts(10, 10));
    await mp.waitForTimeout(150);
    await modelIdle();
    const inPart = await mp.evaluate(() => ({ v: Math.round(window.__sv.model.last().props.volume), mark: [...document.querySelectorAll("#ft-tree .ft-ext, #tab-features .ft-ext")].map(e => e.textContent), bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    // External References lists it; the dialog in Russian.
    await runCmd(mp, "External References");
    await mp.waitForSelector("#mc-xref[open]");
    const dlg = await mp.evaluate(() => ({ rows: document.querySelectorAll("#mc-xref tbody tr").length, text: document.querySelector("#mc-xref tbody")?.textContent }));
    // The dialog is modal: switch the language behind it.
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => document.querySelector("#mc-xref").textContent);
    await mp.evaluate(() => document.querySelector("#lang-btn").click());
    await mp.click('#mc-xref [data-a="close"]');
    await mp.click("#mc-ret button");
    await mp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    await shown(2);
    // The plate goes up 10 mm: the pad follows its top face (world z 15..20).
    const padZ = () => mp.evaluate(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id), d = window.__sv.viewer.parts[i]?.data; return d ? Math.round(d.bboxMin[2] * 1000) / 1000 : null; }, boxId);
    const z0 = await padZ();
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[0].tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10]; }));
    await mp.waitForFunction(id => { const a = window.__sv.asm, i = a.shownIds.indexOf(id), d = window.__sv.viewer.parts[i]?.data; return !a.building && d && Math.abs(d.bboxMin[2] - 15) < 1e-3; }, boxId, { timeout: 60000 });
    const moved = await mp.evaluate(id => { const a = window.__sv.asm, c = a.doc.components.find(x => x.id === id); return a.doc.parts[c.part].doc.features.find(f => f.plane?.ctx).plane.ctx.p[2]; }, boxId);
    const z1 = await padZ();
    // Locked: moving the plate back leaves the pad where it is.
    await mp.evaluate(id => window.__sv.asm.change(d => { const c = d.components.find(x => x.id === id); d.parts[c.part].doc.ctxLocked = true; }), boxId);
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[0].tf = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]; }));
    await shown(2);
    await mp.waitForTimeout(300);
    await mp.waitForFunction(() => !window.__sv.asm.building);
    const z2 = await padZ();
    check(menu.includes("Edit in context") && inCtx.meshes === 1 && /in the context of/.test(inCtx.bar ?? "")
      && ref.comp === plateId && ref.host === boxId && Math.abs(ref.p[2] + 25) < 1e-3 && Math.abs(ref.n[2] - 1) < 1e-6
      && inPart.v === 1500 && inPart.mark.join() === "->" && !inPart.bad && dlg.rows === 1 && /In context/.test(dlg.text ?? "")
      && z0 === 5 && Math.abs(moved + 15) < 1e-3 && z1 === 15 && z2 === 15,
      `asm 1.135: edit in context, sketch on the plate's face, the pad follows the plate until locked (FR-ASM-030) (${JSON.stringify({ menu: menu.length, inCtx, ref, inPart, dlg, z0, moved, z1, z2 })})`);
    check(/Внешние ссылки/.test(ru) && /В контексте/.test(ru) && !/External References|In context|Lock all/.test(ru), `asm 1.135: External References dialog in Russian (${ru.slice(0, 300)})`);
    await ctx.close();
  }

  // --- 1.67: collision detection while dragging (FR-MATE-002) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), [{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -5, -5), P("b", 5, -5), P("c", 5, 5), P("d", -5, 5), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } }]);
    await mp.waitForTimeout(150);
    await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
    const box = [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    for (let k = 1; k <= 2; k++) { await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "box.mcadprt")), box); await shown(k); }
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 30, 0, 1, 0, 0, 0, 0, 1, 0]; }));
    await shown(2);
    // Collision detection on (Move panel), then drag the second box through the first.
    await mp.click("#asm-tree .ft-comp >> nth=1");
    await mp.click('#asm-tools [data-ac="move"]');
    await mp.check('#asm-pm [data-a="collide"]');
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(0, -1, 0), false); v.invalidate(); });
    await mp.waitForTimeout(300);
    const scr = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    const [x0, y0] = await scr([30, 0, 5]), [x1] = await scr([-20, 0, 5]);
    await mp.mouse.move(x0, y0);
    await mp.mouse.down();
    for (let k = 1; k <= 5; k++) await mp.mouse.move(x0 + (x1 - x0) * k / 5, y0);
    await mp.mouse.up();
    await shown(2);
    const stop = await mp.evaluate(() => { const c = window.__sv.asm.doc.components[1]; return { x: c.tf[3], on: window.__sv.asm.collide }; });
    // Off again: the same drag goes through.
    await mp.uncheck('#asm-pm [data-a="collide"]');
    const [x2, y2] = await scr([stop.x, 0, 5]);
    await mp.mouse.move(x2, y2);
    await mp.mouse.down();
    for (let k = 1; k <= 5; k++) await mp.mouse.move(x2 + (x1 - x2) * k / 5, y2);
    await mp.mouse.up();
    await shown(2);
    const free = await mp.evaluate(() => window.__sv.asm.doc.components[1].tf[3]);
    check(stop.on && stop.x >= 10 - 1e-6 && stop.x < 10.6 && free < 0,
      `asm 1.67: collision detection stops the drag at contact; without it the drag goes through (FR-MATE-002) (${JSON.stringify({ stop, free })})`);
    await ctx.close();
  }

  // --- 1.67: Alt-drag inferred mates (FR-MATE-007) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
    const rect = (w, depth) => [{ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -w / 2, -w / 2), P("b", w / 2, -w / 2), P("c", w / 2, w / 2), P("d", -w / 2, w / 2), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
      { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: depth } }];
    const makePart = async feats => {
      await mp.click("#new-part");
      await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
      await mp.evaluate(f => window.__sv.model.store.change("Part", d => { d.features.push(...f); }), feats);
      await mp.waitForTimeout(150);
      await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 });
      return [...await mp.evaluate(async () => [...await window.__sv.modeller.partBytes()])];
    };
    const plate = await makePart(rect(60, 5)), box = await makePart(rect(10, 10));
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc);
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), plate);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "box.mcadprt")), box);
    await shown(2);
    await mp.evaluate(() => window.__sv.asm.change(d => { d.components[1].tf = [1, 0, 0, 50, 0, 1, 0, 0, 0, 0, 1, 20]; }));
    await shown(2);
    await mp.evaluate(() => { const v = window.__sv.viewer; v.viewFrom(new (v.camera.position.constructor)(1, -1, 1), false); v.invalidate(); });
    await mp.waitForTimeout(300);
    const scr = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const s = new (v.camera.position.constructor)(...w).project(v.camera); return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height]; }, w);
    // Grab the box's front face (y = -5) with Alt and drop it on the plate's top.
    const [x0, y0] = await scr([50, -5, 25]), [x1, y1] = await scr([-15, -15, 5]);
    await mp.mouse.move(x0, y0);
    await mp.keyboard.down("Alt");
    await mp.mouse.down();
    for (let k = 1; k <= 6; k++) await mp.mouse.move(x0 + (x1 - x0) * k / 6, y0 + (y1 - y0) * k / 6);
    await mp.mouse.up();
    await mp.keyboard.up("Alt");
    await shown(2);
    const inf = await mp.evaluate(() => {
      const a = window.__sv.asm, m = a.doc.mates?.[0], t = a.doc.components[1].tf;
      // The box's front face normal (0, -1, 0) in the assembly.
      return { type: m?.type, align: m?.align, n: [t[1] * -1, t[5] * -1, t[9] * -1].map(x => Math.round(x * 1e6) / 1e6), row: document.querySelector("#asm-tree .ft-mate .ft-name")?.textContent };
    });
    check(inf.type === "coincident" && inf.align === "anti" && JSON.stringify(inf.n) === "[0,0,-1]" && /^Coincident1 \(plate<1>, box<1>\)$/.test(inf.row),
      `asm 1.67: Alt-drag a face onto a face makes the inferred coincident mate (FR-MATE-007) (${JSON.stringify(inf)})`);
    await ctx.close();
  }

  // --- 1.67: direct editing, Move Face and Delete Face (FR-FT-101) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const settle = async () => { await mp.waitForTimeout(150); await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 }); };
    await mp.evaluate(() => window.__sv.model.store.change("Part", d => {
      const R = (id, cx, cy, w, h, plane) => { const P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y }); return { id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [P(1, cx - w / 2, cy - h / 2), P(2, cx + w / 2, cy - h / 2), P(3, cx + w / 2, cy + h / 2), P(4, cx - w / 2, cy + h / 2), { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` }, { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }] }; };
      d.features.push(R("s1", 0, 0, 100, 60, { std: "XY" }), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
        R("s2", 20, 0, 20, 10, { face: { name: "f1:end" } }), { id: "f2", type: "extrude", name: "Cut-Extrude1", sketch: "s2", op: "cut", end: "blind", depth: { v: 5 } });
    }));
    await settle();
    // Move Face from the Sweep ▾ menu: the top 5 mm out (the pocket walls grow with it, so it is 10 mm deep).
    await runCmd(mp, "Move Face");
    await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.faces = [{ name: "f1:end" }]; m.panel(); void m.rebuild(); });
    await settle();
    const pv = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, count: document.querySelector("#mc-pm .pm-count")?.textContent, v: window.__sv.model.last().props.volume }));
    await mp.fill('#mc-pm input[data-num="distance"]', "5");
    await mp.press('#mc-pm input[data-num="distance"]', "Enter");
    await settle();
    const mv = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, f: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    // Delete Face: the pocket's floor and walls go, and the top closes over it.
    await runCmd(mp, "Delete Face");
    await mp.evaluate(() => { const m = window.__sv.model, names = m.last().faceNames ?? []; m.mode().draft.faces = [...new Set(names.filter(n => n.startsWith("f2:")))].map(name => ({ name })); m.panel(); void m.rebuild(); });
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const del = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, f: window.__sv.model.store.doc.features.map(f => f.name).join(","), faces: window.__sv.model.store.doc.features.at(-1).faces.length }));
    check(pv.title === "Move Face" && pv.count === "1 face" && Math.abs(mv.v - (100 * 60 * 25 - 20 * 10 * 10)) < 1 && !mv.bad && /MoveFace1/.test(mv.f)
      && Math.abs(del.v - 100 * 60 * 25) < 1 && !del.bad && /DeleteFace1$/.test(del.f) && del.faces >= 5,
      `model 1.67: Move Face pushes the top out 5 mm, Delete Face heals the pocket (FR-FT-101) (${JSON.stringify({ pv, mv, del })})`);
    await ctx.close();
  }

  // --- Move Face translate and rotate (FR-FT-101) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const settle = async () => { await mp.waitForTimeout(150); await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last()?.props, null, { timeout: 120000 }); };
    await mp.evaluate(() => window.__sv.model.store.change("Part", d => {
      const id = "s1", P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y });
      d.features.push({ id, type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P(1, -50, -30), P(2, 50, -30), P(3, 50, 30), P(4, -50, 30), { id: "s1l1", t: "line", a: "s1p1", b: "s1p2" }, { id: "s1l2", t: "line", a: "s1p2", b: "s1p3" }, { id: "s1l3", t: "line", a: "s1p3", b: "s1p4" }, { id: "s1l4", t: "line", a: "s1p4", b: "s1p1" }] },
        { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await settle();
    const open = async () => { await runCmd(mp, "Move Face"); await settle(); await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.faces = [{ name: "f1:end" }]; m.panel(); void m.rebuild(); }); await settle(); };
    const vol = () => mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";") }));
    // Translate (7, 0, 5): only the 5 mm along the top's normal counts.
    await open();
    await mp.selectOption('#mc-pm select[data-k="mvmode"]', "translate");
    await settle();
    await mp.fill('#mc-pm input[data-num="dx"]', "7");
    await mp.press('#mc-pm input[data-num="dx"]', "Tab");
    await mp.fill('#mc-pm input[data-num="dz"]', "5");
    await mp.press('#mc-pm input[data-num="dz"]', "Tab");
    await settle();
    const tr = await vol();
    await mp.click("#mc-cancel");
    await settle();
    // Rotate the top 10° about its long edge on the y = -30 side: a wedge of 100 · 60² · tan 10° / 2 added.
    await open();
    await mp.selectOption('#mc-pm select[data-k="mvmode"]', "rotate");
    await settle();
    const focus = await mp.evaluate(() => window.__sv.model.mode().focus);
    await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.axis = { edge: { faces: ["f1:end", "f1:side:s1l1"] } }; m.panel(); void m.rebuild(); });
    await settle();
    const rot = await vol();
    await mp.click("#mc-ok");
    await settle();
    const fin = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1));
    const wedge = 100 * 3600 * Math.tan(Math.PI / 18) / 2;
    check(Math.abs(tr.v - 100 * 60 * 25) < 1 && !tr.bad && focus === "axis" && Math.abs(rot.v - (120000 + wedge)) < 1 && !rot.bad && fin.mode === "rotate" && fin.type === "moveface",
      `model: Move Face translate (normal part only) and rotate about an edge (FR-FT-101) (${JSON.stringify({ tr, focus, rot, mode: fin.mode })})`);
    // Replace Face (Surface ▾): the top replaced by a flat surface 5 mm above it.
    await mp.evaluate(() => window.__sv.model.store.change("Surface", d => {
      d.features.pop();
      const id = "s2", P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y });
      d.features.push({ id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 25 } },
        { id, type: "sketch", name: "Sketch2", plane: { plane: "p1" }, rels: [], dims: [], ents: [P(1, -150, -150), P(2, 150, -150), P(3, 150, 150), P(4, -150, 150), { id: "s2l1", t: "line", a: "s2p1", b: "s2p2" }, { id: "s2l2", t: "line", a: "s2p2", b: "s2p3" }, { id: "s2l3", t: "line", a: "s2p3", b: "s2p4" }, { id: "s2l4", t: "line", a: "s2p4", b: "s2p1" }] },
        { id: "f9", type: "planesurf", name: "Surface-Plane1", sketch: "s2" });
    }));
    await settle();
    await runCmd(mp, "Replace Face");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.faces = [{ name: "f1:end" }]; f.surface = { name: "f9:face:0" }; m.panel(); void m.rebuild(); });
    await settle();
    const rp = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent }));
    await mp.click("#mc-ok");
    await settle();
    check(rp.title === "Replace Face" && Math.abs(rp.v - 100 * 60 * 25) < 1 && !rp.bad, `model: Replace Face grows the body to a surface (FR-FT-101) (${JSON.stringify(rp)})`);
    await ctx.close();
  }

  // --- surfaces 2 (FRS 9.11): revolved, lofted and trimmed surfaces; Delete Face leaving a surface ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const settle = async () => { await mp.waitForTimeout(150); await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 }); };
    const surf = async name => { await runCmd(mp, name); await settle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), sheets: l.sheetFaces ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent ?? null }; });
    // A vertical line beside a construction axis on the front plane, and two 20 mm lines 10 mm apart.
    await mp.evaluate(() => window.__sv.model.store.change("Sketches", d => {
      d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XZ" }, rels: [], dims: [], ents: [
        { id: "a0", t: "point", x: 0, y: -5 }, { id: "a1", t: "point", x: 0, y: 30 }, { id: "ax", t: "line", a: "a0", b: "a1", cons: true },
        { id: "b0", t: "point", x: 10, y: 0 }, { id: "b1", t: "point", x: 10, y: 20 }, { id: "l", t: "line", a: "b0", b: "b1" }] });
    }));
    await settle();
    await surf("Revolved Surface");
    const rv = await state();
    await mp.click("#mc-ok");
    await settle();
    await mp.evaluate(() => window.__sv.model.store.change("Loft sketches", d => {
      const L = (id, plane) => ({ id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [{ id: `${id}a`, t: "point", x: 30, y: -10 }, { id: `${id}b`, t: "point", x: 30, y: 10 }, { id: `${id}l`, t: "line", a: `${id}a`, b: `${id}b` }] });
      d.features.push(L("k1", { std: "XY" }), { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 10 } }, L("k2", { plane: "p1" }));
    }));
    await settle();
    await surf("Lofted Surface");
    const lf = await state();
    const prof = await mp.evaluate(() => window.__sv.model.mode().draft.profiles.join(","));
    await mp.click("#mc-ok");
    await settle();
    // Trim the cylinder with the top plane (z = 10 is Plane1): keep the lower half.
    await surf("Trim Surface");
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft, rvId = m.store.doc.features.find(x => x.type === "revsurf").id; f.surface = { name: `${rvId}:side:l` }; f.tool = { plane: { plane: "p1" } }; f.keep = [{ name: `${rvId}:side:l`, hint: [10, 0, 2] }]; m.panel(); void m.rebuild(); });
    await settle();
    const tr = await state();
    await mp.click("#mc-ok");
    await settle();
    const area = await mp.evaluate(() => window.__sv.model.last().faceNames.length);
    check(rv.title === "Surface-Revolve" && rv.sheets >= 1 && !rv.bad && lf.title === "Surface-Loft" && prof === "k1,k2" && !lf.bad
      && tr.title === "Trim Surface" && !tr.bad && tr.sheets >= 2 && area >= 2,
      `model: revolved, lofted and trimmed surfaces from Surface ▾ (FR-FT-100) (${JSON.stringify({ rv, lf, prof, tr, area })})`);
    // Delete Face, "Delete (leave a surface)": a block without its top becomes a 5-face open surface body.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      d.features = [];
      const id = "s9", P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y });
      d.features.push({ id, type: "sketch", name: "Sketch9", plane: { std: "XY" }, rels: [], dims: [], ents: [P(1, -20, -10), P(2, 20, -10), P(3, 20, 10), P(4, -20, 10), { id: "q1", t: "line", a: "s9p1", b: "s9p2" }, { id: "q2", t: "line", a: "s9p2", b: "s9p3" }, { id: "q3", t: "line", a: "s9p3", b: "s9p4" }, { id: "q4", t: "line", a: "s9p4", b: "s9p1" }] },
        { id: "f9", type: "extrude", name: "Extrude1", sketch: "s9", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await settle();
    await runCmd(mp, "Delete Face");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="dfmode"]', "delete");
    await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.faces = [{ name: "f9:end" }]; m.panel(); void m.rebuild(); });
    await settle();
    const dl = await state();
    check(dl.v === 0 && dl.sheets === 5 && !dl.bad, `model: Delete Face "Delete" leaves an open surface body (FR-FT-100) (${JSON.stringify(dl)})`);
    await mp.click("#mc-ok");
    await settle();
    // Filled Surface closes the top opening (sewn on: 6 faces); Extend Surface grows a 40×20 planar surface to 50×30.
    await surf("Filled Surface");
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.surface = { name: m.last().faceNames.at(-1) }; f.at = [0, 0, 10]; m.panel(); void m.rebuild(); });
    await settle();
    const fl = await state();
    await mp.click("#mc-ok");
    await settle();
    await mp.evaluate(() => window.__sv.model.store.change("Planar", d => { d.features.push({ id: "f20", type: "planesurf", name: "Surface-Plane1", sketch: "s9" }); }));
    await settle();
    await surf("Extend Surface");
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.surface = { name: "f20:face:0" }; m.panel(); void m.rebuild(); });
    await settle();
    const ex = await state();
    const exArea = await mp.evaluate(() => { const l = window.__sv.model.last(), p = window.__sv.viewer.parts[0]?.data; const i = l.faceNames.indexOf("f20:face:0"); return i >= 0 && p ? Math.round(p.faces[i].area) : -1; });
    await mp.click("#mc-ok");
    await settle();
    check(fl.title === "Filled Surface" && fl.sheets === 6 && !fl.bad && ex.title === "Extend Surface" && !ex.bad && exArea === 1500,
      `model: Filled Surface patches an opening, Extend Surface grows a face (FR-FT-100) (${JSON.stringify({ fl, ex, exArea })})`);
    await ctx.close();
  }

  // --- surfaces (FRS 9.11, FR-FT-100): extruded, planar, offset, knit into a solid, thicken ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const settle = async () => { await mp.waitForTimeout(150); await mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 }); };
    await mp.evaluate(() => window.__sv.model.store.change("Sketch", d => {
      const id = "s1", P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y });
      d.features.push({ id, type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P(1, -20, -10), P(2, 20, -10), P(3, 20, 10), P(4, -20, 10), { id: "l1", t: "line", a: "s1p1", b: "s1p2" }, { id: "l2", t: "line", a: "s1p2", b: "s1p3" }, { id: "l3", t: "line", a: "s1p3", b: "s1p4" }, { id: "l4", t: "line", a: "s1p4", b: "s1p1" }] });
    }));
    await settle();
    const surf = async name => { await runCmd(mp, name); await settle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: l.props?.volume ?? 0, sheets: l.sheetFaces ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent ?? null }; });
    // Extruded surface: the rectangle's four sides, 10 mm tall, no volume.
    await surf("Extruded Surface");
    const ex = await state();
    await mp.click("#mc-ok");
    await settle();
    const ex2 = await state();
    // Planar surface on the same sketch (the bottom), then its offset copy 10 mm up (the top).
    await surf("Planar Surface");
    const pl = await state();
    await mp.click("#mc-ok");
    await settle();
    await surf("Offset Surface");
    await mp.evaluate(() => { const m = window.__sv.model, ps = m.store.doc.features.find(f => f.type === "planesurf"); m.mode().draft.faces = [{ name: `${ps.id}:face:0` }]; m.panel(); void m.rebuild(); });
    await settle();
    await mp.fill('#mc-pm input[data-num="distance"]', "10");
    await mp.press('#mc-pm input[data-num="distance"]', "Tab");
    await settle();
    const of = await state();
    await mp.click("#mc-ok");
    await settle();
    // Knit the three surface bodies with Create solid: a closed 40×20×10 box.
    await surf("Knit Surface");
    await mp.evaluate(() => { const m = window.__sv.model, l = m.last(), n = l.faceNames; m.mode().draft.surfaces = [...new Set(n.map(x => x.split(":")[0]))].map(id => ({ name: n.find(x => x.startsWith(`${id}:`)) })); m.panel(); void m.rebuild(); });
    await settle();
    await mp.check('#mc-pm input[data-k="solid"]');
    await settle();
    const kn = await state();
    await mp.click("#mc-ok");
    await settle();
    // Thicken a new planar surface 3 mm downwards (side 2), merged into the box: +2400 mm³.
    await surf("Planar Surface");
    await mp.click("#mc-ok");
    await settle();
    await surf("Thicken");
    await mp.evaluate(() => { const m = window.__sv.model, ps = m.store.doc.features.filter(f => f.type === "planesurf").at(-1); m.mode().draft.surface = { name: `${ps.id}:face:0` }; m.panel(); void m.rebuild(); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="side"]', "other");
    await mp.fill('#mc-pm input[data-num="thickness"]', "3");
    await mp.press('#mc-pm input[data-num="thickness"]', "Tab");
    await settle();
    const th = await state();
    await mp.click("#mc-ok");
    await settle();
    const fin = await mp.evaluate(() => window.__sv.model.store.doc.features.map(f => f.name).join(","));
    check(ex.title === "Surface-Extrude" && ex.sheets === 4 && !ex.v && !ex.bad && ex2.sheets === 4 && pl.title === "Planar Surface" && pl.sheets === 5
      && of.title === "Offset Surface" && of.sheets === 6 && !of.bad && kn.title === "Knit Surface" && Math.abs(kn.v - 8000) < 1 && kn.sheets === 0 && !kn.bad
      && th.title === "Thicken" && Math.abs(th.v - 10400) < 1 && th.sheets === 0 && !th.bad
      && /Surface-Extrude1,Surface-Plane1,Surface-Offset1,Surface-Knit1,Surface-Plane2,Thicken1$/.test(fin),
      `model: surfaces: extruded, planar, offset, knit into a solid, thicken (FR-FT-100) (${JSON.stringify({ ex, ex2, pl, of, kn, th, fin })})`);
    await ctx.close();
  }

  // --- 1.55: helix, sweep and loft (FRS 9.9, AT-P3-1/2) from the Sweep ▾ commands, with their panels ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    mp.on("dialog", d => d.accept());
    await mp.goto(`${origin}/index.html?debug`);
    await mp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Circle", d => { d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "c0", t: "point", x: 0, y: 0 }, { id: "c", t: "circle", c: "c0", r: 10 }] }); }));
    await settle();
    // Helix from the flyout: on the circle sketch, drawn in the view while the panel is open.
    await runCmd(mp, "Helix/Spiral");
    await settle();
    await mp.fill('#mc-pm input[data-num="pitch"]', "5");
    await mp.press('#mc-pm input[data-num="pitch"]', "Tab");
    await mp.fill('#mc-pm input[data-num="revs"]', "10");
    await mp.press('#mc-pm input[data-num="revs"]', "Tab");
    await settle();
    const hx = await mp.evaluate(() => { const m = window.__sv.model.mode(), c = window.__sv.model.last().curves ?? {}; const pts = Object.values(c)[0] ?? []; return { kind: m.kind, type: m.draft?.type, sketch: m.draft?.sketch, title: document.querySelector("#mc-pm h3")?.textContent, n: pts.length, top: pts.at(-1)?.[2], drawn: window.__sv.modeller.decor.children.length }; });
    await mp.click("#mc-ok");
    await settle();
    check(hx.type === "helix" && hx.sketch === "s1" && hx.title === "Helix/Spiral" && hx.n > 100 && Math.abs(hx.top - 50) < 1e-6 && hx.drawn > 0, `model 1.55: Helix/Spiral on a sketch circle, previewed in the view (FR-FT-083) (${JSON.stringify(hx)})`);
    // Sweep: along the helix with a circular profile Ø2 (a spring, AT-P3-1).
    await runCmd(mp, "Sweep");
    await settle();
    const sw0 = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { path: m.draft?.path, circ: m.draft?.circular?.v }; });
    await mp.fill('#mc-pm input[data-num="circular"]', "2");
    await mp.press('#mc-pm input[data-num="circular"]', "Tab");
    await settle();
    const live = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    await mp.click("#mc-ok");
    await settle();
    const L = 10 * Math.hypot(2 * Math.PI * 10, 5);
    const spring = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    check(sw0.path?.helix && Math.abs(spring.v - Math.PI * L) / (Math.PI * L) < 1e-4 && Math.abs(live - spring.v) < 1e-6 && !spring.bad && /Sweep1/.test(spring.names), `model 1.55: Sweep with a circular profile along the helix makes a spring, previewed live (AT-P3-1) (${JSON.stringify(sw0)}, ${live}, ${JSON.stringify(spring)} vs ${(Math.PI * L).toFixed(2)})`);
    // Loft between a square and a circle 50 mm apart (AT-P3-2), picked by default as the last two unused sketches.
    await mp.evaluate(() => window.__sv.model.store.change("Profiles", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push(
        { id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 50 } },
        { id: "sq", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", 40, -20), P("b", 80, -20), P("c", 80, 20), P("d", 40, 20), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "ci", type: "sketch", name: "Sketch3", plane: { plane: "p1" }, rels: [], dims: [], ents: [{ id: "o", t: "point", x: 60, y: 0 }, { id: "k", t: "circle", c: "o", r: 15 }] });
    }));
    await settle();
    const v0 = await mp.evaluate(() => window.__sv.model.last().props.volume);
    await runCmd(mp, "Loft");
    await settle();
    const lp = await mp.evaluate(() => ({ profiles: window.__sv.model.mode().draft?.profiles, rows: document.querySelectorAll('#mc-pm select[data-k^="lp"]').length }));
    await mp.click("#mc-ok");
    await settle();
    const loft = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    const lv = loft.v - v0;
    check(JSON.stringify(lp.profiles) === '["sq","ci"]' && lp.rows === 3 && !loft.bad && lv > Math.PI * 225 * 50 && lv < 1600 * 50, `model 1.55: Loft through a square and a circle (AT-P3-2) (${JSON.stringify(lp)}, ${lv.toFixed(1)})`);
    // In Russian: the panel and the flyout.
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "helix").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, legends: [...document.querySelectorAll("#mc-pm legend")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "Спираль" && !/[A-Za-z]{2}/.test(ru.legends), `model 1.55: helix panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.82: 3D curves (FR-FT-085) as sweep paths, and the swept surface (FR-FT-100) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const len = pts => pts.reduce((s, q, i) => i ? s + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1], q[2] - pts[i - 1][2]) : 0, 0);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 40 × 20 block.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -20, -20), P("b2", 20, -20), P("b3", 20, 20), P("b4", -20, 20), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await settle();
    // Curve Through XYZ Points: the table, then points from a CSV file (a 30 mm vertical line at x = 50).
    await runCmd(mp, "Curve Through XYZ Points");
    await settle();
    const rows0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, rows: document.querySelectorAll("#mc-pm input[data-cx]").length, drawn: window.__sv.modeller.decor.children.length }));
    const chooser = mp.waitForEvent("filechooser");
    await mp.click('#mc-pm [data-crv="csv"]');
    await (await chooser).setFiles({ name: "pts.csv", mimeType: "text/csv", buffer: Buffer.from("x,y,z\n50,0,0\n50,0,10\n50,0,20\n50,0,30\n") });
    await mp.waitForFunction(() => document.querySelectorAll("#mc-pm input[data-cx]").length === 12);
    await settle();
    const xyz = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { id: m.draft.id, pts: m.draft.pts, curve: window.__sv.model.last().curves?.[m.draft.id] ?? [] }; });
    await mp.click("#mc-ok");
    await settle();
    check(rows0.title === "Curve Through XYZ Points" && rows0.rows === 9 && rows0.drawn > 0 && xyz.pts.length === 4 && Math.abs(len(xyz.curve) - 30) < 1e-6,
      `model 1.82: Curve Through XYZ Points from a table and a CSV file, drawn in the view (FR-FT-085) (${JSON.stringify({ rows0, n: xyz.pts.length, len: len(xyz.curve) })})`);
    // Sweep picks the curve as its path: a Ø4 rod 30 long beside the block.
    await runCmd(mp, "Sweep");
    await settle();
    const swPath = await mp.evaluate(() => window.__sv.model.mode().draft?.path);
    await mp.fill('#mc-pm input[data-num="circular"]', "4");
    await mp.press('#mc-pm input[data-num="circular"]', "Tab");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const rod = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length }));
    check(swPath?.curve === xyz.id && Math.abs(rod.v - (32000 + Math.PI * 4 * 30)) < 1e-3 && !rod.bad, `model 1.82: Sweep along the XYZ curve (${JSON.stringify({ swPath, rod })})`);
    // Composite curve: two top edges of the block joined (an L of 80 mm).
    await runCmd(mp, "Composite Curve");
    await settle();
    const comp = await mp.evaluate(async () => {
      const md = window.__sv.modeller, m = window.__sv.model.mode();
      m.draft.edges = [{ faces: ["e:side:bl1", "e:end"] }, { faces: ["e:side:bl2", "e:end"] }];
      md.draftChanged();
      return { title: document.querySelector("#mc-pm h3")?.textContent, id: m.draft.id };
    });
    await settle();
    const compPts = await mp.evaluate(id => window.__sv.model.last().curves?.[id] ?? [], comp.id);
    const compPanel = await mp.evaluate(() => document.querySelector("#mc-pm .pm-count")?.textContent);
    await mp.click("#mc-ok");
    await settle();
    check(comp.title === "Composite Curve" && /2/.test(compPanel ?? "") && Math.abs(len(compPts) - 80) < 1e-6 && compPts.every(q => Math.abs(q[2] - 20) < 1e-6),
      `model 1.82: Composite Curve joins two top edges (${JSON.stringify({ comp, compPanel, len: len(compPts) })})`);
    // Projected curve: a line sketched 30 above the top, projected down onto it (the sketch is picked by default).
    await mp.evaluate(() => window.__sv.model.store.change("Line above", d => {
      d.features.push({ id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 50 } },
        { id: "k", type: "sketch", name: "Sketch2", plane: { plane: "p1" }, rels: [], dims: [], ents: [{ id: "ka", t: "point", x: -10, y: 0 }, { id: "kb", t: "point", x: 10, y: 5 }, { id: "kl", t: "line", a: "ka", b: "kb" }] });
    }));
    await settle();
    await runCmd(mp, "Projected Curve");
    await settle();
    const pj = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { title: document.querySelector("#mc-pm h3")?.textContent, sketch: m.draft.sketch, pts: window.__sv.model.last().curves?.[m.draft.id] ?? [] }; });
    await mp.click("#mc-ok");
    await settle();
    check(pj.title === "Projected Curve" && pj.sketch === "k" && Math.abs(len(pj.pts) - Math.hypot(20, 5)) < 1e-6 && pj.pts.every(q => Math.abs(q[2] - 20) < 1e-6),
      `model 1.82: Projected Curve lands on the block's top (${JSON.stringify({ ...pj, pts: pj.pts.length, len: len(pj.pts) })})`);
    // Swept surface: an open 10 mm line swept along the XYZ curve (picked in the panel).
    await mp.evaluate(() => window.__sv.model.store.change("Open profile", d => {
      d.features.push({ id: "sp", type: "sketch", name: "Sketch3", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "sa", t: "point", x: 45, y: 10 }, { id: "sb", t: "point", x: 55, y: 10 }, { id: "sl", t: "line", a: "sa", b: "sb" }] });
    }));
    await settle();
    await runCmd(mp, "Swept Surface");
    await settle();
    const ss0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, profile: window.__sv.model.mode().draft?.profile }));
    await mp.selectOption('#mc-pm select[data-k="swPath"]', `c:${xyz.id}`);
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const ss = await mp.evaluate(() => { const l = window.__sv.model.last(); return { sheets: l.sheetFaces ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), names: window.__sv.model.store.doc.features.map(f => f.name).join(","), path: window.__sv.model.store.doc.features.at(-1).path }; });
    check(ss0.title === "Swept Surface" && ss0.profile === "sp" && ss.sheets === 1 && !ss.bad && ss.path?.curve === xyz.id && /Curve1,Sweep1,Curve2,.*Curve3,Sketch3,Surface-Sweep1$/.test(ss.names),
      `model 1.82: Swept Surface along the curve (FR-FT-100) (${JSON.stringify({ ss0, ss })})`);
    // In Russian: the XYZ curve panel.
    await mp.click("#lang-btn");
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), xyz.id);
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm label")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "Кривая через точки XYZ" && !/[A-Za-z]{3}/.test(ru.text.replace(/CSV|XYZ|Enter|Esc|\(mm\)/g, "")), `model 1.82: curve panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.83: 3D sketch (FR-SK-080): click lines in space, Tab to turn the plane, relations and dimensions, then a sweep along it ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await settle();
    await runCmd(mp, "3D Sketch");
    await settle();
    // Screen position of a world point.
    const scr = p => mp.evaluate(p => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const V = v.camera.position.constructor; const q = new V(...p).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; }, p);
    const hasThree = true;
    const s0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, tool: document.querySelector('#mc-pm [data-s3t="line"]')?.getAttribute("aria-pressed") }));
    // Three clicks: the origin, then roughly 40 along X on XY; Tab to YZ, then roughly 30 up.
    const clickAt = async p => { const [x, y] = await scr(p); await mp.mouse.click(x, y); await settle(); };
    if (hasThree) {
      await clickAt([0, 0, 0]);
      await clickAt([40, 2, 0]);
      await mp.keyboard.press("Tab");
      await clickAt([40, 0, 30]);
    }
    const drawn = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { pts: d.pts.map(p => p.p), segs: d.segs.length, plane: document.querySelector("#mc-pm [data-s3p]")?.value }; });
    // Fix the first point; line 1: Along X and a 50 length; line 2: Along Z.
    const pmClick = sel => mp.click(`#mc-pm ${sel}`);
    await mp.keyboard.press("Escape");
    await mp.keyboard.press("Escape");
    await settle();
    const segIds = await mp.evaluate(() => window.__sv.model.mode().draft.segs.map(s => s.id));
    const ptIds = await mp.evaluate(() => window.__sv.model.mode().draft.pts.map(s => s.id));
    await pmClick(`[data-s3sel="${ptIds[0]}"]`); await pmClick('[data-s3r="fix"]'); await pmClick(`[data-s3sel="${ptIds[0]}"]`);
    await pmClick(`[data-s3sel="${segIds[0]}"]`); await pmClick('[data-s3r="alongX"]'); await pmClick('[data-s3r="dim:length"]'); await pmClick(`[data-s3sel="${segIds[0]}"]`);
    await pmClick(`[data-s3sel="${segIds[1]}"]`); await pmClick('[data-s3r="alongZ"]'); await pmClick(`[data-s3sel="${segIds[1]}"]`);
    const dimIn = mp.locator("#mc-pm input[data-s3dim]").first();
    await dimIn.fill("50"); await dimIn.press("Enter");
    await settle();
    const solved = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { pts: d.pts.map(p => p.p.map(c => Math.round(c * 1000) / 1000)), rels: d.rels.map(r => r.t), status: document.querySelector("#mc-pm [data-s3status]")?.textContent }; });
    await mp.click("#mc-ok");
    await settle();
    // Sweep with a Ø4 circular profile along the 3D sketch: the path is picked by default.
    await runCmd(mp, "Sweep");
    await settle();
    const swPath = await mp.evaluate(() => window.__sv.model.mode().draft?.path);
    await mp.fill('#mc-pm input[data-num="circular"]', "4");
    await mp.press('#mc-pm input[data-num="circular"]', "Tab");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const after = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";"), names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    const leg2 = solved.pts[2] ? Math.hypot(solved.pts[2][0] - solved.pts[1][0], solved.pts[2][1] - solved.pts[1][1], solved.pts[2][2] - solved.pts[1][2]) : 0;
    check(hasThree && s0.title === "3D Sketch" && s0.tool === "true" && drawn.segs === 2 && drawn.plane === "YZ" && Math.abs(drawn.pts[2][0] - 40) < 1e-6
      && JSON.stringify(solved.pts.slice(0, 2)) === "[[0,0,0],[50,0,0]]" && Math.abs(solved.pts[2][0] - 50) < 1e-6 && Math.abs(solved.pts[2][1]) < 1e-6 && /alongX,alongZ/.test(solved.rels.join(",")) && /1/.test(solved.status ?? ""),
      `model 1.83: 3D Sketch drawn by clicking in space, Tab turns the plane, relations and a dimension solve it (FR-SK-080) (${JSON.stringify({ hasThree, s0, drawn, solved })})`);
    check(swPath?.curve && !after.bad && Math.abs(after.v - Math.PI * 4 * (50 + leg2)) / (Math.PI * 4 * (50 + leg2)) < 1e-3 && /3DSketch1,Sweep1$/.test(after.names),
      `model 1.83: Sweep along the 3D sketch (${JSON.stringify({ swPath, after, leg2 })})`);
    // In Russian: the 3D sketch panel.
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "sketch3d").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm th")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "3D-эскиз" && !/[A-Za-z]{3}/.test(ru.text.replace(/Enter|Esc|Tab/g, "")), `model 1.83: 3D sketch panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.85: sweep twist and guide curve, loft centreline, variable pitch helix (FR-FT-080, FR-FT-082, FR-FT-083) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const turns = pts => { let a = 0; for (let i = 1; i < pts.length; i++) { let d = Math.atan2(pts[i][1], pts[i][0]) - Math.atan2(pts[i - 1][1], pts[i - 1][0]); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; a += d; } return a / (2 * Math.PI); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A Ø20 circle for the helix, a 10 mm square, a 20 mm square 30 up, a straight 30 mm curve and a slanted guide.
    await mp.evaluate(() => window.__sv.model.store.change("Setup", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (id, h, plane) => ({ id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [P(id + "1", -h, -h), P(id + "2", h, -h), P(id + "3", h, h), P(id + "4", -h, h), Ln(id + "a", id + "1", id + "2"), Ln(id + "b", id + "2", id + "3"), Ln(id + "c", id + "3", id + "4"), Ln(id + "d", id + "4", id + "1")] });
      d.features.push({ id: "h", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("hc", 0, 0), { id: "hk", t: "circle", c: "hc", r: 10 }] });
      d.features.push({ ...sq("s", 5, { std: "XY" }), name: "Sketch2" }, { id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 30 } }, { ...sq("t", 10, { plane: "p1" }), name: "Sketch3" });
      d.features.push({ id: "c1", type: "curve", name: "Curve1", kind: "xyz", pts: [[0, 0, 0], [0, 0, 30]] }, { id: "g1", type: "curve", name: "Curve2", kind: "xyz", pts: [[5, 0, 0], [10, 0, 30]] });
    }));
    await settle();
    // Variable pitch helix: tick the box, set pitch 2 at the bottom and 6 at the top (and Ø30), add a row and remove it.
    await runCmd(mp, "Helix/Spiral");
    await settle();
    await mp.check('#mc-pm input[data-k="vpitchOn"]');
    await settle();
    const rows0 = await mp.evaluate(() => document.querySelectorAll('#mc-pm input[data-num^="vpitch."]').length);
    for (const [k, v] of [["vpitch.0.p", "2"], ["vpitch.1.p", "6"], ["vpitch.1.d", "30"], ["vpitch.1.h", "20"]]) {
      await mp.fill(`#mc-pm input[data-num="${k}"]`, v);
      await mp.press(`#mc-pm input[data-num="${k}"]`, "Tab");
      await settle();
    }
    await mp.click("#mc-pm [data-vpadd]");
    await settle();
    const rows1 = await mp.evaluate(() => window.__sv.model.mode().draft.vpitch.length);
    await mp.click('#mc-pm [data-vpdel="2"]');
    await settle();
    const hx = await mp.evaluate(() => { const m = window.__sv.model.mode(); return { id: m.draft.id, rows: m.draft.vpitch.length, pts: window.__sv.model.last().curves?.[m.draft.id] ?? [] }; });
    await mp.click("#mc-ok");
    await settle();
    const end = hx.pts.at(-1) ?? [0, 0, 0];
    check(rows0 === 6 && rows1 === 3 && hx.rows === 2 && Math.abs(turns(hx.pts) - Math.log(3) / 0.2) < 1e-3 && Math.abs(end[2] - 20) < 1e-6 && Math.abs(Math.hypot(end[0], end[1]) - 15) < 1e-6,
      `model 1.85: variable pitch helix from the row table (FR-FT-083) (${JSON.stringify({ rows0, rows1, rows: hx.rows, turns: turns(hx.pts), end })})`);
    // Sweep with a 45° twist: the square along the straight curve keeps its volume, the top corner turns out to 5√2.
    await mp.evaluate(() => { window.__sv.model.store.change("Sweep", d => d.features.push({ id: "w", type: "sweep", name: "Sweep1", op: "boss", profile: "s", path: { curve: "c1" } })); window.__sv.modeller.editFeature("w"); });
    await settle();
    await mp.check('#mc-pm input[data-k="twistOn"]');
    await settle();
    await mp.fill('#mc-pm input[data-num="twist"]', "45");
    await mp.press('#mc-pm input[data-num="twist"]', "Tab");
    await settle();
    const tw = await mp.evaluate(() => { const l = window.__sv.model.last(); return { twist: window.__sv.model.mode().draft.twist?.v, v: l.props?.volume ?? 0, x: Math.max(...window.__sv.viewer.parts.map(p => { p.mesh.geometry.computeBoundingBox(); return p.mesh.geometry.boundingBox.max.x; })) }; });
    // Then a guide curve instead: the twist goes, the profile follows the guide out to 20 mm wide (a square frustum).
    await mp.selectOption('#mc-pm select[data-k="swGuide"]', "c:g1");
    await settle();
    const gd = await mp.evaluate(() => { const m = window.__sv.model.mode(), l = window.__sv.model.last(); return { guide: m.draft.guide, twist: !!m.draft.twist, twistBox: !!document.querySelector('#mc-pm input[data-k="twistOn"]'), v: l.props?.volume ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    await mp.click("#mc-ok");
    await settle();
    check(Math.abs(tw.twist - Math.PI / 4) < 1e-9 && Math.abs(tw.v - 3000) / 3000 < 2e-3 && Math.abs(tw.x - 5 * Math.SQRT2) < 0.05,
      `model 1.85: Sweep with a twist along the path (FR-FT-080) (${JSON.stringify(tw)})`);
    check(gd.guide?.curve === "g1" && !gd.twist && !gd.twistBox && !gd.bad && Math.abs(gd.v - 7000) / 7000 < 5e-3,
      `model 1.85: Sweep with a guide curve (${JSON.stringify(gd)})`);
    // Loft along a centreline: 10 mm square to 20 mm square, the straight curve as centreline.
    await mp.evaluate(() => { window.__sv.model.store.change("Loft", d => { d.features = d.features.filter(f => f.id !== "w"); d.features.push({ id: "l", type: "loft", name: "Loft1", op: "boss", profiles: ["s", "t"] }); }); window.__sv.modeller.editFeature("l"); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="lcPath"]', "c:c1");
    await settle();
    const lf = await mp.evaluate(() => { const m = window.__sv.model.mode(), l = window.__sv.model.last(); return { c: m.draft.centerline, ruled: !!document.querySelector('#mc-pm input[data-k="ruled"]'), v: l.props?.volume ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    await mp.click("#mc-ok");
    await settle();
    check(lf.c?.curve === "c1" && !lf.ruled && !lf.bad && Math.abs(lf.v - 7000) / 7000 < 2e-3, `model 1.85: Loft along a centerline (FR-FT-082) (${JSON.stringify(lf)})`);
    // In Russian: the helix panel with its row table.
    await mp.click("#lang-btn");
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), hx.id);
    await settle();
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm th, #mc-pm label")].map(e => e.textContent).join("|"));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(/Переменный шаг/.test(ru) && !/[A-Za-z]{3}/.test(ru.replace(/\(mm\)|mm|Enter|Esc|Tab/g, "")), `model 1.85: helix panel in Russian (${ru})`);
    await ctx.close();
  }

  // --- 1.88: Intersect bodies into regions (FR-BODY-007) and Untrim Surface (FR-FT-100) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), bodies: l.props?.bodies ?? 0, sheets: l.sheetFaces ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent ?? null }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // Two 20 mm-high-by-10 blocks as separate bodies: x −10…10 and 5…35. Regions: 3000, 1000 (common) and 5000 mm³.
    await mp.evaluate(() => window.__sv.model.store.change("Blocks", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (id, x0, x1) => ({ id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [P(id + "1", x0, -10), P(id + "2", x1, -10), P(id + "3", x1, 10), P(id + "4", x0, 10), Ln(id + "a", id + "1", id + "2"), Ln(id + "b", id + "2", id + "3"), Ln(id + "c", id + "3", id + "4"), Ln(id + "d", id + "4", id + "1")] });
      d.features.push({ ...sq("a", -10, 10), name: "Sketch1" }, { id: "ea", type: "extrude", name: "Boss-Extrude1", sketch: "a", op: "boss", end: "blind", depth: { v: 10 } },
        { ...sq("b", 5, 35), name: "Sketch2" }, { id: "eb", type: "extrude", name: "Boss-Extrude2", sketch: "b", op: "boss", end: "blind", depth: { v: 10 }, merge: false });
    }));
    await settle();
    await runCmd(mp, "Intersect");
    await settle();
    const i0 = await state();
    const rows = await mp.evaluate(() => ({ n: document.querySelectorAll("#mc-pm input[data-rgn]").length, v: (window.__sv.model.last().regions?.[window.__sv.model.mode().draft.id] ?? []).map(r => Math.round(r.v)) }));
    // Untick the common region: the two outer pieces stay as two bodies.
    const k = rows.v.indexOf(1000);
    await mp.uncheck(`#mc-pm input[data-rgn="${k}"]`);
    await settle();
    const i1 = await state();
    // Tick it again: all three merged into one body.
    await mp.check(`#mc-pm input[data-rgn="${k}"]`);
    await settle();
    const i2 = await state();
    await mp.uncheck(`#mc-pm input[data-rgn="${k}"]`);
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const i3 = await state();
    check(i0.title === "Intersect" && rows.n === 3 && JSON.stringify([...rows.v].sort((a, b) => a - b)) === "[1000,3000,5000]" && i0.v === 9000 && i0.bodies === 1
      && i1.v === 8000 && i1.bodies === 2 && i2.v === 9000 && i2.bodies === 1 && i3.v === 8000 && !i3.bad,
      `model 1.88: Intersect lists the regions and keeps the ticked ones (FR-BODY-007) (${JSON.stringify({ i0, rows, i1, i2, i3 })})`);
    // Untrim Surface: a 40 mm square surface with a Ø10 hole gets its hole filled.
    await mp.evaluate(() => window.__sv.model.store.change("Holed surface", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "pl", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 30 } },
        { id: "h", type: "sketch", name: "Sketch3", plane: { plane: "pl" }, rels: [], dims: [], ents: [P("h1", -20, -20), P("h2", 20, -20), P("h3", 20, 20), P("h4", -20, 20), Ln("ha", "h1", "h2"), Ln("hb", "h2", "h3"), Ln("hc", "h3", "h4"), Ln("hd", "h4", "h1"), P("hk", 0, 0), { id: "hr", t: "circle", c: "hk", r: 5 }] },
        { id: "ps", type: "planesurf", name: "Surface-Plane1", sketch: "h" });
    }));
    await settle();
    const area = () => mp.evaluate(() => { const l = window.__sv.model.last(), p = window.__sv.viewer.parts[0]?.data; const i = l.faceNames.indexOf("ps:face:0"); return i >= 0 && p ? Math.round(p.faces[i].area * 10) / 10 : -1; });
    const a0 = await area();
    await runCmd(mp, "Untrim Surface");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.surface = { name: "ps:face:0" }; m.panel(); void m.rebuild(); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="untrimMode"]', "holes");
    await settle();
    const u = await state();
    const a1 = await area();
    const mode = await mp.evaluate(() => window.__sv.model.mode().draft.mode);
    await mp.click("#mc-ok");
    await settle();
    check(Math.abs(a0 - (1600 - Math.PI * 25)) < 0.2 && u.title === "Untrim Surface" && mode === "holes" && !u.bad && a1 === 1600,
      `model 1.88: Untrim Surface fills the hole of a planar surface (FR-FT-100) (${JSON.stringify({ a0, u, a1, mode })})`);
    // In Russian: the Intersect panel.
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "intersect").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm label, #mc-pm .pm-count")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "Пересечь" && !/[A-Za-z]{3}/.test(ru.text.replace(/mm³|mm|Enter|Esc/g, "")), `model 1.88: Intersect panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.101: a sketch line made parallel to a model edge picked in the view (FR-SK-064) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const scr = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const q = new v.camera.position.constructor(...w).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 20 × 20 block, and a sketch on its top with one slanted line.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -20, -10), P("b2", 20, -10), P("b3", 20, 10), P("b4", -20, 10), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } },
        { id: "k", type: "sketch", name: "Sketch2", plane: { face: { name: "e:end" } }, rels: [], dims: [], ents: [] });
    }));
    await settle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("k"));
    await settle();
    await mp.evaluate(() => window.__sv.viewer.viewFrom(new window.__sv.viewer.camera.position.constructor(1, -1, 1), false));
    await mp.waitForTimeout(300);
    // Draw the slanted line from (−10, 2) to (8, 6) on the top, away from the edges.
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    for (const w of [[-10, 2, 20], [8, 6, 20]]) { const [x, y] = await scr(w); await mp.mouse.move(x, y); await mp.mouse.click(x, y); }
    await mp.keyboard.press("Escape");
    await mp.evaluate(() => window.__sv.model.editor().setTool("select"));
    await settle();
    // Select the line, then Ctrl+click the block's front top edge (y = −10) in the view.
    const [lx, ly] = await scr([-1, 4, 20]);
    await mp.mouse.move(lx, ly); await mp.mouse.click(lx, ly);
    const [fx, fy] = await scr([-5, -10, 20]);
    await mp.mouse.move(fx, fy);
    await mp.keyboard.down("Control"); await mp.mouse.click(fx, fy); await mp.keyboard.up("Control");
    await mp.waitForTimeout(200);
    const sel = await mp.evaluate(() => { const ed = window.__sv.model.editor(); return { n: ed.selection.size, kinds: [...ed.selection].map(id => ed.sk.ents.find(e => e.id === id)?.t), rels: ed.validRelations(), ext: ed.sk.rels.filter(r => r.ext).length }; });
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm [data-rel]")].map(b => b.textContent).join("|"));
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    await mp.click('#mc-pm [data-rel="parallel"]');
    await settle();
    const par = await mp.evaluate(() => {
      const s = window.__sv.model.editor().sk, P = id => s.ents.find(e => e.id === id), d = l => { const a = P(l.a), b = P(l.b); return [b.x - a.x, b.y - a.y]; };
      const line = s.ents.find(e => e.t === "line" && !e.cons), ref = s.ents.find(e => e.t === "line" && e.cons);
      const u = d(line), v = d(ref);
      return { cross: Math.abs(u[0] * v[1] - u[1] * v[0]) / Math.hypot(...u) / Math.hypot(...v), rel: s.rels.some(r => r.t === "parallel") };
    });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await settle();
    check(sel.n === 2 && sel.kinds.join() === "line,line" && sel.rels.includes("parallel") && sel.ext === 1 && par.rel && par.cross < 1e-6,
      `model 1.101: a sketch line made parallel to a model edge clicked in the view (FR-SK-064) (${JSON.stringify({ sel, par })})`);
    check(/Параллельность|Параллельн/.test(ru) && !/Parallel/.test(ru), `model 1.101: relation buttons in Russian (${ru})`);
    await ctx.close();
  }

  // --- 1.116: Recognize Holes turns the holes of a body into Hole features (FR-FT-102) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(), d = window.__sv.model.store.doc; return { v: Math.round((l.props?.volume ?? 0) * 100) / 100, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), types: d.features.map(f => f.type).join(","), holes: d.features.filter(f => f.type === "hole").map(f => `${f.end}:${f.pts.length}:${Math.round(f.diameter.v * 10) / 10}`).sort().join(" ") }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 60 × 40 × 20 block with two Ø10 through holes and one Ø8 × 8 flat blind hole.
    await mp.evaluate(() => window.__sv.model.store.change("Holed block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("s1", -30, -20), P("s2", 30, -20), P("s3", 30, 20), P("s4", -30, 20), Ln("sa", "s1", "s2"), Ln("sb", "s2", "s3"), Ln("sc", "s3", "s4"), Ln("sd", "s4", "s1")] },
        { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } },
        { id: "h1", type: "hole", name: "Hole1", plane: { face: { name: "e:end" } }, pts: [[-15, 0], [-15, 12]], kind: "simple", diameter: { v: 10 }, end: "through", depth: { v: 10 } },
        { id: "h2", type: "hole", name: "Hole2", plane: { face: { name: "e:end" } }, pts: [[15, 0]], kind: "simple", diameter: { v: 8 }, end: "blind", depth: { v: 8 }, flat: true });
    }));
    await settle();
    const r0 = await state();
    await runCmd(mp, "Recognize Holes");
    await settle();
    await mp.waitForFunction(() => window.__sv.model.store.doc.features.some(f => f.type === "delface"), null, { timeout: 60000 });
    await settle();
    const r1 = await state();
    check(Math.abs(r1.v - r0.v) < 0.05 && !r1.bad && r1.types === "sketch,extrude,hole,hole,delface,hole,hole" && r1.holes === "blind:1:8 blind:1:8 through:2:10 through:2:10",
      `model 1.116: Recognize Holes fills the holes and makes them again as Hole features (FR-FT-102) (${JSON.stringify({ r0, r1 })})`);
    await ctx.close();
  }

  // --- 1.119: Loft guide curves (FR-FT-082) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), types: window.__sv.model.store.doc.features.map(f => f.type).join(",") }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // Two Ø10 circles 40 apart and a curve bowing out to radius 8 half way.
    await mp.evaluate(() => window.__sv.model.store.change("Profiles and guide", d => {
      const circ = (id, plane) => ({ id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [{ id: id + "o", t: "point", x: 0, y: 0 }, { id: id + "c", t: "circle", c: id + "o", r: 5 }] });
      d.features.push(circ("Sketch1", { std: "XY" }), { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 40 } }, circ("Sketch2", { plane: "p1" }),
        { id: "g1", type: "curve", name: "Curve1", kind: "xyz", pts: [[5, 0, 0], [8, 0, 20], [5, 0, 40]] });
    }));
    await settle();
    await runCmd(mp, "Loft");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="lp0"]', "Sketch1");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="lp1"]', "Sketch2");
    await settle();
    const free = await state();
    const hasGroup = await mp.locator('#mc-pm select[data-k="lg0"]').count();
    await mp.selectOption('#mc-pm select[data-k="lg0"]', "c:g1");
    await settle();
    const guided = await state();
    const noEnds = await mp.locator('#mc-pm select[data-k="startC"]').count();
    await mp.click("#mc-ok");
    await settle();
    const done = await state();
    const cyl = Math.PI * 25 * 40;
    check(hasGroup === 1 && Math.abs(free.v - cyl) < 10 && guided.v > cyl * 1.5 && !guided.bad && noEnds === 0 && done.v === guided.v && done.types.endsWith("loft") && !done.bad,
      `model 1.119: a guide curve makes the loft between two circles bulge out to it (FR-FT-082) (${JSON.stringify({ free, guided, hasGroup, noEnds, done })})`);
    await ctx.close();
  }

  // --- 1.134: Setback fillets (FR-FT-033) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round((l.props?.volume ?? 0) * 10) / 10, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    const toPage = p => mp.evaluate(p => {
      const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, p);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -50, -30), P("b2", 50, -30), P("b3", 50, 30), P("b4", -50, 30), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "eb", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await settle();
    await runCmd(mp, "Fillet");
    await settle();
    // The three edges at the corner (50, −30, 20), radius 3.
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.radius = { v: 3 }; f.edges = [{ faces: ["eb:side:bl1", "eb:side:bl2"] }, { faces: ["eb:end", "eb:side:bl1"] }, { faces: ["eb:end", "eb:side:bl2"] }]; m.panel(); void m.rebuild(); });
    await settle();
    await mp.click('#mc-pm [data-k="sbfocus"]');
    // Click the fillet's tangent line on the top face next to the corner: that corner gets a setback.
    const [cx, cy] = await toPage([44, -27, 20]);
    await mp.mouse.move(cx, cy); await mp.waitForTimeout(50); await mp.mouse.down(); await mp.mouse.up();
    await settle();
    const sd = await mp.evaluate(() => { const f = window.__sv.model.mode().draft; return { n: f.setbacks?.length ?? 0, d: f.setbacks?.[0]?.d, inp: document.querySelector('#mc-pm input[data-sb="0"]')?.value }; });
    await mp.fill('#mc-pm input[data-sb="0"]', "8");
    await mp.press('#mc-pm input[data-sb="0"]', "Enter");
    await settle();
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend, #mc-pm .pm-help, #mc-pm .pm-field > span")].map(e => e.textContent).join("|"));
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await settle();
    const done = await mp.evaluate(() => { const f = window.__sv.model.store.doc.features.at(-1), l = window.__sv.model.last(); return { type: f.type, d: f.setbacks?.[0]?.d, patch: l.faceNames?.some(n => /:setback:0$/.test(n)) ?? null }; });
    const v3 = await state();
    // The same fillet without the setback: the patch adds a little material to the round corner.
    await mp.evaluate(() => window.__sv.model.store.change("No setback", d => { delete d.features.at(-1).setbacks; }));
    await settle();
    const v4 = await state();
    check(sd.n === 1 && sd.d === 6 && sd.inp === "6" && done.type === "fillet" && done.d === 8 && done.patch === true && !v3.bad && !v4.bad && v3.v > v4.v && v3.v < v4.v + 50,
      `model 1.134: setback fillet at a clicked corner, distance typed (FR-FT-033) (${JSON.stringify({ sd, done, v3, v4 })})`);
    check(/Параметры отступа/.test(ru) && /Вершины с отступом/.test(ru) && !/Setback|Click the box/.test(ru), `model 1.134: setback panel in Russian (${ru.slice(0, 300)})`);
    await ctx.close();
  }

  // --- 1.131: Loft connectors (FR-FT-082) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), types: window.__sv.model.store.doc.features.map(f => f.type).join(",") }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // Two 10 mm squares 10 apart.
    await mp.evaluate(() => window.__sv.model.store.change("Two squares", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), L = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (id, plane) => ({ id, type: "sketch", name: id, plane, rels: [], dims: [], ents: [P(id + "1", 0, 0), P(id + "2", 10, 0), P(id + "3", 10, 10), P(id + "4", 0, 10), L(id + "a", id + "1", id + "2"), L(id + "b", id + "2", id + "3"), L(id + "c", id + "3", id + "4"), L(id + "d", id + "4", id + "1")] });
      d.features.push(sq("Sketch1", { std: "XY" }), { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 10 } }, sq("Sketch2", { plane: "p1" }));
    }));
    await settle();
    await runCmd(mp, "Loft");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="lp0"]', "Sketch1");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="lp1"]', "Sketch2");
    await settle();
    const free = await state();
    const opts = await mp.locator('#mc-pm select[data-k="lc1"] option').count();
    await mp.selectOption('#mc-pm select[data-k="lc0"]', "Sketch11");
    await mp.selectOption('#mc-pm select[data-k="lc1"]', "Sketch21");
    await settle();
    const same = await state();
    await mp.selectOption('#mc-pm select[data-k="lc1"]', "Sketch22");
    await settle();
    const twisted = await state();
    await mp.click("#mc-ok");
    await settle();
    const done = await state();
    const conn = await mp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.type === "loft")?.connectors?.join());
    check(opts === 5 && Math.abs(free.v - 1000) < 2 && Math.abs(same.v - 1000) < 2 && twisted.v < 990 && twisted.v > 500 && !twisted.bad && done.v === twisted.v && conn === "Sketch11,Sketch22",
      `model 1.131: loft connectors pick the corners the loft joins; one corner along twists it (FR-FT-082) (${JSON.stringify({ free, same, twisted, opts, done, conn })})`);
    await ctx.close();
  }

  // --- 1.126: Check-Heal feature (FR-FT-131) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), faces: l.faceNames.length, bad: l.statuses.filter(s => !s.ok && s.code !== "warning").map(s => s.message).join(";"), report: document.querySelector("#mc-pm [data-heal]")?.textContent ?? "", types: window.__sv.model.store.doc.features.map(f => f.type).join(",") }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // Two 10 mm blocks side by side: their top, bottom and two sides stay split in two.
    await mp.evaluate(() => window.__sv.model.store.change("Two blocks", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (id, x0, x1) => ({ id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [P(id + "1", x0, 0), P(id + "2", x1, 0), P(id + "3", x1, 10), P(id + "4", x0, 10), Ln(id + "a", id + "1", id + "2"), Ln(id + "b", id + "2", id + "3"), Ln(id + "c", id + "3", id + "4"), Ln(id + "d", id + "4", id + "1")] });
      d.features.push({ ...sq("a", 0, 10), name: "Sketch1" }, { id: "ea", type: "extrude", name: "Boss-Extrude1", sketch: "a", op: "boss", end: "blind", depth: { v: 5 } },
        { ...sq("b", 10, 20), name: "Sketch2" }, { id: "eb", type: "extrude", name: "Boss-Extrude2", sketch: "b", op: "boss", end: "blind", depth: { v: 5 } });
    }));
    await settle();
    const s0 = await state();
    await runCmd(mp, "Check-Heal");
    await settle();
    const h = await state();
    await mp.check('#mc-pm input[data-k="unify"]');
    await settle();
    const u = await state();
    await mp.click("#mc-ok");
    await settle();
    const done = await state();
    check(s0.v === 1000 && h.v === 1000 && /^Check and heal: 0 free edges before, 0 after; valid before, valid after; 1 solid bodies\.$/.test(h.report) && u.faces === 6 && s0.faces > 6 && u.v === 1000 && done.faces === 6 && done.types.endsWith("heal") && !done.bad,
      `model 1.126: Check-Heal reports the body and merges its split faces (FR-FT-131) (${JSON.stringify({ s0, h, u, done })})`);
    await ctx.close();
  }

  // --- 1.108: Indent a plate with a tool body, with a wall and as a cut (FR-BODY-007) ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), bodies: l.props?.bodies ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent ?? null }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 20 × 5 plate and a 10 × 10 block from z = 1 to 21 as its own body: they share 400 mm³.
    await mp.evaluate(() => window.__sv.model.store.change("Plate and punch", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (id, x0, x1, y0, y1) => ({ id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [P(id + "1", x0, y0), P(id + "2", x1, y0), P(id + "3", x1, y1), P(id + "4", x0, y1), Ln(id + "a", id + "1", id + "2"), Ln(id + "b", id + "2", id + "3"), Ln(id + "c", id + "3", id + "4"), Ln(id + "d", id + "4", id + "1")] });
      d.features.push({ ...sq("a", -20, 20, -10, 10), name: "Sketch1" }, { id: "ea", type: "extrude", name: "Boss-Extrude1", sketch: "a", op: "boss", end: "blind", depth: { v: 5 } },
        { ...sq("b", -5, 5, -5, 5), name: "Sketch2" }, { id: "eb", type: "extrude", name: "Boss-Extrude2", sketch: "b", op: "boss", end: "blind", depth: { v: 20 }, start: "offset", startOffset: { v: 1 }, merge: false });
    }));
    await settle();
    const s0 = await state();
    await runCmd(mp, "Indent");
    await settle();
    const focus0 = await mp.evaluate(() => window.__sv.model.mode().focus);
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.main = { name: "ea:end" }; f.tools = [{ name: "eb:end" }]; m.panel(); void m.rebuild(); });
    await settle();
    const w = await state();
    await mp.check('#mc-pm input[data-k="cut"]');
    await settle();
    const c = await state();
    const thick = await mp.locator('#mc-pm input[data-num="thickness"]').count();
    await mp.uncheck('#mc-pm input[data-k="cut"]');
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const done = await state();
    const wall = w.v - 5600;
    check(s0.v === 6000 && s0.bodies === 2 && focus0 === "main" && w.title === "Indent" && !w.bad && wall > 100 && wall < 196 && c.v === 5600 && thick === 0 && done.v === w.v && done.bodies === 2 && !done.bad,
      `model 1.108: Indent cuts the punch out of the plate with a wall under it, or as a cut (FR-BODY-007) (${JSON.stringify({ s0, focus0, w, c, thick, done })})`);
    // Sweep start tangency: a 6 × 4 profile flat on Top swept along a 40 mm line at 45°, away from the plate.
    await mp.evaluate(() => window.__sv.model.store.change("Tilted sweep", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b }), s = 40 / Math.SQRT2;
      d.features.push({ id: "sp", type: "sketch", name: "Sketch3", plane: { std: "XZ" }, rels: [], dims: [], ents: [P("sp1", 100, 0), P("sp2", 100 + s, s), Ln("spl", "sp1", "sp2")] },
        { id: "sr", type: "sketch", name: "Sketch4", plane: { std: "XY" }, rels: [], dims: [], ents: [P("sr1", 97, -2), P("sr2", 103, -2), P("sr3", 103, 2), P("sr4", 97, 2), Ln("sra", "sr1", "sr2"), Ln("srb", "sr2", "sr3"), Ln("src", "sr3", "sr4"), Ln("srd", "sr4", "sr1")] },
        { id: "sw", type: "sweep", name: "Sweep1", op: "boss", profile: "sr", path: { sketch: "sp" }, orient: "normal" });
    }));
    await settle();
    const t0 = await state();
    await mp.evaluate(() => window.__sv.modeller.editFeature("sw"));
    await settle();
    await mp.selectOption('#mc-pm select[data-k="orient"]', "follow").catch(() => {});
    await settle();
    await mp.selectOption('#mc-pm select[data-k="startTan"]', "path");
    await settle();
    const t1 = await state();
    await mp.click("#mc-ok");
    await settle();
    const tan = await mp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.id === "sw").startTangent);
    check(Math.abs(t0.v - done.v - 960 / Math.SQRT2) < 2 && Math.abs(t1.v - done.v - 960) < 2 && tan === true && !t1.bad,
      `model 1.108: sweep start tangency Path tangent turns the profile square to the path (FR-FT-080) (${JSON.stringify({ base: done.v, t0, t1, tan })})`);
    // End tangency (1.143.0): with the start already square the end section matches it, so the solid is the same prism.
    await mp.evaluate(() => window.__sv.modeller.editFeature("sw"));
    await settle();
    await mp.selectOption('#mc-pm select[data-k="endTan"]', "path");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const t2 = await state();
    const etan = await mp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.id === "sw").endTangent);
    check(etan === true && Math.abs(t2.v - done.v - 960) < 2 && !t2.bad, `model 1.143: sweep end tangency Path tangent (FR-FT-080) (${JSON.stringify({ t2, etan })})`);
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "indent").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm label")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "Вдавливание" && !/[A-Za-z]{3}/.test(ru.text.replace(/mm|Enter|Esc/g, "")), `model 1.108: Indent panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.98: parting line draft clicked on the edge, loft normal to its profiles (FR-FT-061, FR-FT-082) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round((l.props?.volume ?? 0) * 10) / 10, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    const toPage = p => mp.evaluate(p => {
      const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, p);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // Two stacked 100 × 60 × 10 blocks: the edge between their −Y sides is the parting line.
    await mp.evaluate(() => window.__sv.model.store.change("Blocks", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const box = (k, plane) => ({ id: k, type: "sketch", name: k, plane, rels: [], dims: [], ents: [P(k + "1", -50, -30), P(k + "2", 50, -30), P(k + "3", 50, 30), P(k + "4", -50, 30), Ln(k + "l1", k + "1", k + "2"), Ln(k + "l2", k + "2", k + "3"), Ln(k + "l3", k + "3", k + "4"), Ln(k + "l4", k + "4", k + "1")] });
      d.features.push(box("a", { std: "XY" }), { id: "ea", type: "extrude", name: "Boss-Extrude1", sketch: "a", op: "boss", end: "blind", depth: { v: 10 } },
        box("b", { face: { name: "ea:end" } }), { id: "eb", type: "extrude", name: "Boss-Extrude2", sketch: "b", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await settle();
    await mp.click('#mc-tools [data-c="draft"]');
    await settle();
    await mp.selectOption('#mc-pm select[data-k="dkind"]', "parting");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.plane = { std: "XY" }; m.mode().focus = "faces"; m.panel(); void m.rebuild(); });
    await settle();
    await mp.fill('#mc-pm input[data-num="angle"]', "5");
    await mp.press('#mc-pm input[data-num="angle"]', "Tab");
    await settle();
    const [ex, ey] = await toPage([0, -30, 10]);
    await mp.mouse.move(ex, ey); await mp.waitForTimeout(50); await mp.mouse.down(); await mp.mouse.up();
    await settle();
    const dd = await mp.evaluate(() => { const f = window.__sv.model.mode().draft; return { kind: f.kind, edges: f.parting?.map(e => e.faces.slice().sort().join("+")), other: !!document.querySelector('#mc-pm input[data-k="other"]') }; });
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend, #mc-pm .pm-help, #mc-pm label > span, #mc-pm option:checked, #mc-pm label.chk")].map(e => e.textContent).join("|"));
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await settle();
    const d1 = await state();
    const wedge = 100 * 0.5 * 10 * 10 * Math.tan(5 * Math.PI / 180);
    check(dd.kind === "parting" && dd.edges?.length === 1 && /ea:side/.test(dd.edges[0]) && /eb:side/.test(dd.edges[0]) && dd.other && Math.abs(Math.abs(120000 - d1.v) - wedge) < 1 && !d1.bad,
      `model 1.98: parting line draft from a clicked edge, 5° (FR-FT-061) (${JSON.stringify({ dd, d1, wedge })})`);
    check(/Линия разъёма/.test(ru) && /Направление извлечения/.test(ru) && /Другая грань/.test(ru) && !/Parting line|Direction of pull/.test(ru), `model 1.98: draft panel in Russian (${ru.slice(0, 300)})`);
    // Loft between two 20 mm squares (the top one 15 mm over), normal to both profiles from the panel.
    await mp.evaluate(() => window.__sv.model.store.change("Squares", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      const sq = (k, cx, plane) => ({ id: k, type: "sketch", name: k, plane, rels: [], dims: [], ents: [P(k + "1", cx - 10, -10), P(k + "2", cx + 10, -10), P(k + "3", cx + 10, 10), P(k + "4", cx - 10, 10), Ln(k + "l1", k + "1", k + "2"), Ln(k + "l2", k + "2", k + "3"), Ln(k + "l3", k + "3", k + "4"), Ln(k + "l4", k + "4", k + "1")] });
      d.features.push({ id: "p1", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 50 } }, { id: "p2", type: "plane", name: "Plane2", mode: "offset", base: { std: "XY" }, offset: { v: 80 } },
        sq("q1", 0, { plane: "p1" }), sq("q2", 15, { plane: "p2" }));
    }));
    await settle();
    const before = (await state()).v;
    await runCmd(mp, "Loft");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.profiles = ["q1", "q2"]; m.panel(); void m.rebuild(); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="startC"]', "normal");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="endC"]', "normal");
    await settle();
    const ld = await mp.evaluate(() => { const f = window.__sv.model.mode().draft; return { s: f.startNormal, e: f.endNormal, len: !!document.querySelector('#mc-pm input[data-k="startLen"]') }; });
    await mp.click("#mc-ok");
    await settle();
    const l1 = await state();
    check(ld.s && ld.e && ld.len && Math.abs(l1.v - before - 12000) < 15 && !l1.bad, `model 1.98: loft normal to its start and end profiles (FR-FT-082) (${JSON.stringify({ ld, l1, before })})`);
    await ctx.close();
  }

  // --- 1.98: vertex chamfer clicked on a corner, multi-thickness shell (FR-FT-041, FR-FT-060) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round((l.props?.volume ?? 0) * 10) / 10, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    const toPage = p => mp.evaluate(p => {
      const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
    }, p);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -50, -30), P("b2", 50, -30), P("b3", 50, 30), P("b4", -50, 30), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "eb", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await settle();
    await mp.click('#mc-tools [data-c="chamfer"]');
    await settle();
    await mp.selectOption('#mc-pm select[data-k="mode"]', "vertex");
    await settle();
    for (const k of ["distance", "distance2", "distance3"]) {
      await mp.fill(`#mc-pm input[data-num="${k}"]`, "5");
      await mp.press(`#mc-pm input[data-num="${k}"]`, "Enter");
      await settle();
    }
    // Click on the top front edge 3 mm from the corner (50, −30, 20): that corner is picked.
    const [cx, cy] = await toPage([47, -30, 20]);
    await mp.mouse.move(cx, cy); await mp.waitForTimeout(50); await mp.mouse.down(); await mp.mouse.up();
    await settle();
    const vd = await mp.evaluate(() => { const f = window.__sv.model.mode().draft; return { mode: f.mode, n: f.vertices?.length ?? 0, at: f.vertices?.[0]?.at, d3: !!document.querySelector('#mc-pm input[data-num="distance3"]'), items: document.querySelector("#mc-pm .pm-count")?.textContent }; });
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend, #mc-pm .pm-help, #mc-pm label > span, #mc-pm option:checked, #mc-pm .pm-count")].map(e => e.textContent).join("|"));
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await settle();
    const v1 = await state();
    check(vd.mode === "vertex" && vd.n === 1 && vd.d3 && Math.abs(v1.v - (120000 - 125 / 6)) < 0.1 && !v1.bad,
      `model 1.98: vertex chamfer on a clicked corner, 5 mm each way (FR-FT-041) (${JSON.stringify({ vd, v1 })})`);
    check(/Расстояние 3/.test(ru) && /Вершина/.test(ru) && !/Distance 3|Click near a corner/.test(ru), `model 1.98: vertex chamfer panel in Russian (${ru.slice(0, 300)})`);
    // Shell 2 mm open at the top (on the plain block); the +X wall gets 5 mm typed in the multi-thickness list.
    await mp.evaluate(() => window.__sv.model.store.change("Drop chamfer", d => { d.features.pop(); }));
    await settle();
    await mp.click('#mc-tools [data-c="shell"]');
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.faces = [{ name: "eb:end" }]; f.thickness = { v: 2 }; m.panel(); void m.rebuild(); });
    await settle();
    await mp.click('#mc-pm [data-focus="mthick"]');
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.multi = [{ name: "eb:side:bl2", t: 4 }]; m.panel(); void m.rebuild(); });
    await settle();
    await mp.fill('#mc-pm input[data-mt="0"]', "5");
    await mp.press('#mc-pm input[data-mt="0"]', "Enter");
    await settle();
    const sd = await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; return { focus: m.mode().focus, multi: f.multi }; });
    await mp.click("#mc-ok");
    await settle();
    const v2 = await state();
    check(sd.focus === "mthick" && sd.multi?.[0]?.t === 5 && Math.abs(v2.v - (120000 - 93 * 56 * 18)) < 1 && !v2.bad,
      `model 1.98: multi-thickness shell, one wall 5 mm (FR-FT-060) (${JSON.stringify({ sd, v2, want: 120000 - 93 * 56 * 18 })})`);
    await ctx.close();
  }

  // --- 1.96: slot hole up to next, extrude up to body (FR-FT-050, FR-FT-012) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round((l.props?.volume ?? 0) * 10) / 10, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -50, -30), P("b2", 50, -30), P("b3", 50, 30), P("b4", -50, 30), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "eb", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } });
    }));
    await settle();
    await mp.click('#mc-tools [data-c="hole"]');
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model, f = m.mode().draft; f.plane = { face: { name: "eb:end" } }; f.pts = [[0, 0]]; m.mode().focus = "pts"; m.panel(); void m.rebuild(); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="kind"]', "slot");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="end"]', "next");
    await settle();
    const hd = await mp.evaluate(() => { const f = window.__sv.model.mode().draft; return { d: f.diameter.v, L: f.slotLen?.v, kind: f.kind, end: f.end, fields: !!document.querySelector('#mc-pm input[data-num="slotLen"]') }; });
    const h1 = await state();
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend, #mc-pm .pm-help, #mc-pm label > span, #mc-pm option:checked")].map(e => e.textContent).join("|"));
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await settle();
    const h2 = await state();
    const r = hd.d / 2, want = 120000 - 20 * (Math.PI * r * r + 2 * r * (hd.L ?? 0));
    check(hd.kind === "slot" && hd.end === "next" && hd.fields && hd.L > 0 && Math.abs(h1.v - want) < 1 && Math.abs(h2.v - want) < 1 && !h2.bad,
      `model 1.96: slot hole up to next goes through the block (FR-FT-050) (${JSON.stringify({ hd, h1, h2, want })})`);
    check(/Длина паза/.test(ru) && /До следующей|До след/.test(ru) && !/Slot length|Up to next/.test(ru), `model 1.96: hole panel in Russian (${ru.slice(0, 300)})`);
    // Up to body: a Ø10 post grows from the block's top to a separate block 30 mm above.
    await mp.evaluate(() => window.__sv.model.store.change("Lid and post", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "pl", type: "plane", name: "Plane1", mode: "offset", base: { std: "XY" }, offset: { v: 50 } },
        { id: "s2", type: "sketch", name: "Sketch2", plane: { plane: "pl" }, rels: [], dims: [], ents: [P("s1", 10, -10), P("s2", 30, -10), P("s3", 30, 10), P("s4", 10, 10), Ln("sa", "s1", "s2"), Ln("sb", "s2", "s3"), Ln("sc", "s3", "s4"), Ln("sd", "s4", "s1")] },
        { id: "e2", type: "extrude", name: "Boss-Extrude2", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 }, merge: false },
        { id: "c", type: "sketch", name: "Sketch3", plane: { face: { name: "eb:end" } }, rels: [], dims: [], ents: [P("c0", 20, 0), { id: "ck", t: "circle", c: "c0", r: 5 }] },
        { id: "e3", type: "extrude", name: "Boss-Extrude3", sketch: "c", op: "boss", end: "body", depth: { v: 1 }, upToBody: { name: "e2:start" } });
    }));
    await settle();
    const ub = await state();
    check(Math.abs(ub.v - (h2.v + 4000 + Math.PI * 25 * 30)) < 1 && !ub.bad, `model 1.96: extrude up to body stops at the other body (FR-FT-012) (${JSON.stringify({ ub, before: h2.v })})`);
    await ctx.close();
  }

  // --- 1.90: sketch- and table-driven patterns, patterns of faces (FR-FT-070, FR-FT-073) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const state = () => mp.evaluate(() => { const l = window.__sv.model.last(); return { v: Math.round(l.props?.volume ?? 0), bodies: l.props?.bodies ?? 0, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), title: document.querySelector("#mc-pm h3")?.textContent ?? null }; });
    const setDraft = fn => mp.evaluate(fn => { const m = window.__sv.model; new Function("f", "names", fn)(m.mode().draft, m.last().faceNames); m.panel(); void m.rebuild(); }, fn);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 100 × 60 × 10 block with a Ø10 × 5 boss at (−40, −20), and a sketch of two free points on top.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -50, -30), P("b2", 50, -30), P("b3", 50, 30), P("b4", -50, 30), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "eb", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 10 } },
        { id: "c", type: "sketch", name: "Sketch2", plane: { face: { name: "eb:end" } }, rels: [], dims: [], ents: [P("c0", -40, -20), { id: "ck", t: "circle", c: "c0", r: 5 }] },
        { id: "ec", type: "extrude", name: "Boss-Extrude2", sketch: "c", op: "boss", end: "blind", depth: { v: 5 } },
        { id: "k", type: "sketch", name: "Sketch3", plane: { face: { name: "eb:end" } }, rels: [], dims: [], ents: [P("k1", 0, 0), P("k2", 20, 10)] });
    }));
    await settle();
    const v0 = (await state()).v, boss = Math.PI * 25 * 5;
    await mp.click('#mc-tools [data-fly="pattern"]');
    await mp.locator("#mc-menu button", { hasText: /^Sketch driven pattern$/ }).click();
    await settle();
    const sk = await mp.evaluate(() => window.__sv.model.mode().draft.sketch);
    await setDraft('f.features = ["ec"];');
    await settle();
    const s1 = await state();
    // Copy the boss's faces instead of the feature: the same result.
    await mp.selectOption('#mc-pm select[data-k="copyKind"]', "faces");
    await settle();
    await setDraft('f.faces = names.filter(n => n.startsWith("ec:") && n !== "ec:start").map(name => ({ name }));');
    await settle();
    const s2 = await state();
    await mp.click("#mc-ok");
    await settle();
    const s3 = await state();
    check(sk === "k" && s1.title === "Sketch driven pattern" && Math.abs(s1.v - (v0 + 2 * boss)) < 2 && Math.abs(s2.v - s1.v) < 2 && !s3.bad && Math.abs(s3.v - s1.v) < 2,
      `model 1.90: sketch driven pattern copies a boss (feature or faces) to the sketch's points (FR-FT-073, FR-FT-070) (${JSON.stringify({ sk, v0, s1, s2, s3 })})`);
    // Table driven: rows typed as X, Y offsets.
    await mp.click('#mc-tools [data-fly="pattern"]');
    await mp.locator("#mc-menu button", { hasText: /^Table driven pattern$/ }).click();
    await settle();
    await setDraft('f.features = ["ec"];');
    await settle();
    await mp.fill('#mc-pm textarea[data-k="tableText"]', "0, 40\n20, 40\n40, 40");
    await mp.dispatchEvent('#mc-pm textarea[data-k="tableText"]', "change");
    await settle();
    const t1 = await state();
    const rows = await mp.evaluate(() => window.__sv.model.mode().draft.table.length);
    // In Russian: the panel.
    await mp.click("#lang-btn");
    await mp.waitForTimeout(200);
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm button, #mc-pm .pm-help, #mc-pm label, #mc-pm .pm-count")].map(e => e.textContent).join("|") }));
    await mp.click("#lang-btn");
    await mp.click("#mc-ok");
    await settle();
    const t2 = await state();
    check(rows === 3 && t1.title === "Table driven pattern" && Math.abs(t2.v - (v0 + 5 * boss)) < 3 && !t2.bad,
      `model 1.90: table driven pattern adds a copy per X, Y row (FR-FT-073) (${JSON.stringify({ rows, t1, t2 })})`);
    check(ru.title === "Массив, управляемый таблицей" && !/[A-Za-z]{3}/.test(ru.text.replace(/mm|Enter|Esc|Boss-Extrude2/g, "")), `model 1.90: pattern panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- 1.89: sketch snaps to model geometry (relations to the model) and middle-drag orbit while sketching ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    const scr = w => mp.evaluate(w => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const q = new v.camera.position.constructor(...w).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; }, w);
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    // A 40 × 20 × 20 block, then a sketch on its top face.
    await mp.evaluate(() => window.__sv.model.store.change("Block", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "b", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b1", -20, -10), P("b2", 20, -10), P("b3", 20, 10), P("b4", -20, 10), Ln("bl1", "b1", "b2"), Ln("bl2", "b2", "b3"), Ln("bl3", "b3", "b4"), Ln("bl4", "b4", "b1")] },
        { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "b", op: "boss", end: "blind", depth: { v: 20 } },
        { id: "k", type: "sketch", name: "Sketch2", plane: { face: { name: "e:end" } }, rels: [], dims: [], ents: [] });
    }));
    await settle();
    await mp.evaluate(() => window.__sv.modeller.editSketch("k"));
    await settle();
    await mp.evaluate(() => window.__sv.viewer.viewFrom(new window.__sv.viewer.camera.position.constructor(1, -1, 1), false));
    await mp.waitForTimeout(300);
    // Line tool: start on the block's top corner (20, 10, 20), end at the middle of the top.
    await mp.evaluate(() => window.__sv.model.editor().setTool("line"));
    const [cx, cy] = await scr([20, 10, 20]);
    await mp.mouse.move(cx + 3, cy + 2); await mp.mouse.move(cx + 1, cy + 1);
    await mp.mouse.click(cx + 1, cy + 1);
    const [mx, my] = await scr([0, 0, 20]);
    await mp.mouse.move(mx, my); await mp.mouse.click(mx, my);
    await mp.keyboard.press("Escape");
    await settle();
    const sk = await mp.evaluate(() => { const ed = window.__sv.model.editor(); const s = ed.sk; const line = s.ents.find(e => e.t === "line" && !e.cons); const a = line && s.ents.find(e => e.id === line.a); return { cons: s.ents.filter(e => e.cons).length, ext: s.rels.filter(r => r.ext).length, a: a ? [a.x, a.y] : null }; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await settle();
    // The block grows to 60 wide: the line's start follows the corner.
    await mp.evaluate(() => window.__sv.model.store.change("Wider", d => { const s = d.features.find(f => f.id === "b"); s.ents.find(e => e.id === "b2").x = 30; s.ents.find(e => e.id === "b3").x = 30; }));
    await settle();
    const moved = await mp.evaluate(() => { const s = window.__sv.model.store.doc.features.find(f => f.id === "k"); const line = s.ents.find(e => e.t === "line" && !e.cons); const a = s.ents.find(e => e.id === line.a); return { a: [a.x, a.y], bad: window.__sv.model.last().statuses.filter(x => !x.ok).length }; });
    check(sk.cons === 1 && sk.ext === 1 && sk.a && Math.hypot(sk.a[0] - 20, sk.a[1] - 10) < 1e-6 && Math.hypot(moved.a[0] - 30, moved.a[1] - 10) < 1e-6 && !moved.bad,
      `model 1.89: a sketch point snapped to a model vertex follows it when the model changes (${JSON.stringify({ sk, moved })})`);
    // Smart Dimension from the line to a model edge (the top's front edge, at its midpoint): a new reference and a dimension.
    await mp.evaluate(() => window.__sv.modeller.editSketch("k"));
    await settle();
    await mp.evaluate(() => { window.__sv.viewer.viewFrom(new window.__sv.viewer.camera.position.constructor(1, -1, 1), false); window.__sv.model.editor().setTool("dim"); });
    await mp.waitForTimeout(300);
    const [lx, ly] = await scr([15, 5, 20]);
    await mp.mouse.move(lx, ly); await mp.mouse.click(lx, ly);
    const [ex2, ey2] = await scr([5, -10, 20]);
    await mp.mouse.move(ex2, ey2); await mp.mouse.click(ex2, ey2);
    const [px, py] = await scr([0, -20, 20]);
    await mp.mouse.move(px, py); await mp.mouse.click(px, py);
    await mp.waitForTimeout(200);
    await mp.evaluate(() => window.__sv.model.editor().closeInput(false));
    const dm = await mp.evaluate(() => { const s = window.__sv.model.editor().sk; return { dims: s.dims.length, ext: s.rels.filter(r => r.ext).length, cons: s.ents.filter(e => e.cons).length }; });
    await mp.evaluate(() => window.__sv.modeller.ok());
    await settle();
    check(dm.dims === 1 && dm.ext === 2 && dm.cons === 2, `model 1.89: Smart Dimension takes a model edge (${JSON.stringify(dm)})`);
    // Middle-drag orbits while sketching (it pans elsewhere). Last, as the orbit coasts on after the drag.
    await mp.evaluate(() => window.__sv.modeller.editSketch("k"));
    await settle();
    const cam = () => mp.evaluate(() => window.__sv.viewer.camera.position.toArray());
    const c0 = await cam();
    await mp.mouse.move(700, 600); await mp.mouse.down({ button: "middle" }); await mp.mouse.move(760, 560, { steps: 6 }); await mp.mouse.up({ button: "middle" });
    const c1 = await cam();
    const turned = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) > 1;
    await mp.evaluate(() => window.__sv.modeller.cancel());
    await settle();
    check(turned, `model 1.89: middle-drag orbits the view while sketching (${JSON.stringify({ c0, c1 })})`);
    await ctx.close();
  }

  // 1.78.0: surface analyses (FR-MEA-005) on a modelled block, and the drawing view palette (FR-UI-072).
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ap = await ctx.newPage();
    ap.on("pageerror", e => errors.push(e.message));
    ap.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await ap.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await ap.goto(`${origin}/index.html?debug`);
    await ap.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    // A 100 × 60 × 20 block with a Ø16 hole through it.
    const part = { schema: 1, kind: "part", id: "d_anablock", name: "Block", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [P("c0", 10, 0), { id: "c1", t: "circle", c: "c0", r: 8 }] },
      { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await ap.setInputFiles("#file-input", { name: "Block.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await ap.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    const runAna = async kind => {
      if (await ap.isHidden("#ana-panel")) { await ap.click("#display-btn"); await ap.selectOption("#analysis", kind); await ap.click("#display-btn"); }
      else await ap.selectOption("#ana-panel [data-k=kind]", kind);
      await ap.waitForFunction(k => window.__sv.surfAna.kind === k && !window.__sv.surfAna.busy, kind, { timeout: 60000 });
      return ap.evaluate(() => { const a = window.__sv.surfAna; return { areas: Object.fromEntries(Object.entries(a.areas).map(([k, v]) => [k, Math.round(v)])), max: Math.round(a.max * 1000) / 1000, legend: document.querySelectorAll("#ana-panel .ana-legend li").length }; });
    };
    // Draft along +Z: top and bottom less the hole, the four sides and the hole wall have none.
    const hole = Math.PI * 64, wall = 2 * Math.PI * 8 * 20;
    const dr = await runAna("draft");
    const near = (a, b, tol) => Math.abs((a ?? 0) - b) <= tol;
    check(near(dr.areas.pos, 6000 - hole, 30) && near(dr.areas.neg, 6000 - hole, 30) && near(dr.areas.low, 6400 + wall, 30) && dr.legend === 3,
      `analysis: draft along +Z colours top green, bottom red and the walls yellow, with areas (${JSON.stringify(dr)})`);
    // Thickness: with a 25 mm minimum the 20 mm top and bottom are thin; the sides are 60 or 100 mm across.
    await ap.selectOption("#ana-panel [data-k=kind]", "thickness");
    await ap.fill("#ana-panel [data-k=minWall]", "25");
    await ap.dispatchEvent("#ana-panel [data-k=minWall]", "change");
    await ap.waitForFunction(() => window.__sv.surfAna.s.minWall === 25 && !window.__sv.surfAna.busy && window.__sv.surfAna.total > 0, null, { timeout: 60000 });
    const th = await ap.evaluate(() => Object.fromEntries(Object.entries(window.__sv.surfAna.areas).map(([k, v]) => [k, Math.round(v)])));
    check(th.thin > 2 * (6000 - hole) - 60 && th.thin < 2 * (6000 - hole) + wall && (th.ok ?? 0) > 6000 && !th.open, `analysis: wall thickness flags the 20 mm top and bottom (and the hole wall 22 mm from the sides) under a 25 mm minimum (${JSON.stringify(th)})`);
    // Undercut: a plain block with a through hole has none; curvature knows the hole's radius; zebra wears its own material.
    const uc = await runAna("undercut");
    const cu = await runAna("curvature");
    const zb = await runAna("zebra");
    const zmat = await ap.evaluate(() => window.__sv.viewer.parts.every(p => p.mesh.material.type === "ShaderMaterial"));
    check(!uc.areas.under && near(uc.areas.up, 6000 - hole, 30) && Math.abs(cu.max - 1 / 8) < 0.01 && zmat, `analysis: no undercut on the block, curvature up to 1/8 mm⁻¹, zebra stripes (${JSON.stringify([uc.areas, cu.max, zmat])})`);
    // In Russian, then off: the parts get their own material back.
    await ap.click("#lang-btn");
    const ruAna = await ap.evaluate(() => document.querySelector("#ana-panel").textContent);
    await ap.click("#lang-btn");
    await ap.click("#ana-panel [data-a=close]");
    const off = await ap.evaluate(() => ({ hidden: document.querySelector("#ana-panel").hidden, own: window.__sv.viewer.parts.every(p => p.mesh.material === p.material) }));
    check(/Полосы/.test(ruAna) && !/[A-Za-z]{3}/.test(ruAna) && off.hidden && off.own, `analysis: panel in Russian; turning it off restores the parts (${JSON.stringify([ruAna.slice(0, 60), off])})`);

    // Drawing view palette: every standard view drawn; drag the isometric one onto the sheet.
    await ap.click("#new-more"); await ap.click("#new-drawing");
    await ap.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ap.waitForFunction(() => [...document.querySelectorAll(".drw-pt path")].every(p => p.getAttribute("d")), null, { timeout: 60000 });
    const tiles = await ap.evaluate(() => [...document.querySelectorAll(".drw-pt")].map(b => b.dataset.pal).join(","));
    const svg = await ap.locator(".drw-svg").boundingBox();
    await ap.locator('[data-pal="iso"]').dragTo(ap.locator(".drw-svg"), { targetPosition: { x: svg.width * 0.75, y: svg.height * 0.3 } });
    await ap.waitForFunction(() => window.__sv.drw.doc().sheets[0].views.length === 4, null, { timeout: 10000 });
    await ap.keyboard.press("Escape");
    const iso = await ap.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views.at(-1); return { orient: v.orient, style: v.style, x: v.x, y: v.y, parent: v.parent ?? null }; });
    check(tiles === "front,top,right,iso,back,bottom,left" && iso.orient === "iso" && iso.style === "hlr" && !iso.parent && iso.x > 200 && iso.y > 150,
      `drawing palette: seven standard views, the isometric one dropped where it was let go (${tiles}, ${JSON.stringify(iso)})`);
    // Clicking a tile, then the sheet, places it too.
    await ap.click('[data-pal="bottom"]');
    await ap.locator(".drw-svg").click({ position: { x: svg.width * 0.75, y: svg.height * 0.75 } });
    await ap.keyboard.press("Escape");
    const n = await ap.evaluate(() => window.__sv.drw.doc().sheets[0].views.filter(v => v.orient === "bottom").length);
    check(n === 1, `drawing palette: click a view, then the sheet, places it (${n})`);
    // Inference line: a new front view placed 1 mm off the first view's centre lines up with it.
    const front = await ap.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0]; return [v.x, v.y]; });
    await ap.click('[data-pal="front"]');
    const at = await ap.evaluate(([x, y]) => window.__sv.drw.sheetPt(x + 1, y - 120), front);
    await ap.mouse.move(at[0], at[1]);
    const guide = await ap.evaluate(() => document.querySelectorAll(".drw-ovl .drw-guide").length);
    await ap.mouse.click(at[0], at[1]);
    await ap.keyboard.press("Escape");
    const placed = await ap.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views.at(-1); return [v.orient, v.x, v.y]; });
    check(guide >= 1 && placed[0] === "front" && placed[1] === front[0], `drawing: inference line lines a new view up with another view's centre (${guide} guide, ${JSON.stringify([placed, front])})`);
    // Annotation tab: the tools beside the sheet start the same commands.
    await ap.click('[data-ptab="annot"]');
    const tab = await ap.evaluate(() => ({ views: document.querySelector("#drw-pane-views").hidden, annot: document.querySelector("#drw-pane-annot").hidden, n: document.querySelectorAll("#drw-pane-annot button").length }));
    await ap.click('#drw-pane-annot [data-an="note"]');
    const mode = await ap.evaluate(() => window.__sv.drw.mode());
    await ap.keyboard.press("Escape");
    check(tab.views && !tab.annot && tab.n === 21 && mode === "note", `drawing: annotation tab shows the 21 annotation tools; Note starts the note command (${JSON.stringify([tab, mode])})`);
    // 1.82.0 break view (FR-DRW-015): select the first front view, leave out u = −25…15 mm; it closes up to a 6 mm gap.
    const fv = await ap.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0]; const pl = window.__sv.drw.placement(v.id); return { id: v.id, x: v.x, y: v.y, s: pl.s, w: pl.box[2] - pl.box[0], uc: pl.uc }; });
    const clickAt = async (x, y) => { const q = await ap.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]); await ap.mouse.click(q[0], q[1]); };
    await clickAt(fv.x + (35 - fv.uc) * fv.s, fv.y);
    await ap.click('.drw-props [data-a="vbreak"]');
    await clickAt(fv.x + (-25 - fv.uc) * fv.s, fv.y);
    await clickAt(fv.x + (15 - fv.uc) * fv.s, fv.y);
    const br = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); const pl = window.__sv.drw.placement(id); return { breaks: v.breaks, w: pl.box[2] - pl.box[0], zig: (window.__sv.drw.svg().match(/<polyline/g) ?? []).length, mode: window.__sv.drw.mode() }; }, fv.id);
    check(br.breaks?.length === 1 && Math.abs(br.breaks[0].a + 25) < 0.6 && Math.abs(br.breaks[0].b - 15) < 0.6 && Math.abs(br.w - (fv.w - 40 + 6 / fv.s)) < 1 && br.mode === "none",
      `drawing: break view leaves out the picked band and closes up (${JSON.stringify([fv, br])})`);
    // Crop view: replace the break with a crop around the hole end.
    await ap.click('.drw-props [data-a="unbreak"]');
    await ap.click('.drw-props [data-a="crop"]');
    await clickAt(fv.x + (0 - fv.uc) * fv.s, fv.y - 15 * fv.s);
    await clickAt(fv.x + (40 - fv.uc) * fv.s, fv.y + 15 * fv.s);
    const cr = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); const pl = window.__sv.drw.placement(id); return { crop: v.crop, breaks: v.breaks ?? null, w: pl.box[2] - pl.box[0], h: pl.box[3] - pl.box[1], ru: !!document.querySelector('.drw-props [data-a="uncrop"]') }; }, fv.id);
    check(cr.crop && !cr.breaks && Math.abs(cr.w - 40) < 1 && Math.abs(cr.h - 20) < 0.6 && cr.ru, `drawing: crop view keeps only the rectangle (${JSON.stringify(cr)})`);
    // Drafting style (FR-DRW-025): with nothing selected, the sheet panel sets 5 mm text, oblique strokes and the 0.7 line group.
    await ap.keyboard.press("Escape");
    await clickAt(30, 260);
    await ap.selectOption('.drw-props [data-st="text"]', "5");
    await ap.selectOption('.drw-props [data-st="arrow"]', "tick");
    await ap.selectOption('.drw-props [data-st="lines"]', "0.7");
    const sty = await ap.evaluate(() => ({ style: window.__sv.drw.doc().style, svg: /stroke-width="0.7"/.test(window.__sv.drw.svg()) }));
    check(sty.style?.text === 5 && sty.style?.arrow === "tick" && sty.style?.lines === 0.7 && sty.svg, `drawing: drafting style is kept with the drawing and thickens visible lines (${JSON.stringify(sty)})`);
    // 1.87.0 view properties (FR-DRW-017): break a projected view's alignment, drag it off line, then put it back in line.
    const pv0 = await ap.evaluate(() => { const sh = window.__sv.drw.doc().sheets[0]; const v = sh.views.find(x => x.parent && x.side && !x.kind); const p = sh.views.find(x => x.id === v.parent); return { id: v.id, x: v.x, y: v.y, px: p.x, py: p.y, side: v.side }; });
    await clickAt(pv0.x, pv0.y);
    const boxes = await ap.evaluate(() => ({ th: !!document.querySelector('.drw-props [data-v="threads"]:checked'), sk: !!document.querySelector('.drw-props [data-v="sketches"]') }));
    await ap.check('.drw-props [data-v="sketches"]');
    await ap.click('.drw-props [data-a="unalign"]');
    const q0 = await ap.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [pv0.x, pv0.y]);
    await ap.mouse.move(q0[0], q0[1]); await ap.mouse.down();
    await ap.mouse.move(q0[0] + 40, q0[1] + 30, { steps: 5 }); await ap.mouse.up();
    const pv1 = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); return { free: v.free, sketches: v.sketches, x: v.x, y: v.y }; }, pv0.id);
    await ap.click('.drw-props [data-a="align"]');
    const pv2 = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); return { free: v.free ?? null, x: v.x, y: v.y }; }, pv0.id);
    const inLine = pv0.side[0] ? Math.abs(pv2.y - pv0.py) < 1e-6 : Math.abs(pv2.x - pv0.px) < 1e-6;
    check(boxes.th && boxes.sk && pv1.free && pv1.sketches && Math.abs(pv1.x - pv0.x) > 3 && Math.abs(pv1.y - pv0.y) > 3 && pv2.free === null && inLine,
      `drawing: break alignment frees a projected view; default alignment puts it back in line (${JSON.stringify([pv0, pv1, pv2, boxes])})`);
    // 1.90.0 user sheet format (FR-DRW-004): edit the title block from the ISO one, add a logo, save and use it; back to ISO.
    await ap.keyboard.press("Escape");
    await clickAt(30, 260);
    await ap.click('.drw-props [data-a="tbedit"]');
    await ap.waitForSelector("#drw-tb-dlg[open]");
    await ap.fill('#drw-tb-dlg [data-tb-f="name"]', "Smoke block");
    await ap.fill('#drw-tb-dlg [data-c="0.label"]', "Firma");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await ap.setInputFiles('#drw-tb-dlg [data-tb="logo"]', { name: "logo.png", mimeType: "image/png", buffer: png });
    await ap.waitForSelector('#drw-tb-dlg [data-tb-l="w"]');
    const pvImg = await ap.evaluate(() => !!document.querySelector("#drw-tb-dlg .drw-tb-pv image"));
    await ap.click('#drw-tb-dlg button[value="ok"]');
    await ap.waitForFunction(() => !!window.__sv.drw.doc().sheets[0].tb, null, { timeout: 10000 });
    const fmt = await ap.evaluate(() => { const tb = window.__sv.drw.doc().sheets[0].tb; return { name: tb.name, label: tb.cells[0].label, logo: !!tb.logo, img: /<image /.test(window.__sv.drw.svg()), lib: JSON.parse(localStorage.getItem("mc:sheetFormats") ?? "[]").length, opt: [...document.querySelectorAll('.drw-props [data-s="format"] option')].map(o => o.value).filter(v => v.startsWith("user:")).length }; });
    await ap.selectOption('.drw-props [data-s="format"]', "iso");
    const back = await ap.evaluate(() => window.__sv.drw.doc().sheets[0].tb ?? null);
    check(pvImg && fmt.name === "Smoke block" && fmt.label === "Firma" && fmt.logo && fmt.img && fmt.lib === 1 && fmt.opt === 1 && back === null,
      `drawing: a user title block with a logo is saved to the library and used on the sheet; ISO puts the standard one back (${JSON.stringify([pvImg, fmt, back])})`);
    // 1.96.0 broken-out section (FR-DRW-015): outline an area of the projected view, Enter cuts it to the middle and hatches the floor.
    await ap.keyboard.press("Escape");
    const tv = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); const pl = window.__sv.drw.placement(v.id); return { id: v.id, x: v.x, y: v.y, s: pl.s, uc: pl.uc, vc: pl.vc, w: (pl.box[2] - pl.box[0]) / pl.s, h: (pl.box[3] - pl.box[1]) / pl.s }; }, pv0.id);
    const at2 = (u, v) => clickAt(tv.x + (u - tv.uc) * tv.s, tv.y + (v - tv.vc) * tv.s);
    await at2(tv.uc, tv.vc);
    await ap.click('.drw-props [data-a="brokenout"]');
    const bu0 = tv.uc - tv.w * 0.4, bu1 = tv.uc - tv.w * 0.2, bv0 = tv.vc - tv.h * 0.2, bv1 = tv.vc + tv.h * 0.2;
    await at2(bu0, bv0); await at2(bu1, bv0); await at2(bu1, bv1); await at2(bu0, bv1);
    await ap.keyboard.press("Enter");
    await ap.waitForFunction(id => window.__sv.drw.proj(id)?.cut?.length > 0, tv.id, { timeout: 60000 });
    const bo = await ap.evaluate(id => { const v = window.__sv.drw.doc().sheets[0].views.find(x => x.id === id); return { poly: v.broken?.poly.length, d: v.broken?.d, mode: window.__sv.drw.mode(), depth: document.querySelector('.drw-props [data-v="bdepth"]')?.value ?? null }; }, tv.id);
    check(bo.poly === 8 && bo.mode === "none" && bo.depth && +bo.depth > 0, `drawing: broken-out section cuts the outlined area and hatches it (${JSON.stringify([tv, bo])})`);
    await ap.fill('.drw-props [data-v="bdepth"]', "1");
    await ap.keyboard.press("Enter");
    const bo2 = await ap.evaluate(id => window.__sv.drw.doc().sheets[0].views.find(x => x.id === id).broken?.d, tv.id);
    await ap.click('.drw-props [data-a="unbroken"]');
    const bo3 = await ap.evaluate(id => window.__sv.drw.doc().sheets[0].views.find(x => x.id === id).broken ?? null, tv.id);
    check(bo2 != null && Math.abs(bo2 - bo.d) > 0.5 && bo3 === null, `drawing: the broken-out depth can be typed; Remove takes it off (${JSON.stringify([bo.d, bo2, bo3])})`);
    await ctx.close();
  }

  // 1.80.0: vault geometry compare (FR-PDM-050) and check-in with referenced files (FR-PDM-011).
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const vp = await ctx.newPage();
    vp.on("pageerror", e => errors.push(e.message));
    vp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await vp.goto(`${origin}/index.html?debug`);
    await vp.evaluate(() => { localStorage.setItem("sv:tips", "off"); localStorage.setItem("mc:vaultUser", "Andrey"); });
    await vp.goto(`${origin}/index.html?debug`);
    await vp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const plate = depth => ({ schema: 1, kind: "part", id: "plate", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, material: { name: "Steel", density: 7.85 }, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -40, -25), P("p2", 40, -25), P("p3", 40, 25), P("p4", -40, 25),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: depth } }] });
    const pmf = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const pb = depth => [...zip(Object.entries({ "manifest.json": JSON.stringify(pmf), "document.json": JSON.stringify(plate(depth)) }))];
    const asmDoc = { schema: 1, kind: "assembly", id: "a_g", name: "Base", units: { length: "mm", decimals: 2 }, parts: { plate: { name: "Plate", file: "Plate.mcadprt", doc: plate(10) } },
      components: [{ id: "c1", name: "Plate<1>", part: "plate", tf: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], fixed: true }] };
    const amf = { format: "mobiuscad", schema: 1, kind: "assembly", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const ab = [...zip(Object.entries({ "manifest.json": JSON.stringify(amf), "document.json": JSON.stringify(asmDoc) }))];
    await vp.click("#t-vault");
    await vp.waitForSelector("#v-name");
    await vp.fill("#v-name", "Geometry test");
    await vp.click('#vault-panel [data-a="new-ws"]');
    await vp.waitForSelector('#vault-panel [data-a="settings"]');
    // The plate 10 mm thick, then 15 mm: 80 × 50 × 5 mm more material.
    const ids = await vp.evaluate(async ([a, b, asm]) => {
      const p = window.__sv.vault, v = p.vault;
      await p.addFiles([new File([new Uint8Array(asm)], "Base.mcadasm")], true);
      const files = await v.files(), part = files.find(f => f.path === "Plate.mcadprt"), base = files.find(f => f.path === "Base.mcadasm");
      await v.checkOut(part.id);
      await v.saveWorking(part.id, new Uint8Array(b));
      await v.checkIn(part.id, "thicker");
      return { part: part.id, base: base.id };
    }, [pb(10), pb(15), ab]);
    await vp.evaluate(i => window.__sv.vault.compareDlg(i, 1, 2), ids.part);
    await vp.waitForSelector("#vault-dlg .v-geo3d canvas", { timeout: 120000 });
    const geo = await vp.evaluate(() => [...document.querySelectorAll("#vault-dlg table")].at(-1).innerText);
    check(/Material added \(mm³\)\s+20000/.test(geo) && /Material removed \(mm³\)\s+0\.00/.test(geo) && /Mass \(kg\)\s+0\.3140\s+0\.4710\s+\+0\.1570/.test(geo),
      `vault: geometry compare of two part versions: added material, mass change and a 3D view (${geo.replace(/\s+/g, " ").slice(0, 300)})`);
    await vp.keyboard.press("Escape");
    // Check in the assembly with its changed part: the part is listed, ticked, and goes in first.
    await vp.evaluate(async ({ part, base }) => { const v = window.__sv.vault.vault; await v.checkOut(part); await v.checkOut(base); }, ids);
    await vp.evaluate(async ([id, b]) => window.__sv.vault.vault.saveWorking(id, new Uint8Array(b)), [ids.part, pb(20)]);
    await vp.evaluate(i => { void window.__sv.vault.checkIn(i); }, ids.base);
    await vp.waitForSelector("#vault-dlg .v-refs input");
    const box = await vp.evaluate(() => [...document.querySelectorAll("#vault-dlg .v-refs input")].map(x => [x.name, x.checked]));
    await vp.fill("#vault-dlg textarea", "deeper plate");
    await vp.click('#vault-dlg button[value="ok"]');
    await vp.evaluate(async id => { for (let i = 0; i < 200; i++) { if (!(await window.__sv.vault.vault.files()).find(f => f.id === id).checkout) return; await new Promise(r => setTimeout(r, 100)); } }, ids.base);
    const after = await vp.evaluate(async ({ part }) => { const v = window.__sv.vault.vault, f = (await v.files()).find(x => x.id === part); return [v.latest(f).n, !!f.checkout]; }, ids);
    check(JSON.stringify(box) === JSON.stringify([[`ref:${ids.part}`, true]]) && after[0] === 3 && !after[1], `vault: check-in offers the changed part it references, ticked, and checks it in too (${JSON.stringify([box, after])})`);
    await ctx.close();
  }

  // --- View navigation (FRS 13.13: FR-UI-101..104): arrow keys, Z, previous view, zoom to area/selection, Space picker ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const np = await ctx.newPage();
    np.on("pageerror", e => errors.push(e.message));
    await np.goto(`${origin}/index.html?debug&nokernel`);
    await np.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await np.goto(`${origin}/index.html?debug&nokernel`);
    await np.waitForFunction(() => window.__sv);
    await np.setInputFiles("#file-input", join(fixtures, "cube-10x10mm/Cube 10x10.stp"));
    await np.waitForFunction(() => window.__sv.viewer.parts.length > 0);
    const cam = () => np.evaluate(() => { const v = window.__sv.viewer; return { p: v.camera.position.toArray(), t: v.controls.target.toArray(), h: v.viewHeight() }; });
    const settleCam = async () => { await np.waitForTimeout(60); await np.waitForFunction(() => !window.__sv.viewer.animating); };
    const dist = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
    const ang = (a, b) => { const u = a.p.map((x, i) => x - a.t[i]), w = b.p.map((x, i) => x - b.t[i]); const c = u.reduce((s, x, i) => s + x * w[i], 0) / Math.hypot(...u) / Math.hypot(...w); return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI; };
    await np.evaluate(() => document.activeElement?.blur());
    await np.keyboard.press("Control+1"); await settleCam();
    const c0 = await cam();
    await np.keyboard.press("ArrowRight"); await settleCam();
    const c1 = await cam();
    await np.keyboard.press("Shift+ArrowRight"); await settleCam();
    const c2 = await cam();
    check(Math.abs(ang(c0, c1) - 15) < 0.5 && Math.abs(ang(c1, c2) - 90) < 0.5, `navigation: → turns the view 15°, Shift+→ 90° (${ang(c0, c1).toFixed(2)}°, ${ang(c1, c2).toFixed(2)}°)`);
    await np.keyboard.press("z"); await settleCam();
    const c3 = await cam();
    await np.keyboard.press("Shift+Z"); await settleCam();
    const c4 = await cam();
    check(c3.h > c2.h * 1.2 && Math.abs(c4.h / c2.h - 1) < 0.01, `navigation: Z zooms out and Shift+Z back in (${c2.h.toFixed(2)} → ${c3.h.toFixed(2)} → ${c4.h.toFixed(2)})`);
    await np.keyboard.press("Control+ArrowRight"); await settleCam();
    const c5 = await cam();
    const moved = Math.hypot(...c5.t.map((x, i) => x - c4.t[i]));
    check(Math.abs(moved / c4.h - 0.1) < 0.01 && Math.abs(ang(c4, c5)) < 0.1, `navigation: Ctrl+→ pans a tenth of the view without turning it (${(moved / c4.h).toFixed(3)})`);
    // Previous view walks back: pan, zoom in, zoom out, turn 90, turn 15 → the camera before Ctrl+1's result.
    for (let i = 0; i < 5; i++) { await np.keyboard.press("Alt+z"); await settleCam(); }
    const back = await cam();
    check(dist(back, c0) < 1e-6 * Math.max(1, Math.hypot(...c0.p)) + 1e-6, `navigation: Alt+Z steps back through the previous views to where it started (${dist(back, c0).toExponential(2)})`);
    // A command button keeps focus after its click; the arrows still turn the view (exam bug 29).
    await np.focus("#lang-btn");
    const cb0 = await cam();
    await np.keyboard.press("ArrowLeft"); await settleCam();
    const cb1 = await cam();
    check(Math.abs(ang(cb0, cb1) - 15) < 0.5, `navigation: ← turns the view with a header button focused (${ang(cb0, cb1).toFixed(2)}°)`);
    await np.keyboard.press("ArrowRight"); await settleCam();
    await np.evaluate(() => document.activeElement?.blur());
    // An arrow pressed while Ctrl+1 is still turning the camera turns from where Ctrl+1 ends (exam bug 31).
    await np.keyboard.press("Control+1"); await settleCam();
    const cq0 = await cam();
    await np.keyboard.press("Control+5");
    await np.keyboard.press("Control+1");
    await np.keyboard.press("ArrowRight"); await settleCam();
    const cq1 = await cam();
    check(Math.abs(ang(cq0, cq1) - 15) < 0.5, `navigation: an arrow pressed mid-move turns from where the move ends (${ang(cq0, cq1).toFixed(2)}°)`);
    // From Top and Bottom, ↑/↓ tilt the view (they did nothing there), and turning up from Front stops at the pole (exam bug 33).
    const polar = c => { const u = c.p.map((x, i) => x - c.t[i]); return Math.acos(Math.max(-1, Math.min(1, u[2] / Math.hypot(...u)))) * 180 / Math.PI; };
    await np.keyboard.press("Control+5"); await settleCam();
    await np.keyboard.press("ArrowUp"); await settleCam();
    const pt = polar(await cam());
    await np.keyboard.press("Control+6"); await settleCam();
    await np.keyboard.press("ArrowDown"); await settleCam();
    const pb = polar(await cam());
    await np.keyboard.press("Control+1"); await settleCam();
    const ys = [];
    for (let i = 0; i < 8; i++) { await np.keyboard.press("ArrowDown"); await settleCam(); const c = await cam(); ys.push(c.p[1] - c.t[1]); }
    const pf = polar(await cam());
    check(Math.abs(pt - 15) < 0.5 && Math.abs(pb - 165) < 0.5 && pf < 0.5 && ys.every(y => y <= 1e-6),
      `navigation: ↑ from Top and ↓ from Bottom tilt 15°, ↓ from Front stops at the top without going over (${pt.toFixed(2)}°, ${pb.toFixed(2)}°, ${pf.toFixed(2)}°, ${JSON.stringify(ys.map(y => +y.toFixed(1)))})`);
    // Double middle click fits: the same camera as F.
    await np.keyboard.press("f"); await settleCam();
    const cf = await cam();
    await np.keyboard.press("z"); await settleCam();
    const box = await np.evaluate(() => { const r = window.__sv.viewer.renderer.domElement.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const mx = box.x + box.width / 2, my = box.y + box.height / 2;
    await np.mouse.move(mx, my);
    await np.mouse.down({ button: "middle" }); await np.mouse.up({ button: "middle" });
    await np.mouse.down({ button: "middle" }); await np.mouse.up({ button: "middle" });
    await settleCam();
    const cd = await cam();
    check(Math.abs(cd.h / cf.h - 1) < 0.01, `navigation: a double middle click fits like F (${cd.h.toFixed(2)} vs ${cf.h.toFixed(2)})`);
    // Space: the orientation picker at the cursor; its Top gives the same view as Ctrl+5, Esc closes it untouched.
    await np.mouse.move(mx + 50, my + 20);
    await np.keyboard.press("Space");
    const pick = await np.evaluate(() => { const el = document.querySelector(".nav-pick"); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, n: el.querySelectorAll("button").length }; });
    await np.click('.nav-pick [data-nv="top"]'); await settleCam();
    const ct = await cam();
    await np.keyboard.press("Control+5"); await settleCam();
    const c5b = await cam();
    await np.keyboard.press("Space");
    const before = await cam();
    await np.keyboard.press("Escape");
    const after = await cam();
    const open = await np.evaluate(() => !!document.querySelector(".nav-pick"));
    check(!!pick && pick.n >= 12 && Math.abs(pick.cx - (mx + 50)) < 2 && ang(ct, c5b) < 0.01 && dist(before, after) < 1e-9 && !open,
      `navigation: Space opens the orientation picker at the cursor (${pick?.n} buttons), Top = Ctrl+5, Esc closes it without moving the view`);
    // Zoom to area: a box over a quarter of the view makes the view half as tall.
    const h0 = (await cam()).h;
    await np.keyboard.press("Space");
    await np.click('.nav-pick [data-nv="area"]');
    await np.mouse.move(mx - box.width / 8, my - box.height / 8);
    await np.mouse.down();
    await np.mouse.move(mx + box.width / 8, my + box.height / 8, { steps: 4 });
    await np.mouse.up();
    await settleCam();
    const ca = await cam();
    check(Math.abs(ca.h / h0 - 0.25) < 0.01 && (await np.evaluate(() => !document.querySelector(".nav-area") && window.__sv.viewer.controls.enabled)), `navigation: Zoom to area frames the box (${(ca.h / h0).toFixed(3)} of the height)`);
    // Zoom to selection on one face of the 10 mm cube: the face fills the view.
    await np.evaluate(() => { const v = window.__sv.viewer, p = v.parts[0]; const f = p.data.faces[0]; window.__sv.state.selection = { kind: "face", point: new (v.camera.position.constructor)(...f.centroid), part: p, face: f }; });
    await np.keyboard.press("Space");
    await np.click('.nav-pick [data-nv="sel"]'); await settleCam();
    const cs = await cam();
    check(cs.h > 8 && cs.h < 25, `navigation: Zoom to selection frames the picked 10 mm face (view height ${cs.h.toFixed(2)} mm)`);
    // Russian: the picker's labels are translated.
    await np.click("#lang-btn");
    await np.evaluate(() => document.activeElement?.blur());
    await np.mouse.move(mx, my);
    await np.keyboard.press("Space");
    const ru = await np.evaluate(() => document.querySelector(".nav-pick")?.textContent ?? "");
    await np.keyboard.press("Escape");
    await np.click("#lang-btn");
    check(ru.includes("Сверху") && ru.includes("Предыдущий вид") && !/[A-Za-z]{3}/.test(ru), `navigation: the orientation picker is translated in Russian (${ru.slice(0, 60)})`);
    await ctx.close();
  }

  // --- Commands (FRS 13.13: FR-UND-005, FR-UI-106/107/111): named undo and its list, Enter repeats, right-click OK/Cancel, pushpin ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cp = await ctx.newPage();
    cp.on("pageerror", e => errors.push(e.message));
    await cp.goto(`${origin}/index.html?debug`);
    await cp.evaluate(() => localStorage.setItem("sv:tips", "off"));
    await cp.goto(`${origin}/index.html?debug`);
    await cp.waitForFunction(() => window.__sv);
    await cp.click("#new-part");
    await cp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.store.doc.features.length);
    const settle = async () => { await cp.waitForTimeout(150); await cp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 }); };
    const rect = (id, x0, y0, x1, y1) => cp.evaluate(([id, x0, y0, x1, y1]) => window.__sv.model.store.change("Sketch", d => {
      const P = (k, x, y) => ({ id: `${id}p${k}`, t: "point", x, y });
      d.features.push({ id, type: "sketch", name: id === "s1" ? "Sketch1" : "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [P(1, x0, y0), P(2, x1, y0), P(3, x1, y1), P(4, x0, y1), { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` }, { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }] });
    }), [id, x0, y0, x1, y1]);
    const mode = () => cp.evaluate(() => { const m = window.__sv.model.mode(); return m.kind === "feature" ? `feature:${m.draft.type}` : m.kind; });
    const nf = () => cp.evaluate(() => window.__sv.model.store.doc.features.length);
    await rect("s1", -20, -10, 20, 10);
    await settle();
    await cp.click('[data-c="extrude"]');
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "feature");
    await cp.click("#mc-ok");
    await settle();
    const tip = await cp.getAttribute('#mc-quick [data-c="undo"]', "title");
    check((await nf()) === 2 && /Extrude1/.test(tip), `commands: the Undo button names the step it undoes (${tip})`);
    // Enter with no command running repeats the last one.
    await cp.evaluate(() => document.activeElement?.blur());
    await cp.keyboard.press("Enter");
    await cp.waitForTimeout(200);
    const rep = await mode();
    // Right-click without a drag while the command runs: OK and Cancel first.
    const vb = await cp.evaluate(() => { const r = window.__sv.viewer.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + r.height * 0.8 }; });
    await cp.mouse.click(vb.x, vb.y, { button: "right" });
    await cp.waitForTimeout(100);
    const menu = await cp.evaluate(() => [...document.querySelectorAll("#mc-menu:not([hidden]) button")].map(b => b.textContent.trim()));
    await cp.locator("#mc-menu button", { hasText: "Cancel" }).click();
    await cp.waitForTimeout(150);
    const afterCancel = await mode();
    check(rep === "feature:extrude" && menu[0]?.includes("OK") && menu[1]?.includes("Cancel") && afterCancel === "none" && (await nf()) === 2,
      `commands: Enter repeats Extrude, a right-click offers OK / Cancel and Cancel closes it (${rep}, [${menu.join(", ")}], ${afterCancel})`);
    // Undo ▾ lists the steps newest first; picking the second undoes both.
    await cp.click('#mc-quick [data-fly="undo"]');
    const list = await cp.evaluate(() => [...document.querySelectorAll("#mc-menu:not([hidden]) button")].map(b => b.textContent.trim()));
    await cp.locator("#mc-menu button").nth(1).click();
    await settle();
    const undone = await nf();
    await cp.keyboard.press("Control+y"); await cp.keyboard.press("Control+y");
    await settle();
    check(list.length === 2 && /Extrude1/.test(list[0]) && undone === 0 && (await nf()) === 2, `commands: the Undo list names the steps and undoes back to the one picked ([${list.join(", ")}] → ${undone} features)`);
    // Pushpin: OK makes the feature and opens the same command again.
    await rect("s2", 30, -10, 50, 10);
    await settle();
    await cp.click('[data-c="extrude"]');
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "feature");
    await cp.click('#mc-pm [data-k="pin"]');
    await cp.click("#mc-ok");
    await settle();
    await cp.waitForTimeout(300);
    const pinned = { n: await nf(), mode: await mode(), store: await cp.evaluate(() => localStorage.getItem("mc:pin")), on: await cp.evaluate(() => document.querySelector('#mc-pm [data-k="pin"]')?.getAttribute("aria-pressed")) };
    await cp.click('#mc-pm [data-k="pin"]');
    await cp.keyboard.press("Escape");
    check(pinned.n === 4 && pinned.mode === "feature:extrude" && pinned.store === "1" && pinned.on === "true", `commands: with the pushpin on, OK keeps the Extrude panel open for the next one (${JSON.stringify(pinned)})`);
    // Remembered options (FR-UI-043): an extrude made Mid plane makes the next one start as Mid plane.
    await rect("s3", -20, 30, 20, 50);
    await settle();
    await cp.click('[data-c="extrude"]');
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "feature");
    await cp.selectOption('#mc-pm select[data-k="end"]', "mid");
    await cp.waitForTimeout(150);
    await cp.click("#mc-ok");
    await settle();
    await cp.click('[data-c="extrude"]');
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "feature");
    const endNext = await cp.evaluate(() => window.__sv.model.mode().draft.end);
    await cp.keyboard.press("Escape");
    await cp.waitForTimeout(150);
    check(endNext === "mid", `commands: a new extrude starts with the end condition used last (${endNext})`);
    // What's wrong: a fillet far too big fails; the list names it and a click selects it in the tree.
    await cp.evaluate(() => window.__sv.model.store.change("Add Fillet1", d => { const ex = d.features.find(f => f.type === "extrude"); d.features.push({ id: "fbad", type: "fillet", name: "Fillet1", radius: { v: 500 }, edges: [{ faces: [`${ex.id}:end`, `${ex.id}:side:s1l1`], hint: [0, -10, 10] }] }); }));
    await settle();
    const wrongHead = await cp.evaluate(() => { const el = document.querySelector("#mc-errors"); return el.hidden ? "" : el.textContent; });
    await cp.click("#mc-errors .mc-wrong-h");
    const rows = await cp.evaluate(() => [...document.querySelectorAll("#mc-errors [data-wid]")].map(b => b.dataset.wid));
    if (rows.length) await cp.click(`#mc-errors [data-wid="${rows[0]}"]`);
    const sel = await cp.evaluate(() => document.querySelector("#mc-tree .ft-row.sel")?.dataset.id);
    check(/What's wrong/.test(wrongHead) && rows.includes("fbad") && sel === rows[0], `commands: What's wrong lists the failing fillet and selects it (${wrongHead}; ${rows.join(",")}; ${sel})`);
    await cp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    // Command search (Ctrl+K): typing "fill" finds Fillet; Enter runs it.
    await cp.evaluate(() => document.activeElement?.blur());
    await cp.keyboard.press("Control+k");
    await cp.waitForSelector("#mc-cmdk input");
    await cp.keyboard.type("fill");
    const found = await cp.evaluate(() => [...document.querySelectorAll("#mc-cmdk [data-id]")].map(li => li.dataset.id));
    await cp.keyboard.press("Enter");
    await cp.waitForTimeout(200);
    const ran = await mode();
    await cp.keyboard.press("Escape");
    await cp.waitForTimeout(150);
    check(found[0] === "fillet" && ran === "feature:fillet" && !(await cp.evaluate(() => !!document.querySelector("#mc-cmdk"))), `commands: Ctrl+K finds and runs Fillet ([${found.join(", ")}], ${ran})`);
    // Check sketch for feature (FR-SK-073): an open L lists both open ends for Extrude, Show selects the point, and it is a good rib.
    await cp.evaluate(() => window.__sv.model.store.change("Sketch", d => {
      const P = (k, x, y) => ({ id: `s9p${k}`, t: "point", x, y });
      d.features.push({ id: "s9", type: "sketch", name: "Sketch9", plane: { std: "XY" }, rels: [], dims: [], ents: [P(1, 0, 0), P(2, 30, 0), P(3, 30, 15), { id: "s9l1", t: "line", a: "s9p1", b: "s9p2" }, { id: "s9l2", t: "line", a: "s9p2", b: "s9p3" }] });
    }));
    await settle();
    await cp.evaluate(() => window.__sv.modeller.editFeature("s9"));
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "sketch");
    await cp.click("#mc-pm [data-a=check]");
    const chk = await cp.evaluate(() => ({ head: document.querySelector("#mc-pm .pm-check-r")?.textContent ?? "", n: document.querySelectorAll("#mc-pm .pm-check-l li").length }));
    await cp.click("#mc-pm .pm-check-l [data-chk]");
    const chkSel = await cp.evaluate(() => [...window.__sv.model.mode().editor.selection].sort().join(","));
    await cp.selectOption("#mc-pm [data-a=chkuse]", "open");
    await cp.click("#mc-pm [data-a=check]");
    const ribOk = await cp.evaluate(() => document.querySelector("#mc-pm .pm-check-r.ok")?.textContent ?? "");
    check(chk.n === 2 && /2 problems/.test(chk.head) && /s9p1|s9p3/.test(chkSel) && /open chain of 2/.test(ribOk), `commands: Check sketch for feature lists both open ends, Show selects one, and the L is a good rib (${chk.head}; ${chkSel}; ${ribOk})`);
    await cp.evaluate(() => window.__sv.modeller.cancel());
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await cp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    // Typed sizes while drawing (FR-UI-052): a digit after the first click opens the size box; Enter steps to the next size.
    await cp.evaluate(() => window.__sv.model.store.change("Sketch", d => { d.features.push({ id: "s8", type: "sketch", name: "Sketch8", plane: { std: "XY" }, rels: [], dims: [], ents: [] }); }));
    await settle();
    await cp.evaluate(() => window.__sv.modeller.editFeature("s8"));
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "sketch");
    await cp.waitForTimeout(500);
    await cp.evaluate(() => document.activeElement?.blur());
    await cp.keyboard.press("l");
    await cp.mouse.move(560, 520); await cp.mouse.click(560, 520);
    await cp.mouse.move(700, 470, { steps: 4 });
    await cp.keyboard.type("25");
    const typedLab = await cp.evaluate(() => document.querySelector(".sk-typed")?.textContent ?? "");
    await cp.keyboard.press("Enter");
    await cp.keyboard.type("0");
    await cp.keyboard.press("Enter");
    await cp.keyboard.press("Escape");
    await cp.keyboard.press("r");
    await cp.mouse.click(560, 380);
    await cp.mouse.move(640, 300, { steps: 4 });
    await cp.keyboard.type("40");
    await cp.keyboard.press("Enter");
    await cp.keyboard.type("20");
    await cp.keyboard.press("Enter");
    await cp.waitForTimeout(150);
    const typed = await cp.evaluate(() => {
      const sk = window.__sv.model.editor().sk;
      const P = id => sk.ents.find(e => e.id === id);
      const len = l => Math.hypot(P(l.b).x - P(l.a).x, P(l.b).y - P(l.a).y);
      const lines = sk.ents.filter(e => e.t === "line");
      return { lens: lines.map(l => +len(l).toFixed(3)), dims: sk.dims.map(d => +d.val.v.toFixed(3)).sort((a, b) => a - b), horiz: sk.rels.filter(r => r.t === "horizontal").length };
    });
    check(/Length/.test(typedLab) && typed.lens[0] === 25 && typed.lens.length === 5 && typed.lens.slice(1).sort().join() === "20,20,40,40" && typed.dims.join() === "20,25,40" && typed.horiz >= 3,
      `commands: sizes typed while drawing place a 25 mm horizontal line and a 40 × 20 rectangle with dimensions (${typedLab}; ${JSON.stringify(typed)})`);
    // Leaving the changed sketch asks first; don't await cancel() (it waits for the answer), answer Discard.
    await cp.evaluate(() => { void window.__sv.modeller.cancel(); });
    await cp.click("#confirm[open] [data-a=ok]");
    await cp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    await cp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    // Russian: the named Undo tooltip and the pushpin are translated.
    await cp.click("#lang-btn");
    const ru = await cp.getAttribute('#mc-quick [data-c="undo"]', "title");
    await cp.click("#lang-btn");
    check(/^Отменить: /.test(ru) && !/Add|Extrude/.test(ru), `commands: the Undo tooltip is translated (${ru})`);
    await ctx.close();
  }

  // --- Weldments (FR-FT-121): structural members on a sketch, cut list, end cap, Russian panel ---
  if (inShard(2)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await settle();
    // A 600 × 400 frame sketched on XY, then Structural Member from the Weldments flyout.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("Frame", d => { d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", 0, 0), P("b", 600, 0), P("c", 600, 400), P("d", 0, 400), L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a")] }); }); });
    await settle();
    await runCmd(mp, "Structural Member");
    await settle();
    const p0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, segs: window.__sv.model.mode().draft?.segs?.length, bodies: window.__sv.model.last().bodies?.length, boxes: document.querySelectorAll("#mc-pm input[data-wseg]").length }));
    // Live preview follows the panel: a bigger tube, then untick one line.
    await mp.selectOption('#mc-pm select[data-k="wsize"]', "50x50x4");
    await settle();
    await mp.click('#mc-pm input[data-wseg="l4"]');
    await settle();
    const p1 = await mp.evaluate(() => ({ bodies: window.__sv.model.last().bodies?.length, size: window.__sv.model.mode().draft.size }));
    // Clicking the line in the view ticks it again (SolidWorks picks path segments in the graphics area).
    const l4At = await mp.evaluate(() => { const v = window.__sv.viewer; v.controls.target.set(300, 200, 0); v.camera.up.set(0, 1, 0); v.camera.position.set(300, 200, 1600); v.camera.lookAt(300, 200, 0); v.controls.update(); v.fit(false); v.camera.updateMatrixWorld(); const r = v.renderer.domElement.getBoundingClientRect(), q = new v.camera.position.constructor(0, 200, 0).project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; });
    await mp.mouse.click(l4At[0] + 2, l4At[1] + 1);
    await settle();
    const p1b = await mp.evaluate(() => ({ segs: window.__sv.model.mode().draft.segs.map(s => s.ent).join(","), box: document.querySelector('#mc-pm input[data-wseg="l4"]')?.checked }));
    check(p1b.segs === "l1,l2,l3,l4" && p1b.box === true, `weldments: clicking a path line in the view ticks it (${JSON.stringify({ l4At, p1b })})`);
    if (p1b.segs !== "l1,l2,l3,l4") { await mp.click('#mc-pm input[data-wseg="l4"]'); }
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const r = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bodies: l.bodies?.length, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), cut: (l.cutList ?? []).map(c => [c.desc, c.qty, c.length, c.angle1, c.angle2]) }; });
    check(p0.title === "Structural Member" && p0.segs === 4 && p0.boxes === 4 && p0.bodies === 4 && p1.bodies === 3 && p1.size === "50x50x4" && !r.bad && r.bodies === 4
      && JSON.stringify(r.cut) === JSON.stringify([["SHS 50x50x4", 2, 650, 45, 45], ["SHS 50x50x4", 2, 450, 45, 45]]),
      `weldments: Structural Member along a sketch, mitred corners, live preview, cut list (FR-FT-121) (${JSON.stringify({ p0, p1, r })})`);
    // Cut List… opens a table: two member rows and the total mass (steel assumed).
    await runCmd(mp, "Cut List");
    await mp.waitForSelector("#wld-cut[open]");
    const cl = await mp.evaluate(() => ({ rows: document.querySelectorAll("#wld-cut tbody tr").length, total: document.querySelector("#wld-cut [data-wtotal]")?.textContent }));
    // Item properties typed in the dialog are kept with the part and rename the item in the tree and the CSV.
    await mp.fill('#wld-cut input[data-cp="desc"][data-ci="0"]', "Top rail");
    await mp.press('#wld-cut input[data-cp="desc"][data-ci="0"]', "Tab");
    await mp.fill('#wld-cut input[data-cp="part"][data-ci="0"]', "FR-001");
    await mp.press('#wld-cut input[data-cp="part"][data-ci="0"]', "Tab");
    await settle();
    await mp.click('#wld-cut [data-a="close"]');
    check(cl.rows === 2 && /Total mass [\d.,]+ kg/.test(cl.total ?? ""), `weldments: cut list dialog (${JSON.stringify(cl)})`);
    await settle();
    const cp = await mp.evaluate(() => ({ props: Object.values(window.__sv.model.store.doc.cutProps ?? {}), row: document.querySelector('#mc-tree .ft-row[data-id="cut:0"]')?.textContent ?? "" }));
    check(JSON.stringify(cp.props) === '[{"desc":"Top rail","part":"FR-001"}]' && cp.row.includes("Top rail"), `weldments: cut list item properties (${JSON.stringify(cp)})`);
    // The Cut list folder in the tree: one row per item; clicking one lights up its two bodies.
    await mp.click('#mc-tree .ft-row[data-id="cut:0"]');
    await mp.waitForTimeout(100);
    const ct = await mp.evaluate(() => {
      const hl = window.__sv.modeller.decor.children.filter(o => o.isMesh && o.material?.opacity === 0.45);
      return { folder: document.querySelector('#mc-tree .ft-row[data-id="folder:cutlist"]')?.textContent, rows: [...document.querySelectorAll('#mc-tree .ft-row[data-id^="cut:"] .ft-name')].map(e => e.textContent), tris: hl.reduce((n, o) => n + o.geometry.getAttribute("position").count / 3, 0), faces: window.__sv.model.last().bodies.map(b => b.faces) };
    });
    check(/Cut list \(2\)/.test(ct.folder ?? "") && JSON.stringify(ct.rows) === '["Top rail × 650 mm (2)","SHS 50x50x4 × 450 mm (2)"]' && ct.tris > 0 && ct.faces.every(n => n > 0), `weldments: Cut list folder in the tree highlights an item's bodies (${JSON.stringify(ct)})`);
    // End cap on an open end: an L of two members butted, a cap on the free end.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b }); window.__sv.model.store.change("L", d => { d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [P("e", 0, 600), P("f", 300, 600), P("g", 300, 800), L("k1", "e", "f"), L("k2", "f", "g")] }, { id: "m2", type: "member", name: "Structural Member2", profile: "shs", size: "40x40x3", segs: [{ sketch: "s2", ent: "k1" }, { sketch: "s2", ent: "k2" }], corner: "butt1" }); }); });
    await settle();
    await runCmd(mp, "End Cap");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.faces = [{ name: "m2:k1:start" }]; window.__sv.modeller.draftChanged(); });
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const cap = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bodies: l.bodies?.length, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), plate: (l.cutList ?? []).find(c => c.kind === "plate")?.plate }; });
    check(cap.bodies === 7 && !cap.bad && JSON.stringify(cap.plate) === "[40,40,5]", `weldments: End Cap on a member's open end (${JSON.stringify(cap)})`);
    // Corner treatment: Fillet swaps the Distance field for Radius and stores `fillet`.
    const capId = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), capId);
    await settle();
    await mp.click('#mc-pm input[data-k="wChamfer"]');
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wCapCorner"]', "fillet");
    await settle();
    const capR = await mp.evaluate(() => ({ label: document.querySelector('#mc-pm [data-num="chamfer"]')?.closest("label")?.textContent?.trim(), fillet: window.__sv.model.mode().draft?.fillet }));
    await mp.click("#mc-cancel");
    await settle();
    check(/^Radius/.test(capR.label ?? "") && capR.fillet === true, `weldments: end cap corner fillet (${JSON.stringify(capR)})`);
    // Thickness direction Inward keeps the overall length: the member is cut back by the plate's 5 mm.
    const memLen = () => mp.evaluate(() => (window.__sv.model.last().cutList ?? []).filter(c => c.kind === "member").reduce((a, c) => a + c.length * c.qty, 0));
    const len0 = await memLen();
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), capId);
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wCapDir"]', "in");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const capIn = await mp.evaluate(() => { const l = window.__sv.model.last(), f = window.__sv.model.store.doc.features.at(-1); return { dir: f.dir, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), plate: (l.cutList ?? []).find(c => c.kind === "plate")?.plate }; });
    const len1 = await memLen();
    check(capIn.dir === "in" && !capIn.bad && JSON.stringify(capIn.plate) === "[40,40,5]" && Math.abs(len0 - len1 - 5) < 0.05, `weldments: inward end cap keeps the overall length (${JSON.stringify({ ...capIn, len0, len1 })})`);
    await mp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    // The wider library: an unequal angle, an HEB beam and a square bar build and name their cut list items.
    const lib = [];
    for (const [type, size, name] of [["uangle", "75x50x6", "L 75x50x6"], ["heb", "120", "HEB 120"], ["sqbar", "30", "SQ 30"]]) {
      await mp.evaluate(([type, size]) => window.__sv.model.store.change("Profile", d => { const m = d.features.find(f => f.type === "member"); m.profile = type; m.size = size; }), [type, size]);
      await settle();
      lib.push(await mp.evaluate(name => { const l = window.__sv.model.last(); return { name, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), found: (l.cutList ?? []).some(c => c.kind === "member" && c.desc === name) }; }, name));
      await mp.evaluate(() => window.__sv.model.store.undo());
      await settle();
    }
    check(lib.every(x => x.found && !x.bad), `weldments: unequal angle, HEB and square bar profiles (${JSON.stringify(lib)})`);
    // The end cap's thickness arrow: dragging it outwards thickens the plate.
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), capId);
    await settle();
    // Look at the cap from close by, so the arrow is on screen.
    await mp.evaluate(() => { const v = window.__sv.viewer, a = window.__sv.modeller.arrow; if (!a) return; v.controls.target.copy(a.base); v.camera.position.copy(a.base).add(a.base.clone().set(-1, -1, 0.8).multiplyScalar(250)); v.camera.lookAt(a.base); v.controls.update(); });
    await mp.waitForTimeout(300);
    const ends = await mp.evaluate(() => {
      const a = window.__sv.modeller.arrow, v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect();
      if (!a) return null;
      const scr = p => { const q = p.clone().project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; };
      const grip = a.obj.position.clone().addScaledVector(a.dir, a.scale * 0.8);
      return { from: scr(grip), to: scr(grip.clone().addScaledVector(a.dir, 10)), label: document.querySelector("#mc-layer .mc-handle")?.textContent };
    });
    if (ends) {
      await mp.mouse.move(ends.from[0], ends.from[1]);
      await mp.mouse.down();
      for (let i = 1; i <= 6; i++) { await mp.mouse.move(ends.from[0] + ((ends.to[0] - ends.from[0]) * i) / 6, ends.from[1] + ((ends.to[1] - ends.from[1]) * i) / 6); await mp.waitForTimeout(40); }
      await mp.mouse.up();
      await settle();
    }
    const thick = await mp.evaluate(() => window.__sv.model.mode().draft?.thickness?.v);
    await mp.click("#mc-ok");
    await settle();
    const plate2 = await mp.evaluate(() => (window.__sv.model.last().cutList ?? []).find(c => c.kind === "plate")?.plate);
    check(ends && /^5 mm$/.test(ends.label ?? "") && thick > 10 && thick < 20 && plate2?.[2] === thick, `weldments: dragging the end cap arrow sets its thickness (${JSON.stringify({ ends, thick, plate2 })})`);
    // A custom profile from a closed sketch, and three members meeting at a corner.
    await mp.evaluate(() => {
      const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b });
      window.__sv.model.store.change("Custom", d => {
        d.features.push({ id: "pr", type: "sketch", name: "Profile", plane: { std: "XY" }, rels: [], dims: [], ents: [P("q1", 0, 0), P("q2", 30, 0), P("q3", 30, 10), P("q4", 0, 10), L("r1", "q1", "q2"), L("r2", "q2", "q3"), L("r3", "q3", "q4"), L("r4", "q4", "q1")] },
          { id: "k3", type: "sketch3d", name: "3DSketch1", rels: [], dims: [], pts: [{ id: "A", p: [1000, 0, 0], fixed: true }, { id: "X", p: [1300, 0, 0] }, { id: "Y", p: [1000, 300, 0] }, { id: "Z", p: [1000, 0, 300] }], segs: [{ id: "x", t: "line", pts: ["A", "X"] }, { id: "y", t: "line", pts: ["A", "Y"] }, { id: "z", t: "line", pts: ["A", "Z"] }] },
          { id: "m3", type: "member", name: "Structural Member3", profile: "sketch", size: "", psketch: "pr", segs: [{ sketch: "s2", ent: "k1" }], corner: "none" },
          { id: "m4", type: "member", name: "Structural Member4", profile: "shs", size: "40x40x3", segs: ["x", "y", "z"].map(ent => ({ sketch: "k3", ent })), corner: "butt1" });
      });
    });
    await settle();
    const cu = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), prof: (l.cutList ?? []).filter(c => c.desc === "Profile").map(c => [c.qty, c.length]), corner: (l.cutList ?? []).filter(c => c.desc === "SHS 40x40x3" && (c.length === 320 || c.length === 280) && c.angle1 === 0).map(c => [c.qty, c.length]) }; });
    check(!cu.bad && JSON.stringify(cu.prof) === "[[1,300]]" && JSON.stringify(cu.corner) === "[[2,320],[2,280]]", `weldments: custom sketch profile and a three-member corner (${JSON.stringify(cu)})`);
    // Corners group: one corner of the frame butted, a weld gap at all of them.
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "member").id));
    await settle();
    const nCorners = await mp.evaluate(() => document.querySelectorAll('#mc-pm select[data-k^="wcorner:"]').length);
    await mp.selectOption('#mc-pm select[data-k^="wcorner:"] >> nth=0', "butt1");
    await settle();
    await mp.click('#mc-pm input[data-k="wGap"]');
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const co = await mp.evaluate(() => { const l = window.__sv.model.last(), f = window.__sv.model.store.doc.features.find(x => x.type === "member"); return { corners: f.corners, gap: f.gap?.v, rows: (l.cutList ?? []).filter(c => c.desc === "SHS 50x50x4").map(c => [c.qty, c.length, c.angle1, c.angle2]) }; });
    check(nCorners === 4 && Object.keys(co.corners ?? {}).length === 1 && co.gap === 2 && JSON.stringify(co.rows) === "[[1,648.6,0,45],[1,647.2,45,45],[1,447.2,45,45],[1,396.6,0,45]]", `weldments: per-corner treatment and weld gap (${JSON.stringify({ nCorners, co })})`);
    // A post on a plate: a gusset with two leg arrows, and a bead all round the tube from one picked side (tangent propagation).
    await mp.evaluate(() => {
      const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b });
      window.__sv.model.store.change("Post", d => {
        d.features.push({ id: "ps", type: "sketch", name: "Plate", plane: { std: "XY" }, rels: [], dims: [], ents: [P("u1", 1900, -100), P("u2", 2100, -100), P("u3", 2100, 100), P("u4", 1900, 100), L("v1", "u1", "u2"), L("v2", "u2", "u3"), L("v3", "u3", "u4"), L("v4", "u4", "u1")] },
          { id: "pe", type: "extrude", name: "Plate body", sketch: "ps", op: "boss", end: "blind", depth: { v: 10 }, merge: false },
          { id: "k5", type: "sketch3d", name: "3DSketch2", rels: [], dims: [], pts: [{ id: "A", p: [2000, 0, 10], fixed: true }, { id: "B", p: [2000, 0, 300] }], segs: [{ id: "post", t: "line", pts: ["A", "B"] }] },
          { id: "m5", type: "member", name: "Structural Member5", profile: "shs", size: "40x40x3", segs: [{ sketch: "k5", ent: "post" }], corner: "none" },
          { id: "g5", type: "gusset", name: "Gusset1", face1: { name: "pe:end", hint: [2050, 50, 10] }, face2: { name: "m5:post:side:5", hint: [2020, 0, 150] }, d1: { v: 50 }, d2: { v: 70 }, thickness: { v: 5 }, shape: "tri", loc: "mid" },
          { id: "w5", type: "weldbead", name: "Fillet Bead1", faces1: [{ name: "pe:end", hint: [2050, 50, 10] }], faces2: [{ name: "m5:post:side:5", hint: [2020, 0, 150] }], size: { v: 4 } });
      });
    });
    await settle();
    const pb = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), beads: (l.cutList ?? []).filter(c => c.kind === "bead").map(c => [c.qty, c.length]) }; });
    check(!pb.bad && pb.beads.length === 1 && pb.beads[0][0] === 1 && Math.abs(pb.beads[0][1] - (4 * 28 + 12 * Math.PI)) < 0.2, `weldments: a bead all round a square tube from one picked side (${JSON.stringify(pb)})`);
    // Intermittent bead from the panel: the defaults (50 every 100) round the 149.7 mm loop give welds at 0 and 100.
    await mp.evaluate(() => window.__sv.modeller.editFeature("w5"));
    await settle();
    await mp.click('#mc-pm input[data-k="wInter"]');
    await settle();
    const ifs = await mp.evaluate(() => [...document.querySelectorAll('#mc-pm [data-num="inter.len"], #mc-pm [data-num="inter.pitch"], #mc-pm input[data-k="wStagger"]')].length);
    await mp.click("#mc-ok");
    await settle();
    const ib = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), beads: (l.cutList ?? []).filter(c => c.kind === "bead").map(c => [c.length, c.inter]) }; });
    check(ifs === 3 && !ib.bad && ib.beads.length === 1 && Math.abs(ib.beads[0][0] - (50 + 4 * 28 + 12 * Math.PI - 100)) < 0.2 && JSON.stringify(ib.beads[0][1]) === "[50,100]", `weldments: intermittent fillet bead (${JSON.stringify({ ifs, ib })})`);
    // Its weld symbol sits on the bead in the view; a click opens the bead for editing.
    const sym = await mp.evaluate(() => { const el = document.querySelector('#mc-layer .wld-sym[data-weld="w5"]'); const t = el?.textContent; el?.click(); return { t, mode: window.__sv.model.mode().kind, id: window.__sv.model.mode().draft?.id }; });
    await settle();
    // All around and field flags show on the symbol while editing.
    await mp.click('#mc-pm input[data-k="wAround"]');
    await settle();
    await mp.click('#mc-pm input[data-k="wField"]');
    await settle();
    const symFlags = await mp.evaluate(() => document.querySelector('#mc-layer .wld-sym[data-weld="w5"]')?.textContent);
    await mp.click("#mc-cancel");
    await settle();
    check(sym.t === "◺ z4 50 (100)" && sym.mode === "feature" && sym.id === "w5", `weldments: weld symbol on the bead (${JSON.stringify(sym)})`);
    check(symFlags === "○ ⚑ ◺ z4 50 (100)", `weldments: all-around and field weld flags on the symbol (${symFlags})`);
    await mp.evaluate(() => window.__sv.modeller.editFeature("g5"));
    await settle();
    await mp.evaluate(() => { const v = window.__sv.viewer, a = window.__sv.modeller.arrows?.[0]; if (!a) return; v.controls.target.copy(a.base); v.camera.position.copy(a.base).add(a.base.clone().set(1, -1, 0.6).multiplyScalar(300)); v.camera.lookAt(a.base); v.controls.update(); });
    await mp.waitForTimeout(300);
    const gs = await mp.evaluate(() => {
      const as = window.__sv.modeller.arrows ?? [], v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect();
      const scr = p => { const q = p.clone().project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; };
      const a = as[0];
      if (!a) return { n: 0 };
      const grip = a.obj.position.clone().addScaledVector(a.dir, a.scale * 0.8);
      return { n: as.length, keys: as.map(x => x.key), key: a.key, from: scr(grip), to: scr(grip.clone().addScaledVector(a.dir, 20)), labels: [...document.querySelectorAll("#mc-layer .mc-handle:not(.wld-sym)")].map(e => e.textContent) };
    });
    if (gs.from) {
      await mp.mouse.move(gs.from[0], gs.from[1]);
      await mp.mouse.down();
      for (let i = 1; i <= 6; i++) { await mp.mouse.move(gs.from[0] + ((gs.to[0] - gs.from[0]) * i) / 6, gs.from[1] + ((gs.to[1] - gs.from[1]) * i) / 6); await mp.waitForTimeout(40); }
      await mp.mouse.up();
      await settle();
    }
    const gd = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { d1: d?.d1?.v, d2: d?.d2?.v }; });
    await mp.click("#mc-ok");
    await settle();
    const moved = gs.key === "d1" ? gd.d1 : gd.d2, kept = gs.key === "d1" ? gd.d2 : gd.d1, was = gs.key === "d1" ? 50 : 70;
    check(gs.n === 2 && JSON.stringify(gs.keys) === '["d1","d2"]' && JSON.stringify(gs.labels) === '["50 mm","70 mm"]' && moved > was + 5 && moved < was + 40 && kept === 120 - was, `weldments: gusset leg arrows (${JSON.stringify({ gs, gd })})`);
    // Gusset location: at the start, centred on it and moved in by an offset.
    await mp.evaluate(() => window.__sv.modeller.editFeature("g5"));
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wloc"]', "start");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wgside"]', "both");
    await settle();
    await mp.click('#mc-pm input[data-k="wgOffset"]');
    await settle();
    const gLoc = await mp.evaluate(() => { const d = window.__sv.model.mode().draft; return { loc: d?.loc, side: d?.side, off: d?.offset?.v, field: !!document.querySelector('#mc-pm [data-num="offset"]') }; });
    await mp.click("#mc-ok");
    await settle();
    const glBad = await mp.evaluate(() => window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";"));
    check(gLoc.loc === "start" && gLoc.side === "both" && gLoc.off === 10 && gLoc.field && !glBad, `weldments: gusset location offset and thickness side (${JSON.stringify({ gLoc, glBad })})`);
    await mp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    // A curved member: a line, a tangent quarter arc and a line; the arc is listed as such and revolved, its cut length is the arc length.
    await mp.evaluate(() => { const P = (id, x, y) => ({ id, t: "point", x, y }); window.__sv.model.store.change("Bend", d => { d.features.push({ id: "sa", type: "sketch", name: "Bend", plane: { std: "XY" }, rels: [], dims: [], ents: [P("b0", 3000, 0), P("b1", 3300, 0), P("bc", 3300, 100), P("b2", 3400, 100), P("b3", 3400, 400), { id: "j1", t: "line", a: "b0", b: "b1" }, { id: "j2", t: "arc", c: "bc", a: "b1", b: "b2" }, { id: "j3", t: "line", a: "b2", b: "b3" }] }); }); });
    await settle();
    await runCmd(mp, "Structural Member");
    await settle();
    const bl = await mp.evaluate(() => ({ segs: window.__sv.model.mode().draft?.segs?.map(s => s.ent), labels: [...document.querySelectorAll("#mc-pm input[data-wseg]")].map(e => e.closest("label")?.textContent?.trim()) }));
    await mp.click("#mc-ok");
    await settle();
    const bend = await mp.evaluate(() => { const l = window.__sv.model.last(), id = window.__sv.model.store.doc.features.at(-1).id; return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), arc: (l.cutList ?? []).some(c => c.length === 157.1), faces: (l.faceNames ?? []).filter(n => n.startsWith(id + ":j2:")).length }; });
    check(JSON.stringify(bl.segs) === '["j1","j2","j3"]' && JSON.stringify(bl.labels) === '["Line 1","Arc 2","Line 3"]' && bend.faces > 0 && !bend.bad && bend.arc, `weldments: a member along a line, an arc and a line (${JSON.stringify({ bl, bend })})`);
    // Merge arc segment bodies: the line, arc and line become one body, one cut list item of the whole bent length (300 + 157.1 + 300).
    const bendId = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), bendId);
    await settle();
    await mp.click('#mc-pm input[data-k="wMergeArcs"]');
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const merged = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), rows: (l.cutList ?? []).filter(c => c.kind === "member" && c.length > 700).map(c => [c.qty, c.length]) }; });
    await mp.evaluate(() => window.__sv.model.store.undo());
    await settle();
    check(!merged.bad && JSON.stringify(merged.rows) === "[[1,757.1]]", `weldments: merged arc segment bodies (${JSON.stringify(merged)})`);
    // Groups: the last line of that member in a new group, turned 90° on its own.
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), bendId);
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wgroup:j3"]', "new");
    await settle();
    const gl = await mp.evaluate(() => [...document.querySelectorAll("#mc-pm legend")].map(e => e.textContent).filter(x => /^Group/.test(x)));
    await mp.fill('#mc-pm input[data-num="groups.0.angle"]', "90");
    await mp.press('#mc-pm input[data-num="groups.0.angle"]', "Tab");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const grp = await mp.evaluate(id => { const l = window.__sv.model.last(), f = window.__sv.model.store.doc.features.find(x => x.id === id); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), groups: f.groups?.map(g => [g.ents, Math.round((g.angle?.v ?? 0) * 180 / Math.PI)]) }; }, bendId);
    check(JSON.stringify(gl) === '["Group 2"]' && !grp.bad && JSON.stringify(grp.groups) === '[[["j3"],90]]', `weldments: member groups with their own rotation (${JSON.stringify({ gl, grp })})`);
    // Trim/Extend End miter: two separate beams that stop short of a corner meet in a mitre.
    await mp.evaluate(() => {
      const P = (id, x, y) => ({ id, t: "point", x, y }); const L = (id, a, b) => ({ id, t: "line", a, b });
      window.__sv.model.store.change("Beams", d => {
        d.features.push({ id: "xsa", type: "sketch", name: "SketchA", plane: { std: "XY" }, rels: [], dims: [], ents: [P("u1", 2100, 2000), P("u2", 2400, 2000), L("ua", "u1", "u2")] },
          { id: "xsb", type: "sketch", name: "SketchB", plane: { std: "XY" }, rels: [], dims: [], ents: [P("v1", 2000, 2100), P("v2", 2000, 2400), L("vb", "v1", "v2")] },
          { id: "xma", type: "member", name: "Beam A", profile: "shs", size: "40x40x3", segs: [{ sketch: "xsa", ent: "ua" }], corner: "none" },
          { id: "xmb", type: "member", name: "Beam B", profile: "shs", size: "40x40x3", segs: [{ sketch: "xsb", ent: "vb" }], corner: "none" });
        d.rollback = null;
      });
    });
    await settle();
    await runCmd(mp, "Trim/Extend");
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wkind"]', "mitre");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.bodies = [{ name: "xma:ua:start" }]; m.draft.boundary = { name: "xmb:vb:start" }; window.__sv.modeller.draftChanged(); });
    await settle();
    const mh = await mp.evaluate(() => document.querySelector("#mc-pm")?.textContent?.includes("Member"));
    await mp.click("#mc-ok");
    await settle();
    const mit = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), rows: (l.cutList ?? []).filter(c => c.desc === "SHS 40x40x3" && Math.abs(c.length - 420) < 0.01).map(c => [c.qty, c.angle1 + c.angle2]) }; });
    check(mh && !mit.bad && JSON.stringify(mit.rows) === "[[2,45]]", `weldments: Trim/Extend End miter joins two separate members (${JSON.stringify({ mh, mit })})`);
    // The same corner as End butt 1 (picked in the panel's type list): one beam stops at the other's side.
    const trId = await mp.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), trId);
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wkind"]', "butt1");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.bodies = [{ name: "xma:ua:start" }]; m.draft.boundary = { name: "xmb:vb:start" }; window.__sv.modeller.draftChanged(); });
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const butt = await mp.evaluate(() => { const l = window.__sv.model.last(); return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), rows: (l.cutList ?? []).filter(c => c.desc === "SHS 40x40x3" && (Math.abs(c.length - 420) < 0.01 || Math.abs(c.length - 380) < 0.01)).map(c => [c.qty, Math.round(c.length), c.angle1 + c.angle2]).sort() }; });
    check(!butt.bad && JSON.stringify(butt.rows) === "[[1,380,0],[1,420,0]]", `weldments: Trim/Extend End butt 1 (${JSON.stringify(butt)})`);
    // Weld gap on the same Trim/Extend: the stopping beam ends 3 mm short of the other's side.
    await mp.evaluate(id => window.__sv.modeller.editFeature(id), trId);
    await settle();
    await mp.click('#mc-pm input[data-k="wGap"]');
    await settle();
    await mp.fill('#mc-pm input[data-num="gap"]', "3");
    await mp.press('#mc-pm input[data-num="gap"]', "Tab");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    const tg = await mp.evaluate(id => { const l = window.__sv.model.last(), f = window.__sv.model.store.doc.features.find(x => x.id === id); return { gap: f.gap?.v, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), rows: (l.cutList ?? []).filter(c => c.desc === "SHS 40x40x3" && (Math.abs(c.length - 420) < 0.01 || Math.abs(c.length - 377) < 0.01)).map(c => [c.qty, Math.round(c.length)]).sort() }; }, trId);
    check(tg.gap === 3 && !tg.bad && JSON.stringify(tg.rows) === "[[1,377],[1,420]]", `weldments: Trim/Extend weld gap (${JSON.stringify(tg)})`);
    // Trim/Extend to a reference plane chosen in the panel (no face picked): Beam A cut at x = 2200.
    await mp.evaluate(() => window.__sv.model.store.change("Plane", d => { d.features.push({ id: "xpl", type: "plane", name: "Cut plane", base: { std: "YZ" }, mode: "offset", offset: { v: 2200 } }); d.rollback = null; }));
    await settle();
    await runCmd(mp, "Trim/Extend");
    await settle();
    await mp.evaluate(() => { const m = window.__sv.model.mode(); m.draft.bodies = [{ name: "xma:ua:start" }]; window.__sv.modeller.draftChanged(); });
    await settle();
    await mp.selectOption('#mc-pm select[data-k="wplane"]', "plane:xpl");
    await settle();
    const noFaceBox = await mp.evaluate(() => !document.querySelector('#mc-pm [data-k="wbound"]'));
    await mp.click("#mc-ok");
    await settle();
    const tp = await mp.evaluate(() => { const l = window.__sv.model.last(), f = window.__sv.model.store.doc.features.at(-1); return { plane: f.plane, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), rows: (l.cutList ?? []).filter(c => c.desc === "SHS 40x40x3" && Math.abs(c.length - 200) < 0.01).map(c => c.qty) }; });
    check(noFaceBox && tp.plane?.plane === "xpl" && !tp.bad && JSON.stringify(tp.rows) === "[1]", `weldments: Trim/Extend to a reference plane (${JSON.stringify({ noFaceBox, tp })})`);
    // In Russian: the Structural Member panel.
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature("m2"));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm label, #mc-pm .pm-help, #mc-pm option")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(ru.title === "Элемент конструкции" && !/[A-Za-z]{3}/.test(ru.text.replace(/SHS|RHS|CHS|UPN|IPE|HEA|HEB|EN|DIN|Enter|Esc/g, "")), `weldments: Structural Member panel in Russian (${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- Sheet metal (FR-FT-120): base flange from a gauge table, edge flange picked in the view, flatten, flat pattern DXF ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const mp = await ctx.newPage();
    mp.on("pageerror", e => errors.push(e.message));
    mp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await mp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await mp.goto(`${origin}/index.html?debug`);
    await mp.waitForFunction(() => window.__sv);
    const idle = () => mp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const settle = async () => { await mp.waitForTimeout(150); await idle(); await mp.waitForTimeout(150); await idle(); };
    await mp.click("#new-part");
    await mp.waitForFunction(() => window.__sv.model?.store);
    await settle();
    // A 100 × 50 rectangle on Top.
    await mp.evaluate(() => {
      const P = (id, x, y) => ({ id, t: "point", x, y });
      window.__sv.model.store.change("Add Sketch1", d => d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [],
        ents: [P("p1", 0, 0), P("p2", 100, 0), P("p3", 100, 50), P("p4", 0, 50), { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] }));
    });
    await settle();
    const smMenu = async label => { await runCmd(mp, label); await settle(); };
    await smMenu("Base Flange/Tab");
    const b0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, sketch: window.__sv.model.mode().draft?.sketch }));
    await mp.selectOption('#mc-pm select[data-sm="gauge"]', "steel:16");
    await settle();
    const b1 = await mp.evaluate(() => ({ t: window.__sv.model.mode().draft.thickness.v, r: window.__sv.model.mode().draft.radius.v, k: window.__sv.model.mode().draft.k, v: window.__sv.model.last().props?.volume ?? 0, shown: document.querySelector('#mc-pm input[data-num="thickness"]').value }));
    await mp.click("#mc-ok");
    await settle();
    check(b0.title === "Base Flange" && b0.sketch === "s1" && b1.t === 1.519 && b1.r === 1.5 && b1.k === 0.42 && b1.shown === "1.519" && Math.abs(b1.v - 100 * 50 * 1.519) < 1e-3,
      `sheet metal: Base Flange from a closed sketch, thickness, radius and K-factor from the gauge table (FR-FT-120) (${JSON.stringify({ b0, b1 })})`);
    // Edge flange: click the front top edge (y = 0, z = T) in the view; the preview shows it at once.
    const scr = p => mp.evaluate(p => { const v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect(); const V = v.camera.position.constructor; const q = new V(...p).project(v.camera); return [((q.x + 1) / 2) * r.width + r.left, ((1 - q.y) / 2) * r.height + r.top]; }, p);
    await mp.evaluate(() => window.__sv.viewer.viewFrom(new window.__sv.viewer.camera.position.constructor(0.3, -1, 0.6)));
    await mp.waitForTimeout(300);
    await smMenu("Edge Flange");
    const [ex, ey] = await scr([60, 0, 1.519]);
    await mp.mouse.click(ex, ey);
    await settle();
    const f0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, edges: window.__sv.model.mode().draft.edges.map(e => e.faces.slice().sort().join("|")), v: window.__sv.model.last().props?.volume ?? 0, bends: window.__sv.model.last().sheet?.bends.length }));
    await mp.fill('#mc-pm input[data-num="length"]', "25");
    await mp.press('#mc-pm input[data-num="length"]', "Tab");
    await settle();
    await mp.click("#mc-ok");
    await settle();
    // Folded volume: two panels plus a quarter ring (T 1.519, R 1.5, flange 25 to the outer virtual sharp, material inside).
    const T = 1.519, R = 1.5;
    const want = T * 100 * (50 - (R + T)) + T * 100 * (25 - (R + T)) + (Math.PI / 4) * ((R + T) ** 2 - R ** 2) * 100;
    const f1 = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";"), names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    check(f0.title === "Edge Flange" && f0.edges.length === 1 && /b?.*:p0:top/.test(f0.edges[0]) && f0.bends === 1 && f0.v > b1.v && !f1.bad && Math.abs(f1.v - want) / want < 1e-6 && /Base-Flange1,Edge-Flange1$/.test(f1.names),
      `sheet metal: Edge Flange on an edge clicked in the view, live preview, length typed (${JSON.stringify({ f0, f1, want })})`);
    // The flange's length arrow (SolidWorks handle): at the flange tip, dragging it 10 mm further lengthens the flange live.
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "smflange").id));
    await settle();
    const fa = await mp.evaluate(() => {
      const as = window.__sv.modeller.arrows ?? [], v = window.__sv.viewer, r = v.renderer.domElement.getBoundingClientRect();
      const scr = p => { const q = p.clone().project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; };
      const a = as[0];
      if (!a) return { n: 0 };
      const grip = a.obj.position.clone().addScaledVector(a.dir, a.scale * 0.8);
      return { n: as.length, key: a.key, dir: a.dir.toArray().map(x => Math.round(x * 1000) / 1000), tipZ: a.obj.position.z, from: scr(grip), to: scr(grip.clone().addScaledVector(a.dir, 10)), label: document.querySelector("#mc-layer .mc-handle")?.textContent };
    });
    if (fa.from) {
      await mp.mouse.move(fa.from[0], fa.from[1]);
      await mp.mouse.down();
      for (let i = 1; i <= 6; i++) { await mp.mouse.move(fa.from[0] + ((fa.to[0] - fa.from[0]) * i) / 6, fa.from[1] + ((fa.to[1] - fa.from[1]) * i) / 6); await mp.waitForTimeout(40); }
      await mp.mouse.up();
      await settle();
    }
    const fd = await mp.evaluate(() => ({ len: window.__sv.model.mode().draft?.length?.v, v: window.__sv.model.last().props?.volume ?? 0 }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    await settle();
    check(fa.n === 1 && fa.key === "length" && fa.dir[2] === 1 && Math.abs(fa.tipZ - 25) < 1 && fa.label === "25 mm" && fd.len > 31 && fd.len < 39 && Math.abs(fd.v - (f1.v + T * 100 * (fd.len - 25))) < 1e-2,
      `sheet metal: the Edge Flange length arrow sits on the flange tip and dragging it lengthens the flange (${JSON.stringify({ fa, fd })})`);
    // Flatten: a flat plate of the developed length, then the DXF with the outline and the bend line.
    await smMenu("Flatten");
    const ba = (Math.PI / 2) * (R + 0.42 * T);
    const flat = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, names: window.__sv.model.store.doc.features.map(f => `${f.name}${f.suppressed ? "-" : ""}`).join(","), bb: (() => { const d = window.__sv.model.last().data; let z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let i = 2; i < d.positions.length; i += 3) { z0 = Math.min(z0, d.positions[i]); z1 = Math.max(z1, d.positions[i]); y0 = Math.min(y0, d.positions[i - 1]); y1 = Math.max(y1, d.positions[i - 1]); } return [z1 - z0, y1 - y0]; })() }));
    const flatLen = 50 - (R + T) + ba + 25 - (R + T);
    const [dl] = await Promise.all([mp.waitForEvent("download"), smMenu("Flat pattern DXF")]);
    const dxf = await (async () => { const p = await dl.path(); return (await import("node:fs")).readFileSync(p, "utf8"); })();
    check(/Flat-Pattern1$/.test(flat.names) && Math.abs(flat.bb[0] - T) < 1e-3 && Math.abs(flat.bb[1] - flatLen) < 1e-3 && Math.abs(flat.v - T * 100 * flatLen) / (T * 100 * flatLen) < 1e-6
      && dl.suggestedFilename().endsWith("-flat.dxf") && /AC1009/.test(dxf) && (dxf.match(/\nLINE\n/g) ?? []).length === 5 && /BEND_UP/.test(dxf),
      `sheet metal: Flatten shows the flat pattern (K-factor bend allowance) and exports it as DXF with the bend line (${JSON.stringify({ flat, flatLen, file: dl.suggestedFilename(), lines: (dxf.match(/\nLINE\n/g) ?? []).length })})`);
    // Fold back, and the Base Flange panel in Russian.
    await smMenu("Flatten");
    const folded = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "smbase").id));
    await settle();
    const ru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm label > span:first-child, #mc-pm .pm-help, #mc-pm option")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(Math.abs(folded - want) / want < 1e-6 && ru.title === "Базовая кромка" && !/[A-Za-z]{3}/.test(ru.text.replace(/Enter|Esc|MSG|mm/g, "")), `sheet metal: folds back; Base Flange panel in Russian (${JSON.stringify({ folded, ru })})`);
    await mp.click("#lang-btn");
    // Sketched bend: drop the flange and flat pattern, sketch a line across the plate's bottom face (XY), fold it.
    await mp.evaluate(() => window.__sv.model.store.change("Sketched bend", d => {
      d.features = d.features.filter(f => f.type !== "smflange" && f.type !== "smflat");
      d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "q1", t: "point", x: 70, y: -5 }, { id: "q2", t: "point", x: 70, y: 55 }, { id: "q3", t: "line", a: "q1", b: "q2" }] });
    }));
    await settle();
    await smMenu("Sketched Bend");
    const sb0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, sketch: window.__sv.model.mode().draft?.sketch }));
    await mp.click("#mc-ok");
    await settle();
    const sbb = await mp.evaluate(() => { const d = window.__sv.model.last().data, P = d.positions; const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); } return { size: hi.map((h, i) => h - lo[i]), bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";"), names: window.__sv.model.store.doc.features.map(f => f.name).join(",") }; });
    const sba = (Math.PI / 2) * (R + 0.42 * T);
    check(sb0.title === "Sketched Bend" && sb0.sketch === "s2" && !sbb.bad && /Sketched-Bend1$/.test(sbb.names) && Math.abs(sbb.size[0] - (70 - sba / 2 + R + T)) < 2e-3 && Math.abs(sbb.size[2] - (T + R + 30 - sba / 2)) < 2e-3,
      `sheet metal: Sketched Bend folds the plate along a line sketched on its face (${JSON.stringify({ sb0, sbb, want: [70 - sba / 2 + R + T, T + R + 30 - sba / 2] })})`);
    // Tab: a closed sketch beside the plate's back edge, on its bottom face; Base Flange/Tab makes a tab now.
    const tv0 = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    await mp.evaluate(() => window.__sv.model.store.change("Tab sketch", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y });
      d.features.push({ id: "s3", type: "sketch", name: "Sketch3", plane: { std: "XY" }, rels: [], dims: [], ents: [P("r1", 10, 50), P("r2", 40, 50), P("r3", 40, 65), P("r4", 10, 65), { id: "m1", t: "line", a: "r1", b: "r2" }, { id: "m2", t: "line", a: "r2", b: "r3" }, { id: "m3", t: "line", a: "r3", b: "r4" }, { id: "m4", t: "line", a: "r4", b: "r1" }] });
    }));
    await settle();
    await smMenu("Base Flange/Tab");
    const tb0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, type: window.__sv.model.mode().draft?.type, sketch: window.__sv.model.mode().draft?.sketch }));
    await mp.click("#mc-ok");
    await settle();
    const tb1 = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";") }));
    check(tb0.title === "Tab" && tb0.type === "smtab" && tb0.sketch === "s3" && !tb1.bad && Math.abs(tb1.v - tv0 - 30 * 15 * T) < 1e-3,
      `sheet metal: Base Flange/Tab on a part with a base flange adds a tab beside a face (${JSON.stringify({ tb0, tb1, tv0 })})`);
    // A hole cut through the plate by an ordinary extrude shows in the flat pattern and its DXF.
    await smMenu("Flatten");
    const hv0 = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    await smMenu("Flatten");
    await mp.evaluate(() => window.__sv.model.store.change("Hole", d => {
      const at = d.features.findIndex(f => f.type === "smflat");
      d.features.splice(at, 0, { id: "s4", type: "sketch", name: "Sketch4", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "hc", t: "point", x: 30, y: 25 }, { id: "ho", t: "circle", c: "hc", r: 4 }] },
        { id: "c4", type: "extrude", name: "Cut-Extrude1", sketch: "s4", op: "cut", end: "through2", depth: { v: 0 } });
    }));
    await settle();
    await smMenu("Flatten");
    const hv = await mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, circles: (window.__sv.model.last().sheet?.flatEdges ?? []).filter(e => e.kind === "circle").map(e => e.r), bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";") }));
    const [hdl] = await Promise.all([mp.waitForEvent("download"), smMenu("Flat pattern DXF")]);
    const hdxf = (await import("node:fs")).readFileSync(await hdl.path(), "utf8");
    check(!hv.bad && hv.circles.length === 1 && Math.abs(hv.circles[0] - 4) < 1e-6 && Math.abs(hv0 - hv.v - Math.PI * 16 * T) < 1e-3 && (hdxf.match(/\nCIRCLE\n/g) ?? []).length === 1,
      `sheet metal: a hole cut after the sheet metal features shows in the flat pattern and its DXF (${JSON.stringify({ hv0, hv, circles: (hdxf.match(/\nCIRCLE\n/g) ?? []).length })})`);
    // Edge flanges on the plate's front and right edges (they meet at a corner): mitred, with the corner gap in the panel.
    await mp.evaluate(() => window.__sv.model.store.change("Mitre", d => {
      const b = d.features.find(f => f.type === "smbase");
      d.features = d.features.filter(f => f.id === "s1" || f.id === b.id);
      d.features.push({ id: "fm", type: "smflange", name: "Edge-Flange9", edges: [{ faces: [`${b.id}:p0:top`, `${b.id}:p0:l1`] }, { faces: [`${b.id}:p0:top`, `${b.id}:p0:l2`] }], length: { v: 20 }, angle: { v: Math.PI / 2 } });
    }));
    await settle();
    await mp.evaluate(() => window.__sv.modeller.editFeature("fm"));
    await settle();
    const mt = await mp.evaluate(() => {
      const l = window.__sv.model.last(), P = l.data.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
      return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), size: hi.map((h, i) => Math.round((h - lo[i]) * 1000) / 1000), mitres: (l.sheet?.panels ?? []).filter(p => p.outer.some(x => x.ent === "miter")).length, gap: document.querySelector('#mc-pm input[data-num="gap"]')?.value };
    });
    await mp.evaluate(() => window.__sv.modeller.cancel());
    check(!mt.bad && mt.mitres === 2 && mt.size[0] === 100 && mt.size[1] === 50 && mt.size[2] === 20 && mt.gap === "0.1",
      `sheet metal: edge flanges on two edges meeting at a corner are mitred, corner gap in the panel (${JSON.stringify(mt)})`);
    // Break Corner: click the thickness edge at the plate's (100, 0) corner, chamfer it 10 mm; the flat pattern follows.
    await mp.evaluate(() => window.__sv.model.store.change("Plate", d => {
      const b = d.features.find(f => f.type === "smbase");
      d.features = d.features.filter(f => f.id === "s1" || f.id === b.id);
    }));
    await settle();
    const bcv0 = await mp.evaluate(() => window.__sv.model.last().props?.volume ?? 0);
    await smMenu("Break Corner");
    const [bx, by] = await scr([100, 0, T / 2]);
    await mp.mouse.click(bx, by);
    await settle();
    await mp.selectOption('#mc-pm select[data-sm="kind"]', "chamfer");
    await settle();
    await mp.fill('#mc-pm input[data-num="size"]', "10");
    await mp.press('#mc-pm input[data-num="size"]', "Tab");
    await settle();
    const bc0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, edges: window.__sv.model.mode().draft?.edges.map(e => e.faces.slice().sort().join("|")) }));
    await mp.click("#mc-ok");
    await settle();
    const bc1 = await mp.evaluate(() => { const l = window.__sv.model.last(); return { v: l.props?.volume ?? 0, segs: l.sheet?.panels[0].outer.length, bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";") }; });
    check(bc0.title === "Break Corner" && bc0.edges?.length === 1 && /:p0:l1\|.*:p0:l2$/.test(bc0.edges[0]) && !bc1.bad && bc1.segs === 5 && Math.abs(bcv0 - bc1.v - 50 * T) < 1e-3,
      `sheet metal: Break Corner chamfers the picked thickness edge's corner, in the flat outline too (${JSON.stringify({ bc0, bc1, bcv0 })})`);
    // Closed Corner: two flanges, material outside, made one at a time leave an open corner; clicking the front one's end face closes it.
    await mp.evaluate(() => window.__sv.model.store.change("Flanges", d => {
      const b = d.features.find(f => f.type === "smbase");
      d.features = d.features.filter(f => f.id === "s1" || f.id === b.id);
      for (const [id, e] of [["fa", "l1"], ["fb", "l2"]]) d.features.push({ id, type: "smflange", name: id === "fa" ? "Edge-Flange7" : "Edge-Flange8", edges: [{ faces: [`${b.id}:p0:top`, `${b.id}:p0:${e}`] }], length: { v: 20 }, angle: { v: Math.PI / 2 }, position: "outside" });
    }));
    await settle();
    await smMenu("Closed Corner");
    const [cx, cy] = await scr([100, -T / 2, 12]);
    await mp.mouse.click(cx, cy);
    await settle();
    const cc0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, faces: window.__sv.model.mode().draft?.faces.map(f => f.name) }));
    await mp.click("#mc-ok");
    await settle();
    const cc1 = await mp.evaluate(() => {
      const l = window.__sv.model.last(), P = l.sheet?.panels ?? [];
      const at = (pid, ent) => { const p = P.find(x => x.id === pid), sg = p?.outer.find(x => x.ent === ent); if (!sg) return null; const q = sg.a, M = p.M; return [0, 1, 2].map(k => M.o[k] + M.x[k] * q[0] + M.y[k] * q[1]); };
      return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), fx: at("fa:p0", "s1")?.[0], gy: at("fb:p0", "s0")?.[1] };
    });
    check(cc0.title === "Closed Corner" && JSON.stringify(cc0.faces) === '["fa:p0:s1"]' && !cc1.bad && Math.abs(cc1.fx - (100 + T)) < 1e-6 && Math.abs(cc1.gy - 0.1) < 1e-6,
      `sheet metal: Closed Corner runs the clicked flange end over the other flange, which runs to the gap (${JSON.stringify({ cc0, cc1 })})`);
    // Miter Flange: a profile on Right (YZ) at the front edge's start, up 20 then 10 outwards; the right and front top edges clicked.
    await mp.evaluate(() => window.__sv.model.store.change("Miter profile", d => {
      const b = d.features.find(f => f.type === "smbase");
      d.features = d.features.filter(f => f.id === "s1" || f.id === b.id);
      const P = (id, x, y) => ({ id, t: "point", x, y });
      d.features.push({ id: "s5", type: "sketch", name: "Sketch5", plane: { std: "YZ" }, rels: [], dims: [], ents: [P("w1", 0, 0), P("w2", 0, 20), P("w3", -10, 20), { id: "w4", t: "line", a: "w1", b: "w2" }, { id: "w5", t: "line", a: "w2", b: "w3" }] });
    }));
    await settle();
    await smMenu("Miter Flange");
    for (const p of [[100, 25, T], [60, 0, T]]) { const [x, y] = await scr(p); await mp.mouse.click(x, y); await settle(); }
    const mf0 = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, sketch: window.__sv.model.mode().draft?.sketch, edges: window.__sv.model.mode().draft?.edges.length }));
    await mp.click("#mc-ok");
    await settle();
    const mf1 = await mp.evaluate(() => {
      const l = window.__sv.model.last(), P = l.data.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
      return { bad: l.statuses.filter(s => !s.ok).map(s => s.message).join(";"), size: hi.map((h, i) => Math.round((h - lo[i]) * 1000) / 1000), mitres: (l.sheet?.panels ?? []).filter(p => p.outer.some(x => x.ent === "miter")).length, names: window.__sv.model.store.doc.features.map(f => f.name).join(",") };
    });
    await mp.click("#lang-btn");
    await mp.evaluate(() => window.__sv.modeller.editFeature(window.__sv.model.store.doc.features.find(f => f.type === "smmiter").id));
    await settle();
    const mru = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, text: [...document.querySelectorAll("#mc-pm legend, #mc-pm label, #mc-pm .pm-help, #mc-pm .pm-count, #mc-pm button")].map(e => e.textContent).join("|") }));
    await mp.evaluate(() => window.__sv.modeller.cancel());
    await mp.click("#lang-btn");
    check(mf0.title === "Miter Flange" && mf0.sketch === "s5" && mf0.edges === 2 && !mf1.bad && mf1.mitres === 4 && mf1.size[0] === 110 && mf1.size[1] === 60 && Math.abs(mf1.size[2] - (20 + T)) < 2e-3 && /Miter-Flange1$/.test(mf1.names)
      && mru.title === "Кромка под углом" && !/[A-Za-z]{3}/.test(mru.text.replace(/Enter|Esc|MSG|mm|Sketch5/g, "")),
      `sheet metal: Miter Flange runs a sketched profile along two clicked edges, mitred at their corner; panel in Russian (${JSON.stringify({ mf0, mf1, mru })})`);
    // A slot cut across the front flange's bend: the flat pattern loses the same material, bend part unrolled.
    const across = async withCut => {
      await mp.evaluate(withCut => window.__sv.model.store.change("Slot across bend", d => {
        const b = d.features.find(f => f.type === "smbase");
        d.features = d.features.filter(f => f.id === "s1" || f.id === b.id);
        const P = (id, x, y) => ({ id, t: "point", x, y });
        d.features.push({ id: "fx", type: "smflange", name: "Edge-Flange6", edges: [{ faces: [`${b.id}:p0:top`, `${b.id}:p0:l1`] }], length: { v: 20 }, angle: { v: Math.PI / 2 } },
          { id: "s6", type: "sketch", name: "Sketch6", plane: { std: "XY" }, rels: [], dims: [], ents: [P("k1", 40, -5), P("k2", 60, -5), P("k3", 60, 10), P("k4", 40, 10), { id: "k5", t: "line", a: "k1", b: "k2" }, { id: "k6", t: "line", a: "k2", b: "k3" }, { id: "k7", t: "line", a: "k3", b: "k4" }, { id: "k8", t: "line", a: "k4", b: "k1" }] },
          { id: "c6", type: "extrude", name: "Cut-Extrude6", sketch: "s6", op: "cut", end: "through2", depth: { v: 0 } });
        if (!withCut) d.features = d.features.filter(f => f.id !== "c6");
        d.features.push({ id: "fp6", type: "smflat", name: "Flat-Pattern1" });
      }), withCut);
      await settle();
      return mp.evaluate(() => ({ v: window.__sv.model.last().props?.volume ?? 0, bad: window.__sv.model.last().statuses.filter(s => !s.ok).map(s => s.message).join(";") }));
    };
    const xb0 = await across(false), xb1 = await across(true);
    const xbWant = T * 20 * (10 - (R + T) + (Math.PI / 2) * (R + 0.42 * T) + 20 - (R + T));
    check(!xb0.bad && !xb1.bad && Math.abs(xb0.v - xb1.v - xbWant) / xbWant < 1e-3,
      `sheet metal: a cut across a bend is unrolled in the flat pattern (${JSON.stringify({ xb0, xb1, xbWant })})`);
    await ctx.close();
  }

  // --- Tabs + assembly rebuild, Modify box, feature dimensions on the model, resizable panels (FR-UI-114, FR-UI-115, FR-UI-002) ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug&nokernel`);
    await dp.waitForFunction(() => window.__sv);
    const idle = () => dp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const plate = w => dp.evaluate(w => window.__sv.model.store.change("Plate", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [{ id: "d1", name: "D1", t: "distance", e: ["l1"], val: { v: 2 * w } }], ents: [P("a", -w, -10), P("b", w, -10), P("c", w, 10), P("d", -w, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }), w);
    await dp.click("#new-part");
    await dp.waitForFunction(() => window.__sv.model?.store);
    await plate(20); await dp.waitForTimeout(150); await idle();
    await dp.click("#new-part");
    await dp.waitForFunction(() => window.__sv.model?.store?.doc.features.length === 0);
    const name2 = await dp.evaluate(() => window.__sv.model.store.doc.name);
    await plate(30); await dp.waitForTimeout(150); await idle();
    // An assembly parked while it rebuilds used to keep "Rebuilding…" for ever once shown again.
    await dp.click("#new-more"); await dp.click("#new-asm");
    await dp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    await dp.click('#asm-tools [data-ac="insert"]'); await dp.click("#asm-menu button >> nth=0");
    await dp.click("#doc-tabs .dt >> nth=0 >> .dt-b");
    await dp.waitForFunction(() => window.__sv.model?.store);
    await dp.click("#doc-tabs .dt >> nth=2 >> .dt-b");
    await dp.waitForFunction(() => window.__sv.asm.doc);
    await dp.click('#asm-tools [data-ac="insert"]'); await dp.click("#asm-menu button >> nth=1");
    const built = await dp.waitForFunction(() => document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 2, null, { timeout: 90000 }).then(() => true, () => false);
    check(name2 === "Part2" && built, `asm: an assembly parked while it rebuilds builds again when shown, and both open parts insert (second part ${name2}, built ${built})`);
    // Back to Part2: double-clicking its face shows the feature's dimensions on the model.
    await dp.click("#doc-tabs .dt >> nth=1 >> .dt-b");
    await dp.waitForFunction(() => window.__sv.model?.store && window.__sv.model.last());
    await idle();
    const vb = await dp.evaluate(() => { const r = window.__sv.viewer.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await dp.mouse.dblclick(vb.x, vb.y);
    await dp.waitForSelector(".mc-fdim", { timeout: 5000 }).catch(() => {});
    const fdims = await dp.evaluate(() => [...document.querySelectorAll(".mc-fdim")].map(b => b.textContent).sort());
    check(fdims.join() === "10,60", `modify: double-clicking a face shows its feature's dimensions on the model (${fdims})`);
    // The depth in the Modify box: ✕ leaves it, ✓ (Enter) changes it as one undo step.
    const clickDim = async v => { const i = await dp.evaluate(v => [...document.querySelectorAll(".mc-fdim")].findIndex(b => b.textContent === v), v); await dp.click(`.mc-fdim >> nth=${i}`); };
    await clickDim("10");
    await dp.waitForSelector(".mod-box .sk-input");
    const box = await dp.evaluate(() => ({ title: document.querySelector(".mod-box .mod-t").textContent, v: document.querySelector(".mod-box input").value, btns: [...document.querySelectorAll(".mod-box .mod-b button")].map(b => b.textContent).join("") }));
    await dp.fill(".mod-box input", "25");
    await dp.click(".mod-box [data-m=x]");
    await dp.waitForTimeout(100);
    const kept = await dp.evaluate(() => window.__sv.model.store.doc.features.find(f => f.id === "x").depth.v);
    await clickDim("10");
    await dp.waitForSelector(".mod-box .sk-input");
    await dp.fill(".mod-box input", "25");
    await dp.press(".mod-box input", "Enter");
    await dp.waitForTimeout(150);
    await idle();
    const after = await dp.evaluate(() => ({ depth: window.__sv.model.store.doc.features.find(f => f.id === "x").depth.v, undo: window.__sv.model.store.undoLabel, labels: [...document.querySelectorAll(".mc-fdim")].map(b => b.textContent).sort().join() }));
    check(box.title === "Depth@Extrude1" && box.v === "10" && box.btns === "✓✕⟲" && kept === 10 && after.depth === 25 && /Depth@Extrude1/.test(after.undo) && after.labels === "25,60",
      `modify: the Modify box changes a feature dimension (✕ keeps it, Enter takes it as one undo step) (${JSON.stringify({ box, kept, after })})`);
    // A sketch dimension: ⟲ rebuilds with the typed value, ✕ puts it back.
    const width = () => dp.evaluate(() => { const b = window.__sv.viewer.computeBounds(); return b.max.x - b.min.x; });
    await clickDim("60");
    await dp.waitForSelector(".mod-box .sk-input");
    await dp.fill(".mod-box input", "80");
    await dp.click(".mod-box [data-m=rebuild]");
    await dp.waitForTimeout(300);
    await idle();
    const prev = { size: await width(), stored: await dp.evaluate(() => window.__sv.model.store.doc.features[0].dims[0].val.v) };
    await dp.click(".mod-box [data-m=x]");
    await dp.waitForTimeout(300);
    await idle();
    const back = await width();
    check(Math.abs(prev.size - 80) < 1e-6 && prev.stored === 60 && Math.abs(back - 60) < 1e-6, `modify: ⟲ rebuilds with the typed value and ✕ goes back (${JSON.stringify({ prev, back })})`);
    // Resizable side panel: the grip drags its width, which is remembered; a double-click restores it.
    const grip = await dp.$eval("#app > .grip-left", g => { const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200, role: g.getAttribute("role"), now: g.getAttribute("aria-valuenow") }; });
    await dp.mouse.move(grip.x, grip.y); await dp.mouse.down(); await dp.mouse.move(grip.x + 80, grip.y, { steps: 4 }); await dp.mouse.up();
    // The columns animate (180 ms): wait for the width to settle rather than a fixed time.
    const settled = w => dp.waitForFunction(w => Math.abs(document.querySelector("#tree-panel").getBoundingClientRect().width - w) <= 2, w, { timeout: 5000 }).catch(() => {});
    await settled(350);
    const w1 = await dp.evaluate(() => ({ w: document.querySelector("#tree-panel").getBoundingClientRect().width, saved: localStorage.getItem("mc:size:left") }));
    await dp.dblclick("#app > .grip-left");
    await settled(270);
    const w2 = await dp.evaluate(() => document.querySelector("#tree-panel").getBoundingClientRect().width);
    check(grip.role === "separator" && Math.abs(w1.w - 350) <= 2 && w1.saved === "350" && Math.abs(w2 - 270) <= 2, `ui: the side panel resizes from its grip, the width is remembered and double-click restores it (${JSON.stringify({ grip, w1, w2 })})`);
    await ctx.close();
  }

  // --- Document tabs (FR-DOC-003, FR-UI-120): parts, assemblies and drawings stay open in tabs at the bottom ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug&nokernel`);
    await dp.waitForFunction(() => window.__sv);
    const tabs = () => dp.evaluate(() => [...document.querySelectorAll("#doc-tabs .dt")].map(d => (d.classList.contains("on") ? "*" : "") + d.querySelector(".dt-l").textContent));
    const idle = () => dp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    await dp.click("#new-part");
    await dp.waitForFunction(() => window.__sv.model?.store);
    await dp.evaluate(() => window.__sv.model.store.change("Plate", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await dp.waitForTimeout(150);
    await idle();
    const t0 = await tabs();
    // Make assembly from part: the part stays open in its own tab.
    await dp.click("#new-more"); await dp.click("#new-asm-part");
    await dp.waitForFunction(() => window.__sv.asm.doc?.components.length === 1);
    const t1 = await tabs();
    // Back to the part: its features and its undo history are still there.
    await dp.click("#doc-tabs .dt >> nth=0 >> .dt-b");
    await dp.waitForFunction(() => window.__sv.model?.store);
    const back = await dp.evaluate(() => ({ feats: window.__sv.model.store.doc.features.length, undo: window.__sv.model.store.undoLabel, model: document.querySelector("#app").classList.contains("model") }));
    check(t0.join() === "*Part1.mcadprt" && t1.join() === "Part1.mcadprt,*Assembly1.mcadasm" && back.feats === 2 && back.undo === "Plate" && back.model,
      `tabs: the part keeps its tab when an assembly is made from it, and comes back with its undo history (${t0} → ${t1}; ${JSON.stringify(back)})`);
    // Insert component offers the part open in the other tab.
    await dp.click("#doc-tabs .dt >> nth=1 >> .dt-b");
    await dp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    await dp.click('#asm-tools [data-ac="insert"]');
    const offered = await dp.evaluate(() => [...document.querySelectorAll("#asm-menu button")].map(b => b.textContent));
    await dp.click("#asm-menu button >> nth=0");
    await dp.waitForFunction(() => window.__sv.asm.doc.components.length === 2);
    check(offered.join("|") === "Open document: Part1.mcadprt|Browse…", `tabs: Insert component lists the parts open in other tabs (${offered.join(" | ")})`);
    // A drawing opens in its own tab over the assembly; the assembly tab brings the 3D view back.
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForFunction(() => document.querySelector("#app").classList.contains("drawing") && document.querySelectorAll("#doc-tabs .dt").length === 3, null, { timeout: 90000 });
    const t2 = await tabs();
    const tabsBox = await dp.evaluate(() => { const r = document.querySelector("#doc-tabs").getBoundingClientRect(), d = document.querySelector(".drw").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, drw: d.bottom, h: innerHeight }; });
    await dp.click('#doc-tabs .dt-b:has-text("Assembly1")');
    await dp.waitForFunction(() => !document.querySelector("#app").classList.contains("drawing"));
    const t3 = await tabs();
    check(t2.join() === "Part1.mcadprt,Assembly1.mcadasm,*Assembly1.mcaddrw" && tabsBox.bottom === tabsBox.h && tabsBox.drw <= tabsBox.top && t3[1] === "*Assembly1.mcadasm",
      `tabs: a drawing gets its own tab above the drawing sheet, and the assembly tab returns to the 3D view (${t2} → ${t3}; ${JSON.stringify(tabsBox)})`);
    // Closing a changed document asks first; the tab goes.
    await dp.click("#doc-tabs .dt >> nth=0 >> .dt-x");
    const asked = await dp.isVisible("#confirm[open]");
    await dp.click("#confirm[open] [data-a=ok]");
    await dp.waitForFunction(() => document.querySelectorAll("#doc-tabs .dt").length === 2);
    const t4 = await tabs();
    // In Russian.
    await dp.click("#lang-btn");
    const ru = await dp.evaluate(() => ({ nav: document.querySelector("#doc-tabs").getAttribute("aria-label"), x: document.querySelector("#doc-tabs .dt-x").getAttribute("aria-label") }));
    await dp.click("#lang-btn");
    check(asked && t4.join() === "*Assembly1.mcadasm,Assembly1.mcaddrw" && ru.nav === "Открытые документы" && /^Закрыть /.test(ru.x), `tabs: closing a changed part asks first; Russian labels (${t4}; ${JSON.stringify(ru)})`);
    await ctx.close();
  }

  // --- Several part tabs next to a STEP tab: each tab shows its own body; a lost WebGL context comes back ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug&nokernel`);
    await dp.waitForFunction(() => window.__sv);
    await dp.setInputFiles("#file-input", join(fixtures, "cax-if/as1_pe_203.stp"));
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
    const idle = () => dp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    const plate = async w => {
      await dp.click("#new-part");
      await dp.waitForFunction(() => window.__sv.model?.store && !window.__sv.model.last());
      await dp.evaluate(w => window.__sv.model.store.change("Plate", d => {
        const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
        d.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -w / 2, -10), P("b", w / 2, -10), P("c", w / 2, 10), P("d", -w / 2, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
          { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 10 } });
      }), w);
      await dp.waitForTimeout(150);
      await idle();
    };
    await plate(40);
    await plate(80);
    // What the view shows: the open part's name, the body's width and whether the STEP header leaked into Properties.
    const shown = () => dp.evaluate(() => {
      const ps = window.__sv.viewer.parts, d = ps.length === 1 ? ps[0].data : null;
      return { name: window.__sv.model.store?.doc.name, w: d ? Math.round(d.bboxMax[0] - d.bboxMin[0]) : -ps.length, step: /AP203/.test(document.querySelector("#props")?.textContent ?? "") };
    });
    const seen = [];
    for (const i of [1, 2, 0, 1, 2, 1]) {
      await dp.click(`#doc-tabs .dt >> nth=${i} >> .dt-b`);
      if (i === 0) await dp.waitForFunction(() => !window.__sv.model.store && window.__sv.viewer.parts.length > 1 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
      else { await dp.waitForFunction(n => window.__sv.model.store?.doc.name === n, i === 1 ? "Part1" : "Part2"); await idle(); }
      const s = await shown();
      seen.push(i ? `${s.name}:${s.w}${s.step ? "+step" : ""}` : "step");
    }
    check(seen.join() === "Part1:40,Part2:80,step,Part1:40,Part2:80,Part1:40", `tabs: switching between two part tabs and a STEP tab shows each part's own body, without the STEP header (${seen})`);
    // A lost WebGL context (GPU reset) blanks the view; once the browser gives it back the view draws again.
    const lost = await dp.evaluate(async () => {
      const v = window.__sv.viewer, gl = v.renderer.getContext(), ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) return "no extension";
      const env0 = v.scene.environment;
      ext.loseContext();
      await new Promise(r => setTimeout(r, 300));
      const was = v.contextLost;
      ext.restoreContext();
      await new Promise(r => setTimeout(r, 800));
      // three.js starts a fresh renderer.info on restore, so any frame counted now was drawn on the new context.
      const msg = [...document.querySelectorAll("#toasts .toast")].map(x => x.textContent).join(" | ");
      return { was, back: !v.contextLost, drew: v.renderer.info.render.frame > 0 && v.renderer.info.render.triangles > 0, env: v.scene.environment !== env0, msg };
    });
    check(lost.was && lost.back && lost.drew && lost.env && /restored/.test(lost.msg), `viewer: a lost WebGL context is redrawn when it comes back, with a fresh environment map (${JSON.stringify(lost)})`);
    await ctx.close();
  }

  // --- STEP names written as raw Windows-1251 bytes (Russian CAD exports) show as Cyrillic, not "ÏË31à" ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", e => errors.push(e.message));
    const want = "ПЛ31а-п_черн";
    const cp = Buffer.from([...want].map(c => { const u = c.charCodeAt(0); return u < 0x80 ? u : u - 0x350; }));
    const src = await readFile("src/worker/warmup.step", "latin1");
    const parts = src.split("warm-up").map(x => Buffer.from(x, "latin1"));
    const file = Buffer.concat(parts.flatMap((x, i) => i ? [cp, x] : [x]));
    await pg.goto(`${origin}/index.html?debug&nokernel`);
    await pg.setInputFiles("#file-input", { name: "socket.step", mimeType: "application/step", buffer: file });
    await pg.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
    const names = await pg.$$eval("#tree .row-n", els => els.map(e => e.textContent.trim()));
    check(names.some(n => n.includes(want)) && !names.some(n => /[ÏËà÷åðí]/.test(n)), `STEP names in Windows-1251 read as Cyrillic in the model tree (${names.join(" | ")})`);
    await ctx.close();
  }

  // --- ✓/✕ always in reach: pinned panel title row and the confirmation corner at the top right of the view (FR-UI-021) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 } });
    const kp = await ctx.newPage();
    kp.on("pageerror", e => errors.push(e.message));
    kp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await kp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await kp.goto(`${origin}/index.html?debug&nokernel`);
    await kp.waitForFunction(() => window.__sv);
    await kp.click("#new-part");
    await kp.waitForFunction(() => window.__sv.model?.store);
    await kp.click('[data-c="sketch"]');
    await kp.click('#mc-pm [data-std="XY"]');
    await kp.waitForFunction(() => window.__sv.model.mode().kind === "sketch");
    await kp.waitForTimeout(300);
    // Scroll the long sketch panel to its end: the ✓ in its title row stays inside the panel.
    const reach = async (pmSel, cornerSel) => kp.evaluate(([ps, cs]) => {
      const pm = document.querySelector(ps);
      pm.scrollTop = pm.scrollHeight;
      const r = pm.getBoundingClientRect(), ok = pm.querySelector(".pm-top .pm-ok").getBoundingClientRect();
      const corner = document.querySelector(cs), c = corner.getBoundingClientRect(), vp = document.querySelector("#viewport").getBoundingClientRect();
      const cube = document.querySelector("#navcube").getBoundingClientRect();
      return { scrolls: pm.scrollHeight > pm.clientHeight, okIn: ok.top >= r.top - 1 && ok.bottom <= r.bottom + 1 && ok.height > 0, scrolled: pm.classList.contains("scrolled"),
        corner: !corner.hidden && c.height > 0, top: Math.round(c.top - vp.top), leftOfCube: c.right <= cube.left, okTitle: corner.querySelector(".mc-ok").title };
    }, [pmSel, cornerSel]);
    await kp.waitForTimeout(100);
    const sk = await reach("#mc-pm", "#mc-confirm");
    check(sk.scrolls && sk.okIn && sk.corner && sk.top <= 16 && sk.leftOfCube && sk.okTitle === "Exit sketch (Enter)",
      `✓ reach: the sketch panel's ✓ stays in view when the panel is scrolled, and the corner sits at the top right of the view (${JSON.stringify(sk)})`);
    await kp.waitForTimeout(100);
    const sc = await kp.evaluate(() => document.querySelector("#mc-pm").classList.contains("scrolled"));
    // The panel ✓ exits the sketch.
    await kp.click("#mc-pm .pm-top .pm-ok");
    await kp.waitForFunction(() => window.__sv.model.mode().kind === "none");
    const exited = await kp.evaluate(() => ({ hidden: document.querySelector("#mc-confirm").hidden, sketches: window.__sv.model.store.doc.features.filter(f => f.type === "sketch").length }));
    check(sc && exited.hidden && exited.sketches === 1, `✓ reach: a scrolled panel marks its title row; the panel ✓ exits the sketch and the corner goes (${sc}, ${JSON.stringify(exited)})`);
    // Assembly: the Explode panel's ✓/✕ are mirrored in the corner.
    await kp.evaluate(() => window.__sv.model.store.change("Plate", d => {
      const P = (id, x, y) => ({ id, t: "point", x, y }), Ln = (id, a, b) => ({ id, t: "line", a, b });
      d.features.push({ id: "s2", type: "sketch", name: "Sketch2", plane: { std: "XY" }, rels: [], dims: [], ents: [P("a", -20, -10), P("b", 20, -10), P("c", 20, 10), P("d", -20, 10), Ln("l1", "a", "b"), Ln("l2", "b", "c"), Ln("l3", "c", "d"), Ln("l4", "d", "a")] },
        { id: "x", type: "extrude", name: "Extrude1", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 } });
    }));
    await kp.waitForFunction(() => document.querySelector("#mc-busy").hidden && window.__sv.model.last(), null, { timeout: 120000 });
    await kp.click("#new-more"); await kp.click("#new-asm-part");
    await kp.waitForFunction(() => window.__sv.asm.doc?.components.length === 1 && document.querySelector("#app").classList.contains("asm"), null, { timeout: 120000 });
    const before = await kp.evaluate(() => !document.querySelector("#asm-confirm").hidden);
    await kp.click('#asm-tools [data-ac="explode"]');
    await kp.waitForFunction(() => !document.querySelector("#asm-confirm").hidden);
    const ac = await kp.evaluate(() => { const c = document.querySelector("#asm-confirm"), r = c.getBoundingClientRect(), vp = document.querySelector("#viewport").getBoundingClientRect(); return { top: Math.round(r.top - vp.top), cancel: !c.querySelector(".mc-cancel").hidden }; });
    await kp.click("#asm-confirm .mc-ok");
    await kp.waitForFunction(() => document.querySelector("#asm-pm").hidden || !document.querySelector("#asm-pm .pm-top"));
    const after = await kp.evaluate(() => document.querySelector("#asm-confirm").hidden);
    check(!before && ac.top <= 16 && ac.cancel && after, `✓ reach: the assembly corner shows only while a panel with ✓ is open, and its ✓ closes the panel (${before}, ${JSON.stringify(ac)}, ${after})`);
    await ctx.close();
  }

  // --- Drawings: a model view of another part configuration (FR-DRW-010) ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const st = (depth, w) => ({ nums: { "s1/dim/d1": { v: w }, "s1/dim/d2": { v: 60 }, "f1/depth": { v: depth } }, ints: {}, suppressed: [], vars: {}, material: null, ids: ["s1", "f1"] });
    const part = { schema: 1, kind: "part", id: "d_drwcfg", name: "Block", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [{ id: "r1", t: "horizontal", e: ["l1"] }, { id: "r2", t: "horizontal", e: ["l3"] }, { id: "r3", t: "vertical", e: ["l2"] }, { id: "r4", t: "vertical", e: ["l4"] }], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }],
        dims: [{ id: "d1", name: "D1", t: "hdistance", e: ["p1", "p2"], val: { v: 100 } }, { id: "d2", name: "D2", t: "vdistance", e: ["p2", "p3"], val: { v: 60 } }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    ], configs: [{ name: "Default", state: st(20, 100) }, { name: "Tall", state: st(50, 80) }], config: "Default" };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Block.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    const boxes = () => dp.evaluate(() => window.__sv.drw.doc().sheets[0].views.map(v => { const p = window.__sv.drw.placement(v.id); return { id: v.id, root: !v.parent, w: (p.box[2] - p.box[0]) / p.s, h: (p.box[3] - p.box[1]) / p.s, x: v.x, y: v.y, cfg: v.config ?? null }; }));
    const b0 = await boxes(), front = b0.find(v => v.root);
    const [fx, fy] = await dp.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [front.x, front.y]);
    await dp.mouse.click(fx, fy);
    await dp.waitForSelector('#drw .drw-props [data-v="cfg"]');
    const opts = await dp.evaluate(() => [...document.querySelectorAll('#drw .drw-props [data-v="cfg"] option')].map(o => o.textContent));
    await dp.selectOption('#drw .drw-props [data-v="cfg"]', "Tall");
    await dp.waitForTimeout(200);
    await ready();
    const b1 = await boxes(), f1 = b1.find(v => v.root), kids = b1.filter(v => !v.root);
    check(opts.join("|") === "Active (Default)|Default|Tall" && Math.abs(front.h - 20) < 0.6 && Math.abs(f1.h - 50) < 0.6 && Math.abs(f1.w - 80) < 0.6 && f1.cfg === "Tall"
      && kids.some(k => Math.abs(k.w - 80) < 0.6) && kids.some(k => Math.abs(k.h - 50) < 0.6),
      `drawing: a model view shows another configuration and its projected views follow (${JSON.stringify({ opts, before: b0, after: b1 })})`);
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    await dp.waitForTimeout(300);
    const ru = await dp.evaluate(() => [...document.querySelectorAll('#drw .drw-props [data-v="cfg"] option')][0]?.textContent);
    await dp.evaluate(() => document.querySelector("#lang-btn").click());
    check(ru === "Активная (Default)", `drawing: configuration list in Russian (${ru})`);
    await ctx.close();
  }

  // --- Drawings: flat pattern view of a sheet metal part, with bend lines and notes (FR-FT-120) ---
  if (inShard(4)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwflat", name: "Bracket", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", 0, 0), P("p2", 100, 0), P("p3", 100, 50), P("p4", 0, 50),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "b", type: "smbase", name: "Base-Flange1", sketch: "s1", thickness: { v: 2 }, radius: { v: 2 }, depth: { v: 20 }, k: 0.5 },
      { id: "f", type: "smflange", name: "Edge-Flange1", edges: [{ faces: ["b:p0:top", "b:p0:l1"] }], length: { v: 20 }, angle: { v: Math.PI / 2 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Bracket.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    const ready = () => dp.waitForFunction(() => window.__sv.drw.ready() && !document.querySelector(".drw.stale"), null, { timeout: 90000 });
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3, null, { timeout: 90000 });
    await ready();
    await dp.waitForFunction(() => { return !!document.querySelector('[data-pal="flat"] path[d^="M"]'); }, null, { timeout: 60000 });
    await dp.click('[data-pal="flat"]');
    await dp.waitForTimeout(500);
    const [sx, sy] = await dp.evaluate(() => window.__sv.drw.sheetPt(330, 90));
    await dp.mouse.click(sx, sy);
    await dp.waitForFunction(() => window.__sv.drw.doc().sheets[0].views.some(v => v.config === "@flat"), null, { timeout: 30000 });
    await dp.keyboard.press("Escape");
    await ready();
    const fv = await dp.evaluate(() => {
      const v = window.__sv.drw.doc().sheets[0].views.find(x => x.config === "@flat"), p = window.__sv.drw.placement(v.id);
      const notes = [...document.querySelectorAll(".drw-svg text")].map(t => t.textContent).filter(s => /^(UP|DOWN) /.test(s));
      return { orient: v.orient, w: (p.box[2] - p.box[0]) / p.s, h: (p.box[3] - p.box[1]) / p.s, notes, props: !!document.querySelector('#drw .drw-props [data-v="bendNotes"]') };
    });
    const flatLen = 50 - 4 + Math.PI / 2 * 3 + 16;
    check(fv.orient === "top" && Math.abs(fv.w - 100) < 0.6 && Math.abs(fv.h - flatLen) < 0.6 && fv.notes.length === 1 && /^(UP|DOWN) 90° R2$/.test(fv.notes[0]) && fv.props,
      `drawing: a sheet metal part's flat pattern view from the palette, with its bend line and note (${JSON.stringify({ fv, flatLen })})`);
    await ctx.close();
  }

  // --- Drawings: revision cloud ---
  if (inShard(3)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwcloud", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }], dims: [] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Plate.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3 && window.__sv.drw.ready(), null, { timeout: 90000 });
    const clickSheet = async (x, y) => { const [cx, cy] = await dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]); await dp.mouse.move(cx, cy); await dp.mouse.click(cx, cy); };
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="cloud"]');
    for (const [x, y] of [[30, 30], [90, 30], [90, 70], [30, 70], [30, 30]]) await clickSheet(x, y);
    await dp.waitForTimeout(150);
    const cl = await dp.evaluate(() => { const a = (window.__sv.drw.doc().sheets[0].annots ?? []).find(x => x.t === "cloud"); return { a: a && JSON.parse(JSON.stringify(a)), arcs: window.__sv.drw.prims().filter(p => p.t === "a" && p.layer === "ANNOT").length, mode: window.__sv.drw.mode(), panel: !!document.querySelector('#drw .drw-props [data-d="carc"]') }; });
    check(cl.a && cl.a.pts.length === 8 && cl.arcs === 10 + 7 + 10 + 7 && cl.mode === "none" && cl.panel, `drawing: revision cloud from four clicked corners, scallops of at most 6 mm (${JSON.stringify(cl)})`);
    await dp.fill('#drw .drw-props [data-d="carc"]', "20");
    await dp.press('#drw .drw-props [data-d="carc"]', "Enter");
    await dp.waitForTimeout(150);
    const arcs2 = await dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "a" && p.layer === "ANNOT").length);
    await clickSheet(60, 50);
    await dp.waitForTimeout(100);
    const inside = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-d="carc"]'));
    await clickSheet(60, 30);
    await dp.waitForTimeout(100);
    const edge = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-d="carc"]'));
    check(arcs2 === 3 + 2 + 3 + 2 && !inside && edge, `drawing: revision cloud arc size, picked on its outline only (${arcs2}, inside ${inside}, edge ${edge})`);
    await ctx.close();
  }

  // --- Drawings: centreline and centre mark ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwcline", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" },
        P("p5", 25, 0), { id: "c1", t: "circle", c: "p5", r: 8 }], dims: [] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Plate.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3 && window.__sv.drw.ready(), null, { timeout: 90000 });
    const clickSheet = async (x, y) => { const [cx, cy] = await dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]); await dp.mouse.move(cx, cy); await dp.mouse.click(cx, cy); };
    // View i's model box on the sheet (sheet mm): placement maps view axes u, v to x + (u - uc)·s, y + (v - vc)·s.
    const boxOf = i => dp.evaluate(k => { const v = window.__sv.drw.doc().sheets[0].views[k], p = window.__sv.drw.placement(v.id), S = (u, w) => [p.x + (u - p.uc) * p.s, p.y + (w - p.vc) * p.s]; return { id: v.id, box: [...S(p.box[0], p.box[1]), ...S(p.box[2], p.box[3])], s: p.s }; }, i);
    const centre = () => dp.evaluate(() => window.__sv.drw.prims().filter(p => p.t === "l" && p.layer === "CENTER").map(p => p.p.map(v => Math.round(v * 100) / 100)));
    const fr = await boxOf(0), c0 = await centre();
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="cline"]');
    const xq = fr.box[0] + (fr.box[2] - fr.box[0]) * 0.2;
    await clickSheet(xq, fr.box[3]); await clickSheet(xq, fr.box[1]);
    await dp.waitForTimeout(150);
    const c1 = await centre();
    const cl = await dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).filter(a => a.t === "cline").map(a => ({ k: a.k, n: a.refs.length })));
    const added = c1.filter(q => !c0.some(r => r.join() === q.join()));
    const midY = (fr.box[1] + fr.box[3]) / 2;
    const okLine = added.length === 1 && Math.abs(added[0][1] - midY) < 0.05 && Math.abs(added[0][3] - midY) < 0.05 && Math.abs(Math.min(added[0][0], added[0][2]) - (fr.box[0] - 2)) < 0.05 && Math.abs(Math.max(added[0][0], added[0][2]) - (fr.box[2] + 2)) < 0.05;
    check(cl.length === 1 && cl[0].k === "line" && okLine, `drawing: centreline halfway between two parallel edges, 2 mm past both ends (${JSON.stringify({ cl, added, box: fr.box })})`);
    await dp.keyboard.press("Escape");
    // Centre mark on the hole seen end-on in the top view: a cross 2 mm past the circle.
    const tp = await boxOf(1);
    const hc = await dp.evaluate(id => { const p = window.__sv.drw.placement(id); return [p.x + (25 - p.uc) * p.s, p.y + (0 - p.vc) * p.s]; }, tp.id);
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="cmark"]');
    await clickSheet(hc[0] + 8 * tp.s, hc[1]);
    await dp.waitForTimeout(150);
    const c2 = await centre(), marks = await dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).filter(a => a.t === "cline" && a.k === "mark").length);
    const cross = c2.length - c1.length;
    check(marks === 1 && cross === 2, `drawing: centre mark on a hole seen end-on (${JSON.stringify({ marks, cross, hc })})`);
    await dp.keyboard.press("Escape");
    // Select the centreline on its line, set the extension to 5 mm.
    await clickSheet(fr.box[0] + 1, midY);
    await dp.waitForTimeout(100);
    const sel = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-d="cext"]'));
    if (sel) { await dp.fill('#drw .drw-props [data-d="cext"]', "5"); await dp.press('#drw .drw-props [data-d="cext"]', "Enter"); await dp.waitForTimeout(150); }
    const ext = await dp.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).find(a => a.t === "cline" && a.k === "line")?.ext);
    const c3 = await centre();
    const longer = c3.some(q => Math.abs(q[1] - midY) < 0.05 && Math.abs(Math.min(q[0], q[2]) - (fr.box[0] - 5)) < 0.05);
    check(sel && ext === 5 && longer, `drawing: select a centreline on its line and change its extension (${JSON.stringify({ sel, ext, longer })})`);
    await ctx.close();
  }

  // --- Drawings: weld symbol ---
  if (inShard(1)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await ctx.newPage();
    dp.on("pageerror", e => errors.push(e.message));
    dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
    await dp.goto(`${origin}/index.html?debug`);
    await dp.waitForFunction(() => window.__sv);
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const part = { schema: 1, kind: "part", id: "d_drwweld", name: "Plate", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], ents: [P("p1", -50, -30), P("p2", 50, -30), P("p3", 50, 30), P("p4", -50, 30),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }], dims: [] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    ] };
    const manifest = { format: "mobiuscad", schema: 1, kind: "part", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    await dp.setInputFiles("#file-input", { name: "Plate.mcadprt", mimeType: "application/zip", buffer: zip(Object.entries({ "manifest.json": JSON.stringify(manifest), "document.json": JSON.stringify(part) })) });
    await dp.waitForFunction(() => window.__sv.viewer.parts.length > 0, null, { timeout: 60000 });
    await dp.click("#new-more"); await dp.click("#new-drawing");
    await dp.waitForFunction(() => window.__sv.drw.doc()?.sheets[0].views.length === 3 && window.__sv.drw.ready(), null, { timeout: 90000 });
    const clickSheet = async (x, y) => { const [cx, cy] = await dp.evaluate(([a, b]) => window.__sv.drw.sheetPt(a, b), [x, y]); await dp.mouse.move(cx, cy); await dp.mouse.click(cx, cy); };
    const fr = await dp.evaluate(() => { const v = window.__sv.drw.doc().sheets[0].views[0], p = window.__sv.drw.placement(v.id), S = (u, w) => [p.x + (u - p.uc) * p.s, p.y + (w - p.vc) * p.s]; return [...S(p.box[0], p.box[1]), ...S(p.box[2], p.box[3])]; });
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="weld"]');
    const ex = fr[0] + (fr[2] - fr[0]) * 0.3;
    await clickSheet(ex, fr[3]);
    await clickSheet(ex + 15, fr[3] + 15);
    await dp.waitForTimeout(150);
    const prims = () => dp.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "ANNOT"));
    const w1 = await dp.evaluate(() => { const a = (window.__sv.drw.doc().sheets[0].annots ?? []).find(x => x.t === "weld"); return a && JSON.parse(JSON.stringify(a)); });
    const p1 = await prims();
    const tri = p1.filter(p => p.t === "p" && p.closed && !p.fill).length, a4 = p1.some(p => p.t === "t" && p.s === "a4");
    const panel = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-d="wosym"]'));
    check(w1 && w1.leader && w1.arrow?.sym === "fillet" && tri >= 1 && a4 && panel, `drawing: weld symbol with an arrow to the clicked joint, fillet a4 on the arrow side (${JSON.stringify({ w1, tri, a4, panel })})`);
    await dp.selectOption('#drw .drw-props [data-d="wosym"]', "v");
    await dp.waitForTimeout(150);
    await dp.check('#drw .drw-props [data-d="waround"]');
    await dp.waitForTimeout(150);
    const p2 = await prims(), w2 = await dp.evaluate(() => { const a = (window.__sv.drw.doc().sheets[0].annots ?? []).find(x => x.t === "weld"); return a && JSON.parse(JSON.stringify(a)); });
    const dash = p2.filter(p => p.t === "l" && p.pen === "hidden").length, ring = p2.some(p => p.t === "a" && Math.abs(p.r - 1.5) < 1e-9);
    const ru = await dp.evaluate(() => document.querySelector('#drw .drw-props [data-d="wosym"]')?.closest("fieldset")?.querySelector("legend")?.textContent);
    check(w2.other?.sym === "v" && w2.around === true && dash === 1 && ring, `drawing: other-side V adds the dashed identification line; all around draws the circle (${JSON.stringify({ other: w2.other, dash, ring, ru })})`);
    // Datum target (ISO 5459): click a point on the bottom edge, place the frame below; then make it a hatched area.
    await dp.keyboard.press("Escape");
    await dp.click('#drw [data-a="annot"]'); await dp.click('#drw [data-an="dtarget"]');
    const tx = fr[0] + (fr[2] - fr[0]) * 0.6;
    await clickSheet(tx, fr[1]);
    await clickSheet(tx - 12, fr[1] - 14);
    await dp.waitForTimeout(150);
    const dt = () => dp.evaluate(() => { const a = (window.__sv.drw.doc().sheets[0].annots ?? []).find(x => x.t === "dtarget"); return a && JSON.parse(JSON.stringify(a)); });
    const d1 = await dt(), q1 = await prims();
    const cross = q1.filter(p => p.t === "l" && p.pen === "thick").length, lab = q1.some(p => p.t === "t" && p.s === "A1");
    const dpanel = await dp.evaluate(() => !!document.querySelector('#drw .drw-props [data-d="dtkind"]'));
    check(d1 && d1.leader && d1.tp && d1.label === "A1" && d1.kind === "point" && cross === 2 && lab && dpanel, `drawing: datum target A1 on the clicked point of an edge, with its cross (${JSON.stringify({ d1, cross, lab, dpanel })})`);
    if (dpanel) { await dp.selectOption('#drw .drw-props [data-d="dtkind"]', "area"); await dp.waitForTimeout(150); }
    const d2 = await dt(), q2 = await prims();
    const area = q2.some(p => p.t === "a" && p.pen === "phantom"), sz = q2.some(p => p.t === "t" && p.s === "Ø8");
    check(d2?.kind === "area" && d2.size === "Ø8" && area && sz, `drawing: datum target area: phantom circle, hatching and its size in the frame (${JSON.stringify({ d2, area, sz })})`);
    await ctx.close();
  }

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);

  // --- Parallel assembly builds (FR-ARC-016): distinct parts are built by helper kernel workers, same result as one worker ---
  if (inShard(4)) {
    const P = (id, x, y) => ({ id, t: "point", x, y });
    const plate = (id, w, h, d, holes) => ({ schema: 1, kind: "part", id, name: id, units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [
      { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [P("p1", -w / 2, -h / 2), P("p2", w / 2, -h / 2), P("p3", w / 2, h / 2), P("p4", -w / 2, h / 2),
        { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] },
      { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: d } },
      ...(holes ? [{ id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "f1:end" } }, rels: [], dims: [], ents: [P("c0", 0, 0), { id: "c1", t: "circle", c: "c0", r: holes }] },
        { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }] : [])] });
    const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
    const parts = {}, components = [];
    for (let k = 0; k < 5; k++) {
      parts[`p${k}`] = { name: `Part${k}`, file: `Part${k}.mcadprt`, doc: plate(`part${k}`, 40 + 10 * k, 30, 5 + k, k % 2 ? 4 + k : 0) };
      components.push({ id: `c${k}`, name: `Part${k}<1>`, part: `p${k}`, tf: T(0, 0, 20 * k), fixed: k === 0 });
    }
    components.push({ id: "c9", name: "Part3<2>", part: "p3", tf: [0, -1, 0, 100, 1, 0, 0, 0, 0, 0, 1, 0] });
    const asmDoc = { schema: 1, kind: "assembly", id: "a_par", name: "Parallel", units: { length: "mm", decimals: 2 }, parts, components };
    const amf = { format: "mobiuscad", schema: 1, kind: "assembly", app: "smoke", modified: "2026-11-08T00:00:00Z", units: "mm" };
    const ab = [...zip(Object.entries({ "manifest.json": JSON.stringify(amf), "document.json": JSON.stringify(asmDoc) }))];
    const build = async workers => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const dp = await ctx.newPage();
      dp.on("pageerror", e => errors.push(e.message));
      dp.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
      await dp.addInitScript(() => { try { localStorage.setItem("sv:tips", "off"); } catch {} });
      await dp.goto(`${origin}/index.html?debug&nokernel&workers=${workers}`);
      await dp.waitForFunction(() => window.__sv);
      await dp.evaluate(b => window.__sv.asm.openFile({ name: "Parallel.mcadasm", data: new Uint8Array(b).buffer }), ab);
      await dp.waitForFunction(() => window.__sv.viewer.parts.length === 6 && !window.__sv.asm.building, null, { timeout: 120000 });
      const r = await dp.evaluate(() => ({
        par: window.__sv.asm.kernel.lastParallel,
        props: window.__sv.asm.props,
        parts: window.__sv.viewer.parts.map(p => [p.data.name, p.data.faces.length, p.data.faces.filter(f => f.type === "cylinder").length, Math.round(p.data.volume * 1000), p.data.faces.map(f => Math.round(f.area * 100)).join(",")]),
      }));
      await ctx.close();
      return r;
    };
    const one = await build(0), many = await build(2);
    check(!one.par && many.par?.parts === 5 && many.par.workers === 3, `parallel build: 5 parts on 3 kernel workers (${JSON.stringify(many.par)}), none with ?workers=0 (${JSON.stringify(one.par)})`);
    check(JSON.stringify(one.parts) === JSON.stringify(many.parts), `parallel build: every component has the same faces, cylinders, volume and face areas as on one worker (${JSON.stringify(many.parts)} vs ${JSON.stringify(one.parts)})`);
    check(Math.abs(one.props.volume - many.props.volume) < 1e-6 * one.props.volume && one.props.bodies === many.props.bodies, `parallel build: assembly mass properties match (${many.props.volume} vs ${one.props.volume})`);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(`${shardN > 1 ? `\nshard ${shardI}/${shardN}: ` : "\n"}${failures ? `${failures} check(s) failed` : "all checks passed"} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failures ? 1 : 0);
