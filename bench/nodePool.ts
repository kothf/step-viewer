// A `ParPool` of node worker threads for benches: the bench's own bundle is started again in each thread
// (`helperThread()` at the top of the bench answers the messages there and the bench's main part is skipped).
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { parHandle, parState, type ParMsg, type ParPool } from "../src/sim/par";

/** In a helper thread: answer the pool's messages and return true (the bench must then do nothing else). */
export function helperThread(): boolean {
  if (isMainThread) return false;
  const S = parState();
  parentPort!.on("message", (m: { id: number; msg: ParMsg }) => { const r = parHandle(S, m.msg); parentPort!.postMessage({ id: m.id, reply: r.reply }, r.transfer); });
  return true;
}

export function nodePool(size: number, file: string): ParPool & { close(): void } {
  const ws = Array.from({ length: size }, () => new Worker(file));
  let seq = 0;
  const waiting = new Map<number, (v: unknown) => void>();
  for (const w of ws) w.on("message", (m: { id: number; reply: unknown }) => { waiting.get(m.id)?.(m.reply); waiting.delete(m.id); });
  const ask = (w: Worker, msg: ParMsg) => new Promise<unknown>(res => { const id = ++seq; waiting.set(id, res); w.postMessage({ id, msg }); });
  return {
    size,
    all: async msg => { await Promise.all(ws.map(w => ask(w, msg))); },
    map: jobs => {
      const out = new Array<unknown>(jobs.length);
      let next = 0;
      const run = async (w: Worker) => { while (next < jobs.length) { const i = next++; out[i] = await ask(w, jobs[i]); } };
      return Promise.all(ws.map(run)).then(() => out);
    },
    close: () => { for (const w of ws) void w.terminate(); },
  };
}
