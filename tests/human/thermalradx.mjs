// Radiation between faces by hand (FRS-thermal FR-TBC-007): two blocks that touch nowhere, the second above and
// behind the first. Heat made in the first can only leave by radiation to the second, which is held at 20 °C.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalradx");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
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
// the second block: 20 mm behind the first along Y and 20 mm above it, typed in the Move panel
const rows = await pg.$$("#asm-tree .ft-row[data-id]");
const comps = [];
for (const r of rows) if (/Block|Part|<\d+>/.test(await r.innerText())) comps.push(r);
await comps[comps.length - 1].click();
await pg.waitForTimeout(300);
await pg.click('#asm-tools [data-ac="move"]');
await pg.waitForSelector('#asm-pm input[data-pose="x"]');
const [b0, b1] = await pg.evaluate(() => [window.__sv.viewer.parts[0].data.bboxMin, window.__sv.viewer.parts[0].data.bboxMax]);
const dy = (b1[1] - b0[1]) + 20, dz = (b1[2] - b0[2]) + 20;
for (const [k, v] of [["x", "0"], ["y", String(dy)], ["z", String(dz)], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
  const i = await pg.$(`#asm-pm input[data-pose="${k}"]`);
  await i.fill(v); await i.press("Enter");
  await pg.waitForTimeout(500);
}
if (await pg.isVisible("#asm-pm [data-a=ok]")) await pg.click("#asm-pm [data-a=ok]");
await pg.waitForTimeout(1500);
const view = async k => { await pg.mouse.move(vp[0], vp[1]); await pg.keyboard.press(`Control+${k}`); await pg.waitForTimeout(900); };
await view(7);
const placed = await pg.evaluate(() => window.__sv.viewer.parts.map(p => { const v = window.__sv.viewer, a = v.toWorld(p, p.data.bboxMin), b = v.toWorld(p, p.data.bboxMax); return [[a.x, a.y, a.z].map(x => Math.round(x * 100) / 100), [b.x, b.y, b.z].map(x => Math.round(x * 100) / 100)]; }));
check("TRX-1", placed.length === 2 && placed[1][0][1] - placed[0][1][1] > 19 && placed[1][0][2] - placed[0][1][2] > 19, "two blocks that touch nowhere: the second 20 mm behind and 20 mm above the first", placed, await snap(pg, "two-blocks"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const [p0, q0] = placed[0], [p1, q1] = placed[1], xm = (p0[0] + q0[0]) / 2;
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
// the second block's top held at 20 °C, 1 W made throughout the first
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [xm, (p1[1] + q1[1]) / 2, q1[2]]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="heat"]');
await clickAt(pg, await screenOf(pg, [xm, (p0[1] + q0[1]) / 2, q0[2]]));
await pg.waitForTimeout(250);
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "1");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s0 = await sim(), said = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
check("TRX-2", /E-TH-LOOSE/.test(s0.error ?? ""), "without radiation between them nothing takes the heat from the first block, and it is named", { error: s0.error, said }, await snap(pg, "loose"));

// TRX-3: Radiation between faces: the first block's back face, then (side two) the second block's front face.
await pg.click('#sim-tools [data-s="radx"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await view(2);
await clickAt(pg, await screenOf(pg, [xm, q0[1], (p0[2] + q0[2]) / 2]));
await pg.waitForTimeout(250);
await pg.click('#sim-pm [data-side="2"]');
await view(1);
await clickAt(pg, await screenOf(pg, [xm, p1[1], (p1[2] + q1[2]) / 2]));
await pg.waitForTimeout(250);
const boxes = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm .sim-faces")].map(b => b.textContent));
const panel = await snap(pg, "panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const item = await pg.evaluate(() => { const s = window.__sv.asm.doc.studies.at(-1).supports.find(x => x.type === "radx"); return { a: s?.faces.length, b: s?.faces2?.length, row: [...document.querySelectorAll("#sim-tree .sim-row")].map(r => r.textContent).find(x => x.includes("⇌")) ?? "" }; });
check("TRX-3", boxes.length === 2 && boxes.every(b => /1 face/.test(b)) && item.a === 1 && item.b === 1 && /ε 0\.9 \/ 0\.9/.test(item.row), "the radiation item takes one face on each side, picked by clicking; the tree shows both sets and the emissivities", { boxes, item, panel }, await snap(pg, "tree"));

// TRX-4: solved: all of the 1 W crosses by radiation, the block runs hotter than the held one, the grey-body law holds.
await view(7);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), x = s1.thermal?.exchanges?.[0];
const R = x ? (0.1 / 0.9) / x.areaA + 1 / (x.areaA * x.f) + (0.1 / 0.9) / x.areaB : 1;
const law = x ? 5.670374419e-14 * ((x.ta + 273.15) ** 4 - (x.tb + 273.15) ** 4) / R : 0;
const table = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-xtable tbody tr")].map(tr => [...tr.children].map(td => td.textContent)));
check("TRX-4", !s1.error && x && x.f > 0.02 && x.f < 0.5 && Math.abs(x.heat - 1) < 0.02 && Math.abs(law - 1) < 0.02 && Math.abs(s1.thermal.out[0] - 1) < 0.02 && x.ta > x.tb + 20 && table.length === 1,
  "all of the 1 W crosses the gap by radiation; the heated block is far hotter than the held one and σ(Ta⁴ − Tb⁴)/R gives the heat", { error: s1.error, x, law, out: s1.thermal?.out, table }, await snap(pg, "solved"));

// TRX-5: the Russian UI has no English left in the radiation table.
await pg.click("#lang-btn");
await pg.waitForTimeout(400);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim .sim-xtable *, #tab-sim [data-v=xnote]")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(t => /[A-Za-z]{4}/.test(t)));
check("TRX-5", ru.length === 0, "the radiation results are translated", { ru }, await snap(pg, "ru"));
await pg.click("#lang-btn");
await finish(browser, pg);
