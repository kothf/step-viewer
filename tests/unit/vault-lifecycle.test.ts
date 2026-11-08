// Vault P4 (FRS 12.5.3-12.5.6): references, where-used, rename/move, delete, copy tree, revisions and lifecycle,
// data cards, numbering, search, version compare and BOMs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMsg, memDir, Vault } from "../../src/pdm/vault";
import { zip } from "../../src/model/zip";
import { docRefs, readProps, relPath, resolveRel } from "../../src/pdm/codec";
import { formatNumber, revLabel, preLabel, defaultWorkflow } from "../../src/pdm/workflow";

const enc = new TextEncoder();
/** A MöbiusCAD document: manifest with references, document with properties and features. */
const doc = (kind: string, refs: { path: string; qty?: number }[] = [], props: Record<string, unknown> = {}, features: unknown[] = []) =>
  zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind, references: refs }) }, { name: "document.json", data: JSON.stringify({ kind, props, features }) }]);

test("workflow: revision schemes and numbering (FR-PDM-030/041)", () => {
  assert.deepEqual([0, 1, 7, 8, 25].map(n => revLabel({ kind: "letters" }, n)), ["A", "B", "H", "I", "Z"]);
  // ASME Y14.35 skip: no I, O, Q, S, X, Z; then two letters.
  const skip = Array.from({ length: 22 }, (_, n) => revLabel({ kind: "letters", skip: true }, n));
  assert.equal(skip.join(""), "ABCDEFGHJKLMNPRTUVWYAAAB");
  assert.deepEqual([0, 9].map(n => revLabel({ kind: "numbers" }, n)), ["01", "10"]);
  assert.deepEqual([0, 3].map(n => revLabel({ kind: "eskd" }, n)), ["О", "А"]);
  assert.deepEqual([0, 1].map(n => preLabel({ kind: "letters", pre: "x" }, n)), ["X1", "X2"]);
  assert.equal(formatNumber("MC-{YYYY}-{0000}", 7, {}, new Date(2026, 0, 1)), "MC-2026-0007");
  assert.equal(formatNumber("{Project}-{000}", 12, { Project: "Drone arm" }), "DRONE-ARM-012");
  assert.equal(defaultWorkflow().transitions.length, 6);
  assert.equal(resolveRel("asm/top.mcadasm", "../parts/a.mcadprt"), "parts/a.mcadprt");
  assert.equal(relPath("asm/top.mcadasm", "parts/a.mcadprt"), "../parts/a.mcadprt");
  assert.equal(relPath("a.mcadasm", "b.mcadprt"), "b.mcadprt");
});

