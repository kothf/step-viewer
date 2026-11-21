// A welded joint analysed by hand (FRS-structural FR-CON-022): two plates crossed, the upper one welded to the lower
// along its two long lower edges. With the plates not joined the welds alone carry the push.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simweld");
await makeBlock(pg, 40, 20, 5);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);

// the assembly: the plate twice, the second across the first and on top of it
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
const rows = await pg.$$("#asm-tree .ft-row[data-id]");
const comps = [];
for (const r of rows) if (/Block|Part|<\d+>/.test(await r.innerText())) comps.push(r);
await comps[comps.length - 1].click();
await pg.waitForTimeout(300);
await pg.click('#asm-tools [data-ac="move"]');
await pg.waitForSelector('#asm-pm input[data-pose="x"]');
for (const [k, v] of [["x", "0"], ["y", "0"], ["z", "5"], ["rx", "0"], ["ry", "0"], ["rz", "90"]]) {
  const i = await pg.$(`#asm-pm input[data-pose="${k}"]`);
  await i.fill(v); await i.press("Enter");
  await pg.waitForTimeout(500);
}
if (await pg.isVisible("#asm-pm [data-a=ok]")) await pg.click("#asm-pm [data-a=ok]");
await pg.waitForTimeout(1500);
await pg.keyboard.press("Escape");
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(1000);
await pg.keyboard.press("f");
await pg.waitForTimeout(1200);
const names = await pg.evaluate(() => window.__sv.asm.doc.components.map(c => [c.name, Math.round(c.tf[11] * 100) / 100]));
check("SW-1", names.length === 2 && names[1][1] === 5, "two plates 40 × 20 × 5, the second across the first and on top of it", names, await snap(pg, "plates"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");

// the weld: the upper plate's lower long edge on this side, then the view turned half round for the other one
await pg.click('#sim-tools [data-s="weld"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await clickAt(pg, await screenOf(pg, [10, 0, 5]));
await pg.waitForTimeout(300);
const picked1 = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Shift+ArrowRight");
await pg.waitForTimeout(900);
await pg.keyboard.press("Shift+ArrowRight");
await pg.waitForTimeout(1200);
await clickAt(pg, await screenOf(pg, [-10, 0, 5]));
await pg.waitForTimeout(300);
const picked2 = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.fill('#sim-pm [data-q="throat"]', "4");
await pg.keyboard.press("Tab");
const shot = await snap(pg, "weld-panel");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
const s1 = await sim();
const listed = await pg.evaluate(() => document.querySelector("#sim-tree .sim-welds")?.textContent ?? "");
check("SW-2", s1.weldList?.length === 1 && s1.weldList[0].edges === 2 && s1.weldList[0].throat === 4 && /4 mm/.test(listed),
  "Weld: two edges clicked on the model, throat 4 mm; the study lists the weld under Welds", { list: s1.weldList, picked1, picked2, listed }, shot);

// the lower plate held at an end, the end of the upper plate pushed along the welds
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [-20, 3, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [3, 20, 7.5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "-100");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(300);
await pg.click('#sim-tree [data-a="findlinks"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.finding && s.found; }, null, { timeout: 120000 });
await pg.waitForTimeout(400);
await pg.selectOption("#sim-tree select[data-k=link]", "none");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const wide = await pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
const row = await pg.evaluate(() => document.querySelector("#sim-tree table.sim-weldtable tr[data-weld]")?.textContent ?? "");
const w = s2.welds?.[0];
check("SW-3", !s2.error && s2.welds?.length === 1 && Math.abs(w.force / 100 - 1) < 0.03 && Math.abs(w.length / 40 - 1) < 0.05 && w.peak > w.mean && Math.abs(w.stress - w.peak / 4) < 1e-9 && row.length > 4 && wide <= 0,
  "with the plates not joined the weld carries the 100 N over the 2 × 20 mm that lie on the lower plate; the table gives its force per length and stress, and the Study tab does not scroll sideways", { error: s2.error, welds: s2.welds, row, wide }, await snap(pg, "weld-results"));

// without the weld nothing holds the upper plate
await pg.click('#sim-tree .sim-welds .sim-row [data-a="toggle"]');
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
const said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("SW-4", /E-SIM-LOOSE/.test(s3.error ?? "") && said.length > 20 && !/E-SIM/.test(said), "with the weld left out the study says in plain words that nothing holds the upper plate", { error: s3.error, said }, await snap(pg, "weld-off"));
await finish(browser, pg);
