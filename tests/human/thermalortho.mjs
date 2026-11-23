// Conductivity by direction by hand (FRS-thermal FR-TMAT-003): a steel block held at 20 and 220 °C at its ends
// passes k·A·ΔT/L; with three times k along it (and the material's k across) it passes three times as much.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalortho");
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
// TOR-1: both ends held, one k: the heat through is k·A·ΔT/L.
await hold(3, a0[0], 20);
await hold(4, a1[0], 220);
await view(7);
const k = await pg.evaluate(() => Number((document.querySelector('#sim-tree [data-v="kcond"]')?.textContent ?? "").match(/([\d.]+)\s*W/)?.[1]));
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), A = (a1[1] - a0[1]) * (a1[2] - a0[2]), L = a1[0] - a0[0], q1 = (k * 1e-3 * A * 200) / L;
check("TOR-1", !s1.error && k > 0 && Math.abs(Math.abs(s1.thermal.out[0]) / q1 - 1) < 0.01, "a block held at 20 °C and 220 °C at its ends passes k·A·ΔT/L", { k, q1, out: s1.thermal?.out, error: s1.error }, await snap(pg, "one-k"));

// TOR-2: Conductivity differs by direction…: the boxes start at the material's k; X typed as three times it.
await pg.click('#sim-tree [data-a="k3"][data-b=""]');
await pg.waitForSelector('#sim-tree input[data-k="k3x"]');
const pre = await pg.evaluate(() => ["x", "y", "z"].map(a => Number(document.querySelector(`#sim-tree input[data-k="k3${a}"]`).value)));
await pg.fill('#sim-tree input[data-k="k3x"]', String(3 * k));
await pg.keyboard.press("Tab");
await idle(pg);
const shown = await pg.evaluate(() => ({ k: document.querySelector('#sim-tree [data-v="kcond"]')?.textContent ?? "", btn: document.querySelector("#sim-tree .sim-k3btn")?.textContent ?? "", wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
const editor = await snap(pg, "by-direction");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
check("TOR-2", !s2.error && pre.every(v => Math.abs(v - k) < 1e-9) && Math.abs(Math.abs(s2.thermal.out[0]) / (3 * q1) - 1) < 0.01 && /^Thermal conductivity X /.test(shown.k) && /by direction/.test(shown.btn) && shown.wide <= 0,
  "with three times k along the block it passes three times the heat; the Material section shows k along X, Y and Z", { pre, out: s2.thermal?.out, want: 3 * q1, shown, editor }, await snap(pg, "by-direction-solved"));

// TOR-3: three times k across the block (Y and Z) and the material's along it: back to k·A·ΔT/L.
await pg.fill('#sim-tree input[data-k="k3x"]', String(k));
await pg.keyboard.press("Tab");
await idle(pg);
await pg.fill('#sim-tree input[data-k="k3y"]', String(3 * k));
await pg.keyboard.press("Tab");
await idle(pg);
await pg.fill('#sim-tree input[data-k="k3z"]', String(3 * k));
await pg.keyboard.press("Tab");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim();
check("TOR-3", !s3.error && Math.abs(Math.abs(s3.thermal.out[0]) / q1 - 1) < 0.01, "a better k across the block does not change the heat along it", { out: s3.thermal?.out, want: q1 }, await snap(pg, "across"));

// TOR-4: a bad value is refused; Russian.
await pg.fill('#sim-tree input[data-k="k3z"]', "0");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const kept = await pg.evaluate(() => window.__sv.model.store.doc.studies.at(-1).k3?.[""] ?? null);
await pg.click("#lang-btn");
await pg.waitForTimeout(200);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#tab-sim .sim-mat *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "ru");
await pg.click("#lang-btn");
check("TOR-4", !!kept && kept[2] === 3 * k && ru.length === 0, "a conductivity of 0 is refused and the values kept; the section is all in Russian", { kept, ru }, ruShot);

// TOR-5: Same in every direction goes back to the material's k.
await pg.click('#sim-tree [data-a="k3clear"]');
await idle(pg);
const gone = await pg.evaluate(() => window.__sv.model.store.doc.studies.at(-1).k3 ?? null);
check("TOR-5", gone === null, "Same in every direction removes the values", { gone }, await snap(pg, "same"));

// TOR-6: over an assembly each component has its own XYZ button.
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(300);
if (await pg.isVisible('#sim-tree [data-a="newthermal"]')) await pg.click('#sim-tree [data-a="newthermal"]');
await pg.waitForSelector('#sim-tree [data-a="k3"][data-b]');
const comp = await pg.$eval('#sim-tree .sim-complist [data-a="k3"]', b => b.dataset.b);
await pg.click(`#sim-tree [data-a="k3"][data-b="${comp}"]`);
await pg.waitForSelector('#sim-tree input[data-k="k3z"]');
await pg.fill('#sim-tree input[data-k="k3z"]', String(k / 10));
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const asmK3 = await pg.evaluate(() => window.__sv.asm.doc.studies?.at(-1)?.k3 ?? null);
const row = await pg.evaluate(() => ({ compk: document.querySelector('#sim-tree .sim-complist [data-v="compk"]')?.textContent ?? "", on: document.querySelector('#sim-tree .sim-complist [data-a="k3"]')?.classList.contains("on"), wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
check("TOR-6", !!asmK3 && asmK3[comp]?.[2] === k / 10 && /Z /.test(row.compk) && row.on && row.wide <= 0, "an assembly's component takes its own conductivity by direction from its XYZ button", { comp, asmK3, row }, await snap(pg, "asm"));

await finish(browser, pg);
