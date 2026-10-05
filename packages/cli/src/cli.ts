import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ACTIVITIES,
  compileContext,
  findKnowledgeBase,
  LAYERS,
  loadKnowledgeBase,
  MANIFEST_FILE,
  render,
  renderExplanation,
  renderMermaid,
  type Activity,
  type Format,
  type Task,
} from "@context-sdlc/core";

const here = dirname(fileURLToPath(import.meta.url));
/** The sample knowledge base, used when running from a checkout of this repo. */
const SAMPLE_KB = resolve(here, "..", "..", "..", "knowledge", "monty-python-co");

const HELP = `ctx: compile organizational context for SDLC tasks

Usage:
  ctx build   "<task>" [options]   Print a task-specific context package (the prompt context)
  ctx explain "<task>" [options]   Show why each unit was included/excluded, plus gaps
  ctx validate                     Check the knowledge base for errors and dangling references
  ctx list [--layer L]             List units in the knowledge base
  ctx graph [--task "<task>"]      Emit a Mermaid diagram of the context graph
  ctx init <dir>                   Scaffold a new organization pack from the template

Options:
  -k, --kb <dir>          Knowledge base directory (default: $CTX_KB, ./context.yaml, or the sample)
  -a, --activity <a>      ${ACTIVITIES.join(" | ")} (default: inferred)
  -s, --service <name>    Service the task touches (infers domain/team/repo)
      --domain, --team, --repo, --env, --business-unit
  -b, --budget <tokens>   Token budget (default 4000)
      --min-score <0..1>  Relevance threshold (default 0.12)
  -f, --format <f>        markdown | xml | json (default markdown)
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kb: { type: "string", short: "k" },
      activity: { type: "string", short: "a" },
      service: { type: "string", short: "s" },
      domain: { type: "string" },
      team: { type: "string" },
      repo: { type: "string" },
      env: { type: "string" },
      "business-unit": { type: "string" },
      budget: { type: "string", short: "b" },
      "min-score": { type: "string" },
      format: { type: "string", short: "f" },
      layer: { type: "string" },
      task: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }

  if (cmd === "init") {
    const target = rest[0];
    if (!target) return fail("ctx init <dir>");
    if (existsSync(join(target, MANIFEST_FILE))) return fail(`${target} already contains ${MANIFEST_FILE}`);
    const template = resolve(here, "..", "templates", "org");
    cpSync(template, target, { recursive: true });
    process.stdout.write(`Created ${target}. Edit ${join(target, MANIFEST_FILE)} then run: ctx validate --kb ${target}\n`);
    return 0;
  }

  const kbDir = findKnowledgeBase(values.kb, SAMPLE_KB);
  const kb = loadKnowledgeBase(kbDir);

  if (cmd === "validate") {
    const errors = kb.diagnostics.filter((d) => d.severity === "error");
    for (const d of kb.diagnostics) {
      process.stdout.write(`${d.severity.toUpperCase().padEnd(7)} ${d.file ?? ""}${d.unitId ? ` (${d.unitId})` : ""}: ${d.message}\n`);
    }
    const counts = LAYERS.map((l) => `${l}=${[...kb.units.values()].filter((u) => u.layer === l).length}`).join(" ");
    process.stdout.write(`${kb.manifest.organization}: ${kb.units.size} units (${counts}), ${errors.length} errors, ${kb.diagnostics.length - errors.length} warnings\n`);
    return errors.length ? 1 : 0;
  }

  if (cmd === "list") {
    for (const u of kb.units.values()) {
      if (values.layer && u.layer !== values.layer) continue;
      const scope = Object.entries(u.scope).map(([k, v]) => `${k}:${v?.join("|")}`).join(" ");
      process.stdout.write(`${u.layer.padEnd(13)}${u.kind.padEnd(16)}${u.level.padEnd(7)}${u.id.padEnd(48)}${scope}\n`);
    }
    return 0;
  }

  if (cmd === "graph") {
    let only: Set<string> | undefined;
    if (values.task) only = new Set(compileContext(kb, taskFrom(values.task, values)).selected.map((s) => s.unit.id));
    process.stdout.write(renderMermaid(kb, only));
    return 0;
  }

  if (cmd === "build" || cmd === "explain") {
    const description = rest.join(" ");
    if (!description) return fail(`ctx ${cmd} "<task description>"`);
    if (values.activity && !(ACTIVITIES as readonly string[]).includes(values.activity)) return fail(`Unknown activity ${values.activity}`);
    const pkg = compileContext(kb, taskFrom(description, values), {
      budget: values.budget ? Number(values.budget) : undefined,
      minScore: values["min-score"] ? Number(values["min-score"]) : undefined,
    });
    if (cmd === "explain") process.stdout.write(renderExplanation(pkg));
    else {
      process.stdout.write(render(pkg, (values.format ?? "markdown") as Format));
      if (pkg.gaps.length && values.format !== "json") {
        process.stderr.write(`\n${pkg.gaps.length} gap(s) detected; run \`ctx explain\` for suggestions.\n`);
      }
    }
    return 0;
  }

  return fail(`Unknown command "${cmd}"\n\n${HELP}`);
}

function taskFrom(description: string, v: Record<string, string | boolean | undefined>): Task {
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  return {
    description,
    activity: s("activity") as Activity | undefined,
    service: s("service"),
    domain: s("domain"),
    team: s("team"),
    repo: s("repo"),
    environment: s("env"),
    businessUnit: s("business-unit"),
  };
}

function fail(msg: string): number {
  process.stderr.write(`${msg}\n`);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
