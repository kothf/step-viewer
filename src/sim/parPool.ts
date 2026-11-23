// The solver worker's helpers in the browser: `helperCount()` workers started on the first use and kept
// until the solver's worker ends (the page ends it to cancel a solve, and its helpers go with it).
import ParWorker from "./par.worker?worker";
import type { ParMsg, ParPool } from "./par";

/** Helpers for this device: its threads less two (the page and the solver), at most 8; 0 = cut the cells in the solver itself. */
export function helperCount(threads = (globalThis.navigator?.hardwareConcurrency ?? 1)): number {
  return threads < 3 ? 0 : Math.min(8, threads - 2);
}

let pool: ParPool | null = null;
export function parPool(size = helperCount()): ParPool | null {
  if (size < 2 || typeof Worker === "undefined") return null;
  if (pool) return pool;
  const ws = Array.from({ length: size }, () => new ParWorker());
  let seq = 0;
  const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  for (const w of ws) {
    w.onmessage = (e: MessageEvent<{ id: number; reply?: unknown; error?: string }>) => {
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error !== undefined) p?.rej(new Error(e.data.error)); else p?.res(e.data.reply);
    };
    w.onerror = () => { for (const p of waiting.values()) p.rej(new Error("helper failed")); waiting.clear(); };
  }
  const ask = (w: Worker, msg: ParMsg) => new Promise<unknown>((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); w.postMessage({ id, msg }); });
  pool = {
    size,
    all: async msg => { await Promise.all(ws.map(w => ask(w, msg))); },
    map: jobs => {
      const out = new Array<unknown>(jobs.length);
      let next = 0;
      const run = async (w: Worker) => { while (next < jobs.length) { const i = next++; out[i] = await ask(w, jobs[i]); } };
      return Promise.all(ws.map(run)).then(() => out);
    },
  };
  return pool;
}
