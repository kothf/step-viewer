// A static study of an assembly by hand (FRS-structural SA3): two blocks placed end to end with a 0.05 mm gap
// are solved joined, the pair is listed under Connections, and with the pair not joined the loose block is named.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simasm");
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
check("SAS-1", placed.length === 2 && Math.abs(placed[1][0][0] - placed[0][1][0] - 0.05) < 1e-6, "two blocks stand end to end, 0.05 mm apart", placed, await snap(pg, "two-blocks"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const x1 = placed[1][1][0], x0 = placed[0][0][0], zt = placed[0][1][2], ym = (placed[0][0][1] + placed[0][1][1]) / 2;
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
// clamped at the far end of the second block, pushed down on top of the first
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [x1, ym, zt / 2]));
await pg.waitForTimeout(250);
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [x0 + 20, ym, zt]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
const s0 = await sim();
check("SAS-2", s0.asm && !!s0.study && s0.marks > 0 && /1/.test(picked), "the assembly has a study: a support on one component and a force on the other", { study: s0.study, marks: s0.marks, picked }, await snap(pg, "set-up"));

await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(300);
// before any solve: Find connections lists the pair with its gap, and a click on the row shows the contact
await pg.click('#sim-tree [data-a="findlinks"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.finding && s.found; }, null, { timeout: 120000 });
await pg.waitForTimeout(400);
await pg.click("#sim-tree .sim-contacts tbody tr td");
await pg.waitForTimeout(400);
const fnd = await sim();
const gapCell = await pg.evaluate(() => document.querySelector('#sim-tree .sim-contacts [data-v="cgap"]')?.textContent ?? "");
check("SAS-7", fnd.found?.length === 1 && Math.abs(fnd.found[0].area / 400 - 1) < 0.02 && Math.abs(fnd.found[0].gap - 0.05) < 0.01 && Math.abs(parseFloat(gapCell) - 0.05) < 0.01 && fnd.patches.length === 2 && !fnd.done,
  "Find connections lists the pair before a solve, with its area and its 0.05 mm gap; the picked row shows the contact in two colours", { found: fnd.found, gapCell, patches: fnd.patches }, await snap(pg, "found-connection"));
await pg.click("#sim-tree .sim-contacts tbody tr td");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r = await sim();
const table = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-contacts tbody tr")].map(tr => tr.textContent));
check("SAS-3", !r.error && r.contacts.length === 1 && Math.abs(r.contacts[0].area / 400 - 1) < 0.02 && r.contacts[0].type === "bonded" && table.length === 1 && r.plot.shown && r.maxU > 0,
  "solved joined across the gap: one connection of 400 mm² is listed, and the results are drawn on both blocks", { error: r.error, contacts: r.contacts, table, maxU: r.maxU, maxVm: r.maxVm }, await snap(pg, "joined"));

// not joined: the first block is held by nothing
await pg.selectOption('#sim-tree select[data-k="link"]', "none");
await pg.waitForTimeout(400);
const s1 = await sim();
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r2 = await sim();
const said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("SAS-4", s1.stale && s1.links.length === 1 && /E-SIM-LOOSE/.test(r2.error ?? "") && /Nothing holds/.test(said), "with the pair not joined the results go out of date, and solving names the block that nothing holds", { stale: s1.stale, links: s1.links, error: r2.error, said }, await snap(pg, "loose"));

// sliding: the block may still slide along the joint, so it is still loose; bonded again solves
await pg.selectOption('#sim-tree select[data-k="link"]', "bonded");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r3 = await sim();
const cf = await pg.evaluate(() => ({ force: document.querySelector('#sim-tree .sim-contacts [data-v="cforce"]')?.textContent ?? "", moment: document.querySelector('#sim-tree .sim-contacts [data-v="cmoment"]')?.textContent ?? "", note: document.querySelector('#sim-tree [data-v="cforcenote"]')?.textContent ?? "" }));
const loadN = Math.hypot(...(r3.applied?.force ?? [0, 0, 0])), passN = Math.hypot(...(r3.contacts[0]?.force ?? [0, 0, 0]));
check("SAS-6", loadN > 0 && Math.abs(passN / loadN - 1) < 0.05 && Math.abs(parseFloat(cf.force) / loadN - 1) < 0.05 && cf.moment !== "" && cf.note.length > 10,
  "the connection's row shows the force it carries, equal to the load, and its moment", { loadN, passN, cf }, await snap(pg, "connection-force"));
check("SAS-5", !r3.error && r3.links.length === 0 && r3.contacts.length === 1 && Math.abs(r3.maxU / r.maxU - 1) < 1e-6, "bonded again, the study solves as before", { error: r3.error, maxU: [r.maxU, r3.maxU] }, await snap(pg, "bonded-again"));

// another material for one component, for this study only: the loaded block in aluminium gives more
await pg.click('#sim-tree .sim-complist li:nth-child(1) [data-a="compmat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.click("#mat-dlg .mat-list li[data-i]");
await pg.click("#mat-dlg [data-a=ok]");
await pg.waitForSelector("#mat-dlg", { state: "detached" });
await pg.waitForTimeout(400);
const m1 = await sim();
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const m2 = await sim();
check("SAS-8", m1.compList?.[0]?.own && m1.stale && !m2.error && m2.maxU > 1.05 * r3.maxU, "a component given aluminium for the study deforms more than in steel; the part keeps its own material", { list: m1.compList, error: m2.error, maxU: [r3.maxU, m2.maxU] }, await snap(pg, "component-material"));

// results by component: the table, and one component alone
const b0 = await sim();
await pg.click('#sim-tree .sim-comptable tbody tr[data-rcomp="1"]');
await pg.waitForTimeout(400);
const b1 = await sim();
check("SAS-10", b0.compRows?.length === 2 && b1.compSel === 1 && b1.drawn < b0.drawn && Math.abs(b1.plot.range[1] / b0.compRows[1].vm - 1) < 1e-6,
  "the results list both components, and a click on a row shows that one alone with its own colour scale", { rows: b0.compRows, drawn: [b0.drawn, b1.drawn], range: b1.plot.range }, await snap(pg, "component-alone"));
await pg.click('#sim-tree [data-a="rcompall"]');
await pg.waitForTimeout(300);

// left out: the component is a ghost, and what was put on it is named when solving
await pg.uncheck('#sim-tree .sim-complist li:nth-child(2) [data-k="compon"]');
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const m3 = await sim();
const said2 = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("SAS-9", m3.compList?.[1]?.off && /E-SIM-REF/.test(m3.error ?? "") && /left out of the study/.test(said2), "a component left out is struck through in the list, and solving says which item still sits on it", { list: m3.compList, error: m3.error, said2 }, await snap(pg, "component-left-out"));
await finish(browser, pg);
