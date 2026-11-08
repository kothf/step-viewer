// Transition actions (FR-PDM-036): releasing a drawing stores its PDF beside it, releasing a part or an assembly
// its STEP, named `<part number or name>_rev<revision>`; PDFs of versions that are not released carry a
// "Not released" watermark. STEP files carry the revision and part number (FR-PDM-034).
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { t } from "../i18n";
import { stampStepBytes } from "./stepStamp";
import { PART_NUMBER } from "./workflow";
import type { FileRec, Vault } from "./vault";

const occtBase = () => new URL("occt/", document.baseURI).href;
const base = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "");
const folderOf = (path: string) => (path.includes("/") ? `${path.split("/").slice(0, -1).join("/")}/` : "");
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim();

/** A drawing file's sheets as one PDF, optionally watermarked. */
export async function drawingPdf(bytes: Uint8Array, title: string, watermark?: string): Promise<Uint8Array> {
  const [{ renderDrawing }, { sheetsPdf }] = await Promise.all([import("../drawing/render"), import("../drawing/output")]);
  const sheets = await renderDrawing(bytes, occtBase());
  const font = await (await fetch(fontUrl)).arrayBuffer();
  return new Uint8Array(await (await sheetsPdf(sheets, font, title, watermark)).arrayBuffer());
}

/** A part's or an assembly's STEP, made in a geometry kernel of its own, stamped with the revision. */
export async function documentStep(path: string, bytes: Uint8Array, stamp: { revision?: string; number?: string; description?: string }): Promise<Uint8Array> {
  const { ModelKernel } = await import("../model/kernelClient");
  const k = new ModelKernel(occtBase());
  try {
    let out: Uint8Array, name: string;
    if (/\.mcadprt$/i.test(path)) {
      const { unpackPart } = await import("../model/file");
      const doc = await unpackPart(bytes.slice().buffer);
      const color = doc.color ?? [0.62, 0.66, 0.72];
      const r = await k.rebuild(doc, color);
      if (!r) throw new Error("The part could not be built.");
      name = doc.name;
      out = await k.step(name, color);
    } else {
      const [{ unpackAsm }, { flattenSubs }] = await Promise.all([import("../asm/file"), import("../asm/patterns")]);
      const doc = await unpackAsm(bytes.slice().buffer);
      name = doc.name;
      out = await k.assemblyStep(flattenSubs(doc));
    }
    return stampStepBytes(out, { name, ...stamp });
  } finally { k.stop(); }
}

/** What a release makes from a file, if anything: a PDF for drawings, a STEP for parts and assemblies. */
export const releaseOutputKind = (path: string): "pdf" | "step" | null => (/\.mcaddrw$/i.test(path) ? "pdf" : /\.mcad(prt|asm)$/i.test(path) ? "step" : null);

/**
 * Makes and stores the release outputs of files that are now in a released state. A file already there (an earlier
 * try) gets a new version. Returns the stored paths and the files that failed, with why.
 */
export async function releaseOutputs(v: Vault, ids: string[]): Promise<{ made: string[]; failed: { path: string; error: string }[] }> {
  const made: string[] = [], failed: { path: string; error: string }[] = [];
  const files = await v.files();
  for (const id of ids) {
    const f = files.find(x => x.id === id);
    if (!f || !v.stateOf(f.state).released) continue;
    const kind = releaseOutputKind(f.path);
    if (!kind) continue;
    const latest = v.latest(f);
    try {
      const bytes = await v.versionBytes(f.id, latest.n);
      const number = f.card?.[PART_NUMBER] || "";
      const name = `${safe(number || base(f.path))}${f.revision ? `_rev${safe(f.revision)}` : ""}.${kind}`;
      const out = kind === "pdf" ? await drawingPdf(bytes, number || base(f.path)) : await documentStep(f.path, bytes, { revision: f.revision, number: number || undefined, description: f.card?.Description || undefined });
      const path = folderOf(f.path) + name;
      await store(v, path, out, `Made on release of ${f.path}${f.revision ? ` (revision ${f.revision})` : ""}`);
      made.push(path);
    } catch (e) {
      failed.push({ path: f.path, error: (e as Error).message });
    }
  }
  return { made, failed };
}

async function store(v: Vault, path: string, data: Uint8Array, comment: string): Promise<FileRec> {
  const have = await v.byPath(path);
  if (!have) return v.add(path, data, comment);
  if (!v.stateOf(have.state).checkout) throw new Error(t("{path} is in a state that cannot be changed.", { path }));
  await v.checkOut(have.id);
  await v.saveWorking(have.id, data);
  await v.checkIn(have.id, comment);
  return have;
}
