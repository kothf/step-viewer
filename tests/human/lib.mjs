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
/** Opens files with File ▸ Open, as a person does (the file chooser gets the paths). */
export async function openFiles(pg, paths) {
  await pg.click("#file-btn");
  const [fc] = await Promise.all([pg.waitForEvent("filechooser"), pg.click('#file-menu [data-f="open"]')]);
  await fc.setFiles(paths);
  await idle(pg);
  await pg.waitForTimeout(800);
  await idle(pg);
}
/** Saves the live document with Ctrl+S into `dir` (a first save asks for the name) and returns the file's path. */
export async function saveModel(pg, dir, name) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  // headless Chromium has no native save dialog: the app then asks for the name itself and downloads the file
  await pg.evaluate(() => { window.showSaveFilePicker = undefined; });
  const dl = pg.waitForEvent("download", { timeout: 60000 });
  await pg.keyboard.press("Control+s");
  await pg.waitForTimeout(500);
  if (await pg.isVisible("#name-dlg[open]")) {
    if (name) await pg.fill("#name-dlg-in", name);
    await pg.keyboard.press("Enter");
  }
  const d = await dl;
  const path = `${dir}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  return path;
}
/** The direction from the model to the eye. */
export const eyeDir = pg => pg.evaluate(() => {
  const c = window.__sv.viewer.camera, d = c.getWorldDirection(new (c.position.constructor)());
  return [-d.x, -d.y, -d.z];
});
/**
 * A point the eye sees on the wall of a round hole: centre `c`, unit `axis`, radius `r`, the wall running
 * from `a0` to `a1` along the axis (measured from `c`). The point is a little inside the end nearer the eye,
 * on the side of the wall away from the eye.
 */
export async function boreSpot(pg, c, axis, r, a0, a1, depth = 0.3, turn = 0) {
  const d = await eyeDir(pg);
  const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
  const s = along >= 0 ? 1 : -1;
  const across = d.map((v, k) => v - along * axis[k]);
  const n = Math.hypot(...across) || 1;
  const t = (s > 0 ? a1 : a0) - s * depth * (a1 - a0);
  // `turn` (radians) moves the point round the wall, clear of a shaft standing in the hole
  const u = across.map(v => v / n), w = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  return c.map((v, k) => v + axis[k] * t - r * (Math.cos(turn) * u[k] + Math.sin(turn) * w[k]));
}
