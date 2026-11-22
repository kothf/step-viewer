// Reads a thermal package off the page's thread (FR-TPKG-011): the files in, the package out with its arrays transferred.
import { readPackage, type ThermalPackage } from "./package";
import { ThermalError } from "./vtu";

export interface ThermalRequest { id: number; files: [string, Uint8Array][]; name: string; field?: string }
export type ThermalReply =
  | { id: number; ok: true; pkg: ThermalPackage }
  | { id: number; ok: false; code: string; reason: string; params: Record<string, string | number> };

const post = (m: ThermalReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ThermalRequest>) => {
  const { id, files, name, field } = e.data;
  try {
    const pkg = await readPackage(new Map(files), name, { field });
    const m = pkg.mesh;
    const own = new Set<ArrayBufferLike>();
    for (const a of [m.pos, m.temp, m.tri, m.part, m.face, m.power, m.flux]) if (a) own.add(a.buffer);
    post({ id, ok: true, pkg }, [...own] as Transferable[]);
  } catch (err) {
    if (err instanceof ThermalError) post({ id, ok: false, code: err.code, reason: err.reason, params: err.params });
    else post({ id, ok: false, code: "E-TH-PKG", reason: "{err}", params: { err: err instanceof Error ? err.message : String(err) } });
  }
};
