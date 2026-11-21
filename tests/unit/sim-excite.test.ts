import assert from "node:assert/strict";
import { test } from "node:test";
import { nearExcitation, parseExcitation } from "../../src/sim/excite";

test("an excitation frequency is read in Hz, kHz and rpm", () => {
  assert.equal(parseExcitation("50"), 50);
  assert.equal(parseExcitation(" 50 Hz "), 50);
  assert.equal(parseExcitation("1,2 kHz"), 1200);
  assert.equal(parseExcitation("3000 rpm"), 50);
  assert.equal(parseExcitation("3000 об/мин"), 50);
  assert.equal(parseExcitation("0"), null);
  assert.equal(parseExcitation("fast"), null);
  assert.equal(parseExcitation("50 N"), null);
  assert.equal(parseExcitation(""), null);
});

test("modes within 10 % of the excitation are found, rigid-body ones never", () => {
  assert.deepEqual(nearExcitation([0, 0, 44.9, 45, 50, 55, 55.1, 400], 50), [3, 4, 5]);
  assert.deepEqual(nearExcitation([0, 100], 0), []);
  assert.deepEqual(nearExcitation([10, 20], 50), []);
});
