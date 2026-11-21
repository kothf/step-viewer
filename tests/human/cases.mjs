// Load cases by hand (FRS-structural FR-LOAD-022): a clamped block with a force and a pressure gets two cases, one
// with both loads and one with the force alone; Solve runs both, and the results show a case or the envelope.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simcases");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };

await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
for (const kind of ["force", "pressure"]) {
  await pg.click(`#sim-tools [data-s="${kind}"]`);
  await clickAt(pg, await screenOf(pg, [-30, 0, 20]));
  await pg.waitForTimeout(250);
  await pg.click("#sim-pm .pm-ok");
  await idle(pg);
}
await pg.selectOption('#sim-tree [data-k="passes"]', "2");
await idle(pg);

// C-1: two cases; the second leaves the pressure out and gets a name.
await pg.click('#sim-tree [data-a="addcase"]');
await idle(pg);
await pg.click('#sim-tree [data-a="addcase"]');
await idle(pg);
await pg.uncheck('#sim-tree .sim-case:nth-of-type(2) input[data-k="cload"] >> nth=1');
await idle(pg);
await pg.fill('#sim-tree .sim-case:nth-of-type(2) input[data-k="cname"]', "Force only");
await pg.keyboard.press("Tab");
await idle(pg);
const img1 = await snap(pg, "cases-set-up");
const s1 = await sim();
const wide = await pg.evaluate(() => document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth);
check("C-1", s1.cases.length === 2 && s1.cases[0].off.length === 0 && s1.cases[1].off.length === 1 && s1.cases[1].name === "Force only" && wide <= 0,
  "two load cases are listed in the Study tab, each with its loads ticked; the second has a name and one load left out", { cases: s1.cases, wide }, img1);

// C-2: Solve runs both; the envelope is shown, with a table of the cases.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim();
const rows = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-casetable tbody tr")].map(r => r.textContent));
const top = Math.max(...s2.caseResults.map(c => c.maxVm));
check("C-2", !s2.error && s2.caseResults.length === 2 && s2.enveloped && Math.abs(s2.maxVm - top) < 1e-9 * top && s2.caseResults[0].maxVm > s2.caseResults[1].maxVm && rows.length === 2 && s2.plot.shown,
  "Solve runs both cases; the plot shows the envelope and the table lists each case's highest stress and displacement", { caseResults: s2.caseResults, maxVm: s2.maxVm, rows }, await snap(pg, "cases-envelope"));

// C-3: the second case picked from the list: its own, lower values; a section plane then shows it inside the part.
await pg.selectOption('#sim-tree [data-k="case"]', "1");
await pg.waitForTimeout(500);
const s3 = await sim();
check("C-3", !s3.enveloped && s3.caseSel === 1 && Math.abs(s3.maxVm - s2.caseResults[1].maxVm) < 1e-9 * s3.maxVm && s3.maxVm < s2.maxVm && s3.reactions.length === 1,
  "picking a case shows that case alone, with its reaction", { caseSel: s3.caseSel, maxVm: s3.maxVm, reactions: s3.reactions.length }, await snap(pg, "cases-second"));

// C-4: a case deleted: the results go out of date.
await pg.click('#sim-tree .sim-case:nth-of-type(2) [data-a="rmcase"]');
await idle(pg);
const s4 = await sim();
check("C-4", s4.cases.length === 1 && s4.stale, "deleting a case leaves one and marks the results out of date", { cases: s4.cases.length, stale: s4.stale }, await snap(pg, "cases-deleted"));

await finish(browser, pg);
