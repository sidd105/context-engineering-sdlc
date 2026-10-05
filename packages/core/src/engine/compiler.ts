import type { Activity, ActivityProfile, ContextUnit, KnowledgeBase, Layer, Relations, Task } from "../model/types.js";
import { LAYERS } from "../model/types.js";
import { inferActivity, type ActivityInference } from "./activity.js";
import { packBudget, type Fidelity } from "./budget.js";
import { findGaps, type Gap } from "./gaps.js";
import { matchScope, resolveTaskScope, type ScopeMatch, type TaskScope } from "./scope.js";
import { Bm25Index, containsPhrase, terms } from "./text.js";

export interface CompileOptions {
  /** Token budget for the rendered context. */
  budget: number;
  /** Candidates scoring below this are dropped. 0..1. */
  minScore: number;
  /** Hops of graph expansion from directly relevant units. */
  expansionDepth: number;
  /** Reference date for staleness checks (ISO). Defaults to today. */
  today?: string;
}

export const DEFAULT_OPTIONS: CompileOptions = { budget: 4000, minScore: 0.12, expansionDepth: 2 };

/** Strength with which activation flows along each relation type. */
const EDGE_WEIGHTS: Record<keyof Relations, number> = {
  dependsOn: 0.7,
  refines: 0.5,
  overrides: 0.5,
  seeAlso: 0.3,
  conflictsWith: 0.4,
};

/** Query weight for words that only locate the task (e.g. the service name). */
const LOCATOR_WEIGHT = 0.3;

/** Lexical relevance at which an in-scope `must` rule is pinned regardless of layer weight. */
const PIN_LEXICAL = 0.4;

const LEVEL_FACTOR = { must: 1.15, should: 1.0, may: 0.85, info: 0.8 } as const;

export interface Signals {
  /** Normalised BM25 relevance to the task text, 0..1. */
  lexical: number;
  matchedTerms: string[];
  /** Activation received through the context graph, 0..1. */
  graph: number;
  /** Which unit (and via which relation) gave the strongest graph activation. */
  graphVia?: { from: string; relation: keyof Relations };
  /** Prior relevance from scope specificity and activity-favoured kinds, 0..1. */
  prior: number;
  /** Combined relevance (noisy-OR of the three signals). */
  relevance: number;
  layerWeight: number;
  scope: ScopeMatch;
  score: number;
}

export interface Candidate {
  unit: ContextUnit;
  signals: Signals;
  pinned: boolean;
  reasons: string[];
}

export interface SelectedItem extends Candidate {
  fidelity: Fidelity;
  tokens: number;
}

export interface Exclusion {
  unit: ContextUnit;
  reason: string;
  score?: number;
}

export interface ContextPackage {
  task: Task;
  activity: ActivityInference;
  profile: ActivityProfile;
  scope: TaskScope;
  scopeNotes: string[];
  queryTerms: { term: string; weight: number; via?: string }[];
  selected: SelectedItem[];
  excluded: Exclusion[];
  conflicts: { a: string; b: string }[];
  gaps: Gap[];
  budget: { limit: number; used: number };
  stats: { totalUnits: number; inScope: number; candidates: number; selected: number };
}

/**
 * Compile a task-specific context package from the knowledge base.
 *
 *   1. Locate:   infer the SDLC activity and the task's organizational scope.
 *   2. Filter:   drop units scoped elsewhere, restricted to other activities, or in zero-weight layers.
 *   3. Expand:   build a query from the task, expanded with glossary synonyms; if no scope
 *                was given, infer the domain from where the lexical evidence concentrates.
 *   4. Score:    lexical relevance (BM25) + graph activation + scope/activity prior, weighted by layer.
 *   5. Pin:      in-scope `must` rules with evidence of relevance, and pinned units, are always kept.
 *   6. Resolve:  apply `overrides`, surface `conflictsWith`.
 *   7. Pack:     fit into the token budget, degrading full -> summary -> reference.
 *   8. Diagnose: report gaps (expected-but-missing knowledge, stale units, ambiguity).
 */
