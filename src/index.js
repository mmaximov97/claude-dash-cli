const { AuthManager } = require('./auth');
const { UsageTracker } = require('./usage');
const { scan, sinceMidnight } = require('./stats');
const { render, HIDE_CURSOR, SHOW_CURSOR } = require('./render');

const REDRAW_MS = 1000;
const STATS_REFRESH_MS = 60_000;

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
