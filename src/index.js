const { AuthManager } = require('./auth');
const { UsageTracker } = require('./usage');
const { scan, sinceMidnight } = require('./stats');
const { render, HIDE_CURSOR, SHOW_CURSOR } = require('./render');

const REDRAW_MS = 1000;
const STATS_REFRESH_MS = 60_000;

// ── Subcommand dispatch ─────────────────────────────────────────
// `claude-dash-cli`            → live dashboard (default, below)
// `claude-dash-cli reflect …`  → one-shot retrospective report
const sub = process.argv[2];
if (sub === 'reflect') {
  require('./reflect').run(process.argv.slice(3)).then((code) => process.exit(code || 0));
  return;
}
if (sub === 'watch') {
  try {
    const { createLimitSource } = require('./watch/limit-source');
    import('./watch/ui.mjs')
      .then(({ run }) => { run({ limitSource: createLimitSource() }); })
      .catch((e) => { process.stderr.write('watch failed: ' + e.message + '\n'); process.exit(1); });
  } catch (e) {
    process.stderr.write('watch failed: ' + e.message + '\n');
    process.exit(1);
  }
  return;
}
if (sub === '-h' || sub === '--help') {
  process.stdout.write(
    'claude-dash-cli — Claude usage dashboard\n\n' +
    'Usage:\n' +
    '  claude-dash-cli            live usage dashboard (for a tmux pane)\n' +
    '  claude-dash-cli watch      interactive multi-harness session tree (Claude + Codex)\n' +
    '  claude-dash-cli reflect    retrospective scan of your sessions\n' +
    '  claude-dash-cli --help     this help\n\n' +
    'Run `claude-dash-cli reflect --help` for retrospective options.\n'
  );
  process.exit(0);
}

function main() {
  const auth = new AuthManager();
  const tracker = new UsageTracker(auth);
  const state = { latest: null, error: null, stats: null };

  tracker.start((data) => {
    if (data) {
      state.latest = data;
      state.error = tracker.error;
    } else {
      state.error = tracker.error;
    }
  });

  // Stats: scan today's transcripts, refresh every 60s.
  // To switch to a different window later, change the since= arg:
  //   sinceMidnight()            — today (v1)
  //   Date.now() - 5 * 3600_000  — last 5h
  //   Date.now() - 7 * 86400_000 — last 7d
  //   0                          — all time
  async function refreshStats() {
    try {
      state.stats = await scan({ since: sinceMidnight() });
    } catch (e) {
      state.stats = null;
    }
  }
  refreshStats();
  const statsTimer = setInterval(refreshStats, STATS_REFRESH_MS);

  process.stdout.write(HIDE_CURSOR);
  const redrawTimer = setInterval(() => {
    process.stdout.write(render(state));
  }, REDRAW_MS);

  const cleanup = () => {
    clearInterval(redrawTimer);
    clearInterval(statsTimer);
    tracker.stop();
    process.stdout.write(SHOW_CURSOR + '\n');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
