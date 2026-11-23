// Where each component's heat goes by hand (FRS-thermal FR-TRES-005): two blocks end to end, 4 W made in one, the
// other's far end held at 20 °C and every open face cooled by convection: the table splits each block's heat into
// air, fixed temperature and neighbours, adding up to what it makes; the report and the heat balance CSV list it.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalheatout");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
// the part gets its material first: every component is analysed with its part's
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await pg.click('#asm-tools [data-ac="insert"]');
await pg.waitForTimeout(300);
await pg.getByText(/^Open document:/).first().click();
await pg.waitForTimeout(800);
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await clickAt(pg, [vp[0] + 220, vp[1] - 120]);
await pg.waitForTimeout(1500);

// the second block goes end to end with the first, 0.05 mm away: typed in the Move panel
const rows = await pg.$$("#asm-tree .ft-row[data-id]");
const comps = [];
for (const r of rows) if (/Block|Part|<\d+>/.test(await r.innerText())) comps.push(r);
await comps[comps.length - 1].click();
await pg.waitForTimeout(300);
await pg.click('#asm-tools [data-ac="move"]');
await pg.waitForSelector('#asm-pm input[data-pose="x"]');
for (const [k, v] of [["x", "100.05"], ["y", "0"], ["z", "0"], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
  const i = await pg.$(`#asm-pm input[data-pose="${k}"]`);
  await i.fill(v); await i.press("Enter");
  await pg.waitForTimeout(500);
}
if (await pg.isVisible("#asm-pm [data-a=ok]")) await pg.click("#asm-pm [data-a=ok]");
await pg.waitForTimeout(1500);
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("f");
await pg.waitForTimeout(900);
const placed = await pg.evaluate(() => window.__sv.viewer.parts.map(p => [p.data.bboxMin.map(v => Math.round(v * 100) / 100), p.data.bboxMax.map(v => Math.round(v * 100) / 100)]));
check("THA-1", placed.length === 2 && Math.abs(placed[1][0][0] - placed[0][1][0] - 0.05) < 1e-6, "two blocks stand end to end, 0.05 mm apart", placed, await snap(pg, "two-blocks"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const x1 = placed[1][1][0], x0 = placed[0][0][0], zt = placed[0][1][2], ym = (placed[0][0][1] + placed[0][1][1]) / 2;
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);

// THA-2: Thermal works over an assembly; a fixed temperature on the second block's far end makes the study.
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [x1, ym, zt / 2]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// 4 W made throughout the first block: one of its faces is clicked, then Throughout the whole component
await pg.click('#sim-tools [data-s="heat"]');
await clickAt(pg, await screenOf(pg, [(x0 + placed[0][1][0]) / 2, ym, zt]));
await pg.waitForTimeout(250);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "4");
await pg.press('#sim-pm [data-n="value"]', "Tab");
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
// convection on every open face, 10 W/(m²·K)
await pg.click('#sim-tools [data-s="conv"]');
await pg.waitForTimeout(250);
await pg.check('#sim-pm [data-k="all"]');
await pg.fill('#sim-pm [data-q="hc"]', "10");
await pg.press('#sim-pm [data-q="hc"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
check("THA-2", /face/.test(picked), "the far end is held at 20 °C, 4 W are made in the first block and every open face has convection", { picked }, await snap(pg, "set-up"));

// THO-1: after solving, Where the heat goes splits each block's heat; each row adds up to the heat it makes.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), tc = s1.thermal?.comps ?? [];
await pg.locator("#sim-tree .sim-heatout").scrollIntoViewIfNeeded();
const table = await pg.evaluate(() => ({ head: [...document.querySelectorAll("#sim-tree .sim-heatout th")].map(e => e.textContent), rows: [...document.querySelectorAll("#sim-tree .sim-heatout tbody tr")].map(tr => [...tr.children].map(td => td.textContent)) }));
const sums = tc.map(c => c.conv + c.rad + c.held + c.cond - c.power);
check("THO-1", !s1.error && tc.length === 2 && table.rows.length === 2 && table.head.length === 4 && sums.every(v => Math.abs(v) < 0.08) && tc[0].cond > 0 && tc[1].held > 0 && tc.every(c => c.conv > 0),
  "the heated block passes most of its heat to the other and some to the air; the other gives it to the held end and the air; each row adds up", { error: s1.error, tc, table, sums }, await snap(pg, "heat-out"));

// THO-2: hovering the Neighbours cell names the block the heat goes to; a row click shows that block alone.
const tip = await pg.locator('#sim-tree .sim-heatout tbody tr').first().locator('[data-v="hocond"]').getAttribute("title");
await pg.locator('#sim-tree .sim-heatout tbody tr').first().click();
await idle(pg);
const alone = (await sim()).compSel;
check("THO-2", /: \d/.test(tip ?? "") && alone === 0, "the Neighbours cell's tooltip names the other block and its watts; clicking the row shows the heated block alone", { tip, alone }, await snap(pg, "heat-out-alone"));
await pg.click('#sim-tree [data-a="rcompall"]');
await idle(pg);

// THO-3: the heat balance CSV and the report carry the split.
const csv = (await sim()).balanceCsv ?? "";
await pg.click('#sim-tools [data-s="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
const path = `${process.env.HT_OUT ?? "/mnt/project-files/gap-tests"}/thermalheatout-report.html`;
await dl.saveAs(path);
const blocks = (await import("node:fs")).readFileSync(path, "utf8");
check("THO-3", /Component to the air,/.test(csv) && /Component conducted to neighbours,/.test(csv) && /Where the heat goes/.test(blocks),
  "the heat balance CSV lists each block's air, radiation and neighbour shares; the report has a Where the heat goes table", { csv: csv.split("\n").filter(l => /^Component/.test(l)), report: /Where the heat goes/.test(blocks) }, await snap(pg, "heat-out-report"));

await finish(browser, pg);
