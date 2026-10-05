# Usage and background guide

Every engineering organization has a pile of knowledge that never makes it into
a prompt. Business rules live in a product wiki, the domain model lives in a few
people's heads, architecture decisions are buried in ADRs, coding conventions
are in a style guide, and the deploy rules are in a runbook somewhere. When
someone asks an AI assistant for help, it gets almost none of that, or someone
pastes in far too much of it.

This project is an attempt to fix that properly. The organization writes its
knowledge down once, as small structured YAML files, and a compiler picks out
the part that matters for a specific task. Adding a payment provider needs the
provider abstraction, the decline-code rules, the integration patterns, the
testing requirements and the secrets process. It doesn't need the ledger's
accounting rules or the incident communication policy. The compiler works that
out and explains its choices.

The question behind it is: how do you model what an organization knows, and turn
it into the smallest useful context for a given task at a given stage of the
software lifecycle?

## What's in this repo

There are three pieces of software here, plus some sample knowledge to run
them against.

The engine, in `packages/core`, is where the real work happens. It defines the
YAML format, loads a knowledge base, and compiles context for a task. It's a
plain library with no idea how it's being called, so it can be built into
other tools.

The `ctx` command line tool, in `packages/cli`, lets people build and inspect
context from a terminal.

The MCP server, in `packages/mcp-server`, lets AI agents ask the engine for
context themselves.

The knowledge is separate from all three. `knowledge/monty-python-co` is a
sample organization, and `knowledge/packs` holds a small shared pack of
security rules that the sample builds on. A real company would keep its own
knowledge base in its own repo, owned by the people who know the rules, and
point the tools at it. The software reads the knowledge and never ships with
it.

## How it's organized

Knowledge is split into five layers, roughly following the path from "why are
we doing this" to "how does it run in production":

- Business: goals, business rules, policies, constraints
- Domain: domain models, invariants, terminology, workflows
- Architecture: principles, patterns, ADRs, service boundaries
- Code: conventions, coding standards, testing rules, reference examples
- Operations: deployment rules, infrastructure, observability, security, runbooks

Each piece of knowledge is a "unit": one rule, one decision or one concept. A
unit says how binding it is (must, should, may), where in the organization it
applies (a domain, a service, a team, a repo, an environment) and which other
units it depends on. Here's one:

```yaml
- id: dom.payments.decline-reasons
  layer: domain
  kind: domain-rule
  level: must
  title: Decline reasons are normalized
  body: |
    Provider decline codes map onto our DeclineReason enum. Soft declines
    can be retried on another provider. Hard declines must never be retried.
  scope: { domains: [payments] }
  relations:
    dependsOn: [dom.payments.transaction-lifecycle]
  owner: payments-core
  reviewed: 2026-03-01
```

A `context.yaml` file at the top describes the organization itself: which
services exist, which domain and team each one belongs to, and which repo it
lives in. That's what lets a task that just says "the payment service" pick up
rules written for the payments domain or the payments-core team.

## What happens when you ask for context

Given a task like "Add a new payment provider to the payment service", the
compiler:

1. Guesses the kind of work from the wording ("add" suggests implementation)
   and finds the service in the text, then fills in its domain, team and repo.
2. Drops units that can't apply, like rules scoped to other services.
3. Scores what's left. Word overlap with the task counts, and so do links from
   other relevant units, so the money-handling rule comes along even though the
   task never mentions money. The kind of work matters too: code rules weigh
   more during implementation, operations rules more during a deployment.
4. Keeps every in-scope "must" rule that has some connection to the task, and
   cuts anything that scores too low.
5. Removes rules that another rule overrides, and flags rules that conflict.
6. Fits the result into a token budget. Everything relevant gets at least a
   one-line mention before anything gets its full text.
7. Reports what looks missing, such as no testing rules for this service, an
   acronym nobody defined, or an ADR that hasn't been reviewed in years.

The details, including the scoring formula, are in
[docs/algorithm.md](algorithm.md).

## Trying it

You need Node 20 or newer.

```bash
npm install
```

