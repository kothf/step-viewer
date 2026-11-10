// Headless drawing rendering and version compare (FR-PDM-051): a .mcaddrw is opened in its own
// drawing kernel, every sheet composed to primitives as the workspace draws it, and two versions
// overlaid with what is only in the older one red and what is only in the newer one green.
import { factsCtx, useStyle, withCut, type AnnotCtx } from "./annot";
import { t } from "../i18n";
import { sheetBom, type Bom } from "./bom";
import { DrawingKernel } from "./client";
import { composeSheet } from "./compose";
import { unpackDrawing } from "./file";
import type { Prim } from "./prims";
import { sheetSize, type Fields } from "./sheet";
import type { DrawingDoc, Sheet } from "./types";
import { altReq, scaleText, viewConfig, viewReq } from "./views";

export interface SheetPrims { name: string; W: number; H: number; prims: Prim[] }

/** Title block fields from the drawing's own properties and source (no live part facts). */
function fieldsOf(doc: DrawingDoc, sheet: Sheet, mass: string): Fields {
  const p = doc.props, src = doc.source;
  const pd = src.kind === "part" ? src.doc : null;
  return {
    title: p.title || pd?.props.title || (src.kind === "asm" ? src.doc.name : "") || doc.name, number: p.number || pd?.props.partNumber || doc.name,
    revision: p.revision || pd?.props.revision || "", material: p.material || pd?.material?.name || "", mass: p.mass || mass,
    company: p.company || "", author: p.author || pd?.props.author || "", checked: p.checked || "", approved: p.approved || "", date: p.date || "",
    tcontrol: p.tcontrol || "", ncontrol: p.ncontrol || "", litera: p.litera || "",
    scale: scaleText(sheet.scale), sheet: `${doc.sheets.indexOf(sheet) + 1}/${doc.sheets.length}`,
    size: sheet.size === "custom" ? sheetSize(sheet).map(v => Math.round(v)).join("×") : sheet.size.replace("ANSI ", ""), units: "mm",
  };
}

/** Every sheet of a drawing file as primitives, with its views projected by a kernel of its own. */
export async function renderDrawing(bytes: Uint8Array, base = new URL("occt/", document.baseURI).href): Promise<SheetPrims[]> {
  const { doc, model } = await unpackDrawing(bytes.slice().buffer);
  const k = new DrawingKernel(base);
  try {
    const src = doc.source;
    const facts = await k.load(src.kind === "part" ? { part: src.doc } : src.kind === "asm" ? { asm: src.flat } : { file: { name: src.name, bytes: model! } });
    await Promise.all(doc.sheets.flatMap(sh => sh.views.map(v => k.request(viewReq(sh, v)))));
    await Promise.all(doc.sheets.flatMap(sh => sh.views.map(v => altReq(sh, v)).filter(r => !!r).map(r => k.alt(r!).catch(() => null))));
    const pd = src.kind === "part" ? src.doc : null;
    const kg = pd?.material ? facts.volume * pd.material.density * 1e-6 : null;
    const mass = kg != null ? `${kg < 10 ? kg.toFixed(3) : kg.toFixed(2)} kg` : "";
    const label = (s: string, p?: Record<string, string>) => t(s, p);
    const boms = new Map<string, Bom>();
    useStyle(doc.style);
    return doc.sheets.map(sh => {
      const [W, H] = sheetSize(sh);
      const ctx: AnnotCtx = {
        ...factsCtx(facts), dec: ".", label, bom: src.kind === "asm" ? sheetBom(sh, src.doc, src.flat, boms) : null, single: src.kind !== "asm" && !facts.cuts?.length,
        forView: v => { const c = viewConfig(sh, v), g = (c && k.configs.get(c)) || null, pr = k.cache.get(viewReq(sh, v).key); return pr?.cutEdges?.length ? factsCtx(withCut(g ?? facts, pr)) : g ? factsCtx(g) : null; },
      };
      return { name: sh.name, W, H, prims: composeSheet(sh, fieldsOf(doc, sh, mass), k.cache, facts.box, label, ctx).prims };
    });
  } finally { k.stop(); }
}

export { diffPrims, overlaySvg, DIFF_NEW, DIFF_OLD } from "./diff";
