# Multi-Harness Session Watcher — Design

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Scope:** Subsystem **A** (observer / read-only). Subsystem **B** (merge & transfer
sessions between harnesses) is explicitly out of scope here and gets its own
spec later.

## Goal

Add an interactive terminal view to `claude-dash-cli` that shows **currently
running and recently finished sessions across harnesses (Claude Code + Codex),
the agents working inside each session, and their subagents**, as a live tree
with per-node token usage and consumption against the usage-window limit.

## Non-Goals (YAGNI)

- Merging or transferring sessions between harnesses (subsystem B, separate spec).
- Browsing the full multi-month session history (only live + recent window).
- Dollar-cost estimation and tokens/sec throughput (not selected by the user).
- `fs.watch`-based eventing (polling is sufficient and simpler).

## Grounded facts about on-disk data

Verified against real transcripts on this machine (2026-07-02), not assumed:

### Claude Code — hierarchical

```
~/.claude/projects/<slug>/
  <session-id>.jsonl                 # parent session transcript
  <session-id>/subagents/
    agent-<agentId>.jsonl            # one file per subagent
```

Each subagent JSONL line carries: `sessionId` (**parent** session id),
`agentId`, `isSidechain: true`, `attributionAgent` (the agent *type*, e.g.
`general-purpose`, `Explore`), `sourceToolAssistantUUID` (links back to the
`tool_use` in the parent that spawned it), `cwd`, `gitBranch`, `timestamp`.
Parent transcripts contain `tool_use` blocks with `name: "Agent"` and assistant
messages with `uuid`. Token usage lives on `message.usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`).

**Correctness constraint:** because subagent lines carry the *parent's*
`sessionId`, usage MUST be attributed by `agentId` / file, not by `sessionId`.
Grouping by `sessionId` (as the current `reflect.js` does) silently merges
subagent tokens into the parent.

### Codex — flat, single-agent

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<session-uuid>.jsonl
```

Each line is an envelope `{type, timestamp, payload}`. `type` values observed:
`session_meta` (one per file, session metadata), `response_item`, `event_msg`,
`turn_context`, `compacted`. Contains `function_call` entries but **no**
`isSidechain` / agent / subagent markers. Codex sessions are therefore flat:
one session, one agent, no children.

**Design implication:** the normalized model must accommodate both a harness
with an agent tree (Claude) and a harness with flat sessions (Codex). The two
schemas are incompatible at the line level — a fact that also defines the
difficulty of future subsystem B (format translation, not file copy).

## Liveness

There is no process PID on disk. Status is derived from file `mtime`:

- **LIVE** — mtime within ~30s (actively being written)
- **IDLE** — mtime between 30s and the recent-window boundary
- **DONE** — within the recent window but older (shown greyed)

Recent window defaults to 6h, configurable via flag. This is an
mtime heuristic ("recently written"), not a guarantee the process is alive —
documented as such in the UI/help.

## Architecture

New subcommand `claude-dash-cli watch` (Ink app). Existing `dashboard` and
`reflect` subcommands are untouched. Node.js; adds `ink` (+ React) to
`package.json` — a deliberate departure from the current zero-dependency
posture, chosen because the interactive-navigator UX warrants it.

**Build-step constraint.** The project currently has no build step, but JSX
requires a transform. To preserve "no build step", the Ink components use
`htm` + `React.createElement` (tagged-template JSX-alike) rather than real
`.jsx` syntax — so files stay plain `.js` runnable by Node directly. The
`*.jsx` filenames in the layout below are illustrative of role; actual files
are `.js`. (Alternative, if we later accept a build step: an `esbuild`
JSX transform. Not chosen for the MVP.)

```
src/harness/
  index.js      # adapter registry; common interface discoverSessions(window)
  claude.js     # Claude Code adapter (hierarchical)
  codex.js      # Codex adapter (flat sessions)
src/model/
  tree.js       # normalized Session/AgentNode types + usage roll-up
src/watch/
  poller.js     # polls adapters every ~2s, incremental re-read
  App.jsx       # root Ink component; key handling
  TreeView.jsx  # tree render + selection/expansion
  DetailPane.jsx# drill-in: metadata + tail of selected node's transcript
  StatusBar.jsx # legend, window, aggregate usage / % of limit
src/usage.js    # reused as-is for the limit engine
```

### Harness adapter interface (the key abstraction)

Both harnesses implement:

```
discoverSessions(window) -> Session[]
```

This single interface is what makes multi-harness support clean and pre-stages
subsystem B (any future transfer works through the normalized model, not raw
files).

- **claude.js** — top-level `<slug>/<session>.jsonl` = sessions;
  `<slug>/<session>/subagents/agent-*.jsonl` = children. Tree built from
  `agentId` + `attributionAgent` + `sourceToolAssistantUUID`. Usage from
  `message.usage`, attributed per `agentId`.
- **codex.js** — `~/.codex/sessions/**/rollout-*.jsonl`, flat (no children).
  `session_meta` → metadata; usage aggregated from `response_item`/`event_msg`.
  Missing `~/.codex` → adapter yields nothing (no crash).

### Normalized model

```
Session/AgentNode {
  harness: 'claude' | 'codex',
  id, cwd, project, model,
  kind: 'session' | 'agent' | 'subagent',
  agentType,                 // Claude: attributionAgent; Codex: null
  status: 'live' | 'idle' | 'done',
  startedAt, lastActivity,
  usage:  { in, out, cacheCreate, cacheRead },   // node's own contribution
  rollup: { in, out, cacheCreate, cacheRead },   // own + sum(children)
  children: AgentNode[],
}
```

Usage roll-up: `rollup = own + Σ children.rollup`.

## Data flow

`poller` (every ~2s) → `adapters.discoverSessions(window)` → normalized trees →
Ink app state → render. Polling, not `fs.watch`, to match the existing
1s loop and keep it simple. MVP re-reads a changed file whole and re-parses
it, memoised by `(size, mtimeMs)` so unchanged files are never re-read.
**Deferred follow-up:** incremental tail-parse of only the appended byte
range, plus cache eviction for deleted transcripts — needed before a very
large actively-written rollout (13 MB observed) is watched at the 2s poll
cadence.

## Interaction (Ink)

Interactive navigator:

- `↑`/`↓` — move selection
- `→` / `Enter` — expand node
- `←` — collapse node
- `d` — toggle detail pane (metadata + tail of selected node's transcript)
- `q` — quit

Live data updates from the poller merge into state without disturbing the
current selection/expansion.

## Usage display

Per node: token counts `in / out / cache` (own + roll-up) and **% of the
usage-window limit** computed via the existing `usage.js` engine. `StatusBar`
shows aggregate usage across all live sessions and remaining headroom to the
limit.

## Error handling

- Missing harness directory → adapter yields nothing, no crash.
- Malformed / truncated final JSONL line (file being written) → skip line,
  continue parsing.
- Large rollout files → whole-file re-read memoised by `(size, mtimeMs)`, so
  an unchanged file is never re-read. Incremental tail-parse (only the
  appended byte range) is a deferred follow-up, not yet implemented.

## Testing

- Adapters are pure functions over a fixtures directory (extends the existing
  `tests/fixtures/projects` pattern; add Codex rollout fixtures). Test:
  tree building, usage roll-up, liveness classification with an injected `now`.
- Ink components tested via `ink-testing-library`.

## Open defaults (confirmed with user)

- Subcommand name: `watch`.
- Recent window default: 6h.
- Codex adapter is flat (no children) — matches on-disk reality.
