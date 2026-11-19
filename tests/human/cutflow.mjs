// Cut with no sketch left to use, by hand: it starts a sketch (on the picked face) and goes on to the cut when the
// sketch is closed; a cut that would take the whole body away says so instead of restarting the kernel.
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf } from "./lib.mjs";
const { browser, pg } = await open("cutflow");
await makeBlock(pg, 100, 60, 20);
const vol = () => pg.evaluate(() => window.__sv.modeller.last?.props?.volume ?? null);
const v0 = await vol();
// Pick the top face, then Cut.
await clickAt(pg, await screenOf(pg, [20, 10, 20]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(1500);
const sketching = await pg.evaluate(() => document.getElementById("app").classList.contains("sketching"));
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await clickAt(pg, await screenOf(pg, [10, 0, 20]));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.click("#mc-ok");
await pg.waitForTimeout(1500);
const draft = await pg.evaluate(() => { const m = window.__sv.modeller.mode; return m.kind === "feature" ? { type: m.draft.type, op: m.draft.op } : m.kind; });
const img1 = await snap(pg, "cut-panel");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
const v1 = await vol();
check("C1", sketching && draft?.op === "cut" && v1 < v0 - 1000, "Cut with a face picked and every sketch used: sketch on the face, close it, the cut panel opens with it", { sketching, draft, v0, v1 }, img1);
// Cut through all on the first sketch, reversed into the body: an error, not a kernel restart.
await pg.keyboard.press("Escape");
await pg.locator("#mc-tree .ft-row", { hasText: "Sketch1" }).first().click();
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(800);
const flipped = await pg.evaluate(() => window.__sv.modeller.mode.draft?.flip);
if (!flipped) await pg.click('#mc-pm [data-k="flip"]').catch(() => {});
await idle(pg);
const msg = await pg.evaluate(() => document.querySelector("#mc-pm")?.textContent ?? "");
const img2 = await snap(pg, "cut-all");
check("C2", /removes the whole body/.test(msg) && !/kernel stopped/.test(msg), "a cut that would take the whole body away says so", { msg: msg.slice(0, 160) }, img2);
await finish(browser, pg);
