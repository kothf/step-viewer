// Fastener library (FR-ASM-028): ISO screws, nuts and washers as configured parametric parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { occ } from "./occ";
import { Modeller } from "../../src/kernel/model";
import { activate } from "../../src/model/configs";
import { refreshExprs } from "../../src/model/params";
import { FASTENERS, fastenerLengths, fastenerName, fastenerPart, fastenerSizes } from "../../src/asm/fasteners";

const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("FR-ASM-028: sizes, lengths and names", () => {
  assert.deepEqual(fastenerSizes("iso4762"), ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20"]);
  assert.ok(fastenerLengths("iso4762", "M6").includes(20) && !fastenerLengths("iso4762", "M6").includes(100));
  assert.equal(fastenerName("iso4762", "M6", 20), "ISO 4762 M6 x 20");
  assert.equal(fastenerName("iso4032", "M8"), "ISO 4032 M8");
  assert.equal(FASTENERS.length, 6);
});

test("FR-ASM-028: every fastener builds; volumes match the ISO sizes; sizes switch as configurations", async () => {
  const m = new Modeller(await occ());
  const vol = (pd: ReturnType<typeof fastenerPart>) => {
    const r = m.evaluate(pd);
    assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
    return m.props(r.body!).volume;
  };
  const hex = (s: number) => (Math.sqrt(3) / 2) * s * s;
  // ISO 4762 M6 x 20: Ø6 × 20 shank, Ø10 × 6 head, hex 5 socket 3 deep.
  const cap = fastenerPart("iso4762", "M6", 20);
  assert.equal(cap.config, "M6");
  assert.equal(cap.configs?.length, 11);
  close(vol(cap), Math.PI * 9 * 20 + Math.PI * 25 * 6 - hex(5) * 3);
  // ISO 4017 M8 x 30: hex 13 × 5.3 head.
  close(vol(fastenerPart("iso4017", "M8", 30)), Math.PI * 16 * 30 + hex(13) * 5.3);
  // ISO 4032 M10 nut: hex 16 × 8.4, Ø10 bore.
  close(vol(fastenerPart("iso4032", "M10")), (hex(16) - Math.PI * 25) * 8.4);
  // ISO 7089 M6 washer: Ø12/Ø6.4 × 1.6.
  close(vol(fastenerPart("iso7089", "M6")), Math.PI * (36 - 6.4 * 6.4 / 4) * 1.6);
  // ISO 7380 button head builds (drafted head).
  assert.ok(vol(fastenerPart("iso7380", "M5", 12)) > Math.PI * 6.25 * 12);
  // Switch the cap screw to M10 (its default length, 30): the part follows.
  activate(cap, "M10");
  refreshExprs(cap);
  close(vol(cap), Math.PI * 25 * 30 + Math.PI * 64 * 10 - hex(8) * 5);
});
