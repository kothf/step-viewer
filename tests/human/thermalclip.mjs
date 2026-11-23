// Isotherm clip on a thermal map, by hand (FRS-thermal FR-TMAP-010): Clip at a temperature in the legend shows only
// the surfaces hotter (or cooler) than the typed temperature in colour, the rest see-through; with Rise above
// ambient the temperature is typed in K above ambient.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalclip");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const all = (await st()).tris;

// TC-1: tick Clip at a temperature, type 100 °C.
await pg.click('#th-legend input[data-k="clip"]');
await idle(pg);
await pg.fill('#th-legend input[data-k="clipval"]', "100");
await pg.press('#th-legend input[data-k="clipval"]', "Enter");
await idle(pg);
await pg.waitForTimeout(500);
const s1 = await st();
check("TC-1", s1.clip?.above === true && s1.clip.t === 100 && s1.tris > 0 && s1.faded > 0 && s1.tris + s1.faded === all,
  "Clip at a temperature, 100 °C: only the surfaces reaching 100 °C stay in colour (the valves and the hot resistor), the board and the rest see-through", { clip: s1.clip, tris: s1.tris, faded: s1.faded }, await snap(pg, "hotter-100"));

// TC-2: Cooler than.
await pg.selectOption('#th-legend select[data-k="clipside"]', "below");
await idle(pg);
await pg.waitForTimeout(500);
const s2 = await st();
check("TC-2", s2.clip?.above === false && s2.tris > s1.tris && s2.tris + s2.faded === all,
  "Cooler than 100 °C: the board and the cool parts in colour, the hottest surfaces see-through", { clip: s2.clip, tris: s2.tris, faded: s2.faded }, await snap(pg, "cooler-100"));

// TC-3: Rise above ambient (40 °C): the box shows 60 K; typing 100 K clips at 140 °C.
await pg.selectOption('#th-legend select[data-k="clipside"]', "above");
await pg.click('#th-legend input[data-k="rise"]');
await idle(pg);
const shown = await pg.inputValue('#th-legend input[data-k="clipval"]');
await pg.fill('#th-legend input[data-k="clipval"]', "100");
await pg.press('#th-legend input[data-k="clipval"]', "Enter");
await idle(pg);
await pg.waitForTimeout(500);
const s3 = await st();
check("TC-3", Number(shown) === 60 && s3.clip.t === 140 && s3.tris > 0 && s3.tris < s1.tris,
  "with Rise above ambient the clip is typed in K above the 40 °C ambient: 100 °C shows as 60 K, 100 K clips at 140 °C", { shown, clip: s3.clip, tris: s3.tris }, await snap(pg, "rise-100K"));

// TC-4: untick: everything back.
await pg.click('#th-legend input[data-k="rise"]');
await pg.click('#th-legend input[data-k="clip"]');
await idle(pg);
const s4 = await st();
check("TC-4", s4.clip === null && s4.tris === all && s4.faded === 0 && !pg.errors.length,
  "unticking Clip at a temperature shows the whole map again", { clip: s4.clip, tris: s4.tris, errors: pg.errors }, await snap(pg, "all"));
await finish(browser, pg);
