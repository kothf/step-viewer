// The Parasolid reader: parasolid-core (from parasolid-kit) compiled to
// WebAssembly in native/parasolid-wasm. It takes an X_B/X_T transmit file and
// returns its B-rep as JSON (see PsModel in kernel/parasolid.ts).
import type { PsModel } from "../kernel/parasolid";

interface Exports {
  memory: WebAssembly.Memory;
  ps_alloc(len: number): number;
  ps_free(ptr: number, len: number): void;
  ps_parse(ptr: number, len: number): number;
  ps_result_len(): number;
}

export class ParasolidReader {
  private x: Exports;
  private constructor(x: Exports) { this.x = x; }

  static async create(source: WebAssembly.Module | BufferSource): Promise<ParasolidReader> {
    const inst = source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, {})
      : (await WebAssembly.instantiate(source, {})).instance;
    return new ParasolidReader(inst.exports as unknown as Exports);
  }

  parse(bytes: Uint8Array): PsModel {
    const x = this.x;
    const ptr = x.ps_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    let json: string;
    try {
      const out = x.ps_parse(ptr, bytes.length);
      json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, out, x.ps_result_len()));
    } finally {
      x.ps_free(ptr, bytes.length);
    }
    return JSON.parse(json) as PsModel;
  }
}
