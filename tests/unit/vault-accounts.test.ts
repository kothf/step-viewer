// Vault user accounts and log in (FR-PDM-037): hashed passwords in vault.json, roles per account, read-only until logged in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, Vault } from "../../src/pdm/vault";
import { checkPassword, hashPassword } from "../../src/pdm/accounts";

const b = (s: string) => new TextEncoder().encode(s);

test("accounts: salted hashes", async () => {
  const h1 = await hashPassword("secret1"), h2 = await hashPassword("secret1");
  assert.notEqual(h1.hash, h2.hash);
  assert.equal(await checkPassword(h1, "secret1"), true);
  assert.equal(await checkPassword(h1, "secret2"), false);
});

test("vault: users, log in, roles and log out (FR-PDM-037)", async () => {
  const root = memDir("Projects");
  const v = await Vault.create(root, "Shop", "Andrey", "pc1");
  const f = await v.add("Bracket.mcadprt", b("v1"));
  assert.equal(v.secured, false);
  await assert.rejects(v.addUser("Olga", "olga-pw", ["Designer"]), /first account is yours/);
  await assert.rejects(v.addUser("Andrey", "123", ["Admin"]), /at least 6/);
  await v.addUser("andrey", "andrey-pw", ["Admin", "Designer"]);
  assert.equal(v.secured, true);
  assert.equal(v.user, "andrey");
  await v.addUser("Olga", "olga-pw", ["Designer"]);
  await assert.rejects(v.addUser("OLGA ", "x-123456", ["Designer"]), /already a user/);
  assert.ok(!JSON.stringify(v.accounts()).includes("hash"));
  assert.ok(!new TextDecoder().decode((await (await root.dir(".mcadvault"))!.read("vault.json"))!).includes("olga-pw"));

  // Opening it again asks for a log in: read-only until then.
  const o = await Vault.open(root, "whoever", "pc2");
  assert.equal(o.locked, true);
  assert.equal(o.user, "");
  assert.equal((await o.files()).length, 1);
  await assert.rejects(o.checkOut(f.id), /Log in/);
  await assert.rejects(o.login("Olga", "wrong!"), /Wrong user name or password/);
  await assert.rejects(o.login("Nobody", "olga-pw"), /Wrong user name or password/);
  await o.login("olga", "olga-pw");
  assert.equal(o.user, "Olga");
  assert.equal(o.mustChange, true);
  assert.deepEqual(o.rolesOf(), ["Designer"]);
  assert.equal(o.has("Admin"), false);
  await assert.rejects(o.addUser("Ivan", "ivan-pw", ["Designer"]), /Only an Admin/);
  await assert.rejects(o.changePassword("bad", "new-olga"), /current password is wrong/);
  await o.changePassword("olga-pw", "new-olga");
  assert.equal(o.mustChange, false);
  await o.checkOut(f.id);
  assert.equal((await o.file(f.id)).checkout?.user, "Olga");
  await o.logout();
  assert.equal(o.locked, true);
  await assert.rejects(o.undoCheckOut(f.id), /Log in|Checked out/);
  await o.login("Olga", "new-olga");
  await o.undoCheckOut(f.id);

  // Admin: reset, roles, disable, remove; the last Admin stays.
  await v.resetPassword("Olga", "temp-123");
  await assert.rejects(o.login("Olga", "new-olga"), /Wrong/);
  await v.setAccount("Olga", { roles: ["Designer", "Checker"] });
  await v.setAccount("Olga", { disabled: true });
  await assert.rejects(o.login("Olga", "temp-123"), /Wrong/);
  await assert.rejects(v.setAccount("andrey", { disabled: true }), /at least one Admin/);
  await assert.rejects(v.setAccount("andrey", { roles: ["Designer"] }), /at least one Admin/);
  await assert.rejects(v.removeUser("Andrey"), /your own account/);
  await v.removeUser("Olga");
  assert.deepEqual(v.accounts().map(a => a.name), ["andrey"]);
  const actions = (await v.auditTrail()).map(e => e.action);
  for (const a of ["add user", "log in", "change password", "log out", "reset password", "set roles", "disable user", "remove user"]) assert.ok(actions.includes(a), a);
});
