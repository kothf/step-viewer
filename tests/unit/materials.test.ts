import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, CHECKED, LIBRARY, MATERIAL_RU, SOURCES, findMaterial, parseCustom, resolveRef, searchMaterials, toRef, validMaterial } from "../../src/tools/materials";
import { RU } from "../../src/i18n.ru";
import { materialPattern } from "../../src/drawing/compose";

test("material library: large, unique names, sane values, a source and a Russian name for each (FR-MAT-001)", () => {
  assert.ok(LIBRARY.length >= 150, `only ${LIBRARY.length} materials`);
  assert.equal(new Set(LIBRARY.map(m => m.name)).size, LIBRARY.length);
  for (const c of CATEGORIES) if (c.id !== "custom") assert.ok(LIBRARY.some(m => m.cat === c.id), `empty category ${c.id}`);
  for (const m of LIBRARY) {
    assert.ok(m.density > 0.1 && m.density < 23, `${m.name}: density ${m.density}`);
    assert.ok(m.src && SOURCES[m.src], `${m.name}: source`);
    assert.match(m.color!, /^#[0-9a-f]{6}$/);
    if (m.E != null) assert.ok(m.E > 0 && m.E < 700, `${m.name}: E`);
    if (m.nu != null) assert.ok(m.nu > 0 && m.nu <= 0.5, `${m.name}: nu`);
    if (m.sy != null && m.su != null) assert.ok(m.sy <= m.su, `${m.name}: yield above tensile`);
    if (m.k != null) assert.ok(m.k > 0 && m.k < 450, `${m.name}: k`);
    if (m.cp != null) assert.ok(m.cp > 100 && m.cp < 4300, `${m.name}: cp`);
    // Every name with English words has its Russian entry; trade names and bare designations stay as they are.
    if (!/^(ABS|ASA|PLA|PETG|PC\/ABS|PEEK|PEI|TPU|Hastelloy)\b/.test(m.name)) assert.ok(RU[m.name], `${m.name}: no Russian name`);
  }
  for (const c of CATEGORIES) assert.equal(RU[c.name], c.ru);
  assert.equal(MATERIAL_RU["Steel S235JR"], "Сталь S235JR");
});

test("the materials of older documents keep their names and densities", () => {
  const old: [string, number][] = [["Steel (carbon)", 7.85], ["Stainless steel 304", 8.0], ["Aluminium 6061", 2.7], ["Brass", 8.5], ["Copper", 8.96], ["Titanium Ti-6Al-4V", 4.43], ["Cast iron", 7.2],
    ["ABS", 1.04], ["PLA", 1.24], ["Nylon PA6", 1.14], ["Polycarbonate", 1.2], ["POM (Delrin)", 1.41], ["PEEK", 1.32], ["Wood (oak)", 0.75]];
  for (const [name, density] of old) assert.equal(findMaterial(name)?.density, density, name);
});

test("material search: names, designations of other standards and Russian", () => {
  const ru = (s: string) => RU[s] ?? s;
  const names = (q: string, tr?: (s: string) => string) => searchMaterials(LIBRARY, q, tr).map(m => m.name);
  assert.equal(names("")?.length, LIBRARY.length);
  assert.equal(names("6061")[0], "Aluminium 6061");
  assert.ok(names("1.4301").includes("Stainless steel 1.4301 (X5CrNi18-10)"));
  assert.deepEqual(names("aisi 316l"), ["Stainless steel 1.4404 (X2CrNiMo17-12-2)"]);
  assert.deepEqual(names("д16т"), ["Aluminium EN AW-2024 T3"]);
  assert.equal(names("сталь 45", ru)[0], "Steel C45 (normalized)");
  assert.equal(names("дуб", ru)[0], "Wood (oak)");
  assert.equal(names("s355")[0], "Steel S355J2");
  assert.equal(names("no such thing").length, 0);
});

test("a document's material: all properties stored, older name + density refs filled in from the library", () => {
  const m = findMaterial("steel s355j2")!;
  const r = toRef(m);
  assert.deepEqual(r, { name: "Steel S355J2", density: 7.85, cat: "steel", E: 210, nu: 0.3, sy: 355, su: 470, k: 54, cp: 461, alpha: 12, color: "#8d9299" });
  assert.equal(resolveRef({ name: "Aluminium 6061", density: 2.7 }).sy, 276);
  // A changed density makes it the document's own material: nothing is filled in.
  assert.equal(resolveRef({ name: "Aluminium 6061", density: 2.9 }).sy, undefined);
  assert.equal(resolveRef({ name: "Unobtainium", density: 3 }).cat, "custom");
});

test("custom materials: validated, bad entries dropped", () => {
  assert.equal(validMaterial({ name: " ", density: 1 }), null);
  assert.equal(validMaterial({ name: "X", density: 0 }), null);
  assert.deepEqual(validMaterial({ name: " My alloy ", density: "7.7", E: 200, nu: "x", color: "#AABBCC", junk: 1 }), { name: "My alloy", density: 7.7, cat: "custom", E: 200, color: "#aabbcc" });
  assert.deepEqual(parseCustom('[{"name":"A","density":1},{"name":"A","density":2},{"density":3},7]').map(m => m.density), [1]);
  assert.deepEqual(parseCustom("not json"), []);
});

test("section hatching follows the library category of a material", () => {
  assert.equal(materialPattern("Steel S235JR"), "ansi32");
  assert.equal(materialPattern("Tool steel X153CrMoV12"), "ansi32");
  assert.equal(materialPattern("Cast steel GE240"), "ansi32");
  assert.equal(materialPattern("Ductile cast iron EN-GJS-400-15"), "ansi31");
  assert.equal(materialPattern("Gunmetal CuSn5Zn5Pb5-C"), "ansi33");
  assert.equal(materialPattern("Cast aluminium EN AC-42100 T6 (AlSi7Mg0.3, sand cast)"), "ansi38");
  assert.equal(materialPattern("Die cast magnesium AZ91D"), "ansi38");
  assert.equal(materialPattern("Zinc alloy Zamak 3"), "ansi37");
  assert.equal(materialPattern("PTFE"), "ansi34");
  assert.equal(materialPattern("FR-4 (glass/epoxy laminate)"), "ansi34");
  assert.equal(materialPattern("Titanium Grade 2"), "ansi31");
});

test("checked references name library materials and are plain https pages; corrected values (1.375.0)", () => {
  const keys = Object.keys(CHECKED);
  assert.ok(keys.length >= 40, `only ${keys.length} checked`);
  for (const k of keys) {
    const m = LIBRARY.find(x => x.name === k);
    assert.ok(m, `${k}: not in the library`);
    assert.equal(m!.ref, CHECKED[k]);
    assert.match(CHECKED[k], /^[a-z0-9.-]+\.[a-z]{2,}\/\S*$/, k);
    assert.doesNotThrow(() => new URL(`https://${CHECKED[k]}`), k);
  }
  assert.equal(findMaterial("Die cast aluminium A380")!.density, 2.71);
  assert.equal(findMaterial("Silicon carbide (sintered)")!.density, 3.15);
  assert.equal(findMaterial("Inconel 718 (aged)")!.su, 1276);
  assert.equal(findMaterial("Gold")!.E, 78);
});

test("second pass (1.379.0): most of the library has a checked reference, the rest is known", () => {
  const un = LIBRARY.filter(m => !m.ref).map(m => m.name);
  assert.ok(Object.keys(CHECKED).length >= 119, `${Object.keys(CHECKED).length} checked`);
  assert.ok(un.length <= 51, `${un.length} unchecked`);
  assert.ok(un.includes("PEEK") && un.includes("Wood (teak)"));
  assert.equal(findMaterial("Stainless steel 1.4404 (X2CrNiMo17-12-2)")!.ref, "www.thyssenkrupp-materials.co.uk/stainless-steel-316l-14404.html");
  assert.equal(findMaterial("Bronze CuSn8 (phosphor bronze)")!.E, 115);
});