test("vault: references, where-used, BOM, rename/move and delete (FR-PDM-020..025, 052)", async () => {
  const v = await Vault.create(memDir("R"), "R", "Andrey", "pc1");
  const bolt = await v.add("parts/Bolt.mcadprt", await doc("part"));
  const plate = await v.add("parts/Plate.mcadprt", await doc("part"));
  const sub = await v.add("asm/Sub.mcadasm", await doc("assembly", [{ path: "../parts/Bolt.mcadprt", qty: 4 }, { path: "../parts/Plate.mcadprt" }]));
  const top = await v.add("asm/Top.mcadasm", await doc("assembly", [{ path: "Sub.mcadasm", qty: 2 }, { path: "../parts/Bolt.mcadprt", qty: 1 }]));
  assert.deepEqual(v.latest(top).refs!.map(r => [r.id, r.version, r.qty]), [[sub.id, 1, 2], [bolt.id, 1, 1]]);
  // Contains with quantities, and where-used up to the top.
  const tree = await v.contains(top.id);
  assert.deepEqual(tree.children.map(c => [c.path, c.qty, c.children.length]), [["asm/Sub.mcadasm", 2, 2], ["parts/Bolt.mcadprt", 1, 0]]);
  const wu = await v.whereUsed(bolt.id);
  assert.deepEqual(wu.map(n => [n.path, n.qty, n.children.map(c => c.path)]), [["asm/Sub.mcadasm", 4, ["asm/Top.mcadasm"]], ["asm/Top.mcadasm", 1, []]]);
  const bom = await v.bom(top.id);
  assert.deepEqual(bom.map(r => [r.path, r.qty]), [["asm/Sub.mcadasm", 2], ["parts/Bolt.mcadprt", 9], ["parts/Plate.mcadprt", 2]]);
  // A newer Bolt: "as checked in" keeps v1, "latest" takes v2.
  await v.checkOut(bolt.id);
  await v.saveWorking(bolt.id, await doc("part", [], { description: "M6 bolt" }));
  await v.checkIn(bolt.id, "M6");
  assert.equal((await v.contains(top.id, undefined, "built")).children[1].version, 1);
  assert.equal((await v.contains(top.id, undefined, "latest")).children[1].version, 2);
  // Rename and move: users get a new version with the reference redirected.
  await v.rename(plate.id, "parts/Base plate.mcadprt");
  let s2 = await v.file(sub.id);
  assert.equal(v.latest(s2).n, 2);
  assert.match(v.latest(s2).comment, /renamed/);
  assert.deepEqual((await docRefs("x.mcadasm", (await v.working("asm/Sub.mcadasm"))!)).map(r => r.path), ["../parts/Bolt.mcadprt", "../parts/Base plate.mcadprt"]);
  assert.equal(v.latest(s2).refs![1].id, plate.id);
  assert.equal(await v.working("parts/Plate.mcadprt"), null);
  await v.rename(sub.id, "Sub.mcadasm");
  s2 = await v.file(sub.id);
  // Moving the assembly itself rewrites its own relative references.
  assert.deepEqual((await docRefs("x.mcadasm", (await v.working("Sub.mcadasm"))!)).map(r => r.path), ["parts/Bolt.mcadprt", "parts/Base plate.mcadprt"]);
  assert.deepEqual((await docRefs("x.mcadasm", (await v.working("asm/Top.mcadasm"))!)).map(r => r.path), ["../Sub.mcadasm", "../parts/Bolt.mcadprt"]);
  assert.deepEqual((await v.verify()).broken, []);
  // Delete: refused while used; a free file goes to the recycle bin and comes back.
  await assert.rejects(v.remove(bolt.id), /Used by/);
  const loose = await v.add("loose.txt", enc.encode("x"));
  await v.remove(loose.id);
  assert.equal((await v.files()).some(f => f.id === loose.id), false);
  assert.equal((await v.recycleBin()).length, 1);
  await v.restore(loose.id);
  assert.equal(new TextDecoder().decode((await v.working("loose.txt"))!), "x");
  // BOM compare between Top v1 and a Top that drops the loose Bolt.
  await v.checkOut(top.id);
  await v.saveWorking(top.id, await doc("assembly", [{ path: "../Sub.mcadasm", qty: 3 }]));
  await v.checkIn(top.id, "three subs");
  const diff = await v.bomCompare(top.id, 2, 3);
  assert.deepEqual(diff.map(d => [d.path, d.change]).sort(), [["Sub.mcadasm", "quantity"], ["parts/Base plate.mcadprt", "quantity"], ["parts/Bolt.mcadprt", "quantity"]].sort());
});

test("vault: copy tree with renaming and new numbers (FR-PDM-024)", async () => {
  const v = await Vault.create(memDir("C"), "C", "Andrey", "pc1");
  await v.saveSettings({ numbering: { pattern: "BR-{000}", onAdd: true } });
  const arm = await v.add("Arm.mcadprt", await doc("part"));
  assert.equal(arm.card!["Part number"], "BR-001");
  assert.equal((await readProps("Arm.mcadprt", (await v.working("Arm.mcadprt"))!))!.partNumber, "BR-001");
  const std = await v.add("Screw.mcadprt", await doc("part"));
  const top = await v.add("Frame.mcadasm", await doc("assembly", [{ path: "Arm.mcadprt", qty: 2 }, { path: "Screw.mcadprt", qty: 8 }]));
  const copies = await v.copyTree(top.id, { ids: [arm.id], folder: "v2", suffix: "-B", renumber: true });
  assert.deepEqual([...copies.values()].map(f => [f.path, f.card!["Part number"], f.versions.length]).sort(), [["v2/Arm-B.mcadprt", "BR-004", 1], ["v2/Frame-B.mcadasm", "BR-005", 1]]);
  const nf = copies.get(top.id)!;
  // The copied arm is used; the screw that was not copied is still the original.
  assert.deepEqual((await docRefs("v2/Frame-B.mcadasm", (await v.working("v2/Frame-B.mcadasm"))!)).map(r => r.path), ["Arm-B.mcadprt", "../Screw.mcadprt"]);
  assert.deepEqual(v.latest(nf).refs!.map(r => r.id), [copies.get(arm.id)!.id, std.id]);
  await assert.rejects(v.copyTree(top.id, { ids: [arm.id], folder: "v2", suffix: "-B" }), /already in the vault/);
});

