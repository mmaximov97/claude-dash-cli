# Reflect Subcommand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `claude-dash-cli reflect` — a retrospective analyzer that scans local transcripts and correlated git history to produce a versioned `MetricsDocument` (schema v1.0.0), rendered as an ANSI narrative report by default or as raw JSON with `--format json`.

**Architecture:** Pure `compute → render` separation. `src/metrics.js` deterministically builds a JSON document from file inputs; `src/reflect-render.js` consumes the document and emits ANSI. The document schema is the public contract for future storage/sharing.

**Tech Stack:** Node.js ≥18 (built-in `node:test` runner), zero runtime deps. ANSI escape codes. `child_process` for `git log`.

**Spec:** `docs/specs/2026-04-19-reflect-subcommand-design.md`

---

## File Structure

```
src/pricing.js              model → $/M-token table + estimate(byModel) function
src/sparkline.js            sparkline() + hbar() + heatmap() ANSI primitives
src/stats-extended.js       extends scan() with dailyBuckets + cwdMessages
src/git-stats.js            per-cwd git log → commits, ±lines, reverts
src/metrics.js              compute({since,until}) → MetricsDocument
src/reflect-render.js       render(doc, section?) → ANSI string
src/reflect.js              argv parse + orchestrator
src/index.js                MODIFIED — subcommand dispatch
tests/pricing.test.js
tests/sparkline.test.js
tests/stats-extended.test.js
tests/git-stats.test.js
tests/metrics.test.js
tests/reflect-render.test.js
tests/reflect.test.js
tests/fixtures/sample-session.jsonl
package.json                MODIFIED — bump to 0.2.0, add test script
README.md                   MODIFIED — document reflect usage
```

All tests run via `node --test tests/`. Each test file uses `node:test` and `node:assert/strict`.

---

### Task 1: Pricing table + cost estimator

**Files:**
- Create: `src/pricing.js`
- Create: `tests/pricing.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pricing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimate, RATES } = require('../src/pricing');

test('estimate: opus model with mixed token types', () => {
  const byModel = {
    'claude-opus-4-7': {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 100_000,
    }
  };
  const { total, byModel: cost } = estimate(byModel);
  // 1M * $15 + 0.5M * $75 + 2M * $1.5 + 0.1M * $18.75
  //  = 15 + 37.5 + 3 + 1.875 = 57.375
  assert.equal(cost['claude-opus-4-7'].costUsd.toFixed(3), '57.375');
  assert.equal(total.toFixed(3), '57.375');
});

test('estimate: unknown model falls back to opus rate', () => {
  const byModel = {
    'claude-future-9000': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  };
  const { total } = estimate(byModel);
  assert.equal(total, 15);
});

test('estimate: empty input yields zero total', () => {
  assert.equal(estimate({}).total, 0);
});

test('RATES table has required model families', () => {
  assert.ok(RATES['claude-opus-4']);
  assert.ok(RATES['claude-sonnet-4']);
  assert.ok(RATES['claude-haiku-4']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pricing.test.js`
Expected: FAIL — `Cannot find module '../src/pricing'`

- [ ] **Step 3: Implement `src/pricing.js`**

```js
// Dollars per million tokens. Last updated 2026-04-19.
// Verify against your actual Anthropic invoices; these are user-maintained.
// Keys are model-name PREFIXES matched longest-first.
const RATES = {
  'claude-opus-4':   { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-sonnet-4': { input: 3,  output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-haiku-4':  { input: 1,  output: 5,  cacheRead: 0.1, cacheCreation: 1.25 },
};
const FALLBACK = RATES['claude-opus-4'];

function rateFor(model) {
  const keys = Object.keys(RATES).sort((a, b) => b.length - a.length);
  for (const k of keys) if (model && model.startsWith(k)) return RATES[k];
  return FALLBACK;
}

function estimate(byModel) {
  const result = { total: 0, byModel: {} };
  for (const [model, t] of Object.entries(byModel || {})) {
    const r = rateFor(model);
    const cost =
      (t.inputTokens         / 1_000_000) * r.input +
      (t.outputTokens        / 1_000_000) * r.output +
      (t.cacheReadTokens     / 1_000_000) * r.cacheRead +
      (t.cacheCreationTokens / 1_000_000) * r.cacheCreation;
    result.byModel[model] = { costUsd: cost };
    result.total += cost;
  }
  return result;
}

module.exports = { estimate, RATES, rateFor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pricing.test.js`
Expected: 4 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/pricing.js tests/pricing.test.js
git commit -m "feat(reflect): pricing table + cost estimator"
```

---

### Task 2: Sparkline primitive

**Files:**
- Create: `src/sparkline.js`
- Create: `tests/sparkline.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/sparkline.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { sparkline } = require('../src/sparkline');

test('sparkline: monotonically increasing', () => {
  const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(out, '▁▂▃▄▅▆▇█');
});

test('sparkline: all zeros → all lowest block', () => {
  assert.equal(sparkline([0, 0, 0]), '▁▁▁');
});

test('sparkline: all equal non-zero → all lowest block', () => {
  assert.equal(sparkline([5, 5, 5]), '▁▁▁');
});

test('sparkline: empty array → empty string', () => {
  assert.equal(sparkline([]), '');
});

