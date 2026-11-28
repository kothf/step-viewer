// Setting up a study, second round (test list /mnt/project-files/tests/analysis-tests.md, rows A3, B4, B5, C2, C3,
// D3, E8, E9, F4) plus the Simulation bar labels and the material warning: a first command with no study, edit /
// suppress / delete from the tree, force along the normal or by components, a global variable in a load, Solve on
// change, convection presets, and an assembly's results beside it in its folder and in Pack and Go.
import { mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { open, snap, idle, screenOf, clickAt, dblAt, check, finish, makeBlock, openFiles, simCmd, OUT } from "./lib.mjs";
const TMP = process.env.HT_TMP || "/tmp/simsetup2";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const FOLDER = "simsetup2-ht";
let { browser, pg } = await open("simsetup2", `&nocache&asmfolder=${FOLDER}`);
pg.on("dialog", d => d.accept());
await pg.evaluate(async f => { await (await navigator.storage.getDirectory()).removeEntry(f, { recursive: true }).catch(() => {}); }, FOLDER);
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const study = () => pg.evaluate(() => { const s = window.__sv.sim.state().study; return structuredClone(window.__sv.model.store.doc.studies?.find(x => x.id === s) ?? null); });
const rows = () => pg.$$eval("#sim-tree .sim-row", els => els.map(e => ({ id: e.dataset.id, text: e.textContent.trim(), off: e.querySelector('[data-a="toggle"]')?.getAttribute("aria-pressed") === "true" })));
const toasts = () => pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
/** Direction of the load arrow on the model (ArrowHelper points along its +Y). */
const arrowDir = () => pg.evaluate(() => {
  const a = window.__sv.sim.marks.children.find(o => o.userData.simArrow);
  if (!a) return null;
  const { x, y, z, w } = a.quaternion;
  return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)].map(v => Math.round(v * 1000) / 1000);
});
const END = [50, 0, 10], TOP = [0, 0, 20], SIDE = [0, -10, 10];

// Bar: every command shows its label at 1440 px (it showed bare glyphs before 1.773.0)
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(400);
const bar = await pg.evaluate(() => ({ icons: document.querySelector("#cm")?.classList.contains("cm-icons") ?? false, bare: [...document.querySelectorAll("#sim-tools .mc-b")].filter(b => b.offsetParent && !(b.querySelector(".mc-l")?.offsetWidth > 0)).map(b => b.dataset.s) }));
check("G1", !bar.icons && bar.bare.length === 0, "the Simulation bar shows every command with its label at 1440 px", bar, await snap(pg, "bar"));

// A3: Fixed support with no study yet makes a static study and opens its panel
const before = await sim();
await pg.click('#sim-tools [data-s="fixed"]');
await pg.waitForTimeout(500);
const a3 = { before: before.study, after: (await sim()).study, editing: (await sim()).editing, kind: (await study())?.kind };
check("A3", !before.study && a3.after && a3.editing && a3.kind === "static", "Fixed support with no study makes a static study and opens the support's panel", a3, await snap(pg, "first-command"));
await clickAt(pg, await screenOf(pg, END));
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// G2: Solve without a material: the warning; picking a material takes it away
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForTimeout(700);
const warnBefore = await toasts();
if (!(await pg.isVisible("#mat-dlg[open]"))) { await pg.click('#sim-tools [data-s="mat"]'); await pg.waitForSelector("#mat-dlg[open]"); }
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
const warnAfter = await toasts();
check("G2", /material/i.test(warnBefore) && !/Pick a material/i.test(warnAfter), "the 'Pick a material' warning goes once a material is picked", { warnBefore, warnAfter }, await snap(pg, "material-picked"));

// C2: a force along the face normal; Reverse flips it and the arrow on the model follows; then by components
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, TOP));
await pg.waitForTimeout(300);
const push = await arrowDir();
await pg.check('#sim-pm [data-k="flip"]');
await pg.waitForTimeout(300);
const pull = await arrowDir();
await pg.uncheck('#sim-pm [data-k="flip"]');
await pg.uncheck('#sim-pm [data-k="normal"]');
await pg.waitForTimeout(300);
const comps = await pg.$$eval('#sim-pm [data-n^="c"]', els => els.map(e => e.dataset.n));
// typed as a person does: X, Tab, Y, Tab, Z, Tab
await pg.click('#sim-pm [data-n="c0"]', { clickCount: 3 });
for (const v of ["0", "500", "0"]) { await pg.keyboard.press("Control+a"); await pg.keyboard.type(v); await pg.keyboard.press("Tab"); await pg.waitForTimeout(150); }
const typed = await pg.$$eval('#sim-pm [data-n^="c"]', els => els.map(e => e.value));
await pg.waitForTimeout(300);
const sideways = await arrowDir();
check("C2", push?.[2] < -0.99 && pull?.[2] > 0.99 && comps.length === 3 && sideways?.[1] > 0.99,
  "a force along the face normal pushes into the top face, Reverse turns the arrow round, and X/Y/Z components point it along Y", { push, pull, comps, typed, sideways }, await snap(pg, "force-components"));
