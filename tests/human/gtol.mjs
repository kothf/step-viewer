// Geometric tolerance frames attached under a hole callout and a note (Andrey, 2026-11-19: a flatness frame under
// "5× Ø5 THRU" stayed free), by hand: a disc with a round hole, a drawing, a hole callout, then the Geometric tolerance
// tool clicked on the callout's text; dragging the callout takes the frame along. A free frame dragged onto a note
// attaches to it too.
import { open, snap, check, finish, idle, cmd, clickAt, screenOf } from "./lib.mjs";
const { browser, pg } = await open("gtol");
// A Ø80 × 10 disc with a Ø20 hole through it, sketched as two circles on Top.
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="new-part"]');
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:circle"]');
for (const r of [40, 10]) {
  await clickAt(pg, await screenOf(pg, [0, 0, 0]));
  await clickAt(pg, await screenOf(pg, [r, 0, 0]));
}
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
const dpt = await pg.$('#mc-pm input[data-num="depth"]');
await dpt.fill("10"); await dpt.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
await pg.click("#new-more");
await pg.click("#new-drawing");
await pg.waitForFunction(() => window.__sv.drw.loaded(), null, { timeout: 120000 });
const cmdA = async a => {
  const tab = await pg.evaluate(a => document.querySelector(`#drw .drw-cmds [data-a="${a}"]`)?.closest("[data-cpane]")?.dataset.cpane ?? null, a);
  if (tab) await pg.click(`#drw [data-ctab="${tab}"]`);
  await pg.click(`#drw .drw-cmds [data-a="${a}"]`);
};
const tool = async k => {
  await pg.click('#drw [data-ctab="annot"]');
  const menu = await pg.evaluate(k => { const b = document.querySelector(`#drw .drw-cmds [data-an="${k}"]`); return b?.closest(".drw-menu") ? b.closest(".drw-dd").querySelector("button").dataset.a : null; }, k);
  if (menu) await pg.click(`#drw .drw-cmds [data-a="${menu}"]`);
  await pg.click(`#drw .drw-cmds [data-an="${k}"]`);
};
await cmdA("std3");
await pg.waitForFunction(() => window.__sv.drw.ready(), null, { timeout: 120000 });
await pg.waitForTimeout(800);
// The view that looks down on the disc (its circles are round there).
const pl = await pg.evaluate(() => {
  const vs = window.__sv.drw.doc().sheets[0].views, v = vs.find(x => x.orient === "top") ?? vs[1], p = window.__sv.drw.placement(v.id);
  return { id: v.id, x: p.x, y: p.y, s: p.s };
});
const sp = (x, y) => pg.evaluate(([x, y]) => window.__sv.drw.sheetPt(x, y), [x, y]);
const annots = () => pg.evaluate(() => (window.__sv.drw.doc().sheets[0].annots ?? []).map(a => JSON.parse(JSON.stringify(a))));
const box = id => pg.evaluate(id => window.__sv.drw.hit(id), id);
const centre = async id => { const b = await box(id); return b && sp((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
const drag = async (from, to) => {
  await pg.mouse.move(...from); await pg.mouse.down();
  await pg.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2); await pg.mouse.move(...to); await pg.mouse.up();
  await pg.waitForTimeout(400);
};
const okDlg = async () => {
  await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 10000 });
  await pg.click("dialog.ad-dlg[open] button[value=ok]");
  await pg.waitForTimeout(400);
};
// Hole callout on the hole's rim (10 mm right of the centre), placed up and to the right.
const r = 10 * pl.s;
await tool("hole");
await clickAt(pg, await sp(pl.x + r * Math.SQRT1_2, pl.y + r * Math.SQRT1_2));
await clickAt(pg, await sp(pl.x + r + 25, pl.y + r + 25));
await pg.keyboard.press("Escape");
await pg.waitForTimeout(500);
const ho = (await annots()).find(a => a.t === "hole");
if (!ho) { check("G1", false, "a hole callout to start from", { ann: await annots() }, await snap(pg, "no-callout")); await finish(browser, pg); process.exit(0); }
await snap(pg, "hole-callout");
// Geometric tolerance tool, click the callout's text: the dialog opens, OK puts the frame under the text.
await pg.waitForTimeout(600);
await tool("gtol");
await clickAt(pg, await centre(ho.id));
await okDlg();
const g = (await annots()).find(a => a.t === "gtol" && a.dim === ho.id);
const under = async (h, f) => { const a = await box(h), b = await box(f); return a && b ? { left: +(b[0] - a[0]).toFixed(2), gap: +(a[1] - b[3]).toFixed(2), top: +a[1].toFixed(1) } : null; };
const u0 = g && await under(ho.id, g.id);
const img1 = await snap(pg, "frame-under-callout");
check("G1", !!g && Math.abs(u0.left) < 0.05 && u0.gap > 0.5 && u0.gap < 3, "Geometric tolerance clicked on a hole callout: the frame sits under the callout, lined up with its text", { g: !!g, u0 }, img1);
// Drag the callout: the frame goes along.
await pg.waitForTimeout(600);
const c0 = await centre(ho.id);
await drag(c0, [c0[0] + 60, c0[1] - 40]);
const u1 = g && await under(ho.id, g.id);
const img2 = await snap(pg, "callout-dragged");
check("G2", !!u1 && Math.abs(u1.left) < 0.05 && u1.gap > 0.5 && u1.gap < 3 && u1.top !== u0.top, "dragging the hole callout takes the frame along", { u0, u1 }, img2);
// The frame's panel says where it is attached and offers Detach.
await pg.waitForTimeout(600);
await clickAt(pg, await centre(g.id));
await pg.waitForTimeout(300);
const panel = await pg.evaluate(() => document.querySelector("#drw .drw-props")?.textContent ?? "");
check("G3", /hole callout/.test(panel) && !!(await pg.$('#drw .drw-props [data-a="gdetach"]')), "the frame's panel says it is attached under the hole callout, with Detach", { panel: panel.slice(0, 160) });
await pg.keyboard.press("Escape");
// A note on the sheet, then a free frame dragged onto it.
await tool("note");
await clickAt(pg, await sp(pl.x - 60, pl.y - 50));
await pg.waitForTimeout(400);
const nt = await pg.$("#drw [data-d=ntxt]");
if (nt) { await nt.fill("FLAT FACES"); await nt.press("Tab"); }
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
const no = (await annots()).find(a => a.t === "note");
await tool("gtol");
await clickAt(pg, await sp(pl.x + 80, pl.y - 70));
await okDlg();
const free = (await annots()).filter(a => a.t === "gtol" && !a.dim && !a.leader).at(-1);
if (free && no) { await pg.waitForTimeout(600); await drag(await centre(free.id), await centre(no.id)); }
const gn = free && (await annots()).find(a => a.id === free.id);
const un = gn?.dim && await under(no.id, gn.id);
const img3 = await snap(pg, "frame-on-note");
check("G4", !!no && gn?.dim === no.id && un && un.gap > 0.5 && un.gap < 3, "a free frame dragged onto a note attaches under it", { note: !!no, dim: gn?.dim, un }, img3);
await finish(browser, pg);
