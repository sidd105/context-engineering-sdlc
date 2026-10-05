/**
 * Core schema for the organizational context layer.
 *
 * A "context unit" is the atom of organizational knowledge: one rule, one
 * policy, one domain concept, one ADR, one convention. Units live in layers,
 * are scoped to parts of the organization, and are linked into a graph.
 * The engine compiles a task-specific subset of units into a context package.
 */

export const LAYERS = ["business", "domain", "architecture", "code", "operations"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * What kind of knowledge a unit holds. Kinds are open-ended strings so packs
 * can introduce their own, but these are the ones the engine understands.
 */
export const KNOWN_KINDS = [
  // business
  "goal", "business-rule", "policy", "constraint", "metric",
  // domain
  "domain-model", "domain-rule", "term", "workflow", "event",
  // architecture
  "principle", "pattern", "decision", "boundary", "quality-attribute",
  // code
  "standard", "convention", "testing-rule", "practice", "example",
  // operations
  "deployment-rule", "infrastructure", "observability", "security", "runbook", "slo",
] as const;
export type Kind = (typeof KNOWN_KINDS)[number] | (string & {});

/** Normative strength, RFC 2119 style. `must` units are candidates for pinning. */
export type Level = "must" | "should" | "may" | "info";

/** SDLC activities. Each activity has a profile that weights layers differently. */
export const ACTIVITIES = [
  "discovery",
  "requirements",
  "architecture",
  "implementation",
  "testing",
  "review",
  "deployment",
  "operations",
  "incident",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** Organizational dimensions a unit can be scoped to. Empty or absent = applies everywhere. */
export const SCOPE_DIMENSIONS = ["businessUnits", "domains", "teams", "services", "repos", "environments"] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];
export type Scope = Partial<Record<ScopeDimension, string[]>>;

export interface Relations {
  /** Units that must be understood for this one to make sense. Pulled in by graph expansion. */
  dependsOn?: string[];
  /** Units this one specialises (e.g. a service rule refining an org rule). */
  refines?: string[];
  /** Units this one replaces when both apply. The overridden unit is dropped. */
  overrides?: string[];
  /** Units that contradict this one. Reported as conflicts if both are selected. */
  conflictsWith?: string[];
  /** Loosely related units. Weak expansion edge. */
  seeAlso?: string[];
}

export interface ContextUnit {
  id: string;
  layer: Layer;
  kind: Kind;
  title: string;
  /** Full text of the rule/concept. */
  body: string;
  /** Short form used when the budget is tight. Derived from body if absent. */
  summary?: string;
  level: Level;
  scope: Scope;
  tags: string[];
  /** For `term` units: synonyms used for query expansion. */
  aliases?: string[];
  /** Restrict to these activities. Absent = any activity. */
  activities?: Activity[];
  /** Always include when in scope, regardless of lexical relevance. */
  pinned?: boolean;
  relations: Relations;
  owner?: string;
  source?: string;
  /** ISO date the unit was last reviewed. Used for staleness warnings. */
  reviewed?: string;
  /** Which pack the unit came from. Set by the loader. */
  pack?: string;
  /** File the unit was loaded from. Set by the loader. */
  file?: string;
}

/** Service, team, repo topology. Lets a task that names only a service inherit its domain, team and repo. */
export interface ServiceInfo {
  domain: string;
  team?: string;
  repo?: string;
  businessUnit?: string;
  aliases: string[];
}

export interface Topology {
  services: Record<string, ServiceInfo>;
  environments: string[];
}

/** Layer weighting and expectations for one SDLC activity. */
export interface ActivityProfile {
  description: string;
  /** 0..1 multiplier per layer. 0 excludes the layer entirely. */
  layerWeights: Record<Layer, number>;
  /** Kinds that get a relevance boost for this activity. */
  favoredKinds: string[];
  /** Knowledge a good package for this activity should contain. Missing ones become gap suggestions. */
  expects: { layer: Layer; kinds: string[]; why: string }[];
  /** Words or phrases in a task description that suggest this activity. A trailing `*` matches as a prefix. */
  cues: string[];
}

export interface Manifest {
  organization: string;
  description?: string;
  /** Other packs (directories with their own manifest) to load before this one. */
  extends: string[];
  /** Glob-ish include patterns for unit files, relative to the manifest. */
  include: string[];
  topology: Topology;
  /** Per-organization overrides merged over the built-in activity profiles. */
  activities: Partial<Record<Activity, Partial<ActivityProfile>>>;
  /** Days after which a unit's `reviewed` date is considered stale. */
  staleAfterDays: number;
}

export interface KnowledgeBase {
  manifest: Manifest;
  units: Map<string, ContextUnit>;
  profiles: Record<Activity, ActivityProfile>;
  /** Non-fatal problems found while loading. */
  diagnostics: Diagnostic[];
  /** Absolute directories of every pack loaded (this one and everything it extends). */
  roots: string[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  unitId?: string;
  file?: string;
}

/** A unit of work someone wants context for. */
export interface Task {
  description: string;
  activity?: Activity;
  service?: string;
  domain?: string;
  team?: string;
  repo?: string;
  environment?: string;
  businessUnit?: string;
}
