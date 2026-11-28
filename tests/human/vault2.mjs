// The vault by hand, part 2: a part saved with its open drawing, check-in with references, the drawing behind
// the part, data card, search, rename, delete and restore, several files at once, the close reminder, closing
// and opening the vault again, a page reload. Ids follow /mnt/project-files/tests/vault-tests.md.
import { open, snap, check, finish, makeBlock, idle } from "./lib.mjs";
const { browser, pg } = await open("vault2");
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
  return { user: v.user, files: p.files.filter(f => !f.deleted).map(f => ({ path: f.path, state: f.state, n: v.latest(f).n, co: f.checkout?.user ?? "", card: f.card ?? {} })) };
});
const fileOf = async re => (await vinfo()).files.find(f => re.test(f.path));
const row = name => `#vault-panel .v-row:has(.v-name:text-is("${name}"))`;
const showPanel = async () => { if (!(await pg.isVisible("#vault-panel .v-files"))) await vmenu("panel"); };
const pickRow = async (name, mods) => { await showPanel(); await pg.click(row(name), mods ? { modifiers: mods } : undefined); await pg.waitForTimeout(300); };
/** Back to the part's document tab (a drawing opened from the vault covers the 3D view and the Vault button). */
const toPart = async () => {
  if (!(await pg.evaluate(() => document.getElementById("app").classList.contains("drawing")))) return;
  const tabs = await pg.$$eval("#doc-tabs [data-dt]", b => b.map(x => x.textContent));
  const i = tabs.findIndex(x => /mcadprt|Block/.test(x));
  if (i >= 0) await pg.locator("#doc-tabs [data-dt]").nth(i).click();
  else await pg.click('#drw [data-a="back"]');
  await idle(pg); await pg.waitForTimeout(800);
};
async function step(id, what, fn) {
  await toPart().catch(() => {});
  try { await fn(); }
  catch (e) { check(id, false, what, { error: e.message.split("\n")[0].slice(0, 200) }, await snap(pg, `${id}-err`)); for (let i = 0; i < 2; i++) await pg.keyboard.press("Escape"); for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close()); }
}

const vname = `Shop${Date.now() % 100000}`;
await vmenu("new-ws");
await pg.keyboard.type(vname);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));

// E1 A part with a drawing open in a tab: Save to vault takes the drawing along.
await makeBlock(pg, 60, 40, 10);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="new-drawing"]');
await pg.waitForFunction(() => window.__sv.drw?.loaded?.(), null, { timeout: 120000 });
await pg.click('#drw [data-ctab="layout"]').catch(() => {});
await pg.click('#drw [data-a="std3"]');
await pg.waitForTimeout(3000);
await step("E1", "Save to vault with the part's drawing open: both go in, the drawing beside the part", async () => {
  // back to the part's tab
  await pg.click('#doc-tabs [data-dt]:not([data-dt="@extra"]) >> nth=0');
  await idle(pg);
  const live = await pg.evaluate(() => document.getElementById("app").className);
  await vmenu("save");
  await pg.waitForTimeout(3000);
  const i = await vinfo();
  check("E1", i.files.length === 2 && i.files.every(f => f.co), "Save to vault with the part's drawing open: both go in, the drawing beside the part, both checked out", { live, files: i.files.map(f => f.path + ":" + f.co), toasts: await toasts() }, await snap(pg, "saved-both"));
});

// E4 The part changed and checked in; its drawing checked in.
await step("E4", "the part changed and checked in; the drawing still checked out lists in its own check-in", async () => {
  await pg.mouse.click(700, 450); await pg.keyboard.press("Control+z"); await idle(pg); await pg.keyboard.press("Control+y"); await idle(pg);
  await pg.keyboard.press("Control+s"); await pg.waitForTimeout(1200);
  await vmenu("ci");
  await pg.waitForSelector(dlg);
  const txt = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " "));
  const img = await snap(pg, "ci-part-dlg");
  await pg.keyboard.type("Part v2");
  await okDlg();
  await pg.waitForTimeout(1500);
  const p = await fileOf(/prt$/), d = await fileOf(/drw$/);
  check("E4", p.n === 2 && !p.co, "Check in of the part: version 2 (does the dialog offer the drawing too?)", { txt: txt.slice(0, 250), part: p, drawing: d }, img);
});

// E5 The drawing is behind the part: the panel says so and Update brings it up to date.
await step("E5", "the drawing uses an older version of the part: the panel shows it behind and Update fixes it", async () => {
  await pickRow((await fileOf(/drw$/)).path);
  await pg.waitForTimeout(500);
  const stale = await pg.$eval("#vault-panel .v-stale", e => e.textContent.replace(/\s+/g, " ")).catch(() => "");
  const behind = await pg.$eval("#vault-panel .v-behind-btn", e => e.textContent).catch(() => "");
  const img = await snap(pg, "behind");
  check("E5", /Part1/.test(stale), "the drawing uses an older version of the part: the panel shows it behind", { stale, behind }, img);
  if (await pg.isVisible('#vault-panel [data-a="upd"]')) {
    await pg.click('#vault-panel [data-a="upd"]');
    await pg.waitForTimeout(2500);
    const stale2 = await pg.$eval("#vault-panel .v-stale", e => e.textContent).catch(() => "");
    const said = (await toasts()).join(" ");
    check("E5b", !stale2 || /working copy/.test(said), "Update brings the drawing up to date, or says the working copy has it already and needs a check-in", { stale2, said }, await snap(pg, "updated"));
  }
});

