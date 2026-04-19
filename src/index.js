const { AuthManager } = require('./auth');
const { UsageTracker } = require('./usage');
const { render, HIDE_CURSOR, SHOW_CURSOR } = require('./render');

const REDRAW_MS = 1000;

function main() {
  const auth = new AuthManager();
  const tracker = new UsageTracker(auth);

  const state = { latest: null, error: null };

  tracker.start((data) => {
    if (data) {
      state.latest = data;
      state.error = tracker.error;
    } else {
      state.error = tracker.error;
    }
  });

  process.stdout.write(HIDE_CURSOR);
  const timer = setInterval(() => {
    process.stdout.write(render(state));
  }, REDRAW_MS);

  const cleanup = () => {
    clearInterval(timer);
    tracker.stop();
    process.stdout.write(SHOW_CURSOR + '\n');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
