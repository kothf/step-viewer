// A helper of the solver's worker (`parPool.ts`): answers `par.ts` messages, one at a time.
import { parHandle, parState, type ParMsg } from "./par";

const S = parState();
self.onmessage = (e: MessageEvent<{ id: number; msg: ParMsg }>) => {
  try {
    const r = parHandle(S, e.data.msg);
    (self as DedicatedWorkerGlobalScope).postMessage({ id: e.data.id, reply: r.reply }, r.transfer);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: e.data.id, error: err instanceof Error ? err.message : String(err) });
  }
};
