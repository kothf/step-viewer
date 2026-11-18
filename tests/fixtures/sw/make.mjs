// Builds the CAD app test fixtures from scratch, so no real (private) model
// is needed: a 40 x 30 x 20 mm block as a hand-written Parasolid X_T body,
// stored the way 2015+ files store sections, and an assembly placing
// it twice. Run: node tests/fixtures/sw/make.mjs
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** A block (sizes in metres, as Parasolid stores them) in the SCH_1300000_13006 text schema. */
function blockXt(lx, ly, lz) {
  const nodes = []; // [type, index, fields...]; a field is a number, a pointer {p}, a char {c} or a vector {v}
  let next = 1;
  const id = () => ++next; // index 1 is the body
  const P = [[0, 0, 0], [lx, 0, 0], [lx, ly, 0], [0, ly, 0], [0, 0, lz], [lx, 0, lz], [lx, ly, lz], [0, ly, lz]];
  // Faces: outward normal, corners anticlockwise around it.
  const F = [
    { n: [0, 0, -1], x: [1, 0, 0], c: [0, 3, 2, 1] }, { n: [0, 0, 1], x: [1, 0, 0], c: [4, 5, 6, 7] },
    { n: [0, -1, 0], x: [1, 0, 0], c: [0, 1, 5, 4] }, { n: [0, 1, 0], x: [1, 0, 0], c: [2, 3, 7, 6] },
    { n: [-1, 0, 0], x: [0, 1, 0], c: [0, 4, 7, 3] }, { n: [1, 0, 0], x: [0, 1, 0], c: [1, 2, 6, 5] },
  ];
  const body = 1, voidRegion = id(), solidRegion = id(), voidShell = id(), solidShell = id();
  const verts = P.map(() => id()), points = P.map(() => id());
  const faces = F.map(() => id()), loops = F.map(() => id()), planes = F.map(() => id());
  const fins = F.map(() => [id(), id(), id(), id()]);
  const edges = new Map(); // "a-b" (a < b) -> { idx, line, fins: [] }
  F.forEach((f, i) => f.c.forEach((a, k) => {
    const b = f.c[(k + 1) % 4], key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (!edges.has(key)) edges.set(key, { idx: id(), line: id(), a: Math.min(a, b), b: Math.max(a, b), fins: [] });
    edges.get(key).fins.push({ fin: fins[i][k], sense: a < b ? "+" : "-", end: b });
  }));
  const E = [...edges.values()];
  const max = next;
  const p = v => ({ p: v }), c = v => ({ c: v }), v = a => ({ v: a });
  const chain = (list, i) => [p(list[i + 1] ?? 0), p(list[i - 1] ?? 0)];
  // BODY
  nodes.push([12, body, max, p(0), p(0), p(0), p(0), p(0), p(0), 1000, 1e-8, p(0), p(0), p(0), 0, p(0), 1, 0, p(0),
    p(planes[0]), p(E[0].line), p(points[0]), p(voidRegion), p(E[0].idx), p(verts[0])]);
  // REGIONs: the infinite void first, then the solid.
  nodes.push([19, voidRegion, voidRegion, p(0), p(body), p(solidRegion), p(0), p(voidShell), c("V")]);
  nodes.push([19, solidRegion, solidRegion, p(0), p(body), p(0), p(voidRegion), p(solidShell), c("S")]);
  // SHELLs: the solid's faces have it behind them (normals point out), the void's in front.
  nodes.push([13, voidShell, voidShell, p(0), p(0), p(0), p(0), p(0), p(0), p(voidRegion), p(faces[0])]);
  nodes.push([13, solidShell, solidShell, p(0), p(0), p(0), p(faces[0]), p(0), p(0), p(solidRegion), p(0)]);
  F.forEach((f, i) => {
    nodes.push([14, faces[i], faces[i], p(0), 1e-8, ...chain(faces, i), p(loops[i]), p(solidShell), p(planes[i]), c("+"), p(0), p(0), ...chain(faces, i), p(voidShell)]);
    nodes.push([15, loops[i], loops[i], p(0), p(fins[i][0]), p(faces[i]), p(0)]);
    nodes.push([50, planes[i], planes[i], p(0), p(faces[i]), ...chain(planes, i), p(0), c("+"), v(P[f.c[0]]), v(f.n), v(f.x)]);
    f.c.forEach((a, k) => {
      const b = f.c[(k + 1) % 4], e = edges.get(a < b ? `${a}-${b}` : `${b}-${a}`);
      const other = e.fins.find(x => x.fin !== fins[i][k]);
      nodes.push([17, fins[i][k], p(0), p(loops[i]), p(fins[i][(k + 1) % 4]), p(fins[i][(k + 3) % 4]), p(verts[b]),
        p(other.fin), p(e.idx), p(0), p(0), c(a < b ? "+" : "-")]);
    });
  });
  E.forEach((e, i) => {
    const d = [0, 1, 2].map(k => P[e.b][k] - P[e.a][k]), len = Math.hypot(...d);
    nodes.push([16, e.idx, e.idx, p(0), 1e-8, p(e.fins[0].fin), p(E[i - 1]?.idx ?? 0), p(E[i + 1]?.idx ?? 0), p(e.line), p(0), p(0), p(body)]);
    nodes.push([30, e.line, e.line, p(0), p(e.idx), p(E[i + 1]?.line ?? 0), p(E[i - 1]?.line ?? 0), p(0), c("+"), v(P[e.a]), v(d.map(x => x / len))]);
  });
  P.forEach((pt, i) => {
    const fin = E.flatMap(e => e.fins).find(f => f.end === i).fin;
    nodes.push([18, verts[i], verts[i], p(0), p(fin), ...chain(verts, i).reverse(), p(points[i]), 1e-8, p(body)]);
    nodes.push([29, points[i], points[i], p(0), p(verts[i]), ...chain(points, i), v(pt)]);
  });
  const num = x => (Number.isInteger(x) ? String(x) : String(x));
  const field = f => typeof f === "number" ? `${num(f)} ` : "p" in f ? `${f.p} ` : "c" in f ? f.c : f.v.map(x => `${num(x)} `).join("");
  const version = ": TRANSMIT FILE created by modeller version 1300000";
  const schema = "SCH_1300000_13006";
  let s = `T${version.length} ${version}${schema.length} ${schema}0 `;
  for (const [type, ...fields] of nodes) s += `${type} ` + fields.map(field).join("");
  return Buffer.from(s + "1 0 ", "latin1");
}