export function compileContext(kb: KnowledgeBase, task: Task, opts: Partial<CompileOptions> = {}): ContextPackage {
  const o: CompileOptions = { ...DEFAULT_OPTIONS };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v;
  const activity = inferActivity(task, kb.profiles);
  const profile = kb.profiles[activity.activity];
  const { scope, notes: scopeNotes, locator } = resolveTaskScope(task, kb.manifest);
  const units = [...kb.units.values()];
  const excluded: Exclusion[] = [];

  const query = buildQuery(task.description, units, locator);
  const index = new Bm25Index(units.map((u) => [u.id, unitTerms(u)]));
  if (!scope.services && !scope.domains) {
    const inferred = inferDomainFromEvidence(units, index, query.weights);
    if (inferred) {
      scope.domains = inferred.domain;
      scopeNotes.push(`domains=${inferred.domain} (inferred: ${Math.round(inferred.share * 100)}% of lexical evidence)`);
    }
  }

  // 2. Filter -------------------------------------------------------------
  const inScope: { unit: ContextUnit; scope: ScopeMatch; layerWeight: number }[] = [];
  for (const unit of units) {
    const sm = matchScope(unit, scope);
    if (sm.kind === "mismatch") {
      excluded.push({ unit, reason: `scoped to ${sm.dim}=${sm.wanted.join("|")}, task is ${sm.got}` });
      continue;
    }
    if (unit.activities && !unit.activities.includes(activity.activity)) {
      excluded.push({ unit, reason: `only applies to ${unit.activities.join(", ")}` });
      continue;
    }
    const layerWeight = profile.layerWeights[unit.layer];
    if (layerWeight <= 0) {
      excluded.push({ unit, reason: `${unit.layer} layer is not used for ${activity.activity}` });
      continue;
    }
    inScope.push({ unit, scope: sm, layerWeight });
  }

  // 4. Score --------------------------------------------------------------
  const lexRaw = new Map<string, { score: number; matched: string[] }>();
  let maxLex = 0;
  for (const { unit } of inScope) {
    const r = index.score(unit.id, query.weights);
    lexRaw.set(unit.id, r);
    // glossary hits are set to 1 below; letting their (alias-inflated) raw scores
    // set the normaliser would compress every other unit's relevance
    if (!query.hitTerms.has(unit.id)) maxLex = Math.max(maxLex, r.score);
  }
  const lexical = new Map<string, number>();
  for (const [id, r] of lexRaw) lexical.set(id, maxLex > 0 ? Math.min(1, r.score / maxLex) : 0);
  // a glossary term named in the task is maximally relevant by definition
  for (const id of query.hitTerms) if (lexical.has(id)) lexical.set(id, 1);

  const inScopeIds = new Set(inScope.map((c) => c.unit.id));
  const graph = spreadActivation(kb, inScopeIds, lexical, o.expansionDepth);

  const candidates: Candidate[] = [];
  for (const { unit, scope: sm, layerWeight } of inScope) {
    const lex = lexical.get(unit.id) ?? 0;
    const g = graph.get(unit.id);
    const graphAct = g?.value ?? 0;
    const favored = profile.favoredKinds.includes(unit.kind);
    const specificity = sm.kind === "match" ? sm.specificity : 0;
    const prior = Math.min(0.5, (favored ? 0.15 : 0) + 0.1 * specificity);
    const relevance = 1 - (1 - lex) * (1 - graphAct) * (1 - prior);
    const scopeFactor = sm.kind === "unknown" ? 0.6 : 1;
    const score = layerWeight * relevance * scopeFactor * LEVEL_FACTOR[unit.level];
    // In-scope mandatory rules are pinned when their layer matters for this activity,
    // or when they are directly about the task even if their layer is down-weighted.
    const evidence = lex > 0 || graphAct > 0;
    const pinned = unit.pinned || (unit.level === "must" && sm.kind === "match" && evidence && (layerWeight >= 0.5 || lex >= PIN_LEXICAL));

    const signals: Signals = {
      lexical: lex,
      matchedTerms: lexRaw.get(unit.id)?.matched ?? [],
      graph: graphAct,
      graphVia: g?.via,
      prior,
      relevance,
      layerWeight,
      scope: sm,
      score,
    };
    candidates.push({ unit, signals, pinned, reasons: explain(unit, signals, pinned, favored, activity.activity) });
  }
  candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.signals.score - a.signals.score);

  // 5. Threshold + pin ----------------------------------------------------
  let chosen: Candidate[] = [];
  for (const c of candidates) {
    if (c.pinned || c.signals.score >= o.minScore) chosen.push(c);
    else excluded.push({ unit: c.unit, reason: `below relevance threshold (${c.signals.score.toFixed(2)} < ${o.minScore})`, score: c.signals.score });
  }

  // 6. Overrides and conflicts --------------------------------------------
  const chosenIds = new Set(chosen.map((c) => c.unit.id));
  const overridden = new Map<string, string>();
  for (const c of chosen) for (const t of c.unit.relations.overrides ?? []) if (chosenIds.has(t)) overridden.set(t, c.unit.id);
  chosen = chosen.filter((c) => {
    const by = overridden.get(c.unit.id);
    if (by) excluded.push({ unit: c.unit, reason: `overridden by ${by}`, score: c.signals.score });
    return !by;
  });
  const conflicts: { a: string; b: string }[] = [];
  const finalIds = new Set(chosen.map((c) => c.unit.id));
  for (const c of chosen) {
    for (const t of c.unit.relations.conflictsWith ?? []) {
      if (finalIds.has(t) && c.unit.id < t) conflicts.push({ a: c.unit.id, b: t });
    }
  }

  // 7. Pack -----------------------------------------------------------------
  const packed = packBudget(chosen, o.budget);
  excluded.push(...packed.dropped.map((c) => ({ unit: c.unit, reason: "did not fit token budget", score: c.signals.score })));
  const selected = sortForPresentation(packed.selected);

  const pkg: ContextPackage = {
    task,
    activity,
    profile,
    scope,
    scopeNotes,
    queryTerms: [...query.weights].map(([term, weight]) => ({ term, weight, via: query.via.get(term) })),
    selected,
    excluded,
    conflicts,
    gaps: [],
    budget: { limit: o.budget, used: packed.used },
    stats: { totalUnits: units.length, inScope: inScope.length, candidates: chosen.length, selected: selected.length },
  };

  // 8. Diagnose -------------------------------------------------------------
  pkg.gaps = findGaps(pkg, kb, candidates, o.today);
  return pkg;
}

