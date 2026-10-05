import type { KnowledgeBase } from "../model/types.js";
import type { Candidate, ContextPackage } from "./compiler.js";
import { tokenize } from "./text.js";

export interface Gap {
  type: "missing-knowledge" | "unscoped-task" | "unknown-term" | "stale" | "conflict" | "dropped-must";
  message: string;
  suggestion: string;
}

/**
 * Inspect a compiled package and report what's likely missing or risky.
 * Gaps are the feedback loop that tells the organization where its context
 * model is thin.
 */
export function findGaps(pkg: ContextPackage, kb: KnowledgeBase, candidates: Candidate[], today?: string): Gap[] {
  const gaps: Gap[] = [];
  const where = pkg.scope.services ?? pkg.scope.domains ?? "this scope";

  // 1. Knowledge the activity profile expects but the package lacks.
  for (const exp of pkg.profile.expects) {
    const present = pkg.selected.some((s) => s.unit.layer === exp.layer && exp.kinds.includes(s.unit.kind));
    if (present) continue;
    const existsSomewhere = candidates.some((c) => c.unit.layer === exp.layer && exp.kinds.includes(c.unit.kind));
    gaps.push({
      type: "missing-knowledge",
      message: `No ${exp.layer} ${exp.kinds.join("/")} in the package. ${exp.why}`,
      suggestion: existsSomewhere
        ? `Matching units exist but scored too low; raise the budget, lower --min-score, or link them to related units.`
        : `Author a ${exp.layer}/${exp.kinds[0]} unit scoped to ${where}.`,
    });
  }

  // 2. Task scope ambiguity.
  if (!pkg.scope.services && !pkg.scope.domains) {
    const svcs = Object.keys(kb.manifest.topology.services);
    gaps.push({
      type: "unscoped-task",
      message: "Could not determine which service or domain this task affects; scoped rules were down-weighted.",
      suggestion: svcs.length ? `Pass --service (known: ${svcs.slice(0, 6).join(", ")}${svcs.length > 6 ? ", ..." : ""}).` : "Add a topology to context.yaml.",
    });
  }

  // 3. Acronyms / jargon in the task that the glossary doesn't define.
  const known = new Set<string>();
  for (const u of kb.units.values()) {
    if (u.kind !== "term") continue;
    for (const n of [u.title, ...(u.aliases ?? [])]) for (const t of tokenize(n)) known.add(t);
  }
  for (const s of Object.keys(kb.manifest.topology.services)) for (const t of tokenize(s)) known.add(t);
  const acronyms = new Set(pkg.task.description.match(/\b[A-Z][A-Z0-9]{1,6}s?\b/g) ?? []);
  for (const a of acronyms) {
    const base = a.replace(/s$/, "").toLowerCase();
    if (!known.has(base)) {
      gaps.push({
        type: "unknown-term",
        message: `"${a}" is not defined in the glossary.`,
        suggestion: `Add a domain/term unit for "${a.replace(/s$/, "")}" so humans and models share its meaning.`,
      });
    }
  }

  // 4. Stale units that made it into the package.
  const now = today ? Date.parse(today) : Date.now();
  const maxAge = kb.manifest.staleAfterDays * 86_400_000;
  for (const s of pkg.selected) {
    if (!s.unit.reviewed) continue;
    const age = now - Date.parse(s.unit.reviewed);
    if (age > maxAge) {
      gaps.push({
        type: "stale",
        message: `${s.unit.id} was last reviewed ${s.unit.reviewed} (> ${kb.manifest.staleAfterDays} days).`,
        suggestion: `Ask ${s.unit.owner ?? "its owner"} to confirm it is still accurate.`,
      });
    }
  }

  // 5. Conflicts and mandatory rules lost to budget.
  for (const { a, b } of pkg.conflicts) {
    gaps.push({
      type: "conflict",
      message: `${a} and ${b} are marked as conflicting and both apply.`,
      suggestion: `Resolve with an 'overrides' relation, or narrow one unit's scope.`,
    });
  }
  for (const e of pkg.excluded) {
    if (e.reason === "did not fit token budget" && e.unit.level === "must") {
      gaps.push({
        type: "dropped-must",
        message: `Mandatory rule ${e.unit.id} was dropped for budget.`,
        suggestion: "Increase --budget; the package may lead to non-compliant output.",
      });
    }
  }
  return gaps;
}