test("vault: lifecycle, revisions, data cards, search and compare (FR-PDM-031..042, 050)", async () => {
  const v = await Vault.create(memDir("L"), "L", "Andrey", "pc1");
  await v.saveSettings({ revScheme: { kind: "letters", skip: true, pre: "x" }, cards: { "*": [{ name: "Part number", type: "text", prop: "partNumber", required: true }, { name: "Description", type: "text", prop: "description" }, { name: "Material", type: "list", options: ["Steel", "Aluminium 6061"], prop: "Material" }, { name: "Mass", type: "number" }] } });
  const p = await v.add("Bracket.mcadprt", await doc("part", [], { description: "Bracket" }, [{ id: "f1", type: "extrude", depth: { expr: "10 mm", value: 10 } }]));
  assert.equal(p.card!.Description, "Bracket");
  const asm = await v.add("Unit.mcadasm", await doc("assembly", [{ path: "Bracket.mcadprt", qty: 2 }]));
  // Data card: only while checked out; values are checked; mapped fields reach the document.
  await assert.rejects(v.setCard(p.id, { Mass: "1" }), /Check the file out/);
  await v.checkOut(p.id);
  await assert.rejects(v.setCard(p.id, { Mass: "heavy" }), /must be a number/);
  await assert.rejects(v.setCard(p.id, { Material: "Wood" }), /must be one of/);
  await v.setCard(p.id, { Material: "Aluminium 6061", Mass: "0.2" });
  assert.equal((await readProps("Bracket.mcadprt", (await v.working("Bracket.mcadprt"))!))!.Material, "Aluminium 6061");
  await v.saveWorking(p.id, await doc("part", [], { description: "Bracket, long", custom: { Material: "Aluminium 6061" } }, [{ id: "f1", type: "extrude", depth: { expr: "20 mm", value: 20 } }, { id: "f2", type: "fillet" }]));
  await v.checkIn(p.id, "longer");
  // Properties edited in the document come back into the card.
  assert.equal((await v.file(p.id)).card!.Description, "Bracket, long");
  // Submit gives a pre-release label; Approve needs the required field, and the assembly waits for its part.
  await v.transition([p.id], "Submit for review");
  assert.equal((await v.file(p.id)).revision, "X1");
  await assert.rejects(v.checkOut(p.id), /cannot be checked out/);
  const chk = await v.checkTransition([p.id], "Approve");
  assert.deepEqual(chk[0].problems, [{ key: "Fill in {field} first.", p: { field: "Part number" } }]);
  await v.transition([p.id], "Reject", "needs a number");
  await v.checkOut(p.id);
  const num = await v.assignNumber(p.id);
  assert.equal(num, `MC-${new Date().getFullYear()}-0001`);
  await v.checkIn(p.id, "numbered");
  await v.checkOut(asm.id);
  await v.setCard(asm.id, { "Part number": "U-1" });
  await v.checkIn(asm.id, "numbered");
  await v.transition([asm.id], "Submit for review");
  await v.transition([p.id], "Submit for review");
  assert.equal((await v.file(p.id)).revision, "X2");
  const blocked = await v.checkTransition([asm.id], "Approve");
  assert.match(blocked[0].problems.map(fmtMsg).join(), /Bracket.mcadprt is In review, not released/);
  // Releasing both together is fine; the part's properties get the revision (a new version).
  const labels = await v.transition([asm.id, p.id], "Approve");
  assert.equal(labels[p.id], "A");
  const rel = await v.file(p.id);
  assert.equal(rel.state, "Released");
  assert.equal(v.latest(rel).rev, "A");
  assert.equal(v.latest(rel).comment, "Revision A");
  const props = (await readProps("Bracket.mcadprt", (await v.working("Bracket.mcadprt"))!))!;
  assert.deepEqual([props.revision, props.State, props["Approved by"]], ["A", "Released", "Andrey"]);
  // Change → Change pending; the released revision stays what "latest released" resolves to.
  await v.transition([p.id], "Change");
  await v.checkOut(p.id);
  await v.saveWorking(p.id, await doc("part", [], { description: "Bracket, long", partNumber: num, custom: { Material: "Steel" }, revision: "A" }));
  await v.checkIn(p.id, "steel");
  assert.equal(v.released(await v.file(p.id))!.rev, "A");
  await v.transition([p.id], "Submit change");
  await v.transition([p.id], "Approve");
  assert.equal((await v.file(p.id)).revision, "B");
  // Search by text, card field, state, revision and "contains material".
  assert.deepEqual((await v.search({ text: "long" })).map(f => f.path), ["Bracket.mcadprt"]);
  assert.deepEqual((await v.search({ state: "Released", revision: "b" })).map(f => f.path), ["Bracket.mcadprt"]);
  assert.deepEqual((await v.search({ fields: { Material: "steel" } })).map(f => f.path), ["Bracket.mcadprt"]);
  assert.deepEqual((await v.search({ contains: { field: "Material", value: "Steel" } })).map(f => f.path), ["Unit.mcadasm"]);
  assert.deepEqual(await v.search({ kind: "drawing" }), []);
  // Compare v1 and v2: card and feature-tree differences.
  const cmp = await v.compare(p.id, 1, 2);
  assert.deepEqual(cmp.card.map(c => c.field).sort(), ["Description", "Mass", "Material"]);
  assert.ok(cmp.card.some(c => c.field === "Description" && c.from === "Bracket" && c.to === "Bracket, long"));
  assert.deepEqual(cmp.features!.added, ["fillet"]);
  assert.deepEqual(cmp.features!.changed.filter(c => c.feature === "extrude").map(c => [c.param, c.from, c.to]), [["depth", "10 mm", "20 mm"]]);
  // Purge keeps released revisions.
  await v.purge(1);
  const after = await v.file(p.id);
  assert.deepEqual(after.versions.filter(x => !x.purged).map(x => x.rev), ["A", "B"]);
  // Obsolete; the audit trail has every transition.
  await v.transition([p.id], "Make obsolete", "replaced");
  assert.equal((await v.auditTrail(p.id)).filter(e => e.action === "transition").length, 8);
});

