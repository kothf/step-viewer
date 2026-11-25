// Cut-cell fitting with kept moments sums the points line by line (points that differ in one coordinate only). The
// fitted points must be those of the plain sum over every point, whatever the lines' directions and order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Points, fitPoints, MOM_SIZE } from "../../src/sim/quad";

test("moments summed by lines of points equal the plain sum", () => {
  const src = new Points();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // lines along each axis, of several lengths, then loose points, then two lines on one another's end
  for (let v = 0; v < 3; v++) for (let l = 0; l < 40; l++) {
    const p = [rnd(), rnd(), rnd()], m = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < m; k++) { p[v] = rnd(); src.push(p[0], p[1], p[2], rnd() - 0.2); }
  }
  for (let k = 0; k < 30; k++) src.push(rnd(), rnd(), rnd(), rnd());
  src.push(0.2, 0.3, 0.1, 0.5); src.push(0.2, 0.3, 0.7, 0.25); src.push(0.9, 0.3, 0.7, 0.4); src.push(0.1, 0.3, 0.7, 0.3);
  const lo = [0, 0, 0], hi = [1, 1, 1];
  for (const q of [5, 9, 13]) {
    const plain = fitPoints(src, lo, hi, q), mom = new Float64Array(MOM_SIZE), kept = fitPoints(src, lo, hi, q, mom, 0);
    assert.equal(kept.n, plain.n);
    let top = 0, d = 0;
    for (let i = 0; i < 4 * plain.n; i++) { top = Math.max(top, Math.abs(plain.a[i])); d = Math.max(d, Math.abs(plain.a[i] - kept.a[i])); }
    assert.ok(d <= 1e-11 * top, `q ${q}: ${d} of ${top}`);
  }
  // a higher degree on top of kept lower ones
  const mom = new Float64Array(MOM_SIZE);
  fitPoints(src, lo, hi, 5, mom, 0);
  const up = fitPoints(src, lo, hi, 9, mom, 5), whole = fitPoints(src, lo, hi, 9);
  let d = 0, top = 0;
  for (let i = 0; i < 4 * whole.n; i++) { top = Math.max(top, Math.abs(whole.a[i])); d = Math.max(d, Math.abs(whole.a[i] - up.a[i])); }
  assert.ok(up.n === whole.n && d <= 1e-11 * top, `${d} of ${top}`);
});
