// A thermal study of an assembly by hand (FRS-thermal TH3): two blocks placed end to end with a 0.05 mm gap.
// Heat made in one leaves through the other; a pad on the contact adds its step; with no contact the block
// nothing cools is named.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalasm");
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
const tree = await pg.evaluate(() => ({ kind: document.querySelector('#sim-tree [data-v="kind"]')?.textContent ?? "", comps: [...document.querySelectorAll("#sim-tree .sim-complist li")].map(li => li.textContent.replace(/\s+/g, " ").trim()), links: !!document.querySelector("#sim-tree .sim-tlinks"), bolts: !!document.querySelector("#sim-tree .sim-bolts") }));
check("THA-2", tree.kind === "Thermal" && tree.comps.length === 2 && tree.comps.every(c => /W\/\(m·K\)/.test(c)) && tree.links && !tree.bolts && picked === "1 face",
  "the Thermal button works over an assembly; the study lists both components with their thermal conductivity and has a Connections section", { tree, picked }, await snap(pg, "thermal-asm-setup"));

// THA-3: solved: all the heat leaves through the held face, the contact passes it, each component has its row.
const k = await pg.evaluate(() => Number((document.querySelector('#sim-tree [data-v="compk"]')?.textContent ?? "").match(/([\d.]+)/)?.[1]) * 1e-3);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
const L = placed[0][1][0] - placed[0][0][0], A = (placed[0][1][1] - placed[0][0][1]) * zt;
const hot = 20 + (4 * L) / (k * A) + (4 * L) / (2 * k * A);
const res = await pg.evaluate(() => ({ rows: [...document.querySelectorAll("#sim-tree .sim-tcomps tbody tr")].map(tr => [...tr.children].map(td => td.textContent)), heat: parseFloat(document.querySelector("#sim-tree .sim-contacts [data-v=cheat]")?.textContent ?? ""), legend: !!document.querySelector("#sim-legend:not([hidden])") }));
check("THA-3", !s3.error && s3.thermal && Math.abs(s3.thermal.max - hot) < 0.02 * (hot - 20) && Math.abs(s3.thermal.out[0] - 4) < 0.05 && s3.thermal.contacts.length === 1 && Math.abs(Math.abs(s3.thermal.contacts[0].heat) - 4) < 0.05 && res.rows.length === 2 && Math.abs(res.heat - 4) < 0.05,
  "4 W made in the first block leave through the second: the hottest point matches P·L/(k·A) + P·L/(2·k·A), the contact passes 4 W, and each component has its row", { error: s3.error, max: s3.thermal?.max, hot, thermal: s3.thermal, res }, await snap(pg, "thermal-asm-solved"));

// THA-4: a pad on the contact adds P·t / (k·A).
await pg.selectOption('#sim-tree select[data-k="tlink"]', "pad");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim(), step = (4 * 0.5) / (0.003 * A);
check("THA-4", !s4.error && Math.abs(s4.thermal.max - s3.thermal.max - step) < 0.05 * step && s4.thermal.contacts[0].type === "resistance",
  "a 0.5 mm pad of 3 W/(m·K) on the contact makes the heated block hotter by P·t / (k·A)", { max: [s3.thermal.max, s4.thermal?.max], step, contact: s4.thermal?.contacts }, await snap(pg, "thermal-asm-pad"));

// THA-5: with no contact nothing cools the first block, and it is named.
await pg.selectOption('#sim-tree select[data-k="tlink"]', "none");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s5 = await sim();
const said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("THA-5", /E-TH-LOOSE/.test(s5.error ?? "") && /Nothing takes the heat away from/.test(said),
  "with No contact the solve stops and names the block that nothing cools", { error: s5.error, said }, await snap(pg, "thermal-asm-loose"));

// THA-6: with the held temperature turned off nothing cools either block: refused before solving, both named (FR-TBC-012).
await pg.evaluate(() => document.querySelectorAll(".toast").forEach(x => x.remove()));
await pg.click('#sim-tree .sim-cool .sim-row:not(.off) [data-a="toggle"]');
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s6 = await sim();
const said6 = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | ") + " | " + (document.querySelector("#sim-tree .sim-prob")?.textContent ?? ""));
const names = (s6.comps ?? []).map(c => c.name ?? c);
check("THA-6", /^E-TH-NOSINK: 0,1$/.test(s6.error ?? "") && !s6.thermal && /Nothing takes the heat away from/.test(said6),
  "with no cooling at all the solve is refused before it starts and the message names both blocks", { error: s6.error, said6, names }, await snap(pg, "thermal-asm-nosink"));

await finish(browser, pg);
