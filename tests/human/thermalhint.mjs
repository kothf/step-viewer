// The "looks like a board" hint by hand (FRS-thermal FR-TPKG-005): a board's STEP offers Add thermal map… in the
// status bar, once per file.
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const FX = "tests/fixtures/thermal";
const { browser, pg } = await open("thermalhint");
const hint = () => pg.evaluate(() => { const el = document.querySelector("#st-thermal"); return { shown: !el.hidden && el.offsetWidth > 0, text: el.innerText.replace(/\s+/g, " ").trim() }; });

// TH-1: the board's STEP alone: the status bar says it looks like a board and offers Add thermal map….
await openFiles(pg, [`${FX}/amp.step`]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length === 7, null, { timeout: 60000 });
await idle(pg);
await pg.waitForTimeout(300);
const h1 = await hint();
check("TH-1", h1.shown && /looks like a circuit board/.test(h1.text) && /Add thermal map/.test(h1.text), "a board's STEP shows a status-bar hint with an Add thermal map… link", h1, await snap(pg, "hint"));

// TH-2: the link opens the file picker; picking the package shows the map and the hint goes.
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#st-thermal [data-a="thadd"]')]);
await fc.setFiles([`${FX}/amp-thermal.zip`]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 60000 });
await idle(pg);
const h2 = await hint();
check("TH-2", !h2.shown, "Add thermal map… opens the file picker; the picked package colours the board and the hint is gone", h2, await snap(pg, "map"));

// TH-3: the same STEP opened again: no hint, it was shown once for this file.
await openFiles(pg, [`${FX}/amp.step`]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length === 7 && !document.querySelector("#loading:not([hidden])"), null, { timeout: 60000 });
await idle(pg);
await pg.waitForTimeout(300);
const h3 = await hint();
check("TH-3", !h3.shown, "the same file opened again shows no hint", h3, await snap(pg, "again"));
await finish(browser, pg);
