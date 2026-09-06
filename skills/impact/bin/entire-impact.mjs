#!/usr/bin/env node
// entire-impact: join Entire Graph blast radius with Entire Checkpoint intent.
//
// The graph knows what a change *could* break. Checkpoints know what the
// developer *said* they were touching. The finding is the gap between them.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USAGE = `Usage: entire-impact --base <rev> [options]

Options:
  --base <rev>        Base revision to diff against (required)
  --head <rev>        Head revision (default: HEAD)
  --repo <path>       Repository to analyze (default: .)
  --top <n>           Max changed symbols to expand blast radius for (default: 8)
  --json              Emit machine-readable JSON instead of the report
  --no-history        Skip the Databricks historical-risk lookup
`;

// Entity kinds worth a blast-radius expansion. Config-file "sections" and
// "keys" collide by name across the tree (a YAML `section on` reports 1610
// dependents in entireio/cli), which drowns real findings in noise.
const CODE_LANGUAGES = new Set([
  "Go", "TypeScript", "JavaScript", "Python", "Java", "Rust",
  "Ruby", "C", "C++", "C#", "Kotlin", "Swift", "PHP", "Scala",
]);
const EXPANDABLE_KINDS = new Set([
  "function", "method", "type", "struct", "interface", "class", "const", "var",
]);

function parseArgs(argv) {
  const opts = { head: "HEAD", repo: ".", top: 8, json: false, history: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--head") opts.head = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--no-history") opts.history = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || "").toString().trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
  }
}

// entire graph prints progress lines before the JSON payload on some
// subcommands, so take the last balanced object rather than the whole stream.
function runJSON(cmd, args, { allowFail = false } = {}) {
  const out = run(cmd, args, { allowFail });
  if (out == null) return null;
  const start = out.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    for (const line of out.split("\n").reverse()) {
      const t = line.trim();
      if (t.startsWith("{")) {
        try { return JSON.parse(t); } catch { /* keep scanning */ }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- step 1
// Changed entities, from the graph rather than a line diff: we want the
// symbols that changed, not the hunks.
function changedSymbols(opts) {
  const payload = runJSON("entire", [
    "graph", "diff",
    "--base", opts.base,
    "--head", opts.head,
    "--repo", opts.repo,
    "--json",
  ]);
  if (!payload) throw new Error("entire graph diff returned no JSON");

  const symbols = [];
  for (const file of payload.files ?? []) {
    const codeFile = CODE_LANGUAGES.has(file.language);
    for (const change of file.changes ?? []) {
      symbols.push({
        file: file.path,
        language: file.language,
        status: file.status,
        name: change.name,
        kind: change.kind,
        type: change.type,
        signature: change.new_signature ?? change.old_signature ?? null,
        line: change.after_start_line ?? change.before_start_line ?? null,
        dependents: change.dependents_count ?? 0,
        // Only code entities get a blast-radius expansion; config sections
        // collide by name and produce meaningless dependent counts.
        expandable: codeFile && EXPANDABLE_KINDS.has(change.kind),
      });
    }
  }
  return { symbols, raw: payload };
}

// ---------------------------------------------------------------- step 2
// Blast radius per changed symbol.
// A dependent living in a test file is coverage, not blast radius: if
// TestPushQueueForRepo calls PushQueueForRepo, that is the test protecting the
// change, not another caller endangered by it. Splitting the two is what lets
// "reaches 36 callers, none of them tests" be a finding.
const TEST_FILE = /(^|\/)(tests?|spec|e2e)\/|_test\.(go|py|rb)$|[._](test|spec)\.(ts|tsx|js|jsx|mjs)$|(^|\/)test_[^/]+\.py$/i;

function isTest(entry) {
  return TEST_FILE.test(entry.file ?? "") || /^Test[A-Z_]/.test(entry.name ?? "");
}

// Sections that mean "something else depends on this". `callees` is excluded
// on purpose: what a symbol calls is not endangered by changing it.
const DEPENDENT_SECTIONS = ["callers", "type_consumers", "data_flows"];

function blastRadius(payload, sym) {
  if (!payload) {
    return { dependents: [], tests: [], total: sym.dependents, unresolved: true, coChanges: [] };
  }

  const dependents = [];
  const tests = [];
  const seen = new Set();
  let total = 0;

  for (const section of DEPENDENT_SECTIONS) {
    const block = payload[section];
    if (!block) continue;
    total += block.total ?? 0;

    for (const raw of block.entries ?? []) {
      // Entries wrap the symbol in `endpoint`; the outer object carries the
      // relation metadata.
      const e = raw.endpoint ?? raw;
      const name = e.name ?? e.qualified_name;
      if (!name) continue;

      const key = `${e.file_path ?? ""}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = {
        name,
        file: e.file_path ?? null,
        line: e.start_line ?? null,
        kind: e.kind ?? null,
        section,
        depth: raw.depth ?? raw.hop ?? null,
      };
      (isTest(entry) ? tests : dependents).push(entry);
    }
  }

  // File-level co-change from the local graph. Thin by construction (the
  // whole entireio/cli index carries only 195 FILE_CHANGES_WITH edges), which
  // is precisely the gap the Databricks history table fills at symbol level.
  const coChanges = (payload.co_changes?.entries ?? []).map((raw) => {
    const e = raw.endpoint ?? raw;
    return { name: e.name ?? e.file_path, file: e.file_path ?? null };
  });

  return { dependents, tests, total, unresolved: false, coChanges };
}

