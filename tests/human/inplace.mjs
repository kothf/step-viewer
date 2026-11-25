// Insert part in place (FR-ASM-031), by hand: New part in an assembly, its first sketch on a face of another
// component, extruded, Return to assembly adds it fixed in place; an empty new part is not added.
import { open, snap, idle, clickAt, check, finish, makeBlock, screenOf } from "./lib.mjs";
const { browser, pg } = await open("inplace");
await makeBlock(pg, 100, 60, 20);
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"));
await pg.waitForTimeout(2000);
await idle(pg);
const asm = () => pg.evaluate(() => { const d = window.__sv.asm.doc; return { comps: d.components.map(c => ({ name: c.name, fixed: !!c.fixed, part: c.part })), parts: Object.values(d.parts).map(p => ({ name: p.name, file: p.file, feats: p.doc.features.map(f => f.type) })) }; });

// 1. New part: the panel names it Part2 (Part1 is the block) and refuses a name in use.
await pg.click('#asm-tools [data-ac="newpart"]');
await pg.waitForTimeout(400);
const name0 = await pg.inputValue('#asm-pm [data-pn]');
await pg.fill('#asm-pm [data-pn]', "part1");
await pg.keyboard.press("Enter");
await pg.waitForTimeout(300);
const err = await pg.evaluate(() => { const e = document.getElementById("asm-pn-err"); return e && !e.hidden ? e.textContent : ""; });
const img1 = await snap(pg, "name-in-use");
check("IP-1", name0 === "Part2" && /already called/.test(err) && (await asm()).comps.length === 1,
  "New part opens its panel named Part2; a name in use is refused in place and nothing is added", { name0, err }, img1);
await pg.fill('#asm-pm [data-pn]', "Cover");

// 2. The top face lights up under the pointer; a click opens the part in context with a sketch on that face.
const top = await screenOf(pg, [10, 5, 20]);
await pg.mouse.move(top[0] - 4, top[1] - 3); await pg.mouse.move(top[0], top[1]);
await pg.waitForTimeout(300);
const lit = await pg.evaluate(() => { let n = 0; window.__sv.viewer.scene.traverse(o => { if (o.userData.placeHover) n++; }); return n; });
const imgH = await snap(pg, "face-lit");
check("IP-hover", lit === 1, "while placing, the flat face under the pointer is lit", { lit }, imgH);
await clickAt(pg, top);
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("sketching"), null, { timeout: 30000 });
await pg.waitForTimeout(1500);
const st2 = await pg.evaluate(() => ({ ret: !!document.getElementById("mc-ret"), retText: document.getElementById("mc-ret")?.textContent ?? "", plane: window.__sv.model?.store?.doc?.features?.[0]?.plane ?? null }));
const img2 = await snap(pg, "sketch-on-face");
check("IP-2", st2.ret && st2.plane && "ctx" in st2.plane && Math.abs(st2.plane.ctx.p[2] - 20) < 1e-6 && st2.plane.ctx.n[2] > 0.99,
  "a click on the block's top face opens the new part in the assembly's context with its first sketch on that face", st2, img2);

// 3. Draw a rectangle on it, extrude 10, Return to assembly.
await pg.click('#mc-tools [data-c="sk:rect"]');
await clickAt(pg, await screenOf(pg, [-30, -20, 20]));
await clickAt(pg, await screenOf(pg, [30, 20, 20]));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
const dp = await pg.$('#mc-pm input[data-num="depth"]');
await dp.fill("10"); await dp.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
const box = await pg.evaluate(() => { const d = window.__sv.viewer.parts[0]?.data; return d ? [d.bboxMin, d.bboxMax].map(v => [...v].map(x => Math.round(x * 1000) / 1000)) : null; });
const img3 = await snap(pg, "extruded-in-context");
await pg.click('#mc-ret [data-a="ret"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 30000 });
await pg.waitForTimeout(2000);
await idle(pg);
const a3 = await asm();
const placed = await pg.evaluate(() => { const v = window.__sv.viewer; return v.parts.map(p => { p.group.updateMatrixWorld(true); const b = new (v.camera.position.constructor)(); return [p.data.bboxMin[2], p.data.bboxMax[2]]; }); });
const img4 = await snap(pg, "added-in-place");
check("IP-3", box && box[0][2] === 20 && box[1][2] === 30 && a3.comps.length === 2 && a3.comps[1].name === "Cover<1>" && a3.comps[1].fixed && a3.parts.some(p => p.file === "Cover.mcadprt" && p.feats.includes("extrude")),
  "a rectangle extruded 10 mm stands on the face (z 20..30); Return to assembly adds Cover<1>, fixed, its part filed as Cover.mcadprt", { box, a3, placed }, img4);

// 4. Undo takes it out again in one step.
await pg.click('#asm-quick [data-ac="undo"]');
await pg.waitForTimeout(800);
const a4 = await asm();
check("IP-4", a4.comps.length === 1, "one Undo removes the new part", { n: a4.comps.length });
await pg.click('#asm-quick [data-ac="redo"]');
await pg.waitForTimeout(800);

// 5. New part, ✓ (at the origin), straight back: nothing is added.
await pg.click('#asm-tools [data-ac="newpart"]');
await pg.waitForTimeout(400);
await pg.click('#asm-pm [data-a="origin"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("model"), null, { timeout: 30000 });
await pg.waitForTimeout(1200);
await pg.click('#mc-ret [data-a="ret"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 30000 });
await pg.waitForTimeout(1200);
const a5 = await asm();
const toastText = await pg.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
const img5 = await snap(pg, "empty-not-added");
check("IP-5", a5.comps.length === 2 && /not added/.test(toastText), "a new part left empty is not added, and a toast says so", { n: a5.comps.length, toastText }, img5);

check("IP-errors", !pg.errors.length, "no page errors", pg.errors.slice(0, 5));
await finish(browser, pg);
