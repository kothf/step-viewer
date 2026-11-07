// Vault P5 (FRS 12.5.6-12.5.7): shared vault locks and records, change orders, release packages, notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, MOVED_ON, Vault, VaultError, type LockRec } from "../../src/pdm/vault";

const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null);

test("locks: the earliest lock record wins, later ones are conflicts (FR-PDM-071)", () => {
  const r = (kind: "lock" | "free", user: string, at: string, extra: Partial<LockRec> = {}): LockRec => ({ kind, user, computer: user, at, ...extra });
  let st = Vault.lockState([r("lock", "Olga", "2026-01-01T10:00:01Z"), r("lock", "Andrey", "2026-01-01T10:00:00Z")].sort((a, x) => a.at.localeCompare(x.at)));
  assert.equal(st.holder!.user, "Andrey");
  assert.deepEqual(st.conflicts.map(c => c.user), ["Olga"]);
  st = Vault.lockState([r("lock", "Andrey", "1"), r("free", "Olga", "2"), r("free", "Andrey", "3"), r("lock", "Olga", "4")]);
  assert.equal(st.holder!.user, "Olga");
  st = Vault.lockState([r("lock", "Andrey", "1"), r("free", "Olga", "2", { broken: true })]);
  assert.equal(st.holder, null);
});

test("shared vault: locks, refused check-in, save as new, break lock, records (FR-PDM-070/071)", async () => {
  const root = memDir("Team");
  const a = await Vault.create(root, "Team", "Andrey", "pc1");
  await a.saveSettings({ shared: true, roles: { Olga: ["Designer"] } });
  const o = await Vault.open(root, "Olga", "pc2");
  const f = await a.add("Plate.mcadprt", b("v1"));
  // Olga checks out first; Andrey is refused.
  await o.checkOut(f.id);
  await assert.rejects(a.checkOut(f.id), /Checked out by Olga/);
  assert.equal((await a.file(f.id)).checkout!.user, "Olga");
  await o.saveWorking(f.id, b("olga"));
  assert.equal(await o.checkIn(f.id, "hers"), 2);
  // A lock taken at v2 cannot check in over a v3 that arrived meanwhile (simulated: a record of v3 by Andrey).
  await a.checkOut(f.id);
  const rec = await a.file(f.id);
  rec.checkout!.base = 1;
  // Write the stale base into a lock record as a synced folder could have delivered it.
  const locks = await (await root.dir(".mcadvault"))!.dir("locks");
  await locks!.write(`${f.id}~0000-early~x.json`, JSON.stringify({ kind: "lock", user: "Andrey", computer: "pc1", at: "2000-01-01T00:00:00Z", base: 1 }));
  await a.saveWorking(f.id, b("andrey"));
  const err = await a.checkIn(f.id, "mine").catch(e => e as VaultError);
  assert.ok(err instanceof VaultError && err.key === MOVED_ON);
  const nf = await a.saveAsNew(f.id, "Plate-andrey.mcadprt");
  assert.equal(s(await a.working("Plate-andrey.mcadprt")), "andrey");
  assert.equal(s(await a.working("Plate.mcadprt")), "olga");
  assert.equal((await a.file(f.id)).checkout, undefined);
  assert.equal(nf.versions.length, 1);
  // Break lock: Admin only, logged.
  await o.checkOut(f.id);
  await assert.rejects(o.breakLock(f.id), /Only an Admin/);
  assert.deepEqual((await a.staleLocks(0)).map(x => x.path), ["Plate.mcadprt"]);
  await a.breakLock(f.id, "on holiday");
  assert.equal((await o.file(f.id)).checkout, undefined);
  assert.ok((await a.auditTrail(f.id)).some(e => e.action === "break lock" && /on holiday/.test(e.details ?? "")));
  // Every record is kept as its own file; the newest wins even when the main record is older.
  const files = (await (await root.dir(".mcadvault"))!.dir("files"))!;
  const names = (await files.list()).map(e => e.name).filter(n => n.startsWith(`${f.id}@`));
  assert.ok(names.length >= 4);
  await files.write(`${f.id}.json`, JSON.stringify({ ...(await a.file(f.id)), seq: 1, versions: [] }));
  assert.equal((await a.file(f.id)).versions.length, 2);
  // Notifications: Olga sees Andrey's actions since a time, and what is addressed to her.
  const n = await o.notifications("2000-01-01");
  assert.ok(n.some(e => e.user === "Andrey" && e.action === "break lock"));
  assert.ok(!n.some(e => e.user === "Olga"));
});

test("change orders and release packages (FR-PDM-053/054)", async () => {
  const v = await Vault.create(memDir("E"), "E", "Andrey", "pc1");
  const p = await v.add("Arm.mcadprt", b("a1"));
  const q = await v.add("Pin.mcadprt", b("p1"));
  // Release both together: a release package is recorded.
  await v.transition([p.id, q.id], "Submit for review");
  await v.transition([p.id, q.id], "Approve");
  let bl = await v.baselines();
  assert.equal(bl.length, 1);
  assert.deepEqual(bl[0].files.map(x => [x.path, x.rev]), [["Arm.mcadprt", "A"], ["Pin.mcadprt", "A"]]);
  // Request → approve (files to Change pending) → edit → close (released together, revision B naming the order).
  await assert.rejects(v.requestChange(" ", "", [p.id]), /needs a title/);
  const c = await v.requestChange("Longer arm", "Clash with the cover", [p.id, q.id]);
  assert.equal(c.number, "ECO-0001");
  await v.approveChange(c.id);
  assert.deepEqual((await v.files()).map(f => f.state), ["Change pending", "Change pending"]);
  await v.checkOut(p.id);
  await v.saveWorking(p.id, b("a2"));
  await v.checkIn(p.id, "longer");
  const closed = await v.closeChange(c.id, "done");
  assert.equal(closed.state, "Closed");
  const after = await v.files();
  assert.deepEqual(after.map(f => [f.state, f.revision, v.released(f)!.eco]), [["Released", "B", "ECO-0001"], ["Released", "B", "ECO-0001"]]);
  bl = await v.baselines();
  assert.equal(bl[0].eco, "ECO-0001");
  const pkg = await v.baselineEntries(closed.baseline!);
  assert.deepEqual(pkg.map(e => e.name), ["Arm_revB.mcadprt", "Pin_revB.mcadprt", "package.csv"]);
  assert.equal(s(pkg[0].data), "a2");
  await assert.rejects(v.closeChange(c.id), /is Closed/);
  const r = await v.requestChange("Paint", "colour", [q.id]);
  await assert.rejects(v.rejectChange(r.id, ""), /Needs a comment/);
  await v.rejectChange(r.id, "not now");
  assert.equal((await v.change(r.id)).state, "Rejected");
});
