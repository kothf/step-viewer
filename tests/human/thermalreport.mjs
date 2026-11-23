// The report of a board thermal map (FRS-thermal FR-TREP-001): a board's STEP with its package, a probe, then
// Report as a web page and as a PDF: where the values come from, the pictures from above and below, the parts.
import { readFileSync, mkdirSync } from "node:fs";
import { open, snap, idle, check, finish, openFiles, OUT } from "./lib.mjs";
const near = (a, b) => [...a.t, ...a.p, a.h].every((v, i) => Math.abs(v - [...b.t, ...b.p, b.h][i]) < 1e-3 * (1 + Math.abs(v)));
const FX = "tests/fixtures/thermal";
const out = `${OUT}/thermalreport`;
mkdirSync(out, { recursive: true });
const { browser, pg } = await open("thermalreport");
await openFiles(pg, [`${FX}/amp.step`, `${FX}/amp-thermal.zip`]);
await pg.waitForFunction(() => window.__sv.thermal.state()?.drawn, null, { timeout: 60000 });
await idle(pg);
await pg.waitForTimeout(900);
const view0 = await pg.evaluate(() => window.__sv.viewer.getView());

// TR-1: a probe on the board, then Report ▸ Web page.
await pg.click('#th-tools [data-th="probe"]');
const p = await pg.evaluate(() => { const q = window.__sv.thermal.screenOf([20, 20, 1.6]); return [q.x, q.y]; });
await pg.mouse.click(p[0], p[1]);
await pg.waitForTimeout(300);
await pg.click('#th-tools [data-th="probe"]');
await pg.click('#th-tools [data-th="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const ask = await snap(pg, "ask");
const [hd] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
await hd.saveAs(`${out}/report.html`);
const html = readFileSync(`${out}/report.html`, "utf8");
const st1 = await pg.evaluate(() => ({ report: window.__sv.thermal.state().report, view: window.__sv.viewer.getView() }));
check("TR-1", /amp.*-thermal-report\.html$/.test(hd.suggestedFilename()) && (html.match(/<img /g) ?? []).length === 3 && /did not compute them/.test(html) && /Tube Amp CAD/.test(html) && ["V3", "R14", "Q2", "C12", "R20", "C13"].every(n => html.includes(n)) && /Probes/.test(html) && /±15/.test(html) && near(st1.view, view0),
  "Report as a web page holds where the temperatures come from, the view as shown and from above and below, every part, the probe and the accuracy; the view stays as it was", { name: hd.suggestedFilename(), bytes: html.length, ...st1, view0 }, ask);

// TR-2: the same as a PDF.
await pg.click('#th-tools [data-th="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [pd] = await Promise.all([pg.waitForEvent("download", { timeout: 60000 }), pg.click('dialog.choose-dlg [data-choose="pdf"]')]);
await pd.saveAs(`${out}/report.pdf`);
const pdf = readFileSync(`${out}/report.pdf`);
check("TR-2", /\.pdf$/.test(pd.suggestedFilename()) && pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 50000,
  "Report as a PDF is written with the same content", { name: pd.suggestedFilename(), bytes: pdf.length }, await snap(pg, "after-pdf"));

// TR-3: in Russian the report's own texts are Russian.
await pg.click("#lang-btn");
await pg.waitForTimeout(300);
await pg.click('#th-tools [data-th="report"]');
await pg.waitForSelector("dialog.choose-dlg[open]");
const [rd] = await Promise.all([pg.waitForEvent("download"), pg.click('dialog.choose-dlg [data-choose="html"]')]);
await rd.saveAs(`${out}/report-ru.html`);
const ru = readFileSync(`${out}/report-ru.html`, "utf8");
check("TR-3", /Тепловая карта/.test(ru) && /Сверху/.test(ru) && /не рассчитывал/.test(ru), "in Russian the report's headings and statements are Russian", { bytes: ru.length }, await snap(pg, "ru"));
await finish(browser, pg);