/** Field-weighted term list for indexing: title and tags count more than body. */
export function unitTerms(u: ContextUnit): string[] {
  const title = terms(u.title);
  const tags = u.tags.flatMap(terms);
  const aliases = (u.aliases ?? []).flatMap(terms);
  return [...title, ...title, ...title, ...tags, ...tags, ...aliases, ...aliases, ...terms(u.summary ?? ""), ...terms(u.body)];
}

interface Query {
  weights: Map<string, number>;
  via: Map<string, string>;
  /** Glossary units whose name or alias appears in the task. */
  hitTerms: Set<string>;
}

/**
 * Turn the task text into weighted query terms, then expand it with the
 * organization's own vocabulary: if the task says "PSP" and the glossary
 * defines PSP as an alias of "payment provider", both get searched.
 */
export function buildQuery(description: string, units: ContextUnit[], locator?: string): Query {
  const weights = new Map<string, number>();
  const via = new Map<string, string>();
  const hitTerms = new Set<string>();
  for (const t of terms(description)) weights.set(t, 1);
  // "the payment service" tells us *where* the task is (already captured as scope), not *what* it is about
  for (const t of terms(locator ?? "")) {
    if (weights.has(t)) {
      weights.set(t, LOCATOR_WEIGHT);
      via.set(t, "scope locator");
    }
  }

  for (const u of units) {
    if (u.kind !== "term") continue;
    const names = [u.title, ...(u.aliases ?? [])];
    const hit = names.some((n) => containsPhrase(description, n));
    if (!hit) continue;
    hitTerms.add(u.id);
    for (const n of names) {
      for (const t of terms(n)) {
        if (!weights.has(t)) {
          weights.set(t, 0.6);
          via.set(t, u.id);
        }
      }
    }
  }
  return { weights, via, hitTerms };
}

/**
 * When a task names no service or domain, look at which domains the most
 * lexically relevant scoped units belong to. If one domain clearly dominates
 * the evidence, adopt it. This is what lets "Adyen auth rate dropping" land
 * in payments without the user saying so.
 */
