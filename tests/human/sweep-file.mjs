// Sweep: every File menu item and every Evaluate tab command on a part; lists those after which nothing visible
// changed (view screenshot included).
import { createHash } from "node:crypto";
import { open, makeBlock } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweepf");
await makeBlock(pg, 100, 60, 20);
const out = [];
let downloads = 0;
pg.on("download", () => downloads++);
pg.on("filechooser", () => downloads += 100);
const pix = async () => createHash("md5").update(await pg.locator("#viewport").screenshot()).digest("hex");
const state = async () => await sig(pg) + await pix() + "|" + downloads + "|" + await pg.evaluate(() => document.querySelectorAll(".tab-on, [aria-selected=true]").length + document.body.className);
const reset = async () => {
  for (let i = 0; i < 2; i++) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(80); }
  for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close());
  await pg.waitForTimeout(250);
};
await pg.click("#file-btn");
await pg.waitForTimeout(250);
const items = await pg.$$eval("#file-menu [data-f]", e => e.filter(x => x.offsetParent && !x.disabled).map(x => ({ f: x.dataset.f, l: x.textContent.trim().slice(0, 40) })));
await reset();
for (const it of items) {
  if (/^(close|close-all|new|new-asm|new-drw|asm-part|open-drawing|recent:|quit)/.test(it.f) || it.f.includes(":")) { out.push(`skip file | ${it.f}`); continue; }
  await reset();
  await pg.click("#file-btn"); await pg.waitForTimeout(200);
  const a = await state();
  try { await pg.click(`#file-menu [data-f="${it.f}"]`, { timeout: 2000 }); } catch (e) { out.push(`ERR file ${it.f}`); continue; }
  await pg.waitForTimeout(1500);
  const b = await state();
  out.push(`${a !== b ? "ok  " : "NONE"} file | ${it.f} ${it.l}`);
  console.error(out.at(-1));
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepf-${it.f.replace(/\W+/g, "_")}.png` });
}
// Evaluate tab.
await reset();
await pg.locator("#cm [role=tab], #cm .cm-tab", { hasText: "Evaluate" }).first().click();
await pg.waitForTimeout(300);
const cmds = await pg.$$eval("#cm-body button", e => e.filter(x => x.offsetParent && !x.disabled).map(x => (x.querySelector(".mc-l")?.textContent || x.title || x.textContent).trim().slice(0, 40)));
for (const l of [...new Set(cmds)]) {
  if (!l) continue;
  await reset();
  await pg.locator("#cm [role=tab], #cm .cm-tab", { hasText: "Evaluate" }).first().click();
  await pg.waitForTimeout(200);
  const a = await state();
  try { await pg.locator("#cm-body button:visible").filter({ hasText: l }).first().click({ timeout: 2000 }); }
  catch { try { await pg.locator(`#cm-body button[title="${l}"]:visible`).first().click({ timeout: 2000 }); } catch { out.push(`ERR eval ${l}`); continue; } }
  await pg.waitForTimeout(1200);
  const b = await state();
  out.push(`${a !== b ? "ok  " : "NONE"} eval | ${l}`);
  console.error(out.at(-1));
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepf-e-${l.replace(/\W+/g, "_")}.png` });
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
