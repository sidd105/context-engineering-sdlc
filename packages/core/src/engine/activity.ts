import type { Activity, ActivityProfile, Layer, Task } from "../model/types.js";
import { ACTIVITIES } from "../model/types.js";
import { stem, tokenize } from "./text.js";

const w = (business: number, domain: number, architecture: number, code: number, operations: number): Record<Layer, number> => ({
  business,
  domain,
  architecture,
  code,
  operations,
});

/**
 * Built-in activity profiles: how much each layer matters for each SDLC activity.
 *
 * Reading a row: during `implementation`, code context is fully weighted (1.0),
 * domain is nearly as important (0.8), and business context is mostly
 * background (0.3). Organizations can override any of this in their manifest.
 */
export const DEFAULT_PROFILES: Record<Activity, ActivityProfile> = {
  discovery: {
    description: "Exploring a problem or opportunity before committing to a solution.",
    layerWeights: w(1.0, 0.8, 0.3, 0.1, 0.1),
    favoredKinds: ["goal", "metric", "constraint", "term", "workflow"],
    expects: [
      { layer: "business", kinds: ["goal", "metric"], why: "Discovery should be anchored to measurable business goals." },
      { layer: "domain", kinds: ["term", "workflow"], why: "Shared vocabulary avoids mis-scoped discovery." },
    ],
    cues: ["explore", "investigate", "opportunity", "why", "research", "discovery", "should we"],
  },
  requirements: {
    description: "Turning intent into requirements, user stories, acceptance criteria.",
    layerWeights: w(1.0, 1.0, 0.3, 0.1, 0.2),
    favoredKinds: ["business-rule", "policy", "domain-rule", "workflow", "term"],
    expects: [
      { layer: "business", kinds: ["business-rule", "policy"], why: "Requirements must respect business rules and policy." },
      { layer: "domain", kinds: ["domain-model", "workflow"], why: "Stories should use the domain model and lifecycle." },
    ],
    cues: ["requirement", "story", "acceptance", "criteria", "spec", "prd", "user can"],
  },
  architecture: {
    description: "Making or reviewing structural and technology decisions.",
    layerWeights: w(0.7, 0.8, 1.0, 0.2, 0.7),
    favoredKinds: ["principle", "decision", "boundary", "pattern", "quality-attribute", "constraint", "slo"],
    expects: [
      { layer: "architecture", kinds: ["principle", "decision"], why: "Decisions should cite principles and prior ADRs." },
      { layer: "business", kinds: ["constraint", "goal"], why: "Architecture trades off against business constraints." },
      { layer: "operations", kinds: ["slo", "security", "infrastructure"], why: "Operational constraints bound the design space." },
    ],
    cues: ["architecture", "design", "decide", "decision", "choose", "adr", "migrate", "split", "boundary", "scalab*", "evaluate"],
  },
  implementation: {
    description: "Writing or changing code.",
    layerWeights: w(0.3, 0.8, 0.6, 1.0, 0.4),
    favoredKinds: ["domain-model", "domain-rule", "pattern", "standard", "convention", "testing-rule", "example"],
    expects: [
      { layer: "domain", kinds: ["domain-model", "domain-rule"], why: "Code must implement the domain model correctly." },
      { layer: "code", kinds: ["convention", "standard"], why: "Changes should follow repository conventions." },
      { layer: "code", kinds: ["testing-rule"], why: "Every change needs to know what tests are required." },
    ],
    cues: ["add", "implement", "build", "create", "write", "refactor", "fix", "integrate", "endpoint", "feature", "support"],
  },
  testing: {
    description: "Designing or writing tests.",
    layerWeights: w(0.4, 0.9, 0.3, 1.0, 0.3),
    favoredKinds: ["testing-rule", "domain-rule", "business-rule", "workflow", "example"],
    expects: [
      { layer: "code", kinds: ["testing-rule"], why: "Test strategy and required coverage." },
      { layer: "domain", kinds: ["domain-rule", "workflow"], why: "Tests should exercise domain invariants and lifecycle." },
    ],
    cues: ["test", "coverage", "qa", "regression", "e2e", "contract test", "mutation"],
  },
  review: {
    description: "Reviewing a change for correctness and compliance.",
    layerWeights: w(0.5, 0.8, 0.7, 1.0, 0.6),
    favoredKinds: ["standard", "convention", "policy", "security", "domain-rule", "principle"],
    expects: [
      { layer: "code", kinds: ["standard", "convention"], why: "Reviews check against standards." },
      { layer: "operations", kinds: ["security"], why: "Reviews are the cheapest place to catch security issues." },
    ],
    cues: ["review", "pr", "pull request", "audit", "check", "approve"],
  },
  deployment: {
    description: "Releasing, configuring and rolling out changes.",
    layerWeights: w(0.3, 0.2, 0.5, 0.3, 1.0),
    favoredKinds: ["deployment-rule", "infrastructure", "security", "observability", "slo", "runbook"],
    expects: [
      { layer: "operations", kinds: ["deployment-rule"], why: "Rollout procedure and gates." },
      { layer: "operations", kinds: ["observability", "slo"], why: "Know how to tell if the rollout is healthy." },
    ],
    cues: ["deploy", "release", "rollout", "roll out", "ship", "pipeline", "canary", "config", "helm", "terraform"],
  },
  operations: {
    description: "Running, scaling and maintaining systems.",
    layerWeights: w(0.3, 0.3, 0.6, 0.3, 1.0),
    favoredKinds: ["observability", "slo", "runbook", "infrastructure", "security"],
    expects: [
      { layer: "operations", kinds: ["slo", "observability"], why: "Operational work is measured against SLOs." },
      { layer: "operations", kinds: ["runbook"], why: "Runbooks encode the safe way to operate." },
    ],
    cues: ["scale", "capacity", "monitor", "alert", "dashboard", "cost", "rotate", "upgrade", "maintenance"],
  },
  incident: {
    description: "Responding to a live incident.",
    layerWeights: w(0.5, 0.5, 0.4, 0.3, 1.0),
    favoredKinds: ["runbook", "slo", "observability", "business-rule", "policy"],
    expects: [
      { layer: "operations", kinds: ["runbook"], why: "Responders need the runbook first." },
      { layer: "business", kinds: ["policy"], why: "Customer-impact and communication policies apply." },
    ],
    cues: ["incident", "outage", "down", "sev", "page", "pager", "failing", "spike", "degraded", "rollback"],
  },
};

