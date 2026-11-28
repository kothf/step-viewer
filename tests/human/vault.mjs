// The vault by hand (FR-PDM): a browser vault, a part saved to it, check-out / check-in, history, states (Draft →
// review → Released → change), the part's drawing beside it, the explorer. Ids follow the test list in
// /mnt/project-files/tests/vault-tests.md. Every step is a real click or key; window.__sv is only read.
import { open, snap, check, finish, makeBlock, idle, cmd } from "./lib.mjs";
const { browser, pg } = await open("vault");
const dlg = "#vault-dlg[open]";
const okDlg = () => pg.click(`${dlg} button[value="ok"]`);
const vmenu = async id => {
  if (await pg.isVisible("#vault-menu")) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(150); }
  await pg.click("#vault-btn");
  if (!(await pg.waitForSelector(`#vault-menu [data-v="${id}"]`, { timeout: 3000 }).catch(() => null))) { await pg.click("#vault-btn"); await pg.waitForSelector(`#vault-menu [data-v="${id}"]`); }
  await pg.click(`#vault-menu [data-v="${id}"]`);
  await pg.waitForTimeout(500);
};
const toast = () => pg.evaluate(() => [...document.querySelectorAll(".toast, #toasts > *")].map(x => x.textContent.trim()).filter(Boolean).slice(-3));
const vinfo = () => pg.evaluate(() => {
  const p = window.__sv.vault, v = p.vault;
  if (!v) return null;
  return { user: v.user, files: p.files.filter(f => !f.deleted).map(f => ({ path: f.path, state: f.state, rev: f.revision ?? "", n: v.latest(f).n, co: f.checkout?.user ?? "" })) };
});
const chip = () => pg.evaluate(() => ({ chip: document.querySelector("#doc-vault")?.textContent.trim() ?? "", ro: !!document.querySelector("#mc-ro"), title: document.querySelector("#doc")?.title ?? "" }));
const row = name => `#vault-panel .v-row:has(.v-name:text-is("${name}"))`;
const pickRow = async name => { await pg.click(row(name)); await pg.waitForTimeout(300); };
const steps = [];
const lost = [];
/** Clicks a button of the vault panel's selected-file box; when the panel went away (a reload switched the side tab), notes it and brings it back. */
const pclick = async (path, sel) => {
  if (!(await pg.isVisible(`#vault-panel ${sel}`))) {
    lost.push(sel);
    await vmenu("panel");
    if (!(await pg.isVisible(`#vault-panel .v-row.sel .v-name:text-is("${path}")`))) await pickRow(path);
  }
  await pg.click(`#vault-panel ${sel}`, { timeout: 5000 });
};
async function step(id, what, fn) {
  try { const r = await fn(); if (r !== undefined) steps.push(id); }
  catch (e) { check(id, false, what, { error: e.message.split("\n")[0].slice(0, 200) }, await snap(pg, `${id}-err`)); for (let i = 0; i < 2; i++) await pg.keyboard.press("Escape"); for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close()); }
}

// A1 New browser vault from the Vault menu.
const vname = `Vault${Date.now() % 100000}`;
await step("A1", "New browser vault: name, Enter, the Vault button lights", async () => {
  await vmenu("new-ws");
  await pg.keyboard.type(vname);
  await pg.keyboard.press("Enter");
  await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"), null, { timeout: 10000 });
  check("A1", true, "New browser vault: name, Enter, the Vault button lights", null, await snap(pg, "new-vault"));
});

// C1 Save to vault.
await makeBlock(pg, 80, 50, 15);
await step("C1", "Save to vault: the part is a vault file checked out to me, the title shows it", async () => {
  await vmenu("save");
  await pg.waitForFunction(() => window.__sv.vault.files.length === 1, null, { timeout: 15000 });
  await pg.waitForTimeout(600);
  const i = await vinfo(), c = await chip();
  check("C1", i.files[0]?.co && /v1/.test(c.chip) && !c.ro, "Save to vault: the part is a vault file checked out to me, the title shows it", { i, c }, await snap(pg, "saved"));
});

// D1 The new file's state reads "Draft" everywhere.
await step("D1", "a new file is in state Draft in the panel, header chip and tooltip", async () => {
  const panel = await pg.$eval("#vault-panel .v-state", e => e.textContent.trim()).catch(() => "");
  const c = await chip();
  check("D1", panel === "Draft" && /Draft/.test(c.chip) && /Draft/.test(c.title) && !/Work in progress/.test(c.chip + c.title + panel), "a new file is in state Draft in the panel, header chip and tooltip", { panel, c });
});

