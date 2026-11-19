// Sweep: every Vault menu item on a part saved to a browser vault; lists those after which nothing visible changed.
import { open, makeBlock } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweepv");
await makeBlock(pg, 100, 60, 20);
const out = [];
const reset = async () => {
  for (let i = 0; i < 3; i++) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(80); }
  for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close());
  await pg.waitForTimeout(300);
};
const vmenu = async () => { await reset(); await pg.click("#vault-btn"); await pg.waitForTimeout(300); };
await vmenu();
console.error("closed menu:", await pg.$$eval("#vault-menu [data-v]", e => e.map(x => x.dataset.v + (x.disabled ? "-" : "")).join(",")));
await pg.click('#vault-menu [data-v="new-ws"]');
await pg.waitForTimeout(800);
console.error("after new-ws:", await sig(pg));
// The name box has focus: typing a name and Enter makes the vault.
await pg.keyboard.type("Sweep");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(1500);
console.error("vault open after Enter:", await pg.evaluate(() => document.querySelector("#vault-btn").classList.contains("on")));
await vmenu();
await pg.click('#vault-menu [data-v="save"]').catch(e => out.push("ERR save " + e.message.slice(0, 80)));
await pg.waitForTimeout(2000);
await vmenu();
const items = await pg.$$eval("#vault-menu [data-v]", e => e.map(x => ({ v: x.dataset.v, dis: x.disabled, l: x.textContent.trim() })));
console.error("open menu:", items.map(x => x.v + (x.dis ? "-" : "")).join(","));
for (const it of items) {
  if (it.dis) { out.push(`dis  vault | ${it.v}`); continue; }
  if (/^(close|add|addfolder)$/.test(it.v) || it.v.includes(":")) { out.push(`skip vault | ${it.v}`); continue; }
  await vmenu();
  const a = await sig(pg);
  try { await pg.click(`#vault-menu [data-v="${it.v}"]`, { timeout: 2000 }); } catch (e) { out.push(`ERR vault ${it.v}`); continue; }
  await pg.waitForTimeout(1200);
  const b = await sig(pg);
  out.push(`${a !== b ? "ok  " : "NONE"} vault | ${it.v} ${it.l}`);
  console.error(out.at(-1), b.slice(0, 200));
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepv-${it.v}.png` });
}
// Vault explorer: select the part's row, then every toolbar/detail button.
const vx = () => pg.evaluate(() => { const e = document.querySelector("#vault-ex"); return (e?.innerHTML.length ?? 0) + "|" + [...document.querySelectorAll(".mc-menu, [role=menu]")].filter(m => m.offsetParent).length; });
const exReset = async () => { await reset(); if (!(await pg.$("#vault-ex:not([hidden])"))) { await vmenu(); await pg.click('#vault-menu [data-v="explorer"]'); await pg.waitForTimeout(800); } await pg.click("#vault-ex .vx-row").catch(() => {}); await pg.waitForTimeout(300); };
await exReset();
const xs = await pg.$$eval("#vault-ex [data-x]", e => e.filter(x => x.offsetParent && !x.disabled).map(x => x.dataset.x));
console.error("explorer buttons:", xs.join(","));
for (const x of [...new Set(xs)]) {
  if (/^(add|opendir|open|bomcsv)$/.test(x)) { out.push(`skip vx | ${x}`); continue; }
  await exReset();
  const a = await sig(pg) + await vx();
  try { await pg.click(`#vault-ex [data-x="${x}"]:visible`, { timeout: 2000 }); } catch (e) { out.push(`ERR vx ${x}`); continue; }
  await pg.waitForTimeout(1000);
  const b = await sig(pg) + await vx();
  out.push(`${a !== b ? "ok  " : "NONE"} vx | ${x}`);
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepv-x-${x}.png` });
}
// Right-click menu of a file row in the explorer.
await exReset();
await pg.click("#vault-ex .vx-row", { button: "right" });
await pg.waitForTimeout(400);
const rm = await pg.$$eval("#v-menu button, .mc-menu button", e => e.filter(x => x.offsetParent && !x.disabled).map(x => x.textContent.trim()));
console.error("row menu:", rm.join(" | "));
for (const l of rm) {
  if (/Delete|Remove|Destroy|Rename|Move|Download|Export|Add|Open/.test(l)) { out.push(`skip row | ${l}`); continue; }
  await exReset();
  await pg.click("#vault-ex .vx-row", { button: "right" });
  await pg.waitForTimeout(300);
  const a = await sig(pg) + await vx();
  try { await pg.locator("#v-menu button:visible, .mc-menu button:visible", { hasText: l }).first().click({ timeout: 2000 }); } catch (e) { out.push(`ERR row ${l}`); continue; }
  await pg.waitForTimeout(1000);
  const b = await sig(pg) + await vx();
  out.push(`${a !== b ? "ok  " : "NONE"} row | ${l}`);
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepv-r-${l.replace(/\W+/g, "_")}.png` });
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