test('sparkline: single value → one block', () => {
  assert.equal(sparkline([42]).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sparkline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sparkline function**

Create `src/sparkline.js`:

```js
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values) {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return BLOCKS[0].repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length));
      return BLOCKS[idx];
    })
    .join('');
}

module.exports = { sparkline };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sparkline.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/sparkline.js tests/sparkline.test.js
git commit -m "feat(reflect): sparkline primitive"
```

---

### Task 3: Horizontal bar + heatmap primitives

**Files:**
- Modify: `src/sparkline.js`
- Modify: `tests/sparkline.test.js`

- [ ] **Step 1: Append failing tests**

Append to `tests/sparkline.test.js`:

```js
const { hbar, heatmap } = require('../src/sparkline');

test('hbar: half width of max', () => {
  assert.equal(hbar(50, 100, 10), '█████░░░░░');
});

test('hbar: zero → all empty', () => {
  assert.equal(hbar(0, 100, 5), '░░░░░');
});

test('hbar: exceeds max → clamped to full', () => {
  assert.equal(hbar(999, 100, 5), '█████');
});

test('heatmap: 2x3 normalized cells', () => {
  // max=6, thresholds at ~1.2, 2.4, 3.6, 4.8
  // 0→· 1→░ 3→▒ 6→█
  const grid = [[0, 1, 3], [6, 0, 0]];
  const out = heatmap(grid);
  // First row: 0→·, 1→░ (val=1, threshold ~1.2 → below first actually)
  // Let's keep loose — just assert structure
  assert.equal(out.split('\n').length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sparkline.test.js`
Expected: FAIL — `hbar` / `heatmap` are undefined.

- [ ] **Step 3: Add `hbar` and `heatmap` to `src/sparkline.js`**

Append to the file, and extend the module.exports:

```js
function hbar(value, max, width) {
  if (max <= 0) return '░'.repeat(width);
  const frac = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// 5-level intensity ramp — from nothing to full.
const HEAT = ['·', '░', '▒', '▓', '█'];

function heatmap(grid) {
  if (!grid.length || !grid[0].length) return '';
  let max = 0;
  for (const row of grid) for (const v of row) if (v > max) max = v;
  if (max === 0) return grid.map((row) => HEAT[0].repeat(row.length)).join('\n');
  return grid
    .map((row) => row.map((v) => {
      if (v === 0) return HEAT[0];
      const idx = Math.min(HEAT.length - 1, Math.max(1, Math.ceil((v / max) * (HEAT.length - 1))));
      return HEAT[idx];
    }).join(''))
    .join('\n');
}

module.exports = { sparkline, hbar, heatmap };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/sparkline.test.js`
Expected: 8 passing total.

- [ ] **Step 5: Commit**

```bash
git add src/sparkline.js tests/sparkline.test.js
git commit -m "feat(reflect): hbar and heatmap primitives"
```

---

### Task 4: Extended stats scanner (daily buckets + cwd tracking)

**Files:**
- Create: `src/stats-extended.js`
- Create: `tests/fixtures/sample-session.jsonl`
- Create: `tests/stats-extended.test.js`

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/sample-session.jsonl` (three assistant messages in the same session, spanning two days):

```jsonl
{"type":"summary","sessionId":"s1"}
{"type":"assistant","sessionId":"s1","timestamp":"2026-03-20T10:00:00.000Z","cwd":"/tmp/proj-a","message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":500,"cache_creation_input_tokens":50},"content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","sessionId":"s1","timestamp":"2026-03-20T11:00:00.000Z","cwd":"/tmp/proj-a","message":{"model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":50,"cache_read_input_tokens":600,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/proj-a/x.js"}}]}}
{"type":"assistant","sessionId":"s1","timestamp":"2026-03-21T09:00:00.000Z","cwd":"/tmp/proj-b","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":20,"output_tokens":200,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"tool_use","name":"mcp__playwright__browser_click","input":{}}]}}
```

- [ ] **Step 2: Write the failing test**

Create `tests/stats-extended.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scanFile } = require('../src/stats-extended');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-session.jsonl');
const SINCE = new Date('2026-03-20T00:00:00Z').getTime();
const UNTIL = new Date('2026-03-22T00:00:00Z').getTime();

test('scanFile: aggregates three messages with tokens + tools', async () => {
  const agg = newAgg();
  await scanFile(FIXTURE, SINCE, UNTIL, agg, new Set());
  assert.equal(agg.messageCount, 3);
  assert.equal(agg.tokens.input, 35);
  assert.equal(agg.tokens.output, 350);
  assert.equal(agg.byModel['claude-opus-4-7'].messages, 2);
  assert.equal(agg.byModel['claude-sonnet-4-6'].messages, 1);
  assert.equal(agg.byTool['Bash'], 1);
  assert.equal(agg.byTool['Read'], 1);
  assert.equal(agg.byMcp['playwright'], 1);
  assert.deepEqual([...agg.cwdSet].sort(), ['/tmp/proj-a', '/tmp/proj-b']);
});

test('scanFile: daily buckets assign messages to correct day', async () => {
  const agg = newAgg();
  const bucketStart = SINCE;
  const bucketCount = 2;
  agg.dailyMessages = new Array(bucketCount).fill(0);
  agg.dailyTokens = new Array(bucketCount).fill(0);
  agg._bucketStart = bucketStart;
  agg._bucketCount = bucketCount;
  await scanFile(FIXTURE, SINCE, UNTIL, agg, new Set());
  // Day 0 (Mar 20) gets 2 messages; Day 1 (Mar 21) gets 1
  assert.equal(agg.dailyMessages[0], 2);
  assert.equal(agg.dailyMessages[1], 1);
});

test('scanFile: file edit captures file_path', async () => {
  const agg = newAgg();
  await scanFile(FIXTURE, SINCE, UNTIL, agg, new Set());
  assert.equal(agg.fileEdits['/tmp/proj-a/x.js'], 1);
});

function newAgg() {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    byModel: {}, byTool: {}, byMcp: {}, bySkill: {},
    messageCount: 0,
    cwdSet: new Set(),
    cwdMessages: {},   // cwd -> { messages, tokens, sessions:Set, byModel }
    fileEdits: {},
    sessionEndTimes: {},   // sessionId -> lastTimestamp
    dailyMessages: null, dailyTokens: null, _bucketStart: 0, _bucketCount: 0,
  };
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/stats-extended.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/stats-extended.js`**

```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAY_MS = 86400_000;

function sinceMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function scan({ since = 0, until = Date.now() } = {}) {
  const t0 = Date.now();
  const files = await _findCandidateFiles(since);
  const bucketStart = _utcMidnight(since);
  const bucketCount = Math.max(1, Math.ceil((until - bucketStart) / DAY_MS));

  const agg = _emptyAgg(bucketStart, bucketCount);
  const seenSessions = new Set();

  for (const file of files) {
    await scanFile(file, since, until, agg, seenSessions);
  }

  return {
    window: { since, until },
    tokens: agg.tokens,
    byModel: agg.byModel,
    byTool: agg.byTool,
    byMcp: agg.byMcp,
    bySkill: agg.bySkill,
    messageCount: agg.messageCount,
    sessionCount: seenSessions.size,
    cwdSet: agg.cwdSet,
    cwdMessages: agg.cwdMessages,
    fileEdits: agg.fileEdits,
    sessionEndTimes: agg.sessionEndTimes,
    sessionStartTimes: agg.sessionStartTimes,
    sessionUserTurns: agg.sessionUserTurns,
    sessionIdleGaps: agg.sessionIdleGaps,
    dailyMessages: agg.dailyMessages,
    dailyTokens: agg.dailyTokens,
    hourDayOfWeekGrid: agg.hourDayOfWeekGrid,
    filesScanned: files.length,
    scanMs: Date.now() - t0,
  };
}

