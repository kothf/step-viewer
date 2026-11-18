// Command tooltip text (FR-UI-112), pure: the shortcut key from a title's trailing "(key)".
const KEY = /^(?:(?:Ctrl|Shift|Alt|Cmd)\+)*(?:[A-Z0-9]|F\d{1,2}|Esc|Enter|Tab|Space|Delete|Del|Home|End|[←→↑↓]|[+−-])$/;

/** Splits a title like "Line (L)" or "Selection filter: faces, edges, vertices (F5)" into description and key. */
export function splitTip(title: string): { text: string; key: string | null } {
  const m = /\s*\(([^()]{1,16})\)\s*$/.exec(title);
  if (m && KEY.test(m[1].trim())) return { text: title.slice(0, m.index).trim(), key: m[1].trim() };
  return { text: title.trim(), key: null };
}

/** The tooltip's parts for a button: label, key, description (left out when it only repeats the label), why disabled. */
export function tipParts(label: string, title: string, why: string | null): { label: string; key: string | null; text: string; why: string | null } {
  const { text, key } = splitTip(title);
  const same = !text || text.toLowerCase() === label.toLowerCase();
  return { label, key, text: same ? "" : text, why };
}
