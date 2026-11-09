// Preferences (FR-UI-080): stored texts, defaults, change notices, spin steps and the journal delay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autosaveDelay, DEFAULT_PREFS, getPref, loadPrefs, onPrefs, parsePref, qualityFactor, setPrefs, stepFor } from "../../src/prefs";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

test("stored texts parse by kind; bad values give the default", () => {
  assert.equal(parsePref("autoRels", null), true);
  assert.equal(parsePref("autoRels", "0"), false);
  assert.equal(parsePref("grid", "1"), true);
  assert.equal(parsePref("grid", "maybe"), false);
  assert.equal(parsePref("gridStep", ""), 0);
  assert.equal(parsePref("gridStep", "2.5"), 2.5);
  assert.equal(parsePref("lenStep", "0"), 1);
  assert.equal(parsePref("angStep", "-3"), 5);
  assert.equal(parsePref("quality", "fine"), "fine");
  assert.equal(parsePref("quality", "ultra"), "normal");
  assert.equal(parsePref("middle", "rotate"), "rotate");
  assert.equal(qualityFactor("coarse"), 2);
  assert.equal(qualityFactor("fine"), 0.5);
});

test("setPrefs stores under the old sketch keys and reports what changed", () => {
  mem.clear();
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
  const seen: string[][] = [];
  const off = onPrefs((_p, ch) => seen.push(ch));
  assert.deepEqual(setPrefs({ autoRels: false, grid: true, gridStep: 5, quality: "normal" }), ["autoRels", "grid", "gridStep"]);
  assert.equal(mem.get("mc:autoRels"), "0");
  assert.equal(mem.get("mc:skGrid"), "1");
  assert.equal(mem.get("mc:skGridStep"), "5");
  assert.deepEqual(setPrefs({ grid: true }), []);
  off();
  assert.deepEqual(seen, [["autoRels", "grid", "gridStep"]]);
  assert.equal(getPref("autoRels"), false);
});

test("spin steps and the recovery journal delay", () => {
  mem.clear();
  assert.equal(stepFor("length", "mm"), 1);
  assert.equal(stepFor("length", "in"), 0.1);
  assert.equal(stepFor("angle"), 5);
  setPrefs({ lenStep: 0.5, angStep: 15 });
  assert.equal(stepFor("length", "in"), 0.5);
  assert.equal(stepFor("angle"), 15);
  assert.equal(autosaveDelay(), 800);
  setPrefs({ autosave: 30 });
  assert.equal(autosaveDelay(), 30000);
  setPrefs({ autosave: 0 });
  assert.equal(autosaveDelay(), null);
});