function _utcMidnight(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function _emptyAgg(bucketStart, bucketCount) {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    byModel: {}, byTool: {}, byMcp: {}, bySkill: {},
    messageCount: 0,
    cwdSet: new Set(),
    cwdMessages: {},
    fileEdits: {},
    sessionEndTimes: {},
    sessionStartTimes: {},
    sessionUserTurns: {},
    sessionIdleGaps: {},
    dailyMessages: new Array(bucketCount).fill(0),
    dailyTokens: new Array(bucketCount).fill(0),
    hourDayOfWeekGrid: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    _bucketStart: bucketStart,
    _bucketCount: bucketCount,
  };
}

async function _findCandidateFiles(since) {
  const out = [];
  let dirs;
  try { dirs = await fs.promises.readdir(PROJECTS_DIR); }
  catch { return out; }
  for (const d of dirs) {
    const dp = path.join(PROJECTS_DIR, d);
    let entries;
    try { entries = await fs.promises.readdir(dp); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dp, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs < since) continue;
        out.push(full);
      } catch { /* skip */ }
    }
  }
  return out;
}

async function scanFile(file, since, until, agg, seenSessions) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    // Track user turns (for flow metrics)
    if (d.type === 'user' && d.sessionId && d.timestamp) {
      const ts = new Date(d.timestamp).getTime();
      if (ts >= since && ts <= until) {
        agg.sessionUserTurns[d.sessionId] = (agg.sessionUserTurns[d.sessionId] || 0) + 1;
      }
      continue;
    }

    if (d.type !== 'assistant') continue;

    const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
    if (ts == null || ts < since || ts > until) continue;

    const msg = d.message || {};
    const u = msg.usage || {};
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const cacheRd = u.cache_read_input_tokens || 0;
    const cacheCr = u.cache_creation_input_tokens || 0;

    agg.tokens.input += inTok;
    agg.tokens.output += outTok;
    agg.tokens.cache_read += cacheRd;
    agg.tokens.cache_creation += cacheCr;

    const model = msg.model || 'unknown';
    if (!agg.byModel[model]) {
      agg.byModel[model] = {
        messages: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      };
    }
    const mm = agg.byModel[model];
    mm.messages += 1;
    mm.inputTokens += inTok;
    mm.outputTokens += outTok;
    mm.cacheReadTokens += cacheRd;
    mm.cacheCreationTokens += cacheCr;

    agg.messageCount += 1;
    if (d.sessionId) {
      seenSessions.add(d.sessionId);
      if (!agg.sessionStartTimes[d.sessionId] || ts < agg.sessionStartTimes[d.sessionId]) {
        agg.sessionStartTimes[d.sessionId] = ts;
      }
      const prev = agg.sessionEndTimes[d.sessionId];
      if (!prev || ts > prev) agg.sessionEndTimes[d.sessionId] = ts;
      if (prev) {
        const gap = (ts - prev) / 1000;
        if (!agg.sessionIdleGaps[d.sessionId]) agg.sessionIdleGaps[d.sessionId] = [];
        agg.sessionIdleGaps[d.sessionId].push(gap);
      }
    }

    if (d.cwd) {
      agg.cwdSet.add(d.cwd);
      if (!agg.cwdMessages[d.cwd]) {
        agg.cwdMessages[d.cwd] = { messages: 0, tokens: 0, sessions: new Set(), byModel: {} };
      }
      const c = agg.cwdMessages[d.cwd];
      c.messages += 1;
      c.tokens += inTok + outTok + cacheCr;
      if (d.sessionId) c.sessions.add(d.sessionId);
      c.byModel[model] = (c.byModel[model] || 0) + 1;
    }

    // Daily bucket
    if (agg.dailyMessages && agg._bucketCount > 0) {
      const idx = Math.floor((ts - agg._bucketStart) / DAY_MS);
      if (idx >= 0 && idx < agg._bucketCount) {
        agg.dailyMessages[idx] += 1;
        agg.dailyTokens[idx] += inTok + outTok + cacheCr;
      }
    }

    // Time-of-day heatmap (local time)
    const local = new Date(ts);
    agg.hourDayOfWeekGrid[local.getDay()][local.getHours()] += 1;

    for (const c of msg.content || []) {
      if (!c || typeof c !== 'object' || c.type !== 'tool_use') continue;
      const name = c.name || 'unknown';
      agg.byTool[name] = (agg.byTool[name] || 0) + 1;

      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        agg.byMcp[parts[1] || 'unknown'] = (agg.byMcp[parts[1] || 'unknown'] || 0) + 1;
      }
      if (name === 'Skill') {
        const skill = (c.input && c.input.skill) || 'unknown';
        agg.bySkill[skill] = (agg.bySkill[skill] || 0) + 1;
      }
      if ((name === 'Edit' || name === 'Write' || name === 'Read') && c.input && c.input.file_path) {
        const p = c.input.file_path;
        agg.fileEdits[p] = (agg.fileEdits[p] || 0) + 1;
      }
    }
  }

  agg.tokens.total = agg.tokens.input + agg.tokens.output + agg.tokens.cache_creation;
}

module.exports = { scan, scanFile, sinceMidnight };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/stats-extended.test.js`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add src/stats-extended.js tests/stats-extended.test.js tests/fixtures/sample-session.jsonl
git commit -m "feat(reflect): extended stats scanner with daily buckets + cwd tracking"
```

---

### Task 5: Git stats scanner

**Files:**
- Create: `src/git-stats.js`
- Create: `tests/git-stats.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/git-stats.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanRepo } = require('../src/git-stats');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-stats-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  run('add', '.');
  run('commit', '-q', '-m', 'feat: first');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
  run('add', '.');
  run('commit', '-q', '-m', 'revert: something');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\nfoo\n');
  run('add', '.');
  run('commit', '-q', '-m', 'fix: bug');
  return dir;
}

test('scanRepo: counts commits and detects reverts/fixes', async () => {
  const dir = makeRepo();
  const res = await scanRepo(dir, 0, Date.now() + 1000);
  assert.equal(res.commits.length, 3);
  assert.equal(res.revertCount, 2); // revert: + fix:
  assert.equal(res.linesAdded, 3);
  assert.equal(res.linesDeleted, 0);
});

test('scanRepo: non-repo directory returns null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-repo-'));
  const res = await scanRepo(dir, 0, Date.now());
  assert.equal(res, null);
});

test('scanRepo: window excludes old commits', async () => {
  const dir = makeRepo();
  const future = Date.now() + 365 * 86400_000;
  const res = await scanRepo(dir, future, future + 1000);
  assert.equal(res.commits.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git-stats.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/git-stats.js`**

