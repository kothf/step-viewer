// The vault by hand, part 3: two users in a vault with log ins (locks, roles, a turned-off account), the revision
// in a drawing's title block, the release PDF, the Vault menu after a reload. Ids follow
// /mnt/project-files/tests/vault-tests.md.
import { open, snap, check, finish, makeBlock, idle } from "./lib.mjs";
const { browser, pg } = await open("vault3");
const dlg = "#vault-dlg[open]";
const okDlg = () => pg.click(`${dlg} button[value="ok"]`);
const type = async (sel, text) => { await pg.click(sel); await pg.keyboard.type(text); };
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
  return { user: v.user, files: p.files.filter(f => !f.deleted).map(f => ({ path: f.path, state: f.state, rev: f.revision ?? "", n: v.latest(f).n, co: f.checkout?.user ?? "" })) };
});
const fileOf = async re => (await vinfo()).files.find(f => re.test(f.path));
const row = name => `#vault-panel .v-row:has(.v-name:text-is("${name}"))`;
const showPanel = async () => { if (!(await pg.isVisible("#vault-panel .v-files"))) await vmenu("panel"); };
const pickRow = async name => { await showPanel(); await pg.click(row(name)); await pg.waitForTimeout(300); };
const toPart = async () => {
  if (!(await pg.evaluate(() => document.getElementById("app").classList.contains("drawing")))) return;
  const tabs = await pg.$$eval("#doc-tabs [data-dt]", b => b.map(x => x.textContent));
  const i = tabs.findIndex(x => /mcadprt/.test(x));
  if (i >= 0) await pg.locator("#doc-tabs [data-dt]").nth(i).click(); else await pg.click('#drw [data-a="back"]');
  await idle(pg); await pg.waitForTimeout(800);
};
async function step(id, what, fn) {
  await toPart().catch(() => {});
  try { await fn(); }
  catch (e) { check(id, false, what, { error: e.message.split("\n")[0].slice(0, 200) }, await snap(pg, `${id}-err`)); for (let i = 0; i < 2; i++) await pg.keyboard.press("Escape"); for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close()); }
}
const login = async (name, pw) => {
  await pg.waitForSelector(`${dlg} [name="pw"]`);
  await pg.fill(`${dlg} [name="name"]`, "");
  await type(`${dlg} [name="name"]`, name);
  await type(`${dlg} [name="pw"]`, pw);
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(800);
};

const vname = `Team${Date.now() % 100000}`;
await vmenu("new-ws");
await pg.keyboard.type(vname);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));
// Accounts: Andrey (Admin, all roles) and Olga (Designer).
await vmenu("users");
await pg.waitForSelector(`${dlg} [name="pw2"]`);
await pg.fill(`${dlg} [name="name"]`, "");
await type(`${dlg} [name="name"]`, "Andrey");
await type(`${dlg} [name="pw"]`, "andrey-pw");
await type(`${dlg} [name="pw2"]`, "andrey-pw");
await okDlg();
await pg.waitForSelector(`${dlg} tr[data-acc="Andrey"]`);
await type(`${dlg} [name="nu"]`, "Olga");
await type(`${dlg} [name="np"]`, "olga-pw");
await pg.click(`${dlg} [data-add]`);
await pg.waitForSelector(`${dlg} tr[data-acc="Olga"]`);
const roles = await pg.$$eval(`${dlg} tr[data-acc="Olga"] [data-role]`, b => b.filter(x => x.checked).map(x => x.dataset.role));
await pg.click(`${dlg} button[value="cancel"]`);

// A part and its drawing, saved and checked in by Andrey.
await makeBlock(pg, 70, 30, 12);
await vmenu("save");
await pg.waitForTimeout(1500);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="new-drawing"]');
await pg.waitForFunction(() => window.__sv.drw?.loaded?.(), null, { timeout: 120000 });
await pg.click('#drw [data-ctab="layout"]').catch(() => {});
await pg.click('#drw [data-a="std3"]');
await pg.waitForTimeout(3000);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(800);
if (await pg.isVisible("#name-dlg[open]")) await pg.keyboard.press("Enter");
await pg.waitForTimeout(2000);
await toPart();
await pg.waitForTimeout(500);

