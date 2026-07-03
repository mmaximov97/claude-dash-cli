const os = require('os');
const path = require('path');
const claude = require('./claude');
const codex = require('./codex');

const RANK = { live: 0, idle: 1, done: 2 };

function discoverAll({
  now,
  liveMs, idleMs, windowMs,
  claudeDir = path.join(os.homedir(), '.claude', 'projects'),
  codexDir = path.join(os.homedir(), '.codex', 'sessions'),
} = {}) {
  const opts = { now, liveMs, idleMs, windowMs };
  const sessions = [
    ...claude.discoverSessions({ ...opts, projectsDir: claudeDir }),
    ...codex.discoverSessions({ ...opts, sessionsDir: codexDir }),
  ];
  return sortSessions(sessions);
}

function sortSessions(sessions) {
  return sessions.sort((a, b) =>
    ((RANK[a.status] ?? 3) - (RANK[b.status] ?? 3)) || ((b.lastActivity || 0) - (a.lastActivity || 0)));
}

module.exports = { discoverAll, sortSessions };
