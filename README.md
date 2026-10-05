# context-engineering-sdlc

[![CI](https://github.com/sidd105/context-engineering-sdlc/actions/workflows/ci.yml/badge.svg)](https://github.com/sidd105/context-engineering-sdlc/actions/workflows/ci.yml)

Compile your organization's knowledge into focused context for a task. Write
business rules, domain knowledge, architecture decisions, coding conventions
and runbooks as YAML; the compiler selects relevant material and explains why.

Use it independently through the CLI, as a library, or through its MCP server.
It does not implement features, review pull requests or deploy software.

## Quick start

Requires **Node 20+**. From a clone of this repository:

```bash
npm ci
npm run ctx -- explain "Add a new payment provider to the payment service"
npm run ctx -- build "Add a new payment provider to the payment service" --budget 1500 --format xml
```

These commands use the bundled fictional organization, Monty Python and Co.
No AI provider or API key is required. Formats include XML, Markdown and JSON.

## Use your own knowledge

```bash
npm run ctx -- init ../my-org-context
npm run ctx -- validate --kb ../my-org-context
npm run ctx -- build "Add a health endpoint" --kb ../my-org-context --format json
```

Replace the generated placeholders with your services, teams and rules. Keep
organizational knowledge in a separate repository. Select it with `--kb` or
`CTX_KB`; otherwise the tools may use the sample knowledge base.

A knowledge unit records what a rule says, where it applies, whether it is a
must/should/may, its owner, and its relationships to other units. The compiler
matches task and scope, scores relevance, resolves overrides, fits a token
budget, and reports conflicts and gaps. Relevance scores are not delivery
readiness scores.

## Connect an agent

Paste CLI output into your agent's context, or expose the MCP server:

```bash
npm run build
```

Point your client's MCP settings at
`packages/mcp-server/dist/main.js` with `--kb /absolute/path/to/knowledge`.
See [MCP setup](docs/mcp.md) for client-specific configuration. The server
provides context compilation, unit retrieval, search and organization lookup.

## Use with Relay and the PR reviewer

These remain separate projects:

| Project | Owns |
| --- | --- |
| **This repository** | Organizational knowledge and task context |
| [context-aware-pr-reviewer](https://github.com/sidd105/context-aware-pr-reviewer) | Rule-based code assessment; can optionally consume this knowledge format |
| [Relay](https://github.com/sidd105/agentic-feature-delivery-workflow) | Delivery stages, approvals, QA and release coordination |

Relay calls `ctx build` and reads JSON. It does not import the compiler or
require changes to this repository. Neither Relay nor the reviewer is required
to use the context engine. Relay's setup guide describes the handoff.

## Development and reference

```bash
npm run check
```

- `packages/core`: model, loader, compiler and renderers
- `packages/cli`: command-line interface
- `packages/mcp-server`: agent-facing server
- [Usage and background guide](docs/guide.md)
- [Knowledge schema](docs/schema.md), [selection algorithm](docs/algorithm.md)
- [Concepts](docs/concepts.md), [research and limitations](docs/research.md)

This is an early deterministic compiler. Matching is primarily lexical;
paraphrases can be missed, and scoring weights are heuristic. Inspect gaps,
conflicts and abbreviated mandatory items before acting on compiled context.
