// Spot welds and an adhesive layer by hand (FRS-structural FR-CON-024/025): two plates crossed, the upper one spot welded
// to the lower through its top face; then the spots left out and the plates glued.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simspot");
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
check("SS-1", names.length === 2 && names[1][1] === 5, "two plates 40 × 20 × 5, the second across the first and on top of it", names, await snap(pg, "plates"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");

// two spots clicked on the top face of the upper plate, over the lower one
await pg.click('#sim-tools [data-s="spot"]');
await pg.waitForSelector('#sim-pm [data-q="dia"]');
await clickAt(pg, await screenOf(pg, [-5, 0, 10]));
await pg.waitForTimeout(300);
await clickAt(pg, await screenOf(pg, [5, 0, 10]));
await pg.waitForTimeout(300);
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.fill('#sim-pm [data-q="dia"]', "4");
await pg.keyboard.press("Tab");
const shot = await snap(pg, "spot-panel");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
const s1 = await sim();
const listed = await pg.evaluate(() => document.querySelector("#sim-tree .sim-welds")?.textContent ?? "");
check("SS-2", s1.weldList?.length === 1 && s1.weldList[0].points === 2 && s1.weldList[0].dia === 4 && /2 points/.test(picked) && /Spot weld 1/.test(listed),
  "Spot weld: two points clicked on the upper plate's top face, diameter 4 mm; the study lists it under Welds", { list: s1.weldList, picked, listed }, shot);

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
const wide = () => pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
const row = await pg.evaluate(() => document.querySelector("#sim-tree table.sim-spottable tr[data-weld]")?.textContent ?? "");
const w = s2.welds?.[0];
check("SS-3", !s2.error && s2.welds?.length === 1 && w.spot && w.spots === 2 && Math.abs(w.force / 100 - 1) < 0.03 && w.peak > 40 && w.peak < 70 && Math.abs(w.stress - w.peak / (Math.PI * 4)) < 1e-9 && row.length > 4 && (await wide()) <= 0,
  "with the plates not joined the two spots carry the 100 N, half each; the table gives the largest spot force and its stress, and the Study tab does not scroll sideways", { error: s2.error, welds: s2.welds, row, wide: await wide() }, await snap(pg, "spot-results"));

// a click on a spot takes it away; cancelled, the weld keeps both
await pg.click('#sim-tree .sim-welds .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm [data-q="dia"]');
await clickAt(pg, await screenOf(pg, [5, 0, 10]));
await pg.waitForTimeout(300);
const less = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.click("#sim-pm .pm-cancel");
await pg.waitForTimeout(300);
const s2b = await sim();
check("SS-4", /1 point/.test(less) && s2b.weldList[0].points === 2, "editing the weld, a click on a spot takes it away; cancelled, both stay", { less, list: s2b.weldList }, await snap(pg, "spot-edit"));

// the spots left out and the plates glued: a soft layer 0.5 mm thick
await pg.click('#sim-tree .sim-welds .sim-row [data-a="toggle"]');
await pg.waitForTimeout(300);
await pg.selectOption("#sim-tree select[data-k=link]", "adhesive");
await pg.waitForSelector('#sim-tree [data-k="gluet"]');
await pg.fill('#sim-tree [data-k="gluet"]', "0.5");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
await pg.fill('#sim-tree [data-k="gluee"]', "100");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const set = await pg.evaluate(() => window.__sv.sim.state().links);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
const c = s3.contacts?.[0], cf = c?.force ? Math.hypot(...c.force) : 0;
// the force presses the upper plate onto the lower: 400 mm² of glue of stiffness 100 / 0.5 N/mm³ is squeezed by about 100 / (200 × 400) mm
const shift = 100 / (100 / 0.5 * 400);
check("SS-5", !s3.error && c?.type === "adhesive" && set[0]?.t === 0.5 && set[0]?.E === 100 && Math.abs(cf / 100 - 1) < 0.03 && s3.maxU > shift && s3.maxU < 2.5 * shift && s3.maxU > 1.5 * s2.maxU && (await wide()) <= 0,
  "Adhesive, 0.5 mm thick with E = 100 MPa: the layer carries the 100 N and is squeezed by about the force over its stiffness, so the plate moves more than with the spots", { error: s3.error, contact: c, set, maxU: [s2.maxU, s3.maxU], shift, wide: await wide() }, await snap(pg, "adhesive"));
await finish(browser, pg);
