# Design: `claude-dash-cli reflect` subcommand

**Date:** 2026-04-19
**Status:** Approved, awaiting implementation plan
**Authors:** user + assistant (brainstorming session)

## Problem

The live dashboard (`claude-dash-cli`, no args) answers *"how close am I to a limit?"* It doesn't help the user reflect on how they use Claude over time — where money goes, whether sessions are productive, which projects dominate, how healthy their interaction patterns are.

We need a retrospective one-shot analyzer that scans local Claude Code transcripts and correlated git history, produces a structured metrics document, and renders a narrative ANSI report by default. The document must be stable-schema so it can later be stored, diffed, and shared (like GitHub's contributions graph).

## Scope

### In scope for v1
- New subcommand `claude-dash-cli reflect [section] [--since <spec>] [--format <ansi|json>]`
- Default time window: last 30 days
- Compute a versioned JSON metrics document
- Render the document as an ANSI narrative report (one scroll, pipeable to `less`)
- Alternative: `--format json` emits the raw document
- Five sections: overview, spend, flow, quality, projects
- Pure local data: `~/.claude/projects/*/*.jsonl` transcripts + `git log` per `cwd`

### Explicit non-goals for v1
- Interactive TUI navigation (keyboard-driven views). Rejected — too much plumbing for the value; `less` + scroll is fine.
- Persistent scan cache. First run on a 30-day window is a few seconds; fine without caching. Add when all-time scans become routine.
- Data anonymization and upload/share features. Deferred to v2 once the v1 schema has stabilized through real use.
- Cross-tool compatibility / schema standardization. Deferred; we'll publish the schema in v1 but not commit to it being an ecosystem spec yet.

## Architecture

```
src/reflect.js         orchestrator + argv parsing
src/metrics.js         compute: produces the MetricsDocument
src/stats-extended.js  extends scan() with daily buckets + cwd tracking
src/git-stats.js       git log scanning per cwd, correlated with session spans
src/pricing.js         model → $/M-token table (user-maintained)
src/sparkline.js       ANSI chart primitives
src/reflect-render.js  ANSI renderer over MetricsDocument
src/index.js           subcommand dispatcher
```

### Data flow

```
argv → parse → { since, until, section, format }
              │
              ├─► metrics.compute({ since, until })   [pure, deterministic]
              │     ├── stats-extended.scan()
              │     ├── git-stats.scan(cwdSet)
              │     └── pricing.estimate(byModel)
              │     returns MetricsDocument
              │
              └─► if format==='json' → JSON.stringify(doc) → stdout
                  else              → reflect-render.render(doc, section) → stdout
```

Compute is pure and deterministic given the same input files — no I/O in the render layer. This separation is the load-bearing design decision for future shareability.

## MetricsDocument schema (v1.0.0)

All fields mandatory unless marked optional.

```json
{
  "schemaVersion": "1.0.0",
  "tool": "claude-dash-cli",
  "toolVersion": "0.2.0",
  "generatedAt": "2026-04-19T12:00:00.000Z",
  "window": {
    "since": "2026-03-20T00:00:00.000Z",
    "until": "2026-04-19T12:00:00.000Z",
    "label": "last 30 days"
  },
  "overview": {
    "sessions": 87,
    "messages": 12408,
    "projects": 14,
    "estCostUsd": 127.42,
    "dailyMessages": [12, 34, 56, ...],
    "dailyTokens":   [10234, 20123, ...]
  },
  "spend": {
    "estCostUsd": 127.42,
    "byModel": {
      "claude-opus-4-7": {
        "messages": 390,
        "inputTokens": 675,
        "outputTokens": 298402,
        "cacheReadTokens": 91253621,
        "cacheCreationTokens": 2844086,
        "costUsd": 98.21
      }
    },
    "cacheHitRatio": 0.75,
    "cacheHitRatioDaily": [0.62, 0.78, ...],
    "topTools": [
      { "name": "Bash", "count": 412 }
    ],
    "mcpServers": { "playwright": 38, "context7": 6 }
  },
  "flow": {
    "sessionDurationBuckets": {
      "labels": ["<5m", "5-15m", "15-60m", "1-3h", ">3h"],
      "counts": [10, 20, 30, 15, 5]
    },
    "medianSessionMinutes": 24,
    "medianUserTurnsPerSession": 12,
    "medianIdleGapSeconds": 18,
    "timeOfDayHeatmap": {
      "shape": [7, 24],
      "data": [[0,0,...], [...], ...]
    },
    "projectThrashDaily": [1, 2, 3, ...]
  },
  "quality": {
    "sessionsWithCommits": 62,
    "sessionCommitRatio": 0.71,
    "linesAdded": 15234,
    "linesDeleted": 3421,
    "topFiles": [
      { "path": "src/auth.js", "edits": 12 }
    ],
    "revertRatio": 0.03,
    "revertCount": 2
  },
  "projects": [
    {
      "cwd": "/home/cypher/Projects/foo",
      "sessions": 12,
      "messages": 512,
      "tokens": 4200000,
      "commits": 18,
      "topModel": "claude-opus-4-7",
      "costUsd": 42.10
    }
  ]
}
```

### Field semantics

- **`generatedAt`** — ISO-8601 UTC. Produced at compute time.
- **`window.since`/`until`** — ISO-8601 UTC. The exact time range analyzed.
- **`overview.dailyMessages`/`dailyTokens`** — arrays of length `(until - since) / 86400000` rounded up, aligned to UTC-midnight buckets. Sparkline-ready.
- **`spend.cacheHitRatio`** — `cache_read / (cache_read + cache_creation + input)` across all messages in the window.
- **`spend.byModel[*].costUsd`** — computed from `pricing.js`. Accuracy depends on user-maintained price table.
- **`flow.timeOfDayHeatmap.data`** — 7×24 matrix: row = day-of-week (0 = Sunday), column = hour-of-day (0–23, local time). Cell = count of assistant messages.
- **`flow.projectThrashDaily`** — array length = days in window, value = count of distinct `cwd` values that had ≥1 message that day.
- **`quality.sessionsWithCommits`** — sessions where at least one commit exists in the session's `cwd` git repo within ±1 hour of session end time. Session end time = timestamp of last message in the transcript.
- **`quality.revertRatio`** — `revertCount / totalCommitsInWindow`. Commits matching `^(revert|fixup!|fix:|hotfix)`.
- **`quality.topFiles`** — top 10 by `tool_use` arguments where the tool is `Edit`/`Write`/`Read` and `file_path` is set. Resolved to absolute paths (caveat: anonymization deferred to v2).
- **`projects[*].topModel`** — the model with the most messages within that `cwd`.

### Schema stability guarantee

v1.0.0 is the first tagged schema. Future versions follow semver:
- **Patch (1.0.x):** bug fixes; no field additions or semantics changes.
- **Minor (1.x.0):** additive only (new optional fields, new sections). Older consumers must ignore unknown fields.
- **Major (2.0.0):** breaking changes. Consumers must check `schemaVersion`.

## Command surface

```
$ claude-dash-cli reflect
  → 30-day ANSI narrative report

$ claude-dash-cli reflect --since 7d
$ claude-dash-cli reflect --since 90d
$ claude-dash-cli reflect --since 2026-01-01
$ claude-dash-cli reflect --since all

$ claude-dash-cli reflect --format json > metrics.json
  → raw MetricsDocument JSON

$ claude-dash-cli reflect spend
  → only the spend section (filters rendering; compute still full)

$ claude-dash-cli reflect --help
```

## Sections (rendering)

### Overview (~15 lines)
Header with window label, date range. Four KPIs (sessions, messages, projects, $cost). Two full-width sparklines: messages/day, tokens/day.

### Spend (~25 lines)
Total $ with per-model horizontal bars. Cache hit ratio with qualitative interpretation ("75% — excellent", "42% — context churn"). Top 10 tools with invocation bars. MCP server list.

### Flow (~20 lines)
Session duration histogram (ASCII buckets). Median session length, median user turns. 7×24 time-of-day heatmap using `·░▒▓█` intensity, dim-gray-to-cyan color ramp. Project thrash sparkline.

### Quality (~15 lines)
Sessions-with-commits ratio. Lines ±. Top 10 most-edited files. Revert/fixup rate.

### Projects (~20 lines)
Sorted table of top 10 projects by tokens. Columns: project (basename of cwd), sessions, tokens, commits, top model, cost.

## Git correlation details

For each unique `cwd` extracted from transcripts in the window:
1. Check if `cwd/.git` exists (skip non-repos silently).
2. `git -C <cwd> log --since=<since> --until=<until> --pretty=format:"%H|%aI|%s" --shortstat`
3. Parse commits; extract timestamp, subject, ±lines.
4. Build session-end → nearest-commit map, within ±1h.
5. Aggregate across projects.

Runs per-project in parallel (`Promise.all`). Bounded concurrency (~8 repos at once). Graceful fallback if `git` binary is unavailable: quality/projects sections display "(git unavailable)".

## Pricing table

`src/pricing.js` exports a model-name-prefix keyed table:

```js
// Last updated: 2026-04-19 — verify against Anthropic's published pricing.
module.exports = {
  'claude-opus-4':   { input: 15, output: 75, cacheRead: 1.5,  cacheCreation: 18.75 },
  'claude-sonnet-4': { input: 3,  output: 15, cacheRead: 0.3,  cacheCreation: 3.75 },
  'claude-haiku-4':  { input: 1,  output: 5,  cacheRead: 0.1,  cacheCreation: 1.25 },
  // Unknown models → best-effort estimate using the Opus rate (most conservative)
};
```

All values in dollars per million tokens. The file is explicitly user-maintained; the spec makes no claim about correctness beyond "good enough to roughly rank spend across models."

## Error handling

- Transcript parse errors: skip line, increment a `parseErrors` counter surfaced in a stderr diagnostic at the end (not in the document).
- Git unavailable: set quality/projects sections to empty/flagged; continue.
- Empty window (no messages): print a friendly "No activity in this window" and exit 0 without a document.
- `--format json` with empty window: emit a document with zero-valued fields and the window metadata.

## Testing

Targeted tests to add (no existing framework yet — start with plain Node `assert`):
1. `metrics.compute` over a fixture transcript yields a known document.
2. `git-stats.scan` with a temp repo: commits inside/outside window, revert patterns.
3. Sparkline renders expected Unicode for a known input array.
4. Pricing estimator: known token counts → known $cost.
5. Schema round-trip: compute → JSON.stringify → JSON.parse → assert shape.

## Open items

- **Session end time definition** — last message timestamp. Works for sessions that conclude naturally; for interrupted sessions the correlation window (±1h) will either catch a later commit or not. Accept this looseness.
- **Top-file resolution** — absolute paths. Anonymization in v2 will replace with `{project}/{relative}` or a hash.
- **Parallelism ceiling** — 8 concurrent git scans. If that causes problems on very large histories, lower to 4. No knob exposed in v1.

## Future (v2+)

- `--anonymize` flag: SHA-256 truncated hashes for cwd, file paths; strip commit subjects.
- `--upload` / `--share`: POST signed document to a configurable endpoint.
- Detached schema spec at a public location for third-party consumers.
- GitHub-contributions-style square-grid renderer for daily buckets.
- Session-over-session diff view (`reflect diff HEAD~1`).
- Persistent scan cache keyed by file mtime for fast all-time queries.
