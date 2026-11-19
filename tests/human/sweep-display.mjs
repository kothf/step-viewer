// Sweep: every control of the Display menu and the heads-up view bar on a part; lists those after which nothing
// visible changed (the canvas pixels are compared too, so render-only options count).
import { open, makeBlock } from "./lib.mjs";
import { sig } from "./sweep-lib.mjs";
const { browser, pg } = await open("sweepd");
await makeBlock(pg, 100, 60, 20);
const out = [];
const pix = async () => { const b = await pg.locator("#viewport").screenshot(); return (await import("node:crypto")).createHash("md5").update(b).digest("hex"); };
const reset = async () => {
  for (let i = 0; i < 2; i++) { await pg.keyboard.press("Escape"); await pg.waitForTimeout(80); }
  for (const d of await pg.$$("dialog[open]")) await d.evaluate(d => d.close());
  await pg.mouse.click(5, 880);
  await pg.waitForTimeout(250);
};
const menu = async () => { await reset(); await pg.click("#display-btn"); await pg.waitForTimeout(250); };
await menu();
const ctrls = await pg.$$eval("#display-menu input, #display-menu select, #display-menu button", e => e.filter(x => x.offsetParent && !x.disabled).map((x, i) => ({ i, tag: x.tagName, id: x.id, l: (x.closest("label")?.textContent || x.textContent || x.id).trim().slice(0, 40) })));
for (const c of ctrls) {
  await menu();
  const a = await sig(pg) + await pix();
  const all = await pg.$$("#display-menu input, #display-menu select, #display-menu button");
  const vis = [];
  for (const x of all) if (await x.evaluate(x => !!x.offsetParent && !x.disabled)) vis.push(x);
  const h = vis[c.i];
  try {
    if (c.tag === "SELECT") { const opts = await h.evaluate(s => [...s.options].map(o => o.value)); const cur = await h.evaluate(s => s.value); await h.selectOption(opts.find(o => o !== cur) ?? cur); }
    else await h.click({ timeout: 2000 });
  } catch (e) { out.push(`ERR disp ${c.l}`); continue; }
  await pg.waitForTimeout(800);
  const b = await sig(pg) + await pix();
  out.push(`${a !== b ? "ok  " : "NONE"} disp | ${c.tag} ${c.id} ${c.l}`);
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepd-${c.i}.png` });
  // Put it back.
  await menu();
  const all2 = await pg.$$("#display-menu input, #display-menu select, #display-menu button");
  const vis2 = [];
  for (const x of all2) if (await x.evaluate(x => !!x.offsetParent && !x.disabled)) vis2.push(x);
  if (c.tag === "INPUT" && vis2[c.i]) await vis2[c.i].click().catch(() => {});
}
await reset();
const huds = await pg.$$eval("#hud [data-hud], #hud button, #hud select", e => e.filter(x => x.offsetParent).map(x => x.dataset.hud || x.id || x.title));
for (const hb of [...new Set(huds)]) {
  if (!hb) continue;
  await reset();
  const a = await sig(pg) + await pix();
  try { await pg.locator(`#hud [data-hud="${hb}"]:visible, #hud [id="${hb}"]:visible, #hud [title="${hb}"]:visible`).first().click({ timeout: 2000 }); }
  catch (e) { out.push(`ERR hud ${hb}`); continue; }
  await pg.waitForTimeout(800);
  const b = await sig(pg) + await pix();
  out.push(`${a !== b ? "ok  " : "NONE"} hud | ${hb}`);
  await pg.screenshot({ path: `${process.env.HT_OUT ?? "/tmp"}/sweepd-h-${hb.replace(/\W+/g, "_")}.png` });
}
console.log(out.join("\n"));
console.log("ERRORS", pg.errors.slice(0, 20));
await browser.close();
