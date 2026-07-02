const fs = require('fs');
const path = require('path');
const { readJsonlCached } = require('./jsonl');
const { emptyUsage, addUsage, classifyStatus, computeRollup } = require('../model/tree');

function parseTranscript(file) {
  const out = {
    cwd: null, model: null, agentType: null, agentId: null,
    firstTs: null, lastTs: null, usage: emptyUsage(),
  };
  for (const rec of readJsonlCached(file)) {
    if (!rec) continue;
    if (rec.cwd) out.cwd = rec.cwd;
    if (rec.agentId) out.agentId = rec.agentId;
    if (rec.attributionAgent) out.agentType = rec.attributionAgent;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
    if (ts) {
      if (out.firstTs == null || ts < out.firstTs) out.firstTs = ts;
      if (out.lastTs == null || ts > out.lastTs) out.lastTs = ts;
    }
    const u = rec.message && rec.message.usage;
    if (u) {
      out.usage = addUsage(out.usage, {
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
      if (rec.message.model) out.model = rec.message.model;
    }
  }
  return out;
}

function subagentNodes(slugDir, sessionId, opts) {
  const subDir = path.join(slugDir, sessionId, 'subagents');
  let files = [];
  try {
    files = fs.readdirSync(subDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch { return []; }
  const nodes = [];
  for (const f of files) {
    const p = parseTranscript(path.join(subDir, f));
    nodes.push({
      harness: 'claude', kind: 'subagent',
      id: p.agentId || f.replace(/\.jsonl$/, ''),
      cwd: p.cwd, project: p.cwd ? path.basename(p.cwd) : null,
      model: p.model, agentType: p.agentType,
      status: classifyStatus(p.lastTs, opts.now, opts),
      startedAt: p.firstTs, lastActivity: p.lastTs,
      usage: p.usage, children: [],
    });
  }
  return nodes;
}

function discoverSessions({ projectsDir, now, liveMs, idleMs, windowMs }) {
  const opts = { now };
  if (liveMs !== undefined) opts.liveMs = liveMs;
  if (idleMs !== undefined) opts.idleMs = idleMs;
  if (windowMs !== undefined) opts.windowMs = windowMs;

  let slugs;
  try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }

  const sessions = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(projectsDir, slug.name);
    let entries;
    try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.replace(/\.jsonl$/, '');
      const p = parseTranscript(path.join(slugDir, e.name));
      const children = subagentNodes(slugDir, sessionId, opts);

      const node = {
        harness: 'claude', kind: 'session',
        id: sessionId, cwd: p.cwd, project: p.cwd ? path.basename(p.cwd) : null,
        model: p.model, agentType: null,
        status: classifyStatus(p.lastTs, now, opts),
        startedAt: p.firstTs, lastActivity: p.lastTs,
        usage: p.usage, children,
      };

      // keep if the session OR any child is inside the window
      const alive = node.status != null || children.some((c) => c.status != null);
      if (!alive) continue;
      computeRollup(node);
      sessions.push(node);
    }
  }
  return sessions;
}

module.exports = { discoverSessions, parseTranscript };
