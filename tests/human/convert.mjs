// Convert Entities of a curved edge, by hand: a round hole's rim converted into a sketch on a sloping chamfer face
// becomes a closed spline on its ellipse, which stays on its edge after the rebuild.
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf, cmd } from "./lib.mjs";
const { browser, pg } = await open("convert");
await makeBlock(pg, 100, 60, 20);
// A Ø20 hole from the top face, at (0, 10).
await clickAt(pg, await screenOf(pg, [20, 10, 20]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="cut"]');
await pg.waitForTimeout(1500);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await screenOf(pg, [0, 10, 20]));
await clickAt(pg, await screenOf(pg, [10, 10, 20]));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
await pg.click("#mc-ok");
await pg.waitForTimeout(1500);
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
// Chamfer the top front edge (y = -30) by 15 mm: a face sloping at 45°, facing the camera.
await pg.keyboard.press("Escape");
await clickAt(pg, await screenOf(pg, [0, -30, 20]));
await pg.click("#cm-t-features");
await pg.click('#mc-tools [data-c="chamfer"]');
await pg.waitForTimeout(800);
const dist = await pg.$('#mc-pm input[data-num="distance"]');
await dist.fill("15"); await dist.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
// Sketch on the chamfer face, then Convert Entities on the hole's top rim.
await pg.keyboard.press("Escape");
await cmd(pg, "Sketch");
await pg.waitForTimeout(500);
await clickAt(pg, await screenOf(pg, [0, -22.5, 12.5]));
await pg.waitForTimeout(1500);
const sketching = await pg.evaluate(() => document.getElementById("app").classList.contains("sketching"));
await cmd(pg, "Convert");
await pg.waitForTimeout(300);
await clickAt(pg, await screenOf(pg, [0, 0, 20]));
await pg.waitForTimeout(500);
const ents = () => pg.evaluate(() => window.__sv.modeller.mode.editor?.sk.ents.filter(e => e.t !== "point").map(e => e.t + (e.closed ? "/closed" : "")) ?? null);
const after = await ents();
const img1 = await snap(pg, "converted-ellipse");
check("V1", sketching && after?.includes("spline/closed"), "a round edge converted into a sketch on a sloping face becomes a closed spline (its ellipse)", { sketching, after }, img1);
// Close the sketch: it keeps the spline, with its On edge relation intact after the rebuild.
await pg.click("#mc-ok");
await idle(pg);
const kept = await pg.evaluate(() => { const d = window.__sv.model.store.doc; const sk = d.features.at(-1); return { type: sk.type, ents: sk.ents.filter(e => e.t === "spline").length, ext: sk.rels.filter(r => r.ext && !r.dangling).length, dangling: sk.rels.filter(r => r.dangling).length }; });
const img2 = await snap(pg, "closed");
check("V2", kept.type === "sketch" && kept.ents === 1 && kept.ext === 1 && kept.dangling === 0, "the closed sketch keeps the converted spline on its edge after the rebuild", kept, img2);
await finish(browser, pg);
