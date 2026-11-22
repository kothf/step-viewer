// The board's copper from its Gerber files by hand (FRS-thermal FR-TBRD-020): Copper from Gerber reads the copper
// layers and drill files onto a grid, shows the map, and the solve follows the copper cell by cell: the side of the
// board under copper spreads heat, the bare side does not. Even copper puts the plain stack back.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalgerber");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 }); await pg.waitForTimeout(600); };
const parts = () => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll("#sim-tree .sim-tcomps tbody tr")].map(r => [r.children[0].textContent, Number(r.children[1].textContent)])));
const board = () => pg.evaluate(() => { const li = [...document.querySelectorAll("#sim-tree .sim-complist li")].find(l => /^PCB/.test(l.textContent));
  return { text: li?.innerText.replace(/\s+/g, " ").trim(), k: li?.querySelector('[data-v="compk"]')?.textContent, info: document.querySelector('#sim-tree [data-v="bmapinfo"]')?.textContent ?? "",
    img: document.querySelector('#sim-tree img[data-v="bmap"]')?.naturalWidth ?? 0, button: !!document.querySelector('#sim-tree [data-a="bgerber"]'), cover: !!document.querySelector('#sim-tree input[data-k="bcover"]') }; });

// TG-1: the plain stack first, solved.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s0 = await sim(), p0 = await parts(), b0 = await board();
check("TG-1", !s0.error && b0.button && b0.cover && !b0.img, "the board study solves with an even copper stack; the board row offers Copper from Gerber…", { b0, p0 }, await snap(pg, "even-copper"));

// TG-2: Copper from Gerber with the board's four files.
const dir = resolve(fx, "amp-gerber");
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#sim-tree [data-a="bgerber"]')]);
await fc.setFiles(["amp-F_Cu.gbr", "amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-PTH.drl"].map(f => resolve(dir, f)));
await pg.waitForFunction(() => !!document.querySelector('#sim-tree [data-v="bmapinfo"]'), null, { timeout: 30000 });
await pg.waitForTimeout(400);
const b1 = await board(), st1 = await sim();
check("TG-2", /^amp: Top copper 50 %, Bottom copper 83 %; 12 plated holes; cells of 1 mm/.test(b1.info) && b1.img === 120 && !b1.cover && st1.stale,
  "the Gerber set is read: two copper layers (half the top, five sixths of the bottom), 12 plated holes on 1 mm cells, a picture of the copper; the coverage field goes and the results are marked out of date", b1, await snap(pg, "copper-map"));

// TG-3: solved again with the map: the board's conductivity follows the copper, so temperatures move.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), p1 = await parts();
const moved = Object.keys(p0).filter(n => Math.abs(p0[n] - p1[n]) > 0.05);
check("TG-3", !s1.error && moved.length >= 3,
  "solved with the copper map: the board's conductivity changes cell by cell and the parts' temperatures move (the transistor, standing on bare board past the copper, runs hotter)", { before: p0, after: p1, moved }, await snap(pg, "solved-with-map"));

// TG-4: undo takes the map away again (one step), redo brings it back.
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(500);
const b2 = await board();
await pg.keyboard.press("Control+y");
await pg.waitForTimeout(500);
const b3 = await board();
check("TG-4", b2.button && !b2.img && b3.img === 120, "Ctrl+Z takes the copper map off in one step and Ctrl+Y puts it back", { b2, b3 }, await snap(pg, "undo-redo"));

// TG-5: Even copper goes back to the plain stack, and the solve gives the first answer again.
await pg.click('#sim-tree [data-a="bgerberclear"]');
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), b4 = await board();
check("TG-5", b4.button && b4.cover && Math.abs(s2.thermal.max - s0.thermal.max) < 1e-3, "Even copper drops the map and the solve gives the even-stack answer again", { max: [s0.thermal.max, s2.thermal.max], b4 }, await snap(pg, "even-again"));
await finish(browser, pg);
