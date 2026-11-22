// Conductivity by temperature by hand (FRS-thermal FR-TMAT-004): a steel block held at 20 and 220 °C at its ends
// passes k·A·ΔT/L; with k doubling over that range it passes 1.5 times as much (the Kirchhoff answer).
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalkt");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const view = async k => { await pg.mouse.move(vp[0], vp[1]); await pg.keyboard.press(`Control+${k}`); await pg.waitForTimeout(900); };
const [a0, a1] = await pg.evaluate(() => [window.__sv.viewer.parts[0].data.bboxMin, window.__sv.viewer.parts[0].data.bboxMax]);
const ym = (a0[1] + a1[1]) / 2, zm = (a0[2] + a1[2]) / 2;
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
const hold = async (k, x, temp) => {
  await pg.click('#sim-tools [data-s="temp"]');
  await pg.waitForSelector("#sim-pm .pm-ok");
  await view(k);
  await clickAt(pg, await screenOf(pg, [x, ym, zm]));
  await pg.waitForTimeout(250);
  await pg.fill('#sim-pm [data-q="temp"]', String(temp));
  await pg.press('#sim-pm [data-q="temp"]', "Tab");
  await pg.click("#sim-pm .pm-ok");
  await idle(pg);
};
// TKT-1: both ends held, constant k: the heat through is k·A·ΔT/L.
await hold(3, a0[0], 20);
await hold(4, a1[0], 220);
await view(7);
const k = await pg.evaluate(() => Number((document.querySelector('#sim-tree [data-v="kcond"]')?.textContent ?? "").match(/([\d.]+)\s*W/)?.[1]));
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), A = (a1[1] - a0[1]) * (a1[2] - a0[2]), L = a1[0] - a0[0], q1 = (k * 1e-3 * A * 200) / L;
check("TKT-1", !s1.error && k > 0 && Math.abs(Math.abs(s1.thermal.out[0]) / q1 - 1) < 0.01, "a block held at 20 °C and 220 °C at its ends passes k·A·ΔT/L", { k, q1, out: s1.thermal?.out, error: s1.error }, await snap(pg, "constant-k"));

// TKT-2: the Material section's table: k doubles from 20 to 220 °C; solved again, the heat goes up by half.
await pg.click('#sim-tree [data-a="ktab"][data-b=""]');
await pg.waitForSelector('#sim-tree textarea[data-k="ktab"]');
await pg.fill('#sim-tree textarea[data-k="ktab"]', `20 ${k}\n220 ${2 * k}`);
await pg.keyboard.press("Tab");
await idle(pg);
const shown = await pg.evaluate(() => ({ k: document.querySelector('#sim-tree [data-v="kcond"]')?.textContent ?? "", btn: document.querySelector("#sim-tree .sim-ktbtn")?.textContent ?? "" }));
const editor = await snap(pg, "table");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), note = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="ksteps"]')?.textContent ?? "");
check("TKT-2", !s2.error && Math.abs(Math.abs(s2.thermal.out[0]) / (1.5 * q1) - 1) < 0.02 && /at 220 °C/.test(shown.k) && /2 rows/.test(shown.btn) && /solved \d+ times/.test(note),
  "with k doubling from 20 to 220 °C the block passes 1.5 times the heat, and the results say the solve was repeated until k settled", { out: s2.thermal?.out, want: 1.5 * q1, shown, note, editor }, await snap(pg, "table-k"));

// TKT-3: the temperature plot still runs from 20 to 220 °C.
check("TKT-3", s2.thermal.max > 219 && s2.thermal.min < 21, "the temperature still runs from 20 to 220 °C over the block", { min: s2.thermal.min, max: s2.thermal.max }, await snap(pg, "plot"));

// TKT-4: Russian.
await pg.click("#lang-btn");
await pg.waitForTimeout(200);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim .sim-mat *, #tab-sim .sim-results *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "ru");
await pg.click("#lang-btn");
check("TKT-4", ru.length === 0, "the Material section and its table editor are all in Russian", { ru }, ruShot);

// TKT-5: over an assembly each component has its own k(T) button.
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(300);
if (await pg.isVisible('#sim-tree [data-a="newthermal"]')) await pg.click('#sim-tree [data-a="newthermal"]');
await pg.waitForSelector('#sim-tree [data-a="ktab"][data-b]');
const comp = await pg.$eval('#sim-tree [data-a="ktab"][data-b]', b => b.dataset.b);
await pg.click(`#sim-tree [data-a="ktab"][data-b="${comp}"]`);
await pg.waitForSelector('#sim-tree textarea[data-k="ktab"]');
await pg.fill('#sim-tree textarea[data-k="ktab"]', `0 ${k}\n400 ${k * 0.8}`);
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const asmKt = await pg.evaluate(() => { const d = window.__sv.asm.doc; return d.studies?.at(-1)?.kt ?? null; });
const row = await pg.evaluate(() => ({ compk: document.querySelector('#sim-tree .sim-complist [data-v="compk"]')?.textContent ?? "", on: document.querySelector('#sim-tree .sim-complist [data-a="ktab"]')?.classList.contains("on"), wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
check("TKT-5", !!asmKt && JSON.stringify(asmKt[comp]) === JSON.stringify([[0, k], [400, k * 0.8]]) && /at 400 °C/.test(row.compk) && row.on && row.wide <= 0, "an assembly's component takes its own conductivity table from its k(T) button", { comp, asmKt, row }, await snap(pg, "asm-table"));

await finish(browser, pg);
