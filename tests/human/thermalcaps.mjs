// Section planes through a board thermal map, by hand (FRS-thermal FR-TMAP-041): the cut faces show the map's
// surface temperatures in a band along the cut outline, plain inside, and the legend says a package has no values
// inside the parts. Moving the plane repaints the caps; removing it takes the note away.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalcaps");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => ({ caps: window.__sv.thermal.state().caps, note: document.querySelector('#th-legend [data-v="capnote"]')?.textContent ?? "" }));

// TS-1: Section tab ▸ + YZ: the plane cuts the board and the parts across.
await pg.click("#rt-section");
await idle(pg);
await pg.click('#sec-add [data-sec="x"]');
await idle(pg);
await pg.waitForTimeout(800);
const s1 = await st();
check("TS-1", s1.caps.n > 0 && s1.caps.painted === s1.caps.n && s1.caps.slice > 20 && s1.caps.banded > 0 && /along the cut only/.test(s1.note),
  "+ YZ on the Section tab: the cut faces show the map's colours in a band along the outline, grey inside, and the legend explains why", s1, await snap(pg, "section-yz"));

// TS-2: drag the offset slider: the caps follow and are painted again.
const box = await pg.locator('#rp-section input[data-k="range"]').first().boundingBox();
await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await pg.mouse.down();
await pg.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 8 });
await pg.mouse.up();
await idle(pg);
await pg.waitForTimeout(600);
const s2 = await st();
check("TS-2", s2.caps.painted === s2.caps.n && s2.caps.slice > 0 && s2.caps.slice !== s1.caps.slice,
  "dragging the plane's offset moves the cut; the caps are painted for the new place", s2, await snap(pg, "section-moved"));

// TS-2b: offset 45 mm (through the valve), drag arrows off, Ctrl+4 = Right view: the cut faces seen straight on,
// the colour band on the valve's and the board's outline.
await pg.fill('#rp-section input[data-k="off"]', "45");
await pg.press('#rp-section input[data-k="off"]', "Enter");
await idle(pg);
await pg.click('#rp-section [data-a="move"]');
await pg.click("#th-legend .ana-head strong");
await pg.keyboard.press("Control+4");
await idle(pg);
await pg.waitForTimeout(900);
const s2b = await st();
check("TS-2b", s2b.caps.painted === s2b.caps.n && s2b.caps.banded > 0, "the Right view looks at the cut faces: the band of the map's colours runs round each cut outline", s2b, await snap(pg, "section-right"));

// TS-3: remove the plane: no caps, no note.
await pg.click('#rp-section [data-a="del"]');
await idle(pg);
await pg.waitForTimeout(400);
const s3 = await st();
check("TS-3", s3.caps.n === 0 && !s3.note && !pg.errors.length, "removing the plane shows the whole map again without the note", { ...s3, errors: pg.errors }, await snap(pg, "no-section"));
await finish(browser, pg);
