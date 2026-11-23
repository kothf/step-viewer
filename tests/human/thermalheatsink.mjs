// A board package's heatsink share by hand (FR-TBRD-003/004, FR-TBC-008): the board STEP with a heatsink block
// against the transistor is opened with its thermal package, Simulate makes the study, Keep the package's split is
// ticked, and Solve puts the transistor's heatsink share into the heatsink where the transistor touches it.
import { resolve } from "node:path";
import { open, snap, idle, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalheatsink");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp-heatsink.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);

// HS-1: Simulate makes an assembly with the heatsink as a body of its own, in a heatsink material.
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 8 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 8, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
const comps = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-complist li")].map(li => li.textContent.replace(/\s+/g, " ").trim()));
check("HS-1", comps.length === 8 && comps.some(c => /heatsink.*Alumin/i.test(c)),
  "Simulate makes the board's study with the heatsink block as a component of its own, in aluminium", comps, await snap(pg, "study"));

// HS-2: the package's split kept: tick it in the Heat from package panel.
await pg.click('#sim-tree .sim-row[data-id="l1"] [data-a="edit"]');
await pg.waitForSelector('#sim-pm input[data-k="split"]');
await pg.click('#sim-pm input[data-k="split"]');
const shot = await snap(pg, "split-ticked");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const split = await pg.evaluate(() => window.__sv.asm.doc.studies.find(x => x.kind === "thermal").loads.find(l => l.type === "pkgheat").split);
check("HS-2", split === true, "Keep the package's split is ticked in the Heat from package panel", { split }, shot);

// HS-3: Solve: Q2's 4.2 W heatsink share enters the heatsink; the Heat paths table has a Heatsink column.
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 });
await pg.waitForTimeout(600);
const r = await pg.evaluate(() => { const s = window.__sv.sim.state(); return { error: s.error, q2: s.thermal?.paths?.find(x => x.name === "Q2"), cell: document.querySelector('#sim-tree .sim-paths tr[data-path="Q2"] [data-v="psink"]')?.textContent,
  heads: [...document.querySelectorAll("#sim-tree .sim-paths th")].map(e => e.textContent), note: document.querySelector('#sim-tree [data-v="sinknote"]')?.textContent,
  sink: (s.thermal?.comps ?? []).find(c => /heatsink/i.test(c.name)) }; });
await pg.evaluate(() => document.querySelector("#sim-tree .sim-paths")?.scrollIntoView({ block: "center" }));
check("HS-3", !r.error && r.q2 && r.q2.sink > 0.5 && r.q2.sink < 4.2 && Math.abs(r.q2.board + r.q2.air + r.q2.sink - 4.4) < 0.05 && Number(r.cell) === Math.round(100 * r.q2.sink / 4.4) && r.heads.some(h => /Heatsink/.test(h)) && /4\.2 W/.test(r.note ?? "") && Math.abs((r.sink?.power ?? 0) - 4.2) < 1e-6 && r.sink.max > 40,
  "the transistor's 4.2 W heatsink share enters the heatsink where the transistor touches it, the heatsink warms above ambient, and the Heat paths table shows the part's net heat into the heatsink in a Heatsink column (some comes back through the part into the board)", r, await snap(pg, "heat-paths"));

await finish(browser, pg);
