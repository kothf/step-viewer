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
    annotations.root.traverse(o => { if (o.userData.axis) axes.push(o.userData.axis); });
    const val = () => document.querySelector("#readout .val").textContent.trim();
    const mm = val();
    setUnits("ft"); const ft = val();
    setDecimals("2"); const ft2 = val();
    setUnits("mm"); setDecimals("");
    document.querySelector("#readout .val .cp").click();
    const copied = state.lastCopied;
    const box = document.querySelector("#readout");
    const floating = box.classList.contains("floating") && box.style.left !== "";
    box.querySelector(".dock").click();
    const docked = !box.classList.contains("floating") && box.style.left === "";
    box.querySelector(".dock").click();
    const parts = state.live.data.parts;
    document.querySelector("#readout .acts button").click(); // Pin
    return { title: state.measurements.at(-1)?.data.title, triad: state.measurements.at(-1)?.data.triad, axes, mm, ft, ft2, copied, floating, docked, parts };
  });
  check(hud.title === "Distance" && hud.triad === 1 && hud.axes.length === 1, `smart: point to point draws the axis legs (${hud.axes.join(",")})`);
  check(hud.mm === "10.000 mm" && hud.ft === "0.03281 ft" && hud.ft2 === "0.03 ft", `readout units and decimals: ${hud.mm} / ${hud.ft} / ${hud.ft2}`);
  check(hud.copied === "10.000", `click copies the bare value (${hud.copied})`);
  check(hud.floating && hud.docked, `readout floats beside the measurement and docks back (${hud.floating}, ${hud.docked})`);
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
      res.toggle = document.querySelectorAll("#readout [data-cmode]").length;
      return res;
    }
    return { rounds: rounds.length };
  });
  check(pitch.title === "Pitch (axis to axis)" && near(pitch.value, pitch.expect, 1e-3) && pitch.value > 0,
    `smart: coplanar round faces give the pitch (${pitch.rounds} round faces, ${pitch.value} vs ${pitch.expect})`);
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