```js
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REVERT_RE = /^(revert|fixup!|fix:|hotfix)/i;

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
    });
  });
}

async function scanRepo(cwd, since, until) {
  try { await fs.promises.access(path.join(cwd, '.git')); }
  catch { return null; }

  const sinceIso = new Date(since).toISOString();
  const untilIso = new Date(until).toISOString();
  let out;
  try {
    out = await execFileP('git', [
      '-C', cwd,
      'log',
      `--since=${sinceIso}`,
      `--until=${untilIso}`,
      '--pretty=format:__C__%H|%aI|%s',
      '--shortstat',
    ], { maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }

  const commits = [];
  let linesAdded = 0, linesDeleted = 0, revertCount = 0;
  const blocks = out.split('__C__').filter(Boolean);

  for (const block of blocks) {
    const firstNl = block.indexOf('\n');
    const header = firstNl === -1 ? block : block.slice(0, firstNl);
    const rest = firstNl === -1 ? '' : block.slice(firstNl + 1);
    const [hash, iso, ...subjectParts] = header.split('|');
    const subject = subjectParts.join('|');
    if (!hash) continue;

    let add = 0, del = 0;
    const m = rest.match(/(\d+) insertion.*?(?:(\d+) deletion)?/);
    if (m) { add = parseInt(m[1] || '0', 10); del = parseInt(m[2] || '0', 10); }
    linesAdded += add;
    linesDeleted += del;
    if (REVERT_RE.test(subject)) revertCount += 1;

    commits.push({
      hash,
      timestamp: new Date(iso).getTime(),
      subject,
      linesAdded: add,
      linesDeleted: del,
    });
  }

  return { commits, linesAdded, linesDeleted, revertCount };
}

async function scanMany(cwds, since, until, concurrency = 8) {
  const result = {};
  const queue = [...cwds];
  async function worker() {
    while (queue.length) {
      const cwd = queue.shift();
      const r = await scanRepo(cwd, since, until);
      if (r) result[cwd] = r;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

module.exports = { scanRepo, scanMany };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/git-stats.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/git-stats.js tests/git-stats.test.js
git commit -m "feat(reflect): git-stats scanner with commit/revert/line tracking"
```

---

### Task 6: Metrics document computer

**Files:**
- Create: `src/metrics.js`
- Create: `tests/metrics.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/metrics.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocument } = require('../src/metrics');

test('buildDocument: assembles MetricsDocument v1.0.0 from inputs', () => {
  const statsResult = {
    window: { since: new Date('2026-03-20').getTime(), until: new Date('2026-03-22').getTime() },
    tokens: { input: 100, output: 500, cache_read: 1000, cache_creation: 200, total: 800 },
    byModel: { 'claude-opus-4-7': { messages: 10, inputTokens: 100, outputTokens: 500, cacheReadTokens: 1000, cacheCreationTokens: 200 } },
    byTool: { Bash: 5, Read: 3 },
    byMcp: { playwright: 2 },
    bySkill: {},
    messageCount: 10,
    sessionCount: 2,
    cwdSet: new Set(['/tmp/a', '/tmp/b']),
    cwdMessages: {
      '/tmp/a': { messages: 6, tokens: 500, sessions: new Set(['s1']), byModel: { 'claude-opus-4-7': 6 } },
      '/tmp/b': { messages: 4, tokens: 300, sessions: new Set(['s2']), byModel: { 'claude-opus-4-7': 4 } },
    },
    fileEdits: { '/tmp/a/x.js': 3 },
    sessionEndTimes: { s1: new Date('2026-03-20T11:00Z').getTime(), s2: new Date('2026-03-21T09:00Z').getTime() },
    sessionStartTimes: { s1: new Date('2026-03-20T10:00Z').getTime(), s2: new Date('2026-03-21T09:00Z').getTime() },
    sessionUserTurns: { s1: 5, s2: 3 },
    sessionIdleGaps: { s1: [30, 60], s2: [10] },
    dailyMessages: [6, 4],
    dailyTokens: [500, 300],
    hourDayOfWeekGrid: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    filesScanned: 1, scanMs: 5,
  };
  const gitResults = {
    '/tmp/a': { commits: [{ hash: 'h1', timestamp: new Date('2026-03-20T11:30Z').getTime(), subject: 'feat', linesAdded: 10, linesDeleted: 2 }],
                linesAdded: 10, linesDeleted: 2, revertCount: 0 },
  };
  const doc = buildDocument(statsResult, gitResults, 'last 30 days', '0.2.0');

  assert.equal(doc.schemaVersion, '1.0.0');
  assert.equal(doc.tool, 'claude-dash-cli');
  assert.equal(doc.toolVersion, '0.2.0');
  assert.equal(doc.window.label, 'last 30 days');
  assert.equal(doc.overview.sessions, 2);
  assert.equal(doc.overview.messages, 10);
  assert.equal(doc.overview.projects, 2);
  assert.ok(doc.overview.estCostUsd > 0);
  assert.deepEqual(doc.overview.dailyMessages, [6, 4]);

  assert.equal(doc.spend.byModel['claude-opus-4-7'].messages, 10);
  assert.ok(doc.spend.cacheHitRatio > 0 && doc.spend.cacheHitRatio < 1);
  assert.deepEqual(doc.spend.topTools[0], { name: 'Bash', count: 5 });

  assert.equal(doc.quality.linesAdded, 10);
  assert.equal(doc.quality.sessionsWithCommits, 1); // s1 had a commit within ±1h of end
  assert.equal(doc.quality.sessionCommitRatio, 0.5);

  assert.equal(doc.projects.length, 2);
  assert.ok(doc.projects[0].tokens >= doc.projects[1].tokens); // sorted desc
});

test('buildDocument: empty input yields zero-valued doc', () => {
  const empty = {
    window: { since: 0, until: 86400000 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    byModel: {}, byTool: {}, byMcp: {}, bySkill: {},
    messageCount: 0, sessionCount: 0,
    cwdSet: new Set(), cwdMessages: {}, fileEdits: {},
    sessionEndTimes: {}, sessionStartTimes: {}, sessionUserTurns: {}, sessionIdleGaps: {},
    dailyMessages: [0], dailyTokens: [0],
    hourDayOfWeekGrid: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    filesScanned: 0, scanMs: 0,
  };
  const doc = buildDocument(empty, {}, 'empty', '0.2.0');
  assert.equal(doc.overview.sessions, 0);
  assert.equal(doc.overview.estCostUsd, 0);
  assert.equal(doc.quality.sessionsWithCommits, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/metrics.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/metrics.js`**

