// The board's Gerber layers under its thermal map by hand (FRS-thermal FR-TMAP-012): Board layers reads the Gerber
// set, lays its copper on the board by the outline and blends it under the temperatures; the slider sets how
// strongly, an offset moves it, the button hides it and Remove layers takes it off.
import { resolve } from "node:path";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermallayers");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const shot = () => pg.screenshot({ clip: { x: 460, y: 320, width: 400, height: 320 } });
const plain = await shot();

// TL-1: Board layers with the board's four Gerber files.
const dir = resolve(fx, "amp-gerber");
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#th-tools [data-th="gerber"]')]);
await fc.setFiles(["amp-F_Cu.gbr", "amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-PTH.drl"].map(f => resolve(dir, f)));
await pg.waitForFunction(() => window.__sv.thermal.state()?.pcb?.textured, null, { timeout: 30000 });
await pg.waitForTimeout(800);
const s1 = await st(), layered = await shot();
check("TL-1", s1.pcb.board > 0 && JSON.stringify(s1.pcb.box) === "[0,0,120,80]" && s1.pcb.labels.length === 2 && !plain.equals(layered),
  "Board layers reads the Gerber set (two copper layers) and the copper shows under the temperatures, laid on the board by its outline", s1.pcb, await snap(pg, "layers-on"));

// TL-2: the bottom face shows the bottom copper.
await pg.click('#th-tools [data-th="flip"]');
await pg.waitForTimeout(900);
check("TL-2", true, "Bottom turns the view to the board's bottom face, which carries the bottom copper", {}, await snap(pg, "bottom-face"));
await pg.click('#th-tools [data-th="flip"]');
await pg.waitForTimeout(900);

// TL-3: the slider: dragged to the left end the plain map comes back; to the right end the copper is strongest.
const slider = await pg.$('#th-legend input[data-k="pcbmix"]');
const box = await slider.boundingBox();
await pg.mouse.click(box.x + 1, box.y + box.height / 2);
await pg.waitForTimeout(600);
const s3 = await st();
await snap(pg, "mix-zero");
await pg.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
await pg.waitForTimeout(600);
const s4 = await st();
check("TL-3", s3.pcb.mix === 0 && s4.pcb.mix === 1, "the Layers slider sets how strongly the copper shows: 0 % is the plain map, 100 % the strongest", { at0: s3.pcb.mix, at100: s4.pcb.mix }, await snap(pg, "mix-full"));

// TL-4: an offset moves the layers along the board.
await pg.fill('#th-legend input[data-k="pcbdx"]', "10");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(600);
const s5 = await st();
check("TL-4", s5.pcb.du === 10 && s5.pcb.textured, "typing 10 mm in the offset moves the copper 10 mm along the board", s5.pcb, await snap(pg, "offset"));
await pg.fill('#th-legend input[data-k="pcbdx"]', "0");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(400);

// TL-5: the button hides and shows the layers, Remove layers takes them off.
await pg.click('#th-tools [data-th="gerber"]');
await pg.waitForTimeout(400);
const s6 = await st();
await pg.click('#th-tools [data-th="gerber"]');
await pg.waitForTimeout(400);
await pg.click('#th-legend [data-a="pcbclear"]');
await pg.waitForTimeout(400);
const s7 = await st();
check("TL-5", !s6.pcb.shown && s7.pcb === null && s7.drawn, "Board layers hides and shows the copper; Remove layers takes it off and leaves the map", { hidden: s6.pcb.shown, after: s7.pcb }, await snap(pg, "removed"));
await pg.evaluate(() => localStorage.removeItem("mc:thermalMap"));
await finish(browser, pg);