test("vault: roles in a shared vault (FR-PDM-037)", async () => {
  const root = memDir("S");
  const v = await Vault.create(root, "S", "Andrey", "pc1");
  await v.saveSettings({ shared: true, roles: { Olga: ["Designer", "Checker"] } });
  const f = await v.add("a.txt", enc.encode("a"));
  await v.transition([f.id], "Submit for review");
  const o = await Vault.open(root, "Olga", "pc2");
  assert.deepEqual(o.rolesOf(), ["Designer", "Checker"]);
  assert.deepEqual((await o.checkTransition([f.id], "Approve"))[0].problems.map(fmtMsg), ["Needs the role Approver."]);
  await assert.rejects(o.saveSettings({ shared: false }), /Only an Admin/);
  await o.transition([f.id], "Reject", "no");
  assert.equal((await v.file(f.id)).state, "Work in progress");
});

test("vault: an assembly's embedded parts are its references; open as checked in / latest; rename follows (FR-PDM-003/020/022)", async () => {
  const { embeddedParts, docJson } = await import("../../src/pdm/codec");
  const v = await Vault.create(memDir("E"), "E", "Andrey", "pc1");
  const part = (desc: string) => ({ kind: "part", props: { description: desc }, features: [] });
  // An assembly as the app saves it: no references list, parts embedded with the file they came from.
  const asmDoc = { kind: "assembly", parts: { pin: { name: "Pin", file: "Pin.mcadprt", doc: part("v1") }, plate: { name: "Plate", file: "Plate.step", doc: part("") } },
    components: [{ id: "c1", part: "pin" }, { id: "c2", part: "pin" }, { id: "c3", part: "plate" }, { id: "c4", part: "pin", suppressed: true }] };
  const asmBytes = await zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "assembly" }) }, { name: "document.json", data: JSON.stringify(asmDoc) }]);
  assert.deepEqual(await docRefs("a/Top.mcadasm", asmBytes), [{ path: "Pin.mcadprt", qty: 2 }, { path: "Plate.step", qty: 1 }]);
  assert.deepEqual((await embeddedParts(asmBytes)).map(p => p.file), ["Pin.mcadprt"]);
  const pin = await v.add("a/Pin.mcadprt", await doc("part", [], { description: "v1" }));
  const top = await v.add("a/Top.mcadasm", asmBytes);
  assert.deepEqual(v.latest(top).refs!.map(r => [r.id, r.qty]), [[pin.id, 2], ["", 1]]);
  // The pin moves on; "latest" puts it in place of the embedded copy, "built" keeps the copy.
  await v.checkOut(pin.id);
  await v.saveWorking(pin.id, await doc("part", [], { description: "v2" }));
  await v.checkIn(pin.id, "longer");
  const built = await v.resolvedBytes(top.id, undefined, "built");
  const latest = await v.resolvedBytes(top.id, undefined, "latest");
  const desc = async (b: Uint8Array) => ((await docJson(b)) as { parts: { pin: { doc: { props: { description: string } } } } }).parts.pin.doc.props.description;
  assert.equal(await desc(built.bytes), "v1");
  assert.equal(await desc(latest.bytes), "v2");
  assert.deepEqual(latest.changed, ["a/Pin.mcadprt"]);
  // Nothing released yet: latest released falls back to the latest.
  assert.equal(await desc((await v.resolvedBytes(top.id, undefined, "released")).bytes), "v2");
  // Renaming the pin rewrites the file name inside the assembly.
  await v.rename(pin.id, "a/Dowel.mcadprt");
  const t2 = (await v.files()).find(f => f.id === top.id)!;
  assert.deepEqual(v.latest(t2).refs!.map(r => r.path), ["Dowel.mcadprt", "Plate.step"]);
  const j = await docJson(await v.versionBytes(top.id, v.latest(t2).n)) as { parts: { pin: { file: string } } };
  assert.equal(j.parts.pin.file, "Dowel.mcadprt");
});

