// Thermal stress in an assembly by hand (FRS-thermal TH5): two steel blocks end to end, 0.05 mm apart, held at
// their far ends and warmed by 100 K are pushed by E α ΔT; with the second of aluminium both carry one force.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock, simCmd } from "./lib.mjs";
const { browser, pg } = await open("thermalstressasm");
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
const placed = await pg.evaluate(() => window.__sv.viewer.parts.map(p => [p.data.bboxMin, p.data.bboxMax]));
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const [a0, a1] = placed[0], [b0, b1] = placed[1], ym = (a0[1] + a1[1]) / 2, zm = (a0[2] + a1[2]) / 2;
const view = async k => { await pg.mouse.move(vp[0], vp[1]); await pg.keyboard.press(`Control+${k}`); await pg.waitForTimeout(900); };
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="mode-structural"]');
await pg.waitForTimeout(200);

// TSA-1: Sliding on the two far end faces, the two bottoms and the two fronts, picked from the views that show them.
await pg.click('#sim-tools [data-s="sliding"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await view(3);
await clickAt(pg, await screenOf(pg, [a0[0], ym, zm]));
await view(4);
await clickAt(pg, await screenOf(pg, [b1[0], ym, zm]));
await view(6);
await clickAt(pg, await screenOf(pg, [(a0[0] + a1[0]) / 2, ym, a0[2]]));
await clickAt(pg, await screenOf(pg, [(b0[0] + b1[0]) / 2, ym, a0[2]]));
await view(1);
await clickAt(pg, await screenOf(pg, [(a0[0] + a1[0]) / 2, a0[1], zm]));
await clickAt(pg, await screenOf(pg, [(b0[0] + b1[0]) / 2, a0[1], zm]));
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await view(7);
// TSA-1: Loads ▸ Temperature is offered over an assembly: 120 °C everywhere, stress-free at 20 °C.
const tempOn = await pg.evaluate(() => !document.querySelector('#sim-tools [data-fly="load"]')?.disabled);
await simCmd(pg, "temperature");
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.fill('#sim-pm [data-n="value"]', "120");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
check("TSA-1", tempOn && picked === "6 faces", "over an assembly the Temperature load is offered; a Sliding support takes the far ends, bottoms and fronts of both blocks", { tempOn, picked }, await snap(pg, "set-up"));

// TSA-2: solved, two probes on the blocks' tops read E α ΔT.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const probe = async () => {
  await pg.click('#sim-legend [data-a="noprobes"]').catch(() => {});
  await pg.click('#sim-legend [data-a="probe"]');
  await clickAt(pg, await screenOf(pg, [(a0[0] + a1[0]) / 2, ym, a1[2]]));
  await clickAt(pg, await screenOf(pg, [(b0[0] + b1[0]) / 2, ym, a1[2]]));
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(300);
  return (await sim()).probes;
};
const s2 = await sim(), p2 = await probe();
const m = await pg.evaluate(() => window.__sv.asm.doc.parts ? Object.values(window.__sv.asm.doc.parts)[0].doc.material : null);
const sig = m.E * 1000 * m.alpha * 1e-6 * 100;
check("TSA-2", !s2.error && p2.length === 2 && p2.every(v => Math.abs(v / sig - 1) < 0.03), "both steel blocks held at their far ends and warmed by 100 K read E α ΔT on their tops", { error: s2.error, p2, sig }, await snap(pg, "steel"));

// TSA-3: the second block of aluminium (picked for the study): one force through both, σ = ΔT (αs + αa) L / (L/Es + L/Ea).
const ids = await pg.evaluate(() => [...document.querySelectorAll('#sim-tree [data-a="compmat"]')].map(b => b.dataset.c));
await pg.click(`#sim-tree [data-a="compmat"][data-c="${ids[1]}"]`);
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "6061");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim(), p3 = await probe();
const La = a1[0] - a0[0], Lb = b1[0] - b0[0], ea = 68.9e3, aa = 23.6e-6;
const s2a = (100 * (m.alpha * 1e-6 * La + aa * Lb)) / (La / (m.E * 1000) + Lb / ea);
check("TSA-3", !s3.error && s3.bodyMats?.length === 2 && p3.length === 2 && p3.every(v => Math.abs(v / s2a - 1) < 0.05), "with the second block of aluminium both carry one force: the tops read ΔT (αs Ls + αa La) / (Ls/Es + La/Ea)", { error: s3.error, mats: s3.bodyMats, p3, s2a }, await snap(pg, "steel-aluminium"));

// TSA-4: Russian.
await pg.click("#lang-btn");
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim .sim-loads *, #tab-sim .sim-comps *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "ru");
await pg.click("#lang-btn");
check("TSA-4", ru.length === 0, "the study is all in Russian", { ru }, ruShot);

await finish(browser, pg);
