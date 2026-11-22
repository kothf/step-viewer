// Power cases by hand (FRS-thermal FR-TSTU-005): a block heated throughout (10 W) and at one end (5 W), cooled
// through its top face; an Idle case without the end heater and a Full power case are solved in one go.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalcases");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
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
// the end heater on the +X end face
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "5 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);

// PCS-1: Power cases section: two cases added, the first renamed Idle and without the end heater
const loads = await pg.evaluate(() => window.__sv.model.store.doc.studies.at(-1).loads.map(l => ({ id: l.id, faces: l.faces.length, body: !!l.body })));
await pg.click('#sim-tree [data-a="addcase"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tree [data-a="addcase"]');
await pg.waitForTimeout(200);
await pg.fill('#sim-tree .sim-case[data-c="c1"] input[data-k="cname"]', "Idle");
await pg.press('#sim-tree .sim-case[data-c="c1"] input[data-k="cname"]', "Tab");
await pg.waitForTimeout(200);
await pg.fill('#sim-tree .sim-case[data-c="c2"] input[data-k="cname"]', "Full power");
await pg.press('#sim-tree .sim-case[data-c="c2"] input[data-k="cname"]', "Tab");
await pg.waitForTimeout(200);
const end = loads.find(l => !l.body)?.id ?? "";
await pg.uncheck(`#sim-tree .sim-case[data-c="c1"] input[data-k="cload"][data-l="${end}"]`);
await pg.waitForTimeout(200);
const r1 = await pg.evaluate(() => ({ head: document.querySelector("#sim-tree .sim-cases h4")?.textContent ?? "", cases: window.__sv.model.store.doc.studies.at(-1).cases }));
check("PCS-1", loads.length === 2 && /Power cases/.test(r1.head) && r1.cases?.length === 2 && r1.cases[0].name === "Idle" && JSON.stringify(r1.cases[0].off) === JSON.stringify([end]) && r1.cases[1].name === "Full power" && !r1.cases[1].off.length,
  "the Power cases section takes two cases: Idle without the end heater and Full power with both", { loads, ...r1 }, await snap(pg, "cases"));

// PCS-2: one Solve runs both; the envelope (hottest of both) is shown first, with a row per case
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(500);
const r2 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, env: s.enveloped, res: s.caseResults, max: s.thermal?.max,
  rows: [...document.querySelectorAll("#sim-tree .sim-casetable tr[data-case]")].map(r => [...r.children].map(c => c.textContent)) }; });
const [ri, rf] = (r2.res ?? []).map(c => c.maxVm);
check("PCS-2", !r2.error && r2.env && r2.res?.length === 2 && rf > ri && Math.abs(r2.max - rf) < 1e-3 && r2.rows.length === 2 && r2.rows[0][2] === "10" && r2.rows[1][2] === "15",
  "Solve runs Idle (10 W) and Full power (15 W); the hottest of both is shown, and Full power is hotter", r2, await snap(pg, "envelope"));

// PCS-3: a click on Idle shows that case alone, with its own heat balance
await pg.click('#sim-tree tr[data-a="case"][data-case="0"]');
await pg.waitForTimeout(400);
const r3 = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { env: s.enveloped, sel: s.caseSel, max: s.thermal?.max, heat: document.querySelector('#sim-tree [data-v="heatin"]')?.textContent ?? "", out: s.thermal?.out }; });
check("PCS-3", !r3.env && r3.sel === 0 && Math.abs(r3.max - ri) < 1e-3 && /10 W/.test(r3.heat) && Math.abs((r3.out?.[0] ?? 0) - 10) < 0.05,
  "clicking Idle shows its temperatures: 10 W in, 10 W out through the held face", r3, await snap(pg, "idle"));
await finish(browser, pg);
