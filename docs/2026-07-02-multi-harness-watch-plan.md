# Multi-Harness Session Watcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-dash-cli watch` subcommand: an interactive Ink tree of live + recent sessions across Claude Code and Codex, with per-node token roll-up and account-level limit / extra-usage in the status bar.

**Architecture:** Pure-logic layer in CommonJS (harness adapters → normalized tree model → poller), reusing the existing `UsageTracker`. The interactive UI is a small ESM (`.mjs`) Ink app using `htm` (no JSX/build step), loaded from the CJS entrypoint via dynamic `import()`.

**Tech Stack:** Node ≥18, CommonJS (logic + tests via `node:test`), Ink 5 + React 18 + htm (ESM, UI only).

## Global Constraints

- Project is **CommonJS** (`require` / `module.exports`) for all logic and tests. Tests use the built-in `node:test` + `node:assert` runner (matches `tests/reflect.test.js`).
- The Ink UI is **ESM-only** (`ink@^5`, `react@^18`). UI files use the `.mjs` extension and `htm` bound to `React.createElement` — **no JSX, no build step**. The CJS entrypoint loads them via dynamic `import()`.
- Normalized usage shape is `{ in, out, cacheCreate, cacheRead }` (integers) **everywhere**.
- Usage is attributed **by `agentId` / file, never by `sessionId`** (subagent lines carry the parent's `sessionId`).
- Liveness is derived from the newest record timestamp (`lastActivity`), not a PID: `classifyStatus` → `live` (age ≤ 30s), `idle` (≤ 5min), `done` (≤ window), `null` (outside window → excluded). Window default 6h.
- **Per-node = token roll-up. Account-level limit `utilization` + `extra_usage` live only in the StatusBar** (the account limit is not attributable to a single session). This refines the spec's "% of limit per node".
- Existing `dashboard` and `reflect` subcommands must remain untouched. Zero-dep posture is relaxed **only** for `watch` (adds `ink`, `react`, `htm`).

---

### Task 1: Normalized tree model

**Files:**
- Create: `src/model/tree.js`
- Test: `tests/model.tree.test.js`

**Interfaces:**
- Produces:
  - `emptyUsage() -> {in,out,cacheCreate,cacheRead}` (all 0)
  - `addUsage(a, b) -> usage` (element-wise sum, pure)
  - `classifyStatus(lastActivity, now, {liveMs?, idleMs?, windowMs?}) -> 'live'|'idle'|'done'|null`
  - `computeRollup(node) -> usage` (sets `node.rollup`, recurses children, returns the node's total)
  - `flattenVisible(nodes, expandedIds, depth?, out?) -> Array<{node, depth}>`
  - `fmtTokens(n) -> string` (e.g. `1234 -> "1.2k"`, `2_000_000 -> "2.0M"`)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model.tree.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  emptyUsage, addUsage, classifyStatus, computeRollup, flattenVisible, fmtTokens,
} = require('../src/model/tree');

test('addUsage sums element-wise without mutating', () => {
  const a = { in: 1, out: 2, cacheCreate: 3, cacheRead: 4 };
  const b = { in: 10, out: 20, cacheCreate: 30, cacheRead: 40 };
  assert.deepStrictEqual(addUsage(a, b), { in: 11, out: 22, cacheCreate: 33, cacheRead: 44 });
  assert.strictEqual(a.in, 1); // unchanged
});

test('classifyStatus bands by age', () => {
  const now = 1_000_000_000;
  const opts = { liveMs: 30_000, idleMs: 300_000, windowMs: 21_600_000 };
  assert.strictEqual(classifyStatus(now - 5_000, now, opts), 'live');
  assert.strictEqual(classifyStatus(now - 60_000, now, opts), 'idle');
  assert.strictEqual(classifyStatus(now - 3_600_000, now, opts), 'done');
  assert.strictEqual(classifyStatus(now - 40_000_000, now, opts), null);
});

test('computeRollup adds children into parent', () => {
  const node = {
    usage: { in: 1, out: 0, cacheCreate: 0, cacheRead: 0 },
    children: [
      { usage: { in: 2, out: 0, cacheCreate: 0, cacheRead: 0 }, children: [] },
      { usage: { in: 3, out: 0, cacheCreate: 0, cacheRead: 0 }, children: [] },
    ],
  };
  const total = computeRollup(node);
  assert.strictEqual(total.in, 6);
  assert.strictEqual(node.rollup.in, 6);
});

test('flattenVisible only expands ids in the set', () => {
  const nodes = [{ id: 's1', children: [{ id: 'a1', children: [] }] }];
  assert.strictEqual(flattenVisible(nodes, new Set()).length, 1);
  const rows = flattenVisible(nodes, new Set(['s1']));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].depth, 1);
});