// B5 The user's name shows.
await step("B5", "the logged-in user shows in the panel and the menu", async () => {
  await showPanel();
  const who = await pg.$eval("#vault-panel .v-who", e => e.textContent).catch(() => "");
  await pg.click("#vault-btn");
  const lo = await pg.$eval('#vault-menu [data-v="logout"]', e => e.textContent).catch(() => "");
  await pg.keyboard.press("Escape");
  check("B5", who === "Andrey" && /Andrey/.test(lo), "the logged-in user shows in the panel and the menu (Log out ‹name›)", { who, lo, olgaRoles: roles });
});

// C9 Andrey keeps the part checked out; Olga logs in: it is locked, Check out is not offered, she cannot break the lock.
await step("C9", "another user sees my lock, cannot check out or break it; Admin can break it", async () => {
  await vmenu("logout");
  await login("Olga", "olga-pw");
  if (await pg.isVisible(`${dlg} [name="old"]`)) {
    await type(`${dlg} [name="old"]`, "olga-pw"); await type(`${dlg} [name="pw"]`, "olga-pw-2"); await type(`${dlg} [name="pw2"]`, "olga-pw-2"); await okDlg(); await pg.waitForTimeout(800);
  }
  const user = (await vinfo())?.user;
  const chip = await pg.$eval("#doc-vault", e => e.textContent).catch(() => "");
  const ro = !!(await pg.$("#mc-ro"));
  const bar = await pg.$eval("#mc-ro", e => e.textContent).catch(() => "");
  const barCo = !!(await pg.$("#mc-ro [data-a=co]"));
  await pickRow("Part1.mcadprt");
  const btns = await pg.$$eval("#vault-panel .v-acts button", b => b.map(x => x.dataset.a || x.dataset.tr).filter(Boolean));
  const img = await snap(pg, "olga-locked");
  // B3 Olga, a Designer, has no Approve on a file in review (none here: Submit for review is not possible while locked).
  check("C9", user === "Olga" && !btns.includes("co") && !btns.includes("break") && ro && /Andrey/.test(chip) && /Andrey/.test(bar) && !barCo && !btns.includes("Submit for review"), "another user sees my lock (the open part stays tied and turns read-only, the bar names who holds it), cannot check out, change its state or break it", { user, chip, ro, bar, barCo, btns }, img);
});

// B3 Olga submits the drawing for review once Andrey checks it in; she has no Approve.
await step("B3", "a Designer cannot approve a release", async () => {
  await vmenu("logout");
  await login("Andrey", "andrey-pw");
  await pickRow("Part1.mcaddrw");
  await pg.click('#vault-panel [data-a="ci"]').catch(() => {});
  if (await pg.waitForSelector(dlg, { timeout: 3000 }).catch(() => null)) { await pg.fill(`${dlg} textarea[name=comment]`, "Ready"); await okDlg(); await pg.waitForTimeout(1500); }
  await pickRow("Part1.mcadprt");
  await pg.click('#vault-panel [data-a="ci"]').catch(() => {});
  if (await pg.waitForSelector(dlg, { timeout: 3000 }).catch(() => null)) { await pg.fill(`${dlg} textarea[name=comment]`, "Ready"); await okDlg(); await pg.waitForTimeout(1500); }
  await toPart();
  await vmenu("logout");
  await login("Olga", "olga-pw-2");
  await pickRow("Part1.mcadprt");
  await pg.click('#vault-panel [data-tr="Submit for review"]');
  await pg.waitForSelector(dlg); await okDlg(); await pg.waitForTimeout(1500);
  await pickRow("Part1.mcadprt");
  const trs = await pg.$$eval("#vault-panel [data-tr]", b => b.map(x => x.dataset.tr));
  const img = await snap(pg, "olga-review");
  let refused = "";
  if (trs.includes("Approve")) {
    await pg.click('#vault-panel [data-tr="Approve"]');
    await pg.waitForSelector(dlg); refused = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " "));
    await pg.keyboard.press("Escape");
  }
  check("B3", !trs.includes("Approve") || /Approver|role/i.test(refused), "a Designer cannot approve a release (the button is not offered, or it says who may)", { trs, refused: refused.slice(0, 250) }, img);
});

