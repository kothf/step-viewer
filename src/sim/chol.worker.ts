// A helper thread of the analysis worker (FR-SARC-005): takes part in the factorisations it is handed over shared
// memory (threads.ts) and sleeps between them.
import { serve, type CholJob } from "./threads";

self.onmessage = (e: MessageEvent<CholJob>) => { serve(e.data); };
(self as unknown as { postMessage(m: unknown): void }).postMessage({ ready: true });