// ---------------------------------------------------------------- step 3
// What the developer said they were doing, from checkpoint context.
// Intent must be scoped to the commits under review. The whole branch's
// checkpoint history describes work this diff never touched, and folding it in
// would make unrelated symbols look "acknowledged" - failing to report a real
// risk is the expensive direction of this error.
const MAX_COMMITS = 25;

function checkpointIntent(opts) {
  const log = run("git", [
    "-C", opts.repo, "log", "--format=%H", `${opts.base}..${opts.head}`,
  ], { allowFail: true });

  const commits = (log ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!commits.length) {
    return { available: false, reason: "no commits in range", text: "", commits: [], resolved: 0 };
  }

  const parts = [];
  const detail = [];
  let resolved = 0;

  for (const sha of commits.slice(0, MAX_COMMITS)) {
    const body = run("entire", [
      "checkpoint", "explain", "--commit", sha,
    ], { allowFail: true });

    // A commit with no Entire trailer, or whose checkpoint body is not
    // present locally, contributes nothing. Both print to stdout on the
    // failure path, so detect them by content rather than exit status.
    const usable = body
      && !/No associated Entire checkpoint/i.test(body)
      && !/checkpoint not found|failed to read checkpoint/i.test(body);

    if (usable) {
      resolved++;
      parts.push(body);
    }
    detail.push({ sha: sha.slice(0, 9), resolved: Boolean(usable) });
  }

  // Tier 2: full transcript bodies are only readable in a repo whose
  // checkpoint remote you can reach. On a repo you can read but not
  // administer, the condensed summaries still list per-commit, and they are
  // genuine checkpoint context - just shorter.
  let source = "transcript";
  if (resolved === 0) {
    const inRange = new Set(commits.map((c) => c.slice(0, 7)));
    const listing = run("entire", ["checkpoint", "list"], { allowFail: true }) ?? "";
    for (const line of listing.split("\n")) {
      const m = line.match(/^\s+\d\d-\d\d\s+\d\d:\d\d\s+\(([0-9a-f]{7,40})\)\s+(.+)$/);
      if (!m) continue;
      if (!inRange.has(m[1].slice(0, 7))) continue;
      resolved++;
      parts.push(m[2]);
    }
    if (resolved) source = "summary";
  }

  return {
    available: resolved > 0,
    source: resolved > 0 ? source : null,
    reason: resolved > 0
      ? null
      : "no checkpoint context resolvable for the commits in range",
    text: parts.join("\n").toLowerCase(),
    commits: detail,
    resolved,
    total: commits.length,
  };
}

// ---------------------------------------------------------------- step 4
// The join. A dependent the intent never names is one the developer
// probably never saw.
function acknowledged(intent, name) {
  if (!intent.available || !name) return false;
  return intent.text.includes(name.toLowerCase());
}

function scoreFinding(f) {
  // Structural reach, then penalties for the two things that make reach
  // dangerous: nobody mentioned it, and nothing tests it.
  let score = Math.min(f.dependentCount, 50) / 50 * 40;
  // Scale by *how much* of the radius went unmentioned, not merely whether
  // any did - one unnamed caller out of 36 is not the same risk as 36 of 36.
  if (f.resolvedDependents) {
    score += 35 * Math.min(f.unacknowledgedCount / f.resolvedDependents, 1);
  }
  if (!f.tests.length) score += 25;
  if (f.historicalRisk != null) score = score * (1 + f.historicalRisk);
  return Math.round(score);
}

// Each `entire graph impact` call is a ~5s subprocess against a warm index;
// run sequentially, eight symbols cost 40s, which is too slow to sit through
// in a review loop.
function parseJSONLoose(out) {
  if (!out) return null;
  const start = out.indexOf("{");
  if (start === -1) return null;
  try { return JSON.parse(out.slice(start)); } catch { return null; }
}