// C2 Ctrl+S writes the working copy; no new version.
await step("C2", "Ctrl+S on a checked-out part writes its working copy (no new version, marked modified)", async () => {
  // a change: a second sketch + extrude on top would be long; a chamfer-free change = the extrude undone and done again
  await pg.mouse.click(700, 450); await pg.keyboard.press("Control+z"); await idle(pg); await pg.keyboard.press("Control+y"); await idle(pg);
  const dp = await pg.evaluate(() => window.__sv.modeller?.store?.dirty ?? null);
  const dirty = await pg.evaluate(() => document.title);
  await pg.keyboard.press("Control+s");
  await pg.waitForTimeout(1500);
  const i = await vinfo(), c = await chip(), title = await pg.evaluate(() => document.title);
  check("C2", i.files[0].n === 1 && /modified/.test(c.chip), "Ctrl+S on a checked-out part writes its working copy (no new version, marked modified)", { i: i.files[0], c: c.chip, dirty, title, depthBox: !!dp }, await snap(pg, "ctrl-s"));
});

// C3 Check in… with a comment: version 2, read-only.
await step("C3", "Check in… stores version 2 with the comment; the part is read-only after", async () => {
  await vmenu("ci");
  await pg.waitForSelector(`${dlg} textarea[name="comment"]`);
  await pg.keyboard.type("Deeper block");
  await snap(pg, "checkin-dlg");
  await okDlg();
  await pg.waitForTimeout(1500);
  const i = await vinfo(), c = await chip();
  check("C3", i.files[0].n === 2 && !i.files[0].co && c.ro, "Check in… stores version 2 with the comment; the part is read-only after", { i: i.files[0], c }, await snap(pg, "checked-in"));
});

// C4 Editing a checked-in part: what happens?
await step("C4", "editing a checked-in part is refused or offers Check out; Check out makes it editable", async () => {
  await cmd(pg, "Fillet").catch(() => {});
  await pg.waitForTimeout(800);
  const panelOpen = await pg.isVisible('#mc-pm');
  const t1 = await toast();
  const img = await snap(pg, "edit-readonly");
  await pg.keyboard.press("Escape");
  if (await pg.isVisible("#mc-cancel")) await pg.click("#mc-cancel");
  await idle(pg);
  // The read-only bar's Check out button, else the menu.
  const bar = await pg.$("#mc-ro button");
  if (bar) await bar.click(); else await vmenu("co");
  await pg.waitForTimeout(1200);
  const i = await vinfo(), c = await chip();
  check("C4", !c.ro && i.files[0].co, "editing a checked-in part is refused or offers Check out; Check out makes it editable", { panelOpenWhileReadOnly: panelOpen, toasts: t1, bar: !!bar, c }, img);
});

// C5 Undo check-out goes back to the latest version.
await step("C5", "Undo check-out throws local changes away", async () => {
  await vmenu("undo");
  await pg.waitForSelector("dialog[open] button", { timeout: 3000 }).catch(() => {});
  const dl = await pg.$$eval("dialog[open]", d => d.map(x => x.id + ":" + x.textContent.trim().slice(0, 80)));
  await pg.click("#confirm [data-a=ok]").catch(() => {});
  await pg.waitForTimeout(1500);
  const i = await vinfo(), c = await chip();
  check("C5", !i.files[0].co && c.ro, "Undo check-out throws local changes away", { dl, c }, await snap(pg, "undo-co"));
});

// C6 History.
await step("C6", "History… lists both versions with user, date and comment", async () => {
  await vmenu("hist");
  await pg.waitForSelector(dlg);
  await pg.waitForTimeout(500);
  const txt = await pg.$eval(dlg, d => d.textContent);
  const img = await snap(pg, "history");
  check("C6", /Deeper block/.test(txt) && /2/.test(txt), "History… lists both versions with user, date and comment", { txt: txt.replace(/\s+/g, " ").slice(0, 400) }, img);
  await pg.keyboard.press("Escape");
});

// D2 Submit for review.
await step("D2", "Submit for review: state In review with a pre-release label; cannot check out", async () => {
  await vmenu("panel");
  await pickRow(`${(await vinfo()).files[0].path}`);
  const trs = await pg.$$eval("#vault-panel [data-tr]", b => b.map(x => x.dataset.tr));
  await pg.click('#vault-panel [data-tr="Submit for review"]');
  await pg.waitForSelector(dlg);
  const img0 = await snap(pg, "submit-dlg");
  await okDlg();
  await pg.waitForTimeout(1500);
  const i = await vinfo();
  const co = await pg.$('#vault-panel [data-a="co"]');
  check("D2", i.files[0].state === "In review" && !co, "Submit for review: state In review with a pre-release label; cannot check out", { trs, f: i.files[0], img0 }, await snap(pg, "in-review"));
});

// D3 Approve → Released, revision A.
await step("D3", "Approve: Released with revision A, read-only", async () => {
  const lostPanel = !(await pg.isVisible("#vault-panel"));
  await pclick("Part1.mcadprt", '[data-tr="Approve"]');
  await pg.waitForSelector(dlg);
  const txt = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " "));
  await okDlg();
  await pg.waitForTimeout(2500);
  const i = await vinfo(), c = await chip();
  const f3 = i.files.find(x => x.path === "Part1.mcadprt");
  check("D3", f3.state === "Released" && f3.rev === "A" && !lostPanel, "Approve: Released with revision A, read-only", { txt: txt.slice(0, 300), f: f3, c, lostPanel }, await snap(pg, "released"));
});

