// Custom keyboard shortcuts (gap list U1), by hand: Settings ▸ Keyboard, then the keys in a part.
import { open, snap, check, finish, makeBlock, idle } from "./lib.mjs";
const { browser, pg } = await open("keys");
await makeBlock(pg, 100, 60, 20);
await pg.keyboard.press("Escape");
await pg.click("#settings-btn");
await pg.waitForTimeout(300);
await pg.click("#pt-keys");
await pg.waitForTimeout(200);
const box = name => pg.getByLabel(`Shortcut for ${name}`, { exact: true });
// Ctrl+S is kept for the app; Ctrl+Shift+F goes to Fillet, then to Chamfer, which takes it from Fillet.
await box("Fillet").click();
await pg.keyboard.press("Control+s");
const kept = await box("Fillet").inputValue();
const msg1 = await pg.evaluate(() => document.querySelector("#prefs-dlg .set-none")?.textContent ?? "");
await pg.keyboard.press("Control+Shift+F");
const f1 = await box("Fillet").inputValue();
await box("Chamfer").click();
await pg.keyboard.press("Control+Shift+F");
const c1 = await box("Chamfer").inputValue(), f2 = await box("Fillet").inputValue();
const img1 = await snap(pg, "keyboard-page");
check("U1-set", kept === "" && /kept for the app/.test(msg1) && f1 === "Ctrl+Shift+F" && c1 === "Ctrl+Shift+F" && f2 === "", "Settings ▸ Keyboard: Ctrl+S is refused, a combination moves to the last command given it", { kept, msg1, f1, c1, f2 }, img1);
// Fillet gets Alt+F; OK stores both.
await box("Fillet").click();
await pg.keyboard.press("Alt+f");
await pg.click('#prefs-dlg [data-a="ok"]');
await pg.waitForTimeout(300);
const stored = await pg.evaluate(() => localStorage.getItem("mc:shortcuts"));
// In the part: Alt+F starts Fillet, Esc, Ctrl+Shift+F starts Chamfer.
await pg.mouse.move(700, 450);
await pg.keyboard.press("Alt+f");
await pg.waitForTimeout(600);
const m1 = await pg.evaluate(() => window.__sv.model.mode().draft?.type ?? window.__sv.model.mode().kind);
const img2 = await snap(pg, "alt-f-fillet");
await pg.keyboard.press("Escape");
await idle(pg);
await pg.keyboard.press("Control+Shift+F");
await pg.waitForTimeout(600);
const m2 = await pg.evaluate(() => window.__sv.model.mode().draft?.type ?? window.__sv.model.mode().kind);
await pg.keyboard.press("Escape");
await idle(pg);
check("U1-run", m1 === "fillet" && m2 === "chamfer", "in the part, Alt+F starts Fillet and Ctrl+Shift+F starts Chamfer", { stored, m1, m2 }, img2);
await finish(browser, pg);
