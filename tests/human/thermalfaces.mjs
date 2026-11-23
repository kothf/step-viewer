// Thermal map on the model's own faces, by hand (FRS-thermal FR-TMAP-002): Colour the model's faces in the legend
// colours the STEP's own triangles from the nearest point of the package, so a section through the board still
// shows the map; hover keeps reading temperatures, isolation and the isotherm clip still work.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalfaces");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => window.__sv.thermal.state());
// a point of the view where the map is: scan a coarse grid of the canvas for a temperature
const found = async () => pg.evaluate(() => { const r = window.__sv.viewer.renderer.domElement.getBoundingClientRect(), x0 = r.left, y0 = r.top, w = r.width, h = r.height; for (let j = 1; j < 12; j++) for (let i = 1; i < 12; i++) { const x = x0 + w * i / 12, y = y0 + h * j / 12, v = window.__sv.thermal.valueAt(x, y); if (v) return { x, y, t: v.t }; } return null; });
const before = await found();

// TC-1: tick Colour the model's faces.
await pg.click('#th-legend input[data-k="faces"]');
await idle(pg);
await pg.waitForTimeout(500);
const s1 = await st();
check("TC-1", s1.faces && s1.faceMeshes > 0 && s1.faceTris > 0,
  "Colour the model's faces: the STEP's own faces now carry the map's colours (same picture, the model's tessellation)", { meshes: s1.faceMeshes, tris: s1.faceTris }, await snap(pg, "faces"));

// TC-2: hover still reads the temperature at the same place.
const hv = before ? await pg.evaluate(([x, y]) => window.__sv.thermal.valueAt(x, y), [before.x, before.y]) : null;
if (before) await pg.mouse.move(before.x, before.y);
await pg.waitForTimeout(300);
check("TC-2", !!before && !!hv && Math.abs(hv.t - before.t) < 1e-6,
  "the hover card still gives the temperature under the pointer", { before, hv }, await snap(pg, "hover"));

// TC-3: a section through the model: the cut model faces stay coloured.
await pg.click("#rt-section");
if (!(await pg.locator('[data-sec="x"]').isVisible())) await pg.click("#sec-add");
await pg.click('[data-sec="x"]');
await idle(pg);
await pg.waitForTimeout(800);
const s3 = await st();
const planes = await pg.evaluate(() => { let n = -1; window.__sv.viewer.modelRoot.traverse(o => { if (o.userData.thermalFaces) n = o.material.clippingPlanes?.length ?? 0; }); return n; });
check("TC-3", s3.faceMeshes > 0 && planes > 0 && !pg.errors.length,
  "a section plane (YZ) cuts the coloured model faces like the model itself", { meshes: s3.faceMeshes, planes }, await snap(pg, "section"));
await pg.click("#sec-clear");
await idle(pg);

// TC-4: isotherm clip at 100 °C ghosts the cooler model triangles.
await pg.click('#th-legend input[data-k="clip"]');
await pg.fill('#th-legend input[data-k="clipval"]', "100");
await pg.press('#th-legend input[data-k="clipval"]', "Enter");
await idle(pg);
await pg.waitForTimeout(500);
const s4 = await st();
check("TC-4", s4.faceFaded > 0 && s4.faceTris > 0 && s4.faceTris + s4.faceFaded === s1.faceTris,
  "Clip at a temperature, 100 °C: only the model faces reaching 100 °C stay in colour, the rest see-through", { tris: s4.faceTris, faded: s4.faceFaded }, await snap(pg, "faces-clip"));

// TC-5: untick both: the package surface is back.
await pg.click('#th-legend input[data-k="clip"]');
await pg.click('#th-legend input[data-k="faces"]');
await idle(pg);
const s5 = await st();
check("TC-5", !s5.faces && s5.faceMeshes === 0 && s5.drawn && !pg.errors.length,
  "unticking Colour the model's faces draws the package's own surfaces again", { faces: s5.faces, meshes: s5.faceMeshes, errors: pg.errors }, await snap(pg, "package"));
await finish(browser, pg);
