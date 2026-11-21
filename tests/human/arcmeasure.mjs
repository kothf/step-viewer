// 1.649.0: Smart measure arc/circle conditions, by hand: a block with a Ø20 hole; click the block's corner, then the
// hole's rim: the card offers Centre / Minimum / Maximum (as other CAD apps' Measure tool), each giving its distance;
// pin it at Maximum, select the pinned one and switch it to Minimum from its card.
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf } from "./lib.mjs";
const { browser, pg } = await open("arcmeasure");
await makeBlock(pg, 100, 60, 20);
// A Ø20 hole at the origin, cut from the top face.
await clickAt(pg, await screenOf(pg, [20, 10, 20]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(1500);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await clickAt(pg, await screenOf(pg, [10, 0, 20]));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.click("#mc-ok");
await pg.waitForTimeout(1500);
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);

// Corner (50, 30, 20), then the rim at 30° (clear of the quadrant snaps).
const live = () => pg.evaluate(() => { const m = window.__sv.state.live; return m ? { title: m.data.title, value: m.value, mode: m.data.mode, picks: window.__sv.state.livePicks.map(p => p.kind) } : null; });
await clickAt(pg, await screenOf(pg, [50, 30, 20]));
await clickAt(pg, await screenOf(pg, [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6), 20]));
await pg.waitForTimeout(300);
const rho = Math.hypot(50, 30);
const c0 = await live();
const btns = await pg.$$eval("#readout [data-cmode]", els => els.map(e => e.textContent.trim()));
const img1 = await snap(pg, "centre");
check("A1", c0 && Math.abs(c0.value - rho) < 0.05 && btns.length === 3, "corner to the hole's rim: Centre / Minimum / Maximum on the card, Centre = distance to the hole's centre", { c0, btns, expect: rho }, img1);

await pg.click('#readout [data-cmode="min"]');
await pg.waitForTimeout(200);
const c1 = await live();
const img2 = await snap(pg, "minimum");
check("A2", c1 && c1.mode === "min" && Math.abs(c1.value - (rho - 10)) < 0.05, "Minimum: to the nearest point of the rim", { c1, expect: rho - 10 }, img2);

await pg.click('#readout [data-cmode="max"]');
await pg.waitForTimeout(200);
const c2 = await live();
const img3 = await snap(pg, "maximum");
check("A3", c2 && c2.mode === "max" && Math.abs(c2.value - (rho + 10)) < 0.05, "Maximum: to the farthest point of the rim", { c2, expect: rho + 10 }, img3);

// Pin at Maximum, then select it in the Measurements list and switch it to Minimum.
await pg.getByRole("button", { name: /Pin/ }).first().click();
await pg.waitForTimeout(300);
await pg.mouse.click(5, 300);
await pg.keyboard.press("Escape");
const id = await pg.evaluate(() => window.__sv.state.measurements.at(-1)?.id);
// Click its label on the model, as a person would.
const row = await pg.$(`#labels .m-label[data-id="${id}"]`);
if (row) await row.click();
await pg.waitForTimeout(300);
const hasBtns = await pg.$$eval("#readout [data-cmode]", els => els.length);
if (hasBtns) await pg.click('#readout [data-cmode="min"]');
await pg.waitForTimeout(300);
const pinned = await pg.evaluate(() => { const m = window.__sv.state.measurements.at(-1); return m ? { value: m.value, mode: m.src?.mode } : null; });
const img4 = await snap(pg, "pinned-min");
check("A4", hasBtns === 3 && pinned?.mode === "min" && Math.abs(pinned.value - (rho - 10)) < 0.05, "a pinned measurement keeps its condition and switches from its card", { viaRow: !!row, hasBtns, pinned }, img4);
await finish(browser, pg);