test('fmtTokens is human-readable', () => {
  assert.strictEqual(fmtTokens(950), '950');
  assert.strictEqual(fmtTokens(1234), '1.2k');
  assert.strictEqual(fmtTokens(2_000_000), '2.0M');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/model.tree.test.js`
Expected: FAIL — `Cannot find module '../src/model/tree'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/model/tree.js
const DEFAULTS = { liveMs: 30_000, idleMs: 5 * 60_000, windowMs: 6 * 3600_000 };

function emptyUsage() {
  return { in: 0, out: 0, cacheCreate: 0, cacheRead: 0 };
}

function addUsage(a, b) {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

function classifyStatus(lastActivity, now, opts = {}) {
  const { liveMs, idleMs, windowMs } = { ...DEFAULTS, ...opts };
  const age = now - (lastActivity ?? 0);
  if (age <= liveMs) return 'live';
  if (age <= idleMs) return 'idle';
  if (age <= windowMs) return 'done';
  return null;
}

function computeRollup(node) {
  let acc = { ...(node.usage || emptyUsage()) };
  for (const child of node.children || []) {
    acc = addUsage(acc, computeRollup(child));
  }
  node.rollup = acc;
  return acc;
}

function flattenVisible(nodes, expandedIds, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children && node.children.length && expandedIds.has(node.id)) {
      flattenVisible(node.children, expandedIds, depth + 1, out);
    }
  }
  return out;
}

function fmtTokens(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

module.exports = { emptyUsage, addUsage, classifyStatus, computeRollup, flattenVisible, fmtTokens, DEFAULTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/model.tree.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/model/tree.js tests/model.tree.test.js
git commit -m "feat(watch): normalized tree model — usage, liveness, rollup, flatten"
```

---

### Task 2: JSONL cache reader + Claude adapter

**Files:**
- Create: `src/harness/jsonl.js`
- Create: `src/harness/claude.js`
- Create fixtures: `tests/fixtures/claude/-home-proj/sess-A.jsonl`, `tests/fixtures/claude/-home-proj/sess-A/subagents/agent-x1.jsonl`
- Test: `tests/harness.claude.test.js`

**Interfaces:**
- Produces:
  - `readJsonlCached(file) -> Array<object>` (skips blank/truncated lines; memoised by `(size, mtimeMs)`)
  - `discoverSessions({projectsDir, now, liveMs?, idleMs?, windowMs?}) -> Session[]`
    - `Session` shape: `{harness:'claude', kind:'session', id, cwd, project, model, agentType:null, status, startedAt, lastActivity, usage, rollup, children:AgentNode[]}`
    - `AgentNode` (subagent): same shape, `kind:'subagent'`, `agentType` from `attributionAgent`.
- Consumes: `../model/tree` (`emptyUsage`, `addUsage`, `classifyStatus`, `computeRollup`).

- [ ] **Step 1: Write the fixture files**

`tests/fixtures/claude/-home-proj/sess-A.jsonl` (parent session, two assistant turns):

```jsonl
{"type":"assistant","sessionId":"sess-A","cwd":"/home/proj","timestamp":"2026-07-02T12:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}}}
{"type":"assistant","sessionId":"sess-A","cwd":"/home/proj","timestamp":"2026-07-02T12:01:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":80,"cache_creation_input_tokens":0,"cache_read_input_tokens":20}}}
```

`tests/fixtures/claude/-home-proj/sess-A/subagents/agent-x1.jsonl` (one subagent):

```jsonl
{"type":"assistant","sessionId":"sess-A","agentId":"x1","isSidechain":true,"attributionAgent":"Explore","cwd":"/home/proj","timestamp":"2026-07-02T12:00:30.000Z","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":40,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```

- [ ] **Step 2: Write the failing test**

```javascript
// tests/harness.claude.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverSessions } = require('../src/harness/claude');

const FIX = path.join(__dirname, 'fixtures', 'claude');
// now = 30s after the subagent's last activity, well inside the window
const NOW = Date.parse('2026-07-02T12:01:30.000Z');

test('discoverSessions builds a session with its subagent child', () => {
  const sessions = discoverSessions({ projectsDir: FIX, now: NOW });
  assert.strictEqual(sessions.length, 1);
  const s = sessions[0];
  assert.strictEqual(s.id, 'sess-A');
  assert.strictEqual(s.project, 'proj');
  assert.strictEqual(s.children.length, 1);
  assert.strictEqual(s.children[0].agentType, 'Explore');
});

test('usage is attributed per agent, not merged by sessionId', () => {
  const s = discoverSessions({ projectsDir: FIX, now: NOW })[0];
  // parent own usage: in 300, out 130
  assert.strictEqual(s.usage.in, 300);
  assert.strictEqual(s.usage.out, 130);
  // child own usage separate
  assert.strictEqual(s.children[0].usage.in, 40);
  // rollup = parent + child
  assert.strictEqual(s.rollup.in, 340);
  assert.strictEqual(s.rollup.out, 140);
});

test('missing projectsDir yields empty array, no throw', () => {
  assert.deepStrictEqual(discoverSessions({ projectsDir: '/no/such/dir', now: NOW }), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/harness.claude.test.js`
Expected: FAIL — `Cannot find module '../src/harness/claude'`

- [ ] **Step 4: Implement the cache reader**

```javascript
// src/harness/jsonl.js
const fs = require('fs');

const cache = new Map(); // file -> { size, mtimeMs, records }

function readJsonlCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records;

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* truncated/partial line */ }
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, records });
  return records;
}

module.exports = { readJsonlCached };
```

- [ ] **Step 5: Implement the Claude adapter**

```javascript
// src/harness/claude.js
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
  const opts = { now, liveMs, idleMs, windowMs };
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/harness.claude.test.js`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/harness/jsonl.js src/harness/claude.js tests/harness.claude.test.js tests/fixtures/claude
git commit -m "feat(watch): Claude Code adapter — session+subagent tree, per-agent usage"
```

---

### Task 3: Codex adapter

**Files:**
- Create: `src/harness/codex.js`
- Create fixture: `tests/fixtures/codex/2026/07/02/rollout-2026-07-02T14-47-03-cx1.jsonl`
- Test: `tests/harness.codex.test.js`

**Interfaces:**
- Produces: `discoverSessions({sessionsDir, now, liveMs?, idleMs?, windowMs?}) -> Session[]`
  - Flat: `kind:'session'`, `children:[]`, `agentType:null`, `harness:'codex'`. Same normalized shape as Task 2.
- Consumes: `./jsonl` (`readJsonlCached`), `../model/tree` (`classifyStatus`).
- **Token mapping** (Codex `total_token_usage` is cumulative → take the last `token_count` event):
  `in = input_tokens - cached_input_tokens`, `out = output_tokens + reasoning_output_tokens`, `cacheCreate = 0`, `cacheRead = cached_input_tokens`.

- [ ] **Step 1: Write the fixture file**

`tests/fixtures/codex/2026/07/02/rollout-2026-07-02T14-47-03-cx1.jsonl`:

```jsonl
{"type":"session_meta","timestamp":"2026-07-02T14:47:03.000Z","payload":{"id":"cx1","cwd":"/home/proj","model":"gpt-5-codex","session_id":"cx1"}}
{"type":"event_msg","timestamp":"2026-07-02T14:47:10.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":200,"reasoning_output_tokens":50,"total_tokens":1250}}}}
{"type":"event_msg","timestamp":"2026-07-02T14:48:00.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":900,"output_tokens":500,"reasoning_output_tokens":100,"total_tokens":3600}}}}
```

- [ ] **Step 2: Write the failing test**

```javascript
// tests/harness.codex.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverSessions } = require('../src/harness/codex');

const FIX = path.join(__dirname, 'fixtures', 'codex');
const NOW = Date.parse('2026-07-02T14:48:30.000Z');

test('discoverSessions returns flat sessions with cumulative usage from the last token_count', () => {
  const sessions = discoverSessions({ sessionsDir: FIX, now: NOW });
  assert.strictEqual(sessions.length, 1);
  const s = sessions[0];
  assert.strictEqual(s.harness, 'codex');
  assert.strictEqual(s.id, 'cx1');
  assert.strictEqual(s.model, 'gpt-5-codex');
  assert.strictEqual(s.children.length, 0);
  // last token_count: in = 3000-900, out = 500+100, cacheRead = 900
  assert.strictEqual(s.usage.in, 2100);
  assert.strictEqual(s.usage.out, 600);
  assert.strictEqual(s.usage.cacheRead, 900);
  assert.deepStrictEqual(s.rollup, s.usage);
});

test('missing sessionsDir yields empty array', () => {
  assert.deepStrictEqual(discoverSessions({ sessionsDir: '/no/such', now: NOW }), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/harness.codex.test.js`
Expected: FAIL — `Cannot find module '../src/harness/codex'`

- [ ] **Step 4: Implement the Codex adapter**

```javascript
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
```

> **Future (subsystem B / faithful Codex trees):** `session_meta.payload` also carries `parent_thread_id`, `multi_agent_version`, and `agent_role`. These can link Codex sessions into a tree later. MVP keeps sessions flat per the approved design.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/harness.codex.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/harness/codex.js tests/harness.codex.test.js tests/fixtures/codex
git commit -m "feat(watch): Codex adapter — flat sessions, cumulative token mapping"
```

---

### Task 4: Harness registry

**Files:**
- Create: `src/harness/index.js`
- Test: `tests/harness.index.test.js`

**Interfaces:**
- Produces: `discoverAll({now, liveMs?, idleMs?, windowMs?, claudeDir?, codexDir?}) -> Session[]`
  - Concatenates both adapters, sorts by status (`live` < `idle` < `done`) then by `lastActivity` desc.
  - Defaults: `claudeDir = ~/.claude/projects`, `codexDir = ~/.codex/sessions`.
- Consumes: `./claude`, `./codex`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/harness.index.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { discoverAll } = require('../src/harness');

const CLAUDE = path.join(__dirname, 'fixtures', 'claude');
const CODEX = path.join(__dirname, 'fixtures', 'codex');
const NOW = Date.parse('2026-07-02T14:48:30.000Z');

test('discoverAll merges both harnesses and sorts live-first', () => {
  const all = discoverAll({ now: NOW, windowMs: 24 * 3600_000, claudeDir: CLAUDE, codexDir: CODEX });
  assert.ok(all.length >= 2);
  const harnesses = new Set(all.map((s) => s.harness));
  assert.ok(harnesses.has('claude') && harnesses.has('codex'));
  // sorted: no 'done' appears before a 'live'
  const rank = { live: 0, idle: 1, done: 2 };
  for (let i = 1; i < all.length; i++) {
    assert.ok(rank[all[i - 1].status] <= rank[all[i].status]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harness.index.test.js`
Expected: FAIL — `Cannot find module '../src/harness'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/harness/index.js
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
  sessions.sort((a, b) =>
    (RANK[a.status] - RANK[b.status]) || ((b.lastActivity || 0) - (a.lastActivity || 0)));
  return sessions;
}

module.exports = { discoverAll };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/harness.index.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/harness/index.js tests/harness.index.test.js
git commit -m "feat(watch): harness registry — merge + sort across adapters"
```

---

### Task 5: Poller

**Files:**
- Create: `src/watch/poller.js`
- Test: `tests/watch.poller.test.js`

**Interfaces:**
- Produces: `createPoller({intervalMs, discover, onUpdate, setTimeoutFn?, clearTimeoutFn?}) -> {start(), stop()}`
  - `discover` is an async/sync thunk returning `Session[]`. `onUpdate(sessions, err)` is called each tick.
  - Timer functions are injectable for tests. Errors from `discover` are passed as `onUpdate(null, err)`, never thrown.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/watch.poller.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createPoller } = require('../src/watch/poller');

test('poller calls onUpdate with discover result and re-schedules', () => {
  const calls = [];
  let scheduled = null;
  const p = createPoller({
    intervalMs: 100,
    discover: () => [{ id: 's1' }],
    onUpdate: (s, e) => calls.push({ s, e }),
    setTimeoutFn: (fn) => { scheduled = fn; return 1; },
    clearTimeoutFn: () => {},
  });
  p.start();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].s, [{ id: 's1' }]);
  scheduled(); // fire the next tick manually
  assert.strictEqual(calls.length, 2);
});

