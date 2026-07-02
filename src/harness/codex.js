// src/harness/codex.js
const fs = require('fs');
const path = require('path');
const { readJsonlCached } = require('./jsonl');
const { emptyUsage, classifyStatus } = require('../model/tree');

function walkRollouts(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(full, acc);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

function mapUsage(info) {
  const t = info && info.total_token_usage;
  if (!t) return emptyUsage();
  return {
    in: Math.max(0, (t.input_tokens || 0) - (t.cached_input_tokens || 0)),
    out: (t.output_tokens || 0) + (t.reasoning_output_tokens || 0),
    cacheCreate: 0,
    cacheRead: t.cached_input_tokens || 0,
  };
}

function discoverSessions({ sessionsDir, now, liveMs, idleMs, windowMs }) {
  const opts = { now, liveMs, idleMs, windowMs };
  const sessions = [];

  for (const file of walkRollouts(sessionsDir)) {
    let cwd = null, model = null, id = null, firstTs = null, lastTs = null;
    let usage = emptyUsage();

    for (const rec of readJsonlCached(file)) {
      if (!rec) continue;
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
      if (ts) {
        if (firstTs == null || ts < firstTs) firstTs = ts;
        if (lastTs == null || ts > lastTs) lastTs = ts;
      }
      const p = rec.payload;
      if (rec.type === 'session_meta' && p) {
        cwd = p.cwd || cwd;
        model = p.model || model;
        id = p.id || p.session_id || id;
      } else if (rec.type === 'event_msg' && p && p.type === 'token_count') {
        usage = mapUsage(p.info); // cumulative → last one wins
      }
    }

    const status = classifyStatus(lastTs, now, opts);
    if (status == null) continue;

    sessions.push({
      harness: 'codex', kind: 'session',
      id: id || path.basename(file, '.jsonl'),
      cwd, project: cwd ? path.basename(cwd) : null,
      model, agentType: null, status,
      startedAt: firstTs, lastActivity: lastTs,
      usage, rollup: { ...usage }, children: [],
    });
  }
  return sessions;
}

module.exports = { discoverSessions, walkRollouts };
