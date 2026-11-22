// A board's STEP and its thermal package in a vault by hand (FRS-thermal FR-TPKG-006): both added to one vault folder,
// opening either one opens the two together, and Pack and Go keeps the package with the STEP.
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { open, snap, check, finish } from "./lib.mjs";
const { browser, pg } = await open("thermalvault");
const fx = resolve("tests/fixtures/thermal");
const st = () => pg.evaluate(() => window.__sv.thermal.state());

// TV-1: a browser vault from the Vault menu, then Add files… with the STEP and its package.
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="new-ws"]');
await pg.waitForTimeout(600);
await pg.keyboard.type(`Boards${Date.now() % 100000}`);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));
const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#vault-panel [data-a="add"]')]);
await fc.setFiles([resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.vault.files.length === 2, null, { timeout: 30000 });
await pg.waitForTimeout(500);
const files = await pg.evaluate(() => window.__sv.vault.files.map(f => f.path).sort());
check("TV-1", files.join(",") === "amp-thermal.zip,amp.step", "Add files… puts the board's STEP and its thermal package in the vault", { files }, await snap(pg, "added"));

// TV-2: a double-click on the package opens the STEP beside it with the map on it.
await pg.dblclick('#vault-panel [data-id] >> text=amp-thermal.zip');
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 90000 });
await pg.waitForTimeout(800);
const s2 = await st(), key2 = await pg.evaluate(() => window.__sv.state.fileKey);
check("TV-2", /amp\.step/.test(key2) && !s2.own && s2.matched === 7, "opening the thermal package from the vault opens the board's STEP from the same folder with the map on its bodies", { key2, own: s2.own, matched: s2.matched }, await snap(pg, "from-package"));

// TV-3: Pack and Go keeps the package with the STEP.
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
const img3 = await snap(pg, "pack");
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const z = (await readFile(await dl.path())).toString("latin1");
check("TV-3", z.includes("amp.step") && z.includes("amp-thermal.zip"), "Pack and Go puts the thermal package in the zip beside the STEP", { file: dl.suggestedFilename() }, img3);

// TV-4: closed and opened again from the STEP's row: the map comes along.
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=close-all]");
await pg.waitForFunction(() => !window.__sv.viewer.parts.length, null, { timeout: 30000 });
await pg.evaluate(() => localStorage.removeItem("mc:thermalMap"));
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="panel"]');
await pg.waitForSelector('#vault-panel [data-id] >> text=amp.step', { state: "visible" });
await pg.dblclick('#vault-panel [data-id] >> text=amp.step');
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 90000 });
await pg.waitForTimeout(800);
const s4 = await st();
check("TV-4", s4.drawn && s4.matched === 7, "opening the STEP from the vault shows its thermal package from the same folder", { matched: s4.matched }, await snap(pg, "from-step"));
await pg.evaluate(() => localStorage.removeItem("mc:thermalMap"));
await finish(browser, pg);
