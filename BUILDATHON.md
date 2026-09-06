# Entire Impact

## One-sentence summary

A change-risk assessment that joins Entire Graph blast radius with Entire
Checkpoint intent, and reports the dependents a change structurally reaches
that the developer's recorded reasoning never mentions.

## Problem, intended user and why it matters

The intended user is a developer or agent about to merge a change they did not
fully write themselves.

Code review answers "is this diff correct?" It does not answer "what else does
this reach?" Two existing tools each answer half:

- A **Git diff** shows changed lines, and nothing about what depends on them.
- **Checkpoint context** shows the developer's stated intent, and nothing about
  the code structure that intent failed to cover.

The dangerous case is neither: a change that is locally correct, reaches 50
callers, and whose author only ever reasoned about 3 of them. Nothing in the
current toolchain surfaces that gap, because surfacing it requires structural
reach and stated intent *in the same view*.

## Selected Entire track and why Entire is essential

**Track 2 — Build with Graph Intelligence** (repository: `entireio/entire-graph`).

This addresses three of the track's five listed examples: impact-aware change-risk
analysis, test selection based on affected relationships, and combining Entire
Graph findings with checkpoint intent.

Entire is not decoration here — the product is a *join*, and neither side is
substitutable:

- Remove the **Graph** and there is no blast radius. `git diff` yields changed
  lines; it cannot enumerate callers, type consumers or data flows. The
  `CALLS`, `USES_TYPE` and `DATA_FLOWS` relations are the entire left side.
- Remove **Checkpoints** and every dependent looks equally unexamined. The
  product's one novel output — *unacknowledged* reach — is definitionally the
  set difference between graph reach and recorded intent. With no intent,
  that set is undefined, and the tool says so rather than guessing.

## Architecture and main workflow

```
entire graph diff --base <ref> --json
        │  entity-level changed symbols (not line hunks)
        ▼
  filter to code symbols          ← config sections collide by name
        │
        ▼
entire graph impact --symbol <file>:<line>     (parallel, one per symbol)
        │  callers + type_consumers + data_flows
        ▼
  split radius: test files → coverage,  everything else → dependents
        │
        ▼
entire checkpoint explain --commit <sha>       (commits in range only)
        │  stated intent
        ▼
  JOIN: dependents whose name never appears in intent text
        │
        ▼
  risk score → ranked findings, each cited file:line
```

Two components:

- `skills/impact/SKILL.md` — the agent-facing workflow. Read-only, requires a
  citation for every finding, and mandates verifying a cited `file:line`
  against source before asserting it.
- `skills/impact/bin/entire-impact.mjs` — the deterministic join. Kept out of
  the agent's head on purpose: the same diff must produce the same findings on
  every run, which prose instructions alone do not guarantee.

### Design decisions worth recording

**Config entities are excluded from expansion.** A YAML `section on` in
`entireio/cli` reports 1610 dependents — a name collision, not a real blast
radius. Left in, it outranks every genuine finding.

**Tests are separated from dependents, not counted as them.** When
`TestPushQueueForRepo` calls `PushQueueForRepo`, that caller is the protection
for the change, not something endangered by it. Keeping them in one bucket
would make well-tested code look risky. The split is what lets "reaches 43
callers, none of them tests" be a finding at all.

**`callees` is excluded from the radius.** What a symbol calls is not
endangered by changing it. Only inbound relations count.

**Intent is scoped to the commits in the diff range**, not the whole branch.
Branch-wide intent describes work this change never touched and would mark
unrelated symbols "acknowledged" — a false clean result, which is the
expensive direction of this error.

## Entire Graph findings and verification

Verified against `entireio/cli`, indexed at **1,425 files / 28,563 symbols /
160,170 relations**, `completeness_level: ok`, 1 partial failure.

**Definition lookup and search.** `entire graph impact --symbol pushqueue.go:69`
resolves `PushQueueForRepo` to 43 inbound dependents across `callers` (36:
16 direct, 20 transitive), `type_consumers` (4) and `data_flows` (3).

**Relationship analysis before a high-risk change.** On `HEAD~6..HEAD`, the
top finding is `EntireSettings` (type, signature changed) at
`cmd/entire/cli/settings/settings.go:80` with a **104-dependent** radius, of
which 8 resolved names never appear in checkpoint intent — including
`LoadEntireSettings` (`cmd/entire/cli/config.go:52`) and `SaveEntireSettings`
(`config.go:64`). A signature change to a settings type whose load/save path
went unmentioned is exactly the review question a diff cannot raise.