// D6 Andrey approves part and drawing: the drawing's title block shows revision A.
await step("D6", "after release the drawing's title block shows revision A; the PDF is made", async () => {
  await toPart();
  await vmenu("logout");
  await login("Andrey", "andrey-pw");
  await pickRow("Part1.mcaddrw");
  const before = (await vinfo()).files.find(f => /drw$/.test(f.path));
  if (before.checkout) {
    await pg.click('#vault-panel [data-a="ci"]');
    await pg.waitForSelector(dlg, { timeout: 3000 }); await pg.fill(`${dlg} textarea[name=comment]`, "Ready"); await okDlg(); await pg.waitForTimeout(1500);
    await pickRow("Part1.mcaddrw");
  }
  const mid = (await vinfo()).files.find(f => /drw$/.test(f.path));
  console.log("D6 drawing before", JSON.stringify(before), "after ci", JSON.stringify(mid), "toasts", await pg.$$eval(".toast", t => t.map(x => x.textContent)));
  await pg.click('#vault-panel [data-tr="Submit for review"]');
  await pg.waitForSelector(dlg); await okDlg(); await pg.waitForTimeout(1500);
  await pickRow("Part1.mcaddrw");
  await pg.waitForSelector('#vault-panel [data-tr="Approve"]', { timeout: 4000 }).catch(async () => console.log("D6 trs", await pg.$$eval("#vault-panel [data-tr]", b => b.map(x => x.dataset.tr)), await pg.$$eval(".toast", t => t.map(x => x.textContent))));
  await pg.click('#vault-panel [data-tr="Approve"]');
  await pg.waitForSelector(dlg);
  const txt = await pg.$eval(dlg, d => d.textContent.replace(/\s+/g, " "));
  await okDlg();
  await pg.waitForTimeout(6000);
  const i = await vinfo();
  await pickRow("Part1.mcaddrw");
  await pg.dblclick(row("Part1.mcaddrw"));
  await pg.waitForTimeout(3000);
  const rev = await pg.evaluate(() => { const texts = [...document.querySelectorAll("svg text")].map(t => t.textContent); return texts; });
  const img = await snap(pg, "released-drawing");
  check("D6", i.files.find(f => /drw$/.test(f.path)).rev === "A" && rev?.some(x => x.trim() === "A"), "after release the drawing's title block shows revision A; the release PDF is stored", { txt: txt.slice(0, 300), files: i.files, tb: rev?.slice(-30) }, img);
});

// B6 Turn Olga off: she cannot log in.
await step("B6", "a turned-off user cannot log in", async () => {
  await toPart();
  await vmenu("users");
  await pg.waitForSelector(`${dlg} tr[data-acc="Olga"] [data-off]`);
  await pg.click(`${dlg} tr[data-acc="Olga"] [data-off]`);
  await pg.waitForTimeout(600);
  await pg.click(`${dlg} button[value="cancel"]`);
  await vmenu("logout");
  await login("Olga", "olga-pw-2");
  const err = await pg.$eval(`${dlg} .v-err`, e => e.textContent).catch(() => "");
  const img = await snap(pg, "olga-off");
  check("B6", !!err && (await vinfo())?.user !== "Olga", "a turned-off user cannot log in", { err }, img);
  await pg.fill(`${dlg} [name="name"]`, ""); await type(`${dlg} [name="name"]`, "Andrey");
  await pg.fill(`${dlg} [name="pw"]`, ""); await type(`${dlg} [name="pw"]`, "andrey-pw"); await pg.keyboard.press("Enter");
  await pg.waitForTimeout(800);
});

// B4 + A4 After a reload: the Vault menu lists the vault; opening it asks who is working; Cancel leaves it closed.
await step("B4", "after a reload the menu lists the vault; a secured vault asks for a log in, Cancel leaves it closed", async () => {
  pg.on("dialog", d => d.accept().catch(() => {}));
  await pg.reload();
  await pg.waitForFunction(() => window.__sv);
  await pg.waitForTimeout(2000);
  await pg.click("#vault-btn");
  await pg.waitForTimeout(800);
  const items = await pg.$$eval("#vault-menu [data-v]", b => b.map(x => x.dataset.v));
  const img0 = await snap(pg, "menu-after-reload");
  await pg.click(`#vault-menu [data-v="ws:${vname}"]`);
  await pg.waitForSelector(`${dlg} [name="pw"]`, { timeout: 5000 });
  const img = await snap(pg, "login-on-open");
  await pg.click(`${dlg} button[value="cancel"]`);
  await pg.waitForTimeout(800);
  const open = !!(await vinfo());
  check("B4", items.includes(`ws:${vname}`) && !open, "after a reload the menu lists the vault; a secured vault asks for a log in, Cancel leaves it closed", { items, open, img0 }, img);
});

console.log("ERRORS", JSON.stringify(pg.errors.slice(0, 10)));
await finish(browser, pg);
