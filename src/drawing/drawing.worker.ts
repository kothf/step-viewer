/// <reference lib="webworker" />
// Drawing worker (FR-DRW-016): holds the drawing's model as an exact B-rep and
// projects views with OCCT's hidden-line removal. Parts are rebuilt from their
// document through the Modeller; STEP / IGES / BREP files are read as they are.
import { project, readShape, section, shapeInfo, topology, type V3, type ViewDir } from "../kernel/drawing";
import { Modeller } from "../kernel/model";
import type { PartDoc } from "../model/types";
import { modelItems } from "./items";

export type DrawingRequest =
  | { id: number; type: "init"; base: string; module: WebAssembly.Module }
  | { id: number; type: "load"; part?: PartDoc; file?: { name: string; bytes: Uint8Array } }
  | { id: number; type: "project"; view: ViewDir }
  | { id: number; type: "section"; view: ViewDir; p: V3 };

let oc: any = null;
let shape: any = null;
const post = (msg: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (e: MessageEvent<DrawingRequest>) => {
  const r = e.data;
  try {
    if (r.type === "init") {
      const factory = (await import(/* @vite-ignore */ `${r.base}opencascade.full.js?v=${__APP_VERSION__}`)).default;
      oc = await factory({
        print: () => {}, printErr: () => {},
        instantiateWasm: (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance) => void) => { WebAssembly.instantiate(r.module, imports).then(done); return {}; },
      });
      post({ id: r.id, ok: true });
    } else if (r.type === "load") {
      if (!oc) throw new Error("Kernel not started");
      let extra = {};
      if (r.part) {
        const res = new Modeller(oc).evaluate(r.part);
        if (!res.body) throw new Error("The part has no body yet.");
        shape = res.body.shape;
        let mi: ReturnType<typeof modelItems> = { items: [], holes: [] };
        try { mi = modelItems(r.part, res.frames, res.sketches); } catch { /* no model items */ }
        extra = { topo: topology(oc, shape, res.body.names), ...mi };
      } else if (r.file) { shape = readShape(oc, r.file.bytes, r.file.name); extra = { topo: topology(oc, shape), items: [], holes: [] }; }
      else throw new Error("Nothing to load");
      post({ id: r.id, ok: true, ...shapeInfo(oc, shape), ...extra });
    } else if (r.type === "project") {
      if (!shape) throw new Error("No model loaded");
      post({ id: r.id, ok: true, proj: project(oc, shape, r.view) });
    } else if (r.type === "section") {
      if (!shape) throw new Error("No model loaded");
      post({ id: r.id, ok: true, proj: section(oc, shape, r.view, r.p) });
    }
  } catch (err) {
    post({ id: r.id, ok: false, error: err instanceof Error ? err.message : typeof err === "number" ? `OpenCASCADE error ${err}` : String(err) });
  }
};
