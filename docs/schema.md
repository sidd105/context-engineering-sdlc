# Schema reference

## Pack manifest (`context.yaml`)

```yaml
organization: monty-python-co                 # pack name; shown in diagnostics and on units (unit.pack)
description: ...
extends: [../packs/secure-sdlc-baseline]      # loaded first; this pack's units with the same id win
include: [business, domain, architecture, code, operations]  # dirs/files (recursive, *.yaml|*.yml); default "."
topology:
  environments: [dev, staging, prod]
  domains:
    <domain>:
      team: <team>                 # default for services in this domain
      businessUnit: <bu>
      services:
        <service>:
          repo: <org/repo>
          team: <team>             # overrides domain default
          aliases: [<names people use in tasks>]
activities:                        # optional overrides of built-in activity profiles
  <activity>:
    layerWeights: { <layer>: 0..1 }
    favoredKinds: [...]
    expects: [{ layer, kinds: [...], why }]
    cues: [...]                    # trailing * = prefix match
staleAfterDays: 365
```

## Unit files

Any YAML file under `include`:

```yaml
defaults:            # merged into every unit in this file (scope and tags are merged, not replaced)
  layer: domain
  owner: payments-core
  scope: { domains: [payments] }

units:
  - id: dom.payments.money       # required; lowercase, [a-z0-9._-]; globally unique
    layer: domain                # required: business | domain | architecture | code | operations
    kind: domain-rule            # see kinds below; unknown kinds allowed (warning)
    level: must                  # must | should | may | info   (default should)
    title: Money is integer minor units      # required
    body: |                      # full text
      ...
    summary: ...                 # optional short form for tight budgets
    scope:                       # all optional; empty = org-wide; "*" = any value
      businessUnits: [...]
      domains: [...]
      teams: [...]
      services: [...]
      repos: [...]
      environments: [...]
    tags: [money, currency]
    aliases: [...]               # for kind: term, synonyms used for query expansion
    activities: [implementation, review]   # restrict to these SDLC activities
    pinned: true                 # always include when in scope
    relations:
      dependsOn: [...]
      refines: [...]
      overrides: [...]
      conflictsWith: [...]
      seeAlso: [...]
    owner: payments-core
    source: https://...          # ADR, wiki page, policy doc
    reviewed: 2026-03-01         # drives staleness warnings
```

## Kinds by layer

| Layer | Kinds |
| --- | --- |
| business | `goal`, `business-rule`, `policy`, `constraint`, `metric` |
| domain | `domain-model`, `domain-rule`, `term`, `workflow`, `event` |
| architecture | `principle`, `pattern`, `decision`, `boundary`, `quality-attribute` |
| code | `standard`, `convention`, `testing-rule`, `practice`, `example` |
| operations | `deployment-rule`, `infrastructure`, `observability`, `security`, `runbook`, `slo` |

Kinds aren't locked to layers. `security` appears in both architecture and
operations. The table is the conventional placement.

## Activities

`discovery`, `requirements`, `architecture`, `implementation`, `testing`,
`review`, `deployment`, `operations`, `incident`. Built-in profiles are in
[`packages/core/src/engine/activity.ts`](../packages/core/src/engine/activity.ts).

## Writing good units

Keep each unit to one idea. If you can imagine wanting only half of it for some
task, split it in two.

Write the title as the rule itself, like "Money is integer minor units" rather
than just "Money". When the budget is tight the title might be the only part
that makes it into the package.

Scope units as narrowly as is actually true. Narrow scope is what lets the
compiler leave things out.

Add `dependsOn` links where one rule only makes sense next to another. That
link is how the compiler knows that adding a provider also means dealing with
decline codes.

If you need to change a rule from a shared pack, override it in your own pack
instead of editing the shared one, so the shared pack can keep evolving on its
own.

Fill in `owner` and `reviewed`. Out-of-date context is worse than missing
context, because people trust it.
