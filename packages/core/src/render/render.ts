import type { ContextPackage, SelectedItem } from "../engine/compiler.js";
import { firstSentence } from "../engine/text.js";
import type { KnowledgeBase, Layer } from "../model/types.js";
import { LAYERS } from "../model/types.js";

export type Format = "markdown" | "xml" | "json";

const LAYER_TITLES: Record<Layer, string> = {
  business: "Business context",
  domain: "Domain context",
  architecture: "Architecture context",
  code: "Code context",
  operations: "Operations context",
};

const LEVEL_TAG = { must: "MUST", should: "SHOULD", may: "MAY", info: "INFO" } as const;

function byLayer(items: SelectedItem[]): [Layer, SelectedItem[]][] {
  return LAYERS.map((l) => [l, items.filter((i) => i.unit.layer === l)] as [Layer, SelectedItem[]]).filter(([, xs]) => xs.length);
}

function itemText(i: SelectedItem): string {
  if (i.fidelity === "reference") return "";
  if (i.fidelity === "summary") return i.unit.summary ?? firstSentence(i.unit.body);
  return i.unit.body;
}

function scopeLine(pkg: ContextPackage): string {
  const parts = Object.entries(pkg.scope).map(([k, v]) => `${k.replace(/s$/, "")}=${v}`);
  return parts.length ? parts.join(", ") : "organization-wide";
}

