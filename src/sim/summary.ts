/**
 * The summary card of a thermal study's results (FR-TRES-002): what the card over the view says, worked out from
 * the shown pass. Pure, so it can be tested without the page.
 */

export interface SummaryComp { name: string; min: number; max: number }

export interface SummaryInput {
  /** The part's name, used when the result has no components. */
  part: string;
  min: number; max: number;
  /** Heat put in (W) and what each sink takes away (W, negative = brought in); absent for a transient time or an envelope. */
  applied?: number;
  flows?: number[];
  /** Components with their temperatures (assemblies); fewer than 2 = the part's name. */
  comps?: SummaryComp[];
  /** Error estimates of the passes (% in the energy norm), as `PassResult.errors`. */
  errors?: (number | null)[];
  /** Parts over their temperature limits, and how many have limits at all. */
  over?: number;
  limited?: number;
  /** Electrolytic lives (h) of a board's parts. */
  lives?: { name: string; h: number }[];
}

export interface ThermalSummary {
  hot: { name: string; t: number };
  cold: { name: string; t: number };
  /** Heat in (W) and how far out of balance (%), null when nothing goes in or out. */
  balance: { put: number; off: number } | null;
  /** The error estimate (%) and whether it is a bound ("<") rather than an extrapolation ("≈"). */
  error: { v: number; bound: boolean } | null;
  over: number | null;
  /** The shortest electrolytic life, when a board's package gives lives. */
  life: { name: string; h: number } | null;
}

export function thermalSummary(s: SummaryInput): ThermalSummary {
  const comps = s.comps && s.comps.length > 1 ? s.comps : null;
  let hot = { name: s.part, t: s.max }, cold = { name: s.part, t: s.min };
  if (comps) {
    const h = comps.reduce((a, c) => (c.max > a.max ? c : a)), c = comps.reduce((a, x) => (x.min < a.min ? x : a));
    hot = { name: h.name, t: h.max };
    cold = { name: c.name, t: c.min };
  }
  let balance: ThermalSummary["balance"] = null;
  if (s.applied !== undefined && s.flows) {
    const out = s.flows.reduce((a, f) => a + f, 0), size = Math.max(Math.abs(s.applied), s.flows.reduce((a, f) => a + Math.abs(f), 0) / 2);
    if (size > 0) balance = { put: s.applied, off: (100 * Math.abs(out - s.applied)) / size };
  }
  const errs = s.errors ?? [], last = errs.at(-1), before = errs.length > 1 ? errs[errs.length - 2] : null;
  const error = last != null ? { v: last, bound: false } : before != null ? { v: before, bound: true } : null;
  const life = s.lives?.length ? s.lives.reduce((a, x) => (x.h < a.h ? x : a)) : null;
  return { hot, cold, balance, error, over: s.limited ? s.over ?? 0 : null, life };
}
