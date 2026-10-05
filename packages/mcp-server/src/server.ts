import { statSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ACTIVITIES,
  compileContext,
  KNOWN_KINDS,
  LAYERS,
  listYaml,
  loadKnowledgeBase,
  render,
  renderExplanation,
  searchUnits,
  type ContextPackage,
  type ContextUnit,
  type KnowledgeBase,
  type Task,
} from "@context-sdlc/core";

/**
 * Holds the knowledge base and reloads it when any YAML file under a loaded
 * pack changes, so people editing context see the effect on the next call
 * without restarting their agent.
 */
export class KnowledgeBaseHandle {
  private kb: KnowledgeBase;
  private fingerprint: string;

  constructor(private readonly dir: string) {
    this.kb = loadKnowledgeBase(dir);
    this.fingerprint = this.computeFingerprint();
  }

  get(): KnowledgeBase {
    const fp = this.computeFingerprint();
    if (fp !== this.fingerprint) {
      this.kb = loadKnowledgeBase(this.dir);
      this.fingerprint = this.computeFingerprint();
    }
    return this.kb;
  }

  private computeFingerprint(): string {
    const parts: string[] = [];
    for (const root of this.kb?.roots ?? []) {
      for (const f of listYaml(root)) {
        try {
          const st = statSync(f);
          parts.push(`${f}:${st.mtimeMs}:${st.size}`);
        } catch {
          parts.push(`${f}:gone`);
        }
      }
    }
    return parts.join("|");
  }
}

const taskShape = {
  task: z.string().min(1).describe("What the user wants done, in their words, e.g. 'Add a new payment provider to the payment service'."),
  activity: z
    .enum(ACTIVITIES)
    .optional()
    .describe("SDLC activity. Omit to infer it from the task text."),
  service: z.string().optional().describe("Service the task touches. Fills in domain, team and repo from the topology. Omit to infer from the task text."),
  domain: z.string().optional(),
  team: z.string().optional(),
  repo: z.string().optional(),
  environment: z.string().optional(),
  budget: z.number().int().min(50).max(100_000).optional().describe("Token budget for the context (default 4000)."),
};

type TaskArgs = { task: string; activity?: Task["activity"]; service?: string; domain?: string; team?: string; repo?: string; environment?: string; budget?: number };

function toTask(a: TaskArgs): Task {
  return { description: a.task, activity: a.activity, service: a.service, domain: a.domain, team: a.team, repo: a.repo, environment: a.environment };
}

/** Reject coordinates the topology doesn't know, with the valid options, rather than silently compiling for nowhere. */
function checkScope(kb: KnowledgeBase, a: TaskArgs): string | undefined {
  const services = kb.manifest.topology.services;
  const known = {
    service: Object.keys(services),
    domain: [...new Set(Object.values(services).map((s) => s.domain))],
    team: [...new Set(Object.values(services).flatMap((s) => (s.team ? [s.team] : [])))],
  };
  for (const key of ["service", "domain", "team"] as const) {
    const v = a[key];
    if (v && known[key].length && !known[key].includes(v)) return `Unknown ${key} "${v}". Known ${key}s: ${known[key].join(", ")}.`;
  }
  return undefined;
}

