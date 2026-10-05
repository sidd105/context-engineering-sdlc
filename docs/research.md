# Open questions and roadmap

The question this project is chasing: how can an organization's knowledge be
modeled so that it can be turned, on demand, into the smallest and most useful
context for whoever is doing a task, at any stage of the software lifecycle?

The current engine is a baseline. It's deterministic, easy to explain and tuned
by hand. Its main value is that it makes the questions below testable instead
of matters of opinion.

## Modeling

How big should a unit be? Too big and you can't drop the half that doesn't
apply. Too small and the links between units get out of hand. A reasonable
guess is one rule or one concept per unit. One way to test that is to see how
often units end up as summaries rather than full text.

Are five layers the right split? Product and UX knowledge, data knowledge
(lineage, contracts, retention) and people and process knowledge (on-call,
approvals) are all candidates for layers of their own. It could also turn out
that layers work better as tags than as a fixed hierarchy.

How should one domain's changes affect another? Adding a payment provider
creates work for the ledger team. Right now that's expressed by listing both
domains in a unit's scope. An explicit "impacts" link between services or
domains might work better.

Should context have dates? Rules change and ADRs get replaced. If units carried
validity periods, you could compile the context exactly as it stood at a given
release.

## Selection

Can a learned scorer do better than the current one without becoming
impossible to explain? One option is to keep the same formula and learn only
the weights for each activity.

Should the goal be relevance or coverage? Picking the most relevant units can
leave a whole concern out, such as alerting. It might be better to make sure
every concern the task touches is represented, even if that means a less
relevant unit gets in.

When is a reference better than full text? If an agent can fetch a unit on
demand, the package can act like a table of contents. The MCP server already
supports that, so this can now be measured.

Most tasks are more than one activity. A change is often part implementation
and part deployment. Mixing the activity profiles according to how likely each
one is might work better than picking a single winner.

## Evaluation

How do you measure whether context was useful? Some candidate measures:

- Of the must rules that apply to a task, how many made it into the package?
  This needs a hand-labeled answer for each task.
- How much of the token budget went to units an expert would call relevant?
- Give a model the same task with different packages (the compiled one, the
  whole knowledge base, nothing at all) and grade the results against the
  rules, with tests and a model as judge.
- How often do generated pull requests break a rule?

To make any of this real, the project needs a benchmark: a set of tasks for the
Monty Python and Co. example, each with the correct context and a grading rubric. Then a second
set for an organization that looks quite different, to see whether the approach
generalizes.

## Governance

Not everyone should see everything. Security architecture or legal positions
might be restricted, so packages need to respect who is asking. That probably
means adding an audience dimension to scope.

Every AI-generated change could record the package it was made with, for
example as a hash in the pull request. Then "which rules did the model see?"
has an answer.

When code drifts from what the knowledge base says, for instance a new provider
adapter without contract tests, the system could notice. It would then suggest
either fixing the code or updating the rule.

## Roadmap

Done so far:

- [x] Unit schema, packs with `extends`, topology
- [x] Activity profiles that organizations can override
- [x] The compiler: scope filtering, BM25 with glossary expansion, graph scoring, pinning, overrides, budget packing
- [x] Explanations, near misses and gap reports
- [x] Markdown, XML and JSON output, plus a Mermaid graph
- [x] The `ctx` command line tool
- [x] An MCP server with `get_context`, `get_units`, `search_units`, `explain_context`, `list_topology`, unit resources, a prompt and hot reload (see [mcp.md](mcp.md))

Next, to make it usable by a real team:

- [ ] Track which abbreviated units agents ask to expand. That's direct evidence for the reference versus full text question, and for tuning budgets.
- [ ] Embedding search alongside BM25, cached per unit
- [ ] The real tokenizer for each target model
- [ ] Importers for ADR markdown, CODEOWNERS, OpenAPI and protobuf files, and Backstage catalogs
- [ ] `ctx diff`, to show how a change to the knowledge base changes the packages for a fixed set of tasks

Later:

- [ ] The evaluation benchmark described above
- [ ] Logging outcomes and learning the weights from them
- [ ] Coverage-based selection and agent-driven expansion
- [ ] Packages that respect who is asking, and package hashes in pull requests
- [ ] Drift detection in CI