export function renderMarkdown(pkg: ContextPackage): string {
  const out: string[] = [];
  out.push(`# Context for: ${pkg.task.description}`, "");
  out.push(`- **Activity:** ${pkg.activity.activity}: ${pkg.profile.description}`);
  out.push(`- **Scope:** ${scopeLine(pkg)}`);
  out.push(`- **Normative keywords:** MUST / SHOULD / MAY follow RFC 2119.`, "");
  for (const [layer, items] of byLayer(pkg.selected)) {
    out.push(`## ${LAYER_TITLES[layer]}`, "");
    for (const i of items) {
      const head = `**[${LEVEL_TAG[i.unit.level]}] ${i.unit.title}** \`${i.unit.id}\``;
      const text = itemText(i);
      if (!text) out.push(`- ${head} _(reference only; ask for details if needed)_`);
      else if (i.fidelity === "summary") out.push(`- ${head}: ${text}`);
      else out.push(`- ${head}`, "", indent(text, "  "), "");
    }
    out.push("");
  }
  if (pkg.conflicts.length) {
    out.push("## Known conflicts", "");
    for (const c of pkg.conflicts) out.push(`- \`${c.a}\` conflicts with \`${c.b}\`; flag this rather than silently picking one.`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XML-tagged output. LLMs tend to follow clearly delimited sections well. */
export function renderXml(pkg: ContextPackage): string {
  const out: string[] = [];
  out.push(`<organizational_context activity="${pkg.activity.activity}" scope="${esc(scopeLine(pkg))}">`);
  out.push(`  <task>${esc(pkg.task.description)}</task>`);
  for (const [layer, items] of byLayer(pkg.selected)) {
    out.push(`  <${layer}_context>`);
    for (const i of items) {
      const attrs = `id="${i.unit.id}" kind="${i.unit.kind}" level="${i.unit.level}" fidelity="${i.fidelity}"`;
      const text = itemText(i);
      out.push(`    <item ${attrs}>`, `      <title>${esc(i.unit.title)}</title>`);
      if (text) out.push(`      <content>${esc(text)}</content>`);
      out.push(`    </item>`);
    }
    out.push(`  </${layer}_context>`);
  }
  for (const c of pkg.conflicts) out.push(`  <conflict a="${c.a}" b="${c.b}"/>`);
  out.push(`  <instructions>Treat level="must" items as hard constraints. Items with fidelity="reference" exist but were abbreviated; ask for them by id if they matter.</instructions>`);
  out.push(`</organizational_context>`);
  return out.join("\n") + "\n";
}

export function renderJson(pkg: ContextPackage): string {
  return (
    JSON.stringify(
      {
        task: pkg.task.description,
        activity: pkg.activity,
        scope: pkg.scope,
        budget: pkg.budget,
        items: pkg.selected.map((i) => ({
          id: i.unit.id,
          layer: i.unit.layer,
          kind: i.unit.kind,
          level: i.unit.level,
          title: i.unit.title,
          fidelity: i.fidelity,
          content: itemText(i) || undefined,
          score: round(i.signals.score),
          reasons: i.reasons,
        })),
        conflicts: pkg.conflicts,
        gaps: pkg.gaps,
      },
      null,
      2,
    ) + "\n"
  );
}

export function render(pkg: ContextPackage, format: Format): string {
  return format === "xml" ? renderXml(pkg) : format === "json" ? renderJson(pkg) : renderMarkdown(pkg);
}

/** Human-facing report: why each unit is in, why near-misses are out, what is missing. */
export function renderExplanation(pkg: ContextPackage, opts: { nearMisses?: number } = {}): string {
  const out: string[] = [];
  const a = pkg.activity;
  out.push(`Task:      ${pkg.task.description}`);
  out.push(`Activity:  ${a.activity}${pkg.task.activity ? " (given)" : ` (inferred, confidence ${a.confidence.toFixed(2)}${Object.keys(a.scores).length > 1 ? `; also ${Object.entries(a.scores).filter(([k]) => k !== a.activity).map(([k, v]) => `${k}:${v}`).join(", ")}` : ""})`}`);
  out.push(`Scope:     ${scopeLine(pkg)}`);
  for (const n of pkg.scopeNotes) out.push(`           - ${n}`);
  const expanded = pkg.queryTerms.filter((t) => t.via);
  out.push(`Query:     ${pkg.queryTerms.filter((t) => !t.via).map((t) => t.term).join(" ")}`);
  if (expanded.length) out.push(`Adjusted:  ${expanded.map((t) => `${t.term} (weight ${t.weight}, ${t.via})`).join(", ")}`);
  out.push(`Units:     ${pkg.stats.totalUnits} total, ${pkg.stats.inScope} in scope, ${pkg.stats.candidates} relevant, ${pkg.stats.selected} selected`);
  out.push(`Budget:    ${pkg.budget.used}/${pkg.budget.limit} tokens`, "");

  out.push("INCLUDED");
  for (const i of pkg.selected) {
    out.push(`  ${i.signals.score.toFixed(2)}  ${i.unit.id}  [${i.unit.layer}/${i.unit.kind}, ${i.fidelity}]`);
    for (const r of i.reasons) out.push(`          - ${r}`);
  }

  const near = pkg.excluded
    .filter((e) => e.score !== undefined)
    .sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
    .slice(0, opts.nearMisses ?? 5);
  if (near.length) {
    out.push("", "NEAR MISSES");
    for (const e of near) out.push(`  ${(e.score ?? 0).toFixed(2)}  ${e.unit.id}: ${e.reason}`);
  }
  const scopedOut = pkg.excluded.filter((e) => e.score === undefined);
  if (scopedOut.length) out.push("", `FILTERED OUT: ${scopedOut.length} units (out of scope / wrong activity / zero-weight layer)`);

  if (pkg.gaps.length) {
    out.push("", "GAPS & SUGGESTIONS");
    for (const g of pkg.gaps) out.push(`  [${g.type}] ${g.message}`, `      suggestion: ${g.suggestion}`);
  }
  return out.join("\n") + "\n";
}

/** Mermaid diagram of the knowledge graph (or of a package's subgraph). */
export function renderMermaid(kb: KnowledgeBase, only?: Set<string>): string {
  const out = ["graph LR"];
  const ids = [...kb.units.keys()].filter((id) => !only || only.has(id));
  const safe = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, "_");
  for (const l of LAYERS) {
    const members = ids.filter((id) => kb.units.get(id)!.layer === l);
    if (!members.length) continue;
    out.push(`  subgraph ${l}`);
    for (const id of members) out.push(`    ${safe(id)}["${kb.units.get(id)!.title.replace(/"/g, "'")}"]`);
    out.push("  end");
  }
  for (const id of ids) {
    for (const [rel, targets] of Object.entries(kb.units.get(id)!.relations)) {
      for (const t of targets ?? []) if (!only || only.has(t)) out.push(`  ${safe(id)} -->|${rel}| ${safe(t)}`);
    }
  }
  return out.join("\n") + "\n";
}

function indent(s: string, pad: string): string {
  return s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
