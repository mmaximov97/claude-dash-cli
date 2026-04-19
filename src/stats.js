const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// ── Public API ──────────────────────────────────────────────────
//
// scan({ since, until }) — aggregate local transcripts for a time window.
//
//   since, until: epoch ms. Omit for all-time.
//
// Returns:
//   {
//     window: { since, until },
//     tokens: { input, output, cache_read, cache_creation, total },
//     byModel: { 'claude-opus-4-7': { tokens, messages }, ... },
//     byTool:  { 'Bash': count, 'Read': count, ... },
//     byMcp:   { 'context7': count, 'playwright': count, ... },
//     bySkill: { 'superpowers:brainstorming': count, ... },
//     sessionCount: N,      // sessions with ≥1 message in the window
//     messageCount: N,      // assistant messages in the window
//     filesScanned: N,
//     scanMs: N,
//   }
//
// Scales from "today" (~ms) to "all-time" (~seconds) via mtime pre-filter.
async function scan({ since = 0, until = Date.now() } = {}) {
  const t0 = Date.now();
  const files = await _findCandidateFiles(since, until);

  const agg = _emptyAggregate();
  const seenSessions = new Set();

  for (const file of files) {
    await _scanFile(file, since, until, agg, seenSessions);
  }

  return {
    window: { since, until },
    tokens: agg.tokens,
    byModel: agg.byModel,
    byTool: agg.byTool,
    byMcp: agg.byMcp,
    bySkill: agg.bySkill,
    sessionCount: seenSessions.size,
    messageCount: agg.messageCount,
    filesScanned: files.length,
    scanMs: Date.now() - t0,
  };
}

// Convenience: since midnight local time.
function sinceMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Internals ───────────────────────────────────────────────────

function _emptyAggregate() {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    byModel: {},
    byTool: {},
    byMcp: {},
    bySkill: {},
    messageCount: 0,
  };
}

async function _findCandidateFiles(since, until) {
  const out = [];
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(PROJECTS_DIR);
  } catch {
    return out;
  }

  for (const proj of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let entries;
    try {
      entries = await fs.promises.readdir(projPath);
    } catch { continue; }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(projPath, name);
      let stat;
      try { stat = await fs.promises.stat(full); } catch { continue; }

      // mtime pre-filter: file untouched before window starts is irrelevant.
      // File last modified after window ends may still contain earlier messages,
      // so we only filter on the lower bound.
      if (stat.mtimeMs < since) continue;
      out.push(full);
    }
  }
  return out;
}

async function _scanFile(file, since, until, agg, seenSessions) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.type !== 'assistant') continue;

    const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
    if (ts == null || ts < since || ts > until) continue;

    const msg = d.message || {};
    const u = msg.usage || {};

    const inTok    = u.input_tokens || 0;
    const outTok   = u.output_tokens || 0;
    const cacheRd  = u.cache_read_input_tokens || 0;
    const cacheCr  = u.cache_creation_input_tokens || 0;

    agg.tokens.input += inTok;
    agg.tokens.output += outTok;
    agg.tokens.cache_read += cacheRd;
    agg.tokens.cache_creation += cacheCr;

    const model = msg.model || 'unknown';
    if (!agg.byModel[model]) agg.byModel[model] = { tokens: 0, messages: 0 };
    agg.byModel[model].tokens += inTok + outTok + cacheCr; // excludes cache_read (already billed)
    agg.byModel[model].messages += 1;

    agg.messageCount += 1;
    if (d.sessionId) seenSessions.add(d.sessionId);

    for (const c of msg.content || []) {
      if (!c || typeof c !== 'object' || c.type !== 'tool_use') continue;
      const name = c.name || 'unknown';
      agg.byTool[name] = (agg.byTool[name] || 0) + 1;

      if (name.startsWith('mcp__')) {
        // mcp__<server>__<tool>  → attribute to <server>
        const parts = name.split('__');
        const server = parts[1] || 'unknown';
        agg.byMcp[server] = (agg.byMcp[server] || 0) + 1;
      }
      if (name === 'Skill') {
        const skill = (c.input && c.input.skill) || 'unknown';
        agg.bySkill[skill] = (agg.bySkill[skill] || 0) + 1;
      }
    }
  }

  agg.tokens.total = agg.tokens.input + agg.tokens.output + agg.tokens.cache_creation;
}

module.exports = { scan, sinceMidnight };