function inferDomainFromEvidence(
  units: ContextUnit[],
  index: Bm25Index,
  query: Map<string, number>,
  topK = 8,
  minShare = 0.6,
): { domain: string; share: number } | undefined {
  const scored = units
    .filter((u) => u.scope.domains?.length)
    .map((u) => ({ u, s: index.score(u.id, query).score }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK);
  const votes = new Map<string, number>();
  let total = 0;
  for (const { u, s } of scored) {
    const ds = u.scope.domains!;
    for (const d of ds) votes.set(d, (votes.get(d) ?? 0) + s / ds.length);
    total += s;
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (!best || total === 0) return undefined;
  const share = best[1] / total;
  return share >= minShare ? { domain: best[0], share } : undefined;
}

/**
 * Spreading activation over the context graph. Directly relevant units
 * (lexical > 0) are seeds; activation flows along relations, decaying by
 * edge weight per hop. Edges are followed in both directions because a rule
 * that depends on a model makes the model relevant, and vice versa (weaker).
 */
function spreadActivation(
  kb: KnowledgeBase,
  allowed: Set<string>,
  seeds: Map<string, number>,
  depth: number,
): Map<string, { value: number; via: { from: string; relation: keyof Relations } }> {
  type Edge = { to: string; w: number; relation: keyof Relations };
  const adj = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => adj.set(from, [...(adj.get(from) ?? []), e]);
  for (const u of kb.units.values()) {
    for (const [rel, ids] of Object.entries(u.relations) as [keyof Relations, string[]][]) {
      for (const id of ids) {
        if (!kb.units.has(id)) continue;
        add(u.id, { to: id, w: EDGE_WEIGHTS[rel], relation: rel });
        add(id, { to: u.id, w: EDGE_WEIGHTS[rel] * 0.6, relation: rel }); // reverse edge, weaker
      }
    }
  }

  const result = new Map<string, { value: number; via: { from: string; relation: keyof Relations } }>();
  let frontier = new Map<string, number>([...seeds].filter(([id, v]) => v > 0.15 && allowed.has(id)));
  for (let hop = 0; hop < depth; hop++) {
    const next = new Map<string, number>();
    for (const [id, act] of frontier) {
      for (const e of adj.get(id) ?? []) {
        if (!allowed.has(e.to)) continue;
        const v = act * e.w;
        if (v <= (result.get(e.to)?.value ?? 0) || v < 0.05) continue;
        result.set(e.to, { value: v, via: { from: id, relation: e.relation } });
        next.set(e.to, Math.max(next.get(e.to) ?? 0, v));
      }
    }
    frontier = next;
  }
  return result;
}

function explain(u: ContextUnit, s: Signals, pinned: boolean, favored: boolean, activity: Activity): string[] {
  const r: string[] = [];
  if (pinned) r.push(u.pinned ? "pinned: always included when in scope" : `mandatory: '${u.level}' rule scoped to this ${describeMatch(s.scope)}`);
  if (s.lexical > 0) r.push(`matches task terms [${s.matchedTerms.join(", ")}] (lexical ${s.lexical.toFixed(2)})`);
  if (s.graphVia) r.push(`linked from ${s.graphVia.from} via ${s.graphVia.relation} (graph ${s.graph.toFixed(2)})`);
  if (s.scope.kind === "match") r.push(`scoped to this ${describeMatch(s.scope)}`);
  if (s.scope.kind === "unknown") r.push(`may apply: scoped by ${s.scope.dims.join(", ")} which the task doesn't specify (score x0.6)`);
  if (s.scope.kind === "global") r.push("organization-wide");
  if (favored) r.push(`'${u.kind}' is a favoured kind for ${activity}`);
  r.push(`${u.layer} layer weight ${s.layerWeight} for ${activity}`);
  return r;
}

function describeMatch(m: ScopeMatch): string {
  return m.kind === "match" ? m.matchedOn.join("+").replace(/s(\+|$)/g, "$1") : "";
}

function sortForPresentation(items: SelectedItem[]): SelectedItem[] {
  const order = (l: Layer) => LAYERS.indexOf(l);
  return [...items].sort((a, b) => order(a.unit.layer) - order(b.unit.layer) || b.signals.score - a.signals.score);
}
