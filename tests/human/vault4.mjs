// The vault by hand, part 4: the explorer (sort, row menu, double-click, folders and drag, compare versions),
// Export ZIP and Import vault ZIP, switching vaults from the menu. Ids follow /mnt/project-files/tests/vault-tests.md.
import { writeFileSync, mkdirSync } from "node:fs";
import { open, snap, check, finish, makeBlock, idle, OUT } from "./lib.mjs";
const { browser, pg } = await open("vault4");
const dlg = "#vault-dlg[open]";
const okDlg = () => pg.click(`${dlg} button[value="ok"]`);
const vmenu = async id => {
  if (await pg.isVisible("#vault-menu")) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(150); }
  await pg.click("#vault-btn");
  if (!(await pg.waitForSelector(`#vault-menu [data-v="${id}"]`, { timeout: 3000 }).catch(() => null))) { await pg.click("#vault-btn"); await pg.waitForSelector(`#vault-menu [data-v="${id}"]`); }
  await pg.click(`#vault-menu [data-v="${id}"]`);
  await pg.waitForTimeout(500);
};
const toasts = () => pg.evaluate(() => [...document.querySelectorAll(".toast, #toasts > *")].map(x => x.textContent.trim().replace(/✕$/, "")).filter(Boolean).slice(-4));
const vinfo = () => pg.evaluate(() => {
  const p = window.__sv.vault, v = p.vault;
  if (!v) return null;
  return { name: v.info.name, user: v.user, files: p.files.filter(f => !f.deleted).map(f => ({ path: f.path, state: f.state, n: v.latest(f).n, versions: f.versions.length, co: f.checkout?.user ?? "" })) };
});
const doc = () => pg.evaluate(() => document.querySelector("#doc")?.textContent.trim() ?? "");
const exRows = () => pg.$$eval("#vault-ex .vx-row", rs => rs.map(r => ({ key: r.dataset.key, text: r.querySelector(".vx-name, [translate=no]")?.textContent.trim() ?? r.textContent.trim().slice(0, 40) })));
const exRow = name => `#vault-ex .vx-row:has-text("${name}")`;
async function step(id, what, fn) {
  try { await fn(); }
  catch (e) { check(id, false, what, { error: e.message.split("\n")[0].slice(0, 200) }, await snap(pg, `${id}-err`)); for (let i = 0; i < 2; i++) await pg.keyboard.press("Escape"); for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close()); }
}
const saveCheckIn = async comment => {
  await vmenu("save");
  await pg.waitForTimeout(1500);
  await vmenu("ci");
  await pg.waitForSelector(dlg);
  await pg.keyboard.type(comment);
  await okDlg();
  await pg.waitForTimeout(1500);
};

const vname = `Shop${Date.now() % 100000}`;
await vmenu("new-ws");
await pg.keyboard.type(vname);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));
// Two parts: Part1 (three versions) and Part2.
await makeBlock(pg, 70, 30, 12);
await saveCheckIn("Block first");
await vmenu("co");
await pg.waitForTimeout(1000);
await pg.mouse.click(700, 450); await pg.keyboard.press("Control+z"); await idle(pg); await pg.keyboard.press("Control+y"); await idle(pg);
await pg.keyboard.press("Control+s"); await pg.waitForTimeout(1200);
await vmenu("ci"); await pg.waitForSelector(dlg); await pg.keyboard.type("Block second"); await okDlg(); await pg.waitForTimeout(1500);
await makeBlock(pg, 40, 40, 4);
await saveCheckIn("Plate first");

// F2 Sort (the parts are Part1 with three versions and Part2) by a column header.
await step("F2", "explorer columns; sort by name both ways", async () => {
  await vmenu("explorer");
  await pg.waitForSelector("#vault-ex:not([hidden]) .vx-row");
  const heads = await pg.$$eval("#vault-ex [data-sort]", b => b.map(x => x.dataset.sort));
  await pg.click('#vault-ex [data-sort="name"]');
  await pg.waitForTimeout(300);
  const a = (await exRows()).map(r => r.text);
  await pg.click('#vault-ex [data-sort="name"]');
  await pg.waitForTimeout(300);
  const b = (await exRows()).map(r => r.text);
  const arrow = await pg.$eval('#vault-ex [data-sort="name"]', x => x.closest("[aria-sort]")?.getAttribute("aria-sort"));
  check("F2", heads.length >= 4 && a.length >= 2 && a.join("|") === [...b].reverse().join("|") && a.join("|") !== b.join("|"), "explorer columns; sort by name both ways", { heads, a, b, arrow }, await snap(pg, "sort"));
});

// F8 Right-click a row.
await step("F8", "right-click a row: open, check out, change state, history…", async () => {
  await pg.click(exRow("Part2"), { button: "right" });
  await pg.waitForTimeout(400);
  const items = await pg.evaluate(() => [...document.querySelectorAll(".mc-menu:not([hidden]) [role=menuitem], #v-menu:not([hidden]) [role=menuitem]")].filter(b => b.offsetParent).map(b => b.textContent.trim()));
  const img = await snap(pg, "rowmenu");
  await pg.keyboard.press("Escape");
  check("F8", items.some(x => /^Open/.test(x)) && items.some(x => /Check out/.test(x)) && items.some(x => /History/.test(x)), "right-click a row: open, check out, change state, history…", { items }, img);
});

