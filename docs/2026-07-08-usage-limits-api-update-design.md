# Usage limits API update — design

## Background

Anthropic changed the shape of the `GET /api/oauth/usage` response. Confirmed live against the real endpoint (2026-07-08):

```json
{
  "five_hour": {"utilization": 23.0, "resets_at": "...", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null},
  "seven_day": {"utilization": 3.0, "resets_at": "...", ...},
  "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_cowork": null,
  "seven_day_oauth_apps": null, "seven_day_omelette": null, "tangelo": null,
  "iguana_necktie": null, "omelette_promotional": null, "nimbus_quill": null,
  "cinder_cove": null, "amber_ladder": null,
  "limits": [
    {"kind": "session", "group": "session", "percent": 23, "severity": "normal",
     "resets_at": "...", "scope": null, "is_active": true},
    {"kind": "weekly_all", "group": "weekly", "percent": 3, "severity": "normal",
     "resets_at": "...", "scope": null, "is_active": false},
    {"kind": "weekly_scoped", "group": "weekly", "percent": 1, "severity": "normal",
     "resets_at": "...", "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null},
     "is_active": false}
  ],
  "extra_usage": {"is_enabled": false, "monthly_limit": null, "used_credits": null,
    "utilization": null, "currency": null, "decimal_places": null,
    "disabled_reason": null, "daily": null, "weekly": null},
  "spend": {"used": {"amount_minor": 0, "currency": "USD", "exponent": 2}, "limit": null,
    "percent": 0, "severity": "normal", "enabled": false, "disabled_reason": null,
    "cap": null, "balance": null, "auto_reload": null,
    "disclaimer": "Usage credits cover you when you hit your plan limits...",
    "can_purchase_credits": false, "can_toggle": false}
}
```

Two changes matter:

1. The old flat per-model keys (`seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`) are now always `null`. Per-model weekly limits (including the new **Fable** weekly cap) are expressed instead as entries in a new **`limits` array**, self-describing via `kind` + `scope.model.display_name`.
2. A new top-level **`spend`** object appears — a richer superset of the old `extra_usage` (pay-as-you-go usage credits beyond plan limits), with `used`/`cap`/`balance`/`disclaimer`. Both are disabled on this account, so the populated shape of `spend.cap`/`spend.balance` is unverified.

## Decisions (confirmed with user)

- Parse `raw.limits[]` dynamically as the source of truth, instead of hardcoding another flat key for Fable. Any future per-model weekly limit shows up automatically.
- Render every entry in `limits`, but visually dim rows where `is_active === false` (append an `(inactive)` tag) rather than hiding them — so Fable/weekly usage stays visible before it becomes the binding constraint.
- For the extra-usage footer: prefer `spend` when `spend.enabled` is true; otherwise fall back to today's `extra_usage.is_enabled` display unchanged.

## Data layer — `src/usage.js`

- Remove the static `LIMIT_KEYS` array.
- In `_enrich(raw)`, iterate `raw.limits || []`. For each entry:
  - `key = entry.scope?.model?.display_name ? `${entry.kind}:${entry.scope.model.display_name}` : entry.kind`
  - `label`:
    - `kind === 'session'` → `'5H'`
    - `kind === 'weekly_all'` → `'7D'`
    - `scope?.model?.display_name` present → `` `${display_name} 7D` ``
    - else → `entry.kind` (unknown future kind, still renders instead of silently dropping)
  - `utilization = entry.percent`, `resets_at = entry.resets_at`, `timeToReset` computed as today.
  - `isActive = entry.is_active`, `severity = entry.severity` (both passed through, unused by prediction math).
  - Prediction (`_predict`/`_getSegment`/`_windowRate`/`_ewmaRate`/`_selectRate`) unchanged — keyed by the same dynamic `key` string, reading/writing the existing rolling 24h `history.json`. Old-format history entries (keyed by `five_hour` etc.) simply age out within 24h; no migration.
- Skip entries where `entry == null` (mirrors today's `if (!limit) continue`).
- Pass `raw.spend` and `raw.extra_usage` straight through on the enriched result (`result.spend`, `result.extra_usage`) — no reshaping, since `spend`'s populated shape (when `enabled: true`) can't be verified right now.
- If `raw.limits` is absent entirely (unexpected/older API), `_enrich` just produces zero rows — no dual-parsing fallback to the deprecated flat keys.

## Render layer — `src/render.js`

- Drop the static `LABELS` map; `renderRow` reads `limit.label` (now computed upstream).
- `renderRow(key, limit, width)`:
  - When `limit.isActive === false`: use `DIM` instead of `colorForPct(pct)` for both the bar and the percentage, and append `' (inactive)'` after the confidence glyph.
  - Otherwise: unchanged (existing `colorForPct` gradient).
- `render(state)` — banner trigger: when computing `highest` across `limits`, only consider entries where `limit.isActive !== false`. Rows still render regardless of active state; only the WARNING/CRITICAL banner comparison excludes inactive ones, so a high-but-inactive Fable/weekly number can't pop a false banner.
- Extra-usage footer (`render(state)`, replacing the current `state.latest.extra_usage` block):
  - If `state.latest.spend?.enabled`: render `extra usage: on` plus, defensively:
    - `used ${fmtMoneyMinor(spend.used)}` if `spend.used` matches `{amount_minor, currency, exponent}`
    - `/ cap ${fmtMoneyMinor(spend.cap)}` if `spend.cap` matches that same shape
    - `balance ${fmtMoneyMinor(spend.balance)}` if present in that shape
    - Any subfield that doesn't match the expected shape (e.g. still `null`, or a different type once populated) is silently omitted rather than guessed at.
  - Else, fall back to today's behavior reading `state.latest.extra_usage.is_enabled` / `.monthly_limit`.
  - `fmtMoneyMinor({amount_minor, currency, exponent})`: `amount_minor / 10**exponent`, prefixed with `$` for `USD`, else the raw currency code.

## Testing

- No existing tests cover `usage.js` or `render.js` directly (checked `tests/` — only `reflect`, `harness.*`, `watch.poller`, `model.tree` exist). This change doesn't need new test scaffolding beyond manual verification against the live API response captured above, since the prediction engine's tested behavior (segment/window/EWMA math) is unchanged — only the key derivation and pass-through wiring around it changes.
- Manual verification: run `claude-dash-cli` against the real account and confirm the 5H/7D/Fable-7D rows render, the Fable row shows dimmed + `(inactive)`, and the footer reflects `extra_usage: off` (current account state) without crashing.

## Out of scope

- Interpreting the unknown null keys seen in the raw payload (`seven_day_oauth_apps`, `tangelo`, `iguana_necktie`, `omelette_promotional`, `nimbus_quill`, `cinder_cove`, `amber_ladder`) — these are currently all `null` for this account and superseded by the `limits` array; no action needed unless they start appearing populated.
- Reshaping `spend.cap`/`spend.balance` beyond defensive shape-checking, since no enabled account is available to confirm their real structure.
