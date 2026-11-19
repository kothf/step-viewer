// A coarse fingerprint of what a person sees: open dialogs, menus, toasts, the panel, the status hint, the view.
export const sig = pg => pg.evaluate(() => {
  const vis = e => e && e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden";
  const dlg = [...document.querySelectorAll("dialog[open]")].map(d => d.id || d.className);
  const toasts = [...document.querySelectorAll(".toast, #toasts > *")].filter(vis).map(t => t.textContent.trim().slice(0, 60));
  const menus = [...document.querySelectorAll(".mc-menu, [role=menu], #file-menu, #mc-menu")].filter(vis).map(m => m.id || m.className);
  return JSON.stringify({
    app: document.getElementById("app").className, dlg, toasts, menus,
    pm: (document.getElementById("mc-pm")?.textContent ?? "").slice(0, 80),
    hint: document.getElementById("st-hint")?.textContent ?? "",
    tool: document.querySelector("canvas")?.dataset.tool ?? "",
    pressed: [...document.querySelectorAll("[aria-pressed=true], .on, .active")].filter(vis).length,
    cam: window.__sv?.viewer?.camera?.position?.toArray().map(x => Math.round(x)).join(","),
  });
});
