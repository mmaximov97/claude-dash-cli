# claude-dash-cli

Terminal dashboard for Claude usage limits. Made for a tmux pane.

Fork of [claude-dash](https://github.com/adelhelalpro-ai/claude-dash) — same prediction engine (EWMA + multi-horizon consensus), no Electron, zero dependencies.

## Requirements

- Node.js ≥ 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`~/.claude/.credentials.json` must exist). The CLI shares tokens with Claude Code — no separate login.

## Install

```bash
cd claude-dash-cli
chmod +x bin/claude-dash-cli
npm link        # optional: exposes `claude-dash-cli` globally
```

Or just run directly:

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
