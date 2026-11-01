#!/usr/bin/env node
/**
 * End-to-end smoke test of a built viewer in headless Chromium.
 *
 *   node tests/smoke.mjs dist/step-viewer
 *
 * Opens public CAX-IF / sample STEP files that ship with occt-import-js
 * (node_modules/occt-import-js/test/testfiles) and checks parsing, topology,
 * measurements, sections, mass properties and the tree.
 * Set CHROMIUM_PATH to use a specific browser binary.
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

async function open(file) {
  await page.goto(`${origin}/index.html?debug&url=${encodeURIComponent(`/fixtures/${file}`)}`);
  await page.waitForFunction(() => window.__sv?.viewer.parts.length > 0 && document.querySelector("#loading").hidden, null, { timeout: 60000 });
}

try {
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
    return { one, par, ang, cleared: state.live === null, version: document.querySelector("#app-version").textContent };
  });
  check(smart.one[0] === "Planar face" && near(smart.one[1], 100, 1e-6), `smart: one face gives its area (${smart.one})`);
  check(smart.par[0] === "Parallel faces" && near(smart.par[1], 10, 1e-9), `smart: opposite faces 10 mm apart (${smart.par})`);
  check(smart.ang[0] === "Angle" && near(smart.ang[1], Math.PI / 2, 1e-9), `smart: adjacent faces at 90° (${smart.ang})`);
  check(smart.cleared, "smart: clicking empty space clears the result");
  check(/^v\d+\.\d+\.\d+$/.test(smart.version), `version shown under the name (${smart.version})`);

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
      const OK = /^(MöbiusCAD|STEP|IGES|BREP|Gerber|Excellon|PCB|PNG|SVG|CSV|JSON|PDF|STL|OBJ|glTF|GLB|HLR|AO|EN|RU|mm|cm|in|ft|mil|fps|PTH|NPTH|ANSI31|XY|YZ|XZ|Ctrl|Alt|Esc|Shift|Enter|Tab|Del|Backspace|macOS|OpenCASCADE|occt|import|js|WebAssembly|RS|X2|AP\d+|rep|B|size|vol|zip|F1|SMD|PMI|GD|T|ComponentPad|SMDPad|ViaPad|GND|ambient|occlusion|Delrin|ABS|PLA|PEEK|POM|PA6|Ti|Al|V|D\d+|J\d+)$/;
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
    check(help.title === "Справка" && help.tabs.length === 6 && help.tabs.includes("Клавиши") && help.kbd > 10 && keysShown && help.tips, `i18n: Help in Russian with sections and shortcuts (${JSON.stringify(help)})`);
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

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
