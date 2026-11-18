// Tutorial panel (FR-HLP-003): the step list at the top of the right panel. It belongs to the part made by
// "Tutorial: bracket in 10 steps" and shows only while that part is the live document; the steps tick
// themselves from the document (tutorial.ts), so undo unticks them.

import { onLangChange, t } from "./i18n";
import type { PartDoc } from "./model/types";
import { TUTORIAL_STEPS, tutorialNext, tutorialProgress } from "./tutorial";
import { toast } from "./ui";

export interface TutorialHost {
  /** The live part document, or null when the live document is not a part. */
  doc(): PartDoc | null;
  /** Starts a new part with this name and returns its document id. */
  start(name: string): string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initTutorial(host: TutorialHost) {
  const el = document.getElementById("tutorial")!;
  let docId: string | null = null;
  let open = -1;        // step whose instructions are shown; -1 = the next one
  let shown = "";
  let cheered = false;
  let timer = 0;

  const render = (force = false) => {
    const doc = host.doc();
    if (!docId || !doc || doc.id !== docId) { el.hidden = true; shown = ""; return; }
    const done = tutorialProgress(doc), next = tutorialNext(done), n = done.filter(Boolean).length;
    const at = open >= 0 ? open : next;
    const key = `${done.map(d => (d ? 1 : 0)).join("")}|${at}`;
    if (!force && key === shown && !el.hidden) return;
    shown = key;
    el.hidden = false;
    el.innerHTML = `<div class="tut-h"><h2>${esc(t("Bracket in 10 steps"))}</h2><span class="tut-n" data-n="${n}">${esc(t("{n} of {m}", { n, m: done.length }))}</span>`
      + `<button type="button" class="icon tut-x" data-a="close" title="${esc(t("Close the tutorial"))}" aria-label="${esc(t("Close the tutorial"))}">✕</button></div>`
      + `<div class="tut-bar" aria-hidden="true"><i style="width:${(100 * n / done.length).toFixed(0)}%"></i></div>`
      + `<ol class="tut-steps">${TUTORIAL_STEPS.map((s, i) => `<li class="${done[i] ? "done" : ""}${i === next ? " cur" : ""}" data-i="${i}">`
        + `<button type="button" class="tut-step" aria-expanded="${i === at}" aria-label="${esc(`${t(s.title)}, ${done[i] ? t("done") : t("not done")}`)}"><span class="tut-mark" aria-hidden="true">${done[i] ? "✓" : i + 1}</span><span>${esc(t(s.title))}</span></button>`
        + (i === at ? `<p class="tut-how">${esc(t(s.how))}</p>` : "") + `</li>`).join("")}</ol>`
      + (next < 0 ? `<p class="tut-end">${esc(t("The bracket is finished. Save it, or make a drawing of it from File."))}</p>` : "");
    if (next < 0 && !cheered) { cheered = true; toast(t("Tutorial finished: the bracket is done.")); }
    if (next >= 0) cheered = false;
  };

  const stop = () => { docId = null; window.clearInterval(timer); timer = 0; el.hidden = true; shown = ""; };

  el.addEventListener("click", ev => {
    const target = ev.target as HTMLElement;
    if (target.closest("[data-a=close]")) { stop(); return; }
    const li = target.closest<HTMLElement>("li[data-i]");
    if (!li) return;
    const i = Number(li.dataset.i);
    open = open === i ? -1 : i;
    render(true);
  });
  onLangChange(() => render(true));

  const start = () => {
    docId = host.start(t("Bracket"));
    open = -1; cheered = false;
    if (!timer) timer = window.setInterval(() => render(), 400);
    render(true);
  };
  document.getElementById("empty-tut")?.addEventListener("click", start);
  return { start, stop, render, get docId() { return docId; } };
}
