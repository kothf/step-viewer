// Helper kernel workers for parallel work (FR-ARC-016). WebAssembly runs one thread per instance,
// so the way to use more cores is more workers, each with its own OpenCASCADE instance (the
// compiled module is shared). An assembly build hands its distinct parts to these helpers while
// its own worker takes a share too. Helpers start on demand and stop after a while idle, so the
// memory each instance holds goes back.
import { takeWorker } from "./spare";

/** Helpers stop after this long without work. */
const IDLE_MS = 30_000;
/** A helper whose WASM heap grew past this is replaced before its next job. */
const RECYCLE_HEAP = 1024 ** 3;

/**
 * How many helper workers to run besides the caller's own worker. Measured: on 4 real cores 2 helpers
 * were best (3 slower); on a 4-core/8-thread i7 1–2 were best and 6 was 4–5 s slower, because every
 * OCCT instance competes at start-up and `hardwareConcurrency` counts hyperthreads. So: cores − 2 up to
 * 4 threads, a quarter of the threads above (at least 2), never more than 3; 1 on ≤ 4 GB devices.
 * `?workers=N` sets it; 0 turns parallel builds off.
 */
export function helperCount(): number {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("workers") : null;
  if (q != null && q !== "" && Number.isFinite(+q)) return Math.max(0, Math.min(16, Math.floor(+q)));
  const nav = typeof navigator !== "undefined" ? navigator as Navigator & { deviceMemory?: number } : null;
  const threads = nav?.hardwareConcurrency || 2;
  let n = threads <= 4 ? threads - 2 : Math.min(3, Math.max(2, Math.floor(threads / 4)));
  if (nav?.deviceMemory && nav.deviceMemory <= 4) n = Math.min(n, 1);
  return Math.max(0, n);
}

interface Helper { w: Worker; ready: Promise<void>; busy: boolean; heap: number; pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }> }

export class KernelPool {
  private helpers: Helper[] = [];
  private queue: { msg: Record<string, unknown>; resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private base: string, readonly size: number) {}

  /** Runs one kernel request on a free helper (queued while all are busy). Rejects if the helper fails. */
  run<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ msg, resolve, reject });
      this.pump();
    });
  }

  /**
   * Starts up to `n` helpers now: an instance takes seconds to set itself up, so they start
   * alongside the caller's own worker instead of after it.
   */
  warm(n: number) {
    while (this.helpers.length < Math.min(n, this.size)) this.spawn();
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.queue.length || this.helpers.some(x => x.busy) ? null : setTimeout(() => this.stop(), IDLE_MS);
  }

  /** Stops every helper; queued requests are rejected. */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const h of this.helpers) this.kill(h, "stopped");
    this.helpers = [];
    for (const q of this.queue.splice(0)) q.reject(new Error("stopped"));
  }

  private kill(h: Helper, why: string) {
    h.w.terminate();
    for (const p of h.pending.values()) p.reject(new Error(why));
    h.pending.clear();
    this.helpers = this.helpers.filter(x => x !== h);
  }

  private spawn(): Helper {
    const { w, ready } = takeWorker(this.base);
    const h: Helper = { w, ready, busy: false, heap: 0, pending: new Map() };
    w.onmessage = (e: MessageEvent) => {
      const d = e.data, p = h.pending.get(d.id);
      if (!p) return;
      h.pending.delete(d.id);
      if (typeof d.heap === "number") h.heap = d.heap;
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error));
    };
    w.onerror = e => this.kill(h, e.message || "The geometry kernel stopped");
    this.helpers.push(h);
    return h;
  }

  private send<T>(h: Helper, msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      h.pending.set(id, { resolve, reject });
      h.w.postMessage({ ...msg, id });
    });
  }

  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.queue.length) {
      let h = this.helpers.find(x => !x.busy);
      if (h && h.heap > RECYCLE_HEAP) { this.kill(h, "recycled"); h = undefined; }
      if (!h && this.helpers.length < this.size) h = this.spawn();
      if (!h) return;
      const job = this.queue.shift()!;
      const helper = h;
      helper.busy = true;
      helper.ready
        .then(() => this.send(helper, job.msg))
        .then(job.resolve, err => {
          job.reject(err);
          // A helper that failed to start or crashed is not used again.
          if (this.helpers.includes(helper) && !helper.pending.size) this.kill(helper, "failed");
        })
        .finally(() => { helper.busy = false; this.pump(); });
    }
    if (this.helpers.length && this.helpers.every(x => !x.busy)) this.timer = setTimeout(() => this.stop(), IDLE_MS);
  }
}

let pool: KernelPool | null = null;
/** The page's helper pool (null when there are no spare cores, or `?workers=0`). */
export function kernelPool(base: string): KernelPool | null {
  if (pool) return pool;
  const n = helperCount();
  return n ? (pool = new KernelPool(base, n)) : null;
}
