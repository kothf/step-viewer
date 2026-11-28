// Simulation results kept with a model (.mcadres): the codec, the file, and the copy inside part and assembly files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeValue, encodeValue, keyHash, stableJson, packResults, resultsHead, resultsName, unpackResults } from "../../src/sim/resultsFile";
import { packPart, unpackPartFile } from "../../src/model/file";
import { packAsm, unpackAsmFile } from "../../src/asm/file";
import { newPart } from "../../src/model/doc";
import type { AsmDoc } from "../../src/asm/types";

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

const sample = () => ({
  passes: [{ pass: 1, p: 2, change: null, energy: 12.5, errors: [null, 3.2], u: Float32Array.from([1, 2, 3, -4.5]), vm: new Float32Array([0.25, NaN]), dom: Int32Array.from([0, 1, -1]), modes: [{ hz: 120.5, x: Float64Array.from([1e-9, Math.PI]) }] },
    { pass: 2, p: 3, change: 0.4, energy: Infinity, low: -Infinity, u: new Float32Array(0), flags: Uint8Array.from([1, 0, 255]) }],
  ids: ["s1", "l1"],
  mesh: { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), nrm: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]), index: Uint32Array.from([0, 1, 2]) },
  gone: undefined,
});

test("results keep typed arrays, NaN and infinities", () => {
  const v = sample(), { json, bin } = encodeValue(v);
  const back = decodeValue(json, bin) as ReturnType<typeof sample>;
  assert.ok(back.passes[0].u instanceof Float32Array);
  assert.deepEqual(Array.from(back.passes[0].u), [1, 2, 3, -4.5]);
  assert.ok(Number.isNaN(back.passes[0].vm[1]));
  assert.ok(back.passes[0].dom instanceof Int32Array && back.passes[0].dom[2] === -1);
  assert.ok(back.passes[0].modes[0].x instanceof Float64Array && back.passes[0].modes[0].x[1] === Math.PI);
  assert.equal(back.passes[1].energy, Infinity);
  assert.equal((back.passes[1] as { low: number }).low, -Infinity);
  assert.deepEqual(back.passes[0].errors, [null, 3.2]);
  assert.ok(back.mesh.index instanceof Uint32Array);
  assert.deepEqual(Array.from(back.passes[1].flags as Uint8Array), [1, 0, 255]);
  assert.ok(!("gone" in back));
});

test("a results file names its model and keeps each study", async () => {
  const bytes = await packResults({ doc: "doc-1", model: "Bracket", saved: "2026-11-24T10:00:00.000Z", active: "st2", studies: [
    { id: "st1", name: "Static 1", kind: "static", key: keyHash("a"), at: "2026-11-24T09:00:00.000Z", data: sample() },
    { id: "st2", name: "Heat", kind: "thermal", key: keyHash("b"), at: "2026-11-24T09:30:00.000Z", data: { passes: [{ vm: Float32Array.from([25, 80]) }] } },
  ] }, "test", new Map([["st2", [{ name: "Bracket Heat-thermal.json", data: "{}" }]]]));
  const head = await resultsHead(bytes);
  assert.equal(head?.doc, "doc-1");
  assert.equal(head?.studies.length, 2);
  assert.deepEqual(head?.studies[1].thermal, ["thermal/Bracket Heat-thermal.json"]);
  const r = await unpackResults(bytes);
  assert.equal(r.model, "Bracket");
  // the study on screen when it was saved opens again (as in other CAD apps)
  assert.equal(r.active, "st2");
  assert.deepEqual(r.studies.map(s => s.id), ["st1", "st2"]);
  assert.equal(r.studies[0].key, keyHash("a"));
  assert.deepEqual(Array.from((r.studies[1].data as { passes: { vm: Float32Array }[] }).passes[0].vm), [25, 80]);
  assert.equal(await resultsHead(new TextEncoder().encode("not a zip")), null);
});

test("the key fingerprint tells states apart", () => {
  assert.equal(keyHash("[1,2,3]"), keyHash("[1,2,3]"));
  assert.notEqual(keyHash("[1,2,3]"), keyHash("[1,2,4]"));
  assert.notEqual(keyHash(""), keyHash(" "));
  // a document read from its file has its keys sorted: the key must not depend on the order
  assert.equal(stableJson([{ b: 1, a: { d: [1, { z: 0, y: 1 }], c: null } }]), stableJson([{ a: { c: null, d: [1, { y: 1, z: 0 }] }, b: 1 }]));
  assert.equal(resultsName("Bracket.mcadprt"), "Bracket.mcadres");
  assert.equal(resultsName("My asm.v2.mcadasm"), "My asm.v2.mcadres");
});

test("a part and an assembly saved as one file carry their results; old files have none", async () => {
  const res = await packResults({ doc: "p", model: "P", saved: "", studies: [] }, "test");
  const part = newPart("P");
  const withRes = await unpackPartFile(buf(await packPart(part, "test", undefined, null, res)));
  assert.deepEqual(Array.from(withRes.results!), Array.from(res));
  assert.equal((await unpackPartFile(buf(await packPart(part, "test")))).results, null);
  const asm = { schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 }, parts: {}, components: [] } as unknown as AsmDoc;
  assert.deepEqual(Array.from((await unpackAsmFile(buf(await packAsm(asm, "test", null, res)))).results!), Array.from(res));
  assert.equal((await unpackAsmFile(buf(await packAsm(asm, "test")))).results, null);
});