// F11 Versions tab: compare two versions.
await step("F11", "Versions tab of a file with two versions: Compare opens the comparison", async () => {
  await pg.click(exRow("Part1"));
  await pg.waitForTimeout(300);
  await pg.click('#vault-ex [data-tab="versions"]');
  await pg.waitForTimeout(500);
  const vers = await pg.$$eval("#vault-ex [data-ver]", b => b.length);
  await pg.click('#vault-ex [data-x="compare"]');
  await pg.waitForSelector(dlg, { timeout: 60000 });
  await pg.waitForTimeout(4000);
  const txt = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " ").slice(0, 300));
  const img = await snap(pg, "compare");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(300);
  const exAfter = await pg.isVisible("#vault-ex");
  check("F11b", exAfter, "Escape closes the compare window and leaves the explorer open", { exAfter }, await snap(pg, "after-compare"));
  if (!exAfter) await vmenu("explorer");
  check("F11", vers >= 2 && txt.length > 20, "Versions tab of a file with two versions: Compare opens the comparison", { vers, txt }, img);
});

// F5 New folder, drag a file into it, rename the folder.
await step("F5", "New folder, drag Part2 into it (confirm), rename the folder", async () => {
  await pg.click('#vault-ex [data-x="newdir"]');
  await pg.waitForSelector(dlg);
  await pg.keyboard.type("Parts");
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(600);
  const node = '#vault-ex .vx-node[data-dir="Parts"], #vault-ex .vx-dir[data-dir="Parts"], #vault-ex .vx-row[data-key="dir:Parts"]';
  await pg.waitForSelector(node, { timeout: 4000 });
  await pg.dragAndDrop(exRow("Part2"), '#vault-ex .vx-node[data-dir="Parts"]');
  await pg.waitForTimeout(600);
  const asked = await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map(d => d.textContent.replace(/\s+/g, " ").slice(0, 160)).join(" | "));
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  else if (await pg.isVisible(dlg)) await okDlg();
  await pg.waitForTimeout(1500);
  const moved = (await vinfo()).files.map(f => f.path);
  await pg.click('#vault-ex .vx-node[data-dir="Parts"]', { button: "right" });
  await pg.waitForTimeout(300);
  await pg.locator("[role=menuitem]:visible", { hasText: "Rename" }).first().click({ timeout: 5000 });
  await pg.waitForSelector(dlg);
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("Plates");
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(500);
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  await pg.waitForTimeout(1500);
  const renamed = (await vinfo()).files.map(f => f.path);
  check("F5", moved.includes("Parts/Part2.mcadprt") && renamed.includes("Plates/Part2.mcadprt"), "New folder, drag Part2 into it (confirm), rename the folder", { asked, moved, renamed, toasts: await toasts() }, await snap(pg, "folders"));
});

// F10 Double-click a row opens the file.
await step("F10", "double-click Part1 opens it", async () => {
  await pg.click('#vault-ex .vx-node[data-dir=""] > .vx-nr');
  await pg.waitForTimeout(400);
  await pg.dblclick(exRow("Part1"));
  await idle(pg);
  await pg.waitForTimeout(2000);
  const d = await doc(), exShown = await pg.isVisible("#vault-ex");
  check("F10", /Part1/.test(d) && !exShown, "double-click Part1 opens it", { doc: d, exShown }, await snap(pg, "dblclick"));
});

// A6 Export ZIP, Import vault ZIP.
let imported = null;
await step("A6", "Export ZIP, then Import vault ZIP… gives the same files and versions", async () => {
  if (!(await pg.isVisible("#vault-panel .v-files"))) await vmenu("panel");
  await pg.click('#vault-panel [data-a="more"]');
  await pg.click('[data-v="export"]');
  await pg.waitForSelector(dlg);
  const dl = pg.waitForEvent("download");
  await okDlg();
  const d = await dl;
  mkdirSync(`${OUT}/vault4`, { recursive: true });
  const file = `${OUT}/vault4/${d.suggestedFilename()}`;
  await d.saveAs(file);
  const was = await vinfo();
  await vmenu("close");
  await pg.waitForTimeout(800);
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  await pg.waitForTimeout(500);
  const chooser = pg.waitForEvent("filechooser");
  await vmenu("import");
  const fc = await chooser;
  await fc.setFiles(file);
  await pg.waitForFunction(n => window.__sv.vault.vault && window.__sv.vault.vault.info.name !== n || window.__sv.vault.vault?.root.name !== n, vname, { timeout: 30000 }).catch(() => {});
  await pg.waitForTimeout(1500);
  imported = await vinfo();
  const root = await pg.evaluate(() => window.__sv.vault.vault?.root.name);
  const same = was.files.length === imported.files.length && was.files.every(f => imported.files.some(g => g.path === f.path && g.n === f.n && g.versions === f.versions));
  check("A6", same, "Export ZIP, then Import vault ZIP… gives the same files and versions", { file: d.suggestedFilename(), root, was: was.files, now: imported.files, toasts: await toasts() }, await snap(pg, "imported"));
  imported.root = root;
});

// A5 Switch to the first vault from the menu without closing.
await step("A5", "switch to the other browser vault from the Vault menu without closing first", async () => {
  await pg.click("#vault-btn");
  await pg.waitForTimeout(500);
  const items = await pg.$$eval("#vault-menu [data-v]", b => b.map(x => `${x.dataset.v} ${x.textContent.trim()}`));
  const img0 = await snap(pg, "switch-menu");
  await pg.click(`#vault-menu [data-v="ws:${vname}"]`);
  await pg.waitForTimeout(1500);
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  await pg.waitForTimeout(1000);
  const root = await pg.evaluate(() => window.__sv.vault.vault?.root.name);
  check("A5", root === vname && imported?.root !== vname, "switch to the other browser vault from the Vault menu without closing first", { items, root, importedRoot: imported?.root }, img0);
});

await finish(browser, pg);
