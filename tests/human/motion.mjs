// Motion studies by hand (tests list /mnt/project-files/tests/mates-motion-tests.md, sections E and F): a pin
// turning in a plate's hole driven by a motor, keys on a distance mate, play, loop, close, save and open again.
import { open, snap, idle, clickAt, check, finish, saveModel, openFiles } from "./lib.mjs";
import { plateAndPin, faceSpot, doc, CYL, TOP } from "./mates.mjs";

const { browser, pg } = await open("motion");
const vp = await plateAndPin(pg);
// Concentric pin/hole, then a 10 mm distance between the pin top and the plate top.
await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 1, CYL)); await pg.waitForTimeout(300);
await clickAt(pg, await faceSpot(pg, 0, CYL)); await pg.waitForTimeout(700);
await pg.keyboard.press("Enter"); await pg.waitForTimeout(1200); await idle(pg);
await clickAt(pg, await faceSpot(pg, 1, TOP)); await pg.waitForTimeout(300);
await clickAt(pg, await faceSpot(pg, 0, TOP)); await pg.waitForTimeout(700);
await pg.click('#asm-matebar [data-mbt="distance"]'); await pg.waitForTimeout(400);
{ const inp = pg.locator('#asm-matebar [data-mb="val"]'); await inp.click({ clickCount: 3 }); await pg.keyboard.type("10"); await pg.keyboard.press("Enter"); }
await pg.waitForTimeout(1200); await idle(pg);
await pg.click('#asm-pm [data-a="ok"]').catch(() => {});
await pg.waitForTimeout(500);
const d0 = await doc(pg);
check("setup", d0.mates.length === 2, "a pin with a concentric and a 10 mm distance mate", d0.mates);

/** The pin as the view shows it: turn about Z (deg) and height of its origin. */
const shown = () => pg.evaluate(() => {
  const g = window.__sv.viewer.parts[1].group; g.updateMatrixWorld(true);
  const e = g.matrixWorld.elements;
  return { ang: (Math.atan2(e[1], e[0]) * 180) / Math.PI, z: e[14], x: e[12], y: e[13] };
});
const rest = await shown();

// E1: Motion study opens a timeline pane under the view.
await pg.click('#asm-tools [data-ac="motion"]');
await pg.waitForTimeout(800);
const pane = await pg.evaluate(() => { const m = document.getElementById("motion"); return m && !m.hidden && m.offsetHeight > 60 ? { h: m.offsetHeight, opts: [...m.querySelectorAll("select[data-mo=add] option")].map(o => o.textContent) } : null; });
check("E1", !!pane, "Motion study opens the timeline pane with an Add track list", pane, await snap(pg, "pane"));

// E6: duration 1.25 s.
await pg.fill('#motion input[data-mo="duration"]', "1.25");
await pg.press('#motion input[data-mo="duration"]', "Enter");
await pg.waitForTimeout(400);
const dur = await pg.evaluate(() => window.__sv.motion.study.duration);
check("E6", Math.abs(dur - 1.25) < 1e-9, "the study's duration is typed in the pane", { dur });

// E2: a rotary motor on the concentric mate at 60 rpm: at the end (1.25 s) the pin has turned 450° = 90° on.
const conc = d0.mates.find(m => m.type === "concentric").id;
await pg.selectOption('#motion select[data-mo="add"]', `motor:${conc}`);
await pg.waitForTimeout(600);
const sp = pg.locator('#motion input[data-p="speed"]');
const hasSpeed = await sp.count();
if (hasSpeed) { await sp.fill("60"); await sp.press("Enter"); await pg.waitForTimeout(500); }
await pg.click('#motion [data-mo="end"]');
await pg.waitForTimeout(2500);
const atEnd = await shown();
const turn = (((atEnd.ang - rest.ang) % 360) + 540) % 360 - 180;
const img2 = await snap(pg, "motor-end");
check("E2", hasSpeed && Math.abs(Math.abs(turn) - 90) < 2 && Math.abs(atEnd.z - rest.z) < 1e-3, "a 60 rpm rotary motor on the concentric mate: at 1.25 s the pin has turned 450° (90° on) and stays at its height", { rest, atEnd, turn }, img2);