/** A Parasolid stream as a CAD app stores it: chunk id, sizes, zlib data. */
function psStream(data) {
  const z = deflateSync(data);
  const head = Buffer.alloc(24);
  Buffer.from("231dd571da8148a2a85898b21b89ef99", "hex").copy(head, 0);
  head.writeUInt32LE(data.length, 16);
  head.writeUInt32LE(z.length, 20);
  return Buffer.concat([head, z]);
}

/** A CAD app 2015+ container: marker, header, nibble-swapped name, raw deflate. */
function container(sections) {
  const out = [];
  for (const [name, data] of sections) {
    const z = deflateRawSync(data), n = Buffer.from(name, "latin1").map(b => ((b >> 4) | (b << 4)) & 0xff);
    const h = Buffer.alloc(26);
    Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]).copy(h, 0);
    h.writeUInt32LE(z.length, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(n.length, 22);
    out.push(h, n, z);
  }
  return Buffer.concat(out);
}

const block = container([["Contents/Config-0-LocalBodies", psStream(blockXt(0.04, 0.03, 0.02))]]);
writeFileSync(here + "block.SLDPRT", block);

// Two blocks: one at the origin, one turned 90 degrees about Z and moved 100 mm along X.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<swSolidWorks xmlns="http://www.solidworks.com/sw2003/schema" swObjCount="6" swVersion="9000"><swHeader swObjCount="2">
<swFile id="3" swDocType="ASSEMBLY" swPath="C:\\Fixtures\\pair.SLDASM"/><swFile id="6" swDocType="PART" swPath="C:\\Fixtures\\block.SLDPRT"/></swHeader>
<swModelList swObjCount="2"><swModel id="5" swName="block" swConfigurationName="Default" swFileRef="6"/>
<swModel id="2" swName="pair" swConfigurationName="Default" swFileRef="3">
<swReference id="4" swName="block" swReferenceNumber="1" swSuppressed="NO" swHidden="NO" swModelRef="5" swConfigurationName="Default" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
<swReference id="7" swName="block" swReferenceNumber="2" swSuppressed="NO" swHidden="NO" swModelRef="5" swConfigurationName="Default" swTransform="0 1 0 0 -1 0 0 0 0 0 1 0 0.1 0 0 1"/>
<swReference id="8" swName="lid" swReferenceNumber="1" swSuppressed="NO" swHidden="NO" swModelRef="9" swConfigurationName="Default" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
</swModel><swModel id="9" swName="lid" swConfigurationName="Default" swFileRef="10"/></swModelList></swSolidWorks>`
  .replace('</swHeader>', '<swFile id="10" swDocType="PART" swPath="C:\\Fixtures\\lid.SLDPRT"/></swHeader>');
// A 1x1 PNG stands in for a CAD app's thumbnail (shown when no geometry can be read).
const chunk = (type, data) => {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
};
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 200, 200, 200, 255]))), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(here + "pair.SLDASM", container([["swXmlContents/COMPINSTANCETREE", Buffer.from(xml, "utf8")], ["PreviewPNG", png]]));
