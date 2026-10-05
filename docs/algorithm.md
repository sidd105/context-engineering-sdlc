# How context gets selected

Stated plainly, the problem is this. There's a knowledge base full of units, a
task, and a token budget. Pick the units that will help most with the task,
decide how much of each one to include, stay within the budget, and make sure
the rules that must be followed are in there.

"Help most" can't be measured directly, so this first version uses a scoring
function that is simple enough to explain. Every number below shows up in the
output of `ctx explain`. The code is `compileContext()` in
[`packages/core/src/engine/compiler.ts`](../packages/core/src/engine/compiler.ts).

The steps run in this order: locate, filter, build the query, score, pin and
threshold, resolve overrides, pack, and diagnose.

## 1. Locate the task

First the compiler decides what kind of work this is. If the caller passes an
activity it uses that. Otherwise it looks for cue words from each activity's
profile in the task text ("add" and "implement" for implementation, "deploy"
and "canary" for deployment, and so on), after reducing words to their stems.

Then it works out where in the organization the task sits. Anything passed
explicitly wins. Otherwise it looks for the longest service name or alias that
appears in the text, and uses the topology to fill in that service's domain,
team, repo and business unit.

If that still leaves no service or domain, it tries one more thing. It scores
every domain-scoped unit against the task text and looks at the top eight
matches. If one domain accounts for at least 60% of that evidence, the task is
assumed to be in that domain. This is how "Adyen auth rate dropping" ends up in
payments even though it names no service.

## 2. Filter

These are hard rules with no scoring. A unit is removed if its scope points
somewhere other than the task, if it's restricted to a different activity, or
if its layer has a weight of zero for this activity.

## 3. Build the query

The task text is split into words, common filler words are removed, and the
rest are stemmed so that "providers" and "provider" match. Each word starts
with a weight of 1.

Words that only identify where the task is, such as "payment service", drop to
a weight of 0.3. Step 1 has already used them, and leaving them at full weight
would make half the knowledge base look relevant.

Then the glossary is used for expansion. If the task mentions a glossary term
or one of its aliases, the term's other names are added at a weight of 0.6. A
task that says "PSP" will also search for "payment provider", "acquirer" and
"processor". The organization's own vocabulary is what drives this.

## 4. Score

Each remaining unit gets three numbers between 0 and 1.

The lexical score measures how well the unit's text matches the query. It uses
BM25, the standard ranking formula from search engines. The title counts three
times, tags and aliases twice, and the summary and body once. The result is
divided by the best score among the candidates. A glossary term that the task
names directly gets a lexical score of 1.

The graph score measures how much relevance reaches the unit through its links.
Units with a lexical score above 0.15 act as starting points. Their score flows
along each link, multiplied by the strength of that kind of link: 0.7 for
`dependsOn`, 0.5 for `refines` and `overrides`, 0.4 for `conflictsWith` and 0.3
for `seeAlso`. Links followed backwards get 60% of that. This repeats for two
hops, and each unit keeps the best value it received.

The prior is a small fixed boost: 0.15 if the unit's kind is one the activity
favors, plus 0.1 for each scope dimension it matched exactly, capped at 0.5.

The three are combined like this:

```text
relevance = 1 - (1 - lexical) * (1 - graph) * (1 - prior)
score     = layer weight * relevance * scope factor * level factor
```

The first line means that any one strong signal is enough on its own, and
several weak ones add up. The scope factor is 0.6 when the unit's scope can't
be checked because the task doesn't say, and 1 otherwise. The level factor is
1.15 for must, 1.0 for should, 0.85 for may and 0.8 for info.

## 5. Pin and threshold

Some units are kept no matter how they score. That covers any unit marked
`pinned: true`. It also covers a must-level unit whose scope matches the task,
as long as it has some evidence of relevance (a lexical or graph score above
zero) and either its layer counts for at least 0.5 in this activity or its
lexical score is at least 0.4.

The evidence requirement is there for a reason. Without it, every must rule in
a domain gets dragged into every task in that domain. An early version did
exactly that, and a question about the ledger's API pulled in the refund window
rule.

Everything else needs a score of at least 0.12. Units below that are dropped
and listed as near misses.

## 6. Resolve overrides and conflicts

If one selected unit overrides another selected unit, the overridden one is
removed. If two selected units are marked as conflicting, both stay. The
conflict is written into the package, so the model is told to raise it rather
than quietly pick a side, and it's reported to the person as a gap.

## 7. Pack into the budget

Each unit can be included in one of three forms. A reference is the title and
id. A summary is the explicit summary if there is one, otherwise the first
sentence, cut off at 180 characters. Full means the whole body.

Packing happens in two passes. The first pass goes through the units in
priority order (pinned first, then by score) and gives each one a seat as a
reference, stopping at the first one that doesn't fit. The second pass spends
whatever budget is left. It upgrades pinned units to summaries, then every unit
to a summary, then every unit to full text, always in priority order.

Two ideas sit behind this. For a model, knowing that a relevant rule exists,
and having its id so it can ask for it, is worth more than the full text of a
marginal rule. And stopping at the first unit that doesn't fit, instead of
skipping it and trying the next, means a bigger budget can never cause a unit
to disappear. The earlier skip-and-continue version did break that: a bigger
budget let an earlier large unit in, which then crowded out smaller ones
further down. There's now a test that checks every budget from 50 to 3,000
tokens.

## 8. Diagnose

Finally the compiler looks for problems with the package and reports them as
gaps:

- Each activity lists the kinds of knowledge it expects, so the compiler can
  say when one is missing. It also says whether matching units exist and scored
  too low, or don't exist at all, which means someone needs to write them.
- A task whose service or domain couldn't be worked out.
- Acronyms in the task that the glossary doesn't define.
- Selected units whose review date is older than the manifest allows.
- Conflicts, and must rules that had to be dropped for lack of budget.

This is the feedback loop that shows an organization where its knowledge base
is thin.

## Properties worth knowing

The same knowledge base, task and options always produce the same package, so
packages can be compared, cached and tested. Every included unit comes with its
reasons and every excluded one with a reason for leaving it out. Raising the
budget never removes a unit, although individual units can move between
summary and full text as the budget is redistributed. And all the weights,
cue words and expectations are data in the manifest rather than code, so an
organization can tune them without touching the engine.

## Known weaknesses

Matching is by words. Paraphrases only work if the glossary covers them, so
"card processor onboarding" and "provider integration" won't find each other.
Adding embedding-based search next to BM25, and merging the two rankings, is
the obvious next step. BM25 should stay, because it's easy to explain.

Activity detection is a list of cue words. A small classifier or an LLM call
could replace it behind the same function, with the cue words kept as a
fallback.

Packing is greedy. Budgets are small enough that an exact solution is
practical. It could also be worth rewarding coverage of different concerns
rather than raw relevance, so the package doesn't spend its budget on five
near-identical rules.

The weights are hand-picked. With logs of packages and what happened afterwards
(accepted PRs, review comments, incidents), they could be fitted per activity.

Relations are written by hand. Candidate links could be mined from PRs, ADR
references and code ownership, then confirmed by a person.

Token counts are estimated at four characters per token. The real tokenizer for
the target model would be better.

Cross-domain effects currently have to be expressed through scope lists. A
payments change that creates obligations for the ledger would be better modeled
as a link between the two domains in the topology.
