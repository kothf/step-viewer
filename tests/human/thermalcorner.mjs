// Hottest points and heat flux at sharp corners (FRS-thermal FR-TRES-003, 1.710.0): an L-shaped bar drawn by hand,
// one end held at 20 °C and 20 W into the other end; the heat turns the sharp inside corner, where the flux keeps rising.
import { open, snap, idle, screenOf, clickAt, check, finish, cmd, eyeDir } from "./lib.mjs";
const { browser, pg } = await open("thermalcorner");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const solved = async () => { await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 }); await pg.waitForTimeout(500); };

// the L: legs 60 long and 20 wide, 20 thick, inside corner at (-10, -10)
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="new-part"]');
await idle(pg);
// the legs' ends face the eye of the isometric view (it looks from +X, −Y, +Z), so both end faces can be clicked
const sx = 1, sy = -1;
const P = (x, y, z) => [sx * x, sy * y, z];
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:line"]');
for (const p of [[-30, -30], [30, -30], [30, -10], [-10, -10], [-10, 30], [-30, 30], [-30, -30]]) await clickAt(pg, await screenOf(pg, P(p[0], p[1], 0)));
await pg.keyboard.press("Escape");
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
await dp.fill("20"); await dp.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.keyboard.press("Escape");
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await pg.waitForTimeout(900);
const eye = await eyeDir(pg);
if (Math.sign(eye[0]) !== sx || Math.sign(eye[1]) !== sy) throw new Error(`the isometric view looks from ${eye}`);
const vol = await pg.evaluate(() => window.__sv.viewer.parts.reduce((a, p) => a + (p.data?.volume ?? 0), 0));

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
await clickAt(pg, await screenOf(pg, P(30, -20, 10)));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-n="value"]', "20 W");
await pg.press('#sim-pm [data-n="value"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="temp"]');
await clickAt(pg, await screenOf(pg, P(-20, 30, 10)));
await pg.waitForTimeout(250);
await pg.fill('#sim-pm [data-q="temp"]', "20");
await pg.press('#sim-pm [data-q="temp"]', "Tab");
await pg.click("#sim-pm .pm-ok");
await idle(pg);
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s1 = await sim(), h1 = s1.thermal?.hot;
const ui1 = await pg.evaluate(() => ({ temps: document.querySelectorAll("#sim-tree .sim-thot tbody tr").length, corners: [...document.querySelectorAll("#sim-tree .sim-fcorners tbody tr")].map(r => r.className),
  note: document.querySelector('#sim-tree [data-v="fluxsing"]')?.textContent ?? "", wide: document.querySelector("#tab-sim").scrollWidth - document.querySelector("#tab-sim").clientWidth }));
await pg.locator("#sim-tree .sim-fcorners").scrollIntoViewIfNeeded().catch(() => {});
const onCorner = h => Math.abs(h.at[0] + 10 * sx) < 0.01 && Math.abs(h.at[1] + 10 * sy) < 0.01;
check("TC-1", !s1.error && vol && Math.abs(vol - 2000 * 20) < 1 && h1 && h1.corners.length >= 1 && h1.corners.every(onCorner) && ui1.corners.length === h1.corners.length && ui1.corners.every(c => c === "sing") && /sharp corner/.test(ui1.note) && /Round the corner/.test(ui1.note) && ui1.wide <= 0,
  "the heat turning the sharp inside corner of the L is marked: the flux there keeps rising pass after pass, so the Study tab lists the corner and says its value depends on refinement", { eye, vol, hot: h1, ui1, flows: s1.thermal?.flows, passes: s1.passes?.length, error: s1.error }, await snap(pg, "corner-list"));

// TC-2: a corner row shows the heat flux plot with the corner marked ⚠ and the highest flux away from it
await pg.click('#sim-tree .sim-fcorners tr[data-fc="0"]');
await pg.waitForTimeout(500);
const s2 = await sim();
const ui2 = await pg.evaluate(() => [...document.querySelectorAll("#sim-probes .sim-peak")].map(e => ({ k: e.dataset.peak, warn: e.classList.contains("warn"), text: e.textContent, tip: e.title })));
const f0 = ui2.find(p => p.k === "f0"), mx = ui2.find(p => p.k === "max");
const num = x => Number((x?.text ?? "").replace(/[^\d.]/g, ""));
check("TC-2", s2.plot.kind === "flux" && f0?.warn && /W\/m²/.test(f0.text) && /sharp corner/.test(f0.tip) && mx && !mx.warn && num(mx) < 0.8 * num(f0),
  "a click on the corner shows the heat flux plot: the corner carries a ⚠ label, and the highest flux away from it is labelled Max", { plot: s2.plot.kind, ui2 }, await snap(pg, "corner-flux"));

// TC-3: the hottest points: the first is the hottest temperature, at the heated end; a row is labelled on the temperature plot
const last = h1.temps.length - 1;
await pg.click(`#sim-tree .sim-thot tr[data-thot="${last}"]`);
await pg.waitForTimeout(500);
const s3 = await sim();
const ui3 = await pg.evaluate(() => ({ sel: document.querySelectorAll("#sim-tree .sim-thot tr.sel").length, peaks: [...document.querySelectorAll("#sim-probes .sim-peak")].map(e => e.dataset.peak) }));
check("TC-3", h1.temps.length >= 1 && Math.abs(h1.temps[0].t - s1.thermal.max) < 0.01 && h1.temps[0].at[0] * sx > 25 && s3.plot.kind === "temp" && ui3.sel === 1 && ui3.peaks.includes("max") && ui3.peaks.includes("min") && (last === 0 || ui3.peaks.includes(`t${last}`)),
  "the hottest points start with the hottest temperature, at the heated end; picking one shows the temperature plot with it labelled", { temps: h1.temps, ui3 }, await snap(pg, "corner-hottest"));

// TC-4: the list as CSV, and in the report
const csv = s3.thermal.hot.csv.split("\r\n");
check("TC-4", csv[0] === "Kind,#,X (mm),Y (mm),Z (mm),Temperature (C),Heat flux (W/m2)" && csv.filter(l => l.startsWith("Hottest point,")).length === h1.temps.length && csv.filter(l => l.startsWith("Sharp corner,")).length === h1.corners.length,
  "Export CSV saves the hottest points with their temperatures and the sharp corners with their heat flux", { csv });

// TC-5: rounding the corner (a fillet on the inside edge) makes the mark go away
await pg.click("#cm-t-features").catch(() => {});
const fil = await pg.evaluate(() => window.__sv.model.store.doc.features.length);
await pg.click('#mc-tools [data-c="fillet"]').catch(async () => cmd(pg, "Fillet"));
await pg.waitForTimeout(600);
await clickAt(pg, await screenOf(pg, P(-10, -10, 10)));
await pg.waitForTimeout(300);
const rr = await pg.$('#mc-pm input[data-num="radius"]');
if (rr) { await rr.fill("5"); await rr.press("Enter"); }
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
const fil2 = await pg.evaluate(() => window.__sv.model.store.doc.features.length);
await pg.click("#cm-t-simulation");
await pg.click('#sim-tools [data-s="solve"]');
await solved();
const s5 = await sim(), h5 = s5.thermal?.hot;
check("TC-5", fil2 === fil + 1 && !s5.error && h5 && h5.corners.length === 0 && !(await pg.$('#sim-tree [data-v="fluxsing"]')),
  "with the inside corner rounded (R 5) the flux settles and no corner is marked any more", { fil, fil2, hot: h5, error: s5.error }, await snap(pg, "corner-rounded"));
await finish(browser, pg);
