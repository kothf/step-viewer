/// <reference lib="webworker" />
// Import worker: runs OpenCASCADE (occt-import-js WASM) and the topology rebuild
// off the main thread, then hands typed arrays back as transferables.
import { analyzeMesh, convertTree, type PartData, type TreeNode } from "../topology";
import { facetFaces } from "../meshFaces";

/** A mesh file (STL, OBJ, 3MF) already parsed into triangle soups, one per object. */
export interface MeshRequest {
  kind: "mesh";
  name: string;
  meshes: { name: string; pos: Float32Array; idx: Uint32Array | null; color?: number[] }[];
}

export interface ImportRequest {
  kind?: "brep";
  buffer: ArrayBuffer;
  name: string;
  occtBase: string;
  quality: "draft" | "normal" | "fine";
}

const QUALITY = {
  draft: { linearDeflection: 0.002, angularDeflection: 0.5 },
  normal: { linearDeflection: 0.0008, angularDeflection: 0.25 },
  fine: { linearDeflection: 0.0002, angularDeflection: 0.12 },
};

let occtPromise: Promise<any> | null = null;

function loadOcct(base: string) {
  occtPromise ??= (async () => {
    const v = `?v=${__APP_VERSION__}`;
    const src = await (await fetch(base + "occt-import-js.js" + v)).text();
    // The emscripten loader is a classic script; evaluate it and take its factory.
    const factory = new Function(`${src}\n;return occtimportjs;`)();
    return factory({ locateFile: (f: string) => base + f + v });
  })();
  return occtPromise;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function finish(parts: PartData[], tree: TreeNode) {
  const transfer: Transferable[] = [];
  for (const p of parts) {
    transfer.push(p.positions.buffer, p.normals.buffer, p.index.buffer, p.edgeSegs.buffer);
    if (p.colors) transfer.push(p.colors.buffer);
  }
  post({ type: "done", parts, tree }, transfer);
}

function importMesh(r: MeshRequest) {
  const parts: PartData[] = [];
  const n = r.meshes.length;
  r.meshes.forEach((m, i) => {
    post({ type: "progress", text: "Finding faces {i}/{n}…", params: { i: i + 1, n }, pct: 20 + (75 * i) / n });
    const d = analyzeMesh(facetFaces(m.name, m.pos, m.idx, m.color));
    d.name = m.name;
    parts.push(d);
  });
  const tree: TreeNode = n === 1 ? { name: r.name, parts: [0], children: [] }
    : { name: r.name, parts: [], children: parts.map((p, i) => ({ name: p.name, parts: [i], children: [] })) };
  finish(parts, tree);
}

self.onmessage = async (e: MessageEvent<ImportRequest | MeshRequest>) => {
  if (e.data.kind === "mesh") {
    try { importMesh(e.data); } catch (err) { post({ type: "error", text: err instanceof Error ? err.message : String(err) }); }
    return;
  }
  const { buffer, name, occtBase, quality } = e.data;
  try {
    post({ type: "progress", text: "Loading geometry kernel…", pct: 5 });
    const occt = await loadOcct(occtBase);
    post({ type: "progress", text: "Parsing and tessellating B-rep…", pct: 20 });
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", ...QUALITY[quality] };
    const bytes = new Uint8Array(buffer);
    const res = ext === "igs" || ext === "iges" ? occt.ReadIgesFile(bytes, params)
      : ext === "brep" ? occt.ReadBrepFile(bytes, params)
      : occt.ReadStepFile(bytes, params);
    if (!res?.success) throw new Error("OpenCASCADE could not read this file.");

    const parts: PartData[] = [];
    const n = res.meshes.length;
    for (let i = 0; i < n; i++) {
      if (i % 4 === 0) post({ type: "progress", text: "Rebuilding topology {i}/{n}…", params: { i: i + 1, n }, pct: 40 + (55 * i) / n });
      parts.push(analyzeMesh(res.meshes[i]));
    }
    finish(parts, convertTree(res.root));
  } catch (err) {
    post({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
};
