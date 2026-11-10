// A kernel worker started ahead of need. An OpenCASCADE instance takes 3–5 s to set itself up
// (the embind glue and static init of the 50 MB module), and a part, an assembly or a STEP
// file's exact pass each used to start their own when the document opened, so even a one-feature
// part took seconds to show. The page keeps one spare instance ready: whoever needs a worker
// takes it (its set-up already done or under way) and a new spare starts a little later, once the
// taker's worker is up.
import { compile } from "./client";
import KernelWorker from "./kernel.worker?worker";

/** The init request's id: callers number their own requests from 1, so its reply never reaches them. */
const INIT_ID = -1;
/** How long after the taken worker is ready the next spare starts (the taker's first job goes first). */
const REFILL_MS = 400;

export interface StartedWorker { w: Worker; ready: Promise<void> }

let spare: StartedWorker | null = null;
/** Whether the spare's set-up is done. */
let spareUp = false;
let refill: ReturnType<typeof setTimeout> | null = null;
let base = "";

/** Spares cost an idle OpenCASCADE heap; small devices and `?nospare` go without (each document starts its own). */
export function sparesOn(): boolean {
  if (typeof navigator === "undefined" || typeof location === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (new URLSearchParams(location.search).has("nospare")) return false;
  if (nav.connection?.saveData) return false;
  return !(nav.deviceMemory && nav.deviceMemory <= 4);
}

/** Starts a kernel worker: compiles the module (once per page) and sets OpenCASCADE up in it. */
function launch(b: string): StartedWorker {
  const w = new KernelWorker();
  const ready = new Promise<void>((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data?.id !== INIT_ID) return;
      w.removeEventListener("message", on);
      if (e.data.ok) resolve(); else reject(new Error(e.data.error));
    };
    w.addEventListener("message", on);
    w.addEventListener("error", e => reject(new Error(e.message || "The geometry kernel stopped")), { once: true });
    compile(b).then(module => w.postMessage({ type: "init", base: b, module, id: INIT_ID }), reject);
  });
  return { w, ready };
}

/** Starts the spare now (when there is none) so the first document finds it ready. */
export function warmSpare(b: string) {
  base = b;
  if (!sparesOn() || spare) return;
  const s = launch(b);
  spare = s;
  spareUp = false;
  s.ready.then(() => { if (spare === s) spareUp = true; }, () => {});
  // A spare that failed to start is dropped; the next taker starts its own.
  s.ready.catch(() => { if (spare === s) { spare = null; s.w.terminate(); } });
}

/**
 * A kernel worker for `b`: the spare when there is one, else a fresh one. The caller sets its own
 * `onmessage`/`onerror` and sends requests once `ready` resolves.
 */
export function takeWorker(b: string): StartedWorker {
  const s = spare && base === b ? spare : null;
  spare = null;
  spareUp = false;
  if (!sparesOn()) return s ?? launch(b);
  base = b;
  const got = s ?? launch(b);
  // Two set-ups at once would slow the taker's: the next spare starts once this one is up.
  const again = () => { if (refill) clearTimeout(refill); refill = setTimeout(() => { refill = null; warmSpare(b); }, REFILL_MS); };
  got.ready.then(again, again);
  return got;
}

/** A worker given back with a heap past this is stopped instead (WASM memory never shrinks). */
const REUSE_HEAP = 512 * 1024 ** 2;

/**
 * Takes back an idle worker whose document closed: it drops that document's state and becomes the
 * spare, so the next document needs no set-up at all. Stopped instead when a spare is already
 * waiting, spares are off, or its heap grew big. The caller must have no request in flight.
 */
export function giveBack(w: Worker, b: string, heap: number) {
  w.onmessage = null;
  w.onerror = null;
  if (!sparesOn() || (spare && spareUp) || b !== base || heap > REUSE_HEAP) { w.terminate(); return; }
  // A spare still setting itself up is slower than this one, which only has to drop its document.
  spare?.w.terminate();
  const ready = new Promise<void>((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data?.id !== INIT_ID) return;
      w.removeEventListener("message", on);
      if (e.data.ok && !(e.data.heap > REUSE_HEAP)) resolve(); else reject(new Error(e.data.error ?? "heap"));
    };
    w.addEventListener("message", on);
    w.addEventListener("error", e => reject(new Error(e.message || "The geometry kernel stopped")), { once: true });
    w.postMessage({ type: "reset", id: INIT_ID });
  });
  const s = { w, ready };
  spare = s;
  spareUp = false;
  ready.then(() => { if (spare === s) spareUp = true; }, () => {});
  if (refill) { clearTimeout(refill); refill = null; }
  ready.catch(() => { if (spare === s) spare = null; w.terminate(); });
}

/** Whether a spare is waiting (for tests). */
export function hasSpare() { return !!spare; }
