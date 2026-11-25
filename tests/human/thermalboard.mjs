// A board's own thermal study by hand (FRS-thermal J5): the STEP and its thermal package are opened, Simulate
// makes the assembly and the study, Solve gives the part temperatures beside their limits, and a heatsink given
// by its thermal resistance on the transistor's top cools it.
import { resolve } from "node:path";
import { open, snap, idle, screenOf, clickAt, check, finish, openFiles } from "./lib.mjs";
const { browser, pg } = await open("thermalboard");
const fx = resolve("tests/fixtures/thermal");
await openFiles(pg, [resolve(fx, "amp.step"), resolve(fx, "amp-thermal.zip")]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 120000 });
await pg.waitForTimeout(800);

// TB-1: Simulate on the Thermal bar makes an assembly of the board's bodies with a thermal study.
await pg.click('#th-tools [data-th="simulate"]');
await pg.waitForFunction(() => window.__sv.asm.doc?.components.length === 7 && !window.__sv.asm.building && document.querySelector("#asm-busy").hidden && window.__sv.viewer.parts.length === 7, null, { timeout: 240000 });
await pg.waitForTimeout(1200);
const made = await pg.evaluate(() => ({ comps: [...document.querySelectorAll("#sim-tree .sim-complist li")].map(li => li.textContent.replace(/\s+/g, " ").trim()),
  rows: [...document.querySelectorAll("#sim-tree .sim-row")].map(r => r.innerText.replace(/\s+/g, " ").trim()), ambient: document.querySelector('#sim-tree input[data-k="ambient"]')?.value,
  tabs: [...document.querySelectorAll("#doc-tabs [data-dt]")].map(e => e.textContent.trim()), mode: document.querySelector('#sim-tools [data-s="mode-thermal"]')?.getAttribute("aria-pressed") }));
check("TB-1", made.comps.length === 7 && made.comps.some(c => /^PCB<1>.*Circuit board.*7\.12 W\/\(m·K\) along the board, 0\.314 W\/\(m·K\) through/.test(c)) && made.comps.some(c => /^Q2<1>.*Copper/.test(c)) && made.rows.some(r => /Heat from package 1.*6 parts/.test(r))
  && made.rows.some(r => /Convection 1.*all open surfaces/.test(r)) && made.rows.some(r => /Radiation 1.*all open surfaces/.test(r)) && made.ambient === "40" && made.tabs.length === 2,
  "Simulate makes an assembly named after the package's parts, with the board marked as a circuit board (its conductivity along and through from its copper) and guessed part materials, and a thermal study: heat from the package, the package's ambient, convection and radiation from all open surfaces", made, await snap(pg, "board-study"));

const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 600000 }); await pg.waitForTimeout(600); };
const table = () => pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-tcomps tbody tr")].map(r => ({ name: r.children[0].textContent, max: Number(r.children[1].textContent), limit: r.children[2].textContent, bad: r.classList.contains("bad") })));

// TB-2: solved as it is: all the heat leaves through the air, hot parts are marked.
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), t1 = await table();
const over1 = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="tover"]')?.textContent ?? "");
const out1 = (s1.thermal?.out ?? []).reduce((a, x) => a + x, 0);
check("TB-2", !s1.error && Math.abs(s1.thermal.applied - 29.17) < 1e-6 && Math.abs(out1 - 29.17) < 0.05 && t1.length === 7 && t1.filter(r => r.limit).length === 6 && t1.some(r => r.bad) && /over/.test(over1),
  "the board solves as it stands: the package's 29.17 W leave by convection and radiation, each part's temperature stands beside its limit, parts over their limit are red", { error: s1.error, applied: s1.thermal?.applied, out: s1.thermal?.out, t1, over1 }, await snap(pg, "board-solved"));

// TB-3: a heatsink of 3 K/W on the transistor's top face, given by its thermal resistance.
const q2 = await pg.evaluate(() => { const v = window.__sv.viewer, i = window.__sv.asm.doc.components.findIndex(c => c.name.startsWith("Q2")), p = v.parts[i]; return [p.data.bboxMin, p.data.bboxMax]; });
await pg.click('#sim-tools [data-s="conv"]');
await clickAt(pg, await screenOf(pg, [(q2[0][0] + q2[1][0]) / 2, (q2[0][1] + q2[1][1]) / 2, q2[1][2]]));
await pg.waitForTimeout(300);
const picked = await pg.evaluate(() => document.querySelector("#sim-pm .sim-faces")?.textContent ?? "");
await pg.selectOption('#sim-pm select[data-k="film"]', "rth");
await pg.waitForSelector('#sim-pm input[data-q="rth"]');
await pg.fill('#sim-pm input[data-q="rth"]', "3");
await pg.press('#sim-pm input[data-q="rth"]', "Tab");
const shot = await snap(pg, "heatsink-panel");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
const row = await pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-row")].map(r => r.innerText.replace(/\s+/g, " ").trim()).find(r => /Convection 2/.test(r)) ?? "");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s2 = await sim(), t2 = await table();
const q = n => (n.find(r => /^Q2</.test(r.name)) ?? {}).max;
check("TB-3", picked === "1 face" && /3 K\/W/.test(row) && !s2.error && s2.thermal.out.length === 3 && s2.thermal.out[2] > 1 && q(t2) < q(t1) - 20 && Math.abs(s2.thermal.out.reduce((a, x) => a + x, 0) - 29.17) < 0.05,
  "a heatsink of 3 K/W on the transistor's top face takes part of the heat and the transistor runs much cooler", { picked, row, q2before: q(t1), q2after: q(t2), out: s2.thermal?.out, error: s2.error }, shot);
