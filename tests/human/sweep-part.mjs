// Sweep: every part command clicked with nothing selected; lists those after which nothing visible changed.
import { open, makeBlock, idle } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweep");
await makeBlock(pg, 100, 60, 20);
const reset = async () => {
  for (let i = 0; i < 3; i++) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(80); }
  for (const s of ["#mc-cancel", ".pm-cancel"]) { const b = await pg.$(`${s}:visible`); if (b) { await b.click().catch(() => {}); await pg.waitForTimeout(300); } }
  for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close());
  await idle(pg).catch(() => {});
};
const out = [];
const tabs = await pg.$$eval("#cm [id^=cm-t-]", els => els.map(e => e.id.slice(5)));
for (const tab of tabs) {
  await pg.click(`#cm-t-${tab}`).catch(() => {});
  const cmds = await pg.$$eval("#mc-tools [data-c], #mc-tools [data-fly]", els => els.map(e => ({ c: e.dataset.c, fly: e.dataset.fly, l: (e.querySelector(".mc-l") ?? e).textContent.trim(), dis: e.disabled })));
  for (const c of cmds) {
    if (c.dis) continue;
    const items = [];
    if (c.c) items.push({ sel: `#mc-tools [data-c="${c.c}"]`, l: c.l });
    else {
      await pg.click(`#mc-tools [data-fly="${c.fly}"]`); await pg.waitForTimeout(150);
      const ls = await pg.$$eval("#mc-menu button", els => els.map(e => ({ l: e.textContent.trim(), dis: e.disabled })));
      await reset();
      ls.forEach((x, i) => { if (!x.dis) items.push({ fly: c.fly, i, l: `${c.l} > ${x.l}` }); });
    }
    for (const it of items) {
      await pg.click(`#cm-t-${tab}`).catch(() => {});
      const a = await sig(pg);
      try {
        if (it.sel) await pg.click(it.sel, { timeout: 2000 });
        else { await pg.click(`#mc-tools [data-fly="${it.fly}"]`, { timeout: 2000 }); await pg.waitForTimeout(150); await pg.locator("#mc-menu button").nth(it.i).click({ timeout: 2000 }); }
      } catch (e) { out.push(`ERR ${tab} ${it.l}: ${e.message.split("\n")[0]}`); await reset(); continue; }
      await pg.waitForTimeout(700);
      const b = await sig(pg);
      const A = JSON.parse(a), B = JSON.parse(b);
      const diff = Object.keys(A).filter(k => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
      out.push(`${diff.length ? "ok  " : "NONE"} ${tab} | ${it.l} | ${diff.map(k => k + "=" + JSON.stringify(B[k]).slice(0, 70)).join(" ; ")}`);
      console.error(out.at(-1));
      await reset();
    }
  }
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
