// Chassis wall by hand (FRS-thermal FR-TBC-009): a steel block making 10 W, its end bolted to a chassis wall of
// 1.5 K/W: all the heat leaves there and the wall sits at ambient + 10 × 1.5; then the wall held at 60 °C.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalchassis");
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
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// TCH-1: Chassis wall on the block's end, by its resistance (1.5 K/W to begin with).
await pg.click('#sim-tools [data-s="chassis"]');
await pg.waitForSelector('#sim-pm select[data-k="cmode"]');
await view(3);
await clickAt(pg, await screenOf(pg, [a0[0], ym, zm]));
await pg.waitForTimeout(250);
const panel = await pg.evaluate(() => ({ mode: document.querySelector('#sim-pm select[data-k="cmode"]').value, rth: document.querySelector('#sim-pm [data-q="rth"]')?.value, faces: document.querySelector("#sim-pm .sim-faces")?.textContent ?? "" }));
const panelShot = await snap(pg, "panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await view(7);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), f1 = s1.thermal?.flows?.[0];
check("TCH-1", panel.mode === "rth" && panel.rth === "1.5" && !s1.error && f1 && Math.abs(f1.out / 10 - 1) < 0.01 && Math.abs(f1.mean - (25 + 15)) < 0.5,
  "a chassis wall of 1.5 K/W on the block's end takes all 10 W and sits at 25 + 10 × 1.5 °C", { panel, panelShot, flows: s1.thermal?.flows, error: s1.error }, await snap(pg, "rth"));

// TCH-2: the same wall held at 60 °C.
await pg.click('#sim-tree .sim-cool .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm select[data-k="cmode"]');
await pg.selectOption('#sim-pm select[data-k="cmode"]', "temp");
await pg.waitForTimeout(200);
await pg.fill('#sim-pm [data-q="temp"]', "60");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const row = await pg.evaluate(() => document.querySelector("#sim-tree .sim-cool .sim-row")?.textContent ?? "");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), f2 = s2.thermal?.flows?.[0];
check("TCH-2", /60 °C/.test(row) && !s2.error && f2 && Math.abs(f2.mean - 60) < 0.3 && Math.abs(f2.out / 10 - 1) < 0.01 && s2.thermal.max > 60,
  "held at 60 °C instead: the wall is at 60 °C and the block above it", { row, flows: s2.thermal?.flows, max: s2.thermal?.max }, await snap(pg, "held"));

// TCH-3: the panel in Russian.
await pg.click('#sim-tree .sim-cool .sim-row [data-a="edit"]');
await pg.waitForSelector('#sim-pm select[data-k="cmode"]');
await pg.click("#lang-btn");
await pg.waitForTimeout(200);
const ru = await pg.evaluate(() => [...document.querySelectorAll("#sim-pm *")].filter(e => !e.children.length && !e.closest("[translate=no]")).map(e => e.textContent.trim()).filter(x => /[A-Za-z]{4}/.test(x)));
const ruShot = await snap(pg, "ru");
await pg.click("#lang-btn");
await pg.click("#sim-pm .pm-cancel");
check("TCH-3", ru.length === 0, "the chassis wall panel is all in Russian", { ru }, ruShot);

await finish(browser, pg);
