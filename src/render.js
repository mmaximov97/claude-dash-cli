// ── ANSI helpers ────────────────────────────────────────────────
const ESC = '\x1b[';
const CLEAR = ESC + '2J' + ESC + 'H';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const DIM = ESC + '2m';

const fg = (n) => ESC + '38;5;' + n + 'm';
const bg = (n) => ESC + '48;5;' + n + 'm';

// Green → yellow → red gradient by utilization (0–100).
function colorForPct(pct) {
  if (pct >= 95) return fg(196); // bright red
  if (pct >= 85) return fg(202); // orange
  if (pct >= 70) return fg(220); // yellow
  if (pct >= 40) return fg(120); // light green
  return fg(82);                 // green
}

function confidenceGlyph(c) {
  return { high: '●', medium: '◐', low: '○', none: '·' }[c] || '·';
}

// ── Formatters ──────────────────────────────────────────────────
const LABELS = {
  five_hour:         '5H ',
  seven_day:         '7D ',
  seven_day_opus:    'Opus 7D ',
  seven_day_sonnet:  'Sonnet 7D',
  seven_day_cowork:  'Cowork 7D',
};

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function bar(pct, width) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── TODO (you): render one limit row ────────────────────────────
//
// This is the main creative decision. Given a limit object like:
//
//   key: 'five_hour'
//   limit: {
//     utilization: 74.2,              // percent 0–100
//     timeToReset: 8040000,           // ms until the rolling window resets
//     estimatedTimeToLimit: 6120000,  // ms until you hit 100% at current rate (may be null)
//     consumptionRate: 12.5,          // %/hour (may be null)
//     confidence: 'high'|'medium'|'low'|'none',
//   }
//   width: the terminal width in columns (pane width)
//
// Return a single line string (ANSI-colored, no trailing newline).
//
// Helpers available: colorForPct, confidenceGlyph, fmtDuration, bar,
// LABELS, BOLD, DIM, RESET, fg/bg.
//
// Suggested layouts (pick one or design your own):
//   compact  →  "5H  ████████░░ 74%  resets 2h14m  eta 1h42m  ●"
//   wide     →  "5H   │ ██████████████░░░░░ 74.2% │ resets in 2h14m │ eta 1h42m (●high, 12.5%/h)"
//
// Scale the bar width from (width - 40) or similar so it adapts to pane size.
function renderRow(key, limit, width) {
  // TODO: implement. Placeholder below so the app runs — replace it.
  const label = LABELS[key] || key;
  const pct = limit.utilization;
  const barW = Math.max(10, width - 55);
  const color = colorForPct(pct);
  return `${BOLD}${label.padEnd(10)}${RESET} ${color}${bar(pct, barW)}${RESET} ${color}${pct.toFixed(1).padStart(5)}%${RESET} ${DIM}reset ${fmtDuration(limit.timeToReset)}  eta ${fmtDuration(limit.estimatedTimeToLimit)} ${confidenceGlyph(limit.confidence)}${RESET}`;
}

// ── TODO (you): render the alert banner ─────────────────────────
//
// Called when ANY limit is above the threshold. Return the banner string
// (one or more lines, ANSI-colored), or '' to suppress.
//
// Arguments:
//   highest: { key, limit } for the most-utilized limit currently tripping
//   width:   terminal width
//
// Design choices to consider:
//   - At 80% warn (yellow), at 95% critical (red/blinking)
//   - Full-width background strip vs a small inline badge?
//   - Include the ETA so user knows how urgent?
function renderBanner(highest, width) {
  // TODO: implement. Placeholder — replace it.
  const pct = highest.limit.utilization;
  const critical = pct >= 95;
  const color = critical ? bg(52) + fg(231) : bg(58) + fg(231);
  const tag = critical ? ' CRITICAL ' : ' WARNING  ';
  const msg = ` ${LABELS[highest.key] || highest.key} at ${pct.toFixed(0)}% — resets ${fmtDuration(highest.limit.timeToReset)} `;
  const line = (tag + msg).padEnd(width).slice(0, width);
  return `${BOLD}${color}${line}${RESET}`;
}

// ── Frame assembly ──────────────────────────────────────────────
function render(state) {
  const width = process.stdout.columns || 80;
  const lines = [];

  // Header
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  lines.push(`${BOLD}claude-dash-cli${RESET}  ${DIM}${hh}:${mm}:${ss}  (polls every 5m)${RESET}`);
  lines.push('');

  if (state.error && !state.latest) {
    lines.push(`${fg(196)}✗ ${state.error}${RESET}`);
    return CLEAR + lines.join('\n') + '\n';
  }

  if (!state.latest) {
    lines.push(`${DIM}Fetching usage…${RESET}`);
    return CLEAR + lines.join('\n') + '\n';
  }

  // Rows — live-adjusted countdowns since the last fetch
  const elapsed = Date.now() - state.latest.timestamp;
  const limits = state.latest.limits;
  let highest = null;

  for (const key of Object.keys(limits)) {
    const raw = limits[key];
    const live = {
      ...raw,
      timeToReset: Math.max(0, raw.timeToReset - elapsed),
      estimatedTimeToLimit: raw.estimatedTimeToLimit != null
        ? Math.max(0, raw.estimatedTimeToLimit - elapsed)
        : null,
    };
    lines.push(renderRow(key, live, width));
    if (!highest || live.utilization > highest.limit.utilization) {
      highest = { key, limit: live };
    }
  }

  // Banner if any limit is concerning
  if (highest && highest.limit.utilization >= 80) {
    lines.push('');
    lines.push(renderBanner(highest, width));
  }

  // Extra-usage footer (monthly $ cap, if plan has it)
  if (state.latest.extra_usage) {
    const eu = state.latest.extra_usage;
    const txt = eu.is_enabled
      ? (eu.monthly_limit ? `extra usage: on ($${(eu.monthly_limit / 100).toFixed(2)}/mo)` : 'extra usage: on')
      : 'extra usage: off';
    lines.push('');
    lines.push(`${DIM}${txt}${RESET}`);
  }

  if (state.error) {
    lines.push('');
    lines.push(`${DIM}${fg(208)}⚠ ${state.error}${RESET}`);
  }

  return CLEAR + lines.join('\n') + '\n';
}

module.exports = { render, HIDE_CURSOR, SHOW_CURSOR };