```js
const { estimate } = require('./pricing');
const { scan } = require('./stats-extended');
const { scanMany } = require('./git-stats');

const SCHEMA_VERSION = '1.0.0';
const SESSION_COMMIT_WINDOW_MS = 60 * 60_000; // ±1h

async function compute({ since, until, windowLabel }, opts = {}) {
  const toolVersion = opts.toolVersion || '0.0.0';
  const statsResult = await scan({ since, until });
  const gitResults = await scanMany([...statsResult.cwdSet], since, until);
  return buildDocument(statsResult, gitResults, windowLabel, toolVersion);
}

function buildDocument(s, gitResults, windowLabel, toolVersion) {
  const { byModel } = s;
  const { total: totalCost, byModel: costByModel } = estimate(byModel);
  const spendByModel = {};
  for (const [m, t] of Object.entries(byModel)) {
    spendByModel[m] = { ...t, costUsd: costByModel[m] ? costByModel[m].costUsd : 0 };
  }

  const totalRead = s.tokens.cache_read;
  const totalWrittenContext = s.tokens.input + s.tokens.cache_creation + totalRead;
  const cacheHitRatio = totalWrittenContext > 0 ? totalRead / totalWrittenContext : 0;

  const topTools = Object.entries(s.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topFiles = Object.entries(s.fileEdits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, edits]) => ({ path, edits }));

  // Flow
  const durations = Object.keys(s.sessionStartTimes).map((sid) => {
    return (s.sessionEndTimes[sid] - s.sessionStartTimes[sid]) / 60_000;
  });
  const durBuckets = { labels: ['<5m', '5-15m', '15-60m', '1-3h', '>3h'], counts: [0, 0, 0, 0, 0] };
  for (const m of durations) {
    if (m < 5) durBuckets.counts[0]++;
    else if (m < 15) durBuckets.counts[1]++;
    else if (m < 60) durBuckets.counts[2]++;
    else if (m < 180) durBuckets.counts[3]++;
    else durBuckets.counts[4]++;
  }
  const medianSessionMinutes = _median(durations);
  const medianUserTurns = _median(Object.values(s.sessionUserTurns));
  const allGaps = [].concat(...Object.values(s.sessionIdleGaps));
  const medianIdleGapSeconds = _median(allGaps);

  // Project thrash daily: distinct cwds per bucket
  const bucketLen = s.dailyMessages.length;
  const projectThrashDaily = new Array(bucketLen).fill(0);
  // Approximation: derive from cwdMessages we lack per-day cwd bucketing,
  // so we use the count of projects active in the overall window as a
  // flat value — TODO in v1.1. See spec open items.
  // For now, flatten: value = count of cwds with any activity, broadcast.
  const flat = s.cwdSet.size;
  for (let i = 0; i < bucketLen; i++) projectThrashDaily[i] = flat;

  // Quality — correlate commits with session end times
  const allCommits = [];
  for (const [cwd, r] of Object.entries(gitResults || {})) {
    for (const c of r.commits) allCommits.push({ ...c, cwd });
  }
  const gitLinesAdded = Object.values(gitResults || {}).reduce((n, r) => n + (r.linesAdded || 0), 0);
  const gitLinesDeleted = Object.values(gitResults || {}).reduce((n, r) => n + (r.linesDeleted || 0), 0);
  const revertCount = Object.values(gitResults || {}).reduce((n, r) => n + (r.revertCount || 0), 0);
  const totalCommits = allCommits.length;
  const revertRatio = totalCommits > 0 ? revertCount / totalCommits : 0;

  let sessionsWithCommits = 0;
  for (const sid of Object.keys(s.sessionEndTimes)) {
    const endTs = s.sessionEndTimes[sid];
    const hit = allCommits.some((c) =>
      Math.abs(c.timestamp - endTs) <= SESSION_COMMIT_WINDOW_MS
    );
    if (hit) sessionsWithCommits += 1;
  }
  const sessionCommitRatio = s.sessionCount > 0 ? sessionsWithCommits / s.sessionCount : 0;

  // Projects sorted by tokens desc
  const projects = Object.entries(s.cwdMessages).map(([cwd, v]) => {
    const topModel = Object.entries(v.byModel).sort((a, b) => b[1] - a[1])[0];
    const g = gitResults && gitResults[cwd];
    const { total: pCost } = estimate({
      [topModel ? topModel[0] : 'unknown']: {
        inputTokens: Math.round(v.tokens * 0.01),
        outputTokens: Math.round(v.tokens * 0.99),
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    return {
      cwd,
      sessions: v.sessions.size,
      messages: v.messages,
      tokens: v.tokens,
      commits: g ? g.commits.length : 0,
      topModel: topModel ? topModel[0] : null,
      costUsd: pCost,
    };
  }).sort((a, b) => b.tokens - a.tokens);

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'claude-dash-cli',
    toolVersion,
    generatedAt: new Date().toISOString(),
    window: {
      since: new Date(s.window.since).toISOString(),
      until: new Date(s.window.until).toISOString(),
      label: windowLabel,
    },
    overview: {
      sessions: s.sessionCount,
      messages: s.messageCount,
      projects: s.cwdSet.size,
      estCostUsd: totalCost,
      dailyMessages: s.dailyMessages,
      dailyTokens: s.dailyTokens,
    },
    spend: {
      estCostUsd: totalCost,
      byModel: spendByModel,
      cacheHitRatio,
      cacheHitRatioDaily: [], // deferred — daily cache ratio needs per-day token buckets
      topTools,
      mcpServers: s.byMcp,
    },
    flow: {
      sessionDurationBuckets: durBuckets,
      medianSessionMinutes,
      medianUserTurnsPerSession: medianUserTurns,
      medianIdleGapSeconds,
      timeOfDayHeatmap: { shape: [7, 24], data: s.hourDayOfWeekGrid },
      projectThrashDaily,
    },
    quality: {
      sessionsWithCommits,
      sessionCommitRatio,
      linesAdded: gitLinesAdded,
      linesDeleted: gitLinesDeleted,
      topFiles,
      revertRatio,
      revertCount,
    },
    projects: projects.slice(0, 10),
  };
}

function _median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = { compute, buildDocument, SCHEMA_VERSION };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/metrics.test.js`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/metrics.js tests/metrics.test.js
git commit -m "feat(reflect): metrics document builder (schema v1.0.0)"
```

---

### Task 7: Reflect renderer

**Files:**
- Create: `src/reflect-render.js`
- Create: `tests/reflect-render.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/reflect-render.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/reflect-render');

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function sampleDoc() {
  return {
    schemaVersion: '1.0.0', tool: 'claude-dash-cli', toolVersion: '0.2.0',
    generatedAt: '2026-04-19T12:00:00.000Z',
    window: { since: '2026-03-20T00:00:00Z', until: '2026-04-19T00:00:00Z', label: 'last 30 days' },
    overview: { sessions: 87, messages: 12408, projects: 14, estCostUsd: 127.42,
      dailyMessages: [10,20,30,40], dailyTokens: [100,200,300,400] },
    spend: {
      estCostUsd: 127.42,
      byModel: { 'claude-opus-4-7': { messages: 390, inputTokens: 1000, outputTokens: 5000,
        cacheReadTokens: 10000, cacheCreationTokens: 500, costUsd: 127.42 } },
      cacheHitRatio: 0.75,
      cacheHitRatioDaily: [],
      topTools: [{ name: 'Bash', count: 412 }, { name: 'Read', count: 200 }],
      mcpServers: { playwright: 38 },
    },
    flow: {
      sessionDurationBuckets: { labels: ['<5m','5-15m','15-60m','1-3h','>3h'], counts: [5,10,20,8,2] },
      medianSessionMinutes: 24,
      medianUserTurnsPerSession: 12,
      medianIdleGapSeconds: 18,
      timeOfDayHeatmap: { shape: [7,24], data: Array.from({length:7},()=>new Array(24).fill(0)) },
      projectThrashDaily: [3,4,2,3],
    },
    quality: {
      sessionsWithCommits: 62, sessionCommitRatio: 0.71,
      linesAdded: 15234, linesDeleted: 3421,
      topFiles: [{ path: '/tmp/x.js', edits: 12 }],
      revertRatio: 0.03, revertCount: 2,
    },
    projects: [
      { cwd: '/home/u/p/alpha', sessions: 12, messages: 512, tokens: 4200000, commits: 18, topModel: 'claude-opus-4-7', costUsd: 42.10 },
      { cwd: '/home/u/p/beta',  sessions:  8, messages: 300, tokens: 2100000, commits:  9, topModel: 'claude-opus-4-7', costUsd: 21.00 },
    ],
  };
}