test('poller reports discover errors instead of throwing', () => {
  const calls = [];
  const p = createPoller({
    intervalMs: 100,
    discover: () => { throw new Error('boom'); },
    onUpdate: (s, e) => calls.push({ s, e }),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  p.start();
  assert.strictEqual(calls[0].s, null);
  assert.match(calls[0].e.message, /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/watch.poller.test.js`
Expected: FAIL — `Cannot find module '../src/watch/poller'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/watch/poller.js
function createPoller({
  intervalMs,
  discover,
  onUpdate,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null;
  let stopped = false;

  async function tick() {
    let sessions = null, err = null;
    try { sessions = await discover(); } catch (e) { err = e; }
    if (stopped) return;
    onUpdate(sessions, err);
    if (!stopped) timer = setTimeoutFn(tick, intervalMs);
  }

  return {
    start() { stopped = false; tick(); },
    stop() { stopped = true; if (timer) clearTimeoutFn(timer); timer = null; },
  };
}

module.exports = { createPoller };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/watch.poller.test.js`
Expected: PASS (2 tests)

> Note: the first synchronous `discover` resolves before `start()` returns in the test because it is not truly async; with a real async `discover` the first `onUpdate` lands on the next microtask. The UI (Task 6) handles the initial empty state.

- [ ] **Step 5: Commit**

```bash
git add src/watch/poller.js tests/watch.poller.test.js
git commit -m "feat(watch): injectable poller with error passthrough"
```

---

### Task 6: Ink UI (tree + status bar + detail)

**Files:**
- Modify: `package.json` (add `ink`, `react`, `htm` deps)
- Create: `src/watch/ui.mjs`
- Test: `tests/watch.ui.test.mjs`

**Interfaces:**
- Produces:
  - `App({discover, intervalMs, limitSource})` — Ink component. `limitSource` (optional) = `{start(cb), stop()}` pushing `{limits, extra_usage}`; when null, the status bar shows tokens only.
  - `run({intervalMs?, discover?, limitSource?})` — mounts the app with `render()`; returns the Ink instance.
- Consumes: `../model/tree` (`flattenVisible`, `fmtTokens`, `computeRollup` already applied), `./poller` (`createPoller`), `../harness` (`discoverAll`) for the default `discover`.

- [ ] **Step 1: Add dependencies**

```bash
npm install ink@^5 react@^18 htm@^3
```

Expected: `package.json` gains `ink`, `react`, `htm` under `dependencies`.

- [ ] **Step 2: Write the failing test**

```javascript
// tests/watch.ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { render } from 'ink-testing-library';
import { App } from '../src/watch/ui.mjs';

const sessions = [{
  harness: 'claude', kind: 'session', id: 'sess-A', project: 'proj',
  model: 'claude-opus-4-8', status: 'live',
  usage: { in: 300, out: 130, cacheCreate: 10, cacheRead: 25 },
  rollup: { in: 340, out: 140, cacheCreate: 10, cacheRead: 25 },
  lastActivity: Date.now(),
  children: [{
    harness: 'claude', kind: 'subagent', id: 'x1', agentType: 'Explore',
    status: 'idle', usage: { in: 40, out: 10, cacheCreate: 0, cacheRead: 0 },
    rollup: { in: 40, out: 10, cacheCreate: 0, cacheRead: 0 }, children: [],
  }],
}];

test('App renders a session row with project and rolled-up tokens', async () => {
  const { lastFrame, unmount } = render(App({ discover: () => sessions, intervalMs: 10_000 }));
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame();
  assert.match(frame, /proj/);
  assert.match(frame, /sess-A|claude/);
  assert.match(frame, /340\.0|340/); // rolled-up input tokens shown somewhere
  unmount();
});
```

Requires the dev dep `ink-testing-library`:

```bash
npm install --save-dev ink-testing-library
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/watch.ui.test.mjs`
Expected: FAIL — `Cannot find module '../src/watch/ui.mjs'`

- [ ] **Step 4: Implement the UI**

```javascript
// src/watch/ui.mjs
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import htm from 'htm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { flattenVisible, fmtTokens } = require('../model/tree.js');
const { createPoller } = require('./poller.js');

const html = htm.bind(React.createElement);

const STATUS_COLOR = { live: 'green', idle: 'yellow', done: 'gray' };
const STATUS_DOT = { live: '●', idle: '◐', done: '○' };

function tokenSummary(u) {
  if (!u) return '';
  return `${fmtTokens(u.in)}→${fmtTokens(u.out)} ⇄${fmtTokens(u.cacheRead)}`;
}

function NodeRow({ node, depth, selected }) {
  const indent = '  '.repeat(depth);
  const dot = STATUS_DOT[node.status] || '·';
  const label = node.kind === 'session'
    ? `${node.harness}:${node.project || node.id}`
    : `${node.agentType || 'agent'} (${node.id})`;
  const tokens = tokenSummary(node.rollup || node.usage);
  return html`
    <${Text} color=${selected ? 'cyan' : undefined} inverse=${selected}>
      ${indent}<${Text} color=${STATUS_COLOR[node.status]}>${dot}</> ${label}  <${Text} color="gray">${tokens}</>
    </>`;
}

function TreeView({ rows, sel }) {
  if (!rows.length) return html`<${Text} color="gray">  (no live or recent sessions)</>`;
  return html`
    <${Box} flexDirection="column">
      ${rows.map((r, i) => html`<${NodeRow} key=${r.node.id + ':' + r.depth} node=${r.node} depth=${r.depth} selected=${i === sel} />`)}
    </>`;
}

function StatusBar({ sessions, limitInfo, err }) {
  const total = sessions.reduce((a, s) => a + ((s.rollup && s.rollup.out) || 0), 0);
  const live = sessions.filter((s) => s.status === 'live').length;
  const five = limitInfo && limitInfo.limits && limitInfo.limits.five_hour;
  const extra = limitInfo && limitInfo.extra_usage;
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Text} bold>claude-dash-cli watch — ${live} live · ${sessions.length} recent · out ${fmtTokens(total)}</>
      <${Text} color="gray">
        ${five ? `5h limit: ${Math.round(five.utilization)}%` : '5h limit: —'}${extra ? `  extra: ${JSON.stringify(extra)}` : ''}
        ${err ? html`  <${Text} color="red">${err}</>` : ''}
      </>
    </>`;
}

function DetailPane({ node }) {
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} bold>${node.harness}:${node.kind} ${node.id}</>
      <${Text} color="gray">cwd: ${node.cwd || '—'}  model: ${node.model || '—'}</>
      <${Text} color="gray">status: ${node.status}  in ${fmtTokens((node.rollup || node.usage).in)} · out ${fmtTokens((node.rollup || node.usage).out)}</>
    </>`;
}

export function App({ discover, intervalMs = 2000, limitSource = null }) {
  const [sessions, setSessions] = useState([]);
  const [err, setErr] = useState(null);
  const [limitInfo, setLimitInfo] = useState(null);
  const [sel, setSel] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showDetail, setShowDetail] = useState(false);
  const { exit } = useApp();

  useEffect(() => {
    const poller = createPoller({
      intervalMs, discover,
      onUpdate: (s, e) => { if (e) setErr(String(e.message || e)); else { setSessions(s); setErr(null); } },
    });
    poller.start();
    return () => poller.stop();
  }, [discover, intervalMs]);

  useEffect(() => {
    if (!limitSource) return undefined;
    limitSource.start((info) => setLimitInfo(info));
    return () => limitSource.stop();
  }, [limitSource]);

  const rows = flattenVisible(sessions, expanded);

  useInput((input, key) => {
    if (input === 'q' || key.escape) { exit(); return; }
    if (key.downArrow) setSel((i) => Math.min(Math.max(rows.length - 1, 0), i + 1));
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.rightArrow || key.return) {
      const n = rows[sel] && rows[sel].node;
      if (n && n.children && n.children.length) setExpanded((s) => new Set(s).add(n.id));
    }
    if (key.leftArrow) {
      const n = rows[sel] && rows[sel].node;
      if (n) setExpanded((s) => { const c = new Set(s); c.delete(n.id); return c; });
    }
    if (input === 'd') setShowDetail((v) => !v);
  });

  const current = rows[sel] && rows[sel].node;
  return html`
    <${Box} flexDirection="column">
      <${StatusBar} sessions=${sessions} limitInfo=${limitInfo} err=${err} />
      <${TreeView} rows=${rows} sel=${sel} />
      ${showDetail && current ? html`<${DetailPane} node=${current} />` : null}
      <${Text} color="gray">↑↓ move · →/Enter expand · ← collapse · d detail · q quit</>
    </>`;
}

export function run({ intervalMs = 2000, discover, limitSource = null } = {}) {
  const require2 = createRequire(import.meta.url);
  const finalDiscover = discover || (() => {
    const { discoverAll } = require2('../harness/index.js');
    return discoverAll({ now: Date.now() });
  });
  return render(html`<${App} discover=${finalDiscover} intervalMs=${intervalMs} limitSource=${limitSource} />`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/watch.ui.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/watch/ui.mjs tests/watch.ui.test.mjs
git commit -m "feat(watch): Ink tree UI — status bar, tree, detail, key nav"
```

---

### Task 7: Wire the `watch` subcommand + limit source

**Files:**
- Modify: `src/index.js:12-27` (subcommand dispatch + help)
- Create: `src/watch/limit-source.js`

**Interfaces:**
- Consumes: `./watch/ui.mjs` (`run`), `./auth` (`AuthManager`), `./usage` (`UsageTracker`).
- Produces: `createLimitSource() -> {start(cb), stop()}` adapting `UsageTracker.start` to the `limitSource` contract.

- [ ] **Step 1: Write the limit source**

```javascript
// src/watch/limit-source.js
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
```

- [ ] **Step 2: Add the `watch` dispatch branch in `src/index.js`**

Insert after the `reflect` branch (`src/index.js:16`):

```javascript
if (sub === 'watch') {
  const { createLimitSource } = require('./watch/limit-source');
  import('./watch/ui.mjs')
    .then(({ run }) => { run({ limitSource: createLimitSource() }); })
    .catch((e) => { process.stderr.write('watch failed: ' + e.message + '\n'); process.exit(1); });
  return;
}
```

- [ ] **Step 3: Update the help text in `src/index.js`**

Replace the usage block (`src/index.js:19-24`) so it lists `watch`:

```javascript
  process.stdout.write(
    'claude-dash-cli — Claude usage dashboard\n\n' +
    'Usage:\n' +
    '  claude-dash-cli            live usage dashboard (for a tmux pane)\n' +
    '  claude-dash-cli watch      interactive multi-harness session tree (Claude + Codex)\n' +
    '  claude-dash-cli reflect    retrospective scan of your sessions\n' +
    '  claude-dash-cli --help     this help\n\n' +
    'Run `claude-dash-cli reflect --help` for retrospective options.\n'
  );
```

- [ ] **Step 4: Manual smoke test**

Run: `node src/index.js watch`
Expected: an interactive tree of your current + recent Claude/Codex sessions renders; `↑↓` moves selection, `→` expands a session to show subagents, `d` toggles detail, `q` exits cleanly. (This is a manual check — no automated assertion.)

- [ ] **Step 5: Run the full test suite**

Run: `node --test`
Expected: all suites PASS (model, claude, codex, index, poller, ui + the pre-existing reflect tests).

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/watch/limit-source.js
git commit -m "feat(watch): wire watch subcommand + UsageTracker limit source"
```

---

## Self-Review

**Spec coverage:**
- Multi-harness observer (Claude hierarchical + Codex flat) → Tasks 2, 3, 4. ✅
- Normalized model + usage roll-up + liveness → Task 1. ✅
- Per-agent (not per-session) usage attribution → Task 2 test asserts it. ✅
- Live + recent window (LIVE/IDLE/DONE, 6h) → Task 1 `classifyStatus`; adapters filter. ✅
- Interactive Ink navigator (↑↓, expand/collapse, detail, quit) → Task 6. ✅
- Token roll-up per node + account limit `utilization` + `extra_usage` in status bar → Tasks 1, 6, 7. ✅
- Incremental / large-file safety → Task 2 `readJsonlCached` `(size,mtime)` cache. ✅
- Error handling (missing dir, malformed line) → Tasks 2/3 tests + `readJsonlCached`. ✅
- No-build-step / CJS↔ESM bridge → Global Constraints + Task 6 (`.mjs`, htm) + Task 7 (dynamic `import()`). ✅
- Out of scope (merge/transfer, cost $, tok/s) → not implemented, noted. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. The only manual (non-automated) step is Task 7 Step 4, explicitly labelled a smoke test. ✅

**Type consistency:** Normalized node shape `{harness, kind, id, cwd, project, model, agentType, status, startedAt, lastActivity, usage, rollup, children}` is identical across Tasks 2/3. `discoverSessions` signature (options object) consistent; `discoverAll` wraps both. `usage` is `{in,out,cacheCreate,cacheRead}` throughout. `flattenVisible`/`fmtTokens` names match between Task 1 and Task 6. ✅

## Notes for the executor

- **Deviation from spec, intentional:** the spec said "% of limit on each node". The account limit (`five_hour`, `seven_day`, …) is account-wide and not attributable to one session, so per-node shows the **token roll-up** and the **StatusBar** shows account `utilization` + `extra_usage`. This is the honest reconciliation; confirmed direction with the user during brainstorming.
- **Codex multi-agent hint:** `session_meta.payload.parent_thread_id` / `multi_agent_version` exist and could later link Codex sessions into a real tree — deferred to subsystem B.
- **Nested Claude subagents:** MVP attaches all `subagents/agent-*.jsonl` as direct children of the session (the on-disk dir is flat). Reconstructing subagent-of-subagent nesting via `attributionAgent` / `sourceToolAssistantUUID` is a future enhancement.
