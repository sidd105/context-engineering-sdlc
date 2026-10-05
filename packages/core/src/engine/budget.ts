import type { ContextUnit } from "../model/types.js";
import type { Candidate, SelectedItem } from "./compiler.js";
import { estimateTokens, firstSentence } from "./text.js";

/** How much of a unit is rendered: the whole body, a one-line summary, or just a titled reference. */
export type Fidelity = "full" | "summary" | "reference";

const ITEM_OVERHEAD = 12; // tags, id, level marker in rendered output

export function renderText(u: ContextUnit, f: Fidelity): string {
  if (f === "reference") return u.title;
  if (f === "summary") return `${u.title}: ${u.summary ?? firstSentence(u.body)}`;
  return u.body ? `${u.title}\n${u.body}` : u.title;
}

export function costOf(u: ContextUnit, f: Fidelity): number {
  return estimateTokens(renderText(u, f)) + ITEM_OVERHEAD;
}

/**
 * Coverage-first, budget-monotone packing.
 *
 * 1. Seat:    walk candidates in priority order (pinned first, then score) and
 *             seat each at "reference" fidelity. Stop at the first one that
 *             doesn't fit, so the seated set is a prefix of the priority order.
 * 2. Upgrade: pinned seats to "summary"; then all seats to "summary"; then all
 *             to "full", each pass in priority order, while budget remains.
 *
 * Seating a prefix (rather than skipping items that don't fit) guarantees
 * monotonicity: raising the budget never removes a unit. Rationale for
 * reference-first: for an LLM, knowing a relevant rule *exists* (and its id,
 * so it can ask for it) beats the full text of a marginal one.
 * This is a greedy approximation of a multiple-choice knapsack; see docs/algorithm.md.
 */
export function packBudget(candidates: Candidate[], budget: number): { selected: SelectedItem[]; dropped: Candidate[]; used: number } {
  let used = 0;
  const seats: SelectedItem[] = [];
  let i = 0;
  for (; i < candidates.length; i++) {
    const c = candidates[i]!;
    const cost = costOf(c.unit, "reference");
    if (used + cost > budget) break;
    seats.push({ ...c, fidelity: "reference", tokens: cost });
    used += cost;
  }
  const dropped = candidates.slice(i);

  const upgrade = (target: Fidelity, which: (s: SelectedItem) => boolean) => {
    for (const s of seats) {
      if (!which(s) || rank(s.fidelity) >= rank(target)) continue;
      const cost = costOf(s.unit, target);
      if (used - s.tokens + cost <= budget) {
        used += cost - s.tokens;
        s.fidelity = target;
        s.tokens = cost;
      }
    }
  };
  upgrade("summary", (s) => s.pinned);
  upgrade("summary", () => true);
  upgrade("full", () => true);
  return { selected: seats, dropped, used };
}

function rank(f: Fidelity): number {
  return f === "reference" ? 0 : f === "summary" ? 1 : 2;
}