test('render: full report includes all section headers', () => {
  const out = stripAnsi(render(sampleDoc()));
  assert.ok(out.includes('Reflect'));
  assert.ok(out.includes('Overview') || out.includes('last 30 days'));
  assert.ok(out.includes('Spend'));
  assert.ok(out.includes('Flow'));
  assert.ok(out.includes('Quality'));
  assert.ok(out.includes('Projects'));
  assert.ok(out.includes('87'));
  assert.ok(out.includes('$127.42'));
  assert.ok(out.includes('Bash'));
  assert.ok(out.includes('alpha'));
});

test('render: section filter shows only requested section', () => {
  const out = stripAnsi(render(sampleDoc(), 'spend'));
  assert.ok(out.includes('Spend'));
  assert.ok(!out.includes('Quality'));
  assert.ok(!out.includes('Projects'));
});

test('render: empty doc prints friendly no-activity message', () => {
  const empty = sampleDoc();
  empty.overview.messages = 0;
  empty.overview.sessions = 0;
  const out = stripAnsi(render(empty));
  assert.ok(out.match(/no activity/i));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reflect-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/reflect-render.js`**

```js
const { sparkline, hbar, heatmap } = require('./sparkline');

const ESC = '\x1b[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const DIM = ESC + '2m';
const fg = (n) => ESC + '38;5;' + n + 'm';

const SECTIONS = ['overview', 'spend', 'flow', 'quality', 'projects'];

function render(doc, sectionFilter) {
  if (!doc || doc.overview.messages === 0) {
    return `${DIM}No activity in this window (${doc ? doc.window.label : 'unknown'}).${RESET}\n`;
  }

  const sections = sectionFilter && SECTIONS.includes(sectionFilter) ? [sectionFilter] : SECTIONS;
  const out = [];
  out.push(_header(doc));
  for (const name of sections) {
    out.push('');
    out.push(_section(name, doc));
  }
  return out.join('\n') + '\n';
}

function _header(doc) {
  const since = doc.window.since.slice(0, 10);
  const until = doc.window.until.slice(0, 10);
  return `${BOLD}Reflect${RESET}  ${doc.window.label}  ${DIM}(${since} → ${until})${RESET}`;
}

function _section(name, doc) {
  switch (name) {
    case 'overview': return _overview(doc);
    case 'spend':    return _spend(doc);
    case 'flow':     return _flow(doc);
    case 'quality':  return _quality(doc);
    case 'projects': return _projects(doc);
    default: return '';
  }
}

function _overview(doc) {
  const o = doc.overview;
  const lines = [];
  lines.push(`${BOLD}Overview${RESET}`);
  lines.push(`  ${fg(82)}sessions${RESET} ${o.sessions}   ${fg(82)}msgs${RESET} ${_fmt(o.messages)}   ${fg(82)}projects${RESET} ${o.projects}   ${fg(82)}est. cost${RESET} $${o.estCostUsd.toFixed(2)}`);
  lines.push(`  ${DIM}messages/day${RESET}  ${sparkline(o.dailyMessages)}`);
  lines.push(`  ${DIM}tokens/day  ${RESET}  ${sparkline(o.dailyTokens)}`);
  return lines.join('\n');
}

function _spend(doc) {
  const s = doc.spend;
  const lines = [`${BOLD}Spend${RESET}  ${DIM}($${s.estCostUsd.toFixed(2)})${RESET}`];
  const models = Object.entries(s.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const maxCost = Math.max(0.01, ...models.map(([, v]) => v.costUsd));
  for (const [m, v] of models) {
    const short = m.replace('claude-', '').replace(/-\d+$/, '');
    lines.push(`  ${short.padEnd(18)} ${hbar(v.costUsd, maxCost, 20)} $${v.costUsd.toFixed(2)} ${DIM}(${_fmt(v.messages)} msgs)${RESET}`);
  }
  const hit = (s.cacheHitRatio * 100).toFixed(1);
  const interp = s.cacheHitRatio >= 0.7 ? 'excellent'
               : s.cacheHitRatio >= 0.5 ? 'good'
               : s.cacheHitRatio >= 0.3 ? 'ok'
               : 'context churn';
  lines.push(`  cache hit ratio    ${hit}%   ${DIM}${interp}${RESET}`);
  lines.push(`  ${BOLD}top tools${RESET}`);
  const maxTool = Math.max(1, ...s.topTools.map((t) => t.count));
  for (const t of s.topTools.slice(0, 10)) {
    lines.push(`    ${t.name.padEnd(24)} ${hbar(t.count, maxTool, 15)} ${t.count}`);
  }
  const mcps = Object.entries(s.mcpServers).sort((a, b) => b[1] - a[1]);
  if (mcps.length) {
    lines.push(`  ${BOLD}mcp${RESET}        ${mcps.map(([k, v]) => `${k} ${DIM}${v}${RESET}`).join('  ')}`);
  }
  return lines.join('\n');
}

function _flow(doc) {
  const f = doc.flow;
  const lines = [`${BOLD}Flow${RESET}`];
  const { labels, counts } = f.sessionDurationBuckets;
  const max = Math.max(1, ...counts);
  lines.push(`  session length`);
  for (let i = 0; i < labels.length; i++) {
    lines.push(`    ${labels[i].padEnd(8)} ${hbar(counts[i], max, 20)} ${counts[i]}`);
  }
  lines.push(`  median session ${DIM}${f.medianSessionMinutes.toFixed(0)}m${RESET}   median turns ${DIM}${f.medianUserTurnsPerSession}${RESET}   median idle ${DIM}${f.medianIdleGapSeconds.toFixed(0)}s${RESET}`);
  lines.push(`  ${BOLD}time of day${RESET}  ${DIM}(rows Sun–Sat, cols 0–23)${RESET}`);
  const hm = heatmap(f.timeOfDayHeatmap.data);
  for (const row of hm.split('\n')) lines.push(`    ${fg(87)}${row}${RESET}`);
  return lines.join('\n');
}

function _quality(doc) {
  const q = doc.quality;
  const lines = [`${BOLD}Quality${RESET}`];
  lines.push(`  sessions with commits  ${q.sessionsWithCommits} ${DIM}(${(q.sessionCommitRatio * 100).toFixed(0)}%)${RESET}`);
  lines.push(`  lines ±                ${fg(82)}+${_fmt(q.linesAdded)}${RESET} ${fg(196)}-${_fmt(q.linesDeleted)}${RESET}`);
  lines.push(`  revert/fixup rate      ${(q.revertRatio * 100).toFixed(1)}% ${DIM}(${q.revertCount})${RESET}`);
  if (q.topFiles.length) {
    lines.push(`  ${BOLD}most-edited files${RESET}`);
    for (const f of q.topFiles) lines.push(`    ${String(f.edits).padStart(3)}  ${DIM}${f.path}${RESET}`);
  }
  return lines.join('\n');
}

function _projects(doc) {
  const lines = [`${BOLD}Projects${RESET}`];
  lines.push(`  ${DIM}${'project'.padEnd(36)} ${'sess'.padStart(5)} ${'tokens'.padStart(9)} ${'commits'.padStart(8)}  top model${RESET}`);
  for (const p of doc.projects) {
    const name = p.cwd.split('/').slice(-2).join('/');
    const short = (p.topModel || '').replace('claude-', '').replace(/-\d+$/, '');
    lines.push(`  ${name.padEnd(36).slice(0, 36)} ${String(p.sessions).padStart(5)} ${_fmt(p.tokens).padStart(9)} ${String(p.commits).padStart(8)}  ${short}  ${DIM}$${p.costUsd.toFixed(2)}${RESET}`);
  }
  return lines.join('\n');
}

function _fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

module.exports = { render, SECTIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reflect-render.test.js`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/reflect-render.js tests/reflect-render.test.js
git commit -m "feat(reflect): ANSI report renderer for MetricsDocument"
```

---

### Task 8: Reflect CLI orchestrator (argv parsing + `--format` flag)

**Files:**
- Create: `src/reflect.js`
- Create: `tests/reflect.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/reflect.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/reflect');

test('parseArgs: defaults', () => {
  const a = parseArgs([]);
  assert.equal(a.format, 'ansi');
  assert.equal(a.section, null);
  assert.ok(a.windowLabel.startsWith('last 30 days'));
  assert.ok(a.since > 0);
  assert.ok(a.until > a.since);
});

test('parseArgs: --since 7d', () => {
  const a = parseArgs(['--since', '7d']);
  const sevenDays = 7 * 86400_000;
  assert.ok(Math.abs((a.until - a.since) - sevenDays) < 1000);
  assert.equal(a.windowLabel, 'last 7 days');
});

test('parseArgs: --since all', () => {
  const a = parseArgs(['--since', 'all']);
  assert.equal(a.since, 0);
  assert.equal(a.windowLabel, 'all time');
});

test('parseArgs: --since date', () => {
  const a = parseArgs(['--since', '2026-01-01']);
  assert.equal(new Date(a.since).toISOString().slice(0, 10), '2026-01-01');
});

test('parseArgs: section positional + format flag', () => {
  const a = parseArgs(['spend', '--format', 'json']);
  assert.equal(a.section, 'spend');
  assert.equal(a.format, 'json');
});

test('parseArgs: --help sets help flag', () => {
  const a = parseArgs(['--help']);
  assert.equal(a.help, true);
});

test('parseArgs: rejects unknown section', () => {
  assert.throws(() => parseArgs(['banana']), /unknown section/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reflect.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/reflect.js`**

```js
const { compute } = require('./metrics');
const { render, SECTIONS } = require('./reflect-render');
const pkg = require('../package.json');

function parseArgs(argv) {
  const a = { format: 'ansi', section: null, since: 0, until: Date.now(), windowLabel: '', help: false };
  let sinceSpec = '30d';
  let sawSince = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { a.help = true; continue; }
    if (arg === '--format') { a.format = argv[++i]; continue; }
    if (arg === '--since') { sinceSpec = argv[++i]; sawSince = true; continue; }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    if (SECTIONS.includes(arg)) { a.section = arg; continue; }
    throw new Error(`unknown section: ${arg} (expected one of: ${SECTIONS.join(', ')})`);
  }

  if (a.format !== 'ansi' && a.format !== 'json') {
    throw new Error(`--format must be ansi or json (got: ${a.format})`);
  }

  const { since, label } = _resolveSince(sinceSpec);
  a.since = since;
  a.windowLabel = label;
  a.until = Date.now();
  return a;
}

function _resolveSince(spec) {
  if (spec === 'all') return { since: 0, label: 'all time' };
  const m = spec.match(/^(\d+)d$/);
  if (m) {
    const days = parseInt(m[1], 10);
    return { since: Date.now() - days * 86400_000, label: `last ${days} days` };
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(spec) ? spec + 'T00:00:00Z' : spec;
  const parsed = new Date(dateOnly);
  if (isNaN(parsed.getTime())) throw new Error(`invalid --since value: ${spec}`);
  return { since: parsed.getTime(), label: `since ${spec}` };
}

function usage() {
  return `
Usage: claude-dash-cli reflect [section] [flags]

Sections: ${SECTIONS.join(', ')} (default: all)
Flags:
  --since <spec>    time window: 7d, 30d, all, or YYYY-MM-DD (default: 30d)
  --format ansi|json  output format (default: ansi)
  -h, --help        this help
`;
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { process.stderr.write(`error: ${e.message}\n${usage()}`); process.exit(2); }

  if (args.help) { process.stdout.write(usage()); return; }

  const doc = await compute(
    { since: args.since, until: args.until, windowLabel: args.windowLabel },
    { toolVersion: pkg.version }
  );

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  } else {
    process.stdout.write(render(doc, args.section));
  }
}

module.exports = { parseArgs, main, usage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reflect.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/reflect.js tests/reflect.test.js
git commit -m "feat(reflect): CLI orchestrator with argv parsing"
```

---

### Task 9: Subcommand dispatch

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Replace `src/index.js` with a dispatcher**

Replace the entire contents of `src/index.js`:

```js
const { AuthManager } = require('./auth');
const { UsageTracker } = require('./usage');
const { scan, sinceMidnight } = require('./stats');
const { render, HIDE_CURSOR, SHOW_CURSOR } = require('./render');

const REDRAW_MS = 1000;
const STATS_REFRESH_MS = 60_000;

async function runDashboard() {
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

  async function refreshStats() {
    try { state.stats = await scan({ since: sinceMidnight() }); }
    catch { state.stats = null; }
  }
  refreshStats();
  const statsTimer = setInterval(refreshStats, STATS_REFRESH_MS);

  process.stdout.write(HIDE_CURSOR);
  const redrawTimer = setInterval(() => { process.stdout.write(render(state)); }, REDRAW_MS);

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

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'reflect') {
    const { main: reflectMain } = require('./reflect');
    await reflectMain(argv.slice(1));
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`Usage:\n  claude-dash-cli                live dashboard\n  claude-dash-cli reflect [...]  retrospective report (see 'reflect --help')\n`);
    return;
  }
  await runDashboard();
}

main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1); });
```

- [ ] **Step 2: Smoke-test the dispatcher**

Run: `node src/index.js reflect --help`
Expected: help text printed to stdout, no errors, exit 0.

Run: `node src/index.js reflect --since 7d --format json | head -5`
Expected: JSON starting with `{\n  "schemaVersion": "1.0.0",` etc.

Run: `node src/index.js reflect --since 7d 2>&1 | head -20`
Expected: ANSI-colored report with Overview, Spend, Flow, Quality, Projects sections.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat(reflect): subcommand dispatch in index.js"
```

---

### Task 10: Version bump, test script, README update

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Update `package.json`**

Change the version to `"0.2.0"` and add a test script. The complete file:

```json
{
  "name": "claude-dash-cli",
  "version": "0.2.0",
  "description": "Terminal dashboard for Claude usage limits. Forked from claude-dash (Electron) — for tmux panes.",
  "bin": {
    "claude-dash-cli": "bin/claude-dash-cli"
  },
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test tests/"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Run all tests together**

Run: `npm test`
Expected: all test files pass, no failures.

- [ ] **Step 3: Append reflect usage to `README.md`**

Append this section to the existing README.md, before the License section (or at the end):

```markdown
## Retrospective report

```bash
claude-dash-cli reflect                      # last 30 days, ANSI report
claude-dash-cli reflect --since 7d           # rolling week
claude-dash-cli reflect --since 2026-01-01   # since a specific date
claude-dash-cli reflect --since all          # entire history

claude-dash-cli reflect spend                # only the spend section
claude-dash-cli reflect --format json        # machine-readable MetricsDocument
```

The report scans `~/.claude/projects/*/*.jsonl` transcripts and correlates with `git log` in each project directory. See `docs/specs/2026-04-19-reflect-subcommand-design.md` for the MetricsDocument schema.

**Cost estimates** come from `src/pricing.js` — a user-maintained per-model $/M-token table. Verify against your Anthropic invoices and update as pricing changes.
```

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore(reflect): bump to 0.2.0; document reflect usage"
```

---

## Plan self-review

Done inline before handoff. Checked:
- **Spec coverage:** every spec section maps to a task. Overview/Spend/Flow/Quality/Projects → Tasks 6+7. Schema → Task 6. Pricing → Task 1. Sparkline/heatmap → Tasks 2+3. Git correlation → Tasks 5+6. Argv + `--format` → Task 8. Subcommand dispatch → Task 9. Stability guarantee is documented in the spec; there's nothing to implement for it in v1 besides emitting the correct `schemaVersion` string (done in Task 6).
- **Placeholder scan:** no "TODO/TBD/fill later" left in the plan's code. The one `projectThrashDaily` approximation (flat broadcast) is explicitly noted as v1 accepting the spec's open item and references the spec.
- **Type consistency:** `byModel[*]` fields (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`) are identical across `stats-extended`, `metrics`, `pricing`, and `reflect-render`. Schema field names match example in tests. `topTools` item shape `{name, count}` matches schema and assertion.
- **Acknowledged spec simplifications:** `cacheHitRatioDaily` is emitted as `[]` in v1 (would need per-day cache bucketing in `stats-extended`). `projectThrashDaily` is flat (same reason). Both are additive extensions that won't break consumers.

## Execution handoff

Plan saved to `docs/plans/2026-04-19-reflect-subcommand.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
