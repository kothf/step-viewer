// STEP names in the wrong character set (Russian CAD exports): repaired after OCCT reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fixResultNames, looksCp1251, nameFixer } from "../../src/names";
import { decodeStepString, readStepMeta } from "../../src/stepMeta";

const latin = (b: number[] | Uint8Array) => String.fromCharCode(...b);
const cp1251 = (s: string) => Uint8Array.from(s, c => {
  const u = c.charCodeAt(0);
  return u < 0x80 ? u : u >= 0x410 && u <= 0x44f ? u - 0x350 : u === 0x401 ? 0xa8 : u === 0x451 ? 0xb8 : 0x3f;
});

test("Windows-1251 names read as Latin-1 come back as Cyrillic", () => {
  const names = ["ПЛ31а-п_черн", "Панелька_черн", "Ёлка"].map(s => latin(cp1251(s)));
  assert.equal(names[0], "ÏË31à-ï_÷åðí");
  const fix = nameFixer(names);
  assert.deepEqual(names.map(fix), ["ПЛ31а-п_черн", "Панелька_черн", "Ёлка"]);
  // Once the file is known to be Cyrillic, short names convert too.
  assert.equal(fix(latin(cp1251("Корпус_ПЛ"))), "Корпус_ПЛ");
});

test("genuine Latin-1, ASCII and Unicode names are left alone", () => {
  const names = ["Müller", "Instalação", "Größe", "Bracket_01", "Деталь"];
  assert.equal(looksCp1251(names), false);
  const fix = nameFixer(names);
  assert.deepEqual(names.map(fix), names);
});

test("UTF-8 bytes read as Latin-1 and UTF-16 code units read as bytes", () => {
  const u8 = latin(new TextEncoder().encode("Вал 20"));
  assert.equal(nameFixer([u8])(u8), "Вал 20");
  assert.equal(nameFixer(['"\u0004'])('"\u0004'), "Т");
  assert.equal(nameFixer(["\"\u00045\u0004;\u0004>\u0004"])("\"\u00045\u0004;\u0004>\u0004"), "Тело");
  assert.equal(nameFixer(["ab"])("ab"), "ab");
});

test("STEP string escapes", () => {
  assert.equal(decodeStepString("\\X2\\041F041B\\X0\\31\\X2\\0430\\X0\\"), "ПЛ31а");
  assert.equal(decodeStepString("A\\X4\\0001F600\\X0\\"), "A😀");
  assert.equal(decodeStepString("M\\S\\|ller"), "Müller");
  assert.equal(decodeStepString("M\\X\\FCller it''s"), "Müller it's");
});

test("occt-import-js reading a STEP with raw Windows-1251, UTF-8 and \\X2\\ names", async () => {
  const require = createRequire(join(process.cwd(), "x.js"));
  const occt = await require("occt-import-js")();
  const src = readFileSync(join(process.cwd(), "src/worker/warmup.step"), "latin1");
  const build = (name: Uint8Array) => {
    const parts = src.split("warm-up").map(p => Uint8Array.from(p, c => c.charCodeAt(0)));
    const out: number[] = [];
    parts.forEach((p, i) => { if (i) out.push(...name); out.push(...p); });
    return new Uint8Array(out);
  };
  const want = "ПЛ31а-п_черн";
  const x2 = [...want].map(c => c.charCodeAt(0) < 128 ? c : `\\X2\\${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}\\X0\\`).join("");
  for (const bytes of [cp1251(want), new TextEncoder().encode(want), new TextEncoder().encode(x2)]) {
    const file = build(bytes);
    const res = occt.ReadStepFile(file, null);
    assert.ok(res.success);
    fixResultNames(res);
    assert.equal(res.meshes[0].name, want);
    assert.equal(readStepMeta(file)?.products[0].name, want);
  }
});
