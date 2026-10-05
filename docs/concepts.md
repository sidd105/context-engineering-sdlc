# Concepts

The starting point for this project is that organizational knowledge can be
treated a bit like source code. It can be written down in a structured way,
versioned, reviewed and owned by specific people. And instead of being read
directly, it gets compiled into something smaller and specific to one job.

## Why bother

AI-assisted development tends to go wrong in a handful of recognizable ways
when the context is off. A model with only generic knowledge writes code that
ignores the house patterns. Or it writes perfectly reasonable code that breaks
a business rule, because that rule lived in a wiki page nobody pasted in. The
opposite problem happens too: someone pastes the whole wiki, and the one rule
that mattered gets lost in the noise. Two teams asking similar questions get
different answers because each assembled its context by hand. And afterwards,
nobody can say what the model actually knew when it made a decision.

A bigger prompt template doesn't solve any of that. What helps is a model of
what the organization knows, plus a repeatable way to decide which part of it a
particular task needs.

## Layers

Knowledge is grouped into five layers, ordered roughly from the reason
something exists to how it runs:

1. Business: why we do it. Goals, business rules, policies, constraints, metrics.
2. Domain: what things mean. Domain models, invariants, terminology, workflows, events.
3. Architecture: how the system is shaped. Principles, patterns, ADRs, service boundaries, quality attributes.
4. Code: how it's built. Standards, repository conventions, testing rules, practices, reference examples.
5. Operations: how it runs. Deployment rules, infrastructure, observability, security, SLOs, runbooks.

Layers aren't permission levels. They're a way to ask what kind of knowledge a
task needs. The same unit can be useful to many different tasks, just with
different weight.

## Units

A unit is the smallest piece the system works with: one rule, one decision, or
one concept. It should be small enough that you can include or leave it out on
its own, and complete enough to make sense by itself.

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
  tags: [decline, retry, routing]
  relations:
    dependsOn: [dom.payments.transaction-lifecycle]
  owner: payments-core
  reviewed: 2026-03-01
```

A few fields deserve a word. The `level` field uses the usual must, should and
may wording, plus `info` for background material. It separates hard
constraints from everything else, and must rules are the ones a model should
never break. `owner` and `reviewed` make each unit somebody's responsibility,
and they let the system warn about stale knowledge instead of quietly serving
it. `summary` is optional and gives the compiler a shorter version to use when
space is tight.

## Scope

A unit can be limited to particular business units, domains, teams, services,
repos or environments. A unit with no scope applies everywhere.

The `topology` section of `context.yaml` says which domain, team, repo and
business unit each service belongs to. So when a task mentions "the payment
service", the compiler knows to include rules written for the payments domain,
the payments-core team, the monty-python-co/payment-service repo and the merchant-services
business unit, without anyone listing them.

When the compiler compares a unit's scope with a task, one of four things
happens. If the unit is scoped to where the task is, it's included and gets a
small boost for being specific. If it has no scope, it's judged on relevance
alone. If it's scoped by something the task doesn't mention (say, a particular
service, when the task names no service), it's kept but its score is
multiplied by 0.6. If it's scoped somewhere else entirely, it's dropped.

## Relations

Units can point at each other, which turns the knowledge base into a graph.
There are five kinds of link:

- `dependsOn`: you need the other unit to understand this one. Relevance flows strongly along this link.
- `refines`: this unit is a more specific version of another.
- `overrides`: when both apply, this one wins and the other is dropped.
- `conflictsWith`: the two disagree. If both end up selected, the conflict is reported instead of quietly resolved.
- `seeAlso`: loosely related.

The graph is how the compiler finds things a task implies without saying.
"Add a payment provider" never mentions decline codes, but the provider
abstraction depends on them, so they come along.

## Activities

The same organization looks different depending on where you are in the
lifecycle. Each activity (discovery, requirements, architecture,
implementation, testing, review, deployment, operations, incident) has a
profile. The profile sets how much each layer counts, which kinds of unit get a
small boost, what a good package for that activity is expected to contain, and
which words in a task hint at that activity.

During implementation, for example, code counts fully, domain counts 0.8,
architecture 0.6, operations 0.4 and business 0.3. During a deployment,
operations counts fully and domain barely matters.

An organization can override any of this in its `context.yaml`. That's
effectively where it describes its own way of delivering software.

## Packs

A pack is a folder with a `context.yaml` and some unit files. A pack can extend
other packs, and its own units replace any unit with the same id from a pack it
extends. The repo has one shared pack, `knowledge/packs/secure-sdlc-baseline`, and the
Monty Python and Co. example extends it.

You can imagine packs for an industry (PCI or HIPAA rules), for a delivery
method (trunk-based development, say), for an internal platform, or for one
business unit layered on top of the company-wide pack.

## Packages

What the compiler produces for a task is called a package. It holds the
selected units, each at full length, as a one-line summary, or as just a title
and id. It also records which activity and scope were worked out, why each
unit was included, which ones nearly made it, and any conflicts or gaps. The
package can be written out as Markdown, as XML (which works well in prompts),
or as JSON for other tools.

## Who controls it

The organization owns all of it. The knowledge base is plain YAML in its own
repo. The selection rules live in its own manifest. Every package can be
explained after the fact. A model provider only ever sees what the compiler
picked for one task. Context becomes something the organization manages the
same way it manages its code.
