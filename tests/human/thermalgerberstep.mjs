// A board's Gerber set that comes with its STEP by hand (FRS-thermal FR-TBRD-020): opened together the STEP opens and
// keeps the set, its thermal map then gets the board layers, Simulate gives the board study's board its copper,
// Gerber files dropped on the view go on the board, and a `<stem>-gerber.zip` beside the STEP in a vault comes along.
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { open, snap, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalgerberstep");
const fx = resolve("tests/fixtures/thermal"), gdir = resolve(fx, "amp-gerber");
const gfiles = ["amp-F_Cu.gbr", "amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-PTH.drl"];
const toasts = () => pg.evaluate(() => [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | "));

// TS-1: File ▸ Open with the STEP and its four Gerber files: the STEP opens (not the PCB view) and keeps the set.
await openFiles(pg, [resolve(fx, "amp.step"), ...gfiles.map(f => resolve(gdir, f))]);
await pg.waitForFunction(() => window.__sv.viewer.parts.length > 0 && /amp\.step/.test(window.__sv.state.fileKey), null, { timeout: 120000 });
const t1 = await toasts(), pcbMode = await pg.evaluate(() => document.querySelector("#app").classList.contains("gerber"));
check("TS-1", !pcbMode && /Gerber files kept with amp\.step/.test(t1), "the STEP opened with its Gerber files is the model on screen, and the files are kept with it", { pcbMode, t1 }, await snap(pg, "step-kept"));

// TS-2: File ▸ Add thermal map…: the map comes with the board layers under it.
await pg.click("#file-btn");
const [fc2] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="thermal-map"]')]);
await fc2.setFiles([resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.pcb?.textured, null, { timeout: 90000 });
await pg.waitForTimeout(800);
const s2 = await pg.evaluate(() => window.__sv.thermal.state().pcb);
check("TS-2", s2.labels.length === 2 && s2.name === "amp", "Add thermal map… puts the kept Gerber layers under the temperatures at once", s2, await snap(pg, "map-layers"));

// TS-3: Pack and Go holds the Gerber set beside the STEP.
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
const img3 = await snap(pg, "pack");
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const z = (await readFile(await dl.path())).toString("latin1");
check("TS-3", z.includes("amp.step") && z.includes("amp-gerber.zip") && z.includes("amp-thermal.zip"), "Pack and Go puts the Gerber set and the thermal package in the zip beside the STEP", { file: dl.suggestedFilename() }, img3);

// TS-4: Simulate: the board study's board takes its copper from the set.
await pg.click('#th-tools [data-th="simulate"]');
const boardMap = () => pg.evaluate(() => { const d = window.__sv.asm.doc, st = d?.studies?.[0], pcb = d?.components.find(c => c.name === "PCB<1>"); return pcb ? st?.comps?.[pcb.id]?.board?.map?.name ?? null : null; });
await pg.waitForFunction(() => { const d = window.__sv.asm.doc, st = d?.studies?.[0], pcb = d?.components.find(c => c.name === "PCB<1>"); return !!(pcb && st?.comps?.[pcb.id]?.board?.map); }, null, { timeout: 240000 });
await pg.waitForSelector('#sim-tree [data-v="bmapinfo"]', { state: "attached", timeout: 60000 });
await pg.evaluate(() => document.querySelector('#sim-tree [data-v="bmapinfo"]').scrollIntoView({ block: "center" }));
await pg.waitForTimeout(800);
const img4 = await snap(pg, "study-copper");
const info = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="bmapinfo"]')?.textContent ?? "");
check("TS-4", (await boardMap()) === "amp" && /amp/.test(info), "Simulate makes the board study with the board's copper read from the Gerber set (copper map in the Study tab)", { info }, img4);

// TS-5: Even copper, then the Gerber files dropped on the view: the board gets its copper back, no PCB view.
await pg.click('#sim-tree [data-a="bgerberclear"]');
await pg.waitForFunction(() => !document.querySelector('#sim-tree [data-v="bmapinfo"]'));
// a real OS file drag is out of a script's reach: the same drop event, with the files in its DataTransfer
const data = await Promise.all(gfiles.map(async f => [f, (await readFile(join(gdir, f))).toString("base64")]));
await pg.evaluate(fs => {
  const dt = new DataTransfer();
  for (const [n, b] of fs) dt.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], n));
  document.querySelector("#viewport").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, data);
await pg.waitForFunction(() => !!document.querySelector('#sim-tree [data-v="bmapinfo"]'), null, { timeout: 30000 });
await pg.waitForTimeout(600);
const g5 = await pg.evaluate(() => ({ pcb: document.querySelector("#app").classList.contains("gerber"), asm: document.querySelector("#app").classList.contains("asm") }));
check("TS-5", !g5.pcb && g5.asm && (await boardMap()) === "amp", "Gerber files dropped on the view while the board study is open give the board its copper instead of opening the PCB view", g5, await snap(pg, "dropped"));

// TS-6: a vault folder with amp.step and amp-gerber.zip: opening the STEP keeps the set with it.
const tmp = mkdtempSync(join(tmpdir(), "gz-")), gzip = join(tmp, "amp-gerber.zip");
execFileSync("python3", ["-c", "import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],'w')\nfor f in sys.argv[2:]: z.write(f, os.path.basename(f))\nz.close()", gzip, ...gfiles.map(f => join(gdir, f))]);
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=close-all]");
// the new assembly is unsaved: Close anyway (asked once per tab)
for (let i = 0; i < 4; i++) {
  await pg.waitForTimeout(600);
  const ok = await pg.$("dialog[open] [data-a=ok]");
  if (!ok) break;
  await ok.click();
}
await pg.waitForFunction(() => !window.__sv.viewer.parts.length, null, { timeout: 30000 });
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="new-ws"]');
await pg.waitForTimeout(600);
await pg.keyboard.type(`Gerbers${Date.now() % 100000}`);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));
const [fc6] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#vault-panel [data-a="add"]')]);
await fc6.setFiles([resolve(fx, "amp.step"), gzip]);
await pg.waitForFunction(() => window.__sv.vault.files.length === 2, null, { timeout: 30000 });
await pg.dblclick('#vault-panel [data-id] >> text=amp.step');
// the page still holds this STEP's map from TS-2, so the set found beside it goes straight under that map
await pg.waitForFunction(() => /Gerber files kept with amp\.step|Board layers amp under the map/.test([...document.querySelectorAll(".toast")].map(t => t.textContent).join(" ")), null, { timeout: 90000 });
await pg.waitForTimeout(800);
const s6 = await pg.evaluate(() => window.__sv.thermal.state()?.pcb ?? null);
check("TS-6", !!s6?.textured, "opening the STEP from the vault finds amp-gerber.zip beside it and puts the board layers under its map", { toasts: await toasts(), pcb: s6?.name }, await snap(pg, "vault"));
await pg.evaluate(() => localStorage.removeItem("mc:thermalMap"));
await finish(browser, pg);
