// Core modelling by hand, round 3: gaps against other CAD apps that the test list did not name.
// C10 curve driven pattern (FR-FT-076).
import { open, snap, cmd, idle, screenOf, clickAt, check, finish, makeBlock } from "./lib.mjs";
const { browser, pg } = await open("core3");
const P = (x, y, z = 0) => screenOf(pg, [x, y, z]);
const st = () => pg.evaluate(() => {
  const m = window.__sv.model, l = m.last(), md = m.mode();
  return { feats: m.store.doc.features.map(f => f.type + ":" + f.name), v: l?.props?.volume, bad: l?.statuses.filter(s => !s.ok).map(s => s.id + ": " + s.message), warn: l?.statuses.filter(s => s.ok && (s.message || s.warning)).map(s => s.warning ?? s.message), mode: md.kind, focus: md.focus, draft: md.draft ? structuredClone(md.draft) : null };
});
const ok = async () => { if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok"); await idle(pg); };
const blank = async () => { await pg.mouse.click(8, 450); await pg.keyboard.press("Escape"); await pg.waitForTimeout(150); };
const num = async (key, v) => {
  await idle(pg);
  for (let k = 0; k < 3; k++) {
    const e = await pg.$(`#mc-pm input[data-num="${key}"], #mc-pm input[data-int="${key}"]`);
    if (!e) return false;
    try { await e.fill(String(v)); await e.press("Tab"); await idle(pg); return true; } catch { await pg.waitForTimeout(300); }
  }
  return false;
};
const near = (a, b, tol = 1) => typeof a === "number" && Math.abs(a - b) <= tol;
let S;

// ---------- C10: curve driven pattern ----------
await makeBlock(pg, 120, 120, 10);
await blank();
const V0 = (await st()).v;
await cmd(pg, "Hole");
await pg.waitForTimeout(500);
await clickAt(pg, await P(40, 0, 10)); await idle(pg);
await clickAt(pg, await P(40, 0, 10)); await idle(pg);
if ((await st()).mode === "sketch") await ok();
await ok();
await blank();
const oneHole = V0 - (await st()).v;
const holeId = await pg.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
// The curve: a circle of radius 40 about the origin on Top.
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:circle"]');
await clickAt(pg, await P(0, 0, 0));
await clickAt(pg, await P(40, 0, 0));
await pg.keyboard.press("Escape");
await ok();
await blank();
const skId = await pg.evaluate(() => window.__sv.model.store.doc.features.at(-1).id);
await pg.locator(`#mc-tree .ft-row[data-id="${holeId}"]`).click();
await cmd(pg, "Curve driven pattern");
await pg.waitForTimeout(600);
S = await st();
const c10a = { src: S.draft?.src, path: S.draft?.path, seeds: S.draft?.features, focus: S.focus };
await pg.check('#mc-pm input[data-k="equal"]'); await idle(pg);
await num("count", 6);
S = await st();
const prev = await pg.evaluate(() => !!window.__sv.model.last()?.preview?.position?.length);
const dots = await pg.$$eval("#mc-layer .pat-spot", els => els.map(e => e.dataset.spot));
const imgC10 = await snap(pg, "curve-pattern");
// Skip the third instance by its dot.
await pg.click('#mc-layer .pat-spot[data-spot="3"]').catch(() => {});
await idle(pg);
S = await st();
const skipped = S.draft?.skip;
await ok();
S = await st();
const name = S.feats.at(-1);
check("C10", c10a.src === "curve" && c10a.path?.sketch === skId && c10a.seeds?.[0] === holeId && dots.length === 5 && JSON.stringify(skipped) === '["3"]' && near(S.v, V0 - 5 * oneHole, 3) && !S.bad.length && /CurvePattern/.test(name),
  "curve driven pattern: the hole picked first, the circle sketch offered as the curve, 6 equal round it, one skipped by its dot = 5 holes", { c10a, dots, skipped, prev, v: S.v, want: V0 - 5 * oneHole, name, bad: S.bad, warn: S.warn }, imgC10);
await blank();

// Spacing along an open part: edit to 40 mm spacing, unequal; the circle is closed, so the copies wrap round.
await pg.locator("#mc-tree .ft-row", { hasText: "CurvePattern" }).first().dblclick().catch(() => {});
await pg.waitForTimeout(500);
if ((await st()).mode !== "feature") { await pg.locator("#mc-tree .ft-row", { hasText: "CurvePattern" }).first().click({ button: "right" }); await pg.waitForTimeout(200); await pg.locator("#mc-menu button", { hasText: "Edit feature" }).first().click().catch(() => {}); await pg.waitForTimeout(500); }
await pg.uncheck('#mc-pm input[data-k="equal"]').catch(() => {}); await idle(pg);
const hasSpacing = !!(await pg.$('#mc-pm input[data-num="spacing"]'));
await num("spacing", 30);
await num("count", 3);
await pg.fill('#mc-pm input[data-k="skip"]', ""); await pg.press('#mc-pm input[data-k="skip"]', "Enter").catch(() => {}); await idle(pg);
await ok();
S = await st();
check("C10-edit", hasSpacing && near(S.v, V0 - 3 * oneHole, 3) && !S.bad.length, "edit: Equal spacing off shows Spacing; 3 instances 30 mm apart along the circle = 3 holes", { hasSpacing, v: S.v, want: V0 - 3 * oneHole, bad: S.bad });
await blank();

// Russian UI of the panel.
const latin = () => pg.evaluate(() => {
  const out = [];
  const english = s => /[A-Za-z]{3,}/.test(s.replace(/\b(Enter|Esc|Ctrl|Shift|Alt|Tab|Delete)\b/g, ""));
  const walk = el => {
    if (el.closest?.("[translate=no]")) return;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const s = n.textContent.trim(); if (english(s) && !/^(mm|deg)/.test(s)) out.push(s); }
      else if (n.nodeType === 1 && getComputedStyle(n).display !== "none") walk(n);
    }
    for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute?.(a); if (v && english(v) && !el.closest("[translate=no]")) out.push(`@${a}=${v}`); }
  };
  const pm = document.querySelector("#mc-pm"); if (pm) walk(pm);
  return [...new Set(out)];
});
await pg.click("#lang-btn");
await pg.waitForTimeout(500);
await pg.locator(`#mc-tree .ft-row[data-id="${holeId}"]`).click();
await cmd(pg, "Массив по кривой");
await pg.waitForTimeout(600);
const ru = [...await latin()];
await pg.uncheck('#mc-pm input[data-k="equal"]').catch(() => {}); await idle(pg);
ru.push(...await latin());
const imgRu = await snap(pg, "ru-curve-pattern");
check("C10-ru", !ru.length, "Russian UI: no English left in the curve driven pattern panel", { left: [...new Set(ru)] }, imgRu);
await finish(browser, pg);
