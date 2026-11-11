import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSI_UNC, ANSI_UNF, HOLE_STANDARDS, ISO_FINE, ISO_METRIC, holeSize, majorOf, standardOf, threadClass } from "../../src/model/holes";

test("hole sizes: ISO M1.6 to M64 coarse, fine pitches, ANSI inch UNC/UNF, each row consistent (FR-FT-051)", () => {
  assert.equal(ISO_METRIC[0].size, "M1.6");
  assert.equal(ISO_METRIC.at(-1)!.size, "M64");
  for (const [k, list] of Object.entries(HOLE_STANDARDS)) {
    assert.equal(new Set(list.map(h => h.size)).size, list.length, `${k}: repeated size`);
    let last = 0;
    for (const h of list) {
      const d = majorOf(h);
      assert.ok(d >= last, `${h.size}: out of order`);
      last = d;
      assert.ok(h.tap < d && h.tap > d - 1.3 * h.pitch, `${h.size}: tap ${h.tap} for d ${d} P ${h.pitch}`);
      assert.ok(h.clear.close > d && h.clear.close <= h.clear.normal && h.clear.normal < h.clear.loose, `${h.size}: clearance`);
      assert.ok(h.cbore[0] > h.clear.loose && h.cbore[1] >= d, `${h.size}: counterbore`);
      assert.ok(h.csink > h.clear.loose, `${h.size}: countersink`);
      assert.equal(standardOf(h.size), k);
      assert.equal(holeSize(h.size), h);
    }
  }
  const m8 = holeSize("M8x1")!;
  assert.deepEqual([m8.pitch, m8.tap, majorOf(m8), m8.clear.normal], [1, 7, 8, 9]);
  assert.equal(ISO_FINE.length, 20);
  const q = holeSize("1/4-20 UNC")!;
  assert.ok(Math.abs(majorOf(q) - 6.35) < 1e-9 && Math.abs(q.pitch - 1.27) < 1e-9 && Math.abs(q.tap - 5.105) < 1e-3 && q.csAng === 82);
  assert.equal(holeSize("1/4-28 UNF")!.tap, 5.41);
  assert.equal(ANSI_UNC.length, ANSI_UNF.length);
  assert.equal(threadClass("M6"), "6H");
  assert.equal(threadClass("M8x1"), "6H");
  assert.equal(threadClass("#10-32 UNF"), "2B");
  assert.equal(standardOf(undefined), "iso");
});