// D4 Change → Change pending → check out, edit, check in, Submit change, Approve → B.
await step("D4", "Change → edit → Submit change → Approve gives revision B", async () => {
  const P = "Part1.mcadprt";
  const roBar = await pg.$eval("#mc-ro", e => e.textContent).catch(() => "");
  await pclick(P, '[data-tr="Change"]');
  const co0 = false;
  await pg.waitForSelector(dlg); await okDlg(); await pg.waitForTimeout(1500);
  await pclick(P, '[data-a="co"]'); await pg.waitForTimeout(1200);
  await pclick(P, '[data-a="ci"]');
  await pg.waitForSelector(dlg); await pg.keyboard.type("Rev B"); await okDlg(); await pg.waitForTimeout(1500);
  await pclick(P, '[data-tr="Submit change"]');
  await pg.waitForSelector(dlg); await okDlg(); await pg.waitForTimeout(1500);
  await pclick(P, '[data-tr="Approve"]');
  await pg.waitForSelector(dlg); await okDlg(); await pg.waitForTimeout(2500);
  const i = await vinfo(), c = await chip(), f = i.files.find(x => x.path === P);
  check("D4", f.state === "Released" && f.rev === "B" && !/Check out/.test(roBar) && !lost.length, "Change → edit → Submit change → Approve gives revision B (no Check out while Released)", { f, c, roBarWhileReleased: roBar, lost, toasts: await toast() }, await snap(pg, "rev-b"));
});

// E2 A new drawing of the vaulted part: its first Save goes beside the part.
await step("E2", "a new drawing of a vaulted part: Save puts it in the vault beside the part", async () => {
  await pg.click("#file-btn");
  await pg.click('#file-menu [data-f="new-drawing"]');
  await pg.waitForFunction(() => window.__sv.drw?.loaded?.(), null, { timeout: 120000 });
  await pg.waitForTimeout(800);
  await pg.click('#drw [data-a="std3"]').catch(async () => { await pg.click('#drw [data-ctab="layout"]'); await pg.click('#drw [data-a="std3"]'); });
  await pg.waitForTimeout(3000);
  await pg.keyboard.press("Control+s");
  await pg.waitForTimeout(800);
  if (await pg.isVisible("#name-dlg[open]")) await pg.keyboard.press("Enter");
  await pg.waitForTimeout(2500);
  const i = await vinfo();
  check("E2", i.files.some(f => /\.mcaddrw$/.test(f.path)), "a new drawing of a vaulted part: Save puts it in the vault beside the part", { files: i.files, toasts: await toast() }, await snap(pg, "drawing-saved"));
});

// E3 Where used / Contains.
await step("E3", "the part's Where used lists the drawing; the drawing's Contains lists the part", async () => {
  const back = await pg.$('#drw [data-a="back"]');
  if (back) await back.click();
  await pg.waitForTimeout(1500);
  await vmenu("panel");
  const part = (await vinfo()).files.find(f => /\.mcadprt$/.test(f.path)).path;
  const drw = (await vinfo()).files.find(f => /\.mcaddrw$/.test(f.path))?.path;
  await pickRow(part);
  await pg.click('#vault-panel [data-a="used"]');
  await pg.waitForSelector(dlg);
  const used = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " "));
  const img = await snap(pg, "where-used");
  await pg.keyboard.press("Escape");
  let contains = "";
  if (drw) { await pickRow(drw); await pg.click('#vault-panel [data-a="contains"]'); await pg.waitForSelector(dlg); contains = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " ")); await pg.keyboard.press("Escape"); }
  check("E3", drw && used.includes(drw.split("/").pop()) && contains.includes(part.split("/").pop()), "the part's Where used lists the drawing; the drawing's Contains lists the part", { used: used.slice(0, 200), contains: contains.slice(0, 200) }, img);
});

// F1 The explorer.
await step("F1", "Vault explorer: tree, list with state/revision columns, preview", async () => {
  await vmenu("explorer");
  await pg.waitForSelector("#vault-ex:not([hidden]) .vx-row");
  await pg.click("#vault-ex .vx-row");
  await pg.waitForTimeout(800);
  const s = await pg.evaluate(() => ({ rows: [...document.querySelectorAll("#vault-ex .vx-row")].map(r => r.textContent.replace(/\s+/g, " ").trim()), heads: [...document.querySelectorAll("#vault-ex [data-sort]")].map(h => h.textContent.trim()), thumb: !!document.querySelector("#vault-ex img") }));
  check("F1", s.rows.length >= 1 && s.heads.length >= 3, "Vault explorer: tree, list with state/revision columns, preview", s, await snap(pg, "explorer"));
});

console.log("ERRORS", JSON.stringify(pg.errors.slice(0, 10)));
await finish(browser, pg);
