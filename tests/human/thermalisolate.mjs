// One part of a thermal map alone, and the map saved as a picture, by hand (FRS-thermal FR-TMAP-020/042): a
// double-click on a row or on the part in the view shows it alone with the rest see-through, Esc ends it, and
// Save picture writes a PNG with the colour scale, the hottest part and the accuracy drawn in.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles, OUT, dblAt, screenOf } from "./lib.mjs";
const { browser, pg } = await open("thermalisolate");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const all = (await st()).tris;

// TI-1: double-click R14's row in the parts list.
await pg.dblclick('#th-side tr[data-part="2"]');
await idle(pg);
await pg.waitForTimeout(900);
const s1 = await st();
const note = await pg.evaluate(() => document.querySelector('#th-legend [data-v="iso"]')?.textContent);
check("TI-1", s1.iso === 2 && s1.faded > 0 && s1.tris + s1.faded === all && /R14/.test(note ?? ""),
  "a double-click on R14's row shows it alone in colour, the other parts and the board see-through; the legend says so", { iso: s1.iso, tris: s1.tris, faded: s1.faded, note }, await snap(pg, "isolated-row"));

// TI-2: Show all parts, then a double-click on R14 in the view, then Esc.
await pg.click('#th-legend [data-a="unisolate"]');
await idle(pg);
const s2 = await st();
const v3 = await pg.evaluate(() => { const p = window.__sv.thermal.state(); return p && window.__sv.thermal.screenOf([45, 30, 8.5]); });
const hit = v3 && await pg.evaluate(([x, y]) => window.__sv.thermal.valueAt(x, y), [v3.x, v3.y]);
if (hit && hit.part > 0) await dblAt(pg, [v3.x, v3.y]);
await pg.waitForTimeout(600);
const s3 = await st(), shot3 = await snap(pg, "isolated-view");
await pg.mouse.move(700, 880);
await pg.keyboard.press("Escape");
await idle(pg);
const s4 = await st();
check("TI-2", s2.iso === null && s2.faded === 0 && hit && s3.iso === hit.part && s4.iso === null,
  "Show all parts brings the board back; a double-click on a part in the view shows it alone and Esc ends it", { hit, iso: s3.iso, after: s4.iso, shot3 }, await snap(pg, "all-again"));

// TI-3: Save picture on the Thermal bar.
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('#th-tools [data-th="png"]')]);
const file = `${OUT}/thermalisolate-picture.png`;
await dl.saveAs(file);
const s5 = await st();
check("TI-3", /\.png$/.test(dl.suggestedFilename()) && s5.picture.lines.some(l => /Hottest V3 182/.test(l)) && s5.picture.lines.some(l => /±15/.test(l)) && !pg.errors.length,
  "Save picture writes a PNG of the view with the colour scale (40 to 182 °C), the hottest part, the accuracy and the labels drawn in", { name: dl.suggestedFilename(), lines: s5.picture.lines, errors: pg.errors }, file);
await finish(browser, pg);
