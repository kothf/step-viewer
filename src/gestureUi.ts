// Mouse gestures (FR-UI-024): the radial guide and the settings dialog (the pure parts are in gestures.ts).
import { t } from "./i18n";
import { DEFAULT_GESTURES, GESTURE_CMDS, GESTURE_DIRS, gestureLabel, loadGestures, saveGestures, type GestureConfig, type GestureMode } from "./gestures";

/** The radial guide at a screen point; `set(slot)` lights a slot, `remove()` takes it away. */
export function gestureGuide(x: number, y: number, mode: GestureMode, c: GestureConfig) {
  const el = document.createElement("div");
  el.className = "mc-gesture";
  el.setAttribute("role", "presentation");
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const R = 74;
  const slots = c.n === 8 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 2, 4, 6];
  el.innerHTML = `<span class="mc-gesture-c" aria-hidden="true"></span>` + slots.map(s => {
    const id = c[mode][s];
    if (!id) return "";
    const a = (s * Math.PI) / 4;
    return `<span class="mc-gesture-i" data-gs="${s}" style="left:${Math.round(Math.sin(a) * R)}px;top:${Math.round(-Math.cos(a) * R)}px">${esc(t(gestureLabel(mode, id)))}</span>`;
  }).join("");
  document.body.appendChild(el);
  return {
    set(slot: number) { el.querySelectorAll<HTMLElement>("[data-gs]").forEach(i => i.classList.toggle("on", +i.dataset.gs! === slot)); },
    remove() { el.remove(); },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch]!);

/** The gesture settings dialog: on/off, 4 or 8, and the command of every slot per mode. `done` runs after a save. */
export function gestureDialog(done?: (c: GestureConfig) => void) {
  document.getElementById("gst-dlg")?.remove();
  const c = loadGestures();
  const dlg = document.createElement("dialog");
  dlg.id = "gst-dlg";
  dlg.className = "modal";
  dlg.setAttribute("aria-labelledby", "gst-title");
  const sel = (mode: GestureMode, s: number) => `<select data-gm="${mode}" data-gs="${s}" aria-label="${esc(t(mode === "part" ? "Part" : "Sketch") + ": " + t(GESTURE_DIRS[s]))}">`
    + GESTURE_CMDS[mode].map(([id, l]) => `<option value="${esc(id)}"${c[mode][s] === id ? " selected" : ""}>${esc(t(l))}</option>`).join("") + `</select>`;
  const rows = GESTURE_DIRS.map((d, s) => `<tr data-row="${s}"${c.n === 4 && s % 2 ? " hidden" : ""}><th scope="row">${esc(t(d))}</th><td>${sel("part", s)}</td><td>${sel("sketch", s)}</td></tr>`).join("");
  dlg.innerHTML = `<h3 id="gst-title">${esc(t("Mouse gestures"))}</h3>`
    + `<p class="muted">${esc(t("Right-drag in a part or a sketch and release in a direction to run its command. A right-click without a drag still opens the menu; pan with the middle button (Ctrl+middle in a sketch)."))}</p>`
    + `<label class="chk"><input type="checkbox" data-g="on"${c.on ? " checked" : ""} /> ${esc(t("Use mouse gestures"))}</label>`
    + `<label class="row">${esc(t("Directions"))} <select data-g="n"><option value="4"${c.n === 4 ? " selected" : ""}>4</option><option value="8"${c.n === 8 ? " selected" : ""}>8</option></select></label>`
    + `<table class="gst-t"><thead><tr><th scope="col">${esc(t("Direction"))}</th><th scope="col">${esc(t("Part"))}</th><th scope="col">${esc(t("Sketch"))}</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<div class="row end"><button class="btn" data-g="reset">${esc(t("Defaults"))}</button><button class="btn" data-g="cancel">${esc(t("Cancel"))}</button><button class="btn primary" data-g="ok">${esc(t("OK"))}</button></div>`;
  document.body.appendChild(dlg);
  const nSel = dlg.querySelector<HTMLSelectElement>('[data-g="n"]')!;
  nSel.addEventListener("change", () => dlg.querySelectorAll<HTMLElement>("[data-row]").forEach(r => { r.hidden = nSel.value === "4" && +r.dataset.row! % 2 === 1; }));
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector('[data-g="cancel"]')!.addEventListener("click", close);
  dlg.querySelector('[data-g="reset"]')!.addEventListener("click", () => {
    dlg.querySelectorAll<HTMLSelectElement>("select[data-gm]").forEach(s => { s.value = DEFAULT_GESTURES[s.dataset.gm as GestureMode][+s.dataset.gs!]; });
  });
  dlg.querySelector('[data-g="ok"]')!.addEventListener("click", () => {
    const out: GestureConfig = { on: dlg.querySelector<HTMLInputElement>('[data-g="on"]')!.checked, n: nSel.value === "8" ? 8 : 4, part: [...c.part], sketch: [...c.sketch] };
    dlg.querySelectorAll<HTMLSelectElement>("select[data-gm]").forEach(s => { out[s.dataset.gm as GestureMode][+s.dataset.gs!] = s.value; });
    saveGestures(out);
    close();
    done?.(out);
  });
  dlg.showModal();
  return dlg;
}
