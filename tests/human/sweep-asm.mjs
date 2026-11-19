// Sweep: every item of an assembly component's right-click menu (tree row and view), and every assembly command,
// on an assembly of two instances of a block; lists those after which nothing visible changed.
import { open, makeBlock } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweepa");
await makeBlock(pg, 100, 60, 20);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
const row = () => pg.locator("#asm-tree .ft-row").filter({ hasText: "<1>" }).first();
await row().click();
await pg.keyboard.press("Control+c");
await pg.mouse.move(800, 400);
await pg.keyboard.press("Control+v");
await pg.waitForTimeout(2500);
const reset = async () => {
  for (let i = 0; i < 3; i++) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(80); }
  for (const s of [".pm-cancel"]) { const b = await pg.$(`#asm-pm ${s}:visible`); if (b) { await b.click().catch(() => {}); await pg.waitForTimeout(300); } }
  for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close());
  await pg.waitForTimeout(300);
};
const extra = () => pg.evaluate(() => JSON.stringify({
  comps: window.__sv.asm?.doc?.components?.map(c => [c.name, !!c.hidden, !!c.fixed, !!c.suppressed, c.color ?? "", c.opacity ?? 1].join("/")),
  rows: [...document.querySelectorAll("#asm-tree .ft-row")].map(r => r.className + ":" + r.textContent.trim().slice(0, 30)).join("|").length,
  bar: [...document.querySelectorAll("#asm-iso:not([hidden]), #asm-matebar")].length,
}));
const out = [];
const menuItems = async () => (await pg.$$eval("#asm-menu button", els => els.map(e => ({ l: e.textContent.trim(), dis: e.disabled })))).filter(x => !x.dis);
await row().click({ button: "right" });
await pg.waitForTimeout(250);
const items = await menuItems();
await reset();
for (const it of items) {
  if (/Delete|Replace|Open|Edit in|Buy|Material|Rename/.test(it.l)) { out.push(`skip menu ${it.l}`); continue; }
  await row().click();
  await row().click({ button: "right" });
  await pg.waitForTimeout(200);
  const a = await sig(pg) + await extra();
  try { await pg.locator("#asm-menu button", { hasText: it.l }).first().click({ timeout: 2000 }); }
  catch (e) { out.push(`ERR menu ${it.l}`); await reset(); continue; }
  await pg.waitForTimeout(900);
  const b = await sig(pg) + await extra();
  out.push(`${a !== b ? "ok  " : "NONE"} menu | ${it.l}`);
  console.error(out.at(-1));
  await reset();
  if (/Hide|Suppress|Isolate|transparent/i.test(it.l)) {
    await row().click({ button: "right" }); await pg.waitForTimeout(200);
    const back = (await menuItems()).find(x => /Show|Unsuppress|Exit|Resolve/i.test(x.l));
    if (back) { await pg.locator("#asm-menu button", { hasText: back.l }).first().click(); await pg.waitForTimeout(900); }
    await reset();
  }
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
