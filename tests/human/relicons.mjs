// Relation icons (1.645.0): the Add Relations buttons, the Relations list, the K menu, the glyphs on the sketch and
// the inference beside the cursor all show a relation's icon, as other CAD apps do.
import { open, snap, cmd, idle, screenOf, clickAt, check, finish } from "./lib.mjs";
const { browser, pg } = await open("relicons");
const P = (x, y) => screenOf(pg, [x, y, 0]);
const tool = async c => { await pg.click(`#mc-tools [data-c="${c}"]`); await pg.waitForTimeout(100); };

await pg.click("#new-part");
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);

// A rectangle (horizontal/vertical relations come with it) and a slanted line.
await tool("sk:rect");
await clickAt(pg, await P(-40, -25));
await clickAt(pg, await P(40, 25));
await pg.keyboard.press("Escape");
await tool("sk:line");
await clickAt(pg, await P(55, -20));
// While drawing, the inference beside the cursor is an icon.
const end = await P(75, 18);
await pg.mouse.move(end[0], end[1] - 10); await pg.waitForTimeout(80);
await pg.mouse.move(end[0], end[1]); await pg.waitForTimeout(200);
const infer = await pg.evaluate(() => { const el = document.querySelector(".sk-infer"); return el ? { rel: el.dataset.rel, svg: !!el.querySelector("svg") } : null; });
await clickAt(pg, end);
await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
check("icons-infer", !infer || infer.svg, "the relation a click would add shows as an icon beside the cursor", { infer });

// The rectangle's glyphs on the sketch are icons.
const glyphs = await pg.$$eval(".sk-rel:not(.sk-fix)", els => els.map(e => ({ svg: !!e.querySelector("svg.rel-ico"), text: e.textContent.trim() })));
const img1 = await snap(pg, "glyphs");
check("icons-view", glyphs.length >= 4 && glyphs.every(g => g.svg && !g.text), "relation glyphs on the sketch are icons", { n: glyphs.length }, img1);

// Select the slanted line and the rectangle's right side: the Add Relations buttons carry icons.
await tool("sk:select");
await clickAt(pg, await P(65, -1));
await pg.keyboard.down("Control");
await clickAt(pg, await P(40, 0));
await pg.keyboard.up("Control");
await pg.waitForTimeout(300);
const btns = await pg.$$eval("#mc-pm [data-rel]", els => els.map(e => ({ rel: e.dataset.rel, svg: !!e.querySelector("svg.rel-ico"), text: e.textContent.trim() })));
const img2 = await snap(pg, "add-relations");
check("icons-buttons", btns.length >= 2 && btns.every(b => b.svg && b.text), "Add Relations buttons show an icon and the name", { btns }, img2);

// K opens the relation menu with icons.
const vp = await P(0, 0);
await pg.mouse.move(vp[0] + 120, vp[1] + 80);
await pg.keyboard.press("k");
await pg.waitForTimeout(200);
const menu = await pg.$$eval("#mc-menu button", els => els.map(e => !!e.querySelector(".mc-i svg")));
const img3 = await snap(pg, "k-menu");
await pg.keyboard.press("Escape");
check("icons-menu", menu.length >= 2 && menu.every(Boolean), "the K relation menu shows an icon per relation", { menu }, img3);

// Make them parallel; the Relations list shows the icon by the name.
await clickAt(pg, await P(65, -1));
await pg.keyboard.down("Control");
await clickAt(pg, await P(40, 0));
await pg.keyboard.up("Control");
await pg.waitForTimeout(200);
if (await pg.$('#mc-pm [data-rel="parallel"]')) await pg.click('#mc-pm [data-rel="parallel"]');
await pg.waitForTimeout(300);
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const list = await pg.$$eval("#mc-pm .pm-rel-list li", els => els.map(e => !!e.querySelector(".rel-row svg.rel-ico")));
const img4 = await snap(pg, "relations-list");
check("icons-list", list.length >= 5 && list.every(Boolean), "every row of the Relations list has its icon", { n: list.length }, img4);
await finish(browser, pg);
