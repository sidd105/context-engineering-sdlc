import { describe, expect, it } from "vitest";
import {
  compileContext,
  inferActivity,
  loadKnowledgeBase,
  matchScope,
  packBudget,
  renderMarkdown,
  renderXml,
  resolveTaskScope,
  validateUnit,
  type ContextUnit,
  type KnowledgeBase,
} from "../src/index.js";
import { DEFAULT_PROFILES } from "../src/engine/activity.js";
import { stem } from "../src/engine/text.js";

const kb = loadKnowledgeBase("knowledge/monty-python-co");
const ids = (pkg: ReturnType<typeof compileContext>) => pkg.selected.map((s) => s.unit.id);

function unit(partial: Partial<ContextUnit> & { id: string }): ContextUnit {
  return { layer: "domain", kind: "domain-rule", title: partial.id, body: "", level: "should", scope: {}, tags: [], relations: {}, ...partial };
}

describe("loader", () => {
  it("loads the example organization and the pack it extends without errors", () => {
    expect(kb.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(kb.units.has("dom.payments.provider-abstraction")).toBe(true);
    expect(kb.units.get("baseline.sec.no-secrets-in-code")?.pack).toBe("secure-sdlc-baseline");
  });

  it("applies per-file defaults", () => {
    const u = kb.units.get("dom.payments.idempotency")!;
    expect(u.layer).toBe("domain");
    expect(u.scope.domains).toEqual(["payments"]);
    expect(u.owner).toBe("payments-core");
  });
});

describe("validateUnit", () => {
  it("rejects units without id, layer or title", () => {
    expect(validateUnit({ layer: "domain", title: "x" }).unit).toBeNull();
    expect(validateUnit({ id: "a", layer: "nope", title: "x" }).unit).toBeNull();
    expect(validateUnit({ id: "a", layer: "code" }).unit).toBeNull();
  });

  it("defaults level and warns on unknown kinds", () => {
    const { unit, problems } = validateUnit({ id: "a.b", layer: "code", title: "T", body: "B", kind: "vibes" });
    expect(unit?.level).toBe("should");
    expect(problems.some((p) => p.message.includes("Unknown kind"))).toBe(true);
  });
});

describe("text", () => {
  it("stems inflections to the same form", () => {
    expect(stem("providers")).toBe(stem("provider"));
    expect(stem("captured")).toBe(stem("capture"));
    expect(stem("policies")).toBe(stem("policy"));
    expect(stem("synchronous")).toBe("synchronous");
  });
});

describe("scope", () => {
  it("infers the service from text and fills domain/team/repo from topology", () => {
    const { scope } = resolveTaskScope({ description: "Add retries to the payments api" }, kb.manifest);
    expect(scope).toMatchObject({ services: "payment-service", domains: "payments", teams: "payments-core", repos: "monty-python-co/payment-service" });
  });

  it("classifies unit scope as match / global / unknown / mismatch", () => {
    const u = unit({ id: "x", scope: { services: ["payment-service"] } });
    expect(matchScope(u, { services: "payment-service" }).kind).toBe("match");
    expect(matchScope(u, {}).kind).toBe("unknown");
    expect(matchScope(u, { services: "ledger-service" }).kind).toBe("mismatch");
    expect(matchScope(unit({ id: "y" }), { services: "ledger-service" }).kind).toBe("global");
  });
});

describe("activity inference", () => {
  const cases: [string, string][] = [
    ["Add a new payment provider to the payment service", "implementation"],
    ["Decide whether to split the ledger into separate read and write services", "architecture"],
    ["Roll out the new adapter to production with a canary", "deployment"],
    ["Incident: checkout is down for EU merchants", "incident"],
    ["Write contract tests for the refund flow", "testing"],
  ];
  it.each(cases)("%s is %s", (description, expected) => {
    expect(inferActivity({ description }, DEFAULT_PROFILES).activity).toBe(expected);
  });

  it("does not match cue words inside other words", () => {
    // "pr" (review cue) must not fire on "provider"
    expect(inferActivity({ description: "provider" }, DEFAULT_PROFILES).scores.review).toBeUndefined();
  });
});

describe("compileContext for 'Add a new payment provider to the payment service'", () => {
  const pkg = compileContext(kb, { description: "Add a new payment provider to the payment service" }, { today: "2026-10-01" });

  it("covers every layer the brief expects", () => {
    const got = ids(pkg);
    for (const id of [
      "biz.rule.provider-onboarding", // business: payment business rules
      "dom.payments.provider-abstraction", // domain: provider abstraction
      "dom.payments.transaction-lifecycle", // domain: transaction lifecycle
      "arch.principle.provider-egress", // architecture: service boundaries / integration
      "arch.pattern.resilient-integration",
      "code.payment-service.layout", // code: repository conventions
      "code.test.provider-contract-tests", // code: testing requirements
      "ops.secrets.provider-credentials", // operations: secrets
      "ops.config.provider-config", // operations: deployment configuration
      "ops.obs.provider-dashboards", // operations: monitoring
      "ops.alert.provider-alerts", // operations: alerting
    ]) {
      expect(got, id).toContain(id);
    }
  });

  it("ranks the provider port among the top domain units", () => {
    const domain = pkg.selected.filter((s) => s.unit.layer === "domain" && s.unit.kind !== "term");
    expect(domain[0]?.unit.id).toBe("dom.payments.provider-abstraction");
  });

  it("excludes units scoped to other services and applies overrides", () => {
    expect(ids(pkg)).not.toContain("ops.deploy.pci-pipeline"); // provider-gateway only
    const sandbox = pkg.excluded.find((e) => e.unit.id === "code.test.sandbox-e2e");
    expect(sandbox?.reason).toBe("overridden by code.test.ci-hermetic");
  });

  it("expands the query with glossary aliases", () => {
    expect(pkg.queryTerms.find((t) => t.term === "psp")?.via).toBe("term.payment-provider");
  });

  it("explains every selection", () => {
    for (const s of pkg.selected) expect(s.reasons.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = compileContext(kb, { description: "Add a new payment provider to the payment service" }, { today: "2026-10-01" });
    expect(ids(again)).toEqual(ids(pkg));
  });
});

describe("activity changes the package", () => {
  it("deployment tasks favour operations, implementation tasks favour code", () => {
    const share = (description: string, layer: string) => {
      const p = compileContext(kb, { description, service: "provider-gateway" }, { budget: 1500 });
      return p.selected.filter((s) => s.unit.layer === layer).length / p.selected.length;
    };
    expect(share("Roll out the Klarna adapter to production", "operations")).toBeGreaterThan(
      share("Implement the Klarna adapter mapping", "operations"),
    );
  });

  it("infers the domain from evidence when the task names no service", () => {
    const p = compileContext(kb, { description: "Incident: Adyen authorization rate dropping, merchants failing" });
    expect(p.scope.domains).toBe("payments");
    expect(ids(p)).toContain("ops.runbook.provider-outage");
  });
});

describe("budget", () => {
  it("never exceeds the budget and degrades fidelity before dropping", () => {
    const pkg = compileContext(kb, { description: "Add a new payment provider to the payment service" }, { budget: 600 });
    expect(pkg.budget.used).toBeLessThanOrEqual(600);
    const fidelities = new Set(pkg.selected.map((s) => s.fidelity));
    expect(fidelities.has("reference") || fidelities.has("summary")).toBe(true);
  });

  it("is monotone: raising the budget never removes a unit", () => {
    for (const description of [
      "Add a new payment provider to the payment service",
      "Roll out the Klarna adapter in provider-gateway to production",
      "Incident: Adyen authorization rate dropping",
    ]) {
      let prev = new Set<string>();
      for (let budget = 50; budget <= 3000; budget += 50) {
        const cur = new Set(ids(compileContext(kb, { description }, { budget })));
        for (const id of prev) expect(cur.has(id), `${description} @${budget}: lost ${id}`).toBe(true);
        prev = cur;
      }
    }
  });

  it("seats pinned units before higher-scoring unpinned ones", () => {
    const a = unit({ id: "a", body: "x".repeat(400) });
    const b = unit({ id: "b", body: "y".repeat(400) });
    const mk = (u: ContextUnit, score: number, pinned: boolean) => ({
      unit: u,
      pinned,
      reasons: [],
      signals: { score } as never,
    });
    const r = packBudget([mk(a, 0.1, true), mk(b, 0.9, false)], 40);
    expect(r.selected.map((s) => s.unit.id)).toContain("a");
  });
});

describe("gaps", () => {
  const tiny: KnowledgeBase = {
    manifest: { organization: "t", extends: [], include: [], topology: { services: {}, environments: [] }, activities: {}, staleAfterDays: 30 },
    units: new Map([["d.model", unit({ id: "d.model", kind: "domain-model", title: "Order model", body: "Orders have lines.", reviewed: "2020-01-01" })]]),
    profiles: DEFAULT_PROFILES,
    diagnostics: [],
    roots: [],
  };

  it("reports expected-but-missing knowledge, unknown acronyms, staleness and missing scope", () => {
    const pkg = compileContext(tiny, { description: "Implement order SKU validation", activity: "implementation" }, { today: "2026-01-01" });
    const types = pkg.gaps.map((g) => g.type);
    expect(types).toContain("missing-knowledge"); // no testing rules / conventions exist
    expect(types).toContain("unknown-term"); // SKU
    expect(types).toContain("stale");
    expect(types).toContain("unscoped-task");
  });
});

describe("renderers", () => {
  const pkg = compileContext(kb, { description: "Add a new payment provider to the payment service" });

  it("markdown groups by layer in lifecycle order", () => {
    const md = renderMarkdown(pkg);
    const order = ["## Business", "## Domain", "## Architecture", "## Code", "## Operations"].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("xml escapes content", () => {
    const xml = renderXml({ ...pkg, task: { description: "a < b & c" } });
    expect(xml).toContain("a &lt; b &amp; c");
  });
});