// F3 Data card.
await step("F3", "data card: part number and description saved, shown in the list", async () => {
  const P = (await fileOf(/prt$/)).path;
  await pickRow(P);
  await pg.click('#vault-panel [data-a="card"]');
  await pg.waitForSelector(dlg);
  const editable = await pg.$eval(`${dlg} [name="c:Part number"]`, e => !e.disabled);
  if (!editable) { await pg.click(`${dlg} button[value="co"]`); await pg.waitForSelector(`${dlg} [name="c:Part number"]:not([disabled])`); }
  await pg.fill(`${dlg} [name="c:Part number"]`, "BRK-001");
  await pg.fill(`${dlg} [name="c:Description"]`, "Mounting block");
  await okDlg();
  await pg.waitForTimeout(1500);
  const f = await fileOf(/prt$/);
  const props = await pg.evaluate(() => { const d = window.__sv.modeller?.store?.doc; return d ? { pn: d.props?.partNumber, desc: d.props?.description } : null; });
  check("F3", f.card["Part number"] === "BRK-001", "data card: part number and description saved; they reach the part's properties", { editableAtFirst: editable, card: f.card, props }, await snap(pg, "card"));
});

// F4 Search.
await step("F4", "search by the part number finds the part", async () => {
  await showPanel();
  await pg.fill("#v-q", "BRK-001");
  await pg.press("#v-q", "Enter");
  await pg.waitForTimeout(800);
  const rows = await pg.$$eval("#vault-panel .v-row .v-name", r => r.map(x => x.textContent));
  check("F4", rows.length === 1 && /prt/.test(rows[0]), "search by the part number finds the part", { rows }, await snap(pg, "search"));
  await pg.click('#vault-panel [data-a="clearq"]').catch(() => {});
});

// F9 Several files: Ctrl+click both, check in both.
await step("F9", "Ctrl+click selects two files; Check in checks in both", async () => {
  const P = (await fileOf(/prt$/)).path, D = (await fileOf(/drw$/)).path;
  await pickRow(P);
  await pickRow(D, ["Control"]);
  const multi = await pg.$eval("#vault-panel .v-multi .v-acts-h", e => e.textContent).catch(() => "");
  await pg.click('#vault-panel [data-a="mci"]');
  await pg.waitForSelector(dlg);
  const img = await snap(pg, "multi-ci");
  await pg.keyboard.type("Both");
  await okDlg();
  await pg.waitForTimeout(2500);
  const i = await vinfo();
  check("F9", /2 files/.test(multi) && i.files.every(f => !f.co), "Ctrl+click selects two files; Check in checks in both", { multi, files: i.files.map(f => `${f.path} v${f.n} ${f.co}`) }, img);
});

// F7 Rename the part: the drawing follows.
await step("F7", "rename the part: the drawing's reference follows", async () => {
  const P = (await fileOf(/prt$/)).path;
  await pickRow(P);
  await pg.click('#vault-panel [data-a="rename"]');
  await pg.waitForSelector(`${dlg} [name="path"]`);
  await pg.fill(`${dlg} [name="path"]`, "Parts/Block.mcadprt");
  await okDlg();
  await pg.waitForTimeout(2000);
  const i = await vinfo();
  await pickRow("Block.mcadprt").catch(() => {});
  await pg.click('#vault-panel [data-a="used"]').catch(() => {});
  await pg.waitForSelector(dlg, { timeout: 3000 }).catch(() => {});
  const used = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " ")).catch(() => "");
  const img = await snap(pg, "renamed");
  await pg.keyboard.press("Escape");
  check("F7", i.files.some(f => f.path === "Parts/Block.mcadprt") && /drw/.test(used), "rename the part into a folder: the drawing still uses it", { files: i.files.map(f => f.path), used: used.slice(0, 200), toasts: await toasts() }, img);
});

// F6 Delete the drawing → recycle bin → restore.
await step("F6", "delete the drawing: it goes to the recycle bin and comes back", async () => {
  const D = (await fileOf(/drw$/)).path;
  await pickRow(D);
  await pg.click('#vault-panel [data-a="del"]');
  await pg.waitForTimeout(500);
  const txt = await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map(d => d.textContent.replace(/\s+/g, " ")).join(" | "));
  if (await pg.isVisible("#confirm[open]")) await pg.click("#confirm [data-a=ok]");
  else await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1200);
  const gone = !(await fileOf(/drw$/));
  await pg.click('#vault-panel [data-a="more"]');
  await pg.click('[data-v="bin"]');
  await pg.waitForSelector(`${dlg} [data-restore]`, { timeout: 4000 });
  const img = await snap(pg, "bin");
  await pg.click(`${dlg} [data-restore]`);
  await pg.waitForTimeout(1500);
  const back = !!(await fileOf(/drw$/));
  check("F6", gone && back, "delete the drawing: it goes to the recycle bin and comes back", { txt: txt.slice(0, 200), gone, back }, img);
});

