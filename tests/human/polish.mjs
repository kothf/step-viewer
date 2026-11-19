// P3 polish of the gap list, by hand: double-click a face for its sketch (M6), the Smart Dimension type cursor (S9),
// the lock on fixed points (S11), Normal to and back (S10) and feature comments (M5).
import { open, snap, idle, screenOf, clickAt, dblAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("polish");
await makeBlock(pg, 100, 60, 20);
await pg.keyboard.press("Escape");
const mode = () => pg.evaluate(() => window.__sv.model.mode().kind);
const camZ = () => pg.evaluate(() => { const v = window.__sv.viewer; return v.camera.position.clone().sub(v.controls.target).normalize().toArray().map(x => +x.toFixed(3)); });
const settle = () => pg.waitForTimeout(900);

// M6: double-click the top face: Extrude1's dimensions show; double-click again: its sketch opens.
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await settle();
const top = await screenOf(pg, [10, 5, 20]);
await dblAt(pg, top);
await pg.waitForTimeout(500);
const inst = await pg.evaluate(() => ({ id: window.__sv.model.instant, labels: document.querySelectorAll(".mc-fdim").length }));
const img1 = await snap(pg, "face-dims");
await dblAt(pg, top);
await pg.waitForTimeout(1500);
const m1 = await mode();
const img2 = await snap(pg, "sketch-open");
check("M6", inst.labels >= 1 && m1 === "sketch", "double-click a face shows its feature's dimensions; double-click again opens its sketch", { inst, m1 }, img2);
void img1;

// S9: Smart Dimension on two opposite corners: the cursor shows horizontal, vertical or aligned, and a lock once locked.
const P = (x, y) => screenOf(pg, [x, y, 0]);
const cur = () => pg.evaluate(() => window.__sv.viewer.renderer.domElement.dataset.tool ?? "");
await pg.click('#mc-tools [data-c="sk:dim"]');
await pg.waitForTimeout(150);
const c0 = await cur();
await clickAt(pg, await P(-50, -30));
await clickAt(pg, await P(50, 30));
const at = async (x, y) => { const [sx, sy] = await P(x, y); await pg.mouse.move(sx, sy, { steps: 4 }); await pg.waitForTimeout(150); return cur(); };
const h = await at(0, 48), v = await at(72, 0), a = await at(75, 55);
const img3 = await snap(pg, "dim-aligned-cursor");
await at(0, 48);
const [rx, ry] = await P(0, 48);
await pg.mouse.click(rx, ry, { button: "right" });
await pg.waitForTimeout(200);
const locked = await cur();
const lockedFar = await at(80, 10);
const img4 = await snap(pg, "dim-locked-cursor");
check("S9", c0 === "dim" && h === "dimh" && v === "dimv" && a === "dima" && locked === "dimhl" && lockedFar === "dimhl",
  "while a dimension follows the cursor, the cursor shows horizontal / vertical / aligned, and a padlock once right-click locks it", { c0, h, v, a, locked, lockedFar }, img4);
void img3;
await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
await pg.waitForTimeout(150);

// S11: select a corner, K, Fix: a lock sits on the point; the relation glyphs off, it stays.
await pg.click('#mc-tools [data-c="sk:select"]');
const corner = await P(-50, -30);
await clickAt(pg, corner);
await pg.keyboard.press("k");
await pg.waitForTimeout(250);
const fixBtn = pg.locator("#mc-menu button:visible", { hasText: /^\W*Fix\b/ });
const hadFix = await fixBtn.count();
if (hadFix) await fixBtn.first().click();
await pg.waitForTimeout(300);
await pg.mouse.click(5, 300); await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
const lock = () => pg.evaluate(() => { const el = document.querySelector(".sk-rel.sk-fix"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, svg: !!el.querySelector("svg"), shown: r.width > 0 }; });
const l1 = await lock();
const img5 = await snap(pg, "fix-lock");
const near = l1 && Math.hypot(l1.x - corner[0], l1.y - corner[1]) < 30;
await pg.evaluate(() => { const e = window.__sv.model.editor(); e.showRels = false; e.render(); });
const l2 = await lock();
await pg.evaluate(() => { const e = window.__sv.model.editor(); e.showRels = true; e.render(); });
check("S11", hadFix > 0 && !!l1?.svg && near && !!l2, "a fixed point carries a padlock right next to it, even with relation glyphs hidden", { hadFix, l1, corner, l2: !!l2 }, img5);

// S10 in the sketch: N looks from the other side, N again goes back to the view before.
await pg.mouse.move(700, 450);
const z0 = await camZ();
await pg.keyboard.press("n"); await settle();
const z1 = await camZ();
await pg.keyboard.press("n"); await settle();
const z2 = await camZ();
check("S10-sketch", z0[2] > 0.999 && z1[2] < -0.999 && z2[2] > 0.999, "in a sketch already normal to it, N flips to the back, N again comes back", { z0, z1, z2 });
await pg.click("#mc-ok");
await idle(pg);

// S10 on a face: from iso, select the top face, N → normal, N → back side, N → the iso view again.
await pg.mouse.move(700, 450);
await pg.keyboard.press("0");
await settle();
const iso = await camZ();
await clickAt(pg, await screenOf(pg, [10, 5, 20]));
await pg.mouse.move(700, 450);
await pg.keyboard.press("n"); await settle();
const n1 = await camZ();
await pg.keyboard.press("n"); await settle();
const n2 = await camZ();
await pg.keyboard.press("n"); await settle();
const n3 = await camZ();
const img6 = await snap(pg, "normal-back");
check("S10", n1[2] > 0.999 && n2[2] < -0.999 && n3.every((x, k) => Math.abs(x - iso[k]) < 1e-3), "N on a face: normal to it, again the other side, a third time back to the view before", { iso, n1, n2, n3 }, img6);
await pg.keyboard.press("Escape");

// M5: right-click Extrude1 in the tree, Add comment…, type, OK: 💬 on the row with the text as its tooltip; Ctrl+Z takes it off.
const row = pg.locator("#mc-tree .ft-row[data-i]", { hasText: "Extrude1" }).first();
await row.click({ button: "right" });
await pg.waitForTimeout(200);
await pg.locator("#mc-menu button:visible", { hasText: "Add comment…" }).click();
await pg.waitForSelector("#fcomment-dlg textarea");
await pg.keyboard.type("Plate blank, cut from 20 mm stock");
const img7 = await snap(pg, "comment-dialog");
await pg.click('#fcomment-dlg [data-a="ok"]');
await idle(pg);
const r1 = await pg.evaluate(() => { const r = [...document.querySelectorAll("#mc-tree .ft-row")].find(e => e.dataset.i && e.textContent.includes("Extrude1")); return { note: !!r?.querySelector(".ft-note"), title: r?.getAttribute("title") ?? "", doc: window.__sv.model.store.doc.features.find(f => f.name === "Extrude1")?.comment ?? null }; });
const img8 = await snap(pg, "comment-mark");
check("M5", r1.note && /20 mm stock/.test(r1.title) && r1.doc === "Plate blank, cut from 20 mm stock", "a feature comment shows as 💬 on its tree row with the text in the row's tooltip", r1, img8);
void img7;
await pg.mouse.move(700, 450);
await pg.keyboard.press("Control+z");
await idle(pg);
const r2 = await pg.evaluate(() => ({ note: !!document.querySelector("#mc-tree .ft-note"), doc: window.__sv.model.store.doc.features.find(f => f.name === "Extrude1")?.comment ?? null }));
check("M5-undo", !r2.note && r2.doc === null, "Ctrl+Z takes the comment off", r2);
await finish(browser, pg);
