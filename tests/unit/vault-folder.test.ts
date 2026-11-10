// Vault exam (FR-PDM-003/020/021): a vault made in a project folder takes the files already there in place;
// assemblies find their parts in subfolders by name, drawings find their model by document id; files added
// before the file they use are tied to it once it comes in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, Vault } from "../../src/pdm/vault";
import { zip } from "../../src/model/zip";

const part = (id: string) => zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "part" }) }, { name: "document.json", data: JSON.stringify({ kind: "part", id, name: id, props: {}, features: [] }) }]);
/** An assembly whose embedded parts name their files (no manifest references), as MöbiusCAD saves them. */
const asm = (id: string, files: string[]) => zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "assembly" }) }, { name: "document.json", data: JSON.stringify({ kind: "assembly", id, name: "Assembly1", parts: Object.fromEntries(files.map((f, i) => [`p${i}`, { file: f }])), components: files.map((_f, i) => ({ part: `p${i}` })) }) }]);
/** A drawing keeps a copy of its model, which carries the model's document id. */
const drawing = (src: { kind: string; name: string; id: string }) => zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "drawing" }) }, { name: "drawing.json", data: JSON.stringify({ kind: "drawing", sheets: [{}], source: { kind: src.kind, name: src.name, doc: { id: src.id } } }) }]);

test("vault: files already in the project folder go in where they are (vault exam B1/B3)", async () => {
  const root = memDir("Engine");
  // The project folder before the vault: parts/, drawings/ and the assembly at the top.
  const write = async (path: string, data: Uint8Array) => { const parts = path.split("/"); let d = root; for (const s of parts.slice(0, -1)) d = (await d.dir(s, true))!; await d.write(parts.at(-1)!, data); };
  await write("parts/wheel.mcadprt", await part("d_wheel"));
  await write("parts/shaft.mcadprt", await part("d_shaft"));
  await write("engine.mcadasm", await asm("a_engine", ["wheel.mcadprt", "shaft.mcadprt"]));
  await write("drawings/engine.mcaddrw", await drawing({ kind: "asm", name: "Assembly1", id: "a_engine" }));
  await write("drawings/wheel.mcaddrw", await drawing({ kind: "part", name: "wheel.mcadprt", id: "d_wheel" }));
  await write(".hidden/notes.txt", new TextEncoder().encode("x"));
  const v = await Vault.create(root, "Engine", "Andrey", "PC");
  const loose = await v.untracked();
  assert.deepEqual(loose, ["drawings/engine.mcaddrw", "drawings/wheel.mcaddrw", "engine.mcadasm", "parts/shaft.mcadprt", "parts/wheel.mcadprt"]);
  // Drawings first on purpose: their references are tied once the model comes in.
  await v.add("drawings/engine.mcaddrw", (await v.working("drawings/engine.mcaddrw"))!);
  await v.addInPlace(loose.filter(p => p !== "drawings/engine.mcaddrw"));
  assert.deepEqual(await v.untracked(), []);
  const files = await v.files();
  const byPath = (p: string) => files.find(f => f.path === p)!;
  assert.deepEqual(files.map(f => f.path).sort(), loose);
  // No copies at the top of the folder.
  assert.deepEqual((await root.list()).filter(e => e.kind === "file").map(e => e.name), ["engine.mcadasm"]);
  // The assembly finds its parts in parts/ by name; the drawings find their models by document id.
  const refs = (p: string) => (v.latest(byPath(p)).refs ?? []).map(r => files.find(f => f.id === r.id)?.path ?? "?").sort();
  assert.deepEqual(refs("engine.mcadasm"), ["parts/shaft.mcadprt", "parts/wheel.mcadprt"]);
  assert.deepEqual(refs("drawings/engine.mcaddrw"), ["engine.mcadasm"]);
  assert.deepEqual(refs("drawings/wheel.mcaddrw"), ["parts/wheel.mcadprt"]);
  // Where used: part → assembly → drawing, and the part's own drawing.
  const up = await v.whereUsed(byPath("parts/wheel.mcadprt").id);
  const flat = (ns: typeof up): string[] => ns.flatMap(n => [n.path, ...flat(n.children).map(c => `${n.path} > ${c}`)]);
  assert.deepEqual(flat(up).sort(), ["drawings/wheel.mcaddrw", "engine.mcadasm", "engine.mcadasm > drawings/engine.mcaddrw"]);
});
