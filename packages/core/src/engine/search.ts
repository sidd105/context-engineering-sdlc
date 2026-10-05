import type { ContextUnit, KnowledgeBase, Layer } from "../model/types.js";
import { buildQuery, unitTerms } from "./compiler.js";
import { Bm25Index } from "./text.js";

export interface SearchHit {
  unit: ContextUnit;
  score: number;
  matchedTerms: string[];
}

/**
 * Free-text search over the whole knowledge base, ignoring scope and activity.
 * Complements compileContext: the compiler decides what a task *needs*, search
 * lets a human or agent look for something the compiler didn't pick.
 */
export function searchUnits(
  kb: KnowledgeBase,
  text: string,
  opts: { layer?: Layer; kind?: string; limit?: number } = {},
): SearchHit[] {
  const units = [...kb.units.values()];
  const index = new Bm25Index(units.map((u) => [u.id, unitTerms(u)]));
  const query = buildQuery(text, units);
  return units
    .filter((u) => (!opts.layer || u.layer === opts.layer) && (!opts.kind || u.kind === opts.kind))
    .map((u) => {
      const r = index.score(u.id, query.weights);
      return { unit: u, score: query.hitTerms.has(u.id) ? r.score + 1 : r.score, matchedTerms: r.matched };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id))
    .slice(0, opts.limit ?? 10);
}
