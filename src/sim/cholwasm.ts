// Structural and thermal analysis: the factorisation's inner loops in WebAssembly with SIMD (native/chol-kernel).
// A factor made here lives in a WebAssembly memory, so the kernel can work on it in place; JavaScript reads and
// writes the same numbers through a Float64Array over that memory. Where WebAssembly memory cannot be had, the
// factor is a plain array and blockchol.ts runs its own loops.

import { KERNEL_PLAIN, KERNEL_SHARED } from "./cholKernel.wasm";

/** The kernel's functions: places are counted in doubles from `d` (bytes). */
export interface CholKernel {
  update(d: number, mk: number, mi: number, mj: number, oi: number, oj: number, to: number, diag: number, a0: number): void;
  solve(d: number, mk: number, mi: number, dg: number, o: number): void;
  diag(d: number, m: number, o: number): number;
  fdiag(d: number, m: number, dg: number, y0: number): void;
  fblock(d: number, mk: number, mi: number, o: number, y0: number, yi: number): void;
  bblock(d: number, mk: number, mi: number, o: number, y0: number, yi: number): void;
  bdiag(d: number, m: number, dg: number, y0: number): void;
}

/** The factor starts one page into its memory: the first page is the module's own (its stack). */
const HEAD = 65536, PAGE = 65536;
const modules: { shared?: WebAssembly.Module; plain?: WebAssembly.Module } = {};
const kernels = new WeakMap<ArrayBufferLike, CholKernel>();
let lastBuffer: ArrayBufferLike | null = null, lastKernel: CholKernel | null = null;
let off = false, made = 0;

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function moduleOf(shared: boolean): WebAssembly.Module {
  return shared ? (modules.shared ??= new WebAssembly.Module(bytes(KERNEL_SHARED))) : (modules.plain ??= new WebAssembly.Module(bytes(KERNEL_PLAIN)));
}
function attach(mem: WebAssembly.Memory, shared: boolean): CholKernel {
  const hit = kernels.get(mem.buffer);
  if (hit) return hit;
  const k = new WebAssembly.Instance(moduleOf(shared), { env: { memory: mem } }).exports as unknown as CholKernel;
  kernels.set(mem.buffer, k);
  return k;
}

/** Turns the kernel off or on (tests compare it with the plain loops). */
export function setKernel(on: boolean) { off = !on; }
/** Factors given kernel memory so far on this thread (tests, debug). */
export const kernelMemories = () => made;

/**
 * Memory for a factor of n doubles that the kernel can work on, `shared` between threads or not, with room for
 * `extra` doubles after it (`scratchOf`); null when there is no such memory to be had here (the caller then uses
 * an ordinary array).
 */
export function kernelBuffer(n: number, shared: boolean, extra = 0): { data: Float64Array; mem: WebAssembly.Memory } | null {
  if (off || typeof WebAssembly === "undefined") return null;
  try {
    const pages = Math.ceil((HEAD + 8 * (n + extra)) / PAGE);
    // a memory handed back (`releaseBuffer`) that fits: a WebAssembly memory is only let go by the collector, some
    // time later, so the next factor takes the last one's place instead of standing beside it
    const at = spare.findIndex(f => f.shared === shared && f.pages >= pages && f.pages <= pages + Math.max(pages >> 1, 256));
    if (at >= 0) {
      const f = spare.splice(at, 1)[0], data = new Float64Array(f.mem.buffer, HEAD, n);
      new Float64Array(f.mem.buffer, HEAD, n + extra).fill(0);
      reused++;
      made++;
      return { data, mem: f.mem };
    }
    spare.length = 0;
    const mem = new WebAssembly.Memory(shared ? { initial: pages, maximum: pages, shared: true } : { initial: pages, maximum: pages });
    attach(mem, shared);
    memories.set(mem.buffer, mem);
    sizes.set(mem, { shared, pages });
    made++;
    return { data: new Float64Array(mem.buffer, HEAD, n), mem };
  } catch { return null; }
}
const memories = new WeakMap<ArrayBufferLike, WebAssembly.Memory>();
const sizes = new WeakMap<WebAssembly.Memory, { shared: boolean; pages: number }>();
/** Memories handed back and not taken again yet (at most `SPARE`; a request none fits lets them all go). */
const spare: { mem: WebAssembly.Memory; shared: boolean; pages: number }[] = [];
const SPARE = 2;
let reused = 0;
/** Factors that took a memory handed back (tests, debug). */
export const reusedMemories = () => reused;
/**
 * Hands a factor's memory back for the next `kernelBuffer` that fits it. Only for a factor nothing uses any
 * more: the next taker zeroes and overwrites it. An ordinary array is ignored.
 */
export function releaseBuffer(data: Float64Array) {
  const mem = memories.get(data.buffer), size = mem && sizes.get(mem);
  if (!mem || !size || spare.some(f => f.mem === mem)) return;
  spare.push({ mem, ...size });
  if (spare.length > SPARE) spare.shift();
}
/** The memory a factor made by `kernelBuffer` lives in (to hand to another thread), if any. */
export const memoryOf = (data: Float64Array): WebAssembly.Memory | undefined => memories.get(data.buffer);
/** Another thread's side: the factor of n doubles in a shared memory it was handed. */
export function adoptMemory(mem: WebAssembly.Memory, n: number): Float64Array {
  attach(mem, true);
  return new Float64Array(mem.buffer, HEAD, n);
}

/** The kernel working on the memory `data` lies in, or null for an ordinary array. */
export function kernelOf(data: Float64Array): CholKernel | null {
  const b = data.buffer;
  if (b === lastBuffer) return lastKernel;
  lastBuffer = b;
  return (lastKernel = kernels.get(b) ?? null);
}
/** The `n` doubles after a factor made with that much room to spare, or null. */
export function scratchOf(data: Float64Array, n: number): Float64Array | null {
  const at = data.byteOffset + 8 * data.length;
  return kernels.has(data.buffer) && at + 8 * n <= data.buffer.byteLength ? new Float64Array(data.buffer, at, n) : null;
}