await snap(pg, "board-with-heatsink");

// TB-4: the board's copper: unticking Board analyses it as an ordinary body with one conductivity, and the parts' temperatures change.
const pcb = await pg.evaluate(() => window.__sv.sim.state().compList.find(c => c.name === "PCB<1>").id);
await pg.click(`#sim-tree .sim-complist li[data-comp="${pcb}"] [data-a="compboard"]`);
await idle(pg);
const plain = await pg.evaluate(id => document.querySelector(`#sim-tree .sim-complist li[data-comp="${id}"]`).textContent.replace(/\s+/g, " ").trim(), pcb);
const shot4 = await snap(pg, "board-as-ordinary-body");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s3 = await sim(), t3 = await table();
const of = (tb, n) => (tb.find(r => r.name.startsWith(n)) ?? {}).max;
check("TB-4", /7\.12 W\/\(m·K\).*PCB \(effective\)/.test(plain) && !/0\.314/.test(plain) && !s3.error && Math.abs(of(t3, "C12") - of(t2, "C12")) > 0.5 && Math.abs(s3.thermal.out.reduce((a, x) => a + x, 0) - 29.17) < 0.05,
  "with Board unticked the board is an ordinary body of one conductivity; the temperatures of the parts on it differ from the ones with the copper layers taken by direction", { plain, error: s3.error, board: [of(t2, "PCB"), of(t3, "PCB")], c12: [of(t2, "C12"), of(t3, "C12")], r14: [of(t2, "R14"), of(t3, "R14")] }, shot4);

// TB-5: heat paths: the table says where each part's heat goes; the package's split is always kept, so the board shares enter the board under the parts.
await pg.click(`#sim-tree .sim-complist li[data-comp="${pcb}"] [data-a="compboard"]`);
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const paths = async () => pg.evaluate(() => [...document.querySelectorAll("#sim-tree .sim-paths tr[data-path]")].map(r => ({ name: r.dataset.path, board: r.querySelector('[data-v="pboard"]').textContent, surface: r.querySelector('[data-v="pair"]').textContent, title: r.title })));
const p1 = await paths(), s5 = await sim();
await pg.locator("#sim-tree .sim-paths").scrollIntoViewIfNeeded();
const shot5 = await snap(pg, "heat-paths-package-split");
const pathRow = (ps, n) => ps.find(r => r.name === n) ?? {};
check("TB-5", p1.length === 6 && p1.every(r => /package's split/.test(r.title)) && pathRow(p1, "R14").board === "52" && pathRow(p1, "R20").board === "56" && !s5.error && Math.abs(s5.thermal.applied - 29.17) < 0.01,
  "the Heat paths table shows each part's share into the board and off its own surface; the package's split is always kept, so R14 and R20 put the package's board shares into the board", { p1, applied: s5.thermal?.applied }, shot5);

// TB-6: natural convection: the package's closed chassis is the study's enclosure; picking Open frame sets 25 °C and the parts run cooler.
const enc = await pg.evaluate(() => ({ enc: document.querySelector('#sim-tree select[data-k="enclosure"]').value, down: document.querySelector('#sim-tree select[data-k="down"]').value, h: document.querySelector('#sim-tree [data-v="hnat"]')?.textContent ?? "" }));
const max6 = (await sim()).thermal.max;
await pg.locator('#sim-tree select[data-k="enclosure"]').scrollIntoViewIfNeeded();
const shot7 = await snap(pg, "enclosure-closed");
await pg.selectOption('#sim-tree select[data-k="enclosure"]', "open");
await idle(pg);
const amb6 = await pg.evaluate(() => document.querySelector('#sim-tree input[data-k="ambient"]').value);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s6 = await sim(), h6 = await pg.evaluate(() => document.querySelector('#sim-tree [data-v="hnat"]')?.textContent ?? "");
check("TB-6", enc.enc === "closed" && enc.down === "−Z" && /W\/\(m²·K\)/.test(enc.h) && amb6 === "25" && !s6.error && s6.thermal.max < max6 - 20 && parseFloat(h6) > parseFloat(enc.h),
  "natural convection: the study takes the package's closed chassis and lies with gravity along −Z; Open frame sets the ambient to 25 °C, raises the film coefficient and the parts run cooler", { enc, max6, amb6, max: s6.thermal?.max, h6, shot7 }, await snap(pg, "enclosure-open"));
await finish(browser, pg);