// back to along the normal, 1000 N, for the rest
await pg.check('#sim-pm [data-k="normal"]');
await pg.waitForTimeout(200);
await pg.fill('#sim-pm [data-n="value"]', "1000");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// C3: a global variable drives the load: Equations ▸ F = 1500, then the force typed as F
await pg.click("#t-features");
await pg.locator('#mc-tree .ft-row[data-id="equations"]').first().click();
await pg.waitForTimeout(400);
await pg.click('#mc-pm [data-a="add"]');
await pg.waitForTimeout(200);
const eqName = pg.locator('#mc-pm .eq-row [data-e="name"]').last();
await eqName.fill("F"); await eqName.press("Enter");
const eqExpr = pg.locator('#mc-pm .eq-row [data-e="expr"]').last();
await eqExpr.fill("1500"); await eqExpr.press("Enter");
await pg.selectOption('#mc-pm .eq-row [data-e="kind"] >> nth=-1', "number");
await pg.click('#mc-pm [data-a="ok"]');
await idle(pg);
await pg.click("#t-sim");
await pg.waitForTimeout(300);
const forceRow = (await rows()).find(r => /Force/.test(r.text));
await pg.click(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="edit"]`);
await pg.waitForTimeout(400);
await pg.fill('#sim-pm [data-n="value"]', "F");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(200);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const fv = (await study()).loads.find(l => l.id === forceRow.id)?.value;
const r3 = (await rows()).find(r => r.id === forceRow.id)?.text;
// change the variable: the force follows
await pg.click("#t-features");
await pg.locator('#mc-tree .ft-row[data-id="equations"]').first().click();
await pg.waitForTimeout(400);
const eqExpr2 = pg.locator('#mc-pm .eq-row [data-e="expr"]').last();
await eqExpr2.fill("2500"); await eqExpr2.press("Enter");
await pg.click('#mc-pm [data-a="ok"]');
await idle(pg);
await pg.click("#t-sim");
await pg.waitForTimeout(300);
const fv2 = (await study()).loads.find(l => l.id === forceRow.id)?.value;
check("C3", fv?.expr === "F" && fv?.v === 1500 && fv2?.v === 2500, "a force typed as the global variable F takes its value and follows when F changes", { fv, fv2, row: r3 }, await snap(pg, "force-variable"));

// B4: double-click the force row opens it for editing; its face lights on the model
await pg.locator(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="edit"]`).dblclick();
await pg.waitForTimeout(500);
const b4 = { editing: (await sim()).editing, faces: await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? null), marks: await pg.evaluate(() => window.__sv.sim.marks.children.filter(o => o.userData.simMark || o.userData.simArrow).length) };
check("B4", b4.editing === forceRow.id && b4.faces === "1 face" && b4.marks > 0, "a click (or double-click) on a tree item opens it for editing with its face marked on the model", b4, await snap(pg, "edit-item"));
await pg.click("#sim-pm .pm-cancel");
await idle(pg);

// B5: suppress, then delete, from the tree; Ctrl+Z brings the deleted one back
await pg.click(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="toggle"]`);
await pg.waitForTimeout(300);
const off = (await study()).suppressed?.includes(forceRow.id) && (await rows()).find(r => r.id === forceRow.id)?.off;
await pg.click(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="toggle"]`);
await pg.waitForTimeout(300);
const on = !(await study()).suppressed?.includes(forceRow.id);
await pg.click(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="del"]`);
await pg.waitForTimeout(400);
const gone = !(await study()).loads.some(l => l.id === forceRow.id);
await pg.mouse.move(700, 450);
await pg.keyboard.press("Control+z");
await pg.waitForTimeout(400);
const back = (await study()).loads.some(l => l.id === forceRow.id);
check("B5", off && on && gone && back, "the tree's ● leaves an item out and puts it back, × deletes it, Ctrl+Z brings it back", { off, on, gone, back }, await snap(pg, "suppress-delete"));

// D3: Solve on change: tick it, then change the force: the study solves by itself
await pg.check('#sim-tree [data-k="auto"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return s.done && !s.stale && !s.running; }, null, { timeout: 300000 }).catch(() => {});
const d3a = await sim();
await pg.click(`#sim-tree .sim-row[data-id="${forceRow.id}"] [data-a="edit"]`);
await pg.waitForTimeout(300);
await pg.fill('#sim-pm [data-n="value"]', "5000");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.waitForFunction(r => { const s = window.__sv.sim.state(); return s.autoRuns > r && s.done && !s.stale && !s.running; }, d3a.autoRuns, { timeout: 300000 }).catch(() => {});
const d3b = await sim();
check("D3", d3a.done && d3b.autoRuns > d3a.autoRuns && d3b.done && !d3b.stale && d3b.maxU > d3a.maxU * 1.5,
  "with Solve on change ticked, the study solves after it is ticked and again after the force changes", { first: [d3a.autoRuns, d3a.maxU], second: [d3b.autoRuns, d3b.maxU] }, await snap(pg, "auto-solved"));
await pg.uncheck('#sim-tree [data-k="auto"]');

