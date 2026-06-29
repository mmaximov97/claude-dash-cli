const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { aggregate, parseSince, render, scanRecords, parseArgs } = require('../src/reflect');

const FIXTURES = path.join(__dirname, 'fixtures', 'projects');

// A tiny transcript: two sessions, mixed user/assistant records.
function records() {
  return [
    // session A — project /home/u/foo
    { type: 'user', sessionId: 'A', cwd: '/home/u/foo', timestamp: '2026-06-29T09:00:00.000Z' },
    { type: 'assistant', sessionId: 'A', cwd: '/home/u/foo', timestamp: '2026-06-29T09:00:10.000Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000 },
        content: [ { type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'mcp__playwright__browser_click' } ] } },
    { type: 'assistant', sessionId: 'A', cwd: '/home/u/foo', timestamp: '2026-06-29T09:30:00.000Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20 },
        content: [ { type: 'tool_use', name: 'Skill', input: { skill: 'brainstorming' } } ] } },
    // session B — project /home/u/bar
    { type: 'user', sessionId: 'B', cwd: '/home/u/bar', timestamp: '2026-06-29T14:00:00.000Z' },
    { type: 'assistant', sessionId: 'B', cwd: '/home/u/bar', timestamp: '2026-06-29T14:00:05.000Z',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 5 },
        content: [ { type: 'tool_use', name: 'Bash' } ] } },
    // out of window — ignored
    { type: 'assistant', sessionId: 'C', cwd: '/home/u/baz', timestamp: '2026-06-28T10:00:00.000Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 999, output_tokens: 999 } } },
  ];
}

const SINCE = Date.parse('2026-06-29T00:00:00.000Z');
const UNTIL = Date.parse('2026-06-30T00:00:00.000Z');

test('aggregate: counts sessions, assistant messages and user turns in window', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  assert.equal(r.totals.sessions, 2);
  assert.equal(r.totals.assistantMsgs, 3);
  assert.equal(r.totals.userTurns, 2);
});

test('aggregate: sums tokens, excluding out-of-window records', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  assert.equal(r.totals.tokensIn, 115);   // 100 + 10 + 5
  assert.equal(r.totals.tokensOut, 225);  // 200 + 20 + 5
  assert.equal(r.totals.cacheCreation, 50);
  assert.equal(r.totals.cacheRead, 1000);
});

test('aggregate: tallies tools, mcp servers and skills', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  assert.equal(r.byTool.Bash, 2);
  assert.equal(r.byMcp.playwright, 1);
  assert.equal(r.bySkill.brainstorming, 1);
});

test('aggregate: groups by project with per-project session counts', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  assert.equal(r.byProject['/home/u/foo'].sessions, 1);
  assert.equal(r.byProject['/home/u/foo'].assistantMsgs, 2);
  assert.equal(r.byProject['/home/u/bar'].sessions, 1);
});

test('aggregate: builds per-session rows with span and models', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  const a = r.sessions.find((s) => s.id === 'A');
  assert.equal(a.cwd, '/home/u/foo');
  assert.equal(a.assistantMsgs, 2);
  assert.equal(a.first, Date.parse('2026-06-29T09:00:00.000Z'));
  assert.equal(a.last, Date.parse('2026-06-29T09:30:00.000Z'));
  assert.deepEqual(a.models, ['claude-opus-4-8']);
});

test('aggregate: byHour distributes assistant messages by local hour', () => {
  const r = aggregate(records(), { since: SINCE, until: UNTIL });
  assert.equal(r.byHour.reduce((a, b) => a + b, 0), 3);
});

test('parseSince: relative day spec', () => {
  const now = Date.parse('2026-06-29T12:00:00.000Z');
  assert.equal(parseSince('7d', now), now - 7 * 86400_000);
});

test('parseSince: "all" means epoch 0', () => {
  assert.equal(parseSince('all', Date.now()), 0);
});

test('parseSince: absolute date', () => {
  assert.equal(parseSince('2026-01-01', Date.now()), Date.parse('2026-01-01T00:00:00.000'));
});

test('render: default ANSI report contains headline stats and a project', () => {
  const doc = aggregate(records(), { since: SINCE, until: UNTIL });
  const out = render(doc, { label: 'today', color: false });
  assert.match(out, /2 sessions/);
  assert.match(out, /3 (assistant )?msgs/i);
  assert.match(out, /foo/);   // project basename appears in "what you work on"
});

test('render: json format round-trips the document', () => {
  const doc = aggregate(records(), { since: SINCE, until: UNTIL });
  const out = render(doc, { format: 'json' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.totals.sessions, 2);
  assert.equal(parsed.totals.assistantMsgs, 3);
});

test('render: section filter limits output', () => {
  const doc = aggregate(records(), { since: SINCE, until: UNTIL });
  const sessionsOnly = render(doc, { section: 'sessions', color: false });
  assert.match(sessionsOnly, /SESSIONS/);
  assert.doesNotMatch(sessionsOnly, /WHAT YOU WORK ON/);
});

test('parseArgs: defaults to today, all sections, ansi', () => {
  const o = parseArgs([]);
  assert.equal(o.since, 'today');
  assert.equal(o.section, null);
  assert.equal(o.format, 'ansi');
  assert.equal(o.color, true);
});

test('parseArgs: section, --since and --format=json', () => {
  const o = parseArgs(['sessions', '--since', '7d', '--format=json']);
  assert.equal(o.section, 'sessions');
  assert.equal(o.since, '7d');
  assert.equal(o.format, 'json');
});

test('parseArgs: --no-color and --help', () => {
  const o = parseArgs(['--no-color', '--help']);
  assert.equal(o.color, false);
  assert.equal(o.help, true);
});

test('parseArgs: unknown argument throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('scanRecords: reads jsonl from a projects dir, skipping bad lines', async () => {
  const recs = await scanRecords({ since: SINCE, until: UNTIL, projectsDir: FIXTURES });
  const doc = aggregate(recs, { since: SINCE, until: UNTIL });
  assert.equal(doc.totals.sessions, 2);
  assert.equal(doc.totals.assistantMsgs, 2);
  assert.equal(doc.byTool.Bash, 1);
});
