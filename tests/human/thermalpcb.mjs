// Thermal overlay in the PCB view (FRS-thermal FR-TMAP-040): the package's board-face temperatures under the 2D
// Gerber layers at 50 %, with a colour scale, the temperature under the pointer and the bottom face in Bottom view.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalpcb");
const fx = resolve("tests/fixtures/thermal"), gdir = resolve(fx, "amp-gerber");
const gfiles = ["amp-F_Cu.gbr", "amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-PTH.drl"].map(f => resolve(gdir, f));
const st = () => pg.evaluate(() => window.__sv.pcbThermal.state());

// TS-1: the Gerber set opens in the PCB view; no package yet, so no Thermal button.
await openFiles(pg, gfiles);
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("gerber") && window.__sv.gerber.layers.length >= 3, null, { timeout: 60000 });
await pg.waitForTimeout(500);
const btnHidden = await pg.evaluate(() => document.querySelector("[data-gview=thermal]").hidden);
check("TS-1", btnHidden, "the PCB view opens the board's Gerber set; with no thermal package the Thermal button stays hidden", { btnHidden }, await snap(pg, "pcb"));

// TS-2: File ▸ Add thermal map… in the PCB view: the temperatures go under the layers.
await pg.click("#file-btn");
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="thermal-map"]')]);
await fc.setFiles([resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.pcbThermal.state().on, null, { timeout: 60000 });
await pg.waitForTimeout(600);
const s2 = await st();
const legend2 = await pg.evaluate(() => document.querySelector("#g-th-legend").textContent);
check("TS-2", s2.on && s2.legend && s2.cells.top > 1000 && /Board top/.test(legend2) && s2.max > s2.min, "Add thermal map… in the PCB view draws the board's top-face temperatures under the layers with a colour scale", { ...s2, legend2 }, await snap(pg, "overlay-top"));

// TS-3: the pointer over the board reads the temperature drawn there.
const box = await pg.evaluate(() => { const b = window.__sv.gerber.boardBox(false); const c = window.__sv.gerber.toScreen((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); const r = document.querySelector("#g-overlay").getBoundingClientRect(); return [r.left + c[0], r.top + c[1]]; });
await pg.mouse.move(box[0] - 40, box[1] - 20);
await pg.mouse.move(box[0], box[1], { steps: 4 });
await pg.waitForTimeout(300);
const at = await pg.evaluate(() => document.querySelector('#g-th-legend [data-v=at]')?.textContent ?? "");
check("TS-3", /\d+(\.\d)? °C/.test(at), "hovering the board shows the temperature under the pointer in the legend", { at }, await snap(pg, "hover"));

// TS-4: Bottom view shows the bottom face's temperatures, mirrored like the bottom layers.
await pg.click("[data-gview=flip]");
await pg.waitForTimeout(500);
const legend4 = await pg.evaluate(() => document.querySelector("#g-th-legend").textContent);
const s4 = await st();
check("TS-4", /Board bottom/.test(legend4) && s4.cells.bottom > 1000, "Bottom view shows the board's bottom-face temperatures", { legend4, cells: s4.cells }, await snap(pg, "overlay-bottom"));
await pg.click("[data-gview=flip]");

// TS-5: the Thermal button turns the overlay off and on.
await pg.click("[data-gview=thermal]");
await pg.waitForTimeout(300);
const off = await st();
await pg.click("[data-gview=thermal]");
await pg.waitForTimeout(300);
const on = await st();
check("TS-5", !off.on && !off.legend && on.on && on.legend, "the PCB view's Thermal button hides and shows the overlay", { off: off.on, on: on.on }, await snap(pg, "toggle"));

// TS-6: from the 3D map with the Gerber set under it, PCB view opens the set with the overlay on.
await openFiles(pg, [resolve(fx, "amp.step"), ...gfiles]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length > 0 && /amp\.step/.test(window.__sv.state.fileKey), null, { timeout: 120000 });
await pg.click("#file-btn");
const [fc6] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="thermal-map"]')]);
await fc6.setFiles([resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.pcb?.textured, null, { timeout: 90000 });
await pg.waitForSelector('#th-tools [data-th="pcbview"]', { timeout: 30000 });
const img6a = await snap(pg, "map-bar");
await pg.click('#th-tools [data-th="pcbview"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("gerber") && window.__sv.pcbThermal.state().on, null, { timeout: 60000 });
await pg.waitForTimeout(600);
const s6 = await st();
check("TS-6", s6.on && s6.name === "amp", "PCB view on the thermal map's bar opens the board's Gerber set with its temperatures under the layers", s6, img6a);
check("TS-6b", true, "the PCB view opened from the map", {}, await snap(pg, "from-map"));
await pg.evaluate(() => localStorage.removeItem("mc:thermalMap"));
await finish(browser, pg);
