// Human-style test helpers: every action is a real mouse click, drag or key press on the packaged app;
// window.__sv is only read (to find where things are on screen and to check results).
import { chromium } from "playwright";
export const OUT = process.env.HT_OUT || "/mnt/project-files/gap-tests";
export const BASE = process.env.HT_URL || "http://localhost:8123";
export const results = [];
let shot = 0;
export async function open(name) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  pg.errors = [];
  pg.on("pageerror", e => pg.errors.push(e.message));
  pg.on("console", m => { if (m.type() === "error") pg.errors.push(m.text()); });
  await pg.goto(`${BASE}/index.html?debug`);
  await pg.evaluate(() => localStorage.setItem("sv:tips", "off"));
  await pg.goto(`${BASE}/index.html?debug`);
  await pg.waitForFunction(() => window.__sv);
  pg.name = name;
  return { browser, pg };
}
export async function snap(pg, label) {
  const f = `${OUT}/${pg.name}-${String(++shot).padStart(2, "0")}-${label}.png`;
  await pg.screenshot({ path: f });
  return f;
}
export function check(id, ok, what, detail, img) {
  results.push({ id, ok: !!ok, what, detail, img });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${what}${detail ? " " + JSON.stringify(detail) : ""}`);
}
export const idle = async pg => {
  await pg.waitForTimeout(200);
  await pg.waitForFunction(() => document.querySelector("#mc-busy")?.hidden !== false, null, { timeout: 120000 });
  await pg.waitForTimeout(150);
};
/** Screen point of a world point. */
export const screenOf = (pg, p) => pg.evaluate(p => {
  const v = window.__sv.viewer, q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
}, p);
export async function clickAt(pg, [x, y], opts = {}) {
  await pg.mouse.move(x - 3, y - 2); await pg.waitForTimeout(40);
  await pg.mouse.move(x, y); await pg.waitForTimeout(60);
  await pg.mouse.click(x, y, opts);
  await pg.waitForTimeout(120);
}
export async function dblAt(pg, [x, y]) {
  await pg.mouse.move(x, y); await pg.waitForTimeout(80);
  await pg.mouse.dblclick(x, y);
  await pg.waitForTimeout(150);
}
/** A command by its label on any tab or flyout of the command bar, the way a person looks for it. */
export async function cmd(pg, label) {
  for (const exact of [true, false]) {
    const pick = async sel => {
      const texts = await pg.$$eval(sel, els => els.map(e => (e.querySelector(".mc-l") ?? e).textContent.trim()));
      return exact ? texts.indexOf(label) : texts.findIndex(x => x.startsWith(label));
    };
    const sketching = await pg.evaluate(() => document.getElementById("app").classList.contains("sketching"));
    const tabs = sketching ? ["sketch"] : ["features", "surfaces", "sheetmetal", "weldments", "sketch"];
    for (const tab of tabs) {
      if (!(await pg.$(`#cm-t-${tab}`))) continue;
      await pg.click(`#cm-t-${tab}`);
      const i = await pick("#mc-tools [data-c]");
      if (i >= 0) { await pg.locator("#mc-tools [data-c]").nth(i).click(); return; }
      for (const key of await pg.$$eval("#mc-tools [data-fly]", els => els.map(e => e.dataset.fly))) {
        await pg.click(`#mc-tools [data-fly="${key}"]`);
        const j = await pick("#mc-menu button");
        if (j >= 0) { await pg.locator("#mc-menu button").nth(j).click(); return; }
        await pg.keyboard.press("Escape");
      }
    }
  }
  throw new Error(`No command labelled ${label}`);
}
export async function finish(browser, pg) {
  if (pg.errors.length) check(`${pg.name}-errors`, false, "no errors in the page", pg.errors.slice(0, 5));
  await browser.close();
}
/** A new part with a w × h rectangle on Top extruded by `depth`, all by hand. */
export async function makeBlock(pg, w = 100, h = 60, depth = 20) {
  await pg.click("#file-btn");
  await pg.click('#file-menu [data-f="new-part"]');
  await idle(pg);
  await cmd(pg, "Sketch");
  await pg.waitForTimeout(300);
  await pg.getByRole("button", { name: "Top (XY)" }).last().click();
  await pg.waitForTimeout(1200);
  await pg.click('#mc-tools [data-c="sk:rect"]');
  await clickAt(pg, await screenOf(pg, [-w / 2, -h / 2, 0]));
  await clickAt(pg, await screenOf(pg, [w / 2, h / 2, 0]));
  await pg.keyboard.press("Escape");
  await pg.click('#mc-tools [data-c="extrude"]');
  await pg.waitForTimeout(800);
  const dp = await pg.$('#mc-pm input[data-num="depth"]');
  await dp.fill(String(depth)); await dp.press("Enter");
  await idle(pg);
  if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
  await idle(pg);
}
