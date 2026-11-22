// A temperature map from another tool by hand (FRS-thermal FR-TPKG-014): a plain .vtu with no manifest, no PartId,
// the temperature under another name and in kelvin.
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const FX = "tests/fixtures/thermal";
const { browser, pg } = await open("thermalvtu");
const st = () => pg.evaluate(() => window.__sv.thermal.state());
const toasts = () => pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map(e => e.textContent).join(" | "));

// TV-1: opening it asks which point array is the temperature.
await openFiles(pg, [`${FX}/other-tool.vtu`]);
await pg.waitForSelector("dialog.choose-dlg [data-choose]", { timeout: 20000 });
const d1 = await pg.evaluate(() => ({ title: document.querySelector("dialog.choose-dlg h3")?.textContent, opts: [...document.querySelectorAll("dialog.choose-dlg [data-choose]")].map(b => b.textContent) }));
check("TV-1", /temperature/.test(d1.title ?? "") && JSON.stringify(d1.opts) === '["Flux","Field_K"]', "a .vtu with two candidate arrays and no Temperature_C asks which one holds the temperatures", d1, await snap(pg, "ask"));

// TV-2: Esc leaves nothing open.
await pg.keyboard.press("Escape");
await pg.waitForTimeout(400);
check("TV-2", !(await st()) && !(await pg.$("dialog.choose-dlg")), "Esc on the question opens nothing", {}, await snap(pg, "cancelled"));

// TV-3: open it again and pick Field_K: kelvin shown as °C, the two pieces become parts #1 and #2.
await openFiles(pg, [`${FX}/other-tool.vtu`]);
await pg.waitForSelector("dialog.choose-dlg [data-choose]", { timeout: 20000 });
await pg.click('dialog.choose-dlg [data-choose="Field_K"]');
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 60000 });
await idle(pg);
await pg.waitForTimeout(600);
const s3 = await st(), t3 = await toasts();
const rows = await pg.evaluate(() => [...document.querySelectorAll("#th-side tbody tr")].map(r => r.innerText.replace(/\s+/g, " ").trim()));
check("TV-3", s3.parts === 2 && Math.abs(s3.range[0] - 20) < 0.01 && Math.abs(s3.range[1] - 65) < 0.01 && /kelvin/.test(t3) && /connected piece/.test(t3) && rows.some(r => /^#2/.test(r)),
  "picking Field_K shows 20 to 65 °C (read as kelvin) on the file's own surfaces, with its two pieces listed as parts #1 and #2", { s3: { range: s3.range, parts: s3.parts, hottest: s3.hottest }, t3, rows }, await snap(pg, "map"));

// TV-4: hovering the hot piece reads its temperature.
const p = await pg.evaluate(() => window.__sv.thermal.screenOf([25, 5, 5]));
await pg.mouse.move(p.x, p.y);
await pg.waitForTimeout(400);
const v = await pg.evaluate(([x, y]) => window.__sv.thermal.valueAt(x, y), [p.x, p.y]);
check("TV-4", v && v.part === 2 && v.t > 50 && v.t < 65, "the pointer over the hotter square reads a temperature between 50 and 65 °C on part #2", v, await snap(pg, "hover"));
await finish(browser, pg);
