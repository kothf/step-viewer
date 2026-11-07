// Local vault (FRS 12.5, P2): add, check-out/check-in, history, roll back, audit trail, integrity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, unvaulted, Vault, VaultError, sha256 } from "../../src/pdm/vault";

const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null);

test("vault: versions, check-out/check-in, roll back and the audit trail (FR-PDM-001..014, 060)", async () => {
  const root = memDir("Projects");
  const v = await Vault.create(root, "Shop", "Andrey", "pc1");
  await assert.rejects(Vault.create(root, "Again", "Andrey", "pc1"), VaultError);
  const f = await v.add("parts/Bracket.mcadprt", b("v1"));
  assert.equal(f.kind, "part");
  assert.equal(s(await v.working("parts/Bracket.mcadprt")), "v1");
  await assert.rejects(v.add("Parts/bracket.mcadprt", b("x")), /already in the vault/);
  // Read-only until checked out.
  await assert.rejects(v.saveWorking(f.id, b("v2")), /Check the file out/);
  await v.checkOut(f.id);
  // Another user (or computer) sees the lock.
  const other = await Vault.open(root, "Olga", "pc2");
  await assert.rejects(other.checkOut(f.id), /Checked out by Andrey/);
  assert.deepEqual(other.info.users, ["Andrey", "Olga"]);
  await v.saveWorking(f.id, b("v2"));
  assert.equal((await v.status(await v.file(f.id))).modified, true);
  await assert.rejects(v.checkIn(f.id, "  "), /needs a comment/);
  assert.equal(await v.checkIn(f.id, "Longer arm"), 2);
  let rec = await v.file(f.id);
  assert.equal(rec.checkout, undefined);
  assert.deepEqual(rec.versions.map(x => [x.n, x.comment, x.user]), [[1, "Added", "Andrey"], [2, "Longer arm", "Andrey"]]);
  // Unchanged check-in makes no version; keep checked out keeps the lock.
  await v.checkOut(f.id);
  assert.equal(await v.checkIn(f.id, "nothing", true), null);
  assert.ok((await v.file(f.id)).checkout);
  // Undo check-out throws local edits away.
  await v.saveWorking(f.id, b("scratch"));
  await v.undoCheckOut(f.id);
  assert.equal(s(await v.working("parts/Bracket.mcadprt")), "v2");
  // Roll back adds a version with the old content.
  assert.equal(await v.rollBack(f.id, 1), 3);
  rec = await v.file(f.id);
  assert.equal(rec.versions[2].sha, rec.versions[0].sha);
  assert.equal(s(await v.working("parts/Bracket.mcadprt")), "v1");
  assert.equal(s(await v.versionBytes(f.id, 2)), "v2");
  // Identical content is stored once: v1 and v3 share an object.
  const chk = await v.verify();
  assert.deepEqual({ missing: chk.missing, corrupt: chk.corrupt, orphans: chk.orphans, objects: chk.objects }, { missing: [], corrupt: [], orphans: [], objects: 2 });
  // Audit trail, per file and whole vault.
  const log = await v.auditTrail(f.id);
  assert.deepEqual(log.map(e => e.action), ["add", "check out", "check in", "check out", "check in", "undo check out", "roll back"]);
  assert.equal((await v.auditTrail()).length, log.length + 1);
  // Files dropped in the folder can be added; the store folder is never listed.
  const sub = await root.dir("docs", true);
  await sub!.write("spec.pdf", b("%PDF"));
  assert.deepEqual(await unvaulted(v), ["docs/spec.pdf"]);
  // A damaged object shows up in the integrity check.
  const objs = await (await root.dir(".mcadvault"))!.dir("objects");
  await objs!.write(await sha256(b("v2")), b("tampered"));
  assert.deepEqual((await v.verify()).corrupt, ["parts/Bracket.mcadprt v2"]);
});

test("vault: export/import, storage report and purge (FR-PDM-007/008)", async () => {
  const v = await Vault.create(memDir("A"), "A", "Andrey", "pc1");
  const f = await v.add("Plate.mcadprt", b("one"));
  for (const x of ["two", "three", "four"]) { await v.checkOut(f.id); await v.saveWorking(f.id, b(x)); await v.checkIn(f.id, x); }
  await v.add("drawing.pdf", b("%PDF-1"));
  // Full backup into another folder.
  const all = await v.exportEntries();
  const copy = await Vault.importEntries(memDir("B"), new Map(all.map(e => [e.name, e.data])), "Olga", "pc2");
  assert.equal((await copy.files()).length, 2);
  assert.equal(s(await copy.versionBytes(f.id, 2)), "two");
  assert.equal(s(await copy.working("Plate.mcadprt")), "four");
  assert.deepEqual((await copy.verify()).missing, []);
  // Latest only: older versions arrive as purged history rows.
  const lean = await Vault.importEntries(memDir("C"), new Map((await v.exportEntries(true)).map(e => [e.name, e.data])), "Olga", "pc2");
  await assert.rejects(lean.versionBytes(f.id, 1), /purged/);
  assert.equal(s(await lean.versionBytes(f.id, 4)), "four");
  assert.deepEqual(await lean.verify().then(r => [r.missing, r.corrupt, r.orphans]), [[], [], []]);
  // Storage report and purge keeping the last 2 versions.
  const before = await v.storage();
  assert.deepEqual(before.map(r => [r.path, r.versions, r.kept, r.bytes]), [["drawing.pdf", 1, 1, 6], ["Plate.mcadprt", 4, 4, 3 + 3 + 5 + 4]]);
  assert.equal(await v.purge(2), 6);
  const after = await v.storage();
  assert.deepEqual(after.map(r => [r.kept, r.bytes]), [[1, 6], [2, 9]]);
  await assert.rejects(v.rollBack(f.id, 1), /purged/);
  assert.equal(s(await v.versionBytes(f.id, 3)), "three");
  assert.deepEqual((await v.verify()).missing, []);
  assert.ok((await v.auditTrail()).some(e => e.action === "purge"));
});
