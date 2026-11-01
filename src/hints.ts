// First-use tips: a short hint the first time a feature is reached (a model or board
// opens, a Smart result appears, a section plane is added...). Each tip shows once;
// "Turn off tips" stops them, and Help can reset or re-enable them.

import { t } from "./i18n";
import { storage } from "./ui";

const KEY = "sv:tips";
const SEEN = "sv:tips-seen";

export const HINTS = {
  model: "Tip: click a face, edge or hole to measure it; click a second one for the distance, pitch or angle between them. Right-drag pans, the wheel zooms.",
  live: "Tip: click a value in the result card to copy it. 📌 Pin keeps the result in the Measurements list; Esc clears it.",
  pair: "Tip: for two holes, switch between centre to centre, minimum and maximum in the result card.",
  section: "Tip: drag the arrow on the plane, or type an offset, to move the cut. The cut curves can be snapped to for measuring.",
  pcb: "Tip: click a pad, track or hole for its size; a second click gives pitch and clearance. Shift+click a shape for its area, 3 shows the board in 3D.",
  pcb3d: "Tip: in 3D, drag orbits and right-drag pans; measuring works on the side you look at. B turns the board over.",
  tree: "Tip: type size>50 or vol<1000 in the filter to find large or small parts. Double-click a part to zoom to it.",
} as const;
export type HintId = keyof typeof HINTS;

const seen = (): Set<string> => new Set((storage.get(SEEN) ?? "").split(",").filter(Boolean));
export const tipsOn = () => storage.get(KEY) !== "off";

let shown: HintId | null = null;

/** Shows tip `id` once (unless tips are off). */
export function hint(id: HintId) {
  if (!tipsOn() || seen().has(id)) return;
  const s = seen();
  s.add(id);
  storage.set(SEEN, [...s].join(","));
  show(id);
}

function show(id: HintId) {
  const el = document.querySelector<HTMLElement>("#hint");
  if (!el) return;
  shown = id;
  el.innerHTML = `<span class="hint-ico" aria-hidden="true">💡</span><span class="hint-txt"></span>
    <span class="hint-acts"><button class="btn small" data-h="ok"></button><button class="btn small ghost" data-h="off"></button></span>`;
  render();
  el.hidden = false;
  el.querySelector('[data-h="ok"]')!.addEventListener("click", hide);
  el.querySelector('[data-h="off"]')!.addEventListener("click", () => { setTips(false); hide(); });
}

function render() {
  const el = document.querySelector<HTMLElement>("#hint");
  if (!el || !shown) return;
  el.querySelector(".hint-txt")!.textContent = t(HINTS[shown]);
  el.querySelector('[data-h="ok"]')!.textContent = t("Got it");
  el.querySelector('[data-h="off"]')!.textContent = t("Turn off tips");
}

/** Closes the tip on screen. */
export function hide() {
  const el = document.querySelector<HTMLElement>("#hint");
  if (el) el.hidden = true;
  shown = null;
}

/** Re-renders the tip on screen in the current language. */
export const relocalizeHint = render;

/** Turns tips on (showing them all again from the start) or off. */
export function setTips(on: boolean) {
  storage.set(KEY, on ? "on" : "off");
  if (on) storage.set(SEEN, "");
}
