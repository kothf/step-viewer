// Thermal conditions on the model, by hand (FRS-thermal FR-TLOAD-011, FR-TBC-013): a steel block with heat on its end,
// a held temperature on the other end, radiation on a side and a heat flux; each condition shows a callout with its
// glyph and value on its faces, radiation dashed rays and the flux arrows; they go when the plot shows.
import { open, snap, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("thermalmarks");
await makeBlock(pg, 100, 20, 20);
await pg.keyboard.press("Escape");
const sim = () => pg.evaluate(() => window.__sv.sim.state());
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const view = async k => { await pg.mouse.move(vp[0], vp[1]); await pg.keyboard.press(`Control+${k}`); await pg.waitForTimeout(900); };
const [a0, a1] = await pg.evaluate(() => [window.__sv.viewer.parts[0].data.bboxMin, window.__sv.viewer.parts[0].data.bboxMax]);
const ym = (a0[1] + a1[1]) / 2, zm = (a0[2] + a1[2]) / 2, xm = (a0[0] + a1[0]) / 2;
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
const pick = async (cmd, p, fill) => {
  await pg.click(`#sim-tools [data-s="${cmd}"]`);
  await pg.waitForSelector("#sim-pm .pm-ok");
  await view(7);
  await clickAt(pg, await screenOf(pg, p));
  await pg.waitForTimeout(250);
  if (fill) { await pg.fill(`#sim-pm [${fill[0]}]`, fill[1]); await pg.press(`#sim-pm [${fill[0]}]`, "Tab"); }
  await pg.click("#sim-pm .pm-ok");
  await idle(pg);
};
// TMK-1: heat on the far end, 40 °C held on the near end, radiation on the top, a heat flux on the front.
await pick("heat", [a1[0], ym, zm], ['data-n="value"', "15 W"]);
await pick("temp", [a0[0], ym, zm], ['data-q="temp"', "40"]);
await pick("rad", [xm, ym, a1[2]]);
await pick("hflux", [xm, a0[1], zm], ['data-n="value"', "2000"]);
await view(7);
const s1 = await sim();
const kinds = s1.tags.map(x => `${x.kind}:${x.text}`);
check("TMK-1", s1.tags.length === 4 && s1.tags.every(x => x.shown) && kinds.includes("heat:15 W") && kinds.includes("temp:40 °C") && s1.tags.some(x => x.kind === "rad") && kinds.includes("hflux:2000 W/m²") && s1.rays === 1 && s1.arrowsOn === 1,
  "each condition has a callout with its glyph and value on its faces; radiation sends dashed rays, the heat flux an arrow into the face", { kinds, rays: s1.rays, arrows: s1.arrowsOn }, await snap(pg, "marks"));
// TMK-2: the plot replaces them; the Features tab hides them.
await pg.click('#sim-tools [data-s="solve"]');
await pg.waitForFunction(() => { const s = window.__sv.sim.state(); return !s.running && (s.done || s.error); }, null, { timeout: 300000 });
await pg.waitForTimeout(500);
const s2 = await sim();
const plotShot = await snap(pg, "plot");
await pg.click('#sim-tools [data-s="results"]');
await pg.waitForTimeout(400);
const s3 = await sim();
await pg.click("#cm-t-features");
await pg.waitForTimeout(300);
const s4 = await sim();
check("TMK-2", !s2.error && s2.tags.filter(x => x.shown).length === 0 && s3.tags.filter(x => x.shown).length === 4 && s4.tags.filter(x => x.shown).length === 0,
  "the callouts give way to the temperature plot, come back with the plot off, and stay in the Simulation tab", { plot: s2.tags.length, off: s3.tags.length, features: s4.tags.filter(x => x.shown).length, plotShot }, await snap(pg, "features"));
await finish(browser, pg);
