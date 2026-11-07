// Lifecycle rules of a vault (FRS 12.5.4/12.5.5): revision schemes, the default workflow, data card fields and
// numbering patterns. Pure data and functions, stored in the vault settings and shared by the vault and its UI.

/** Revision scheme (FR-PDM-030). */
export interface RevScheme {
  kind: "letters" | "numbers" | "custom" | "eskd";
  /** Letters: skip I, O, Q, S, X, Z (ASME Y14.35). */
  skip?: boolean;
  /** Pre-release revisions before the first release: "-" (one dash), "0.1, 0.2 …" or "X1, X2 …". */
  pre?: "none" | "dash" | "decimal" | "x";
  /** Custom: the labels in order. */
  labels?: string[];
}

const SKIPPED = new Set(["I", "O", "Q", "S", "X", "Z"]);

/** The n-th (from 0) letter label: A … Z, AA, AB … (spreadsheet style). */
function letterLabel(n: number, skip: boolean) {
  const abc = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter(c => !skip || !SKIPPED.has(c));
  let s = "";
  n += 1;
  while (n > 0) { n -= 1; s = abc[n % abc.length] + s; n = Math.floor(n / abc.length); }
  return s;
}

/** ESKD production letters (D-11): experimental О, О1, О2, then series А, Б, В … */
const ESKD = ["О", "О1", "О2", "А", "Б", "В", "Г", "Д", "Е", "Ж", "И", "К", "Л", "М", "Н", "П", "Р", "С", "Т", "У", "Ф", "Х", "Ц", "Ш", "Э", "Ю", "Я"];

/** The release label with index n (0: the first release). */
export function revLabel(s: RevScheme, n: number): string {
  switch (s.kind) {
    case "numbers": return String(n + 1).padStart(2, "0");
    case "custom": { const l = (s.labels ?? []).filter(Boolean); return l[n] ?? `${l[l.length - 1] ?? "R"}.${n - l.length + 2}`; }
    case "eskd": return ESKD[n] ?? `Я${n - ESKD.length + 2}`;
    default: return letterLabel(n, !!s.skip);
  }
}

/** The pre-release label with index n (0: the first), or null when the scheme has none. */
export function preLabel(s: RevScheme, n: number): string | null {
  switch (s.pre) {
    case "dash": return "-";
    case "decimal": return `0.${n + 1}`;
    case "x": return `X${n + 1}`;
    default: return null;
  }
}

/** Index of a release label in the scheme (-1 when it is not one of its labels, e.g. a pre-release label). */
export function revIndex(s: RevScheme, label: string): number {
  for (let i = 0; i < 2000; i++) if (revLabel(s, i) === label) return i;
  return -1;
}

export interface WfState {
  name: string;
  color: string;
  /** Files in this state can be checked out (FR-PDM-032: Work in progress and Change pending). */
  checkout: boolean;
  /** Released state: what "latest released" resolves to. */
  released?: boolean;
  /** Not for new use: a warning when inserted. */
  obsolete?: boolean;
}

export type Role = "Designer" | "Checker" | "Approver" | "Admin";
export const ROLES: Role[] = ["Designer", "Checker", "Approver", "Admin"];

export interface WfTransition {
  name: string;
  from: string;
  to: string;
  /** "release": the latest version gets the next revision label; "pre": the next pre-release label (if the scheme has them and the file was never released). */
  revision?: "release" | "pre";
  /** Conditions (FR-PDM-033). */
  comment?: boolean;
  fields?: string[];
  /** Referenced files must be in a state with this flag ("released") before the transition. */
  refsReleased?: boolean;
  role?: Role;
}

export interface Workflow { name: string; initial: string; states: WfState[]; transitions: WfTransition[] }

export const WIP = "Work in progress", REVIEW = "In review", RELEASED = "Released", CHANGE = "Change pending", OBSOLETE = "Obsolete";

/** The default workflow (FR-PDM-031). */
export function defaultWorkflow(): Workflow {
  return {
    name: "Default",
    initial: WIP,
    states: [
      { name: WIP, color: "#3b82f6", checkout: true },
      { name: REVIEW, color: "#d97706", checkout: false },
      { name: RELEASED, color: "#16a34a", checkout: false, released: true },
      { name: CHANGE, color: "#9333ea", checkout: true },
      { name: OBSOLETE, color: "#6b7280", checkout: false, obsolete: true },
    ],
    transitions: [
      { name: "Submit for review", from: WIP, to: REVIEW, revision: "pre", role: "Designer" },
      { name: "Approve", from: REVIEW, to: RELEASED, revision: "release", refsReleased: true, role: "Approver" },
      { name: "Reject", from: REVIEW, to: WIP, comment: true, role: "Checker" },
      { name: "Change", from: RELEASED, to: CHANGE, role: "Designer" },
      { name: "Submit change", from: CHANGE, to: REVIEW, role: "Designer" },
      { name: "Make obsolete", from: RELEASED, to: OBSOLETE, comment: true, role: "Approver" },
    ],
  };
}

/** A data card field (FR-PDM-040). `prop` maps it to a document property both ways. */
export interface CardField {
  name: string;
  type: "text" | "number" | "date" | "list" | "checkbox" | "user";
  options?: string[];
  required?: boolean;
  default?: string;
  /** Document property: "partNumber", "description", "title", "author", "revision", or a custom property name. */
  prop?: string;
}

export const PART_NUMBER = "Part number";

/** Default data card, for every file kind ("*"). */
export function defaultCards(): Record<string, CardField[]> {
  return {
    "*": [
      { name: PART_NUMBER, type: "text", prop: "partNumber" },
      { name: "Description", type: "text", prop: "description" },
      { name: "Material", type: "text", prop: "Material" },
      { name: "Project", type: "text", prop: "Project" },
    ],
  };
}

/** Numbering scheme (FR-PDM-041). Tokens: {YYYY} {YY} {MM}, {000…} (the counter, zero-padded) and {Field} from the data card. */
export interface Numbering { pattern: string; onAdd: boolean }

export function formatNumber(pattern: string, counter: number, card: Record<string, string> = {}, now = new Date()) {
  return pattern.replace(/\{([^{}]+)\}/g, (_, tok: string) => {
    if (/^0+$/.test(tok)) return String(counter).padStart(tok.length, "0");
    if (tok === "YYYY") return String(now.getFullYear());
    if (tok === "YY") return String(now.getFullYear()).slice(2);
    if (tok === "MM") return String(now.getMonth() + 1).padStart(2, "0");
    const v = Object.entries(card).find(([k]) => k.toLowerCase() === tok.toLowerCase())?.[1];
    return (v ?? tok).trim().replace(/\s+/g, "-").toUpperCase();
  });
}
