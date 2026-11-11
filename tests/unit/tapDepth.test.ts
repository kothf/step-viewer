import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTapDepth, keepTapDepth, tapDepthLinked, tapTooShallow } from "../../src/model/tapDepth";
import type { HoleFeature } from "../../src/model/types";

const m5 = (o: Partial<HoleFeature> = {}): HoleFeature => ({ id: "h", type: "hole", name: "Hole", pts: [[0, 0]], kind: "tapped", size: "M5", diameter: { v: 4.2 }, major: 5, pitch: 0.8, threadDepth: { v: 10 }, end: "blind", depth: { v: 10 }, ...o });

test("a blind M5 tap drill goes past its 10 mm thread", () => {
  const f = m5();
  assert.equal(autoTapDepth(f), 12.5);
  assert.ok(Math.abs(tapTooShallow(f)! - 11.6) < 1e-9);
  keepTapDepth(f, false);
  assert.equal(f.depth.v, 12.5);
  assert.equal(tapTooShallow(f), null);
  assert.ok(tapDepthLinked(f));
});

test("a linked drill follows the thread, a deeper typed one stays", () => {
  const f = m5({ depth: { v: 12.5 } });
  const linked = tapDepthLinked(f);
  f.threadDepth = { v: 8 };
  keepTapDepth(f, linked);
  assert.equal(f.depth.v, 10.5);
  const g = m5({ depth: { v: 20 } });
  g.threadDepth = { v: 8 };
  keepTapDepth(g, tapDepthLinked(g));
  assert.equal(g.depth.v, 20);
  g.threadDepth = { v: 19 };
  keepTapDepth(g, false);
  assert.equal(g.depth.v, 21.5);
});

test("through holes, through threads, other kinds and expressions are left alone", () => {
  for (const f of [m5({ end: "through" }), m5({ kind: "simple" }), m5({ depth: { v: 10, expr: "D1" } })]) {
    keepTapDepth(f, true);
    assert.equal(f.depth.v, 10);
  }
  assert.equal(tapTooShallow(m5({ end: "through" })), null);
});

test("tapered taps and custom tapped holes", () => {
  const p = m5({ kind: "ptap", size: "1/4-18 NPT", diameter: { v: 11 }, major: 13.6, pitch: 1.41, threadDepth: { v: 10 }, depth: { v: 10 } });
  keepTapDepth(p, false);
  assert.equal(p.depth.v, 15.5);
  const c = m5({ size: undefined, major: undefined, pitch: undefined, threadDepth: undefined, diameter: { v: 5 } });
  assert.ok(tapTooShallow(c)! > 10);
  keepTapDepth(c, false);
  assert.equal(c.depth.v, 12.5);
});