The sample organization is Monty Python and Co., a made-up payments company
with about 60 units across all five layers. When you run the tools from inside
this repo without saying which knowledge base to use, they use that one. To
see what the compiler picks for a task and why:

```bash
npm run ctx -- explain "Add a new payment provider to the payment service"
```

To get the context itself, in the form you'd hand to a model:

```bash
npm run ctx -- build "Add a new payment provider to the payment service" --budget 1500 --format xml
```

Try a few different kinds of task, such as rolling something out, an incident,
or an architecture question, and watch the mix change. "Roll out the Klarna
adapter to production" pulls mostly operations rules. "Should the ledger expose
a synchronous balance API?" pulls mostly architecture decisions.

Other commands: `ctx validate` checks the YAML for mistakes and broken links,
`ctx list` prints every unit, `ctx graph` draws the relationships as a Mermaid
diagram, and `ctx init <dir>` creates a starter knowledge base for your own
organization. Run any of them with `--help` for the options.

## Using it with an AI model

Nothing here is tied to a particular model or vendor. The output is plain text,
so there are two ways to use it.

The simple way works with any chat model. Run `ctx build` and paste the result
in ahead of your request. The XML format is a good default, because the
sections are clearly marked and the must-level rules are labeled as such.

The better way is the MCP server, which lets a coding agent ask for context by
itself whenever it starts a task. MCP is an open protocol supported by most
agent tools, including Claude Code, Codex, Cursor, VS Code, Gemini CLI and
Windsurf. Build the server once:

```bash
npm run build
```

Then point your agent at it. Most clients take a block like this in their MCP
settings:

```json
{
  "mcpServers": {
    "org-context": {
      "command": "node",
      "args": ["/path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js", "--kb", "/path/to/your-org-context"]
    }
  }
}
```

[docs/mcp.md](mcp.md) has the exact setup for several clients, including
the ones that use a command or a TOML file instead. This repo also includes a
project-level `.mcp.json` for clients that read one.

Once it's connected, the main tool is `get_context`, which returns the
compiled package for a task. When the package only mentions a rule by name to
save space, the agent can call `get_units` to read it in full. There's also
search, an explain tool, and a way to list the organization's services. The
server reloads the YAML whenever it changes, so edits show up on the next
request.

## Using it for your own organization

```bash
npm run ctx -- init ../my-org-context
```

That gives you a `context.yaml` and one folder per layer with a couple of
placeholder units. Fill in your services and teams, replace the placeholders
with real rules, and run `ctx validate --kb ../my-org-context` as you go. The
tools also pick up a knowledge base from the `CTX_KB` environment variable, or
from the current folder if it has a `context.yaml`. If you want to reuse a
shared set of rules across teams, put them in their own pack and pull it in
with `extends`, the way the sample uses `knowledge/packs/secure-sdlc-baseline`.

You can also change how much each layer matters for each kind of work by
overriding the activity weights in `context.yaml`. That's the place to encode
how your organization actually delivers software. The field-by-field reference
is in [docs/schema.md](schema.md).

## Finding your way around the code

Inside `packages/core/src`, `model` has the schema and validation, `loader`
reads packs and follows `extends`, `engine` is the compiler itself (activity
profiles, scope matching, scoring, budget packing and gap detection), and
`render` turns a package into XML, Markdown or JSON. The CLI is a single file,
`packages/cli/src/cli.ts`, and `packages/cli/templates/org` is what `ctx init`
copies. The MCP server is `packages/mcp-server/src/server.ts`. Each package
keeps its tests in its own `test` folder, and `docs` has the background
reading.

## Where this is going

This is a first version. It works, and it's deterministic and explainable, but
it matches on words, so it misses paraphrases that the glossary doesn't cover.
The scoring weights are also educated guesses rather than anything learned.
The interesting next steps are measuring whether a package actually helps a
model do better work, learning the weights from real outcomes, and adding
semantic search alongside the word matching. [docs/research.md](research.md)
has the longer list, and [docs/concepts.md](concepts.md) explains the
thinking behind the model.

To run the type checks and tests:

```bash
npm run check
```
