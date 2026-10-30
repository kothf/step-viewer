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
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve(process.argv[2] || "dist/step-viewer");
const fixtures = resolve("node_modules/occt-import-js/test/testfiles");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
  const cube = await page.evaluate(() => {
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
  check(/Mass\s*7\.850 g/.test(cube.mass), "steel cube mass 7.850 g");

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
      return { rounds: rounds.length, title: state.live.data.title, value: state.live.value, expect: a.c.distanceTo(b.c) };
    }
    return { rounds: rounds.length };
  });
  check(pitch.title === "Pitch (axis to axis)" && near(pitch.value, pitch.expect, 1e-3) && pitch.value > 0,
    `smart: coplanar round faces give the pitch (${pitch.rounds} round faces, ${pitch.value} vs ${pitch.expect})`);

  // explode moves parts apart
  await page.$eval("#explode", el => { el.value = "1"; el.dispatchEvent(new Event("input")); });
  const moved = await page.evaluate(() => window.__sv.viewer.parts.filter(p => p.group.position.length() > 1e-6).length);
  check(moved > 0, `explode moved ${moved} parts`);

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
