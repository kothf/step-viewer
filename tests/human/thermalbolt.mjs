// A bolted joint in a thermal study by hand (FRS-thermal FR-TCON-003): two plates with a hole clamped by an M6 screw
// and nut from the toolbox. The plates' contact is a bolted joint by default, with its own contact conductance.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalbolt");
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
check("TB-1", holeR > 3 && holeR < 3.6, "a plate 40 × 20 × 5 with a hole of about Ø6.6 in the middle", { holeR }, await snap(pg, "plate"));
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
await pickKind("4032", "iso4032");
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+6");
await pg.waitForTimeout(1200);
await clickAt(pg, await screenOf(pg, [4.2, 0, 0]));
await built(4);
await pg.waitForTimeout(2000);
await pg.keyboard.press("Escape");
await pg.mouse.move(vp[0], vp[1]);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(1200);
const names = await pg.evaluate(() => window.__sv.asm.doc.components.map(c => [c.name, Math.round(c.tf[11] * 100) / 100]));
check("TB-2", names.length === 4 && /4762 M6/.test(names[2][0]) && names[2][1] === 10 && /4032 M6/.test(names[3][0]) && names[3][1] === 0,
  "two plates with an M6 × 16 screw from above and an M6 nut from below, both placed by a click on the hole", names, await snap(pg, "joint"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(300);
// a long side of the lower plate held at 20 °C, 4 W made throughout the upper plate
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="heat"]');
await clickAt(pg, await screenOf(pg, [16, 4, 10]));
await pg.waitForTimeout(250);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "4");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(300);
const plates = () => pg.evaluate(() => {
  const s = window.__sv.sim.state(), c = s.thermal?.contacts?.find(x => x.area > 500);
  const row = [...document.querySelectorAll("#sim-tree .sim-tlinks select[data-k=tlink]")].find(sel => !/4762|4032/.test(sel.closest("tr").innerText));
  return { error: s.error, max: s.thermal?.max, c: c ? { type: c.type, area: Math.round(c.area), heat: c.heat, drop: Math.abs(c.ta - c.tb) } : null, sel: row?.value,
    options: row ? [...row.options].map(o => o.textContent) : [], h: row?.closest("tr").nextElementSibling?.querySelector('input[data-k="tcch"]')?.value,
    note: document.querySelector('#sim-tree [data-v="boltnote"]')?.textContent ?? "", ab: row ? [row.dataset.a, row.dataset.b] : null };
});
await pg.click('#sim-tree [data-a="findlinks"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.finding && s.found; }, null, { timeout: 120000 });
await pg.waitForTimeout(400);
const t3 = await plates();
check("TB-3", t3.sel === "bolted" && t3.options.includes("Bolted joint") && t3.h === "5000" && /bolted joint/.test(t3.note),
  "Find connections: the two plates the screw clamps are a Bolted joint of 5000 W/(m²·K), and a note says why", t3, await snap(pg, "bolted-found"));

await pg.click('#sim-tools [data-s="solve"]');
await solved();
const t4 = await plates();
const want = Math.abs(t4.c?.heat ?? 0) / ((t4.c?.area ?? 1) * 1e-6 * 5000);
check("TB-4", !t4.error && t4.c?.type === "resistance" && Math.abs(t4.c.drop - want) < 0.15 * want && want > 0.5,
  "solved: the plates' contact passes the heat with a temperature step of heat / (5000 W/(m²·K) × area)", { ...t4, want }, await snap(pg, "bolted-solved"));

const sel = `#sim-tree .sim-tlinks select[data-k=tlink][data-a="${t4.ab[0]}"][data-b="${t4.ab[1]}"]`;
const field = `#sim-tree input[data-k="tcch"][data-a="${t4.ab[0]}"][data-b="${t4.ab[1]}"]`;
await pg.fill(field, "20000");
await pg.press(field, "Enter");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const t5 = await plates();
check("TB-5", !t5.error && t5.sel === "bolted" && t5.h === "20000" && t5.c.drop < t4.c.drop / 3 && t5.max < t4.max,
  "a typed 20000 W/(m²·K) stays on the bolted joint: the step is about four times smaller and the upper plate runs cooler", { t4: t4.c, t5 }, await snap(pg, "bolted-20000"));

await pg.selectOption(sel, "perfect");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const t6 = await plates();
check("TB-6", !t6.error && t6.sel === "perfect" && t6.c?.type === "perfect" && t6.c.drop < 0.1 && t6.max < t5.max,
  "set to Perfect the plates pass heat with no step, and the choice is kept", t6, await snap(pg, "perfect"));
await finish(browser, pg);
