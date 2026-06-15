# claude-dash-cli

Terminal dashboard for Claude usage limits. Made for a tmux pane.

Fork of [claude-dash](https://github.com/adelhelalpro-ai/claude-dash) — same prediction engine (EWMA + multi-horizon consensus), no Electron, zero dependencies.

## What it looks like

A live text capture of the dashboard (`node src/index.js`, 80-column pane):

```text
claude-dash-cli  11:17:45  (polls every 5m)

5H         ████░░░░░░░░░░░░░░░░░░░░░  15.0% reset 3h12m  eta 3h33m ○
7D         █░░░░░░░░░░░░░░░░░░░░░░░░   2.0% reset 2d2h  eta — ·
Sonnet 7D  ░░░░░░░░░░░░░░░░░░░░░░░░░   0.0% reset now  eta — ·

────────────────────────────────────────────────────────────
Today  (4 sessions, 314 msgs, scan 57ms)
tokens  in 231.7k  out 433.6k  cache+ 1.0M  cache_rd 20.7M
tools   Bash 67  Read 17  Agent 10  Edit 9  ToolSearch 7
mcp     playwright 13
skills  bugreport-to-tasks 1  skill-creator:skill-creator 1  skill-creator 1
models  opus-4 1.7M / 313m  <synthetic> 0 / 1m

extra usage: off
```

The top block is your **plan limits** (live from the usage API); the bottom block is **today's local activity** scanned from your `~/.claude` transcripts. In a real terminal the bars are color-ramped green→yellow→red and a `WARNING`/`CRITICAL` strip appears once a limit crosses 80% / 95%.

## Why

You're coding in the terminal and you don't want to discover you've hit a usage wall mid-task. claude-dash-cli answers two questions at a glance, without leaving tmux:

- **How much runway is left?** — utilization per rolling window (5H / 7D / per-model), the reset countdown, and an EWMA-predicted **ETA to 100%** so you can pace a long session or take a break before a hard stop.
- **Where did today's budget go?** — tokens, top tools, MCP servers, skills, and models pulled straight from your transcripts, so you can see what's actually burning context.

It's a single always-on pane: zero dependencies, shares Claude Code's login (no separate auth), and stays out of the way until a limit gets close.

## Requirements

- Node.js ≥ 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`~/.claude/.credentials.json` must exist). The CLI shares tokens with Claude Code — no separate login.

## Install

To run `claude-dash-cli` from **any directory**, link it globally:

```bash
cd claude-dash-cli
chmod +x bin/claude-dash-cli
npm link
```

`npm link` symlinks the `bin` entry into your global npm path (already on `PATH`), so edits to `src/` are picked up live — no reinstall needed. Then run it anywhere:

```bash
claude-dash-cli
```

Verify the link:

```bash
which claude-dash-cli   # prints the symlink path
```

> **nvm note:** the symlink lives under the active Node version. If you `nvm use` a different version, re-run `npm link` there. To remove it later: `npm unlink -g claude-dash-cli`.

Or skip linking and run directly:

```bash
node src/index.js
```

## Use in tmux

```bash
# split a narrow right pane and run the dashboard there
tmux split-window -h -p 30 'claude-dash-cli'
```

The dashboard:
- Polls `https://api.anthropic.com/api/oauth/usage` every 5 min (endpoint rate-limits to ~5 req/token — don't reduce this).
- Redraws every 1 s so the "resets in" and "ETA" countdowns stay live between fetches.
- Rotates the OAuth token on 429 (per-token rate limit → fresh token resets it).
- Persists prediction history to `~/.config/claude-dash-cli/history.json` (24 h rolling).

## Layout

Displayed limits (whichever your plan exposes):
- `5H`  — 5-hour rolling window
- `7D`  — 7-day rolling window
- `Opus 7D` / `Sonnet 7D` / `Cowork 7D` — model-specific 7-day windows

Each row shows utilization, the rolling-window reset countdown, and the EWMA-predicted ETA to 100%. Confidence glyph: `●` high, `◐` medium, `○` low, `·` not enough data yet.

## Customizing the display

Two places in `src/render.js` are marked `TODO (you):` —

1. **`renderRow(key, limit, width)`** — the per-limit line format. Swap in your preferred layout (compact vs wide, bar width, color ramp, glyphs).
2. **`renderBanner(highest, width)`** — what shows when a limit crosses 80% / 95%. Full-width strip? Inline badge? Blinking?

The stub implementations work, but the whole point of the fork is that these are yours to shape.

## License

MIT (inherited from upstream).
