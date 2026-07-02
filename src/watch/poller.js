function createPoller({
  intervalMs,
  discover,
  onUpdate,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null;
  let stopped = false;

  function tick() {
    let sessions = null, err = null;
    try {
      sessions = discover();
    } catch (e) {
      err = e;
    }

    // Check if sessions is a Promise
    if (sessions instanceof Promise) {
      sessions
        .then(s => {
          if (!stopped) {
            onUpdate(s, null);
            if (!stopped) timer = setTimeoutFn(tick, intervalMs);
          }
        })
        .catch(e => {
          if (!stopped) {
            onUpdate(null, e);
            if (!stopped) timer = setTimeoutFn(tick, intervalMs);
          }
        });
    } else {
      if (!stopped) {
        onUpdate(sessions, err);
        if (!stopped) timer = setTimeoutFn(tick, intervalMs);
      }
    }
  }

  return {
    start() { stopped = false; tick(); },
    stop() { stopped = true; if (timer) clearTimeoutFn(timer); timer = null; },
  };
}

module.exports = { createPoller };
