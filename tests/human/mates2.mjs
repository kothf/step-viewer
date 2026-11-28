// More assembly mates by hand (tests list /mnt/project-files/tests/mates-motion-tests.md): refusals, limits,
// the Move panel, Alt-drag mating and undo of a drag.
import { open, snap, idle, clickAt, check, finish } from "./lib.mjs";
import { plateAndPin, faceSpot, doc, CYL, TOP } from "./mates.mjs";

const { browser, pg } = await open("mates2");
const vp = await plateAndPin(pg);

// A10: two faces of one component are refused.
await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 1, CYL)); await pg.waitForTimeout(300);
await clickAt(pg, await faceSpot(pg, 1, TOP)); await pg.waitForTimeout(700);
const self = await pg.evaluate(() => ({ status: document.querySelector("#asm-pm [data-mstatus]")?.textContent, bar: !!document.getElementById("asm-matebar"), toasts: [...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ") }));
check("A10", !self.bar, "a second face on the same component does not make a mate (it replaces the pick or says why)", self, await snap(pg, "self"));
await pg.click('#asm-pm [data-a="cancel"]').catch(() => {}); await pg.waitForTimeout(400);

// D7: drag the free pin, then Ctrl+Z puts it back.
const tf0 = (await doc(pg)).comps[1].tf;
const p = await faceSpot(pg, 1, CYL);
await pg.mouse.move(p[0], p[1]); await pg.mouse.down();
for (let k = 1; k <= 10; k++) { await pg.mouse.move(p[0] + k * 10, p[1] + k * 3); await pg.waitForTimeout(30); }
await pg.mouse.up(); await pg.waitForTimeout(800);
const tf1 = (await doc(pg)).comps[1].tf;
await pg.mouse.move(vp[0], vp[1] + 200);
await pg.keyboard.press("Control+z"); await pg.waitForTimeout(800);
const tf2 = (await doc(pg)).comps[1].tf;
check("D1/D7", tf1[3] !== tf0[3] && tf2.join() === tf0.join(), "dragging the free pin moves it; Ctrl+Z puts it back", { moved: tf1[3] - tf0[3], back: tf2[3] - tf0[3] }, await snap(pg, "drag-undo"));

// D4: Move component with typed position.
await pg.locator("#asm-tree .ft-row", { hasText: "Part1<1>" }).first().click();
await pg.click('#asm-tools [data-ac="move"]'); await pg.waitForTimeout(500);
const fields = await pg.evaluate(() => [...document.querySelectorAll("#asm-pm input")].map(i => i.dataset.mp ?? i.dataset.k ?? i.name ?? i.type));
const ix = pg.locator("#asm-pm input").first();
await ix.fill("-80"); await ix.press("Enter"); await pg.waitForTimeout(800);
if (await pg.isVisible('#asm-pm [data-a="ok"]')) await pg.click('#asm-pm [data-a="ok"]');
await pg.waitForTimeout(600);
const tf3 = (await doc(pg)).comps[1].tf;
check("D4", Math.abs(tf3[3] + 80) < 1e-6, "Move component: X typed as −80 puts the pin there", { fields, x: tf3[3] }, await snap(pg, "move"));

// D6: Alt-drag the pin's side onto the hole: a concentric mate is made.
const ps = await faceSpot(pg, 1, CYL), hs = await faceSpot(pg, 0, CYL);
await pg.keyboard.down("Alt");
await pg.mouse.move(ps[0], ps[1]); await pg.mouse.down();
for (let k = 1; k <= 15; k++) { await pg.mouse.move(ps[0] + (hs[0] - ps[0]) * k / 15, ps[1] + (hs[1] - ps[1]) * k / 15); await pg.waitForTimeout(40); }
await pg.mouse.up(); await pg.keyboard.up("Alt");
await pg.waitForTimeout(1500); await idle(pg);
const d6 = await doc(pg);
check("D6", d6.mates.some(m => m.type === "concentric"), "Alt-drag of the pin's side onto the hole makes a concentric mate", d6.mates, await snap(pg, "alt-drag"));

// B1: Limit distance 5..25 between the pin top and the plate top; dragging up stops at 25.
await pg.click('#asm-tools [data-ac="mate"]'); await pg.waitForTimeout(400);
await clickAt(pg, await faceSpot(pg, 1, TOP)); await pg.waitForTimeout(300);
await clickAt(pg, await faceSpot(pg, 0, TOP)); await pg.waitForTimeout(700);
await pg.click('#asm-pm [data-mt="limitdist"]').catch(() => {}); await pg.waitForTimeout(400);
const mn = pg.locator('#asm-pm [data-lim="min"]'), mx = pg.locator('#asm-pm [data-lim="max"]');
const hasLim = await mn.count();
if (hasLim) { await mn.fill("5"); await mn.press("Tab"); await mx.fill("25"); await mx.press("Tab"); }
await pg.waitForTimeout(500);
await pg.click('#asm-pm [data-a="ok"]'); await pg.waitForTimeout(1200); await idle(pg);
await pg.click('#asm-pm [data-a="ok"]').catch(() => {}); await pg.waitForTimeout(500);
const d7 = await doc(pg);
const z0 = d7.comps[1].tf[11] + 60;
const q = await faceSpot(pg, 1, CYL);
await pg.mouse.move(q[0], q[1]); await pg.mouse.down();
for (let k = 1; k <= 20; k++) { await pg.mouse.move(q[0], q[1] - k * 15); await pg.waitForTimeout(30); }
await pg.mouse.up(); await pg.waitForTimeout(1000);
const z1 = (await doc(pg)).comps[1].tf[11] + 60;
check("B1", hasLim && d7.mates.some(m => m.type === "limitdist") && z1 - 20 <= 25 + 1e-3 && z1 - 20 >= 5 - 1e-3, "a 5–25 mm limit distance: dragging the pin up stops with its top at most 25 mm above the plate", { z0: z0 - 20, z1: z1 - 20, mates: d7.mates.map(m => m.type) }, await snap(pg, "limit"));

// C7: View mates from the component's row: the Mates folder shows only its mates; ✕ shows all again.
await pg.locator("#asm-tree .ft-row", { hasText: "Part1<1>" }).first().click({ button: "right" });
await pg.waitForTimeout(300);
await pg.locator("#asm-menu button, #asm-menu [role=menuitem]", { hasText: "View mates" }).first().click();
await pg.waitForTimeout(400);
const vm = await pg.evaluate(() => ({ head: document.querySelector('#asm-tree [data-id="folder:mates"]')?.textContent, rows: document.querySelectorAll("#asm-tree .ft-mate").length, all: window.__sv.asm.doc.mates.length }));
await pg.click('#asm-tree [data-a="vmclear"]'); await pg.waitForTimeout(300);
const vm2 = await pg.evaluate(() => document.querySelectorAll("#asm-tree .ft-mate").length);
check("C7", /Mates of/.test(vm.head ?? "") && vm.rows > 0 && vm2 === vm.all, "View mates on a component lists its mates under 'Mates of …'; ✕ shows them all again", { vm, vm2 }, await snap(pg, "view-mates"));

await finish(browser, pg);