function compile(handle: KnowledgeBaseHandle, a: TaskArgs): { kb: KnowledgeBase; pkg: ContextPackage } | { error: string } {
  const kb = handle.get();
  const err = checkScope(kb, a);
  if (err) return { error: err };
  return { kb, pkg: compileContext(kb, toTask(a), { budget: a.budget }) };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** Full markdown rendering of one unit, including metadata an agent may need to cite or follow links. */
export function renderUnit(u: ContextUnit): string {
  const lines = [`## ${u.title}`, "", `- id: \`${u.id}\``, `- layer/kind: ${u.layer} / ${u.kind}`, `- level: ${u.level.toUpperCase()}`];
  const scope = Object.entries(u.scope).map(([k, v]) => `${k}=${v?.join("|")}`);
  lines.push(`- scope: ${scope.length ? scope.join(", ") : "organization-wide"}`);
  if (u.aliases?.length) lines.push(`- aliases: ${u.aliases.join(", ")}`);
  if (u.activities?.length) lines.push(`- activities: ${u.activities.join(", ")}`);
  for (const [rel, ids] of Object.entries(u.relations)) if (ids?.length) lines.push(`- ${rel}: ${ids.map((i: string) => `\`${i}\``).join(", ")}`);
  if (u.owner) lines.push(`- owner: ${u.owner}`);
  if (u.source) lines.push(`- source: ${u.source}`);
  if (u.reviewed) lines.push(`- reviewed: ${u.reviewed}`);
  if (u.tags.length) lines.push(`- tags: ${u.tags.join(", ")}`);
  if (u.body) lines.push("", u.body);
  return lines.join("\n");
}

function gapsNote(pkg: ContextPackage): string {
  if (!pkg.gaps.length) return "";
  return (
    "\n\n<context_gaps>\nThe organization's knowledge base may be incomplete for this task:\n" +
    pkg.gaps.map((g) => `- [${g.type}] ${g.message} (${g.suggestion})`).join("\n") +
    "\n</context_gaps>\n"
  );
}

export function createServer(kbDir: string): { server: McpServer; handle: KnowledgeBaseHandle } {
  const handle = new KnowledgeBaseHandle(kbDir);
  const org = handle.get().manifest.organization;
  const server = new McpServer(
    { name: "context-engineering-sdlc", version: "0.1.0" },
    {
      instructions:
        `Organizational context for ${org}. Before planning or changing code, architecture, tests or deployments for ${org}, ` +
        "call get_context with the user's task to receive the business rules, domain model, architecture decisions, conventions " +
        "and operational policies that apply. Treat level=\"must\" items as hard constraints. Items with fidelity=\"reference\" " +
        "were abbreviated for budget: call get_units with their ids when they matter. Use search_units to look for anything the package lacks.",
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get organizational context for a task",
      description:
        "Compile the smallest relevant package of organizational context (business rules, domain model, architecture decisions, " +
        "code conventions, testing rules, operational policies) for a software task. Call this before planning or making a change. " +
        "Activity and service are inferred from the task text if omitted.",
      inputSchema: { ...taskShape, format: z.enum(["xml", "markdown", "json"]).optional().describe("Output format (default xml).") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const r = compile(handle, a);
      if ("error" in r) return error(r.error);
      const format = a.format ?? "xml";
      return text(render(r.pkg, format) + (format === "json" ? "" : gapsNote(r.pkg)));
    },
  );

  server.registerTool(
    "explain_context",
    {
      title: "Explain context selection",
      description:
        "Explain which organizational context a task would receive and why: inferred activity and scope, each included unit's " +
        "signals, near misses, and gaps in the knowledge base. Use when the user asks why something was or wasn't considered.",
      inputSchema: taskShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const r = compile(handle, a);
      return "error" in r ? error(r.error) : text(renderExplanation(r.pkg));
    },
  );

  server.registerTool(
    "get_units",
    {
      title: "Get context units by id",
      description: "Fetch the full text and metadata of context units by id, e.g. to expand items get_context returned as references.",
      inputSchema: { ids: z.array(z.string()).min(1).max(50).describe("Unit ids, e.g. ['dom.payments.decline-reasons'].") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ids }) => {
      const kb = handle.get();
      const found = ids.flatMap((id) => (kb.units.has(id) ? [renderUnit(kb.units.get(id)!)] : []));
      const missing = ids.filter((id) => !kb.units.has(id));
      if (!found.length) return error(`No units found for: ${missing.join(", ")}. Use search_units to find ids.`);
      return text(found.join("\n\n---\n\n") + (missing.length ? `\n\nNot found: ${missing.join(", ")}` : ""));
    },
  );

  server.registerTool(
    "search_units",
    {
      title: "Search organizational knowledge",
      description: "Keyword search across all context units regardless of scope or activity. Returns ids, titles and summaries.",
      inputSchema: {
        query: z.string().min(1),
        layer: z.enum(LAYERS).optional(),
        kind: z.string().optional().describe(`Unit kind, e.g. ${KNOWN_KINDS.slice(0, 6).join(", ")}...`),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, layer, kind, limit }) => {
      const hits = searchUnits(handle.get(), query, { layer, kind, limit });
      if (!hits.length) return text(`No units match "${query}".`);
      return text(
        hits
          .map((h) => {
            const s = Object.entries(h.unit.scope).map(([k, v]) => `${k}=${v?.join("|")}`).join(", ") || "org-wide";
            return `- \`${h.unit.id}\` [${h.unit.layer}/${h.unit.kind}, ${h.unit.level}] ${h.unit.title} (${s})`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "list_topology",
    {
      title: "List services, domains and teams",
      description: "List the organization's services with their domain, team and repo, plus environments and SDLC activities. Use to pick valid arguments for get_context.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const kb = handle.get();
      const lines = [`# ${kb.manifest.organization}`, kb.manifest.description ?? "", "", "| service | domain | team | repo | aliases |", "| --- | --- | --- | --- | --- |"];
      for (const [name, s] of Object.entries(kb.manifest.topology.services)) {
        lines.push(`| ${name} | ${s.domain} | ${s.team ?? ""} | ${s.repo ?? ""} | ${s.aliases.join(", ")} |`);
      }
      lines.push("", `Environments: ${kb.manifest.topology.environments.join(", ") || "none"}`);
      lines.push(`Activities: ${ACTIVITIES.map((a) => `${a} (${kb.profiles[a].description})`).join("; ")}`);
      lines.push(`Units: ${kb.units.size}`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "validate_knowledge_base",
    {
      title: "Validate the knowledge base",
      description: "Report schema errors, unknown kinds and dangling relations in the organization's context units.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const kb = handle.get();
      const d = kb.diagnostics;
      if (!d.length) return text(`${kb.manifest.organization}: ${kb.units.size} units, no problems.`);
      return text(d.map((x) => `${x.severity.toUpperCase()} ${x.file ?? ""}${x.unitId ? ` (${x.unitId})` : ""}: ${x.message}`).join("\n"));
    },
  );

  server.registerResource(
    "context-unit",
    new ResourceTemplate("context://unit/{id}", {
      list: async () => ({
        resources: [...handle.get().units.values()].map((u) => ({
          uri: `context://unit/${u.id}`,
          name: u.id,
          title: u.title,
          description: `${u.layer}/${u.kind} (${u.level})`,
          mimeType: "text/markdown",
        })),
      }),
      complete: {
        id: (value) => [...handle.get().units.keys()].filter((id) => id.startsWith(value)).slice(0, 50),
      },
    }),
    { title: "Context unit", description: "One organizational context unit", mimeType: "text/markdown" },
    async (uri, { id }) => {
      const u = handle.get().units.get(String(id));
      if (!u) throw new Error(`Unknown unit ${String(id)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderUnit(u) }] };
    },
  );

  server.registerPrompt(
    "with-org-context",
    {
      title: "Do a task with organizational context",
      description: "Start a task with the organization's relevant rules, models, decisions and policies already loaded.",
      argsSchema: {
        task: z.string().describe("What you want done"),
        service: z.string().optional().describe("Service it touches (optional)"),
        activity: z.string().optional().describe(`One of: ${ACTIVITIES.join(", ")} (optional)`),
      },
    },
    ({ task, service, activity }) => {
      const act = activity && (ACTIVITIES as readonly string[]).includes(activity) ? (activity as Task["activity"]) : undefined;
      const kb = handle.get();
      const pkg = compileContext(kb, { description: task, service: service || undefined, activity: act });
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `${render(pkg, "xml")}${gapsNote(pkg)}\n` +
                `Using the organizational context above (treat level="must" items as hard constraints, and say if any of them ` +
                `conflict with the request), help with this task:\n\n${task}`,
            },
          },
        ],
      };
    },
  );

  return { server, handle };
}
