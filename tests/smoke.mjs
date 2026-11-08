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

  // --- header tools: every measuring tool and right-panel page is on screen at every width, no scrolling;
  //     one header row from 1366 px up, a second row only on narrower windows ---
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const inView = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth + 0.5 && b.top >= 0 && b.bottom <= innerHeight; };
      const tb = document.querySelector(".topbar");
      const btns = [...document.querySelectorAll("#tools button, #rp-tabs [role=tab]")];
      return {
        n: btns.length, off: btns.filter(b => !inView(b)).map(b => b.dataset.tool ?? b.dataset.tab),
        named: btns.every(b => b.textContent.trim().length > 1 && b.title),
        over: tb.scrollWidth - tb.clientWidth, page: document.documentElement.scrollWidth - innerWidth,
        rows: tb.classList.contains("tb-wrap") ? 2 : 1, h: Math.round(tb.getBoundingClientRect().height),
      };
    });
    check(r.n === 17 && r.off.length === 0 && r.named && r.over <= 1 && r.page <= 0 && (w < 1366 || (r.rows === 1 && r.h <= 48)), `header tools ${w}px: 12 tools + 5 panel pages on screen, no scrolling${w >= 1366 ? ", one row" : ""} (${JSON.stringify(r)})`);
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
  // Clicking the open page hides the panel; another page brings it back. A new section plane shows the Section page.
  await page.click("#rt-props");
  const hiddenPanel = await page.evaluate(() => document.querySelector("#app").classList.contains("no-right"));
  await page.click("#rt-mass");
  const shownPanel = await page.evaluate(() => !document.querySelector("#app").classList.contains("no-right"));
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
  check(hiddenPanel && shownPanel && secShown && pressed.join() === "radius", `tool strip: open page toggles the panel, a new plane shows Section, aria-pressed on the active tool (${JSON.stringify({ hiddenPanel, shownPanel, secShown, pressed })})`);
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
    await mp.waitForSelector("#mc-bar:not([hidden])");
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
    check(undone.dims.join() === "100,50" && redone.dims.join() === "100,60" && redone.dof === 0, `model sketch: Ctrl+Z / Ctrl+Y step the dimension value back and forth (${undone.dims} → ${redone.dims})`);
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
    check(prev.tris > 10 && /Radius: 2 mm/.test(prev.callout ?? "") && prev.groups === "Fillet type|Items to fillet|Fillet parameters|Fillet options" && prev.items === 3, `model: the fillet previews live (yellow faces) while edges are picked, with a radius callout (${JSON.stringify(prev)})`);
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
    await mp.click('#mc-tools [data-fly="save"]');
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
    await mp.click('#mc-tools [data-fly="save"]');
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
      const OK = /^(MöbiusCAD|STEP|DXF|XY|YZ|XZ|Ctrl|Esc|Enter|Shift|Del|Delete|mcadprt|mm|DOF|D\d+|Part\d+|Base|S|L|R|C|A|P|D|Q|Y|Z|H|V|T|M)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      for (const root of document.querySelectorAll("#tab-features, #mc-bar, #mc-confirm, #sk-layer, #t-features")) {
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
      const OK = /^(MöbiusCAD|STEP|DXF|XY|YZ|XZ|Ctrl|Esc|Enter|Shift|Del|Delete|mcadprt|mm|DOF|D\d+|Part\d+|Base|Hex|body|S|L|R|C|A|P|D|Q|Y|Z|H|V|T|M|g|cm|Ti|Al|ABS|PLA|PA6|POM|Delrin|PEEK)$/;
      const skip = e => !e || e.closest('[translate="no"], script, style, [hidden]') || getComputedStyle(e).display === "none";
      const bad = new Set();
      const test = (s, where) => { if (s.split(/[^A-Za-zö0-9]+/).map(w => w.replace(/^\d+/, "")).some(w => /[A-Za-z]{2,}/.test(w) && !OK.test(w))) bad.add(`${where}: ${s.trim().slice(0, 60)}`); };
      for (const root of document.querySelectorAll("#tab-features, #mc-bar, #mc-confirm, #sk-layer, #mc-layer, #mc-menu, #t-features")) {
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
    check(refMenu.join("|") === "Plane|Axis|Point|Coordinate system" && ax.type === "axis" && ax.n?.join(",") === "0,1,0" && ax.row, `model 1.21: Axis from two planes, from the Plane ▾ flyout (${refMenu.join("|")}, ${JSON.stringify(ax)})`);
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
    const filterOff = await mp.evaluate(() => !document.querySelector("#mc-filter") && [...document.querySelectorAll("#mc-tools [data-c=filter]")].every(b => !b.classList.contains("on")));
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
    check(patMenu === "Linear pattern|Circular pattern|Mirror" && Math.abs(vLp - (120000 - 4 * hole)) < 1 && stLp === "lpattern:ok", `model 1.23: linear pattern of a hole along a picked edge, 4 × 20 mm (${patMenu}, ${Math.round(vLp)}, ${stLp})`);
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
    const shellFaces = await mp.evaluate(() => document.querySelector("#mc-pm .pm-count")?.textContent);
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
    await mp.click("#mc-menu button:nth-child(3)");
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
    check(elFly === "Circle|3-point circle|Ellipse|Partial ellipse" && el && near(el.r1, 30, 0.01) && near(el.r2, 12, 0.01) && el.st === "ok" && el.dof === 3 && near(vEl, Math.PI * 30 * 12 * 5, 0.5) && cut.ok && near(vEl - cut.v, half, 1), `model 1.34: ellipse and partial ellipse tools, extruded and cut (${elFly}, ${JSON.stringify(el)}, ${vEl.toFixed(1)}, ${(vEl - cut.v).toFixed(1)} ≈ ${half.toFixed(1)}, ${cut.ok})`);
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
    check(lnFly === "Line|Spline" && spl?.n === 4 && spl.closed && spl.dof === 8 && cut3.ok && dSpl > 42 * 5 && dSpl < 42 * 5 * 1.7, `model 1.35: a closed spline through four clicks, cut through the part (${lnFly}, ${JSON.stringify(spl)}, ${cut3.ok}, ${dSpl.toFixed(1)})`);
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
    const items = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(1)");
    const nLoop = await mp.evaluate(() => window.__sv.model.mode().draft.edges.length);
    await idle();
    await mp.waitForTimeout(300);
    // Right-click a hole's top edge: the same-radius helper adds the other hole's circles too (4 in all).
    // The view may still be easing: wait for the camera to settle before aiming.
    await mp.waitForFunction(() => { const p = window.__sv.viewer.camera.position.toArray().join(); const same = window.__camLast === p; window.__camLast = p; return same; }, null, { polling: 250, timeout: 10000 });
    // A point on the rim away from vertices and quadrant points (those snap as points, not the edge).
    const [hx, hy] = await world([-10 + 5 * Math.cos(-1.1), 5 * Math.sin(-1.1), 20]);
    await mp.mouse.click(hx, hy, { button: "right" });
    const items2 = await mp.evaluate(() => [...document.querySelectorAll("#mc-menu button")].map(b => b.textContent).join("|"));
    await mp.click("#mc-menu button:nth-child(3)");
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
      const OK = /^(MöbiusCAD|ISO|ANSI|Y14|PDF|SVG|DXF|Ctrl|Esc|Delete|mcaddrw|mm|kg|F|A\d|B|C|D|E|S|Z|Y|P)$/;
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
    await dp.click('#drw [data-a="detail"]');
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
    // DXF has the hatch on its own layer; Russian labels; a saved drawing keeps the views.
    await dp.click('#drw [data-a="export"]');
    const [dl] = await Promise.all([dp.waitForEvent("download"), dp.click('#drw [data-x="dxf"]')]);
    const dxfT = (await readFile(await dl.path())).toString();
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
    const swState = await pg.evaluate(async () => { const ks = (await caches.keys()).filter(k => k.startsWith("mobiuscad-")); const c = ks.length ? await caches.open(ks[0]) : null; const urls = c ? (await c.keys()).map(r => new URL(r.url).pathname) : []; return { caches: ks.length, n: urls.length, index: urls.includes("/index.html"), occt: urls.some(u => u.endsWith("occt-import-js.wasm")), full: urls.some(u => u.endsWith("opencascade.full.wasm")), ctl: !!navigator.serviceWorker.controller }; });
    await ctx.setOffline(true);
    let offVer = "";
    try { await pg.reload({ timeout: 20000 }); await pg.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector("#app-version")?.textContent ?? ""), null, { timeout: 20000 }); offVer = await pg.evaluate(() => document.querySelector("#app-version").textContent); } catch (e) { offVer = String(e).slice(0, 80); }
    await ctx.setOffline(false);
    check(swState.caches === 1 && swState.index && swState.occt && !swState.full && swState.n > 10 && swState.ctl && /^v\d/.test(offVer), `1.47: service worker precaches the app and it starts offline (${JSON.stringify(swState)}, ${offVer})`);
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.click('#mc-menu button:has-text("Rib")');
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.click('#mc-menu button:has-text("Split Line")');
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
    const menu = async label => { await mp.click('#mc-tools [data-fly="sweep"]'); await mp.locator("#mc-menu button", { hasText: new RegExp(`^${label}$`) }).click(); await settle(); };
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.locator("#mc-menu button", { hasText: /^Scale$/ }).click();
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
    // New assembly closes the part; the Assembly tab and bar take over.
    await mp.click("#new-more");
    await mp.click("#new-asm");
    await mp.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
    const swap = await mp.evaluate(() => ({ model: document.querySelector("#app").classList.contains("model"), tab: document.querySelector("#t-asm").getAttribute("aria-selected"), bar: !document.querySelector("#asm-bar").hidden }));
    const shown = n => mp.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 120000 });
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), part);
    await shown(1);
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "plate.mcadprt")), part);
    await shown(2);
    const cube = [...(await readFile(join(fixtures, "cube-10x10mm", "Cube 10x10.stp")))];
    await mp.evaluate(b => window.__sv.asm.insertComponent(new File([new Uint8Array(b)], "Cube 10x10.stp")), cube);
    await shown(3);
    const a0 = await mp.evaluate(() => ({ rows: [...document.querySelectorAll("#asm-tree .ft-comp .ft-name")].map(e => e.textContent), keys: Object.keys(window.__sv.asm.doc.parts).length, v: window.__sv.asm.props?.volume, status: document.querySelector("#asm-status").textContent }));
    // Move the second plate by typing its pose: X = 100, 90° about Z.
    await mp.click("#asm-tree .ft-comp >> nth=1");
    await mp.click('#asm-tools [data-ac="move"]');
    await mp.fill('#asm-pm input[data-pose="x"]', "100");
    await mp.fill('#asm-pm input[data-pose="rz"]', "90");
    await mp.press('#asm-pm input[data-pose="rz"]', "Enter");
    await shown(3);
    const mv = await mp.evaluate(() => { const c = window.__sv.asm.doc.components[1], d = window.__sv.viewer.parts[1].data; return { tf: c.tf.map(v => Math.round(v * 1e6) / 1e6), min: d.bboxMin.map(v => Math.round(v * 1e3) / 1e3), max: d.bboxMax.map(v => Math.round(v * 1e3) / 1e3), pm: document.querySelector("#asm-pm").hidden }; });
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
    check(!swap.model && swap.tab === "true" && swap.bar && a0.rows.join() === "(f) plate<1>,(-) plate<2>,(-) Cube 10x10<1>" && a0.keys === 2 && Math.abs(a0.v - 17000) < 1 && a0.status === "3 components · Under defined"
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
      && bom.open && bom.cells.join("|") === "1|box|BX-10||Aluminium 6061|2|0.0027" && bom.csv.split("\r\n")[1] === "1,box,BX-10,,Aluminium 6061,2,0.002700"
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.locator("#mc-menu button", { hasText: /^Move Face$/ }).click();
    await mp.evaluate(() => { const m = window.__sv.model; m.mode().draft.faces = [{ name: "f1:end" }]; m.panel(); void m.rebuild(); });
    await settle();
    const pv = await mp.evaluate(() => ({ title: document.querySelector("#mc-pm h3")?.textContent, count: document.querySelector("#mc-pm .pm-count")?.textContent, v: window.__sv.model.last().props.volume }));
    await mp.fill('#mc-pm input[data-num="distance"]', "5");
    await mp.press('#mc-pm input[data-num="distance"]', "Enter");
    await settle();
    const mv = await mp.evaluate(() => ({ v: window.__sv.model.last().props.volume, bad: window.__sv.model.last().statuses.filter(s => !s.ok).length, f: window.__sv.model.store.doc.features.map(f => f.name).join(",") }));
    // Delete Face: the pocket's floor and walls go, and the top closes over it.
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.locator("#mc-menu button", { hasText: /^Delete Face$/ }).click();
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.click('#mc-menu button:has-text("Helix/Spiral")');
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.click('#mc-menu button:has-text("Sweep")');
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
    await mp.click('#mc-tools [data-fly="sweep"]');
    await mp.click('#mc-menu button:has-text("Loft")');
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

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(`${shardN > 1 ? `\nshard ${shardI}/${shardN}: ` : "\n"}${failures ? `${failures} check(s) failed` : "all checks passed"} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failures ? 1 : 0);