**Findings are treated as evidence, not oracle.** Two cases where the graph
was checked and the raw output was *not* taken at face value:

1. The YAML `section on` / 1610-dependent result is a name collision. Verified
   by inspection and filtered out.
2. `init` at `e2e/agents/opencode.go:21` reports 490 dependents. Go permits
   many `init` functions across packages; the count aggregates unrelated
   symbols sharing a name. Still reported, but it is a **known false-positive
   shape** documented under limitations rather than presented as real reach.

## Noon Curveball: what changed and how we adapted

_To be completed after 12:00._

## Checkpoint links and what each checkpoint proves

_To be completed. Required milestones: initial understanding and intended
architecture; last stable state before the Curveball; response to the
Curveball; final implementation and verification._

## Setup, run and test instructions

```bash
# Prerequisites: entire CLI, graph plugin, Node 18+
entire plugin install graph
entire graph version          # expect v0.4.0

# From a clone created through the Entire mirror workflow:
entire enable -y --agent claude-code
entire graph init-agents --repo .

# Run against any Entire-enabled repository:
node skills/impact/bin/entire-impact.mjs --base HEAD~6 --top 4 --repo .

# Machine-readable output:
node skills/impact/bin/entire-impact.mjs --base HEAD~6 --json --repo .
```

Flags: `--base` (required), `--head` (default `HEAD`), `--repo`, `--top`
(symbols expanded, default 8), `--json`, `--no-history`.

### Degraded modes, and what each prints

| Condition | Behavior |
| --- | --- |
| Checkpoint transcripts unreachable | Falls back to condensed checkpoint summaries; labels the source in the header |
| No checkpoint context at all | **Structural-only mode**; suppresses the unacknowledged split entirely rather than marking every dependent unacknowledged |
| Symbol ambiguous / unresolvable | Falls back to the dependent count from `graph diff` |
| Graph plugin missing | Stops; the skill does not pretend to degrade |

## Databricks use, data sources and limitations (if applicable)

_Opted in; not yet implemented. Planned: a Delta table of symbol-level
co-change history `(symbol, co_changed_symbol, times_changed_together,
times_followed_by_fix)`, aggregated from real git and checkpoint history of the
analyzed repo, queried through the serverless SQL warehouse to convert the
structural score into an empirical one._

_Rationale: the local graph's own co-change signal is file-level and thin — the
whole `entireio/cli` index carries only 195 `FILE_CHANGES_WITH` edges, and
`co_changes.total` was 0 for the symbols examined. Symbol-level history
weighted by whether a follow-up fix was needed is not derivable locally._

_The helper already accepts `--no-history` and treats the multiplier as
optional, so the documented fallback is the current behavior._

## Known limitations and next steps

**Limitations, all verified rather than assumed:**

- **Intent matching is substring, case-insensitive.** A short or common symbol
  name (`New`, `Push`, `abs`) can match unrelated prose and be marked
  acknowledged when the developer never considered it. This biases toward
  false *negatives* — missed risk — which is the wrong direction, and is the
  first thing to fix.
- **Test detection is path- and name-based** (`_test.go`, `*.spec.ts`,
  `Test*`). A test following neither convention is miscounted as an endangered
  dependent. The index does carry a native `TESTS` relation (272 edges in
  `entireio/cli`) which `graph impact` does not surface; using it via
  `graph neighbors --relation TESTS` would be exact.
- **Common-name symbols inflate reach** (`init`, 490 dependents). Needs
  package-qualified resolution.
- **Only the top `--top` symbols are expanded**, so a low-reach symbol with a
  subtle break is missed.
- **Runtime is ~35s** on a 28k-symbol repo for 4 symbols. Each
  `entire graph impact` reloads the index in its own process; parallelism helped
  little because the calls contend on CPU. An in-process API would fix it.
- **Checkpoint bodies are unavailable for repos you cannot administer**, which
  is why the `entireio/cli` demo runs on summary-tier intent.

**Next steps:** exact `TESTS` edges; package-qualified symbol resolution;
replace substring intent matching with symbol-aware extraction; wire the
Databricks historical multiplier.
