---
name: impact
description: >
  Assess the risk of a change by joining Entire Graph blast radius with Entire
  Checkpoint intent, then run only the tests that cover what actually changed.
  Use when the user asks whether a change is safe to merge, what a change might
  break, what the blast radius or impact of an edit is, which tests to run for
  a change, or asks for a release-readiness or change-risk assessment.
argument-hint: [base-ref]
---

# Entire Impact

Assess change risk by combining two sources of evidence that are weak alone:

- **Entire Graph** knows what a change *could* break — the callers, type
  consumers and data flows that reach the edited symbol.
- **Entire Checkpoints** know what the developer *said* they were doing — the
  reasoning, assumptions and symbols they actually considered.

The finding this skill produces is **the gap between them**: dependents that the
change structurally reaches but that the developer's recorded intent never
mentions. Those are the callers nobody looked at.

## Response Format

Begin the first response to this skill invocation with the line:

`Entire Impact:`

followed by a blank line, then the content.

- Apply the header to the **first response of the invocation only.**
- Do **not** include the header on error or early-exit responses.

## Rules

1. This is a **read-only assessment**. Do not modify source files.
2. **Never present a graph result as fact without a citation.** Every finding
   must carry `file:line` for the dependent, so the user can verify it.
3. If checkpoint context is unavailable for the range, say so and report the
   structural radius only. Do **not** report "unacknowledged" dependents when
   there is no intent to compare against — with no intent, everything looks
   unacknowledged, and that is a fabricated finding.
4. Report partial coverage honestly: if 3 of 12 commits resolved to
   checkpoints, say "3 of 12".
5. A high dependent count is not automatically a problem. Rank by the
   combination of reach, unacknowledged dependents and missing tests.
6. Do not auto-fix. After presenting findings, offer the test run.

## Process

### 1. Verify environment

Run `entire graph version`. If the graph plugin is missing, stop and tell the
user to run `entire plugin install graph` — this skill cannot degrade to a
useful result without it.

Run `entire checkpoint list` to confirm checkpoint context exists. If it does
not, continue in **structural-only mode** and state that clearly.

### 2. Determine the base ref

Use the argument if given. Otherwise infer the branch point:

```bash
git merge-base HEAD origin/main
```

Fall back to `HEAD~1` for a single-commit assessment.

### 3. Run the analysis

```bash
node skills/impact/bin/entire-impact.mjs --base <base> --repo . --json
```

The helper performs the graph→checkpoint join deterministically so the result
is reproducible rather than re-derived by the agent each run. It:

1. Calls `entire graph diff` for entity-level changed symbols
2. Expands each code symbol with `entire graph impact`
3. Reads intent from `entire checkpoint explain --commit <sha>` for the
   commits in range
4. Splits the radius into dependents vs covering tests
5. Marks dependents whose names never appear in the intent text

### 4. Present findings

Order by risk score. For each finding show:

- the changed symbol, its kind and `file:line`
- the blast radius size
- **unacknowledged dependents** with `file:line` for each
- covering tests, or an explicit "no covering tests in the graph"

### 5. Verify before asserting

Graph output is evidence, not an oracle. Before presenting a high-risk finding,
open the cited `file:line` and confirm the dependency is real. If a citation
does not check out, drop the finding and say why.

### 6. Offer the narrow test run

Propose running only the covering tests the graph identified, rather than the
whole suite:

```bash
entire graph verify --command "<narrowest test command>"
```

Ask before running. Report the adjudicated verdict.

## Interpreting the score

The risk score weighs three signals:

| Signal | Weight | Meaning |
| --- | --- | --- |
| Blast radius size | up to 40 | how far the change structurally reaches |
| Unacknowledged share | up to 35 | how much of that reach went unmentioned |
| No covering tests | 25 | nothing would catch a regression |

A historical-risk multiplier is applied when the Databricks history table is
configured; see `references/history.md`. When it is unavailable the score is
structural only and the report says so.

## Limitations

- Test detection is **path- and name-based** (`_test.go`, `*.spec.ts`,
  `Test*`). A test that follows neither convention is counted as a dependent.
- Name matching against intent text is **substring, case-insensitive**. A
  short or common symbol name can match incidentally and be marked
  acknowledged when it was not. Verify before acting on a clean result.
- Config-file entities (YAML sections, JSON keys) are excluded from expansion:
  they collide by name across the tree and produce meaningless dependent
  counts.
- Only the top `--top` symbols by dependent count are expanded, so a
  low-reach symbol with a subtle break can be missed.
