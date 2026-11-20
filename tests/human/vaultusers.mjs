// Vault user accounts by hand (FR-PDM-037): turn log ins on, add a user, log out, log in as them with the starting
// password and pick their own, then check they cannot manage users.
import { open, snap, check, finish } from "./lib.mjs";
const { browser, pg } = await open("vaultusers");
const dlg = "#vault-dlg[open]";
const type = async (sel, text) => { await pg.click(sel); await pg.keyboard.type(text); };
const ok = () => pg.click(`${dlg} button[value="ok"]`);

// A browser vault, made from the Vault menu.
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="new-ws"]');
await pg.waitForTimeout(600);
await pg.keyboard.type(`Users${Date.now() % 100000}`);
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.querySelector("#vault-btn").classList.contains("on"));

// Vault ▸ Users…: my own Admin account first.
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="users"]');
await pg.waitForSelector(`${dlg} [name="pw2"]`);
const img0 = await snap(pg, "turn-on");
await pg.fill(`${dlg} [name="name"]`, "");
await type(`${dlg} [name="name"]`, "Andrey");
await type(`${dlg} [name="pw"]`, "andrey-pw");
await type(`${dlg} [name="pw2"]`, "andrey-pw");
await ok();
await pg.waitForSelector(`${dlg} tr[data-acc="Andrey"]`);
await type(`${dlg} [name="nu"]`, "Olga");
await type(`${dlg} [name="np"]`, "start-1");
await pg.click(`${dlg} [data-nrole="Checker"]`);
await pg.click(`${dlg} [data-add]`);
await pg.waitForSelector(`${dlg} tr[data-acc="Olga"]`);
const img1 = await snap(pg, "users");
const rows = await pg.$$eval(`${dlg} tr[data-acc]`, r => r.map(x => x.dataset.acc).join(","));
check("PDM-037a", rows === "Andrey,Olga", "Users… turns log ins on with my account and adds a user with a starting password", { rows, img0 }, img1);
await pg.click(`${dlg} button[value="cancel"]`);

// Vault ▸ Log out, then log in as Olga: a wrong password first.
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="logout"]');
await pg.waitForSelector(`${dlg} [name="pw"]`);
await pg.fill(`${dlg} [name="name"]`, "");
await type(`${dlg} [name="name"]`, "olga");
await type(`${dlg} [name="pw"]`, "wrong-pw");
await ok();
await pg.waitForSelector(`${dlg} .v-err`);
const img2 = await snap(pg, "wrong-password");
await pg.fill(`${dlg} [name="pw"]`, "");
await type(`${dlg} [name="pw"]`, "start-1");
await pg.keyboard.press("Enter");
await pg.waitForSelector(`${dlg} [name="old"]`);
const img3 = await snap(pg, "choose-password");
await type(`${dlg} [name="old"]`, "start-1");
await type(`${dlg} [name="pw"]`, "olga-pw-1");
await type(`${dlg} [name="pw2"]`, "olga-pw-1");
await ok();
await pg.waitForFunction(() => window.__sv.vault.vault?.user === "Olga");
await pg.waitForTimeout(500);
const who = await pg.evaluate(() => { const v = window.__sv.vault.vault; return { user: v.user, roles: v.rolesOf(), who: document.querySelector("#vault-panel .v-who")?.textContent }; });
const img4 = await snap(pg, "olga-in");
check("PDM-037b", who.user === "Olga" && who.roles.join() === "Designer,Checker" && who.who === "Olga", "log out, log in as the new user (wrong password refused), and their own password at the first log in", { who, img2, img3 }, img4);

// Olga sees the users but cannot change them.
await pg.click("#vault-btn");
await pg.click('#vault-menu [data-v="users"]');
await pg.waitForSelector(`${dlg} .v-users`);
const ro = await pg.evaluate(() => ({ add: !!document.querySelector("#vault-dlg [data-add]"), boxes: [...document.querySelectorAll("#vault-dlg [data-role]")].every(c => c.disabled) }));
const img5 = await snap(pg, "users-readonly");
check("PDM-037c", !ro.add && ro.boxes, "a Designer sees the user list read-only", ro, img5);
await pg.click(`${dlg} button[value="cancel"]`);
await finish(browser, pg);
