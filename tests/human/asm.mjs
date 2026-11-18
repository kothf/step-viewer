// Assembly features of the gap list, by hand: Isolate and Make others transparent (A1/A2).
import { open, snap, idle, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("asm");
await makeBlock(pg, 100, 60, 20);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(1500);
await snap(pg, "asm-from-part");
for (let k = 0; k < 2; k++) {
  await pg.click('#asm-tools [data-ac="insert"]');
  await pg.waitForTimeout(300);
  await snap(pg, "insert-popup");
  const opt = pg.getByText(/^Open document:/).first();
  await opt.click();
  await pg.waitForTimeout(800);
  await snap(pg, "inserting");
  const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await clickAt(pg, [vp[0] + 150 * (k + 1), vp[1] - 100 * (k + 1)]);
  await pg.waitForTimeout(1500);
}
await snap(pg, "three-comps");
const look = () => pg.evaluate(() => { const v = window.__sv.viewer; return v.parts.map(p => (p.visible ? "v" : "h") + (p.opacity < 1 ? Math.round(p.opacity * 100) : "")).join(","); });
const bar = () => pg.evaluate(() => { const b = document.querySelector("#asm-iso"); return b && !b.hidden && b.offsetParent ? b.textContent : null; });
// Right-click the second component in the tree: Isolate.
const rows = pg.locator("#asm-tree .ft-row");
const row2 = rows.filter({ hasText: "Part1<2>" }).first();
await row2.click({ button: "right" });
await pg.waitForTimeout(250);
const menu = await pg.$$eval("#mc-menu button, .mc-menu button", els => els.map(e => e.textContent.trim()));
await snap(pg, "tree-menu");
await pg.getByText("Isolate", { exact: true }).first().click();
await pg.waitForTimeout(500);
const l1 = await look(), b1 = await bar();
const img1 = await snap(pg, "isolated");
check("A1", l1 === "h,v,h" && /Isolated: 1/.test(b1 ?? ""), "tree right-click ▸ Isolate shows only that component, with an Isolated bar", { menu, l1, b1 }, img1);
await pg.selectOption('#asm-iso select[data-iso="mode"]', "trans");
await pg.waitForTimeout(400);
const l2 = await look();
const img2 = await snap(pg, "others-transparent");
check("A2-bar", /^v\d+,v,v\d+$/.test(l2), "the bar's select switches the others to transparent", { l2 }, img2);
await pg.mouse.click(700, 800);
// Esc steps back: the first clears the selection, the next exits Isolate.
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(400);
const l3 = await look(), b3 = await bar();
check("A1-exit", l3 === "v,v,v" && !b3, "Esc (after one Esc clears the selection) exits Isolate and every component is back", { l3, b3 });
// From the view: right-click the fixed block's near corner → Make others transparent.
const at = await pg.evaluate(() => { const v = window.__sv.viewer, p = v.parts[0]; const q = v.toWorld(p, new (v.camera.position.constructor)(-45, -25, 20)).project(v.camera), r = v.renderer.domElement.getBoundingClientRect(); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; });
await clickAt(pg, at, { button: "right" });
await pg.waitForTimeout(300);
const vmenu = await pg.$$eval("#mc-menu button, .mc-menu button", els => els.filter(e => e.offsetParent).map(e => e.textContent.trim()));
await snap(pg, "view-menu");
const mt = pg.getByText("Make others transparent", { exact: true });
if (await mt.count()) await mt.first().click();
await pg.waitForTimeout(500);
const l4 = await look();
const img4 = await snap(pg, "view-transparent");
check("A2", /^v,v\d+,v\d+$/.test(l4), "view right-click ▸ Make others transparent fades the other two", { vmenu, l4 }, img4);
const ex = pg.locator('#asm-iso [data-iso="exit"]');
if (await ex.count()) await ex.click();
await pg.waitForTimeout(300);
check("A2-exit", (await look()) === "v,v,v", "Exit Isolate on the bar restores them", { l: await look() });
await finish(browser, pg);
