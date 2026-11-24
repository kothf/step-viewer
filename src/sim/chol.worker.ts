// A helper thread of the analysis worker (FR-SARC-005): takes part in the factorisations and loops it is handed over shared
// memory (threads.ts) and sleeps between them.
import { serve, type CholJob, type ParJob } from "./threads";
// the loops a helper can take part in are registered by the modules that own them
import "./static";
import "./thermal";

// Jobs come through a message port of the helper's own: Chrome hands a message posted to a worker's worker straight
// over only on a port; posted to the worker itself, it can wait until the busy parent is back in its event loop.
const run = (e: MessageEvent<CholJob | ParJob>) => { serve(e.data); };
self.onmessage = (e: MessageEvent<{ port?: MessagePort }>) => {
  const port = e.data.port;
  if (!port) return;
  port.onmessage = run;
  (self as unknown as { postMessage(m: unknown): void }).postMessage({ ready: true });
};