async function impactPayloads(symbols, opts) {
  const jobs = symbols.map(async (sym) => {
    const args = [
      "graph", "impact",
      "--repo", opts.repo,
      "--format", "json",
      "--symbol", sym.line ? `${sym.file}:${sym.line}` : sym.name,
    ];
    try {
      const { stdout } = await execFileAsync("entire", args, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      return parseJSONLoose(stdout);
    } catch {
      // Ambiguous or unresolvable symbol; the caller degrades to the
      // dependent count the diff already gave us.
      return null;
    }
  });
  return Promise.all(jobs);
}

async function analyze(opts) {
  const { symbols } = changedSymbols(opts);
  const intent = checkpointIntent(opts);

  const expandable = symbols
    .filter((s) => s.expandable)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, opts.top);

  const payloads = await impactPayloads(expandable, opts);

  const findings = [];
  for (const [i, sym] of expandable.entries()) {
    const radius = blastRadius(payloads[i], sym);
    // With no checkpoint context every dependent would look "unacknowledged",
    // which is a fabricated finding rather than a real one. Report the
    // structural radius alone and say so.
    const unack = intent.available
      ? radius.dependents.filter((d) => !acknowledged(intent, d.name))
      : [];
    const finding = {
      // Ratio denominator: every dependent we actually resolved a name for,
      // not the truncated display list.
      resolvedDependents: radius.dependents.length,
      symbol: sym.name,
      kind: sym.kind,
      file: sym.file,
      line: sym.line,
      changeType: sym.type,
      signature: sym.signature,
      dependentCount: radius.total || radius.dependents.length || sym.dependents,
      dependents: radius.dependents.slice(0, 10),
      unacknowledged: unack.slice(0, 10),
      unacknowledgedCount: unack.length,
      tests: radius.tests.slice(0, 10),
      coChanges: radius.coChanges.slice(0, 5),
      unresolved: radius.unresolved,
      historicalRisk: null,
      intentAvailable: intent.available,
    };
    finding.risk = scoreFinding(finding);
    findings.push(finding);
  }

  findings.sort((a, b) => b.risk - a.risk);

  return {
    base: opts.base,
    head: opts.head,
    repo: opts.repo,
    changedSymbols: symbols.length,
    expandedSymbols: expandable.length,
    intent,
    findings,
  };
}

function report(result) {
  const lines = [];
  lines.push(`Entire Impact: ${result.base}..${result.head}`);
  lines.push("");
  lines.push(
    `${result.changedSymbols} changed entities, ` +
    `${result.expandedSymbols} code symbols expanded.`,
  );

  if (!result.intent.available) {
    lines.push(
      `! ${result.intent.reason} - findings are STRUCTURAL ONLY, and the ` +
      "acknowledged/unacknowledged split is unavailable.",
    );
  } else {
    const src = result.intent.source === "summary"
      ? "checkpoint summaries (transcript bodies unavailable for this repo)"
      : "checkpoint transcripts";
    lines.push(
      `Intent read from ${src}: ${result.intent.resolved} of ` +
      `${result.intent.total} commit(s) in range.`,
    );
  }
  lines.push("");

  if (!result.findings.length) {
    lines.push("No code symbols with a resolvable blast radius changed.");
    return lines.join("\n");
  }

  for (const f of result.findings) {
    lines.push(`[risk ${f.risk}] ${f.symbol} (${f.kind}, ${f.changeType})`);
    lines.push(`  at ${f.file}:${f.line ?? "?"}`);
    lines.push(`  blast radius: ${f.dependentCount} dependent(s)`);

    if (f.unacknowledged.length) {
      lines.push(`  UNACKNOWLEDGED (${f.unacknowledgedCount}) - reached by this change, never named in checkpoint intent:`);
      for (const d of f.unacknowledged.slice(0, 5)) {
        lines.push(`    - ${d.name}  ${d.file ?? "?"}:${d.line ?? "?"}`);
      }
    } else if (f.intentAvailable && f.dependentCount) {
      lines.push("  all dependents were named in checkpoint intent");
    }

    if (f.tests.length) {
      lines.push(`  covering tests: ${f.tests.map((t) => t.name).slice(0, 5).join(", ")}`);
    } else {
      lines.push("  NO COVERING TESTS in the graph");
    }

    if (f.historicalRisk != null) {
      lines.push(`  historical risk multiplier: ${f.historicalRisk.toFixed(2)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || !opts.base) {
    process.stdout.write(USAGE);
    process.exit(opts.base ? 0 : 2);
  }

  analyze(opts).then((result) => {
    process.stdout.write(opts.json ? JSON.stringify(result, null, 2) : report(result));
    process.stdout.write("\n");
  }).catch((err) => {
    process.stderr.write(`entire-impact: ${err.message}\n`);
    process.exit(1);
  });
}

main();