// F4: thermal study, Convection: film presets fill the coefficient; Custom keeps a typed one
await pg.click('#sim-tools [data-s="mode-thermal"]');
await idle(pg);
if ((await sim()).kind !== "thermal") { await pg.click('#sim-tools [data-s="newthermal"]'); await idle(pg); }
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, SIDE));
await pg.waitForTimeout(300);
const presets = await pg.$$eval('#sim-pm select[data-k="film"] option', os => os.map(o => [o.value, o.textContent.trim()]));
const hcOf = () => pg.$eval('#sim-pm [data-q="hc"]', e => e.value).catch(() => null);
await pg.selectOption('#sim-pm select[data-k="film"]', "3000");
await pg.waitForTimeout(200);
const water = await hcOf();
await pg.selectOption('#sim-pm select[data-k="film"]', "40");
await pg.waitForTimeout(200);
const fan = await hcOf();
await pg.fill('#sim-pm [data-q="hc"]', "123");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(200);
const custom = await pg.$eval('#sim-pm select[data-k="film"]', e => e.value);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const conv = (await study()).supports.find(s => s.type === "conv");
check("F4", presets.length >= 6 && Number(water) === 3000 && Number(fan) === 40 && custom === "" && conv?.h === 123,
  "Convection offers film presets (still/moving air, still/flowing water, natural, forced) that fill the coefficient; a typed one shows Custom", { presets: presets.map(p => p[1]), water, fan, custom, h: conv?.h }, await snap(pg, "film-presets"));

// E8/E9: an assembly of the block, a thermal study solved, saved into its folder: results beside it; Pack and Go
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 30000 });
await pg.waitForTimeout(1500);
await idle(pg);
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="mode-thermal"]');
await idle(pg);
if ((await sim()).kind !== "thermal") { await pg.click('#sim-tools [data-s="newthermal"]'); await idle(pg); }
const sur = await pg.$('#sim-tree [data-a="surround"]');
if (sur) { await sur.click(); await idle(pg); }
await pg.click('#sim-tools [data-s="heat"]');
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(600);
await clickAt(pg, await screenOf(pg, TOP));
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return (s.done && s.kind === "thermal" && !s.stale) || s.error; }, null, { timeout: 300000 });
const th = await sim();
await snap(pg, "asm-solved");
const disk = () => pg.evaluate(async f => {
  const out = {};
  for await (const [n, h] of (await (await navigator.storage.getDirectory()).getDirectoryHandle(f, { create: true })).entries()) if (h.kind === "file") out[n] = (await h.getFile()).size;
  return out;
}, FOLDER);
await pg.evaluate(f => { window.showSaveFilePicker = async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle(f, { create: true })).getFileHandle("Block.mcadasm", { create: true }); }, FOLDER);
await pg.mouse.click(700, 860);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(800);
if (await pg.isVisible("#name-dlg[open]")) { await pg.fill("#name-dlg-in", "Block.mcadasm"); await pg.keyboard.press("Enter"); }
await pg.waitForTimeout(4000);
const files = await disk();
const fetchOut = async name => {
  const data = await pg.evaluate(async ({ f, n }) => [...new Uint8Array(await (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle(f)).getFileHandle(n)).getFile()).arrayBuffer())], { f: FOLDER, n: name });
  writeFileSync(`${TMP}/${name}`, Buffer.from(data));
  return `${TMP}/${name}`;
};
const asmName = Object.keys(files).find(n => n.endsWith(".mcadasm"));
const resName = Object.keys(files).find(n => n.endsWith(".mcadres"));
const local = [];
for (const n of Object.keys(files)) local.push(await fetchOut(n));
// Pack and Go
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
await pg.waitForSelector("#pack-dlg tr[data-pf]", { timeout: 20000 });
const packRows = await pg.$$eval("#pack-dlg tr[data-pf]", rs => rs.map(r => r.cells[0].textContent.trim()));
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const zip = `${TMP}/${dl.suggestedFilename()}`;
await dl.saveAs(zip);
const zipList = execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n");
check("E9", zipList.some(n => n.endsWith(".mcadres")) && packRows.some(n => n.endsWith(".mcadres")), "Pack and Go lists and zips the results file beside the assembly", { packRows, zipList }, await snap(pg, "pack"));
await finish(browser, pg);

// reopen the folder's files in a fresh browser with no disk cache
({ browser, pg } = await open("simsetup2b", "&nocache"));
await openFiles(pg, local);
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(1500);
await idle(pg);
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(2000);
const e8 = await sim();
check("E8", asmName && resName && e8.done && e8.fromFile && e8.kind === "thermal" && Math.abs(e8.thermal?.max - th.thermal?.max) < 1e-6,
  "an assembly saved into its folder writes its results beside it (.mcadres), and opening the folder's files brings them back without solving", { files, done: e8.done, fromFile: e8.fromFile, max: [e8.thermal?.max, th.thermal?.max] }, await snap(pg, "asm-reopened"));
await finish(browser, pg);
void readdirSync; void dblAt; void simCmd; void OUT;
