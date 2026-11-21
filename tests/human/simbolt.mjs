// A bolted joint analysed by hand (FRS-structural FR-CON-020/021): two plates with a hole, an M6 screw and a nut from
// the toolbox. The study finds the bolt, shows its shear when the plates are not joined, and its tension when tightened.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simbolt");
await makeBlock(pg, 40, 20, 5);
// a Ø6.6 hole through the middle: Cut with the top face picked
await pg.mouse.move(700, 450);
await pg.keyboard.press("f");
await pg.waitForTimeout(900);
await clickAt(pg, await screenOf(pg, [12, 3, 5]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(1500);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [0, 0, 5]));
await clickAt(pg, await screenOf(pg, [3.3, 0, 5]));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.click("#mc-ok");
await pg.waitForTimeout(1500);
{ const dp = await pg.$('#mc-pm input[data-num="depth"]'); if (dp) { await dp.fill("5"); await dp.press("Enter"); } }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.keyboard.press("Escape");
const holeR = await pg.evaluate(() => window.__sv.viewer.parts[0]?.data.faces.find(f => f.type === "cylinder")?.radius ?? null);
check("SB-1", holeR > 3 && holeR < 3.6, "a plate 40 × 20 × 5 with a hole of about Ø6.6 in the middle", { holeR }, await snap(pg, "plate"));
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);

// the assembly: the plate twice, the second on top of the first
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
for (const [k, v] of [["x", "0"], ["y", "0"], ["z", "5"], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
  const i = await pg.$(`#asm-pm input[data-pose="${k}"]`);
  await i.fill(v); await i.press("Enter");
  await pg.waitForTimeout(500);
}
if (await pg.isVisible("#asm-pm [data-a=ok]")) await pg.click("#asm-pm [data-a=ok]");
await pg.waitForTimeout(1500);
const built = n => pg.waitForFunction(k => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === k, n, { timeout: 180000 });

// the screw: picked in the toolbox, then a click on the rim of the hole seen from above
const pickKind = async (q, kind) => {
  await pg.fill('#asm-pm [data-f="q"]', q);
  await pg.waitForTimeout(500);
  await pg.click(`#asm-pm [data-kind="${kind}"]`);
  await pg.waitForTimeout(300);
};
await pg.click("#cm-t-assembly").catch(() => {});
await pg.click('#asm-tools [data-ac="fastener"]');
await pg.waitForTimeout(500);
// the view from above first: the view keys do nothing while the cursor is in a field of the panel
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+5");
await pg.waitForTimeout(1200);
await pickKind("4762", "iso4762");
await pg.click('#asm-pm [data-size="M6"]');
await pg.waitForTimeout(300);
await pg.selectOption('#asm-pm [data-f="length"]', "16");
await pg.waitForTimeout(300);
await clickAt(pg, await screenOf(pg, [3.2, 0, 10]));
await built(3);
await pg.waitForTimeout(1500);
// the nut: on the same hole from below
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+6");
await pg.waitForTimeout(1200);
await pickKind("4032", "iso4032");
await clickAt(pg, await screenOf(pg, [3.2, 0, 0]));
await built(4);
await pg.waitForTimeout(2000);
await pg.keyboard.press("Escape");
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(1200);
const names = await pg.evaluate(() => window.__sv.asm.doc.components.map(c => [c.name, Math.round(c.tf[11] * 100) / 100]));
check("SB-2", names.length === 4 && /4762 M6/.test(names[2][0]) && names[2][1] === 10 && /4032 M6/.test(names[3][0]) && names[3][1] === 0,
  "two plates with an M6 × 16 screw from above and an M6 nut from below, both placed by a click on the hole", names, await snap(pg, "joint"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const s0 = await sim();
const listed = await pg.evaluate(() => document.querySelector("#sim-tree .sim-boltlist")?.textContent ?? "");
check("SB-3", s0.boltList?.length === 1 && !s0.boltList[0].off && /4762/.test(listed), "the study lists the screw under Bolts, ticked", { list: s0.boltList, listed }, await snap(pg, "bolts-section"));

// held on a long side of the lower plate, the end of the upper plate pushed along the plates
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [20, 3, 7.5]));
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
const s1 = await sim();
const note = await pg.evaluate(() => document.querySelector("#sim-tree .sim-boltlist [data-v=boltnote]")?.textContent ?? "");
check("SB-4", s1.boltList[0].found && !s1.boltList[0].missed && /nut/.test(note) && s1.found?.length === 1, "Find connections: the bolt is found with its nut, and only the two plates are a connection", { list: s1.boltList, note, found: s1.found }, await snap(pg, "found"));

// plates not joined: the bolt alone carries the push
await pg.selectOption("#sim-tree select[data-k=link]", "none");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const wide = await pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
check("SB-5", !s2.error && s2.bolts?.length === 1 && Math.abs(s2.bolts[0].shear / 100 - 1) < 0.02 && s2.bolts[0].sf > 1 && s2.boltMarks >= 1 && wide <= 0,
  "with the plates not joined the bolt carries the 100 N in shear; the table gives its safety factor and the Study tab does not scroll sideways", { error: s2.error, bolts: s2.bolts, marks: s2.boltMarks, wide }, await snap(pg, "shear"));

// tightened: 2000 N preload, class 12.9, plates sliding
await pg.selectOption("#sim-tree select[data-k=link]", "sliding");
await pg.waitForTimeout(300);
await pg.fill("#sim-tree .sim-boltlist input[data-k=boltpre]", "2000");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(300);
await pg.selectOption("#sim-tree .sim-boltlist select[data-k=boltcls]", "12.9");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
check("SB-6", !s3.error && Math.abs(s3.bolts[0].axial / 2000 - 1) < 0.03 && s3.bolts[0].cls === "12.9" && s3.bolts[0].sf > 1,
  "tightened to 2000 N the bolt's tension is the preload, and it is rated as class 12.9", { error: s3.error, bolts: s3.bolts }, await snap(pg, "preload"));

// a preload needs the clamped parts joined
await pg.selectOption("#sim-tree select[data-k=link]", "none");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim();
const said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("SB-7", /E-SIM-PRELOAD/.test(s4.error ?? "") && said.length > 20 && !/E-SIM/.test(said), "a preload with the plates not joined is refused in plain words", { error: s4.error, said }, await snap(pg, "preload-refused"));

// the screw as a solid again
await pg.uncheck("#sim-tree .sim-boltlist input[data-k=bolton]");
await pg.waitForTimeout(400);
const s5 = await sim();
check("SB-8", s5.boltList[0].off && s5.stale, "unticked, the screw is analysed as a solid and the results are out of date", { list: s5.boltList, stale: s5.stale }, await snap(pg, "solid"));
await finish(browser, pg);
