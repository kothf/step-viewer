// A modal study of an assembly, and comparing two results (FRS-structural SA4, FR-STU-023): two plates end to end,
// clamped at one end; a copy of the study with a mass on the free plate; then the mass changed.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simasmmodal");
await makeBlock(pg, 40, 20, 5);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);

// the assembly: the plate twice, the second on the end of the first
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
for (const [k, v] of [["x", "40"], ["y", "0"], ["z", "0"], ["rx", "0"], ["ry", "0"], ["rz", "0"]]) {
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
const placed = await pg.evaluate(() => window.__sv.asm.doc.components.map(c => [c.name, Math.round(c.tf[3] * 100) / 100]));
check("SAM-1", placed.length === 2 && placed[1][1] === 40, "two plates 40 × 20 × 5 end to end", placed, await snap(pg, "plates"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const wide = () => pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
await pg.click("#cm-t-simulation");
await pg.waitForTimeout(300);
await pg.click('#sim-tools [data-s="newmodal"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");

// the first plate is held on its top face: the second hangs off its end
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [-8, 3, 5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
// the free plate is a steel cantilever 40 × 20 × 5: first bending about 2600 Hz by beam theory, a little less on a root that gives
const beam = (1.875104 ** 2 / (2 * Math.PI * 40 * 40)) * Math.sqrt((210000 * 25) / (12 * 7.85e-9));
const f1 = s1.modes.find(m => !m.rigid)?.hz ?? 0;
const none = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="cmpnone"]')?.textContent ?? "");
check("SAM-2", !s1.error && s1.asm && s1.kind === "modal" && f1 < beam && f1 > 0.85 * beam && Math.abs(s1.mass * 1000 / 0.0628 - 1) < 0.02 && none.length > 20 && (await wide()) <= 0,
  "Modal study of the assembly: the second plate, joined to the held one only where their ends touch, vibrates as a cantilever (first bending a little under the beam value), and the mass is that of both; nothing to compare with yet", { error: s1.error, f1, beam, mass: s1.mass, none, wide: await wide() }, await snap(pg, "modal"));

// a copy of the study with 0.1 kg on the free plate's top face
await pg.click('#sim-tree [data-a="dupstudy"]');
await pg.waitForTimeout(500);
const s2 = await sim();
const head = await pg.evaluate(() => document.querySelector("#sim-tree .sim-head select")?.selectedOptions[0]?.textContent ?? "");
await pg.click('#sim-tools [data-s="mass"]');
await pg.waitForSelector('#sim-pm [data-q="mass"]');
await clickAt(pg, await screenOf(pg, [50, 3, 5]));
await pg.waitForTimeout(300);
await pg.fill('#sim-pm [data-q="mass"]', "0.1");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
await pg.selectOption('#sim-tree select[data-k="cmp"]', s1.study);
await pg.waitForTimeout(300);
const s3 = await sim();
const table = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree table.sim-cmptable tr[data-cmp]")].map(r => [r.dataset.cmp, ...[...r.cells].map(c => c.textContent)]));
const f3 = s3.modes.find(m => !m.rigid)?.hz ?? 0;
const c3 = s3.compare;
check("SAM-3", s2.study !== s1.study && /\(2\)/.test(head) && !s3.error && f3 < 0.6 * f1 && c3 && c3.with === s1.study && c3.rows[0].key === "mass" && Math.abs(c3.rows[0].a - c3.rows[0].b - 0.1) < 0.002
  && c3.rows[1].key === "f1" && Math.abs(c3.rows[1].b / f1 - 1) < 1e-6 && c3.rows[1].change < -40 && table.length === c3.rows.length && /−/.test(table[1][4]) && (await wide()) <= 0,
  "Duplicate study, a mass of 0.1 kg on the free plate: the first frequency drops, and Compare lists this result beside the first study's: mass 0.1 kg more, frequencies lower", { head, f1, f3, compare: c3, table, wide: await wide() }, await snap(pg, "compare"));

// the mass made 0.2 kg: the result before the change is offered too
await pg.click('#sim-tree .sim-masses .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm [data-q="mass"]');
await pg.fill('#sim-pm [data-q="mass"]', "0.2");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s4 = await sim();
const opts = await pg.evaluate(() => [...document.querySelectorAll('#sim-tree select[data-k="cmp"] option')].map(o => o.value));
await pg.selectOption('#sim-tree select[data-k="cmp"]', "prev");
await pg.waitForTimeout(300);
const c4 = (await sim()).compare;
await pg.selectOption('#sim-tree select[data-k="cmp"]', s1.study);
await pg.waitForTimeout(300);
const c5 = (await sim()).compare;
check("SAM-4", !s4.error && opts[0] === "prev" && opts.includes(s1.study) && c4?.with === "prev" && Math.abs(c4.rows[0].a - c4.rows[0].b - 0.1) < 0.002 && Math.abs(c4.rows[1].b / f3 - 1) < 1e-6 && c4.rows[1].change < 0
  && c5?.with === s1.study && Math.abs(c5.rows[0].a - c5.rows[0].b - 0.2) < 0.003,
  "after the mass is changed to 0.2 kg and the study solved again, Compare offers the result before the last change, and the other study still", { opts, c4, c5 }, await snap(pg, "compare-before"));
await finish(browser, pg);
