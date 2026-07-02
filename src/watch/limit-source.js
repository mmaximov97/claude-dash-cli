const { AuthManager } = require('../auth');
const { UsageTracker } = require('../usage');

function createLimitSource() {
  const tracker = new UsageTracker(new AuthManager());
  return {
    start(cb) { tracker.start((data) => { if (data) cb(data); }); },
    stop() { tracker.stop(); },
  };
}

module.exports = { createLimitSource };
