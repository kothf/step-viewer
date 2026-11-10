/**
 * Touch long-press = context menu (FR-UI-091). A finger held still for `LONG_PRESS_MS` sends a
 * `contextmenu` event to the element under it, so every right-click menu also opens on a tablet.
 * The browser's own long-press `contextmenu` (Android) is swallowed, so a menu never opens twice.
 */
export const LONG_PRESS_MS = 550;
export const LONG_PRESS_PX = 10;

export interface Press { id: number; x: number; y: number; t: number }

/** What a pointer event does to a pending press: keep waiting, or drop it. Pure, for tests. */
export function pressAfter(p: Press | null, ev: { kind: "down" | "move" | "up"; id: number; x: number; y: number; t: number; touch: boolean }): Press | null {
  if (ev.kind === "down") return ev.touch && !p ? { id: ev.id, x: ev.x, y: ev.y, t: ev.t } : null; // a second finger ends it
  if (!p) return null;
  if (ev.kind === "up") return null;
  if (ev.id !== p.id) return p;
  return Math.hypot(ev.x - p.x, ev.y - p.y) > LONG_PRESS_PX ? null : p;
}

/** True once the press has been held long enough. */
export function pressDue(p: Press | null, now: number): boolean { return !!p && now - p.t >= LONG_PRESS_MS; }

/** True for the `contextmenu` event a long press made. */
export function isLongPress(e: Event): boolean { return (e as Event & { longPress?: boolean }).longPress === true; }

export function bindLongPress(win: Window = window) {
  let press: Press | null = null, timer = 0, lastTouch = -1e9, fired = -1e9;
  const down = new Set<number>();
  const set = (p: Press | null) => {
    if (p === press) return;
    press = p;
    clearTimeout(timer);
    if (p) timer = win.setTimeout(fire, LONG_PRESS_MS);
  };
  const fire = () => {
    const p = press;
    press = null;
    if (!p) return;
    fired = performance.now();
    const target = win.document.elementFromPoint(p.x, p.y);
    if (!target) return;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, view: win, clientX: p.x, clientY: p.y, button: 2, buttons: 0 });
    Object.defineProperty(ev, "longPress", { value: true });
    target.dispatchEvent(ev);
  };
  const on = (kind: "down" | "move" | "up") => (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    lastTouch = performance.now();
    if (kind === "down") down.add(e.pointerId);
    else if (kind === "up") down.delete(e.pointerId);
    const ev = { kind, id: e.pointerId, x: e.clientX, y: e.clientY, t: lastTouch, touch: true };
    // A finger that lands while others are down is a pan or zoom, never a press.
    set(kind === "down" && down.size > 1 ? null : pressAfter(press, ev));
  };
  win.addEventListener("pointerdown", on("down"), true);
  win.addEventListener("pointermove", on("move"), true);
  win.addEventListener("pointerup", on("up"), true);
  win.addEventListener("pointercancel", on("up"), true);
  // The browser's own long-press menu event: ours has been, or will be, sent.
  win.addEventListener("contextmenu", e => {
    if (isLongPress(e) || !e.isTrusted) return;
    const touch = (e as PointerEvent).pointerType === "touch" || performance.now() - lastTouch < 1500 && (e as PointerEvent).pointerType !== "mouse";
    if (touch) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // Lifting the finger after the menu opened must not click what is under it.
  win.addEventListener("click", e => {
    if (performance.now() - fired < 400 && (e as PointerEvent).pointerType === "touch") { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
