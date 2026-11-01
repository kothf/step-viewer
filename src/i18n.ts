// Interface language (English / Russian).
//
// English text is the key: `t("Open file")` returns the Russian translation from
// `i18n.ru.ts` when Russian is on, and the English text otherwise. `{name}`
// placeholders are filled from the params; a translation with "a|b|c" forms is a
// plural picked by `params.n` (English: one|other, Russian: one|few|many).
//
// Static markup (index.html) and markup that code builds from fixed English strings
// are translated in the DOM: text nodes and the title / aria-label / placeholder
// attributes whose whole (trimmed) text is a dictionary key. A MutationObserver
// translates nodes as they are added, and switching the language walks the page
// again from the remembered English originals. Subtrees with translate="no" (file,
// part and layer file names) are left alone. Text that mixes in values is built with
// t() in code, and those views re-render through `onLangChange`.

import { RU } from "./i18n.ru";

export type Lang = "en" | "ru";
export const LANGS: Lang[] = ["en", "ru"];
const KEY = "sv:lang";

const DICT = new Map<string, string>(Object.entries(RU));

function initial(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "ru") return q;
  try { const s = localStorage.getItem(KEY); if (s === "en" || s === "ru") return s; } catch { /* private mode */ }
  return /^ru\b/i.test(navigator.language || "") ? "ru" : "en";
}

let current: Lang = initial();
const listeners: (() => void)[] = [];

export const lang = () => current;

function plural(forms: string[], n: number): string {
  if (current === "ru") {
    const a = Math.abs(n) % 100, b = a % 10;
    const i = !Number.isInteger(n) ? 1 : a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2;
    return forms[Math.min(i, forms.length - 1)];
  }
  return forms[n === 1 ? 0 : Math.min(1, forms.length - 1)];
}

/** Translates `en` into the current language and fills `{param}` placeholders. */
export function t(en: string, params?: Record<string, string | number>): string {
  let s = current === "ru" ? DICT.get(en) ?? en : en;
  if (params && typeof params.n === "number" && s.includes("|")) s = plural(s.split("|"), params.n);
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** True when the dictionary has `en` (used by the tests to spot gaps). */
export const hasKey = (en: string) => DICT.has(en);

// ---------- PCB layer labels ("Top copper", "Inner copper In1", "Drill (NPTH)") ----------

const SIDE_RU: Record<string, string> = { Top: "верх", Bottom: "низ", Inner: "внутр." };
const KIND_RU: Record<string, string> = { copper: "Медь", "solder mask": "Маска", silkscreen: "Шелкография", paste: "Паста" };
const WHOLE_RU: Record<string, string> = { Drill: "Сверловка", "Board outline": "Контур платы", Layer: "Слой", Copper: "Медь", "Solder mask": "Маска", Silkscreen: "Шелкография", Paste: "Паста" };
/** Layer labels come from load.ts in English; this puts them into the current language. */
export function layerLabel(label: string): string {
  if (current === "en") return label;
  const m = /^(Top|Bottom|Inner) (copper|solder mask|silkscreen|paste)(.*)$/.exec(label);
  if (m) return `${KIND_RU[m[2]]}, ${SIDE_RU[m[1]]}${m[3]}`;
  const d = /^(Drill|Board outline|Layer|Copper|Solder mask|Silkscreen|Paste)(.*)$/.exec(label);
  if (d) return WHOLE_RU[d[1]] + d[2];
  return label;
}

// ---------- DOM ----------

const ATTRS = ["title", "aria-label", "placeholder"];
type Memo = { src: string; out: string };
const textMemo = new WeakMap<Text, Memo>();
const attrMemo = new WeakMap<Element, Record<string, Memo>>();

/** The translation of `src` with its surrounding whitespace kept, or null if it is not a key. */
function translated(src: string): string | null {
  const key = src.trim();
  if (!key) return null;
  const ru = DICT.get(key);
  if (ru === undefined) return null;
  return current === "ru" ? src.replace(key, ru) : src;
}

function locText(n: Text) {
  const m = textMemo.get(n);
  const src = m && n.data === m.out ? m.src : n.data;
  const out = translated(src);
  if (out === null) { if (m) textMemo.delete(n); return; }
  textMemo.set(n, { src, out });
  if (n.data !== out) n.data = out;
}

function locAttrs(el: Element) {
  let memo = attrMemo.get(el);
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v === null) continue;
    const m = memo?.[a];
    const src = m && v === m.out ? m.src : v;
    const out = translated(src);
    if (out === null) { if (m) delete memo![a]; continue; }
    memo ??= {};
    memo[a] = { src, out };
    attrMemo.set(el, memo);
    if (v !== out) el.setAttribute(a, out);
  }
}

const SKIP = '[translate="no"], [data-no-i18n], script, style';
const skip = (el: Element | null) => !!el?.closest(SKIP);

/** Translates every text node and attribute under `root` (skipping translate="no"). */
export function localize(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { if (!skip(root.parentElement)) locText(root as Text); return; }
  if (!(root instanceof Element) || skip(root)) return;
  locAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) locText(n as Text);
    else locAttrs(n as Element);
  }
}

let observer: MutationObserver | null = null;
/** Translates the page now and keeps translating what code adds later. */
export function startI18n(root: HTMLElement = document.body) {
  document.documentElement.lang = current;
  localize(root);
  observer?.disconnect();
  observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === "attributes") { if (!skip(r.target as Element)) locAttrs(r.target as Element); continue; }
      r.addedNodes.forEach(n => localize(n));
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS });
}

/** Switches the interface language, remembers it and re-renders. */
export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  document.documentElement.lang = l;
  localize(document.body);
  for (const f of listeners) f();
}

/** Runs `fn` after every language switch (views that build text with t()). */
export function onLangChange(fn: () => void) { listeners.push(fn); }

/** Runs `fn` with the language temporarily set to `l` (the PDF report is always English: its fonts have no Cyrillic). */
export function withLang<T>(l: Lang, fn: () => T): T {
  const prev = current;
  current = l;
  try { return fn(); } finally { current = prev; }
}
