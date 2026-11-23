// Comparing thermal results (FRS-thermal FR-TRES-030): a study with its own result before the last change, and with
// another thermal study; temperatures differ in K, the heat put in in %.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalcmp");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const top = async () => clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="temp"]');
await top();
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
const table = () => pg.evaluate(() => ({ none: document.querySelector('#sim-tree [data-v="cmpnone"]')?.textContent ?? "", opts: [...document.querySelectorAll('#sim-tree [data-k="cmp"] option')].map(o => [o.value, o.textContent]),
  rows: [...document.querySelectorAll("#sim-tree .sim-cmptable tbody tr")].map(r => [r.dataset.cmp, ...[...r.cells].map(c => c.textContent)]) }));
const c1 = await table();
check("TC-1", !s1.error && /Nothing to compare/.test(c1.none) && !c1.rows.length, "first solve: nothing to compare with yet, and the Study tab says so", { c1, max: s1.thermal?.max }, await snap(pg, "first"));

// the heat raised to 20 W and solved again: compared with the 10 W result
await pg.click('#sim-tree .sim-heat .sim-row [data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-n="value"]', "20 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), c2 = await table();
const tmax = c2.rows.find(r => r[0] === "tmax"), heat = c2.rows.find(r => r[0] === "heat");
check("TC-2", !s2.error && c2.opts[0]?.[0] === "prev" && s2.compare?.with === "prev" && Math.abs(s2.compare.rows[0].diff - (s2.thermal.max - s1.thermal.max)) < 1e-6 && /^\+[\d.]+ K$/.test(tmax?.[4] ?? "") && heat?.[4] === "+100 %",
  "20 W instead of 10: compared with the result before the change; the highest temperature went up by the shown K and the heat put in by 100 %", { c2, max: [s1.thermal.max, s2.thermal.max] }, await snap(pg, "compare-before"));

// a copy of the study with the top face at 60 °C, compared with the first study
await pg.click('#sim-tree [data-a="dupstudy"]');
await idle(pg);
await pg.click('#sim-tree .sim-cool .sim-row [data-a="edit"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-q="temp"]', "60");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
let c3 = await table();
const other = c3.opts.find(o => o[0] !== "prev");
if (other) { await pg.selectOption('#sim-tree [data-k="cmp"]', other[0]); await idle(pg); }
c3 = await table();
const s3b = await sim();
check("TC-3", !s3.error && other && /Thermal 1/.test(other[1]) && s3b.compare?.with === other[0] && Math.abs(s3b.compare.rows.find(r => r.key === "tmin").diff - 20) < 0.05 && c3.rows.find(r => r[0] === "heat")?.[4] === "0 %",
  "the copy with the top face at 60 °C picks the first study to compare with: every temperature is 20 K higher, the heat the same", { c3, compare: s3b.compare }, await snap(pg, "compare-study"));

// in Russian the compare table has no English left but the study name
await pg.click("#lang-btn");
await idle(pg);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-cmptable *, #sim-tree [data-k=cmp] option")].filter(e => !e.children.length && !e.closest("[translate=no]") && !e.matches("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
check("TC-4", ru.length === 0, "the compare table in Russian", { ru }, await snap(pg, "ru"));
await pg.click("#lang-btn");
await finish(browser, pg);
