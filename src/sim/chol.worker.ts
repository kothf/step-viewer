// A helper thread of the analysis worker (FR-SARC-005): takes part in the factorisations and loops it is handed over shared
// memory (threads.ts) and sleeps between them.
import { serve, type CholJob, type ParJob } from "./threads";
// the loops a helper can take part in are registered by the modules that own them
import "./static";
import "./thermal";

self.onmessage = (e: MessageEvent<CholJob | ParJob>) => { serve(e.data); };
(self as unknown as { postMessage(m: unknown): void }).postMessage({ ready: true });
