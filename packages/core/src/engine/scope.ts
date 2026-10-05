import type { ContextUnit, Manifest, ScopeDimension, Task } from "../model/types.js";
import { SCOPE_DIMENSIONS } from "../model/types.js";
import { containsPhrase } from "./text.js";

/** The organizational coordinates of a task, after topology inference. */
export type TaskScope = Partial<Record<ScopeDimension, string>>;

export interface ScopeResolution {
  scope: TaskScope;
  /** Human-readable notes on how each coordinate was determined. */
  notes: string[];
  /** Phrase in the task text that identified the service, if any. It locates the task rather than describing it. */
  locator?: string;
}

const TASK_FIELD: Record<ScopeDimension, keyof Task> = {
  businessUnits: "businessUnit",
  domains: "domain",
  teams: "team",
  services: "service",
  repos: "repo",
  environments: "environment",
};

/**
 * Work out where in the organization a task sits. Explicit fields win; a named
 * service fills in its domain/team/repo from the topology; failing that we
 * look for a service name or alias in the task text.
 */
export function resolveTaskScope(task: Task, manifest: Manifest): ScopeResolution {
  const scope: TaskScope = {};
  const notes: string[] = [];
  let locator: string | undefined;
  for (const dim of SCOPE_DIMENSIONS) {
    const v = task[TASK_FIELD[dim]];
    if (typeof v === "string" && v) {
      scope[dim] = v;
      notes.push(`${dim}=${v} (given)`);
    }
  }

  const services = manifest.topology.services;
  if (!scope.services) {
    let best: { name: string; len: number; via: string } | undefined;
    for (const [name, info] of Object.entries(services)) {
      for (const candidate of [name, ...info.aliases]) {
        // longest match wins, so "payment gateway service" beats "payment"
        if (containsPhrase(task.description, candidate) && (!best || candidate.length > best.len)) {
          best = { name, len: candidate.length, via: candidate };
        }
      }
    }
    if (best) {
      scope.services = best.name;
      locator = best.via;
      notes.push(`services=${best.name} (inferred from "${best.via}" in task text)`);
    }
  }

  const svc = scope.services ? services[scope.services] : undefined;
  if (svc) {
    const fill = (dim: ScopeDimension, value: string | undefined) => {
      if (value && !scope[dim]) {
        scope[dim] = value;
        notes.push(`${dim}=${value} (from topology of ${scope.services})`);
      }
    };
    fill("domains", svc.domain);
    fill("teams", svc.team);
    fill("repos", svc.repo);
    fill("businessUnits", svc.businessUnit);
  }
  return { scope, notes, locator };
}

export type ScopeMatch =
  /** Unit is scoped to a dimension the task explicitly occupies, and they overlap. */
  | { kind: "match"; specificity: number; matchedOn: ScopeDimension[] }
  /** Unit has no scope constraints: org-wide. */
  | { kind: "global" }
  /** Unit is scoped to a dimension the task doesn't specify; it might apply. */
  | { kind: "unknown"; dims: ScopeDimension[] }
  /** Unit is scoped elsewhere. Excluded. */
  | { kind: "mismatch"; dim: ScopeDimension; wanted: string[]; got: string };

/**
 * Scope semantics: every dimension a unit constrains must be compatible with
 * the task. A unit scoped to services [payment-service] applies to a task on
 * payment-service, is unknown for a task with no service, and is excluded for
 * a task on ledger-service.
 */
export function matchScope(unit: ContextUnit, scope: TaskScope): ScopeMatch {
  const matchedOn: ScopeDimension[] = [];
  const unknown: ScopeDimension[] = [];
  for (const dim of SCOPE_DIMENSIONS) {
    const allowed = unit.scope[dim];
    if (!allowed?.length) continue;
    const actual = scope[dim];
    if (actual === undefined) unknown.push(dim);
    else if (allowed.includes(actual) || allowed.includes("*")) matchedOn.push(dim);
    else return { kind: "mismatch", dim, wanted: allowed, got: actual };
  }
  if (unknown.length) return { kind: "unknown", dims: unknown };
  if (matchedOn.length) return { kind: "match", specificity: matchedOn.length, matchedOn };
  return { kind: "global" };
}
