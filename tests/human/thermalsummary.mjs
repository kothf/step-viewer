// The summary card of a thermal study (FRS-thermal FR-TRES-002) and power typed in BTU/h (FR-TLOAD-010): a 100 × 20 × 20 mm
// block with 10 BTU/h on an end face, cooled by convection on the top face.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalsummary");
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

// TS-1: Heat power typed as 10 BTU/h on the end face = 2.93 W
await pg.click('#sim-tools [data-s="heat"]');
await pg.waitForSelector("#sim-pm .pm-ok");
await clickAt(pg, await screenOf(pg, [50, 0, 10]));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "10 BTU/h");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.waitForTimeout(200);
const shot1 = await snap(pg, "btu");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const r1 = await pg.evaluate(() => { const l = window.__sv.model.store.doc.studies.at(-1).loads[0]; return { v: l?.value, faces: l?.faces.length }; });
check("TS-1", Math.abs((r1.v?.v ?? 0) - 2.9307107) < 1e-6 && r1.v?.expr === "10 BTU/h" && r1.faces === 1, "Heat power typed as 10 BTU/h is kept as typed and is 2.93 W", r1, shot1);

await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.waitForTimeout(250);
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(500);

// TS-2: the summary card over the view: hottest, coolest, heat in with the balance, error estimate
const card = () => pg.evaluate(() => { const el = document.querySelector("#sim-summary"); const r = el?.getBoundingClientRect(); return { shown: !!el && !el.hidden && (r?.width ?? 0) > 0, head: el?.querySelector('[data-v="hottest"]')?.textContent ?? "", lines: [...(el?.querySelectorAll("li[data-v]") ?? [])].map(l => [l.dataset.v, l.textContent]) }; });
const s2 = await pg.evaluate(() => window.__sv.sim.state()), c2 = await card();
const get = (c, k) => c.lines.find(l => l[0] === k)?.[1] ?? "";
check("TS-2", !s2.error && c2.shown && c2.head.includes(String(Math.round(s2.thermal.max))) && get(c2, "scold").includes(String(Math.round(s2.thermal.min))) && /Heat in 2\.93 W/.test(get(c2, "sbalance")) && /error/.test(get(c2, "serror")),
  "The card over the view says the hottest and coolest temperatures, 2.93 W in with the balance and the error estimate", { c2, max: s2.thermal.max, min: s2.thermal.min }, await snap(pg, "card"));

// TS-3: clicking the hottest line shows the temperature plot with the hottest point picked
await pg.selectOption('#sim-legend [data-k="kind"]', "flux");
await idle(pg);
await pg.click('#sim-summary [data-v="shot"]');
await pg.waitForTimeout(300);
const s3 = await pg.evaluate(() => window.__sv.sim.state());
check("TS-3", s3.plot.on && s3.plot.kind === "temp" && s3.thermal.hot.sel === 0, "From the heat flux plot, the hottest line goes back to the temperature plot with the hottest point picked", { plot: s3.plot, sel: s3.thermal.hot.sel }, await snap(pg, "hot"));

// TS-4: folding keeps one line, and stays folded after a reload of the view state
await pg.click('#sim-summary [data-a="fold"]');
const c4 = await card(), kept = await pg.evaluate(() => localStorage.getItem("mc:simSummary"));
const shot4 = await snap(pg, "folded");
await pg.click('#sim-summary [data-a="fold"]');
const c4b = await card();
check("TS-4", c4.shown && c4.lines.length === 0 && /Hottest/.test(c4.head) && kept === "1" && c4b.lines.length === c2.lines.length, "The card folds to its hottest line, remembered, and opens again", { c4, kept, back: c4b.lines.length }, shot4);
await finish(browser, pg);
