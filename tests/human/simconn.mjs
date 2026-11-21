// Connectors and masses analysed by hand (FRS-structural FR-CON-023): two plates in line with a gap between them,
// tied by a rigid connector, then by a spring; a mass on the second plate weighs under gravity.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simconn");
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
for (const [k, v] of [["x", "45"], ["y", "0"], ["z", "0"], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
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
const names2 = await pg.evaluate(() => window.__sv.asm.doc.components.map(c => [c.name, Math.round(c.tf[3] * 100) / 100]));
check("SC-1", names2.length === 2 && names2[1][1] === 45, "two plates 40 × 20 × 5 in line, 5 mm apart", names2, await snap(pg, "plates"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");


// the connector: the top face of the first plate, then Side 2 and the top face of the second
await pg.click('#sim-tools [data-s="connector"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await clickAt(pg, await screenOf(pg, [-8, 3, 5]));
await pg.waitForTimeout(300);
await pg.click('#sim-pm [data-side="2"]');
await pg.waitForTimeout(200);
await clickAt(pg, await screenOf(pg, [45, 3, 5]));
await pg.waitForTimeout(300);
const shot = await snap(pg, "connector-panel");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
const s1 = await sim();
const listed = await pg.evaluate(() => document.querySelector("#sim-tree .sim-conns")?.textContent ?? "");
check("SC-2", s1.connList?.length === 1 && s1.connList[0].a === 1 && s1.connList[0].b === 1 && s1.connList[0].kind === "rigid" && /rigid/.test(listed),
  "Connector: a face on each side clicked on the model; the study lists it under Connectors as rigid", { list: s1.connList, listed }, shot);

// the first plate held on a long side, the far end of the second pushed towards the first
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [65, 3, 2.5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "100");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const wide = await pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
const row = await pg.evaluate(() => document.querySelector("#sim-tree table.sim-conntable tr[data-conn]")?.textContent ?? "");
check("SC-3", !s2.error && s2.conns?.length === 1 && Math.abs(s2.conns[0].force / 100 - 1) < 0.02 && row.length > 4 && wide <= 0,
  "the plates touch nowhere, and the rigid connector passes the whole 100 N on; the table gives its force and moment, and the Study tab does not scroll sideways", { error: s2.error, conns: s2.conns, row, wide }, await snap(pg, "rigid"));
const u2 = s2.maxU;

// a spring of 1000 N/mm instead: it gives 0.1 mm under the 100 N
await pg.click('#sim-tree .sim-conns .sim-row [data-a="edit"]');
await pg.waitForSelector("#sim-pm select[data-k=ckind]");
await pg.selectOption("#sim-pm select[data-k=ckind]", "spring");
await pg.waitForSelector('#sim-pm [data-q="k0"]');
await pg.fill('#sim-pm [data-q="k0"]', "1000");
await pg.keyboard.press("Tab");
const shot2 = await snap(pg, "spring-panel");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
check("SC-4", !s3.error && s3.conns?.[0]?.spring && Math.abs(s3.conns[0].stretch / 0.1 - 1) < 0.03 && Math.abs(s3.conns[0].force / 100 - 1) < 0.02 && s3.maxU > u2 + 0.09,
  "as a spring of 1000 N/mm the connector gives 0.1 mm under the 100 N, and the second plate moves that much more", { error: s3.error, conns: s3.conns, maxU: [u2, s3.maxU] }, shot2);

// a mass of 2 kg on the second plate, with gravity: the support carries its weight too
await pg.click('#sim-tools [data-s="mass"]');
await pg.waitForSelector('#sim-pm [data-q="mass"]');
await clickAt(pg, await screenOf(pg, [45, 3, 5]));
await pg.waitForTimeout(300);
await pg.fill('#sim-pm [data-q="mass"]', "2");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="gravity"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim();
const rz = (s4.reactions ?? []).reduce((a, r) => a + r.force[2], 0), want = (2 + 2 * 4 * 7.85e-3) * 9.80665;
const masses = await pg.evaluate(() => document.querySelector("#sim-tree .sim-masses")?.textContent ?? "");
check("SC-5", !s4.error && s4.massList?.length === 1 && s4.massList[0].mass === 2 && /2 kg/.test(masses) && Math.abs(Math.abs(rz) / want - 1) < 0.03,
  "Mass: 2 kg on the second plate; under gravity the support carries the plates and the mass", { error: s4.error, list: s4.massList, masses, rz, want }, await snap(pg, "mass"));

// without the connector nothing holds the second plate
await pg.click('#sim-tree .sim-conns .sim-row [data-a="toggle"]');
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s5 = await sim();
const said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("SC-6", /E-SIM-LOOSE/.test(s5.error ?? "") && said.length > 20 && !/E-SIM/.test(said), "with the connector left out the study says in plain words that nothing holds the second plate", { error: s5.error, said }, await snap(pg, "connector-off"));
await finish(browser, pg);