// F1: Play from the start: the time display and the pin move.
await pg.click('#motion [data-mo="start"]');
await pg.waitForTimeout(800);
const a0 = await shown();
await pg.click('#motion [data-mo="play"]');
await pg.waitForTimeout(500);
const mid = await shown();
const tmid = await pg.evaluate(() => window.__sv.motion.time);
await pg.waitForTimeout(1800);
const tend = await pg.evaluate(() => [window.__sv.motion.time, window.__sv.motion.playing]);
check("F1", Math.abs(mid.ang - a0.ang) > 5 && tmid > 0 && tmid < 1.25 && tend[1] === false && Math.abs(tend[0] - 1.25) < 0.05, "Play runs the study once: the pin turns while the time runs, it stops at the end", { a0, mid, tmid, tend });

// F2: Loop keeps playing past the end; Pause stops it.
await pg.selectOption('#motion select[data-mo="mode"]', "loop");
await pg.click('#motion [data-mo="play"]');
await pg.waitForTimeout(2600);
const looping = await pg.evaluate(() => [window.__sv.motion.playing, window.__sv.motion.time]);
await pg.click('#motion [data-mo="play"]');
await pg.waitForTimeout(300);
const paused = await pg.evaluate(() => window.__sv.motion.playing);
check("F2", looping[0] === true && paused === false, "Loop keeps playing after the end; the play button pauses it", { looping, paused });

// E4: keys on the distance mate: 10 mm at 0, 30 mm at the end → at the end the pin stands 20 mm higher.
const dist = d0.mates.find(m => m.type === "distance").id;
await pg.selectOption('#motion select[data-mo="add"]', `mate:${dist}`);
await pg.waitForTimeout(600);
const kv = pg.locator('#motion input[data-p="v"]');
const hasV = await kv.count();
if (hasV) { await kv.fill("30"); await kv.press("Enter"); await pg.waitForTimeout(500); }
await pg.click('#motion [data-mo="end"]');
await pg.waitForTimeout(2500);
const up = await shown();
const img4 = await snap(pg, "mate-keys");
check("E4", hasV && Math.abs(Math.abs(up.z - rest.z) - 20) < 0.05, "keys on the distance mate (10 → 30 mm): at the end the pin stands 20 mm higher", { rest: rest.z, up: up.z }, img4);

// F4: Trace path: pick a point on the pin's top rim, a path is drawn.
await pg.selectOption('#motion select[data-mo="add"]', "trace:");
await pg.waitForTimeout(400);
const rim = await faceSpot(pg, 1, TOP);
await clickAt(pg, rim);
await pg.waitForTimeout(3000);
const traces = await pg.evaluate(() => window.__sv.motion.study.traces?.length ?? 0);
check("F4", traces === 1, "Trace path… then a click on the pin adds a trace path result", { traces }, await snap(pg, "trace"));

// F3: closing the study puts the assembly back where it was.
await pg.click('#motion [data-mo="close"]');
await pg.waitForTimeout(1200);
const back = await shown();
check("F3", Math.abs(back.ang - rest.ang) < 0.5 && Math.abs(back.z - rest.z) < 1e-3, "closing the study shows the assembly as it was", { rest, back }, await snap(pg, "closed"));

// F8: undo inside the study history: Ctrl+Z after closing takes back the last study change (the trace).
// E8: save and open again: the study is there.
const file = await saveModel(pg, "/tmp/claude-0/ht-motion", "Pinplate");
await openFiles(pg, [file]);
await pg.waitForTimeout(1500);
const studies = await pg.evaluate(() => (window.__sv.asm.doc?.motions ?? []).map(s => ({ name: s.name, tracks: s.tracks.map(k => k.kind), traces: s.traces?.length ?? 0 })));
check("E8", studies.length === 1 && studies[0].tracks.includes("motor") && studies[0].tracks.includes("mate"), "the study is saved in the assembly file and comes back when it is opened", { file, studies });
await pg.click('#asm-tools [data-ac="motion"]');
await pg.waitForTimeout(800);
await pg.click('#motion [data-mo="end"]');
await pg.waitForTimeout(2500);
const again = await shown();
check("E8-run", Math.abs(Math.abs(again.z - rest.z) - 20) < 0.05, "the opened study runs as before", { again, rest }, await snap(pg, "reopened"));
await finish(browser, pg);