// C8 Close the part's tab while it is checked out with changes: a reminder.
await step("C8", "closing a part checked out with changes reminds me to check in", async () => {
  await vmenu("co");
  await pg.waitForTimeout(1200);
  await pg.mouse.click(700, 450); await pg.keyboard.press("Control+z"); await idle(pg); await pg.keyboard.press("Control+y"); await idle(pg);
  await pg.keyboard.press("Control+s"); await pg.waitForTimeout(1200);
  const x = await pg.$$("#doc-tabs [data-dtx]");
  const ids = await pg.$$eval("#doc-tabs [data-dtx]", b => b.map(x => x.dataset.dtx + ":" + x.closest("[data-dt]")?.textContent.trim()));
  await pg.click(`#doc-tabs [data-dtx]:near(#doc-tabs [data-dt]:has-text("Block"))`).catch(async () => { if (x[0]) await x[0].click(); });
  await pg.waitForTimeout(800);
  const asked = await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map(d => d.textContent.replace(/\s+/g, " ")).join(" | "));
  const img = await snap(pg, "close-reminder");
  check("C8", /checked out to you/.test(asked), "closing a part checked out with changes reminds me to check in", { tabs: ids, asked: asked.slice(0, 250) }, img);
  await pg.click(`${dlg} button[value="cancel"]`).catch(() => pg.keyboard.press("Escape"));
});

// A3 Close the vault and open it again: everything kept.
await step("A3", "close the vault and open it again from the menu: files, versions, check-outs kept", async () => {
  const before = JSON.stringify((await vinfo()).files.map(f => [f.path, f.n, f.co]));
  await vmenu("close");
  await pg.waitForTimeout(500);
  const asked = await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map(d => d.textContent.replace(/\s+/g, " ")).join(" | "));
  if (await pg.isVisible(`${dlg} button[value="close"]`)) await pg.click(`${dlg} button[value="close"]`);
  await pg.waitForTimeout(800);
  const closed = !(await vinfo());
  const chip = await pg.$eval("#doc-vault", e => e.textContent).catch(() => "");
  await pg.click("#vault-btn");
  await pg.click(`#vault-menu [data-v="ws:${vname}"]`);
  await pg.waitForTimeout(1500);
  const after = JSON.stringify((await vinfo())?.files.map(f => [f.path, f.n, f.co]));
  const chip2 = await pg.$eval("#doc-vault", e => e.textContent).catch(() => "");
  check("A3", closed && before === after && /v\d/.test(chip2), "close the vault and open it again from the menu: files, versions, check-outs kept", { asked: asked.slice(0, 200), chipWhileClosed: chip, chipAfter: chip2, before, after }, await snap(pg, "reopened"));
});

// A4 A page reload: the start card offers the vault.
await step("A4", "after a reload the start card offers the vault used last, and the menu lists it", async () => {
  pg.once("dialog", d => d.accept());
  await pg.reload();
  await pg.waitForFunction(() => window.__sv);
  await pg.waitForTimeout(1500);
  const card = await pg.$eval("#empty-vault", e => e.textContent).catch(() => "");
  await pg.click("#vault-btn");
  await pg.waitForSelector(`#vault-menu [data-v="ws:${vname}"]`, { timeout: 3000 }).catch(() => null);
  const items = await pg.$$eval("#vault-menu [data-v]", b => b.map(x => x.dataset.v));
  await pg.keyboard.press("Escape");
  const img = await snap(pg, "reload");
  if (card) { await pg.click("#empty-vault"); await pg.waitForTimeout(1500); }
  check("A4", card.includes(vname) && items.includes(`ws:${vname}`) && !!(await vinfo()), "after a reload the start card offers the vault used last, and the menu lists it", { card, items }, img);
});

// E6 File ▸ Open drawing of the part opened from the vault finds the drawing.
await step("E6", "File ▸ Open drawing of a vault part finds its drawing in the vault", async () => {
  await pickRow("Block.mcadprt");
  await pg.dblclick(row("Block.mcadprt"));
  await idle(pg); await pg.waitForTimeout(1500);
  await pg.click("#file-btn");
  await pg.click('#file-menu [data-f="open-drawing"]');
  await pg.waitForTimeout(2500);
  const asked = await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map(d => d.id + ": " + d.textContent.replace(/\s+/g, " ")).join(" | "));
  const opened = await pg.evaluate(() => document.getElementById("app").classList.contains("drawing"));
  check("E6", opened || /drw/.test(asked), "File ▸ Open drawing of a vault part finds its drawing in the vault", { asked: asked.slice(0, 250), opened }, await snap(pg, "open-drawing"));
});

console.log("ERRORS", JSON.stringify(pg.errors.slice(0, 10)));
await finish(browser, pg);
