// Study housekeeping and result extras by hand (FRS-structural FR-STU-003, FR-RES-006, FR-RES-007, FR-REP-003):
// rename a study, the load balance, show only a range of values, hot spots as CSV, the deformed shape as STL.
import { readFileSync } from "node:fs";
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("simextras");
await makeBlock(pg, 40, 20, 5);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="mat"]');
await pg.waitForSelector("#mat-dlg[open]");
await pg.fill("#mat-q", "S235");
await pg.waitForTimeout(300);
await pg.click("#mat-dlg .mat-list li");
await pg.click('#mat-dlg [data-a="ok"]');
await idle(pg);
await pg.keyboard.press("Control+7");
await pg.waitForTimeout(800);

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const wide = () => pg.evaluate(() => { const e = document.querySelector("#tab-sim"); return e.scrollWidth - e.clientWidth; });
await pg.click('#sim-tools [data-s="new"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
// held on a long side, pushed down on the top face
await pg.click('#sim-tools [data-s="fixed"]');
await clickAt(pg, await screenOf(pg, [8, -10, 2.5]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-8, 3, 5]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "200");
await pg.keyboard.press("Tab");
await pg.click("#sim-pm .pm-ok");
await pg.waitForTimeout(400);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim();
const bal = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="balance"]')?.textContent ?? "");
check("SX-1", !s1.error && s1.balance && s1.balance.off < 0.1 && Math.abs(Math.hypot(...s1.balance.force) / 200 - 1) < 0.001 && /%/.test(bal),
  "the results give how far the reactions are from balancing the 200 N: under 0.1 %", { error: s1.error, balance: s1.balance, bal }, await snap(pg, "balance"));

// the study renamed: the results stay
await pg.click('#sim-tree [data-a="renstudy"]');
await pg.waitForSelector('#sim-tree [data-k="sname"]');
await pg.keyboard.type("Shelf under 200 N");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(400);
const s2 = await sim();
const head = await pg.evaluate(() => document.querySelector("#sim-tree .sim-head")?.textContent ?? "");
check("SX-2", /Shelf under 200 N/.test(head) && !s2.renaming && !s2.stale && s2.done && (await wide()) <= 0,
  "the pencil next to the study's name lets it be typed anew; the results are kept", { head, stale: s2.stale, wide: await wide() }, await snap(pg, "renamed"));

// only the places at or above half the highest stress
const all = s2.drawn;
await pg.check('#sim-legend [data-k="iso"]');
await pg.waitForTimeout(400);
const s3 = await sim();
await pg.fill('#sim-legend [data-k="isoval"]', String(Math.round(s2.maxVm * 0.25)));
await pg.keyboard.press("Tab");
await pg.waitForTimeout(400);
const s4 = await sim();
const shot = await snap(pg, "iso-above");
await pg.selectOption('#sim-legend [data-k="isoside"]', "below");
await pg.waitForTimeout(400);
const s5 = await sim();
const shot2 = await snap(pg, "iso-below");
await pg.uncheck('#sim-legend [data-k="iso"]');
await pg.waitForTimeout(400);
const s6 = await sim();
check("SX-3", s3.iso.on && s3.drawn > 0 && s3.drawn < all && s4.drawn > s3.drawn && s4.drawn < all && s5.drawn > 0 && s5.drawn < all && s4.drawn + s5.drawn >= all && s6.drawn === all,
  "Show only a range of values: at or above half the range, then above a typed stress, then at or below it; unticked, the whole plot is back", { all, mid: [s3.iso.at, s3.drawn], above: [s4.iso.at, s4.drawn], below: s5.drawn, back: s6.drawn }, shot);
void shot2;

// the hot spots as CSV and the deformed shape as STL
const [d1] = await Promise.all([pg.waitForEvent("download"), pg.click('#sim-tree [data-a="hotcsv"]')]);
const csv = readFileSync(await d1.path(), "utf8").trim().split(/\r\n/);
const [d2] = await Promise.all([pg.waitForEvent("download"), pg.click('#sim-tree [data-a="stl"]')]);
const stl = readFileSync(await d2.path());
const s7 = await sim();
const tris = stl.readUInt32LE(80);
check("SX-4", csv[0].startsWith("Hot spot,X (mm)") && csv.length >= 2 && /-hot-spots\.csv$/.test(d1.suggestedFilename()) && /-deformed\.stl$/.test(d2.suggestedFilename())
  && stl.length === 84 + 50 * tris && tris === s7.stl.tris && tris > 100 && s7.stl.scale > 1,
  "Export CSV under the hot spots saves their places and stresses; Deformed shape as STL saves the shape at the scale shown", { csv: csv.slice(0, 3), names: [d1.suggestedFilename(), d2.suggestedFilename()], tris, stl: s7.stl }, await snap(pg, "exports"));

// a second study; the one picked is remembered for the document
await pg.click('#sim-tools [data-s="newmodal"]');
await pg.waitForTimeout(500);
await pg.keyboard.press("Escape");
const s8 = await sim();
await pg.selectOption('#sim-tree select[data-k="study"]', s1.study);
await pg.waitForTimeout(500);
const s9 = await sim();
const kept = await pg.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("mc:simStudy:")).map(k => localStorage.getItem(k)));
check("SX-5", s8.study !== s1.study && s9.study === s1.study && kept.includes(s1.study) && s9.done,
  "with two studies, the one picked is remembered for the document, and its results come back", { studies: [s1.study, s8.study, s9.study], kept, done: s9.done }, await snap(pg, "two-studies"));
await finish(browser, pg);