test("vault: full-text search in notes and drawing text; STEP stamped with the revision (FR-PDM-043/034)", async () => {
  const { docText } = await import("../../src/pdm/codec");
  const { stampStep } = await import("../../src/pdm/stepStamp");
  const v = await Vault.create(memDir("T"), "T", "Andrey", "pc1");
  const drawing = await zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "drawing" }) },
    { name: "drawing.json", data: JSON.stringify({ kind: "drawing", props: { title: "Bracket" }, sheets: [{ name: "Sheet1", annots: [{ t: "note", text: "Deburr all edges", pos: [0, 0] }, { t: "table", cols: ["Rev."], rows: [["A", "Fixture holes moved"]], pos: [0, 0] }], views: [{ id: "v1", orient: "front" }] }], source: { kind: "file", name: "x.step" } }) }]);
  assert.match(await docText("d/Bracket.mcaddrw", drawing), /Deburr all edges[\s\S]*Fixture holes moved/);
  await v.add("d/Bracket.mcaddrw", drawing);
  await v.add("d/readme.txt", enc.encode("Anodise black after machining"));
  await v.add("d/other.txt", enc.encode("nothing here"));
  assert.deepEqual((await v.search({ content: "deburr" })).map(f => f.path), ["d/Bracket.mcaddrw"]);
  assert.deepEqual((await v.search({ content: "ANODISE" })).map(f => f.path), ["d/readme.txt"]);
  assert.deepEqual((await v.search({ content: "fixture holes", kind: "drawing" })).map(f => f.path), ["d/Bracket.mcaddrw"]);
  // STEP: the product gets the part number, its formation the revision; other products stay.
  const step = "DATA;\n#10=PRODUCT('Bracket','Bracket','',(#3));\n#11=PRODUCT_DEFINITION_FORMATION('','',#10);\n#20=PRODUCT('Bolt','Bolt','',(#3));\n#21=PRODUCT_DEFINITION_FORMATION('','',#20);\nENDSEC;";
  const s = stampStep(step, { name: "Bracket", revision: "B", number: "BR-001", description: "Main bracket" });
  assert.match(s, /#10=PRODUCT\('BR-001','Bracket','Main bracket'/);
  assert.match(s, /#11=PRODUCT_DEFINITION_FORMATION\('B','',#10\)/);
  assert.match(s, /#21=PRODUCT_DEFINITION_FORMATION\('','',#20\)/);
  assert.match(stampStep("#1=PRODUCT('P','P','',(#2));#2=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#1,.NOT_KNOWN.);", { revision: "Ä" }), /SOURCE\('\\X2\\00C4\\X0\\'/);
});

test("vault: check in referenced files too, deepest first, changed ones marked (FR-PDM-011)", async () => {
  const v = await Vault.create(memDir("W"), "W", "Andrey", "pc1");
  const bolt = await v.add("parts/Bolt.mcadprt", await doc("part"));
  const plate = await v.add("parts/Plate.mcadprt", await doc("part"));
  const sub = await v.add("asm/Sub.mcadasm", await doc("assembly", [{ path: "../parts/Bolt.mcadprt", qty: 4 }, { path: "../parts/Plate.mcadprt" }]));
  const top = await v.add("asm/Top.mcadasm", await doc("assembly", [{ path: "Sub.mcadasm" }]));
  for (const f of [bolt, plate, sub, top]) await v.checkOut(f.id);
  await v.saveWorking(bolt.id, await doc("part", [], { description: "M6 bolt" }));
  const list = await v.checkInWith(top.id);
  assert.deepEqual(list.map(x => [x.path, x.modified]), [["parts/Bolt.mcadprt", true], ["parts/Plate.mcadprt", false], ["asm/Sub.mcadasm", false]]);
  // A file no longer checked out here drops off the list.
  await v.undoCheckOut(plate.id);
  assert.deepEqual((await v.checkInWith(top.id)).map(x => x.path), ["parts/Bolt.mcadprt", "asm/Sub.mcadasm"]);
});

test("vault: linked assembly components resolve by their hash, show newer versions and update from the vault (FR-ASM-003)", async () => {
  const { docJson } = await import("../../src/pdm/codec");
  const { sha256 } = await import("../../src/pdm/vault");
  const v = await Vault.create(memDir("L"), "L", "Andrey", "pc1");
  const p1 = await doc("part", [], { description: "v1" });
  const pin = await v.add("a/parts/Pin.mcadprt", p1);
  // The pin moves on to v2 before the assembly is checked in: the link still names v1's bytes.
  await v.checkOut(pin.id);
  await v.saveWorking(pin.id, await doc("part", [], { description: "v2" }));
  await v.checkIn(pin.id, "v2");
  const part = (desc: string) => ({ kind: "part", props: { description: desc }, features: [] });
  const asmDoc = { kind: "assembly", parts: { pin: { name: "Pin", file: "Pin.mcadprt", doc: part("v1"), link: { path: "parts/Pin.mcadprt", hash: await sha256(p1) } } },
    components: [{ id: "c1", part: "pin" }, { id: "c2", part: "pin" }] };
  const asmBytes = await zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "assembly" }) }, { name: "document.json", data: JSON.stringify(asmDoc) }]);
  assert.deepEqual(await docRefs("a/Top.mcadasm", asmBytes), [{ path: "parts/Pin.mcadprt", qty: 2, hash: await sha256(p1) }]);
  const top = await v.add("a/Top.mcadasm", asmBytes);
  assert.deepEqual(v.latest(top).refs, [{ id: pin.id, path: "parts/Pin.mcadprt", version: 1, qty: 2, linked: true }]);
  const tree = await v.contains(top.id);
  assert.equal(tree.children[0].version, 1);
  assert.equal(tree.children[0].linked, true);
  assert.equal(tree.children[0].newer, 2);
  assert.deepEqual((await v.outdatedLinks(top.id)).map(x => [x.path, x.version, x.latest]), [["a/parts/Pin.mcadprt", 1, 2]]);
  // Opened with the latest components, the link hash follows the version put in.
  const pin2 = (await v.files()).find(f => f.id === pin.id)!;
  const latest = await v.resolvedBytes(top.id, undefined, "latest");
  const j = await docJson(latest.bytes) as { parts: { pin: { doc: { props: { description: string } }; link: { hash: string } } } };
  assert.equal(j.parts.pin.doc.props.description, "v2");
  assert.equal(j.parts.pin.link.hash, v.latest(pin2).sha);
  // Update links needs a check-out, then writes the working copy; checked in, nothing is outdated.
  await assert.rejects(v.updateLinks(top.id));
  await v.checkOut(top.id);
  assert.deepEqual(await v.updateLinks(top.id), ["a/parts/Pin.mcadprt"]);
  assert.deepEqual(await v.updateLinks(top.id), []);
  await v.checkIn(top.id, "links");
  const t2 = (await v.files()).find(f => f.id === top.id)!;
  assert.equal(v.latest(t2).refs![0].version, 2);
  assert.deepEqual(await v.outdatedLinks(top.id), []);
  // Renaming the part rewrites the link path.
  await v.rename(pin.id, "a/parts/Dowel.mcadprt");
  const t3 = (await v.files()).find(f => f.id === top.id)!;
  const j3 = await docJson(await v.versionBytes(top.id, v.latest(t3).n)) as { parts: { pin: { link: { path: string } } } };
  assert.equal(j3.parts.pin.link.path, "parts/Dowel.mcadprt");
  assert.equal(v.latest(t3).refs![0].linked, true);
});
