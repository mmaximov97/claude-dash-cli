// tests/watch.ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
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
  const { lastFrame, unmount } = render(React.createElement(App, { discover: () => sessions, intervalMs: 10_000 }));
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame();
  assert.match(frame, /proj/);
  assert.match(frame, /sess-A|claude/);
  assert.match(frame, /340\.0|340/); // rolled-up input tokens shown somewhere
  unmount();
});