export function resolveProfiles(overrides: Partial<Record<Activity, Partial<ActivityProfile>>>): Record<Activity, ActivityProfile> {
  const out = {} as Record<Activity, ActivityProfile>;
  for (const a of ACTIVITIES) {
    const base = DEFAULT_PROFILES[a];
    const o = overrides[a] ?? {};
    out[a] = {
      ...base,
      ...o,
      layerWeights: { ...base.layerWeights, ...(o.layerWeights ?? {}) },
    };
  }
  return out;
}

export interface ActivityInference {
  activity: Activity;
  confidence: number;
  scores: Partial<Record<Activity, number>>;
}

/**
 * Infer the SDLC activity from a task description by matching cue words.
 * Deliberately simple and explainable; an LLM classifier can replace it
 * behind the same interface.
 */
export function inferActivity(task: Task, profiles: Record<Activity, ActivityProfile>): ActivityInference {
  if (task.activity) return { activity: task.activity, confidence: 1, scores: { [task.activity]: 1 } };
  const norm = (t: string) => tokenize(t).map(stem).join(" ");
  const text = ` ${norm(task.description)} `;
  const scores: Partial<Record<Activity, number>> = {};
  for (const a of ACTIVITIES) {
    let s = 0;
    for (const cue of profiles[a].cues) {
      // whole-word/phrase match; a trailing "*" makes it a prefix cue ("scalab*" matches "scalability")
      const prefix = cue.endsWith("*");
      const c = prefix ? tokenize(cue).join(" ") : norm(cue);
      if (text.includes(prefix ? ` ${c}` : ` ${c} `)) s += 1;
    }
    if (s > 0) scores[a] = s;
  }
  const ranked = Object.entries(scores).sort((x, y) => y[1] - x[1]);
  if (ranked.length === 0) return { activity: "implementation", confidence: 0, scores };
  const [best, bestScore] = ranked[0]!;
  const total = ranked.reduce((acc, [, v]) => acc + v, 0);
  return { activity: best as Activity, confidence: bestScore / total, scores };
}
