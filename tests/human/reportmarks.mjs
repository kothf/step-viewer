// Highest and lowest values in study reports (1.679.0): each picture of a structural and of a thermal report has an
// arrow and a label at its highest value (lowest for a safety factor, both for temperature), and a table says where they are.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("reportmarks");
const out = process.env.HT_OUT ?? "/mnt/project-files/gap-tests";
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };
const report = async (name) => {
  await pg.click('#sim-tools [data-s="report"]');
  await pg.waitForSelector("dialog.choose-dlg[open]");
  const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
  const path = `${out}/${name}.html`;
  await dl.saveAs(path);
  const rp = await pg.context().newPage();
  await rp.setViewportSize({ width: 1000, height: 1400 });
  await rp.goto(`file://${path}`);
  const facts = await rp.evaluate(() => ({ imgs: [...document.querySelectorAll("figure img")].length,
    tables: [...document.querySelectorAll("table")].filter(t => /X, Y, Z/.test(t.querySelector("thead")?.textContent ?? "")).map(t => [...t.querySelectorAll("tbody tr")].map(r => [...r.cells].map(c => c.textContent))) }));
  const fig = await rp.$("figure");
  const shot = `${out}/${name}-picture.png`;
  await fig.screenshot({ path: shot });
  await rp.close();
  return { facts, shot, state: (await sim()).report };
};

// RM-1: a cantilever: fixed end, 1000 N on the top face at the other end.
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
await pg.click('#sim-tools [data-s="force"]');
await clickAt(pg, await screenOf(pg, [-40, 0, 20]));
await pg.fill('#sim-pm [data-n="value"]', "1000");
await pg.keyboard.press("Tab");
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r1 = await report("reportmarks-structural");
const u = r1.state.marks[1]?.[0], vm = r1.state.marks[0]?.[0];
check("RM-1", !(await sim()).error && r1.facts.imgs >= 2 && r1.facts.tables.length >= 2 && vm?.max && u?.max && u.at[0] < -40 && vm.at[0] > 30,
  "the structural report marks the highest stress (near the clamped end) and the largest displacement (at the free end) with arrows, and lists where they are", { marks: r1.state.marks, tables: r1.facts.tables }, r1.shot);

// RM-2: a thermal study of the same block: 10 W made throughout, the top face at 40 °C.
await pg.click('#sim-tools [data-s="mode-thermal"]');
await pg.waitForTimeout(200);
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await pg.check('#sim-pm [data-k="body"]');
await pg.fill('#sim-pm [data-n="value"]', "10 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "40");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const r2 = await report("reportmarks-thermal");
const t2 = r2.state.marks[0] ?? [], hot = t2.find(e => e.max), cold = t2.find(e => !e.max);
check("RM-2", !(await sim()).error && hot && cold && hot.at[0] < -45 && cold.at[0] > 45 && hot.value > cold.value && r2.facts.tables[0]?.length === 2,
  "the thermal report marks the hottest point (the far end) and the coldest (the face held at 40 °C), with a table of both places", { marks: r2.state.marks, tables: r2.facts.tables }, r2.shot);

await finish(browser, pg);
