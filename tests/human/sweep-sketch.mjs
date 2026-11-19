// Sweep: every sketch tool clicked twice and thrice on an empty sketch (Top); lists those after which the sketch
// gained nothing and nothing visible told the user why.
import { open, makeBlock, clickAt, screenOf } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweeps");
await makeBlock(pg, 100, 60, 20);
const out = [];
const startSketch = async () => {
  await pg.click("#cm-t-sketch").catch(() => {});
  await pg.click('#mc-tools [data-c="sketch"]').catch(() => {});
  await pg.waitForTimeout(300);
  await pg.getByRole("button", { name: "Front (XZ)" }).last().click();
  await pg.waitForTimeout(1200);
};
await startSketch();
const tools = await pg.$$eval("#mc-tools [data-c^='sk:'], #mc-tools [data-fly]", els => els.map(e => ({ c: e.dataset.c, fly: e.dataset.fly, l: (e.querySelector(".mc-l") ?? e).textContent.trim(), dis: e.disabled })));
const items = [];
for (const c of tools) {
  if (c.dis) continue;
  if (c.c) { items.push({ sel: `#mc-tools [data-c="${c.c}"]`, l: c.l }); continue; }
  await pg.click(`#mc-tools [data-fly="${c.fly}"]`); await pg.waitForTimeout(150);
  const ls = await pg.$$eval("#mc-menu button", els => els.map(e => ({ l: e.textContent.trim(), dis: e.disabled })));
  await pg.keyboard.press("Escape");
  ls.forEach((x, i) => { if (!x.dis) items.push({ fly: c.fly, i, l: `${c.l} > ${x.l}` }); });
}
const count = () => pg.evaluate(() => { const m = window.__sv.modeller.mode; return m.kind === "sketch" ? m.editor.sk.ents.length + "/" + m.editor.sk.rels.length + "/" + m.editor.sk.dims.length : m.kind; });
const pts = [[-40, 0, 30], [-10, 0, 45], [-25, 0, 55], [5, 0, 30]];
for (const it of items) {
  if (/DXF|Picture|Insert block|Text/.test(it.l)) { out.push(`skip ${it.l}`); continue; }
  const a = await count(), s0 = await sig(pg);
  try {
    if (it.sel) await pg.click(it.sel, { timeout: 2000 });
    else { await pg.click(`#mc-tools [data-fly="${it.fly}"]`, { timeout: 2000 }); await pg.waitForTimeout(150); await pg.locator("#mc-menu button").nth(it.i).click({ timeout: 2000 }); }
  } catch (e) { out.push(`ERR ${it.l}: ${e.message.split("\n")[0]}`); continue; }
  await pg.waitForTimeout(250);
  for (const p of pts) await clickAt(pg, await screenOf(pg, p));
  await pg.keyboard.press("Escape"); await pg.waitForTimeout(150);
  const b = await count(), s1 = await sig(pg);
  out.push(`${a !== b ? "ok  " : s0 !== s1 ? "msg " : "NONE"} ${it.l} ${a} -> ${b}`);
  console.error(out.at(-1));
  if (typeof b !== "string" || !b.includes("/")) { await startSketch(); continue; }
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Control+a"); await pg.keyboard.press("Delete"); await pg.waitForTimeout(150);
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
